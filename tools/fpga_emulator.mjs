#!/usr/bin/env node
// =============================================================================
// tools/fpga_emulator.mjs: the Sixfold FPGA computer on your PC, talking over stdin / stdout
//
//   node tools/fpga_emulator.mjs [--program fpga/examples/calculator.s] [--switches 0x0C05] [--show]
//
// The same emulation as the site's FPGA console (web/fpga_system.js): the boot firmware on the
// cycle-exact model, with the board's device registers. Bytes on stdin are the serial port's receive
// line, stdout is its transmit line. tools/virtual_board.py puts it behind a pseudo serial port, so
// tools/fpga_load.py, screen or minicom talk to it exactly as to a real board.
//   --program   a program in memory from power-on, as `make fpga-basys3 PROG=...` builds it in
//   --switches  the slide switches (default 0)
//   --show      print the LEDs and the digits on stderr whenever they change
// It runs as fast as the model can (several million cycles a second); the CLOCK register still says
// 1 MHz, so a program that waits for "one second" waits for 1,000,000 cycles.
// =============================================================================
import fs from 'node:fs';
import { EmulatedSystem } from '../web/fpga_system.js';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const show = args.includes('--show');

const SEGMENT_CHARS = { 0x3F: '0', 0x06: '1', 0x5B: '2', 0x4F: '3', 0x66: '4', 0x6D: '5', 0x7D: '6', 0x07: '7', 0x7F: '8', 0x6F: '9',
  0x77: 'A', 0x7C: 'b', 0x39: 'C', 0x5E: 'd', 0x79: 'E', 0x71: 'F', 0x40: '-', 0x38: 'L', 0x50: 'r', 0x5C: 'o', 0x73: 'P', 0x30: 'I', 0x00: ' ' };
export const digitsText = v => [3, 2, 1, 0].map(d => { const b = (v >>> (8 * d)) & 0xff; return (SEGMENT_CHARS[b & 0x7f] ?? '?') + (b & 0x80 ? '.' : ''); }).join('');
const ledsText = v => [...Array(16).keys()].reverse().map(i => ((v >> i) & 1 ? '*' : '.')).join('');

let leds = 0, display = 0;
const status = () => { if (show) process.stderr.write(`[board] LEDs ${ledsText(leds)}  display [${digitsText(display)}]\n`); };
const system = new EmulatedSystem(
  c => process.stdout.write(Buffer.from([c])),
  v => { if (v !== leds) { leds = v; status(); } },
  v => { if (v !== display) { display = v; status(); } });
system.switches = Number(opt('--switches') || 0);
system.powerOn(opt('--program') ? fs.readFileSync(opt('--program'), 'utf8') : null);

process.stdin.on('data', chunk => system.send([...chunk]));
process.stdin.on('end', () => process.exit(0));
const slice = () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 20 && !system.waiting) system.run(5000);
  setTimeout(slice, system.waiting ? 5 : 0);
};
slice();
