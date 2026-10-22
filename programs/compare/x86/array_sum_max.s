# compare/array_sum_max (x86-64): the sum and the largest of ten numbers in memory
# Result = largest * 1000 + sum. "add rax, [rsi]" reads memory inside an arithmetic instruction (one
# instruction, two micro-ops: a load, then the add), and cmovg picks the larger without a branch.
# RESULT: 159628
    lea  rsi, [data]
    mov  rcx, 10
    xor  rax, rax            ; sum
    mov  rbx, [rsi]          ; largest so far = the first
loop:
    mov  rdx, [rsi]
    add  rax, [rsi]          ; load + add: one instruction, two micro-ops
    cmp  rdx, rbx
    cmovg rbx, rdx           ; largest = this one, if it is greater (no branch)
    add  rsi, 8
    dec  rcx
    jnz  loop
    imul rbx, rbx, 1000
    add  rax, rbx
    hlt
    .align 3
data:
    .quad 31, 4, 159, 26, 53, 58, 97, 93, 23, 84
