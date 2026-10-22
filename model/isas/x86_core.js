// =============================================================================
// model/isas/x86_core.js: a cycle-accurate model of a simple in-order x86-64 pipeline built on micro-ops
//
//   FETCH       reads the next instruction from a 16-byte fetch block; an instruction that crosses into
//               the next block takes a second cycle ("split")
//   PREDECODE   finds where each instruction ends (its length: 1 to 15 bytes): the step fixed-length ISAs
//               do not need
//   DECODE      turns the instruction into micro-ops (./x86.js microOps), one per cycle: an instruction of
//               three micro-ops holds DECODE for three cycles. Direct jumps and calls, and conditional
//               jumps the predictor guesses taken, send FETCH to their target from here ("redirect": the
//               two instructions behind it in FETCH and PREDECODE are dropped)
//   EXECUTE     one micro-op: ALU, address, flags, conditional jumps resolved (wrong guess: "flush" the
//               three front-end stages), indirect jumps and ret (always a flush: no target prediction)
//   MEMORY      loads and stores of micro-ops (ideal one-cycle memory, like the RISC-V comparison build)
//   WRITEBACK   the micro-op retires; an instruction retires with its last micro-op
//
// The same comparison rules as the other two models: the predictor is Sixfold's baseline gshare (4 history
// bits), multiply and divide occupy EXECUTE for Sixfold's iterative unit's steps (model/core.js), memory
// answers in one cycle. Every cycle WRITEBACK retires one micro-op or a bubble with its cause, so
//   cycles = U (micro-ops) + 5 (fill) + L (load-use) + F (flush) + R (redirect) + K (multiply/divide) + S (split)
// The architectural effects of an instruction happen in program order when its first micro-op executes.
// =============================================================================
import { decode, REGS64, REGS8, CONDITIONS, RESULT_REGISTER } from './x86.js';
import { GShare, multiplyDivideSteps } from '../core.js';

// Macro-fusion (off unless the core is made with { macroFusion: true }): real x86 decoders merge a flag-setting
// instruction and the conditional jump right behind it (cmp rcx, 100 + jle loop) into ONE micro-op that
// compares and branches, the way a RISC-V blt does in one instruction. In this pipeline the pair then
// takes one EXECUTE slot instead of two, and a jump guessed taken redirects FETCH one cycle earlier.
// The pipeline only offers pairs where the first instruction is one micro-op and the second a conditional
// jump; this function decides which of those a decoder can really fuse.
//   first, second: decoded instructions (./x86.js decode): .mn ('cmp', 'jle', ...), .dst and .src operands
//                  ({ type: 'reg' | 'mem' | 'imm', ... }), and for the jump .cc, its condition (CONDITIONS[cc]:
//                  'e', 'ne', 'l', 'le', 'g', 'ge', 'b', 'ae', 'a', 'be', 's', 'ns', 'o', 'no', ...)
export function canMacroFuse(first, second) {
  // TODO: which pairs fuse? (see docs/EXPERIMENTS.md, Lab 24)
  return false;
}

export const X86_STAGES = ['FETCH', 'PREDECODE', 'DECODE', 'EXECUTE', 'MEMORY', 'WRITEBACK'];
const BUBBLE = cause => ({ bubble: true, cause });
const M64 = (1n << 64n) - 1n;
const mask = size => (size === 1 ? 0xffn : M64);
const signBit = size => (size === 1 ? 0x80n : 1n << 63n);
const toSigned = (v, size) => BigInt.asIntN(size * 8, v);

export class X86Core {
  constructor(img, { historyBits = 4, macroFusion = false } = {}) {
    this.macroFusion = macroFusion;
    this.mem = new Uint8Array(65536);
    this.mem.set((img.bytes || img).slice(0, 65536));
    this.regs = new Array(16).fill(0n);
    this.flags = { cf: false, zf: false, sf: false, of: false };
    this.fetchPc = 0x2000; this.splitPending = false; this.draining = false;
    this.pdSlot = BUBBLE('fill'); this.dSlot = BUBBLE('fill'); this.eSlot = BUBBLE('fill'); this.mSlot = BUBBLE('fill'); this.wSlot = BUBBLE('fill');
    this.eBusy = 0;
    this.bp = new GShare(historyBits, true);
    this.cycle = 0; this.halted = false; this.output = ''; this.nextId = 0; this.instrs = [];
    this.stats = { cycles: 0, retired: 0, uops: 0, branches: 0, mispredicts: 0, codeBytes: 0, bubbles: { fill: 0, loaduse: 0, flush: 0, redirect: 0, muldiv: 0, split: 0, fused: 0 }, fusedPairs: 0 };
  }
  get stageNames() { return X86_STAGES; }
  read8(a) { return this.mem[Number(BigInt.asUintN(64, BigInt(a)) & 0xffffn)]; }
  isDevice(addr) { return (addr >> 8n) === 0x100000n; }
  load(addr, size) {
    if (this.isDevice(addr)) return 0n;
    let v = 0n; for (let k = size - 1; k >= 0; k--) v = (v << 8n) | BigInt(this.mem[Number((addr + BigInt(k)) & 0xffffn)]);
    return v;
  }
  store(addr, size, v) {
    if (this.isDevice(addr)) { if (addr === 0x10000000n) this.output += String.fromCharCode(Number(v & 0xffn)); return; }
    for (let k = 0; k < size; k++) this.mem[Number((addr + BigInt(k)) & 0xffffn)] = Number((v >> BigInt(8 * k)) & 0xffn);
  }
  fetchInstruction(pc) { // the same instruction (same identity) until it moves on to PREDECODE
    if (this.fetchCache && this.fetchCache.pc === pc) return this.fetchCache;
    const d = decode(a => this.read8(a), pc);
    const id = this.nextId++;
    this.instrs[id] = { pc, text: d.text };
    this.fetchCache = { id, pc, d, next: (pc + d.length) >>> 0 };
    return this.fetchCache;
  }

  // ---------------- architectural semantics (one whole instruction)
  address(o) { let a = BigInt(o.disp || 0n); if (o.base !== null && o.base !== undefined) a += this.regs[o.base]; if (o.index !== null && o.index !== undefined) a += this.regs[o.index] * BigInt(o.scale); return BigInt.asUintN(64, a); }
  read(o) {
    if (o.type === 'imm') return BigInt.asUintN(64, o.value);
    if (o.type === 'reg') return o.size === 1 ? this.regs[o.n] & 0xffn : this.regs[o.n];
    return this.load(this.address(o), o.size || 8);
  }
  write(o, v) {
    v = BigInt.asUintN(64, v) & mask(o.size || 8);
    if (o.type === 'reg') { this.regs[o.n] = o.size === 1 ? (this.regs[o.n] & ~0xffn) | v : v; return; }
    this.store(this.address(o), o.size || 8, v);
  }
  setLogic(r, size) { const f = this.flags; f.cf = false; f.of = false; f.zf = (r & mask(size)) === 0n; f.sf = (r & signBit(size)) !== 0n; }
  condition(cc) {
    const f = this.flags;
    switch (CONDITIONS[cc]) {
      case 'o': return f.of; case 'no': return !f.of; case 'b': return f.cf; case 'ae': return !f.cf; case 'e': return f.zf; case 'ne': return !f.zf;
      case 'be': return f.cf || f.zf; case 'a': return !f.cf && !f.zf; case 's': return f.sf; case 'ns': return !f.sf;
      case 'l': return f.sf !== f.of; case 'ge': return f.sf === f.of; case 'le': return f.zf || f.sf !== f.of; case 'g': return !f.zf && f.sf === f.of;
      default: return false; // parity is not modelled
    }
  }
  execute(instr) {
    const d = instr.d, f = this.flags, mn = d.mn;
    const size = d.dst ? (d.dst.size || 8) : 8, m = mask(size), sb = signBit(size);
    const addsub = (a, b, sub) => { const r = (sub ? a - b : a + b) & m; f.cf = sub ? a < b : a + b > m; f.zf = r === 0n; f.sf = (r & sb) !== 0n; f.of = sub ? ((a ^ b) & (a ^ r) & sb) !== 0n : (~(a ^ b) & (a ^ r) & sb) !== 0n; return r; };
    const out = { next: instr.next };
    switch (mn) {
      case 'mov': this.write(d.dst, this.read(d.src) & m); break;
      case 'movzx': this.write(d.dst, this.read(d.src) & 0xffn); break;
      case 'lea': this.write(d.dst, this.address(d.src)); break;
      case 'add': case 'sub': case 'cmp': { const a = this.read(d.dst) & m, b = this.read(d.src) & m, r = addsub(a, b, mn !== 'add'); if (mn !== 'cmp') this.write(d.dst, r); break; }
      case 'and': case 'or': case 'xor': case 'test': { const a = this.read(d.dst), b = this.read(d.src); const r = (mn === 'or' ? a | b : mn === 'xor' ? a ^ b : a & b) & m; this.setLogic(r, size); if (mn !== 'test') this.write(d.dst, r); break; }
      case 'inc': case 'dec': { const cf = f.cf; const r = addsub(this.read(d.dst) & m, 1n, mn === 'dec'); f.cf = cf; this.write(d.dst, r); break; }
      case 'neg': { const a = this.read(d.dst) & m, r = (-a) & m; f.cf = a !== 0n; f.of = a === sb; f.zf = r === 0n; f.sf = (r & sb) !== 0n; this.write(d.dst, r); break; }
      case 'not': this.write(d.dst, ~this.read(d.dst) & m); break;
      case 'shl': case 'shr': case 'sar': {
        const n = Number(this.read(d.count) & 63n); if (!n) break;
        const a = this.read(d.dst) & m; let r;
        if (mn === 'shl') { r = (a << BigInt(n)) & m; f.cf = ((a >> BigInt(size * 8 - n)) & 1n) === 1n; }
        else if (mn === 'shr') { r = a >> BigInt(n); f.cf = ((a >> BigInt(n - 1)) & 1n) === 1n; }
        else { r = BigInt.asUintN(size * 8, toSigned(a, size) >> BigInt(n)); f.cf = ((toSigned(a, size) >> BigInt(n - 1)) & 1n) === 1n; }
        f.zf = r === 0n; f.sf = (r & sb) !== 0n; f.of = false; this.write(d.dst, r); break;
      }
      case 'imul':
        if (d.oneOperand) { const p = BigInt.asIntN(64, this.regs[0]) * BigInt.asIntN(64, this.read(d.src)); this.regs[0] = BigInt.asUintN(64, p); this.regs[2] = BigInt.asUintN(64, p >> 64n); f.cf = f.of = p !== BigInt.asIntN(64, p); }
        else { const b = d.imm3 ? BigInt.asIntN(64, BigInt.asUintN(64, d.imm3.value)) : BigInt.asIntN(64, this.read(d.src)); const a = d.imm3 ? BigInt.asIntN(64, this.read(d.src)) : BigInt.asIntN(64, this.regs[d.dst.n]); const p = a * b; this.regs[d.dst.n] = BigInt.asUintN(64, p); f.cf = f.of = p !== BigInt.asIntN(64, p); }
        break;
      case 'mul': { const p = this.regs[0] * this.read(d.src); this.regs[0] = p & M64; this.regs[2] = p >> 64n; f.cf = f.of = this.regs[2] !== 0n; break; }
      case 'div': case 'idiv': {
        const b = this.read(d.src); if (b === 0n) throw new Error(`divide by zero at 0x${instr.pc.toString(16)}`);
        if (mn === 'div') { const a = (this.regs[2] << 64n) | this.regs[0]; this.regs[0] = (a / b) & M64; this.regs[2] = a % b; }
        else { const a = BigInt.asIntN(128, (this.regs[2] << 64n) | this.regs[0]), bs = BigInt.asIntN(64, b); this.regs[0] = BigInt.asUintN(64, a / bs); this.regs[2] = BigInt.asUintN(64, a % bs); }
        break;
      }
      case 'cqo': this.regs[2] = (this.regs[0] >> 63n) ? M64 : 0n; break;
      case 'push': this.regs[4] = BigInt.asUintN(64, this.regs[4] - 8n); this.store(this.regs[4], 8, this.regs[d.dst.n]); break;
      case 'pop': this.regs[d.dst.n] = this.load(this.regs[4], 8); this.regs[4] = BigInt.asUintN(64, this.regs[4] + 8n); break;
      case 'call': { const t = d.indirect ? Number(this.read(d.src) & 0xffffffffn) : d.target; this.regs[4] = BigInt.asUintN(64, this.regs[4] - 8n); this.store(this.regs[4], 8, BigInt(instr.next)); out.next = t; out.jump = true; break; }
      case 'ret': out.next = Number(this.load(this.regs[4], 8) & 0xffffffffn); this.regs[4] = BigInt.asUintN(64, this.regs[4] + 8n); out.jump = true; break;
      case 'jmp': out.next = d.indirect ? Number(this.read(d.src) & 0xffffffffn) : d.target; out.jump = true; break;
      case 'nop': case 'hlt': break;
      default:
        if (d.cc !== undefined && mn.startsWith('j')) { out.taken = this.condition(d.cc); out.next = out.taken ? d.target : instr.next; break; }
        if (mn.startsWith('cmov')) { if (this.condition(d.cc)) this.write(d.dst, this.read(d.src)); break; }
        if (mn.startsWith('set')) { this.write(d.dst, this.condition(d.cc) ? 1n : 0n); break; }
        throw new Error(`cannot execute "${d.text}" at 0x${instr.pc.toString(16)}`);
    }
    return out;
  }

  step() {
    if (this.halted) return null;
    this.cycle++; this.stats.cycles = this.cycle;
    const ev = { cycle: this.cycle, stages: {}, notes: [], stall: null };
    const showUop = (stage, x) => { if (x && !x.bubble) ev.stages[stage] = { id: x.instr.id, pc: x.instr.pc, text: x.instr.d.text + (x.pair ? ` + ${x.pair.d.text}` : ''), note: x.pair ? 'one fused micro-op: compare and branch' : x.instr.d.uops.length > 1 ? `uop ${x.idx + 1}/${x.instr.d.uops.length}: ${x.u.text}` : x.u.text }; };
    const { pdSlot, dSlot, eSlot, mSlot, wSlot } = this;

    // ---------------- WRITEBACK
    showUop('WRITEBACK', wSlot);
    if (wSlot.bubble) this.stats.bubbles[wSlot.cause]++;
    else {
      this.stats.uops++;
      if (wSlot.last) { this.stats.retired += wSlot.pair ? 2 : 1; if (wSlot.instr.d.mn === 'hlt') { this.halted = true; ev.halt = true; ev.notes.push('hlt retired: the program is done'); return ev; } }
    }
    // ---------------- MEMORY
    showUop('MEMORY', mSlot);
    if (!mSlot.bubble && (mSlot.u.kind === 'load' || mSlot.u.kind === 'store')) ev.notes.push(`MEMORY: ${mSlot.u.text}`);

    // ---------------- EXECUTE
    showUop('EXECUTE', eSlot);
    let mNew = eSlot, eHeld = false, flushTo = null;
    if (!eSlot.bubble) {
      const x = eSlot, instr = x.instr;
      const dividend = this.regs[0]; // (before the instruction overwrites rax)
      if (x.idx === 0 && !x.executed) { instr.outcome = this.execute(instr); x.executed = true; instr.dividend = dividend; if (x.pair) x.pair.outcome = this.execute(x.pair); }
      if (x.u.muldiv && !x.started) { // the same timing as Sixfold's iterative unit: its steps, plus 4 cycles in all
        x.started = true;
        const d = instr.d, isDiv = d.mn === 'div' || d.mn === 'idiv';
        this.eBusy = multiplyDivideSteps(isDiv ? (d.mn === 'div' ? 'DIVU' : 'DIV') : 'MUL', false, isDiv ? instr.dividend : 0n) + 3;
      }
      if (this.eBusy > 0) { this.eBusy--; eHeld = true; mNew = BUBBLE('muldiv'); ev.notes.push(`EXECUTE: the multiply/divide unit is busy (${this.eBusy + 1} more)`); }
      else if (x.last) {
        const br = x.pair || instr, o = br.outcome; // a fused pair resolves its jump here too
        if (br.d.cc !== undefined && br.d.mn.startsWith('j')) {
          this.stats.branches++;
          const t = this.bp.train(br.bpIdx, o.taken);
          if (o.taken !== br.predTaken) { this.stats.mispredicts++; flushTo = o.next; this.bp.ghr = ((br.ghrCheckpoint << 1) | (o.taken ? 1 : 0)) & this.bp.mask; ev.notes.push(`EXECUTE: ${br.d.mn} ${o.taken ? 'taken' : 'not taken'}, guessed wrong (counter ${t.before} -> ${t.after}): flush`); }
          else ev.notes.push(`EXECUTE: ${br.d.mn} ${o.taken ? 'taken' : 'not taken'}, guessed right`);
        } else if (x.u.kind === 'jump' && x.u.indirect) { flushTo = o.next; ev.notes.push(`EXECUTE: ${instr.d.mn} goes to 0x${o.next.toString(16)}, known only now: flush`); }
      }
    }
    if (flushTo !== null) ev.flush = true;

    // ---------------- DECODE (micro-ops into EXECUTE)
    let eNew = eSlot, dNew = dSlot, pdNew = pdSlot, redirectTo = null, dAccepts = false;
    if (this.draining && !eHeld) eNew = BUBBLE('fill');
    if (flushTo !== null) {
      eNew = BUBBLE('flush'); dNew = BUBBLE('flush'); pdNew = BUBBLE('flush');
      this.fetchPc = flushTo; this.splitPending = false; this.draining = false; this.fetchCache = null;
    } else if (eHeld) {
      ev.stall = 'muldiv';
    } else if (this.draining) {
      // hlt has been issued: nothing younger may run
    } else if (dSlot.bubble) {
      eNew = BUBBLE(dSlot.cause); dAccepts = true;
    } else {
      const instr = dSlot.instr, idx = dSlot.idx, u = instr.d.uops[idx];
      ev.stages.DECODE = { id: instr.id, pc: instr.pc, text: instr.d.text, note: instr.d.uops.length > 1 ? `uop ${idx + 1}/${instr.d.uops.length}: ${u.text}` : u.text };
      // macro-fusion: a one-micro-op instruction and the conditional jump waiting in PREDECODE become one micro-op
      const inE = !eSlot.bubble && !eHeld ? eSlot : null;
      const loadUse = inE && inE.u.kind === 'load' && inE.u.writes.some(r => u.reads.includes(r));
      let pair = null;
      if (this.macroFusion && !loadUse && idx === 0 && instr.d.uops.length === 1 && !pdSlot.bubble && pdSlot.instr.d.cc !== undefined && pdSlot.instr.d.mn.startsWith('j') && canMacroFuse(instr.d, pdSlot.instr.d)) pair = pdSlot.instr;
      if (idx === 0 && !dSlot.decided && !(pair === null && this.macroFusion && loadUse)) { // first cycle in DECODE: is it a jump whose target we know?
        dSlot.decided = true;
        const d = pair ? pair.d : instr.d, bi = pair || instr;
        if (pair) ev.notes.push(`DECODE: ${instr.d.text} and ${d.text} fuse into one micro-op`);
        if ((d.mn === 'jmp' || d.mn === 'call') && !d.indirect) { redirectTo = d.target; ev.notes.push(`DECODE: ${d.mn} to 0x${d.target.toString(16)}: redirect FETCH`); }
        else if (d.cc !== undefined && d.mn.startsWith('j')) {
          const p = this.bp.predict(bi.pc);
          bi.predTaken = p.taken; bi.bpIdx = p.idx; bi.ghrCheckpoint = this.bp.ghr;
          this.bp.ghr = ((this.bp.ghr << 1) | (p.taken ? 1 : 0)) & this.bp.mask;
          if (p.taken) { redirectTo = d.target; ev.notes.push(`DECODE: ${d.mn} guessed taken (counter ${p.counter}): redirect FETCH`); }
          else ev.notes.push(`DECODE: ${d.mn} guessed not taken (counter ${p.counter})`);
        }
      }
      if (loadUse) {
        eNew = BUBBLE('loaduse'); ev.stall = 'loaduse'; ev.notes.push(`load-use: "${u.text}" needs what the load in EXECUTE is still fetching`);
      } else {
        const last = idx === instr.d.uops.length - 1;
        eNew = pair ? { instr, u, idx, last, pair } : { instr, u, idx, last };
        if (pair) { this.stats.fusedPairs++; this.fusedFromPd = true; }
        if (instr.d.mn === 'hlt') this.draining = true;
        if (last) dAccepts = true; else dNew = { ...dSlot, idx: idx + 1 };
      }
    }
    // ---------------- PREDECODE and FETCH: they move into empty slots, or when DECODE takes its next instruction
    if (flushTo === null && !eHeld && !this.draining) {
      if (redirectTo !== null) {
        if (dAccepts) dNew = BUBBLE('redirect');
        pdNew = BUBBLE('redirect');
        this.fetchPc = redirectTo; this.splitPending = false; this.fetchCache = null;
      } else {
        // (after a fused pair, PREDECODE's instruction went into DECODE's micro-op: DECODE gets a gap, because
        // the front end delivers one instruction a cycle)
        if (dAccepts) dNew = this.fusedFromPd ? BUBBLE('fused') : pdSlot.bubble ? pdSlot : { instr: pdSlot.instr, idx: 0 };
        const pdFree = dAccepts || pdSlot.bubble;
        if (pdFree) {
          const instr = this.fetchInstruction(this.fetchPc);
          const crosses = (this.fetchPc & 15) + instr.d.length > 16;
          if (crosses && !this.splitPending) { pdNew = BUBBLE('split'); this.splitPending = true; ev.stages.FETCH = { id: instr.id, pc: instr.pc, text: instr.d.text, note: 'crosses a 16-byte block: second fetch next cycle' }; }
          else { pdNew = { instr }; this.splitPending = false; this.fetchPc = instr.next; this.fetchCache = null; ev.stages.FETCH = { id: instr.id, pc: instr.pc, text: instr.d.text, note: `${instr.d.length} bytes` }; }
        }
      }
    }
    if (!pdSlot.bubble) ev.stages.PREDECODE = { id: pdSlot.instr.id, pc: pdSlot.instr.pc, text: pdSlot.instr.d.text, note: `length ${pdSlot.instr.d.length}` };
    if (!ev.stages.FETCH && !this.halted) ev.stages.FETCH = { id: -1, pc: this.fetchPc, text: '(held)', note: '' };

    this.fusedFromPd = false;
    this.wSlot = mSlot; this.mSlot = eHeld ? BUBBLE('muldiv') : mNew;
    if (!eHeld) this.eSlot = eNew;
    this.dSlot = dNew; this.pdSlot = pdNew;
    return ev;
  }
  run(max = 5e6) { while (!this.halted && this.cycle < max) this.step(); return this; }
  registers() { return [...this.regs.map((v, i) => ({ name: REGS64[i], value: v })), { name: 'flags', value: `${this.flags.zf ? 'Z' : '-'}${this.flags.sf ? 'S' : '-'}${this.flags.cf ? 'C' : '-'}${this.flags.of ? 'O' : '-'}` }]; }
  get result() { return Number(BigInt.asIntN(64, this.regs[RESULT_REGISTER])); }
  equation() {
    const s = this.stats, b = s.bubbles;
    return { terms: [['U micro-ops', s.uops], ['5 to fill', b.fill], ['L load-use', b.loaduse], ['F flush', b.flush], ['R redirect', b.redirect], ['K multiply/divide', b.muldiv], ['S split fetch', b.split], ...(this.macroFusion ? [['G gap after a fused pair', b.fused]] : [])], total: s.cycles };
  }
}
export { REGS8 };
