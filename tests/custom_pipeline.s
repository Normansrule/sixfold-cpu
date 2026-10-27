# =============================================================================
# tests/custom_pipeline.s: custom instructions in every awkward place in the pipeline
#
# make test runs this on the RTL and on the model and compares them on every clock cycle. A timer
# interrupt every 37 cycles replaces instructions in DECODE, including custom ones, while the loop
# chains custom results into custom instructions, a store's data, a load, a multiply, a divide, a branch,
# a JALR target, a CSR write and x0, and runs an unassigned custom-0 encoding (.word, gives 0). The
# 64-byte stride through buf causes data-cache misses on the performance build. (Written by an
# independent review of the custom-instruction hardware: docs/CUSTOM_INSTRUCTIONS.md.)
# =============================================================================
    .equ DEVICES,  0x10000000
    .equ MTIME,    0x58
    .equ MTIMECMP, 0x60
    .equ PERIOD,   37
    la   t0, handler
    csrw mtvec, t0
    li   s0, DEVICES
    li   s1, 0
    ld   t0, MTIME(s0)
    addi t0, t0, PERIOD
    sd   t0, MTIMECMP(s0)
    li   t0, 0x80
    csrw mie, t0
    csrsi mstatus, 8
    li   a0, 0
    li   a1, 0x0123456789abcdef
    li   a2, 0x7fffffffffff0001
    la   s11, buf
    li   t6, 0
loop:
    absdiff t0, a1, a2
    absdiff t1, t0, a2
    hamming t2, t1, t0
    clampi  s3, t2, 100
    avgu    s5, t0, t1
    andi    t5, t6, 127
    slli    t5, t5, 6
    add     s4, s11, t5
    sd      s5, 0(s4)
    ld      s6, 0(s4)
    absdiff s7, s6, a1
    mul     s8, s7, t0
    absdiff s8, s8, s7
    div     s9, s8, a2
    absdiff x0, a1, a2
    add     s9, s9, x0
    .word   180727051
    absdiff a3, a1, s9
    beq     a3, x0, skip1
    xor     a0, a0, a3
skip1:  la      a5, tgt2
    avgu    a4, a5, a5
    jalr    x0, 0(a4)
    li      a0, -1
tgt2:  hamming a6, a1, a2
    csrw    mscratch, a6
    csrr    a7, mscratch
    clampi  a6, a6, -5
    sd      a7, 8(s4)
    hamming a7, a7, a6
    sd      a7, 16(s4)
    add     a0, a0, s3
    add     a0, a0, s5
    add     a0, a0, s7
    add     a0, a0, s8
    add     a0, a0, s9
    add     a0, a0, s10
    add     a0, a0, a7
    slli    t4, a1, 13
    srli    a1, a1, 51
    or      a1, a1, t4
    add     a2, a2, a1
    addi    t6, t6, 1
    li      t5, 400
    blt     t6, t5, loop
    csrci   mstatus, 8
    mv      a1, s1
    halt
handler:
    addi s1, s1, 1
    ld   t3, MTIMECMP(s0)
    addi t3, t3, PERIOD
    sd   t3, MTIMECMP(s0)
    mret
    .align 3
buf:
    .zero 8256
