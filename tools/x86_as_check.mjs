#!/usr/bin/env node
// =============================================================================
// tools/x86_as_check.mjs: our x86-64 encoder against the GNU assembler, byte for byte
//
//   node tools/x86_as_check.mjs        (needs `as` and `objdump` for x86-64: binutils)
//
// Every instruction form model/isas/x86.js can emit (each ALU operation with each operand kind, every
// addressing mode with its special cases: rsp/r12 bases need a SIB byte, rbp/r13 bases need a
// displacement, an absolute address uses SIB with no base) is assembled twice: by our assembler and by
// GNU as (Intel syntax, no optimisation). The bytes must be identical. Jumps and calls are left out:
// GNU as shortens them to 2 bytes when it can, while ours always uses the 32-bit form (Capstone checks
// their lengths in tools/isa_crosscheck.py).
// =============================================================================
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assemble } from '../model/isas/x86.js';

const R64 = ['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi', 'r8', 'r9', 'r12', 'r13', 'r15'];
const MEMS = ['[rax]', '[rsi + 8]', '[rsp]', '[rsp + 16]', '[rbp]', '[rbp - 8]', '[r12]', '[r13]', '[r13 + 4]', '[rsi + rcx*8]',
  '[rdi + rax*4 + 12]', '[rbx + r9*2 - 200]', '[0x2070]', '[rax + 1000]', '[r8 + r15*1]'];
const ALU = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'];
const forms = [];
for (const op of ALU) {
  forms.push(`${op} rax, rcx`, `${op} r9, r12`, `${op} rdx, [rsi + 8]`, `${op} [rdi + 16], r10`, `${op} rbx, 5`, `${op} rbx, -128`, `${op} rbx, 1000`,
    `${op} rax, 1000`, `${op} rax, 5`, `${op} qword ptr [rsi], 7`, `${op} qword ptr [rsp + 8], 70000`, `${op} al, 3`, `${op} cl, dl`, `${op} byte ptr [rdi], 9`);
}
forms.push('test rax, rax', 'test rcx, rdx', 'test rax, 256', 'test rbx, 256', 'test al, 1', 'test cl, 4', 'test cl, dl');
for (const r of R64) forms.push(`mov ${r}, rcx`, `mov ${r}, 5`);
for (const m of MEMS) forms.push(`mov rax, ${m}`, `mov ${m}, rdx`, `lea rdi, ${m}`);
forms.push('mov r11, -1', 'mov rax, 0x123456789', 'mov qword ptr [rsi], -3', 'mov al, [rsi]', 'mov [rdi + 1], cl', 'mov byte ptr [rdi], 65', 'mov dl, 7', 'mov r8b, 1',
  'movzx rax, byte ptr [rsi]', 'movzx rcx, byte ptr [r8 + 3]', 'movzx rdx, al',
  'inc rax', 'dec r12', 'inc qword ptr [rsi]', 'not rbx', 'neg r9', 'mul rcx', 'imul rdi', 'div r8', 'idiv rbx', 'cqo',
  'imul rax, rcx', 'imul rdx, [rsi + 8]', 'imul rbx, rcx, 10', 'imul rbx, rcx, 1000',
  'shl rax, 1', 'shr rbx, 3', 'sar r10, 63', 'shl rcx, cl', 'shr rdx, cl',
  'push rbx', 'push r12', 'pop rbp', 'pop r15', 'ret', 'nop', 'hlt');
for (const cc of ['e', 'ne', 'l', 'le', 'g', 'ge', 'b', 'a']) forms.push(`set${cc} al`, `cmov${cc} rax, rcx`, `cmov${cc} rdx, [rsi]`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x86as-'));
const src = path.join(dir, 'f.s'), obj = path.join(dir, 'f.o');
fs.writeFileSync(src, '.intel_syntax noprefix\n.text\n' + forms.join('\n') + '\n');
try { execFileSync('as', ['--64', '-o', obj, src]); } catch (e) { console.error('GNU as (x86-64) is needed: apt install binutils'); process.exit(2); }
const dump = execFileSync('objdump', ['-d', '-M', 'intel', obj], { encoding: 'utf8' });
// objdump prints one line per instruction (long ones continue on a second line with only bytes)
const theirs = [];
for (const line of dump.split('\n')) {
  const m = line.match(/^\s+[0-9a-f]+:\t((?:[0-9a-f]{2} )+)\s*(\t.*)?$/);
  if (!m) continue;
  const bytes = m[1].trim().split(' ');
  if (m[2]) theirs.push(bytes); else theirs[theirs.length - 1].push(...bytes);
}
const rows = assemble(forms.join('\n')).listing.filter(r => r.kind === 'insn');
let bad = 0;
forms.forEach((f, i) => {
  const ours = rows[i].bytes.map(b => b.toString(16).padStart(2, '0'));
  if (ours.join(' ') !== (theirs[i] || []).join(' ')) { bad++; console.log(`DIFF ${f.padEnd(34)} ours ${ours.join(' ')}   GNU as ${(theirs[i] || []).join(' ')}`); }
});
fs.rmSync(dir, { recursive: true });
console.log(`${forms.length - bad} of ${forms.length} x86-64 instruction forms identical to GNU as${bad ? `, ${bad} differ` : ''}`);
process.exit(bad ? 1 : 0);
