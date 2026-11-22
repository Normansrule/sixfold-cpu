#!/usr/bin/env node
// =============================================================================
// tools/compare_builds.mjs: the six-stage turbo build against the 14-stage deep edition, by kind of work
//
//   node tools/compare_builds.mjs          (make compare)
//
// Runs every program in programs/ on both cycle-exact models (model/core.js CONFIGS.turbo, model/deep.js), turns
// cycles into time with each build's measured clock period at 7 nm (DEEP_CYCLE_PS, TURBO_CYCLE_PS: logic from
// tools/timing.sh plus the flip-flops, no wires or clock skew), and groups the programs by the kind of work they do.
// The grouping is a judgement written down here, not a measurement; the cycles and periods are measured.
//
//   docs/img/charts/build_compare.svg   deep time / turbo time per program (below 1: the deep edition is faster)
//   docs/img/charts/build_compare.md    the same numbers, per program and per kind of work
// =============================================================================
import fs from 'node:fs';
import { assemble } from '../model/asm.js';
import { Core, CONFIGS } from '../model/core.js';
import { DeepCore, DEEP_CYCLE_PS, TURBO_CYCLE_PS } from '../model/deep.js';

// The machine timer (mtime) counts clock cycles in both builds, so a program that waits for the timer
// (21_timer_interrupts, 22_multitasking) waits a fixed number of CYCLES: on the faster deep clock that is a
// shorter time, which flatters the deep edition. On a chip whose timer runs from a fixed clock those waits take
// the same time on both builds. TIMER marks them in the outputs.
export const TIMER = new Set(['21_timer_interrupts', '22_multitasking']);
// What each program mostly does (an application stands in for each kind of work)
export const KINDS = [
  ['loops', 'Tight, predictable loops', 'DSP filters, fixed-trip counters, streaming arithmetic',
    ['05_fibonacci', '11_gshare_patterns', '12_measure_cpi']],
  ['compute', 'Compute kernels', 'hashing and crypto, bit manipulation, custom instructions, sieves and table walks',
    ['09_primes_sieve', '18_bit_tricks', '23_custom_instructions', '24_sha256']],
  ['branchy', 'Data-dependent branches', 'sorting, parsers, game logic and AI decisions, collision tests',
    ['04_branch_penalty', '06_bubble_sort', '14_false_load_stall', '16_cache_conflicts', '17_predictor_challenge']],
  ['muldiv', 'Multiply and divide heavy', 'number formatting, fixed-point maths, schedulers that divide time',
    ['07_factorial_recursive', '08_gcd_euclid', '10_print_numbers', '22_multitasking']],
  ['system', 'Calls, traps and devices', 'firmware, drivers, system calls, interrupts, console output',
    ['01_hello', '13_function_call_cost', '15_system_calls', '19_performance_counters', '20_leds_and_buttons', '21_timer_interrupts']],
  ['startup', 'Very short programs', 'a few dozen instructions: the pipeline fill is most of the time',
    ['00_pipeline_fill', '02_forwarding', '03_load_use']],
];

export function measure() {
  const rows = [];
  for (const [key, , , names] of KINDS) for (const name of names) {
    const img = assemble(fs.readFileSync(`programs/${name}.s`, 'utf8'));
    const turbo = new Core(img, { ...CONFIGS.turbo }); turbo.run(5e6, false);
    const deep = new DeepCore(img, {});
    while (!deep.halted && deep.cycle < 5e6) deep.step();
    if (!turbo.halted || !deep.halted) throw new Error(`${name} did not halt`);
    const t = turbo.stats, d = deep.stats;
    rows.push({ key, name, retired: t.retired, tc: t.cycles, dc: d.cycles, tns: t.cycles * TURBO_CYCLE_PS / 1000, dns: d.cycles * DEEP_CYCLE_PS / 1000,
      mdu: d.mduHolds, dep: d.dependencyHolds, flushes: d.flushes });
  }
  return rows;
}

const FONT = "font-family=\"'IBM Plex Sans','Segoe UI',Helvetica,Arial,sans-serif\"";
const MONO = "font-family=\"'IBM Plex Mono',Consolas,monospace\"";
const DEEP_WINS = '#1F77B4', TURBO_WINS = '#C2410C', INK = '#17251D', SUB = '#4A5A50', MUTED = '#6B7A70', GRID = '#D5DBD0';

function svg(rows) {
  const lx = 330, pw = 520, rh = 20, top = 92, gap = 26;
  const lo = 0.7, hi = 2.3, X = r => lx + pw * (Math.log(r) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
  const height = top + rows.length * rh + KINDS.length * gap + 60, width = lx + pw + 190;
  let o = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="t d">`;
  o += `<title id="t">Deep edition against turbo build: time per program</title><desc id="d">For each example program, the deep edition's run time divided by the turbo build's, at 7 nm. Below 1 the deep edition is faster.</desc>`;
  o += `<rect width="100%" height="100%" rx="10" fill="#FBFCF8" stroke="${GRID}"/>`;
  o += `<text x="16" y="28" ${FONT} font-size="17" font-weight="600" fill="${INK}">Which build finishes first? Deep edition (14 stages) against turbo (6 stages), by kind of work</text>`;
  o += `<text x="16" y="48" ${FONT} font-size="12" fill="${SUB}">Run time = cycles (measured on the cycle-exact models) x clock period (measured at 7 nm: deep ${DEEP_CYCLE_PS} ps, turbo ${TURBO_CYCLE_PS} ps, no wires or clock skew).</text>`;
  o += `<text x="16" y="66" ${FONT} font-size="12" fill="${SUB}">Each bar is deep time / turbo time on a log scale. Left of the 1.0 line the deep edition is faster; right of it the turbo build is.</text>`;
  for (const v of [0.8, 1, 1.25, 1.5, 2]) {
    o += `<line x1="${X(v)}" y1="${top - 8}" x2="${X(v)}" y2="${height - 46}" stroke="${v === 1 ? INK : GRID}" stroke-width="${v === 1 ? 1.5 : 1}"/>`;
    o += `<text x="${X(v)}" y="${top - 12}" ${MONO} font-size="10.5" fill="${MUTED}" text-anchor="middle">${v.toFixed(2)}</text>`;
  }
  let y = top;
  for (const [key, label, apps] of KINDS) {
    const g = rows.filter(r => r.key === key), ratio = g.reduce((a, r) => a + r.dns, 0) / g.reduce((a, r) => a + r.tns, 0);
    y += gap;
    o += `<text x="16" y="${y - 8}" ${FONT} font-size="12.5" font-weight="700" fill="${INK}">${label}<tspan font-weight="400" fill="${SUB}">: ${apps}</tspan></text>`;
    o += `<text x="${lx + pw + 12}" y="${y - 8}" ${FONT} font-size="11.5" font-weight="600" fill="${INK}">group ${ratio.toFixed(2)}x</text>`;
    for (const r of g) {
      const q = r.dns / r.tns, x0 = X(1), x1 = X(Math.min(hi, Math.max(lo, q)));
      o += `<g><title>${r.name}: deep ${r.dc} cycles (${r.dns.toFixed(1)} ns), turbo ${r.tc} cycles (${r.tns.toFixed(1)} ns), ratio ${q.toFixed(2)}</title>`;
      o += `<text x="${lx - 10}" y="${y + 14}" ${MONO} font-size="11" fill="${INK}" text-anchor="end">${r.name}${TIMER.has(r.name) ? ' *' : ''}</text>`;
      o += `<rect x="${Math.min(x0, x1)}" y="${y + 4}" width="${Math.max(2, Math.abs(x1 - x0))}" height="${rh - 8}" rx="3" fill="${q < 1 ? DEEP_WINS : TURBO_WINS}"/>`;
      o += `<text x="${lx + pw + 12}" y="${y + 14}" ${MONO} font-size="10.5" fill="${SUB}">${q.toFixed(2)}  ${r.dns.toFixed(0)} / ${r.tns.toFixed(0)} ns</text></g>`;
      y += rh;
    }
  }
  const ly = height - 26;
  o += `<rect x="16" y="${ly - 10}" width="14" height="10" rx="2" fill="${DEEP_WINS}"/><text x="36" y="${ly}" ${FONT} font-size="11.5" fill="${INK}">deep edition faster</text>`;
  o += `<rect x="176" y="${ly - 10}" width="14" height="10" rx="2" fill="${TURBO_WINS}"/><text x="196" y="${ly}" ${FONT} font-size="11.5" fill="${INK}">turbo build faster</text>`;
  o += `<text x="356" y="${ly}" ${FONT} font-size="11.5" fill="${SUB}">* waits for the timer, which counts cycles: flatters the deep edition. Numbers: build_compare.md</text>`;
  return o + '</svg>\n';
}

function table(rows) {
  let m = `# Turbo (6 stages) against the deep edition (14 stages), by kind of work\n\n`;
  m += `Generated by \`make compare\` (tools/compare_builds.mjs). Cycles are measured on the cycle-exact models; time is cycles x the measured clock period at 7 nm (turbo ${TURBO_CYCLE_PS} ps, deep ${DEEP_CYCLE_PS} ps; logic plus flip-flops, no wires or clock skew). The grouping into kinds of work is a judgement. A ratio below 1.00 means the deep edition finishes first.\n\n`;
  m += `| kind of work | programs | turbo time | deep time | deep / turbo | faster build |\n|---|---:|---:|---:|---:|---|\n`;
  for (const [key, label] of KINDS) {
    const g = rows.filter(r => r.key === key), t = g.reduce((a, r) => a + r.tns, 0), d = g.reduce((a, r) => a + r.dns, 0);
    m += `| ${label} | ${g.length} | ${t.toFixed(0)} ns | ${d.toFixed(0)} ns | ${(d / t).toFixed(2)} | ${d < t ? 'deep' : 'turbo'} |\n`;
  }
  const t = rows.reduce((a, r) => a + r.tns, 0), d = rows.reduce((a, r) => a + r.dns, 0);
  m += `| **all ${rows.length} programs** | ${rows.length} | ${t.toFixed(0)} ns | ${d.toFixed(0)} ns | ${(d / t).toFixed(2)} | ${d < t ? 'deep' : 'turbo'} |\n\n`;
  m += `| program | kind | instructions | turbo cycles | deep cycles | turbo CPI | deep CPI | turbo ns | deep ns | deep / turbo | deep: dependency holds | deep: multiply/divide holds |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
  for (const r of rows) m += `| ${r.name}${TIMER.has(r.name) ? ' (timer)' : ''} | ${r.key} | ${r.retired} | ${r.tc} | ${r.dc} | ${(r.tc / r.retired).toFixed(2)} | ${(r.dc / r.retired).toFixed(2)} | ${r.tns.toFixed(1)} | ${r.dns.toFixed(1)} | ${(r.dns / r.tns).toFixed(2)} | ${r.dep} | ${r.mdu} |\n`;
  m += `\n(timer): the program waits for the machine timer, which counts clock cycles in both builds, so its wait is shorter in time on the faster deep clock. With a timer on a fixed clock, as on a real chip, the deep edition would do worse on these two than shown.\n`;
  m += `\nThe deep edition wins only where its CPI is less than ${(TURBO_CYCLE_PS / DEEP_CYCLE_PS).toFixed(3)} times the turbo build's (${TURBO_CYCLE_PS} / ${DEEP_CYCLE_PS}).\n`;
  return m;
}

const rows = measure();
fs.mkdirSync('docs/img/charts', { recursive: true });
fs.writeFileSync('docs/img/charts/build_compare.svg', svg(rows));
fs.writeFileSync('docs/img/charts/build_compare.md', table(rows));
const t = rows.reduce((a, r) => a + r.tns, 0), d = rows.reduce((a, r) => a + r.dns, 0);
console.log(`wrote docs/img/charts/build_compare.svg and .md: ${rows.length} programs, deep / turbo time ${(d / t).toFixed(3)}`);
