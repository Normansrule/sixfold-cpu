# compare/fibonacci (MIPS32): the 30th Fibonacci number, iteratively
# bnez compares in DECODE, one stage before EXECUTE: it needs $t2 from the addiu right in front
# of it, which is still in EXECUTE, so the pipeline waits one cycle ("B") on every pass.
# RESULT: 832040
    .set noreorder
    li    $t0, 0              # a = F(0)
    li    $t1, 1              # b = F(1)
    li    $t2, 30             # n
loop:
    addu  $t3, $t0, $t1       # a + b
    move  $t0, $t1
    addiu $t2, $t2, -1
    bnez  $t2, loop
    move  $t1, $t3            # delay slot
    move  $v0, $t0
    halt
