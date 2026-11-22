#!/usr/bin/env node
// =============================================================================
// tools/turbo_report.mjs: the performance edition against the turbo edition, every program, predictor on.
//   writes docs/img/charts/turbo_table.md (included in docs/PERFORMANCE.md)
// Each column of the cycle equation (docs/MATH.md) is summed over all programs, so the table shows which
// term every turbo feature removed and what is left between the programs and CPI 1.0.
// The RTL of both builds is checked cycle-exact against these model runs by `make test`.
// =============================================================================
import fs from 'node:fs';
import { assemble } from '../model/asm.js';
import { Core, CONFIGS } from '../model/core.js';

const CFGS = ['performance', 'turbo'];
const rows = [], total = Object.fromEntries(CFGS.map(c => [c, { N: 0, cycles: 0, L: 0, F: 0, R: 0, K: 0, I: 0, D: 0, X: 0, B: 0 }]));
for (const dir of ['programs', 'tests']) for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.s')).sort()) {
  const img = assemble(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  const r = { name: `${dir === 'tests' ? 'tests/' : ''}${f.replace('.s', '')}` };
  for (const cfg of CFGS) {
    const c = new Core(img, { ...CONFIGS[cfg], bp: true }); c.run(5e6, false);
    const s = c.stats, b = s.bubbles, t = total[cfg];
    r[cfg] = s;
    t.N += s.retired; t.cycles += s.cycles; t.L += s.loadStalls; t.F += 3 * s.flushes; t.R += b.redirect; t.K += b.muldiv; t.I += b.imiss; t.D += b.dmiss; t.X += s.interrupts; t.B += b.late;
  }
  rows.push(r);
}
const cpi = s => s.cycles / s.retired;
let md = `| program | performance: cycles | CPI | turbo: cycles | CPI | change |\n|---|---:|---:|---:|---:|---:|\n`;
let geo = 0;
for (const r of rows) {
  const p = r.performance, t = r.turbo;
  geo += Math.log(p.cycles / t.cycles);
  md += `| \`${r.name}\` | ${p.cycles.toLocaleString('en-US')} | ${cpi(p).toFixed(2)} | ${t.cycles.toLocaleString('en-US')} | **${cpi(t).toFixed(2)}** | ${(100 * (t.cycles / p.cycles - 1)).toFixed(1)}% |\n`;
}
md += `\nGeometric-mean cycle reduction, turbo over performance: **${(100 * (1 - Math.exp(-geo / rows.length))).toFixed(1)}%** over ${rows.length} programs.\n\n`;
md += `Every cycle above one per instruction, summed over all ${rows.length} programs (\`cycles = N + 5 + L + 3F + R + K + I + D + X + B\` per program):\n\n`;
md += `| build | N | cycles | CPI | L | 3F | R | K | I | D | X | B |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
for (const cfg of CFGS) { const t = total[cfg]; md += `| ${cfg} | ${t.N.toLocaleString('en-US')} | ${t.cycles.toLocaleString('en-US')} | ${(t.cycles / t.N).toFixed(3)} | ${['L', 'F', 'R', 'K', 'I', 'D', 'X', 'B'].map(k => t[k].toLocaleString('en-US')).join(' | ')} |\n`; }
md += `\n(N differs between the builds because the interrupt programs wait for a timer: a faster core runs its idle loop more often. B is the extra bubble of a branch resolved one stage later, LATE_BRANCH_RESOLVE.)\n`;
fs.mkdirSync('docs/img/charts', { recursive: true });
fs.writeFileSync('docs/img/charts/turbo_table.md', md);
console.log(md);
