# compare/bubble_sort (MIPS32): sort eight numbers in memory, then a checksum
# checksum = 1*a[0] + 2*a[1] + ... + 8*a[7] of the sorted array (2 7 18 33 45 52 64 91)
# RESULT: 1915
    .set noreorder
    la    $s0, data
    li    $s1, 8              # n
outer:
    addiu $s1, $s1, -1        # pairs left to compare in this pass
    blez  $s1, done
    nop
    move  $t0, $s0            # p = &a[0]
    move  $t1, $s1
inner:
    lw    $t2, 0($t0)
    lw    $t3, 4($t0)
    slt   $t4, $t3, $t2       # a[j+1] < a[j]?
    beqz  $t4, noswap
    nop
    sw    $t3, 0($t0)         # swap
    sw    $t2, 4($t0)
noswap:
    addiu $t1, $t1, -1
    bnez  $t1, inner
    addiu $t0, $t0, 4         # delay slot: p++
    b     outer
    nop
done:
    li    $v0, 0
    li    $t1, 1              # weight
    move  $t0, $s0
    li    $t5, 9
sum:
    lw    $t2, 0($t0)
    mul   $t3, $t2, $t1
    addu  $v0, $v0, $t3
    addiu $t1, $t1, 1
    bne   $t1, $t5, sum
    addiu $t0, $t0, 4         # delay slot
    halt
    .align 2
data:
    .word 52, 7, 33, 91, 18, 64, 2, 45
