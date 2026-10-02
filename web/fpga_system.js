// =============================================================================
// web/fpga_system.js: the Sixfold FPGA computer (fpga/rtl/Sixfold_System.sv), emulated in JavaScript
//
// The boot firmware (fpga/firmware/bios.s) runs on the cycle-exact model (model/core.js); the device
// registers at 0x1000_0000 are answered here the way the RTL answers them: PUTCHAR and the UART, 16 LEDS,
// BUTTONS, SWITCHES, the DISPLAY digits, BOOT and BOOT_ADDRESS, CLOCK, TIMER, LAST_TOHOST, LAST_CYCLES and
// BOOT_REASON. BOOT and a finished program restart the core with fresh caches, as on the board.
// Used by the site's FPGA console (site/console.js) and the command-line virtual board
// (tools/fpga_emulator.mjs, tools/virtual_board.py). No browser APIs here.
// =============================================================================
import { assemble } from '../model/asm.js';
import { Core, CONFIGS, MMIO_BASE } from '../model/core.js';
import { FIRMWARE } from './programs.js';

export const CLOCK_HZ = 1_000_000; // what the CLOCK register reports
export const FIRMWARE_ENTRY = 0x0000;

export class EmulatedSystem {
  constructor(onChar, onLeds = () => {}, onDisplay = () => {}) {
    this.onChar = onChar; this.onLeds = onLeds; this.onDisplay = onDisplay;
    this.firmware = assemble(FIRMWARE);
    this.rx = []; this.leds = 0; this.buttons = 0; this.switches = 0; this.display = 0; this.timer = 0;
    this.lastTohost = 0n; this.lastCycles = 0; this.bootReason = 0; this.bootAddress = 0x2000;
    this.pendingBoot = false; this.idlePolls = 0;
    const self = this;
    this.devices = {
      load(address) {
        const offset = Number(address - MMIO_BASE);
        if (offset !== 0x18 && offset !== 0x10) self.idlePolls = 0; // the firmware polls the UART and the centre button
        switch (offset) {
          case 0x08: return self.leds;
          case 0x68: return self.switches;
          case 0x70: return self.display;
          case 0x10: return self.buttons;
          case 0x18: { // bit 0 byte waiting, bit 1 queue full (never here), bit 2 idle, 15:8 the byte
            if (!self.rx.length) self.idlePolls++;
            return (self.rx.length ? 1 : 0) | 4 | ((self.rx[0] || 0) << 8);
          }
          case 0x28: return CLOCK_HZ;
          case 0x30: return self.lastTohost;
          case 0x38: return self.lastCycles;
          case 0x40: return self.bootReason;
          case 0x48: return self.timer;
          case 0x50: return self.bootAddress;
          default: return 0;
        }
      },
      store(address, data, mask) {
        const offset = Number(address - MMIO_BASE);
        self.idlePolls = 0;
        if (offset === 0x00 && mask) self.onChar(Number(data & 0xffn));
        else if (offset === 0x08 && (mask & 3)) { self.leds = merge(self.leds, data, mask, 2); self.onLeds(self.leds); }
        else if (offset === 0x70 && (mask & 15)) { self.display = merge(self.display, data, mask, 4); self.onDisplay(self.display); }
        else if (offset === 0x18) self.rx.shift();
        else if (offset === 0x20) self.pendingBoot = true;
        else if (offset === 0x50) self.bootAddress = Number(data & 0xffffffffn);
      },
      externalInterrupt() { return self.rx.length > 0; }, // the UART receive interrupt line (MTIME/MTIMECMP live in the model)
    };
  }
  boot(vector, reason) {
    if (this.core) this.memory = this.core.mem.slice();
    this.bootReason = reason;
    this.running = vector !== FIRMWARE_ENTRY;
    this.core = new Core(this.memory, { ...CONFIGS.performance, devices: this.devices, resetPc: vector });
    this.core.mtime = BigInt(this.timer); // MTIME counts from power-on, through every program (Sixfold_System.sv)
    this.pendingBoot = false; this.idlePolls = 0;
  }
  powerOn(program) { // the block RAM image: firmware at 0, the chosen program at 0x2000
    this.memory = new Uint8Array(65536);
    this.memory.set(this.firmware.bytes.slice(0, 0x1000), 0);
    if (program) { const img = assemble(program); this.memory.set(img.bytes.slice(img.used[0], img.used[1]), img.used[0]); }
    this.core = null;
    this.leds = 0; this.onLeds(0); this.display = 0; this.onDisplay(0); this.rx = []; this.boot(FIRMWARE_ENTRY, 0);
  }
  // Wait for input instead of burning cycles: the firmware has polled an empty receive queue many times
  get waiting() { return this.idlePolls > 200 && !this.rx.length && !this.running; }
  run(cycles) {
    for (let i = 0; i < cycles; i++) {
      this.core.step(); this.timer++;
      if (this.pendingBoot) this.boot(this.bootAddress, 2);
      else if (this.core.halted) {
        this.lastTohost = this.core.csr.tohost; this.lastCycles = this.core.stats.cycles;
        this.boot(FIRMWARE_ENTRY, 1);
      }
      if (this.waiting) return;
    }
  }
  send(bytes) { this.rx.push(...bytes); this.idlePolls = 0; }
}

// a store changes only the bytes it writes (sb to LEDS sets 8 LEDs)
const merge = (old, data, mask, bytes) => { let v = old; for (let k = 0; k < bytes; k++) if (mask & (1 << k)) v = (v & ~(0xff << (8 * k))) | (Number((data >> BigInt(8 * k)) & 0xffn) << (8 * k)); return v >>> 0; };

export function uploadStream(source) {
  const img = assemble(source);
  const [lo, hi] = img.used;
  const bytes = [...img.bytes.slice(lo, hi)];
  const word = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  const checksum = bytes.reduce((a, b) => (a + b) >>> 0, 0);
  return ['l'.charCodeAt(0), ...word(lo), ...word(hi - lo), ...bytes, ...word(checksum), 'r'.charCodeAt(0)];
}

