#!/usr/bin/env node
// =============================================================================
// tools/a11y_check.mjs: accessibility check of the four pages with axe-core in a real browser
//
//   make a11y          (installs Playwright and axe-core into build/a11y the first time; needs Chromium:
//                       npx playwright install chromium, or set CHROME=/path/to/chrome)
//
// Opens the front page, the pipeline lab, the three-architecture lab and the instruction workshop in light
// and dark colour schemes, scrolls so every lazily built section exists, runs the labs to their last cycle,
// then reports every axe-core violation (contrast, labels, roles, keyboard reachability). Exit 1 if any.
// =============================================================================
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'build/a11y/package.json'));
const { chromium } = require('playwright');
const axe = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(0);
const base = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
let total = 0;
for (const page of ['index.html', 'web/index.html', 'web/isa.html', 'web/custom.html', '404.html']) for (const colorScheme of ['light', 'dark']) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme });
  await p.goto(base + page); await p.waitForTimeout(1200);
  for (let i = 0; i < 40; i++) { const done = await p.evaluate(() => { scrollBy(0, 700); return innerHeight + scrollY >= document.documentElement.scrollHeight - 2; }); await p.waitForTimeout(80); if (done) break; }
  if (await p.locator('#end').count()) { await p.locator('#end').click(); await p.waitForTimeout(1500); }
  await p.addScriptTag({ content: axe });
  const v = await p.evaluate(async () => (await window.axe.run(document)).violations.map(x => ({ id: x.id, impact: x.impact, nodes: x.nodes.map(n => n.target.join(' ')) })));
  total += v.length;
  console.log(`${v.length ? 'FAIL' : 'ok  '} ${page.padEnd(16)} ${colorScheme.padEnd(5)}${v.map(x => `\n       ${x.impact} ${x.id} (${x.nodes.length}): ${x.nodes.slice(0, 3).join(', ')}`).join('')}`);
  await p.close();
}
await browser.close(); server.close();
console.log(`\n${total ? `${total} accessibility violation types` : 'no accessibility violations'} (axe-core, WCAG 2 A and AA rules)`);
process.exit(total ? 1 : 0);
