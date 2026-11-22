#!/usr/bin/env node
// =============================================================================
// tools/deep_estimate.mjs: an ESTIMATE of the deep-pipeline edition's CPI, before any RTL exists
//
//   node tools/deep_estimate.mjs [--map=name] [--verbose]
//
// Not cycle-exact, and labelled as an estimate wherever it is quoted. It replays every program's retired
// instruction stream (from the turbo model, so the same predictor outcomes and cache misses) through a
// simple in-order timing model of the proposed stage map:
//
//   F1 F2 F3 D1 D2 | X1 X2 X3 | M1 M2 M3 | W
//
// Each instruction enters X1 one cycle after the one before it, or later when:
//   * an operand is not ready. "ready" is the first cycle a consumer may be in X1:
//       add/sub/logic/lui/auipc/jal link (staggered: the low 16 bits are ready after X1)  -> producer X1 + 1,
//       but only for a consumer that also works low bits first (add, sub, logic, address of a load/store,
//       store data); any other consumer needs the whole value, ready after X3            -> producer X1 + 3
//       shifts, compares, Zb* and everything else finished in X3                           -> producer X1 + 3
//       loads, CSR reads and custom instructions (finished in M2, forwarded from there)    -> producer X1 + LOAD_USE
//   * the instruction before it was a branch / JALR guessed wrong: the redirect leaves in M1 and the right
//     instruction refills F1 to D2                                                         -> branch X1 + MISPREDICT
//   * a multiply / divide is busy: turbo's busy cycles x MDU_SCALE (its steps split to fit the stage)
// and the turbo run's other stalls are added on top:
//   * front-end redirects R (a taken branch or JAL the BTB missed) x REDIRECT_SCALE (found in D1, not FETCH2)
//   * cache-miss cycles I + D x MISS_SCALE: a miss takes the same nanoseconds, which are more cycles at a
//     shorter clock period (turbo 535 ps / deep 249 ps = 2.15)
//   * interrupt entries X as they are
// =============================================================================
import fs from 'node:fs';
import { assemble } from '../model/asm.js';
import { Core, CONFIGS, control } from '../model/core.js';

const MAPS = {
  // the map of the plan (docs: "Sixfold deep-pipeline edition: plan")
  plan: { LOAD_USE: 5, FULL: 3, MISPREDICT: 8, MDU_SCALE: 2, REDIRECT_SCALE: 3, MISS_SCALE: 535 / 249 },
  // four 16-bit slices (X1..X4): the 16-bit slice with AND / OR / XOR in its loop measured 193 ps, a 22-bit
  // one 207 ps, a 32-bit one 244 ps (tools/clock_floor/staggered_alu.sv), so bits 32..63 need two stages
  plan13: { LOAD_USE: 6, FULL: 4, MISPREDICT: 9, MDU_SCALE: 2, REDIRECT_SCALE: 3, MISS_SCALE: 535 / 257 },
  // loads forwarded straight out of M2's alignment (one stage earlier) and an M unit that keeps turbo's cycle count
  plan_fast_load: { LOAD_USE: 4, FULL: 3, MISPREDICT: 8, MDU_SCALE: 2, REDIRECT_SCALE: 3, MISS_SCALE: 535 / 249 },
  plan_mdu_kept: { LOAD_USE: 5, FULL: 3, MISPREDICT: 8, MDU_SCALE: 1, REDIRECT_SCALE: 3, MISS_SCALE: 535 / 249 },
  // the same with 64-bit adds in one stage (no staggering): every result waits for X1 + 1 only if it is in X1
  nostagger: { LOAD_USE: 5, FULL: 3, MISPREDICT: 8, MDU_SCALE: 2, REDIRECT_SCALE: 3, MISS_SCALE: 535 / 249, NO_STAGGER: true },
};
const args = process.argv.slice(2);
const mapName = (args.find(a => a.startsWith('--map=')) || '--map=plan').slice(6);
const P = MAPS[mapName];
if (!P) { console.error(`unknown map ${mapName}: ${Object.keys(MAPS).join(', ')}`); process.exit(1); }
const verbose = args.includes('--verbose');

const STAGGER_PRODUCERS = new Set(['ADD', 'SUB', 'AND', 'OR', 'XOR', 'COPY_B', 'ANDN', 'ORN', 'XNOR']);
const bits = (w, hi, lo) => (w >>> lo) & ((1 << (hi - lo + 1)) - 1);

function estimate(file) {
  const img = assemble(fs.readFileSync(file, 'utf8'));
  const core = new Core(img, { ...CONFIGS.turbo, bp: true });
  const events = core.run(5e6, true);
  const info = new Map(); // id -> { pc, mispredict, busy }
  const retired = [];
  let R = 0, I = 0, D = 0;
  for (const ev of events) {
    const ex = ev.stages.EXECUTE;
    if (ex) {
      const r = info.get(ex.id) || { pc: ex.pc, mispredict: false, busy: 0 };
      if (ev.resolve && ev.resolve.mispredict) r.mispredict = true;
      if (ev.busy) r.busy++;
      info.set(ex.id, r);
    }
    if (ev.stages.WRITEBACK) retired.push(ev.stages.WRITEBACK.id);
    if (ev.redirect) R++;
    if (ev.imiss) I++;
    if (ev.dmiss) D++;
  }
  const ready = new Array(32).fill(0), full = new Array(32).fill(0); // cycle a consumer may be in X1: low-bits-first / whole value
  let x1 = 0, prevBranchPenalty = 0, mduExtra = 0, n = 0;
  const parts = { dep: 0, branch: 0 }; // cycles X1 waited, by reason
  for (const id of retired) {
    const r = info.get(id);
    if (!r) continue; // the interrupt pseudo-instruction never reaches here as a retired instruction
    const word = core.fetch(r.pc), c = control(word);
    const rs1 = bits(word, 19, 15), rs2 = bits(word, 24, 20), rd = bits(word, 11, 7);
    const op = word & 0x7f;
    const readsRs1 = !(op === 0x37 || op === 0x17 || op === 0x6f) && !(op === 0x73 && c.csrImm);
    const readsRs2 = op === 0x33 || op === 0x3b || op === 0x23 || op === 0x63 || (op === 0x0b && bits(word, 14, 12) < 4);
    // consumers that work low bits first: adds and logic, load / store addresses, JALR targets, and branch
    // compares (equal and less-than are decided slice by slice, low slice first, like the add's carry)
    const lowFirst = (['ADD', 'SUB', 'AND', 'OR', 'XOR', 'ANDN', 'ORN', 'XNOR', 'JALR'].includes(c.aluOp) && !c.isMulDiv) || !!c.isBranch;
    const need = reg => (reg === 0 ? 0 : (lowFirst && !P.NO_STAGGER ? ready[reg] : full[reg]));
    let t = Math.max(x1 + 1, prevBranchPenalty);
    parts.branch += t - (x1 + 1);
    const tb = t;
    if (readsRs1) t = Math.max(t, need(rs1));
    if (readsRs2) t = Math.max(t, c.memWrite ? ready[rs2] : need(rs2)); // store data is written low bits first
    parts.dep += t - tb;
    x1 = t;
    if (c.isMulDiv) mduExtra += r.busy * P.MDU_SCALE;
    if (c.regWrite && rd !== 0) {
      let lat, lowLat;
      if (c.memRead || c.wbSel === 3 || c.aluOp === 'CUSTOM') lat = lowLat = P.LOAD_USE;
      else if (c.isMulDiv) lat = lowLat = P.FULL;
      else if (c.isJal || c.isJalr) lat = lowLat = 1; // the link (PC + 4) is known in DECODE
      else if (STAGGER_PRODUCERS.has(c.aluOp) && !P.NO_STAGGER) { lowLat = 1; lat = P.FULL; }
      else if (P.NO_STAGGER && STAGGER_PRODUCERS.has(c.aluOp)) lat = lowLat = 1;
      else lat = lowLat = P.FULL;
      ready[rd] = t + lowLat; full[rd] = t + lat;
    }
    prevBranchPenalty = r.mispredict ? t + P.MISPREDICT + 1 : 0;
    n++;
  }
  const cycles = x1 + 11 /* X1 to W of the last one, plus the fill F1..D2 */ + mduExtra + Math.round(R * P.REDIRECT_SCALE + (I + D) * P.MISS_SCALE) + core.stats.interrupts;
  return { n, cycles, turbo: core.stats.cycles, turboN: core.stats.retired, parts: { ...parts, mdu: mduExtra, redirect: Math.round(R * P.REDIRECT_SCALE), miss: Math.round((I + D) * P.MISS_SCALE) } };
}

let N = 0, C = 0, TC = 0, TN = 0;
const PARTS = { dep: 0, branch: 0, mdu: 0, redirect: 0, miss: 0 };
const ONLY = { programs: { N: 0, C: 0, TC: 0, TN: 0 }, tests: { N: 0, C: 0, TC: 0, TN: 0 } }; // the example programs alone, the stress tests alone
for (const dir of ['programs', 'tests']) for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.s')).sort()) {
  const r = estimate(`${dir}/${f}`);
  N += r.n; C += r.cycles; TC += r.turbo; TN += r.turboN;
  for (const k in PARTS) PARTS[k] += r.parts[k];
  const o = ONLY[dir]; o.N += r.n; o.C += r.cycles; o.TC += r.turbo; o.TN += r.turboN;
  if (verbose) console.log(`${(dir + '/' + f).padEnd(40)} turbo CPI ${(r.turbo / r.turboN).toFixed(2)}   deep estimate ${(r.cycles / r.n).toFixed(2)}`);
}
console.log(`map ${mapName}: turbo CPI ${(TC / TN).toFixed(3)} (model), deep CPI ${(C / N).toFixed(3)} (estimate) over ${N} instructions`);
console.log('cycles above one per instruction, by reason (per instruction): ' + Object.entries(PARTS).map(([k, v]) => `${k} ${(v / N).toFixed(3)}`).join(', '));
for (const [k, o] of Object.entries(ONLY)) console.log(`  ${k.padEnd(9)} only: turbo CPI ${(o.TC / o.TN).toFixed(3)}, deep CPI ${(o.C / o.N).toFixed(3)} (estimate)`);
