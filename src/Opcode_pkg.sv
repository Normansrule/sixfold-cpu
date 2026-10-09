`default_nettype none

/* List of RISC-V opcodes + funct codes (RV64I + M + Zicsr). */

package opcode_pkg;

  // ***** Opcodes *****
  localparam logic [6:0] OPC_NOOP      = 7'b0000000;

  // Special immediate instructions
  localparam logic [6:0] OPC_LUI       = 7'b0110111;
  localparam logic [6:0] OPC_AUIPC     = 7'b0010111;

  // Jump instructions
  localparam logic [6:0] OPC_JAL       = 7'b1101111;
  localparam logic [6:0] OPC_JALR      = 7'b1100111;

  // Branch instructions
  localparam logic [6:0] OPC_BRANCH    = 7'b1100011;

  // Load and store instructions
  localparam logic [6:0] OPC_STORE     = 7'b0100011;
  localparam logic [6:0] OPC_LOAD      = 7'b0000011;

  // Arithmetic instructions
  localparam logic [6:0] OPC_ARI_RTYPE = 7'b0110011;
  localparam logic [6:0] OPC_ARI_ITYPE = 7'b0010011;

  // ===============================================
  // RV64 Word (32-bit) arithmetic instructions: ADDIW, SLLIW, ADDW, SUBW, MULW, ...
  localparam logic [6:0] OPC_ARI_ITYPE_WORD = 7'b0011011;
  localparam logic [6:0] OPC_ARI_RTYPE_WORD = 7'b0111011;
  // ===============================================

  // Control status register
  localparam logic [6:0] OPC_CSR       = 7'b1110011;

  // custom-0: an opcode the RISC-V specification reserves for vendor extensions, so
  // no standard instruction will ever land here (docs/learn/10_adding_instructions.md)
  localparam logic [6:0] OPC_CUSTOM0   = 7'b0001011;

  // ***** Function codes (funct3) *****

  // Branch funct3 codes
  localparam logic [2:0] FNC_BEQ       = 3'b000;
  localparam logic [2:0] FNC_BNE       = 3'b001;
  localparam logic [2:0] FNC_BLT       = 3'b100;
  localparam logic [2:0] FNC_BGE       = 3'b101;
  localparam logic [2:0] FNC_BLTU      = 3'b110;
  localparam logic [2:0] FNC_BGEU      = 3'b111;

  // Load funct3 codes
  localparam logic [2:0] FNC_LB        = 3'b000;
  localparam logic [2:0] FNC_LH        = 3'b001;
  localparam logic [2:0] FNC_LW        = 3'b010;
  localparam logic [2:0] FNC_LD        = 3'b011; // RV64: Load Doubleword
  localparam logic [2:0] FNC_LBU       = 3'b100;
  localparam logic [2:0] FNC_LHU       = 3'b101;
  localparam logic [2:0] FNC_LWU       = 3'b110; // RV64: Load Word Unsigned

  // Store funct3 codes
  localparam logic [2:0] FNC_SB        = 3'b000;
  localparam logic [2:0] FNC_SH        = 3'b001;
  localparam logic [2:0] FNC_SW        = 3'b010;
  localparam logic [2:0] FNC_SD        = 3'b011; // RV64: Store Doubleword

  // Arithmetic R-type / I-type funct3 codes
  localparam logic [2:0] FNC_ADD_SUB   = 3'b000;
  localparam logic [2:0] FNC_SLL       = 3'b001;
  localparam logic [2:0] FNC_SLT       = 3'b010;
  localparam logic [2:0] FNC_SLTU      = 3'b011;
  localparam logic [2:0] FNC_XOR       = 3'b100;
  localparam logic [2:0] FNC_SRL_SRA   = 3'b101;
  localparam logic [2:0] FNC_OR        = 3'b110;
  localparam logic [2:0] FNC_AND       = 3'b111;

  // ===============================================
  // M extension funct3 codes (funct7 = 0000001):
  localparam logic [6:0] FNC7_MULTIPLY_DIVIDE = 7'b0000001;
  localparam logic [2:0] FNC_MUL       = 3'b000;
  localparam logic [2:0] FNC_MULH      = 3'b001;
  localparam logic [2:0] FNC_MULHSU    = 3'b010;
  localparam logic [2:0] FNC_MULHU     = 3'b011;
  localparam logic [2:0] FNC_DIV       = 3'b100;
  localparam logic [2:0] FNC_DIVU      = 3'b101;
  localparam logic [2:0] FNC_REM       = 3'b110;
  localparam logic [2:0] FNC_REMU      = 3'b111;
  // ===============================================

  // CSR funct3 codes
  localparam logic [2:0] FNC_RW        = 3'b001; // CSRRW
  localparam logic [2:0] FNC_RWI       = 3'b101; // CSRRWI

  // ===============================================
  // Other Control and Status Register funct3 codes:
  localparam logic [2:0] FNC_RS     = 3'b010; // CSRRS
  localparam logic [2:0] FNC_RC     = 3'b011; // CSRRC
  localparam logic [2:0] FNC_RSI    = 3'b110; // CSRRSI
  localparam logic [2:0] FNC_RCI    = 3'b111; // CSRRCI
  localparam logic [2:0] FNC_PRIV   = 3'b000; // ECALL / EBREAK (no operation on this core)
  // ===============================================

  // ***** Secondary function bit (bit 30 / funct7[5]) *****
  localparam logic       FNC2_ADD      = 1'b0;
  localparam logic       FNC2_SUB      = 1'b1;
  localparam logic       FNC2_SRL      = 1'b0;
  localparam logic       FNC2_SRA      = 1'b1;

  // ===============================================
  // Fence opcode:
  localparam logic [6:0] OPC_FENCE     = 7'b0001111;
  // ===============================================

  // ===============================================
  // Fence funct3 codes:
  localparam logic [2:0] FNC_FENCE     = 3'b000;
  localparam logic [2:0] FNC_FENCE_I   = 3'b001;
  // ===============================================

endpackage : opcode_pkg

`default_nettype wire
