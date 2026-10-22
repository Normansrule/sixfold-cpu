# compare/factorial_recursive (MIPS32): 10! by a recursive function
# jal saves the return address in $ra (register 31, always: MIPS fixes it; RISC-V's jal names it).
# The return address is jal + 8, past the delay slot. The stack frame holds $ra and the argument.
# RESULT: 3628800
    .set noreorder
    li    $sp, 0xF000
    li    $a0, 10
    jal   fact
    nop                       # delay slot of the call
    halt
fact:                         # $v0 = $a0!
    addiu $sp, $sp, -8
    sw    $ra, 4($sp)
    sw    $a0, 0($sp)
    slti  $t1, $a0, 2
    beqz  $t1, recurse
    nop
    li    $v0, 1              # 0! = 1! = 1
    b     return
    nop
recurse:
    jal   fact                # fact(n - 1) ...
    addiu $a0, $a0, -1        # ... the argument is decremented in the delay slot
    lw    $a0, 0($sp)
    mul   $v0, $v0, $a0
return:
    lw    $ra, 4($sp)
    jr    $ra
    addiu $sp, $sp, 8         # delay slot: pop the frame on the way out
