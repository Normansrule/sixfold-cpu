#!/usr/bin/env node
// =============================================================================
// tools/fpga_sim.mjs: the FPGA computer, simulated end to end, against the model
//
//   node tools/fpga_sim.mjs [program.s ...]     (default: every program and the ISA self-check)
//
// For each program: tools/fpga_image.mjs makes the upload stream, the Verilator build of
// fpga/sim/system_testbench.sv powers the system on, waits for the boot firmware's prompt, uploads
// the program over the simulated UART, runs it and reads the firmware's report. Checked:
//   * the firmware reports PASS (or the same FAIL as the model)
//   * the program's printed output, as it arrived over the UART, equals the model's
//   * the cycle count the system measured equals the cycle-exact model's
// Programs for a person at the board (fpga/examples/) say instead what to do and what must happen:
//   # FPGA-INPUT: text               keys typed right after the upload (tools/fpga_image.mjs)
//   # FPGA-STEPS: sw=0x0C05 wait=20 press=U key=q    switches, buttons (C U D L R, held 30 ms, then
//                                    released for 30 ms), keys and waits in milliseconds (1 ms = 1000 cycles here)
//   # FPGA-EXPECT-OUTPUT: text       must appear in what the program prints (any number of these lines)
//   # FPGA-EXPECT-LEDS: 0x0006       the LEDs at the end;  # FPGA-EXPECT-DISPLAY: 0x38003F06  the digits
// So the block RAM main memory, the device registers, the boot firmware and the soft reset all
// behave exactly like the simulation platform that `make test` checks cycle by cycle.
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assemble } from '../model/asm.js';
import { Core, CONFIGS } from '../model/core.js';

const BINARY = 'build/fsim/fsim';
const core = fs.readFileSync('src/sources.f', 'utf8').split('\n').filter(f => f && !/Scratchpad|Riscv64_top/.test(f));
const fpga = fs.readFileSync('fpga/sources.f', 'utf8').split('\n').filter(Boolean);
const sources = [...core, ...fpga, 'fpga/sim/system_testbench.sv'];
const newest = Math.max(...sources.map(f => fs.statSync(f).mtimeMs));
if (!fs.existsSync(BINARY) || fs.statSync(BINARY).mtimeMs < newest) {
  process.stdout.write('building the FPGA system simulation with Verilator... ');
  fs.mkdirSync('build/fsim', { recursive: true });
  execFileSync('verilator', ['--binary', '--timing', '-O2', '-DSIXFOLD_FPGA', '-Wno-fatal', '-Wno-TIMESCALEMOD', '-Wno-lint', '-Wno-style', ...sources,
    '--top-module', 'system_testbench', '-Mdir', 'build/fsim', '-o', 'fsim'], { stdio: ['ignore', 'ignore', 'inherit'] });
  console.log('done');
}

execFileSync('node', ['tools/fpga_image.mjs', '--out', 'build/fpga'], { stdio: 'ignore' }); // the power-on image: firmware only
let programs = process.argv.slice(2);
if (!programs.length) programs = ['programs', 'tests', 'fpga/examples'].flatMap(d => fs.readdirSync(d).filter(f => f.endsWith('.s')).sort().map(f => `${d}/${f}`));
let failed = 0;
for (const program of programs) {
  const name = path.basename(program, '.s');
  const out = `build/fpga/${name}`;
  fs.mkdirSync(out, { recursive: true });
  execFileSync('node', ['tools/fpga_image.mjs', program, '--out', out], { stdio: 'ignore' });
  const source = fs.readFileSync(program, 'utf8');
  const readsDevices = /^# FPGA: reads the clock rate/m.test(source); // runs longer on the board, on purpose
  const expectedLines = [...source.matchAll(/^# FPGA-EXPECT-OUTPUT: (.*)$/gm)].map(m => m[1]); // board-only programs: check what they print
  const expected = expectedLines.length ? expectedLines : null;
  const expectLeds = /^# FPGA-EXPECT-LEDS: (\S+)/m.exec(source), expectDisplay = /^# FPGA-EXPECT-DISPLAY: (\S+)/m.exec(source);
  const stepArgs = [];
  const stepTokens = [...source.matchAll(/^# FPGA-STEPS: (.*)$/gm)].flatMap(m => m[1].trim().split(/\s+/));
  if (stepTokens.length) {
    const BUTTON = { C: 0x01, U: 0x04, D: 0x08, L: 0x10, R: 0x20 };
    let switches = 0;
    const lines = [], line = (kind, sw, b, units) => lines.push(((BigInt(kind) << 40n) | (BigInt(sw) << 24n) | (BigInt(b) << 16n) | BigInt(units)).toString(16).padStart(12, '0'));
    line(1, 0, 0, 500); // 50 ms: let the program start and print its greeting
    for (const t of stepTokens) {
      const [k, v] = t.split('=');
      if (k === 'sw') { switches = Number(v); line(1, switches, 0, 0); }
      else if (k === 'wait') line(1, switches, 0, Number(v) * 10);
      else if (k === 'press') { line(1, switches, BUTTON[v], 300); line(1, switches, 0, 300); }
      else if (k === 'key') line(2, switches, v.charCodeAt(0), 50);
      else throw new Error(`${program}: unknown FPGA-STEPS item ${t}`);
    }
    fs.writeFileSync(`${out}/steps.hex`, lines.join('\n') + '\n');
    stepArgs.push(`+STEPS=${out}/steps.hex`);
  }
  const model = new Core(assemble(source), { ...CONFIGS.performance, exceptions: false, bp: true }); // the FPGA system keeps EXCEPTIONS = 0
  if (!expected) model.run(5e6, false);
  const text = execFileSync(BINARY, [`+UPLOAD=${out}/upload.hex`, ...stepArgs, '+MAXCYCLES=20000000'], { encoding: 'latin1', maxBuffer: 1 << 26 });
  fs.writeFileSync(`${out}/uart.txt`, text);
  const start = text.indexOf('starting the program at 0x2000\r\n'), end = text.indexOf('\r\n[bios] program finished: ');
  const report = /program finished: (PASS|FAIL, test (\d+)) in (\d+) cycles/.exec(text);
  const problems = [];
  if (start < 0 || end < 0 || !report) problems.push('no report from the firmware (see ' + out + '/uart.txt)');
  else {
    const printed = text.slice(start + 'starting the program at 0x2000\r\n'.length, end);
    const tohost = report[1] === 'PASS' ? 1n : (BigInt(report[2]) << 1n) | 1n;
    if (expected) {
      if (report[1] !== 'PASS') problems.push(`the firmware reported ${report[1]}`);
      for (const e of expected) if (!printed.includes(e)) problems.push(`expected ${JSON.stringify(e)} in what it printed (see ${out}/uart.txt)`);
      const end = /LEDs ([01]{16}), display ([0-9a-f]{8})/.exec(text);
      if (expectLeds && (!end || parseInt(end[1], 2) !== Number(expectLeds[1]))) problems.push(`LEDs ${end ? '0x' + parseInt(end[1], 2).toString(16) : '?'}, expected ${expectLeds[1]}`);
      if (expectDisplay && (!end || parseInt(end[2], 16) !== Number(expectDisplay[1]))) problems.push(`display ${end ? '0x' + end[2] : '?'}, expected ${expectDisplay[1]}`);
    }
    else {
      if (tohost !== model.csr.tohost) problems.push(`TOHOST ${tohost}, model ${model.csr.tohost}`);
      if (printed !== model.output) problems.push(`output differs: ${JSON.stringify(printed.slice(0, 60))} vs model ${JSON.stringify(model.output.slice(0, 60))}`);
      if (!readsDevices && Number(report[3]) !== model.stats.cycles) problems.push(`${report[3]} cycles, model ${model.stats.cycles}`);
    }
  }
  if (problems.length) failed++;
  console.log(`${problems.length ? 'FAIL' : 'PASS'} ${program.padEnd(36)} ${report ? `${report[1].padEnd(4)} ${report[3].padStart(7)} cycles ${expected ? `(${stepTokens.length ? 'switches, buttons and keys' : 'typed input'}; ${expected.length} expected line${expected.length > 1 ? 's' : ''} printed${expectLeds ? ', LEDs and display right' : ''})` : readsDevices ? '(waits on the clock rate: longer than the model, on purpose)' : '= model'}` : ''}${problems.length ? '  ' + problems.join('; ') : ''}`);
}
console.log(`\n${programs.length - failed} passed, ${failed} failed (the FPGA system, over its UART, against the model)`);
process.exit(failed ? 1 : 0);
