#!/usr/bin/env python3
# =============================================================================
# tools/virtual_board.py: a Sixfold FPGA board on a pseudo serial port (Linux, macOS, WSL)
#
#   python3 tools/virtual_board.py                       prints the port, e.g. /dev/pts/5, and waits
#       then, in another terminal:  python3 tools/fpga_load.py programs/05_fibonacci.s --port /dev/pts/5
#                             or:  screen /dev/pts/5 115200     (the firmware's prompt; Ctrl-A K quits)
#   python3 tools/virtual_board.py --program fpga/examples/calculator.s --switches 0x0C05 --show
#   python3 tools/virtual_board.py --test programs/05_fibonacci.s [more.s ...]
#       starts a board, runs tools/fpga_load.py against it for each program, exits 0 if all PASS
#
# Behind the port runs tools/fpga_emulator.mjs: the boot firmware and the program on the cycle-exact
# model, with the board's device registers. Everything a real board does over its serial port works the
# same: the banner, h / i / m / r, loading with fpga_load.py, the PASS report with the cycle count.
# Use it to practise before the board arrives, or to check a program and fpga_load.py without hardware.
# --show prints the LEDs and the seven-segment digits whenever a program changes them.
# =============================================================================
import argparse, os, subprocess, sys, tty

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def start_board(program=None, switches=None, show=False):
    master, slave = os.openpty()
    tty.setraw(slave)                       # bytes pass through untouched, as on a real UART
    command = ['node', os.path.join(HERE, 'fpga_emulator.mjs')]
    if program:
        command += ['--program', program]
    if switches:
        command += ['--switches', switches]
    if show:
        command += ['--show']
    board = subprocess.Popen(command, stdin=master, stdout=master, cwd=ROOT)
    os.close(master)                        # the emulator holds it now; we keep the slave side open
    return board, slave, os.ttyname(slave)


def main():
    parser = argparse.ArgumentParser(description='A Sixfold FPGA board on a pseudo serial port')
    parser.add_argument('--program', help='a program in memory from power-on (the centre button or "r" runs it)')
    parser.add_argument('--switches', help='the slide switches, e.g. 0x0C05')
    parser.add_argument('--show', action='store_true', help='print the LEDs and digits when they change')
    parser.add_argument('--test', nargs='+', metavar='PROGRAM', help='load and run these with fpga_load.py, then exit')
    args = parser.parse_args()

    board, slave, port = start_board(args.program, args.switches, args.show)
    try:
        if args.test:
            failed = 0
            for program in args.test:
                print(f'[virtual_board] {program} -> {port}', flush=True)
                result = subprocess.run([sys.executable, os.path.join(HERE, 'fpga_load.py'), program, '--port', port, '--timeout', '120'], cwd=ROOT)
                failed += result.returncode != 0
            print(f'[virtual_board] {len(args.test) - failed} passed, {failed} failed')
            return 1 if failed else 0
        print(f'virtual Sixfold board on {port}  (115200 baud is fine; any rate works here). Ctrl-C stops it.', flush=True)
        print(f'  python3 tools/fpga_load.py programs/05_fibonacci.s --port {port}', flush=True)
        board.wait()
    except KeyboardInterrupt:
        pass
    finally:
        board.terminate()
        os.close(slave)
    return 0


if __name__ == '__main__':
    sys.exit(main())
