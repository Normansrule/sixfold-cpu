// node tools/sounds.mjs: the pipeline lab's optional sound cues (web/sounds/*.wav), synthesized with jsfxr.
//
// jsfxr (public domain, https://github.com/chr15m/jsfxr, version 1.4.0) is not part of this repository. Fetch it
// once into build/jsfxr, then run this script:
//   mkdir -p build/jsfxr/node_modules/jsfxr  (put sfxr.js and riffwave.js from the jsfxr 1.4.0 release there)
//   cd ../.. && node tools/sounds.mjs
// Every parameter is written out below (no random presets), so the files are the same on every machine.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const jsfxr = require('../build/jsfxr/node_modules/jsfxr/sfxr.js');
globalThis.RIFFWAVE = require('../build/jsfxr/node_modules/jsfxr/riffwave.js');

const SQUARE = 0, SINE = 2;
const base = { sound_vol: 0.2, sample_rate: 22050, sample_size: 8, p_env_attack: 0, p_env_punch: 0, p_freq_limit: 0, p_freq_ramp: 0,
  p_freq_dramp: 0, p_vib_strength: 0, p_vib_speed: 0, p_arp_mod: 0, p_arp_speed: 0, p_duty: 0, p_duty_ramp: 0, p_repeat_speed: 0,
  p_pha_offset: 0, p_pha_ramp: 0, p_lpf_freq: 1, p_lpf_ramp: 0, p_lpf_resonance: 0, p_hpf_freq: 0, p_hpf_ramp: 0 };
const CUES = {
  retire: { wave_type: SINE, p_base_freq: 0.55, p_env_sustain: 0.02, p_env_decay: 0.08 },                      // a soft tick
  stall:  { wave_type: SQUARE, p_base_freq: 0.22, p_env_sustain: 0.05, p_env_decay: 0.1, p_duty: 0.5, p_lpf_freq: 0.4 }, // a low thud
  flush:  { wave_type: SQUARE, p_base_freq: 0.45, p_freq_ramp: -0.35, p_env_sustain: 0.06, p_env_decay: 0.18, p_duty: 0.3, p_lpf_freq: 0.6 }, // a falling sweep
  trap:   { wave_type: SINE, p_base_freq: 0.35, p_arp_mod: 0.4, p_arp_speed: 0.55, p_env_sustain: 0.08, p_env_decay: 0.2 },  // two notes up
};

mkdirSync('web/sounds', { recursive: true });
for (const [name, cue] of Object.entries(CUES)) {
  const params = new jsfxr.Params();
  Object.assign(params, base, cue);
  const uri = new jsfxr.SoundEffect(params).generate().dataURI;
  const bytes = Buffer.from(uri.split(',')[1], 'base64');
  writeFileSync(`web/sounds/${name}.wav`, bytes);
  console.log(`web/sounds/${name}.wav  ${bytes.length} bytes`);
}
