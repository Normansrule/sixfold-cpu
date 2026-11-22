// =============================================================================
// site/hero3d.js: the live 3D pipeline on the front page.
//
// Nothing here is scripted: every die is an instruction inside model/core.js,
// the cycle-exact twin of src/Riscv64.sv. Each clock cycle we call core.step()
// and animate what the event record says happened:
//   ev.stages      which instruction is in each of the six stages -> die positions
//   ev.fwd         operands forwarded into DECODE                  -> arcs of light
//   ev.stall       LOAD_STALL                                      -> amber pulse
//   ev.flush       FLUSH_FETCH1_FETCH2_DECODE                      -> red sweep, dies dissolve
//   ev.redirect    FETCH2 redirect                                 -> teal arc to FETCH1
//   ev.trap        ecall, ebreak, mret and interrupts              -> red sweep (a flush) and a caption
// =============================================================================
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { Core, STAGES } from '../model/core.js';
import { assemble } from '../model/asm.js';

// colours come from CSS (site/style.css) so the scene follows the light and dark themes; read them fresh each time
const col = v => new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue(v).trim() || '#888');
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const isLight = () => css('--light') === '1';
const STAGE_VAR = { FETCH1: '--F1', FETCH2: '--F2', DECODE: '--D', EXECUTE: '--E', MEMORY: '--M', WRITEBACK: '--W' };
const SPACING = 3.3;
const X = i => (i - 2.5) * SPACING;
const SX = Object.fromEntries(STAGES.map((s, i) => [s, X(i)]));
const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function textTexture(text, { size = 44, color = css('--ink') || '#E9EFF1', font = "600 44px 'IBM Plex Mono', monospace", w = 640, h = 96, bg = null } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (bg) { g.fillStyle = bg; g.beginPath(); g.roundRect(4, 4, w - 8, h - 8, 18); g.fill(); }
  g.font = font.replace(/\d+px/, size + 'px'); g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
  let s = text; while (g.measureText(s).width > w - 30 && s.length > 4) s = s.slice(0, -2) + '…';
  g.fillText(s, w / 2, h / 2 + 2);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

export function createHero({ canvas, programs, ui, reducedMotion }) {
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false }); }
  catch (e) { return null; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(col('--sub'));
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(col('--sub'), 26, 60);
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 200);
  const controls = new OrbitControls(camera, canvas);
  controls.enableZoom = false; controls.enablePan = false; controls.enableDamping = true; controls.dampingFactor = 0.06;
  controls.minPolarAngle = 0.55; controls.maxPolarAngle = 1.32; controls.minAzimuthAngle = -0.75; controls.maxAzimuthAngle = 0.75;
  controls.rotateSpeed = 0.5;

  const hemi = new THREE.HemisphereLight(0xcfe3ee, 0x0c1418, 0.9); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(6, 14, 10); scene.add(sun);

  // ---------------------------------------------------------------- floor: placement rows
  const rows = new THREE.Group();
  const rowMat = new THREE.LineBasicMaterial({ color: col('--ink2'), transparent: true, opacity: 0.07 });
  for (let z = -14; z <= 14; z += 0.9) {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-30, 0, z), new THREE.Vector3(30, 0, z)]);
    rows.add(new THREE.Line(g, rowMat));
  }
  scene.add(rows);

  // ---------------------------------------------------------------- stages
  const platforms = {};
  STAGES.forEach((s, i) => {
    const c = col(STAGE_VAR[s]);
    const g = new THREE.Group(); g.position.x = X(i);
    const base = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.16, 3.4), new THREE.MeshStandardMaterial({ color: col('--panel2'), roughness: 0.7, metalness: 0.2, emissive: c, emissiveIntensity: 0.06 }));
    base.position.y = 0.08; g.add(base);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(base.geometry), new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.9 }));
    edge.position.copy(base.position); g.add(edge);
    const label = new THREE.Mesh(new THREE.PlaneGeometry(3.1, 0.62), new THREE.MeshBasicMaterial({ map: textTexture(s, { font: "800 64px 'Archivo', sans-serif", size: 64, w: 640, h: 128, color: '#' + c.getHexString() }), transparent: true }));
    label.rotation.x = -Math.PI / 2.6; label.position.set(0, 0.35, 2.45); g.add(label);
    scene.add(g);
    platforms[s] = { base, edge, label, color: c, pulse: 0, pulseColor: new THREE.Color() };
  });
  // pipeline registers between the stages: thin slabs that flash on every clock edge
  const regs = [];
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.3, 3.4), new THREE.MeshStandardMaterial({ color: col('--rule'), emissive: col('--ink2'), emissiveIntensity: 0.05, transparent: true, opacity: 0.85 }));
    m.position.set((X(i) + X(i + 1)) / 2, 0.65, 0); scene.add(m); regs.push(m);
  }

  // dust: slow particles, like data in flight
  const dustG = new THREE.BufferGeometry(); const N = 380; const p = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { p[i * 3] = (Math.random() - 0.5) * 44; p[i * 3 + 1] = Math.random() * 9; p[i * 3 + 2] = (Math.random() - 0.5) * 24; }
  dustG.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const dust = new THREE.Points(dustG, new THREE.PointsMaterial({ color: col('--ink2'), size: 0.04, transparent: true, opacity: 0.45 }));
  scene.add(dust);

  // ---------------------------------------------------------------- theme: repaint everything that copied a CSS colour
  function dieLabelBg() { const c = col('--panel'); return `rgba(${c.r * 255 | 0},${c.g * 255 | 0},${c.b * 255 | 0},0.86)`; }
  function applyTheme() {
    const light = isLight();
    renderer.setClearColor(col('--sub')); scene.fog.color.copy(col('--sub'));
    hemi.color.set(light ? 0xffffff : 0xcfe3ee); hemi.groundColor.set(light ? 0xb8c4c9 : 0x0c1418); hemi.intensity = light ? 1.5 : 0.9;
    rowMat.color.copy(col('--ink2')); rowMat.opacity = light ? 0.12 : 0.07;
    dust.material.color.copy(col('--ink2'));
    for (const r of regs) { r.material.color.copy(col('--rule')); r.material.emissive.copy(col('--ink2')); }
    STAGES.forEach(s => {
      const pl = platforms[s]; pl.color.copy(col(STAGE_VAR[s]));
      pl.base.material.color.copy(col('--panel2')).lerp(pl.color, light ? 0.22 : 0); pl.edge.material.color.copy(pl.color);
      pl.label.material.map.dispose();
      pl.label.material.map = textTexture(s, { font: "800 64px 'Archivo', sans-serif", size: 64, w: 640, h: 128, color: '#' + pl.color.getHexString() });
    });
    for (const d of dies.values()) {       // instructions already in flight get new name tags too
      d.label.material.map.dispose();
      d.label.material.map = textTexture(core?.instrs[d.id]?.text || '', { bg: dieLabelBg(), size: 40 });
    }
  }
  addEventListener('sixfold:theme', () => { applyTheme(); });

  // ---------------------------------------------------------------- dies (instructions)
  const dies = new Map(); // id -> { group, body, mat, label, from, to, t0, fade, kind }
  const dieGeo = new THREE.BoxGeometry(2.1, 0.42, 1.5);
  function makeDie(id, text) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x2a3e49, roughness: 0.35, metalness: 0.4, emissive: 0x000000, emissiveIntensity: 0.55, transparent: true, opacity: 1 });
    const body = new THREE.Mesh(dieGeo, mat);
    const pins = new THREE.LineSegments(new THREE.EdgesGeometry(dieGeo), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: textTexture(text, { bg: dieLabelBg(), size: 40 }), transparent: true, depthWrite: false }));
    label.scale.set(2.9, 0.43, 1); label.position.y = 0.72;
    const group = new THREE.Group(); group.add(body, pins, label);
    scene.add(group);
    const d = { id, group, body, mat, pins, label, from: new THREE.Vector3(), to: new THREE.Vector3(), t0: 0, fade: null, color: new THREE.Color(0x2a3e49), target: new THREE.Color(0x2a3e49) };
    dies.set(id, d); return d;
  }
  function killDie(d, how, now) {
    d.fade = { how, t0: now };
    if (how === 'squash') { d.target.copy(col('--W')); d.mat.emissive.copy(col('--W')); }
  }

  // ---------------------------------------------------------------- arcs (forwarding, redirect, flush)
  const arcs = [];
  function arc(fromX, toX, color, height = 2.2, z = -0.4, width = 0.055) {
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(fromX, 0.55, z), new THREE.Vector3((fromX + toX) / 2, height, z), new THREE.Vector3(toX, 0.55, z));
    const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, width, 8, false), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }));
    scene.add(mesh); arcs.push({ mesh, t0: performance.now() });
  }

  // ---------------------------------------------------------------- simulation
  let img = null, core = null, playing = false, stepMs = 700, lastStep = 0, now = 0, history = [];
  const names = Object.keys(programs);
  function load(name) {
    for (const d of dies.values()) { scene.remove(d.group); } dies.clear();
    img = assemble(programs[name]); core = new Core(img, { bp: ui.bp.checked, xcompute: true }); history = [];
    ui.cycle.textContent = '0'; ui.ret.textContent = '0'; ui.cpi.textContent = '–';
    ui.event.innerHTML = `Loaded <b>${name.replace(/_/g, ' ')}</b>. Press play or step one cycle.`;
  }

  function caption(ev) {
    const t = id => core.instrs[id]?.text || '';
    if (ev.halt) return '<b>Done.</b> The instruction that writes the tohost register reached WRITEBACK: the program passed.';
    if (ev.interruptTaken) return `<b>Interrupt.</b> The ${ev.interruptTaken.external ? 'serial port' : 'timer'} raised its line. The instruction in DECODE does not go on: an interrupt takes its place, and it will run after the handler returns.`;
    if (ev.interrupt) return `<b>Trap.</b> The interrupt reaches EXECUTE: the CPU saves where to come back to (mepc) and why (mcause), turns interrupts off and jumps to the handler. Nothing is lost, nothing runs twice.`;
    if (ev.trap?.kind === 'mret') return `<b>mret.</b> The handler is done: back to the saved address, interrupts on again.`;
    if (ev.trap) return `<b>${ev.trap.kind}.</b> A trap on purpose: the CPU jumps to the handler at mtvec and remembers where it was.`;
    if (ev.flush) return ev.resolve?.kind === 'jalr'
      ? `<b>Flush.</b> <code>${t(ev.stages.EXECUTE.id)}</code> jumps to an address held in a register, which FETCH could not know. The 3 instructions behind it are thrown away.`
      : `<b>Wrong guess, flush.</b> The branch in EXECUTE went the other way. The 3 younger instructions were on the wrong path and are thrown away.`;
    if (ev.dmiss) return `<b>Data cache miss.</b> <code>${t(ev.stages.EXECUTE.id)}</code> needs a line that is not in the data cache; it waits while main memory sends 32 bytes.`;
    if (ev.imiss) return `<b>Instruction cache miss.</b> The next instructions are not in the instruction cache yet, so FETCH1 waits for main memory (and the following line is prefetched).`;
    if (ev.busy) return `<b>Multiply/divide busy.</b> <code>${t(ev.stages.EXECUTE.id)}</code> is computed a little each cycle so the clock can stay fast; everything behind it waits.`;
    if (ev.stall) return `<b>Load stall.</b> DECODE needs a value that the load in EXECUTE has not fetched from memory yet, so the front of the pipeline waits one cycle${ev.loadStallReal ? '' : ' (a false alarm: the bits only look like that register)'}.`;
    if (ev.redirect) return `<b>Redirect.</b> FETCH2 sees ${ev.predecode?.kind === 'jal' ? 'a jump' : ev.predecode?.kind === 'return' ? 'a return and takes its address from the return address stack' : 'a branch predicted taken'} and sends FETCH1 there; the instruction fetched behind it is dropped.`;
    if (ev.btb?.redirect) return `<b>Branch target buffer hit.</b> FETCH1 recognises this taken branch from last time and jumps to its target immediately: no cycle lost.`;
    if (ev.fwd?.a || ev.fwd?.b) return `<b>Forwarding.</b> <code>${t(ev.stages.DECODE.id)}</code> needs a result that is still inside the pipeline, so it is passed back from ${[ev.fwd.a, ev.fwd.b].filter(Boolean).join(' and ')} instead of waiting.`;
    if (ev.rfWrite) return `<code>${t(ev.stages.WRITEBACK.id)}</code> finishes and writes its result. Every stage is busy with a different instruction.`;
    return 'Every stage works on a different instruction at the same time.';
  }

  function step() {
    if (!core) return;
    if (core.halted) { load(ui.prog.value); return; }
    const ev = core.step(); history.push(ev);
    const tNow = performance.now();
    const present = new Set();
    for (const s of STAGES) {
      const x = ev.stages[s]; if (!x) continue;
      present.add(x.id);
      let d = dies.get(x.id);
      if (!d) { d = makeDie(x.id, core.instrs[x.id].text); d.group.position.set(SX[s], 3.4, 0); }
      if (d.fade) continue;
      d.from.copy(d.group.position); d.to.set(SX[s], 0.37, 0); d.t0 = tNow;
      d.target.copy(platforms[s].color);
    }
    for (const d of dies.values()) {
      if (present.has(d.id) || d.fade) continue;
      killDie(d, core.instrs[d.id]?.squashed ? 'squash' : 'retire', tNow);
    }
    // arcs and pulses
    const fwdColor = { EXECUTE: col('--E'), MEMORY: col('--M'), WRITEBACK: col('--W') };
    for (const k of ['a', 'b']) { const src = ev.fwd?.[k]; if (src) arc(SX[src], SX.DECODE, fwdColor[src], k === 'a' ? 2.3 : 1.7, k === 'a' ? -0.5 : 0.5); }
    if (ev.redirect) arc(SX.FETCH2, SX.FETCH1, col('--F2'), 1.6, 0.9, 0.07);
    if (ev.flush) { arc(SX.EXECUTE, SX.FETCH1, col('--W'), 3.4, 0, 0.09); for (const s of ['FETCH1', 'FETCH2', 'DECODE']) { platforms[s].pulse = 1; platforms[s].pulseColor.copy(col('--W')); } }
    if (ev.stall) for (const s of ['FETCH1', 'FETCH2', 'DECODE']) { platforms[s].pulse = 1; platforms[s].pulseColor.copy(col('--stall')); }
    if (ev.busy) { platforms.EXECUTE.pulse = 1; platforms.EXECUTE.pulseColor.copy(col('--D')); }
    if (ev.dmiss) { platforms.EXECUTE.pulse = 1; platforms.EXECUTE.pulseColor.copy(col('--M')); }
    if (ev.imiss) { platforms.FETCH1.pulse = 1; platforms.FETCH1.pulseColor.copy(col('--F1')); }
    if (ev.btb?.redirect && !ev.flush && !ev.redirect && !ev.stall && !ev.busy) arc(SX.FETCH1 + 0.9, SX.FETCH1 - 0.9, col('--F1'), 1.1, 0.9, 0.05);
    for (const r of regs) r.material.emissiveIntensity = 0.5;
    const st = core.stats;
    ui.cycle.textContent = st.cycles; ui.ret.textContent = st.retired;
    ui.cpi.textContent = st.retired ? (st.cycles / st.retired).toFixed(2) : '–';
    ui.event.innerHTML = caption(ev);
    if (ev.halt) lastStep = tNow + 1800; // linger on the finished program
  }

  // ---------------------------------------------------------------- render loop
  let visible = true, raf = 0;
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    const narrow = w / h < 1.1;
    camera.fov = narrow ? 46 : 34;
    camera.updateProjectionMatrix();
    if (narrow) {            // phones: look down the row at an angle so it recedes into depth
      controls.target.set(-0.6, 0.2, 0);
      camera.position.set(-15.5, 12.5, 15.5);
      controls.minAzimuthAngle = -1.4; controls.maxAzimuthAngle = 0.2;
    } else {
      const dist = 22.5;
      controls.target.set(0, h < 820 ? 2.6 : 3.6, 0); // aim above the row so it sits under the headline; short screens have a smaller headline (style.css)
      camera.position.set(0, dist * 0.56 + 1.2, dist);
      controls.minAzimuthAngle = -0.75; controls.maxAzimuthAngle = 0.75;
    }
    controls.update();
  }
  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (!visible) return;
    now = t;
    if (playing && t - lastStep > stepMs) { lastStep = t; step(); }
    const dur = Math.min(520, stepMs * 0.75);
    for (const d of [...dies.values()]) {
      if (d.fade) {
        const k = Math.min(1, (t - d.fade.t0) / 650);
        d.mat.opacity = 1 - k; d.pins.material.opacity = 0.35 * (1 - k); d.label.material.opacity = 1 - k;
        if (d.fade.how === 'squash') { d.group.position.y -= 0.012; d.group.scale.setScalar(1 - 0.35 * k); }
        else { d.group.position.y += 0.03; d.group.position.x += 0.01; }
        if (k >= 1) { scene.remove(d.group); d.mat.dispose(); d.label.material.map.dispose(); dies.delete(d.id); }
      } else {
        const k = ease(Math.min(1, (t - d.t0) / dur));
        d.group.position.lerpVectors(d.from, d.to, k);
      }
      d.color.lerp(d.target, 0.12); d.mat.color.copy(d.color).multiplyScalar(0.55); d.mat.emissive.copy(d.color).multiplyScalar(0.55);
    }
    for (const s of STAGES) {
      const pl = platforms[s];
      pl.pulse *= 0.93;
      pl.base.material.emissive.copy(pl.color).lerp(pl.pulseColor, Math.min(1, pl.pulse * 1.3));
      pl.base.material.emissiveIntensity = 0.06 + pl.pulse * 0.6;
    }
    for (const r of regs) r.material.emissiveIntensity = Math.max(0.05, r.material.emissiveIntensity * 0.9);
    for (let i = arcs.length - 1; i >= 0; i--) {
      const a = arcs[i], k = (t - a.t0) / Math.max(500, stepMs * 1.1);
      a.mesh.material.opacity = Math.max(0, 0.95 * (1 - k));
      if (k >= 1) { scene.remove(a.mesh); a.mesh.geometry.dispose(); a.mesh.material.dispose(); arcs.splice(i, 1); }
    }
    if (!reducedMotion) dust.rotation.y = t * 0.00002;
    controls.update();
    renderer.render(scene, camera);
  }
  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(es => { visible = es[0].isIntersecting; }, { threshold: 0.02 }).observe(canvas);

  // ---------------------------------------------------------------- controls
  for (const n of names) ui.prog.add(new Option(n.replace(/^\d+_/, '').replace(/_/g, ' '), n));
  ui.prog.value = names.includes('13_function_call_cost') ? '13_function_call_cost' : names[0];
  const setPlaying = on => { playing = on; ui.play.textContent = on ? 'Pause' : 'Play'; ui.play.setAttribute('aria-pressed', String(on)); };
  ui.play.onclick = () => setPlaying(!playing);
  ui.step.onclick = () => { setPlaying(false); step(); };
  ui.prog.onchange = () => load(ui.prog.value);
  ui.bp.onchange = () => load(ui.prog.value);
  const setSpeed = () => { stepMs = 1500 - 130 * Number(ui.speed.value); };
  ui.speed.oninput = setSpeed; setSpeed();
  applyTheme();
  load(ui.prog.value);
  resize();
  raf = requestAnimationFrame(frame);
  if (!reducedMotion) setPlaying(true);
  return { load, step, setPlaying };
}
