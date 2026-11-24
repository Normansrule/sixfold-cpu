`default_nettype none

import const_pkg::*;
import opcode_pkg::*;

module CSRFile #(
    parameter bit EXCEPTIONS = 1'b0 // mtval exists and mstatus.MPP reads 3 (machine mode, the only mode): see src/Riscv64.sv
) (
    input logic clk,
    input logic reset,
    input logic CSR_WRITE_ENABLE,
    input logic [11:0] CSR_ADDRESS,
    input logic [2:0] CSR_OPERATION, // funct3: CSRRW(I) write, CSRRS(I) set bits, CSRRC(I) clear bits
    input logic [63:0] CSR_WRITE_DATA, // rs1 value or the 5-bit zero extended immediate
    input logic INSTRUCTION_RETIRED, // An instruction finished in Writeback this cycle (counts instret)
    input logic [7:0] PERFORMANCE_EVENTS, // {late kill, interrupt, D miss, I miss, M busy, redirect, flush, load stall}: the TRACE_* signals of this cycle
    input logic TAKE_TRAP, // ecall / ebreak / an interrupt in Execute: record the trap
    input logic [63:0] TRAP_PC, // ... the address of that instruction (for an interrupt: the one it replaced)
    input logic [63:0] TRAP_CAUSE, // ... and why (11, 3, or bit 63 + 7 / 11 for interrupts; EXCEPTIONS adds 0, 2, 4 and 6)
    input logic [63:0] TRAP_VALUE, // ... and for EXCEPTIONS = 1 the bad address or instruction word (0 for the others): mtval
    input logic TIMER_INTERRUPT_LINE, // mtime >= mtimecmp (from the timer device)
    input logic EXTERNAL_INTERRUPT_LINE, // a device wants attention (the FPGA's UART receiver; 0 in simulation)
    output logic INTERRUPT_REQUEST, // mstatus.MIE and an enabled interrupt is pending (all registered)
    output logic INTERRUPT_IS_EXTERNAL, // ... and it is the external one (it has priority over the timer)
    input logic RETURN_FROM_TRAP, // mret in Execute
    output logic [63:0] TRAP_VECTOR, // mtvec base: where traps go
    output logic [63:0] EXCEPTION_PC, // mepc: where mret goes
    output logic [63:0] CSR_READ_DATA,
    output logic [63:0] TOHOST
);

    logic [63:0] CSR_TOHOST_REGISTER;
    logic [63:0] CSR_STATUS_REGISTER;
    logic [63:0] CSR_MSTATUS_REGISTER, CSR_MTVEC_REGISTER, CSR_MSCRATCH_REGISTER, CSR_MEPC_REGISTER, CSR_MCAUSE_REGISTER;
    logic [63:0] CSR_MTVAL_REGISTER; // EXCEPTIONS = 1 only (otherwise mtval reads 0 like every CSR Sixfold does not have)
    logic [63:0] CSR_MIE_REGISTER; // interrupt enables (bit 7 timer, bit 11 external)
    logic MIP_MTIP, MIP_MEIP; // the interrupt lines, captured once per cycle (mip bits 7 and 11)
    logic [63:0] CSR_CYCLE_COUNTER; // Counts every clock cycle since reset (read with rdcycle)
    logic [63:0] CSR_INSTRET_COUNTER; // Counts every retired instruction since reset (read with rdinstret)
    // Split counters: each 64-bit counter is two 32-bit halves. The low half's carry is REGISTERED and added
    // to the high half one cycle later, so no 64-bit carry chain sits between two flip-flops. (The high half
    // lags by one cycle once every 2^32 counts, which is harmless for performance counters.)
    logic CYCLE_CARRY_PENDING, INSTRET_CARRY_PENDING;
    logic [63:0] CSR_NEW_VALUE; // Value after applying the read-modify-write operation

    // Performance counters hpmcounter3..8: the cycle equation, counted by the hardware itself
    logic [63:0] EVENT_COUNT [0:7];
    genvar EVENT;
    generate
        for (EVENT = 0; EVENT < 8; EVENT = EVENT + 1) begin : performance_counter
            EventCounter counter (.clk (clk), .reset (reset), .INCREMENT (PERFORMANCE_EVENTS[EVENT]), .COUNT (EVENT_COUNT[EVENT]));
        end
    endgenerate

    logic [31:0] CYCLE_LOW_NEXT, CYCLE_HIGH_NEXT, INSTRET_LOW_NEXT, INSTRET_HIGH_NEXT;
    logic CYCLE_LOW_CARRY, CYCLE_HIGH_CARRY_UNUSED, INSTRET_LOW_CARRY, INSTRET_HIGH_CARRY_UNUSED;
    ParallelPrefixAdder #(.WIDTH(32)) cycle_low_incrementer (.A (CSR_CYCLE_COUNTER[31:0]), .B (32'd0), .CARRY_IN (1'b1), .SUM (CYCLE_LOW_NEXT), .CARRY_OUT (CYCLE_LOW_CARRY));
    ParallelPrefixAdder #(.WIDTH(32)) cycle_high_incrementer (.A (CSR_CYCLE_COUNTER[63:32]), .B (32'd0), .CARRY_IN (CYCLE_CARRY_PENDING), .SUM (CYCLE_HIGH_NEXT), .CARRY_OUT (CYCLE_HIGH_CARRY_UNUSED));
    ParallelPrefixAdder #(.WIDTH(32)) instret_low_incrementer (.A (CSR_INSTRET_COUNTER[31:0]), .B (32'd0), .CARRY_IN (1'b1), .SUM (INSTRET_LOW_NEXT), .CARRY_OUT (INSTRET_LOW_CARRY));
    ParallelPrefixAdder #(.WIDTH(32)) instret_high_incrementer (.A (CSR_INSTRET_COUNTER[63:32]), .B (32'd0), .CARRY_IN (INSTRET_CARRY_PENDING), .SUM (INSTRET_HIGH_NEXT), .CARRY_OUT (INSTRET_HIGH_CARRY_UNUSED));

    // Read-Modify-Write: CSRRW replaces, CSRRS sets the 1 bits, CSRRC clears the 1 bits
    always_comb begin
        unique case (CSR_OPERATION)
            FNC_RS, FNC_RSI: CSR_NEW_VALUE = CSR_READ_DATA | CSR_WRITE_DATA; // Set Bits
            FNC_RC, FNC_RCI: CSR_NEW_VALUE = CSR_READ_DATA & ~CSR_WRITE_DATA; // Clear Bits
            default: CSR_NEW_VALUE = CSR_WRITE_DATA; // Read and Write
        endcase
    end

    // Synchronous Write:
    always_ff @(posedge clk) begin
        if (reset) begin // On reset set all CSRs to 0
            CSR_TOHOST_REGISTER <= 64'd0;
            CSR_STATUS_REGISTER <= 64'd0;
            CSR_MSTATUS_REGISTER <= 64'd0;
            CSR_MTVEC_REGISTER <= 64'd0;
            CSR_MSCRATCH_REGISTER <= 64'd0;
            CSR_MEPC_REGISTER <= 64'd0;
            CSR_MCAUSE_REGISTER <= 64'd0;
            CSR_MTVAL_REGISTER <= 64'd0;
            CSR_MIE_REGISTER <= 64'd0;
            MIP_MTIP <= 1'b0;
            MIP_MEIP <= 1'b0;
            CSR_CYCLE_COUNTER <= 64'd0;
            CSR_INSTRET_COUNTER <= 64'd0;
            CYCLE_CARRY_PENDING <= 1'b0;
            INSTRET_CARRY_PENDING <= 1'b0;
        end else begin
            CSR_CYCLE_COUNTER <= {CYCLE_HIGH_NEXT, CYCLE_LOW_NEXT}; // One more clock cycle has passed
            MIP_MTIP <= TIMER_INTERRUPT_LINE; // registered: a device's line never reaches the pipeline's logic directly
            MIP_MEIP <= EXTERNAL_INTERRUPT_LINE;
            CYCLE_CARRY_PENDING <= CYCLE_LOW_CARRY; // The low half wrapped: the high half catches up next cycle
            CSR_INSTRET_COUNTER[63:32] <= INSTRET_HIGH_NEXT;
            INSTRET_CARRY_PENDING <= INSTRUCTION_RETIRED && INSTRET_LOW_CARRY;
            if (INSTRUCTION_RETIRED) begin
                CSR_INSTRET_COUNTER[31:0] <= INSTRET_LOW_NEXT; // One more instruction has finished
            end
            if (TAKE_TRAP) begin // Enter the trap: remember where and why, disable interrupts (MPIE <= MIE, MIE <= 0)
                CSR_MEPC_REGISTER <= {TRAP_PC[63:2], 2'b00}; // IALIGN = 32 (no compressed instructions): mepc[1:0] are always 0
                CSR_MCAUSE_REGISTER <= TRAP_CAUSE;
                if (EXCEPTIONS) CSR_MTVAL_REGISTER <= TRAP_VALUE;
                CSR_MSTATUS_REGISTER[7] <= CSR_MSTATUS_REGISTER[3];
                CSR_MSTATUS_REGISTER[3] <= 1'b0;
            end else if (RETURN_FROM_TRAP) begin // Leave the trap: MIE <= MPIE, MPIE <= 1
                CSR_MSTATUS_REGISTER[3] <= CSR_MSTATUS_REGISTER[7];
                CSR_MSTATUS_REGISTER[7] <= 1'b1;
            end
            if (CSR_WRITE_ENABLE) begin
                unique case (CSR_ADDRESS)
                    CSR_TOHOST: CSR_TOHOST_REGISTER <= CSR_NEW_VALUE;
                    CSR_STATUS: CSR_STATUS_REGISTER <= CSR_NEW_VALUE;
                    CSR_MSTATUS: CSR_MSTATUS_REGISTER <= CSR_NEW_VALUE;
                    CSR_MTVEC: CSR_MTVEC_REGISTER <= CSR_NEW_VALUE;
                    CSR_MSCRATCH: CSR_MSCRATCH_REGISTER <= CSR_NEW_VALUE;
                    CSR_MEPC: CSR_MEPC_REGISTER <= {CSR_NEW_VALUE[63:2], 2'b00}; // mepc[1:0] read as 0 (IALIGN = 32; found by riscv-formal)
                    CSR_MCAUSE: CSR_MCAUSE_REGISTER <= CSR_NEW_VALUE;
                    CSR_MTVAL: if (EXCEPTIONS) CSR_MTVAL_REGISTER <= CSR_NEW_VALUE;
                    CSR_MIE: CSR_MIE_REGISTER <= CSR_NEW_VALUE;
                    default: begin
                    // Whatever the previous values are just keep them as is by default (the counters are read-only)
                    end
                endcase
            end
        end
    end

    // Asynchronous Read:
    always_comb begin
        unique case (CSR_ADDRESS)
            CSR_TOHOST: CSR_READ_DATA = CSR_TOHOST_REGISTER;
            CSR_STATUS: CSR_READ_DATA = CSR_STATUS_REGISTER;
            CSR_HARTID: CSR_READ_DATA = 64'd0; // Only one core so just set id to 0
            // EXCEPTIONS = 1: mstatus.MPP (bits 12:11, the mode mret returns to) always reads 3, machine mode, the only
            // mode Sixfold has (a program that tries to set another mode can tell it is not there: rv64mi-illegal)
            CSR_MSTATUS: CSR_READ_DATA = CSR_MSTATUS_REGISTER | (EXCEPTIONS ? 64'h1800 : 64'd0);
            CSR_MTVEC: CSR_READ_DATA = CSR_MTVEC_REGISTER;
            CSR_MSCRATCH: CSR_READ_DATA = CSR_MSCRATCH_REGISTER;
            CSR_MEPC: CSR_READ_DATA = CSR_MEPC_REGISTER;
            CSR_MCAUSE: CSR_READ_DATA = CSR_MCAUSE_REGISTER;
            CSR_MTVAL: CSR_READ_DATA = EXCEPTIONS ? CSR_MTVAL_REGISTER : 64'd0;
            CSR_MIE: CSR_READ_DATA = CSR_MIE_REGISTER;
            CSR_MIP: CSR_READ_DATA = {52'd0, MIP_MEIP, 3'd0, MIP_MTIP, 7'd0};
            CSR_MHARTID: CSR_READ_DATA = 64'd0; // Standard Machine Hardware Thread ID: also 0
            CSR_CYCLE: CSR_READ_DATA = CSR_CYCLE_COUNTER;
            CSR_INSTRET: CSR_READ_DATA = CSR_INSTRET_COUNTER;
            CSR_HPMCOUNTER3: CSR_READ_DATA = EVENT_COUNT[0]; // L
            CSR_HPMCOUNTER4: CSR_READ_DATA = EVENT_COUNT[1]; // F
            CSR_HPMCOUNTER5: CSR_READ_DATA = EVENT_COUNT[2]; // R
            CSR_HPMCOUNTER6: CSR_READ_DATA = EVENT_COUNT[3]; // K
            CSR_HPMCOUNTER7: CSR_READ_DATA = EVENT_COUNT[4]; // I
            CSR_HPMCOUNTER8: CSR_READ_DATA = EVENT_COUNT[5]; // D
            CSR_HPMCOUNTER9: CSR_READ_DATA = EVENT_COUNT[6]; // X
            CSR_HPMCOUNTER10: CSR_READ_DATA = EVENT_COUNT[7]; // B
            default: CSR_READ_DATA = 64'd0;
        endcase
    end

    // Output to host value for testing purposes
    // for real applications this would be used to communicate with actual host hardware
    assign TOHOST = CSR_TOHOST_REGISTER;
    assign TRAP_VECTOR = {CSR_MTVEC_REGISTER[63:2], 2'b00}; // direct mode
    assign EXCEPTION_PC = CSR_MEPC_REGISTER;
    // An interrupt is taken when interrupts are on (mstatus.MIE), it is enabled in mie, and its line is up
    assign INTERRUPT_IS_EXTERNAL = CSR_MIE_REGISTER[11] && MIP_MEIP;
    assign INTERRUPT_REQUEST = CSR_MSTATUS_REGISTER[3] && ((CSR_MIE_REGISTER[7] && MIP_MTIP) || INTERRUPT_IS_EXTERNAL);

endmodule

// =====================================================================================================
// EventCounter: a 64-bit event counter split into two 32-bit halves with a registered carry (like cycle and
// instret above), so no 64-bit carry chain sits between two flip-flops.
// =====================================================================================================
module EventCounter (
    input  logic clk,
    input  logic reset,
    input  logic INCREMENT,
    output logic [63:0] COUNT
);
    logic CARRY_PENDING, LOW_CARRY, HIGH_CARRY_UNUSED;
    logic [31:0] LOW_NEXT, HIGH_NEXT;
    ParallelPrefixAdder #(.WIDTH(32)) low_incrementer (.A (COUNT[31:0]), .B (32'd0), .CARRY_IN (1'b1), .SUM (LOW_NEXT), .CARRY_OUT (LOW_CARRY));
    ParallelPrefixAdder #(.WIDTH(32)) high_incrementer (.A (COUNT[63:32]), .B (32'd0), .CARRY_IN (CARRY_PENDING), .SUM (HIGH_NEXT), .CARRY_OUT (HIGH_CARRY_UNUSED));
    always_ff @(posedge clk) begin
        if (reset) begin
            COUNT <= 64'd0;
            CARRY_PENDING <= 1'b0;
        end else begin
            COUNT[63:32] <= HIGH_NEXT;
            CARRY_PENDING <= INCREMENT && LOW_CARRY;
            if (INCREMENT) COUNT[31:0] <= LOW_NEXT;
        end
    end
endmodule

`default_nettype wire

// Research Results:
// Machine Hardware Thread ID
// CSR_MHARTID: Machine Hardware thread ID
// for this thread address is (address 0xF14)
// In real world applications multiple cores are used and to distinguish between them each core is assigned a unique hardware thread ID
// For this design the ID would be 0, but in the future for a multi-core design each core would need to be assigned an appropriate ID
// RISC-V Official Documentation CSR: https://docs.riscv.org/reference/isa/priv/priv-csrs.html
