# `hsec.cteq`: Constant-time Equal

[← all instructions](../README.md) · extension **Xhydrasec** · format **R** · category *Cryptography*

```
rd = (rs1 == rs2) ? 1 : 0, in one cycle whatever the operands (no early exit)
```

## Encoding

![hsec.cteq encoding](../../docs/img/instructions/hsec.cteq.svg)

```
bit:  31                              0
      0000 000t tttt ssss s110 dddd d000 1011
```

Fixed bits are `0`/`1`. Letters are filled in by the assembler:
`d` = rd, `s` = rs1, `t` = rs2, `i` = immediate, `h` = shift amount, `c` = CSR address, `z` = 5-bit CSR immediate, `f` = funct3, `m/p/u` = fence fields.

## Example

`hsec.cteq a0, a1, a2` assembles to **`0x00c5e50b`** = `00000000110001011110010100001011`

![example](../../docs/img/instructions/hsec.cteq_example.svg)

| field | bits | template | example |
|---|---|---|---|
| `funct7` | 31:25 | `0000000` | `0000000` |
| `rs2` | 24:20 | `ttttt` | `01100` |
| `rs1` | 19:15 | `sssss` | `01011` |
| `funct3` | 14:12 | `110` | `110` |
| `rd` | 11:7 | `ddddd` | `01010` |
| `opcode` | 6:0 | `0001011` | `0001011` |

Try it yourself:

```bash
node tools/rv.mjs encode "hsec.cteq a0, a1, a2"
node tools/rv.mjs decode 00c5e50b
```

## Control signals from the Control Unit ([`src/Control_Unit.sv`](../../src/Control_Unit.sv))

These are the exact values the RTL produces for the example word above (computed by the
bit-exact twin in `model/core.js`, which `make test` checks against the RTL every cycle).

| signal | value | | signal | value |
|---|---|---|---|---|
| `REGISTER_WRITE_ENABLE` | `1` | | `IS_A_MULTIPLY_DIVIDE_INSTRUCTION` | `0` |
| `MEMORY_READ_ENABLE` | `0` | | `IS_A_BRANCH_INSTRUCTION` | `0` |
| `MEMORY_WRITE_ENABLE` | `0` | | `IS_A_JAL_INSTRUCTION` | `0` |
| `CSR_WRITE_ENABLE` | `0` | | `IS_A_JALR_INSTRUCTION` | `0` |
| `CSR_WRITE_USING_IMMEDIATE` | `0` | | `IMMEDIATE_TYPE_SELECT` | `IMMEDIATE_I` |
| `ALU_INPUT_A_IS_PC` | `0` | | `WRITEBACK_SELECT` | `WRITEBACK_ALU` |
| `ALU_INPUT_B_IS_IMMEDIATE` | `0` | | `ALU_OPERATION` | `ALU_CTEQ` |
| `ALU_IS_WORD_OPERATION` | `0` | |  |  |

## Journey through the 6-stage pipeline

| stage | what happens to `hsec.cteq` |
|---|---|
| **FETCH1** | The PC is sent to the instruction memory. At the same time the **GSharePredictor** reads the 2-bit counter at `PC[5:2] XOR GLOBAL_HISTORY_REGISTER` (it does not know yet what instruction this is). |
| **FETCH2** | The 32-bit word arrives from memory. It is not a branch or JAL, so fetching simply continues at `PC + 4`. |
| **DECODE** | **ControlUnit** + **ALUdec** recognise `hsec.cteq` from opcode `0001011`, funct3 `110`, funct7 `0000000`; the **ImmediateGenerator** builds the I-type immediate. The **RegisterFile** is read for `rs1` and `rs2`, and the forwarding muxes replace a stale value with a newer one from EXECUTE, MEMORY or WRITEBACK. |
| **EXECUTE** | The **ALU** performs `CTEQ`: `rd = (rs1 == rs2) ? 1 : 0, in one cycle whatever the operands (no early exit)`. |
| **MEMORY** | No memory work. **WriteControl** picks the `WRITEBACK_ALU` value, which can be forwarded back to DECODE. |
| **WRITEBACK** | The **RegisterFile** writes `rd` at the clock edge (ignored if `rd` is `x0`). The instruction is now **retired** and the `instret` counter goes up by one. |

See the whole datapath in the [block diagram](../../docs/ARCHITECTURE.md) and step through a program in the [web simulator](../../web/index.html).
