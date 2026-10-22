# compare/factorial_recursive (RISC-V): 10! by a recursive function
# call (jal ra) puts the return address in the register ra; a function that calls another saves ra
# on the stack itself. ret is jalr x0, 0(ra).
# RESULT: 3628800
    li   sp, 0xF000
    li   a0, 10
    call fact
    halt
fact:                        # a0 = a0!
    li   t0, 2
    blt  a0, t0, base
    addi sp, sp, -16
    sd   ra, 8(sp)
    sd   a0, 0(sp)
    addi a0, a0, -1
    call fact                # fact(n - 1)
    ld   t1, 0(sp)
    mul  a0, a0, t1
    ld   ra, 8(sp)
    addi sp, sp, 16
    ret
base:
    li   a0, 1               # 0! = 1! = 1
    ret
