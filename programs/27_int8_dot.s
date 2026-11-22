# =============================================================================
# 27_int8_dot.s: a small neural-network layer in 8-bit integers, 8 neurons x 512 inputs
#
# Inference on small chips stores weights and activations as signed bytes (int8): a neuron's output is the
# dot product of its 512 weights with the 512 inputs, 4096 multiply-adds for the layer.
#
#   plain RV64IM : per input lb, lb, mul, add (mul takes several cycles in the iterative M unit)
#   pdot.b rd, rs1, rs2 : 8 signed byte products summed into one 64-bit number (custom-0 group "xcompute");
#                          per 8 inputs: ld, ld, pdot.b, add. Two partial sums take turns, so an add never
#                          waits for the pdot.b right before it.
#
# a1 = a checksum of the 8 outputs; both versions must agree (a0 = 0). EXPECT values: tools/kernel_reference.py.
#
# BENCH: int8 layer, 8 neurons x 512 inputs (dot products) | s2 s3 | s4 s5
# EXPECT: a0 = 0
# EXPECT: a1 = 0x3020ab5ba2a8a1
# =============================================================================
    .equ IN, 512
    la   a0, weights
    li   a1, 576               # 4096 weight bytes, then 512 input bytes
    li   a2, 0x1a7e
    call fill
    # ---------------- plain
    rdinstret s4
    rdcycle s2
    la   s0, weights
    la   s10, out_s
    li   s6, 8                 # neurons left
plain_neuron:
    la   s1, inputs
    li   a3, 0
    li   a4, IN
plain_mac:
    lb   t0, 0(s0)
    lb   t1, 0(s1)
    mul  t0, t0, t1
    add  a3, a3, t0
    addi s0, s0, 1
    addi s1, s1, 1
    addi a4, a4, -1
    bnez a4, plain_mac
    sd   a3, 0(s10)
    addi s10, s10, 8
    addi s6, s6, -1
    bnez s6, plain_neuron
    rdcycle t6
    sub  s2, t6, s2
    rdinstret t6
    sub  s4, t6, s4
    # ---------------- packed: 16 inputs per trip, two partial sums
    rdinstret s5
    rdcycle s3
    la   s0, weights
    la   s10, out_p
    li   s6, 8
packed_neuron:
    la   s1, inputs
    li   a3, 0
    li   a5, 0
    li   a4, IN
packed_mac:
    ld   t0, 0(s0)
    ld   t1, 0(s1)
    ld   t2, 8(s0)
    ld   t3, 8(s1)
    pdot.b t0, t0, t1
    pdot.b t2, t2, t3
    addi s0, s0, 16
    addi s1, s1, 16
    add  a3, a3, t0
    add  a5, a5, t2
    addi a4, a4, -16
    bnez a4, packed_mac
    add  a3, a3, a5
    sd   a3, 0(s10)
    addi s10, s10, 8
    addi s6, s6, -1
    bnez s6, packed_neuron
    rdcycle t6
    sub  s3, t6, s3
    rdinstret t6
    sub  s5, t6, s5
    # ---------------- agree? a1 = checksum
    la   s0, out_s
    la   s1, out_p
    li   t5, 8
    li   a0, 0
    li   a1, 0
check:
    ld   t0, 0(s0)
    ld   t1, 0(s1)
    xor  t2, t0, t1
    or   a0, a0, t2
    slli t3, a1, 5
    sub  a1, t3, a1
    add  a1, a1, t1
    addi s0, s0, 8
    addi s1, s1, 8
    addi t5, t5, -1
    bnez t5, check
    snez a0, a0
    halt

# fill(a0 = address, a1 = doublewords, a2 = seed): x = x * 6364136223846793005 + 1442695040888963407
fill:
    li   t0, 6364136223846793005
    li   t1, 1442695040888963407
fill_loop:
    mul  a2, a2, t0
    add  a2, a2, t1
    sd   a2, 0(a0)
    addi a0, a0, 8
    addi a1, a1, -1
    bnez a1, fill_loop
    ret

    .align 3
weights: .zero 4096
inputs:  .zero 512
out_s:   .zero 64
out_p:   .zero 64
