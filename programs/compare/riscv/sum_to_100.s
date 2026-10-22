# compare/sum_to_100 (RISC-V): add 1 + 2 + ... + 100 in a loop
# ble compares two registers and branches in one instruction.
# RESULT: 5050
    li   t0, 1               # i
    li   t1, 100
    li   a0, 0               # sum
loop:
    add  a0, a0, t0
    addi t0, t0, 1
    ble  t0, t1, loop
    halt
