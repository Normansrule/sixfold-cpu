# Basys 3 board sheet (for Sixfold)

A one-page summary of the board facts Sixfold depends on, gathered from Digilent's material. This is
**not** the official reference manual. For anything electrical, check the documents under
[Official documents](#official-documents).

The Basys 3 is the board with the most to touch: 16 switches, 16 LEDs, 5 buttons and a four-digit display.
Sixfold uses all of them, so it is the board for trying the computer by hand without a PC
([`fpga/examples/calculator.s`](../../fpga/examples/calculator.s)).

## The board

| | Digilent Basys 3 |
|---|---|
| FPGA | AMD (Xilinx) Artix-7 **XC7A35T-1CPG236C** |
| Logic | 33,280 logic cells: 5,200 slices = 20,800 LUT6 + 41,600 flip-flops |
| Block RAM | 1,800 Kbit (50 x 36 Kbit RAMB36, each splittable into two 18 Kbit halves); 400 Kbit of distributed (LUT) RAM |
| DSP | 90 DSP48E1 slices (25 x 18-bit multipliers) |
| Clock | 100 MHz oscillator on pin **W5**; 5 clock management tiles (MMCM + PLL each) |
| USB | **FTDI FT2232HQ** on the micro-USB port: JTAG programming on one channel, USB serial port on the other |
| User I/O | 16 slide switches, 16 LEDs, 5 push buttons (centre, up, down, left, right), 4-digit seven-segment display |
| Other | 12-bit VGA port, USB host port for a keyboard or mouse, 4 Pmod ports (one shared with the on-chip ADC), Quad-SPI flash for the configuration |
| Power | the micro-USB port, or an external 5 V supply |

## Pins Sixfold uses

From Digilent's `Basys-3-Master.xdc`; copied into
[`fpga/boards/basys3/basys3.xdc`](../../fpga/boards/basys3/basys3.xdc). All pins are LVCMOS33.

| Signal | Pins | Direction | Sixfold |
|---|---|---|---|
| `clk` | W5 | in | MMCM input, 100 MHz to 20 MHz (raise it if timing allows) |
| `sw[0..15]` | V17 V16 W16 W17 W15 V15 W14 W13 V2 T3 T2 R3 W2 U1 T1 R2 | in, up = 1 | `SWITCHES[15:0]` (0x1000_0068) |
| `led[0..15]` | U16 E19 U19 V19 W18 U15 U14 V14 V13 V3 W3 U3 P3 N3 P1 L1 | out, 1 = lit | `LEDS[15:0]` (0x1000_0008) |
| `btnC` `btnU` `btnD` `btnL` `btnR` | U18 T18 U17 W19 T17 | in, pressed = 1 | `BUTTONS` bits 0, 2, 3, 4, 5 (0x1000_0010) |
| `seg[0..6]` (a..g), `dp` | W7 W6 U8 V8 U5 V5 U7, V7 | out, 0 = lit | `DISPLAY` (0x1000_0070), through the seven-segment driver |
| `an[0..3]` | U2 U4 V4 W4 | out, 0 = digit on | digit 0 is the rightmost |
| `RsRx` | B18 | in | UART receive (the PC sends) |
| `RsTx` | A18 | out | UART transmit (the PC receives) |

The four digits share their segment wires. [`fpga/rtl/Seven_Segment_Display.sv`](../../fpga/rtl/Seven_Segment_Display.sv)
turns on one digit's anode at a time, for 1 ms each, and puts that digit's segments on the wires; the eye
sees all four lit. The CPU only writes the `DISPLAY` register.

## Build and program

With AMD Vivado (the free "ML Standard" edition supports the XC7A35T):

```
make fpga-basys3 PROG=calculator          # runs fpga/boards/basys3/build.tcl in batch mode
openFPGALoader -b basys3 build/basys3/sixfold.bit      # or Vivado's Hardware Manager
```

`PROG` picks the program baked into the image next to the firmware (any of `programs/`, `tests/` or
`fpga/examples/`). Check `build/basys3/timing.txt`: the worst negative slack (WNS) must be 0 or positive,
and `build/basys3/utilization.txt` for how full the chip is (see [Will it fit?](#will-it-fit)).

The clock is **20 MHz**, chosen with a margin so the first build works. With positive slack, try 25 MHz:
set `CLOCK_DIVIDE` to 40.0 and `CLOCK_HZ` to 25_000_000 in
[`basys3_top.sv`](../../fpga/boards/basys3/basys3_top.sv) (both together: the UART divides `CLOCK_HZ`).
Cycle counts do not depend on the clock; only the time per cycle does.

To keep Sixfold on the board after power-off, write it to the Quad-SPI flash: in Vivado's Hardware
Manager, add the configuration memory device (the board's flash part, listed in the reference manual),
program it with `sixfold.bit`, and set the board's mode jumper (JP1) to QSPI.

## Before the board arrives

`make fpga-virtual PROG=calculator` starts a virtual Sixfold board on a pseudo serial port: the same firmware
and program on the cycle-exact model, reachable with `tools/fpga_load.py` and `screen` exactly as the real
board is ([FPGA.md](../FPGA.md#5-no-board-yet-a-virtual-one)). The FPGA console on the project's web page is the
same computer, drawn as a Basys 3 with clickable switches and buttons.

## Using it

| You do | Sixfold does |
|---|---|
| power on (or the bitstream finishes loading) | the display shows **`bIOS`**, LEDs 0 and 7 light: the boot firmware is running |
| press **centre** | the firmware runs the program at 0x2000 (the one built in, or the last one loaded) |
| the program finishes | the display shows **`PASS`** or **`FAIL`**; the cycle count goes to the serial port |
| hold **left + right** for half a second | reset: back to the firmware, memory kept (the red PROG button would reload the FPGA and erase it) |
| open the serial port at 115200 baud | the firmware's prompt `sixfold>`; type `h` for its commands |
| `python3 tools/fpga_load.py programs/05_fibonacci.s --port /dev/ttyUSB1` | load and run another program |

The serial port is the **second** of the two ports the FT2232HQ creates: often `/dev/ttyUSB1` on Linux,
the higher-numbered COM port on Windows. From WSL, attach the board with `usbipd` first, or use Windows
Python with the COM port (see [FPGA.md](../FPGA.md#8-bring-up-checklist)).

### The calculator ([`fpga/examples/calculator.s`](../../fpga/examples/calculator.s))

* Switches 15 to 8 are **A**, switches 7 to 0 are **B** (binary, 0 to 255). The display shows them in
  hexadecimal, `0C.05` for A = 12, B = 5, and the LEDs copy the switches.
* **Up** A + B, **down** A - B, **left** A x B, **right** A / B and the remainder. The answer appears on
  the display in decimal (`  17`, `  -7`), on the LEDs in binary, and on the serial port as a sentence
  (`12 x 5 = 60`). An answer that needs five digits (255 x 255 = 65025) shows in hexadecimal with all four
  decimal points lit (`F.E.0.1.`); dividing by zero shows `Err`.
* **Centre** switches to the light painter: **left / right** move a blinking cursor along the LEDs, **up**
  flips the LED under it, **down** clears them all, and the display shows `L` and the cursor position.
  Centre again goes back to the calculator.

All the work is the CPU's: the arithmetic, the decimal digits (one division by 10 each), the segment
patterns (a lookup table), the cursor blinking (the machine timer), and the button debouncing (a press
counts after the contacts have been steady for 10 ms). `make fpga-sim` plays a sequence of switch settings
and button presses into the simulated board and checks the sentences, the LEDs and the digits.

## Will it fit?

The XC7A35T is the smallest chip Sixfold has been built for. Yosys 0.33's `synth_xilinx` estimate for the
whole system (core, caches, block RAM main memory, UART, devices, display driver):

| Resource | Estimate | Of the XC7A35T |
|---|---|---|
| LUTs as logic | 16,071 | of 20,800 |
| LUTs as memory (caches, register file) | 1,904 (420 RAM64M + 56 RAM32M) | of 6,400 that can be memory (400 Kbit) |
| **all LUTs** | **17,975** | **86% of 20,800** |
| flip-flops | 5,465 | 13% of 41,600 |
| block RAM | 32 RAMB36 + 1 RAMB18 (main memory, UART queue) | 65% of 50 RAMB36 |
| DSP48E1 | 4 (the multiplier step) | 4% of 90 |

It fits, with room to spare for Vivado's placer. Yosys counts lookup tables generously; Vivado's own report
(`utilization.txt`) is the real number and is normally lower. Two things keep the design small enough: the
FPGA build's multiplier step uses the DSP slices instead of a tree of about 2,400 lookup tables (without it
the estimate was 97%) (`SIXFOLD_FPGA` in
[`src/Carry_Save_Multiplier.sv`](../../src/Carry_Save_Multiplier.sv); same product, same cycle counts),
and the adders use the carry chains. If Vivado ever reports more than 100%, turn off the tournament
predictor (`TOURNAMENT_PREDICTOR` in `fpga/rtl/Sixfold_System.sv`, about 1,100 lookup tables): programs
then run with the gshare predictor alone, slightly slower in cycles but otherwise the same.

## Official documents

* [Basys 3 Reference Manual](https://digilent.com/reference/programmable-logic/basys-3/reference-manual) and
  [schematic](https://digilent.com/reference/programmable-logic/basys-3/start) (Digilent)
* [Basys-3-Master.xdc](https://github.com/Digilent/digilent-xdc/blob/master/Basys-3-Master.xdc)
* FPGA: AMD [7 Series FPGAs Data Sheet: Overview (DS180)](https://docs.amd.com/v/u/en-US/ds180_7Series_Overview) and
  [Artix-7 Data Sheet: DC and AC Switching Characteristics (DS181)](https://docs.amd.com/v/u/en-US/ds181_Artix_7_Data_Sheet)
* [7 Series Clocking Resources (UG472)](https://docs.amd.com/v/u/en-US/ug472_7Series_Clocking) for the MMCM,
  [7 Series Memory Resources (UG473)](https://docs.amd.com/v/u/en-US/ug473_7Series_Memory_Resources) for block RAM,
  [7 Series DSP48E1 Slice (UG479)](https://docs.amd.com/v/u/en-US/ug479_7Series_DSP48E1) for the multipliers
