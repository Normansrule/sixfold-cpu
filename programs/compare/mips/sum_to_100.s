# compare/sum_to_100 (MIPS32): add 1 + 2 + ... + 100 in a loop
# The increment sits in the branch's DELAY SLOT: it runs whether or not the branch is taken,
# so the loop has no wasted instruction and the taken branch costs no cycle.
# RESULT: 5050
    .set noreorder
    li    $t0, 1              # i
    li    $t1, 100
    li    $v0, 0              # sum
loop:
    addu  $v0, $v0, $t0
    bne   $t0, $t1, loop
    addiu $t0, $t0, 1         # delay slot: i++ (runs on every pass, taken or not)
    halt
