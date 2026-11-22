# =============================================================================
# 26_motion_search.s: the heart of a video encoder, searching where a 16 x 16 block moved
#
# A video encoder sends "this block is the one 3 rows down and 8 pixels left in the last frame" instead of the
# pixels. To find it, it compares the block with candidate positions in the previous frame by their sum of
# absolute differences (SAD) and keeps the smallest. Here: 24 candidates (rows 0 ... 7, columns 0, 8, 16) in a
# 32 x 32 frame, 256 pixels each, 6144 absolute differences.
#
#   plain RV64 + Zbb : per pixel lbu, lbu, sub, sub, max, add
#   psad.b rd, rs1, rs2  : |a - b| of 8 byte pairs, summed (custom-0 group "xcompute"): per row of 16 pixels
#                          two ld pairs and two psad.b
#
# a1 = the smallest SAD, a2 = its candidate number (row * 3 + column / 8); both versions must agree (a0 = 0).
# The EXPECT values come from tools/kernel_reference.py.
#
# BENCH: motion search, 24 candidates x 256 pixels (SAD) | s2 s3 | s4 s5
# EXPECT: a0 = 0
# EXPECT: a1 = 19517
# EXPECT: a2 = 5
# =============================================================================
    la   a0, frame
    li   a1, 160               # the 1024-byte frame, then the 256-byte block
    li   a2, 0x5ad
    call fill
    # ---------------- plain: candidate loop, row loop, pixel loop
    rdinstret s4
    rdcycle s2
    li   s6, -1                # best SAD so far (unsigned: the largest number)
    li   s7, 0                 # its candidate
    li   s8, 0                 # candidate number
    li   s9, 0                 # candidate row
plain_row_cand:
    li   s10, 0                # candidate column: 0, 8, 16
plain_col_cand:
    la   t0, frame
    slli t1, s9, 5             # row * 32
    add  t0, t0, t1
    add  t0, t0, s10           # the candidate's top-left pixel
    la   t1, block
    li   a3, 0                 # this candidate's SAD
    li   a4, 16                # rows left
plain_row:
    li   a5, 16                # pixels left in the row
plain_pixel:
    lbu  t2, 0(t0)
    lbu  t3, 0(t1)
    sub  t4, t2, t3
    sub  t5, t3, t2
    max  t4, t4, t5            # |a - b| (Zbb)
    add  a3, a3, t4
    addi t0, t0, 1
    addi t1, t1, 1
    addi a5, a5, -1
    bnez a5, plain_pixel
    addi t0, t0, 16            # next frame row (32 bytes on)
    addi a4, a4, -1
    bnez a4, plain_row
    bgeu a3, s6, plain_not_better
    mv   s6, a3
    mv   s7, s8
plain_not_better:
    addi s8, s8, 1
    addi s10, s10, 8
    li   t6, 24
    bne  s10, t6, plain_col_cand
    addi s9, s9, 1
    li   t6, 8
    bne  s9, t6, plain_row_cand
    rdcycle t6
    sub  s2, t6, s2
    rdinstret t6
    sub  s4, t6, s4
    mv   a6, s6
    mv   a7, s7
    # ---------------- packed: two doublewords per row
    rdinstret s5
    rdcycle s3
    li   s6, -1
    li   s7, 0
    li   s8, 0
    li   s9, 0
packed_row_cand:
    li   s10, 0
packed_col_cand:
    la   t0, frame
    slli t1, s9, 5
    add  t0, t0, t1
    add  t0, t0, s10
    la   t1, block
    li   a3, 0
    li   a4, 16
packed_row:
    ld   t2, 0(t0)
    ld   t3, 0(t1)
    ld   t4, 8(t0)
    ld   t5, 8(t1)
    psad.b t2, t2, t3
    psad.b t4, t4, t5
    addi t0, t0, 32
    addi t1, t1, 16
    add  a3, a3, t2
    add  a3, a3, t4
    addi a4, a4, -1
    bnez a4, packed_row
    bgeu a3, s6, packed_not_better
    mv   s6, a3
    mv   s7, s8
packed_not_better:
    addi s8, s8, 1
    addi s10, s10, 8
    li   t6, 24
    bne  s10, t6, packed_col_cand
    addi s9, s9, 1
    li   t6, 8
    bne  s9, t6, packed_row_cand
    rdcycle t6
    sub  s3, t6, s3
    rdinstret t6
    sub  s5, t6, s5
    # ---------------- agree?
    mv   a1, s6
    mv   a2, s7
    xor  t0, a6, s6
    xor  t1, a7, s7
    or   a0, t0, t1
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
frame: .zero 1024
block: .zero 256
