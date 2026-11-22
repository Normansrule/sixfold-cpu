#!/usr/bin/env python3
# =============================================================================
# asic/flow/macros.py: where the 32 SRAM macros of the two caches go (asic/flow.sh)
#
#   python3 asic/flow/macros.py <corner|planned> <macros.txt> <die.json> > macros.tcl
#
# macros.txt: one line per macro instance, "<instance name> <width um> <height um>" (pnr.tcl writes it).
# die.json: the core area, {"core": [x0, y0, x1, y1]} in micrometres.
# Prints Tcl lines "place_sram <instance> <x> <y> <orientation>" (lower-left corner, in micrometres).
#
# sram22_64x32m4w8 is 360.32 x 191.0 um and has every signal pin on its bottom edge (metal 1), and blocks only
# metal 1 and 2 above itself: wires on metal 3 to 5 may cross it. Rows of macros are therefore placed in pairs
# whose pin edges face each other across one shared channel (the lower row mirrored, MX), and the pairs sit
# back to back with a small gap. The channels are where the address, data and control wires reach the pins.
#
#   corner  : all 32 in one block in the lower-left corner of the core, in instance order (the 32-bit prototype:
#             the ten macros there sat together in a corner, the logic that uses them near the middle)
#   planned : the instruction cache's 16 macros as a block against the WEST edge, where its refill pins are, and the
#             data cache's 16 against the EAST edge, where its refill and store pins are. The core logic fills
#             the middle, between them, so each cache sits between its own memory port and the pipeline stages
#             that read it (FETCH1/FETCH2 for instructions, EXECUTE/MEMORY for data). Each block is centred
#             vertically, so its farthest macro is as close to the middle as the block's height allows.
#             Inside a block, the columns are the two ways and the rows the words (I) or doublewords (D) of a
#             line: the late output multiplexer (way, then word) is fed from one compact block.
# =============================================================================
import json, os, re, sys

CHANNEL = float(os.environ.get("MACRO_CHANNEL_UM", 24.0))  # um between the facing pin edges of a row pair (pin access and the wires to the pins)
BACK = 6.0       # um between two pairs (no pins on these edges)
COLUMN_GAP = 12.0
SNAP_X, SNAP_Y = 0.46, 2.72  # the standard-cell site, so macro edges line up with the rows

def snap(v, g): return round(round(v / g) * g, 3)

def rows_block(names, cols, w, h, x0, y0):
    """names in column-major order (column = way), rows bottom to top; pairs of rows face each other"""
    rows = (len(names) + cols - 1) // cols
    out = []
    for i, n in enumerate(names):
        c, r = i // rows, i % rows
        pair, upper = r // 2, r % 2
        y = y0 + pair * (2 * h + CHANNEL + BACK) + (h + CHANNEL if upper else 0)
        x = x0 + c * (w + COLUMN_GAP)
        out.append((n, snap(x, SNAP_X), snap(y, SNAP_Y), 'R0' if upper else 'MX'))
    return out

def block_size(n, cols, w, h):
    rows = (n + cols - 1) // cols
    pairs = (rows + 1) // 2
    return cols * w + (cols - 1) * COLUMN_GAP, pairs * (2 * h + CHANNEL) + (pairs - 1) * BACK

def key(name):
    # instruction_cache.sram.way[1].word[5].data / data_cache.sram.way[0].doubleword[2].half[1].data
    nums = [int(v) for v in re.findall(r'\[(\d+)\\?\]', name)]
    return ('data_cache' in name, nums)

def main():
    mode, listfile, diefile = sys.argv[1:4]
    macros = [l.split() for l in open(listfile) if l.strip()]
    w, h = float(macros[0][1]), float(macros[0][2])
    names = sorted((m[0] for m in macros), key=key)
    x0, y0, x1, y1 = json.load(open(diefile))['core']
    x0, y0, x1, y1 = x0 + 2, y0 + 2, x1 - 2, y1 - 2  # stay inside after snapping to the site grid
    out = []
    if mode == 'corner':
        cols = 6
        out = rows_block(names, cols, w, h, x0, y0)
    elif mode == 'planned':
        icache = [n for n in names if 'instruction_cache' in n]
        dcache = [n for n in names if 'data_cache' in n]
        for group, west in ((icache, True), (dcache, False)):
            bw, bh = block_size(len(group), 2, w, h)
            bx = x0 if west else x1 - bw
            by = (y0 + y1) / 2 - bh / 2
            out += rows_block(group, 2, w, h, bx, by)
    else:
        sys.exit('mode must be corner or planned')
    for n, x, y, o in out:
        print(f'place_sram {{{n}}} {x} {y} {o}')
    # one placement blockage over each block of macros, gaps included, so the global placer keeps the logic out of
    # the narrow channels between macros (wires still reach the pins there and cross the macros on metal 3 to 5).
    # Buffers that the timing repair inserts on wires crossing a block may still be legalized into a channel.
    blocks = [out] if mode == 'corner' else [[m for m in out if 'instruction_cache' in m[0]], [m for m in out if 'data_cache' in m[0]]]
    for b in blocks:
        xs = [m[1] for m in b]; ys = [m[2] for m in b]
        print(f'block_region {min(xs)} {min(ys)} {round(max(xs) + w, 3)} {round(max(ys) + h, 3)}')

if __name__ == '__main__':
    main()
