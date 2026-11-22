#!/usr/bin/env python3
# =============================================================================
# asic/flow/draw.py: draw a placed-and-routed Sixfold_Silicon from its DEF (asic/flow.sh writes it)
#
#   python3 asic/flow/draw.py build/asic/<placement> <sky130_fd_sc_hd.lef> docs/img/silicon/asic_<placement>.svg
#
# Every rectangle comes from the DEF (metrics.json after routing, else metrics_placed.json): the die, the 32 SRAM macros at their placed positions (instruction cache
# blue, data cache green, pins edge marked), the standard cells as a density map (darker = more cell area in
# that square), the pins by group, and, in red, the cells of the slowest path in critical_path.rpt joined in
# path order, so the length of that path's wires can be seen.
# =============================================================================
import json, re, sys, os, html

def lef_sizes(paths):
    sizes = {}
    for p in paths:
        for m in re.finditer(r'MACRO\s+(\S+)(.*?)END\s+\1', open(p).read(), re.S):
            s = re.search(r'SIZE\s+([\d.]+)\s+BY\s+([\d.]+)', m.group(2))
            if s: sizes[m.group(1)] = (float(s.group(1)), float(s.group(2)))
    return sizes

def main():
    run, cell_lef, out = sys.argv[1:4]
    macro_lef = os.path.join(os.path.dirname(__file__), '..', 'macros', 'sram22_64x32m4w8', 'sram22_64x32m4w8.lef')
    sizes = lef_sizes([cell_lef, macro_lef])
    d = open(f'{run}/Sixfold_Silicon.def').read()
    unit = int(re.search(r'UNITS DISTANCE MICRONS (\d+)', d).group(1))
    die = [int(v) / unit for v in re.search(r'DIEAREA \( (-?\d+) (-?\d+) \) \( (-?\d+) (-?\d+) \)', d).groups()]
    comps = d[d.index('\nCOMPONENTS'):d.index('END COMPONENTS')]
    W = 760.0
    s = W / die[2]
    H = die[3] * s
    BIN = 40.0  # um: one density square
    nx, ny = int(die[2] / BIN) + 1, int(die[3] / BIN) + 1
    dens = [[0.0] * ny for _ in range(nx)]
    macros, where = [], {}
    for name, cell, rest in re.findall(r'-\s+(\S+)\s+(\S+)\s+([^;]*);', comps):
        p = re.search(r'\+\s+(PLACED|FIXED|FIRM)\s+\(\s*(-?\d+)\s+(-?\d+)\s*\)\s+(\S+)', rest)
        if not p or cell not in sizes: continue
        x, y, o = int(p.group(2)) / unit, int(p.group(3)) / unit, p.group(4)
        w, h = sizes[cell]
        if o in ('E', 'W', 'FE', 'FW'): w, h = h, w
        where[name.replace('\\', '')] = (x + w / 2, y + h / 2)
        if cell.startswith('sram22'):
            macros.append((name.replace('\\', ''), x, y, w, h, o)); continue
        if 'tapvpwrvgnd' in cell or cell.startswith('sky130_fd_sc_hd__fill') or 'decap' in cell: continue
        i, j = min(nx - 1, int((x + w / 2) / BIN)), min(ny - 1, int((y + h / 2) / BIN))
        dens[i][j] += w * h
    pins = []
    pins_txt = d[d.index('\nPINS'):d.index('END PINS')]
    for name, rest in re.findall(r'-\s+(\S+)\s+\+\s+NET\s+\S+([^;]*);', pins_txt):
        p = re.search(r'PLACED\s+\(\s*(-?\d+)\s+(-?\d+)\s*\)', rest)
        if p: pins.append((name, int(p.group(1)) / unit, int(p.group(2)) / unit))
    stage = 'routed' if os.path.exists(f'{run}/metrics.json') else 'placed'
    m = json.load(open(f'{run}/metrics.json' if stage == 'routed' else f'{run}/metrics_placed.json'))
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W + 20:.0f} {H + 70:.0f}" font-family="Helvetica, Arial, sans-serif" font-size="12">',
         f'<title>Sixfold on sky130, {m["placement"]} macro placement</title>',
         '<style>.bg{fill:#fbfbf8}.die{fill:#f1f2ee;stroke:#9aa0a6}.t{fill:#111}.s{fill:#555}.c{fill:#37474f}.ic{fill:#4c8bf5;stroke:#1a4fa8}.dc{fill:#34a853;stroke:#1e6b34}.pe{stroke:#fff;stroke-width:1.5}.path{stroke:#d93025;stroke-width:2;fill:none}'
         '@media (prefers-color-scheme: dark){.bg{fill:#16181b}.die{fill:#202327;stroke:#5f6368}.t{fill:#eee}.s{fill:#bbb}.c{fill:#cfd8dc}}</style>',
         f'<rect class="bg" width="100%" height="100%"/>',
         f'<g transform="translate(10,10)"><rect class="die" x="0" y="0" width="{W:.1f}" height="{H:.1f}"/>']
    peak = max(max(col) for col in dens) or 1
    for i in range(nx):
        for j in range(ny):
            if dens[i][j] <= 0: continue
            a = min(1.0, dens[i][j] / peak) * 0.85 + 0.08
            o.append(f'<rect class="c" x="{i * BIN * s:.1f}" y="{H - (j + 1) * BIN * s:.1f}" width="{BIN * s + 0.3:.1f}" height="{BIN * s + 0.3:.1f}" fill-opacity="{a:.2f}"/>')
    for name, x, y, w, h, orient in macros:
        cls = 'ic' if 'instruction_cache' in name else 'dc'
        o.append(f'<rect class="{cls}" x="{x * s:.1f}" y="{H - (y + h) * s:.1f}" width="{w * s:.1f}" height="{h * s:.1f}" fill-opacity="0.8"/>')
        py = y + (h if orient in ('FS', 'MX') else 0)  # the pin edge: bottom unless mirrored
        o.append(f'<line class="pe" x1="{(x + 2) * s:.1f}" y1="{H - py * s:.1f}" x2="{(x + w - 2) * s:.1f}" y2="{H - py * s:.1f}"/>')
    for name, x, y in pins:
        col = '#4c8bf5' if name.startswith('INSTRUCTION') else '#34a853' if name.startswith(('DATA', 'DEVICE')) else '#9aa0a6'
        o.append(f'<circle cx="{x * s:.1f}" cy="{H - y * s:.1f}" r="1.2" fill="{col}"/>')
    # the slowest path, cell to cell
    pts = []
    try:
        for line in open(f'{run}/{stage}_critical_path.rpt'):
            mm = re.search(r'\s(\S+)/\S+\s+\((\S+)\)', line)
            if mm and mm.group(1).replace('\\', '') in where:
                c = where[mm.group(1).replace('\\', '')]
                if not pts or pts[-1] != c: pts.append(c)
    except FileNotFoundError:
        pass
    if len(pts) > 1:
        o.append('<polyline class="path" points="' + ' '.join(f'{x * s:.1f},{H - y * s:.1f}' for x, y in pts) + '"/>')
    o.append('</g>')
    o.append(f'<text class="t" x="10" y="{H + 32:.0f}" font-weight="bold">{html.escape(m["placement"])}: die {die[2]:.0f} x {die[3]:.0f} um, '
             f'clock target {m["clock_target_ns"]} ns, worst slack {m["worst_setup_slack_ns"]:.2f} ns, '
             + (f'routed wire {m["routed_wire_length_um"] / 1e6:.2f} m' if 'routed_wire_length_um' in m else f'placed wire (half-perimeter) {m["half_perimeter_wire_length_um"] / 1e6:.2f} m')
             + '</text>')
    o.append(f'<text class="s" x="10" y="{H + 52:.0f}">blue: instruction cache macros, green: data cache macros (white edge = pins), grey: standard-cell density, red: slowest path</text>')
    o.append('</svg>')
    open(out, 'w').write('\n'.join(o) + '\n')

if __name__ == '__main__':
    main()
