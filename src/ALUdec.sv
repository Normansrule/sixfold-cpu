`default_nettype none

// Module: ALUdec
// Desc:   Sets the ALU operation (RV64I, M, Zba, Zbb, Zbs) and the operand preparation DECODE applies
// Inputs:
//   opcode   : instruction opcode
//   funct    : funct3 field
//   funct7   : instruction bits [31:25] (funct6 = [31:26] for 64-bit shift immediates)
//   funct12  : instruction bits [31:20] (selects the Zbb one-operand operations: clz, cpop, rev8, ...)
// Outputs:
//   ALUop                  : selects the ALU operation
//   OPERAND_A_ZERO_EXTEND  : Zba ".uw" forms use zext(rs1[31:0]) as operand A
//   OPERAND_A_SHIFT        : Zba sh1add / sh2add / sh3add use rs1 << 1, 2 or 3 as operand A
//   OPERAND_B_INVERT       : Zbb andn / orn / xnor use ~rs2 as operand B (Zbs bclr: ~(1 << rs2))
//   OPERAND_B_SINGLE_BIT   : Zbs bset / bclr / binv use 1 << rs2[5:0] (or the immediate) as operand B
//   FULL_WIDTH_RESULT      : in the 32-bit "W" opcode space but a 64-bit result (add.uw, shNadd.uw, slli.uw, zext.h)
//
// The operand preparation happens in DECODE, where the ALU operands are chosen anyway, so the ALU itself
// only ever sees an ADD, SLL, AND, OR or XOR for these: no new logic in the ALU's one-cycle loop.
//   bset = rs1 | (1 << n)     bclr = rs1 & ~(1 << n)     binv = rs1 ^ (1 << n)
// (model/core.js aluDecode() is the bit-exact twin of this module.)

import opcode_pkg::*;
import alu_op_pkg::*;

module ALUdec (
  input  logic [6:0]  opcode,
  input  logic [2:0]  funct,
  input  logic [6:0]  funct7,
  input  logic [11:0] funct12,
  output alu_op_t     ALUop,
  output logic        OPERAND_A_ZERO_EXTEND,
  output logic [1:0]  OPERAND_A_SHIFT,
  output logic        OPERAND_B_INVERT,
  output logic        OPERAND_B_SINGLE_BIT,
  output logic        FULL_WIDTH_RESULT
);

  logic [5:0] funct6;
  logic       sra_type; // instruction bit 30: SUB instead of ADD, SRA instead of SRL
  assign funct6 = funct7[6:1];
  assign sra_type = funct7[5];

  // The RV64I operations selected by funct3 alone (SRL/SRA by bit 30)
  alu_op_t base_operation;
  always_comb begin
    unique case (funct)
      FNC_ADD_SUB: base_operation = ALU_ADD;
      FNC_SLL: base_operation = ALU_SLL;
      FNC_SLT: base_operation = ALU_SLT;
      FNC_SLTU: base_operation = ALU_SLTU;
      FNC_XOR: base_operation = ALU_XOR;
      FNC_SRL_SRA: if (sra_type) base_operation = ALU_SRA; else base_operation = ALU_SRL; // (if/else, not ?: : Icarus Verilog wants enums assigned directly)
      FNC_OR: base_operation = ALU_OR;
      FNC_AND: base_operation = ALU_AND;
      default: base_operation = ALU_XXX;
    endcase
  end

  always_comb begin
    ALUop = ALU_XXX;
    OPERAND_A_ZERO_EXTEND = 1'b0;
    OPERAND_A_SHIFT = 2'd0;
    OPERAND_B_INVERT = 1'b0;
    OPERAND_B_SINGLE_BIT = 1'b0;
    FULL_WIDTH_RESULT = 1'b0;
    unique case (opcode)
      OPC_LUI: ALUop = ALU_COPY_B;
      OPC_AUIPC: ALUop = ALU_ADD;
      OPC_JAL: ALUop = ALU_ADD;
      OPC_JALR: ALUop = ALU_JALR;
      OPC_BRANCH: ALUop = ALU_ADD;
      OPC_LOAD: ALUop = ALU_ADD;
      OPC_STORE: ALUop = ALU_ADD;
      OPC_ARI_ITYPE: begin // addi ... srai, and the Zbb immediate / one-operand forms
        if (funct == FNC_SLL) begin
          unique case (funct12)
            12'h600: ALUop = ALU_CLZ;
            12'h601: ALUop = ALU_CTZ;
            12'h602: ALUop = ALU_CPOP;
            12'h604: ALUop = ALU_SEXT_B;
            12'h605: ALUop = ALU_SEXT_H;
            default: begin
              unique case (funct6)
                6'b001010: begin ALUop = ALU_OR; OPERAND_B_SINGLE_BIT = 1'b1; end // bseti
                6'b010010: begin ALUop = ALU_AND; OPERAND_B_SINGLE_BIT = 1'b1; OPERAND_B_INVERT = 1'b1; end // bclri
                6'b011010: begin ALUop = ALU_XOR; OPERAND_B_SINGLE_BIT = 1'b1; end // binvi
                default: ALUop = ALU_SLL; // slli
              endcase
            end
          endcase
        end else if (funct == FNC_SRL_SRA) begin
          if (funct12 == 12'h6B8) ALUop = ALU_REV8;
          else if (funct12 == 12'h287) ALUop = ALU_ORC_B;
          else if (funct6 == 6'b011000) ALUop = ALU_ROR; // rori
          else if (funct6 == 6'b010010) ALUop = ALU_BEXT; // bexti
          else ALUop = base_operation; // srli, srai
        end else begin
          ALUop = base_operation;
        end
      end
      OPC_ARI_ITYPE_WORD: begin // addiw, slliw, srliw, sraiw, and clzw ctzw cpopw slli.uw roriw
        if (funct == FNC_SLL) begin
          unique case (funct12)
            12'h600: ALUop = ALU_CLZ;
            12'h601: ALUop = ALU_CTZ;
            12'h602: ALUop = ALU_CPOP;
            default: begin
              ALUop = ALU_SLL;
              if (funct6 == 6'b000010) begin // slli.uw
                OPERAND_A_ZERO_EXTEND = 1'b1;
                FULL_WIDTH_RESULT = 1'b1;
              end
            end
          endcase
        end else if (funct == FNC_SRL_SRA) begin
          if (funct7 == 7'b0110000) ALUop = ALU_ROR; else ALUop = base_operation; // roriw, srliw, sraiw
        end else begin
          ALUop = base_operation;
        end
      end
      OPC_ARI_RTYPE, OPC_ARI_RTYPE_WORD: begin
        unique case (funct7)
          FNC7_MULTIPLY_DIVIDE: begin // ===== M extension (funct7 = 0000001) =====
            unique case (funct)
              FNC_MUL: ALUop = ALU_MUL;
              FNC_MULH: ALUop = ALU_MULH;
              FNC_MULHSU: ALUop = ALU_MULHSU;
              FNC_MULHU: ALUop = ALU_MULHU;
              FNC_DIV: ALUop = ALU_DIV;
              FNC_DIVU: ALUop = ALU_DIVU;
              FNC_REM: ALUop = ALU_REM;
              FNC_REMU: ALUop = ALU_REMU;
              default: ALUop = ALU_XXX;
            endcase
          end
          7'b0000000: ALUop = base_operation;
          7'b0100000: begin // sub, sra, and Zbb andn / orn / xnor (not in the W space)
            if (funct == FNC_ADD_SUB) ALUop = ALU_SUB;
            else if (funct == FNC_SRL_SRA) ALUop = ALU_SRA;
            else if (opcode == OPC_ARI_RTYPE && (funct == FNC_AND || funct == FNC_OR || funct == FNC_XOR)) begin
              ALUop = base_operation;
              OPERAND_B_INVERT = 1'b1;
            end
          end
          7'b0010000: begin // Zba sh1add sh2add sh3add (and their .uw forms in the W space)
            if (funct == 3'b010 || funct == 3'b100 || funct == 3'b110) begin
              ALUop = ALU_ADD;
              OPERAND_A_SHIFT = funct[2:1];
              OPERAND_A_ZERO_EXTEND = (opcode == OPC_ARI_RTYPE_WORD);
              FULL_WIDTH_RESULT = (opcode == OPC_ARI_RTYPE_WORD);
            end
          end
          7'b0000101: begin // Zbb min minu max maxu
            if (opcode == OPC_ARI_RTYPE) begin
              unique case (funct)
                3'b100: ALUop = ALU_MIN;
                3'b101: ALUop = ALU_MINU;
                3'b110: ALUop = ALU_MAX;
                3'b111: ALUop = ALU_MAXU;
                default: ALUop = ALU_XXX;
              endcase
            end
          end
          7'b0110000: begin // Zbb rol ror (rolw rorw in the W space)
            if (funct == FNC_SLL) ALUop = ALU_ROL;
            else if (funct == FNC_SRL_SRA) ALUop = ALU_ROR;
          end
          7'b0010100: if (opcode == OPC_ARI_RTYPE && funct == FNC_SLL) begin // Zbs bset
            ALUop = ALU_OR;
            OPERAND_B_SINGLE_BIT = 1'b1;
          end
          7'b0100100: begin // Zbs bclr bext
            if (opcode == OPC_ARI_RTYPE && funct == FNC_SLL) begin
              ALUop = ALU_AND;
              OPERAND_B_SINGLE_BIT = 1'b1;
              OPERAND_B_INVERT = 1'b1;
            end else if (opcode == OPC_ARI_RTYPE && funct == FNC_SRL_SRA) ALUop = ALU_BEXT;
          end
          7'b0110100: if (opcode == OPC_ARI_RTYPE && funct == FNC_SLL) begin // Zbs binv
            ALUop = ALU_XOR;
            OPERAND_B_SINGLE_BIT = 1'b1;
          end
          7'b0000100: begin // Zba add.uw, Zbb zext.h (both W space, both 64-bit results)
            if (opcode == OPC_ARI_RTYPE_WORD && funct == FNC_ADD_SUB) begin
              ALUop = ALU_ADD;
              OPERAND_A_ZERO_EXTEND = 1'b1;
              FULL_WIDTH_RESULT = 1'b1;
            end else if (opcode == OPC_ARI_RTYPE_WORD && funct == FNC_XOR) begin
              ALUop = ALU_ZEXT_H;
              FULL_WIDTH_RESULT = 1'b1;
            end
          end
          default: ALUop = ALU_XXX;
        endcase
      end
      OPC_CSR: begin
        unique case (funct)
          FNC_RW: ALUop = ALU_COPY_B;
          FNC_RWI: ALUop = ALU_COPY_B;
          default: ALUop = ALU_XXX;
        endcase
      end
    default: ALUop = ALU_XXX;
    endcase
  end

endmodule

`default_nettype wire
