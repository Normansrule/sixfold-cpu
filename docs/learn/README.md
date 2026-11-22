# Learning path: from "what is a CPU?" to your own chip

Fourteen short chapters. Each one explains one idea, shows a picture, points at the exact
lines of SystemVerilog that implement it, and gives you a program to run so you can
**see** it happen. Read them in order the first time.

| # | chapter | you will be able to | run this |
|---|---|---|---|
| 1 | [What a CPU does](01_what_is_a_cpu.md) | explain fetch, decode, execute and the clock | `make pipe PROG=00_pipeline_fill` |
| 2 | [Instructions are just 32 bits](02_instructions_in_binary.md) | decode any RISC-V word by hand | `node tools/rv.mjs encode "add a0, a1, a2"` |
| 3 | [The six stages and how to read the diagrams](03_the_six_stages.md) | follow one instruction through the block diagram and the pipeline chart | `make cycle PROG=02_forwarding C=7` |
| 4 | [Data hazards: forwarding and load stalls](04_data_hazards.md) | predict when the pipeline stalls | `make pipe PROG=03_load_use` |
| 5 | [Control hazards and branch prediction](05_branch_prediction.md) | explain gshare, redirects and flushes | `make bp PROG=11_gshare_patterns` |
| 6 | [Measuring performance](06_performance.md) | compute CPI and account for every cycle; see also [PERFORMANCE.md](../PERFORMANCE.md) | `make run PROG=12_measure_cpi` |
| 7 | [From RTL to silicon](07_silicon.md) | read a layout, a timing report and an area report | `make synth` |
| 8 | [Using the CPU: write and run your own program](08_using_the_cpu.md) | write, assemble, simulate and debug RISC-V assembly | `make run PROG=my_program` |
| 9 | [Devices, interrupts and booting](09_devices_and_interrupts.md) | drive devices through memory-mapped registers, handle a timer interrupt, explain how a computer boots | `make run PROG=21_timer_interrupts` |
| 10 | [Three architectures: RISC-V, MIPS and x86-64](10_three_architectures.md) | read the same program in three instruction sets, their encodings and their pipelines | `make isa-compare` |
| 11 | [Your own instructions](11_custom_instructions.md) | design an instruction, give it an encoding, measure it, and build it into the hardware | `make custom && make test` |
| 12 | [Adding a standard extension: SHA-2 in hardware](12_adding_instructions.md) | add a ratified extension (Zknh) by hand through all five layers, and measure whether it paid off | `make run PROG=24_sha256` |
| 13 | [Trading cycles for clock, and where the caches go](13_clock_and_floorplan.md) | find the slowest path, shorten it by deciding earlier or later, and place the caches beside the logic that uses them | `make floorplan` |
| 14 | [A deeper pipeline: more stages, a faster clock, and what it costs](14_deep_pipeline.md) | explain a staggered ALU, why only one stage stalls, and weigh a faster clock against a higher CPI | `make deep-check` |

Every chapter uses the same names as the code: stages are `FETCH1`, `FETCH2`, `DECODE`,
`EXECUTE`, `MEMORY`, `WRITEBACK`, and signals are written exactly as in
[`src/Riscv64.sv`](../../src/Riscv64.sv), for example `LOAD_STALL` or
`FLUSH_FETCH1_FETCH2_DECODE`.

Every abbreviation is spelled out in the [glossary](../GLOSSARY.md). Recommended videos and courses (all in English) are listed in [REFERENCES.md](../REFERENCES.md#learning-resources).
