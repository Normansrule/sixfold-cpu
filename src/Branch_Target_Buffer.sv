`default_nettype none

// =====================================================================================================
// Branch Target Buffer (BTB): lets FETCH1 jump to a predicted target with ZERO bubbles.
//
// Without it, FETCH1 only sees an address; the instruction bits (and so the target PC + imm) are only
// known in FETCH2, one cycle later, which costs one bubble for every taken branch and every JAL.
// The BTB remembers, for recently TAKEN branches and JALs, "the instruction at this PC jumps to that PC":
//
//   FETCH1 : index = PC[5:2] (16 entries), hit = valid && tag == PC[31:6]
//            hit && (JAL || gshare says taken)  ->  next PC = stored target (no bubble)
//   EXECUTE: a taken branch or a JAL writes {tag, target, is JAL} into its entry
//
// The full tag compare means a hit is always the same instruction, so FETCH2 always agrees with the
// BTB's choice (the direction bit is the same gshare counter both stages use).
// =====================================================================================================
module BranchTargetBuffer #(
    parameter int ENTRIES = 16
) (
    input  logic clk,
    input  logic reset,
    // ===== Fetch 1: Lookup =====
    input  logic [63:0] FETCH_PC,
    output logic HIT, // This PC was a taken branch or a JAL before
    output logic HIT_IS_JAL, // ... and it was a JAL (always taken)
    output logic [63:0] PREDICTED_TARGET,
    // ===== Execute: Update =====
    input  logic UPDATE, // A taken branch or a JAL resolved in Execute
    input  logic [63:0] UPDATE_PC,
    input  logic [63:0] UPDATE_TARGET,
    input  logic UPDATE_IS_JAL
);

    localparam int INDEX_BITS = $clog2(ENTRIES);
    localparam int TAG_LOW = INDEX_BITS + 2;

    logic [ENTRIES-1:0] ENTRY_VALID;
    logic [ENTRIES-1:0] ENTRY_IS_JAL;
    logic [31-TAG_LOW:0] ENTRY_TAG [0:ENTRIES-1]; // PC[31:TAG_LOW]
    logic [31:0] ENTRY_TARGET [0:ENTRIES-1]; // Low 32 bits of the target (programs live below 4 GiB)

    logic [INDEX_BITS-1:0] FETCH_INDEX;
    logic [INDEX_BITS-1:0] UPDATE_INDEX;
    assign FETCH_INDEX = FETCH_PC[TAG_LOW-1:2];
    assign UPDATE_INDEX = UPDATE_PC[TAG_LOW-1:2];

    assign HIT = ENTRY_VALID[FETCH_INDEX] && (ENTRY_TAG[FETCH_INDEX] == FETCH_PC[31:TAG_LOW]) && (FETCH_PC[63:32] == 32'd0);
    assign HIT_IS_JAL = ENTRY_IS_JAL[FETCH_INDEX];
    assign PREDICTED_TARGET = {32'd0, ENTRY_TARGET[FETCH_INDEX]};

    // Only targets below 4 GiB fit an entry (ENTRY_TARGET keeps 32 bits). A jump to a target above that is
    // simply not remembered: FETCH2 redirects it with one bubble instead. Before this guard the entry kept the
    // low 32 bits and FETCH1 jumped to the wrong address with nothing to correct it (found by riscv-formal's
    // pc_fwd check: a JAL from 0x8bfc0 back to 0xffff_ffff_ffff_b73c).
    logic REMEMBER;
    // The jump itself must also sit below 4 GiB: a lookup only compares PC[31:6] (and needs PC[63:32] = 0),
    // so an entry written from 0xffff_ffff_ffff_fffc would otherwise hit at 0x0000_0000_ffff_fffc, a different
    // instruction (found by pc_fwd too, right after the first fix).
    assign REMEMBER = UPDATE && (UPDATE_TARGET[63:32] == 32'd0) && (UPDATE_PC[63:32] == 32'd0);
    always_ff @(posedge clk) begin
        if (reset) begin
            ENTRY_VALID <= '0; // Empty after reset: the first time any branch is taken it costs the FETCH2 redirect
            ENTRY_IS_JAL <= '0;
        end else if (REMEMBER) begin
            ENTRY_VALID[UPDATE_INDEX] <= 1'b1;
            ENTRY_IS_JAL[UPDATE_INDEX] <= UPDATE_IS_JAL;
        end
    end

    always_ff @(posedge clk) begin
        if (!reset && REMEMBER) begin
            ENTRY_TAG[UPDATE_INDEX] <= UPDATE_PC[31:TAG_LOW];
            ENTRY_TARGET[UPDATE_INDEX] <= UPDATE_TARGET[31:0];
        end
    end

    /* verilator lint_off UNUSEDSIGNAL */
    logic UNUSED_BITS;
    assign UNUSED_BITS = ^{UPDATE_PC[1:0], FETCH_PC[1:0]};
    /* verilator lint_on UNUSEDSIGNAL */

endmodule

`default_nettype wire
