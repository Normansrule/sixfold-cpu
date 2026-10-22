// =============================================================================
// model/isas/mips_core.js: a cycle-accurate model of the classic MIPS five-stage pipeline
//
//   IF  fetch at PC                       EX   ALU (operands forwarded from MEM and WB)
//   ID  decode, read registers, and       MEM  loads and stores (one cycle: ideal memory, like the
//       resolve branches and jumps             RISC-V comparison build)
//       (compare in ID: the next          WB   write the register file
//       instruction, already being
//       fetched, is the DELAY SLOT)
//
// Hazards, each a one-cycle bubble into EX with its cause:
//   load-use   the instruction in ID reads the register a load in EX is still fetching
//   branch     a branch or jr in ID needs a value still being computed in EX (or loaded in MEM): it
//              compares in ID, a stage earlier than an ALU instruction would need it
//   hi/lo      mfhi / mflo (or a new mult / div) while the multiply/divide unit is still busy. It runs
//              beside the pipeline: independent instructions keep flowing while it works, which is
//              what HI and LO were invented for. Its latency follows Sixfold's iterative unit
//              (model/core.js multiplyDivideSteps: 4 steps for a multiply, one per dividend bit for a
//              divide) plus the same 4 cycles of setup, so the comparison is fair.
// So cycles = N + 4 + L + B + H, where N counts every instruction that reached WB (delay-slot nops too).
// A taken branch costs nothing: its delay slot is the instruction behind it. The price is paid in
// instructions instead: an unfilled delay slot holds a nop.
// =============================================================================
import { decode, REGISTER_NAMES, RESULT_REGISTER } from './mips.js';
import { multiplyDivideSteps } from '../core.js';

export const MIPS_STAGES = ['IF', 'ID', 'EX', 'MEM', 'WB'];
const MMIO_PAGE = 0x100000; // address >>> 8 for 0x1000_0000 .. 0x1000_00FF (PUTCHAR at 0x1000_0000)
const BUBBLE = cause => ({ bubble: true, cause });

export class MipsCore {
  constructor(img) {
    this.mem = new Uint8Array(65536);
    this.mem.set((img.bytes || img).slice(0, 65536));
    this.regs = new Array(32).fill(0); // unsigned 32-bit values
    this.hi = 0; this.lo = 0; this.hiloReady = 0;
    this.fetchPc = 0x2000;
    this.ifId = BUBBLE('fill'); this.idEx = BUBBLE('fill'); this.exMem = BUBBLE('fill'); this.memWb = BUBBLE('fill');
    this.cycle = 0; this.halted = false; this.output = ''; this.nextId = 0; this.instrs = [];
    this.stats = { cycles: 0, retired: 0, branches: 0, taken: 0, delaySlotNops: 0, loads: 0, stores: 0, bubbles: { fill: 0, loaduse: 0, branch: 0, hilo: 0 } };
  }
  get stageNames() { return MIPS_STAGES; }
  load(addr, size, signed) {
    if ((addr >>> 8) === MMIO_PAGE) return 0;
    let v = 0; for (let k = size - 1; k >= 0; k--) v = (v << 8) | this.mem[(addr + k) & 0xffff];
    if (signed && size < 4) v = (v << (32 - 8 * size)) >> (32 - 8 * size);
    return v >>> 0;
  }
  store(addr, size, value) {
    if ((addr >>> 8) === MMIO_PAGE) { if (addr === 0x10000000) this.output += String.fromCharCode(value & 0xff); return; }
    for (let k = 0; k < size; k++) this.mem[(addr + k) & 0xffff] = (value >>> (8 * k)) & 0xff;
  }
  word(pc) { return this.load(pc, 4, false); }

  step() {
    if (this.halted) return null;
    this.cycle++; this.stats.cycles = this.cycle;
    const ev = { cycle: this.cycle, stages: {}, notes: [], stall: null };
    const show = (stage, x, note) => { if (x && !x.bubble) ev.stages[stage] = { id: x.id, pc: x.pc, text: x.d.text, note }; };
    const ifId = this.ifId, idEx = this.idEx, exMem = this.exMem, memWb = this.memWb;

    // ---------------- WB: write the register file (first, so ID reads what WB writes this cycle)
    show('WB', memWb);
    if (memWb.bubble) this.stats.bubbles[memWb.cause]++;
    else {
      if (memWb.d.dst) { this.regs[memWb.d.dst] = memWb.result >>> 0; ev.notes.push(`WB writes $${REGISTER_NAMES[memWb.d.dst]} = ${memWb.result | 0}`); }
      this.stats.retired++;
      if (memWb.d.kind === 'break') { this.halted = true; ev.halt = true; ev.notes.push('break reached WB: the program is done'); return ev; }
    }

    // ---------------- MEM
    show('MEM', exMem);
    let memOut = exMem;
    if (!exMem.bubble) {
      const d = exMem.d, a = exMem.address;
      if (d.kind === 'load') {
        const size = d.mn === 'lw' ? 4 : d.mn.startsWith('lh') ? 2 : 1;
        memOut = { ...exMem, result: this.load(a, size, !d.mn.endsWith('u')) }; this.stats.loads++;
        ev.notes.push(`MEM loads ${memOut.result | 0} from 0x${a.toString(16)}`);
      } else if (d.kind === 'store') {
        const size = d.mn === 'sw' ? 4 : d.mn === 'sh' ? 2 : 1;
        this.store(a, size, exMem.storeValue); this.stats.stores++;
        ev.notes.push(`MEM stores ${exMem.storeValue | 0} to 0x${a.toString(16)}`);
      }
    }

    // ---------------- EX: operands forwarded from the instructions now in MEM and WB
    show('EX', idEx);
    const forward = (r, why) => {
      if (r === 0) return 0;
      if (!exMem.bubble && exMem.d.dst === r && exMem.d.kind !== 'load') { if (why) ev.notes.push(`EX: $${REGISTER_NAMES[r]} forwarded from MEM`); return exMem.result; }
      if (!memWb.bubble && memWb.d.dst === r) { if (why) ev.notes.push(`EX: $${REGISTER_NAMES[r]} forwarded from WB`); return memWb.result; }
      return this.regs[r];
    };
    let exOut = idEx;
    if (!idEx.bubble) {
      const d = idEx.d, x = { ...idEx };
      const s = forward(d.rs, d.src.includes(d.rs)), t = forward(d.rt, d.src.includes(d.rt));
      switch (d.mn) {
        case 'add': case 'addu': x.result = (s + t) >>> 0; break;
        case 'sub': case 'subu': x.result = (s - t) >>> 0; break;
        case 'and': x.result = (s & t) >>> 0; break;
        case 'or': x.result = (s | t) >>> 0; break;
        case 'xor': x.result = (s ^ t) >>> 0; break;
        case 'nor': x.result = (~(s | t)) >>> 0; break;
        case 'slt': x.result = (s | 0) < (t | 0) ? 1 : 0; break;
        case 'sltu': x.result = s < t ? 1 : 0; break;
        case 'sll': x.result = (t << d.shamt) >>> 0; break;
        case 'srl': x.result = t >>> d.shamt; break;
        case 'sra': x.result = (t >> d.shamt) >>> 0; break;
        case 'sllv': x.result = (t << (s & 31)) >>> 0; break;
        case 'srlv': x.result = t >>> (s & 31); break;
        case 'srav': x.result = ((t | 0) >> (s & 31)) >>> 0; break;
        case 'addi': case 'addiu': x.result = (s + d.imm) >>> 0; break;
        case 'slti': x.result = (s | 0) < d.imm ? 1 : 0; break;
        case 'sltiu': x.result = s < (d.imm >>> 0) ? 1 : 0; break;
        case 'andi': x.result = s & (d.word & 0xffff); break;
        case 'ori': x.result = (s | (d.word & 0xffff)) >>> 0; break;
        case 'xori': x.result = (s ^ (d.word & 0xffff)) >>> 0; break;
        case 'lui': x.result = ((d.word & 0xffff) << 16) >>> 0; break;
        case 'mul': x.result = Number(BigInt.asUintN(32, BigInt(s | 0) * BigInt(t | 0))); break;
        case 'mfhi': x.result = this.hi; break;
        case 'mflo': x.result = this.lo; break;
        case 'mthi': this.hi = s; break;
        case 'mtlo': this.lo = s; break;
        case 'mult': case 'multu': case 'div': case 'divu': {
          const signed = !d.mn.endsWith('u');
          const A = signed ? BigInt(s | 0) : BigInt(s), B = signed ? BigInt(t | 0) : BigInt(t);
          if (d.mn.startsWith('mult')) { const p = BigInt.asUintN(64, A * B); this.lo = Number(p & 0xffffffffn); this.hi = Number(p >> 32n); }
          else if (B !== 0n) { this.lo = Number(BigInt.asUintN(32, A / B)); this.hi = Number(BigInt.asUintN(32, A % B)); }
          const steps = multiplyDivideSteps(d.mn.startsWith('mult') ? 'MUL' : signed ? 'DIV' : 'DIVU', true, BigInt.asUintN(64, A));
          this.hiloReady = this.cycle + steps + 4;
          ev.notes.push(`EX starts ${d.mn}: HI and LO ready in ${steps + 4} cycles; the pipeline keeps going`);
          break;
        }
        default:
          if (d.kind === 'load' || d.kind === 'store') { x.address = (s + d.imm) >>> 0; if (d.kind === 'store') x.storeValue = t; }
          if (d.link) x.result = (idEx.pc + 8) >>> 0; // jal / jalr: the return address skips the delay slot
      }
      exOut = x;
    }

    // ---------------- ID: decode, hazards, and branches (resolved here: the delay slot is being fetched now)
    show('ID', ifId);
    let stall = null, redirect = null;
    if (!ifId.bubble) {
      const d = ifId.d;
      const inEx = r => r && !idEx.bubble && idEx.d.dst === r;                              // being computed this cycle
      const loadInEx = r => inEx(r) && idEx.d.kind === 'load';
      const loadInMem = r => r && !exMem.bubble && exMem.d.dst === r && exMem.d.kind === 'load';
      const resolvesInId = d.kind === 'branch' || d.kind === 'jump-register';
      if (d.src.some(loadInEx)) stall = 'loaduse';
      else if (resolvesInId && d.src.some(r => inEx(r) || loadInMem(r))) stall = 'branch';
      else if ((d.kind === 'move-from-hilo' || d.kind === 'hilo') && this.cycle < this.hiloReady) stall = 'hilo';
      if (!stall && (d.kind === 'branch' || d.kind === 'jump' || d.kind === 'jump-register')) {
        const val = r => (r && !exMem.bubble && exMem.d.dst === r) ? exMem.result : (r && !memWb.bubble && memWb.d.dst === r) ? memWb.result : this.regs[r];
        let taken = true, target = d.target;
        if (d.kind === 'branch') {
          const a = val(d.rs) | 0, b = val(d.rt) | 0;
          taken = d.mn === 'beq' ? a === b : d.mn === 'bne' ? a !== b : d.mn === 'blez' ? a <= 0 : d.mn === 'bgtz' ? a > 0 : d.mn === 'bltz' ? a < 0 : a >= 0;
          this.stats.branches++; if (taken) this.stats.taken++;
        }
        if (d.kind === 'jump-register') target = val(d.rs) >>> 0;
        if (taken) redirect = target;
        ev.notes.push(`ID: ${d.mn} ${taken ? `taken to 0x${target.toString(16)}` : 'not taken'}; the delay slot at 0x${(ifId.pc + 4).toString(16)} runs either way`);
      }
    }
    if (stall) {
      ev.stall = stall;
      ev.notes.push({ loaduse: 'load-use stall: ID waits for the load in EX', branch: 'branch stall: the branch compares in ID and needs a value still in EX or MEM', hilo: 'hi/lo stall: the multiply/divide unit is not done' }[stall]);
    }

    // ---------------- IF
    const fetched = stall ? null : { pc: this.fetchPc, word: this.word(this.fetchPc) };
    if (fetched) {
      const prevIsBranch = !ifId.bubble && ['branch', 'jump', 'jump-register'].includes(ifId.d.kind);
      const id = this.nextId++, d = decode(fetched.word, fetched.pc);
      this.instrs[id] = { pc: fetched.pc, text: d.text };
      if (prevIsBranch && d.mn === 'nop') this.stats.delaySlotNops++;
      ev.stages.IF = { id, pc: fetched.pc, text: d.text, note: prevIsBranch ? 'delay slot' : '' };
      this.ifId = { id, pc: fetched.pc, d, delaySlot: prevIsBranch };
      this.fetchPc = redirect !== null ? redirect : (this.fetchPc + 4) >>> 0;
    } else {
      ev.stages.IF = { id: -1, pc: this.fetchPc, text: '(held)', note: 'stalled' };
    }
    // pipeline registers
    this.memWb = memOut; this.exMem = exOut;
    this.idEx = stall ? BUBBLE(stall) : ifId; // ID passes its instruction on, or a bubble while it waits
    if (stall) this.ifId = ifId;
    return ev;
  }
  run(max = 5e6) { while (!this.halted && this.cycle < max) this.step(); return this; }
  registers() { return [...this.regs.map((v, i) => ({ name: '$' + REGISTER_NAMES[i], value: v })), { name: 'hi', value: this.hi }, { name: 'lo', value: this.lo }]; }
  get result() { return this.regs[RESULT_REGISTER] | 0; }
  equation() {
    const s = this.stats, b = s.bubbles;
    return { terms: [['N instructions', s.retired], ['4 to fill', b.fill], ['L load-use', b.loaduse], ['B branch operands', b.branch], ['H hi/lo waits', b.hilo]], total: s.cycles };
  }
}
