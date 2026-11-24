# =============================================================================
# tests/exceptions.s: precise exceptions (EXCEPTIONS = 1 in src/Riscv64.sv)
#
# Each case runs one instruction that must trap, and checks what the trap handler saw:
#   mcause  2 illegal instruction, 0 misaligned jump target, 4 misaligned load, 6 misaligned store
#   mtval   the instruction word, the jump target, or the load / store address
#   mepc    the faulting instruction itself
# and that the instruction did nothing else: its destination register keeps its old value and a store
# leaves memory as it was. The handler returns to mepc + 4. A FAIL reports the case number in tohost.
# Then a few instructions that must NOT trap: aligned accesses, a not-taken branch to a bad target, JALR
# with bit 0 set (JALR clears it), wfi, and mstatus.MPP reading 3 (machine mode, the only mode).
#
# EXCEPTIONS: on
# EXPECT: a0 = 0
# EXPECT: s5 = 15
# =============================================================================
    la   t0, handler
    csrw mtvec, t0
    li   s5, 0                      # traps taken
    la   s0, data                   # 8-aligned

    # ---- illegal instructions: mcause 2, mtval = the word
    li   a0, 1
    li   s6, 2
    li   s7, 0
case1:
    .word 0x00000000                # the all-zero word
    la   s8, case1
    call check
    li   a0, 2
    li   s7, 0x10200073
case2:
    .word 0x10200073                # sret: no supervisor mode
    la   s8, case2
    call check
    li   a0, 3
    li   s7, 0x00007003
case3:
    .word 0x00007003                # a load with funct3 7 (does not exist)
    la   s8, case3
    call check
    li   a0, 4
    li   s7, 0x00004073
case4:
    .word 0x00004073                # SYSTEM funct3 4 (no instruction)
    la   s8, case4
    call check

    # ---- misaligned loads: mcause 4, mtval = address, the destination keeps its value
    li   s6, 4
    li   a0, 5
    li   t1, 1234
    addi s7, s0, 1
case5:
    lh   t1, 1(s0)
    la   s8, case5
    call check
    li   t2, 1234
    bne  t1, t2, fail
    li   a0, 6
    addi s7, s0, 2
case6:
    lw   t1, 2(s0)
    la   s8, case6
    call check
    li   a0, 7
    addi s7, s0, 4
case7:
    ld   t1, 4(s0)
    la   s8, case7
    call check
    li   a0, 8
    addi s7, s0, 3
case8:
    lwu  t1, 3(s0)
    la   s8, case8
    call check
    li   t2, 1234
    bne  t1, t2, fail

    # ---- misaligned stores: mcause 6, memory unchanged
    li   s6, 6
    li   a0, 9
    li   t1, -1
    addi s7, s0, 1
case9:
    sh   t1, 1(s0)
    la   s8, case9
    call check
    li   a0, 10
    addi s7, s0, 6
case10:
    sw   t1, 6(s0)
    la   s8, case10
    call check
    li   a0, 11
    addi s7, s0, 4
case11:
    sd   t1, 4(s0)
    la   s8, case11
    call check
    ld   t2, 0(s0)                  # still the original doubleword
    ld   t3, 8(s0)
    la   t4, original
    ld   t5, 0(t4)
    bne  t2, t5, fail
    ld   t5, 8(t4)
    bne  t3, t5, fail

    # ---- misaligned jump targets: mcause 0, mtval = target, rd not written
    li   s6, 0
    li   a0, 12
    li   t1, 77
    la   t0, case12
    addi s7, t0, 6                  # target: 2 bytes past the next instruction
case12:
    jalr t1, 6(t0)
    la   s8, case12
    call check
    li   t2, 77
    bne  t1, t2, fail
    li   a0, 13
    la   s7, case13
    addi s7, s7, 6
case13:
    .word 0x0060036f                # jal t1, .+6 (an odd half-word offset: the assembler will not write one)
    la   s8, case13
    call check
    li   t2, 77
    bne  t1, t2, fail
    li   a0, 14
    la   s7, case14
    addi s7, s7, 10
case14:
    .word 0x00000563                # beq zero, zero, .+10
    la   s8, case14
    call check
    li   a0, 15
    li   s6, 2                      # last: an illegal word in a loop, so the predictors see it more than once
    li   s9, 3
loop15:
    li   s7, 0xffffffff
case15:
    .word 0xffffffff
    la   s8, case15
    call check
    addi s9, s9, -1
    bnez s9, loop15
    addi s5, s5, -2                 # the loop trapped three times: count it once

    # ---- things that must not trap
    li   a0, 16
    mv   s4, s5
    lh   t1, 2(s0)
    lw   t1, 4(s0)
    ld   t1, 8(s0)
    sh   t1, 16(s0)
    sw   t1, 20(s0)
    sd   t1, 24(s0)
    .word 0x00001563                # bne zero, zero, .+10 (not taken: no trap)
    la   t0, ok17
    jalr t1, 1(t0)                  # bit 0 of the target is cleared, not a trap
ok17:
    wfi
    bne  s4, s5, fail
    li   a0, 17
    csrr t1, mstatus
    srli t1, t1, 11
    andi t1, t1, 3
    li   t2, 3
    bne  t1, t2, fail
    li   a0, 0
    halt

# check: the trap just taken had mcause s6, mtval s7 and mepc s8
check:
    bne  s2, s6, fail
    bne  s3, s7, fail
    bne  s4, s8, fail
    ret

fail:
    slli t0, a0, 1
    ori  t0, t0, 1
    csrw tohost, t0
    j    .

    .align 2
handler:
    csrr s2, mcause
    csrr s3, mtval
    csrr s4, mepc
    addi s5, s5, 1
    addi t6, s4, 4
    csrw mepc, t6
    mret

    .align 3
data:
    .dword 0x1122334455667788
    .dword 0x99aabbccddeeff00
    .zero 16
original:
    .dword 0x1122334455667788
    .dword 0x99aabbccddeeff00
