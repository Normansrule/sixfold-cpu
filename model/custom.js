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
export function toVerilog(ast, used = new Set()) {
  const v = n => toVerilog(n, used);
  const fn = (name, ...args) => { used.add(name); return `f_${name}(${args.join(', ')})`; };
  const bit = s => `{63'd0, ${s}}`;
  switch (ast.k) {
    case 'num': return `64'h${ast.v.toString(16)}`;
    case 'var': return ast.v === 'a' ? 'A' : 'B';
    case 'un': return ast.op === '-' ? `(64'd0 - ${v(ast.x)})` : ast.op === '~' ? `(~${v(ast.x)})` : bit(`(${v(ast.x)} == 64'd0)`);
    case 'cond': { // a comparison used as the condition needs no widening: (A > B) ? ... : ...
      const c = ast.c, cmp = c.k === 'bin' && ['==', '!=', '<', '<=', '>', '>='].includes(c.op);
      return `(${cmp ? `(${v(c.x)} ${c.op} ${v(c.y)})` : `(${v(c)} != 64'd0)`} ? ${v(ast.x)} : ${v(ast.y)})`;
    }
    case 'call': return fn(ast.f, ...ast.args.map(v));
    case 'bin': {
      const x = v(ast.x), y = v(ast.y);
      switch (ast.op) {
        case '&&': return bit(`((${x} != 64'd0) && (${y} != 64'd0))`);
        case '||': return bit(`((${x} != 64'd0) || (${y} != 64'd0))`);
        case '<<': return fn('sll', x, y); case '>>': return fn('srl', x, y); case '>>>': return fn('sra', x, y);
        case '==': case '!=': case '<': case '<=': case '>': case '>=': return bit(`(${x} ${ast.op} ${y})`);
        default: return `(${x} ${ast.op} ${y})`; // + - * & | ^ : 64-bit operands, 64-bit result
      }
    }
  }
  throw new ExprError(`cannot translate ${ast.k}`);
}

// The SystemVerilog functions toVerilog may call (all 64-bit in, 64-bit out; loops unroll in synthesis)
export const VERILOG_FUNCTIONS = {
  sll: 'function automatic logic [63:0] f_sll(input logic [63:0] x, input logic [63:0] n); return x << n[5:0]; endfunction',
  srl: 'function automatic logic [63:0] f_srl(input logic [63:0] x, input logic [63:0] n); return x >> n[5:0]; endfunction',
  sra: 'function automatic logic [63:0] f_sra(input logic [63:0] x, input logic [63:0] n); return $unsigned($signed(x) >>> n[5:0]); endfunction',
  min: 'function automatic logic [63:0] f_min(input logic [63:0] x, input logic [63:0] y); return ($signed(x) < $signed(y)) ? x : y; endfunction',
  max: 'function automatic logic [63:0] f_max(input logic [63:0] x, input logic [63:0] y); return ($signed(x) > $signed(y)) ? x : y; endfunction',
  minu: 'function automatic logic [63:0] f_minu(input logic [63:0] x, input logic [63:0] y); return (x < y) ? x : y; endfunction',
  maxu: 'function automatic logic [63:0] f_maxu(input logic [63:0] x, input logic [63:0] y); return (x > y) ? x : y; endfunction',
  abs: 'function automatic logic [63:0] f_abs(input logic [63:0] x); return x[63] ? 64\'d0 - x : x; endfunction',
  slt: 'function automatic logic [63:0] f_slt(input logic [63:0] x, input logic [63:0] y); return {63\'d0, $signed(x) < $signed(y)}; endfunction',
  sltu: 'function automatic logic [63:0] f_sltu(input logic [63:0] x, input logic [63:0] y); return {63\'d0, x < y}; endfunction',
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
    let ast = null;
    try { ast = parse(String(d.expr ?? ''), format || 'R'); } catch (e) { err('expr', e.message); }
    if (ast && format) compiled.push({ name, format, funct3: f3, funct7: format === 'R' ? f7 : 0, expr: String(d.expr), desc: String(d.desc || ''), ast, fn: compileJS(ast) });
  });
  return { ok: errors.length === 0, errors, compiled };
}

// The machine word an instruction's fields select: key = funct3 * 128 + funct7 for R, funct3 * 128 for I
export const keyOf = (funct3, funct7) => (funct3 >= 4 ? funct3 * 128 : funct3 * 128 + funct7);

// The active set, shared by the assembler (model/isa.js registers the names) and the core (execute)
let ACTIVE = new Map();
export function setActive(compiled) { ACTIVE = new Map(compiled.map(c => [keyOf(c.funct3, c.funct7), c])); }
export function activeList() { return [...ACTIVE.values()]; }
// What the hardware computes for a custom-0 word: an unassigned funct3 / funct7 gives 0 (Custom_Unit.sv's default)
export function execute(word, a, b) {
  const f3 = (word >>> 12) & 7, f7 = (word >>> 25) & 0x7f;
  const c = ACTIVE.get(keyOf(f3, f7));
  return c ? c.fn(a, b) : 0n;
}

// ---------------------------------------------------------------- the whole module (src/Custom_Unit.sv)
// list: validated instructions ({ name, format, funct3, funct7, expr }). tools/custom.mjs writes the result to
// src/Custom_Unit.sv; web/custom.html shows it.
export function verilogModule(list) {
  const used = new Set();
  const body = list.map((c, i) => ({ c, i, sv: toVerilog(parse(c.expr, c.format), used) }));
  if (used.has('popcount')) used.add('csa7'); // popcount's helper
  const fns = [...used].sort().map(n => VERILOG_FUNCTIONS[n].split('\n').map((l, i, all) => (i === 0 || i === all.length - 1 ? '  ' : '    ') + l.trim()).join('\n')).join('\n');
  const match = c => c.format === 'I' ? `(FUNCT3 == 3'd${c.funct3})` : `(FUNCT3 == 3'd${c.funct3}) && (FUNCT7 == 7'd${c.funct7})`;
  const selects = body.map(({ c, i }) => `  assign SELECT[${i}] = ${match(c)}; // ${c.name}`).join('\n');
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
//   CustomUnit (in MEMORY): every instruction's result in parallel, and an AND-OR keeps the selected one.
//     A is rs1 and B is rs2 or the sign-extended immediate, chosen and forwarded in DECODE like the ALU's
//     and registered at the end of EXECUTE, so this logic has the whole MEMORY cycle to itself. The result
//     goes straight into WRITEBACK_DATA (src/Riscv64.sv); a dependent instruction waits for it in DECODE
//     (CUSTOM_HAZARD_REGISTER1/2). An encoding with no instruction selects nothing and gives 0.
//
${list.map(c => `//   ${c.name.padEnd(10)} ${c.format}  funct3 ${c.funct3}${c.format === 'R' ? `  funct7 ${String(c.funct7).padEnd(3)}` : '            '}  rd = ${c.expr}`).join('\n') || '//   (no custom instructions)'}
// =============================================================================
/* verilator lint_off UNUSEDSIGNAL */
module CustomDecode (
    input  logic [2:0]  FUNCT3,  // instruction bits 14:12
    input  logic [6:0]  FUNCT7,  // instruction bits 31:25 (part of the immediate in I format)
    output logic [31:0] SELECT   // one bit per custom instruction (at most 32)
);
${selects ? selects + '\n' : ''}${list.length < 32 ? `  assign SELECT[31:${list.length}] = '0;\n` : ''}endmodule

module CustomUnit (
    input  logic [63:0] A,       // rs1
    input  logic [63:0] B,       // rs2 (R format) or the sign-extended immediate (I format)
    input  logic [31:0] SELECT,  // from CustomDecode, one stage earlier
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
// "What fits in a cycle"), absdiff, avgu and clampi leave the clock where it was and a 64-bit popcount
// (hamming) just fits, so the budget is about 1.5 adder delays. Shifts by a constant are only wiring, and
// a comparison with 0 is just the sign bit.
export const DEPTH = { add: 1, compare: 1, multiply: 3, counter: 1, popcount: 1.4, shift: 0.5, mux: 0.15, logic: 0.08 };
export const DEPTH_BUDGET = 1.5;
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
      if (f === 'popcount') return inner + DEPTH.popcount; // a 64-input sum (src/Population_Count.sv)
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
