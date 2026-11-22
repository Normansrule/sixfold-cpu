// =============================================================================
// model/deep.js: cycle-exact model of the deep-pipeline edition (the 5 GHz plan, docs/DEEP_PIPELINE.md)
//
//   F1 F2 F3 F4 D1 D2 | X1 X2 X3 X4 | M1 M2 M3 | W     14 stages
//
//   F1  PC to the I-cache and the predictor tables     F2  arrays read
//   F3  I-cache tag compare; the word and its predecode are captured for F4
//   F4  the prediction: a JAL, a branch guessed taken or a return sends F1 to its target (3 bubbles);
//       a miss restarts F1 at this PC, which asks for the line and waits until it is nearly in
//   D1  decode, register file read                     D2  the issue check (below); holds F1..D2 when it fails
//   X1..X4  the staggered ALU: one 16-bit slice per stage, low slice first (tools/clock_floor/staggered_alu.sv)
//   M1  the COMMIT POINT: branches and JALR resolve here (a wrong guess refills F1..D2 and drops X1..X4),
//       ecall / ebreak / mret trap here, loads look up the D-cache (a miss replays the load from F1),
//       stores and CSR writes happen at its clock edge, an M instruction starts the multiply / divide unit
//   M2  load alignment                                 M3  write-back drive        W  register file write
//
// Nothing behind D2 ever stalls: the back end always moves one stage per cycle, so the only stall is
// D2 holding its instruction. That is what keeps every loop of the back end inside one short stage.
//
// THE ISSUE CHECK. Every producer has a stage AT where its whole result exists (X1 = 0 .. M2 = 5), and every
// consumer a stage where it needs each operand. A consumer that works low bits first ("sliced": adds,
// subtracts, logic, compares, branches, addresses, JALR) needs slice k in stage Xk+1, which a sliced producer
// made one stage earlier, so it may follow a sliced producer straight away. Anything else needs the whole
// value by the stage where it computes. With producer X1 cycle tp and consumer X1 cycle tc:
//   sliced consumer of a sliced producer        tc >= tp + 1
//   sliced consumer of any other producer       tc >= tp + AT + 1
//   whole-value consumer needing it in stage S  tc >= tp + AT + 1 - S
//
//   producer                                       AT    consumer (whole value)                S
//   add sub and or xor andn orn xnor lui auipc     3*    shifts, rotates, Zbb, Zbs, Zknh       2 (X3)
//     Zba, word adds (* sliced, low slice in X1)          custom instructions                  2 (X3)
//   JAL / JALR link (PC + 4, known in DECODE)      0     store data, CSR source, M operands    4 (M1)
//   slt sltu (the slices' compare, in X4)          3
//   shifts, rotates, Zbb, Zbs, Zknh, min, max      4     (the whole-value unit: X3 X4 M1)
//   CSR reads                                      4
//   loads, custom instructions, cpop               5
//   multiply / divide                              when the unit finishes (it writes the register file)
//
// Serial instructions (CSR access, ecall, ebreak, mret) issue only into an empty X1..M1 and an idle M unit,
// and nothing issues behind one until it has left M1. An interrupt drains X1..M1 the same way, then takes
// the D2 instruction's place (that instruction runs after mret).
//
// The model computes values functionally (model/core.js alu, multiplyDivide, loadControl ...) at the stage
// where the hardware has them, so a value is only ever read after its producer made it. Architectural
// results must match model/core.js exactly; timing is this file's own (tools/deep_check.mjs compares both).
// =============================================================================
import { Core, control, usesRegisters, multiplyDivideSteps, multiplyDivide, alu, prepareA, prepareB, immediate,
  branchComparator, loadControl, storeControl, OPC, WB, CSR, MMIO_PUTCHAR, MMIO_LEDS, MMIO_DISPLAY, MMIO_MTIMECMP,
  CAUSE_TIMER_INTERRUPT, CAUSE_EXTERNAL_INTERRUPT, isMmio, mergeBytes, u64, bits } from './core.js';
import { execute as customExecute } from './custom.js';

export const DEEP_STAGES = ['F1', 'F2', 'F3', 'F4', 'D1', 'D2', 'X1', 'X2', 'X3', 'X4', 'M1', 'M2', 'M3', 'W'];
const BACK = ['X1', 'X2', 'X3', 'X4', 'M1', 'M2', 'M3', 'W'];
const M1 = 4; // index of M1 in the back end
// a miss takes at least the nanoseconds of the turbo edition's 10 cycles of 535 ps: 12 cycles of 466 ps (402 ps of
// logic, measured with tools/timing.sh deep asap7, plus 64 ps for the flip-flops; docs/DEEP_PIPELINE.md)
export const DEEP_CYCLE_PS = 466, TURBO_CYCLE_PS = 535;
export const DEEP_CONFIG = { historyBits: 6, btb: true, ras: true, tournament: true, caches: true, missLatency: 12, iterativeMdu: true, fastMdu: true, streamPrefetch: true, xcompute: true };
const REPLAY_LEAD = 10; // F1 to M1: a replayed load is fetched again when its line is at most this many cycles away
const FETCH_LEAD = 2;  // F1 to F3: the same for an instruction line

// DeepMultiplyDivideUnit's states between CAPTURE and SIGN: PREPARE (a negative operand that matters), then a
// multiply's one 64 x 64 step, or a divide's ALIGN, its radix-16 steps (4 quotient bits each) and NEGATE (the
// remainder of a negative dividend). The counting is model/core.js multiplyDivideSteps (fast) with 4 bits a step.
export function deepMultiplyDivideSteps(op, isWord, a, b) {
  if (!['DIV', 'DIVU', 'REM', 'REMU'].includes(op)) {
    const aSigned = op === 'MULH' || op === 'MULHSU', bSigned = op === 'MULH'; // MUL / MULW: the low bits do not care
    return 1 + ((aSigned && !!(a >> 63n)) || (bSigned && !!(b >> 63n)) ? 1 : 0);
  }
  const signed = op === 'DIV' || op === 'REM';
  const x = isWord ? (signed ? BigInt.asUintN(64, BigInt.asIntN(32, a)) : BigInt.asUintN(32, a)) : a;
  const y = isWord ? (signed ? BigInt.asUintN(64, BigInt.asIntN(32, b)) : BigInt.asUintN(32, b)) : b;
  const negative = signed && !!(x >> 63n), v = negative ? BigInt.asUintN(64, ~x) : x;
  let lz = v === 0n ? 63 : 64 - v.toString(2).length;
  if (negative && lz > 0) lz--;
  const yNegative = signed && !!(y >> 63n), w = yNegative ? BigInt.asUintN(64, ~y) : y;
  const lzd = w === 0n ? 63 : 64 - w.toString(2).length;
  const r = lzd - lz; // the quotient has at most r + 1 bits: ceil((r + 1) / 4) radix-16 steps
  const steps = r < 0 ? 1 : (r >> 2) + 1;
  return (negative || yNegative ? 1 : 0) + 1 + steps + ((op === 'REM' && negative) ? 1 : 0);
}

const SLICED_OPS = new Set(['ADD', 'SUB', 'AND', 'OR', 'XOR', 'COPY_B']);
const SLICED_CONSUMERS = new Set(['ADD', 'SUB', 'AND', 'OR', 'XOR', 'COPY_B', 'SLT', 'SLTU', 'MIN', 'MINU', 'MAX', 'MAXU', 'JALR']);

// The timing class of one instruction: what it produces when, and when it needs its operands.
export function deepClass(word) {
  const c = control(word), op = word & 0x7f, f3 = bits(word, 14, 12);
  const serial = op === OPC.SYSTEM;
  const k = { c, serial, isMulDiv: !!c.isMulDiv, at: 4, sliced: false, needA: 0, needB: 0, slicedA: false, slicedB: false };
  // producer
  if (c.memRead || c.aluOp === 'CUSTOM') k.at = 5;
  else if (c.wbSel === WB.CSR) k.at = 4;
  else if (c.isJal || c.isJalr) { k.at = 0; k.sliced = true; }
  else if (c.isMulDiv) k.at = Infinity;
  else if (c.aluOp === 'SLT' || c.aluOp === 'SLTU') k.at = 3; // the slices' compare, decided in X4
  else if (c.aluOp === 'CPOP') k.at = 5; // ones per nibble (X3), per quarter (X4), per half (M1), the total (M2)
  else if (SLICED_OPS.has(c.aluOp) && !c.oneB) { k.at = 3; k.sliced = true; }
  // everything else (shifts, rotates, Zbb, Zbs, Zknh, min, max) comes out of the three-stage whole-value unit in M1
  // consumer
  const sliced = (SLICED_CONSUMERS.has(c.aluOp) && !c.oneB && !c.isMulDiv) || c.isBranch || c.memRead || c.memWrite;
  if (c.isMulDiv || serial) { k.needA = 4; k.needB = 4; }
  else if (c.aluOp === 'CUSTOM') { k.needA = 2; k.needB = 2; }
  else if (sliced) { k.slicedA = true; k.slicedB = !c.memWrite; k.needB = c.memWrite ? 4 : 0; }
  else { k.needA = 2; k.needB = 2; } // the whole-value unit: X3 prepares, X4 computes
  // add.uw, sh1add..sh3add(.uw): rs1 is zero-extended / shifted one stage early, so it must be complete at issue
  if (k.slicedA && (c.aZext || c.aShift)) { k.slicedA = false; k.needA = -1; }
  k.uses = usesRegisters(word);
  if (op === OPC.SYSTEM && f3 === 0) k.uses = { rs1: false, rs2: false };
  return k;
}

export class DeepCore extends Core {
  constructor(image, opts = {}) {
    super(image, { ...DEEP_CONFIG, ...opts });
    // serialCsr (an experiment): CSR instructions wait for an empty X1..M1 and block issue behind them. Not
    // needed: M1 is the commit point and every CSR access happens there, in program order.
    this.deepOpts = { serialCsr: !!opts.serialCsr };
    // Every slot holds an instruction or a bubble that remembers why it exists ({ bubble: cause, depth }).
    // The counters count bubbles as they reach W (see the cycle equation in the class comment below).
    // Reset: 13 fill bubbles reach W before the first instruction; the six-stage pipeline's 5 are the
    // equation's constant, the other 8 are depth bubbles (B).
    const fill = depth => ({ bubble: 'fill', depth });
    this.f2 = fill(true); this.f3 = fill(true); this.f4 = fill(true); this.d1 = fill(true); this.d2 = fill(true);
    this.be = [fill(true), fill(true), fill(true), fill(false), fill(false), fill(false), fill(false), fill(false)]; // X1 .. W
    this.dmdu = { busy: false, left: 0, rd: 0, value: 0n };
    this.icache.data = []; // way * 64 + set -> the line's 32 bytes
    this.iwait = false; this.dwait = -1; // F1 waits for an instruction line / a replayed load's data line
    this.missR = false; // a load missed in M1 last cycle: replay it from M2 now
    this.dTouch = -1; // the data cache line M1 used last cycle (marked used now)
    this.tohostSet = false; this.intReq = false; this.intExt = false;
    this.skid = null; this.fstall = false; // the skid slot between D1 and D2, and "it is full" (the front end waits)
    Object.assign(this.stats, { holds: 0, replays: 0, serialHolds: 0, dependencyHolds: 0, mduHolds: 0, interruptHolds: 0, customHolds: 0 });
  }

  install(c) { // the instruction cache also keeps the line's bytes (DeepCache's WAY0_DATA / WAY1_DATA)
    const slot = c.victim >= 0 ? c.victim : this.victimSlot(c, c.line);
    super.install(c);
    if (c === this.icache) c.data[slot] = c.snap;
  }

  // youngest in-flight writer of register r in the back end (index 0 = X1 = youngest)
  writer(r) {
    if (r === 0) return null;
    for (const rec of this.be) if (rec && !rec.bubble && rec.k.c.regWrite && rec.rd === r) return rec;
    return null;
  }
  // can an instruction of class k be in X1 at cycle tc with this producer?
  static ready(p, k, sliced, need, tc) {
    if (!p) return true;
    if (p.k.at === Infinity) return false;
    if (sliced && p.k.sliced) return tc >= p.tx + 1;
    return tc >= p.tx + p.k.at + 1 - need;
  }

  step() {
    if (this.halted) return null;
    this.cycle++;
    const ev = { cycle: this.cycle, stages: {}, squashed: [], deep: true };
    const I = q => (q && !q.bubble ? q : null); // the instruction in a slot, or null for a bubble
    const be = this.be.map(I), cyc = this.cycle;
    // The instruction cache keeps its own copy of each line, taken from memory as the line installs (before
    // this cycle's store). A store never updates it, so a line read after a store to it holds the old words.
    if (this.icache.busy && this.icache.left === 1) { const a = this.icache.line & 0xffff; this.icache.snap = this.mem.slice(a, a + 32); }
    BACK.forEach((s, i) => { if (be[i]) ev.stages[s] = { id: be[i].id, pc: be[i].pc }; });
    for (const [s, slot] of [['F2', I(this.f2)], ['F3', I(this.f3)], ['F4', I(this.f4)], ['D1', I(this.d1)], ['D2', I(this.d2)]]) if (slot) ev.stages[s] = { id: slot.id, pc: slot.pc };

    // ================= W =================
    const w = be[7];
    // (decided a cycle early, while the instruction was in M3, from tohost as it was then: Riscv64Deep's HALT_PENDING)
    const HALT_NOW = !!(w && w.writesTohost && this.tohostSet);
    const rfWrite = w && w.k.c.regWrite && w.rd !== 0 && !w.k.isMulDiv ? { rd: w.rd, value: w.value } : null;
    if (rfWrite) ev.rfWrite = rfWrite;

    // ================= X4: the ALU results (sliced and whole-value) =================
    const val = (src, v) => { if (!src) return v; if (src.value === undefined) throw new Error(`deep model: operand of ${src.pc.toString(16)} read before it was made`); return src.value; };
    const operands = rec => {
      const k = rec.k, c = k.c;
      const rs1v = val(rec.srcA, rec.valA), rs2v = val(rec.srcB, rec.valB);
      const A = c.aIsPC ? BigInt(rec.pc) : prepareA(rs1v, c), B = prepareB(c.bIsImm ? immediate(rec.word, c.immType) : rs2v, c);
      return { rs1v, rs2v, A, B };
    };
    const compute = rec => {
      const { A, B } = operands(rec);
      rec.aluOut = rec.k.c.aluOp === 'CUSTOM' ? customExecute(rec.word, A, B, this.customGroups) : alu(A, B, rec.k.c.aluOp, rec.k.c.isWord);
      if (rec.k.c.wbSel === WB.ALU && !rec.k.isMulDiv) rec.value = rec.aluOut;
    };
    if (be[3] && be[3].k.at === 3 && be[3].k.c.regWrite && be[3].k.c.wbSel === WB.ALU && !be[3].k.isMulDiv) compute(be[3]);

    // ================= M2: custom results, cpop =================
    if (be[5] && (be[5].k.c.aluOp === 'CUSTOM' || (be[5].k.at === 5 && be[5].k.c.wbSel === WB.ALU && !be[5].k.c.memRead))) compute(be[5]);

    // ================= M1: the commit point =================
    let FLUSH = false, REPLAY = false, adjust = 0, restoreGhr = null, rasRestore = null, trap = null, mret = false, fenceI = false;
    let storeOp = null, csrWrite = null, bpTrain = null, btbWrite = null, dReq = false, dHit = true, dAddr = 0n, dStoreSlot = -1, mduStart = null;
    // a load that missed in M1 last cycle is replayed now, from M2 (Riscv64Deep's MISS_R): the instruction in M1
    // is younger, so it does nothing and is removed with the rest
    const RM2 = this.missR, m = RM2 ? null : be[M1];
    let missNow = false;
    if (RM2) { const l = be[M1 + 1]; FLUSH = true; REPLAY = true; adjust = l.pc; restoreGhr = l.ckpt; rasRestore = l.rasCkpt; dAddr = l.missAddr; }
    if (m) {
      const k = m.k, c = k.c;
      const { rs1v, rs2v, A, B } = operands(m);
      const aluOut = c.aluOp === 'CUSTOM' ? 0n : alu(A, B, c.aluOp, c.isWord);
      if (k.at === 4 && c.wbSel === WB.ALU && !k.isMulDiv) m.value = aluOut;
      const pc4 = Number(u64(BigInt(m.pc) + 4n) & 0xffffffffn);
      if (c.isBranch) {
        const taken = branchComparator(bits(m.word, 14, 12), rs1v, rs2v);
        bpTrain = { idx: m.idx, taken, pc: m.pc, g: m.gTaken, b: m.bTaken };
        if (this.opts.btb) btbWrite = { idx: (m.pc >>> 2) & 15, tag: (m.pc >>> 6) & 0x3ff, target: m.btarget >>> 0, isJal: false, taken };
        ev.resolve = { kind: 'branch', predicted: m.pred, actual: taken, mispredict: taken !== m.pred, target: m.btarget };
        if (taken !== m.pred || m.btbBad) { FLUSH = true; adjust = taken ? m.btarget : pc4; restoreGhr = ((m.ckpt << 1) | (taken ? 1 : 0)) & this.bp.mask; }
      } else if (c.isJalr) {
        const target = Number(aluOut & ~1n & 0xffffffffn);
        const right = !!m.returnPredicted && !m.btbBad && m.target === target;
        ev.resolve = { kind: 'jalr', predicted: !!m.returnPredicted, actual: true, mispredict: !right, target };
        if (right) this.stats.returnsPredicted++;
        else { FLUSH = true; adjust = target; restoreGhr = m.ckpt; }
      }
      else if (m.btbBad) { FLUSH = true; adjust = c.isJal ? m.btarget : pc4; restoreGhr = m.ckpt; } // a stale BTB entry
      if (FLUSH) rasRestore = (m.rasCkpt + (m.isCall ? 1 : 0) - (m.isReturn ? 1 : 0) + 8) & 7;
      if (c.isEcall || c.isEbreak) { FLUSH = true; adjust = Number(this.csr.mtvec & 0xfffffffcn); trap = { pc: m.pc, cause: c.isEbreak ? 3n : 11n }; ev.trap = { kind: c.isEbreak ? 'ebreak' : 'ecall', to: adjust }; restoreGhr = m.ckpt; rasRestore = m.rasCkpt; }
      else if (c.isMret) { FLUSH = true; adjust = Number(this.csr.mepc & 0xffffffffn); mret = true; ev.trap = { kind: 'mret', to: adjust }; restoreGhr = m.ckpt; rasRestore = m.rasCkpt; }
      else if (c.isFenceI) { FLUSH = true; adjust = pc4; fenceI = true; ev.fenceI = true; } // FENCE.I: refetch from PC + 4 (Riscv64Deep's FENCE_I_NOW)
      if (c.memRead) {
        dReq = true; dAddr = aluOut; dHit = this.cacheHit(this.dcache, aluOut);
        ev.dcacheAccess = { addr: Number(aluOut & 0xffffffffn), hit: dHit };
        if (!dHit) { missNow = true; m.missAddr = aluOut; } // (replayed from M2 next cycle; the refill starts now)
        else { const dword = this.readDouble(aluOut); m.value = loadControl(bits(m.word, 14, 12), aluOut, dword); ev.memAccess = { kind: 'load', addr: aluOut, value: m.value, dword, funct3: bits(m.word, 14, 12) }; }
      }
      if (c.memWrite) {
        const s = storeControl(bits(m.word, 14, 12), aluOut, rs2v); storeOp = { addr: aluOut, ...s };
        dStoreSlot = this.cacheSlot(this.dcache, aluOut);
        ev.memAccess = { kind: 'store', addr: aluOut, value: rs2v, mask: s.mask, funct3: bits(m.word, 14, 12) };
      }
      if (c.wbSel === WB.CSR && !c.isEcall && !c.isEbreak && !c.isMret) {
        const csrAddr = bits(m.word, 31, 20), csrData = this.csrRead(csrAddr);
        m.value = csrData;
        if (c.csrWrite) {
          const src = c.csrImm ? BigInt(bits(m.word, 19, 15)) : rs1v, f = bits(m.word, 14, 12);
          const nv = (f === 2 || f === 6) ? (csrData | src) : (f === 3 || f === 7) ? (csrData & u64(~src)) : src;
          csrWrite = { addr: csrAddr, value: nv }; ev.csrWrite = csrWrite;
        }
      }
      if (c.isJal || c.isJalr) m.value = BigInt(pc4);
      if (c.isJal && this.opts.btb) btbWrite = { idx: (m.pc >>> 2) & 15, tag: (m.pc >>> 6) & 0x3ff, target: m.btarget >>> 0, isJal: true, taken: true };
      if (k.isMulDiv) {
        // DeepMultiplyDivideUnit (src/deep/Deep_Multiply_Divide.sv): every state takes two cycles, CAPTURE and
        // SIGN included, so it writes the register file 2 x (steps + 2) cycles after M1
        const cycles = 2 * deepMultiplyDivideSteps(c.aluOp, !!c.isWord, rs1v, rs2v) + 4;
        mduStart = { rd: m.rd, value: multiplyDivide(rs1v, rs2v, c.aluOp, c.isWord), cycles };
      }
      ev.alu = { a: A, b: B, result: m.value ?? aluOut, op: c.aluOp, unit: k.isMulDiv ? 'MDU' : c.aluOp === 'CUSTOM' ? 'CUSTOM' : 'ALU', word: !!c.isWord };
    }

    // ================= D2: the issue check =================
    const tc = cyc + 1;
    const mieBit = (this.csr.mstatus >> 3n) & 1n, EXTERNAL_NOW = !!((this.csr.mie >> 11n) & 1n) && this.mip.external;
    const REQUEST_NOW = mieBit === 1n && ((!!((this.csr.mie >> 7n) & 1n) && this.mip.timer) || EXTERNAL_NOW);
    // D2 sees the request registered (Riscv64Deep's INT_REQ): a cycle late, and dropped for a cycle after anything
    // that changes the CSRs (a CSR write, mret, a trap), so a request just disabled is never taken
    const INTERRUPT_REQUEST = this.intReq, INTERRUPT_EXTERNAL = this.intExt;
    const frontEmpty = be.slice(0, M1 + 1).every(r => !r), mduIdle = !this.dmdu.busy;
    const serialAhead = this.deepOpts.serialCsr && be.slice(0, M1 + 1).some(r => r && r.k.serial);
    const mduAhead = be.slice(0, M1 + 1).some(r => r && r.k.isMulDiv);
    let ISSUE = false, TAKE_INTERRUPT = false, holdWhy = null, issued = null;
    const d2 = I(this.d2);
    if (d2 && !FLUSH) {
      const k = d2.k, rs1 = bits(d2.word, 19, 15), rs2 = bits(d2.word, 24, 20), rd = bits(d2.word, 11, 7);
      const pending = new Set();
      if (this.dmdu.busy && this.dmdu.rd) pending.add(this.dmdu.rd);
      for (const r of be.slice(0, M1 + 1)) if (r && r.k.isMulDiv && r.rd) pending.add(r.rd);
      if (INTERRUPT_REQUEST) { if (frontEmpty && mduIdle) TAKE_INTERRUPT = true; else holdWhy = 'interrupt'; }
      else if (serialAhead) holdWhy = 'serial';
      else if (this.deepOpts.serialCsr && k.serial && !(frontEmpty && mduIdle)) holdWhy = 'serial';
      else if (k.isMulDiv && (!mduIdle || mduAhead)) holdWhy = 'mdu';
      else if ((k.uses.rs1 && pending.has(rs1)) || (k.uses.rs2 && pending.has(rs2)) || (k.c.regWrite && rd && pending.has(rd))) holdWhy = 'mdu';
      else if (k.c.aluOp === 'CUSTOM' && [be[0], be[1]].some(r => r && r.k.c.aluOp === 'CUSTOM')) holdWhy = 'custom'; // its three-cycle path is busy
      else {
        const pa = k.uses.rs1 ? this.writer(rs1) : null, pb = k.uses.rs2 ? this.writer(rs2) : null;
        if (!DeepCore.ready(pa, k, k.slicedA, k.needA, tc) || !DeepCore.ready(pb, k, k.slicedB, k.needB, tc)) holdWhy = 'dependency';
        else {
          ISSUE = true;
          issued = { ...d2, k, rd: k.c.regWrite ? rd : 0, tx: tc, srcA: pa, valA: pa ? 0n : this.regs[rs1], srcB: pb, valB: pb ? 0n : this.regs[rs2],
            writesTohost: !!(k.c.csrWrite && bits(d2.word, 31, 20) === CSR.TOHOST) };
          if (k.c.isJal || k.c.isJalr) issued.value = u64(BigInt(d2.pc) + 4n);
        }
      }
    }
    const HOLD = !!d2 && !FLUSH && !ISSUE && !TAKE_INTERRUPT;
    if (HOLD) { this.stats.holds++; this.stats[holdWhy + 'Holds']++; }

    // F1..D1 move on unless the skid slot is full (FSTALL: last cycle's hold, registered), so D2's hold never
    // reaches the front end in the same cycle; while D2 holds, the instruction leaving D1 waits in the skid slot
    const ADVANCE = !FLUSH && !TAKE_INTERRUPT && !this.fstall;
    // ================= F3: tag compare; the hit, way and word are captured for F4 =================
    const f3 = I(this.f3);
    let f3Sample = null;
    if (f3 && ADVANCE) {
      const slot = this.cacheSlot(this.icache, f3.pc);
      let cached = 0;
      if (slot >= 0) { const line = this.icache.data[slot], o = f3.pc & 28; cached = (line[o] | (line[o + 1] << 8) | (line[o + 2] << 16) | (line[o + 3] << 24)) >>> 0; }
      f3Sample = { icHit: slot >= 0, icSlot: slot, icWord: cached };
    }
    // ================= F4: the prediction (redirect), decode =================
    let REDIRECT = false, IMISS_F4 = false, f3Target = 0, f3Info = null;
    const f4 = I(this.f4);
    if (f4 && ADVANCE) {
      if (!f4.icHit) IMISS_F4 = true;
      else {
        // the word F3 read out of the instruction cache (F1 only guessed it from memory, possibly before the line was in)
        const cached = f4.icWord;
        if (cached !== f4.word) { const fc = this.instrs[f4.id]?.fetchCycle; f4.word = cached; delete this.instrs[f4.id]; this.instr(f4.id, f4.pc, cached).fetchCycle = fc; }
        const wd = f4.word, op = wd & 0x7f, isJal = op === OPC.JAL, isJalr = op === OPC.JALR, isBranch = op === OPC.BRANCH;
        const rdF = bits(wd, 11, 7), rs1F = bits(wd, 19, 15);
        const isCall = this.opts.ras && (isJal || isJalr) && (rdF === 1 || rdF === 5);
        const isReturn = this.opts.ras && isJalr && rdF === 0 && (rs1F === 1 || rs1F === 5) && bits(wd, 31, 20) === 0;
        const btarget = Number(u64(BigInt(f4.pc) + immediate(wd, isJal ? 'J' : 'B')) & 0xffffffffn);
        f3Target = isReturn ? Number(this.ras.stack[this.ras.top] & 0xffffffffn) : btarget;
        const taken = isJal || (isBranch && f4.pred) || isReturn;
        // the BTB sent F1 on already (no bubbles): redirect only if it guessed a different next PC
        // (it is trusted here: D1 compares the two, and M1 repairs a wrong guess, which takes changed code)
        let btbBad = false;
        // a branch the BTB sent on that the tournament guesses not taken goes back to PC + 4 (an F3 redirect)
        if (f4.btb && isBranch && !f4.pred) { f3Target = (f4.pc + 4) >>> 0; REDIRECT = true; f4.btb = false; }
        else if (f4.btb) { if (!taken) f3Target = (f4.pc + 4) >>> 0; btbBad = !taken || f4.btbTarget !== f3Target; }
        else REDIRECT = taken;
        f3Info = { ckpt: this.bp.ghr, rasCkpt: this.ras.top, isCall, isReturn, returnPredicted: isReturn, target: f3Target, btarget, isBranch, btbBad, k: deepClass(wd) };
        if (isBranch || isJal || isReturn) ev.predecode = { kind: isJal ? 'jal' : isBranch ? 'branch' : 'return', predicted: REDIRECT, target: f3Target, idx: f4.idx, counter: f4.counter };
      }
    }

    // ================= F1 =================
    const lineOf = a => Number(BigInt.asUintN(32, BigInt(a)) & ~31n);
    const nearlyIn = (c, line, lead) => this.cacheHit(c, line) || (c.busy && c.line === line && c.left <= lead);
    const IGATE = this.iwait && !nearlyIn(this.icache, lineOf(this.F1PC), FETCH_LEAD);
    const DGATE = this.dwait >= 0 && !nearlyIn(this.dcache, this.dwait, REPLAY_LEAD);
    const FETCH = ADVANCE && !REDIRECT && !IMISS_F4 && !IGATE && !DGATE;
    let f1Slot = null;
    if (FETCH) {
      const word = this.fetch(this.F1PC), pred = this.bp.predict(this.F1PC);
      const tIdx = (this.F1PC >>> 2) & 127, gTaken = pred.taken, bTaken = this.bp.enabled && this.bht[tIdx] >= 2;
      if (this.opts.tournament) pred.taken = this.chooser[tIdx] >= 2 ? gTaken : bTaken;
      const id = this.nextId++;
      this.instr(id, this.F1PC, word);
      // BTB (as in the turbo edition): a hit on a JAL, or on a branch guessed taken, sends F1 to the target next cycle
      // (a 10-bit tag, PC[15:6]: DeepBranchTargetBuffer; a false hit is repaired like a stale entry)
      const be1 = this.btb[(this.F1PC >>> 2) & 15], btbHit = this.opts.btb && be1.valid && be1.tag === ((this.F1PC >>> 6) & 0x3ff);
      const btbGo = btbHit && (be1.isJal || (this.bp.enabled && be1.bias >= 2)); // the entry's own counter (DeepBranchTargetBuffer)
      f1Slot = { id, pc: this.F1PC, word, pred: pred.taken, idx: pred.idx, counter: pred.counter, gTaken, bTaken, btb: btbGo, btbTarget: btbGo ? be1.target : 0 };
      ev.btb = { hit: btbHit, redirect: btbGo, target: btbHit ? be1.target : null };
      ev.stages.F1 = { id, pc: this.F1PC };
      ev.predict = pred;
    }

    ev.stall = HOLD; ev.flush = FLUSH && !REPLAY; ev.redirect = REDIRECT; ev.busy = this.dmdu.busy;
    ev.imiss = IMISS_F4 || (ADVANCE && !REDIRECT && IGATE); ev.dmiss = REPLAY || (ADVANCE && !REDIRECT && !IMISS_F4 && !IGATE && DGATE);
    ev.replay = REPLAY; ev.ghr = this.bp.ghr;

    // ================= the clock edge =================
    if (HALT_NOW) {
      if (rfWrite) this.regs[rfWrite.rd] = rfWrite.value;
      this.stats.retired++; this.stats.cycles = cyc; this.halted = true; ev.halt = true;
      return ev;
    }
    if (rfWrite) this.regs[rfWrite.rd] = rfWrite.value;
    if (w) { this.stats.retired++; this.csr.instret++; }
    if (storeOp && storeOp.mask) {
      if (storeOp.addr === MMIO_PUTCHAR) { this.output += String.fromCharCode(Number(storeOp.data & 0xffn)); ev.putchar = true; }
      else if ((storeOp.addr & ~7n) === MMIO_LEDS && (storeOp.mask & 3)) { this.leds = mergeBytes(this.leds, storeOp, 2); ev.leds = this.leds; }
      else if ((storeOp.addr & ~7n) === MMIO_DISPLAY && (storeOp.mask & 15)) { this.display = mergeBytes(this.display, storeOp, 4); ev.display = this.display; }
      if (isMmio(storeOp.addr)) { if (this.opts.devices) this.opts.devices.store(storeOp.addr, storeOp.data, storeOp.mask); }
      else { const base = Number(storeOp.addr & 0xfff8n); for (let q = 0; q < 8; q++) if (storeOp.mask & (1 << q)) this.mem[(base + q) & 0xffff] = Number((storeOp.data >> BigInt(8 * q)) & 0xffn); }
      if (storeOp.addr === MMIO_MTIMECMP) { let v = this.mtimecmp; for (let q = 0; q < 8; q++) if (storeOp.mask & (1 << q)) { const sh = BigInt(8 * q); v = (v & ~(0xffn << sh)) | (storeOp.data & (0xffn << sh)); } this.mtimeCmpNext = v; }
    }
    this.mip.timer = this.mtime >= this.mtimecmp;
    this.mip.external = !!(this.opts.devices && this.opts.devices.externalInterrupt && this.opts.devices.externalInterrupt());
    this.mtime++;
    if (this.mtimeCmpNext !== undefined) { this.mtimecmp = this.mtimeCmpNext; this.mtimeCmpNext = undefined; }
    if (TAKE_INTERRUPT) {
      trap = { pc: d2.pc, cause: INTERRUPT_EXTERNAL ? CAUSE_EXTERNAL_INTERRUPT : CAUSE_TIMER_INTERRUPT };
      ev.trap = { kind: INTERRUPT_EXTERNAL ? 'external interrupt' : 'timer interrupt', to: Number(this.csr.mtvec & 0xfffffffcn) };
      ev.interrupt = true; ev.intr = true; ev.interruptTaken = { pc: d2.pc, external: INTERRUPT_EXTERNAL };
      this.stats.interrupts++;
    }
    if (trap) { this.csr.mepc = BigInt(trap.pc) & ~1n; this.csr.mcause = trap.cause; const mie = (this.csr.mstatus >> 3n) & 1n; this.csr.mstatus = (this.csr.mstatus & ~0x88n) | (mie << 7n); this.stats.traps = (this.stats.traps || 0) + 1; }
    else if (mret) { const mpie = (this.csr.mstatus >> 7n) & 1n; this.csr.mstatus = (this.csr.mstatus & ~0x88n) | (mpie << 3n) | 0x80n; }
    this.tohostSet = this.csr.tohost !== 0n; // (before this cycle's CSR write)
    this.intReq = REQUEST_NOW && !csrWrite && !mret && !trap; this.intExt = EXTERNAL_NOW;
    this.missR = missNow;
    if (csrWrite) {
      const v = csrWrite.value, a = csrWrite.addr, c = this.csr;
      if (a === CSR.TOHOST) c.tohost = v; else if (a === CSR.STATUS) c.status = v; else if (a === CSR.MSTATUS) c.mstatus = v;
      else if (a === CSR.MTVEC) c.mtvec = v; else if (a === CSR.MSCRATCH) c.mscratch = v; else if (a === CSR.MEPC) c.mepc = v & ~1n; else if (a === CSR.MCAUSE) c.mcause = v;
      else if (a === CSR.MIE) c.mie = v;
    }
    this.csr.cycle++;
    // the counters: F counts flushes (3 bubbles of the six-stage pipeline each, which always reach W); the others
    // count bubbles reaching W by cause; B counts the bubbles that exist only because this pipeline is deeper
    if (FLUSH && !REPLAY) this.hpm.flush++;
    const wb = this.be[7];
    if (wb && wb.bubble) {
      this.stats.bubbles[wb.bubble] = (this.stats.bubbles[wb.bubble] || 0) + 1;
      const key = wb.depth ? 'late' : { stall: 'stall', mdu: 'busy', redirect: 'redirect', imiss: 'imiss', dmiss: 'dmiss', interrupt: 'intr' }[wb.bubble];
      if (key) this.hpm[key]++;
    }
    // the tables learn a cycle after M1 (in M2, from registers: Riscv64Deep's TRAIN_*)
    const late = this.pendingTrain; this.pendingTrain = REPLAY ? null : { bpTrain, btbWrite };
    if (bpTrain && !REPLAY) this.stats.branches++;
    ({ bpTrain, btbWrite } = late || { bpTrain: null, btbWrite: null });
    if (btbWrite) { // DeepBranchTargetBuffer: a taken branch / JAL writes its entry; a not-taken branch steps its counter down
      const e = this.btb[btbWrite.idx], same = e.valid && e.tag === btbWrite.tag;
      if (btbWrite.taken) Object.assign(e, { valid: true, tag: btbWrite.tag, target: btbWrite.target, isJal: btbWrite.isJal, bias: same ? Math.min(3, (e.bias || 0) + 1) : 2 });
      else if (same && e.bias > 0) e.bias--;
    }
    if (bpTrain) {
      ev.bpUpdate = { ...this.bp.train(bpTrain.idx, bpTrain.taken), taken: bpTrain.taken };
      if (this.opts.tournament) {
        const i = (bpTrain.pc >>> 2) & 127, t = bpTrain.taken, gOk = bpTrain.g === t, bOk = bpTrain.b === t;
        this.bht[i] = t ? Math.min(3, this.bht[i] + 1) : Math.max(0, this.bht[i] - 1);
        if (gOk && !bOk) this.chooser[i] = Math.min(3, this.chooser[i] + 1); else if (bOk && !gOk) this.chooser[i] = Math.max(0, this.chooser[i] - 1);
      }
    }
    // caches: LRU, then the refill engines (an instruction line is requested while F1 waits for it)
    const ic = this.icache, dc = this.dcache;
    for (const c of [ic, dc]) c.victim = c.busy && c.left === 1 ? this.victimSlot(c, c.line) : -1;
    if (f4 && ADVANCE && !IMISS_F4) this.touch(ic, f4.icSlot); // (F4, from the way F3 found)
    // (the data cache marks a line used a cycle after M1 found it, from registers: Riscv64Deep's DTOUCH_*)
    if (this.dTouch >= 0) this.touch(dc, this.dTouch);
    this.dTouch = dReq && dHit ? this.cacheSlot(dc, dAddr) : storeOp && storeOp.mask && dStoreSlot >= 0 ? dStoreSlot : -1;
    // (an F4 miss restarts F1 there and asks for the line through the wait: F3's hit is a cycle old by now)
    const iMissPc = this.F1PC;
    const iWant = (this.iwait && !this.cacheHit(ic, this.F1PC) && !(ic.busy && ic.line === lineOf(this.F1PC)));
    if (this.irefill(iWant, iMissPc)) this.stats.icacheMisses++;
    const dWantAddr = missNow ? dAddr : BigInt(Math.max(this.dwait, 0));
    const dWant = missNow || (this.dwait >= 0 && !this.cacheHit(dc, this.dwait) && !(dc.busy && dc.line === this.dwait));
    if (this.prefetchingRefill(dc, dWant, dWantAddr, !!(storeOp && storeOp.mask))) this.stats.dcacheMisses++;
    if (fenceI) { // FENCE.I: the instruction cache and the BTB take their reset at this edge (it wins over this cycle's updates)
      Object.assign(ic, { valid: new Uint8Array(2 * ic.sets), lru: new Uint8Array(ic.sets), busy: false, left: 0, line: 0, demand: false, pf: false, pfLine: 0, nextLine: undefined, data: [] });
      for (const b of this.btb) { b.valid = false; b.isJal = false; }
    }
    // M unit
    if (this.dmdu.busy) { if (--this.dmdu.left === 0) { this.dmdu.busy = false; if (this.dmdu.rd) this.regs[this.dmdu.rd] = this.dmdu.value; } }
    if (mduStart && !REPLAY) { Object.assign(this.dmdu, { busy: true, left: mduStart.cycles, rd: mduStart.rd, value: mduStart.value }); this.stats.multiplyDivideBusy += mduStart.cycles; }
    // predictor history and return stack
    const intrSlot = TAKE_INTERRUPT ? d2 : null;
    if (FLUSH) { this.bp.ghr = restoreGhr; this.ras.top = rasRestore; ev.ghrRestore = restoreGhr; }
    else if (intrSlot) { this.bp.ghr = intrSlot.ckpt; this.ras.top = intrSlot.rasCkpt; }
    else if (ADVANCE && f3Info) {
      if (f3Info.isBranch) { this.bp.ghr = ((this.bp.ghr << 1) | (f4.pred ? 1 : 0)) & this.bp.mask; ev.ghrShift = f4.pred ? 1 : 0; }
      if (f3Info.isCall) { this.ras.top = (this.ras.top + 1) & 7; this.ras.stack[this.ras.top] = BigInt((f4.pc + 4) >>> 0); }
      else if (f3Info.isReturn) this.ras.top = (this.ras.top + 7) & 7;
    }

    // statistics
    if (FLUSH && !REPLAY) { this.stats.flushes++; if (m.k.c.isJalr) this.stats.jalrFlushes++; else if (m.k.c.isBranch) this.stats.mispredicts++; }
    if (REPLAY) this.stats.replays++;
    if (REDIRECT) this.stats.redirects++;

    // pipeline registers
    const squash = (id) => { const q = this.instrs[id]; if (q && !q.squashed) { q.squashed = true; ev.squashed.push(id); } };
    const bub = (cause, depth = false) => ({ bubble: cause, depth });
    // bubbles a flush makes, oldest first: the first `base` cost what the six-stage pipeline pays, the rest are depth bubbles
    const tagger = (cause, base) => { let n = 0; return () => bub(cause, cause !== 'dmiss' && cause !== 'interrupt' && n++ >= base); };
    const raw = this.be;
    for (let q = 7; q > 0; q--) raw[q] = raw[q - 1];
    raw[0] = ISSUE ? issued : HOLD ? bub(holdWhy === 'mdu' ? 'mdu' : holdWhy === 'interrupt' ? 'interrupt' : 'stall') : null; // null: filled below
    if (FLUSH || TAKE_INTERRUPT) {
      if (this.skid) squash(this.skid.id);
      this.skid = null; this.fstall = false;
      // the refill always makes 6 bubbles (X1 now, then D2 D1 F4 F3 F2): a flush's first 3 are the six-stage
      // pipeline's cost, so they always reach W; the rest, and every instruction dropped from X1..X4, are depth bubbles
      const cause = REPLAY ? 'dmiss' : FLUSH ? 'flush' : 'interrupt', next = tagger(cause, 3);
      raw[0] = next();
      for (const sl of [this.d2, this.d1, this.f4, this.f3, this.f2]) if (sl && !sl.bubble) squash(sl.id);
      if (f1Slot) squash(f1Slot.id);
      this.d2 = next(); this.d1 = next(); this.f4 = next(); this.f3 = next(); this.f2 = next();
      if (FLUSH) {
        if (REPLAY) { squash(raw[M1 + 2].id); raw[M1 + 2] = next(); } // the load, from M2
        for (let q = REPLAY ? M1 + 1 : M1; q >= 1; q--) if (raw[q] && !raw[q].bubble) { squash(raw[q].id); raw[q] = next(); } // X1..X4 (and M1 for a replay)
      }
      this.F1PC = (FLUSH ? adjust : Number(this.csr.mtvec & 0xfffffffcn)) >>> 0;
      if (REPLAY) this.dwait = dAddr >> 32n ? -1 : lineOf(Number(dAddr & 0xffffffffn));
      this.iwait = false;
      return this.finish(ev);
    }
    if (!HOLD && !ISSUE) raw[0] = this.d2; // D2's bubble moves on with its cause
    // D2 and the skid slot: a hold keeps D2 and parks D1's instruction (a bubble leaving D1 then is dropped);
    // otherwise D2 takes the skid slot's instruction first, else D1's
    if (HOLD) { if (ADVANCE && this.d1 && !this.d1.bubble) this.skid = this.d1; }
    else if (this.skid) { this.d2 = this.skid; this.skid = null; }
    else if (ADVANCE) this.d2 = this.d1;
    this.fstall = !!this.skid;
    if (!ADVANCE) return this.finish(ev); // F1..D1 keep their instructions
    this.d1 = f4 && !IMISS_F4 ? { ...f4, ...f3Info } : this.f4;
    if (IMISS_F4) { // restart F1 at the missing instruction once its line is nearly in
      squash(f4.id); this.d1 = bub('imiss');
      if (this.f3 && !this.f3.bubble) { squash(this.f3.id); this.f4 = bub('imiss'); } else this.f4 = this.f3;
      if (this.f2 && !this.f2.bubble) { squash(this.f2.id); this.f3 = bub('imiss'); } else this.f3 = this.f2;
      this.f2 = bub('imiss'); this.F1PC = f4.pc; this.iwait = true;
      return this.finish(ev);
    }
    if (REDIRECT) { // F1 fetched nothing this cycle; F3's and F2's instructions are dropped
      const next = tagger('redirect', 1);
      if (this.f3 && !this.f3.bubble) { squash(this.f3.id); this.f4 = next(); } else this.f4 = this.f3;
      if (this.f2 && !this.f2.bubble) { squash(this.f2.id); this.f3 = next(); } else this.f3 = this.f2;
      this.f2 = next(); this.F1PC = f3Target >>> 0;
      return this.finish(ev);
    }
    this.f4 = f3 ? { ...f3, ...f3Sample } : this.f3;
    this.f3 = this.f2; this.f2 = f1Slot || bub(IGATE ? 'imiss' : 'dmiss');
    if (FETCH) { this.F1PC = (f1Slot.btb ? f1Slot.btbTarget : this.F1PC + 4) >>> 0; this.iwait = false; this.dwait = -1; if (f1Slot.btb) this.stats.btbRedirects++; }
    return this.finish(ev);
  }
  finish(ev) { this.stats.cycles = this.cycle; return ev; }

  static traceLine(ev) {
    const f = s => (ev.stages[s] ? (ev.stages[s].pc >>> 0).toString(16).padStart(8, '0') : '--------');
    return `C${ev.cycle} ` + DEEP_STAGES.map(s => `${s}:${f(s)}`).join(' ') + (ev.stall ? ' STALL' : '') + (ev.flush ? ' FLUSH' : '') + (ev.redirect ? ' REDIRECT' : '') + (ev.busy ? ' BUSY' : '') + (ev.imiss ? ' IMISS' : '') + (ev.dmiss ? ' DMISS' : '') + (ev.replay ? ' REPLAY' : '') + (ev.intr ? ' INTR' : '');
  }
}
