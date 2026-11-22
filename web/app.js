// =============================================================================
// web/app.js: interactive front end for model/core.js, the cycle-exact twin of
// src/Riscv64.sv (the RTL is regression-tested against it every cycle).
// =============================================================================
import { assemble } from '../model/asm.js';
import { Core, STAGES, SHORT, DEFAULT_HISTORY_BITS, WB_NAMES, control } from '../model/core.js';
import { decode, disasm, FORMATS, ABI, registerCustom, DEFAULT_CUSTOM } from '../model/isa.js';
import { decodeShare } from '../model/custom.js';
import { PROGRAMS } from './programs.js';
import { parseRegions, RegionTracker, profile, drawTimeline } from './regions.js';
import { buildDisplay } from './sevenseg.js';

const $ = id => document.getElementById(id);
const STAGE_INFO = {
  FETCH1: 'PC, BTB, BHT + gshare', FETCH2: 'predecode + redirect', DECODE: 'control, registers, forwarding',
  EXECUTE: 'ALU, branches, CSR', MEMORY: 'load data', WRITEBACK: 'write rd, retire',
};
const FRONT = ['FETCH1', 'FETCH2', 'DECODE'];
const hex = (v, n = 4) => '0x' + (v >>> 0).toString(16).padStart(n, '0');
const hex64 = v => '0x' + v.toString(16).padStart(16, '0');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const sgn = v => BigInt.asIntN(64, v);
const bin = (v, n) => v.toString(2).padStart(n, '0');

// Only the last KEEP cycles are kept (the chart shows 26): a long program (22_multitasking runs 83,000
// cycles) would otherwise hold every cycle's record in memory. Back and seeking replay from reset.
const KEEP = 64, MAX_CYCLES = 5_000_000;
let img = null, source = '', core = null, events = [], timer = null, selAddr = null, traps = [], regions = null, tracker = null, prof = null;
const opts = () => ({ bp: $('bp').checked, historyBits: Number($('hist').value), xcompute: true }); // the packed set is on in every build (docs/XCOMPUTE.md)
const textOf = x => (x ? core.instrs[x.id].text : '');

// ------------------------------------------------------------------ loading
function loadSource(src) {
  try { img = assemble(src); source = src; $('asmerr').textContent = ''; $('src').value = src; reset(); return true; }
  catch (e) { $('asmerr').textContent = e.message; return false; }
}
function fresh() {
  core = new Core(img, opts()); events = []; traps = [];
  regions = parseRegions(source, img.symbols); tracker = regions ? new RegionTracker(regions) : null;
}
function reset() { stop(); fresh(); prof = null; startProfile(); render(); }
function advance() { // one clock cycle, with the bookkeeping the panels need
  const ev = core.step();
  events.push(ev); if (events.length > KEEP) events.shift();
  if (tracker) tracker.step(ev);
  if (ev.trap) traps.push({ cycle: ev.cycle, kind: ev.trap.kind, pc: ev.stages.EXECUTE ? ev.stages.EXECUTE.pc : 0, to: ev.trap.to });
  if (traps.length > 200) traps.shift();
  return ev;
}
function step() { if (!core || core.halted) { stop(); return; } advance(); render(); }
function seek(target) { // replay from reset to cycle target
  stop(); fresh();
  while (core.cycle < target && !core.halted) advance();
  render();
}
function back() { if (core.cycle) seek(core.cycle - 1); }
// Speed slider: cycles per second, from about 1 to about 30,000 (exponential)
const cyclesPerSecond = () => Math.round(2 ** (Number($('speed').value) / 6.7));
function run() {
  if (timer) { stop(); return; }
  if (core.halted) return;
  $('run').textContent = 'Pause';
  let last = performance.now(), owed = 0;
  const tick = now => {
    owed += Math.min(250, now - last) * cyclesPerSecond() / 1000; last = now;
    for (; owed >= 1 && !core.halted; owed--) advance();
    render();
    if (core.halted) stop(); else timer = requestAnimationFrame(tick);
  };
  timer = requestAnimationFrame(tick);
}
function stop() { if (timer) cancelAnimationFrame(timer); timer = null; $('run').textContent = 'Run'; }
function runToEnd() { // as fast as the model goes, in slices so the page stays responsive
  stop();
  const slice = () => {
    const t0 = performance.now();
    while (!core.halted && core.cycle < MAX_CYCLES && performance.now() - t0 < 40) for (let k = 0; k < 500 && !core.halted; k++) advance();
    render();
    if (!core.halted && core.cycle < MAX_CYCLES) timer = requestAnimationFrame(slice); else stop();
  };
  $('run').textContent = 'Pause'; timer = requestAnimationFrame(slice);
}

// ------------------------------------------------------------------ render
function render() {
  const ev = events[events.length - 1] || null, prev = events[events.length - 2] || null;
  $('cycle').textContent = ev ? ev.cycle : 0;
  const st = $('status'); st.className = 'status';
  if (!ev) st.textContent = 'reset: pipeline empty, FETCH1_PC = 0x2000';
  else if (ev.halt) { st.textContent = `halted: tohost = ${core.csr.tohost}${core.csr.tohost === 1n ? ' (PASS)' : ` (FAIL in test ${core.csr.tohost >> 1n})`}`; st.classList.add('halt'); }
  else if (ev.interrupt) { st.textContent = `${ev.trap.kind} in EXECUTE: trap to mtvec ${hex(ev.trap.to)}, the replaced instruction runs after mret`; st.classList.add('flush'); }
  else if (ev.interruptTaken) { st.textContent = 'DECODE_TAKES_INTERRUPT: the instruction in DECODE is replaced by the interrupt'; st.classList.add('flush'); }
  else if (ev.trap) { st.textContent = ev.trap.kind === 'mret' ? `mret: back to ${hex(ev.trap.to)}, interrupts on again (MIE = MPIE)` : `${ev.trap.kind}: trap to mtvec ${hex(ev.trap.to)}`; st.classList.add('flush'); }
  else if (ev.stall) { st.textContent = `LOAD_STALL${ev.loadStallReal ? '' : ' (false stall)'}`; st.classList.add('stall'); }
  else if (ev.busy) { st.textContent = 'MULTIPLY_DIVIDE_STALL: the M unit is iterating'; st.classList.add('stall'); }
  else if (ev.dmiss) { st.textContent = 'DATA_CACHE_STALL: the load waits for its cache line'; st.classList.add('stall'); }
  else if (ev.imiss) { st.textContent = 'Instruction cache miss: FETCH1 waits for main memory'; st.classList.add('stall'); }
  else if (ev.flush) { st.textContent = ev.resolve && ev.resolve.kind === 'jalr' ? 'FLUSH_FETCH1_FETCH2_DECODE: JALR target was not predicted, 3 instructions squashed' : 'FLUSH_FETCH1_FETCH2_DECODE: wrong guess, 3 instructions squashed'; st.classList.add('flush'); }
  else if (ev.redirect) { st.textContent = 'FETCH2 redirect: 1 instruction squashed'; st.classList.add('flush'); }
  else st.textContent = '';
  renderStages(ev, prev); renderNarration(ev); renderChart(); renderListing(ev); renderRegs(ev); renderPredictor(ev); renderStats(); renderMachine(); renderTimeline();
  $('output').textContent = core.output || '(nothing printed yet: programs print by storing a byte to 0x10000000)';
  $('leds').innerHTML = [...Array(16).keys()].reverse().map(i => `<span class="led${(core.leds >> i) & 1 ? ' on' : ''}" title="LED ${i}"></span>`).join('');
  showDisplay(core.display);
}

function renderStages(ev, prev) {
  $('stages').innerHTML = STAGES.map(s => {
    const x = ev && ev.stages[s];
    let body;
    if (!x) body = `<div class="empty">${ev ? 'bubble' : 'empty'}</div>`;
    else {
      const entered = !prev || !prev.stages[s] || prev.stages[s].id !== x.id;
      const tags = [];
      const stalled = ev.stall && FRONT.includes(s);
      const killed = (ev.flush && FRONT.includes(s)) || (ev.redirect && s === 'FETCH1');
      if (stalled) tags.push('<span class="tag stall">held</span>');
      if (s === 'FETCH1') tags.push(`<span class="tag pred">${ev.predict.chooser ? `${ev.predict.chooser} says` : `counter[${ev.predict.idx}] = ${bin(ev.predict.counter, 2)}:`} ${ev.predict.taken ? 'taken' : 'not taken'}</span>`);
      if (s === 'FETCH1' && ev.btb && ev.btb.redirect) tags.push(`<span class="tag pred">BTB hit: next ${hex(ev.btb.target)}</span>`);
      if (s === 'FETCH2' && ev.predecode) tags.push(`<span class="tag pred">${ev.predecode.kind === 'jal' ? 'JAL: redirect' : ev.predecode.kind === 'return' ? 'return: address from the RAS' : ev.predecode.predicted ? 'branch, predicted taken: redirect' : 'branch, predicted not taken'}</span>`);
      if (s === 'DECODE' && ev.interruptTaken) tags.push('<span class="tag miss">replaced by the interrupt</span>');
      if (s === 'DECODE') {
        if (ev.fwd.a) tags.push(`<span class="tag fwd">rs1 ← ${ev.fwd.a}</span>`);
        if (ev.fwd.b) tags.push(`<span class="tag fwd">rs2 ← ${ev.fwd.b}</span>`);
      }
      if (s === 'EXECUTE') {
        if (ev.alu) tags.push(`<span class="tag ok">${ev.alu.unit} ${ev.alu.op}${ev.alu.word ? 'W' : ''}</span>`);
        if (ev.resolve && ev.resolve.kind !== 'jal') tags.push(ev.resolve.mispredict ? `<span class="tag miss">${ev.resolve.kind === 'jalr' ? 'JALR: always flush' : 'guess was wrong'}</span>` : '<span class="tag ok">guess was right</span>');
        if (ev.csrWrite) tags.push(`<span class="tag ok">CSR write</span>`);
      }
      if (s === 'MEMORY' && ev.memAccess && ev.memAccess.kind === 'load') tags.push(`<span class="tag ok">load ${hex(Number(ev.memAccess.addr & 0xffffffffn))}</span>`);
      if (s === 'EXECUTE' && ev.memAccess && ev.memAccess.kind === 'store') tags.push(`<span class="tag ok">store ${hex(Number(ev.memAccess.addr & 0xffffffffn))}</span>`);
      if (s === 'WRITEBACK' && ev.rfWrite) tags.push(`<span class="tag ok">${ABI[ev.rfWrite.rd]} ← ${sgn(ev.rfWrite.value)}</span>`);
      if (killed) tags.push('<span class="tag miss">squashed at the clock edge</span>');
      const isIntr = s === 'EXECUTE' && ev.interrupt;
      if (isIntr) tags.push(`<span class="tag miss">trap to ${hex(ev.trap.to)}</span>`);
      if (s === 'EXECUTE' && ev.trap && !ev.interrupt) tags.push(`<span class="tag miss">${ev.trap.kind}: to ${hex(ev.trap.to)}</span>`);
      const label = isIntr ? `${ev.trap.kind}<br><small>in place of ${esc(textOf(x))}</small>` : esc(textOf(x));
      body = `<div class="chip${entered ? ' enter' : ''}${stalled ? ' stalled' : ''}${isIntr ? ' intr' : ''}" style="background:color-mix(in srgb, var(--${s}) 65%, #000)${killed ? ';filter:grayscale(1)' : ''}">
        <div class="pc">${hex(x.pc)}</div>${label}</div><div class="tags">${tags.join('')}</div>`;
    }
    return `<div class="stage"><h3>${s} <small>${STAGE_INFO[s]}</small></h3><div class="bar" style="background:var(--${s})"></div>${body}</div>`;
  }).join('');
}

function renderNarration(ev) {
  const L = [];
  if (!ev) L.push('Press <b>Step</b> to clock the pipeline. In cycle 1 FETCH1 sends the reset PC 0x2000 to the instruction memory.');
  else {
    const S = ev.stages, p = ev.predict, H = core.bp.historyBits;
    L.push(`<b>FETCH1</b> ${hex(S.FETCH1.pc)}: gshare index = PC bits <code>${bin(p.pcBits, H)}</code> XOR history <code>${bin(p.ghr, H)}</code> = ${p.idx}, counter <code>${bin(p.counter, 2)}</code> → ${p.taken ? 'taken' : 'not taken'}.`);
    if (S.FETCH2) L.push(`<b>FETCH2</b> ${esc(textOf(S.FETCH2))} arrived.${ev.predecode ? (ev.predecode.predicted ? ` Target ${hex(ev.predecode.target)} precomputed: FETCH1 is redirected there.` : ' A branch, predicted not taken: keep going at PC + 4.') : ''}`);
    if (S.DECODE) {
      const c = control(core.instrs[S.DECODE.id].word);
      L.push(`<b>DECODE</b> ${esc(textOf(S.DECODE))}: ALU_OPERATION = ALU_${c.aluOp}, WRITEBACK_SELECT = WRITEBACK_${WB_NAMES[c.wbSel]}${c.regWrite ? ', REGISTER_WRITE_ENABLE' : ''}.${ev.fwd.a || ev.fwd.b ? ` Forwarded: ${[ev.fwd.a && `rs1 from ${ev.fwd.a}`, ev.fwd.b && `rs2 from ${ev.fwd.b}`].filter(Boolean).join(', ')}.` : ''}`);
    }
    if (S.EXECUTE && ev.alu) {
      L.push(`<b>EXECUTE</b> ${esc(textOf(S.EXECUTE))}: ${ev.alu.unit}(${sgn(ev.alu.a)}, ${sgn(ev.alu.b)}) = ${sgn(ev.alu.result)}.`);
      if (ev.resolve && ev.resolve.kind === 'branch') L.push(`<b>BranchControl</b> predicted ${ev.resolve.predicted ? 'taken' : 'not taken'}, actually ${ev.resolve.actual ? 'taken' : 'not taken'}: ${ev.resolve.mispredict ? '<b>wrong</b>, flush 3 and restart.' : 'right, no penalty.'}`);
      if (ev.resolve && ev.resolve.kind === 'jalr') L.push(`<b>BranchControl</b> JALR target ${hex(ev.resolve.target)} comes from a register, it could not be predicted: flush 3.`);
      if (ev.bpUpdate) L.push(`<b>gshare</b> train counter[${ev.bpUpdate.idx}] ${bin(ev.bpUpdate.before, 2)} → ${bin(ev.bpUpdate.after, 2)}.${ev.ghrRestore !== undefined ? ` History restored to <code>${bin(ev.ghrRestore, H)}</code>.` : ''}`);
    }
    if (ev.memAccess) L.push(`<b>${ev.memAccess.kind === 'load' ? 'MEMORY' : 'EXECUTE'}</b> ${ev.memAccess.kind} at ${hex(Number(ev.memAccess.addr & 0xffffffffn))}: ${sgn(ev.memAccess.value)}.`);
    if (ev.rfWrite) L.push(`<b>WRITEBACK</b> x${ev.rfWrite.rd} (${ABI[ev.rfWrite.rd]}) ← ${hex64(ev.rfWrite.value)}.`);
    if (ev.stall) L.push(`<b>LOAD_STALL</b> the load in EXECUTE has no data yet and DECODE's rs1/rs2 field matches its rd${ev.loadStallReal ? '' : ' (a <b>false</b> stall: the instruction does not really read that register, see Lab 5)'}: hold FETCH1, FETCH2, DECODE; NOP into EXECUTE.`);
    if (ev.interruptTaken) L.push(`<b>DECODE_TAKES_INTERRUPT</b> mstatus.MIE and mie allow it and ${ev.interruptTaken.external ? 'the external line' : 'the timer line (MTIME ≥ MTIMECMP)'} is up: the instruction in DECODE (${hex(ev.interruptTaken.pc)}) does not go on; an interrupt pseudo-instruction with its PC goes to EXECUTE instead.`);
    if (ev.interrupt) L.push(`<b>Trap</b> ${ev.trap.kind}: mepc ← ${hex(ev.stages.EXECUTE.pc)} (the replaced instruction), mcause ← 0x${BigInt.asUintN(64, core.csr.mcause).toString(16)}, MPIE ← MIE, MIE ← 0, FLUSH and jump to mtvec ${hex(ev.trap.to)}. Nothing retires: the program never sees it.`);
    else if (ev.trap && ev.trap.kind === 'mret') L.push(`<b>mret</b> back to mepc ${hex(ev.trap.to)}, MIE ← MPIE: interrupts are allowed again.`);
    else if (ev.trap) L.push(`<b>Trap</b> ${ev.trap.kind}: mepc ← its PC, jump to mtvec ${hex(ev.trap.to)}.`);
    if (ev.halt) L.push('<b>HALT</b> the tohost write reached WRITEBACK. The program is finished.');
  }
  $('narration').innerHTML = L.map(x => `<li>${x}</li>`).join('');
}

function renderChart() {
  const N = 26, last = core.cycle, first = Math.max(1, last - N + 1);
  const byCycle = new Map(events.map(ev => [ev.cycle, ev]));
  const rows = new Map();
  for (const ev of events.filter(ev => ev.cycle >= first)) for (const s of STAGES) {
    const x = ev.stages[s]; if (!x) continue;
    if (!rows.has(x.id)) rows.set(x.id, { pc: x.pc, cells: {} });
    rows.get(x.id).cells[ev.cycle] = { s, st: ev.stall && FRONT.includes(s), fw: s === 'DECODE' && (ev.fwd.a || ev.fwd.b) };
  }
  const ids = [...rows.keys()].sort((a, b) => a - b).slice(-18);
  const end = Math.max(last, first + N - 1);
  let h = '<tr><th><span class="sr-only">instruction</span></th>';
  for (let c = first; c <= end; c++) h += `<th>${c}</th>`;
  h += '</tr>';
  for (const id of ids) {
    const r = rows.get(id), sq = core.instrs[id].squashed;
    h += `<tr><td class="label${sq ? ' sq' : ''}">${hex(r.pc)} ${esc(core.instrs[id].text.slice(0, 24))}</td>`;
    for (let c = first; c <= end; c++) {
      const cell = r.cells[c];
      h += cell ? `<td class="c${sq ? ' sq' : ''}${cell.st ? ' st' : ''}${cell.fw ? ' fw' : ''}${c === last ? ' now' : ''}" style="background:color-mix(in srgb, var(--${cell.s}) 65%, #000)">${SHORT[cell.s]}</td>` : '<td></td>';
    }
    h += '</tr>';
  }
  h += '<tr class="hz"><td class="label" style="color:var(--sub)">hazard events</td>';
  for (let c = first; c <= end; c++) {
    const ev = byCycle.get(c);
    h += !ev ? '<td></td>' : ev.interruptTaken || ev.interrupt ? '<td style="background:color-mix(in srgb, var(--WRITEBACK) 65%, #000)">intr</td>' : ev.stall ? '<td style="background:color-mix(in srgb, var(--stall) 65%, #000)">stall</td>'
      : ev.flush ? '<td style="background:color-mix(in srgb, var(--redirect) 65%, #000)">flush</td>' : ev.redirect ? '<td style="background:color-mix(in srgb, var(--FETCH2) 65%, #000)">redir</td>' : ev.busy ? '<td style="background:color-mix(in srgb, var(--DECODE) 65%, #000)">busy</td>'
      : ev.imiss || ev.dmiss ? '<td style="background:color-mix(in srgb, var(--MEMORY) 65%, #000)">miss</td>' : '<td></td>';
  }
  $('chart').innerHTML = h + '</tr>';
}

const FIELD_CLASS = n => { const k = n.split('[')[0]; return ['opcode', 'rd', 'rs1', 'rs2', 'funct3', 'funct7'].includes(k) ? 'f-' + k : (k === 'funct6' || k === 'funct12' ? 'f-funct7' : k === 'csr' ? 'f-funct7' : 'f-imm'); };
function binFields(word) {
  const d = decode(word), b = word.toString(2).padStart(32, '0');
  if (!d.def) return { d, html: `<span>${b}</span>` };
  return { d, parts: FORMATS[d.fmt].map(([n, hi, lo]) => ({ n, bits: b.slice(31 - hi, 32 - lo), cls: FIELD_CLASS(n) })),
    html: FORMATS[d.fmt].map(([n, hi, lo]) => `<span class="${FIELD_CLASS(n)}">${b.slice(31 - hi, 32 - lo)}</span>`).join(' ') };
}
function renderListing(ev) {
  const at = {};
  if (ev) for (const s of STAGES) if (ev.stages[s]) (at[ev.stages[s].pc] ??= []).push(s);
  const rows = img.listing.filter(l => l.word !== undefined);
  $('listing').innerHTML = rows.map(l => {
    const stg = at[l.addr] || [];
    const border = stg.length ? `border-left-color:var(--${stg[stg.length - 1]})` : '';
    return `<tr data-addr="${l.addr}" class="${selAddr === l.addr ? 'sel' : ''}" style="${border}">
      <td class="addr">${hex(l.addr)}</td><td>${stg.map(s => `<span class="stg" style="background:color-mix(in srgb, var(--${s}) 65%, #000)">${SHORT[s]}</span>`).join(' ')}</td>
      <td class="bin">${binFields(l.word).html}</td><td class="src">${esc(l.src)}</td></tr>`;
  }).join('');
  const sel = rows.find(l => l.addr === selAddr) || null;
  if (!sel) { $('bits').innerHTML = '<p class="hint">Click an instruction to see its 32-bit encoding field by field and the control signals the ControlUnit makes from it.</p>'; return; }
  const { d, parts } = binFields(sel.word);
  const c = control(sel.word);
  $('bits').innerHTML = d.def ? `<b>${esc(disasm(d, sel.addr))}</b>: ${esc(d.def.desc)} (${d.fmt}-type) = <code>0x${sel.word.toString(16).padStart(8, '0')}</code>
    <div class="fields">${parts.map(p => `<div class="fld ${p.cls}">${p.bits}<small>${p.n}</small></div>`).join('')}</div>
    <code>${esc(d.def.sem)}</code><p class="hint">ALU_OPERATION = ALU_${c.aluOp} · IMMEDIATE_${c.immType} · WRITEBACK_${WB_NAMES[c.wbSel]} · REGISTER_WRITE_ENABLE = ${c.regWrite} · MEMORY_READ/WRITE = ${c.memRead}/${c.memWrite}</p>` : 'not an instruction';
}

function renderRegs(ev) {
  const w = ev && ev.rfWrite ? ev.rfWrite.rd : -1;
  $('regs').innerHTML = core.regs.map((v, i) =>
    `<div class="${i === w ? 'w' : ''}"><span class="n">x${i} ${ABI[i]}</span><span class="${v === 0n ? 'z' : ''}">${v === 0n ? '0' : hex64(v)}</span></div>`).join('');
}

function renderPredictor(ev) {
  const bp = core.bp, H = bp.historyBits;
  $('ghr').innerHTML = [...bin(bp.ghr, H)].map(t => `<span class="${t === '1' ? 't' : ''}">${t}</span>`).join('');
  const rd = ev ? ev.predict.idx : -1, up = ev && ev.bpUpdate ? ev.bpUpdate.idx : -1;
  let h = '';
  for (let i = 0; i < bp.pht.length; i++) h += `<i class="s${bp.pht[i]}${i === rd ? ' rd' : ''}${i === up ? ' up' : ''}" title="counter ${i}: ${bin(bp.pht[i], 2)}"></i>`;
  $('pht').innerHTML = h;
  $('bpinfo').innerHTML = `${bp.enabled ? `gshare: ${bp.pht.length} two-bit counters, index = <code>PC[${H + 1}:2] XOR GLOBAL_HISTORY_REGISTER</code> (${H} bits).` : 'Predictor OFF: every branch is predicted not taken (JAL still redirects in FETCH2).'} Outline = read in FETCH1 this cycle, ring = trained by the branch in EXECUTE.`;
  // the per-branch table and the chooser of the tournament predictor, the BTB and the RAS
  const t = ev && ev.stages.FETCH1 ? (ev.stages.FETCH1.pc >>> 2) & 127 : -1;
  let b = '', c = '';
  for (let i = 0; i < 128; i++) { b += `<i class="s${core.bht[i]}${i === t ? ' rd' : ''}"></i>`; c += `<i class="s${core.chooser[i] >= 2 ? 3 : 0}${i === t ? ' rd' : ''}" title="chooser ${i}: ${core.chooser[i] >= 2 ? 'trust gshare' : 'trust the BHT'}"></i>`; }
  $('bht').innerHTML = b; $('chooser').innerHTML = c;
  const bi = ev && ev.stages.FETCH1 ? (ev.stages.FETCH1.pc >>> 2) & 15 : -1;
  $('btb').innerHTML = '<tr><th>#</th><th>branch at</th><th>target</th><th><span class="sr-only">state</span></th></tr>' + core.btb.map((e, i) =>
    `<tr class="${i === bi ? 'rd' : ''}"><td>${i}</td><td>${e.valid ? hex((e.tag << 6) | (i << 2)) : '-'}</td><td>${e.valid ? hex(e.target) : '-'}</td><td>${e.valid ? (e.isJal ? 'jal' : 'branch') : ''}</td></tr>`).join('');
  $('ras').innerHTML = core.ras.stack.map((v, i) => `<span class="${i === core.ras.top ? 'top' : ''}" title="entry ${i}">${i === core.ras.top ? 'top → ' : ''}${hex(Number(v & 0xffffffffn))}</span>`).join('');
  $('ghrnote').textContent = ev && ev.ghrRestore !== undefined ? `restored from checkpoint after a flush: ${bin(ev.ghrRestore, H)}` : ev && ev.ghrShift !== undefined ? `a branch left FETCH2: shifted in its predicted direction (${ev.ghrShift})` : '';
}

function renderStats() {
  const s = core.stats, b = s.bubbles;
  const items = [
    ['cycles', s.cycles, true], ['instructions retired', s.retired], ['CPI', s.retired ? (s.cycles / s.retired).toFixed(3) : '-', true],
    ['load stalls (false)', `${s.loadStalls} (${s.falseLoadStalls})`], ['flushes: wrong guess / JALR', `${s.mispredicts} / ${s.jalrFlushes}`],
    ['FETCH2 redirects / BTB hits', `${s.redirects} / ${s.btbRedirects}`], ['multiply/divide busy cycles', s.multiplyDivideBusy], ['cache misses: instruction / data', `${s.icacheMisses} / ${s.dcacheMisses}`], ['branch accuracy', s.branches ? (100 * (1 - s.mispredicts / s.branches)).toFixed(1) + '%' : '-'], ['operands forwarded', s.forwards],
    ['interrupts taken', s.interrupts],
    ['hardware counters hpm3..10 (L F R K I D X B)', core.hpm ? ['stall', 'flush', 'redirect', 'busy', 'imiss', 'dmiss', 'intr', 'late'].map(k => String(core.hpm[k])).join(' · ') : '-'],
  ];
  if (core.halted) {
    const pred = s.retired + 5 + s.loadStalls + 3 * s.flushes + b.redirect + b.muldiv + b.imiss + b.dmiss + b.interrupt + (b.late || 0);
    items.push(['equation check', `${s.retired} + 5 + ${s.loadStalls} + 3×${s.flushes} + ${b.redirect} + ${b.muldiv} + ${b.imiss} + ${b.dmiss} + ${b.interrupt}${b.late ? ' + ' + b.late : ''} = ${pred} ${pred === s.cycles ? '✓' : '✗'}`]);
  }
  $('stats').innerHTML = items.map(([k, v, big]) => `<dt>${k}</dt><dd class="${big ? 'big' : ''}">${v}</dd>`).join('');
}

// ------------------------------------------------------------------ machine mode: CSRs, timer, traps
const CAUSES = { 3: 'breakpoint', 11: 'ecall', [-7]: 'timer interrupt', [-11]: 'external interrupt' };
function renderMachine() {
  const c = core.csr, ms = c.mstatus;
  const bit = (v, n) => Number((v >> BigInt(n)) & 1n);
  const cause = c.mcause === 0n ? '-' : `0x${BigInt.asUintN(64, c.mcause).toString(16)} (${CAUSES[c.mcause >> 63n ? -Number(c.mcause & 0xffn) : Number(c.mcause)] || '?'})`;
  const left = core.mtimecmp - core.mtime;
  const rows = [
    ['mstatus', `MIE ${bit(ms, 3)} · MPIE ${bit(ms, 7)}`, 'interrupts on / what MIE was before the trap'],
    ['mie', `MTIE ${bit(c.mie, 7)} · MEIE ${bit(c.mie, 11)}`, 'which interrupts may happen'],
    ['mip', `MTIP ${core.mip.timer ? 1 : 0} · MEIP ${core.mip.external ? 1 : 0}`, 'which lines are up'],
    ['mtvec', hex(Number(c.mtvec & 0xffffffffn)), 'where traps go'],
    ['mepc', hex(Number(c.mepc & 0xffffffffn)), 'where mret returns'],
    ['mcause', cause, 'why the last trap happened'],
    ['mscratch', c.mscratch ? hex(Number(c.mscratch & 0xffffffffn)) : '0', 'a spare register for the handler'],
    ['MTIME', core.mtime.toString(), 'counts every cycle (0x1000_0058)'],
    ['MTIMECMP', core.mtimecmp === (1n << 64n) - 1n ? 'never (all ones)' : `${core.mtimecmp} (${left > 0n ? `in ${left} cycles` : 'reached'})`, 'the timer line goes up at MTIME ≥ MTIMECMP (0x1000_0060)'],
  ];
  $('csrs').innerHTML = rows.map(([k, v, n]) => `<dt title="${esc(n)}">${k}</dt><dd>${v}</dd>`).join('');
  $('traps').innerHTML = traps.length ? traps.slice(-10).reverse().map(t => `<li><span class="cyc">${t.cycle}</span> <b class="${t.kind === 'mret' ? 'ret' : ''}">${t.kind}</b> ${hex(t.pc)} → ${hex(t.to)}</li>`).join('')
    : '<li class="hint">No traps yet. Programs 21 and 22 use the timer interrupt; ecall and ebreak trap too.</li>';
}

// ------------------------------------------------------------------ who is running (programs with a "# REGIONS:" line)
const REGION_COLORS = ['--FETCH1', '--DECODE', '--MEMORY', '--WRITEBACK', '--stall', '--FETCH2', '--EXECUTE'];
const cssv = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
let profiling = 0;
async function startProfile() {
  const card = $('whocard');
  if (!regions) { card.hidden = true; return; }
  card.hidden = false;
  const token = ++profiling, src = source;
  $('who-legend').textContent = 'measuring the whole run…';
  const p = await profile(src, opts());
  if (token !== profiling || src !== source) return;
  prof = p; renderTimeline();
}
function regionColors() {
  const c = { track: cssv('--sub'), cursor: cssv('--ink'), text: cssv('--sub') };
  regions.names.forEach((n, i) => { c[n] = cssv(REGION_COLORS[i % REGION_COLORS.length]); });
  if (regions.names.includes('asleep')) c.asleep = cssv('--sub');
  return c;
}
function renderTimeline() {
  if (!regions || !prof || $('whocard').hidden) return;
  const colors = regionColors();
  drawTimeline($('who'), prof, colors, { rowHeight: 14, gap: 3, labelWidth: 70, upTo: core.cycle });
  const now = tracker.current >= 0 ? regions.names[tracker.current] : '-';
  $('who-legend').innerHTML = regions.names.map((n, i) => `<span class="${n === now ? 'now' : ''}"><i style="background:${colors[n]}"></i>${esc(n)} ${(100 * prof.perRegion[i] / prof.cycles).toFixed(1)}%</span>`).join('') +
    `<span class="hint">whole run: ${prof.cycles.toLocaleString('en-US')} cycles, ${prof.traps.length} interrupts. Running now: <b>${esc(now)}</b>. Click the chart to jump to a cycle.</span>`;
}
$('who').addEventListener('click', e => {
  if (!prof) return;
  const r = e.currentTarget.getBoundingClientRect(), x = e.clientX - r.left - 70;
  if (x < 0) return;
  seek(Math.round(x / (r.width - 70) * prof.cycles));
});

const showDisplay = buildDisplay($('display'));

// ------------------------------------------------------------------ wiring
const sel = $('prog');
for (const name of Object.keys(PROGRAMS)) sel.add(new Option(name.replace(/_/g, ' '), name));
for (let h = 1; h <= 10; h++) $('hist').add(new Option(`${h} bits (${1 << h} counters)${h === 4 ? ', baseline' : h === DEFAULT_HISTORY_BITS ? ', default' : ''}`, h));
$('hist').value = DEFAULT_HISTORY_BITS;
const wanted = new URLSearchParams(location.search).get('prog');
sel.value = wanted in PROGRAMS ? wanted : '03_load_use' in PROGRAMS ? '03_load_use' : Object.keys(PROGRAMS)[0];
sel.onchange = () => loadSource(PROGRAMS[sel.value]);
$('step').onclick = step; $('back').onclick = back; $('run').onclick = run; $('reset').onclick = reset; $('end').onclick = runToEnd;
$('speed').oninput = () => { $('speed-o').textContent = `${cyclesPerSecond().toLocaleString('en-US')}/s`; };
$('speed').oninput();
addEventListener('resize', () => renderTimeline());
$('bp').onchange = reset; $('hist').onchange = reset;
$('assemble').onclick = () => { if (loadSource($('src').value)) switchTab('listing'); };
$('listing').onclick = e => { const tr = e.target.closest('tr'); if (tr) { selAddr = Number(tr.dataset.addr); render(); } };
function switchTab(t) {
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
  $('tab-listing').hidden = t !== 'listing'; $('tab-edit').hidden = t !== 'edit';
}
document.querySelectorAll('.tabs button').forEach(b => { b.onclick = () => switchTab(b.dataset.tab); });
document.addEventListener('keydown', e => {
  if (e.target.matches('textarea, input, select')) return;
  if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); step(); }
  else if (e.key === 'ArrowLeft') back();
  else if (e.key === 'r' || e.key === 'R') run();
  else if (e.key === 'e' || e.key === 'E') runToEnd();
});
// Custom instructions (web/custom.html): a link from the workshop carries the set and a program in the
// hash; otherwise the set saved in this browser (if any) is used, so programs that use it assemble here too.
// The lab starts with the instructions the hardware ships with (custom/instructions.json), so the example
// programs always mean what the RTL does. A link from the workshop brings its own set with its program; a
// set saved in the workshop can be switched on here with one click.
let customSet = null, customProgram = null;
const shared = location.hash.length > 1 ? decodeShare(location.hash.slice(1)) : null;
if (shared && shared.list.length && shared.program) { customSet = shared.list; customProgram = shared.program; }
const showCustomNote = list => {
  $('customnote').hidden = false;
  $('customnote').innerHTML = `Using your custom instructions: <code>${list.map(c => esc(c.name)).join('</code>, <code>')}</code> (<a href="custom.html">edit them in the workshop</a>, or <a href="index.html">go back to the shipped ones</a>).`;
};
if (customSet && registerCustom(customSet).ok) showCustomNote(customSet);
else {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('sixfold.custom.v1')); } catch { /* storage unavailable */ }
  const same = Array.isArray(saved) && JSON.stringify(saved.map(c => [c.name, c.format, c.funct3, c.funct7 ?? 0, c.expr])) === JSON.stringify(DEFAULT_CUSTOM.map(c => [c.name, c.format, c.funct3, c.funct7 ?? 0, c.expr]));
  if (Array.isArray(saved) && saved.length && !same) {
    $('customnote').hidden = false;
    $('customnote').innerHTML = 'You have your own custom instructions in the workshop. <button type="button" id="usecustom">Use them here</button>';
    $('usecustom').onclick = () => { if (registerCustom(saved).ok) { showCustomNote(saved); loadSource($('src').value); } else $('customnote').textContent = 'Your saved set has an error: fix it in the workshop first.'; };
  }
}
if (customProgram) {
  sel.add(new Option('your program (from the workshop)', '__custom'), 0);
  sel.value = '__custom';
  sel.onchange = () => loadSource(sel.value === '__custom' ? customProgram : PROGRAMS[sel.value]);
  loadSource(customProgram);
} else loadSource(PROGRAMS[sel.value]);
