// =============================================================================
// model/asm.js — a small, readable two-pass RV64IM assembler.
//
//   Pass 1: walk every line, assign an address to every label and instruction.
//   Pass 2: evaluate operands (labels are now known) and call isa.encode().
//
// Output: a byte image (code starts at RESET_PC = 0x2000) plus a
// listing that shows every instruction's address, hex, and BINARY encoding.
//
// Supported directives: .text .data .org .align .byte .half .word .dword
//                       .zero/.space .string/.asciz .ascii .equ/.set .globl
// Supported pseudo-ops: nop li la mv not neg negw sext.w seqz snez sltz sgtz
//                       beqz bnez blez bgez bltz bgtz bgt ble bgtu bleu
//                       j jr ret call tail
//                       csrr csrw csrs csrc csrwi csrsi csrci rdcycle rdinstret
//                       halt  (= csrwi tohost, 1 ; j .   : report PASS and stop)
// The symbol "." means the address of the current instruction. Code starts at 0x2000.
// =============================================================================
import { BY_NAME, encode, regNum, CSR_NAMES } from './isa.js';

export const RESET_PC = 0x2000; // programs start here (src/const_pkg.sv PC_RESET)

const MEM_SIZE = 0x10000;

export function stripComment(line) {
  let out = '', inStr = false, inChr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && !inChr && line[i - 1] !== '\\') inStr = !inStr;
    if (c === "'" && !inStr && line[i - 1] !== '\\') inChr = !inChr;
    if (!inStr && !inChr && (c === '#' || c === ';' || (c === '/' && line[i + 1] === '/'))) break;
    out += c;
  }
  return out.trim();
}

export function splitOperands(s) {
  const out = []; let cur = '', depth = 0, inStr = false;
  for (const c of s) {
    if (c === '"') inStr = !inStr;
    if (!inStr && c === '(') depth++;
    if (!inStr && c === ')') depth--;
    if (c === ',' && depth === 0 && !inStr) { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function unescape(s) {
  return s.replace(/\\(n|t|r|0|\\|"|')/g, (_, c) => ({ n: '\n', t: '\t', r: '\r', 0: '\0', '\\': '\\', '"': '"', "'": "'" }[c]));
}

// Tiny expression evaluator: numbers, 'c', labels, + - * / << >> & | ( ).
// Returns a BigInt.
export function evalExpr(expr, symbols, allowUnknown = false) {
  const toks = expr.match(/0x[0-9a-fA-F_]+|0b[01_]+|\d+|'(?:\\.|[^'])'|<<|>>|[A-Za-z_.$][\w.$]*|[-+*/&|()~^%]/g);
  if (!toks) throw new Error(`bad expression "${expr}"`);
  let i = 0;
  const peek = () => toks[i], next = () => toks[i++];
  function atom() {
    const t = next();
    if (t === undefined) throw new Error(`bad expression "${expr}"`);
    if (t === '(') { const v = orE(); if (next() !== ')') throw new Error(`missing ) in "${expr}"`); return v; }
    if (t === '-') return -atom();
    if (t === '+') return atom();
    if (t === '~') return ~atom();
    if (/^0x/i.test(t)) return BigInt('0x' + t.slice(2).replace(/_/g, ''));
    if (/^0b/i.test(t)) return BigInt('0b' + t.slice(2).replace(/_/g, ''));
    if (/^\d/.test(t)) return BigInt(t);
    if (t[0] === "'") return BigInt(unescape(t.slice(1, -1)).charCodeAt(0));
    if (t in symbols) return BigInt(symbols[t]);
    if (allowUnknown) return 0n;
    throw new Error(`undefined symbol "${t}"`);
  }
  function mul() { let v = atom(); while (['*', '/', '%'].includes(peek())) { const o = next(), r = atom(); v = o === '*' ? v * r : o === '/' ? v / r : v % r; } return v; }
  function add() { let v = mul(); while (['+', '-'].includes(peek())) { const o = next(), r = mul(); v = o === '+' ? v + r : v - r; } return v; }
  function sh() { let v = add(); while (['<<', '>>'].includes(peek())) { const o = next(), r = add(); v = o === '<<' ? v << r : v >> r; } return v; }
  function andE() { let v = sh(); while (peek() === '&') { next(); v &= sh(); } return v; }
  function xorE() { let v = andE(); while (peek() === '^') { next(); v ^= andE(); } return v; }
  function orE() { let v = xorE(); while (peek() === '|') { next(); v |= xorE(); } return v; }
  const v = orE();
  if (i !== toks.length) throw new Error(`bad expression "${expr}"`);
  return v;
}

const fitsI12 = v => v >= -2048n && v <= 2047n;
const fitsI32 = v => v >= -(1n << 31n) && v <= (1n << 31n) - 1n;
const sext12 = v => { v &= 0xfffn; return v >= 0x800n ? v - 0x1000n : v; };

// Expand "li rd, value" into real instructions (same idea LLVM/GCC use).
export function liSequence(rd, value) {
  let v = BigInt.asIntN(64, value);
  if (fitsI12(v)) return [['addi', { rd, rs1: 0, imm: Number(v) }]];
  if (fitsI32(v)) {
    const hi = (v + 0x800n) >> 12n, lo = v - (hi << 12n);
    const seq = [['lui', { rd, imm: Number(hi & 0xfffffn) }]];
    if (lo !== 0n) seq.push(['addiw', { rd, rs1: rd, imm: Number(lo) }]);
    return seq;
  }
  const lo12 = sext12(v);
  let hi = (v - lo12) >> 12n, shift = 12n;
  while ((hi & 1n) === 0n) { hi >>= 1n; shift++; }
  const seq = liSequence(rd, hi);
  seq.push(['slli', { rd, rs1: rd, imm: Number(shift) }]);
  if (lo12 !== 0n) seq.push(['addi', { rd, rs1: rd, imm: Number(lo12) }]);
  return seq;
}

function csrNum(tok) {
  const t = tok.trim().toLowerCase();
  if (t in CSR_NAMES) return CSR_NAMES[t];
  return Number(evalExpr(t, {}));
}

function parseMem(op) {  // "off(reg)" or "(reg)"
  const m = op.match(/^(.*)\(\s*([\w]+)\s*\)$/);
  if (!m) throw new Error(`expected offset(register), got "${op}"`);
  return { off: m[1].trim() || '0', reg: regNum(m[2]) };
}

// Expand one source line (mnemonic + operand strings) into base instructions.
// Each result: [name, fieldsFn(symbols, pc) -> {rd,rs1,rs2,imm}]
function expand(mn, ops, symbolsPass1) {
  const E = (s, sym) => evalExpr(s, sym);
  const rel = (s) => (sym, pc) => Number(E(s, sym) - BigInt(pc));
  const one = (name, f) => [[name, f]];
  const need = n => { if (ops.length !== n) throw new Error(`${mn} expects ${n} operand(s), got ${ops.length}`); };
  switch (mn) {
    case 'nop': return one('addi', () => ({ rd: 0, rs1: 0, imm: 0 }));
    case 'mv': need(2); return one('addi', () => ({ rd: regNum(ops[0]), rs1: regNum(ops[1]), imm: 0 }));
    case 'not': need(2); return one('xori', () => ({ rd: regNum(ops[0]), rs1: regNum(ops[1]), imm: -1 }));
    case 'neg': need(2); return one('sub', () => ({ rd: regNum(ops[0]), rs1: 0, rs2: regNum(ops[1]) }));
    case 'negw': need(2); return one('subw', () => ({ rd: regNum(ops[0]), rs1: 0, rs2: regNum(ops[1]) }));
    case 'sext.w': need(2); return one('addiw', () => ({ rd: regNum(ops[0]), rs1: regNum(ops[1]), imm: 0 }));
    case 'seqz': need(2); return one('sltiu', () => ({ rd: regNum(ops[0]), rs1: regNum(ops[1]), imm: 1 }));
    case 'snez': need(2); return one('sltu', () => ({ rd: regNum(ops[0]), rs1: 0, rs2: regNum(ops[1]) }));
    case 'sltz': need(2); return one('slt', () => ({ rd: regNum(ops[0]), rs1: regNum(ops[1]), rs2: 0 }));
    case 'sgtz': need(2); return one('slt', () => ({ rd: regNum(ops[0]), rs1: 0, rs2: regNum(ops[1]) }));
    case 'beqz': need(2); return one('beq', (s, pc) => ({ rs1: regNum(ops[0]), rs2: 0, imm: rel(ops[1])(s, pc) }));
    case 'bnez': need(2); return one('bne', (s, pc) => ({ rs1: regNum(ops[0]), rs2: 0, imm: rel(ops[1])(s, pc) }));
    case 'blez': need(2); return one('bge', (s, pc) => ({ rs1: 0, rs2: regNum(ops[0]), imm: rel(ops[1])(s, pc) }));
    case 'bgez': need(2); return one('bge', (s, pc) => ({ rs1: regNum(ops[0]), rs2: 0, imm: rel(ops[1])(s, pc) }));
    case 'bltz': need(2); return one('blt', (s, pc) => ({ rs1: regNum(ops[0]), rs2: 0, imm: rel(ops[1])(s, pc) }));
    case 'bgtz': need(2); return one('blt', (s, pc) => ({ rs1: 0, rs2: regNum(ops[0]), imm: rel(ops[1])(s, pc) }));
    case 'bgt': need(3); return one('blt', (s, pc) => ({ rs1: regNum(ops[1]), rs2: regNum(ops[0]), imm: rel(ops[2])(s, pc) }));
    case 'ble': need(3); return one('bge', (s, pc) => ({ rs1: regNum(ops[1]), rs2: regNum(ops[0]), imm: rel(ops[2])(s, pc) }));
    case 'bgtu': need(3); return one('bltu', (s, pc) => ({ rs1: regNum(ops[1]), rs2: regNum(ops[0]), imm: rel(ops[2])(s, pc) }));
    case 'bleu': need(3); return one('bgeu', (s, pc) => ({ rs1: regNum(ops[1]), rs2: regNum(ops[0]), imm: rel(ops[2])(s, pc) }));
    case 'j': need(1); return one('jal', (s, pc) => ({ rd: 0, imm: rel(ops[0])(s, pc) }));
    case 'call': need(1); return one('jal', (s, pc) => ({ rd: 1, imm: rel(ops[0])(s, pc) }));
    case 'tail': need(1); return one('jal', (s, pc) => ({ rd: 0, imm: rel(ops[0])(s, pc) }));
    case 'jr': need(1); return one('jalr', () => ({ rd: 0, rs1: regNum(ops[0]), imm: 0 }));
    case 'ret': return one('jalr', () => ({ rd: 0, rs1: 1, imm: 0 }));
    case 'halt': return [['csrrwi', () => ({ rd: 0, rs1: 1, imm: CSR_NAMES.tohost })], ['jal', () => ({ rd: 0, imm: 0 })]];
    case 'csrr': need(2); return one('csrrs', () => ({ rd: regNum(ops[0]), imm: csrNum(ops[1]), rs1: 0 }));
    case 'csrw': need(2); return one('csrrw', () => ({ rd: 0, imm: csrNum(ops[0]), rs1: regNum(ops[1]) }));
    case 'csrs': need(2); return one('csrrs', () => ({ rd: 0, imm: csrNum(ops[0]), rs1: regNum(ops[1]) }));
    case 'csrc': need(2); return one('csrrc', () => ({ rd: 0, imm: csrNum(ops[0]), rs1: regNum(ops[1]) }));
    case 'csrwi': need(2); return one('csrrwi', (s) => ({ rd: 0, imm: csrNum(ops[0]), rs1: Number(E(ops[1], s)) }));
    case 'csrsi': need(2); return one('csrrsi', (s) => ({ rd: 0, imm: csrNum(ops[0]), rs1: Number(E(ops[1], s)) }));
    case 'csrci': need(2); return one('csrrci', (s) => ({ rd: 0, imm: csrNum(ops[0]), rs1: Number(E(ops[1], s)) }));
    case 'rdcycle': need(1); return one('csrrs', () => ({ rd: regNum(ops[0]), imm: CSR_NAMES.cycle, rs1: 0 }));
    case 'rdinstret': need(1); return one('csrrs', () => ({ rd: regNum(ops[0]), imm: CSR_NAMES.instret, rs1: 0 }));
    case 'la': {
      need(2);
      const rd = regNum(ops[0]);
      const hiLo = (s, pc) => { const off = E(ops[1], s) - BigInt(pc); const hi = (off + 0x800n) >> 12n; return { hi, lo: off - (hi << 12n) }; };
      return [['auipc', (s, pc) => ({ rd, imm: Number(hiLo(s, pc).hi & 0xfffffn) })],
              ['addi', (s, pc) => ({ rd, rs1: rd, imm: Number(hiLo(s, pc - 4).lo) })]];
    }
    case 'li': {
      need(2);
      const rd = regNum(ops[0]);
      const v = evalExpr(ops[1], symbolsPass1); // must be a constant (use la for labels)
      return liSequence(rd, v).map(([n, f]) => [n, () => f]);
    }
  }
  const d = BY_NAME[mn];
  if (!d) throw new Error(`unknown instruction "${mn}"`);
  switch (d.syntax) {
    case 'rrr': need(3); return one(mn, () => ({ rd: regNum(ops[0]), rs1: regNum(ops[1]), rs2: regNum(ops[2]) }));
    case 'rri': need(3); return one(mn, (s) => ({ rd: regNum(ops[0]), rs1: regNum(ops[1]), imm: Number(E(ops[2], s)) }));
    case 'rr': need(2); return one(mn, () => ({ rd: regNum(ops[0]), rs1: regNum(ops[1]) }));
    case 'load': need(2); return one(mn, (s) => { const m = parseMem(ops[1]); return { rd: regNum(ops[0]), rs1: m.reg, imm: Number(E(m.off, s)) }; });
    case 'store': need(2); return one(mn, (s) => { const m = parseMem(ops[1]); return { rs2: regNum(ops[0]), rs1: m.reg, imm: Number(E(m.off, s)) }; });
    case 'branch': need(3); return one(mn, (s, pc) => ({ rs1: regNum(ops[0]), rs2: regNum(ops[1]), imm: rel(ops[2])(s, pc) }));
    case 'ui': need(2); return one(mn, (s) => ({ rd: regNum(ops[0]), imm: Number(E(ops[1], s)) }));
    case 'jal':
      if (ops.length === 1) return one(mn, (s, pc) => ({ rd: 1, imm: rel(ops[0])(s, pc) }));
      need(2); return one(mn, (s, pc) => ({ rd: regNum(ops[0]), imm: rel(ops[1])(s, pc) }));
    case 'jalr':
      if (ops.length === 1) return one(mn, () => ({ rd: 1, rs1: regNum(ops[0]), imm: 0 }));
      if (ops.length === 2) return one(mn, (s) => { const m = parseMem(ops[1]); return { rd: regNum(ops[0]), rs1: m.reg, imm: Number(E(m.off, s)) }; });
      need(3); return one(mn, (s) => ({ rd: regNum(ops[0]), rs1: regNum(ops[1]), imm: Number(E(ops[2], s)) }));
    case 'csr': need(3); return one(mn, () => ({ rd: regNum(ops[0]), imm: csrNum(ops[1]), rs1: regNum(ops[2]) }));
    case 'csri': need(3); return one(mn, (s) => ({ rd: regNum(ops[0]), imm: csrNum(ops[1]), rs1: Number(E(ops[2], s)) }));
    case 'none': return one(mn, () => ({}));
  }
  throw new Error(`cannot assemble ${mn}`);
}

// assemble(source) -> { bytes: Uint8Array(64K), used: [lo, hi), listing: [...], symbols, entries }
export function assemble(source) {
  const lines = source.split(/\r?\n/);
  const symbols = {};
  const items = []; // {kind:'insn'|'data', addr, size, line, src, ...}
  let pc = RESET_PC;
  const errors = [];

  // ------------------------------ pass 1 -----------------------------------
  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    try {
      let s = stripComment(raw);
      let m;
      while ((m = s.match(/^([A-Za-z_.$][\w.$]*)\s*:(.*)$/))) {
        if (m[1] in symbols) throw new Error(`label "${m[1]}" defined twice`);
        symbols[m[1]] = pc; s = m[2].trim();
      }
      if (!s) return;
      const sp = s.search(/\s/);
      const mn = (sp < 0 ? s : s.slice(0, sp)).toLowerCase();
      const rest = sp < 0 ? '' : s.slice(sp + 1).trim();
      if (mn.startsWith('.')) {
        const ops = splitOperands(rest);
        switch (mn) {
          case '.text': case '.data': case '.globl': case '.global': case '.section': case '.option': return;
          case '.equ': case '.set': symbols[ops[0]] = Number(evalExpr(ops[1], symbols)); return;
          case '.org': pc = Number(evalExpr(ops[0], symbols)); return;
          case '.align': case '.p2align': { const a = 1 << Number(evalExpr(ops[0], symbols)); const pad = (a - (pc % a)) % a;
            items.push({ kind: 'data', addr: pc, bytes: () => new Array(pad).fill(0), line: lineNo, src: raw.trim() }); pc += pad; return; }
          case '.balign': { const a = Number(evalExpr(ops[0], symbols)); const pad = (a - (pc % a)) % a;
            items.push({ kind: 'data', addr: pc, bytes: () => new Array(pad).fill(0), line: lineNo, src: raw.trim() }); pc += pad; return; }
          case '.zero': case '.space': { const n = Number(evalExpr(ops[0], symbols));
            items.push({ kind: 'data', addr: pc, bytes: () => new Array(n).fill(0), line: lineNo, src: raw.trim() }); pc += n; return; }
          case '.byte': case '.half': case '.short': case '.word': case '.long': case '.dword': case '.quad': {
            const size = { '.byte': 1, '.half': 2, '.short': 2, '.word': 4, '.long': 4, '.dword': 8, '.quad': 8 }[mn];
            const addr = pc;
            items.push({ kind: 'data', addr, line: lineNo, src: raw.trim(), bytes: (sym) => {
              const out = [];
              for (const o of ops) { let v = BigInt.asUintN(size * 8, evalExpr(o, sym)); for (let b = 0; b < size; b++) { out.push(Number(v & 0xffn)); v >>= 8n; } }
              return out; } });
            pc += size * ops.length; return;
          }
          case '.string': case '.asciz': case '.ascii': {
            const strs = ops.map(o => { const mm = o.match(/^"(.*)"$/); if (!mm) throw new Error(`expected string, got ${o}`); return unescape(mm[1]); });
            const out = [];
            for (const str of strs) { for (const ch of str) out.push(ch.charCodeAt(0) & 0xff); if (mn !== '.ascii') out.push(0); }
            items.push({ kind: 'data', addr: pc, bytes: () => out, line: lineNo, src: raw.trim() });
            pc += out.length; return;
          }
          default: throw new Error(`unknown directive ${mn}`);
        }
      }
      const ops = splitOperands(rest);
      const seq = expand(mn, ops, symbols);
      seq.forEach(([name, f], k) => {
        items.push({ kind: 'insn', addr: pc, name, fields: f, line: lineNo, src: k === 0 ? raw.trim() : '  (expansion)', pseudo: seq.length > 1 || name !== mn });
        pc += 4;
      });
    } catch (e) { errors.push({ line: lineNo, message: e.message, src: raw }); }
  });

  // ------------------------------ pass 2 -----------------------------------
  const bytes = new Uint8Array(MEM_SIZE);
  const listing = [];
  let lo = Infinity, hi = 0;
  for (const it of items) {
    try {
      symbols['.'] = it.addr;
      if (it.kind === 'insn') {
        if (it.addr % 4) throw new Error(`instruction at 0x${it.addr.toString(16)} is not 4-byte aligned (add .align 2)`);
        const f = it.fields(symbols, it.addr);
        const w = encode(it.name, f);
        for (let b = 0; b < 4; b++) bytes[(it.addr + b) & 0xffff] = (w >>> (8 * b)) & 0xff;
        listing.push({ addr: it.addr, word: w, line: it.line, src: it.src, name: it.name });
        lo = Math.min(lo, it.addr); hi = Math.max(hi, it.addr + 4);
      } else {
        const bs = it.bytes(symbols);
        bs.forEach((b, k) => { bytes[(it.addr + k) & 0xffff] = b; });
        if (bs.length) { lo = Math.min(lo, it.addr); hi = Math.max(hi, it.addr + bs.length); }
        listing.push({ addr: it.addr, data: bs, line: it.line, src: it.src });
      }
    } catch (e) { errors.push({ line: it.line, message: e.message, src: it.src }); }
  }
  if (errors.length) {
    const err = new Error(errors.map(e => `line ${e.line}: ${e.message}\n    ${e.src.trim()}`).join('\n'));
    err.errors = errors; throw err;
  }
  if (lo === Infinity) lo = 0;
  return { bytes, used: [lo, hi], listing, symbols };
}

// Helpers for output files -----------------------------------------------------
export function toHex(img) {       // $readmemh format: one byte per line, @addr jumps
  const [lo, hi] = img.used;
  const out = [`@${lo.toString(16).padStart(8, '0')}`];
  for (let a = lo; a < hi; a++) out.push(img.bytes[a].toString(16).padStart(2, '0'));
  return out.join('\n') + '\n';
}

export function toListing(img) {
  const bin = w => w.toString(2).padStart(32, '0');
  const out = ['ADDR      HEX        BINARY (bit 31 ................................ bit 0)   SOURCE'];
  for (const l of img.listing) {
    if (l.word !== undefined) {
      out.push(`${l.addr.toString(16).padStart(8, '0')}  ${l.word.toString(16).padStart(8, '0')}   ${bin(l.word)}   ${l.src}`);
    } else if (l.data.length) {
      const hex = l.data.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join(' ') + (l.data.length > 8 ? ' ...' : '');
      out.push(`${l.addr.toString(16).padStart(8, '0')}  [${l.data.length} data byte${l.data.length > 1 ? 's' : ''}] ${hex.padEnd(31)} ${l.src}`);
    }
  }
  return out.join('\n') + '\n';
}
