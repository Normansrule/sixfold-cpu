# compare/sum_to_100 (x86-64): add 1 + 2 + ... + 100 in a loop
# cmp sets the FLAGS register; jle reads it. The comparison and the jump are two instructions that
# communicate through flags (RISC-V and MIPS compare and branch in one, through registers).
# RESULT: 5050
    mov  rcx, 1              ; i
    xor  rax, rax            ; sum = 0 (xor with itself: the usual 3-byte way to zero a register)
loop:
    add  rax, rcx
    inc  rcx
    cmp  rcx, 100
    jle  loop
    hlt
