# References

Numbers in **[brackets]** are used throughout the repo. Every design decision here follows a
published source; this page says which.

## Specification

**[1]** A. Waterman, K. Asanović (eds.), *The RISC-V Instruction Set Manual, Volume I:
Unprivileged Architecture*, RISC-V International. Source and releases:
https://github.com/riscv/riscv-isa-manual (ratified release `20240411`:
https://github.com/riscv/riscv-isa-manual/releases/tag/20240411).
Used for: every encoding in `model/isa.js` and `binary/`, the Zicsr instructions and the `cycle`/`instret` counters, RV64 "W" semantics, M-extension
division-by-zero and overflow results, the placement of the immediate sign bit.

## Textbooks

**[2]** D. A. Patterson, J. L. Hennessy, *Computer Organization and Design RISC-V Edition:
The Hardware/Software Interface*, 2nd ed., Morgan Kaufmann, 2020. Ch. 1 (performance, the
CPU time equation), ch. 4 (the processor: pipelined datapath, forwarding, load-use stalls,
control hazards, dynamic branch prediction). The 5-stage pipeline this design extends to 6.

**[3]** J. L. Hennessy, D. A. Patterson, *Computer Architecture: A Quantitative Approach*,
6th ed., Morgan Kaufmann, 2017. Ch. 1 (quantitative principles, processor performance
equation), ch. 3 (branch prediction: 2-bit counters, correlating/gshare, tournament predictors,
branch target buffers), Appendix C (pipelining: basic and intermediate concepts).

**[4]** S. L. Harris, D. Harris, *Digital Design and Computer Architecture: RISC-V Edition*,
Morgan Kaufmann, 2021. Ch. 7 (single-cycle, multicycle and pipelined RISC-V microarchitectures
drawn at the Register Transfer Level, with HDL).

## Instruction set manuals

Used for the MIPS and x86-64 models ([ISA_COMPARISON.md](ISA_COMPARISON.md)).

* *The RISC-V Instruction Set Manual, Volume I: Unprivileged ISA* (RISC-V International), the chapter
  "Extending RISC-V" and the opcode map: the four custom opcodes and how non-standard extensions may use
  them ([CUSTOM_INSTRUCTIONS.md](CUSTOM_INSTRUCTIONS.md)). The Zicond chapter describes `czero.eqz`.
* *MIPS32 Architecture for Programmers, Volume II: The MIPS32 Instruction Set* (MIPS Technologies /
  Imagination). Every MIPS32 encoding, the delay slot, HI and LO.
* *Intel 64 and IA-32 Architectures Software Developer's Manual (SDM)*, Volume 2 (instruction set
  reference): the encoding tables (REX, ModRM, SIB) and every instruction. Volume 1 for the flags.
* *Intel 64 and IA-32 Architectures Optimization Reference Manual*: macro-fusion rules and the stack
  engine (Lab 24).
* Andrew Waterman, *Design of the RISC-V Instruction Set Architecture*, PhD thesis, 2016: why RISC-V
  left out delay slots, condition codes and variable-length decoding, with measurements against MIPS and
  x86-64.
* John L. Hennessy and David A. Patterson, *Computer Architecture: A Quantitative Approach*, appendix A
  (instruction set principles) and appendix K (a survey of instruction sets).
* [Unicorn](https://www.unicorn-engine.org/) (CPU emulator built on QEMU) and
  [Capstone](https://www.capstone-engine.org/) (disassembler): the independent references
  `tools/isa_crosscheck.py` compares against.

## Branch prediction papers

**[5]** J. E. Smith, "A Study of Branch Prediction Strategies," *Proc. 8th International
Symposium on Computer Architecture (ISCA)*, pp. 135-148, 1981. The 2-bit saturating counter.

**[6]** T.-Y. Yeh, Y. N. Patt, "Two-Level Adaptive Training Branch Prediction," *Proc. 24th
International Symposium on Microarchitecture (MICRO-24)*, 1991. Branch history registers indexing
pattern tables: the idea gshare builds on.

**[7]** S. McFarling, "Combining Branch Predictors," Digital Equipment Corporation Western
Research Laboratory, Technical Note TN-36, June 1993.
https://inst.eecs.berkeley.edu/~cs252/sp17/papers/McFarling-WRL-TN-36.pdf
(mirror: https://www.ece.ucdavis.edu/~akella/270W05/mcfarling93combining.pdf).
Introduces **gshare** (global history XOR address) and the combined (tournament) predictor.
This is the predictor in `src/GShare_Branch_Predictor.sv`.

**[8]** A. Seznec, P. Michaud, "A case for (partially) TAgged GEometric history length branch
prediction," *Journal of Instruction-Level Parallelism*, vol. 8, 2006.
https://www.jilp.org/vol8/v8paper1.pdf. TAGE: the basis of most modern high-end predictors.

**[9]** D. A. Jiménez, C. Lin, "Dynamic Branch Prediction with Perceptrons," *Proc. 7th
International Symposium on High-Performance Computer Architecture (HPCA)*, 2001. A branch
predictor that is a small neural network: one perceptron per branch, trained online.

**[10]** K. Skadron, M. Martonosi, D. W. Clark, "Speculative Updates of Local and Global Branch
History: A Quantitative Analysis," *Journal of Instruction-Level Parallelism*, vol. 2, 2000.
Why real machines update history at prediction time and repair it: the checkpoint scheme in `GSharePredictor` (see ARCHITECTURE.md, FETCH2).

## Real RISC-V cores and chips to compare with

**[11]** F. Zaruba, L. Benini, "The Cost of Application-Class Processing: Energy and Performance
Analysis of a Linux-Ready 1.7-GHz 64-Bit RISC-V Core in 22-nm FDSOI Technology," *IEEE
Transactions on VLSI Systems*, vol. 27, no. 11, pp. 2629-2640, Nov. 2019,
doi:10.1109/TVLSI.2019.2926114. Preprint with die floorplan: https://arxiv.org/pdf/1904.05442.
Ariane (now CVA6): a **6-stage, single-issue, in-order RV64** core, the closest real relative of
this design, taped out in GlobalFoundries 22FDX on a 3 mm x 3 mm die.

**[12]** OpenHW Group, *CORE-V CVA6*, https://github.com/openhwgroup/cva6. Open-source
SystemVerilog of the core in [11], including its branch history table, branch target buffer and
return-address stack.

**[13]** C. Celio, P.-F. Chiu, K. Asanović, B. Nikolić, D. Patterson, "BROOM: An open-source
Out-of-Order processor with resilient low-voltage operation in 28nm CMOS," Hot Chips 30, 2018.
Slides: https://old.hotchips.org/hc30/1conf/1.03_Berkeley_BROOM_HC30.Berkeley.Celio.v02.pdf.
Journal version: IEEE Xplore document 8634812, https://ieeexplore.ieee.org/document/8634812/.

**[14]** The Berkeley Out-of-Order Machine (BOOM), https://boom-core.org/ and publications at
https://boom-core.org/boom-publications/. What an out-of-order RV64 core adds beyond this design.

**[15]** K. Asanović et al., "The Rocket Chip Generator," Technical Report UCB/EECS-2016-17,
UC Berkeley, 2016. Rocket: the classic 5-stage in-order RV64 core.

## Learning resources

All in English.

**[16]** C. Terman, *6.004 Computation Structures*, MIT OpenCourseWare, Spring 2017.
https://ocw.mit.edu/courses/6-004-computation-structures-spring-2017/ . Pipelining, hazards,
CPI = CPI_ideal + CPI_stall (lecture 21 and the "Pipelining the Beta" unit). Lecture archive:
https://computation-structures.github.io/course/ .

**[17]** MIT 6.004 (RISC-V version), Fall 2019, full lecture playlist:
https://www.youtube.com/playlist?list=PL0MxyGPHXXYIPmeYPTyPwqNAl6cgkl3d3 (English).

**[18]** Arvind et al., *6.175 Constructive Computer Architecture*, MIT. Builds pipelined RISC-V
processors with branch target buffers and branch history tables step by step:
http://csg.csail.mit.edu/6.175/ . Its 6-stage pipeline lab:
https://csg.csail.mit.edu/6.175/labs/lab6-riscv-pipeline.html .

**[22]** UC Berkeley CS 61C, *Great Ideas in Computer Architecture (Machine Structures)*,
https://cs61c.org/ . RISC-V assembly, the single-cycle and pipelined datapath (English lectures and labs).

**[23]** UCSD CSE 141L branch prediction tutorial, https://cseweb.ucsd.edu/classes/fa04/cse141L/bp_tutorial.pdf ,
and the OpenRISC mor1kx gshare predictor,
https://github.com/openrisc/mor1kx/blob/master/rtl/verilog/mor1kx_branch_predictor_gshare.v .
Both are cited in `GShare_Branch_Predictor.sv`.

## Adders (the critical path)

**[24]** P. M. Kogge, H. S. Stone, "A Parallel Algorithm for the Efficient Solution of a General
Class of Recurrence Equations," *IEEE Transactions on Computers*, vol. C-22, no. 8, 1973.

**[25]** R. P. Brent, H. T. Kung, "A Regular Layout for Parallel Adders," *IEEE Transactions on
Computers*, vol. C-31, no. 3, 1982. The two classic parallel-prefix adders for Lab 8.

## Tools

**[19]** Icarus Verilog (https://steveicarus.github.io/iverilog/), Verilator
(https://www.veripool.org/verilator/), GTKWave (https://gtkwave.sourceforge.net/),
Yosys (https://yosyshq.net/yosys/).

**[20]** SkyWater SKY130 open process design kit, https://github.com/google/skywater-pdk ;
OpenLane RTL-to-GDSII flow, https://github.com/The-OpenROAD-Project/OpenLane ; Tiny Tapeout,
https://tinytapeout.com/ . How an RTL design like this one becomes real silicon; see
[SILICON.md](SILICON.md).

**[26]** sky130 high-density standard-cell library (layouts used in SILICON.md, Apache-2.0):
https://github.com/google/skywater-pdk-libs-sky130_fd_sc_hd (mirror used by `make synth`: the
OpenROAD-flow-scripts `sky130hd` platform). sram22 SRAM generator:
https://github.com/rahulk29/sram22 . sv2v SystemVerilog-to-Verilog converter:
https://github.com/zachjs/sv2v . Hammer VLSI flow: https://github.com/ucb-bar/hammer .
OpenROAD-flow-scripts: https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts .

**[27]** riscv-tests (the tohost PASS/FAIL convention used here):
https://github.com/riscv-software-src/riscv-tests .

**[28]** R. E. Kessler, "The Alpha 21264 Microprocessor," *IEEE Micro*, vol. 19, no. 2, 1999. The
tournament (local + global + chooser) branch predictor used by `TournamentChooser`.

**[29]** L. T. Clark et al., "ASAP7: A 7-nm finFET predictive process design kit," *Microelectronics
Journal*, vol. 53, 2016. The 7 nm-class library used by `tools/timing.sh ... asap7`; liberty files from
https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts (platforms/asap7).

**[31]** A. Waterman, K. Asanović (eds.), *The RISC-V Instruction Set Manual, Volume II: Privileged Architecture*, https://github.com/riscv/riscv-isa-manual . Machine-mode traps: `mtvec`, `mepc`, `mcause`, `mstatus`, `mret` (used by `CSRFile`).

**[30]** A. J. Smith, "Cache Memories," *ACM Computing Surveys*, vol. 14, no. 3, 1982. Direct-mapped
caches, write-through, and sequential (next-line) prefetching.

**[34]** J.-L. Baer, T.-F. Chen, "An Effective On-Chip Preloading Scheme to Reduce Data Access Penalty,"
*Supercomputing '91*, 1991. Stride prefetching; next-line prefetching goes back to A. J. Smith [30].

**[35]** WikiChip, "Zen 2 - Microarchitectures - AMD," https://en.wikichip.org/wiki/amd/microarchitectures/zen_2 .
Zen/Zen+ use a hashed perceptron predictor; Zen 2 keeps it and adds a TAGE predictor, with about 30%
fewer mispredictions according to AMD.

**[36]** A. Seznec, "TAGE-SC-L Branch Predictors Again," *5th Championship Branch Prediction (CBP-5)*,
2016. The TAGE family with a statistical corrector and loop predictor; winner of CBP-5.

**[37]** C.-L. Lin et al., "Dissecting Conditional Branch Predictors of Apple Firestorm and Qualcomm
Oryon," arXiv:2411.13900, 2024. Notes TAGE use in AMD Zen 2, ARM and Intel cores.

**[38]** A. Seznec, "A 64-Kbytes ITTAGE indirect branch predictor," *2nd JILP Workshop on Computer
Architecture Competitions (JWAC-2)*, 2011.

**[39]** Intel, *Intel 64 and IA-32 Architectures Optimization Reference Manual*,
https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html . Describes the
decoded instruction cache (micro-op cache), the loop stream detector and macro-fusion.

**[40]** R. M. Tomasulo, "An Efficient Algorithm for Exploiting Multiple Arithmetic Units," *IBM
Journal of Research and Development*, vol. 11, no. 1, 1967.

**[41]** J. E. Smith, A. R. Pleszkun, "Implementation of Precise Interrupts in Pipelined Processors,"
*ISCA*, 1985. The reorder buffer.

**[42]** G. Z. Chrysos, J. S. Emer, "Memory Dependence Prediction using Store Sets," *ISCA*, 1998.

**[43]** D. M. Tullsen, S. J. Eggers, H. M. Levy, "Simultaneous Multithreading: Maximizing On-Chip
Parallelism," *ISCA*, 1995.


**[44]** C. S. Wallace, "A Suggestion for a Fast Multiplier," *IEEE Transactions on Electronic
Computers*, vol. EC-13, no. 1, 1964. The carry-save (3:2 compressor) tree used in
`src/Carry_Save_Multiplier.sv`.

**[45]** L. Dadda, "Some Schemes for Parallel Multipliers," *Alta Frequenza*, vol. 34, 1965. The
variant of the tree that uses the fewest adders.

**[46]** V. G. Oklobdzija, "An Algorithmic and Novel Design of a Leading Zero Detector Circuit:
Comparison with Logic Synthesis," *IEEE Transactions on VLSI Systems*, vol. 2, no. 1, 1994. The
leading-zero counter tree in `src/Iterative_Multiply_Divide_Unit.sv`.

**[47]** A. Mishchenko, R. Brayton, S. Jang, V. Kravets, "Delay Optimization Using SOP Balancing,"
*ICCAD*, 2011. The delay-oriented restructuring (`&if -g`) used by `tools/timing.sh`.

**[48]** M. S. Hrishikesh, N. P. Jouppi, K. I. Farkas, D. Burger, S. W. Keckler, P. Shivakumar, "The
Optimal Logic Depth per Pipeline Stage is 6 to 8 FO4 Inverter Delays," *ISCA*, 2002. Why fast clocks
need deep pipelines.

**[49]** RISC-V International, *RISC-V Bit-Manipulation ISA-extensions*, version 1.0.0, 2021,
https://github.com/riscv/riscv-bitmanip/releases . The Zba, Zbb, Zbc and Zbs extensions: every encoding
used in `model/isa.js`.

**[50]** RISC-V International, *RVA23 Profile*, 2024, https://github.com/riscv/riscv-profiles . The set of
extensions an application-class RISC-V processor is expected to have (RVA22 requires Zba, Zbb and Zbs;
RVA23 requires the whole B extension).

**[51]** A. Yasin, "A Top-Down Method for Performance Analysis and Counters Architecture," *IEEE
International Symposium on Performance Analysis of Systems and Software (ISPASS)*, 2014. How Intel
cores break cycles down into categories from hardware counters (the idea behind hpmcounter3..9 here).

**[52]** RISC-V International, *The RISC-V Instruction Set Manual, Volume II: Privileged Architecture*,
and the *RISC-V Platform Specification* drafts, https://github.com/riscv/riscv-isa-manual . Reset vectors,
memory-mapped I/O and machine-mode firmware as RISC-V systems define them (the model for `fpga/`).

**[53]** Lattice Semiconductor, *ECP5 and ECP5-5G Family Data Sheet* (FPGA-DS-02012),
https://www.latticesemi.com/Products/FPGAandCPLD/ECP5 . LUT4 slices, CCU2C carry chains, DP16KD block RAM,
EHXPLLL PLLs: the resources `fpga/boards/ulx3s/build.sh` maps Sixfold onto.

**[54]** AMD (Xilinx), *7 Series FPGAs Data Sheet: Overview* (DS180), *Artix-7 FPGAs Data Sheet: DC and AC
Switching Characteristics* (DS181), *7 Series FPGAs Memory Resources* (UG473), *7 Series FPGAs Clocking
Resources* (UG472), https://docs.amd.com . The Arty A7-100T build.

**[55]** C. Wolf, D. Shah et al., *Yosys*, *nextpnr* and *Project Trellis*, https://github.com/YosysHQ . The
open-source synthesis, place-and-route and bitstream tools used for the ULX3S build, including the
timing report quoted in [FPGA.md](FPGA.md).

**[56]** Radiona.org, *ULX3S* (open hardware), https://github.com/emard/ulx3s ; Digilent, *Arty A7 Reference
Manual*, https://digilent.com/reference/programmable-logic/arty-a7/reference-manual . The boards
summarized in [boards/ULX3S.md](boards/ULX3S.md) and [boards/ARTY_A7.md](boards/ARTY_A7.md).

**[57]** RISC-V International, *RISC-V Advanced Core Local Interruptor (ACLINT) Specification* and the
machine timer (`mtime`, `mtimecmp`) in the Privileged Architecture, https://github.com/riscv/riscv-aclint .
The memory-mapped timer that `MTIME` / `MTIMECMP` model, and the interrupt enables (`mie`), pending bits
(`mip`) and causes (`mcause` with bit 63 set) used by `programs/21_timer_interrupts.s`.

**[58]** J. E. Smith and A. R. Pleszkun, "Implementing Precise Interrupts in Pipelined Processors," *IEEE
Transactions on Computers*, 37(5), 1988. Why an interrupt must look as if it happened between two
instructions, and the reorder-buffer technique out-of-order cores use for it.

**[59]** Digilent, *Basys 3 Reference Manual*, https://digilent.com/reference/programmable-logic/basys-3/reference-manual ,
and *Basys-3-Master.xdc*, https://github.com/Digilent/digilent-xdc . The XC7A35T board with 16 switches,
16 LEDs, 5 buttons and a multiplexed four-digit display, summarized in [boards/BASYS3.md](boards/BASYS3.md).
AMD (Xilinx), *7 Series DSP48E1 Slice User Guide* (UG479), https://docs.amd.com : the hard multipliers the
FPGA build's multiply step uses.

