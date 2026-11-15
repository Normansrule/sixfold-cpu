`default_nettype none

// =====================================================================================================
// Data Cache: 4 KiB, 2-way set-associative, 32-byte lines (4 doublewords), 64 sets x 2 ways, write-through.
//
//   address bits:  [31:11] tag   [10:5] set index   [4:3] doubleword in the line   [2:0] byte
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
// =====================================================================================================
module DataCache #(
    parameter int MISS_LATENCY = 10,
    parameter int SETS = 64 // sets per way, a power of two >= 2: 64 is 4 KiB, 16 is 1 KiB
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
    input  logic [255:0] REFILL_LINE
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
    assign READ_DATA = HIT_WAY1 ? WAY1_DATA[SET][64*ADDRESS[4:3] +: 64] : WAY0_DATA[SET][64*ADDRESS[4:3] +: 64];

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
    assign INSTALL = REFILL_BUSY && (REFILL_CYCLES_LEFT == 6'd1) && !(|WRITE_MASK); // a store this cycle goes first
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
            end else if (REFILL_CYCLES_LEFT != 6'd1) begin // (at 1 with a store: hold, install next cycle)
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
            for (int BYTE_LANE = 0; BYTE_LANE < 32; BYTE_LANE = BYTE_LANE + 1) begin
                if (WAY0_BYTE_ENABLES[BYTE_LANE]) WAY0_DATA[DATA_WRITE_SET][8*BYTE_LANE +: 8] <= DATA_WRITE_LINE[8*BYTE_LANE +: 8];
                if (WAY1_BYTE_ENABLES[BYTE_LANE]) WAY1_DATA[DATA_WRITE_SET][8*BYTE_LANE +: 8] <= DATA_WRITE_LINE[8*BYTE_LANE +: 8];
            end
        end
    end

endmodule

`default_nettype wire
