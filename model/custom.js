// =============================================================================
// model/custom.js: your own instructions for Sixfold
//
// RISC-V sets aside the major opcode custom-0 (0001011) for exactly this: instructions a designer adds.
// An instruction here is a name, a format and one expression:
//
//   { "name": "absdiff", "format": "R", "funct3": 0, "funct7": 0, "expr": "a > b ? a - b : b - a" }
//   { "name": "addsl3",  "format": "I", "funct3": 4,              "expr": "(a << 3) + imm" }
//
//   R format: rd, rs1, rs2        a = rs1, b = rs2           funct3 0 to 3, funct7 0 to 127
//   I format: rd, rs1, immediate  a = rs1, b = imm (12 bits, sign-extended)   funct3 4 to 7
//   (funct3 bit 2 tells the decoder which: the hardware's decoder never changes, only Custom_Unit.sv does)
//
// The expression language is small on purpose: every operation has an obvious circuit, and the same
// expression is compiled two ways, to a JavaScript function for the model (compileJS) and to a
// SystemVerilog expression for the RTL (toVerilog, used by tools/custom.mjs to write src/Custom_Unit.sv).
// Values are 64-bit unsigned; arithmetic wraps like the hardware's.
//
//   operators, loosest first:  c ? x : y    ||    &&    |    ^    &    == !=    < <= > >= (unsigned)
//                              << >> (logical) >>> (arithmetic; shift amounts use their low 6 bits)
//                              + -    *    unary - ~ !
//   names:      a, b, rs1, rs2 (R format), imm (I format)
//   numbers:    42, -7, 0xff, 0b1010, 1_000_000
//   functions:  min max (signed)  minu maxu  abs  slt sltu (signed / unsigned less-than)
//               clz ctz popcount  rev8  rotl rotr  bit(x, n)  sext8 sext16 sext32  zext8 zext16 zext32
//   packed:     paddusb psubusb pavgub pmaxub pminub (8 byte lanes)  psadb pdotb (sums of 8 byte lanes)
//               pdoth (sum of 4 signed 16-bit products)  pmulhrsh (4 Q15 multiplies), docs/XCOMPUTE.md
//
// A custom instruction's operands are chosen in DECODE like the ALU's, pass through EXECUTE, and its logic
// runs in MEMORY, a cycle it shares with nothing; the result goes straight to WRITEBACK. An instruction
// that needs it right away waits two cycles (one with an instruction in between). That way your logic
// cannot lengthen the clock of the rest of the processor (docs/CUSTOM_INSTRUCTIONS.md explains why).
// =============================================================================

export const CUSTOM_OPCODE = 0b0001011;
const M64 = (1n << 64n) - 1n;
const u64 = x => BigInt.asUintN(64, x);
const s64 = x => BigInt.asIntN(64, x);

// ---------------------------------------------------------------- the functions
const clz = x => { if (x === 0n) return 64n; let n = 0n; for (let i = 63n; i >= 0n && !((x >> i) & 1n); i--) n++; return n; };
const ctz = x => { if (x === 0n) return 64n; let n = 0n; while (!((x >> n) & 1n)) n++; return n; };
const popcount = x => { let n = 0n; while (x) { n += x & 1n; x >>= 1n; } return n; };
const rotl = (x, s) => { s &= 63n; return s ? u64((x << s) | (x >> (64n - s))) : x; };
const rotr = (x, s) => { s &= 63n; return s ? u64((x >> s) | (x << (64n - s))) : x; };
const min = (x, y) => (x < y ? x : y);
// lanes(x, y, w, f): f on each w-bit lane (unsigned lane values), each result kept to w bits
const lanes = (x, y, w, f) => { const m = (1n << BigInt(w)) - 1n; let r = 0n; for (let i = 0n; i < 64n; i += BigInt(w)) r |= (f((x >> i) & m, (y >> i) & m) & m) << i; return r; };
// reduce(x, y, w, f, signed): the sum over the lanes of f(lane of x, lane of y), as a 64-bit number
const reduce = (x, y, w, f, signed) => { const m = (1n << BigInt(w)) - 1n; let s = 0n; for (let i = 0n; i < 64n; i += BigInt(w)) { let p = (x >> i) & m, q = (y >> i) & m; if (signed) { p = BigInt.asIntN(w, p); q = BigInt.asIntN(w, q); } s += f(p, q); } return u64(s); };
// Q15: a 16-bit lane is a fraction from -1 to 1 - 2^-15. (p * q + 2^14) >> 15 rounds the product to the nearest
// Q15 value; only -1 * -1 = +1 does not fit and saturates to 0x7fff
const q15 = (p, q) => { const a = BigInt.asIntN(16, p), b = BigInt.asIntN(16, q); return a === -32768n && b === -32768n ? 0x7fffn : BigInt.asUintN(16, (a * b + 0x4000n) >> 15n); };
const rev8 = x => { let r = 0n; for (let i = 0n; i < 8n; i++) r |= ((x >> (8n * i)) & 0xffn) << (8n * (7n - i)); return r; };

// name: [number of arguments, JavaScript (BigInt) implementation, one-line description]
export const FUNCTIONS = {
  min: [2, (x, y) => (s64(x) < s64(y) ? x : y), 'the smaller, comparing as signed numbers'],
  max: [2, (x, y) => (s64(x) > s64(y) ? x : y), 'the larger, comparing as signed numbers'],
  minu: [2, (x, y) => (x < y ? x : y), 'the smaller, unsigned'],
  maxu: [2, (x, y) => (x > y ? x : y), 'the larger, unsigned'],
  abs: [1, x => (s64(x) < 0n ? u64(-s64(x)) : x), 'absolute value of a signed number'],
  slt: [2, (x, y) => (s64(x) < s64(y) ? 1n : 0n), '1 if x < y as signed numbers'],
  sltu: [2, (x, y) => (x < y ? 1n : 0n), '1 if x < y unsigned'],
  clz: [1, clz, 'count leading zero bits (64 for 0)'],
  ctz: [1, ctz, 'count trailing zero bits (64 for 0)'],
  popcount: [1, popcount, 'count the 1 bits'],
  rev8: [1, rev8, 'reverse the 8 bytes'],
  rotl: [2, rotl, 'rotate left by n (low 6 bits)'],
  rotr: [2, rotr, 'rotate right by n (low 6 bits)'],
  bit: [2, (x, n) => (x >> (n & 63n)) & 1n, 'bit n of x'],
  sext8: [1, x => u64(BigInt.asIntN(8, x)), 'sign-extend the low 8 bits'],
  sext16: [1, x => u64(BigInt.asIntN(16, x)), 'sign-extend the low 16 bits'],
  sext32: [1, x => u64(BigInt.asIntN(32, x)), 'sign-extend the low 32 bits'],
  zext8: [1, x => x & 0xffn, 'keep the low 8 bits'],
  zext16: [1, x => x & 0xffffn, 'keep the low 16 bits'],
  zext32: [1, x => x & 0xffffffffn, 'keep the low 32 bits'],
  // Packed (SIMD within a register): eight 8-bit lanes (.b) or four 16-bit lanes (.h) side by side in one
  // 64-bit register, every lane computed at once. For pixels (8 bits per colour channel), audio samples and
  // fixed-point maths (16 bits), int8 neural networks. Lane i is bits 8i+7 ... 8i (or 16i+15 ... 16i).
  paddusb: [2, (x, y) => lanes(x, y, 8, (p, q) => min(p + q, 255n)), '8 bytes: add, unsigned, saturating at 255'],
  psubusb: [2, (x, y) => lanes(x, y, 8, (p, q) => (p > q ? p - q : 0n)), '8 bytes: subtract, unsigned, saturating at 0'],
  pavgub: [2, (x, y) => lanes(x, y, 8, (p, q) => (p + q + 1n) >> 1n), '8 bytes: average, unsigned, rounded up at .5'],
  pmaxub: [2, (x, y) => lanes(x, y, 8, (p, q) => (p > q ? p : q)), '8 bytes: the larger, unsigned'],
  pminub: [2, (x, y) => lanes(x, y, 8, (p, q) => (p < q ? p : q)), '8 bytes: the smaller, unsigned'],
  psadb: [2, (x, y) => reduce(x, y, 8, (p, q) => (p > q ? p - q : q - p), false), 'sum of the 8 bytes\' absolute differences'],
  pdotb: [2, (x, y) => reduce(x, y, 8, (p, q) => p * q, true), 'dot product of 8 signed bytes (64-bit result)'],
  pdoth: [2, (x, y) => reduce(x, y, 16, (p, q) => p * q, true), 'dot product of 4 signed 16-bit numbers (64-bit result)'],
  pmulhrsh: [2, (x, y) => lanes(x, y, 16, (p, q) => q15(p, q)), '4 x 16 bits: Q15 multiply, rounded, saturating'],
};

// ---------------------------------------------------------------- parsing
export class ExprError extends Error {
  constructor(message, pos) { super(pos === undefined ? message : `${message} (at character ${pos + 1})`); this.pos = pos; }
}

function tokenize(src) {
  const toks = [];
  const re = /\s*(?:(0x[0-9a-fA-F_]+|0b[01_]+|[0-9][0-9_]*)|([A-Za-z_][A-Za-z0-9_]*)|(>>>|<<|>>|<=|>=|==|!=|&&|\|\||[-+*&|^~!<>?:(),]))/y;
  let m, pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    re.lastIndex = pos;
    m = re.exec(src);
    if (!m) throw new ExprError(`I do not understand "${src.slice(pos).trim()[0]}"`, pos + (src.slice(pos).length - src.slice(pos).trimStart().length));
    const at = m.index + (m[0].length - m[0].trimStart().length);
    if (m[1] !== undefined) {
      const digits = m[1].replace(/_/g, '');
      if (/^0[xb]$/.test(digits)) throw new ExprError(`"${m[1]}" has no digits`, at);
      toks.push({ t: 'num', v: BigInt(digits), pos: at });
    }
    else if (m[2] !== undefined) toks.push({ t: 'name', v: m[2], pos: at });
    else toks.push({ t: 'op', v: m[3], pos: at });
    pos = re.lastIndex;
  }
  toks.push({ t: 'end', v: '', pos: src.length });
  return toks;
}

// Binary operators: precedence (higher binds tighter)
const BINARY = { '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '<=': 7, '>': 7, '>=': 7, '<<': 8, '>>': 8, '>>>': 8, '+': 9, '-': 9, '*': 10 };

// parse(src, format) -> AST: {k:'num', v} | {k:'var', v:'a'|'b'} | {k:'un', op, x} | {k:'bin', op, x, y} | {k:'cond', c, x, y} | {k:'call', f, args}
export function parse(src, format = 'R') {
  if (typeof src !== 'string' || !src.trim()) throw new ExprError('the expression is empty');
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i], next = () => toks[i++];
  const expect = v => { const t = next(); if (t.v !== v) throw new ExprError(t.t === 'end' ? `expected "${v}" before the end` : `expected "${v}", found "${t.v}"`, t.pos); };
  const VARS = format === 'I' ? { a: 'a', rs1: 'a', b: 'b', imm: 'b' } : { a: 'a', rs1: 'a', b: 'b', rs2: 'b' };
  function primary() {
    const t = next();
    if (t.t === 'num') return { k: 'num', v: u64(t.v) };
    if (t.t === 'name') {
      if (peek().v === '(') {
        const f = Object.hasOwn(FUNCTIONS, t.v) ? FUNCTIONS[t.v] : null;
        if (!f) throw new ExprError(`there is no function "${t.v}" (try ${Object.keys(FUNCTIONS).slice(0, 6).join(', ')}, ...)`, t.pos);
        next();
        const args = [];
        if (peek().v !== ')') { args.push(expr()); while (peek().v === ',') { next(); args.push(expr()); } }
        expect(')');
        if (args.length !== f[0]) throw new ExprError(`${t.v} takes ${f[0]} argument${f[0] > 1 ? 's' : ''}, not ${args.length}`, t.pos);
        return { k: 'call', f: t.v, args };
      }
      if (!Object.hasOwn(VARS, t.v)) {
        const hint = (t.v === 'imm' && format === 'R') ? ': an R-format instruction has rs2, not an immediate'
          : ((t.v === 'rs2') && format === 'I') ? ': an I-format instruction has an immediate (imm), not rs2' : ` (use ${Object.keys(VARS).join(', ')})`;
        throw new ExprError(`unknown name "${t.v}"${hint}`, t.pos);
      }
      return { k: 'var', v: VARS[t.v] };
    }
    if (t.v === '(') { const e = expr(); expect(')'); return e; }
    throw new ExprError(t.t === 'end' ? 'the expression ends too early' : `unexpected "${t.v}"`, t.pos);
  }
  let depthLeft = 200; // a deeply nested expression is a mistake, not a circuit: stop before the stack does
  function unary() {
    if (--depthLeft < 0) throw new ExprError('the expression is nested too deeply');
    const t = peek();
    if (t.v === '-' || t.v === '~' || t.v === '!') {
      next();
      const x = unary();
      if (t.v === '-' && x.k === 'num') return { k: 'num', v: u64(-x.v) }; // a negative number literal
      return { k: 'un', op: t.v, x };
    }
    return primary();
  }
  function binary(minPrec) {
    let x = unary();
    for (;;) {
      const t = peek(), p = BINARY[t.v];
      if (t.t !== 'op' || !p || p < minPrec) return x;
      next();
      x = { k: 'bin', op: t.v, x, y: binary(p + 1) };
    }
  }
  function expr() {
    const c = binary(1);
    if (peek().v !== '?') return c;
    next();
    const x = expr(); expect(':');
    return { k: 'cond', c, x, y: expr() };
  }
  const ast = expr();
  if (peek().t !== 'end') throw new ExprError(`unexpected "${peek().v}"`, peek().pos);
  return ast;
}

// ---------------------------------------------------------------- the model's evaluator
export function evaluate(ast, a, b) {
  const ev = n => evaluate(n, a, b);
  switch (ast.k) {
    case 'num': return ast.v;
    case 'var': return ast.v === 'a' ? a : b;
    case 'un': { const x = ev(ast.x); return ast.op === '-' ? u64(-x) : ast.op === '~' ? u64(~x) : (x === 0n ? 1n : 0n); }
    case 'cond': return ev(ast.c) !== 0n ? ev(ast.x) : ev(ast.y);
    case 'call': return FUNCTIONS[ast.f][1](...ast.args.map(ev));
    case 'bin': {
      if (ast.op === '&&') return ev(ast.x) !== 0n && ev(ast.y) !== 0n ? 1n : 0n;
      if (ast.op === '||') return ev(ast.x) !== 0n || ev(ast.y) !== 0n ? 1n : 0n;
      const x = ev(ast.x), y = ev(ast.y), sh = y & 63n;
      switch (ast.op) {
        case '+': return u64(x + y); case '-': return u64(x - y); case '*': return u64(x * y);
        case '&': return x & y; case '|': return x | y; case '^': return x ^ y;
        case '<<': return u64(x << sh); case '>>': return x >> sh; case '>>>': return u64(s64(x) >> sh);
        case '==': return x === y ? 1n : 0n; case '!=': return x !== y ? 1n : 0n;
        case '<': return x < y ? 1n : 0n; case '<=': return x <= y ? 1n : 0n;
        case '>': return x > y ? 1n : 0n; case '>=': return x >= y ? 1n : 0n;
      }
    }
  }
  throw new ExprError(`cannot evaluate ${ast.k}`);
}
export const compileJS = ast => (a, b) => evaluate(ast, u64(a), u64(b)) & M64;

// ---------------------------------------------------------------- the hardware's expression
// Each node becomes a 64-bit SystemVerilog expression over A and B. Comparisons give 1 bit, widened with
// {63'd0, ...}; anything that needs bit selects (shifts by a variable amount, clz, sext8, ...) calls a
// small function that tools/custom.mjs emits once per module. `used` collects those function names.
// prep: when given, the first PREPARE_SLOTS popcount calls are split across two stages (CustomPrepare in
// EXECUTE counts the argument's ones in four 16-bit quarters, CustomUnit in MEMORY adds the four counts):
// their argument's Verilog is pushed onto prep and the call becomes f_popfinish of its slot of PREPARED.
export const PREPARE_SLOTS = 3;
export function toVerilog(ast, used = new Set(), prep = null) {
  const v = n => toVerilog(n, used, prep);
  const fn = (name, ...args) => { used.add(name); return `f_${name}(${args.join(', ')})`; };
  const bit = s => `{63'd0, ${s}}`;
  // An unsigned comparison is the carry out of x - y on the prefix adder; == and != are trees already
  const compare = (op, x, y) => ({ '==': `(${x} == ${y})`, '!=': `(${x} != ${y})`, '<': fn('ltu', x, y), '>': fn('ltu', y, x),
    '<=': `!${fn('ltu', y, x)}`, '>=': `!${fn('ltu', x, y)}` })[op];
  switch (ast.k) {
    case 'num': return `64'h${ast.v.toString(16)}`;
    case 'var': return ast.v === 'a' ? 'A' : 'B';
    case 'un': return ast.op === '-' ? fn('sub', "64'd0", v(ast.x)) : ast.op === '~' ? `(~${v(ast.x)})` : bit(`(${v(ast.x)} == 64'd0)`);
    case 'cond': { // a comparison used as the condition needs no widening: (A > B) ? ... : ...
      const c = ast.c, cmp = c.k === 'bin' && ['==', '!=', '<', '<=', '>', '>='].includes(c.op);
      return `(${cmp ? compare(c.op, v(c.x), v(c.y)) : `(${v(c)} != 64'd0)`} ? ${v(ast.x)} : ${v(ast.y)})`;
    }
    case 'call': { // against the constant 0 a signed min / max / slt needs only the sign bit, no comparator
      const zero = n => n.k === 'num' && n.v === 0n, [p, q] = ast.args;
      if (['min', 'max', 'slt'].includes(ast.f) && ast.args.length === 2 && (zero(p) || zero(q))) {
        const other = v(zero(p) ? q : p);
        if (ast.f === 'max') return fn('maxz', other);
        if (ast.f === 'min') return fn('minz', other);
        if (zero(q)) return fn('ltz', other); // slt(x, 0) = sign of x
      }
      // A split function (SPLIT): its first half runs in EXECUTE on the arguments (computed there too, no
      // nested split) and travels in this instruction's bits of PREPARED; the second half runs here
      const sp = Object.hasOwn(SPLIT, ast.f) ? SPLIT[ast.f] : null;
      const at = prep ? prep.reduce((n, q) => n + q.bits, 0) : 0;
      if (sp && prep && (ast.f !== 'popcount' || prep.filter(q => q.f === 'popcount').length < PREPARE_SLOTS) && at + sp.bits <= PREPARED_BITS) {
        const prepFn = sp.prep || `${ast.f}_prep`, finFn = sp.fin || `${ast.f}_fin`;
        const pu = prep.used || used; // the functions CustomPrepare needs
        pu.add(prepFn);
        prep.push({ f: ast.f, bits: sp.bits, sv: `f_${prepFn}(${ast.args.map(a => toVerilog(a, pu, null)).join(', ')})` });
        const width = prepFn === 'popquarters' ? 20 : PREPARED_BITS; // the finishing function's input width
        const slice = `PREPARED[${at} +: ${sp.bits}]`;
        return fn(finFn, width === sp.bits ? slice : `{${width - sp.bits}'d0, ${slice}}`);
      }
      return fn(ast.f, ...ast.args.map(v));
    }
    case 'bin': {
      const x = v(ast.x), y = v(ast.y);
      switch (ast.op) {
        case '&&': return bit(`((${x} != 64'd0) && (${y} != 64'd0))`);
        case '||': return bit(`((${x} != 64'd0) || (${y} != 64'd0))`);
        case '<<': return fn('sll', x, y); case '>>': return fn('srl', x, y); case '>>>': return fn('sra', x, y);
        case '==': case '!=': case '<': case '<=': case '>': case '>=': return bit(compare(ast.op, x, y));
        case '+': return fn('add', x, y); case '-': return fn('sub', x, y); // prefix adders (see f_addc)
        default: return `(${x} ${ast.op} ${y})`; // * & | ^ : 64-bit operands, 64-bit result
      }
    }
  }
  throw new ExprError(`cannot translate ${ast.k}`);
}

// The SystemVerilog functions toVerilog may call (all 64-bit in, 64-bit out; loops unroll in synthesis)
export const VERILOG_FUNCTIONS = {
  // Every + - < > min max goes through one prefix adder. Written as a plain "x + y", synthesis
  // builds a ripple-carry chain (each bit waits for the one below it): 64 steps, which set the whole core's
  // clock on the 130 nm library. Here the carries are combined in pairs, then fours, eights ... (a
  // Kogge-Stone prefix: generate g = x & y, propagate p = x ^ y, then (g, p) = (g_hi | p_hi & g_lo, p_hi & p_lo)),
  // 6 levels for 64 bits, like src/Parallel_Prefix_Adder.sv. Returns {carry out, sum}.
  addc: `function automatic logic [64:0] f_addc(input logic [63:0] x, input logic [63:0] y, input logic c);
    logic [63:0] g, p, h;
    g = x & y; p = x ^ y; h = p;
    g[0] = g[0] | (p[0] & c); // the carry in joins bit 0
    for (int d = 1; d < 64; d = 2 * d)
      for (int i = 63; i >= d; i--) begin // from the top down, so g[i - d] is still the previous level's
        g[i] = g[i] | (p[i] & g[i - d]);
        p[i] = p[i] & p[i - d];
      end
    return {g[63], h ^ {g[62:0], c}}; // g[i] is now the carry out of bits i ... 0
  endfunction`,
  add: `function automatic logic [63:0] f_add(input logic [63:0] x, input logic [63:0] y);
    logic [64:0] s; s = f_addc(x, y, 1'b0); return s[63:0];
  endfunction`,
  sub: `function automatic logic [63:0] f_sub(input logic [63:0] x, input logic [63:0] y);
    logic [64:0] s; s = f_addc(x, ~y, 1'b1); return s[63:0]; // x + ~y + 1
  endfunction`,
  ltu: `function automatic logic f_ltu(input logic [63:0] x, input logic [63:0] y);
    logic [64:0] s; s = f_addc(x, ~y, 1'b1); return !s[64]; // x - y borrows
  endfunction`,
  lts: 'function automatic logic f_lts(input logic [63:0] x, input logic [63:0] y); return (x[63] != y[63]) ? x[63] : f_ltu(x, y); endfunction // signs differ: the negative one is smaller',
  maxz: 'function automatic logic [63:0] f_maxz(input logic [63:0] x); return x[63] ? 64\'d0 : x; endfunction // max(x, 0)',
  minz: 'function automatic logic [63:0] f_minz(input logic [63:0] x); return x[63] ? x : 64\'d0; endfunction // min(x, 0)',
  ltz: 'function automatic logic [63:0] f_ltz(input logic [63:0] x); return {63\'d0, x[63]}; endfunction // slt(x, 0)',
  sll: 'function automatic logic [63:0] f_sll(input logic [63:0] x, input logic [63:0] n); return x << n[5:0]; endfunction',
  srl: 'function automatic logic [63:0] f_srl(input logic [63:0] x, input logic [63:0] n); return x >> n[5:0]; endfunction',
  sra: 'function automatic logic [63:0] f_sra(input logic [63:0] x, input logic [63:0] n); return $unsigned($signed(x) >>> n[5:0]); endfunction',
  min: 'function automatic logic [63:0] f_min(input logic [63:0] x, input logic [63:0] y); return f_lts(x, y) ? x : y; endfunction',
  max: 'function automatic logic [63:0] f_max(input logic [63:0] x, input logic [63:0] y); return f_lts(y, x) ? x : y; endfunction',
  minu: 'function automatic logic [63:0] f_minu(input logic [63:0] x, input logic [63:0] y); return f_ltu(x, y) ? x : y; endfunction',
  maxu: 'function automatic logic [63:0] f_maxu(input logic [63:0] x, input logic [63:0] y); return f_ltu(y, x) ? x : y; endfunction',
  abs: 'function automatic logic [63:0] f_abs(input logic [63:0] x); return x[63] ? f_sub(64\'d0, x) : x; endfunction',
  slt: 'function automatic logic [63:0] f_slt(input logic [63:0] x, input logic [63:0] y); return {63\'d0, f_lts(x, y)}; endfunction',
  sltu: 'function automatic logic [63:0] f_sltu(input logic [63:0] x, input logic [63:0] y); return {63\'d0, f_ltu(x, y)}; endfunction',
  // clz / ctz / popcount are trees, not chains: log2(64) = 6 levels, like src/Leading_Zero_Counter.sv and
  // src/Population_Count.sv (a 64-step loop would synthesize to a 64-deep chain and set the clock)
  clz: `function automatic logic [63:0] f_clz(input logic [63:0] x);
    logic [63:0] v; logic [6:0] n; v = x; n = 7'd0;
    if (v == 64'd0) return 64'd64;
    if (v[63:32] == 32'd0) begin n = n + 7'd32; v = v << 32; end
    if (v[63:48] == 16'd0) begin n = n + 7'd16; v = v << 16; end
    if (v[63:56] == 8'd0) begin n = n + 7'd8; v = v << 8; end
    if (v[63:60] == 4'd0) begin n = n + 7'd4; v = v << 4; end
    if (v[63:62] == 2'd0) begin n = n + 7'd2; v = v << 2; end
    if (v[63] == 1'b0) n = n + 7'd1;
    return {57'd0, n};
  endfunction`,
  ctz: `function automatic logic [63:0] f_ctz(input logic [63:0] x);
    logic [63:0] v; logic [6:0] n; v = x; n = 7'd0;
    if (v == 64'd0) return 64'd64;
    if (v[31:0] == 32'd0) begin n = n + 7'd32; v = v >> 32; end
    if (v[15:0] == 16'd0) begin n = n + 7'd16; v = v >> 16; end
    if (v[7:0] == 8'd0) begin n = n + 7'd8; v = v >> 8; end
    if (v[3:0] == 4'd0) begin n = n + 7'd4; v = v >> 4; end
    if (v[1:0] == 2'd0) begin n = n + 7'd2; v = v >> 2; end
    if (v[0] == 1'b0) n = n + 7'd1;
    return {57'd0, n};
  endfunction`,
  // popcount: each nibble's count from equations (as src/Population_Count.sv), then a carry-save tree: every
  // layer of full adders turns three numbers into two without propagating a carry, 16 -> 11 -> 8 -> 6 -> 4
  // -> 3 -> 2, and only the last add carries (7 bits). A chain or a plain sum of 16 operands was too slow
  // to fit in one cycle with everything else (docs/CUSTOM_INSTRUCTIONS.md, "What fits in a cycle").
  // Packed lanes: each lane has its own small adder (9 bits for a byte instead of 64), so a lane operation
  // is shallower than one 64-bit add. The loops unroll into eight (or four) independent copies.
  paddusb: `function automatic logic [63:0] f_paddusb(input logic [63:0] x, input logic [63:0] y);
    logic [8:0] s; logic [63:0] r;
    for (int i = 0; i < 8; i++) begin
      s = {1'b0, x[8*i +: 8]} + {1'b0, y[8*i +: 8]};
      r[8*i +: 8] = s[8] ? 8'hff : s[7:0]; // a carry out means the sum passed 255
    end
    return r;
  endfunction`,
  psubusb: `function automatic logic [63:0] f_psubusb(input logic [63:0] x, input logic [63:0] y);
    logic [8:0] s; logic [63:0] r;
    for (int i = 0; i < 8; i++) begin
      s = {1'b0, x[8*i +: 8]} - {1'b0, y[8*i +: 8]};
      r[8*i +: 8] = s[8] ? 8'h00 : s[7:0]; // a borrow means the difference went below 0
    end
    return r;
  endfunction`,
  pavgub: `function automatic logic [63:0] f_pavgub(input logic [63:0] x, input logic [63:0] y);
    logic [8:0] s; logic [63:0] r;
    for (int i = 0; i < 8; i++) begin
      s = {1'b0, x[8*i +: 8]} + {1'b0, y[8*i +: 8]} + 9'd1; // 9 bits: the carry is the average's top bit
      r[8*i +: 8] = s[8:1];
    end
    return r;
  endfunction`,
  pmaxub: `function automatic logic [63:0] f_pmaxub(input logic [63:0] x, input logic [63:0] y);
    logic [63:0] r;
    for (int i = 0; i < 8; i++) r[8*i +: 8] = (x[8*i +: 8] > y[8*i +: 8]) ? x[8*i +: 8] : y[8*i +: 8];
    return r;
  endfunction`,
  pminub: `function automatic logic [63:0] f_pminub(input logic [63:0] x, input logic [63:0] y);
    logic [63:0] r;
    for (int i = 0; i < 8; i++) r[8*i +: 8] = (x[8*i +: 8] < y[8*i +: 8]) ? x[8*i +: 8] : y[8*i +: 8];
    return r;
  endfunction`,
  csa7: `function automatic logic [13:0] f_csa7(input logic [6:0] a, input logic [6:0] b, input logic [6:0] c);
    return {((a & b) | (a & c) | (b & c)) << 1, a ^ b ^ c}; // {carry (already moved one column left), sum}
  endfunction`,
  popcount: `function automatic logic [63:0] f_popcount(input logic [63:0] x);
    logic [15:0][6:0] v; logic [3:0] q; logic two;
    logic [13:0] a0, a1, a2, a3, a4, b0, b1, b2, c0, c1, d0, d1, e0, f0;
    for (int i = 0; i < 16; i++) begin
      q = x[4*i +: 4];
      two = (q[0] & q[1]) | (q[0] & q[2]) | (q[0] & q[3]) | (q[1] & q[2]) | (q[1] & q[3]) | (q[2] & q[3]);
      v[i] = {4'd0, &q, two & ~(&q), ^q};
    end
    a0 = f_csa7(v[0], v[1], v[2]); a1 = f_csa7(v[3], v[4], v[5]); a2 = f_csa7(v[6], v[7], v[8]);
    a3 = f_csa7(v[9], v[10], v[11]); a4 = f_csa7(v[12], v[13], v[14]);                         // 16 -> 11
    b0 = f_csa7(a0[6:0], a0[13:7], a1[6:0]); b1 = f_csa7(a1[13:7], a2[6:0], a2[13:7]);
    b2 = f_csa7(a3[6:0], a3[13:7], a4[6:0]);                                                     // 11 -> 8
    c0 = f_csa7(b0[6:0], b0[13:7], b1[6:0]); c1 = f_csa7(b1[13:7], b2[6:0], b2[13:7]);          // 8 -> 6
    d0 = f_csa7(c0[6:0], c0[13:7], c1[6:0]); d1 = f_csa7(c1[13:7], a4[13:7], v[15]);            // 6 -> 4
    e0 = f_csa7(d0[6:0], d0[13:7], d1[6:0]);                                                     // 4 -> 3
    f0 = f_csa7(e0[6:0], e0[13:7], d1[13:7]);                                                    // 3 -> 2
    return {57'd0, f0[6:0] + f0[13:7]};
  endfunction`,
  // popcount split across two stages (the first PREPARE_SLOTS calls): the argument's ones in four 16-bit
  // quarters in EXECUTE (CustomPrepare), the sum of the four in MEMORY, like src/Population_Count.sv
  popquarters: `function automatic logic [19:0] f_popquarters(input logic [63:0] x);
    logic [3:0] q; logic two; logic [2:0] n; logic [19:0] r; r = 20'd0;
    for (int i = 0; i < 16; i++) begin
      q = x[4*i +: 4];
      two = (q[0] & q[1]) | (q[0] & q[2]) | (q[0] & q[3]) | (q[1] & q[2]) | (q[1] & q[3]) | (q[2] & q[3]);
      n = {&q, two & ~(&q), ^q};
      r[5*(i/4) +: 5] = r[5*(i/4) +: 5] + {2'd0, n};
    end
    return r;
  endfunction`,
  popfinish: `function automatic logic [63:0] f_popfinish(input logic [19:0] q);
    logic [5:0] lo, hi; lo = {1'b0, q[4:0]} + {1'b0, q[9:5]}; hi = {1'b0, q[14:10]} + {1'b0, q[19:15]};
    return {57'd0, {1'b0, lo} + {1'b0, hi}};
  endfunction`,
  rev8: 'function automatic logic [63:0] f_rev8(input logic [63:0] x); return {x[7:0], x[15:8], x[23:16], x[31:24], x[39:32], x[47:40], x[55:48], x[63:56]}; endfunction',
  rotl: 'function automatic logic [63:0] f_rotl(input logic [63:0] x, input logic [63:0] n); return (x << n[5:0]) | (x >> (7\'d64 - {1\'b0, n[5:0]})); endfunction',
  rotr: 'function automatic logic [63:0] f_rotr(input logic [63:0] x, input logic [63:0] n); return (x >> n[5:0]) | (x << (7\'d64 - {1\'b0, n[5:0]})); endfunction',
  bit: 'function automatic logic [63:0] f_bit(input logic [63:0] x, input logic [63:0] n); return {63\'d0, x[n[5:0]]}; endfunction',
  sext8: 'function automatic logic [63:0] f_sext8(input logic [63:0] x); return {{56{x[7]}}, x[7:0]}; endfunction',
  sext16: 'function automatic logic [63:0] f_sext16(input logic [63:0] x); return {{48{x[15]}}, x[15:0]}; endfunction',
  sext32: 'function automatic logic [63:0] f_sext32(input logic [63:0] x); return {{32{x[31]}}, x[31:0]}; endfunction',
  zext8: 'function automatic logic [63:0] f_zext8(input logic [63:0] x); return {56\'d0, x[7:0]}; endfunction',
  zext16: 'function automatic logic [63:0] f_zext16(input logic [63:0] x); return {48\'d0, x[15:0]}; endfunction',
  zext32: 'function automatic logic [63:0] f_zext32(input logic [63:0] x); return {32\'d0, x[31:0]}; endfunction',
};

// ---------------------------------------------------------------- packed multiply and sum, in two halves
// PREPARED: the bits CustomPrepare (EXECUTE) hands CustomUnit (MEMORY); the widest first half is pdoth's
export const PREPARED_BITS = 272;
// A carry-save (Wallace) tree: full adders turn three numbers into two with no carry running along the
// word, so n numbers take about log1.5(n) levels; only the last two meet in a prefix adder (f_addc).
// csaTree(rows, W, tag) -> { decl, code, out: [x, y] } for W-bit rows (two's complement, modulo 2^W).
function csaTree(rows, W, tag) {
  const decl = [], code = [];
  let cur = rows.slice(), n = 0;
  while (cur.length > 2) {
    const next = [];
    let i = 0;
    for (; i + 3 <= cur.length; i += 3) {
      const [a, b, c] = cur.slice(i, i + 3), sum = `${tag}s${n}`, carry = `${tag}c${n}`;
      n++;
      decl.push(`logic [${W - 1}:0] ${sum}, ${carry};`);
      code.push(`${sum} = ${a} ^ ${b} ^ ${c}; ${carry} = ((${a} & ${b}) | (${a} & ${c}) | (${b} & ${c})) << 1;`);
      next.push(sum, carry);
    }
    cur = next.concat(cur.slice(i));
  }
  return { decl, code, out: cur };
}
// The last carry-propagate add of a tree, W bits, on the module's 64-bit prefix adder (constant-zero top bits
// fall away in synthesis)
const addW = (x, y, W) => `f_addc({${64 - W}'d0, ${x}}, {${64 - W}'d0, ${y}}, 1'b0)`;
const sext = (v, from, to) => (to === from ? v : `{{${to - from}{${v}[${from - 1}]}}, ${v}}`);

// One signed w x w product, modulo 2^(2w): rows b[j] ? a << j for j < w - 1, and the sign bit's row
// subtracted (-X = ~X + 1, the + 1 a row of its own). Writes the product into `${dst}`.
// (flat bit indices: lane `base` of x and y; some synthesis tools refuse x[i +: w][j])
// With W > 2w the rows are sign-extended to W bits; with dst = null the product stays in carry-save form
// (two numbers, ${tag}s / ${tag}c in out) and the carry-propagate add is left to the next stage.
function productCode(base, w, tag, dst, W = 2 * w) {
  const rows = [], decl = [`logic [${W - 1}:0] ${tag}a;`], code = [`${tag}a = {{${W - w}{x[${base + w - 1}]}}, x[${base + w - 1}:${base}]};`];
  for (let j = 0; j < w - 1; j++) rows.push(`({${W}{y[${base + j}]}} & (${tag}a << ${j}))`);
  rows.push(`({${W}{y[${base + w - 1}]}} & ~(${tag}a << ${w - 1}))`, `{${W - 1}'d0, y[${base + w - 1}]}`);
  rows.forEach((r, k) => { decl.push(`logic [${W - 1}:0] ${tag}r${k};`); code.push(`${tag}r${k} = ${r};`); });
  const t = csaTree(rows.map((_, k) => `${tag}r${k}`), W, tag);
  if (!dst) return { decl: decl.concat(t.decl), code: t.code.length ? code.concat(t.code) : code, out: t.out };
  return { decl: decl.concat(t.decl), code: code.concat(t.code, [`${dst} = ${addW(t.out[0], t.out[1], W)};`]) };
}
const fnText = (head, decl, code, ret) => `${head}\n${decl.join('\n')}\n${code.join('\n')}\n${ret}\n  endfunction`;

// The lane products of pdotb / pdoth: in EXECUTE (CustomPrepare), each lane's product to its own register bits
function productsFn(name, w) {
  const lanesN = 64 / w, W = 2 * w, decl = [`logic [127:0] r; logic [64:0] t;`], code = [`r = 128'd0;`];
  for (let i = 0; i < lanesN; i++) {
    const p = productCode(w * i, w, `l${i}`, 't');
    decl.push(...p.decl); code.push(...p.code, `r[${W * i} +: ${W}] = t[${W - 1}:0];`);
  }
  return fnText(`function automatic logic [127:0] f_${name}(input logic [63:0] x, input logic [63:0] y);`, decl, code, '    return r;');
}
// The sum of n signed W-bit numbers packed in P (MEMORY, CustomUnit), sign-extended to 64 bits
function sumFn(name, n, w, inBits, S) { // n signed w-bit numbers at P[w*i +: w], summed in S bits
  const rows = [], decl = [`logic [64:0] t;`], code = [];
  for (let i = 0; i < n; i++) { decl.push(`logic [${S - 1}:0] v${i};`); code.push(`v${i} = ${sext(`P[${w * i} +: ${w}]`, w, S).replace(/\{\{(\d+)\{P\[(\d+) \+: \d+\]\[(\d+)\]\}\}/, (m, k, base, bit) => `{{${k}{P[${+base + +bit}]}}`)};`); rows.push(`v${i}`); }
  const t = csaTree(rows, S, 'z');
  return fnText(`function automatic logic [63:0] f_${name}(input logic [${inBits - 1}:0] P);`, decl.concat(t.decl), code.concat(t.code, [`t = ${addW(t.out[0], t.out[1], S)};`]), `    return ${sext(`t[${S - 1}:0]`, S, 64).replace(/\{\{(\d+)\{t\[\d+:0\]\[(\d+)\]\}\}/, (m, k, bit) => `{{${k}{t[${bit}]}}`)};`);
}
VERILOG_FUNCTIONS.pdotb_prep = productsFn('pdotb_prep', 8);            // 8 products of 16 bits
VERILOG_FUNCTIONS.pdotb_fin = sumFn('pdotb_fin', 8, 16, PREPARED_BITS, 20); // |sum| <= 8 x 2^14: 20 signed bits
// pdoth: a 16 x 16 product's tree (17 rows, 6 levels) and its 32-bit add did not fit one cycle together, so
// each lane's product leaves EXECUTE in carry-save form, two 34-bit numbers (34 bits: the sum of all four
// products, at most 4 x 2^30 in size, is exact modulo 2^34), and MEMORY adds the eight in one tree
{
  const decl = [`logic [${PREPARED_BITS - 1}:0] r;`], code = [`r = ${PREPARED_BITS}'d0;`];
  for (let i = 0; i < 4; i++) {
    const p = productCode(16 * i, 16, `l${i}`, null, 34);
    decl.push(...p.decl); code.push(...p.code, `r[${68 * i} +: 34] = ${p.out[0]};`, `r[${68 * i + 34} +: 34] = ${p.out[1]};`);
  }
  VERILOG_FUNCTIONS.pdoth_prep = fnText(`function automatic logic [${PREPARED_BITS - 1}:0] f_pdoth_prep(input logic [63:0] x, input logic [63:0] y);`, decl, code, '    return r;');
  const rows = [], d2 = ['logic [64:0] t;'];
  for (let i = 0; i < 8; i++) { d2.push(`logic [33:0] v${i};`); rows.push(`v${i}`); }
  const t = csaTree(rows, 34, 'z');
  VERILOG_FUNCTIONS.pdoth_fin = fnText(`function automatic logic [63:0] f_pdoth_fin(input logic [${PREPARED_BITS - 1}:0] P);`, d2.concat(t.decl),
    rows.map((v, i) => `${v} = P[${34 * i} +: 34];`).concat(t.code, [`t = ${addW(t.out[0], t.out[1], 34)};`]), "    return {{30{t[33]}}, t[33:0]};");
}
// psadb: the eight byte differences |x - y| in EXECUTE, their sum (11 bits) in MEMORY
VERILOG_FUNCTIONS.psadb_prep = `function automatic logic [63:0] f_psadb_prep(input logic [63:0] x, input logic [63:0] y);
    logic [8:0] d, e; logic [63:0] r;
    for (int i = 0; i < 8; i++) begin
      d = {1'b0, x[8*i +: 8]} - {1'b0, y[8*i +: 8]}; e = {1'b0, y[8*i +: 8]} - {1'b0, x[8*i +: 8]};
      r[8*i +: 8] = d[8] ? e[7:0] : d[7:0]; // x - y borrowed: the difference is y - x
    end
    return r;
  endfunction`;
{
  const rows = [], decl = [`logic [64:0] t;`], code = [];
  for (let i = 0; i < 8; i++) { decl.push(`logic [10:0] v${i};`); code.push(`v${i} = {3'd0, P[${8 * i} +: 8]};`); rows.push(`v${i}`); }
  const t = csaTree(rows, 11, 'z');
  VERILOG_FUNCTIONS.psadb_fin = fnText(`function automatic logic [63:0] f_psadb_fin(input logic [${PREPARED_BITS - 1}:0] P);`, decl.concat(t.decl), code.concat(t.code, [`t = ${addW(t.out[0], t.out[1], 11)};`]), "    return {53'd0, t[10:0]};");
}
// pmulhrsh: each lane's product in carry-save form (two 32-bit numbers: the result needs only bits 30 ... 15,
// so modulo 2^32 is enough) and whether both lanes were -1 (-32768: the one product that does not fit); in
// MEMORY, the pair and the rounding constant 2^14 go through one level of full adders and a 32-bit add
{
  const decl = ['logic [259:0] r;'], code = [];
  for (let i = 0; i < 4; i++) {
    const p = productCode(16 * i, 16, `l${i}`, null, 32);
    decl.push(...p.decl);
    code.push(...p.code, `r[${64 * i} +: 32] = ${p.out[0]};`, `r[${64 * i + 32} +: 32] = ${p.out[1]};`, `r[${256 + i}] = (x[${16 * i} +: 16] == 16'h8000) && (y[${16 * i} +: 16] == 16'h8000);`);
  }
  VERILOG_FUNCTIONS.pmulhrsh_prep = fnText(`function automatic logic [259:0] f_pmulhrsh_prep(input logic [63:0] x, input logic [63:0] y);`, decl, code, '    return r;');
}
VERILOG_FUNCTIONS.pmulhrsh_fin = `function automatic logic [63:0] f_pmulhrsh_fin(input logic [${PREPARED_BITS - 1}:0] P);
    logic [63:0] r; logic [31:0] a, b, s, c; logic [64:0] t;
    for (int i = 0; i < 4; i++) begin
      a = P[64*i +: 32]; b = P[64*i + 32 +: 32];
      s = a ^ b ^ 32'h4000; c = ((a & b) | ((a | b) & 32'h4000)) << 1; // + 2^14: rounds to the nearest
      t = f_addc({32'd0, s}, {32'd0, c}, 1'b0);
      r[16*i +: 16] = P[256 + i] ? 16'h7fff : t[30:15];
    end
    return r;
  endfunction`;
// The whole operation in one stage, for a call the split cannot take (nested in another split call's
// argument, or more than the 128 bits of PREPARED in one instruction)
for (const f of ['pdotb', 'pdoth', 'psadb', 'pmulhrsh'])
  VERILOG_FUNCTIONS[f] = `function automatic logic [63:0] f_${f}(input logic [63:0] x, input logic [63:0] y); return f_${f}_fin(f_${f}_prep(x, y)); endfunction`;

// Functions split across EXECUTE and MEMORY: how many bits of PREPARED the first half takes
export const SPLIT = { popcount: { bits: 20, prep: 'popquarters', fin: 'popfinish' }, psadb: { bits: 64 }, pdotb: { bits: 128 }, pdoth: { bits: 272 }, pmulhrsh: { bits: 260 } };

// How big is it? A rough count of the circuits an expression needs, so the workshop can show the cost
// of a choice (a 64 x 64 multiplier is thousands of gates; an AND is 64).
export function cost(ast) {
  const c = { adders: 0, multipliers: 0, shifters: 0, comparators: 0, counters: 0, logic: 0, muxes: 0 };
  const walk = n => {
    if (n.k === 'bin') {
      const k = [n.x, n.y].find(m => m.k === 'num'), pow2 = k && (k.v & (k.v - 1n)) === 0n;
      if (n.op === '+' || n.op === '-') c.adders++; else if (n.op === '*') { if (!k) c.multipliers++; else if (!pow2) c.adders++; } // * constant: shifts and adds
      else if (['<<', '>>', '>>>'].includes(n.op)) { if (n.y.k !== 'num') c.shifters++; } // by a constant: only wiring
      else if (['<', '<=', '>', '>=', '==', '!='].includes(n.op)) c.comparators++; else c.logic++;
      walk(n.x); walk(n.y);
    } else if (n.k === 'un') { if (n.op === '-') c.adders++; else c.logic++; walk(n.x); }
    else if (n.k === 'cond') { c.muxes++; walk(n.c); walk(n.x); walk(n.y); }
    else if (n.k === 'call') {
      if (['clz', 'ctz', 'popcount'].includes(n.f)) c.counters++;
      else if (['pdotb', 'pmulhrsh'].includes(n.f) || n.f === 'pdoth') { c.multipliers += 1; c.adders++; } // the lane multipliers and their sum
      else if (['paddusb', 'psubusb', 'pavgub', 'psadb'].includes(n.f)) c.adders++;
      else if (['pmaxub', 'pminub'].includes(n.f)) { c.comparators++; c.muxes++; }
      else if (['rotl', 'rotr', 'bit'].includes(n.f)) c.shifters++;
      else if (['min', 'max', 'minu', 'maxu', 'slt', 'sltu', 'abs'].includes(n.f)) { c.comparators++; c.muxes++; }
      n.args.forEach(walk);
    }
  };
  walk(ast);
  return c;
}

// ---------------------------------------------------------------- a set of instructions
// Names a custom instruction may not take: every built-in instruction and assembler pseudo-instruction
const PSEUDO = ['nop', 'mv', 'not', 'neg', 'negw', 'sext.w', 'seqz', 'snez', 'sltz', 'sgtz', 'beqz', 'bnez', 'blez', 'bgez', 'bltz', 'bgtz', 'bgt', 'ble', 'bgtu', 'bleu',
  'j', 'call', 'tail', 'jr', 'ret', 'halt', 'csrr', 'csrw', 'csrs', 'csrc', 'csrwi', 'csrsi', 'csrci', 'rdcycle', 'rdinstret', 'la', 'li'];

// validate(list, builtinNames) -> { ok, errors: [{ index, field, message }], compiled: [...] }
export function validate(list, builtinNames = []) {
  const errors = [], compiled = [], seen = new Map(), reserved = new Set([...builtinNames, ...PSEUDO]);
  if (!Array.isArray(list)) return { ok: false, errors: [{ index: -1, field: 'list', message: 'expected a list of instructions' }], compiled };
  if (list.length > 32) errors.push({ index: -1, field: 'list', message: 'at most 32 custom instructions' });
  list.forEach((d, i) => {
    const err = (field, message) => errors.push({ index: i, field, message });
    if (!d || typeof d !== 'object') { err('entry', 'each instruction is an object with name, format, funct3, expr'); return; }
    const name = String(d.name || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9.]{0,15}$/.test(name)) err('name', 'a name is 1 to 16 lowercase letters, digits or dots, starting with a letter');
    else if (reserved.has(name)) err('name', `"${name}" is already an instruction`);
    else if (seen.has('n:' + name)) err('name', `"${name}" is used twice`);
    seen.set('n:' + name, i);
    const format = d.format === 'I' ? 'I' : d.format === 'R' ? 'R' : null;
    if (!format) err('format', 'the format is R (two registers) or I (a register and an immediate)');
    const whole = v => (typeof v === 'number' || (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) ? Number(v) : NaN); // null or "" is not 0
    const f3 = whole(d.funct3), f7 = d.funct7 === undefined && format !== 'R' ? 0 : whole(d.funct7 ?? 0);
    if (format === 'R') {
      if (!Number.isInteger(f3) || f3 < 0 || f3 > 3) err('funct3', 'an R-format instruction uses funct3 0 to 3');
      if (!Number.isInteger(f7) || f7 < 0 || f7 > 127) err('funct7', 'funct7 is 0 to 127');
      const key = `r:${f3}:${f7}`;
      if (seen.has(key)) err('funct7', `funct3 ${f3} and funct7 ${f7} are taken by ${list[seen.get(key)].name}`);
      seen.set(key, i);
    } else if (format === 'I') {
      if (!Number.isInteger(f3) || f3 < 4 || f3 > 7) err('funct3', 'an I-format instruction uses funct3 4 to 7');
      const key = `i:${f3}`;
      if (seen.has(key)) err('funct3', `funct3 ${f3} is taken by ${list[seen.get(key)].name}`);
      seen.set(key, i);
    }
    const group = d.group === undefined || d.group === '' ? null : String(d.group);
    if (group !== null && !/^[a-z][a-z0-9]{0,15}$/.test(group)) err('group', 'a group is 1 to 16 lowercase letters or digits, starting with a letter (it becomes a parameter of CustomDecode)');
    let ast = null;
    try { ast = parse(String(d.expr ?? ''), format || 'R'); } catch (e) { err('expr', e.message); }
    if (ast && format) compiled.push({ name, format, funct3: f3, funct7: format === 'R' ? f7 : 0, expr: String(d.expr), desc: String(d.desc || ''), ...(group ? { group } : {}), ast, fn: compileJS(ast) });
  });
  return { ok: errors.length === 0, errors, compiled };
}

// The machine word an instruction's fields select: key = funct3 * 128 + funct7 for R, funct3 * 128 for I
export const keyOf = (funct3, funct7) => (funct3 >= 4 ? funct3 * 128 : funct3 * 128 + funct7);

// The active set, shared by the assembler (model/isa.js registers the names) and the core (execute)
let ACTIVE = new Map();
export function setActive(compiled) { ACTIVE = new Map(compiled.map(c => [keyOf(c.funct3, c.funct7), c])); }
export function activeList() { return [...ACTIVE.values()]; }
// What the hardware computes for a custom-0 word: an unassigned funct3 / funct7 gives 0 (Custom_Unit.sv's default),
// and so does an instruction of a group the build leaves out (groups: the set of enabled group names,
// CustomDecode's parameters; for example new Set(['xcompute']))
export function execute(word, a, b, groups = null) {
  const f3 = (word >>> 12) & 7, f7 = (word >>> 25) & 0x7f;
  const c = ACTIVE.get(keyOf(f3, f7));
  if (c && c.group && !(groups && groups.has(c.group))) return 0n;
  return c ? c.fn(a, b) : 0n;
}

// ---------------------------------------------------------------- the whole module (src/Custom_Unit.sv)
// list: validated instructions ({ name, format, funct3, funct7, expr }). tools/custom.mjs writes the result to
// src/Custom_Unit.sv; web/custom.html shows it.
export function verilogModule(list) {
  const used = new Set(), usedPrep = new Set();
  const body = list.map((c, i) => { const prep = []; prep.used = usedPrep; return { c, i, prep, sv: toVerilog(parse(c.expr, c.format), used, prep) }; });
  const NEEDS = { popcount: ['csa7'], add: ['addc'], sub: ['addc'], ltu: ['addc'], lts: ['ltu'], min: ['lts'], max: ['lts'],
    slt: ['lts'], minu: ['ltu'], maxu: ['ltu'], sltu: ['ltu'], abs: ['sub'],
    pdotb_prep: ['addc'], pdoth_prep: ['addc'], pdotb_fin: ['addc'], pdoth_fin: ['addc'], psadb_fin: ['addc'], pmulhrsh_prep: ['addc'], pmulhrsh_fin: ['addc'],
    pdotb: ['pdotb_prep', 'pdotb_fin'], pdoth: ['pdoth_prep', 'pdoth_fin'], psadb: ['psadb_prep', 'psadb_fin'], pmulhrsh: ['pmulhrsh_prep', 'pmulhrsh_fin'] }; // the helpers each function calls
  const close = set => { for (let grew = true; grew;) { grew = false; for (const n of [...set]) for (const d of NEEDS[n] || []) if (!set.has(d)) { set.add(d); grew = true; } } return set; };
  const text = set => [...close(set)].sort().map(n => VERILOG_FUNCTIONS[n].split('\n').map((l, i, all) => (i === 0 || i === all.length - 1 ? '  ' : '    ') + l.trim()).join('\n')).join('\n');
  const fns = text(used), fnsPrep = text(usedPrep);
  const match = c => c.format === 'I' ? `(FUNCT3 == 3'd${c.funct3})` : `(FUNCT3 == 3'd${c.funct3}) && (FUNCT7 == 7'd${c.funct7})`;
  // An instruction of a group (for example "xcompute") exists only when the group's parameter is 1
  const groups = [...new Set(list.map(c => c.group).filter(Boolean))];
  const gate = c => (c.group ? `${c.group.toUpperCase()} && ` : '');
  const selects = body.map(({ c, i }) => `  assign SELECT[${i}] = ${gate(c)}${match(c)}; // ${c.name}${c.group ? ` (${c.group})` : ''}`).join('\n');
  // Each instruction's first halves, packed from bit 0 (slot 0 lowest); one instruction is in EXECUTE at a time,
  // so they share PREPARED, selected by the one-hot SELECT like the results in MEMORY
  const packed = q => { const w = q.reduce((n, x) => n + x.bits, 0); return `{${w < PREPARED_BITS ? `${PREPARED_BITS - w}'d0, ` : ''}${q.map(x => x.sv).reverse().join(', ')}}`; };
  const withPrep = body.filter(b => b.prep.length);
  // Riscv64 and the deep edition always pass XCOMPUTE, so CustomDecode always declares it, even for a set
  // without that group (then it changes nothing)
  const params = [...new Set(['xcompute', ...groups])];
  const decodeParams = ` #(\n${params.map((g, k) => `    parameter bit ${g.toUpperCase()} = 1'b0${k < params.length - 1 ? ',' : ''} // the "${g}" instructions (0: their encodings give 0, as if unassigned)`).join('\n')}\n)`;
  const prepared = withPrep.length ? `${PREPARED_BITS}'d0\n${withPrep.map(({ c, i, prep }) => `      | ({${PREPARED_BITS}{SELECT[${i}]}} & ${packed(prep)}) // ${c.name}`).join('\n')}` : `${PREPARED_BITS}'d0`;
  const terms = body.map(({ c, i, sv }) => `      | ({64{SELECT[${i}]}} & ${sv}) // ${c.name}: ${c.expr}`).join('\n');
  return `\`default_nettype none
// =============================================================================
// src/Custom_Unit.sv: GENERATED by tools/custom.mjs from custom/instructions.json. Do not edit by hand:
// change the JSON file (or design instructions in web/custom.html) and run \`make custom\`.
//
// Your own instructions, on RISC-V's custom-0 opcode (0001011). funct3 0 to 3 is R format (rd, rs1, rs2),
// funct3 4 to 7 is I format (rd, rs1, a 12-bit immediate).
//   CustomDecode (in DECODE): which instruction this is, one bit per instruction (one-hot), carried along
//     with the instruction, so no funct3 / funct7 comparison is left on the custom unit's path.
//   CustomPrepare (in EXECUTE): the first half of each split function, registered into MEMORY with the
//     operands (${PREPARED_BITS} bits, PREPARED). A popcount (at most ${PREPARE_SLOTS} per instruction) counts the ones of its
//     argument in four 16-bit quarters, like src/Population_Count.sv; the packed psadb takes the eight byte
//     differences, pdotb / pdoth / pmulhrsh the lane products. Too deep for one cycle next to everything
//     else; split in two, each half fits.
//   CustomUnit (in MEMORY): every instruction's result in parallel, and an AND-OR keeps the selected one.
//     A is rs1 and B is rs2 or the sign-extended immediate, chosen and forwarded in DECODE like the ALU's
//     and registered at the end of EXECUTE, so this logic has the whole MEMORY cycle to itself. The result
//     goes straight into WRITEBACK_DATA (src/Riscv64.sv); a dependent instruction waits for it in DECODE
//     (CUSTOM_HAZARD_REGISTER1/2). An encoding with no instruction selects nothing and gives 0.
//
${list.map(c => `//   ${c.name.padEnd(10)} ${c.format}  funct3 ${c.funct3}${c.format === 'R' ? `  funct7 ${String(c.funct7).padEnd(3)}` : '            '}  rd = ${c.expr}`).join('\n') || '//   (no custom instructions)'}
// =============================================================================
/* verilator lint_off UNUSEDSIGNAL */
module CustomDecode${decodeParams} (
    input  logic [2:0]  FUNCT3,  // instruction bits 14:12
    input  logic [6:0]  FUNCT7,  // instruction bits 31:25 (part of the immediate in I format)
    output logic [31:0] SELECT   // one bit per custom instruction (at most 32)
);
${selects ? selects + '\n' : ''}${list.length < 32 ? `  assign SELECT[31:${list.length}] = '0;\n` : ''}endmodule

module CustomPrepare (
    input  logic [63:0]  A,        // rs1, at the start of EXECUTE
    input  logic [63:0]  B,        // rs2 or the immediate
    input  logic [31:0]  SELECT,   // from CustomDecode, one stage earlier
    output logic [${PREPARED_BITS - 1}:0] PREPARED  // the selected instruction's first halves (20 bits per split popcount)
);
${fnsPrep ? fnsPrep + '\n' : ''}
  assign PREPARED = ${prepared}
      ;
endmodule

module CustomUnit (
    input  logic [63:0] A,        // rs1
    input  logic [63:0] B,        // rs2 (R format) or the sign-extended immediate (I format)
    input  logic [${PREPARED_BITS - 1}:0] PREPARED, // from CustomPrepare, one stage earlier
    input  logic [31:0] SELECT,   // from CustomDecode, one stage earlier
    output logic [63:0] RESULT
);
${fns ? fns + '\n' : ''}
  assign RESULT = 64'd0
${terms ? terms + '\n' : ''}      ;
endmodule
/* verilator lint_on UNUSEDSIGNAL */
`;
}

// ---------------------------------------------------------------- share links
// An instruction set (and optionally a program) as URL-safe text: base64 of the UTF-8 JSON
export function encodeShare(list, program) {
  const json = JSON.stringify(program ? { s: list, p: program } : { s: list });
  const bytes = new TextEncoder().encode(json);
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeShare(text) {
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const j = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, ch => ch.charCodeAt(0))));
    if (!Array.isArray(j.s)) return null;
    const list = j.s.slice(0, 32).map(c => ({ name: String(c.name || ''), format: c.format === 'I' ? 'I' : 'R', funct3: Number(c.funct3) || 0, ...(c.format === 'I' ? {} : { funct7: Number(c.funct7) || 0 }), expr: String(c.expr || '').slice(0, 400), desc: String(c.desc || '').slice(0, 200) }));
    return { list, program: typeof j.p === 'string' ? j.p.slice(0, 100000) : null };
  } catch { return null; }
}

// ---------------------------------------------------------------- how deep is it?
// The longest path through an expression, in "adder delays": the time one 64-bit add takes. The custom
// unit has a MEMORY cycle to itself; measured with `make timing` on sky130 (docs/CUSTOM_INSTRUCTIONS.md,
// "What fits in a cycle"), absdiff, avgu and clampi leave the clock where it was, which first set the budget at 1.5
// adder delays. The packed set (docs/XCOMPUTE.md) measured further: its deepest MEMORY half, pdoth at 1.83
// adder delays alone (3014 ps), left the whole core at 3853 ps against 4415 ps without it (ABC spread is wide,
// so read that as "no slower"), so the budget is 1.85: the deepest half measured inside the core.
// A popcount's argument and its quarter counts run in EXECUTE (CustomPrepare), so in MEMORY it is only the last addition of four small counts (popfinish); a whole 64-bit count (popcount) did not fit.
// Shifts by a constant are only wiring, and a comparison with 0 is just the sign bit.
export const DEPTH = { add: 1, compare: 1, multiply: 3, counter: 1, popcount: 1.4, popfinish: 0.4, shift: 0.5, mux: 0.15, logic: 0.08,
  // the packed functions, measured alone on sky130 against one 64-bit add (1651 ps): a lane operation, and the
  // MEMORY half of each split one (its EXECUTE half runs next to the ALU)
  lane: 0.6, psadb: 1.56, pdotb: 1.64, pdoth: 1.83, pmulhrsh: 0.86 };
export const DEPTH_BUDGET = 1.85;
const isZero = n => n.k === 'num' && n.v === 0n;
export function depth(ast) {
  const d = n => depth(n);
  switch (ast.k) {
    case 'num': case 'var': return 0;
    case 'un': return d(ast.x) + (ast.op === '-' ? DEPTH.add : DEPTH.logic);
    case 'cond': return Math.max(d(ast.c), d(ast.x), d(ast.y)) + DEPTH.mux;
    case 'call': {
      const inner = Math.max(0, ...ast.args.map(d));
      const f = ast.f;
      if (f === 'popcount') return DEPTH.popfinish; // the argument and the quarter counts are done in EXECUTE (CustomPrepare)
      if (['psadb', 'pdotb', 'pdoth', 'pmulhrsh'].includes(f)) return DEPTH[f]; // the first half is in EXECUTE too
      if (['paddusb', 'psubusb', 'pavgub', 'pmaxub', 'pminub'].includes(f)) return inner + DEPTH.lane;
      if (f === 'clz' || f === 'ctz') return inner + DEPTH.counter; // a 6-level tree (src/Leading_Zero_Counter.sv)
      const cmp = ast.args.some(isZero) || f === 'abs' ? DEPTH.logic : DEPTH.compare; // against 0: the sign bit (abs negates, below)
      if (['min', 'max', 'minu', 'maxu'].includes(f)) return inner + cmp + DEPTH.mux;
      if (f === 'abs') return inner + DEPTH.add + DEPTH.mux;
      if (['slt', 'sltu'].includes(f)) return inner + cmp;
      if (['rotl', 'rotr', 'bit'].includes(f)) return inner + (ast.args[1].k === 'num' ? 0 : DEPTH.shift);
      return inner + (f === 'rev8' || f.startsWith('zext') ? 0 : DEPTH.logic); // byte moves and extensions are wiring
    }
    case 'bin': {
      const x = d(ast.x), y = d(ast.y), m = Math.max(x, y);
      if (ast.op === '+' || ast.op === '-') return m + DEPTH.add;
      if (ast.op === '*') { const k = [ast.x, ast.y].find(n => n.k === 'num'); return m + (!k ? DEPTH.multiply : (k.v & (k.v - 1n)) === 0n ? 0 : DEPTH.add); } // by a power of two: wiring
      if (['<<', '>>', '>>>'].includes(ast.op)) return x + (ast.y.k === 'num' ? 0 : Math.max(0, y - x) + DEPTH.shift);
      if (['<', '<=', '>', '>=', '==', '!='].includes(ast.op)) return m + (ast.op === '==' || ast.op === '!=' || isZero(ast.x) || isZero(ast.y) ? DEPTH.logic * 3 : DEPTH.compare);
      return m + DEPTH.logic;
    }
  }
  return 0;
}
