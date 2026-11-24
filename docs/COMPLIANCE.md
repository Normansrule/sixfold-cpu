# Compliance: the official RISC-V tests

Sixfold's own regression (`make test`) proves that the RTL (register-transfer level) design and the
JavaScript model agree on every clock cycle. It cannot prove that both are *right*: a misread of the
specification written into both would pass. Compliance testing closes that gap with tests written by other
people, against the specification, before Sixfold existed.

This page records what has been run, the measured results, and what is still missing. Every number on it
comes from `make riscv-tests`.

## riscv-tests

[riscv-tests](https://github.com/riscv-software-src/riscv-tests) is the RISC-V community's
instruction-by-instruction suite (BSD-3-Clause license). Each test is a self-checking program for one
instruction: dozens of cases covering overflow, sign extension, `x0` as a source or destination, and every
forwarding distance (the `TEST_RR_SRC12_BYPASS`, `TEST_RR_SRC21_BYPASS` and `TEST_RR_DEST_BYPASS` cases put 0, 1 and 2 instructions between a result and its
use, which is exactly what Sixfold's forwarding paths must get right).

```bash
cd ~/sixfold-cpu && sudo apt install gcc-riscv64-unknown-elf && make riscv-tests
```

What `make riscv-tests` does ([tools/riscv_tests.mjs](../tools/riscv_tests.mjs)):

1. Fetches the suite at a pinned commit (`3df703c`) into `build/riscv-tests-src`. Nothing from it is copied
   into this repository.
2. Assembles every test of the extensions Sixfold implements with the GNU (GNU's Not Unix) toolchain:
   `rv64ui` (the base integer set), `rv64um` (multiply and divide), `rv64uzba`, `rv64uzbb`, `rv64uzbs`
   (the bit-manipulation extensions), and `rv64mi`, the machine-mode tests of the exceptions (illegal
   instruction, misaligned addresses, `ecall`, `ebreak`). The tests start, pass and fail through Sixfold's own environment
   header, [tests/riscv-tests/env/riscv_test.h](../tests/riscv-tests/env/riscv_test.h): machine mode,
   code at the reset vector `0x2000`, PASS as `1` written to the TOHOST control and status register (CSR),
   FAIL as `(test number << 1) | 1`, any unexpected trap as a failure of test 1337. A test that expects a
   trap brings its own handler (`mtvec_handler`), and the environment passes the trap to it.
3. Runs every test through `tools/test.mjs --images`: the model and the RTL of every build, branch predictor
   on and off, with the same cycle-by-cycle comparison as the regression.
4. Checks the cycle equation of [MATH.md](MATH.md) on every test and every build.

### Results

Measured with `make riscv-tests` on 23 November 2026, riscv-tests commit `3df703c`:

| Suite | What it covers | Tests | Runs (6 configurations x predictor on/off) | Passed | RTL cycle-exact |
|---|---|---|---|---|---|
| `rv64ui` | base integer instructions, loads, stores, branches, `fence.i` | 53 | 636 | 636 | 636 |
| `rv64um` | multiply, divide, remainder | 13 | 156 | 156 | 156 |
| `rv64uzba` | address generation (`sh1add`, `add.uw`, ...) | 8 | 96 | 96 | 96 |
| `rv64uzbb` | basic bit manipulation (`clz`, `cpop`, `rev8`, `orc.b`, rotates, ...) | 24 | 288 | 288 | 288 |
| `rv64uzbs` | single-bit instructions (`bset`, `bclr`, `binv`, `bext`) | 8 | 96 | 96 | 96 |
| `rv64mi` | exceptions: illegal instruction, misaligned loads, stores and jump targets, `ecall`, `ebreak`, `mtval` (4 builds, see below) | 15 | 120 | 120 | 120 |
| **Total** | | **121** | **1,392** | **1,392** | **1,392** |

The six configurations are the performance, baseline, turbo, deep-pipeline and compact builds, plus the
performance build with the packed instructions switched off (the setting HYDRA-130 uses). The `rv64mi` tests
need the exceptions, which exist only with `EXCEPTIONS = 1` (a parameter of `src/Riscv64.sv`, off by default so
HYDRA-130's build does not change): they run on the performance, baseline, turbo and compact test builds, which
switch it on, and not on the HYDRA-130 setting or the deep-pipeline edition. The cycle equation of
[MATH.md](MATH.md) holds exactly on all **1,180** test/build/predictor runs it covers (the five builds, both
predictor settings).

Total cycles for the 106 user-level tests (measured on 22 November 2026; the exceptions do not change them), as one measure of how the builds compare on short, branch-dense code:

| Build | predictor on | predictor off |
|---|---|---|
| baseline | 44,942 | 40,705 |
| performance | 73,686 | 66,237 |
| turbo | 60,023 | 52,122 |
| deep | 98,581 | 71,576 |
| compact | 73,697 | 66,237 |

These tests are tiny and run once, so cold caches dominate: the baseline build, with single-cycle memory
and no caches, is fastest here, and the predictor costs cycles because it has nothing to learn yet. Use
the programs in `programs/` for performance; riscv-tests is for correctness.

### Left out, and why

| Test | Why |
|---|---|
| `rv64ui-ma_data` | Misaligned loads and stores done in hardware. The specification lets a core either perform them or raise an address-misaligned exception. With `EXCEPTIONS = 1` Sixfold raises the exception, which `rv64mi-ma_addr` and the six `rv64mi-*-misaligned` tests check; `ma_data` has no trap handler, so it only fits a core that performs them. (Without `EXCEPTIONS`, Sixfold quietly accesses the aligned address.) |
| `rv64mi-mcsr` | `misa` reporting the extensions. Sixfold reads 0, which the specification allows ("not reported") but this test does not. |
| `rv64mi-pmpaddr` | Physical memory protection (PMP), which Sixfold does not have. |

No test of an extension Sixfold implements was left out for any other reason, and none failed. Some `rv64mi`
tests check a feature only when the core has it and skip that part otherwise (`breakpoint` skips when there
are no debug triggers, `csr` and `scall` skip their user-mode parts): they pass on what Sixfold implements.

## What is still missing

riscv-tests checks that each instruction computes the right result. It does not check the parts of the
privileged architecture Sixfold leaves out. These are the known gaps, measured against the specification,
and the order to close them in:

| Gap | Today | Needed for |
|---|---|---|
| Illegal-instruction detection inside OP and OP-IMM | with `EXCEPTIONS = 1`, an unknown major opcode, a reserved `funct3` of a load, store, branch, JALR or FENCE, and every SYSTEM word except `ecall`, `ebreak`, `mret`, `wfi` and the CSR instructions trap; an unused `funct7` in the arithmetic groups still runs as some operation | a complete decoder |
| A faulting instruction does not count as retired | it counts in `instret`, like `ecall` | exact `minstret` |
| Unknown CSRs and writes to read-only CSRs raise an illegal-instruction exception | reads give 0, writes are ignored | `rv64mi-csr` |
| `misa` reports the extensions | reads 0 (legal: it means "not reported") | `rv64mi-mcsr`, software that asks the core what it supports |
| Supervisor and user modes, Sv39 virtual memory | machine mode only | xv6 and Linux |

## Next

1. **riscv-arch-test with RISCOF (RISC-V Compatibility Framework)**: the official architectural tests compare a memory *signature* written by
   the test against the Sail reference model, instead of trusting the test's own checks. Needs a signature
   dump in the testbench and a RISCOF plugin for Sixfold.
2. **riscv-formal**: in the repository now. A RISC-V Formal Interface (RVFI) trace port on the core (`make formal`,
   [formal/README.md](../formal/README.md), [chapter 17](learn/17_formal_verification.md)) lets SymbiYosys prove each
   instruction correct for *every* input up to a bounded depth. A full recorded run of every check is still to come.
3. ~~The illegal-instruction and address-misaligned exceptions and `mtval`~~: done, behind the `EXCEPTIONS`
   parameter (23 November 2026). Next in that line: unknown CSRs trapping, then `misa`.
