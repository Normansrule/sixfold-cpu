// =============================================================================
// site/console.js: the FPGA computer, emulated in the browser
//
// The same boot firmware (fpga/firmware/bios.s) runs on the same cycle-exact model the regression checks
// against the RTL, with the device registers of fpga/rtl/Sixfold_System.sv answered in JavaScript:
// PUTCHAR and the UART go to the terminal on the page, LEDS lights the 16 LEDs, SWITCHES and BUTTONS read
// the switches and the five buttons, DISPLAY lights the four seven-segment digits (the board is drawn like a
// Digilent Basys 3), BOOT restarts the core. The selected program is in memory from power-on, like a
// bitstream built with `make fpga-basys3 PROG=calculator`: the centre button runs it. Uploading a program
// sends the same byte stream tools/fpga_load.py sends to a real board. The emulation runs at 1 MHz (1,000,000 cycles per second of real time), which is
// what the CLOCK register reports, so programs that wait on the clock behave as on the board, only slower.
// =============================================================================
import { PROGRAMS, FPGA_EXAMPLES } from '../web/programs.js';
import { buildDisplay } from '../web/sevenseg.js';
import { EmulatedSystem, uploadStream, CLOCK_HZ } from '../web/fpga_system.js';
const ALL_PROGRAMS = { ...FPGA_EXAMPLES, ...PROGRAMS };

const $ = id => document.getElementById(id);
function setup() {
  const term = $('fc-term');
  if (!term) return;
  let text = '';
  const render = () => { term.textContent = text; term.scrollTop = term.scrollHeight; };
  let dirty = false;
  const onChar = c => { if (c === 13) return; text += String.fromCharCode(c); if (text.length > 20000) text = text.slice(-16000); dirty = true; };
  const ledEls = [];
  const leds = $('fc-leds');
  for (let i = 15; i >= 0; i--) { const s = document.createElement('span'); s.className = 'fc-led'; s.title = `LED ${i}`; leds.appendChild(s); ledEls[i] = s; }
  const onLeds = v => ledEls.forEach((el, i) => el.classList.toggle('on', !!((v >> i) & 1)));
  const onDisplay = buildDisplay($('fc-display'));
  const system = new EmulatedSystem(onChar, onLeds, onDisplay);

  // five buttons in a cross, as on the Basys 3; the BUTTONS bits are those of the ULX3S (FIRE1 = centre)
  const pad = $('fc-buttons');
  [['U', 2, 'up'], ['L', 4, 'left'], ['C', 0, 'centre'], ['R', 5, 'right'], ['D', 3, 'down']].forEach(([name, bit, label]) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = name; b.className = `fc-btn fc-btn-${name}`;
    b.title = `${label}: BUTTONS bit ${bit}`; b.setAttribute('aria-label', `${label} button`);
    const press = on => { system.buttons = on ? system.buttons | (1 << bit) : system.buttons & ~(1 << bit); system.idlePolls = 0; b.classList.toggle('down', on); };
    b.addEventListener('pointerdown', e => { e.preventDefault(); press(true); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(e => b.addEventListener(e, () => press(false)));
    b.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); press(true); } });
    b.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') press(false); });
    pad.appendChild(b);
  });
  const switchEls = [];
  const switchRow = $('fc-switches');
  const showSwitches = () => { switchEls.forEach((el, i) => { const on = !!((system.switches >> i) & 1); el.classList.toggle('on', on); el.setAttribute('aria-pressed', String(on)); });
    $('fc-sw-value').textContent = `= 0x${system.switches.toString(16).toUpperCase().padStart(4, '0')} (A ${system.switches >> 8}, B ${system.switches & 255})`; };
  for (let i = 15; i >= 0; i--) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'fc-sw'; b.title = `switch ${i}`; b.setAttribute('aria-label', `switch ${i}`);
    b.innerHTML = `<i></i><span>${i}</span>`;
    b.addEventListener('click', () => { system.switches ^= 1 << i; showSwitches(); });
    switchRow.appendChild(b); switchEls[i] = b;
  }
  system.switches = 0x0C05; // A = 12, B = 5: try the calculator straight away
  showSwitches();

  const select = $('fc-program');
  for (const name of Object.keys(ALL_PROGRAMS)) { const o = document.createElement('option'); o.value = name; o.textContent = name; select.appendChild(o); }
  select.value = 'calculator' in ALL_PROGRAMS ? 'calculator' : '20_leds_and_buttons';
  system.powerOn(ALL_PROGRAMS[select.value]);
  $('fc-upload').addEventListener('click', () => { system.send(uploadStream(ALL_PROGRAMS[select.value])); term.focus(); });
  $('fc-reset').addEventListener('click', () => { text += '\n'; system.powerOn(ALL_PROGRAMS[select.value]); term.focus(); });
  term.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Enter') { system.send([13]); e.preventDefault(); }
    else if (e.key.length === 1) { system.send([e.key.charCodeAt(0) & 0xff]); e.preventDefault(); }
  });
  for (const [id, key] of [['fc-help', 'h'], ['fc-info', 'i'], ['fc-run', 'r'], ['fc-memtest', 'm']])
    $(id).addEventListener('click', () => { system.send([key.charCodeAt(0)]); term.focus(); });

  const status = $('fc-status');
  let visible = false, last = performance.now();
  new IntersectionObserver(entries => { visible = entries.some(e => e.isIntersecting); }, { threshold: 0.05 }).observe(term);
  const frame = now => {
    const dt = Math.min(100, now - last); last = now;
    if (visible) {
      system.run(Math.round(CLOCK_HZ * dt / 1000));
      status.textContent = system.waiting ? 'firmware waiting for input'
        : system.running ? `program running at 0x2000, cycle ${system.core.cycle.toLocaleString('en-US')}` : 'firmware running';
    }
    if (dirty) { render(); dirty = false; }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

setup();
