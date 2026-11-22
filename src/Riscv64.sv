`default_nettype none

import const_pkg::*;
import opcode_pkg::*;
import immediate_op_pkg::*;
import alu_op_pkg::*;
import writeback_op_pkg::*;

// =====================================================================================================
// Riscv64: the core of Sixfold. A 6 stage, in-order, single issue RV64IM + Zicsr core,
//
// 6 Stage Datapath:
//   Fetch1 (GSharePredictor)                                                    ->
//   Fetch2 (predecode: redirect predicted-taken branches and every JAL)         ->
//   Decode (RegisterFile, ControlUnit, ImmediateGenerator, forwarding muxes)    ->
//   Execute (ALU, MultiplyDivideUnit, BranchComparator, BranchControl, StoreControl, CSRFile) ->
//   Memory (LoadControl, WriteControl)                                          ->
//   Writeback (RegisterFile write port)
//
// Hazards:
//   Data Hazard    : forwarded INTO DECODE from Execute, Memory and Writeback (priority: nearest first)
//   Load Hazard    : a load in Execute has no data yet -> hold Fetch1/Fetch2/Decode one cycle, NOP into Execute
//   Control Hazard : Fetch2 redirects predicted-taken branches and JALs (1 bubble); Execute flushes
//                    Fetch1, Fetch2 and Decode on a wrong prediction or any JALR (3 bubbles)
//
// model/core.js is a cycle-exact software twin of this file; `make test` compares them every cycle.
// =====================================================================================================
module Riscv64 #(
  parameter int GSHARE_HISTORY_BITS = 6, // 64 counters (the baseline build uses 4 = 16 counters)
  // ===== Performance edition features (all 0 = the baseline build) =====
  parameter bit BTB_ENABLE = 1'b1, // Branch Target Buffer: taken branches and JALs redirect in FETCH1 with 0 bubbles
  parameter bit RAS_ENABLE = 1'b1, // Return Address Stack: returns redirect in FETCH2 (1 bubble instead of a 3 bubble flush)
  parameter bit PRECISE_LOAD_STALL = 1'b1, // LOAD_STALL only for registers an instruction really reads
  parameter bit ITERATIVE_MULTIPLY_DIVIDE = 1'b1, // Multi-cycle M extension (short clock) instead of a single huge cycle
  parameter bit TOURNAMENT_PREDICTOR = 1'b1, // Per-branch history table + chooser alongside GShare
  // ===== Turbo edition features (all 0 = the performance edition, unchanged) =====
  parameter bit FAST_MULTIPLY_DIVIDE = 1'b0, // M unit: no PREPARE cycle, radix-4 divide, result leaves in SIGN as a late result
  parameter bit FAST_ALU = 1'b0, // DECODE predecodes the ALU result select (one-hot); clz / ctz / min / max become late results
  parameter bit FAST_FETCH_TARGET = 1'b0, // FETCH2 adds both immediates at once and picks a sum (no immediate mux in front of the adder)
  parameter bit FAST_STALL = 1'b0, // the DECODE hazard checks come from flip-flops: decoded and compared one cycle ahead
  parameter bit FAST_LOAD_ALIGN = 1'b0, // a load's byte lanes are decoded in EXECUTE: MEMORY only ANDs and ORs the data
  parameter bit LATE_BRANCH_RESOLVE = 1'b0, // branches and JALR redirect from MEMORY, one cycle later: no compare -> flush path in EXECUTE
  parameter bit ZIFENCEI = 1'b0, // FENCE.I (Zifencei): flushes from EXECUTE like a trap, empties the BTB and (icache_invalidate) the instruction cache
  parameter bit XCOMPUTE = 1'b0, // the packed compute instructions (custom-0 group "xcompute" in src/Custom_Unit.sv: paddus.b ... pmulhrs.h)
  parameter bit SRAM_CACHES = 1'b0 // silicon: the caches keep their lines in SRAM macros, which answer one clock edge later.
                                   // FETCH2_INSTRUCTION and MEMORY_DATA_CACHE_DATA then come from the caches (*_dout_late)
) (
  input  logic        clk,
  input  logic        reset,
  input  logic        BRANCH_PREDICTION_ENABLE, // 1 = GShare predictor, 0 = always predict not taken
  input  logic        TIMER_INTERRUPT_LINE, // the machine timer: mtime >= mtimecmp
  input  logic        EXTERNAL_INTERRUPT_LINE, // a device wants attention (FPGA: the UART received a byte)

  // Where the first instruction is fetched after reset (PC_RESET = 0x2000 for programs; the FPGA system
  // points it at its boot firmware at 0x0000 first, like a PC's reset vector pointing into its BIOS ROM)
  input  logic [63:0] RESET_VECTOR,

  // Memory system ports
  output logic [63:0] dcache_addr,
  output logic [63:0] icache_addr,
  output logic [7:0]  dcache_we,
  output logic [63:0] dcache_din,
  input  logic [63:0] dcache_dout,
  input  logic [31:0] icache_dout,
  input  logic        icache_hit, // 0: the instruction cache is fetching FETCH1's line from main memory
  output logic        icache_invalidate, // FENCE.I in EXECUTE (ZIFENCEI): the instruction cache takes its reset at this clock edge
  output logic        dcache_re, // A load is in Execute
  input  logic        dcache_hit, // 0: that load must wait for its line
  // SRAM_CACHES only (unused otherwise): the edges at which FETCH2_INSTRUCTION and MEMORY_DATA_CACHE_DATA load, and
  // the values they hold, produced by the caches' SRAM macros instead of by the two registers here
  output logic        icache_capture,
  output logic        dcache_capture,
  input  logic [31:0] icache_dout_late,
  input  logic [63:0] dcache_dout_late,
  output logic [63:0] csr, // TOHOST: 1 = PASS, anything else odd = FAIL test (csr >> 1)

  // Status and debug ports (testbench only)
  output logic        HALTED, // The instruction that wrote TOHOST has reached Writeback: the program is done
  input  logic [4:0]  DEBUG_REGISTER_ADDRESS,
  output logic [63:0] DEBUG_REGISTER_DATA,
  output logic [5:0]  TRACE_VALID, // {WRITEBACK, MEMORY, EXECUTE, DECODE, FETCH2, FETCH1}
  output logic [63:0] TRACE_FETCH1_PC, TRACE_FETCH2_PC, TRACE_DECODE_PC, TRACE_EXECUTE_PC, TRACE_MEMORY_PC, TRACE_WRITEBACK_PC,
  output logic        TRACE_LOAD_STALL, TRACE_FLUSH, TRACE_REDIRECT, TRACE_MULTIPLY_DIVIDE_STALL,
  output logic        TRACE_INSTRUCTION_MISS, TRACE_DATA_MISS
);

  logic LOAD_STALL; // Load Hazard: Instead of a full stall only hold the Fetch and Decode, send a NOP to Execute, and advance the load logic for the Memory and Writeback
  logic FLUSH_FETCH1_FETCH2_DECODE; // Control Hazard: Fetch1 & Fetch2 & Decode FLUSH for mispredicted branching
  // LATE_BRANCH_RESOLVE: a branch or JALR only REGISTERS its outcome in EXECUTE. One cycle later, from MEMORY,
  // a wrong guess flushes FETCH1, FETCH2, DECODE and also EXECUTE (the instruction that followed it there),
  // 4 bubbles instead of 3. The comparator then drives one flip-flop instead of every pipeline enable, the
  // predictor tables and the return address stack. Traps, mret and interrupts still flush from EXECUTE.
  logic LATE_FLUSH; // the branch in MEMORY was guessed wrong: flush everything younger, EXECUTE included
  logic EXECUTE_LIVE; // EXECUTE_VALID, unless LATE_FLUSH is removing that instruction right now
  logic MEMORY_REDIRECT, MEMORY_BRANCH_UPDATE, MEMORY_BRANCH_TAKEN, MEMORY_BTB_UPDATE, MEMORY_IS_A_JAL;
  logic MEMORY_GSHARE_PREDICTED_TAKEN, MEMORY_BHT_PREDICTED_TAKEN;
  logic [63:0] MEMORY_REDIRECT_PC, MEMORY_PC_TARGET;
  logic INTERRUPT_REQUEST, INTERRUPT_IS_EXTERNAL; // from the CSR file: an enabled interrupt is pending
  logic DECODE_TAKES_INTERRUPT; // the instruction in DECODE is replaced by the interrupt (see below)
  logic ADVANCE_FRONT_END; // Fetch1, Fetch2 and Decode move forward this cycle (no flush and no stall)
  logic FRONT_END_NOT_STALLED; // No stall (a flush may still be happening): enough for anything a flush overrides anyway
  logic MULTIPLY_DIVIDE_STALL; // An M instruction in Execute is still iterating: hold Fetch1 to Execute, bubble into Memory
  localparam bit FAST_M_UNIT = ITERATIVE_MULTIPLY_DIVIDE && FAST_MULTIPLY_DIVIDE; // the turbo edition's M unit (FastMultiplyDivideUnit)
  logic DATA_CACHE_STALL; // The load in Execute missed in the data cache: hold Fetch1 to Execute, bubble into Memory
  logic HALT_NOW; // The TOHOST writing instruction is in Writeback this cycle: it finishes, everything else freezes
  logic FREEZE; // No side effects this cycle (halting now, or already halted)

  // ========== Fetch 1 Stage Signals: ==========
  logic [63:0] FETCH1_PC; // The Current Program Counter to send to Instruction Memory
  logic [63:0] FETCH1_PC_ADD_4; // Next sequential Program Counter
  logic FETCH1_INCREMENT_CARRY_UNUSED;
  ParallelPrefixAdder #(.WIDTH(64)) fetch1_incrementer ( // Program Counter + 4 (prefix adder: no carry chain on the next-PC path)
    .A (FETCH1_PC), .B (64'd4), .CARRY_IN (1'b0), .SUM (FETCH1_PC_ADD_4), .CARRY_OUT (FETCH1_INCREMENT_CARRY_UNUSED)
  );
  assign icache_addr = FETCH1_PC; // Provide Instruction Memory with Program Counter Address

  // Global Share Branch Prediction Scheme:
  logic FETCH1_PREDICTED_BRANCH_TAKEN; // Fetch 1 Stage Prediction from the Almighty Branch Predictor (0 is saying it predicts not taken, 1 is saying it will be taken)
  logic [GSHARE_HISTORY_BITS-1:0] FETCH1_GSHARE_INDEX; // Fetch 1 Branch History Table Index (for 2^n entries with n history bits to index from)
  logic [GSHARE_HISTORY_BITS-1:0] GLOBAL_HISTORY; // Current Global History Register value (saved as a checkpoint in Fetch 2)

  // Execute Stage Signals Relevant to Gshare predictor:
  logic EXECUTE_VALID;
  logic EXECUTE_UPDATE_BRANCH_PREDICTOR; // We have the actual Results from the branching scheme tally it at the Branch Predictor History Table
  logic EXECUTE_BRANCH_WAS_ACTUALLY_TAKEN; // Since Branch Comparator is in the Execute Stage this is when it will be known whether the branch was really taken or not
  logic EXECUTE_PREDICTION_WAS_WRONG; // Branch Control looks at Predicted Value and determines if the prediction was right or wrong
  logic [GSHARE_HISTORY_BITS-1:0] EXECUTE_GSHARE_INDEX; // Save the Branch History Table Index that was used for solid book keeping
  logic [GSHARE_HISTORY_BITS-1:0] EXECUTE_GLOBAL_HISTORY_CHECKPOINT; // Global History as it was before this instruction's own speculative update
  logic [GSHARE_HISTORY_BITS-1:0] EXECUTE_RESTORED_GLOBAL_HISTORY; // Correct history to rewind to on a flush
  logic [GSHARE_HISTORY_BITS-1:0] MEMORY_RESTORED_GLOBAL_HISTORY, MEMORY_GSHARE_INDEX; // LATE_BRANCH_RESOLVE: the same, one stage later
  logic EXECUTE_IS_A_BRANCH_INSTRUCTION; // Is Branch Instruction? at the Execute Stage

  // Branch Target Buffer: a taken branch or JAL seen before redirects straight from FETCH1 (no bubble)
  logic BTB_HIT; // FETCH1_PC is a taken branch or JAL we have seen
  logic BTB_HIT_IS_JAL; // ... and it is a JAL
  logic [63:0] BTB_PREDICTED_TARGET; // Where it went last time
  logic FETCH1_BTB_REDIRECT; // Jump now: JAL, or a branch the GShare counter says is taken
  logic [63:0] FETCH1_NEXT_PC; // FETCH1's own choice of the next PC
  logic EXECUTE_BTB_UPDATE; // A taken branch or JAL is resolving in Execute: remember it
  logic [63:0] EXECUTE_PC; // (declared early: the BTB is written from Execute)
  logic [63:0] EXECUTE_PC_TARGET;
  logic EXECUTE_IS_A_JAL_INSTRUCTION;
  logic EXECUTE_BRANCH_TAKEN;

  BranchTargetBuffer #(.ENTRIES(16)) branch_target_buffer (
    .clk (clk),
    .reset (reset || icache_invalidate), // FENCE.I empties the BTB too: no jump is taken from a target the old code taught it
    .FETCH_PC (FETCH1_PC),
    .HIT (BTB_HIT),
    .HIT_IS_JAL (BTB_HIT_IS_JAL),
    .PREDICTED_TARGET (BTB_PREDICTED_TARGET),
    .UPDATE (LATE_BRANCH_RESOLVE ? (!FREEZE && MEMORY_BTB_UPDATE) : EXECUTE_BTB_UPDATE),
    .UPDATE_PC (LATE_BRANCH_RESOLVE ? MEMORY_PC : EXECUTE_PC),
    .UPDATE_TARGET (LATE_BRANCH_RESOLVE ? MEMORY_PC_TARGET : EXECUTE_PC_TARGET),
    .UPDATE_IS_JAL (LATE_BRANCH_RESOLVE ? MEMORY_IS_A_JAL : EXECUTE_IS_A_JAL_INSTRUCTION)
  );
  assign FETCH1_BTB_REDIRECT = BTB_ENABLE && icache_hit && BTB_HIT && (BTB_HIT_IS_JAL || FETCH1_PREDICTED_BRANCH_TAKEN);
  // An instruction cache miss: stay on this PC until the line arrives
  assign FETCH1_NEXT_PC = !icache_hit ? FETCH1_PC : FETCH1_BTB_REDIRECT ? BTB_PREDICTED_TARGET : FETCH1_PC_ADD_4;

  // ========== Fetch 2 Stage Signals: ==========
  logic [63:0] FETCH2_PC; // The Program Counter of the instruction that just arrived from Instruction Memory
  logic FETCH2_VALID; // Verify Fetch 2 stage has a real instruction not a flush or redirection from branching or jumping
  logic [31:0] FETCH2_INSTRUCTION; // Full Instruction from Instruction Memory
  logic [31:0] FETCH2_INSTRUCTION_REGISTER; // ... captured here, or (SRAM_CACHES) held in the instruction cache's SRAM
  assign FETCH2_INSTRUCTION = SRAM_CACHES ? icache_dout_late : FETCH2_INSTRUCTION_REGISTER;
  logic [6:0] FETCH2_OPCODE; // Instruction Operation Code
  logic FETCH2_IS_A_BRANCH_INSTRUCTION; // Is the FETCH Instruction a Branch type? (0 no, 1 yes)
  logic FETCH2_IS_A_JAL_INSTRUCTION; // Is the FETCH Instruction a JAL? If so just always take no need to guess
  logic FETCH2_PREDICTED_BRANCH_TAKEN; // Store the Magical Almighty Branch Predictor's prediction
  logic [GSHARE_HISTORY_BITS-1:0] FETCH2_GSHARE_INDEX; // Index for the Branch History Table
  logic FETCH2_BTB_REDIRECTED; // FETCH1 already jumped to this instruction's target (via the BTB)
  logic [63:0] FETCH2_PC_ADD_4; // FETCH1's PC + 4, registered beside FETCH2_PC and carried down the pipeline: no adder after FETCH1

  assign FETCH2_OPCODE = FETCH2_INSTRUCTION[6:0]; // Assign FETCH Instruction's opcode
  assign FETCH2_IS_A_BRANCH_INSTRUCTION = (FETCH2_OPCODE == OPC_BRANCH); // If opcode is the same as B-type then its a branch
  assign FETCH2_IS_A_JAL_INSTRUCTION = (FETCH2_OPCODE == OPC_JAL); // If opcode is the same as JAL then its a JAL

  // Precompute Branch and JAL Immediates for Branch Prediction Addressing (reduces the critical path, the target is ready before Decode):
  logic [63:0] FETCH2_BRANCH_IMMEDIATE; // Full sign extended Branch Immediate
  logic [63:0] FETCH2_JAL_IMMEDIATE; // Full sign extended Jump Immediate
  logic [63:0] FETCH2_IMMEDIATE; // Select Immediate based on whether a Branch or Jump occurs
  logic [63:0] FETCH2_PC_TARGET; // Target Address = Instruction Memory's Response Program Counter + Associated Immediate
  assign FETCH2_BRANCH_IMMEDIATE = {{51{FETCH2_INSTRUCTION[31]}}, FETCH2_INSTRUCTION[31], FETCH2_INSTRUCTION[7], FETCH2_INSTRUCTION[30:25], FETCH2_INSTRUCTION[11:8], 1'b0}; // B-type uses Immediate bits 31, 7, 30-25, 11-8 and the 0th bit
  assign FETCH2_JAL_IMMEDIATE = {{43{FETCH2_INSTRUCTION[31]}}, FETCH2_INSTRUCTION[31], FETCH2_INSTRUCTION[19:12], FETCH2_INSTRUCTION[20], FETCH2_INSTRUCTION[30:21], 1'b0}; // J-type uses Immediate bits 31, 19-12, 20, 30-21, and the 0th bit
  assign FETCH2_IMMEDIATE = FETCH2_IS_A_JAL_INSTRUCTION ? FETCH2_JAL_IMMEDIATE : FETCH2_BRANCH_IMMEDIATE;
  logic FETCH2_TARGET_CARRY_UNUSED; // Addresses wrap: the carry out of the target add is not needed
  logic [63:0] FETCH2_SELECTED_SUM;
  ParallelPrefixAdder #(.WIDTH(64)) fetch2_target_adder ( // Compute the Target Address to use (prefix adder: this add is on the next-PC path)
    .A (FETCH2_PC),
    .B (FAST_FETCH_TARGET ? FETCH2_BRANCH_IMMEDIATE : FETCH2_IMMEDIATE),
    .CARRY_IN (1'b0),
    .SUM (FETCH2_SELECTED_SUM),
    .CARRY_OUT (FETCH2_TARGET_CARRY_UNUSED)
  );
  // FAST_FETCH_TARGET: a second adder for the JAL immediate, so the opcode decode picks between two finished
  // sums instead of steering 64 adder inputs (the same target, one multiplexer level shorter)
  generate
    if (FAST_FETCH_TARGET) begin : jal_target
      logic [63:0] JAL_SUM; logic JAL_CARRY_UNUSED;
      ParallelPrefixAdder #(.WIDTH(64)) fetch2_jal_target_adder (.A (FETCH2_PC), .B (FETCH2_JAL_IMMEDIATE), .CARRY_IN (1'b0), .SUM (JAL_SUM), .CARRY_OUT (JAL_CARRY_UNUSED));
      assign FETCH2_PC_TARGET = FETCH2_IS_A_JAL_INSTRUCTION ? JAL_SUM : FETCH2_SELECTED_SUM;
    end else begin : one_target
      assign FETCH2_PC_TARGET = FETCH2_SELECTED_SUM;
    end
  endgenerate

  // Return Address Stack: calls push PC + 4, returns (jalr x0, 0(ra)) pop and redirect here in FETCH2
  logic FETCH2_IS_A_JALR_INSTRUCTION;
  logic FETCH2_IS_A_CALL; // jal / jalr that writes ra (x1) or t0 (x5)
  logic FETCH2_IS_A_RETURN; // jalr x0, 0(ra) or jalr x0, 0(t0)
  logic FETCH2_RETURN_PREDICTED; // Use the Return Address Stack for this return
  logic [63:0] RETURN_ADDRESS_STACK_TOP;
  localparam int RAS_POINTER_BITS = 3; // 8 entries
  logic [RAS_POINTER_BITS-1:0] RETURN_ADDRESS_STACK_POINTER;
  logic [RAS_POINTER_BITS-1:0] EXECUTE_RAS_CHECKPOINT;
  logic EXECUTE_IS_A_CALL, EXECUTE_IS_A_RETURN;
  logic [RAS_POINTER_BITS-1:0] EXECUTE_RAS_RESTORE_POINTER, MEMORY_RAS_RESTORE_POINTER; // the pointer as it should be after this instruction
  assign EXECUTE_RAS_RESTORE_POINTER = EXECUTE_RAS_CHECKPOINT + {{(RAS_POINTER_BITS-1){1'b0}}, EXECUTE_IS_A_CALL} - {{(RAS_POINTER_BITS-1){1'b0}}, EXECUTE_IS_A_RETURN};
  assign FETCH2_IS_A_JALR_INSTRUCTION = (FETCH2_OPCODE == OPC_JALR);
  assign FETCH2_IS_A_CALL = (FETCH2_IS_A_JAL_INSTRUCTION || FETCH2_IS_A_JALR_INSTRUCTION) && ((FETCH2_INSTRUCTION[11:7] == 5'd1) || (FETCH2_INSTRUCTION[11:7] == 5'd5));
  assign FETCH2_IS_A_RETURN = FETCH2_IS_A_JALR_INSTRUCTION && (FETCH2_INSTRUCTION[11:7] == 5'd0) && ((FETCH2_INSTRUCTION[19:15] == 5'd1) || (FETCH2_INSTRUCTION[19:15] == 5'd5)) && (FETCH2_INSTRUCTION[31:20] == 12'd0);
  assign FETCH2_RETURN_PREDICTED = RAS_ENABLE && FETCH2_IS_A_RETURN;

  ReturnAddressStack #(.DEPTH(8)) return_address_stack (
    .clk (clk),
    .reset (reset),
    .TOP_ADDRESS (RETURN_ADDRESS_STACK_TOP),
    .POINTER (RETURN_ADDRESS_STACK_POINTER),
    // (a flush in the same cycle wins inside the stack: RESTORE has priority over PUSH and POP)
    .PUSH (RAS_ENABLE && !FREEZE && FRONT_END_NOT_STALLED && FETCH2_VALID && FETCH2_IS_A_CALL),
    .POP (RAS_ENABLE && !FREEZE && FRONT_END_NOT_STALLED && FETCH2_VALID && FETCH2_IS_A_RETURN),
    .PUSH_ADDRESS (FETCH2_PC_ADD_4),
    .RESTORE (RAS_ENABLE && !FREEZE && FLUSH_FETCH1_FETCH2_DECODE),
    .RESTORE_POINTER (LATE_FLUSH ? MEMORY_RAS_RESTORE_POINTER : EXECUTE_RAS_RESTORE_POINTER)
  );

  // Target will either become the address that will get branched or jumped to, or will continue like normal adding 4 each time
  logic FETCH2_BRANCHED; // A branch the predictor says is taken
  logic FETCH2_BRANCH_OFF_OR_CONTINUE; // If a branch or jump is predicted use the calculated new address (and squash the instruction fetched behind it)
  logic [63:0] FETCH2_REDIRECT_TARGET; // Branch / JAL target, or the Return Address Stack for a return
  logic [63:0] FETCH2_PREDICTED_NEXT_PC; // The next Program Counter: either the targeted address or FETCH1's own choice
  assign FETCH2_BRANCHED = FETCH2_IS_A_BRANCH_INSTRUCTION && FETCH2_PREDICTED_BRANCH_TAKEN;
  assign FETCH2_BRANCH_OFF_OR_CONTINUE = FETCH2_VALID && (FETCH2_BRANCHED || FETCH2_IS_A_JAL_INSTRUCTION || FETCH2_RETURN_PREDICTED) && !FETCH2_BTB_REDIRECTED;
  assign FETCH2_REDIRECT_TARGET = FETCH2_RETURN_PREDICTED ? RETURN_ADDRESS_STACK_TOP : FETCH2_PC_TARGET;
  assign FETCH2_PREDICTED_NEXT_PC = FETCH2_BRANCH_OFF_OR_CONTINUE ? FETCH2_REDIRECT_TARGET : FETCH1_NEXT_PC;

  // ===== Tournament: per-branch history table + chooser =====
  logic FETCH1_GSHARE_PREDICTED_TAKEN; // GShare's guess
  logic FETCH1_BHT_PREDICTED_TAKEN; // The per-branch table's guess
  logic FETCH1_CHOOSE_GSHARE; // The chooser trusts GShare for this branch
  logic FETCH2_GSHARE_PREDICTED_TAKEN, FETCH2_BHT_PREDICTED_TAKEN;
  logic DECODE_GSHARE_PREDICTED_TAKEN, DECODE_BHT_PREDICTED_TAKEN;
  logic EXECUTE_GSHARE_PREDICTED_TAKEN, EXECUTE_BHT_PREDICTED_TAKEN;
  TournamentChooser #(.INDEX_BITS(7)) tournament_chooser (
    .clk (clk),
    .reset (reset),
    .ENABLE (BRANCH_PREDICTION_ENABLE),
    .FETCH_PC (FETCH1_PC),
    .BHT_PREDICTED_TAKEN (FETCH1_BHT_PREDICTED_TAKEN),
    .CHOOSE_GSHARE (FETCH1_CHOOSE_GSHARE),
    .UPDATE (TOURNAMENT_PREDICTOR && !FREEZE && (LATE_BRANCH_RESOLVE ? MEMORY_BRANCH_UPDATE : (EXECUTE_LIVE && EXECUTE_UPDATE_BRANCH_PREDICTOR))),
    .UPDATE_PC (LATE_BRANCH_RESOLVE ? MEMORY_PC : EXECUTE_PC),
    .ACTUAL_BRANCH_TAKEN (LATE_BRANCH_RESOLVE ? MEMORY_BRANCH_TAKEN : EXECUTE_BRANCH_WAS_ACTUALLY_TAKEN),
    .BHT_WAS_TAKEN (LATE_BRANCH_RESOLVE ? MEMORY_BHT_PREDICTED_TAKEN : EXECUTE_BHT_PREDICTED_TAKEN),
    .GSHARE_WAS_TAKEN (LATE_BRANCH_RESOLVE ? MEMORY_GSHARE_PREDICTED_TAKEN : EXECUTE_GSHARE_PREDICTED_TAKEN)
  );
  assign FETCH1_PREDICTED_BRANCH_TAKEN = TOURNAMENT_PREDICTOR ? (FETCH1_CHOOSE_GSHARE ? FETCH1_GSHARE_PREDICTED_TAKEN : FETCH1_BHT_PREDICTED_TAKEN) : FETCH1_GSHARE_PREDICTED_TAKEN;

  GSharePredictor #(
    .HISTORY_BITS (GSHARE_HISTORY_BITS)
  ) gshare_branch_predictor (
    .clk (clk),
    .reset (reset),
    .ENABLE (BRANCH_PREDICTION_ENABLE),
    .FETCH_PC (FETCH1_PC),
    .FETCH_PREDICTED_TAKEN (FETCH1_GSHARE_PREDICTED_TAKEN),
    .FETCH_PREDICTION_INDEX (FETCH1_GSHARE_INDEX),
    .GLOBAL_HISTORY (GLOBAL_HISTORY),
    .SPECULATIVE_UPDATE (!FREEZE && FRONT_END_NOT_STALLED && FETCH2_VALID && FETCH2_IS_A_BRANCH_INSTRUCTION), // Fetch 2 branch moving to Decode
    .SPECULATIVE_TAKEN (FETCH2_PREDICTED_BRANCH_TAKEN),
    .UPDATE_PREDICTION (!FREEZE && (LATE_BRANCH_RESOLVE ? MEMORY_BRANCH_UPDATE : (EXECUTE_LIVE && EXECUTE_UPDATE_BRANCH_PREDICTOR))),
    .UPDATE_PREDICTION_INDEX (LATE_BRANCH_RESOLVE ? MEMORY_GSHARE_INDEX : EXECUTE_GSHARE_INDEX),
    .ACTUAL_BRANCH_TAKEN (LATE_BRANCH_RESOLVE ? MEMORY_BRANCH_TAKEN : EXECUTE_BRANCH_WAS_ACTUALLY_TAKEN),
    .RESTORE_HISTORY (!FREEZE && FLUSH_FETCH1_FETCH2_DECODE), // Main idea here is to make sure the Global History Register stores only what actually happens
    .RESTORE_HISTORY_VALUE (LATE_FLUSH ? MEMORY_RESTORED_GLOBAL_HISTORY : EXECUTE_RESTORED_GLOBAL_HISTORY)
  );

  // ========== Decode Stage Signals: ==========
  logic [63:0] DECODE_PC; // Program Counter at Decode
  logic [31:0] DECODE_INSTRUCTION; // Instruction at Decode
  logic DECODE_VALID;
  logic DECODE_PREDICTED_BRANCH_TAKEN;
  logic [GSHARE_HISTORY_BITS-1:0] DECODE_GSHARE_INDEX;
  logic [GSHARE_HISTORY_BITS-1:0] DECODE_GLOBAL_HISTORY_CHECKPOINT;
  logic [63:0] DECODE_PC_TARGET; // Branch / JAL target precomputed in Fetch 2 (or the predicted return address)
  logic [63:0] DECODE_PC_ADD_4; // PC + 4 carried from Fetch 2
  logic DECODE_RETURN_PREDICTED, DECODE_IS_A_CALL, DECODE_IS_A_RETURN;
  logic [RAS_POINTER_BITS-1:0] DECODE_RAS_CHECKPOINT;
  logic DECODE_USES_REGISTER1, DECODE_USES_REGISTER2;
  logic DECODE_IS_AN_ECALL, DECODE_IS_AN_EBREAK, DECODE_IS_AN_MRET; // Traps (machine mode)
  logic DECODE_IS_A_FENCE_I; // FENCE.I (Zifencei, only with ZIFENCEI)
  logic [4:0] DECODE_REGISTER1_ADDRESS; // register file read port 1 (rs1)
  logic [4:0] DECODE_REGISTER2_ADDRESS; // register file read port 2 (rs2)
  logic [4:0] DECODE_DESTINATION_REGISTER_ADDRESS; // destination register (rd)
  logic [2:0] DECODE_FUNCT3; // funct3
  logic [11:0] DECODE_CSR_ADDRESS; // Control Status Register Target
  logic [63:0] DECODE_REGISTER_FILE_REGISTER1_DATA; // Regfile's Register 1 information
  logic [63:0] DECODE_REGISTER_FILE_REGISTER2_DATA; // Regfile's Register 2 information
  logic [63:0] DECODE_FORWARDED_REGISTER1_DATA; // Regfile's Register 1 information after forwarding (Data Hazard: Decode to Execute Forwarding)
  logic [63:0] DECODE_FORWARDED_REGISTER2_DATA; // Regfile's Register 2 information after forwarding (Data Hazard: Decode to Execute Forwarding)
  logic [63:0] DECODE_IMMEDIATE; // Decode's Immediate Value
  logic DECODE_REGISTER_WRITE_ENABLE; // Does the instruction write to destination register? (0 is read, 1 is write)
  logic DECODE_MEMORY_READ_ENABLE; // Does memory need to be read? (Basically is this a load, 0 is no, 1 is yes)
  logic DECODE_MEMORY_WRITE_ENABLE; // Does memory need to be written to? (Basically is this a store, 0 is no, 1 is yes)
  logic DECODE_CSR_WRITE_ENABLE; // Does Control Status Register need to be written to? (0 is no, 1 is yes)
  logic DECODE_CSR_WRITE_USING_IMMEDIATE; // Does Control Status Register need to be written to with immediate? (0 is no, 1 is yes)
  logic DECODE_ALU_INPUT_A_IS_PC; // ALU Input A is 0: Register 1 or 1: Program Counter
  logic DECODE_ALU_INPUT_B_IS_IMMEDIATE; // ALU Input B is 0: Register 2 or 1: Immediate Value
  logic DECODE_ALU_IS_WORD_OPERATION; // RV64 32-bit Word operation
  logic DECODE_IS_A_MULTIPLY_DIVIDE_INSTRUCTION; // RV64M instruction (result from the Multiply Divide Unit)
  logic DECODE_IS_A_BRANCH_INSTRUCTION; // Continue preserving whether or not the instruction is a B type
  logic DECODE_IS_A_JAL_INSTRUCTION; // Continue preserving whether or not the instruction is a JAL
  logic DECODE_IS_A_JALR_INSTRUCTION; // Determine whether or not the instruction is a JALR
  immediate_type_select_t DECODE_IMMEDIATE_TYPE_SELECT; // Immediate Type will consist of these: | I | S | B | U | J | Z |
  writeback_select_t DECODE_WRITEBACK_SELECT; // 4 Possibilities to Writeback: | ALU Result | Load Information | PC ADD 4 | CSR |
  alu_op_t DECODE_ALU_OPERATION; // Determine which ALU operation is required
  logic DECODE_ALU_OPERAND_A_ZERO_EXTEND; // Zba .uw forms
  logic [1:0] DECODE_ALU_OPERAND_A_SHIFT; // Zba shNadd
  logic DECODE_ALU_OPERAND_B_INVERT; // Zbb andn / orn / xnor, Zbs bclr
  logic DECODE_ALU_OPERAND_B_SINGLE_BIT; // Zbs bset / bclr / binv: 1 << rs2[5:0]

  assign DECODE_REGISTER1_ADDRESS = DECODE_INSTRUCTION[19:15]; // Register 1 Address (rs1) is always the 5 bits at 19-15
  assign DECODE_REGISTER2_ADDRESS = DECODE_INSTRUCTION[24:20]; // Register 2 Address (rs2) is always the 5 bits at 24-20
  assign DECODE_DESTINATION_REGISTER_ADDRESS = DECODE_INSTRUCTION[11:7]; // Destination Register's Address (rd) is always the 5 bits at 11-7
  assign DECODE_FUNCT3 = DECODE_INSTRUCTION[14:12]; // Funct3 is always the 3 bits at 14-12
  assign DECODE_IS_A_FENCE_I = ZIFENCEI && (DECODE_INSTRUCTION[6:0] == OPC_FENCE) && (DECODE_INSTRUCTION[14:12] == FNC_FENCE_I);
  assign DECODE_CSR_ADDRESS = DECODE_INSTRUCTION[31:20]; // Control Status Register Address (CSR) is always the top 12 bits at 31-20

  // Forwarding Signals from Execute:
  logic [4:0] EXECUTE_DESTINATION_REGISTER_ADDRESS; // Execute Stage Instruction's destination register address (rd)
  logic EXECUTE_REGISTER_WRITE_ENABLE; // Execute Stage's Read or Write Signal
  logic EXECUTE_MEMORY_READ_ENABLE; // Execute Stage's Memory Read or not (Is a load occurring in Execute? if so load stall is necessary)
  logic [63:0] EXECUTE_FORWARD_DATA; // Execute Stage's Data to Forward | ALU Result | PC ADD 4 | CSR |

  // Forwarding Signals from Memory:
  logic [4:0] MEMORY_DESTINATION_REGISTER_ADDRESS; // Memory's destination register address (rd)
  logic MEMORY_REGISTER_WRITE_ENABLE; // Memory's Read or Write Signal
  logic MEMORY_VALID; // Memory's instruction is valid right?
  logic [63:0] MEMORY_FORWARD_DATA; // Memory's 4 Possibilities to Forward back: | ALU Result | Load Information | PC ADD 4 | CSR |

  // Forwarding Signals from Writeback:
  logic [4:0] WRITEBACK_DESTINATION_REGISTER_ADDRESS; // Writeback Stage's destination register address (rd)
  logic WRITEBACK_REGISTER_WRITE_ENABLE; // Writeback Stage's Read or Write Signal
  logic WRITEBACK_VALID; // Writeback Stage's instruction is valid right?
  logic [63:0] WRITEBACK_DATA; // Final writeback data driving Register File's write data this cycle

  RegisterFile register_file ( // Synchronous Writes, Asynchronous Reads
    .clk (clk),
    .reset (reset),
    .REGISTER_WRITE_ENABLE (!HALTED && WRITEBACK_VALID && WRITEBACK_REGISTER_WRITE_ENABLE),
    .READ_ADDRESS1 (DECODE_REGISTER1_ADDRESS),
    .READ_ADDRESS2 (DECODE_REGISTER2_ADDRESS),
    .WRITE_ADDRESS (WRITEBACK_DESTINATION_REGISTER_ADDRESS),
    .WRITE_DATA (WRITEBACK_DATA),
    .READ_DATA1 (DECODE_REGISTER_FILE_REGISTER1_DATA),
    .READ_DATA2 (DECODE_REGISTER_FILE_REGISTER2_DATA),
    .DEBUG_READ_ADDRESS (DEBUG_REGISTER_ADDRESS),
    .DEBUG_READ_DATA (DEBUG_REGISTER_DATA)
  );

  // Decode Stage Register 1 Data Hazard Forwarding (Data Hazard Priority Logic: x0 Address > Execute (no loading occurring) > Memory > Writeback > Register File):
  always_comb begin
    if (DECODE_REGISTER1_ADDRESS == 5'd0) begin // If the Address is x0 then all the data is just zero
      DECODE_FORWARDED_REGISTER1_DATA = 64'd0; // x0 reads as all 0s
    end else if (EXECUTE_VALID && EXECUTE_REGISTER_WRITE_ENABLE && !EXECUTE_MEMORY_READ_ENABLE && !EXECUTE_LATE_RESULT && (EXECUTE_DESTINATION_REGISTER_ADDRESS != 5'd0) && (EXECUTE_DESTINATION_REGISTER_ADDRESS == DECODE_REGISTER1_ADDRESS)) begin // Execute Stage is Valid and Register Writing is Enabled and No Loading is happening, and RS1 is the same as Destination Address
      DECODE_FORWARDED_REGISTER1_DATA = EXECUTE_FORWARD_DATA; // Data Hazard: Forward Execute Data to Decode Stage (Loads are not considered will use a load stall)
    end else if (MEMORY_VALID && MEMORY_REGISTER_WRITE_ENABLE && (MEMORY_DESTINATION_REGISTER_ADDRESS != 5'd0) && (MEMORY_DESTINATION_REGISTER_ADDRESS == DECODE_REGISTER1_ADDRESS)) begin // Memory Stage is Valid and Register Writing is Enabled and RS1 is the same as Destination Address
      DECODE_FORWARDED_REGISTER1_DATA = MEMORY_FORWARD_DATA; // Data Hazard: Forward Memory Data
    end else if (WRITEBACK_VALID && WRITEBACK_REGISTER_WRITE_ENABLE && (WRITEBACK_DESTINATION_REGISTER_ADDRESS != 5'd0) && (WRITEBACK_DESTINATION_REGISTER_ADDRESS == DECODE_REGISTER1_ADDRESS)) begin // Writeback Stage is Valid and Register Writing is Enabled, and RS1 is the same as Destination Address
      DECODE_FORWARDED_REGISTER1_DATA = WRITEBACK_DATA; // Data Hazard: Forward Writeback Data
    end else begin
      DECODE_FORWARDED_REGISTER1_DATA = DECODE_REGISTER_FILE_REGISTER1_DATA; // No hazard is present, the register file data is okay to use
    end
  end

  // Decode Stage Register 2 Data Hazard Forwarding (Data Hazard Priority Logic: x0 Address > Execute (no loading occurring) > Memory > Writeback > Register File):
  always_comb begin
    if (DECODE_REGISTER2_ADDRESS == 5'd0) begin // If the Address is x0 then all the data is just zero
      DECODE_FORWARDED_REGISTER2_DATA = 64'd0; // x0 reads as all 0s
    end else if (EXECUTE_VALID && EXECUTE_REGISTER_WRITE_ENABLE && !EXECUTE_MEMORY_READ_ENABLE && !EXECUTE_LATE_RESULT && (EXECUTE_DESTINATION_REGISTER_ADDRESS != 5'd0) && (EXECUTE_DESTINATION_REGISTER_ADDRESS == DECODE_REGISTER2_ADDRESS)) begin // Execute Stage is Valid and Register Writing is Enabled and No Loading is happening, and RS2 is the same as Destination Address
      DECODE_FORWARDED_REGISTER2_DATA = EXECUTE_FORWARD_DATA; // Data Hazard: Forward Execute Data to Decode Stage (Loads are not considered will use a load stall)
    end else if (MEMORY_VALID && MEMORY_REGISTER_WRITE_ENABLE && (MEMORY_DESTINATION_REGISTER_ADDRESS != 5'd0) && (MEMORY_DESTINATION_REGISTER_ADDRESS == DECODE_REGISTER2_ADDRESS)) begin // Memory Stage is Valid and Register Writing is Enabled and RS2 is the same as Destination Address
      DECODE_FORWARDED_REGISTER2_DATA = MEMORY_FORWARD_DATA; // Data Hazard: Forward Memory Data
    end else if (WRITEBACK_VALID && WRITEBACK_REGISTER_WRITE_ENABLE && (WRITEBACK_DESTINATION_REGISTER_ADDRESS != 5'd0) && (WRITEBACK_DESTINATION_REGISTER_ADDRESS == DECODE_REGISTER2_ADDRESS)) begin // Writeback Stage is Valid and Register Writing is Enabled, and RS2 is the same as Destination Address
      DECODE_FORWARDED_REGISTER2_DATA = WRITEBACK_DATA; // Data Hazard: Forward Writeback Data
    end else begin
      DECODE_FORWARDED_REGISTER2_DATA = DECODE_REGISTER_FILE_REGISTER2_DATA; // No hazard is present, the register file data is okay to use
    end
  end

  logic LOAD_HAZARD_REGISTER1; // Determine if Decode is reading register1 as Execute Load is writing to same place
  logic LOAD_HAZARD_REGISTER2; // Determine if Decode is reading register2 as Execute Load is writing to same place
  logic PREPARED_OPERAND_HAZARD; // FAST_ALU: shNadd / .uw whose rs1 is the value EXECUTE is computing right now
  logic SINGLE_BIT_HAZARD; // Zbs bset / bclr / binv whose bit number is the value EXECUTE is computing right now

  // What the hazard checks need to know about the DECODE instruction. Normally decoded from DECODE_INSTRUCTION
  // this cycle. FAST_STALL decodes the FETCH2 instruction one cycle ahead and also compares its register numbers
  // with the destination of the instruction that will be in EXECUTE then, so LOAD_STALL (which holds the whole
  // front end: hundreds of flip-flop enables) is a few gates on flip-flop outputs instead of decode -> compare.
  logic HAZARD_USES_REGISTER1, HAZARD_USES_REGISTER2; // the instruction really reads rs1 / rs2
  logic HAZARD_SINGLE_BIT_FROM_REGISTER2; // Zbs bset / bclr / binv with the bit number in rs2
  logic HAZARD_PREPARED_REGISTER1; // Zba shNadd / .uw: operand A is rs1, shifted or zero-extended
  logic REGISTER1_MATCHES_EXECUTE, REGISTER2_MATCHES_EXECUTE; // EXECUTE's rd is not x0 and equals rs1 / rs2
  generate
    if (FAST_STALL) begin : early_hazard
      logic F2_USES1, F2_USES2, F2_B_IMMEDIATE, F2_SINGLE_BIT, F2_A_IS_PC, F2_ZERO_EXTEND;
      logic [1:0] F2_SHIFT;
      logic [13:0] UNUSED; immediate_type_select_t UNUSED_IMMEDIATE_TYPE; writeback_select_t UNUSED_WRITEBACK_SELECT; alu_op_t UNUSED_OPERATION; // only the hazard-related outputs are needed
      ControlUnit fetch2_control_unit (
        .INSTRUCTION (FETCH2_INSTRUCTION),
        .REGISTER_WRITE_ENABLE (UNUSED[0]), .MEMORY_READ_ENABLE (UNUSED[1]), .MEMORY_WRITE_ENABLE (UNUSED[2]),
        .CSR_WRITE_USING_IMMEDIATE (UNUSED[3]), .CSR_WRITE_ENABLE (UNUSED[4]),
        .ALU_INPUT_A_IS_PC (F2_A_IS_PC), .ALU_INPUT_B_IS_IMMEDIATE (F2_B_IMMEDIATE), .ALU_IS_WORD_OPERATION (UNUSED[5]),
        .IS_A_MULTIPLY_DIVIDE_INSTRUCTION (UNUSED[6]), .IS_A_BRANCH_INSTRUCTION (UNUSED[7]), .IS_A_JAL_INSTRUCTION (UNUSED[8]),
        .IS_A_JALR_INSTRUCTION (UNUSED[9]), .IS_AN_ECALL (UNUSED[10]), .IS_AN_EBREAK (UNUSED[11]), .IS_AN_MRET (UNUSED[12]),
        .USES_REGISTER1 (F2_USES1), .USES_REGISTER2 (F2_USES2),
        .IMMEDIATE_TYPE_SELECT (UNUSED_IMMEDIATE_TYPE), .WRITEBACK_SELECT (UNUSED_WRITEBACK_SELECT), .ALU_OPERATION (UNUSED_OPERATION),
        .ALU_OPERAND_A_ZERO_EXTEND (F2_ZERO_EXTEND), .ALU_OPERAND_A_SHIFT (F2_SHIFT), .ALU_OPERAND_B_INVERT (UNUSED[13]),
        .ALU_OPERAND_B_SINGLE_BIT (F2_SINGLE_BIT)
      );
      function automatic logic same_register(input logic [4:0] source, input logic [4:0] destination);
        return (destination != 5'd0) && (destination == source);
      endfunction
      logic USES1, USES2, SINGLE_BIT, PREPARED, MATCH1, MATCH2;
      always_ff @(posedge clk) begin
        if (reset) {USES1, USES2, SINGLE_BIT, PREPARED, MATCH1, MATCH2} <= 6'd0;
        else if (!FREEZE) begin
          if (FRONT_END_NOT_STALLED) begin // DECODE_INSTRUCTION <= FETCH2_INSTRUCTION, below
            USES1 <= F2_USES1;
            USES2 <= F2_USES2;
            SINGLE_BIT <= F2_SINGLE_BIT && !F2_B_IMMEDIATE;
            PREPARED <= (F2_ZERO_EXTEND || (F2_SHIFT != 2'd0)) && !F2_A_IS_PC;
          end
          // next DECODE instruction (FETCH2's, or the same one when the front end holds) against next EXECUTE's rd
          // (DECODE's when EXECUTE's operand registers load, else the same one); all four compares run in parallel
          MATCH1 <= FRONT_END_NOT_STALLED ? same_register(FETCH2_INSTRUCTION[19:15], DECODE_DESTINATION_REGISTER_ADDRESS)
                  : (!DATA_CACHE_STALL && !MULTIPLY_DIVIDE_STALL) ? same_register(DECODE_REGISTER1_ADDRESS, DECODE_DESTINATION_REGISTER_ADDRESS)
                  : same_register(DECODE_REGISTER1_ADDRESS, EXECUTE_DESTINATION_REGISTER_ADDRESS);
          MATCH2 <= FRONT_END_NOT_STALLED ? same_register(FETCH2_INSTRUCTION[24:20], DECODE_DESTINATION_REGISTER_ADDRESS)
                  : (!DATA_CACHE_STALL && !MULTIPLY_DIVIDE_STALL) ? same_register(DECODE_REGISTER2_ADDRESS, DECODE_DESTINATION_REGISTER_ADDRESS)
                  : same_register(DECODE_REGISTER2_ADDRESS, EXECUTE_DESTINATION_REGISTER_ADDRESS);
        end
      end
      assign {HAZARD_USES_REGISTER1, HAZARD_USES_REGISTER2, HAZARD_SINGLE_BIT_FROM_REGISTER2, HAZARD_PREPARED_REGISTER1} = {USES1, USES2, SINGLE_BIT, PREPARED};
      assign {REGISTER1_MATCHES_EXECUTE, REGISTER2_MATCHES_EXECUTE} = {MATCH1, MATCH2};
    end else begin : decoded_hazard
      assign HAZARD_USES_REGISTER1 = DECODE_USES_REGISTER1;
      assign HAZARD_USES_REGISTER2 = DECODE_USES_REGISTER2;
      assign HAZARD_SINGLE_BIT_FROM_REGISTER2 = DECODE_ALU_OPERAND_B_SINGLE_BIT && !DECODE_ALU_INPUT_B_IS_IMMEDIATE;
      assign HAZARD_PREPARED_REGISTER1 = (DECODE_ALU_OPERAND_A_ZERO_EXTEND || (DECODE_ALU_OPERAND_A_SHIFT != 2'd0)) && !DECODE_ALU_INPUT_A_IS_PC;
      assign REGISTER1_MATCHES_EXECUTE = (EXECUTE_DESTINATION_REGISTER_ADDRESS != 5'd0) && (EXECUTE_DESTINATION_REGISTER_ADDRESS == DECODE_REGISTER1_ADDRESS);
      assign REGISTER2_MATCHES_EXECUTE = (EXECUTE_DESTINATION_REGISTER_ADDRESS != 5'd0) && (EXECUTE_DESTINATION_REGISTER_ADDRESS == DECODE_REGISTER2_ADDRESS);
    end
  endgenerate

  // If the Execute Destination Address during a Load is the same as the Decode's register 1 that is being read a load hazard exists
  // (the rs1/rs2 FIELDS are compared even when an instruction does not use them: simple and safe, sometimes stalls for nothing, see Lab 5)
  assign LOAD_HAZARD_REGISTER1 = EXECUTE_VALID && (EXECUTE_MEMORY_READ_ENABLE || EXECUTE_LATE_RESULT) && REGISTER1_MATCHES_EXECUTE && (!PRECISE_LOAD_STALL || HAZARD_USES_REGISTER1);
  // If the Execute Destination Address during a Load is the same as the Decode's register 2 that is being read a load hazard exists
  assign LOAD_HAZARD_REGISTER2 = EXECUTE_VALID && (EXECUTE_MEMORY_READ_ENABLE || EXECUTE_LATE_RESULT) && REGISTER2_MATCHES_EXECUTE && (!PRECISE_LOAD_STALL || HAZARD_USES_REGISTER2);
  // A custom result is ready only in WRITEBACK: also wait while it is in MEMORY (EXECUTE is covered above,
  // because a custom instruction counts as a late result there)
  logic CUSTOM_HAZARD_REGISTER1, CUSTOM_HAZARD_REGISTER2;
  assign CUSTOM_HAZARD_REGISTER1 = MEMORY_VALID && MEMORY_IS_A_CUSTOM_INSTRUCTION && (MEMORY_DESTINATION_REGISTER_ADDRESS != 5'd0) && (MEMORY_DESTINATION_REGISTER_ADDRESS == DECODE_REGISTER1_ADDRESS) && (!PRECISE_LOAD_STALL || HAZARD_USES_REGISTER1);
  assign CUSTOM_HAZARD_REGISTER2 = MEMORY_VALID && MEMORY_IS_A_CUSTOM_INSTRUCTION && (MEMORY_DESTINATION_REGISTER_ADDRESS != 5'd0) && (MEMORY_DESTINATION_REGISTER_ADDRESS == DECODE_REGISTER2_ADDRESS) && (!PRECISE_LOAD_STALL || HAZARD_USES_REGISTER2);
  // An M instruction still iterating in EXECUTE wins over every DECODE hazard: a load stall would put a bubble
  // into EXECUTE and push the unfinished M instruction on to MEMORY with a stale result (a `bset` or a custom
  // instruction's hazard right behind a `mul` did exactly that). DECODE simply waits until the result is there.
  assign LOAD_STALL = DECODE_VALID && !MULTIPLY_DIVIDE_STALL && (LOAD_HAZARD_REGISTER1 || LOAD_HAZARD_REGISTER2 || SINGLE_BIT_HAZARD || PREPARED_OPERAND_HAZARD || CUSTOM_HAZARD_REGISTER1 || CUSTOM_HAZARD_REGISTER2); // Load Hazard Exists and thus enable the load stall

  ControlUnit control_unit (
    .INSTRUCTION (DECODE_INSTRUCTION),
    .REGISTER_WRITE_ENABLE (DECODE_REGISTER_WRITE_ENABLE),
    .MEMORY_READ_ENABLE (DECODE_MEMORY_READ_ENABLE),
    .MEMORY_WRITE_ENABLE (DECODE_MEMORY_WRITE_ENABLE),
    .CSR_WRITE_USING_IMMEDIATE (DECODE_CSR_WRITE_USING_IMMEDIATE),
    .CSR_WRITE_ENABLE (DECODE_CSR_WRITE_ENABLE),
    .ALU_INPUT_A_IS_PC (DECODE_ALU_INPUT_A_IS_PC),
    .ALU_INPUT_B_IS_IMMEDIATE (DECODE_ALU_INPUT_B_IS_IMMEDIATE),
    .ALU_IS_WORD_OPERATION (DECODE_ALU_IS_WORD_OPERATION),
    .IS_A_MULTIPLY_DIVIDE_INSTRUCTION (DECODE_IS_A_MULTIPLY_DIVIDE_INSTRUCTION),
    .IS_A_BRANCH_INSTRUCTION (DECODE_IS_A_BRANCH_INSTRUCTION),
    .IS_A_JAL_INSTRUCTION (DECODE_IS_A_JAL_INSTRUCTION),
    .IS_A_JALR_INSTRUCTION (DECODE_IS_A_JALR_INSTRUCTION),
    .IS_AN_ECALL (DECODE_IS_AN_ECALL),
    .IS_AN_EBREAK (DECODE_IS_AN_EBREAK),
    .IS_AN_MRET (DECODE_IS_AN_MRET),
    .USES_REGISTER1 (DECODE_USES_REGISTER1),
    .USES_REGISTER2 (DECODE_USES_REGISTER2),
    .IMMEDIATE_TYPE_SELECT (DECODE_IMMEDIATE_TYPE_SELECT),
    .WRITEBACK_SELECT (DECODE_WRITEBACK_SELECT),
    .ALU_OPERATION (DECODE_ALU_OPERATION),
    .ALU_OPERAND_A_ZERO_EXTEND (DECODE_ALU_OPERAND_A_ZERO_EXTEND),
    .ALU_OPERAND_A_SHIFT (DECODE_ALU_OPERAND_A_SHIFT),
    .ALU_OPERAND_B_INVERT (DECODE_ALU_OPERAND_B_INVERT),
    .ALU_OPERAND_B_SINGLE_BIT (DECODE_ALU_OPERAND_B_SINGLE_BIT)
  );

  // ALU operands, chosen and prepared in DECODE (Zba / Zbb need: sh1add / sh2add / sh3add: rs1 << 1, 2, 3;
  // .uw forms: zext(rs1[31:0]); andn / orn / xnor: ~rs2).
  // The value forwarded from EXECUTE arrives at the very end of the cycle (it is the ALU's output), everything
  // else (MEMORY, WRITEBACK, register file, PC, immediate) arrives early. So the operand is built in two parts:
  //   early: x0 / MEMORY / WRITEBACK / register file, prepared, or the PC / immediate   (all the muxing off the loop)
  //   late:  the EXECUTE value, prepared by one small one-hot multiplexer
  // and a final 2:1 picks the late one when rs1 / rs2 is being forwarded from EXECUTE. Same values as
  // DECODE_FORWARDED_*, but the ALU -> forwarding -> ALU loop only passes through two small multiplexers.
  logic DECODE_REGISTER1_FROM_EXECUTE, DECODE_REGISTER2_FROM_EXECUTE;
  assign DECODE_REGISTER1_FROM_EXECUTE = REGISTER1_MATCHES_EXECUTE && EXECUTE_VALID && EXECUTE_REGISTER_WRITE_ENABLE && !EXECUTE_MEMORY_READ_ENABLE && !EXECUTE_LATE_RESULT;
  assign DECODE_REGISTER2_FROM_EXECUTE = REGISTER2_MATCHES_EXECUTE && EXECUTE_VALID && EXECUTE_REGISTER_WRITE_ENABLE && !EXECUTE_MEMORY_READ_ENABLE && !EXECUTE_LATE_RESULT;
  logic [63:0] DECODE_EARLY_REGISTER1_DATA, DECODE_EARLY_REGISTER2_DATA; // the forwarding choice without EXECUTE
  always_comb begin
    if (DECODE_REGISTER1_ADDRESS == 5'd0) DECODE_EARLY_REGISTER1_DATA = 64'd0;
    else if (MEMORY_VALID && MEMORY_REGISTER_WRITE_ENABLE && (MEMORY_DESTINATION_REGISTER_ADDRESS == DECODE_REGISTER1_ADDRESS)) DECODE_EARLY_REGISTER1_DATA = MEMORY_FORWARD_DATA;
    else if (WRITEBACK_VALID && WRITEBACK_REGISTER_WRITE_ENABLE && (WRITEBACK_DESTINATION_REGISTER_ADDRESS == DECODE_REGISTER1_ADDRESS)) DECODE_EARLY_REGISTER1_DATA = WRITEBACK_DATA;
    else DECODE_EARLY_REGISTER1_DATA = DECODE_REGISTER_FILE_REGISTER1_DATA;
    if (DECODE_REGISTER2_ADDRESS == 5'd0) DECODE_EARLY_REGISTER2_DATA = 64'd0;
    else if (MEMORY_VALID && MEMORY_REGISTER_WRITE_ENABLE && (MEMORY_DESTINATION_REGISTER_ADDRESS == DECODE_REGISTER2_ADDRESS)) DECODE_EARLY_REGISTER2_DATA = MEMORY_FORWARD_DATA;
    else if (WRITEBACK_VALID && WRITEBACK_REGISTER_WRITE_ENABLE && (WRITEBACK_DESTINATION_REGISTER_ADDRESS == DECODE_REGISTER2_ADDRESS)) DECODE_EARLY_REGISTER2_DATA = WRITEBACK_DATA;
    else DECODE_EARLY_REGISTER2_DATA = DECODE_REGISTER_FILE_REGISTER2_DATA;
  end
  function automatic logic [63:0] prepare_operand_a(input logic [63:0] value, input logic zero_extend, input logic [1:0] shift);
    logic [63:0] extended;
    extended = zero_extend ? {32'd0, value[31:0]} : value;
    return extended << shift;
  endfunction
  // Operand B: rs2 or the immediate, then Zbs's single bit (a 6-to-64 decoder) and the Zbb / Zbs inversion
  function automatic logic [63:0] prepare_operand_b(input logic [63:0] value, input logic invert, input logic single_bit);
    logic [63:0] chosen;
    chosen = single_bit ? (64'd1 << value[5:0]) : value;
    return invert ? ~chosen : chosen;
  endfunction
  logic [63:0] DECODE_EARLY_ALU_INPUT_A, DECODE_EARLY_ALU_INPUT_B, DECODE_LATE_ALU_INPUT_A, DECODE_LATE_ALU_INPUT_B;
  logic [63:0] DECODE_ALU_INPUT_A, DECODE_ALU_INPUT_B;
  assign DECODE_EARLY_ALU_INPUT_A = DECODE_ALU_INPUT_A_IS_PC ? DECODE_PC : prepare_operand_a(DECODE_EARLY_REGISTER1_DATA, DECODE_ALU_OPERAND_A_ZERO_EXTEND, DECODE_ALU_OPERAND_A_SHIFT);
  assign DECODE_EARLY_ALU_INPUT_B = prepare_operand_b(DECODE_ALU_INPUT_B_IS_IMMEDIATE ? DECODE_IMMEDIATE : DECODE_EARLY_REGISTER2_DATA, DECODE_ALU_OPERAND_B_INVERT, DECODE_ALU_OPERAND_B_SINGLE_BIT);
  // FAST_ALU: the late path does not prepare operand A either (the zero-extend and shift multiplexers would sit in
  // the loop): a Zba shNadd / .uw whose rs1 EXECUTE is computing right now waits one cycle (PREPARED_OPERAND_HAZARD).
  assign DECODE_LATE_ALU_INPUT_A = FAST_ALU ? EXECUTE_FORWARD_DATA : prepare_operand_a(EXECUTE_FORWARD_DATA, DECODE_ALU_OPERAND_A_ZERO_EXTEND, DECODE_ALU_OPERAND_A_SHIFT);
  assign PREPARED_OPERAND_HAZARD = FAST_ALU && HAZARD_PREPARED_REGISTER1 && DECODE_REGISTER1_FROM_EXECUTE;
  // The late (EXECUTE-forwarded) path only inverts: the 6-to-64 single-bit decoder would sit in the ALU's
  // one-cycle loop (measured: 485 ps -> 571 ps at 7 nm). A bset / bclr / binv whose bit number EXECUTE is
  // computing right now waits one cycle instead (SINGLE_BIT_HAZARD) and takes it from MEMORY, early.
  assign DECODE_LATE_ALU_INPUT_B = DECODE_ALU_OPERAND_B_INVERT ? ~EXECUTE_FORWARD_DATA : EXECUTE_FORWARD_DATA;
  assign SINGLE_BIT_HAZARD = HAZARD_SINGLE_BIT_FROM_REGISTER2 && DECODE_REGISTER2_FROM_EXECUTE;
  assign DECODE_ALU_INPUT_A = (DECODE_REGISTER1_FROM_EXECUTE && !DECODE_ALU_INPUT_A_IS_PC) ? DECODE_LATE_ALU_INPUT_A : DECODE_EARLY_ALU_INPUT_A;
  assign DECODE_ALU_INPUT_B = (DECODE_REGISTER2_FROM_EXECUTE && !DECODE_ALU_INPUT_B_IS_IMMEDIATE) ? DECODE_LATE_ALU_INPUT_B : DECODE_EARLY_ALU_INPUT_B;

  // Which custom instruction (src/Custom_Unit.sv): decoded here, used in EXECUTE
  logic [31:0] DECODE_CUSTOM_SELECT, EXECUTE_CUSTOM_SELECT;
  CustomDecode #(.XCOMPUTE (XCOMPUTE)) custom_decode (
    .FUNCT3 (DECODE_INSTRUCTION[14:12]),
    .FUNCT7 (DECODE_INSTRUCTION[31:25]),
    .SELECT (DECODE_CUSTOM_SELECT)
  );

  ImmediateGenerator immediate_generator (
    .INSTRUCTION (DECODE_INSTRUCTION),
    .IMMEDIATE_TYPE_SELECT (DECODE_IMMEDIATE_TYPE_SELECT),
    .IMMEDIATE (DECODE_IMMEDIATE)
  );

  // ========== Execute Stage Signals: ==========
  // EXECUTE_PC is declared next to the Branch Target Buffer (it is written from Execute)
  logic [31:0] EXECUTE_INSTRUCTION; // Instruction at the Execute Stage
  logic [63:0] EXECUTE_REGISTER1_DATA; // Register1 Data at the Execute Stage (Forwarding already resolved)
  logic [63:0] EXECUTE_REGISTER2_DATA; // Register2 Data at the Execute Stage (Forwarding already resolved)
  logic [63:0] EXECUTE_IMMEDIATE; // Immediate at the Execute Stage
  logic [2:0] EXECUTE_FUNCT3; // Funct3 at the Execute Stage used for the Branch Comparator and Loading/Storing Control
  logic [11:0] EXECUTE_CSR_ADDRESS; // Control Status Register at the Execute Stage
  logic EXECUTE_MEMORY_WRITE_ENABLE; // Determine if this is a store at the Execute Stage
  logic EXECUTE_CSR_WRITE_ENABLE; // Determine if the Control Status Register needs to be written to at the Execute Stage
  logic EXECUTE_CSR_WRITE_USING_IMMEDIATE; // Determine if the Control Status Register needs to be written to (with immediate) at the Execute Stage
  logic EXECUTE_ALU_INPUT_A_IS_PC; // ALU A Input at the Execute Stage
  logic EXECUTE_ALU_INPUT_B_IS_IMMEDIATE; // ALU B Input at the Execute Stage select
  logic EXECUTE_ALU_IS_WORD_OPERATION; // RV64 Word operation at the Execute Stage
  logic EXECUTE_IS_A_MULTIPLY_DIVIDE_INSTRUCTION; // RV64M instruction at the Execute Stage
  logic EXECUTE_IS_A_JALR_INSTRUCTION; // Is JALR Instruction? at the Execute Stage
  logic EXECUTE_PREDICTED_BRANCH_TAKEN; // Store Fetch prediction at the Execute Stage
  logic EXECUTE_RETURN_PREDICTED; // FETCH2 redirected this return using the Return Address Stack
  logic EXECUTE_IS_AN_ECALL, EXECUTE_IS_AN_EBREAK, EXECUTE_IS_AN_MRET;
  logic EXECUTE_IS_A_FENCE_I; // flushes like a trap and restarts FETCH1 at PC + 4
  logic EXECUTE_IS_AN_INTERRUPT, EXECUTE_INTERRUPT_IS_EXTERNAL; // an interrupt travelling as a pseudo-instruction
  logic EXECUTE_TAKES_TRAP; // ecall or ebreak: jump to mtvec
  logic EXECUTE_RETURNS_FROM_TRAP; // mret: jump to mepc
  logic [63:0] TRAP_VECTOR, EXCEPTION_PC; // mtvec, mepc
  logic [63:0] EXECUTE_REDIRECT_PC; // Where Fetch 1 restarts after a flush
  writeback_select_t EXECUTE_WRITEBACK_SELECT; // Writeback logic in Execute Stage
  alu_op_t EXECUTE_ALU_OPERATION; // ALU operation in the Execute Stage
  logic EXECUTE_ALU_SUBTRACT; // Decoded one stage early: the adder's subtract control is a flip-flop, not logic after one
  logic [2:0] EXECUTE_MULTIPLY_DIVIDE_PREDECODED; // {A signed, B signed, word divide}, decoded one stage early too

  logic [63:0] EXECUTE_PC_ADD_4; // Hold Next Program Counter at the Execute Stage
  logic [63:0] EXECUTE_ALU_INPUT_A; // ALU input A (register): rs1 or the PC, chosen in DECODE
  logic [63:0] EXECUTE_ALU_INPUT_B; // ALU input B (register): rs2 or the immediate, chosen in DECODE
  logic [63:0] EXECUTE_ALU_OUTPUT; // Raw ALU Output (every operation: goes to MEMORY)
  logic [63:0] EXECUTE_ALU_FAST_OUTPUT; // Every operation except the late ones: what forwarding, addresses and JALR use
  logic [63:0] EXECUTE_ALU_SELECT; // FAST_ALU: the ALU operation, one-hot, plus two group lines (src/ALU.sv)
  logic EXECUTE_LATE_RESULT; // cpop(w), min(u), max(u): result only from MEMORY on (too deep to sit in front of forwarding)
  logic [63:0] EXECUTE_FAST_RESULT; // ALU fast output or the M unit
  logic [63:0] EXECUTE_MULTIPLY_DIVIDE_OUTPUT; // Raw Multiply Divide Unit Output
  logic [63:0] EXECUTE_ALU_RESULT; // Result at the Execute Stage (ALU or Multiply Divide Unit)
  logic [63:0] EXECUTE_JALR_TARGET; // JALR Target Address is Register1 + Immediate and half word aligned by clearing the LSB
  logic EXECUTE_FLUSH; // Control Hazard: Flush when Branch Prediction is wrong (Flush Fetch 1, Fetch 2 and Decode)
  logic [63:0] EXECUTE_ADJUST_NEXT_PC; // Have the good and valid Program Counter in case Flush occurs
  logic [63:0] EXECUTE_CSR_READ_DATA; // Hold Control Status Register Read Value at Execute Stage
  logic [63:0] EXECUTE_CSR_WRITE_DATA; // Write Value to write to Control Status Register
  logic [7:0] EXECUTE_STORE_MASK; // Hold Store Byte Mask at the Execute Stage
  logic [63:0] EXECUTE_STORE_DATA; // Hold Stored Data at the Execute Stage (forced alignment in Store Control)
  logic EXECUTE_WRITES_TOHOST; // This instruction writes the TOHOST CSR (the program is finishing)

  // EXECUTE_PC_ADD_4 is a pipeline register (computed in Fetch 2): no incrementer on the flush path
  // The ALU inputs are chosen in DECODE (DECODE_ALU_INPUT_A/B) and arrive from flip-flops: no multiplexer, and no
  // select signal fanning out to 128 bits, in front of the adder.

  // FAST_ALU: the ALU operation decoded in DECODE, where it is ready early, instead of in EXECUTE, where the
  // comparisons would sit in front of every result bit. Bit k is (operation == k); bit 56 marks the operations
  // whose result is the adder's (ADD SUB JALR SLT SLTU); bit 57 marks a word (W) operation that uses the adder.
  function automatic logic [63:0] alu_select(input alu_op_t operation);
    logic [63:0] select;
    select = 64'd1 << operation;
    select[56] = (operation == ALU_ADD) || (operation == ALU_SUB) || (operation == ALU_JALR) || (operation == ALU_SLT) || (operation == ALU_SLTU);
    select[57] = !((operation == ALU_SLL) || (operation == ALU_SRL) || (operation == ALU_SRA) || (operation == ALU_ROL)
                || (operation == ALU_ROR) || (operation == ALU_CLZ) || (operation == ALU_CTZ) || (operation == ALU_CPOP));
    return select;
  endfunction

  ALU #(.FAST_ALU (FAST_ALU)) alu (
    .OP_SELECT (EXECUTE_ALU_SELECT),
    .A (EXECUTE_ALU_INPUT_A),
    .B (EXECUTE_ALU_INPUT_B),
    .ALUop (EXECUTE_ALU_OPERATION),
    .SUBTRACT_MODE (EXECUTE_ALU_SUBTRACT),
    .ALU_IS_WORD_OPERATION (EXECUTE_ALU_IS_WORD_OPERATION),
    .LATE_RESULT (EXECUTE_LATE_RESULT),
    .ALUOutFast (EXECUTE_ALU_FAST_OUTPUT),
    .ALUOut (EXECUTE_ALU_OUTPUT)
  );

  logic MULTIPLY_DIVIDE_READY; // The M instruction in Execute has its result
  logic [63:0] EXECUTE_MULTIPLY_DIVIDE_LATE_OUTPUT; // FAST_MULTIPLY_DIVIDE: the result in the SIGN cycle (to MEMORY only)
  generate
    if (FAST_M_UNIT) begin : fast_m_extension
      FastMultiplyDivideUnit multiply_divide_unit (
        .clk (clk),
        .reset (reset),
        .FREEZE (FREEZE),
        .REQUEST (EXECUTE_LIVE && EXECUTE_IS_A_MULTIPLY_DIVIDE_INSTRUCTION),
        .A (EXECUTE_REGISTER1_DATA),
        .B (EXECUTE_REGISTER2_DATA),
        .MULTIPLY_DIVIDE_OPERATION (EXECUTE_ALU_OPERATION),
        .IS_WORD_OPERATION (EXECUTE_ALU_IS_WORD_OPERATION),
        .PREDECODED (EXECUTE_MULTIPLY_DIVIDE_PREDECODED),
        .READY (MULTIPLY_DIVIDE_READY),
        .LATE_RESULT (EXECUTE_MULTIPLY_DIVIDE_LATE_OUTPUT)
      );
      assign EXECUTE_MULTIPLY_DIVIDE_OUTPUT = 64'd0; // never forwarded: every M instruction is a late result here
    end else if (ITERATIVE_MULTIPLY_DIVIDE) begin : iterative_m_extension
      IterativeMultiplyDivideUnit multiply_divide_unit (
        .clk (clk),
        .reset (reset),
        .FREEZE (FREEZE),
        .REQUEST (EXECUTE_LIVE && EXECUTE_IS_A_MULTIPLY_DIVIDE_INSTRUCTION),
        .A (EXECUTE_REGISTER1_DATA),
        .B (EXECUTE_REGISTER2_DATA),
        .MULTIPLY_DIVIDE_OPERATION (EXECUTE_ALU_OPERATION),
        .IS_WORD_OPERATION (EXECUTE_ALU_IS_WORD_OPERATION),
        .PREDECODED (EXECUTE_MULTIPLY_DIVIDE_PREDECODED),
        .READY (MULTIPLY_DIVIDE_READY),
        .MULTIPLY_DIVIDE_RESULT (EXECUTE_MULTIPLY_DIVIDE_OUTPUT)
      );
      assign EXECUTE_MULTIPLY_DIVIDE_LATE_OUTPUT = EXECUTE_MULTIPLY_DIVIDE_OUTPUT;
    end else begin : single_cycle_m_extension
      assign EXECUTE_MULTIPLY_DIVIDE_LATE_OUTPUT = EXECUTE_MULTIPLY_DIVIDE_OUTPUT;
      MultiplyDivideUnit multiply_divide_unit (
        .A (EXECUTE_REGISTER1_DATA),
        .B (EXECUTE_REGISTER2_DATA),
        .MULTIPLY_DIVIDE_OPERATION (EXECUTE_ALU_OPERATION),
        .IS_WORD_OPERATION (EXECUTE_ALU_IS_WORD_OPERATION),
        .MULTIPLY_DIVIDE_RESULT (EXECUTE_MULTIPLY_DIVIDE_OUTPUT)
      );
      assign MULTIPLY_DIVIDE_READY = 1'b1;
    end
  endgenerate
  assign MULTIPLY_DIVIDE_STALL = EXECUTE_LIVE && EXECUTE_IS_A_MULTIPLY_DIVIDE_INSTRUCTION && !MULTIPLY_DIVIDE_READY;

  // Your own instructions (custom-0) do not use the ALU's result: their operands go on to MEMORY, where
  // CustomUnit has a whole cycle to itself (see the MEMORY stage below).
  logic EXECUTE_IS_A_CUSTOM_INSTRUCTION;
  assign EXECUTE_IS_A_CUSTOM_INSTRUCTION = (EXECUTE_ALU_OPERATION == ALU_CUSTOM);
  // The first half of every popcount in a custom instruction (and the packed psad.b / pdot / pmulhrs.h's
  // differences and lane products) runs here, on the registered operands, and travels to MEMORY with them
  // (CustomPrepare in src/Custom_Unit.sv): a 64-bit count or a multiply did not fit next to everything else
  // in MEMORY's one cycle. Bits no instruction uses are constant 0 and synthesis removes their flip-flops.
  logic [271:0] EXECUTE_CUSTOM_PREPARED, MEMORY_CUSTOM_PREPARED; // model/custom.js PREPARED_BITS
  CustomPrepare custom_prepare (
    .A (EXECUTE_ALU_INPUT_A),
    .B (EXECUTE_ALU_INPUT_B),
    .SELECT (EXECUTE_CUSTOM_SELECT),
    .PREPARED (EXECUTE_CUSTOM_PREPARED)
  );
  // EXECUTE_ALU_RESULT feeds only the MEMORY pipeline register, so the turbo edition's unregistered M result may
  // use it; forwarding and the data-cache address take EXECUTE_FAST_RESULT, which never sees it.
  assign EXECUTE_ALU_RESULT = EXECUTE_IS_A_MULTIPLY_DIVIDE_INSTRUCTION ? (FAST_M_UNIT ? EXECUTE_MULTIPLY_DIVIDE_LATE_OUTPUT : EXECUTE_MULTIPLY_DIVIDE_OUTPUT) : EXECUTE_ALU_OUTPUT;
  assign EXECUTE_FAST_RESULT = EXECUTE_IS_A_MULTIPLY_DIVIDE_INSTRUCTION ? EXECUTE_MULTIPLY_DIVIDE_OUTPUT : EXECUTE_ALU_FAST_OUTPUT;
  assign EXECUTE_JALR_TARGET = {EXECUTE_ALU_FAST_OUTPUT[63:1], 1'b0}; // JALR requires even addresses (Least Significant Bit forced to 0 to maintain halfword alignment)

  BranchComparator branch_comparator (
    .A (EXECUTE_REGISTER1_DATA),
    .B (EXECUTE_REGISTER2_DATA),
    .BRANCH_FUNCT3 (EXECUTE_FUNCT3),
    .BRANCH_TAKEN (EXECUTE_BRANCH_TAKEN)
  );

  // A predicted return has offset 0, so its real target is rs1 with bit 0 cleared: compare against the register
  // directly (available at the start of the cycle) instead of waiting for the ALU's 64-bit add.
  logic EXECUTE_RETURN_PREDICTION_CORRECT;
  assign EXECUTE_RETURN_PREDICTION_CORRECT = EXECUTE_RETURN_PREDICTED && ({EXECUTE_REGISTER1_DATA[63:1], 1'b0} == EXECUTE_PC_TARGET);

  BranchControl branch_control (
    .IS_A_BRANCH_INSTRUCTION (EXECUTE_IS_A_BRANCH_INSTRUCTION),
    .IS_A_JAL_INSTRUCTION (EXECUTE_IS_A_JAL_INSTRUCTION),
    .IS_A_JALR_INSTRUCTION (EXECUTE_IS_A_JALR_INSTRUCTION),
    .ACTUALLY_TAKEN_BRANCH (EXECUTE_BRANCH_TAKEN),
    .PREDICTED_BRANCH_TAKEN (EXECUTE_PREDICTED_BRANCH_TAKEN),
    .PC_ADD_4 (EXECUTE_PC_ADD_4),
    .BRANCH_TARGET (EXECUTE_PC_TARGET),
    .JALR_TARGET (EXECUTE_JALR_TARGET),
    .JALR_PREDICTION_CORRECT (EXECUTE_RETURN_PREDICTION_CORRECT),
    .BRANCH_WAS_ACTUALLY_TAKEN (EXECUTE_BRANCH_WAS_ACTUALLY_TAKEN),
    .PREDICTION_WAS_WRONG (EXECUTE_PREDICTION_WAS_WRONG),
    .FLUSH (EXECUTE_FLUSH),
    .UPDATE_BRANCH_PREDICTOR (EXECUTE_UPDATE_BRANCH_PREDICTOR),
    .ADJUST_NEXT_PC (EXECUTE_ADJUST_NEXT_PC)
  );

  // Traps: ecall / ebreak jump to mtvec, mret jumps back to mepc. Both flush like a mispredicted branch.
  assign LATE_FLUSH = LATE_BRANCH_RESOLVE && MEMORY_REDIRECT;
  assign EXECUTE_LIVE = EXECUTE_VALID && !LATE_FLUSH;
  assign EXECUTE_TAKES_TRAP = EXECUTE_LIVE && (EXECUTE_IS_AN_ECALL || EXECUTE_IS_AN_EBREAK || EXECUTE_IS_AN_INTERRUPT);
  assign EXECUTE_RETURNS_FROM_TRAP = EXECUTE_LIVE && EXECUTE_IS_AN_MRET;
  // (LATE_BRANCH_RESOLVE: EXECUTE itself flushes only for a trap or mret, so the branch outcome never reaches FETCH1 from here)
  assign EXECUTE_REDIRECT_PC = LATE_FLUSH ? MEMORY_REDIRECT_PC : EXECUTE_TAKES_TRAP ? TRAP_VECTOR
                             // FENCE.I: BranchControl already gives PC + 4 for it; only the late-resolve build needs its own case
                             : (LATE_BRANCH_RESOLVE && EXECUTE_IS_A_FENCE_I) ? EXECUTE_PC_ADD_4
                             : (EXECUTE_RETURNS_FROM_TRAP || LATE_BRANCH_RESOLVE) ? EXCEPTION_PC : EXECUTE_ADJUST_NEXT_PC;
  assign FLUSH_FETCH1_FETCH2_DECODE = LATE_FLUSH || (EXECUTE_LIVE && ((!LATE_BRANCH_RESOLVE && EXECUTE_FLUSH) || EXECUTE_IS_AN_ECALL || EXECUTE_IS_AN_EBREAK || EXECUTE_IS_AN_MRET || EXECUTE_IS_AN_INTERRUPT || EXECUTE_IS_A_FENCE_I)); // Control Hazard: misprediction, JALR, a trap or FENCE.I
  // FENCE.I: the data cache writes through, so main memory already holds every older store; emptying the
  // instruction cache and the BTB at this edge makes FETCH1 read the new code from PC + 4 on
  assign icache_invalidate = ZIFENCEI && !FREEZE && EXECUTE_LIVE && EXECUTE_IS_A_FENCE_I;

  // ========== Interrupts: precise, by replacing the instruction in DECODE ==========
  // When an enabled interrupt is pending, the instruction in DECODE does not go on to EXECUTE. A
  // pseudo-instruction with its PC takes its place: it does nothing but trap, like an ecall with the
  // interrupt's cause. Everything older (EXECUTE, MEMORY, WRITEBACK) finishes normally, everything younger is
  // flushed by the trap, and mret later returns to the replaced instruction, which then runs for real.
  // It is not taken while EXECUTE holds a CSR write, a trap or mret (they may be changing mstatus or mie
  // right now), and it only acts when DECODE advances: the pipeline-register code below applies it in the
  // "no stall, no flush" branch, so the stall and flush signals never enter this (early, registered) logic.
  // The pseudo-instruction never retires: MEMORY gets a bubble, so an interrupt costs 4 bubbles (the flush's
  // 3, plus its own slot): the X term of the equation.
  assign DECODE_TAKES_INTERRUPT = INTERRUPT_REQUEST && DECODE_VALID
    && !(EXECUTE_VALID && (EXECUTE_CSR_WRITE_ENABLE || EXECUTE_IS_AN_ECALL || EXECUTE_IS_AN_EBREAK || EXECUTE_IS_AN_MRET || EXECUTE_IS_AN_INTERRUPT || EXECUTE_IS_A_FENCE_I));
  assign dcache_re = EXECUTE_LIVE && EXECUTE_MEMORY_READ_ENABLE;
  assign DATA_CACHE_STALL = dcache_re && !dcache_hit;
  assign FRONT_END_NOT_STALLED = !DATA_CACHE_STALL && !LOAD_STALL && !MULTIPLY_DIVIDE_STALL;
  assign ADVANCE_FRONT_END = !FLUSH_FETCH1_FETCH2_DECODE && FRONT_END_NOT_STALLED; // The front of the pipeline moves only when nothing is being flushed or stalled
  assign EXECUTE_BTB_UPDATE = BTB_ENABLE && !FREEZE && EXECUTE_LIVE && ((EXECUTE_IS_A_BRANCH_INSTRUCTION && EXECUTE_BRANCH_TAKEN) || EXECUTE_IS_A_JAL_INSTRUCTION);

  // Rewind the Global History on a flush: the checkpoint, plus the real direction if the flushing instruction is itself a branch
  assign EXECUTE_RESTORED_GLOBAL_HISTORY = EXECUTE_IS_A_BRANCH_INSTRUCTION ?
      {EXECUTE_GLOBAL_HISTORY_CHECKPOINT[GSHARE_HISTORY_BITS-2:0], EXECUTE_BRANCH_WAS_ACTUALLY_TAKEN} : EXECUTE_GLOBAL_HISTORY_CHECKPOINT;

  // A store only needs the low 3 address bits to place its bytes, and a store address is always rs1 + imm:
  // a private 3-bit adder gives them without waiting for the 64-bit ALU and its result multiplexer.
  logic [2:0] EXECUTE_STORE_BYTE_OFFSET;
  assign EXECUTE_STORE_BYTE_OFFSET = EXECUTE_REGISTER1_DATA[2:0] + EXECUTE_IMMEDIATE[2:0];

  StoreControl store_control (
    .STORE_FUNCT3 (EXECUTE_FUNCT3),
    .MEMORY_ADDRESS ({EXECUTE_FAST_RESULT[63:3], EXECUTE_STORE_BYTE_OFFSET}),
    .MEMORY_INFO (EXECUTE_REGISTER2_DATA),
    .WRITE_MASK_FOR_STORE (EXECUTE_STORE_MASK),
    .DATA_TO_STORE (EXECUTE_STORE_DATA)
  );

  // Collect Control Status Register Data at the Execute Stage for Memory and Writeback Stage
  assign EXECUTE_CSR_WRITE_DATA = EXECUTE_CSR_WRITE_USING_IMMEDIATE ? {59'd0, EXECUTE_INSTRUCTION[19:15]} : EXECUTE_REGISTER1_DATA;
  assign EXECUTE_WRITES_TOHOST = EXECUTE_CSR_WRITE_ENABLE && (EXECUTE_CSR_ADDRESS == CSR_TOHOST);

  CSRFile control_status_register_file (
    .clk (clk),
    .reset (reset),
    .CSR_WRITE_ENABLE (!FREEZE && EXECUTE_CSR_WRITE_ENABLE && EXECUTE_LIVE),
    .CSR_ADDRESS (EXECUTE_CSR_ADDRESS),
    .CSR_OPERATION (EXECUTE_FUNCT3),
    .CSR_WRITE_DATA (EXECUTE_CSR_WRITE_DATA),
    .INSTRUCTION_RETIRED (WRITEBACK_VALID),
    .PERFORMANCE_EVENTS ({LATE_FLUSH && EXECUTE_VALID, EXECUTE_LIVE && EXECUTE_IS_AN_INTERRUPT, TRACE_DATA_MISS, TRACE_INSTRUCTION_MISS, TRACE_MULTIPLY_DIVIDE_STALL, TRACE_REDIRECT, TRACE_FLUSH, TRACE_LOAD_STALL}),
    .TAKE_TRAP (!FREEZE && EXECUTE_TAKES_TRAP),
    .TRAP_PC (EXECUTE_PC),
    .TRAP_CAUSE (EXECUTE_IS_AN_INTERRUPT ? (EXECUTE_INTERRUPT_IS_EXTERNAL ? CAUSE_MACHINE_EXTERNAL_INTERRUPT : CAUSE_MACHINE_TIMER_INTERRUPT)
                 : EXECUTE_IS_AN_EBREAK ? CAUSE_BREAKPOINT : CAUSE_ENVIRONMENT_CALL),
    .TIMER_INTERRUPT_LINE (TIMER_INTERRUPT_LINE),
    .EXTERNAL_INTERRUPT_LINE (EXTERNAL_INTERRUPT_LINE),
    .INTERRUPT_REQUEST (INTERRUPT_REQUEST),
    .INTERRUPT_IS_EXTERNAL (INTERRUPT_IS_EXTERNAL),
    .RETURN_FROM_TRAP (!FREEZE && EXECUTE_RETURNS_FROM_TRAP),
    .TRAP_VECTOR (TRAP_VECTOR),
    .EXCEPTION_PC (EXCEPTION_PC),
    .CSR_READ_DATA (EXECUTE_CSR_READ_DATA),
    .TOHOST (csr)
  );

  // Execute Writeback to Decode Stage MUX
  always_comb begin
    unique case (EXECUTE_WRITEBACK_SELECT)
      WRITEBACK_ALU: EXECUTE_FORWARD_DATA = EXECUTE_FAST_RESULT; // ALU Result (cpop never forwards from here)
      WRITEBACK_PC_ADD_4: EXECUTE_FORWARD_DATA = EXECUTE_PC_ADD_4; // Program Counter + 4
      WRITEBACK_CSR: EXECUTE_FORWARD_DATA = EXECUTE_CSR_READ_DATA; // Control Status Register Data
      WRITEBACK_MEMORY: EXECUTE_FORWARD_DATA = 64'd0; // Load is not covered instead a load stall is used
      default: EXECUTE_FORWARD_DATA = EXECUTE_FAST_RESULT; // In general the writeback would use the result from the ALU
    endcase
  end

  assign dcache_addr = EXECUTE_FAST_RESULT; // Feed Data Memory the calculated Target Address
  assign dcache_din = EXECUTE_STORE_DATA; // Feed Data Memory Data from Store Instruction
  assign dcache_we = (!FREEZE && EXECUTE_LIVE && EXECUTE_MEMORY_WRITE_ENABLE) ? EXECUTE_STORE_MASK : 8'b0000_0000; // Place Write Mask If the Execute Stage is Valid and a Write

  // ========== Memory Stage Signals: ==========
  logic [63:0] MEMORY_PC; // Keep track of Program Counter at the Memory Stage
  logic [2:0] MEMORY_FUNCT3; // Keep track of the funct3 at the Memory Stage (For Load Alignments)
  logic [63:0] MEMORY_ALU_RESULT; // Keep track of the ALU Result at the Memory Stage
  logic [63:0] MEMORY_PC_ADD_4; // Keep track of the next program counter address at the Memory Stage
  logic [63:0] MEMORY_CSR_READ_DATA; // Control Status Register value read in Execute
  writeback_select_t MEMORY_WRITEBACK_SELECT; // Determine what value from writeback mux to give
  logic [63:0] MEMORY_LOAD_DATA; // Aligned Load Result that will be given by Load Control Unit
  logic [63:0] MEMORY_DATA_CACHE_DATA; // Data Memory's doubleword, captured at the end of Execute (like an SRAM output register)
  logic [63:0] MEMORY_DATA_CACHE_DATA_REGISTER; // ... here, or (SRAM_CACHES) by the data cache's SRAM macros themselves
  assign MEMORY_DATA_CACHE_DATA = SRAM_CACHES ? dcache_dout_late : MEMORY_DATA_CACHE_DATA_REGISTER;
  logic MEMORY_WRITES_TOHOST; // Program finishing instruction in the Memory Stage
  logic MEMORY_REGISTER_WRITE_ENABLE_OUT; // Write enable after the Writeback MUX (same value, kept for the WriteControl interface)
  logic MEMORY_IS_POPULATION_COUNT, MEMORY_POPULATION_COUNT_WORD; // cpop / cpopw: finish the count here
  logic [63:0] MEMORY_CUSTOM_A, MEMORY_CUSTOM_B; // EXECUTE's ALU inputs, one stage later (custom unit, FAST_ALU min / max)
  logic MEMORY_IS_MIN_MAX; // FAST_ALU: min / max finish here (EXECUTE sent only the comparison, in bit 0)
  logic [6:0] MEMORY_POPULATION; // the finished count
  logic [63:0] MEMORY_RESULT; // the ALU result, with cpop's last addition done

  // cpop leaves EXECUTE as four quarter counts (src/Population_Count.sv); its last addition happens here,
  // beside LoadControl's lane selection, so the 64-bit count never has to fit in one EXECUTE cycle
  PopulationCountFinish population_count_finish (
    .QUARTER_COUNTS (MEMORY_ALU_RESULT[19:0]),
    .WORD (MEMORY_POPULATION_COUNT_WORD),
    .COUNT (MEMORY_POPULATION)
  );
  assign MEMORY_RESULT = MEMORY_IS_POPULATION_COUNT ? {57'd0, MEMORY_POPULATION}
                       : MEMORY_IS_MIN_MAX ? (MEMORY_ALU_RESULT[0] ? MEMORY_CUSTOM_A : MEMORY_CUSTOM_B) : MEMORY_ALU_RESULT;

  // FAST_LOAD_ALIGN: which source byte lands in each result byte, and which bytes are sign or zero fill, is
  // decided in EXECUTE from funct3 and the 3-bit address offset (both early there) and registered, so the
  // loaded data reaches the forwarding multiplexers through one AND-OR instead of offset compares and a
  // sign bit that fans out to 56 bits behind a chain of selections. Same values as LoadControl.
  logic [63:0] MEMORY_LOAD_SOURCE; // byte j of the result is byte k of the doubleword: bit 8j + k
  logic [7:0] MEMORY_LOAD_FILL, MEMORY_LOAD_SIGN_SOURCE; // result bytes that are fill; the byte whose bit 7 is the sign
  generate
    if (FAST_LOAD_ALIGN) begin : fast_load_align
      FastLoadControl load_control (
        .SOURCE (MEMORY_LOAD_SOURCE),
        .FILL (MEMORY_LOAD_FILL),
        .SIGN_SOURCE (MEMORY_LOAD_SIGN_SOURCE),
        .MEMORY_INFO (MEMORY_DATA_CACHE_DATA),
        .DATA_TO_LOAD (MEMORY_LOAD_DATA)
      );
    end else begin : load_align
      LoadControl load_control (
        .LOAD_FUNCT3 (MEMORY_FUNCT3), // Determines Load Alignment
        .MEMORY_ADDRESS (MEMORY_ALU_RESULT), // Address to Determine byte, halfword, word, doubleword lane
        .MEMORY_INFO (MEMORY_DATA_CACHE_DATA), // The 64 data bits from the Data Memory
        .DATA_TO_LOAD (MEMORY_LOAD_DATA)
      );
    end
  endgenerate
  logic [63:0] EXECUTE_LOAD_SOURCE;
  logic [7:0] EXECUTE_LOAD_FILL, EXECUTE_LOAD_SIGN_SOURCE;
  LoadLanes load_lanes (
    .LOAD_FUNCT3 (EXECUTE_FUNCT3),
    .OFFSET (EXECUTE_STORE_BYTE_OFFSET), // the address's low 3 bits, from a 3-bit add (the data cache uses it too)
    .SOURCE (EXECUTE_LOAD_SOURCE),
    .FILL (EXECUTE_LOAD_FILL),
    .SIGN_SOURCE (EXECUTE_LOAD_SIGN_SOURCE)
  );

  // Memory Forwarding MUX (the same value is written back one stage later)
  WriteControl write_control (
    .REGISTER_WRITE_ENABLE_INPUT (MEMORY_REGISTER_WRITE_ENABLE),
    .WRITEBACK_SELECT (MEMORY_WRITEBACK_SELECT),
    .ALU_RESULT (MEMORY_RESULT),
    .MEMORY_DATA (MEMORY_LOAD_DATA),
    .PC_ADD_4 (MEMORY_PC_ADD_4),
    .CSR_DATA (MEMORY_CSR_READ_DATA),
    .REGISTER_WRITE_ENABLE_OUTPUT (MEMORY_REGISTER_WRITE_ENABLE_OUT),
    .WRITEBACK_DATA (MEMORY_FORWARD_DATA)
  );

  // Your own instructions (custom-0, src/Custom_Unit.sv generated from custom/instructions.json). Their
  // operands were registered at the end of EXECUTE, so the custom logic has this whole cycle, shared with
  // nothing: its result goes straight into WRITEBACK_DATA, never onto MEMORY's forwarding path. An
  // instruction that needs it waits in DECODE until it reaches WRITEBACK (CUSTOM_HAZARD_REGISTER1/2):
  // two cycles right behind it, one cycle with one instruction in between, none after that.
  logic MEMORY_IS_A_CUSTOM_INSTRUCTION;
  logic [31:0] MEMORY_CUSTOM_SELECT;
  logic [63:0] MEMORY_CUSTOM_OUTPUT;
  CustomUnit custom_unit (
    .A (MEMORY_CUSTOM_A),
    .B (MEMORY_CUSTOM_B),
    .PREPARED (MEMORY_CUSTOM_PREPARED),
    .SELECT (MEMORY_CUSTOM_SELECT),
    .RESULT (MEMORY_CUSTOM_OUTPUT)
  );

  // ========== Writeback Stage Signals: ==========
  logic [63:0] WRITEBACK_PC; // Program Counter of the instruction finishing (trace only)
  logic WRITEBACK_WRITES_TOHOST; // The program finishing instruction reached Writeback
  assign HALT_NOW = !HALTED && WRITEBACK_VALID && WRITEBACK_WRITES_TOHOST && (csr != 64'd0);
  assign FREEZE = HALTED || HALT_NOW;
  // The exact conditions under which the always_ff block below loads FETCH2_INSTRUCTION_REGISTER and
  // MEMORY_DATA_CACHE_DATA_REGISTER: with SRAM_CACHES, the caches read their SRAM macros at these edges instead
  assign icache_capture = !reset && !FREEZE && FRONT_END_NOT_STALLED;
  assign dcache_capture = !reset && !FREEZE;

  // ========== The Clock Edge: every pipeline register captures its stage's result at once ==========
  always_ff @(posedge clk) begin
    if (reset) begin
       // ========== Fetch 1 ==========
      FETCH1_PC <= RESET_VECTOR;
      HALTED <= 1'b0;
      // ========== Fetch 2 ==========
      FETCH2_VALID <= 1'b0;
      FETCH2_PC <= 64'd0;
      FETCH2_PC_ADD_4 <= 64'd4;
      FETCH2_INSTRUCTION_REGISTER <= INSTR_NOP;
      FETCH2_PREDICTED_BRANCH_TAKEN <= 1'b0;
      FETCH2_GSHARE_INDEX <= '0;
      FETCH2_BTB_REDIRECTED <= 1'b0;
      FETCH2_GSHARE_PREDICTED_TAKEN <= 1'b0;
      FETCH2_BHT_PREDICTED_TAKEN <= 1'b0;
      DECODE_GSHARE_PREDICTED_TAKEN <= 1'b0;
      DECODE_BHT_PREDICTED_TAKEN <= 1'b0;
      EXECUTE_GSHARE_PREDICTED_TAKEN <= 1'b0;
      EXECUTE_BHT_PREDICTED_TAKEN <= 1'b0;
       // ========== Decode ==========
      DECODE_VALID <= 1'b0;
      DECODE_PC <= 64'd0;
      DECODE_INSTRUCTION <= INSTR_NOP;
      DECODE_PREDICTED_BRANCH_TAKEN <= 1'b0;
      DECODE_GSHARE_INDEX <= '0;
      DECODE_GLOBAL_HISTORY_CHECKPOINT <= '0;
      DECODE_PC_TARGET <= 64'd0;
      DECODE_PC_ADD_4 <= 64'd0;
      DECODE_RETURN_PREDICTED <= 1'b0;
      DECODE_IS_A_CALL <= 1'b0;
      DECODE_IS_A_RETURN <= 1'b0;
      DECODE_RAS_CHECKPOINT <= '0;
       // ========== Execute ==========
      EXECUTE_VALID <= 1'b0;
      EXECUTE_PC <= 64'd0;
      EXECUTE_INSTRUCTION <= INSTR_NOP;
      EXECUTE_REGISTER1_DATA <= 64'd0;
      EXECUTE_ALU_INPUT_A <= 64'd0;
      EXECUTE_ALU_INPUT_B <= 64'd0;
      EXECUTE_REGISTER2_DATA <= 64'd0;
      EXECUTE_IMMEDIATE <= 64'd0;
      EXECUTE_DESTINATION_REGISTER_ADDRESS <= 5'd0;
      EXECUTE_FUNCT3 <= 3'd0;
      EXECUTE_CSR_ADDRESS <= 12'd0;
      EXECUTE_REGISTER_WRITE_ENABLE <= 1'b0;
      EXECUTE_MEMORY_READ_ENABLE <= 1'b0;
      EXECUTE_MEMORY_WRITE_ENABLE <= 1'b0;
      EXECUTE_CSR_WRITE_ENABLE <= 1'b0;
      EXECUTE_CSR_WRITE_USING_IMMEDIATE <= 1'b0;
      EXECUTE_ALU_INPUT_A_IS_PC <= 1'b0;
      EXECUTE_ALU_INPUT_B_IS_IMMEDIATE <= 1'b0;
      EXECUTE_ALU_IS_WORD_OPERATION <= 1'b0;
      EXECUTE_IS_A_MULTIPLY_DIVIDE_INSTRUCTION <= 1'b0;
      EXECUTE_IS_A_BRANCH_INSTRUCTION <= 1'b0;
      EXECUTE_IS_A_JAL_INSTRUCTION <= 1'b0;
      EXECUTE_IS_A_JALR_INSTRUCTION <= 1'b0;
      EXECUTE_PREDICTED_BRANCH_TAKEN <= 1'b0;
      EXECUTE_GSHARE_INDEX <= '0;
      EXECUTE_GLOBAL_HISTORY_CHECKPOINT <= '0;
      EXECUTE_WRITEBACK_SELECT <= WRITEBACK_ALU;
      EXECUTE_ALU_OPERATION <= ALU_XXX;
      EXECUTE_ALU_SUBTRACT <= 1'b0;
      EXECUTE_LATE_RESULT <= 1'b0;
      EXECUTE_ALU_SELECT <= 64'd0;
      EXECUTE_CUSTOM_SELECT <= 32'd0;
      EXECUTE_MULTIPLY_DIVIDE_PREDECODED <= 3'b000;
      EXECUTE_PC_TARGET <= 64'd0;
      EXECUTE_PC_ADD_4 <= 64'd0;
      EXECUTE_RETURN_PREDICTED <= 1'b0;
      EXECUTE_IS_A_CALL <= 1'b0;
      EXECUTE_IS_A_RETURN <= 1'b0;
      EXECUTE_RAS_CHECKPOINT <= '0;
      EXECUTE_IS_AN_ECALL <= 1'b0;
      EXECUTE_IS_AN_EBREAK <= 1'b0;
      EXECUTE_IS_AN_MRET <= 1'b0;
      EXECUTE_IS_A_FENCE_I <= 1'b0;
      EXECUTE_IS_AN_INTERRUPT <= 1'b0;
      EXECUTE_INTERRUPT_IS_EXTERNAL <= 1'b0;
      // ========== Memory ==========
      MEMORY_VALID <= 1'b0;
      MEMORY_REDIRECT <= 1'b0;
      MEMORY_BRANCH_UPDATE <= 1'b0;
      MEMORY_BTB_UPDATE <= 1'b0;
      MEMORY_PC <= 64'd0;
      MEMORY_DESTINATION_REGISTER_ADDRESS <= 5'd0;
      MEMORY_FUNCT3 <= 3'd0;
      MEMORY_LOAD_SOURCE <= 64'd0;
      MEMORY_LOAD_FILL <= 8'd0;
      MEMORY_LOAD_SIGN_SOURCE <= 8'd0;
      MEMORY_ALU_RESULT <= 64'd0;
      MEMORY_IS_A_CUSTOM_INSTRUCTION <= 1'b0;
      MEMORY_CUSTOM_SELECT <= 32'd0;
      MEMORY_CUSTOM_A <= 64'd0;
      MEMORY_CUSTOM_B <= 64'd0;
      MEMORY_CUSTOM_PREPARED <= '0;
      MEMORY_IS_POPULATION_COUNT <= 1'b0;
      MEMORY_IS_MIN_MAX <= 1'b0;
      MEMORY_POPULATION_COUNT_WORD <= 1'b0;
      MEMORY_PC_ADD_4 <= 64'd0;
      MEMORY_CSR_READ_DATA <= 64'd0;
      MEMORY_REGISTER_WRITE_ENABLE <= 1'b0;
      MEMORY_WRITEBACK_SELECT <= WRITEBACK_ALU;
      MEMORY_DATA_CACHE_DATA_REGISTER <= 64'd0;
      MEMORY_WRITES_TOHOST <= 1'b0;
       // ========== Writeback ==========
      WRITEBACK_VALID <= 1'b0;
      WRITEBACK_PC <= 64'd0;
      WRITEBACK_DESTINATION_REGISTER_ADDRESS <= 5'd0;
      WRITEBACK_REGISTER_WRITE_ENABLE <= 1'b0;
      WRITEBACK_DATA <= 64'd0;
      WRITEBACK_WRITES_TOHOST <= 1'b0;
    end
    else if (HALTED) begin
      // Program finished: freeze the whole pipeline so the testbench can read the final registers
    end
    else if (HALT_NOW) begin
      HALTED <= 1'b1; // The TOHOST write has retired: every older instruction has written back too
    end
    else begin
      // Advance Execute to Memory (always: the Execute instruction is never flushed, even when it causes a flush)
      MEMORY_VALID <= EXECUTE_LIVE && !EXECUTE_IS_AN_INTERRUPT; // the interrupt pseudo-instruction never retires
      // LATE_BRANCH_RESOLVE: what the branch / JALR found out, acted on next cycle from MEMORY
      MEMORY_REDIRECT <= LATE_BRANCH_RESOLVE && EXECUTE_LIVE && EXECUTE_FLUSH;
      MEMORY_REDIRECT_PC <= EXECUTE_ADJUST_NEXT_PC;
      MEMORY_RESTORED_GLOBAL_HISTORY <= EXECUTE_RESTORED_GLOBAL_HISTORY;
      MEMORY_RAS_RESTORE_POINTER <= EXECUTE_RAS_RESTORE_POINTER;
      MEMORY_BRANCH_UPDATE <= LATE_BRANCH_RESOLVE && EXECUTE_LIVE && EXECUTE_UPDATE_BRANCH_PREDICTOR;
      MEMORY_BRANCH_TAKEN <= EXECUTE_BRANCH_WAS_ACTUALLY_TAKEN;
      MEMORY_GSHARE_INDEX <= EXECUTE_GSHARE_INDEX;
      MEMORY_GSHARE_PREDICTED_TAKEN <= EXECUTE_GSHARE_PREDICTED_TAKEN;
      MEMORY_BHT_PREDICTED_TAKEN <= EXECUTE_BHT_PREDICTED_TAKEN;
      MEMORY_BTB_UPDATE <= LATE_BRANCH_RESOLVE && BTB_ENABLE && EXECUTE_LIVE && ((EXECUTE_IS_A_BRANCH_INSTRUCTION && EXECUTE_BRANCH_TAKEN) || EXECUTE_IS_A_JAL_INSTRUCTION);
      MEMORY_PC_TARGET <= EXECUTE_PC_TARGET;
      MEMORY_IS_A_JAL <= EXECUTE_IS_A_JAL_INSTRUCTION;
      MEMORY_PC <= EXECUTE_PC; // Update Memory Program Counter
      MEMORY_DESTINATION_REGISTER_ADDRESS <= EXECUTE_DESTINATION_REGISTER_ADDRESS; // Update Memory Destination Register Address
      MEMORY_FUNCT3 <= EXECUTE_FUNCT3; // Update Memory Funct3
      MEMORY_LOAD_SOURCE <= FAST_LOAD_ALIGN ? EXECUTE_LOAD_SOURCE : 64'd0;
      MEMORY_LOAD_FILL <= FAST_LOAD_ALIGN ? EXECUTE_LOAD_FILL : 8'd0;
      MEMORY_LOAD_SIGN_SOURCE <= FAST_LOAD_ALIGN ? EXECUTE_LOAD_SIGN_SOURCE : 8'd0;
      MEMORY_ALU_RESULT <= EXECUTE_ALU_RESULT; // Update Memory ALU Result
      MEMORY_IS_A_CUSTOM_INSTRUCTION <= EXECUTE_LIVE && !EXECUTE_IS_AN_INTERRUPT && EXECUTE_IS_A_CUSTOM_INSTRUCTION;
      MEMORY_CUSTOM_SELECT <= EXECUTE_CUSTOM_SELECT;
      MEMORY_CUSTOM_A <= EXECUTE_ALU_INPUT_A;
      MEMORY_CUSTOM_B <= EXECUTE_ALU_INPUT_B;
      MEMORY_CUSTOM_PREPARED <= EXECUTE_CUSTOM_PREPARED;
      MEMORY_IS_POPULATION_COUNT <= !EXECUTE_IS_A_MULTIPLY_DIVIDE_INSTRUCTION && (EXECUTE_ALU_OPERATION == ALU_CPOP);
      MEMORY_IS_MIN_MAX <= FAST_ALU && ((EXECUTE_ALU_OPERATION == ALU_MIN) || (EXECUTE_ALU_OPERATION == ALU_MINU) || (EXECUTE_ALU_OPERATION == ALU_MAX) || (EXECUTE_ALU_OPERATION == ALU_MAXU));
      MEMORY_POPULATION_COUNT_WORD <= EXECUTE_ALU_IS_WORD_OPERATION;
      MEMORY_PC_ADD_4 <= EXECUTE_PC_ADD_4; // Update Memory Program Counter + 4
      MEMORY_CSR_READ_DATA <= EXECUTE_CSR_READ_DATA; // Update Control Status Register Read Data
      MEMORY_REGISTER_WRITE_ENABLE <= EXECUTE_REGISTER_WRITE_ENABLE; // Update Register Write Enable Signal
      MEMORY_WRITEBACK_SELECT <= EXECUTE_WRITEBACK_SELECT; // Update Memory Writeback Select MUX Output Selection
      MEMORY_DATA_CACHE_DATA_REGISTER <= dcache_dout; // Capture Data Memory's response data for Load Control
      MEMORY_WRITES_TOHOST <= EXECUTE_LIVE && EXECUTE_WRITES_TOHOST;

      // Advance Memory to Writeback
      WRITEBACK_VALID <= MEMORY_VALID;
      WRITEBACK_PC <= MEMORY_PC;
      WRITEBACK_DESTINATION_REGISTER_ADDRESS <= MEMORY_DESTINATION_REGISTER_ADDRESS;
      WRITEBACK_REGISTER_WRITE_ENABLE <= MEMORY_REGISTER_WRITE_ENABLE_OUT;
      WRITEBACK_DATA <= MEMORY_IS_A_CUSTOM_INSTRUCTION ? MEMORY_CUSTOM_OUTPUT : MEMORY_FORWARD_DATA; // Memory Stage Writeback MUX (or a custom result)
      WRITEBACK_WRITES_TOHOST <= MEMORY_WRITES_TOHOST;

      // Operand registers of Execute: they cause nothing by themselves (every side effect is gated by
      // EXECUTE_VALID and the enables below), so they only need to HOLD while an instruction is kept in
      // Execute (cache miss, multiply/divide). On a flush or a load stall they may load freely: Execute
      // holds a bubble then. Their enable therefore never waits for the branch outcome, which removes the
      // branch compare -> FLUSH -> enable of ~1,000 flip-flops path.
      if (!DATA_CACHE_STALL && !MULTIPLY_DIVIDE_STALL) begin
          EXECUTE_PC <= DECODE_PC;
          EXECUTE_REGISTER1_DATA <= DECODE_FORWARDED_REGISTER1_DATA;
          EXECUTE_ALU_INPUT_A <= DECODE_ALU_INPUT_A;
          EXECUTE_ALU_INPUT_B <= DECODE_ALU_INPUT_B;
          EXECUTE_REGISTER2_DATA <= DECODE_FORWARDED_REGISTER2_DATA;
          EXECUTE_IMMEDIATE <= DECODE_IMMEDIATE;
          EXECUTE_DESTINATION_REGISTER_ADDRESS <= DECODE_DESTINATION_REGISTER_ADDRESS;
          EXECUTE_FUNCT3 <= DECODE_FUNCT3;
          EXECUTE_CSR_ADDRESS <= DECODE_CSR_ADDRESS;
          EXECUTE_CSR_WRITE_USING_IMMEDIATE <= DECODE_CSR_WRITE_USING_IMMEDIATE;
          EXECUTE_ALU_INPUT_A_IS_PC <= DECODE_ALU_INPUT_A_IS_PC;
          EXECUTE_ALU_INPUT_B_IS_IMMEDIATE <= DECODE_ALU_INPUT_B_IS_IMMEDIATE;
          EXECUTE_ALU_IS_WORD_OPERATION <= DECODE_ALU_IS_WORD_OPERATION;
          EXECUTE_PREDICTED_BRANCH_TAKEN <= DECODE_PREDICTED_BRANCH_TAKEN;
          EXECUTE_GSHARE_INDEX <= DECODE_GSHARE_INDEX;
          EXECUTE_GLOBAL_HISTORY_CHECKPOINT <= DECODE_GLOBAL_HISTORY_CHECKPOINT;
          EXECUTE_WRITEBACK_SELECT <= DECODE_WRITEBACK_SELECT;
          EXECUTE_ALU_OPERATION <= DECODE_ALU_OPERATION;
          EXECUTE_ALU_SELECT <= FAST_ALU ? alu_select(DECODE_ALU_OPERATION) : 64'd0;
          EXECUTE_CUSTOM_SELECT <= (DECODE_ALU_OPERATION == ALU_CUSTOM) ? DECODE_CUSTOM_SELECT : 32'd0;
          EXECUTE_LATE_RESULT <= !DECODE_TAKES_INTERRUPT && ((DECODE_ALU_OPERATION == ALU_CPOP) || (DECODE_ALU_OPERATION == ALU_MIN) || (DECODE_ALU_OPERATION == ALU_MINU)
            || (DECODE_ALU_OPERATION == ALU_MAX) || (DECODE_ALU_OPERATION == ALU_MAXU) || (DECODE_ALU_OPERATION == ALU_CUSTOM)
            || (FAST_M_UNIT && DECODE_IS_A_MULTIPLY_DIVIDE_INSTRUCTION) || (FAST_ALU && ((DECODE_ALU_OPERATION == ALU_CLZ) || (DECODE_ALU_OPERATION == ALU_CTZ))));
          EXECUTE_ALU_SUBTRACT <= (DECODE_ALU_OPERATION == ALU_SUB) || (DECODE_ALU_OPERATION == ALU_SLT) || (DECODE_ALU_OPERATION == ALU_SLTU)
            || (DECODE_ALU_OPERATION == ALU_MIN) || (DECODE_ALU_OPERATION == ALU_MINU) || (DECODE_ALU_OPERATION == ALU_MAX) || (DECODE_ALU_OPERATION == ALU_MAXU);
          EXECUTE_MULTIPLY_DIVIDE_PREDECODED <= {
            (DECODE_ALU_OPERATION == ALU_MULH) || (DECODE_ALU_OPERATION == ALU_MULHSU) || (DECODE_ALU_OPERATION == ALU_DIV) || (DECODE_ALU_OPERATION == ALU_REM),
            (DECODE_ALU_OPERATION == ALU_MULH) || (DECODE_ALU_OPERATION == ALU_DIV) || (DECODE_ALU_OPERATION == ALU_REM),
            DECODE_ALU_IS_WORD_OPERATION && ((DECODE_ALU_OPERATION == ALU_DIV) || (DECODE_ALU_OPERATION == ALU_DIVU) || (DECODE_ALU_OPERATION == ALU_REM) || (DECODE_ALU_OPERATION == ALU_REMU))};
          EXECUTE_PC_TARGET <= DECODE_PC_TARGET;
          EXECUTE_PC_ADD_4 <= DECODE_PC_ADD_4;
          EXECUTE_RAS_CHECKPOINT <= DECODE_RAS_CHECKPOINT;
          EXECUTE_GSHARE_PREDICTED_TAKEN <= DECODE_GSHARE_PREDICTED_TAKEN;
          EXECUTE_BHT_PREDICTED_TAKEN <= DECODE_BHT_PREDICTED_TAKEN;
      end

      // Front-end data registers (FETCH2_*, DECODE_*): the same idea. A flush only has to clear FETCH2_VALID and
      // DECODE_VALID; the data behind them may load whatever arrives. Only a stall must hold them.
      if (FRONT_END_NOT_STALLED) begin
          DECODE_PC <= FETCH2_PC;
          DECODE_INSTRUCTION <= FETCH2_INSTRUCTION;
          DECODE_PREDICTED_BRANCH_TAKEN <= FETCH2_PREDICTED_BRANCH_TAKEN;
          DECODE_GSHARE_INDEX <= FETCH2_GSHARE_INDEX;
          DECODE_GLOBAL_HISTORY_CHECKPOINT <= GLOBAL_HISTORY; // History BEFORE this instruction's own speculative update
          DECODE_PC_TARGET <= FETCH2_REDIRECT_TARGET;
          DECODE_PC_ADD_4 <= FETCH2_PC_ADD_4;
          DECODE_RETURN_PREDICTED <= FETCH2_RETURN_PREDICTED;
          DECODE_IS_A_CALL <= RAS_ENABLE && FETCH2_IS_A_CALL;
          DECODE_IS_A_RETURN <= RAS_ENABLE && FETCH2_IS_A_RETURN;
          DECODE_RAS_CHECKPOINT <= RETURN_ADDRESS_STACK_POINTER; // Stack pointer BEFORE this instruction's own push or pop
          DECODE_GSHARE_PREDICTED_TAKEN <= FETCH2_GSHARE_PREDICTED_TAKEN;
          DECODE_BHT_PREDICTED_TAKEN <= FETCH2_BHT_PREDICTED_TAKEN;
          FETCH2_GSHARE_PREDICTED_TAKEN <= FETCH1_GSHARE_PREDICTED_TAKEN;
          FETCH2_BHT_PREDICTED_TAKEN <= FETCH1_BHT_PREDICTED_TAKEN;
          FETCH2_PC <= FETCH1_PC;
          FETCH2_PC_ADD_4 <= FETCH1_PC_ADD_4;
          FETCH2_INSTRUCTION_REGISTER <= icache_dout;
          FETCH2_PREDICTED_BRANCH_TAKEN <= FETCH1_PREDICTED_BRANCH_TAKEN;
          FETCH2_GSHARE_INDEX <= FETCH1_GSHARE_INDEX;
          FETCH2_BTB_REDIRECTED <= FETCH1_BTB_REDIRECT;
      end

      if (FLUSH_FETCH1_FETCH2_DECODE) begin // Control Hazard: Flush Taken (Misprediction occurred, inject NOP into Execute)
        EXECUTE_VALID <= 1'b0;
        EXECUTE_INSTRUCTION <= INSTR_NOP;
        EXECUTE_REGISTER_WRITE_ENABLE <= 1'b0;
        EXECUTE_MEMORY_READ_ENABLE <= 1'b0;
        EXECUTE_MEMORY_WRITE_ENABLE <= 1'b0;
        EXECUTE_CSR_WRITE_ENABLE <= 1'b0;
        EXECUTE_IS_A_BRANCH_INSTRUCTION <= 1'b0;
        EXECUTE_IS_A_JAL_INSTRUCTION <= 1'b0;
        EXECUTE_IS_A_JALR_INSTRUCTION <= 1'b0;
        EXECUTE_IS_AN_ECALL <= 1'b0;
        EXECUTE_IS_AN_EBREAK <= 1'b0;
        EXECUTE_IS_AN_MRET <= 1'b0;
        EXECUTE_IS_A_FENCE_I <= 1'b0;
        EXECUTE_IS_AN_INTERRUPT <= 1'b0;
        // Fetch 2 transition to Decode: the Decode instruction was on the wrong path
        DECODE_VALID <= 1'b0;
        // Fetch 1 Transition to Fetch 2 with Program Counter Update for Fetch 1 and Fetch 2 and Decode Flush
        FETCH1_PC <= EXECUTE_REDIRECT_PC;
        FETCH2_VALID <= 1'b0;
      end
      else if (DATA_CACHE_STALL) begin // The load in Execute is waiting for its cache line (checked before LOAD_STALL:
        // the load must not move on without its data). Everything up to Execute holds; a bubble goes into Memory.
        MEMORY_VALID <= 1'b0;
        MEMORY_REGISTER_WRITE_ENABLE <= 1'b0;
        MEMORY_WRITES_TOHOST <= 1'b0;
      end
      else if (LOAD_STALL) begin // Load Stall:
        // Fetch 1, Fetch 2, Decode do not update for load hazard stall
        // Advance Execute to No Operation (Decode cannot proceed yet so do not do anything in Execute in the meantime)
        EXECUTE_VALID <= 1'b0;
        EXECUTE_INSTRUCTION <= INSTR_NOP;
        EXECUTE_REGISTER_WRITE_ENABLE <= 1'b0;
        EXECUTE_MEMORY_READ_ENABLE <= 1'b0;
        EXECUTE_MEMORY_WRITE_ENABLE <= 1'b0;
        EXECUTE_CSR_WRITE_ENABLE <= 1'b0;
        EXECUTE_IS_A_BRANCH_INSTRUCTION <= 1'b0;
        EXECUTE_IS_A_JAL_INSTRUCTION <= 1'b0;
        EXECUTE_IS_A_JALR_INSTRUCTION <= 1'b0;
        EXECUTE_IS_AN_ECALL <= 1'b0;
        EXECUTE_IS_AN_EBREAK <= 1'b0;
        EXECUTE_IS_AN_MRET <= 1'b0;
        EXECUTE_IS_A_FENCE_I <= 1'b0;
        EXECUTE_IS_AN_INTERRUPT <= 1'b0;
      end
      else if (MULTIPLY_DIVIDE_STALL) begin // The M instruction in Execute needs more cycles:
        // Fetch 1, Fetch 2, Decode and Execute all hold; a bubble goes into Memory (overrides the advance above)
        MEMORY_VALID <= 1'b0;
        MEMORY_REGISTER_WRITE_ENABLE <= 1'b0;
        MEMORY_WRITES_TOHOST <= 1'b0;
      end
      else begin // No Stall Occurring continue normally
        // Continue updated Execute like Normal
        EXECUTE_VALID <= DECODE_VALID;
        EXECUTE_INSTRUCTION <= DECODE_INSTRUCTION;
        EXECUTE_REGISTER_WRITE_ENABLE <= DECODE_REGISTER_WRITE_ENABLE;
        EXECUTE_MEMORY_READ_ENABLE <= DECODE_MEMORY_READ_ENABLE;
        EXECUTE_MEMORY_WRITE_ENABLE <= DECODE_MEMORY_WRITE_ENABLE;
        EXECUTE_CSR_WRITE_ENABLE <= DECODE_CSR_WRITE_ENABLE;
        EXECUTE_IS_A_MULTIPLY_DIVIDE_INSTRUCTION <= DECODE_IS_A_MULTIPLY_DIVIDE_INSTRUCTION;
        EXECUTE_IS_A_BRANCH_INSTRUCTION <= DECODE_IS_A_BRANCH_INSTRUCTION;
        EXECUTE_IS_A_JAL_INSTRUCTION <= DECODE_IS_A_JAL_INSTRUCTION;
        EXECUTE_IS_A_JALR_INSTRUCTION <= DECODE_IS_A_JALR_INSTRUCTION;
        EXECUTE_RETURN_PREDICTED <= DECODE_RETURN_PREDICTED;
        EXECUTE_IS_A_CALL <= DECODE_IS_A_CALL;
        EXECUTE_IS_A_RETURN <= DECODE_IS_A_RETURN;
        EXECUTE_IS_AN_ECALL <= DECODE_IS_AN_ECALL;
        EXECUTE_IS_AN_EBREAK <= DECODE_IS_AN_EBREAK;
        EXECUTE_IS_AN_MRET <= DECODE_IS_AN_MRET;
        EXECUTE_IS_A_FENCE_I <= DECODE_IS_A_FENCE_I;
        EXECUTE_IS_AN_INTERRUPT <= 1'b0;
        EXECUTE_INTERRUPT_IS_EXTERNAL <= INTERRUPT_IS_EXTERNAL;
        if (DECODE_TAKES_INTERRUPT) begin // the DECODE instruction stays behind; the interrupt goes in its place
          EXECUTE_REGISTER_WRITE_ENABLE <= 1'b0;
          EXECUTE_MEMORY_READ_ENABLE <= 1'b0;
          EXECUTE_MEMORY_WRITE_ENABLE <= 1'b0;
          EXECUTE_CSR_WRITE_ENABLE <= 1'b0;
          EXECUTE_IS_A_MULTIPLY_DIVIDE_INSTRUCTION <= 1'b0;
          EXECUTE_IS_A_BRANCH_INSTRUCTION <= 1'b0;
          EXECUTE_IS_A_JAL_INSTRUCTION <= 1'b0;
          EXECUTE_IS_A_JALR_INSTRUCTION <= 1'b0;
          EXECUTE_RETURN_PREDICTED <= 1'b0;
          EXECUTE_IS_A_CALL <= 1'b0; // so the flush restores the return address stack to before this instruction
          EXECUTE_IS_A_RETURN <= 1'b0;
          EXECUTE_IS_AN_ECALL <= 1'b0;
          EXECUTE_IS_AN_EBREAK <= 1'b0;
          EXECUTE_IS_AN_MRET <= 1'b0;
          EXECUTE_IS_A_FENCE_I <= 1'b0;
          EXECUTE_IS_AN_INTERRUPT <= 1'b1;
        end

        // Fetch 2 to Decode
        DECODE_VALID <= FETCH2_VALID;

        // Fetch 1 to Fetch 2 (the instruction fetched behind a predicted-taken branch or a JAL is on the wrong path)
        FETCH2_VALID <= !FETCH2_BRANCH_OFF_OR_CONTINUE && icache_hit; // wrong path behind a redirect, or no instruction yet (cache miss)
        FETCH1_PC <= FETCH2_PREDICTED_NEXT_PC;
      end
    end
  end

  // ========== Trace (what is in every stage this cycle) ==========
  assign TRACE_VALID = {WRITEBACK_VALID, MEMORY_VALID, EXECUTE_VALID, DECODE_VALID, FETCH2_VALID, 1'b1};
  assign TRACE_FETCH1_PC = FETCH1_PC;
  assign TRACE_FETCH2_PC = FETCH2_PC;
  assign TRACE_DECODE_PC = DECODE_PC;
  assign TRACE_EXECUTE_PC = EXECUTE_PC;
  assign TRACE_MEMORY_PC = MEMORY_PC;
  assign TRACE_WRITEBACK_PC = WRITEBACK_PC;
  assign TRACE_LOAD_STALL = LOAD_STALL && !FLUSH_FETCH1_FETCH2_DECODE && !DATA_CACHE_STALL;
  assign TRACE_INSTRUCTION_MISS = ADVANCE_FRONT_END && !FETCH2_BRANCH_OFF_OR_CONTINUE && !icache_hit;
  assign TRACE_DATA_MISS = DATA_CACHE_STALL && !FLUSH_FETCH1_FETCH2_DECODE;
  assign TRACE_FLUSH = FLUSH_FETCH1_FETCH2_DECODE;
  assign TRACE_REDIRECT = FETCH2_BRANCH_OFF_OR_CONTINUE && ADVANCE_FRONT_END;
  assign TRACE_MULTIPLY_DIVIDE_STALL = MULTIPLY_DIVIDE_STALL && !FLUSH_FETCH1_FETCH2_DECODE;

  /* verilator lint_off UNUSEDSIGNAL */
  logic UNUSED_SIGNALS; // Kept for waveforms and for symmetry with the original design
  assign UNUSED_SIGNALS = ^{EXECUTE_PREDICTION_WAS_WRONG, EXECUTE_IMMEDIATE[0], MEMORY_PC[0], MEMORY_REGISTER_WRITE_ENABLE_OUT};
  /* verilator lint_on UNUSEDSIGNAL */

endmodule

`default_nettype wire
