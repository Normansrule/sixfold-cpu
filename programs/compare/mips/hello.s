# compare/hello (MIPS32): print a string, one byte store per character
# A store to 0x1000_0000 is the PUTCHAR device, as on Sixfold. Result = characters printed.
# RESULT: 14
# OUTPUT: Hello, world!\n
    .set noreorder
    la    $t0, message
    li    $t1, 0x10000000     # PUTCHAR
    li    $v0, 0
loop:
    lbu   $t2, 0($t0)
    beqz  $t2, done
    addiu $t0, $t0, 1         # delay slot
    sb    $t2, 0($t1)
    b     loop
    addiu $v0, $v0, 1         # delay slot: count it
done:
    halt
message:
    .string "Hello, world!\n"
