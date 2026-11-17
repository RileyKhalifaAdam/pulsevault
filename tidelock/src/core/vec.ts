// Double-precision vector / quaternion helpers on plain objects.
// V3 and Quat are structurally compatible with THREE.Vector3 / THREE.Quaternion (x, y, z[, w]),
// so results can be passed to `.copy()` / `.set()` on Three objects.
//
// Functions returning a vector allocate a new object unless they take an explicit `out` argument.
// Hot loops should use the `...To(out, ...)` variants.

import type { Quat, V3 } from './types';

export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
export const clone = (a: V3): V3 => ({ x: a.x, y: a.y, z: a.z });
export const set = (out: V3, x: number, y: number, z: number): V3 => {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
};
export const copyTo = (out: V3, a: V3): V3 => set(out, a.x, a.y, a.z);

export const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const neg = (a: V3): V3 => ({ x: -a.x, y: -a.y, z: -a.z });
/** a + b * s */
export const addScaled = (a: V3, b: V3, s: number): V3 => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s });
export const lerp = (a: V3, b: V3, t: number): V3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });

export const addTo = (out: V3, a: V3, b: V3): V3 => set(out, a.x + b.x, a.y + b.y, a.z + b.z);
export const subTo = (out: V3, a: V3, b: V3): V3 => set(out, a.x - b.x, a.y - b.y, a.z - b.z);
export const scaleTo = (out: V3, a: V3, s: number): V3 => set(out, a.x * s, a.y * s, a.z * s);
export const addScaledTo = (out: V3, a: V3, b: V3, s: number): V3 => set(out, a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);

export const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const crossTo = (out: V3, a: V3, b: V3): V3 =>
  set(out, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

export const lenSq = (a: V3): number => a.x * a.x + a.y * a.y + a.z * a.z;
export const len = (a: V3): number => Math.sqrt(lenSq(a));
export const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const distSq = (a: V3, b: V3): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};
/** Unit vector; returns (0,0,0) for a zero vector. */
export const norm = (a: V3): V3 => {
  const l = len(a);
  return l > 0 ? scale(a, 1 / l) : v3();
};
/** Angle between two vectors, 0..π. */
export const angleBetween = (a: V3, b: V3): number => {
  const d = len(a) * len(b);
  return d > 0 ? Math.acos(Math.min(1, Math.max(-1, dot(a, b) / d))) : 0;
};
/** Component of `a` perpendicular to unit vector `n`. */
export const reject = (a: V3, n: V3): V3 => addScaled(a, n, -dot(a, n));
/** Any unit vector perpendicular to `a`. */
export const anyPerpendicular = (a: V3): V3 => {
  const ref = Math.abs(a.y) < 0.9 ? Y_AXIS : X_AXIS;
  return norm(cross(a, ref));
};
export const isFiniteV = (a: V3): boolean => Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);

export const X_AXIS: Readonly<V3> = Object.freeze({ x: 1, y: 0, z: 0 });
export const Y_AXIS: Readonly<V3> = Object.freeze({ x: 0, y: 1, z: 0 });
export const Z_AXIS: Readonly<V3> = Object.freeze({ x: 0, y: 0, z: 1 });
export const ZERO: Readonly<V3> = Object.freeze({ x: 0, y: 0, z: 0 });
/** Ship-local axes (see docs/ARCHITECTURE.md): forward is -Z, up is +Y, right is +X. */
export const SHIP_FORWARD: Readonly<V3> = Object.freeze({ x: 0, y: 0, z: -1 });
export const SHIP_UP: Readonly<V3> = Y_AXIS;
export const SHIP_RIGHT: Readonly<V3> = X_AXIS;

// ---------- quaternions (local -> world) ----------

export const quat = (x = 0, y = 0, z = 0, w = 1): Quat => ({ x, y, z, w });
export const qClone = (q: Quat): Quat => ({ x: q.x, y: q.y, z: q.z, w: q.w });
export const qIdentity = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });

export const qNormalize = (q: Quat): Quat => {
  const l = Math.hypot(q.x, q.y, q.z, q.w);
  return l > 0 ? { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l } : qIdentity();
};
export const qConj = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

/** Hamilton product a*b: applies b first, then a. */
export const qMul = (a: Quat, b: Quat): Quat => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});

export const qFromAxisAngle = (axis: V3, angle: number): Quat => {
  const n = norm(axis);
  const s = Math.sin(angle / 2);
  return { x: n.x * s, y: n.y * s, z: n.z * s, w: Math.cos(angle / 2) };
};

/** Rotate vector v by quaternion q. */
export const qRotate = (q: Quat, v: V3): V3 => {
  const { x, y, z, w } = q;
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return {
    x: v.x + w * tx + (y * tz - z * ty),
    y: v.y + w * ty + (z * tx - x * tz),
    z: v.z + w * tz + (x * ty - y * tx),
  };
};

/** Shortest-arc quaternion rotating unit vector `from` onto unit vector `to`. */
export const qFromTo = (from: V3, to: V3): Quat => {
  const d = dot(from, to);
  if (d > 0.999999) return qIdentity();
  if (d < -0.999999) return qFromAxisAngle(anyPerpendicular(from), Math.PI);
  const c = cross(from, to);
  return qNormalize({ x: c.x, y: c.y, z: c.z, w: 1 + d });
};

/**
 * Orientation whose ship-forward (-Z) points along `forward` and whose ship-up (+Y) is as close as
 * possible to `up`.
 */
export const qLook = (forward: V3, up: V3 = Y_AXIS): Quat => {
  const f = norm(forward);
  let r = cross(f, up);
  if (lenSq(r) < 1e-12) r = anyPerpendicular(f);
  r = norm(r);
  const u = cross(r, f);
  // Rotation matrix columns: right, up, back (= -forward).
  const m00 = r.x, m01 = u.x, m02 = -f.x;
  const m10 = r.y, m11 = u.y, m12 = -f.y;
  const m20 = r.z, m21 = u.z, m22 = -f.z;
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = { w: s / 4, x: (m21 - m12) / s, y: (m02 - m20) / s, z: (m10 - m01) / s };
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = { w: (m21 - m12) / s, x: s / 4, y: (m01 + m10) / s, z: (m02 + m20) / s };
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = { w: (m02 - m20) / s, x: (m01 + m10) / s, y: s / 4, z: (m12 + m21) / s };
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: s / 4 };
  }
  return qNormalize(q);
};

/** Spherical interpolation. */
export const qSlerp = (a: Quat, b: Quat, t: number): Quat => {
  let cos = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  if (cos < 0) {
    cos = -cos;
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  if (cos > 0.9995) {
    return qNormalize({ x: a.x + (bx - a.x) * t, y: a.y + (by - a.y) * t, z: a.z + (bz - a.z) * t, w: a.w + (bw - a.w) * t });
  }
  const theta = Math.acos(cos);
  const s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return { x: a.x * wa + bx * wb, y: a.y * wa + by * wb, z: a.z * wa + bz * wb, w: a.w * wa + bw * wb };
};

/** Integrate orientation q by body-frame angular velocity w (rad/s, ship-local axes) over dt. */
export const qIntegrate = (q: Quat, wLocal: V3, dt: number): Quat => {
  const angle = len(wLocal) * dt;
  if (angle < 1e-12) return q;
  return qNormalize(qMul(q, qFromAxisAngle(wLocal, angle)));
};

// ---------- scalars ----------

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const TAU = Math.PI * 2;
/** Wrap an angle to [0, 2π). */
export const wrapTau = (a: number): number => ((a % TAU) + TAU) % TAU;
/** Wrap an angle to (-π, π]. */
export const wrapPi = (a: number): number => {
  const w = wrapTau(a);
  return w > Math.PI ? w - TAU : w;
};
