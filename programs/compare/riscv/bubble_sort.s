# compare/bubble_sort (RISC-V): sort eight numbers in memory, then a checksum
# checksum = 1*a[0] + 2*a[1] + ... + 8*a[7] of the sorted array (2 7 18 33 45 52 64 91)
# RESULT: 1915
    la   s0, data
    li   s1, 8               # n
outer:
    addi s1, s1, -1          # pairs left to compare in this pass
    blez s1, done
    mv   t0, s0              # p
    mv   t1, s1
inner:
    ld   t2, 0(t0)
    ld   t3, 8(t0)
    bge  t3, t2, noswap      # a[j+1] >= a[j]: in order
    sd   t3, 0(t0)           # swap
    sd   t2, 8(t0)
noswap:
    addi t0, t0, 8
    addi t1, t1, -1
    bnez t1, inner
    j    outer
done:
    li   a0, 0
    li   t1, 1               # weight
    mv   t0, s0
    li   t5, 9
sum:
    ld   t2, 0(t0)
    mul  t3, t2, t1
    add  a0, a0, t3
    addi t0, t0, 8
    addi t1, t1, 1
    bne  t1, t5, sum
    halt
    .align 3
data:
    .dword 52, 7, 33, 91, 18, 64, 2, 45
