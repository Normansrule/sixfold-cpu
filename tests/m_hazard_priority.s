# =============================================================================
# tests/m_hazard_priority.s: a DECODE hazard right behind an M instruction that is still iterating
#
# A load stall puts a bubble into EXECUTE. If that happens while the iterative multiply/divide unit is
# still working on the instruction in EXECUTE, the unfinished instruction must NOT be pushed on to MEMORY:
# the multiply/divide stall wins and DECODE waits. Two hazards can arise there:
#   1. a custom instruction's result is in MEMORY and DECODE needs it (custom results are ready only in WRITEBACK)
#   2. a `bset` whose bit number is the M result (the single-bit decoder sits on the early operand path only)
# Each loop runs twice with new operands, so a stale result from the previous M instruction is caught by
# the register comparison between the RTL and the model, and by the EXPECT lines below.
# EXPECT: a1 = 102
# EXPECT: a3 = 102
# EXPECT: a5 = 144
# EXPECT: s3 = 4
# EXPECT: s4 = 16
# EXPECT: s5 = 24
# EXPECT: s7 = 7
# EXPECT: s8 = 256
# =============================================================================
    # ---------------- 1. custom result in MEMORY, mul in EXECUTE, dependent add in DECODE
    li   t0, 7
    li   t1, 6
    li   t2, 100
    li   t3, 1
    li   t4, 2
    li   a5, 0
loop1:
    absdiff a0, t2, t3
    mul  a1, t0, t1
    add  a2, a0, t3
    add  a3, a1, zero
    add  a5, a5, a3
    addi t0, t0, 10
    addi t4, t4, -1
    bnez t4, loop1
    # ---------------- 2. bset whose bit number the mul right before it computes
    li   t0, 3
    li   t1, 1
    li   s0, 0
    li   t4, 2
    li   s5, 0
loop2:
    mul  s3, t0, t1
    bset s4, s0, s3
    add  s5, s5, s4
    addi t0, t0, 1
    addi t4, t4, -1
    bnez t4, loop2
    # ---------------- 3. the same with a divide (more iterations) and a custom hazard
    li   t0, 70
    li   t1, 10
    li   t4, 2
    li   s8, 0
loop3:
    absdiff s6, t2, t3
    divu s7, t0, t1
    add  s9, s6, t3
    bset s10, zero, s7
    add  s8, s8, s10
    addi t4, t4, -1
    bnez t4, loop3
    halt
