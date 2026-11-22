#!/usr/bin/env node
// =============================================================================
// tools/gendocs.mjs: regenerate every generated doc and picture in the repo.
//
//   binary/README.md                       index of all instructions with bit patterns
//   binary/opcode_map.md                   the RISC-V major-opcode map
//   binary/<RV64I|RV64M|Zicsr|Zifencei|Zba|Zbb|Zbs>/<name>.md   one page per instruction
//   binary/programs/*.lst, *.hex           every example program, assembled
//   docs/img/formats/*.svg                 R/I/S/B/U/J/CSR bit-field diagrams
//   docs/img/instructions/*.svg            one bit-field picture per instruction
//   docs/img/pipeline/*.svg                pipeline charts of every experiment
//   web/programs.js                        the programs bundled for the web simulator (and programs/compare/)
//
//   node tools/gendocs.mjs
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { INSTRUCTIONS, FORMATS, OPCODES } from '../model/isa.js';
import { assemble, toHex, toListing } from '../model/asm.js';
import { Core, STAGES, SHORT, control as controlOf, WB_NAMES } from '../model/core.js';

const W = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const b = (v, n) => v.toString(2).padStart(n, '0');

// ---------------------------------------------------------------------------
// colours shared by every picture (see also web/style tokens)
// ---------------------------------------------------------------------------
export const FIELD_COLOR = {
  opcode: '#2F6FDB', rd: '#1F9D6B', rs1: '#D97A1E', rs2: '#C23B8F', funct3: '#7457D1',
  funct7: '#5B6472', funct6: '#5B6472', funct12: '#5B6472', imm: '#B8911B', shamt: '#B8911B',
  fm: '#5B6472', pred: '#5B6472', succ: '#5B6472', csr: '#0E7C86', zimm: '#B8911B',
};
const fieldKind = name => {
  const k = name.split('[')[0];
  return FIELD_COLOR[k] ? k : 'imm';
};
export const STAGE_COLOR = { FETCH1: '#2E86C1', FETCH2: '#17A2B8', DECODE: '#6A5ACD', EXECUTE: '#E08E0B', MEMORY: '#27AE60', WRITEBACK: '#C0392B' };
const FONT = "font-family=\"'IBM Plex Sans','Segoe UI',Helvetica,Arial,sans-serif\"";
const MONO = "font-family=\"'IBM Plex Mono','SFMono-Regular',Consolas,monospace\"";

// ---------------------------------------------------------------------------
// bit-field SVG
// ---------------------------------------------------------------------------
function bitfieldSVG(title, fields, subtitle = '') {
  const cw = 24, x0 = 20, y0 = subtitle ? 64 : 48, h = 40;
  const width = x0 * 2 + cw * 32, height = y0 + h + 58;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`;
  s += `<rect width="100%" height="100%" rx="10" fill="#FBFCF8" stroke="#D5DBD0"/>`;
  s += `<text x="${x0}" y="26" ${FONT} font-size="17" font-weight="600" fill="#17251D">${esc(title)}</text>`;
  if (subtitle) s += `<text x="${x0}" y="46" ${FONT} font-size="12.5" fill="#4A5A50">${esc(subtitle)}</text>`;
  for (const f of fields) {
    const x = x0 + (31 - f.hi) * cw, w = (f.hi - f.lo + 1) * cw;
    const col = FIELD_COLOR[fieldKind(f.name)];
    s += `<rect x="${x}" y="${y0}" width="${w}" height="${h}" fill="${col}" fill-opacity="0.14" stroke="${col}" stroke-width="1.5"/>`;
    const bits = f.bits ?? '';
    for (let i = 0; i < bits.length; i++) {
      const fixed = bits[i] === '0' || bits[i] === '1';
      s += `<text x="${x + i * cw + cw / 2}" y="${y0 + 26}" text-anchor="middle" ${MONO} font-size="14" font-weight="${fixed ? 700 : 400}" fill="${fixed ? '#17251D' : col}">${esc(bits[i])}</text>`;
    }
    s += `<text x="${x + 3}" y="${y0 - 5}" ${MONO} font-size="10" fill="#6B7A70">${f.hi}</text>`;
    if (f.hi !== f.lo) s += `<text x="${x + w - 3}" y="${y0 - 5}" text-anchor="end" ${MONO} font-size="10" fill="#6B7A70">${f.lo}</text>`;
    s += `<text x="${x + w / 2}" y="${y0 + h + 18}" text-anchor="middle" ${FONT} font-size="12" font-weight="600" fill="${col}">${esc(f.name)}</text>`;
    s += `<text x="${x + w / 2}" y="${y0 + h + 34}" text-anchor="middle" ${FONT} font-size="10.5" fill="#6B7A70">${w / cw} bit${w / cw > 1 ? 's' : ''}</text>`;
  }
  return s + '</svg>\n';
}

function templateBits(def) {
  // bit string with fixed bits as 0/1 and variable bits as letters
  const out = new Array(32).fill('?');
  const put = (hi, lo, val) => { for (let i = hi; i >= lo; i--) out[31 - i] = val === null ? null : ((val >> (i - lo)) & 1).toString(); };
  const sym = (hi, lo, ch) => { for (let i = hi; i >= lo; i--) out[31 - i] = ch; };
  put(6, 0, def.opcode);
  if (def.funct3 !== null) put(14, 12, def.funct3); else if (def.fmt !== 'U' && def.fmt !== 'J') sym(14, 12, 'f');
  switch (def.fmt) {
    case 'R': put(31, 25, def.funct7); sym(24, 20, 't'); sym(19, 15, 's'); sym(11, 7, 'd'); break;
    case 'I': sym(31, 20, 'i'); sym(19, 15, 's'); sym(11, 7, 'd'); break;
    case 'I-sh64': put(31, 26, def.funct7); sym(25, 20, 'h'); sym(19, 15, 's'); sym(11, 7, 'd'); break;
    case 'I-sh32': put(31, 25, def.funct7); sym(24, 20, 'h'); sym(19, 15, 's'); sym(11, 7, 'd'); break;
    case 'I-unary': put(31, 20, def.funct7); sym(19, 15, 's'); sym(11, 7, 'd'); break;
    case 'S': sym(31, 25, 'i'); sym(24, 20, 't'); sym(19, 15, 's'); sym(11, 7, 'i'); break;
    case 'B': sym(31, 25, 'i'); sym(24, 20, 't'); sym(19, 15, 's'); sym(11, 7, 'i'); break;
    case 'U': case 'J': sym(31, 12, 'i'); sym(11, 7, 'd'); break;
    case 'SYS': put(31, 20, def.name === 'ebreak' ? 1 : 0); put(19, 15, 0); put(11, 7, 0); break;
    case 'FENCE': if (def.name === 'fence.i') { put(31, 20, 0); put(19, 15, 0); put(11, 7, 0); break; } sym(31, 28, 'm'); sym(27, 24, 'p'); sym(23, 20, 'u'); put(19, 15, 0); put(11, 7, 0); break;
    case 'CSR': sym(31, 20, 'c'); sym(19, 15, 's'); sym(11, 7, 'd'); break;
    case 'CSR-I': sym(31, 20, 'c'); sym(19, 15, 'z'); sym(11, 7, 'd'); break;
  }
  return out.join('');
}

function fieldsWithBits(fmt, bitstr) {
  return FORMATS[fmt].map(([name, hi, lo]) => ({ name, hi, lo, bits: bitstr.slice(31 - hi, 32 - lo) }));
}

// ---------------------------------------------------------------------------
// control signals: computed by the bit-exact ControlUnit twin in model/core.js
// and printed with the SAME names as src/Control_Unit.sv
// ---------------------------------------------------------------------------
const IMM_NAME = { I: 'IMMEDIATE_I', S: 'IMMEDIATE_S', B: 'IMMEDIATE_B', U: 'IMMEDIATE_U', J: 'IMMEDIATE_J', Z: 'IMMEDIATE_Z' };
export function controlRows(word) {
  const c = controlOf(word);
  return [
    ['REGISTER_WRITE_ENABLE', c.regWrite], ['MEMORY_READ_ENABLE', c.memRead], ['MEMORY_WRITE_ENABLE', c.memWrite],
    ['CSR_WRITE_ENABLE', c.csrWrite], ['CSR_WRITE_USING_IMMEDIATE', c.csrImm], ['ALU_INPUT_A_IS_PC', c.aIsPC],
    ['ALU_INPUT_B_IS_IMMEDIATE', c.bIsImm], ['ALU_IS_WORD_OPERATION', c.isWord], ['IS_A_MULTIPLY_DIVIDE_INSTRUCTION', c.isMulDiv],
    ['IS_A_BRANCH_INSTRUCTION', c.isBranch], ['IS_A_JAL_INSTRUCTION', c.isJal], ['IS_A_JALR_INSTRUCTION', c.isJalr],
    ['IMMEDIATE_TYPE_SELECT', IMM_NAME[c.immType]], ['WRITEBACK_SELECT', 'WRITEBACK_' + WB_NAMES[c.wbSel]], ['ALU_OPERATION', 'ALU_' + c.aluOp],
  ];
}

function stageStory(def, word) {
  const n = def.name, s = def.syntax, c = controlOf(word);
  const st = {};
  const isB = s === 'branch', isJal = n === 'jal';
  st.FETCH1 = 'The PC is sent to the instruction memory. At the same time the **GSharePredictor** reads the 2-bit counter at `PC[5:2] XOR GLOBAL_HISTORY_REGISTER` (it does not know yet what instruction this is).';
  st.FETCH2 = isB ? 'The 32-bit word arrives. Opcode `1100011` = branch: the B-immediate is unscrambled and `FETCH2_PC_TARGET = PC + imm` is precomputed. If the counter said **taken**, FETCH1 is redirected to the target and the instruction fetched behind the branch is squashed (1 bubble). The predicted direction is shifted into the global history.'
    : isJal ? 'The word arrives. Opcode `1101111` = JAL: the target `PC + imm` is computed right here and FETCH1 is **always** redirected (the jump is never wrong), squashing the one instruction fetched behind it (1 bubble).'
    : 'The 32-bit word arrives from memory. It is not a branch or JAL, so fetching simply continues at `PC + 4`.';
  const reads = [];
  if (['rrr', 'rri', 'rr', 'load', 'store', 'branch', 'jalr', 'csr'].includes(s)) reads.push('`rs1`');
  if (['rrr', 'store', 'branch'].includes(s)) reads.push('`rs2`');
  st.DECODE = `**ControlUnit** + **ALUdec** recognise \`${n}\` from opcode \`${b(def.opcode, 7)}\`${def.funct3 !== null ? `, funct3 \`${b(def.funct3, 3)}\`` : ''}${def.funct7 !== null ? (def.fmt === 'I-unary' ? `, funct12 \`${b(def.funct7, 12)}\`` : `, funct${def.fmt === 'I-sh64' ? 6 : 7} \`${b(def.funct7, def.fmt === 'I-sh64' ? 6 : 7)}\``) : ''}; the **ImmediateGenerator** builds the ${c.immType}-type immediate.` +
    (reads.length ? ` The **RegisterFile** is read for ${reads.join(' and ')}, and the forwarding muxes replace a stale value with a newer one from EXECUTE, MEMORY or WRITEBACK.` : ' No registers are needed.');
  if (isB) st.EXECUTE = `**BranchComparator** checks \`${def.sem.replace(/ pc \+= sext\(imm\)/, '').replace('if ', '')}\`. **BranchControl** compares that with the prediction: right -> nothing happens; wrong -> \`FLUSH_FETCH1_FETCH2_DECODE\` squashes 3 instructions and FETCH1 restarts at the correct address. The gshare counter is trained either way.`;
  else if (isJal) st.EXECUTE = 'The ALU computes `PC + imm` (not needed any more) and `PC + 4` becomes the link value. BranchControl sees a JAL: it was already redirected in FETCH2, so **no flush**.';
  else if (n === 'jalr') st.EXECUTE = 'The ALU computes `rs1 + imm`, bit 0 is cleared. The target was unknowable in FETCH2 (it lives in a register), so BranchControl **always flushes** (3 bubbles) and FETCH1 restarts at the target. The link value is `PC + 4`.';
  else if (s === 'load' || s === 'store') st.EXECUTE = `The ALU computes the address \`rs1 + imm\` and sends it to the data memory.${s === 'store' ? ` **StoreControl** moves the low ${{ sb: 8, sh: 16, sw: 32, sd: 64 }[n]} bits of \`rs2\` into the right byte lanes and sets the ${{ sb: 1, sh: 2, sw: 4, sd: 8 }[n]}-bit write mask; the memory is written at the end of this cycle (\`0x1000_0000\` prints a character instead).` : ' The memory reads the whole aligned doubleword at the end of this cycle.'}`;
  else if (n === 'lui') st.EXECUTE = 'The ALU performs `ALU_COPY_B`: the result is just the U-immediate (sign-extended to 64 bits).';
  else if (n === 'auipc') st.EXECUTE = 'The ALU adds `PC + imm` (ALU input A is the PC).';
  else if (s === 'csr' || s === 'csri') st.EXECUTE = `The **CSRFile** is read at address \`csr\` (the old value goes to \`rd\`) and ${n.startsWith('csrrw') ? 'replaced by' : n.startsWith('csrrs') ? 'OR-ed with' : 'AND-ed with the inverse of'} ${s === 'csri' ? 'the 5-bit zero-extended immediate' : '`rs1`'} at the end of the cycle.${n === 'csrrs' || n === 'csrrc' || n === 'csrrsi' || n === 'csrrci' ? ' With `rs1 = x0` / `zimm = 0` nothing is written, so `csrr` is a pure read.' : ''}`;
  else if (s === 'none') st.EXECUTE = n === 'fence' ? 'Nothing: with a single in-order memory FENCE has nothing to order.' : n === 'fence.i' ? 'FENCE.I acts here, like a trap: it flushes FETCH1, FETCH2 and DECODE (3 bubbles), empties the instruction cache and the BTB, and FETCH1 restarts at `PC + 4`, so every later instruction is fetched again from memory, after every earlier store (the data cache writes through). The deep-pipeline edition does the same at M1.' : 'Nothing: on this core ECALL/EBREAK are no-ops; programs finish by writing the `tohost` CSR (`halt`).';
  else st.EXECUTE = `${c.isMulDiv ? 'The **MultiplyDivideUnit**' : 'The **ALU**'} performs \`${c.aluOp}\`${c.isWord ? ' on the low 32 bits and sign-extends the result to 64 bits' : ''}: \`${def.sem}\`.` +
    (c.aShift || c.aZext ? ` DECODE already prepared operand A (${c.aZext ? 'zero-extended the low 32 bits of rs1' : ''}${c.aZext && c.aShift ? ' and ' : ''}${c.aShift ? `shifted it left by ${c.aShift}` : ''}), so the ALU only adds${c.aluOp === 'SLL' ? ' or shifts' : ''}.` : '') +
    (c.oneB ? ` DECODE already turned operand B into a single 1 bit at position ${def.syntax === 'rri' ? 'shamt' : 'rs2[5:0]'} (a 6-to-64 decoder)${c.invB ? ' and inverted it' : ''}, so the ALU does a plain ${c.aluOp}.` : c.invB ? ' DECODE already inverted operand B, so the ALU does a plain ' + c.aluOp + '.' : '') +
    (c.late ? ' This result is one of the two-cycle ones (`EXECUTE_LATE_RESULT`): it is forwarded from MEMORY, so an instruction that needs it right away waits one cycle.' : '');
  if (s === 'load') st.MEMORY = `The doubleword read in EXECUTE is here. **LoadControl** picks the byte lanes with address bits [2:0] and ${/u$/.test(n) ? 'zero' : 'sign'}-extends the ${{ lb: 8, lbu: 8, lh: 16, lhu: 16, lw: 32, lwu: 32, ld: 64 }[n]}-bit value to 64 bits. This is the earliest point the value can be forwarded, which is why an instruction that needs it right away causes a LOAD_STALL.`;
  else st.MEMORY = `No memory work. **WriteControl** picks the ${c.regWrite ? `\`WRITEBACK_${WB_NAMES[c.wbSel]}\`` : 'result'} value${c.regWrite ? ', which can be forwarded back to DECODE' : ''}.`;
  st.WRITEBACK = c.regWrite ? `The **RegisterFile** writes \`rd\` at the clock edge (ignored if \`rd\` is \`x0\`). The instruction is now **retired** and the \`instret\` counter goes up by one.` : 'Nothing to write. The instruction retires (`instret` + 1).';
  return st;
}

// example with concrete registers
const EXAMPLES = {
  rrr: n => `${n} a0, a1, a2`, rri: n => (/^(s(l|r)[la]iw?|rori|roriw|slli\.uw|b(set|clr|inv|ext)i)$/.test(n) ? `${n} a0, a1, ${n.endsWith('w') ? 5 : 40}` : `${n} a0, a1, -5`),
  rr: n => `${n} a0, a1`,
  load: n => `${n} a0, 16(sp)`, store: n => `${n} a0, 16(sp)`, branch: n => `${n} a0, a1, -8`, ui: n => `${n} a0, 0x12345`,
  jal: () => 'jal ra, 2048', jalr: () => 'jalr ra, 8(t0)', none: n => n,
  csr: n => `${n} a0, status, a1`, csri: n => `${n} a0, status, 5`,
};
function exampleWord(def) {
  const src = EXAMPLES[def.syntax](def.name);
  const txt = def.syntax === 'branch' ? `${def.name} a0, a1, target\n.org 0x2100\ntarget:` : def.syntax === 'jal' ? 'jal ra, target\n.org 0x2800\ntarget:' : src;
  const img = assemble(txt);
  const w = img.listing.find(l => l.word !== undefined).word;
  return { src: def.syntax === 'branch' ? `${def.name} a0, a1, +256` : def.syntax === 'jal' ? 'jal ra, +2048' : src, word: w };
}

// ---------------------------------------------------------------------------
// pipeline chart SVG from the model
// ---------------------------------------------------------------------------
export function pipelineSVG(title, img, maxCycles = 30, maxRows = 22, { from = 1, bp = true, historyBits, zifencei = false } = {}) {
  const core = new Core(img, { bp, zifencei, xcompute: true, ...(historyBits ? { historyBits } : {}) });
  const events = core.run();
  const first = from, last = Math.min(events.length, from + maxCycles - 1);
  const rows = new Map();
  for (const ev of events.slice(first - 1, last)) for (const s of STAGES) {
    const st = ev.stages[s]; if (!st) continue;
    if (!rows.has(st.id)) rows.set(st.id, { cells: {} });
    rows.get(st.id).cells[ev.cycle] = { s, stall: ev.stall && ['FETCH1', 'FETCH2', 'DECODE'].includes(s), fwd: s === 'DECODE' && (ev.fwd.a || ev.fwd.b) };
  }
  const ids = [...rows.keys()].sort((a, c) => a - c).slice(0, maxRows);
  const cw = 30, rh = 24, lx = 260, top = 70;
  const width = lx + cw * (last - first + 1) + 24, height = top + rh * (ids.length + 1) + 70;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`;
  s += `<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#17251D" stroke-opacity="0.35" stroke-width="2"/></pattern></defs>`;
  s += `<rect width="100%" height="100%" rx="10" fill="#FBFCF8" stroke="#D5DBD0"/>`;
  s += `<text x="16" y="28" ${FONT} font-size="17" font-weight="600" fill="#17251D">${esc(title)}</text>`;
  const st = core.stats;
  s += `<text x="16" y="48" ${FONT} font-size="12" fill="#4A5A50">${st.cycles} cycles, ${st.retired} instructions, CPI ${(st.cycles / st.retired).toFixed(2)}: ${st.loadStalls} load stall(s), ${st.flushes} flush(es), ${st.redirects} FETCH2 redirect(s), ${st.forwards} forwarded operand(s)${first > 1 ? `. Cycles ${first} to ${last} shown` : events.length > last ? `. First ${last} cycles shown` : ''}${bp ? '' : '. Predictor OFF'}</text>`;
  for (let c = first; c <= last; c++) s += `<text x="${lx + (c - first + 0.5) * cw}" y="${top - 6}" text-anchor="middle" ${MONO} font-size="10.5" fill="#6B7A70">${c}</text>`;
  ids.forEach((id, i) => {
    const r = rows.get(id), y = top + i * rh, inst = core.instrs[id];
    const squashed = inst.squashed;
    if (i % 2 === 0) s += `<rect x="8" y="${y}" width="${width - 16}" height="${rh}" fill="#EEF2EA" fill-opacity="0.6"/>`;
    s += `<text x="16" y="${y + 16}" ${MONO} font-size="11" fill="${squashed ? '#9AA59D' : '#6B7A70'}">${inst.pc.toString(16).padStart(4, '0')}</text>`;
    s += `<text x="56" y="${y + 16}" ${MONO} font-size="11.5" fill="${squashed ? '#9AA59D' : '#17251D'}"${squashed ? ' text-decoration="line-through"' : ''}>${esc(inst.text.slice(0, 28))}</text>`;
    for (const [cyc, cell] of Object.entries(r.cells)) {
      const x = lx + (cyc - first) * cw + 2;
      const col = squashed ? '#B4BDB6' : STAGE_COLOR[cell.s];
      s += `<rect x="${x}" y="${y + 3}" width="${cw - 4}" height="${rh - 6}" rx="3" fill="${col}"${squashed ? ' fill-opacity="0.45"' : ''}/>`;
      if (cell.stall) s += `<rect x="${x}" y="${y + 3}" width="${cw - 4}" height="${rh - 6}" rx="3" fill="url(#hatch)"/>`;
      s += `<text x="${x + (cw - 4) / 2}" y="${y + 16}" text-anchor="middle" ${FONT} font-size="10" font-weight="700" fill="#FFFFFF">${SHORT[cell.s]}</text>`;
      if (cell.fwd) s += `<circle cx="${x + cw - 6}" cy="${y + 5}" r="4" fill="#FFFFFF" stroke="${STAGE_COLOR.DECODE}" stroke-width="2"/>`;
    }
  });
  const hy = top + ids.length * rh + 8;
  s += `<text x="16" y="${hy + 14}" ${FONT} font-size="11.5" font-weight="600" fill="#4A5A50">hazard events</text>`;
  for (const ev of events.slice(first - 1, last)) {
    const x = lx + (ev.cycle - first) * cw + 2;
    const tag = (fill, fg, t) => `<rect x="${x}" y="${hy}" width="${cw - 4}" height="18" rx="3" fill="${fill}"/><text x="${x + (cw - 4) / 2}" y="${hy + 13}" text-anchor="middle" ${FONT} font-size="8.5" font-weight="700" fill="${fg}">${t}</text>`;
    if (ev.stall) s += tag('#F2C94C', '#17251D', 'stall');
    else if (ev.flush) s += tag('#8E44AD', '#FFF', 'flush');
    else if (ev.redirect) s += tag('#17A2B8', '#FFF', 'redir');
  }
  let lxp = 16; const ly = height - 26;
  for (const k of STAGES) { s += `<rect x="${lxp}" y="${ly - 11}" width="26" height="15" rx="3" fill="${STAGE_COLOR[k]}"/><text x="${lxp + 13}" y="${ly}" text-anchor="middle" ${FONT} font-size="9.5" font-weight="700" fill="#FFF">${SHORT[k]}</text><text x="${lxp + 30}" y="${ly}" ${FONT} font-size="10.5" fill="#4A5A50">${k}</text>`; lxp += 38 + k.length * 7.4; }
  const l2 = ly + 18; lxp = 16;
  s += `<rect x="${lxp}" y="${l2 - 11}" width="26" height="15" rx="3" fill="#6A5ACD"/><rect x="${lxp}" y="${l2 - 11}" width="26" height="15" rx="3" fill="url(#hatch)"/><text x="${lxp + 32}" y="${l2}" ${FONT} font-size="11" fill="#4A5A50">held by LOAD_STALL</text>`;
  s += `<circle cx="${lxp + 170}" cy="${l2 - 4}" r="4" fill="#FFF" stroke="${STAGE_COLOR.DECODE}" stroke-width="2"/><text x="${lxp + 180}" y="${l2}" ${FONT} font-size="11" fill="#4A5A50">operand forwarded into DECODE</text>`;
  s += `<rect x="${lxp + 370}" y="${l2 - 11}" width="26" height="15" rx="3" fill="#B4BDB6" fill-opacity="0.45"/><text x="${lxp + 402}" y="${l2}" ${FONT} font-size="11" fill="#4A5A50">squashed (wrong path)</text>`;
  return s.replace(`height="${height}"`, `height="${height + 10}"`).replace(`0 0 ${width} ${height}"`, `0 0 ${width} ${height + 10}"`) + '</svg>\n';
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  // 1. format pictures
  const FORMAT_TITLES = {
    R: 'R-type: register-register (add, sub, mul, ...)', I: 'I-type: immediate, loads, jalr',
    'I-sh64': 'I-type shift (RV64): slli, srli, srai with a 6-bit shift amount',
    'I-sh32': 'I-type shift (word): slliw, srliw, sraiw with a 5-bit shift amount',
    'I-unary': 'I-type, one operand (Zbb): clz, ctz, cpop, sext.b, rev8, ... funct12 names the operation',
    S: 'S-type: stores', B: 'B-type: conditional branches', U: 'U-type: lui, auipc', J: 'J-type: jal',
    SYS: 'SYSTEM: ecall, ebreak', FENCE: 'FENCE',
    CSR: 'CSR-type: csrrw, csrrs, csrrc (register source)', 'CSR-I': 'CSR-type immediate: csrrwi, csrrsi, csrrci (5-bit zimm)',
  };
  for (const [fmt, fl] of Object.entries(FORMATS))
    W(`docs/img/formats/${fmt}.svg`, bitfieldSVG(FORMAT_TITLES[fmt], fl.map(([name, hi, lo]) => ({ name, hi, lo, bits: '' }))));

  // 2. per-instruction pages + pictures
  const index = [];
  for (const def of INSTRUCTIONS) {
    const tb = templateBits(def);
    W(`docs/img/instructions/${def.name}.svg`, bitfieldSVG(`${def.name}: ${def.desc}`, fieldsWithBits(def.fmt, tb), def.sem));
    const ex = exampleWord(def);
    const exBits = b(ex.word, 32);
    W(`docs/img/instructions/${def.name}_example.svg`, bitfieldSVG(`${ex.src}   =   0x${ex.word.toString(16).padStart(8, '0')}`, fieldsWithBits(def.fmt, exBits), 'example encoding'));
    const story = stageStory(def, ex.word), rowsC = controlRows(ex.word);
    const fieldRows = FORMATS[def.fmt].map(([name, hi, lo]) => `| \`${name}\` | ${hi}:${lo} | \`${tb.slice(31 - hi, 32 - lo)}\` | \`${exBits.slice(31 - hi, 32 - lo)}\` |`).join('\n');
    const md = `# \`${def.name}\`: ${def.desc}

[← all instructions](../README.md) · extension **${def.ext}** · format **${def.fmt}** · category *${def.cls}*

\`\`\`
${def.sem}
\`\`\`

## Encoding

![${def.name} encoding](../../docs/img/instructions/${def.name}.svg)

\`\`\`
bit:  31                              0
      ${tb.replace(/(.{4})/g, '$1 ').trim()}
\`\`\`

Fixed bits are \`0\`/\`1\`. Letters are filled in by the assembler:
\`d\` = rd, \`s\` = rs1, \`t\` = rs2, \`i\` = immediate, \`h\` = shift amount, \`c\` = CSR address, \`z\` = 5-bit CSR immediate, \`f\` = funct3, \`m/p/u\` = fence fields.

## Example

\`${ex.src}\` assembles to **\`0x${ex.word.toString(16).padStart(8, '0')}\`** = \`${exBits}\`

![example](../../docs/img/instructions/${def.name}_example.svg)

| field | bits | template | example |
|---|---|---|---|
${fieldRows}

Try it yourself:

\`\`\`bash
node tools/rv.mjs encode "${ex.src.replace(/\+/, '')}"${def.syntax === 'branch' || def.syntax === 'jal' ? '   # use a label or a number for the offset' : ''}
node tools/rv.mjs decode ${ex.word.toString(16).padStart(8, '0')}
\`\`\`

## Control signals from the Control Unit ([\`src/Control_Unit.sv\`](../../src/Control_Unit.sv))

These are the exact values the RTL produces for the example word above (computed by the
bit-exact twin in \`model/core.js\`, which \`make test\` checks against the RTL every cycle).

| signal | value | | signal | value |
|---|---|---|---|---|
${rowsC.slice(0, 8).map((r, k) => `| \`${r[0]}\` | \`${r[1]}\` | | ${rowsC[k + 8] ? `\`${rowsC[k + 8][0]}\` | \`${rowsC[k + 8][1]}\`` : ' | '} |`).join('\n')}

## Journey through the 6-stage pipeline

| stage | what happens to \`${def.name}\` |
|---|---|
${STAGES.map(s => `| **${s}** | ${story[s]} |`).join('\n')}

See the whole datapath in the [block diagram](../../docs/ARCHITECTURE.md) and step through a program in the [web simulator](../../web/index.html).
`;
    W(`binary/${def.ext}/${def.name}.md`, md);
    index.push({ def, tb });
  }

  // 3. index page
  const groups = {};
  for (const x of index) (groups[x.def.cls] ??= []).push(x);
  let idx = `# Instruction encodings: every RV64IM + Zicsr instruction in binary

This folder is generated by \`node tools/gendocs.mjs\` from the single ISA table in
[\`model/isa.js\`](../model/isa.js). Every instruction is exactly **32 bits**. The low 7 bits are
always the **opcode**; register numbers sit in the **same bit positions** in every format
(\`rd\` = bits 11:7, \`rs1\` = 19:15, \`rs2\` = 24:20) so the decoder can start reading the
register file before it even knows what the instruction is.

* [Opcode map](opcode_map.md): which opcode means what
* [Assembled example programs](programs/): every experiment as address / hex / binary / source

## The six formats

| | |
|---|---|
| ![R](../docs/img/formats/R.svg) | ![I](../docs/img/formats/I.svg) |
| ![S](../docs/img/formats/S.svg) | ![B](../docs/img/formats/B.svg) |
| ![U](../docs/img/formats/U.svg) | ![J](../docs/img/formats/J.svg) |
| ![I-sh64](../docs/img/formats/I-sh64.svg) | ![I-sh32](../docs/img/formats/I-sh32.svg) |
| ![CSR](../docs/img/formats/CSR.svg) | ![CSR-I](../docs/img/formats/CSR-I.svg) |

**Why are B and J immediates scrambled?** So that every immediate bit that exists in several
formats sits in the same instruction bit (e.g. imm[10:5] is always bits 30:25 and the sign is
always bit 31). That makes the immediate generator in \`src/Immediate_Generator.sv\` a set of simple wires,
not a big multiplexer. Branch/jump offsets are always even, so bit 0 is not stored at all.

## All ${INSTRUCTIONS.length} instructions

Letters in the pattern are the variable fields: \`d\` rd, \`s\` rs1, \`t\` rs2, \`i\` immediate,
\`h\` shift amount, \`c\` CSR address, \`z\` CSR immediate.

`;
  for (const [cls, list] of Object.entries(groups)) {
    idx += `### ${cls}\n\n| instruction | format | 32-bit pattern (bit 31 … bit 0) | meaning |\n|---|---|---|---|\n`;
    for (const { def, tb } of list) idx += `| [\`${def.name}\`](${def.ext}/${def.name}.md) | ${def.fmt} | \`${tb.slice(0, 7)} ${tb.slice(7, 12)} ${tb.slice(12, 17)} ${tb.slice(17, 20)} ${tb.slice(20, 25)} ${tb.slice(25)}\` | \`${def.sem.replace(/\|/g, '\\|')}\` |\n`;
    idx += '\n';
  }
  W('binary/README.md', idx);

  // 4. opcode map
  const opNames = Object.fromEntries(Object.entries(OPCODES).map(([k, v]) => [v, k]));
  let om = `# RISC-V major opcode map (RV64IM + Zicsr + Zba + Zbb + Zbs subset implemented here)

The opcode is \`inst[6:0]\`. For 32-bit instructions \`inst[1:0]\` is always \`11\`
(\`00\`, \`01\`, \`10\` mark 16-bit compressed instructions, not implemented here).
Rows are \`inst[6:5]\`, columns are \`inst[4:2]\`.

| inst[6:5] \\ inst[4:2] | 000 | 001 | 010 | 011 | 100 | 101 | 110 | 111 |
|---|---|---|---|---|---|---|---|---|
`;
  for (let r = 0; r < 4; r++) {
    om += `| **${b(r, 2)}** |`;
    for (let c = 0; c < 8; c++) {
      const op = (r << 5) | (c << 2) | 0b11;
      const name = opNames[op];
      om += name ? ` **${name}**<br>\`${b(op, 7)}\` |` : ` · |`;
    }
    om += '\n';
  }
  om += `\n## Instructions under each opcode\n\n`;
  for (const [name, op] of Object.entries(OPCODES)) {
    const list = INSTRUCTIONS.filter(i => i.opcode === op);
    om += `### ${name} \`${b(op, 7)}\`\n\n${list.map(i => `[\`${i.name}\`](${i.ext}/${i.name}.md)`).join(' · ')}\n\n`;
  }
  W('binary/opcode_map.md', om);

  // 5. assembled programs + pipeline pictures
  const progs = [...fs.readdirSync('programs').filter(f => f.endsWith('.s')).sort().map(f => 'programs/' + f)];
  for (const p of progs) {
    const name = path.basename(p, '.s');
    const img = assemble(fs.readFileSync(p, 'utf8'));
    W(`binary/programs/${name}.lst`, toListing(img));
    W(`binary/programs/${name}.hex`, toHex(img));
    W(`docs/img/pipeline/${name}.svg`, pipelineSVG(`${name}.s`, img));
  }
  // extra views for the hazard and branch-prediction stories
  const img11 = assemble(fs.readFileSync('programs/11_gshare_patterns.s', 'utf8'));
  W('docs/img/pipeline/11_gshare_patterns_warm.svg', pipelineSVG('11_gshare_patterns.s after the predictor has trained', img11, 30, 22, { from: 900 }));
  W('docs/img/pipeline/11_gshare_patterns_nobp.svg', pipelineSVG('11_gshare_patterns.s with the predictor OFF', img11, 30, 22, { from: 900, bp: false }));
  const img05 = assemble(fs.readFileSync('programs/05_fibonacci.s', 'utf8'));
  W('docs/img/pipeline/05_fibonacci_nobp.svg', pipelineSVG('05_fibonacci.s with the predictor OFF', img05, 30, 22, { from: 100, bp: false }));
  W('docs/img/pipeline/05_fibonacci_warm.svg', pipelineSVG('05_fibonacci.s with gshare (trained)', img05, 30, 22, { from: 100 }));
  const img04 = assemble(fs.readFileSync('programs/04_branch_penalty.s', 'utf8'));
  W('docs/img/pipeline/04_branch_penalty_nobp.svg', pipelineSVG('04_branch_penalty.s with the predictor OFF: every taken branch flushes 3', img04, 34, 22, { bp: false }));
  const img13 = assemble(fs.readFileSync('programs/13_function_call_cost.s', 'utf8'));
  W('docs/img/pipeline/13_call_return_zoom.svg', pipelineSVG('13_function_call_cost.s: jal redirects in FETCH2 (1 bubble), ret flushes in EXECUTE (3 bubbles)', img13, 30, 22, { from: 9 }));
  const imgFence = assemble(fs.readFileSync('tests/fence_i.s', 'utf8'));
  W('docs/img/pipeline/fence_i_zoom.svg', pipelineSVG('tests/fence_i.s: fence.i flushes in EXECUTE and empties the I-cache, so the rewritten next word is fetched again from memory (a miss)', imgFence, 30, 16, { from: 112, zifencei: true }));
  // sample programs for the web simulator (works without a server fetch)
  const bundle = Object.fromEntries(progs.map(p => [path.basename(p, '.s'), fs.readFileSync(p, 'utf8')]));
  W('web/programs.js', `// generated by tools/gendocs.mjs: every file in programs/, and the FPGA boot firmware\nexport const PROGRAMS = ${JSON.stringify(bundle, null, 1)};\nexport const FIRMWARE = ${JSON.stringify(fs.readFileSync('fpga/firmware/bios.s', 'utf8'))};\nexport const FPGA_EXAMPLES = ${JSON.stringify(Object.fromEntries(fs.readdirSync('fpga/examples').filter(f => f.endsWith('.s')).sort().map(f => [f.replace('.s', ''), fs.readFileSync('fpga/examples/' + f, 'utf8')])), null, 1)};\n`
    + `// programs/compare/: the same programs in RISC-V, MIPS and x86-64 (web/isa.html, the site's ISA section)\nexport const COMPARE_PROGRAMS = ${JSON.stringify(Object.fromEntries(fs.readdirSync('programs/compare/riscv').filter(f => f.endsWith('.s')).sort().map(f => [f.replace('.s', ''), Object.fromEntries(['riscv', 'mips', 'x86'].map(a => [a, fs.readFileSync(`programs/compare/${a}/${f}`, 'utf8')]))])), null, 1)};\n`);
  W('binary/programs/README.md', `# Assembled programs

Every file in [\`programs/\`](../../programs) assembled by \`model/asm.js\` (code starts at the reset PC \`0x2000\`).

* \`.lst\`: listing with address, hex word, **binary word**, source line
* \`.hex\`: memory image for \`$readmemh\` (one byte per line, little-endian)

${progs.map(p => { const n = path.basename(p, '.s'); return `* [${n}.lst](${n}.lst) · [${n}.hex](${n}.hex)`; }).join('\n')}
`);

  console.log(`generated: ${INSTRUCTIONS.length} instruction pages, ${Object.keys(FORMATS).length} format diagrams, ${progs.length} pipeline charts`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) main();
