#!/usr/bin/env node
// =============================================================================
// tools/compute_bench.mjs: what the packed "xcompute" instructions buy, measured on the kernel programs
//
//   node tools/compute_bench.mjs          prints the table and writes docs/img/charts/xcompute_table.md
//                                         and docs/img/charts/xcompute.json (the site's chart reads it)
//
// Every program with "# BENCH: <name> | <cycles plain> <cycles packed> | <instructions plain> <packed>" lines
// (programs/25 ... 28) measures each kernel twice in one run, with rdcycle / rdinstret around a plain
// RV64 + Zbb + M version and a packed version, and checks the two agree (a0 = 0) and match plain Python
// (tools/kernel_reference.py, the EXPECT lines). This tool runs them on the model of every build, predictor
// on; `make test` checks the RTL of every build cycle-exact against the same model runs.
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { assemble } from '../model/asm.js';
import { Core, CONFIGS } from '../model/core.js';
import { DeepCore } from '../model/deep.js';
import { regNum } from '../model/isa.js';

const BUILDS = ['performance', 'baseline', 'turbo', 'deep'];
const rows = [];
for (const f of fs.readdirSync('programs').filter(x => x.endsWith('.s')).sort()) {
  const src = fs.readFileSync(path.join('programs', f), 'utf8');
  const benches = [...src.matchAll(/^#\s*BENCH:\s*(.+?)\s*\|\s*(\w+)\s+(\w+)\s*\|\s*(\w+)\s+(\w+)\s*$/gm)];
  if (!benches.length) continue;
  const img = assemble(src);
  const runs = {};
  for (const b of BUILDS) {
    const c = b === 'deep' ? new DeepCore(img, { bp: true }) : new Core(img, { ...CONFIGS[b], bp: true });
    c.run(5e6, false);
    if (!c.halted || c.csr.tohost !== 1n || c.regs[regNum('a0')] !== 0n) throw new Error(`${f} (${b}): did not pass`);
    runs[b] = c;
  }
  for (const m of benches) {
    const [, name, cp, cx, ip, ix] = m, r = { program: f.replace('.s', ''), name };
    for (const b of BUILDS) {
      const g = k => Number(runs[b].regs[regNum(k)]);
      r[b] = { plain: g(cp), packed: g(cx), instPlain: g(ip), instPacked: g(ix) };
    }
    rows.push(r);
  }
}
const x = (a, b) => `${(a / b).toFixed(1)}x`;
const n = v => v.toLocaleString('en-US');
let md = `| kernel | instructions plain / packed | performance: cycles plain / packed | speedup | baseline | turbo | deep |\n|---|---:|---:|---:|---:|---:|---:|\n`;
for (const r of rows) {
  const p = r.performance;
  md += `| ${r.name} (\`${r.program}\`) | ${n(p.instPlain)} / ${n(p.instPacked)} | ${n(p.plain)} / ${n(p.packed)} | **${x(p.plain, p.packed)}** | ${BUILDS.slice(1).map(b => x(r[b].plain, r[b].packed)).join(' | ')} |\n`;
}
const geo = b => Math.exp(rows.reduce((s, r) => s + Math.log(r[b].plain / r[b].packed), 0) / rows.length);
md += `| **geometric mean** | | | **${geo('performance').toFixed(1)}x** | ${BUILDS.slice(1).map(b => `${geo(b).toFixed(1)}x`).join(' | ')} |\n`;
md += `\nCycles between the two rdcycle reads around each version (the model, predictor on; the RTL of every build agrees cycle for cycle).\n`;
fs.mkdirSync('docs/img/charts', { recursive: true });
fs.writeFileSync('docs/img/charts/xcompute_table.md', md);
fs.writeFileSync('docs/img/charts/xcompute.json', JSON.stringify({ builds: BUILDS, kernels: rows }, null, 1) + '\n');
console.log(md);

// ---------------------------------------------------------------- the chart: speedup per kernel, performance edition
{
  const FONT = "font-family=\"'IBM Plex Sans','Segoe UI',Helvetica,Arial,sans-serif\"", MONO = "font-family=\"'IBM Plex Mono',Consolas,monospace\"";
  const lx = 330, bw = 470, rh = 34, top = 76, width = lx + bw + 110, height = top + rows.length * rh + 64;
  const max = Math.ceil(Math.max(...rows.map(r => r.performance.plain / r.performance.packed)) / 5) * 5;
  const X = v => lx + bw * v / max;
  let o = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="t d"><title id="t">Packed instructions: speedup per kernel</title><desc id="d">Plain RV64 code cycles divided by packed code cycles, performance edition, for ${rows.length} kernels; the same numbers are in docs/img/charts/xcompute_table.md.</desc><rect width="100%" height="100%" rx="10" fill="#FBFCF8" stroke="#D5DBD0"/>`;
  o += `<text x="16" y="28" ${FONT} font-size="17" font-weight="600" fill="#17251D">What the packed instructions buy: speedup per kernel</text>`;
  o += `<text x="16" y="48" ${FONT} font-size="12" fill="#4A5A50">Plain RV64 + Zbb + M cycles ÷ packed (xcompute) cycles, performance edition, predictor on. Measured on the cycle-exact model; the RTL agrees.</text>`;
  for (let v = 0; v <= max; v += 5) o += `<line x1="${X(v)}" x2="${X(v)}" y1="${top - 6}" y2="${top + rows.length * rh}" stroke="#E3E8DF"/><text x="${X(v)}" y="${top + rows.length * rh + 18}" ${MONO} font-size="10.5" fill="#6B7A70" text-anchor="middle">${v}x</text>`;
  rows.forEach((r, i) => {
    const p = r.performance, s = p.plain / p.packed, y = top + i * rh;
    o += `<g><title>${r.name}: ${n(p.plain)} cycles plain, ${n(p.packed)} packed (${s.toFixed(1)}x)</title>`;
    o += `<rect x="16" y="${y}" width="${width - 32}" height="${rh}" fill="transparent"/>`; // hover target bigger than the bar
    o += `<text x="${lx - 10}" y="${y + 21}" ${FONT} font-size="12" fill="#17251D" text-anchor="end">${r.name.replace(/ \(.*\)$/, '')}</text>`;
    o += `<path d="M${lx} ${y + 8} H${X(s) - 4} a4 4 0 0 1 4 4 v10 a4 4 0 0 1 -4 4 H${lx} Z" fill="#2E86C1"/>`;
    o += `<text x="${X(s) + 8}" y="${y + 21}" ${MONO} font-size="11.5" fill="#17251D">${s.toFixed(1)}x</text></g>`;
  });
  o += `<line x1="${lx}" x2="${lx}" y1="${top - 6}" y2="${top + rows.length * rh}" stroke="#6B7A70"/>`;
  o += `<text x="16" y="${height - 16}" ${FONT} font-size="11" fill="#4A5A50">Geometric mean ${geo('performance').toFixed(1)}x. The plain loops handle one element per trip and are not unrolled; a compiler that unrolls them would narrow the gap.</text>`;
  fs.writeFileSync('docs/img/charts/xcompute_speedup.svg', o + '</svg>\n');
}
