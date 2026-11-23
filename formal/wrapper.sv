// rvfi_wrapper: the Sixfold core inside riscv-formal (make formal; formal/README.md explains it).
//
// Everything outside the core is left to the solver: every instruction word fetched, every doubleword loaded,
// whether each cache access hits or misses, and whether the branch predictor is on. riscv-formal then proves
// its checks hold for EVERY such choice, up to the bounded number of cycles in formal/checks.cfg.
//
// Two assumptions narrow that, both because Sixfold does not implement the matching exceptions yet (the
// "trap completeness" add-on removes them):
//   1. no load or store is misaligned        (the core ignores the low address bits instead of trapping)
//   2. no jump or branch goes to an address that is not a multiple of 4   (it jumps instead of trapping)
// A third keeps program memory consistent (see "Program memory does not change" below).
// Interrupt lines are held at 0: interrupts are not checked in this first cut.

module rvfi_wrapper (
	input clock,
	input reset,
	`RVFI_OUTPUTS
);
	(* keep *) `rvformal_rand_reg [31:0] icache_dout;
	(* keep *) `rvformal_rand_reg        icache_hit;
	(* keep *) `rvformal_rand_reg [63:0] dcache_dout;
	(* keep *) `rvformal_rand_reg        dcache_hit;
	(* keep *) `rvformal_rand_const_reg  prediction_on;

	(* keep *) wire [63:0] icache_addr, dcache_addr, dcache_din, tohost, debug_data;
	(* keep *) wire [7:0]  dcache_we;
	(* keep *) wire        dcache_re, halted;
	wire        icache_invalidate, icache_capture, dcache_capture; // ZIFENCEI = 0 and SRAM_CACHES = 0 here: unused
	wire [5:0]  trace_valid;
	wire [63:0] trace_pc1, trace_pc2, trace_pc3, trace_pc4, trace_pc5, trace_pc6;
	wire        trace_load_stall, trace_flush, trace_redirect, trace_md_stall, trace_imiss, trace_dmiss;

`ifdef BASELINE
	Riscv64 #(.GSHARE_HISTORY_BITS(4), .BTB_ENABLE(1'b0), .RAS_ENABLE(1'b0), .PRECISE_LOAD_STALL(1'b0),
	          .ITERATIVE_MULTIPLY_DIVIDE(1'b0), .TOURNAMENT_PREDICTOR(1'b0)) uut (
`else
	Riscv64 uut (
`endif
		.clk                      (clock),
		.reset                    (reset),
		.BRANCH_PREDICTION_ENABLE (prediction_on),
		.TIMER_INTERRUPT_LINE     (1'b0),
		.EXTERNAL_INTERRUPT_LINE  (1'b0),
		.RESET_VECTOR             (64'h2000),
		.dcache_addr              (dcache_addr),
		.icache_addr              (icache_addr),
		.dcache_we                (dcache_we),
		.dcache_din               (dcache_din),
		.dcache_dout              (dcache_dout),
		.icache_dout              (icache_dout),
		.icache_hit               (icache_hit),
		.icache_invalidate        (icache_invalidate),
		.icache_capture           (icache_capture),
		.dcache_capture           (dcache_capture),
		.icache_dout_late         (32'd0),   // SRAM_CACHES = 0: unused
		.dcache_dout_late         (64'd0),
		.dcache_re                (dcache_re),
		.dcache_hit               (dcache_hit),
		.csr                      (tohost),
		.HALTED                   (halted),
		.DEBUG_REGISTER_ADDRESS   (5'd0),
		.DEBUG_REGISTER_DATA      (debug_data),
		.TRACE_VALID              (trace_valid),
		.TRACE_FETCH1_PC          (trace_pc1),
		.TRACE_FETCH2_PC          (trace_pc2),
		.TRACE_DECODE_PC          (trace_pc3),
		.TRACE_EXECUTE_PC         (trace_pc4),
		.TRACE_MEMORY_PC          (trace_pc5),
		.TRACE_WRITEBACK_PC       (trace_pc6),
		.TRACE_LOAD_STALL         (trace_load_stall),
		.TRACE_FLUSH              (trace_flush),
		.TRACE_REDIRECT           (trace_redirect),
		.TRACE_MULTIPLY_DIVIDE_STALL (trace_md_stall),
		.TRACE_INSTRUCTION_MISS   (trace_imiss),
		.TRACE_DATA_MISS          (trace_dmiss),
		`RVFI_CONN
	);

	// Program memory does not change while the program runs: fetching the same address twice gives the same
	// word. Without this the solver may answer two fetches of one PC with two different instructions, which no
	// real program memory does, and the branch target buffer (which remembers "the instruction at this PC is
	// a JAL") would be blamed for it. The last FETCH_RECORDS fetches are remembered, enough for every fetch in
	// the deepest check (formal/checks.cfg). Self-modifying code (FENCE.I) is left out: the formal build keeps ZIFENCEI = 0.
	localparam integer FETCH_RECORDS = 24;
	reg [FETCH_RECORDS-1:0] fetch_valid;
	reg [63:0] fetch_address [0:FETCH_RECORDS-1];
	reg [31:0] fetch_word    [0:FETCH_RECORDS-1];
	integer i;
	always @(posedge clock) begin
		if (reset) fetch_valid <= 0;
		else if (icache_hit) begin
			for (i = FETCH_RECORDS-1; i > 0; i = i - 1) begin
				fetch_valid[i]   <= fetch_valid[i-1];
				fetch_address[i] <= fetch_address[i-1];
				fetch_word[i]    <= fetch_word[i-1];
			end
			fetch_valid[0]   <= 1'b1;
			fetch_address[0] <= icache_addr;
			fetch_word[0]    <= icache_dout;
		end
	end
	always @* begin
		if (!reset && icache_hit)
			for (i = 0; i < FETCH_RECORDS; i = i + 1)
				if (fetch_valid[i] && fetch_address[i] == icache_addr) assume (icache_dout == fetch_word[i]);
	end

	// The two assumptions above, stated on what retires
	wire [6:0]  opcode  = rvfi_insn[6:0];
	wire [2:0]  funct3  = rvfi_insn[14:12];
	wire [63:0] load_address  = rvfi_rs1_rdata + {{52{rvfi_insn[31]}}, rvfi_insn[31:20]};
	wire [63:0] store_address = rvfi_rs1_rdata + {{52{rvfi_insn[31]}}, rvfi_insn[31:25], rvfi_insn[11:7]};
	wire [63:0] address = (opcode == 7'b0100011) ? store_address : load_address;
	wire [2:0]  low_bits_that_must_be_zero = (funct3[1:0] == 2'd0) ? 3'b000 : (funct3[1:0] == 2'd1) ? 3'b001 : (funct3[1:0] == 2'd2) ? 3'b011 : 3'b111;
	// Jump and branch targets, computed from the instruction itself (never from what the core reports, so a core
	// that computes a wrong target is still caught): bit 1 of the offset (JAL, branches) or of rs1 + offset (JALR)
	wire [63:0] jalr_target = rvfi_rs1_rdata + {{52{rvfi_insn[31]}}, rvfi_insn[31:20]};
	always @* begin
		if (!reset && rvfi_valid) begin
			if (opcode == 7'b0000011 || opcode == 7'b0100011) assume ((address[2:0] & low_bits_that_must_be_zero) == 3'b000);
			if (opcode == 7'b1101111) assume (rvfi_insn[21] == 1'b0); // JAL: offset bit 1
			if (opcode == 7'b1100011) assume (rvfi_insn[8] == 1'b0);  // branches: offset bit 1
			if (opcode == 7'b1100111) assume (jalr_target[1] == 1'b0); // JALR
		end
	end
endmodule
