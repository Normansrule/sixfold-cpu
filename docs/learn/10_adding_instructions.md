# 10. Adding an instruction: SHA-2 in hardware, and one of our own

Every instruction in Sixfold arrived the same way: someone decided a common job deserved its own
32-bit pattern, picked a pattern nobody else was using, and taught each layer of the design what to do
with it. This chapter does that twice, with real instructions, and measures whether it was worth it.

* **Zknh**, eight instructions from the ratified RISC-V Scalar Cryptography extension. They compute
  the "sigma" functions at the heart of SHA-256 and SHA-512, the hash behind every software update,
  every Git commit and every TLS certificate.
* **`hsec.cteq`**, an instruction we invent: compare two registers for equality, in a way that cannot
  leak *how much* of them matched. It lives in an opcode the RISC-V specification sets aside for
  exactly this.

Both are borrowed from [HYDRA-130](https://github.com/Normansrule/hydra-skywater130), a security chip
that uses them for measured boot and for its key vault. Here they are the worked example.

## Is it worth an instruction?

Start with a measurement, not a design. One SHA-256 block runs 48 message-schedule steps and 64
rounds, and each uses two sigma functions. Without Zknh, each sigma is three rotations and two XORs,
and RV64 has no 32-bit rotate-by-constant that leaves the upper half alone, so each rotation is a
shift, a shift and an OR: 8 to 11 instructions. With Zknh, each sigma is one.

[`programs/23_sha256.s`](../../programs/23_sha256.s) hashes `"abc"` both ways and checks both digests
against the published answer, `ba7816bf…f20015ad`:

| | cycles for one block | instructions per sigma |
|---|---:|---:|
| RV64I + Zbb | 4,698 | 8 to 11 |
| with Zknh | 2,731 | 1 |

That is 1.72 times faster. The cost is 768 two-input XOR gates for all eight instructions: each
function is a three-input XOR per bit (two gates), on 32 bits for SHA-256 and 64 for SHA-512, and the
rotations are only wiring. A 1.7× speed-up on a common job for well under a thousand small gates is
the kind of trade an instruction set takes.

Try it: `make run PROG=23_sha256` and read `a5` and `a6`.

## Choosing a bit pattern

A new instruction needs a 32-bit pattern that no existing instruction decodes to. There are two ways to
get one.

**Use the standard one.** Zknh is ratified, so its encodings are already chosen. All eight sit in
`OP-IMM` (opcode `0010011`) with `funct3 = 001`, the same place as `slli` and `clz`, and are told
apart by the 12-bit field in bits 31 to 20:

```
 31        20 19   15 14  12 11    7 6      0
+------------+-------+------+-------+--------+
|  funct12   |  rs1  | 001  |  rd   |0010011 |   sha256sum0 = 0x100 ... sha512sig1 = 0x107
+------------+-------+------+-------+--------+
```

`slli` with a shift amount below 64 always has bits 31 to 26 equal to zero, so `0x100` to `0x107`
(bits 31 to 26 = `000100`) cannot be mistaken for it. Check any pattern you choose against every row
already in the table: `node tools/rv.mjs encode "sha256sig0 a0, a1"` prints it.

**Invent one.** For an instruction of your own, the specification reserves four major opcodes,
*custom-0* to *custom-3*, that no standard extension will ever use. `hsec.cteq` takes custom-0
(`0001011`) and the R-type layout, so it reads two registers and writes one:

```
 31     25 24   20 19   15 14  12 11    7 6      0
+---------+-------+-------+------+-------+--------+
| 0000000 |  rs2  |  rs1  | 110  |  rd   |0001011 |   hsec.cteq rd, rs1, rs2
+---------+-------+-------+------+-------+--------+
```

Everything else in custom-0 stays unused, so the next instruction you invent has room.

## The five places an instruction lives

An instruction is not one change. It is the same fact written into five places, and the test suite
checks that they agree.

### 1. The table: [`model/isa.js`](../../model/isa.js)

The single source of truth. One row gives the assembler the name, the format and the bit pattern;
the disassembler, the binary pages in `binary/` and the format diagrams are generated from it.

```js
I('sha256sig0', 'I-unary', O.OP_IMM,   0b001, 0x102,     'rr',  'Zknh',      'Cryptography', 'SHA-256 sigma0 (message schedule)', 'rd = sext(ror32(rs1,7) ^ ror32(rs1,18) ^ (rs1[31:0] >>u 3))'),
I('hsec.cteq',  'R',       O.CUSTOM_0, 0b110, 0b0000000, 'rrr', 'Xhydrasec', 'Cryptography', 'Constant-time Equal', 'rd = (rs1 == rs2) ? 1 : 0, ...'),
```

A new opcode also needs a name: `CUSTOM_0: 0b0001011` in `OPCODES`.

### 2. The operation's name: [`src/ALUop_pkg.sv`](../../src/ALUop_pkg.sv)

DECODE turns each instruction into an ALU operation code. Zknh adds eight, `ALU_SHA256SUM0` (47) to
`ALU_SHA512SIG1` (54), and `hsec.cteq` one, `ALU_CTEQ` (55). The field is 6 bits wide, so there is
room for 8 more before it has to grow.

### 3. Decoding: [`src/ALUdec.sv`](../../src/ALUdec.sv), [`src/Control_Unit.sv`](../../src/Control_Unit.sv), [`src/Opcode_pkg.sv`](../../src/Opcode_pkg.sv)

For Zknh, the opcode is already known, so `ControlUnit` already says "read `rs1`, write `rd` from the
ALU". Only `ALUdec` changes, one line per instruction, next to `clz`:

```systemverilog
12'h102: ALUop = ALU_SHA256SIG0; // Zknh: same opcode and funct3 as clz, a new funct12
```

For `hsec.cteq` the opcode is new, so three files change. `Opcode_pkg` names it. `ControlUnit` must be
told the two things it decides by opcode: which source registers the instruction reads (so the hazard
logic stalls and forwards for them) and whether it writes a register:

```systemverilog
OPC_ARI_RTYPE, OPC_ARI_RTYPE_WORD, OPC_STORE, OPC_BRANCH, OPC_CUSTOM0: begin USES_REGISTER1 = 1'b1; USES_REGISTER2 = 1'b1; end
...
OPC_CUSTOM0: begin
    REGISTER_WRITE_ENABLE = (INSTRUCTION_FUNCT7 == 7'b0000000) && (INSTRUCTION_FUNCT3 == 3'b110);
    WRITEBACK_SELECT = WRITEBACK_ALU;
end
```

Forget the first line and nothing fails to compile. The performance build stalls after a load only
if the next instruction really reads the loaded register, and it asks `USES_REGISTER2` whether it
does. Without the line, `hsec.cteq` right after a load into its `rs2` runs one cycle too early and
compares against the old value. The regression has a test for exactly that (see step 6).

Note that `REGISTER_WRITE_ENABLE` is on only for the exact pattern. Any other bit pattern in custom-0
writes nothing and does nothing.

### 4. The datapath: [`src/ALU.sv`](../../src/ALU.sv)

```systemverilog
function automatic logic [31:0] ror32(input logic [31:0] x, input int n);
    return (x >> n) | (x << (32 - n));   // a rotate by a CONSTANT is only wires
endfunction
...
sha256_sig0 = ror32(rs1[31:0], 7) ^ ror32(rs1[31:0], 18) ^ (rs1[31:0] >> 3);
...
ALU_SHA256SIG0: alu_result = {{32{sha256_sig0[31]}}, sha256_sig0};   // sign-extend, as the spec says
ALU_CTEQ:       alu_result = {63'd0, (xor_result == 64'd0)};
```

Two decisions hide in these lines.

*Which result path?* The ALU has two outputs: `ALUOutFast`, short enough to forward to the next
instruction in the same cycle, and `ALUOut`, for results like `cpop` that need one cycle more. A
three-input XOR is far shallower than the 64-bit adder, and `xor_result == 0` is an XOR and a 64-input
NOR, about as deep as the adder's carry tree, so all nine join the fast path and add no stall. If an
instruction were deeper, it would join `LATE_RESULT` instead, and the hazard unit would treat it like a
load. `make timing` shows whether the decision held.

*Reuse what is there.* `hsec.cteq` uses `xor_result`, which the ALU computes anyway for `xor`, rather
than a new comparator.

### 5. The twin: [`model/core.js`](../../model/core.js)

The JavaScript model must decode and compute exactly as the RTL does, because `make test` runs every
program on both and compares them cycle by cycle. Three edits mirror steps 3 and 4: the opcode in
`usesRegisters`, the decode in `aluDecode` and `control`, and the arithmetic in `alu`:

```js
case 'SHA256SIG0': return sx32(ror32(a, 7n) ^ ror32(a, 18n) ^ (u32(a) >> 3n));
case 'CTEQ': return (a ^ b) === 0n ? 1n : 0n;
```

## 6. Proving it: three implementations that must agree

Writing the function twice, once in SystemVerilog and once in JavaScript, catches typos only if the
two typos differ. So the tests use a third version, written separately from the standard:

* [`tools/gen_selfcheck.py`](../../tools/gen_selfcheck.py) holds the FIPS 180-4 definitions in Python
  and generates [`tests/zknh_selfcheck.s`](../../tests/zknh_selfcheck.s): every new instruction on 24
  operands, including the SHA-2 starting values, with the Python answer built into the test. A few
  cases check the pipeline rather than the arithmetic: a Zknh result used by the very next instruction
  (forwarding), `hsec.cteq` right after a load into its `rs2` (the stall), `hsec.cteq` feeding a
  branch, and a different custom-0 pattern that must write nothing. (They are in their own file
  because `tests/isa_selfcheck.s` already fills most of the 64 KiB test memory.)
* [`programs/23_sha256.s`](../../programs/23_sha256.s) checks the whole algorithm against the
  published digest, so a function that is self-consistent but wrong still fails.
* `make test` runs both on the model and on the RTL, with and without the branch predictor, on both
  builds, and requires every register and every cycle count to match.

```bash
python3 tools/gen_selfcheck.py      # regenerate both self-checks
make test                           # RTL against the model, cycle-exact
make math                           # the cycle equation still accounts for every cycle
make lint                           # Verilator, all warnings
make docs                           # binary/ pages for the new instructions
```

## Why "constant time" is a hardware question

To check a password or a message authentication code, the obvious code compares byte by byte and
returns at the first mismatch. That code takes longer the more bytes match, and an attacker who can
time it can guess a secret one byte at a time. Cryptographic libraries avoid it by OR-ing the XOR of
every byte and branching once at the end.

`hsec.cteq` is that idea as one instruction. It always takes exactly one ALU cycle, whatever its
operands, because it is one combinational operation with no branch inside. On Sixfold the result is
honest only because the rest of the pipeline is too: `xor` and `sub` are also one cycle. On a core
whose multiplier or divider finishes early for small operands, "constant time" would be a promise the
hardware has to keep for each instruction, and the documentation would have to say which ones.

HYDRA builds on the same instruction. There, `hsec.cteq` belongs to a family that can compare against
a key held in a vault, so software can check a secret it is never allowed to read.

## What Sixfold does not add, and why

HYDRA's full extension, Xhydrasec, also has instructions that unlock and use keys. Those only make
sense with privilege levels: a user program must not be able to read the vault, and an attempt has to
trap. Sixfold runs everything in machine mode, the most privileged level, so any protection would be
for show. Adding a user mode and an illegal-instruction trap is a chapter of its own.

## Try it

* Delete `OPC_CUSTOM0` from the `USES_REGISTER1/2` line in `src/Control_Unit.sv` and run `make test`.
  Which test fails, and on which cycle do the model and the RTL disagree?
* Add `hsec.ctne` (`funct3 = 111`, the opposite answer) through all five layers, then add it to
  `R` or `ZR` in `tools/gen_selfcheck.py`.
* `programs/23_sha256.s` still spends 7 `mv` instructions per round moving the eight working
  variables. Unroll eight rounds and rename registers instead. How close to 1 does CPI get?
* Move `ALU_CTEQ` to the late path (`LATE_RESULT`) and count the extra stalls `make test` reports.

Back to the [learning path](README.md).
