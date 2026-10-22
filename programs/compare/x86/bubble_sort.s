# compare/bubble_sort (x86-64): sort eight numbers in memory, then a checksum
# checksum = 1*a[0] + 2*a[1] + ... + 8*a[7] of the sorted array (2 7 18 33 45 52 64 91)
# RESULT: 1915
    lea  rdi, [data]
    mov  r8, 8               ; n
outer:
    dec  r8                  ; pairs left to compare in this pass
    jle  done
    mov  rsi, rdi
    mov  rcx, r8
inner:
    mov  rax, [rsi]
    mov  rdx, [rsi + 8]
    cmp  rdx, rax            ; a[j+1] < a[j]?
    jge  noswap
    mov  [rsi], rdx          ; swap
    mov  [rsi + 8], rax
noswap:
    add  rsi, 8
    dec  rcx
    jnz  inner
    jmp  outer
done:
    xor  rax, rax
    mov  rcx, 1              ; weight
    mov  rsi, rdi
sum:
    mov  rdx, [rsi]
    imul rdx, rcx
    add  rax, rdx
    add  rsi, 8
    inc  rcx
    cmp  rcx, 9
    jne  sum
    hlt
    .align 3
data:
    .quad 52, 7, 33, 91, 18, 64, 2, 45
