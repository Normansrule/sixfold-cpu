#!/usr/bin/env node
// =============================================================================
// tools/check_links.mjs: every relative link and image in the repository's Markdown and HTML resolves
//
//   node tools/check_links.mjs        (exit 1 if any link points at a missing file or #anchor)
//
// Checks [text](path), ![image](path), href="..." and src="..." that are not web addresses, and for
// links to a .md or .html file with #anchor, that the heading or id exists (GitHub's heading slugs).
// =============================================================================
import fs from 'node:fs'; import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const files = [];
const walk = d => { for (const f of fs.readdirSync(d)) { if (['.git', 'build', 'node_modules'].includes(f)) continue; const p = path.join(d, f); const st = fs.statSync(p); if (st.isDirectory()) walk(p); else if (/\.(md|html)$/.test(f)) files.push(p); } };
walk(root);
const slug = h => h.trim().toLowerCase().replace(/<[^>]+>/g, '').replace(/[`*_]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
const anchors = f => { const s = fs.readFileSync(f, 'utf8'); const set = new Set(); const seen = {}; for (const m of s.matchAll(/^#{1,6}\s+(.+)$/gm)) { let a = slug(m[1]); if (seen[a] !== undefined) { seen[a]++; a = `${a}-${seen[a]}`; } else seen[a] = 0; set.add(a); } for (const m of s.matchAll(/id="([^"]+)"/g)) set.add(m[1]); return set; };
let bad = 0, n = 0;
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  const links = [];
  if (f.endsWith('.md')) { const body = s.replace(/```[\s\S]*?```/g, ''); for (const m of body.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) links.push(m[1]); for (const m of body.matchAll(/(?:src|href)="([^"]+)"/g)) links.push(m[1]); }
  else for (const m of s.matchAll(/(?:src|href)="([^"]+)"/g)) links.push(m[1]);
  for (const l of links) {
    if (/^(https?:|mailto:|data:|javascript:)/.test(l) || l.includes('${')) continue;
    n++;
    const [p, a] = l.split('?')[0].split('#');
    const target = p ? path.resolve(path.dirname(f), decodeURIComponent(p)) : f;
    if (!fs.existsSync(target)) { console.log(`MISSING ${path.relative(root, f)} -> ${l}`); bad++; continue; }
    if (a && /\.(md|html)$/.test(target) && !anchors(target).has(a)) { console.log(`ANCHOR  ${path.relative(root, f)} -> ${l}`); bad++; }
  }
}
console.log(`${files.length} files, ${n} relative links, ${bad} broken`);
process.exit(bad ? 1 : 0);
