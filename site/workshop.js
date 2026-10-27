// =============================================================================
// site/workshop.js: "Invent an instruction" and "Take it with you" on the front page, and the section menu
//
// The expression box uses the compiler in model/custom.js, the same one tools/custom.mjs uses to write
// src/Custom_Unit.sv; the measured bars come from running programs/23_custom_instructions.s on the model.
// =============================================================================
import { parse, evaluate, toVerilog, cost, depth, DEPTH_BUDGET, CUSTOM_OPCODE } from '../model/custom.js';
import { assemble } from '../model/asm.js';
import { Core, CONFIGS } from '../model/core.js';
import { PROGRAMS } from '../web/programs.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const u64 = x => BigInt.asUintN(64, x), s64 = x => BigInt.asIntN(64, x);

// ---------------------------------------------------------------- the section menu closes like a menu
const more = document.querySelector('.navmore');
if (more) {
  more.addEventListener('click', e => { if (e.target.closest('a')) more.open = false; });
  document.addEventListener('click', e => { if (more.open && !more.contains(e.target)) more.open = false; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && more.open) { more.open = false; more.querySelector('summary').focus(); } });
}

// ---------------------------------------------------------------- invent an instruction
const IDEAS = [
  ['absolute difference', 'a > b ? a - b : b - a'],
  ['saturating add', 'a > ~b ? -1 : a + b'],
  ['bits that differ', 'popcount(a ^ b)'],
  ['Gray code', 'a ^ (a >> 1)'],
  ['select (Zicond)', 'b == 0 ? 0 : a'],
  ['two-byte dot product', 'sext8(a) * sext8(b) + sext8(a >> 8) * sext8(b >> 8)'],
];
const num = s => { s = String(s).trim().replace(/_/g, ''); if (!s) return 0n; try { return u64(BigInt(s)); } catch { return null; } };
const FIELDS = [['funct7', 31, 25, 'D'], ['rs2', 24, 20, 'F2'], ['rs1', 19, 15, 'E'], ['funct3', 14, 12, 'D'], ['rd', 11, 7, 'M'], ['opcode', 6, 0, 'F1']];
function renderTry() {
  const src = $('ws-expr').value, a = num($('ws-a').value), b = num($('ws-b').value);
  let ast;
  try { ast = parse(src, 'R'); $('ws-err').textContent = ''; $('ws-expr').removeAttribute('aria-invalid'); }
  catch (e) { $('ws-err').textContent = e.message; $('ws-expr').setAttribute('aria-invalid', 'true'); return; }
  if (a === null || b === null) { $('ws-err').textContent = 'a and b are whole numbers: 42, -7, 0xff or 0b1010.'; return; }
  const r = evaluate(ast, a, b);
  $('ws-out').innerHTML = `<span class="k">myop a0, a1, a2 &rarr; a0 =</span><strong>${s64(r)}</strong><code>0x${r.toString(16).padStart(16, '0')}</code>`;
  const word = ((0 << 25) | (12 << 20) | (11 << 15) | (2 << 12) | (10 << 7) | CUSTOM_OPCODE) >>> 0;
  $('ws-word').innerHTML = FIELDS.map(([n, hi, lo, c]) => `<span style="--c:var(--${c});flex:${hi - lo + 1}"><b>${((word >>> lo) & (2 ** (hi - lo + 1) - 1)).toString(2).padStart(hi - lo + 1, '0')}</b><i>${n}</i></span>`).join('');
  const used = new Set(), sv = toVerilog(ast, used), k = cost(ast);
  const parts = Object.entries(k).filter(([, n]) => n).map(([key, n]) => `${n} ${key.replace(/s$/, n === 1 ? '' : 's').replace('logic', 'logic gate').replace('muxe', 'multiplexer')}`);
  const dp = depth(ast);
  $('ws-sv').textContent = `// in src/Custom_Unit.sv (make custom writes it)\n| ({64{SELECT[k]}} & ${sv})\n// hardware: ${parts.join(', ') || 'only wires'}\n// longest path: about ${dp.toFixed(1)} adder delays: ${dp <= DEPTH_BUDGET ? 'fits in one cycle' : 'would slow the clock'}`;
}
if ($('ws-try')) {
  $('ws-ideas').innerHTML = IDEAS.map(([label, e]) => `<button type="button" data-e="${esc(e)}">${esc(label)}</button>`).join('');
  $('ws-ideas').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { $('ws-expr').value = b.dataset.e; renderTry(); } });
  ['ws-expr', 'ws-a', 'ws-b'].forEach(id => $(id).addEventListener('input', renderTry));
  renderTry();
  // measured: the plain code against the custom instruction, on the model (performance build)
  const measure = () => {
    const src = PROGRAMS['23_custom_instructions'];
    if (!src) return;
    const core = new Core(assemble(src), CONFIGS.performance);
    core.run(100000);
    const r = n => Number(core.regs[n]);
    const rows = [['Sum of absolute differences, 8 pairs', r(14), r(15), 'absdiff'], ['Hamming distance of two words', r(16), r(17), 'hamming']];
    $('ws-bars').innerHTML = rows.map(([label, plain, custom, op]) => `<div class="ws-bar"><p>${label}</p>
      <div><span class="lab">RV64I</span><i style="width:${100}%"></i><b>${plain} cycles</b></div>
      <div class="c"><span class="lab"><code>${op}</code></span><i style="width:${(100 * custom / plain).toFixed(1)}%"></i><b>${custom} cycles, ${(plain / custom).toFixed(1)}x faster</b></div></div>`).join('');
  };
  new IntersectionObserver((es, o) => { if (es[0].isIntersecting) { o.disconnect(); measure(); } }, { rootMargin: '300px' }).observe($('ws-bars'));
}

// ---------------------------------------------------------------- downloads: the latest release's files
const REPO = (() => {
  if (location.hostname.endsWith('github.io')) {
    const owner = location.hostname.split('.')[0], repo = location.pathname.split('/').filter(Boolean)[0];
    if (repo) return [owner, repo];
  }
  return ['Normansrule', 'sixfold-cpu'];
})();
const releases = `https://github.com/${REPO[0]}/${REPO[1]}/releases/latest`;
document.querySelectorAll('[data-repo-releases]').forEach(a => { a.href = releases; });
const myOS = /Windows/i.test(navigator.userAgent) ? 'windows' : /Mac/i.test(navigator.userAgent) ? 'mac' : /Linux|X11/i.test(navigator.userAgent) ? 'linux' : null;
if (myOS) document.querySelector(`.dl-card[data-os="${myOS}"]`)?.classList.add('mine');
if ($('dl-grid')) {
  new IntersectionObserver(async (es, o) => {
    if (!es[0].isIntersecting) return;
    o.disconnect();
    try { // public, no key: 60 requests an hour per visitor, which is plenty for one look
      const res = await fetch(`https://api.github.com/repos/${REPO[0]}/${REPO[1]}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(res.status);
      const rel = await res.json(), assets = rel.assets || [];
      const pick = re => assets.find(x => re.test(x.name));
      const files = { windows: pick(/setup.*\.exe$|\.exe$/i), mac: pick(/arm64.*\.dmg$|\.dmg$/i), linux: pick(/\.AppImage$/i) };
      for (const [os, f] of Object.entries(files)) {
        const card = document.querySelector(`.dl-card[data-os="${os}"]`);
        if (card && f) { card.href = f.browser_download_url; card.querySelector('.dl-file').textContent = `${f.name} · ${(f.size / 1048576).toFixed(0)} MB`; }
      }
      $('dl-note').insertAdjacentHTML('afterbegin', `Release <a href="${esc(rel.html_url)}">${esc(rel.tag_name)}</a>, with every file and its notes. `);
    } catch { /* no release yet, or offline: the cards link to the releases page */ }
  }, { rootMargin: '300px' }).observe($('dl-grid'));
}
