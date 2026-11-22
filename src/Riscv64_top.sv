`default_nettype none

import const_pkg::*;

// riscv64_top: the whole "chip" for simulation: the Riscv64 core wired to its Scratchpad Memory
module riscv64_top #(
  parameter int GSHARE_HISTORY_BITS = 6,
  parameter bit BTB_ENABLE = 1'b1,
  parameter bit RAS_ENABLE = 1'b1,
  parameter bit PRECISE_LOAD_STALL = 1'b1,
  parameter bit ITERATIVE_MULTIPLY_DIVIDE = 1'b1,
  parameter bit TOURNAMENT_PREDICTOR = 1'b1,
  parameter bit CACHES_ENABLE = 1'b1,
  parameter int MISS_LATENCY = 10,
  parameter int CACHE_SETS = 64, // sets per way in each cache (64: 4 KiB each; 16: 1 KiB, the compact build)
  parameter bit FAST_MULTIPLY_DIVIDE = 1'b0, // turbo edition: FastMultiplyDivideUnit
  parameter bit FAST_INSTRUCTION_PREFETCH = 1'b0, // turbo edition: the instruction cache keeps the next line of the fetch stream
  parameter bit FAST_ALU = 1'b0, // turbo edition: the ALU result select is decoded in DECODE; clz / ctz are late results
  parameter bit FAST_FETCH_TARGET = 1'b0, // turbo edition: two FETCH2 target adders, no immediate mux in front of them
  parameter bit FAST_STALL = 1'b0, // turbo edition: the DECODE hazard checks are decoded and compared one cycle ahead
  parameter bit FAST_LOAD_ALIGN = 1'b0, // turbo edition: a load's byte lanes are decoded in EXECUTE
  parameter bit LATE_BRANCH_RESOLVE = 1'b0, // turbo edition: branches and JALR redirect from MEMORY (a shorter clock, 1 more bubble)
  parameter bit ZIFENCEI = 1'b0, // FENCE.I: flush, then empty the instruction cache and the BTB
  parameter bit XCOMPUTE = 1'b0, // the packed compute instructions (paddus.b ... pmulhrs.h, src/Custom_Unit.sv)
  parameter bit SRAM_CACHES = 1'b0 // silicon: cache lines in SRAM macros (sram22), same cycle count (docs/SILICON.md)
) (
  input  logic        clk,
  input  logic        reset,
  input  logic        BRANCH_PREDICTION_ENABLE,
  output logic [63:0] csr,
  output logic        HALTED,
  input  logic [4:0]  DEBUG_REGISTER_ADDRESS,
  output logic [63:0] DEBUG_REGISTER_DATA,
  output logic [5:0]  TRACE_VALID,
  output logic [63:0] TRACE_FETCH1_PC, TRACE_FETCH2_PC, TRACE_DECODE_PC, TRACE_EXECUTE_PC, TRACE_MEMORY_PC, TRACE_WRITEBACK_PC,
  output logic        TRACE_LOAD_STALL, TRACE_FLUSH, TRACE_REDIRECT, TRACE_MULTIPLY_DIVIDE_STALL,
  output logic        TRACE_INSTRUCTION_MISS, TRACE_DATA_MISS
);

  logic [63:0] dcache_addr; // From cpu of Riscv64
  logic [63:0] dcache_din;  // From cpu of Riscv64
  logic [63:0] dcache_dout; // From mem of ScratchpadMemory
  logic [7:0]  dcache_we;   // From cpu of Riscv64
  logic [63:0] icache_addr; // From cpu of Riscv64
  logic [31:0] icache_dout; // To cpu: the instruction at icache_addr
  logic        icache_hit;  // To cpu: 0 = the instruction cache is refilling
  logic        icache_invalidate; // From cpu: FENCE.I empties the instruction cache at this clock edge
  logic        dcache_re;   // From cpu: a load is in Execute
  logic        dcache_hit;  // To cpu: 0 = the load in Execute must wait for its line
  logic        HALT_FREEZE; // The core has halted: caches stop too
  logic [31:0] MEMORY_INSTRUCTION; // Main memory ports
  logic [63:0] MEMORY_DATA, INSTRUCTION_REFILL_ADDRESS, DATA_REFILL_ADDRESS;
  logic [255:0] INSTRUCTION_REFILL_LINE, DATA_REFILL_LINE;
  logic [63:0] CACHE_DATA;
  logic        icache_capture, dcache_capture; // SRAM_CACHES: from cpu, the edges its FETCH2 / MEMORY data registers load
  logic [31:0] icache_dout_late;              // SRAM_CACHES: to cpu, what those registers hold
  logic [63:0] dcache_dout_late, CACHE_DATA_LATE;

  // ===== The machine timer (memory-mapped, like the timer in every RISC-V system) =====
  // MTIME counts clock cycles from reset; a store sets MTIMECMP; the timer interrupt line is up while
  // MTIME >= MTIMECMP. Loads of 0x1000_0058 / 0x1000_0060 read them; every other device address reads 0.
  logic [63:0] MACHINE_TIME, MACHINE_TIME_COMPARE, DEVICE_DATA;
  logic IS_DEVICE;
  assign IS_DEVICE = (dcache_addr[63:8] == MMIO_BASE[63:8]);
  always_ff @(posedge clk) begin
    if (reset) begin
      MACHINE_TIME <= 64'd0;
      MACHINE_TIME_COMPARE <= 64'hFFFF_FFFF_FFFF_FFFF; // no interrupt until software sets it
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
    else DEVICE_DATA = MEMORY_DATA; // the scratchpad answers 0 for the rest of the device page
  end
  logic TIMER_INTERRUPT_LINE;
  assign TIMER_INTERRUPT_LINE = (MACHINE_TIME >= MACHINE_TIME_COMPARE);

  // Main memory (with the caches) or the single-cycle scratchpad (without)
  ScratchpadMemory mem (
    .clk                        (clk),
    .INSTRUCTION_ADDRESS        (icache_addr),
    .INSTRUCTION_DATA           (MEMORY_INSTRUCTION),
    .DATA_ADDRESS               (dcache_addr),
    .DATA_WRITE_MASK            (dcache_we),
    .DATA_WRITE_DATA            (dcache_din),
    .DATA_READ_DATA             (MEMORY_DATA),
    .INSTRUCTION_REFILL_ADDRESS (INSTRUCTION_REFILL_ADDRESS),
    .INSTRUCTION_REFILL_LINE    (INSTRUCTION_REFILL_LINE),
    .DATA_REFILL_ADDRESS        (DATA_REFILL_ADDRESS),
    .DATA_REFILL_LINE           (DATA_REFILL_LINE)
  );
  assign HALT_FREEZE = HALTED;

  generate
    if (CACHES_ENABLE) begin : caches
      InstructionCache #(.MISS_LATENCY(MISS_LATENCY), .SETS(CACHE_SETS), .STREAM_PREFETCH(FAST_INSTRUCTION_PREFETCH), .SRAM_ARRAYS(SRAM_CACHES)) instruction_cache (
        .clk (clk), .reset (reset || icache_invalidate), .FREEZE (HALT_FREEZE),
        .FETCH_ADDRESS (icache_addr), .INSTRUCTION (icache_dout), .HIT (icache_hit),
        .REFILL_ADDRESS (INSTRUCTION_REFILL_ADDRESS), .REFILL_LINE (INSTRUCTION_REFILL_LINE),
        .CAPTURE (icache_capture), .INSTRUCTION_LATE (icache_dout_late)
      );
      DataCache #(.MISS_LATENCY(MISS_LATENCY), .SETS(CACHE_SETS), .SRAM_ARRAYS(SRAM_CACHES)) data_cache (
        .clk (clk), .reset (reset), .FREEZE (HALT_FREEZE),
        .LOAD_REQUEST (dcache_re), .ADDRESS (dcache_addr), .WRITE_MASK (dcache_we), .WRITE_DATA (dcache_din),
        .READ_DATA (CACHE_DATA), .HIT (dcache_hit),
        .REFILL_ADDRESS (DATA_REFILL_ADDRESS), .REFILL_LINE (DATA_REFILL_LINE),
        .CAPTURE (dcache_capture), .READ_DATA_LATE (CACHE_DATA_LATE)
      );
      // Memory-mapped I/O is not cached: loads from a device address take the device's answer (0 here)
      assign dcache_dout = IS_DEVICE ? DEVICE_DATA : CACHE_DATA;
      // SRAM_CACHES: the device answer is captured at the same edge as the SRAM read, like the core's register
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
    end else begin : no_caches
      assign icache_dout = MEMORY_INSTRUCTION;
      assign icache_dout_late = 32'd0; // (no SRAM without caches)
      assign dcache_dout_late = 64'd0;
      assign icache_hit = 1'b1;
      assign dcache_dout = IS_DEVICE ? DEVICE_DATA : MEMORY_DATA;
      assign dcache_hit = 1'b1;
      assign INSTRUCTION_REFILL_ADDRESS = 64'd0;
      assign DATA_REFILL_ADDRESS = 64'd0;
    end
  endgenerate

  // RISC-V 64 CPU
  Riscv64 #(
    .GSHARE_HISTORY_BITS (GSHARE_HISTORY_BITS),
    .BTB_ENABLE (BTB_ENABLE),
    .RAS_ENABLE (RAS_ENABLE),
    .PRECISE_LOAD_STALL (PRECISE_LOAD_STALL),
    .ITERATIVE_MULTIPLY_DIVIDE (ITERATIVE_MULTIPLY_DIVIDE),
    .TOURNAMENT_PREDICTOR (TOURNAMENT_PREDICTOR),
    .FAST_MULTIPLY_DIVIDE (FAST_MULTIPLY_DIVIDE),
    .FAST_ALU (FAST_ALU),
    .FAST_FETCH_TARGET (FAST_FETCH_TARGET),
    .FAST_STALL (FAST_STALL),
    .FAST_LOAD_ALIGN (FAST_LOAD_ALIGN),
    .LATE_BRANCH_RESOLVE (LATE_BRANCH_RESOLVE),
    .ZIFENCEI (ZIFENCEI),
    .XCOMPUTE (XCOMPUTE),
    .SRAM_CACHES (SRAM_CACHES && CACHES_ENABLE)
  ) cpu (
    .clk                      (clk),
    .reset                    (reset),
    .BRANCH_PREDICTION_ENABLE (BRANCH_PREDICTION_ENABLE),
    .RESET_VECTOR             (PC_RESET),
    .TIMER_INTERRUPT_LINE     (TIMER_INTERRUPT_LINE),
    .EXTERNAL_INTERRUPT_LINE  (1'b0),
    .dcache_addr              (dcache_addr),
    .icache_addr              (icache_addr),
    .dcache_we                (dcache_we),
    .dcache_din               (dcache_din),
    .dcache_dout              (dcache_dout),
    .icache_dout              (icache_dout),
    .icache_hit               (icache_hit),
    .icache_invalidate        (icache_invalidate),
    .dcache_re                (dcache_re),
    .dcache_hit               (dcache_hit),
    .icache_capture           (icache_capture),
    .dcache_capture           (dcache_capture),
    .icache_dout_late         (icache_dout_late),
    .dcache_dout_late         (dcache_dout_late),
    .csr                      (csr),
    .HALTED                   (HALTED),
    .DEBUG_REGISTER_ADDRESS   (DEBUG_REGISTER_ADDRESS),
    .DEBUG_REGISTER_DATA      (DEBUG_REGISTER_DATA),
    .TRACE_VALID              (TRACE_VALID),
    .TRACE_FETCH1_PC          (TRACE_FETCH1_PC),
    .TRACE_FETCH2_PC          (TRACE_FETCH2_PC),
    .TRACE_DECODE_PC          (TRACE_DECODE_PC),
    .TRACE_EXECUTE_PC         (TRACE_EXECUTE_PC),
    .TRACE_MEMORY_PC          (TRACE_MEMORY_PC),
    .TRACE_WRITEBACK_PC       (TRACE_WRITEBACK_PC),
    .TRACE_LOAD_STALL         (TRACE_LOAD_STALL),
    .TRACE_FLUSH              (TRACE_FLUSH),
    .TRACE_REDIRECT           (TRACE_REDIRECT),
    .TRACE_MULTIPLY_DIVIDE_STALL (TRACE_MULTIPLY_DIVIDE_STALL),
    .TRACE_INSTRUCTION_MISS (TRACE_INSTRUCTION_MISS),
    .TRACE_DATA_MISS (TRACE_DATA_MISS)
  );

endmodule

`default_nettype wire
