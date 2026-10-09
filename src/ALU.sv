// Fullest Optimized and Parallelized ALU (RV64 + Zba + Zbb):
// Optimized ALU: Uses a single shared adder/subtractor for ADD, SUB, SLT, SLTU, MIN, MAX and JALR to reduce critical path
// Performance edition: that shared adder is a Kogge-Stone parallel prefix adder (src/Parallel_Prefix_Adder.sv)
// RV64 addition: ALU_IS_WORD_OPERATION selects the 32-bit "W" variants (ADDW, SUBW, SLLW, SRLW, SRAW, ROLW, RORW,
//                CLZW, CTZW, CPOPW) which compute on the low 32 bits and sign-extend the 32-bit result back to 64 bits
// Zbb: every bit-manipulation unit (counters, rotator, byte shuffles) works in parallel with the adder;
//      only the final result multiplexer grows. Zba needs nothing here: DECODE prepares operand A.
`default_nettype none

import opcode_pkg::*;
import alu_op_pkg::*;

module ALU (
    input  logic [63:0] A,
    input  logic [63:0] B,
    input  alu_op_t ALUop,
    input  logic SUBTRACT_MODE, // SUB, SLT, SLTU, MIN(U), MAX(U): decoded from ALUop one stage earlier (it steers all 64 adder inputs)
    input  logic ALU_IS_WORD_OPERATION, // 0 means full 64-bit operation, 1 means 32-bit Word operation (sign extended)
    input  logic LATE_RESULT, // cpop, cpopw, min, minu, max, maxu (registered in DECODE): their result goes on ALUOut only
    output logic [63:0] ALUOutFast, // every other operation: short enough to forward in the same cycle
    output logic [63:0] ALUOut // everything (to the MEMORY stage)
);

    logic [63:0] ADDER_SUM;
    logic ADDER_CARRY_OUT;
    ParallelPrefixAdder #(.WIDTH(64)) shared_adder (
        .A (A),
        .B (SUBTRACT_MODE ? ~B : B),
        .CARRY_IN (SUBTRACT_MODE),
        .SUM (ADDER_SUM),
        .CARRY_OUT (ADDER_CARRY_OUT)
    );

    // ---------------------------------------------------------------- Zbb counting units
    // clz / ctz / cpop and their word forms. The word forms pad the low 32 bits so the 64-bit units give
    // the 32-bit answer: clzw counts in {A[31:0], ones}, ctzw in {ones, A[31:0]}. cpop and cpopw leave
    // EXECUTE as four 16-bit quarter counts; MEMORY adds all four (cpop) or the low two (cpopw).
    logic [63:0] CLZ_INPUT, CTZ_INPUT_REVERSED;
    logic [5:0] CLZ_COUNT, CTZ_COUNT;
    logic CLZ_ALL_ZERO, CTZ_ALL_ZERO;
    logic [19:0] QUARTER_POPULATIONS;
    logic [63:0] CTZ_INPUT;
    assign CLZ_INPUT = ALU_IS_WORD_OPERATION ? {A[31:0], 32'hFFFF_FFFF} : A;
    assign CTZ_INPUT = ALU_IS_WORD_OPERATION ? {32'hFFFF_FFFF, A[31:0]} : A;
    always_comb for (int i = 0; i < 64; i++) CTZ_INPUT_REVERSED[i] = CTZ_INPUT[63-i]; // trailing zeros = leading zeros of the mirror image
    LeadingZeroCounter count_leading (.X (CLZ_INPUT), .COUNT (CLZ_COUNT), .ALL_ZERO (CLZ_ALL_ZERO));
    LeadingZeroCounter count_trailing (.X (CTZ_INPUT_REVERSED), .COUNT (CTZ_COUNT), .ALL_ZERO (CTZ_ALL_ZERO));
    PopulationCount count_ones (.X (A), .QUARTER_COUNTS (QUARTER_POPULATIONS));

    logic [63:0] CLZ_RESULT, CTZ_RESULT, CPOP_RESULT;
    assign CLZ_RESULT = CLZ_ALL_ZERO ? 64'd64 : {58'd0, CLZ_COUNT}; // all-zero input: 64 (the word forms never get here: their padding is never all zero)
    assign CTZ_RESULT = CTZ_ALL_ZERO ? 64'd64 : {58'd0, CTZ_COUNT};
    assign CPOP_RESULT = {44'd0, QUARTER_POPULATIONS}; // finished in MEMORY (src/Population_Count.sv)

    // Rotations for Zknh: a rotate by a constant is only wiring.
    function automatic logic [63:0] ror64(input logic [63:0] x, input int n);
        return (x >> n) | (x << (64 - n));
    endfunction
    function automatic logic [31:0] ror32(input logic [31:0] x, input int n);
        return (x >> n) | (x << (32 - n));
    endfunction

    function automatic logic [63:0] alu (
        input logic [63:0] rs1, // First operand
        input logic [63:0] rs2, // Second operand
        input alu_op_t operation_code, // The Operation Code
        input logic is_word, // Word (32-bit) operation?
        input logic [64:0] add_and_subtract_result, // {carry out, sum} from the shared prefix adder
        input logic [63:0] clz_result,
        input logic [63:0] ctz_result,
        input logic [63:0] cpop_result
    );
    logic signed [63:0] signed_rs1; // For Signed Operations
    logic [5:0] bit_shift; // For 64 bits 2^6 = 64 which means shift is by 6 bits
    logic [4:0] word_bit_shift; // For 32 bit Word operations 2^5 = 32 which means shift is by 5 bits
    logic [63:0] and_result; // Precomputed AND Result
    logic [63:0] or_result; // Precomputed OR Result
    logic [63:0] xor_result; // Precomputed XOR Result
    logic [63:0] csr_result; // Precomputed CSR Clear-Bits Result
    logic [31:0] sha256_sum0, sha256_sum1, sha256_sig0, sha256_sig1; // Zknh, on rs1[31:0]
    logic [63:0] sll_result; // Precomputed Shift Left Logical Result
    logic [63:0] sra_result; // Precomputed Shift Right Arithmetic Result
    logic [63:0] srl_result; // Precomputed Shift Right Logical Result
    logic [127:0] rotate_left_wide, rotate_right_wide; // {rs1, rs1} shifted: the bits that fall off one end come back at the other
    logic [63:0] word_doubled; // {rs1[31:0], rs1[31:0]} for the 32-bit rotates
    logic [31:0] word_sll_result; // Precomputed Word Shift Left Logical Result
    logic [31:0] word_srl_result; // Precomputed Word Shift Right Logical Result
    logic [31:0] word_sra_result; // Precomputed Word Shift Right Arithmetic Result
    logic [31:0] word_rol_result, word_ror_result;
    logic [63:0] rev8_result, orc_b_result;
    logic slt_result; // Precomputed Signed Less-Than Result (derived from shared adder)
    logic sltu_result; // Precomputed Unsigned Less-Than Result (derived from shared adder carry-out)
    logic [63:0] alu_result; // Store the result of the 64-bit ALU operation
    logic [31:0] word_result; // Store the result of the 32-bit Word ALU operation
    begin
        signed_rs1 = $signed(rs1);
        bit_shift = rs2[5:0];
        word_bit_shift = rs2[4:0];

        sha256_sum0 = ror32(rs1[31:0], 2) ^ ror32(rs1[31:0], 13) ^ ror32(rs1[31:0], 22);
        sha256_sum1 = ror32(rs1[31:0], 6) ^ ror32(rs1[31:0], 11) ^ ror32(rs1[31:0], 25);
        sha256_sig0 = ror32(rs1[31:0], 7) ^ ror32(rs1[31:0], 18) ^ (rs1[31:0] >> 3);
        sha256_sig1 = ror32(rs1[31:0], 17) ^ ror32(rs1[31:0], 19) ^ (rs1[31:0] >> 10);
        and_result = rs1 & rs2; // Operand 1 AND Operand 2 (andn: DECODE already inverted rs2)
        or_result = rs1 | rs2; // Operand 1 OR Operand 2 (orn: inverted rs2)
        xor_result = rs1 ^ rs2; // Operand 1 XOR Operand 2 (xnor: inverted rs2)
        csr_result = rs1 & ~rs2; // CSRs Clear bits in rs1 where rs2 has any 1s
        sll_result = rs1 << bit_shift; // Shift Left Logical by 64 bit shift
        sra_result = signed_rs1 >>> bit_shift; // Shift Right Arithmetic by 64 bit shift
        srl_result = rs1 >> bit_shift; // Shift Right Logical by 64 bit shift
        rotate_left_wide = {rs1, rs1} << bit_shift; // rol = upper half
        rotate_right_wide = {rs1, rs1} >> bit_shift; // ror = lower half
        word_doubled = {rs1[31:0], rs1[31:0]};
        word_sll_result = rs1[31:0] << word_bit_shift; // Word Shift Left Logical (only the low 32 bits matter)
        word_srl_result = rs1[31:0] >> word_bit_shift; // Word Shift Right Logical (zeros shift in at bit 31)
        word_sra_result = $signed(rs1[31:0]) >>> word_bit_shift; // Word Shift Right Arithmetic (bit 31 copies shift in)
        word_rol_result = 32'((word_doubled << word_bit_shift) >> 32);
        word_ror_result = 32'(word_doubled >> word_bit_shift);
        for (int i = 0; i < 8; i++) begin
            rev8_result[8*i +: 8] = rs1[8*(7-i) +: 8]; // byte i comes from byte 7 - i
            orc_b_result[8*i +: 8] = {8{|rs1[8*i +: 8]}}; // 0xFF where the byte is not zero
        end
        slt_result = (rs1[63] != rs2[63]) ? rs1[63] : add_and_subtract_result[63]; // Signed Less-Than: sign bit of (A - B) gives the answer, unless signs differ then A's sign decides (handles overflow)
        sltu_result = ~add_and_subtract_result[64]; // Unsigned Less-Than: A < B (unsigned) means a borrow happened in A - B which means carry-out is 0

        alu_result = 64'd0;
        unique case (operation_code)
            ALU_ADD: alu_result = add_and_subtract_result[63:0]; // Operand 1 + Operand 2 (shared adder with subtract_mode = 0)
            ALU_SUB: alu_result = add_and_subtract_result[63:0]; // Operand 1 - Operand 2 (shared adder with subtract_mode = 1)
            ALU_AND: alu_result = and_result; // Operand 1 AND Operand 2
            ALU_OR: alu_result = or_result; // Operand 1 OR Operand 2
            ALU_XOR: alu_result = xor_result; // Operand 1 XOR Operand 2
            ALU_SLT: alu_result = {63'd0, slt_result}; // Set less Than if Operand 1 < Operand 2 (Signed, derived from shared adder)
            ALU_SLTU: alu_result = {63'd0, sltu_result}; // Set less Than if Operand 1 < Operand 2 (Unsigned, derived from shared adder)
            ALU_SLL: alu_result = sll_result; // Shift Left Logical by 64 bit shift
            ALU_SRA: alu_result = sra_result; // Shift Right Arithmetic by 64 bit shift
            ALU_SRL: alu_result = srl_result; // Shift Right Logical by 64 bit shift
            ALU_COPY_B: alu_result = rs2; // Just Forward whatever the value of RS2 (B)
            ALU_CSR: alu_result = csr_result; // CSRs Clear bits in rs1 where rs2 has any 1s
            ALU_JALR: alu_result = add_and_subtract_result[63:0]; // JALR requires even addresses (halfword aligned) this will be handled in riscv core logic (shared adder with subtract_mode = 0)
            ALU_MIN: alu_result = slt_result ? rs1 : rs2; // Zbb: the comparison is the shared subtractor's
            ALU_MINU: alu_result = sltu_result ? rs1 : rs2;
            ALU_MAX: alu_result = slt_result ? rs2 : rs1;
            ALU_MAXU: alu_result = sltu_result ? rs2 : rs1;
            ALU_ROL: alu_result = rotate_left_wide[127:64];
            ALU_ROR: alu_result = rotate_right_wide[63:0];
            ALU_CLZ: alu_result = clz_result;
            ALU_CTZ: alu_result = ctz_result;
            ALU_CPOP: alu_result = cpop_result;
            ALU_SEXT_B: alu_result = {{56{rs1[7]}}, rs1[7:0]};
            ALU_SEXT_H: alu_result = {{48{rs1[15]}}, rs1[15:0]};
            ALU_ZEXT_H: alu_result = {48'd0, rs1[15:0]};
            ALU_REV8: alu_result = rev8_result;
            ALU_ORC_B: alu_result = orc_b_result;
            ALU_BEXT: alu_result = {63'd0, srl_result[0]}; // the bit the right shifter brings down to position 0
            // Zknh: rotations are free (wires), so each is a 3-input XOR per bit. The 32-bit SHA-256 forms
            // sign-extend their result, as the specification requires.
            ALU_SHA256SUM0: alu_result = {{32{sha256_sum0[31]}}, sha256_sum0};
            ALU_SHA256SUM1: alu_result = {{32{sha256_sum1[31]}}, sha256_sum1};
            ALU_SHA256SIG0: alu_result = {{32{sha256_sig0[31]}}, sha256_sig0};
            ALU_SHA256SIG1: alu_result = {{32{sha256_sig1[31]}}, sha256_sig1};
            ALU_SHA512SUM0: alu_result = ror64(rs1, 28) ^ ror64(rs1, 34) ^ ror64(rs1, 39);
            ALU_SHA512SUM1: alu_result = ror64(rs1, 14) ^ ror64(rs1, 18) ^ ror64(rs1, 41);
            ALU_SHA512SIG0: alu_result = ror64(rs1, 1)  ^ ror64(rs1, 8)  ^ (rs1 >> 7);
            ALU_SHA512SIG1: alu_result = ror64(rs1, 19) ^ ror64(rs1, 61) ^ (rs1 >> 6);
            // hsec.cteq: equality WITHOUT a branch. A compare-and-branch leaks, through timing, how far
            // two secrets agree; one ALU operation takes the same cycle whatever the operands are.
            ALU_CTEQ: alu_result = {63'd0, (xor_result == 64'd0)};
            default: alu_result = 64'd0; // Default Case for any edge cases not covered (ALU_XXX and the M extension which uses the Multiply Divide Unit)
        endcase

        unique case (operation_code)
            ALU_SLL: word_result = word_sll_result; // SLLW / SLLIW
            ALU_SRL: word_result = word_srl_result; // SRLW / SRLIW
            ALU_SRA: word_result = word_sra_result; // SRAW / SRAIW
            ALU_ROL: word_result = word_rol_result; // ROLW
            ALU_ROR: word_result = word_ror_result; // RORW / RORIW
            ALU_CLZ: word_result = clz_result[31:0]; // CLZW (0..32)
            ALU_CTZ: word_result = ctz_result[31:0]; // CTZW
            ALU_CPOP: word_result = cpop_result[31:0]; // CPOPW
            default: word_result = add_and_subtract_result[31:0]; // ADDW / ADDIW / SUBW use the low half of the shared adder
        endcase

        return is_word ? {{32{word_result[31]}}, word_result} : alu_result; // Word results are sign extended from bit 31 back to 64 bits
    end
    endfunction

    // The adder is the slowest unit the forwarding loop has to wait for, so its result enters the output
    // multiplexer LAST: every other unit is selected first (while the carries are still settling), and one
    // final 2:1 picks between "an adder operation" and "everything else".
    logic ADDER_OPERATION;
    assign ADDER_OPERATION = (ALUop == ALU_ADD) || (ALUop == ALU_SUB) || (ALUop == ALU_JALR) || (ALUop == ALU_SLT) || (ALUop == ALU_SLTU);
    logic ADDER_SLT, ADDER_SLTU;
    assign ADDER_SLT = (A[63] != B[63]) ? A[63] : ADDER_SUM[63];
    assign ADDER_SLTU = ~ADDER_CARRY_OUT;
    logic [63:0] ADDER_FAMILY_RESULT, OTHER_RESULT;
    always_comb begin
        unique case (ALUop)
            ALU_SLT: ADDER_FAMILY_RESULT = {63'd0, ADDER_SLT};
            ALU_SLTU: ADDER_FAMILY_RESULT = {63'd0, ADDER_SLTU};
            default: ADDER_FAMILY_RESULT = ALU_IS_WORD_OPERATION ? {{32{ADDER_SUM[31]}}, ADDER_SUM[31:0]} : ADDER_SUM; // ADD SUB JALR, ADDW SUBW ADDIW
        endcase
        OTHER_RESULT = alu(A, B, ALUop, ALU_IS_WORD_OPERATION, 65'd0, CLZ_RESULT, CTZ_RESULT, 64'd0); // no adder input: logic, shifts, rotates, clz, ctz, byte ops
    end

    // Two Zbb results take one cycle more than everything else, so they are kept out of the forwarding loop:
    //   cpop / cpopw        a 64-bit population count is a deeper tree than the 64-bit adder
    //   min / max (+ u)     the comparison comes out of the adder and then steers all 64 result bits
    // Their result leaves through ALUOut only and is forwarded from MEMORY one cycle later (a dependent
    // instruction right behind one waits one cycle, exactly like a load: LOAD_STALL covers them).
    logic [63:0] LATE_VALUE;
    always_comb begin
        unique case (ALUop)
            ALU_MIN: LATE_VALUE = ADDER_SLT ? A : B;
            ALU_MINU: LATE_VALUE = ADDER_SLTU ? A : B;
            ALU_MAX: LATE_VALUE = ADDER_SLT ? B : A;
            ALU_MAXU: LATE_VALUE = ADDER_SLTU ? B : A;
            default: LATE_VALUE = CPOP_RESULT; // cpop, cpopw: four partial counts, added up in MEMORY
        endcase
        ALUOutFast = ADDER_OPERATION ? ADDER_FAMILY_RESULT : OTHER_RESULT;
        ALUOut = LATE_RESULT ? LATE_VALUE : ALUOutFast;
    end

endmodule

`default_nettype wire
