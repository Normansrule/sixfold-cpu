#!/usr/bin/env python3
# =============================================================================
# tools/kernel_reference.py: the expected results of the packed-compute kernel programs (programs/25 ... 28),
# computed here from the same random data in plain Python, independently of the model, the RTL and the
# packed instructions. Each program's "# EXPECT:" lines are these numbers; `make test` checks them on the
# model and the RTL, and each program also checks its plain and packed versions against each other.
#
#   python3 tools/kernel_reference.py
# =============================================================================
M = 1 << 64
A_LCG, C_LCG = 6364136223846793005, 1442695040888963407

def fill(n_dwords, seed):
    """The programs' fill(): n doublewords from x = x * A + C, as little-endian bytes; returns (bytes, seed)."""
    out = bytearray()
    for _ in range(n_dwords):
        seed = (seed * A_LCG + C_LCG) % M
        out += seed.to_bytes(8, 'little')
    return out, seed

def sbyte(v): return v - 256 if v > 127 else v
def shalf(b, i): v = b[i] | (b[i + 1] << 8); return v - 65536 if v > 32767 else v
def checksum(data):
    """checksum = checksum * 31 + doubleword (mod 2^64), over the data's doublewords"""
    c = 0
    for i in range(0, len(data), 8): c = (c * 31 + int.from_bytes(data[i:i + 8], 'little')) % M
    return c
def h(x): return '0x%x' % (x % M)

# ---------------- 25_pixel_blend.s
data, _ = fill(512, 0x5eed)
a, b = data[:2048], data[2048:]
bright = bytes(min(x + y, 255) for x, y in zip(a, b))
blend = bytes((x + y + 1) >> 1 for x, y in zip(a, b))
print('25_pixel_blend      a1 =', h(checksum(bright + blend)))

# ---------------- 26_motion_search.s
data, _ = fill(160, 0x5ad)
frame, block = data[:1024], data[1024:]
best, best_k, k = None, 0, 0
for row in range(8):
    for col in (0, 8, 16):
        sad = sum(abs(frame[(row + y) * 32 + col + x] - block[y * 16 + x]) for y in range(16) for x in range(16))
        if best is None or sad < best: best, best_k = sad, k
        k += 1
print('26_motion_search    a1 =', best, ' a2 =', best_k)

# ---------------- 27_int8_dot.s
data, _ = fill(576, 0x1a7e)
w, x = data[:4096], data[4096:]
outs = b''.join(((sum(sbyte(w[n * 512 + i]) * sbyte(x[i]) for i in range(512))) % M).to_bytes(8, 'little') for n in range(8))
print('27_int8_dot         a1 =', h(checksum(outs)))

# ---------------- 28_fixed_point.s
data, _ = fill(772, 0xf15ed)
mat, verts, samp = data[:32], data[32:32 + 2048], data[32 + 2048:]
tr = bytearray()
for v in range(256):
    vv = [shalf(verts, 8 * v + 2 * k) for k in range(4)]
    for j in range(4):
        s = sum(shalf(mat, 8 * j + 2 * k) * vv[k] for k in range(4)) >> 15   # arithmetic shift
        tr += (s % 65536).to_bytes(2, 'little')
gain = b''.join((((shalf(samp, 2 * i) * 0x5a82 + 0x4000) >> 15) % 65536).to_bytes(2, 'little') for i in range(2048))
print('28_fixed_point      a1 =', h(checksum(bytes(tr))), ' a2 =', h(checksum(gain)))
