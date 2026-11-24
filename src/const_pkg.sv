`default_nettype none

/* Global design constants. */

package const_pkg;

  // -----------------------------
  // CPU parameters (RV64: every register and address is 64 bits, instructions stay 32 bits)
  // -----------------------------
  localparam int XLEN           = 64;
  localparam int CPU_ADDR_BITS  = 64;
  localparam int CPU_INST_BITS  = 32;
  localparam int CPU_DATA_BITS  = 64;

  // -----------------------------
  // Main memory (behind the instruction and data caches in the performance build)
  // -----------------------------
  localparam int MEMORY_BYTES      = 65536;                    // 64 KiB unified instruction + data memory
  // Memory-mapped input/output: the 256 bytes at 0x1000_0000 are devices, not memory (never written to RAM)
  localparam logic [63:0] MMIO_BASE    = 64'h0000_0000_1000_0000; // 0x1000_0000 .. 0x1000_00FF
  localparam logic [63:0] MMIO_PUTCHAR = 64'h0000_0000_1000_0000; // store: print one character (the FPGA's UART)
  localparam logic [63:0] MMIO_LEDS    = 64'h0000_0000_1000_0008; // store: the 8 LEDs (low byte); load: what was stored
  localparam logic [63:0] MMIO_BUTTONS = 64'h0000_0000_1000_0010; // load: the board's buttons / switches (0 in simulation)
  localparam logic [63:0] MMIO_MTIME    = 64'h0000_0000_1000_0058; // load: the machine timer (counts clock cycles)
  localparam logic [63:0] MMIO_MTIMECMP = 64'h0000_0000_1000_0060; // load / store: timer interrupt when mtime >= mtimecmp

  // -----------------------------
  // PC address on reset
  // -----------------------------
  localparam logic [63:0] PC_RESET = 64'h0000_0000_0000_2000;

  // -----------------------------
  // NOP instruction
  // Depends on opcode_pkg definitions
  // -----------------------------
  localparam logic [31:0] INSTR_NOP =
      {12'd0, 5'd0, opcode_pkg::FNC_ADD_SUB, 5'd0, opcode_pkg::OPC_ARI_ITYPE};

  // -----------------------------
  // CSR addresses
  // -----------------------------
  localparam logic [11:0] CSR_TOHOST  = 12'h51E; // Write 1 = PASS, (n << 1) | 1 = FAIL test n (riscv-tests convention)
  localparam logic [11:0] CSR_HARTID  = 12'h50B;
  localparam logic [11:0] CSR_STATUS  = 12'h50A;
  // ===============================================
  // Standard read-only performance counters (programs can measure their own CPI):
  localparam logic [11:0] CSR_CYCLE   = 12'hC00; // rdcycle   : clock cycles since reset
  localparam logic [11:0] CSR_INSTRET = 12'hC02; // rdinstret : instructions retired since reset
  localparam logic [11:0] CSR_MHARTID = 12'hF14; // Machine Hardware Thread ID (always 0 on this single core)
  // Hardware performance counters (read-only): one per term of the cycle equation in docs/MATH.md,
  //   cycles = N + 5 + L + 3F + R + K + I + D   (N = instret)
  localparam logic [11:0] CSR_HPMCOUNTER3 = 12'hC03; // L: load-stall cycles (loads and 2-cycle Zbb results)
  localparam logic [11:0] CSR_HPMCOUNTER4 = 12'hC04; // F: flushes (wrong branch guesses, JALR misses, traps)
  localparam logic [11:0] CSR_HPMCOUNTER5 = 12'hC05; // R: FETCH2 redirects
  localparam logic [11:0] CSR_HPMCOUNTER6 = 12'hC06; // K: cycles the multiply/divide unit holds EXECUTE
  localparam logic [11:0] CSR_HPMCOUNTER7 = 12'hC07; // I: instruction-cache miss cycles
  localparam logic [11:0] CSR_HPMCOUNTER8 = 12'hC08; // D: data-cache miss cycles
  localparam logic [11:0] CSR_HPMCOUNTER9 = 12'hC09; // X: interrupts taken (each costs one bubble more than a flush)
  localparam logic [11:0] CSR_HPMCOUNTER10 = 12'hC0A; // B: instructions a late branch flush removed from EXECUTE (LATE_BRANCH_RESOLVE, else 0)
  // ===============================================
  // Machine-mode trap CSRs (RISC-V privileged specification):
  localparam logic [11:0] CSR_MSTATUS  = 12'h300; // bit 3 MIE (interrupts enabled), bit 7 MPIE (MIE before the trap)
  localparam logic [11:0] CSR_MTVEC    = 12'h305; // trap handler address (direct mode: low 2 bits ignored)
  localparam logic [11:0] CSR_MSCRATCH = 12'h340; // free register for the handler
  localparam logic [11:0] CSR_MEPC     = 12'h341; // address of the instruction that trapped
  localparam logic [11:0] CSR_MCAUSE   = 12'h342; // why: 3 = breakpoint (ebreak), 11 = environment call (ecall)
  localparam logic [11:0] CSR_MIE      = 12'h304; // interrupt enables: bit 7 MTIE (timer), bit 11 MEIE (external)
  localparam logic [11:0] CSR_MIP      = 12'h344; // interrupts pending (read-only here): bit 7 MTIP, bit 11 MEIP
  localparam logic [11:0] CSR_MTVAL    = 12'h343; // EXCEPTIONS = 1: the bad address or instruction word of the last exception
  localparam logic [63:0] CAUSE_MISALIGNED_FETCH = 64'd0; // EXCEPTIONS = 1: a jump or branch to an address that is not a multiple of 4
  localparam logic [63:0] CAUSE_ILLEGAL_INSTRUCTION = 64'd2; // EXCEPTIONS = 1: an encoding Sixfold does not implement
  localparam logic [63:0] CAUSE_MISALIGNED_LOAD = 64'd4; // EXCEPTIONS = 1: a load whose address is not a multiple of its size
  localparam logic [63:0] CAUSE_MISALIGNED_STORE = 64'd6; // EXCEPTIONS = 1: the same for a store
  localparam logic [63:0] CAUSE_BREAKPOINT = 64'd3;
  localparam logic [63:0] CAUSE_ENVIRONMENT_CALL = 64'd11;
  localparam logic [63:0] CAUSE_MACHINE_TIMER_INTERRUPT = 64'h8000_0000_0000_0007;    // bit 63 = an interrupt, not an exception
  localparam logic [63:0] CAUSE_MACHINE_EXTERNAL_INTERRUPT = 64'h8000_0000_0000_000B;
  // ===============================================

endpackage : const_pkg

`default_nettype wire
