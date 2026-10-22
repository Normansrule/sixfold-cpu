#!/usr/bin/env node
// =============================================================================
// tools/isa_dump.mjs: one comparison program, assembled and run on our model, as JSON
//
//   node tools/isa_dump.mjs mips programs/compare/mips/gcd.s
//
// Prints { arch, start, bytes (hex, 0x2000 to the end of the program), instructions: [{ addr, size }],
// registers: [names, final values as decimal strings], output, cycles }. tools/isa_crosscheck.py runs the
// same bytes on Unicorn (QEMU's CPU emulation) and compares.
// =============================================================================
import fs from 'node:fs';
import { ARCHS } from '../model/isas/index.js';

const [arch, file] = process.argv.slice(2);
const A = ARCHS[arch];
if (!A) { console.error('usage: node tools/isa_dump.mjs riscv|mips|x86 program.s'); process.exit(2); }
const img = A.assemble(fs.readFileSync(file, 'utf8'));
const core = A.makeCore(img).run(5e6);
const [lo, hi] = img.used;
console.log(JSON.stringify({
  arch, start: lo, bytes: Buffer.from(img.bytes.slice(lo, hi)).toString('hex'),
  instructions: A.listing(img).map(r => ({ addr: r.addr, size: r.size, text: r.text })),
  registers: core.registers().map(r => [r.name, typeof r.value === 'bigint' ? r.value.toString() : String(r.value)]),
  output: core.output, cycles: core.stats.cycles, halted: core.halted,
}));
