| program | performance: cycles | CPI | turbo: cycles | CPI | change |
|---|---:|---:|---:|---:|---:|
| `00_pipeline_fill` | 21 | 4.20 | 21 | **4.20** | 0.0% |
| `01_hello` | 147 | 1.52 | 149 | **1.54** | 1.4% |
| `02_forwarding` | 23 | 3.29 | 23 | **3.29** | 0.0% |
| `03_load_use` | 40 | 3.64 | 40 | **3.64** | 0.0% |
| `04_branch_penalty` | 53 | 1.61 | 55 | **1.67** | 3.8% |
| `05_fibonacci` | 328 | 1.08 | 330 | **1.08** | 0.6% |
| `06_bubble_sort` | 1,002 | 1.39 | 1,004 | **1.39** | 0.2% |
| `07_factorial_recursive` | 482 | 2.04 | 399 | **1.69** | -17.2% |
| `08_gcd_euclid` | 82 | 4.32 | 55 | **2.89** | -32.9% |
| `09_primes_sieve` | 16,899 | 1.14 | 17,012 | **1.15** | 0.7% |
| `10_print_numbers` | 1,138 | 2.12 | 888 | **1.65** | -22.0% |
| `11_gshare_patterns` | 1,139 | 1.03 | 1,143 | **1.04** | 0.4% |
| `12_measure_cpi` | 154 | 1.62 | 129 | **1.36** | -16.2% |
| `13_function_call_cost` | 294 | 2.60 | 225 | **1.99** | -23.5% |
| `14_false_load_stall` | 82 | 2.16 | 72 | **1.89** | -12.2% |
| `15_system_calls` | 116 | 2.19 | 117 | **2.21** | 0.9% |
| `16_cache_conflicts` | 440 | 2.57 | 443 | **2.59** | 0.7% |
| `17_predictor_challenge` | 6,277 | 1.24 | 6,510 | **1.28** | 3.7% |
| `18_bit_tricks` | 711 | 1.26 | 679 | **1.20** | -4.5% |
| `19_performance_counters` | 232 | 1.93 | 219 | **1.82** | -5.6% |
| `20_leds_and_buttons` | 1,196 | 1.18 | 1,197 | **1.18** | 0.1% |
| `21_timer_interrupts` | 10,056 | 1.03 | 10,058 | **1.02** | 0.0% |
| `22_multitasking` | 82,959 | 2.43 | 57,144 | **1.94** | -31.1% |
| `23_custom_instructions` | 638 | 1.50 | 604 | **1.42** | -5.3% |
| `24_sha256` | 7,648 | 1.05 | 7,562 | **1.04** | -1.1% |
| `tests/custom_pipeline` | 93,863 | 3.06 | 54,301 | **2.14** | -42.1% |
| `tests/interrupt_stress` | 21,540 | 1.90 | 18,235 | **1.64** | -15.3% |
| `tests/isa_selfcheck` | 31,292 | 2.51 | 20,903 | **1.68** | -33.2% |
| `tests/m_divide_lengths` | 79,312 | 12.86 | 28,614 | **4.64** | -63.9% |
| `tests/m_hazard_priority` | 152 | 2.62 | 113 | **1.95** | -25.7% |
| `tests/m_unit_fuzz` | 150,699 | 6.24 | 64,852 | **2.68** | -57.0% |
| `tests/zknh_selfcheck` | 4,508 | 2.09 | 3,316 | **1.54** | -26.4% |

Geometric-mean cycle reduction, turbo over performance: **15.6%** over 32 programs.

Every cycle above one per instruction, summed over all 32 programs (`cycles = N + 5 + L + 3F + R + K + I + D + X + B` per program):

| build | N | cycles | CPI | L | 3F | R | K | I | D | X | B |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| performance | 163,734 | 513,523 | 3.136 | 14,098 | 24,672 | 3,725 | 284,110 | 14,367 | 5,570 | 3,087 | 0 |
| turbo | 153,545 | 296,412 | 1.930 | 22,732 | 17,844 | 3,926 | 83,014 | 5,866 | 5,572 | 1,957 | 1,796 |

(N differs between the builds because the interrupt programs wait for a timer: a faster core runs its idle loop more often. B is the extra bubble of a branch resolved one stage later, LATE_BRANCH_RESOLVE.)
