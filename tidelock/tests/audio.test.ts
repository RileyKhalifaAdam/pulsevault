import { beforeAll, describe, expect, it } from 'vitest';
import { hash } from '../src/core/rng';
import { bakeAll, biquadInPlace, createBaker, freeSlot, pairSlot, type SoundBank } from '../src/audio/bake';
import { AUDIBLE, createAudioEngine, G_VALVE, K_IMPACT, MECH, strikeVariant, type AudioEngine } from '../src/audio/engine';
import { audioShipFromData, createAudioFrame, fillAudioFrame, primarySoundSpeed } from '../src/audio/index';
import { createUnlocker } from '../src/audio/context';
import { ACOUSTIC_TYPES, MATERIALS, PROP_ACOUSTICS, SURFACES, contactModulus, frictionOf, hertzContactTime, plateModeHz, ringModeHz, barModeHz } from '../src/audio/materials';
import { BAKE_RATE, MODAL_MAX_S, VARIANTS, bakePair, constructionModes, freeModes, modalLength, ownModes, pairModes } from '../src/audio/modal';
import { GUARD_CEIL, GUARD_SPAN, STEAL_S, guardCurve, limiterMakeupDb } from '../src/audio/mixer';
import { G_HISS, JET_REF_N, aeroRoar, airAtt, airPathGain, structAtt, type AeroOut } from '../src/audio/sources';
import { PROP_TYPES } from '../src/data/props';
import type { AudioFrame, AudioShip } from '../src/audio/types';
import { BODY_CREW, BODY_SHIP, MAT, createEventRing, drain, emitEvent, type EventRing } from '../src/world/events';

// ------------------------------------------------------------------ a mock AudioContext that records parameters

let RECORD = true;
class MockParam {
  value: number;
  log: [string, number, number][] = [];
  constructor(v = 0) { this.value = v; }
  setTargetAtTime(v: number, t: number, tau: number): this { this.value = v; if (RECORD) this.log.push(['target', v, t]); void tau; return this; }
  setValueAtTime(v: number, t: number): this { this.value = v; if (RECORD) this.log.push(['set', v, t]); return this; }
  cancelScheduledValues(t: number): this { if (RECORD) this.log.push(['cancel', 0, t]); return this; }
}
class MockNode {
  outs: MockNode[] = [];
  constructor(readonly ctx: MockCtx, readonly kind: string) {}
  connect<T>(n: T): T { this.outs.push(n as unknown as MockNode); return n; }
  disconnect(n?: MockNode): void {
    if (n === undefined) this.outs.length = 0;
    else { const i = this.outs.indexOf(n); if (i >= 0) this.outs.splice(i, 1); }
  }
}
class MockGain extends MockNode { gain = new MockParam(1); constructor(c: MockCtx) { super(c, 'gain'); } }
class MockShaper extends MockNode { curve: Float32Array | null = null; oversample = 'none'; constructor(c: MockCtx) { super(c, 'shaper'); } }
class MockBiquad extends MockNode { type = 'lowpass'; frequency = new MockParam(350); Q = new MockParam(1); constructor(c: MockCtx) { super(c, 'biquad'); } }
class MockPanner extends MockNode { pan = new MockParam(0); constructor(c: MockCtx) { super(c, 'pan'); } }
class MockComp extends MockNode {
  threshold = new MockParam(); knee = new MockParam(); ratio = new MockParam(); attack = new MockParam(); release = new MockParam();
  constructor(c: MockCtx) { super(c, 'comp'); }
}
class MockBuffer {
  data: Float32Array;
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) { this.data = new Float32Array(length); }
  get duration(): number { return this.length / this.sampleRate; }
  copyToChannel(src: Float32Array): void { this.data.set(src); }
  getChannelData(): Float32Array { return this.data; }
}
class MockSource extends MockNode {
  buffer: MockBuffer | null = null;
  loop = false;
  playbackRate = new MockParam(1);
  started = -1;
  stopped = false;
  stopAt = Infinity;
  constructor(c: MockCtx) { super(c, 'source'); if (RECORD) c.sources.push(this); }
  start(when = 0): void { this.started = when; }
  stop(when = 0): void { this.stopped = true; this.stopAt = when; }
}
class MockCtx {
  currentTime = 0;
  sampleRate = 48000;
  state = 'running';
  sources: MockSource[] = [];
  destination = new MockNode(this, 'destination');
  createGain(): MockGain { return new MockGain(this); }
  createBiquadFilter(): MockBiquad { return new MockBiquad(this); }
  createStereoPanner(): MockPanner { return new MockPanner(this); }
  createDynamicsCompressor(): MockComp { return new MockComp(this); }
  createWaveShaper(): MockShaper { return new MockShaper(this); }
  createBufferSource(): MockSource { return new MockSource(this); }
  createBuffer(ch: number, len: number, rate: number): MockBuffer { return new MockBuffer(ch, len, rate); }
  createAnalyser(): MockNode { return new MockNode(this, 'analyser'); }
}

// ------------------------------------------------------------------ fixtures

let bank: SoundBank;
let bakeMs = 0;
beforeAll(() => {
  const t0 = performance.now();
  bank = bakeAll(BAKE_RATE, () => performance.now());
  bakeMs = performance.now() - t0;
});

/** 14 jets around a 32 m hull (34 kN), 2 engines aft, the Wren's rooms and props. */
function ship14(): AudioShip {
  const s = audioShipFromData('wren');
  s.jets = [];
  for (let j = 0; j < 14; j++) {
    const side = j % 2 === 0 ? 1 : -1, fwd = j < 7 ? -12 : 12;
    s.jets.push({ pos: { x: side * (3 + (j % 3)), y: (j % 4) - 1.5, z: fwd + (j % 5) }, thrust: 34e3 });
  }
  s.engines = [{ pos: { x: 4.8, y: -0.2, z: 15.6 }, maxThrust: 400e3 }, { pos: { x: -4.8, y: -0.2, z: 15.6 }, maxThrust: 400e3 }];
  return s;
}

function rig(opts: { fansOn?: boolean } = {}): { ctx: MockCtx; eng: AudioEngine; frame: AudioFrame; ring: EventRing; step: (n?: number) => void; ship: AudioShip } {
  const ctx = new MockCtx();
  const ship = ship14();
  const eng = createAudioEngine(ctx as unknown as BaseAudioContext, ship, bank, opts);
  const frame = createAudioFrame(14, 2);
  const ring = createEventRing();
  const drainFn = (cb: Parameters<typeof drain>[1]): void => { drain(ring, cb); };
  const step = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      ctx.currentTime += frame.dt;
      frame.simTime += frame.dt * frame.warp;
      eng.update(frame, drainFn);
    }
  };
  return { ctx, eng, frame, ring, step, ship };
}

const lastSet = (p: { log: [string, number, number][] }): number => {
  for (let i = p.log.length - 1; i >= 0; i--) if (p.log[i][0] === 'set') return p.log[i][1];
  return Number.NaN;
};

function continuousGains(eng: AudioEngine): number[] {
  const d = eng.debug;
  return [...d.rcs, ...d.engines, d.aero, d.fan, d.slide, d.hum].map((l) => (Number.isNaN(l.level.last) ? 0 : l.level.last));
}

/** Goertzel power of x at f. */
function power(x: Float32Array, f: number, rate: number, n = x.length): number {
  const w = (2 * Math.PI * f) / rate, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const s = x[i] + c * s1 - s2; s2 = s1; s1 = s; }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

// ------------------------------------------------------------------ tests

describe('bake', () => {
  it('is deterministic: two bakes are bit-identical', () => {
    const b2 = bakeAll();
    const fnv = (a: Float32Array): number => {
      const u = new Uint32Array(a.buffer, a.byteOffset, a.length);
      let h = 0x811c9dc5;
      for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 0x01000193);
      return h >>> 0;
    };
    const digest = (b: SoundBank): number[] => [b.noise, b.rumble, b.fan, b.hum, ...Object.values(b.clips), ...b.pairs.map((p) => p.data), ...b.free.map((p) => p.data)].map(fnv);
    expect(digest(b2)).toEqual(digest(bank));
    expect(b2.pairs.map((p) => p.peak)).toEqual(bank.pairs.map((p) => p.peak));
    expect(b2.free.map((p) => p.peak)).toEqual(bank.free.map((p) => p.peak));
  });

  it('bakes 15 types × 2 surfaces × 2 strike points, 15 × 2 free rings and every clip within ~5 MB', () => {
    expect(bank.pairs.length).toBe(ACOUSTIC_TYPES.length * SURFACES.length * VARIANTS);
    expect(bank.free.length).toBe(ACOUSTIC_TYPES.length * VARIANTS);
    expect(bank.bytes).toBeLessThan(5.2e6);
    for (const p of bank.pairs.concat(bank.free)) {
      expect(p.data.length).toBeLessThanOrEqual(MODAL_MAX_S * BAKE_RATE + 1);
      let peak = 0;
      for (const v of p.data) peak = Math.max(peak, Math.abs(v));
      expect(peak).toBeCloseTo(1, 5);
      expect(Number.isFinite(p.peak) && p.peak > 0).toBe(true);
    }
    // the two strike points of a pair are different sounds (not a copy)
    const a = bank.pairs[pairSlot(0, 0, 0)].data, b = bank.pairs[pairSlot(0, 0, 1)].data;
    let d = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) d += Math.abs(a[i] - b[i]);
    expect(d).toBeGreaterThan(10);
    console.log(`bake: ${bakeMs.toFixed(0)} ms in node (first, cold), ${(bank.bytes / 1e6).toFixed(2)} MB of Float32 buffers`);
  });

  it('every impact buffer ends because its ring has died (η, not a fade): last 15%, as the speaker plays it, ≥ 40 dB under the onset', () => {
    const rmsDb = (x: Float32Array, i0: number, i1: number): number => { let s = 0; for (let i = i0; i < i1; i++) s += x[i] * x[i]; return 10 * Math.log10(s / Math.max(1, i1 - i0) + 1e-30); };
    let worst = -Infinity;
    for (const t of ACOUSTIC_TYPES) {
      for (let v = 0; v < VARIANTS; v++) {
        const sets = [...SURFACES.map((sf) => pairModes(t, sf, bank.mass[t], v)), freeModes(t, bank.mass[t], v)];
        for (const ms of sets) expect(modalLength(ms, 0.03, 10)).toBeLessThan(MODAL_MAX_S); // never capped
      }
    }
    let worstKey = '';
    for (const p of bank.pairs.concat(bank.free)) {
      // what the phone plays (its speaker ≈ a 2nd-order high-pass at F_REPRO = 250 Hz, modal.ts)
      const x = p.data, n = x.length;
      const hp = Float32Array.from(x);
      biquadInPlace(hp, 'highpass', 250, 0.707, BAKE_RATE);
      const rel = rmsDb(hp, Math.floor(0.85 * n), n) - rmsDb(x, 0, Math.min(n, Math.round(0.02 * BAKE_RATE)));
      if (rel > worst) { worst = rel; worstKey = p.key; }
    }
    console.log(`impact buffers: loudest last-15% tail ${worst.toFixed(1)} dB re the first 20 ms (${worstKey})`);
    expect(worst).toBeLessThan(-40);
  });

  it('is sliced finely: a zero-budget step does ~CHUNK operations, so a 2 ms slice overruns by ≲ 0.1 ms; release() drops everything', () => {
    const b = createBaker(BAKE_RATE);
    const dts: number[] = [];
    let steps = 0;
    while (!b.step(0, () => performance.now())) {
      steps++;
      if (steps % 50 === 0) { const t0 = performance.now(); b.step(0, () => performance.now()); dts.push(performance.now() - t0); steps++; }
    }
    expect(steps).toBeGreaterThan(500); // ~940 resumable steps, not 45 indivisible tasks
    dts.sort((x, y) => x - y);
    console.log(`bake steps: ${steps}; sampled step median ${dts[dts.length >> 1].toFixed(3)} ms, max ${dts[dts.length - 1].toFixed(2)} ms (node, machine under load)`);
    expect(b.done).toBe(true);
    expect(b.bank().bytes).toBe(bank.bytes);
    b.release();
    expect(() => b.bank()).toThrow();
  });
});

describe('modal frequencies from the material constants', () => {
  it('the 2 mm aluminium deck panel matches the plate formula within 0.5%', () => {
    const al = MATERIALS[MAT.aluminium];
    const h = 0.002, Lx = 0.6, Ly = 0.6;
    const D = (al.E * h ** 3) / (12 * (1 - al.nu ** 2));
    for (const [m, n] of [[1, 1], [2, 3], [5, 4], [9, 7]]) {
      const exact = (Math.PI / 2) * Math.sqrt(D / (al.rho * h)) * ((m / Lx) ** 2 + (n / Ly) ** 2);
      expect(Math.abs(plateModeHz(al, h, Lx, Ly, m, n) / exact - 1)).toBeLessThan(0.005);
    }
    expect(plateModeHz(al, h, Lx, Ly, 1, 1)).toBeCloseTo(26.9, 0); // c_L = 5355 m/s
    // and the modes the bake uses are exactly those frequencies
    const modes = constructionModes({ kind: 'plate', mat: MAT.aluminium, h, Lx, Ly }, 'x', 120, 12000);
    for (const md of modes.slice(0, 20)) {
      const ratio = md.f / (0.453 * Math.sqrt(al.E / (al.rho * (1 - al.nu ** 2))) * h);
      const k = ratio * Lx * Lx; // m² + n² for a square panel
      expect(Math.abs(k - Math.round(k))).toBeLessThan(0.005 * k);
    }
  });

  it('the mug shell (ring) and the spanner (free–free bar) match their analytic formulas, and the baked buffer rings there', () => {
    const st = MATERIALS[MAT.steel];
    const mug = PROP_ACOUSTICS.mug.body as { h: number; R: number };
    for (const n of [2, 3, 4]) {
      // ring bending: f = n(n²−1)/√(n²+1) · (1/2π) · √(E h² / (12 ρ (1−ν²) R⁴))
      const exact = ((n * (n * n - 1)) / Math.sqrt(n * n + 1)) * (1 / (2 * Math.PI)) * Math.sqrt((st.E * mug.h ** 2) / (12 * st.rho * (1 - st.nu ** 2) * mug.R ** 4));
      expect(Math.abs(ringModeHz(st, mug.h, mug.R, n) / exact - 1)).toBeLessThan(0.005);
    }
    const sp = PROP_ACOUSTICS.spanner.body as { I: number; A: number; L: number };
    const f1 = (4.73004074 ** 2 / (2 * Math.PI)) * Math.sqrt((st.E * sp.I) / (st.rho * sp.A * sp.L ** 4));
    expect(Math.abs(barModeHz(st, sp.I, sp.A, sp.L, 0) / f1 - 1)).toBeLessThan(1e-9);
    expect(f1).toBeGreaterThan(600);
    expect(f1).toBeLessThan(700);
    // the spanner's own ring (struck free) has energy at f1 well above the neighbourhood (5% away)
    const pb = bank.free[freeSlot(ACOUSTIC_TYPES.indexOf('spanner'), 0)];
    const n = Math.min(pb.data.length, 8192);
    expect(power(pb.data, f1, BAKE_RATE, n)).toBeGreaterThan(20 * power(pb.data, f1 * 1.05, BAKE_RATE, n));
  });

  it('Hertz contact time follows m*^(2/5), v^(−1/5): hard light objects ring bright, soft ones thud', () => {
    const al = MATERIALS[MAT.aluminium];
    const eSt = contactModulus(MATERIALS[MAT.steel], al), eFoam = contactModulus(MATERIALS[MAT.foam], al);
    const tSp = hertzContactTime(0.3, 0.003, eSt, 1), tPi = hertzContactTime(0.45, 0.06, eFoam, 1);
    expect(1 / tSp).toBeGreaterThan(3000);
    expect(1 / tPi).toBeLessThan(100);
    expect(hertzContactTime(4 * 0.3, 0.003, eSt, 1) / tSp).toBeCloseTo(4 ** 0.4, 6);
    expect(hertzContactTime(0.3, 0.003, eSt, 32) / tSp).toBeCloseTo(32 ** -0.2, 6);
  });
});

describe('impact identity', () => {
  it('a ringing prop on the deck is heard by its own modes: its strongest mode stands ≥ 6 dB above the ±⅓-octave spectrum', () => {
    const pw = (x: Float32Array, f: number): number => power(x, f, BAKE_RATE);
    const out: string[] = [];
    for (const t of ['mug', 'tablet', 'spanner', 'torch', 'helmet', 'plantpot'] as const) {
      const ti = ACOUSTIC_TYPES.indexOf(t);
      for (let v = 0; v < VARIANTS; v++) {
        const seed = v ? `${t}:deck#${v}` : `${t}:deck`;
        const om = ownModes(t, bank.mass[t], seed).filter((m) => m.f > 300 && m.f < 8000);
        const best = om.reduce((a, m) => ((m.a * m.a) / (m.f * m.eta) > (a.a * a.a) / (a.f * a.eta) ? m : a));
        const x = bank.pairs[pairSlot(ti, 0, v)].data;
        const ref: number[] = [];
        for (let k = 0; k < 24; k++) { const r = Math.pow(1.26, (k / 23) * 2 - 1); if (Math.abs(r - 1) > 0.03) ref.push(pw(x, best.f * r)); }
        ref.sort((p, q) => p - q);
        const db = 10 * Math.log10(pw(x, best.f) / ref[ref.length >> 1]);
        if (v === 0) out.push(`${t} ${best.f.toFixed(0)} Hz +${db.toFixed(1)} dB`);
        expect(db).toBeGreaterThan(6);
      }
    }
    console.log(`own mode above the deck's response: ${out.join(', ')}`);
  });

  it('the deck panel is an installed panel: its ring decays by its loss factor (+ radiation) within 0.6 s, not over seconds', () => {
    const ms = pairModes('mug', 'deck', 0.4).filter((m) => m.eta < 0.012 || m.eta > 0.0125); // the panel's modes
    for (const m of ms) expect(m.eta).toBeGreaterThanOrEqual(0.01);
    expect(modalLength(pairModes('mug', 'deck', 0.4), 0.03, 10)).toBeLessThan(0.6);
  });
});

describe('level laws', () => {
  it('impact gain ∝ J/√m (doubling the impulse doubles the pressure); mechanisms ∝ √E', () => {
    const { ctx, eng, ring, step } = rig();
    step(2);
    const at = { x: -0.5, y: -1, z: -13 };
    const mugDeck = (seq: number): number => bank.pairs[pairSlot(ACOUSTIC_TYPES.indexOf('mug'), 0, strikeVariant(seq))].peak;
    const seq1 = ring.head;
    emitEvent(ring, 'contact', 0, 0, BODY_SHIP, 0.5, at, null, 1, MAT.ceramic, MAT.aluminium); // mug-galley-1 is prop 0
    step();
    const g1 = eng.debug.voices.voices.map((v) => lastSet(v.gain.gain as unknown as MockParam)).filter((g) => g > 0);
    expect(g1.length).toBe(1);
    const seq2 = ring.head;
    emitEvent(ring, 'contact', 0, 0, BODY_SHIP, 1.0, at, null, 1, MAT.ceramic, MAT.aluminium);
    step();
    const g2 = eng.debug.voices.voices.map((v) => lastSet(v.gain.gain as unknown as MockParam)).filter((g) => g > 0);
    expect(g2.length).toBe(2);
    // twice the impulse, same type: 2× the pressure (times the two strike points' own levels)
    expect(Math.max(...g2) / mugDeck(seq2) / (g1[0] / mugDeck(seq1))).toBeCloseTo(2, 6);
    // the law's constant: a 0.4 kg mug at J = 0.54 N·s within 1 m of the head is K·J/√m (relative pair level 1)
    const att = airAtt(Math.hypot(at.x + 0.55, at.y - 0.25, at.z + 13.45)); // 1/r from the impact to the eye
    expect(g1[0]).toBeCloseTo(K_IMPACT * (0.5 / Math.sqrt(0.4)) * mugDeck(seq1) * att, 9);
    // no voice resamples: every source plays at its own rate
    expect(ctx.sources.every((src) => src.playbackRate.value === 1 && src.playbackRate.log.length === 0)).toBe(true);
    // boot clamp: 4× the energy → 2× the pressure
    const n0 = ctx.sources.length;
    emitEvent(ring, 'boot', 0, 0, 0, MECH.boot.e0, at, null, 0.5, 0, 0);
    emitEvent(ring, 'boot', 0, 1, 0, 4 * MECH.boot.e0, at, null, 0.5, 0, 0);
    step();
    const boots = ctx.sources.slice(n0).filter((s) => s.buffer === (eng.debug.buffers.bootClamp as unknown as MockBuffer));
    expect(boots.length).toBe(2);
    const bg = eng.debug.voices.voices.filter((v) => v.src && boots.includes(v.src as unknown as MockSource)).map((v) => lastSet(v.gain.gain as unknown as MockParam)).sort();
    expect(bg[1] / bg[0]).toBeCloseTo(2, 6);
  });

  it('air path ∝ cabin pressure; in vacuum and floating, every path to the ear is closed (silence)', () => {
    expect(airPathGain(101325)).toBe(1);
    expect(airPathGain(50662.5)).toBeCloseTo(0.5, 9);
    expect(airPathGain(0)).toBe(0);
    const { eng, frame, step } = rig();
    frame.jetDuty[3] = 1;
    frame.engineLevel[0] = 1;
    frame.cabinPressure = 0;
    frame.crew.posture = 'floating';
    frame.crew.gripped = false;
    step(5);
    expect(eng.mixer.airGain.last).toBe(0);
    expect(eng.mixer.boneGain.last).toBe(0);
    // the jet is still firing (its cause exists), but nothing carries it: no air, no body contact
    expect(eng.debug.rcs.some((l) => l.level.last > 0)).toBe(true);
    // the zero is exact (scheduled), and after the ramp both paths are unplugged from the master
    const airLog = (eng.mixer.air.gain as unknown as MockParam).log;
    expect(airLog.some((e) => e[0] === 'set' && e[1] === 0)).toBe(true);
    step(40);
    expect(eng.mixer.airWire.on).toBe(false);
    expect(eng.mixer.boneWire.on).toBe(false);
    expect((eng.mixer.struct as unknown as MockNode).outs).toContain(eng.mixer.air as unknown as MockNode);
    // grip the deck: the structure-borne part comes through the body again (bone path), the air path stays shut
    frame.crew.gripped = true;
    step();
    expect(eng.mixer.boneGain.last).toBeGreaterThan(0);
    expect(eng.mixer.airGain.last).toBe(0);
  });

  it('aero roar: ~70–80 dB in the cabin at q = 10 kPa and Mach 25, louder lower down, 0 out of the air', () => {
    const o: AeroOut = { pOut: 0, mach: 0, delta: 0, fPeak: 0, pCabin: 0 };
    const spl = (p: number): number => 94 + 20 * Math.log10(p);
    const a = 300;
    const at = (q: number, M: number): number => { const U = M * a; aeroRoar(o, q, (2 * q) / (U * U), U, a, 16); return spl(o.pCabin); };
    const high = at(10e3, 25);
    expect(high).toBeGreaterThan(70);
    expect(high).toBeLessThan(80);
    expect(at(30e3, 10)).toBeGreaterThan(high);
    aeroRoar(o, 0, 0, 7500, a, 16);
    expect(o.pCabin).toBe(0);
    expect(structAtt(10)).toBeCloseTo(0.5, 12);
  });
});

describe('no sound without a cause (mock AudioContext)', () => {
  it('jetDuty 0 → every RCS gain 0; engineLevel 0 → rumble 0; outside air → aero 0', () => {
    const { eng, frame, step } = rig();
    step(3);
    expect(eng.debug.rcs.every((l) => l.level.last === 0)).toBe(true);
    expect(eng.debug.engines.every((l) => l.level.last === 0)).toBe(true);
    expect(eng.debug.aero.level.last).toBe(0);
    expect(eng.debug.slide.level.last).toBe(0);
    expect(eng.debug.hum.level.last).toBe(0); // not docked
    frame.jetDuty[5] = 0.5;
    frame.engineLevel[1] = 0.3;
    step();
    expect(eng.debug.rcs.filter((l) => l.level.last > 0).length).toBeGreaterThan(0);
    expect(eng.debug.engines[1].level.last).toBeGreaterThan(0);
    expect(eng.debug.engines[0].level.last).toBe(0);
    frame.jetDuty[5] = 0;
    frame.engineLevel[1] = 0;
    step();
    expect(eng.debug.rcs.every((l) => l.level.last === 0)).toBe(true);
    expect(eng.debug.engines.every((l) => l.level.last === 0)).toBe(true);
    // sources with no cause for a second are stopped (no audio-thread cost)
    step(90);
    expect(eng.debug.rcs.every((l) => !l.awake)).toBe(true);
    expect(eng.debug.engines.every((l) => !l.awake)).toBe(true);
  });

  it('a jetOn event starts exactly one transient, with gain ∝ F_j', () => {
    const { ctx, eng, ring, ship, step } = rig();
    step(2);
    const clip = eng.debug.buffers.valveOpen as unknown as MockBuffer;
    const jp = ship.jets[2].pos;
    let n0 = ctx.sources.length;
    emitEvent(ring, 'jetOn', 0, 2, 0, 34e3, jp, null, 0, 0, 0);
    step();
    let started = ctx.sources.slice(n0).filter((s) => s.buffer === clip);
    expect(started.length).toBe(1);
    const v1 = eng.debug.voices.voices.find((v) => (v.src as unknown) === started[0])!;
    const g34 = lastSet(v1.gain.gain as unknown as MockParam);
    const d = Math.hypot(jp.x + 0.55, jp.y - 0.25, jp.z + 13.45);
    expect(g34).toBeCloseTo(((G_VALVE * 34e3) / JET_REF_N) * structAtt(d), 9);
    n0 = ctx.sources.length;
    emitEvent(ring, 'jetOn', 0, 2, 0, 8.5e3, jp, null, 0, 0, 0);
    step();
    started = ctx.sources.slice(n0).filter((s) => s.buffer === clip);
    expect(started.length).toBe(1);
    const v2 = eng.debug.voices.voices.find((v) => (v.src as unknown) === started[0])!;
    expect(lastSet(v2.gain.gain as unknown as MockParam) / g34).toBeCloseTo(0.25, 9);
  });

  it('above 4× warp every continuous gain is 0 and events are decimated to ≤ 8 per second', () => {
    const { eng, frame, ring, step } = rig();
    for (let j = 0; j < 14; j++) frame.jetDuty[j] = 1;
    frame.engineLevel[0] = frame.engineLevel[1] = 1;
    frame.docked = true;
    frame.dynamicPressure = 10e3; frame.airDensity = 3.6e-4; frame.airVelocity.x = 7500;
    step(3);
    expect(continuousGains(eng).filter((g) => g > 0).length).toBeGreaterThan(8);
    frame.warp = 10;
    const s0 = eng.stats.started;
    for (let k = 0; k < 120; k++) { // 2 s of frames, 30 impacts in each
      for (let i = 0; i < 30; i++) emitEvent(ring, 'contact', frame.simTime, i % 20, BODY_SHIP, 0.3 + 0.01 * i, { x: 0, y: -1, z: -12 }, null, 1, 0, MAT.aluminium);
      step();
    }
    expect(continuousGains(eng).every((g) => g === 0)).toBe(true);
    const played = eng.stats.started - s0;
    expect(played).toBeLessThanOrEqual(8 + 8 * 2 + 1); // the initial 8 tokens + 8/s
    expect(played).toBeGreaterThanOrEqual(16);
    // back to 1×: continuous sources return
    frame.warp = 1;
    step();
    expect(eng.debug.rcs.some((l) => l.level.last > 0)).toBe(true);
  });

  it('voice cap: a burst of 20 impacts plays the 16 loudest', () => {
    const { eng, ring, step } = rig();
    step(2);
    const s0 = eng.stats.started;
    const unit = K_IMPACT * (0.1 / Math.sqrt(0.4)) * airAtt(Math.hypot(0.05, 1.25, 0.45));
    const expected: number[] = [];
    for (let i = 0; i < 20; i++) {
      expected.push(unit * (i + 1) * bank.pairs[pairSlot(0, 0, strikeVariant(ring.head))].peak);
      emitEvent(ring, 'contact', 0, 0, BODY_SHIP, 0.1 * (i + 1), { x: -0.5, y: -1, z: -13 }, null, 1, 0, MAT.aluminium);
    }
    step();
    expect(eng.stats.started - s0).toBe(16);
    const gains = eng.debug.voices.voices.map((v) => lastSet(v.gain.gain as unknown as MockParam)).sort((a, b) => a - b);
    // the 16 loudest by their (post-low-pass) level; same buffer type, so the same order as the gains
    const top = expected.sort((a, b) => b - a).slice(0, 16).sort((a, b) => a - b);
    for (let i = 0; i < 16; i++) expect(gains[i] / top[i]).toBeCloseTo(1, 6);
  });

  it('a stolen voice fades out over STEAL_S before it stops, and the new hit starts after the fade (no click)', () => {
    const { ctx, eng, ring, step } = rig();
    step(2);
    for (let i = 0; i < 16; i++) emitEvent(ring, 'contact', 0, 0, BODY_SHIP, 1, { x: -0.5, y: -1, z: -13 }, null, 1, 0, MAT.aluminium);
    step();
    const before = eng.debug.voices.voices.map((v) => v.src as unknown as MockSource);
    const now0 = ctx.currentTime + 1 / 60;
    emitEvent(ring, 'contact', 0, 0, BODY_SHIP, 5, { x: -0.5, y: -1, z: -13 }, null, 1, 0, MAT.aluminium);
    step();
    expect(eng.stats.stolen).toBe(1);
    const vi = eng.debug.voices.voices.findIndex((v, i) => (v.src as unknown as MockSource) !== before[i]);
    const v = eng.debug.voices.voices[vi];
    const log = (v.gain.gain as unknown as MockParam).log;
    const k = log.findIndex((e) => e[0] === 'target' && e[1] === 0);
    expect(k).toBeGreaterThanOrEqual(0); // ramp to 0 …
    expect(before[vi].stopAt).toBeCloseTo(now0 + STEAL_S, 9); // … old source stops after it …
    expect((v.src as unknown as MockSource).started).toBeGreaterThanOrEqual(now0 + STEAL_S - 1e-12); // … new one starts after it
    expect(log[log.length - 1][0]).toBe('set');
    expect(log[log.length - 1][2]).toBeGreaterThanOrEqual(now0 + STEAL_S - 1e-12);
  });

  it('two loose bodies ring with their own modes (no wall panel); prop on crew: only the prop\'s and the body\'s', () => {
    const { ctx, eng, ring, ship, step } = rig({ fansOn: false });
    step(2);
    const free = eng.debug.freeBuffers as unknown as MockBuffer[];
    const pairs = eng.debug.pairBuffers as unknown as MockBuffer[];
    const iMug = ship.props.indexOf('mug'), iBox = ship.props.indexOf('toolbox');
    let n0 = ctx.sources.length;
    emitEvent(ring, 'contact', 0, iMug, iBox, 3, { x: -0.5, y: -1, z: -13 }, null, 1, MAT.steel, MAT.steel);
    step();
    let srcs = ctx.sources.slice(n0);
    expect(srcs.length).toBe(2);
    expect(srcs.every((src) => free.includes(src.buffer!) && !pairs.includes(src.buffer!))).toBe(true);
    const tMug = ACOUSTIC_TYPES.indexOf('mug'), tBox = ACOUSTIC_TYPES.indexOf('toolbox');
    const want = [0, 1].map((v) => free[freeSlot(tMug, v)]).concat([0, 1].map((v) => free[freeSlot(tBox, v)]));
    expect(srcs.every((src) => want.includes(src.buffer!))).toBe(true);
    n0 = ctx.sources.length;
    emitEvent(ring, 'contact', 0, iMug, BODY_CREW, 2, { x: -0.5, y: -0.5, z: -13 }, null, 1, MAT.steel, MAT.tissue);
    step();
    srcs = ctx.sources.slice(n0);
    const tBody = ACOUSTIC_TYPES.indexOf('body');
    // (a steel mug on soft tissue: the long Hertz contact leaves little of the mug's kHz ring; the body's thud plays)
    expect(srcs.length).toBeGreaterThanOrEqual(1);
    expect(srcs.every((src) => [0, 1].some((v) => src.buffer === free[freeSlot(tMug, v)] || src.buffer === free[freeSlot(tBody, v)]))).toBe(true);
  });

  it('sliding: gain ∝ μ·N·v_t with μ from the props data', () => {
    const { eng, ring, ship, step } = rig();
    step(2);
    const at = { x: -0.5, y: -1, z: -13 };
    const iSp = ship.props.indexOf('spanner'), iPi = ship.props.indexOf('pillow');
    emitEvent(ring, 'slide', 0, iSp, BODY_SHIP, 4, at, null, 0.3, MAT.steel, MAT.aluminium);
    step();
    const gSp = eng.debug.slide.level.last;
    step(120);
    emitEvent(ring, 'slide', 0, iPi, BODY_SHIP, 4, at, null, 0.3, MAT.foam, MAT.aluminium);
    step();
    const gPi = eng.debug.slide.level.last;
    expect(frictionOf('spanner')).toBe(PROP_TYPES.spanner.friction);
    expect(gPi / gSp).toBeCloseTo(PROP_TYPES.pillow.friction / PROP_TYPES.spanner.friction, 6);
  });
});

// The allocation and cost probe runs on an esbuild bundle (as in the page), not on vitest's module transform:
// vite-node rewrites every import into a getter access, which blocks V8's inlining and makes it box doubles,
// so a heap measurement under the transform would measure the test runner, not the engine.
const PROBE = `
import { bakeAll } from './src/audio/bake';
import { createAudioEngine } from './src/audio/engine';
import { audioShipFromData, createAudioFrame } from './src/audio/index';
import { createEventRing, drain, emitEvent, BODY_SHIP, MAT } from './src/world/events';
class P { constructor(v) { this.value = v; } setTargetAtTime(v) { this.value = v; } setValueAtTime(v) { this.value = v; } cancelScheduledValues() {} }
class N { constructor() { this.outs = 0; } connect(n) { this.outs++; return n; } disconnect(n) { this.outs = n ? this.outs - 1 : 0; } }
class G extends N { constructor() { super(); this.gain = new P(1); } }
class B extends N { constructor() { super(); this.type = 'lowpass'; this.frequency = new P(350); this.Q = new P(1); } }
class S extends N { constructor() { super(); this.pan = new P(0); } }
class C extends N { constructor() { super(); this.threshold = new P(0); this.knee = new P(0); this.ratio = new P(0); this.attack = new P(0); this.release = new P(0); } }
class W extends N { constructor() { super(); this.curve = null; this.oversample = 'none'; } }
class Buf { constructor(c, n, r) { this.length = n; this.sampleRate = r; this.duration = n / r; } copyToChannel() {} }
class Src extends N { constructor() { super(); this.buffer = null; this.loop = false; this.playbackRate = new P(1); } start() {} stop() {} }
class Ctx { constructor() { this.currentTime = 0; this.sampleRate = 48000; this.destination = new N(); }
  createGain() { return new G(); } createBiquadFilter() { return new B(); } createStereoPanner() { return new S(); }
  createDynamicsCompressor() { return new C(); } createWaveShaper() { return new W(); } createBufferSource() { return new Src(); } createBuffer(c, n, r) { return new Buf(c, n, r); } }
export function run(heap, now) {
  const bank = bakeAll();
  const ctx = new Ctx();
  const ship = audioShipFromData('wren');
  ship.jets = [];
  for (let j = 0; j < 14; j++) ship.jets.push({ pos: { x: (j % 2 ? -1 : 1) * (3 + (j % 3)), y: (j % 4) - 1.5, z: (j < 7 ? -12 : 12) + (j % 5) }, thrust: 34e3 });
  const eng = createAudioEngine(ctx, ship, bank);
  const frame = createAudioFrame(14, 2);
  const ring = createEventRing();
  const dr = (cb) => { drain(ring, cb); };
  frame.crew.gripped = true;
  for (let j = 0; j < 14; j++) frame.jetDuty[j] = 0.5;
  frame.engineLevel[0] = frame.engineLevel[1] = 0.8;
  frame.dynamicPressure = 5e3; frame.airDensity = 2e-4; frame.airVelocity.x = 7000;
  const step = () => { ctx.currentTime += frame.dt; frame.simTime += frame.dt; eng.update(frame, dr); };
  const out = {};
  for (let i = 0; i < 30000; i++) step();
  let best = Infinity;
  for (let w = 0; w < 12; w++) { const h0 = heap(); for (let i = 0; i < 4000; i++) step(); const d = heap() - h0; if (d >= 0) best = Math.min(best, d / 4000); }
  out.steadyBytes = best;
  let t0 = now(); for (let i = 0; i < 20000; i++) step(); out.steadyUs = (now() - t0) / 20000 * 1000;
  let writes = 0, k = 0;
  const pwm = () => { for (let j = 0; j < 14; j++) frame.jetDuty[j] = ((k + j) % 7) / 7; frame.engineLevel[0] = 0.5 + 0.05 * (k % 10); frame.crew.yaw = 0.3 * Math.sin(k * 0.01); k++; step(); writes += eng.stats.writes; };
  for (let i = 0; i < 5000; i++) pwm();
  writes = 0; t0 = now(); for (let i = 0; i < 20000; i++) pwm(); out.pwmUs = (now() - t0) / 20000 * 1000; out.pwmWrites = writes / 20000;
  const at = { x: 1, y: -1, z: -8 };
  const burst = () => { for (let i = 0; i < 20; i++) emitEvent(ring, 'contact', frame.simTime, i % 25, BODY_SHIP, 0.2 + 0.05 * i, at, null, 1.5, 0, i & 1 ? MAT.aluminium : MAT.composite); pwm(); };
  for (let i = 0; i < 1000; i++) burst();
  t0 = now(); for (let i = 0; i < 5000; i++) burst(); out.burstUs = (now() - t0) / 5000 * 1000;
  out.started = eng.stats.started;
  return out;
}
`;

describe('per-frame cost (esbuild bundle, as shipped)', () => {
  it('update with 14 jets, 2 engines and a burst of 20 impacts: no allocation on the continuous path; µs per frame', async () => {
    const { buildSync } = await import('esbuild');
    const root = new URL('..', import.meta.url).pathname;
    const res = buildSync({ stdin: { contents: PROBE, resolveDir: root, loader: 'js', sourcefile: 'probe.js' }, bundle: true, format: 'iife', globalName: 'PROBE', write: false, platform: 'neutral', logLevel: 'silent' });
    const mod = new Function(`${res.outputFiles[0].text}\nreturn PROBE;`)() as { run(heap: () => number, now: () => number): Record<string, number> };
    const proc = (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process;
    const r = mod.run(() => proc.memoryUsage().heapUsed, () => performance.now());
    console.log(`update (node, bundled): steady ${r.steadyUs.toFixed(2)} µs/frame and ${r.steadyBytes.toFixed(2)} B/frame allocated; ` +
      `PWM-varying 14 jets + 2 engines + aero + fan ${r.pwmUs.toFixed(2)} µs/frame with ${r.pwmWrites.toFixed(1)} AudioParam writes/frame; ` +
      `+ a burst of 20 impacts every frame ${r.burstUs.toFixed(1)} µs/frame (${r.started} transients started)`);
    expect(r.steadyBytes).toBeLessThan(1); // one boxed double would be 12 B
    expect(r.pwmUs).toBeLessThan(25); // ≤ 0.05 ms on the A16 at ≈ 2× node
    expect(r.burstUs).toBeLessThan(100);
  });
});

describe('frame from views', () => {
  it('copies the wave-1 view fields without allocating and defaults what is missing', () => {
    const f = createAudioFrame(3, 2);
    const jd = f.jetDuty;
    fillAudioFrame(f, 1 / 60, {
      craft: { jetDuty: [0.1, 0.2, 0.3, 0.4], engineLevel: [0.5], airVelocity: { x: 1, y: 2, z: 3 }, heatFlux: 7, dockedTo: 'x' },
      flight: { airDensity: 1e-3, dynamicPressure: 50 },
      warp: { achieved: 2 },
      crew: { eye: { x: 1, y: 2, z: 3 }, yaw: 0.5, posture: 'walking', gripped: true, roomId: 'lounge' },
      simTime: 12,
    });
    expect(f.jetDuty).toBe(jd);
    expect(Array.from(f.jetDuty)).toEqual([0.1, 0.2, 0.3]);
    expect(Array.from(f.engineLevel)).toEqual([0.5, 0]);
    expect(f.docked).toBe(true);
    expect(f.cabinPressure).toBe(101325);
    expect(f.crew.roomId).toBe('lounge');
    fillAudioFrame(f, 1 / 60, { craft: { dockedTo: null }, flight: null, warp: { achieved: 1 }, crew: null, simTime: 0 });
    expect(Array.from(f.jetDuty)).toEqual([0, 0, 0]);
  });

  it('speed of sound from the primary\'s isothermal atmosphere: a = √(γ·g·H) = √(γRT/M)', () => {
    // an Earth-like body built the way src/sim/universe.ts builds it: H = R·T/(M·g)
    const mu = 3.986e14, radius = 6.371e6, T = 288, M = 0.02897, g = mu / (radius * radius);
    const H = (8.314462618 * T) / (M * g);
    const earth = { mu, radius, temperature: T, atmosphere: { scaleHeight: H } };
    expect(primarySoundSpeed(earth)).toBeCloseTo(Math.sqrt((1.4 * 8.314462618 * T) / M), 6);
    expect(primarySoundSpeed(earth)).toBeGreaterThan(335);
    expect(primarySoundSpeed(earth)).toBeLessThan(345);
    // CO₂-rich (the rocky class, M 43.5 g/mol): γ 1.3
    const Hm = (8.314462618 * 210) / (0.0435 * 3.7);
    expect(primarySoundSpeed({ mu: 3.7 * 3.39e6 ** 2, radius: 3.39e6, temperature: 210, atmosphere: { scaleHeight: Hm } })).toBeCloseTo(Math.sqrt((1.3 * 8.314462618 * 210) / 0.0435), 6);
    expect(primarySoundSpeed({ mu, radius, temperature: T, atmosphere: null })).toBe(0);
    const f = createAudioFrame(0, 0);
    fillAudioFrame(f, 1 / 60, { craft: null, flight: { airDensity: 1, dynamicPressure: 1 }, warp: { achieved: 1 }, crew: null, simTime: 0, primary: earth });
    expect(f.soundSpeed).toBeCloseTo(primarySoundSpeed(earth), 9);
    fillAudioFrame(f, 1 / 60, { craft: null, flight: { airDensity: 1, dynamicPressure: 1, soundSpeed: 300 }, warp: { achieved: 1 }, crew: null, simTime: 0, primary: earth });
    expect(f.soundSpeed).toBe(300); // a published profile value wins
  });
});

describe('mix calibration', () => {
  it('the limiter\'s make-up gain (+3.42 dB at −6 dBFS, ratio 20) is trimmed away; the guard soft-clips below full scale', () => {
    expect(limiterMakeupDb(-6, 20)).toBeCloseTo(3.42, 9);
    const ctx = new MockCtx();
    const eng = createAudioEngine(ctx as unknown as BaseAudioContext, ship14(), bank);
    const trim = eng.mixer.trim.gain.value;
    expect(trim * GUARD_SPAN).toBeCloseTo(Math.pow(10, -3.42 / 20), 9);
    const curve = (eng.mixer.guard as unknown as MockShaper).curve!;
    // identity (after the ×GUARD_SPAN scaling) up to the knee; never reaches 1
    const at = (x: number): number => curve[Math.round(((x / GUARD_SPAN + 1) / 2) * (curve.length - 1))];
    expect(at(0.5)).toBeCloseTo(0.5, 3);
    expect(Math.max(...curve)).toBeLessThan(1);
    expect(guardCurve(10)).toBeLessThanOrEqual(GUARD_CEIL);
  });
});

describe('masking floor', () => {
  it('is built from the pressures that reach the ear above 250 Hz: a sub-250 Hz roar does not hide a mug clink', () => {
    const { eng, frame, ring, step } = rig({ fansOn: false });
    frame.crew.posture = 'walking'; frame.crew.gripped = false;
    // q = 1 kPa at Mach 25: cabin roar ≈ 62 dB, low-passed near 180 Hz
    frame.dynamicPressure = 1000; frame.airDensity = 3.6e-5; frame.airVelocity.x = 7500; frame.soundSpeed = 300;
    step(30);
    expect(eng.debug.aeroState.fPeak).toBeLessThan(250);
    expect(eng.debug.floor).toBeCloseTo(AUDIBLE, 12); // the roar is all below 250 Hz: only the threshold of hearing
    const s0 = eng.stats.started;
    emitEvent(ring, 'contact', 0, 0, BODY_SHIP, 0.2, { x: -0.55, y: -0.75, z: -13.45 }, null, 1, MAT.steel, MAT.aluminium);
    step();
    expect(eng.stats.started - s0).toBe(1);
    const v = eng.debug.voices.voices.find((x) => x.src && x.level > 0)!;
    expect(v.end - v.t0).toBeGreaterThan(0.1); // plays out its decay, not cut to 30 ms
  });

  it('RCS hiss counts with its band pressure (not the noise-bandwidth-corrected loop gain)', () => {
    const { eng, frame, ship, step } = rig();
    frame.jetDuty[0] = 1;
    step(3);
    const jp = ship.jets[0].pos;
    const d = Math.hypot(jp.x + 0.55, jp.y - 0.25, jp.z + 13.45);
    const band = G_HISS / (1 + d / 10); // the hiss's in-band pressure at the head, air path 1
    const fan = eng.debug.fan.level.last; // the fan's loop (its band is above 250 Hz)
    expect(eng.debug.floor).toBeCloseTo(0.1 * Math.sqrt(band * band + fan * fan), 9);
  });
});

describe('context (tap to start, 48 kHz, visibility)', () => {
  type L = (e?: unknown) => void;
  function fakeWin(opts: { refuseRate?: boolean } = {}) {
    const listeners: Record<string, L[]> = {};
    const docL: Record<string, L[]> = {};
    let inGesture = false;
    const made: { opts: unknown }[] = [];
    class Ctx {
      state = 'suspended';
      sampleRate = 48000;
      private l: L[] = [];
      pending = 0;
      constructor(o: { sampleRate?: number }) {
        if (opts.refuseRate && o.sampleRate) throw new Error('NotSupportedError');
        made.push({ opts: o });
      }
      addEventListener(_t: string, f: L): void { this.l.push(f); }
      removeEventListener(): void {}
      private set(s: string): void { this.state = s; for (const f of this.l) f(); }
      resume(): Promise<void> {
        if (!inGesture) { this.pending++; return new Promise(() => { /* the spec: pending until allowed */ }); }
        this.set('running');
        return Promise.resolve();
      }
      suspend(): Promise<void> { this.set('suspended'); return Promise.resolve(); }
      close(): Promise<void> { return Promise.resolve(); }
    }
    const doc = { hidden: false, addEventListener: (t: string, f: L) => { (docL[t] ??= []).push(f); }, removeEventListener() {} };
    const win = {
      document: doc, navigator: {}, AudioContext: Ctx,
      addEventListener: (t: string, f: L) => { (listeners[t] ??= []).push(f); },
      removeEventListener: (t: string, f: L) => { listeners[t] = (listeners[t] ?? []).filter((x) => x !== f); },
    };
    const tap = (): void => { inGesture = true; for (const f of [...(listeners.touchend ?? [])]) f({}); inGesture = false; };
    const vis = (hidden: boolean): void => { doc.hidden = hidden; for (const f of docL.visibilitychange ?? []) f(); };
    const armed = (): number => (listeners.touchend ?? []).length;
    return { win: win as unknown as Window, tap, vis, armed, made };
  }

  it('creates the context at 48 kHz inside the tap (falls back to the default rate if refused)', async () => {
    const w = fakeWin();
    const u = createUnlocker({ win: w.win, onContext: () => {} });
    expect(u.state()).toBe('none');
    w.tap();
    expect(w.made[0].opts).toEqual({ latencyHint: 'interactive', sampleRate: 48000 });
    expect(u.state()).toBe('running');
    const w2 = fakeWin({ refuseRate: true });
    const u2 = createUnlocker({ win: w2.win, onContext: () => {} });
    w2.tap();
    expect(u2.state()).toBe('running');
    expect(w2.made[0].opts).toEqual({ latencyHint: 'interactive' });
  });

  it('hidden → suspended; visible outside a gesture: resume() stays pending, the tap listeners are re-armed, the next tap resumes', async () => {
    const w = fakeWin();
    const u = createUnlocker({ win: w.win, onContext: () => {} });
    w.tap();
    await Promise.resolve();
    expect(u.state()).toBe('running');
    expect(w.armed()).toBe(0);
    w.vis(true);
    expect(u.state()).toBe('suspended');
    w.vis(false);
    await Promise.resolve();
    expect(u.state()).toBe('suspended'); // the resume() made outside a gesture never settles
    expect(w.armed()).toBe(1);
    w.tap();
    expect(u.state()).toBe('running');
  });
});
