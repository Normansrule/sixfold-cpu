`default_nettype none

// =====================================================================================================
// DeepCustomChain: the deep-pipeline edition's custom instructions (src/Custom_Unit.sv, generated from
// custom/instructions.json) as one three-cycle multicycle path.
//
// Your instructions can be anything, so the edition does not try to cut them into ~185 ps stages. Instead
// Riscv64Deep registers the prepared operands and the one-hot select at the end of X3 (CUSTOM_A / CUSTOM_B /
// CUSTOM_SELECT) and keeps them still for three cycles (X4, M1, M2); this chain, CustomPrepare then
// CustomUnit, has all three to settle, and its result is registered into M3's slot at the end of M2, the
// same AT (5) the custom instructions had before. The price: D2 issues a custom instruction at most once
// every three cycles (a "custom" hold). Timing (tools/timing.sh deep) leaves this chain out of the
// one-cycle paths and measures it on its own against three cycles.
// =====================================================================================================
module DeepCustomChain (
    input  logic [63:0] A,      // rs1, prepared (registered at the end of X3)
    input  logic [63:0] B,      // rs2 or the immediate, prepared
    input  logic [31:0] SELECT, // CustomDecode's one-hot select
    output logic [63:0] RESULT
);
  logic [63:0] PREPARED;
  CustomPrepare custom_prepare (.A (A), .B (B), .PREPARED (PREPARED));
  CustomUnit custom_unit (.A (A), .B (B), .PREPARED (PREPARED), .SELECT (SELECT), .RESULT (RESULT));
endmodule

`default_nettype wire
