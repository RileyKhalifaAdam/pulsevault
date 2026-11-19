// Honest exhaust, the pure core (SIMULATION.md W1-E items 1 and 2): RCS condensate puffs from the applied jet
// duty and the main plume's physical expansion in vacuum. No three.js, no DOM, no Math.random / Date.now; every
// per-frame path is allocation-free (typed arrays, preallocated scratch). The GPU side is plumes.ts.
//
// WIRING (wave 1, W1-E in scene.ts; nothing here is called yet):
//   * SceneManager owns one `PuffPool` (capacity PUFF_CAPACITY[quality]) and one `PuffRenderer` (plumes.ts).
//     It REPLACES the `fxm.rcsPuff(...)` loop in render() (the `fire < 0.25` threshold on `s.rcs` and the hot
//     pinpoint go; EffectsManager.rcsPuff is deleted with them). Per frame, while frame.warp ≤ 4:
//       pool.frame(simT, player.abs (doubles), player.v, gAbs)     // anchor: free-falling, rebased each ≤ 1 s
//       for each craft within 3 km with jets:  pool.emit(slot, craftIn, view.jets, view.jetDuty, lastTick, tick)
//     `craftIn` = {r: abs doubles, v, q, w (craft-axes body rate)}; `slot` = 0 for the player, 1..3 others;
//     `tick` = world.tick (W1-A); `view.jets` are the JetDef[] (jets.ts) and `jetDuty` the §1.4 contract field.
//     `gAbs` = Σ GM·(rb − r)/|rb − r|³ over the frame's bodies at the player (or 0 — the error is ½gτ² over a
//     puff's ≤ 0.5 s life; with the anchor free-falling there is none).
//     Then `puffs.update(pool, anchor − camAbs (doubles → float), sunDir, keyRGB × starVisibility(player),
//     occluders from puffOccluders(layout, q, r − anchor))`.
//   * The main plume: scene.ts addShip uses `createPhysicalPlumes(layout.engines, …)` (plumes.ts) instead of
//     `createEnginePlumes`, and per frame calls `plume.setLevels(view.engineLevel)` (F_s/F_max per engine, the
//     §1.4 view) instead of setThrottle/update. The render spool (τ 0.45/0.6 s), the ignition kick and the
//     47/113 Hz flicker are not ported. `e.plume.level` readers (hull bell glow) read `plumeGlowLevel(levels)`.
//   * Tests: tests/plumes.test.ts. Harness: dev/harness/plumes.ts.
//
// The physics (SI; inertial axes unless stated):
//   Hydrazine exhaust (N₂, H₂, NH₃) is transparent. What is seen is condensate: unreacted propellant at the
//   pulse edges (the cold catalyst bed at valve opening, the dribble volume boiling out after closing) and a
//   small steady fraction. Each condensate parcel leaves the nozzle at v + ω × r + f·vₑ·d̂ (d̂ sampled uniformly in
//   solid angle inside a cone), then moves ballistically with NO drag. A parcel is a Gaussian blob of mass m and
//   width s(τ) = s₀ + w·τ (it spreads at the cone's lateral speed), so its centre column density is
//   Σ = m / (2π s²) and its optical depth κΣ with κ = 3Q/(4aρ) for droplets of radius a. Seen radiance:
//   L = E_sun · vis · ω₀ · p_HG(θ; g = 0.8) · (1 − e^(−κΣ)). In shadow (planet: vis from the scene; own hull:
//   capsule occluders in the vertex shader) nothing shows. A parcel's life ends, in closed form, where its
//   centre optical depth falls below TAU_END.
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

/** Condensate per valve opening, in seconds of full flow (cold bed: ≈ 10 ms at ≈ 50% unreacted). */
export const T_ON = 0.005;
/** Condensate per valve closing: the dribble volume, in seconds of full flow. */
export const T_OFF = 0.005;
/** Steady-state condensate mass fraction while open. */
export const ETA_STEADY = 0.002;
/** Mass per parcel, in seconds of full flow (sets the parcel count: 10 per edge). */
export const T_PARCEL = 0.0005;

/** Parcels per valve opening / closing at full resolution. */
export const N_EDGE_ON = Math.round(T_ON / T_PARCEL);
export const N_EDGE_OFF = Math.round(T_OFF / T_PARCEL);
/** Typical parcel life (s): the pool's emission budget is capacity·Q/PUFF_TURNOVER parcels per tick per craft. */
export const PUFF_TURNOVER = 0.6;

/** Exit-speed fraction f of vₑ: opening transient (rising chamber pressure), dribble (boils out at low pressure). */
export const F_ON_LO = 0.3, F_ON_HI = 1.0;
export const F_OFF_LO = 0.03, F_OFF_HI = 0.15;
export const F_SS_LO = 0.92, F_SS_HI = 1.0;
/** Cone half-angles, rad: the plan's 30–60°: 30° for full-pressure flow, 60° for the low-pressure dribble spray. */
export const CONE_ON = (30 * Math.PI) / 180;
export const CONE_OFF = (60 * Math.PI) / 180;
/** A parcel's own spread rate as a fraction of the cone's lateral speed f·vₑ·sin θ. */
export const K_SPREAD = 0.3;
/** A parcel ends when its centre optical depth falls below this (L/E below ≈ 1e-2 even fully forward-lit). */
export const TAU_END = 2e-3;

/** Nozzle sizing for s₀ (exit radius from thrust): chamber pressure, thrust coefficient, area ratio. */
export const RCS_PC = 1.0e6;
export const RCS_CF = 1.8;
export const RCS_AREA_RATIO = 50;

/** Anchor re-base limits: age (s) and distance from the player (m). */
export const REBASE_T = 1.0;
export const REBASE_D = 2000;
/** Ticks emitted at most per call (a longer gap — first frame, warp — keeps only the latest ones). */
export const MAX_TICKS = 48;
/** Craft slots that keep their previous duty and fractional parcel counts. */
export const PUFF_SLOTS = 4;
export const MAX_JETS = 32;

export type PuffQuality = 'low' | 'medium' | 'high' | 'ultra';
export const PUFF_CAPACITY: Record<PuffQuality, number> = { low: 512, medium: 1024, high: 2048, ultra: 2048 };

/** Floats per parcel: b.xyz, t0 | u.xyz, tEnd | s0, w, K = κm/2π, kind. */
export const PUFF_STRIDE = 12;
export const PUFF_ON = 0, PUFF_OFF = 1, PUFF_STEADY = 2;

// =============================================================================================== small pure helpers

/** Henyey–Greenstein phase function, sr⁻¹ (∫ over the sphere = 1); cosT = cos of the scattering angle. */
export function hgPhase(cosT: number, g = HG_G): number {
  const g2 = g * g;
  const d = 1 + g2 - 2 * g * cosT;
  return (1 - g2) / (4 * Math.PI * d * Math.sqrt(d));
}

/** RCS nozzle exit radius from thrust (m): A_e = ε·F/(C_F·p_c). */
export function rcsExitRadius(thrust: number): number {
  return Math.sqrt((RCS_AREA_RATIO * thrust) / (RCS_CF * RCS_PC * Math.PI));
}

/** Closed-form parcel life (s): s(τ) = s0 + wτ until κm/(2π s²) = TAU_END. 0 if it starts thinner than that. */
export function parcelLife(m: number, s0: number, w: number): number {
  const sEnd = Math.sqrt((KAPPA * m) / (2 * Math.PI * TAU_END));
  if (sEnd <= s0) return 0;
  return w > 1e-9 ? (sEnd - s0) / w : 3600;
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

/** What the pool needs of an emitting craft (inertial doubles; body rate in craft axes). */
export interface PuffCraft {
  r: V3;
  v: V3;
  q: Quat;
  w: V3;
}

/**
 * A fixed ring of condensate parcels stored against a free-falling anchor. Emission writes, the GPU evaluates the
 * ballistic positions; nothing per parcel is touched per frame except at a re-base (≤ once per second).
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
  /** Count of re-bases (a re-base dirties the whole live set). */
  rebases = 0;
  private readonly prevDuty = new Float64Array(PUFF_SLOTS * MAX_JETS);
  private readonly accSteady = new Float64Array(PUFF_SLOTS * MAX_JETS);
  private readonly lastTick = new Float64Array(PUFF_SLOTS).fill(-1);
  private readonly cOn = new Int32Array(MAX_JETS);
  private readonly cOff = new Int32Array(MAX_JETS);
  private readonly cSS = new Int32Array(MAX_JETS);
  private readonly tOff = new Float64Array(MAX_JETS);
  private tNow = 0;
  // scratch
  private readonly _r = { x: 0, y: 0, z: 0 };
  private readonly _d = { x: 0, y: 0, z: 0 };

  constructor(capacity = PUFF_CAPACITY.high) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * PUFF_STRIDE);
    for (let i = 0; i < capacity; i++) this.data[i * PUFF_STRIDE + 7] = -1e9; // dead
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
   * Once per frame, before emit(): advance to sim time t; re-base the anchor onto the player's state (r, v
   * inertial doubles, g its gravitational acceleration) when the anchor is older than REBASE_T or farther than
   * REBASE_D. A re-base transforms every live parcel exactly (b' = b + ΔA − ΔV·(t − t0), u' = u + ΔV).
   */
  frame(t: number, r: V3, v: V3, g: V3): void {
    this.tNow = t;
    const a = this.anchor;
    if (!this.anchorSet) {
      this.setAnchor(t, r, v, g);
      this.anchorSet = true;
      return;
    }
    const P = this.anchorPos(t, this._r);
    const dx = P.x - r.x, dy = P.y - r.y, dz = P.z - r.z;
    if (t - a[9] < REBASE_T && t >= a[9] && dx * dx + dy * dy + dz * dz < REBASE_D * REBASE_D) return;
    const V = this.anchorVel(t, this._d);
    const dVx = V.x - v.x, dVy = V.y - v.y, dVz = V.z - v.z;
    const shift = t - a[9]; // old epoch → new epoch (= t)
    const D = this.data;
    const rel = t - a[9];
    let live = false;
    for (let i = 0; i < this.capacity; i++) {
      const o = i * PUFF_STRIDE;
      if (D[o + 7] < rel) { D[o + 7] = -1e9; continue; } // dead: keep it dead in the new epoch
      const age = rel - D[o + 3]; // t − t0 (may be < 0 for a parcel born later in this frame's ticks)
      D[o] += dx - dVx * age; D[o + 1] += dy - dVy * age; D[o + 2] += dz - dVz * age;
      D[o + 4] += dVx; D[o + 5] += dVy; D[o + 6] += dVz;
      D[o + 3] -= shift; D[o + 7] -= shift;
      live = true;
    }
    this.maxEnd = live ? this.maxEnd - shift : -Infinity;
    this.setAnchor(t, r, v, g);
    this.rebases++;
    if (live) { this.dirtyLo = 0; this.dirtyHi = this.capacity - 1; }
  }

  private setAnchor(t: number, r: V3, v: V3, g: V3): void {
    const a = this.anchor;
    a[0] = r.x; a[1] = r.y; a[2] = r.z; a[3] = v.x; a[4] = v.y; a[5] = v.z; a[6] = g.x; a[7] = g.y; a[8] = g.z; a[9] = t;
  }

  /** Forget a slot's history (a craft left range or the slot was reassigned). */
  resetSlot(slot: number): void {
    this.lastTick[slot] = -1;
    const o = slot * MAX_JETS;
    for (let j = 0; j < MAX_JETS; j++) { this.prevDuty[o + j] = 0; this.accSteady[o + j] = 0; }
  }

  /**
   * Emit the condensate of ticks (lastTick, tick] of craft `slot` with its applied duties (constant over those
   * ticks; the first one sees the transition from the previous call's duty). The valve of a jet with duty d is
   * open for the first d·Q of each tick: an opening at t_k when d > 0 after a tick that ended closed (d_prev < 1),
   * a closing at t_k + dQ when 0 < d < 1, or at t_k when d = 0 after a fully open tick.
   * Returns the number of parcels written.
   */
  emit(slot: number, c: PuffCraft, jets: readonly JetDef[], duty: ArrayLike<number>, tick: number): number {
    const last = this.lastTick[slot];
    this.lastTick[slot] = tick;
    const nj = jets.length < MAX_JETS ? jets.length : MAX_JETS;
    const po = slot * MAX_JETS;
    if (last < 0) {
      // first sight of this craft: adopt its duty without inventing an edge
      for (let j = 0; j < nj; j++) this.prevDuty[po + j] = clamp01(duty[j] ?? 0);
      return 0;
    }
    let k0 = last + 1;
    if (tick - k0 + 1 > MAX_TICKS) k0 = tick - MAX_TICKS + 1;
    let n = 0;
    const tA = this.anchor[9];
    const budget = this.capacity * TICK / PUFF_TURNOVER;
    const cOn = this.cOn, cOff = this.cOff, cSS = this.cSS, tOff = this.tOff;
    for (let k = k0; k <= tick; k++) {
      // tick k is the step that ended at k·Q: it covers [(k − 1)Q, kQ]
      const tk = (k - 1) * TICK;
      let need = 0;
      for (let j = 0; j < nj; j++) {
        const d = clamp01(duty[j] ?? 0);
        const dp = k === k0 ? this.prevDuty[po + j] : d;
        cOn[j] = d > 0 && dp < 1 ? N_EDGE_ON : 0;
        cOff[j] = 0;
        if (d > 0 && d < 1) { cOff[j] = N_EDGE_OFF; tOff[j] = tk + d * TICK; }
        else if (d === 0 && dp >= 1) { cOff[j] = N_EDGE_OFF; tOff[j] = tk; }
        cSS[j] = 0;
        if (d > 0) {
          const acc = this.accSteady[po + j] + (ETA_STEADY * d * TICK) / T_PARCEL;
          const m = Math.floor(acc);
          this.accSteady[po + j] = acc - m;
          cSS[j] = m;
        }
        need += cOn[j] + cOff[j] + cSS[j];
      }
      if (need === 0) continue;
      // over the pool's turnover budget: fewer, heavier parcels (mass conserved)
      const scale = need > budget ? budget / need : 1;
      for (let j = 0; j < nj; j++) {
        if (cOn[j] + cOff[j] + cSS[j] === 0) continue;
        const J = jets[j];
        const d = clamp01(duty[j] ?? 0);
        const mp = (J.thrust / J.ve) * T_PARCEL;
        const s0 = 0.5 * rcsExitRadius(J.thrust);
        if (cOn[j]) n += this.burst(slot, j, k, PUFF_ON, cOn[j], scale, tk, 0, c, J, mp, s0, tA);
        if (cOff[j]) n += this.burst(slot, j, k, PUFF_OFF, cOff[j], scale, tOff[j], 0, c, J, mp, s0, tA);
        if (cSS[j]) n += this.burst(slot, j, k, PUFF_STEADY, cSS[j], scale, tk, d * TICK, c, J, mp, s0, tA);
      }
    }
    for (let j = 0; j < nj; j++) this.prevDuty[po + j] = clamp01(duty[j] ?? 0);
    return n;
  }

  /** Write `count` parcels of one kind, born over [t0, t0 + span] (absolute s). */
  private burst(slot: number, j: number, k: number, kind: number, want: number, scale: number, t0: number, span: number, c: PuffCraft, J: JetDef, mp0: number, s0: number, tA: number): number {
    const count = scale < 1 ? Math.max(1, Math.round(want * scale)) : want;
    const mp = (mp0 * want) / count;
    const qx = c.q.x, qy = c.q.y, qz = c.q.z, qw = c.q.w;
    // jet position and exhaust direction in inertial axes
    const r = rot(this._r, qx, qy, qz, qw, J.pos.x, J.pos.y, J.pos.z);
    const rx = r.x, ry = r.y, rz = r.z;
    const dd = rot(this._d, qx, qy, qz, qw, J.dir.x, J.dir.y, J.dir.z);
    const dx = dd.x, dy = dd.y, dz = dd.z;
    // nozzle velocity: v + ω × r (ω from craft axes to inertial)
    const wl = J.pos;
    const cwx = c.w.y * wl.z - c.w.z * wl.y, cwy = c.w.z * wl.x - c.w.x * wl.z, cwz = c.w.x * wl.y - c.w.y * wl.x;
    const wv = rot(this._d, qx, qy, qz, qw, cwx, cwy, cwz);
    const nvx = c.v.x + wv.x, nvy = c.v.y + wv.y, nvz = c.v.z + wv.z;
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
    const seed = slot * 64 + j;
    const D = this.data;
    const a = this.anchor;
    for (let i = 0; i < count; i++) {
      const h1 = hash01(k, seed, i * 4 + kind * 1024), h2 = hash01(k, seed, i * 4 + 1 + kind * 1024);
      const h3 = hash01(k, seed, i * 4 + 2 + kind * 1024), h4 = hash01(k, seed, i * 4 + 3 + kind * 1024);
      // uniform in solid angle inside the cone
      const ct = 1 - h1 * (1 - cosC), st = Math.sqrt(Math.max(0, 1 - ct * ct));
      const ph = 2 * Math.PI * h2;
      const cp = Math.cos(ph) * st, sp = Math.sin(ph) * st;
      const ux = dx * ct + ex * cp + fx * sp, uy = dy * ct + ey * cp + fy * sp, uz = dz * ct + ez * cp + fz * sp;
      const sp0 = (fLo + (fHi - fLo) * h3) * J.ve;
      const tb = t0 + span * h4;
      const w = K_SPREAD * sp0 * sinC;
      const life = parcelLife(mp, s0, w);
      if (life <= 0) continue;
      // birth position relative to the anchor: craft position at tb (first order from now) + jet offset
      const dtb = tb - this.tNow, da = tb - a[9];
      const Ax = a[0] + a[3] * da + 0.5 * a[6] * da * da;
      const Ay = a[1] + a[4] * da + 0.5 * a[7] * da * da;
      const Az = a[2] + a[5] * da + 0.5 * a[8] * da * da;
      const AVx = a[3] + a[6] * da, AVy = a[4] + a[7] * da, AVz = a[5] + a[8] * da;
      const o = this.cursor * PUFF_STRIDE;
      const rel0 = tb - tA;
      D[o] = c.r.x + c.v.x * dtb - Ax + rx;
      D[o + 1] = c.r.y + c.v.y * dtb - Ay + ry;
      D[o + 2] = c.r.z + c.v.z * dtb - Az + rz;
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
      if (this.cursor < this.dirtyLo) this.dirtyLo = this.cursor;
      if (this.cursor > this.dirtyHi) this.dirtyHi = this.cursor;
      this.cursor = this.cursor + 1 === this.capacity ? 0 : this.cursor + 1;
    }
    return count;
  }

  /** Hand the dirty range to the uploader and clear it: returns [lo, count] in parcels (count 0: nothing). */
  takeDirty(out: Int32Array): Int32Array {
    if (this.dirtyHi < this.dirtyLo) { out[0] = 0; out[1] = 0; return out; }
    out[0] = this.dirtyLo; out[1] = this.dirtyHi - this.dirtyLo + 1;
    this.dirtyLo = Number.MAX_SAFE_INTEGER; this.dirtyHi = -1;
    return out;
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
