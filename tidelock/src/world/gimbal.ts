// Main-engine gimbal and thrust-vector control (SIMULATION.md W3-A item 2), replacing jets.ts engineDef's fixed
// 0.73° cant: each nozzle swivels about a pivot (z = 13.5 m on the Wren) in pitch (about craft X) and yaw (about
// craft Y), ±4° at ≤ 15°/s with a first-order lag of 0.1 s; a ±10 % differential throttle adds yaw. The mount cant
// puts each thrust line through the DESIGN CoM in the Y–Z plane (yaw offsets cancel by symmetry: engine-out yaws the
// ship); the TVC then trims the lines through the MOVING CoM and delivers the attitude controller's torque during a
// burn, so the RCS stays quiet.
//
// Actuator (per axis, exact at any h): δ̇ = clamp((δ_c − δ)/τ, ±rate), δ_c ∈ [−range, range]. Rate-limited while
// |δ_c − δ| > rate·τ, then exponential (the two pieces joined exactly inside the step).
// TVC (every controller tick, 60 Hz): the torque about c of all engines, τ(u), u = [δp_0, δy_0, δp_1, δy_1, …, Δ], is
// driven to the command τ_cmd by two Gauss–Newton steps of the range-weighted minimum-norm solution
//   u ← u + W Jᵀ (J W Jᵀ + εI)⁻¹ (τ_cmd − τ(u)),   W = diag(range², …, Δ_max²)
// from the last command (warm start); J analytic (∂d/∂δp = x̂ × d, ∂d/∂δy = ŷ × d). Engines at zero thrust have no
// columns (an engine out); Δ only while every engine burns. Clamped to the ranges; what it cannot deliver is
// returned (TO_RES*: the attitude controller hands it to the RCS / CMG). τ_cmd = 0 is the pure trim: the resultant
// through the moving CoM.
//
// WIRING (wave 3; nothing here is called yet):
//   * setup.ts / load: c.gimbalDefs = gimbalDefs(layout.engines, designCom, stats.mainThrust / n, stats.exhaustVelocity)
//     (designCom = massProps.ts massProps with full tanks); it REPLACES jets.ts engineDef (keep c.engines for the spool
//     constants: gimbalDefs copies them in). §1.4 `gimbal` = makeGimbalState(n) or loadGimbalState(raw, n) (saved:
//     angles AND the held commands, so a save between two 60 Hz control ticks continues bit-identically).
//   * control.ts, at the 60 Hz controller tick while any engine burns: τ_cmd = the hold's pitch/yaw(/roll) torque
//     (N·m, craft axes, about c; the same law that drives the jets/CMG); tvcSolve(defs, c.gimbal, c.engineThrust,
//     mp (massProps MP_*), tcmd, to) → the held commands in c.gimbal; the residual to[TO_RESX..Z] goes to the jets
//     (jets.ts torqueToCmd) instead of the whole demand. Not burning: tvcSolve(…) with zero thrust centres the bells.
//   * dynamics.ts integrateCraft, per step: gimbalStep(c.gimbal, n, inp) (actuators, exact over inp[IN_H]); then per
//     engine k diffThrottle(c.gimbal, defs, k, base = [c.throttle], inp) before jets.ts engineUpdate(k); then
//     applyGimbaled(defs, c.gimbal, mean, inp, o) REPLACES jets.ts applyEngines (force −F̄·d(δ) through the pivot,
//     torque about c = inp[IN_C*], ṁ, jet damping from the rotated exit). engineMdot[k] = mean[k]/ve for
//     massProps.ts drawMain. Engine health (W2-C engineHealth) scales maxThrust in the caller, as today.
//   * render: the nozzle meshes turn by (δp, δy) about the pivot (read c.gimbal; "the bells swivel during burns").
//   * §1.4 fields read: gimbal, engineThrust, com; written: gimbal.
// Rate: tvcSolve at 60 Hz (≈ 1 µs node), gimbalStep + applyGimbaled per craft step. Warp: exact; while the engines
// burn the steps are DT_POWERED anyway (limitedBy 'thrust', unchanged).

import type { V3 } from '../core/types';
import { IN_CX, IN_CY, IN_CZ, IN_H, IN_THROTTLE, IN_WX, IN_WY, IN_WZ, ENGINE_DELAY, ENGINE_MIN_THROTTLE, ENGINE_TAU_DOWN, ENGINE_TAU_UP, ENGINE_THRUST, ENGINE_VE } from './jets';
import { MP_CX, MP_CY, MP_CZ } from './massProps';

const DEG = Math.PI / 180;
export const GIMBAL_RANGE = 4 * DEG;
export const GIMBAL_RATE = 15 * DEG;
export const GIMBAL_TAU = 0.1;
export const PIVOT_Z = 13.5;
export const DIFF_MAX = 0.1;
/** Per engine in §1.4 `gimbal`: δp, δy (rad), held commands δp_c, δy_c; then the differential throttle command Δ. */
export const G_STRIDE = 4;

/** One gimballed engine (load time). dir0 is the neutral EXHAUST direction (unit), the force is −F·d. */
export interface GimbalDef {
  pivot: V3;
  /** Nozzle exit relative to the pivot along the neutral axis (m): the exit is pivot + arm·d. */
  arm: number;
  dir0: V3;
  maxThrust: number;
  ve: number;
  tauUp: number;
  tauDown: number;
  delay: number;
  minThrottle: number;
  /** +1 / −1: the side of the differential throttle (starboard engines +1). */
  side: number;
}

/**
 * Gimballed engines from the layout's nozzle exits (`engines[i].pos`): pivot at (x, y, PIVOT_Z) (or 2.1 m ahead of
 * the exit when the exit is not aft of PIVOT_Z), neutral exhaust in the Y–Z plane through `designCom`.
 */
export function gimbalDefs(engines: readonly { pos: V3 }[], designCom: V3, maxThrust = ENGINE_THRUST, ve = ENGINE_VE): GimbalDef[] {
  return engines.map((e) => {
    const pz = e.pos.z > PIVOT_Z ? PIVOT_Z : e.pos.z - 2.1;
    const pivot = { x: e.pos.x, y: e.pos.y, z: pz };
    const dy = pivot.y - designCom.y, dz = pivot.z - designCom.z, l = Math.hypot(dy, dz) || 1;
    return {
      pivot, arm: Math.hypot(e.pos.x - pivot.x, e.pos.y - pivot.y, e.pos.z - pivot.z),
      dir0: { x: 0, y: dy / l, z: dz / l }, maxThrust, ve,
      tauUp: ENGINE_TAU_UP, tauDown: ENGINE_TAU_DOWN, delay: ENGINE_DELAY, minThrottle: ENGINE_MIN_THROTTLE,
      side: e.pos.x > 1e-6 ? 1 : e.pos.x < -1e-6 ? -1 : 0,
    };
  });
}

export const makeGimbalState = (n: number): number[] => new Array(n * G_STRIDE + 1).fill(0);

/** Exhaust direction at angles src[i] (δp about X, first) and src[i + 1] (δy about Y) of its neutral direction, into out[o..o+2]. */
function dirAt(d: GimbalDef, src: ArrayLike<number>, i: number, out: Float64Array, o: number): void {
  const dp = src[i], dy = src[i + 1];
  const cp = Math.cos(dp), sp = Math.sin(dp), cy = Math.cos(dy), sy = Math.sin(dy);
  const x0 = d.dir0.x, y0 = d.dir0.y, z0 = d.dir0.z;
  // about X: y' = c y − s z, z' = s y + c z
  const y1 = cp * y0 - sp * z0, z1 = sp * y0 + cp * z0;
  // about Y: x' = c x + s z, z' = −s x + c z
  out[o] = cy * x0 + sy * z1; out[o + 1] = y1; out[o + 2] = -sy * x0 + cy * z1;
}

// ------------------------------------------------------------------------------------------------ actuator

const GE = new Float64Array(2).fill(NaN); // cached e^(−h/τ) for h

function actuate(g: number[], o: number): void {
  const h = GE[0], e = GE[1];
  const c = g[o + 2];
  let x = g[o];
  const d = c - x, ad = d < 0 ? -d : d, lim = GIMBAL_RATE * GIMBAL_TAU;
  if (ad > lim) {
    const t1 = (ad - lim) / GIMBAL_RATE, s = d > 0 ? 1 : -1;
    if (t1 >= h) { g[o] = x + s * GIMBAL_RATE * h; return; }
    x = c - s * lim;
    g[o] = c - s * lim * Math.exp(-(h - t1) / GIMBAL_TAU);
    return;
  }
  g[o] = c + (x - c) * e;
}

/** Advance every gimbal actuator over h = inp[IN_H] (jets.ts step input) toward its held command (exact). */
export function gimbalStep(g: number[], n: number, inp: Float64Array): void {
  const h = inp[IN_H];
  if (!(h > 0)) return;
  if (GE[0] !== h) { GE[0] = h; GE[1] = Math.exp(-h / GIMBAL_TAU); }
  for (let k = 0; k < n; k++) {
    const o = k * G_STRIDE;
    actuate(g, o);
    actuate(g, o + 1);
  }
}

/**
 * Engine k's throttle command with the differential: inp[IN_THROTTLE] ← base[0]·(1 + side·Δ) (base[0] = c.throttle,
 * Δ = the held differential command). Call before jets.ts engineUpdate(k).
 */
export function diffThrottle(g: ArrayLike<number>, defs: readonly GimbalDef[], k: number, base: ArrayLike<number>, inp: Float64Array): void {
  inp[IN_THROTTLE] = base[0] * (1 + defs[k].side * g[defs.length * G_STRIDE]);
}

// ------------------------------------------------------------------------------------------------ TVC

/** tvcSolve inputs/outputs: commanded torque (N·m, craft axes, about c) and an axis mask; residual torque out. */
export const TI_TX = 0, TI_TY = 1, TI_TZ = 2, TI_MASK = 3, TI_LEN = 4;
export const TO_RESX = 0, TO_RESY = 1, TO_RESZ = 2, TO_LEN = 3;
export const makeTvcIn = (): Float64Array => { const a = new Float64Array(TI_LEN); a[TI_MASK] = 7; return a; };
export const makeTvcOut = (): Float64Array => new Float64Array(TO_LEN);

const MAXE = 4;
const NU = 2 * MAXE + 1;
const U = new Float64Array(NU), J = new Float64Array(3 * NU), Wd = new Float64Array(NU), D3 = new Float64Array(3 * MAXE);
const TQ = new Float64Array(3), Mx = new Float64Array(9), Lam = new Float64Array(3);

/** Torque about c of every engine at angles/differential U and thrusts T, into TQ; Jacobian into J when `jac`. */
function torqueAt(defs: readonly GimbalDef[], n: number, T: ArrayLike<number>, mp: ArrayLike<number>, jac: boolean): void {
  const cx = mp[MP_CX], cy = mp[MP_CY], cz = mp[MP_CZ];
  TQ[0] = TQ[1] = TQ[2] = 0;
  if (jac) J.fill(0);
  const diff = U[2 * n];
  let allOn = true;
  for (let k = 0; k < n; k++) if (!(T[k] > 0)) allOn = false;
  for (let k = 0; k < n; k++) {
    const d = defs[k], F0 = T[k] > 0 ? T[k] : 0;
    if (F0 === 0) continue;
    const F = F0 * (1 + (allOn ? d.side * diff : 0));
    dirAt(d, U, 2 * k, D3, 3 * k);
    const ux = D3[3 * k], uy = D3[3 * k + 1], uz = D3[3 * k + 2];
    const rx = d.pivot.x - cx, ry = d.pivot.y - cy, rz = d.pivot.z - cz;
    // force −F·u; τ = r × f
    const fx = -F * ux, fy = -F * uy, fz = -F * uz;
    TQ[0] += ry * fz - rz * fy; TQ[1] += rz * fx - rx * fz; TQ[2] += rx * fy - ry * fx;
    if (!jac) continue;
    // ∂u/∂δp = x̂ × u = (0, −uz, uy); ∂u/∂δy = ŷ × u = (uz, 0, −ux)  (small-angle exact at the current u)
    const ax = 0, ay = -uz, az = uy, bx = uz, by = 0, bz = -ux;
    J[0 * NU + 2 * k] = -F * (ry * az - rz * ay); J[1 * NU + 2 * k] = -F * (rz * ax - rx * az); J[2 * NU + 2 * k] = -F * (rx * ay - ry * ax);
    J[0 * NU + 2 * k + 1] = -F * (ry * bz - rz * by); J[1 * NU + 2 * k + 1] = -F * (rz * bx - rx * bz); J[2 * NU + 2 * k + 1] = -F * (rx * by - ry * bx);
    if (allOn && d.side !== 0) {
      const s = F0 * d.side;
      J[0 * NU + 2 * n] += -s * (ry * uz - rz * uy); J[1 * NU + 2 * n] += -s * (rz * ux - rx * uz); J[2 * NU + 2 * n] += -s * (rx * uy - ry * ux);
    }
  }
  if (jac) for (let k = 0; k < n; k++) { Wd[2 * k] = Wd[2 * k + 1] = T[k] > 0 ? GIMBAL_RANGE * GIMBAL_RANGE : 0; }
  if (jac) Wd[2 * n] = allOn && n > 1 ? DIFF_MAX * DIFF_MAX : 0;
}

/**
 * The TVC law (see the header). `g` = §1.4 gimbal (the held commands are written), `T` = engineThrust (N, the spool
 * state; a lit engine still spooling counts at its current thrust), `mp` = massProps output (c), `ti` = command,
 * `to` ← the residual torque the engines could not deliver. Allocation-free; n ≤ 4 engines.
 */
export function tvcSolve(defs: readonly GimbalDef[], g: number[], T: ArrayLike<number>, mp: ArrayLike<number>, ti: Float64Array, to: Float64Array): void {
  const n = defs.length < MAXE ? defs.length : MAXE;
  const mask = ti[TI_MASK] | 0;
  let any = false;
  for (let k = 0; k < n; k++) if (T[k] > 0) any = true;
  if (!any) {
    for (let k = 0; k < n; k++) { g[k * G_STRIDE + 2] = 0; g[k * G_STRIDE + 3] = 0; }
    g[n * G_STRIDE] = 0;
    to[0] = ti[TI_TX]; to[1] = ti[TI_TY]; to[2] = ti[TI_TZ];
    return;
  }
  for (let k = 0; k < n; k++) { U[2 * k] = g[k * G_STRIDE + 2]; U[2 * k + 1] = g[k * G_STRIDE + 3]; }
  U[2 * n] = g[n * G_STRIDE];
  const nu = 2 * n + 1;
  for (let it = 0; it < 2; it++) {
    torqueAt(defs, n, T, mp, true);
    // residual on the masked axes
    const e0 = mask & 1 ? ti[TI_TX] - TQ[0] : 0, e1 = mask & 2 ? ti[TI_TY] - TQ[1] : 0, e2 = mask & 4 ? ti[TI_TZ] - TQ[2] : 0;
    // M = J W Jᵀ (masked rows), regularised
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
      let s = 0;
      if ((mask >> a) & 1 && (mask >> b) & 1) for (let j = 0; j < nu; j++) s += J[a * NU + j] * Wd[j] * J[b * NU + j];
      Mx[3 * a + b] = s;
    }
    const tr = Mx[0] + Mx[4] + Mx[8], eps = 1e-9 * tr + 1e-30;
    for (let a = 0; a < 3; a++) if (!((mask >> a) & 1)) Mx[4 * a] = 1; else Mx[4 * a] += eps;
    // solve M λ = e (3×3, Cramer)
    const m0 = Mx[0], m1 = Mx[1], m2 = Mx[2], m3 = Mx[3], m4 = Mx[4], m5 = Mx[5], m6 = Mx[6], m7 = Mx[7], m8 = Mx[8];
    const det = m0 * (m4 * m8 - m5 * m7) - m1 * (m3 * m8 - m5 * m6) + m2 * (m3 * m7 - m4 * m6);
    if (!(Math.abs(det) > 0)) break;
    const id = 1 / det;
    Lam[0] = (e0 * (m4 * m8 - m5 * m7) - m1 * (e1 * m8 - m5 * e2) + m2 * (e1 * m7 - m4 * e2)) * id;
    Lam[1] = (m0 * (e1 * m8 - m5 * e2) - e0 * (m3 * m8 - m5 * m6) + m2 * (m3 * e2 - e1 * m6)) * id;
    Lam[2] = (m0 * (m4 * e2 - e1 * m7) - m1 * (m3 * e2 - e1 * m6) + e0 * (m3 * m7 - m4 * m6)) * id;
    for (let j = 0; j < nu; j++) {
      let s = 0;
      for (let a = 0; a < 3; a++) if ((mask >> a) & 1) s += J[a * NU + j] * Lam[a];
      U[j] += Wd[j] * s;
    }
    for (let k = 0; k < n; k++) {
      for (let a = 0; a < 2; a++) { const u = U[2 * k + a]; U[2 * k + a] = u > GIMBAL_RANGE ? GIMBAL_RANGE : u < -GIMBAL_RANGE ? -GIMBAL_RANGE : u; }
    }
    U[2 * n] = U[2 * n] > DIFF_MAX ? DIFF_MAX : U[2 * n] < -DIFF_MAX ? -DIFF_MAX : U[2 * n];
  }
  for (let k = 0; k < n; k++) {
    g[k * G_STRIDE + 2] = T[k] > 0 ? U[2 * k] : 0; g[k * G_STRIDE + 3] = T[k] > 0 ? U[2 * k + 1] : 0;
  }
  g[n * G_STRIDE] = U[2 * n];
  // what the commanded angles deliver (the actuators still have to get there)
  torqueAt(defs, n, T, mp, false);
  to[TO_RESX] = ti[TI_TX] - TQ[0]; to[TO_RESY] = ti[TI_TY] - TQ[1]; to[TO_RESZ] = ti[TI_TZ] - TQ[2];
}

/** The torque about c (N·m) the engines make at the ACTUAL angles and thrusts `T`, into out (for tests and views). */
export function engineTorque(defs: readonly GimbalDef[], g: ArrayLike<number>, T: ArrayLike<number>, mp: ArrayLike<number>, out: V3): V3 {
  const n = defs.length < MAXE ? defs.length : MAXE;
  for (let k = 0; k < n; k++) { U[2 * k] = g[k * G_STRIDE]; U[2 * k + 1] = g[k * G_STRIDE + 1]; }
  U[2 * n] = g[n * G_STRIDE];
  torqueAt(defs, n, T, mp, false);
  out.x = TQ[0]; out.y = TQ[1]; out.z = TQ[2];
  return out;
}

// ------------------------------------------------------------------------------------------------ application per step

/**
 * jets.ts applyEngines with gimballed nozzles: adds the engines' step-mean thrusts `mean[k]` (N, from engineUpdate,
 * already including the differential factor through the throttle) to `o`: force −F̄·d(δ), torque about c = inp[IN_C*]
 * through the pivot, ṁ_main = ΣF̄/vₑ, jet damping at rate inp[IN_W*] from the swivelled exit. Uses the ACTUAL angles.
 */
export function applyGimbaled(defs: readonly GimbalDef[], g: ArrayLike<number>, mean: ArrayLike<number>, inp: Float64Array, o: { fx: number; fy: number; fz: number; tx: number; ty: number; tz: number; dx: number; dy: number; dz: number; mdotMain: number }): void {
  const wx = inp[IN_WX], wy = inp[IN_WY], wz = inp[IN_WZ], cx = inp[IN_CX], cy = inp[IN_CY], cz = inp[IN_CZ];
  const n = defs.length < MAXE ? defs.length : MAXE;
  for (let k = 0; k < n; k++) {
    const F = mean[k];
    if (F === 0) continue;
    const d = defs[k];
    dirAt(d, g, k * G_STRIDE, D3, 3 * k);
    const ux = D3[3 * k], uy = D3[3 * k + 1], uz = D3[3 * k + 2];
    const ax = -F * ux, ay = -F * uy, az = -F * uz;
    const rx = d.pivot.x - cx, ry = d.pivot.y - cy, rz = d.pivot.z - cz;
    o.fx += ax; o.fy += ay; o.fz += az;
    o.tx += ry * az - rz * ay; o.ty += rz * ax - rx * az; o.tz += rx * ay - ry * ax;
    const md = F / d.ve;
    o.mdotMain += md;
    // exit point relative to c for the jet damping
    const ex = rx + d.arm * ux, ey = ry + d.arm * uy, ez = rz + d.arm * uz;
    const r2 = ex * ex + ey * ey + ez * ez, rw = ex * wx + ey * wy + ez * wz;
    const dx = -md * (r2 * wx - rw * ex), dy = -md * (r2 * wy - rw * ey), dz = -md * (r2 * wz - rw * ez);
    o.dx += dx; o.dy += dy; o.dz += dz;
    o.tx += dx; o.ty += dy; o.tz += dz;
  }
}

// ------------------------------------------------------------------------------------------------ save / load

export const saveGimbalState = (g: readonly number[]): number[] => g.slice();

/** Loader default: centred, no command, no differential; angles clamped to the range. */
export function loadGimbalState(raw: unknown, n: number): number[] {
  const out = makeGimbalState(n);
  if (!Array.isArray(raw) || raw.length !== out.length) return out;
  for (let k = 0; k < out.length; k++) {
    const v = raw[k];
    const x = typeof v === 'number' && Number.isFinite(v) ? v : 0;
    const lim = k === n * G_STRIDE ? DIFF_MAX : GIMBAL_RANGE;
    out[k] = x > lim ? lim : x < -lim ? -lim : x;
  }
  return out;
}
