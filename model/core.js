// =============================================================================
// model/core.js: cycle-exact software twin of src/Riscv64.sv
//
//   FETCH1 ─► FETCH2 ─► DECODE ─► EXECUTE ─► MEMORY ─► WRITEBACK
//   gshare    predecode  regfile   ALU, MDU   Load      regfile
//   lookup    redirect   control   branch     Control   write
//             JAL/taken  forward   CSR, store
//
// Every rule below has the same name as the signal in the RTL, so you can read
// the two files side by side. `make test` runs each program through BOTH and
// diffs the per-cycle trace, so a change here must also be made in src/.
//
//   LOAD_STALL                     DECODE_VALID && EXECUTE is a load && its rd != 0 && rd matches
//                                  the rs1 OR rs2 FIELD of the Decode instruction (fields, not uses)
//   FLUSH_FETCH1_FETCH2_DECODE     EXECUTE_VALID && (branch guessed wrong || JALR)
//   FETCH2_BRANCH_OFF_OR_CONTINUE  FETCH2_VALID && (JAL || branch predicted taken)
//   Forwarding into DECODE         x0 > EXECUTE (not a load) > MEMORY > WRITEBACK > register file
//   HALT_NOW                       the instruction that wrote a nonzero TOHOST is in WRITEBACK
// =============================================================================
import { decode, disasm, usesRegs } from './isa.js';

export const STAGES = ['FETCH1', 'FETCH2', 'DECODE', 'EXECUTE', 'MEMORY', 'WRITEBACK'];
export const SHORT = { FETCH1: 'F1', FETCH2: 'F2', DECODE: 'D', EXECUTE: 'E', MEMORY: 'M', WRITEBACK: 'W' };
export const RESET_PC = 0x2000;
export const MMIO_BASE = 0x10000000n, MMIO_PUTCHAR = 0x10000000n, MMIO_LEDS = 0x10000008n, MMIO_BUTTONS = 0x10000010n;
export const MMIO_MTIME = 0x10000058n, MMIO_MTIMECMP = 0x10000060n; // the machine timer (src/Riscv64_top.sv)
export const MMIO_SWITCHES = 0x10000068n, MMIO_DISPLAY = 0x10000070n; // FPGA boards: slide switches, seven-segment digits
// The LEDS register is 16 bits and DISPLAY 32: a store changes only the bytes it writes
const mergeBytes = (old, op, bytes) => { let v = old; for (let k = 0; k < bytes; k++) if (op.mask & (1 << k)) v = (v & ~(0xff << (8 * k))) | (Number((op.data >> BigInt(8 * k)) & 0xffn) << (8 * k)); return v >>> 0; };
export const isMmio = a => (a >> 8n) === (MMIO_BASE >> 8n); // 0x1000_0000 .. 0x1000_00FF: devices, never RAM
export const HPM = { 0xC03: 'stall', 0xC04: 'flush', 0xC05: 'redirect', 0xC06: 'busy', 0xC07: 'imiss', 0xC08: 'dmiss', 0xC09: 'intr' }; // hpmcounter3..9 = L F R K I D X
export const CSR = { TOHOST: 0x51E, STATUS: 0x50A, HARTID: 0x50B, CYCLE: 0xC00, INSTRET: 0xC02, MHARTID: 0xF14,
  MSTATUS: 0x300, MTVEC: 0x305, MSCRATCH: 0x340, MEPC: 0x341, MCAUSE: 0x342, MIE: 0x304, MIP: 0x344 };
// mcause values for the two interrupts (bit 63 set: an interrupt, not an exception)
export const CAUSE_TIMER_INTERRUPT = (1n << 63n) | 7n, CAUSE_EXTERNAL_INTERRUPT = (1n << 63n) | 11n;
export const DEFAULT_HISTORY_BITS = 6; // GSHARE_HISTORY_BITS in src/Riscv64.sv
// The two builds `make test` checks (parameters of src/Riscv64.sv):
export const CONFIGS = {
  performance: { historyBits: 6, btb: true, ras: true, preciseStall: true, iterativeMdu: true, tournament: true, caches: true, missLatency: 10 },
  baseline: { historyBits: 4, btb: false, ras: false, preciseStall: false, iterativeMdu: false, tournament: false, caches: false, missLatency: 10 }, // the plain pipeline
};
// ControlUnit USES_REGISTER1 / USES_REGISTER2 (by opcode, exactly as src/Control_Unit.sv)
export function usesRegisters(word) {
  const op = word & 0x7f, f3 = (word >>> 12) & 7;
  if (op === 0x33 || op === 0x3b || op === 0x23 || op === 0x63 || op === 0x0b) return { rs1: true, rs2: true };
  if (op === 0x13 || op === 0x1b || op === 0x03 || op === 0x67) return { rs1: true, rs2: false };
  if (op === 0x73) return { rs1: f3 === 1 || f3 === 2 || f3 === 3, rs2: false };
  return { rs1: false, rs2: false };
}
// Cycles an M instruction spends iterating in IterativeMultiplyDivideUnit (it occupies EXECUTE for steps + 4 cycles:
// IDLE capture, PREPARE, the steps, SIGN, DONE; a divide's ALIGN cycle is counted as one more step)
export function multiplyDivideSteps(op, isWord, a) {
  if (!['DIV', 'DIVU', 'REM', 'REMU'].includes(op)) return 4;
  const signed = op === 'DIV' || op === 'REM';
  let x = isWord ? (signed ? BigInt.asUintN(64, BigInt.asIntN(32, a)) : BigInt.asUintN(32, a)) : a;
  if (signed && (x >> 63n)) x = BigInt.asUintN(64, -x);
  return 1 + Math.max(1, x.toString(2).replace(/^0+/, '').length); // + 1: the ALIGN cycle
}

const u64 = x => BigInt.asUintN(64, x);
const s64 = x => BigInt.asIntN(64, x);
const u32 = x => BigInt.asUintN(32, x);
const s32 = x => BigInt.asIntN(32, x);
const sx32 = x => u64(s32(x)); // low 32 bits sign-extended to 64
const bits = (w, hi, lo) => (w >>> lo) & ((1 << (hi - lo + 1)) - 1);
const sextN = (v, n) => BigInt.asIntN(n, BigInt(v));

// ---------------------------------------------------------------- ControlUnit + ALUdec
// Mirrors src/Control_Unit.sv and src/ALUdec.sv exactly (by opcode/funct bits, not by name).
export const OPC = { LUI: 0x37, AUIPC: 0x17, JAL: 0x6f, JALR: 0x67, BRANCH: 0x63, STORE: 0x23, LOAD: 0x03,
  OP: 0x33, OP_IMM: 0x13, OP_32: 0x3b, OP_IMM_32: 0x1b, SYSTEM: 0x73, CUSTOM0: 0x0b };
export const WB = { ALU: 0, MEMORY: 1, PC_ADD_4: 2, CSR: 3 };
export const WB_NAMES = ['ALU', 'MEMORY', 'PC_ADD_4', 'CSR'];
const ARITH = ['ADD', 'SLL', 'SLT', 'SLTU', 'XOR', 'SRL_SRA', 'OR', 'AND'];
const MULDIV = ['MUL', 'MULH', 'MULHSU', 'MULHU', 'DIV', 'DIVU', 'REM', 'REMU'];

// ALUdec (src/ALUdec.sv): opcode + funct3 + funct7 / funct12 -> ALU operation, plus the operand preparation
// DECODE applies for Zba/Zbb (aZext: use zext(rs1[31:0]); aShift: rs1 << n; invB: ~rs2; full: 64-bit result
// although the opcode is in the W space).
export function aluDecode(word) {
  const op = word & 0x7f, f3 = bits(word, 14, 12), f7 = bits(word, 31, 25), f6 = f7 >> 1, f12 = bits(word, 31, 20), b30 = bits(word, 30, 30);
  const r = { aluOp: 'XXX', aZext: 0, aShift: 0, invB: 0, oneB: 0, full: 0 };
  const base = () => { const n = ARITH[f3]; return n === 'SRL_SRA' ? (b30 ? 'SRA' : 'SRL') : n; };
  switch (op) {
    case OPC.OP_IMM:
      if (f3 === 0b001) {
        r.aluOp = ({ 0x600: 'CLZ', 0x601: 'CTZ', 0x602: 'CPOP', 0x604: 'SEXT_B', 0x605: 'SEXT_H',
          0x100: 'SHA256SUM0', 0x101: 'SHA256SUM1', 0x102: 'SHA256SIG0', 0x103: 'SHA256SIG1', // Zknh
          0x104: 'SHA512SUM0', 0x105: 'SHA512SUM1', 0x106: 'SHA512SIG0', 0x107: 'SHA512SIG1' })[f12] || 'SLL';
        if (r.aluOp === 'SLL') { // Zbs immediates: bseti bclri binvi are OR / AND / XOR with 1 << shamt
          if (f6 === 0b001010) Object.assign(r, { aluOp: 'OR', oneB: 1 });
          else if (f6 === 0b010010) Object.assign(r, { aluOp: 'AND', oneB: 1, invB: 1 });
          else if (f6 === 0b011010) Object.assign(r, { aluOp: 'XOR', oneB: 1 });
        }
      } else if (f3 === 0b101) r.aluOp = f12 === 0x6b8 ? 'REV8' : f12 === 0x287 ? 'ORC_B' : f6 === 0b011000 ? 'ROR' : f6 === 0b010010 ? 'BEXT' : (b30 ? 'SRA' : 'SRL');
      else r.aluOp = f3 === 0 ? 'ADD' : base();
      break;
    case OPC.OP_IMM_32:
      if (f3 === 0b001) {
        const u = ({ 0x600: 'CLZ', 0x601: 'CTZ', 0x602: 'CPOP' })[f12];
        if (u) r.aluOp = u; else if (f6 === 0b000010) Object.assign(r, { aluOp: 'SLL', aZext: 1, full: 1 }); else r.aluOp = 'SLL';
      } else if (f3 === 0b101) r.aluOp = f7 === 0b0110000 ? 'ROR' : (b30 ? 'SRA' : 'SRL');
      else r.aluOp = f3 === 0 ? 'ADD' : base();
      break;
    case OPC.OP: case OPC.OP_32: {
      const word32 = op === OPC.OP_32;
      if (f7 === 0b0000001) r.aluOp = MULDIV[f3];
      else if (f7 === 0b0000000) r.aluOp = f3 === 0 ? 'ADD' : base();
      else if (f7 === 0b0100000) {
        if (f3 === 0b000) r.aluOp = 'SUB'; else if (f3 === 0b101) r.aluOp = 'SRA';
        else if (!word32 && f3 === 0b111) Object.assign(r, { aluOp: 'AND', invB: 1 });
        else if (!word32 && f3 === 0b110) Object.assign(r, { aluOp: 'OR', invB: 1 });
        else if (!word32 && f3 === 0b100) Object.assign(r, { aluOp: 'XOR', invB: 1 });
      } else if (f7 === 0b0010000 && (f3 === 0b010 || f3 === 0b100 || f3 === 0b110)) Object.assign(r, { aluOp: 'ADD', aShift: f3 >> 1, aZext: word32 ? 1 : 0, full: word32 ? 1 : 0 });
      else if (f7 === 0b0000101 && !word32 && f3 >= 0b100) r.aluOp = ['MIN', 'MINU', 'MAX', 'MAXU'][f3 - 4];
      else if (f7 === 0b0110000 && (f3 === 0b001 || f3 === 0b101)) r.aluOp = f3 === 0b001 ? 'ROL' : 'ROR';
      else if (!word32 && f3 === 0b001 && f7 === 0b0010100) Object.assign(r, { aluOp: 'OR', oneB: 1 }); // bset
      else if (!word32 && f3 === 0b001 && f7 === 0b0100100) Object.assign(r, { aluOp: 'AND', oneB: 1, invB: 1 }); // bclr
      else if (!word32 && f3 === 0b001 && f7 === 0b0110100) Object.assign(r, { aluOp: 'XOR', oneB: 1 }); // binv
      else if (!word32 && f3 === 0b101 && f7 === 0b0100100) r.aluOp = 'BEXT';
      else if (f7 === 0b0000100 && word32 && f3 === 0b000) Object.assign(r, { aluOp: 'ADD', aZext: 1, full: 1 });
      else if (f7 === 0b0000100 && word32 && f3 === 0b100) Object.assign(r, { aluOp: 'ZEXT_H', full: 1 });
      break;
    }
    case OPC.CUSTOM0: // hsec.cteq (custom-0, funct7 0, funct3 110)
      if (f7 === 0 && f3 === 0b110) r.aluOp = 'CTEQ';
      break;
    default: break;
  }
  return r;
}

// Zbb results with a 2-cycle latency: forwarded from MEMORY, and a dependent next instruction waits (LOAD_STALL)
export const LATE_OPS = new Set(['CPOP', 'MIN', 'MINU', 'MAX', 'MAXU']);

export function control(word) {
  const op = word & 0x7f, f3 = bits(word, 14, 12), f7 = bits(word, 31, 25), rs1f = bits(word, 19, 15);
  const c = { regWrite: 0, memRead: 0, memWrite: 0, csrWrite: 0, csrImm: 0, aIsPC: 0, bIsImm: 0, isWord: 0, isMulDiv: 0,
    isBranch: 0, isJal: 0, isJalr: 0, isEcall: 0, isEbreak: 0, isMret: 0, immType: 'I', wbSel: WB.ALU, aluOp: 'XXX',
    aZext: 0, aShift: 0, invB: 0, oneB: 0, late: 0 };
  const md = f7 === 0b0000001;
  const dec = () => { const d = aluDecode(word); Object.assign(c, { aluOp: d.aluOp, aZext: d.aZext, aShift: d.aShift, invB: d.invB, oneB: d.oneB, late: LATE_OPS.has(d.aluOp) ? 1 : 0 }); return d; };
  switch (op) {
    case OPC.LUI: Object.assign(c, { regWrite: 1, bIsImm: 1, immType: 'U', aluOp: 'COPY_B' }); break;
    case OPC.AUIPC: Object.assign(c, { regWrite: 1, aIsPC: 1, bIsImm: 1, immType: 'U', aluOp: 'ADD' }); break;
    case OPC.JAL: Object.assign(c, { isJal: 1, regWrite: 1, aIsPC: 1, bIsImm: 1, immType: 'J', wbSel: WB.PC_ADD_4, aluOp: 'ADD' }); break;
    case OPC.JALR: Object.assign(c, { isJalr: 1, regWrite: 1, bIsImm: 1, immType: 'I', wbSel: WB.PC_ADD_4, aluOp: 'JALR' }); break;
    case OPC.BRANCH: Object.assign(c, { isBranch: 1, aIsPC: 1, bIsImm: 1, immType: 'B', aluOp: 'ADD' }); break;
    case OPC.STORE: Object.assign(c, { memWrite: 1, bIsImm: 1, immType: 'S', aluOp: 'ADD' }); break;
    case OPC.LOAD: Object.assign(c, { regWrite: 1, memRead: 1, bIsImm: 1, immType: 'I', wbSel: WB.MEMORY, aluOp: 'ADD' }); break;
    case OPC.OP: case OPC.OP_32: {
      Object.assign(c, { regWrite: 1, isMulDiv: md ? 1 : 0 });
      const d = dec(); c.isWord = op === OPC.OP_32 && !d.full ? 1 : 0;
      break;
    }
    case OPC.CUSTOM0: { // hsec.cteq: an R-type ALU instruction in an opcode of our own
      c.regWrite = (f7 === 0 && f3 === 0b110) ? 1 : 0;
      dec();
      break;
    }
    case OPC.OP_IMM: case OPC.OP_IMM_32: {
      Object.assign(c, { regWrite: 1, bIsImm: 1, immType: 'I' });
      const d = dec(); c.isWord = op === OPC.OP_IMM_32 && !d.full ? 1 : 0;
      break;
    }
    case OPC.SYSTEM:
      c.regWrite = f3 !== 0 ? 1 : 0; c.wbSel = WB.CSR;
      if (f3 === 0b001 || f3 === 0b101) c.csrWrite = 1; else if (f3 !== 0) c.csrWrite = rs1f !== 0 ? 1 : 0;
      if (f3 === 0b101 || f3 === 0b110 || f3 === 0b111) { c.csrImm = 1; c.immType = 'Z'; }
      c.aluOp = (f3 === 0b001 || f3 === 0b101) ? 'COPY_B' : 'XXX';
      if (f3 === 0 && rs1f === 0 && bits(word, 11, 7) === 0) { // ecall / ebreak / mret (ControlUnit IS_AN_*)
        const f12 = bits(word, 31, 20);
        c.isEcall = f12 === 0 ? 1 : 0; c.isEbreak = f12 === 1 ? 1 : 0; c.isMret = f12 === 0x302 ? 1 : 0;
      }
      break;
    default: break; // FENCE and unknown opcodes: no operation
  }
  return c;
}

// DECODE's operand preparation (Riscv64.sv: EXECUTE_ALU_INPUT_A / _B are chosen and prepared in DECODE)
export function prepareA(rs1, c) { const x = c.aZext ? (rs1 & 0xffffffffn) : rs1; return u64(x << BigInt(c.aShift || 0)); }
// operand B (rs2 or the immediate): Zbs's single bit, then the Zbb / Zbs inversion (src/Riscv64.sv prepare_operand_b)
export function prepareB(value, c) { const chosen = c.oneB ? 1n << (value & 63n) : value; return c.invB ? u64(~chosen) : chosen; }

// ---------------------------------------------------------------- ImmediateGenerator
export function immediate(word, type) {
  switch (type) {
    case 'I': return u64(sextN(bits(word, 31, 20), 12));
    case 'S': return u64(sextN((bits(word, 31, 25) << 5) | bits(word, 11, 7), 12));
    case 'B': return u64(sextN((bits(word, 31, 31) << 12) | (bits(word, 7, 7) << 11) | (bits(word, 30, 25) << 5) | (bits(word, 11, 8) << 1), 13));
    case 'U': return u64(sextN((word & 0xfffff000) >>> 0, 32));
    case 'J': return u64(sextN((bits(word, 31, 31) << 20) | (bits(word, 19, 12) << 12) | (bits(word, 20, 20) << 11) | (bits(word, 30, 21) << 1), 21));
    case 'Z': return BigInt(bits(word, 19, 15));
    default: return 0n;
  }
}

// ---------------------------------------------------------------- ALU (src/ALU.sv)
const clz64 = x => { if (x === 0n) return 64n; let n = 0n; for (let i = 63n; i >= 0n && !((x >> i) & 1n); i--) n++; return n; };
const ctz64 = x => { if (x === 0n) return 64n; let n = 0n; while (!((x >> n) & 1n)) n++; return n; };
const cpop64 = x => { let n = 0n; while (x) { n += x & 1n; x >>= 1n; } return n; };
const ror32 = (x, n) => u32((u32(x) >> n) | (u32(x) << (32n - n)));
const rot = (x, s, w, left) => { const m = (1n << w) - 1n; s %= w; if (s === 0n) return x & m; return left ? (((x << s) | (x >> (w - s))) & m) : (((x >> s) | (x << (w - s))) & m); };
export const SUBTRACTS = new Set(['SUB', 'SLT', 'SLTU', 'MIN', 'MINU', 'MAX', 'MAXU']);
export function alu(a, b, op, isWord) {
  const sub = SUBTRACTS.has(op);
  const sum = a + (sub ? u64(~b) : b) + (sub ? 1n : 0n); // 65-bit shared adder
  const slt = ((a >> 63n) !== (b >> 63n)) ? (a >> 63n) : ((u64(sum) >> 63n) & 1n);
  const sltu = ((sum >> 64n) & 1n) ? 0n : 1n;
  if (isWord) {
    const sh = BigInt(Number(b & 31n)), lo = u32(a);
    if (op === 'SLL') return sx32(lo << sh);
    if (op === 'SRL') return sx32(lo >> sh);
    if (op === 'SRA') return sx32(u32(s32(lo) >> sh));
    if (op === 'ROL') return sx32(rot(lo, sh, 32n, true));
    if (op === 'ROR') return sx32(rot(lo, sh, 32n, false));
    if (op === 'CLZ') return lo === 0n ? 32n : clz64(lo) - 32n;
    if (op === 'CTZ') return lo === 0n ? 32n : ctz64(lo);
    if (op === 'CPOP') return cpop64(lo);
    return sx32(sum); // ADDW / ADDIW / SUBW use the low half of the shared adder
  }
  const sh = BigInt(Number(b & 63n));
  switch (op) {
    case 'ADD': case 'SUB': case 'JALR': return u64(sum);
    case 'AND': return a & b;
    case 'OR': return a | b;
    case 'XOR': return a ^ b;
    case 'SLT': return slt;
    case 'SLTU': return sltu;
    case 'SLL': return u64(a << sh);
    case 'SRL': return a >> sh;
    case 'SRA': return u64(s64(a) >> sh);
    case 'COPY_B': return b;
    case 'CSR': return a & u64(~b);
    case 'MIN': return slt ? a : b;
    case 'MINU': return sltu ? a : b;
    case 'MAX': return slt ? b : a;
    case 'MAXU': return sltu ? b : a;
    case 'ROL': return rot(a, sh, 64n, true);
    case 'ROR': return rot(a, sh, 64n, false);
    case 'CLZ': return clz64(a);
    case 'CTZ': return ctz64(a);
    case 'CPOP': return cpop64(a);
    case 'SEXT_B': return u64(BigInt.asIntN(8, a));
    case 'SEXT_H': return u64(BigInt.asIntN(16, a));
    case 'ZEXT_H': return a & 0xffffn;
    case 'REV8': { let r = 0n; for (let i = 0n; i < 8n; i++) r |= ((a >> (8n * i)) & 0xffn) << (8n * (7n - i)); return r; }
    case 'BEXT': return (a >> sh) & 1n;
    // Zknh: SHA-2 sigma and sum functions (SHA-256 forms work on rs1[31:0] and sign-extend)
    case 'SHA256SUM0': return sx32(ror32(a, 2n) ^ ror32(a, 13n) ^ ror32(a, 22n));
    case 'SHA256SUM1': return sx32(ror32(a, 6n) ^ ror32(a, 11n) ^ ror32(a, 25n));
    case 'SHA256SIG0': return sx32(ror32(a, 7n) ^ ror32(a, 18n) ^ (u32(a) >> 3n));
    case 'SHA256SIG1': return sx32(ror32(a, 17n) ^ ror32(a, 19n) ^ (u32(a) >> 10n));
    case 'SHA512SUM0': return rot(a, 28n, 64n, false) ^ rot(a, 34n, 64n, false) ^ rot(a, 39n, 64n, false);
    case 'SHA512SUM1': return rot(a, 14n, 64n, false) ^ rot(a, 18n, 64n, false) ^ rot(a, 41n, 64n, false);
    case 'SHA512SIG0': return rot(a, 1n, 64n, false) ^ rot(a, 8n, 64n, false) ^ (a >> 7n);
    case 'SHA512SIG1': return rot(a, 19n, 64n, false) ^ rot(a, 61n, 64n, false) ^ (a >> 6n);
    case 'CTEQ': return (a ^ b) === 0n ? 1n : 0n; // hsec.cteq: equality with no branch
    case 'ORC_B': { let r = 0n; for (let i = 0n; i < 8n; i++) if ((a >> (8n * i)) & 0xffn) r |= 0xffn << (8n * i); return r; }
    default: return 0n;
  }
}

// ---------------------------------------------------------------- MultiplyDivideUnit
export function multiplyDivide(a, b, op, isWord) {
  if (isWord) {
    const A = u32(a), B = u32(b), sA = s32(A), sB = s32(B);
    let r;
    switch (op) {
      case 'MUL': r = u32(A * B); break;
      case 'DIV': r = B === 0n ? 0xffffffffn : (A === 0x80000000n && B === 0xffffffffn) ? A : u32(sA / sB); break;
      case 'DIVU': r = B === 0n ? 0xffffffffn : A / B; break;
      case 'REM': r = B === 0n ? A : (A === 0x80000000n && B === 0xffffffffn) ? 0n : u32(sA % sB); break;
      case 'REMU': r = B === 0n ? A : A % B; break;
      default: r = 0n;
    }
    return sx32(r);
  }
  const sA = s64(a), sB = s64(b);
  switch (op) {
    case 'MUL': return u64(a * b);
    case 'MULH': return u64((sA * sB) >> 64n);
    case 'MULHSU': return u64((sA * b) >> 64n);
    case 'MULHU': return u64((a * b) >> 64n);
    case 'DIV': return b === 0n ? u64(-1n) : (a === 1n << 63n && b === u64(-1n)) ? a : u64(sA / sB);
    case 'DIVU': return b === 0n ? u64(-1n) : a / b;
    case 'REM': return b === 0n ? a : (a === 1n << 63n && b === u64(-1n)) ? 0n : u64(sA % sB);
    case 'REMU': return b === 0n ? a : a % b;
    default: return 0n;
  }
}

// ---------------------------------------------------------------- BranchComparator
export function branchComparator(f3, a, b) {
  switch (f3) {
    case 0: return a === b;
    case 1: return a !== b;
    case 4: return s64(a) < s64(b);
    case 5: return !(s64(a) < s64(b));
    case 6: return a < b;
    case 7: return !(a < b);
    default: return false;
  }
}

// ---------------------------------------------------------------- Load / Store Control
export function loadControl(f3, addr, dword) {
  const off = BigInt(Number(addr & 7n));
  const byte = (dword >> (8n * off)) & 0xffn;
  const half = (dword >> (16n * (off >> 1n))) & 0xffffn;
  const word = (dword >> (32n * (off >> 2n))) & 0xffffffffn;
  switch (f3) {
    case 0: return u64(BigInt.asIntN(8, byte));
    case 1: return u64(BigInt.asIntN(16, half));
    case 2: return u64(BigInt.asIntN(32, word));
    case 3: return dword;
    case 4: return byte;
    case 5: return half;
    case 6: return word;
    default: return 0n;
  }
}
export function storeControl(f3, addr, value) {
  const off = Number(addr & 7n);
  switch (f3) {
    case 0: return { mask: 1 << off, data: (value & 0xffn) << BigInt(8 * off) };
    case 1: { const h = off >> 1; return { mask: 0b11 << (2 * h), data: (value & 0xffffn) << BigInt(16 * h) }; }
    case 2: { const w = off >> 2; return { mask: w ? 0xf0 : 0x0f, data: (value & 0xffffffffn) << BigInt(32 * w) }; }
    case 3: return { mask: 0xff, data: value };
    default: return { mask: 0, data: 0n };
  }
}

// ---------------------------------------------------------------- GSharePredictor
export class GShare {
  constructor(historyBits = DEFAULT_HISTORY_BITS, enabled = true) {
    this.historyBits = historyBits; this.enabled = enabled;
    this.mask = (1 << historyBits) - 1;
    this.pht = new Uint8Array(1 << historyBits).fill(2); // reset: every counter weakly taken (2'b10)
    this.ghr = 0;
  }
  index(pc) { return ((pc >>> 2) & this.mask) ^ this.ghr; } // FETCH_PC[HISTORY_BITS+1:2] ^ GLOBAL_HISTORY_REGISTER
  predict(pc) { const idx = this.index(pc), counter = this.pht[idx]; return { idx, counter, taken: this.enabled && counter >= 2, ghr: this.ghr, pcBits: (pc >>> 2) & this.mask }; }
  train(idx, taken) { const c = this.pht[idx]; this.pht[idx] = taken ? Math.min(3, c + 1) : Math.max(0, c - 1); return { idx, before: c, after: this.pht[idx] }; }
}

const BUBBLE = cause => ({ valid: false, cause });

// ---------------------------------------------------------------- the core
export class Core {
  // opts.bp: false = always predict not taken; opts.historyBits: GSHARE_HISTORY_BITS
  // devices (optional): { load(address) -> value, store(address, value, mask) } answers the device page
  // 0x1000_0000 .. 0x1000_00FF the way fpga/rtl/Sixfold_System.sv does (the site's FPGA console uses it).
  // Without it, device loads read 0, like the simulation testbench. resetPc: the RESET_VECTOR input.
  constructor(image, { bp = true, historyBits = DEFAULT_HISTORY_BITS, btb = true, ras = true, preciseStall = true, iterativeMdu = true, tournament = true, caches = true, missLatency = 10, devices = null, resetPc = RESET_PC } = {}) {
    this.opts = { bp, historyBits, btb, ras, preciseStall, iterativeMdu, tournament, caches, missLatency, devices, resetPc };
    this.bht = new Uint8Array(128).fill(2); // TournamentChooser: per-branch history table (weakly taken)
    this.chooser = new Uint8Array(128).fill(1); // ... and chooser (weakly trust the BHT)
    // 2-way set-associative: slot = way * 64 + set (64 sets x 2 ways), one LRU bit per set
    const cache = () => ({ valid: new Uint8Array(128), tag: new Uint32Array(128), lru: new Uint8Array(64), busy: false, left: 0, line: 0, demand: false, pf: false, pfLine: 0 });
    this.icache = cache(); this.dcache = cache();
    this.btb = Array.from({ length: 16 }, () => ({ valid: false, tag: 0, target: 0, isJal: false }));
    this.ras = { stack: new Array(8).fill(0n), top: 0 };
    this.mdu = { state: 'IDLE', left: 0 };
    this.mem = new Uint8Array(65536);
    this.mem.set((image.bytes || image).slice(0, 65536)); // absolute addresses: code starts at RESET_PC
    this.regs = new Array(32).fill(0n);
    this.bp = new GShare(historyBits, bp);
    this.csr = { tohost: 0n, status: 0n, cycle: 0n, instret: 0n, mstatus: 0n, mtvec: 0n, mscratch: 0n, mepc: 0n, mcause: 0n, mie: 0n };
    this.hpm = { stall: 0n, flush: 0n, redirect: 0n, busy: 0n, imiss: 0n, dmiss: 0n, intr: 0n };
    this.mtime = 0n; this.mtimecmp = (1n << 64n) - 1n; // the machine timer device
    this.mip = { timer: false, external: false }; // the interrupt lines as the CSR file registered them
    this.F1PC = resetPc;
    this.f2 = BUBBLE('fill'); this.d = BUBBLE('fill'); this.e = BUBBLE('fill'); this.m = BUBBLE('fill'); this.w = BUBBLE('fill');
    this.cycle = 0; this.halted = false; this.output = ''; this.leds = 0; this.display = 0;
    this.instrs = []; this.nextId = 0;
    this.stats = { cycles: 0, retired: 0, loadStalls: 0, falseLoadStalls: 0, flushes: 0, mispredicts: 0, jalrFlushes: 0,
      redirects: 0, branches: 0, predictedTaken: 0, forwards: 0, btbRedirects: 0, returnsPredicted: 0, multiplyDivideBusy: 0,
      icacheMisses: 0, dcacheMisses: 0, choseGshare: 0,
      interrupts: 0, bubbles: { fill: 0, loaduse: 0, flush: 0, redirect: 0, muldiv: 0, imiss: 0, dmiss: 0, interrupt: 0 } };
  }

  cacheSlot(c, addr) { // way * 64 + set of the line holding addr, or -1 (InstructionCache / DataCache lookup)
    const a = typeof addr === 'bigint' ? addr : BigInt(addr >>> 0);
    if (a >> 32n) return -1;
    const set = Number((a >> 5n) & 63n), tag = Number((a >> 11n) & 0x1fffffn);
    for (const way of [0, 1]) if (c.valid[way * 64 + set] && c.tag[way * 64 + set] === tag) return way * 64 + set;
    return -1;
  }
  cacheHit(c, addr) { return this.cacheSlot(c, addr) >= 0; }
  victimSlot(c, line) { // an empty way first, otherwise the least recently used one
    const set = (line >>> 5) & 63;
    const way = !c.valid[set] ? 0 : !c.valid[64 + set] ? 1 : c.lru[set];
    return way * 64 + set;
  }
  touch(c, slot) { if (slot >= 0) c.lru[slot & 63] = slot < 64 ? 1 : 0; } // the other way becomes least recently used
  install(c) { // uses the victim chosen at the START of the cycle (before this cycle's LRU updates), like the RTL
    const slot = c.victim >= 0 ? c.victim : this.victimSlot(c, c.line), set = slot & 63;
    c.valid[slot] = 1; c.tag[slot] = (c.line >>> 11) & 0x1fffff; c.lru[set] = slot < 64 ? 1 : 0;
  }
  refill(c, missing, addr) { // one clock edge of the DataCache refill engine
    if (!c.busy) { if (missing) { c.busy = true; c.left = this.opts.missLatency; c.line = Number(BigInt.asUintN(32, (typeof addr === 'bigint' ? addr : BigInt(addr >>> 0))) & ~31n); return true; } }
    else if (c.left === 1) { c.busy = false; this.install(c); }
    else c.left--;
    return false;
  }
  irefill(missing, pc) { return this.prefetchingRefill(this.icache, missing, pc); }
  prefetchingRefill(c, missing, addr, storing = false) { // a refill engine with next-line prefetch (InstructionCache and DataCache)
    if (!c.busy) {
      if (missing) { c.busy = true; c.left = this.opts.missLatency; c.line = Number(BigInt.asUintN(32, (typeof addr === 'bigint' ? addr : BigInt(addr >>> 0))) & ~31n); c.demand = true; return true; }
      if (c.pf) { c.pf = false; if (!this.cacheHit(c, c.pfLine)) { c.busy = true; c.left = this.opts.missLatency; c.line = c.pfLine; c.demand = false; this.stats.prefetches = (this.stats.prefetches || 0) + 1; if (c === this.dcache) this.stats.dprefetches = (this.stats.dprefetches || 0) + 1; } }
    } else if (c.left === 1) {
      if (storing) return false; // DataCache: a store this cycle goes first, the line installs next cycle
      c.busy = false; this.install(c);
      if (c.demand) { c.pf = true; c.pfLine = (c.line + 32) >>> 0; }
    } else c.left--;
    return false;
  }
  fetch(pc) { const m = this.mem, a = pc & 0xffff; return (m[a] | (m[(a + 1) & 0xffff] << 8) | (m[(a + 2) & 0xffff] << 16) | (m[(a + 3) & 0xffff] << 24)) >>> 0; }
  readDouble(addr) {
    if (addr === MMIO_MTIME) return this.mtime;
    if (addr === MMIO_MTIMECMP) return this.mtimecmp;
    if (isMmio(addr)) return this.opts.devices ? BigInt.asUintN(64, BigInt(this.opts.devices.load(addr))) : 0n; // devices read 0 in simulation
    const base = Number(addr & 0xfff8n); let v = 0n;
    for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(this.mem[(base + k) & 0xffff]);
    return v;
  }
  csrRead(addr) {
    switch (addr) {
      case CSR.TOHOST: return this.csr.tohost;
      case CSR.STATUS: return this.csr.status;
      case CSR.CYCLE: return this.csr.cycle;
      case CSR.INSTRET: return this.csr.instret;
      case 0xC03: case 0xC04: case 0xC05: case 0xC06: case 0xC07: case 0xC08: case 0xC09: return this.hpm[HPM[addr]];
      case CSR.MIE: return this.csr.mie;
      case CSR.MIP: return (this.mip.timer ? 0x80n : 0n) | (this.mip.external ? 0x800n : 0n);
      case CSR.MSTATUS: return this.csr.mstatus;
      case CSR.MTVEC: return this.csr.mtvec;
      case CSR.MSCRATCH: return this.csr.mscratch;
      case CSR.MEPC: return this.csr.mepc;
      case CSR.MCAUSE: return this.csr.mcause;
      default: return 0n; // HARTID, MHARTID and unknown CSRs read 0
    }
  }
  instr(id, pc, word) {
    if (!this.instrs[id]) { const d = decode(word); this.instrs[id] = { id, pc, word, text: word === 0 ? '(empty memory, not code)' : disasm(d, pc), fetchCycle: this.cycle, squashed: false }; }
    return this.instrs[id];
  }

  // Advance one clock cycle. Returns an event record describing the cycle.
  step() {
    if (this.halted) return null;
    this.cycle++;
    const ev = { cycle: this.cycle, stages: {}, fwd: {}, squashed: [] };
    const { f2, d, e, m, w } = this;

    // ================= WRITEBACK =================
    const HALT_NOW = w.valid && w.writesTohost && this.csr.tohost !== 0n;
    if (w.valid) ev.stages.WRITEBACK = { id: w.id, pc: w.pc };
    const rfWrite = (w.valid && w.regWrite && w.rd !== 0) ? { rd: w.rd, value: w.data } : null;
    if (rfWrite) ev.rfWrite = rfWrite;

    // ================= MEMORY =================
    let fwdM = 0n;
    if (m.valid) {
      const loadData = loadControl(m.funct3, m.result, m.dcData);
      fwdM = [m.result, loadData, m.pc4, m.csrData][m.wbSel];
      ev.stages.MEMORY = { id: m.id, pc: m.pc };
      if (m.memRead) ev.memAccess = { kind: 'load', addr: m.result, value: loadData, dword: m.dcData, funct3: m.funct3 };
    }

    // ================= EXECUTE =================
    let FLUSH = false, adjust = 0, fwdE = 0n, exNext = null, storeOp = null, csrWrite = null, bpTrain = null, restoreGhr = null, btbWrite = null, MDU_STALL = false, mduSteps = 0;
    let dReq = false, dHit = true, dAddr = 0n, D_STALL = false, trap = null, mret = false, dStoreSlot = -1;
    if (e.valid && e.isInterrupt) { // the interrupt pseudo-instruction: trap to mtvec, retire nothing (src/Riscv64.sv)
      FLUSH = true; adjust = Number(this.csr.mtvec & 0xfffffffcn);
      trap = { pc: e.pc, cause: e.external ? CAUSE_EXTERNAL_INTERRUPT : CAUSE_TIMER_INTERRUPT };
      ev.trap = { kind: e.external ? 'external interrupt' : 'timer interrupt', to: adjust }; ev.interrupt = true;
      restoreGhr = e.ckpt;
      ev.stages.EXECUTE = { id: e.id, pc: e.pc };
    } else if (e.valid) {
      const A = e.aIsPC ? BigInt(e.pc) : prepareA(e.rs1v, e), B = prepareB(e.bIsImm ? e.imm : e.rs2v, e);
      const aluOut = alu(A, B, e.aluOp, e.isWord);
      const result = e.isMulDiv ? multiplyDivide(e.rs1v, e.rs2v, e.aluOp, e.isWord) : aluOut;
      const pc4 = u64(BigInt(e.pc) + 4n);
      const jalrTarget = aluOut & ~1n;
      const taken = branchComparator(e.funct3, e.rs1v, e.rs2v);
      // BranchControl
      adjust = Number(pc4 & 0xffffffffn);
      if (e.isBranch) {
        adjust = taken ? e.target : adjust; FLUSH = taken !== e.pred;
        bpTrain = { idx: e.idx, taken, pc: e.pc, g: e.gTaken, b: e.bTaken };
        ev.resolve = { kind: 'branch', predicted: e.pred, actual: taken, mispredict: FLUSH, target: e.target };
      } else if (e.isJal) {
        adjust = e.target; ev.resolve = { kind: 'jal', predicted: true, actual: true, mispredict: false, target: e.target };
      } else if (e.isJalr) {
        adjust = Number(jalrTarget & 0xffffffffn);
        const right = !!e.returnPredicted && BigInt(e.target) === (e.rs1v & ~1n); // returns have offset 0: compare with rs1
        FLUSH = !right;
        ev.resolve = { kind: 'jalr', predicted: !!e.returnPredicted, actual: true, mispredict: !right, target: adjust };
        if (right) this.stats.returnsPredicted++;
      }
      if (e.isEcall || e.isEbreak) { FLUSH = true; adjust = Number(this.csr.mtvec & 0xfffffffcn); trap = { pc: e.pc, cause: e.isEbreak ? 3n : 11n }; ev.trap = { kind: e.isEbreak ? 'ebreak' : 'ecall', to: adjust }; }
      else if (e.isMret) { FLUSH = true; adjust = Number(this.csr.mepc & 0xffffffffn); mret = true; ev.trap = { kind: 'mret', to: adjust }; }
      if (FLUSH) restoreGhr = e.isBranch ? ((e.ckpt << 1) | (taken ? 1 : 0)) & this.bp.mask : e.ckpt;
      if (this.opts.btb && ((e.isBranch && taken) || e.isJal)) btbWrite = { idx: (e.pc >>> 2) & 15, tag: (e.pc >>> 6) & 0x3ffffff, target: e.target >>> 0, isJal: !!e.isJal };
      if (e.memRead && this.opts.caches) { dReq = true; dHit = this.cacheHit(this.dcache, result); dAddr = result; D_STALL = !dHit; ev.dcacheAccess = { addr: Number(result & 0xffffffffn), hit: dHit }; }
      if (e.isMulDiv && this.opts.iterativeMdu) { MDU_STALL = this.mdu.state !== 'DONE'; mduSteps = multiplyDivideSteps(e.aluOp, !!e.isWord, e.rs1v); }
      const csrData = this.csrRead(e.csrAddr);
      fwdE = [result, 0n, pc4, csrData][e.wbSel];
      if (e.csrWrite) {
        const src = e.csrImm ? BigInt(bits(e.word, 19, 15)) : e.rs1v, f3 = e.funct3;
        const nv = (f3 === 2 || f3 === 6) ? (csrData | src) : (f3 === 3 || f3 === 7) ? (csrData & u64(~src)) : src;
        csrWrite = { addr: e.csrAddr, value: nv };
        ev.csrWrite = csrWrite;
      }
      if (e.memWrite) { const s = storeControl(e.funct3, result, e.rs2v); storeOp = { addr: result, ...s }; if (this.opts.caches) dStoreSlot = this.cacheSlot(this.dcache, result); ev.memAccess = { kind: 'store', addr: result, value: e.rs2v, mask: s.mask, funct3: e.funct3 }; }
      exNext = { valid: true, id: e.id, pc: e.pc, rd: e.rd, regWrite: e.regWrite, memRead: e.memRead, funct3: e.funct3, result, pc4, csrData,
        wbSel: e.wbSel, dcData: this.readDouble(result), writesTohost: !!(e.csrWrite && e.csrAddr === CSR.TOHOST) };
      ev.stages.EXECUTE = { id: e.id, pc: e.pc };
      ev.alu = { a: A, b: B, result, op: e.aluOp, unit: e.isMulDiv ? 'MDU' : 'ALU', word: !!e.isWord };
    }

    // ================= DECODE =================
    const dw = d.valid ? d.word : 0;
    const rs1f = bits(dw, 19, 15), rs2f = bits(dw, 24, 20), rdf = bits(dw, 11, 7);
    const forward = (r) => {
      if (r === 0) return [0n, null];
      if (e.valid && e.regWrite && !e.memRead && !e.late && e.rd !== 0 && e.rd === r) return [fwdE, 'EXECUTE']; // loads and cpop forward from MEMORY
      if (m.valid && m.regWrite && m.rd !== 0 && m.rd === r) return [fwdM, 'MEMORY'];
      if (w.valid && w.regWrite && w.rd !== 0 && w.rd === r) return [w.data, 'WRITEBACK'];
      return [this.regs[r], null];
    };
    const useD = usesRegisters(dw), exact = this.opts.preciseStall;
    // Zbs bset / bclr / binv whose bit number comes from EXECUTE wait one cycle (src/Riscv64.sv SINGLE_BIT_HAZARD)
    const ctlD = d.valid ? control(dw) : null;
    const SINGLE_BIT_STALL = !!(d.valid && e.valid && ctlD.oneB && !ctlD.bIsImm && e.regWrite && !e.memRead && !e.late && e.rd !== 0 && e.rd === rs2f);
    const LOAD_STALL = (d.valid && e.valid && (!!e.memRead || !!e.late) && e.rd !== 0 && ((e.rd === rs1f && (!exact || useD.rs1)) || (e.rd === rs2f && (!exact || useD.rs2)))) || SINGLE_BIT_STALL;
    let deNext = null;
    if (d.valid) {
      ev.stages.DECODE = { id: d.id, pc: d.pc };
      const c = control(d.word);
      const [v1, s1] = forward(rs1f), [v2, s2] = forward(rs2f);
      const use = usesRegs(decode(d.word));
      ev.fwd = { a: use.rs1 ? s1 : null, b: use.rs2 ? s2 : null, rs1: rs1f, rs2: rs2f };
      deNext = { valid: true, id: d.id, pc: d.pc, word: d.word, ...c, rs1v: v1, rs2v: v2, imm: immediate(d.word, c.immType), rd: rdf,
        funct3: bits(d.word, 14, 12), csrAddr: bits(d.word, 31, 20), pred: d.pred, idx: d.idx, ckpt: d.ckpt, target: d.target,
        returnPredicted: d.returnPredicted, isCall: d.isCall, isReturn: d.isReturn, rasCkpt: d.rasCkpt, gTaken: d.gTaken, bTaken: d.bTaken };
      if (LOAD_STALL) ev.loadStallReal = SINGLE_BIT_STALL || (useD.rs1 && e.rd === rs1f) || (useD.rs2 && e.rd === rs2f);
    }

    // Interrupt: replace the DECODE instruction (src/Riscv64.sv DECODE_TAKES_INTERRUPT)
    const mieBit = (this.csr.mstatus >> 3n) & 1n, INTERRUPT_EXTERNAL = !!((this.csr.mie >> 11n) & 1n) && this.mip.external;
    const INTERRUPT_REQUEST = mieBit === 1n && ((!!((this.csr.mie >> 7n) & 1n) && this.mip.timer) || INTERRUPT_EXTERNAL);

    // ================= FETCH2 =================
    let REDIRECT = false, f2Target = 0, f2IsBranch = false, f2Call = false, f2Return = false, f2ReturnPredicted = false;
    if (f2.valid) {
      const op = f2.word & 0x7f, isJal = op === OPC.JAL, isJalr = op === OPC.JALR;
      const rdF = bits(f2.word, 11, 7), rs1F = bits(f2.word, 19, 15);
      f2IsBranch = op === OPC.BRANCH;
      f2Call = (isJal || isJalr) && (rdF === 1 || rdF === 5);
      f2Return = isJalr && rdF === 0 && (rs1F === 1 || rs1F === 5) && bits(f2.word, 31, 20) === 0;
      f2ReturnPredicted = this.opts.ras && f2Return;
      const imm = isJal ? immediate(f2.word, 'J') : immediate(f2.word, 'B');
      f2Target = f2ReturnPredicted ? Number(this.ras.stack[this.ras.top] & 0xffffffffn) : Number(u64(BigInt(f2.pc) + imm) & 0xffffffffn);
      REDIRECT = (isJal || (f2IsBranch && f2.pred) || f2ReturnPredicted) && !f2.btbRedirected;
      ev.stages.FETCH2 = { id: f2.id, pc: f2.pc };
      if (f2IsBranch || isJal || f2ReturnPredicted) ev.predecode = { kind: isJal ? 'jal' : f2IsBranch ? 'branch' : 'return', predicted: REDIRECT || !!f2.btbRedirected, byBtb: !!f2.btbRedirected, target: f2Target, idx: f2.idx, counter: f2.counter };
    }

    // ================= FETCH1 =================
    const word = this.fetch(this.F1PC);
    const pred = this.bp.predict(this.F1PC);
    const gTaken = pred.taken, tIdx = (this.F1PC >>> 2) & 127;
    const bTaken = this.bp.enabled && this.bht[tIdx] >= 2, useG = this.chooser[tIdx] >= 2;
    if (this.opts.tournament) { pred.taken = useG ? gTaken : bTaken; pred.chooser = useG ? 'gshare' : 'bht'; }
    const iHit = !this.opts.caches || this.cacheHit(this.icache, this.F1PC);
    ev.icacheHit = iHit;
    const be = this.btb[(this.F1PC >>> 2) & 15];
    const btbHit = be.valid && be.tag === ((this.F1PC >>> 6) & 0x3ffffff);
    const F1_BTB_REDIRECT = this.opts.btb && iHit && btbHit && (be.isJal || pred.taken);
    const f1Next = !iHit ? this.F1PC : F1_BTB_REDIRECT ? be.target : (this.F1PC + 4) >>> 0;
    ev.btb = { hit: btbHit, redirect: F1_BTB_REDIRECT, target: btbHit ? be.target : null };
    const f1Id = this.nextId;
    this.instr(f1Id, this.F1PC, word);
    ev.stages.FETCH1 = { id: f1Id, pc: this.F1PC };
    ev.predict = pred;

    const ADVANCE = !FLUSH && !D_STALL && !LOAD_STALL && !MDU_STALL;
    const TAKE_INTERRUPT = INTERRUPT_REQUEST && d.valid && ADVANCE && !(e.valid && (e.csrWrite || e.isEcall || e.isEbreak || e.isMret || e.isInterrupt));
    ev.stall = LOAD_STALL && !FLUSH && !D_STALL;
    ev.busy = MDU_STALL && !FLUSH;
    ev.dmiss = D_STALL && !FLUSH;
    ev.imiss = ADVANCE && !REDIRECT && !iHit;
    ev.flush = FLUSH;
    ev.redirect = REDIRECT && ADVANCE;
    ev.ghr = this.bp.ghr;

    // ================= the clock edge =================
    if (HALT_NOW) { // only the Writeback instruction finishes; everything else freezes
      if (rfWrite) this.regs[rfWrite.rd] = rfWrite.value;
      this.stats.retired++; this.stats.cycles = this.cycle;
      this.halted = true; ev.halt = true;
      return ev;
    }
    if (rfWrite) this.regs[rfWrite.rd] = rfWrite.value;
    if (w.valid) this.stats.retired++; else this.stats.bubbles[w.cause]++;
    if (storeOp && storeOp.mask) {
      if (storeOp.addr === MMIO_PUTCHAR) { this.output += String.fromCharCode(Number(storeOp.data & 0xffn)); ev.putchar = true; }
      else if ((storeOp.addr & ~7n) === MMIO_LEDS && (storeOp.mask & 3)) { this.leds = mergeBytes(this.leds, storeOp, 2); ev.leds = this.leds; }
      else if ((storeOp.addr & ~7n) === MMIO_DISPLAY && (storeOp.mask & 15)) { this.display = mergeBytes(this.display, storeOp, 4); ev.display = this.display; }
      else if (isMmio(storeOp.addr)) { /* other device addresses: only the devices hook sees them */ }
      if (isMmio(storeOp.addr)) { if (this.opts.devices) this.opts.devices.store(storeOp.addr, storeOp.data, storeOp.mask); }
      else { const base = Number(storeOp.addr & 0xfff8n); for (let k = 0; k < 8; k++) if (storeOp.mask & (1 << k)) this.mem[(base + k) & 0xffff] = Number((storeOp.data >> BigInt(8 * k)) & 0xffn); }
    }
    if (storeOp && storeOp.mask && storeOp.addr === MMIO_MTIMECMP) { let v = this.mtimecmp; for (let k = 0; k < 8; k++) if (storeOp.mask & (1 << k)) { const sh = BigInt(8 * k); v = (v & ~(0xffn << sh)) | (storeOp.data & (0xffn << sh)); } this.mtimeCmpNext = v; }
    // the CSR file registers the interrupt lines from this cycle's timer values; then the timer ticks
    this.mip.timer = this.mtime >= this.mtimecmp;
    this.mip.external = !!(this.opts.devices && this.opts.devices.externalInterrupt && this.opts.devices.externalInterrupt());
    this.mtime++;
    if (this.mtimeCmpNext !== undefined) { this.mtimecmp = this.mtimeCmpNext; this.mtimeCmpNext = undefined; }
    if (trap) { this.csr.mepc = BigInt(trap.pc) & ~1n; this.csr.mcause = trap.cause; const mie = (this.csr.mstatus >> 3n) & 1n; this.csr.mstatus = (this.csr.mstatus & ~0x88n) | (mie << 7n); this.stats.traps = (this.stats.traps || 0) + 1; }
    else if (mret) { const mpie = (this.csr.mstatus >> 7n) & 1n; this.csr.mstatus = (this.csr.mstatus & ~0x88n) | (mpie << 3n) | 0x80n; }
    if (csrWrite) {
      const v = csrWrite.value, a = csrWrite.addr, c = this.csr;
      if (a === CSR.TOHOST) c.tohost = v; else if (a === CSR.STATUS) c.status = v; else if (a === CSR.MSTATUS) c.mstatus = v;
      else if (a === CSR.MTVEC) c.mtvec = v; else if (a === CSR.MSCRATCH) c.mscratch = v; else if (a === CSR.MEPC) c.mepc = v & ~1n; else if (a === CSR.MCAUSE) c.mcause = v;
      else if (a === CSR.MIE) c.mie = v;
    }
    this.csr.cycle++; if (w.valid) this.csr.instret++;
    if (ev.interrupt) ev.intr = true;
    for (const k of ['stall', 'flush', 'redirect', 'busy', 'imiss', 'dmiss', 'intr']) if (ev[k]) this.hpm[k]++; // performance counters (CSRFile EventCounter)
    if (bpTrain) {
      ev.bpUpdate = { ...this.bp.train(bpTrain.idx, bpTrain.taken), taken: bpTrain.taken }; this.stats.branches++;
      if (this.opts.tournament) {
        const i = (bpTrain.pc >>> 2) & 127, t = bpTrain.taken, gOk = bpTrain.g === t, bOk = bpTrain.b === t;
        this.bht[i] = t ? Math.min(3, this.bht[i] + 1) : Math.max(0, this.bht[i] - 1);
        if (gOk && !bOk) this.chooser[i] = Math.min(3, this.chooser[i] + 1); else if (bOk && !gOk) this.chooser[i] = Math.max(0, this.chooser[i] - 1);
      }
    }
    if (this.opts.caches) {
      for (const c of [this.icache, this.dcache]) c.victim = c.busy && c.left === 1 ? this.victimSlot(c, c.line) : -1; // REFILL_VICTIM_WAY from the current LRU state
      if (iHit) this.touch(this.icache, this.cacheSlot(this.icache, this.F1PC)); // LRU first, the install below wins
      if (dReq && dHit) this.touch(this.dcache, this.cacheSlot(this.dcache, dAddr));
      if (storeOp && storeOp.mask && dStoreSlot >= 0) this.touch(this.dcache, dStoreSlot);
      if (this.irefill(!iHit, this.F1PC)) this.stats.icacheMisses++;
      if (this.prefetchingRefill(this.dcache, dReq && !dHit, dAddr, !!(storeOp && storeOp.mask))) this.stats.dcacheMisses++;
    }
    const rasTopBefore = this.ras.top; // DECODE_RAS_CHECKPOINT: the pointer BEFORE this cycle's push or pop
    if (btbWrite) Object.assign(this.btb[btbWrite.idx], { valid: true, tag: btbWrite.tag, target: btbWrite.target, isJal: btbWrite.isJal });
    if (this.opts.ras) {
      if (FLUSH) this.ras.top = (e.rasCkpt + (e.isCall ? 1 : 0) - (e.isReturn ? 1 : 0) + 8) & 7;
      else if (ADVANCE && f2.valid && f2Call) { this.ras.top = (this.ras.top + 1) & 7; this.ras.stack[this.ras.top] = BigInt((f2.pc + 4) >>> 0); }
      else if (ADVANCE && f2.valid && f2Return) this.ras.top = (this.ras.top + 7) & 7;
    }
    if (this.opts.iterativeMdu) {
      const m = this.mdu;
      if (m.state === 'IDLE') { if (e.valid && e.isMulDiv) { m.state = 'PREPARE'; m.left = mduSteps; } }
      else if (m.state === 'PREPARE') m.state = 'BUSY';
      else if (m.state === 'BUSY') { if (m.left === 1) m.state = 'SIGN'; m.left--; }
      else if (m.state === 'SIGN') m.state = 'DONE';
      else m.state = 'IDLE';
    }
    if (FLUSH) { this.bp.ghr = restoreGhr; ev.ghrRestore = restoreGhr; }
    else if (ADVANCE && f2.valid && f2IsBranch) { this.bp.ghr = ((this.bp.ghr << 1) | (f2.pred ? 1 : 0)) & this.bp.mask; ev.ghrShift = f2.pred ? 1 : 0; }

    // statistics
    if (ev.stall) { this.stats.loadStalls++; if (!ev.loadStallReal) this.stats.falseLoadStalls++; }
    if (FLUSH) { this.stats.flushes++; if (e.isJalr) this.stats.jalrFlushes++; else if (!(e.isEcall || e.isEbreak || e.isMret || e.isInterrupt)) this.stats.mispredicts++; }
    if (ev.interrupt) this.stats.interrupts++;
    if (ev.redirect) this.stats.redirects++;
    if (ev.busy) this.stats.multiplyDivideBusy++;
    if (ADVANCE && !REDIRECT && F1_BTB_REDIRECT) this.stats.btbRedirects++;

    // pipeline registers
    this.w = m.valid ? { valid: true, id: m.id, pc: m.pc, rd: m.rd, regWrite: m.regWrite, data: fwdM, writesTohost: m.writesTohost } : BUBBLE(m.cause);
    this.m = exNext || BUBBLE(e.cause);
    const squash = (id) => { const i = this.instrs[id]; if (i && !i.squashed) { i.squashed = true; ev.squashed.push(id); } };
    if (FLUSH) {
      this.e = BUBBLE('flush');
      if (d.valid) squash(d.id);
      if (f2.valid) squash(f2.id);
      squash(f1Id); this.nextId++;
      this.d = BUBBLE('flush'); this.f2 = BUBBLE('flush');
      this.F1PC = adjust >>> 0;
    } else if (D_STALL) {
      this.m = BUBBLE('dmiss'); // the load waits in Execute for its cache line
    } else if (LOAD_STALL) {
      this.e = BUBBLE('loaduse');
    } else if (MDU_STALL) {
      this.m = BUBBLE('muldiv'); // Execute holds the M instruction; Memory gets a bubble
    } else {
      if (deNext && TAKE_INTERRUPT) { // the interrupt takes the DECODE instruction's place; that one runs after mret
        this.e = { valid: true, id: d.id, pc: d.pc, isInterrupt: 1, external: INTERRUPT_EXTERNAL, cause: 'interrupt', ckpt: d.ckpt, rasCkpt: d.rasCkpt, isCall: false, isReturn: false };
        squash(d.id); ev.interruptTaken = { pc: d.pc, external: INTERRUPT_EXTERNAL };
      } else if (deNext) { this.e = deNext; if (ev.fwd.a) this.stats.forwards++; if (ev.fwd.b) this.stats.forwards++; }
      else this.e = BUBBLE(d.cause);
      this.d = f2.valid ? { valid: true, id: f2.id, pc: f2.pc, word: f2.word, pred: f2.pred, idx: f2.idx, ckpt: ev.ghr, target: f2Target,
        returnPredicted: f2ReturnPredicted, isCall: this.opts.ras && f2Call, isReturn: this.opts.ras && f2Return, rasCkpt: rasTopBefore, gTaken: f2.gTaken, bTaken: f2.bTaken } : BUBBLE(f2.cause);
      if (REDIRECT) { squash(f1Id); this.f2 = BUBBLE('redirect'); this.nextId++; }
      else if (!iHit) { this.f2 = BUBBLE('imiss'); } // same instruction retried next cycle (same id)
      else { this.f2 = { valid: true, id: f1Id, pc: this.F1PC, word, pred: pred.taken, idx: pred.idx, counter: pred.counter, btbRedirected: F1_BTB_REDIRECT, gTaken, bTaken }; this.nextId++; if (pred.chooser === 'gshare') this.stats.choseGshare++; }
      this.F1PC = (REDIRECT ? f2Target : f1Next) >>> 0;
    }
    this.stats.cycles = this.cycle;
    return ev;
  }

  // Run to completion. Returns the array of events (or [] when keepEvents is false).
  run(maxCycles = 2000000, keepEvents = true) {
    const events = [];
    while (!this.halted && this.cycle < maxCycles) { const ev = this.step(); if (keepEvents) events.push(ev); }
    if (!this.halted) throw new Error(`no TOHOST write within ${maxCycles} cycles (does the program end with "halt"?)`);
    return events;
  }

  // Same line format the RTL testbench prints: `make test` diffs the two.
  static traceLine(ev) {
    const f = s => (ev.stages[s] ? (ev.stages[s].pc >>> 0).toString(16).padStart(8, '0') : '--------');
    return `C${ev.cycle} ` + STAGES.map(s => `${SHORT[s]}:${f(s)}`).join(' ') + (ev.stall ? ' STALL' : '') + (ev.flush ? ' FLUSH' : '') + (ev.redirect ? ' REDIRECT' : '') + (ev.busy ? ' BUSY' : '') + (ev.imiss ? ' IMISS' : '') + (ev.dmiss ? ' DMISS' : '');
  }
}
