# compare/array_sum_max (RISC-V): the sum and the largest of ten numbers in memory
# Result = largest * 1000 + sum. max (from the Zbb extension) picks the larger without a branch.
# RESULT: 159628
    la   t0, data
    li   t1, 10              # count
    li   a0, 0               # sum
    ld   t2, 0(t0)           # largest so far = the first
loop:
    ld   t3, 0(t0)
    addi t0, t0, 8
    add  a0, a0, t3
    max  t2, t2, t3          # no branch to mispredict
    addi t1, t1, -1
    bnez t1, loop
    li   t4, 1000
    mul  t2, t2, t4
    add  a0, a0, t2
    halt
    .align 3
data:
    .dword 31, 4, 159, 26, 53, 58, 97, 93, 23, 84
