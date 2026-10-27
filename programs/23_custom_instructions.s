# =============================================================================
# 23_custom_instructions.s: four instructions that are not in RISC-V, designed in custom/instructions.json
#
# RISC-V leaves the opcode custom-0 free for instructions a designer adds. Sixfold's four examples
# (src/Custom_Unit.sv is generated from the JSON file by `make custom`):
#
#   absdiff rd, rs1, rs2    |rs1 - rs2| (unsigned)                 video motion search
#   avgu    rd, rs1, rs2    (rs1 + rs2) / 2 that never overflows    image scaling
#   hamming rd, rs1, rs2    number of bits that differ              error-correcting codes
#   clampi  rd, rs1, imm    rs1 limited to 0 ... imm (signed)       saturating a pixel to 0 ... 255
#
# Each is measured against the plain RV64I code it replaces:
#   a0 : sum of absolute differences of two 8-element arrays (both ways, checked equal)
#   a1 : Hamming distance of two 64-bit words (both ways)
#   a2 : 8 pixels clamped to 0 ... 255, then summed
#   a3 : the average of two numbers near 2^64 (the plain a + b overflows; avgu does not)
#   a4 : cycles of the plain sum of absolute differences, a5 : cycles with absdiff
#   a6 : cycles of the plain Hamming distance,             a7 : cycles with hamming
#   s9 : an unassigned custom-0 encoding gives 0 (what Custom_Unit.sv's default does)
#
# Custom logic runs in the MEMORY stage, a cycle it shares with nothing, so it can never slow the clock;
# the price is that an instruction right behind one that needs its result waits two cycles (one with an
# instruction in between, none with two).
# EXPECT: a0 = 303
# EXPECT: a1 = 34
# EXPECT: a2 = 912
# EXPECT: a3 = -2
# EXPECT: s9 = 0
# EXPECT: s10 = 1
# =============================================================================
    la   s0, array_x
    la   s1, array_y
    # ---------------- sum of absolute differences, RV64I: compare, then subtract one way or the other
    rdcycle t6
    li   a0, 0
    li   t0, 0
sad_loop:
    slli t1, t0, 3
    add  t2, s0, t1
    add  t3, s1, t1
    ld   t2, 0(t2)
    ld   t3, 0(t3)
    bltu t2, t3, sad_swap
    sub  t4, t2, t3
    j    sad_add
sad_swap:
    sub  t4, t3, t2
sad_add:
    add  a0, a0, t4
    addi t0, t0, 1
    li   t5, 8
    blt  t0, t5, sad_loop
    rdcycle t5
    sub  a4, t5, t6
    mv   s2, a0
    # ---------------- the same with absdiff: no branch to mispredict
    rdcycle t6
    li   a0, 0
    mv   t1, s0
    mv   t2, s1
    addi t3, s0, 64
absdiff_loop:
    ld   t4, 0(t1)
    ld   t5, 0(t2)
    absdiff t4, t4, t5       # its operand comes from the load just before: a load stall, as for any instruction
    addi t1, t1, 8
    addi t2, t2, 8
    add  a0, a0, t4          # three instructions after absdiff: its result is ready, no wait
    bne  t1, t3, absdiff_loop
    rdcycle t5
    sub  a5, t5, t6
    sub  s10, a0, s2
    seqz s10, s10            # 1 when both ways agree
    # ---------------- Hamming distance, RV64I: clear the lowest 1 bit until none are left
    li   s3, 0x0123456789ABCDEF
    li   s4, 0xFEDC00FF89AB0000
    rdcycle t6
    xor  t0, s3, s4
    li   a1, 0
ham_loop:
    beqz t0, ham_done
    addi t1, t0, -1
    and  t0, t0, t1
    addi a1, a1, 1
    j    ham_loop
ham_done:
    rdcycle t5
    sub  a6, t5, t6
    mv   s5, a1
    # ---------------- the same with hamming
    rdcycle t6
    hamming a1, s3, s4
    rdcycle t5
    sub  a7, t5, t6
    sub  t0, a1, s5
    snez t0, t0
    sub  s10, s10, t0        # still 1 only if this agreed too
    # ---------------- clamp 8 signed pixels to 0 ... 255 and add them up
    la   t1, pixels
    addi t3, t1, 64
    li   a2, 0
clamp_loop:
    ld   t4, 0(t1)
    clampi t4, t4, 255
    add  a2, a2, t4          # right after clampi: waits two cycles for its result
    addi t1, t1, 8
    bne  t1, t3, clamp_loop
    # ---------------- the average of two large numbers
    li   t0, -1              # 2^64 - 1
    li   t1, -3              # 2^64 - 3
    avgu a3, t0, t1          # 2^64 - 2, which is -2 as a signed number
    # ---------------- a custom result as a store's data, an address and a branch operand
    la   t2, scratch
    absdiff t3, t2, zero     # = the address of scratch
    nop
    sd   a3, 0(t3)
    ld   t4, 0(t2)
    bne  t4, a3, failed
    clampi t5, a3, -1        # a negative immediate: max(-2, 0) = 0, min(0, -1) = -1
    li   t6, -1
    bne  t5, t6, failed
    # ---------------- an encoding no instruction uses: funct3 = 2, funct7 = 5 gives 0
    li   s9, 1234
    .word 0x0A0A2C8B         # custom-0, rd = s9, rs1 = s4, rs2 = zero, funct3 = 2, funct7 = 5
    halt
failed:
    li   s10, 0
    halt

    .align 3
array_x:  .dword 12, 40, 7, 99, 3, 250, 18, 60
array_y:  .dword 30, 10, 7, 1, 90, 200, 2, 64
pixels:   .dword -40, 12, 300, 255, 128, 1000, -1, 7
scratch:  .dword 0
