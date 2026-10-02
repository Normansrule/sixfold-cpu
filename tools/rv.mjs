#!/usr/bin/env node
// =============================================================================
// tools/rv.mjs: command-line front end for Sixfold.
//
//   node tools/rv.mjs asm    programs/05_fibonacci.s        -> build/05_fibonacci.{hex,lst}
//   node tools/rv.mjs run    programs/05_fibonacci.s        run on the cycle-exact model
//   node tools/rv.mjs pipe   programs/02_forwarding.s       ASCII pipeline chart
//   node tools/rv.mjs cycle  programs/03_load_use.s 8       explain one clock cycle
//   node tools/rv.mjs bp     programs/11_gshare_patterns.s  predictor off vs gshare with 1..12 history bits
//   node tools/rv.mjs encode "add a0, a1, a2"               show the binary fields
//   node tools/rv.mjs decode 0x00c58533                     binary -> assembly
//   node tools/rv.mjs isa                                   list every instruction
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { assemble, toHex, toListing } from '../model/asm.js';
import { Core, STAGES, SHORT, DEFAULT_HISTORY_BITS, WB_NAMES, CONFIGS } from '../model/core.js';
import { decode, disasm, INSTRUCTIONS, FORMATS, ABI } from '../model/isa.js';

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const C = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const STAGE_COLOR = { FETCH1: 36, FETCH2: 96, DECODE: 34, EXECUTE: 33, MEMORY: 32, WRITEBACK: 31 };
const FIELD_COLORS = [36, 34, 35, 33, 32, 31];

function usage() {
  console.log(`usage: node tools/rv.mjs <command> [args]

  asm    <file.s> [-o outbase]     assemble to <outbase>.hex and <outbase>.lst (default build/<name>)
  run    <file.s> [--trace f] [--max N] [--quiet]
                                   run on the cycle-exact pipeline model
  pipe   <file.s> [--cycles N] [--from C]
                                   print a pipeline chart (instruction x cycle)
  cycle  <file.s> <C>              explain everything that happens in cycle C
  bp     <file.s>                  predictor off vs gshare with 1..12 history bits
  run/pipe/cycle accept --bp=off, --history=N (default ${DEFAULT_HISTORY_BITS}) and --config=baseline (the original design)
  encode "<instruction>"           show the binary encoding field by field
  decode <hexword> [...]           decode 32-bit machine words
  isa                              table of every supported instruction`);
}

function load(file) {
  const src = fs.readFileSync(file, 'utf8');
  try { return { src, img: assemble(src) }; }
  catch (e) { console.error(C(31, `assembly failed for ${file}:\n`) + e.message); process.exit(1); }
}
function opt(args, name, def) { const a = args.find(x => x.startsWith(name + '=')); if (a) return a.slice(name.length + 1); const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; }
function coreOpts(args) {
  const cfg = CONFIGS[opt(args, '--config', 'performance')] || CONFIGS.performance;
  return { ...cfg, bp: opt(args, '--bp', 'on') !== 'off', historyBits: +opt(args, '--history', cfg.historyBits) };
}
const hex64 = v => '0x' + v.toString(16).padStart(16, '0');
const signed = v => BigInt.asIntN(64, v);

function cmdAsm(args) {
  const file = args[0];
  const { img } = load(file);
  const base = opt(args, '-o', path.join('build', path.basename(file).replace(/\.s$/, '')));
  fs.mkdirSync(path.dirname(base), { recursive: true });
  fs.writeFileSync(base + '.hex', toHex(img));
  fs.writeFileSync(base + '.lst', toListing(img));
  const n = img.listing.filter(l => l.word !== undefined).length;
  console.log(`${file}: ${n} instructions, ${img.used[1] - img.used[0]} bytes at 0x${img.used[0].toString(16)} -> ${base}.hex, ${base}.lst`);
}

export function summary(core) {
  const s = core.stats, b = s.bubbles;
  return [
    `cycles ${s.cycles}   instructions ${s.retired}   CPI ${(s.cycles / s.retired).toFixed(3)}   tohost ${core.csr.tohost}${core.csr.tohost === 1n ? ' (PASS)' : ` (FAIL in test ${core.csr.tohost >> 1n})`}`,
    `cycles = instructions + bubbles:  ${s.cycles} = ${s.retired} + ${b.fill} fill + ${b.loaduse} load-stall + ${b.flush} flush + ${b.redirect} redirect + ${b.muldiv} multiply/divide busy + ${b.imiss} I-cache + ${b.dmiss} D-cache${b.interrupt ? ` + ${b.interrupt} interrupt` : ''}`,
    `load stalls ${s.loadStalls} (${s.falseLoadStalls} false)   flushes ${s.flushes} (${s.mispredicts} branch mispredicts, ${s.jalrFlushes} JALR)   FETCH2 redirects ${s.redirects}   forwards ${s.forwards}`,
    `BTB redirects ${s.btbRedirects}   returns predicted ${s.returnsPredicted}   I-cache misses ${s.icacheMisses} (+${s.prefetches || 0} prefetches)   D-cache misses ${s.dcacheMisses}   build: ${core.opts.btb ? 'performance' : 'baseline'}`,
    `branches ${s.branches}   predictor accuracy ${s.branches ? (100 * (1 - s.mispredicts / s.branches)).toFixed(1) + '%' : '-'}   (${core.bp.enabled ? `gshare, ${core.bp.historyBits} history bits, ${1 << core.bp.historyBits} counters` : 'predictor off: always not taken'})`,
  ];
}

function cmdRun(args) {
  const { img } = load(args[0]);
  const core = new Core(img, coreOpts(args));
  const max = +opt(args, '--max', 5e6), tf = opt(args, '--trace', null), lines = [];
  while (!core.halted && core.cycle < max) { const ev = core.step(); if (tf) lines.push(Core.traceLine(ev)); }
  if (tf) fs.writeFileSync(tf, lines.join('\n') + '\n');
  if (!core.halted) {
    const waits = /FPGA-STEPS|FPGA-INPUT|fpga\/examples\//.test(args[0] + (fs.existsSync(args[0]) ? fs.readFileSync(args[0], 'utf8') : ''));
    console.error(C(31, `no tohost write after ${max} cycles`) + (waits ? `\n(this program waits for buttons, switches or keys: try it in the site's FPGA console, or run node tools/fpga_sim.mjs ${args[0]})` : ''));
    process.exit(2);
  }
  if (core.output) { console.log(C(1, '── program output ─────────────────────────────────')); process.stdout.write(core.output); if (!core.output.endsWith('\n')) console.log(); }
  console.log(C(1, '── summary ────────────────────────────────────────'));
  for (const l of summary(core)) console.log(l);
  if (!args.includes('--quiet')) {
    console.log(C(1, '── registers ──────────────────────────────────────'));
    for (let i = 0; i < 32; i += 2) {
      const f = k => `${('x' + k + '/' + ABI[k]).padEnd(8)} ${hex64(core.regs[k])} ${String(signed(core.regs[k])).padStart(21)}`;
      console.log(`${f(i)}    ${f(i + 1)}`);
    }
  }
}

export function pipelineChart(core, events, from = 1, count = 40) {
  const rows = new Map();
  for (const ev of events) {
    if (ev.cycle < from || ev.cycle >= from + count) continue;
    for (const s of STAGES) {
      const x = ev.stages[s]; if (!x) continue;
      if (!rows.has(x.id)) rows.set(x.id, { cells: {} });
      const stalled = ev.stall && ['FETCH1', 'FETCH2', 'DECODE'].includes(s);
      rows.get(x.id).cells[ev.cycle] = { s, stalled, fwd: s === 'DECODE' && (ev.fwd.a || ev.fwd.b) };
    }
  }
  const W = 3, head = ' '.repeat(34) + Array.from({ length: count }, (_, k) => String(from + k).padStart(W)).join('');
  const out = [head];
  for (const [id, r] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    const inst = core.instrs[id];
    let line = `${inst.pc.toString(16).padStart(5)} ${inst.text.slice(0, 27).padEnd(28)}`;
    for (let c = from; c < from + count; c++) {
      const cell = r.cells[c];
      if (!cell) { line += ' '.repeat(W); continue; }
      let t = SHORT[cell.s].padStart(2);
      if (cell.stalled) t = t.trim().toLowerCase().padStart(2);
      if (cell.fwd) t = t.trim() + '*';
      line += C(inst.squashed ? 90 : STAGE_COLOR[cell.s], t.padStart(W));
    }
    if (inst.squashed) line += C(90, '  (squashed)');
    out.push(line);
  }
  out.push('', 'F1 F2 = FETCH1 FETCH2   D = DECODE   E = EXECUTE   M = MEMORY   W = WRITEBACK',
    'lower case = held by LOAD_STALL    D* = an operand was forwarded into DECODE    grey = squashed (wrong path)');
  return out.join('\n');
}

function cmdPipe(args) {
  const { img } = load(args[0]);
  const core = new Core(img, coreOpts(args));
  const events = core.run();
  console.log(pipelineChart(core, events, +opt(args, '--from', 1), +opt(args, '--cycles', 40)));
  console.log(''); for (const l of summary(core)) console.log(l);
}

function cmdCycle(args) {
  const { img } = load(args[0]);
  const target = +args[1];
  const core = new Core(img, coreOpts(args));
  let ev = null;
  while (!core.halted) { ev = core.step(); if (ev.cycle === target) break; }
  if (!ev || ev.cycle !== target) { console.log(`program finished after ${core.cycle} cycles`); return; }
  console.log(C(1, `── cycle ${target} ──`));
  for (const s of STAGES) {
    const x = ev.stages[s];
    console.log(`  ${C(STAGE_COLOR[s], s.padEnd(9))} ${x ? `0x${x.pc.toString(16).padStart(5, '0')}  ${core.instrs[x.id].text}${core.instrs[x.id].squashed ? C(90, '   (will be squashed)') : ''}` : C(90, '(bubble)')}`);
  }
  const p = ev.predict;
  console.log(`  FETCH1 gshare: index = PC bits ${p.pcBits.toString(2).padStart(core.bp.historyBits, '0')} XOR history ${p.ghr.toString(2).padStart(core.bp.historyBits, '0')} = ${p.idx}, counter ${p.counter.toString(2).padStart(2, '0')} -> ${p.taken ? 'predict TAKEN' : 'predict not taken'}`);
  if (ev.predecode) console.log(`  FETCH2 sees a ${ev.predecode.kind.toUpperCase()}: ${ev.predecode.predicted ? `redirect FETCH1 to 0x${ev.predecode.target.toString(16)}` : 'predicted not taken, keep fetching PC+4'}`);
  if (ev.fwd && (ev.fwd.a || ev.fwd.b)) console.log(`  DECODE forwarding: rs1 <- ${ev.fwd.a || 'register file'}, rs2 <- ${ev.fwd.b || 'register file'}`);
  if (ev.alu) console.log(`  EXECUTE ${ev.alu.unit} ${ev.alu.op}${ev.alu.word ? ' (32-bit W)' : ''}: ${hex64(ev.alu.a)} , ${hex64(ev.alu.b)} -> ${hex64(ev.alu.result)}`);
  if (ev.resolve) console.log(`  EXECUTE resolves ${ev.resolve.kind.toUpperCase()}: predicted ${ev.resolve.predicted ? 'taken' : 'not taken'}, actually ${ev.resolve.actual ? 'taken' : 'not taken'}${ev.resolve.mispredict ? C(31, ' -> WRONG, flush') : C(32, ' -> correct')}`);
  if (ev.memAccess) console.log(`  ${ev.memAccess.kind === 'load' ? 'MEMORY load' : 'EXECUTE store'} address ${hex64(ev.memAccess.addr)} value ${hex64(ev.memAccess.value)}`);
  if (ev.rfWrite) console.log(`  WRITEBACK x${ev.rfWrite.rd} (${ABI[ev.rfWrite.rd]}) <- ${hex64(ev.rfWrite.value)}`);
  if (ev.stall) console.log(C(33, `  LOAD_STALL${ev.loadStallReal ? '' : ' (FALSE: the instruction does not really read that register)'}: FETCH1, FETCH2, DECODE hold; NOP into EXECUTE`));
  if (ev.flush) console.log(C(35, `  FLUSH_FETCH1_FETCH2_DECODE: 3 younger instructions squashed, history restored to ${ev.ghrRestore.toString(2).padStart(core.bp.historyBits, '0')}`));
  if (ev.redirect) console.log(C(36, '  REDIRECT from FETCH2: the instruction in FETCH1 is squashed (1 bubble)'));
  if (ev.bpUpdate) console.log(`  gshare trains counter ${ev.bpUpdate.idx}: ${ev.bpUpdate.before.toString(2).padStart(2, '0')} -> ${ev.bpUpdate.after.toString(2).padStart(2, '0')}`);
  if (ev.halt) console.log(C(31, '  HALT: the tohost write reached WRITEBACK, simulation ends'));
}

export function fieldBreakdown(word, fmt) {
  const b = word.toString(2).padStart(32, '0');
  return FORMATS[fmt].map(([name, hi, lo]) => ({ name, hi, lo, bits: b.slice(31 - hi, 32 - lo) }));
}

function showFields(word) {
  const d = decode(word);
  if (!d.def) { console.log(`0x${word.toString(16).padStart(8, '0')}  ->  illegal / unsupported`); return; }
  const f = fieldBreakdown(word, d.fmt);
  console.log(`${C(1, disasm(d))}    [${d.def.desc}, ${d.fmt}-type, ${d.def.ext}]`);
  console.log(`  hex     0x${word.toString(16).padStart(8, '0')}`);
  console.log(`  binary  ${f.map((x, k) => C(FIELD_COLORS[k % 6], x.bits)).join(' ')}`);
  for (const x of f) console.log(`          ${x.name.padEnd(24)} [${String(x.hi).padStart(2)}:${String(x.lo).padStart(2)}]  ${x.bits}`);
  console.log(`  meaning ${d.def.sem}`);
}

function cmdEncode(args) {
  let img;
  try { img = assemble(args.join(' ')); } catch (e) { console.error(e.message); process.exit(1); }
  for (const l of img.listing) if (l.word !== undefined) { showFields(l.word); console.log(); }
}

function cmdDecode(args) {
  for (const a of args) { showFields(parseInt(a.replace(/_/g, ''), 16) >>> 0); console.log(); }
}

export function predictorSweep(img, maxBits = 12, base = CONFIGS.performance) {
  const rows = [];
  const run = (label, o) => { const core = new Core(img, o); core.run(5e6, false); const s = core.stats; rows.push({ label, bits: o.bp ? o.historyBits : 0, cycles: s.cycles, cpi: s.cycles / s.retired, mispredicts: s.mispredicts, branches: s.branches, accuracy: s.branches ? 1 - s.mispredicts / s.branches : 1, redirects: s.redirects }); };
  run('off (always not taken)', { ...base, bp: false });
  for (let h = 1; h <= maxBits; h++) run(`gshare ${String(h).padStart(2)} bits (${String(1 << h).padStart(4)} counters)`, { ...base, bp: true, historyBits: h });
  return rows;
}

function cmdBp(args) {
  const { img } = load(args[0]);
  const config = CONFIGS[opt(args, '--config', 'performance')] ? opt(args, '--config', 'performance') : 'performance';
  console.log(config === 'baseline' ? 'the baseline build (gshare alone, no BTB, no RAS): predictor off, then gshare with 1 to 12 history bits:\n'
    : 'the performance edition (BHT + gshare + chooser, BTB, RAS): predictor off, then gshare with 1 to 12 history bits:\n');
  console.log('predictor                              cycles     CPI  mispredicts  accuracy');
  for (const r of predictorSweep(img, 12, CONFIGS[config])) {
    const mark = r.bits === CONFIGS[config].historyBits ? `  <- this build's GSHARE_HISTORY_BITS` : '';
    console.log(`${r.label.padEnd(38)} ${String(r.cycles).padStart(7)}  ${r.cpi.toFixed(3)}  ${String(r.mispredicts).padStart(11)}  ${(100 * r.accuracy).toFixed(1).padStart(7)}%${mark}`);
  }
  console.log('\naccuracy = conditional branches predicted correctly / all conditional branches');
  console.log(config === 'baseline' ? '(JAL is always right: FETCH2 reads its target from the instruction. JALR always flushes.)'
    : '(JALs are always right: the BTB or FETCH2 knows the target. Returns use the return address stack; other JALRs flush.)');
}

function cmdIsa() {
  console.log('NAME     FMT     OPCODE   F3   F7/F6    EXT    DESCRIPTION');
  for (const i of INSTRUCTIONS) {
    const f3 = i.funct3 === null ? '---' : i.funct3.toString(2).padStart(3, '0');
    const f7 = i.funct7 === null ? '-------' : i.funct7.toString(2).padStart(i.fmt === 'I-sh64' ? 6 : 7, '0');
    console.log(`${i.name.padEnd(8)} ${i.fmt.padEnd(7)} ${i.opcode.toString(2).padStart(7, '0')}  ${f3}  ${f7.padEnd(8)} ${i.ext.padEnd(6)} ${i.desc}`);
  }
  console.log(`\n${INSTRUCTIONS.length} instructions`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const [cmd, ...args] = process.argv.slice(2);
  const cmds = { asm: cmdAsm, run: cmdRun, pipe: cmdPipe, cycle: cmdCycle, bp: cmdBp, encode: cmdEncode, decode: cmdDecode, isa: cmdIsa };
  if (!cmds[cmd] || (cmd !== 'isa' && !args.length)) { usage(); process.exit(cmd ? 1 : 0); }
  cmds[cmd](args);
}
