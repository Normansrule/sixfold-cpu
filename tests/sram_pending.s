# =============================================================================
# tests/sram_pending.s: the rare paths of the SRAM caches (SRAM_CACHES, docs/SILICON.md)
#
# With SRAM macros, a refill that arrives while a load reads the same macro (same way and doubleword, another
# set) leaves that one doubleword PENDING for a cycle; loads and stores that reach it then use the pending copy.
# Each round below misses on a fresh line A (the next line A+32 is then prefetched in the background), runs a
# different number of hitting loads to a line B, then loads, stores and loads again the same doubleword of A+32.
# Somewhere among the rounds the prefetch lands exactly under a B load and the next access is the pending
# doubleword. With or without the macros the cycle count and every register must be the same as the model's
# (node tools/test.mjs --sram); SIXFOLD_SRAM_COVERAGE counts how often the paths were taken.
# EXPECT: a0 = 0xbb69223c6d2a856e
# =============================================================================
    # memory 0x8000..0xBFFF: every doubleword = its address times 3 (stores do not allocate: nothing is cached yet)
    li   s0, 0x8000
    li   s1, 0xC000
init:
    slli t0, s0, 1
    add  t0, t0, s0
    sd   t0, 0(s0)
    addi s0, s0, 8
    bne  s0, s1, init
    # the B lines: cached first, so they sit in way 0 of their sets
    li   s2, 0xA000
    ld   t0, 0(s2)
    ld   t0, 64(s2)
    ld   t0, 128(s2)
    ld   t0, 192(s2)
    li   a0, 0
    # round 0: 4 B loads, 0 filler, doubleword 1
    li   s3, 32768
    li   t3, 1
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t2, 40(s3)
    sb   t3, 40(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 1: 4 B loads, 0 filler, doubleword 3
    li   s3, 33024
    li   t3, 8
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 2: 4 B loads, 1 filler, doubleword 1
    li   s3, 33280
    li   t3, 15
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    addi t6, t6, 1
    ld   t2, 40(s3)
    sb   t3, 42(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 3: 4 B loads, 1 filler, doubleword 3
    li   s3, 33536
    li   t3, 22
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    addi t6, t6, 1
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 4: 5 B loads, 0 filler, doubleword 1
    li   s3, 33792
    li   t3, 29
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t2, 40(s3)
    sb   t3, 44(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 5: 5 B loads, 0 filler, doubleword 3
    li   s3, 34048
    li   t3, 36
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 6: 5 B loads, 1 filler, doubleword 1
    li   s3, 34304
    li   t3, 43
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    addi t6, t6, 1
    ld   t2, 40(s3)
    sb   t3, 46(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 7: 5 B loads, 1 filler, doubleword 3
    li   s3, 34560
    li   t3, 50
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    addi t6, t6, 1
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 8: 6 B loads, 0 filler, doubleword 1
    li   s3, 34816
    li   t3, 57
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t2, 40(s3)
    sb   t3, 40(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 9: 6 B loads, 0 filler, doubleword 3
    li   s3, 35072
    li   t3, 64
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 10: 6 B loads, 1 filler, doubleword 1
    li   s3, 35328
    li   t3, 71
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    addi t6, t6, 1
    ld   t2, 40(s3)
    sb   t3, 42(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 11: 6 B loads, 1 filler, doubleword 3
    li   s3, 35584
    li   t3, 78
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    addi t6, t6, 1
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 12: 7 B loads, 0 filler, doubleword 1
    li   s3, 35840
    li   t3, 85
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t2, 40(s3)
    sb   t3, 44(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 13: 7 B loads, 0 filler, doubleword 3
    li   s3, 36096
    li   t3, 92
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 14: 7 B loads, 1 filler, doubleword 1
    li   s3, 36352
    li   t3, 99
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    addi t6, t6, 1
    ld   t2, 40(s3)
    sb   t3, 46(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 15: 7 B loads, 1 filler, doubleword 3
    li   s3, 36608
    li   t3, 106
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    addi t6, t6, 1
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 16: 8 B loads, 0 filler, doubleword 1
    li   s3, 36864
    li   t3, 113
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t2, 40(s3)
    sb   t3, 40(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 17: 8 B loads, 0 filler, doubleword 3
    li   s3, 37120
    li   t3, 120
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 18: 8 B loads, 1 filler, doubleword 1
    li   s3, 37376
    li   t3, 127
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    addi t6, t6, 1
    ld   t2, 40(s3)
    sb   t3, 42(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 19: 8 B loads, 1 filler, doubleword 3
    li   s3, 37632
    li   t3, 134
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    addi t6, t6, 1
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 20: 9 B loads, 0 filler, doubleword 1
    li   s3, 37888
    li   t3, 141
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t2, 40(s3)
    sb   t3, 44(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 21: 9 B loads, 0 filler, doubleword 3
    li   s3, 38144
    li   t3, 148
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 22: 9 B loads, 1 filler, doubleword 1
    li   s3, 38400
    li   t3, 155
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    addi t6, t6, 1
    ld   t2, 40(s3)
    sb   t3, 46(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 23: 9 B loads, 1 filler, doubleword 3
    li   s3, 38656
    li   t3, 162
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    addi t6, t6, 1
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 24: 10 B loads, 0 filler, doubleword 1
    li   s3, 38912
    li   t3, 169
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t2, 40(s3)
    sb   t3, 40(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 25: 10 B loads, 0 filler, doubleword 3
    li   s3, 39168
    li   t3, 176
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 26: 10 B loads, 1 filler, doubleword 1
    li   s3, 39424
    li   t3, 183
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    addi t6, t6, 1
    ld   t2, 40(s3)
    sb   t3, 42(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 27: 10 B loads, 1 filler, doubleword 3
    li   s3, 39680
    li   t3, 190
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    addi t6, t6, 1
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 28: 11 B loads, 0 filler, doubleword 1
    li   s3, 39936
    li   t3, 197
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t2, 40(s3)
    sb   t3, 44(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 29: 11 B loads, 0 filler, doubleword 3
    li   s3, 40192
    li   t3, 204
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 30: 11 B loads, 1 filler, doubleword 1
    li   s3, 40448
    li   t3, 211
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    addi t6, t6, 1
    ld   t2, 40(s3)
    sb   t3, 46(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 31: 11 B loads, 1 filler, doubleword 3
    li   s3, 40704
    li   t3, 218
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    addi t6, t6, 1
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 32: 12 B loads, 0 filler, doubleword 1
    li   s3, 40960
    li   t3, 225
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t2, 40(s3)
    sb   t3, 40(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 33: 12 B loads, 0 filler, doubleword 3
    li   s3, 41216
    li   t3, 232
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 34: 12 B loads, 1 filler, doubleword 1
    li   s3, 41472
    li   t3, 239
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    addi t6, t6, 1
    ld   t2, 40(s3)
    sb   t3, 42(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 35: 12 B loads, 1 filler, doubleword 3
    li   s3, 41728
    li   t3, 246
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    addi t6, t6, 1
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 36: 13 B loads, 0 filler, doubleword 1
    li   s3, 41984
    li   t3, 253
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t2, 40(s3)
    sb   t3, 44(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 37: 13 B loads, 0 filler, doubleword 3
    li   s3, 42240
    li   t3, 260
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 38: 13 B loads, 1 filler, doubleword 1
    li   s3, 42496
    li   t3, 267
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    addi t6, t6, 1
    ld   t2, 40(s3)
    sb   t3, 46(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 39: 13 B loads, 1 filler, doubleword 3
    li   s3, 42752
    li   t3, 274
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    addi t6, t6, 1
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 40: 14 B loads, 0 filler, doubleword 1
    li   s3, 43008
    li   t3, 281
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t2, 40(s3)
    sb   t3, 40(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 41: 14 B loads, 0 filler, doubleword 3
    li   s3, 43264
    li   t3, 288
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 42: 14 B loads, 1 filler, doubleword 1
    li   s3, 43520
    li   t3, 295
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    addi t6, t6, 1
    ld   t2, 40(s3)
    sb   t3, 42(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 43: 14 B loads, 1 filler, doubleword 3
    li   s3, 43776
    li   t3, 302
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    addi t6, t6, 1
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 44: 15 B loads, 0 filler, doubleword 1
    li   s3, 44032
    li   t3, 309
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t2, 40(s3)
    sb   t3, 44(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 45: 15 B loads, 0 filler, doubleword 3
    li   s3, 44288
    li   t3, 316
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 46: 15 B loads, 1 filler, doubleword 1
    li   s3, 44544
    li   t3, 323
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    addi t6, t6, 1
    ld   t2, 40(s3)
    sb   t3, 46(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 47: 15 B loads, 1 filler, doubleword 3
    li   s3, 44800
    li   t3, 330
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    addi t6, t6, 1
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 48: 16 B loads, 0 filler, doubleword 1
    li   s3, 45056
    li   t3, 337
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t2, 40(s3)
    sb   t3, 40(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 49: 16 B loads, 0 filler, doubleword 3
    li   s3, 45312
    li   t3, 344
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 50: 16 B loads, 1 filler, doubleword 1
    li   s3, 45568
    li   t3, 351
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    addi t6, t6, 1
    ld   t2, 40(s3)
    sb   t3, 42(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 51: 16 B loads, 1 filler, doubleword 3
    li   s3, 45824
    li   t3, 358
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    addi t6, t6, 1
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 52: 17 B loads, 0 filler, doubleword 1
    li   s3, 46080
    li   t3, 365
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t2, 40(s3)
    sb   t3, 44(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 53: 17 B loads, 0 filler, doubleword 3
    li   s3, 46336
    li   t3, 372
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 54: 17 B loads, 1 filler, doubleword 1
    li   s3, 46592
    li   t3, 379
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    addi t6, t6, 1
    ld   t2, 40(s3)
    sb   t3, 46(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 55: 17 B loads, 1 filler, doubleword 3
    li   s3, 46848
    li   t3, 386
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    addi t6, t6, 1
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 56: 18 B loads, 0 filler, doubleword 1
    li   s3, 47104
    li   t3, 393
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t2, 40(s3)
    sb   t3, 40(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 57: 18 B loads, 0 filler, doubleword 3
    li   s3, 47360
    li   t3, 400
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 58: 18 B loads, 1 filler, doubleword 1
    li   s3, 47616
    li   t3, 407
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    addi t6, t6, 1
    ld   t2, 40(s3)
    sb   t3, 42(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 59: 18 B loads, 1 filler, doubleword 3
    li   s3, 47872
    li   t3, 414
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    addi t6, t6, 1
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 60: 19 B loads, 0 filler, doubleword 1
    li   s3, 48128
    li   t3, 421
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t1, 8(s2)
    ld   t2, 40(s3)
    sb   t3, 44(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 61: 19 B loads, 0 filler, doubleword 3
    li   s3, 48384
    li   t3, 428
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    ld   t1, 88(s2)
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 62: 19 B loads, 1 filler, doubleword 1
    li   s3, 48640
    li   t3, 435
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    ld   t1, 136(s2)
    addi t6, t6, 1
    ld   t2, 40(s3)
    sb   t3, 46(s3)
    ld   t4, 40(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    # round 63: 19 B loads, 1 filler, doubleword 3
    li   s3, 48896
    li   t3, 442
    ld   t0, 0(s3)
    add  a0, a0, t0
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    ld   t1, 216(s2)
    addi t6, t6, 1
    sd   t3, 56(s3)
    ld   t2, 56(s3)
    ld   t4, 56(s3)
    add  a0, a0, t1
    add  a0, a0, t2
    xor  a0, a0, t4
    slli t5, a0, 5
    srli t6, a0, 59
    or   a0, t5, t6
    halt
