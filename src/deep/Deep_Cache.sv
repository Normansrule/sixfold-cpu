`default_nettype none

// =====================================================================================================
// DeepCache: the deep-pipeline edition's instruction and data cache (model/deep.js, prefetchingRefill in model/core.js)
//
// The same arrays as InstructionCache / DataCache: 4 KiB, 2-way set-associative, 32-byte lines, one LRU bit
// per set, write-through stores that update a cached line, a next-line prefetch after every demand miss and
// (STREAM_PREFETCH) the line after the fetch stream's. What changes is who asks and when:
//   LOOKUP  the address being checked this cycle (F3 for instructions, M1 for data): HIT and the doubleword
//   PROBE   a second tag port (F1 waiting for a line asks "is it in yet?"). The core gives next cycle's probe
//           address (PROBE_NEXT_ADDRESS): like the lookup, and like the prefetcher's own checks ("is the line it
//           would fetch already here?"), the set's tags are read a cycle ahead and only compared in the cycle itself
//   DEMAND  start a refill of DEMAND_ADDRESS's line when the engine is free (the core decides when)
//   BUSY, BUSY_LINE, CYCLES_LEFT  the engine's state: F1 restarts once the line it waits for is CYCLES_LEFT
//           cycles away, so the instruction (or the replayed load) reaches F3 (M1) just as it is installed
//   PREDECODE (instruction cache): as a line installs, each of its 8 instructions is predecoded and its jump
//           target (PC + immediate of a JAL or a branch) added up, and kept beside the line (+36 bits per
//           instruction). LOOKUP_PREDECODE gives the looked-up instruction's: F3 then decides a redirect from
//           four ready bits and sends F1 to a ready target, with no decoder and no 32-bit adder in its cycle.
//           (The data is the same as decoding the word in F3: only when the work is done changes.)
//   EARLY_SET the arrays are read a cycle ahead, like a clocked SRAM: the stage before the lookup gives the set
//           (EARLY_SET, taken when EARLY_LOAD, else the same set is read again), the row (both ways' valid bits,
//           tags, data, predecode) is latched at the clock edge, and the lookup cycle only compares tags and
//           picks the way. A write in the cycle a row is latched (a refill installing, a store) goes into the
//           latched copy too ("write first"), so nothing is stale.
// The data and predecode arrays are DeepCacheArray (below): what would be an SRAM macro on a chip, with a
// clocked read and byte-lane writes. Timing DeepCache treats them as black boxes (a macro's access time comes
// from its datasheet, not from logic synthesis); the tags, valid bits and LRU bits stay in flip-flops here,
// because the probe and the refill engine read them at other sets in the same cycle.
// =====================================================================================================
module DeepCache #(
    parameter int MISS_LATENCY = 21,
    parameter bit STREAM_PREFETCH = 1'b0,
    parameter bit PREDECODE = 1'b0
) (
    input  logic clk,
    input  logic reset,
    input  logic FREEZE,
    input  logic [63:0] LOOKUP_ADDRESS,
    input  logic [5:0] EARLY_SET, // the set of next cycle's LOOKUP_ADDRESS
    input  logic EARLY_LOAD, // read EARLY_SET's row (else read the latched row's set again: the lookup holds)
    output logic LOOKUP_HIT,
    output logic [63:0] LOOKUP_DATA, // the aligned doubleword at LOOKUP_ADDRESS
    output logic [35:0] LOOKUP_PREDECODE, // (PREDECODE) {target[31:0], is_jal, is_branch, is_call, is_return} of the word at LOOKUP_ADDRESS
    output logic LOOKUP_WAY0, LOOKUP_WAY1, // which way hit (both only if a line were cached twice)
    output logic [63:0] LOOKUP_DATA0, LOOKUP_DATA1, // each way's doubleword, for a core that picks the way a stage later
    output logic [35:0] LOOKUP_PREDECODE0, LOOKUP_PREDECODE1,
    input  logic TOUCH, // a line was used: way 0 of set TOUCH_SET if TOUCH_WAY0, else way 1, becomes the most recently used
    input  logic [5:0] TOUCH_SET,
    input  logic TOUCH_WAY0,
    input  logic [7:0] WRITE_MASK, // a store at LOOKUP_ADDRESS (data cache only)
    input  logic [63:0] WRITE_DATA,
    input  logic [63:0] PROBE_NEXT_ADDRESS, // the address PROBE_HIT answers for next cycle
    output logic PROBE_HIT,
    input  logic DEMAND,
    input  logic [63:0] DEMAND_ADDRESS,
    output logic BUSY,
    output logic [63:0] BUSY_LINE,
    output logic [5:0] CYCLES_LEFT,
    output logic [63:0] REFILL_ADDRESS,
    input  logic [255:0] REFILL_LINE
);

    logic [63:0] WAY0_VALID, WAY1_VALID;
    logic [20:0] WAY0_TAG [0:63];
    logic [20:0] WAY1_TAG [0:63];
    logic [63:0] LEAST_RECENTLY_USED;

    function automatic logic present(input logic [63:0] address, input logic [63:0] v0, input logic [63:0] v1, input logic [20:0] t0, input logic [20:0] t1);
        return (address[63:32] == 32'd0) && ((v0[address[10:5]] && (t0 == address[31:11])) || (v1[address[10:5]] && (t1 == address[31:11])));
    endfunction

    logic [5:0] SET;
    logic HIT_WAY0, HIT_WAY1;
    assign SET = LOOKUP_ADDRESS[10:5];
    // the lookup's row: latched at the last clock edge
    logic ROW_VALID0, ROW_VALID1;
    logic [20:0] ROW_TAG0, ROW_TAG1;
    logic [255:0] ROW_DATA0, ROW_DATA1;
    assign HIT_WAY0 = ROW_VALID0 && (ROW_TAG0 == LOOKUP_ADDRESS[31:11]) && (LOOKUP_ADDRESS[63:32] == 32'd0);
    assign HIT_WAY1 = ROW_VALID1 && (ROW_TAG1 == LOOKUP_ADDRESS[31:11]) && (LOOKUP_ADDRESS[63:32] == 32'd0);
    assign LOOKUP_HIT = HIT_WAY0 || HIT_WAY1;
    assign LOOKUP_WAY0 = HIT_WAY0;
    assign LOOKUP_WAY1 = HIT_WAY1;
    assign LOOKUP_DATA0 = ROW_DATA0[64*LOOKUP_ADDRESS[4:3] +: 64];
    assign LOOKUP_DATA1 = ROW_DATA1[64*LOOKUP_ADDRESS[4:3] +: 64];
    assign LOOKUP_DATA = HIT_WAY1 ? ROW_DATA1[64*LOOKUP_ADDRESS[4:3] +: 64] : ROW_DATA0[64*LOOKUP_ADDRESS[4:3] +: 64];

    // the next line's address, with a parallel-prefix carry (bit i flips when bits 5 .. i-1 are all ones): log depth
    function automatic logic [63:0] next_line(input logic [63:0] address);
        logic [63:0] all_ones;
        all_ones = address | 64'h1f;
        for (int d = 1; d < 64; d = 2 * d)
            for (int i = 63; i >= d; i--) all_ones[i] = all_ones[i] & all_ones[i - d];
        return {address[63:5] ^ all_ones[62:4], 5'b00000};
    endfunction
    logic REFILL_BUSY, REFILL_IS_DEMAND, PREFETCH_PENDING, NEXT_LINE_VALID;
    logic [5:0] REFILL_CYCLES_LEFT;
    logic [63:0] REFILL_LINE_ADDRESS, PREFETCH_LINE_ADDRESS, NEXT_LINE_ADDRESS;
    logic [5:0] REFILL_SET;
    logic REFILL_VICTIM_WAY, INSTALL, STORING, PREFETCH_PRESENT, NEXT_LINE_PRESENT;
    assign REFILL_SET = REFILL_LINE_ADDRESS[10:5];
    // The victim way, worked out a cycle ahead (an empty way first, else the least recently used one) from the
    // state as it will be at the next clock edge: only a use of this set can change it before the install
    // (valid bits change only when this refill installs). A refill lasts MISS_LATENCY >= 2 cycles, so the value
    // is for the right line by its install. This keeps the 64-way reads out of the install's own cycle.
    logic NEXT_LEAST_RECENTLY_USED;
    assign NEXT_LEAST_RECENTLY_USED = (!FREEZE && TOUCH && (TOUCH_SET == REFILL_SET)) ? TOUCH_WAY0 : LEAST_RECENTLY_USED[REFILL_SET];
    // the line after the refill's, for the prefetch that follows a demand refill (also worked out a cycle ahead)
    logic [63:0] REFILL_NEXT_LINE;
    always_ff @(posedge clk) REFILL_NEXT_LINE <= next_line(REFILL_LINE_ADDRESS);
    always_ff @(posedge clk)
        REFILL_VICTIM_WAY <= !WAY0_VALID[REFILL_SET] ? 1'b0 : !WAY1_VALID[REFILL_SET] ? 1'b1 : NEXT_LEAST_RECENTLY_USED;
    assign STORING = |WRITE_MASK;
    assign INSTALL = REFILL_BUSY && (REFILL_CYCLES_LEFT == 6'd1) && !STORING; // a store this cycle goes first
    // "Is this line cached?" in two steps, like the lookup: in the cycle before, the set's tags and valid bits are
    // read (with this cycle's install written in) and latched with the address; the cycle itself only compares.
    // So no 64-way tag read sits in front of a decision (F1's gate, the refill engine's next start).
    typedef struct packed { logic low, v0, v1; logic [20:0] t0, t1, tag; } tag_row_t;
    function automatic tag_row_t tag_row(input logic [63:0] address, input logic v0, input logic v1, input logic [20:0] t0,
                                         input logic [20:0] t1, input logic install, input logic [5:0] install_set,
                                         input logic install_way, input logic [20:0] install_tag);
        tag_row_t r;
        logic here0, here1;
        here0 = install && (install_set == address[10:5]) && !install_way;
        here1 = install && (install_set == address[10:5]) && install_way;
        r.low = (address[63:32] == 32'd0); r.tag = address[31:11];
        r.v0 = v0 || here0; r.t0 = here0 ? install_tag : t0;
        r.v1 = v1 || here1; r.t1 = here1 ? install_tag : t1;
        return r;
    endfunction
    function automatic logic row_hit(input tag_row_t r);
        return r.low && ((r.v0 && (r.t0 == r.tag)) || (r.v1 && (r.t1 == r.tag)));
    endfunction
    // the addresses checked next cycle. The prefetch line changes only as a demand refill installs, and is only
    // needed once the engine is free, so while a demand refill is busy its next line is read ahead.
    logic [63:0] PREFETCH_LINE_NEXT, NEXT_LINE_NEXT;
    assign PREFETCH_LINE_NEXT = (REFILL_BUSY && REFILL_IS_DEMAND) ? REFILL_NEXT_LINE : PREFETCH_LINE_ADDRESS;
    assign NEXT_LINE_NEXT = STREAM_PREFETCH ? next_line(DEMAND_ADDRESS) : NEXT_LINE_ADDRESS;
    tag_row_t PROBE_ROW, PREFETCH_ROW, NEXT_LINE_ROW;
    always_ff @(posedge clk) begin
        if (reset) begin PROBE_ROW <= '0; PREFETCH_ROW <= '0; NEXT_LINE_ROW <= '0; end
        else if (!FREEZE) begin
            PROBE_ROW <= tag_row(PROBE_NEXT_ADDRESS, WAY0_VALID[PROBE_NEXT_ADDRESS[10:5]], WAY1_VALID[PROBE_NEXT_ADDRESS[10:5]],
                                 WAY0_TAG[PROBE_NEXT_ADDRESS[10:5]], WAY1_TAG[PROBE_NEXT_ADDRESS[10:5]],
                                 INSTALL, REFILL_SET, REFILL_VICTIM_WAY, REFILL_LINE_ADDRESS[31:11]);
            PREFETCH_ROW <= tag_row(PREFETCH_LINE_NEXT, WAY0_VALID[PREFETCH_LINE_NEXT[10:5]], WAY1_VALID[PREFETCH_LINE_NEXT[10:5]],
                                    WAY0_TAG[PREFETCH_LINE_NEXT[10:5]], WAY1_TAG[PREFETCH_LINE_NEXT[10:5]],
                                    INSTALL, REFILL_SET, REFILL_VICTIM_WAY, REFILL_LINE_ADDRESS[31:11]);
            NEXT_LINE_ROW <= tag_row(NEXT_LINE_NEXT, WAY0_VALID[NEXT_LINE_NEXT[10:5]], WAY1_VALID[NEXT_LINE_NEXT[10:5]],
                                     WAY0_TAG[NEXT_LINE_NEXT[10:5]], WAY1_TAG[NEXT_LINE_NEXT[10:5]],
                                     INSTALL, REFILL_SET, REFILL_VICTIM_WAY, REFILL_LINE_ADDRESS[31:11]);
        end
    end
    assign PROBE_HIT = row_hit(PROBE_ROW);
    assign PREFETCH_PRESENT = row_hit(PREFETCH_ROW);
    assign NEXT_LINE_PRESENT = row_hit(NEXT_LINE_ROW);
    assign BUSY = REFILL_BUSY;
    assign BUSY_LINE = REFILL_LINE_ADDRESS;
    assign CYCLES_LEFT = REFILL_CYCLES_LEFT;
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
                NEXT_LINE_ADDRESS <= next_line(DEMAND_ADDRESS);
                NEXT_LINE_VALID <= 1'b1;
            end
            if (TOUCH) LEAST_RECENTLY_USED[TOUCH_SET] <= TOUCH_WAY0; // the other way is now the least recently used
            if (!REFILL_BUSY) begin
                if (DEMAND) begin
                    REFILL_BUSY <= 1'b1;
                    REFILL_CYCLES_LEFT <= MISS_LATENCY[5:0];
                    REFILL_LINE_ADDRESS <= {DEMAND_ADDRESS[63:5], 5'b00000};
                    REFILL_IS_DEMAND <= 1'b1;
                end else if (PREFETCH_PENDING) begin
                    PREFETCH_PENDING <= 1'b0;
                    if (!PREFETCH_PRESENT) begin
                        REFILL_BUSY <= 1'b1;
                        REFILL_CYCLES_LEFT <= MISS_LATENCY[5:0];
                        REFILL_LINE_ADDRESS <= PREFETCH_LINE_ADDRESS;
                        REFILL_IS_DEMAND <= 1'b0;
                    end
                end else if (STREAM_PREFETCH && NEXT_LINE_VALID && !NEXT_LINE_PRESENT) begin
                    REFILL_BUSY <= 1'b1;
                    REFILL_CYCLES_LEFT <= MISS_LATENCY[5:0];
                    REFILL_LINE_ADDRESS <= NEXT_LINE_ADDRESS;
                    REFILL_IS_DEMAND <= 1'b0;
                end
            end else if (INSTALL) begin
                REFILL_BUSY <= 1'b0;
                if (REFILL_VICTIM_WAY) WAY1_VALID[REFILL_SET] <= 1'b1; else WAY0_VALID[REFILL_SET] <= 1'b1;
                LEAST_RECENTLY_USED[REFILL_SET] <= !REFILL_VICTIM_WAY;
                if (REFILL_IS_DEMAND) begin
                    PREFETCH_PENDING <= 1'b1;
                    PREFETCH_LINE_ADDRESS <= REFILL_NEXT_LINE;
                end
            end else if (REFILL_CYCLES_LEFT != 6'd1) begin // (at 1 with a store: hold, install next cycle)
                REFILL_CYCLES_LEFT <= REFILL_CYCLES_LEFT - 6'd1;
            end
        end
    end

    // Line data: a refill writes a whole line, a store hit only its own bytes (never both in one cycle)
    logic [5:0] DATA_WRITE_SET;
    logic [255:0] DATA_WRITE_LINE;
    logic [31:0] WAY0_BYTE_ENABLES, WAY1_BYTE_ENABLES, STORE_BYTE_ENABLES;
    always_comb begin
        STORE_BYTE_ENABLES = 32'd0;
        STORE_BYTE_ENABLES[8*LOOKUP_ADDRESS[4:3] +: 8] = WRITE_MASK;
        DATA_WRITE_SET = INSTALL ? REFILL_SET : SET;
        DATA_WRITE_LINE = INSTALL ? REFILL_LINE : {4{WRITE_DATA}};
        WAY0_BYTE_ENABLES = INSTALL ? {32{!REFILL_VICTIM_WAY}} : (STORING && HIT_WAY0) ? STORE_BYTE_ENABLES : 32'd0;
        WAY1_BYTE_ENABLES = INSTALL ? {32{REFILL_VICTIM_WAY}} : (STORING && HIT_WAY1) ? STORE_BYTE_ENABLES : 32'd0;
    end
    always_ff @(posedge clk) begin
        if (!reset && !FREEZE) begin
            if (INSTALL) begin
                if (REFILL_VICTIM_WAY) WAY1_TAG[REFILL_SET] <= REFILL_LINE_ADDRESS[31:11];
                else WAY0_TAG[REFILL_SET] <= REFILL_LINE_ADDRESS[31:11];
            end
        end
    end

    // the row latched at this clock edge: set ROW_SET_NEXT, with this cycle's writes in it
    logic [5:0] ROW_SET, ROW_SET_NEXT;
    logic INSTALLS_ROW;
    assign ROW_SET_NEXT = EARLY_LOAD ? EARLY_SET : ROW_SET;
    assign INSTALLS_ROW = INSTALL && (REFILL_SET == ROW_SET_NEXT);
    always_ff @(posedge clk) begin
        if (reset) begin ROW_SET <= 6'd0; ROW_VALID0 <= 1'b0; ROW_VALID1 <= 1'b0; end
        else if (!FREEZE) begin
            ROW_SET <= ROW_SET_NEXT;
            ROW_VALID0 <= WAY0_VALID[ROW_SET_NEXT] || (INSTALLS_ROW && !REFILL_VICTIM_WAY);
            ROW_VALID1 <= WAY1_VALID[ROW_SET_NEXT] || (INSTALLS_ROW && REFILL_VICTIM_WAY);
            ROW_TAG0 <= (INSTALLS_ROW && !REFILL_VICTIM_WAY) ? REFILL_LINE_ADDRESS[31:11] : WAY0_TAG[ROW_SET_NEXT];
            ROW_TAG1 <= (INSTALLS_ROW && REFILL_VICTIM_WAY) ? REFILL_LINE_ADDRESS[31:11] : WAY1_TAG[ROW_SET_NEXT];
        end
    end
    DeepCacheArray #(.WIDTH (256)) way0_data (.clk (clk), .HOLD (FREEZE), .READ_SET (ROW_SET_NEXT), .ROW (ROW_DATA0),
        .WRITE_SET (DATA_WRITE_SET), .WRITE_LANES (reset ? 32'd0 : WAY0_BYTE_ENABLES), .WRITE_DATA (DATA_WRITE_LINE));
    DeepCacheArray #(.WIDTH (256)) way1_data (.clk (clk), .HOLD (FREEZE), .READ_SET (ROW_SET_NEXT), .ROW (ROW_DATA1),
        .WRITE_SET (DATA_WRITE_SET), .WRITE_LANES (reset ? 32'd0 : WAY1_BYTE_ENABLES), .WRITE_DATA (DATA_WRITE_LINE));

    // Predecode (instruction cache only): written with the line, never by a store
    if (PREDECODE) begin : predecode
        // each word's kind, and its branch / JAL target: the word's PC (the line's address with the word's
        // number in bits 4:2, no add needed) plus the immediate, on a prefix adder (log depth)
        logic [8*36-1:0] INSTALL_PREDECODE;
        for (genvar i = 0; i < 8; i++) begin : word
            logic [31:0] w, immediate, target;
            logic jal, jalr, branch, call, ret, carry_unused;
            assign w = REFILL_LINE[32*i +: 32];
            assign jal = (w[6:0] == 7'b1101111); assign jalr = (w[6:0] == 7'b1100111); assign branch = (w[6:0] == 7'b1100011);
            assign call = (jal || jalr) && ((w[11:7] == 5'd1) || (w[11:7] == 5'd5));
            assign ret = jalr && (w[11:7] == 5'd0) && ((w[19:15] == 5'd1) || (w[19:15] == 5'd5)) && (w[31:20] == 12'd0);
            assign immediate = jal ? {{12{w[31]}}, w[19:12], w[20], w[30:21], 1'b0} : {{20{w[31]}}, w[7], w[30:25], w[11:8], 1'b0};
            ParallelPrefixAdder #(.WIDTH (32)) target_adder (.A ({REFILL_LINE_ADDRESS[31:5], 3'(i), 2'b00}), .B (immediate),
                .CARRY_IN (1'b0), .SUM (target), .CARRY_OUT (carry_unused));
            assign INSTALL_PREDECODE[36*i +: 36] = {target, jal, branch, call, ret};
        end
        logic [8*36-1:0] ROW_PREDECODE0, ROW_PREDECODE1;
        logic WRITE0, WRITE1;
        assign WRITE0 = !reset && INSTALL && !REFILL_VICTIM_WAY;
        assign WRITE1 = !reset && INSTALL && REFILL_VICTIM_WAY;
        DeepCacheArray #(.WIDTH (288)) way0_predecode (.clk (clk), .HOLD (FREEZE), .READ_SET (ROW_SET_NEXT), .ROW (ROW_PREDECODE0),
            .WRITE_SET (REFILL_SET), .WRITE_LANES ({36{WRITE0}}), .WRITE_DATA (INSTALL_PREDECODE));
        DeepCacheArray #(.WIDTH (288)) way1_predecode (.clk (clk), .HOLD (FREEZE), .READ_SET (ROW_SET_NEXT), .ROW (ROW_PREDECODE1),
            .WRITE_SET (REFILL_SET), .WRITE_LANES ({36{WRITE1}}), .WRITE_DATA (INSTALL_PREDECODE));
        assign LOOKUP_PREDECODE0 = ROW_PREDECODE0[36*LOOKUP_ADDRESS[4:2] +: 36];
        assign LOOKUP_PREDECODE1 = ROW_PREDECODE1[36*LOOKUP_ADDRESS[4:2] +: 36];
        assign LOOKUP_PREDECODE = HIT_WAY1 ? LOOKUP_PREDECODE1 : LOOKUP_PREDECODE0;
    end else begin : no_predecode
        assign LOOKUP_PREDECODE = 36'd0; assign LOOKUP_PREDECODE0 = 36'd0; assign LOOKUP_PREDECODE1 = 36'd0;
    end

endmodule

// =====================================================================================================
// DeepCacheArray: one way's data (or predecode) array, 64 rows, as a clocked SRAM would behave: at each clock
// edge (unless HOLD) row READ_SET is latched into ROW, and WRITE_LANES' bytes of WRITE_DATA are written into row
// WRITE_SET. Reading the row being written gives the new bytes ("write first"). On a chip this is a memory
// macro; its access time is the macro's, so the cache's logic timing leaves it out (a black box).
// =====================================================================================================
module DeepCacheArray #(
    parameter int WIDTH = 256
) (
    input  logic clk,
    input  logic HOLD,
    input  logic [5:0] READ_SET,
    output logic [WIDTH-1:0] ROW,
    input  logic [5:0] WRITE_SET,
    input  logic [WIDTH/8-1:0] WRITE_LANES,
    input  logic [WIDTH-1:0] WRITE_DATA
);
    logic [WIDTH-1:0] MEMORY [0:63];
    logic [WIDTH-1:0] READ_NOW;
    always_comb begin
        READ_NOW = MEMORY[READ_SET];
        if (READ_SET == WRITE_SET)
            for (int b = 0; b < WIDTH / 8; b++) if (WRITE_LANES[b]) READ_NOW[8*b +: 8] = WRITE_DATA[8*b +: 8];
    end
    always_ff @(posedge clk) begin
        if (!HOLD) begin
            ROW <= READ_NOW;
            for (int b = 0; b < WIDTH / 8; b++) if (WRITE_LANES[b]) MEMORY[WRITE_SET][8*b +: 8] <= WRITE_DATA[8*b +: 8];
        end
    end
endmodule

`default_nettype wire
