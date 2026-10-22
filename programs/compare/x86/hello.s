# compare/hello (x86-64): print a string, one byte store per character
# A store to 0x1000_0000 is the PUTCHAR device, as on Sixfold. Result = characters printed.
# movzx loads one byte and clears the rest of the register; [rsi + rax] adds two registers in the address.
# RESULT: 14
# OUTPUT: Hello, world!\n
    lea  rsi, [message]
    mov  rdi, 0x10000000     ; PUTCHAR
    xor  rax, rax
loop:
    movzx rdx, byte [rsi + rax]
    test rdx, rdx
    jz   done
    mov  [rdi], dl           ; store the low byte of rdx
    inc  rax
    jmp  loop
done:
    hlt
message:
    .string "Hello, world!\n"
