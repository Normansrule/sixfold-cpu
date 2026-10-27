#!/usr/bin/env node
// =============================================================================
// desktop/scripts/stage.mjs: copy the website from the repository into desktop/app-site/
//
// The desktop app is the same static site the GitHub Pages workflow publishes, bundled offline. Only what
// the pages load or link to is copied: the pages, their scripts, the model, the programs, the
// documentation and its pictures. Not copied: the RTL build output, the place-and-route data of the
// silicon prototype (docs/silicon, megabytes of text the site does not open), the FPGA and simulation
// sources, and git.
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.resolve(HERE, '..', 'app-site');
const COPY = ['index.html', 'LICENSE', 'README.md', 'site', 'web', 'model', 'programs', 'docs', 'binary', 'fpga/examples', 'tests/isa_selfcheck.s', 'custom'];
const SKIP = new Set([path.join('docs', 'silicon'), 'node_modules', '.git', '.DS_Store']);

let files = 0, bytes = 0;
function copy(rel) {
  const src = path.join(ROOT, rel), dst = path.join(OUT, rel);
  if (SKIP.has(rel) || SKIP.has(path.basename(rel))) return;
  if (!fs.existsSync(src)) { console.warn(`stage: ${rel} does not exist, skipped`); return; }
  const st = fs.statSync(src);
  if (st.isDirectory()) { for (const name of fs.readdirSync(src)) copy(path.join(rel, name)); return; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  files++; bytes += st.size;
}

fs.rmSync(OUT, { recursive: true, force: true });
for (const rel of COPY) copy(rel);
if (!fs.existsSync(path.join(OUT, 'index.html'))) { console.error('stage: index.html is missing: run this inside the sixfold-cpu repository'); process.exit(1); }
console.log(`staged ${files} files (${(bytes / 1048576).toFixed(1)} MiB) into ${path.relative(process.cwd(), OUT) || OUT}`);
