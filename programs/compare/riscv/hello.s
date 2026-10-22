# compare/hello (RISC-V): print a string, one byte store per character
# A store to 0x1000_0000 is the PUTCHAR device. Result = characters printed.
# RESULT: 14
# OUTPUT: Hello, world!\n
    la   t0, message
    li   t1, 0x10000000      # PUTCHAR
    li   a0, 0
loop:
    lbu  t2, 0(t0)
    beqz t2, done
    sb   t2, 0(t1)
    addi t0, t0, 1
    addi a0, a0, 1
    j    loop
done:
    halt
message:
    .string "Hello, world!\n"
