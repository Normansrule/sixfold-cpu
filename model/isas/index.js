// =============================================================================
// model/isas/index.js: three instruction set architectures behind one interface
//
//   ARCHS.riscv   RISC-V RV64 on Sixfold's pipeline (model/core.js)
//   ARCHS.mips    MIPS32 on the classic five-stage pipeline (./mips_core.js)
//   ARCHS.x86     x86-64 on a six-stage micro-op pipeline (./x86_core.js)
//
// Each one: assemble(source) -> image, makeCore(image) -> a core with step(), listing(image) -> rows with
// their bytes split into encoding fields. The cores all report the same way: step() returns
//   { cycle, stages: { NAME: { pc, text, note } }, notes: [...], stall, flush, halt }
// and equation() the cycle equation's terms, which must add up to the cycle count.
//
// The comparison is fair on purpose: ideal one-cycle memory for all three (no caches), Sixfold's
// iterative multiply/divide timing, and Sixfold's baseline gshare predictor (4 history bits) wherever a
// branch is predicted. RISC-V therefore runs Sixfold's BASELINE build with the iterative multiply/divide
// unit (CONFIGS.baseline + iterativeMdu): the other two get no BTB, return stack or tournament either.
// =============================================================================
import { assemble as rvAssemble } from '../asm.js';
import { Core, CONFIGS, STAGES } from '../core.js';
import { decode as rvDecode, disasm as rvDisasm, FORMATS, ABI } from '../isa.js';
import * as mips from './mips.js';
import * as x86 from './x86.js';
import { MipsCore } from './mips_core.js';
import { X86Core } from './x86_core.js';

export const RISCV_COMPARISON_CONFIG = { ...CONFIGS.baseline, iterativeMdu: true };

class RiscvCore { // Sixfold's model, reporting like the other two
  constructor(img) { this.core = new Core(img, RISCV_COMPARISON_CONFIG); this.stageNames = STAGES; }
  get cycle() { return this.core.cycle; }
  get halted() { return this.core.halted; }
  get output() { return this.core.output; }
  get stats() { const s = this.core.stats; return { ...s, cycles: s.cycles, retired: s.retired }; }
  get result() { return Number(BigInt.asIntN(64, this.core.regs[10])); }
  step() {
    const e = this.core.step();
    if (!e) return null;
    const ev = { cycle: e.cycle, stages: {}, notes: [], stall: e.stall ? 'loaduse' : e.busy ? 'muldiv' : null, flush: e.flush, halt: e.halt };
    for (const s of STAGES) if (e.stages[s]) ev.stages[s] = { id: e.stages[s].id, pc: e.stages[s].pc, text: this.core.instrs[e.stages[s].id].text, note: '' };
    if (e.stall) ev.notes.push('load-use stall: DECODE waits for the load in EXECUTE');
    if (e.busy) ev.notes.push('the multiply/divide unit is busy: EXECUTE holds');
    if (e.flush) ev.notes.push(e.resolve && e.resolve.kind === 'jalr' ? 'jalr: the target is known only in EXECUTE: flush' : 'the branch went the other way: flush');
    if (e.redirect) ev.notes.push('FETCH2 sees a jump or a branch guessed taken: redirect');
    if (e.rfWrite) ev.notes.push(`WRITEBACK writes ${ABI[e.rfWrite.rd]} = ${BigInt.asIntN(64, e.rfWrite.value)}`);
    if (e.halt) ev.notes.push('the tohost write reached WRITEBACK: the program is done');
    return ev;
  }
  run(max = 5e6) { this.core.run(max, false); return this; }
  registers() { return this.core.regs.map((v, i) => ({ name: ABI[i], value: v })); }
  equation() {
    const s = this.core.stats, b = s.bubbles;
    return { terms: [['N instructions', s.retired], ['5 to fill', b.fill], ['L load-use', b.loaduse], ['F flush', b.flush], ['R redirect', b.redirect], ['K multiply/divide', b.muldiv]], total: s.cycles };
  }
}

const hex = (v, n = 2) => v.toString(16).padStart(n, '0');
const bitsOf = (w, hi, lo) => ((w >>> lo) & ((2 ** (hi - lo + 1)) - 1)).toString(2).padStart(hi - lo + 1, '0');
const instructionRows = img => img.listing.filter(l => l.kind === 'insn');

export const ARCHS = {
  riscv: {
    id: 'riscv', name: 'RISC-V', full: 'RISC-V RV64 (2010s, open standard)', result: 'a0', dir: 'riscv',
    pipeline: 'Sixfold: FETCH1 FETCH2 DECODE EXECUTE MEMORY WRITEBACK; branches predicted (gshare), resolved in EXECUTE',
    assemble: src => rvAssemble(src),
    makeCore: img => new RiscvCore(img),
    listing: img => img.listing.filter(l => l.word !== undefined).map(l => {
      const d = rvDecode(l.word), w = l.word;
      return { addr: l.addr, size: 4, bytes: [w & 255, (w >>> 8) & 255, (w >>> 16) & 255, (w >>> 24) & 255], text: d.def ? rvDisasm(d, l.addr) : '?', src: l.src, format: d.fmt,
        parts: d.def ? FORMATS[d.fmt].map(([name, hi, lo]) => ({ name, bits: bitsOf(w, hi, lo) })) : [] };
    }),
  },
  mips: {
    id: 'mips', name: 'MIPS', full: 'MIPS32 (1985, Stanford / MIPS Computer Systems)', result: 'v0', dir: 'mips',
    pipeline: 'the classic five stages IF ID EX MEM WB; branches resolved in ID, with a delay slot',
    assemble: src => mips.assemble(src),
    makeCore: img => new MipsCore(img),
    listing: img => instructionRows(img).map(l => {
      const w = (l.bytes[0] | (l.bytes[1] << 8) | (l.bytes[2] << 16) | (l.bytes[3] << 24)) >>> 0, d = mips.decode(w, l.addr);
      return { addr: l.addr, size: 4, bytes: l.bytes, text: d.text, src: l.src, format: d.format, parts: d.fields.map(([name, hi, lo]) => ({ name, bits: bitsOf(w, hi, lo) })) };
    }),
  },
  x86: {
    id: 'x86', name: 'x86-64', full: 'x86-64 (1978 8086, 64-bit since 2003)', result: 'rax', dir: 'x86',
    pipeline: 'FETCH PREDECODE DECODE (into micro-ops) EXECUTE MEMORY WRITEBACK; jumps redirected in DECODE',
    assemble: src => x86.assemble(src),
    makeCore: (img, opts) => new X86Core(img, opts),
    listing: img => instructionRows(img).map(l => {
      const d = x86.decode(a => img.bytes[a & 0xffff], l.addr);
      return { addr: l.addr, size: d.length, bytes: l.bytes, text: d.text, src: l.src, format: `${d.length} bytes, ${d.uops.length} micro-op${d.uops.length > 1 ? 's' : ''}`,
        parts: d.parts.map(p => ({ name: p.name, bits: p.bytes.map(b => hex(b)).join(' '), cls: p.cls })), uops: d.uops.map(u => u.text) };
    }),
  },
};

// Code size of a program: the bytes of its instructions (not its data)
export function codeBytes(arch, img) { return ARCHS[arch].listing(img).reduce((n, r) => n + r.size, 0); }

// Everything the comparison views show about one program on one architecture
export function measure(arch, source, max = 5e6, options) {
  const A = ARCHS[arch], img = A.assemble(source), core = A.makeCore(img, options).run(max);
  const eq = core.equation(), rows = A.listing(img);
  return {
    arch, halted: core.halted, result: core.result, output: core.output, cycles: core.stats.cycles,
    instructions: core.stats.retired, uops: core.stats.uops, staticInstructions: rows.length, codeBytes: rows.reduce((n, r) => n + r.size, 0),
    equation: eq, equationHolds: eq.terms.reduce((n, t) => n + t[1], 0) === eq.total,
  };
}
