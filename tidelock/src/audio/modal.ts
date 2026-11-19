// Modal synthesis, baked once: every impact, click and clank is a sum of exponentially decaying modes
//   y(t) = Σ a_k · e^(−π f_k η_k (t − t0_k)) · sin(2π f_k (t − t0_k)),   t ≥ t0_k
// with frequencies from the closed-form plate / bar / ring formulas of materials.ts and a loss factor
// η_k = η_structure + η_radiation(f_k) (the energy a vibrating body loses to the air it radiates into is
// often larger than its material damping: a steel spanner's 640 Hz mode loses ~10× more to the air than to
// the steel). Nothing is synthesised modally in real time: each (prop type × surface) pair is a Float32 buffer
// baked for two strike points, and a hit plays one of them (picked by a hash of the event index) with gain ∝
// J/√m and a Hertz low-pass at 1/τ_c. No run-time resampling (a playbackRate ≠ 1 doubles a voice's cost).
//
// Every buffer is as long as its ring takes to fall 60 dB below its peak, so the decay heard is η's, not a
// fade's. Rings longer than MODAL_MAX_S are rare (a spanner's high modes) and are the only ones faded.
//
// Pure functions on typed arrays: no DOM, no AudioContext, deterministic (randomness only from core/rng.ts hashes).
// The bake functions are generators that yield every ~CHUNK sample-operations, so the baker can stop at any
// point and resume in the next slice: no slice runs longer than its budget plus one chunk (≈ 0.1 ms).

import { hash } from '../core/rng';
import {
  ACOUSTIC_TYPES, ETA_INSTALLED, MATERIALS, PROP_ACOUSTICS, SURFACE_PANEL, SURFACES, barModeHz, plateModeHz, plateWaveSpeed, radiatingArea, ringModeHz,
  type AcousticPropType, type Construction, type SurfaceId,
} from './materials';

/** Bake rate. The AudioContext is requested at this rate; any other rate would resample every source on playback. */
export const BAKE_RATE = 48000;
/** Longest modal buffer, s. Only a ring still above −60 dB at this time is faded (over its last 15%). */
export const MODAL_MAX_S = 1.0;
/** Strike-point variants baked per pair (a hit picks one by hash of its event index). */
export const VARIANTS = 2;
/** Work per generator step, sample-operations (≈ 0.05–0.15 ms in node). */
export const CHUNK = 16384;
const C_AIR = 343;
const RHO_AIR = 1.2;

export interface Mode {
  f: number;
  a: number;
  eta: number;
  /** Onset delay, s (a toggle's second click, a toolbox's tools landing after the box). */
  t0: number;
}

/** Deterministic uniform in [0, 1) from a label. */
export const u01 = (label: string): number => hash(label) / 4294967296;

/** Radiation efficiency of a compact radiator of size `size` at f: (ka)² below ka = 1. */
export const sigmaCompact = (f: number, size: number): number => {
  const ka = ((2 * Math.PI * f) / C_AIR) * (size / 2);
  return ka >= 1 ? 1 : ka * ka;
};

/** Plate radiation efficiency below coincidence f_c = c²/(1.8 c_L h): √(f/f_c), 1 above (estimate). */
export const sigmaPlate = (f: number, cL: number, h: number): number => {
  const fc = (C_AIR * C_AIR) / (1.8 * cL * h);
  return f >= fc ? 1 : Math.sqrt(f / fc);
};

/** Radiation loss factor of a compact body of size `size`, area S, vibrating mass M: η = ρ₀cσS/(ωM). */
export const etaRadCompact = (f: number, size: number, massKg: number, area = size * size): number =>
  (RHO_AIR * C_AIR * sigmaCompact(f, size) * area) / (2 * Math.PI * f * massKg);

/** Radiation loss factor of a plate radiating from both faces: η = 2ρ₀cσ/(ω m″). */
export const etaRadPlate = (f: number, cL: number, h: number, surfaceMass: number): number =>
  (2 * RHO_AIR * C_AIR * sigmaPlate(f, cL, h)) / (2 * Math.PI * f * surfaceMass);

/**
 * The modes of a construction, struck at a point chosen by `seed`: frequency, mode-shape factor φ at the strike
 * point, sorted by frequency, inside [fMin, fMax]. `massLoad` lowers every f by 1/√(1 + massLoad).
 */
export function constructionModes(c: Construction, seed: string, fMin: number, fMax: number, massLoad = 0): { f: number; phi: number }[] {
  const mat = MATERIALS[c.mat];
  const wet = 1 / Math.sqrt(1 + massLoad);
  const out: { f: number; phi: number }[] = [];
  if (c.kind === 'plate') {
    const x0 = 0.2 + 0.6 * u01(`${seed}:x`), y0 = 0.2 + 0.6 * u01(`${seed}:y`);
    for (let m = 1; m <= 24; m++) {
      for (let n = 1; n <= 24; n++) {
        const f = plateModeHz(mat, c.h, c.Lx, c.Ly, m, n) * wet;
        if (f < fMin || f > fMax) continue;
        out.push({ f, phi: Math.sin(m * Math.PI * x0) * Math.sin(n * Math.PI * y0) });
      }
    }
  } else if (c.kind === 'bar') {
    const x0 = 0.05 + 0.4 * u01(`${seed}:x`); // struck near an end, where every free-free mode moves
    for (let n = 0; n < 6; n++) {
      const f = barModeHz(mat, c.I, c.A, c.L, n) * wet;
      if (f < fMin || f > fMax) continue;
      out.push({ f, phi: Math.cos((n + 1.5) * Math.PI * x0) });
    }
  } else {
    const th = 2 * Math.PI * u01(`${seed}:th`);
    for (let n = 2; n <= 9; n++) {
      const f = ringModeHz(mat, c.h, c.R, n) * wet;
      if (f < fMin || f > fMax) continue;
      out.push({ f, phi: 0.35 + 0.65 * Math.abs(Math.cos(n * th)) });
    }
  }
  out.sort((p, q) => p.f - q.f);
  return out;
}

/**
 * Reduction of a dense modal set (a 2 mm panel has ~60 modes in the 1–2 kHz octave): per octave band from `f0`,
 * the `perBand` strongest true modes, scaled together so the band keeps its summed energy Σa² (modes of random
 * phase add in power). Several lines per band keep a panel's response dense, as it is, instead of collapsing a
 * band into one loud tone that would bury the struck object's own modes.
 */
export function octaveReduce(modes: readonly Mode[], f0: number, bands: number, perBand: number): Mode[] {
  const out: Mode[] = [];
  for (let b = 0; b < bands; b++) {
    const lo = f0 * 2 ** b, hi = lo * 2;
    const inBand = modes.filter((m) => m.f >= lo && m.f < hi);
    if (!inBand.length) continue;
    let e = 0;
    for (const m of inBand) e += m.a * m.a;
    const keep = inBand.sort((p, q) => Math.abs(q.a) - Math.abs(p.a)).slice(0, perBand);
    let ek = 0;
    for (const m of keep) ek += m.a * m.a;
    const k = ek > 0 ? Math.sqrt(e / ek) : 0;
    for (const m of keep) out.push({ f: m.f, a: m.a * k, eta: m.eta, t0: m.t0 });
  }
  return out;
}

/**
 * The struck object's own modes (and its loose contents). Pressure from mode k ∝ J·φ_k·√(σ_k S)/M_k (modal
 * velocity J·φ/M times the radiated amplitude √(σS)); the run-time gain carries J/√m, so the buffer carries
 * √m·φ·√(σS)/M. The 6 lowest modes; η = the assembly's loss factor + its radiation loss.
 */
export function ownModes(type: AcousticPropType, massKg: number, seed: string): Mode[] {
  const pa = PROP_ACOUSTICS[type];
  const sq = Math.sqrt(massKg);
  const own: Mode[] = [];
  const mVib = pa.structMass * (1 + pa.addedMass);
  const mObj = mVib / 2;
  const S = radiatingArea(type);
  for (const { f, phi } of constructionModes(pa.body, `${seed}:body`, 60, 16000, pa.addedMass)) {
    own.push({ f, a: (sq * phi * Math.sqrt(sigmaCompact(f, pa.size) * S)) / mObj, eta: pa.eta + etaRadCompact(f, pa.size, mVib, S), t0: 0 });
  }
  const modes = own.sort((p, q) => p.f - q.f).slice(0, 6);
  // Loose tools inside (toolbox): small steel bars landing 8–70 ms after the box, each with two modes.
  for (let i = 0; i < pa.rattle; i++) {
    const L = 0.1 + 0.12 * u01(`${type}:rattle:${i}:L`);
    const steel = MATERIALS[4];
    const I = (0.012 * 0.005 ** 3) / 12, A = 0.012 * 0.005;
    const t0 = 0.008 + 0.06 * u01(`${seed}:rattle:${i}:t`);
    const amp = 0.25 * (0.5 + u01(`${seed}:rattle:${i}:a`)) * Math.abs(modes[0]?.a ?? 1);
    for (let n = 0; n < 2; n++) {
      const f = barModeHz(steel, I, A, L, n);
      // tools lying against each other: contact (joint) damping like an installed part, plus radiation
      modes.push({ f, a: amp / (n + 1), eta: ETA_INSTALLED + etaRadCompact(f, L, 0.012 * 0.005 * L * 7850), t0 });
    }
  }
  return modes;
}

/** Modes of the struck surface panel (installed loss factor + radiation loss), 6 octave bands from 150 Hz. */
export function panelModesFor(surface: SurfaceId, massKg: number, seed: string): Mode[] {
  const panel = SURFACE_PANEL[surface];
  const sq = Math.sqrt(massKg);
  const pm = MATERIALS[panel.mat];
  const cL = plateWaveSpeed(pm);
  const mPanel = (pm.rho * panel.h * panel.Lx * panel.Ly) / 4;
  const area = panel.Lx * panel.Ly;
  const plate: Mode[] = [];
  for (const { f, phi } of constructionModes({ kind: 'plate', mat: panel.mat, h: panel.h, Lx: panel.Lx, Ly: panel.Ly }, `${seed}:panel`, 120, 12000)) {
    plate.push({ f, a: (sq * phi * Math.sqrt(sigmaPlate(f, cL, panel.h) * area)) / mPanel, eta: panel.eta + etaRadPlate(f, cL, panel.h, pm.rho * panel.h), t0: 0 });
  }
  return octaveReduce(plate, 150, 6, 4);
}

/** A prop striking a surface panel: its own modes plus the panel's. `variant` moves both strike points. */
export function pairModes(type: AcousticPropType, surface: SurfaceId, massKg: number, variant = 0): Mode[] {
  const seed = variant ? `${type}:${surface}#${variant}` : `${type}:${surface}`;
  return ownModes(type, massKg, seed).concat(panelModesFor(surface, massKg, seed));
}

/** A prop struck by another loose body (no panel involved): its own modes only. */
export function freeModes(type: AcousticPropType, massKg: number, variant = 0): Mode[] {
  return ownModes(type, massKg, variant ? `${type}:free#${variant}` : `${type}:free`);
}

/** The phone speaker's roll-off, Hz (W1-D "Mix": below ~250 Hz), modelled as a 2nd-order high-pass. */
export const F_REPRO = 250;
/** |H(f)| of that high-pass: what the speaker plays of a mode at f. */
export const speakerGain = (f: number): number => {
  const r = (f / F_REPRO) * (f / F_REPRO);
  return r / Math.sqrt(1 + r * r);
};

/**
 * Time for the ring, as the phone plays it, to fall 60 dB below its peak (estimated as √Σ(a·H)², the incoherent
 * sum; H = speakerGain), within [minS, maxS]: mode k is gone at t0_k + ln(|a_k·H_k| / (10⁻³·A)) / (π f_k η_k).
 * A low mode the speaker barely plays does not keep the buffer long; it is still baked, and faded if it outlasts.
 */
export function modalLength(modes: readonly Mode[], minS: number, maxS: number): number {
  let e = 0;
  for (const m of modes) { const a = m.a * speakerGain(m.f); e += a * a; }
  const floor = 1e-3 * Math.sqrt(e);
  let t = minS;
  for (const m of modes) {
    const am = Math.abs(m.a) * speakerGain(m.f);
    if (!(am > floor)) continue;
    const t60 = m.t0 + Math.log(am / floor) / (Math.PI * m.f * m.eta);
    if (t60 > t) t = t60;
  }
  return t > maxS ? maxS : t;
}

/**
 * Bake Σ modes into `out` at `rate` (complex-rotation recursion: 4 multiplies per mode per sample, exact for an
 * exponentially decaying sinusoid), as a generator that yields every ~CHUNK sample-operations. Each mode stops
 * once it is 80 dB under the buffer's peak estimate. `fade`: if the buffer ends before the ring has died, the last
 * 15% is faded with a raised cosine so the cut does not click. Returns the peak |y| (the generator's value).
 */
export function* bakeModesG(out: Float32Array, modes: readonly Mode[], rate: number, fade = true): Generator<void, number> {
  const n = out.length;
  const acc = scratch(n);
  let e = 0;
  for (const m of modes) e += m.a * m.a;
  const stop2 = 1e-8 * e; // (−80 dB)²
  let ops = 0;
  for (const m of modes) {
    const w = (2 * Math.PI * m.f) / rate;
    if (w >= Math.PI) continue; // above Nyquist
    const c = Math.cos(w), s = Math.sin(w), r = Math.exp((-Math.PI * m.f * m.eta) / rate);
    const rc = r * c, rs = r * s;
    ST[0] = m.a; ST[1] = 0; // [re, im]; im = a·e^(−…)·sin(ωt)
    let i = Math.max(0, Math.round(m.t0 * rate));
    while (i < n) {
      const end = Math.min(n, i + 2048);
      rotateAdd(acc, i, end, rc, rs);
      ops += end - i;
      i = end;
      if (ops >= CHUNK) { ops = 0; yield; }
      if (ST[0] * ST[0] + ST[1] * ST[1] < stop2) break;
    }
  }
  yield;
  return finishModes(out, acc, fade);
}

// The per-sample loops live in plain functions (state in ST): V8 optimises them fully, which it does less well
// for a loop written inside a generator body.
const ST = new Float64Array(2);
function rotateAdd(acc: Float64Array, from: number, to: number, rc: number, rs: number): void {
  let re = ST[0], im = ST[1];
  for (let i = from; i < to; i++) {
    acc[i] += im;
    const nre = rc * re - rs * im;
    im = rs * re + rc * im;
    re = nre;
  }
  ST[0] = re; ST[1] = im;
}
function finishModes(out: Float32Array, acc: Float64Array, fade: boolean): number {
  const n = out.length;
  let peak = 0;
  const f0 = Math.floor(n * 0.85);
  for (let i = 0; i < n; i++) {
    let y = acc[i];
    if (fade && i >= f0) y *= 0.5 + 0.5 * Math.cos((Math.PI * (i - f0)) / (n - f0));
    out[i] = y;
    const ay = y < 0 ? -y : y;
    if (ay > peak) peak = ay;
  }
  return peak;
}

// One accumulator reused by every bake (a fresh 0.4 MB Float64Array per buffer made the GC pause mid-slice).
let acc64 = new Float64Array(0);
const scratch = (n: number): Float64Array => {
  if (acc64.length < n) acc64 = new Float64Array(n);
  const a = acc64.subarray(0, n);
  a.fill(0);
  return a;
};
/** Free the shared accumulator (the baker calls this when it finishes). */
export const releaseScratch = (): void => { acc64 = new Float64Array(0); };

/** Run a bake generator to the end (tests, measurements). */
export function runToEnd<T>(g: Generator<void, T>): T {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/** Non-sliced form of bakeModesG. */
export const bakeModes = (out: Float32Array, modes: readonly Mode[], rate: number, fade = true): number => runToEnd(bakeModesG(out, modes, rate, fade));

/** One baked modal buffer and the gain factor that makes its level physical relative to the reference pair. */
export interface ModalBuffer {
  key: string;
  data: Float32Array;
  /** Raw peak before normalisation (the reference pair, mug on deck, is 1 after scaling). */
  peak: number;
  /** Energy fraction of the (peak-normalised) buffer per octave band from 62.5 Hz (8 bands, sum 1): what a
   *  Hertz low-pass at f leaves of it is estimated from these at run time. */
  bands: Float64Array;
}

/** Octave bands of ModalBuffer.bands: centres 62.5·2^b·√2 Hz, b = 0..7. */
export const BAND_F0 = 62.5;
export const NBANDS = 8;

export const pairKey = (type: AcousticPropType, surface: SurfaceId | 'free'): string => `${type}@${surface}`;

/** Every (prop type × surface) pair, in a fixed order: 15 × 2 = 30 (each baked in VARIANTS strike points). */
export const MODAL_PAIRS: readonly { type: AcousticPropType; surface: SurfaceId }[] = ACOUSTIC_TYPES.flatMap((type) =>
  SURFACES.map((surface) => ({ type, surface })),
);

/** True when some mode is still above −60 dB of the peak at the buffer's end (the cut would click unfaded). */
function needsFade(modes: readonly Mode[], L: number): boolean {
  let e = 0;
  for (const m of modes) e += m.a * m.a;
  const floor = 1e-3 * Math.sqrt(e) * 0.999;
  for (const m of modes) if (Math.abs(m.a) * Math.exp(-Math.PI * m.f * m.eta * Math.max(0, L - m.t0)) > floor) return true;
  return false;
}

function bandEnergy(modes: readonly Mode[]): Float64Array {
  const out = new Float64Array(NBANDS);
  let tot = 0;
  for (const m of modes) {
    // energy of a decaying mode ∝ a²·T where T = 1/(2π f η) (∫e^(−2πfηt) dt)
    const en = (m.a * m.a) / (2 * Math.PI * m.f * m.eta);
    let b = Math.floor(Math.log2(m.f / BAND_F0));
    if (b < 0) b = 0; else if (b >= NBANDS) b = NBANDS - 1;
    out[b] += en;
    tot += en;
  }
  if (tot > 0) for (let b = 0; b < NBANDS; b++) out[b] /= tot;
  return out;
}

/** Bake one set of modes into a buffer sized to its −60 dB time (unnormalised: physical units of pairModes). */
export function* bakeModalG(key: string, modes: Mode[], rate = BAKE_RATE): Generator<void, ModalBuffer> {
  const L = modalLength(modes, 0.03, MODAL_MAX_S);
  const len = Math.max(1, Math.round(L * rate));
  const data = new Float32Array(len);
  // fade only when something the speaker can play outlasts the cap, or an inaudible low mode is cut
  const peak = yield* bakeModesG(data, modes, rate, needsFade(modes, L));
  return { key, data, peak, bands: bandEnergy(modes) };
}

/** Bake one pair (variant 0) at once. */
export function bakePair(type: AcousticPropType, surface: SurfaceId, massKg: number, rate = BAKE_RATE, variant = 0): ModalBuffer {
  return runToEnd(bakeModalG(pairKey(type, surface), pairModes(type, surface, massKg, variant), rate));
}
