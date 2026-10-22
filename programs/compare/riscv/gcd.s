# compare/gcd (RISC-V): the greatest common divisor of 1071 and 462 (Euclid, with remainders)
# remu gives the remainder directly, into any register.
# RESULT: 21
    li   a0, 1071
    li   a1, 462
loop:
    beqz a1, done
    remu t0, a0, a1
    mv   a0, a1
    mv   a1, t0
    j    loop
done:
    halt
