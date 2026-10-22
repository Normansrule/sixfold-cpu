// =============================================================================
// model/isas/mips.js: MIPS32 (little-endian), the integer subset, for comparison with RISC-V
//
// MIPS (Stanford, then MIPS Computer Systems, 1985) is RISC-V's closest ancestor: 32 registers, fixed
// 32-bit instructions in three formats, loads and stores the only memory instructions. The differences
// are the instructive part:
//   * three formats instead of six: R (registers), I (16-bit immediate), J (26-bit jump target)
//   * the BRANCH DELAY SLOT: the instruction after a branch or jump always executes (the pipeline is
//     part of the contract); branches compare in DECODE, so a taken branch costs no cycle at all
//   * multiply and divide write two special registers, HI and LO, read back with mfhi / mflo
//   * only beq / bne compare two registers; "branch if less than" is slt + bne (through $at)
//   * register 0 is zero, as in RISC-V; $ra = 31 is fixed by jal (RISC-V lets jal pick its rd)
// Supported: add(u) sub(u) and or xor nor slt(u) sll srl sra sllv srlv srav, addi(u) slti(u) andi ori xori
// lui, lb lbu lh lhu lw sb sh sw, beq bne blez bgtz bltz bgez, j jal jr jalr, mult(u) div(u) mfhi mflo
// mthi mtlo, mul (MIPS32), syscall break, and the usual pseudo-instructions: nop move li la b beqz bnez
// blt bgt ble bge (bltu bgtu bleu bgeu) neg not halt (= break: the program is done).
// Programs are written with the delay slots explicit (".set noreorder" in GNU terms).
// add / addi / sub do not trap on overflow here (programs use the "u" forms, as compilers do).
// =============================================================================
import { assembleProgram, evalExpr, constantOrNull } from './asm_common.js';

export const REGISTER_NAMES = ['zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
  's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra'];
export const RESULT_REGISTER = 2; // $v0: where a function (and a program here) leaves its result

function reg(tok) {
  const t = tok.trim().replace(/^\$/, '');
  if (/^\d+$/.test(t) && +t < 32) return +t;
  const i = REGISTER_NAMES.indexOf(t === 's8' ? 'fp' : t);
  if (i < 0) throw new Error(`not a MIPS register: ${tok}`);
  return i;
}

const R_FUNCT = { sll: 0x00, srl: 0x02, sra: 0x03, sllv: 0x04, srlv: 0x06, srav: 0x07, jr: 0x08, jalr: 0x09, syscall: 0x0c, break: 0x0d,
  mfhi: 0x10, mthi: 0x11, mflo: 0x12, mtlo: 0x13, mult: 0x18, multu: 0x19, div: 0x1a, divu: 0x1b,
  add: 0x20, addu: 0x21, sub: 0x22, subu: 0x23, and: 0x24, or: 0x25, xor: 0x26, nor: 0x27, slt: 0x2a, sltu: 0x2b };
const I_OPCODE = { beq: 4, bne: 5, blez: 6, bgtz: 7, addi: 8, addiu: 9, slti: 0xa, sltiu: 0xb, andi: 0xc, ori: 0xd, xori: 0xe, lui: 0xf,
  lb: 0x20, lh: 0x21, lw: 0x23, lbu: 0x24, lhu: 0x25, sb: 0x28, sh: 0x29, sw: 0x2b };
const LOADS = new Set(['lb', 'lh', 'lw', 'lbu', 'lhu']), STORES = new Set(['sb', 'sh', 'sw']);

const word = w => [w & 255, (w >>> 8) & 255, (w >>> 16) & 255, (w >>> 24) & 255];
const R = (rs, rt, rd, sh, f) => ((rs << 21) | (rt << 16) | (rd << 11) | (sh << 6) | f) >>> 0;
const I = (op, rs, rt, imm) => ((op << 26) | (rs << 21) | (rt << 16) | (imm & 0xffff)) >>> 0;
const one = make => ({ size: 4, emit: (sym, pc) => word(make(sym, pc)) });
const val = (e, sym) => Number(BigInt.asIntN(64, evalExpr(e, sym)));
function mem(op) { // "off($reg)" or "($reg)" or "label" (absolute: only for la-style use)
  const m = op.match(/^(.*)\(\s*(\$?\w+)\s*\)$/);
  if (!m) throw new Error(`expected offset($register), got ${op}`);
  return { off: m[1].trim() || '0', base: reg(m[2]) };
}
const branchOffset = (target, pc) => { const d = target - (pc + 4); if (d % 4) throw new Error('branch target not word aligned'); const o = d >> 2; if (o < -32768 || o > 32767) throw new Error('branch too far'); return o; };
function needs(ops, n, mn) { if (ops.length !== n) throw new Error(`${mn} takes ${n} operand${n === 1 ? '' : 's'}`); }

// li / la: one instruction when the value fits, else lui + ori (always two for a label: its value may be big)
function loadImmediate(rd, expr, sym1) {
  const c = constantOrNull(expr, sym1);
  if (c !== null) {
    const v = Number(BigInt.asIntN(32, c));
    if (v >= -32768 && v <= 32767) return [one(() => I(9, 0, rd, v))];            // addiu rd, $zero, v
    if (v >= 0 && v <= 0xffff) return [one(() => I(0xd, 0, rd, v))];             // ori rd, $zero, v
  }
  return [one(sym => I(0xf, 0, rd, (val(expr, sym) >>> 16) & 0xffff)), one(sym => I(0xd, rd, rd, val(expr, sym) & 0xffff))];
}

export function instruction(mn, ops, sym1) {
  if (mn in R_FUNCT) {
    const f = R_FUNCT[mn];
    if (['sll', 'srl', 'sra'].includes(mn)) { needs(ops, 3, mn); return [one(sym => R(0, reg(ops[1]), reg(ops[0]), val(ops[2], sym) & 31, f))]; }
    if (['sllv', 'srlv', 'srav'].includes(mn)) { needs(ops, 3, mn); return [one(() => R(reg(ops[2]), reg(ops[1]), reg(ops[0]), 0, f))]; }
    if (mn === 'jr') { needs(ops, 1, mn); return [one(() => R(reg(ops[0]), 0, 0, 0, f))]; }
    if (mn === 'jalr') { const rd = ops.length === 2 ? reg(ops[0]) : 31, rs = reg(ops[ops.length - 1]); return [one(() => R(rs, 0, rd, 0, f))]; }
    if (mn === 'syscall' || mn === 'break') return [one(sym => (((ops.length ? val(ops[0], sym) : 0) & 0xfffff) << 6 | f) >>> 0)];
    if (mn === 'mfhi' || mn === 'mflo') { needs(ops, 1, mn); return [one(() => R(0, 0, reg(ops[0]), 0, f))]; }
    if (mn === 'mthi' || mn === 'mtlo') { needs(ops, 1, mn); return [one(() => R(reg(ops[0]), 0, 0, 0, f))]; }
    if (['mult', 'multu', 'div', 'divu'].includes(mn)) { needs(ops, 2, mn); return [one(() => R(reg(ops[0]), reg(ops[1]), 0, 0, f))]; }
    needs(ops, 3, mn); return [one(() => R(reg(ops[1]), reg(ops[2]), reg(ops[0]), 0, f))];
  }
  if (mn === 'mul') { needs(ops, 3, mn); return [one(() => ((0x1c << 26) | (reg(ops[1]) << 21) | (reg(ops[2]) << 16) | (reg(ops[0]) << 11) | 2) >>> 0)]; }
  if (LOADS.has(mn) || STORES.has(mn)) { needs(ops, 2, mn); const m = mem(ops[1]); return [one(sym => I(I_OPCODE[mn], m.base, reg(ops[0]), val(m.off, sym)))]; }
  if (mn === 'lui') { needs(ops, 2, mn); return [one(sym => I(0xf, 0, reg(ops[0]), val(ops[1], sym)))]; }
  if (['addi', 'addiu', 'slti', 'sltiu', 'andi', 'ori', 'xori'].includes(mn)) { needs(ops, 3, mn); return [one(sym => I(I_OPCODE[mn], reg(ops[1]), reg(ops[0]), val(ops[2], sym)))]; }
  if (mn === 'beq' || mn === 'bne') { needs(ops, 3, mn); return [one((sym, pc) => I(I_OPCODE[mn], reg(ops[0]), reg(ops[1]), branchOffset(val(ops[2], sym), pc)))]; }
  if (mn === 'blez' || mn === 'bgtz') { needs(ops, 2, mn); return [one((sym, pc) => I(I_OPCODE[mn], reg(ops[0]), 0, branchOffset(val(ops[1], sym), pc)))]; }
  if (mn === 'bltz' || mn === 'bgez') { needs(ops, 2, mn); return [one((sym, pc) => I(1, reg(ops[0]), mn === 'bgez' ? 1 : 0, branchOffset(val(ops[1], sym), pc)))]; }
  if (mn === 'j' || mn === 'jal') { needs(ops, 1, mn); return [one(sym => (((mn === 'j' ? 2 : 3) << 26) | ((val(ops[0], sym) >>> 2) & 0x3ffffff)) >>> 0)]; }
  // ---- pseudo-instructions
  switch (mn) {
    case 'nop': return [one(() => 0)];
    case 'halt': return [one(() => R_FUNCT.break)];
    case 'move': needs(ops, 2, mn); return [one(() => R(reg(ops[1]), 0, reg(ops[0]), 0, R_FUNCT.addu))];
    case 'neg': needs(ops, 2, mn); return [one(() => R(0, reg(ops[1]), reg(ops[0]), 0, R_FUNCT.subu))];
    case 'not': needs(ops, 2, mn); return [one(() => R(reg(ops[1]), 0, reg(ops[0]), 0, R_FUNCT.nor))];
    case 'li': case 'la': needs(ops, 2, mn); return loadImmediate(reg(ops[0]), ops[1], sym1);
    case 'b': needs(ops, 1, mn); return [one((sym, pc) => I(4, 0, 0, branchOffset(val(ops[0], sym), pc)))];
    case 'beqz': needs(ops, 2, mn); return [one((sym, pc) => I(4, reg(ops[0]), 0, branchOffset(val(ops[1], sym), pc)))];
    case 'bnez': needs(ops, 2, mn); return [one((sym, pc) => I(5, reg(ops[0]), 0, branchOffset(val(ops[1], sym), pc)))];
    case 'blt': case 'bgt': case 'ble': case 'bge': case 'bltu': case 'bgtu': case 'bleu': case 'bgeu': {
      // slt(u) $at, a, b then bne/beq $at, $zero: two instructions (the branch's delay slot follows them)
      needs(ops, 3, mn);
      const unsigned = mn.endsWith('u'), base = unsigned ? mn.slice(0, -1) : mn;
      const swap = base === 'bgt' || base === 'ble', a = swap ? ops[1] : ops[0], b = swap ? ops[0] : ops[1];
      const taken = base === 'blt' || base === 'bgt' ? 5 : 4; // bne $at (a < b) / beq $at (not a < b)
      return [one(() => R(reg(a), reg(b), 1, 0, unsigned ? R_FUNCT.sltu : R_FUNCT.slt)),
        one((sym, pc) => I(taken, 1, 0, branchOffset(val(ops[2], sym), pc)))];
    }
    default: throw new Error(`unknown MIPS instruction "${mn}"`);
  }
}

export function assemble(source) { return assembleProgram(source, instruction); }

// ---------------------------------------------------------------- decoding (for the pipeline model and the views)
const R_NAMES = Object.fromEntries(Object.entries(R_FUNCT).map(([k, v]) => [v, k]));
const I_NAMES = Object.fromEntries(Object.entries(I_OPCODE).map(([k, v]) => [v, k]));
const sx16 = v => (v << 16) >> 16;
const rn = r => '$' + REGISTER_NAMES[r];

// d: { mn, format, rs, rt, rd, shamt, imm, target, fields: [[name, hi, lo]], src: [registers read], dst, kind }
export function decode(w, pc = 0) {
  const op = w >>> 26, rs = (w >>> 21) & 31, rt = (w >>> 16) & 31, rd = (w >>> 11) & 31, shamt = (w >>> 6) & 31, funct = w & 63, imm = sx16(w & 0xffff);
  const d = { word: w >>> 0, op, rs, rt, rd, shamt, funct, imm, src: [], dst: 0, kind: 'alu' };
  const Rf = [['opcode', 31, 26], ['rs', 25, 21], ['rt', 20, 16], ['rd', 15, 11], ['shamt', 10, 6], ['funct', 5, 0]];
  const If = [['opcode', 31, 26], ['rs', 25, 21], ['rt', 20, 16], ['immediate', 15, 0]];
  if (w === 0) return { ...d, mn: 'nop', format: 'R', fields: Rf, text: 'nop' };
  if (op === 0) {
    const mn = R_NAMES[funct];
    if (!mn) return { ...d, mn: '?', format: 'R', fields: Rf, text: `.word 0x${(w >>> 0).toString(16)}`, kind: 'illegal' };
    const out = { ...d, mn, format: 'R', fields: Rf };
    if (['sll', 'srl', 'sra'].includes(mn)) return { ...out, src: [rt], dst: rd, text: `${mn} ${rn(rd)}, ${rn(rt)}, ${shamt}` };
    if (['sllv', 'srlv', 'srav'].includes(mn)) return { ...out, src: [rt, rs], dst: rd, text: `${mn} ${rn(rd)}, ${rn(rt)}, ${rn(rs)}` };
    if (mn === 'jr') return { ...out, src: [rs], kind: 'jump-register', text: `jr ${rn(rs)}` };
    if (mn === 'jalr') return { ...out, src: [rs], dst: rd, kind: 'jump-register', link: true, text: `jalr ${rn(rd)}, ${rn(rs)}` };
    if (mn === 'syscall' || mn === 'break') return { ...out, kind: mn, text: mn === 'break' ? 'break (halt)' : 'syscall' };
    if (mn === 'mfhi' || mn === 'mflo') return { ...out, dst: rd, kind: 'move-from-hilo', text: `${mn} ${rn(rd)}` };
    if (mn === 'mthi' || mn === 'mtlo') return { ...out, src: [rs], kind: 'move-to-hilo', text: `${mn} ${rn(rs)}` };
    if (['mult', 'multu', 'div', 'divu'].includes(mn)) return { ...out, src: [rs, rt], kind: 'hilo', text: `${mn} ${rn(rs)}, ${rn(rt)}` };
    return { ...out, src: [rs, rt], dst: rd, text: mn === 'addu' && rt === 0 ? `move ${rn(rd)}, ${rn(rs)}` : `${mn} ${rn(rd)}, ${rn(rs)}, ${rn(rt)}` };
  }
  if (op === 0x1c && funct === 2) return { ...d, mn: 'mul', format: 'R', fields: Rf, src: [rs, rt], dst: rd, kind: 'mul', text: `mul ${rn(rd)}, ${rn(rs)}, ${rn(rt)}` };
  if (op === 2 || op === 3) {
    const target = (((pc + 4) & 0xf0000000) | ((w & 0x3ffffff) << 2)) >>> 0;
    return { ...d, mn: op === 2 ? 'j' : 'jal', format: 'J', fields: [['opcode', 31, 26], ['target', 25, 0]], kind: 'jump', link: op === 3, dst: op === 3 ? 31 : 0, target, text: `${op === 2 ? 'j' : 'jal'} 0x${target.toString(16)}` };
  }
  if (op === 1 && (rt === 0 || rt === 1)) {
    const target = (pc + 4 + (imm << 2)) >>> 0, mn = rt ? 'bgez' : 'bltz';
    return { ...d, mn, format: 'I', fields: If, kind: 'branch', src: [rs], target, text: `${mn} ${rn(rs)}, 0x${target.toString(16)}` };
  }
  const mn = I_NAMES[op];
  if (!mn) return { ...d, mn: '?', format: 'I', fields: If, text: `.word 0x${(w >>> 0).toString(16)}`, kind: 'illegal' };
  const out = { ...d, mn, format: 'I', fields: If };
  if (['beq', 'bne'].includes(mn)) { const target = (pc + 4 + (imm << 2)) >>> 0; return { ...out, kind: 'branch', src: [rs, rt], target, text: rt === 0 ? `${mn === 'beq' ? 'beqz' : 'bnez'} ${rn(rs)}, 0x${target.toString(16)}` : `${mn} ${rn(rs)}, ${rn(rt)}, 0x${target.toString(16)}` }; }
  if (['blez', 'bgtz'].includes(mn)) { const target = (pc + 4 + (imm << 2)) >>> 0; return { ...out, kind: 'branch', src: [rs], target, text: `${mn} ${rn(rs)}, 0x${target.toString(16)}` }; }
  if (LOADS.has(mn)) return { ...out, kind: 'load', src: [rs], dst: rt, text: `${mn} ${rn(rt)}, ${imm}(${rn(rs)})` };
  if (STORES.has(mn)) return { ...out, kind: 'store', src: [rs, rt], text: `${mn} ${rn(rt)}, ${imm}(${rn(rs)})` };
  if (mn === 'lui') return { ...out, dst: rt, text: `lui ${rn(rt)}, 0x${(w & 0xffff).toString(16)}` };
  const shown = ['andi', 'ori', 'xori'].includes(mn) ? `0x${(w & 0xffff).toString(16)}` : imm;
  return { ...out, src: [rs], dst: rt, text: mn === 'addiu' && rs === 0 ? `li ${rn(rt)}, ${imm}` : `${mn} ${rn(rt)}, ${rn(rs)}, ${shown}` };
}
