// =============================================================================
// model/isas/asm_common.js: the two-pass assembler shared by the MIPS and x86-64 models
//
// Labels, directives and expressions work exactly as in model/asm.js (the RISC-V assembler):
//   label:   .equ / .set NAME, value   .org   .align n (2^n)   .balign n   .zero n
//   .byte .half .short .word .long .dword .quad   .string .asciz .ascii   (.text .data .globl ignored)
// Each architecture supplies one function, instruction(mnemonic, operands, symbols), which returns the
// instruction(s) a line becomes: [{ size, emit(symbols, pc) -> [bytes] }]. The size must be known in pass 1
// (when later labels are still unknown), so an encoding may depend on a constant's value but never on a
// label's: x86 jumps, for example, always use a 32-bit displacement here.
// =============================================================================
import { stripComment, splitOperands, unescape, evalExpr, RESET_PC } from '../asm.js';

export { evalExpr };

export function assembleProgram(source, instruction, { start = RESET_PC, littleEndian = true } = {}) {
  const lines = source.split(/\r?\n/);
  const symbols = {};
  const items = [];
  const errors = [];
  let pc = start;
  const dataItem = (lineNo, src, size, make) => { items.push({ kind: 'data', addr: pc, size, line: lineNo, src, make }); pc += size; };

  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    try {
      let s = stripComment(raw), m;
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
          case '.text': case '.data': case '.globl': case '.global': case '.section': case '.option': case '.intel_syntax': return;
          case '.set': if (ops.length < 2) return; // ".set noreorder" and friends: no effect here
          // fallthrough
          case '.equ': symbols[ops[0]] = Number(evalExpr(ops[1], symbols)); return;
          case '.org': pc = Number(evalExpr(ops[0], symbols)); return;
          case '.align': case '.p2align': case '.balign': {
            const a = mn === '.balign' ? Number(evalExpr(ops[0], symbols)) : 1 << Number(evalExpr(ops[0], symbols));
            const pad = (a - (pc % a)) % a;
            if (pad) dataItem(lineNo, raw.trim(), pad, () => new Array(pad).fill(0));
            return;
          }
          case '.zero': case '.space': { const n = Number(evalExpr(ops[0], symbols)); dataItem(lineNo, raw.trim(), n, () => new Array(n).fill(0)); return; }
          case '.byte': case '.half': case '.short': case '.word': case '.long': case '.dword': case '.quad': {
            const size = { '.byte': 1, '.half': 2, '.short': 2, '.word': 4, '.long': 4, '.dword': 8, '.quad': 8 }[mn];
            dataItem(lineNo, raw.trim(), size * ops.length, sym => ops.flatMap(o => {
              let v = BigInt.asUintN(size * 8, evalExpr(o, sym)); const out = [];
              for (let b = 0; b < size; b++) { out.push(Number(v & 0xffn)); v >>= 8n; }
              return littleEndian ? out : out.reverse();
            }));
            return;
          }
          case '.string': case '.asciz': case '.ascii': {
            const out = [];
            for (const o of ops) {
              const mm = o.match(/^"(.*)"$/); if (!mm) throw new Error(`expected a string, got ${o}`);
              for (const ch of unescape(mm[1])) out.push(ch.charCodeAt(0) & 0xff);
              if (mn !== '.ascii') out.push(0);
            }
            dataItem(lineNo, raw.trim(), out.length, () => out);
            return;
          }
          default: throw new Error(`unknown directive ${mn}`);
        }
      }
      const parts = instruction(mn, splitOperands(rest), symbols);
      parts.forEach((p, k) => { items.push({ kind: 'insn', addr: pc, size: p.size, line: lineNo, src: k === 0 ? raw.trim() : '(expansion)', emit: p.emit }); pc += p.size; });
    } catch (e) { errors.push(`line ${lineNo}: ${e.message}\n    ${raw.trim()}`); }
  });
  if (errors.length) throw new Error(errors.join('\n'));

  const bytes = new Uint8Array(65536);
  const listing = [];
  let lo = Infinity, hi = 0;
  for (const it of items) {
    try {
      const b = it.kind === 'insn' ? it.emit(symbols, it.addr) : it.make(symbols);
      if (b.length !== it.size) throw new Error(`internal: encoded ${b.length} bytes, sized ${it.size}`);
      b.forEach((x, k) => { bytes[(it.addr + k) & 0xffff] = x; });
      listing.push({ addr: it.addr, size: it.size, bytes: b, src: it.src, line: it.line, kind: it.kind });
      if (it.size) { lo = Math.min(lo, it.addr); hi = Math.max(hi, it.addr + it.size); }
    } catch (e) { errors.push(`line ${it.line}: ${e.message}\n    ${it.src}`); }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return { bytes, used: [lo === Infinity ? start : lo, hi || start], listing, symbols };
}

// a value as a signed BigInt, or (pass 1, a label not yet defined) null
export function constantOrNull(expr, symbols) {
  try { return evalExpr(expr, symbols, false); } catch { return null; }
}
