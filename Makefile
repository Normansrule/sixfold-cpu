# =============================================================================
# Sixfold: every command in one place.        `make help`
# =============================================================================
PROG ?= 05_fibonacci
BP   ?= 1
HIST ?= 6
CONFIG ?= performance
SRC   = $(firstword $(wildcard programs/$(PROG).s tests/$(PROG).s fpga/examples/$(PROG).s $(PROG)))
RTL   = $(shell cat src/sources.f)
NAME  = $(basename $(notdir $(SRC)))
LIB   = build/sky130_hd_tt.lib
LIB_URL = https://raw.githubusercontent.com/The-OpenROAD-Project/OpenROAD-flow-scripts/master/flow/platforms/sky130hd/lib/sky130_fd_sc_hd__tt_025C_1v80.lib
SV2V_URL = https://github.com/zachjs/sv2v/releases/download/v0.0.13/sv2v-Linux.zip
MODULES = GSharePredictor BranchComparator BranchControl ALU ImmediateGenerator ControlUnit LoadControl StoreControl RegisterFile CSRFile
BPFLAG = $(if $(filter 0,$(BP)),--bp=off) --history=$(HIST) --config=$(CONFIG)

TBDEF = $(if $(filter baseline,$(CONFIG)),-DBASELINE)
FPGA_RTL = $(filter-out src/Scratchpad_Memory.sv src/Riscv64_top.sv,$(RTL)) $(shell cat fpga/sources.f)
.PHONY: check-links fpga-virtual fpga-load-test fpga-sim fpga-image fpga-ulx3s fpga-arty fpga-basys3 fpga-lint arena timing help deps test test-model math run pipe bp cycle rtl vsim wave lint docs charts diagram diagrams animations schematics synth serve clean

help:            ## list targets
	@grep -E '^[a-z0-9-]+:.*##' Makefile | sed 's/:.*##/\t/' | expand -t 14
	@echo "\nvariables: PROG=<name in programs/, tests/ or fpga/examples/> (default $(PROG))  BP=1|0  HIST=<history bits> (default 6)  CONFIG=performance|baseline"

deps:            ## install Ubuntu packages (needs sudo)
	sudo apt-get update
	sudo apt-get install -y nodejs npm iverilog verilator gtkwave yosys graphviz librsvg2-bin python3-serial make git curl unzip

test:            ## full regression: both builds, predictor on and off, RTL vs model cycle-exact (Verilator, else Icarus)
	node tools/test.mjs

test-model:      ## regression without a Verilog simulator (model only)
	node tools/test.mjs --no-rtl

math:            ## verify cycles = N + 5 + L + 3F + R + K + I + D + X on every program, both builds
	node tools/verify_math.mjs

run:             ## run PROG on the model:   make run PROG=09_primes_sieve BP=0
	node tools/rv.mjs run $(SRC) $(BPFLAG)

pipe:            ## ASCII pipeline chart of PROG
	node tools/rv.mjs pipe $(SRC) --cycles 48 $(BPFLAG)

bp:              ## predictor off vs gshare with 1..12 history bits on PROG (CONFIG=baseline for the baseline build)
	node tools/rv.mjs bp $(SRC) --config=$(CONFIG)

cycle:           ## explain one cycle:        make cycle PROG=03_load_use C=5
	node tools/rv.mjs cycle $(SRC) $(C) $(BPFLAG)

build/sim.vvp: $(RTL) tb/riscv64_testbench.sv
	@mkdir -p build
	iverilog -g2012 $(TBDEF) -o $@ $(RTL) tb/riscv64_testbench.sv

rtl: build/sim.vvp  ## run PROG on the SystemVerilog RTL (Icarus Verilog)
	@mkdir -p build
	node tools/rv.mjs asm $(SRC) -o build/$(NAME)
	vvp -n build/sim.vvp +HEX=build/$(NAME).hex +TRACE=build/$(NAME).rtl.trace +BP=$(BP)
	@echo "per-cycle pipeline trace: build/$(NAME).rtl.trace"

build/vsim/vsim: $(RTL) tb/riscv64_testbench.sv
	verilator --binary --timing -O3 -Wno-fatal -Wno-lint -Wno-style $(TBDEF) $(RTL) tb/riscv64_testbench.sv --top-module riscv64_testbench -Mdir build/vsim -o vsim

vsim: build/vsim/vsim  ## run PROG on the Verilator-compiled RTL (much faster)
	node tools/rv.mjs asm $(SRC) -o build/$(NAME)
	./build/vsim/vsim +HEX=build/$(NAME).hex +BP=$(BP)

wave: build/sim.vvp  ## dump waveforms of PROG and open GTKWave with the pipeline view
	node tools/rv.mjs asm $(SRC) -o build/$(NAME)
	vvp -n build/sim.vvp +HEX=build/$(NAME).hex +VCD=build/$(NAME).vcd +BP=$(BP)
	gtkwave build/$(NAME).vcd docs/gtkwave/pipeline.gtkw &

lint:            ## Verilator lint (all warnings except naming style and intentionally unused bits)
	verilator --lint-only -Wall -Wno-DECLFILENAME -Wno-IMPORTSTAR -Wno-UNUSEDPARAM -Wno-UNUSEDSIGNAL $(RTL) --top-module riscv64_top

fpga-lint:       ## Verilator lint of the FPGA system (core + block RAM memory + UART + devices) and the Basys 3 / Arty board tops
	verilator --lint-only -Wall -DSIXFOLD_FPGA -Wno-DECLFILENAME -Wno-IMPORTSTAR -Wno-UNUSEDPARAM -Wno-UNUSEDSIGNAL $(FPGA_RTL) --top-module SixfoldSystem
	verilator --lint-only -Wall -DSIXFOLD_FPGA -Wno-DECLFILENAME -Wno-IMPORTSTAR -Wno-UNUSEDPARAM -Wno-UNUSEDSIGNAL -Wno-PINCONNECTEMPTY -Wno-MULTITOP $(FPGA_RTL) fpga/sim/xilinx_lint_stubs.sv fpga/boards/basys3/basys3_top.sv --top-module basys3_top
	verilator --lint-only -Wall -DSIXFOLD_FPGA -Wno-DECLFILENAME -Wno-IMPORTSTAR -Wno-UNUSEDPARAM -Wno-UNUSEDSIGNAL -Wno-PINCONNECTEMPTY -Wno-MULTITOP $(FPGA_RTL) fpga/sim/xilinx_lint_stubs.sv fpga/boards/arty_a7/arty_a7_top.sv --top-module arty_a7_top

fpga-sim:        ## the FPGA system in simulation: boot firmware, UART upload, run, report; cycles checked against the model
	node tools/fpga_sim.mjs

fpga-virtual:    ## a virtual board on a pseudo serial port, PROG in memory: talk to it with fpga_load.py or screen
	python3 tools/virtual_board.py --program $(SRC) --show

fpga-load-test:  ## tools/fpga_load.py against a virtual board: load, run and check PASS for a few programs (needs pyserial)
	python3 tools/virtual_board.py --test programs/01_hello.s programs/09_primes_sieve.s programs/21_timer_interrupts.s programs/22_multitasking.s

fpga-image:      ## block RAM image for the boards: firmware + PROG (build/fpga/memory.hex)
	node tools/fpga_image.mjs $(SRC) --out build/fpga

fpga-ulx3s:      ## bitstream for the ULX3S (ECP5-85F) with yosys + nextpnr-ecp5 + ecppack: build/ulx3s/sixfold.bit
	./fpga/boards/ulx3s/build.sh $(SRC)

fpga-arty:       ## bitstream for the Arty A7-100T with Vivado: build/arty_a7/sixfold.bit
	node tools/fpga_image.mjs $(SRC) --out build/arty_a7
	vivado -mode batch -nojournal -nolog -source fpga/boards/arty_a7/build.tcl

fpga-basys3:     ## bitstream for the Digilent Basys 3 with Vivado: build/basys3/sixfold.bit (try PROG=calculator)
	node tools/fpga_image.mjs $(SRC) --out build/basys3
	vivado -mode batch -nojournal -nolog -source fpga/boards/basys3/build.tcl

docs:            ## regenerate binary/, docs/img/{formats,instructions,pipeline}, web/programs.js
	node tools/gendocs.mjs

charts:          ## CPI stack and predictor sweep charts (docs/img/charts)
	node tools/charts.mjs

arena:           ## branch predictor arena: BHT, gshare, tournament, perceptron, TAGE on every program's real branches
	node tools/predictor_arena.mjs

diagram:         ## datapath block diagram (docs/img/cpu_block_diagram.svg)
	node tools/blockdiagram.mjs

diagrams:        ## detailed figures: front end, cache, memory, multiplier, operands and ALU, counters, clock roadmap (docs/img/diagrams)
	node tools/diagrams.mjs

animations:      ## animated SVGs for the README and the site (docs/img/animations)
	node tools/animations.mjs

timing:          ## logic-only sky130 timing of both builds (sv2v + Yosys + ABC): see docs/PERFORMANCE.md
	./tools/timing.sh performance
	./tools/timing.sh baseline

$(LIB):
	@mkdir -p build
	curl -sL -o $@ $(LIB_URL)

build/sv2v:
	@mkdir -p build
	curl -sL -o build/sv2v.zip $(SV2V_URL) && unzip -qo build/sv2v.zip -d build && cp build/sv2v-Linux/sv2v build/sv2v

build/synth/flat.v: build/sv2v $(RTL)
	@mkdir -p build/synth
	./build/sv2v $(filter-out src/Scratchpad_Memory.sv src/Riscv64_top.sv,$(RTL)) > $@

synth: build/synth/flat.v $(LIB)  ## synthesize each module onto real SkyWater sky130 cells (sv2v + Yosys)
	@for top in $(MODULES); do \
	  printf 'read_verilog build/synth/flat.v\nsynth -top %s -flatten\ndfflibmap -liberty $(LIB)\nabc -liberty $(LIB)\nopt_clean\ntee -q -o build/synth/%s.stat stat -liberty $(LIB)\n' $$top $$top > build/synth/$$top.ys; \
	  yosys -q -s build/synth/$$top.ys > /dev/null 2>&1; \
	  printf '%-20s %12s um2\n' $$top "$$(grep 'Chip area' build/synth/$$top.stat | awk '{print $$NF}')"; \
	done

schematics: build/synth/flat.v  ## Yosys schematics of small modules (docs/img/schematics, needs graphviz)
	@mkdir -p docs/img/schematics
	yosys -q -p "read_verilog build/synth/flat.v; chparam -set HISTORY_BITS 2 GSharePredictor; hierarchy -top GSharePredictor; proc; opt -full; clean; show -format svg -width -stretch -prefix docs/img/schematics/gshare_2bit GSharePredictor"
	yosys -q -p "read_verilog build/synth/flat.v; hierarchy -top BranchControl; proc; opt -full; clean; show -format svg -width -stretch -prefix docs/img/schematics/branch_control BranchControl"
	rm -f docs/img/schematics/*.dot

check-links:     ## every relative link, image and #anchor in the Markdown and HTML files resolves
	node tools/check_links.mjs

serve:           ## the site at http://localhost:8000/ and the lab at http://localhost:8000/web/
	@echo "open http://localhost:8000/ (site) or http://localhost:8000/web/ (lab)   Ctrl+C to stop"
	python3 -m http.server 8000

clean:           ## remove build outputs
	rm -rf build
