// =============================================================================
// site/extras.js: the "Bit tricks" lab (Zba / Zbb), the Wallace-tree multiplier
// explorer and the animation showcase on the front page.
//
// Every result is computed by the same model code the regression checks against
// the RTL (model/core.js: aluDecode, control, prepareA/B, alu), so what you see
// here is exactly what the SystemVerilog does.
// =============================================================================
import { encode, BY_NAME } from '../model/isa.js';
import { control, prepareA, prepareB, alu, LATE_OPS } from '../model/core.js';

const $ = id => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const u64 = x => BigInt.asUintN(64, x);
const hex = v => '0x' + u64(v).toString(16).padStart(16, '0').replace(/(.{4})(?=.)/g, '$1_');

function parseValue(s) {
  s = String(s).trim().replace(/_/g, '');
  if (!s) return 0n;
  try { return u64(BigInt(s.startsWith('-') ? s : s)); } catch { return null; }
}

// ---------------------------------------------------------------- Bit tricks lab
const OPS = [
  // name, needs B, what it teaches
  ['clz', false, 'Count Leading Zeros: how many 0 bits sit above the highest 1. A 6-level tree in hardware (src/Leading_Zero_Counter.sv).'],
  ['ctz', false, 'Count Trailing Zeros: the same tree on the mirror image of the bits.'],
  ['cpop', false, 'Population count: the number of 1 bits. A tree of small adders, deeper than the 64-bit adder, so Sixfold gives it 2 cycles.'],
  ['rev8', false, 'Reverse the 8 bytes: converts between little-endian and big-endian (network byte order) in one instruction.'],
  ['orc.b', false, 'Every nonzero byte becomes 0xFF: find the 0 byte that ends a string, 8 bytes at a time (see programs/18_bit_tricks.s).'],
  ['sext.b', false, 'Sign-extend the low byte to 64 bits.'],
  ['sext.h', false, 'Sign-extend the low 16 bits.'],
  ['zext.h', false, 'Zero-extend the low 16 bits.'],
  ['clzw', false, 'Leading zeros of the low 32 bits only.'],
  ['cpopw', false, 'Population count of the low 32 bits.'],
  ['rol', true, 'Rotate left by B[5:0]: bits that fall off the top come back at the bottom.'],
  ['ror', true, 'Rotate right by B[5:0].'],
  ['andn', true, 'A AND NOT B: clear the bits that are set in B (DECODE inverts B, the ALU does a plain AND).'],
  ['orn', true, 'A OR NOT B.'],
  ['xnor', true, 'NOT (A XOR B): 1 wherever the two values agree.'],
  ['min', true, 'The smaller of A and B, as signed numbers (the ALU\'s subtractor decides; 2-cycle result).'],
  ['max', true, 'The larger, signed.'],
  ['minu', true, 'The smaller, unsigned.'],
  ['maxu', true, 'The larger, unsigned.'],
  ['sh1add', true, 'B + (A << 1): address of element A in an array of 2-byte items starting at B (Zba).'],
  ['sh2add', true, 'B + (A << 2): 4-byte items (int).'],
  ['sh3add', true, 'B + (A << 3): 8-byte items (long, pointer). DECODE shifts A, the ALU only adds.'],
  ['bset', true, 'Set bit B[5:0] of A (Zbs). A 6-to-64 decoder makes the single 1, then an OR.'],
  ['bclr', true, 'Clear bit B[5:0] of A: AND with everything but that bit.'],
  ['binv', true, 'Flip bit B[5:0] of A: XOR with the single 1.'],
  ['bext', true, 'Read bit B[5:0] of A as 0 or 1 (the right shifter brings it down to bit 0).'],
];

function bitGrid(v, cls = '', mark = () => '') {
  let h = `<div class="bgrid ${cls}">`;
  for (let byte = 7; byte >= 0; byte--) {
    h += `<div class="bbyte" data-byte="${byte}" style="--sx:${2 * byte - 7}">`;
    for (let b = 7; b >= 0; b--) {
      const i = byte * 8 + b, bit = (v >> BigInt(i)) & 1n;
      h += `<i class="${bit ? 'one' : ''} ${mark(i, bit)}" style="--i:${63 - i}" title="bit ${i}">${bit}</i>`;
    }
    h += `<small>${byte}</small></div>`;
  }
  return h + '</div>';
}

function runBitOp() {
  const name = $('bt-op').value;
  const [, needsB, teach] = OPS.find(o => o[0] === name);
  const A = parseValue($('bt-a').value), B = parseValue($('bt-b').value);
  $('bt-b-wrap').classList.toggle('dim', !needsB);
  $('bt-b').disabled = !needsB;
  if (A === null || (needsB && B === null)) { $('bt-out').innerHTML = '<p class="small">Type a number: decimal, negative, or hex (0x...).</p>'; return; }
  const word = encode(name, { rd: 10, rs1: 11, rs2: 12 });
  const c = control(word);
  const a = prepareA(A, c), b = prepareB(B, c);
  const r = alu(a, b, c.aluOp, c.isWord);
  const late = LATE_OPS.has(c.aluOp);
  let markA = () => '', markR = () => '', extra = '';
  if (name === 'clz' || name === 'clzw') {
    const top = name === 'clzw' ? 31 : 63;
    markA = i => (i <= top && i > top - Number(r)) ? 'lz' : (name === 'clzw' && i > 31 ? 'off' : '');
  } else if (name === 'ctz') {
    markA = i => i < Number(r) ? 'lz' : '';
  } else if (name === 'cpop' || name === 'cpopw') {
    markA = (i, bit) => bit && (name === 'cpop' || i < 32) ? 'pop' : (name === 'cpopw' && i > 31 ? 'off' : '');
    // src/Population_Count.sv: nibble lookups and quarter counts in EXECUTE, the total in MEMORY
    const width = name === 'cpopw' ? 32 : 64, bitOf = i => Number((A >> BigInt(i)) & 1n);
    const nibbles = []; for (let n = 0; n < width / 4; n++) nibbles.push(bitOf(4 * n) + bitOf(4 * n + 1) + bitOf(4 * n + 2) + bitOf(4 * n + 3));
    const quarters = []; for (let q = 0; q < width / 16; q++) quarters.push(nibbles.slice(4 * q, 4 * q + 4).reduce((x, y) => x + y, 0));
    const rows = [[`EXECUTE: ${nibbles.length} nibble counts (one lookup each)`, nibbles], [`EXECUTE: ${quarters.length} quarter counts (carry-save sums)`, quarters], ['MEMORY: the last addition', [quarters.reduce((x, y) => x + y, 0)]]];
    extra = `<div class="poptree">${rows.map(([label, row], k) => `<div class="prow" style="--k:${k}"><span>${label}</span>${row.slice().reverse().map(x => `<b>${x}</b>`).join('')}</div>`).join('')}</div>`;
  } else if (['bset', 'bclr', 'binv', 'bext'].includes(name)) {
    const pos = Number(B & 63n);
    markA = i => i === pos ? 'pop' : '';
    if (name !== 'bext') markR = i => i === pos ? 'pop' : '';
    extra = `<p class="small">Bit ${pos} (B mod 64). Every other bit of A passes straight through.</p>`;
  } else if (name === 'rev8') {
    extra = '<p class="small">Watch the bytes of A trade places: byte 7 goes to byte 0, byte 6 to byte 1, ...</p>';
  }
  const bits = x => `<code>${hex(x)}</code> <span class="dec">= ${BigInt.asIntN(64, x)}</span>`;
  $('bt-out').innerHTML = `
    <div class="bt-row"><label>A</label>${bitGrid(A, 'a', markA)}<div class="bt-val">${bits(A)}</div></div>
    ${needsB ? `<div class="bt-row"><label>B</label>${bitGrid(B, 'b')}<div class="bt-val">${bits(B)}</div></div>` : ''}
    ${c.aShift || c.aZext || c.invB || c.oneB ? `<div class="bt-note">DECODE prepared the operands: ${c.aShift ? `A &lt;&lt; ${c.aShift}` : ''}${c.aZext ? ' zext(A[31:0])' : ''}${c.oneB ? ' B = 1 &lt;&lt; B[5:0]' : ''}${c.invB ? ' B inverted' : ''} &rarr; the ALU does <b>${c.aluOp}</b></div>` : ''}
    <div class="bt-row res ${name === 'rev8' ? 'rev' : ''}"><label>${name}</label>${bitGrid(r, 'r', markR)}<div class="bt-val">${bits(r)}</div></div>
    ${extra}
    <p class="bt-teach">${teach}</p>
    <p class="small">Encoding <code>${name} a0, a1${needsB ? ', a2' : ''}</code> = <code>0x${word.toString(16).padStart(8, '0')}</code> · ALU operation <code>ALU_${c.aluOp}</code>${c.isWord ? ' (word)' : ''} · ${late ? '<b>2-cycle</b> result (forwarded from MEMORY)' : '1-cycle result (forwarded from EXECUTE)'}</p>`;
  if (!reducedMotion) {
    const out = $('bt-out');
    out.classList.remove('play'); void out.offsetWidth; out.classList.add('play');
  }
}

function setupBitLab() {
  if (!$('bt-op')) return;
  $('bt-op').innerHTML = OPS.map(([n]) => `<option>${n}</option>`).join('');
  $('bt-op').value = 'cpop';
  const chips = ['clz', 'ctz', 'cpop', 'rev8', 'orc.b', 'rol', 'andn', 'max', 'sh3add'];
  $('bt-chips').innerHTML = chips.map(n => `<button type="button" data-op="${n}">${n}</button>`).join('');
  $('bt-chips').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; $('bt-op').value = b.dataset.op; runBitOp(); });
  for (const id of ['bt-op', 'bt-a', 'bt-b']) $(id).addEventListener('input', runBitOp);
  $('bt-random').addEventListener('click', () => {
    const r = () => BigInt(Math.floor(Math.random() * 2 ** 32));
    $('bt-a').value = hex((r() << 32n | r()) >> BigInt(Math.floor(Math.random() * 24))).replace(/_/g, '');
    runBitOp();
  });
  runBitOp();
}

// ---------------------------------------------------------------- Wallace tree explorer
const W = { levels: [], k: 0, timer: null };
function wallaceLevels(A, Bm, bw) {
  const aw = Math.max(1, A.toString(2).length);
  const rows = [];
  for (let j = 0; j < bw; j++) rows.push({ v: ((Bm >> BigInt(j)) & 1n) ? A << BigInt(j) : 0n, lo: j, hi: j + aw - 1, label: `A x b${j}` });
  const levels = [rows];
  while (levels.at(-1).length > 2) {
    const p = levels.at(-1), n = [];
    for (let i = 0; i + 2 < p.length; i += 3) {
      const [x, y, z] = p.slice(i, i + 3), lo = Math.min(x.lo, y.lo, z.lo), hi = Math.max(x.hi, y.hi, z.hi);
      n.push({ v: x.v ^ y.v ^ z.v, lo, hi, label: 'sum', src: i });
      n.push({ v: ((x.v & y.v) | (x.v & z.v) | (y.v & z.v)) << 1n, lo: lo + 1, hi: hi + 1, label: 'carry', src: i });
    }
    for (let i = p.length - (p.length % 3); i < p.length; i++) n.push({ ...p[i], label: p[i].label.replace(/ \(kept\)$/, '') + ' (kept)', src: i });
    levels.push(n);
  }
  return levels;
}
function drawWallace() {
  const svg = $('wt-svg'), L = W.levels, k = W.k, rows = L[Math.min(k, L.length - 1)];
  const cols = Math.max(...L.flat().map(r => r.hi)) + 2, cell = Math.min(24, 760 / cols), right = 70 + cols * cell;
  const final = k >= L.length;
  let s = '';
  for (let c = 0; c < cols; c++) s += `<text x="${right - c * cell}" y="18" class="wt-col">${c}</text>`;
  const groups = rows.length > 2 && !final ? Math.floor(rows.length / 3) : 0;
  const shown = final ? L.at(-1) : rows;
  shown.forEach((r, i) => {
    const y = 42 + i * 30, g = i < groups * 3 ? Math.floor(i / 3) : -1;
    s += `<g class="wt-row" style="--d:${i * 40}ms">`;
    if (g >= 0) s += `<rect x="${right - r.hi * cell - cell / 2 - 4}" y="${y - 12}" width="${(r.hi - r.lo + 1) * cell + 8}" height="24" rx="12" class="wt-band g${g % 4}"/>`;
    for (let c = r.lo; c <= r.hi; c++) s += `<circle cx="${right - c * cell}" cy="${y}" r="${cell * 0.33}" class="${(r.v >> BigInt(c)) & 1n ? 'on' : ''} ${g >= 0 ? 'g' + (g % 4) : ''}"/>`;
    s += `<text x="${right + 18}" y="${y + 4}" class="wt-lab">${r.label}</text></g>`;
  });
  if (final) {
    const sum = L.at(-1)[0].v + (L.at(-1)[1]?.v ?? 0n), y = 42 + 2 * 30 + 16;
    s += `<line x1="${right - cols * cell}" x2="${right + 10}" y1="${y - 16}" y2="${y - 16}" class="wt-line"/>`;
    s += `<g class="wt-row">`;
    for (let c = 0; c < cols; c++) s += `<circle cx="${right - c * cell}" cy="${y}" r="${cell * 0.33}" class="${(sum >> BigInt(c)) & 1n ? 'on res' : 'res'}"/>`;
    s += `<text x="${right + 18}" y="${y + 4}" class="wt-lab">= ${sum}</text></g>`;
  }
  const h = 42 + Math.max(shown.length + (final ? 2 : 0), 3) * 30;
  svg.setAttribute('viewBox', `0 0 ${right + 150} ${h}`);
  svg.innerHTML = s;
  const A = BigInt($('wt-a').value || 0), B = BigInt($('wt-b').value || 0);
  $('wt-info').innerHTML = final
    ? `<b>Final add:</b> one carry-propagate adder. ${A} x ${B} = <b>${A * B}</b> ${L.at(-1)[0].v + (L.at(-1)[1]?.v ?? 0n) === A * B ? '(correct)' : '(mismatch!)'}. ${L.length - 1} levels of full adders before it.`
    : k === 0 ? `<b>Level 0:</b> ${rows.length} partial products: A shifted left by j wherever bit j of B is 1. Same colour = one row of full adders next.`
      : `<b>Level ${k}:</b> ${L[k - 1].length} rows became ${rows.length}. Sum bits stay in their column; carry bits move one column left. No carry travels further.`;
  $('wt-step').textContent = final ? 'Again' : 'Next level';
}
function wallaceReset() {
  let A = BigInt(Math.max(0, Math.min(65535, Number($('wt-a').value) || 0)));
  let B = BigInt(Math.max(0, Math.min(65535, Number($('wt-b').value) || 0)));
  W.levels = wallaceLevels(A, B, Math.max(1, B.toString(2).length)); W.k = 0; drawWallace();
}
function wallaceStep() { if (W.k >= W.levels.length) { W.k = 0; } else W.k++; drawWallace(); }
function setupWallace() {
  if (!$('wt-svg')) return;
  $('wt-a').addEventListener('input', wallaceReset); $('wt-b').addEventListener('input', wallaceReset);
  $('wt-step').addEventListener('click', wallaceStep);
  $('wt-play').addEventListener('click', () => {
    if (W.timer) { clearInterval(W.timer); W.timer = null; $('wt-play').textContent = 'Play'; return; }
    W.k = 0; drawWallace(); $('wt-play').textContent = 'Pause';
    W.timer = setInterval(() => { if (W.k >= W.levels.length) { clearInterval(W.timer); W.timer = null; $('wt-play').textContent = 'Play'; return; } wallaceStep(); }, reducedMotion ? 2400 : 1300);
  });
  wallaceReset();
}

// ---------------------------------------------------------------- animation showcase
function setupShowcase() {
  const tabs = $('show-tabs'); if (!tabs) return;
  const items = [...tabs.querySelectorAll('button')];
  const show = k => {
    items.forEach(b => b.setAttribute('aria-selected', String(b.dataset.k === k)));
    const b = items.find(x => x.dataset.k === k);
    $('show-img').src = `docs/img/animations/${k}.svg`; $('show-img').alt = b.dataset.alt; $('show-cap').textContent = b.dataset.cap;
  };
  tabs.addEventListener('click', e => { const b = e.target.closest('button'); if (b) show(b.dataset.k); });
  show('pipeline');
}

setupBitLab();
setupWallace();
setupShowcase();
