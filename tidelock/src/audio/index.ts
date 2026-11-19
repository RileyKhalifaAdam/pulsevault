// TIDELOCK sound (docs/SIMULATION.md W1-D): every sound has a physical cause in the simulation state.
//
// ── Wiring (W1-A, wave 1: the one hook in app.ts) ─────────────────────────────────────────────────────────────
//
//   import { attachAudio, audioShipFromData, createAudioFrame, fillAudioFrame } from '../audio';
//
//   // once, at boot (bakes 4.6 MB of buffers in 2 ms slices in the background; no sound, no AudioContext yet):
//   const audio = attachAudio(audioShipFromData('wren', craft.jets, craft.engines));   // JetDef[] / EngineDef[]
//   const audioFrame = createAudioFrame(craft.jets.length, craft.engines.length);
//   const drain = (cb: Parameters<typeof session.drainEvents>[0]) => session.drainEvents(cb);   // made once
//
//   // every frame, after session.step(dt):
//   const flight = session.flight();
//   fillAudioFrame(audioFrame, dt, { craft: playerCraftView, flight, warp: session.warp(), crew: session.crew(),
//                                    simTime: session.time(), primary: bodyDefOf(flight.primaryId) });
//   audio.update(audioFrame, drain);
//
// That is all. The first tap that lifts a finger (pointerup / touchend / click, capture phase on window) creates
// the AudioContext (48 kHz) and resumes it inside the gesture; before that `update` only drains and discards.
// `fillAudioFrame` reads the wave-1 view fields structurally (CraftView.jetDuty, engineLevel, airVelocity,
// heatFlux; FlightView.airDensity, dynamicPressure; WarpView.achieved; CrewView eye/yaw/posture/gripped/roomId),
// so it compiles against today's api.ts and picks the fields up as W1-A adds them. `primary` is the BodyDef of
// FlightView.primaryId (the speed of sound for the aero roar's Mach is derived from its isothermal atmosphere).
// Cabin pressure is the 101 325 Pa placeholder until W2-D's cabin gas (pass `cabinPressure`).
//
// Costs (measured, see tests/audio.e2e.cjs): bake ≈ 80–90 ms of work in Chromium x86 warm, 150 ms on the first
// (cold) run (≈ 0.16–0.3 s on the A16 by the ×2 rule), in ~40 slices of 2 ms (max 3–4 ms on a loaded machine)
// that run between frames after attachAudio, not behind the loading bar; buffers 5.1 MB, held once (the
// AudioBuffers: the baked Float32 arrays are released as soon as they are copied).
//
// ── Model ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Vacuum outside is silent: only the ship's own structure and cabin air carry sound. Structure-borne sources (jets,
// drive, aero roar, impacts on panels, boots, mechanisms, the station's machinery through the collar) reach the
// ear through the cabin air (gain ∝ cabin pressure) and, while seated or gripped, through the body (low-pass
// 300 Hz). Fans are air-borne. Continuous sources mute above 4× warp; events are decimated to ≤ 8 per second.
// Native nodes only (no AudioWorklet, no OfflineAudioContext); buffers are filled in plain JS (bake.ts, modal.ts).
//
// Budget: main thread ≤ 0.05 ms per frame; audio thread ≤ 5% of a core with W2-F; ~5 MB of buffers.
//
// Deferred: "landed, the ground conducts" (W1-D honesty). The wave-1 world has no ground-borne source to conduct
// (no ground body in the event ring, no surface machinery or weather), so there is nothing for a `landed` flag to
// gate; it returns with the first source that has a ground cause (a touchdown contact with a ground body id).

import type { SimEvent } from '../world/events';
import { PROPS } from '../data/props';
import { INTERIORS } from '../data/interiors';
import { SHIP_LAYOUTS } from '../data/shipLayouts';
import type { ShipVisualId, V3 } from '../core/types';
import { createBaker, type Baker, type SoundBank } from './bake';
import { BAKE_RATE } from './modal';
import { createUnlocker, type CtxState } from './context';
import { createAudioEngine, type AudioEngine, type EngineOptions } from './engine';
import { restFrame, type AudioFrame, type AudioShip, type Posture } from './types';

export type { AudioFrame, AudioShip, AudioCrew, Posture } from './types';
export type { AudioEngine, AudioStats } from './engine';
export { createAudioEngine } from './engine';
export { bakeAll, createBaker, pairSlot, freeSlot } from './bake';
export type { SoundBank } from './bake';

/** Placeholder jet thrust until W1-B's JetDef supplies it, N (the click law's reference). */
const DEFAULT_JET_N = 34e3;
/** Placeholder drive thrust per engine until W1-B's EngineDef supplies it, N. */
const DEFAULT_ENGINE_N = 400e3;

/**
 * The fixed ship description from the data files: jets and engines from W1-B's defs when given (`{pos, thrust}`
 * / `{pos, maxThrust}`), else from the ship layout with placeholder thrusts; one fan per room at the ceiling
 * centre; the docking collar; the props' types in PROPS order (the index the contact events carry).
 */
export function audioShipFromData(
  visual: ShipVisualId,
  jets?: readonly { pos: V3; thrust: number }[],
  engines?: readonly { pos: V3; maxThrust: number }[],
): AudioShip {
  const L = SHIP_LAYOUTS[visual];
  const interior = INTERIORS[visual];
  return {
    jets: jets ? jets.map((j) => ({ pos: { ...j.pos }, thrust: j.thrust })) : L.rcs.map((r) => ({ pos: { ...r.pos }, thrust: DEFAULT_JET_N })),
    engines: engines ? engines.map((e) => ({ pos: { ...e.pos }, maxThrust: e.maxThrust })) : L.engines.map((e) => ({ pos: { ...e.pos }, maxThrust: DEFAULT_ENGINE_N })),
    rooms: (interior?.rooms ?? []).map((r) => ({
      id: r.id,
      fan: { x: (r.box.min.x + r.box.max.x) / 2, y: r.box.max.y - 0.1, z: (r.box.min.z + r.box.max.z) / 2 },
    })),
    dockingPort: { ...L.dockingPort.pos },
    props: (PROPS[visual] ?? []).map((p) => p.type),
  };
}

/** A reusable frame (allocate once; `fillAudioFrame` writes into it every frame). */
export function createAudioFrame(nJets: number, nEngines: number): AudioFrame {
  return restFrame(nJets, nEngines);
}

/** The session views audio reads, structurally (wave-1 fields optional so this compiles before W1-A adds them). */
export interface AudioViews {
  craft: {
    jetDuty?: ArrayLike<number>;
    engineLevel?: ArrayLike<number>;
    airVelocity?: V3;
    heatFlux?: number;
    dockedTo: string | null;
  } | null;
  /** FlightView; `soundSpeed` (m/s) only if a later wave publishes one (W2-B's profile): it overrides `primary`. */
  flight: { airDensity: number; dynamicPressure: number; soundSpeed?: number } | null;
  warp: { achieved: number };
  crew: { eye: V3; yaw: number; posture: Posture; gripped: boolean; roomId: string } | null;
  simTime: number;
  /** Cabin pressure of the head's room, Pa (W2-D); default 101 325. */
  cabinPressure?: number;
  /** The primary body (BodyDef of FlightView.primaryId): its isothermal atmosphere gives the speed of sound. */
  primary?: PrimaryAir | null;
}

/** The fields of a BodyDef the speed of sound needs. */
export interface PrimaryAir {
  mu: number;
  radius: number;
  /** Isothermal atmosphere temperature, K (BodyDef.temperature, the T its scale height was built from). */
  temperature: number;
  atmosphere: { scaleHeight: number } | null;
}

/** Universal gas constant, J/(mol·K). */
const R_GAS = 8.314462618;

/**
 * Wave-1 speed of sound of the primary's air, m/s: the isothermal atmosphere has H = R·T/(M·g), so
 * a = √(γ·R·T/M) = √(γ·g·H), with g = μ/r² at the surface (W2-B's layered profile replaces it). γ by the gas the
 * molar mass M = R·T/(g·H) indicates: 1.30 for CO₂-rich air (M ≥ 35 g/mol, the rocky and desert classes), 1.40
 * for N₂/O₂ and H₂/He. 0 without an atmosphere.
 */
export function primarySoundSpeed(b: PrimaryAir | null | undefined): number {
  if (!b || !b.atmosphere || !(b.atmosphere.scaleHeight > 0) || !(b.radius > 0)) return 0;
  const g = b.mu / (b.radius * b.radius);
  const H = b.atmosphere.scaleHeight;
  const M = b.temperature > 0 ? (R_GAS * b.temperature) / (g * H) : 0.029;
  const gamma = M >= 0.035 ? 1.3 : 1.4;
  return Math.sqrt(gamma * g * H);
}

/** Copy the views into `out`, allocation-free. */
export function fillAudioFrame(out: AudioFrame, dt: number, v: AudioViews): AudioFrame {
  out.dt = dt;
  out.simTime = v.simTime;
  out.warp = v.warp.achieved;
  const c = v.craft;
  const jd = out.jetDuty, el = out.engineLevel;
  for (let i = 0; i < jd.length; i++) jd[i] = c?.jetDuty && i < c.jetDuty.length ? c.jetDuty[i] : 0;
  for (let i = 0; i < el.length; i++) el[i] = c?.engineLevel && i < c.engineLevel.length ? c.engineLevel[i] : 0;
  const av = c?.airVelocity;
  out.airVelocity.x = av ? av.x : 0; out.airVelocity.y = av ? av.y : 0; out.airVelocity.z = av ? av.z : 0;
  out.heatFlux = c?.heatFlux ?? 0;
  out.docked = !!c?.dockedTo;
  const f = v.flight;
  out.airDensity = f ? f.airDensity : 0;
  out.dynamicPressure = f ? f.dynamicPressure : 0;
  out.soundSpeed = f && f.soundSpeed !== undefined && f.soundSpeed > 0 ? f.soundSpeed : primarySoundSpeed(v.primary);
  out.cabinPressure = v.cabinPressure ?? 101325;
  const cr = v.crew;
  if (cr) {
    out.crew.eye.x = cr.eye.x; out.crew.eye.y = cr.eye.y; out.crew.eye.z = cr.eye.z;
    out.crew.yaw = cr.yaw;
    out.crew.posture = cr.posture;
    out.crew.gripped = cr.gripped;
    out.crew.roomId = cr.roomId;
  }
  return out;
}

export interface AudioHandle {
  /** Per frame. Before the context runs (or before the bake ends) it only drains and discards the events. */
  update(frame: AudioFrame, drainEvents?: (cb: (e: SimEvent, seq: number) => void) => void): void;
  /** 'none' until the first tap, then the AudioContext's state ('running', 'suspended', 'interrupted'…). */
  state(): CtxState;
  readonly baked: boolean;
  readonly engine: AudioEngine | null;
  readonly ctx: AudioContext | null;
  /** Bake statistics (valid once baked). */
  readonly bakeMs: number;
  readonly bufferBytes: number;
  /** Times the bank was baked again because the context did not run at BAKE_RATE (0 expected). */
  readonly rebakes: number;
  dispose(): void;
}

export interface AttachOptions extends EngineOptions {
  win?: Window;
  /** Wall-clock budget per bake slice, ms (default 2; a slice overruns it by at most one ~0.1 ms bake step). */
  bakeSliceMs?: number;
  /** AudioContext factory (tests). */
  createContext?: () => AudioContext;
}

const discard = (): void => { /* events before sound exists are dropped: output only */ };

/**
 * Attach sound to the page. Starts the background bake; arms the tap listeners; creates nothing audible until
 * the first finger lifts. Safe to call once at boot.
 */
export function attachAudio(ship: AudioShip, opts: AttachOptions = {}): AudioHandle {
  const win = opts.win ?? window;
  const perf = (): number => win.performance.now();
  const sliceMs = opts.bakeSliceMs ?? 2;
  // Bake at 48 kHz before any gesture; the context is requested at the same rate (context.ts). Only if the engine
  // refused it does the bank get baked again at the context's rate, in the same small slices, before building:
  // a buffer at a foreign rate is resampled on every play (about 2–8× a source's cost, measured in Chromium).
  // Nothing here holds the baker or the bank once the engine is built: the AudioBuffers are the only copy.
  let baker: Baker | null = createBaker(BAKE_RATE);
  let bank: SoundBank | null = null;
  let baked = false;
  let engine: AudioEngine | null = null;
  let ctx: AudioContext | null = null;
  let disposed = false;
  let timer = 0;
  let bakeMs = 0, bytes = 0, rebakes = 0;

  const build = (): void => {
    if (engine || !ctx || !bank) return;
    if (bank.rate !== ctx.sampleRate) {
      bank = null;
      baked = false;
      rebakes++;
      baker = createBaker(ctx.sampleRate);
      if (!timer) timer = win.setTimeout(slice, 0);
      return;
    }
    engine = createAudioEngine(ctx, ship, bank, opts);
    bank = null; // the AudioBuffers hold their own copies; let the Float32 arrays go
  };
  function slice(): void {
    timer = 0;
    if (disposed || !baker) return;
    if (baker.step(sliceMs, perf)) {
      bank = baker.bank();
      bakeMs += bank.bakeMs;
      bytes = bank.bytes;
      baker.release();
      baker = null;
      baked = true;
      build();
    } else timer = win.setTimeout(slice, 0);
  }
  timer = win.setTimeout(slice, 0);

  const unlock = createUnlocker({
    win,
    create: opts.createContext,
    onContext: (c) => { ctx = c; build(); },
  });

  return {
    update(frame, drainEvents) {
      if (engine && ctx && ctx.state === 'running') engine.update(frame, drainEvents);
      else if (drainEvents) drainEvents(discard);
    },
    state: () => unlock.state(),
    get baked() { return baked; },
    get engine() { return engine; },
    get ctx() { return ctx; },
    get bakeMs() { return bakeMs; },
    get bufferBytes() { return bytes; },
    get rebakes() { return rebakes; },
    dispose() {
      disposed = true;
      if (timer) win.clearTimeout(timer);
      baker?.release();
      baker = null;
      bank = null;
      engine?.dispose();
      unlock.dispose();
    },
  };
}
