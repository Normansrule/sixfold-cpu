// =============================================================================
// model/isas/x86.js: x86-64, an integer subset in Intel syntax, for comparison with RISC-V and MIPS
//
// x86 is the other road: instructions from 1 to 15 bytes, built from optional parts,
//   [REX prefix] opcode (1-2 bytes) [ModRM] [SIB] [displacement 1/4] [immediate 1/4/8]
// most instructions can read (or read and write) memory directly ("add rax, [rbx + rcx*8 + 16]"), the
// result usually overwrites the first operand (two operands, not three), and a FLAGS register remembers
// the last result's sign, zero, carry and overflow for the conditional jumps that follow.
// Modern x86 cores translate each instruction into RISC-like MICRO-OPERATIONS; ./x86_core.js models that.
//
// Syntax (NASM-style Intel): operands "destination, source"; [ ... ] is memory, a bare name or number is an
// immediate; "byte [m]" / "qword [m]" give a memory operand's size when no register does.
// Registers: rax rcx rdx rbx rsp rbp rsi rdi r8-r15 (64-bit), al cl dl bl spl bpl sil dil r8b-r15b (8-bit).
// Instructions: mov movzx lea add sub and or xor cmp test inc dec neg not imul mul div idiv cqo
//   shl sal shr sar push pop call ret jmp jcc (je jne jl jle jg jge jb jbe ja jae js jns jz jnz) cmovcc setcc
//   nop hlt (= the program is done).
// Encodings follow GNU as without optimisation (tools/isa_crosscheck.py compares them byte for byte), except
// that jumps always use a 32-bit displacement (an assembler picks 8 bits when the target is near, which
// needs a third pass to settle sizes).
// =============================================================================
import { assembleProgram, evalExpr, constantOrNull } from './asm_common.js';

export const REGS64 = ['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'];
export const REGS8 = ['al', 'cl', 'dl', 'bl', 'spl', 'bpl', 'sil', 'dil', 'r8b', 'r9b', 'r10b', 'r11b', 'r12b', 'r13b', 'r14b', 'r15b'];
export const RESULT_REGISTER = 0; // rax
export const CONDITIONS = ['o', 'no', 'b', 'ae', 'e', 'ne', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g'];
const CC_ALIASES = { c: 'b', nae: 'b', nb: 'ae', nc: 'ae', z: 'e', nz: 'ne', na: 'be', nbe: 'a', pe: 'p', po: 'np', nge: 'l', nl: 'ge', ng: 'le', nle: 'g' };
const ccOf = s => { const c = CC_ALIASES[s] || s; const i = CONDITIONS.indexOf(c); return i; };
const ALU = { add: 0, or: 1, adc: 2, sbb: 3, and: 4, sub: 5, xor: 6, cmp: 7 };
const SHIFT = { shl: 4, sal: 4, shr: 5, sar: 7 };

// ---------------------------------------------------------------- operands
function parseOperand(tok) {
  let t = tok.trim().toLowerCase(), size = 0;
  const sm = t.match(/^(byte|word|dword|qword)\s+(?:ptr\s+)?(.*)$/);
  if (sm) { size = { byte: 1, word: 2, dword: 4, qword: 8 }[sm[1]]; t = sm[2].trim(); }
  if (REGS64.includes(t)) return { type: 'reg', size: 8, n: REGS64.indexOf(t) };
  if (REGS8.includes(t)) return { type: 'reg', size: 1, n: REGS8.indexOf(t) };
  const m = t.match(/^\[(.*)\]$/);
  if (m) {
    let base = null, index = null, scale = 1; const disp = [];
    // split into signed terms: "rbx + rcx*8 - 16 + label"
    for (const term of m[1].replace(/\s+/g, '').replace(/-/g, '+-').split('+').filter(Boolean)) {
      const neg = term.startsWith('-'), body = neg ? term.slice(1) : term;
      const sc = body.match(/^([a-z0-9]+)\*(\d)$/) || body.match(/^(\d)\*([a-z0-9]+)$/);
      if (sc) {
        const [r, s] = REGS64.includes(sc[1]) ? [sc[1], +sc[2]] : [sc[2], +sc[1]];
        if (!REGS64.includes(r) || ![1, 2, 4, 8].includes(s) || neg || index !== null) throw new Error(`bad index in ${tok}`);
        index = REGS64.indexOf(r); scale = s;
      } else if (REGS64.includes(body) && !neg) {
        if (base === null) base = REGS64.indexOf(body); else if (index === null) index = REGS64.indexOf(body); else throw new Error(`too many registers in ${tok}`);
      } else disp.push((neg ? '-' : '') + body);
    }
    if (index === 4) throw new Error('rsp cannot be an index register');
    return { type: 'mem', size, base, index, scale, disp: disp.length ? disp.join('+').replace(/\+-/g, '-') : '0' };
  }
  return { type: 'imm', expr: tok.trim() };
}

// ---------------------------------------------------------------- the encoder
const fitsI8 = v => v !== null && v >= -128n && v <= 127n;
const fitsI32 = v => v !== null && v >= -2147483648n && v <= 2147483647n;
const le = (v, n) => { let x = BigInt.asUintN(8 * n, BigInt(v)); const out = []; for (let i = 0; i < n; i++) { out.push(Number(x & 0xffn)); x >>= 8n; } return out; };

// ModRM (+ SIB + displacement) for "reg field" r (a register number or an opcode extension) and operand rm.
// The displacement's size is decided in pass 1 (8 bits only when it is a known constant that fits).
function modrmPlan(rm, sym1) {
  if (rm.type === 'reg') return { size: 1, rexB: rm.n >> 3, rexX: 0, emit: r => [0xc0 | ((r & 7) << 3) | (rm.n & 7)] };
  const dv = constantOrNull(rm.disp, sym1);
  if (rm.base === null) { // [disp32] or [index*scale + disp32]: SIB with "no base"
    const idx = rm.index === null ? 4 : rm.index & 7, ss = Math.log2(rm.scale);
    return { size: 6, rexB: 0, rexX: rm.index === null ? 0 : rm.index >> 3,
      emit: (r, sym) => [0x04 | ((r & 7) << 3), (ss << 6) | (idx << 3) | 5, ...le(evalExpr(rm.disp, sym), 4)] };
  }
  const needSib = rm.index !== null || (rm.base & 7) === 4;
  const mod = dv === 0n && (rm.base & 7) !== 5 ? 0 : fitsI8(dv) ? 1 : 2;
  const dsize = [0, 1, 4][mod];
  return { size: 1 + (needSib ? 1 : 0) + dsize, rexB: rm.base >> 3, rexX: rm.index === null ? 0 : rm.index >> 3,
    emit: (r, sym) => {
      const out = [(mod << 6) | ((r & 7) << 3) | (needSib ? 4 : rm.base & 7)];
      if (needSib) out.push((Math.log2(rm.scale) << 6) | ((rm.index === null ? 4 : rm.index & 7) << 3) | (rm.base & 7));
      if (dsize) out.push(...le(evalExpr(rm.disp, sym), dsize));
      return out;
    } };
}
// One instruction: [REX] opcode [ModRM/SIB/disp] [immediate]
function encode({ w = 1, op, r = 0, rm = null, imm = null, immSize = 0, sym1, byteRegs = [], rel = null }) {
  const plan = rm ? modrmPlan(rm, sym1) : null;
  const rexR = typeof r === 'number' && r > 7 ? 1 : 0;
  const forceRex = byteRegs.some(n => n >= 4 && n <= 7); // spl bpl sil dil exist only with a REX prefix
  const rex = 0x40 | (w << 3) | (rexR << 2) | ((plan ? plan.rexX : 0) << 1) | (plan ? plan.rexB : 0);
  const rexBytes = rex !== 0x40 || forceRex ? 1 : 0;
  const size = rexBytes + op.length + (plan ? plan.size : 0) + immSize + (rel ? 4 : 0);
  return { size, emit: (sym, pc) => {
    const out = rexBytes ? [rex, ...op] : [...op];
    if (plan) out.push(...plan.emit(r, sym));
    if (imm !== null) out.push(...le(evalExpr(imm, sym), immSize));
    if (rel) out.push(...le(BigInt(Number(evalExpr(rel, sym)) - (pc + size)), 4));
    return out;
  } };
}

export function instruction(mn, rawOps, sym1) {
  const ops = rawOps.map(parseOperand);
  const [a, b, c] = ops;
  const isReg = (o, s) => o && o.type === 'reg' && (!s || o.size === s);
  const isMem = o => o && o.type === 'mem';
  const isRM = o => isReg(o) || isMem(o);
  const size = o => (o.type === 'reg' ? o.size : o.size || 8);
  const k = v => constantOrNull(v.expr, sym1);
  const count = n => { if (ops.length !== n) throw new Error(`${mn} takes ${n} operand${n === 1 ? '' : 's'}`); };
  const byteRegsOf = (...os) => os.filter(o => o && o.type === 'reg' && o.size === 1).map(o => o.n);

  if (mn in ALU) {
    count(2); const n = ALU[mn], base = n * 8;
    if (size(a) === 1 || size(b || a) === 1) { // byte forms: cmp byte [m], imm8  /  op r/m8, r8
      if (b.type === 'imm' && isReg(a, 1) && a.n === 0) return [{ size: 2, emit: sym => [base + 4, ...le(evalExpr(b.expr, sym), 1)] }];
      if (b.type === 'imm') return [encode({ w: 0, op: [0x80], r: n, rm: a, imm: b.expr, immSize: 1, sym1, byteRegs: byteRegsOf(a) })];
      if (isReg(b, 1)) return [encode({ w: 0, op: [base], r: b.n, rm: a, sym1, byteRegs: byteRegsOf(a, b) })];
      return [encode({ w: 0, op: [base + 2], r: a.n, rm: b, sym1, byteRegs: byteRegsOf(a, b) })];
    }
    if (b.type === 'imm') {
      const v = k(b);
      if (fitsI8(v)) return [encode({ op: [0x83], r: n, rm: a, imm: b.expr, immSize: 1, sym1 })];
      if (isReg(a) && a.n === 0) return [encode({ op: [base + 5], imm: b.expr, immSize: 4, sym1 })];
      return [encode({ op: [0x81], r: n, rm: a, imm: b.expr, immSize: 4, sym1 })];
    }
    if (isReg(b)) return [encode({ op: [base + 1], r: b.n, rm: a, sym1 })];
    if (isReg(a) && isMem(b)) return [encode({ op: [base + 3], r: a.n, rm: b, sym1 })];
    throw new Error(`${mn}: unsupported operands`);
  }
  if (mn === 'test') {
    count(2);
    if (b.type === 'imm' && size(a) === 1) {
      if (isReg(a) && a.n === 0) return [{ size: 2, emit: sym => [0xa8, ...le(evalExpr(b.expr, sym), 1)] }];
      return [encode({ w: 0, op: [0xf6], r: 0, rm: a, imm: b.expr, immSize: 1, sym1, byteRegs: byteRegsOf(a) })];
    }
    if (b.type === 'imm') { if (isReg(a) && a.n === 0) return [encode({ op: [0xa9], imm: b.expr, immSize: 4, sym1 })]; return [encode({ op: [0xf7], r: 0, rm: a, imm: b.expr, immSize: 4, sym1 })]; }
    if (size(a) === 1) return [encode({ w: 0, op: [0x84], r: b.n, rm: a, sym1, byteRegs: byteRegsOf(a, b) })];
    return [encode({ op: [0x85], r: b.n, rm: a, sym1 })];
  }
  if (mn === 'mov') {
    count(2);
    if (size(a) === 1 || (isReg(b, 1))) {
      if (b.type === 'imm' && isReg(a)) { const rx = a.n > 7 ? [0x41] : a.n >= 4 ? [0x40] : []; return [{ size: rx.length + 2, emit: sym => [...rx, 0xb0 + (a.n & 7), ...le(evalExpr(b.expr, sym), 1)] }]; }
      if (b.type === 'imm') return [encode({ w: 0, op: [0xc6], r: 0, rm: a, imm: b.expr, immSize: 1, sym1, byteRegs: byteRegsOf(a) })];
      if (isReg(b, 1)) return [encode({ w: 0, op: [0x88], r: b.n, rm: a, sym1, byteRegs: byteRegsOf(a, b) })];
      return [encode({ w: 0, op: [0x8a], r: a.n, rm: b, sym1, byteRegs: byteRegsOf(a) })];
    }
    if (b.type === 'imm') {
      const v = k(b);
      if (isReg(a) && v !== null && !fitsI32(v)) return [{ size: 10, emit: sym => [0x48 | (a.n >> 3), 0xb8 + (a.n & 7), ...le(evalExpr(b.expr, sym), 8)] }];
      return [encode({ op: [0xc7], r: 0, rm: a, imm: b.expr, immSize: 4, sym1 })];
    }
    if (isReg(b)) return [encode({ op: [0x89], r: b.n, rm: a, sym1 })];
    if (isReg(a) && isMem(b)) return [encode({ op: [0x8b], r: a.n, rm: b, sym1 })];
    throw new Error('mov: unsupported operands');
  }
  if (mn === 'movzx') { count(2); if (!isReg(a, 8) || size(b) !== 1) throw new Error('movzx: use movzx r64, byte [m] or movzx r64, r8'); return [encode({ op: [0x0f, 0xb6], r: a.n, rm: b, sym1, byteRegs: byteRegsOf(b) })]; }
  if (mn === 'lea') { count(2); if (!isReg(a, 8) || !isMem(b)) throw new Error('lea r64, [address]'); return [encode({ op: [0x8d], r: a.n, rm: b, sym1 })]; }
  if (mn === 'inc' || mn === 'dec') { count(1); return [encode({ op: [0xff], r: mn === 'inc' ? 0 : 1, rm: a, sym1 })]; }
  if (['not', 'neg', 'mul', 'div', 'idiv'].includes(mn) || (mn === 'imul' && ops.length === 1)) {
    count(1); return [encode({ op: [0xf7], r: { not: 2, neg: 3, mul: 4, imul: 5, div: 6, idiv: 7 }[mn], rm: a, sym1 })];
  }
  if (mn === 'imul') {
    if (ops.length === 2) return [encode({ op: [0x0f, 0xaf], r: a.n, rm: b, sym1 })];
    count(3); const v = k(c);
    return [fitsI8(v) ? encode({ op: [0x6b], r: a.n, rm: b, imm: c.expr, immSize: 1, sym1 }) : encode({ op: [0x69], r: a.n, rm: b, imm: c.expr, immSize: 4, sym1 })];
  }
  if (mn in SHIFT) {
    count(2); const n = SHIFT[mn];
    if (isReg(b, 1) && b.n === 1) return [encode({ op: [0xd3], r: n, rm: a, sym1 })];
    if (b.type !== 'imm') throw new Error(`${mn}: the count is an immediate or cl`);
    if (k(b) === 1n) return [encode({ op: [0xd1], r: n, rm: a, sym1 })];
    return [encode({ op: [0xc1], r: n, rm: a, imm: b.expr, immSize: 1, sym1 })];
  }
  if (mn === 'push' || mn === 'pop') { count(1); if (!isReg(a, 8)) throw new Error(`${mn} r64`); const b0 = (mn === 'push' ? 0x50 : 0x58) + (a.n & 7); return [{ size: a.n > 7 ? 2 : 1, emit: () => (a.n > 7 ? [0x41, b0] : [b0]) }]; }
  if (mn === 'call' || mn === 'jmp') {
    count(1);
    if (a.type === 'imm') return [encode({ w: 0, op: [mn === 'call' ? 0xe8 : 0xe9], rel: a.expr, sym1 })];
    return [encode({ w: 0, op: [0xff], r: mn === 'call' ? 2 : 4, rm: a, sym1 })];
  }
  if (mn === 'cqo') { count(0); return [{ size: 2, emit: () => [0x48, 0x99] }]; }
  if (mn === 'ret') { count(0); return [{ size: 1, emit: () => [0xc3] }]; }
  if (mn === 'nop') { count(0); return [{ size: 1, emit: () => [0x90] }]; }
  if (mn === 'hlt' || mn === 'halt') { count(0); return [{ size: 1, emit: () => [0xf4] }]; }
  let m;
  if ((m = mn.match(/^j([a-z]+)$/)) && ccOf(m[1]) >= 0) { count(1); return [encode({ w: 0, op: [0x0f, 0x80 + ccOf(m[1])], rel: a.expr, sym1 })]; }
  if ((m = mn.match(/^cmov([a-z]+)$/)) && ccOf(m[1]) >= 0) { count(2); return [encode({ op: [0x0f, 0x40 + ccOf(m[1])], r: a.n, rm: b, sym1 })]; }
  if ((m = mn.match(/^set([a-z]+)$/)) && ccOf(m[1]) >= 0) { count(1); return [encode({ w: 0, op: [0x0f, 0x90 + ccOf(m[1])], r: 0, rm: a, sym1, byteRegs: byteRegsOf(a) })]; }
  throw new Error(`unknown x86 instruction "${mn}"`);
}

export function assemble(source) { return assembleProgram(source, instruction); }

// ---------------------------------------------------------------- the decoder
// decode(read, pc) with read(address) -> byte. Returns the instruction's length, its parts (for the byte
// view), what it does (for the pipeline model) and its micro-operations.
const hex2 = v => v.toString(16).padStart(2, '0');
const sx = (v, bits) => BigInt.asIntN(bits, BigInt(v));
export function decode(read, pc) {
  let p = pc, rex = 0;
  const parts = [];
  const take = (n, name, cls) => { const bytes = []; for (let i = 0; i < n; i++) bytes.push(read(p++)); parts.push({ name, bytes, cls }); return bytes; };
  const peek = () => read(p);
  if ((peek() & 0xf0) === 0x40) rex = take(1, 'REX', 'prefix')[0];
  const W = (rex >> 3) & 1, R = (rex >> 2) & 1, X = (rex >> 1) & 1, B = rex & 1;
  let op = take(1, 'opcode', 'opcode')[0], op2 = null;
  if (op === 0x0f) { op2 = read(p++); parts[parts.length - 1].bytes.push(op2); }
  const imm = (n, signed = true) => { const b = take(n, `immediate${n > 1 ? n * 8 : 8}`, 'imm'); let v = 0n; b.forEach((x, i) => { v |= BigInt(x) << BigInt(8 * i); }); return signed ? BigInt.asIntN(8 * n, v) : v; };
  const modrm = () => {
    const m = take(1, 'ModRM', 'modrm')[0], mod = m >> 6, reg = ((m >> 3) & 7) | (R << 3), rmb = m & 7;
    if (mod === 3) return { reg, rm: { type: 'reg', n: rmb | (B << 3) } };
    let base = rmb | (B << 3), index = null, scale = 1, disp = 0n;
    if (rmb === 4) {
      const s = take(1, 'SIB', 'sib')[0]; scale = 1 << (s >> 6);
      const ix = ((s >> 3) & 7) | (X << 3); index = ix === 4 ? null : ix;
      base = (s & 7) | (B << 3);
      if ((s & 7) === 5 && mod === 0) { base = null; disp = imm(4); parts[parts.length - 1].name = 'displacement32'; parts[parts.length - 1].cls = 'disp'; return { reg, rm: { type: 'mem', base, index, scale, disp } }; }
    } else if (rmb === 5 && mod === 0) { disp = imm(4); parts[parts.length - 1].name = 'rip+displacement32'; parts[parts.length - 1].cls = 'disp'; return { reg, rm: { type: 'mem', rip: true, base: null, index: null, scale: 1, disp } }; }
    if (mod === 1) { disp = imm(1); parts[parts.length - 1].name = 'displacement8'; parts[parts.length - 1].cls = 'disp'; }
    if (mod === 2) { disp = imm(4); parts[parts.length - 1].name = 'displacement32'; parts[parts.length - 1].cls = 'disp'; }
    return { reg, rm: { type: 'mem', base, index, scale, disp } };
  };
  const d = { pc, rex, W };
  const regOp = (n, size = 8) => ({ type: 'reg', n, size });
  const rmOp = (x, size) => (x.type === 'reg' ? { ...x, size } : { ...x, size });
  const ALU_NAMES = Object.keys(ALU);
  if (op2 === null && op < 0x40 && (op & 7) <= 5) {
    const n = op >> 3, form = op & 7, name = ALU_NAMES[n];
    if (form === 5) Object.assign(d, { mn: name, dst: regOp(0), src: { type: 'imm', value: imm(4) } });
    else if (form === 4) Object.assign(d, { mn: name, dst: regOp(0, 1), src: { type: 'imm', value: imm(1) } });
    else { const x = modrm(); const sz = form === 0 || form === 2 ? 1 : 8;
      if (form === 0 || form === 1) Object.assign(d, { mn: name, dst: rmOp(x.rm, sz), src: regOp(x.reg, sz) });
      else Object.assign(d, { mn: name, dst: regOp(x.reg, sz), src: rmOp(x.rm, sz) }); }
  } else if (op2 === null && (op === 0x80 || op === 0x81 || op === 0x83)) {
    const x = modrm(), sz = op === 0x80 ? 1 : 8;
    Object.assign(d, { mn: ALU_NAMES[x.reg & 7], dst: rmOp(x.rm, sz), src: { type: 'imm', value: imm(op === 0x81 ? 4 : 1) } });
  } else if (op2 === null && (op === 0x84 || op === 0x85)) { const x = modrm(), sz = op === 0x84 ? 1 : 8; Object.assign(d, { mn: 'test', dst: rmOp(x.rm, sz), src: regOp(x.reg, sz) }); }
  else if (op2 === null && op === 0xa9) Object.assign(d, { mn: 'test', dst: regOp(0), src: { type: 'imm', value: imm(4) } });
  else if (op2 === null && op === 0xa8) Object.assign(d, { mn: 'test', dst: regOp(0, 1), src: { type: 'imm', value: imm(1) } });
  else if (op2 === null && op === 0xf6) { const x = modrm(); Object.assign(d, (x.reg & 7) === 0 ? { mn: 'test', dst: rmOp(x.rm, 1), src: { type: 'imm', value: imm(1) } } : { mn: '?' }); }
  else if (op2 === null && op >= 0xb0 && op <= 0xb7) Object.assign(d, { mn: 'mov', dst: regOp((op & 7) | (B << 3), 1), src: { type: 'imm', value: imm(1) } });
  else if (op2 === null && (op === 0x88 || op === 0x89)) { const x = modrm(), sz = op === 0x88 ? 1 : 8; Object.assign(d, { mn: 'mov', dst: rmOp(x.rm, sz), src: regOp(x.reg, sz) }); }
  else if (op2 === null && (op === 0x8a || op === 0x8b)) { const x = modrm(), sz = op === 0x8a ? 1 : 8; Object.assign(d, { mn: 'mov', dst: regOp(x.reg, sz), src: rmOp(x.rm, sz) }); }
  else if (op2 === null && op === 0x8d) { const x = modrm(); Object.assign(d, { mn: 'lea', dst: regOp(x.reg), src: x.rm }); }
  else if (op2 === null && (op === 0xc6 || op === 0xc7)) { const x = modrm(), sz = op === 0xc6 ? 1 : 8; Object.assign(d, { mn: 'mov', dst: rmOp(x.rm, sz), src: { type: 'imm', value: imm(sz === 1 ? 1 : 4) } }); }
  else if (op2 === null && op >= 0xb8 && op <= 0xbf) Object.assign(d, { mn: 'mov', dst: regOp((op & 7) | (B << 3)), src: { type: 'imm', value: imm(8) } });
  else if (op2 === null && op === 0xff) { const x = modrm(), e = x.reg & 7;
    if (e <= 1) Object.assign(d, { mn: e ? 'dec' : 'inc', dst: rmOp(x.rm, 8) });
    else if (e === 2 || e === 4) Object.assign(d, { mn: e === 2 ? 'call' : 'jmp', indirect: true, src: rmOp(x.rm, 8) });
    else d.mn = '?';
  } else if (op2 === null && op === 0xf7) { const x = modrm(), e = x.reg & 7;
    if (e === 0) Object.assign(d, { mn: 'test', dst: rmOp(x.rm, 8), src: { type: 'imm', value: imm(4) } });
    else if (e <= 3) Object.assign(d, { mn: e === 2 ? 'not' : 'neg', dst: rmOp(x.rm, 8) });
    else Object.assign(d, { mn: ['mul', 'imul', 'div', 'idiv'][e - 4], src: rmOp(x.rm, 8), oneOperand: true }); // rdx:rax and the operand
  } else if (op2 === null && (op === 0xc1 || op === 0xd1 || op === 0xd3)) { const x = modrm();
    Object.assign(d, { mn: { 4: 'shl', 5: 'shr', 7: 'sar' }[x.reg & 7] || '?', dst: rmOp(x.rm, 8), count: op === 0xd1 ? { type: 'imm', value: 1n } : op === 0xd3 ? regOp(1, 1) : { type: 'imm', value: imm(1) } });
  } else if (op2 === null && op === 0x6b || op2 === null && op === 0x69) { const x = modrm(); Object.assign(d, { mn: 'imul', dst: regOp(x.reg), src: rmOp(x.rm, 8), imm3: { type: 'imm', value: imm(op === 0x6b ? 1 : 4) } }); }
  else if (op2 === null && op >= 0x50 && op <= 0x5f) Object.assign(d, { mn: op < 0x58 ? 'push' : 'pop', dst: regOp((op & 7) | (B << 3)) });
  else if (op2 === null && (op === 0xe8 || op === 0xe9)) { const rel = imm(4); parts[parts.length - 1].name = 'displacement32 (to the target)'; parts[parts.length - 1].cls = 'disp'; Object.assign(d, { mn: op === 0xe8 ? 'call' : 'jmp', target: Number(BigInt.asUintN(64, BigInt(p) + rel) & 0xffffffffn) }); }
  else if (op2 === null && op === 0xc3) d.mn = 'ret';
  else if (op2 === null && op === 0x90) d.mn = 'nop';
  else if (op2 === null && op === 0xf4) d.mn = 'hlt';
  else if (op2 === null && op === 0x99 && W) d.mn = 'cqo';
  else if (op2 !== null && op2 >= 0x80 && op2 <= 0x8f) { const rel = imm(4); parts[parts.length - 1].name = 'displacement32 (to the target)'; parts[parts.length - 1].cls = 'disp'; Object.assign(d, { mn: 'j' + CONDITIONS[op2 - 0x80], cc: op2 - 0x80, target: Number(BigInt.asUintN(64, BigInt(p) + rel) & 0xffffffffn) }); }
  else if (op2 !== null && op2 >= 0x40 && op2 <= 0x4f) { const x = modrm(); Object.assign(d, { mn: 'cmov' + CONDITIONS[op2 - 0x40], cc: op2 - 0x40, dst: regOp(x.reg), src: rmOp(x.rm, 8) }); }
  else if (op2 !== null && op2 >= 0x90 && op2 <= 0x9f) { const x = modrm(); Object.assign(d, { mn: 'set' + CONDITIONS[op2 - 0x90], cc: op2 - 0x90, dst: rmOp(x.rm, 1) }); }
  else if (op2 === 0xb6) { const x = modrm(); Object.assign(d, { mn: 'movzx', dst: regOp(x.reg), src: rmOp(x.rm, 1) }); }
  else if (op2 === 0xaf) { const x = modrm(); Object.assign(d, { mn: 'imul', dst: regOp(x.reg), src: rmOp(x.rm, 8) }); }
  else d.mn = '?';
  d.length = p - pc; d.parts = parts;
  d.text = disasm(d);
  d.uops = microOps(d);
  return d;
}

function opText(o) {
  if (!o) return '';
  if (o.type === 'reg') return (o.size === 1 ? REGS8 : REGS64)[o.n];
  if (o.type === 'imm') return o.value < 0n || o.value > 9n ? (o.value < 0n ? String(o.value) : '0x' + o.value.toString(16)) : String(o.value);
  const t = [];
  if (o.base !== null && o.base !== undefined) t.push(REGS64[o.base]);
  if (o.index !== null && o.index !== undefined) t.push(`${REGS64[o.index]}*${o.scale}`);
  let s = t.join(' + ');
  if (o.disp || !s) s += s ? (o.disp < 0n ? ` - ${-o.disp}` : ` + ${o.disp}`) : `0x${BigInt.asUintN(32, o.disp).toString(16)}`;
  return `${o.size === 1 ? 'byte ' : ''}[${s}]`;
}
function disasm(d) {
  if (d.mn === '?') return '(not in this subset)';
  if (d.target !== undefined) return `${d.mn} 0x${d.target.toString(16)}`;
  if (d.mn === 'imul' && d.imm3) return `imul ${opText(d.dst)}, ${opText(d.src)}, ${opText(d.imm3)}`;
  if (d.count) return `${d.mn} ${opText(d.dst)}, ${opText(d.count)}`;
  if (d.indirect || d.oneOperand) return `${d.mn} ${opText(d.src)}`;
  const ops = [d.dst, d.src].filter(Boolean).map(opText);
  return ops.length ? `${d.mn} ${ops.join(', ')}` : d.mn;
}

// ---------------------------------------------------------------- micro-operations
// How a simple in-order x86 core (./x86_core.js) breaks each instruction down. Each micro-op names the
// registers it reads and writes, so the pipeline can find load-use hazards; "t" is a hidden temporary.
//   1 micro-op   register-register and register-immediate operations, mov, lea, loads, stores, jumps
//   2            a load and an operation (add rax, [rbx]); push (rsp - 8, store); pop (load, rsp + 8)
//   3            read-modify-write (add [rbx], rax: load, add, store); call (rsp - 8, store, jump);
//                ret (load, rsp + 8, jump)
export function microOps(d) {
  const regsOf = o => (!o ? [] : o.type === 'reg' ? [REGS64[o.n]] : o.type === 'mem' ? [o.base, o.index].filter(x => x !== null && x !== undefined).map(n => REGS64[n]) : []);
  const reg = o => (o && o.type === 'reg' ? [REGS64[o.n]] : []);
  const u = (kind, text, reads, writes, extra = {}) => ({ kind, text, reads, writes, ...extra });
  const mn = d.mn, dst = d.dst, src = d.src;
  if (mn === 'push') return [u('alu', 'rsp = rsp - 8', ['rsp'], ['rsp']), u('store', `store ${REGS64[dst.n]} to [rsp]`, ['rsp', REGS64[dst.n]], [])];
  if (mn === 'pop') return [u('load', `load ${REGS64[dst.n]} from [rsp]`, ['rsp'], [REGS64[dst.n]]), u('alu', 'rsp = rsp + 8', ['rsp'], ['rsp'])];
  if (mn === 'call') return [u('alu', 'rsp = rsp - 8', ['rsp'], ['rsp']), u('store', 'store the return address to [rsp]', ['rsp'], []),
    d.indirect ? u('jump', `jump to ${opText(src)}`, regsOf(src), [], { indirect: true }) : u('jump', `jump to 0x${d.target.toString(16)}`, [], [])];
  if (mn === 'ret') return [u('load', 't = [rsp] (the return address)', ['rsp'], ['t']), u('alu', 'rsp = rsp + 8', ['rsp'], ['rsp']), u('jump', 'jump to t', ['t'], [], { indirect: true })];
  if (mn === 'jmp') return [d.indirect ? u('jump', `jump to ${opText(src)}`, regsOf(src), [], { indirect: true }) : u('jump', `jump to 0x${d.target.toString(16)}`, [], [])];
  if (d.cc !== undefined && mn.startsWith('j')) return [u('branch', `${mn}: test the flags`, ['flags'], [])];
  if (mn === 'lea') return [u('alu', `${REGS64[dst.n]} = address`, regsOf(src), [REGS64[dst.n]])];
  if (['nop', 'hlt', 'cqo'].includes(mn)) return [u('alu', mn === 'cqo' ? 'rdx = sign of rax' : mn, mn === 'cqo' ? ['rax'] : [], mn === 'cqo' ? ['rdx'] : [])];
  const memDst = dst && dst.type === 'mem', memSrc = src && src.type === 'mem';
  if (d.oneOperand) { // mul / imul / div / idiv: rdx:rax with the operand, in the multiply/divide unit
    const reads = ['rax', ...(mn === 'div' || mn === 'idiv' ? ['rdx'] : [])], writes = ['rax', 'rdx', ...(mn.endsWith('mul') ? ['flags'] : [])];
    const what = mn.endsWith('mul') ? `rdx:rax = rax x ${memSrc ? 't' : opText(src)}` : `rax, rdx = rdx:rax / ${memSrc ? 't' : opText(src)}, remainder`;
    return memSrc ? [u('load', `t = ${opText(src)}`, regsOf(src), ['t']), u('alu', what, ['t', ...reads], writes, { muldiv: true })]
      : [u('alu', what, [...reg(src), ...reads], writes, { muldiv: true })];
  }
  const writesFlags = ['add', 'sub', 'and', 'or', 'xor', 'cmp', 'test', 'inc', 'dec', 'neg', 'shl', 'shr', 'sar', 'adc', 'sbb', 'imul', 'mul'].includes(mn);
  const writesDst = !['cmp', 'test'].includes(mn);
  const readsFlags = mn.startsWith('cmov') || mn.startsWith('set') || mn === 'adc' || mn === 'sbb';
  const md = ['mul', 'imul', 'div', 'idiv'].includes(mn) ? { muldiv: true } : {};
  const extraReads = (d.count && d.count.type === 'reg' ? ['rcx'] : []).concat(readsFlags ? ['flags'] : []);
  const extraWrites = writesFlags ? ['flags'] : [];
  if (mn === 'mov' || mn === 'movzx') {
    if (memDst) return [u('store', `store ${opText(src)} to ${opText(dst)}`, [...regsOf(dst), ...reg(src)], [])];
    if (memSrc) return [u('load', `${REGS64[dst.n]} = ${opText(src)}`, regsOf(src), [REGS64[dst.n]])];
    return [u('alu', `${opText(dst)} = ${opText(src)}`, reg(src), reg(dst))];
  }
  if (memDst) { // read-modify-write
    const out = [u('load', `t = ${opText(dst)}`, regsOf(dst), ['t']), u('alu', `t = t ${mn} ${opText(src) || ''}`.trim(), ['t', ...reg(src), ...extraReads], ['t', ...extraWrites], md)];
    if (writesDst && !mn.startsWith('set')) out.push(u('store', `store t to ${opText(dst)}`, ['t', ...regsOf(dst)], []));
    else if (mn.startsWith('set')) { out.splice(0, 2, u('alu', `t = ${mn}`, ['flags'], ['t'])); out.push(u('store', `store t to ${opText(dst)}`, ['t', ...regsOf(dst)], [])); }
    return out;
  }
  if (memSrc) return [u('load', `t = ${opText(src)}`, regsOf(src), ['t']), u('alu', `${opText(dst)} = ${opText(dst)} ${mn} t`, ['t', ...reg(dst), ...extraReads], [...(writesDst ? reg(dst) : []), ...extraWrites], md)];
  return [u('alu', d.text, [...reg(dst), ...reg(src), ...extraReads].filter((x, i, a) => a.indexOf(x) === i), [...(writesDst ? reg(dst) : []), ...extraWrites], md)];
}
