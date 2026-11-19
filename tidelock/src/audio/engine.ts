// The sound engine: builds the graph on an AudioContext from a baked SoundBank, then once per frame reads an
// AudioFrame (continuous sources) and drains the world's event ring (transients). Allocation-free per frame:
// every scratch value lives in preallocated typed arrays; the only objects created are the one-shot
// AudioBufferSourceNodes that played events need (Web Audio has no reusable source).

import { BODY_CREW, BODY_SHIP, MAT, type SimEvent } from '../world/events';
import type { ClipId, SoundBank } from './bake';
import { CLIP_IDS, freeSlot, pairSlot } from './bake';
import { ACOUSTIC_TYPES, MATERIALS, PROP_ACOUSTICS, SURFACES, contactModulus, frictionOf, hertzContactTime, surfaceFor } from './materials';
import { BAND_F0, NBANDS, VARIANTS, type ModalBuffer } from './modal';
import { Slots, Smooth, VOICES, VoicePool, Wire, createMixer, dB, type Mixer } from './mixer';
import {
  BONE_LEVEL, ENBW_LP, EVENTS_PER_S_WARP, FAN_STRUCT, G_FAN, G_HISS, G_HUM, G_RUMBLE, JET_REF_N, K_SLIDE, Loop, WARP_MUTE,
  P0, aeroRoarIO, airAtt, bandComp, structAtt, type AeroOut,
} from './sources';
import type { AudioFrame, AudioShip } from './types';

/** Impact law: gain = K_IMPACT · (J/√m) · (pair level relative to mug@deck). A 0.4 kg mug at 1 m/s (J/√m 0.85) is 74 dB peak at 1 m. */
export const K_IMPACT = dB(74) / 0.85;
/** Valve click peak at 34 kN at the jet (structure law applies): 88 dB. Ignition transient at the nozzle: 98 dB. */
export const G_VALVE = dB(88);
export const G_IGNITION = dB(98);
/** Mechanisms: gain = G·√(E/E₀) with the reference energy E₀ of each (docs/SIMULATION.md W1-D). */
export const MECH: Record<'boot' | 'bootOff' | 'detent' | 'toggle' | 'plunger' | 'breaker' | 'creak', { clip: ClipId; e0: number; g: number }> = {
  boot: { clip: 'bootClamp', e0: 6.25e-3, g: dB(70) }, // 50 g armature at 0.5 m/s
  bootOff: { clip: 'bootRelease', e0: 2e-3, g: dB(60) },
  detent: { clip: 'detent', e0: 2e-3, g: dB(59) },
  toggle: { clip: 'toggle', e0: 10e-3, g: dB(66) }, // snap-through 5–20 mJ
  plunger: { clip: 'plunger', e0: 5e-3, g: dB(62) },
  breaker: { clip: 'breaker', e0: 20e-3, g: dB(68) },
  creak: { clip: 'creak', e0: 0.1, g: dB(54) },
};
/** Latch, capture, undock: gain ∝ J (impulse across the joint); 1e4 N·s is 82 dB at the collar. */
export const G_LATCH = dB(82);
export const J_LATCH = 1e4;
/** Below this pressure (≈ 14 dB SPL) a transient is not built. */
export const AUDIBLE = dB(14);

/** Below this frequency a steady noise does not mask the kHz clicks and rings of transients (masking spreads
 *  upward, but a sub-250 Hz roar leaves the 1–5 kHz band, where impacts carry their energy, nearly free). */
export const MASK_LO_HZ = 250;

const NCLUSTER = 5;
const CLUSTER_PAN = [-1, -0.5, 0, 0.5, 1];
const MAX_CAND = 256 + 8;

export interface AudioStats {
  /** Main-thread ms of the last update (performance clock when available). */
  updateMs: number;
  /** Transients started / dropped by the cap or decimation, totals. */
  started: number;
  dropped: number;
  stolen: number;
  /** AudioParam automation writes in the last update. */
  writes: number;
  /** Continuous loops awake (source nodes running). */
  awake: number;
  bufferBytes: number;
  bakeMs: number;
}

export interface AudioEngine {
  update(frame: AudioFrame, drainEvents?: (cb: (e: SimEvent, seq: number) => void) => void): void;
  /** An AnalyserNode on the output (harness / tests only; created on first call). */
  analyser(): AnalyserNode;
  readonly stats: AudioStats;
  readonly mixer: Mixer;
  /** For tests: the continuous gains and the voice pool. */
  readonly debug: {
    rcs: readonly Loop[];
    engines: readonly Loop[];
    aero: Loop;
    aeroLP: Smooth;
    fanAir: Smooth;
    fan: Loop;
    slide: Loop;
    hum: Loop;
    voices: VoicePool;
    aeroState: AeroOut;
    buffers: Record<ClipId, AudioBuffer>;
    pairBuffers: readonly AudioBuffer[];
    freeBuffers: readonly AudioBuffer[];
    /** The masking floor of the last update (pressure, 1 = 94 dB). */
    readonly floor: number;
  };
  dispose(): void;
}

export interface EngineOptions {
  /** Clock for stats.updateMs (performance.now). Off by default: a native clock call returns a boxed double. */
  now?: () => number;
  /** Real air handling on? Wave 1: a declared constant (true) until W2-D's power bus drives it. */
  fansOn?: boolean;
  /** Hull length for the boundary layer (half of it is the run length), m. */
  hullLength?: number;
}

/** Everything the engine keeps of a SoundBank: AudioBuffers and small per-buffer tables (no Float32 sample data). */
interface Built {
  rate: number;
  bytes: number;
  bakeMs: number;
  noise: AudioBuffer;
  rumble: AudioBuffer;
  fan: AudioBuffer;
  hum: AudioBuffer;
  clips: Record<ClipId, AudioBuffer>;
  clipList: AudioBuffer[];
  clipDecay: Float64Array;
  pairs: AudioBuffer[];
  pairPeak: Float64Array;
  pairDecay: Float64Array;
  pairBands: Float64Array;
  free: AudioBuffer[];
  freePeak: Float64Array;
  freeDecay: Float64Array;
  freeBands: Float64Array;
  /** Mass per ACOUSTIC_TYPES index, kg. */
  typeMass: Float64Array;
}

/** Envelope rate of a buffer (peak 1): ln(1000) over the time of the last sample above −60 dB. */
function envDecay(x: Float32Array, rate: number): number {
  let last = 0;
  for (let i = x.length - 1; i >= 0; i--) if (x[i] > 1e-3 || x[i] < -1e-3) { last = i; break; }
  return Math.log(1000) / Math.max(0.01, last / rate);
}

/**
 * Copy the bank into AudioBuffers. Nothing returned refers to the bank, so once the caller drops it the Float32
 * sample arrays (~4.6 MB) are garbage and only the AudioBuffers' own copy remains.
 */
function buildBuffers(ctx: BaseAudioContext, bank: SoundBank): Built {
  const rate = bank.rate;
  const mk = (data: Float32Array): AudioBuffer => {
    const b = ctx.createBuffer(1, data.length, rate);
    b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
    return b;
  };
  const clips = {} as Record<ClipId, AudioBuffer>;
  for (const id of CLIP_IDS) clips[id] = mk(bank.clips[id]);
  const bands = (list: readonly ModalBuffer[]): Float64Array => {
    const out = new Float64Array(list.length * NBANDS);
    list.forEach((p, i) => out.set(p.bands, i * NBANDS));
    return out;
  };
  return {
    rate,
    bytes: bank.bytes,
    bakeMs: bank.bakeMs,
    noise: mk(bank.noise),
    rumble: mk(bank.rumble),
    fan: mk(bank.fan),
    hum: mk(bank.hum),
    clips,
    clipList: CLIP_IDS.map((id) => clips[id]),
    clipDecay: Float64Array.from(CLIP_IDS, (id) => envDecay(bank.clips[id], rate)),
    pairs: bank.pairs.map((p) => mk(p.data)),
    pairPeak: Float64Array.from(bank.pairs, (p) => p.peak),
    pairDecay: Float64Array.from(bank.pairs, (p) => envDecay(p.data, rate)),
    pairBands: bands(bank.pairs),
    free: bank.free.map((p) => mk(p.data)),
    freePeak: Float64Array.from(bank.free, (p) => p.peak),
    freeDecay: Float64Array.from(bank.free, (p) => envDecay(p.data, rate)),
    freeBands: bands(bank.free),
    typeMass: Float64Array.from(ACOUSTIC_TYPES, (t) => bank.mass[t]),
  };
}

/** The strike-point variant a contact with event index `seq` plays (allocation-free integer hash). */
export const strikeVariant = (seq: number): number => mix32(seq) % VARIANTS;
function mix32(x: number): number {
  let h = Math.imul(x ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Build the graph on `ctx` from a baked bank. The engine keeps no reference to `bank` (see buildBuffers). */
export function createAudioEngine(ctx: BaseAudioContext, ship: AudioShip, bank: SoundBank, opts: EngineOptions = {}): AudioEngine {
  return engineFrom(ctx, ship, buildBuffers(ctx, bank), opts);
}

function engineFrom(ctx: BaseAudioContext, ship: AudioShip, B: Built, opts: EngineOptions): AudioEngine {
  const clock = opts.now ?? null;
  const fansOn = opts.fansOn ?? true;
  const runX = (opts.hullLength ?? 32) / 2;
  const slots = new Slots();
  const clk = slots.f;
  const T = slots.f;
  const mixer = createMixer(ctx, slots);
  const nyq = ctx.sampleRate / 2;

  const noise = B.noise, rumble = B.rumble, fanBuf = B.fan, humBuf = B.hum;
  const clips = B.clips;
  const pairBufs = B.pairs, pairPeak = B.pairPeak, pairDecay = B.pairDecay, pairBands = B.pairBands;
  const freeBufs = B.free, freePeak = B.freePeak, freeDecay = B.freeDecay, freeBands = B.freeBands;
  const clipDecayOf = B.clipDecay;

  // ---- continuous sources
  const rcsBus = ctx.createGain();
  const rcsHP = ctx.createBiquadFilter();
  rcsHP.type = 'highpass'; rcsHP.frequency.value = 500; rcsHP.Q.value = 0.707;
  const rcsLP = ctx.createBiquadFilter();
  rcsLP.type = 'lowpass'; rcsLP.frequency.value = 5000; rcsLP.Q.value = 0.707;
  rcsBus.connect(rcsHP); rcsHP.connect(rcsLP);
  const rcsWire = new Wire(rcsLP, [mixer.struct], slots.f);
  const RCS_COMP = bandComp(ENBW_LP * (5000 - 500), nyq);
  const rcs: Loop[] = [];
  for (let k = 0; k < NCLUSTER; k++) {
    const p = ctx.createStereoPanner();
    p.pan.value = CLUSTER_PAN[k];
    rcs.push(new Loop(ctx, noise, p, 0.005, 0.53 * k, slots, [rcsBus])); // τ 5 ms: the 15 ms chamber rise
  }
  const engPan: StereoPannerNode[] = [];
  const engines: Loop[] = ship.engines.map((_, e) => {
    const p = ctx.createStereoPanner();
    engPan.push(p);
    return new Loop(ctx, rumble, p, 0.03, 0.37 * e, slots, [mixer.struct]);
  });
  const engPanS = engPan.map((p) => new Smooth(p.pan, 0.05, slots, 0.02));
  const aeroLPNode = ctx.createBiquadFilter();
  aeroLPNode.type = 'lowpass'; aeroLPNode.Q.value = 0.707; aeroLPNode.frequency.value = 1000;
  const aero = new Loop(ctx, noise, aeroLPNode, 0.1, 1.7, slots, [mixer.struct]);
  const aeroLP = new Smooth(aeroLPNode.frequency, 0.1, slots, 0.02);
  // fan: one loop, panned, into the air (and a quarter through its mount into the structure)
  const fanPan = ctx.createStereoPanner();
  const fanAirG = ctx.createGain();
  fanAirG.gain.value = 0;
  fanAirG.connect(mixer.air);
  const fanStructG = ctx.createGain();
  fanStructG.gain.value = FAN_STRUCT;
  fanStructG.connect(mixer.struct);
  const fan = new Loop(ctx, fanBuf, fanPan, 0.2, 0.11, slots, [fanAirG, fanStructG]);
  const fanAir = new Smooth(fanAirG.gain, 0.2, slots);
  const fanPanS = new Smooth(fanPan.pan, 0.1, slots, 0.02);
  // sliding / rolling
  const slideBP = ctx.createBiquadFilter();
  slideBP.type = 'bandpass'; slideBP.frequency.value = 1500; slideBP.Q.value = 0.7;
  const slidePan = ctx.createStereoPanner();
  slideBP.connect(slidePan);
  const slide = new Loop(ctx, noise, slideBP, 0.03, 0.9, slots);
  const slideWire = new Wire(slidePan, [mixer.struct], slots.f);
  const slidePanS = new Smooth(slidePan.pan, 0.05, slots, 0.02);
  const SLIDE_COMP = bandComp((Math.PI / 2) * (1500 / 0.7), nyq);
  // station machinery through the collar
  const humPan = ctx.createStereoPanner();
  const hum = new Loop(ctx, humBuf, humPan, 0.3, 0.29, slots, [mixer.struct]);
  const humPanS = new Smooth(humPan.pan, 0.1, slots, 0.02);
  const loops: Loop[] = [...rcs, ...engines, aero, fan, slide, hum];
  // Each loop's in-band ear pressure per unit of its target: the noise-bandwidth correction removed. Rumble (248–
  // 900 Hz), fan (≥ 150 Hz, mostly the 350 Hz family) and hum (≥ 240 Hz) lie above MASK_LO_HZ; the aero roar's
  // share above it depends on its cut-off and is computed each frame (F[AEROM], weight 0 here).
  const maskW = Float64Array.from(loops, (l) =>
    rcs.includes(l) ? 1 / RCS_COMP : l === slide ? 1 / SLIDE_COMP : l === aero ? 0 : 1);

  const voices = new VoicePool(ctx, [mixer.struct, mixer.air], slots.f);

  // ---- per-prop lookup tables
  const bodyType = ACOUSTIC_TYPES.indexOf('body');
  const propType = Int8Array.from(ship.props, (t) => ACOUSTIC_TYPES.indexOf(t));
  const typeMass = B.typeMass;
  const typeFriction = Float64Array.from(ACOUSTIC_TYPES, (t) => frictionOf(t));
  const typeMat = Int8Array.from(ACOUSTIC_TYPES, (t) => PROP_ACOUSTICS[t].contactMat);
  const typeR = Float64Array.from(ACOUSTIC_TYPES, (t) => PROP_ACOUSTICS[t].contactR);
  const surfIdx = (mat: number): number => (surfaceFor(mat) === SURFACES[0] ? 0 : 1);
  const roomIds = ship.rooms.map((r) => r.id);

  // ---- scratch (preallocated)
  const clusterP = new Float64Array(NCLUSTER);
  const engPrev = new Float64Array(ship.engines.length);
  const candBuf = new Int16Array(MAX_CAND); // buffer index within its kind
  const candKind = new Int8Array(MAX_CAND); // 0 pair, 1 free, 2 clip
  const candGain = new Float64Array(MAX_CAND); // peak pressure of the buffer as played (before the Hertz low-pass)
  const candLevel = new Float64Array(MAX_CAND); // the same after the low-pass (estimate): what reaches the ear
  const candWhen = new Float64Array(MAX_CAND);
  const candPan = new Float64Array(MAX_CAND);
  const candLP = new Float64Array(MAX_CAND);
  const candRoute = new Int8Array(MAX_CAND);
  const order = new Int16Array(MAX_CAND);
  let nCand = 0;
  const tokens = new Float64Array([EVENTS_PER_S_WARP]);
  const aeroState: AeroOut = { pOut: 0, mach: 0, delta: 0, fPeak: 0, pCabin: 0 };
  const clipIndex = {} as Record<ClipId, number>;
  CLIP_IDS.forEach((id, i) => { clipIndex[id] = i; });
  const clipList = B.clipList;

  // Per-frame scalars live in a Float64Array, not in closure variables: V8 boxes a double stored in a closure
  // slot (a HeapNumber per store), but a typed-array store is a raw write. Same for values passed between the
  // update's parts: they go through F, never as arguments.
  const F = new Float64Array(16);
  const NOW = 0, DT = 1, SIM = 2, WARP = 3, EX = 4, EY = 5, EZ = 6, RX = 7, RZ = 8, GATE = 9, SLW = 10, SLP = 11, FLOOR = 12, AEROM = 13;
  const room = new Int32Array([-1]);
  let lastRoomId = '';

  const panOf = (x: number, y: number, z: number): number => {
    const dx = x - F[EX], dy = y - F[EY], dz = z - F[EZ];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return d > 1e-3 ? (dx * F[RX] + dz * F[RZ]) / d : 0;
  };
  const distOf = (x: number, y: number, z: number): number => {
    const dx = x - F[EX], dy = y - F[EY], dz = z - F[EZ];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };
  const whenOf = (t: number): number => {
    const w = F[WARP], dt = F[DT];
    let off = dt - (F[SIM] - t) / (w > 1e-9 ? w : 1e-9);
    if (off < 0) off = 0; else if (off > dt) off = dt;
    return F[NOW] + off;
  };
  /** Fraction of a modal buffer's peak that a 2nd-order low-pass at `lp` leaves (from its octave-band energies). */
  const lpLeft = (bands: Float64Array, i: number, lp: number): number => {
    if (lp >= 20000) return 1;
    let e = 0;
    const o = i * NBANDS;
    for (let b = 0; b < NBANDS; b++) {
      const r = (BAND_F0 * 1.4142 * (1 << b)) / lp;
      e += bands[o + b] / (1 + r * r * r * r);
    }
    return Math.sqrt(e);
  };
  const push = (kind: number, buf: number, gain: number, level: number, when: number, pan: number, lp: number, route: number): void => {
    if (level < F[FLOOR] || nCand >= MAX_CAND) return;
    candKind[nCand] = kind; candBuf[nCand] = buf; candGain[nCand] = gain; candLevel[nCand] = level; candWhen[nCand] = when;
    candPan[nCand] = pan; candLP[nCand] = lp; candRoute[nCand] = route;
    nCand++;
  };
  const clipCand = (id: ClipId, gain: number, e: SimEvent, route: number): void => {
    const p = e.pos;
    const hasPos = p.x !== 0 || p.y !== 0 || p.z !== 0;
    push(2, clipIndex[id], gain, gain, whenOf(e.t), hasPos ? panOf(p.x, p.y, p.z) : 0, 20000, route);
  };
  /** One body's own ring after a contact with another loose body (`free` buffers; no panel was struck). */
  const freeCand = (ti: number, J: number, v: number, att: number, when: number, pan: number, lp: number): void => {
    const fi = freeSlot(ti, v);
    const g = K_IMPACT * (J / Math.sqrt(typeMass[ti])) * freePeak[fi] * att;
    push(1, fi, g, g * lpLeft(freeBands, fi, lp), when, pan, lp, 1);
  };

  const onEvent = (e: SimEvent, seq: number): void => {
    const p = e.pos;
    switch (e.kind) {
      case 'slide': {
        const ti = e.a >= 0 && e.a < propType.length ? propType[e.a] : e.a === BODY_CREW ? bodyType : -1;
        const mu = ti >= 0 ? typeFriction[ti] : 0.4;
        const w = mu * (e.J > 0 ? e.J : 0) * (e.vn > 0 ? e.vn : -e.vn) * airAtt(distOf(p.x, p.y, p.z));
        F[SLW] += w;
        F[SLP] += w * panOf(p.x, p.y, p.z);
        return;
      }
      case 'contact': {
        let a = e.a, b = e.b, matB = e.matB;
        if (a < 0 && b >= 0) { a = e.b; b = e.a; matB = e.matA; }
        const ti = a >= 0 && a < propType.length ? propType[a] : a === BODY_CREW ? bodyType : -1;
        if (ti < 0 || !(e.J > 0)) return;
        // the struck surface: the ship's panels (by material), or another loose body (a prop, the crew body)
        const onShip = b === BODY_SHIP;
        const tb = !onShip ? (b === BODY_CREW ? bodyType : b >= 0 && b < propType.length ? propType[b] : -1) : -1;
        const surfMat = onShip ? matB : tb >= 0 ? typeMat[tb] : matB;
        const m = typeMass[ti];
        let mStar = m;
        if (tb >= 0) { const mb = typeMass[tb]; mStar = (m * mb) / (m + mb); }
        const matA = MATERIALS[typeMat[ti]] ?? MATERIALS[MAT.polymer];
        const matS = MATERIALS[surfMat] ?? MATERIALS[MAT.aluminium];
        const tc = hertzContactTime(mStar, typeR[ti], contactModulus(matA, matS), e.vn > 0 ? e.vn : -e.vn);
        let lp = 1 / tc;
        if (lp > 20000) lp = 20000; else if (lp < 30) lp = 30;
        const att = airAtt(distOf(p.x, p.y, p.z));
        const when = whenOf(e.t), pan = panOf(p.x, p.y, p.z);
        const v = strikeVariant(seq); // strike point: the hit's own, not a run-time detune
        if (onShip) {
          const pi = pairSlot(ti, surfIdx(matB), v);
          const g = K_IMPACT * (e.J / Math.sqrt(m)) * pairPeak[pi] * att;
          push(0, pi, g, g * lpLeft(pairBands, pi, lp), when, pan, lp, 0);
        } else {
          // two loose bodies: each rings with its own modes (the same impulse J acts on both)
          freeCand(ti, e.J, v, att, when, pan, lp);
          if (tb >= 0) freeCand(tb, e.J, v, att, when, pan, lp);
        }
        return;
      }
      case 'jetOn':
      case 'jetOff': {
        const j = e.a;
        const jet = j >= 0 && j < ship.jets.length ? ship.jets[j] : null;
        const F = e.J > 0 ? e.J : jet ? jet.thrust : 0;
        const jp = jet ? jet.pos : p;
        const g = (G_VALVE * F) / JET_REF_N * structAtt(distOf(jp.x, jp.y, jp.z)) * (e.kind === 'jetOn' ? 1 : 0.6);
        push(2, clipIndex[e.kind === 'jetOn' ? 'valveOpen' : 'valveClose'], g, g, whenOf(e.t), panOf(jp.x, jp.y, jp.z), 20000, 0);
        return;
      }
      case 'boot': case 'bootOff': case 'detent': case 'toggle': case 'plunger': case 'breaker': case 'creak': {
        const mc = MECH[e.kind];
        const E = e.J > 0 ? e.J : mc.e0;
        const d = p.x !== 0 || p.y !== 0 || p.z !== 0 ? distOf(p.x, p.y, p.z) : 0.6;
        clipCand(mc.clip, mc.g * Math.sqrt(E / mc.e0) * (e.kind === 'creak' ? structAtt(d) : airAtt(d)), e, 0);
        return;
      }
      case 'latch': case 'capture': case 'undock': {
        const J = e.J > 0 ? e.J : J_LATCH;
        const d = p.x !== 0 || p.y !== 0 || p.z !== 0 ? distOf(p.x, p.y, p.z) : distOf(ship.dockingPort.x, ship.dockingPort.y, ship.dockingPort.z);
        clipCand('latch', ((G_LATCH * J) / J_LATCH) * (e.kind === 'undock' ? 0.7 : 1) * structAtt(d), e, 0);
        return;
      }
    }
  };

  const stats: AudioStats = { updateMs: 0, started: 0, dropped: 0, stolen: 0, writes: 0, awake: 0, bufferBytes: B.bytes, bakeMs: B.bakeMs };
  let analyserNode: AnalyserNode | null = null;
  const smooths: Smooth[] = [mixer.airGain, mixer.boneGain, aeroLP, fanAir, fanPanS, slidePanS, humPanS, ...engPanS, ...loops.map((l) => l.level)];

  // ---- the per-frame parts. Small functions (so V8 optimises each whole), arithmetic written inline, values
  // passed through F and the parameter slots T, never as call arguments: nothing is boxed, nothing allocated.
  const aeroIO = new Float64Array(10);
  aeroIO[4] = runX;
  const rcsK = Int32Array.from(rcs, (l) => l.k);
  const engK = Int32Array.from(engines, (l) => l.k);
  const engPanK = Int32Array.from(engPanS, (sm) => sm.k);

  /** RCS flow hiss: per-jet u·F_j with the structure law 1/(1 + d/10), panned by azimuth; incoherent jets summed in power into 5 clusters. */
  const partRcs = (duty: Float64Array): void => {
    for (let k = 0; k < NCLUSTER; k++) clusterP[k] = 0;
    const jets = ship.jets;
    const nj = jets.length < duty.length ? jets.length : duty.length;
    const ex = F[EX], ey = F[EY], ez = F[EZ], rx = F[RX], rz = F[RZ];
    for (let j = 0; j < nj; j++) {
      const u = duty[j];
      if (!(u > 0)) continue;
      const jp = jets[j].pos;
      const dx = jp.x - ex, dy = jp.y - ey, dz = jp.z - ez;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const amp = (((u > 1 ? 1 : u) * jets[j].thrust) / JET_REF_N) / (1 + d / 10);
      const pan = d > 1e-3 ? (dx * rx + dz * rz) / d : 0;
      const x = (pan + 1) * 2; // 0..4 over the cluster grid
      let i = x | 0;
      if (i >= NCLUSTER - 1) i = NCLUSTER - 2;
      const wgt = x - i;
      clusterP[i] += amp * amp * (1 - wgt);
      clusterP[i + 1] += amp * amp * wgt;
    }
    const g = F[GATE] * G_HISS * RCS_COMP;
    let any = false;
    for (let k = 0; k < NCLUSTER; k++) {
      T[rcsK[k]] = g * Math.sqrt(clusterP[k]);
      if (rcs[k].needs()) rcs[k].sync();
      if (rcs[k].awake) any = true;
    }
    rcsWire.set(any);
  };

  /** Main drive: rumble ∝ F_s/F_max (the spool is heard because the level is the state); ignition when F_s crosses 1%. */
  const partEngines = (level: Float64Array): void => {
    const n = ship.engines.length;
    const ex = F[EX], ey = F[EY], ez = F[EZ], rx = F[RX], rz = F[RZ];
    for (let e = 0; e < n; e++) {
      const lvl = e < level.length ? level[e] : 0;
      const ep = ship.engines[e].pos;
      const dx = ep.x - ex, dy = ep.y - ey, dz = ep.z - ez;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const att = 1 / (1 + d / 10);
      const pan = d > 1e-3 ? (dx * rx + dz * rz) / d : 0;
      T[engK[e]] = lvl > 0 ? F[GATE] * G_RUMBLE * (lvl > 1 ? 1 : lvl) * att : 0;
      if (engines[e].needs()) engines[e].sync();
      if (engines[e].awake) { T[engPanK[e]] = pan; engPanS[e].sync(); }
      if (lvl >= 0.01 && engPrev[e] < 0.01) push(2, clipIndex.ignition, G_IGNITION * att, G_IGNITION * att, F[NOW], pan, 20000, 0);
      engPrev[e] = lvl;
    }
  };

  /** Aero roar through the skin (mass law); the cabin-air path is applied by the mixer. */
  const partAero = (f: AudioFrame): void => {
    const av = f.airVelocity;
    aeroIO[0] = f.dynamicPressure;
    aeroIO[1] = f.airDensity;
    aeroIO[2] = Math.sqrt(av.x * av.x + av.y * av.y + av.z * av.z);
    aeroIO[3] = f.soundSpeed;
    aeroRoarIO(aeroIO);
    const pc = aeroIO[9];
    if (pc > 0) {
      const fp = aeroIO[8];
      const fc = fp < 16000 ? (fp > 80 ? fp : 80) : 16000;
      const lastFc = aeroLP.last;
      if (!(lastFc === lastFc) || Math.abs(fc - lastFc) > 0.02 * fc) { T[aeroLP.k] = fc; aeroLP.sync(); }
      T[aero.k] = F[GATE] * pc * Math.sqrt(nyq / (ENBW_LP * fc));
      // the part of the roar's in-cabin pressure above MASK_LO_HZ (flat spectrum up to fc): what can mask a click
      F[AEROM] = fc > MASK_LO_HZ ? F[GATE] * pc * Math.sqrt((fc - MASK_LO_HZ) / fc) : 0;
    } else { T[aero.k] = 0; F[AEROM] = 0; }
    if (aero.needs()) aero.sync();
  };

  /** The head's room fan (declared on until W2-D's bus drives it): direct + reverberant field. And the station hum. */
  const partAmbience = (docked: boolean): void => {
    const ex = F[EX], ey = F[EY], ez = F[EZ], rx = F[RX], rz = F[RZ];
    const r = room[0];
    if (fansOn && r >= 0) {
      const fp = ship.rooms[r].fan;
      const dx = fp.x - ex, dy = fp.y - ey, dz = fp.z - ez;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const dd = d > 0.3 ? d : 0.3;
      T[fan.k] = F[GATE] * G_FAN * Math.sqrt((1 / (dd * dd) + 1) / 2);
      T[fanAir.k] = 1;
      if (fanAir.last !== 1) fanAir.sync();
      T[fanPanS.k] = d > 1e-3 ? (dx * rx + dz * rz) / d : 0;
      if (T[fanPanS.k] !== fanPanS.last) fanPanS.sync();
    } else T[fan.k] = 0;
    if (fan.needs()) fan.sync();
    const dp = ship.dockingPort;
    const dx = dp.x - ex, dy = dp.y - ey, dz = dp.z - ez;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    T[hum.k] = docked ? (F[GATE] * G_HUM) / (1 + d / 10) : 0;
    if (hum.needs()) hum.sync();
    if (hum.awake) {
      T[humPanS.k] = d > 1e-3 ? (dx * rx + dz * rz) / d : 0;
      if (T[humPanS.k] !== humPanS.last) humPanS.sync();
    }
  };

  /** Transients: order by loudness (insertion sort over indices), cap at 16 voices, decimate under warp. */
  const partTransients = (): void => {
    for (let i = 0; i < nCand; i++) {
      let j = i;
      const g = candLevel[i];
      while (j > 0 && candLevel[order[j - 1]] < g) { order[j] = order[j - 1]; j--; }
      order[j] = i;
    }
    const warped = F[WARP] > WARP_MUTE;
    let allowed = nCand < VOICES ? nCand : VOICES;
    if (warped) {
      let tk = tokens[0] + EVENTS_PER_S_WARP * F[DT];
      if (tk > EVENTS_PER_S_WARP) tk = EVENTS_PER_S_WARP;
      tokens[0] = tk;
      const whole = tk | 0;
      if (allowed > whole) allowed = whole;
    } else tokens[0] = EVENTS_PER_S_WARP;
    for (let k = 0; k < nCand; k++) {
      const i = order[k];
      if (k >= allowed) { stats.dropped++; continue; }
      const bi = candBuf[i], kd = candKind[i];
      const buf = kd === 0 ? pairBufs[bi] : kd === 1 ? freeBufs[bi] : clipList[bi];
      const dec = kd === 0 ? pairDecay[bi] : kd === 1 ? freeDecay[bi] : clipDecayOf[bi];
      const ok = voices.play(buf, candWhen[i], candGain[i], candLevel[i], candPan[i], candLP[i], candRoute[i], dec, F[NOW], F[FLOOR]);
      if (ok) { if (warped) tokens[0] -= 1; } else stats.dropped++;
    }
  };

  const countWrites = (): number => {
    let w = 0;
    for (let i = 0; i < smooths.length; i++) w += smooths[i].writes;
    return w;
  };

  const update = (f: AudioFrame, drainEvents?: (cb: (e: SimEvent, seq: number) => void) => void): void => {
    if (clock) stats.updateMs = clock();
    const w0 = countWrites();
    const dt = f.dt > 0 ? (f.dt < 0.25 ? f.dt : 0.25) : 0;
    clk[0] = ctx.currentTime;
    clk[1] = dt;
    F[NOW] = clk[0]; F[DT] = dt; F[SIM] = f.simTime; F[WARP] = f.warp;
    const c = f.crew;
    F[EX] = c.eye.x; F[EY] = c.eye.y; F[EZ] = c.eye.z;
    F[RX] = Math.cos(c.yaw); F[RZ] = -Math.sin(c.yaw); // head right = R_y(yaw)·(+X)
    F[GATE] = f.warp > WARP_MUTE ? 0 : 1;
    if (c.roomId !== lastRoomId) { lastRoomId = c.roomId; room[0] = roomIds.indexOf(c.roomId); }

    // paths: air ∝ cabin pressure (ρ ∝ p); bone while the body touches the structure
    const p = f.cabinPressure;
    T[mixer.airGain.k] = p > 0 ? (p < 2 * P0 ? p / P0 : 2) : 0;
    if (T[mixer.airGain.k] !== mixer.airGain.last) mixer.airGain.sync();
    T[mixer.boneGain.k] = c.posture === 'seated' || c.posture === 'lying' || c.gripped ? BONE_LEVEL : 0;
    if (T[mixer.boneGain.k] !== mixer.boneGain.last) mixer.boneGain.sync();

    partRcs(f.jetDuty);
    partEngines(f.engineLevel);
    partAero(f);
    partAmbience(f.docked);

    // Masking floor for transients: the threshold of hearing, or 20 dB under the steady noise now reaching the ear
    // above MASK_LO_HZ, whichever is higher. Each loop counts with its in-band pressure (its target gain without
    // the noise-bandwidth correction that only rescales a unit-RMS white loop), through whichever path is open.
    // Below the floor a hit is not built and a ringing voice is stopped: below perception is not built.
    let e2 = F[AEROM] * F[AEROM];
    for (let i = 0; i < loops.length; i++) { const v = T[loops[i].k] * maskW[i]; e2 += v * v; }
    const pathG = T[mixer.airGain.k] > T[mixer.boneGain.k] ? T[mixer.airGain.k] : T[mixer.boneGain.k];
    const fl = 0.1 * Math.sqrt(e2) * pathG;
    F[FLOOR] = fl > AUDIBLE ? fl : AUDIBLE;

    // transients from the ring
    nCand = 0;
    F[SLW] = 0; F[SLP] = 0;
    if (drainEvents) drainEvents(onEvent);
    const sw = F[SLW];
    T[slide.k] = sw > 0 ? F[GATE] * K_SLIDE * SLIDE_COMP * sw : 0;
    if (slide.needs()) slide.sync();
    slideWire.set(slide.awake);
    if (sw > 0) { T[slidePanS.k] = F[SLP] / sw; slidePanS.sync(); }
    if (nCand > 0) partTransients();
    voices.reap();
    // the two paths to the ear are plugged only while they carry anything
    mixer.airWire.set(T[mixer.airGain.k] > 0);
    mixer.boneWire.set(T[mixer.boneGain.k] > 0);

    let awake = 0;
    for (let i = 0; i < loops.length; i++) if (loops[i].awake) awake++;
    stats.writes = countWrites() - w0;
    stats.awake = awake;
    stats.started = voices.started;
    stats.stolen = voices.stolen;
    if (clock) stats.updateMs = clock() - stats.updateMs;
  };

  return {
    update,
    stats,
    mixer,
    analyser() {
      if (!analyserNode) {
        analyserNode = ctx.createAnalyser();
        analyserNode.fftSize = 2048;
        mixer.out.connect(analyserNode);
      }
      return analyserNode;
    },
    debug: {
      rcs, engines, aero, aeroLP, fanAir, fan, slide, hum, voices, buffers: clips, pairBuffers: pairBufs, freeBuffers: freeBufs,
      get floor(): number { return F[FLOOR]; },
      get aeroState(): AeroOut {
        aeroState.pOut = aeroIO[5]; aeroState.mach = aeroIO[6]; aeroState.delta = aeroIO[7]; aeroState.fPeak = aeroIO[8]; aeroState.pCabin = aeroIO[9];
        return aeroState;
      },
    },
    dispose() {
      clk[0] = ctx.currentTime; clk[1] = 10;
      for (const l of loops) { l.set(0); l.set(0); }
      try { mixer.out.disconnect(); } catch { /* ok */ }
    },
  };
}
