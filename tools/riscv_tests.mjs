#!/usr/bin/env node
// =============================================================================
// tools/riscv_tests.mjs: the official RISC-V unit tests (riscv-tests) on every Sixfold build
//
// riscv-tests (github.com/riscv-software-src/riscv-tests, BSD-3-Clause) is the instruction-by-instruction
// test suite the RISC-V community uses: one self-checking program per instruction, each with many
// corner cases (overflow, sign extension, x0 as a source or destination, forwarding distances).
// This script:
//   1. fetches the suite at a pinned commit into build/riscv-tests-src (nothing is copied into the repo)
//   2. assembles the user-level tests Sixfold implements (RV64I, M, Zba, Zbb, Zbs) with the GNU toolchain
//      and Sixfold's own environment header tests/riscv-tests/env/riscv_test.h (machine mode, TOHOST CSR)
//   3. runs every one through tools/test.mjs --images: the cycle-exact model AND the RTL of every build,
//      predictor on and off, with the same cycle-by-cycle comparison as the regression
//   4. checks the cycle equation (docs/MATH.md, tools/verify_math.mjs --images) on every test and build
//
//   node tools/riscv_tests.mjs                 everything (make riscv-tests)
//   node tools/riscv_tests.mjs --no-rtl        model only
//   node tools/riscv_tests.mjs --config=turbo  one build (other tools/test.mjs options pass through)
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const REPO = 'https://github.com/riscv-software-src/riscv-tests';
const COMMIT = '3df703c'; // pinned so results are reproducible; bump on purpose and re-run
const SRC = 'build/riscv-tests-src', OUT = 'build/riscv-tests', ENV = 'tests/riscv-tests/env';
// The suites Sixfold implements: test directory -> the -march extensions it needs
const SUITES = ['rv64ui', 'rv64um', 'rv64uzba', 'rv64uzbb', 'rv64uzbs'];
const MARCH = 'rv64im_zicsr_zifencei_zba_zbb_zbs';
// Tests left out, each with the reason. A test goes here only when Sixfold does not implement what it checks;
// never to hide a failure of something it does implement.
const NOT_IMPLEMENTED = {
  'rv64ui-ma_data': 'misaligned loads and stores: Sixfold neither performs them in hardware nor traps them (an address-misaligned exception is on the privileged-architecture list in docs/COMPLIANCE.md)',
};

const run = (cmd, args, opts = {}) => { const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts }); if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}\n${r.stderr || r.stdout || r.error}`); return r.stdout; };

// 1. the suite at the pinned commit
if (!fs.existsSync(`${SRC}/.git`)) {
  console.log(`fetching riscv-tests ${COMMIT} ...`);
  run('git', ['clone', '-q', REPO, SRC]);
}
const head = run('git', ['-C', SRC, 'rev-parse', '--short=7', 'HEAD']).trim();
if (head !== COMMIT) { run('git', ['-C', SRC, 'fetch', '-q', 'origin']); run('git', ['-C', SRC, 'checkout', '-q', COMMIT]); }

// 2. assemble: riscv64-unknown-elf-* (Ubuntu: gcc-riscv64-unknown-elf), else riscv64-linux-gnu-*
const prefix = ['riscv64-unknown-elf-', 'riscv64-linux-gnu-'].find(p => !spawnSync(`${p}gcc`, ['--version']).error);
if (!prefix) { console.log('no RISC-V GCC found: sudo apt install gcc-riscv64-unknown-elf'); process.exit(1); }
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
let built = 0;
for (const suite of SUITES) {
  for (const file of fs.readdirSync(`${SRC}/isa/${suite}`).filter(f => f.endsWith('.S')).sort()) {
    const name = `${suite}-${path.basename(file, '.S')}`;
    if (NOT_IMPLEMENTED[name]) { console.log(`skip ${name}: ${NOT_IMPLEMENTED[name]}`); continue; }
    const elf = `${OUT}/${name}.elf`;
    run(`${prefix}gcc`, [`-march=${MARCH}`, '-mabi=lp64', '-static', '-mcmodel=medany', '-nostdlib', '-nostartfiles',
      `-I${ENV}`, `-I${SRC}/isa/macros/scalar`, '-T', `${ENV}/link.ld`, `${SRC}/isa/${suite}/${file}`, '-o', elf]);
    run(`${prefix}objcopy`, ['-O', 'binary', elf, `${OUT}/${name}.bin`]);
    fs.writeFileSync(`${OUT}/${name}.dump`, run(`${prefix}objdump`, ['-d', elf], { maxBuffer: 1 << 26 }));
    built++;
  }
}
console.log(`riscv-tests ${COMMIT}: ${built} tests built from ${SUITES.join(', ')}; ${Object.keys(NOT_IMPLEMENTED).length} left out (reasons above)\n`);

// 3. every build, model and RTL, cycle-exact; 4. the cycle equation (docs/MATH.md) on every test, every build
const r = spawnSync('node', ['tools/test.mjs', `--images=${OUT}`, ...process.argv.slice(2)], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
const m = spawnSync('node', ['tools/verify_math.mjs', `--images=${OUT}`], { encoding: 'utf8', maxBuffer: 1 << 26 });
const rows = (m.stdout.match(/ OK$/gm) || []).length, bad = (m.stdout.match(/MISMATCH/g) || []).length;
console.log(`cycle equation: OK on ${rows} of ${rows + bad} test/build/predictor runs`);
if (m.status !== 0) console.log(m.stdout.split('\n').filter(l => l.includes('MISMATCH')).join('\n'));
process.exit(m.status ?? 1);
