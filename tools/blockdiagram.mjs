#!/usr/bin/env node
// =============================================================================
// tools/blockdiagram.mjs: draws docs/img/cpu_block_diagram.svg
//
// The datapath of src/Riscv64.sv with the module and signal names of the RTL:
// every pipeline register, mux, unit and feedback path, colour-coded by what
// kind of signal it carries.
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';

const FONT = "font-family=\"'IBM Plex Sans','Segoe UI',Helvetica,Arial,sans-serif\"";
const MONO = "font-family=\"'IBM Plex Mono',Consolas,monospace\"";
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const COL = {
  ink: '#17251D', sub: '#4A5A50', paper: '#FBFCF8', box: '#FFFFFF', edge: '#2B3A31',
  data: '#2B3A31', fwdE: '#E08E0B', fwdM: '#27AE60', fwdW: '#C0392B', flush: '#C2185B', redirect: '#17A2B8',
  pred: '#00796B', hold: '#B8860B', ctrl: '#6A4FC8',
  FETCH1: '#2E86C1', FETCH2: '#17A2B8', DECODE: '#6A5ACD', EXECUTE: '#E08E0B', MEMORY: '#27AE60', WRITEBACK: '#C0392B',
};

export function blockDiagramSVG() {
  const W = 1840, H = 1024;
  const out = [];
  const add = s => out.push(s);
  const kinds = ['data', 'fwdE', 'fwdM', 'fwdW', 'flush', 'redirect', 'pred', 'hold', 'ctrl'];
  const markers = kinds.map(k => `<marker id="a-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${COL[k]}"/></marker>`).join('');
  const text = (x, y, s, { size = 12, weight = 400, fill = COL.ink, anchor = 'start', mono = false } = {}) =>
    add(`<text x="${x}" y="${y}" ${mono ? MONO : FONT} font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`);
  const box = (x, y, w, h, title, sub = [], { fill = COL.box, stroke = COL.edge, tsize = 13, mod = null } = {}) => {
    add(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${fill}" stroke="${stroke}" stroke-width="1.6"/>`);
    text(x + w / 2, y + 18, title, { size: tsize, weight: 600, anchor: 'middle' });
    if (mod) text(x + w / 2, y + 32, mod, { size: 9.5, fill: COL.ctrl, anchor: 'middle', mono: true });
    sub.forEach((s, i) => text(x + w / 2, y + (mod ? 47 : 34) + i * 13.5, s, { size: 10.5, fill: COL.sub, anchor: 'middle' }));
  };
  const wire = (pts, kind = 'data', { width = 2, dash = null, arrow = true } = {}) => {
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ');
    add(`<path d="${d}" fill="none" stroke="${COL[kind]}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-linejoin="round"${arrow ? ` marker-end="url(#a-${kind})"` : ''}/>`);
  };
  const dot = (x, y, kind = 'data') => add(`<circle cx="${x}" cy="${y}" r="3.2" fill="${COL[kind]}"/>`);
  const mux = (x, y, w, h, label, inputs = []) => {
    add(`<polygon points="${x},${y} ${x + w},${y + h * 0.2} ${x + w},${y + h * 0.8} ${x},${y + h}" fill="#F3F5F0" stroke="${COL.edge}" stroke-width="1.6"/>`);
    if (label) text(x + w / 2, y - 6, label, { size: 9.5, fill: COL.sub, anchor: 'middle' });
    inputs.forEach(([yy, s]) => text(x + 3, yy + 3.5, s, { size: 8, fill: COL.sub, mono: true }));
  };
  const lbl = (x, y, s, kind = 'data', anchor = 'start') => text(x, y, s, { size: 9.5, fill: kind === 'data' ? COL.sub : COL[kind], anchor, mono: true });

  add(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`);
  add(`<defs>${markers}</defs>`);
  add(`<rect width="100%" height="100%" rx="12" fill="${COL.paper}" stroke="#D5DBD0"/>`);
  text(20, 28, 'Sixfold (src/Riscv64.sv): 6-stage RV64IM + B (Zba Zbb Zbs) + Zicsr + Zifencei pipeline with caches, BTB + tournament prediction, RAS, forwarding into DECODE, traps and interrupts', { size: 17, weight: 600 });

  // ---------------------------------------------------------------- stage bands
  const stages = [
    ['FETCH1', 20, 300, 'PC, I-cache, BTB, predictors'], ['FETCH2', 330, 560, 'predecode + redirect'], ['DECODE', 590, 900, 'control, registers, forwarding'],
    ['EXECUTE', 930, 1300, 'compute + resolve branches'], ['MEMORY', 1330, 1580, 'load data'], ['WRITEBACK', 1610, 1820, 'retire'],
  ];
  for (const [n, x0, x1, sub] of stages) {
    add(`<rect x="${x0}" y="44" width="${x1 - x0}" height="34" rx="6" fill="${COL[n]}"/>`);
    text(x0 + 10, 66, n, { size: 14, weight: 700, fill: '#FFF' });
    text(x1 - 8, 66, sub, { size: 10.5, fill: '#FFF', anchor: 'end' });
    add(`<rect x="${x0}" y="84" width="${x1 - x0}" height="672" rx="4" fill="${COL[n]}" fill-opacity="0.05"/>`);
  }
  const regs = [[310, 'FETCH2_*'], [570, 'DECODE_*'], [910, 'EXECUTE_*'], [1310, 'MEMORY_*'], [1590, 'WRITEBACK_*']];
  for (const [x, n] of regs) {
    add(`<rect x="${x - 5}" y="130" width="10" height="560" rx="2" fill="#2B3A31" fill-opacity="0.82"/>`);
    add(`<text transform="translate(${x + 4},${700}) rotate(-90)" ${MONO} font-size="10" fill="#2B3A31" text-anchor="start">${n}</text>`);
  }

  // ---------------------------------------------------------------- FETCH1
  mux(34, 170, 26, 110, 'next PC', [[186, 'F1+4'], [224, 'F2'], [262, 'EX']]);
  box(84, 185, 86, 80, 'FETCH1_PC', ['register', 'reset 0x2000'], { tsize: 11.5 });
  wire([[60, 225], [84, 225]]);
  add(`<circle cx="232" cy="160" r="15" fill="#FFF" stroke="${COL.edge}" stroke-width="1.6"/>`); text(232, 165, '+4', { size: 12, weight: 700, anchor: 'middle' });
  wire([[170, 205], [196, 205], [196, 160], [217, 160]]);
  wire([[247, 160], [262, 160], [262, 140], [24, 140], [24, 186], [34, 186]]);
  lbl(100, 136, 'FETCH1_PC_ADD_4');
  box(84, 300, 206, 76, 'Instruction cache', ['hit: word latched into FETCH2', 'miss: hold FETCH1_PC, refill'], { mod: 'InstructionCache 4 KiB 2-way', tsize: 12 });
  wire([[127, 265], [127, 300]]); dot(127, 280); wire([[127, 280], [300, 280], [300, 250], [305, 250]]);
  lbl(135, 294, 'icache_addr');
  wire([[290, 338], [305, 338]]); lbl(212, 392, 'icache_dout', 'data', 'middle');
  // gshare
  add(`<rect x="34" y="440" width="258" height="208" rx="8" fill="#E6F4F1" stroke="${COL.pred}" stroke-width="1.8"/>`);
  text(163, 460, 'BTB + tournament predictor', { size: 13, weight: 700, anchor: 'middle', fill: COL.pred });
  text(163, 474, 'src/GShare_Branch_Predictor.sv + chooser', { size: 9, anchor: 'middle', mono: true, fill: COL.sub });
  box(46, 486, 96, 40, 'PC[7:2]', [], { tsize: 11 });
  box(46, 536, 96, 40, 'GLOBAL_HISTORY', [], { tsize: 9.5 });
  text(94, 568, '6 bits', { size: 9.5, anchor: 'middle', fill: COL.sub });
  add(`<circle cx="176" cy="531" r="15" fill="#FFF" stroke="${COL.pred}" stroke-width="2"/><path d="M165,520 L187,542 M187,520 L165,542" stroke="${COL.pred}" stroke-width="2"/>`);
  text(176, 562, 'XOR', { size: 9.5, anchor: 'middle', fill: COL.pred, weight: 700 });
  wire([[142, 506], [158, 506], [163, 520]], 'pred'); wire([[142, 556], [158, 556], [163, 542]], 'pred');
  // PHT
  const px = 212, py = 482;
  text(px + 32, py + 122, 'gshare 64 x 2-bit', { size: 9, anchor: 'middle', fill: COL.sub });
  const states = [2, 2, 3, 1, 2, 0, 2, 3, 2, 2, 1, 2, 3, 2, 0, 2];
  const sc = ['#C0392B', '#E59866', '#82C99A', '#1E8449'];
  for (let i = 0; i < 64; i++) add(`<rect x="${px + (i >> 4) * 16}" y="${py + 4 + (i & 15) * 7}" width="15" height="6" fill="${sc[states[(i * 7 + (i >> 4)) % 16]]}" stroke="#FFF" stroke-width="0.8"/>`);
  wire([[191, 531], [px - 2, 531]], 'pred');
  wire([[px + 64, 540], [300, 540], [300, 520], [305, 520]], 'pred');
  lbl(344, 470, 'FETCH1_PREDICTED_BRANCH_TAKEN', 'pred'); lbl(344, 483, 'FETCH1_GSHARE_INDEX', 'pred');
  text(163, 624, 'chooser picks gshare or BHT (128 each);', { size: 9.5, anchor: 'middle', fill: COL.pred }); text(163, 638, 'BTB hit + taken: jump with 0 bubbles', { size: 9.5, anchor: 'middle', fill: COL.pred });

  // ---------------------------------------------------------------- FETCH2
  box(344, 170, 204, 64, 'Predecode', ['opcode == OPC_BRANCH ?', 'opcode == OPC_JAL ?'], { tsize: 12 });
  box(344, 250, 204, 64, 'Target precompute', ['FETCH2_PC_TARGET =', 'FETCH2_PC + B/J immediate'], { tsize: 12 });
  box(344, 330, 204, 76, 'Redirect + RAS', ['JAL, predicted-taken branch, or', 'return (8-entry RAS): squash', 'FETCH1 unless the BTB jumped'], { tsize: 12 });
  wire([[315, 250], [330, 250], [330, 202], [344, 202]]); wire([[330, 250], [330, 282], [344, 282]]);
  wire([[315, 520], [338, 520], [338, 390], [344, 390]], 'pred');
  wire([[446, 234], [446, 250]]); wire([[446, 314], [446, 330]]);
  // redirect path to next-PC mux
  wire([[446, 406], [446, 420], [320, 420], [320, 430], [16, 430], [16, 224], [34, 224]], 'redirect', { width: 2.4 });
  lbl(330, 434, 'redirect: FETCH2_PREDICTED_NEXT_PC', 'redirect');
  // speculative GHR update
  wire([[548, 368], [562, 368], [562, 700], [110, 700], [110, 578]], 'pred', { dash: '5 4' });
  lbl(570, 695, 'speculative history shift (branch predicted direction)', 'pred');
  wire([[548, 202], [565, 202]]); wire([[548, 282], [565, 282]]);

  // ---------------------------------------------------------------- DECODE
  box(606, 150, 170, 150, 'RegisterFile', ['x1..x31 (x0 = 0)', '2 async read ports', '1 sync write port', 'READ_ADDRESS1 = [19:15]', 'READ_ADDRESS2 = [24:20]'], { mod: 'src/Register_File.sv', tsize: 13 });
  box(606, 318, 170, 132, 'ControlUnit + ALUdec', ['REGISTER_WRITE_ENABLE', 'MEMORY_READ/WRITE_ENABLE', 'ALU_OPERATION', 'IMMEDIATE_TYPE_SELECT', 'WRITEBACK_SELECT ...'], { mod: 'src/Control_Unit.sv', tsize: 12 });
  box(606, 468, 170, 66, 'ImmediateGenerator', ['I S B U J Z, 64-bit', 'sign extension'], { tsize: 12 });
  wire([[575, 202], [590, 202], [590, 225], [606, 225]]); wire([[590, 225], [590, 384], [606, 384]]); wire([[590, 384], [590, 500], [606, 500]]);
  mux(806, 150, 32, 104, 'rs1 fwd', [[164, 'E'], [186, 'M'], [208, 'W'], [232, 'RF']]);
  mux(806, 272, 32, 104, 'rs2 fwd', [[286, 'E'], [308, 'M'], [330, 'W'], [354, 'RF']]);
  wire([[776, 190], [792, 190], [792, 232], [806, 232]]); wire([[776, 260], [796, 260], [796, 354], [806, 354]]);
  wire([[838, 202], [852, 202], [852, 190], [866, 190]]); wire([[838, 324], [852, 324], [852, 304], [866, 304]]);
  text(852, 430, 'priority:', { size: 9.5, fill: COL.sub, anchor: 'middle' });
  text(852, 443, 'x0 > E > M > W > RF', { size: 9.5, fill: COL.sub, anchor: 'middle', mono: true });
  wire([[776, 384], [905, 384]]); lbl(784, 378, 'control'); wire([[776, 500], [905, 500]]); lbl(790, 494, 'immediate');
  box(606, 560, 280, 72, 'LOAD_STALL', ['DECODE_VALID && EXECUTE is a load &&', 'EXECUTE rd == an rs1/rs2 that this', 'instruction really reads (precise)'], { fill: '#FFF8E1', stroke: COL.hold, tsize: 12.5 });
  wire([[886, 596], [910, 596]], 'hold', { dash: '6 4' });
  const badge = (x, y, t) => { add(`<rect x="${x}" y="${y}" width="${t.length * 6.2 + 10}" height="16" rx="8" fill="#FFF3C4" stroke="${COL.hold}"/>`); text(x + 5, y + 12, t, { size: 9.5, fill: COL.hold, weight: 700 }); };
  badge(172, 170, 'hold'); badge(286, 136, 'hold'); badge(546, 136, 'hold'); badge(918, 600, 'NOP in');
  lbl(606, 648, 'LOAD_STALL: hold FETCH1_PC, FETCH2_*, DECODE_*, bubble into EXECUTE', 'hold');

  // ---------------------------------------------------------------- EXECUTE
  // ALU operands are chosen in DECODE and latched (EXECUTE_ALU_INPUT_A/B): no multiplexer in front of the adder
  mux(866, 176, 26, 60, 'A (Zba)', [[190, 'rs1'], [222, 'PC']]);
  mux(866, 290, 26, 60, 'B (bit, ~)', [[304, 'rs2'], [336, 'imm']]);
  wire([[892, 206], [905, 206]]); wire([[892, 320], [905, 320]]);
  wire([[858, 500], [858, 336], [866, 336]]); dot(858, 500);
  add(`<polygon points="1000,160 1070,190 1070,300 1000,330 1000,262 1014,245 1000,228" fill="#FFF3E0" stroke="${COL.EXECUTE}" stroke-width="2"/>`);
  text(1040, 235, 'ALU', { size: 14, weight: 700, anchor: 'middle' }); text(1040, 250, '65-bit shared', { size: 9, anchor: 'middle', fill: COL.sub }); text(1040, 261, 'adder + Zbb units', { size: 9, anchor: 'middle', fill: COL.sub });
  wire([[915, 206], [1000, 206]]); wire([[915, 320], [1000, 320]]); lbl(930, 200, 'ALU_INPUT_A'); lbl(930, 314, 'ALU_INPUT_B');
  box(1000, 346, 130, 56, 'Iterative M unit', ['MUL 8, DIV 4+bits cycles'], { tsize: 11 });
  mux(1100, 216, 24, 80, 'result', []);
  wire([[1070, 240], [1100, 240]]); wire([[1130, 374], [1140, 374], [1140, 320], [1124, 320], [1124, 290]], 'data', { arrow: false });
  wire([[1124, 256], [1305, 256]]); lbl(1136, 250, 'EXECUTE_ALU_RESULT');
  box(944, 424, 150, 70, 'CSRFile + traps', ['cycle instret hpm3..8', 'mtvec mepc mcause'], { mod: 'Zicsr, ecall/mret', tsize: 12 });
  box(1110, 424, 176, 70, 'StoreControl', ['byte lanes + 8-bit', 'write mask (sb..sd)'], { tsize: 12 });
  box(944, 530, 150, 60, 'BranchComparator', ['== != < >= (signed', 'and unsigned)'], { tsize: 11.5 });
  box(1110, 522, 176, 82, 'BranchControl', ['predicted vs actual:', 'wrong or JALR -> FLUSH', 'ADJUST_NEXT_PC'], { tsize: 12, fill: '#FCE4EC', stroke: COL.flush });
  wire([[1094, 560], [1110, 560]]);
  box(1346, 512, 220, 72, 'Data cache', ['hit: doubleword in MEMORY', 'miss: load waits in EXECUTE'], { mod: 'DataCache 4 KiB 2-way, write-through', tsize: 12 });
  wire([[1300, 256], [1300, 530], [1346, 530]]); dot(1300, 256); lbl(1318, 526, 'addr');
  wire([[1286, 470], [1326, 470], [1326, 562], [1346, 562]]); lbl(1330, 578, 'store');
  wire([[1456, 512], [1456, 490]]);
  // forward from EXECUTE
  mux(1182, 130, 22, 56, 'fwd E', []);
  wire([[1150, 256], [1150, 170], [1182, 170]], 'data', { arrow: false });
  wire([[1182, 144], [1182, 112], [822, 112], [822, 161]], 'fwdE', { width: 2.4 });
  lbl(940, 108, 'EXECUTE_FORWARD_DATA (not loads)', 'fwdE');
  // flush + restore
  wire([[1198, 604], [1198, 740], [8, 740], [8, 262], [34, 262]], 'flush', { width: 2.6 });
  lbl(620, 752, 'FLUSH_FETCH1_FETCH2_DECODE + EXECUTE_ADJUST_NEXT_PC (3 bubbles; fence.i also clears the I-cache and BTB)', 'flush');
  wire([[1250, 604], [1250, 726], [84, 726], [84, 648]], 'pred', { dash: '5 4' });
  lbl(620, 722, 'train PHT counter, restore GLOBAL_HISTORY from checkpoint', 'pred');

  // ---------------------------------------------------------------- MEMORY
  box(1346, 420, 220, 70, 'LoadControl', ['lb lh lw ld lbu lhu lwu:', 'pick lanes, sign/zero extend'], { tsize: 12 });
  box(1346, 200, 220, 120, 'WriteControl', ['WRITEBACK_SELECT picks', 'ALU | MEMORY | PC+4 | CSR', '= MEMORY_FORWARD_DATA'], { mod: 'src/Write_Control_Unit.sv', tsize: 12.5 });
  wire([[1315, 256], [1346, 256]]); wire([[1456, 420], [1456, 320]]);
  wire([[1566, 260], [1585, 260]]);
  wire([[1576, 260], [1576, 100], [814, 100], [814, 183]], 'fwdM', { width: 2.4 }); dot(1576, 260, 'fwdM');
  lbl(1340, 97, 'MEMORY_FORWARD_DATA (loads too)', 'fwdM');

  // ---------------------------------------------------------------- WRITEBACK
  box(1624, 200, 184, 100, 'Retire', ['WRITEBACK_DATA ->', 'RegisterFile write port', 'instret + 1'], { tsize: 13 });
  wire([[1595, 250], [1624, 250]]);
  box(1624, 330, 184, 90, 'HALT_NOW', ['the tohost write reached', 'WRITEBACK: PASS if 1,', 'FAIL test n if (n<<1)|1'], { tsize: 12.5, fill: '#FDECEA', stroke: COL.WRITEBACK });
  wire([[1716, 200], [1716, 88], [806, 88], [806, 205]], 'fwdW', { width: 2.4 });
  lbl(1340, 85, 'WRITEBACK_DATA: forward + write rd', 'fwdW');
  wire([[806, 88], [690, 88], [690, 150]], 'fwdW', { width: 2.4 });

  // ---------------------------------------------------------------- legend
  const ly = 800;
  add(`<rect x="20" y="${ly - 18}" width="${W - 40}" height="204" rx="8" fill="#FFF" stroke="#D5DBD0"/>`);
  text(36, ly + 2, 'How to read this diagram', { size: 13, weight: 700 });
  const leg = [['data', 'data (64-bit values, 32-bit instructions)'], ['fwdE', 'forward from EXECUTE'], ['fwdM', 'forward from MEMORY'], ['fwdW', 'forward / write from WRITEBACK'],
    ['redirect', 'FETCH2 redirect (1 bubble)'], ['flush', 'EXECUTE flush (3 bubbles)'], ['pred', 'branch predictor state'], ['hold', 'load stall hold']];
  leg.forEach(([k, s], i) => {
    const x = 36 + (i % 4) * 440, y = ly + 26 + Math.floor(i / 4) * 24;
    wire([[x, y - 4], [x + 44, y - 4]], k, { dash: k === 'pred' || k === 'hold' ? '5 4' : null });
    text(x + 54, y, s, { size: 11.5 });
  });
  const notes = [
    'Every clock edge, each thick bar captures the results of the stage to its left: 6 instructions are in flight at once.',
    'Data hazards are fixed by forwarding INTO DECODE: the newest value of rs1/rs2 is latched into EXECUTE with the instruction.',
    'Branches are guessed twice: FETCH1 reads the BTB and a tournament of BHT + gshare, FETCH2 redirects the rest (and returns via the RAS); EXECUTE checks.',
    'Numbers to remember: fill 5, load stall 1, FETCH2 redirect 1, wrong guess 3, cache miss 11. Exact: cycles = N + 5 + L + 3F + R + K + I + D + X + B (docs/MATH.md).',
    'Detailed figures: docs/img/diagrams/branch_prediction.svg (front end), cache.svg (one cache lookup), cache_interfaces.svg, memory_hierarchy.svg, clock_roadmap.svg, deep_pipeline.svg (the 14-stage edition).',
  ];
  notes.forEach((s, i) => text(36, ly + 86 + i * 20, s, { size: 11.5, fill: COL.sub }));
  add('</svg>');
  return out.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  fs.mkdirSync('docs/img', { recursive: true });
  fs.writeFileSync('docs/img/cpu_block_diagram.svg', blockDiagramSVG());
  console.log('wrote docs/img/cpu_block_diagram.svg');
}
