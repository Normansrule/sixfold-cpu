// =============================================================================
// model/isa.js — THE single source of truth for the RV64IM + Zicsr instruction set.
//
// RV64IM + Zicsr + Zba + Zbb + Zbs (together Zba Zbb Zbs are the B extension, which every current RISC-V application core has)
// + Zknh (SHA-2 hash helpers) + one custom instruction, hsec.cteq -- the worked example in docs/learn/10_adding_instructions.md.
// Every other part of the repo derives from this table:
//   * model/asm.js        assembles text into machine code using `encode()`
//   * model/core.js       decodes machine code using `decode()`
//   * tools/rv.mjs      generates binary/ docs, opcode maps and SVG bit-fields
//   * src/*.sv (the RTL) is checked against it by `make test`
//
// Works unmodified in Node.js (ES modules) and in the browser.
// =============================================================================

// Major opcodes (bits [6:0] of every 32-bit instruction)
export const OPCODES = {
  LOAD:     0b0000011,
  MISC_MEM: 0b0001111,
  OP_IMM:   0b0010011,
  AUIPC:    0b0010111,
  OP_IMM_32:0b0011011,
  STORE:    0b0100011,
  OP:       0b0110011,
  LUI:      0b0110111,
  OP_32:    0b0111011,
  BRANCH:   0b1100011,
  JALR:     0b1100111,
  JAL:      0b1101111,
  SYSTEM:   0b1110011,
  CUSTOM_0: 0b0001011,   // reserved by the RISC-V spec for vendor extensions; used by hsec.cteq
};

// Instruction formats and their bit layouts (MSB first). Used for docs + SVG.
export const FORMATS = {
  R: [['funct7', 31, 25], ['rs2', 24, 20], ['rs1', 19, 15], ['funct3', 14, 12], ['rd', 11, 7], ['opcode', 6, 0]],
  I: [['imm[11:0]', 31, 20], ['rs1', 19, 15], ['funct3', 14, 12], ['rd', 11, 7], ['opcode', 6, 0]],
  'I-sh64': [['funct6', 31, 26], ['shamt[5:0]', 25, 20], ['rs1', 19, 15], ['funct3', 14, 12], ['rd', 11, 7], ['opcode', 6, 0]],
  'I-sh32': [['funct7', 31, 25], ['shamt[4:0]', 24, 20], ['rs1', 19, 15], ['funct3', 14, 12], ['rd', 11, 7], ['opcode', 6, 0]],
  'I-unary': [['funct12', 31, 20], ['rs1', 19, 15], ['funct3', 14, 12], ['rd', 11, 7], ['opcode', 6, 0]],
  S: [['imm[11:5]', 31, 25], ['rs2', 24, 20], ['rs1', 19, 15], ['funct3', 14, 12], ['imm[4:0]', 11, 7], ['opcode', 6, 0]],
  B: [['imm[12|10:5]', 31, 25], ['rs2', 24, 20], ['rs1', 19, 15], ['funct3', 14, 12], ['imm[4:1|11]', 11, 7], ['opcode', 6, 0]],
  U: [['imm[31:12]', 31, 12], ['rd', 11, 7], ['opcode', 6, 0]],
  J: [['imm[20|10:1|11|19:12]', 31, 12], ['rd', 11, 7], ['opcode', 6, 0]],
  SYS: [['funct12', 31, 20], ['rs1', 19, 15], ['funct3', 14, 12], ['rd', 11, 7], ['opcode', 6, 0]],
  CSR: [['csr', 31, 20], ['rs1', 19, 15], ['funct3', 14, 12], ['rd', 11, 7], ['opcode', 6, 0]],
  'CSR-I': [['csr', 31, 20], ['zimm[4:0]', 19, 15], ['funct3', 14, 12], ['rd', 11, 7], ['opcode', 6, 0]],
  FENCE: [['fm', 31, 28], ['pred', 27, 24], ['succ', 23, 20], ['rs1', 19, 15], ['funct3', 14, 12], ['rd', 11, 7], ['opcode', 6, 0]],
};

// syntax keys: how the assembler parses operands
//   rrr: rd, rs1, rs2      rri: rd, rs1, imm       load: rd, off(rs1)
//   store: rs2, off(rs1)   branch: rs1, rs2, label  ui: rd, imm20
//   jal: rd, label         jalr: rd, off(rs1)       none
//   rr: rd, rs1 (one source register, Zbb unary operations; funct7 holds the whole funct12)
const I = (name, fmt, opcode, funct3, funct7, syntax, ext, cls, desc, sem) =>
  ({ name, fmt, opcode, funct3, funct7, syntax, ext, cls, desc, sem });

const O = OPCODES;
export const INSTRUCTIONS = [
  // ---------------- RV32I / RV64I : upper immediates & jumps -----------------
  I('lui',   'U', O.LUI,   null, null, 'ui',  'RV64I', 'Upper immediate', 'Load Upper Immediate', 'rd = sext(imm20 << 12)'),
  I('auipc', 'U', O.AUIPC, null, null, 'ui',  'RV64I', 'Upper immediate', 'Add Upper Immediate to PC', 'rd = pc + sext(imm20 << 12)'),
  I('jal',   'J', O.JAL,   null, null, 'jal', 'RV64I', 'Jump', 'Jump And Link', 'rd = pc + 4; pc = pc + sext(imm)'),
  I('jalr',  'I', O.JALR,  0b000, null, 'jalr','RV64I', 'Jump', 'Jump And Link Register', 't = pc + 4; pc = (rs1 + sext(imm)) & ~1; rd = t'),
  // ---------------- branches ------------------------------------------------
  I('beq',  'B', O.BRANCH, 0b000, null, 'branch', 'RV64I', 'Branch', 'Branch if Equal', 'if (rs1 == rs2) pc += sext(imm)'),
  I('bne',  'B', O.BRANCH, 0b001, null, 'branch', 'RV64I', 'Branch', 'Branch if Not Equal', 'if (rs1 != rs2) pc += sext(imm)'),
  I('blt',  'B', O.BRANCH, 0b100, null, 'branch', 'RV64I', 'Branch', 'Branch if Less Than (signed)', 'if (rs1 <s rs2) pc += sext(imm)'),
  I('bge',  'B', O.BRANCH, 0b101, null, 'branch', 'RV64I', 'Branch', 'Branch if Greater or Equal (signed)', 'if (rs1 >=s rs2) pc += sext(imm)'),
  I('bltu', 'B', O.BRANCH, 0b110, null, 'branch', 'RV64I', 'Branch', 'Branch if Less Than Unsigned', 'if (rs1 <u rs2) pc += sext(imm)'),
  I('bgeu', 'B', O.BRANCH, 0b111, null, 'branch', 'RV64I', 'Branch', 'Branch if Greater or Equal Unsigned', 'if (rs1 >=u rs2) pc += sext(imm)'),
  // ---------------- loads ---------------------------------------------------
  I('lb',  'I', O.LOAD, 0b000, null, 'load', 'RV64I', 'Load', 'Load Byte (sign-extend)', 'rd = sext(M[rs1 + sext(imm)][7:0])'),
  I('lh',  'I', O.LOAD, 0b001, null, 'load', 'RV64I', 'Load', 'Load Halfword (sign-extend)', 'rd = sext(M[rs1 + sext(imm)][15:0])'),
  I('lw',  'I', O.LOAD, 0b010, null, 'load', 'RV64I', 'Load', 'Load Word (sign-extend)', 'rd = sext(M[rs1 + sext(imm)][31:0])'),
  I('ld',  'I', O.LOAD, 0b011, null, 'load', 'RV64I', 'Load', 'Load Doubleword', 'rd = M[rs1 + sext(imm)][63:0]'),
  I('lbu', 'I', O.LOAD, 0b100, null, 'load', 'RV64I', 'Load', 'Load Byte Unsigned (zero-extend)', 'rd = zext(M[rs1 + sext(imm)][7:0])'),
  I('lhu', 'I', O.LOAD, 0b101, null, 'load', 'RV64I', 'Load', 'Load Halfword Unsigned (zero-extend)', 'rd = zext(M[rs1 + sext(imm)][15:0])'),
  I('lwu', 'I', O.LOAD, 0b110, null, 'load', 'RV64I', 'Load', 'Load Word Unsigned (zero-extend)', 'rd = zext(M[rs1 + sext(imm)][31:0])'),
  // ---------------- stores --------------------------------------------------
  I('sb', 'S', O.STORE, 0b000, null, 'store', 'RV64I', 'Store', 'Store Byte', 'M[rs1 + sext(imm)][7:0] = rs2[7:0]'),
  I('sh', 'S', O.STORE, 0b001, null, 'store', 'RV64I', 'Store', 'Store Halfword', 'M[rs1 + sext(imm)][15:0] = rs2[15:0]'),
  I('sw', 'S', O.STORE, 0b010, null, 'store', 'RV64I', 'Store', 'Store Word', 'M[rs1 + sext(imm)][31:0] = rs2[31:0]'),
  I('sd', 'S', O.STORE, 0b011, null, 'store', 'RV64I', 'Store', 'Store Doubleword', 'M[rs1 + sext(imm)][63:0] = rs2'),
  // ---------------- integer register-immediate ------------------------------
  I('addi',  'I', O.OP_IMM, 0b000, null, 'rri', 'RV64I', 'Arithmetic (imm)', 'Add Immediate', 'rd = rs1 + sext(imm)'),
  I('slti',  'I', O.OP_IMM, 0b010, null, 'rri', 'RV64I', 'Compare (imm)', 'Set if Less Than Immediate (signed)', 'rd = (rs1 <s sext(imm)) ? 1 : 0'),
  I('sltiu', 'I', O.OP_IMM, 0b011, null, 'rri', 'RV64I', 'Compare (imm)', 'Set if Less Than Immediate Unsigned', 'rd = (rs1 <u sext(imm)) ? 1 : 0'),
  I('xori',  'I', O.OP_IMM, 0b100, null, 'rri', 'RV64I', 'Logic (imm)', 'Exclusive OR Immediate', 'rd = rs1 ^ sext(imm)'),
  I('ori',   'I', O.OP_IMM, 0b110, null, 'rri', 'RV64I', 'Logic (imm)', 'OR Immediate', 'rd = rs1 | sext(imm)'),
  I('andi',  'I', O.OP_IMM, 0b111, null, 'rri', 'RV64I', 'Logic (imm)', 'AND Immediate', 'rd = rs1 & sext(imm)'),
  I('slli',  'I-sh64', O.OP_IMM, 0b001, 0b000000, 'rri', 'RV64I', 'Shift (imm)', 'Shift Left Logical Immediate', 'rd = rs1 << shamt[5:0]'),
  I('srli',  'I-sh64', O.OP_IMM, 0b101, 0b000000, 'rri', 'RV64I', 'Shift (imm)', 'Shift Right Logical Immediate', 'rd = rs1 >>u shamt[5:0]'),
  I('srai',  'I-sh64', O.OP_IMM, 0b101, 0b010000, 'rri', 'RV64I', 'Shift (imm)', 'Shift Right Arithmetic Immediate', 'rd = rs1 >>s shamt[5:0]'),
  // ---------------- integer register-register -------------------------------
  I('add',  'R', O.OP, 0b000, 0b0000000, 'rrr', 'RV64I', 'Arithmetic', 'Add', 'rd = rs1 + rs2'),
  I('sub',  'R', O.OP, 0b000, 0b0100000, 'rrr', 'RV64I', 'Arithmetic', 'Subtract', 'rd = rs1 - rs2'),
  I('sll',  'R', O.OP, 0b001, 0b0000000, 'rrr', 'RV64I', 'Shift', 'Shift Left Logical', 'rd = rs1 << rs2[5:0]'),
  I('slt',  'R', O.OP, 0b010, 0b0000000, 'rrr', 'RV64I', 'Compare', 'Set if Less Than (signed)', 'rd = (rs1 <s rs2) ? 1 : 0'),
  I('sltu', 'R', O.OP, 0b011, 0b0000000, 'rrr', 'RV64I', 'Compare', 'Set if Less Than Unsigned', 'rd = (rs1 <u rs2) ? 1 : 0'),
  I('xor',  'R', O.OP, 0b100, 0b0000000, 'rrr', 'RV64I', 'Logic', 'Exclusive OR', 'rd = rs1 ^ rs2'),
  I('srl',  'R', O.OP, 0b101, 0b0000000, 'rrr', 'RV64I', 'Shift', 'Shift Right Logical', 'rd = rs1 >>u rs2[5:0]'),
  I('sra',  'R', O.OP, 0b101, 0b0100000, 'rrr', 'RV64I', 'Shift', 'Shift Right Arithmetic', 'rd = rs1 >>s rs2[5:0]'),
  I('or',   'R', O.OP, 0b110, 0b0000000, 'rrr', 'RV64I', 'Logic', 'OR', 'rd = rs1 | rs2'),
  I('and',  'R', O.OP, 0b111, 0b0000000, 'rrr', 'RV64I', 'Logic', 'AND', 'rd = rs1 & rs2'),
  // ---------------- RV64I-only 32-bit "word" operations ---------------------
  I('addiw', 'I', O.OP_IMM_32, 0b000, null, 'rri', 'RV64I', 'Word (32-bit)', 'Add Immediate Word', 'rd = sext((rs1 + sext(imm))[31:0])'),
  I('slliw', 'I-sh32', O.OP_IMM_32, 0b001, 0b0000000, 'rri', 'RV64I', 'Word (32-bit)', 'Shift Left Logical Immediate Word', 'rd = sext((rs1[31:0] << shamt[4:0])[31:0])'),
  I('srliw', 'I-sh32', O.OP_IMM_32, 0b101, 0b0000000, 'rri', 'RV64I', 'Word (32-bit)', 'Shift Right Logical Immediate Word', 'rd = sext(rs1[31:0] >>u shamt[4:0])'),
  I('sraiw', 'I-sh32', O.OP_IMM_32, 0b101, 0b0100000, 'rri', 'RV64I', 'Word (32-bit)', 'Shift Right Arithmetic Immediate Word', 'rd = sext(rs1[31:0] >>s shamt[4:0])'),
  I('addw',  'R', O.OP_32, 0b000, 0b0000000, 'rrr', 'RV64I', 'Word (32-bit)', 'Add Word', 'rd = sext((rs1 + rs2)[31:0])'),
  I('subw',  'R', O.OP_32, 0b000, 0b0100000, 'rrr', 'RV64I', 'Word (32-bit)', 'Subtract Word', 'rd = sext((rs1 - rs2)[31:0])'),
  I('sllw',  'R', O.OP_32, 0b001, 0b0000000, 'rrr', 'RV64I', 'Word (32-bit)', 'Shift Left Logical Word', 'rd = sext((rs1[31:0] << rs2[4:0])[31:0])'),
  I('srlw',  'R', O.OP_32, 0b101, 0b0000000, 'rrr', 'RV64I', 'Word (32-bit)', 'Shift Right Logical Word', 'rd = sext(rs1[31:0] >>u rs2[4:0])'),
  I('sraw',  'R', O.OP_32, 0b101, 0b0100000, 'rrr', 'RV64I', 'Word (32-bit)', 'Shift Right Arithmetic Word', 'rd = sext(rs1[31:0] >>s rs2[4:0])'),
  // ---------------- memory ordering & system --------------------------------
  I('fence',  'FENCE', O.MISC_MEM, 0b000, null, 'none', 'RV64I', 'System', 'Memory Fence', 'order memory accesses (a no-op on this in-order core)'),
  I('ecall',  'SYS', O.SYSTEM, 0b000, null, 'none', 'RV64I', 'System', 'Environment Call', 'trap: mepc = pc, mcause = 11, jump to mtvec (a system call)'),
  I('ebreak', 'SYS', O.SYSTEM, 0b000, null, 'none', 'RV64I', 'System', 'Environment Breakpoint', 'trap: mepc = pc, mcause = 3, jump to mtvec (a breakpoint)'),
  I('mret',   'SYS', O.SYSTEM, 0b000, null, 'none', 'Priv', 'System', 'Machine-mode Return', 'return from a trap: pc = mepc, mstatus.MIE = mstatus.MPIE'),
  I('wfi',    'SYS', O.SYSTEM, 0b000, null, 'none', 'Priv', 'System', 'Wait For Interrupt', 'a hint that nothing is left to do until an interrupt: Sixfold simply continues (a nop), so it sits in a loop'),
  // ---------------- Zicsr: control and status registers ---------------------
  I('csrrw',  'CSR',   O.SYSTEM, 0b001, null, 'csr',  'Zicsr', 'CSR', 'CSR Read and Write', 't = CSR[csr]; CSR[csr] = rs1; rd = t'),
  I('csrrs',  'CSR',   O.SYSTEM, 0b010, null, 'csr',  'Zicsr', 'CSR', 'CSR Read and Set bits', 't = CSR[csr]; if (rs1 != x0) CSR[csr] = t | rs1; rd = t'),
  I('csrrc',  'CSR',   O.SYSTEM, 0b011, null, 'csr',  'Zicsr', 'CSR', 'CSR Read and Clear bits', 't = CSR[csr]; if (rs1 != x0) CSR[csr] = t & ~rs1; rd = t'),
  I('csrrwi', 'CSR-I', O.SYSTEM, 0b101, null, 'csri', 'Zicsr', 'CSR', 'CSR Read and Write Immediate', 't = CSR[csr]; CSR[csr] = zimm; rd = t'),
  I('csrrsi', 'CSR-I', O.SYSTEM, 0b110, null, 'csri', 'Zicsr', 'CSR', 'CSR Read and Set bits Immediate', 't = CSR[csr]; if (zimm != 0) CSR[csr] = t | zimm; rd = t'),
  I('csrrci', 'CSR-I', O.SYSTEM, 0b111, null, 'csri', 'Zicsr', 'CSR', 'CSR Read and Clear bits Immediate', 't = CSR[csr]; if (zimm != 0) CSR[csr] = t & ~zimm; rd = t'),
  // ---------------- M extension: multiply / divide --------------------------
  I('mul',    'R', O.OP, 0b000, 0b0000001, 'rrr', 'RV64M', 'Multiply', 'Multiply (low 64 bits)', 'rd = (rs1 * rs2)[63:0]'),
  I('mulh',   'R', O.OP, 0b001, 0b0000001, 'rrr', 'RV64M', 'Multiply', 'Multiply High (signed x signed)', 'rd = (sext(rs1) * sext(rs2))[127:64]'),
  I('mulhsu', 'R', O.OP, 0b010, 0b0000001, 'rrr', 'RV64M', 'Multiply', 'Multiply High (signed x unsigned)', 'rd = (sext(rs1) * zext(rs2))[127:64]'),
  I('mulhu',  'R', O.OP, 0b011, 0b0000001, 'rrr', 'RV64M', 'Multiply', 'Multiply High (unsigned x unsigned)', 'rd = (zext(rs1) * zext(rs2))[127:64]'),
  I('div',    'R', O.OP, 0b100, 0b0000001, 'rrr', 'RV64M', 'Divide', 'Divide (signed)', 'rd = rs1 /s rs2  (x/0 = -1, MIN/-1 = MIN)'),
  I('divu',   'R', O.OP, 0b101, 0b0000001, 'rrr', 'RV64M', 'Divide', 'Divide Unsigned', 'rd = rs1 /u rs2  (x/0 = 2^64-1)'),
  I('rem',    'R', O.OP, 0b110, 0b0000001, 'rrr', 'RV64M', 'Divide', 'Remainder (signed)', 'rd = rs1 %s rs2  (x%0 = x, MIN%-1 = 0)'),
  I('remu',   'R', O.OP, 0b111, 0b0000001, 'rrr', 'RV64M', 'Divide', 'Remainder Unsigned', 'rd = rs1 %u rs2  (x%0 = x)'),
  I('mulw',   'R', O.OP_32, 0b000, 0b0000001, 'rrr', 'RV64M', 'Multiply', 'Multiply Word', 'rd = sext((rs1 * rs2)[31:0])'),
  I('divw',   'R', O.OP_32, 0b100, 0b0000001, 'rrr', 'RV64M', 'Divide', 'Divide Word (signed)', 'rd = sext(rs1[31:0] /s rs2[31:0])'),
  I('divuw',  'R', O.OP_32, 0b101, 0b0000001, 'rrr', 'RV64M', 'Divide', 'Divide Word Unsigned', 'rd = sext(rs1[31:0] /u rs2[31:0])'),
  I('remw',   'R', O.OP_32, 0b110, 0b0000001, 'rrr', 'RV64M', 'Divide', 'Remainder Word (signed)', 'rd = sext(rs1[31:0] %s rs2[31:0])'),
  I('remuw',  'R', O.OP_32, 0b111, 0b0000001, 'rrr', 'RV64M', 'Divide', 'Remainder Word Unsigned', 'rd = sext(rs1[31:0] %u rs2[31:0])'),
  // ---------------- Zba: address generation (array indexing in one instruction) ----------
  I('sh1add',    'R', O.OP,    0b010, 0b0010000, 'rrr', 'Zba', 'Address generation', 'Shift left by 1 and Add', 'rd = rs2 + (rs1 << 1)'),
  I('sh2add',    'R', O.OP,    0b100, 0b0010000, 'rrr', 'Zba', 'Address generation', 'Shift left by 2 and Add', 'rd = rs2 + (rs1 << 2)'),
  I('sh3add',    'R', O.OP,    0b110, 0b0010000, 'rrr', 'Zba', 'Address generation', 'Shift left by 3 and Add', 'rd = rs2 + (rs1 << 3)'),
  I('add.uw',    'R', O.OP_32, 0b000, 0b0000100, 'rrr', 'Zba', 'Address generation', 'Add Unsigned Word', 'rd = rs2 + zext(rs1[31:0])'),
  I('sh1add.uw', 'R', O.OP_32, 0b010, 0b0010000, 'rrr', 'Zba', 'Address generation', 'Shift Unsigned Word left by 1 and Add', 'rd = rs2 + (zext(rs1[31:0]) << 1)'),
  I('sh2add.uw', 'R', O.OP_32, 0b100, 0b0010000, 'rrr', 'Zba', 'Address generation', 'Shift Unsigned Word left by 2 and Add', 'rd = rs2 + (zext(rs1[31:0]) << 2)'),
  I('sh3add.uw', 'R', O.OP_32, 0b110, 0b0010000, 'rrr', 'Zba', 'Address generation', 'Shift Unsigned Word left by 3 and Add', 'rd = rs2 + (zext(rs1[31:0]) << 3)'),
  I('slli.uw',   'I-sh64', O.OP_IMM_32, 0b001, 0b000010, 'rri', 'Zba', 'Address generation', 'Shift Left Logical Immediate Unsigned Word', 'rd = zext(rs1[31:0]) << shamt[5:0]'),
  // ---------------- Zbb: basic bit manipulation --------------------------------------------
  I('andn',  'R', O.OP, 0b111, 0b0100000, 'rrr', 'Zbb', 'Bit manipulation', 'AND with inverted operand', 'rd = rs1 & ~rs2'),
  I('orn',   'R', O.OP, 0b110, 0b0100000, 'rrr', 'Zbb', 'Bit manipulation', 'OR with inverted operand', 'rd = rs1 | ~rs2'),
  I('xnor',  'R', O.OP, 0b100, 0b0100000, 'rrr', 'Zbb', 'Bit manipulation', 'Exclusive NOR', 'rd = ~(rs1 ^ rs2)'),
  I('min',   'R', O.OP, 0b100, 0b0000101, 'rrr', 'Zbb', 'Bit manipulation', 'Minimum (signed)', 'rd = (rs1 <s rs2) ? rs1 : rs2'),
  I('minu',  'R', O.OP, 0b101, 0b0000101, 'rrr', 'Zbb', 'Bit manipulation', 'Minimum Unsigned', 'rd = (rs1 <u rs2) ? rs1 : rs2'),
  I('max',   'R', O.OP, 0b110, 0b0000101, 'rrr', 'Zbb', 'Bit manipulation', 'Maximum (signed)', 'rd = (rs1 <s rs2) ? rs2 : rs1'),
  I('maxu',  'R', O.OP, 0b111, 0b0000101, 'rrr', 'Zbb', 'Bit manipulation', 'Maximum Unsigned', 'rd = (rs1 <u rs2) ? rs2 : rs1'),
  I('rol',   'R', O.OP, 0b001, 0b0110000, 'rrr', 'Zbb', 'Bit manipulation', 'Rotate Left', 'rd = (rs1 << rs2[5:0]) | (rs1 >>u (64 - rs2[5:0]))'),
  I('ror',   'R', O.OP, 0b101, 0b0110000, 'rrr', 'Zbb', 'Bit manipulation', 'Rotate Right', 'rd = (rs1 >>u rs2[5:0]) | (rs1 << (64 - rs2[5:0]))'),
  I('rori',  'I-sh64', O.OP_IMM, 0b101, 0b011000, 'rri', 'Zbb', 'Bit manipulation', 'Rotate Right Immediate', 'rd = (rs1 >>u shamt) | (rs1 << (64 - shamt))'),
  I('rolw',  'R', O.OP_32, 0b001, 0b0110000, 'rrr', 'Zbb', 'Bit manipulation', 'Rotate Left Word', 'rd = sext(rotate_left(rs1[31:0], rs2[4:0]))'),
  I('rorw',  'R', O.OP_32, 0b101, 0b0110000, 'rrr', 'Zbb', 'Bit manipulation', 'Rotate Right Word', 'rd = sext(rotate_right(rs1[31:0], rs2[4:0]))'),
  I('roriw', 'I-sh32', O.OP_IMM_32, 0b101, 0b0110000, 'rri', 'Zbb', 'Bit manipulation', 'Rotate Right Immediate Word', 'rd = sext(rotate_right(rs1[31:0], shamt[4:0]))'),
  I('clz',    'I-unary', O.OP_IMM,    0b001, 0x600, 'rr', 'Zbb', 'Bit manipulation', 'Count Leading Zeros', 'rd = number of 0 bits above the highest 1 (64 if rs1 = 0)'),
  I('ctz',    'I-unary', O.OP_IMM,    0b001, 0x601, 'rr', 'Zbb', 'Bit manipulation', 'Count Trailing Zeros', 'rd = number of 0 bits below the lowest 1 (64 if rs1 = 0)'),
  I('cpop',   'I-unary', O.OP_IMM,    0b001, 0x602, 'rr', 'Zbb', 'Bit manipulation', 'Count Population (set bits)', 'rd = number of 1 bits in rs1'),
  I('clzw',   'I-unary', O.OP_IMM_32, 0b001, 0x600, 'rr', 'Zbb', 'Bit manipulation', 'Count Leading Zeros Word', 'rd = leading zeros of rs1[31:0] (32 if zero)'),
  I('ctzw',   'I-unary', O.OP_IMM_32, 0b001, 0x601, 'rr', 'Zbb', 'Bit manipulation', 'Count Trailing Zeros Word', 'rd = trailing zeros of rs1[31:0] (32 if zero)'),
  I('cpopw',  'I-unary', O.OP_IMM_32, 0b001, 0x602, 'rr', 'Zbb', 'Bit manipulation', 'Count Population Word', 'rd = number of 1 bits in rs1[31:0]'),
  I('sext.b', 'I-unary', O.OP_IMM,    0b001, 0x604, 'rr', 'Zbb', 'Bit manipulation', 'Sign-extend Byte', 'rd = sext(rs1[7:0])'),
  I('sext.h', 'I-unary', O.OP_IMM,    0b001, 0x605, 'rr', 'Zbb', 'Bit manipulation', 'Sign-extend Halfword', 'rd = sext(rs1[15:0])'),
  I('zext.h', 'I-unary', O.OP_32,     0b100, 0x080, 'rr', 'Zbb', 'Bit manipulation', 'Zero-extend Halfword', 'rd = zext(rs1[15:0])'),
  I('rev8',   'I-unary', O.OP_IMM,    0b101, 0x6B8, 'rr', 'Zbb', 'Bit manipulation', 'Reverse byte order', 'rd = the 8 bytes of rs1 in reverse order (endianness swap)'),
  I('orc.b',  'I-unary', O.OP_IMM,    0b101, 0x287, 'rr', 'Zbb', 'Bit manipulation', 'OR-Combine each Byte', 'rd byte i = (rs1 byte i != 0) ? 0xFF : 0x00 (finds the 0 byte ending a string)'),
  // ---------------- Zbs: single-bit instructions ------------------------------------------
  I('bset',  'R', O.OP, 0b001, 0b0010100, 'rrr', 'Zbs', 'Single-bit', 'Bit Set', 'rd = rs1 | (1 << rs2[5:0])'),
  I('bclr',  'R', O.OP, 0b001, 0b0100100, 'rrr', 'Zbs', 'Single-bit', 'Bit Clear', 'rd = rs1 & ~(1 << rs2[5:0])'),
  I('binv',  'R', O.OP, 0b001, 0b0110100, 'rrr', 'Zbs', 'Single-bit', 'Bit Invert', 'rd = rs1 ^ (1 << rs2[5:0])'),
  I('bext',  'R', O.OP, 0b101, 0b0100100, 'rrr', 'Zbs', 'Single-bit', 'Bit Extract', 'rd = (rs1 >> rs2[5:0]) & 1'),
  I('bseti', 'I-sh64', O.OP_IMM, 0b001, 0b001010, 'rri', 'Zbs', 'Single-bit', 'Bit Set Immediate', 'rd = rs1 | (1 << shamt)'),
  I('bclri', 'I-sh64', O.OP_IMM, 0b001, 0b010010, 'rri', 'Zbs', 'Single-bit', 'Bit Clear Immediate', 'rd = rs1 & ~(1 << shamt)'),
  I('binvi', 'I-sh64', O.OP_IMM, 0b001, 0b011010, 'rri', 'Zbs', 'Single-bit', 'Bit Invert Immediate', 'rd = rs1 ^ (1 << shamt)'),
  I('bexti', 'I-sh64', O.OP_IMM, 0b101, 0b010010, 'rri', 'Zbs', 'Single-bit', 'Bit Extract Immediate', 'rd = (rs1 >> shamt) & 1'),
  // ---------------- Zknh: SHA-2 hash helpers (scalar cryptography) ---------------------------
  I('sha256sum0', 'I-unary', O.OP_IMM, 0b001, 0x100, 'rr', 'Zknh', 'Cryptography', 'SHA-256 Sum0 (big sigma 0)', 'rd = sext(ror32(rs1,2) ^ ror32(rs1,13) ^ ror32(rs1,22))'),
  I('sha256sum1', 'I-unary', O.OP_IMM, 0b001, 0x101, 'rr', 'Zknh', 'Cryptography', 'SHA-256 Sum1 (big sigma 1)', 'rd = sext(ror32(rs1,6) ^ ror32(rs1,11) ^ ror32(rs1,25))'),
  I('sha256sig0', 'I-unary', O.OP_IMM, 0b001, 0x102, 'rr', 'Zknh', 'Cryptography', 'SHA-256 sigma0 (message schedule)', 'rd = sext(ror32(rs1,7) ^ ror32(rs1,18) ^ (rs1[31:0] >>u 3))'),
  I('sha256sig1', 'I-unary', O.OP_IMM, 0b001, 0x103, 'rr', 'Zknh', 'Cryptography', 'SHA-256 sigma1 (message schedule)', 'rd = sext(ror32(rs1,17) ^ ror32(rs1,19) ^ (rs1[31:0] >>u 10))'),
  I('sha512sum0', 'I-unary', O.OP_IMM, 0b001, 0x104, 'rr', 'Zknh', 'Cryptography', 'SHA-512 Sum0 (big sigma 0)', 'rd = ror(rs1,28) ^ ror(rs1,34) ^ ror(rs1,39)'),
  I('sha512sum1', 'I-unary', O.OP_IMM, 0b001, 0x105, 'rr', 'Zknh', 'Cryptography', 'SHA-512 Sum1 (big sigma 1)', 'rd = ror(rs1,14) ^ ror(rs1,18) ^ ror(rs1,41)'),
  I('sha512sig0', 'I-unary', O.OP_IMM, 0b001, 0x106, 'rr', 'Zknh', 'Cryptography', 'SHA-512 sigma0 (message schedule)', 'rd = ror(rs1,1) ^ ror(rs1,8) ^ (rs1 >>u 7)'),
  I('sha512sig1', 'I-unary', O.OP_IMM, 0b001, 0x107, 'rr', 'Zknh', 'Cryptography', 'SHA-512 sigma1 (message schedule)', 'rd = ror(rs1,19) ^ ror(rs1,61) ^ (rs1 >>u 6)'),
  // ---------------- Xhydrasec: a custom instruction (see docs/learn/10_adding_instructions.md) --------
  I('hsec.cteq', 'R', O.CUSTOM_0, 0b110, 0b0000000, 'rrr', 'Xhydrasec', 'Cryptography', 'Constant-time Equal', 'rd = (rs1 == rs2) ? 1 : 0, in one cycle whatever the operands (no early exit)'),
];

export const BY_NAME = Object.fromEntries(INSTRUCTIONS.map(i => [i.name, i]));

// CSR names understood by the assembler (addresses match src/const_pkg.sv)
export const CSR_NAMES = { tohost: 0x51E, status: 0x50A, hartid: 0x50B, cycle: 0xC00, instret: 0xC02, mhartid: 0xF14,
  mstatus: 0x300, mtvec: 0x305, mscratch: 0x340, mepc: 0x341, mcause: 0x342,
  mie: 0x304, mip: 0x344,
  hpmcounter3: 0xC03, hpmcounter4: 0xC04, hpmcounter5: 0xC05, hpmcounter6: 0xC06, hpmcounter7: 0xC07, hpmcounter8: 0xC08, hpmcounter9: 0xC09 };
export const CSR_BY_ADDRESS = Object.fromEntries(Object.entries(CSR_NAMES).map(([k, v]) => [v, k]));

// ABI register names
export const ABI = ['zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1',
  'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7',
  's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6'];

export function regNum(tok) {
  const t = tok.trim().toLowerCase();
  if (/^x([0-9]|[12][0-9]|3[01])$/.test(t)) return parseInt(t.slice(1), 10);
  if (t === 'fp') return 8;
  const i = ABI.indexOf(t);
  if (i < 0) throw new Error(`unknown register "${tok}"`);
  return i;
}

const u32 = x => x >>> 0;
const bits = (v, hi, lo) => (v >>> lo) & ((1 << (hi - lo + 1)) - 1);
function checkRange(v, lo, hi, what) {
  if (v < lo || v > hi) throw new Error(`${what} ${v} out of range [${lo}, ${hi}]`);
}

// encode(name, {rd, rs1, rs2, imm}) -> 32-bit unsigned machine word
export function encode(name, f) {
  const d = BY_NAME[name];
  if (!d) throw new Error(`unknown instruction "${name}"`);
  const rd = f.rd | 0, rs1 = f.rs1 | 0, rs2 = f.rs2 | 0;
  let imm = f.imm === undefined ? 0 : Number(f.imm);
  const op = d.opcode, f3 = d.funct3 ?? 0;
  switch (d.fmt) {
    case 'R':
      return u32((d.funct7 << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op);
    case 'I':
      checkRange(imm, -2048, 2047, `${name} immediate`);
      return u32(((imm & 0xfff) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op);
    case 'I-sh64':
      checkRange(imm, 0, 63, `${name} shift amount`);
      return u32((d.funct7 << 26) | (imm << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op);
    case 'I-sh32':
      checkRange(imm, 0, 31, `${name} shift amount`);
      return u32((d.funct7 << 25) | (imm << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op);
    case 'S':
      checkRange(imm, -2048, 2047, `${name} offset`);
      return u32((bits(imm, 11, 5) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (bits(imm, 4, 0) << 7) | op);
    case 'B':
      checkRange(imm, -4096, 4094, `${name} branch offset`);
      if (imm & 1) throw new Error(`${name} branch offset must be even`);
      return u32((bits(imm, 12, 12) << 31) | (bits(imm, 10, 5) << 25) | (rs2 << 20) | (rs1 << 15) |
        (f3 << 12) | (bits(imm, 4, 1) << 8) | (bits(imm, 11, 11) << 7) | op);
    case 'U':
      checkRange(imm, -(1 << 19), (1 << 20) - 1, `${name} upper immediate`);
      return u32(((imm & 0xfffff) << 12) | (rd << 7) | op);
    case 'J':
      checkRange(imm, -(1 << 20), (1 << 20) - 2, `${name} jump offset`);
      if (imm & 1) throw new Error(`${name} jump offset must be even`);
      return u32((bits(imm, 20, 20) << 31) | (bits(imm, 10, 1) << 21) | (bits(imm, 11, 11) << 20) |
        (bits(imm, 19, 12) << 12) | (rd << 7) | op);
    case 'I-unary':
      return u32((d.funct7 << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op);
    case 'SYS':
      return u32(({ ecall: 0, ebreak: 1, mret: 0x302, wfi: 0x105 }[name] << 20) | op);
    case 'CSR': case 'CSR-I':
      checkRange(imm, 0, 4095, `${name} CSR address`);
      checkRange(rs1, 0, 31, `${name} ${d.fmt === 'CSR' ? 'rs1' : 'immediate'}`);
      return u32((imm << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op);
    case 'FENCE':
      return u32((0b0000 << 28) | (0b1111 << 24) | (0b1111 << 20) | op); // fence iorw, iorw
  }
  throw new Error(`cannot encode format ${d.fmt}`);
}

const sext = (v, n) => (v << (32 - n)) >> (32 - n);

// decode(word) -> {name, fmt, rd, rs1, rs2, imm, def} or {name:'illegal'}
export function decode(word) {
  const w = word >>> 0;
  const op = w & 0x7f, rd = bits(w, 11, 7), f3 = bits(w, 14, 12), rs1 = bits(w, 19, 15),
    rs2 = bits(w, 24, 20), f7 = bits(w, 31, 25), f6 = bits(w, 31, 26);
  let def = null;
  for (const d of INSTRUCTIONS) {
    if (d.opcode !== op) continue;
    if (d.funct3 !== null && d.funct3 !== f3) continue;
    if (d.fmt === 'R' && d.funct7 !== f7) continue;
    if (d.fmt === 'I-sh64' && d.funct7 !== f6) continue;
    if (d.fmt === 'I-sh32' && d.funct7 !== f7) continue;
    if (d.fmt === 'I-unary' && d.funct7 !== bits(w, 31, 20)) continue;
    if (d.fmt === 'SYS') {
      if (rd !== 0 || rs1 !== 0 || f3 !== 0) continue;
      const f12 = bits(w, 31, 20);
      if ({ ecall: 0, ebreak: 1, mret: 0x302, wfi: 0x105 }[d.name] !== f12) continue;
    }
    def = d; break;
  }
  if (!def) return { name: 'illegal', fmt: '?', rd: 0, rs1: 0, rs2: 0, imm: 0, def: null, word: w };
  let imm = 0;
  switch (def.fmt) {
    case 'I': imm = sext(bits(w, 31, 20), 12); break;
    case 'I-sh64': imm = bits(w, 25, 20); break;
    case 'I-sh32': imm = bits(w, 24, 20); break;
    case 'S': imm = sext((bits(w, 31, 25) << 5) | bits(w, 11, 7), 12); break;
    case 'B': imm = sext((bits(w, 31, 31) << 12) | (bits(w, 7, 7) << 11) | (bits(w, 30, 25) << 5) | (bits(w, 11, 8) << 1), 13); break;
    case 'U': imm = bits(w, 31, 12); break;
    case 'J': imm = sext((bits(w, 31, 31) << 20) | (bits(w, 19, 12) << 12) | (bits(w, 20, 20) << 11) | (bits(w, 30, 21) << 1), 21); break;
    case 'CSR': case 'CSR-I': imm = bits(w, 31, 20); break;
  }
  return { name: def.name, fmt: def.fmt, rd, rs1, rs2, imm, def, word: w };
}

// Which source registers an instruction actually reads. The hazard unit in
// The model in model/core.js uses it to tell real load stalls from false ones.
export function usesRegs(d) {
  if (!d.def) return { rs1: false, rs2: false, rd: false };
  const s = d.def.syntax;
  return {
    rs1: ['rrr', 'rri', 'rr', 'load', 'store', 'branch', 'jalr', 'csr'].includes(s),
    rs2: ['rrr', 'store', 'branch'].includes(s),
    rd: ['rrr', 'rri', 'rr', 'load', 'ui', 'jal', 'jalr', 'csr', 'csri'].includes(s),
  };
}

export function disasm(d, pc = null) {
  if (!d.def) return `illegal 0x${(d.word >>> 0).toString(16).padStart(8, '0')}`;
  const r = n => ABI[n];
  const n = d.name;
  switch (d.def.syntax) {
    case 'rrr': return `${n} ${r(d.rd)}, ${r(d.rs1)}, ${r(d.rs2)}`;
    case 'rri': return `${n} ${r(d.rd)}, ${r(d.rs1)}, ${d.imm}`;
    case 'rr': return `${n} ${r(d.rd)}, ${r(d.rs1)}`;
    case 'load': return `${n} ${r(d.rd)}, ${d.imm}(${r(d.rs1)})`;
    case 'store': return `${n} ${r(d.rs2)}, ${d.imm}(${r(d.rs1)})`;
    case 'branch': return `${n} ${r(d.rs1)}, ${r(d.rs2)}, ${pc !== null ? '0x' + (pc + d.imm).toString(16) : d.imm}`;
    case 'ui': return `${n} ${r(d.rd)}, 0x${d.imm.toString(16)}`;
    case 'jal': return `${n} ${r(d.rd)}, ${pc !== null ? '0x' + (pc + d.imm).toString(16) : d.imm}`;
    case 'jalr': return `${n} ${r(d.rd)}, ${d.imm}(${r(d.rs1)})`;
    case 'csr': return `${n} ${r(d.rd)}, ${CSR_BY_ADDRESS[d.imm] || '0x' + d.imm.toString(16)}, ${r(d.rs1)}`;
    case 'csri': return `${n} ${r(d.rd)}, ${CSR_BY_ADDRESS[d.imm] || '0x' + d.imm.toString(16)}, ${d.rs1}`;
    default: return n;
  }
}
