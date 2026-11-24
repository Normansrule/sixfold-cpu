#!/usr/bin/env node
// =============================================================================
// tools/test.mjs: regression suite.
//
// For every program in programs/ and tests/:
//   1. assemble it                                   (model/asm.js)
//   2. run it on the cycle-exact model               (model/core.js)
//   3. check the "# EXPECT:" lines in its header     (register values, output)
//      and that the program reported PASS through the tohost CSR
//   4. run the SAME image on the SystemVerilog RTL   (iverilog, src/sources.f + tb/riscv64_testbench.sv)
//   5. demand the RTL and the model agree on EVERY cycle's pipeline contents,
//      the cycle count, the program output, tohost and all 32 registers.
//
//   node tools/test.mjs              everything
//   node tools/test.mjs --no-rtl     model only (no Icarus Verilog needed)
//   node tools/test.mjs 05           only programs whose name contains "05"
//   node tools/test.mjs --bp=off     only the static not-taken configuration
//   node tools/test.mjs --config=turbo   one build only (performance, baseline, turbo, deep, compact or xoff; default all six)
//   (xoff: the performance build with XCOMPUTE = 0 and EXCEPTIONS = 0, the default HYDRA-130 instantiates: every program that
//   uses no packed instruction must run exactly as on the performance build, and tests/xcompute_off.s checks
//   that the packed encodings give 0)
//   node tools/test.mjs --images=DIR     raw images DIR/*.bin (loaded at the reset vector 0x2000) instead of the
//                                        assembly programs: the official riscv-tests suite (make riscv-tests,
//                                        tools/riscv_tests.mjs). Each must report PASS through TOHOST
//   node tools/test.mjs --sram           the cached builds' RTL with the caches in SRAM macros (same model, same cycles;
//                                        performance and turbo, the builds make test-sram runs)
//   (deep: the deep-pipeline edition, model/deep.js against src/deep/ and tb/riscv64_deep_testbench.sv)
//
// Every program runs TWICE: with the gshare predictor and with it disabled.
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { assemble, toHex, toListing } from '../model/asm.js';
import { Core, CONFIGS, RESET_PC } from '../model/core.js';
import { DeepCore } from '../model/deep.js';
import { regNum, ABI } from '../model/isa.js';
import { activeList } from '../model/custom.js';

const args = process.argv.slice(2);
const noRtl = args.includes('--no-rtl');
const filter = args.find(a => !a.startsWith('--'));
const bpArg = (args.find(a => a.startsWith('--bp=')) || '--bp=both').slice(5);
const cfgArg = (args.find(a => a.startsWith('--config=')) || '--config=all').slice(9);
const CONFIG_NAMES = cfgArg === 'all' ? ['performance', 'baseline', 'turbo', 'deep', 'compact', 'xoff'] : cfgArg === 'both' ? ['performance', 'baseline'] : [cfgArg];
const MODES = (bpArg === 'on' ? [true] : bpArg === 'off' ? [false] : [true, false]).flatMap(bp => CONFIG_NAMES.map(cfg => ({ bp, cfg })));
const useIcarus = args.includes('--icarus');
// --sram: the RTL of every cached build keeps its cache lines in sram22 SRAM macros (SRAM_CACHES, docs/SILICON.md),
// checked against the SAME model: the macros must not change a single cycle
const useSram = args.includes('--sram');
const SRAM_MODELS = fs.readdirSync('asic/macros').filter(d => fs.existsSync(`asic/macros/${d}/${d}.v`)).map(d => `asic/macros/${d}/${d}.v`);
const tty = process.stdout.isTTY;
const green = s => (tty ? `\x1b[32m${s}\x1b[0m` : s), red = s => (tty ? `\x1b[31m${s}\x1b[0m` : s);

const imagesDir = (args.find(a => a.startsWith('--images=')) || '').slice(9);
const files = (imagesDir ? fs.readdirSync(imagesDir).filter(f => f.endsWith('.bin')).sort().map(f => path.join(imagesDir, f))
  : ['programs', 'tests'].flatMap(d => fs.readdirSync(d).filter(f => f.endsWith('.s')).sort().map(f => path.join(d, f))))
  .filter(f => !filter || f.includes(filter));

fs.mkdirSync('build', { recursive: true });
let haveRtl = false;
const SIM = {};
if (!noRtl) {
  // Verilator (compiled C++, fast) if installed, otherwise Icarus Verilog. One binary per configuration.
  // The deep-pipeline edition is its own design (src/deep/sources.f, its own testbench and trace format)
  const hasVerilator = !useIcarus && !spawnSync('verilator', ['--version']).error;
  for (const cfg of CONFIG_NAMES) {
    const deep = cfg === 'deep';
    const sources = fs.readFileSync(deep ? 'src/deep/sources.f' : 'src/sources.f', 'utf8').split('\n').filter(Boolean)
      .concat(useSram && !deep ? SRAM_MODELS : []);
    const tb = deep ? 'tb/riscv64_deep_testbench.sv' : 'tb/riscv64_testbench.sv', top = deep ? 'riscv64_deep_testbench' : 'riscv64_testbench';
    const def = (cfg === 'baseline' ? ['-DBASELINE'] : cfg === 'turbo' ? ['-DTURBO'] : cfg === 'compact' ? ['-DCOMPACT'] : cfg === 'xoff' ? ['-DXCOMPUTE_OFF'] : []).concat(useSram && !deep ? ['-DSRAM'] : []);
    let r;
    if (hasVerilator) {
      const dir = `build/vsim_${cfg}${useSram && !deep ? '_sram' : ''}`;
      const stamp = sources.concat(tb).map(f => fs.statSync(f).mtimeMs).reduce((a, b) => Math.max(a, b));
      if (fs.existsSync(`${dir}/vsim`) && fs.statSync(`${dir}/vsim`).mtimeMs > stamp) { SIM[cfg] = [`${dir}/vsim`]; continue; }
      process.stdout.write(`building ${cfg} RTL with Verilator... `);
      r = spawnSync('verilator', ['--binary', '--timing', '-O3', '-Wno-fatal', '-Wno-lint', '-Wno-style', ...def, ...sources, tb, '--top-module', top, '-Mdir', dir, '-o', 'vsim'], { encoding: 'utf8', maxBuffer: 1 << 26 });
      console.log(r.status === 0 ? 'done' : 'failed');
      SIM[cfg] = [`${dir}/vsim`];
    } else {
      const vvp = `build/sim_${cfg}${useSram && !deep ? '_sram' : ''}.vvp`;
      r = spawnSync('iverilog', ['-g2012', ...def, '-o', vvp, ...sources, tb], { encoding: 'utf8' });
      SIM[cfg] = ['vvp', '-n', vvp];
    }
    if (r.error) { console.log('no Verilog simulator found: skipping RTL comparison (sudo apt install verilator iverilog)'); break; }
    if (r.status !== 0) { console.log(red(`RTL (${cfg}) failed to compile:\n`) + (r.stderr || r.stdout).slice(-3000)); process.exit(1); }
    haveRtl = true;
  }
  if (Object.keys(SIM).length === CONFIG_NAMES.length) haveRtl = true;
}

// "# EXPECT: a0 = 5" always; "# EXPECT[gshare]: ..." / "# EXPECT[bp-off]: ..." only in that predictor mode
// (timing measured with rdcycle legitimately differs between the two modes).
// "# EXPECT[gshare]" / "# EXPECT[bp-off]" are timing values of the BASELINE build; "# EXPECT[perf]" /
// "# EXPECT[perf-bp-off]" of the performance build; "# EXPECT[turbo]" / "# EXPECT[turbo-bp-off]" of the turbo build;
// "# EXPECT[deep]" / "# EXPECT[deep-bp-off]" of the deep-pipeline edition.
function parseExpect(src, bp, cfg) {
  const regs = [], out = [];
  const want = cfg === 'baseline' ? (bp ? 'gshare' : 'bp-off') : cfg === 'turbo' ? (bp ? 'turbo' : 'turbo-bp-off') : cfg === 'deep' ? (bp ? 'deep' : 'deep-bp-off') : cfg === 'compact' ? (bp ? 'compact' : 'compact-bp-off') : (bp ? 'perf' : 'perf-bp-off'); // xoff: as performance
  for (const m of src.matchAll(/^#\s*EXPECT(?:\[([\w-]+)\])?:\s*(\w+)\s*=\s*(-?\w+)\s*$/gm))
    if (!m[1] || m[1] === want) regs.push([m[2], BigInt.asUintN(64, BigInt(m[3]))]);
  for (const m of src.matchAll(/^#\s*EXPECT-OUTPUT:\s?(.*)$/gm)) out.push(m[1].replace(/\\n/g, '\n'));
  return { regs, output: out.length ? out.join('') : null };
}

// A program uses the packed instructions if it names one (custom-0 group "xcompute")
const packedNames = activeList().filter(c => c.group === 'xcompute').map(c => c.name.replace(/\./g, '\\.'));
const PACKED = new RegExp(`^\\s*(?:\\w+:\\s*)?(?:${packedNames.join('|') || '(?!)'})\\s`, 'm');

// A raw binary (objcopy -O binary of an ELF linked at 0x2000) as an image toHex and the cores accept
function rawImage(bin) {
  if (RESET_PC + bin.length > 65536) throw new Error(`image of ${bin.length} bytes does not fit in 64 KiB above 0x${RESET_PC.toString(16)}`);
  const bytes = new Uint8Array(65536); bytes.set(bin, RESET_PC);
  return { bytes, used: [RESET_PC, RESET_PC + bin.length], listing: [] };
}

let pass = 0, fail = 0;
for (const f of files) {
  const isImage = f.endsWith('.bin');
  const name = path.basename(f, isImage ? '.bin' : '.s');
  const src = isImage ? '' : fs.readFileSync(f, 'utf8'); // a raw image has no EXPECT lines: only TOHOST = 1 counts
  let img;
  try { img = isImage ? rawImage(fs.readFileSync(f)) : assemble(src); } catch (e) { console.log(`${red('FAIL')} ${f}: assembly error\n${e.message}`); fail++; continue; }
  fs.writeFileSync(`build/${name}.hex`, toHex(img));
  fs.writeFileSync(`build/${name}.lst`, toListing(img));

  // The packed instructions exist only with XCOMPUTE = 1: the xoff build skips programs that use them and runs
  // only it the program that checks they are off
  const usesPacked = PACKED.test(src), offOnly = /^#\s*XCOMPUTE:\s*off\s*$/m.test(src);
  // Programs that need the exceptions (EXCEPTIONS = 1 in src/Riscv64.sv: "# EXCEPTIONS: on", and the official
  // rv64mi-* machine-mode tests) run on the builds that have them: not xoff (HYDRA-130's default) and not deep
  const needsExceptions = /^#\s*EXCEPTIONS:\s*on\s*$/m.test(src) || name.startsWith('rv64mi-');
  for (const { bp, cfg } of MODES) {
  if (cfg === 'xoff' ? usesPacked && !offOnly : offOnly) continue;
  if (needsExceptions && (cfg === 'xoff' || cfg === 'deep')) continue;
  const problems = [];
  const tag = `${cfg === 'baseline' ? 'base' : cfg === 'turbo' ? 'turb' : cfg === 'deep' ? 'deep' : cfg === 'compact' ? 'cmpt' : cfg === 'xoff' ? 'xoff' : 'perf'} ${bp ? 'gshare' : 'no-bp '}`;
  const tr = `${cfg}.${bp ? 'bp' : 'nobp'}`;
  // ---------------- model ----------------
  const core = cfg === 'deep' ? new DeepCore(img, { bp }) : cfg === 'xoff' ? new Core(img, { ...CONFIGS.performance, xcompute: false, exceptions: false, bp }) : new Core(img, { ...CONFIGS[cfg], bp });
  const traceLine = cfg === 'deep' ? DeepCore.traceLine : Core.traceLine;
  const trace = [];
  while (!core.halted && core.cycle < 2000000) trace.push(traceLine(core.step()));
  if (!core.halted) problems.push('model did not halt');
  fs.writeFileSync(`build/${name}.${tr}.model.trace`, trace.join('\n') + '\n');
  const exp = parseExpect(src, bp, cfg);
  for (const [r, v] of exp.regs) {
    const got = core.regs[regNum(r)];
    if (got !== v) problems.push(`model: ${r} = ${BigInt.asIntN(64, got)} (0x${got.toString(16)}), expected ${BigInt.asIntN(64, v)}`);
  }
  if (exp.output !== null && core.output !== exp.output) problems.push(`model: output ${JSON.stringify(core.output)}, expected ${JSON.stringify(exp.output)}`);
  if (core.halted && core.csr.tohost !== 1n) problems.push(`model: tohost = ${core.csr.tohost}: FAIL in test ${core.csr.tohost >> 1n}`);

  // ---------------- RTL ----------------
  let rtlNote = '';
  if (haveRtl && core.halted) {
    const [cmd, ...pre] = SIM[cfg];
    const r = spawnSync(cmd, [...pre, `+HEX=build/${name}.hex`, `+TRACE=build/${name}.${tr}.rtl.trace`, '+MAXCYCLES=2000000', `+BP=${bp ? 1 : 0}`], { encoding: 'utf8', maxBuffer: 1 << 26 });
    const stdout = r.stdout || '';
    const k = stdout.indexOf('[tb] HALT');
    if (k < 0) problems.push('RTL did not halt:\n' + stdout.slice(-500));
    else {
      const rtlOut = stdout.slice(0, k).replace(/\n$/, '');
      if (rtlOut !== core.output) problems.push(`RTL output ${JSON.stringify(rtlOut)} != model ${JSON.stringify(core.output)}`);
      const regs = {};
      for (const m of stdout.matchAll(/^REG x(\d+) ([0-9a-f]+)$/gm)) regs[+m[1]] = BigInt('0x' + m[2]);
      for (let i = 0; i < 32; i++) if (regs[i] !== core.regs[i])
        problems.push(`RTL x${i}(${ABI[i]}) = 0x${(regs[i] ?? 0n).toString(16)}, model = 0x${core.regs[i].toString(16)}`);
      const rt = fs.readFileSync(`build/${name}.${tr}.rtl.trace`, 'utf8').trimEnd().split('\n');
      const n = Math.max(rt.length, trace.length);
      for (let i = 0; i < n; i++) if (rt[i] !== trace[i]) {
        problems.push(`pipeline trace differs at line ${i + 1}:\n      RTL:   ${rt[i]}\n      model: ${trace[i]}`); break;
      }
      const th = stdout.match(/TOHOST = (\d+)/);
      if (!th || BigInt(th[1]) !== core.csr.tohost) problems.push(`RTL tohost ${th ? th[1] : '?'} != model ${core.csr.tohost}`);
      rtlNote = ' | RTL ✓ cycle-exact';
    }
  }
  const s = core.stats;
  const info = `${String(s.cycles).padStart(6)} cycles, CPI ${(s.cycles / s.retired).toFixed(2)}, ${String(s.flushes).padStart(4)} flushes`;
  if (problems.length) { fail++; console.log(`${red('FAIL')} ${tag} ${f}  (${info})`); problems.slice(0, 8).forEach(p => console.log('   - ' + p)); }
  else { pass++; console.log(`${green('PASS')} ${tag} ${f.padEnd(34)} ${info}${rtlNote}`); }
  }
}
console.log(`\n${pass} passed, ${fail} failed${haveRtl ? '' : '  (RTL comparison skipped)'}`);
process.exit(fail ? 1 : 0);
