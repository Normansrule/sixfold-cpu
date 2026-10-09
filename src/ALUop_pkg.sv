`default_nettype none

package alu_op_pkg;
  typedef enum logic [5:0] {
    ALU_ADD    = 6'd0,
    ALU_SUB    = 6'd1,
    ALU_AND    = 6'd2,
    ALU_OR     = 6'd3,
    ALU_XOR    = 6'd4,
    ALU_SLT    = 6'd5,
    ALU_SLTU   = 6'd6,
    ALU_SLL    = 6'd7,
    ALU_SRA    = 6'd8,
    ALU_SRL    = 6'd9,
    ALU_COPY_B = 6'd10,
    ALU_CSR    = 6'd11, // Added for CSR instructions
    ALU_JALR   = 6'd12, // Added for JALR instruction
    // ===============================================
    // M extension: handled by the Multiply Divide Unit next to the ALU
    ALU_MUL    = 6'd16,
    ALU_MULH   = 6'd17,
    ALU_MULHSU = 6'd18,
    ALU_MULHU  = 6'd19,
    ALU_DIV    = 6'd20,
    ALU_DIVU   = 6'd21,
    ALU_REM    = 6'd22,
    ALU_REMU   = 6'd23,
    // ===============================================
    // Zbb: bit manipulation
    ALU_MIN    = 6'd32,
    ALU_MINU   = 6'd33,
    ALU_MAX    = 6'd34,
    ALU_MAXU   = 6'd35,
    ALU_CLZ    = 6'd36, // count leading zeros (clz, clzw)
    ALU_CTZ    = 6'd37, // count trailing zeros (ctz, ctzw)
    ALU_CPOP   = 6'd38, // count set bits (cpop, cpopw)
    ALU_ROL    = 6'd39,
    ALU_ROR    = 6'd40,
    ALU_SEXT_B = 6'd41,
    ALU_SEXT_H = 6'd42,
    ALU_ZEXT_H = 6'd43,
    ALU_REV8   = 6'd44, // byte reverse
    ALU_ORC_B  = 6'd45, // OR-combine each byte
    ALU_BEXT   = 6'd46, // Zbs: extract bit rs2[5:0] (bset / bclr / binv are OR / AND / XOR with a prepared operand)
    // Zknh (ratified, Scalar Cryptography): the SHA-2 sigma and sum functions, one per instruction.
    // See docs/learn/10_adding_instructions.md -- these are the worked example of adding an extension.
    ALU_SHA256SUM0 = 6'd47,
    ALU_SHA256SUM1 = 6'd48,
    ALU_SHA256SIG0 = 6'd49,
    ALU_SHA256SIG1 = 6'd50,
    ALU_SHA512SUM0 = 6'd51,
    ALU_SHA512SUM1 = 6'd52,
    ALU_SHA512SIG0 = 6'd53,
    ALU_SHA512SIG1 = 6'd54,
    // Custom (custom-0 opcode): constant-time equality, the worked example of inventing an instruction
    ALU_CTEQ   = 6'd55,
    // (Zba needs no new operation: shNadd and .uw are an ADD or SLL with operand A prepared in DECODE,
    //  andn / orn / xnor are AND / OR / XOR with operand B inverted in DECODE)
    // ===============================================
    ALU_XXX    = 6'd63
  } alu_op_t;
endpackage : alu_op_pkg

`default_nettype wire
