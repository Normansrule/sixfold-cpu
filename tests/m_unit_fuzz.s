# =============================================================================
# tests/m_unit_fuzz.s: 400 pseudo-random multiplies and divides of every size and sign
#
# A 64-bit xorshift generator makes the operands; each is shifted right by a random amount (0 to 63) and
# negated at random, so the dividend has every possible number of significant bits, both signs, and the
# corner values 0, 1, -1 and the most negative number turn up. Every M instruction (MUL, MULH, MULHSU,
# MULHU, DIV, DIVU, REM, REMU and the W forms) runs on each pair, and its result is folded into a checksum.
# The model computes M results directly with BigInt arithmetic, and make test compares all 32 registers
# of the RTL with the model, so a wrong quotient digit or a wrong step count in the hardware shows up here.
# EXPECT: a0 = 3309556448707450994
# =============================================================================
    li   s0, 0x9E3779B97F4A7C15     # xorshift state
    li   s1, 0                      # checksum
    li   s2, 400                    # iterations
    li   s3, 0x8000000000000000
loop:
    # ---- next random a
    slli t0, s0, 13
    xor  s0, s0, t0
    srli t0, s0, 7
    xor  s0, s0, t0
    slli t0, s0, 17
    xor  s0, s0, t0
    andi t1, s0, 63
    srl  a0, s0, t1                 # a: 64 - t1 significant bits
    srli t2, s0, 6
    andi t2, t2, 1
    beqz t2, l1
    neg  a0, a0
l1:  # ---- next random b
    slli t0, s0, 13
    xor  s0, s0, t0
    srli t0, s0, 7
    xor  s0, s0, t0
    slli t0, s0, 17
    xor  s0, s0, t0
    andi t1, s0, 63
    srl  a1, s0, t1
    srli t2, s0, 6
    andi t2, t2, 3
    bnez t2, l2
    neg  a1, a1
l2:  srli t2, s0, 8
    andi t2, t2, 15
    bnez t2, l3                     # 1 in 16: a corner value for a
    srli t3, s0, 12
    andi t3, t3, 3
    li   a0, 0
    beqz t3, l3
    li   a0, -1
    addi t3, t3, -1
    beqz t3, l3
    mv   a0, s3                     # the most negative number
l3:  srli t2, s0, 16
    andi t2, t2, 15
    bnez t2, l4                     # 1 in 16: a corner value for b
    li   a1, 0
    srli t3, s0, 20
    andi t3, t3, 1
    beqz t3, l4
    li   a1, -1
l4:  mul    t0, a0, a1
    add    s1, s1, t0
    mulh   t0, a0, a1
    xor    s1, s1, t0
    mulhsu t0, a0, a1
    add    s1, s1, t0
    mulhu  t0, a0, a1
    xor    s1, s1, t0
    mulw   t0, a0, a1
    add    s1, s1, t0
    div    t0, a0, a1
    xor    s1, s1, t0
    divu   t0, a0, a1
    add    s1, s1, t0
    rem    t0, a0, a1
    xor    s1, s1, t0
    remu   t0, a0, a1
    add    s1, s1, t0
    divw   t0, a0, a1
    xor    s1, s1, t0
    divuw  t0, a0, a1
    add    s1, s1, t0
    remw   t0, a0, a1
    xor    s1, s1, t0
    remuw  t0, a0, a1
    add    s1, s1, t0
    slli   s1, s1, 1                # mix
    srli   t0, s1, 63
    or     s1, s1, t0
    addi   s2, s2, -1
    bnez   s2, loop
    mv     a0, s1
    halt
