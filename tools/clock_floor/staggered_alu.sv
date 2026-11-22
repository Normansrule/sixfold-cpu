// =============================================================================
// tools/clock_floor/staggered_alu.sv: one slice of the deep edition's staggered ALU, with its bypass loop
//
// The deep edition adds 64 bits in slices, one slice per execute stage, like the Pentium 4's integer units.
// Each stage holds one slice of every instruction in flight, and its loop has to close in one cycle:
//   operand registers -> W-bit add / AND / OR / XOR, one-hot selected -> bypass multiplexer -> operand registers
// The bypass has two inputs: the operand DECODE prepared for this instruction (register file or an older
// result, chosen a stage earlier), or this slice's own result from the cycle before (the instruction right
// ahead). The carry into the slice comes from the slice below, computed one stage earlier for the same
// instruction, so it is a flip-flop: it is not on the loop. Subtraction is an add of ~B with a carry of 1
// into the lowest slice (B is inverted in DECODE).
// tools/clock_floor.sh synthesizes slice16 / slice22 / slice32 alone, the same flow as the core.
// It is not part of the core and is never simulated.
// =============================================================================
module StaggeredSlice #(parameter int W = 16) (
    input  logic clk,
    input  logic [W-1:0] EARLY_A, EARLY_B,   // from DECODE (register file or an older result, already chosen)
    input  logic A_FROM_SELF, B_FROM_SELF,   // the instruction right ahead wrote rs1 / rs2: use this slice's last result
    input  logic [3:0] NEXT_OP,              // one-hot: add, and, or, xor (decoded in DECODE)
    input  logic NEXT_CARRY,                 // the carry into this slice, from the slice below one stage earlier
    output logic [W-1:0] RESULT,
    output logic CARRY_OUT
);
    logic [W-1:0] A, B, SUM;
    logic [3:0] OP;
    logic CARRY_IN, C;
    ParallelPrefixAdder #(.WIDTH(W)) add (.A(A), .B(B), .CARRY_IN(CARRY_IN), .SUM(SUM), .CARRY_OUT(C));
    logic [W-1:0] Y;
    assign Y = ({W{OP[0]}} & SUM) | ({W{OP[1]}} & (A & B)) | ({W{OP[2]}} & (A | B)) | ({W{OP[3]}} & (A ^ B));
    always_ff @(posedge clk) begin
        A <= A_FROM_SELF ? Y : EARLY_A;
        B <= B_FROM_SELF ? Y : EARLY_B;
        OP <= NEXT_OP;
        CARRY_IN <= NEXT_CARRY;
        RESULT <= Y;
        CARRY_OUT <= C;
    end
endmodule

module slice16 (input logic clk, input logic [15:0] EA, EB, input logic SA, SB, input logic [3:0] OPN, input logic CN, output logic [15:0] R, output logic CO);
    StaggeredSlice #(.W(16)) s (.clk, .EARLY_A(EA), .EARLY_B(EB), .A_FROM_SELF(SA), .B_FROM_SELF(SB), .NEXT_OP(OPN), .NEXT_CARRY(CN), .RESULT(R), .CARRY_OUT(CO));
endmodule
module slice22 (input logic clk, input logic [21:0] EA, EB, input logic SA, SB, input logic [3:0] OPN, input logic CN, output logic [21:0] R, output logic CO);
    StaggeredSlice #(.W(22)) s (.clk, .EARLY_A(EA), .EARLY_B(EB), .A_FROM_SELF(SA), .B_FROM_SELF(SB), .NEXT_OP(OPN), .NEXT_CARRY(CN), .RESULT(R), .CARRY_OUT(CO));
endmodule
module slice32 (input logic clk, input logic [31:0] EA, EB, input logic SA, SB, input logic [3:0] OPN, input logic CN, output logic [31:0] R, output logic CO);
    StaggeredSlice #(.W(32)) s (.clk, .EARLY_A(EA), .EARLY_B(EB), .A_FROM_SELF(SA), .B_FROM_SELF(SB), .NEXT_OP(OPN), .NEXT_CARRY(CN), .RESULT(R), .CARRY_OUT(CO));
endmodule
