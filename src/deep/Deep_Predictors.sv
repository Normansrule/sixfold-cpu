`default_nettype none

// =====================================================================================================
// The deep-pipeline edition's direction predictors: the same gshare and tournament chooser as
// src/GShare_Branch_Predictor.sv and src/Tournament_Chooser.sv (same tables, same reset values, same
// counting), written so each 2-bit counter trains itself.
//
// The shared modules train with "counter[index] <= step(counter[index])": a 64- or 128-way read of the
// trained counter, one step, and a decoded write back. Here every entry instead looks at its own counter:
// "if this entry is the one being trained, step it". The read multiplexer leaves the training path, which
// is then a 6- or 7-bit decode and a 2-bit step. The fetch side (F1's lookups) is unchanged.
// =====================================================================================================
module DeepGShare #(
    parameter int HISTORY_BITS = 6
) (
    input  logic clk,
    input  logic reset,
    input  logic ENABLE,
    input  logic [31:0] FETCH_PC,
    output logic FETCH_PREDICTED_TAKEN,
    output logic [HISTORY_BITS-1:0] FETCH_PREDICTION_INDEX,
    output logic [HISTORY_BITS-1:0] GLOBAL_HISTORY,
    input  logic SPECULATIVE_UPDATE,
    input  logic SPECULATIVE_TAKEN,
    input  logic UPDATE_PREDICTION,
    input  logic [HISTORY_BITS-1:0] UPDATE_PREDICTION_INDEX,
    input  logic ACTUAL_BRANCH_TAKEN,
    input  logic RESTORE_HISTORY,
    input  logic [HISTORY_BITS-1:0] RESTORE_HISTORY_VALUE
);
    localparam int ENTRIES = 1 << HISTORY_BITS;
    logic [1:0] COUNTER [0:ENTRIES-1];
    logic [HISTORY_BITS-1:0] GLOBAL_HISTORY_REGISTER;
    assign GLOBAL_HISTORY = GLOBAL_HISTORY_REGISTER;
    assign FETCH_PREDICTION_INDEX = FETCH_PC[HISTORY_BITS+1:2] ^ GLOBAL_HISTORY_REGISTER;
    assign FETCH_PREDICTED_TAKEN = ENABLE && COUNTER[FETCH_PREDICTION_INDEX][1];

    always_ff @(posedge clk) begin
        if (reset) GLOBAL_HISTORY_REGISTER <= '0;
        else if (RESTORE_HISTORY) GLOBAL_HISTORY_REGISTER <= RESTORE_HISTORY_VALUE;
        else if (SPECULATIVE_UPDATE) GLOBAL_HISTORY_REGISTER <= {GLOBAL_HISTORY_REGISTER[HISTORY_BITS-2:0], SPECULATIVE_TAKEN};
    end
    for (genvar i = 0; i < ENTRIES; i++) begin : entry
        always_ff @(posedge clk) begin
            if (reset) COUNTER[i] <= 2'b10; // weakly taken
            else if (UPDATE_PREDICTION && (UPDATE_PREDICTION_INDEX == HISTORY_BITS'(i))) begin
                if (ACTUAL_BRANCH_TAKEN && (COUNTER[i] != 2'b11)) COUNTER[i] <= COUNTER[i] + 2'b01;
                else if (!ACTUAL_BRANCH_TAKEN && (COUNTER[i] != 2'b00)) COUNTER[i] <= COUNTER[i] - 2'b01;
            end
        end
    end
endmodule

module DeepTournament #(
    parameter int INDEX_BITS = 7
) (
    input  logic clk,
    input  logic reset,
    input  logic ENABLE,
    input  logic [31:0] FETCH_PC,
    output logic BHT_PREDICTED_TAKEN,
    output logic CHOOSE_GSHARE,
    input  logic UPDATE,
    input  logic [31:0] UPDATE_PC,
    input  logic ACTUAL_BRANCH_TAKEN,
    input  logic BHT_WAS_TAKEN,
    input  logic GSHARE_WAS_TAKEN
);
    localparam int ENTRIES = 1 << INDEX_BITS;
    logic [1:0] BHT [0:ENTRIES-1];
    logic [1:0] CHOOSER [0:ENTRIES-1];
    logic [INDEX_BITS-1:0] FETCH_INDEX, UPDATE_INDEX;
    assign FETCH_INDEX = FETCH_PC[INDEX_BITS+1:2];
    assign UPDATE_INDEX = UPDATE_PC[INDEX_BITS+1:2];
    assign BHT_PREDICTED_TAKEN = ENABLE && BHT[FETCH_INDEX][1];
    assign CHOOSE_GSHARE = CHOOSER[FETCH_INDEX][1];
    logic GSHARE_WAS_RIGHT, BHT_WAS_RIGHT;
    assign GSHARE_WAS_RIGHT = (GSHARE_WAS_TAKEN == ACTUAL_BRANCH_TAKEN);
    assign BHT_WAS_RIGHT = (BHT_WAS_TAKEN == ACTUAL_BRANCH_TAKEN);
    for (genvar i = 0; i < ENTRIES; i++) begin : entry
        always_ff @(posedge clk) begin
            if (reset) begin
                BHT[i] <= 2'b10; // weakly taken
                CHOOSER[i] <= 2'b01; // weakly trust the BHT
            end else if (UPDATE && (UPDATE_INDEX == INDEX_BITS'(i))) begin
                if (ACTUAL_BRANCH_TAKEN && (BHT[i] != 2'b11)) BHT[i] <= BHT[i] + 2'b01;
                else if (!ACTUAL_BRANCH_TAKEN && (BHT[i] != 2'b00)) BHT[i] <= BHT[i] - 2'b01;
                if (GSHARE_WAS_RIGHT && !BHT_WAS_RIGHT && (CHOOSER[i] != 2'b11)) CHOOSER[i] <= CHOOSER[i] + 2'b01;
                else if (BHT_WAS_RIGHT && !GSHARE_WAS_RIGHT && (CHOOSER[i] != 2'b00)) CHOOSER[i] <= CHOOSER[i] - 2'b01;
            end
        end
    end
    /* verilator lint_off UNUSEDSIGNAL */
    logic UNUSED_BITS;
    assign UNUSED_BITS = ^{FETCH_PC[31:INDEX_BITS+2], FETCH_PC[1:0], UPDATE_PC[31:INDEX_BITS+2], UPDATE_PC[1:0]};
    /* verilator lint_on UNUSEDSIGNAL */
endmodule

// The branch target buffer of src/Branch_Target_Buffer.sv with a short tag: TAG_BITS bits of the PC above the
// index (PC[15:6] by default) instead of all of PC[31:6]. The compare in F1's next-PC loop is 10 bits, not 26.
// Two PCs 64 KiB apart now share an entry; a false hit sends fetch to the wrong place, and D1 / M1 repair it as
// they do a stale entry (btb_bad). (Programs here live in 64 KiB, so it never happens in them.)
module DeepBranchTargetBuffer #(
    parameter int ENTRIES = 16,
    parameter int TAG_BITS = 10
) (
    input  logic clk,
    input  logic reset,
    input  logic [31:0] FETCH_PC,
    output logic HIT,
    output logic HIT_IS_JAL,
    output logic HIT_TAKEN, // the entry's own direction counter says taken (a branch)
    output logic [63:0] PREDICTED_TARGET,
    input  logic UPDATE,
    input  logic DECAY, // a branch went not taken: its entry's counter steps down
    input  logic [31:0] UPDATE_PC,
    input  logic [31:0] UPDATE_TARGET,
    input  logic UPDATE_IS_JAL
);
    localparam int INDEX_BITS = $clog2(ENTRIES);
    localparam int TAG_LOW = INDEX_BITS + 2;
    logic [ENTRIES-1:0] ENTRY_VALID, ENTRY_IS_JAL;
    logic [TAG_BITS-1:0] ENTRY_TAG [0:ENTRIES-1];
    logic [1:0] ENTRY_BIAS [0:ENTRIES-1];
    logic SAME;
    logic [31:0] ENTRY_TARGET [0:ENTRIES-1];
    logic [INDEX_BITS-1:0] FETCH_INDEX, UPDATE_INDEX;
    assign FETCH_INDEX = FETCH_PC[TAG_LOW-1:2];
    assign UPDATE_INDEX = UPDATE_PC[TAG_LOW-1:2];
    assign HIT = ENTRY_VALID[FETCH_INDEX] && (ENTRY_TAG[FETCH_INDEX] == FETCH_PC[TAG_LOW +: TAG_BITS]);
    assign HIT_IS_JAL = ENTRY_IS_JAL[FETCH_INDEX];
    assign HIT_TAKEN = ENTRY_BIAS[FETCH_INDEX][1];
    // training: the entry already holds this branch (a taken branch steps its counter up, else starts it weakly taken)
    assign SAME = ENTRY_VALID[UPDATE_INDEX] && (ENTRY_TAG[UPDATE_INDEX] == UPDATE_PC[TAG_LOW +: TAG_BITS]);
    assign PREDICTED_TARGET = {32'd0, ENTRY_TARGET[FETCH_INDEX]};
    always_ff @(posedge clk) begin
        if (reset) begin ENTRY_VALID <= '0; ENTRY_IS_JAL <= '0; end
        else if (UPDATE) begin ENTRY_VALID[UPDATE_INDEX] <= 1'b1; ENTRY_IS_JAL[UPDATE_INDEX] <= UPDATE_IS_JAL; end
    end
    always_ff @(posedge clk) begin
        if (!reset && UPDATE) begin
            ENTRY_TAG[UPDATE_INDEX] <= UPDATE_PC[TAG_LOW +: TAG_BITS]; ENTRY_TARGET[UPDATE_INDEX] <= UPDATE_TARGET;
            ENTRY_BIAS[UPDATE_INDEX] <= !SAME ? 2'b10 : (ENTRY_BIAS[UPDATE_INDEX] == 2'b11) ? 2'b11 : ENTRY_BIAS[UPDATE_INDEX] + 2'b01;
        end else if (!reset && DECAY && SAME && (ENTRY_BIAS[UPDATE_INDEX] != 2'b00)) ENTRY_BIAS[UPDATE_INDEX] <= ENTRY_BIAS[UPDATE_INDEX] - 2'b01;
    end
    /* verilator lint_off UNUSEDSIGNAL */
    logic UNUSED_BITS;
    assign UNUSED_BITS = ^{FETCH_PC[31:TAG_LOW+TAG_BITS], FETCH_PC[1:0], UPDATE_PC[31:TAG_LOW+TAG_BITS], UPDATE_PC[1:0]};
    /* verilator lint_on UNUSEDSIGNAL */
endmodule

`default_nettype wire
