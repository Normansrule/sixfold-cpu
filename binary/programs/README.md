# Assembled programs

Every file in [`programs/`](../../programs) assembled by `model/asm.js` (code starts at the reset PC `0x2000`).

* `.lst`: listing with address, hex word, **binary word**, source line
* `.hex`: memory image for `$readmemh` (one byte per line, little-endian)

* [00_pipeline_fill.lst](00_pipeline_fill.lst) · [00_pipeline_fill.hex](00_pipeline_fill.hex)
* [01_hello.lst](01_hello.lst) · [01_hello.hex](01_hello.hex)
* [02_forwarding.lst](02_forwarding.lst) · [02_forwarding.hex](02_forwarding.hex)
* [03_load_use.lst](03_load_use.lst) · [03_load_use.hex](03_load_use.hex)
* [04_branch_penalty.lst](04_branch_penalty.lst) · [04_branch_penalty.hex](04_branch_penalty.hex)
* [05_fibonacci.lst](05_fibonacci.lst) · [05_fibonacci.hex](05_fibonacci.hex)
* [06_bubble_sort.lst](06_bubble_sort.lst) · [06_bubble_sort.hex](06_bubble_sort.hex)
* [07_factorial_recursive.lst](07_factorial_recursive.lst) · [07_factorial_recursive.hex](07_factorial_recursive.hex)
* [08_gcd_euclid.lst](08_gcd_euclid.lst) · [08_gcd_euclid.hex](08_gcd_euclid.hex)
* [09_primes_sieve.lst](09_primes_sieve.lst) · [09_primes_sieve.hex](09_primes_sieve.hex)
* [10_print_numbers.lst](10_print_numbers.lst) · [10_print_numbers.hex](10_print_numbers.hex)
* [11_gshare_patterns.lst](11_gshare_patterns.lst) · [11_gshare_patterns.hex](11_gshare_patterns.hex)
* [12_measure_cpi.lst](12_measure_cpi.lst) · [12_measure_cpi.hex](12_measure_cpi.hex)
* [13_function_call_cost.lst](13_function_call_cost.lst) · [13_function_call_cost.hex](13_function_call_cost.hex)
* [14_false_load_stall.lst](14_false_load_stall.lst) · [14_false_load_stall.hex](14_false_load_stall.hex)
* [15_system_calls.lst](15_system_calls.lst) · [15_system_calls.hex](15_system_calls.hex)
* [16_cache_conflicts.lst](16_cache_conflicts.lst) · [16_cache_conflicts.hex](16_cache_conflicts.hex)
* [17_predictor_challenge.lst](17_predictor_challenge.lst) · [17_predictor_challenge.hex](17_predictor_challenge.hex)
* [18_bit_tricks.lst](18_bit_tricks.lst) · [18_bit_tricks.hex](18_bit_tricks.hex)
* [19_performance_counters.lst](19_performance_counters.lst) · [19_performance_counters.hex](19_performance_counters.hex)
* [20_leds_and_buttons.lst](20_leds_and_buttons.lst) · [20_leds_and_buttons.hex](20_leds_and_buttons.hex)
* [21_timer_interrupts.lst](21_timer_interrupts.lst) · [21_timer_interrupts.hex](21_timer_interrupts.hex)
* [22_multitasking.lst](22_multitasking.lst) · [22_multitasking.hex](22_multitasking.hex)
* [23_sha256.lst](23_sha256.lst) · [23_sha256.hex](23_sha256.hex)
