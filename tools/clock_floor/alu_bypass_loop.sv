// =============================================================================
// tools/clock_floor/alu_bypass_loop.sv: the loop every single-issue pipeline must close in one cycle
//
// A dependent ALU instruction can only start the cycle after the one it depends on if this loop fits:
// operand register -> adder -> bypass multiplexer (register file, the adder itself, MEMORY) -> operand register.
// tools/clock_floor.sh synthesizes it alone with the same flow as tools/timing.sh, at three widths:
//   loop64: a full 64-bit add (Sixfold's EXECUTE today)
//   loop32 / loop16: "staggered" adders, which add the low 32 (or 16) bits in one cycle and the rest in the
//   next, so a dependent add can start on the low part every cycle (the technique of Intel's Pentium 4)
// It is not part of the core and is never simulated.
// =============================================================================
module loop64(input logic clk, input logic [63:0] RF_A, RF_B, MEM_V, input logic [1:0] SA, SB, output logic [63:0] OUT);
  logic [63:0] A, B, S; logic c;
  ParallelPrefixAdder #(.WIDTH(64)) add (.A(A), .B(B), .CARRY_IN(1'b0), .SUM(S), .CARRY_OUT(c));
  always_ff @(posedge clk) begin
    A <= SA==2'd0 ? RF_A : SA==2'd1 ? S : MEM_V;
    B <= SB==2'd0 ? RF_B : SB==2'd1 ? S : MEM_V;
  end
  assign OUT = S;
endmodule
// staggered: low 32 bits in one cycle, high 32 bits (with the low carry) the next; a dependent add can start
// on the low half every cycle
module loop32(input logic clk, input logic [31:0] RF_A, RF_B, MEM_V, input logic [1:0] SA, SB, output logic [31:0] OUT, output logic C);
  logic [31:0] A, B, S; logic c;
  ParallelPrefixAdder #(.WIDTH(32)) add (.A(A), .B(B), .CARRY_IN(1'b0), .SUM(S), .CARRY_OUT(c));
  always_ff @(posedge clk) begin
    A <= SA==2'd0 ? RF_A : SA==2'd1 ? S : MEM_V;
    B <= SB==2'd0 ? RF_B : SB==2'd1 ? S : MEM_V;
    C <= c;
  end
  assign OUT = S;
endmodule
module loop16(input logic clk, input logic [15:0] RF_A, RF_B, MEM_V, input logic [1:0] SA, SB, output logic [15:0] OUT, output logic C);
  logic [15:0] A, B, S; logic c;
  ParallelPrefixAdder #(.WIDTH(16)) add (.A(A), .B(B), .CARRY_IN(1'b0), .SUM(S), .CARRY_OUT(c));
  always_ff @(posedge clk) begin
    A <= SA==2'd0 ? RF_A : SA==2'd1 ? S : MEM_V;
    B <= SB==2'd0 ? RF_B : SB==2'd1 ? S : MEM_V;
    C <= c;
  end
  assign OUT = S;
endmodule
