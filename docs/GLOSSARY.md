# Glossary

Every abbreviation and technical term used in this repository, in plain words, with where to see it.
Terms are in alphabetical order; acronyms are spelled out first.

| term | in full | what it means here | see |
|---|---|---|---|
| ABI | Application Binary Interface | the agreed names and jobs of the registers (`a0` holds the result, `sp` the stack pointer, `ra` the return address), so code from different authors can call each other | [`model/isa.js`](../model/isa.js) `ABI` |
| ABC | (a logic synthesis and verification tool; the name is not an acronym) | rewrites and maps a circuit onto real cells and estimates its delay; used by `make timing` | [`tools/timing.sh`](../tools/timing.sh) |
| ALU | Arithmetic Logic Unit | adds, subtracts, compares, shifts and does bit operations in EXECUTE | [`src/ALU.sv`](../src/ALU.sv) |
| AppImage | (a Linux application format) | one file that runs on most Linux distributions without installing | [`desktop/README.md`](../desktop/README.md) |
| ASAP7 | Arizona State Predictive 7 nm process design kit | a research model of a 7 nm FinFET process: realistic timing, cannot be manufactured | [PERFORMANCE.md](PERFORMANCE.md) |
| ASIC | Application-Specific Integrated Circuit | a chip made for one design, as opposed to an FPGA | [SILICON.md](SILICON.md) |
| B extension | Bit manipulation (Zba + Zbb + Zbs) | address generation (`sh3add`), bit counting (`cpop`, `clz`), min/max, rotates, single-bit operations | [chapter 2](learn/02_instructions_in_binary.md) |
| BHT | Branch History Table | a table of 2-bit counters, one per branch address: "does this branch usually jump?" | [`src/Tournament_Chooser.sv`](../src/Tournament_Chooser.sv) |
| BIOS | Basic Input/Output System | the firmware the FPGA computer runs at power-on: a serial console that loads and runs programs | [`fpga/firmware/bios.s`](../fpga/firmware/bios.s) |
| bubble | | an empty slot moving through the pipeline: a cycle in which a stage does no useful work | [chapter 3](learn/03_the_six_stages.md) |
| BTB | Branch Target Buffer | remembers where taken branches went, so FETCH1 can follow them with no lost cycle | [`src/Branch_Target_Buffer.sv`](../src/Branch_Target_Buffer.sv) |
| cache | | a small fast memory holding copies of recently used main memory | [chapter 6](learn/06_performance.md), [the caches](../index.html#caches) |
| CISC | Complex Instruction Set Computer | instruction sets like x86 with variable-length instructions that can work on memory directly | [ISA_COMPARISON.md](ISA_COMPARISON.md) |
| CPI | Cycles Per Instruction | clock cycles divided by instructions finished; 1.0 is the ideal for a one-instruction-per-cycle pipeline | [chapter 6](learn/06_performance.md) |
| CPU | Central Processing Unit | the processor | |
| CSR | Control and Status Register | registers outside the 32 general ones: cycle counter, trap registers (`mtvec`, `mepc`, `mcause`), interrupt enables | [`src/Control_Status_Register_File.sv`](../src/Control_Status_Register_File.sv) |
| carry-save adder | (CSA) | a row of full adders that turns three numbers into two without waiting for any carry; a tree of them adds many numbers fast (the multiplier, the custom popcount) | [`src/Carry_Save_Multiplier.sv`](../src/Carry_Save_Multiplier.sv) |
| custom-0 | | one of four major opcodes RISC-V reserves for non-standard instructions; Sixfold's are there | [CUSTOM_INSTRUCTIONS.md](CUSTOM_INSTRUCTIONS.md) |
| deb | Debian package | the installer format for Debian, Ubuntu and their relatives | [`desktop/README.md`](../desktop/README.md) |
| DEF | Design Exchange Format | a text file describing a placed and routed chip layout | [`docs/silicon/`](silicon) |
| delay slot | | on MIPS, the instruction right after a branch, which runs whether the branch is taken or not | [chapter 10](learn/10_three_architectures.md) |
| dmg | disk image (Apple) | the macOS installer format | [`desktop/README.md`](../desktop/README.md) |
| FPGA | Field-Programmable Gate Array | a chip whose logic is configured by a file, so the same board can become Sixfold | [FPGA.md](FPGA.md) |
| forwarding | (also "bypassing") | sending a result straight from a later stage to an instruction that needs it, without waiting for the register file | [chapter 4](learn/04_data_hazards.md) |
| funct3, funct7 | function fields | bits of an instruction that pick the operation within an opcode (`add` against `sub`) | [chapter 2](learn/02_instructions_in_binary.md) |
| GHR | Global History Register | the last few branch outcomes, taken or not, as bits; gshare mixes it with the address | [`src/GShare_Branch_Predictor.sv`](../src/GShare_Branch_Predictor.sv) |
| gshare | global history with index sharing (McFarling, 1993) | a branch predictor indexed by the branch address XOR the global history | [chapter 5](learn/05_branch_prediction.md) |
| HI, LO | high and low | MIPS's two special registers that receive the results of multiply and divide | [ISA_COMPARISON.md](ISA_COMPARISON.md) |
| hazard | | a reason the next instruction cannot proceed: data (needs a value not ready yet), control (a branch), structural (a busy unit) | [chapter 4](learn/04_data_hazards.md) |
| HPM | Hardware Performance Monitor | counters (`hpmcounter3` to `hpmcounter9`) that count each kind of lost cycle | [`programs/19_performance_counters.s`](../programs/19_performance_counters.s) |
| JSON | JavaScript Object Notation | the text format of `custom/instructions.json`, the file that lists your custom instructions | [CUSTOM_INSTRUCTIONS.md](CUSTOM_INSTRUCTIONS.md) |
| ISA | Instruction Set Architecture | the contract between software and hardware: which instructions exist and how they are encoded | [chapter 10](learn/10_three_architectures.md) |
| late result | | a result forwarded from MEMORY instead of EXECUTE (`cpop`, `min`, `max`); the next instruction waits one cycle if it needs it. Custom instructions are later still: computed in MEMORY, ready in WRITEBACK | [CUSTOM_INSTRUCTIONS.md](CUSTOM_INSTRUCTIONS.md) |
| LED | Light-Emitting Diode | the 16 lights on the Basys 3 board, a memory-mapped device | [`programs/20_leds_and_buttons.s`](../programs/20_leds_and_buttons.s) |
| LRU | Least Recently Used | the cache replacement rule: refill the way that was used longest ago | [the caches](../index.html#caches) |
| M extension | Multiply and divide | `mul`, `div`, `rem` and their variants | [`src/Iterative_Multiply_Divide_Unit.sv`](../src/Iterative_Multiply_Divide_Unit.sv) |
| macro-fusion | | an x86 decoder merging a compare and the following jump into one micro-op | [EXPERIMENTS.md, Lab 24](EXPERIMENTS.md#lab-24-teach-the-x86-64-model-a-real-processors-tricks) |
| micro-op | micro-operation | one simple step an x86 instruction is split into (`add rax, [rsi]` is a load and an add) | [ISA_COMPARISON.md](ISA_COMPARISON.md) |
| MIPS | Microprocessor without Interlocked Pipelined Stages | the classic RISC teaching architecture, modelled here for comparison | [ISA_COMPARISON.md](ISA_COMPARISON.md) |
| MMIO | Memory-Mapped Input/Output | devices that appear as memory addresses: storing to `0x10000000` prints a character | [chapter 9](learn/09_devices_and_interrupts.md) |
| ModRM, SIB, REX | Mode-Register-Memory; Scale-Index-Base; Register Extension | the x86-64 bytes that name an instruction's operands | [ISA_COMPARISON.md](ISA_COMPARISON.md) |
| MTIME, MTIMECMP | Machine Timer, Machine Timer Compare | the timer and the value at which it raises an interrupt | [`programs/21_timer_interrupts.s`](../programs/21_timer_interrupts.s) |
| nm | nanometre | the name of a manufacturing process generation (130 nm, 7 nm); today a label more than a measured size | [SILICON.md](SILICON.md) |
| opcode | operation code | bits 6:0 of every RISC-V instruction: which group it belongs to | [chapter 2](learn/02_instructions_in_binary.md) |
| PC | Program Counter | the address of the instruction being fetched | [chapter 1](learn/01_what_is_a_cpu.md) |
| PDK | Process Design Kit | the cell library and rules a foundry publishes for its process (SkyWater's sky130 here) | [SILICON.md](SILICON.md) |
| pipeline | | splitting each instruction into stages so several are in progress at once | [chapter 1](learn/01_what_is_a_cpu.md) |
| RAS | Return Address Stack | remembers where each `call` will return, so `ret` is predicted correctly | [`src/Return_Address_Stack.sv`](../src/Return_Address_Stack.sv) |
| RISC | Reduced Instruction Set Computer | instruction sets with simple, fixed-length instructions where only loads and stores touch memory | [ISA_COMPARISON.md](ISA_COMPARISON.md) |
| RTL | Register-Transfer Level | the description of hardware as registers and the logic between them: the SystemVerilog in `src/` | [chapter 3](learn/03_the_six_stages.md) |
| RV64I | RISC-V 64-bit base Integer instruction set | the 64-bit base every RISC-V processor of this size implements | [`binary/`](../binary/README.md) |
| SDM | Software Developer's Manual (Intel) | the reference for x86-64 encodings | [REFERENCES.md](REFERENCES.md) |
| sky130 | SkyWater 130 nm | an open, manufacturable process design kit | [SILICON.md](SILICON.md) |
| stall | | holding an instruction in place for a cycle because something it needs is not ready | [chapter 4](learn/04_data_hazards.md) |
| SV | SystemVerilog | the hardware description language of `src/` | [`src/`](../src) |
| TAGE | TAgged GEometric history length predictor | a family of branch predictors with several history lengths, used in modern high-end cores | [MODERN_CPUS.md](MODERN_CPUS.md) |
| tohost | | a CSR a program writes to say it has finished (`halt` writes it) | [`model/asm.js`](../model/asm.js) |
| UART | Universal Asynchronous Receiver-Transmitter | the serial port the FPGA computer talks over | [FPGA.md](FPGA.md) |
| WSL | Windows Subsystem for Linux | runs the Linux tools of this repository on Windows | [README](../README.md#quick-start-ubuntu-or-wsl) |
| XOR | exclusive OR | 1 when exactly one of two bits is 1 | |
| Zicond | Integer conditional operations extension | RISC-V's `czero.eqz` and `czero.nez`, branch-free selects; one of the workshop's ideas | [CUSTOM_INSTRUCTIONS.md](CUSTOM_INSTRUCTIONS.md) |
| Zicsr | Control and Status Register instructions extension | `csrrw`, `csrrs`, `csrrc` and their immediate forms | [`model/isa.js`](../model/isa.js) |
