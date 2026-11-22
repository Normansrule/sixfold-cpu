# =============================================================================
# tests/m_divide_lengths.s: divides whose step count sits right at the edge of the quotient-length estimate
#
# The turbo build's divider runs ceil(q / 2) radix-4 steps, where q = (divisor's leading zeros) -
# (dividend's leading zeros) + 1 is the quotient's length at most; for a negative divisor it counts the
# zeros of ~B, which is one short of |B| exactly when B is minus a power of two. So this test divides
# three dividends (the largest positive number, the most negative number, and 12345, in both signs) by
# every power of two and its negative, signed and unsigned, 64-bit and word, and folds every quotient and
# remainder into a checksum. One step too few gives a wrong quotient; make test also compares the cycle
# counts of the RTL and the model, so one step too many shows up too.
# EXPECT: a0 = 3952873739897689088
# =============================================================================
    li   a0, 0                      # checksum
    la   s0, dividends
    li   s1, 4                      # dividends
next_dividend:
    ld   s2, 0(s0)
    li   s3, 0                      # k
next_power:
    li   t0, 1
    sll  t0, t0, s3                 # 2^k
    neg  t1, t0                     # -2^k
    div  t2, s2, t1
    rem  t3, s2, t1
    divu t4, s2, t0
    remu t5, s2, t0
    div  t6, s2, t0
    remw a1, s2, t1
    divw a2, s2, t1
    divuw a3, s2, t0
    add  a0, a0, t2
    slli a0, a0, 1
    xor  a0, a0, t3
    add  a0, a0, t4
    slli a0, a0, 1
    xor  a0, a0, t5
    add  a0, a0, t6
    xor  a0, a0, a1
    add  a0, a0, a2
    xor  a0, a0, a3
    addi s3, s3, 1
    li   t0, 64
    blt  s3, t0, next_power
    addi s0, s0, 8
    addi s1, s1, -1
    bnez s1, next_dividend
    halt
    .align 3
dividends:
    .dword 0x7fffffffffffffff
    .dword 0x8000000000000000
    .dword 12345
    .dword -12345
