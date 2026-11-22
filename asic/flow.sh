#!/usr/bin/env bash
# =============================================================================
# asic/flow.sh: place and route the core with its SRAM caches on SkyWater sky130 (OpenROAD)
#
#   asic/flow.sh [corner|planned|auto] [clock_ns, default 30] [place|route, default route]
#                                                     (make asic-corner / asic-planned / asic-auto)
#
#   corner  : the 32 cache macros packed together in the lower-left corner (how the 32-bit prototype was laid out)
#   planned : each cache beside the pipeline stages that use it (asic/flow/macros.py has the arithmetic)
#   auto    : OpenROAD's automatic macro placer (macro_placement, after a first global placement) decides
#
# The three runs share everything else: the same netlist, die, pins, power grid, clock target and flow, so the
# differences in the reports come from where the macros are. Results: build/asic/<placement>/ (reports, DEF,
# and metrics.json; asic/flow/draw.py draws the DEF for docs/SILICON.md).
#
# Tools (any recent build): yosys, openroad, sv2v, and the sky130A PDK from open_pdks. Point at them with
#   YOSYS=... OPENROAD=... SV2V=... PDK_ROOT=<dir that holds sky130A>
# The SRAM macros are sram22 (BSD-3-Clause, asic/macros/LICENSE.sram22), included in asic/macros/.
# =============================================================================
set -euo pipefail
{ # bash reads a script as it runs it: the braces make it read all of it first, so editing this file mid-run is safe
cd "$(dirname "$0")/.."
PLACEMENT=${1:-planned}
CLOCK_NS=${2:-${CLOCK_NS:-30.0}}
STOP_AFTER=${3:-route}   # place: stop before global routing (metrics_placed.json only)
YOSYS=${YOSYS:-yosys}
OPENROAD=${OPENROAD:-openroad}
SV2V=${SV2V:-sv2v}
PDK_ROOT=${PDK_ROOT:-/usr/local/share/pdk}
export PDK_DIR=$PDK_ROOT/sky130A/libs.ref/sky130_fd_sc_hd
[ -d "$PDK_DIR" ] || { echo "sky130A not found under PDK_ROOT=$PDK_ROOT"; exit 1; }
mkdir -p build/asic

# ---------------------------------------------------------------- synthesis (once per source change)
NETLIST=build/asic/Sixfold_Silicon.v
SRCS="$(grep -v -e Scratchpad -e Riscv64_top src/sources.f) asic/src/Sixfold_Silicon.sv"
exec 9> build/asic/.synthesis.lock; flock 9   # runs of the three placements started together synthesize once
if [ ! -f $NETLIST ] || [ -n "$(find $SRCS asic/flow.sh -newer $NETLIST)" ]; then
  $SV2V $SRCS > build/asic/flat.v
  # the same cells pnr.tcl keeps the resizer away from (power-gating, probe and delay cells): ABC must not pick them either
  ABC_DONT_USE=$(grep -o 'cell ("sky130_fd_sc_hd__\(lpflow\|probe\|dlygate\|dlymetal\|clkdlybuf4s\)[^"]*' \
    $PDK_DIR/lib/sky130_fd_sc_hd__tt_025C_1v80.lib | sed 's/cell ("/-dont_use /' | tr '\n' ' ')
  cat > build/asic/synth.ys <<YS
read_verilog -lib asic/macros/sram22_64x32m4w8/sram22_64x32m4w8.v
read_verilog build/asic/flat.v
synth -top Sixfold_Silicon -flatten
dfflibmap -liberty $PDK_DIR/lib/sky130_fd_sc_hd__tt_025C_1v80.lib
abc -D $(awk "BEGIN{print int($CLOCK_NS*1000)}") -liberty $PDK_DIR/lib/sky130_fd_sc_hd__tt_025C_1v80.lib $ABC_DONT_USE
setundef -zero
hilomap -singleton -hicell sky130_fd_sc_hd__conb_1 HI -locell sky130_fd_sc_hd__conb_1 LO
splitnets -ports
opt_clean -purge
insbuf -buf sky130_fd_sc_hd__buf_2 A X
tee -o build/asic/synth_stat.txt stat -liberty $PDK_DIR/lib/sky130_fd_sc_hd__tt_025C_1v80.lib
write_verilog -noattr -noexpr -nohex -nodec $NETLIST
YS
  $YOSYS -q -l build/asic/synth.log -s build/asic/synth.ys > /dev/null
  grep -E 'Chip area|sram22' build/asic/synth_stat.txt
fi
flock -u 9

# ---------------------------------------------------------------- floorplan, place, clock tree, route
OUT=${OUT:-build/asic/$PLACEMENT}
mkdir -p $OUT
# run from a copy of asic/flow: OpenROAD reads a Tcl script as it goes, so editing asic/flow during a run cannot touch it
mkdir -p $OUT/flow && cp asic/flow/*.tcl asic/flow/*.py $OUT/flow/
PLACEMENT=$PLACEMENT CLOCK_NS=$CLOCK_NS STOP_AFTER=$STOP_AFTER OUT=$OUT NETLIST=$NETLIST FLOW_DIR=$PWD/$OUT/flow MACRO_DIR=$PWD/asic/macros/sram22_64x32m4w8 \
  $OPENROAD -no_init -exit $OUT/flow/pnr.tcl > $OUT/openroad.log 2>&1 || { tail -30 $OUT/openroad.log; exit 1; }
# the routed wire length, as FastRoute reports it after global routing
python3 - $OUT <<'PY'
import json, re, sys
out = sys.argv[1]
log = open(f'{out}/openroad.log').read()
# the reports, cut out of the log between the === markers that pnr.tcl prints
for name, body in re.findall(r'^=== BEGIN (\w+)\n(.*?)^=== END \1$', log, re.M | re.S):
    open(f'{out}/{name}.rpt', 'w').write(body)
print(open(f'{out}/metrics_placed.json').read())
if 'Total wirelength' not in log:
    sys.exit(0)  # stopped after placement
m = json.load(open(f'{out}/metrics.json'))
m['routed_wire_length_um'] = int(re.findall(r'Total wirelength:\s*(\d+)\s*um', log)[-1])
# global-route overflow: wire demand beyond the tracks available, summed over every routing tile (0 = routable)
m['global_route_overflow'] = int(re.findall(r'^Total\s+\d+\s+\d+\s+[\d.]+%\s+\d+ /\s*\d+ /\s*(\d+)', log, re.M)[-1])
json.dump(m, open(f'{out}/metrics.json', 'w'), indent=1)
print(json.dumps(m, indent=1))
PY
exit
}
