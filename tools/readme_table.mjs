// The README's results table, computed by the model.
//   node tools/readme_table.mjs           print it
//   node tools/readme_table.mjs --write   replace the table in README.md (CI checks that it is current)
import fs from 'node:fs';
import { assemble } from '../model/asm.js';
import { Core } from '../model/core.js';
const out = ['| program | what it shows | cycles (gshare) | CPI | cycles (predictor off) | CPI |', '|---|---|---:|---:|---:|---:|'];
for (const f of fs.readdirSync('programs').filter(x => x.endsWith('.s')).sort()) {
  const src = fs.readFileSync('programs/' + f, 'utf8');
  const what = (src.split('\n')[1].split(': ')[1] || '').trim();
  const img = assemble(src);
  const r = [true, false].map(bp => { const c = new Core(img, { bp }); c.run(5e6, false); return c.stats; });
  out.push(`| [\`${f.replace('.s', '')}\`](programs/${f}) | ${what} | ${r[0].cycles} | ${(r[0].cycles / r[0].retired).toFixed(2)} | ${r[1].cycles} | ${(r[1].cycles / r[1].retired).toFixed(2)} |`);
}
if (process.argv.includes('--write')) {
  const lines = fs.readFileSync('README.md', 'utf8').split('\n');
  const start = lines.findIndex(l => l.startsWith('| program | what it shows |'));
  if (start < 0) throw new Error('README.md: the results table header was not found');
  let end = start; while (end < lines.length && lines[end].startsWith('|')) end++;
  lines.splice(start, end - start, ...out);
  fs.writeFileSync('README.md', lines.join('\n'));
} else console.log(out.join('\n'));
