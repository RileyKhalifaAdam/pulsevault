// Allocation-free vector / quaternion helpers for the stepping loops of the physical world.
import type { Quat, V3 } from '../core/types';

/** out = q · (x, y, z): rotate a vector by a unit quaternion. */
export function qRot(out: V3, q: Quat, x: number, y: number, z: number): V3 {
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

/** out = q⁻¹ · (x, y, z). */
export function qRotInv(out: V3, q: Quat, x: number, y: number, z: number): V3 {
  const qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

/** out = a ⊗ b (apply b first, then a). out may alias a or b. */
export function qMulTo(out: Quat, a: Quat, b: Quat): Quat {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  out.x = x; out.y = y; out.z = z; out.w = w;
  return out;
}

/** out = a⁻¹ ⊗ b. */
export function qConjMulTo(out: Quat, a: Quat, b: Quat): Quat {
  const ax = -a.x, ay = -a.y, az = -a.z, aw = a.w;
  const x = aw * b.x + ax * b.w + ay * b.z - az * b.y;
  const y = aw * b.y - ax * b.z + ay * b.w + az * b.x;
  const z = aw * b.z + ax * b.y - ay * b.x + az * b.w;
  const w = aw * b.w - ax * b.x - ay * b.y - az * b.z;
  out.x = x; out.y = y; out.z = z; out.w = w;
  return out;
}

/** Quaternion of a rotation by `angle` about the unit `axis`. */
export function qAxisTo(out: Quat, axis: V3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  out.x = axis.x * s; out.y = axis.y * s; out.z = axis.z * s; out.w = Math.cos(angle / 2);
  return out;
}

/** out = (x, y, z) rotated by `angle` about the unit `axis` (Rodrigues). */
export function rotAxis(out: V3, axis: V3, angle: number, x: number, y: number, z: number): V3 {
  const c = Math.cos(angle), s = Math.sin(angle);
  const d = (axis.x * x + axis.y * y + axis.z * z) * (1 - c);
  const cx = axis.y * z - axis.z * y, cy = axis.z * x - axis.x * z, cz = axis.x * y - axis.y * x;
  out.x = x * c + cx * s + axis.x * d;
  out.y = y * c + cy * s + axis.y * d;
  out.z = z * c + cz * s + axis.z * d;
  return out;
}

export const clamp1 = (x: number): number => (x < -1 ? -1 : x > 1 ? 1 : x);
export const perfNow = (): number => performance.now();
