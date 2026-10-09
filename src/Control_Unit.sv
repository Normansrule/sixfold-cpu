`default_nettype none

import opcode_pkg::*;
import immediate_op_pkg::*;
import alu_op_pkg::*;
import writeback_op_pkg::*;

module ControlUnit (
    input logic [31:0] INSTRUCTION,
    output logic REGISTER_WRITE_ENABLE,
    output logic MEMORY_READ_ENABLE,
    output logic MEMORY_WRITE_ENABLE,
    output logic CSR_WRITE_ENABLE,
    output logic CSR_WRITE_USING_IMMEDIATE,
    output logic ALU_INPUT_A_IS_PC,
    output logic ALU_INPUT_B_IS_IMMEDIATE,
    output logic ALU_IS_WORD_OPERATION, // RV64: 32-bit "W" instruction (ADDW, ADDIW, MULW, ...)
    output logic IS_A_MULTIPLY_DIVIDE_INSTRUCTION, // RV64M: result comes from the Multiply Divide Unit
    output logic IS_A_BRANCH_INSTRUCTION,
    output logic IS_A_JAL_INSTRUCTION,
    output logic IS_A_JALR_INSTRUCTION,
    output logic IS_AN_ECALL, // Environment call: trap to mtvec with mcause 11
    output logic IS_AN_EBREAK, // Breakpoint: trap to mtvec with mcause 3
    output logic IS_AN_MRET, // Return from a trap to mepc
    output logic USES_REGISTER1, // This instruction really reads rs1 (used for precise load stalls)
    output logic USES_REGISTER2, // This instruction really reads rs2
    output immediate_type_select_t IMMEDIATE_TYPE_SELECT,
    output writeback_select_t WRITEBACK_SELECT,
    output alu_op_t ALU_OPERATION,
    output logic ALU_OPERAND_A_ZERO_EXTEND, // Zba .uw: operand A = zext(rs1[31:0])   (applied in DECODE)
    output logic [1:0] ALU_OPERAND_A_SHIFT, // Zba shNadd: operand A = rs1 << N
    output logic ALU_OPERAND_B_INVERT, // Zbb andn / orn / xnor: operand B = ~rs2 (Zbs bclr: ~(1 << rs2))
    output logic ALU_OPERAND_B_SINGLE_BIT // Zbs bset / bclr / binv: operand B = 1 << rs2[5:0] (or the immediate)
);

    logic [6:0] INSTRUCTION_OPCODE;
    logic [2:0] INSTRUCTION_FUNCT3;
    logic [6:0] INSTRUCTION_FUNCT7;
    logic [4:0] INSTRUCTION_REGISTER1_FIELD; // rs1 field (also the 5-bit zimm of CSRRWI/CSRRSI/CSRRCI)
    logic INSTRUCTION_MULTIPLY_DIVIDE_TYPE; // if 1 this R-type instruction belongs to the M extension (funct7 = 0000001)

    assign INSTRUCTION_OPCODE = INSTRUCTION[6:0];
    assign INSTRUCTION_FUNCT3 = INSTRUCTION[14:12];
    assign INSTRUCTION_FUNCT7 = INSTRUCTION[31:25];
    assign INSTRUCTION_REGISTER1_FIELD = INSTRUCTION[19:15];
    assign INSTRUCTION_MULTIPLY_DIVIDE_TYPE = (INSTRUCTION_FUNCT7 == FNC7_MULTIPLY_DIVIDE);

    logic FULL_WIDTH_RESULT; // add.uw, shNadd.uw, slli.uw, zext.h: W opcode space, 64-bit result
    ALUdec alu_decode (
        .opcode(INSTRUCTION_OPCODE),
        .funct(INSTRUCTION_FUNCT3),
        .funct7(INSTRUCTION_FUNCT7),
        .funct12(INSTRUCTION[31:20]),
        .ALUop(ALU_OPERATION),
        .OPERAND_A_ZERO_EXTEND(ALU_OPERAND_A_ZERO_EXTEND),
        .OPERAND_A_SHIFT(ALU_OPERAND_A_SHIFT),
        .OPERAND_B_INVERT(ALU_OPERAND_B_INVERT),
        .OPERAND_B_SINGLE_BIT(ALU_OPERAND_B_SINGLE_BIT),
        .FULL_WIDTH_RESULT(FULL_WIDTH_RESULT)
    );

    // System instructions with funct3 = 000 are told apart by bits 31:20 (rd and rs1 must be x0)
    logic IS_A_PRIVILEGED_SYSTEM_INSTRUCTION;
    assign IS_A_PRIVILEGED_SYSTEM_INSTRUCTION = (INSTRUCTION_OPCODE == OPC_CSR) && (INSTRUCTION_FUNCT3 == FNC_PRIV) && (INSTRUCTION[19:15] == 5'd0) && (INSTRUCTION[11:7] == 5'd0);
    assign IS_AN_ECALL = IS_A_PRIVILEGED_SYSTEM_INSTRUCTION && (INSTRUCTION[31:20] == 12'h000);
    assign IS_AN_EBREAK = IS_A_PRIVILEGED_SYSTEM_INSTRUCTION && (INSTRUCTION[31:20] == 12'h001);
    assign IS_AN_MRET = IS_A_PRIVILEGED_SYSTEM_INSTRUCTION && (INSTRUCTION[31:20] == 12'h302);

    // Which source registers are REALLY read. LOAD_STALL can use these instead of the raw rs1/rs2 fields,
    // so "addi a1, zero, 5" right after "ld t0" no longer stalls just because its immediate looks like x5.
    always_comb begin
        unique case (INSTRUCTION_OPCODE)
            OPC_ARI_RTYPE, OPC_ARI_RTYPE_WORD, OPC_STORE, OPC_BRANCH, OPC_CUSTOM0: begin USES_REGISTER1 = 1'b1; USES_REGISTER2 = 1'b1; end
            OPC_ARI_ITYPE, OPC_ARI_ITYPE_WORD, OPC_LOAD, OPC_JALR: begin USES_REGISTER1 = 1'b1; USES_REGISTER2 = 1'b0; end
            OPC_CSR: begin USES_REGISTER1 = (INSTRUCTION_FUNCT3 == FNC_RW) || (INSTRUCTION_FUNCT3 == FNC_RS) || (INSTRUCTION_FUNCT3 == FNC_RC); USES_REGISTER2 = 1'b0; end
            default: begin USES_REGISTER1 = 1'b0; USES_REGISTER2 = 1'b0; end // LUI, AUIPC, JAL, FENCE
        endcase
    end

    always_comb begin
        REGISTER_WRITE_ENABLE = 1'b0;
        MEMORY_READ_ENABLE = 1'b0;
        MEMORY_WRITE_ENABLE = 1'b0;
        CSR_WRITE_ENABLE = 1'b0;
        CSR_WRITE_USING_IMMEDIATE = 1'b0;
        ALU_INPUT_A_IS_PC = 1'b0; // 0 means assume register 1, 1 means assume PC
        ALU_INPUT_B_IS_IMMEDIATE = 1'b0; // 0 means assume register 2, 1 means assume Immediate
        ALU_IS_WORD_OPERATION = 1'b0; // 0 means full 64-bit operation
        IS_A_MULTIPLY_DIVIDE_INSTRUCTION = 1'b0;
        IS_A_BRANCH_INSTRUCTION = 1'b0;
        IS_A_JAL_INSTRUCTION = 1'b0;
        IS_A_JALR_INSTRUCTION = 1'b0;
        IMMEDIATE_TYPE_SELECT = IMMEDIATE_I;
        WRITEBACK_SELECT = WRITEBACK_ALU;

        unique case (INSTRUCTION_OPCODE)
            OPC_LUI: begin
                REGISTER_WRITE_ENABLE = 1'b1;
                ALU_INPUT_B_IS_IMMEDIATE = 1'b1;
                IMMEDIATE_TYPE_SELECT = IMMEDIATE_U;
                WRITEBACK_SELECT = WRITEBACK_ALU;
            end
            OPC_AUIPC: begin
                REGISTER_WRITE_ENABLE = 1'b1;
                ALU_INPUT_A_IS_PC = 1'b1;
                ALU_INPUT_B_IS_IMMEDIATE = 1'b1;
                IMMEDIATE_TYPE_SELECT = IMMEDIATE_U;
                WRITEBACK_SELECT = WRITEBACK_ALU;
            end
            OPC_JAL: begin
                IS_A_JAL_INSTRUCTION    = 1'b1;
                REGISTER_WRITE_ENABLE = 1'b1;
                ALU_INPUT_A_IS_PC = 1'b1;
                ALU_INPUT_B_IS_IMMEDIATE = 1'b1;
                IMMEDIATE_TYPE_SELECT = IMMEDIATE_J;
                WRITEBACK_SELECT = WRITEBACK_PC_ADD_4;
            end
            OPC_JALR: begin
                IS_A_JALR_INSTRUCTION  = 1'b1;
                REGISTER_WRITE_ENABLE = 1'b1;
                ALU_INPUT_B_IS_IMMEDIATE = 1'b1;
                IMMEDIATE_TYPE_SELECT = IMMEDIATE_I;
                WRITEBACK_SELECT = WRITEBACK_PC_ADD_4;
            end
            OPC_BRANCH: begin
                IS_A_BRANCH_INSTRUCTION = 1'b1;
                ALU_INPUT_A_IS_PC = 1'b1;
                ALU_INPUT_B_IS_IMMEDIATE = 1'b1;
                IMMEDIATE_TYPE_SELECT = IMMEDIATE_B;
            end
            OPC_STORE: begin
                MEMORY_WRITE_ENABLE = 1'b1;
                ALU_INPUT_B_IS_IMMEDIATE = 1'b1;
                IMMEDIATE_TYPE_SELECT = IMMEDIATE_S;
            end
            OPC_LOAD: begin
                REGISTER_WRITE_ENABLE = 1'b1;
                MEMORY_READ_ENABLE = 1'b1;
                ALU_INPUT_B_IS_IMMEDIATE = 1'b1;
                IMMEDIATE_TYPE_SELECT = IMMEDIATE_I;
                WRITEBACK_SELECT = WRITEBACK_MEMORY;
            end
            OPC_ARI_RTYPE: begin
                REGISTER_WRITE_ENABLE = 1'b1;
                IS_A_MULTIPLY_DIVIDE_INSTRUCTION = INSTRUCTION_MULTIPLY_DIVIDE_TYPE;
                WRITEBACK_SELECT = WRITEBACK_ALU;
            end
            OPC_CUSTOM0: begin // hsec.cteq: an R-type ALU instruction in an opcode of our own
                REGISTER_WRITE_ENABLE = (INSTRUCTION_FUNCT7 == 7'b0000000) && (INSTRUCTION_FUNCT3 == 3'b110);
                WRITEBACK_SELECT = WRITEBACK_ALU;
            end
            OPC_ARI_ITYPE: begin
                REGISTER_WRITE_ENABLE = 1'b1;
                ALU_INPUT_B_IS_IMMEDIATE = 1'b1;
                IMMEDIATE_TYPE_SELECT = IMMEDIATE_I;
                WRITEBACK_SELECT = WRITEBACK_ALU;
            end
            // ===============================================
            // RV64 Word instructions: same as above but 32-bit and sign extended
            OPC_ARI_RTYPE_WORD: begin
                REGISTER_WRITE_ENABLE = 1'b1;
                ALU_IS_WORD_OPERATION = !FULL_WIDTH_RESULT;
                IS_A_MULTIPLY_DIVIDE_INSTRUCTION = INSTRUCTION_MULTIPLY_DIVIDE_TYPE;
                WRITEBACK_SELECT = WRITEBACK_ALU;
            end
            OPC_ARI_ITYPE_WORD: begin
                REGISTER_WRITE_ENABLE = 1'b1;
                ALU_INPUT_B_IS_IMMEDIATE = 1'b1;
                ALU_IS_WORD_OPERATION = !FULL_WIDTH_RESULT;
                IMMEDIATE_TYPE_SELECT = IMMEDIATE_I;
                WRITEBACK_SELECT = WRITEBACK_ALU;
            end
            // ===============================================
            OPC_CSR: begin
                REGISTER_WRITE_ENABLE = (INSTRUCTION_FUNCT3 != FNC_PRIV); // Regfile will ignore x0 writes by default (ECALL/EBREAK do nothing)
                WRITEBACK_SELECT = WRITEBACK_CSR;
                // CSRRW/CSRRWI always write. CSRRS/CSRRC and their immediate forms only write when rs1/zimm != 0,
                // so "csrr rd, cycle" (= csrrs rd, cycle, x0) is a pure read, exactly as the RISC-V specification says
                if ((INSTRUCTION_FUNCT3 == FNC_RW) || (INSTRUCTION_FUNCT3 == FNC_RWI)) begin
                    CSR_WRITE_ENABLE = 1'b1;
                end else if (INSTRUCTION_FUNCT3 != FNC_PRIV) begin
                    CSR_WRITE_ENABLE = (INSTRUCTION_REGISTER1_FIELD != 5'd0);
                end
                if ((INSTRUCTION_FUNCT3 == FNC_RWI) || (INSTRUCTION_FUNCT3 == FNC_RSI) || (INSTRUCTION_FUNCT3 == FNC_RCI)) begin
                    CSR_WRITE_USING_IMMEDIATE = 1'b1;
                    IMMEDIATE_TYPE_SELECT = IMMEDIATE_Z;
                end else begin
                    CSR_WRITE_USING_IMMEDIATE = 1'b0;
                    IMMEDIATE_TYPE_SELECT = IMMEDIATE_I;
                end
            end
            default: begin // FENCE and unknown opcodes do nothing on this in-order single memory core
                REGISTER_WRITE_ENABLE = 1'b0;
                MEMORY_READ_ENABLE = 1'b0;
                MEMORY_WRITE_ENABLE = 1'b0;
                CSR_WRITE_ENABLE = 1'b0;
                CSR_WRITE_USING_IMMEDIATE = 1'b0;
                ALU_INPUT_A_IS_PC = 1'b0;
                ALU_INPUT_B_IS_IMMEDIATE = 1'b0;
                ALU_IS_WORD_OPERATION = 1'b0;
                IS_A_MULTIPLY_DIVIDE_INSTRUCTION = 1'b0;
                IS_A_BRANCH_INSTRUCTION = 1'b0;
                IS_A_JAL_INSTRUCTION = 1'b0;
                IS_A_JALR_INSTRUCTION = 1'b0;
                IMMEDIATE_TYPE_SELECT = IMMEDIATE_I;
                WRITEBACK_SELECT = WRITEBACK_ALU;
            end
        endcase
    end

endmodule

`default_nettype wire
