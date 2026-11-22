`default_nettype none

// =====================================================================================================
// DeepMultiplyDivideUnit: the deep-pipeline edition's M unit (model/deep.js deepMultiplyDivideSteps)
//
// FastMultiplyDivideUnit (src/Iterative_Multiply_Divide_Unit.sv, the turbo edition's) run at half rate: the
// core lets it change state every second cycle, so every state has two cycles' time (a two-cycle path).
// Three changes make every path into its registers either that, or a plain register load:
//   IDLE     only latches the request's operands. The work FastMultiplyDivideUnit does in IDLE (|A|, |B|, the
//            leading zeros, the step registers' first values) moves to a new state, CAPTURE, from those
//            registers: M1's operand select is not in front of a 64-bit negation and two leading-zero counters.
//   BUSY     a multiply is one 64 x 64 carry-save step; a divide step is two radix-4 iterations in a row
//            (4 quotient bits), so a divide takes half the steps of a radix-4 one.
//   SIGN     lasts two cycles like every other state: the 128-bit carry resolution and the result's select
//            reach the register file at the end of the second.
// States: IDLE, CAPTURE, [PREPARE], then a multiply's BUSY, or a divide's ALIGN, BUSY x T, [NEGATE]; then SIGN.
// The core writes the result 2 x (states between CAPTURE and SIGN) + 4 cycles after M1.
// =====================================================================================================
module DeepMultiplyDivideUnit #(
    parameter int MULTIPLY_STEP_BITS = 64 // multiplier bits per step: 64 / this = the multiply steps (32 or 64)
) (
    input  logic clk,
    input  logic reset,
    input  logic FREEZE, // The core is halting: change nothing
    input  logic REQUEST, // An M instruction is in M1 (A and B are only latched: CAPTURE does the work)
    input  logic [63:0] A, // rs1
    input  logic [63:0] B, // rs2
    input  alu_op_t MULTIPLY_DIVIDE_OPERATION,
    input  logic IS_WORD_OPERATION, // MULW, DIVW, DIVUW, REMW, REMUW
    input  logic [2:0] PREDECODED, // {A signed, B signed, word divide}, decoded in DECODE
    output logic READY, // SIGN: the result is valid (the core writes it at the end of SIGN's second cycle)
    output logic [63:0] LATE_RESULT
);

    typedef enum logic [2:0] { STATE_IDLE = 3'd0, STATE_ALIGN = 3'd1, STATE_BUSY = 3'd2, STATE_NEGATE = 3'd3, STATE_SIGN = 3'd4, STATE_PREPARE = 3'd5, STATE_CAPTURE = 3'd6 } unit_state_t;
    unit_state_t UNIT_STATE;

    // ---------------------------------------------------------------- IDLE: the request's operands, as they are
    logic [63:0] CAPTURED_A, CAPTURED_B;
    alu_op_t CAPTURED_OPERATION;
    logic CAPTURED_IS_WORD;
    logic [2:0] CAPTURED_PREDECODED;
    always_ff @(posedge clk)
        if (!FREEZE && (UNIT_STATE == STATE_IDLE) && REQUEST) begin
            CAPTURED_A <= A; CAPTURED_B <= B; CAPTURED_OPERATION <= MULTIPLY_DIVIDE_OPERATION;
            CAPTURED_IS_WORD <= IS_WORD_OPERATION; CAPTURED_PREDECODED <= PREDECODED;
        end

    // ---------------------------------------------------------------- CAPTURE: decode and operands (as in FastMultiplyDivideUnit's IDLE)
    logic IS_DIVIDE, IS_REMAINDER, A_IS_SIGNED, B_IS_SIGNED;
    assign IS_DIVIDE = (CAPTURED_OPERATION == ALU_DIV) || (CAPTURED_OPERATION == ALU_DIVU) || (CAPTURED_OPERATION == ALU_REM) || (CAPTURED_OPERATION == ALU_REMU);
    assign IS_REMAINDER = (CAPTURED_OPERATION == ALU_REM) || (CAPTURED_OPERATION == ALU_REMU);
    assign A_IS_SIGNED = CAPTURED_PREDECODED[2];
    assign B_IS_SIGNED = CAPTURED_PREDECODED[1];
    logic [63:0] A_EFFECTIVE, B_EFFECTIVE;
    assign A_EFFECTIVE = CAPTURED_PREDECODED[0] ? (A_IS_SIGNED ? {{32{CAPTURED_A[31]}}, CAPTURED_A[31:0]} : {32'd0, CAPTURED_A[31:0]}) : CAPTURED_A;
    assign B_EFFECTIVE = CAPTURED_PREDECODED[0] ? (B_IS_SIGNED ? {{32{CAPTURED_B[31]}}, CAPTURED_B[31:0]} : {32'd0, CAPTURED_B[31:0]}) : CAPTURED_B;
    logic A_IS_NEGATIVE, B_IS_NEGATIVE;
    assign A_IS_NEGATIVE = A_IS_SIGNED && A_EFFECTIVE[63];
    assign B_IS_NEGATIVE = B_IS_SIGNED && B_EFFECTIVE[63];
    logic [63:0] A_NEGATED, B_NEGATED, A_MAGNITUDE_NOW, B_MAGNITUDE_NOW;
    PrefixNegate #(.WIDTH(64)) negate_a (.X (A_EFFECTIVE), .NEGATED (A_NEGATED));
    PrefixNegate #(.WIDTH(64)) negate_b (.X (B_EFFECTIVE), .NEGATED (B_NEGATED));
    assign A_MAGNITUDE_NOW = A_IS_NEGATIVE ? A_NEGATED : A_EFFECTIVE;
    assign B_MAGNITUDE_NOW = B_IS_NEGATIVE ? B_NEGATED : B_EFFECTIVE;

    // Leading zeros of A or ~A, beside the negation (see the header)
    logic [5:0] EARLY_LEADING_ZEROS;
    logic EARLY_ALL_ZERO_UNUSED;
    // (zeros of A and of ~A are counted side by side and the sign picks one: the sign does not wait in front of 64 XOR gates)
    logic [5:0] A_ZEROS, A_ONES, B_ZEROS, B_ONES;
    logic A_ONES_ALL_UNUSED, B_ZEROS_ALL_UNUSED, B_ONES_ALL_UNUSED;
    LeadingZeroCounter count_early_zeros (.X (A_EFFECTIVE), .COUNT (A_ZEROS), .ALL_ZERO (EARLY_ALL_ZERO_UNUSED));
    LeadingZeroCounter count_early_ones (.X (~A_EFFECTIVE), .COUNT (A_ONES), .ALL_ZERO (A_ONES_ALL_UNUSED));
    assign EARLY_LEADING_ZEROS = A_IS_NEGATIVE ? A_ONES : A_ZEROS;
    // ... and of B or ~B. For a negative B, |B| = ~B + 1 is never smaller than ~B, so this count is never
    // below |B|'s: it can only overestimate the quotient's length, which costs a step but is never wrong.
    logic [5:0] EARLY_DIVISOR_LEADING_ZEROS;
    LeadingZeroCounter count_divisor_zeros (.X (B_EFFECTIVE), .COUNT (B_ZEROS), .ALL_ZERO (B_ZEROS_ALL_UNUSED));
    LeadingZeroCounter count_divisor_ones (.X (~B_EFFECTIVE), .COUNT (B_ONES), .ALL_ZERO (B_ONES_ALL_UNUSED));
    assign EARLY_DIVISOR_LEADING_ZEROS = B_IS_NEGATIVE ? B_ONES : B_ZEROS;

    // ---------------------------------------------------------------- registers
    logic [63:0] LATCHED_A; // |A|
    logic [63:0] LATCHED_B; // |B|
    logic [5:0] LATCHED_LEADING_ZEROS, LATCHED_DIVISOR_LEADING_ZEROS;
    logic LATCHED_A_IS_NEGATIVE, LATCHED_IS_DIVIDE, LATCHED_IS_REMAINDER, LATCHED_IS_WORD, LATCHED_NEGATE_PRODUCT, LATCHED_NEGATE_QUOTIENT, LATCHED_DIVIDE_BY_ZERO;
    alu_op_t LATCHED_OPERATION;
    logic [6:0] STEPS_LEFT;
    logic [63:0] MULTIPLICAND;
    // The step's Wallace tree: MULTIPLY_STEP_BITS partial products + 2 = OPERANDS numbers, 3:2 levels until 2 are left
    function automatic int tree_levels(input int operands);
        int n, levels;
        n = operands; levels = 0;
        while (n > 2) begin n = 2 * (n / 3) + (n % 3); levels++; end
        return levels;
    endfunction
    localparam int STEP_WIDTH = 64 + MULTIPLY_STEP_BITS + tree_levels(MULTIPLY_STEP_BITS + 2); // as in CarrySaveMultiplyStep
    localparam int ACCUMULATOR_WIDTH = STEP_WIDTH - MULTIPLY_STEP_BITS;
    localparam int PRODUCT_WIDTH = ACCUMULATOR_WIDTH + 64;
    localparam logic [6:0] MULTIPLY_STEPS = 7'(64 / MULTIPLY_STEP_BITS);
    logic [PRODUCT_WIDTH-1:0] PRODUCT_SUM, PRODUCT_CARRY; // carry-save product, as above
    logic [63:0] DIVISOR;
    logic [63:0] DIVIDEND_BITS; // |A| left-aligned: the next two dividend bits are always [63:62]
    logic [63:0] PARTIAL_REMAINDER;
    logic [63:0] QUOTIENT;
    logic [63:0] QUOTIENT_MINUS_ONE; // QUOTIENT - 1, built alongside it (on-the-fly conversion)
    logic [63:0] NEGATIVE_REMAINDER; // -remainder, written in NEGATE

    // ---------------------------------------------------------------- ALIGN: step count, the starting remainder, 3 x divisor
    // The quotient of an a-bit dividend by a d-bit divisor has at most a - d + 1 bits, so T = ceil((a - d + 1) / 4)
    // radix-16 steps are enough. With r = a - d = (divisor's leading zeros) - (dividend's), T = r / 4 + 1 (rounded
    // down), or 1 when r < 0. The dividend's top bits that no step needs start out in the remainder:
    //   {PARTIAL_REMAINDER, DIVIDEND_BITS} = |A| << (64 - 4T)   (as one 128-bit number)
    // That starting remainder |A| >> 4T has fewer than d bits, so it is below the divisor, which is all a
    // restoring divide needs. (64 - 4T) / 4 = 15 - r / 4 is just the inverted bits of r / 4: no adder before the
    // shifter. A divisor of 0 counts 63 leading zeros, and T is then the dividend's own length.
    logic [63:0] ALIGNED_DIVIDEND, STARTING_REMAINDER;
    logic [6:0] DIVIDE_STEPS;
    always_comb begin
        logic [6:0] LENGTH_DIFFERENCE; // r, may be negative
        logic [3:0] QUARTER_SHIFT;
        logic [127:0] WIDE;
        // + 1 for a negative dividend (unless it counted 0): |A| = ~A + 1 may be one bit longer than ~A
        LENGTH_DIFFERENCE = {1'b0, LATCHED_DIVISOR_LEADING_ZEROS} - {1'b0, LATCHED_LEADING_ZEROS}
                          + {6'd0, LATCHED_A_IS_NEGATIVE && (LATCHED_LEADING_ZEROS != 6'd0)};
        QUARTER_SHIFT = LENGTH_DIFFERENCE[6] ? 4'd15 : ~LENGTH_DIFFERENCE[5:2];
        DIVIDE_STEPS = LENGTH_DIFFERENCE[6] ? 7'd1 : {3'b000, LENGTH_DIFFERENCE[5:2]} + 7'd1;
        WIDE = {64'd0, LATCHED_A} << {QUARTER_SHIFT, 2'b00};
        STARTING_REMAINDER = WIDE[127:64];
        ALIGNED_DIVIDEND = WIDE[63:0];
    end
    logic [65:0] DIVISOR_TIMES_3_SUM;
    logic DIVISOR_TIMES_3_CARRY_UNUSED;
    ParallelPrefixAdder #(.WIDTH(66)) times_3 (.A ({2'b00, DIVISOR}), .B ({1'b0, DIVISOR, 1'b0}), .CARRY_IN (1'b0), .SUM (DIVISOR_TIMES_3_SUM), .CARRY_OUT (DIVISOR_TIMES_3_CARRY_UNUSED));

    // ---------------------------------------------------------------- one multiply step (as in FastMultiplyDivideUnit)
    logic [STEP_WIDTH-1:0] MULTIPLY_STEP_SUM, MULTIPLY_STEP_CARRY;
    CarrySaveMultiplyStep #(.A_WIDTH(64), .B_WIDTH(MULTIPLY_STEP_BITS), .WIDTH(STEP_WIDTH), .ACCUMULATOR_WIDTH(ACCUMULATOR_WIDTH)) multiply_step (
        .MULTIPLICAND (MULTIPLICAND), .MULTIPLIER (PRODUCT_SUM[MULTIPLY_STEP_BITS-1:0]),
        .ACCUMULATOR_SUM (PRODUCT_SUM[PRODUCT_WIDTH-1:64]), .ACCUMULATOR_CARRY (PRODUCT_CARRY[PRODUCT_WIDTH-1:64]),
        .SUM_VECTOR (MULTIPLY_STEP_SUM), .CARRY_VECTOR (MULTIPLY_STEP_CARRY)
    );
    logic [PRODUCT_WIDTH-1:0] NEXT_PRODUCT_SUM, NEXT_PRODUCT_CARRY;
    if (MULTIPLY_STEP_BITS == 64) begin : whole_step // one step: the step's vectors are the whole product
        assign NEXT_PRODUCT_SUM = MULTIPLY_STEP_SUM;
        assign NEXT_PRODUCT_CARRY = MULTIPLY_STEP_CARRY;
    end else begin : partial_step
        assign NEXT_PRODUCT_SUM = {MULTIPLY_STEP_SUM, PRODUCT_SUM[63:MULTIPLY_STEP_BITS]};
        assign NEXT_PRODUCT_CARRY = {MULTIPLY_STEP_CARRY, PRODUCT_CARRY[63:MULTIPLY_STEP_BITS]};
    end

    // ---------------------------------------------------------------- one radix-16 divide step: two radix-4 iterations
    // (each as in FastMultiplyDivideUnit: S - D, S - 2D and S - 3D side by side, the largest that does not borrow
    // wins). A state has two cycles' time in the deep edition, so both iterations fit in it.
    // (D, 2D and 3D are kept inverted in registers of their own, set in ALIGN: S - kD = S + ~kD + 1)
    logic [65:0] NOT_DIVISOR_1, NOT_DIVISOR_2, NOT_DIVISOR_3;
    // The second iteration does not wait for the first one's choice: it runs on all four of the first one's
    // candidate remainders (S, S - D, S - 2D, S - 3D) side by side, and the first digit then picks one of the four
    // results. Twelve subtractors instead of six; the first iteration's select drops out of the chain.
    logic [65:0] FIRST_SHIFTED, FIRST_1, FIRST_2, FIRST_3;
    logic FIRST_NO_BORROW_1, FIRST_NO_BORROW_2, FIRST_NO_BORROW_3;
    assign FIRST_SHIFTED = {PARTIAL_REMAINDER, DIVIDEND_BITS[63:62]};
    ParallelPrefixAdder #(.WIDTH(66)) first_1 (.A (FIRST_SHIFTED), .B (NOT_DIVISOR_1), .CARRY_IN (1'b1), .SUM (FIRST_1), .CARRY_OUT (FIRST_NO_BORROW_1));
    ParallelPrefixAdder #(.WIDTH(66)) first_2 (.A (FIRST_SHIFTED), .B (NOT_DIVISOR_2), .CARRY_IN (1'b1), .SUM (FIRST_2), .CARRY_OUT (FIRST_NO_BORROW_2));
    ParallelPrefixAdder #(.WIDTH(66)) first_3 (.A (FIRST_SHIFTED), .B (NOT_DIVISOR_3), .CARRY_IN (1'b1), .SUM (FIRST_3), .CARRY_OUT (FIRST_NO_BORROW_3));
    logic [65:0] SECOND [0:3]; // {second digit, remainder} after a first digit of 0, 1, 2, 3
    for (genvar j = 0; j < 4; j++) begin : second
        logic [65:0] shifted, d1, d2, d3; logic n1, n2, n3;
        assign shifted = {(j == 0) ? FIRST_SHIFTED[63:0] : (j == 1) ? FIRST_1[63:0] : (j == 2) ? FIRST_2[63:0] : FIRST_3[63:0], DIVIDEND_BITS[61:60]};
        ParallelPrefixAdder #(.WIDTH(66)) t1 (.A (shifted), .B (NOT_DIVISOR_1), .CARRY_IN (1'b1), .SUM (d1), .CARRY_OUT (n1));
        ParallelPrefixAdder #(.WIDTH(66)) t2 (.A (shifted), .B (NOT_DIVISOR_2), .CARRY_IN (1'b1), .SUM (d2), .CARRY_OUT (n2));
        ParallelPrefixAdder #(.WIDTH(66)) t3 (.A (shifted), .B (NOT_DIVISOR_3), .CARRY_IN (1'b1), .SUM (d3), .CARRY_OUT (n3));
        // S >= 3D implies S >= 2D implies S >= D: the digit counts the tests, the remainder is a one-hot select
        assign SECOND[j] = {n2, n3 || (n1 && !n2), ({64{n3}} & d3[63:0]) | ({64{n2 && !n3}} & d2[63:0]) | ({64{n1 && !n2}} & d1[63:0]) | ({64{!n1}} & shifted[63:0])};
    end
    logic [3:0] FIRST_PICK; // one-hot: the first digit
    assign FIRST_PICK = {FIRST_NO_BORROW_3, FIRST_NO_BORROW_2 && !FIRST_NO_BORROW_3, FIRST_NO_BORROW_1 && !FIRST_NO_BORROW_2, !FIRST_NO_BORROW_1};
    logic [65:0] SECOND_PICKED;
    assign SECOND_PICKED = ({66{FIRST_PICK[0]}} & SECOND[0]) | ({66{FIRST_PICK[1]}} & SECOND[1])
                         | ({66{FIRST_PICK[2]}} & SECOND[2]) | ({66{FIRST_PICK[3]}} & SECOND[3]);
    logic [3:0] QUOTIENT_DIGIT;
    logic [63:0] NEXT_REMAINDER;
    assign QUOTIENT_DIGIT = {FIRST_NO_BORROW_2, FIRST_NO_BORROW_3 || (FIRST_NO_BORROW_1 && !FIRST_NO_BORROW_2), SECOND_PICKED[65:64]};
    assign NEXT_REMAINDER = SECOND_PICKED[63:0];
    // Divide by zero: every step keeps S (quotient digit 3, D = 0), so the remainder ends as |A| and x % 0 = x;
    // the quotient is replaced by all ones in SIGN, as RISC-V requires.

    always_ff @(posedge clk) begin
        if (reset) begin
            UNIT_STATE <= STATE_IDLE;
            STEPS_LEFT <= 7'd0;
            LATCHED_LEADING_ZEROS <= 6'd0;
            LATCHED_DIVISOR_LEADING_ZEROS <= 6'd0;
        end else if (!FREEZE) begin
            unique case (UNIT_STATE)
                STATE_IDLE: if (REQUEST) UNIT_STATE <= STATE_CAPTURE; // (the operands are latched above)
                STATE_CAPTURE: begin
                    UNIT_STATE <= (A_IS_NEGATIVE || B_IS_NEGATIVE) ? STATE_PREPARE : IS_DIVIDE ? STATE_ALIGN : STATE_BUSY;
                    LATCHED_A <= A_MAGNITUDE_NOW;
                    LATCHED_B <= B_MAGNITUDE_NOW;
                    LATCHED_A_IS_NEGATIVE <= A_IS_NEGATIVE;
                    LATCHED_LEADING_ZEROS <= EARLY_LEADING_ZEROS;
                    LATCHED_DIVISOR_LEADING_ZEROS <= EARLY_DIVISOR_LEADING_ZEROS;
                    LATCHED_OPERATION <= CAPTURED_OPERATION;
                    LATCHED_IS_DIVIDE <= IS_DIVIDE;
                    LATCHED_IS_REMAINDER <= IS_REMAINDER;
                    LATCHED_IS_WORD <= CAPTURED_IS_WORD;
                    LATCHED_NEGATE_PRODUCT <= A_IS_NEGATIVE ^ B_IS_NEGATIVE;
                    LATCHED_NEGATE_QUOTIENT <= A_IS_NEGATIVE ^ B_IS_NEGATIVE;
                    LATCHED_DIVIDE_BY_ZERO <= (B_EFFECTIVE == 64'd0);
                    MULTIPLICAND <= A_EFFECTIVE; // = |A| unless A is negative (then PREPARE follows)
                    PRODUCT_SUM <= {{ACCUMULATOR_WIDTH{1'b0}}, B_EFFECTIVE};
                    PRODUCT_CARRY <= '0;
                    DIVISOR <= B_EFFECTIVE;
                    PARTIAL_REMAINDER <= 64'd0;
                    QUOTIENT <= 64'd0;
                    QUOTIENT_MINUS_ONE <= 64'hFFFF_FFFF_FFFF_FFFF; // 0 - 1
                    STEPS_LEFT <= MULTIPLY_STEPS; // a divide sets its own count in ALIGN
                end
                STATE_PREPARE: begin // a negative operand: the magnitudes from CAPTURE
                    UNIT_STATE <= LATCHED_IS_DIVIDE ? STATE_ALIGN : STATE_BUSY;
                    MULTIPLICAND <= LATCHED_A;
                    PRODUCT_SUM <= {{ACCUMULATOR_WIDTH{1'b0}}, LATCHED_B};
                    DIVISOR <= LATCHED_B;
                end
                STATE_ALIGN: begin
                    UNIT_STATE <= STATE_BUSY;
                    DIVIDEND_BITS <= ALIGNED_DIVIDEND;
                    PARTIAL_REMAINDER <= STARTING_REMAINDER;
                    STEPS_LEFT <= DIVIDE_STEPS;
                    NOT_DIVISOR_1 <= ~{2'b00, DIVISOR}; NOT_DIVISOR_2 <= ~{1'b0, DIVISOR, 1'b0}; NOT_DIVISOR_3 <= ~DIVISOR_TIMES_3_SUM;
                end
                STATE_BUSY: begin
                    if (LATCHED_IS_DIVIDE) begin
                        PARTIAL_REMAINDER <= NEXT_REMAINDER;
                        QUOTIENT <= {QUOTIENT[59:0], QUOTIENT_DIGIT}; // 16Q + d
                        QUOTIENT_MINUS_ONE <= (QUOTIENT_DIGIT != 4'd0) ? {QUOTIENT[59:0], QUOTIENT_DIGIT - 4'd1} : {QUOTIENT_MINUS_ONE[59:0], 4'b1111}; // 16Q + d - 1
                        DIVIDEND_BITS <= {DIVIDEND_BITS[59:0], 4'b0000};
                    end else begin
                        PRODUCT_SUM <= NEXT_PRODUCT_SUM;
                        PRODUCT_CARRY <= NEXT_PRODUCT_CARRY;
                    end
                    STEPS_LEFT <= STEPS_LEFT - 7'd1;
                    if (STEPS_LEFT == 7'd1) UNIT_STATE <= (LATCHED_IS_DIVIDE && LATCHED_IS_REMAINDER && LATCHED_A_IS_NEGATIVE) ? STATE_NEGATE : STATE_SIGN;
                end
                STATE_NEGATE: begin // the remainder takes the dividend's sign (a register of its own: the step's multiplexer stays 2-way)
                    NEGATIVE_REMAINDER <= REMAINDER_NEGATED;
                    UNIT_STATE <= STATE_SIGN;
                end
                STATE_SIGN: UNIT_STATE <= STATE_IDLE; // the core writes the result at this edge
                default: UNIT_STATE <= STATE_IDLE;
            endcase
        end
    end

    // ---------------------------------------------------------------- SIGN (as in FastMultiplyDivideUnit)
    logic [127:0] PRODUCT_X, PRODUCT_Y, PRODUCT_Z, RESOLVE_SUM_BITS, RESOLVE_CARRY_BITS, RESOLVED_PRODUCT, SIGNED_PRODUCT;
    logic RESOLVE_CARRY_UNUSED;
    assign PRODUCT_X = PRODUCT_SUM[127:0];
    assign PRODUCT_Y = PRODUCT_CARRY[127:0];
    assign PRODUCT_Z = {128{LATCHED_NEGATE_PRODUCT}};
    assign RESOLVE_SUM_BITS = PRODUCT_X ^ PRODUCT_Y ^ PRODUCT_Z;
    assign RESOLVE_CARRY_BITS = {((PRODUCT_X[126:0] & PRODUCT_Y[126:0]) | (PRODUCT_X[126:0] & PRODUCT_Z[126:0]) | (PRODUCT_Y[126:0] & PRODUCT_Z[126:0])), 1'b0};
    ParallelPrefixAdder #(.WIDTH(128)) resolve_product (
        .A (RESOLVE_SUM_BITS), .B (RESOLVE_CARRY_BITS), .CARRY_IN (1'b0), .SUM (RESOLVED_PRODUCT), .CARRY_OUT (RESOLVE_CARRY_UNUSED)
    );
    assign SIGNED_PRODUCT = RESOLVED_PRODUCT ^ PRODUCT_Z;
    logic [63:0] REMAINDER_NEGATED, SIGNED_QUOTIENT, FULL_RESULT;
    logic NEGATE_CARRY_UNUSED;
    ParallelPrefixAdder #(.WIDTH(64)) negate_remainder (.A (~PARTIAL_REMAINDER), .B (64'd0), .CARRY_IN (1'b1), .SUM (REMAINDER_NEGATED), .CARRY_OUT (NEGATE_CARRY_UNUSED)); // ~R + 1, in NEGATE only
    assign SIGNED_QUOTIENT = LATCHED_NEGATE_QUOTIENT ? ~QUOTIENT_MINUS_ONE : QUOTIENT; // -Q = ~(Q - 1)
    always_comb begin
        if (LATCHED_IS_DIVIDE) begin
            if (LATCHED_IS_REMAINDER) FULL_RESULT = LATCHED_A_IS_NEGATIVE ? NEGATIVE_REMAINDER : PARTIAL_REMAINDER; // signed in NEGATE
            else FULL_RESULT = LATCHED_DIVIDE_BY_ZERO ? 64'hFFFF_FFFF_FFFF_FFFF : SIGNED_QUOTIENT;
        end else begin
            unique case (LATCHED_OPERATION)
                ALU_MULH, ALU_MULHSU, ALU_MULHU: FULL_RESULT = SIGNED_PRODUCT[127:64];
                default: FULL_RESULT = SIGNED_PRODUCT[63:0];
            endcase
        end
        LATE_RESULT = LATCHED_IS_WORD ? {{32{FULL_RESULT[31]}}, FULL_RESULT[31:0]} : FULL_RESULT;
    end

    assign READY = (UNIT_STATE == STATE_SIGN);

endmodule

`default_nettype wire
