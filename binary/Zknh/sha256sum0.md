# `sha256sum0`: SHA-256 Sum0 (big sigma 0)

[← all instructions](../README.md) · extension **Zknh** · format **I-unary** · category *Cryptography*

```
rd = sext(ror32(rs1,2) ^ ror32(rs1,13) ^ ror32(rs1,22))
```

## Encoding

![sha256sum0 encoding](../../docs/img/instructions/sha256sum0.svg)

```
bit:  31                              0
      0001 0000 0000 ssss s001 dddd d001 0011
```

Fixed bits are `0`/`1`. Letters are filled in by the assembler:
`d` = rd, `s` = rs1, `t` = rs2, `i` = immediate, `h` = shift amount, `c` = CSR address, `z` = 5-bit CSR immediate, `f` = funct3, `m/p/u` = fence fields.

## Example

`sha256sum0 a0, a1` assembles to **`0x10059513`** = `00010000000001011001010100010011`

![example](../../docs/img/instructions/sha256sum0_example.svg)

| field | bits | template | example |
|---|---|---|---|
| `funct12` | 31:20 | `000100000000` | `000100000000` |
| `rs1` | 19:15 | `sssss` | `01011` |
| `funct3` | 14:12 | `001` | `001` |
| `rd` | 11:7 | `ddddd` | `01010` |
| `opcode` | 6:0 | `0010011` | `0010011` |

Try it yourself:

```bash
node tools/rv.mjs encode "sha256sum0 a0, a1"
node tools/rv.mjs decode 10059513
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
| `ALU_INPUT_B_IS_IMMEDIATE` | `1` | | `ALU_OPERATION` | `ALU_SHA256SUM0` |
| `ALU_IS_WORD_OPERATION` | `0` | |  |  |

## Journey through the 6-stage pipeline

| stage | what happens to `sha256sum0` |
|---|---|
| **FETCH1** | The PC is sent to the instruction memory. At the same time the **GSharePredictor** reads the 2-bit counter at `PC[5:2] XOR GLOBAL_HISTORY_REGISTER` (it does not know yet what instruction this is). |
| **FETCH2** | The 32-bit word arrives from memory. It is not a branch or JAL, so fetching simply continues at `PC + 4`. |
| **DECODE** | **ControlUnit** + **ALUdec** recognise `sha256sum0` from opcode `0010011`, funct3 `001`, funct12 `000100000000`; the **ImmediateGenerator** builds the I-type immediate. The **RegisterFile** is read for `rs1`, and the forwarding muxes replace a stale value with a newer one from EXECUTE, MEMORY or WRITEBACK. |
| **EXECUTE** | The **ALU** performs `SHA256SUM0`: `rd = sext(ror32(rs1,2) ^ ror32(rs1,13) ^ ror32(rs1,22))`. |
| **MEMORY** | No memory work. **WriteControl** picks the `WRITEBACK_ALU` value, which can be forwarded back to DECODE. |
| **WRITEBACK** | The **RegisterFile** writes `rd` at the clock edge (ignored if `rd` is `x0`). The instruction is now **retired** and the `instret` counter goes up by one. |

See the whole datapath in the [block diagram](../../docs/ARCHITECTURE.md) and step through a program in the [web simulator](../../web/index.html).
