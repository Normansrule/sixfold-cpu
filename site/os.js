// =============================================================================
// site/os.js: "Three programs, one CPU", the tiny operating system of programs/22_multitasking.s
//
// The kernel runs on the cycle-exact model. The chart is the program's whole run, measured first
// (web/regions.js) and then drawn as a second core replays it, so the task control blocks shown under
// it are read from that core's memory as the kernel writes them.
// =============================================================================
import { assemble } from '../model/asm.js';
import { Core, CONFIGS } from '../model/core.js';
import { PROGRAMS } from '../web/programs.js';
import { parseRegions, RegionTracker, profile, drawTimeline } from '../web/regions.js';

const $ = id => document.getElementById(id);
const SOURCE = PROGRAMS['22_multitasking'];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const cssv = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const hex = v => '0x' + (Number(v) >>> 0).toString(16);
const TASKS = [['task0', 'counts the primes below 500', 's0 = primes so far'], ['task1', 'adds the squares 1² … 400²', 's0 = sum so far'], ['task2', 'prints four lines, slowly', 's1 = lines printed']];
const OFFSET = { pc: 248, done: 256, sp: 8, s0: 56, s1: 64 }; // the control block layout in the program
const COLORS = () => ({ task0: cssv('--F1'), task1: cssv('--D'), task2: cssv('--M'), kernel: cssv('--W'), asleep: cssv('--ink3'), track: cssv('--ink3'), cursor: cssv('--ink'), text: cssv('--ink2') });

function setup() {
  const canvas = $('os-gantt');
  if (!canvas) return;
  let prof = null, core = null, tracker = null, img = null, raf = 0, playing = false, token = 0, sym = {};

  const word = (addr) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(core.mem[addr + i]); return v; };
  const source = () => SOURCE.replace(/(\.equ QUANTUM,\s*)\d+/, `$1${$('os-q').value}`);

  async function prepare() {
    stop();
    const my = ++token;
    $('os-note').textContent = 'measuring the run…';
    const src = source();
    const p = await profile(src, { ...CONFIGS.performance });
    if (my !== token) return false;
    prof = p; img = assemble(src); sym = img.symbols;
    core = new Core(img, { ...CONFIGS.performance }); tracker = new RegionTracker(parseRegions(src, img.symbols));
    const k = prof.regions.names.indexOf('kernel');
    $('os-note').textContent = `${prof.cycles.toLocaleString('en-US')} cycles in all, ${prof.traps.length} context switches, kernel ${(100 * prof.perRegion[k] / prof.cycles).toFixed(1)}% of the time`;
    draw();
    return true;
  }

  function draw() {
    if (!prof) return;
    const colors = COLORS();
    drawTimeline(canvas, prof, colors, { rowHeight: 18, gap: 5, labelWidth: 64, upTo: core.halted ? Infinity : core.cycle });
    const names = prof.regions.names, cur = tracker.current >= 0 ? names[tracker.current] : '';
    $('os-legend').innerHTML = names.map((n, i) => `<span class="${n === cur ? 'now' : ''}"><i style="background:${colors[n]}"></i>${n} <b>${core.cycle ? (100 * tracker.cycles[i] / core.cycle).toFixed(1) : '0.0'}%</b></span>`).join('');
    // the three task control blocks, straight from the model's memory
    $('os-tcbs').innerHTML = TASKS.map(([name, what, reg], i) => {
      const base = Number(sym[`tcb${i}`]);
      const done = word(base + OFFSET.done) !== 0n, running = cur === name && !done;
      const state = done ? 'done' : running ? 'running' : core.cycle ? 'ready' : 'not started';
      const saved = k => hex(word(base + OFFSET[k]));
      const rows = running
        ? `<dt>registers</dt><dd>in the CPU</dd><dt>sp</dt><dd>${hex(core.regs[2])}</dd><dt>${reg.split(' ')[0]}</dt><dd>${core.regs[reg.startsWith('s0') ? 8 : 9]}</dd>`
        : `<dt>saved pc</dt><dd>${saved('pc')}</dd><dt>saved sp</dt><dd>${saved('sp')}</dd><dt>${reg.split(' ')[0]}</dt><dd>${word(base + OFFSET[reg.slice(0, 2)])}</dd>`;
      return `<div class="tcb ${state.replace(' ', '-')}" style="--c:${COLORS()[name]}"><h3>${name} <span>${state}</span></h3><p>${what}</p>
        <div class="tcb-addr">control block at ${hex(base)}, ${reg}</div><dl>${rows}</dl></div>`;
    }).join('');
    const switches = core.stats.interrupts, kc = tracker.cycles[names.indexOf('kernel')];
    const r = core.halted ? `${core.regs[10]} · ${core.regs[11].toLocaleString('en-US')} · ${core.regs[12]}` : '-';
    $('os-stats').innerHTML = `<dt>cycle</dt><dd>${core.cycle.toLocaleString('en-US')}</dd><dt>switches</dt><dd>${switches}</dd>`
      + `<dt>cycles per switch</dt><dd>${switches ? Math.round(kc / switches) : '-'}</dd><dt>results a0 · a1 · a2</dt><dd>${r}</dd>`;
    $('os-term').textContent = core.output || ' ';
  }

  function frame() {
    const per = Math.max(1, Math.ceil(prof.cycles / (60 * 9)));
    for (let k = 0; k < per && !core.halted; k++) tracker.step(core.step());
    draw();
    if (core.halted) { playing = false; $('os-go').textContent = 'Play again'; return; }
    if (playing) raf = requestAnimationFrame(frame);
  }
  function stop() { cancelAnimationFrame(raf); playing = false; $('os-go').textContent = 'Play'; }
  function play() {
    if (core.halted) { core = new Core(img, { ...CONFIGS.performance }); tracker = new RegionTracker(prof.regions); }
    playing = true; $('os-go').textContent = 'Pause'; raf = requestAnimationFrame(frame);
  }
  function runAll() { while (!core.halted) tracker.step(core.step()); draw(); $('os-go').textContent = 'Play again'; }

  $('os-go').onclick = () => { if (!prof) return; if (playing) stop(); else play(); };
  $('os-q').oninput = () => { $('os-q-o').textContent = $('os-q').value; };
  $('os-q').onchange = async () => { if (await prepare()) { if (reducedMotion) runAll(); else play(); } };
  addEventListener('resize', () => { if (prof) draw(); });
  addEventListener('sixfold:theme', () => { if (prof) draw(); }); // site/theme.js: colours changed
  new IntersectionObserver(async (es, o) => {
    if (!es[0].isIntersecting) return;
    o.disconnect();
    if (await prepare()) { if (reducedMotion) runAll(); else play(); }
  }, { rootMargin: '200px' }).observe(canvas);
}

setup();
