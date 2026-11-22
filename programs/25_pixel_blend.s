# =============================================================================
# 25_pixel_blend.s: brightening and blending 2048 pixels, one byte at a time and eight at a time
#
# A colour channel is a byte (0 ... 255). Adding light to it must stop at 255 (white), not wrap around to
# black; a 50 % blend of two images is the rounded average of each pair of bytes. The plain RV64 + Zbb code
# handles one byte per loop trip; the packed instructions of the "xcompute" group (custom-0, XCOMPUTE = 1)
# handle the eight bytes of a 64-bit register at once:
#
#   paddus.b rd, rs1, rs2   8 x min(a + b, 255)           brighten, additive blending
#   pavgu.b  rd, rs1, rs2   8 x (a + b + 1) / 2           50 % blend
#
# Both versions run on the same random images (a 64-bit linear congruential generator) and must write
# identical results; a0 = 0 says they did. a1 = a checksum of both outputs; the EXPECT value comes from
# tools/kernel_reference.py, plain Python on the same data, so a mistake both versions share cannot hide.
# A packed result is ready two cycles after its instruction (it is computed in MEMORY): two independent
# instructions sit between paddus.b and the store that needs it, so nothing waits.
#
# BENCH: brighten 2048 bytes (saturating add) | s2 s3 | s4 s5
# BENCH: blend 2048 bytes (rounded average)    | s6 s7 | s8 s9
# EXPECT: a0 = 0
# EXPECT: a1 = 0x846756529a01ce00
# =============================================================================
    .equ N, 2048
    la   a0, img_a
    li   a1, 512               # img_a and img_b: 4096 random bytes
    li   a2, 0x5eed
    call fill
    # ---------------- brighten, plain: one byte per trip
    la   s0, img_a
    la   s1, img_b
    la   s10, out_s
    li   t5, N
    li   t4, 255
    rdinstret s4
    rdcycle s2
bright_plain:
    lbu  t0, 0(s0)
    lbu  t1, 0(s1)
    add  t0, t0, t1
    minu t0, t0, t4            # stop at 255 (Zbb)
    sb   t0, 0(s10)
    addi s0, s0, 1
    addi s1, s1, 1
    addi s10, s10, 1
    addi t5, t5, -1
    bnez t5, bright_plain
    rdcycle t6
    sub  s2, t6, s2
    rdinstret t6
    sub  s4, t6, s4
    # ---------------- brighten, packed: eight bytes per trip
    la   s0, img_a
    la   s1, img_b
    la   s10, out_p
    li   t5, N
    rdinstret s5
    rdcycle s3
bright_packed:
    ld   t0, 0(s0)
    ld   t1, 0(s1)
    addi s0, s0, 8
    paddus.b t2, t0, t1
    addi s1, s1, 8
    addi t5, t5, -8
    sd   t2, 0(s10)
    addi s10, s10, 8
    bnez t5, bright_packed
    rdcycle t6
    sub  s3, t6, s3
    rdinstret t6
    sub  s5, t6, s5
    # ---------------- blend, plain
    la   s0, img_a
    la   s1, img_b
    la   s10, out_s + N
    li   t5, N
    rdinstret s8
    rdcycle s6
blend_plain:
    lbu  t0, 0(s0)
    lbu  t1, 0(s1)
    add  t0, t0, t1
    addi t0, t0, 1
    srli t0, t0, 1
    sb   t0, 0(s10)
    addi s0, s0, 1
    addi s1, s1, 1
    addi s10, s10, 1
    addi t5, t5, -1
    bnez t5, blend_plain
    rdcycle t6
    sub  s6, t6, s6
    rdinstret t6
    sub  s8, t6, s8
    # ---------------- blend, packed
    la   s0, img_a
    la   s1, img_b
    la   s10, out_p + N
    li   t5, N
    rdinstret s9
    rdcycle s7
blend_packed:
    ld   t0, 0(s0)
    ld   t1, 0(s1)
    addi s0, s0, 8
    pavgu.b t2, t0, t1
    addi s1, s1, 8
    addi t5, t5, -8
    sd   t2, 0(s10)
    addi s10, s10, 8
    bnez t5, blend_packed
    rdcycle t6
    sub  s7, t6, s7
    rdinstret t6
    sub  s9, t6, s9
    # ---------------- the two versions must agree; a1 = checksum
    la   s0, out_s
    la   s1, out_p
    li   t5, 2 * N / 8
    li   a0, 0
    li   a1, 0
check:
    ld   t0, 0(s0)
    ld   t1, 0(s1)
    xor  t2, t0, t1
    or   a0, a0, t2
    slli t3, a1, 5             # checksum = checksum * 31 + doubleword
    sub  a1, t3, a1
    add  a1, a1, t1
    addi s0, s0, 8
    addi s1, s1, 8
    addi t5, t5, -1
    bnez t5, check
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
img_a: .zero 2048
img_b: .zero 2048
out_s: .zero 4096
out_p: .zero 4096
