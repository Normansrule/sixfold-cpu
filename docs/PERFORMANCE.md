# Performance: a shorter critical path, fewer wasted cycles, a realistic memory

How the performance edition was built from the baseline pipeline, what each change bought, and what
it cost. Every number is produced by a script in this repository, and every behavioural change is
verified cycle by cycle against the RTL by `make test`, which builds **both** designs.

| build | how to get it | what it is |
|---|---|---|
| **performance** (default) | `make test`, `make run PROG=...` | 4 KiB 2-way set-associative instruction cache with next-line prefetch, 4 KiB 2-way write-through data cache (LRU replacement), tournament predictor (per-branch history table + gshare + chooser), 16-entry branch target buffer, 8-entry return address stack, precise load stalls, iterative multiply/divide, Kogge-Stone adders |
| **baseline** | `-DBASELINE`, `CONFIG=baseline` | the plain 6-stage pipeline: single-cycle 64 KiB memory, 4-bit gshare only, single-cycle multiply/divide |

Every feature is a parameter of [`src/Riscv64.sv`](../src/Riscv64.sv) / [`src/Riscv64_top.sv`](../src/Riscv64_top.sv)
(`CACHES_ENABLE`, `MISS_LATENCY`, `TOURNAMENT_PREDICTOR`, `BTB_ENABLE`, `RAS_ENABLE`,
`PRECISE_LOAD_STALL`, `ITERATIVE_MULTIPLY_DIVIDE`, `GSHARE_HISTORY_BITS`), with the same switches in
`CONFIGS` in [`model/core.js`](../model/core.js), so each one can be measured on its own.

## The result

![CPI per program](img/charts/performance.svg)

| program | M ops | baseline: cycles | CPI | performance: cycles | CPI | time, baseline 130 nm (7.5 MHz) | time, performance 130 nm (244 MHz) | time, performance 7 nm (1.95 GHz) |
|---|:-:|---:|---:|---:|---:|---:|---:|---:|
| `00_pipeline_fill` |  | 10 | 2.00 | 21 | **4.20** | 1.3 µs | 0.09 µs | 0.01 µs |
| `01_hello` |  | 139 | 1.43 | 147 | **1.52** | 18.5 µs | 0.60 µs | 0.08 µs |
| `02_forwarding` |  | 12 | 1.71 | 23 | **3.29** | 1.6 µs | 0.09 µs | 0.01 µs |
| `03_load_use` |  | 18 | 1.64 | 40 | **3.64** | 2.4 µs | 0.16 µs | 0.02 µs |
| `04_branch_penalty` |  | 50 | 1.52 | 53 | **1.61** | 6.7 µs | 0.22 µs | 0.03 µs |
| `05_fibonacci` |  | 366 | 1.20 | 328 | **1.08** | 48.8 µs | 1.34 µs | 0.17 µs |
| `06_bubble_sort` | yes | 1,124 | 1.56 | 1,002 | **1.39** | 149.9 µs | 4.11 µs | 0.51 µs |
| `07_factorial_recursive` | yes | 327 | 1.39 | 482 | **2.04** | 43.6 µs | 1.98 µs | 0.25 µs |
| `08_gcd_euclid` | yes | 33 | 1.74 | 82 | **4.32** | 4.4 µs | 0.34 µs | 0.04 µs |
| `09_primes_sieve` | yes | 19,773 | 1.33 | 16,899 | **1.14** | 2636.4 µs | 69.26 µs | 8.67 µs |
| `10_print_numbers` | yes | 737 | 1.37 | 1,138 | **2.12** | 98.3 µs | 4.66 µs | 0.58 µs |
| `11_gshare_patterns` |  | 1,519 | 1.38 | 1,139 | **1.03** | 202.5 µs | 4.67 µs | 0.58 µs |
| `12_measure_cpi` | yes | 122 | 1.28 | 154 | **1.62** | 16.3 µs | 0.63 µs | 0.08 µs |
| `13_function_call_cost` | yes | 174 | 1.54 | 294 | **2.60** | 23.2 µs | 1.20 µs | 0.15 µs |
| `14_false_load_stall` |  | 49 | 1.29 | 82 | **2.16** | 6.5 µs | 0.34 µs | 0.04 µs |
| `15_system_calls` |  | 89 | 1.68 | 116 | **2.19** | 11.9 µs | 0.48 µs | 0.06 µs |
| `16_cache_conflicts` |  | 208 | 1.22 | 440 | **2.57** | 27.7 µs | 1.80 µs | 0.23 µs |
| `17_predictor_challenge` |  | 7,492 | 1.48 | 6,277 | **1.24** | 998.9 µs | 25.73 µs | 3.22 µs |
| `18_bit_tricks` |  | 732 | 1.30 | 711 | **1.26** | 97.6 µs | 2.91 µs | 0.36 µs |
| `19_performance_counters` | yes | 173 | 1.47 | 231 | **1.96** | 23.1 µs | 0.95 µs | 0.12 µs |
| `20_leds_and_buttons` |  | 1,266 | 1.25 | 1,196 | **1.18** | 168.8 µs | 4.90 µs | 0.61 µs |
| `21_timer_interrupts` |  | 13,236 | 1.36 | 10,056 | **1.03** | 1764.8 µs | 41.21 µs | 5.16 µs |
| `22_multitasking` | yes | 35,510 | 1.35 | 82,959 | **2.43** | 4734.7 µs | 340.00 µs | 42.56 µs |
| `interrupt_stress` | yes | 16,062 | 1.48 | 21,540 | **1.90** | 2141.6 µs | 88.28 µs | 11.05 µs |
| `isa_selfcheck` | yes | 14,346 | 1.15 | 31,292 | **2.51** | 1912.8 µs | 128.25 µs | 16.06 µs |

Geometric-mean speed-up of the performance edition over the baseline, both on 130 nm: **24.3x** (clock and cycles together). Cache misses are included: these programs are tiny, so their few cold misses weigh heavily.

## Part 1: cycles per instruction

`cycles = N + 5 + L + 3F + R + K + I + D + X` ([MATH.md](MATH.md)) says exactly where every cycle above
one per instruction comes from.

| change | term | how | cost |
|---|---|---|---|
| **Branch Target Buffer** | R | 16 entries remember "the instruction at this PC jumped to that PC"; FETCH1 redirects immediately | 960 flip-flops |
| **Return Address Stack** | F | calls push PC + 4 in FETCH2, returns pop and redirect (1 bubble instead of a 3-bubble flush); the pointer is checkpointed and restored on flushes | 8 x 64-bit entries |
| **Tournament predictor** | F | a per-branch history table (fast learner) next to gshare (pattern learner), and a chooser per branch that learns which to trust (Alpha 21264 style) | 2 x 128 two-bit counters |
| **Precise load stalls** | L | `ControlUnit` reports `USES_REGISTER1/2`, so only real dependences stall | a few gates |
| **Instruction cache + next-line prefetch** | I | after a miss on line X, line X + 1 is fetched in the background: sequential code misses half as often (self-check: 917 → 459 misses) | 4 KiB SRAM + tags |
| **Data cache** | D | write-through: stores never wait; only loads that miss wait for their line | 4 KiB SRAM + tags |
| **Data next-line prefetch** | D | after a load miss on line X, line X + 1 is fetched in the background (sieve: 32 → 16 data misses) | a second refill request path |
| **2 ways + LRU** (both caches) | I, D | two lines per set, so addresses 2 KiB apart no longer evict each other; `16_cache_conflicts.s` shows 2 arrays fitting and 3 thrashing | a second tag compare, 1 LRU bit per set |

Why add caches if they add cycles? The baseline assumes 64 KiB of memory that answers in one cycle.
That is fine in a simulator but not in silicon: a memory that large cannot be read in one short clock
cycle. Real CPUs keep small, fast caches next to the pipeline and pay a miss penalty now and then.
The penalty here is `MISS_LATENCY + 1 = 11` cycles; long-running code hides it (the sieve runs at CPI
1.15 with caches), while programs of a few dozen instructions are dominated by their cold misses.

## Part 2: frequency

```bash
make timing                              # both builds on SkyWater 130 nm
tools/timing.sh performance asap7        # the same RTL on ASAP7, a 7 nm-class library
```

sv2v converts the SystemVerilog, Yosys synthesizes it without area-oriented rewriting and without
resource sharing (`-noshare`, see the third round), and ABC restructures it for delay (sum-of-products balancing, `&if -g` and `&b` [47]), maps it onto the cell
library and reports the longest register-to-register path. **Logic only**: no wires, clock skew or
slow corner; after place and route expect 1.5x to 2.5x longer. The cache memories are left out (a
real chip uses SRAM macros for them). ABC has some run-to-run spread: near-equal paths can swap
places and move the result by about 5%.

![clock roadmap](img/diagrams/clock_roadmap.svg)

### The first round (130 nm)

| step | limiting path | 130 nm |
|---|---|---:|
| baseline RTL, M unit excluded | `EXECUTE_PC + 4` incrementer on the flush path | 4.6 ns |
| baseline single-cycle multiply/divide unit alone | 64 subtract steps in a row | **133 ns** |
| Kogge-Stone prefix adders (ALU, branch compare, FETCH2 target), PC + 4 carried down the pipeline | | 4.1 ns (M excluded) |
| iterative multiply/divide unit | its setup, then its negation | 11.1 → 5.9 ns |
| prefix-OR negation, magnitudes a cycle earlier, return check against `rs1` | | 4.8 ns |
| tournament predictor, prefix incrementers for the PCs | FETCH2 target → next-PC mux | 5.0 ns |
| 64-bit counters split into halves with a registered carry | the multiply step (64 x 16 bits + accumulate) | 5.5 ns (180 MHz) |

### The second round (7 nm): 729 ps → 522 ps

Each row is one change, measured with `tools/timing.sh performance asap7`, and each was checked
cycle-exact against the model on all 76 regression runs before the next one.

| change | why it was slow | cost | 7 nm |
|---|---|---|---:|
| start of this round | `FETCH2_PC + 4` for the Return Address Stack | | 729 ps |
| **PC + 4 registered from FETCH1** instead of recomputed in FETCH2 | a second 64-bit incrementer after a register | 64 flip-flops | 709 ps |
| delay-oriented mapping in the flow (SOP balancing) | now shows the real limit clearly: the multiply step | | 747 ps |
| **Wallace-tree multiply step** ([`Carry_Save_Multiplier.sv`](../src/Carry_Save_Multiplier.sv)) [44] | `A * B[15:0] + acc` became 16 rows of ripple adders | none | 597 ps |
| **registered M result** (a SIGN cycle) | a 128-bit negation in front of the forwarding multiplexers | +1 cycle per M instruction | 608 ps |
| **carry-save accumulator**: the product stays two numbers until SIGN, where one adder sums **and** negates it (`-(x+y) = ~(x + y - 1)`) | an 80-bit carry-propagate adder in every step | none | 599 ps |
| **leading-zero counter tree** [46] + a separate ALIGN cycle for divides | "is the top half zero? shift" six times in a row | +1 cycle per divide | 555 ps |
| **ALU subtract decoded in DECODE** (a flip-flop, not logic) | op decode → 64 inverters → adder | 1 flip-flop | 560 ps |
| **EXECUTE operand registers no longer wait for FLUSH** | branch compare → flush → enable of ~1,000 flip-flops | none | 575 ps |
| **private 3-bit store-offset adder** | store lanes waited for the full ALU and its result multiplexer | a 3-bit adder | 546 ps |
| **multiply/divide signedness decoded in DECODE** | op decode in front of the operand negation | 3 flip-flops | 527 ps |
| **ALU operands chosen in DECODE** (`EXECUTE_ALU_INPUT_A/B` are registers) | a 2:1 multiplexer with a 64-bit fan-out select in front of the adder | 128 flip-flops | 541 ps |
| **front-end registers (FETCH2, DECODE) no longer wait for FLUSH** | the same flush-to-enable path in the front end | none | **522 ps** |

### The third round: 32 more instructions and six counters, same clock at 7 nm

Adding Zba and Zbb put a leading-zero counter, a population count, a rotator, byte shuffles and
min/max next to the adder, and a shift-and-zero-extend in front of it. Measured on the way:

| step | 7 nm |
|---|---:|
| end of the second round, re-measured with the final flow below | 538 ps |
| Zba/Zbb added naively (operand preparation after forwarding, everything in the result multiplexer) | 758 ps |
| found: Yosys's `share` pass had merged the ALU's shifters with another shifter into one "supercell" steered by logic that depends on the branch flush. A timing-driven flow never shares on a critical path, so the flow now runs `synth -noshare` (this also explains the odd flush-to-operand paths of the second round) | 629 ps |
| `cpop` gets a 2-cycle latency (`EXECUTE_LATE_RESULT`): a 64-bit popcount tree is deeper than the adder | 574 ps |
| the value forwarded from EXECUTE takes its own short path through operand preparation (early/late split), and the adder enters the ALU's result multiplexer last | 576 ps |
| `min`/`max` get the same 2-cycle latency: their compare comes out of the adder and then steers all 64 result bits | 547 ps |
| hardware performance counters (split 64-bit counters, off every critical path) | **523 ps** |

Cost in cycles: an instruction that uses a `cpop`, `min` or `max` result right away waits one cycle
(like a load). Every other new instruction is single-cycle. The 7 nm clock is where it was before the
new instructions (within ABC's run-to-run spread).

| build | SkyWater 130 nm | ASAP7 7 nm-class |
|---|---:|---:|
| baseline (single-cycle M unit excluded) | 4.41 ns (227 MHz) | 0.51 ns (1.98 GHz) |
| **performance** (everything included) | **4.28 ns (234 MHz)** | **0.52 ns (1.91 GHz)** |

At 130 nm the population count is now the longest path (its small adders chain up: about 13 full
adders deep), which costs 130 nm about 12% against the second round; at 7 nm it has slack.

The remaining paths are all within a few percent of each other (500 to 520 ps), and the main one is
the loop every simple pipeline has: **ALU → result multiplexer → forwarding multiplexer → the next
instruction's operand register**. One 64-bit add plus about four levels of multiplexing is roughly
500 ps in this library. At 130 nm the limit is the population count (see above).

### The fourth round: the rest of the B extension, and cpop split across two stages

Zbs adds single-bit set, clear, invert and extract. Where its 6-to-64 decoder goes decides the clock.
Measured at 7 nm, one change at a time:

| step | 7 nm | 130 nm |
|---|---:|---:|
| end of the third round | 523 ps | 4.28 ns (limit: `cpop`) |
| Zbs inside the ALU: the decoder in EXECUTE, four more inputs on the result multiplexer | 543 ps | |
| `cpop` split across two stages: nibble lookups and four 16-bit quarter counts in EXECUTE, the last addition in MEMORY (where it sits beside LoadControl's lane selection, which is slower) | | 4.14 ns |
| (experiment) the same without Zbs at all | 485 ps | |
| Zbs as operand preparation in DECODE (`bset` = OR, `bclr` = AND, `binv` = XOR with a prepared single bit), decoder on both the early and the late path | 571 ps (the decoder landed in the forwarding loop) | |
| **the decoder on the early path only**: a `bset`/`bclr`/`binv` whose bit number the previous instruction computes waits one cycle (`SINGLE_BIT_HAZARD`, counted as a load stall) | **536 ps** | **3.75 ns** |

The final 7 nm limit is no longer the ALU loop but the divider's SIGN step (the 64-bit remainder
negation, then the result select), which ABC's run-to-run spread moves by a few percent either way.
At 130 nm the split `cpop` gave back more than it had cost: **267 MHz**, the best so far.

| build | SkyWater 130 nm | ASAP7 7 nm-class |
|---|---:|---:|
| **performance** (everything included) | **3.75 ns (267 MHz)** | **0.536 ns (1.87 GHz)** |

Cost in cycles: none for any program in `programs/` (their `bset`s take bit numbers computed earlier);
the self-check, which computes every bit number right before using it, pays 20 cycles in 31,138.

### The fifth round: interrupts

Precise timer and external interrupts add a decision in DECODE (take the interrupt instead of the
instruction?), a pseudo-instruction flag through EXECUTE, and two registered interrupt lines in the CSR
file. The decision uses only registered signals: the stall and flush conditions are applied by the
pipeline-register code that already has them, so no branch outcome reaches the new logic. A first version
that tested `FLUSH` inside the decision put the branch comparator in front of one more flip-flop input.
Measured with the same flow:

| build | SkyWater 130 nm | ASAP7 7 nm-class |
|---|---:|---:|
| **performance** with interrupts | **4.09 ns (244 MHz)** | **0.513 ns (1.95 GHz)** |

Both limits now start at the branch comparator's operand (`EXECUTE_REGISTER1_DATA`): compare, flush, then
the next-PC multiplexer. The numbers move by a few percent from run to run of ABC's delay-driven mapping
(this round saw 3.75 to 4.10 ns at 130 nm and 501 to 536 ps at 7 nm for very similar netlists), so a
change smaller than about 5% is below what this logic-only flow can resolve.

Re-measured after the Basys 3 round (which changed no logic of the core): `make timing` gives 3.66 ns
(273 MHz) for the performance build and 3.35 ns for the baseline without its M unit. That is the same
spread again, so this page, the README and the site keep the conservative 244 MHz.

The caches are not in this measurement (they would be SRAM macros on a chip, timed separately). On an
FPGA they are real logic, and there they set the clock: see [FPGA.md](FPGA.md#7-results).

## 2.5 GHz and 5 GHz

2.5 GHz is a 400 ps cycle and 5 GHz is 200 ps. The logic between two registers has to shrink by 1.3x
and 2.6x from here, and on a real chip wires and clock skew take part of the cycle too. The design
techniques that get there are known; each one costs cycles (CPI) or area:

* **Split EXECUTE in two** (an 8-stage pipeline): add in one stage, select and forward in the next.
  A dependent instruction then waits one cycle (like a load today), and a mispredicted branch costs
  4 bubbles instead of 3. This is the step that would take Sixfold under 400 ps.
* **A deeper front end**: BTB lookup, direction prediction and instruction-cache access in separate
  stages, as in every current core, with a small "next-line predictor" to keep fetching every cycle.
* **Pipelined caches**: a 4 to 5 cycle load-to-use latency on a 4 to 5 GHz desktop core.
* **15 to 20 stages and out-of-order execution**: at 5 GHz a stage holds only about 12 to 20 simple
  gate delays [48], so everything is pipelined, and out-of-order execution hides the extra latency.
* **Custom circuits and the process**: hand-placed datapaths, dynamic logic and a leading-edge node.
  Commercial 2 to 3 nm-class libraries are under non-disclosure agreements, so this repository
  measures on ASAP7, an open 7 nm-class predictive kit.

## Why not 2 nm, or 0.42 nm?

A process node is a property of the **factory**, not of the Verilog. The RTL describes logic; a
foundry's library of transistors decides how fast that logic switches. The same RTL here gives
4.28 ns on 130 nm and 0.52 ns on a 7 nm-class library, 8x faster, without changing a line.

* **2 nm** processes exist commercially (for example at TSMC, Samsung and Intel), but their design
  kits are under non-disclosure agreements; no open library below 7 nm exists to measure with.
  "2 nm" is also a marketing name: the actual gate pitch in such processes is tens of nanometres.
* **0.42 nm** is about the distance between neighbouring silicon atoms (0.235 nm bond length, 0.543 nm
  lattice constant). No transistor can be built at that scale; it is not a process node.

What this repository *can* show is the design side, which carries over to any node: measure the
critical path, make it shallower (prefix adders, Wallace trees, leading-zero trees), take decisions
a stage earlier (pre-decoding), keep slow control signals away from large register enables, spread
long work over several cycles (the iterative M unit), and win the cycles back with prediction and
caching.

## What to try next

* **Split EXECUTE** into two stages and measure the clock gain against the extra bubbles.
* **A carry-save population count** (the 130 nm limit): compress the 64 bits column by column with full
  adders, like the multiplier, instead of a tree of small ripple adders.
* **Time the cache hit path**: address → tag compare → `DATA_CACHE_STALL` → every pipeline enable.
  With the tag SRAM included this is likely the next critical path.
* **Booth recoding** for the multiply step (8 partial products instead of 16), and radix-4 division.
* **Real sign-off**: run OpenROAD on the sv2v output for placed-and-routed numbers.
