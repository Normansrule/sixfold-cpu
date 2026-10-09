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
| `23_sha256` |  | 7,574 | 1.04 | 7,648 | **1.05** | 1009.9 µs | 31.34 µs | 3.92 µs |
| `interrupt_stress` | yes | 16,062 | 1.48 | 21,540 | **1.90** | 2141.6 µs | 88.28 µs | 11.05 µs |
| `isa_selfcheck` | yes | 14,346 | 1.15 | 31,292 | **2.51** | 1912.8 µs | 128.25 µs | 16.06 µs |
| `zknh_selfcheck` |  | 2,401 | 1.12 | 4,494 | **2.09** | 320.1 µs | 18.42 µs | 2.31 µs |

Geometric-mean speed-up of the performance edition over the baseline, both on 130 nm: **24.2x** (clock and cycles together). Cache misses are included: these programs are tiny, so their few cold misses weigh heavily.
