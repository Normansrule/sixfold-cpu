# =============================================================================
# 28_fixed_point.s: game and audio maths in 16-bit fixed point (Q15)
#
# Without floating point, games and audio code store a number from -1 to almost 1 as a 16-bit integer
# scaled by 2^15 (Q15). Two kernels:
#   transform : 256 vertices (x, y, z, w) times a 4 x 4 matrix, each output (row . vertex) >> 15
#   gain      : 2048 audio samples times a volume of 0.7071 (0x5a82), rounded: (s * g + 2^14) >> 15
#
#   pdot.h    rd, rs1, rs2 : 4 signed 16-bit products summed (custom-0 group "xcompute"): one row . vertex
#   pmulhrs.h rd, rs1, rs2 : 4 Q15 products, rounded (-1 x -1 saturates; it cannot happen with this volume)
#
# a1, a2 = checksums of the two outputs; both versions must agree (a0 = 0). EXPECT values come from
# tools/kernel_reference.py.
#
# BENCH: transform 256 vertices by a 4 x 4 Q15 matrix | s2 s3 | s4 s5
# BENCH: audio gain on 2048 Q15 samples               | s6 s7 | s8 s9
# EXPECT: a0 = 0
# EXPECT: a1 = 0x76ed60ea63ec6cb
# EXPECT: a2 = 0x9d30f976290592d1
# =============================================================================
    .equ NV, 256
    .equ NS, 2048
    la   a0, matrix
    li   a1, 772               # matrix (4), vertices (256), samples (512) doublewords
    li   a2, 0xf15ed
    call fill
    # ---------------- transform, plain: per vertex 4 rows x 4 multiply-adds
    rdinstret s4
    rdcycle s2
    la   s0, vertices
    la   s10, out_s
    li   s6, NV
plain_vertex:
    lh   a3, 0(s0)             # x y z w
    lh   a4, 2(s0)
    lh   a5, 4(s0)
    lh   a6, 6(s0)
    la   s1, matrix
    li   s11, 4                # rows left
plain_rowdot:
    lh   t0, 0(s1)
    lh   t1, 2(s1)
    lh   t2, 4(s1)
    lh   t3, 6(s1)
    mul  t0, t0, a3
    mul  t1, t1, a4
    mul  t2, t2, a5
    mul  t3, t3, a6
    add  t0, t0, t1
    add  t2, t2, t3
    add  t0, t0, t2
    srai t0, t0, 15
    sh   t0, 0(s10)
    addi s1, s1, 8
    addi s10, s10, 2
    addi s11, s11, -1
    bnez s11, plain_rowdot
    addi s0, s0, 8
    addi s6, s6, -1
    bnez s6, plain_vertex
    rdcycle t6
    sub  s2, t6, s2
    rdinstret t6
    sub  s4, t6, s4
    # ---------------- transform, packed: the matrix rows stay in four registers
    rdinstret s5
    rdcycle s3
    la   t0, matrix
    ld   a3, 0(t0)
    ld   a4, 8(t0)
    ld   a5, 16(t0)
    ld   a6, 24(t0)
    la   s0, vertices
    la   s10, out_p
    li   s6, NV
packed_vertex:
    ld   t0, 0(s0)
    pdot.h t1, a3, t0
    pdot.h t2, a4, t0
    pdot.h t3, a5, t0
    pdot.h t4, a6, t0
    srai t1, t1, 15
    srai t2, t2, 15
    srai t3, t3, 15
    srai t4, t4, 15
    sh   t1, 0(s10)
    sh   t2, 2(s10)
    sh   t3, 4(s10)
    sh   t4, 6(s10)
    addi s0, s0, 8
    addi s10, s10, 8
    addi s6, s6, -1
    bnez s6, packed_vertex
    rdcycle t6
    sub  s3, t6, s3
    rdinstret t6
    sub  s5, t6, s5
    # ---------------- gain, plain
    rdinstret s8
    rdcycle s6
    la   s0, samples
    la   s10, out_s + 2 * NV * 4
    li   t4, 0x5a82            # 0.7071 in Q15
    li   t3, 0x4000            # half of 2^15: rounds to the nearest
    li   t5, NS
plain_gain:
    lh   t0, 0(s0)
    mul  t0, t0, t4
    add  t0, t0, t3
    srai t0, t0, 15
    sh   t0, 0(s10)
    addi s0, s0, 2
    addi s10, s10, 2
    addi t5, t5, -1
    bnez t5, plain_gain
    rdcycle t6
    sub  s6, t6, s6
    rdinstret t6
    sub  s8, t6, s8
    # ---------------- gain, packed
    rdinstret s9
    rdcycle s7
    la   s0, samples
    la   s10, out_p + 2 * NV * 4
    li   t4, 0x5a825a825a825a82 # the volume in all four lanes
    li   t5, NS
packed_gain:
    ld   t0, 0(s0)
    ld   t1, 8(s0)
    pmulhrs.h t0, t0, t4
    pmulhrs.h t1, t1, t4
    addi s0, s0, 16
    addi t5, t5, -8
    sd   t0, 0(s10)
    sd   t1, 8(s10)
    addi s10, s10, 16
    bnez t5, packed_gain
    rdcycle t6
    sub  s7, t6, s7
    rdinstret t6
    sub  s9, t6, s9
    # ---------------- agree? a1 = checksum of the transform, a2 = of the gain
    la   s0, out_s
    la   s1, out_p
    li   t5, NV
    li   a0, 0
    li   a1, 0
check_t:
    ld   t0, 0(s0)
    ld   t1, 0(s1)
    xor  t2, t0, t1
    or   a0, a0, t2
    slli t3, a1, 5
    sub  a1, t3, a1
    add  a1, a1, t1
    addi s0, s0, 8
    addi s1, s1, 8
    addi t5, t5, -1
    bnez t5, check_t
    li   t5, NS / 4
    li   a2, 0
check_g:
    ld   t0, 0(s0)
    ld   t1, 0(s1)
    xor  t2, t0, t1
    or   a0, a0, t2
    slli t3, a2, 5
    sub  a2, t3, a2
    add  a2, a2, t1
    addi s0, s0, 8
    addi s1, s1, 8
    addi t5, t5, -1
    bnez t5, check_g
    snez a0, a0
    halt

# fill(a0 = address, a1 = doublewords, a2 = seed): x = x * 6364136223846793005 + 1442695040888963407
fill:
    li   t0, 6364136223846793005
    li   t1, 1442695040888963407
fill_loop:
    mul  a2, a2, t0
    add  a2, a2, t1
    sd   a2, 0(a0)
    addi a0, a0, 8
    addi a1, a1, -1
    bnez a1, fill_loop
    ret

    .align 3
matrix:   .zero 32
vertices: .zero 2048
samples:  .zero 4096
out_s:    .zero 6144
out_p:    .zero 6144
