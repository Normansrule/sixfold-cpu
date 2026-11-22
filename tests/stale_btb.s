# =============================================================================
# tests/stale_btb.s: code that changes under a branch target buffer (BTB) entry
#
# The BTB remembers, for a jump it has seen, where the jump went, and sends fetch there before the jump is
# even decoded. This test teaches it two jumps, then rewrites both: the first becomes an addi (no longer a
# jump at all), the second a jump to a different place. It then pushes their cache line out of the
# instruction cache (by running code in the two other lines of the same set, so the next fetch reads the
# new words from memory) and runs them again. The BTB still holds the old targets. A FENCE.I after the
# rewrite is what RISC-V requires before running new code: on every build it empties the instruction cache
# and the BTB and fetches everything after it again. The eviction stays, so the program is right twice over,
# and the deep-pipeline edition (which also checks the BTB's guess in D1 and repairs it at M1) is tested both ways.
#
# Each training pass adds 1 + 10; the patched code adds 100 + 7 + 3 (the stale targets would add 1 or 10).
# EXPECT: a0 = 143
# =============================================================================
    li   a0, 0
    li   s1, 3
again:
    j    site
back:
    addi s1, s1, -1
    bnez s1, again
    # rewrite the code: site becomes "addi a0, a0, 100", site2 a jump 8 bytes on (to site + 16)
    la   t0, site
    la   t2, patch_addi
    lw   t1, 0(t2)
    sw   t1, 0(t0)
    la   t2, patch_jump
    lw   t1, 0(t2)
    sw   t1, 8(t0)
    fence.i                         # new code ahead: fetch must see the two stores
    # push site's line out of the instruction cache: two other lines of its set (4 KiB, 2 ways: 2 KiB apart)
    call evict1
    call evict2
    j    site
finish:
    halt

patch_addi:
    addi a0, a0, 100                # (data: copied over site)
patch_jump:
    jal  x0, patch_jump_target      # (data: an 8-byte forward jump, copied over site2)
    nop
patch_jump_target:
    nop

    .org 0x2400
site:
    jal  x0, hop_a                  # becomes addi a0, a0, 100
    addi a0, a0, 7
site2:
    jal  x0, hop_c                  # becomes a jump to site + 16
    addi a0, a0, 1000               # (skipped by the new jump)
    addi a0, a0, 3
    j    finish
hop_a:
    addi a0, a0, 1
    j    site2
hop_c:
    addi a0, a0, 10
    j    back

    .org 0x2c00
evict1:
    ret

    .org 0x3400
evict2:
    ret
