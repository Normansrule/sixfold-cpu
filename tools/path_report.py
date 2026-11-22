#!/usr/bin/env python3
# =============================================================================
# tools/path_report.py: the slowest path into every register group, from the netlist tools/timing.sh mapped
#
#   python3 tools/path_report.py [performance|turbo|baseline|deep] [asap7|sky130] [--top=N] [--trace=GROUP]   (after tools/timing.sh)
#
# ABC reports only the single longest path of the whole core. To see which pipeline stage needs work
# next, this reads the mapped netlist (build/synth/mapped_<build>_<pdk>.json) and the same Liberty library,
# and computes the latest arrival time at every flip-flop input, starting from every flip-flop output at 0.
# Each cell's delay is its slowest input-to-output arc in the library at a 20 ps (sky130: 80 ps) input slew
# and the load of the pins it drives, so the numbers come out close to ABC's but are not identical: use
# them to rank paths, and tools/timing.sh for the number. Registers are grouped by name with [bit] removed.
# =============================================================================
import json, re, sys, bisect
from collections import defaultdict

args = [a for a in sys.argv[1:] if not a.startswith('--')]
cfg = args[0] if args else 'performance'
pdk = args[1] if len(args) > 1 else 'asap7'
top = int(next((a.split('=')[1] for a in sys.argv if a.startswith('--top=')), 25))
lib_path = 'build/asap7/asap7_merged_tt.lib' if pdk == 'asap7' else 'build/sky130_hd_tt.lib'
slew = 20.0 if pdk == 'asap7' else 0.08  # library units: ps (ASAP7), ns (sky130)
unit = 1.0 if pdk == 'asap7' else 1000.0

# ---------------------------------------------------------------- Liberty: pin directions, capacitances, arcs
lib = open(lib_path).read()
cells = {}
for m in re.finditer(r'\n\s*cell\s*\(\s*"?([\w]+)"?\s*\)\s*\{', lib):
    start = m.end(); depth = 1; i = start
    while depth:
        c = lib[i]
        depth += c == '{'; depth -= c == '}'; i += 1
    cells[m.group(1)] = lib[start:i]

def block_iter(text, kind):
    for m in re.finditer(r'\b' + kind + r'\s*\(\s*"?([^")]*)"?\s*\)\s*\{', text):
        start = m.end(); depth = 1; i = start
        while depth:
            c = text[i]
            depth += c == '{'; depth -= c == '}'; i += 1
        yield m.group(1), text[start:i]

def lookup(table, x, y):
    i1 = [float(v) for v in re.search(r'index_1\s*\("([^"]*)"', table).group(1).split(',')]
    i2 = [float(v) for v in re.search(r'index_2\s*\("([^"]*)"', table).group(1).split(',')]
    rows = [[float(v) for v in r.split(',')] for r in re.findall(r'"([^"]*)"', re.search(r'values\s*\((.*?)\)\s*;', table, re.S).group(1))]
    a = min(max(bisect.bisect_left(i1, x), 1), len(i1) - 1); b = min(max(bisect.bisect_left(i2, y), 1), len(i2) - 1)
    def lin(lo, hi, v, flo, fhi): return flo + (fhi - flo) * (v - lo) / (hi - lo) if hi != lo else flo
    r0 = lin(i2[b - 1], i2[b], y, rows[a - 1][b - 1], rows[a - 1][b]); r1 = lin(i2[b - 1], i2[b], y, rows[a][b - 1], rows[a][b])
    return lin(i1[a - 1], i1[a], x, r0, r1)

info = {}
for name, body in cells.items():
    pins = {}; arcs = defaultdict(list)
    for pin, pbody in block_iter(body, 'pin'):
        d = re.search(r'direction\s*:\s*(\w+)', pbody)
        cap = re.search(r'\bcapacitance\s*:\s*([\d.]+)', pbody)
        pins[pin] = (d.group(1) if d else 'input', float(cap.group(1)) if cap else 0.0)
        for _, tbody in block_iter(pbody, 'timing'):
            rel = re.search(r'related_pin\s*:\s*"?(\w+)"?', tbody)
            tables = [t for k in ('cell_rise', 'cell_fall') for _, t in block_iter(tbody, k)]
            if rel and tables: arcs[pin].append((rel.group(1), tables))
    info[name] = (pins, arcs)

# ---------------------------------------------------------------- the mapped netlist
mod = json.load(open(f'build/synth/mapped_{cfg}_{pdk}.json'))['modules']['Riscv64Deep' if cfg.startswith('deep') else 'Riscv64']
names = {}
for n, v in mod['netnames'].items():
    for i, b in enumerate(v['bits']):
        if not isinstance(b, int): continue
        label = f'{n}[{i}]' if len(v['bits']) > 1 else n
        rank = (n.startswith('$'), '.' in n, len(n)) # a top-level register name beats a submodule's port alias
        if b not in names or rank < names[b][0]: names[b] = (rank, label)
names = {b: label for b, (rank, label) in names.items()}
load = defaultdict(float); drivers = {}; starts = set(); ends = []
for cname, c in mod['cells'].items():
    t = c['type']
    for pin, bits in c['connections'].items():
        for b in bits:
            if not isinstance(b, int): continue
            if t in info:
                d, cap = info[t][0].get(pin, ('input', 0.0))
                if d == 'output': drivers[b] = (cname, pin)
                else: load[b] += cap
            elif 'DFF' in t.upper() or t.startswith('$_SDFF') or t.startswith('$_DFFE'):
                if pin == 'Q': starts.add(b)
        if t not in info and ('DFF' in t.upper()):
            ends.append((c['connections']['D'][0], c['connections']['Q'][0]))
for b in [b for p in mod['ports'].values() if p['direction'] == 'input' for b in p['bits']]: starts.add(b)

arrival = {}; came_from = {}
sys.setrecursionlimit(1000000)
def arr(b):
    if b in arrival: return arrival[b]
    if not isinstance(b, int) or b in starts or b not in drivers: arrival[b] = 0.0; return 0.0
    cname, opin = drivers[b]; c = mod['cells'][cname]; pins, arcs = info[c['type']]
    best, src = 0.0, None
    for rel, tables in arcs.get(opin, []):
        ib = c['connections'].get(rel, [None])[0]
        delay = max(lookup(t, slew, max(load[b], 0.1)) for t in tables) * unit
        a = arr(ib) + delay
        if a > best: best, src = a, ib
    arrival[b] = best; came_from[b] = src
    return best

groups = {}
for e, q in ends:
    a = arr(e); key = re.sub(r'\[\d+\]$', '', names.get(q, str(q)))
    if key not in groups or a > groups[key][0]: groups[key] = (a, e)
def startpoint(b):
    while came_from.get(b) is not None: b = came_from[b]
    return re.sub(r'\[\d+\]$', '', names.get(b, str(b)))
print(f'{cfg} {pdk}: slowest path into each register group (ps, estimate)')
for key, (a, e) in sorted(groups.items(), key=lambda kv: -kv[1][0])[:top]:
    print(f'{a:8.0f}  {key:<55} from {startpoint(e)}')

# --trace=GROUP: the named nets along the slowest path into GROUP, with their arrival times
trace = next((a.split('=', 1)[1] for a in sys.argv if a.startswith('--trace=')), None)
if trace and trace in groups:
    b = groups[trace][1]; seen = []
    while b is not None:
        n = names.get(b)
        if n and not n.startswith('$') and (not seen or seen[-1][1] != re.sub(r'\[\d+\]$', '', n)): seen.append((arrival.get(b, 0.0), re.sub(r'\[\d+\]$', '', n)))
        b = came_from.get(b)
    print(f'\npath into {trace}:')
    for a, n in reversed(seen): print(f'{a:8.0f}  {n}')
