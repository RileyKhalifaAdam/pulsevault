// Everything audible is baked once into Float32 buffers in plain JS (no OfflineAudioContext, no AudioWorklet):
// the shared noise loop, the drive rumble, the fan and station-machinery loops, the mechanism clips and the
// modal impact buffers (15 types × 2 surfaces × 2 strike points, plus each type struck free by another body).
// Deterministic: the only randomness is core/rng.ts seeded by fixed labels, so the same build bakes the same
// samples bit for bit. Pure: no DOM, runs in node.
//
// Sliced at a fine grain: the whole bake is one generator that yields every ~CHUNK sample-operations
// (≈ 0.05–0.15 ms), so `Baker.step(budget)` returns within its budget plus one chunk, wherever it is (inside a
// filter pass, a sine, a mode). Band noise is cut from the one shared white-noise buffer instead of drawing
// fresh random numbers for every loop and clip.
//
// Levels: 1.0 in a buffer is 1 Pa = 94 dB SPL at the ear (docs/SIMULATION.md W1-D "reference"). Loops are
// normalised to RMS 1 and clips to peak 1; the sources multiply by a physical pressure.

import { makeRng, type Rng } from '../core/rng';
import { PROP_TYPES } from '../data/props';
import { ACOUSTIC_TYPES, ETA_INSTALLED, MATERIALS, PROP_ACOUSTICS, SURFACE_PANEL, SURFACES, barModeHz, plateWaveSpeed, ringModeHz, type AcousticPropType } from './materials';
import {
  BAKE_RATE, CHUNK, VARIANTS, bakeModalG, bakeModesG, constructionModes, etaRadPlate, freeModes, modalLength, pairKey, pairModes, releaseScratch, runToEnd,
  type Mode, type ModalBuffer,
} from './modal';
import { MAT } from '../world/events';

export type ClipId =
  | 'valveOpen' | 'valveClose' | 'ignition' | 'bootClamp' | 'bootRelease' | 'detent' | 'toggle' | 'plunger'
  | 'breaker' | 'latch' | 'creak';
export const CLIP_IDS: readonly ClipId[] = [
  'valveOpen', 'valveClose', 'ignition', 'bootClamp', 'bootRelease', 'detent', 'toggle', 'plunger', 'breaker', 'latch', 'creak',
];

export interface SoundBank {
  rate: number;
  /** White noise, RMS 1, 2^17 samples (2.7 s): the one noise buffer every noise source shares (offsets decorrelate). */
  noise: Float32Array;
  /** Drive rumble loop, RMS 1: harmonics 250–800 Hz of a 62 Hz feed/chamber fundamental (missing fundamental) and
   *  band noise. 1 s, integer cycles of everything. (No ripple modulation: see bakeRumble.) */
  rumble: Float32Array;
  /** Cabin fan loop, RMS 1: 7 blades × 3000 rpm = 350 Hz blade-pass and harmonics over broadband flow noise. */
  fan: Float32Array;
  /** Station machinery loop heard through the collar, RMS 1: 4 blades × 1800 rpm = 120 Hz family above 240 Hz. */
  hum: Float32Array;
  clips: Record<ClipId, Float32Array>;
  /** Modal impact buffers struck on a surface, index ((type · SURFACES + surface) · VARIANTS + variant);
   *  `peak` is relative to mug@deck variant 0 (= 1). */
  pairs: ModalBuffer[];
  /** The same types struck by another loose body (own modes only), index (type · VARIANTS + variant). */
  free: ModalBuffer[];
  /** Mass used per acoustic prop type, kg. */
  mass: Record<AcousticPropType, number>;
  bytes: number;
  bakeMs: number;
}

export const pairSlot = (typeIdx: number, surfaceIdx: number, variant: number): number => (typeIdx * SURFACES.length + surfaceIdx) * VARIANTS + variant;
export const freeSlot = (typeIdx: number, variant: number): number => typeIdx * VARIANTS + variant;

// ------------------------------------------------------------------ bake-time DSP (never run per frame), sliced

type BiquadKind = 'lowpass' | 'highpass' | 'bandpass';
/** RBJ-cookbook biquad applied in place (bake time only), yielding every CHUNK samples. */
export function* biquadG(x: Float32Array, kind: BiquadKind, f: number, q: number, rate: number, from = 0, to = x.length): Generator<void, void> {
  const w = (2 * Math.PI * f) / rate, cw = Math.cos(w), al = Math.sin(w) / (2 * q);
  let b0: number, b1: number, b2: number;
  if (kind === 'lowpass') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; }
  else if (kind === 'highpass') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; }
  else { b0 = al; b1 = 0; b2 = -al; }
  const a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
  b0 /= a0; b1 /= a0; b2 /= a0;
  const A1 = a1 / a0, A2 = a2 / a0;
  const st = new Float64Array(4); // x1, x2, y1, y2
  // two passes over a loop so the filter state at the seam is the steady state (no click at the loop point)
  for (let pass = 0; pass < 2; pass++) {
    let i = from;
    while (i < to) {
      const end = Math.min(to, i + CHUNK);
      biquadRun(x, i, end, b0, b1, b2, A1, A2, st, pass === 1);
      i = end;
      yield;
    }
  }
}
function biquadRun(x: Float32Array, from: number, to: number, b0: number, b1: number, b2: number, A1: number, A2: number, st: Float64Array, write: boolean): void {
  let x1 = st[0], x2 = st[1], y1 = st[2], y2 = st[3];
  for (let i = from; i < to; i++) {
    const xi = x[i];
    const y = b0 * xi + b1 * x1 + b2 * x2 - A1 * y1 - A2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = y;
    if (write) x[i] = y;
  }
  st[0] = x1; st[1] = x2; st[2] = y1; st[3] = y2;
}
/** Non-sliced form (tests). */
export const biquadInPlace = (x: Float32Array, kind: BiquadKind, f: number, q: number, rate: number): void => runToEnd(biquadG(x, kind, f, q, rate));

/** out += a·sin(2π f t + ph) by rotation recursion (no per-sample transcendental), yielding every CHUNK samples. */
function* addSineG(out: Float32Array, f: number, a: number, ph: number, rate: number): Generator<void, void> {
  const w = (2 * Math.PI * f) / rate, c = Math.cos(w), s = Math.sin(w);
  const st = new Float64Array([Math.cos(ph), Math.sin(ph)]);
  let i = 0;
  while (i < out.length) {
    const end = Math.min(out.length, i + CHUNK);
    sineRun(out, i, end, a, c, s, st);
    i = end;
    yield;
  }
}
function sineRun(out: Float32Array, from: number, to: number, a: number, c: number, s: number, st: Float64Array): void {
  let re = st[0], im = st[1];
  for (let i = from; i < to; i++) {
    out[i] += a * im;
    const nre = c * re - s * im;
    im = s * re + c * im;
    re = nre;
  }
  st[0] = re; st[1] = im;
}

const rms = (x: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
};
const scaleTo = (x: Float32Array, k: number): Float32Array => {
  for (let i = 0; i < x.length; i++) x[i] *= k;
  return x;
};
const normRms = (x: Float32Array): Float32Array => scaleTo(x, 1 / (rms(x) || 1));
const normPeak = (x: Float32Array): Float32Array => {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return scaleTo(x, 1 / (p || 1));
};

/** x = a·x + b·y, in place. */
const mix = (x: Float32Array, a: number, y: Float32Array, b: number): void => {
  for (let i = 0; i < x.length; i++) x[i] = a * x[i] + b * y[i];
};

/** A copy of `n` samples of the shared noise from offset `at` (wrapping): band noise without new random numbers. */
const noiseCut = (noise: Float32Array, n: number, at: number): Float32Array => {
  const x = new Float32Array(n);
  const N = noise.length;
  let j = ((at % N) + N) % N;
  for (let i = 0; i < n; i++) { x[i] = noise[j]; j = j + 1 === N ? 0 : j + 1; }
  return x;
};

/** Band noise lo..hi (Hz) of length n, RMS 1, cut from the shared noise. */
function* bandNoiseG(noise: Float32Array, n: number, at: number, lo: number, hi: number, rate: number): Generator<void, Float32Array> {
  const x = noiseCut(noise, n, at);
  if (lo > 0) yield* biquadG(x, 'highpass', lo, 0.707, rate);
  if (hi > 0) yield* biquadG(x, 'lowpass', hi, 0.707, rate);
  return normRms(x);
}

/** Add an exponentially decaying noise burst (a valve seat, a contact click), optionally high-passed. */
function* addBurstG(out: Float32Array, noise: Float32Array, rate: number, t0: number, tau: number, amp: number, rng: Rng, hpHz = 0): Generator<void, void> {
  const i0 = Math.round(t0 * rate);
  const n = Math.min(out.length - i0, Math.round(tau * 8 * rate));
  if (n <= 0) return;
  const b = noiseCut(noise, n, Math.floor(rng.next() * noise.length));
  if (hpHz > 0) yield* biquadG(b, 'highpass', hpHz, 0.707, rate);
  addDecaying(out, i0, b, amp, Math.exp(-1 / (tau * rate)));
}
function addDecaying(out: Float32Array, i0: number, b: Float32Array, amp: number, k: number): void {
  let e = amp;
  for (let i = 0; i < b.length; i++) { out[i0 + i] += e * b[i]; e *= k; }
}

/** Plate modes of an installed panel struck once, as Mode[] (φ only, scaled by amp); η plus the plate's radiation loss. */
const panelModes = (mat: number, h: number, Lx: number, Ly: number, eta: number, seed: string, k: number, amp: number, t0 = 0): Mode[] => {
  const m = MATERIALS[mat];
  const cL = plateWaveSpeed(m);
  return constructionModes({ kind: 'plate', mat, h, Lx, Ly }, seed, 150, 10000)
    .sort((p, q) => Math.abs(q.phi) - Math.abs(p.phi))
    .slice(0, k)
    .map(({ f, phi }) => ({ f, a: amp * phi, eta: eta + etaRadPlate(f, cL, h, m.rho * h), t0 }));
};

const barModes = (mat: number, I: number, A: number, L: number, eta: number, amp: number, t0 = 0, n = 3): Mode[] => {
  const out: Mode[] = [];
  for (let i = 0; i < n; i++) out.push({ f: barModeHz(MATERIALS[mat], I, A, L, i), a: amp / (i + 1), eta, t0 });
  return out;
};

// ------------------------------------------------------------------ the pieces

/** Loop length, s: every periodic component has an integer number of cycles in it, so the seam is inaudible. */
const LOOP_S = 1;

function fillWhite(x: Float32Array, from: number, to: number, rng: Rng): void {
  for (let i = from; i < to; i++) x[i] = 2 * rng.next() - 1;
}

function* noiseG(): Generator<void, Float32Array> {
  const rng = makeRng('tidelock-audio:noise');
  const x = new Float32Array(1 << 17);
  let i = 0;
  while (i < x.length) {
    const end = Math.min(x.length, i + CHUNK);
    fillWhite(x, i, end, rng);
    i = end;
    yield;
  }
  return normRms(x);
}

/**
 * Drive rumble. The plan's 6–12 Hz ripple from a 1% thrust fluctuation is, with p ∝ F, a 1% (0.09 dB)
 * amplitude modulation: far below the ~0.5–1 dB that hearing detects at those rates, so by §1.1.3 it is not
 * built (an earlier bake used a depth of 0.35, 35× its cause).
 */
function* rumbleG(rate: number, noise: Float32Array): Generator<void, Float32Array> {
  const n = LOOP_S * rate;
  const x = new Float32Array(n);
  const rng = makeRng('tidelock-audio:rumble');
  const f0 = 62; // feed/chamber fundamental; harmonics k = 4..13 span 248–806 Hz, whole cycles per 1 s loop
  for (let k = 4; k <= 13; k++) yield* addSineG(x, f0 * k, (1 / k) * (0.6 + 0.4 * rng.next()), 2 * Math.PI * rng.next(), rate);
  normRms(x);
  const band = yield* bandNoiseG(noise, n, 7919, 200, 900, rate);
  mix(x, 0.55, band, 0.85);
  return normRms(x);
}

/** Cabin fan: blade-pass 350 Hz family plus shaft-order sidebands (±50 Hz) and broadband flow noise. */
function* fanG(rate: number, noise: Float32Array): Generator<void, Float32Array> {
  const n = LOOP_S * rate;
  const x = new Float32Array(n);
  const rng = makeRng('tidelock-audio:fan');
  const amps = [1, 0.45, 0.22, 0.1];
  // shaft order 50 Hz (3000 rpm) modulating the blade loading by 8%: sidebands at k·350 ± 50 Hz of 0.04 each
  for (let k = 1; k <= 4; k++) {
    const ph = 2 * Math.PI * rng.next();
    yield* addSineG(x, 350 * k, amps[k - 1], ph, rate);
    yield* addSineG(x, 350 * k - 50, 0.04 * amps[k - 1], ph, rate);
    yield* addSineG(x, 350 * k + 50, 0.04 * amps[k - 1], ph, rate);
  }
  normRms(x);
  const flow = yield* bandNoiseG(noise, n, 31337, 150, 2500, rate);
  mix(x, 0.6, flow, 0.8);
  return normRms(x);
}

/** Station machinery through the docking collar: 120 Hz blade-pass family above the speaker cut-off. */
function* humG(rate: number, noise: Float32Array): Generator<void, Float32Array> {
  const n = LOOP_S * rate;
  const x = new Float32Array(n);
  const rng = makeRng('tidelock-audio:hum');
  for (let k = 2; k <= 6; k++) yield* addSineG(x, 120 * k, 1 / k, 2 * Math.PI * rng.next(), rate);
  normRms(x);
  const flow = yield* bandNoiseG(noise, n, 104729, 0, 700, rate);
  mix(x, 0.8, flow, 0.4);
  return normRms(x);
}

interface Burst { t0: number; tau: number; amp: number; hp: number }
interface ClipRecipe {
  /** Shortest length, s (covers the bursts and any band noise). */
  minS: number;
  modes: Mode[];
  bursts: Burst[];
  /** Band noise with an envelope (the valve's chamber rise). */
  band?: { lo: number; hi: number; amp: number; env: (t: number) => number };
  /** Low-pass applied last (the ignition's chamber). */
  lp?: number;
}

/** Mechanism clips: each is the mechanism's own impulse(s) into its own modes and the structure it is bolted to. */
function clipRecipe(id: ClipId, rng: Rng): ClipRecipe {
  const al = MAT.aluminium, st = MAT.steel;
  const eI = ETA_INSTALLED;
  switch (id) {
    case 'valveOpen':
      // poppet lift (broadband 5–10 ms click), chamber pressure rise (15 ms), the mount panel's ring
      return {
        minS: 0.2, modes: panelModes(al, 0.004, 1.2, 0.8, eI, 'valve-mount', 8, 0.4), bursts: [{ t0: 0, tau: 0.0015, amp: 1, hp: 1000 }],
        band: { lo: 500, hi: 5000, amp: 0.5, env: (t) => (1 - Math.exp(-t / 0.005)) * Math.exp(-t / 0.03) },
      };
    case 'valveClose':
      return { minS: 0.03, modes: panelModes(al, 0.004, 1.2, 0.8, eI, 'valve-mount-close', 6, 0.25), bursts: [{ t0: 0, tau: 0.001, amp: 0.8, hp: 1500 }] };
    case 'ignition': {
      // chamber light-off: the drive's 62 Hz family struck once (heard as its harmonics; amplitude time constant
      // 0.12 s, the chamber's acoustic decay through the throat), plus a flow burst
      const ms: Mode[] = [];
      for (let k = 4; k <= 13; k++) ms.push({ f: 62 * k, a: 1 / k, eta: 1 / (Math.PI * 62 * k * 0.12), t0: 0.01 });
      void rng;
      return { minS: 0.6, modes: ms, bursts: [{ t0: 0.005, tau: 0.08, amp: 0.4, hp: 0 }], lp: 1200 };
    }
    case 'bootClamp':
      // 50 g steel armature (12 × 12 × 40 mm) closing on the 2 mm aluminium deck
      return {
        minS: 0.03,
        modes: barModes(st, (0.012 * 0.012 ** 3) / 12, 0.012 * 0.012, 0.04, eI, 0.3)
          .concat(panelModes(SURFACE_PANEL.deck.mat, SURFACE_PANEL.deck.h, 0.6, 0.6, SURFACE_PANEL.deck.eta, 'boot', 8, 1)),
        bursts: [{ t0: 0, tau: 0.0008, amp: 0.4, hp: 2000 }],
      };
    case 'bootRelease':
      return { minS: 0.03, modes: panelModes(SURFACE_PANEL.deck.mat, SURFACE_PANEL.deck.h, 0.6, 0.6, SURFACE_PANEL.deck.eta, 'boot-off', 5, 0.3), bursts: [{ t0: 0, tau: 0.0005, amp: 0.5, hp: 2500 }] };
    case 'detent':
      // ball into a detent groove: a 40 mm steel lever and the 1.5 mm console panel
      return {
        minS: 0.03,
        modes: barModes(st, (0.005 * 0.002 ** 3) / 12, 0.005 * 0.002, 0.04, eI, 0.5).concat(panelModes(al, 0.0015, 0.3, 0.2, eI, 'console-detent', 6, 0.6)),
        bursts: [{ t0: 0, tau: 0.0004, amp: 0.3, hp: 3000 }],
      };
    case 'toggle': {
      // over-centre snap (two impacts 4 ms apart: the spring throw and the stop)
      const modes: Mode[] = [];
      const bursts: Burst[] = [];
      for (const t0 of [0, 0.004]) {
        modes.push(...barModes(st, (0.006 * 0.003 ** 3) / 12, 0.006 * 0.003, 0.06, eI, t0 ? 0.6 : 0.35, t0));
        modes.push(...panelModes(al, 0.0015, 0.3, 0.2, eI, `console-toggle-${t0}`, 6, t0 ? 0.7 : 0.4, t0));
        bursts.push({ t0, tau: 0.0004, amp: 0.3, hp: 3000 });
      }
      return { minS: 0.03, modes, bursts };
    }
    case 'plunger':
      return {
        minS: 0.03,
        modes: barModes(st, (Math.PI / 4) * 0.003 ** 4, Math.PI * 0.003 ** 2, 0.05, eI, 0.4).concat(panelModes(al, 0.0015, 0.3, 0.2, eI, 'console-plunger', 6, 0.5)),
        bursts: [{ t0: 0, tau: 0.0006, amp: 0.4, hp: 2000 }],
      };
    case 'breaker':
      return {
        minS: 0.03,
        modes: panelModes(MAT.polymer, 0.002, 0.05, 0.03, 0.02, 'breaker-case', 4, 0.5).concat(panelModes(al, 0.002, 0.5, 0.4, eI, 'breaker-panel', 6, 0.7)),
        bursts: [{ t0: 0, tau: 0.0006, amp: 0.5, hp: 1500 }],
      };
    case 'latch': {
      // steel hooks (30 × 20 mm, 0.2 m) closing on the collar ring (R 0.8 m, 12 mm) and the 4 mm structure
      const hooks = barModes(st, (0.03 * 0.02 ** 3) / 12, 0.03 * 0.02, 0.2, eI, 0.5);
      const ring: Mode[] = [];
      for (let n = 4; n <= 9; n++) ring.push({ f: ringModeHz(MATERIALS[st], 0.012, 0.8, n), a: 0.6 / Math.sqrt(n), eta: eI, t0: 0 });
      return { minS: 0.05, modes: hooks.concat(ring, panelModes(al, 0.004, 1.2, 0.8, eI, 'collar-structure', 8, 0.6)), bursts: [{ t0: 0, tau: 0.002, amp: 0.4, hp: 800 }] };
    }
    case 'creak': {
      // stick–slip at a skin-frame joint: a dozen micro-slips over 120 ms into a lining panel's modes
      const modes: Mode[] = [];
      for (let k = 0; k < 12; k++) {
        const t0 = 0.12 * rng.next();
        modes.push(...panelModes(SURFACE_PANEL.lining.mat, SURFACE_PANEL.lining.h, 0.8, 0.6, SURFACE_PANEL.lining.eta, `creak-${k}`, 4, 0.3 + 0.7 * rng.next(), t0));
      }
      return { minS: 0.15, modes, bursts: [] };
    }
  }
}

/** Longest clip, s (only the drive's ignition ring needs this long). */
const CLIP_MAX_S = 0.9;

const addEnveloped = (x: Float32Array, band: Float32Array, amp: number, env: (t: number) => number, rate: number): void => {
  for (let i = 0; i < x.length; i++) x[i] += amp * band[i] * env(i / rate);
};

function* clipG(id: ClipId, rate: number, noise: Float32Array): Generator<void, Float32Array> {
  const rng = makeRng(`tidelock-audio:clip:${id}`);
  const r = clipRecipe(id, rng);
  let L = modalLength(r.modes, r.minS, CLIP_MAX_S);
  for (const b of r.bursts) L = Math.max(L, Math.min(CLIP_MAX_S, b.t0 + 8 * b.tau));
  const x = new Float32Array(Math.round(L * rate));
  yield* bakeModesG(x, r.modes, rate, L >= CLIP_MAX_S);
  for (const b of r.bursts) yield* addBurstG(x, noise, rate, b.t0, b.tau, b.amp, rng, b.hp);
  if (r.band) {
    const band = yield* bandNoiseG(noise, x.length, Math.floor(rng.next() * noise.length), r.band.lo, r.band.hi, rate);
    addEnveloped(x, band, r.band.amp, r.band.env, rate);
  }
  if (r.lp) yield* biquadG(x, 'lowpass', r.lp, 0.707, rate);
  return normPeak(x);
}

// ------------------------------------------------------------------ the bank, baked in slices

/** Mass of each acoustic type: the props' data (src/data/props.ts), 80 kg for the crew body. */
export function acousticMass(type: AcousticPropType): number {
  return type === 'body' ? 80 : PROP_TYPES[type].mass;
}

export interface Baker {
  /** Bake until `budgetMs` of wall time (by `now`) has been used; true when everything is baked. */
  step(budgetMs: number, now: () => number): boolean;
  readonly done: boolean;
  /** What is being baked now ('noise', 'rumble', a clip id, 'mug@deck', … 'done'). */
  readonly stage: string;
  /** Valid once done (until released). */
  bank(): SoundBank;
  /** Drop every reference the baker holds (the bank, the generator, its partial results). */
  release(): void;
}

function* bankG(rate: number, out: { bank: SoundBank | null; stage: string }): Generator<void, void> {
  // the continuous loops first (they are what the owner hears first), then the clips, then the impacts
  out.stage = 'noise';
  const noise = yield* noiseG();
  out.stage = 'rumble';
  const rumble = yield* rumbleG(rate, noise);
  out.stage = 'fan';
  const fan = yield* fanG(rate, noise);
  out.stage = 'hum';
  const hum = yield* humG(rate, noise);
  const clips = {} as Record<ClipId, Float32Array>;
  for (const id of CLIP_IDS) { out.stage = id; clips[id] = yield* clipG(id, rate, noise); }
  const mass = {} as Record<AcousticPropType, number>;
  for (const t of ACOUSTIC_TYPES) mass[t] = acousticMass(t);
  const pairs: ModalBuffer[] = [];
  for (const type of ACOUSTIC_TYPES) {
    for (const surface of SURFACES) {
      out.stage = `${type}@${surface}`;
      for (let v = 0; v < VARIANTS; v++) pairs.push(yield* bakeModalG(pairKey(type, surface), pairModes(type, surface, mass[type], v), rate));
    }
  }
  const free: ModalBuffer[] = [];
  for (const type of ACOUSTIC_TYPES) {
    out.stage = `${type}@free`;
    for (let v = 0; v < VARIANTS; v++) free.push(yield* bakeModalG(pairKey(type, 'free'), freeModes(type, mass[type], v), rate));
  }
  out.stage = 'normalise';
  // normalise every modal buffer to peak 1 and keep its physical level relative to mug@deck (variant 0) in `peak`
  const k = 1 / pairs[pairSlot(ACOUSTIC_TYPES.indexOf('mug'), SURFACES.indexOf('deck'), 0)].peak;
  let bytes = 0;
  for (const p of pairs.concat(free)) {
    scaleTo(p.data, 1 / (p.peak || 1));
    p.peak *= k;
    const d = p.data;
    bytes += d.byteLength;
    yield;
  }
  for (const id of CLIP_IDS) bytes += clips[id].byteLength;
  bytes += noise.byteLength + rumble.byteLength + fan.byteLength + hum.byteLength;
  out.stage = 'done';
  out.bank = { rate, noise, rumble, fan, hum, clips, pairs, free, mass, bytes, bakeMs: 0 };
}

/** The whole bake as one resumable generator; `step` runs it for a wall-time budget. */
export function createBaker(rate = BAKE_RATE): Baker {
  const out: { bank: SoundBank | null; stage: string } = { bank: null, stage: '' };
  let gen: Generator<void, void> | null = bankG(rate, out);
  let ms = 0;
  let finished = false;
  return {
    step(budgetMs, now) {
      if (finished || !gen) return finished;
      const t0 = now();
      for (;;) {
        if (gen.next().done) {
          finished = true;
          gen = null;
          releaseScratch();
          if (out.bank) out.bank.bakeMs = ms + (now() - t0);
          break;
        }
        if (now() - t0 >= budgetMs) break;
      }
      if (!finished) ms += now() - t0;
      return finished;
    },
    get done() { return finished; },
    get stage() { return out.stage; },
    bank() {
      if (!out.bank) throw new Error('sound bank not baked yet (or released)');
      return out.bank;
    },
    release() {
      out.bank = null;
      gen = null;
    },
  };
}

/** Bake everything at once (tests, measurements). */
export function bakeAll(rate = BAKE_RATE, now: () => number = () => 0): SoundBank {
  const b = createBaker(rate);
  while (!b.step(1e9, now));
  return b.bank();
}

export { PROP_ACOUSTICS };
