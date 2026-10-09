M=1<<64
def u(x): return x % M
def s(x): x%=M; return x-M if x>>63 else x
def s32(x): x%=1<<32; return x-(1<<32) if x>>31 else x
def u32(x): return x % (1<<32)
def sx(x): return u(s32(x))
def tdiv(a,b): q=abs(a)//abs(b); return q if (a<0)==(b<0) else -q
def trem(a,b): return a - tdiv(a,b)*b
MIN=1<<63
def div(a,b):
    if b==0: return M-1
    if a==MIN and b==M-1: return a
    return u(tdiv(s(a),s(b)))
def rem(a,b):
    if b==0: return a
    if a==MIN and b==M-1: return 0
    return u(trem(s(a),s(b)))
def divw(a,b):
    x,y=s32(a),s32(b)
    if y==0: return M-1
    if x==-(1<<31) and y==-1: return sx(x)
    return sx(tdiv(x,y))
def remw(a,b):
    x,y=s32(a),s32(b)
    if y==0: return sx(x)
    if x==-(1<<31) and y==-1: return 0
    return sx(trem(x,y))
R = {
 'add':lambda a,b:u(a+b),'sub':lambda a,b:u(a-b),'sll':lambda a,b:u(a<<(b&63)),
 'slt':lambda a,b:int(s(a)<s(b)),'sltu':lambda a,b:int(a<b),'xor':lambda a,b:a^b,
 'srl':lambda a,b:a>>(b&63),'sra':lambda a,b:u(s(a)>>(b&63)),'or':lambda a,b:a|b,'and':lambda a,b:a&b,
 'addw':lambda a,b:sx(a+b),'subw':lambda a,b:sx(a-b),'sllw':lambda a,b:sx(a<<(b&31)),
 'srlw':lambda a,b:sx(u32(a)>>(b&31)),'sraw':lambda a,b:sx(s32(a)>>(b&31)),
 'mul':lambda a,b:u(a*b),'mulh':lambda a,b:u((s(a)*s(b))>>64),'mulhsu':lambda a,b:u((s(a)*b)>>64),
 'mulhu':lambda a,b:(a*b)>>64,'div':div,'divu':lambda a,b:M-1 if b==0 else a//b,'rem':rem,
 'remu':lambda a,b:a if b==0 else a%b,'mulw':lambda a,b:sx(a*b),'divw':divw,
 'divuw':lambda a,b:M-1 if u32(b)==0 else sx(u32(a)//u32(b)),'remw':remw,
 'remuw':lambda a,b:sx(u32(a)) if u32(b)==0 else sx(u32(a)%u32(b)),
}
I = {
 'addi':lambda a,i:u(a+i),'slti':lambda a,i:int(s(a)<i),'sltiu':lambda a,i:int(a<u(i)),
 'xori':lambda a,i:a^u(i),'ori':lambda a,i:a|u(i),'andi':lambda a,i:a&u(i),
 'slli':lambda a,i:u(a<<i),'srli':lambda a,i:a>>i,'srai':lambda a,i:u(s(a)>>i),
 'addiw':lambda a,i:sx(a+i),'slliw':lambda a,i:sx(a<<i),'srliw':lambda a,i:sx(u32(a)>>i),'sraiw':lambda a,i:sx(s32(a)>>i),
}
def clz(x,w=64):
    x%=1<<w
    return w - x.bit_length()
def ctz(x,w=64):
    x%=1<<w
    return w if x==0 else (x & -x).bit_length()-1
def rotl(x,n,w): x%=1<<w; n%=w; return ((x<<n)|(x>>(w-n)))%(1<<w) if n else x
def rotr(x,n,w): x%=1<<w; n%=w; return ((x>>n)|(x<<(w-n)))%(1<<w) if n else x
def sext_n(x,n): x%=1<<n; return u(x-(1<<n) if x>>(n-1) else x)
def rev8(x): return int.from_bytes(u(x).to_bytes(8,'little'),'big')
def orcb(x): return sum((0xff if (x>>(8*i))&0xff else 0)<<(8*i) for i in range(8))
ZR = {  # Zba / Zbb / Zbs register-register
 'sh1add':lambda a,b:u(b+(a<<1)),'sh2add':lambda a,b:u(b+(a<<2)),'sh3add':lambda a,b:u(b+(a<<3)),
 'add.uw':lambda a,b:u(b+u32(a)),'sh1add.uw':lambda a,b:u(b+(u32(a)<<1)),'sh2add.uw':lambda a,b:u(b+(u32(a)<<2)),'sh3add.uw':lambda a,b:u(b+(u32(a)<<3)),
 'andn':lambda a,b:a&~b%M,'orn':lambda a,b:u(a|(~b%M)),'xnor':lambda a,b:u(~(a^b)),
 'min':lambda a,b:a if s(a)<s(b) else b,'minu':lambda a,b:min(a,b),'max':lambda a,b:a if s(a)>s(b) else b,'maxu':lambda a,b:max(a,b),
 'rol':lambda a,b:rotl(a,b&63,64),'ror':lambda a,b:rotr(a,b&63,64),
 'rolw':lambda a,b:sx(rotl(a,b&31,32)),'rorw':lambda a,b:sx(rotr(a,b&31,32)),
 'bset':lambda a,b:a|(1<<(b&63)),'bclr':lambda a,b:a&~(1<<(b&63))%M,'binv':lambda a,b:a^(1<<(b&63)),'bext':lambda a,b:(a>>(b&63))&1,
}
ZI = {  # immediates
 'slli.uw':lambda a,i:u(u32(a)<<i),'rori':lambda a,i:rotr(a,i,64),'roriw':lambda a,i:sx(rotr(a,i,32)),
 'bseti':lambda a,i:a|(1<<i),'bclri':lambda a,i:a&~(1<<i)%M,'binvi':lambda a,i:a^(1<<i),'bexti':lambda a,i:(a>>i)&1,
}
ZU = {  # unary
 'clz':lambda a:clz(a),'ctz':lambda a:ctz(a),'cpop':lambda a:bin(u(a)).count('1'),
 'clzw':lambda a:clz(a,32),'ctzw':lambda a:ctz(a,32),'cpopw':lambda a:bin(u32(a)).count('1'),
 'sext.b':lambda a:sext_n(a,8),'sext.h':lambda a:sext_n(a,16),'zext.h':lambda a:a&0xffff,
 'rev8':rev8,'orc.b':orcb,
}
B = {'beq':lambda a,b:a==b,'bne':lambda a,b:a!=b,'blt':lambda a,b:s(a)<s(b),'bge':lambda a,b:s(a)>=s(b),
     'bltu':lambda a,b:a<b,'bgeu':lambda a,b:a>=b}
V=[0,1,u(-1),7,u(-7),MIN,MIN-1,0x80000000,0x7fffffff,u(-0x80000000),0x123456789abcdef0,0xfedcba9876543210,63,64,33]
pairs=[(V[i],V[j]) for i in range(len(V)) for j in range(len(V)) if (i*7+j*3)%11==0 or i==j or j in (0,1,2)]
out=[]; n=0
h=lambda v:'0x%x'%v
def check(reg,exp):
    global n
    out.append(f"    li   t6, {h(exp)}"); out.append(f"    beq  {reg}, t6, t{n}_ok"); out.append("    j    fail"); out.append(f"t{n}_ok:")
for op,f in R.items():
    sel = pairs[::3] if op in('div','divu','rem','remu','divw','divuw','remw','remuw','mulh','mulhsu','mulhu','mul') else pairs[::7]
    for a,b in sel:
        n+=1; out.append(f"t{n}: # {op} {h(a)}, {h(b)}"); out.append(f"    li   a0, {n}")
        out.append(f"    li   a1, {h(a)}"); out.append(f"    li   a2, {h(b)}"); out.append(f"    {op} a3, a1, a2"); check('a3',f(a,b))
IMM=[0,1,-1,2047,-2048,0x555,-0x800+3]
SH=[0,1,31,32,63]
for op,f in I.items():
    imms = SH if op in('slli','srli','srai') else [x for x in SH if x<32] if op in('slliw','srliw','sraiw') else IMM
    for a in V[::4]:
        for i in imms:
            n+=1; out.append(f"t{n}: # {op} {h(a)}, {i}"); out.append(f"    li   a0, {n}")
            out.append(f"    li   a1, {h(a)}"); out.append(f"    {op} a3, a1, {i}"); check('a3',f(a,i))
for op,f in ZR.items():
    for a,b in (pairs[::3] if op[0]=='b' else pairs[::5]):
        n+=1; out.append(f"t{n}: # {op} {h(a)}, {h(b)}"); out.append(f"    li   a0, {n}")
        out.append(f"    li   a1, {h(a)}"); out.append(f"    li   a2, {h(b)}"); out.append(f"    {op} a3, a1, a2"); check('a3',f(a,b))
for op,f in ZI.items():
    for a in V[::3]:
        for i in ([0,1,13,31] if op=='roriw' else [0,1,13,32,63]):
            n+=1; out.append(f"t{n}: # {op} {h(a)}, {i}"); out.append(f"    li   a0, {n}")
            out.append(f"    li   a1, {h(a)}"); out.append(f"    {op} a3, a1, {i}"); check('a3',f(a,i))
ZV = V + [0x00ff00ff00ff00ff, 0x0000000100000000, 0x8000000000000001, 0x00000000ffff8000, 0x0102030400000080]
for op,f in ZU.items():
    for a in ZV:
        n+=1; out.append(f"t{n}: # {op} {h(a)}"); out.append(f"    li   a0, {n}")
        out.append(f"    li   a1, {h(a)}"); out.append(f"    {op} a3, a1"); check('a3',f(a))
n+=1; out+=[f"t{n}: # sh3add indexes an array of doublewords (forwarded both ways)", f"    li   a0, {n}", "    la   s0, scratch", "    li   t0, 3", "    li   t1, 0x77",
            "    sd   t1, 24(s0)", "    sh3add t2, t0, s0", "    ld   a3, 0(t2)"]; check('a3',0x77)
n+=1; out+=[f"t{n}: # max result used right away (2-cycle latency: one stall, then forwarded from MEMORY)", f"    li   a0, {n}", "    li   t0, -5", "    li   t1, 7", "    max  t2, t0, t1", "    sub  a3, t2, t1"]; check('a3',0)
n+=1; out+=[f"t{n}: # performance counters are readable and count forward", f"    li   a0, {n}", "    csrr t0, hpmcounter4", "    nop", "    csrr t1, hpmcounter4", "    sltu a3, t1, t0"]; check('a3',0)
n+=1; out+=[f"t{n}: # cpop result forwarded to the next instruction", f"    li   a0, {n}", "    li   t0, 0xff", "    cpop t1, t0", "    addi a3, t1, 1"]; check('a3',9)
for op,f in B.items():
    for a,b in pairs[::9]:
        n+=1; out+= [f"t{n}: # {op} {h(a)}, {h(b)}", f"    li   a0, {n}", f"    li   a1, {h(a)}", f"    li   a2, {h(b)}",
            f"    li   a3, 0", f"    {op} a1, a2, t{n}_taken", f"    j    t{n}_chk", f"t{n}_taken:", f"    li   a3, 1", f"t{n}_chk:"]
        check('a3',int(f(a,b)))
# lui / auipc
for imm in [0,1,0x7ffff,0x80000,0xfffff,0x12345]:
    n+=1; out+=[f"t{n}: # lui {h(imm)}", f"    li   a0, {n}", f"    lui  a3, {h(imm)}"]; check('a3',u(s32(imm<<12)))
    n+=1; out+=[f"t{n}: # auipc {h(imm)}", f"    li   a0, {n}", f"t{n}_pc:", f"    auipc a3, {h(imm)}", f"    la   t5, t{n}_pc",
                f"    li   t6, {h(u(s32(imm<<12)))}", f"    add  t5, t5, t6", f"    beq  a3, t5, t{n}_ok", "    j    fail", f"t{n}_ok:"]
# jal / jalr
n+=1; out+=[f"t{n}: # jal link + target", f"    li   a0, {n}", f"    jal  ra, t{n}_tgt", f"t{n}_ret:", f"    j    fail",
            f"t{n}_tgt:", f"    la   t6, t{n}_ret", f"    beq  ra, t6, t{n}_ok", "    j    fail", f"t{n}_ok:"]
n+=1; out+=[f"t{n}: # jalr clears bit 0 of the target", f"    li   a0, {n}", f"    la   t0, t{n}_tgt", f"    jalr ra, 1(t0)", f"t{n}_ret:", f"    j    fail",
            f"t{n}_tgt:", f"    la   t6, t{n}_ret", f"    beq  ra, t6, t{n}_ok", "    j    fail", f"t{n}_ok:"]
n+=1; out+=[f"t{n}: # jal x0 (no link) and rd=x0 writes are dropped", f"    li   a0, {n}", f"    jal  zero, t{n}_tgt", f"    j    fail",
            f"t{n}_tgt:", f"    addi zero, zero, 5", f"    beqz zero, t{n}_ok", "    j    fail", f"t{n}_ok:"]
# loads / stores
pat=0x8182838485868788
mem={}
def st(addr,val,size):
    for k in range(size): mem[addr+k]=(val>>(8*k))&0xff
def ld(addr,size,signed):
    v=sum(mem.get(addr+k,0)<<(8*k) for k in range(size))
    if signed and v>>(8*size-1): v-=1<<(8*size)
    return u(v)
out_mem=[]
n+=1; out+=[f"t{n}: # sd then every load width", f"    li   a0, {n}", "    la   s0, scratch", f"    li   t0, {h(pat)}", "    sd   t0, 0(s0)"]
st(0,pat,8)
for op,size,sg in [('lb',1,1),('lbu',1,0),('lh',2,1),('lhu',2,0),('lw',4,1),('lwu',4,0),('ld',8,0)]:
    for off in [0,1,2,4] if size<8 else [0]:
        if off % size: continue
        n+=1; out+=[f"t{n}: # {op} {off}", f"    li   a0, {n}", f"    {op}   a3, {off}(s0)"]; check('a3',ld(off,size,sg))
for op,size in [('sb',1),('sh',2),('sw',4),('sd',8)]:
    n+=1; val=0x0102030405060708 ^ (size*0x1111)
    out+=[f"t{n}: # {op} then ld", f"    li   a0, {n}", f"    li   t0, {h(pat)}", "    sd   t0, 8(s0)", f"    li   t1, {h(val)}",
          f"    {op}   t1, 8(s0)", "    ld   a3, 8(s0)"]
    st(8,pat,8); st(8,val & ((1<<(8*size))-1),size); check('a3',ld(8,8,0))
n+=1; out+=[f"t{n}: # negative offset", f"    li   a0, {n}", "    addi s1, s0, 16", "    ld   a3, -16(s1)"]; check('a3',pat)
n+=1; out+=[f"t{n}: # fence is a no-op", f"    li   a0, {n}", "    li   a3, 9", "    fence", "    addi a3, a3, 1"]; check('a3',10)

# ---------------- Zicsr (status CSR 0x50A is read/write; counters are read-only) ----------------
def csr_case(desc, lines, reg, exp):
    global n
    n+=1; out.append(f"t{n}: # {desc}"); out.append(f"    li   a0, {n}"); out.extend(lines); check(reg, exp)
csr_case("csrrw returns old value", ["    li   t0, 0x5a", "    csrw status, t0", "    li   t1, 0x33", "    csrrw a3, status, t1"], 'a3', 0x5a)
csr_case("csrrw wrote new value", ["    csrr a3, status"], 'a3', 0x33)
csr_case("csrrs sets bits", ["    li   t0, 0x0c", "    csrrs a3, status, t0", "    csrr a3, status"], 'a3', 0x3f)
csr_case("csrrc clears bits", ["    li   t0, 0x0f", "    csrrc a3, status, t0", "    csrr a3, status"], 'a3', 0x30)
csr_case("csrrs with x0 does not write", ["    csrrs a3, status, x0", "    csrr a4, status", "    sub  a3, a3, a4"], 'a3', 0)
csr_case("csrrwi", ["    csrrwi a3, status, 17", "    csrr a3, status"], 'a3', 17)
csr_case("csrrsi", ["    csrrsi a3, status, 8", "    csrr a3, status"], 'a3', 25)
csr_case("csrrci", ["    csrrci a3, status, 1", "    csrr a3, status"], 'a3', 24)
csr_case("csr read then forward to next instruction", ["    csrwi status, 5", "    csrr t0, status", "    addi a3, t0, 1"], 'a3', 6)
csr_case("hartid reads 0", ["    csrr a3, hartid"], 'a3', 0)
csr_case("mhartid reads 0", ["    csrr a3, mhartid"], 'a3', 0)
# ---------------- traps (machine mode): ecall / ebreak jump to mtvec, mret returns to mepc ----------------
csr_case("ecall traps to mtvec and mret returns (the handler counts in a5)", ["    la   t0, trap_handler", "    csrw mtvec, t0", "    li   a5, 0", "    ecall", "    ecall", "    mv   a3, a5"], 'a3', 2)
csr_case("mcause = 11 after ecall", ["    ecall", "    csrr a3, mcause"], 'a3', 11)
csr_case("mcause = 3 after ebreak", ["    ebreak", "    csrr a3, mcause"], 'a3', 3)
csr_case("mepc = address of the ecall (the handler added 4)", ["trap_site:", "    ecall", "    csrr a3, mepc", "    la   t1, trap_site", "    sub  a3, a3, t1"], 'a3', 4)
csr_case("mret restores MIE from MPIE", ["    csrsi mstatus, 8", "    ecall", "    csrr a3, mstatus", "    andi a3, a3, 0x88"], 'a3', 0x88)
csr_case("cycle counter moves forward", ["    rdcycle t0", "    nop", "    nop", "    rdcycle t1", "    sltu a3, t0, t1"], 'a3', 1)
csr_case("instret counts 3 retired instructions between reads (second pass: warm instruction cache; 3 nops first so no earlier bubble is still draining)",
         ["    li   t2, 2", f"t{n+1}_pass:", "    nop", "    nop", "    nop", "    rdinstret t0", "    nop", "    nop", "    rdinstret t1", "    addi t2, t2, -1", f"    bnez t2, t{n+1}_pass", "    sub  a3, t1, t0"], 'a3', 3)
# ---------------- interrupts: mie / mip and the machine timer (MTIME 0x1000_0058, MTIMECMP 0x1000_0060) ----------------
csr_case("mie keeps what is written", ["    li   t0, 0x888", "    csrw mie, t0", "    csrr a3, mie", "    csrw mie, zero"], 'a3', 0x888)
csr_case("mip is 0 while MTIMECMP is 'never'", ["    csrr a3, mip"], 'a3', 0)
csr_case("mip.MTIP rises when MTIME >= MTIMECMP (no interrupt: mie is 0)", ["    li   t1, 0x10000000", "    sd   zero, 0x60(t1)", "    nop", "    nop", "    nop", "    csrr a3, mip", "    li   t0, -1", "    sd   t0, 0x60(t1)"], 'a3', 0x80)
csr_case("MTIME counts up", ["    li   t1, 0x10000000", "    ld   t0, 0x58(t1)", "    nop", "    ld   t2, 0x58(t1)", "    sltu a3, t0, t2"], 'a3', 1)
csr_case("a timer interrupt is taken (mcause = 2^63 + 7) and returns", ["    la   t0, interrupt_handler", "    csrw mtvec, t0", "    li   a6, 0", "    li   t1, 0x10000000",
          "    sd   zero, 0x60(t1)", "    li   t0, 0x80", "    csrw mie, t0", "    csrsi mstatus, 8", "    nop", "    nop", "    nop", "    nop", "    nop", "    nop",
          "    csrci mstatus, 8", "    csrw mie, zero", "    la   t0, trap_handler", "    csrw mtvec, t0", "    mv   a3, a6"], 'a3', (1<<63)|7)
csr_case("wfi is a no-op", ["    li   a3, 4", "    wfi", "    addi a3, a3, 1"], 'a3', 5)
csr_case("cycle counter is read-only", ["    rdcycle t0", "    csrw cycle, zero", "    rdcycle t1", "    sltu a3, t0, t1"], 'a3', 1)

hdr=f"""# =============================================================================
# tests/isa_selfcheck.s: AUTO-GENERATED self-checking test of every RV64IM +
# Zicsr + Zba + Zbb + Zbs + trap + interrupt instruction ({n} test cases, expected values computed by an independent
# Python reference model). Uses the riscv-tests convention:
#   PASS: tohost = 1           FAIL: tohost = (test number << 1) | 1
# so the testbench prints "FAIL in test N": search for "tN:" below.
#
# EXPECT: a0 = 0
# =============================================================================
"""
body="\n".join(out)
tail="""
pass:
    li   a0, 0
    halt               # tohost = 1: PASS
fail:
    slli t0, a0, 1     # a0 holds the failing test number
    ori  t0, t0, 1
    csrw tohost, t0    # tohost = (n << 1) | 1: FAIL in test n
    j    .

interrupt_handler:     # records mcause in a6, sets the timer to "never" again, returns to the interrupted instruction
    csrr a6, mcause
    li   t6, -1
    sd   t6, 0x60(t1)
    mret

trap_handler:          # counts traps in a5 and returns to the instruction after the ecall/ebreak
    addi a5, a5, 1
    csrr t5, mepc
    addi t5, t5, 4
    csrw mepc, t5
    mret

    .align 3
scratch:
    .zero 32
"""
open('tests/isa_selfcheck.s','w').write(hdr+body+tail)
print(n,"tests")

# ---------------- tests/zknh_selfcheck.s: the instructions added in docs/learn/10_adding_instructions.md ----------------
# A separate file because isa_selfcheck.s already fills most of the 64 KiB test memory.
# Expected values come from the FIPS 180-4 definitions, written here independently of the RTL and the model.
ZK = {
 'sha256sum0':lambda a:sx(rotr(a,2,32)^rotr(a,13,32)^rotr(a,22,32)),
 'sha256sum1':lambda a:sx(rotr(a,6,32)^rotr(a,11,32)^rotr(a,25,32)),
 'sha256sig0':lambda a:sx(rotr(a,7,32)^rotr(a,18,32)^(u32(a)>>3)),
 'sha256sig1':lambda a:sx(rotr(a,17,32)^rotr(a,19,32)^(u32(a)>>10)),
 'sha512sum0':lambda a:rotr(a,28,64)^rotr(a,34,64)^rotr(a,39,64),
 'sha512sum1':lambda a:rotr(a,14,64)^rotr(a,18,64)^rotr(a,41,64),
 'sha512sig0':lambda a:rotr(a,1,64)^rotr(a,8,64)^(u(a)>>7),
 'sha512sig1':lambda a:rotr(a,19,64)^rotr(a,61,64)^(u(a)>>6),
}
out=[]; n=0
for op,f in ZK.items():
    for a in ZV + [0x6a09e667, 0x510e527f, 0x6a09e667f3bcc908, 0x61626380]:   # SHA-2 initial values and the "abc" block
        n+=1; out.append(f"t{n}: # {op} {h(a)}"); out.append(f"    li   a0, {n}")
        out.append(f"    li   a1, {h(a)}"); out.append(f"    {op} a3, a1"); check('a3',f(a))
for a,b in [(x,x) for x in V] + pairs[::3]:
    n+=1; out.append(f"t{n}: # hsec.cteq {h(a)}, {h(b)}"); out.append(f"    li   a0, {n}")
    out.append(f"    li   a1, {h(a)}"); out.append(f"    li   a2, {h(b)}"); out.append("    hsec.cteq a3, a1, a2"); check('a3',int(a==b))
for bit in (0, 31, 32, 63):   # operands differing in exactly one bit
    n+=1; out+=[f"t{n}: # hsec.cteq, operands differ only in bit {bit}", f"    li   a0, {n}", "    li   a1, 0x0123456789abcdef", f"    li   a2, {h(0x0123456789abcdef ^ (1<<bit))}", "    hsec.cteq a3, a1, a2"]; check('a3',0)
n+=1; out+=[f"t{n}: # sha256sig0 result forwarded to the very next instruction", f"    li   a0, {n}", "    li   t0, 0x61626380", "    sha256sig0 t1, t0", "    xor  a3, t1, zero"]; check('a3',ZK['sha256sig0'](0x61626380))
n+=1; out+=[f"t{n}: # rs2 of hsec.cteq forwarded from the instruction just before", f"    li   a0, {n}", "    li   t0, 0x5a5a", "    li   t1, 0x5a5a", "    hsec.cteq a3, t0, t1"]; check('a3',1)
n+=1; out+=[f"t{n}: # rs2 of hsec.cteq LOADED by the instruction just before: the load-use stall needs USES_REGISTER2 for custom-0", f"    li   a0, {n}", "    la   s0, scratch", "    li   t0, 0x5a5a", "    sd   t0, 0(s0)", "    ld   t1, 0(s0)", "    hsec.cteq a3, t0, t1"]; check('a3',1)
n+=1; out+=[f"t{n}: # hsec.cteq result used as a branch condition", f"    li   a0, {n}", "    li   t0, 7", "    li   t1, 7", "    hsec.cteq t2, t0, t1", "    li   a3, 0", f"    beqz t2, t{n}_skip", "    li   a3, 1", f"t{n}_skip:"]; check('a3',1)
n+=1; out+=[f"t{n}: # other custom-0 patterns write nothing (funct3 = 111)", f"    li   a0, {n}", "    li   a3, 42", "    .word 0x00c5f68b", "    mv   a3, a3"]; check('a3',42)
open('tests/zknh_selfcheck.s','w').write(f"""# =============================================================================
# tests/zknh_selfcheck.s: AUTO-GENERATED by tools/gen_selfcheck.py. The Zknh SHA-2
# instructions and the custom hsec.cteq ({n} test cases), the worked example of
# docs/learn/10_adding_instructions.md. Same convention as isa_selfcheck.s:
#   PASS: tohost = 1           FAIL: tohost = (test number << 1) | 1
#
# EXPECT: a0 = 0
# =============================================================================
""" + "\n".join(out) + """
pass:
    li   a0, 0
    halt               # tohost = 1: PASS
fail:
    slli t0, a0, 1     # a0 holds the failing test number
    ori  t0, t0, 1
    csrw tohost, t0    # tohost = (n << 1) | 1: FAIL in test n
    j    .

    .align 3
scratch:
    .zero 16
""")
print(n,"Zknh / hsec.cteq tests")
