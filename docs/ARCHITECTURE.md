# Architecture reference

The complete description of `Riscv64` ([`src/Riscv64.sv`](../src/Riscv64.sv)). For a gentler
introduction read the [learning path](learn/README.md) first.

![block diagram](img/cpu_block_diagram.svg)

## Summary

| property | value |
|---|---|
| instruction set | RV64I + M (multiply/divide) + B (Zba address generation, Zbb bit manipulation, Zbs single-bit) + Zicsr (CSR instructions) + Zknh (SHA-2 hash functions) + `hsec.cteq` (custom-0, constant-time equality; [chapter 10](learn/10_adding_instructions.md)) + machine-mode traps and interrupts (`ecall`, `ebreak`, `mret`, `wfi`): 122 instructions, see [`binary/`](../binary/README.md) |
| traps | `ecall` / `ebreak` save the PC in `mepc` and the cause in `mcause` (11 / 3) and jump to `mtvec`; `mret` returns to `mepc`; `mstatus` MIE/MPIE are saved and restored |
| pipeline | 6 stages, in order, single issue: FETCH1, FETCH2, DECODE, EXECUTE, MEMORY, WRITEBACK |
| data hazards | forwarding **into DECODE** from EXECUTE, MEMORY, WRITEBACK; 1-cycle `LOAD_STALL` |
| branch prediction | tournament: `TournamentChooser` (128-entry per-branch history table + 128-entry chooser) with `GSharePredictor` (2^`GSHARE_HISTORY_BITS` counters, default 6 bits = 64), speculative global history with checkpoint repair; a 16-entry `BranchTargetBuffer` in FETCH1; an 8-entry `ReturnAddressStack` in FETCH2 |
| branch penalties | taken branch or JAL found in the BTB: 0 bubbles; otherwise a FETCH2 redirect: 1; predicted return: 1; wrong guess or unpredicted JALR: 3 (flush) |
| multiply / divide | `IterativeMultiplyDivideUnit`: 64 x 16-bit Wallace-tree steps into a carry-save accumulator ([`Carry_Save_Multiplier.sv`](../src/Carry_Save_Multiplier.sv)), a leading-zero-counter skip for divides, a registered result: multiply 8 cycles, divide 5 + significant bits of the dividend (baseline build: single cycle) |
| clock (logic only) | sky130 130 nm: 4.09 ns, about 244 MHz; ASAP7 7 nm: 0.513 ns, about 1.95 GHz; see [PERFORMANCE.md](PERFORMANCE.md) |
| FPGA | the same core in a small computer (block RAM memory, UART, LEDs, buttons, boot firmware): see [FPGA.md](FPGA.md) |
| builds | performance (default) and baseline (`-DBASELINE`, the plain pipeline); `make test` checks both |
| memory | performance build: `InstructionCache` (4 KiB, 2-way set-associative with LRU replacement, 32-byte lines, next-line prefetch) and `DataCache` (4 KiB, 2-way LRU, next-line prefetch, write-through, no store allocation) in front of a 64 KiB main memory with a 10-cycle line refill; baseline: single-cycle 64 KiB `ScratchpadMemory` |
| reset PC | the `RESET_VECTOR` input: `0x2000` (`PC_RESET` in [`src/const_pkg.sv`](../src/const_pkg.sv)) in simulation; the FPGA system starts its boot firmware at `0x0000` first |
| memory-mapped I/O | 0x1000_0000 .. 0x1000_00FF are device registers, never RAM: `PUTCHAR` (0x00) prints, `LEDS` (0x08), `BUTTONS` (0x10) and the rest on the FPGA ([FPGA.md](FPGA.md#3-how-the-cpu-programs-the-rest-of-the-computer)) |
| program end | write a nonzero value to the `tohost` CSR; the core halts when that instruction reaches WRITEBACK |
| verification | every program, every cycle, RTL vs [`model/core.js`](../model/core.js), predictor on and off (`make test`) |

## Source files

| file | module | stage | role |
|---|---|---|---|
| [`Opcode_pkg.sv`](../src/Opcode_pkg.sv) | `opcode_pkg` | | opcodes and funct3/funct7 codes (RV64I, M, Zicsr) |
| [`ALUop_pkg.sv`](../src/ALUop_pkg.sv) | `alu_op_pkg` | | `alu_op_t` enum (ALU and M operations) |
| [`IMMEDIATEop_pkg.sv`](../src/IMMEDIATEop_pkg.sv) | `immediate_op_pkg` | | immediate formats I S B U J Z |
| [`WRITEBACK_op_pkg.sv`](../src/WRITEBACK_op_pkg.sv) | `writeback_op_pkg` | | writeback sources ALU, MEMORY, PC_ADD_4, CSR |
| [`const_pkg.sv`](../src/const_pkg.sv) | `const_pkg` | | reset PC, memory size, MMIO and CSR addresses |
| [`GShare_Branch_Predictor.sv`](../src/GShare_Branch_Predictor.sv) | `GSharePredictor` | FETCH1 (read), FETCH2 (history), EXECUTE (train/repair) | branch direction prediction |
| [`Control_Unit.sv`](../src/Control_Unit.sv) | `ControlUnit` | DECODE | all control signals from the instruction bits |
| [`ALUdec.sv`](../src/ALUdec.sv) | `ALUdec` | DECODE | opcode + funct3 + funct7 / funct12 to `alu_op_t` (RV64I, M, Zba, Zbb, Zbs), plus the Zba/Zbb operand preparation (shift, zero-extend, invert) |
| [`Immediate_Generator.sv`](../src/Immediate_Generator.sv) | `ImmediateGenerator` | DECODE | builds and sign-extends immediates to 64 bits |
| [`Register_File.sv`](../src/Register_File.sv) | `RegisterFile` | DECODE (read), WRITEBACK (write) | x1..x31, 2 asynchronous reads, 1 synchronous write |
| [`ALU.sv`](../src/ALU.sv) | `ALU` | EXECUTE | shared 65-bit adder, logic, shifts and rotates, 32-bit W variants, Zbb counters and byte operations, Zbs single-bit set / clear / invert / extract (a 6-to-64 decoder in front of the logic gates); a fast output (forwarded) and a full one (2-cycle results) |
| [`Multiply_Divide_Unit.sv`](../src/Multiply_Divide_Unit.sv) | `MultiplyDivideUnit` | EXECUTE | M extension, single cycle (baseline build) |
| [`Iterative_Multiply_Divide_Unit.sv`](../src/Iterative_Multiply_Divide_Unit.sv) | `IterativeMultiplyDivideUnit` | EXECUTE | M extension, one short step per cycle (performance build) |
| [`Carry_Save_Multiplier.sv`](../src/Carry_Save_Multiplier.sv) | `CarrySaveMultiplyStep` | EXECUTE | one 64 x 16-bit multiply step: a Wallace tree of full adders, no carry propagation |
| [`Leading_Zero_Counter.sv`](../src/Leading_Zero_Counter.sv) | `LeadingZeroCounter` | EXECUTE | 64-bit leading-zero count as a 6-level tree (clz, ctz, the divider's skip) |
| [`Population_Count.sv`](../src/Population_Count.sv) | `PopulationCount`, `PopulationCountFinish` | EXECUTE, MEMORY | cpop in two halves: nibble lookups and four 16-bit quarter counts in EXECUTE, the last addition in MEMORY |
| [`Parallel_Prefix_Adder.sv`](../src/Parallel_Prefix_Adder.sv) | `ParallelPrefixAdder` | EXECUTE, FETCH2 | Kogge-Stone adder: carries in log2(n) levels |
| [`Prefix_Negate.sv`](../src/Prefix_Negate.sv) | `PrefixNegate` | EXECUTE | -x without a carry chain |
| [`Branch_Target_Buffer.sv`](../src/Branch_Target_Buffer.sv) | `BranchTargetBuffer` | FETCH1 (read), EXECUTE (write) | zero-bubble taken branches and jumps |
| [`Return_Address_Stack.sv`](../src/Return_Address_Stack.sv) | `ReturnAddressStack` | FETCH2 | predicts `ret` |
| [`Tournament_Chooser.sv`](../src/Tournament_Chooser.sv) | `TournamentChooser` | FETCH1 (read), EXECUTE (train) | per-branch history table + chooser |
| [`Instruction_Cache.sv`](../src/Instruction_Cache.sv) | `InstructionCache` | FETCH1 | 4 KiB, 2-way LRU, next-line prefetch |
| [`Data_Cache.sv`](../src/Data_Cache.sv) | `DataCache` | EXECUTE | 4 KiB, 2-way LRU, write-through |
| [`Branch_Comparator.sv`](../src/Branch_Comparator.sv) | `BranchComparator` | EXECUTE | beq bne blt bge bltu bgeu |
| [`Branch_Control_Unit.sv`](../src/Branch_Control_Unit.sv) | `BranchControl` | EXECUTE | prediction check, `FLUSH`, `ADJUST_NEXT_PC` |
| [`Control_Status_Register_File.sv`](../src/Control_Status_Register_File.sv) | `CSRFile` | EXECUTE | tohost, status, cycle, instret, hartid, and the trap CSRs mstatus, mtvec, mscratch, mepc, mcause |
| [`Store_Control_Unit.sv`](../src/Store_Control_Unit.sv) | `StoreControl` | EXECUTE | byte lanes and write mask for sb sh sw sd |
| [`Load_Control_Unit.sv`](../src/Load_Control_Unit.sv) | `LoadControl` | MEMORY | lane select and extension for all 7 loads |
| [`Write_Control_Unit.sv`](../src/Write_Control_Unit.sv) | `WriteControl` | MEMORY | writeback multiplexer (also the MEMORY forward value) |
| [`Scratchpad_Memory.sv`](../src/Scratchpad_Memory.sv) | `ScratchpadMemory` | FETCH1/EXECUTE | 64 KiB memory and the device page (putchar); simulation only |
| [`Riscv64.sv`](../src/Riscv64.sv) | `Riscv64` | all | the pipeline: registers, hazards, forwarding |
| [`Riscv64_top.sv`](../src/Riscv64_top.sv) | `riscv64_top` | | core + memory (simulation) |

The FPGA computer adds [`fpga/rtl/`](../fpga/rtl): `MainMemory` (block RAM), `UartTransmitter`,
`UartReceiver`, `ByteFifo` and `SixfoldSystem` (devices, reset and boot control); see [FPGA.md](FPGA.md).

## Coding style

The RTL follows one consistent style so it reads like one project:
`` `default_nettype none`` in every file, packages for every encoding, `always_comb` / `always_ff`
/ `unique case`, and long UPPER_CASE signal names that begin with the stage that owns them
(`DECODE_FORWARDED_REGISTER1_DATA`, `EXECUTE_ADJUST_NEXT_PC`), each with a comment saying what it
is. A signal named `STAGE_X` is combinational inside that stage or is that stage's pipeline register.

## Stage by stage

### FETCH1
![front end](img/diagrams/branch_prediction.svg)

`FETCH1_PC` addresses the instruction cache. In the same cycle four tables are read: the
`BranchTargetBuffer` (16 entries, `PC[5:2]` index, `PC[31:6]` tag), the Branch History Table and the
chooser in `TournamentChooser` (128 two-bit counters each, `PC[8:2]`), and the `GSharePredictor`
(`FETCH1_GSHARE_INDEX = FETCH1_PC[7:2] ^ GLOBAL_HISTORY_REGISTER`, 64 counters; the baseline build
uses `PC[5:2]` and 16). The chooser picks gshare or the BHT as `FETCH1_PREDICTED_BRANCH_TAKEN`. The
next PC is chosen by priority: the EXECUTE flush target, the FETCH2 redirect target, the same PC
again on an instruction-cache miss, the BTB target (`HIT && (JAL || TAKEN)`), then `FETCH1_PC + 4`,
which is also registered into `FETCH2_PC_ADD_4` so no later stage needs an incrementer.

### FETCH2
`FETCH2_INSTRUCTION` holds the word (the pipeline register acts as the output register of a
synchronous SRAM). Predecode looks only at the opcode (`OPC_BRANCH`, `OPC_JAL`, `OPC_JALR`) and the
register fields: a call (`rd` = `ra` or `t0`) pushes `FETCH2_PC_ADD_4` on the `ReturnAddressStack`, a
return (`jalr x0, 0(ra)`) pops it and redirects there. The branch and
jump immediates are unscrambled here and `FETCH2_PC_TARGET = FETCH2_PC + imm` is precomputed.
`FETCH2_BRANCH_OFF_OR_CONTINUE` (a JAL, or a branch predicted taken) sends FETCH1 to the target and
marks the instruction currently in FETCH1 invalid. When a branch leaves FETCH2 its predicted
direction is shifted into the global history, and the history value before the shift travels down
the pipeline as `DECODE_GLOBAL_HISTORY_CHECKPOINT`.

### DECODE
`ControlUnit` (with `ALUdec`) and `ImmediateGenerator` decode the instruction; the `RegisterFile` is
read at `[19:15]` and `[24:20]`. Each operand then passes the forwarding chain
x0 > EXECUTE (non-load) > MEMORY > WRITEBACK > register file. The chosen values are what EXECUTE
receives, so EXECUTE has no forwarding muxes on its inputs.

`LOAD_STALL = DECODE_VALID && EXECUTE_VALID && (EXECUTE_MEMORY_READ_ENABLE || EXECUTE_LATE_RESULT) && rd != 0 && (rd == rs1 || rd == rs2)`,
where the performance build only counts a register the instruction really reads (`USES_REGISTER1/2`).

The ALU operands are chosen and prepared here too (`DECODE_ALU_INPUT_A/B`): rs1 or the PC, rs2 or the
immediate, and for Zba/Zbb rs1 shifted left by 1 to 3, the low 32 bits of rs1 zero-extended, or rs2
inverted. Every source except EXECUTE is ready early in the cycle and is prepared then; the value
forwarded from EXECUTE (the ALU output of this same cycle) takes a separate short path and a final 2:1
picks it. See the figure in the README ("Operands and the ALU").

### EXECUTE
![operands and ALU](img/diagrams/operands_and_alu.svg)

The ALU operands arrive straight from registers: DECODE already chose rs1 or the PC
(`EXECUTE_ALU_INPUT_A`) and rs2 or the immediate (`EXECUTE_ALU_INPUT_B`), and decoded the adder's
subtract control (`EXECUTE_ALU_SUBTRACT`), so nothing but the adder sits in front of the result
(PERFORMANCE.md, second round). M instructions use the `IterativeMultiplyDivideUnit` (the
`MultiplyDivideUnit` in the baseline build). The operand registers only hold during a cache miss or
a multiply/divide; a flush does not touch them, because every side effect is gated by
`EXECUTE_VALID`.

The ALU computes every operation in parallel (adder, logic, shifter/rotator, two leading-zero counter
trees, byte operations, population count) and has two outputs: `ALUOutFast`, forwarded to DECODE in the
same cycle, where the adder enters the multiplexer last; and `ALUOut` for the MEMORY stage, which adds
the two results too deep for that loop (`cpop`/`cpopw` and `min`/`minu`/`max`/`maxu`,
`EXECUTE_LATE_RESULT`). Those are forwarded from MEMORY instead, exactly like a load.

![multiply/divide unit](img/diagrams/multiply_divide.svg) `BranchComparator` evaluates the condition and `BranchControl` decides:

| instruction | `FLUSH` | `ADJUST_NEXT_PC` | predictor |
|---|---|---|---|
| branch, guess right | 0 | (unused) | train counter |
| branch, guess wrong | 1 | taken ? target : PC + 4 | train counter, restore history = checkpoint shifted with the real outcome |
| JAL | 0 (already redirected in FETCH2) | target | nothing |
| JALR | 1 | `(rs1 + imm) & ~1` | restore history = checkpoint |

`FLUSH_FETCH1_FETCH2_DECODE` squashes the three younger instructions and puts a bubble into
EXECUTE. The `CSRFile` is read (old value to rd) and written (RW/RS/RC semantics) here. Stores write
memory at the end of this cycle; loads read the aligned doubleword at the end of this cycle.

### MEMORY
![cache](img/diagrams/cache.svg)

`MEMORY_DATA_CACHE_DATA` holds the doubleword (a load that misses waits in EXECUTE for 11 cycles, see
the figure); `LoadControl` selects lanes with address bits [2:0]
and extends. `WriteControl` selects the result by `WRITEBACK_SELECT`; that value is
`MEMORY_FORWARD_DATA` (forwarded to DECODE) and becomes `WRITEBACK_DATA` at the edge.

### WRITEBACK
![performance counters](img/diagrams/performance_counters.svg)

The register file is written at the clock edge and the `instret` counter increments. If this
instruction wrote a nonzero `tohost`, `HALT_NOW` freezes everything else and the testbench prints the
result: `tohost = 1` is PASS, `(n << 1) | 1` is FAIL in test n (the riscv-tests convention).

## Memory map and CSRs

| address / CSR | meaning |
|---|---|
| `0x0000_2000` | reset PC: first instruction |
| `0x0000_0000` to `0x0000_FFFF` | 64 KiB RAM (addresses wrap) |
| `0x1000_0000` | store a byte here to print a character |
| CSR `0x51E` `tohost` | program result (read/write) |
| CSR `0x50A` `status` | scratch register (read/write) |
| CSR `0x50B` `hartid`, `0xF14` `mhartid` | always 0 |
| CSR `0xC00` `cycle` | clock cycles since reset (read-only) |
| CSR `0xC02` `instret` | instructions retired since reset (read-only) |
| CSR `0x300` `mstatus` | bit 3 MIE, bit 7 MPIE |
| CSR `0x305` `mtvec` | trap handler address (direct mode) |
| CSR `0x340` `mscratch` | scratch register for the handler |
| CSR `0x341` `mepc` | address of the instruction that trapped |
| CSR `0x342` `mcause` | 3 = breakpoint, 11 = environment call; with bit 63 set: 7 = machine timer interrupt, 11 = machine external interrupt |
| CSR `0x304` `mie` | interrupt enables: bit 7 MTIE (timer), bit 11 MEIE (external) |
| CSR `0x344` `mip` | interrupts pending (read-only): bit 7 MTIP, bit 11 MEIP, the interrupt lines registered once per cycle |
| CSR `0xC03`..`0xC09` `hpmcounter3..9` | performance counters (read-only): load-stall cycles (L), flushes (F), FETCH2 redirects (R), multiply/divide busy cycles (K), instruction-cache miss cycles (I), data-cache miss cycles (D), interrupts taken (X) |
| device `0x1000_0058` `MTIME`, `0x1000_0060` `MTIMECMP` | the machine timer: MTIME counts cycles; the timer interrupt line is up while MTIME >= MTIMECMP (reset: all ones, never) |

## Interrupts

Two interrupt lines reach the core: the machine timer (MTIME >= MTIMECMP) and an external line (on the FPGA,
the UART's receive queue is not empty). The CSR file registers both every cycle into `mip`. An interrupt is
**requested** when `mstatus.MIE` is 1 and a pending line is enabled in `mie`; the external one wins over the
timer. It is **taken** in DECODE: the instruction there does not go to EXECUTE, and a pseudo-instruction
carrying its PC goes instead. In EXECUTE the pseudo-instruction traps like `ecall` (mepc = that PC, mcause =
the interrupt, MIE saved into MPIE and cleared, jump to mtvec), flushes everything younger, and becomes a
bubble instead of retiring. Everything older finishes normally, so the interrupt is **precise** [58]: after
`mret` the replaced instruction runs as if nothing had happened.

It is not taken while DECODE is stalled or being flushed, or while EXECUTE holds a CSR write, a trap, `mret`
or another interrupt (they may be changing `mstatus` or `mie` in that same cycle). `wfi` is a legal no-op:
the loop around it does the waiting. [`programs/21_timer_interrupts.s`](../programs/21_timer_interrupts.s) is
the example, [`tests/interrupt_stress.s`](../tests/interrupt_stress.s) the stress test, and
[`fpga/examples/interrupt_echo.s`](../fpga/examples/interrupt_echo.s) a program driven only by interrupts.

![An interrupt in the pipeline](img/diagrams/interrupt.svg)

## Timing rules (exact)

| event | bubbles |
|---|---:|
| pipeline fill at reset | 5 |
| `LOAD_STALL` (a load, or a 2-cycle Zbb result: `cpop`, `cpopw`, `min`, `minu`, `max`, `maxu`, needed right away; or a Zbs `bset` / `bclr` / `binv` whose bit number the instruction just before computes) | 1 |
| FETCH2 redirect (predicted-taken branch or JAL not in the BTB, predicted return) | 1 (0 if a flush squashes the redirecting instruction) |
| taken branch or JAL found in the BTB | 0 |
| flush (wrong branch guess, JALR not predicted or predicted wrong, `ecall`, `ebreak`, `mret`) | 3 |
| interrupt (a flush, plus the pseudo-instruction's own slot) | 4 |
| M instruction (performance build) | multiply 7, divide 4 + significant bits of the dividend (EXECUTE held, bubbles into MEMORY) |
| instruction-cache miss | 11 (bubbles into FETCH2; a prefetched line costs 0) |
| data-cache miss (loads) | 11 (the load waits in EXECUTE; stores never wait) |

`cycles = N + 5 + L + 3F + R + K + I + D + X` holds exactly for both builds; see [MATH.md](MATH.md).
