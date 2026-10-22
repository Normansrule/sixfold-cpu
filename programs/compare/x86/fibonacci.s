# compare/fibonacci (x86-64): the 30th Fibonacci number, iteratively
# lea computes an address without touching memory or the flags; here it is just a three-operand add.
# dec sets the zero flag, so no compare is needed before jnz.
# RESULT: 832040
    xor  rax, rax            ; a = F(0)
    mov  rbx, 1              ; b = F(1)
    mov  rcx, 30
loop:
    lea  rdx, [rax + rbx]    ; a + b
    mov  rax, rbx
    mov  rbx, rdx
    dec  rcx
    jnz  loop
    hlt
