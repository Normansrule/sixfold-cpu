# =============================================================================
# tests/xcompute_off.s: with XCOMPUTE = 0 (the default, what HYDRA-130 instantiates) the packed instructions
# do not exist: their custom-0 encodings select nothing in CustomDecode and write 0, like any unassigned
# custom-0 encoding. Runs only on the xoff build of tools/test.mjs (the line below); every other build has
# the instructions (tests/xcompute_selfcheck.s).
# XCOMPUTE: off
#   PASS: tohost = 1           FAIL: tohost = (test number << 1) | 1
#
# EXPECT: a0 = 0
# =============================================================================
t1: # paddus.b writes 0
    li   a0, 1
    li   a1, 0x7f80017f80017f80
    li   a2, 0x0102030405060708
    li   a3, 42
    paddus.b a3, a1, a2
    bnez a3, fail
t2: # psubus.b writes 0
    li   a0, 2
    li   a1, 0x7f80017f80017f80
    li   a2, 0x0102030405060708
    li   a3, 42
    psubus.b a3, a1, a2
    bnez a3, fail
t3: # pavgu.b writes 0
    li   a0, 3
    li   a1, 0x7f80017f80017f80
    li   a2, 0x0102030405060708
    li   a3, 42
    pavgu.b a3, a1, a2
    bnez a3, fail
t4: # pmaxu.b writes 0
    li   a0, 4
    li   a1, 0x7f80017f80017f80
    li   a2, 0x0102030405060708
    li   a3, 42
    pmaxu.b a3, a1, a2
    bnez a3, fail
t5: # pminu.b writes 0
    li   a0, 5
    li   a1, 0x7f80017f80017f80
    li   a2, 0x0102030405060708
    li   a3, 42
    pminu.b a3, a1, a2
    bnez a3, fail
t6: # psad.b writes 0
    li   a0, 6
    li   a1, 0x7f80017f80017f80
    li   a2, 0x0102030405060708
    li   a3, 42
    psad.b a3, a1, a2
    bnez a3, fail
t7: # pdot.b writes 0
    li   a0, 7
    li   a1, 0x7f80017f80017f80
    li   a2, 0x0102030405060708
    li   a3, 42
    pdot.b a3, a1, a2
    bnez a3, fail
t8: # pdot.h writes 0
    li   a0, 8
    li   a1, 0x7f80017f80017f80
    li   a2, 0x0102030405060708
    li   a3, 42
    pdot.h a3, a1, a2
    bnez a3, fail
t9: # pmulhrs.h writes 0
    li   a0, 9
    li   a1, 0x7f80017f80017f80
    li   a2, 0x0102030405060708
    li   a3, 42
    pmulhrs.h a3, a1, a2
    bnez a3, fail
pass:
    li   a0, 0
    halt               # tohost = 1: PASS
fail:
    slli t0, a0, 1     # a0 holds the failing test number
    ori  t0, t0, 1
    csrw tohost, t0    # tohost = (n << 1) | 1: FAIL in test n
    j    .
