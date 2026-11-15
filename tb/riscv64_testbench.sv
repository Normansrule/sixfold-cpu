// =====================================================================================================
// riscv64_testbench.sv: clock, reset, one trace line per cycle, and a register dump at the end.
//
//   +HEX=build/prog.hex      program image ($readmemh, one byte per line, starts at @00002000)
//   +TRACE=build/prog.trace  per-cycle pipeline trace (diffed against model/core.js by `make test`)
//   +VCD=build/prog.vcd      waveforms for GTKWave
//   +BP=0                    turn the GShare predictor off (always predict not taken)
//   +MAXCYCLES=N             safety limit (default 2000000)
// =====================================================================================================
//   Build-time configuration (make test builds both):
//     default               the performance edition (caches, tournament predictor, BTB, RAS, precise load stalls, iterative M unit)
//     -DBASELINE            the baseline pipeline (all features off, 4 history bits, single-cycle memory)
//     -DCOMPACT             the performance edition with 1 KiB caches (CACHE_SETS = 16)
`timescale 1ns/1ps
`default_nettype none
`ifdef BASELINE
  `define CONFIG_FEATURES 1'b0
  `define CONFIG_HISTORY 4
`else
  `define CONFIG_FEATURES 1'b1
  `define CONFIG_HISTORY 6
`endif
`ifdef COMPACT
  `define CONFIG_CACHE_SETS 16
`else
  `define CONFIG_CACHE_SETS 64
`endif

module riscv64_testbench;
  logic clk = 1'b0;
  logic reset = 1'b1;
  always #5 clk = ~clk; // 100 MHz simulation clock (the real sky130 chip ran at 26 ns)

  logic        BRANCH_PREDICTION_ENABLE = 1'b1;
  logic [63:0] csr, DEBUG_REGISTER_DATA;
  logic        HALTED;
  logic [4:0]  DEBUG_REGISTER_ADDRESS = 5'd0;
  logic [5:0]  TRACE_VALID;
  logic [63:0] TRACE_FETCH1_PC, TRACE_FETCH2_PC, TRACE_DECODE_PC, TRACE_EXECUTE_PC, TRACE_MEMORY_PC, TRACE_WRITEBACK_PC;
  logic        TRACE_LOAD_STALL, TRACE_FLUSH, TRACE_REDIRECT, TRACE_MULTIPLY_DIVIDE_STALL, TRACE_INSTRUCTION_MISS, TRACE_DATA_MISS;

  riscv64_top #(
    .GSHARE_HISTORY_BITS (`CONFIG_HISTORY),
    .BTB_ENABLE (`CONFIG_FEATURES),
    .RAS_ENABLE (`CONFIG_FEATURES),
    .PRECISE_LOAD_STALL (`CONFIG_FEATURES),
    .ITERATIVE_MULTIPLY_DIVIDE (`CONFIG_FEATURES),
    .TOURNAMENT_PREDICTOR (`CONFIG_FEATURES),
    .CACHES_ENABLE (`CONFIG_FEATURES),
    .CACHE_SETS (`CONFIG_CACHE_SETS)
  ) dut (.*);

  integer TRACE_FILE = 0, MAX_CYCLES, CYCLE = 0, RETIRED = 0, INDEX, BP_ARGUMENT;
  logic [1023:0] TRACE_FILE_NAME, VCD_FILE_NAME;

  function automatic [8*8-1:0] hex8(input logic valid, input logic [63:0] value);
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
    if (!$value$plusargs("MAXCYCLES=%d", MAX_CYCLES)) MAX_CYCLES = 2000000;
    if ($value$plusargs("BP=%d", BP_ARGUMENT)) BRANCH_PREDICTION_ENABLE = (BP_ARGUMENT != 0);
    if ($value$plusargs("TRACE=%s", TRACE_FILE_NAME)) TRACE_FILE = $fopen(TRACE_FILE_NAME, "w");
    if ($value$plusargs("VCD=%s", VCD_FILE_NAME)) begin $dumpfile(VCD_FILE_NAME); $dumpvars(0, riscv64_testbench); end
    repeat (2) @(posedge clk);
    @(negedge clk) reset = 1'b0;
  end

  // One trace line per clock cycle, sampled just before the rising edge
  always @(posedge clk) if (!reset && !HALTED) begin
    CYCLE = CYCLE + 1;
    if (TRACE_VALID[5]) RETIRED = RETIRED + 1;
    if (TRACE_FILE != 0) begin
      $fwrite(TRACE_FILE, "C%0d F1:%s F2:%s D:%s E:%s M:%s W:%s", CYCLE,
        hex8(TRACE_VALID[0], TRACE_FETCH1_PC), hex8(TRACE_VALID[1], TRACE_FETCH2_PC), hex8(TRACE_VALID[2], TRACE_DECODE_PC),
        hex8(TRACE_VALID[3], TRACE_EXECUTE_PC), hex8(TRACE_VALID[4], TRACE_MEMORY_PC), hex8(TRACE_VALID[5], TRACE_WRITEBACK_PC));
      if (TRACE_LOAD_STALL) $fwrite(TRACE_FILE, " STALL");
      if (TRACE_FLUSH) $fwrite(TRACE_FILE, " FLUSH");
      if (TRACE_REDIRECT) $fwrite(TRACE_FILE, " REDIRECT");
      if (TRACE_MULTIPLY_DIVIDE_STALL) $fwrite(TRACE_FILE, " BUSY");
      if (TRACE_INSTRUCTION_MISS) $fwrite(TRACE_FILE, " IMISS");
      if (TRACE_DATA_MISS) $fwrite(TRACE_FILE, " DMISS");
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
