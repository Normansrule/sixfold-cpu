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
  parameter int CACHE_SETS = 64 // sets per way in each cache (64: 4 KiB each)
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
  logic        dcache_re;   // From cpu: a load is in Execute
  logic        dcache_hit;  // To cpu: 0 = the load in Execute must wait for its line
  logic        HALT_FREEZE; // The core has halted: caches stop too
  logic [31:0] MEMORY_INSTRUCTION; // Main memory ports
  logic [63:0] MEMORY_DATA, INSTRUCTION_REFILL_ADDRESS, DATA_REFILL_ADDRESS;
  logic [255:0] INSTRUCTION_REFILL_LINE, DATA_REFILL_LINE;
  logic [63:0] CACHE_DATA;

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
      InstructionCache #(.MISS_LATENCY(MISS_LATENCY), .SETS(CACHE_SETS)) instruction_cache (
        .clk (clk), .reset (reset), .FREEZE (HALT_FREEZE),
        .FETCH_ADDRESS (icache_addr), .INSTRUCTION (icache_dout), .HIT (icache_hit),
        .REFILL_ADDRESS (INSTRUCTION_REFILL_ADDRESS), .REFILL_LINE (INSTRUCTION_REFILL_LINE)
      );
      DataCache #(.MISS_LATENCY(MISS_LATENCY), .SETS(CACHE_SETS)) data_cache (
        .clk (clk), .reset (reset), .FREEZE (HALT_FREEZE),
        .LOAD_REQUEST (dcache_re), .ADDRESS (dcache_addr), .WRITE_MASK (dcache_we), .WRITE_DATA (dcache_din),
        .READ_DATA (CACHE_DATA), .HIT (dcache_hit),
        .REFILL_ADDRESS (DATA_REFILL_ADDRESS), .REFILL_LINE (DATA_REFILL_LINE)
      );
      // Memory-mapped I/O is not cached: loads from a device address take the device's answer (0 here)
      assign dcache_dout = IS_DEVICE ? DEVICE_DATA : CACHE_DATA;
    end else begin : no_caches
      assign icache_dout = MEMORY_INSTRUCTION;
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
    .TOURNAMENT_PREDICTOR (TOURNAMENT_PREDICTOR)
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
    .dcache_re                (dcache_re),
    .dcache_hit               (dcache_hit),
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
