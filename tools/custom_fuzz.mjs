#!/usr/bin/env node
// =============================================================================
// tools/custom_fuzz.mjs: random custom instructions, checked on the RTL against the model
//
//   node tools/custom_fuzz.mjs [rounds] [seed=1]      (make custom-check; rounds: every function at least once)
//
// The custom-instruction compiler (model/custom.js) translates one expression two ways: to JavaScript for
// the model and to SystemVerilog for src/Custom_Unit.sv. This test makes random instruction sets that use
// every operator and every function, writes them into the RTL with tools/custom.mjs, runs a program that
// feeds them random and edge-case operands, and lets tools/test.mjs compare the RTL with the model on
// every cycle. Afterwards the default instructions (custom/instructions.json) are put back.
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FUNCTIONS, parse } from '../model/custom.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const roundsArg = Number(process.argv[2] || 0); // default: enough rounds that every function and operator is used once (MUST below)
let seed = Number(process.argv[3] || 1) >>> 0;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const pick = xs => xs[Math.floor(rand() * xs.length)];
const BIN = ['+', '-', '*', '&', '|', '^', '<<', '>>', '>>>', '==', '!=', '<', '<=', '>', '>=', '&&', '||'];
const FNS = Object.keys(FUNCTIONS);
const CONSTS = ['0', '1', '3', '7', '63', '64', '255', '0xff00', '-1', '-128', '0x8000000000000000', '0x0123456789abcdef'];

function expr(depth, vars) {
  if (depth === 0 || rand() < 0.2) return rand() < 0.7 ? pick(vars) : pick(CONSTS);
  const r = rand();
  if (r < 0.45) return `(${expr(depth - 1, vars)} ${pick(BIN)} ${expr(depth - 1, vars)})`;
  if (r < 0.55) return `${pick(['-', '~', '!'])}${expr(depth - 1, vars)}`;
  if (r < 0.65) return `(${expr(depth - 1, vars)} ? ${expr(depth - 1, vars)} : ${expr(depth - 1, vars)})`;
  const f = pick(FNS);
  return `${f}(${Array.from({ length: FUNCTIONS[f][0] }, () => expr(depth - 1, vars)).join(', ')})`;
}

// Every function and binary operator appears in some round (9 R-format slots a round; the default number of
// rounds covers them all); the remaining slots, and the 3 I-format ones, get random nested expressions.
const MUST = [...FNS.map(f => `${f}(${Array.from({ length: FUNCTIONS[f][0] }, (_, i) => (i ? 'b' : 'a')).join(', ')})`), ...BIN.map(o => `(a ${o} b)`)];
const rounds = roundsArg || Math.ceil(MUST.length / 9);
function spec(round) {
  const list = [], used = new Set();
  for (let k = 0; k < 12; k++) {
    const format = k < 9 ? 'R' : 'I';
    let f3, f7;
    do { f3 = format === 'R' ? Math.floor(rand() * 4) : 4 + Math.floor(rand() * 4); f7 = format === 'R' ? Math.floor(rand() * 128) : -1; } while (used.has(`${f3}:${f7}`));
    used.add(`${f3}:${f7}`);
    const e = format === 'R' ? (MUST[round * 9 + k] || expr(3, ['a', 'b'])) : expr(3, ['a', 'imm']);
    parse(e, format); // a fuzz expression the parser rejects is a bug in this generator
    list.push({ name: `fz${round}x${k}`, format, funct3: f3, ...(format === 'R' ? { funct7: f7 } : {}), expr: e });
  }
  return list;
}

const VALUES = ['0', '1', '-1', '2', '63', '64', '0x7fffffffffffffff', '0x8000000000000000', '0x0123456789abcdef', '0xfedcba9876543210', '-200', '255', '1000',
  '0x8080808080808080', '0x7f7f7f7f7f7f7f7f', '0x8000800080008000', '0x7fff7fff7fff7fff', '0xff00ff00ff00ff00']; // and lane edge cases for the packed functions
function program(list) {
  const lines = ['# custom_fuzz: random custom instructions on random operands (generated; RTL vs model)', '    li a0, 0'];
  for (const c of list) for (let n = 0; n < 4; n++) {
    lines.push(`    li a1, ${rand() < 0.6 ? pick(VALUES) : '0x' + Math.floor(rand() * 2 ** 32).toString(16) + Math.floor(rand() * 2 ** 32).toString(16).padStart(8, '0')}`);
    lines.push(`    li a2, ${pick(VALUES)}`);
    if (c.format === 'R') lines.push(`    ${c.name} a3, a1, a2`);
    else lines.push(`    ${c.name} a3, a1, ${pick(['0', '1', '-1', '255', '-2048', '2047', '63', '-7'])}`);
    // rotate a0 and mix the result in, using it right away, one instruction later or three later, so the
    // pipeline's waits for a custom result (two cycles, one, none) are all exercised
    const gap = n % 3;
    if (gap === 0) lines.push('    xor a0, a0, a3', '    slli a4, a0, 7', '    srli a5, a0, 57', '    or a0, a4, a5');
    else if (gap === 1) lines.push('    slli a4, a0, 7', '    xor a4, a4, a3', '    srli a5, a0, 57', '    or a0, a4, a5');
    else lines.push('    slli a4, a0, 7', '    srli a5, a0, 57', '    or a0, a4, a5', '    xor a0, a0, a3');
  }
  lines.push('    halt');
  return lines.join('\n') + '\n';
}

const specFile = path.join(ROOT, 'build', 'custom_fuzz.json'), progFile = path.join(ROOT, 'tests', 'zz_custom_fuzz.s');
fs.mkdirSync(path.dirname(specFile), { recursive: true });
let failed = false;
// Put the default instructions back even if the run is interrupted (Ctrl+C or a CI timeout)
const restore = () => { try { if (fs.existsSync(progFile)) fs.rmSync(progFile); execFileSync('node', ['tools/custom.mjs'], { cwd: ROOT, stdio: 'pipe' }); } catch { /* best effort */ } };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { restore(); process.exit(130); });
try {
  for (let r = 0; r < rounds; r++) {
    const list = spec(r);
    fs.writeFileSync(specFile, JSON.stringify({ instructions: list }, null, 1));
    execFileSync('node', ['tools/custom.mjs', '--spec', specFile], { cwd: ROOT, stdio: 'pipe' });
    fs.writeFileSync(progFile, program(list));
    let out = '';
    try { out = execFileSync('node', ['tools/test.mjs', 'zz_custom_fuzz'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }); }
    catch (e) { out = (e.stdout || '') + (e.stderr || ''); failed = true; }
    const summary = out.trim().split('\n').pop();
    console.log(`round ${r + 1}: ${list.length} random instructions, ${list.length * 4} operand pairs: ${summary}`);
    if (failed) { console.log(out); console.log(`the failing instruction set is in ${path.relative(ROOT, specFile)}`); break; }
  }
} finally {
  if (fs.existsSync(progFile)) fs.rmSync(progFile);
  execFileSync('node', ['tools/custom.mjs'], { cwd: ROOT, stdio: 'pipe' }); // the default instructions again
}
process.exit(failed ? 1 : 0);
