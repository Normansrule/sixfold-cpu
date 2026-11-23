# 17. Proving the CPU correct: formal verification

Every chapter so far trusted programs: `make test` runs each program on the RTL (register-transfer
level) design and on the JavaScript model, and compares them every cycle, and chapter 16 added the official
riscv-tests. Both nets only catch the bugs the programs happen to walk into. This chapter adds a second net that does not need programs at all.

## Testing asks "does this work?"; formal asks "can this ever fail?"

A formal tool turns the design and a rule into one big logic equation and hands it to a solver. The solver
answers one of two things:

- **"No sequence of inputs breaks the rule within N cycles."** That is a proof (bounded to N cycles).
- **"This one does."** That is a *counterexample*: the exact instructions, data and timing that break it,
  as a waveform.

Sixfold uses riscv-formal, a set of rules written once for every RISC-V core. The rules are the RISC-V
specification itself, instruction by instruction. To use them, the core has to describe each instruction as
it finishes, through the RISC-V Formal Interface (RVFI).

```bash
make formal ONLY='insn_add_*'    # one instruction's proof, about a minute
make formal                      # all of them
```

## The core describes what it did

When an instruction retires (leaves WRITEBACK), the formal build of Sixfold reports:

| RVFI signal | meaning | where it comes from in `src/Riscv64.sv` |
|---|---|---|
| `rvfi_valid` | an instruction retires this cycle | `WRITEBACK_VALID` |
| `rvfi_insn` | its 32 bits | `EXECUTE_INSTRUCTION`, carried along |
| `rvfi_pc_rdata`, `rvfi_pc_wdata` | its PC, and the PC it hands on | `WRITEBACK_PC`; the next PC worked out in EXECUTE |
| `rvfi_rs1_rdata`, `rvfi_rs2_rdata` | the source values it really used, after forwarding | `EXECUTE_REGISTER1_DATA`, `EXECUTE_REGISTER2_DATA` |
| `rvfi_rd_addr`, `rvfi_rd_wdata` | what it wrote | `WRITEBACK_DESTINATION_REGISTER_ADDRESS`, `WRITEBACK_DATA` |
| `rvfi_mem_*` | the memory access | `dcache_addr`, the store mask, the loaded doubleword |

Look for the block headed "RISC-V Formal Interface". It sits inside `` `ifdef RISCV_FORMAL ``, so the normal
build never sees it. Most of it is a *shadow pipeline*: the instruction word, its source values and its
memory access are captured in EXECUTE and moved to MEMORY and then WRITEBACK on exactly the same clock edges
as the real pipeline registers.

The checker then compares each report with the specification. Take `add`: if `rvfi_insn` is an `add`,
`rvfi_rd_wdata` must equal `rvfi_rs1_rdata + rvfi_rs2_rdata`, and `rvfi_pc_wdata` must be `rvfi_pc_rdata + 4`.
Other checks tie the reports together. `reg`: the value an instruction read is the value the last write to
that register left. `pc_fwd`: each instruction starts where the previous one said the next one would start.

Notice what this catches. Suppose forwarding is broken, so the ALU gets a stale value. The core still
reports the right source value (that comes from the forwarding multiplexer), but the result is wrong, and
the `add` check fails. Suppose a mispredicted branch is not flushed. The wrong-path instruction retires at
a PC nobody handed on, and `pc_fwd` fails.

## Everything else is up to the solver

`formal/wrapper.sv` connects the core to nothing. Every instruction word fetched, every doubleword loaded,
every cache hit or miss and the predictor switch are free choices for the solver. It looks for *any*
combination that breaks a rule. Making sure that is not vacuous matters: a proof can also pass because the
rules accidentally rule out every interesting case. So we planted a bug: DECODE stopped taking forwarded
values from MEMORY. The `add` check failed with this program, found by the solver:

```text
jalr t0, 0x718(tp)    # get somewhere
ld   sp, 0(t3)        # load a value into sp (x2)
add  ra, sp, t4       # use it at once: the load stall holds add one cycle, then sp comes from MEMORY
```

The core reported `rs1 = 0x04a6a04677d838f6` and wrote `ra = 0`. Six instructions, found without anyone
writing a test.

## Three real bugs

The first full run on the real design found these. Each one is a short counterexample, and each fix is a
line or two.

**1. `mret` to a misaligned address.** Without compressed instructions, every instruction address is a
multiple of 4, so the low two bits of mepc (where `mret` returns) must always read 0. Sixfold cleared only
bit 0. The solver found `csrrsi s1, mepc, 11` (setting bits 0, 1 and 3) followed by `mret`, which jumped to
0xa. Fix: `src/Control_Status_Register_File.sv` (and the model) clear bits 1 and 0.

**2. A jump target cut to 32 bits.** The branch target buffer (BTB, chapter 5) remembers where a JAL went, but
only the low 32 bits of the target. The solver jumped from 0x8bfc0 back to 0xffff_ffff_ffff_b73c. The
second time round, FETCH1 followed the BTB to 0xffffb73c, and nothing later checks a JAL's target.
Fix: a target that does not fit in 32 bits is not remembered.

**3. Two addresses, one BTB entry.** A lookup compares PC bits 31 to 6 and requires the top 32 bits to be 0.
But an entry could be *written* by a jump at 0xffff_ffff_ffff_fffc, and it then hit at 0x0000_0000_ffff_fffc,
a different instruction. Fix: only jumps below 4 GiB write entries.

Neither the regression nor the official riscv-tests of chapter 16 could have found these: every test program
lives in the first few kilobytes of memory. After the fixes, the regression, the cycle equation and the FPGA simulation give exactly the same
results as before.

## What the proof does not say

Be as precise about the limits as about the result (`formal/README.md` lists them all):

- **Bounded.** Each instruction check looks at an instruction retiring 20 cycles after reset; `pc_fwd` stops
  at 16 cycles, because the solver's time grows fast with depth (60 seconds for 12 cycles, 341 for 14,
  9,022 for 16). A bug that needs a longer run is outside them.
- **Multiply and divide arithmetic is replaced.** A 64-bit multiplier is too hard for the solver, so in the
  formal build an M instruction's result is a cheap stand-in (`RISCV_FORMAL_ALTOPS`). The stalls and the
  forwarding of the result are still checked; the arithmetic is the regression's job.
- **Assumed, not proved:** no misaligned loads or stores, and no jumps to addresses that are not a multiple of
  4. The specification says those must trap, and Sixfold does not trap yet. Program memory is assumed not to
  change while the program runs (the BTB relies on that).
- **Not compared with a specification yet:** B, Zknh and the custom instructions, interrupts, the caches.

## Try it

1. Run one proof: `make formal ONLY='insn_sub_*'`.
2. Break forwarding the way the planted bug did (in `DECODE_EARLY_REGISTER1_DATA`, replace the MEMORY line's
   condition with `1'b0`), and run `make formal ONLY='insn_add_*'` again. Open the waveform it names in GTKWave
   and find the load and the `add`.
3. Undo the change, and run `make test` to see that the regression agrees.

Next steps for Sixfold build on this: the exceptions that would remove the two assumptions, the architectural
compliance tests (riscv-arch-test, [COMPLIANCE.md](../COMPLIANCE.md)), and lock-step comparison with Spike, the
reference RISC-V simulator.
