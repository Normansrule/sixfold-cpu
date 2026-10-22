# compare/array_sum_max (MIPS32): the sum and the largest of ten numbers in memory
# Result = largest * 1000 + sum. Loads, a data-dependent branch, and slt + beqz for "less than":
# MIPS compares two registers only for equality (beq / bne); every other comparison is slt first.
# RESULT: 159628
    .set noreorder
    la    $t0, data
    li    $t1, 10             # count
    li    $v0, 0              # sum
    lw    $t2, 0($t0)         # largest so far = the first
loop:
    lw    $t3, 0($t0)
    addiu $t0, $t0, 4
    addu  $v0, $v0, $t3
    slt   $t4, $t2, $t3       # largest < this one?
    beqz  $t4, skip
    addiu $t1, $t1, -1        # delay slot: count--
    move  $t2, $t3
skip:
    bnez  $t1, loop
    nop                       # delay slot: nothing useful to put here
    li    $t5, 1000
    mul   $t2, $t2, $t5
    addu  $v0, $v0, $t2
    halt
    .align 2
data:
    .word 31, 4, 159, 26, 53, 58, 97, 93, 23, 84
