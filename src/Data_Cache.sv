`default_nettype none

// =====================================================================================================
// Data Cache: 2-way set-associative, 32-byte lines (4 doublewords), SETS sets x 2 ways (4 KiB at 64 sets), write-through.
//
//   address bits (S = log2(SETS), 6 by default):  [31:5+S] tag   [4+S:5] set index   [4:3] doubleword in the line   [2:0] byte
//
// Loads look up the address the ALU computed in EXECUTE. A hit (either way) returns the doubleword that
// cycle; a miss makes HIT = 0 and the core holds the load in EXECUTE (DATA_CACHE_STALL) while the refill
// engine brings the line from main memory: MISS_LATENCY + 1 cycles in total.
// Stores go straight to main memory (write-through) and also update the cached line if it is present
// (no allocation on a store miss). Replacement: an empty way first, otherwise the least recently used.
// Next-line prefetch: after a load miss fills line X, line X + 1 is fetched in the background (the
// simplest of the hardware prefetchers that every modern CPU has; theirs also detect strides).
// A background (prefetch) line that arrives in a cycle with a store waits one cycle: the store updates
// the cache that cycle, and the line is read from main memory one cycle later, store included. So the
// data arrays only ever take ONE write per cycle (what an FPGA block RAM or an SRAM macro offers) and
// the cache can never hold a stale copy.
//
// SRAM_ARRAYS (for a real chip): the line data lives in 16 SRAM macros (sram22_64x32m4w8), one pair per way and
// per doubleword of the line (low and high 32 bits), addressed by the set. Tags and valid bits stay in
// flip-flops, so HIT and its way are known in EXECUTE exactly as before. The macro pair of the hit way and
// doubleword is read at the edge where the core loads MEMORY_DATA_CACHE_DATA (CAPTURE), and READ_DATA_LATE then
// shows what that register would hold. A store hit writes its bytes through the macros' byte write masks. A refill
// writes the victim way's eight macros at once; only a doubleword whose pair a load reads in that same cycle
// waits in PENDING (loads and stores to it use the copy there) and goes in at the next free edge. The next
// refill waits for it. Same cycle count as with flip-flop arrays: tests/ check it against the model.
// =====================================================================================================
module DataCache #(
    parameter int MISS_LATENCY = 10,
    parameter int SETS = 64, // sets per way, a power of two >= 2: 64 is 4 KiB (every timing figure here), 16 is 1 KiB
    parameter bit SRAM_ARRAYS = 1'b0 // 1: the line data in SRAM macros (above; SETS <= 64, the macro's depth)
) (
    input  logic clk,
    input  logic reset,
    input  logic FREEZE,
    input  logic LOAD_REQUEST, // A load is in EXECUTE
    input  logic [63:0] ADDRESS,
    input  logic [7:0] WRITE_MASK, // Store byte lanes (from StoreControl)
    input  logic [63:0] WRITE_DATA,
    output logic [63:0] READ_DATA, // The aligned doubleword
    output logic HIT, // 1 unless a load is waiting for its line
    // Main memory refill port
    output logic [63:0] REFILL_ADDRESS,
    input  logic [255:0] REFILL_LINE,
    // SRAM_ARRAYS only
    input  logic CAPTURE, // the core loads MEMORY_DATA_CACHE_DATA at this edge
    output logic [63:0] READ_DATA_LATE // what MEMORY_DATA_CACHE_DATA holds: the SRAM's answer to the last CAPTURE
);

    localparam int SET_BITS = $clog2(SETS);
    localparam int TAG_BITS = 27 - SET_BITS; // address bits [31:5+SET_BITS]

    logic [SETS-1:0] WAY0_VALID, WAY1_VALID;
    logic [TAG_BITS-1:0] WAY0_TAG [0:SETS-1];
    logic [TAG_BITS-1:0] WAY1_TAG [0:SETS-1];
    logic [255:0] WAY0_DATA [0:SETS-1];
    logic [255:0] WAY1_DATA [0:SETS-1];
    logic [SETS-1:0] LEAST_RECENTLY_USED;

    logic [SET_BITS-1:0] SET;
    logic HIT_WAY0, HIT_WAY1, LINE_PRESENT;
    assign SET = ADDRESS[SET_BITS+4:5];
    assign HIT_WAY0 = WAY0_VALID[SET] && (WAY0_TAG[SET] == ADDRESS[31:SET_BITS+5]) && (ADDRESS[63:32] == 32'd0);
    assign HIT_WAY1 = WAY1_VALID[SET] && (WAY1_TAG[SET] == ADDRESS[31:SET_BITS+5]) && (ADDRESS[63:32] == 32'd0);
    assign LINE_PRESENT = HIT_WAY0 || HIT_WAY1;
    assign HIT = !LOAD_REQUEST || LINE_PRESENT;
    assign READ_DATA = SRAM_ARRAYS ? 64'd0 : HIT_WAY1 ? WAY1_DATA[SET][64*ADDRESS[4:3] +: 64] : WAY0_DATA[SET][64*ADDRESS[4:3] +: 64];

    logic REFILL_BUSY;
    logic [5:0] REFILL_CYCLES_LEFT;
    logic [63:0] REFILL_LINE_ADDRESS;
    logic [SET_BITS-1:0] REFILL_SET;
    logic REFILL_VICTIM_WAY;
    logic INSTALL;
    logic STORE_HIT; // A store to a line that is cached: update it
    logic PREFETCH_PENDING;
    logic [63:0] PREFETCH_LINE_ADDRESS;
    logic PREFETCH_PRESENT;
    logic REFILL_IS_DEMAND;
    assign PREFETCH_PRESENT = (WAY0_VALID[PREFETCH_LINE_ADDRESS[SET_BITS+4:5]] && (WAY0_TAG[PREFETCH_LINE_ADDRESS[SET_BITS+4:5]] == PREFETCH_LINE_ADDRESS[31:SET_BITS+5]))
                           || (WAY1_VALID[PREFETCH_LINE_ADDRESS[SET_BITS+4:5]] && (WAY1_TAG[PREFETCH_LINE_ADDRESS[SET_BITS+4:5]] == PREFETCH_LINE_ADDRESS[31:SET_BITS+5]));
    assign REFILL_SET = REFILL_LINE_ADDRESS[SET_BITS+4:5];
    assign REFILL_VICTIM_WAY = !WAY0_VALID[REFILL_SET] ? 1'b0 : !WAY1_VALID[REFILL_SET] ? 1'b1 : LEAST_RECENTLY_USED[REFILL_SET];
    logic PENDING_VALID; // SRAM_ARRAYS: one doubleword of the last refill is still waiting for its macros
    assign INSTALL = REFILL_BUSY && (REFILL_CYCLES_LEFT == 6'd1) && !(|WRITE_MASK) && !PENDING_VALID; // a store this cycle goes first
    assign STORE_HIT = (|WRITE_MASK) && LINE_PRESENT;
    assign REFILL_ADDRESS = REFILL_LINE_ADDRESS;

    always_ff @(posedge clk) begin
        if (reset) begin
            WAY0_VALID <= '0;
            WAY1_VALID <= '0;
            LEAST_RECENTLY_USED <= '0;
            REFILL_BUSY <= 1'b0;
            REFILL_CYCLES_LEFT <= 6'd0;
            REFILL_LINE_ADDRESS <= 64'd0;
            REFILL_IS_DEMAND <= 1'b0;
            PREFETCH_PENDING <= 1'b0;
            PREFETCH_LINE_ADDRESS <= 64'd0;
        end else if (!FREEZE) begin
            if ((LOAD_REQUEST || (|WRITE_MASK)) && LINE_PRESENT) LEAST_RECENTLY_USED[SET] <= HIT_WAY0; // used: the other way is now LRU
            if (!REFILL_BUSY) begin
                if (LOAD_REQUEST && !LINE_PRESENT) begin // demand miss first
                    REFILL_BUSY <= 1'b1;
                    REFILL_CYCLES_LEFT <= MISS_LATENCY[5:0];
                    REFILL_LINE_ADDRESS <= {ADDRESS[63:5], 5'b00000};
                    REFILL_IS_DEMAND <= 1'b1;
                end else if (PREFETCH_PENDING) begin
                    PREFETCH_PENDING <= 1'b0;
                    if (!PREFETCH_PRESENT) begin
                        REFILL_BUSY <= 1'b1;
                        REFILL_CYCLES_LEFT <= MISS_LATENCY[5:0];
                        REFILL_LINE_ADDRESS <= PREFETCH_LINE_ADDRESS;
                        REFILL_IS_DEMAND <= 1'b0;
                    end
                end
            end else if (INSTALL) begin
                REFILL_BUSY <= 1'b0;
                if (REFILL_VICTIM_WAY) WAY1_VALID[REFILL_SET] <= 1'b1; else WAY0_VALID[REFILL_SET] <= 1'b1;
                LEAST_RECENTLY_USED[REFILL_SET] <= !REFILL_VICTIM_WAY;
                if (REFILL_IS_DEMAND) begin
                    PREFETCH_PENDING <= 1'b1;
                    PREFETCH_LINE_ADDRESS <= REFILL_LINE_ADDRESS + 64'd32;
                end
            end else if (REFILL_CYCLES_LEFT != 6'd1) begin // (at 1 with a store or a PENDING word: hold, install next cycle)
                REFILL_CYCLES_LEFT <= REFILL_CYCLES_LEFT - 6'd1;
            end
        end
    end

    // Line data: a refill writes a whole line; a store hit writes only its own bytes, through per-byte write
    // enables, so the store never has to read the line first (no read-modify-write in the store's path).
    // Never both in one cycle: INSTALL waits for a store (see above), so one write port is enough.
    logic [SET_BITS-1:0] DATA_WRITE_SET;
    logic [255:0] DATA_WRITE_LINE;
    logic [31:0] WAY0_BYTE_ENABLES, WAY1_BYTE_ENABLES, STORE_BYTE_ENABLES;
    always_comb begin
        STORE_BYTE_ENABLES = 32'd0;
        STORE_BYTE_ENABLES[8*ADDRESS[4:3] +: 8] = WRITE_MASK;
        DATA_WRITE_SET = INSTALL ? REFILL_SET : SET;
        DATA_WRITE_LINE = INSTALL ? REFILL_LINE : {4{WRITE_DATA}};
        WAY0_BYTE_ENABLES = INSTALL ? {32{!REFILL_VICTIM_WAY}} : (STORE_HIT && HIT_WAY0) ? STORE_BYTE_ENABLES : 32'd0;
        WAY1_BYTE_ENABLES = INSTALL ? {32{REFILL_VICTIM_WAY}} : (STORE_HIT && HIT_WAY1) ? STORE_BYTE_ENABLES : 32'd0;
    end
    always_ff @(posedge clk) begin
        if (!reset && !FREEZE) begin
            if (INSTALL) begin
                if (REFILL_VICTIM_WAY) WAY1_TAG[REFILL_SET] <= REFILL_LINE_ADDRESS[31:SET_BITS+5];
                else WAY0_TAG[REFILL_SET] <= REFILL_LINE_ADDRESS[31:SET_BITS+5];
            end
            if (!SRAM_ARRAYS) for (int BYTE_LANE = 0; BYTE_LANE < 32; BYTE_LANE = BYTE_LANE + 1) begin
                if (WAY0_BYTE_ENABLES[BYTE_LANE]) WAY0_DATA[DATA_WRITE_SET][8*BYTE_LANE +: 8] <= DATA_WRITE_LINE[8*BYTE_LANE +: 8];
                if (WAY1_BYTE_ENABLES[BYTE_LANE]) WAY1_DATA[DATA_WRITE_SET][8*BYTE_LANE +: 8] <= DATA_WRITE_LINE[8*BYTE_LANE +: 8];
            end
        end
    end

    // ------------------------------------------------------------------ SRAM_ARRAYS: the line data in macros
    if (SRAM_ARRAYS) begin : sram
        logic ACCESS_WAY, READ_NOW, ACCESS_IS_PENDING, STORE_TO_SRAM, INSTALL_WRITE;
        logic [1:0] ACCESS_DOUBLEWORD;
        logic PENDING_WAY;
        logic [1:0] PENDING_DOUBLEWORD;
        logic [SET_BITS-1:0] PENDING_SET;
        logic [63:0] PENDING_DATA, PENDING_DATA_STORED;
        logic [63:0] DOUT [0:1][0:3];
        logic [1:0][3:0] BUSY; // [way][doubleword]: the macro pair a load reads or a store writes this edge
        assign ACCESS_WAY = HIT_WAY1;
        assign ACCESS_DOUBLEWORD = ADDRESS[4:3];
        assign ACCESS_IS_PENDING = PENDING_VALID && (PENDING_SET == SET) && (PENDING_WAY == ACCESS_WAY) && (PENDING_DOUBLEWORD == ACCESS_DOUBLEWORD);
        assign READ_NOW = CAPTURE && LOAD_REQUEST && LINE_PRESENT && !ACCESS_IS_PENDING;
        assign STORE_TO_SRAM = !reset && !FREEZE && STORE_HIT && !ACCESS_IS_PENDING; // (a store to the PENDING doubleword updates the copy)
        assign INSTALL_WRITE = !reset && !FREEZE && INSTALL;
        always_comb begin
            BUSY = '0;
            BUSY[ACCESS_WAY][ACCESS_DOUBLEWORD] = READ_NOW || STORE_TO_SRAM;
            for (int BYTE_LANE = 0; BYTE_LANE < 8; BYTE_LANE++)
                PENDING_DATA_STORED[8*BYTE_LANE +: 8] = WRITE_MASK[BYTE_LANE] ? WRITE_DATA[8*BYTE_LANE +: 8] : PENDING_DATA[8*BYTE_LANE +: 8];
        end
        for (genvar WAY = 0; WAY < 2; WAY++) begin : way
            for (genvar DOUBLEWORD = 0; DOUBLEWORD < 4; DOUBLEWORD++) begin : doubleword
                logic ACCESS, WRITE_LINE, WRITE_PENDING;
                assign ACCESS = BUSY[WAY][DOUBLEWORD];
                assign WRITE_LINE = INSTALL_WRITE && (REFILL_VICTIM_WAY == WAY[0]) && !ACCESS;
                assign WRITE_PENDING = PENDING_VALID && (PENDING_WAY == WAY[0]) && (PENDING_DOUBLEWORD == DOUBLEWORD[1:0]) && !ACCESS;
                logic [5:0] ADDR;
                logic [63:0] DIN;
                logic [7:0] MASK;
                assign ADDR = 6'(ACCESS ? SET : WRITE_LINE ? REFILL_SET : PENDING_SET);
                assign DIN = ACCESS ? WRITE_DATA : WRITE_LINE ? REFILL_LINE[64*DOUBLEWORD +: 64] : PENDING_DATA;
                assign MASK = ACCESS ? WRITE_MASK : 8'hFF;
                for (genvar HALF = 0; HALF < 2; HALF++) begin : half
                    sram22_64x32m4w8 data (
                        .clk (clk), .rstb (1'b1), .ce (ACCESS || WRITE_LINE || WRITE_PENDING),
                        .we (STORE_TO_SRAM && ACCESS || WRITE_LINE || WRITE_PENDING), .wmask (MASK[4*HALF +: 4]), .addr (ADDR),
                        .din (DIN[32*HALF +: 32]), .dout (DOUT[WAY][DOUBLEWORD][32*HALF +: 32])
                    );
                end
            end
        end
        always_ff @(posedge clk) begin
            if (reset) PENDING_VALID <= 1'b0;
            else if (INSTALL_WRITE && READ_NOW && (ACCESS_WAY == REFILL_VICTIM_WAY)) begin
                PENDING_VALID <= 1'b1;
                PENDING_WAY <= REFILL_VICTIM_WAY;
                PENDING_DOUBLEWORD <= ACCESS_DOUBLEWORD;
                PENDING_SET <= REFILL_SET;
                PENDING_DATA <= REFILL_LINE[64*ACCESS_DOUBLEWORD +: 64];
            end else if (PENDING_VALID) begin
                if (!FREEZE && STORE_HIT && ACCESS_IS_PENDING) PENDING_DATA <= PENDING_DATA_STORED;
                else if (!BUSY[PENDING_WAY][PENDING_DOUBLEWORD]) PENDING_VALID <= 1'b0;
            end
        end
        // READ_DATA_LATE = the value MEMORY_DATA_CACHE_DATA would hold
        logic FRESH, LATE_HIT, LATE_FROM_PENDING, LATE_WAY;
        logic [1:0] LATE_DOUBLEWORD;
        logic [63:0] LATE_PENDING_DATA, HOLD;
        always_ff @(posedge clk) begin
            if (reset) begin
                FRESH <= 1'b0;
                HOLD <= 64'd0;
            end else begin
                FRESH <= CAPTURE;
                HOLD <= READ_DATA_LATE;
            end
            if (CAPTURE) begin
                LATE_HIT <= LOAD_REQUEST && LINE_PRESENT;
                LATE_FROM_PENDING <= ACCESS_IS_PENDING;
                LATE_PENDING_DATA <= PENDING_DATA;
                LATE_WAY <= ACCESS_WAY;
                LATE_DOUBLEWORD <= ACCESS_DOUBLEWORD;
            end
        end
        assign READ_DATA_LATE = !FRESH ? HOLD : !LATE_HIT ? 64'd0 : LATE_FROM_PENDING ? LATE_PENDING_DATA : DOUT[LATE_WAY][LATE_DOUBLEWORD];
`ifdef SIXFOLD_SRAM_COVERAGE // simulation only: how often the PENDING word and the refill hold really happen
        int unsigned COVER_PENDING = 0, COVER_HELD = 0, COVER_STORE_PENDING = 0, COVER_LOAD_PENDING = 0;
        always_ff @(posedge clk) begin
            if (INSTALL_WRITE && READ_NOW && (ACCESS_WAY == REFILL_VICTIM_WAY)) COVER_PENDING <= COVER_PENDING + 1;
            if (!reset && !FREEZE && REFILL_BUSY && (REFILL_CYCLES_LEFT == 6'd1) && !(|WRITE_MASK) && PENDING_VALID) COVER_HELD <= COVER_HELD + 1;
            if (!reset && !FREEZE && STORE_HIT && ACCESS_IS_PENDING) COVER_STORE_PENDING <= COVER_STORE_PENDING + 1;
            if (CAPTURE && LOAD_REQUEST && LINE_PRESENT && ACCESS_IS_PENDING) COVER_LOAD_PENDING <= COVER_LOAD_PENDING + 1;
        end
        final $display("SRAM coverage %m: %0d words pending, %0d refills held, %0d stores and %0d loads served by PENDING",
                       COVER_PENDING, COVER_HELD, COVER_STORE_PENDING, COVER_LOAD_PENDING);
`endif
    end else begin : flops
        assign PENDING_VALID = 1'b0;
        assign READ_DATA_LATE = 64'd0;
    end

endmodule

`default_nettype wire
