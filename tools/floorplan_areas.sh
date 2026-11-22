#!/usr/bin/env bash
# =============================================================================
# tools/floorplan_areas.sh: the measured inputs of the floorplan (tools/floorplan.py)
#
#   tools/floorplan_areas.sh [block ...]   (make floorplan runs it when build/floorplan/areas.json is missing;
#                                          with block names, only those are synthesized again)
#
# Synthesizes every block of the turbo edition separately onto the SkyWater sky130 high-density cells
# (sv2v -> Yosys -> ABC, area-oriented, the same commands as `make synth`) and writes the cell area of each,
# plus the size of every memory array in the two caches, to build/floorplan/areas.json.
# The cache arrays are NOT kept as flip-flops here: on a chip they are SRAM macros (tools/floorplan.py places
# real sram22 macros for them), so their bits are counted and only the cache controllers' logic is synthesized.
# Removing the arrays also removes their read multiplexers, which the macros contain.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
LIB=build/sky130_hd_tt.lib
[ -f "$LIB" ] || curl -sL -o "$LIB" https://raw.githubusercontent.com/The-OpenROAD-Project/OpenROAD-flow-scripts/master/flow/platforms/sky130hd/lib/sky130_fd_sc_hd__tt_025C_1v80.lib
[ -x build/sv2v ] || ./tools/timing.sh turbo sky130 > /dev/null    # fetches sv2v
mkdir -p build/floorplan
./build/sv2v $(grep -v -e Scratchpad -e Riscv64_top src/sources.f) > build/floorplan/flat.v

# block name | top module | chparam arguments | cache (1: keep the arrays out)
BLOCKS=(
  "register_file|RegisterFile||0"
  "alu|ALU|-set FAST_ALU 1|0"
  "multiply_divide|FastMultiplyDivideUnit||0"
  "custom_unit|CustomUnit||0"
  "csr_file|CSRFile||0"
  "gshare|GSharePredictor|-set HISTORY_BITS 6|0"
  "tournament|TournamentChooser|-set INDEX_BITS 7|0"
  "btb|BranchTargetBuffer|-set ENTRIES 16|0"
  "return_stack|ReturnAddressStack|-set DEPTH 8|0"
  "core|Riscv64|-set FAST_MULTIPLY_DIVIDE 1 -set LATE_BRANCH_RESOLVE 1 -set FAST_ALU 1 -set FAST_FETCH_TARGET 1 -set FAST_STALL 1 -set FAST_LOAD_ALIGN 1|0"
  "icache_control|InstructionCache|-set STREAM_PREFETCH 1|1"
  "dcache_control|DataCache||1"
)
for b in "${BLOCKS[@]}"; do
  IFS='|' read -r name top params cache <<< "$b"
  [ $# -gt 0 ] && [[ " $* " != *" $name "* ]] && [ -f build/floorplan/$name.stat ] && continue   # only the blocks named on the command line
  ys=build/floorplan/$name.ys
  {
    echo "read_verilog build/floorplan/flat.v"
    [ -n "$params" ] && echo "chparam $params $top"
    if [ "$cache" = 1 ]; then
      # the arrays (WAY0_DATA, WAY1_TAG, ...) are written as flip-flops in the RTL: count their bits, then delete
      # them, so their read multiplexers go too, and synthesize what is left (the controller)
      echo "synth -top $top -flatten -run begin:map_ffram"
      echo "select -set data w:*WAY?_DATA*"
      echo "select -set tag w:*WAY?_TAG*"
      echo "tee -q -o build/floorplan/$name.databits select -count @data %ci1 t:\$_DFFE_PP_ %i"
      echo "tee -q -o build/floorplan/$name.tagbits select -count @tag %ci1 t:\$_DFFE_PP_ %i"
      echo "delete @data %ci1 t:\$_DFFE_PP_ %i"
      echo "delete @tag %ci1 t:\$_DFFE_PP_ %i"
      echo "opt_clean"
      echo "synth -top $top -run map_ffram:"
    else
      echo "synth -top $top -flatten"
    fi
    echo "dfflibmap -liberty $LIB"
    echo "abc -liberty $LIB"
    echo "opt_clean"
    echo "tee -q -o build/floorplan/$name.stat stat -liberty $LIB"
  } > "$ys"
  yosys -q -s "$ys" > build/floorplan/$name.log 2>&1
  area=$(grep 'Chip area' build/floorplan/$name.stat | awk '{print $NF}')
  printf '%-16s %12s um2\n' "$name" "$area"
done
# collect: build/floorplan/<block>.stat (and, for the caches, the counted array bits) -> areas.json
python3 - "${BLOCKS[@]}" <<'PY'
import json, re, sys
out = {}
for b in sys.argv[1:]:
    name, top, params, cache = b.split('|')
    area = float(re.search(r'Chip area.*?([\d.]+)\s*$', open(f'build/floorplan/{name}.stat').read(), re.M).group(1))
    out[name] = {'module': top, 'parameters': params, 'area_um2': area}
    if cache == '1':
        for kind in ('data', 'tag'):
            out[name][f'{kind}_bits'] = int(re.search(r'(\d+)', open(f'build/floorplan/{name}.{kind}bits').read()).group(1))
json.dump(out, open('build/floorplan/areas.json', 'w'), indent=1)
print(json.dumps(out, indent=1))
PY
