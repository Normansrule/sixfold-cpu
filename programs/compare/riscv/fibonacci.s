# compare/fibonacci (RISC-V): the 30th Fibonacci number, iteratively
# RESULT: 832040
    li   t0, 0               # a = F(0)
    li   t1, 1               # b = F(1)
    li   t2, 30              # n
loop:
    add  t3, t0, t1          # a + b
    mv   t0, t1
    mv   t1, t3
    addi t2, t2, -1
    bnez t2, loop
    mv   a0, t0
    halt
