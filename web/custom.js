// =============================================================================
// web/custom.js: the instruction workshop
//
// You edit a list of custom instructions; every change is validated by model/custom.js and registered with
// model/isa.js (registerCustom), so the assembler, the disassembler and the pipeline model (model/core.js)
// know them at once. The SystemVerilog shown is exactly what `make custom` writes to src/Custom_Unit.sv.
// =============================================================================
import { parse, evaluate, cost, depth, DEPTH_BUDGET, FUNCTIONS, CUSTOM_OPCODE, verilogModule, encodeShare, decodeShare } from '../model/custom.js';
import { registerCustom, DEFAULT_CUSTOM, encode, decode, disasm, ABI } from '../model/isa.js';
import { assemble } from '../model/asm.js';
import { Core, CONFIGS } from '../model/core.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const u64 = x => BigInt.asUintN(64, x), s64 = x => BigInt.asIntN(64, x);
const hex = v => '0x' + u64(v).toString(16).padStart(16, '0').replace(/(.{4})(?=.)/g, '$1_');
const STORE_KEY = 'sixfold.custom.v1';
const clone = x => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------- ideas to start from
const IDEAS = [
  { name: 'satadd', format: 'R', expr: 'a > ~b ? -1 : a + b', desc: 'Saturating unsigned add: sticks at the maximum instead of wrapping (audio, image processing). a + b overflows exactly when a > ~b, which compares the inputs alongside the add instead of after it' },
  { name: 'czero.eqz', format: 'R', expr: 'b == 0 ? 0 : a', desc: 'a, or 0 when b is 0: a branch-free select. RISC-V later standardised exactly this as the Zicond extension' },
  { name: 'gray', format: 'R', expr: 'a ^ (a >> 1)', desc: 'Binary to Gray code, where neighbours differ in one bit (rotary encoders)' },
  { name: 'ilog2', format: 'R', expr: 'a == 0 ? 0 : clz(a) ^ 63', desc: 'Position of the highest 1 bit: the whole-number base-2 logarithm. For 0 to 63, 63 - n is n ^ 63: wires instead of a subtractor' },
  { name: 'lerp2', format: 'R', expr: 'a + ((b - a) >>> 1)', desc: 'Halfway from a to b for signed numbers (animation, filters)' },
  { name: 'dot2b', format: 'R', expr: 'sext8(a) * sext8(b) + sext8(a >> 8) * sext8(b >> 8)', desc: 'Dot product of two pairs of signed bytes: the kind of instruction machine-learning accelerators add (two multipliers: expensive)' },
  { name: 'getbyte', format: 'I', expr: 'zext8(a >> ((imm & 7) * 8))', desc: 'Byte number imm (0 to 7) of a register: a bit-field extract' },
  { name: 'addsl4', format: 'I', expr: '(a << 4) + imm', desc: 'a * 16 + imm in one step: the address of field imm of record a, when records are 16 bytes' },
  { name: 'inrange', format: 'I', expr: 'a < imm', desc: '1 if a is below imm, unsigned: a bounds check in one instruction' },
  { name: 'parity', format: 'R', expr: 'popcount(a) & 1', desc: '1 when a has an odd number of 1 bits (error detection)' },
];

// ---------------------------------------------------------------- state
let set = load(), sel = 0, lastGood = null;
function load() {
  const fromLink = location.hash.startsWith('#set=') ? decodeShare(location.hash.slice(5)) : null;
  if (fromLink && fromLink.list.length) return fromLink.list; // an empty set is no set: fall through
  try { const s = JSON.parse(localStorage.getItem(STORE_KEY)); if (Array.isArray(s) && s.length) return s; } catch { /* private window: use the examples */ }
  return clone(DEFAULT_CUSTOM);
}
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(set)); } catch { /* storage unavailable: the share link still works */ } }

// The slots a format can use, and the first one nobody else holds
const slots = format => format === 'R' ? Array.from({ length: 4 * 128 }, (_, k) => [k >> 7, k & 127]) : [4, 5, 6, 7].map(f3 => [f3, 0]);
const taken = (except) => new Set(set.filter((_, i) => i !== except).map(c => c.format === 'R' ? `R${c.funct3}:${c.funct7}` : `I${c.funct3}`));
function freeSlot(format, except = -1) {
  const t = taken(except);
  return slots(format).find(([f3, f7]) => !t.has(format === 'R' ? `R${f3}:${f7}` : `I${f3}`)) || null;
}

// ---------------------------------------------------------------- applying the set to the model
function apply() {
  const r = registerCustom(set);
  const byIndex = new Map();
  for (const e of r.errors) { if (!byIndex.has(e.index)) byIndex.set(e.index, []); byIndex.get(e.index).push(e); }
  if (r.ok) lastGood = clone(set);
  $('setstatus').textContent = r.ok
    ? `${set.length} instruction${set.length === 1 ? '' : 's'}, all valid: the assembler and the pipeline know ${set.length === 1 ? 'it' : 'them'}.`
    : `Fix the marked instruction${byIndex.size > 1 ? 's' : ''} first: until then the pipeline uses your last valid set.`;
  $('setstatus').className = 'setstatus ' + (r.ok ? 'ok' : 'bad');
  return { ok: r.ok, byIndex };
}

// ---------------------------------------------------------------- rendering
function renderSet(byIndex) {
  $('set').innerHTML = set.map((c, i) => `<li><button type="button" data-i="${i}" aria-current="${i === sel}" class="${byIndex.has(i) ? 'bad' : ''}">
    <span class="nm">${esc(c.name || '(no name)')}</span><span class="fm">${c.format}${c.format === 'R' ? ` ${c.funct3}/${c.funct7}` : ` ${c.funct3}`}</span>
    <code>${esc(c.expr || '')}</code></button></li>`).join('');
}

function renderEditor(byIndex) {
  const c = set[sel];
  const busy = document.activeElement;
  $('ed-name').textContent = c.name || 'instruction';
  if (busy !== $('f-name')) $('f-name').value = c.name;
  if (busy !== $('f-expr')) $('f-expr').value = c.expr;
  if (busy !== $('f-desc')) $('f-desc').value = c.desc || '';
  document.querySelectorAll('input[name=fmt]').forEach(r => { r.checked = r.value === c.format; });
  const t = taken(sel);
  $('f-funct3').innerHTML = (c.format === 'R' ? [0, 1, 2, 3] : [4, 5, 6, 7]).map(f3 => {
    const full = c.format === 'I' ? t.has(`I${f3}`) : Array.from({ length: 128 }, (_, f7) => t.has(`R${f3}:${f7}`)).every(Boolean);
    return `<option value="${f3}" ${full ? 'disabled' : ''}>${f3} (${f3.toString(2).padStart(3, '0')})${full ? ', taken' : ''}</option>`;
  }).join('');
  $('f-funct3').value = c.funct3;
  $('f7wrap').hidden = c.format !== 'R';
  if (c.format === 'R') {
    $('f-funct7').innerHTML = Array.from({ length: 128 }, (_, f7) => { const used = t.has(`R${c.funct3}:${f7}`); return `<option value="${f7}" ${used ? 'disabled' : ''}>${f7}${used ? ', taken' : ''}</option>`; }).join('');
    $('f-funct7').value = c.funct7;
  }
  const errs = byIndex.get(sel) || [];
  const exprErr = errs.find(e => e.field === 'expr');
  $('f-err').textContent = exprErr ? exprErr.message : '';
  $('f-expr').setAttribute('aria-invalid', String(!!exprErr));
  $('fieldmsg').textContent = errs.filter(e => e.field !== 'expr').map(e => e.message).join(' · ');
  $('remove').disabled = set.length <= 1;
  $('t-bl').firstChild.textContent = c.format === 'R' ? 'rs2 (b) ' : 'immediate (imm, -2048 to 2047) ';
  const vars = c.format === 'R' ? ['a', 'b'] : ['a', 'imm'];
  $('palette').innerHTML = [...vars, ...Object.keys(FUNCTIONS).map(f => `${f}(`)].map(v => `<button type="button" class="tok" data-ins="${v}" title="${esc(FUNCTIONS[v.replace('(', '')]?.[2] || (v === 'a' ? 'rs1' : v === 'b' ? 'rs2' : 'the sign-extended 12-bit immediate'))}">${esc(v)}</button>`).join('');
}

function renderEncoding() {
  const c = set[sel];
  let word;
  try {
    const f = c.format === 'R' ? { rd: 10, rs1: 11, rs2: 12 } : { rd: 10, rs1: 11, imm: 42 };
    word = c.format === 'R'
      ? ((c.funct7 << 25) | (12 << 20) | (11 << 15) | (c.funct3 << 12) | (10 << 7) | CUSTOM_OPCODE) >>> 0
      : ((42 << 20) | (11 << 15) | (c.funct3 << 12) | (10 << 7) | CUSTOM_OPCODE) >>> 0;
    if (lastGood && lastGood.some(x => x.name === c.name)) word = encode(c.name, f);
  } catch { word = 0; }
  const asm = c.format === 'R' ? `${c.name} a0, a1, a2` : `${c.name} a0, a1, 42`;
  $('enc-asm').textContent = asm;
  const fields = c.format === 'R'
    ? [['funct7', 31, 25, 'with funct3: which one'], ['rs2', 24, 20, 'a2 = x12'], ['rs1', 19, 15, 'a1 = x11'], ['funct3', 14, 12, '0-3: R'], ['rd', 11, 7, 'a0 = x10'], ['opcode', 6, 0, 'custom-0']]
    : [['imm[11:0]', 31, 20, '42'], ['rs1', 19, 15, 'a1 = x11'], ['funct3', 14, 12, '4-7: I'], ['rd', 11, 7, 'a0 = x10'], ['opcode', 6, 0, 'custom-0']];
  $('enc-bits').innerHTML = fields.map(([n, hi, lo, what]) => {
    const bits = ((word >>> lo) & ((2 ** (hi - lo + 1)) - 1)).toString(2).padStart(hi - lo + 1, '0');
    return `<div class="bf f-${n.replace(/\W.*/, '')}" style="flex:${hi - lo + 1}"><span class="bn">${n}</span><span class="bb">${bits}</span><span class="bw">${esc(what)}</span></div>`;
  }).join('');
  $('enc-hex').textContent = '0x' + word.toString(16).padStart(8, '0') + (lastGood && lastGood.some(x => x.name === c.name) ? `  ·  disassembles as: ${disasm(decode(word))}` : '');
}

function num(s) {
  s = String(s).trim().replace(/_/g, '');
  if (!s) return 0n;
  try { return u64(BigInt(s)); } catch { return null; }
}
function renderTry() {
  const c = set[sel];
  let ast = null;
  try { ast = parse(c.expr, c.format); } catch { /* shown in the editor */ }
  const a = num($('t-a').value);
  let b = num($('t-b').value);
  if (c.format === 'I' && b !== null) { const v = s64(b); b = v < -2048n || v > 2047n ? null : u64(v); }
  $('t-a').setAttribute('aria-invalid', String(a === null));
  $('t-b').setAttribute('aria-invalid', String(b === null));
  if (!ast) { $('t-out').innerHTML = '<p class="hint">Fix the expression to see results.</p>'; $('t-edges').innerHTML = ''; return; }
  if (a === null || b === null) { $('t-out').innerHTML = `<p class="experr">${a === null ? 'rs1' : c.format === 'R' ? 'rs2' : 'The immediate'} must be a whole number${c.format === 'I' && a !== null ? ' from -2048 to 2047' : ''} (decimal, 0x hex or 0b binary).</p>`; return; }
  const r = evaluate(ast, a, b);
  $('t-out').innerHTML = `<dl class="res"><dt>rd</dt><dd><b>${s64(r)}</b> <span class="sub">signed</span></dd><dd>${r} <span class="sub">unsigned</span></dd><dd><code>${hex(r)}</code></dd></dl>`;
  const edgeA = [0n, 1n, u64(-1n), 0x7fffffffffffffffn, 0x8000000000000000n];
  const edgeB = c.format === 'R' ? [0n, 1n, u64(-1n), 0x8000000000000000n] : [0n, 1n, u64(-1n), 2047n, u64(-2048n)];
  // small values as signed numbers; large ones by name, or as a short hexadecimal with the middle left out
  const NAMED = new Map([[0x7fffffffffffffffn, 'max'], [0x8000000000000000n, 'min']]);
  const show = v => { v = u64(v); const s = s64(v); if (s > -100000n && s < 100000n) return String(s); if (NAMED.has(v)) return NAMED.get(v); const h = v.toString(16).padStart(16, '0'); return `0x${h.slice(0, 4)}…${h.slice(-4)}`; };
  $('t-edges').innerHTML = `<caption>Edge cases: max and min are the largest and smallest signed 64-bit numbers</caption><tr><th scope="col">${c.format === 'R' ? 'a \\ b' : 'a \\ imm'}</th>${edgeB.map(x => `<th scope="col">${show(x)}</th>`).join('')}</tr>` +
    edgeA.map(x => `<tr><th scope="row">${show(x)}</th>${edgeB.map(y => `<td>${show(evaluate(ast, x, y))}</td>`).join('')}</tr>`).join('');
}

const COST_WORDS = {
  adders: ['adder', 'adders', 'a 64-bit add or subtract: about 400 gates in a fast (parallel prefix) design'],
  multipliers: ['multiplier', 'multipliers', 'a 64 x 64-bit multiply: thousands of gates, the biggest thing you can ask for here'],
  shifters: ['shifter', 'shifters', 'a variable shift or rotate: 6 levels of 64 multiplexers'],
  comparators: ['comparator', 'comparators', 'a compare: a subtractor\'s carry chain'],
  counters: ['bit counter', 'bit counters', 'clz, ctz or popcount: a tree of small adders'],
  logic: ['logic operation', 'logic operations', 'AND, OR, XOR, NOT: one gate per bit'],
  muxes: ['multiplexer', 'multiplexers', 'choosing between two values: one 2-to-1 multiplexer per bit'],
};
function renderCost() {
  const c = set[sel];
  let ast = null;
  try { ast = parse(c.expr, c.format); } catch { /* shown in the editor */ }
  if (!ast) { $('cost').innerHTML = ''; return; }
  const k = cost(ast), rows = Object.entries(k).filter(([, n]) => n > 0);
  $('cost').innerHTML = rows.length
    ? `<ul>${rows.map(([key, n]) => `<li><b>${n} ${COST_WORDS[key][n === 1 ? 0 : 1]}</b> <span class="sub">${COST_WORDS[key][2]}</span></li>`).join('')}</ul>` +
      (k.multipliers ? '<p class="warn">A multiplier this size will not fit in one cycle at Sixfold\'s clock on silicon: a real design would make it take several cycles, like the M extension does.</p>' : '')
    : '<p>Only wires: the result is one of the inputs or a constant.</p>';
  // the longest path, in the time of one 64-bit add: what decides whether Sixfold's clock must slow down
  const dp = depth(ast), pct = Math.min(100, 100 * dp / (2 * DEPTH_BUDGET)), fits = dp <= DEPTH_BUDGET;
  $('cost').insertAdjacentHTML('beforeend', `<div class="depth ${fits ? 'ok' : 'slow'}"><p><b>Longest path: about ${dp.toFixed(1)} adder delays</b> (the budget is ${DEPTH_BUDGET})</p>
    <div class="meter" role="img" aria-label="${dp.toFixed(1)} of ${DEPTH_BUDGET} adder delays"><i style="width:${pct}%"></i><span style="left:50%"></span></div>
    <p class="sub">${fits ? 'Fits in the MEMORY cycle the custom unit has to itself: the clock stays where it is.' : 'Longer than the cycle: on silicon the whole processor would run slower. Look for steps that wait for each other and compute them side by side instead (compare the inputs directly, then choose).'}</p></div>`);
}

function renderVerilog() {
  try { $('sv').textContent = verilogModule((lastGood || set).map(c => ({ ...c, name: c.name.toLowerCase() }))); }
  catch (e) { $('sv').textContent = `// ${e.message}`; }
}

function render() {
  const { byIndex } = apply();
  renderSet(byIndex); renderEditor(byIndex); renderEncoding(); renderTry(); renderCost(); renderVerilog();
  history.replaceState(null, '', location.pathname + location.search);
  save();
}

// ---------------------------------------------------------------- the program
function sampleProgram() {
  const c = set[sel];
  const a = num($('t-a').value) ?? 200n, b = num($('t-b').value) ?? 0n;
  let expected = '';
  try { expected = String(s64(evaluate(parse(c.expr, c.format), a, c.format === 'I' ? u64(BigInt.asIntN(12, b)) : b))); } catch { /* invalid */ }
  const imm = c.format === 'I' ? Number(BigInt.asIntN(12, b)) : 0;
  return `# A test of ${c.name}${c.desc ? ': ' + c.desc : ''}
    li   a1, ${s64(a)}
${c.format === 'R' ? `    li   a2, ${s64(b)}\n    ${c.name} a0, a1, a2` : `    ${c.name} a0, a1, ${imm}`}${expected ? `       # a0 should be ${expected}` : ''}
    addi a3, a0, 1           # needs a0 right away: waits two cycles (custom logic runs in MEMORY)
    halt
`;
}
function runProgram() {
  $('p-err').textContent = ''; $('p-out').innerHTML = '';
  let img;
  try { img = assemble($('p-src').value); } catch (e) { $('p-err').textContent = e.message; return; }
  const core = new Core(img, CONFIGS.performance);
  core.run(200000);
  const st = core.stats, b = st.bubbles;
  const regs = [10, 11, 12, 13, 14, 15, 16, 17].map(r => `<tr><th scope="row">${ABI[r]}</th><td>${s64(core.regs[r])}</td><td><code>${hex(core.regs[r])}</code></td></tr>`).join('');
  $('p-out').innerHTML = `<p class="pstat"><b>${st.cycles.toLocaleString('en-US')}</b> cycles · <b>${st.retired.toLocaleString('en-US')}</b> instructions · CPI ${(st.cycles / Math.max(1, st.retired)).toFixed(2)} · ${st.loadStalls} cycle${st.loadStalls === 1 ? '' : 's'} waiting for loads and late results · ${b.imiss + b.dmiss} for cache misses${core.halted ? '' : ' · <b>did not finish in 200,000 cycles</b>'}</p>
    <table class="regs"><caption>Registers a0 to a7 at the end</caption>${regs}</table>${core.output ? `<p>Printed: <code>${esc(core.output)}</code></p>` : ''}`;
  $('p-lab').href = `index.html#${encodeShare(set, $('p-src').value)}`;
}

// ---------------------------------------------------------------- wiring
const edit = (fn) => { fn(set[sel]); render(); };
$('set').addEventListener('click', e => { const b = e.target.closest('button[data-i]'); if (b) { sel = Number(b.dataset.i); render(); } });
$('f-name').addEventListener('input', e => edit(c => { c.name = e.target.value.trim().toLowerCase(); }));
$('f-expr').addEventListener('input', e => edit(c => { c.expr = e.target.value; }));
$('f-desc').addEventListener('input', e => edit(c => { c.desc = e.target.value; }));
document.querySelectorAll('input[name=fmt]').forEach(r => r.addEventListener('change', () => edit(c => {
  const slot = freeSlot(r.value, sel);
  if (!slot) { $('fieldmsg').textContent = `No free ${r.value}-format slot left.`; return; }
  c.format = r.value; [c.funct3, c.funct7] = slot;
  if (c.format === 'I') { delete c.funct7; c.expr = c.expr.replace(/\b(b|rs2)\b/g, 'imm'); } else c.expr = c.expr.replace(/\bimm\b/g, 'b');
})));
$('f-funct3').addEventListener('change', e => edit(c => {
  c.funct3 = Number(e.target.value);
  if (c.format === 'R') { const t = taken(sel); c.funct7 = Array.from({ length: 128 }, (_, f7) => f7).find(f7 => !t.has(`R${c.funct3}:${f7}`)) ?? 0; }
}));
$('f-funct7').addEventListener('change', e => edit(c => { c.funct7 = Number(e.target.value); }));
$('palette').addEventListener('click', e => {
  const b = e.target.closest('[data-ins]'); if (!b) return;
  const ta = $('f-expr'), s = ta.selectionStart ?? ta.value.length, t = ta.selectionEnd ?? s, ins = b.dataset.ins;
  ta.value = ta.value.slice(0, s) + ins + ta.value.slice(t);
  ta.focus(); ta.setSelectionRange(s + ins.length, s + ins.length);
  edit(c => { c.expr = ta.value; });
});
$('add').addEventListener('click', () => {
  const slot = freeSlot('R') || freeSlot('I');
  if (!slot || set.length >= 32) { $('setstatus').textContent = 'The set is full (32 instructions).'; return; }
  let n = 1; while (set.some(c => c.name === `myop${n}`)) n++;
  set.push(slot[0] < 4 ? { name: `myop${n}`, format: 'R', funct3: slot[0], funct7: slot[1], expr: 'a + b', desc: '' } : { name: `myop${n}`, format: 'I', funct3: slot[0], expr: 'a + imm', desc: '' });
  sel = set.length - 1; render(); $('f-expr').focus(); $('f-expr').select();
});
IDEAS.forEach((x, i) => $('ideas').add(new Option(`${x.name}: ${x.expr}`, i)));
$('ideas').addEventListener('change', e => {
  const x = IDEAS[Number(e.target.value)]; e.target.value = '';
  if (!x) return;
  let name = x.name, n = 2; while (set.some(c => c.name === name)) name = `${x.name}${n++}`;
  const slot = freeSlot(x.format);
  if (!slot || set.length >= 32) { $('setstatus').textContent = `No free ${x.format}-format slot left.`; return; }
  set.push({ ...x, name, funct3: slot[0], ...(x.format === 'R' ? { funct7: slot[1] } : {}) });
  sel = set.length - 1; render();
});
$('remove').addEventListener('click', () => { if (set.length > 1) { set.splice(sel, 1); sel = Math.max(0, sel - 1); render(); } });
$('reset').addEventListener('click', () => { if (confirm('Replace your instruction set with Sixfold\'s four examples?')) { set = clone(DEFAULT_CUSTOM); sel = 0; render(); } });
$('download').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ about: 'Sixfold custom instructions (opcode custom-0). Save as custom/instructions.json, then run make custom and make test.', instructions: set }, null, 2) + '\n'], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'instructions.json' });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('import').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const j = JSON.parse(await f.text()), list = Array.isArray(j) ? j : j.instructions;
    if (!Array.isArray(list) || !list.length) throw new Error('no "instructions" list in that file');
    set = list.map(c => ({ name: String(c.name || ''), format: c.format === 'I' ? 'I' : 'R', funct3: Number(c.funct3) || 0, ...(c.format === 'I' ? {} : { funct7: Number(c.funct7) || 0 }), expr: String(c.expr || ''), desc: String(c.desc || '') }));
    sel = 0; render();
  } catch (err) { $('setstatus').textContent = `Could not import: ${err.message}`; $('setstatus').className = 'setstatus bad'; }
});
$('share').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}#set=${encodeShare(set)}`;
  try { await navigator.clipboard.writeText(url); $('share').textContent = 'Link copied'; }
  catch { prompt('Copy this link:', url); }
  setTimeout(() => { $('share').textContent = 'Copy share link'; }, 1800);
});
$('sv-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('sv').textContent); $('sv-copy').textContent = 'Copied'; } catch { /* select it instead */ getSelection().selectAllChildren($('sv')); }
  setTimeout(() => { $('sv-copy').textContent = 'Copy'; }, 1500);
});
['t-a', 't-b'].forEach(id => $(id).addEventListener('input', renderTry));
$('p-run').addEventListener('click', runProgram);
$('p-sample').addEventListener('click', () => { $('p-src').value = sampleProgram(); runProgram(); });

render();
$('p-src').value = sampleProgram();
runProgram();
