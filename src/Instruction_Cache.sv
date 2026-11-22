`default_nettype none

// =====================================================================================================
// Instruction Cache: 2-way set-associative, 32-byte lines (8 instructions), SETS sets x 2 ways (4 KiB at 64 sets).
//
//   address bits:  [31:SET_BITS+5] tag   [SET_BITS+4:5] set index   [4:2] word in the line   [1:0] always 00
//
// Each set holds two lines ("ways"), so two pieces of code that land in the same set can both stay.
// A hit in either way returns the instruction the same cycle. On a miss FETCH1 waits while the refill
// engine fetches the line from main memory (MISS_LATENCY cycles; MISS_LATENCY + 1 in total).
// Replacement: an empty way first, otherwise the LEAST RECENTLY USED way of the set (1 LRU bit per set).
// Next-line prefetch: after a demand miss fills line X, line X + 1 is fetched in the background.
// STREAM_PREFETCH (the turbo edition): also, whenever the engine is idle and the line after the one FETCH1 is
// in is missing, fetch it: straight-line code then finds every next line on its way instead of missing every
// other line. NEXT_LINE_ADDRESS is registered from the fetch address, so the tag check reads only registers.
// Code that rewrites instructions must run fence.i: with ZIFENCEI, Riscv64 pulses this cache's reset (icache_invalidate).
// SRAM_ARRAYS (for a real chip): the line data lives in 16 SRAM macros (sram22_64x32m4w8: 64 words of 32 bits,
// one per way and per word of the line, addressed by the set). Tags and valid bits stay in flip-flops, so a hit
// and its way are known in the same cycle, exactly as before. An SRAM answers one clock edge after it is read,
// so the macro of the hit way and word is read at the edge where the core loads FETCH2_INSTRUCTION (CAPTURE),
// and INSTRUCTION_LATE then shows what that register would hold: the core uses it in its place.
// A refill writes the victim way's eight macros at once. Only if FETCH1 reads one of them in that very cycle
// (same way, same word, another set) does that one word wait in PENDING (read from there meanwhile) and go in
// at the next free edge; the next refill waits for it (a one-cycle hold the model never needs: see docs/SILICON.md).
// The cycle count is the same as with flip-flop arrays: tests/ check it against the model.
// =====================================================================================================
module InstructionCache #(
    parameter int MISS_LATENCY = 10,
    parameter int SETS = 64, // sets per way, a power of two >= 2: 64 is 4 KiB (every timing figure here), 16 is 1 KiB
    parameter bit STREAM_PREFETCH = 1'b0, // 1: keep the next line of the fetch stream in the cache (above)
    parameter bit SRAM_ARRAYS = 1'b0 // 1: the line data in SRAM macros (above; SETS <= 64, the macro's depth)
) (
    input  logic clk,
    input  logic reset,
    input  logic FREEZE,
    input  logic [63:0] FETCH_ADDRESS,
    output logic [31:0] INSTRUCTION,
    output logic HIT,
    // Main memory refill port
    output logic [63:0] REFILL_ADDRESS, // Line address being filled
    input  logic [255:0] REFILL_LINE, // The 32 bytes at REFILL_ADDRESS (main memory answers after MISS_LATENCY cycles)
    // SRAM_ARRAYS only
    input  logic CAPTURE, // the core loads FETCH2_INSTRUCTION at this edge
    output logic [31:0] INSTRUCTION_LATE // what FETCH2_INSTRUCTION holds: the SRAM's answer to the last CAPTURE
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
    assign INSTRUCTION = SRAM_ARRAYS ? 32'd0 : HIT_WAY1 ? WAY1_DATA[FETCH_SET][32*FETCH_ADDRESS[4:2] +: 32] : WAY0_DATA[FETCH_SET][32*FETCH_ADDRESS[4:2] +: 32];

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
    logic PENDING_VALID; // SRAM_ARRAYS: one word of the last refill is still waiting for its macro
    assign INSTALL = REFILL_BUSY && (REFILL_CYCLES_LEFT == 6'd1) && !PENDING_VALID;

    // STREAM_PREFETCH: the line after the one FETCH1 was in last cycle
    logic [63:0] NEXT_LINE_ADDRESS;
    logic NEXT_LINE_VALID, NEXT_LINE_PRESENT;
    logic [SET_BITS-1:0] NEXT_SET;
    assign NEXT_SET = NEXT_LINE_ADDRESS[SET_BITS+4:5];
    assign NEXT_LINE_PRESENT = (WAY0_VALID[NEXT_SET] && (WAY0_TAG[NEXT_SET] == NEXT_LINE_ADDRESS[31:SET_BITS+5]))
                            || (WAY1_VALID[NEXT_SET] && (WAY1_TAG[NEXT_SET] == NEXT_LINE_ADDRESS[31:SET_BITS+5]));
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
            NEXT_LINE_ADDRESS <= 64'd0;
            NEXT_LINE_VALID <= 1'b0;
        end else if (!FREEZE) begin
            if (STREAM_PREFETCH) begin
                NEXT_LINE_ADDRESS <= {FETCH_ADDRESS[63:5], 5'b00000} + 64'd32;
                NEXT_LINE_VALID <= 1'b1;
            end
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
                end else if (STREAM_PREFETCH && NEXT_LINE_VALID && !NEXT_LINE_PRESENT) begin // keep the stream one line ahead
                    REFILL_BUSY <= 1'b1;
                    REFILL_CYCLES_LEFT <= MISS_LATENCY[5:0];
                    REFILL_LINE_ADDRESS <= NEXT_LINE_ADDRESS;
                    REFILL_IS_DEMAND <= 1'b0;
                end
            end else if (INSTALL) begin // Main memory delivers the line: install it in the victim way
                REFILL_BUSY <= 1'b0;
                if (REFILL_VICTIM_WAY) WAY1_VALID[REFILL_SET] <= 1'b1; else WAY0_VALID[REFILL_SET] <= 1'b1;
                LEAST_RECENTLY_USED[REFILL_SET] <= !REFILL_VICTIM_WAY; // the new line is the most recently used
                if (REFILL_IS_DEMAND) begin
                    PREFETCH_PENDING <= 1'b1;
                    PREFETCH_LINE_ADDRESS <= REFILL_LINE_ADDRESS + 64'd32;
                end
            end else if (REFILL_CYCLES_LEFT != 6'd1) begin // (at 1 with a word PENDING: hold, install next cycle)
                REFILL_CYCLES_LEFT <= REFILL_CYCLES_LEFT - 6'd1;
            end
        end
    end

    always_ff @(posedge clk) begin
        if (!reset && !FREEZE && INSTALL) begin
            if (REFILL_VICTIM_WAY) begin
                WAY1_TAG[REFILL_SET] <= REFILL_LINE_ADDRESS[31:SET_BITS+5];
                if (!SRAM_ARRAYS) WAY1_DATA[REFILL_SET] <= REFILL_LINE;
            end else begin
                WAY0_TAG[REFILL_SET] <= REFILL_LINE_ADDRESS[31:SET_BITS+5];
                if (!SRAM_ARRAYS) WAY0_DATA[REFILL_SET] <= REFILL_LINE;
            end
        end
    end

    // ------------------------------------------------------------------ SRAM_ARRAYS: the line data in macros
    if (SRAM_ARRAYS) begin : sram
        logic READ_WAY, READ_NOW, READ_FROM_PENDING, INSTALL_WRITE;
        logic [2:0] READ_WORD;
        logic PENDING_WAY;
        logic [2:0] PENDING_WORD;
        logic [SET_BITS-1:0] PENDING_SET;
        logic [31:0] PENDING_DATA;
        logic [31:0] DOUT [0:1][0:7];
        logic [1:0][7:0] BUSY_READ; // [way][word]: the macro FETCH1 reads this edge
        assign READ_WAY = HIT_WAY1;
        assign READ_WORD = FETCH_ADDRESS[4:2];
        assign READ_FROM_PENDING = PENDING_VALID && (PENDING_SET == FETCH_SET) && (PENDING_WAY == READ_WAY) && (PENDING_WORD == READ_WORD);
        assign READ_NOW = CAPTURE && HIT && !READ_FROM_PENDING; // a miss needs no data: FETCH2 will not be valid
        assign INSTALL_WRITE = !reset && !FREEZE && INSTALL;
        always_comb begin
            BUSY_READ = '0;
            BUSY_READ[READ_WAY][READ_WORD] = READ_NOW;
        end
        for (genvar WAY = 0; WAY < 2; WAY++) begin : way
            for (genvar WORD = 0; WORD < 8; WORD++) begin : word
                logic WRITE_LINE, WRITE_PENDING, READ;
                assign READ = BUSY_READ[WAY][WORD];
                assign WRITE_LINE = INSTALL_WRITE && (REFILL_VICTIM_WAY == WAY[0]) && !READ;
                assign WRITE_PENDING = PENDING_VALID && (PENDING_WAY == WAY[0]) && (PENDING_WORD == WORD[2:0]) && !READ;
                sram22_64x32m4w8 data (
                    .clk (clk), .rstb (1'b1), .ce (READ || WRITE_LINE || WRITE_PENDING), .we (WRITE_LINE || WRITE_PENDING),
                    .wmask (4'hF), .addr (6'(READ ? FETCH_SET : WRITE_LINE ? REFILL_SET : PENDING_SET)),
                    .din (WRITE_LINE ? REFILL_LINE[32*WORD +: 32] : PENDING_DATA), .dout (DOUT[WAY][WORD])
                );
            end
        end
        // the one word a refill could not write (its macro was being read): written at the next edge it is free
        always_ff @(posedge clk) begin
            if (reset) PENDING_VALID <= 1'b0;
            else if (INSTALL_WRITE && READ_NOW && (READ_WAY == REFILL_VICTIM_WAY)) begin
                PENDING_VALID <= 1'b1;
                PENDING_WAY <= REFILL_VICTIM_WAY;
                PENDING_WORD <= READ_WORD;
                PENDING_SET <= REFILL_SET;
                PENDING_DATA <= REFILL_LINE[32*READ_WORD +: 32];
            end else if (PENDING_VALID && !BUSY_READ[PENDING_WAY][PENDING_WORD]) PENDING_VALID <= 1'b0;
        end
        // INSTRUCTION_LATE = the value FETCH2_INSTRUCTION would hold
        logic FRESH, LATE_HIT, LATE_FROM_PENDING, LATE_WAY;
        logic [2:0] LATE_WORD;
        logic [31:0] LATE_PENDING_DATA, HOLD;
        always_ff @(posedge clk) begin
            if (reset) begin
                FRESH <= 1'b0;
                HOLD <= 32'h0000_0013; // the NOP the core's FETCH2_INSTRUCTION resets to
            end else begin
                FRESH <= CAPTURE;
                HOLD <= INSTRUCTION_LATE;
            end
            if (CAPTURE) begin
                LATE_HIT <= HIT;
                LATE_FROM_PENDING <= READ_FROM_PENDING;
                LATE_PENDING_DATA <= PENDING_DATA;
                LATE_WAY <= READ_WAY;
                LATE_WORD <= READ_WORD;
            end
        end
        assign INSTRUCTION_LATE = !FRESH ? HOLD : !LATE_HIT ? 32'd0 : LATE_FROM_PENDING ? LATE_PENDING_DATA : DOUT[LATE_WAY][LATE_WORD];
`ifdef SIXFOLD_SRAM_COVERAGE // simulation only: how often the PENDING word and the refill hold really happen
        int unsigned COVER_PENDING = 0, COVER_HELD = 0;
        always_ff @(posedge clk) begin
            if (INSTALL_WRITE && READ_NOW && (READ_WAY == REFILL_VICTIM_WAY)) COVER_PENDING <= COVER_PENDING + 1;
            if (!reset && !FREEZE && REFILL_BUSY && (REFILL_CYCLES_LEFT == 6'd1) && PENDING_VALID) COVER_HELD <= COVER_HELD + 1;
        end
        final $display("SRAM coverage %m: %0d words pending, %0d refills held", COVER_PENDING, COVER_HELD);
`endif
    end else begin : flops
        assign PENDING_VALID = 1'b0;
        assign INSTRUCTION_LATE = 32'd0;
    end

endmodule

`default_nettype wire
