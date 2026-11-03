// =============================================================================
// site/isa.js: "One program, three instruction sets" on the front page.
//
// The same program written for RISC-V, MIPS and x86-64, assembled by model/asm.js and model/isas/ and run
// to the end on each pipeline model (the same models the lab at web/isa.html steps through, and that
// tools/isa_crosscheck.py checks against the Unicorn CPU emulator). Nothing here is typed in by hand: every
// byte and every count comes from running the code.
// =============================================================================
import { ARCHS, measure } from '../model/isas/index.js';
import { COMPARE_PROGRAMS } from '../web/programs.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const ORDER = ['riscv', 'mips', 'x86'];
const COLOR = { riscv: '--F1', mips: '--D', x86: '--W' };
const NAMES = Object.keys(COMPARE_PROGRAMS);
const nice = n => n.replace(/_/g, ' ');
const title = n => (COMPARE_PROGRAMS[n].riscv.split('\n')[0].split(': ').slice(1).join(': ') || nice(n)).trim();
// x86 instructions are built from parts; each part gets the colour of its role
const PART = { prefix: '--ink3', REX: '--E', opcode: '--F1', ModRM: '--M', SIB: '--F2', disp: '--W', imm: '--W' };
const partVar = p => PART[p.cls] || PART[p.name] || (/^imm/.test(p.name) ? '--W' : /disp/.test(p.name) ? '--W' : '--F1');
const cache = {};
let current = NAMES.includes('bubble_sort') ? 'bubble_sort' : NAMES[0];

function run(name) {
  if (!cache[name]) cache[name] = Object.fromEntries(ORDER.map(a => {
    const src = COMPARE_PROGRAMS[name][a], img = ARCHS[a].assemble(src);
    return [a, { m: measure(a, src), rows: ARCHS[a].listing(img) }];
  }));
  return cache[name];
}

function column(a, { m, rows }) {
  const code = rows.map(r => {
    const bytes = a === 'x86'
      ? r.parts.map(p => `<b style="color:var(${partVar(p)})" title="${esc(p.name)}">${p.bits}</b>`).join(' ')
      : r.bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
    return `<tr><td class="ia">${r.addr.toString(16)}</td><td class="ib">${bytes}</td><td class="it">${esc(r.text)}${r.uops && r.uops.length > 1 ? ` <i title="${esc(r.uops.join('\n'))}">${r.uops.length} micro-ops</i>` : ''}</td></tr>`;
  }).join('');
  return `<div class="isa-col" style="--ac:var(${COLOR[a]})">
    <h3>${ARCHS[a].name}</h3>
    <p class="isa-pipe">${esc(ARCHS[a].pipeline || '')}</p>
    <div class="isa-code" tabindex="0" role="region" aria-label="${ARCHS[a].name} machine code"><table>${code}</table></div>
    <a class="isa-open" href="web/isa.html?arch=${a}&prog=${current}">Step through it cycle by cycle</a>
  </div>`;
}

function render() {
  const r = run(current);
  $('isa-cols').innerHTML = ORDER.map(a => column(a, r[a])).join('');
  const metrics = [['bytes of code', 'codeBytes'], ['instructions executed', 'instructions'], ['clock cycles', 'cycles']];
  $('isa-bars').innerHTML = metrics.map(([label, k]) => {
    const max = Math.max(...ORDER.map(a => r[a].m[k]));
    return `<div class="isa-metric"><h4>${label}</h4>${ORDER.map(a => {
      const v = r[a].m[k], extra = a === 'x86' && k === 'instructions' && r[a].m.uops ? ` <small>${r[a].m.uops} micro-ops</small>` : '';
      return `<div class="isa-bar" style="--ac:var(${COLOR[a]})"><span>${ARCHS[a].name}</span><i style="width:${(100 * v / max).toFixed(1)}%"></i><b>${v.toLocaleString('en-US')}${extra}</b></div>`;
    }).join('')}</div>`;
  }).join('');
  const ok = ORDER.every(a => r[a].m.equationHolds && String(r[a].m.result) === String(r.riscv.m.result));
  $('isa-note').textContent = `All three compute ${r.riscv.m.result}${r.riscv.m.output ? ` and print "${r.riscv.m.output.trim()}"` : ''}. `
    + (ok ? 'Every cycle on every pipeline is accounted for by its cycle equation.' : 'The models disagree: please report this.');
  for (const b of $('isa-progs').children) b.setAttribute('aria-pressed', String(b.dataset.p === current));
}

const section = $('isa');
if (section) {
  $('isa-progs').innerHTML = NAMES.map(n => `<button type="button" data-p="${n}" title="${esc(title(n))}">${nice(n)}</button>`).join('');
  $('isa-progs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { current = b.dataset.p; render(); } });
  new IntersectionObserver((es, o) => { if (es[0].isIntersecting) { o.disconnect(); render(); } }, { rootMargin: '400px' }).observe(section);
}
