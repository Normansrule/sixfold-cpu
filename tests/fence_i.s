# =============================================================================
# tests/fence_i.s: FENCE.I (the Zifencei extension) makes new code visible to fetch
#
# Three rewrites of code that is still in the instruction cache (nothing is evicted), each followed by a
# FENCE.I, and each run again at once. Without FENCE.I a build with an instruction cache or a branch target
# buffer (BTB) would run the old words; with it, every build must run the new ones:
#   1. a loop body instruction, run 3 times first (cached): addi a0, a0, 1  ->  addi a0, a0, 20
#   2. the instruction right after the FENCE.I itself (already fetched behind it): addi a0, a0, 2 -> addi a0, a0, 300
#   3. a jump the BTB has learned, run 3 times first: j skip (skips +4000)  ->  nop (runs into +4000)
#
# a0 = 3 * 1 (loop before) + 20 (loop after) + 300 + 4000 = 4323
# EXPECT: a0 = 4323
# =============================================================================
    li   a0, 0
    # ---- 1. a cached loop body
    li   s1, 3
loop1:
    call body
    addi s1, s1, -1
    bnez s1, loop1
    la   t0, body
    la   t2, new_add20
    lw   t1, 0(t2)
    sw   t1, 0(t0)
    fence.i
    call body                       # must add 20

    # ---- 2. the very next instruction
    la   t0, next
    la   t2, new_add300
    lw   t1, 0(t2)
    sw   t1, 0(t0)
    fence.i
next:
    addi a0, a0, 2                  # replaced by addi a0, a0, 300 before it runs

    # ---- 3. a jump the BTB knows
    li   s1, 3
loop3:
    call jumper                     # each call: the jump skips the +4000
    addi s1, s1, -1
    bnez s1, loop3
    la   t0, jumper
    la   t2, new_nop
    lw   t1, 0(t2)
    sw   t1, 0(t0)
    fence.i
    call jumper                     # the jump is gone: +4000 runs
    halt

body:
    addi a0, a0, 1                  # replaced by addi a0, a0, 20
    ret

jumper:
    j    skip                       # replaced by nop
    li   t3, 4000
    add  a0, a0, t3
skip:
    ret

new_add20:
    addi a0, a0, 20                 # (data: copied over body)
new_add300:
    addi a0, a0, 300                # (data: copied over next)
new_nop:
    nop                             # (data: copied over jumper)
