`default_nettype none

import const_pkg::*;

// =====================================================================================================
// Sixfold_Silicon: the block that is placed and routed on sky130 (asic/flow.sh)
//
// The turbo edition's core with both caches, their lines in 32 sram22 SRAM macros (SRAM_CACHES = 1), and the
// machine timer. Main memory is outside the block: the pins are the two refill ports (a 64-bit line address
// out, a 256-bit line in, after MISS_LATENCY cycles) and the write-through store port. On a full chip these
// pins would go to a memory controller or to the pads; here they are the edges of the hardened block.
// Simulation of the same core and caches: riscv64_top with SRAM_CACHES (node tools/test.mjs --sram).
// =====================================================================================================
module Sixfold_Silicon (
  input  logic         clk,
  input  logic         reset,
  input  logic         BRANCH_PREDICTION_ENABLE,
  input  logic [63:0]  RESET_VECTOR,
  input  logic         EXTERNAL_INTERRUPT_LINE,
  // instruction cache refill
  output logic [63:0]  INSTRUCTION_REFILL_ADDRESS,
  input  logic [255:0] INSTRUCTION_REFILL_LINE,
  // data cache refill
  output logic [63:0]  DATA_REFILL_ADDRESS,
  input  logic [255:0] DATA_REFILL_LINE,
  // stores (write-through) and device loads
  output logic [63:0]  DATA_ADDRESS,
  output logic [7:0]   DATA_WRITE_MASK,
  output logic [63:0]  DATA_WRITE_DATA,
  input  logic [63:0]  DEVICE_READ_DATA, // what a device outside the block answers at DATA_ADDRESS
  // status
  output logic [63:0]  TOHOST,
  output logic         HALTED
);
  logic [63:0] icache_addr, dcache_addr, dcache_dout_late, CACHE_DATA_LATE, CACHE_DATA, MACHINE_TIME, MACHINE_TIME_COMPARE, DEVICE_DATA;
  logic [31:0] icache_dout, icache_dout_late;
  logic icache_hit, dcache_hit, dcache_re, icache_capture, dcache_capture, IS_DEVICE, TIMER_INTERRUPT_LINE;
  logic [7:0] dcache_we;
  logic [63:0] dcache_din;
  assign DATA_ADDRESS = dcache_addr;
  assign DATA_WRITE_MASK = dcache_we;
  assign DATA_WRITE_DATA = dcache_din;

  // the machine timer, as in riscv64_top
  assign IS_DEVICE = (dcache_addr[63:8] == MMIO_BASE[63:8]);
  always_ff @(posedge clk) begin
    if (reset) begin
      MACHINE_TIME <= 64'd0;
      MACHINE_TIME_COMPARE <= 64'hFFFF_FFFF_FFFF_FFFF;
    end else begin
      MACHINE_TIME <= MACHINE_TIME + 64'd1;
      if (dcache_addr == MMIO_MTIMECMP)
        for (int BYTE_LANE = 0; BYTE_LANE < 8; BYTE_LANE = BYTE_LANE + 1)
          if (dcache_we[BYTE_LANE]) MACHINE_TIME_COMPARE[8*BYTE_LANE +: 8] <= dcache_din[8*BYTE_LANE +: 8];
    end
  end
  always_comb begin
    if (dcache_addr == MMIO_MTIME) DEVICE_DATA = MACHINE_TIME;
    else if (dcache_addr == MMIO_MTIMECMP) DEVICE_DATA = MACHINE_TIME_COMPARE;
    else DEVICE_DATA = DEVICE_READ_DATA;
  end
  assign TIMER_INTERRUPT_LINE = (MACHINE_TIME >= MACHINE_TIME_COMPARE);

  logic icache_invalidate; // fence.i empties the instruction cache (always 0 here: ZIFENCEI is left off)
  InstructionCache #(.MISS_LATENCY(10), .STREAM_PREFETCH(1'b1), .SRAM_ARRAYS(1'b1)) instruction_cache (
    .clk (clk), .reset (reset || icache_invalidate), .FREEZE (HALTED),
    .FETCH_ADDRESS (icache_addr), .INSTRUCTION (icache_dout), .HIT (icache_hit),
    .REFILL_ADDRESS (INSTRUCTION_REFILL_ADDRESS), .REFILL_LINE (INSTRUCTION_REFILL_LINE),
    .CAPTURE (icache_capture), .INSTRUCTION_LATE (icache_dout_late)
  );
  DataCache #(.MISS_LATENCY(10), .SRAM_ARRAYS(1'b1)) data_cache (
    .clk (clk), .reset (reset), .FREEZE (HALTED),
    .LOAD_REQUEST (dcache_re), .ADDRESS (dcache_addr), .WRITE_MASK (dcache_we), .WRITE_DATA (dcache_din),
    .READ_DATA (CACHE_DATA), .HIT (dcache_hit),
    .REFILL_ADDRESS (DATA_REFILL_ADDRESS), .REFILL_LINE (DATA_REFILL_LINE),
    .CAPTURE (dcache_capture), .READ_DATA_LATE (CACHE_DATA_LATE)
  );
  logic IS_DEVICE_LATE;
  logic [63:0] DEVICE_DATA_LATE;
  always_ff @(posedge clk) begin
    if (reset) IS_DEVICE_LATE <= 1'b0;
    else if (dcache_capture) begin
      IS_DEVICE_LATE <= IS_DEVICE;
      DEVICE_DATA_LATE <= DEVICE_DATA;
    end
  end
  assign dcache_dout_late = IS_DEVICE_LATE ? DEVICE_DATA_LATE : CACHE_DATA_LATE;

  logic [63:0] UNUSED_DEBUG_DATA, UNUSED_TRACE_PC [0:5];
  logic [5:0] UNUSED_TRACE_VALID;
  logic [5:0] UNUSED_TRACE_FLAGS;
  Riscv64 #(
    .FAST_MULTIPLY_DIVIDE (1'b1), .FAST_ALU (1'b1), .FAST_FETCH_TARGET (1'b1), .FAST_STALL (1'b1),
    .FAST_LOAD_ALIGN (1'b1), .LATE_BRANCH_RESOLVE (1'b1), .SRAM_CACHES (1'b1)
  ) cpu (
    .clk (clk), .reset (reset), .icache_invalidate (icache_invalidate), .BRANCH_PREDICTION_ENABLE (BRANCH_PREDICTION_ENABLE), .RESET_VECTOR (RESET_VECTOR),
    .TIMER_INTERRUPT_LINE (TIMER_INTERRUPT_LINE), .EXTERNAL_INTERRUPT_LINE (EXTERNAL_INTERRUPT_LINE),
    .dcache_addr (dcache_addr), .icache_addr (icache_addr), .dcache_we (dcache_we), .dcache_din (dcache_din),
    .dcache_dout (64'd0), .icache_dout (32'd0), // (SRAM_CACHES: the core takes the *_late values)
    .icache_hit (icache_hit), .dcache_re (dcache_re), .dcache_hit (dcache_hit),
    .icache_capture (icache_capture), .dcache_capture (dcache_capture),
    .icache_dout_late (icache_dout_late), .dcache_dout_late (dcache_dout_late),
    .csr (TOHOST), .HALTED (HALTED),
    .DEBUG_REGISTER_ADDRESS (5'd0), .DEBUG_REGISTER_DATA (UNUSED_DEBUG_DATA),
    .TRACE_VALID (UNUSED_TRACE_VALID),
    .TRACE_FETCH1_PC (UNUSED_TRACE_PC[0]), .TRACE_FETCH2_PC (UNUSED_TRACE_PC[1]), .TRACE_DECODE_PC (UNUSED_TRACE_PC[2]),
    .TRACE_EXECUTE_PC (UNUSED_TRACE_PC[3]), .TRACE_MEMORY_PC (UNUSED_TRACE_PC[4]), .TRACE_WRITEBACK_PC (UNUSED_TRACE_PC[5]),
    .TRACE_LOAD_STALL (UNUSED_TRACE_FLAGS[0]), .TRACE_FLUSH (UNUSED_TRACE_FLAGS[1]), .TRACE_REDIRECT (UNUSED_TRACE_FLAGS[2]),
    .TRACE_MULTIPLY_DIVIDE_STALL (UNUSED_TRACE_FLAGS[3]), .TRACE_INSTRUCTION_MISS (UNUSED_TRACE_FLAGS[4]),
    .TRACE_DATA_MISS (UNUSED_TRACE_FLAGS[5])
  );
  logic unused;
  assign unused = ^{icache_dout, CACHE_DATA, UNUSED_DEBUG_DATA, UNUSED_TRACE_VALID, UNUSED_TRACE_FLAGS};

endmodule

`default_nettype wire
