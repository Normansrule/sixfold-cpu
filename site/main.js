// =============================================================================
// site/main.js: the interactive sections of the GitHub Pages front page.
// Everything runs on the same modules as the rest of the repository:
// model/isa.js (encodings), model/asm.js (assembler), model/core.js (the
// cycle-exact twin of the SystemVerilog). No build step, no framework.
// =============================================================================
import { assemble } from '../model/asm.js';
import { decode, disasm, FORMATS } from '../model/isa.js';
import { Core, control, WB_NAMES, CONFIGS } from '../model/core.js';
import { PROGRAMS } from '../web/programs.js';
import { runArena, branchTrace, PREDICTORS } from '../model/predictors.js';

const $ = id => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const NAMES = Object.keys(PROGRAMS);
const nice = n => n.replace(/^\d+_/, '').replace(/_/g, ' ');
const describe = n => (PROGRAMS[n].split('\n')[1] || '').split(': ').slice(1).join(': ').trim();

// ---------------------------------------------------------------- repository links
const REPO = (() => {
  if (location.hostname.endsWith('github.io')) {
    const owner = location.hostname.split('.')[0], repo = location.pathname.split('/').filter(Boolean)[0];
    if (repo) return `https://github.com/${owner}/${repo}`;
  }
  return 'https://github.com/Normansrule/sixfold-cpu';
})();
document.querySelectorAll('[data-repo-link]').forEach(a => { a.href = REPO; });
const blob = p => `${REPO}/blob/main/${p}`;
document.querySelectorAll('[data-repo-doc]').forEach(a => { a.href = blob(a.dataset.repoDoc); });

// ---------------------------------------------------------------- hero (3D)
(async () => {
  const canvas = $('stage3d');
  const ui = { play: $('h-play'), step: $('h-step'), prog: $('h-prog'), bp: $('h-bp'), speed: $('h-speed'),
    cycle: $('h-cycle'), ret: $('h-ret'), cpi: $('h-cpi'), event: $('h-event') };
  let hero = null;
  try { const m = await import('./hero3d.js'); hero = m.createHero({ canvas, programs: PROGRAMS, ui, reducedMotion }); }
  catch (e) { console.warn('3D view unavailable:', e); }
  if (!hero) {
    const img = document.createElement('img');
    img.src = 'docs/img/pipeline/13_call_return_zoom.svg'; img.alt = 'Pipeline chart of a function call';
    img.style.cssText = 'position:absolute;right:4vw;top:28vh;width:min(62vw,900px);border-radius:10px;opacity:.9';
    canvas.replaceWith(img);
    $('h-event').textContent = 'Your browser has WebGL turned off, so here is a pipeline chart instead. The lab below still runs everything.';
    document.querySelector('.hud-ctl').hidden = true;
  }
})();

// ---------------------------------------------------------------- bit lab
const FIELD_VAR = { opcode: '--F1', rd: '--M', rs1: '--E', rs2: '--D', funct3: '--F2', funct7: '--ink3', funct6: '--ink3', funct12: '--ink3', csr: '--ink3' };
const fieldVar = name => FIELD_VAR[name.split('[')[0]] || '--stall';
const PRESETS = ['add a0, a1, a2', 'addi sp, sp, -16', 'ld a0, 8(sp)', 'sd ra, 0(sp)', 'beq a0, a1, 0x2010', 'jal ra, 0x2800', 'lui a0, 0x12345', 'mul a0, a1, a2', 'slliw a0, a1, 5', 'csrr t0, cycle'];
let word = 0;
function renderBits(flipped = -1) {
  const d = decode(word);
  const bits = word.toString(2).padStart(32, '0');
  const fmt = d.def ? FORMATS[d.fmt] : [['not an instruction', 31, 0]];
  const varOf = new Array(32);
  for (const [n, hi, lo] of fmt) for (let i = lo; i <= hi; i++) varOf[i] = d.def ? fieldVar(n) : '--ink3';
  const row = $('bit-row');
  if (!row.children.length) {
    for (let i = 31; i >= 0; i--) {
      const b = document.createElement('button');
      b.dataset.i = i; b.type = 'button';
      b.onclick = () => { word = (word ^ (1 << i)) >>> 0; syncAsm(); renderBits(i); };
      row.append(b);
    }
  }
  [...row.children].forEach(b => {
    const i = Number(b.dataset.i);
    b.textContent = bits[31 - i]; b.dataset.v = bits[31 - i];
    b.style.setProperty('--fc', `var(${varOf[i]})`);
    b.setAttribute('aria-label', `bit ${i} is ${bits[31 - i]}`);
    b.classList.toggle('edge', i === 31 || i === 0);
    if (i === flipped && !reducedMotion) { b.classList.remove('flip'); void b.offsetWidth; b.classList.add('flip'); }
  });
  $('bit-fields').innerHTML = fmt.map(([n, hi, lo]) => `<span style="grid-column:${32 - hi} / ${33 - lo};--fc:var(${d.def ? fieldVar(n) : '--ink3'})">${esc(n)}</span>`).join('');
  $('bit-hex').textContent = '0x' + word.toString(16).padStart(8, '0');
  $('bit-desc').textContent = d.def ? `${d.def.desc}, ${d.fmt}-type, ${d.def.ext}` : 'The decoder does not recognise this pattern: the ControlUnit turns it into a no-op.';
  $('bit-sem').textContent = d.def ? d.def.sem : '';
  const c = control(word);
  const on = [['REGISTER_WRITE_ENABLE', c.regWrite], ['MEMORY_READ_ENABLE', c.memRead], ['MEMORY_WRITE_ENABLE', c.memWrite],
    ['ALU_INPUT_A_IS_PC', c.aIsPC], ['ALU_INPUT_B_IS_IMMEDIATE', c.bIsImm], ['ALU_IS_WORD_OPERATION', c.isWord],
    ['IS_A_BRANCH_INSTRUCTION', c.isBranch], ['IS_A_JAL_INSTRUCTION', c.isJal], ['IS_A_JALR_INSTRUCTION', c.isJalr],
    ['IS_A_MULTIPLY_DIVIDE_INSTRUCTION', c.isMulDiv], ['CSR_WRITE_ENABLE', c.csrWrite]];
  const vals = [['ALU_OPERATION', 'ALU_' + c.aluOp], ['IMMEDIATE_TYPE_SELECT', 'IMMEDIATE_' + c.immType], ['WRITEBACK_SELECT', 'WRITEBACK_' + WB_NAMES[c.wbSel]]];
  $('bit-leds').innerHTML = on.map(([k, v]) => `<div class="${v ? 'on' : ''}"><i></i>${k}</div>`).join('') +
    vals.map(([k, v]) => `<div class="val on"><i></i>${k}<em>${v.replace(/^[A-Z]+_/, '')}</em></div>`).join('');
}
function syncAsm() { const d = decode(word); $('bit-asm').value = d.def ? disasm(d, 0x2000) : `.word 0x${word.toString(16).padStart(8, '0')}`; }
function fromAsm() {
  try { const img = assemble($('bit-asm').value.split('\n')[0]); const l = img.listing.find(x => x.word !== undefined); if (l) { word = l.word; $('bit-asm').removeAttribute('aria-invalid'); renderBits(); } }
  catch { $('bit-asm').setAttribute('aria-invalid', 'true'); }
}
$('bit-asm').addEventListener('input', fromAsm);
$('bit-presets').innerHTML = PRESETS.map(p => `<button type="button">${esc(p)}</button>`).join('');
$('bit-presets').onclick = e => { const b = e.target.closest('button'); if (b) { $('bit-asm').value = b.textContent; fromAsm(); } };
fromAsm();

// ---------------------------------------------------------------- predictor race
const CAUSE = { fill: '--fill', loaduse: '--stall', flush: '--flush', redirect: '--F2', muldiv: '--D', imiss: '--F1', dmiss: '--M', interrupt: '--W' };
// Clock rates of the two builds (logic-only sky130 estimates, docs/PERFORMANCE.md)
const CLOCK_BASELINE_MHZ = 7.5, CLOCK_PERFORMANCE_MHZ = 244;
const CLOCK_RATIO = Math.round(CLOCK_PERFORMANCE_MHZ / CLOCK_BASELINE_MHZ);
const cssv = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
for (const n of NAMES) $('r-prog').add(new Option(nice(n), n));
$('r-prog').value = '11_gshare_patterns';
$('r-hist').oninput = () => { $('r-hist-o').textContent = $('r-hist').value; };
$('r-mode').onchange = () => {
  const cmp = $('r-mode').value === 'build';
  $('lane-off').querySelector('h3').textContent = cmp ? 'Baseline design' : 'Always not taken';
  $('lane-gs').querySelector('h3').textContent = cmp ? 'Performance edition' : 'gshare';
};
let race = null;
function laneSetup(id, opts, total) {
  const el = $(id), cv = el.querySelector('canvas');
  const w = cv.clientWidth, h = cv.clientHeight, dpr = Math.min(2, devicePixelRatio);
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  el.classList.remove('won');
  el.querySelector('[data-k=cyc]').textContent = '0'; el.querySelector('[data-k=cpi]').textContent = '';
  return { el, g, w, h, core: new Core(assemble(PROGRAMS[race.name]), opts), px: w / total, done: false, last: null };
}
function raceStart() {
  const name = $('r-prog').value, hist = Number($('r-hist').value);
  const img = assemble(PROGRAMS[name]);
  const probes = [{ ...CONFIGS.performance, bp: false }, { ...CONFIGS.baseline, bp: true }, { ...CONFIGS.performance, bp: true, historyBits: hist }].map(o => { const c = new Core(img, o); c.run(5e6, false); return c.stats; });
  const total = Math.max(...probes.map(p => p.cycles)) * 1.02, N = probes[0].retired;
  race = { name, N, total };
  const cmp = $('r-mode').value === 'build';
  race.lanes = cmp
    ? [laneSetup('lane-off', { ...CONFIGS.baseline, bp: true }, total), laneSetup('lane-gs', { ...CONFIGS.performance, bp: true, historyBits: hist }, total)]
    : [laneSetup('lane-off', { ...CONFIGS.performance, bp: false }, total), laneSetup('lane-gs', { ...CONFIGS.performance, bp: true, historyBits: hist }, total)];
  race.cmp = cmp;
  race.perFrame = Math.max(1, Math.ceil(total / (60 * (reducedMotion ? 1.5 : 7))));
  $('r-verdict').textContent = '';
  $('r-go').textContent = 'Restart';
  cancelAnimationFrame(race.raf); race.raf = requestAnimationFrame(raceTick);
}
function raceTick() {
  let running = false;
  for (const L of race.lanes) {
    for (let k = 0; k < race.perFrame && !L.core.halted; k++) {
      const w = L.core.w, x = L.core.cycle * L.px;
      L.g.fillStyle = cssv(w.valid ? '--M' : CAUSE[w.cause] || '--fill');
      L.g.globalAlpha = w.valid ? 0.9 : 1;
      L.g.fillRect(x, w.valid ? 12 : 4, Math.max(1, L.px), w.valid ? L.h - 24 : L.h - 8);
      L.last = L.core.step();
    }
    const s = L.core.stats;
    L.el.querySelector('[data-k=cyc]').textContent = s.cycles.toLocaleString();
    L.el.querySelector('[data-k=cpi]').textContent = s.retired ? `CPI ${(s.cycles / s.retired).toFixed(2)}` : '';
    L.el.querySelector('.bar i').style.width = `${100 * s.retired / race.N}%`;
    if (!L.core.halted) running = true;
    else if (!L.done) { L.done = true; if (race.lanes.every(x => x.core.halted || x === L)) {} }
  }
  drawGshare(race.lanes[1]);
  if (running) race.raf = requestAnimationFrame(raceTick);
  else raceEnd();
}
function raceEnd() {
  const [a, b] = race.lanes.map(L => L.core.stats.cycles);
  const winner = b <= a ? race.lanes[1] : race.lanes[0];
  winner.el.classList.add('won');
  const hist = $('r-hist').value;
  const who = race.cmp ? 'The performance edition' : `gshare with ${hist} history bits`;
  $('r-verdict').innerHTML = race.cmp && b >= a
    ? `Same clock, and here the performance edition needs <b>${(b - a).toLocaleString()}</b> more cycles: this program multiplies or divides, which now takes several short cycles. Its clock is about ${CLOCK_RATIO} times faster (${CLOCK_BASELINE_MHZ} MHz to ${CLOCK_PERFORMANCE_MHZ} MHz), so it still finishes far sooner.`
    : b < a
    ? `${who} finished in <b>${b.toLocaleString()}</b> cycles, ${(a - b).toLocaleString()} fewer: <b>${(100 * (a - b) / a).toFixed(1)}%</b> fewer cycles${race.cmp ? `, on a clock about ${CLOCK_RATIO} times faster` : ''}.`
    : b === a ? 'A tie: this program has too few branches for guessing to matter.'
    : `Here guessing <b>cost</b> ${(b - a).toLocaleString()} cycles: this program's branches are hard to predict with ${hist} history bits, and every wrong guess costs 3 cycles. Try another history length.`;
}
function drawGshare(L) {
  const bp = L.core.bp, ev = L.last;
  $('gs-ghr').innerHTML = [...bp.ghr.toString(2).padStart(bp.historyBits, '0')].map(b => `<span class="${b === '1' ? 't' : ''}">${b}</span>`).join('');
  const rd = ev?.predict?.idx, up = ev?.bpUpdate?.idx;
  const pht = $('gs-pht');
  pht.style.gridTemplateColumns = `repeat(${Math.min(32, bp.pht.length)}, minmax(0, 1fr))`;
  if (pht.children.length !== bp.pht.length) pht.innerHTML = '<i></i>'.repeat(bp.pht.length);
  [...pht.children].forEach((c, i) => { c.className = `s${bp.pht[i]}${i === rd ? ' rd' : ''}${i === up ? ' up' : ''}`; });
}
$('r-go').onclick = raceStart;
drawGshare({ core: new Core(assemble(PROGRAMS['11_gshare_patterns']), { bp: true }), last: null });

// ---------------------------------------------------------------- chip scope
(() => {
  const scope = $('scope'), inner = $('scope-inner'), routing = $('scope-routing'), div = $('scope-div');
  const IW = 1500, IH = 1500; // image area above the legend
  let s = 1, tx = 0, ty = 0, split = 0.5;
  const fit = () => { const r = scope.getBoundingClientRect(); s = Math.min(r.width / IW, r.height / IH) * 1.02; tx = (r.width - IW * s) / 2; ty = (r.height - IH * s) / 2; apply(); };
  function apply() {
    inner.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    const r = scope.getBoundingClientRect();
    const cut = Math.max(0, (split * r.width - tx) / s);
    routing.style.clipPath = `inset(0 0 0 ${cut}px)`;
    div.style.left = `${split * 100}%`; div.setAttribute('aria-valuenow', Math.round(split * 100));
  }
  const zoomAt = (f, cx, cy) => { const ns = Math.min(6, Math.max(0.2, s * f)); tx = cx - (cx - tx) * ns / s; ty = cy - (cy - ty) * ns / s; s = ns; apply(); };
  let drag = null;
  scope.addEventListener('pointerdown', e => {
    if (e.target.closest('.scope-ctl')) return;
    drag = { mode: e.target.closest('.divider') ? 'split' : 'pan', x: e.clientX, y: e.clientY, tx, ty };
    scope.setPointerCapture(e.pointerId);
  });
  scope.addEventListener('pointermove', e => {
    if (!drag) return;
    const r = scope.getBoundingClientRect();
    if (drag.mode === 'split') split = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    else { tx = drag.tx + e.clientX - drag.x; ty = drag.ty + e.clientY - drag.y; }
    apply();
  });
  scope.addEventListener('pointerup', () => { drag = null; });
  scope.addEventListener('wheel', e => { e.preventDefault(); const r = scope.getBoundingClientRect(); zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  const center = f => { const r = scope.getBoundingClientRect(); zoomAt(f, r.width / 2, r.height / 2); };
  $('z-in').onclick = () => center(1.4); $('z-out').onclick = () => center(1 / 1.4); $('z-reset').onclick = fit;
  scope.addEventListener('keydown', e => {
    const k = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }[e.key];
    if (k && e.target === scope) { tx += k[0]; ty += k[1]; apply(); e.preventDefault(); }
    if (e.key === '+' || e.key === '=') center(1.25); if (e.key === '-') center(0.8);
  });
  div.addEventListener('keydown', e => { if (e.key === 'ArrowLeft') split = Math.max(0, split - 0.05); if (e.key === 'ArrowRight') split = Math.min(1, split + 0.05); apply(); e.stopPropagation(); });
  new ResizeObserver(fit).observe(scope);
})();

// ---------------------------------------------------------------- dashboard
(() => {
  const dash = $('dash');
  const parts = [['retired', '--F1', 'useful work'], ['fill', '--fill', 'pipeline fill'], ['loaduse', '--stall', 'load stalls'], ['flush', '--flush', 'flushes'], ['redirect', '--F2', 'redirects'], ['muldiv', '--D', 'multiply/divide busy'], ['imiss', '--E', 'instruction cache misses'], ['dmiss', '--W', 'data cache misses'], ['interrupt', '--ink2', 'interrupts']];
  const tiles = [];
  let i = 0;
  const bar = (s, max) => `<div class="stack" style="width:${(100 * s.cycles / max).toFixed(1)}%">${parts.map(([k, v]) => { const n = k === 'retired' ? s.retired : s.bubbles[k]; return n ? `<i style="width:${(100 * n / s.cycles).toFixed(2)}%;background:var(${v})" title="${n} ${k}"></i>` : ''; }).join('')}</div>`;
  function next() {
    if (i >= NAMES.length) {
      dash.innerHTML = `<div class="dash-key">${parts.map(([, v, l]) => `<span><i style="background:var(${v})"></i>${l}</span>`).join('')}</div>` + tiles.join('');
      dash.removeAttribute('aria-busy'); return;
    }
    const n = NAMES[i++], img = assemble(PROGRAMS[n]);
    const r = ['performance', 'baseline'].map(k => { const c = new Core(img, { ...CONFIGS[k], bp: true }); c.run(5e6, false); return c.stats; });
    const max = Math.max(r[0].cycles, r[1].cycles);
    tiles.push(`<a class="tile" href="web/index.html?prog=${n}"><h3>${esc(nice(n))}</h3><p>${esc(describe(n))}</p>
      <div class="trow"><span>faster</span>${bar(r[0], max)}<b>CPI ${(r[0].cycles / r[0].retired).toFixed(2)}</b></div>
      <div class="trow"><span>baseline</span>${bar(r[1], max)}<b>CPI ${(r[1].cycles / r[1].retired).toFixed(2)}</b></div></a>`);
    setTimeout(next, 0);
  }
  new IntersectionObserver((es, o) => { if (es[0].isIntersecting) { o.disconnect(); next(); } }, { rootMargin: '400px' }).observe(dash);
})();

// ---------------------------------------------------------------- chapters
const CHAPTERS = [
  ['01_what_is_a_cpu', 'What a CPU does', 'Fetch, decode, execute, and why overlapping them works.'],
  ['02_instructions_in_binary', 'Instructions are just 32 bits', 'Read any RISC-V word by hand.'],
  ['03_the_six_stages', 'The six stages', 'How to read the block diagram and a pipeline chart.'],
  ['04_data_hazards', 'Data hazards', 'Forwarding, load stalls, and a stall that is a false alarm.'],
  ['05_branch_prediction', 'Branch prediction', '2-bit counters, gshare, and repairing history after a wrong guess.'],
  ['06_performance', 'Measuring performance', 'CPI and an equation that accounts for every cycle.'],
  ['07_silicon', 'From RTL to silicon', 'Standard cells, a real layout, timing and area.'],
  ['08_using_the_cpu', 'Write your own program', 'Assemble, run, test and debug on the model and the RTL.'],
  ['09_devices_and_interrupts', 'Devices, interrupts, booting', 'Memory-mapped devices, a timer interrupt taken precisely, and how the FPGA computer boots.'],
];
$('chapters').innerHTML = CHAPTERS.map(([f, t, d]) => `<li><a href="${blob(`docs/learn/${f}.md`)}"><strong>${t}</strong><span>${d}</span></a></li>`).join('');

// ---------------------------------------------------------------- commands
const CMDS = {
  'Quick start': [
    ['sudo apt-get install -y nodejs iverilog verilator yosys graphviz gtkwave python3-serial make git curl unzip', 'every tool the repository uses'],
    [`git clone ${REPO}.git && cd ${REPO.split('/').pop()}`, 'get the code'],
    ['make test', 'all programs on the RTL and the model, compared cycle by cycle'],
    ['make serve', 'this page and the lab at http://localhost:8000/'],
  ],
  'Explore a program': [
    ['make run PROG=05_fibonacci', 'registers, cycles, CPI, predictor accuracy'],
    ['make pipe PROG=03_load_use', 'pipeline chart in the terminal'],
    ['make cycle PROG=03_load_use C=5', 'everything that happens in one clock cycle'],
    ['make bp PROG=06_bubble_sort', 'predictor off vs gshare with 1 to 12 history bits'],
    ['make run PROG=09_primes_sieve CONFIG=baseline', 'the same program on the baseline design'],
    ['node tools/rv.mjs encode "ld a0, 16(sp)"', 'show an instruction in binary'],
  ],
  'RTL and waveforms': [
    ['make rtl PROG=09_primes_sieve', 'run on the SystemVerilog with Icarus Verilog'],
    ['make vsim PROG=09_primes_sieve', 'the same, compiled with Verilator (faster)'],
    ['make wave PROG=03_load_use', 'open GTKWave with one signal group per stage'],
    ['make lint && make math', 'Verilator lint, then check the cycle equation'],
    ['make timing', 'logic-only sky130 clock estimate of both builds'],
  ],
  'Silicon': [
    ['make synth', 'map every module onto real SkyWater sky130 cells (sv2v + Yosys)'],
    ['make schematics', 'gate-level schematics of the predictor and branch control'],
    ['python3 tools/render_def.py docs/silicon/prototype_layout.def.gz docs/img/silicon', 'redraw the chip pictures from the layout file'],
  ],
  'FPGA board': [
    ['make fpga-sim', 'the whole FPGA computer in simulation: firmware, upload over the UART, run, report'],
    ['make fpga-virtual PROG=calculator', 'a virtual board on a pseudo serial port: try fpga_load.py and a terminal without hardware'],
    ['make fpga-basys3 PROG=calculator', 'bitstream for the Digilent Basys 3 (Vivado); the centre button runs the calculator'],
    ['make fpga-ulx3s PROG=20_leds_and_buttons', 'bitstream for the ULX3S (yosys + nextpnr-ecp5 + ecppack)'],
    ['openFPGALoader -b ulx3s build/ulx3s/sixfold.bit', 'program the board over USB'],
    ['python3 tools/fpga_load.py programs/22_multitasking.s --port /dev/ttyUSB0', 'send a program to the firmware and show what it prints'],
    ['make fpga-arty PROG=05_fibonacci', 'bitstream for the Arty A7-100T (Vivado)'],
  ],
  'Publish on GitHub Pages': [
    ['git remote add origin git@github.com:<you>/sixfold-cpu.git', 'run inside the project folder'],
    ['git push -u origin main', 'upload'],
    ['# Settings -> Pages -> Deploy from a branch -> main, / (root)', 'this page appears at https://<you>.github.io/sixfold-cpu/'],
  ],
};
const tabs = $('cmd-tabs');
tabs.innerHTML = Object.keys(CMDS).map((k, i) => `<button role="tab" aria-selected="${i === 0}" data-k="${esc(k)}">${esc(k)}</button>`).join('');
function showCmds(k) {
  tabs.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.k === k)));
  $('cmd-body').innerHTML = CMDS[k].map(([c, n]) => `<div class="row"><pre>${esc(c)}\n<span class="c"># ${esc(n)}</span></pre><button type="button" data-copy="${esc(c)}">Copy</button></div>`).join('');
}
tabs.onclick = e => { const b = e.target.closest('button'); if (b) showCmds(b.dataset.k); };
$('cmd-body').onclick = async e => {
  const b = e.target.closest('button[data-copy]'); if (!b) return;
  try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; }
  catch { b.textContent = 'Select and copy'; }
  setTimeout(() => { b.textContent = 'Copy'; }, 1600);
};
showCmds('Quick start');

// ---------------------------------------------------------------- inside the caches
(() => {
  for (const n of NAMES) $('c-prog').add(new Option(nice(n), n));
  $('c-prog').value = '09_primes_sieve';
  const mkGrid = el => { el.innerHTML = '<i></i>'.repeat(128); return [...el.children]; };
  const ig = mkGrid($('c-igrid')), dg = mkGrid($('c-dgrid'));
  $('c-dgrid').style.setProperty('--cv', 'var(--M)');
  let core = null, raf = 0, playing = false, hits = { i: 0, d: 0, dAcc: 0 };
  const bits = a => { const b = (a >>> 0).toString(2).padStart(32, '0');
    return `<span class="t">${b.slice(0, 21)}</span> <span class="x">${b.slice(21, 27)}</span> <span class="o">${b.slice(27)}</span>`; };
  const describe = (a, label) => `${label} <b>0x${(a >>> 0).toString(16).padStart(8, '0')}</b> = ${bits(a)} &nbsp;set ${((a >>> 5) & 63)}`;
  function reset() {
    cancelAnimationFrame(raf); playing = false; $('c-go').textContent = 'Play';
    core = new Core(assemble(PROGRAMS[$('c-prog').value]), { ...CONFIGS.performance, bp: true });
    hits = { i: 0, d: 0, dAcc: 0 }; draw(null);
  }
  function draw(ev) {
    const paint = (cells, c, hitIdx) => { const fill = c.busy ? core.victimSlot(c, c.line) : -1; cells.forEach((el, i) => {
      el.className = (c.valid[i] ? 'v' : '') + (i === fill ? (c.demand === false ? ' pf' : ' fill') : '') + (i === hitIdx ? ' hit' : '');
    }); };
    const iIdx = ev && ev.icacheHit ? core.cacheSlot(core.icache, ev.stages.FETCH1.pc) : -1;
    const dIdx = ev && ev.dcacheAccess && ev.dcacheAccess.hit ? core.cacheSlot(core.dcache, ev.dcacheAccess.addr) : -1;
    paint(ig, core.icache, iIdx); paint(dg, core.dcache, dIdx);
    if (ev) {
      $('c-iaddr').innerHTML = describe(ev.stages.FETCH1.pc, 'FETCH1 PC');
      if (ev.dcacheAccess) $('c-daddr').innerHTML = describe(ev.dcacheAccess.addr, 'load address');
    } else { $('c-iaddr').innerHTML = 'Press Play: FETCH1 looks up its PC every cycle.'; $('c-daddr').innerHTML = 'Loads look up their address in EXECUTE.'; }
    const s = core.stats;
    $('c-istats').innerHTML = `<dt>cycles</dt><dd>${s.cycles.toLocaleString()}</dd><dt>misses</dt><dd>${s.icacheMisses}</dd><dt>prefetches</dt><dd>${s.prefetches || 0}</dd><dt>miss bubbles</dt><dd>${s.bubbles.imiss}</dd>`;
    $('c-dstats').innerHTML = `<dt>loads</dt><dd>${hits.dAcc.toLocaleString()}</dd><dt>misses</dt><dd>${s.dcacheMisses}</dd><dt>hit rate</dt><dd>${hits.dAcc ? (100 * (1 - s.dcacheMisses / hits.dAcc)).toFixed(1) + '%' : '-'}</dd><dt>miss bubbles</dt><dd>${s.bubbles.dmiss}</dd>`;
  }
  function tick() {
    let ev = null;
    const per = Math.max(1, Math.round((reducedMotion ? 40 : 6)));
    for (let k = 0; k < per && !core.halted; k++) { ev = core.step(); if (ev.dcacheAccess && !ev.dmiss) hits.dAcc++; }
    if (ev) draw(ev);
    if (!core.halted && playing) raf = requestAnimationFrame(tick); else { playing = false; $('c-go').textContent = core.halted ? 'Done' : 'Play'; }
  }
  $('c-go').onclick = () => { if (core.halted) reset(); playing = !playing; $('c-go').textContent = playing ? 'Pause' : 'Play'; if (playing) raf = requestAnimationFrame(tick); };
  $('c-reset').onclick = reset; $('c-prog').onchange = reset;
  reset();
})();

// ---------------------------------------------------------------- predictor arena (animated bar race)
(() => {
  const COL = { bht: '--ink3', gshare: '--F1', tournament: '--D', perceptron: '--E', tage: '--M' };
  const RTL = new Set(['gshare', 'tournament']);
  for (const n of NAMES) $('a-prog').add(new Option(nice(n), n));
  $('a-prog').value = NAMES.includes('17_predictor_challenge') ? '17_predictor_challenge' : NAMES[0];
  const bars = $('arena-bars');
  bars.innerHTML = Object.entries(PREDICTORS).map(([k, C]) => `<div class="arow${RTL.has(k) ? ' rtl' : ''}" data-k="${k}" style="--c:var(${COL[k]})"><span class="name">${esc(C.label)}</span><div class="track"><div class="fill"></div></div><span class="val">-</span></div>`).join('');
  let raf = 0;
  function race() {
    cancelAnimationFrame(raf);
    const trace = branchTrace(new Core(assemble(PROGRAMS[$('a-prog').value]), { ...CONFIGS.performance, bp: true }));
    const preds = Object.entries(PREDICTORS).map(([k, C]) => ({ k, p: new C(), right: 0, last: null }));
    let i = 0; const per = Math.max(1, Math.ceil(trace.length / (reducedMotion ? 3 : 240)));
    const rows = Object.fromEntries([...bars.children].map(el => [el.dataset.k, el]));
    const frame = () => {
      for (let n = 0; n < per && i < trace.length; n++, i++) {
        const [pc, taken] = trace[i];
        for (const r of preds) { r.last = r.p.predict(pc); if (r.last === taken) r.right++; r.p.update(pc, taken); }
      }
      const best = Math.max(...preds.map(r => r.right));
      for (const r of preds) {
        const acc = i ? r.right / i : 0, row = rows[r.k];
        row.querySelector('.fill').style.width = `${(100 * Math.max(0, (acc - 0.4) / 0.6)).toFixed(1)}%`;
        row.querySelector('.val').textContent = `${(100 * acc).toFixed(1)}%`;
        row.classList.toggle('lead', i === trace.length && r.right === best);
      }
      if (i) { const [pc, taken] = trace[i - 1];
        $('a-ticker').innerHTML = `branch ${i.toLocaleString()} / ${trace.length.toLocaleString()} at 0x${pc.toString(16)}: actually <b>${taken ? 'taken' : 'not taken'}</b> &nbsp; ` + preds.map(r => `<i class="${r.last === taken ? 'ok' : 'no'}">${r.k} ${r.last === taken ? '✓' : '✗'}</i>`).join(' '); }
      if (i < trace.length) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  }
  $('a-go').onclick = race;
  new IntersectionObserver((es, o) => { if (es[0].isIntersecting) { o.disconnect(); race(); } }, { threshold: 0.3 }).observe(bars);
})();

// ---------------------------------------------------------------- motion: scroll reveal and count-up numbers
(() => {
  if (reducedMotion) return;
  const targets = document.querySelectorAll('.band .copy, .band .bitlab, .band .lanes, .band .race-foot, .band .scope, .band .facts, .band .cp, .band .cells, .band .dash, .band .chapters, .band .term, .band .cache-grid-wrap, .band .arena');
  targets.forEach(el => el.classList.add('reveal'));
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.12 });
  targets.forEach(el => io.observe(el));
  document.querySelectorAll('.facts strong').forEach(el => {
    const m = el.textContent.match(/^([\d.,]+)(.*)$/); if (!m) return;
    const end = parseFloat(m[1].replace(/,/g, '')), dec = (m[1].split('.')[1] || '').length, suffix = m[2], comma = m[1].includes(',');
    const fmt = v => (comma ? Math.round(v).toLocaleString('en-US') : v.toFixed(dec)) + suffix;
    const cio = new IntersectionObserver(es => { if (!es[0].isIntersecting) return; cio.disconnect();
      const t0 = performance.now(), D = 1100;
      const step = t => { const k = Math.min(1, (t - t0) / D), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(end * e); if (k < 1) requestAnimationFrame(step); else el.textContent = m[0]; };
      requestAnimationFrame(step); }, { threshold: 0.5 });
    cio.observe(el);
  });
})();
