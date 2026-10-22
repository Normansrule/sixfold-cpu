#!/usr/bin/env node
// =============================================================================
// tools/isa_test.mjs: the comparison programs on all three pipeline models
//
//   node tools/isa_test.mjs            check every program in programs/compare/ on RISC-V, MIPS and x86-64
//   node tools/isa_test.mjs --table    print the comparison table of docs/ISA_COMPARISON.md
//
// Checks, for each program and architecture: it halts; the result register holds the value in the
// program's "# RESULT:" line (a0 on RISC-V, $v0 on MIPS, rax on x86-64); what it printed equals its
// "# OUTPUT:" line; and the cycle equation of that pipeline accounts for every cycle.
// =============================================================================
import fs from 'node:fs';
import { ARCHS, measure } from '../model/isas/index.js';

const ROOT = new URL('../programs/compare/', import.meta.url);
const ORDER = ['riscv', 'mips', 'x86'];
const names = fs.readdirSync(new URL('riscv/', ROOT)).filter(f => f.endsWith('.s')).sort();
const header = (src, key) => (src.match(new RegExp(`^\\s*[#;]\\s*${key}:\\s*(.*)$`, 'm')) || [])[1];

if (process.argv.includes('--table')) {
  console.log('| program | bytes of code | instructions executed | cycles | cycles per instruction (CPI) |\n|---|---|---|---|---|');
  for (const f of names) {
    const r = ORDER.map(a => measure(a, fs.readFileSync(new URL(`${a}/${f}`, ROOT), 'utf8')));
    const ins = r.map(m => m.instructions + (m.uops && m.uops !== m.instructions ? ` (${m.uops} micro-ops)` : ''));
    console.log(`| ${f.replace(/\.s$/, '')} | ${r.map(m => m.codeBytes).join(' / ')} | ${ins.join(' / ')} | ${r.map(m => m.cycles).join(' / ')} | ${r.map(m => (m.cycles / m.instructions).toFixed(2)).join(' / ')} |`);
  }
  process.exit(0);
}

let bad = 0, n = 0;
for (const f of names) for (const a of ORDER) {
  const file = new URL(`${a}/${f}`, ROOT);
  if (!fs.existsSync(file)) { console.log(`FAIL ${a}/${f}: missing (every program is written for all three)`); bad++; continue; }
  const src = fs.readFileSync(file, 'utf8'), m = measure(a, src), problems = [];
  const want = header(src, 'RESULT'), out = header(src, 'OUTPUT');
  if (!m.halted) problems.push('never halted');
  if (want === undefined) problems.push('no "# RESULT:" line');
  else if (String(m.result) !== want.trim()) problems.push(`${ARCHS[a].result} = ${m.result}, expected ${want.trim()}`);
  if (out !== undefined && m.output.replace(/\n$/, '') !== out.replace(/\\n/g, '\n').trimEnd()) problems.push(`printed ${JSON.stringify(m.output)}, expected ${JSON.stringify(out)}`);
  if (!m.equationHolds) problems.push(`cycle equation does not add up: ${JSON.stringify(m.equation)}`);
  n++; bad += problems.length > 0;
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${a.padEnd(5)} ${f.padEnd(26)} ${String(m.cycles).padStart(4)} cycles` + (problems.length ? '\n       ' + problems.join('\n       ') : ''));
}
console.log(`\n${n - bad} of ${n} comparison runs correct (result, output, cycle equation)`);
process.exit(bad ? 1 : 0);
