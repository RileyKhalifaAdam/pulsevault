// Honest exhaust, the pure core (SIMULATION.md W1-E items 1 and 2): RCS condensate puffs from the applied jet
// duty and the main plume's physical expansion in vacuum. No three.js, no DOM, no Math.random / Date.now; every
// per-frame path is allocation-free (typed arrays, preallocated scratch). The GPU side is plumes.ts.
//
// WIRING (wave 1, W1-E; nothing here is called yet):
//   * Per tick (game/session.ts, W1-A's 120 Hz loop): tapeRecord(tape, slot, c.jetDuty, n, world.tick) — see
//     world/dutyTape.ts. That tape is what makes the puffs independent of the frame rate and phase (every tick's
//     duty is replayed; a pulse that starts and ends inside one frame still makes its puff).
//   * scene.ts SceneManager owns one `PuffPool(PUFF_CAPACITY[quality])` and one `PuffRenderer` (plumes.ts). It
//     REPLACES the `fxm.rcsPuff(...)` loop in render() (the `fire < 0.25` threshold on `s.rcs`, the hot pinpoint and
//     EffectsManager.rcsPuff go). Per frame, while frame.warp ≤ 4:
//       pool.frame(tFrame, rCam, vCam, gAbs)       // tFrame = the extrapolated frame time (§1.3); r, v: any finite
//                                                  // free-fall reference near the camera (the player's extrapolated
//                                                  // abs state); g = Σ GM(rb − r)/|rb − r|³ at it, or 0
//       for each slot s with a craft: pool.consume(s, craftAtTick, view.jets, tape)
//     `craftAtTick` = {r: abs doubles, v, q, w (craft-axes body rate)} = the TICK STATE at t = tape.last[s]·Q (the
//     un-extrapolated world state the tape's last tick produced). Births are placed from it at their own tick times,
//     so frame extrapolation never offsets the puffs (no v·r error).
//     Then solvePuffFloor(pool, cam, sunDir, vis, budgetPx, occ, nOcc) (the CPU twin of the shader, O(live)) and
//     puffs.update(...) (plumes.ts WIRING), which hands pool.floorPhi to the shader.
//   * After a load: tapeReset for every slot and pool.reset() (both output-only: never saved; their loader
//     default is empty). A frame time that goes backwards by more than a tick also resets the pool by itself.
//   * The main plume: see plumes.ts (createPhysicalPlumes + setLevels(view.engineLevel) + setAmbient(p_a)).
//   * Tests: tests/plumes.test.ts. Harness: dev/harness/plumes.ts.
//
// The physics (SI; inertial axes unless stated):
//   Hydrazine exhaust (N₂, H₂, NH₃) is transparent. What is seen is condensate: unreacted propellant at the pulse
//   edges and a small steady fraction. Edges are crossings of 0 only (jets.ts jetEdgeMasks / the jetOn and jetOff
//   events): a duty held at 0.3 is ONE opening, not a valve cycling every tick. Per pulse, in seconds of full flow
//   ṁ = F/vₑ (S below), with ∫d·dt the propellant that actually passed (S_open):
//     opening (cold catalyst bed): ETA_BED of the flow in the first T_BED after the opening   → ≤ ETA_BED·S_open
//     steady: ETA_STEADY of the flow while open
//     closing (the dribble volume boiling out): min(T_DRIB, S_open − condensate so far)
//   so the condensate of a pulse never exceeds the propellant of that pulse (tested at every duty and length).
//   Each parcel leaves the nozzle at v + ω × r + f·vₑ·d̂ (d̂ uniform in solid angle inside a 30° cone, 60° for the
//   low-pressure dribble), then moves ballistically with NO drag. A parcel is a Gaussian blob of mass m and width
//   s(τ) = s₀ + w·τ, so its centre optical depth is τc = κm/(2π s²), κ = 3Q/(4aρ). Seen radiance:
//   L = E_sun · vis · ω₀ · p_HG(θ; g = 0.8) · (1 − e^(−τ)). In shadow (planet: vis; own hull: capsule occluders in
//   the vertex shader) nothing shows. A parcel ends, in closed form, when even fully forward-lit its centre falls
//   below the radiance floor F_MIN (≈ 1 LSB of a sunlit white hull); the shader clips every quad where its
//   radiance drops below that floor at its actual phase. When even that honest image would cover more than the
//   fill budget (PUFF_FILL_SCREENS of the target), solvePuffFloor raises the floor for that frame just enough
//   (the faint outskirts go first) — the GPU cost is bounded whatever the pool holds.
//   Particles live against an inertial anchor: a free-falling point (A, V, g) re-based at most every second,
//   so neither the player's translation nor the fx frame moves them.
//
//   Main plume in vacuum (a magnetic nozzle): the detached plasma expands as a cone of half-angle θ_d; the
//   number density is n(r, z) = ṁ/(m_i vₑ π R²)·exp(−r²/R²) with R(z) = r_e + z·tan θ_d, and the two-body
//   (recombination / bremsstrahlung) emissivity ε ∝ n². No absorption (optically thin), no turbulence (a
//   collisionless flow), no shock cells (no ambient pressure), no flicker. So brightness ∝ ṁ² and falls as R⁻³
//   down the plume: the length is not a parameter, it is where the expansion has thinned it out.

import type { V3, Quat } from '../../core/types';
import type { JetDef } from '../../world/jets';
import { DUTY_TAPE_JETS, DUTY_TAPE_LEN, DUTY_TAPE_SLOTS, tapeAt, type DutyTape } from '../../world/dutyTape';

// =============================================================================================== constants

/** The fixed simulation tick, s (SIMULATION §1.3). */
export const TICK = 1 / 120;

/** Henyey–Greenstein asymmetry of the condensate droplets (forward-scattering, plan value). */
export const HG_G = 0.8;
/** Single-scattering albedo of clear hydrazine / ammonia droplets. */
export const OMEGA0 = 0.98;
/** Droplet radius (m), density (kg/m³) and extinction efficiency: κ = 3Q/(4aρ) ≈ 747 m²/kg. */
export const DROP_A = 2e-6;
export const DROP_RHO = 1004;
export const DROP_Q = 2;
export const KAPPA = (3 * DROP_Q) / (4 * DROP_A * DROP_RHO);

/** Cold-bed window after an opening (s) and the unreacted fraction of the flow inside it. */
export const T_BED = 0.01;
export const ETA_BED = 0.5;
/** Dribble volume, in seconds of full flow (capped per pulse by the propellant that passed). */
export const T_DRIB = 0.005;
/** The dribble boils out over this long after the closing (s). */
export const DRIB_SPAN = 0.01;
/** Steady-state condensate mass fraction while open. */
export const ETA_STEADY = 0.002;
/** Mass per parcel, in seconds of full flow (a full opening at duty 1 makes ⌈ETA_BED·T_BED/T_PARCEL⌉ ≈ 10–11). */
export const T_PARCEL = 0.0005;
/** Emission budget: at most capacity·Q/PUFF_TURNOVER parcels per tick (beyond it: fewer, heavier; mass kept). */
export const PUFF_TURNOVER = 1.0;

/** Exit-speed fraction f of vₑ: opening transient (rising chamber pressure), dribble (flash boiling), steady. */
export const F_ON_LO = 0.3, F_ON_HI = 1.0;
export const F_OFF_LO = 0.03, F_OFF_HI = 0.15;
export const F_SS_LO = 0.92, F_SS_HI = 1.0;
/** Cone half-angles, rad: the plan's 30–60°: 30° for full-pressure flow, 60° for the low-pressure dribble spray. */
export const CONE_ON = (30 * Math.PI) / 180;
export const CONE_OFF = (60 * Math.PI) / 180;
/** A parcel's own spread rate as a fraction of the cone's lateral speed f·vₑ·sin θ. */
export const K_SPREAD = 0.3;

/**
 * Radiance floor per unit sun irradiance (render: L / E). A white Lambert hull face-on shows 1/π ≈ 0.32 of E, so the
 * floor is 3e-4 of it: about one 8-bit LSB of the encoded output near black. Nothing fainter is drawn.
 */
export const F_MIN = 1e-4;
/** Hard cap of a parcel's life (s): the fill cap keeps the GPU bounded anyway; this keeps the anchor math short. */
export const LIFE_MAX = 2;
/** The puffs' fill budget: covered pixels per frame as a fraction of the render target (≈ 0.05 ms on an A16 at
 *  ≥ 10 Gpx/s additive fp16 blend; an estimate, not measured on the device). */
export const PUFF_FILL_SCREENS = 0.3;
/** One parcel's quad covers at most this fraction of the fill budget (a cloud right at the lens takes its core only). */
export const PUFF_QUAD_SHARE = 0.25;

/** Nozzle sizing for s₀ (exit radius from thrust): chamber pressure, thrust coefficient, area ratio. */
export const RCS_PC = 1.0e6;
export const RCS_CF = 1.8;
export const RCS_AREA_RATIO = 50;

/** Anchor re-base limits: age (s) and distance from the reference (m). */
export const REBASE_T = 1.0;
export const REBASE_D = 2000;
/** Craft slots and jets per slot (the duty tape's). */
export const PUFF_SLOTS = DUTY_TAPE_SLOTS;
export const MAX_JETS = DUTY_TAPE_JETS;

export type PuffQuality = 'low' | 'medium' | 'high' | 'ultra';
export const PUFF_CAPACITY: Record<PuffQuality, number> = { low: 512, medium: 1024, high: 2048, ultra: 2048 };

/** Floats per parcel: b.xyz, t0 | u.xyz, tEnd | s0, w, K = κm/2π, kind. */
export const PUFF_STRIDE = 12;
export const PUFF_ON = 0, PUFF_OFF = 1, PUFF_STEADY = 2;

/** Death-time ledger for the O(1) live estimate: 64 buckets of 1/16 s (4 s ≥ LIFE_MAX + any replay lag). */
const LEDGER_N = 64;
const LEDGER_DT = 1 / 16;

// =============================================================================================== small pure helpers

/** Henyey–Greenstein phase function, sr⁻¹ (∫ over the sphere = 1); cosT = cos of the scattering angle. */
export function hgPhase(cosT: number, g = HG_G): number {
  const g2 = g * g;
  const d = 1 + g2 - 2 * g * cosT;
  return (1 - g2) / (4 * Math.PI * d * Math.sqrt(d));
}

/** The brightest phase (exact forward scatter). */
export const PHASE_MAX = hgPhase(1);

/**
 * Optical depth at which ω₀·p·vis·(1 − e^(−τ)) = φ·F_MIN for phase p (Infinity when even τ → ∞ is below it).
 * φ ≥ 1 is the frame's floor raise (PuffPool.solveFloor; 1 whenever the honest image fits the fill budget).
 */
export function tauFloor(phase: number, vis = 1, phi = 1): number {
  const q = (phi * F_MIN) / (OMEGA0 * phase * vis);
  return q < 1 ? -Math.log(1 - q) : Infinity;
}

/** The centre optical depth at which a parcel ends: below it nothing is visible even fully forward-lit. */
export const TAU_END = tauFloor(PHASE_MAX);

/** RCS nozzle exit radius from thrust (m): A_e = ε·F/(C_F·p_c). */
export function rcsExitRadius(thrust: number): number {
  return Math.sqrt((RCS_AREA_RATIO * thrust) / (RCS_CF * RCS_PC * Math.PI));
}

/** Closed-form parcel life (s): s(τ) = s0 + wτ until κm/(2π s²) = TAU_END, at most LIFE_MAX. 0: never visible. */
export function parcelLife(m: number, s0: number, w: number): number {
  const sEnd = Math.sqrt((KAPPA * m) / (2 * Math.PI * TAU_END));
  if (!(sEnd > s0)) return 0;
  const l = w > 1e-9 ? (sEnd - s0) / w : LIFE_MAX;
  return l < LIFE_MAX ? l : LIFE_MAX;
}

/** Counter hash → [0, 1) (32-bit avalanche of three integers; deterministic, allocation-free). */
export function hash01(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ Math.imul(c | 0, 0xc2b2ae3d);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Squared distance from the half-line p + t·s (t ≥ 0, s unit, up to `len`) to the segment a–b. Used for the hull's
 * own shadow on a parcel: the parcel is dark when this is < radius² of an occluder capsule (same test in GLSL).
 */
export function rayCapsuleDist2(px: number, py: number, pz: number, sx: number, sy: number, sz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, len = 1e4): number {
  const d1x = sx * len, d1y = sy * len, d1z = sz * len;
  const d2x = bx - ax, d2y = by - ay, d2z = bz - az;
  const rx = px - ax, ry = py - ay, rz = pz - az;
  const A = d1x * d1x + d1y * d1y + d1z * d1z;
  const E = d2x * d2x + d2y * d2y + d2z * d2z;
  const F = d2x * rx + d2y * ry + d2z * rz;
  const C = d1x * rx + d1y * ry + d1z * rz;
  const B = d1x * d2x + d1y * d2y + d1z * d2z;
  let s = 0, t = 0;
  if (E <= 1e-12) {
    s = A > 1e-12 ? clamp01(-C / A) : 0;
    t = 0;
  } else {
    const den = A * E - B * B;
    s = den > 1e-12 * (A * E + 1e-30) ? clamp01((B * F - C * E) / den) : 0;
    t = (B * s + F) / E;
    if (t < 0) { t = 0; s = A > 1e-12 ? clamp01(-C / A) : 0; } else if (t > 1) { t = 1; s = A > 1e-12 ? clamp01((B - C) / A) : 0; }
  }
  const qx = px + d1x * s - (ax + d2x * t), qy = py + d1y * s - (ay + d2y * t), qz = pz + d1z * s - (az + d2z * t);
  return qx * qx + qy * qy + qz * qz;
}


function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** The radiance a parcel's centre shows per unit sun irradiance (render units: same scale as albedo·E/π). */
export function parcelRadiance(tauCentre: number, cosScatter: number, sunVis: number): number {
  return sunVis * OMEGA0 * hgPhase(cosScatter) * (1 - Math.exp(-tauCentre));
}

// =============================================================================================== the puff pool

/** What the pool needs of an emitting craft: its TICK state (inertial doubles; body rate in craft axes). */
export interface PuffCraft {
  r: V3;
  v: V3;
  q: Quat;
  w: V3;
}

// burst parameter scratch slots (Float64Array, so no double is boxed through a call)
const B_T0 = 0, B_SPAN = 1, B_MP = 2, B_S0 = 3, B_TREF = 4, B_K = 5, B_KIND = 6, B_SLOT = 7, B_J = 8, B_N = 9, B_SCALE = 10;

/**
 * A fixed ring of condensate parcels stored against a free-falling anchor. Emission (consume) writes; the GPU
 * evaluates the ballistic positions; nothing per parcel is touched per frame except at a re-base (≤ once a second).
 */
export class PuffPool {
  readonly capacity: number;
  /** PUFF_STRIDE floats per parcel (uploaded as three vec4 instance attributes). */
  readonly data: Float32Array;
  /** Anchor: position, velocity at tA, gravity, epoch (doubles). Times in `data` are relative to tA. */
  readonly anchor = new Float64Array(10); // ax ay az vx vy vz gx gy gz tA
  private anchorSet = false;
  private cursor = 0;
  /** Latest tEnd (relative to tA) of anything alive; the renderer hides the mesh past it. */
  maxEnd = -Infinity;
  /** Dirty range of parcels to upload (lo > hi: nothing). Cleared by takeDirty(). */
  dirtyLo = Number.MAX_SAFE_INTEGER;
  dirtyHi = -1;
  /** Count of re-bases (a re-base dirties the whole live set) and of frames ignored for non-finite input. */
  rebases = 0;
  rejected = 0;
  /** Condensate written, kg, and parcels written by kind (all time; tests and the perf overlay). */
  massOut = 0;
  readonly countOut = new Float64Array(3);
  /** Fill control (solvePuffFloor): the floor raise φ, the honest fill and the drawn fill (px); its scratch. */
  floorPhi = 1;
  quadCapPx = Infinity;
  fillHonest = 0;
  fillPx = 0;
  readonly fillA: Float64Array;
  readonly fillL: Float64Array;
  /** Births not yet past their death bucket: an upper bound of the parcels alive (O(1)); see liveBound. */
  liveEstimate = 0;
  // per slot × jet replay state
  private readonly prevOn = new Uint8Array(PUFF_SLOTS * MAX_JETS);
  private readonly bedLeft = new Float64Array(PUFF_SLOTS * MAX_JETS);
  private readonly openS = new Float64Array(PUFF_SLOTS * MAX_JETS);
  private readonly condS = new Float64Array(PUFF_SLOTS * MAX_JETS);
  private readonly accSS = new Float64Array(PUFF_SLOTS * MAX_JETS);
  private readonly lastTick = new Float64Array(PUFF_SLOTS).fill(-1);
  private readonly epoch = new Float64Array(PUFF_SLOTS).fill(-1);
  // per tick scratch
  private readonly sOn = new Float64Array(MAX_JETS);
  private readonly bt = new Float64Array(MAX_JETS);
  private readonly sOff = new Float64Array(MAX_JETS);
  private readonly nOn = new Int32Array(MAX_JETS);
  private readonly nOff = new Int32Array(MAX_JETS);
  private readonly nSS = new Int32Array(MAX_JETS);
  private readonly bp = new Float64Array(11);
  private readonly sv = new Float64Array(24); // vector scratch
  private readonly ledger = new Float64Array(LEDGER_N);
  private ledgerAt = 0; // first bucket index not yet drained
  private tNow = 0;

  constructor(capacity = PUFF_CAPACITY.high) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * PUFF_STRIDE);
    this.fillA = new Float64Array(capacity);
    this.fillL = new Float64Array(capacity);
    this.reset();
  }

  /** Forget everything (after a load; the pool is output-only and never saved). */
  reset(): void {
    const D = this.data;
    D.fill(0);
    for (let i = 0; i < this.capacity; i++) D[i * PUFF_STRIDE + 7] = -1e9; // dead
    this.anchor.fill(0);
    this.anchorSet = false;
    this.cursor = 0;
    this.maxEnd = -Infinity;
    this.dirtyLo = 0; this.dirtyHi = this.capacity - 1;
    this.liveEstimate = 0;
    this.ledger.fill(0);
    this.ledgerAt = 0;
    this.tNow = 0;
    for (let s = 0; s < PUFF_SLOTS; s++) this.resetSlot(s);
  }

  /** Anchor position at absolute time t (doubles): A₀ + V₀Δ + ½gΔ². */
  anchorPos(t: number, out: V3): V3 {
    const a = this.anchor, d = t - a[9];
    out.x = a[0] + a[3] * d + 0.5 * a[6] * d * d;
    out.y = a[1] + a[4] * d + 0.5 * a[7] * d * d;
    out.z = a[2] + a[5] * d + 0.5 * a[8] * d * d;
    return out;
  }

  /** Anchor velocity at absolute time t. */
  anchorVel(t: number, out: V3): V3 {
    const a = this.anchor, d = t - a[9];
    out.x = a[3] + a[6] * d; out.y = a[4] + a[7] * d; out.z = a[5] + a[8] * d;
    return out;
  }

  /** The current time relative to the anchor epoch (the shader's uNow). */
  get now(): number {
    return this.tNow - this.anchor[9];
  }

  /**
   * Once per frame, before consume(): advance to frame time t; re-base the anchor onto (r, v, g) — any finite
   * free-fall reference near the camera — when the anchor is older than REBASE_T or farther than REBASE_D. A
   * re-base transforms every live parcel exactly (b' = b + ΔA − ΔV·(t − t0), u' = u + ΔV). Non-finite input is
   * ignored (counted in `rejected`); a time more than a tick before the last one resets the pool (a load).
   */
  frame(t: number, r: V3, v: V3, g: V3): void {
    if (!(Number.isFinite(t) && Number.isFinite(r.x + r.y + r.z) && Number.isFinite(v.x + v.y + v.z) && Number.isFinite(g.x + g.y + g.z))) {
      this.rejected++;
      return;
    }
    if (this.anchorSet && t < this.tNow - TICK) this.reset();
    this.tNow = t;
    // drain the live ledger (inlined: a double passed to a non-inlined call is boxed)
    {
      const upto = Math.floor(t / LEDGER_DT); // buckets < upto have all died
      if (upto - this.ledgerAt >= LEDGER_N) { this.ledger.fill(0); this.liveEstimate = 0; this.ledgerAt = upto; }
      while (this.ledgerAt < upto) {
        const b = ((this.ledgerAt % LEDGER_N) + LEDGER_N) % LEDGER_N;
        this.liveEstimate -= this.ledger[b];
        this.ledger[b] = 0;
        this.ledgerAt++;
      }
      if (this.liveEstimate < 0) this.liveEstimate = 0;
    }
    const a = this.anchor;
    if (!this.anchorSet) {
      this.setAnchor(t, r.x, r.y, r.z, v.x, v.y, v.z, g.x, g.y, g.z);
      return;
    }
    const sv = this.sv;
    const d = t - a[9];
    const Px = a[0] + a[3] * d + 0.5 * a[6] * d * d, Py = a[1] + a[4] * d + 0.5 * a[7] * d * d, Pz = a[2] + a[5] * d + 0.5 * a[8] * d * d;
    const dx = Px - r.x, dy = Py - r.y, dz = Pz - r.z;
    if (d < REBASE_T && d >= 0 && dx * dx + dy * dy + dz * dz < REBASE_D * REBASE_D) return;
    const dVx = a[3] + a[6] * d - v.x, dVy = a[4] + a[7] * d - v.y, dVz = a[5] + a[8] * d - v.z;
    sv[0] = dx; sv[1] = dy; sv[2] = dz; sv[3] = dVx; sv[4] = dVy; sv[5] = dVz;
    const D = this.data;
    let live = false;
    for (let i = 0; i < this.capacity; i++) {
      const o = i * PUFF_STRIDE;
      if (D[o + 7] < d) { D[o + 7] = -1e9; continue; } // dead: keep it dead in the new epoch
      const age = d - D[o + 3]; // t − t0 (< 0 for a parcel born after t)
      D[o] += sv[0] - sv[3] * age; D[o + 1] += sv[1] - sv[4] * age; D[o + 2] += sv[2] - sv[5] * age;
      D[o + 4] += sv[3]; D[o + 5] += sv[4]; D[o + 6] += sv[5];
      D[o + 3] -= d; D[o + 7] -= d;
      live = true;
    }
    this.maxEnd = live ? this.maxEnd - d : -Infinity;
    this.setAnchor(t, r.x, r.y, r.z, v.x, v.y, v.z, g.x, g.y, g.z);
    this.rebases++;
    this.dirtyLo = 0; this.dirtyHi = this.capacity - 1;
  }

  private setAnchor(t: number, rx: number, ry: number, rz: number, vx: number, vy: number, vz: number, gx: number, gy: number, gz: number): void {
    const a = this.anchor;
    a[0] = rx; a[1] = ry; a[2] = rz; a[3] = vx; a[4] = vy; a[5] = vz; a[6] = gx; a[7] = gy; a[8] = gz; a[9] = t;
    this.anchorSet = true;
  }

  /** Forget a slot's history (a craft left range or the slot was reassigned). */
  resetSlot(slot: number): void {
    this.lastTick[slot] = -1;
    this.epoch[slot] = -1;
    const o = slot * MAX_JETS;
    for (let j = 0; j < MAX_JETS; j++) { this.prevOn[o + j] = 0; this.bedLeft[o + j] = 0; this.openS[o + j] = 0; this.condS[o + j] = 0; this.accSS[o + j] = 0; }
  }

  /**
   * Emit the condensate of every tick of `slot` the tape holds since the last call, each at its own tick time.
   * `c` is the craft's TICK state at t = tape.last[slot]·Q. Returns the number of parcels written.
   */
  consume(slot: number, c: PuffCraft, jets: readonly JetDef[], tape: DutyTape): number {
    if (!(slot >= 0 && slot < PUFF_SLOTS) || slot !== (slot | 0)) throw new RangeError(`puff slot ${slot} (0..${PUFF_SLOTS - 1})`);
    const last = tape.last[slot];
    if (last < 0) return 0;
    if (!(Number.isFinite(c.r.x + c.r.y + c.r.z) && Number.isFinite(c.v.x + c.v.y + c.v.z) && Number.isFinite(c.w.x + c.w.y + c.w.z))) { this.rejected++; return 0; }
    const po = slot * MAX_JETS;
    const nj = Math.min(jets.length, tape.jets[slot]);
    if (tape.epoch[slot] !== this.epoch[slot]) {
      // a new tape epoch (first sight, a load, a slot reassignment): start from its seed, inventing no edge
      this.resetSlot(slot);
      this.epoch[slot] = tape.epoch[slot];
      this.lastTick[slot] = last - tape.count[slot];
      for (let j = 0; j < nj; j++) {
        const on = tape.seed[po + j] > 0;
        this.prevOn[po + j] = on ? 1 : 0;
        if (on) this.openS[po + j] = T_DRIB; // open since before we looked: assume a full dribble volume
      }
    }
    let k0 = this.lastTick[slot] + 1;
    const oldest = last - Math.min(tape.count[slot], DUTY_TAPE_LEN) + 1;
    if (k0 < oldest) {
      // the tape overflowed (a frame longer than DUTY_TAPE_LEN ticks): resync on its oldest tick without an edge
      const o = tapeAt(slot, oldest);
      for (let j = 0; j < nj; j++) { const on = tape.duty[o + j] > 0; if (on !== (this.prevOn[po + j] === 1)) { this.prevOn[po + j] = on ? 1 : 0; this.openS[po + j] = on ? T_DRIB : 0; this.condS[po + j] = 0; this.bedLeft[po + j] = 0; } }
      k0 = oldest + 1;
    }
    if (!this.anchorSet) this.setAnchor(last * TICK, c.r.x, c.r.y, c.r.z, c.v.x, c.v.y, c.v.z, 0, 0, 0);
    let n = 0;
    const bp = this.bp;
    bp[B_TREF] = last * TICK;
    for (let k = k0; k <= last; k++) { bp[B_K] = k; n += this.replayTick(slot, c, jets, nj, tape); }
    this.lastTick[slot] = last;
    return n;
  }

  /** One tick k = bp[B_K] of the tape (tick state at bp[B_TREF]): edges at 0 ↔ > 0 crossings only, masses capped by the flow that passed. */
  private replayTick(slot: number, c: PuffCraft, jets: readonly JetDef[], nj: number, tape: DutyTape): number {
    const po = slot * MAX_JETS;
    const k = this.bp[B_K];
    const to = tapeAt(slot, k);
    const sOn = this.sOn, bt = this.bt, sOff = this.sOff, nOn = this.nOn, nOff = this.nOff, nSS = this.nSS;
    let need = 0;
    for (let j = 0; j < nj; j++) {
      const d = tape.duty[to + j];
      const i = po + j;
      const on = d > 0;
      sOn[j] = 0; bt[j] = 0; sOff[j] = 0; nSS[j] = 0;
      if (on) {
        if (this.prevOn[i] === 0) { this.bedLeft[i] = T_BED; this.openS[i] = 0; this.condS[i] = 0; this.accSS[i] = 0; }
        this.openS[i] += d * TICK;
        const b = this.bedLeft[i] < TICK ? this.bedLeft[i] : TICK;
        if (b > 0) { this.bedLeft[i] -= b; bt[j] = b; sOn[j] = ETA_BED * d * b; this.condS[i] += sOn[j]; }
        const acc = this.accSS[i] + (ETA_STEADY * d * TICK) / T_PARCEL;
        const m = Math.floor(acc);
        this.accSS[i] = acc - m;
        nSS[j] = m;
        this.condS[i] += m * T_PARCEL;
      } else if (this.prevOn[i] === 1) {
        const avail = this.openS[i] - this.condS[i];
        sOff[j] = avail <= 0 ? 0 : avail < T_DRIB ? avail : T_DRIB;
        this.openS[i] = 0; this.condS[i] = 0; this.bedLeft[i] = 0;
      }
      this.prevOn[i] = on ? 1 : 0;
      nOn[j] = sOn[j] > 0 ? Math.ceil(sOn[j] / T_PARCEL - 1e-9) : 0;
      nOff[j] = sOff[j] > 0 ? Math.ceil(sOff[j] / T_PARCEL - 1e-9) : 0;
      need += nOn[j] + nOff[j] + nSS[j];
    }
    if (need === 0) return 0;
    // over the pool's turnover budget: fewer, heavier parcels (mass conserved)
    const budget = (this.capacity * TICK) / PUFF_TURNOVER;
    const tk = (k - 1) * TICK;
    const bp = this.bp;
    bp[B_SCALE] = need > budget ? budget / need : 1;
    bp[B_SLOT] = slot;
    let n = 0;
    for (let j = 0; j < nj; j++) {
      if (nOn[j] + nOff[j] + nSS[j] === 0) continue;
      const J = jets[j];
      const mdot = J.thrust / J.ve;
      bp[B_S0] = 0.5 * rcsExitRadius(J.thrust); bp[B_J] = j;
      if (nOn[j]) { bp[B_KIND] = PUFF_ON; bp[B_T0] = tk; bp[B_SPAN] = bt[j]; bp[B_N] = nOn[j]; bp[B_MP] = mdot * sOn[j]; n += this.burst(c, J); }
      if (nOff[j]) { bp[B_KIND] = PUFF_OFF; bp[B_T0] = tk; bp[B_SPAN] = DRIB_SPAN; bp[B_N] = nOff[j]; bp[B_MP] = mdot * sOff[j]; n += this.burst(c, J); }
      if (nSS[j]) { bp[B_KIND] = PUFF_STEADY; bp[B_T0] = tk; bp[B_SPAN] = TICK; bp[B_N] = nSS[j]; bp[B_MP] = mdot * nSS[j] * T_PARCEL; n += this.burst(c, J); }
    }
    return n;
  }

  /**
   * Write the burst described by `bp` (B_MP holds the burst's TOTAL mass, kg). Every double travels through the
   * Float64Array scratch and every helper is inlined by hand: a double passed to a call that V8 does not inline is
   * boxed (a 16-byte heap number), which is what made the old 14-argument burst allocate ≈ 1 KB a frame.
   */
  private burst(c: PuffCraft, J: JetDef): number {
    const bp = this.bp, sv = this.sv;
    const want = bp[B_N], scale = bp[B_SCALE];
    const count = scale < 1 ? Math.max(1, Math.round(want * scale)) : want;
    const mp = bp[B_MP] / count;
    const kind = bp[B_KIND] | 0, k = bp[B_K] | 0, seed = (bp[B_SLOT] * 64 + bp[B_J]) | 0;
    const t0 = bp[B_T0], span = bp[B_SPAN], tRef = bp[B_TREF], s0 = bp[B_S0];
    this.massOut += bp[B_MP];
    const qx = c.q.x, qy = c.q.y, qz = c.q.z, qw = c.q.w;
    // jet position (0..2), exhaust direction (3..5) and ω × r (6..8) in craft axes, rotated in place to inertial
    const wl = J.pos;
    sv[0] = wl.x; sv[1] = wl.y; sv[2] = wl.z;
    sv[3] = J.dir.x; sv[4] = J.dir.y; sv[5] = J.dir.z;
    sv[6] = c.w.y * wl.z - c.w.z * wl.y; sv[7] = c.w.z * wl.x - c.w.x * wl.z; sv[8] = c.w.x * wl.y - c.w.y * wl.x;
    for (let b = 0; b < 9; b += 3) {
      const x = sv[b], y = sv[b + 1], z = sv[b + 2];
      const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
      sv[b] = x + qw * tx + (qy * tz - qz * ty);
      sv[b + 1] = y + qw * ty + (qz * tx - qx * tz);
      sv[b + 2] = z + qw * tz + (qx * ty - qy * tx);
    }
    const dx = sv[3], dy = sv[4], dz = sv[5];
    const nvx = c.v.x + sv[6], nvy = c.v.y + sv[7], nvz = c.v.z + sv[8];
    // an orthonormal basis about the exhaust direction
    let ex: number, ey: number, ez: number;
    if (Math.abs(dx) < 0.9) { ex = 0; ey = dz; ez = -dy; } else { ex = -dz; ey = 0; ez = dx; }
    const el = Math.sqrt(ex * ex + ey * ey + ez * ez);
    ex /= el; ey /= el; ez /= el;
    const fx = dy * ez - dz * ey, fy = dz * ex - dx * ez, fz = dx * ey - dy * ex;
    const cone = kind === PUFF_OFF ? CONE_OFF : CONE_ON;
    const cosC = Math.cos(cone), sinC = Math.sin(cone);
    const fLo = kind === PUFF_ON ? F_ON_LO : kind === PUFF_OFF ? F_OFF_LO : F_SS_LO;
    const fHi = kind === PUFF_ON ? F_ON_HI : kind === PUFF_OFF ? F_OFF_HI : F_SS_HI;
    const K = (KAPPA * mp) / (2 * Math.PI);
    const sEnd = Math.sqrt(K / TAU_END);
    const D = this.data;
    const a = this.anchor;
    const tA = a[9];
    let written = 0;
    for (let i = 0; i < count; i++) {
      const salt = (i * 4 + kind * 1024) | 0;
      const h1 = hash01(k, seed, salt), h2 = hash01(k, seed, salt + 1);
      const h3 = hash01(k, seed, salt + 2), h4 = hash01(k, seed, salt + 3);
      // uniform in solid angle inside the cone
      const ct = 1 - h1 * (1 - cosC), st = Math.sqrt(Math.max(0, 1 - ct * ct));
      const ph = 2 * Math.PI * h2;
      const cp = Math.cos(ph) * st, sp = Math.sin(ph) * st;
      const ux = dx * ct + ex * cp + fx * sp, uy = dy * ct + ey * cp + fy * sp, uz = dz * ct + ez * cp + fz * sp;
      const sp0 = (fLo + (fHi - fLo) * h3) * J.ve;
      const tb = t0 + span * h4;
      const w = K_SPREAD * sp0 * sinC;
      // parcelLife(mp, s0, w), inlined
      if (!(sEnd > s0)) continue;
      let life = w > 1e-9 ? (sEnd - s0) / w : LIFE_MAX;
      if (life > LIFE_MAX) life = LIFE_MAX;
      // birth position relative to the anchor: the craft's tick state carried to tb (first order) + jet offset
      const dtb = tb - tRef, da = tb - tA;
      const Ax = a[0] + a[3] * da + 0.5 * a[6] * da * da;
      const Ay = a[1] + a[4] * da + 0.5 * a[7] * da * da;
      const Az = a[2] + a[5] * da + 0.5 * a[8] * da * da;
      const AVx = a[3] + a[6] * da, AVy = a[4] + a[7] * da, AVz = a[5] + a[8] * da;
      const cur = this.cursor;
      const o = cur * PUFF_STRIDE;
      const rel0 = tb - tA;
      D[o] = c.r.x + c.v.x * dtb - Ax + sv[0];
      D[o + 1] = c.r.y + c.v.y * dtb - Ay + sv[1];
      D[o + 2] = c.r.z + c.v.z * dtb - Az + sv[2];
      D[o + 3] = rel0;
      D[o + 4] = nvx + ux * sp0 - AVx;
      D[o + 5] = nvy + uy * sp0 - AVy;
      D[o + 6] = nvz + uz * sp0 - AVz;
      D[o + 7] = rel0 + life;
      D[o + 8] = s0;
      D[o + 9] = w;
      D[o + 10] = K;
      D[o + 11] = kind;
      if (rel0 + life > this.maxEnd) this.maxEnd = rel0 + life;
      if (cur < this.dirtyLo) this.dirtyLo = cur;
      if (cur > this.dirtyHi) this.dirtyHi = cur;
      this.cursor = cur + 1 === this.capacity ? 0 : cur + 1;
      // the live ledger: one more parcel until its death bucket
      const bi = Math.floor((tb + life) / LEDGER_DT);
      if (bi >= this.ledgerAt) {
        this.ledger[((bi % LEDGER_N) + LEDGER_N) % LEDGER_N]++;
        this.liveEstimate++;
      }
      written++;
    }
    this.countOut[kind] += written;
    return written;
  }

  /** Hand the dirty range to the uploader and clear it: returns [lo, count] in parcels (count 0: nothing). */
  takeDirty(out: Int32Array): Int32Array {
    if (this.dirtyHi < this.dirtyLo) { out[0] = 0; out[1] = 0; return out; }
    out[0] = this.dirtyLo; out[1] = this.dirtyHi - this.dirtyLo + 1;
    this.dirtyLo = Number.MAX_SAFE_INTEGER; this.dirtyHi = -1;
    return out;
  }

  /** min(liveEstimate, capacity) ≥ the parcels alive now: the shader's fill cap divides the budget by it. */
  get liveBound(): number {
    return this.liveEstimate < this.capacity ? this.liveEstimate : this.capacity;
  }

  /** True while anything may still be visible. */
  get alive(): boolean {
    return this.now <= this.maxEnd;
  }

  /** Count of parcels alive now (tests, perf overlay; O(capacity)). */
  liveCount(): number {
    const rel = this.now;
    let n = 0;
    for (let i = 0; i < this.capacity; i++) {
      const o = i * PUFF_STRIDE;
      if (this.data[o + 3] <= rel && this.data[o + 7] >= rel) n++;
    }
    return n;
  }

  /** Parcel i's position relative to the anchor at the current time (CPU twin of the vertex shader). */
  parcelPos(i: number, out: V3): V3 {
    const o = i * PUFF_STRIDE, D = this.data, tau = this.now - D[o + 3];
    out.x = D[o] + D[o + 4] * tau; out.y = D[o + 1] + D[o + 5] * tau; out.z = D[o + 2] + D[o + 6] * tau;
    return out;
  }
}

/** out = q·(x, y, z). */
function rot(out: V3, qx: number, qy: number, qz: number, qw: number, x: number, y: number, z: number): V3 {
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

// =============================================================================================== the shader's CPU twin

/** A camera for the twin: position (anchor-relative), unit right / up / forward, pixels per unit of x/depth. */
export interface PuffCam {
  p: V3;
  right: V3;
  up: V3;
  fwd: V3;
  /** 0.5 · drawing-buffer height · projectionMatrix[5] (= 1/tan(fov/2)). */
  px: number;
  shutter: number;
}

/**
 * The quad the vertex shader draws for parcel i (same arithmetic) with floor raise φ: returns its covered pixels
 * (0 when collapsed: not born, dead, in the hull's or planet's shadow, below the floor, behind the camera) and writes
 * to out[0] the clip radius in σ, out[1] the centre radiance per unit irradiance, out[2] the quad's pixels per unit
 * x² (4·σx·σy in px²) and out[3] ln(τc/τ_floor) at φ = 1 (the solver's inputs).
 */
export function puffQuadPx(pool: PuffPool, i: number, cam: PuffCam, sunDir: V3, vis: number, phi: number, occ: Float32Array | null, nOcc: number, out: Float64Array, quadCapPx = Infinity): number {
  out[0] = 0; out[1] = 0; out[2] = 0; out[3] = -1;
  const D = pool.data, o = i * PUFF_STRIDE;
  const tau = pool.now - D[o + 3];
  if (tau < 0 || pool.now > D[o + 7] || !(vis > 0)) return 0;
  const px = D[o] + D[o + 4] * tau, py = D[o + 1] + D[o + 5] * tau, pz = D[o + 2] + D[o + 6] * tau;
  for (let k = 0; occ && k < nOcc; k++) {
    const b = k * 8;
    if (rayCapsuleDist2(px, py, pz, sunDir.x, sunDir.y, sunDir.z, occ[b], occ[b + 1], occ[b + 2], occ[b + 4], occ[b + 5], occ[b + 6]) < occ[b + 3] * occ[b + 3]) return 0;
  }
  const rx = px - cam.p.x, ry = py - cam.p.y, rz = pz - cam.p.z;
  const depth = rx * cam.fwd.x + ry * cam.fwd.y + rz * cam.fwd.z;
  if (depth < 1e-3) return 0;
  const dist = Math.sqrt(rx * rx + ry * ry + rz * rz);
  const ct = (sunDir.x * rx + sunDir.y * ry + sunDir.z * rz) / dist; // dot(−sunDir, view), view = (cam − p)/|·|
  const phase = hgPhase(ct);
  // smear: image-plane motion over the shutter, in metres at the parcel's depth
  const vx = D[o + 4], vy = D[o + 5], vz = D[o + 6];
  const vr = vx * cam.right.x + vy * cam.right.y + vz * cam.right.z, vu = vx * cam.up.x + vy * cam.up.y + vz * cam.up.z;
  const vf = vx * cam.fwd.x + vy * cam.fwd.y + vz * cam.fwd.z;
  const xr = rx * cam.right.x + ry * cam.right.y + rz * cam.right.z, xu = rx * cam.up.x + ry * cam.up.y + rz * cam.up.z;
  const mx = vr - (vf * xr) / depth, my = vu - (vf * xu) / depth;
  const l = Math.sqrt(mx * mx + my * my) * cam.shutter;
  const s = D[o + 8] + D[o + 9] * tau;
  const sa = Math.sqrt(s * s + (l * l) / 12);
  const tc = D[o + 10] / (s * sa);
  const sPx = (s * cam.px) / depth, saPx = (sa * cam.px) / depth;
  out[2] = 4 * sPx * saPx;
  const t1 = tauFloor(phase, vis);
  out[3] = t1 < Infinity ? Math.log(tc / t1) : -1;
  const tm = phi === 1 ? t1 : tauFloor(phase, vis, phi);
  if (!(tc > tm)) return 0;
  let x2 = 2 * Math.log(tc / tm);
  const xq = quadCapPx / out[2];
  if (x2 > xq) x2 = xq;
  if (x2 > 9) x2 = 9;
  if (x2 < 0.01) return 0;
  out[0] = Math.sqrt(x2);
  out[1] = vis * OMEGA0 * phase * (1 - Math.exp(-tc));
  return out[2] * x2;
}

export function puffFillPx(pool: PuffPool, cam: PuffCam, sunDir: V3, vis: number, phi: number, occ: Float32Array | null, nOcc: number, scratch: Float64Array, quadCapPx = Infinity): number {
  let s = 0;
  for (let i = 0; i < pool.capacity; i++) s += puffQuadPx(pool, i, cam, sunDir, vis, phi, occ, nOcc, scratch, quadCapPx);
  return s;
}

const _q = new Float64Array(4);
/**
 * The frame's floor raise φ ≥ 1 (the shader's uFloor) and per-quad cap (uQuadCap = pool.quadCapPx, a
 * PUFF_QUAD_SHARE of the budget: a cloud at the lens draws its core only): φ = 1 while the honest image (everything
 * above F_MIN) covers at most `budgetPx` pixels; otherwise the smallest φ that brings the fill down to the budget — the faintest outskirts
 * go first, the bright cores stay. Evaluates the shader twin once per live parcel (O(live), ≈ 50 ns each in node),
 * then bisects on ln φ with the conservative τ_floor(φ) ≈ φ·τ_floor(1) (true fill ≤ the solved one). The result is
 * written to pool.floorPhi, pool.fillHonest (px at φ = 1) and pool.fillPx (px drawn); scratch is the pool's own.
 */
export function solvePuffFloor(pool: PuffPool, cam: PuffCam, sunDir: V3, vis: number, budgetPx: number, occ: Float32Array | null, nOcc: number): number {
  const A = pool.fillA, Lg = pool.fillL;
  const qcap = PUFF_QUAD_SHARE * budgetPx;
  pool.quadCapPx = qcap;
  let n = 0, s0 = 0;
  const now = pool.now, D = pool.data;
  if (vis > 0 && pool.alive) {
    // the twin of the vertex shader, inlined (puffQuadPx at φ = 1; no call per parcel, so no boxed doubles)
    const cpx = cam.p.x, cpy = cam.p.y, cpz = cam.p.z, Rx = cam.right.x, Ry = cam.right.y, Rz = cam.right.z;
    const Ux = cam.up.x, Uy = cam.up.y, Uz = cam.up.z, Fx = cam.fwd.x, Fy = cam.fwd.y, Fz = cam.fwd.z;
    const sx = sunDir.x, sy = sunDir.y, sz = sunDir.z, sh = cam.shutter, cpix = cam.px;
    const g2 = HG_G * HG_G, hgA = (1 - g2) / (4 * Math.PI), hgB = 1 + g2, hg2 = 2 * HG_G;
    const fq = F_MIN / (OMEGA0 * vis);
    for (let i = 0; i < pool.capacity; i++) {
      const o = i * PUFF_STRIDE;
      if (D[o + 3] > now || D[o + 7] < now) continue;
      const tau = now - D[o + 3];
      const px = D[o] + D[o + 4] * tau, py = D[o + 1] + D[o + 5] * tau, pz = D[o + 2] + D[o + 6] * tau;
      let dark = false;
      for (let k = 0; occ && k < nOcc && !dark; k++) {
        const b = k * 8;
        dark = rayCapsuleDist2(px, py, pz, sx, sy, sz, occ[b], occ[b + 1], occ[b + 2], occ[b + 4], occ[b + 5], occ[b + 6]) < occ[b + 3] * occ[b + 3];
      }
      if (dark) continue;
      const rx = px - cpx, ry = py - cpy, rz = pz - cpz;
      const depth = rx * Fx + ry * Fy + rz * Fz;
      if (depth < 1e-3) continue;
      const ct = (sx * rx + sy * ry + sz * rz) / Math.sqrt(rx * rx + ry * ry + rz * rz);
      const dd = hgB - hg2 * ct;
      const q = fq / (hgA / (dd * Math.sqrt(dd)));
      if (!(q < 1)) continue;
      const vx = D[o + 4], vy = D[o + 5], vz = D[o + 6];
      const vf = vx * Fx + vy * Fy + vz * Fz;
      const mx = vx * Rx + vy * Ry + vz * Rz - (vf * (rx * Rx + ry * Ry + rz * Rz)) / depth;
      const my = vx * Ux + vy * Uy + vz * Uz - (vf * (rx * Ux + ry * Uy + rz * Uz)) / depth;
      const l2 = (mx * mx + my * my) * sh * sh;
      const s = D[o + 8] + D[o + 9] * tau;
      const sa = Math.sqrt(s * s + l2 / 12);
      const L = Math.log(D[o + 10] / (s * sa * -Math.log1p(-q)));
      if (!(L > 0.005)) continue;
      const a = (4 * s * sa * cpix * cpix) / (depth * depth);
      let x2 = 2 * L;
      if (x2 > qcap / a) x2 = qcap / a;
      if (x2 > 9) x2 = 9;
      if (x2 < 0.01) continue;
      s0 += a * x2;
      A[n] = a; Lg[n] = L; n++;
    }
  }
  pool.fillHonest = s0;
  let phi = 1, fill = s0;
  if (s0 > budgetPx) {
    // S(y) = Σ A_i·min(9, 2(L_i − y)) over L_i > y: decreasing in y = ln φ; S(max L) = 0
    let lo = 0, hi = 0;
    fill = 0;
    for (let i = 0; i < n; i++) if (Lg[i] > hi) hi = Lg[i];
    for (let it = 0; it < 16; it++) {
      const y = 0.5 * (lo + hi);
      let S = 0;
      for (let i = 0; i < n; i++) {
        let x2 = 2 * (Lg[i] - y);
        const xq = qcap / A[i];
        if (x2 > xq) x2 = xq;
        if (x2 > 0.01) S += A[i] * (x2 < 9 ? x2 : 9);
      }
      if (S > budgetPx) lo = y; else { hi = y; fill = S; }
    }
    phi = Math.exp(hi);
  }
  pool.floorPhi = phi;
  pool.fillPx = fill;
  return phi;
}

// =============================================================================================== hull occluders

/** A capsule in craft axes that shadows puffs: segment a–b, radius (kept inside the hull). */
export interface Occluder {
  a: V3;
  b: V3;
  radius: number;
}

/** The Wren's hull as two capsules inside its skin: the fuselage and the wing / pod span. */
export const WREN_OCCLUDERS: readonly Occluder[] = [
  { a: { x: 0, y: 0.1, z: -11.5 }, b: { x: 0, y: 0.1, z: 12.5 }, radius: 1.7 },
  { a: { x: -8.8, y: -0.3, z: 7.5 }, b: { x: 8.8, y: -0.3, z: 7.5 }, radius: 0.9 },
];

export const MAX_OCCLUDERS = 4;

/**
 * Pack occluders into the shader's vec4 pairs (a.xyz, radius | b.xyz, 0), in anchor-relative inertial axes:
 * p = (craft − anchor) + q·local. Returns the count. `out` holds 8·MAX_OCCLUDERS floats.
 */
const _occT = { x: 0, y: 0, z: 0 };
export function packOccluders(occ: readonly Occluder[], q: Quat, ox: number, oy: number, oz: number, out: Float32Array, start = 0): number {
  const t = _occT;
  let n = start;
  for (let i = 0; i < occ.length && n < MAX_OCCLUDERS; i++, n++) {
    const o = occ[i];
    rot(t, q.x, q.y, q.z, q.w, o.a.x, o.a.y, o.a.z);
    out[n * 8] = ox + t.x; out[n * 8 + 1] = oy + t.y; out[n * 8 + 2] = oz + t.z; out[n * 8 + 3] = o.radius;
    rot(t, q.x, q.y, q.z, q.w, o.b.x, o.b.y, o.b.z);
    out[n * 8 + 4] = ox + t.x; out[n * 8 + 5] = oy + t.y; out[n * 8 + 6] = oz + t.z; out[n * 8 + 7] = 0;
  }
  return n;
}

// =============================================================================================== main plume

/** Magnetic-nozzle detachment half-angle (tuning within the 10–20° such nozzles show), rad. */
export const PLUME_THETA = (15 * Math.PI) / 180;
/** The plume is bounded where the on-axis column has fallen to this fraction of the exit column. */
export const PLUME_END_FRACTION = 1e-4;
/** Reference engine for the radiance scale: the Wren's (400 kN at vₑ 34 km/s, exit radius 1.15 m). */
export const PLUME_MDOT_REF = 400e3 / 34e3;
export const PLUME_RE_REF = 1.15;

/** Plume radius at z (nozzle radii) downstream of the exit plane: R = 1 + z·tan θ. */
export function plumeRadius(z: number, tanTheta = Math.tan(PLUME_THETA)): number {
  return 1 + (z > 0 ? z : 0) * tanTheta;
}

/**
 * Relative emissivity at (r, z) in nozzle radii for unit ṁ²: ε = n², n = exp(−r²/R²)/R². Optically thin.
 * In air `cell` (nozzle radii, from shockCellSpacing/r_e) adds the standing cells; 0 in vacuum.
 */
export function plumeEmissivity(r: number, z: number, tanTheta = Math.tan(PLUME_THETA), cell = 0): number {
  const R = plumeRadius(z, tanTheta);
  const n = Math.exp(-(r * r) / (R * R)) / (R * R);
  let e = n * n;
  if (cell > 0 && z > 0) { const c = Math.cos((Math.PI * z) / cell); e *= 0.4 + 1.2 * c * c; }
  return e;
}

/**
 * The transverse column through the axis at z, in units of the exit column: ∫ε dx across the plume
 * ∝ ∫exp(−2x²/R²)/R⁴ dx = √(π/2)/R³. So the plume dims as R⁻³ — its length emerges from the expansion.
 */
export function plumeAxisColumn(z: number, tanTheta = Math.tan(PLUME_THETA)): number {
  const R = plumeRadius(z, tanTheta);
  return 1 / (R * R * R);
}

/** Visible length in nozzle radii: where the column has fallen to PLUME_END_FRACTION. */
export function plumeLength(tanTheta = Math.tan(PLUME_THETA), frac = PLUME_END_FRACTION): number {
  return (Math.pow(frac, -1 / 3) - 1) / tanTheta;
}

/**
 * Exit-column radiance factor of one engine relative to the reference engine at full thrust:
 * (ṁ/ṁ_ref)²·(r_ref/r_e)³ with ṁ = level·F_max/vₑ. Brightness from mass flow, no spool of its own.
 */
export function plumeExitFactor(level: number, maxThrust: number, ve: number, re: number): number {
  const l = level < 0 ? 0 : level > 1 ? 1 : level;
  const m = (l * maxThrust) / ve / PLUME_MDOT_REF;
  const k = PLUME_RE_REF / re;
  return m * m * k * k * k;
}

/** Hull-glow / audio level from per-engine levels: the mean of the levels (no lag of its own). */
export function plumeGlowLevel(levels: ArrayLike<number>, n = levels.length): number {
  if (n <= 0) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += levels[i];
  return s / n;
}

/**
 * Shock-cell spacing (m) of an under/over-expanded jet in air: 1.3·D_e·√(p_e/p_a). In vacuum (p_a ≤ 0) there are
 * no cells: returns 0 (the plume expands freely). W3-E finishes the air shape.
 */
export function shockCellSpacing(De: number, pe: number, pa: number): number {
  if (!(pa > 0) || !(pe > 0)) return 0;
  return 1.3 * De * Math.sqrt(pe / pa);
}

/** Static exit pressure of the detached plume (Pa): sets the cells in air only (a W3-E estimate). */
export const PLUME_PE = 3e3;

/**
 * The shader's cell spacing in nozzle radii for ambient pressure p_a (Pa): shockCellSpacing(2r_e, p_e, p_a)/r_e =
 * 2.6·√(p_e/p_a), the same for every nozzle size. 0 in vacuum.
 */
export function plumeCellRadii(pa: number, pe = PLUME_PE): number {
  return shockCellSpacing(2, pe, pa);
}
