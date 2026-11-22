# =============================================================================
# 19_performance_counters.s: the cycle equation, counted by the hardware itself
#
# docs/MATH.md proves that every cycle is either an instruction or one of seven
# kinds of bubble:  cycles = N + 5 + L + 3F + R + K + I + D + B.
# Sixfold counts each term in hardware (src/Control_Status_Register_File.sv):
#
#   hpmcounter3 (0xC03)  L  load-stall cycles        hpmcounter6 (0xC06)  K  multiply/divide busy cycles
#   hpmcounter4 (0xC04)  F  flushes (3 bubbles each)  hpmcounter7 (0xC07)  I  instruction-cache miss cycles
#   hpmcounter5 (0xC05)  R  FETCH2 redirects          hpmcounter8 (0xC08)  D  data-cache miss cycles
#   hpmcounter10 (0xC0A) B  turbo build only: instructions a late branch flush removed from EXECUTE
#
# The workload below has a bit of everything (loads used right away, branches
# that are hard to guess, a multiply, a divide, cold caches). Afterwards, all
# counted since reset:
#   a0 = cycles          a1 = instructions retired (N)
#   a2 = L   a3 = F   a4 = R   a5 = K   a6 = I   a7 = D   t4 = B
#   s2 = N + 5 + L + 3F + R + K + I + D + B   (the equation, from the counters)
# s2 comes out a few cycles away from a0 only because the counters are read in
# EXECUTE while instructions and bubbles are still in flight (see 12_measure_cpi).
# Every value is checked cycle-exact against the model by `make test`.
# EXPECT: s3 = 1
# =============================================================================
    la   t0, table
    li   t1, 0               # i
    li   t2, 0               # sum
    li   t6, 12
work:
    ld   t3, 0(t0)           # a load used right away: 1 load-stall cycle
    add  t2, t2, t3
    andi t4, t3, 1           # data-dependent branch: odd numbers skip the add below
    bnez t4, odd
    addi t2, t2, 100
odd:
    addi t0, t0, 8
    addi t1, t1, 1
    bne  t1, t6, work
    mul  t2, t2, t6          # the multiply/divide unit: K cycles
    divu t2, t2, t1
    rdcycle    a0            # cycles since reset
    rdinstret  a1            # instructions retired since reset (N)
    csrr a2, hpmcounter3     # L
    csrr a3, hpmcounter4     # F
    csrr a4, hpmcounter5     # R
    csrr a5, hpmcounter6     # K
    csrr a6, hpmcounter7     # I
    csrr a7, hpmcounter8     # D
    csrr t4, hpmcounter10    # B (0 outside the turbo build)
    addi s2, a1, 5           # N + 5 (filling the empty pipeline)
    add  s2, s2, a2          # + L
    slli t3, a3, 1
    add  t3, t3, a3          # 3F
    add  s2, s2, t3
    add  s2, s2, a4
    add  s2, s2, a5
    add  s2, s2, a6
    add  s2, s2, a7
    add  s2, s2, t4
    sub  t3, a0, s2          # how far apart are the two sides?
    bgez t3, positive
    neg  t3, t3
positive:
    sltiu s3, t3, 16         # s3 = 1: within the few in-flight cycles
    halt

    .align 3
table:
    .dword 5, 8, 13, 2, 7, 7, 10, 3, 21, 4, 4, 9
