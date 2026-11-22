`default_nettype none

import const_pkg::*;
import opcode_pkg::*;

// =============================================================================
// src/deep/Deep_CSR.sv: the deep edition's control and status registers
//
// CSRFile (src/Control_Status_Register_File.sv) with the 12-bit address decode moved out: DeepCSRDecode turns
// the address into a one-hot select in X4 (from the instruction word, a register away from anything else), and
// M1 reads and writes with that select. M1's read is then an AND-OR, not a compare followed by a mux. Everything
// else (the counters, traps, interrupts) is CSRFile's, unchanged. Shared modules stay as they are.
// The select has 21 bits, one per CSR CSRFile knows (SEL_* below, in DeepCSRDecode's order).
// =============================================================================
module DeepCSRDecode (
    input  logic [11:0] ADDRESS,
    output logic [20:0] SELECT
);
    always_comb begin
        SELECT[0] = (ADDRESS == CSR_TOHOST);
        SELECT[1] = (ADDRESS == CSR_STATUS);
        SELECT[2] = (ADDRESS == CSR_HARTID);
        SELECT[3] = (ADDRESS == CSR_MSTATUS);
        SELECT[4] = (ADDRESS == CSR_MTVEC);
        SELECT[5] = (ADDRESS == CSR_MSCRATCH);
        SELECT[6] = (ADDRESS == CSR_MEPC);
        SELECT[7] = (ADDRESS == CSR_MCAUSE);
        SELECT[8] = (ADDRESS == CSR_MIE);
        SELECT[9] = (ADDRESS == CSR_MIP);
        SELECT[10] = (ADDRESS == CSR_MHARTID);
        SELECT[11] = (ADDRESS == CSR_CYCLE);
        SELECT[12] = (ADDRESS == CSR_INSTRET);
        SELECT[13] = (ADDRESS == CSR_HPMCOUNTER3);
        SELECT[14] = (ADDRESS == CSR_HPMCOUNTER4);
        SELECT[15] = (ADDRESS == CSR_HPMCOUNTER5);
        SELECT[16] = (ADDRESS == CSR_HPMCOUNTER6);
        SELECT[17] = (ADDRESS == CSR_HPMCOUNTER7);
        SELECT[18] = (ADDRESS == CSR_HPMCOUNTER8);
        SELECT[19] = (ADDRESS == CSR_HPMCOUNTER9);
        SELECT[20] = (ADDRESS == CSR_HPMCOUNTER10);
    end
endmodule

module DeepCSRFile (
    input logic clk,
    input logic reset,
    input logic CSR_WRITE_ENABLE,
    input logic [20:0] CSR_SELECT, // one-hot (DeepCSRDecode, a stage early) instead of the address
    input logic [2:0] CSR_OPERATION, // funct3: CSRRW(I) write, CSRRS(I) set bits, CSRRC(I) clear bits
    input logic [63:0] CSR_WRITE_DATA, // rs1 value or the 5-bit zero extended immediate
    input logic INSTRUCTION_RETIRED, // An instruction finished in Writeback this cycle (counts instret)
    input logic [7:0] PERFORMANCE_EVENTS, // {late kill, interrupt, D miss, I miss, M busy, redirect, flush, load stall}: the TRACE_* signals of this cycle
    input logic TAKE_TRAP, // ecall / ebreak / an interrupt in Execute: record the trap
    input logic [63:0] TRAP_PC, // ... the address of that instruction (for an interrupt: the one it replaced)
    input logic [63:0] TRAP_CAUSE, // ... and why (11, 3, or bit 63 + 7 / 11 for interrupts)
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
    localparam int SEL_TOHOST = 0;
    localparam int SEL_STATUS = 1;
    localparam int SEL_HARTID = 2;
    localparam int SEL_MSTATUS = 3;
    localparam int SEL_MTVEC = 4;
    localparam int SEL_MSCRATCH = 5;
    localparam int SEL_MEPC = 6;
    localparam int SEL_MCAUSE = 7;
    localparam int SEL_MIE = 8;
    localparam int SEL_MIP = 9;
    localparam int SEL_MHARTID = 10;
    localparam int SEL_CYCLE = 11;
    localparam int SEL_INSTRET = 12;
    localparam int SEL_HPMCOUNTER3 = 13;
    localparam int SEL_HPMCOUNTER4 = 14;
    localparam int SEL_HPMCOUNTER5 = 15;
    localparam int SEL_HPMCOUNTER6 = 16;
    localparam int SEL_HPMCOUNTER7 = 17;
    localparam int SEL_HPMCOUNTER8 = 18;
    localparam int SEL_HPMCOUNTER9 = 19;
    localparam int SEL_HPMCOUNTER10 = 20;

    logic [63:0] CSR_TOHOST_REGISTER;
    logic [63:0] CSR_STATUS_REGISTER;
    logic [63:0] CSR_MSTATUS_REGISTER, CSR_MTVEC_REGISTER, CSR_MSCRATCH_REGISTER, CSR_MEPC_REGISTER, CSR_MCAUSE_REGISTER;
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
                CSR_MEPC_REGISTER <= {TRAP_PC[63:1], 1'b0};
                CSR_MCAUSE_REGISTER <= TRAP_CAUSE;
                CSR_MSTATUS_REGISTER[7] <= CSR_MSTATUS_REGISTER[3];
                CSR_MSTATUS_REGISTER[3] <= 1'b0;
            end else if (RETURN_FROM_TRAP) begin // Leave the trap: MIE <= MPIE, MPIE <= 1
                CSR_MSTATUS_REGISTER[3] <= CSR_MSTATUS_REGISTER[7];
                CSR_MSTATUS_REGISTER[7] <= 1'b1;
            end
            if (CSR_WRITE_ENABLE) begin
                if (CSR_SELECT[SEL_TOHOST]) CSR_TOHOST_REGISTER <= CSR_NEW_VALUE;
                if (CSR_SELECT[SEL_STATUS]) CSR_STATUS_REGISTER <= CSR_NEW_VALUE;
                if (CSR_SELECT[SEL_MSTATUS]) CSR_MSTATUS_REGISTER <= CSR_NEW_VALUE;
                if (CSR_SELECT[SEL_MTVEC]) CSR_MTVEC_REGISTER <= CSR_NEW_VALUE;
                if (CSR_SELECT[SEL_MSCRATCH]) CSR_MSCRATCH_REGISTER <= CSR_NEW_VALUE;
                if (CSR_SELECT[SEL_MEPC]) CSR_MEPC_REGISTER <= {CSR_NEW_VALUE[63:1], 1'b0}; // mepc is always even
                if (CSR_SELECT[SEL_MCAUSE]) CSR_MCAUSE_REGISTER <= CSR_NEW_VALUE;
                if (CSR_SELECT[SEL_MIE]) CSR_MIE_REGISTER <= CSR_NEW_VALUE;
            end
        end
    end

    // Asynchronous Read: an AND-OR of the one-hot select (no address compare)
    always_comb begin
        CSR_READ_DATA = ({64{CSR_SELECT[SEL_TOHOST]}} & CSR_TOHOST_REGISTER)
                      | ({64{CSR_SELECT[SEL_STATUS]}} & CSR_STATUS_REGISTER)
                      | ({64{CSR_SELECT[SEL_HARTID]}} & 64'd0)
                      | ({64{CSR_SELECT[SEL_MSTATUS]}} & CSR_MSTATUS_REGISTER)
                      | ({64{CSR_SELECT[SEL_MTVEC]}} & CSR_MTVEC_REGISTER)
                      | ({64{CSR_SELECT[SEL_MSCRATCH]}} & CSR_MSCRATCH_REGISTER)
                      | ({64{CSR_SELECT[SEL_MEPC]}} & CSR_MEPC_REGISTER)
                      | ({64{CSR_SELECT[SEL_MCAUSE]}} & CSR_MCAUSE_REGISTER)
                      | ({64{CSR_SELECT[SEL_MIE]}} & CSR_MIE_REGISTER)
                      | ({64{CSR_SELECT[SEL_MIP]}} & {52'd0, MIP_MEIP, 3'd0, MIP_MTIP, 7'd0})
                      | ({64{CSR_SELECT[SEL_MHARTID]}} & 64'd0)
                      | ({64{CSR_SELECT[SEL_CYCLE]}} & CSR_CYCLE_COUNTER)
                      | ({64{CSR_SELECT[SEL_INSTRET]}} & CSR_INSTRET_COUNTER)
                      | ({64{CSR_SELECT[SEL_HPMCOUNTER3]}} & EVENT_COUNT[0])
                      | ({64{CSR_SELECT[SEL_HPMCOUNTER4]}} & EVENT_COUNT[1])
                      | ({64{CSR_SELECT[SEL_HPMCOUNTER5]}} & EVENT_COUNT[2])
                      | ({64{CSR_SELECT[SEL_HPMCOUNTER6]}} & EVENT_COUNT[3])
                      | ({64{CSR_SELECT[SEL_HPMCOUNTER7]}} & EVENT_COUNT[4])
                      | ({64{CSR_SELECT[SEL_HPMCOUNTER8]}} & EVENT_COUNT[5])
                      | ({64{CSR_SELECT[SEL_HPMCOUNTER9]}} & EVENT_COUNT[6])
                      | ({64{CSR_SELECT[SEL_HPMCOUNTER10]}} & EVENT_COUNT[7]);
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

`default_nettype wire
