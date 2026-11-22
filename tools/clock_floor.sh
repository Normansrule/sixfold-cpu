#!/usr/bin/env bash
# =============================================================================
# tools/clock_floor.sh: how fast can any single-issue pipeline built from these standard cells go?
#
#   tools/clock_floor.sh            (make clock-floor)
#
# 1. The ALU-bypass loop (tools/clock_floor/alu_bypass_loop.sv) at 64, 32 and 16 bits, logic only, on the
#    ASAP7 7 nm-class library with the same sv2v -> Yosys -> ABC flow as tools/timing.sh.
# 2. The flip-flop's own share of every cycle, read from the ASAP7 flip-flop library (DFFHQNx1, typical
#    corner): clock-to-output delay plus setup time, at a 10 ps input slew and a light load.
# The cycle time of a pipeline whose slowest stage is this loop is then (loop + flip-flop) ps.
# Wire delay and clock skew are not included (see docs/PERFORMANCE.md, "The road to 5 GHz").
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f build/asap7/asap7_merged_tt.lib ] && [ -x build/sv2v ] || ./tools/timing.sh performance asap7 > /dev/null   # fetches the ASAP7 libraries and sv2v
SEQ=build/asap7/asap7sc7p5t_SEQ_RVT_TT_nldm_220123.lib
[ -f "$SEQ" ] || curl -sL -o "$SEQ" https://raw.githubusercontent.com/The-OpenROAD-Project/OpenROAD-flow-scripts/master/flow/platforms/asap7/lib/NLDM/asap7sc7p5t_SEQ_RVT_TT_nldm_220123.lib
mkdir -p build/synth
./build/sv2v src/Parallel_Prefix_Adder.sv tools/clock_floor/alu_bypass_loop.sv > build/synth/clock_floor.v
for m in loop64 loop32 loop16; do
  printf 'read_verilog build/synth/clock_floor.v\nsynth -noabc -noshare -top %s -flatten\nabc -D 100 -liberty build/asap7/asap7_merged_tt.lib -script build/synth/abc_timing.scr\n' $m > build/synth/clock_floor_$m.ys
  yosys -q -l build/synth/clock_floor_$m.log -s build/synth/clock_floor_$m.ys > /dev/null 2>&1
  printf '%-7s logic %6.1f ps\n' $m "$(grep 'Delay =' build/synth/clock_floor_$m.log | tail -1 | sed -E 's/.*Delay = *([0-9.]+) ps.*/\1/')"
done
python3 - "$SEQ" <<'PY'
import re, sys
s = open(sys.argv[1]).read()
i = s.index('cell (DFFHQNx1_ASAP7_75t_R)'); c = s[i:s.index('cell (', i + 10)]
def table(text, kind):
    m = re.search(kind + r'\s*\([^)]*\)\s*\{(.*?)\}', text, re.S)
    rows = re.findall(r'"([^"]*)"', re.search(r'values\s*\((.*?)\);', m.group(1), re.S).group(1))
    return [[float(x) for x in r.split(',')] for r in rows]
clk_q = max(table(c, 'cell_rise')[1][1], table(c, 'cell_fall')[1][1])    # 10 ps clock slew, 1.44 fF load
setup_body = re.search(r'timing_type\s*:\s*setup_rising;(.*?)(?=timing_type|\Z)', c, re.S).group(1)
setup = max(table(setup_body, 'rise_constraint')[1][1], table(setup_body, 'fall_constraint')[1][1])  # 10 ps slews
print(f'flip-flop clock-to-output {clk_q:.1f} ps + setup {setup:.1f} ps = {clk_q + setup:.1f} ps per cycle')
PY
