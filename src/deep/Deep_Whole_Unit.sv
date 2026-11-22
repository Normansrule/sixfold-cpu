`default_nettype none

import alu_op_pkg::*;

// =====================================================================================================
// The deep-pipeline edition's whole-value unit: every ALU operation that is not an add, subtract, logic
// operation or compare (those run in the staggered slices, src/deep/Riscv64_Deep.sv). Three stages:
//
//   X3  (the core)        gathers and prepares the operands; DeepWholeDecode turns the ALU operation into
//                         one select line per result; DeepWholeFunnel lays out the shifter's input
//   X4  DeepWholePrepare  the shifts' coarse step (by 0, 4, ... 60 bits), the 16-bit groups of clz and ctz,
//                         the byte and bit operations and Zknh (they need only the operands),
//                         cpop's four quarter counts from X3's nibble counts. Its outputs are registered with the
//                         instruction. (cpop goes on: the two halves in M1, the total in M2, DeepPopulationSteps.)
//   M1  DeepWholeFinish   the shifts' fine step (0 .. 3 bits), clz and ctz combined, and a small AND-OR
//                         result multiplexer on a one-hot select.
//
// Shifts and rotates are funnel shifts of 128 bits:
//   right (srl sra ror bext and the word forms)  ({HIGH, LOW} >> amount)[63:0]
//   left  (sll rol and the word forms)            ({HIGH, LOW} << amount)[127:64]
// HIGH and LOW are the operand, zeros or copies of its sign, so rotates come out of the same shifter. The
// word forms put their 32 bits where the 64-bit window reads them and sign-extend the answer.
// The same results as src/ALU.sv (model/core.js alu), in shorter stages.
// =====================================================================================================

package deep_whole_pkg;
  // one-hot select of the result, and how the shifter is fed (decoded from the ALU operation in X3)
  typedef struct packed {
    logic rotate, arithmetic; // ror / rol / rorw / rolw; sra / sraw
    logic right, left, bext, op_and, op_or, op_xor, clz, ctz, cpop, sext_b, sext_h, zext_h, rev8, orc_b;
    logic sha256sum0, sha256sum1, sha256sig0, sha256sig1, sha512sum0, sha512sum1, sha512sig0, sha512sig1;
  } whole_select_t;
endpackage

import deep_whole_pkg::*;

module DeepWholeDecode (
  input  alu_op_t     OPERATION,
  output whole_select_t SELECT
);
  always_comb begin
    SELECT = '0;
    unique case (OPERATION)
      ALU_SRL: SELECT.right = 1'b1;
      ALU_SRA: begin SELECT.right = 1'b1; SELECT.arithmetic = 1'b1; end
      ALU_ROR: begin SELECT.right = 1'b1; SELECT.rotate = 1'b1; end
      ALU_SLL: SELECT.left = 1'b1;
      ALU_ROL: begin SELECT.left = 1'b1; SELECT.rotate = 1'b1; end
      ALU_BEXT: SELECT.bext = 1'b1;
      ALU_AND: SELECT.op_and = 1'b1; // bclr (Zbs operands come prepared)
      ALU_OR: SELECT.op_or = 1'b1;   // bset
      ALU_XOR: SELECT.op_xor = 1'b1; // binv
      ALU_CLZ: SELECT.clz = 1'b1;
      ALU_CTZ: SELECT.ctz = 1'b1;
      ALU_CPOP: SELECT.cpop = 1'b1;
      ALU_SEXT_B: SELECT.sext_b = 1'b1;
      ALU_SEXT_H: SELECT.sext_h = 1'b1;
      ALU_ZEXT_H: SELECT.zext_h = 1'b1;
      ALU_REV8: SELECT.rev8 = 1'b1;
      ALU_ORC_B: SELECT.orc_b = 1'b1;
      ALU_SHA256SUM0: SELECT.sha256sum0 = 1'b1;
      ALU_SHA256SUM1: SELECT.sha256sum1 = 1'b1;
      ALU_SHA256SIG0: SELECT.sha256sig0 = 1'b1;
      ALU_SHA256SIG1: SELECT.sha256sig1 = 1'b1;
      ALU_SHA512SUM0: SELECT.sha512sum0 = 1'b1;
      ALU_SHA512SUM1: SELECT.sha512sum1 = 1'b1;
      ALU_SHA512SIG0: SELECT.sha512sig0 = 1'b1;
      ALU_SHA512SIG1: SELECT.sha512sig1 = 1'b1;
      default: ;
    endcase
  end

endmodule

// X3: the shifter's 128-bit funnel, {HIGH, LOW}
module DeepWholeFunnel (
  input  logic [63:0] A,
  input  whole_select_t SELECT,
  input  logic        WORD,
  output logic [63:0] HIGH,
  output logic [63:0] LOW
);
  logic [31:0] w;
  logic [63:0] high, low;
  assign w = A[31:0];
  // the funnel's two halves
  always_comb begin
    if (SELECT.left) begin
      // left: the answer is the window [127:64]; a word form reads its 32 bits from the window's top half
      if (WORD) begin high = {w, SELECT.rotate ? w : 32'd0}; low = 64'd0; end
      else begin high = A; low = SELECT.rotate ? A : 64'd0; end
    end else begin
      // right: the answer is the window [63:0]; a word form reads the window's low 32 bits
      unique case ({WORD, SELECT.arithmetic, SELECT.rotate})
        3'b010: begin high = {64{A[63]}}; low = A; end           // sra
        3'b001: begin high = A; low = A; end                     // ror
        3'b100: begin high = 64'd0; low = {32'd0, w}; end        // srlw
        3'b110: begin high = {64{w[31]}}; low = {{32{w[31]}}, w}; end // sraw
        3'b101: begin high = {w, w}; low = {w, w}; end           // rorw
        default: begin high = 64'd0; low = A; end               // srl, bext
      endcase
    end
    HIGH = high; LOW = low;
  end
endmodule

module DeepWholePrepare (
  input  logic [63:0] A,          // rs1, prepared (slli.uw: zero-extended)
  input  logic [63:0] B,          // rs2 or the immediate, prepared (Zbs: the single bit, inverted for bclr)
  input  logic [63:0] HIGH,       // the funnel (DeepWholeFunnel in X3)
  input  logic [63:0] LOW,
  input  whole_select_t SELECT,
  input  logic        WORD,
  input  logic [47:0] NIBBLES,      // cpop: ones in each nibble of A, 3 bits each (DeepNibbleOnes in X3)
  output logic [66:0] RIGHT_COARSE, // the right funnel shifted by 4 x amount[5:2]: the 67 bits the fine step can still reach
  output logic [66:0] LEFT_COARSE,
  output logic [1:0]  FINE,         // amount[1:0]
  output logic [19:0] LEADING,      // per 16-bit group, top group first in bits 19:15: {all zero, leading zeros (4 bits)}
  output logic [19:0] TRAILING,     // the same for trailing zeros (bottom group in bits 19:15)
  output logic [19:0] QUARTERS,     // cpop: ones in each 16-bit quarter (cpopw: the top two are 0)
  output logic [63:0] SIMPLE        // the byte and bit operations and Zknh, which need only A (0 for the others)
);
  logic [5:0] amount;
  logic [3:0] coarse;
  logic [31:0] w;
  logic [127:0] right_wide, left_wide;
  assign amount = WORD ? {1'b0, B[4:0]} : B[5:0]; // the word forms use five bits of the amount
  assign coarse = amount[5:2];
  assign FINE = amount[1:0];
  assign w = A[31:0];

  always_comb begin
    right_wide = {HIGH, LOW} >> {coarse, 2'b00};
    left_wide = {HIGH, LOW} << {coarse, 2'b00};
    RIGHT_COARSE = right_wide[66:0];
    LEFT_COARSE = left_wide[127:61];
  end

  // clz / ctz: the word forms pad the low 32 bits with ones so the 64-bit count is the 32-bit answer
  function automatic logic [4:0] group_zeros(input logic [15:0] x); // {all zero, leading zeros}
    logic [3:0] count;
    count = 4'd15;
    for (int i = 0; i < 16; i++) if (x[i]) count = 4'(15 - i);
    return {x == 16'd0, count};
  endfunction
  logic [63:0] lead_in, trail_in;
  always_comb begin
    lead_in = WORD ? {w, 32'hFFFF_FFFF} : A;
    trail_in = WORD ? {32'hFFFF_FFFF, w} : A;
    for (int g = 0; g < 4; g++) begin
      logic [15:0] mirrored;
      LEADING[5*(3-g) +: 5] = group_zeros(lead_in[16*(3-g) +: 16]) ; // group 3 (the top one) lands in bits 19:15
      for (int i = 0; i < 16; i++) mirrored[i] = trail_in[16*g + 15 - i];
      TRAILING[5*(3-g) +: 5] = group_zeros(mirrored);              // group 0 (the bottom one) lands in bits 19:15
    end
  end
  // the operations on A alone
  function automatic logic [63:0] ror64(input logic [63:0] x, input int n); return (x >> n) | (x << (64 - n)); endfunction
  function automatic logic [31:0] ror32(input logic [31:0] x, input int n); return (x >> n) | (x << (32 - n)); endfunction
  function automatic logic [63:0] sext32(input logic [31:0] x); return {{32{x[31]}}, x}; endfunction
  logic [63:0] rev8, orc_b;
  logic [31:0] s256_0, s256_1, g256_0, g256_1;
  always_comb for (int i = 0; i < 8; i++) begin
    rev8[8*i +: 8] = A[8*(7-i) +: 8];
    orc_b[8*i +: 8] = {8{|A[8*i +: 8]}};
  end
  assign s256_0 = ror32(w, 2) ^ ror32(w, 13) ^ ror32(w, 22);
  assign s256_1 = ror32(w, 6) ^ ror32(w, 11) ^ ror32(w, 25);
  assign g256_0 = ror32(w, 7) ^ ror32(w, 18) ^ (w >> 3);
  assign g256_1 = ror32(w, 17) ^ ror32(w, 19) ^ (w >> 10);
  assign SIMPLE = ({64{SELECT.sext_b}} & {{56{A[7]}}, A[7:0]})
                | ({64{SELECT.sext_h}} & {{48{A[15]}}, A[15:0]})
                | ({64{SELECT.zext_h}} & {48'd0, A[15:0]})
                | ({64{SELECT.rev8}} & rev8)
                | ({64{SELECT.orc_b}} & orc_b)
                | ({64{SELECT.sha256sum0}} & sext32(s256_0))
                | ({64{SELECT.sha256sum1}} & sext32(s256_1))
                | ({64{SELECT.sha256sig0}} & sext32(g256_0))
                | ({64{SELECT.sha256sig1}} & sext32(g256_1))
                | ({64{SELECT.sha512sum0}} & (ror64(A, 28) ^ ror64(A, 34) ^ ror64(A, 39)))
                | ({64{SELECT.sha512sum1}} & (ror64(A, 14) ^ ror64(A, 18) ^ ror64(A, 41)))
                | ({64{SELECT.sha512sig0}} & (ror64(A, 1) ^ ror64(A, 8) ^ (A >> 7)))
                | ({64{SELECT.sha512sig1}} & (ror64(A, 19) ^ ror64(A, 61) ^ (A >> 6)))
                | ({64{SELECT.op_and}} & (A & B))
                | ({64{SELECT.op_or}} & (A | B))
                | ({64{SELECT.op_xor}} & (A ^ B));
  // cpop: the nibble counts added in pairs, then the pairs (two levels of small adders) per 16-bit quarter
  always_comb for (int q = 0; q < 4; q++) begin
    logic [3:0] pair0, pair1;
    pair0 = {1'b0, NIBBLES[12*q +: 3]} + {1'b0, NIBBLES[12*q + 3 +: 3]};
    pair1 = {1'b0, NIBBLES[12*q + 6 +: 3]} + {1'b0, NIBBLES[12*q + 9 +: 3]};
    QUARTERS[5*q +: 5] = (WORD && q >= 2) ? 5'd0 : {1'b0, pair0} + {1'b0, pair1};
  end
endmodule

// X3: ones in each nibble (0..4), as equations
module DeepNibbleOnes (
  input  logic [63:0] A,
  output logic [47:0] NIBBLES
);
  always_comb for (int i = 0; i < 16; i++) begin
    logic [3:0] n;
    logic at_least_two;
    n = A[4*i +: 4];
    at_least_two = (n[0] & n[1]) | (n[0] & n[2]) | (n[0] & n[3]) | (n[1] & n[2]) | (n[1] & n[3]) | (n[2] & n[3]);
    NIBBLES[3*i +: 3] = {&n, at_least_two & ~(&n), ^n};
  end
endmodule

// M1 and M2: cpop's halves, then its total
module DeepPopulationSteps (
  input  logic [19:0] QUARTERS,
  output logic [11:0] HALVES,   // M1: {ones in the high 32 bits, ones in the low 32 bits}
  input  logic [11:0] HALVES_IN, // M2: the halves, registered
  output logic [6:0]  TOTAL
);
  assign HALVES = {{1'b0, QUARTERS[19:15]} + {1'b0, QUARTERS[14:10]}, {1'b0, QUARTERS[9:5]} + {1'b0, QUARTERS[4:0]}};
  assign TOTAL = {1'b0, HALVES_IN[11:6]} + {1'b0, HALVES_IN[5:0]};
endmodule

module DeepWholeFinish (
  input  whole_select_t SELECT,
  input  logic        WORD,
  input  logic [66:0] RIGHT_COARSE,
  input  logic [66:0] LEFT_COARSE,
  input  logic [1:0]  FINE,
  input  logic [19:0] LEADING,
  input  logic [19:0] TRAILING,
  input  logic [63:0] SIMPLE,
  output logic [63:0] RESULT
);
  function automatic logic [63:0] sext32(input logic [31:0] x); return {{32{x[31]}}, x}; endfunction
  // four groups, top first: the first group that is not all zero decides
  function automatic logic [6:0] combine(input logic [19:0] groups);
    if (!groups[19]) return {3'd0, groups[18:15]};
    if (!groups[14]) return 7'd16 + {3'd0, groups[13:10]};
    if (!groups[9]) return 7'd32 + {3'd0, groups[8:5]};
    if (!groups[4]) return 7'd48 + {3'd0, groups[3:0]};
    return 7'd64;
  endfunction
  logic [63:0] right, left;
  assign right = RIGHT_COARSE[{5'd0, FINE} +: 64];
  assign left = LEFT_COARSE[{5'd0, ~FINE} +: 64]; // (3 - FINE)
  assign RESULT = ({64{SELECT.right}} & (WORD ? sext32(right[31:0]) : right))
                | ({64{SELECT.left}} & (WORD ? sext32(left[63:32]) : left))
                | ({64{SELECT.bext}} & {63'd0, right[0]})
                | ({64{SELECT.clz}} & {57'd0, combine(LEADING)})
                | ({64{SELECT.ctz}} & {57'd0, combine(TRAILING)})
                | SIMPLE;
endmodule

`default_nettype wire
