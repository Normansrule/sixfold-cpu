# compare/gcd (x86-64): the greatest common divisor of 1071 and 462 (Euclid, with remainders)
# div divides the 128-bit rdx:rax by its operand: quotient to rax, remainder to rdx. Its operands
# are fixed registers, a legacy of the 8086, so the loop shuffles values through rax and rdx.
# RESULT: 21
    mov  rax, 1071
    mov  rbx, 462
loop:
    test rbx, rbx
    jz   done
    xor  rdx, rdx            ; the high half of the dividend
    div  rbx                 ; rax = rdx:rax / rbx, rdx = remainder
    mov  rax, rbx
    mov  rbx, rdx
    jmp  loop
done:
    hlt
