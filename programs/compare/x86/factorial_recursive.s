# compare/factorial_recursive (x86-64): 10! by a recursive function
# call pushes the return address onto the stack in memory (no link register); ret pops it and jumps.
# push and pop move rsp and memory together. The argument travels in rdi, the result in rax.
# RESULT: 3628800
    mov  rsp, 0xF000
    mov  rdi, 10
    call fact
    hlt
fact:                        ; rax = rdi!
    cmp  rdi, 2
    jge  recurse
    mov  rax, 1              ; 0! = 1! = 1
    ret
recurse:
    push rdi
    dec  rdi
    call fact                ; fact(n - 1)
    pop  rdi
    imul rax, rdi
    ret
