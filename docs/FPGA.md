# Sixfold on an FPGA

The same core that `make test` checks cycle by cycle becomes a small computer you can hold in your hand:
the core, its two caches, 64 KiB of block RAM, a serial port, LEDs, switches, buttons and a four-digit
display, and boot firmware that loads programs from your PC. This page covers what is in it, how the CPU
talks to each part, how it boots, and how to build it for three boards.

* Boards: **Digilent Basys 3** (AMD Artix-7 XC7A35T, Vivado: the full set of switches, buttons, LEDs and
  digits), **ULX3S** (Lattice ECP5-85F, fully open-source tools) and **Arty A7-100T** (AMD Artix-7, Vivado).
  Their board sheets: [docs/boards/BASYS3.md](boards/BASYS3.md), [docs/boards/ULX3S.md](boards/ULX3S.md),
  [docs/boards/ARTY_A7.md](boards/ARTY_A7.md).
* Try it with your hands: [`fpga/examples/calculator.s`](../fpga/examples/calculator.s) adds, subtracts,
  multiplies and divides the numbers on the switches when you press a button, shows the answer on the
  display and the LEDs, and has a mode where the buttons paint the LEDs.
* Source: [`fpga/`](../fpga): `rtl/` (the system around the core), `firmware/bios.s` (boot firmware),
  `sim/` (whole-system testbench), `boards/` (pins, clocks, build scripts), `examples/` (programs for a person
  at the board).
* Check it without a board: `make fpga-sim` boots the system in simulation, uploads every program over
  the simulated serial port and checks the cycle counts against the model. For the hands-on examples it
  also flips the switches and presses the buttons (a program's `# FPGA-STEPS:` lines say how) and checks
  what it prints, its LEDs and its digits.

## 1. What is on the chip

![The FPGA computer](img/diagrams/fpga_system.svg)

| Part | File | What it does |
|---|---|---|
| `Riscv64` core | [`src/Riscv64.sv`](../src/Riscv64.sv) | Exactly the simulated core. Its only new input is `RESET_VECTOR`. |
| Instruction and data caches | [`src/Instruction_Cache.sv`](../src/Instruction_Cache.sv), [`src/Data_Cache.sv`](../src/Data_Cache.sv) | Unchanged. On the FPGA their arrays become LUT RAM (they are read in the same cycle). |
| Main memory | [`fpga/rtl/Main_Memory.sv`](../fpga/rtl/Main_Memory.sv) | 64 KiB of block RAM, 256-bit lines, two copies (below). |
| Device registers | [`fpga/rtl/Sixfold_System.sv`](../fpga/rtl/Sixfold_System.sv) | The addresses 0x1000_0000 .. 0x1000_00FF. |
| UART | [`fpga/rtl/Uart.sv`](../fpga/rtl/Uart.sv) | 115200 baud, 8 data bits, no parity, 1 stop bit; 2 KiB transmit queue, 16-byte receive queue. |
| Reset and boot control | `Sixfold_System.sv` | Power-on reset, the reset vector, restarting the core for a program and after it. |
| Boot firmware | [`fpga/firmware/bios.s`](../fpga/firmware/bios.s) | Software at address 0: banner, commands, program loader, report. |
| Seven-segment driver | [`fpga/rtl/Seven_Segment_Display.sv`](../fpga/rtl/Seven_Segment_Display.sv) | Lights the four digits one at a time, 1 ms each, from the `DISPLAY` register (Basys 3). |
| Board top | [`fpga/boards/*/`](../fpga/boards) | Clock (PLL / MMCM), pins, button and switch synchronizers. |

Only two things in `src/` know about the FPGA at all: the core's `RESET_VECTOR` input (the simulator ties
it to 0x2000), and a `SIXFOLD_FPGA` switch in [`Parallel_Prefix_Adder.sv`](../src/Parallel_Prefix_Adder.sv)
and [`Prefix_Negate.sv`](../src/Prefix_Negate.sv). With it, adders are written as plain `+`, which the FPGA
tools put on the chip's dedicated carry chain. That hard-wired ripple beats any prefix tree built from lookup
tables. A chip design goes the other way: there, the prefix tree is the fast choice.

## 2. How the caches connect everything

![Cache interfaces](img/diagrams/cache_interfaces.svg)

The core never sees main memory directly. It has two ports:

* **Instruction port** (FETCH1): `FETCH_ADDRESS` goes out, and `INSTRUCTION` plus `HIT` come back in the
  same cycle. `HIT = 0` holds FETCH1 while the instruction cache fetches the line.
* **Data port** (EXECUTE): `ADDRESS`, `LOAD_REQUEST`, `WRITE_MASK` and `WRITE_DATA` go out, and
  `READ_DATA` plus `HIT` come back. `HIT = 0` on a load raises `DATA_CACHE_STALL`.

Behind the caches, each cache has a **refill port**: a line address out, and 256 bits (a whole 32-byte
line) back. Main memory answers 10 cycles later, so a miss costs 11 cycles. Stores are **write-through**:
each one goes straight to main memory, and also into the cached line if the line is present.

Why block RAM works for main memory: an FPGA's block RAM is *synchronous*, meaning the data for an address
arrives one cycle after the address. The simulated memory answers instantly. The difference never shows,
because a refill holds its line address steady for all 10 cycles before it installs the line. The one
subtlety is a store in the cycle just before the install. Block RAM reads the old contents in the same
cycle it writes, so the memory remembers its last store and merges it into the line it outputs. With that,
the block RAM returns exactly what the simulated memory would, cycle for cycle.

Block RAM has two ports, and main memory needs three (one write and two refill reads), so there are two
copies. Every store writes both, and each cache reads its own.

## 3. How the CPU programs the rest of the computer

![Memory map](img/diagrams/memory_map.svg)

There are no special input/output instructions. A load or store to an address in 0x1000_0000 ..
0x1000_00FF reaches a **device register** instead of memory. This is called memory-mapped I/O, and every
RISC-V system uses it. The data cache still looks the address up, but the system replaces the data with
the device's value, and the store never reaches the RAM.

| Offset | Register | A load returns | A store does |
|---|---|---|---|
| 0x00 | `PUTCHAR` | 0 | sends one character over the UART |
| 0x08 | `LEDS` | the 16 LED bits | sets the LEDs (`sh` sets all 16, `sb` the low 8; boards with 8 LEDs show bits 7:0) |
| 0x10 | `BUTTONS` | the buttons, 1 = pressed: bit 0 centre (FIRE1), 1 FIRE2, 2 up, 3 down, 4 left, 5 right | nothing |
| 0x18 | `UART` | bit 0: a byte arrived, bit 1: transmit queue full, bit 2: transmitter idle, bits 15:8: the byte | drops the received byte |
| 0x20 | `BOOT` | 0 | restarts the core (and clears its caches) at `BOOT_ADDRESS` |
| 0x28 | `CLOCK` | the clock rate in Hz | nothing |
| 0x30 | `LAST_TOHOST` | what the last program wrote to TOHOST | nothing |
| 0x38 | `LAST_CYCLES` | how many cycles the last program ran | nothing |
| 0x40 | `BOOT_REASON` | 0 power-on or reset button, 1 a program finished, 2 a `BOOT` store | nothing |
| 0x48 | `TIMER` | cycles since power-on | nothing |
| 0x50 | `BOOT_ADDRESS` | where `BOOT` starts the core (0x2000 after power-on) | sets it |
| 0x58 | `MTIME` | the machine timer: cycles since power-on | nothing |
| 0x60 | `MTIMECMP` | when the timer interrupt fires | sets it: the timer interrupt line is up while `MTIME >= MTIMECMP` (every program starts with it at "never") |
| 0x68 | `SWITCHES` | the slide switches, 1 = up (16 on the Basys 3, 4 on the ULX3S and the Arty) | nothing |
| 0x70 | `DISPLAY` | the digits as last written | sets the four seven-segment digits: one byte per digit, leftmost in bits 31:24; bit 0 = segment a (top) ... bit 6 = g (middle), bit 7 = the decimal point |

The display shows exactly the segments software asks for, so the CPU does the arithmetic of a number
display itself: divide by 10 for each decimal digit, then look the digit up in a 16-byte table of
segment patterns (`calculator.s` has both). The patterns, with bit 0 = a:

```
   a        0 = 0x3F   1 = 0x06   2 = 0x5B   3 = 0x4F   4 = 0x66   5 = 0x6D   6 = 0x7D   7 = 0x07
 f   b      8 = 0x7F   9 = 0x6F   A = 0x77   b = 0x7C   C = 0x39   d = 0x5E   E = 0x79   F = 0x71
   g        - = 0x40   L = 0x38   r = 0x50   o = 0x5C   P = 0x73   blank = 0x00   + 0x80 = decimal point
 e   c
   d   .
```

Two of these devices can **interrupt** the CPU instead of waiting to be polled: the timer (`MTIME >=
MTIMECMP`) and the UART, whose external interrupt line is up while a received byte is waiting. Software
enables them in `mie` (bit 7 timer, bit 11 external) and turns interrupts on with `mstatus.MIE`; the core
then jumps to `mtvec` between two instructions, with the cause in `mcause`
([ARCHITECTURE.md](ARCHITECTURE.md#interrupts) shows how, cycle by cycle).
[`fpga/examples/interrupt_echo.s`](../fpga/examples/interrupt_echo.s) does all its work in the interrupt
handler: it echoes what you type in upper case and blinks an LED from the timer, while the main program
sleeps in a `wfi` loop. `make fpga-sim` runs it with typed input and checks what it prints.

Reading never changes a device, and only stores have effects. That matters because a load can execute
more than once: it repeats while the data cache fetches the line. So "take the received byte" is a
separate store to `UART`, not a side effect of reading it.

Here is a driver from the firmware. `s0` holds 0x1000_0000:

```asm
putc:                        # send the character in a0
    ld   t0, 0x18(s0)        # UART status
    andi t0, t0, 2           # bit 1: transmit queue full?
    bnez t0, putc            # ... then wait
    sb   a0, 0x00(s0)        # PUTCHAR
    ret

getc:                        # wait for a character, return it in a0
    ld   t0, 0x18(s0)
    andi t1, t0, 1           # bit 0: a byte is waiting
    beqz t1, getc
    srli a0, t0, 8
    andi a0, a0, 255         # bits 15:8: the byte
    sd   zero, 0x18(s0)      # take it out of the receive queue
    ret
```

Two register files are easy to confuse. The **device registers** are memory addresses outside the core.
The **control and status registers** (CSRs: `cycle`, `instret`, the performance counters, `mtvec`, `tohost`
and the rest) are inside the core, in their own 12-bit address space, and only `csrr` / `csrw` reach them.

In simulation, every device load returns 0. Only `PUTCHAR` prints, and the model tracks `LEDS` and
`DISPLAY`; the [web lab](../web/index.html) shows the 16 LEDs. So the same program runs on the model, the RTL and the
board. [`programs/20_leds_and_buttons.s`](../programs/20_leds_and_buttons.s) is the example.

## 4. How it boots

![Boot sequence](img/diagrams/boot_sequence.svg)

A PC's processor starts at a fixed *reset vector* that points into its firmware (BIOS or UEFI). The
firmware sets up the machine, loads the operating system from a disk and jumps to it. Sixfold works the
same way, on a small scale:

1. **Power on.** The board's clock goes through a PLL. Reset is held until the PLL is locked, plus 65,536
   cycles. The reset vector is 0x0000.
2. **Firmware.** The core starts in [`bios.s`](../fpga/firmware/bios.s), which was baked into the block RAM
   when the bitstream was built. It prints a banner (processor, clock rate, memory) and the prompt
   `sixfold>`.
3. **Load.** [`tools/fpga_load.py`](../tools/fpga_load.py) sends `l`, then the address, the length, the
   program bytes and a checksum. The firmware stores each byte to 0x2000 and up. The stores are
   write-through, so the bytes go straight into main memory.
4. **Run.** On `r`, the firmware clears registers x1 to x31 (all but `tp`, which holds the device address)
   and stores to `BOOT`. The system resets the core and both caches and starts it at `BOOT_ADDRESS`
   (0x2000). This is the state a simulation starts from: cold caches, fresh counters and predictors, and
   zeroed registers.
5. **Finish.** The program writes TOHOST, and the core halts. The system waits until the transmit queue has
   sent everything, records `LAST_TOHOST` and `LAST_CYCLES`, and restarts the core at 0x0000 with
   `BOOT_REASON = 1`. The firmware then prints `program finished: PASS in N cycles`.

**N is the model's cycle count, exactly.** [`tools/fpga_sim.mjs`](../tools/fpga_sim.mjs) (`make fpga-sim`)
runs this whole sequence in simulation for every program: it boots, uploads over the simulated UART, runs,
and reads the report. It then checks the result, the printed output and the cycle count against
`model/core.js`. The single exception is `20_leds_and_buttons`, which waits on the real clock rate on
purpose.

Memory layout: firmware code and text at 0x0000 .. 0x0FFF (about 2 KiB used), the firmware stack at
0x1000 .. 0x1FFF, and programs at 0x2000 .. 0xFFFF. The reset button restarts the firmware without
erasing memory, so `r` runs the last loaded program again.

## 5. No board yet? A virtual one

[`tools/virtual_board.py`](../tools/virtual_board.py) runs the whole computer on your PC behind a pseudo
serial port: the same firmware on the cycle-exact model, with the same device registers (the emulation in
[`web/fpga_system.js`](../web/fpga_system.js), shared with the site's console). Everything you would do with
a board over its serial port works the same way:

```
pip install pyserial
make fpga-virtual PROG=calculator              # prints its port, e.g. /dev/pts/3, and the LEDs and digits
python3 tools/fpga_load.py programs/09_primes_sieve.s --port /dev/pts/3     # in a second terminal
screen /dev/pts/3 115200                       # or the firmware's prompt directly (Ctrl-A K quits)
make fpga-load-test                            # loads four programs with fpga_load.py and checks PASS
```

With `PROG=calculator`, type `r` at the prompt, then `u d l r c` act as the buttons (set the switches with
`python3 tools/virtual_board.py --program fpga/examples/calculator.s --switches 0x0C05 --show`). The cycle
counts it reports are the model's, so they equal the board's.

## 6. Build it

### ULX3S (open-source tools)

```
sudo apt install yosys nextpnr-ecp5 fpga-trellis openfpgaloader
make fpga-ulx3s                             # PROG=... picks the program baked in next to the firmware
openFPGALoader -b ulx3s build/ulx3s/sixfold.bit
screen /dev/ttyUSB0 115200                  # press PWR: the banner; type h for help
python3 tools/fpga_load.py programs/09_primes_sieve.s --port /dev/ttyUSB0
```

The build script ([`fpga/boards/ulx3s/build.sh`](../fpga/boards/ulx3s/build.sh)) runs these steps:
`ecppll` makes the PLL, `sv2v` converts to Verilog with `SIXFOLD_FPGA`, `yosys synth_ecp5` maps the
design onto lookup tables, carry chains and block RAM, `nextpnr-ecp5` places, routes and checks timing,
and `ecppack` writes the bitstream. `CLOCK_MHZ=24 make fpga-ulx3s` picks another clock rate (20 MHz is the
default, with a margin; `SEED=2` tries another placement).

### Basys 3 (Vivado)

```
make fpga-basys3 PROG=calculator            # vivado -mode batch -source fpga/boards/basys3/build.tcl
openFPGALoader -b basys3 build/basys3/sixfold.bit      # or Vivado's Hardware Manager
```

The display shows `bIOS`: press the centre button to run the calculator built into the image, or open the
serial port (115200 baud) for the firmware's prompt and load any program with `tools/fpga_load.py`.
[docs/boards/BASYS3.md](boards/BASYS3.md) has the pins, the controls, and how to keep the design in flash.

### Arty A7-100T (Vivado)

```
make fpga-arty                              # vivado -mode batch -source fpga/boards/arty_a7/build.tcl
openFPGALoader -b arty_a7_100t build/arty_a7/sixfold.bit
python3 tools/fpga_load.py programs/05_fibonacci.s --port /dev/ttyUSB1
```

## 7. Results

| | ULX3S: ECP5 LFE5U-85F, speed grade 6 | Basys 3: Artix-7 XC7A35T-1 | Arty A7-100T: Artix-7 XC7A100T-1 |
|---|---|---|---|
| tools | Yosys 0.33 + nextpnr-ecp5 0.6 (placed, routed, timed) | Yosys `synth_xilinx` estimate (Vivado reports its own) | the same netlist as the Basys 3 |
| logic | 33,886 LUT4 (41%) | about 17,975 LUT6 (86%): 16,071 logic + 1,904 memory | about 17,975 LUT6 (28%) |
| flip-flops | 5,546 (7%) | 5,465 (13%) | 5,465 (4%) |
| LUT RAM | 705 RAM slices (caches, register file) | 420 RAM64M + 56 RAM32M | the same |
| block RAM | 85 of 208 DP16KD (40%) | 32 RAMB36 + 1 RAMB18 (65%) | the same (24%) |
| multipliers | 4 MULT18X18D (the multiply step) | 4 DSP48E1 | the same |
| clock | **20 MHz**; nextpnr: maximum 25.0 MHz | **20 MHz** (a margin; raise it if Vivado's slack allows) | 25 MHz (raise or lower it by Vivado's slack) |
| a program's speed | 09_primes_sieve: 16,899 cycles = 0.84 ms | the same cycles, at its clock | the same cycles, at its clock |

The bitstream is about 1 MB (`build/ulx3s/sixfold.bit`), and the whole build takes about 8 minutes.

Where the logic goes: the core's 64-bit datapath, the two caches (4 KiB of data each, stored in LUT RAM
because a cache hit must answer in the same cycle), and the register file (LUT RAM, three read ports).
Main memory uses block RAM.

An FPGA clock is far below a chip's. The same core reaches about 244 MHz on a 130 nm chip and about 1.95 GHz
on a 7 nm chip ([PERFORMANCE.md](PERFORMANCE.md)), because an FPGA builds every gate from programmable
lookup tables and routes every wire through programmable switches.

What sets the FPGA's clock is not in the chip numbers at all: the **data cache**. On a chip, the cache
arrays are SRAM macros and are timed on their own. On the FPGA, they are lookup-table RAM in the fabric,
and one EXECUTE cycle does all of the following: adds the address (on the carry chain), reads both tags,
compares them, and, for a store, turns the result into the write enables of the line. That path is about
40 ns, which is where 20 to 25 MHz comes from. Soft processors built for FPGAs usually reach 50 to 150 MHz,
because they register the address first and check the tag in the next stage. That is the classic
pipelined cache, and it costs one more cycle of load latency (Lab 20 in
[EXPERIMENTS.md](EXPERIMENTS.md)). Sixfold keeps the same-cycle cache, so the FPGA runs exactly the cycles
the model counts.

The first build ran at 16.8 MHz. Three changes brought it to 25 MHz, and each is in the source with a
comment:

* **Carry chains instead of prefix trees.** On a chip, Kogge-Stone adders are the fast choice. On an
  FPGA, the dedicated carry chain is faster than any tree built from lookup tables, so `SIXFOLD_FPGA`
  turns the adders into plain `+`.
* **Stores should not read the cache line.** The data cache used to merge a store into a copy of its line
  (read, modify, write). It now writes only the store's bytes, through per-byte write enables, which
  takes a 256-bit read and multiplexer out of the store's path. With these two changes the build
  reached 18.1 MHz.
* **Resource sharing can wreck timing.** Yosys's `share` pass had merged the ALU's adder with the branch
  comparator's subtractor behind a multiplexer, so the branch decision fed the load address. Without
  `share`, the build reached 26.4 MHz and used 30% fewer lookup tables. The chip flow found the same
  problem in the third round.

Then the Basys 3 asked for less. Its XC7A35T is a quarter of the Arty's chip, and the first estimate filled
97% of its lookup tables. The largest block that did not need them was the multiplier step's Wallace tree
(about 2,400 lookup tables): every FPGA has hard multipliers. With `SIXFOLD_FPGA`, the step is written as
`accumulator + multiplicand x 16 bits`, which synthesis maps onto 4 DSP slices (4 MULT18X18D on the ECP5),
giving the same product with a zero carry vector, so every cycle count stays the same (`make fpga-sim`
checks it). The Basys 3 estimate fell to 86%, and the ULX3S build from 44% to 41% of its LUT4s. The ULX3S's
maximum clock moved from 26.6 MHz to between 24 and 25 MHz: the slowest path is still the data cache, and
placements vary by a few MHz from run to run. So its default clock is now 20 MHz, with a 25% margin.

## 8. Bring-up checklist

1. **Nothing on the serial port.** Check the baud rate (115200). On the Arty and the Basys 3, try the
   *second* serial port of the FT2232HQ. Press reset (ULX3S: PWR; Arty: the red RESET; Basys 3: hold
   left and right together for half a second) for the banner.
2. **Garbage characters.** The UART divisor comes from `CLOCK_HZ`, which must match the PLL output.
   `build.sh` generates both from `CLOCK_MHZ`. On the Arty, change `CLOCK_HZ` whenever you change
   `CLOCK_DIVIDE`.
3. **`checksum error`.** A byte was lost. Use a shorter USB cable, or check that no terminal program has
   the port open at the same time as `fpga_load.py`.
4. **Windows with WSL.** A USB device is not visible inside WSL until you attach it (`usbipd attach
   --wsl --busid <id>`, from the usbipd-win project). Alternatively, run `openFPGALoader` and
   `fpga_load.py` with Windows Python, using the COM port that Device Manager shows.
5. **Timing fails** (the nextpnr log says `FAIL at N MHz`, or Vivado's WNS is negative). Lower the clock.
6. **A program never finishes.** It may be waiting on a button or looping forever. Press reset: the
   firmware comes back, and memory keeps the program.
7. **The display is dark or shows garbage.** Only the Basys 3 has digits. They show `bIOS` from power-on;
   if they stay dark, the bitstream is not running (is the DONE LED on?). A digit that shows the wrong
   segments is the program's table, not the hardware: bit 0 is segment a.
