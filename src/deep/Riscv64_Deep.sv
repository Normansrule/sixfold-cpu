`default_nettype none

import const_pkg::*;
import opcode_pkg::*;
import immediate_op_pkg::*;
import alu_op_pkg::*;
import writeback_op_pkg::*;
import deep_whole_pkg::*;

// =====================================================================================================
// Riscv64Deep: the deep-pipeline edition (cycle-exact twin: model/deep.js; read its header first)
//
//   F1 F2 F3 F4 D1 D2 | X1 X2 X3 X4 | M1 M2 M3 | W
//
// Only D2 ever stalls. Everything behind it moves one stage per cycle, so every back-end loop closes in one
// short stage. Each back-end slot carries its instruction's decoded control, where its operands come from
// (the DISTANCE back to the instruction that writes them, or the register file), and its RESULT once made.
// An operand is read in the stage that uses it: from the producer's slot, DISTANCE + that stage further on,
// or from the register file once the producer has written it. The issue check in D2 guarantees the producer
// made it in an earlier cycle.
//
// Where the work sits (docs/DEEP_PIPELINE.md has the full table and the measured times):
//   F1  next PC: PC + 4, or the BTB's target (its own direction counter, so no predictor table is in this loop)
//   F2  the instruction cache's arrays are read (a clocked SRAM read at F2's PC); the predictors' guess rides along
//   F3  tag compare and way select: the hit, the way, the word and its predecode are registered for F4
//   F4  F4 redirects a predicted jump the BTB missed (predecoded kind and target from the cache), decodes the word
//       (ControlUnit) and marks the line used; a miss restarts F1 there, which asks for the line
//   D1  immediate, timing class, the BTB's guess checked; D2 the issue check (the only stall) and the register file
//   X1..X4  the staggered ALU, 16 bits per stage (add, logic, compare, address); X3 + X4 the whole-value unit
//       (shifts, Zbb, Zbs, Zknh); X4 reads the data cache's arrays at the set X1 made
//   M1  tag compare, load data, stores, CSRs, branch / jump repair (the commit point); M2 load alignment, the
//       custom chain's result; M3, W the register file write
// =====================================================================================================
module Riscv64Deep #(
  parameter int GSHARE_HISTORY_BITS = 6,
  parameter bit XCOMPUTE = 1'b1, // the packed compute instructions (custom-0 group "xcompute"); on in this edition
  parameter int MISS_LATENCY = 12 // a miss takes as long in nanoseconds as the turbo edition's 10 cycles (12 x 466 ps >= 10 x 535 ps)
) (
  input  logic        clk,
  input  logic        reset,
  input  logic        BRANCH_PREDICTION_ENABLE,
  input  logic        TIMER_INTERRUPT_LINE,
  input  logic        EXTERNAL_INTERRUPT_LINE,
  input  logic [31:0] RESET_VECTOR,
  // main memory: refills, and the stores and device reads of M1
  output logic [63:0] INSTRUCTION_REFILL_ADDRESS,
  input  logic [255:0] INSTRUCTION_REFILL_LINE,
  output logic [63:0] DATA_REFILL_ADDRESS,
  input  logic [255:0] DATA_REFILL_LINE,
  output logic [63:0] DATA_ADDRESS,
  output logic [7:0]  DATA_WRITE_MASK,
  output logic [63:0] DATA_WRITE_DATA,
  input  logic [63:0] DEVICE_READ_DATA, // what a device address reads (the machine timer; 0 otherwise)
  output logic [63:0] csr, // TOHOST
  output logic        HALTED,
  input  logic [4:0]  DEBUG_REGISTER_ADDRESS,
  output logic [63:0] DEBUG_REGISTER_DATA,
  output logic [13:0] TRACE_VALID, // F1 F2 F3 F4 D1 D2 X1 X2 X3 X4 M1 M2 M3 W (bit 0 = F1)
  output logic [31:0] TRACE_PC [0:13],
  output logic [7:0]  TRACE_FLAGS // {INTR, REPLAY, DMISS, IMISS, BUSY, REDIRECT, FLUSH, STALL}
);
  localparam int H = GSHARE_HISTORY_BITS;
  // why a slot holds no instruction (the counters count these as they reach W)
  localparam logic [2:0] CAUSE_FILL = 3'd0, CAUSE_FLUSH = 3'd1, CAUSE_REDIRECT = 3'd2, CAUSE_IMISS = 3'd3,
                         CAUSE_DMISS = 3'd4, CAUSE_INTERRUPT = 3'd5, CAUSE_STALL = 3'd6, CAUSE_MDU = 3'd7;
  localparam int REPLAY_LEAD = 10; // F1 to M1
  localparam int FETCH_LEAD = 2; // F1 to F3

  // ================================================================ slots
  typedef struct packed {
    logic valid; logic [2:0] cause; logic depth; // an instruction, or a bubble with its cause
    logic [31:0] pc;
    logic pred; logic [H-1:0] gidx; logic gtaken, btaken; // the predictors' guesses from F1
    logic btb_go; logic [31:0] btb_target; // the BTB already sent F1 on to btb_target
  } fetch_slot_t;
  typedef struct packed {
    logic register_write;
    logic memory_read;
    logic memory_write;
    logic csr_write;
    logic csr_immediate;
    logic a_is_pc;
    logic b_is_immediate;
    logic is_word;
    logic is_muldiv;
    logic is_branch;
    logic is_jal;
    logic is_jalr;
    logic is_ecall;
    logic is_ebreak;
    logic is_mret;
    logic uses1;
    logic uses2;
    logic a_zext;
    logic inv_b;
    logic one_b;
    logic [1:0] a_shift;
    writeback_select_t wb_sel;
    alu_op_t alu_op;
    logic [63:0] immediate;
    logic [31:0] custom_select;
    logic system;
    logic custom;
    logic sliced_producer;
    logic sliced_a;
    logic sliced_b;
    logic at_never;
    logic [2:0] at;
    logic [2:0] need_a;
    logic [2:0] need_b;
    logic a_early; // a sliced consumer that zero-extends or shifts rs1 (Zba): rs1 must be complete at issue, never late
  } decoded_t; // ControlUnit and the timing class, worked out in D1
  typedef struct packed { // ControlUnit's outputs, worked out in F4 from the cached word
    logic register_write, memory_read, memory_write, csr_write, csr_immediate, a_is_pc, b_is_immediate, is_word;
    logic is_muldiv, is_branch, is_jal, is_jalr, is_ecall, is_ebreak, is_mret, uses1, uses2, a_zext, inv_b, one_b;
    logic [1:0] a_shift;
    immediate_type_select_t immediate_type;
    writeback_select_t wb_sel;
    alu_op_t alu_op;
  } control_t;
  typedef struct packed {
    fetch_slot_t f;
    logic [31:0] word;
    control_t ctl; // F4's decode (ControlUnit)
    logic [H-1:0] ckpt; logic [2:0] ras_ckpt; // history and return-stack pointer before this instruction's own update
    logic is_call, is_return; logic [31:0] target, btarget; // F4's predicted next PC, and the branch / JAL target
    logic btb_bad; // D1 found that the BTB sent F1 somewhere other than F4's next PC (only after code changed)
    decoded_t dec; // filled in as the instruction moves from D1 to D2
  } decode_slot_t;
  typedef struct packed {
    logic valid; logic [2:0] cause; logic depth;
    logic [31:0] pc; logic [31:0] word;
    logic reg_write; logic [4:0] rd, rs1, rs2;
    logic [2:0] at; logic at_never; logic sliced; // AT: the stage whose end has the whole result (model/deep.js)
    logic mem_read, mem_write, is_branch, is_jal, is_jalr, is_ecall, is_ebreak, is_mret, is_muldiv, is_custom, is_csr, csr_write, csr_imm;
    logic a_is_pc, b_is_imm, is_word, a_zext; logic [1:0] a_shift; logic inv_b, one_b, subtract, bflip; // bflip = inv_b ^ subtract
    alu_op_t alu_op; writeback_select_t wb_sel; logic [63:0] imm; logic [2:0] funct3;
    logic src_a, src_b; logic [3:0] dist_a, dist_b; // operand from the slot DIST stages ahead at issue (else the register file)
    logic [2:0] md_pre; logic [31:0] custom_select;
    logic pred; logic [H-1:0] gidx; logic gtaken, btaken; logic [H-1:0] ckpt; logic [2:0] ras_ckpt;
    logic is_call, is_return; logic [31:0] target, btarget;
    logic writes_tohost;
    logic is_fence_i; // FENCE.I (Zifencei): flushes at M1, empties the instruction cache and the BTB
    logic btb_bad; // the BTB sent fetch to the wrong place: M1 flushes and restarts at the right next PC
    logic jalr_hit; logic [31:0] alt_pc; logic [2:0] ras_after; // X3: JALR target = predicted; the restart PC unless a
                                                               // taken branch (JALR target, JAL target, PC + 4); the RAS pointer after it
    logic wrong_taken, wrong_not; // X4: this jump went the wrong way if it is taken / not taken (M1 picks with taken)
    logic [63:0] result; // the value for rd (or, for a load in M2, the raw doubleword)
    logic [63:0] address; // X4's adder: the load / store address, the JALR target
    logic taken, lt; // M1's branch outcome and compare (X4's last slice)
    logic [63:0] op_a, op_b; // rs1 / rs2 as gathered so far: read from the register file in D2, then refreshed from the
                             // producer's slot every stage, so each stage finds them complete one stage early
    logic [5:0] late_a, late_b; // stage s (X1 = 0 .. M2 = 5) takes rs1 / rs2 straight from the producer's slot instead:
                                // the producer finished that part only in the cycle before
    logic [4:0] ysel, ysel_hi; // the slices' result, one-hot {b, xor, or, and, sum} (set at issue); _hi for X3 / X4 (none for a word op)
    logic yres, is_slt, lt_signed; // the slices write rd's bits; slt / sltu; X4's less-than is signed
    logic [4:0] xsel_a, xsel_b; // this stage's slice operands, one-hot {prepared xa / xb, M3's slot, M2's, M1's, the slot
                                // right ahead}: late_* and lsel_* folded a stage early, so the slice's operand is one AND-OR
    logic [20:0] csr_sel; // X4: the CSR, one-hot (DeepCSRDecode), so M1's read and write need no address compare
    logic carry, eq; // the sliced adder's carry into the next slice; every slice of A - B so far was zero
    logic [3:0] lsel_a, lsel_b; // where a late operand comes from, one-hot: {M3's slot, M2's, M1's, the slot right ahead}
    logic [63:0] xa, xb; // the slices' operands, prepared one stage early (A: PC, zero-extend, shift; B: immediate,
                         // inverted for andn / orn / xnor and for a subtract), used unless the operand is late
    logic whole; // a result made by the two-stage whole-value unit (X3 prepares, X4 computes)
    logic [63:0] pa, pb; whole_select_t whole_sel; // X3's prepared operands and one-hot result select for X4
    logic [63:0] high, low; // X3's funnel for the shifter
    logic [66:0] right_coarse, left_coarse; logic [1:0] fine; logic [19:0] leading, trailing, quarters; logic [63:0] simple; // X4's part
    logic [47:0] nibbles; logic [11:0] halves; // cpop (X3 to M2)
  } back_slot_t;

  fetch_slot_t F2, F3, F4;
  // what F3's lookup found, for F4: the hit, the way, and both ways' word and predecode (F4 picks the way)
  logic F4_HIT, F4_WAY0, F4_WAY1; logic [31:0] F4_WORD0, F4_WORD1, F4_WORD; logic [35:0] F4_PREDECODE0, F4_PREDECODE1, F4_PREDECODE;
  assign F4_WORD = F4_WAY1 ? F4_WORD1 : F4_WORD0;
  assign F4_PREDECODE = F4_WAY1 ? F4_PREDECODE1 : F4_PREDECODE0;
  decode_slot_t D1, D2;
  decode_slot_t SKID; // between D1 and D2: where D1's instruction waits while D2 holds (only an instruction, never a bubble)
  logic FSTALL;       // the skid slot is full: F1..D1 wait (registered, so D2's hold never reaches them in its own cycle)
  back_slot_t BE [0:7]; // X1 X2 X3 X4 M1 M2 M3 W
  logic [31:0] F1PC;
  logic IWAIT, DWAIT_VALID; // F1 waits for an instruction line / a replayed load's data line
  logic [63:0] DWAIT_LINE;

  // ================================================================ register file (two write ports: W and the M unit)
  logic [63:0] RF [0:31];
  assign DEBUG_REGISTER_DATA = RF[DEBUG_REGISTER_ADDRESS];
  // the result field of the slot DISTANCE + S stages on (the producer, seen from a consumer in stage S)
  function automatic logic [63:0] slot_result(input logic [3:0] distance, input int s,
                                              input logic [63:0] r1, input logic [63:0] r2, input logic [63:0] r3, input logic [63:0] r4, input logic [63:0] r5, input logic [63:0] r6, input logic [63:0] r7);
    unique case (int'(distance) + s)
      1: return r1; 2: return r2; 3: return r3; 4: return r4; 5: return r5; 6: return r6; 7: return r7; default: return 64'd0;
    endcase
  endfunction
  `define SLOT(D, S) slot_result(D, S, BE[1].result, BE[2].result, BE[3].result, BE[4].result, BE[5].result, BE[6].result, BE[7].result)
  // rs1 / rs2 of the instruction in back-end stage S: the gathered value, or (late) straight from the producer
  // A late operand comes from the producer's slot as it finishes: the slot right ahead (slice by slice), or the
  // slot after its AT stage, BE[AT + 1], whatever stage the consumer is in. So it is a 4-way one-hot choice
  // (LSEL, set at issue), never a decode of the distance.
  `define LATE(S, SEL) (({64{SEL[0]}} & BE[(S) + 1].result) | ({64{SEL[1]}} & BE[4].result) | ({64{SEL[2]}} & BE[5].result) | ({64{SEL[3]}} & BE[6].result))
  `define RS1(J, S) (BE[J].late_a[S] ? `LATE(S, BE[J].lsel_a) : BE[J].op_a)
  `define RS2(J, S) (BE[J].late_b[S] ? `LATE(S, BE[J].lsel_b) : BE[J].op_b)
  // what moves on with the instruction: refreshed from the producer's slot while it is still in the pipeline
  `define NEXT_A(J, S) ((BE[J].src_a && (int'(BE[J].dist_a) + S <= 7)) ? `SLOT(BE[J].dist_a, S) : BE[J].op_a)
  `define NEXT_B(J, S) ((BE[J].src_b && (int'(BE[J].dist_b) + S <= 7)) ? `SLOT(BE[J].dist_b, S) : BE[J].op_b)

  // PC + 4 with a parallel-prefix carry (bit i flips when bits 2 .. i-1 are all ones): log depth, not a ripple
  function automatic logic [31:0] plus4(input logic [31:0] pc);
    logic [31:0] all_ones;
    all_ones = pc | 32'h3; // bits 0..1 do not take part
    for (int d = 1; d < 32; d = 2 * d)
      for (int i = 31; i >= d; i--) all_ones[i] = all_ones[i] & all_ones[i - d];
    return {pc[31:2] ^ all_ones[30:1], pc[1:0]};
  endfunction
  function automatic logic [63:0] prepare_a(input logic [63:0] value, input logic zext, input logic [1:0] shift);
    logic [63:0] x;
    x = zext ? {32'd0, value[31:0]} : value;
    return x << shift;
  endfunction
  function automatic logic [63:0] prepare_b(input logic [63:0] value, input logic invert, input logic single_bit);
    logic [63:0] chosen;
    chosen = single_bit ? (64'd1 << value[5:0]) : value;
    return invert ? ~chosen : chosen;
  endfunction

  // ================================================================ control / status registers
  logic CSR_WRITE_ENABLE, TAKE_TRAP, RETURN_FROM_TRAP, INTERRUPT_REQUEST, INTERRUPT_IS_EXTERNAL;
  // the request D2 acts on, registered: a cycle late, and dropped for a cycle after anything that changes the CSRs
  // (a CSR write, mret, a trap), so a request just disabled is never taken
  logic INT_REQ, INT_EXT;
  logic [2:0] CSR_OPERATION;
  logic [63:0] CSR_WRITE_DATA, TRAP_PC, TRAP_CAUSE, TRAP_VECTOR, EXCEPTION_PC, CSR_READ_DATA;
  logic [7:0] PERFORMANCE_EVENTS;
  logic INSTRUCTION_RETIRED;
  DeepCSRFile control_status_register_file (
    .clk (clk), .reset (reset),
    .CSR_WRITE_ENABLE (CSR_WRITE_ENABLE), .CSR_SELECT (M.csr_sel), .CSR_OPERATION (CSR_OPERATION), .CSR_WRITE_DATA (CSR_WRITE_DATA),
    .INSTRUCTION_RETIRED (INSTRUCTION_RETIRED), .PERFORMANCE_EVENTS (PERFORMANCE_EVENTS),
    .TAKE_TRAP (TAKE_TRAP), .TRAP_PC (TRAP_PC), .TRAP_CAUSE (TRAP_CAUSE),
    .TIMER_INTERRUPT_LINE (TIMER_INTERRUPT_LINE), .EXTERNAL_INTERRUPT_LINE (EXTERNAL_INTERRUPT_LINE),
    .INTERRUPT_REQUEST (INTERRUPT_REQUEST), .INTERRUPT_IS_EXTERNAL (INTERRUPT_IS_EXTERNAL),
    .RETURN_FROM_TRAP (RETURN_FROM_TRAP), .TRAP_VECTOR (TRAP_VECTOR), .EXCEPTION_PC (EXCEPTION_PC),
    .CSR_READ_DATA (CSR_READ_DATA), .TOHOST (csr)
  );

  // ================================================================ W
  // HALT_NOW: the instruction in W wrote a nonzero tohost. Decided a cycle early (from M3's slot and tohost as it is
  // then) into a register, so FREEZE, which reaches every register, starts from flip-flops
  logic HALT_NOW, FREEZE, HALT_PENDING;
  always_ff @(posedge clk) begin
    if (reset) HALT_PENDING <= 1'b0;
    else if (!FREEZE) HALT_PENDING <= BE[6].valid && BE[6].writes_tohost && (csr != 64'd0);
  end
  assign HALT_NOW = !HALTED && HALT_PENDING;
  assign FREEZE = HALTED || HALT_NOW;
  always_ff @(posedge clk) begin
    if (reset) begin INT_REQ <= 1'b0; INT_EXT <= 1'b0; end
    else if (!FREEZE) begin
      INT_REQ <= INTERRUPT_REQUEST && !CSR_WRITE_ENABLE && !RETURN_FROM_TRAP && !TAKE_TRAP;
      INT_EXT <= INTERRUPT_IS_EXTERNAL;
    end
  end

  // ================================================================ X1..X4: the staggered ALU
  // Adds, subtracts, logic, compares, addresses: slice k (bits 16k .. 16k+15) in stage Xk+1, the carry and the
  // "equal so far" flag passed on in the slot (tools/clock_floor/staggered_alu.sv). Word adds fill bits 32..63
  // with bit 31 (made in X2). The compare (branches, slt, min, max) is the same subtraction, decided in X4.
  logic [63:0] XA [0:3], XB [0:3], XPA [0:3], XPB [0:3];
  logic [15:0] XY [0:3], XSUM [0:3];
  logic XCARRY [0:3], XEQ [0:3];
  for (genvar k = 0; k < 4; k++) begin : slice
    logic [15:0] a, b, b_adder;
    logic carry_in;
    assign XA[k] = `RS1(k, k); // (raw, for the next stage's operands)
    assign XB[k] = `RS2(k, k);
    // (rs1 is never late for a_zext / a_shift: a_early; a late rs2 is inverted for a subtract here, xb already is)
    assign XPA[k] = `LATE(k, BE[k].xsel_a) | ({64{BE[k].xsel_a[4]}} & BE[k].xa);
    assign XPB[k] = (`LATE(k, BE[k].xsel_b) ^ {64{BE[k].bflip && !BE[k].xsel_b[4]}}) | ({64{BE[k].xsel_b[4]}} & BE[k].xb);
    assign a = XPA[k][16*k +: 16];
    assign b = XPB[k][16*k +: 16]; // (already inverted for a subtract)
    assign b_adder = b;
    if (k == 0) begin : first assign carry_in = BE[k].subtract; end
    else begin : later assign carry_in = BE[k].carry; end
    ParallelPrefixAdder #(.WIDTH (16)) adder (.A (a), .B (b_adder), .CARRY_IN (carry_in), .SUM (XSUM[k]), .CARRY_OUT (XCARRY[k]));
    always_comb begin
      logic [4:0] sel;
      sel = (k >= 2) ? BE[k].ysel_hi : BE[k].ysel; // (one-hot, decoded at issue: no compare of alu_op here)
      XY[k] = ({16{sel[0]}} & XSUM[k]) | ({16{sel[1]}} & (a & b)) | ({16{sel[2]}} & (a | b)) | ({16{sel[3]}} & (a ^ b)) | ({16{sel[4]}} & b);
      if (k >= 2) XY[k] = XY[k] | {16{BE[k].is_word && BE[k].address[31]}}; // a word op: bits 32..63 copy bit 31
    end
    // A == B for a subtract (branches): a equals the un-inverted b, so a ^ b is all ones; no wait for the adder
    if (k == 0) begin : first_eq assign XEQ[k] = &(a ^ b); end
    else begin : later_eq assign XEQ[k] = BE[k].eq && &(a ^ b); end
  end
  // X4: the compare is decided (A - B: equal, signed and unsigned less-than)
  logic X4_SLT, X4_SLTU, X4_TAKEN, X4_LT;
  assign X4_SLT = (XPA[3][63] != (XPB[3][63] ^ BE[3].subtract)) ? XPA[3][63] : XSUM[3][15];
  assign X4_SLTU = !XCARRY[3];
  always_comb begin
    unique case (BE[3].funct3)
      3'd0: X4_TAKEN = XEQ[3]; 3'd1: X4_TAKEN = !XEQ[3];
      3'd4: X4_TAKEN = X4_SLT; 3'd5: X4_TAKEN = !X4_SLT;
      3'd6: X4_TAKEN = X4_SLTU; 3'd7: X4_TAKEN = !X4_SLTU;
      default: X4_TAKEN = 1'b0;
    endcase
  end
  assign X4_LT = BE[3].lt_signed ? X4_SLT : X4_SLTU;

  // X3 + X4: everything else that writes a register from the ALU (shifts, rotates, Zbb, Zbs, Zknh), in the
  // two-stage whole-value unit (src/deep/Deep_Whole_Unit.sv): X3 gathers and prepares the operands and does
  // the first half, X4 the second. min and max are picked in M1 with X4's compare.
  logic [63:0] X3_A, X3_B, X3_PA, X3_PB;
  assign X3_A = `RS1(2, 2);
  assign X3_B = `RS2(2, 2);
  assign X3_PA = BE[2].a_is_pc ? {32'd0, BE[2].pc} : prepare_a(X3_A, BE[2].a_zext, BE[2].a_shift);
  assign X3_PB = prepare_b(BE[2].b_is_imm ? BE[2].imm : X3_B, BE[2].inv_b, BE[2].one_b);
  whole_select_t X3_SELECT;
  DeepWholeDecode whole_decode (.OPERATION (BE[2].alu_op), .SELECT (X3_SELECT));
  logic [63:0] X3_HIGH, X3_LOW;
  DeepWholeFunnel whole_funnel (.A (X3_PA), .SELECT (X3_SELECT), .WORD (BE[2].is_word), .HIGH (X3_HIGH), .LOW (X3_LOW));
  logic [47:0] X3_NIBBLES;
  DeepNibbleOnes nibble_ones (.A (X3_PA), .NIBBLES (X3_NIBBLES));
  logic [66:0] X4_RIGHT, X4_LEFT;
  logic [1:0] X4_FINE;
  logic [19:0] X4_LEADING, X4_TRAILING, X4_QUARTERS;
  logic [63:0] X4_SIMPLE;
  DeepWholePrepare whole_prepare (
    .A (BE[3].pa), .B (BE[3].pb), .HIGH (BE[3].high), .LOW (BE[3].low), .SELECT (BE[3].whole_sel), .WORD (BE[3].is_word), .NIBBLES (BE[3].nibbles),
    .RIGHT_COARSE (X4_RIGHT), .LEFT_COARSE (X4_LEFT), .FINE (X4_FINE), .LEADING (X4_LEADING), .TRAILING (X4_TRAILING), .QUARTERS (X4_QUARTERS), .SIMPLE (X4_SIMPLE)
  );
  logic [63:0] M1_WHOLE;
  DeepWholeFinish whole_finish (
    .SELECT (BE[4].whole_sel), .WORD (BE[4].is_word), .SIMPLE (BE[4].simple), .RIGHT_COARSE (BE[4].right_coarse), .LEFT_COARSE (BE[4].left_coarse),
    .FINE (BE[4].fine), .LEADING (BE[4].leading), .TRAILING (BE[4].trailing), .RESULT (M1_WHOLE)
  );
  logic [11:0] M1_HALVES;
  logic [6:0] M2_POPULATION;
  DeepPopulationSteps population_steps (.QUARTERS (BE[4].quarters), .HALVES (M1_HALVES), .HALVES_IN (BE[5].halves), .TOTAL (M2_POPULATION));

  // ================================================================ M1: the commit point
  // M: M1's slot, except in the cycle a load that missed is replayed from M2 (MISS_R): then the instruction in M1
  // is younger than the load and is removed with the rest, so it does nothing (no store, no CSR write, no trap)
  back_slot_t M;
  logic MISS_R, M1_MISS;
  always_comb begin M = BE[4]; M.valid = BE[4].valid && !MISS_R; end
  logic [63:0] M1_RS1, M1_RS2;
  assign M1_RS1 = `RS1(4, 4);
  assign M1_RS2 = `RS2(4, 4);
  // min / max pick with X4's compare (ready at the end of M1)
  logic [63:0] M1_LATE_RESULT;
  assign M1_LATE_RESULT = (M.lt == ((M.alu_op == ALU_MIN) || (M.alu_op == ALU_MINU))) ? M1_RS1 : M1_RS2;

  // the data cache (looked up by M1's address)
  logic DCACHE_HIT, DCACHE_WAY0, DCACHE_PROBE_HIT, DCACHE_BUSY, DCACHE_DEMAND;
  logic [63:0] DCACHE_DATA, DCACHE_BUSY_LINE, DCACHE_DEMAND_ADDRESS;
  logic [5:0] DCACHE_LEFT;
  logic [7:0] STORE_MASK;
  logic [63:0] STORE_DATA;
  StoreControl store_control (.STORE_FUNCT3 (M.funct3), .MEMORY_ADDRESS (M.address), .MEMORY_INFO (M1_RS2), .WRITE_MASK_FOR_STORE (STORE_MASK), .DATA_TO_STORE (STORE_DATA));
  logic M1_STORE, M1_LOAD, IS_DEVICE;
  assign M1_STORE = M.valid && M.mem_write && !FREEZE;
  assign M1_LOAD = M.valid && M.mem_read;
  assign DATA_ADDRESS = M.address;
  assign DATA_WRITE_MASK = M1_STORE ? STORE_MASK : 8'd0;
  assign DATA_WRITE_DATA = STORE_DATA;
  assign IS_DEVICE = (M.address[63:8] == MMIO_BASE[63:8]);

  logic FLUSH, REPLAY, MISPREDICT;
  logic [31:0] ADJUST;
  logic [H-1:0] RESTORE_GHR;
  logic [2:0] RAS_RESTORE;
  // X3 / X4 work out whether a jump went the wrong way and where to restart (M.wrong, M.alt_pc), so M1's
  // flush is a few gates from registers: a branch guessed wrong, a JALR whose target was not the predicted
  // return, a stale BTB entry (a JAL whose target changed, or no longer a jump at all)
  logic [31:0] X3_PC4;
  logic X4_WRONG_TAKEN, X4_WRONG_NOT;
  assign X3_PC4 = plus4(BE[2].pc);
  // (both outcomes worked out beside the compare, which then only picks: the compare's own path stays short)
  assign X4_WRONG_TAKEN = BE[3].is_branch ? (!BE[3].pred || BE[3].btb_bad)
                        : BE[3].is_jalr ? !(BE[3].is_return && !BE[3].btb_bad && BE[3].jalr_hit) : BE[3].btb_bad;
  assign X4_WRONG_NOT = BE[3].is_branch ? (BE[3].pred || BE[3].btb_bad) : X4_WRONG_TAKEN;
  always_comb begin
    FLUSH = 1'b0; REPLAY = 1'b0; MISPREDICT = 1'b0; ADJUST = 32'd0; RESTORE_GHR = M.ckpt; RAS_RESTORE = M.ras_ckpt;
    if (M.valid) begin
      if (M.taken ? M.wrong_taken : M.wrong_not) begin
        FLUSH = 1'b1; MISPREDICT = 1'b1; ADJUST = (M.is_branch && M.taken) ? M.btarget : M.alt_pc;
        if (M.is_branch) RESTORE_GHR = {M.ckpt[H-2:0], M.taken};
        RAS_RESTORE = M.ras_after;
      end
      if (M.is_ecall || M.is_ebreak) begin FLUSH = 1'b1; ADJUST = TRAP_VECTOR[31:0]; end
      else if (M.is_mret) begin FLUSH = 1'b1; ADJUST = EXCEPTION_PC[31:0]; end
      else if (M.is_fence_i) begin FLUSH = 1'b1; ADJUST = M.alt_pc; end // PC + 4: fetch everything after it again
    end
    // a load that missed in M1 last cycle (registered, so the data cache's tag compare never reaches the flush and
    // its fan-out): replay it from M2, and remove everything younger, the instruction now in M1 included
    if (MISS_R) begin
      FLUSH = 1'b1; REPLAY = 1'b1; ADJUST = BE[5].pc; RESTORE_GHR = BE[5].ckpt; RAS_RESTORE = BE[5].ras_ckpt;
    end
  end
  assign M1_MISS = M.valid && M.mem_read && !DCACHE_HIT;
  always_ff @(posedge clk) begin
    if (reset) MISS_R <= 1'b0;
    else if (!FREEZE) MISS_R <= M1_MISS;
  end

  // the M unit: DeepMultiplyDivideUnit (src/deep/Deep_Multiply_Divide.sv) at half rate: one state every two
  // cycles, SIGN included, so every path through it has two cycles; it writes rd 2 x (steps + 2) cycles after M1
  logic MDU_BUSY, MDU_PHASE, MDU_READY, MDU_ENABLE, MDU_REQUEST;
  logic [4:0] MDU_RD;
  logic [63:0] MDU_RESULT;
  assign MDU_REQUEST = M.valid && M.is_muldiv && !FREEZE;
  assign MDU_ENABLE = !MDU_BUSY || MDU_PHASE;
  DeepMultiplyDivideUnit multiply_divide_unit (
    .clk (clk), .reset (reset), .FREEZE (FREEZE || !MDU_ENABLE), .REQUEST (MDU_REQUEST),
    .A (M1_RS1), .B (M1_RS2), .MULTIPLY_DIVIDE_OPERATION (M.alu_op), .IS_WORD_OPERATION (M.is_word), .PREDECODED (M.md_pre),
    .READY (MDU_READY), .LATE_RESULT (MDU_RESULT)
  );

  // custom instructions: one three-cycle path (src/deep/Deep_Custom.sv). X3's prepared operands are held
  // here from the end of X3 to the end of M2, which registers the result into M3's slot; D2 keeps custom
  // instructions three cycles apart (CUSTOM_AHEAD), so the next one cannot overwrite them sooner.
  logic [63:0] CUSTOM_A, CUSTOM_B, CUSTOM_RESULT;
  logic [31:0] CUSTOM_SELECT;
  always_ff @(posedge clk) begin
    if (!FREEZE && BE[2].valid && BE[2].is_custom) begin
      CUSTOM_A <= X3_PA; CUSTOM_B <= X3_PB; CUSTOM_SELECT <= BE[2].custom_select;
    end
  end
  DeepCustomChain custom_chain (.A (CUSTOM_A), .B (CUSTOM_B), .SELECT (CUSTOM_SELECT), .RESULT (CUSTOM_RESULT));

  // CSR access (M1)
  logic [20:0] X4_CSR_SELECT;
  DeepCSRDecode csr_decode (.ADDRESS (BE[3].word[31:20]), .SELECT (X4_CSR_SELECT));
  assign CSR_OPERATION = M.funct3;
  assign CSR_WRITE_DATA = M.csr_imm ? {59'd0, M.word[19:15]} : M1_RS1;
  assign CSR_WRITE_ENABLE = M.valid && M.is_csr && M.csr_write && !FREEZE;
  assign RETURN_FROM_TRAP = M.valid && M.is_mret && !FREEZE;
  // FENCE.I: every older store has written main memory (the data cache writes through), so emptying the
  // instruction cache and the BTB at this edge makes the refetch from PC + 4 read the new code
  logic FENCE_I_NOW;
  assign FENCE_I_NOW = M.valid && M.is_fence_i && !FREEZE;

  // ================================================================ M2: load alignment, custom instructions
  logic [63:0] M2_LOADED;
  LoadControl load_control (.LOAD_FUNCT3 (BE[5].funct3), .MEMORY_ADDRESS (BE[5].address), .MEMORY_INFO (BE[5].result), .DATA_TO_LOAD (M2_LOADED));

  // ================================================================ D1: decode (registered into D2 with the instruction)
  logic D1_REGISTER_WRITE, D1_MEMORY_READ, D1_MEMORY_WRITE, D1_CSR_WRITE, D1_CSR_IMMEDIATE, D1_A_IS_PC, D1_B_IS_IMMEDIATE, D1_IS_WORD;
  logic D1_IS_MULDIV, D1_IS_BRANCH, D1_IS_JAL, D1_IS_JALR, D1_IS_ECALL, D1_IS_EBREAK, D1_IS_MRET, D1_USES1, D1_USES2;
  logic D1_A_ZEXT, D1_INV_B, D1_ONE_B;
  logic [1:0] D1_A_SHIFT;
  immediate_type_select_t D1_IMMEDIATE_TYPE;
  writeback_select_t D1_WB_SEL;
  alu_op_t D1_ALU_OP;
  logic [63:0] D1_IMMEDIATE;
  logic [31:0] D1_CUSTOM_SELECT;
  assign {D1_REGISTER_WRITE, D1_MEMORY_READ, D1_MEMORY_WRITE, D1_CSR_WRITE, D1_CSR_IMMEDIATE, D1_A_IS_PC, D1_B_IS_IMMEDIATE, D1_IS_WORD,
          D1_IS_MULDIV, D1_IS_BRANCH, D1_IS_JAL, D1_IS_JALR, D1_IS_ECALL, D1_IS_EBREAK, D1_IS_MRET, D1_USES1, D1_USES2, D1_A_ZEXT, D1_INV_B, D1_ONE_B,
          D1_A_SHIFT, D1_IMMEDIATE_TYPE, D1_WB_SEL, D1_ALU_OP} = D1.ctl; // (decoded in F4)
  ImmediateGenerator immediate_generator (.INSTRUCTION (D1.word), .IMMEDIATE_TYPE_SELECT (D1_IMMEDIATE_TYPE), .IMMEDIATE (D1_IMMEDIATE));
  CustomDecode #(.XCOMPUTE (XCOMPUTE)) custom_decode (.FUNCT3 (D1.word[14:12]), .FUNCT7 (D1.word[31:25]), .SELECT (D1_CUSTOM_SELECT));

  // the timing class (deepClass in model/deep.js)
  logic D1_SYSTEM, D1_CUSTOM, D1_SLICED_PRODUCER, D1_SLICED_CONSUMER, D1_SLICED_A, D1_SLICED_B, D1_AT_NEVER, D1_A_EARLY;
  logic [2:0] D1_AT, D1_NEED_A, D1_NEED_B;
  assign D1_SYSTEM = (D1.word[6:0] == OPC_CSR);
  assign D1_CUSTOM = (D1_ALU_OP == ALU_CUSTOM);
  always_comb begin
    logic slice_op, slice_consumer_op;
    slice_op = (D1_ALU_OP == ALU_ADD) || (D1_ALU_OP == ALU_SUB) || (D1_ALU_OP == ALU_AND) || (D1_ALU_OP == ALU_OR) || (D1_ALU_OP == ALU_XOR) || (D1_ALU_OP == ALU_COPY_B);
    slice_consumer_op = slice_op || (D1_ALU_OP == ALU_SLT) || (D1_ALU_OP == ALU_SLTU) || (D1_ALU_OP == ALU_MIN) || (D1_ALU_OP == ALU_MINU)
                     || (D1_ALU_OP == ALU_MAX) || (D1_ALU_OP == ALU_MAXU) || (D1_ALU_OP == ALU_JALR);
    D1_AT_NEVER = 1'b0; D1_SLICED_PRODUCER = 1'b0; D1_AT = 3'd4; // the whole-value unit (and min / max) finish in M1
    if (D1_MEMORY_READ || D1_CUSTOM) D1_AT = 3'd5;
    else if (D1_WB_SEL == WRITEBACK_CSR) D1_AT = 3'd4;
    else if (D1_IS_JAL || D1_IS_JALR) begin D1_AT = 3'd0; D1_SLICED_PRODUCER = 1'b1; end
    else if (D1_IS_MULDIV) D1_AT_NEVER = 1'b1;
    else if ((D1_ALU_OP == ALU_SLT) || (D1_ALU_OP == ALU_SLTU)) D1_AT = 3'd3; // the slices' compare, decided in X4
    else if (D1_ALU_OP == ALU_CPOP) D1_AT = 3'd5; // ones per nibble (X3), per quarter (X4), per half (M1), the total (M2)
    else if (slice_op && !D1_ONE_B) begin D1_AT = 3'd3; D1_SLICED_PRODUCER = 1'b1; end
    D1_SLICED_CONSUMER = (slice_consumer_op && !D1_ONE_B && !D1_IS_MULDIV) || D1_IS_BRANCH || D1_MEMORY_READ || D1_MEMORY_WRITE;
    D1_SLICED_A = 1'b0; D1_SLICED_B = 1'b0;
    if (D1_IS_MULDIV || D1_SYSTEM) begin D1_NEED_A = 3'd4; D1_NEED_B = 3'd4; end
    else if (D1_CUSTOM) begin D1_NEED_A = 3'd2; D1_NEED_B = 3'd2; end
    else if (D1_SLICED_CONSUMER) begin D1_NEED_A = 3'd0; D1_NEED_B = D1_MEMORY_WRITE ? 3'd4 : 3'd0; D1_SLICED_A = 1'b1; D1_SLICED_B = !D1_MEMORY_WRITE; end
    else begin D1_NEED_A = 3'd2; D1_NEED_B = 3'd2; end // the whole-value unit: X3 gathers and prepares, X4 computes
    // add.uw, sh1add..sh3add(.uw): the slices take rs1 prepared (one stage early), so a late rs1 would need the
    // zero-extend and shift on the late path; instead rs1 must be in hand at issue (one cycle later than a plain add)
    D1_A_EARLY = D1_SLICED_A && (D1_A_ZEXT || (D1_A_SHIFT != 2'd0));
    if (D1_A_EARLY) D1_SLICED_A = 1'b0;
  end

  decoded_t D1_DECODED;
  always_comb begin
    D1_DECODED.register_write = D1_REGISTER_WRITE;
    D1_DECODED.memory_read = D1_MEMORY_READ;
    D1_DECODED.memory_write = D1_MEMORY_WRITE;
    D1_DECODED.csr_write = D1_CSR_WRITE;
    D1_DECODED.csr_immediate = D1_CSR_IMMEDIATE;
    D1_DECODED.a_is_pc = D1_A_IS_PC;
    D1_DECODED.b_is_immediate = D1_B_IS_IMMEDIATE;
    D1_DECODED.is_word = D1_IS_WORD;
    D1_DECODED.is_muldiv = D1_IS_MULDIV;
    D1_DECODED.is_branch = D1_IS_BRANCH;
    D1_DECODED.is_jal = D1_IS_JAL;
    D1_DECODED.is_jalr = D1_IS_JALR;
    D1_DECODED.is_ecall = D1_IS_ECALL;
    D1_DECODED.is_ebreak = D1_IS_EBREAK;
    D1_DECODED.is_mret = D1_IS_MRET;
    D1_DECODED.uses1 = D1_USES1;
    D1_DECODED.uses2 = D1_USES2;
    D1_DECODED.a_zext = D1_A_ZEXT;
    D1_DECODED.inv_b = D1_INV_B;
    D1_DECODED.one_b = D1_ONE_B;
    D1_DECODED.a_shift = D1_A_SHIFT;
    D1_DECODED.wb_sel = D1_WB_SEL;
    D1_DECODED.alu_op = D1_ALU_OP;
    D1_DECODED.immediate = D1_IMMEDIATE;
    D1_DECODED.custom_select = D1_CUSTOM_SELECT;
    D1_DECODED.system = D1_SYSTEM;
    D1_DECODED.custom = D1_CUSTOM;
    D1_DECODED.sliced_producer = D1_SLICED_PRODUCER;
    D1_DECODED.sliced_a = D1_SLICED_A;
    D1_DECODED.sliced_b = D1_SLICED_B;
    D1_DECODED.at_never = D1_AT_NEVER;
    D1_DECODED.at = D1_AT;
    D1_DECODED.need_a = D1_NEED_A;
    D1_DECODED.need_b = D1_NEED_B;
    D1_DECODED.a_early = D1_A_EARLY;
  end

  // ================================================================ D2: the issue check (decoded control comes registered from D1)
  logic D2_REGISTER_WRITE;
  logic D2_MEMORY_READ;
  logic D2_MEMORY_WRITE;
  logic D2_CSR_WRITE;
  logic D2_CSR_IMMEDIATE;
  logic D2_A_IS_PC;
  logic D2_B_IS_IMMEDIATE;
  logic D2_IS_WORD;
  logic D2_IS_MULDIV;
  logic D2_IS_BRANCH;
  logic D2_IS_JAL;
  logic D2_IS_JALR;
  logic D2_IS_ECALL;
  logic D2_IS_EBREAK;
  logic D2_IS_MRET;
  logic D2_USES1;
  logic D2_USES2;
  logic D2_A_ZEXT;
  logic D2_INV_B;
  logic D2_ONE_B;
  logic [1:0] D2_A_SHIFT;
  writeback_select_t D2_WB_SEL;
  alu_op_t D2_ALU_OP;
  logic [63:0] D2_IMMEDIATE;
  logic [31:0] D2_CUSTOM_SELECT;
  logic D2_SYSTEM;
  logic D2_CUSTOM;
  logic D2_SLICED_PRODUCER;
  logic D2_SLICED_A;
  logic D2_SLICED_B;
  logic D2_AT_NEVER;
  logic [2:0] D2_AT;
  logic [2:0] D2_NEED_A;
  logic [2:0] D2_NEED_B;
  logic D2_A_EARLY;
  always_comb begin
    D2_REGISTER_WRITE = D2.dec.register_write;
    D2_MEMORY_READ = D2.dec.memory_read;
    D2_MEMORY_WRITE = D2.dec.memory_write;
    D2_CSR_WRITE = D2.dec.csr_write;
    D2_CSR_IMMEDIATE = D2.dec.csr_immediate;
    D2_A_IS_PC = D2.dec.a_is_pc;
    D2_B_IS_IMMEDIATE = D2.dec.b_is_immediate;
    D2_IS_WORD = D2.dec.is_word;
    D2_IS_MULDIV = D2.dec.is_muldiv;
    D2_IS_BRANCH = D2.dec.is_branch;
    D2_IS_JAL = D2.dec.is_jal;
    D2_IS_JALR = D2.dec.is_jalr;
    D2_IS_ECALL = D2.dec.is_ecall;
    D2_IS_EBREAK = D2.dec.is_ebreak;
    D2_IS_MRET = D2.dec.is_mret;
    D2_USES1 = D2.dec.uses1;
    D2_USES2 = D2.dec.uses2;
    D2_A_ZEXT = D2.dec.a_zext;
    D2_INV_B = D2.dec.inv_b;
    D2_ONE_B = D2.dec.one_b;
    D2_A_SHIFT = D2.dec.a_shift;
    D2_WB_SEL = D2.dec.wb_sel;
    D2_ALU_OP = D2.dec.alu_op;
    D2_IMMEDIATE = D2.dec.immediate;
    D2_CUSTOM_SELECT = D2.dec.custom_select;
    D2_SYSTEM = D2.dec.system;
    D2_CUSTOM = D2.dec.custom;
    D2_SLICED_PRODUCER = D2.dec.sliced_producer;
    D2_SLICED_A = D2.dec.sliced_a;
    D2_SLICED_B = D2.dec.sliced_b;
    D2_AT_NEVER = D2.dec.at_never;
    D2_AT = D2.dec.at;
    D2_NEED_A = D2.dec.need_a;
    D2_NEED_B = D2.dec.need_b;
    D2_A_EARLY = D2.dec.a_early;
  end
  logic [4:0] D2_RS1, D2_RS2, D2_RD;
  assign D2_RS1 = D2.word[19:15];
  assign D2_RS2 = D2.word[24:20];
  assign D2_RD = D2.word[11:7];

  // the youngest older writer of a register, and whether its value is there in time
  function automatic logic writes(input back_slot_t s, input logic [4:0] r);
    return s.valid && s.reg_write && (s.rd == r) && (r != 5'd0);
  endfunction
  // A_LATE / B_LATE: the stages s whose producer finishes the needed part exactly one cycle before (slice s of a
  // sliced producer right ahead, or the whole result at its AT stage): those take it from the producer's slot
  logic A_FOUND, B_FOUND, A_READY, B_READY;
  logic [3:0] A_DIST, B_DIST;
  logic [5:0] A_LATE, B_LATE;
  logic [3:0] A_LSEL, B_LSEL;
  logic [63:0] A_VALUE, B_VALUE;
  function automatic logic [3:0] late_select(input logic chain, input logic [2:0] at);
    if (chain || (at == 3'd0)) return 4'b0001; // the slot right ahead (a sliced producer, or a JAL / JALR link)
    return {at == 3'd5, at == 3'd4, at == 3'd3, 1'b0};
  endfunction
  always_comb begin
    A_FOUND = 1'b0; B_FOUND = 1'b0; A_DIST = 4'd0; B_DIST = 4'd0; A_READY = 1'b1; B_READY = 1'b1;
    A_LATE = 6'd0; B_LATE = 6'd0; A_LSEL = 4'd0; B_LSEL = 4'd0; A_VALUE = RF[D2_RS1]; B_VALUE = RF[D2_RS2];
    for (int j = 7; j >= 0; j--) begin // the youngest (smallest j) wins
      if (MATCH_A[j]) begin
        A_FOUND = 1'b1; A_DIST = 4'(j + 1); A_VALUE = BE[j].result;
        A_READY = !BE[j].at_never && ((D2_SLICED_A && BE[j].sliced) || (j + int'(D2_NEED_A) >= int'(BE[j].at) + int'(D2_A_EARLY)));
        for (int st = 0; st < 6; st++) A_LATE[st] = (D2_SLICED_A && BE[j].sliced) ? (j == 0) : (st + j == int'(BE[j].at));
        A_LSEL = late_select(D2_SLICED_A && BE[j].sliced, BE[j].at);
      end
      if (MATCH_B[j]) begin
        B_FOUND = 1'b1; B_DIST = 4'(j + 1); B_VALUE = BE[j].result;
        B_READY = !BE[j].at_never && ((D2_SLICED_B && BE[j].sliced) || (j + int'(D2_NEED_B) >= int'(BE[j].at)));
        for (int st = 0; st < 6; st++) B_LATE[st] = (D2_SLICED_B && BE[j].sliced) ? (j == 0) : (st + j == int'(BE[j].at));
        B_LSEL = late_select(D2_SLICED_B && BE[j].sliced, BE[j].at);
      end
    end
  end
  // The register matches of the issue check, worked out one cycle early (registered): which back-end slots write
  // D2's rs1 / rs2, and which M instructions in X1..M1 write any register D2 reads or writes. Next cycle's back
  // end is this cycle's moved on by one slot (it never stalls), plus what D2 issues now; next cycle's D2 is D2
  // again (a hold: the vectors just shift) or D1 (compared now with BE[0..6] and with D2 itself).
  logic ISSUE, HOLD, TAKE_INTERRUPT;
  logic [7:0] MATCH_A, MATCH_B;
  logic [4:0] MDU_MATCH;
  logic [7:0] MATCH_A_NEXT, MATCH_B_NEXT;
  logic [4:0] MDU_MATCH_NEXT;
  function automatic logic mdu_writes(input back_slot_t s, input logic [4:0] r1, input logic u1, input logic [4:0] r2, input logic u2, input logic [4:0] rw, input logic w);
    return s.valid && s.is_muldiv && (s.rd != 5'd0) && ((u1 && s.rd == r1) || (u2 && s.rd == r2) || (w && s.rd == rw));
  endfunction
  // next cycle's D2 unless D2 holds: the skid slot's instruction if there is one, else D1's
  logic [4:0] NEXT_RS1, NEXT_RS2, NEXT_RD;
  logic NEXT_USES1, NEXT_USES2, NEXT_WRITES;
  always_comb begin
    if (SKID.f.valid) begin
      NEXT_RS1 = SKID.word[19:15]; NEXT_RS2 = SKID.word[24:20]; NEXT_RD = SKID.word[11:7];
      NEXT_USES1 = SKID.dec.uses1; NEXT_USES2 = SKID.dec.uses2; NEXT_WRITES = SKID.dec.register_write;
    end else begin
      NEXT_RS1 = D1.word[19:15]; NEXT_RS2 = D1.word[24:20]; NEXT_RD = D1.word[11:7];
      NEXT_USES1 = D1_USES1; NEXT_USES2 = D1_USES2; NEXT_WRITES = D1_REGISTER_WRITE;
    end
  end
  always_comb begin
    logic [4:0] r1, r2, rw;
    r1 = NEXT_RS1; r2 = NEXT_RS2; rw = NEXT_RD;
    for (int j = 1; j <= 7; j++) begin
      MATCH_A_NEXT[j] = NEXT_USES1 && writes(BE[j - 1], r1);
      MATCH_B_NEXT[j] = NEXT_USES2 && writes(BE[j - 1], r2);
    end
    for (int j = 1; j <= 4; j++) MDU_MATCH_NEXT[j] = mdu_writes(BE[j - 1], r1, NEXT_USES1, r2, NEXT_USES2, rw, NEXT_WRITES);
    MATCH_A_NEXT[0] = ISSUE && NEXT_USES1 && D2_REGISTER_WRITE && (D2_RD == r1) && (r1 != 5'd0);
    MATCH_B_NEXT[0] = ISSUE && NEXT_USES2 && D2_REGISTER_WRITE && (D2_RD == r2) && (r2 != 5'd0);
    MDU_MATCH_NEXT[0] = ISSUE && D2_IS_MULDIV && (D2_RD != 5'd0) && ((NEXT_USES1 && D2_RD == r1) || (NEXT_USES2 && D2_RD == r2) || (NEXT_WRITES && D2_RD == rw));
    if (FLUSH || TAKE_INTERRUPT) begin MATCH_A_NEXT = '0; MATCH_B_NEXT = '0; MDU_MATCH_NEXT = '0; end
    else if (HOLD) begin MATCH_A_NEXT = {MATCH_A[6:0], 1'b0}; MATCH_B_NEXT = {MATCH_B[6:0], 1'b0}; MDU_MATCH_NEXT = {MDU_MATCH[3:0], 1'b0}; end
  end
  // and whether the M unit's destination (next cycle's MDU_RD) is a register next cycle's D2 reads or writes
  logic MDU_RD_MATCH, MDU_RD_MATCH_NEXT;
  function automatic logic rd_hits(input logic [4:0] r, input logic [4:0] r1, input logic u1, input logic [4:0] r2, input logic u2, input logic [4:0] rw, input logic w);
    return (r != 5'd0) && ((u1 && r == r1) || (u2 && r == r2) || (w && r == rw));
  endfunction
  always_comb begin
    logic [4:0] next_rd;
    next_rd = (M.valid && M.is_muldiv) ? M.rd : MDU_RD; // (MDU_REQUEST without FREEZE: this register holds while frozen anyway)
    if (FLUSH || TAKE_INTERRUPT) MDU_RD_MATCH_NEXT = 1'b0;
    else if (HOLD) MDU_RD_MATCH_NEXT = rd_hits(next_rd, D2_RS1, D2_USES1, D2_RS2, D2_USES2, D2_RD, D2_REGISTER_WRITE);
    else MDU_RD_MATCH_NEXT = rd_hits(next_rd, NEXT_RS1, NEXT_USES1, NEXT_RS2, NEXT_USES2, NEXT_RD, NEXT_WRITES);
  end
  always_ff @(posedge clk) begin
    if (reset) begin MATCH_A <= '0; MATCH_B <= '0; MDU_MATCH <= '0; MDU_RD_MATCH <= 1'b0; end
    else if (!FREEZE) begin MATCH_A <= MATCH_A_NEXT; MATCH_B <= MATCH_B_NEXT; MDU_MATCH <= MDU_MATCH_NEXT; MDU_RD_MATCH <= MDU_RD_MATCH_NEXT; end
  end
  logic AHEAD_EMPTY, MDU_AHEAD, PENDING_HIT, CUSTOM_AHEAD;
  // X1..M1 empty, worked out a cycle early (next cycle's X1..M1 are this cycle's D2 issue and X1..X4)
  logic AHEAD_EMPTY_R;
  always_ff @(posedge clk) begin
    if (reset) AHEAD_EMPTY_R <= 1'b1;
    else if (!FREEZE) AHEAD_EMPTY_R <= FLUSH || TAKE_INTERRUPT || !(ISSUE || BE[0].valid || BE[1].valid || BE[2].valid || BE[3].valid);
  end
  assign CUSTOM_AHEAD = (BE[0].valid && BE[0].is_custom) || (BE[1].valid && BE[1].is_custom); // issued 1 or 2 cycles ago
  always_comb begin
    AHEAD_EMPTY = 1'b1; MDU_AHEAD = 1'b0; PENDING_HIT = 1'b0;
    for (int j = 0; j <= 4; j++) begin
      if (BE[j].valid) AHEAD_EMPTY = 1'b0;
      if (BE[j].valid && BE[j].is_muldiv) begin
        MDU_AHEAD = 1'b1;
        if (MDU_MATCH[j]) PENDING_HIT = 1'b1;
      end
    end
    if (MDU_BUSY && MDU_RD_MATCH) PENDING_HIT = 1'b1;
  end
  logic [2:0] HOLD_CAUSE;
  always_comb begin
    ISSUE = 1'b0; TAKE_INTERRUPT = 1'b0; HOLD_CAUSE = CAUSE_STALL;
    if (D2.f.valid && !FLUSH) begin
      if (INT_REQ) begin
        if (AHEAD_EMPTY_R && !MDU_BUSY) TAKE_INTERRUPT = 1'b1; else HOLD_CAUSE = CAUSE_INTERRUPT;
      end
      else if (D2_IS_MULDIV && (MDU_BUSY || MDU_AHEAD)) HOLD_CAUSE = CAUSE_MDU;
      else if (PENDING_HIT) HOLD_CAUSE = CAUSE_MDU;
      else if (D2_CUSTOM && CUSTOM_AHEAD) HOLD_CAUSE = CAUSE_STALL; // the custom chain is still busy
      else if (A_READY && B_READY) ISSUE = 1'b1;
    end
    HOLD = D2.f.valid && !FLUSH && !ISSUE && !TAKE_INTERRUPT;
  end
  assign TAKE_TRAP = !FREEZE && ((M.valid && (M.is_ecall || M.is_ebreak)) || TAKE_INTERRUPT);
  assign TRAP_PC = TAKE_INTERRUPT ? {32'd0, D2.f.pc} : {32'd0, M.pc};
  assign TRAP_CAUSE = TAKE_INTERRUPT ? (INT_EXT ? CAUSE_MACHINE_EXTERNAL_INTERRUPT : CAUSE_MACHINE_TIMER_INTERRUPT)
                    : (M.is_ebreak ? CAUSE_BREAKPOINT : CAUSE_ENVIRONMENT_CALL);

  back_slot_t ISSUED;
  always_comb begin
    ISSUED = '0;
    ISSUED.valid = 1'b1; ISSUED.pc = D2.f.pc; ISSUED.word = D2.word;
    ISSUED.reg_write = D2_REGISTER_WRITE; ISSUED.rd = D2_REGISTER_WRITE ? D2_RD : 5'd0; ISSUED.rs1 = D2_RS1; ISSUED.rs2 = D2_RS2;
    ISSUED.at = D2_AT; ISSUED.at_never = D2_AT_NEVER; ISSUED.sliced = D2_SLICED_PRODUCER;
    ISSUED.mem_read = D2_MEMORY_READ; ISSUED.mem_write = D2_MEMORY_WRITE; ISSUED.is_branch = D2_IS_BRANCH; ISSUED.is_jal = D2_IS_JAL; ISSUED.is_jalr = D2_IS_JALR;
    ISSUED.is_ecall = D2_IS_ECALL; ISSUED.is_ebreak = D2_IS_EBREAK; ISSUED.is_mret = D2_IS_MRET; ISSUED.is_muldiv = D2_IS_MULDIV; ISSUED.is_custom = D2_CUSTOM;
    ISSUED.is_csr = (D2_WB_SEL == WRITEBACK_CSR) && D2_SYSTEM && (D2.word[14:12] != 3'd0); ISSUED.csr_write = D2_CSR_WRITE; ISSUED.csr_imm = D2_CSR_IMMEDIATE;
    ISSUED.a_is_pc = D2_A_IS_PC && !D2_IS_BRANCH; ISSUED.b_is_imm = D2_B_IS_IMMEDIATE && !D2_IS_BRANCH; // a branch's slices compare rs1 with rs2
    ISSUED.is_word = D2_IS_WORD; ISSUED.a_zext = D2_A_ZEXT; ISSUED.a_shift = D2_A_SHIFT;
    ISSUED.inv_b = D2_INV_B; ISSUED.one_b = D2_ONE_B;
    ISSUED.subtract = D2_IS_BRANCH || (D2_ALU_OP == ALU_SUB) || (D2_ALU_OP == ALU_SLT) || (D2_ALU_OP == ALU_SLTU) || (D2_ALU_OP == ALU_MIN) || (D2_ALU_OP == ALU_MINU) || (D2_ALU_OP == ALU_MAX) || (D2_ALU_OP == ALU_MAXU);
    ISSUED.alu_op = D2_ALU_OP; ISSUED.wb_sel = D2_WB_SEL; ISSUED.imm = D2_IMMEDIATE; ISSUED.funct3 = D2.word[14:12];
    ISSUED.src_a = A_FOUND; ISSUED.dist_a = A_DIST; ISSUED.src_b = B_FOUND; ISSUED.dist_b = B_DIST;
    ISSUED.op_a = A_VALUE; ISSUED.op_b = B_VALUE; ISSUED.late_a = A_LATE; ISSUED.late_b = B_LATE;
    ISSUED.lsel_a = A_LSEL; ISSUED.lsel_b = B_LSEL;
    ISSUED.xsel_a = A_LATE[0] ? {1'b0, A_LSEL} : 5'b10000;
    ISSUED.xsel_b = (B_LATE[0] && !ISSUED.b_is_imm) ? {1'b0, B_LSEL} : 5'b10000;
    ISSUED.xa = ISSUED.a_is_pc ? {32'd0, D2.f.pc} : prepare_a(A_VALUE, D2_A_ZEXT, D2_A_SHIFT);
    ISSUED.bflip = D2_INV_B ^ ISSUED.subtract;
    ISSUED.ysel[1] = (D2_ALU_OP == ALU_AND); ISSUED.ysel[2] = (D2_ALU_OP == ALU_OR); ISSUED.ysel[3] = (D2_ALU_OP == ALU_XOR); ISSUED.ysel[4] = (D2_ALU_OP == ALU_COPY_B);
    ISSUED.ysel[0] = !(|ISSUED.ysel[4:1]); // add, sub, the compares, JALR, load / store addresses
    ISSUED.ysel_hi = D2_IS_WORD ? 5'd0 : ISSUED.ysel;
    ISSUED.yres = D2_SLICED_PRODUCER && !D2_IS_JAL && !D2_IS_JALR;
    ISSUED.is_slt = (D2_ALU_OP == ALU_SLT) || (D2_ALU_OP == ALU_SLTU);
    ISSUED.lt_signed = (D2_ALU_OP == ALU_SLT) || (D2_ALU_OP == ALU_MIN) || (D2_ALU_OP == ALU_MAX);
    ISSUED.xb = (ISSUED.b_is_imm ? D2_IMMEDIATE : B_VALUE) ^ {64{ISSUED.bflip}};
    ISSUED.whole = D2_REGISTER_WRITE && (D2_WB_SEL == WRITEBACK_ALU) && !D2_IS_MULDIV && !D2_CUSTOM && !D2_IS_JAL && !D2_IS_JALR
                && !D2_SLICED_PRODUCER && (D2_ALU_OP != ALU_SLT) && (D2_ALU_OP != ALU_SLTU) && (D2_ALU_OP != ALU_MIN) && (D2_ALU_OP != ALU_MINU)
                && (D2_ALU_OP != ALU_MAX) && (D2_ALU_OP != ALU_MAXU);
    ISSUED.md_pre = {(D2_ALU_OP == ALU_MULH) || (D2_ALU_OP == ALU_MULHSU) || (D2_ALU_OP == ALU_DIV) || (D2_ALU_OP == ALU_REM),
                     (D2_ALU_OP == ALU_MULH) || (D2_ALU_OP == ALU_DIV) || (D2_ALU_OP == ALU_REM),
                     D2_IS_WORD && ((D2_ALU_OP == ALU_DIV) || (D2_ALU_OP == ALU_DIVU) || (D2_ALU_OP == ALU_REM) || (D2_ALU_OP == ALU_REMU))};
    ISSUED.custom_select = D2_CUSTOM ? D2_CUSTOM_SELECT : 32'd0;
    ISSUED.pred = D2.f.pred; ISSUED.gidx = D2.f.gidx; ISSUED.gtaken = D2.f.gtaken; ISSUED.btaken = D2.f.btaken;
    ISSUED.ckpt = D2.ckpt; ISSUED.ras_ckpt = D2.ras_ckpt; ISSUED.is_call = D2.is_call; ISSUED.is_return = D2.is_return;
    ISSUED.target = D2.target; ISSUED.btarget = D2.btarget; ISSUED.btb_bad = D2.btb_bad;
    ISSUED.is_fence_i = (D2.word[6:0] == OPC_FENCE) && (D2.word[14:12] == FNC_FENCE_I);
    ISSUED.writes_tohost = D2_CSR_WRITE && (D2.word[31:20] == CSR_TOHOST);
    ISSUED.result = {31'd0, &D2.f.pc[31:2], plus4(D2.f.pc)}; // the link of a JAL / JALR (known now); everything else overwrites it
  end

  // ================================================================ F4: prediction (redirect), decode
  logic ADVANCE;
  assign ADVANCE = !FLUSH && !TAKE_INTERRUPT && !FSTALL; // F1..D1 move on
  logic ICACHE_HIT, ICACHE_WAY0, ICACHE_WAY1, ICACHE_PROBE_HIT, ICACHE_BUSY, ICACHE_DEMAND;
  logic [63:0] ICACHE_DATA, ICACHE_DATA0, ICACHE_DATA1, ICACHE_BUSY_LINE;
  logic [35:0] ICACHE_PREDECODE, ICACHE_PREDECODE0, ICACHE_PREDECODE1, DCACHE_PREDECODE_UNUSED, DCACHE_PREDECODE0_UNUSED, DCACHE_PREDECODE1_UNUSED;
  logic [63:0] DCACHE_DATA0_UNUSED, DCACHE_DATA1_UNUSED; logic DCACHE_WAY1_UNUSED;
  logic [5:0] ICACHE_LEFT;
  logic [31:0] F4_TARGET, F4_BTARGET, RAS_TOP32;
  logic F4_IS_JAL, F4_IS_BRANCH, F4_IS_CALL, F4_IS_RETURN, F4_TAKEN, F4_HIT_ADVANCE, IMISS_F4, REDIRECT;
  logic [63:0] RAS_TOP;
  logic [2:0] RAS_POINTER;
  logic [H-1:0] GLOBAL_HISTORY;
  assign RAS_TOP32 = RAS_TOP[31:0];
  // F4 decodes the word (ControlUnit); D1 works out the immediate and the timing class from the result
  control_t F4_CONTROL;
  ControlUnit control_unit (
    .INSTRUCTION (F4_WORD), .REGISTER_WRITE_ENABLE (F4_CONTROL.register_write), .MEMORY_READ_ENABLE (F4_CONTROL.memory_read), .MEMORY_WRITE_ENABLE (F4_CONTROL.memory_write),
    .CSR_WRITE_ENABLE (F4_CONTROL.csr_write), .CSR_WRITE_USING_IMMEDIATE (F4_CONTROL.csr_immediate), .ALU_INPUT_A_IS_PC (F4_CONTROL.a_is_pc), .ALU_INPUT_B_IS_IMMEDIATE (F4_CONTROL.b_is_immediate),
    .ALU_IS_WORD_OPERATION (F4_CONTROL.is_word), .IS_A_MULTIPLY_DIVIDE_INSTRUCTION (F4_CONTROL.is_muldiv), .IS_A_BRANCH_INSTRUCTION (F4_CONTROL.is_branch),
    .IS_A_JAL_INSTRUCTION (F4_CONTROL.is_jal), .IS_A_JALR_INSTRUCTION (F4_CONTROL.is_jalr), .IS_AN_ECALL (F4_CONTROL.is_ecall), .IS_AN_EBREAK (F4_CONTROL.is_ebreak), .IS_AN_MRET (F4_CONTROL.is_mret),
    .USES_REGISTER1 (F4_CONTROL.uses1), .USES_REGISTER2 (F4_CONTROL.uses2), .IMMEDIATE_TYPE_SELECT (F4_CONTROL.immediate_type), .WRITEBACK_SELECT (F4_CONTROL.wb_sel),
    .ALU_OPERATION (F4_CONTROL.alu_op), .ALU_OPERAND_A_ZERO_EXTEND (F4_CONTROL.a_zext), .ALU_OPERAND_A_SHIFT (F4_CONTROL.a_shift), .ALU_OPERAND_B_INVERT (F4_CONTROL.inv_b), .ALU_OPERAND_B_SINGLE_BIT (F4_CONTROL.one_b)
  );
  // the instruction cache predecoded the word as its line installed (DeepCache PREDECODE): kind and target ready
  assign {F4_BTARGET, F4_IS_JAL, F4_IS_BRANCH, F4_IS_CALL, F4_IS_RETURN} = F4_PREDECODE;
  logic F4_BTB_UNDO;
  assign F4_BTB_UNDO = F4.btb_go && F4_IS_BRANCH && !F4.pred;
  always_comb begin
    F4_TAKEN = F4_IS_JAL || (F4_IS_BRANCH && F4.pred) || F4_IS_RETURN;
    F4_TARGET = F4_IS_RETURN ? RAS_TOP32 : F4_BTARGET;
    REDIRECT = 1'b0; IMISS_F4 = 1'b0; F4_HIT_ADVANCE = 1'b0;
    if (F4.valid && ADVANCE) begin
      if (!F4_HIT) IMISS_F4 = 1'b1;
      else begin
        F4_HIT_ADVANCE = 1'b1;
        // the BTB sent F1 on already: trust it (D1 checks it, M1 repairs it), so no adder or compare here
        // (a branch the BTB sent on that the tournament guesses not taken: back to PC + 4, like any F4 redirect)
        if (F4.btb_go) begin
          if (!F4_TAKEN) F4_TARGET = plus4(F4.pc);
          REDIRECT = F4_BTB_UNDO;
        end else REDIRECT = F4_TAKEN;
      end
    end
  end

  // ================================================================ F1
  logic GSHARE_TAKEN, BHT_TAKEN, CHOOSE_GSHARE, BTB_HIT, BTB_HIT_IS_JAL, BTB_HIT_TAKEN, F1_PRED, BTB_GO;
  logic [H-1:0] GSHARE_INDEX;
  logic [63:0] BTB_TARGET;
  assign F1_PRED = CHOOSE_GSHARE ? GSHARE_TAKEN : BHT_TAKEN;
  // The BTB's go uses its own per-entry direction counter, not the tournament's guess: the predictor tables (a
  // history-indexed read, then the chooser) stay off F1's next-PC loop. F4 has the tournament's guess and
  // takes it back (a redirect to PC + 4) when the two disagree
  assign BTB_GO = BTB_HIT && (BTB_HIT_IS_JAL || (BRANCH_PREDICTION_ENABLE && BTB_HIT_TAKEN));
  logic IGATE, DGATE, FETCH;
  assign IGATE = IWAIT && !(ICACHE_PROBE_HIT || (ICACHE_BUSY && ICACHE_BUSY_LINE == {32'd0, F1PC[31:5], 5'd0} && ICACHE_LEFT <= 6'(FETCH_LEAD)));
  assign DGATE = DWAIT_VALID && !(DCACHE_PROBE_HIT || (DCACHE_BUSY && DCACHE_BUSY_LINE == DWAIT_LINE && DCACHE_LEFT <= 6'(REPLAY_LEAD)));
  assign FETCH = ADVANCE && !REDIRECT && !IMISS_F4 && !IGATE && !DGATE;

  // ================================================================ predictors and the return stack
  // M1 resolves a branch or JAL; the tables learn from it a cycle later (M2), from these registers, so the
  // training (index decode, counter step) is not tacked onto M1's own logic
  logic BP_TRAIN, BTB_UPDATE, TRAIN_BRANCH, TRAIN_BTB, TRAIN_TAKEN, TRAIN_GTAKEN, TRAIN_BTAKEN, TRAIN_IS_JAL;
  logic [H-1:0] TRAIN_GIDX;
  logic [31:0] TRAIN_PC, TRAIN_TARGET;
  always_ff @(posedge clk) begin
    if (reset) begin TRAIN_BRANCH <= 1'b0; TRAIN_BTB <= 1'b0; end
    else if (!FREEZE) begin
      TRAIN_BRANCH <= M.valid && M.is_branch;
      TRAIN_BTB <= M.valid && ((M.is_branch && M.taken) || M.is_jal);
      TRAIN_TAKEN <= M.taken; TRAIN_GTAKEN <= M.gtaken; TRAIN_BTAKEN <= M.btaken; TRAIN_IS_JAL <= M.is_jal;
      TRAIN_GIDX <= M.gidx; TRAIN_PC <= M.pc; TRAIN_TARGET <= M.btarget;
    end
  end
  assign BP_TRAIN = TRAIN_BRANCH && !FREEZE;
  assign BTB_UPDATE = TRAIN_BTB && !FREEZE;
  DeepGShare #(.HISTORY_BITS (H)) gshare_predictor (
    .clk (clk), .reset (reset), .ENABLE (BRANCH_PREDICTION_ENABLE),
    .FETCH_PC (F1PC), .FETCH_PREDICTED_TAKEN (GSHARE_TAKEN), .FETCH_PREDICTION_INDEX (GSHARE_INDEX), .GLOBAL_HISTORY (GLOBAL_HISTORY),
    .SPECULATIVE_UPDATE (!FREEZE && F4_HIT_ADVANCE && F4_IS_BRANCH), .SPECULATIVE_TAKEN (F4.pred),
    .UPDATE_PREDICTION (BP_TRAIN), .UPDATE_PREDICTION_INDEX (TRAIN_GIDX), .ACTUAL_BRANCH_TAKEN (TRAIN_TAKEN),
    .RESTORE_HISTORY (!FREEZE && (FLUSH || TAKE_INTERRUPT)), .RESTORE_HISTORY_VALUE (TAKE_INTERRUPT ? D2.ckpt : RESTORE_GHR)
  );
  DeepTournament #(.INDEX_BITS (7)) tournament_chooser (
    .clk (clk), .reset (reset), .ENABLE (BRANCH_PREDICTION_ENABLE), .FETCH_PC (F1PC), .BHT_PREDICTED_TAKEN (BHT_TAKEN), .CHOOSE_GSHARE (CHOOSE_GSHARE),
    .UPDATE (BP_TRAIN), .UPDATE_PC (TRAIN_PC), .ACTUAL_BRANCH_TAKEN (TRAIN_TAKEN), .BHT_WAS_TAKEN (TRAIN_BTAKEN), .GSHARE_WAS_TAKEN (TRAIN_GTAKEN)
  );
  DeepBranchTargetBuffer #(.ENTRIES (16), .TAG_BITS (10)) branch_target_buffer (
    .clk (clk), .reset (reset || FENCE_I_NOW), .FETCH_PC (F1PC), .HIT (BTB_HIT), .HIT_IS_JAL (BTB_HIT_IS_JAL), .HIT_TAKEN (BTB_HIT_TAKEN), .PREDICTED_TARGET (BTB_TARGET),
    .UPDATE (BTB_UPDATE), .DECAY (BP_TRAIN && !TRAIN_TAKEN), .UPDATE_PC (TRAIN_PC), .UPDATE_TARGET (TRAIN_TARGET), .UPDATE_IS_JAL (TRAIN_IS_JAL)
  );
  ReturnAddressStack #(.DEPTH (8)) return_address_stack (
    .clk (clk), .reset (reset), .TOP_ADDRESS (RAS_TOP), .POINTER (RAS_POINTER),
    .PUSH (!FREEZE && F4_HIT_ADVANCE && F4_IS_CALL), .POP (!FREEZE && F4_HIT_ADVANCE && F4_IS_RETURN), .PUSH_ADDRESS ({32'd0, plus4(F4.pc)}),
    .RESTORE (!FREEZE && (FLUSH || TAKE_INTERRUPT)), .RESTORE_POINTER (TAKE_INTERRUPT ? D2.ras_ckpt : RAS_RESTORE)
  );

  // ================================================================ caches
  logic ICACHE_WANT;
  logic [31:0] ICACHE_MISS_PC;
  // (an F4 miss restarts F1 there, and the wait asks for the line: F3's hit is a cycle old by F4, and the
  // line may have arrived since, so F4 does not ask itself)
  assign ICACHE_MISS_PC = F1PC;
  assign ICACHE_WANT = IWAIT && !ICACHE_PROBE_HIT && !(ICACHE_BUSY && ICACHE_BUSY_LINE == {32'd0, F1PC[31:5], 5'd0});
  logic [63:0] ICACHE_WRITE_DATA_UNUSED;
  assign ICACHE_WRITE_DATA_UNUSED = 64'd0;
  // (F2 reads the arrays at F2's PC, F3 compares the tags and picks the way, F4 marks the line used; F3 and F4
  // hold only while the skid slot is full)
  DeepCache #(.MISS_LATENCY (MISS_LATENCY), .STREAM_PREFETCH (1'b1), .PREDECODE (1'b1)) instruction_cache (
    .clk (clk), .reset (reset || FENCE_I_NOW), .FREEZE (FREEZE),
    .LOOKUP_ADDRESS ({32'd0, F3.pc}), .EARLY_SET (F2.pc[10:5]), .EARLY_LOAD (!FSTALL), .LOOKUP_HIT (ICACHE_HIT), .LOOKUP_DATA (ICACHE_DATA), .LOOKUP_PREDECODE (ICACHE_PREDECODE),
    .LOOKUP_WAY0 (ICACHE_WAY0), .LOOKUP_WAY1 (ICACHE_WAY1), .LOOKUP_DATA0 (ICACHE_DATA0), .LOOKUP_DATA1 (ICACHE_DATA1),
    .LOOKUP_PREDECODE0 (ICACHE_PREDECODE0), .LOOKUP_PREDECODE1 (ICACHE_PREDECODE1), .TOUCH (F4_HIT_ADVANCE), .TOUCH_SET (F4.pc[10:5]), .TOUCH_WAY0 (F4_WAY0),
    .WRITE_MASK (8'd0), .WRITE_DATA (ICACHE_WRITE_DATA_UNUSED),
    .PROBE_NEXT_ADDRESS ({32'd0, IWAIT ? F1PC : F4.pc}), .PROBE_HIT (ICACHE_PROBE_HIT),
    .DEMAND (ICACHE_WANT), .DEMAND_ADDRESS ({32'd0, ICACHE_MISS_PC}),
    .BUSY (ICACHE_BUSY), .BUSY_LINE (ICACHE_BUSY_LINE), .CYCLES_LEFT (ICACHE_LEFT),
    .REFILL_ADDRESS (INSTRUCTION_REFILL_ADDRESS), .REFILL_LINE (INSTRUCTION_REFILL_LINE)
  );
  // the line M1 used is marked used a cycle later (M2), from registers, so the tag compare stays off the LRU bits
  logic DTOUCH, DTOUCH_WAY0; logic [5:0] DTOUCH_SET;
  always_ff @(posedge clk) begin
    if (reset) DTOUCH <= 1'b0;
    else if (!FREEZE) begin
      DTOUCH <= (M1_LOAD || (M1_STORE && (STORE_MASK != 8'd0))) && DCACHE_HIT;
      DTOUCH_SET <= M.address[10:5]; DTOUCH_WAY0 <= DCACHE_WAY0;
    end
  end
  assign DCACHE_DEMAND = M1_MISS || (DWAIT_VALID && !DCACHE_PROBE_HIT && !(DCACHE_BUSY && DCACHE_BUSY_LINE == DWAIT_LINE));
  assign DCACHE_DEMAND_ADDRESS = M1_MISS ? M.address : DWAIT_LINE; // (the refill starts as the miss is found, in M1)
  // (X4 reads the arrays at the set X1's slice made, M1 compares the tags and picks the way; the back end never holds)
  DeepCache #(.MISS_LATENCY (MISS_LATENCY), .STREAM_PREFETCH (1'b0)) data_cache (
    .clk (clk), .reset (reset), .FREEZE (FREEZE),
    .LOOKUP_ADDRESS (M.address), .EARLY_SET (BE[3].address[10:5]), .EARLY_LOAD (1'b1), .LOOKUP_HIT (DCACHE_HIT), .LOOKUP_DATA (DCACHE_DATA), .LOOKUP_PREDECODE (DCACHE_PREDECODE_UNUSED),
    .LOOKUP_WAY0 (DCACHE_WAY0), .LOOKUP_WAY1 (DCACHE_WAY1_UNUSED), .LOOKUP_DATA0 (DCACHE_DATA0_UNUSED), .LOOKUP_DATA1 (DCACHE_DATA1_UNUSED),
    .LOOKUP_PREDECODE0 (DCACHE_PREDECODE0_UNUSED), .LOOKUP_PREDECODE1 (DCACHE_PREDECODE1_UNUSED), .TOUCH (DTOUCH), .TOUCH_SET (DTOUCH_SET), .TOUCH_WAY0 (DTOUCH_WAY0),
    .WRITE_MASK (DATA_WRITE_MASK), .WRITE_DATA (STORE_DATA),
    .PROBE_NEXT_ADDRESS (MISS_R ? {BE[5].address[63:5], 5'd0} : DWAIT_LINE), .PROBE_HIT (DCACHE_PROBE_HIT),
    .DEMAND (DCACHE_DEMAND), .DEMAND_ADDRESS (DCACHE_DEMAND_ADDRESS),
    .BUSY (DCACHE_BUSY), .BUSY_LINE (DCACHE_BUSY_LINE), .CYCLES_LEFT (DCACHE_LEFT),
    .REFILL_ADDRESS (DATA_REFILL_ADDRESS), .REFILL_LINE (DATA_REFILL_LINE)
  );

  // ================================================================ counters (bubbles as they reach W) and trace
  back_slot_t WB;
  assign WB = BE[7];
  assign INSTRUCTION_RETIRED = WB.valid && !FREEZE;
  assign PERFORMANCE_EVENTS = FREEZE ? 8'd0 : {
    !WB.valid && WB.depth, // B: bubbles only the deeper pipeline has
    !WB.valid && !WB.depth && (WB.cause == CAUSE_INTERRUPT),
    !WB.valid && !WB.depth && (WB.cause == CAUSE_DMISS),
    !WB.valid && !WB.depth && (WB.cause == CAUSE_IMISS),
    !WB.valid && !WB.depth && (WB.cause == CAUSE_MDU),
    !WB.valid && !WB.depth && (WB.cause == CAUSE_REDIRECT),
    FLUSH && !REPLAY, // F counts flushes (their 3 six-stage bubbles always reach W)
    !WB.valid && !WB.depth && (WB.cause == CAUSE_STALL)};
  assign TRACE_FLAGS = {TAKE_INTERRUPT, REPLAY, REPLAY || (ADVANCE && !REDIRECT && !IMISS_F4 && !IGATE && DGATE),
                        IMISS_F4 || (ADVANCE && !REDIRECT && IGATE), MDU_BUSY, REDIRECT, FLUSH && !REPLAY, HOLD};
  always_comb begin
    TRACE_VALID[0] = FETCH; TRACE_PC[0] = F1PC;
    TRACE_VALID[1] = F2.valid; TRACE_PC[1] = F2.pc;
    TRACE_VALID[2] = F3.valid; TRACE_PC[2] = F3.pc;
    TRACE_VALID[3] = F4.valid; TRACE_PC[3] = F4.pc;
    TRACE_VALID[4] = D1.f.valid; TRACE_PC[4] = D1.f.pc;
    TRACE_VALID[5] = D2.f.valid; TRACE_PC[5] = D2.f.pc;
    for (int j = 0; j < 8; j++) begin TRACE_VALID[6 + j] = BE[j].valid; TRACE_PC[6 + j] = BE[j].pc; end
  end

  // ================================================================ the clock edge
  function automatic fetch_slot_t bubble(input logic [2:0] cause, input logic depth);
    fetch_slot_t b;
    b = '0; b.cause = cause; b.depth = depth;
    return b;
  endfunction
  function automatic logic [63:0] next_xa(input back_slot_t s, input logic [63:0] a);
    return s.a_is_pc ? {32'd0, s.pc} : prepare_a(a, s.a_zext, s.a_shift);
  endfunction
  function automatic logic [63:0] next_xb(input back_slot_t s, input logic [63:0] b);
    return (s.b_is_imm ? s.imm : b) ^ {64{s.bflip}};
  endfunction
  function automatic back_slot_t back_bubble(input logic [2:0] cause, input logic depth);
    back_slot_t b;
    b = '0; b.cause = cause; b.depth = depth;
    return b;
  endfunction
  function automatic decode_slot_t decode_bubble(input logic [2:0] cause, input logic depth);
    decode_slot_t b;
    b = '0; b.f.cause = cause; b.f.depth = depth;
    return b;
  endfunction
  function automatic back_slot_t to_back(input decode_slot_t d); // a bubble moving from D2 into X1
    back_slot_t b;
    b = '0; b.cause = d.f.cause; b.depth = d.f.depth;
    return b;
  endfunction
  function automatic decode_slot_t to_decode(input fetch_slot_t f); // a bubble moving from F4 into D1
    decode_slot_t d;
    d = '0; d.f = f;
    return d;
  endfunction

  decode_slot_t D1_OUT;
  always_comb begin // D1 checks the BTB's guess (F4 trusted it, so its adder and compare stay off the redirect path)
    D1_OUT = D1; D1_OUT.dec = D1_DECODED;
    D1_OUT.btb_bad = D1.f.valid && D1.f.btb_go && (D1.target != D1.f.btb_target);
  end

  fetch_slot_t F1_SLOT;
  always_comb begin
    F1_SLOT = '0;
    F1_SLOT.valid = 1'b1; F1_SLOT.pc = F1PC; F1_SLOT.pred = F1_PRED; F1_SLOT.gidx = GSHARE_INDEX; F1_SLOT.gtaken = GSHARE_TAKEN; F1_SLOT.btaken = BHT_TAKEN;
    F1_SLOT.btb_go = BTB_GO; F1_SLOT.btb_target = BTB_GO ? BTB_TARGET[31:0] : 32'd0;
  end

  always_ff @(posedge clk) begin
    if (reset) begin
      HALTED <= 1'b0;
      F1PC <= RESET_VECTOR;
      IWAIT <= 1'b0; DWAIT_VALID <= 1'b0; DWAIT_LINE <= 64'd0;
      F2 <= bubble(CAUSE_FILL, 1'b1); F3 <= bubble(CAUSE_FILL, 1'b1); F4 <= bubble(CAUSE_FILL, 1'b1);
      F4_HIT <= 1'b0; F4_WAY0 <= 1'b0; F4_WAY1 <= 1'b0; F4_WORD0 <= 32'd0; F4_WORD1 <= 32'd0; F4_PREDECODE0 <= 36'd0; F4_PREDECODE1 <= 36'd0;
      D1 <= decode_bubble(CAUSE_FILL, 1'b1); D2 <= decode_bubble(CAUSE_FILL, 1'b1); SKID <= decode_bubble(CAUSE_FILL, 1'b0); FSTALL <= 1'b0;
      for (int j = 0; j < 8; j++) BE[j] <= back_bubble(CAUSE_FILL, j <= 2);
      for (int r = 0; r < 32; r++) RF[r] <= 64'd0;
      MDU_BUSY <= 1'b0; MDU_PHASE <= 1'b0; MDU_RD <= 5'd0;
    end else if (HALT_NOW) begin // only the instruction in W finishes
      if (WB.reg_write && WB.rd != 5'd0 && !WB.is_muldiv) RF[WB.rd] <= WB.result;
      HALTED <= 1'b1;
    end else if (!HALTED) begin
      // ---- register file
      if (WB.valid && WB.reg_write && WB.rd != 5'd0 && !WB.is_muldiv) RF[WB.rd] <= WB.result;
      if (MDU_READY && MDU_PHASE && MDU_RD != 5'd0) RF[MDU_RD] <= MDU_RESULT;
      // ---- M unit bookkeeping
      if (MDU_BUSY) begin
        MDU_PHASE <= !MDU_PHASE;
        if (MDU_READY && MDU_PHASE) MDU_BUSY <= 1'b0;
      end
      if (MDU_REQUEST) begin MDU_BUSY <= 1'b1; MDU_PHASE <= 1'b0; MDU_RD <= M.rd; end
      // ---- the back end moves on
      for (int j = 7; j >= 1; j--) BE[j] <= BE[j - 1];
      // operands move on, refreshed from their producers' slots
      for (int j = 0; j <= 4; j++) begin
        unique case (j)
          0: begin BE[1].op_a <= `NEXT_A(0, 0); BE[1].op_b <= `NEXT_B(0, 0); end
          1: begin BE[2].op_a <= `NEXT_A(1, 1); BE[2].op_b <= `NEXT_B(1, 1); end
          2: begin BE[3].op_a <= `NEXT_A(2, 2); BE[3].op_b <= `NEXT_B(2, 2); end
          3: begin BE[4].op_a <= `NEXT_A(3, 3); BE[4].op_b <= `NEXT_B(3, 3); end
          default: begin BE[5].op_a <= `NEXT_A(4, 4); BE[5].op_b <= `NEXT_B(4, 4); end
        endcase
      end
      for (int j = 0; j <= 2; j++) begin // where the next slice's operands come from
        BE[j + 1].xsel_a <= BE[j].late_a[j + 1] ? {1'b0, BE[j].lsel_a} : 5'b10000;
        BE[j + 1].xsel_b <= (BE[j].late_b[j + 1] && !BE[j].b_is_imm) ? {1'b0, BE[j].lsel_b} : 5'b10000;
      end
      for (int j = 0; j <= 2; j++) begin // the next slice's operands, prepared
        unique case (j)
          0: begin BE[1].xa <= next_xa(BE[0], `NEXT_A(0, 0)); BE[1].xb <= next_xb(BE[0], `NEXT_B(0, 0)); end
          1: begin BE[2].xa <= next_xa(BE[1], `NEXT_A(1, 1)); BE[2].xb <= next_xb(BE[1], `NEXT_B(1, 1)); end
          default: begin BE[3].xa <= next_xa(BE[2], `NEXT_A(2, 2)); BE[3].xb <= next_xb(BE[2], `NEXT_B(2, 2)); end
        endcase
      end
      // the slices
      for (int k = 0; k < 4; k++) begin
        BE[k + 1].address[16*k +: 16] <= XY[k];
        if (BE[k].yres) BE[k + 1].result[16*k +: 16] <= XY[k];
        BE[k + 1].carry <= XCARRY[k];
        BE[k + 1].eq <= XEQ[k];
      end
      // X3 prepares the whole-value unit's operands
      BE[3].pa <= X3_PA; BE[3].pb <= X3_PB; BE[3].whole_sel <= X3_SELECT; BE[3].nibbles <= X3_NIBBLES;
      BE[3].high <= X3_HIGH; BE[3].low <= X3_LOW;
      BE[5].halves <= M1_HALVES;
      // X4: the whole-value unit's middle stage
      BE[4].right_coarse <= X4_RIGHT; BE[4].left_coarse <= X4_LEFT; BE[4].fine <= X4_FINE;
      BE[4].leading <= X4_LEADING; BE[4].trailing <= X4_TRAILING; BE[4].quarters <= X4_QUARTERS; BE[4].simple <= X4_SIMPLE;
      // X4's results into M1
      BE[4].taken <= X4_TAKEN;
      BE[4].wrong_taken <= X4_WRONG_TAKEN; BE[4].wrong_not <= X4_WRONG_NOT;
      BE[3].jalr_hit <= (BE[2].target == {BE[2].address[31:1], 1'b0}); // (X1 and X2 made the address's low 32 bits)
      BE[3].alt_pc <= BE[2].is_jalr ? {BE[2].address[31:1], 1'b0} : BE[2].is_jal ? BE[2].btarget : X3_PC4;
      BE[3].ras_after <= BE[2].ras_ckpt + {2'd0, BE[2].is_call} - {2'd0, BE[2].is_return};
      BE[4].lt <= X4_LT;
      BE[4].csr_sel <= X4_CSR_SELECT;
      if (BE[3].is_slt) BE[4].result <= {63'd0, X4_LT};
      // M1's into M2
      if (M.valid) begin
        if (M.mem_read) BE[5].result <= IS_DEVICE ? DEVICE_READ_DATA : DCACHE_DATA;
        else if (M.is_csr) BE[5].result <= CSR_READ_DATA;
        else if (!M.is_custom && ((M.alu_op == ALU_MIN) || (M.alu_op == ALU_MINU) || (M.alu_op == ALU_MAX) || (M.alu_op == ALU_MAXU)))
          BE[5].result <= M1_LATE_RESULT;
        else if (M.whole && (M.alu_op != ALU_CPOP)) BE[5].result <= M1_WHOLE;
      end
      // M2's into M3
      if (BE[5].valid) begin
        if (BE[5].mem_read) BE[6].result <= M2_LOADED;
        else if (BE[5].is_custom) BE[6].result <= CUSTOM_RESULT;
        else if (BE[5].whole && (BE[5].alu_op == ALU_CPOP)) BE[6].result <= {57'd0, M2_POPULATION};
      end
      // ---- what enters X1, and the front end
      if (FLUSH || TAKE_INTERRUPT) begin
        // the refill makes 6 bubbles (X1 now, then D2 D1 F4 F3 F2): a flush's first 3 cost what the six-stage
        // pipeline pays; the rest, and every instruction dropped from X1..X4, are depth bubbles
        logic [2:0] cause;
        logic deep;
        cause = REPLAY ? CAUSE_DMISS : FLUSH ? CAUSE_FLUSH : CAUSE_INTERRUPT;
        deep = (cause == CAUSE_FLUSH);
        BE[0] <= back_bubble(cause, 1'b0);
        D2 <= decode_bubble(cause, 1'b0); D1 <= decode_bubble(cause, 1'b0); SKID.f.valid <= 1'b0; FSTALL <= 1'b0;
        F4 <= bubble(cause, deep); F3 <= bubble(cause, deep); F2 <= bubble(cause, deep);
        if (FLUSH) begin
          for (int j = 0; j <= 4; j++) if (BE[j].valid && (j <= 3 || REPLAY)) BE[j + 1] <= back_bubble(cause, deep); // X1..X4 (and M1 for a replay)
          if (REPLAY) BE[6] <= back_bubble(cause, 1'b0); // the load, from M2 (otherwise M1 moves on as usual)
        end
        F1PC <= FLUSH ? ADJUST : TRAP_VECTOR[31:0];
        if (REPLAY) begin DWAIT_VALID <= (BE[5].address[63:32] == 32'd0); DWAIT_LINE <= {BE[5].address[63:5], 5'd0}; end
        IWAIT <= 1'b0;
      end else begin
        // X1 takes D2's fields whether or not it issues (a bubble's fields are never read), so only valid, cause
        // and depth wait for the issue decision
        BE[0] <= ISSUED;
        BE[0].valid <= ISSUE;
        BE[0].cause <= HOLD ? HOLD_CAUSE : D2.f.cause;
        BE[0].depth <= !HOLD && !ISSUE && D2.f.depth;
        // D2 and the skid slot: a hold keeps D2 and parks D1's instruction (a bubble leaving D1 is dropped);
        // otherwise D2 takes the skid slot's instruction first, else D1's
        if (HOLD) begin if (ADVANCE && D1.f.valid) SKID <= D1_OUT; end
        else if (SKID.f.valid) begin D2 <= SKID; SKID.f.valid <= 1'b0; end
        else if (ADVANCE) D2 <= D1_OUT;
        FSTALL <= HOLD && (SKID.f.valid || (ADVANCE && D1.f.valid));
      end
      if (!FLUSH && !TAKE_INTERRUPT && ADVANCE) begin // F1..D1
        if (F4_HIT_ADVANCE) begin
          decode_slot_t d;
          d = '0; d.f = F4; d.f.btb_go = F4.btb_go && !F4_BTB_UNDO; d.word = F4_WORD; d.ctl = F4_CONTROL; d.ckpt = GLOBAL_HISTORY; d.ras_ckpt = RAS_POINTER;
          d.is_call = F4_IS_CALL; d.is_return = F4_IS_RETURN; d.target = F4_TARGET; d.btarget = F4_BTARGET; d.btb_bad = 1'b0;
          D1 <= d;
        end else D1 <= IMISS_F4 ? decode_bubble(CAUSE_IMISS, 1'b0) : to_decode(F4);
        // F3's lookup, for F4 (F3's instruction moves to F4 only on the last branch below; otherwise F4 gets a bubble)
        F4_HIT <= ICACHE_HIT; F4_WAY0 <= ICACHE_WAY0; F4_WAY1 <= ICACHE_WAY1;
        F4_WORD0 <= F3.pc[2] ? ICACHE_DATA0[63:32] : ICACHE_DATA0[31:0]; F4_WORD1 <= F3.pc[2] ? ICACHE_DATA1[63:32] : ICACHE_DATA1[31:0];
        F4_PREDECODE0 <= ICACHE_PREDECODE0; F4_PREDECODE1 <= ICACHE_PREDECODE1;
        if (IMISS_F4) begin // restart F1 at the missing instruction; it asks for the line and waits until it is nearly in
          F4 <= F3.valid ? bubble(CAUSE_IMISS, 1'b0) : F3;
          F3 <= F2.valid ? bubble(CAUSE_IMISS, 1'b0) : F2;
          F2 <= bubble(CAUSE_IMISS, 1'b0);
          F1PC <= F4.pc; IWAIT <= 1'b1;
        end else if (REDIRECT) begin // F1 fetched nothing this cycle; F3's and F2's instructions are dropped
          F4 <= F3.valid ? bubble(CAUSE_REDIRECT, 1'b0) : F3;
          F3 <= F2.valid ? bubble(CAUSE_REDIRECT, F3.valid) : F2;
          F2 <= bubble(CAUSE_REDIRECT, F3.valid || F2.valid);
          F1PC <= F4_TARGET;
        end else begin
          F4 <= F3;
          F3 <= F2;
          F2 <= FETCH ? F1_SLOT : bubble(IGATE ? CAUSE_IMISS : CAUSE_DMISS, 1'b0);
          if (FETCH) begin F1PC <= BTB_GO ? BTB_TARGET[31:0] : plus4(F1PC); IWAIT <= 1'b0; DWAIT_VALID <= 1'b0; end
        end
      end
    end
  end

  /* verilator lint_off UNUSEDSIGNAL */
  logic UNUSED;
  assign UNUSED = ^{BTB_TARGET[63:32], RAS_TOP[63:32], DCACHE_PREDECODE_UNUSED, DCACHE_PREDECODE0_UNUSED, DCACHE_PREDECODE1_UNUSED,
                   DCACHE_DATA0_UNUSED, DCACHE_DATA1_UNUSED, DCACHE_WAY1_UNUSED, ICACHE_DATA, ICACHE_PREDECODE};
  /* verilator lint_on UNUSEDSIGNAL */
endmodule

`undef SLOT
`undef LATE
`undef RS1
`undef RS2
`undef NEXT_A
`undef NEXT_B
`default_nettype wire
