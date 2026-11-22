`default_nettype none

import const_pkg::*;

// =====================================================================================================
// SixfoldSystem: the whole computer for an FPGA board.
//
//            +-------------------------------------------------------------------------------+
//   UART RX -+-> receive queue --+                                                           |
//            |                   |   device registers (memory-mapped I/O at 0x1000_0000)     |
//   UART TX <+-- transmit queue <+-- PUTCHAR LEDS BUTTONS UART BOOT CLOCK LAST_* TIMER       |
//   LEDs    <+-------------------+        ^ loads and stores to 0x1000_00xx                  |
//   buttons -+-------------------+        |   (+ SWITCHES and DISPLAY: 7-segment digits)     |
//   switches-+-------------------+        |                                                  |
//            |   Riscv64 core --> instruction cache --> refill --+                           |
//            |                --> data cache ---------> refill --+--> MainMemory (block RAM) |
//            |                --> stores (write-through) --------+    64 KiB: firmware at 0,  |
//            |                                                        programs at 0x2000     |
//            +-------------------------------------------------------------------------------+
//
// The CPU "programs" every other part of the computer through ordinary loads and stores: an address in
// 0x1000_0000 .. 0x1000_00FF does not go to memory but to a device register (see docs/FPGA.md):
//
//   offset  name          load returns                                store does
//   0x00    PUTCHAR       0                                           send one character to the PC
//   0x08    LEDS          the LEDs                                    set the LEDs (16; byte stores set 8)
//   0x10    BUTTONS       the buttons: bit 0 centre / FIRE1, 1 FIRE2, 2 up, 3 down, 4 left, 5 right
//   0x18    UART          bit0 = a byte arrived, bit1 = transmit queue full,
//                         bit2 = transmitter idle, bits 15:8 = that byte    drop the received byte
//   0x20    BOOT          0                                           restart the core at BOOT_ADDRESS
//   0x28    CLOCK         clock frequency in Hz                       -
//   0x30    LAST_TOHOST   what the last program wrote to TOHOST       -
//   0x38    LAST_CYCLES   how many cycles the last program ran        -
//   0x40    BOOT_REASON   0 = power on / reset button, 1 = a program finished, 2 = BOOT store
//   0x48    TIMER         cycles since power on (for delays)          -
//   0x50    BOOT_ADDRESS  where BOOT starts the core (0x2000)         set it
//   0x58    MTIME         the machine timer (= TIMER)                 -
//   0x60    MTIMECMP      the timer interrupt time                    set it: interrupt when MTIME >= MTIMECMP
//   0x68    SWITCHES      the slide switches (16 on the Basys 3)      -
//   0x70    DISPLAY       the seven-segment digits                    set them: one byte of segments per digit
//                         (fpga/rtl/Seven_Segment_Display.sv shows the bit order)
//
// Interrupt lines into the core: the timer (MTIME >= MTIMECMP) and the external one (a byte is waiting in
// the UART's receive queue), both enabled by software through mie and mstatus.MIE.
//
// Boot sequence (like a PC: reset vector -> BIOS -> load the program -> run it -> back to the BIOS):
//   1. Power on or reset button: the core starts at RESET_VECTOR = 0x0000, the boot firmware
//      (fpga/firmware/bios.s, baked into the block RAM image).
//   2. The firmware prints a banner and waits for commands on the UART: "l" loads a program the PC sends
//      (tools/fpga_load.py), "r" runs it, "i" prints information, "m" tests the memory.
//   3. "r" clears the registers and stores to BOOT: this system resets the core AND the caches and
//      starts it at BOOT_ADDRESS (0x2000). A fresh core, cold caches, zeroed registers (all but tp, which
//      held the device address for that last store): exactly the state a simulation starts from.
//   4. The program runs exactly as in simulation (same core, same caches, same cycle counts).
//   5. When it writes TOHOST the core halts; once the transmit queue has drained, this system restarts
//      the core at 0x0000 with BOOT_REASON = 1, and the firmware reports PASS/FAIL and the cycle count.
// =====================================================================================================
module SixfoldSystem #(
    parameter int CLOCK_HZ = 25_000_000,
    parameter int BAUD = 115_200,
    parameter string MEMORY_IMAGE = "memory.hex", // firmware + demo program (tools/fpga_image.mjs)
    parameter int MISS_LATENCY = 10,
    parameter int CACHE_SETS = 64, // sets per way in each cache (64: 4 KiB each)
    parameter logic [63:0] FIRMWARE_ENTRY = 64'h0
) (
    input  logic clk,
    input  logic reset,               // synchronous, active high (the board top synchronizes the button)
    input  logic UART_RX,
    output logic UART_TX,
    input  logic [7:0] BUTTONS,       // already synchronized, active high
    input  logic [15:0] SWITCHES,     // already synchronized, 1 = up / on
    output logic [15:0] LEDS,
    output logic [31:0] DISPLAY,      // the seven-segment digits (SevenSegmentDisplay drives the pins)
    output logic CORE_HALTED,
    output logic RUNNING_PROGRAM      // 1 while a program (not the firmware) runs
);

    localparam int CLOCKS_PER_BIT = CLOCK_HZ / BAUD;

    // ------------------------------------------------------------------ the core and its caches
    logic [63:0] TIMER, MACHINE_TIME_COMPARE; // cycles since power on (MTIME), and MTIMECMP
    logic TX_QUEUE_EMPTY, TX_QUEUE_FULL, TX_BUSY, TX_POPPED, TX_SEND;
    logic RX_RECEIVED, RX_QUEUE_EMPTY, RX_QUEUE_FULL, RX_POP;
    logic CORE_RESET;
    logic [63:0] RESET_VECTOR;
    logic [63:0] dcache_addr, dcache_din, dcache_dout, icache_addr, CACHE_DATA, TOHOST;
    logic [7:0] dcache_we;
    logic [31:0] icache_dout;
    logic icache_hit, dcache_re, dcache_hit, HALTED;
    logic ICACHE_INVALIDATE; // FENCE.I: the instruction cache takes its reset at this edge
    logic [63:0] INSTRUCTION_REFILL_ADDRESS, DATA_REFILL_ADDRESS;
    logic [255:0] INSTRUCTION_REFILL_LINE, DATA_REFILL_LINE;

    /* verilator lint_off PINCONNECTEMPTY */
    // SRAM_CACHES stays 0 here (flip-flop caches): these wires are connected as in src/Riscv64_top.sv and unused
    logic        icache_capture, dcache_capture;
    logic [31:0] icache_dout_late;
    logic [63:0] dcache_dout_late;
    Riscv64 #(
        .GSHARE_HISTORY_BITS (6), .BTB_ENABLE (1'b1), .RAS_ENABLE (1'b1), .PRECISE_LOAD_STALL (1'b1),
        .ITERATIVE_MULTIPLY_DIVIDE (1'b1), .TOURNAMENT_PREDICTOR (1'b1), .ZIFENCEI (1'b1), .XCOMPUTE (1'b1)
    ) core (
        .clk (clk), .reset (CORE_RESET), .BRANCH_PREDICTION_ENABLE (1'b1), .RESET_VECTOR (RESET_VECTOR),
        .TIMER_INTERRUPT_LINE (TIMER >= MACHINE_TIME_COMPARE), .EXTERNAL_INTERRUPT_LINE (!RX_QUEUE_EMPTY),
        .dcache_addr (dcache_addr), .icache_addr (icache_addr), .dcache_we (dcache_we), .dcache_din (dcache_din),
        .dcache_dout (dcache_dout), .icache_dout (icache_dout), .icache_hit (icache_hit), .icache_invalidate (ICACHE_INVALIDATE), .dcache_re (dcache_re),
        .icache_capture (icache_capture), .dcache_capture (dcache_capture), .icache_dout_late (icache_dout_late), .dcache_dout_late (dcache_dout_late),
        .dcache_hit (dcache_hit), .csr (TOHOST), .HALTED (HALTED),
        .DEBUG_REGISTER_ADDRESS (5'd0), .DEBUG_REGISTER_DATA (),
        .TRACE_VALID (), .TRACE_FETCH1_PC (), .TRACE_FETCH2_PC (), .TRACE_DECODE_PC (), .TRACE_EXECUTE_PC (),
        .TRACE_MEMORY_PC (), .TRACE_WRITEBACK_PC (), .TRACE_LOAD_STALL (), .TRACE_FLUSH (), .TRACE_REDIRECT (),
        .TRACE_MULTIPLY_DIVIDE_STALL (), .TRACE_INSTRUCTION_MISS (), .TRACE_DATA_MISS ()
    );
    /* verilator lint_on PINCONNECTEMPTY */
    assign CORE_HALTED = HALTED;

    InstructionCache #(.MISS_LATENCY (MISS_LATENCY), .SETS (CACHE_SETS)) instruction_cache (
        .clk (clk), .reset (CORE_RESET || ICACHE_INVALIDATE), .FREEZE (HALTED),
        .FETCH_ADDRESS (icache_addr), .INSTRUCTION (icache_dout), .HIT (icache_hit),
        .REFILL_ADDRESS (INSTRUCTION_REFILL_ADDRESS), .REFILL_LINE (INSTRUCTION_REFILL_LINE),
        .CAPTURE (icache_capture), .INSTRUCTION_LATE (icache_dout_late)
    );
    DataCache #(.MISS_LATENCY (MISS_LATENCY), .SETS (CACHE_SETS)) data_cache (
        .clk (clk), .reset (CORE_RESET), .FREEZE (HALTED),
        .LOAD_REQUEST (dcache_re), .ADDRESS (dcache_addr), .WRITE_MASK (dcache_we), .WRITE_DATA (dcache_din),
        .READ_DATA (CACHE_DATA), .HIT (dcache_hit),
        .REFILL_ADDRESS (DATA_REFILL_ADDRESS), .REFILL_LINE (DATA_REFILL_LINE),
        .CAPTURE (dcache_capture), .READ_DATA_LATE (dcache_dout_late)
    );

    // ------------------------------------------------------------------ memory-mapped devices
    logic IS_DEVICE;                  // the address in EXECUTE is a device register
    logic [4:0] DEVICE_REGISTER;      // which one (the address in doublewords)
    logic DEVICE_STORE;
    assign IS_DEVICE = (dcache_addr[63:8] == MMIO_BASE[63:8]);
    assign DEVICE_REGISTER = dcache_addr[7:3];
    assign DEVICE_STORE = IS_DEVICE && (|dcache_we) && !HALTED;

    MainMemory #(.INIT_FILE (MEMORY_IMAGE)) main_memory (
        .clk (clk),
        .WRITE_ADDRESS (dcache_addr[15:0]), .WRITE_MASK ((IS_DEVICE || HALTED) ? 8'd0 : dcache_we), .WRITE_DATA (dcache_din),
        .INSTRUCTION_REFILL_ADDRESS (INSTRUCTION_REFILL_ADDRESS[15:0]), .INSTRUCTION_REFILL_LINE (INSTRUCTION_REFILL_LINE),
        .DATA_REFILL_ADDRESS (DATA_REFILL_ADDRESS[15:0]), .DATA_REFILL_LINE (DATA_REFILL_LINE)
    );

    // UART with a 2 KiB transmit queue (programs print faster than 115200 baud can carry) and a
    // 16-byte receive queue (the firmware empties it far faster than bytes arrive)
    logic [7:0] TX_QUEUE_BYTE;
    logic [7:0] RX_BYTE, RX_QUEUE_BYTE;
    ByteFifo #(.DEPTH (2048), .SYNCHRONOUS_READ (1'b1)) transmit_queue (
        .clk (clk), .reset (reset),
        .WRITE (DEVICE_STORE && (DEVICE_REGISTER == 5'd0)), .DATA_IN (dcache_din[7:0]),
        .READ (TX_POPPED), .DATA_OUT (TX_QUEUE_BYTE), .EMPTY (TX_QUEUE_EMPTY), .FULL (TX_QUEUE_FULL)
    );
    // pop when the transmitter is free, send the byte the next cycle (block RAM read latency)
    assign TX_POPPED = !TX_QUEUE_EMPTY && !TX_BUSY && !TX_SEND;
    always_ff @(posedge clk) TX_SEND <= reset ? 1'b0 : TX_POPPED;
    UartTransmitter #(.CLOCKS_PER_BIT (CLOCKS_PER_BIT)) transmitter (
        .clk (clk), .reset (reset), .SEND (TX_SEND), .BYTE (TX_QUEUE_BYTE), .BUSY (TX_BUSY), .TX (UART_TX)
    );
    UartReceiver #(.CLOCKS_PER_BIT (CLOCKS_PER_BIT)) receiver (
        .clk (clk), .reset (reset), .RX (UART_RX), .RECEIVED (RX_RECEIVED), .BYTE (RX_BYTE)
    );
    ByteFifo #(.DEPTH (16), .SYNCHRONOUS_READ (1'b0)) receive_queue (
        .clk (clk), .reset (reset),
        .WRITE (RX_RECEIVED), .DATA_IN (RX_BYTE),
        .READ (RX_POP), .DATA_OUT (RX_QUEUE_BYTE), .EMPTY (RX_QUEUE_EMPTY), .FULL (RX_QUEUE_FULL)
    );
    assign RX_POP = DEVICE_STORE && (DEVICE_REGISTER == 5'd3);

    // Registers
    logic [15:0] LED_REGISTER;
    logic [31:0] DISPLAY_REGISTER;
    logic [63:0] LAST_TOHOST, LAST_CYCLES, PROGRAM_CYCLES, BOOT_ADDRESS;
    logic [1:0] BOOT_REASON;
    assign LEDS = LED_REGISTER;
    assign DISPLAY = DISPLAY_REGISTER;

    // Loads: a device register instead of the cache's data
    logic [63:0] DEVICE_DATA;
    always_comb begin
        unique case (DEVICE_REGISTER)
            5'd1: DEVICE_DATA = {48'd0, LED_REGISTER};
            5'd2: DEVICE_DATA = {56'd0, BUTTONS};
            5'd3: DEVICE_DATA = {48'd0, RX_QUEUE_BYTE, 5'd0, !TX_BUSY && TX_QUEUE_EMPTY && !TX_SEND, TX_QUEUE_FULL, !RX_QUEUE_EMPTY};
            5'd5: DEVICE_DATA = 64'(CLOCK_HZ);
            5'd6: DEVICE_DATA = LAST_TOHOST;
            5'd7: DEVICE_DATA = LAST_CYCLES;
            5'd8: DEVICE_DATA = {62'd0, BOOT_REASON};
            5'd9: DEVICE_DATA = TIMER;
            5'd10: DEVICE_DATA = BOOT_ADDRESS;
            5'd11: DEVICE_DATA = TIMER; // MTIME
            5'd12: DEVICE_DATA = MACHINE_TIME_COMPARE;
            5'd13: DEVICE_DATA = {48'd0, SWITCHES};
            5'd14: DEVICE_DATA = {32'd0, DISPLAY_REGISTER};
            default: DEVICE_DATA = 64'd0;
        endcase
    end
    assign dcache_dout = IS_DEVICE ? DEVICE_DATA : CACHE_DATA;

    // ------------------------------------------------------------------ reset and boot control
    typedef enum logic [1:0] { RUN, DRAIN, RESTART } boot_state_t;
    boot_state_t BOOT_STATE;
    logic BOOT_STORE;
    assign BOOT_STORE = DEVICE_STORE && (DEVICE_REGISTER == 5'd4);
    always_ff @(posedge clk) begin
        if (reset) begin
            CORE_RESET <= 1'b1;
            RESET_VECTOR <= FIRMWARE_ENTRY;
            BOOT_STATE <= RESTART;
            BOOT_REASON <= 2'd0;
            RUNNING_PROGRAM <= 1'b0;
            LED_REGISTER <= 16'd0;
            DISPLAY_REGISTER <= 32'd0;
            LAST_TOHOST <= 64'd0;
            LAST_CYCLES <= 64'd0;
            PROGRAM_CYCLES <= 64'd0;
            TIMER <= 64'd0;
            BOOT_ADDRESS <= PC_RESET;
            MACHINE_TIME_COMPARE <= 64'hFFFF_FFFF_FFFF_FFFF;
        end else begin
            TIMER <= TIMER + 64'd1;
            // LEDS and DISPLAY take only the bytes the store writes (sb sets 8 LEDs or one digit)
            if (DEVICE_STORE && (DEVICE_REGISTER == 5'd1))
                for (int BYTE_LANE = 0; BYTE_LANE < 2; BYTE_LANE = BYTE_LANE + 1)
                    if (dcache_we[BYTE_LANE]) LED_REGISTER[8*BYTE_LANE +: 8] <= dcache_din[8*BYTE_LANE +: 8];
            if (DEVICE_STORE && (DEVICE_REGISTER == 5'd14))
                for (int BYTE_LANE = 0; BYTE_LANE < 4; BYTE_LANE = BYTE_LANE + 1)
                    if (dcache_we[BYTE_LANE]) DISPLAY_REGISTER[8*BYTE_LANE +: 8] <= dcache_din[8*BYTE_LANE +: 8];
            if (DEVICE_STORE && (DEVICE_REGISTER == 5'd10)) BOOT_ADDRESS <= dcache_din;
            if (CORE_RESET) MACHINE_TIME_COMPARE <= 64'hFFFF_FFFF_FFFF_FFFF; // every program starts with no timer set
            else if (DEVICE_STORE && (DEVICE_REGISTER == 5'd12))
                for (int BYTE_LANE = 0; BYTE_LANE < 8; BYTE_LANE = BYTE_LANE + 1)
                    if (dcache_we[BYTE_LANE]) MACHINE_TIME_COMPARE[8*BYTE_LANE +: 8] <= dcache_din[8*BYTE_LANE +: 8];
            unique case (BOOT_STATE)
                RUN: begin
                    CORE_RESET <= 1'b0;
                    if (!HALTED && !CORE_RESET) PROGRAM_CYCLES <= PROGRAM_CYCLES + 64'd1; // the same count as the simulator's "cycles"
                    if (BOOT_STORE) begin                 // the firmware starts a program
                        RESET_VECTOR <= BOOT_ADDRESS;
                        BOOT_REASON <= 2'd2;
                        RUNNING_PROGRAM <= (BOOT_ADDRESS != FIRMWARE_ENTRY);
                        CORE_RESET <= 1'b1;
                        BOOT_STATE <= RESTART;
                    end else if (HALTED) begin            // a program finished: let its output drain first
                        BOOT_STATE <= DRAIN;
                    end
                end
                DRAIN: if (TX_QUEUE_EMPTY && !TX_BUSY && !TX_SEND) begin
                    LAST_TOHOST <= TOHOST;
                    LAST_CYCLES <= PROGRAM_CYCLES;
                    RESET_VECTOR <= FIRMWARE_ENTRY;
                    BOOT_REASON <= 2'd1;
                    RUNNING_PROGRAM <= 1'b0;
                    CORE_RESET <= 1'b1;
                    BOOT_STATE <= RESTART;
                end
                RESTART: begin                            // one cycle of core + cache reset
                    PROGRAM_CYCLES <= 64'd0;
                    BOOT_STATE <= RUN;
                end
                default: BOOT_STATE <= RUN;
            endcase
        end
    end

    /* verilator lint_off UNUSEDSIGNAL */
    logic UNUSED;
    assign UNUSED = ^{icache_addr[63:0], INSTRUCTION_REFILL_ADDRESS[63:16], DATA_REFILL_ADDRESS[63:16], RX_QUEUE_FULL, dcache_din[63:32]};
    /* verilator lint_on UNUSEDSIGNAL */

endmodule

`default_nettype wire
