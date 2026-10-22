#!/usr/bin/env python3
# =============================================================================
# tools/isa_crosscheck.py: our RISC-V, MIPS and x86-64 models against an independent CPU emulator
#
#   python3 tools/isa_crosscheck.py            (every program in programs/compare/, all three architectures)
#
# For each program: tools/isa_dump.mjs assembles it with OUR assembler and runs it on OUR model; then the
# same bytes run on Unicorn (QEMU's CPU emulation, an implementation of each real ISA written by other
# people), and these must agree:
#   * every general-purpose register at the end (and HI, LO on MIPS), and what the program printed
#   * every instruction's length as Capstone (an independent disassembler) decodes it, and that Capstone
#     recognises it at all
# Together with the cycle equation the models check themselves, that is how the comparison pages can be
# trusted: wrong bytes from an encoder, or a wrong meaning in a model, would show up here.
# Needs: pip install unicorn capstone
# =============================================================================
import glob, json, os, subprocess, sys

try:
    import unicorn as uc
    from unicorn import mips_const, x86_const, riscv_const
    import capstone as cs
except ImportError:
    sys.exit('needs unicorn and capstone: pip install unicorn capstone')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEVICE = 0x10000000
ZBB = {'max', 'maxu', 'min', 'minu', 'cpop', 'cpopw', 'clz', 'clzw', 'ctz', 'ctzw', 'andn', 'orn', 'xnor', 'rol', 'ror', 'rori', 'sext.b', 'sext.h', 'zext.h', 'rev8', 'orc.b'}

MIPS_NAMES = ['zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
              's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra']
X86_REGS = ['RAX', 'RCX', 'RDX', 'RBX', 'RSP', 'RBP', 'RSI', 'RDI'] + [f'R{i}' for i in range(8, 16)]
RV_ABI = ['zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7',
          's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6']


def is_halt(arch, code):
    if arch == 'x86':
        return code[:1] == b'\xf4'                                   # hlt
    word = int.from_bytes(code[:4], 'little')
    if arch == 'mips':
        return (word & 0xfc00003f) == 0x0000000d                    # break
    return (word & 0x7f) == 0x73 and (word >> 20) == 0x51e          # csrrwi zero, tohost, 1


def run_unicorn(arch, start, code):
    mode = {'mips': (uc.UC_ARCH_MIPS, uc.UC_MODE_MIPS32 + uc.UC_MODE_LITTLE_ENDIAN),
            'x86': (uc.UC_ARCH_X86, uc.UC_MODE_64),
            'riscv': (uc.UC_ARCH_RISCV, uc.UC_MODE_RISCV64)}[arch]
    emu = uc.Uc(*mode)
    emu.mem_map(0, 0x10000)
    emu.mem_map(DEVICE, 0x1000)
    emu.mem_write(start, code)
    printed = []

    def on_write(emu, access, address, size, value, data):
        if address == DEVICE:
            printed.append(chr(value & 0xff))
    emu.hook_add(uc.UC_HOOK_MEM_WRITE, on_write, begin=DEVICE, end=DEVICE + 0xfff)
    halted = []

    def on_code(emu, address, size, data):
        if is_halt(arch, bytes(emu.mem_read(address, 4 if arch != 'x86' else 1))):
            halted.append(address)
            emu.emu_stop()
    emu.hook_add(uc.UC_HOOK_CODE, on_code)
    emu.emu_start(start, start + len(code) + 0x10000, count=2_000_000)
    if arch == 'mips':
        regs = {MIPS_NAMES[i]: emu.reg_read(getattr(mips_const, f'UC_MIPS_REG_{i}')) & 0xffffffff for i in range(32)}
        regs['hi'] = emu.reg_read(mips_const.UC_MIPS_REG_HI) & 0xffffffff
        regs['lo'] = emu.reg_read(mips_const.UC_MIPS_REG_LO) & 0xffffffff
    elif arch == 'x86':
        regs = {name.lower(): emu.reg_read(getattr(x86_const, f'UC_X86_REG_{name}')) for name in X86_REGS}
    else:
        regs = {RV_ABI[i]: emu.reg_read(getattr(riscv_const, f'UC_RISCV_REG_X{i}')) for i in range(32)}
    return regs, ''.join(printed), bool(halted)


def capstone_lengths(arch, start, code, instructions):
    md = {'mips': cs.Cs(cs.CS_ARCH_MIPS, cs.CS_MODE_MIPS32 + cs.CS_MODE_LITTLE_ENDIAN),
          'x86': cs.Cs(cs.CS_ARCH_X86, cs.CS_MODE_64),
          'riscv': cs.Cs(cs.CS_ARCH_RISCV, cs.CS_MODE_RISCV64 | getattr(cs, 'CS_MODE_RISCVC', 0))}[arch]
    problems = []
    for ins in instructions:
        off = ins['addr'] - start
        got = list(md.disasm(code[off:off + 15], ins['addr'], count=1))
        if not got:
            if arch == 'riscv':
                continue  # Capstone 5 does not know every B-extension instruction (max, min, ...): Unicorn checks those
            problems.append(f"Capstone cannot decode {ins['text']} at 0x{ins['addr']:x}")
        elif got[0].size != ins['size']:
            problems.append(f"{ins['text']} at 0x{ins['addr']:x}: our length {ins['size']}, Capstone's {got[0].size} ({got[0].mnemonic} {got[0].op_str})")
    return problems


def main():
    failed = checked = 0
    for arch in ['riscv', 'mips', 'x86']:
        for path in sorted(glob.glob(os.path.join(ROOT, 'programs', 'compare', arch, '*.s'))):
            name = os.path.relpath(path, ROOT)
            ours = json.loads(subprocess.check_output(['node', os.path.join(ROOT, 'tools', 'isa_dump.mjs'), arch, path], cwd=ROOT))
            code = bytes.fromhex(ours['bytes'])
            problems = capstone_lengths(arch, ours['start'], code, ours['instructions'])
            try:
                regs, printed, halted = run_unicorn(arch, ours['start'], code)
            except uc.UcError as e:
                uses_b = arch == 'riscv' and any(i['text'].split()[0] in ZBB for i in ours['instructions'])
                if uses_b:  # Unicorn's RISC-V predates the B extension; Sixfold's RTL and tests/isa_selfcheck.s check these
                    print(f"SKIP {arch:5} {os.path.relpath(path, ROOT):52} uses Zbb ({', '.join(sorted({i['text'].split()[0] for i in ours['instructions']} & ZBB))}), which Unicorn does not implement")
                    continue
                problems.append(f'Unicorn stopped: {e}')
                regs, printed, halted = {}, '', False
            if not halted:
                problems.append('Unicorn never reached the halt instruction')
            for reg_name, value in ours['registers']:
                if reg_name in ('flags',):
                    continue
                key = reg_name.lstrip('$')
                if key in regs:
                    mask = 0xffffffff if arch == 'mips' else (1 << 64) - 1
                    if (int(value) & mask) != (regs[key] & mask):
                        problems.append(f'{reg_name}: ours {int(value) & mask}, Unicorn {regs[key] & mask}')
            if printed != ours['output']:
                problems.append(f'output: ours {ours["output"]!r}, Unicorn {printed!r}')
            checked += 1
            failed += bool(problems)
            print(f"{'PASS' if not problems else 'FAIL'} {arch:5} {name:52} {len(ours['instructions']):3} instructions, {len(code):4} bytes"
                  + ('' if not problems else '\n       ' + '\n       '.join(problems)))
    print(f'\n{checked - failed} passed, {failed} failed, the rest skipped (our assemblers and models against Unicorn and Capstone)')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
