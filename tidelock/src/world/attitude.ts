// Attitude dynamics II (SIMULATION.md W2-B items 1–3): the rotation ODE with stored momentum (CMG pack, station
// rotor), the gravity-gradient torque from the primary, and the CMG hold as a CONTINUOUS-TIME law integrated inside
// the ODE (with the constant-duty desaturation couple held over the step), RK4 on (ω, q, h).
//
//   I·ω̇ = τ_gg + τ_ext + τ_jets − u − ω × (I·ω + h + h_r)        ḣ = u (CMG output, body axes)
//   q̇ = ½·q ⊗ (0, ω)                                              τ_gg = 3μ/|r|⁵ · r_b × (I·r_b),  r_b = q⁻¹·r
//
// Hold law (mode HOLD), ω_n = 0.05 rad/s, ζ = 0.9, with a per-axis rate limit (the CMG-only slew):
//   θ = 2·sgn(q_e.w)·vec(q_e),  q_e = q_ref⁻¹ ⊗ q,  q_ref(τ) = exp(Ω·τ) ⊗ q_ref0  (Ω: the reference frame's inertial
//   rate, 0 for an inertial hold, n·orbit-normal for an LVLH hold)
//   ω_cmd = clamp(−(ω_n/2ζ)·θ, ±ω_lim),  τ_c = I·2ζω_n·(ω_cmd − (ω − q⁻¹Ω))   (= −I(ω_n²θ + 2ζω_n·ω_rel) unclamped)
//   u = −τ_c − ω × h + ff·τ_jets  (the pack cancels its own gyroscopic coupling, and during a desaturation the jets'
//   couple, so the body feels nothing net), each axis limited to |u_i| ≤ u_max and softly to the momentum envelope
//   |h_i| ≤ h_max (the capability falls linearly to 0 over the last 2% of the envelope: smooth, so RK4 keeps its
//   order and the total momentum I·ω + h is conserved exactly by the ODE; u is internal).
// Demand the pack could not deliver is reported (RO_OVER, N·m): the session hands the hold to the 60 Hz jet
// controller while it is > 0 (a slew faster than CMG authority), and back when it is 0.
//
// WIRING (wave 2; nothing here is called yet):
//   * dynamics.ts integrateCraft: replaces rotateCraft(c, mass, dt, torquing) for every craft whose rotation must be
//     integrated (any ω ≠ 0, any torque, a CMG hold, or gravity gradient: inertia anisotropy > 1% within the
//     primary's sphere of influence). Per translational step, once:
//       ri = c.rotIn (makeRotIn(), per craft, not saved); ri[RI_DT] = dt; ri[RI_IX..IZ] = mass·gyration (later W3-A's
//       inertia); ri[RI_MU] = bodies[P.p].mu; ri[RI_RX..RZ] = P.x..; ri[RI_VX..VZ] = P.vx.. (step start);
//       ri[RI_TJX..TJZ] = the jets' actual torque o.t* (jets.ts, constant over the step); ri[RI_TEX..TEZ] = other
//       constant torques (engine torque; aero is co-integrated by the in-air RK4, see aero.ts);
//       ri[RI_HRX..HRZ] = rotor momentum (W2-C stations, else 0);
//       ri[RI_MODE] = MODE_HOLD when the hold is on the CMGs (cmg.ts cmgTakesHold), else MODE_FREE;
//       ri[RI_QR*] / ri[RI_OM*] = the hold target at the step start and its frame rate (control.ts computes the
//       target; for LVLH holds Ω = (r × v)/|r|²); ri[RI_FF] = 1 while desaturating (cmg.ts), else 0;
//       ri[RI_DTMAX] = desaturating ? DESAT_DT_MAX : HOLD_DT_MAX;
//       desatCutDt(c.cmg, ri) (cmg.ts) BEFORE the jets are evaluated, so the couple stops at a step boundary.
//       rotateHeld(c.w, c.q, c.cmgH, ri, ro) → ro[RO_STEPS] sub-steps (tally WHY_ROTATION), ro[RO_OVER],
//       ro[RO_UMEAN] (CMG power / whine, cmg.ts cmgPower), ro[RO_GG*] (mean gravity-gradient torque, information:
//       it is gravitational, NOT a proper torque, so it never enters the ledger / IMU).
//     Under warp a settled CMG hold or a desaturation no longer forces DT_POWERED steps: the step is the
//     translational one (≤ ETA dynamical time), the rotation sub-steps at ≤ HOLD_DT_MAX (4 s) or ≤ DESAT_DT_MAX
//     (1 s); `limitedBy` stays free ('rotation' only while RO_OVER > 0 hands the hold to the jets).
//   * setup.ts stations: ggEquilibrium(r, v, gyration, q, w) for the start attitude (principal axes in LVLH,
//     ω = n about the orbit normal) instead of ω = 0; flight.ts' station pilot runs MODE_HOLD with an LVLH target,
//     u_max ≈ 1e-6·I_max, h_max = Infinity (station-scale momentum devices).
//   Contract fields: reads/writes c.w, c.q, cmgH (§1.4 wave 2); reads rotorH (W2-C), cmgHMax, cmgTauMax.
//
// Conventions: SI; body (craft) axes are principal; ω and h in body axes; q maps body → inertial; r, v relative to
// the primary in inertial axes. Pure, deterministic, allocation-free (module scratch, typed-array in/out).

import type { Quat, V3 } from '../core/types';

// ============================================================================================= constants

export const MODE_FREE = 0;
export const MODE_HOLD = 1;
/** Hold law natural frequency (rad/s) and damping (SIMULATION.md W2-B item 2). */
export const HOLD_WN = 0.05;
export const HOLD_ZETA = 0.9;
/** Largest rotation sub-step under the hold law, s (0.2/ω_n) and while desaturating. */
export const HOLD_DT_MAX = 0.2 / HOLD_WN;
export const DESAT_DT_MAX = 1;
/** At most this many radians turned per sub-step (dynamics.ts ROT_ANGLE). */
export const ROT_ANGLE = 0.05;
/** Gravity-gradient sub-step: at most this fraction of 1/(n·√3) (the fastest libration time scale). */
export const GG_STEP_FRAC = 0.1;
/** Width of the soft momentum envelope edge, as a fraction of h_max. */
export const H_EDGE = 0.02;

// io slots (rotation input)
export const RI_DT = 0, RI_IX = 1, RI_IY = 2, RI_IZ = 3, RI_MU = 4;
export const RI_RX = 5, RI_RY = 6, RI_RZ = 7, RI_VX = 8, RI_VY = 9, RI_VZ = 10;
export const RI_TJX = 11, RI_TJY = 12, RI_TJZ = 13, RI_TEX = 14, RI_TEY = 15, RI_TEZ = 16;
export const RI_HRX = 17, RI_HRY = 18, RI_HRZ = 19, RI_MODE = 20;
export const RI_QRX = 21, RI_QRY = 22, RI_QRZ = 23, RI_QRW = 24, RI_OMX = 25, RI_OMY = 26, RI_OMZ = 27;
export const RI_WN = 28, RI_ZETA = 29, RI_WLX = 30, RI_WLY = 31, RI_WLZ = 32, RI_HMAX = 33, RI_UMAX = 34;
export const RI_FF = 35, RI_DTMAX = 36, RI_LEN = 37;
// output slots
export const RO_STEPS = 0, RO_OVER = 1, RO_UMEAN = 2, RO_GGX = 3, RO_GGY = 4, RO_GGZ = 5, RO_ERR = 6, RO_SAT = 7;
export const RO_LEN = 8;

/** A rotation input array with the defaults: free, hold gains, no rate limit, unlimited pack. */
export function makeRotIn(): Float64Array {
  const a = new Float64Array(RI_LEN);
  a[RI_IX] = a[RI_IY] = a[RI_IZ] = 1;
  a[RI_QRW] = 1;
  a[RI_WN] = HOLD_WN; a[RI_ZETA] = HOLD_ZETA;
  a[RI_WLX] = a[RI_WLY] = a[RI_WLZ] = Infinity;
  a[RI_HMAX] = Infinity; a[RI_UMAX] = Infinity;
  a[RI_DTMAX] = HOLD_DT_MAX;
  return a;
}
export const makeRotOut = (): Float64Array => new Float64Array(RO_LEN);

// ============================================================================================= the ODE

// Scratch (module-level typed arrays: a double held in a module `let` or passed to a call V8 does not inline is a
// heap number, so every write would allocate; measured 269 scavenges per 1e6 calls before this layout, 0 after).
// K: constants over a call.
const K_IX = 0, K_IY = 1, K_IZ = 2, K_IIX = 3, K_IIY = 4, K_IIZ = 5, K_MU = 6;
const K_R0 = 7, K_V0 = 10, K_A0 = 13, K_TC = 16, K_TJ = 19, K_HR = 22, K_FF = 25, K_HOLD = 26, K_KW = 27, K_KTH = 28;
const K_WL = 29, K_HM = 32, K_UM = 33, K_HEDGE = 34, K_OM = 35, K_OVER = 38, K_SAT = 39, K_LEN = 40;
const K = new Float64Array(K_LEN);
// S: the stage input (τ, ω, q, h, q_ref).  D: the derivative (ω̇, q̇, ḣ), the GG torque and |u|.
const S_T = 0, S_W = 1, S_Q = 4, S_H = 8, S_R = 11;
const S = new Float64Array(15);
const D_W = 0, D_Q = 3, D_H = 7, D_G = 10, D_U = 13;
const D = new Float64Array(14);

/** Allowed share of u toward the momentum envelope edge (u > 0 grows h): 1 until the last band, then linear to 0. */
function edge(h: number, u: number): number {
  const hm = K[K_HM], band = K[K_HEDGE];
  const m = u > 0 ? hm - h : hm + h;
  if (m >= band) return 1;
  return m > 0 ? m / band : 0;
}

/** Derivative of (ω, q, h) at the stage in S, into D. */
function deriv(): void {
  const tau = S[S_T];
  const wx = S[S_W], wy = S[S_W + 1], wz = S[S_W + 2];
  const qx = S[S_Q], qy = S[S_Q + 1], qz = S[S_Q + 2], qw = S[S_Q + 3];
  const hx = S[S_H], hy = S[S_H + 1], hz = S[S_H + 2];
  const Ix = K[K_IX], Iy = K[K_IY], Iz = K[K_IZ];
  let tx = K[K_TC] + K[K_TJ], ty = K[K_TC + 1] + K[K_TJ + 1], tz = K[K_TC + 2] + K[K_TJ + 2];
  let gx = 0, gy = 0, gz = 0;
  const mu = K[K_MU];
  if (mu > 0) {
    // r(τ) to second order, into body axes with the stage attitude: r_b = q⁻¹·r
    const h2 = 0.5 * tau * tau;
    const x = K[K_R0] + K[K_V0] * tau + K[K_A0] * h2;
    const y = K[K_R0 + 1] + K[K_V0 + 1] * tau + K[K_A0 + 1] * h2;
    const z = K[K_R0 + 2] + K[K_V0 + 2] * tau + K[K_A0 + 2] * h2;
    const cx = -qx, cy = -qy, cz = -qz;
    const ax = 2 * (cy * z - cz * y), ay = 2 * (cz * x - cx * z), az = 2 * (cx * y - cy * x);
    const bx = x + qw * ax + (cy * az - cz * ay), by = y + qw * ay + (cz * ax - cx * az), bz = z + qw * az + (cx * ay - cy * ax);
    const r2 = bx * bx + by * by + bz * bz;
    const k = (3 * mu) / (r2 * r2 * Math.sqrt(r2));
    const Lx = Ix * bx, Ly = Iy * by, Lz = Iz * bz;
    gx = k * (by * Lz - bz * Ly); gy = k * (bz * Lx - bx * Lz); gz = k * (bx * Ly - by * Lx);
    tx += gx; ty += gy; tz += gz;
  }
  let ux = 0, uy = 0, uz = 0, ua = 0;
  if (K[K_HOLD] !== 0) {
    const rqx = S[S_R], rqy = S[S_R + 1], rqz = S[S_R + 2], rqw = S[S_R + 3];
    // q_e = q_ref⁻¹ ⊗ q; θ = 2·sgn(w)·vec(q_e) (its axis has the same components in body and reference axes)
    const ex = rqw * qx - rqx * qw - rqy * qz + rqz * qy;
    const ey = rqw * qy + rqx * qz - rqy * qw - rqz * qx;
    const ez = rqw * qz - rqx * qy + rqy * qx - rqz * qw;
    const ew = rqw * qw + rqx * qx + rqy * qy + rqz * qz;
    const sg = ew < 0 ? -2 : 2;
    // Ω in body axes: q⁻¹ · Ω
    const ox = K[K_OM], oy = K[K_OM + 1], oz = K[K_OM + 2];
    let obx = 0, oby = 0, obz = 0;
    if (ox !== 0 || oy !== 0 || oz !== 0) {
      const cx = -qx, cy = -qy, cz = -qz;
      const ax = 2 * (cy * oz - cz * oy), ay = 2 * (cz * ox - cx * oz), az = 2 * (cx * oy - cy * ox);
      obx = ox + qw * ax + (cy * az - cz * ay); oby = oy + qw * ay + (cz * ax - cx * az); obz = oz + qw * az + (cx * ay - cy * ax);
    }
    const kth = -K[K_KTH] * sg, kw = K[K_KW];
    let cmx = kth * ex, cmy = kth * ey, cmz = kth * ez;
    const lx = K[K_WL], ly = K[K_WL + 1], lz = K[K_WL + 2];
    if (cmx > lx) cmx = lx; else if (cmx < -lx) cmx = -lx;
    if (cmy > ly) cmy = ly; else if (cmy < -ly) cmy = -ly;
    if (cmz > lz) cmz = lz; else if (cmz < -lz) cmz = -lz;
    const tcx = Ix * kw * (cmx - (wx - obx)), tcy = Iy * kw * (cmy - (wy - oby)), tcz = Iz * kw * (cmz - (wz - obz));
    // u = −τ_c − ω × h + ff·τ_jets
    const ff = K[K_FF];
    const rx = -tcx - (wy * hz - wz * hy) + ff * K[K_TJ];
    const ry = -tcy - (wz * hx - wx * hz) + ff * K[K_TJ + 1];
    const rz = -tcz - (wx * hy - wy * hx) + ff * K[K_TJ + 2];
    const um = K[K_UM];
    ux = rx > um ? um : rx < -um ? -um : rx;
    uy = ry > um ? um : ry < -um ? -um : ry;
    uz = rz > um ? um : rz < -um ? -um : rz;
    if (K[K_HM] < Infinity) {
      const fx = edge(hx, ux), fy = edge(hy, uy), fz = edge(hz, uz);
      if (fx < 1 || fy < 1 || fz < 1) {
        let s = K[K_SAT];
        if (fx < 1 && (s & 1) === 0) s += 1;
        if (fy < 1 && (s & 2) === 0) s += 2;
        if (fz < 1 && (s & 4) === 0) s += 4;
        K[K_SAT] = s;
        ux *= fx; uy *= fy; uz *= fz;
      }
    }
    const dx = rx - ux, dy = ry - uy, dz = rz - uz;
    const o2 = dx * dx + dy * dy + dz * dz;
    if (o2 > K[K_OVER]) K[K_OVER] = o2;
    ua = ux * ux + uy * uy + uz * uz;
  }
  // Euler with stored momentum: I ω̇ = τ − u − ω × (Iω + h + h_r)
  const Hx = Ix * wx + hx + K[K_HR], Hy = Iy * wy + hy + K[K_HR + 1], Hz = Iz * wz + hz + K[K_HR + 2];
  D[D_W] = (tx - ux - (wy * Hz - wz * Hy)) * K[K_IIX];
  D[D_W + 1] = (ty - uy - (wz * Hx - wx * Hz)) * K[K_IIY];
  D[D_W + 2] = (tz - uz - (wx * Hy - wy * Hx)) * K[K_IIZ];
  D[D_Q] = 0.5 * (qw * wx + qy * wz - qz * wy);
  D[D_Q + 1] = 0.5 * (qw * wy + qz * wx - qx * wz);
  D[D_Q + 2] = 0.5 * (qw * wz + qx * wy - qy * wx);
  D[D_Q + 3] = -0.5 * (qx * wx + qy * wy + qz * wz);
  D[D_H] = ux; D[D_H + 1] = uy; D[D_H + 2] = uz;
  D[D_G] = gx; D[D_G + 1] = gy; D[D_G + 2] = gz;
  D[D_U] = ua;
}

// RK4 stage buffers: state Y (ω 3, q 4, h 3), the stage slopes and the accumulated weighted slope.
const Y = new Float64Array(10), ACC = new Float64Array(10), ACC_G = new Float64Array(4);
/** Reference quaternions: start (0), mid (4), end (8); half-step increment (12). */
const RQ = new Float64Array(16);

/** One stage: S ← Y + c·slope (slope = last D), deriv, ACC += wgt·D. */
function stage(tau: number, c: number, wgt: number, ref: number): void {
  // tau, c, wgt are small integers or literals at each call site; this function is inlined by TurboFan.
  S[S_T] = tau;
  for (let k = 0; k < 10; k++) S[1 + k] = Y[k] + c * (k < 3 ? D[D_W + k] : k < 7 ? D[D_Q + k - 3] : D[D_H + k - 7]);
  S[S_R] = RQ[ref]; S[S_R + 1] = RQ[ref + 1]; S[S_R + 2] = RQ[ref + 2]; S[S_R + 3] = RQ[ref + 3];
  deriv();
  for (let k = 0; k < 3; k++) ACC[k] += wgt * D[D_W + k];
  for (let k = 0; k < 4; k++) ACC[3 + k] += wgt * D[D_Q + k];
  for (let k = 0; k < 3; k++) ACC[7 + k] += wgt * D[D_H + k];
  ACC_G[0] += wgt * D[D_G]; ACC_G[1] += wgt * D[D_G + 1]; ACC_G[2] += wgt * D[D_G + 2]; ACC_G[3] += wgt * Math.sqrt(D[D_U]);
}

/** q_out = d ⊗ q_in within RQ (offsets). */
function refAdvance(o: number, i: number): void {
  const dx = RQ[12], dy = RQ[13], dz = RQ[14], dw = RQ[15];
  const rx = RQ[i], ry = RQ[i + 1], rz = RQ[i + 2], rw = RQ[i + 3];
  let x = dw * rx + dx * rw + dy * rz - dz * ry;
  let y = dw * ry - dx * rz + dy * rw + dz * rx;
  let z = dw * rz + dx * ry - dy * rx + dz * rw;
  let w = dw * rw - dx * rx - dy * ry - dz * rz;
  const n = 1 / Math.sqrt(x * x + y * y + z * z + w * w);
  x *= n; y *= n; z *= n; w *= n;
  RQ[o] = x; RQ[o + 1] = y; RQ[o + 2] = z; RQ[o + 3] = w;
}

/**
 * Rotate through ri[RI_DT] seconds with sub-steps ≤ min(ri[RI_DTMAX] (hold), ROT_ANGLE/(|ω| + |h + h_r|/I_min),
 * GG_STEP_FRAC/(n√3)). Updates w, q (renormalised each sub-step) and h (CMG momentum; untouched in MODE_FREE).
 * Writes ro. Allocation-free.
 */
export function rotateHeld(w: V3, q: Quat, h: V3, ri: Float64Array, ro: Float64Array): void {
  const dt = ri[RI_DT];
  const Ix = ri[RI_IX], Iy = ri[RI_IY], Iz = ri[RI_IZ];
  K[K_IX] = Ix; K[K_IY] = Iy; K[K_IZ] = Iz; K[K_IIX] = 1 / Ix; K[K_IIY] = 1 / Iy; K[K_IIZ] = 1 / Iz;
  const mu = ri[RI_MU];
  K[K_MU] = mu;
  for (let k = 0; k < 3; k++) {
    K[K_R0 + k] = ri[RI_RX + k]; K[K_V0 + k] = ri[RI_VX + k];
    K[K_TC + k] = ri[RI_TEX + k]; K[K_TJ + k] = ri[RI_TJX + k]; K[K_HR + k] = ri[RI_HRX + k];
    K[K_WL + k] = ri[RI_WLX + k]; K[K_OM + k] = ri[RI_OMX + k];
  }
  const hold = ri[RI_MODE] === MODE_HOLD;
  K[K_HOLD] = hold ? 1 : 0;
  K[K_FF] = hold ? ri[RI_FF] : 0;
  const wn = ri[RI_WN], ze = ri[RI_ZETA];
  K[K_KW] = 2 * ze * wn; K[K_KTH] = wn / (2 * ze);
  K[K_HM] = ri[RI_HMAX]; K[K_UM] = ri[RI_UMAX]; K[K_HEDGE] = H_EDGE * ri[RI_HMAX];
  K[K_OVER] = 0; K[K_SAT] = 0;
  ro[RO_STEPS] = 0; ro[RO_OVER] = 0; ro[RO_UMEAN] = 0; ro[RO_GGX] = ro[RO_GGY] = ro[RO_GGZ] = 0; ro[RO_SAT] = 0; ro[RO_ERR] = 0;
  if (!(dt > 0)) return;
  let lim = hold ? ri[RI_DTMAX] : Infinity;
  if (mu > 0) {
    const x = ri[RI_RX], y = ri[RI_RY], z = ri[RI_RZ];
    const r2 = x * x + y * y + z * z, r = Math.sqrt(r2);
    const k = -mu / (r2 * r);
    K[K_A0] = k * x; K[K_A0 + 1] = k * y; K[K_A0 + 2] = k * z;
    const l = GG_STEP_FRAC / Math.sqrt((3 * mu) / (r2 * r));
    if (l < lim) lim = l;
  }
  // Angle per sub-step: the body rate plus the nutation rate of the stored momentum (|h + h_r|/I_min), so a gyrostat
  // (a station's rotor, a loaded pack) is resolved even when the body itself turns slowly.
  const Imin = Ix < Iy ? (Ix < Iz ? Ix : Iz) : Iy < Iz ? Iy : Iz;
  const Sx = h.x + ri[RI_HRX], Sy = h.y + ri[RI_HRY], Sz = h.z + ri[RI_HRZ];
  const wr = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z) + Math.sqrt(Sx * Sx + Sy * Sy + Sz * Sz) / Imin + 1e-30;
  if (ROT_ANGLE / wr < lim) lim = ROT_ANGLE / wr;
  const ns = lim === Infinity ? 1 : Math.max(1, Math.ceil(dt / lim));
  const s = dt / ns, s2 = s / 2, s6 = s / 6;
  Y[0] = w.x; Y[1] = w.y; Y[2] = w.z; Y[3] = q.x; Y[4] = q.y; Y[5] = q.z; Y[6] = q.w; Y[7] = h.x; Y[8] = h.y; Y[9] = h.z;
  // Reference: q_ref(τ) = exp(Ω τ) ⊗ q_ref0, advanced by the constant half-step rotation exp(Ω s/2).
  RQ[0] = ri[RI_QRX]; RQ[1] = ri[RI_QRY]; RQ[2] = ri[RI_QRZ]; RQ[3] = ri[RI_QRW];
  const ox = ri[RI_OMX], oy = ri[RI_OMY], oz = ri[RI_OMZ];
  const om = Math.sqrt(ox * ox + oy * oy + oz * oz);
  if (hold && om > 0) {
    const a = 0.5 * om * s2, sn = Math.sin(a) / om;
    RQ[12] = ox * sn; RQ[13] = oy * sn; RQ[14] = oz * sn; RQ[15] = Math.cos(a);
  } else {
    RQ[12] = RQ[13] = RQ[14] = 0; RQ[15] = 1;
  }
  let gmx = 0, gmy = 0, gmz = 0, umean = 0;
  let tau = 0;
  for (let i = 0; i < ns; i++) {
    refAdvance(4, 0);
    refAdvance(8, 4);
    for (let k = 0; k < 10; k++) ACC[k] = 0;
    ACC_G[0] = ACC_G[1] = ACC_G[2] = ACC_G[3] = 0;
    for (let k = 0; k < 14; k++) D[k] = 0;
    stage(tau, 0, 1, 0);
    stage(tau + s2, s2, 2, 4);
    stage(tau + s2, s2, 2, 4);
    stage(tau + s, s, 1, 8);
    for (let k = 0; k < 10; k++) Y[k] += s6 * ACC[k];
    const qn = 1 / Math.sqrt(Y[3] * Y[3] + Y[4] * Y[4] + Y[5] * Y[5] + Y[6] * Y[6]);
    Y[3] *= qn; Y[4] *= qn; Y[5] *= qn; Y[6] *= qn;
    gmx += ACC_G[0]; gmy += ACC_G[1]; gmz += ACC_G[2]; umean += ACC_G[3];
    RQ[0] = RQ[8]; RQ[1] = RQ[9]; RQ[2] = RQ[10]; RQ[3] = RQ[11];
    tau += s;
  }
  w.x = Y[0]; w.y = Y[1]; w.z = Y[2];
  q.x = Y[3]; q.y = Y[4]; q.z = Y[5]; q.w = Y[6];
  if (hold) { h.x = Y[7]; h.y = Y[8]; h.z = Y[9]; }
  const k6 = 1 / (6 * ns);
  ro[RO_STEPS] = ns;
  ro[RO_OVER] = Math.sqrt(K[K_OVER]);
  ro[RO_UMEAN] = umean * k6;
  ro[RO_GGX] = gmx * k6; ro[RO_GGY] = gmy * k6; ro[RO_GGZ] = gmz * k6;
  ro[RO_SAT] = K[K_SAT];
  if (hold) {
    // final attitude error angle against the reference at the end of the span
    const ew = RQ[3] * Y[6] + RQ[0] * Y[3] + RQ[1] * Y[4] + RQ[2] * Y[5];
    const a = ew < 0 ? -ew : ew;
    ro[RO_ERR] = 2 * Math.acos(a > 1 ? 1 : a);
  }
}

// ============================================================================================= helpers

/** Gravity-gradient torque in body axes, N·m: 3μ/|r|⁵ · r_b × I·r_b, with r_b the primary→craft vector in body axes. */
export function ggTorque(out: V3, mu: number, bx: number, by: number, bz: number, Ix_: number, Iy_: number, Iz_: number): V3 {
  const r2 = bx * bx + by * by + bz * bz;
  const k = (3 * mu) / (r2 * r2 * Math.sqrt(r2));
  const Lx = Ix_ * bx, Ly = Iy_ * by, Lz = Iz_ * bz;
  out.x = k * (by * Lz - bz * Ly); out.y = k * (bz * Lx - bx * Lz); out.z = k * (bx * Ly - by * Lx);
  return out;
}

/**
 * Small-amplitude pitch libration frequency, rad/s, of a gravity-gradient-stable rigid body on a circular orbit of
 * mean motion n, pitching about the orbit normal: n·√(3·(I_t − I_r)/I_n) (I_t along-track, I_r radial, I_n normal).
 */
export const pitchLibration = (n: number, It: number, Ir: number, In: number): number => n * Math.sqrt((3 * (It - Ir)) / In);

/**
 * Gravity-gradient equilibrium of a craft at (r, v) relative to its primary (load time; allocates nothing but
 * writes q and w): principal axes in the local-vertical frame, the LARGEST inertia along the orbit normal, the
 * SMALLEST along the radial, the intermediate along-track; ω = n about the orbit normal (body axes).
 * `inertia` are the principal moments (or gyrations: only their order matters for q; w is independent of them).
 */
export function ggEquilibrium(r: V3, v: V3, inertia: V3, q: Quat, w: V3): void {
  const rl = Math.hypot(r.x, r.y, r.z);
  const R = { x: r.x / rl, y: r.y / rl, z: r.z / rl };
  let nx = r.y * v.z - r.z * v.y, ny = r.z * v.x - r.x * v.z, nz = r.x * v.y - r.y * v.x;
  const hn = Math.hypot(nx, ny, nz);
  const n = hn / (rl * rl);
  nx /= hn; ny /= hn; nz /= hn;
  const N = { x: nx, y: ny, z: nz };
  const T = { x: ny * R.z - nz * R.y, y: nz * R.x - nx * R.z, z: nx * R.y - ny * R.x };
  const I = [inertia.x, inertia.y, inertia.z];
  const idx = [0, 1, 2].sort((a, b) => I[a] - I[b] || a - b); // [min, mid, max]
  // Columns of the body → world matrix: body axis idx[0] → R, idx[1] → T, idx[2] → N.
  const col: V3[] = [R, R, R];
  col[idx[0]] = R; col[idx[1]] = T; col[idx[2]] = N;
  // Handedness: (R, T, N) is right-handed; the permutation's parity decides whether to flip one axis.
  const c0 = col[0], c1 = col[1], c2 = col[2];
  const det = c0.x * (c1.y * c2.z - c1.z * c2.y) - c0.y * (c1.x * c2.z - c1.z * c2.x) + c0.z * (c1.x * c2.y - c1.y * c2.x);
  if (det < 0) col[idx[1]] = { x: -T.x, y: -T.y, z: -T.z };
  matToQuat(col[0], col[1], col[2], q);
  // ω = n·N in body axes: N is body axis idx[2].
  w.x = w.y = w.z = 0;
  if (idx[2] === 0) w.x = n; else if (idx[2] === 1) w.y = n; else w.z = n;
}

/** Quaternion of the rotation matrix with columns a, b, c (body x, y, z in world). */
export function matToQuat(a: V3, b: V3, c: V3, q: Quat): Quat {
  const m00 = a.x, m10 = a.y, m20 = a.z, m01 = b.x, m11 = b.y, m21 = b.z, m02 = c.x, m12 = c.y, m22 = c.z;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    q.w = 0.25 / s; q.x = (m21 - m12) * s; q.y = (m02 - m20) * s; q.z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q.w = (m21 - m12) / s; q.x = 0.25 * s; q.y = (m01 + m10) / s; q.z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q.w = (m02 - m20) / s; q.x = (m01 + m10) / s; q.y = 0.25 * s; q.z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q.w = (m10 - m01) / s; q.x = (m02 + m20) / s; q.y = (m12 + m21) / s; q.z = 0.25 * s;
  }
  return q;
}

/** Does gravity gradient matter for this inertia (anisotropy > 1%)? Then the rotation is integrated every step. */
export const ggMatters = (I: V3): boolean => {
  const mx = Math.max(I.x, I.y, I.z), mn = Math.min(I.x, I.y, I.z);
  return mx > 1.01 * mn;
};
