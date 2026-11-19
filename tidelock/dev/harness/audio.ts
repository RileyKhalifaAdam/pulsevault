// Audio harness: the W1-D engine driven by synthetic world state, for tests/audio.e2e.cjs and by-ear checks.
// No world, no three.js: a ring of events, 14 jets around the Wren's hull, 2 engines, and the page's own frame loop.
// Everything audible has a cause set through window.__audio (duty, engine level, cabin pressure, an impact event).
//
//   window.__audio.state()            'none' until the first finger lifts, then the AudioContext state
//   window.__audio.probeSuspended()   state of a throwaway AudioContext made now (shows the autoplay policy)
//   window.__audio.set({...})         jet duty / engine level / cabin pressure / posture / warp
//   window.__audio.impact(J)          emit a contact event (the mug on the deck)
//   window.__audio.level()            RMS and peak of the output since the last call (AnalyserNode)
//   window.__audio.bench()            main-thread µs per update: 14 jets + 2 engines, with and without 20 impacts
//   window.__audio.audioThread(s)     audio-render cost of the worst-case graph (measurement only)
//   window.__audio.voiceCost(...)     audio-render cost of the 16-voice pool alone at a hit rate (measurement only)
//   window.__audio.worstPeak()        output peak of the worst coincidence, rendered offline (must stay < 1.0)
//   window.__audio.limiterGain()      output/input of the mix chain below threshold (must be 1: 94 dB = 1.0)
//   window.__audio.hide() / show()    emulated page visibility (?vis=emulate)

import { attachAudio, audioShipFromData, bakeAll, createAudioEngine, createAudioFrame, createBaker, type SoundBank } from '../../src/audio';
import { Slots, VoicePool, createMixer } from '../../src/audio/mixer';
import { BODY_SHIP, MAT, createEventRing, drain, emitEvent, type SimEvent } from '../../src/world/events';
import type { AudioShip } from '../../src/audio';

const params = new URLSearchParams(location.search);
const fansOn = params.get('fans') !== '0';

/**
 * ?policy=webkit: emulate WebKit's rule in a browser that does not enforce it (headless Chromium starts every
 * AudioContext 'running'). A context made outside a user activation starts suspended, and resume() outside a
 * trusted activation-triggering event (touchend, pointerup from a touch or pen, click, keydown — HTML
 * "activation triggering input event"; touchstart and a touch's pointerdown are not) is NOT allowed to start: as
 * the Web Audio spec says, its promise is appended to [[pending resume promises]] and stays pending (no rejection,
 * no statechange) until a later allowed resume() starts the context. Stricter than WebKit's transient window, so
 * passing here means the engine resumes inside the gesture and re-arms whenever a resume may hang.
 * (navigator.userActivation cannot be used: Playwright's evaluate() carries a user gesture.)
 */
const webkitPolicy = params.get('policy') === 'webkit';
let inActivation = false;
const ACTIVATING = ['touchend', 'pointerup', 'click', 'keydown'];
for (const type of ACTIVATING) {
  window.addEventListener(type, (e) => {
    if (!e.isTrusted) return;
    if (type === 'pointerup' && (e as PointerEvent).pointerType === 'mouse') return;
    inActivation = true;
    setTimeout(() => { inActivation = false; }, 0); // only for the rest of this event's dispatch (this task)
  }, true);
}
/** Resume promises left pending by the emulated rule (settled when an allowed resume starts the context). */
let pendingResumes: (() => void)[] = [];
let resumeCalls = 0;
function makeContext(): AudioContext {
  const c = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
  if (!webkitPolicy) return c;
  if (!inActivation) void c.suspend();
  const resume = c.resume.bind(c);
  c.resume = () => {
    resumeCalls++;
    if (!inActivation) return new Promise<void>((res) => { pendingResumes.push(res); });
    const p = resume();
    void p.then(() => { const q = pendingResumes; pendingResumes = []; for (const r of q) r(); });
    return p;
  };
  return c;
}

/** ?vis=emulate: document.hidden is driven by __audio.hide()/show() (the sandboxed iframe cannot be hidden). */
let emulatedHidden = false;
if (params.get('vis') === 'emulate') {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => emulatedHidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (emulatedHidden ? 'hidden' : 'visible') });
}

const ship: AudioShip = audioShipFromData('wren');
ship.jets = [];
for (let j = 0; j < 14; j++) {
  const side = j % 2 === 0 ? 1 : -1, fwd = j < 7 ? -12 : 12;
  ship.jets.push({ pos: { x: side * (3 + (j % 3)), y: (j % 4) - 1.5, z: fwd + (j % 5) }, thrust: 34e3 });
}
ship.engines = [{ pos: { x: 4.8, y: -0.2, z: 15.6 }, maxThrust: 400e3 }, { pos: { x: -4.8, y: -0.2, z: 15.6 }, maxThrust: 400e3 }];

const audio = attachAudio(ship, { fansOn, now: () => performance.now(), createContext: makeContext });
const frame = createAudioFrame(14, 2);
const ring = createEventRing();
const drainFn = (cb: (e: SimEvent, seq: number) => void): void => { drain(ring, cb); };
let simT = 0;
let last = performance.now();
const td = new Float32Array(2048);
let peak = 0, sumSq = 0, nSq = 0;

function tick(): void {
  const now = performance.now();
  frame.dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  simT += frame.dt * frame.warp;
  frame.simTime = simT;
  audio.update(frame, drainFn);
  const eng = audio.engine;
  if (eng && audio.ctx?.state === 'running') {
    const an = eng.analyser();
    an.getFloatTimeDomainData(td);
    for (let i = 0; i < td.length; i++) {
      const v = td[i];
      sumSq += v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    nSq += td.length;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

const label = document.createElement('div');
label.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;color:#9ab;font:16px system-ui;background:#05070a;';
label.textContent = 'tap to start sound';
document.body.appendChild(label);
setInterval(() => { label.textContent = `audio: ${audio.state()}${audio.baked ? '' : ' (baking…)'}`; }, 250);

const at = { x: -0.5, y: -1, z: -13 };

/** Worst-case graph rendered offline to time the audio thread (dev measurement only; the engine never uses it). */
interface Parts { impactsPerKick?: number; events?: boolean; jets?: boolean; engines?: boolean; aero?: boolean; fan?: boolean; docked?: boolean }
let measureBank: SoundBank | null = null;
const mBank = (): SoundBank => (measureBank ??= bakeAll());
async function audioThread(seconds: number, parts: Parts = {}): Promise<{ seconds: number; wallMs: number; cpuPct: number }> {
  const on = (k: keyof Parts): boolean => parts[k] !== false;
  const bank = mBank();
  const rate = 48000;
  const off = new OfflineAudioContext(2, Math.round(seconds * rate), rate);
  const eng = createAudioEngine(off, ship, bank, { fansOn: on('fan') });
  const f = createAudioFrame(14, 2);
  if (on('jets')) for (let j = 0; j < 14; j++) f.jetDuty[j] = 0.6;
  if (on('engines')) f.engineLevel[0] = f.engineLevel[1] = 0.8;
  if (on('aero')) { f.dynamicPressure = 10e3; f.airDensity = 3.6e-4; f.airVelocity.x = 7500; }
  f.docked = on('docked');
  f.crew.gripped = true;
  f.dt = 0.1;
  const r = createEventRing();
  const dr = (cb: (e: SimEvent, seq: number) => void): void => { drain(r, cb); };
  let k = 0;
  const kick = (): void => {
    f.simTime = k * 0.1;
    if (on('events')) for (let i = 0; i < (parts.impactsPerKick ?? 4); i++) emitEvent(r, 'contact', f.simTime, i, BODY_SHIP, 0.3 + 0.1 * i, at, null, 1, MAT.steel, MAT.aluminium);
    if (on('events')) {
      emitEvent(r, 'slide', f.simTime, 5, BODY_SHIP, 4, at, null, 0.3, MAT.ceramic, MAT.aluminium);
      emitEvent(r, 'jetOn', f.simTime, k % 14, 0, 34e3, null, null, 0, 0, 0);
    }
    eng.update(f, dr);
    k++;
  };
  for (let t = 0.1; t < seconds - 0.05; t += 0.1) {
    off.suspend(t).then(() => { kick(); off.resume(); });
  }
  kick();
  const t0 = performance.now();
  await off.startRendering();
  const wallMs = performance.now() - t0;
  return { seconds, wallMs, cpuPct: (100 * wallMs) / (seconds * 1000) };
}

/** The voice pool alone: `perS` hits per second of the mug@deck buffer in a silent cabin (floor 14 dB), 16 voices. */
async function voiceCost(perS = 40, lp = 8000, seconds = 10): Promise<number> {
  const bank = mBank();
  const R = 48000;
  const off = new OfflineAudioContext(2, R * seconds, R);
  const slots = new Slots();
  const m = createMixer(off, slots);
  m.struct.connect(m.air); m.air.gain.value = 1; m.air.connect(m.master);
  const pool = new VoicePool(off, [m.struct, m.air], slots.f);
  const pair = bank.pairs[0];
  const buf = off.createBuffer(1, pair.data.length, R);
  buf.copyToChannel(pair.data as Float32Array<ArrayBuffer>, 0);
  let last = 0;
  for (let i = pair.data.length - 1; i >= 0; i--) if (Math.abs(pair.data[i]) > 1e-3) { last = i; break; }
  const decay = Math.log(1000) / (last / R);
  const floor = Math.pow(10, (14 - 94) / 20);
  const kick = (): void => {
    const now = off.currentTime; slots.f[0] = now; slots.f[1] = 0.1;
    for (let i = 0; i < perS / 10; i++) pool.play(buf, now + 0.001 * i, 0.05, 0.05, 0, lp, 0, decay, now, floor);
    pool.reap();
  };
  for (let t = 0.1; t < seconds - 0.05; t += 0.1) off.suspend(t).then(() => { kick(); void off.resume(); });
  kick();
  const t0 = performance.now();
  await off.startRendering();
  return (100 * (performance.now() - t0)) / (seconds * 1000);
}

/** Worst coincidence (14 jets all jetOn every 0.1 s, 4 contacts of 20 N·s, both engines lighting each second, aero at
 *  q = 30 kPa, gripped): the output peak and the samples at or above full scale. */
async function worstPeak(seconds = 4): Promise<{ peak: number; samplesAtFullScale: number }> {
  const R = 48000;
  const off = new OfflineAudioContext(2, R * seconds, R);
  const eng = createAudioEngine(off, ship, mBank());
  const f = createAudioFrame(14, 2);
  for (let j = 0; j < 14; j++) f.jetDuty[j] = 1;
  f.dynamicPressure = 30e3; f.airDensity = 2e-3; f.airVelocity.x = 5000; f.crew.gripped = true; f.dt = 0.1;
  const r = createEventRing();
  const dr = (cb: (e: SimEvent, seq: number) => void): void => { drain(r, cb); };
  let k = 0;
  const kick = (): void => {
    f.simTime = k * 0.1;
    f.engineLevel[0] = f.engineLevel[1] = k % 10 < 5 ? 1 : 0;
    for (let i = 0; i < 14; i++) emitEvent(r, 'jetOn', f.simTime, i, 0, 34e3, null, null, 0, 0, 0);
    for (let i = 0; i < 4; i++) emitEvent(r, 'contact', f.simTime, 6, BODY_SHIP, 20, { x: -0.5, y: 0, z: -13.4 }, null, 3, MAT.steel, MAT.aluminium);
    eng.update(f, dr);
    k++;
  };
  for (let t = 0.1; t < seconds - 0.05; t += 0.1) off.suspend(t).then(() => { kick(); void off.resume(); });
  kick();
  const buf = await off.startRendering();
  let peak = 0, n = 0;
  for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; if (a >= 1) n++; } }
  return { peak, samplesAtFullScale: n };
}

/** Output rms / input rms of a 1 kHz sine through master → limiter → trim → guard, at levels below the threshold. */
async function limiterGain(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const amp of [0.01, 0.1, 0.4]) {
    const off = new OfflineAudioContext(1, 48000, 48000);
    const m = createMixer(off, new Slots());
    const o = off.createOscillator(); o.frequency.value = 1000;
    const g = off.createGain(); g.gain.value = amp;
    o.connect(g); g.connect(m.master); o.start();
    const b = await off.startRendering();
    const d = b.getChannelData(0); let s = 0; for (let i = 24000; i < 48000; i++) s += d[i] * d[i];
    out[`in ${amp}`] = Math.sqrt(s / 24000) / (amp / Math.SQRT2);
  }
  return out;
}

/** A fresh bake in `budgetMs` slices (as attachAudio runs it): slice durations and total work, ms. */
function bakeSlices(budgetMs = 2): { slices: number; totalMs: number; median: number; p95: number; max: number; over4: number } {
  const b = createBaker(48000);
  const t: number[] = [];
  let done = false;
  while (!done) { const t0 = performance.now(); done = b.step(budgetMs, () => performance.now()); t.push(performance.now() - t0); }
  b.release();
  const s = [...t].sort((x, y) => x - y);
  return { slices: t.length, totalMs: t.reduce((a, c) => a + c, 0), median: s[s.length >> 1], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1], over4: t.filter((x) => x > 4).length };
}

(window as unknown as { __audio: unknown }).__audio = {
  bakeSlices,
  voiceCost,
  worstPeak,
  limiterGain,
  rate: () => audio.ctx?.sampleRate ?? 0,
  rebakes: () => audio.rebakes,
  resumeCalls: () => resumeCalls,
  pendingResumes: () => pendingResumes.length,
  hide(): void { emulatedHidden = true; document.dispatchEvent(new Event('visibilitychange')); },
  show(): void { emulatedHidden = false; document.dispatchEvent(new Event('visibilitychange')); },
  state: () => audio.state(),
  baked: () => audio.baked,
  bake: () => ({ ms: audio.bakeMs, bytes: audio.bufferBytes }),
  /** States of contexts made now, outside any gesture: the browser's own, and under the emulated WebKit rule. */
  async probeSuspended(): Promise<{ browser: string; webkitRule: string }> {
    const a = new AudioContext();
    const pol = makeContext();
    await new Promise((r) => setTimeout(r, 50));
    const out = { browser: a.state as string, webkitRule: webkitPolicy ? (pol.state as string) : 'n/a' };
    void a.close();
    void pol.close();
    return out;
  },
  set(o: { duty?: number[]; engine?: number[]; cabin?: number; posture?: 'seated' | 'floating'; gripped?: boolean; warp?: number }): void {
    if (o.duty) for (let j = 0; j < 14; j++) frame.jetDuty[j] = o.duty[j] ?? 0;
    if (o.engine) for (let e = 0; e < 2; e++) frame.engineLevel[e] = o.engine[e] ?? 0;
    if (o.cabin !== undefined) frame.cabinPressure = o.cabin;
    if (o.posture) frame.crew.posture = o.posture;
    if (o.gripped !== undefined) frame.crew.gripped = o.gripped;
    if (o.warp !== undefined) frame.warp = o.warp;
  },
  impact(J: number): void {
    emitEvent(ring, 'contact', simT, 0, BODY_SHIP, J, at, null, 1, MAT.ceramic, MAT.aluminium);
  },
  level(): { rms: number; peak: number; n: number } {
    const out = { rms: nSq ? Math.sqrt(sumSq / nSq) : 0, peak, n: nSq };
    peak = 0; sumSq = 0; nSq = 0;
    return out;
  },
  stats: () => ({ ...audio.engine?.stats }),
  bench(): Record<string, number> {
    const eng = audio.engine!;
    const f = createAudioFrame(14, 2);
    f.crew.gripped = true;
    f.dynamicPressure = 5e3; f.airDensity = 2e-4; f.airVelocity.x = 7000;
    const r = createEventRing();
    const dr = (cb: (e: SimEvent, seq: number) => void): void => { drain(r, cb); };
    let k = 0;
    const pwm = (): void => {
      for (let j = 0; j < 14; j++) f.jetDuty[j] = ((k + j) % 7) / 7;
      f.engineLevel[0] = 0.5 + 0.05 * (k % 10); f.engineLevel[1] = 0.7;
      f.crew.yaw = 0.3 * Math.sin(k * 0.01);
      f.simTime = k / 60;
      k++;
      eng.update(f, dr);
    };
    for (let i = 0; i < 3000; i++) pwm();
    let t0 = performance.now();
    for (let i = 0; i < 20000; i++) pwm();
    const contUs = ((performance.now() - t0) / 20000) * 1000;
    const burst = (): void => {
      for (let i = 0; i < 20; i++) emitEvent(r, 'contact', f.simTime, i % 25, BODY_SHIP, 0.2 + 0.05 * i, at, null, 1.5, MAT.steel, i & 1 ? MAT.aluminium : MAT.composite);
      pwm();
    };
    for (let i = 0; i < 100; i++) burst();
    t0 = performance.now();
    for (let i = 0; i < 500; i++) burst();
    const burstUs = ((performance.now() - t0) / 500) * 1000;
    // leave the live engine quiet again
    for (let j = 0; j < 14; j++) f.jetDuty[j] = 0;
    f.engineLevel[0] = f.engineLevel[1] = 0; f.dynamicPressure = 0;
    eng.update(f, dr);
    return { contUs, burstUs };
  },
  audioThread,
};
(window as unknown as { __ready: boolean }).__ready = true;
