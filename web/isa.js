// =============================================================================
// web/isa.js: the architecture lab. One program, three instruction sets: RISC-V, MIPS, x86-64.
// The models are model/isas/ (index.js gives the three one interface); the programs are programs/compare/.
// =============================================================================
import { ARCHS, measure } from '../model/isas/index.js';
import { COMPARE_PROGRAMS } from './programs.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const hex = (v, n = 4) => '0x' + (v >>> 0).toString(16).padStart(n, '0');
const ORDER = ['sum_to_100', 'fibonacci', 'array_sum_max', 'bubble_sort', 'factorial_recursive', 'gcd', 'hello'].filter(n => n in COMPARE_PROGRAMS);
const STAGE_COLOR = ['--FETCH1', '--FETCH2', '--DECODE', '--EXECUTE', '--MEMORY', '--WRITEBACK'];
const stageColor = (names, i) => STAGE_COLOR[names.length === 5 ? [0, 2, 3, 4, 5][i] : i];
const KEEP = 64;

// What makes each one different, in a few lines (docs/ISA_COMPARISON.md has the long version)
const INFO = {
  riscv: [['registers', '32 x 64-bit (x0 = 0), no flags'], ['instructions', 'all 32 bits, 6 formats, fields in fixed places'], ['memory', 'only loads and stores touch it'],
    ['branches', 'compare two registers and branch in one instruction'], ['calls', 'jal writes the return address to a register (ra)'], ['pipeline', 'Sixfold, 6 stages, branches predicted (gshare)']],
  mips: [['registers', '32 x 32-bit ($zero = 0) + HI, LO for multiply / divide'], ['instructions', 'all 32 bits, 3 formats (R, I, J)'], ['memory', 'only loads and stores touch it'],
    ['branches', 'beq / bne compare two registers; "<" needs slt first; the next instruction always runs (delay slot)'], ['calls', 'jal writes $ra, fixed to register 31'], ['pipeline', '5 stages, branches resolved in ID: no prediction needed']],
  x86: [['registers', '16 x 64-bit + FLAGS (zero, sign, carry, overflow)'], ['instructions', '1 to 15 bytes: prefix, REX, opcode, ModRM, SIB, displacement, immediate'], ['memory', 'most instructions can read or write it directly'],
    ['branches', 'cmp / test set FLAGS, then jcc reads them: two instructions'], ['calls', 'call pushes the return address on the stack in memory'], ['pipeline', '6 stages; DECODE splits instructions into micro-ops']],
};

let arch = 'riscv', progName = ORDER[0], source = '', img = null, core = null, events = [], timer = null, selAddr = null;
const params = new URLSearchParams(location.search);
let fusion = params.get('fusion') === '1'; // x86-64 macro-fusion (model/isas/x86_core.js canMacroFuse, Lab 24)
const coreOptions = a => (a === 'x86' ? { macroFusion: fusion } : undefined);
if (params.get('arch') in ARCHS) arch = params.get('arch');
if (params.get('prog') in COMPARE_PROGRAMS) progName = params.get('prog');

// ---------------------------------------------------------------- loading and stepping
function load(src) {
  try { img = ARCHS[arch].assemble(src); source = src; $('asmerr').textContent = ''; $('src').value = src; reset(); return true; }
  catch (e) { $('asmerr').textContent = e.message; return false; }
}
function reset() { stop(); core = ARCHS[arch].makeCore(img, coreOptions(arch)); events = []; selAddr = null; render(); }
function advance() { const ev = core.step(); if (ev) { events.push(ev); if (events.length > KEEP) events.shift(); } return ev; }
function step() { if (core.halted) return; advance(); render(); }
function seek(target) { stop(); core = ARCHS[arch].makeCore(img, coreOptions(arch)); events = []; while (core.cycle < target && !core.halted) advance(); render(); }
function back() { if (core.cycle) seek(core.cycle - 1); }
function run() {
  if (timer) { stop(); return; }
  if (core.halted) return;
  $('run').textContent = 'Pause';
  let last = performance.now(), owed = 0;
  const tick = now => { owed += Math.min(250, now - last) * 12 / 1000; last = now; for (; owed >= 1 && !core.halted; owed--) advance(); render(); if (core.halted) stop(); else timer = requestAnimationFrame(tick); };
  timer = requestAnimationFrame(tick);
}
function stop() { if (timer) cancelAnimationFrame(timer); timer = null; $('run').textContent = 'Run'; }
function toEnd() { stop(); let n = 0; while (!core.halted && n++ < 2e6) advance(); render(); }

// ---------------------------------------------------------------- rendering
function render() {
  const ev = events[events.length - 1] || null, names = core.stageNames;
  $('cycle').textContent = core.cycle;
  const st = $('status'); st.className = 'status';
  if (!ev) st.textContent = 'reset: the pipeline is empty, the first fetch is at 0x2000';
  else if (ev.halt) { st.textContent = `halted: ${ARCHS[arch].result} = ${core.result}`; st.classList.add('halt'); }
  else if (ev.flush) { st.textContent = 'flush: a wrong path is thrown away'; st.classList.add('flush'); }
  else if (ev.stall) { st.textContent = { loaduse: 'load-use stall', branch: 'branch-operand stall (the branch compares in ID)', hilo: 'waiting for HI / LO', muldiv: 'the multiply/divide unit is busy' }[ev.stall] || ev.stall; st.classList.add('stall'); }
  else st.textContent = '';
  $('stages').style.gridTemplateColumns = `repeat(${names.length}, minmax(0, 1fr))`;
  $('stages').innerHTML = names.map((s, i) => {
    const x = ev && ev.stages[s];
    const body = x && x.id !== -1 ? `<div class="chip" style="background:color-mix(in srgb, var(${stageColor(names, i)}) 65%, #000)"><div class="pc">${hex(x.pc)}</div>${esc(x.text)}</div>${x.note ? `<div class="tags"><span class="tag pred">${esc(x.note)}</span></div>` : ''}`
      : `<div class="empty">${x ? esc(x.text) : ev ? 'bubble' : 'empty'}</div>`;
    return `<div class="stage"><h3>${s}</h3><div class="bar" style="background:var(${stageColor(names, i)})"></div>${body}</div>`;
  }).join('');
  $('notes').innerHTML = ev ? ev.notes.map(n => `<li>${esc(n)}</li>`).join('') : '<li>Press <b>Step</b> to clock the pipeline.</li>';
  renderChart(); renderListing(ev); renderRegs(); renderStats(); renderInfo();
  $('output').textContent = core.output || '(nothing printed yet: a store to 0x1000_0000 prints a character)';
}

function renderChart() {
  const names = core.stageNames, N = 24, last = core.cycle, first = Math.max(1, last - N + 1);
  const rows = new Map(), byCycle = new Map(events.map(e => [e.cycle, e]));
  for (const ev of events.filter(e => e.cycle >= first)) names.forEach((s, i) => {
    const x = ev.stages[s]; if (!x || x.id === -1) return;
    if (!rows.has(x.id)) rows.set(x.id, { pc: x.pc, text: x.text, cells: {} });
    rows.get(x.id).cells[ev.cycle] = { i, short: s.slice(0, s === 'PREDECODE' ? 2 : s.length > 3 ? 1 : 2) };
  });
  const ids = [...rows.keys()].sort((a, b) => a - b).slice(-16), end = Math.max(last, first + N - 1);
  let h = '<tr><th><span class="sr-only">instruction</span></th>'; for (let c = first; c <= end; c++) h += `<th>${c}</th>`; h += '</tr>';
  for (const id of ids) {
    const r = rows.get(id);
    h += `<tr><td class="label">${hex(r.pc)} ${esc(r.text.slice(0, 26))}</td>`;
    for (let c = first; c <= end; c++) { const x = r.cells[c]; h += x ? `<td class="c${c === last ? ' now' : ''}" style="background:color-mix(in srgb, var(${stageColor(names, x.i)}) 65%, #000)">${x.short}</td>` : '<td></td>'; }
    h += '</tr>';
  }
  h += '<tr class="hz"><td class="label" style="color:var(--sub)">events</td>';
  for (let c = first; c <= end; c++) { const e = byCycle.get(c); h += !e ? '<td></td>' : e.flush ? '<td style="background:color-mix(in srgb, var(--redirect) 65%, #000)">flush</td>' : e.stall ? `<td style="background:color-mix(in srgb, var(--stall) 65%, #000)">${e.stall === 'muldiv' || e.stall === 'hilo' ? 'busy' : 'stall'}</td>` : '<td></td>'; }
  $('chart').innerHTML = h + '</tr>';
}

const PART_CLASS = { opcode: 'f-opcode', rd: 'f-rd', rs: 'f-rs1', rt: 'f-rs2', rs1: 'f-rs1', rs2: 'f-rs2', funct3: 'f-funct3', funct7: 'f-funct7', funct: 'f-funct7', shamt: 'f-imm', immediate: 'f-imm', target: 'f-imm',
  prefix: 'f-funct3', REX: 'f-funct3', modrm: 'f-rd', ModRM: 'f-rd', sib: 'f-rs1', SIB: 'f-rs1', disp: 'f-imm', imm: 'f-imm' };
const partClass = p => PART_CLASS[p.cls] || PART_CLASS[p.name] || PART_CLASS[p.name.split('[')[0]] || (/^imm/.test(p.name) ? 'f-imm' : /^disp|^rip/.test(p.name) ? 'f-imm' : 'f-funct7');
function renderListing(ev) {
  const rows = ARCHS[arch].listing(img), names = core.stageNames, at = {};
  if (ev) names.forEach((s, i) => { const x = ev.stages[s]; if (x && x.id !== -1) (at[x.pc] ??= []).push(i); });
  $('listing').innerHTML = '<tr><th>address</th><th><span class="sr-only">stage</span></th><th>bytes in memory</th><th>instruction</th></tr>' + rows.map(r => {
    const stg = at[r.addr] || [];
    const bytes = r.bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
    return `<tr data-addr="${r.addr}" class="${selAddr === r.addr ? 'sel' : ''}" style="${stg.length ? `border-left-color:var(${stageColor(names, stg[stg.length - 1])})` : ''}">
      <td class="addr">${hex(r.addr)}</td><td>${stg.map(i => `<span class="stg" style="background:color-mix(in srgb, var(${stageColor(names, i)}) 65%, #000)">${names[i].slice(0, 2)}</span>`).join(' ')}</td>
      <td class="bin">${bytes}</td><td class="src">${esc(r.text)}</td></tr>`;
  }).join('');
  const sel = rows.find(r => r.addr === selAddr);
  if (!sel) { $('bits').innerHTML = `<p class="hint">Click an instruction to see its encoding field by field.${arch === 'x86' ? ' On x86-64 you also see its micro-operations.' : ''}</p>`; return; }
  const order = arch === 'x86' ? 'byte by byte, in memory order' : 'bit 31 on the left (stored little-endian: the lowest byte first)';
  $('bits').innerHTML = `<b>${esc(sel.text)}</b>: ${sel.size} bytes, ${esc(sel.format)} (${order})
    <div class="fields">${sel.parts.map(p => `<div class="fld ${partClass(p)}">${esc(p.bits)}<small>${esc(p.name)}</small></div>`).join('')}</div>
    ${sel.uops ? `<p class="hint mt">Micro-operations: ${sel.uops.map((u, i) => `<code>${i + 1}. ${esc(u)}</code>`).join(' ')}</p>` : ''}
    <p class="hint">Source line: <code>${esc(sel.src)}</code></p>`;
}
function renderRegs() {
  $('regs').innerHTML = core.registers().map(r => {
    const v = typeof r.value === 'string' ? r.value : arch === 'mips' ? '0x' + (r.value >>> 0).toString(16).padStart(8, '0') : '0x' + BigInt.asUintN(64, BigInt(r.value)).toString(16).padStart(16, '0');
    const zero = r.value === 0 || r.value === 0n;
    return `<div><span class="n">${esc(r.name)}</span><span class="${zero ? 'z' : ''}">${zero ? '0' : v}</span></div>`;
  }).join('');
}
function renderStats() {
  const s = core.stats, eq = core.equation(), sum = eq.terms.reduce((a, t) => a + t[1], 0);
  const items = [['cycles', s.cycles], ['instructions finished', s.retired]];
  if (arch === 'x86') items.push(['micro-ops finished', s.uops]);
  items.push(['cycles per instruction', s.retired ? (s.cycles / s.retired).toFixed(3) : '-']);
  if (core.halted) items.push(['the cycle equation', `${eq.terms.map(t => `${t[1]} ${t[0].split(' ')[0]}`).join(' + ')} = ${sum} ${sum === eq.total ? '✓' : '✗'}`]);
  $('stats').innerHTML = items.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  $('eqnote').textContent = `cycles = ${eq.terms.map(t => t[0]).join(' + ')}. Every cycle, WRITEBACK finishes one ${arch === 'x86' ? 'micro-op' : 'instruction'} or a bubble, and each bubble has its cause.`;
}
function renderInfo() {
  const A = ARCHS[arch];
  $('archinfo').innerHTML = `<h2>${esc(A.full)}</h2><dl class="infolist">${INFO[arch].map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
}

// ---------------------------------------------------------------- the comparison table (all three, measured)
const cache = {};
function renderCompare() {
  const m = cache[progName + fusion] ??= Object.fromEntries(Object.keys(ARCHS).map(a => [a, measure(a, COMPARE_PROGRAMS[progName][a], 5e6, coreOptions(a))]));
  const rows = [['instructions in the program', 'staticInstructions'], ['bytes of code', 'codeBytes'], ['instructions executed', 'instructions'], ['micro-ops executed (x86)', 'uops'], ['cycles', 'cycles']];
  const archs = Object.keys(ARCHS);
  let h = `<tr><th><span class="sr-only">measure</span></th>${archs.map(a => `<th class="${a === arch ? 'cur' : ''}">${ARCHS[a].name}</th>`).join('')}</tr>`;
  for (const [label, key] of rows) {
    const vals = archs.map(a => m[a][key]), max = Math.max(...vals.filter(v => v !== undefined));
    h += `<tr><td>${label}</td>${archs.map((a, i) => vals[i] === undefined ? '<td>-</td>' : `<td class="${a === arch ? 'cur' : ''}"><span class="bar" style="width:${(100 * vals[i] / max).toFixed(0)}%"></span><span class="v">${vals[i].toLocaleString('en-US')}</span></td>`).join('')}</tr>`;
  }
  h += `<tr><td>result</td>${archs.map(a => `<td class="${a === arch ? 'cur' : ''}">${m[a].result} ${m[a].equationHolds ? '' : '(equation ✗)'}</td>`).join('')}</tr>`;
  $('compare').innerHTML = h;
  const first = COMPARE_PROGRAMS[progName][arch].split('\n').filter(l => l.startsWith('#') && !/RESULT|OUTPUT/.test(l)).slice(1).map(l => l.slice(1).trim()).join(' ');
  $('cmpnote').textContent = first;
}

// ---------------------------------------------------------------- wiring
$('archswitch').innerHTML = Object.values(ARCHS).map(A => `<button type="button" role="radio" data-arch="${A.id}">${A.name}</button>`).join('');
function setArch(a) {
  arch = a;
  document.querySelectorAll('#archswitch button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.arch === a)));
  $('fusewrap').hidden = a !== 'x86';
  history.replaceState(null, '', `?arch=${arch}&prog=${progName}${fusion ? '&fusion=1' : ''}`);
  load(COMPARE_PROGRAMS[progName][arch]); renderCompare();
}
$('archswitch').onclick = e => { const b = e.target.closest('button'); if (b) setArch(b.dataset.arch); };
for (const n of ORDER) $('prog').add(new Option(n.replace(/_/g, ' '), n));
$('prog').value = progName;
$('fusion').checked = fusion;
$('fusion').onchange = () => { fusion = $('fusion').checked; setArch(arch); };
$('prog').onchange = () => { progName = $('prog').value; setArch(arch); };
$('step').onclick = step; $('back').onclick = back; $('run').onclick = run; $('end').onclick = toEnd; $('reset').onclick = reset;
$('assemble').onclick = () => { if (load($('src').value)) switchTab('listing'); };
$('listing').onclick = e => { const tr = e.target.closest('tr[data-addr]'); if (tr) { selAddr = Number(tr.dataset.addr); render(); } };
function switchTab(t) { document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t))); $('tab-listing').hidden = t !== 'listing'; $('tab-edit').hidden = t !== 'edit'; }
document.querySelectorAll('.tabs button').forEach(b => { b.onclick = () => switchTab(b.dataset.tab); });
document.addEventListener('keydown', e => {
  if (e.target.matches('textarea, input, select')) return;
  if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); step(); }
  else if (e.key === 'ArrowLeft') back();
  else if (e.key === 'r' || e.key === 'R') run();
  else if (e.key === 'e' || e.key === 'E') toEnd();
});
setArch(arch);
