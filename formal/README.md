# Formal verification: proving Sixfold against the RISC-V specification

The regression (`make test`) runs real programs and compares the RTL (register-transfer level) design with the
JavaScript model, cycle by cycle. That catches the bugs those programs happen to reach. Formal verification
asks a different question: **is there any program at all, and any timing of the memory system, that makes the
core do something the specification forbids?** A solver searches every possibility up to a fixed number of
clock cycles. When it finds one, it returns a counterexample: the exact instructions, data and cache
hits and misses that break the rule.

Sixfold uses [riscv-formal](https://github.com/YosysHQ/riscv-formal) (YosysHQ, ISC license), driven by
SymbiYosys and the Bitwuzla solver.

```bash
make formal                      # every check, performance build
make formal ONLY='insn_add_*'    # a subset
make formal-baseline             # the baseline build
make formal-lint                 # Verilator lint of the formal build
```

Results land in `build/formal/<build>/summary.txt`; each failing check leaves a waveform
(`checks/<check>/engine_0/trace.vcd`) you can open in GTKWave.

## How the core talks to the checker

riscv-formal does not look inside the pipeline. The core reports every instruction as it retires, through
the RISC-V Formal Interface (RVFI): `rvfi_valid`, `rvfi_order`, `rvfi_insn`, `rvfi_pc_rdata` /
`rvfi_pc_wdata` (its PC and the PC it hands on), `rvfi_rs1_addr` / `rvfi_rs1_rdata` and the same for rs2
(the source values it really used), `rvfi_rd_addr` / `rvfi_rd_wdata` (what it wrote), `rvfi_mem_*` (the
memory access), and `rvfi_trap`, `rvfi_halt`, `rvfi_intr`, `rvfi_mode`, `rvfi_ixl`.

These ports exist only when `RISCV_FORMAL` is defined (`src/Riscv64.sv`, the block marked "RISC-V Formal
Interface"). The default build, the regression, the FPGA system and anything else that instantiates the core
compile exactly as before. The pipeline does not carry the instruction word, the source values or the memory
access to WRITEBACK, so a shadow copy of them is captured in EXECUTE and travels beside MEMORY and WRITEBACK.

`formal/wrapper.sv` leaves everything outside the core to the solver: every fetched instruction word,
every loaded doubleword, whether each cache access hits or misses, and whether branch prediction is on.

## What is proved

For every instruction sequence that retires within the depths in `formal/checks.cfg`:

| Check | What it proves |
|---|---|
| `insn_*` (one per RV64I and M instruction) | the instruction's result, next PC and memory access match the specification, given the source values it read |
| `reg` | every source value an instruction read is the value the last write to that register left |
| `pc_fwd`, `pc_bwd` | each instruction starts at the PC the previous one handed on: no instruction lost, none run twice, every mispredict recovered |
| `unique` | no two retirements share an order number |
| `causal` | no instruction reads a register before an older instruction has written it |

Together these cover forwarding, the load-use stall, flushes after mispredicts, jumps and traps, the
branch target buffer, the return address stack, cache-miss stalls and multiply/divide stalls.

## What is not proved

- **Anything past the bound.** Reset is held for one cycle; the instruction checks look at an instruction
  retiring at cycle 20, `reg`, `pc_bwd`, `causal` and `unique` check up to cycle 20, and `pc_fwd` up to
  cycle 16 (on the performance build the solver needed 60 s for 12 cycles, 341 s for 14 and 9,022 s for 16,
  and gave no answer for 20 in 13 hours). A bug that needs a longer run is outside them.
- **Multiply and divide arithmetic.** A 64-bit multiplier is too hard for the solver, so the formal build
  replaces each M result with riscv-formal's "alternative operation" (`RISCV_FORMAL_ALTOPS`: rs1 plus or minus
  rs2, XOR a constant). The M unit still runs and still sets the timing, so its stalls and the forwarding of
  its result are checked. The arithmetic itself is covered by the regression.
- **The caches and memory.** The core is checked with a solver-chosen memory. Whether the caches return the
  right data is a separate question.
- **B (Zba, Zbb, Zbs), Zknh and the custom-0 instructions.** They run in the solver's random programs (so
  `reg`, `pc_*`, `unique` and `causal` cover their effect on the pipeline), but their results are not compared
  with a specification yet.
- **Interrupts.** The interrupt lines are held at 0.
- **Branch prediction quality.** Only that every misprediction is recovered.

Two assumptions in `formal/wrapper.sv` narrow the programs, because the formal build (the default
`EXCEPTIONS = 0`) does not raise the exceptions the specification requires for them:

1. no load or store is misaligned (with the default `EXCEPTIONS = 0` the core drops the low address bits instead of trapping);
2. no JAL, branch or JALR targets an address that is not a multiple of 4 (with `EXCEPTIONS = 0` the core jumps instead of trapping).

Both come from the instruction itself, never from what the core reports, so a core that computes a wrong
address is still caught. The core now has those exceptions behind the `EXCEPTIONS` parameter (off by default,
see [docs/COMPLIANCE.md](../docs/COMPLIANCE.md)). The formal build still uses the default, so both assumptions
stay until a proof run with `EXCEPTIONS = 1` and the assumptions removed has been recorded.

A third assumption keeps program memory consistent: two fetches of the same address return the same word
(the wrapper remembers the last 24 fetches, more than the deepest check makes). Without it, the solver
answers two fetches of one PC with two different instructions, which no real memory does. The branch target
buffer relies on this ("the instruction at this PC is a JAL"), so the formal build keeps `ZIFENCEI = 0` and code that
rewrites itself (FENCE.I) is not covered by these proofs; `tests/fence_i.s` covers it in the regression.

## Bugs found

| Date | Check | What happened | Fix |
|---|---|---|---|
| 2026-11-09 | all six `insn_b*`, `insn_jal` | `csrrsi` set mepc bit 1; `mret` then jumped to a PC that is not a multiple of 4, and the next branch's target was misaligned. Without compressed instructions, mepc[1:0] must always read 0. | `src/Control_Status_Register_File.sv` and `model/core.js` clear mepc[1:0] |
| 2026-11-10 | `pc_fwd` | The branch target buffer kept only the low 32 bits of a jump target. A JAL from 0x8bfc0 to 0xffff_ffff_ffff_b73c went to 0xffffb73c the second time, and nothing re-checks a JAL's target. | `src/Branch_Target_Buffer.sv` does not remember targets above 4 GiB |
| 2026-11-10 | `pc_fwd` | An entry written by a jump at 0xffff_ffff_ffff_fffc hit at 0x0000_0000_ffff_fffc (a lookup compares PC bits 31 to 6 only), redirecting an instruction that was not a jump. | entries are written only for jumps below 4 GiB |

Every program the regression runs lives below 4 GiB, so neither buffer fix changes a single cycle there:
`make test` (116 of 116) and `make math` give the same results before and after.

## Is it really checking anything?

A proof can pass because the assumptions accidentally rule out every interesting case. To rule that out, a
copy of the core with a planted bug (DECODE stops taking forwarded values from MEMORY) was run through
`insn_add`: it failed with a six-instruction counterexample (`ld sp, 0(t3)` followed at once by
`add ra, sp, t4`, which wrote 0 instead of the loaded value).

## Results

No complete run of every check has been recorded for the current version yet. The bugs above were found and
fixed during the first runs; the remaining step is a full `make formal` and `make formal-baseline`, whose
`build/formal/<build>/summary.txt` will be summarized here, with the solver times, once they finish.
