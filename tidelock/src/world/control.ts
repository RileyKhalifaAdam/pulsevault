// Attitude hold: a pure controller that turns an attitude error and the current body rates into a torque
// command (-1..1 per local axis). It never sets orientation — the command goes through Euler's equations.
//
// Law: desired rate along the error axis = min(k·θ, √(2·c·α·θ), maxRate); torque = I·K·(ω_des − ω) plus the
// gyroscopic term, clamped to the attitude system's limits. Near the target it is a critically damped PD
// (k = K/4); far from it the square-root curve keeps the demanded deceleration at c·α (40 % of what the
// torquers can give, 80 % at the hand-over to the linear zone), so the turn arrives without overshoot.

import type { Quat, V3 } from '../core/types';
import type { Craft } from './state';
import { clamp1, qRotInv } from './math';

/** Rate-loop gain K, 1/s. The attitude stiffness is K/4 (critical damping). */
export const HOLD_RATE_GAIN = 6;
/** Fraction of the available angular acceleration the braking curve plans with. */
export const HOLD_BRAKE = 0.4;
/** Default slew rate limit, rad/s. */
export const HOLD_MAX_RATE = 0.6;

const T = { x: 0, y: 0, z: 0 };

/** Rotation vector (craft-local axes, rad) that would take attitude `q` to `qTarget`. */
export function attitudeError(q: Quat, qTarget: Quat, out: V3): V3 {
  // e = q⁻¹ ⊗ qTarget
  let x = q.w * qTarget.x - q.x * qTarget.w - q.y * qTarget.z + q.z * qTarget.y;
  let y = q.w * qTarget.y + q.x * qTarget.z - q.y * qTarget.w - q.z * qTarget.x;
  let z = q.w * qTarget.z - q.x * qTarget.y + q.y * qTarget.x - q.z * qTarget.w;
  let w = q.w * qTarget.w + q.x * qTarget.x + q.y * qTarget.y + q.z * qTarget.z;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.sqrt(x * x + y * y + z * z);
  const k = s > 1e-12 ? (2 * Math.atan2(s, w)) / s : 2;
  out.x = x * k; out.y = y * k; out.z = z * k;
  return out;
}

/** Rotation vector (craft-local axes, rad) of the shortest turn that points the nose (local -Z) along `dir` (world). */
export function pointingError(q: Quat, dir: V3, out: V3): V3 {
  qRotInv(T, q, dir.x, dir.y, dir.z);
  const l = Math.sqrt(T.x * T.x + T.y * T.y + T.z * T.z) || 1;
  const dx = T.x / l, dy = T.y / l, dz = T.z / l;
  // axis = (0,0,-1) × d = (dy, -dx, 0); cos = -dz
  const s = Math.sqrt(dx * dx + dy * dy);
  if (s < 1e-9) {
    out.x = 0; out.y = dz > 0 ? Math.PI : 0; out.z = 0;
    return out;
  }
  const k = Math.atan2(s, -dz) / s;
  out.x = dy * k; out.y = -dx * k; out.z = 0;
  return out;
}

/** Principal moments of inertia of a craft at its current mass, kg·m². */
export function craftInertia(c: Craft, out: V3): V3 {
  const m = c.dryMass + c.propellant;
  out.x = m * c.gyration.x; out.y = m * c.gyration.y; out.z = m * c.gyration.z;
  return out;
}

/**
 * Torque command (-1..1 per local axis) that drives the attitude error `err` (rotation vector, local axes)
 * and the body rates `w` to zero. Pass a zero error to damp rotation only.
 */
export function holdTorque(err: V3, w: V3, inertia: V3, maxTorque: V3, out: V3, maxRate = HOLD_MAX_RATE): V3 {
  const K = HOLD_RATE_GAIN, k = K / 4;
  const ax = maxTorque.x / inertia.x, ay = maxTorque.y / inertia.y, az = maxTorque.z / inertia.z;
  const alpha = Math.min(ax, ay, az);
  const th = Math.sqrt(err.x * err.x + err.y * err.y + err.z * err.z);
  let wdx = 0, wdy = 0, wdz = 0;
  if (th > 1e-9) {
    let rate = k * th;
    const brake = Math.sqrt(2 * HOLD_BRAKE * alpha * th);
    if (brake < rate) rate = brake;
    if (maxRate < rate) rate = maxRate;
    const s = rate / th;
    wdx = err.x * s; wdy = err.y * s; wdz = err.z * s;
  }
  // τ = I·K·(ω_des − ω) + ω × Iω
  const Lx = inertia.x * w.x, Ly = inertia.y * w.y, Lz = inertia.z * w.z;
  const tx = inertia.x * K * (wdx - w.x) + (w.y * Lz - w.z * Ly);
  const ty = inertia.y * K * (wdy - w.y) + (w.z * Lx - w.x * Lz);
  const tz = inertia.z * K * (wdz - w.z) + (w.x * Ly - w.y * Lx);
  out.x = maxTorque.x > 0 ? clamp1(tx / maxTorque.x) : 0;
  out.y = maxTorque.y > 0 ? clamp1(ty / maxTorque.y) : 0;
  out.z = maxTorque.z > 0 ? clamp1(tz / maxTorque.z) : 0;
  return out;
}
