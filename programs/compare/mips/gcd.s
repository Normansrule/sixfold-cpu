# compare/gcd (MIPS32): the greatest common divisor of 1071 and 462 (Euclid, with remainders)
# divu starts the divider and the pipeline goes on: the quotient lands in LO, the remainder in HI.
# mfhi waits ("H") until the divider is done; independent instructions could run meanwhile.
# RESULT: 21
    .set noreorder
    li    $a0, 1071
    li    $a1, 462
loop:
    beqz  $a1, done
    nop
    divu  $a0, $a1            # HI = a mod b, LO = a / b
    move  $a0, $a1
    mfhi  $a1                 # b = a mod b
    b     loop
    nop
done:
    move  $v0, $a0
    halt
