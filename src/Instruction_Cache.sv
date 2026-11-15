`default_nettype none

// =====================================================================================================
// Instruction Cache: 2-way set-associative, 32-byte lines (8 instructions), SETS sets x 2 ways:
// 4 KiB at the default 64 sets (the size every timing figure in this repository uses).
//
//   address bits:  [31:5+S] tag   [4+S:5] set index   [4:2] word in the line   [1:0] always 00
//                  (S = log2(SETS): 6 by default, so [31:11] tag and [10:5] set)
//
// Each set holds two lines ("ways"), so two pieces of code that land in the same set can both stay.
// A hit in either way returns the instruction the same cycle. On a miss FETCH1 waits while the refill
// engine fetches the line from main memory (MISS_LATENCY cycles; MISS_LATENCY + 1 in total).
// Replacement: an empty way first, otherwise the LEAST RECENTLY USED way of the set (1 LRU bit per set).
// Next-line prefetch: after a demand miss fills line X, line X + 1 is fetched in the background.
// Instruction memory is never written by the program (no self-modifying code), so no invalidation.
// =====================================================================================================
module InstructionCache #(
    parameter int MISS_LATENCY = 10,
    parameter int SETS = 64 // sets per way, a power of two >= 2: 64 is 4 KiB, 16 is 1 KiB
) (
    input  logic clk,
    input  logic reset,
    input  logic FREEZE,
    input  logic [63:0] FETCH_ADDRESS,
    output logic [31:0] INSTRUCTION,
    output logic HIT,
    // Main memory refill port
    output logic [63:0] REFILL_ADDRESS, // Line address being filled
    input  logic [255:0] REFILL_LINE // The 32 bytes at REFILL_ADDRESS (main memory answers after MISS_LATENCY cycles)
);

    localparam int SET_BITS = $clog2(SETS);
    localparam int TAG_BITS = 27 - SET_BITS; // address bits [31:5+SET_BITS]

    logic [SETS-1:0] WAY0_VALID, WAY1_VALID;
    logic [TAG_BITS-1:0] WAY0_TAG [0:SETS-1];
    logic [TAG_BITS-1:0] WAY1_TAG [0:SETS-1];
    logic [255:0] WAY0_DATA [0:SETS-1];
    logic [255:0] WAY1_DATA [0:SETS-1];
    logic [SETS-1:0] LEAST_RECENTLY_USED; // per set: which way to replace next (0 or 1)

    logic [SET_BITS-1:0] FETCH_SET;
    logic HIT_WAY0, HIT_WAY1;
    assign FETCH_SET = FETCH_ADDRESS[SET_BITS+4:5];
    assign HIT_WAY0 = WAY0_VALID[FETCH_SET] && (WAY0_TAG[FETCH_SET] == FETCH_ADDRESS[31:SET_BITS+5]) && (FETCH_ADDRESS[63:32] == 32'd0);
    assign HIT_WAY1 = WAY1_VALID[FETCH_SET] && (WAY1_TAG[FETCH_SET] == FETCH_ADDRESS[31:SET_BITS+5]) && (FETCH_ADDRESS[63:32] == 32'd0);
    assign HIT = HIT_WAY0 || HIT_WAY1;
    assign INSTRUCTION = HIT_WAY1 ? WAY1_DATA[FETCH_SET][32*FETCH_ADDRESS[4:2] +: 32] : WAY0_DATA[FETCH_SET][32*FETCH_ADDRESS[4:2] +: 32];

    // Refill engine
    logic REFILL_BUSY;
    logic [5:0] REFILL_CYCLES_LEFT;
    logic [63:0] REFILL_LINE_ADDRESS;
    logic REFILL_IS_DEMAND; // This refill was caused by a FETCH1 miss (not a prefetch)
    logic PREFETCH_PENDING; // Line X + 1 should be fetched when the engine is free
    logic [63:0] PREFETCH_LINE_ADDRESS;
    logic PREFETCH_PRESENT; // ... but it may already be in the cache
    logic [SET_BITS-1:0] REFILL_SET, PREFETCH_SET;
    logic REFILL_VICTIM_WAY; // Empty way first, else the least recently used one
    logic INSTALL; // The line arrives this cycle
    assign REFILL_SET = REFILL_LINE_ADDRESS[SET_BITS+4:5];
    assign PREFETCH_SET = PREFETCH_LINE_ADDRESS[SET_BITS+4:5];
    assign PREFETCH_PRESENT = (WAY0_VALID[PREFETCH_SET] && (WAY0_TAG[PREFETCH_SET] == PREFETCH_LINE_ADDRESS[31:SET_BITS+5]))
                           || (WAY1_VALID[PREFETCH_SET] && (WAY1_TAG[PREFETCH_SET] == PREFETCH_LINE_ADDRESS[31:SET_BITS+5]));
    assign REFILL_VICTIM_WAY = !WAY0_VALID[REFILL_SET] ? 1'b0 : !WAY1_VALID[REFILL_SET] ? 1'b1 : LEAST_RECENTLY_USED[REFILL_SET];
    assign INSTALL = REFILL_BUSY && (REFILL_CYCLES_LEFT == 6'd1);
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
            if (HIT) LEAST_RECENTLY_USED[FETCH_SET] <= HIT_WAY0; // the OTHER way is now the least recently used
            if (!REFILL_BUSY) begin
                if (!HIT) begin // Start fetching the missing line (demand first)
                    REFILL_BUSY <= 1'b1;
                    REFILL_CYCLES_LEFT <= MISS_LATENCY[5:0];
                    REFILL_LINE_ADDRESS <= {FETCH_ADDRESS[63:5], 5'b00000};
                    REFILL_IS_DEMAND <= 1'b1;
                end else if (PREFETCH_PENDING) begin // Nothing missing now: fetch the next line ahead of time
                    PREFETCH_PENDING <= 1'b0;
                    if (!PREFETCH_PRESENT) begin
                        REFILL_BUSY <= 1'b1;
                        REFILL_CYCLES_LEFT <= MISS_LATENCY[5:0];
                        REFILL_LINE_ADDRESS <= PREFETCH_LINE_ADDRESS;
                        REFILL_IS_DEMAND <= 1'b0;
                    end
                end
            end else if (INSTALL) begin // Main memory delivers the line: install it in the victim way
                REFILL_BUSY <= 1'b0;
                if (REFILL_VICTIM_WAY) WAY1_VALID[REFILL_SET] <= 1'b1; else WAY0_VALID[REFILL_SET] <= 1'b1;
                LEAST_RECENTLY_USED[REFILL_SET] <= !REFILL_VICTIM_WAY; // the new line is the most recently used
                if (REFILL_IS_DEMAND) begin
                    PREFETCH_PENDING <= 1'b1;
                    PREFETCH_LINE_ADDRESS <= REFILL_LINE_ADDRESS + 64'd32;
                end
            end else begin
                REFILL_CYCLES_LEFT <= REFILL_CYCLES_LEFT - 6'd1;
            end
        end
    end

    always_ff @(posedge clk) begin
        if (!reset && !FREEZE && INSTALL) begin
            if (REFILL_VICTIM_WAY) begin
                WAY1_TAG[REFILL_SET] <= REFILL_LINE_ADDRESS[31:SET_BITS+5];
                WAY1_DATA[REFILL_SET] <= REFILL_LINE;
            end else begin
                WAY0_TAG[REFILL_SET] <= REFILL_LINE_ADDRESS[31:SET_BITS+5];
                WAY0_DATA[REFILL_SET] <= REFILL_LINE;
            end
        end
    end

endmodule

`default_nettype wire
