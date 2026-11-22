// =====================================================================================================
// riscv64_deep_testbench.sv: the deep-pipeline edition (src/deep/). Same plusargs and end-of-run report as
// tb/riscv64_testbench.sv; the trace line has the 14 stages of DeepCore.traceLine (model/deep.js).
// =====================================================================================================
`timescale 1ns/1ps
`default_nettype none

module riscv64_deep_testbench;
  logic clk = 1'b0;
  logic reset = 1'b1;
  always #5 clk = ~clk;

  logic        BRANCH_PREDICTION_ENABLE = 1'b1;
  logic [63:0] csr, DEBUG_REGISTER_DATA;
  logic        HALTED;
  logic [4:0]  DEBUG_REGISTER_ADDRESS = 5'd0;
  logic [13:0] TRACE_VALID;
  logic [31:0] TRACE_PC [0:13];
  logic [7:0]  TRACE_FLAGS;

  riscv64_deep_top dut (.*);

  integer TRACE_FILE = 0, MAX_CYCLES, CYCLE = 0, RETIRED = 0, INDEX, BP_ARGUMENT, STAGE;
  logic [1023:0] TRACE_FILE_NAME, VCD_FILE_NAME;
  // stage names in the trace (DeepCore.traceLine)
  function automatic [8*2-1:0] stage_name(input integer s);
    case (s)
      0: stage_name = "F1"; 1: stage_name = "F2"; 2: stage_name = "F3"; 3: stage_name = "F4"; 4: stage_name = "D1"; 5: stage_name = "D2";
      6: stage_name = "X1"; 7: stage_name = "X2"; 8: stage_name = "X3"; 9: stage_name = "X4";
      10: stage_name = "M1"; 11: stage_name = "M2"; 12: stage_name = "M3"; default: stage_name = "W ";
    endcase
  endfunction

  function automatic [8*8-1:0] hex8(input logic valid, input logic [31:0] value);
    integer d; logic [3:0] n; logic [8*8-1:0] s;
    begin
      s = "--------";
      if (valid) for (d = 0; d < 8; d = d + 1) begin
        n = value[4*d +: 4];
        s[8*d +: 8] = (n < 10) ? (8'd48 + n) : (8'd87 + n);
      end
      hex8 = s;
    end
  endfunction

  initial begin
    if (!$value$plusargs("MAXCYCLES=%d", MAX_CYCLES)) MAX_CYCLES = 3000000;
    if ($value$plusargs("BP=%d", BP_ARGUMENT)) BRANCH_PREDICTION_ENABLE = (BP_ARGUMENT != 0);
    if ($value$plusargs("TRACE=%s", TRACE_FILE_NAME)) TRACE_FILE = $fopen(TRACE_FILE_NAME, "w");
    if ($value$plusargs("VCD=%s", VCD_FILE_NAME)) begin $dumpfile(VCD_FILE_NAME); $dumpvars(0, riscv64_deep_testbench); end
    repeat (2) @(posedge clk);
    @(negedge clk) reset = 1'b0;
  end

  always @(posedge clk) if (!reset && !HALTED) begin
    CYCLE = CYCLE + 1;
    if (TRACE_VALID[13]) RETIRED = RETIRED + 1;
    if (TRACE_FILE != 0) begin
      $fwrite(TRACE_FILE, "C%0d", CYCLE);
      for (STAGE = 0; STAGE < 14; STAGE = STAGE + 1)
        if (STAGE == 13) $fwrite(TRACE_FILE, " W:%s", hex8(TRACE_VALID[STAGE], TRACE_PC[STAGE]));
        else $fwrite(TRACE_FILE, " %s:%s", stage_name(STAGE), hex8(TRACE_VALID[STAGE], TRACE_PC[STAGE]));
      if (TRACE_FLAGS[0]) $fwrite(TRACE_FILE, " STALL");
      if (TRACE_FLAGS[1]) $fwrite(TRACE_FILE, " FLUSH");
      if (TRACE_FLAGS[2]) $fwrite(TRACE_FILE, " REDIRECT");
      if (TRACE_FLAGS[3]) $fwrite(TRACE_FILE, " BUSY");
      if (TRACE_FLAGS[4]) $fwrite(TRACE_FILE, " IMISS");
      if (TRACE_FLAGS[5]) $fwrite(TRACE_FILE, " DMISS");
      if (TRACE_FLAGS[6]) $fwrite(TRACE_FILE, " REPLAY");
      if (TRACE_FLAGS[7]) $fwrite(TRACE_FILE, " INTR");
      $fwrite(TRACE_FILE, "\n");
    end
    if (CYCLE >= MAX_CYCLES) begin
      $display("\n[tb] ERROR: no TOHOST write after %0d cycles", CYCLE);
      $finish;
    end
  end

  always @(posedge HALTED) begin
    #1;
    if (TRACE_FILE != 0) $fclose(TRACE_FILE);
    $display("");
    $display("[tb] HALT after %0d cycles, %0d instructions retired", CYCLE, RETIRED);
    if (csr == 64'd1) $display("[tb] TOHOST = 1: PASS");
    else $display("[tb] TOHOST = %0d: FAIL in test %0d", csr, csr >> 1);
    $display("[tb] branch predictor: %s", BRANCH_PREDICTION_ENABLE ? "GShare" : "off (always not taken)");
    for (INDEX = 0; INDEX < 32; INDEX = INDEX + 1) begin
      DEBUG_REGISTER_ADDRESS = INDEX[4:0]; #1;
      $display("REG x%0d %016h", INDEX, DEBUG_REGISTER_DATA);
    end
    $finish;
  end
endmodule

`default_nettype wire
