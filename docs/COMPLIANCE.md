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
   (the bit-manipulation extensions). The tests start, pass and fail through Sixfold's own environment
   header, [tests/riscv-tests/env/riscv_test.h](../tests/riscv-tests/env/riscv_test.h): machine mode,
   code at the reset vector `0x2000`, PASS as `1` written to the TOHOST control and status register (CSR),
   FAIL as `(test number << 1) | 1`, any unexpected trap as a failure of test 1337.
3. Runs every test through `tools/test.mjs --images`: the model and the RTL of every build, branch predictor
   on and off, with the same cycle-by-cycle comparison as the regression.
4. Checks the cycle equation of [MATH.md](MATH.md) on every test and every build.

### Results

Measured with `make riscv-tests` on 22 November 2026, riscv-tests commit `3df703c`:

| Suite | What it covers | Tests | Runs (6 configurations x predictor on/off) | Passed | RTL cycle-exact |
|---|---|---|---|---|---|
| `rv64ui` | base integer instructions, loads, stores, branches, `fence.i` | 53 | 636 | 636 | 636 |
| `rv64um` | multiply, divide, remainder | 13 | 156 | 156 | 156 |
| `rv64uzba` | address generation (`sh1add`, `add.uw`, ...) | 8 | 96 | 96 | 96 |
| `rv64uzbb` | basic bit manipulation (`clz`, `cpop`, `rev8`, `orc.b`, rotates, ...) | 24 | 288 | 288 | 288 |
| `rv64uzbs` | single-bit instructions (`bset`, `bclr`, `binv`, `bext`) | 8 | 96 | 96 | 96 |
| **Total** | | **106** | **1,272** | **1,272** | **1,272** |

The six configurations are the performance, baseline, turbo, deep-pipeline and compact builds, plus the
performance build with the packed instructions switched off (the setting HYDRA-130 uses). The cycle
equation of [MATH.md](MATH.md) holds exactly on all **1,060** test/build/predictor runs it covers (the five
builds, both predictor settings).

Total cycles for all 106 tests, as one measure of how the builds compare on short, branch-dense code:

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
| `rv64ui-ma_data` | Misaligned loads and stores. The specification lets a core either perform them in hardware or raise an address-misaligned exception. Sixfold does neither: it quietly accesses the aligned address. This is a real gap, listed below. |

No test of an extension Sixfold implements was left out for any other reason, and none failed.

## What is still missing

riscv-tests checks that each instruction computes the right result. It does not check the parts of the
privileged architecture Sixfold leaves out. These are the known gaps, measured against the specification,
and the order to close them in:

| Gap | Today | Needed for |
|---|---|---|
| Illegal-instruction exception | an unknown encoding runs as a no-operation | `rv64mi-illegal`, any operating system |
| Address-misaligned exceptions | the access is aligned down silently | `rv64ui-ma_data`, `rv64mi-ma_addr` |
| `mtval` (the faulting address or instruction) | not implemented | trap handlers that report what went wrong |
| Unknown CSRs and writes to read-only CSRs raise an illegal-instruction exception | reads give 0, writes are ignored | `rv64mi-csr` |
| `misa` reports the extensions | reads 0 (legal: it means "not reported") | software that asks the core what it supports |
| Supervisor and user modes, Sv39 virtual memory | machine mode only | xv6 and Linux |

## Next

1. **riscv-arch-test with RISCOF (RISC-V Compatibility Framework)**: the official architectural tests compare a memory *signature* written by
   the test against the Sail reference model, instead of trusting the test's own checks. Needs a signature
   dump in the testbench and a RISCOF plugin for Sixfold.
2. **riscv-formal**: in the repository now. A RISC-V Formal Interface (RVFI) trace port on the core (`make formal`,
   [formal/README.md](../formal/README.md), [chapter 17](learn/17_formal_verification.md)) lets SymbiYosys prove each
   instruction correct for *every* input up to a bounded depth. A full recorded run of every check is still to come.
3. The gaps above, starting with the illegal-instruction exception, behind a parameter so HYDRA-130's build
   does not change.
