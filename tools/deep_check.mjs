#!/usr/bin/env node
// =============================================================================
// tools/deep_check.mjs: run every program on the deep-pipeline model (model/deep.js) and check it
//
//   node tools/deep_check.mjs [filter] [--bp=off] [--trace]
//
// Checks what does not depend on timing: the "# EXPECT:" lines without a build tag, the expected output and
// PASS through tohost. Then prints the deep model's cycles and CPI next to the turbo model's (model/core.js).
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { assemble } from '../model/asm.js';
import { Core, CONFIGS } from '../model/core.js';
import { DeepCore, DEEP_CYCLE_PS, TURBO_CYCLE_PS } from '../model/deep.js';
import { regNum } from '../model/isa.js';

const args = process.argv.slice(2);
const filter = args.find(a => !a.startsWith('--'));
const bp = !args.includes('--bp=off');
const files = ['programs', 'tests'].flatMap(d => fs.readdirSync(d).filter(f => f.endsWith('.s')).sort().map(f => path.join(d, f)))
  .filter(f => !filter || f.includes(filter));
let fail = 0;
const tot = { programs: [0, 0, 0, 0], tests: [0, 0, 0, 0] }; // deep cycles, deep retired, turbo cycles, turbo retired
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8'), img = assemble(src);
  const deep = new DeepCore(img, { bp });
  const trace = [];
  try { while (!deep.halted && deep.cycle < 3000000) { const ev = deep.step(); if (args.includes('--trace')) trace.push(DeepCore.traceLine(ev)); } }
  catch (e) { console.log(`FAIL ${f}: ${e.message} (cycle ${deep.cycle})`); fail++; continue; }
  if (trace.length) fs.writeFileSync(`build/${path.basename(f, '.s')}.deep.trace`, trace.join('\n') + '\n');
  const turbo = new Core(img, { ...CONFIGS.turbo, bp }); turbo.run(3000000, false);
  const problems = [];
  if (!deep.halted) problems.push('did not halt');
  for (const m of src.matchAll(/^#\s*EXPECT:\s*(\w+)\s*=\s*(-?\w+)\s*$/gm)) {
    const v = BigInt.asUintN(64, BigInt(m[2])), got = deep.regs[regNum(m[1])];
    if (got !== v) problems.push(`${m[1]} = ${BigInt.asIntN(64, got)}, expected ${BigInt.asIntN(64, v)}`);
  }
  const out = [...src.matchAll(/^#\s*EXPECT-OUTPUT:\s?(.*)$/gm)].map(m => m[1].replace(/\\n/g, '\n')).join('');
  if (out && deep.output !== out) problems.push(`output ${JSON.stringify(deep.output.slice(0, 80))}, expected ${JSON.stringify(out.slice(0, 80))}`);
  if (deep.halted && deep.csr.tohost !== 1n) problems.push(`tohost = ${deep.csr.tohost}`);
  const s = deep.stats, t = turbo.stats;
  const k = f.startsWith('programs') ? 'programs' : 'tests';
  tot[k][0] += s.cycles; tot[k][1] += s.retired; tot[k][2] += t.cycles; tot[k][3] += t.retired;
  const info = `deep CPI ${(s.cycles / s.retired).toFixed(2)} (${s.cycles} cycles)  turbo CPI ${(t.cycles / t.retired).toFixed(2)}  holds: dep ${s.dependencyHolds} serial ${s.serialHolds} mdu ${s.mduHolds} custom ${s.customHolds} | flushes ${s.flushes} redirects ${s.redirects} replays ${s.replays} imiss ${s.icacheMisses}`;
  if (problems.length) { fail++; console.log(`FAIL ${f.padEnd(34)} ${info}`); problems.slice(0, 5).forEach(p => console.log('   - ' + p)); }
  else console.log(`PASS ${f.padEnd(34)} ${info}`);
}
const all = [0, 1, 2, 3].map(i => tot.programs[i] + tot.tests[i]);
for (const [k, v] of [['programs', tot.programs], ['tests', tot.tests], ['all', all]])
  console.log(`${k.padEnd(9)} deep CPI ${(v[0] / v[1]).toFixed(3)}   turbo CPI ${(v[2] / v[3]).toFixed(3)}   time per instruction at 7 nm: deep ${(v[0] / v[1] * DEEP_CYCLE_PS).toFixed(0)} ps, turbo ${(v[2] / v[3] * TURBO_CYCLE_PS).toFixed(0)} ps`);
process.exit(fail ? 1 : 0);
