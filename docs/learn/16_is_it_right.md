# 16. Is it right? Testing a CPU against other people's tests

Every chapter so far ended with the same check: the SystemVerilog design and the JavaScript model agree on
every clock cycle. That check is strong, but it has a blind spot. Both were written from the same reading of
the specification. If that reading is wrong, both are wrong in the same way, and they still agree.

This chapter runs tests that Sixfold's author did not write. The measured results are in
[COMPLIANCE.md](../COMPLIANCE.md).

## Three ways to be sure

| Method | Who decides the right answer | What it can miss |
|---|---|---|
| Lock-step comparison (`make test`) | Sixfold's own model | a mistake made in both the model and the RTL |
| Compliance tests (`make riscv-tests`) | test authors working from the specification | cases nobody thought to write |
| Formal verification (next) | a solver, for every possible input | only what the properties fail to say |

Each row covers a hole in the one above it. Real processor teams use all three.

## One test, read closely

Here is one case from `rv64ui/add.S` in the official suite:

```text
TEST_RR_OP( 7,  add, 0xffffffff7fff8000, 0xffffffff80000000, 0xffffffffffff8000 );
```

Test 7: add `0xffffffff80000000` and `0xffffffffffff8000`, expect `0xffffffff7fff8000`. Two large negative
numbers whose sum carries out of the top bit, which a 64-bit adder must drop. The more interesting cases come
later in the same file:

```text
TEST_RR_SRC12_BYPASS( 24, 0, 1, add, 25, 14, 11 );
```

Test 24 loads 14 into `x1`, then 11 into `x2`, puts **one** `nop` after the second load, and adds. Its
neighbours put zero, one or two instructions between a value and its use, and run the sequence twice so the
second pass meets warm caches and a trained predictor. Those distances decide whether Sixfold forwards a
value from MEMORY or from WRITEBACK ([chapter 4](04_data_hazards.md)). The suite was written for every
RISC-V core, yet it walks straight through Sixfold's forwarding paths.

## How a test says pass or fail

The suite leaves "how do I report a result" to each core. Sixfold's answer is
[tests/riscv-tests/env/riscv_test.h](../../tests/riscv-tests/env/riscv_test.h): a passing test writes `1`
to the TOHOST register, a failing one writes its test number shifted left with the lowest bit set. Test 24
failing would write `(24 << 1) | 1 = 49`. The model and the testbench stop on that write.

## What the tests found

Every test of every extension Sixfold implements passes, on every build, with the RTL (register-transfer level) design still matching the
model on every cycle. One test was left out on purpose: `ma_data` loads a halfword from an odd address.
The specification allows a core either to do that in hardware or to raise an exception. Sixfold does
neither: it quietly reads the aligned halfword. The test caught a real gap, and it is the first item on the
list of what comes next.

## Try it

```bash
cd ~/sixfold-cpu && make riscv-tests
```

Then open `build/riscv-tests/rv64ui-add.dump` to read the machine code of one test next to its source.
