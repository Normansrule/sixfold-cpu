#!/usr/bin/env node
// =============================================================================
// tools/diagrams.mjs: the detailed figures in the README and docs
//
//   docs/img/diagrams/branch_prediction.svg  the whole front end: BTB, BHT, gshare, chooser, RAS
//   docs/img/diagrams/cache.svg              one 2-way set-associative cache lookup, refill and prefetch
//   docs/img/diagrams/memory_hierarchy.svg   Sixfold's memory next to a typical desktop core
//   docs/img/diagrams/clock_roadmap.svg      measured clock periods against 2.5 GHz and 5 GHz
//   docs/img/diagrams/cache_interfaces.svg   every port between the pipeline, the caches, memory and devices
//   docs/img/diagrams/memory_map.svg         addresses: firmware, programs, device registers, CSRs
//   docs/img/diagrams/boot_sequence.svg      reset vector -> firmware -> program -> firmware (FPGA)
//   docs/img/diagrams/fpga_system.svg        the FPGA computer on its board (docs/fpga_results.json)
//   docs/img/diagrams/interrupt.svg          an interrupt taken in DECODE, cycle by cycle (real model trace)
//   docs/img/diagrams/multitasking.svg       a preemptive kernel: timeline, task control blocks, one context switch
//
// Every number in these figures comes from the RTL parameters (src/*.sv) or from
// docs/PERFORMANCE.md; the figures are redrawn by `make diagrams`.
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';

const FONT = "font-family=\"'IBM Plex Sans','Segoe UI',Helvetica,Arial,sans-serif\"";
const MONO = "font-family=\"'IBM Plex Mono',Consolas,monospace\"";
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const C = {
  ink: '#17251D', sub: '#4A5A50', faint: '#8A968E', paper: '#FBFCF8', edge: '#2B3A31', box: '#FFFFFF', line: '#D5DBD0',
  F1: '#2E86C1', F2: '#17A2B8', D: '#6A5ACD', E: '#E08E0B', M: '#27AE60', W: '#C0392B',
  tag: '#C9982E', idx: '#17A2B8', off: '#6A5ACD', pred: '#00796B', flush: '#C2185B', data: '#2B3A31', hit: '#1E8449', miss: '#C0392B',
  ctr: ['#C0392B', '#E59866', '#82C99A', '#1E8449'],
};

// A tiny SVG builder shared by all figures.
function canvas(W, H, title, subtitle) {
  const out = [];
  const add = s => out.push(s);
  const kinds = ['data', 'pred', 'flush', 'F1', 'F2', 'D', 'E', 'M', 'tag', 'idx', 'off', 'hit', 'miss', 'sub'];
  add(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`);
  add(`<defs>${kinds.map(k => `<marker id="m-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${C[k]}"/></marker>`).join('')}</defs>`);
  add(`<rect width="100%" height="100%" rx="12" fill="${C.paper}" stroke="${C.line}"/>`);
  const text = (x, y, s, { size = 12, weight = 400, fill = C.ink, anchor = 'start', mono = false, italic = false } = {}) =>
    add(`<text x="${x}" y="${y}" ${mono ? MONO : FONT} font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${italic ? ' font-style="italic"' : ''}>${esc(s)}</text>`);
  const rect = (x, y, w, h, { fill = C.box, stroke = C.edge, sw = 1.5, rx = 6, dash = null, op = 1 } = {}) =>
    add(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}${op < 1 ? ` fill-opacity="${op}"` : ''}/>`);
  const box = (x, y, w, h, title, lines = [], { fill = C.box, stroke = C.edge, tsize = 13, tfill = C.ink, lsize = 10.5, file = null } = {}) => {
    rect(x, y, w, h, { fill, stroke });
    text(x + w / 2, y + 19, title, { size: tsize, weight: 700, anchor: 'middle', fill: tfill });
    let yy = y + 19;
    if (file) { yy += 13; text(x + w / 2, yy, file, { size: 9, anchor: 'middle', mono: true, fill: C.faint }); }
    lines.forEach((s, i) => text(x + w / 2, yy + 15 + i * 13.5, s, { size: lsize, anchor: 'middle', fill: C.sub }));
  };
  const wire = (pts, kind = 'data', { width = 2, dash = null, arrow = true } = {}) => {
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ');
    add(`<path d="${d}" fill="none" stroke="${C[kind]}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-linejoin="round"${arrow ? ` marker-end="url(#m-${kind})"` : ''}/>`);
  };
  const dot = (x, y, kind = 'data') => add(`<circle cx="${x}" cy="${y}" r="3.2" fill="${C[kind]}"/>`);
  const mux = (x, y, w, h, label, inputs = [], { stroke = C.edge } = {}) => {
    add(`<polygon points="${x},${y} ${x + w},${y + h * 0.18} ${x + w},${y + h * 0.82} ${x},${y + h}" fill="#F3F5F0" stroke="${stroke}" stroke-width="1.6"/>`);
    if (label) text(x + w / 2, y - 7, label, { size: 10, fill: C.sub, anchor: 'middle', weight: 600 });
    inputs.forEach(([yy, s]) => text(x + 4, yy + 3.5, s, { size: 8.5, fill: C.sub, mono: true }));
  };
  const circle = (x, y, r, label, stroke = C.edge) => {
    add(`<circle cx="${x}" cy="${y}" r="${r}" fill="#FFF" stroke="${stroke}" stroke-width="1.8"/>`);
    text(x, y + 4.5, label, { size: 12, weight: 700, anchor: 'middle', fill: stroke });
  };
  const pill = (x, y, s, color, { size = 10, w = null } = {}) => {
    const ww = w ?? s.length * size * 0.6 + 14;
    add(`<rect x="${x}" y="${y}" width="${ww}" height="${size + 8}" rx="${(size + 8) / 2}" fill="${color}" fill-opacity="0.13" stroke="${color}"/>`);
    text(x + ww / 2, y + size + 2, s, { size, fill: color, anchor: 'middle', weight: 700 });
    return ww;
  };
  const counters = (x, y, w, rowH, states, { cols = 1 } = {}) => {
    const per = Math.ceil(states.length / cols), cw = w / cols;
    states.forEach((s, i) => {
      const c = Math.floor(i / per), r = i % per;
      add(`<rect x="${x + c * cw}" y="${y + r * rowH}" width="${cw - 1}" height="${rowH - 0.8}" fill="${C.ctr[s]}"/>`);
    });
  };
  text(24, 34, title, { size: 20, weight: 700 });
  if (subtitle) text(24, 56, subtitle, { size: 12.5, fill: C.sub });
  return { add, text, rect, box, wire, dot, mux, circle, pill, counters, done: () => { add('</svg>'); return out.join('\n'); } };
}

// Deterministic "random" counter states so the figures do not change between runs.
function states(n, seed) {
  let s = seed;
  return Array.from({ length: n }, () => { s = (s * 1103515245 + 12345) & 0x7fffffff; const v = s % 10; return v < 1 ? 0 : v < 3 ? 1 : v < 6 ? 2 : 3; });
}

// =============================================================================
// Branch prediction front end
// =============================================================================
export function branchPrediction() {
  const W = 1600, H = 1080;
  const g = canvas(W, H, 'The Sixfold front end: choosing the next PC every cycle, before any instruction is decoded',
    'Performance build (src/Riscv64.sv). FETCH1 guesses with the Branch Target Buffer and a tournament of two direction predictors; FETCH2 corrects cheap cases; EXECUTE checks and trains.');
  const { add, text, rect, box, wire, dot, mux, circle, pill, counters } = g;

  const bands = [['FETCH1', 20, 1010, C.F1, 'look up 4 tables in parallel with the instruction cache'], ['FETCH2', 1030, 1300, C.F2, 'predecode, RAS, redirect'], ['EXECUTE', 1320, 1580, C.E, 'resolve, train, repair']];
  for (const [n, x0, x1, col, s] of bands) {
    rect(x0, 72, x1 - x0, 32, { fill: col, stroke: col });
    text(x0 + 12, 93, n, { size: 14, weight: 700, fill: '#FFF' });
    text(x1 - 10, 93, s, { size: 11, fill: '#FFF', anchor: 'end' });
    rect(x0, 108, x1 - x0, 690, { fill: col, stroke: 'none', op: 0.05, rx: 4 });
  }

  // FETCH1_PC and its bus
  box(40, 420, 110, 84, 'FETCH1_PC', ['64-bit register', 'loads next PC', 'every cycle'], { tsize: 12.5 });
  const busX = 190;
  wire([[150, 462], [busX, 462]], 'data', { arrow: false }); dot(busX, 462);
  const bx = 240, by = 132, tx = 240, tyy = 380;
  wire([[busX, 121], [busX, tyy + 300]], 'data', { arrow: false });

  // ---- BTB
  rect(bx, by, 440, 236, { fill: '#EAF2FB', stroke: C.F1, sw: 1.8, rx: 8 });
  text(bx + 12, by + 22, 'Branch Target Buffer (BTB)', { size: 14, weight: 700, fill: C.F1 });
  text(bx + 12, by + 37, 'src/Branch_Target_Buffer.sv', { size: 9, mono: true, fill: C.faint });
  text(bx + 12, by + 53, '16 entries, direct mapped: "the instruction at this PC jumped to that PC"', { size: 10.5, fill: C.sub });
  const cols = [['V', 22], ['JAL', 34], ['tag = PC[31:6]', 132], ['target (32 bits)', 150]];
  const ty = by + 64;
  let cx = bx + 20;
  cols.forEach(([h, w]) => { text(cx + w / 2, ty + 10, h, { size: 9.5, fill: C.sub, anchor: 'middle', weight: 600 }); cx += w; });
  const rows = [[1, 0, '0x00000080', '0x00002040'], [1, 1, '0x00000080', '0x00002310'], [0, 0, '-', '-'], [1, 0, '0x00000081', '0x000020c8'], [1, 0, '0x00000080', '0x00002108'], [0, 0, '-', '-']];
  rows.forEach((r, i) => {
    let xx = bx + 20; const yy = ty + 16 + i * 17, hl = i === 3;
    cols.forEach(([, w], j) => {
      add(`<rect x="${xx}" y="${yy}" width="${w - 1}" height="16" fill="${hl ? '#FFF3C4' : '#FFF'}" stroke="${C.line}"/>`);
      text(xx + w / 2, yy + 12, String(r[j]), { size: 9.5, mono: true, anchor: 'middle', fill: r[0] ? C.ink : C.faint });
      xx += w;
    });
  });
  const rowY = ty + 16 + 3 * 17 + 8; // centre of the selected row
  text(bx + 283, ty + 16 + 6 * 17 + 14, '... 16 rows ...', { size: 9.5, fill: C.faint, anchor: 'middle', italic: true });
  wire([[busX, rowY], [bx + 18, rowY]], 'idx'); text(busX + 5, rowY - 5, 'PC[5:2]', { size: 9, mono: true, fill: C.idx });
  const cmpY = by + 212;
  circle(bx + 142, cmpY, 15, '=?', C.F1);
  wire([[bx + 142, ty + 16 + 6 * 17], [bx + 142, cmpY - 15]], 'tag', { width: 1.6 });
  text(bx + 148, ty + 16 + 6 * 17 + 14, 'stored tag', { size: 9, fill: C.tag });
  wire([[busX, cmpY], [bx + 127, cmpY]], 'tag', { width: 1.6 }); text(busX + 5, cmpY - 5, 'PC[31:6]', { size: 9, mono: true, fill: C.tag });
  wire([[bx + 157, cmpY], [704, cmpY], [704, 494], [736, 494]], 'F1');
  text(bx + 166, cmpY - 6, 'BTB_HIT (valid and tag match)', { size: 9.5, mono: true, fill: C.F1, weight: 700 });
  wire([[bx + 358, rowY], [870, rowY], [870, 196], [900, 196]], 'F1');
  text(bx + 450, rowY - 6, 'BTB_PREDICTED_TARGET', { size: 9.5, mono: true, fill: C.F1, weight: 700 });
  wire([[bx + 76 - 17, ty + 16 + 6 * 17], [bx + 59, 306], [720, 306], [720, 520], [736, 520]], 'F1', { width: 1.4, dash: '4 3' });
  text(bx + 450, 301, 'HIT_IS_JAL', { size: 9.5, mono: true, fill: C.F1 });

  // ---- Tournament
  rect(tx, tyy, 450, 400, { fill: '#E6F4F1', stroke: C.pred, sw: 1.8, rx: 8 });
  text(tx + 12, tyy + 22, 'Tournament direction predictor', { size: 14, weight: 700, fill: C.pred });
  text(tx + 12, tyy + 37, 'src/Tournament_Chooser.sv, src/GShare_Branch_Predictor.sv', { size: 9, mono: true, fill: C.faint });
  text(tx + 12, tyy + 53, 'two predictors answer "taken?"; a third table picks which one to trust', { size: 10.5, fill: C.sub });
  // BHT
  text(tx + 20, tyy + 80, 'Branch History Table (BHT)', { size: 12, weight: 700 });
  text(tx + 20, tyy + 95, '128 x 2-bit counters, index PC[8:2]', { size: 10, fill: C.sub });
  text(tx + 20, tyy + 108, 'learns each branch on its own', { size: 10, fill: C.sub });
  counters(tx + 220, tyy + 66, 100, 3.4, states(128, 7), { cols: 8 });
  text(tx + 270, tyy + 132, '128 counters', { size: 9, fill: C.faint, anchor: 'middle' });
  wire([[busX, tyy + 76], [tx + 216, tyy + 76]], 'idx', { width: 1.6 }); text(busX + 5, tyy + 71, 'PC[8:2]', { size: 9, mono: true, fill: C.idx });
  const mx = tx + 400, my = tyy + 126;
  wire([[tx + 322, tyy + 93], [tx + 384, tyy + 93], [tx + 384, my + 20], [mx, my + 20]], 'pred', { width: 1.8 });
  text(tx + 328, tyy + 88, 'BHT says', { size: 9.5, fill: C.pred });
  // gshare
  wire([[busX, tyy + 160], [tx + 190, tyy + 160], [tx + 190, tyy + 203]], 'idx', { width: 1.6 }); text(busX + 5, tyy + 155, 'PC[7:2]', { size: 9, mono: true, fill: C.idx });
  text(tx + 20, tyy + 180, 'gshare', { size: 12, weight: 700 });
  text(tx + 20, tyy + 195, '64 x 2-bit, index PC[7:2] XOR history', { size: 10, fill: C.sub });
  rect(tx + 20, tyy + 204, 132, 26, { fill: '#FFF', stroke: C.pred });
  text(tx + 86, tyy + 222, 'GLOBAL_HISTORY', { size: 10.5, mono: true, anchor: 'middle', weight: 700, fill: C.pred });
  [1, 0, 1, 1, 0, 1].forEach((b, i) => { rect(tx + 20 + i * 22, tyy + 234, 21, 20, { fill: b ? '#1E8449' : '#C0392B', stroke: '#FFF', sw: 1, rx: 2 }); text(tx + 30.5 + i * 22, tyy + 248, b ? 'T' : 'N', { size: 10, fill: '#FFF', anchor: 'middle', weight: 700 }); });
  text(tx + 20, tyy + 270, 'the last 6 branch directions: FETCH2 shifts in', { size: 9.5, fill: C.sub });
  text(tx + 20, tyy + 282, 'each guess, EXECUTE repairs it after a flush', { size: 9.5, fill: C.sub });
  add(`<circle cx="${tx + 190}" cy="${tyy + 217}" r="14" fill="#FFF" stroke="${C.pred}" stroke-width="2"/><path d="M${tx + 180},${tyy + 207} L${tx + 200},${tyy + 227} M${tx + 200},${tyy + 207} L${tx + 180},${tyy + 227}" stroke="${C.pred}" stroke-width="2"/>`);
  wire([[tx + 152, tyy + 217], [tx + 174, tyy + 217]], 'pred', { width: 1.6 });
  counters(tx + 220, tyy + 190, 100, 3.4, states(64, 11), { cols: 4 });
  text(tx + 270, tyy + 256, '64 counters', { size: 9, fill: C.faint, anchor: 'middle' });
  wire([[tx + 204, tyy + 217], [tx + 216, tyy + 217]], 'pred', { width: 1.6 });
  wire([[tx + 322, tyy + 217], [tx + 384, tyy + 217], [tx + 384, my + 56], [mx, my + 56]], 'pred', { width: 1.8 });
  text(tx + 328, tyy + 212, 'gshare says', { size: 9.5, fill: C.pred });
  // chooser
  wire([[busX, tyy + 300], [tx + 335, tyy + 300], [tx + 335, tyy + 306]], 'idx', { width: 1.4 }); text(busX + 5, tyy + 295, 'PC[8:2]', { size: 9, mono: true, fill: C.idx });
  text(tx + 20, tyy + 322, 'Chooser: 128 x 2-bit', { size: 12, weight: 700 });
  text(tx + 20, tyy + 337, 'counter >= 2: trust gshare, else the BHT;', { size: 10, fill: C.sub });
  text(tx + 20, tyy + 351, 'moves toward whichever one was right', { size: 10, fill: C.sub });
  text(tx + 20, tyy + 365, 'when the two disagree', { size: 10, fill: C.sub });
  counters(tx + 300, tyy + 310, 70, 2.2, states(128, 3), { cols: 8 });
  text(tx + 335, tyy + 360, '128 counters', { size: 9, fill: C.faint, anchor: 'middle' });
  wire([[tx + 370, tyy + 327], [tx + 415, tyy + 327], [tx + 415, my + 76]], 'pred', { width: 1.6, dash: '4 3' });
  text(tx + 420, tyy + 290, 'select', { size: 9.5, fill: C.pred });
  mux(mx, my, 30, 80, '', [[my + 20, 'B'], [my + 56, 'G']], { stroke: C.pred });
  wire([[mx + 30, my + 40], [736, my + 40]], 'pred', { width: 2 });
  text(696, my + 34, 'TAKEN', { size: 9, mono: true, fill: C.pred, weight: 700 });

  // AND gate
  add(`<path d="M736,480 L760,480 A26,40 0 0 1 760,560 L736,560 Z" fill="#FFF" stroke="${C.F1}" stroke-width="1.8"/>`);
  text(758, 525, '&', { size: 15, weight: 700, anchor: 'middle', fill: C.F1 });
  text(792, 474, 'HIT && (JAL || TAKEN)', { size: 9, mono: true, fill: C.F1 });
  wire([[786, 520], [912, 520], [912, 412]], 'F1');
  text(792, 514, 'FETCH1_BTB_REDIRECT', { size: 9, mono: true, fill: C.F1, weight: 700 });

  // PC + 4 and the next-PC mux
  circle(830, 121, 14, '+4');
  wire([[busX, 121], [816, 121]], 'data', { width: 1.6 });
  wire([[844, 121], [880, 121], [880, 150], [900, 150]], 'data', { width: 1.6 });
  wire([[860, 300], [900, 300]], 'data', { width: 1.6 }); text(856, 304, 'FETCH1_PC', { size: 9, mono: true, fill: C.sub, anchor: 'end' });
  mux(900, 124, 40, 300, '', [[150, 'PC+4'], [196, 'BTB'], [300, 'hold'], [330, 'F2'], [398, 'EX']]);
  text(920, 440, 'next PC', { size: 10, fill: C.sub, anchor: 'middle', weight: 700 });
  text(790, 330, 'priority', { size: 9.5, fill: C.sub, weight: 700 });
  ['1 EXECUTE flush', '2 FETCH2 redirect', '3 I-cache miss: hold', '4 BTB redirect', '5 PC + 4'].forEach((s, i) => text(790, 344 + i * 12.5, s, { size: 9.5, fill: C.sub }));
  pill(790, 412, 'I-cache miss', C.miss, { size: 9.5 });
  wire([[876, 421], [928, 421], [928, 392]], 'miss', { width: 1.4, dash: '4 3' });
  wire([[940, 274], [990, 274], [990, 113], [30, 113], [30, 462], [40, 462]], 'data', { width: 2.2 });

  // FETCH2
  box(1046, 128, 238, 92, 'Predecode', ['opcode: branch? JAL? JALR?', 'call: rd = ra or t0', 'return: jalr x0, 0(ra or t0)'], { tsize: 12.5 });
  box(1046, 236, 238, 60, 'Target adder', ['FETCH2_PC + B or J immediate'], { tsize: 12.5 });
  rect(1046, 312, 238, 214, { fill: '#EAF6F8', stroke: C.F2, sw: 1.8, rx: 8 });
  text(1058, 332, 'Return Address Stack (RAS)', { size: 12.5, weight: 700, fill: C.F2 });
  text(1058, 347, '8 x 64-bit, src/Return_Address_Stack.sv', { size: 9, fill: C.faint, mono: true });
  ['0x2014', '0x2330', '0x2468', '', '', '', '', ''].forEach((v, i) => { const yy = 480 - i * 16; rect(1070, yy, 110, 15, { fill: v ? '#FFF' : '#F4F6F2', stroke: C.line, rx: 1, sw: 1 }); text(1125, yy + 11.5, v || '-', { size: 9.5, mono: true, anchor: 'middle', fill: v ? C.ink : C.faint }); });
  wire([[1210, 456], [1184, 456]], 'F2', { width: 1.6 }); text(1214, 460, 'top', { size: 9.5, fill: C.F2 });
  text(1190, 386, 'call: push PC+4', { size: 9.5, fill: C.sub }); text(1190, 400, 'ret: pop', { size: 9.5, fill: C.sub });
  text(1058, 514, 'pointer checkpointed per call/ret', { size: 9.5, fill: C.sub });
  box(1046, 542, 238, 104, 'Redirect decision', ['JAL, or branch predicted taken,', 'or return (target = RAS top),', 'and FETCH1 did not already jump:', 'squash FETCH1, 1 bubble'], { tsize: 12.5, stroke: C.F2 });
  wire([[1165, 220], [1165, 236]], 'data', { width: 1.5 }); wire([[1165, 296], [1165, 312]], 'data', { width: 1.5 }); wire([[1165, 526], [1165, 542]], 'data', { width: 1.5 });
  wire([[1165, 646], [1165, 668], [1010, 668], [1010, 330], [940, 330]], 'F2', { width: 2.2 });
  text(1020, 684, 'FETCH2_PREDICTED_NEXT_PC', { size: 9.5, mono: true, fill: C.F2, weight: 700 });

  // EXECUTE
  box(1336, 128, 228, 80, 'BranchComparator', ['== != < >= (signed, unsigned)', 'on forwarded rs1, rs2'], { tsize: 12.5 });
  box(1336, 224, 228, 116, 'BranchControl', ['actual direction and target', 'vs the prediction that', 'travelled down the pipe', 'wrong: FLUSH (3 bubbles)'], { tsize: 12.5, stroke: C.flush, fill: '#FCE4EC' });
  wire([[1450, 208], [1450, 224]], 'data', { width: 1.5 });
  box(1336, 356, 228, 176, 'Train (every branch)', ['BHT counter at the PC', 'gshare counter at the index', 'saved when it was predicted', 'chooser: toward the one', 'that was right', 'BTB: insert taken branch / JAL'], { tsize: 12.5, stroke: C.pred, fill: '#E6F4F1' });
  box(1336, 548, 228, 120, 'Repair (only after a flush)', ['GLOBAL_HISTORY <= checkpoint', '+ the real direction', 'RAS pointer <= checkpoint', 'refetch from the right PC'], { tsize: 12.5, stroke: C.flush });
  wire([[1450, 340], [1450, 356]], 'pred', { width: 1.5 }); wire([[1450, 532], [1450, 548]], 'flush', { width: 1.5 });
  wire([[1450, 668], [1450, 740], [960, 740], [960, 398], [940, 398]], 'flush', { width: 2.4 });
  text(1200, 756, 'EXECUTE_REDIRECT_PC + FLUSH_FETCH1_FETCH2_DECODE', { size: 9.5, mono: true, fill: C.flush, weight: 700, anchor: 'middle' });
  wire([[1336, 470], [1316, 470], [1316, 790], [tx + 235, 790], [tx + 235, tyy + 402]], 'pred', { width: 1.4, dash: '5 4' });
  text(740, 812, 'training writes: one per resolved branch, at the table indexes saved when it was predicted', { size: 10, fill: C.pred });

  // bottom panels
  const py = 836;
  rect(20, py, 560, 226, { fill: '#FFF', stroke: C.line, rx: 8 });
  text(36, py + 24, 'Every table entry is a 2-bit saturating counter', { size: 13, weight: 700 });
  const sn = ['00 strong\nnot taken', '01 weak\nnot taken', '10 weak\ntaken', '11 strong\ntaken'];
  [60, 180, 300, 420].forEach((x, i) => {
    add(`<circle cx="${x + 40}" cy="${py + 92}" r="36" fill="${C.ctr[i]}" fill-opacity="0.18" stroke="${C.ctr[i]}" stroke-width="2"/>`);
    sn[i].split('\n').forEach((s, j) => text(x + 40, py + 88 + j * 14, s, { size: j ? 10 : 11, weight: j ? 400 : 700, anchor: 'middle' }));
    if (i < 3) {
      add(`<path d="M${x + 72},${py + 76} Q${x + 100},${py + 58} ${x + 128},${py + 76}" fill="none" stroke="${C.hit}" stroke-width="1.8" marker-end="url(#m-hit)"/>`);
      text(x + 100, py + 60, 'taken', { size: 9.5, fill: C.hit, anchor: 'middle' });
      add(`<path d="M${x + 128},${py + 108} Q${x + 100},${py + 126} ${x + 72},${py + 108}" fill="none" stroke="${C.miss}" stroke-width="1.8" marker-end="url(#m-miss)"/>`);
      text(x + 100, py + 136, 'not taken', { size: 9.5, fill: C.miss, anchor: 'middle' });
    }
  });
  text(36, py + 166, 'Predict taken when the counter is 2 or 3. One odd outcome only moves it one step, so a loop', { size: 10.5, fill: C.sub });
  text(36, py + 181, 'branch that falls through once at the end is not unlearned. Reset value: 10 (weakly taken).', { size: 10.5, fill: C.sub });
  text(36, py + 206, 'Cost: 128 + 64 + 128 counters = 640 bits of direction state, plus a 16-entry BTB.', { size: 10.5, fill: C.sub, weight: 600 });

  rect(600, py, 470, 226, { fill: '#FFF', stroke: C.line, rx: 8 });
  text(616, py + 24, 'What each case costs (bubbles = lost cycles)', { size: 13, weight: 700 });
  [['not a branch, or not taken and predicted so', '0', C.hit], ['taken branch / JAL already in the BTB', '0', C.hit], ['taken branch / JAL not in the BTB yet (FETCH2)', '1', C.F2],
    ['return predicted by the RAS (FETCH2)', '1', C.F2], ['direction or target wrong (EXECUTE flush)', '3', C.flush], ['instruction cache miss (refill)', '+11', C.miss]].forEach(([s, n, col], i) => {
    const yy = py + 52 + i * 27;
    text(616, yy + 4, s, { size: 11 });
    pill(1010, yy - 10, n, col, { size: 11, w: 44 });
  });

  rect(1090, py, 490, 226, { fill: '#FFF', stroke: C.line, rx: 8 });
  text(1106, py + 24, 'Accuracy on 17_predictor_challenge (make arena)', { size: 13, weight: 700 });
  [['BHT alone', 68.2, C.ctr[1]], ['gshare alone', 81.9, C.F2], ['tournament (in RTL)', 83.4, C.pred], ['perceptron (model)', 90.3, C.D], ['TAGE (model)', 96.2, C.M]].forEach(([n, v, col], i) => {
    const yy = py + 44 + i * 32;
    text(1106, yy + 14, n, { size: 11 });
    rect(1250, yy, 260, 20, { fill: '#F1F3EE', stroke: 'none', rx: 3 });
    rect(1250, yy, 260 * (v - 50) / 50, 20, { fill: col, stroke: 'none', rx: 3 });
    text(1518, yy + 15, v.toFixed(1) + '%', { size: 11, weight: 700, fill: col });
  });
  text(1106, py + 212, 'axis starts at 50% (a coin flip). TAGE is the basis of current Intel, AMD and Arm predictors.', { size: 9.5, fill: C.faint });
  return g.done();
}

// =============================================================================
// Cache lookup
// =============================================================================
export function cache() {
  const W = 1600, H = 1010;
  const g = canvas(W, H, 'Inside a Sixfold cache: 4 KiB, 2-way set-associative, 32-byte lines, least-recently-used replacement',
    'src/Instruction_Cache.sv and src/Data_Cache.sv have the same shape: 64 sets x 2 ways x 32 bytes. Example: a load from address 0x0000_2072.');
  const { add, text, rect, box, wire, dot, mux, circle, pill } = g;

  // Address bar
  const ax = 330, ay = 86, bw = 24;
  text(ax - 20, ay + 30, 'address', { size: 13, weight: 700, anchor: 'end' });
  text(ax - 20, ay + 46, '0x0000_2072', { size: 11, mono: true, anchor: 'end', fill: C.sub });
  const bits = (0x2072).toString(2).padStart(32, '0').split('').map(Number);
  const fields = [[31, 11, C.tag, 'tag  [31:11]  21 bits', 'which of the lines that share this set?', '= 4'], [10, 5, C.idx, 'set  [10:5]  6 bits', 'which of the 64 sets', '= 3'], [4, 0, C.off, 'offset  [4:0]  5 bits', 'which byte in the 32-byte line', '= 18 (doubleword 2)']];
  for (let b = 31; b >= 0; b--) {
    const x = ax + (31 - b) * bw;
    const f = fields.find(([hi, lo]) => b <= hi && b >= lo);
    rect(x, ay + 14, bw - 2, 30, { fill: f[2], stroke: '#FFF', sw: 1, rx: 3, op: 0.2 + 0.7 * bits[31 - b] });
    text(x + bw / 2 - 1, ay + 35, String(bits[31 - b]), { size: 13, mono: true, anchor: 'middle', weight: 700, fill: bits[31 - b] ? '#FFF' : f[2] });
    if (b % 4 === 3 || b === 0) text(x + bw / 2 - 1, ay + 10, String(b), { size: 8.5, mono: true, anchor: 'middle', fill: C.faint });
  }
  fields.forEach(([hi, lo, col, name, what, val]) => {
    const x0 = ax + (31 - hi) * bw, x1 = ax + (31 - lo) * bw + bw - 2;
    add(`<path d="M${x0},${ay + 50} L${x0},${ay + 56} L${x1},${ay + 56} L${x1},${ay + 50}" fill="none" stroke="${col}" stroke-width="2"/>`);
    text((x0 + x1) / 2, ay + 72, `${name.split(' ')[0]} ${val.replace(' (doubleword 2)', '')}`, { size: 12, anchor: 'middle', fill: col, weight: 700 });
  });
  fields.forEach(([hi, lo, col, name, what, val], i) => {
    text(ax + 32 * bw + 20, ay + 8 + i * 30, `${name.replace(/  /g, ' ')}`, { size: 11.5, fill: col, weight: 700 });
    text(ax + 32 * bw + 20, ay + 22 + i * 30, what, { size: 10, fill: C.sub });
  });
  text(ax - 20, ay + 62, 'bits 63..32 must be 0', { size: 10, fill: C.faint, anchor: 'end' });

  // Two ways
  const wy = 230, rowH = 21;
  const setRows = [0, 1, 2, 3, 4, 5, -1, 63];
  const ways = [
    { x: 180, name: 'way 0', tags: [2, 0, 1, 4, 1, 0, 0, 3], valid: [1, 1, 1, 1, 1, 0, 0, 1] },
    { x: 760, name: 'way 1', tags: [0, 5, 0, 1, 3, 0, 0, 0], valid: [0, 1, 0, 1, 1, 0, 0, 0] },
  ];
  const wcol = [['V', 26], ['tag (21 bits)', 110], ['data: 4 doublewords = 32 bytes', 380]];
  for (const [wi, w] of ways.entries()) {
    rect(w.x - 10, wy - 34, 540, 262, { fill: '#FFF', stroke: C.line, rx: 8 });
    text(w.x, wy - 14, w.name, { size: 13, weight: 700 });
    text(w.x + 520, wy - 14, `WAY${wi}_VALID, WAY${wi}_TAG, WAY${wi}_DATA`, { size: 9.5, mono: true, fill: C.faint, anchor: 'end' });
    let xx = w.x;
    wcol.forEach(([h, ww]) => { text(xx + ww / 2, wy, h, { size: 9.5, fill: C.sub, anchor: 'middle', weight: 600 }); xx += ww; });
    setRows.forEach((s, r) => {
      const yy = wy + 8 + r * rowH;
      if (s < 0) { text(w.x + 258, yy + 14, '... sets 6 to 62 ...', { size: 9.5, fill: C.faint, anchor: 'middle', italic: true }); return; }
      const hl = s === 3;
      let x = w.x;
      const v = w.valid[r];
      add(`<rect x="${x}" y="${yy}" width="25" height="${rowH - 2}" fill="${hl ? '#FFF3C4' : '#FFF'}" stroke="${hl ? C.idx : C.line}" stroke-width="${hl ? 1.8 : 1}"/>`);
      text(x + 13, yy + 14, String(v), { size: 10, mono: true, anchor: 'middle', fill: v ? C.ink : C.faint }); x += 26;
      add(`<rect x="${x}" y="${yy}" width="109" height="${rowH - 2}" fill="${hl ? '#FFF3C4' : '#FFF'}" stroke="${hl ? C.idx : C.line}" stroke-width="${hl ? 1.8 : 1}"/>`);
      text(x + 55, yy + 14, v ? String(w.tags[r]) : '-', { size: 10, mono: true, anchor: 'middle', fill: v ? C.tag : C.faint }); x += 110;
      for (let d = 0; d < 4; d++) {
        const pick = hl && wi === 0 && d === 2;
        add(`<rect x="${x + d * 95}" y="${yy}" width="94" height="${rowH - 2}" fill="${pick ? '#E6E1FF' : hl ? '#FFF3C4' : v ? '#F7F8F4' : '#FFF'}" stroke="${pick ? C.off : hl ? C.idx : C.line}" stroke-width="${pick || hl ? 1.8 : 1}"/>`);
        text(x + d * 95 + 47, yy + 14, v ? (pick ? 'bytes 16..23' : `dw ${d}`) : '', { size: 9, mono: true, anchor: 'middle', fill: pick ? C.off : C.faint });
      }
      text(w.x - 16, yy + 14, String(s), { size: 9.5, mono: true, anchor: 'end', fill: hl ? C.idx : C.faint, weight: hl ? 700 : 400 });
    });
  }
  text(160, wy + 8 + 3 * rowH + 14 - 88, 'set', { size: 9.5, fill: C.faint, anchor: 'end' });
  // LRU column
  const lx = 1330;
  rect(lx - 10, wy - 34, 90, 262, { fill: '#FFF', stroke: C.line, rx: 8 });
  text(lx + 35, wy - 14, 'LRU', { size: 13, weight: 700, anchor: 'middle' });
  text(lx + 35, wy, '1 bit / set', { size: 9.5, fill: C.sub, anchor: 'middle' });
  const lru = [1, 0, 1, 1, 0, 0, 0, 1];
  setRows.forEach((s, r) => {
    const yy = wy + 8 + r * rowH;
    if (s < 0) return;
    add(`<rect x="${lx + 10}" y="${yy}" width="50" height="${rowH - 2}" fill="${s === 3 ? '#FFF3C4' : '#FFF'}" stroke="${s === 3 ? C.idx : C.line}"/>`);
    text(lx + 35, yy + 14, String(lru[r]), { size: 10, mono: true, anchor: 'middle' });
  });
  text(lx + 35, wy + 196, 'which way to', { size: 9, fill: C.sub, anchor: 'middle' });
  text(lx + 35, wy + 208, 'evict next', { size: 9, fill: C.sub, anchor: 'middle' });

  // set index arrow
  const sy = 182, sx0 = ax + 23 * bw;
  wire([[sx0, ay + 78], [sx0, sy]], 'idx', { arrow: false });
  wire([[sx0, sy], [150, sy], [150, wy + 8 + 3 * rowH + 9], [176, wy + 8 + 3 * rowH + 9]], 'idx');
  wire([[700, sy], [700, wy + 8 + 3 * rowH + 9], [756, wy + 8 + 3 * rowH + 9]], 'idx');
  wire([[sx0, sy], [1300, sy], [1300, wy + 8 + 3 * rowH + 9], [1336, wy + 8 + 3 * rowH + 9]], 'idx', { width: 1.5 });
  text(158, sy - 5, 'set 3 selects one row in every array, in the same cycle', { size: 10, fill: C.idx, weight: 600 });

  // comparators
  const cy = 540;
  circle(310, cy, 20, '=?', C.tag);
  circle(890, cy, 20, '=?', C.tag);
  wire([[ways[0].x + 26 + 55, wy + 8 + 8 * rowH + 2], [ways[0].x + 81, cy - 30], [296, cy - 30], [300, cy - 18]], 'tag', { width: 1.6 });
  wire([[ways[1].x + 26 + 55, wy + 8 + 8 * rowH + 2], [ways[1].x + 81, cy - 30], [876, cy - 30], [880, cy - 18]], 'tag', { width: 1.6 });
  wire([[225, cy], [290, cy]], 'tag', { width: 1.6 }); text(220, cy + 4, 'address tag 4', { size: 10, fill: C.tag, weight: 700, anchor: 'end' });
  wire([[805, cy], [870, cy]], 'tag', { width: 1.6 }); text(800, cy + 4, 'address tag 4', { size: 10, fill: C.tag, weight: 700, anchor: 'end' });
  text(310, cy - 42, 'stored tag 4', { size: 9.5, fill: C.tag }); text(890, cy - 42, 'stored tag 1', { size: 9.5, fill: C.tag });
  // AND with valid -> hit way
  box(250, 590, 120, 54, 'HIT_WAY0', ['V && tag 4 == 4'], { tsize: 11.5, stroke: C.hit, tfill: C.hit });
  box(830, 590, 120, 54, 'HIT_WAY1', ['V && tag 1 == 4'], { tsize: 11.5, stroke: C.miss, tfill: C.miss });
  wire([[310, cy + 20], [310, 590]], 'hit'); wire([[890, cy + 20], [890, 590]], 'miss');
  pill(380, 600, 'yes', C.hit); pill(960, 600, 'no', C.miss);
  // OR -> HIT
  box(520, 680, 150, 54, 'HIT = W0 or W1', ['0: stall and refill'], { tsize: 11.5, stroke: C.hit });
  wire([[310, 644], [310, 707], [520, 707]], 'hit'); wire([[890, 644], [890, 707], [670, 707]], 'miss');
  // data mux
  mux(1090, 520, 36, 110, 'way', [[544, 'W0'], [604, 'W1']]);
  wire([[ways[0].x + 136 + 2 * 95 + 47, wy + 8 + 8 * rowH + 2], [ways[0].x + 136 + 2 * 95 + 47, 470], [1060, 470], [1060, 544], [1090, 544]], 'off', { width: 1.8 });
  wire([[ways[1].x + 136 + 2 * 95 + 47, wy + 8 + 8 * rowH + 2], [ways[1].x + 136 + 2 * 95 + 47, 604], [1090, 604]], 'data', { width: 1.4, dash: '4 3' });
  wire([[950, 617], [1108, 617], [1108, 616]], 'hit', { width: 1.4 });
  wire([[1126, 575], [1180, 575]], 'off', { width: 2.2 });
  box(1180, 530, 190, 92, 'READ_DATA', ['doubleword 2 of the line', '(offset[4:3]); LoadControl', 'picks bytes with [2:0]'], { tsize: 12, stroke: C.off });
  text(1180, 648, 'I-cache: the 32-bit word at offset[4:2]', { size: 10, fill: C.sub });
  text(1180, 690, 'all of this happens in one cycle:', { size: 11, fill: C.hit, weight: 700 }); text(1180, 706, 'a hit costs 0 extra cycles', { size: 11, fill: C.hit, weight: 700 });

  // ---- miss handling panel
  const my = 770;
  rect(20, my, 760, 226, { fill: '#FFF', stroke: C.line, rx: 8 });
  text(36, my + 24, 'On a miss: refill (MISS_LATENCY = 10, so a miss costs 11 cycles)', { size: 13, weight: 700 });
  for (let c = 0; c < 12; c++) {
    const x = 40 + c * 58, col = c === 0 ? C.miss : c === 11 ? C.hit : '#D9DED6';
    rect(x, my + 42, 54, 30, { fill: col, stroke: '#FFF', rx: 4, op: c === 0 || c === 11 ? 0.9 : 1 });
    text(x + 27, my + 62, c === 0 ? 'miss' : c === 11 ? 'hit' : String(c), { size: 10.5, anchor: 'middle', weight: 700, fill: c === 0 || c === 11 ? '#FFF' : C.sub });
  }
  text(40, my + 92, 'cycle', { size: 9.5, fill: C.faint });
  text(335, my + 92, 'core stalls: FETCH1 holds its PC (I-cache) or the load waits in EXECUTE (D-cache)', { size: 10, fill: C.sub, anchor: 'middle' });
  text(620, my + 92, 'INSTALL when 1 cycle is left', { size: 10, fill: C.hit, anchor: 'middle' });
  const notes = [
    ['victim way', 'an empty way first, otherwise the one LRU points at (chosen before this cycle\'s LRU update)'],
    ['next-line prefetch', 'after a demand miss on line X, line X + 1 is fetched in the background if it is not present'],
    ['stores', 'D-cache is write-through, no-allocate: main memory always has the data, a cached copy is updated too'],
    ['MMIO', 'addresses 0x1000_0000 and up (putchar) bypass the cache entirely'],
  ];
  notes.forEach(([k, v], i) => { text(36, my + 124 + i * 24, k, { size: 11, weight: 700 }); text(170, my + 124 + i * 24, v, { size: 11, fill: C.sub }); });

  rect(800, my, 780, 226, { fill: '#FFF', stroke: C.line, rx: 8 });
  text(816, my + 24, 'Why two ways? (programs/16_cache_conflicts.s)', { size: 13, weight: 700 });
  const why = [
    'Two arrays exactly 2 KiB apart share every set index. In a direct-mapped cache they evict',
    'each other on every access ("thrashing"). With 2 ways both lines live in the same set.',
    '',
    'Size cost of this cache, per line: 1 valid + 21 tag + 256 data bits; plus 1 LRU bit per set:',
    '128 lines x 278 bits + 64 = 35,648 bits of storage for 32,768 bits of data (8.8% overhead).',
    '',
    'Real CPUs: 32 to 64 KiB L1 caches with 8 to 12 ways and 64-byte lines, a 4 or 5 cycle load-to-use',
    'latency (pipelined), and stride and stream prefetchers instead of just "next line".',
  ];
  why.forEach((s, i) => text(816, my + 50 + i * 20, s, { size: 11, fill: i >= 3 && i <= 4 ? C.ink : C.sub }));
  return g.done();
}

// =============================================================================
// Memory hierarchy
// =============================================================================
export function hierarchy() {
  const W = 1600, H = 560;
  const g = canvas(W, H, 'Memory hierarchy: Sixfold next to a typical desktop core',
    'Each level is bigger and slower than the one above it. Widths are drawn on a log scale of size; cycle counts at the right.');
  const { text, rect, pill, add } = g;
  const col = [C.D, C.F1, C.F2, C.M, C.E, C.W];
  const draw = (x0, title, levels, note) => {
    text(x0, 100, title, { size: 15, weight: 700 });
    const cx = x0 + 330;
    levels.forEach(([name, size, bytes, cyc, detail], i) => {
      const y = 124 + i * 78;
      const w = Math.max(280, 60 * Math.log2(bytes / 64));
      const c = col[i % col.length];
      rect(cx - Math.min(w, 620) / 2, y, Math.min(w, 620), 58, { fill: c, stroke: c, op: 0.16, rx: 8 });
      add(`<rect x="${cx - Math.min(w, 620) / 2}" y="${y}" width="${Math.min(w, 620)}" height="58" rx="8" fill="none" stroke="${c}" stroke-width="1.8"/>`);
      text(cx, y + 24, `${name}  ${size}`, { size: 13, weight: 700, anchor: 'middle', fill: C.ink });
      text(cx, y + 42, detail, { size: 10.5, anchor: 'middle', fill: C.sub });
      pill(x0 + 670, y + 18, cyc, c, { size: 11, w: 96 });
    });
    text(x0, 124 + levels.length * 78 + 20, note, { size: 11, fill: C.sub });
  };
  draw(30, 'Sixfold (this repository)', [
    ['registers', '31 x 64-bit', 248, '0 cycles', 'x1..x31, forwarding into DECODE'],
    ['L1 I-cache + L1 D-cache', '4 KiB each', 4096, '0 extra', '2-way, 32 B lines, LRU, next-line prefetch'],
    ['main memory', '64 KiB', 65536, '+11 cycles', 'Scratchpad_Memory behind a 10-cycle refill port'],
  ], 'Every miss is counted: the I and D terms of the CPI stack (docs/MATH.md).');
  add(`<line x1="800" y1="84" x2="800" y2="${H - 30}" stroke="${C.line}" stroke-width="1.5" stroke-dasharray="6 5"/>`);
  draw(830, 'A typical desktop core (order of magnitude)', [
    ['registers', '~200-300 physical', 2048, '0 cycles', 'renamed, out of order'],
    ['L1 I + D', '32-64 KiB each', 49152, '4-5 cycles', '8-12 ways, 64 B lines, pipelined'],
    ['L2', '1-3 MiB per core', 2 * 1048576, '12-18 cycles', 'private, inclusive or not'],
    ['L3', '16-96 MiB shared', 32 * 1048576, '40-70 cycles', 'shared by all cores, sliced'],
    ['DRAM', '16-64 GiB', 16 * 1073741824, '~250-400 cycles', 'about 80-100 ns at 4-5 GHz'],
  ], 'Latencies vary by generation; these are typical published figures for recent Intel and AMD cores.');
  return g.done();
}

// =============================================================================
// Clock roadmap
// =============================================================================
export function clockRoadmap(data) {
  const W = 1600, H = 110 + data.rows.length * 46 + 20 + 60 + data.steps.length * 26 + 30;
  const g = canvas(W, H, 'Clock frequency: where Sixfold is, and what it takes to reach 2.5 GHz and 5 GHz',
    'Longest register-to-register path, logic only (tools/timing.sh, typical corner). Shorter bar = faster clock. Log scale.');
  const { text, rect, add, pill } = g;
  const x0 = 470, x1 = 1440;
  const lo = Math.log10(100), hi = Math.log10(400000);
  const X = ps => x0 + (x1 - x0) * (Math.log10(ps) - lo) / (hi - lo);
  [100, 200, 400, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000].forEach(ps => {
    add(`<line x1="${X(ps)}" y1="92" x2="${X(ps)}" y2="${92 + data.rows.length * 46 + 8}" stroke="${C.line}" stroke-width="1"/>`);
    text(X(ps), 86, ps >= 1000 ? `${ps / 1000} ns` : `${ps} ps`, { size: 10, fill: C.faint, anchor: 'middle' });
  });
  data.rows.forEach(([label, ps, kind, note], i) => {
    const y = 100 + i * 46;
    const col = kind === 'target' ? C.flush : kind === 'best' ? C.M : kind === 'base' ? C.faint : C.F1;
    text(x0 - 14, y + 20, label, { size: 12, anchor: 'end', weight: kind === 'best' ? 700 : 400 });
    if (kind === 'target') {
      add(`<line x1="${X(ps)}" y1="${y}" x2="${X(ps)}" y2="${y + 30}" stroke="${col}" stroke-width="3"/>`);
      rect(x0, y + 4, X(ps) - x0, 22, { fill: col, stroke: col, op: 0.08, rx: 3, dash: '5 4' });
    } else rect(x0, y + 4, X(ps) - x0, 22, { fill: col, stroke: col, op: 0.85, rx: 3 });
    const f = 1e6 / ps;
    const fs = f >= 1000 ? `${(f / 1000).toFixed(2)} GHz` : `${f.toFixed(f < 10 ? 1 : 0)} MHz`;
    text(X(ps) + 8, y + 20, `${ps >= 1000 ? (ps / 1000).toFixed(ps >= 10000 ? 0 : 2) + ' ns' : ps + ' ps'}  =  ${fs}`, { size: 11.5, weight: 700, fill: col });
    if (note) text(x0 - 14, y + 35, note, { size: 9.5, anchor: 'end', fill: C.faint });
  });
  // steps panel
  const py = 110 + data.rows.length * 46 + 20;
  rect(20, py, W - 40, H - py - 20, { fill: '#FFF', stroke: C.line, rx: 8 });
  text(36, py + 26, 'Closing the gap: the clock is set by the slowest pipeline stage, so every step cuts the logic between two registers', { size: 13, weight: 700 });
  data.steps.forEach(([what, how, status], i) => {
    const y = py + 52 + i * 26;
    const col = status === 'done' ? C.M : status === 'measured' ? C.F1 : C.faint;
    pill(36, y - 13, status, col, { size: 10, w: 84 });
    text(134, y, what, { size: 11.5, weight: 700 });
    text(560, y, how, { size: 11, fill: C.sub });
  });
  return g.done();
}

// =============================================================================
// The multiply/divide unit: state machine, Wallace step, divider, SIGN cycle
// =============================================================================
export function multiplyDivideUnit() {
  const W = 1600, H = 990;
  const g = canvas(W, H, 'The multiply/divide unit: short steps, no carry chains, a registered result',
    'src/Iterative_Multiply_Divide_Unit.sv + src/Carry_Save_Multiplier.sv + src/Leading_Zero_Counter.sv. EXECUTE holds the M instruction (MULTIPLY_DIVIDE_STALL) until DONE.');
  const { add, text, rect, box, wire, circle, pill } = g;
  // ---- state machine
  const sy = 190;
  const states = [['IDLE', 90, 'capture |A|, |B|', '(signs: DECODE)', C.sub], ['PREPARE', 330, 'count leading zeros', 'load step registers', C.F1],
    ['ALIGN', 570, 'divide only:', 'dividend << zeros', C.D], ['BUSY', 830, 'multiply: 4 steps', 'divide: 1 bit / step', C.E], ['SIGN', 1090, 'sum carry-save pair,', 'negate, pick result', C.M], ['DONE', 1350, 'READY = 1', 'registered result', C.W]];
  states.forEach(([n, x, l1, l2, col], i) => {
    add(`<circle cx="${x}" cy="${sy}" r="58" fill="${col}" fill-opacity="0.12" stroke="${col}" stroke-width="2.4"/>`);
    text(x, sy - 8, n, { size: 15, weight: 800, anchor: 'middle', fill: col });
    text(x, sy + 12, l1, { size: 10.5, anchor: 'middle', fill: C.sub });
    text(x, sy + 26, l2, { size: 10.5, anchor: 'middle', fill: C.sub });
    if (i < states.length - 1) wire([[x + 60, sy], [states[i + 1][1] - 62, sy]], 'data', { width: 2 });
  });
  add(`<path d="M${830 - 30},${sy - 52} C${830 - 70},${sy - 120} ${830 + 70},${sy - 120} ${830 + 30},${sy - 52}" fill="none" stroke="${C.E}" stroke-width="2" marker-end="url(#m-E)"/>`);
  text(830, sy - 104, 'repeat N times', { size: 11, anchor: 'middle', fill: C.E, weight: 700 });
  add(`<path d="M${330 + 40},${sy + 44} C${400},${sy + 88} ${760},${sy + 88} ${830 - 40},${sy + 44}" fill="none" stroke="${C.F1}" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#m-F1)"/>`);
  text(580, sy + 64, 'multiply skips ALIGN', { size: 11, anchor: 'middle', fill: C.F1 });
  add(`<path d="M1350,${sy + 58} C1300,${sy + 118} 140,${sy + 118} 90,${sy + 58}" fill="none" stroke="${C.sub}" stroke-width="1.4" stroke-dasharray="4 4" marker-end="url(#m-sub)"/>`);
  text(720, sy + 124, 'the instruction leaves EXECUTE; the unit waits for the next one', { size: 11, anchor: 'middle', fill: C.sub });
  pill(1430, sy - 30, 'multiply: 8 cycles', C.E, { size: 11, w: 150 }); pill(1430, sy + 2, 'divide: 5 + bits', C.D, { size: 11, w: 150 }); text(1430, sy + 44, 'bits = significant', { size: 10, fill: C.faint }); text(1430, sy + 58, 'bits of |A|', { size: 10, fill: C.faint });

  // ---- multiply datapath
  const my = 340;
  rect(20, my, 760, 360, { fill: '#FFF', stroke: C.line, rx: 10 });
  text(36, my + 26, 'Multiply: 4 steps of 64 x 16 bits, the product kept as TWO numbers (carry-save)', { size: 14, weight: 700 });
  box(40, my + 50, 160, 56, 'MULTIPLICAND', ['|A|, 64 bits'], { tsize: 12 });
  // product registers as bars
  const bar = (x, y, name, col) => {
    rect(x, y, 380, 30, { fill: '#FFF', stroke: col, sw: 1.6, rx: 4 });
    rect(x, y, 200, 30, { fill: col, stroke: 'none', op: 0.12, rx: 4 });
    text(x + 100, y + 20, 'high part [133:64], 70 bits', { size: 10.5, anchor: 'middle', fill: C.ink });
    text(x + 290, y + 20, 'low [63:0]', { size: 10.5, anchor: 'middle', fill: C.ink });
    text(x - 8, y + 20, name, { size: 11, anchor: 'end', weight: 700, fill: col, mono: true });
  };
  bar(360, my + 52, 'PRODUCT_SUM', C.E); bar(360, my + 92, 'PRODUCT_CARRY', C.E);
  text(380, my + 150, 'low 16 bits of PRODUCT_SUM =', { size: 10.5, anchor: 'middle', fill: C.sub });
  text(380, my + 164, 'the next multiplier bits', { size: 10.5, anchor: 'middle', fill: C.sub });
  rect(120, my + 180, 540, 110, { fill: '#FFF4E0', stroke: C.E, sw: 2, rx: 10 });
  text(390, my + 204, 'CarrySaveMultiplyStep (a Wallace tree)', { size: 13, weight: 700, anchor: 'middle', fill: C.E });
  text(390, my + 224, '16 partial products (A << j if bit j) + sum + carry = 18 numbers', { size: 11, anchor: 'middle', fill: C.sub });
  // mini level strip
  const lv = [18, 12, 8, 6, 4, 3, 2];
  lv.forEach((n, i) => { const x = 160 + i * 70; rect(x, my + 238, 50, 36, { fill: C.E, stroke: 'none', op: 0.15 + i * 0.1, rx: 6 }); text(x + 25, my + 261, String(n), { size: 13, weight: 700, anchor: 'middle' }); if (i < lv.length - 1) wire([[x + 50, my + 256], [x + 70, my + 256]], 'E', { width: 1.4 }); });
  text(390, my + 286, '6 levels of full adders, no carry propagation at all', { size: 10.5, anchor: 'middle', fill: C.sub });
  wire([[120, my + 106], [120, my + 180]], 'data'); wire([[560, my + 122], [560, my + 180]], 'data');
  wire([[640, my + 235], [700, my + 235], [700, my + 67], [742, my + 67]], 'E', { width: 2 });
  text(690, my + 310, 'each step: {sum, carry} go back in, shifted right by 16', { size: 10.5, fill: C.E, anchor: 'end' });
  wire([[660, my + 290], [720, my + 290], [720, my + 107], [742, my + 107]], 'E', { width: 2 });
  text(40, my + 334, 'Why carry-save: adding the two numbers every step would put an 80-bit carry chain in the loop. They are added only once, in SIGN.', { size: 11, fill: C.sub });
  text(40, my + 348, 'Measured: 747 ps (16 rows of ripple adders) -> 597 ps (tree) -> off the critical path (carry-save + SIGN).', { size: 11, fill: C.sub, weight: 600 });

  // ---- divide datapath
  const dx = 800;
  rect(dx, my, 780, 360, { fill: '#FFF', stroke: C.line, rx: 10 });
  text(dx + 16, my + 26, 'Divide: skip the leading zeros, then one quotient bit per cycle', { size: 14, weight: 700 });
  box(dx + 20, my + 50, 210, 70, 'LeadingZeroCounter', ['tree: 64 -> 32 -> ... -> 1 block', '6 levels (Oklobdzija)'], { tsize: 12, stroke: C.F1 });
  box(dx + 260, my + 50, 150, 70, 'ALIGN cycle', ['|A| << zeros', '(registered count)'], { tsize: 12, stroke: C.D });
  box(dx + 440, my + 50, 320, 70, 'steps = 64 - zeros', ['1234 / 10 needs 11 steps, not 64', '(printing decimals divides small numbers)'], { tsize: 12 });
  wire([[dx + 230, my + 85], [dx + 260, my + 85]], 'data'); wire([[dx + 410, my + 85], [dx + 440, my + 85]], 'data');
  rect(dx + 20, my + 150, 740, 150, { fill: '#F3F0FF', stroke: C.D, sw: 1.8, rx: 10 });
  text(dx + 390, my + 174, 'One BUSY step (restoring division)', { size: 13, weight: 700, anchor: 'middle', fill: C.D });
  box(dx + 40, my + 190, 200, 60, 'bring down a bit', ['{remainder, next bit}'], { tsize: 12 });
  box(dx + 270, my + 190, 220, 60, 'subtract |B|', ['65-bit Kogge-Stone'], { tsize: 12 });
  box(dx + 520, my + 190, 220, 60, 'no borrow?', ['quotient bit = 1, keep it'], { tsize: 12 });
  wire([[dx + 240, my + 220], [dx + 270, my + 220]], 'data'); wire([[dx + 490, my + 220], [dx + 520, my + 220]], 'data');
  wire([[dx + 630, my + 250], [dx + 630, my + 282], [dx + 140, my + 282], [dx + 140, my + 250]], 'D', { width: 1.6 });
  text(dx + 390, my + 296, 'next cycle', { size: 10.5, anchor: 'middle', fill: C.D });
  text(dx + 16, my + 330, 'Measured: the old "is the top half zero? then shift" chain was 599 ps; the counter tree + a separate ALIGN', { size: 11, fill: C.sub });
  text(dx + 16, my + 348, 'cycle took it off the critical path (one extra cycle per divide).', { size: 11, fill: C.sub });

  // ---- SIGN cycle
  const gy = 720;
  rect(20, gy, W - 40, 250, { fill: '#FFF', stroke: C.line, rx: 10 });
  text(36, gy + 26, 'SIGN: one 128-bit adder sums the carry-save pair AND negates it, then the result is registered', { size: 14, weight: 700 });
  box(40, gy + 50, 190, 60, 'PRODUCT_SUM [127:0]', [], { tsize: 11.5 }); box(40, gy + 124, 190, 60, 'PRODUCT_CARRY [127:0]', [], { tsize: 11.5 });
  box(260, gy + 86, 190, 64, '3:2 row of full adders', ['third input: NEG ? all ones : 0'], { tsize: 11.5, stroke: C.M });
  box(480, gy + 86, 190, 64, '128-bit Kogge-Stone', ['one carry-propagate add'], { tsize: 11.5, stroke: C.M });
  box(700, gy + 86, 160, 64, 'XOR with NEG', ['-(x + y) = ~(x + y - 1)'], { tsize: 11.5, stroke: C.M });
  box(890, gy + 86, 200, 64, 'pick the result', ['low / high half, word, quotient,', 'remainder, x/0, MIN/-1 cases'], { tsize: 11.5 });
  box(1120, gy + 86, 200, 64, 'RESULT_REGISTER', ['read in DONE: nothing slow', 'in front of forwarding'], { tsize: 11.5, stroke: C.W });
  wire([[230, gy + 80], [245, gy + 80], [245, gy + 110], [260, gy + 110]], 'data'); wire([[230, gy + 154], [245, gy + 154], [245, gy + 126], [260, gy + 126]], 'data');
  wire([[450, gy + 118], [480, gy + 118]], 'data'); wire([[670, gy + 118], [700, gy + 118]], 'data'); wire([[860, gy + 118], [890, gy + 118]], 'data'); wire([[1090, gy + 118], [1120, gy + 118]], 'data');
  text(1350, gy + 90, 'Signs: the unit works on |A| and |B|;', { size: 11, fill: C.sub }); text(1350, gy + 106, 'the product is negated when', { size: 11, fill: C.sub }); text(1350, gy + 122, 'exactly one input was negative.', { size: 11, fill: C.sub });
  text(36, gy + 214, 'Why this works: -(x + y) = ~(x + y) + 1 = ~(x + y + (-1)). Adding "all ones" as a third number costs one row of full adders, not a second adder.', { size: 11.5, fill: C.sub });
  text(36, gy + 234, 'Quotient and remainder use a prefix negation (src/Prefix_Negate.sv) in the same cycle. The registered result costs one cycle per M instruction and removed the M unit from the critical path.', { size: 11.5, fill: C.sub });
  return g.done();
}

// =============================================================================
// Operands and the ALU: early/late paths in DECODE, parallel units, fast and late results
// =============================================================================
export function operandsAndAlu() {
  const W = 1600, H = 950;
  const g = canvas(W, H, 'Operands and the ALU: what sits in the one-cycle loop, and what was moved out of it',
    'DECODE prepares both ALU operands (Zba shifts, .uw zero-extension, Zbs single bit, Zbb/Zbs inverted operand) and EXECUTE computes every operation in parallel. src/Riscv64.sv, src/ALU.sv.');
  const { add, text, rect, box, wire, dot, mux, pill } = g;
  rect(20, 72, 600, 32, { fill: C.D, stroke: C.D }); text(32, 93, 'DECODE', { size: 14, weight: 700, fill: '#FFF' });
  rect(650, 72, 600, 32, { fill: C.E, stroke: C.E }); text(662, 93, 'EXECUTE', { size: 14, weight: 700, fill: '#FFF' });
  rect(1280, 72, 300, 32, { fill: C.M, stroke: C.M }); text(1292, 93, 'MEMORY', { size: 14, weight: 700, fill: '#FFF' });
  // ---- operand A in DECODE
  const oy = 130;
  text(36, oy + 10, 'operand A', { size: 13, weight: 700 });
  box(36, oy + 24, 150, 40, 'register file', [], { tsize: 11 }); box(36, oy + 72, 150, 40, 'WRITEBACK', [], { tsize: 11 }); box(36, oy + 120, 150, 40, 'MEMORY', [], { tsize: 11 });
  mux(210, oy + 20, 26, 150, 'early');
  [44, 92, 140].forEach(y => wire([[186, oy + y], [210, oy + y]], 'data', { width: 1.4 }));
  box(256, oy + 60, 150, 70, 'prepare', ['zext(rs1[31:0])?', '<< 0, 1, 2 or 3'], { tsize: 11.5 });
  wire([[236, oy + 95], [256, oy + 95]], 'data');
  mux(420, oy + 40, 24, 100, 'PC?');
  wire([[406, oy + 95], [420, oy + 95]], 'data'); text(410, oy + 56, 'PC', { size: 9.5, anchor: 'end', fill: C.sub, mono: true });
  box(256, oy + 170, 150, 60, 'prepare (one-hot)', ['same, 1 small mux'], { tsize: 11.5, stroke: C.E });
  mux(480, oy + 60, 26, 130, 'late?', [], { stroke: C.E });
  wire([[444, oy + 90], [480, oy + 90]], 'data'); wire([[406, oy + 200], [460, oy + 200], [460, oy + 170], [480, oy + 170]], 'E', { width: 2.4 });
  box(530, oy + 95, 90, 60, 'ALU_INPUT_A', ['register'], { tsize: 10.5 });
  wire([[506, oy + 125], [530, oy + 125]], 'data');
  // ---- operand B
  const by = 400;
  text(36, by + 10, 'operand B', { size: 13, weight: 700 });
  box(36, by + 24, 150, 90, 'register file / W / M', ['same early choice'], { tsize: 11 });
  mux(206, by + 20, 24, 90, 'imm?'); wire([[186, by + 64], [206, by + 64]], 'data');
  box(256, by + 34, 150, 60, 'bit? invert?', ['bset: 1<<rs2  andn: ~rs2', 'bclr: ~(1<<rs2)'], { tsize: 11.5, lsize: 9.5 });
  wire([[230, by + 64], [256, by + 64]], 'data'); wire([[406, by + 65], [444, by + 65]], 'data', { arrow: false });
  box(256, by + 130, 150, 50, 'bit? invert? (late)', [], { tsize: 11.5, stroke: C.E });
  mux(480, by + 40, 26, 110, 'late?', [], { stroke: C.E });
  wire([[444, by + 65], [480, by + 65]], 'data'); wire([[406, by + 155], [460, by + 155], [460, by + 130], [480, by + 130]], 'E', { width: 2.4 });
  box(530, by + 65, 90, 60, 'ALU_INPUT_B', ['register'], { tsize: 10.5 });
  wire([[506, by + 95], [530, by + 95]], 'data');
  rect(36, 640, 580, 110, { fill: '#FFF8E1', stroke: '#E0B03A', rx: 8 });
  text(52, 664, 'Why split early and late?', { size: 13, weight: 700 });
  ['Every source but EXECUTE is ready early in the cycle: all the muxing and preparing happens then.', 'The value forwarded from EXECUTE is the ALU output of this same cycle, the latest', 'signal of all: it passes through only one small prepare mux and one 2:1.'].forEach((s, i) => text(52, 688 + i * 18, s, { size: 11.5, fill: C.sub }));
  // ---- ALU units
  const ux = 680, uy = 130;
  const units = [['Kogge-Stone adder', 'add sub slt jalr, addresses', C.E, 'SUBTRACT decoded in DECODE'], ['logic', 'and or xor (andn orn xnor)', C.sub, ''], ['shifter / rotator', 'sll srl sra, rol ror, W forms', C.sub, ''],
    ['LeadingZeroCounter x 2', 'clz, ctz (mirror image), W', C.F1, '6-level tree'], ['byte ops', 'rev8 orc.b sext.b/h zext.h', C.sub, 'wires and 8-input ORs'], ['PopulationCount', 'cpop cpopw: 4 quarter counts', C.flush, 'MEMORY adds them up'], ['min / max', 'the adder\'s compare picks A or B', C.flush, 'steers all 64 bits']];
  units.forEach(([n, d, col, note], i) => {
    const y = uy + i * 76;
    box(ux, y, 250, 64, n, note ? [d, note] : [d], { tsize: 12, stroke: col, lsize: 10 });
  });
  wire([[620, oy + 125], [650, oy + 125], [650, uy + 450], [680, uy + 450]], 'data', { width: 1.4 });
  wire([[650, uy + 32], [680, uy + 32]], 'data', { width: 1.4 }); wire([[650, uy + 108], [680, uy + 108]], 'data', { width: 1.4 }); wire([[650, uy + 184], [680, uy + 184]], 'data', { width: 1.4 });
  wire([[650, uy + 260], [680, uy + 260]], 'data', { width: 1.4 }); wire([[650, uy + 336], [680, uy + 336]], 'data', { width: 1.4 }); wire([[650, uy + 412], [680, uy + 412]], 'data', { width: 1.4 });
  wire([[620, by + 95], [640, by + 95]], 'data', { width: 1.4, arrow: false }); dot(650, by + 95);
  // fast mux: others first, adder last
  mux(1040, uy + 60, 30, 260, 'others', []);
  [108, 184, 260, 336].forEach(y => wire([[930, uy + y], [1040, uy + y]], 'data', { width: 1.2 }));
  mux(1110, uy + 10, 28, 110, 'fast', [], { stroke: C.E });
  wire([[930, uy + 32], [1110, uy + 32]], 'E', { width: 2.4 }); wire([[1070, uy + 190], [1090, uy + 190], [1090, uy + 100], [1110, uy + 100]], 'data');
  text(1124, uy + 140, 'adder enters', { size: 10, fill: C.E, anchor: 'middle' }); text(1124, uy + 153, 'LAST', { size: 10, fill: C.E, anchor: 'middle', weight: 700 });
  box(1160, uy + 30, 150, 50, 'ALUOutFast', [], { tsize: 12, stroke: C.E });
  wire([[1138, uy + 65], [1160, uy + 55]], 'E', { width: 2.4 });
  wire([[1235, uy + 30], [1235, 118], [140, 118], [140, oy + 200 - 30], [256, oy + 200]], 'E', { width: 2.2, dash: '7 4' });
  text(1320, uy + 50, 'to DECODE (forwarded the', { size: 11, fill: C.E, weight: 700 }); text(1320, uy + 66, 'same cycle), load/store', { size: 11, fill: C.E, weight: 700 }); text(1320, uy + 82, 'addresses and JALR', { size: 11, fill: C.E, weight: 700 });
  // late mux
  mux(1180, uy + 380, 30, 110, 'late', [], { stroke: C.flush });
  wire([[930, uy + 412], [1180, uy + 412]], 'flush', { width: 1.6 }); wire([[930, uy + 488], [1150, uy + 488], [1150, uy + 460], [1180, uy + 460]], 'flush', { width: 1.6 });
  wire([[1235, uy + 80], [1235, uy + 395], [1210, uy + 395]], 'data', { width: 1.4 });
  box(1300, uy + 400, 140, 60, 'ALUOut', ['everything'], { tsize: 12 });
  wire([[1210, uy + 435], [1300, uy + 430]], 'data');
  box(1300, uy + 500, 260, 70, 'MEMORY_ALU_RESULT', ['forwarded from MEMORY next cycle'], { tsize: 12, stroke: C.M });
  wire([[1370, uy + 460], [1370, uy + 500]], 'data');
  // late explanation
  rect(680, 730, 900, 200, { fill: '#FFF', stroke: C.line, rx: 8 });
  text(696, 754, 'The two-cycle results (EXECUTE_LATE_RESULT): cpop, cpopw, min, minu, max, maxu', { size: 13, weight: 700 });
  ['Their logic is deeper than the adder path, so they leave through ALUOut only. For hazards they behave exactly like a load:', 'the next instruction may not take them from EXECUTE, and LOAD_STALL holds it one cycle if it needs them right away.', 'Measured: with them in the loop the clock was 758 ps (a popcount tree, then a 64-bit select); with them out: 523 ps. cpop now adds its partial counts in MEMORY.'].forEach((s, i) => text(696, 778 + i * 18, s, { size: 11.5, fill: C.sub }));
  // mini pipeline example
  const ex = [['cpop t1, t0', ['F1', 'F2', 'D', 'E', 'M', 'W', '']], ['addi t2, t1, 1', ['', 'F1', 'F2', 'D', 'D', 'E', 'M']]];
  ex.forEach(([n, st], r) => {
    text(696, 850 + r * 30, n, { size: 11.5, mono: true });
    st.forEach((s, c) => { if (!s) return; const col = { F1: C.F1, F2: C.F2, D: C.D, E: C.E, M: C.M, W: C.W }[s]; rect(850 + c * 44, 836 + r * 30, 40, 22, { fill: col, stroke: 'none', rx: 4, op: r === 1 && c === 3 ? 0.45 : 0.9 }); text(870 + c * 44, 851 + r * 30, s, { size: 10.5, weight: 700, anchor: 'middle', fill: '#FFF' }); });
  });
  text(1180, 866, 'one stall, then t1 comes from MEMORY', { size: 11, fill: C.sub });
  text(696, 916, 'The same trick every real core uses for longer operations: pipeline them, and let the hazard logic wait.', { size: 11, fill: C.faint });
  return g.done();
}

// =============================================================================
// Performance counters: where each term of the cycle equation is counted
// =============================================================================
export function performanceCounters(values) {
  const W = 1600, H = 640;
  const g = canvas(W, H, 'Hardware performance counters: the cycle equation, counted by the chip itself',
    'cycles = N + 5 + L + 3F + R + K + I + D (docs/MATH.md). Each term has a read-only counter in src/Control_Status_Register_File.sv, readable with csrr.');
  const { add, text, rect, box, wire, pill } = g;
  const st = [['FETCH1', C.F1], ['FETCH2', C.F2], ['DECODE', C.D], ['EXECUTE', C.E], ['MEMORY', C.M], ['WRITEBACK', C.W]];
  st.forEach(([n, col], i) => { rect(40 + i * 250, 80, 230, 40, { fill: col, stroke: col }); text(52 + i * 250, 106, n, { size: 14, weight: 700, fill: '#FFF' }); });
  const ctr = [
    ['I', 'hpmcounter7', '0xC07', 'instruction-cache miss cycles', 0, C.F1, 'TRACE_INSTRUCTION_MISS', values.I],
    ['R', 'hpmcounter5', '0xC05', 'FETCH2 redirects', 1, C.F2, 'TRACE_REDIRECT', values.R],
    ['L', 'hpmcounter3', '0xC03', 'load (and late-result) stalls', 2, C.D, 'TRACE_LOAD_STALL', values.L],
    ['F', 'hpmcounter4', '0xC04', 'flushes (3 bubbles each)', 3, C.flush, 'TRACE_FLUSH', values.F],
    ['K', 'hpmcounter6', '0xC06', 'multiply/divide busy cycles', 3, C.E, 'TRACE_MULTIPLY_DIVIDE_STALL', values.K],
    ['D', 'hpmcounter8', '0xC08', 'data-cache miss cycles', 3, C.M, 'TRACE_DATA_MISS', values.D],
    ['N', 'instret', '0xC02', 'instructions retired', 5, C.W, 'WRITEBACK_VALID', values.N],
  ];
  ctr.forEach(([term, name, addr, what, stage, col, sig, v], i) => {
    const x = 40 + i * 218, y = 190;
    wire([[40 + stage * 250 + 115, 120], [40 + stage * 250 + 115, 150], [x + 100, 150], [x + 100, y]], 'data', { width: 1.4 });
    rect(x, y, 200, 150, { fill: '#FFF', stroke: col, sw: 2, rx: 10 });
    text(x + 16, y + 40, term, { size: 32, weight: 800, fill: col });
    text(x + 60, y + 26, name, { size: 12, weight: 700, mono: true });
    text(x + 60, y + 42, addr, { size: 11, mono: true, fill: C.faint });
    text(x + 16, y + 70, what, { size: 11, fill: C.sub });
    text(x + 16, y + 88, sig, { size: 9, mono: true, fill: C.faint });
    text(x + 16, y + 132, String(v), { size: 22, weight: 700, mono: true, fill: col });
    text(x + 186, y + 132, 'in prog 19', { size: 9.5, anchor: 'end', fill: C.faint });
  });
  // stacked bar of program 19's cycles
  const total = Math.max(values.cycles, values.sum), bx = 40, bw = W - 80, byy = 420, gap = values.sum - values.cycles;
  text(40, byy - 30, `Program 19 at the moment it reads the counters: rdcycle says ${values.cycles}; the counters add up to ${values.N} + 5 + ${values.L} + 3 x ${values.F} + ${values.R} + ${values.K} + ${values.I} + ${values.D} = ${values.sum}.`, { size: 13, weight: 700 });
  text(40, byy - 12, gap === 0 ? 'Exactly equal.' : `The ${Math.abs(gap)}-cycle difference: ${gap > 0 ? 'some counted bubbles and instructions have not reached WRITEBACK yet when rdcycle is read in EXECUTE' : 'a few cycles in flight are not counted yet'}. At the end of a program the two sides are exactly equal (make math).`, { size: 11.5, fill: C.sub });
  const parts = [['N', values.N, C.W], ['fill', 5, C.faint], ['L', values.L, C.D], ['3F', 3 * values.F, C.flush], ['R', values.R, C.F2], ['K', values.K, C.E], ['I', values.I, C.F1], ['D', values.D, C.M]];
  let x = bx;
  parts.forEach(([n, v, col]) => {
    const w = bw * v / total;
    rect(x, byy, w - 1, 44, { fill: col, stroke: 'none', rx: 3, op: 0.85 });
    if (w > 34) { text(x + w / 2, byy + 20, n, { size: 12, weight: 700, anchor: 'middle', fill: '#FFF' }); text(x + w / 2, byy + 36, String(v), { size: 11, anchor: 'middle', fill: '#FFF', mono: true }); }
    x += w;
  });
  text(40, byy + 80, 'How to use them: read a counter before and after a piece of code (csrr t0, hpmcounter4 ... csrr t1, hpmcounter4); the difference is how many', { size: 12, fill: C.sub });
  text(40, byy + 98, 'times that event happened in between. programs/19_performance_counters.s adds them all up and checks the sum against rdcycle.', { size: 12, fill: C.sub });
  text(40, byy + 116, 'Real CPUs have hundreds of such events (Intel\'s "top-down" method builds exactly this kind of CPI stack from them); the counters are 64 bits,', { size: 12, fill: C.sub });
  text(40, byy + 134, 'split into halves with a registered carry so they never slow down the clock.', { size: 12, fill: C.sub });
  return g.done();
}

// An interrupt in the pipeline, cycle by cycle, from the model running programs/21_timer_interrupts.s
export async function interruptDiagram() {
  const { assemble } = await import('../model/asm.js');
  const { Core, CONFIGS, STAGES } = await import('../model/core.js');
  const core = new Core(assemble(fs.readFileSync(new URL('../programs/21_timer_interrupts.s', import.meta.url), 'utf8')), CONFIGS.performance);
  const evs = core.run(200000, true);
  // the second interrupt (the first one is still paying cold-cache misses in its handler)
  const hits = evs.map((e, i) => (e.interruptTaken ? i : -1)).filter(i => i >= 0);
  const i0 = hits[1], first = i0 - 2, last = Math.min(evs.length - 1, i0 + 21);
  const window = evs.slice(first, last + 1);
  const ids = [];
  for (const e of window) for (const st of STAGES) { const x = e.stages[st]; if (x && !ids.includes(x.id)) ids.push(x.id); }
  ids.sort((a, b) => a - b);
  const col = { FETCH1: C.F1, FETCH2: C.F2, DECODE: C.D, EXECUTE: C.E, MEMORY: C.M, WRITEBACK: C.W };
  const SH = { FETCH1: 'F1', FETCH2: 'F2', DECODE: 'D', EXECUTE: 'E', MEMORY: 'M', WRITEBACK: 'W' };
  const lx = 330, cw = 38, rh = 22, top = 120, W = lx + window.length * cw + 40, H = top + ids.length * rh + 200;
  const g = canvas(W, H, 'An interrupt, cycle by cycle: replace the DECODE instruction, trap, handle, return',
    `programs/21_timer_interrupts.s on the cycle-exact model (performance build), cycles ${first + 1} to ${last + 1}. Every cell is what the RTL does too (make test).`);
  const { add, text, rect } = g;
  window.forEach((e, k) => text(lx + k * cw + cw / 2, top - 10, String(e.cycle), { size: 9.5, anchor: 'middle', mono: true, fill: C.faint }));
  text(lx - 10, top - 10, 'cycle', { size: 10, anchor: 'end', fill: C.faint });
  const intCycle = i0 - first;
  add(`<rect x="${lx + intCycle * cw}" y="${top - 4}" width="${cw}" height="${ids.length * rh + 8}" fill="${C.flush}" fill-opacity="0.07"/>`);
  add(`<rect x="${lx + (intCycle + 1) * cw}" y="${top - 4}" width="${cw}" height="${ids.length * rh + 8}" fill="${C.flush}" fill-opacity="0.13"/>`);
  ids.forEach((id, r) => {
    const ins = core.instrs[id], y = top + r * rh;
    const isReplaced = window.some(e => e.interruptTaken && e.stages.DECODE && e.stages.DECODE.id === id);
    const label = `${(ins.pc >>> 0).toString(16).padStart(4, '0')}  ${ins.text}`;
    text(lx - 10, y + 15, label.length > 42 ? label.slice(0, 41) + '…' : label, { size: 10.5, anchor: 'end', mono: true, fill: ins.squashed ? C.faint : C.ink });
    if (isReplaced) text(18, y + 15, 'replaced', { size: 9.5, fill: C.flush, weight: 700 });
    window.forEach((e, k) => {
      for (const st of STAGES) {
        const x = e.stages[st];
        if (!x || x.id !== id) continue;
        const pseudo = st === 'EXECUTE' && e.interrupt && isReplaced;
        const c = pseudo ? C.flush : col[st];
        add(`<rect x="${lx + k * cw + 2}" y="${y + 2}" width="${cw - 4}" height="${rh - 4}" rx="4" fill="${c}" fill-opacity="${ins.squashed && !pseudo ? 0.25 : 0.9}"/>`);
        text(lx + k * cw + cw / 2, y + 15, pseudo ? 'INT' : SH[st], { size: 9.5, anchor: 'middle', weight: 700, fill: ins.squashed && !pseudo ? c : '#FFF' });
      }
    });
  });
  const ny = top + ids.length * rh + 30;
  const notes = [
    [C.flush, `cycle ${evs[i0].cycle}: the timer interrupt is pending and enabled, so the instruction in DECODE does not go on: an interrupt pseudo-instruction takes its place.`],
    [C.flush, `cycle ${evs[i0 + 1].cycle}: in EXECUTE it traps like ecall: mepc = the replaced instruction, mcause = 2^63 + 7, MIE off, jump to mtvec; FETCH1..DECODE are flushed.`],
    [C.E, 'It never retires (MEMORY gets a bubble): an interrupt costs 4 cycles, the X term of cycles = N + 5 + L + 3F + R + K + I + D + X.'],
    [C.M, 'The handler moves MTIMECMP forward and runs mret, a flush back to mepc: the replaced instruction runs now, and the loop never notices.'],
    [C.faint, 'Faded rows were fetched and then squashed; their slots are the bubbles the equation counts.'],
  ];
  notes.forEach(([c, t], i) => { add(`<circle cx="30" cy="${ny + i * 22 - 4}" r="5" fill="${c}"/>`); text(44, ny + i * 22, t, { size: 11.5, fill: C.sub }); });
  return g.done();
}

// A tiny preemptive kernel: who runs when, the task control blocks, and one context switch (programs/22)
export async function multitaskingDiagram() {
  const { assemble } = await import('../model/asm.js');
  const { Core, CONFIGS } = await import('../model/core.js');
  const img = assemble(fs.readFileSync(new URL('../programs/22_multitasking.s', import.meta.url), 'utf8'));
  const sym = img.symbols;
  const core = new Core(img, CONFIGS.performance);
  const evs = core.run(500000, true);
  const owner = pc => pc >= sym.task2 && pc < sym.message ? 2 : pc >= sym.task1 && pc < sym.task2 ? 1 : pc >= sym.task0 && pc < sym.task1 ? 0 : pc >= sym.task_done && pc < sym.task0 ? 3 : 4; // 3 = sleeping, 4 = kernel
  // who retires an instruction in each cycle (idle cycles inherit the last owner)
  let last = 4; const who = evs.map(e => (e.stages.WRITEBACK ? (last = owner(e.stages.WRITEBACK.pc)) : last));
  const segs = []; who.forEach((w, c) => { const t = segs[segs.length - 1]; if (t && t.w === w) t.end = c + 1; else segs.push({ w, start: c, end: c + 1 }); });
  const kernelCycles = who.filter(w => w === 4).length, switches = evs.filter(e => e.interrupt).length;
  const W = 1500, H = 860, x0 = 150, x1 = W - 40;
  const g = canvas(W, H, 'A tiny operating system: three tasks, one CPU, a context switch every 600 cycles',
    `programs/22_multitasking.s on the cycle-exact model: ${switches} timer interrupts, ${evs.length.toLocaleString('en-US')} cycles, ${(100 * kernelCycles / evs.length).toFixed(1)}% of them in the kernel. make test checks it on the RTL too.`);
  const { add, text, rect, box, wire } = g;
  const TC = [C.F1, C.M, C.E, '#B8C2BA', C.flush], TN = ['task 0: primes', 'task 1: squares', 'task 2: prints', 'finished, asleep', 'kernel'];
  // 1. timeline, in two rows: the first 12,000 cycles, then the whole run
  const strip = (y, from, to, label) => {
    text(x0 - 12, y + 22, label, { size: 11.5, anchor: 'end', weight: 700 });
    const sx = c => x0 + (c - from) / (to - from) * (x1 - x0);
    for (const t of segs) { if (t.end <= from || t.start >= to) continue; const a = Math.max(t.start, from), b = Math.min(t.end, to);
      add(`<rect x="${sx(a).toFixed(2)}" y="${y}" width="${Math.max(0.6, sx(b) - sx(a)).toFixed(2)}" height="34" fill="${TC[t.w]}"/>`); }
    for (let k = 0; k <= 6; k++) { const c = Math.round(from + (to - from) * k / 6); text(sx(c), y + 50, c.toLocaleString('en-US'), { size: 9.5, anchor: 'middle', mono: true, fill: C.faint }); }
  };
  text(x0, 94, 'Who is running (the instruction retiring in WRITEBACK), cycle by cycle', { size: 13, weight: 700 });
  strip(108, 0, 9000, 'cycles 0 - 9,000');
  strip(178, 0, evs.length, 'the whole run');
  TN.forEach((n, i) => { add(`<rect x="${x0 + i * 190}" y="244" width="14" height="14" rx="3" fill="${TC[i]}"/>`); text(x0 + i * 190 + 20, 256, n, { size: 11.5, fill: C.sub }); });
  // 2. task control blocks in a ring
  const ty = 300;
  text(40, ty, 'Task control blocks: everything a task needs to continue later', { size: 13, weight: 700 });
  const tcbs = [['tcb0', 'task 0', C.F1], ['tcb1', 'task 1', C.M], ['tcb2', 'task 2', C.E]];
  tcbs.forEach(([n, t, col], i) => {
    const bx = 40 + i * 250, by = ty + 20;
    rect(bx, by, 200, 250, { stroke: col, sw: 2 });
    text(bx + 100, by + 20, `${n} (${t})`, { size: 12, weight: 700, anchor: 'middle', fill: col });
    const rows = [['0', 'x1  ra'], ['8', 'x2  sp (own stack)'], ['16..232', 'x3 .. x30'], ['240', 'x31 t6'], ['248', 'pc (from mepc)'], ['256', 'done flag'], ['264', 'next -> ' + tcbs[(i + 1) % 3][0]]];
    rows.forEach(([o, f], r) => { rect(bx + 10, by + 34 + r * 29, 180, 25, { fill: r >= 4 ? '#FFF8E1' : '#FFF', stroke: C.line, rx: 3 }); text(bx + 16, by + 51 + r * 29, o, { size: 9.5, mono: true, fill: C.faint }); text(bx + 74, by + 51 + r * 29, f, { size: 10.5, mono: true }); });
    if (i < 2) wire([[bx + 200, by + 238], [bx + 250, by + 238]], 'sub', { width: 1.6 });
  });
  add(`<path d="M${40 + 2 * 250 + 200},${ty + 258} L${40 + 2 * 250 + 220},${ty + 258} L${40 + 2 * 250 + 220},${ty + 285} L20,${ty + 285} L20,${ty + 258} L40,${ty + 258}" fill="none" stroke="${C.sub}" stroke-width="1.6" marker-end="url(#m-sub)"/>`);
  text(400, ty + 300, 'round robin: the next pointers form a ring; mscratch holds the running task\'s block', { size: 11, anchor: 'middle', fill: C.sub });
  // 3. one context switch, step by step
  const sx0 = 800, sy = ty + 20;
  text(sx0, ty, 'One context switch (trap_handler), in order', { size: 13, weight: 700 });
  const avg = Math.round(kernelCycles / switches);
  const steps = [
    ['timer interrupt', 'mtime >= mtimecmp: the DECODE instruction is replaced, trap to mtvec (4 cycles)', C.flush],
    ['csrrw t6, mscratch, t6', 'swap: t6 = this task\'s block, the task\'s t6 is parked in mscratch', C.D],
    ['sd x1 .. x30, then t6, mepc', '32 stores into the block: the task is now frozen in memory', C.D],
    ['move MTIMECMP forward', 'the next switch in 600 cycles', C.flush],
    ['pick the next task', 'follow the next pointer, skip tasks that are done', C.sub],
    ['csrw mscratch; csrw mepc', 'the new task\'s block and where it continues', C.D],
    ['ld x1 .. x31', '31 loads: the new task\'s registers are back', C.D],
    ['mret', 'jump to mepc, MIE on again: the other task runs as if never stopped', C.M],
  ];
  steps.forEach(([t, d, col], i) => {
    const y = sy + i * 58;
    add(`<circle cx="${sx0 + 14}" cy="${y + 18}" r="13" fill="${col}"/>`);
    text(sx0 + 14, y + 23, String(i + 1), { size: 12, weight: 700, anchor: 'middle', fill: '#FFF' });
    text(sx0 + 38, y + 16, t, { size: 12, weight: 700, mono: true });
    text(sx0 + 38, y + 34, d, { size: 11, fill: C.sub });
  });
  text(sx0, sy + steps.length * 58 + 16, `About ${avg} cycles per switch on average (${kernelCycles.toLocaleString('en-US')} kernel cycles / ${switches} switches):`, { size: 11.5, weight: 600 });
  text(sx0, sy + steps.length * 58 + 34, 'the price of sharing the CPU. Real kernels also switch page tables and flush or tag the TLB.', { size: 11.5, fill: C.sub });
  return g.done();
}

export const FPGA_RESULTS = JSON.parse(fs.readFileSync(new URL('../docs/fpga_results.json', import.meta.url), 'utf8'));
export const CLOCK_DATA = JSON.parse(fs.readFileSync(new URL('../docs/clock_roadmap.json', import.meta.url), 'utf8'));

// The counter values program 19 reads, from the cycle-exact model (performance build)
async function program19Counters() {
  const { assemble } = await import('../model/asm.js');
  const { Core, CONFIGS } = await import('../model/core.js');
  const core = new Core(assemble(fs.readFileSync(new URL('../programs/19_performance_counters.s', import.meta.url), 'utf8')), CONFIGS.performance);
  core.run(100000, false);
  const r = i => Number(core.regs[i]);
  const v = { cycles: r(10), N: r(11), L: r(12), F: r(13), R: r(14), K: r(15), I: r(16), D: r(17) };
  v.sum = v.N + 5 + v.L + 3 * v.F + v.R + v.K + v.I + v.D;
  return v;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  fs.mkdirSync('docs/img/diagrams', { recursive: true });
  const figs = { branch_prediction: branchPrediction(), cache: cache(), memory_hierarchy: hierarchy(), clock_roadmap: clockRoadmap(CLOCK_DATA),
    multiply_divide: multiplyDivideUnit(), operands_and_alu: operandsAndAlu(), performance_counters: performanceCounters(await program19Counters()),
    cache_interfaces: cacheInterfaces(), memory_map: memoryMap(), boot_sequence: bootSequence(), fpga_system: fpgaSystem(FPGA_RESULTS), interrupt: await interruptDiagram(), multitasking: await multitaskingDiagram(),
    isa_encodings: await isaEncodings(), isa_pipelines: await isaPipelines() };
  for (const [n, svg] of Object.entries(figs)) { fs.writeFileSync(`docs/img/diagrams/${n}.svg`, svg); console.log(`wrote docs/img/diagrams/${n}.svg`); }
}

// =============================================================================
// The computer around the core: caches, main memory, devices, boot (docs/FPGA.md)
// =============================================================================

// How the two caches sit between the pipeline, main memory and the device registers
export function cacheInterfaces() {
  const W = 1440, H = 860;
  const g = canvas(W, H, 'How the caches connect the pipeline to main memory and to the devices',
    'Every signal that crosses a cache boundary, with its width. src/Riscv64_top.sv (simulation) and fpga/rtl/Sixfold_System.sv (FPGA) wire exactly these ports.');
  const { add, text, rect, box, wire, dot, mux, pill } = g;

  // Pipeline column
  const px = 40, pw = 250, stages = [['FETCH1', C.F1, 'PC, next-PC prediction'], ['FETCH2', C.F2, 'instruction register'], ['DECODE', C.D, 'registers, forwarding'],
    ['EXECUTE', C.E, 'ALU: load/store address'], ['MEMORY', C.M, 'LoadControl picks bytes'], ['WRITEBACK', C.W, 'register file write']];
  rect(px - 14, 96, pw + 28, 640, { fill: '#FFF', stroke: C.line, rx: 10 });
  text(px + pw / 2, 118, 'Riscv64 core (src/Riscv64.sv)', { size: 13, weight: 700, anchor: 'middle' });
  const sy = i => 138 + i * 98;
  stages.forEach(([n, col, s], i) => {
    rect(px, sy(i), pw, 70, { fill: col, stroke: col, op: 0.12 });
    text(px + 14, sy(i) + 26, n, { size: 14, weight: 700, fill: col });
    text(px + 14, sy(i) + 46, s, { size: 11, fill: C.sub });
  });
  for (let i = 0; i < 5; i++) wire([[px + pw / 2, sy(i) + 70], [px + pw / 2, sy(i + 1)]], 'sub', { width: 1.5 });

  const cx = 540, cw = 300, mx = 1140, mw = 280, dx = 930;
  box(cx, 110, cw, 210, 'Instruction cache', ['4 KiB, 2 ways x 64 sets x 32-byte lines', 'hit: the instruction in the same cycle', 'miss: refill engine, 11 cycles', 'then prefetch the next line', 'reset clears every valid bit'], { file: 'src/Instruction_Cache.sv', stroke: C.F1 });
  box(cx, 430, cw, 250, 'Data cache', ['4 KiB, 2 ways x 64 sets x 32-byte lines', 'load hit: the doubleword in the same cycle', 'load miss: DATA_CACHE_STALL, 11 cycles', 'store: write-through to main memory,', 'and into the line if it is cached', 'a prefetch waits one cycle for a store', '(one write per cycle into the arrays)'], { file: 'src/Data_Cache.sv', stroke: C.M });
  box(mx, 110, mw, 260, 'Main memory', ['64 KiB, 2048 lines x 256 bits', 'simulation: src/Scratchpad_Memory.sv', 'FPGA: fpga/rtl/Main_Memory.sv', 'two block-RAM copies: a store writes', 'both, each refill port reads its own', 'the line address is steady for the', 'whole refill, so 1-cycle block RAM', 'keeps up; the last store is merged in'], { stroke: C.edge });
  box(mx, 470, mw, 210, 'Device registers', ['0x1000_0000 .. 0x1000_00FF', 'PUTCHAR LEDS BUTTONS UART BOOT', 'CLOCK LAST_TOHOST LAST_CYCLES', 'BOOT_REASON TIMER BOOT_ADDRESS', 'never cached, never written to RAM', 'fpga/rtl/Sixfold_System.sv'], { stroke: C.flush });

  const lbl = (x, y, s, col, anchor = 'middle') => text(x, y, s, { size: 10.5, mono: true, fill: col, anchor, weight: 600 });
  const mid = (px + pw + cx) / 2 - 20;
  // Instruction side
  wire([[px + pw, sy(0) + 24], [cx, sy(0) + 24]], 'F1'); lbl(mid, sy(0) + 18, 'FETCH_ADDRESS [63:0] (the PC)', C.F1);
  wire([[cx, sy(1) + 30], [px + pw, sy(1) + 30]], 'F1'); lbl(mid, sy(1) + 24, 'INSTRUCTION [31:0]', C.F1);
  wire([[cx, 300], [505, 300], [505, sy(0) + 56], [px + pw, sy(0) + 56]], 'miss', { dash: '5 3' });
  lbl(512, 338, 'HIT = 0: FETCH1 holds (an I-cache miss bubble)', C.miss, 'start');

  // Data side
  wire([[px + pw, sy(3) + 18], [cx, sy(3) + 18]], 'E'); lbl(mid, sy(3) + 12, 'ADDRESS, LOAD_REQUEST', C.E);
  wire([[px + pw, sy(3) + 42], [cx, sy(3) + 42]], 'E'); lbl(mid, sy(3) + 36, 'WRITE_MASK, WRITE_DATA', C.E);
  wire([[cx, 660], [505, 660], [505, sy(3) + 62], [px + pw, sy(3) + 62]], 'miss', { dash: '5 3' });
  lbl(530, 697, 'HIT = 0: DATA_CACHE_STALL, FETCH1..EXECUTE hold', C.miss, 'start');
  mux(dx - 13, 560, 26, 90, '', []);
  lbl(dx + 18, 640, 'address[63:8]', C.flush, 'start'); lbl(dx + 18, 654, '= 0x1000_00 ?', C.flush, 'start');
  wire([[cx + cw, 590], [dx - 13, 590]], 'M'); lbl(cx + cw + 4, 584, 'READ_DATA', C.M, 'start');
  wire([[mx, 600], [dx + 13, 600]], 'flush'); lbl(mx - 8, 594, 'device value', C.flush, 'end');
  wire([[dx, 644], [dx, 724], [520, 724], [520, sy(4) + 40], [px + pw, sy(4) + 40]], 'M');
  lbl(530, 740, 'load data [63:0], registered into MEMORY', C.M, 'start');
  wire([[px + pw, sy(3) + 42], [470, sy(3) + 42], [470, 760], [mx + mw / 2, 760], [mx + mw / 2, 680]], 'flush', { dash: '6 3' });
  text(820, 776, 'a store to 0x1000_00xx goes to the device register instead of memory (the core cannot tell the difference)', { size: 10.5, fill: C.flush, anchor: 'middle' });

  // Refill ports and write-through
  wire([[cx + cw, 150], [mx, 150]], 'F1'); lbl((cx + cw + mx) / 2, 144, 'REFILL_ADDRESS (line)', C.F1);
  wire([[mx, 190], [cx + cw, 190]], 'F1'); lbl((cx + cw + mx) / 2, 184, 'REFILL_LINE [255:0] (8 instructions)', C.F1);
  wire([[cx + cw, 455], [940, 455], [940, 270], [mx, 270]], 'M'); lbl(946, 264, 'REFILL_ADDRESS', C.M, 'start');
  wire([[mx, 320], [970, 320], [970, 485], [cx + cw, 485]], 'M'); lbl(976, 314, 'REFILL_LINE [255:0]', C.M, 'start');
  wire([[cx + cw, 530], [1010, 530], [1010, 370]], 'E', { dash: '6 3' }); lbl(1016, 410, 'every store', C.E, 'start'); lbl(1016, 424, '(write-through)', C.E, 'start');

  rect(540, 790, 880, 54, { fill: '#FFF', stroke: C.line, rx: 8 });
  text(556, 812, 'Timing: a hit costs nothing; a miss costs 11 cycles (10-cycle main memory + 1). The model counts them as the I and D terms', { size: 11, fill: C.sub });
  text(556, 830, 'of cycles = N + 5 + L + 3F + R + K + I + D, and the FPGA system reports the same count: its memory answers in the same 10 cycles.', { size: 11, fill: C.sub });
  text(px, 812, 'solid: every cycle', { size: 10.5, fill: C.sub });
  text(px, 830, 'dashed: stall / store paths', { size: 10.5, fill: C.sub });
  return g.done();
}

// The address space: memory, the firmware's area, programs, device registers, and the CSRs
export function memoryMap() {
  const W = 1300, H = 900;
  const g = canvas(W, H, 'Memory map: what each address means',
    'Loads and stores reach memory and devices; CSR instructions reach the registers inside the core. Same map in simulation and on the FPGA.');
  const { add, text, rect, pill } = g;
  const x = 120, w = 300;
  const seg = (y, h, fill, title, lines, addrTop, addrBottom) => {
    rect(x, y, w, h, { fill, stroke: C.edge, op: 0.16, rx: 4 });
    text(x + 14, y + 22, title, { size: 13, weight: 700 });
    lines.forEach((s, i) => text(x + 14, y + 40 + i * 15, s, { size: 10.5, fill: C.sub }));
    if (addrTop) text(x - 8, y + 12, addrTop, { size: 10.5, mono: true, anchor: 'end', fill: C.ink });
    if (addrBottom) text(x - 8, y + h, addrBottom, { size: 10.5, mono: true, anchor: 'end', fill: C.ink });
  };
  text(x + w / 2, 92, 'addresses (64-bit, only these are used)', { size: 11, anchor: 'middle', fill: C.sub, weight: 600 });
  seg(104, 70, C.flush, 'Device registers (256 bytes)', ['0x1000_0000 .. 0x1000_00FF', 'never cached, never stored to RAM'], '0x1000_00FF', '0x1000_0000');
  text(x + w / 2, 196, '. . .  nothing here  . . .', { size: 11, anchor: 'middle', fill: C.faint, italic: true });
  seg(212, 330, C.M, 'Programs  0x2000 .. 0xFFFF  (56 KiB)', ['the assembler puts code at 0x2000 (PC_RESET)', 'then its data; programs set their own sp', 'loaded by the firmware ("l") on the FPGA,', 'from +HEX= in simulation'], '0xFFFF', '0x2000');
  seg(542, 90, C.D, 'Firmware stack  0x1000 .. 0x1FFF', ['grows down from 0x2000'], '', '0x1000');
  seg(632, 100, C.F1, 'Boot firmware  0x0000 .. 0x0FFF', ['fpga/firmware/bios.s (about 2 KiB)', 'RESET_VECTOR after power-on', '(zeros in simulation)'], '', '0x0000');
  text(x + w / 2, 754, 'main memory: 64 KiB (addresses wrap every 64 KiB)', { size: 11, anchor: 'middle', fill: C.sub });

  // Device table
  const tx = 500, ty = 104;
  const rows = [
    ['0x00', 'PUTCHAR', '0', 'print one character (UART on the FPGA)'],
    ['0x08', 'LEDS', 'the 16 LED bits', 'set the LEDs (sb: the low 8)'],
    ['0x10', 'BUTTONS', 'bit 0 centre, 2 up, 3 down, 4 left, 5 right', '-'],
    ['0x18', 'UART', 'bit0 byte waiting, bit1 queue full, bit2 idle, 15:8 byte', 'drop the received byte'],
    ['0x20', 'BOOT', '0', 'restart the core at BOOT_ADDRESS'],
    ['0x28', 'CLOCK', 'clock rate in Hz', '-'],
    ['0x30', 'LAST_TOHOST', 'TOHOST of the last program', '-'],
    ['0x38', 'LAST_CYCLES', 'cycles the last program ran', '-'],
    ['0x40', 'BOOT_REASON', '0 power-on, 1 program ended, 2 BOOT', '-'],
    ['0x48', 'TIMER', 'cycles since power-on', '-'],
    ['0x50', 'BOOT_ADDRESS', 'where BOOT starts (0x2000)', 'set it'],
    ['0x58', 'MTIME', 'the machine timer (cycles)', '-'],
    ['0x60', 'MTIMECMP', 'the timer interrupt time', 'set it: interrupt at MTIME >= it'],
    ['0x68', 'SWITCHES', 'the slide switches (16 on a Basys 3)', '-'],
    ['0x70', 'DISPLAY', 'the digits as written', 'set 4 digits: a byte of segments each'],
  ];
  const cols = [[0, 'offset'], [60, 'register'], [180, 'a load returns'], [500, 'a store does']];
  rect(tx - 12, ty - 4, 780, 48 + rows.length * 26, { fill: '#FFF', stroke: C.flush, rx: 8 });
  text(tx, ty + 16, 'Device registers at 0x1000_0000 + offset (8 bytes each; use ld / sd, or sb for PUTCHAR)', { size: 12.5, weight: 700, fill: C.flush });
  cols.forEach(([cx, h]) => text(tx + cx, ty + 36, h, { size: 10.5, weight: 700, fill: C.sub }));
  rows.forEach((r, i) => {
    const yy = ty + 56 + i * 26;
    if (i % 2 === 0) add(`<rect x="${tx - 6}" y="${yy - 16}" width="768" height="24" fill="${C.flush}" fill-opacity="0.05"/>`);
    text(tx, yy, r[0], { size: 11, mono: true });
    text(tx + 60, yy, r[1], { size: 11, mono: true, weight: 700 });
    text(tx + 180, yy, r[2], { size: 11, fill: C.sub });
    text(tx + 500, yy, r[3], { size: 11, fill: C.sub });
  });
  text(tx, ty + 70 + rows.length * 26, 'In simulation the timer works everywhere; the other device loads return 0 and only PUTCHAR (and LEDS and DISPLAY,', { size: 10.5, fill: C.faint });
  text(tx, ty + 84 + rows.length * 26, 'in the model) do anything, so the same program runs unchanged on the model, the RTL and the board.', { size: 10.5, fill: C.faint });

  // CSR box
  const cy = 640;
  rect(tx - 12, cy, 780, 238, { fill: '#FFF', stroke: C.D, rx: 8 });
  text(tx, cy + 22, 'Control and status registers: a separate address space, inside the core (csrr / csrw)', { size: 12.5, weight: 700, fill: C.D });
  const csrs = [['0xC00 cycle', '0xC02 instret', 'counters since reset (rdcycle, rdinstret)'], ['0xC03..0xC08', 'hpmcounter3..8', 'L F R K I D: the bubble counters of the cycle equation'],
    ['0x300 mstatus', '0x305 mtvec', 'trap setup: interrupt enable bits, handler address'], ['0x341 mepc', '0x342 mcause', 'where a trap happened and why (ecall, ebreak)'],
    ['0x304 mie', '0x344 mip', 'interrupt enables / pending: bit 7 timer, bit 11 external'],
    ['0x340 mscratch', '0x50A status', 'scratch registers for software'], ['0x51E tohost', '0xC09 hpm9', 'write 1: PASS, (n << 1) | 1: FAIL test n / interrupts taken']];
  csrs.forEach(([a, b, s], i) => {
    const yy = cy + 50 + i * 26;
    text(tx, yy, a, { size: 11, mono: true, weight: 700 });
    text(tx + 150, yy, b, { size: 11, mono: true, weight: 700 });
    text(tx + 300, yy, s, { size: 11, fill: C.sub });
  });
  return g.done();
}

// The boot sequence as a sequence diagram: time runs down, each column is a part of the computer
export function bootSequence() {
  const W = 1300, H = 1010;
  const g = canvas(W, H, 'Boot sequence of the FPGA computer: reset vector, firmware, program, and back',
    'Like a PC: the reset vector points into firmware ("BIOS"), which loads the program and hands over. Checked end to end by tools/fpga_sim.mjs.');
  const { add, text, rect, wire, pill } = g;
  const lanes = [['Your PC', 'tools/fpga_load.py', C.sub], ['UART', 'receive / transmit queues', C.F2], ['Boot firmware', 'core at 0x0000', C.F1], ['System', 'reset and boot control', C.flush], ['Program', 'core at 0x2000', C.M]];
  const lx = i => 130 + i * 255;
  lanes.forEach(([n, s, col], i) => {
    rect(lx(i) - 95, 78, 190, 48, { fill: col, stroke: col, op: 0.14 });
    text(lx(i), 98, n, { size: 13.5, weight: 700, anchor: 'middle', fill: col });
    text(lx(i), 115, s, { size: 10, anchor: 'middle', fill: C.sub });
    add(`<line x1="${lx(i)}" y1="126" x2="${lx(i)}" y2="${H - 30}" stroke="${col}" stroke-width="1.4" stroke-dasharray="4 4" opacity="0.6"/>`);
  });
  let y = 150, step = 0;
  const kindOf = { 0: 'sub', 1: 'F2', 2: 'F1', 3: 'flush', 4: 'M' };
  const msg = (from, to, label, sub = '') => {
    step++; y += 50;
    const x0 = lx(from), x1 = lx(to), dir = x1 > x0 ? 1 : -1;
    wire([[x0 + dir * 6, y], [x1 - dir * 8, y]], kindOf[from], { width: 2 });
    const mid = (x0 + x1) / 2;
    text(mid, y - 8, `${step}. ${label}`, { size: 11.5, anchor: 'middle', weight: 600 });
    if (sub) text(mid, y + 16, sub, { size: 10, anchor: 'middle', fill: C.sub });
  };
  const act = (lane, label, sub = '') => {
    step++; y += 50;
    const w = Math.max(label.length, sub.length) * 6.3 + 30;
    rect(lx(lane) - w / 2, y - 20, w, sub ? 40 : 28, { fill: '#FFF', stroke: lanes[lane][2] });
    text(lx(lane), y - 2, `${step}. ${label}`, { size: 11.5, anchor: 'middle', weight: 600 });
    if (sub) text(lx(lane), y + 13, sub, { size: 10, anchor: 'middle', fill: C.sub });
  };
  act(3, 'power on: PLL locks, reset held ~1.6 ms', 'RESET_VECTOR = 0x0000');
  msg(3, 2, 'core + caches leave reset at 0x0000', 'the firmware is in the block RAM image');
  msg(2, 1, 'banner, clock, memory, "sixfold> "', 'sb to PUTCHAR, after checking UART bit 1 (queue full)');
  msg(1, 0, 'characters at 115200 baud');
  msg(0, 1, "'l' address length bytes checksum", 'little-endian words; the sum of the bytes mod 2^32');
  msg(1, 2, 'getc: poll UART bit 0, read bits 15:8, sd to UART', 'the store drops the byte from the receive queue');
  act(2, 'sb every byte to 0x2000..', 'write-through: straight into main memory');
  msg(2, 0, '"loaded N bytes", then r from the PC');
  act(2, "'r': clear x1..x31 (all but tp), sd to BOOT", 'registers as a simulation starts: all zero');
  msg(2, 3, 'BOOT store', 'RESET_VECTOR = BOOT_ADDRESS = 0x2000');
  msg(3, 4, 'reset core and both caches, start at 0x2000', 'cold caches, fresh CSRs and predictors');
  msg(4, 1, 'the program prints (PUTCHAR)', 'the 2 KiB transmit queue absorbs bursts');
  msg(4, 3, 'writes TOHOST: the core halts', 'the system counts the cycles from reset to halt');
  act(3, 'wait for the transmit queue to drain', 'latch LAST_TOHOST, LAST_CYCLES; BOOT_REASON = 1');
  msg(3, 2, 'restart the firmware at 0x0000');
  msg(2, 0, '"program finished: PASS in N cycles"', 'N equals the cycle-exact model (tools/fpga_sim.mjs checks)');
  return g.done();
}

// The whole FPGA computer on its board
export function fpgaSystem(results) {
  const W = 1500, H = 900;
  const r = results.ulx3s, x7 = results.arty, b3 = results.basys3;
  const g = canvas(W, H, 'The Sixfold FPGA computer (fpga/rtl/Sixfold_System.sv) on its board',
    `ULX3S (ECP5-85F): ${r.lut4.toLocaleString('en-US')} LUT4s (${r.lutPercent}%), ${r.ff.toLocaleString('en-US')} flip-flops, ${r.bram} block RAMs, routed for ${r.fmax.toFixed(1)} MHz and clocked at ${r.clock} MHz. Basys 3 (XC7A35T): about ${b3.lut6.toLocaleString('en-US')} LUTs (${b3.lutPercent}%); Arty A7-100T: ${x7.lutPercent}%.`);
  const { add, text, rect, box, wire, pill } = g;

  // Board parts: clock and reset on the left, serial port, LEDs and buttons on the right
  const part = (x, y, t, sub, col) => { rect(x, y, 200, 62, { fill: col, stroke: col, op: 0.12 }); text(x + 12, y + 24, t, { size: 12.5, weight: 700, fill: col }); text(x + 12, y + 44, sub, { size: 10, fill: C.sub }); };
  part(30, 130, 'Oscillator', '25 MHz ULX3S, 100 MHz Basys 3 / Arty', C.F1);
  part(30, 270, 'Reset', 'a button, or (Basys 3) left + right', C.flush);
  part(1270, 470, 'USB to serial chip', 'FT231X (Basys 3, Arty: FT2232HQ)', C.F2);
  part(1270, 570, '16 LEDs', 'the LEDS register (8 on ULX3S, Arty)', C.E);
  part(1270, 670, '5 buttons, 16 switches', 'synchronized, active high', C.D);
  part(1270, 770, '4-digit display', 'Basys 3: seven segments + point', C.W);

  // The system
  rect(270, 90, 960, 780, { fill: '#FFF', stroke: C.edge, dash: '8 5', rx: 14 });
  text(286, 112, 'SixfoldSystem', { size: 14, weight: 700 });
  box(300, 130, 190, 100, 'PLL / MMCM', [`25 -> ${r.clock} MHz (ULX3S)`, `100 -> ${b3.clock} MHz (Basys 3)`, `100 -> ${x7.clock} MHz (Arty)`], { stroke: C.F1 });
  box(300, 260, 190, 110, 'Reset and boot', ['power-on: 65536 cycles', 'RESET_VECTOR 0x0000', 'or BOOT_ADDRESS'], { stroke: C.flush });
  box(560, 130, 300, 290, 'Riscv64 core', ['6 stages: F1 F2 D E M W', 'RV64IM Zicsr Zba Zbb Zbs', 'BTB, tournament predictor, RAS', 'forwarding into DECODE', 'iterative multiply / divide', 'traps: ecall ebreak mret', 'performance counters', '', 'RESET_VECTOR input: the only', 'difference from simulation'], { stroke: C.E, file: 'src/Riscv64.sv' });
  box(560, 460, 140, 110, 'I-cache', ['4 KiB 2-way', 'LUT RAM'], { stroke: C.F1 });
  box(720, 460, 140, 110, 'D-cache', ['4 KiB 2-way', 'write-through', 'per-byte writes'], { stroke: C.M });
  box(560, 640, 300, 200, 'Main memory: 64 KiB block RAM', ['2 copies x 2048 lines x 256 bits', '(ECP5 DP16KD / Artix-7 RAMB36)', 'copy A: instruction refills', 'copy B: data refills', 'every store writes both', 'initial image: firmware + a demo', 'program (tools/fpga_image.mjs)'], { stroke: C.edge, file: 'fpga/rtl/Main_Memory.sv' });
  box(300, 640, 190, 200, 'Boot firmware', ['software, 2 KiB', 'fpga/firmware/bios.s', 'banner, info, memory test', "l: load over the UART", "r: clear registers, BOOT", 'after a program:', 'PASS / FAIL, cycles'], { stroke: C.F1 });
  box(920, 130, 280, 360, 'Device registers', ['address[63:8] = 0x1000_00', '', '0x00 PUTCHAR   -> transmit queue', '0x08 LEDS      -> 16 LEDs', '0x10 BUTTONS   <- buttons', '0x18 UART      status / receive', '0x20 BOOT      -> restart the core', '0x28 CLOCK     = CLOCK_HZ', '0x30 LAST_TOHOST 0x38 LAST_CYCLES', '0x40 BOOT_REASON 0x48 TIMER', '0x50 BOOT_ADDRESS', '0x58 MTIME  0x60 MTIMECMP', '0x68 SWITCHES <- 16 switches', '0x70 DISPLAY  -> 4 digits'], { stroke: C.flush, lsize: 10.5 });
  box(920, 520, 280, 120, 'UART', ['receiver: 16-byte queue', 'transmitter: 2 KiB queue', '115200 baud, 8N1'], { stroke: C.F2, file: 'fpga/rtl/Uart.sv' });
  box(920, 680, 280, 130, 'Seven-segment driver', ['one digit at a time, 1 ms each', 'segments and anodes active low', 'software picks the segments'], { stroke: C.W, file: 'fpga/rtl/Seven_Segment_Display.sv' });
  box(1270, 130, 200, 220, 'Your PC', ['a serial terminal', '(screen, minicom, PuTTY)', 'at 115200 baud', '', 'tools/fpga_load.py:', 'program.s -> the board', '-> PASS in N cycles'], { stroke: C.sub });

  const lbl = (x, y, s, col, anchor = 'middle') => text(x, y, s, { size: 9.5, anchor, mono: true, fill: col });
  wire([[230, 161], [300, 161]], 'F1');
  wire([[230, 301], [300, 301]], 'flush');
  wire([[490, 180], [560, 180]], 'F1'); lbl(541, 173, 'clk', C.F1);
  wire([[490, 300], [560, 300]], 'flush'); lbl(541, 293, 'reset', C.flush);
  wire([[490, 340], [560, 340]], 'flush'); lbl(541, 333, 'vector', C.flush);
  wire([[630, 420], [630, 460]], 'F1'); wire([[790, 420], [790, 460]], 'M');
  wire([[630, 570], [630, 640]], 'F1'); lbl(636, 610, 'refill 256', C.F1, 'start');
  wire([[790, 570], [790, 640]], 'M'); lbl(796, 610, 'refill / stores', C.M, 'start');
  wire([[860, 250], [920, 250]], 'flush'); lbl(890, 243, 'ld / sd', C.flush);
  wire([[920, 300], [860, 300]], 'flush'); lbl(890, 318, 'value', C.flush);
  wire([[920, 390], [860, 390]], 'flush', { dash: '4 3' }); lbl(890, 383, 'timer', C.flush); lbl(890, 408, 'UART irq', C.flush);
  wire([[1060, 490], [1060, 520]], 'F2');
  wire([[940, 130], [940, 121], [520, 121], [520, 355], [490, 355]], 'flush', { dash: '5 3' }); lbl(730, 116, 'BOOT store, or a halt -> restart the core', C.flush);
  wire([[490, 740], [560, 740]], 'F1', { dash: '4 3' }); lbl(525, 733, 'at 0x0', C.F1);
  wire([[1200, 550], [1270, 495]], 'F2'); lbl(1222, 515, 'TX', C.F2);
  wire([[1270, 515], [1200, 600]], 'F2'); lbl(1222, 600, 'RX', C.F2);
  wire([[1370, 470], [1370, 350]], 'F2', { width: 3 }); lbl(1378, 420, 'USB cable', C.F2, 'start');
  wire([[1200, 400], [1240, 400], [1240, 600], [1270, 600]], 'E', { dash: '5 3' });
  wire([[1270, 700], [1252, 700], [1252, 370], [1200, 370]], 'D', { dash: '5 3' });
  wire([[1200, 470], [1230, 470], [1230, 660], [1060, 660], [1060, 680]], 'W', { dash: '5 3' }); lbl(1140, 655, 'DISPLAY', C.W);
  wire([[1200, 745], [1270, 800]], 'W');
  return g.done();
}

// =============================================================================
// Three instruction sets (docs/ISA_COMPARISON.md): their encodings, and their pipelines
// =============================================================================
function FIELD_COLOR(name) {
  const n = name.toLowerCase();
  if (n.startsWith('opcode') || n === 'funct3' || n.startsWith('funct')) return n.startsWith('opcode') ? C.F1 : C.D;
  if (n === 'rd' || n === 'modrm') return C.M;
  if (n === 'rs1' || n === 'rs' || n === 'sib') return C.E;
  if (n === 'rs2' || n === 'rt') return C.F2;
  if (n === 'rex' || n === 'prefixes') return C.tag;
  return C.W; // immediates, displacements, shift amounts, targets
}

// The formats of RISC-V and MIPS (bit fields) and the parts of an x86 instruction (bytes), with three real
// instructions encoded by the assemblers in model/ (so the bytes in the figure are the bytes the models run)
export async function isaEncodings() {
  const { FORMATS } = await import('../model/isa.js');
  const { ARCHS } = await import('../model/isas/index.js');
  const W = 1500, H = 1130;
  const g = canvas(W, H, 'Three ways to encode an instruction: RISC-V, MIPS, x86-64',
    'Fixed 32-bit words with fields in the same places (RISC-V, MIPS) against a variable-length sequence of optional bytes (x86-64). Examples encoded by model/asm.js and model/isas/.');
  const { text, rect } = g;
  const X0 = 150, BW = 26; // one bit = 26 px: 32 bits = 832 px
  const bitRow = (y, label, fields, sub) => {
    text(X0 - 14, y + 20, label, { size: 12.5, weight: 700, anchor: 'end' });
    if (sub) text(X0 - 14, y + 35, sub, { size: 9.5, anchor: 'end', fill: C.faint });
    for (const [name, hi, lo] of fields) {
      const x = X0 + (31 - hi) * BW, w = (hi - lo + 1) * BW, col = FIELD_COLOR(name);
      rect(x, y, w, 30, { fill: col, stroke: col, op: 0.16, rx: 3 });
      text(x + w / 2, y + 19, name, { size: w < 70 ? 9.5 : 11, anchor: 'middle', fill: col, weight: 700 });
    }
  };
  // RISC-V
  text(40, 100, 'RISC-V: six formats, all 32 bits. rd, rs1 and rs2 are in the same place in every format that has them.', { size: 14, weight: 700, fill: C.F1 });
  [['R', 'register-register'], ['I', 'immediate, loads, jalr'], ['S', 'stores'], ['B', 'branches'], ['U', 'lui, auipc'], ['J', 'jal']].forEach(([f, sub], i) => bitRow(114 + i * 40, f, FORMATS[f], sub));
  for (let b = 31; b >= 0; b -= 1) if (b % 4 === 3 || b === 0) text(X0 + (31 - b) * BW + BW / 2, 112, String(b), { size: 8.5, anchor: 'middle', fill: C.faint });
  // MIPS
  const MIPS = { R: [['opcode', 31, 26], ['rs', 25, 21], ['rt', 20, 16], ['rd', 15, 11], ['shamt', 10, 6], ['funct', 5, 0]], I: [['opcode', 31, 26], ['rs', 25, 21], ['rt', 20, 16], ['immediate', 15, 0]], J: [['opcode', 31, 26], ['target', 25, 0]] };
  text(40, 380, 'MIPS: three formats, all 32 bits. The opcode is on the left; 16-bit immediates; 26-bit jump targets.', { size: 14, weight: 700, fill: C.D });
  [['R', 'register-register'], ['I', 'loads, stores, branches'], ['J', 'j, jal']].forEach(([f, sub], i) => bitRow(394 + i * 40, f, MIPS[f], sub));
  // x86
  text(40, 540, 'x86-64: one instruction is 1 to 15 bytes, built from optional parts in a fixed order.', { size: 14, weight: 700, fill: C.W });
  const parts = [['prefixes', '0-4', 'size, rep, lock'], ['REX', '0-1', 'W: 64-bit; r8-r15'], ['opcode', '1-3', 'the operation'], ['ModRM', '0-1', 'register and r/m operand'], ['SIB', '0-1', 'scale, index, base'], ['displacement', '0, 1, 2, 4', 'the address offset'], ['immediate', '0, 1, 2, 4, 8', 'a constant']];
  let x = X0;
  parts.forEach(([name, bytes, what]) => {
    const w = 118, col = FIELD_COLOR(name === 'displacement' || name === 'immediate' ? 'imm' : name);
    rect(x, 556, w - 6, 44, { fill: col, stroke: col, op: 0.16, rx: 4, dash: name === 'opcode' ? null : '5 3' });
    text(x + (w - 6) / 2, 575, name, { size: 11.5, weight: 700, anchor: 'middle', fill: col });
    text(x + (w - 6) / 2, 592, `${bytes} bytes`, { size: 9.5, anchor: 'middle', fill: C.sub });
    text(x + (w - 6) / 2, 618, what, { size: 9, anchor: 'middle', fill: C.faint });
    x += w;
  });
  text(x + 10, 584, 'dashed = optional', { size: 10, fill: C.faint, italic: true });
  // Examples
  const ex = [
    ['add two registers', { riscv: 'add a0, a0, t0', mips: 'addu $v0, $v0, $t0', x86: 'add rax, rcx' }],
    ['add a small constant', { riscv: 'addi sp, sp, -16', mips: 'addiu $sp, $sp, -16', x86: 'sub rsp, 16' }],
    ['load from memory', { riscv: 'ld t3, 8(t0)', mips: 'lw $t3, 8($t0)', x86: 'mov rdx, [rsi + 8]' }],
    ['add a value from memory', { riscv: 'ld t3, 8(t0) then add a0, a0, t3', mips: 'lw $t3, 8($t0) then addu $v0, $v0, $t3', x86: 'add rax, [rsi + rcx*8 + 8]' }],
  ];
  const ey = 672;
  text(40, ey - 14, 'The same operations, encoded (bytes as they lie in memory, lowest address first)', { size: 14, weight: 700 });
  const colX = { riscv: 230, mips: 650, x86: 1070 };
  for (const [a, cx] of Object.entries(colX)) text(cx, ey + 12, ARCHS[a].name, { size: 13, weight: 700, fill: a === 'riscv' ? C.F1 : a === 'mips' ? C.D : C.W });
  ex.forEach(([what, srcs], i) => {
    const y = ey + 34 + i * 88;
    text(40, y + 16, what, { size: 11.5, weight: 600 });
    for (const [a, cx] of Object.entries(colX)) {
      const lines = srcs[a].split(' then ');
      let yy = y;
      for (const line of lines) {
        const img = ARCHS[a].assemble(line), row = ARCHS[a].listing(img)[0];
        text(cx, yy + 12, line, { size: 11, mono: true });
        let bx = cx;
        const groups = a === 'x86' ? row.parts.map(p => ({ name: p.name, bytes: p.bits })) : [{ name: `${row.size} bytes, ${row.format}-type`, bytes: row.bytes.map(b => b.toString(16).padStart(2, '0')).join(' ') }];
        for (const gp of groups) {
          const w = Math.max(gp.bytes.length * 7.4 + 12, a === 'x86' ? 34 : 120), col = a === 'x86' ? FIELD_COLOR(gp.name.startsWith('disp') || gp.name.startsWith('imm') ? 'imm' : gp.name) : C.F1;
          rect(bx, yy + 18, w, 20, { fill: col, stroke: col, op: 0.14, rx: 3 });
          text(bx + w / 2, yy + 32, gp.bytes, { size: 10.5, mono: true, anchor: 'middle', fill: C.ink });
          text(bx + w / 2, yy + 49, a === 'x86' ? gp.name.replace('displacement', 'disp').replace('immediate', 'imm') : gp.name, { size: 8.5, anchor: 'middle', fill: C.faint });
          bx += w + 3;
        }
        yy += lines.length > 1 ? 58 : 0;
      }
    }
  });
  text(40, H - 22, 'RISC-V and MIPS need two instructions (8 bytes) to add a value from memory; x86-64 does it in one 5-byte instruction, which its decoder splits into a load and an add.', { size: 11.5, fill: C.sub });
  return g.done();
}

// Where each pipeline finds out about branches, and what the seven comparison programs cost on each
export async function isaPipelines() {
  const { ARCHS, measure } = await import('../model/isas/index.js');
  const progs = fs.readdirSync(new URL('../programs/compare/riscv/', import.meta.url)).filter(f => f.endsWith('.s')).sort();
  const totals = Object.fromEntries(Object.keys(ARCHS).map(a => [a, { cycles: 0, instructions: 0, uops: 0, codeBytes: 0 }]));
  for (const f of progs) for (const a of Object.keys(ARCHS)) {
    const m = measure(a, fs.readFileSync(new URL(`../programs/compare/${a}/${f}`, import.meta.url), 'utf8'));
    for (const k of ['cycles', 'instructions', 'uops', 'codeBytes']) totals[a][k] += m[k] || 0;
  }
  const W = 1500, H = 900;
  const g = canvas(W, H, 'Three pipelines: where each one learns about a branch',
    'The models in model/core.js (Sixfold, RISC-V) and model/isas/ (MIPS, x86-64): same memory, same multiply/divide timing, same predictor where one is used.');
  const { text, rect, wire, pill } = g;
  const rows = [
    ['riscv', 'RISC-V on Sixfold', ['FETCH1', 'FETCH2', 'DECODE', 'EXECUTE', 'MEMORY', 'WRITEBACK'], C.F1,
      [[1, 'jumps and branches guessed taken: redirect, 1 bubble'], [3, 'a wrong guess, or any jalr: flush, 3 bubbles']], 'Branches are predicted (gshare). Compare and branch are one instruction.'],
    ['mips', 'MIPS, the classic five stages', ['IF', 'ID', 'EX', 'MEM', 'WB'], C.D,
      [[1, 'branches and jumps resolve here: the next instruction (the delay slot) runs anyway, 0 bubbles'], [1, 'but a branch needing a value still in EX waits 1 cycle']], 'No prediction at all: the instruction set itself hides the branch.'],
    ['x86', 'x86-64, in-order with micro-ops', ['FETCH', 'PREDECODE', 'DECODE', 'EXECUTE', 'MEMORY', 'WRITEBACK'], C.W,
      [[2, 'decoded into 1 to 3 micro-ops; jumps known here: redirect, 2 bubbles'], [3, 'a wrong guess, ret, indirect jumps: flush, 3 bubbles']], 'PREDECODE finds where each instruction ends. cmp and jcc are two instructions.'],
  ];
  rows.forEach(([a, title, stages, col, marks, foot], r) => {
    const y = 110 + r * 190, sw = 158;
    text(40, y - 12, title, { size: 15, weight: 700, fill: col });
    stages.forEach((s, i) => {
      rect(40 + i * (sw + 12), y, sw, 44, { fill: col, stroke: col, op: 0.12 });
      text(40 + i * (sw + 12) + sw / 2, y + 27, s, { size: 12, weight: 700, anchor: 'middle', fill: col });
      if (i) wire([[40 + i * (sw + 12) - 12, y + 22], [40 + i * (sw + 12) - 1, y + 22]], 'data', { width: 1.5 });
    });
    [...marks].sort((p, q) => q[0] - p[0]).forEach(([i, s], k) => { // the rightmost mark on the top row, so no arrow crosses a label
      const mx = 40 + i * (sw + 12) + sw / 2, my = y + 60 + k * 30;
      const bad = /wrong|waits/.test(s);
      wire([[mx, y + 44], [mx, my + 6]], bad ? 'flush' : 'pred', { width: 1.5 });
      text(mx + 8, my + 10, s, { size: 11, fill: bad ? C.flush : C.pred, weight: 600 });
    });
    text(40, y + 136, foot, { size: 11.5, fill: C.sub });
  });
  // Totals over the seven programs
  const ty = 690, archs = Object.keys(ARCHS);
  text(40, ty, `All seven comparison programs together (programs/compare/), measured on these models:`, { size: 14, weight: 700 });
  const metrics = [['bytes of code', 'codeBytes'], ['instructions executed', 'instructions'], ['cycles', 'cycles']];
  metrics.forEach(([label, key], m) => {
    const x0 = 40 + m * 490, max = Math.max(...archs.map(a => totals[a][key]));
    text(x0, ty + 32, label, { size: 12, weight: 600 });
    archs.forEach((a, i) => {
      const y = ty + 46 + i * 34, w = 240 * totals[a][key] / max, col = a === 'riscv' ? C.F1 : a === 'mips' ? C.D : C.W;
      text(x0, y + 15, ARCHS[a].name, { size: 11, fill: col, weight: 700 });
      rect(x0 + 70, y, w, 22, { fill: col, stroke: col, op: 0.25, rx: 3 });
      text(x0 + 76 + w, y + 16, totals[a][key].toLocaleString('en-US') + (a === 'x86' && key === 'instructions' ? ` (${totals[a].uops.toLocaleString('en-US')} micro-ops)` : ''), { size: 11, mono: true });
    });
  });
  text(40, H - 22, 'x86-64 has the smallest code and the most cycles here: dense instructions, but a simple in-order core spends extra stages finding and splitting them. Real x86 cores add wide decoders, micro-op caches and fusion to win that back.', { size: 11, fill: C.sub });
  return g.done();
}
