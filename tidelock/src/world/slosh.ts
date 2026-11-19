// Propellant slosh, settling and ullage (SIMULATION.md W3-A item 3). Per tank (not the diaphragm N2H4 tanks), the
// liquid's centroid is the tank centre + x + e, both craft axes:
//   x  the BULK offset: where the liquid mass sits in the tank (settled against a face, or spread);
//   e  the first lateral SLOSH mode's contribution to the centroid (e = (m_s/m_l)·s for the spring-mass s).
// The felt acceleration at the tank, g = −a − α×r − ω×(ω×r) (a = the system's proper acceleration, craft axes;
// r = tank centre − c), decides the regime each step (a pure function of the inputs: no history, no hysteresis):
//   |g| < A_SETTLE (1e-3 m/s², free fall): the liquid is unsettled and spreads: x and e relax to 0 (critically
//      damped, τ = TAU_SPREAD = 20 s (est.): surface tension and wall wetting, slow).
//   otherwise the settle axis k* = the craft axis with the largest |g_k|:
//      along k*: the bulk moves ballistically under g_k and stops INELASTICALLY at the tank wall (X_k = a_k(1 − f),
//         a_k the half extent: a liquid of fill f settled against the face has its centroid there). The settling time
//         from spread is t = √(2X/a) (the plan's √(2R/a)). The slosh part along k* is handed to the bulk at once
//         (x += e, ẋ += ė; same mass: centroid and momentum unchanged).
//      across k* (the two lateral axes k): the spring-mass slosh mode (Abramson, NASA SP-106), exact update
//         ë + 2ζω ė + ω² e = β·g_k,   β = m_s/m_l,
//         rectangular (width L = 2a_k, depth d = f·2a_k*): ω² = (π g/L)·tanh(π d/L), β = 8L/(π³d)·tanh(π d/L);
//         upright circular (capsule tanks settled along their axis, radius R): ξ = 1.8412,
//         ω² = (ξ g/R)·tanh(ξ d/R), β = 2R/(ξ(ξ² − 1)d)·tanh(ξ d/R)   (β → 0.43 at d = R, the plan's 0.4);
//         g = |g_k*|; ζ = 0.02 bare, 0.05 with ring baffles; the bulk relaxes to 0 at the slosh rate ω.
//   Ullage: the sump is covered when the liquid is settled against an outlet face (TankDef.outlet: +Z aft, −Y down)
//   or the tank is ≥ 98 % full; unsettled fraction u = 1 − clamp(σ, 0, 1), σ = settled offset / X along the outlet
//   face. unsettledFraction() is the mass-weighted u of the tanks that would feed: ignition with u > 0.5 fails (no
//   thrust, IGNITION_FAIL_VENT = 1 kg vented).
// Momentum: the craft integrates the SYSTEM CoM (massProps.ts), so the liquid's motion conserves linear momentum by
// construction; sloshStep reports the hull's velocity change from it (SO_DV*, what the crew feels: into the ledger's
// dvImpulse) and the tensor and internal angular-momentum changes (SO_DI*, SO_DL*) for massProps.ts rebaseInternal,
// which keeps I·ω + L_int exact. SO_L* is L_int after the step; internalMomentum() gives it from the state alone
// (rotateFull's stored momentum RF_H* at the start of the next step: a pure function of the saved state).
//
// Cost: exact updates whose transcendentals are cached per tank-axis by a QUANTISED key (fill to 1/1024, ω to 2⁻⁷
// relative, h exactly): the cached numbers are a pure function of the key, so a cache hit and a miss give the same
// bits (save → load → step stays bit-identical) — measured in tests/slosh.test.ts.
//
// WIRING (wave 3; nothing here is called yet):
//   * setup.ts / load: c.sloshModel = buildSloshModel(c.mass) (not saved); §1.4 `slosh` = makeSloshState(model)
//     (12 numbers per tank, SL_STRIDE) or loadSloshState(raw, model).
//   * dynamics.ts integrateCraft, after the step's translation and rotation and the propellant draw (massProps.ts):
//       si = c.sloshIn (makeSloshIn); si[SI_H] = dt; si[SI_A*] = the step-mean proper acceleration of the system in
//       craft axes (ThrustOut o.f* (+ drag, vent) / m); si[SI_W*] = c.w; si[SI_AL*] = the step's α (eulerAccel);
//       si[SI_C*], si[SI_M] = c.mp (start of step); (before the rotation: internalMomentum(model, c.tanks, c.slosh, si,
//       li) → rotateFull's RF_H* (+ the CMG h)); sloshStep(model, c.tanks, c.slosh, si, so) (writes tank pos);
//       massProps(...) again → c.mp; rebaseInternal(c.w, c.mp, so, SO_DIXX, SO_DLX);
//       ledger: c.dvImpulse += so[SO_DV*] (craft axes; the hull's own jump from the liquid; mean force = SO_DV·m/dt).
//     Coasting with |a| = 0 and ω = 0: every tank is in free fall; sloshStep is exact at any dt (a 17 s quantum), and
//     sloshQuiet(c.slosh, model) (all offsets < 1 µm) lets the caller skip it: coasting sleep warp stays free.
//   * jets.ts engineUpdate wiring (W1-B's ignition): when an unlit engine k is commanded on, call
//     unsettledFraction(model, c.tanks, c.slosh, 1 << k, crossfeed); if > IGNITION_U_MAX: keep it unlit, vent
//     IGNITION_FAIL_VENT kg from its feed tanks (massProps.ts drawMain) as W3-B's vent mdot, emit the event.
//   * §1.4 fields read: tanks (m), slosh; written: slosh, tanks[i].pos (the liquid centroid, for views/sound).
// Rate: ≈ 1.0 µs per call in node for the Wren's 8 sloshing tanks. The slosh frequencies are ≤ 0.75 Hz (pods, full
// thrust), so run it every 4th tick (30 Hz, h = 4Q, the tick's inputs held: exact for held inputs, ≥ 40 samples per
// period; tests/w3aRig.ts sloshEvery): ≈ 0.25 µs per tick. Skip it while sloshQuiet. Warp: exact; no limitedBy.

import type { MassModel, TankState } from './massProps';
import { FLUID_LH2, SL_STRIDE } from './massProps';
import { OUT_NX, OUT_NY, OUT_NZ, OUT_PX, OUT_PY, OUT_PZ } from '../data/tanks';

export const A_SETTLE = 1e-3;
export const TAU_SPREAD = 20;
export const ZETA_BARE = 0.02;
export const ZETA_BAFFLED = 0.05;
export const XI_CYL = 1.8412;
export const IGNITION_U_MAX = 0.5;
export const IGNITION_FAIL_VENT = 1;
/** A tank at least this full always covers its sump. */
export const FULL_COVER = 0.98;

/** sloshStep inputs. */
export const SI_H = 0, SI_AX = 1, SI_AY = 2, SI_AZ = 3, SI_WX = 4, SI_WY = 5, SI_WZ = 6, SI_ALX = 7, SI_ALY = 8, SI_ALZ = 9;
export const SI_CX = 10, SI_CY = 11, SI_CZ = 12, SI_M = 13, SI_LEN = 14;
/** sloshStep outputs: hull Δv (3), tensor change about the new CoM (6, [xx yy zz xy xz yz]), L_int change (3), L_int after (3). */
export const SO_DVX = 0, SO_DVY = 1, SO_DVZ = 2, SO_DIXX = 3, SO_DLX = 9, SO_LX = 12, SO_LEN = 15;

export const makeSloshIn = (): Float64Array => new Float64Array(SI_LEN);
export const makeSloshOut = (): Float64Array => new Float64Array(SO_LEN);

/** Per-tank slosh geometry (load time) and the per-tank-axis coefficient cache (pure function of its key). */
export interface SloshModel {
  mass: MassModel;
  nT: number;
  /** 1 if the tank sloshes (LH2, not a diaphragm tank). */
  active: Uint8Array;
  /** Equivalent box half extents a_k (3 per tank), capsule radius (0 for boxes), ζ, outlet mask. */
  a: Float64Array;
  rad: Float64Array;
  zeta: Float64Array;
  outlet: Uint8Array;
  /** Cache per tank-axis (stride C_LEN). */
  cache: Float64Array;
}

// cache slots per tank-axis: geometry key (k*, quantised fill) → slosh factor ω²/g and β; oscillator key (ω_q, h) →
// A, B, C, D of the damped oscillator and Ar, Br, Cr, Dr of the critical relaxation at rate ω_q
const C_KS = 0, C_KF = 1, C_W2G = 2, C_BETA = 3, C_KW = 4, C_KH = 5;
const C_A = 6, C_B = 7, C_C = 8, C_D = 9, C_RA = 10, C_RB = 11, C_RC = 12, C_RD = 13, C_LEN = 14;

export function buildSloshModel(mass: MassModel): SloshModel {
  const nT = mass.nT;
  const active = new Uint8Array(nT), a = new Float64Array(3 * nT), rad = new Float64Array(nT), zeta = new Float64Array(nT), outlet = new Uint8Array(nT);
  mass.tanks.forEach((t, i) => {
    active[i] = t.fluid === 'lh2' && !t.diaphragm ? 1 : 0;
    if (t.shape === 'box') { a[3 * i] = t.h.x; a[3 * i + 1] = t.h.y; a[3 * i + 2] = t.h.z; }
    else {
      // capsule along Z: equal-area square across, equal-volume length along
      const r = t.h.x;
      a[3 * i] = a[3 * i + 1] = 0.5 * Math.sqrt(Math.PI) * r;
      a[3 * i + 2] = t.h.z + (2 / 3) * r;
      rad[i] = r;
    }
    zeta[i] = t.baffles ? ZETA_BAFFLED : ZETA_BARE;
    outlet[i] = t.outlet;
  });
  const cache = new Float64Array(3 * nT * C_LEN).fill(NaN);
  return { mass, nT, active, a, rad, zeta, outlet, cache };
}

export const makeSloshState = (model: SloshModel): number[] => new Array(model.nT * SL_STRIDE).fill(0);

// ------------------------------------------------------------------------------------------------ quantisation (bit exact)

const QF = new Float64Array(1);
const QU = new Uint32Array(QF.buffer);
const HI = new Uint32Array(new Float64Array([1]).buffer)[1] === 0x3ff00000 ? 1 : 0;
/** Round a positive double to 7 mantissa bits (relative step 2⁻⁷ ≈ 0.8 %, error ≤ 0.4 %). Pure function of x. */
function quant7(): void {
  const hi = QU[HI] + 0x1000;
  QU[HI] = hi & 0xffffe000;
  QU[1 - HI] = 0;
}

// ------------------------------------------------------------------------------------------------ step

const G = new Float64Array(3);
const P0 = new Float64Array(3), P1 = new Float64Array(3), V0 = new Float64Array(3), V1 = new Float64Array(3);
const OSC = new Float64Array(4); // y, ẏ in; y, ẏ out
const BAL = new Float64Array(5); // x, v, g, X, h in; x, v out

/** Exact ballistic motion under constant acceleration with inelastic walls at ±X over h (BAL: x, v, g, X, h). */
function ballistic(): void {
  let x = BAL[0], v = BAL[1], t = BAL[4];
  const g = BAL[2], X = BAL[3];
  for (let it = 0; it < 3 && t > 0; it++) {
    const x1 = x + v * t + 0.5 * g * t * t;
    if (x1 <= X && x1 >= -X) { v += g * t; x = x1; t = 0; break; }
    // the wall it reaches first
    const w = x1 > X ? X : -X;
    // solve x + v τ + ½gτ² = w for the first τ in (0, t]
    const A = 0.5 * g, B = v, C = x - w;
    let tau: number;
    if (Math.abs(A) < 1e-300) tau = B !== 0 ? -C / B : t;
    else {
      const disc = B * B - 4 * A * C;
      const sq = Math.sqrt(disc > 0 ? disc : 0);
      const q = -0.5 * (B + (B >= 0 ? sq : -sq));
      const r1 = q / A, r2 = q !== 0 ? C / q : Infinity;
      tau = Infinity;
      if (r1 >= 0 && r1 < tau) tau = r1;
      if (r2 >= 0 && r2 < tau) tau = r2;
      if (!(tau <= t)) tau = t;
    }
    x = w; v = 0; t -= tau;
    // pressed into the wall: it stays for the rest of the step
    if (g * w >= 0) { t = 0; break; }
  }
  if (x > X) x = X; else if (x < -X) x = -X;
  BAL[0] = x; BAL[1] = v;
}

/** Fill the oscillator and relaxation coefficients for (ω, ζ, h) = CF[0..2] into the cache slot at `o` (only on a key change). */
const CF = new Float64Array(3);
function coeffs(c: Float64Array, o: number): void {
  const w = CF[0], zeta = CF[1], h = CF[2];
  if (c[o + C_KW] === w && c[o + C_KH] === h) return;
  c[o + C_KW] = w; c[o + C_KH] = h;
  const zw = zeta * w, wd = w * Math.sqrt(1 - zeta * zeta);
  const E = Math.exp(-zw * h), cs = Math.cos(wd * h), sn = Math.sin(wd * h);
  c[o + C_A] = E * (cs + (zw / wd) * sn);
  c[o + C_B] = (E * sn) / wd;
  c[o + C_C] = (-E * w * w * sn) / wd;
  c[o + C_D] = E * (cs - (zw / wd) * sn);
  const Er = Math.exp(-w * h);
  c[o + C_RA] = (1 + w * h) * Er; c[o + C_RB] = h * Er; c[o + C_RC] = -w * w * h * Er; c[o + C_RD] = (1 - w * h) * Er;
}

/** The free-fall relaxation coefficients (rate 1/TAU_SPREAD) for h, cached on h. */
const FREE = new Float64Array(6).fill(NaN);
function freeCoeffs(): void {
  const h = FREE[5];
  if (FREE[0] === h) return;
  FREE[0] = h;
  const l = 1 / TAU_SPREAD, E = Math.exp(-l * h);
  FREE[1] = (1 + l * h) * E; FREE[2] = h * E; FREE[3] = -l * l * h * E; FREE[4] = (1 - l * h) * E;
}

/**
 * Advance every sloshing tank over si[SI_H] (see the header). Writes `slosh` and each active tank's `pos`, and `so`
 * (SO_*). Tanks with no liquid are zeroed. Exact at any step size; allocation-free.
 */
export function sloshStep(model: SloshModel, tanks: TankState[], slosh: number[], si: Float64Array, so: Float64Array): void {
  for (let k = 0; k < SO_LEN; k++) so[k] = 0;
  const h = si[SI_H];
  if (!(h > 0)) return;
  const mass = model.mass, tc = mass.tc, A = model.a, cache = model.cache;
  const ax = si[SI_AX], ay = si[SI_AY], az = si[SI_AZ], wx = si[SI_WX], wy = si[SI_WY], wz = si[SI_WZ];
  const alx = si[SI_ALX], aly = si[SI_ALY], alz = si[SI_ALZ], cx = si[SI_CX], cy = si[SI_CY], cz = si[SI_CZ];
  const M = si[SI_M] > 0 ? si[SI_M] : 1;
  let s1x = 0, s1y = 0, s1z = 0; // Σ m Δp (CoM shift ×M)
  let dxx = 0, dyy = 0, dzz = 0, dxy = 0, dxz = 0, dyz = 0; // Σ m Δ(p pᵀ)
  let L0x = 0, L0y = 0, L0z = 0, L1x = 0, L1y = 0, L1z = 0;
  let mvx = 0, mvy = 0, mvz = 0; // Σ m Δṗ
  for (let i = 0; i < model.nT; i++) {
    const o = i * SL_STRIDE;
    const ml = tanks[i].m;
    if (!model.active[i] || !(ml > 0)) {
      for (let k = 0; k < SL_STRIDE; k++) slosh[o + k] = 0;
      if (model.active[i]) { tanks[i].pos.x = tc[3 * i]; tanks[i].pos.y = tc[3 * i + 1]; tanks[i].pos.z = tc[3 * i + 2]; }
      continue;
    }
    const f = ml / mass.cap[i];
    const rx = tc[3 * i] - cx, ry = tc[3 * i + 1] - cy, rz = tc[3 * i + 2] - cz;
    // felt acceleration at the tank: g = −a − α×r − ω×(ω×r)
    const ux = wy * rz - wz * ry, uy = wz * rx - wx * rz, uz = wx * ry - wy * rx;
    G[0] = -ax - (aly * rz - alz * ry) - (wy * uz - wz * uy);
    G[1] = -ay - (alz * rx - alx * rz) - (wz * ux - wx * uz);
    G[2] = -az - (alx * ry - aly * rx) - (wx * uy - wy * ux);
    const g2 = G[0] * G[0] + G[1] * G[1] + G[2] * G[2];
    let ks = -1;
    if (g2 >= A_SETTLE * A_SETTLE) {
      ks = 0;
      if (Math.abs(G[1]) > Math.abs(G[ks])) ks = 1;
      if (Math.abs(G[2]) > Math.abs(G[ks])) ks = 2;
    }
    // positions and rates before (relative to the tank centre)
    for (let k = 0; k < 3; k++) { P0[k] = slosh[o + k] + slosh[o + 6 + k]; V0[k] = slosh[o + 3 + k] + slosh[o + 9 + k]; }
    if (ks < 0) {
      FREE[5] = h; freeCoeffs();
      for (let k = 0; k < 3; k++) {
        const x = slosh[o + k], v = slosh[o + 3 + k], e = slosh[o + 6 + k], ev = slosh[o + 9 + k];
        slosh[o + k] = FREE[1] * x + FREE[2] * v; slosh[o + 3 + k] = FREE[3] * x + FREE[4] * v;
        slosh[o + 6 + k] = FREE[1] * e + FREE[2] * ev; slosh[o + 9 + k] = FREE[3] * e + FREE[4] * ev;
      }
    } else {
      const gs = Math.abs(G[ks]);
      // hand the slosh part along k* to the bulk
      slosh[o + ks] += slosh[o + 6 + ks]; slosh[o + 3 + ks] += slosh[o + 9 + ks];
      slosh[o + 6 + ks] = 0; slosh[o + 9 + ks] = 0;
      // bulk along k*: ballistic with walls
      BAL[0] = slosh[o + ks]; BAL[1] = slosh[o + 3 + ks]; BAL[2] = G[ks]; BAL[3] = A[3 * i + ks] * (1 - f);
      BAL[4] = h; ballistic();
      slosh[o + ks] = BAL[0]; slosh[o + 3 + ks] = BAL[1];
      // the quantised fill (geometry key)
      const fq = Math.round(f * 1024) / 1024;
      const depth = (fq > 1 / 1024 ? fq : 1 / 1024) * 2 * A[3 * i + ks];
      for (let k = 0; k < 3; k++) {
        if (k === ks) continue;
        const co = (3 * i + k) * C_LEN;
        if (cache[co + C_KS] !== ks || cache[co + C_KF] !== fq) {
          cache[co + C_KS] = ks; cache[co + C_KF] = fq;
          const R = model.rad[i];
          if (R > 0 && ks === 2) {
            const th = Math.tanh((XI_CYL * depth) / R);
            cache[co + C_W2G] = (XI_CYL / R) * th;
            cache[co + C_BETA] = ((2 * R) / (XI_CYL * (XI_CYL * XI_CYL - 1) * depth)) * th;
          } else {
            const L = 2 * A[3 * i + k], th = Math.tanh((Math.PI * depth) / L);
            cache[co + C_W2G] = (Math.PI / L) * th;
            cache[co + C_BETA] = ((8 * L) / (Math.PI * Math.PI * Math.PI * depth)) * th;
          }
        }
        QF[0] = Math.sqrt(cache[co + C_W2G] * gs);
        quant7();
        const w = QF[0];
        CF[0] = w; CF[1] = model.zeta[i]; CF[2] = h;
        coeffs(cache, co);
        // bulk across k*: relax to 0 at the slosh rate
        const x = slosh[o + k], v = slosh[o + 3 + k];
        slosh[o + k] = cache[co + C_RA] * x + cache[co + C_RB] * v;
        slosh[o + 3 + k] = cache[co + C_RC] * x + cache[co + C_RD] * v;
        // slosh mode: ë + 2ζω ė + ω² e = β g_k  (about its static offset β g_k / ω²)
        const eq = (cache[co + C_BETA] * G[k]) / (w * w);
        const y = slosh[o + 6 + k] - eq, yv = slosh[o + 9 + k];
        slosh[o + 6 + k] = eq + cache[co + C_A] * y + cache[co + C_B] * yv;
        slosh[o + 9 + k] = cache[co + C_C] * y + cache[co + C_D] * yv;
        // the liquid stays in the tank
        const Xk = A[3 * i + k] * (1 - f), tot = slosh[o + k] + slosh[o + 6 + k];
        if (tot > Xk || tot < -Xk) {
          slosh[o + 6 + k] = (tot > 0 ? Xk : -Xk) - slosh[o + k];
          slosh[o + 3 + k] = 0; slosh[o + 9 + k] = 0;
        }
      }
    }
    for (let k = 0; k < 3; k++) { P1[k] = slosh[o + k] + slosh[o + 6 + k]; V1[k] = slosh[o + 3 + k] + slosh[o + 9 + k]; }
    const tx = tc[3 * i], ty = tc[3 * i + 1], tz = tc[3 * i + 2];
    const p0x = tx + P0[0], p0y = ty + P0[1], p0z = tz + P0[2], p1x = tx + P1[0], p1y = ty + P1[1], p1z = tz + P1[2];
    tanks[i].pos.x = p1x; tanks[i].pos.y = p1y; tanks[i].pos.z = p1z;
    s1x += ml * (p1x - p0x); s1y += ml * (p1y - p0y); s1z += ml * (p1z - p0z);
    dxx += ml * (p1x * p1x - p0x * p0x); dyy += ml * (p1y * p1y - p0y * p0y); dzz += ml * (p1z * p1z - p0z * p0z);
    dxy += ml * (p1x * p1y - p0x * p0y); dxz += ml * (p1x * p1z - p0x * p0z); dyz += ml * (p1y * p1z - p0y * p0z);
    // L_int before about c, after about c' (added below as Σ m p × ṗ − M c × ċ_int, with ċ_int = Σ m ṗ / M)
    L0x += ml * (p0y * V0[2] - p0z * V0[1]); L0y += ml * (p0z * V0[0] - p0x * V0[2]); L0z += ml * (p0x * V0[1] - p0y * V0[0]);
    L1x += ml * (p1y * V1[2] - p1z * V1[1]); L1y += ml * (p1z * V1[0] - p1x * V1[2]); L1z += ml * (p1x * V1[1] - p1y * V1[0]);
    mvx += ml * (V1[0] - V0[0]); mvy += ml * (V1[1] - V0[1]); mvz += ml * (V1[2] - V0[2]);
  }
  // Σ m (p − c) × ṗ = Σ m p × ṗ − c × Σ m ṗ; the momentum sums before/after need Σ m ṗ separately
  let q0x = 0, q0y = 0, q0z = 0;
  for (let i = 0; i < model.nT; i++) {
    const o = i * SL_STRIDE, ml = tanks[i].m;
    if (!model.active[i] || !(ml > 0)) continue;
    q0x += ml * (slosh[o + 3] + slosh[o + 9]); q0y += ml * (slosh[o + 4] + slosh[o + 10]); q0z += ml * (slosh[o + 5] + slosh[o + 11]);
  }
  // q0 is Σ m ṗ AFTER; before = after − mv
  const b0x = q0x - mvx, b0y = q0y - mvy, b0z = q0z - mvz;
  const c1x = cx + s1x / M, c1y = cy + s1y / M, c1z = cz + s1z / M;
  L0x -= cy * b0z - cz * b0y; L0y -= cz * b0x - cx * b0z; L0z -= cx * b0y - cy * b0x;
  L1x -= c1y * q0z - c1z * q0y; L1y -= c1z * q0x - c1x * q0z; L1z -= c1x * q0y - c1y * q0x;
  so[SO_DVX] = -mvx / M; so[SO_DVY] = -mvy / M; so[SO_DVZ] = -mvz / M;
  // ΔI about the moved CoM: I = tr(S)E − S − M(|c|²E − c cᵀ)
  const cc0 = cx * cx + cy * cy + cz * cz, cc1 = c1x * c1x + c1y * c1y + c1z * c1z;
  so[SO_DIXX] = dyy + dzz - M * (cc1 - c1x * c1x - (cc0 - cx * cx));
  so[SO_DIXX + 1] = dxx + dzz - M * (cc1 - c1y * c1y - (cc0 - cy * cy));
  so[SO_DIXX + 2] = dxx + dyy - M * (cc1 - c1z * c1z - (cc0 - cz * cz));
  so[SO_DIXX + 3] = -dxy + M * (c1x * c1y - cx * cy);
  so[SO_DIXX + 4] = -dxz + M * (c1x * c1z - cx * cz);
  so[SO_DIXX + 5] = -dyz + M * (c1y * c1z - cy * cz);
  so[SO_DLX] = L1x - L0x; so[SO_DLX + 1] = L1y - L0y; so[SO_DLX + 2] = L1z - L0z;
  so[SO_LX] = L1x; so[SO_LX + 1] = L1y; so[SO_LX + 2] = L1z;
}

/** Internal angular momentum Σ m (p − c) × ṗ of the liquid now (craft axes, about c given in si[SI_C*]); out[0..2]. */
export function internalMomentum(model: SloshModel, tanks: readonly TankState[], slosh: ArrayLike<number>, si: Float64Array, out: Float64Array): void {
  let lx = 0, ly = 0, lz = 0;
  const tc = model.mass.tc;
  for (let i = 0; i < model.nT; i++) {
    const o = i * SL_STRIDE, ml = tanks[i].m;
    if (!model.active[i] || !(ml > 0)) continue;
    const px = tc[3 * i] + slosh[o] + slosh[o + 6] - si[SI_CX], py = tc[3 * i + 1] + slosh[o + 1] + slosh[o + 7] - si[SI_CY], pz = tc[3 * i + 2] + slosh[o + 2] + slosh[o + 8] - si[SI_CZ];
    const vx = slosh[o + 3] + slosh[o + 9], vy = slosh[o + 4] + slosh[o + 10], vz = slosh[o + 5] + slosh[o + 11];
    lx += ml * (py * vz - pz * vy); ly += ml * (pz * vx - px * vz); lz += ml * (px * vy - py * vx);
  }
  out[0] = lx; out[1] = ly; out[2] = lz;
}

/** True when every offset and rate is below 1e-6 (m, m/s): the caller may skip sloshStep. */
export function sloshQuiet(slosh: ArrayLike<number>): boolean {
  for (let k = 0; k < slosh.length; k++) if (slosh[k] > 1e-6 || slosh[k] < -1e-6) return false;
  return true;
}

/**
 * Mass-weighted unsettled fraction of the LH2 tanks that would feed the engines in `engineMask` now (the lowest
 * draw group with propellant among the eligible tanks, as massProps.ts drawMain draws). 1 when they are all dry.
 */
export function unsettledFraction(model: SloshModel, tanks: readonly TankState[], slosh: ArrayLike<number>, engineMask: number, crossfeed: boolean): number {
  const mass = model.mass, A = model.a;
  let g = 256;
  for (let i = 0; i < model.nT; i++) {
    if (mass.fluid[i] !== FLUID_LH2 || !(tanks[i].m > 0) || (!crossfeed && (mass.feeds[i] & engineMask) === 0)) continue;
    if (mass.group[i] < g) g = mass.group[i];
  }
  if (g === 256) return 1;
  let mu = 0, mt = 0;
  for (let i = 0; i < model.nT; i++) {
    if (mass.fluid[i] !== FLUID_LH2 || mass.group[i] !== g || !(tanks[i].m > 0) || (!crossfeed && (mass.feeds[i] & engineMask) === 0)) continue;
    const ml = tanks[i].m, f = ml / mass.cap[i];
    let u = 0;
    if (model.active[i] && f < FULL_COVER) {
      const o = i * SL_STRIDE;
      let s = 0;
      const out = model.outlet[i];
      for (let k = 0; k < 3; k++) {
        const X = A[3 * i + k] * (1 - f);
        if (!(X > 0)) { s = 1; break; }
        const p = (slosh[o + k] + slosh[o + 6 + k]) / X;
        const pos = k === 0 ? OUT_PX : k === 1 ? OUT_PY : OUT_PZ, neg = k === 0 ? OUT_NX : k === 1 ? OUT_NY : OUT_NZ;
        if (out & pos && p > s) s = p;
        if (out & neg && -p > s) s = -p;
      }
      u = 1 - (s > 1 ? 1 : s);
    }
    mu += ml * u; mt += ml;
  }
  return mt > 0 ? mu / mt : 1;
}

/**
 * Slosh frequencies (rad/s) of tank i's two lateral modes for a felt acceleration g along its settle axis k* (the
 * formulas above, unquantised): out[k] for k ≠ k*, out[k*] = 0. For tests and the views.
 */
export function sloshOmega(model: SloshModel, i: number, fill: number, ks: number, g: number, out: Float64Array): void {
  const A = model.a, R = model.rad[i], depth = fill * 2 * A[3 * i + ks];
  for (let k = 0; k < 3; k++) {
    if (k === ks) { out[k] = 0; continue; }
    if (R > 0 && ks === 2) out[k] = Math.sqrt(((XI_CYL * g) / R) * Math.tanh((XI_CYL * depth) / R));
    else { const L = 2 * A[3 * i + k]; out[k] = Math.sqrt(((Math.PI * g) / L) * Math.tanh((Math.PI * depth) / L)); }
  }
}

// ------------------------------------------------------------------------------------------------ save / load

export const saveSloshState = (s: readonly number[]): number[] => s.slice();

/** Loader default: settled nowhere, at rest (all zeros); wrong lengths or non-finite entries read as 0. */
export function loadSloshState(raw: unknown, model: SloshModel): number[] {
  const out = makeSloshState(model);
  if (!Array.isArray(raw) || raw.length !== out.length) return out;
  for (let k = 0; k < out.length; k++) { const v = raw[k]; out[k] = typeof v === 'number' && Number.isFinite(v) ? v : 0; }
  return out;
}
