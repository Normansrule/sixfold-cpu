// =============================================================================
// tests/riscv-tests/env/riscv_test.h: Sixfold's test environment for the official riscv-tests suite
//
// riscv-tests (github.com/riscv-software-src/riscv-tests, BSD-3-Clause, fetched by `make riscv-tests`,
// never copied into this repository) writes each test once and leaves "how a test starts, passes and
// fails" to an environment header like this one. Sixfold is a machine-mode-only core with 64 KiB of
// memory and a TOHOST control and status register (CSR) at 0x51E, so this environment:
//   - starts every test in machine mode at 0x2000 (the core's RESET_VECTOR), no virtual memory
//   - points mtvec at a handler that hands a trap to the test's own mtvec_handler when it has one (the
//     machine-mode rv64mi tests do: they check the exception they caused), and otherwise reports the
//     unexpected trap as a failure (test number 1337)
//   - reports PASS by writing 1 to TOHOST and FAIL by writing (test number << 1) | 1, the same
//     convention every program in programs/ and tests/ already uses (tools/test.mjs decodes it)
// =============================================================================
#ifndef SIXFOLD_RISCV_TEST_H
#define SIXFOLD_RISCV_TEST_H

#include "encoding.h" // CAUSE_*, MSTATUS_* ... from riscv-test-env (fetched with the suite by make riscv-tests)

#define TESTNUM gp
#define SIXFOLD_TOHOST 0x51e

// Only user-level instructions are tested here; every test runs in machine mode
#define RVTEST_RV64U .macro init; .endm
#define RVTEST_RV32U RVTEST_RV64U
#define RVTEST_RV64M RVTEST_RV64U

// The test bodies use the first test number to say "no test ran yet"
#define RVTEST_CODE_BEGIN                                               \
        .section .text.init;                                            \
        .align  6;                                                      \
        .globl _start;                                                  \
_start:                                                                 \
        la t0, sixfold_trap;                                            \
        csrw mtvec, t0;                                                 \
        li TESTNUM, 0;                                                  \
        init;                                                           \
        j sixfold_test;                                                 \
        .align 2;                                                       \
sixfold_trap:                                                           \
        .weak mtvec_handler;                                            \
        la t5, mtvec_handler;                                           \
        beqz t5, 2f;                                                    \
        jr t5;                                                          \
2:      li TESTNUM, (1337 << 1) | 1;                                    \
        csrw SIXFOLD_TOHOST, TESTNUM;                                   \
1:      j 1b;                                                           \
sixfold_test:

#define RVTEST_CODE_END                                                 \
1:      j 1b;

#define RVTEST_PASS                                                     \
        fence;                                                          \
        li TESTNUM, 1;                                                  \
        csrw SIXFOLD_TOHOST, TESTNUM;                                   \
1:      j 1b;

#define RVTEST_FAIL                                                     \
        fence;                                                          \
1:      beqz TESTNUM, 1b;                                               \
        sll TESTNUM, TESTNUM, 1;                                        \
        or TESTNUM, TESTNUM, 1;                                         \
        csrw SIXFOLD_TOHOST, TESTNUM;                                   \
1:      j 1b;

#define EXTRA_DATA
#define RVTEST_DATA_BEGIN EXTRA_DATA .align 4; .global begin_signature; begin_signature:
#define RVTEST_DATA_END .align 4; .global end_signature; end_signature:

#endif
