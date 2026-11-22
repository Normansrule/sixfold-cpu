#!/usr/bin/env python3
# =============================================================================
# tools/floorplan.py: where the caches go. The prototype's measured layout against a planned floorplan.
#
#   python3 tools/floorplan.py            (make floorplan; needs build/floorplan/areas.json from tools/floorplan_areas.sh)
#
# 1. MEASURED, the 32-bit prototype (docs/silicon/prototype_layout.def.gz, placed and routed): where its cache
#    controllers and its ten SRAM macros actually sit, and how far apart they are.
# 2. PLANNED, the 64-bit turbo core on the same SkyWater sky130 process: every block's cell area is measured
#    (tools/floorplan_areas.sh synthesizes each one), the SRAM macros are the prototype's real sram22 macros
#    (their sizes are read from the same DEF), and the blocks are arranged in pipeline order with each cache
#    beside the stage that uses it. The arrangement is a plan, not a placement: no placer or router ran on it.
#    Assumptions are named where they are made (UTILIZATION, HALO, the split of the pipeline control).
# 3. COMPUTED: the delay of the long wires each arrangement needs, from the per-micrometre resistance and
#    capacitance of the sky130 metal layers (OpenROAD-flow-scripts platforms/sky130hd/setRC.tcl). Wire only:
#    no driver, no repeaters. It shows why distance matters, not a signed-off number.
#
# Writes docs/img/silicon/floorplan.svg and docs/img/silicon/floorplan.json (the numbers in docs/SILICON.md).
# =============================================================================
import gzip, json, math, re, sys, os
from collections import defaultdict

UTILIZATION = 0.65  # assumption: fraction of a logic region filled by cells (the rest is routing room)
HALO = 10.0         # assumption: um of keep-out around each SRAM macro
# sky130 metal RC per micrometre, OpenROAD-flow-scripts platforms/sky130hd/setRC.tcl (kOhm/um, pF/um)
RC = {'met2': (1.22132e-3, 1.36233e-4), 'met3': (1.66281e-4, 2.14962e-4), 'met4': (1.68093e-4, 1.48128e-4)}

LIB = open('build/sky130_hd_tt.lib').read()
def _table(cell, kind):
    body = LIB[LIB.index(f'cell ("{cell}")'):]
    body = body[:body.index('cell ("', 10)]
    m = re.search(kind + r'\s*\("[^"]*"\)\s*\{(.*?)\}', body, re.S)
    i1 = [float(v) for v in re.search(r'index_1\s*\("([^"]*)"', m.group(1)).group(1).split(',')]
    i2 = [float(v) for v in re.search(r'index_2\s*\("([^"]*)"', m.group(1)).group(1).split(',')]
    rows = [[float(v) for v in r.split(',')] for r in re.findall(r'"([^"]*)"', re.search(r'values\s*\((.*?)\)\s*;', m.group(1), re.S).group(1))]
    return i1, i2, rows
def _lookup(t, x, y):
    i1, i2, rows = t
    def seg(ax, v):
        j = max(1, min(len(ax) - 1, next((k for k, a in enumerate(ax) if a >= v), len(ax) - 1)))
        return j - 1, j, (v - ax[j - 1]) / (ax[j] - ax[j - 1])
    a0, a1, fa = seg(i1, x); b0, b1, fb = seg(i2, y)
    r0 = rows[a0][b0] + (rows[a0][b1] - rows[a0][b0]) * fb; r1 = rows[a1][b0] + (rows[a1][b1] - rows[a1][b0]) * fb
    return r0 + (r1 - r0) * fa
DRIVER = 'sky130_fd_sc_hd__buf_8'
_driver = [_table(DRIVER, 'cell_rise'), _table(DRIVER, 'cell_fall')]
def driven_ps(length_um, layer='met3'):
    """one strong buffer (buf_8, 80 ps input slew) driving the whole wire: its delay into the wire's capacitance, plus the wire's RC"""
    c_pf = RC[layer][1] * length_um + 0.005
    return 1000 * max(_lookup(t, 0.08, c_pf) for t in _driver) + wire_ps(length_um, layer)

def wire_ps(length_um, layer):
    """50% delay of an unbuffered distributed RC wire: 0.38 * R * C (R in ohm, C in farad)."""
    r, c = RC[layer]
    return 0.38 * (r * 1e3 * length_um) * (c * 1e-12 * length_um) * 1e12

# ---------------------------------------------------------------- 1. the prototype, measured
txt = gzip.open('docs/silicon/prototype_layout.def.gz', 'rt').read()
comp = txt[txt.index('\nCOMPONENTS'):txt.index('END COMPONENTS')]
groups = defaultdict(list); macros = []
for name, cell, rest in re.findall(r'-\s+(\S+)\s+(\S+)\s+([^;]*);', comp):
    p = re.search(r'\+\s+(PLACED|FIXED)\s+\(\s*(-?\d+)\s+(-?\d+)\s*\)', rest)
    if not p: continue
    x, y = int(p.group(2)) / 1000, int(p.group(3)) / 1000
    if cell.startswith('sram22'): macros.append((name, cell, x, y)); continue
    if cell.startswith('FILL') or cell == 'ANTENNA' or 'DECAP' in cell.upper(): continue
    if name.startswith('mem/icache'): groups['icache_control'].append((x, y))
    elif name.startswith('mem/dcache'): groups['dcache_control'].append((x, y))
    elif name.startswith('cpu/'): groups['core'].append((x, y))
stats = json.load(open('docs/img/silicon/chip_stats.json'))
size = {m[0]: (m[2], m[3]) for m in stats['macros']}  # um, measured from the DEF by tools/render_def.py
def centroid(pts): return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
proto = {k: centroid(v) for k, v in groups.items()}
def mcenter(n, x, y): w, h = size[n]; return (x + w / 2, y + h / 2)
def dist(a, b): return abs(a[0] - b[0]) + abs(a[1] - b[1])  # Manhattan: wires run horizontally and vertically
proto_meas = {}
for cache in ('icache', 'dcache'):
    ms = [mcenter(n, x, y) for n, c, x, y in macros if f'/{cache}/' in n]
    tag = [mcenter(n, x, y) for n, c, x, y in macros if f'/{cache}/' in n and 'Tag' in n][0]
    proto_meas[cache] = {
        'core_to_tag_um': round(dist(proto['core'], tag)),
        'core_to_controller_um': round(dist(proto['core'], proto[f'{cache}_control'])),
        'controller_to_farthest_macro_um': round(max(dist(proto[f'{cache}_control'], m) for m in ms)),
    }

# ---------------------------------------------------------------- 2. the plan
A = json.load(open('build/floorplan/areas.json'))
area = {k: v['area_um2'] for k, v in A.items()}
parts = ['register_file', 'alu', 'multiply_divide', 'custom_unit', 'csr_file', 'gshare', 'tournament', 'btb', 'return_stack']
control = area['core'] - sum(area[k] for k in parts)  # pipeline registers, forwarding, hazard and branch control
SRAM = {'sram22_256x32m4w8': size['mem/icache/Cache_Data0'], 'sram22_64x32m4w8': size['mem/icache/Cache_Tag']}
def macros_for(cache):
    d, t = A[cache]['data_bits'], A[cache]['tag_bits']
    nd = math.ceil(d / (256 * 32)); nt = 2 * math.ceil((t / 2) / (64 * 32))  # one tag macro per way (64 sets)
    return nd, nt
# Stage columns, left to right in pipeline order. Each lists (block, area); the control logic is spread over
# the four columns in equal parts (an assumption: it is the glue between all of them).
q = control / 4
# Each column: (title, the block centred level with the cache tag arrays (or None), blocks below it, blocks above it).
# The block that talks to a cache sits in the middle of its column, beside the tag arrays: the hit check is
# address -> tag read -> compare -> hit, and its wire is the one that matters most.
columns = [
    ('FETCH', ('I-cache controller', area['icache_control']),
     [('btb', area['btb']), ('return stack', area['return_stack'])],
     [('fetch control', q), ('gshare + tournament', area['gshare'] + area['tournament'])]),
    ('DECODE', None, [('register file', area['register_file'])], [('decode + forwarding', q)]),
    # the M unit is off the one-cycle ALU loop and is the largest block: a column of its own, away from the D-cache
    ('M UNIT', None, [('multiply / divide', area['multiply_divide'])], []),
    ('EXECUTE', ('ALU', area['alu']), [('execute control', q)], [('CSR file', area['csr_file'])]),
    ('MEMORY', ('D-cache controller', area['dcache_control']), [('custom unit', area['custom_unit'])],
     [('memory control', q / 2), ('writeback control', q / 2)]),
]
mw, mh = SRAM['sram22_256x32m4w8']; tw, th = SRAM['sram22_64x32m4w8']
ni, nti = macros_for('icache_control'); nd, ntd = macros_for('dcache_control')
# each cache is one column of macros: data arrays above and below, the tag arrays in the middle, level with
# the controller (the hit check is tag read -> compare -> hit, the shortest wire is the one that matters most)
col_h = max(ni * (mh + 2 * HALO) + nti * (th + 2 * HALO), nd * (mh + 2 * HALO) + ntd * (th + 2 * HALO))
H = col_h
macro_w = max(mw, tw) + 2 * HALO
blocks = []; x = macro_w
for title, key, below, above in columns:
    items = ([key] if key else []) + below + above
    tot = sum(a for _, a in items); w = tot / UTILIZATION / H
    def put(name, a, y): blocks.append({'name': name, 'stage': title, 'x': x, 'y': y, 'w': w, 'h': H * a / tot, 'area_um2': round(a)})
    if key:  # centred; the rest stacked downwards and upwards from it (squeezed to fit the column if one side is too tall)
        hk = H * key[1] / tot; hb = sum(H * a / tot for _, a in below); ha = sum(H * a / tot for _, a in above)
        yk = min(max(H / 2 - hk / 2, hb), H - ha - hk)
        put(key[0], key[1], yk); y = yk
        for name, a in below: y -= H * a / tot; put(name, a, y)
        y = yk + hk
        for name, a in above: put(name, a, y); y += H * a / tot
    else:
        y = 0
        for name, a in below + above: put(name, a, y); y += H * a / tot
    x += w
W = x + macro_w
def place_cache_column(x0, n_data, n_tag, prefix):
    out = []; y = 0
    half = n_data // 2
    for i in range(half): out.append({'name': f'{prefix} data {i}', 'x': x0 + HALO, 'y': y + HALO, 'w': mw, 'h': mh}); y += mh + 2 * HALO
    for i in range(n_tag): out.append({'name': f'{prefix} tag {i}', 'x': x0 + HALO, 'y': y + HALO, 'w': tw, 'h': th}); y += th + 2 * HALO
    for i in range(half, n_data): out.append({'name': f'{prefix} data {i}', 'x': x0 + HALO, 'y': y + HALO, 'w': mw, 'h': mh}); y += mh + 2 * HALO
    return out
plan_macros = place_cache_column(0, ni, nti, 'I-cache') + place_cache_column(W - macro_w, nd, ntd, 'D-cache')
def center(b): return (b['x'] + b['w'] / 2, b['y'] + b['h'] / 2)
B = {b['name']: b for b in blocks}
def tag_center(prefix): return centroid([center(m) for m in plan_macros if m['name'].startswith(prefix) and 'tag' in m['name']])
plan_meas = {
    'icache': {'core_to_tag_um': round(dist(center(B['fetch control']), tag_center('I-cache'))),
               'core_to_controller_um': round(dist(center(B['fetch control']), center(B['I-cache controller']))),
               'controller_to_farthest_macro_um': round(max(dist(center(B['I-cache controller']), center(m)) for m in plan_macros if m['name'].startswith('I-cache')))},
    'dcache': {'core_to_tag_um': round(dist(center(B['ALU']), tag_center('D-cache'))),
               'core_to_controller_um': round(dist(center(B['ALU']), center(B['D-cache controller']))),
               'controller_to_farthest_macro_um': round(max(dist(center(B['D-cache controller']), center(m)) for m in plan_macros if m['name'].startswith('D-cache')))},
}
result = {
    'assumptions': {'utilization': UTILIZATION, 'macro_halo_um': HALO, 'control_split': 'core minus its measured blocks, in four equal parts'},
    'areas_um2': {**{k: round(v) for k, v in area.items()}, 'pipeline_control': round(control)},
    'sram_macros': {'sram22_256x32m4w8_um': SRAM['sram22_256x32m4w8'], 'sram22_64x32m4w8_um': SRAM['sram22_64x32m4w8'],
                    'icache': {'data': ni, 'tag': nti}, 'dcache': {'data': nd, 'tag': ntd}},
    'plan_die_um': [round(W), round(H)],
    'prototype_die_um': [3000, 3000],
    'distances_um': {'prototype': proto_meas, 'plan': plan_meas},
    'wire_delay_ps': {f'{c}_{m[:-3]}': {'prototype': round(driven_ps(proto_meas[c][m])), 'plan': round(driven_ps(plan_meas[c][m]))}
                      for c in ('icache', 'dcache') for m in ('core_to_tag_um', 'controller_to_farthest_macro_um')},
    'wire_delay_model': f'{DRIVER} (liberty table, 80 ps input slew) driving the wire on met3, plus 0.38 R C of the wire (setRC.tcl)',
    'blocks': [{k: (round(v, 1) if isinstance(v, float) else v) for k, v in b.items()} for b in blocks],
    'macros': [{k: (round(v, 1) if isinstance(v, float) else v) for k, v in m.items()} for m in plan_macros],
}
json.dump(result, open('docs/img/silicon/floorplan.json', 'w'), indent=1)

# ---------------------------------------------------------------- the drawing (SVG, light and dark)
S = 900 / max(W, H); PAD = 30
def X(v): return PAD + v * S
def Y(v): return PAD + (H - v) * S
COLORS = {'FETCH': '#4c8bf5', 'DECODE': '#a35bd6', 'M UNIT': '#e0a030', 'EXECUTE': '#ef7d22', 'MEMORY': '#1fa38a'}
svg = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {round(W * S + 2 * PAD)} {round(H * S + 2 * PAD + 50)}" font-family="Helvetica, Arial, sans-serif" font-size="12">',
       '<title>Planned floorplan of the turbo core on sky130</title>',
       '<style>.bg{fill:#fbfbf8}.die{fill:#f1f2ee;stroke:#9aa0a6}.lbl{fill:#111}.sub{fill:#444}.sram{fill:#607d8b;stroke:#37474f}.tag{fill:#455a64;stroke:#263238}'
       '.net{stroke:#c62828;stroke-width:2;fill:none;marker-end:url(#a)}'
       '@media (prefers-color-scheme: dark){.bg{fill:#16181b}.die{fill:#202327;stroke:#5f6368}.lbl{fill:#eee}.sub{fill:#bbb}}</style>',
       '<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L10,5L0,10z" fill="#c62828"/></marker></defs>',
       f'<rect class="bg" x="0" y="0" width="100%" height="100%"/>',
       f'<rect class="die" x="{X(0)}" y="{Y(H)}" width="{W * S}" height="{H * S}"/>']
for b in blocks:
    c = COLORS[b['stage']]
    svg.append(f'<rect x="{X(b["x"]):.1f}" y="{Y(b["y"] + b["h"]):.1f}" width="{b["w"] * S:.1f}" height="{b["h"] * S:.1f}" fill="{c}" fill-opacity="0.75" stroke="#fff" stroke-width="1"/>')
    if b['w'] * S < 110:  # a narrow column: the label runs upwards
        cx, cy = X(b['x']) + 14, Y(b['y']) - 6
        svg.append(f'<text class="lbl" font-size="11" transform="translate({cx:.1f},{cy:.1f}) rotate(-90)">{b["name"]} · {b["area_um2"]:,} um²</text>')
    elif b['h'] * S > 18:
        svg.append(f'<text class="lbl" x="{X(b["x"]) + 4:.1f}" y="{Y(b["y"] + b["h"]) + 14:.1f}">{b["name"]}</text>')
        if b['h'] * S > 32: svg.append(f'<text class="sub" x="{X(b["x"]) + 4:.1f}" y="{Y(b["y"] + b["h"]) + 28:.1f}">{b["area_um2"]:,} um²</text>')
for m in plan_macros:
    cls = 'tag' if 'tag' in m['name'] else 'sram'
    svg.append(f'<rect class="{cls}" x="{X(m["x"]):.1f}" y="{Y(m["y"] + m["h"]):.1f}" width="{m["w"] * S:.1f}" height="{m["h"] * S:.1f}"/>')
    svg.append(f'<text x="{X(m["x"]) + 4:.1f}" y="{Y(m["y"] + m["h"] / 2) + 4:.1f}" fill="#fff" font-size="11">{m["name"]}</text>')
for title, *_ in columns:
    xs = [b for b in blocks if b['stage'] == title]
    svg.append(f'<text class="lbl" font-weight="bold" x="{X(xs[0]["x"] + xs[0]["w"] / 2):.1f}" y="{Y(H) - 8:.1f}" text-anchor="middle">{title}</text>')
# the critical nets: fetch address -> I-cache tags, ALU address -> D-cache tags
def arrow(a, b): svg.append(f'<path class="net" d="M{X(a[0]):.1f},{Y(a[1]):.1f} L{X(b[0]):.1f},{Y(a[1]):.1f} L{X(b[0]):.1f},{Y(b[1]):.1f}"/>')
arrow(center(B['fetch control']), tag_center('I-cache')); arrow(center(B['ALU']), tag_center('D-cache'))
ty = Y(0) + 22
svg.append(f'<text class="lbl" x="{PAD}" y="{ty}">Planned, not placed: {round(W)} x {round(H)} um core area, sky130. Cell areas measured (tools/floorplan_areas.sh), SRAM macros the prototype\'s sram22 sizes,</text>')
svg.append(f'<text class="lbl" x="{PAD}" y="{ty + 16}">{int(UTILIZATION * 100)}% utilization and the split of the pipeline control assumed. Red: the cache hit paths (address to tag arrays).</text>')
svg.append('</svg>')
open('docs/img/silicon/floorplan.svg', 'w').write('\n'.join(svg))
print(json.dumps({k: result[k] for k in ('plan_die_um', 'sram_macros', 'distances_um', 'wire_delay_ps')}, indent=1))
