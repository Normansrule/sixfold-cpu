/* tests/riscv-tests/env/link.ld: code at the reset vector 0x2000, data right after it; everything must stay
   below 64 KiB (0x10000), the size of the simulated memory */
OUTPUT_ARCH("riscv")
ENTRY(_start)
SECTIONS
{
  . = 0x2000;
  .text.init : { *(.text.init) }
  .text : { *(.text) }
  . = ALIGN(0x100);
  .data : { *(.data) }
  .bss : { *(.bss) }
  _end = .;
  ASSERT(_end <= 0x10000, "test does not fit in Sixfold's 64 KiB memory")
}
