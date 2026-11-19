// Compound collision shapes and rigid-body contact for craft: oriented boxes, capsules and spheres in craft-local
// axes (src/data/hullColliders.ts for ships, the station's sphere/capsule colliders for stations), a bounding sphere
// for the broad phase and a small AABB tree above 16 parts; narrow phase for compound vs compound (ship–station,
// ship–ship) and compound vs a body's surface (a sphere of the body's radius); persistent contact manifolds; and a
// sequential-impulse solver for two rigid bodies with full (principal) inertia: restitution by relative normal
// speed, Coulomb friction with a friction anchor, warm starting, and position correction by non-linear
// Gauss-Seidel on the poses (split from the velocities, so it never adds energy). The solver reports the impulse
// it applied and the kinetic energy it dissipated (what does damage).
//
// Conventions: SI; a pose maps local -> world (`p + q·x`); angular velocity `w` is in body-local axes (as Craft.w);
// the contact normal points from body B to body A; depth > 0 is penetration, depth < 0 a gap (speculative).
// Shapes are compiled once (cached); manifolds live in a ContactCache outside the saved world state (losing them
// on load only costs one step of warm start). Nothing here allocates per step, nothing throws, no randomness.

import type { Quat, StationCollider, V3 } from '../core/types';
import { HULL_COLLIDERS, type HullPartDef } from '../data/hullColliders';

// ================================================================================================ shapes

export const PART_SPHERE = 0;
export const PART_CAPSULE = 1;
export const PART_BOX = 2;
/** Floats per part in Compound.data. Round: a(3) b(3) r. Box: c(3) h(3) u0(3) u1(3) u2(3) (axes in craft axes). */
const PS = 16;

export interface Compound {
  n: number;
  kind: Int8Array;
  data: Float64Array;
  /** Part bounding spheres (cx, cy, cz, r) and AABBs (min xyz, max xyz), craft-local. */
  bs: Float64Array;
  aabb: Float64Array;
  /** Bounding sphere of the whole compound, craft-local. */
  cx: number;
  cy: number;
  cz: number;
  radius: number;
  /** AABB tree (null for <= 16 parts): per node left, right child (-1 for a leaf) and part index; node boxes. */
  tl: Int32Array | null;
  tr: Int32Array | null;
  tp: Int32Array | null;
  tb: Float64Array | null;
  names: string[];
}

const TREE_MIN = 16;

function partBoundsInto(kind: number, d: Float64Array, o: number, bs: Float64Array, bo: number, ab: Float64Array, ao: number): void {
  if (kind === PART_BOX) {
    const ex = Math.abs(d[o + 6]) * d[o + 3] + Math.abs(d[o + 9]) * d[o + 4] + Math.abs(d[o + 12]) * d[o + 5];
    const ey = Math.abs(d[o + 7]) * d[o + 3] + Math.abs(d[o + 10]) * d[o + 4] + Math.abs(d[o + 13]) * d[o + 5];
    const ez = Math.abs(d[o + 8]) * d[o + 3] + Math.abs(d[o + 11]) * d[o + 4] + Math.abs(d[o + 14]) * d[o + 5];
    ab[ao] = d[o] - ex; ab[ao + 1] = d[o + 1] - ey; ab[ao + 2] = d[o + 2] - ez;
    ab[ao + 3] = d[o] + ex; ab[ao + 4] = d[o + 1] + ey; ab[ao + 5] = d[o + 2] + ez;
    bs[bo] = d[o]; bs[bo + 1] = d[o + 1]; bs[bo + 2] = d[o + 2];
    bs[bo + 3] = Math.sqrt(d[o + 3] * d[o + 3] + d[o + 4] * d[o + 4] + d[o + 5] * d[o + 5]);
    return;
  }
  const r = d[o + 6];
  for (let k = 0; k < 3; k++) {
    ab[ao + k] = Math.min(d[o + k], d[o + 3 + k]) - r;
    ab[ao + 3 + k] = Math.max(d[o + k], d[o + 3 + k]) + r;
    bs[bo + k] = 0.5 * (d[o + k] + d[o + 3 + k]);
  }
  const hx = 0.5 * (d[o + 3] - d[o]), hy = 0.5 * (d[o + 4] - d[o + 1]), hz = 0.5 * (d[o + 5] - d[o + 2]);
  bs[bo + 3] = Math.sqrt(hx * hx + hy * hy + hz * hz) + r;
}

/** Compile part definitions into a compound. Invalid parts are skipped (never throws). */
export function compileCompound(parts: readonly HullPartDef[]): Compound {
  const good = parts.filter((p) => p && (p.kind === 'box' || p.kind === 'capsule' || p.kind === 'sphere'));
  const n = good.length;
  const kind = new Int8Array(n), data = new Float64Array(Math.max(1, n) * PS), bs = new Float64Array(Math.max(1, n) * 4), aabb = new Float64Array(Math.max(1, n) * 6);
  for (let i = 0; i < n; i++) {
    const p = good[i], o = i * PS;
    if (p.kind === 'box') {
      kind[i] = PART_BOX;
      data[o] = p.c[0]; data[o + 1] = p.c[1]; data[o + 2] = p.c[2];
      data[o + 3] = Math.abs(p.h[0]); data[o + 4] = Math.abs(p.h[1]); data[o + 5] = Math.abs(p.h[2]);
      let qx = 0, qy = 0, qz = 0, qw = 1;
      if (p.q) {
        const l = Math.hypot(p.q[0], p.q[1], p.q[2], p.q[3]) || 1;
        qx = p.q[0] / l; qy = p.q[1] / l; qz = p.q[2] / l; qw = p.q[3] / l;
      }
      // Columns of the rotation matrix = the box axes in craft axes.
      data[o + 6] = 1 - 2 * (qy * qy + qz * qz); data[o + 7] = 2 * (qx * qy + qz * qw); data[o + 8] = 2 * (qx * qz - qy * qw);
      data[o + 9] = 2 * (qx * qy - qz * qw); data[o + 10] = 1 - 2 * (qx * qx + qz * qz); data[o + 11] = 2 * (qy * qz + qx * qw);
      data[o + 12] = 2 * (qx * qz + qy * qw); data[o + 13] = 2 * (qy * qz - qx * qw); data[o + 14] = 1 - 2 * (qx * qx + qy * qy);
    } else if (p.kind === 'capsule') {
      kind[i] = PART_CAPSULE;
      data[o] = p.a[0]; data[o + 1] = p.a[1]; data[o + 2] = p.a[2];
      data[o + 3] = p.b[0]; data[o + 4] = p.b[1]; data[o + 5] = p.b[2];
      data[o + 6] = Math.abs(p.r);
    } else {
      kind[i] = PART_SPHERE;
      data[o] = data[o + 3] = p.c[0]; data[o + 1] = data[o + 4] = p.c[1]; data[o + 2] = data[o + 5] = p.c[2];
      data[o + 6] = Math.abs(p.r);
    }
    partBoundsInto(kind[i], data, o, bs, i * 4, aabb, i * 6);
  }
  // Bounding sphere about the centre of the overall AABB.
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    x0 = Math.min(x0, aabb[i * 6]); y0 = Math.min(y0, aabb[i * 6 + 1]); z0 = Math.min(z0, aabb[i * 6 + 2]);
    x1 = Math.max(x1, aabb[i * 6 + 3]); y1 = Math.max(y1, aabb[i * 6 + 4]); z1 = Math.max(z1, aabb[i * 6 + 5]);
  }
  const cx = n ? 0.5 * (x0 + x1) : 0, cy = n ? 0.5 * (y0 + y1) : 0, cz = n ? 0.5 * (z0 + z1) : 0;
  let radius = 0;
  for (let i = 0; i < n; i++) {
    const o = i * PS;
    if (kind[i] === PART_BOX) {
      for (let c = 0; c < 8; c++) {
        const sx = c & 1 ? 1 : -1, sy = c & 2 ? 1 : -1, sz = c & 4 ? 1 : -1;
        const vx = data[o] + sx * data[o + 3] * data[o + 6] + sy * data[o + 4] * data[o + 9] + sz * data[o + 5] * data[o + 12];
        const vy = data[o + 1] + sx * data[o + 3] * data[o + 7] + sy * data[o + 4] * data[o + 10] + sz * data[o + 5] * data[o + 13];
        const vz = data[o + 2] + sx * data[o + 3] * data[o + 8] + sy * data[o + 4] * data[o + 11] + sz * data[o + 5] * data[o + 14];
        radius = Math.max(radius, Math.hypot(vx - cx, vy - cy, vz - cz));
      }
    } else {
      const r = data[o + 6];
      radius = Math.max(radius, Math.hypot(data[o] - cx, data[o + 1] - cy, data[o + 2] - cz) + r, Math.hypot(data[o + 3] - cx, data[o + 4] - cy, data[o + 5] - cz) + r);
    }
  }
  const c: Compound = { n, kind, data, bs, aabb, cx, cy, cz, radius, tl: null, tr: null, tp: null, tb: null, names: good.map((p) => p.name) };
  if (n > TREE_MIN) buildTree(c);
  return c;
}

function buildTree(c: Compound): void {
  const n = c.n, max = 2 * n;
  const tl = new Int32Array(max), tr = new Int32Array(max), tp = new Int32Array(max), tb = new Float64Array(max * 6);
  let count = 0;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(i);
  const centre = (i: number, k: number): number => 0.5 * (c.aabb[i * 6 + k] + c.aabb[i * 6 + 3 + k]);
  const make = (list: number[]): number => {
    const node = count++;
    for (let k = 0; k < 3; k++) { tb[node * 6 + k] = Infinity; tb[node * 6 + 3 + k] = -Infinity; }
    for (const i of list) for (let k = 0; k < 3; k++) {
      tb[node * 6 + k] = Math.min(tb[node * 6 + k], c.aabb[i * 6 + k]);
      tb[node * 6 + 3 + k] = Math.max(tb[node * 6 + 3 + k], c.aabb[i * 6 + 3 + k]);
    }
    if (list.length === 1) { tl[node] = -1; tr[node] = -1; tp[node] = list[0]; return node; }
    let ax = 0, best = -1;
    for (let k = 0; k < 3; k++) {
      let lo = Infinity, hi = -Infinity;
      for (const i of list) { lo = Math.min(lo, centre(i, k)); hi = Math.max(hi, centre(i, k)); }
      if (hi - lo > best) { best = hi - lo; ax = k; }
    }
    const sorted = list.slice().sort((a, b) => centre(a, ax) - centre(b, ax) || a - b);
    const h = sorted.length >> 1;
    tp[node] = -1;
    tl[node] = make(sorted.slice(0, h));
    tr[node] = make(sorted.slice(h));
    return node;
  };
  make(idx);
  c.tl = tl; c.tr = tr; c.tp = tp; c.tb = tb;
}

const STACK = new Int32Array(128);
const LIST_A = new Int32Array(256);
const LIST_B = new Int32Array(256);

/** Parts of `c` whose AABB overlaps the box [x0..x1]×[y0..y1]×[z0..z1] (craft-local) -> out; returns the count. */
function queryBox(c: Compound, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, out: Int32Array): number {
  let m = 0;
  const ab = c.aabb;
  if (!c.tl) {
    for (let i = 0; i < c.n && m < out.length; i++) {
      const o = i * 6;
      if (ab[o] > x1 || ab[o + 3] < x0 || ab[o + 1] > y1 || ab[o + 4] < y0 || ab[o + 2] > z1 || ab[o + 5] < z0) continue;
      out[m++] = i;
    }
    return m;
  }
  const tl = c.tl, tr = c.tr!, tp = c.tp!, tb = c.tb!;
  let sp = 0;
  STACK[sp++] = 0;
  while (sp > 0) {
    const node = STACK[--sp], o = node * 6;
    if (tb[o] > x1 || tb[o + 3] < x0 || tb[o + 1] > y1 || tb[o + 4] < y0 || tb[o + 2] > z1 || tb[o + 5] < z0) continue;
    if (tl[node] < 0) { if (m < out.length) out[m++] = tp[node]; continue; }
    if (sp + 2 <= STACK.length) { STACK[sp++] = tl[node]; STACK[sp++] = tr[node]; }
  }
  return m;
}

const HULL_CACHE = new Map<string, Compound>();
/** The compiled compound of a hull (src/data/hullColliders.ts), cached; null for an unknown hull. */
export function hullCompound(id: string | null): Compound | null {
  if (!id) return null;
  let c = HULL_CACHE.get(id);
  if (!c) {
    const defs = (HULL_COLLIDERS as Record<string, HullPartDef[] | undefined>)[id];
    if (!defs) return null;
    c = compileCompound(defs);
    HULL_CACHE.set(id, c);
  }
  return c;
}

const STATION_CACHE = new WeakMap<readonly StationCollider[], Compound>();
/** A station's sphere / capsule colliders (station-local) as a compound, cached per colliders array. */
export function stationCompound(colliders: readonly StationCollider[]): Compound {
  let c = STATION_CACHE.get(colliders);
  if (!c) {
    const defs: HullPartDef[] = [];
    colliders.forEach((s, i) => {
      if (s.kind === 'capsule' && s.b) defs.push({ name: `col-${i}`, kind: 'capsule', a: [s.a.x, s.a.y, s.a.z], b: [s.b.x, s.b.y, s.b.z], r: s.radius });
      else defs.push({ name: `col-${i}`, kind: 'sphere', c: [s.a.x, s.a.y, s.a.z], r: s.radius });
    });
    c = compileCompound(defs);
    STATION_CACHE.set(colliders, c);
  }
  return c;
}

/** A single sphere (e.g. a craft with no hull compound: its bounding sphere). */
export function sphereCompound(radius: number): Compound {
  return compileCompound([{ name: 'sphere', kind: 'sphere', c: [0, 0, 0], r: radius }]);
}

/** Is the craft-local point inside the compound? */
export function compoundContains(c: Compound, x: number, y: number, z: number): boolean {
  const d = c.data;
  for (let i = 0; i < c.n; i++) {
    const o = i * PS;
    if (c.kind[i] === PART_BOX) {
      const px = x - d[o], py = y - d[o + 1], pz = z - d[o + 2];
      if (Math.abs(px * d[o + 6] + py * d[o + 7] + pz * d[o + 8]) <= d[o + 3] &&
        Math.abs(px * d[o + 9] + py * d[o + 10] + pz * d[o + 11]) <= d[o + 4] &&
        Math.abs(px * d[o + 12] + py * d[o + 13] + pz * d[o + 14]) <= d[o + 5]) return true;
    } else {
      segClosest(d[o], d[o + 1], d[o + 2], d[o + 3], d[o + 4], d[o + 5], x, y, z);
      const ex = x - _sx, ey = y - _sy, ez = z - _sz, r = d[o + 6];
      if (ex * ex + ey * ey + ez * ez <= r * r) return true;
    }
  }
  return false;
}

/**
 * Principal moments of inertia per unit mass (m²) of the compound as a uniform solid about the craft origin and
 * craft axes (overlaps counted twice, products of inertia ignored: the hulls are near-symmetric). For Craft.gyration.
 */
export function compoundGyration(c: Compound, out: V3): V3 {
  let V = 0, ix = 0, iy = 0, iz = 0;
  const d = c.data;
  for (let i = 0; i < c.n; i++) {
    const o = i * PS;
    let v: number, jx: number, jy: number, jz: number, px: number, py: number, pz: number;
    if (c.kind[i] === PART_BOX) {
      const a = d[o + 3], b = d[o + 4], e = d[o + 5];
      v = 8 * a * b * e;
      const k0 = (b * b + e * e) / 3, k1 = (a * a + e * e) / 3, k2 = (a * a + b * b) / 3;
      // Diagonal of R·diag(k)·Rᵀ.
      jx = d[o + 6] ** 2 * k0 + d[o + 9] ** 2 * k1 + d[o + 12] ** 2 * k2;
      jy = d[o + 7] ** 2 * k0 + d[o + 10] ** 2 * k1 + d[o + 13] ** 2 * k2;
      jz = d[o + 8] ** 2 * k0 + d[o + 11] ** 2 * k1 + d[o + 14] ** 2 * k2;
      px = d[o]; py = d[o + 1]; pz = d[o + 2];
    } else {
      // A capsule as a solid cylinder of length L + 4r/3 (same volume within a few per cent), axis u.
      const r = d[o + 6], ex = d[o + 3] - d[o], ey = d[o + 4] - d[o + 1], ez = d[o + 5] - d[o + 2];
      const L0 = Math.sqrt(ex * ex + ey * ey + ez * ez), L = L0 + (4 / 3) * r;
      v = Math.PI * r * r * L;
      const ux = L0 > 1e-9 ? ex / L0 : 0, uy = L0 > 1e-9 ? ey / L0 : 0, uz = L0 > 1e-9 ? ez / L0 : 0;
      const ka = 0.5 * r * r, kp = 0.25 * r * r + (L * L) / 12; // about the axis, about a perpendicular
      const sph = L0 <= 1e-9 ? 0.4 * r * r : -1;
      jx = sph >= 0 ? sph : kp + (ka - kp) * ux * ux;
      jy = sph >= 0 ? sph : kp + (ka - kp) * uy * uy;
      jz = sph >= 0 ? sph : kp + (ka - kp) * uz * uz;
      px = 0.5 * (d[o] + d[o + 3]); py = 0.5 * (d[o + 1] + d[o + 4]); pz = 0.5 * (d[o + 2] + d[o + 5]);
    }
    V += v;
    ix += v * (jx + py * py + pz * pz); iy += v * (jy + px * px + pz * pz); iz += v * (jz + px * px + py * py);
  }
  out.x = V > 0 ? ix / V : 0; out.y = V > 0 ? iy / V : 0; out.z = V > 0 ? iz / V : 0;
  return out;
}

// ================================================================================================ narrow phase

/** Contacts closer than this gap are kept (speculative), m. */
export const CONTACT_MARGIN = 0.05;
/** Points per manifold (a pair of craft). */
export const MAX_POINTS = 16;

// New contacts of the current collide() call, in A-local axes: pA (point of A deepest in B), n (B -> A), depth, parts.
const NB = 64, NS = 9;
const NEW = new Float64Array(NB * NS);
let _nNew = 0, _pa = 0, _pb = 0, _margin = CONTACT_MARGIN;

function emit(px: number, py: number, pz: number, nx: number, ny: number, nz: number, depth: number): void {
  if (!(depth > -_margin) || !Number.isFinite(px + py + pz + nx + ny + nz + depth)) return;
  let o: number;
  if (_nNew < NB) o = (_nNew++) * NS;
  else {
    // Full: replace the shallowest if this one is deeper.
    let w = 0;
    for (let i = 1; i < NB; i++) if (NEW[i * NS + 6] < NEW[w * NS + 6]) w = i;
    if (NEW[w * NS + 6] >= depth) return;
    o = w * NS;
  }
  NEW[o] = px; NEW[o + 1] = py; NEW[o + 2] = pz; NEW[o + 3] = nx; NEW[o + 4] = ny; NEW[o + 5] = nz;
  NEW[o + 6] = depth; NEW[o + 7] = _pa; NEW[o + 8] = _pb;
}

let _sx = 0, _sy = 0, _sz = 0, _st = 0;
/** Closest point on segment a-b to p -> (_sx, _sy, _sz), parameter _st. */
function segClosest(ax: number, ay: number, az: number, bx: number, by: number, bz: number, px: number, py: number, pz: number): void {
  const ex = bx - ax, ey = by - ay, ez = bz - az, l2 = ex * ex + ey * ey + ez * ez;
  let t = l2 > 1e-18 ? ((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  _st = t; _sx = ax + t * ex; _sy = ay + t * ey; _sz = az + t * ez;
}

let _s1 = 0, _s2 = 0;
/** Parameters of the closest points of segments p1-q1 and p2-q2 -> _s1, _s2 (Ericson, Real-Time Collision Detection 5.1.9). */
function segSeg(p1x: number, p1y: number, p1z: number, q1x: number, q1y: number, q1z: number, p2x: number, p2y: number, p2z: number, q2x: number, q2y: number, q2z: number): void {
  const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z, d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
  let s: number, t: number;
  if (a <= 1e-18 && e <= 1e-18) { _s1 = 0; _s2 = 0; return; }
  if (a <= 1e-18) { s = 0; t = f / e; t = t < 0 ? 0 : t > 1 ? 1 : t; }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-18) { t = 0; s = -c / a; s = s < 0 ? 0 : s > 1 ? 1 : s; }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z, den = a * e - b * b;
      s = den > 1e-12 * a * e ? (b * f - c * e) / den : 0;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = -c / a; s = s < 0 ? 0 : s > 1 ? 1 : s; }
      else if (t > 1) { t = 1; s = (b - c) / a; s = s < 0 ? 0 : s > 1 ? 1 : s; }
    }
  }
  _s1 = s; _s2 = t;
}

/** Any unit vector perpendicular to (x, y, z) -> (_px, _py, _pz). */
let _px = 0, _py = 0, _pz = 0;
function perp(x: number, y: number, z: number): void {
  if (Math.abs(x) < 0.57) { _px = 0; _py = z; _pz = -y; } else { _px = -z; _py = 0; _pz = x; }
  const l = Math.sqrt(_px * _px + _py * _py + _pz * _pz) || 1;
  _px /= l; _py /= l; _pz /= l;
}

/** Point p1 on round 1 vs segment a2-b2 radius r2: one contact (normal from 2 to 1). */
function pointRound(p1x: number, p1y: number, p1z: number, r1: number, a2x: number, a2y: number, a2z: number, b2x: number, b2y: number, b2z: number, r2: number): void {
  segClosest(a2x, a2y, a2z, b2x, b2y, b2z, p1x, p1y, p1z);
  let nx = p1x - _sx, ny = p1y - _sy, nz = p1z - _sz;
  const d = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (d > r1 + r2 + _margin) return;
  if (d > 1e-12) { nx /= d; ny /= d; nz /= d; } else { perp(b2x - a2x, b2y - a2y, b2z - a2z); nx = _px; ny = _py; nz = _pz; }
  emit(p1x - nx * r1, p1y - ny * r1, p1z - nz * r1, nx, ny, nz, r1 + r2 - d);
}

/** Round (segment + radius) of A vs round of B, both in the same frame. Parallel overlapping segments give two points. */
function roundRound(d1: Float64Array, o1: number, d2: Float64Array, o2: number): void {
  const a1x = d1[o1], a1y = d1[o1 + 1], a1z = d1[o1 + 2], b1x = d1[o1 + 3], b1y = d1[o1 + 4], b1z = d1[o1 + 5], r1 = d1[o1 + 6];
  const a2x = d2[o2], a2y = d2[o2 + 1], a2z = d2[o2 + 2], b2x = d2[o2 + 3], b2y = d2[o2 + 4], b2z = d2[o2 + 5], r2 = d2[o2 + 6];
  segSeg(a1x, a1y, a1z, b1x, b1y, b1z, a2x, a2y, a2z, b2x, b2y, b2z);
  const e1x = b1x - a1x, e1y = b1y - a1y, e1z = b1z - a1z, e2x = b2x - a2x, e2y = b2y - a2y, e2z = b2z - a2z;
  const c1x = a1x + e1x * _s1, c1y = a1y + e1y * _s1, c1z = a1z + e1z * _s1;
  const c2x = a2x + e2x * _s2, c2y = a2y + e2y * _s2, c2z = a2z + e2z * _s2;
  const dx = c1x - c2x, dy = c1y - c2y, dz = c1z - c2z, dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist > r1 + r2 + _margin) return;
  const L1 = Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z), L2 = Math.sqrt(e2x * e2x + e2y * e2y + e2z * e2z);
  if (L1 > 1e-6 && L2 > 1e-6) {
    const cr = Math.abs(e1x * e2x + e1y * e2y + e1z * e2z) / (L1 * L2);
    if (cr > 0.995) {
      // Nearly parallel: the overlap of segment 2 projected on segment 1, tested at both ends.
      const u = ((a2x - a1x) * e1x + (a2y - a1y) * e1y + (a2z - a1z) * e1z) / (L1 * L1);
      const v = ((b2x - a1x) * e1x + (b2y - a1y) * e1y + (b2z - a1z) * e1z) / (L1 * L1);
      const t0 = Math.max(0, Math.min(u, v)), t1 = Math.min(1, Math.max(u, v));
      if ((t1 - t0) * L1 > 0.05) {
        pointRound(a1x + e1x * t0, a1y + e1y * t0, a1z + e1z * t0, r1, a2x, a2y, a2z, b2x, b2y, b2z, r2);
        pointRound(a1x + e1x * t1, a1y + e1y * t1, a1z + e1z * t1, r1, a2x, a2y, a2z, b2x, b2y, b2z, r2);
        return;
      }
    }
  }
  let nx: number, ny: number, nz: number;
  if (dist > 1e-12) { nx = dx / dist; ny = dy / dist; nz = dz / dist; }
  else { perp(L1 > 1e-9 ? e1x : e2x, L1 > 1e-9 ? e1y : e2y, L1 > 1e-9 ? e1z : e2z); nx = _px; ny = _py; nz = _pz; if (L1 <= 1e-9 && L2 <= 1e-9) { nx = 0; ny = 1; nz = 0; } }
  emit(c1x - nx * r1, c1y - ny * r1, c1z - nz * r1, nx, ny, nz, r1 + r2 - dist);
}

// Box in its own frame for roundBox(): half extents, and the round's segment transformed into it.
let _bhx = 0, _bhy = 0, _bhz = 0;
let _cx = 0, _cy = 0, _cz = 0, _inside = false, _ik = 0, _is = 1;
/** Closest point of the (box-frame) box to p -> (_cx, _cy, _cz); _inside when p is inside (then _ik/_is = exit face). */
function boxClosest(px: number, py: number, pz: number): void {
  _cx = px < -_bhx ? -_bhx : px > _bhx ? _bhx : px;
  _cy = py < -_bhy ? -_bhy : py > _bhy ? _bhy : py;
  _cz = pz < -_bhz ? -_bhz : pz > _bhz ? _bhz : pz;
  _inside = _cx === px && _cy === py && _cz === pz;
  if (_inside) {
    const dx = _bhx - Math.abs(px), dy = _bhy - Math.abs(py), dz = _bhz - Math.abs(pz);
    if (dx <= dy && dx <= dz) { _ik = 0; _is = px >= 0 ? 1 : -1; }
    else if (dy <= dz) { _ik = 1; _is = py >= 0 ? 1 : -1; }
    else { _ik = 2; _is = pz >= 0 ? 1 : -1; }
  }
}

// Box frame (origin, axes) for transforming results back.
let _ox = 0, _oy = 0, _oz = 0, _ux = 0, _uy = 0, _uz = 0, _vx = 0, _vy = 0, _vz = 0, _wx = 0, _wy = 0, _wz = 0, _flip = false;
/** Emit a box-frame contact: point on the round (deepest in the box), normal from box to round, depth. */
function emitBoxFrame(px: number, py: number, pz: number, nx: number, ny: number, nz: number, depth: number): void {
  const X = _ox + px * _ux + py * _vx + pz * _wx, Y = _oy + px * _uy + py * _vy + pz * _wy, Z = _oz + px * _uz + py * _vz + pz * _wz;
  const NX = nx * _ux + ny * _vx + nz * _wx, NY = nx * _uy + ny * _vy + nz * _wy, NZ = nx * _uz + ny * _vz + nz * _wz;
  if (!_flip) emit(X, Y, Z, NX, NY, NZ, depth); // A is the round: normal box(B) -> round(A)
  else emit(X + NX * depth, Y + NY * depth, Z + NZ * depth, -NX, -NY, -NZ, depth); // A is the box
}

/** A point of the round's axis (box frame) with radius r vs the box. */
function pointBox(px: number, py: number, pz: number, r: number): void {
  boxClosest(px, py, pz);
  if (_inside) {
    const nx = _ik === 0 ? _is : 0, ny = _ik === 1 ? _is : 0, nz = _ik === 2 ? _is : 0;
    const pen = _ik === 0 ? _bhx - Math.abs(px) : _ik === 1 ? _bhy - Math.abs(py) : _bhz - Math.abs(pz);
    emitBoxFrame(px - nx * r, py - ny * r, pz - nz * r, nx, ny, nz, pen + r);
    return;
  }
  let nx = px - _cx, ny = py - _cy, nz = pz - _cz;
  const d = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (d > r + _margin) return;
  nx /= d; ny /= d; nz /= d;
  emitBoxFrame(px - nx * r, py - ny * r, pz - nz * r, nx, ny, nz, r - d);
}

/**
 * Round (dr, or) vs box (db, ob), same frame. `flip` false: A is the round; true: A is the box. Up to three points:
 * the closest point of the axis to the box and, when the axis lies along a face, the two ends of its overlap.
 */
function roundBox(dr: Float64Array, or: number, db: Float64Array, ob: number, flip: boolean): void {
  _flip = flip;
  _ox = db[ob]; _oy = db[ob + 1]; _oz = db[ob + 2];
  _bhx = db[ob + 3]; _bhy = db[ob + 4]; _bhz = db[ob + 5];
  _ux = db[ob + 6]; _uy = db[ob + 7]; _uz = db[ob + 8]; _vx = db[ob + 9]; _vy = db[ob + 10]; _vz = db[ob + 11]; _wx = db[ob + 12]; _wy = db[ob + 13]; _wz = db[ob + 14];
  const r = dr[or + 6];
  let x = dr[or] - _ox, y = dr[or + 1] - _oy, z = dr[or + 2] - _oz;
  const ax = x * _ux + y * _uy + z * _uz, ay = x * _vx + y * _vy + z * _vz, az = x * _wx + y * _wy + z * _wz;
  x = dr[or + 3] - _ox; y = dr[or + 4] - _oy; z = dr[or + 5] - _oz;
  const bx = x * _ux + y * _uy + z * _uz, by = x * _vx + y * _vy + z * _vz, bz = x * _wx + y * _wy + z * _wz;
  const ex = bx - ax, ey = by - ay, ez = bz - az, L2 = ex * ex + ey * ey + ez * ez, L = Math.sqrt(L2);
  if (L < 1e-9) { pointBox(ax, ay, az, r); return; }
  // Closest point of the axis to the box by alternating projection (converges fast for these convex pairs).
  segClosest(ax, ay, az, bx, by, bz, 0, 0, 0);
  let t = _st;
  for (let it = 0; it < 6; it++) {
    boxClosest(ax + ex * t, ay + ey * t, az + ez * t);
    if (_inside) break;
    segClosest(ax, ay, az, bx, by, bz, _cx, _cy, _cz);
    if (Math.abs(_st - t) < 1e-7) { t = _st; break; }
    t = _st;
  }
  const sx = ax + ex * t, sy = ay + ey * t, sz = az + ez * t;
  boxClosest(sx, sy, sz);
  if (_inside) {
    // The axis passes through the box: minimum-overlap axis among the 3 face normals and 3 face × axis directions.
    let best = Infinity, nx = 0, ny = 1, nz = 0;
    const ux = ex / L, uy = ey / L, uz = ez / L, mx = 0.5 * (ax + bx), my = 0.5 * (ay + by), mz = 0.5 * (az + bz);
    for (let k = 0; k < 6; k++) {
      let lx = k === 0 ? 1 : 0, ly = k === 1 ? 1 : 0, lz = k === 2 ? 1 : 0;
      if (k >= 3) {
        const fx = k === 3 ? 1 : 0, fy = k === 4 ? 1 : 0, fz = k === 5 ? 1 : 0;
        lx = fy * uz - fz * uy; ly = fz * ux - fx * uz; lz = fx * uy - fy * ux;
        const l = Math.sqrt(lx * lx + ly * ly + lz * lz);
        if (l < 1e-6) continue;
        lx /= l; ly /= l; lz /= l;
      }
      const rb = _bhx * Math.abs(lx) + _bhy * Math.abs(ly) + _bhz * Math.abs(lz);
      const rs = 0.5 * L * Math.abs(ux * lx + uy * ly + uz * lz);
      const dist = mx * lx + my * ly + mz * lz;
      const ov = rb + rs + r - Math.abs(dist);
      if (ov < best) { best = ov; const s = dist >= 0 ? 1 : -1; nx = lx * s; ny = ly * s; nz = lz * s; }
    }
    // Deepest axis point along -n.
    const da = ax * nx + ay * ny + az * nz, db2 = bx * nx + by * ny + bz * nz;
    const qx = Math.abs(da - db2) < 1e-6 ? sx : da < db2 ? ax : bx, qy = Math.abs(da - db2) < 1e-6 ? sy : da < db2 ? ay : by, qz = Math.abs(da - db2) < 1e-6 ? sz : da < db2 ? az : bz;
    emitBoxFrame(qx - nx * r, qy - ny * r, qz - nz * r, nx, ny, nz, best);
    return;
  }
  const dx = sx - _cx, dy = sy - _cy, dz = sz - _cz, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d > r + _margin) return;
  const nx = dx / d, ny = dy / d, nz = dz / d;
  // Axis along a face (perpendicular to the normal): clip it to the box's extent along the axis, two end points.
  const dn = Math.abs(ex * nx + ey * ny + ez * nz) / L;
  if (dn < 0.3) {
    const ux = ex / L, uy = ey / L, uz = ez / L;
    const ext = _bhx * Math.abs(ux) + _bhy * Math.abs(uy) + _bhz * Math.abs(uz), mid = -(ax * ux + ay * uy + az * uz);
    const t0 = Math.max(0, (mid - ext) / L), t1 = Math.min(1, (mid + ext) / L);
    if ((t1 - t0) * L > 0.05) {
      pointBox(ax + ex * t0, ay + ey * t0, az + ez * t0, r);
      pointBox(ax + ex * t1, ay + ey * t1, az + ez * t1, r);
      if ((t - t0) * L > 0.25 && (t1 - t) * L > 0.25) emitBoxFrame(sx - nx * r, sy - ny * r, sz - nz * r, nx, ny, nz, r - d);
      return;
    }
  }
  emitBoxFrame(sx - nx * r, sy - ny * r, sz - nz * r, nx, ny, nz, r - d);
}

// Box–box (SAT over 15 axes; vertex-in-box points for face axes, closest edge points for edge axes).
const BA = new Float64Array(15), BB = new Float64Array(15);
function boxVertexIn(px: number, py: number, pz: number, b: Float64Array, m: number): boolean {
  const x = px - b[0], y = py - b[1], z = pz - b[2];
  return Math.abs(x * b[6] + y * b[7] + z * b[8]) <= b[3] + m && Math.abs(x * b[9] + y * b[10] + z * b[11]) <= b[4] + m && Math.abs(x * b[12] + y * b[13] + z * b[14]) <= b[5] + m;
}
const boxRadius = (b: Float64Array, nx: number, ny: number, nz: number): number =>
  b[3] * Math.abs(nx * b[6] + ny * b[7] + nz * b[8]) + b[4] * Math.abs(nx * b[9] + ny * b[10] + nz * b[11]) + b[5] * Math.abs(nx * b[12] + ny * b[13] + nz * b[14]);

function boxBox(d1: Float64Array, o1: number, d2: Float64Array, o2: number): void {
  for (let i = 0; i < 15; i++) { BA[i] = d1[o1 + i]; BB[i] = d2[o2 + i]; }
  const tx = BA[0] - BB[0], ty = BA[1] - BB[1], tz = BA[2] - BB[2]; // B -> A
  let best = Infinity, bx = 0, by = 1, bz = 0, bestEdge = -1;
  for (let k = 0; k < 15; k++) {
    let lx: number, ly: number, lz: number;
    if (k < 3) { lx = BA[6 + 3 * k]; ly = BA[7 + 3 * k]; lz = BA[8 + 3 * k]; }
    else if (k < 6) { lx = BB[6 + 3 * (k - 3)]; ly = BB[7 + 3 * (k - 3)]; lz = BB[8 + 3 * (k - 3)]; }
    else {
      const i = ((k - 6) / 3) | 0, j = (k - 6) % 3;
      const ux = BA[6 + 3 * i], uy = BA[7 + 3 * i], uz = BA[8 + 3 * i], vx = BB[6 + 3 * j], vy = BB[7 + 3 * j], vz = BB[8 + 3 * j];
      lx = uy * vz - uz * vy; ly = uz * vx - ux * vz; lz = ux * vy - uy * vx;
      const l = Math.sqrt(lx * lx + ly * ly + lz * lz);
      if (l < 1e-5) continue;
      lx /= l; ly /= l; lz /= l;
    }
    const dist = tx * lx + ty * ly + tz * lz;
    const ov = boxRadius(BA, lx, ly, lz) + boxRadius(BB, lx, ly, lz) - Math.abs(dist);
    if (ov < -_margin) return; // separating axis
    // Prefer face axes: an edge axis must be clearly better.
    const score = k < 6 ? ov : ov * 1.05 + 0.01;
    if (score < best) { best = score; const s = dist >= 0 ? 1 : -1; bx = lx * s; by = ly * s; bz = lz * s; bestEdge = k < 6 ? -1 : k - 6; }
  }
  const nx = bx, ny = by, nz = bz;
  const depth = boxRadius(BA, nx, ny, nz) + boxRadius(BB, nx, ny, nz) - Math.abs(tx * nx + ty * ny + tz * nz);
  const before = _nNew;
  if (bestEdge < 0) {
    const maxB = BB[0] * nx + BB[1] * ny + BB[2] * nz + boxRadius(BB, nx, ny, nz);
    const minA = BA[0] * nx + BA[1] * ny + BA[2] * nz - boxRadius(BA, nx, ny, nz);
    for (let c = 0; c < 8; c++) {
      const sx = c & 1 ? 1 : -1, sy = c & 2 ? 1 : -1, sz = c & 4 ? 1 : -1;
      // Vertex of A inside B.
      let vx = BA[0] + sx * BA[3] * BA[6] + sy * BA[4] * BA[9] + sz * BA[5] * BA[12];
      let vy = BA[1] + sx * BA[3] * BA[7] + sy * BA[4] * BA[10] + sz * BA[5] * BA[13];
      let vz = BA[2] + sx * BA[3] * BA[8] + sy * BA[4] * BA[11] + sz * BA[5] * BA[14];
      if (boxVertexIn(vx, vy, vz, BB, _margin)) emit(vx, vy, vz, nx, ny, nz, maxB - (vx * nx + vy * ny + vz * nz));
      // Vertex of B inside A.
      vx = BB[0] + sx * BB[3] * BB[6] + sy * BB[4] * BB[9] + sz * BB[5] * BB[12];
      vy = BB[1] + sx * BB[3] * BB[7] + sy * BB[4] * BB[10] + sz * BB[5] * BB[13];
      vz = BB[2] + sx * BB[3] * BB[8] + sy * BB[4] * BB[11] + sz * BB[5] * BB[14];
      if (boxVertexIn(vx, vy, vz, BA, _margin)) {
        const dd = vx * nx + vy * ny + vz * nz - minA;
        emit(vx - nx * dd, vy - ny * dd, vz - nz * dd, nx, ny, nz, dd);
      }
    }
    if (_nNew > before) return;
  }
  // Edge–edge (or a face case without vertices inside): closest points of the supporting edges.
  const i = bestEdge >= 0 ? (bestEdge / 3) | 0 : 0, j = bestEdge >= 0 ? bestEdge % 3 : 0;
  let p1x = BA[0], p1y = BA[1], p1z = BA[2], p2x = BB[0], p2y = BB[1], p2z = BB[2];
  for (let k = 0; k < 3; k++) {
    const ux = BA[6 + 3 * k], uy = BA[7 + 3 * k], uz = BA[8 + 3 * k];
    if (k !== i || bestEdge < 0) { const s = ux * nx + uy * ny + uz * nz > 0 ? -1 : 1; p1x += s * BA[3 + k] * ux; p1y += s * BA[3 + k] * uy; p1z += s * BA[3 + k] * uz; }
    const vx = BB[6 + 3 * k], vy = BB[7 + 3 * k], vz = BB[8 + 3 * k];
    if (k !== j || bestEdge < 0) { const s = vx * nx + vy * ny + vz * nz > 0 ? 1 : -1; p2x += s * BB[3 + k] * vx; p2y += s * BB[3 + k] * vy; p2z += s * BB[3 + k] * vz; }
  }
  if (bestEdge < 0) { emit(p1x, p1y, p1z, nx, ny, nz, depth); return; }
  const hi = BA[3 + i], hj = BB[3 + j];
  const ux = BA[6 + 3 * i] * hi, uy = BA[7 + 3 * i] * hi, uz = BA[8 + 3 * i] * hi, vx = BB[6 + 3 * j] * hj, vy = BB[7 + 3 * j] * hj, vz = BB[8 + 3 * j] * hj;
  segSeg(p1x - ux, p1y - uy, p1z - uz, p1x + ux, p1y + uy, p1z + uz, p2x - vx, p2y - vy, p2z - vz, p2x + vx, p2y + vy, p2z + vz);
  const q1x = p1x - ux + 2 * ux * _s1, q1y = p1y - uy + 2 * uy * _s1, q1z = p1z - uz + 2 * uz * _s1;
  emit(q1x, q1y, q1z, nx, ny, nz, depth);
}

function partPair(ka: number, da: Float64Array, oa: number, kb: number, db: Float64Array, ob: number): void {
  if (ka !== PART_BOX) {
    if (kb !== PART_BOX) roundRound(da, oa, db, ob);
    else roundBox(da, oa, db, ob, false);
  } else if (kb !== PART_BOX) roundBox(db, ob, da, oa, true);
  else boxBox(da, oa, db, ob);
}

// ================================================================================================ bodies

/** A rigid body as the solver sees it. p, v, q, w may be the very objects of a Craft (rel, relV, q, w). */
export interface ContactBody {
  /** Centre of mass, and its velocity (any common frame, e.g. relative to the primary body). */
  p: V3;
  v: V3;
  /** Attitude local -> world, and angular velocity in local axes. */
  q: Quat;
  w: V3;
  /** 1 / mass (0 = immovable) and 1 / principal moments (local axes, 0 = no rotation). */
  invMass: number;
  invI: V3;
}

export function makeContactBody(): ContactBody {
  return { p: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 }, w: { x: 0, y: 0, z: 0 }, invMass: 0, invI: { x: 0, y: 0, z: 0 } };
}

interface CraftLike { rel: V3; relV: V3; q: Quat; w: V3; dryMass: number; propellant: number; gyration: V3 }
/** Point `out` at a craft's state (by reference: the solver then writes the craft directly) and its mass properties. */
export function bodyFromCraft(out: ContactBody, c: CraftLike): ContactBody {
  out.p = c.rel; out.v = c.relV; out.q = c.q; out.w = c.w;
  const m = c.dryMass + c.propellant;
  out.invMass = m > 0 ? 1 / m : 0;
  const g = c.gyration;
  out.invI.x = m > 0 && g.x > 0 ? 1 / (m * g.x) : 0;
  out.invI.y = m > 0 && g.y > 0 ? 1 / (m * g.y) : 0;
  out.invI.z = m > 0 && g.z > 0 ? 1 / (m * g.z) : 0;
  return out;
}

/**
 * Point `out` at an immovable spinning body (a planet) whose centre is `centre` (same frame as the craft, e.g. the
 * origin for craft integrated relative to it): attitude = rotation by `angle` about the unit `axis`, spin `rate`.
 */
export function planetBody(out: ContactBody, centre: V3, axis: V3, rate: number, angle: number): ContactBody {
  out.p = centre;
  out.v.x = out.v.y = out.v.z = 0;
  const s = Math.sin(0.5 * angle);
  out.q.x = axis.x * s; out.q.y = axis.y * s; out.q.z = axis.z * s; out.q.w = Math.cos(0.5 * angle);
  out.w.x = axis.x * rate; out.w.y = axis.y * rate; out.w.z = axis.z * rate;
  out.invMass = 0; out.invI.x = out.invI.y = out.invI.z = 0;
  return out;
}

/** Kinetic energy of a body (translation + rotation about principal axes), J. Infinite for immovable bodies -> 0. */
export function kineticEnergy(b: ContactBody): number {
  let e = 0;
  if (b.invMass > 0) e += (0.5 * (b.v.x * b.v.x + b.v.y * b.v.y + b.v.z * b.v.z)) / b.invMass;
  if (b.invI.x > 0) e += (0.5 * b.w.x * b.w.x) / b.invI.x;
  if (b.invI.y > 0) e += (0.5 * b.w.y * b.w.y) / b.invI.y;
  if (b.invI.z > 0) e += (0.5 * b.w.z * b.w.z) / b.invI.z;
  return e;
}

// Rotation matrices (row-major) of A and B, and B-local -> A-local transform.
const RA = new Float64Array(9), RB = new Float64Array(9), M = new Float64Array(9);
function qMat(q: Quat, R: Float64Array): void {
  const l = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w) || 1;
  const x = q.x / l, y = q.y / l, z = q.z / l, w = q.w / l;
  R[0] = 1 - 2 * (y * y + z * z); R[1] = 2 * (x * y - z * w); R[2] = 2 * (x * z + y * w);
  R[3] = 2 * (x * y + z * w); R[4] = 1 - 2 * (x * x + z * z); R[5] = 2 * (y * z - x * w);
  R[6] = 2 * (x * z - y * w); R[7] = 2 * (y * z + x * w); R[8] = 1 - 2 * (x * x + y * y);
}

// ================================================================================================ manifolds

// Per point (stride MS): 0-2 la (A-local point), 3-5 lb (B-local point), 6-8 nb (normal B-local, B -> A), 9 depth,
// 10 partA, 11 partB, 12 jn, 13 jt1, 14 jt2, 15-17 anchor (B-local), 18 anchored, then solver scratch (world):
// 19-21 rA, 22-24 rB, 25-33 n t1 t2, 34-36 1/K (n, t1, t2), 37 target vn, 38 active, 39-56 IA⁻¹(rA×d), 57-74 IB⁻¹(rB×d).
const MS = 76;

/** The persistent contact points of one pair of bodies. */
export class Manifold {
  n = 0;
  readonly d = new Float64Array(MAX_POINTS * MS);
  /** Step length of the last solve (warm-start scaling), s. */
  dtPrev = 0;
  /** Cache bookkeeping. */
  used = 0;
  /** Number of the part of A / B of point i (for the integrator: which part touched). */
  partA(i: number): number { return this.d[i * MS + 10]; }
  partB(i: number): number { return this.d[i * MS + 11]; }
  depth(i: number): number { return this.d[i * MS + 9]; }
  /** World position of point i (midpoint of the two surfaces) given the bodies -> out. */
  point(i: number, A: ContactBody, out: V3): V3 {
    const o = i * MS, d = this.d;
    qMat(A.q, RA);
    out.x = A.p.x + RA[0] * d[o] + RA[1] * d[o + 1] + RA[2] * d[o + 2];
    out.y = A.p.y + RA[3] * d[o] + RA[4] * d[o + 1] + RA[5] * d[o + 2];
    out.z = A.p.z + RA[6] * d[o] + RA[7] * d[o + 1] + RA[8] * d[o + 2];
    return out;
  }
  /** World contact normal of point i (B -> A) -> out. */
  normal(i: number, B: ContactBody, out: V3): V3 {
    const o = i * MS, d = this.d;
    qMat(B.q, RB);
    out.x = RB[0] * d[o + 6] + RB[1] * d[o + 7] + RB[2] * d[o + 8];
    out.y = RB[3] * d[o + 6] + RB[4] * d[o + 7] + RB[5] * d[o + 8];
    out.z = RB[6] * d[o + 6] + RB[7] * d[o + 7] + RB[8] * d[o + 8];
    return out;
  }
  /** Accumulated normal impulse of point i in the last solve, N·s. */
  normalImpulse(i: number): number { return this.d[i * MS + 12]; }
  clear(): void { this.n = 0; this.dtPrev = 0; }
}

const OLD = new Float64Array(MAX_POINTS * MS);
const MATCH2 = 0.2 * 0.2;

/** Replace the points of `m` by the NEW buffer, carrying impulses and anchors over from matching old points. */
function commit(m: Manifold, A: ContactBody, B: ContactBody): number {
  const d = m.d, oldN = m.n;
  for (let i = 0; i < oldN * MS; i++) OLD[i] = d[i];
  // Keep at most MAX_POINTS: the deepest.
  let n = _nNew;
  while (n > MAX_POINTS) {
    let w = 0;
    for (let i = 1; i < n; i++) if (NEW[i * NS + 6] < NEW[w * NS + 6]) w = i;
    for (let k = 0; k < NS; k++) NEW[w * NS + k] = NEW[(n - 1) * NS + k];
    n--;
  }
  qMat(A.q, RA); qMat(B.q, RB);
  for (let i = 0; i < n; i++) {
    const s = i * NS, o = i * MS;
    const lx = NEW[s], ly = NEW[s + 1], lz = NEW[s + 2], nx = NEW[s + 3], ny = NEW[s + 4], nz = NEW[s + 5], dep = NEW[s + 6];
    // World point of A and normal, then B-local.
    const wx = A.p.x + RA[0] * lx + RA[1] * ly + RA[2] * lz, wy = A.p.y + RA[3] * lx + RA[4] * ly + RA[5] * lz, wz = A.p.z + RA[6] * lx + RA[7] * ly + RA[8] * lz;
    const Nx = RA[0] * nx + RA[1] * ny + RA[2] * nz, Ny = RA[3] * nx + RA[4] * ny + RA[5] * nz, Nz = RA[6] * nx + RA[7] * ny + RA[8] * nz;
    const bx = wx + Nx * dep - B.p.x, by = wy + Ny * dep - B.p.y, bz = wz + Nz * dep - B.p.z;
    d[o] = lx; d[o + 1] = ly; d[o + 2] = lz;
    d[o + 3] = RB[0] * bx + RB[3] * by + RB[6] * bz; d[o + 4] = RB[1] * bx + RB[4] * by + RB[7] * bz; d[o + 5] = RB[2] * bx + RB[5] * by + RB[8] * bz;
    d[o + 6] = RB[0] * Nx + RB[3] * Ny + RB[6] * Nz; d[o + 7] = RB[1] * Nx + RB[4] * Ny + RB[7] * Nz; d[o + 8] = RB[2] * Nx + RB[5] * Ny + RB[8] * Nz;
    d[o + 9] = dep; d[o + 10] = NEW[s + 7]; d[o + 11] = NEW[s + 8];
    d[o + 12] = d[o + 13] = d[o + 14] = 0; d[o + 18] = 0;
    let bestK = -1, bestD = MATCH2;
    for (let k = 0; k < oldN; k++) {
      const q = k * MS;
      if (OLD[q + 10] !== d[o + 10] || OLD[q + 11] !== d[o + 11]) continue;
      const ex = OLD[q] - lx, ey = OLD[q + 1] - ly, ez = OLD[q + 2] - lz, dd = ex * ex + ey * ey + ez * ez;
      if (dd < bestD) { bestD = dd; bestK = k; }
    }
    if (bestK >= 0) {
      const q = bestK * MS;
      d[o + 12] = OLD[q + 12]; d[o + 13] = OLD[q + 13]; d[o + 14] = OLD[q + 14];
      d[o + 15] = OLD[q + 15]; d[o + 16] = OLD[q + 16]; d[o + 17] = OLD[q + 17]; d[o + 18] = OLD[q + 18];
      OLD[q + 10] = -1; // claimed
    }
  }
  m.n = n;
  return n;
}

// ================================================================================================ collide

const WP = new Float64Array(PS);

/**
 * Narrow phase of compound `ca` on body A against compound `cb` on body B (poses from the bodies). Updates the
 * persistent manifold `m` (points matched to the previous step keep their impulses for warm starting) and returns
 * the number of contact points (0 = apart). Gaps below `margin` count as speculative contacts.
 */
export function collide(ca: Compound, A: ContactBody, cb: Compound, B: ContactBody, m: Manifold, margin = CONTACT_MARGIN): number {
  _nNew = 0;
  _margin = margin > 0 ? margin : 0;
  if (ca.n === 0 || cb.n === 0) { m.n = 0; return 0; }
  qMat(A.q, RA); qMat(B.q, RB);
  // M = RAᵀ·RB maps B-local directions to A-local; t = RAᵀ(pB - pA).
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i * 3 + j] = RA[i] * RB[j] + RA[3 + i] * RB[3 + j] + RA[6 + i] * RB[6 + j];
  const dx = B.p.x - A.p.x, dy = B.p.y - A.p.y, dz = B.p.z - A.p.z;
  const tx = RA[0] * dx + RA[3] * dy + RA[6] * dz, ty = RA[1] * dx + RA[4] * dy + RA[7] * dz, tz = RA[2] * dx + RA[5] * dy + RA[8] * dz;
  // Broad phase: A's bounding sphere in B-local.
  const ax = ca.cx - tx, ay = ca.cy - ty, az = ca.cz - tz;
  const sx = M[0] * ax + M[3] * ay + M[6] * az, sy = M[1] * ax + M[4] * ay + M[7] * az, sz = M[2] * ax + M[5] * ay + M[8] * az;
  const bxr = cb.cx - sx, byr = cb.cy - sy, bzr = cb.cz - sz, reach = ca.radius + cb.radius + _margin;
  if (bxr * bxr + byr * byr + bzr * bzr > reach * reach) { m.n = 0; return 0; }
  const rr = ca.radius + _margin;
  const nb = queryBox(cb, sx - rr, sy - rr, sz - rr, sx + rr, sy + rr, sz + rr, LIST_B);
  for (let q = 0; q < nb; q++) {
    const j = LIST_B[q], bo = j * 4;
    const ex = cb.bs[bo] - sx, ey = cb.bs[bo + 1] - sy, ez = cb.bs[bo + 2] - sz, rj = cb.bs[bo + 3] + rr;
    if (ex * ex + ey * ey + ez * ez > rj * rj) continue;
    // Part j of B into A-local.
    const kb = cb.kind[j], o = j * PS, D = cb.data;
    const pts = kb === PART_BOX ? 1 : 2;
    for (let e = 0; e < pts; e++) {
      const x = D[o + 3 * e], y = D[o + 3 * e + 1], z = D[o + 3 * e + 2];
      WP[3 * e] = M[0] * x + M[1] * y + M[2] * z + tx;
      WP[3 * e + 1] = M[3] * x + M[4] * y + M[5] * z + ty;
      WP[3 * e + 2] = M[6] * x + M[7] * y + M[8] * z + tz;
    }
    if (kb === PART_BOX) {
      WP[3] = D[o + 3]; WP[4] = D[o + 4]; WP[5] = D[o + 5];
      for (let c = 0; c < 3; c++) {
        const x = D[o + 6 + 3 * c], y = D[o + 7 + 3 * c], z = D[o + 8 + 3 * c];
        WP[6 + 3 * c] = M[0] * x + M[1] * y + M[2] * z; WP[7 + 3 * c] = M[3] * x + M[4] * y + M[5] * z; WP[8 + 3 * c] = M[6] * x + M[7] * y + M[8] * z;
      }
    } else WP[6] = D[o + 6];
    // Its AABB in A-local, then A's parts that overlap it.
    let x0: number, y0: number, z0: number, x1: number, y1: number, z1: number;
    if (kb === PART_BOX) {
      const hx = Math.abs(WP[6]) * WP[3] + Math.abs(WP[9]) * WP[4] + Math.abs(WP[12]) * WP[5] + _margin;
      const hy = Math.abs(WP[7]) * WP[3] + Math.abs(WP[10]) * WP[4] + Math.abs(WP[13]) * WP[5] + _margin;
      const hz = Math.abs(WP[8]) * WP[3] + Math.abs(WP[11]) * WP[4] + Math.abs(WP[14]) * WP[5] + _margin;
      x0 = WP[0] - hx; x1 = WP[0] + hx; y0 = WP[1] - hy; y1 = WP[1] + hy; z0 = WP[2] - hz; z1 = WP[2] + hz;
    } else {
      const r = WP[6] + _margin;
      x0 = Math.min(WP[0], WP[3]) - r; x1 = Math.max(WP[0], WP[3]) + r;
      y0 = Math.min(WP[1], WP[4]) - r; y1 = Math.max(WP[1], WP[4]) + r;
      z0 = Math.min(WP[2], WP[5]) - r; z1 = Math.max(WP[2], WP[5]) + r;
    }
    const na = queryBox(ca, x0, y0, z0, x1, y1, z1, LIST_A);
    for (let s = 0; s < na; s++) {
      const i = LIST_A[s];
      _pa = i; _pb = j;
      partPair(ca.kind[i], ca.data, i * PS, kb, WP, 0);
    }
  }
  return commit(m, A, B);
}

/**
 * Narrow phase of compound `ca` on body A against the surface of a body: a sphere of `radius` about B.p (B from
 * planetBody()). Box corners and capsule ends touch it — so a hull rests on, or crashes with, its lowest points.
 */
export function collidePlanet(ca: Compound, A: ContactBody, B: ContactBody, radius: number, m: Manifold, margin = CONTACT_MARGIN): number {
  _nNew = 0;
  _margin = margin > 0 ? margin : 0;
  qMat(A.q, RA);
  const dx = B.p.x - A.p.x, dy = B.p.y - A.p.y, dz = B.p.z - A.p.z;
  // Centre of the body in A-local.
  const cx = RA[0] * dx + RA[3] * dy + RA[6] * dz, cy = RA[1] * dx + RA[4] * dy + RA[7] * dz, cz = RA[2] * dx + RA[5] * dy + RA[8] * dz;
  const ex = ca.cx - cx, ey = ca.cy - cy, ez = ca.cz - cz;
  if (Math.sqrt(ex * ex + ey * ey + ez * ez) - radius > ca.radius + _margin) { m.n = 0; return 0; }
  const D = ca.data;
  for (let i = 0; i < ca.n; i++) {
    const o = i * PS;
    _pa = i; _pb = 0;
    const bo = i * 4, fx = ca.bs[bo] - cx, fy = ca.bs[bo + 1] - cy, fz = ca.bs[bo + 2] - cz;
    if (Math.sqrt(fx * fx + fy * fy + fz * fz) - radius > ca.bs[bo + 3] + _margin) continue;
    if (ca.kind[i] === PART_BOX) {
      for (let c = 0; c < 8; c++) {
        const sx = c & 1 ? 1 : -1, sy = c & 2 ? 1 : -1, sz = c & 4 ? 1 : -1;
        const vx = D[o] + sx * D[o + 3] * D[o + 6] + sy * D[o + 4] * D[o + 9] + sz * D[o + 5] * D[o + 12];
        const vy = D[o + 1] + sx * D[o + 3] * D[o + 7] + sy * D[o + 4] * D[o + 10] + sz * D[o + 5] * D[o + 13];
        const vz = D[o + 2] + sx * D[o + 3] * D[o + 8] + sy * D[o + 4] * D[o + 11] + sz * D[o + 5] * D[o + 14];
        const ux = vx - cx, uy = vy - cy, uz = vz - cz, d = Math.sqrt(ux * ux + uy * uy + uz * uz);
        if (d > 0) emit(vx, vy, vz, ux / d, uy / d, uz / d, radius - d);
      }
    } else {
      const r = D[o + 6], ends = ca.kind[i] === PART_SPHERE ? 1 : 2;
      for (let e = 0; e < ends; e++) {
        const px = D[o + 3 * e], py = D[o + 3 * e + 1], pz = D[o + 3 * e + 2];
        const ux = px - cx, uy = py - cy, uz = pz - cz, d = Math.sqrt(ux * ux + uy * uy + uz * uz);
        if (d > 0) emit(px - (ux / d) * r, py - (uy / d) * r, pz - (uz / d) * r, ux / d, uy / d, uz / d, radius + r - d);
      }
    }
  }
  return commit(m, A, B);
}

// ================================================================================================ solver

export interface ContactParams {
  /** Coefficient of restitution, applied when the bodies approach faster than `restSpeed`. */
  restitution: number;
  restSpeed: number;
  /** Coulomb friction coefficient. */
  friction: number;
  /** Velocity and position iterations. */
  iterations: number;
  positionIterations: number;
  /** Penetration left alone (m), fraction of the rest corrected per step, largest correction per step (m). */
  slop: number;
  baumgarte: number;
  maxCorrection: number;
}

export const DEFAULT_CONTACT: ContactParams = {
  restitution: 0.2, restSpeed: 0.3, friction: 0.4, iterations: 10, positionIterations: 3, slop: 0.01, baumgarte: 0.3, maxCorrection: 0.2,
};

export interface ContactResult {
  /** Kinetic energy dissipated by the contact (>= 0), J — the damage hook. */
  energy: number;
  /** Total impulse on A (world axes; B got the opposite), N·s, and the angular impulse on A about its centre. */
  impulse: V3;
  angularImpulse: V3;
  /** Largest approach speed along a normal before the solve, m/s (for impact events / damage thresholds). */
  approachSpeed: number;
  /** Sum of the normal impulses, N·s, and the number of points that took part. */
  normalImpulse: number;
  points: number;
}

export function makeContactResult(): ContactResult {
  return { energy: 0, impulse: { x: 0, y: 0, z: 0 }, angularImpulse: { x: 0, y: 0, z: 0 }, approachSpeed: 0, normalImpulse: 0, points: 0 };
}

// World-space solver state of the pair.
const IA = new Float64Array(9), IB = new Float64Array(9);
let vax = 0, vay = 0, vaz = 0, wax = 0, way = 0, waz = 0, vbx = 0, vby = 0, vbz = 0, wbx = 0, wby = 0, wbz = 0;
let imA = 0, imB = 0, dE = 0, jx = 0, jy = 0, jz = 0, lx = 0, ly = 0, lz = 0;

function invInertiaWorld(R: Float64Array, inv: V3, out: Float64Array): void {
  // R·diag(inv)·Rᵀ
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[i * 3 + j] = R[i * 3] * inv.x * R[j * 3] + R[i * 3 + 1] * inv.y * R[j * 3 + 1] + R[i * 3 + 2] * inv.z * R[j * 3 + 2];
}

/** Relative velocity of point o (stride MS) along direction at offset `dd` (25 n, 28 t1, 31 t2). */
function relVel(d: Float64Array, o: number, dd: number): number {
  const rax = d[o + 19], ray = d[o + 20], raz = d[o + 21], rbx = d[o + 22], rby = d[o + 23], rbz = d[o + 24];
  const ux = vax + (way * raz - waz * ray) - vbx - (wby * rbz - wbz * rby);
  const uy = vay + (waz * rax - wax * raz) - vby - (wbz * rbx - wbx * rbz);
  const uz = vaz + (wax * ray - way * rax) - vbz - (wbx * rby - wby * rbx);
  return ux * d[o + dd] + uy * d[o + dd + 1] + uz * d[o + dd + 2];
}

/** Apply impulse lambda along direction k (0 n, 1 t1, 2 t2) of point o; track work and the impulse on A. */
function applyDir(d: Float64Array, o: number, k: number, lambda: number, u0: number): void {
  if (lambda === 0) return;
  const dd = o + 25 + 3 * k, ga = o + 39 + 3 * k, gb = o + 57 + 3 * k;
  const px = d[dd] * lambda, py = d[dd + 1] * lambda, pz = d[dd + 2] * lambda;
  vax += px * imA; vay += py * imA; vaz += pz * imA;
  wax += d[ga] * lambda; way += d[ga + 1] * lambda; waz += d[ga + 2] * lambda;
  vbx -= px * imB; vby -= py * imB; vbz -= pz * imB;
  wbx -= d[gb] * lambda; wby -= d[gb + 1] * lambda; wbz -= d[gb + 2] * lambda;
  dE += lambda * (u0 + (0.5 * lambda) / d[o + 34 + k]);
  jx += px; jy += py; jz += pz;
  const rax = d[o + 19], ray = d[o + 20], raz = d[o + 21];
  lx += ray * pz - raz * py; ly += raz * px - rax * pz; lz += rax * py - ray * px;
}

/**
 * Resolve the contact points of manifold `m` (from collide / collidePlanet with the same A, B) by sequential
 * impulses, then correct the remaining penetration on the poses. `dt` = time until the next solve (s; for
 * speculative contacts and warm-start scaling; 0 if unknown). Writes A and B (velocities, angular velocities,
 * poses) and fills `out`. Never throws; with no points it only clears `out`.
 */
export function solveManifold(m: Manifold, A: ContactBody, B: ContactBody, dt: number, prm: ContactParams, out: ContactResult): ContactResult {
  out.energy = 0; out.approachSpeed = 0; out.normalImpulse = 0; out.points = 0;
  out.impulse.x = out.impulse.y = out.impulse.z = 0; out.angularImpulse.x = out.angularImpulse.y = out.angularImpulse.z = 0;
  const n = m.n, d = m.d;
  if (n === 0) { m.dtPrev = dt; return out; }
  imA = A.invMass; imB = B.invMass;
  const movB = imB > 0 || B.invI.x > 0 || B.invI.y > 0 || B.invI.z > 0;
  qMat(A.q, RA); qMat(B.q, RB);
  invInertiaWorld(RA, A.invI, IA); invInertiaWorld(RB, B.invI, IB);
  vax = A.v.x; vay = A.v.y; vaz = A.v.z; vbx = B.v.x; vby = B.v.y; vbz = B.v.z;
  wax = RA[0] * A.w.x + RA[1] * A.w.y + RA[2] * A.w.z; way = RA[3] * A.w.x + RA[4] * A.w.y + RA[5] * A.w.z; waz = RA[6] * A.w.x + RA[7] * A.w.y + RA[8] * A.w.z;
  wbx = RB[0] * B.w.x + RB[1] * B.w.y + RB[2] * B.w.z; wby = RB[3] * B.w.x + RB[4] * B.w.y + RB[5] * B.w.z; wbz = RB[6] * B.w.x + RB[7] * B.w.y + RB[8] * B.w.z;
  dE = 0; jx = jy = jz = 0; lx = ly = lz = 0;
  const mu = prm.friction > 0 ? prm.friction : 0;
  const ws = m.dtPrev > 0 && dt > 0 ? Math.min(2, dt / m.dtPrev) : 1;
  // --- prestep
  let active = 0;
  for (let i = 0; i < n; i++) {
    const o = i * MS;
    const pax = A.p.x + RA[0] * d[o] + RA[1] * d[o + 1] + RA[2] * d[o + 2], pay = A.p.y + RA[3] * d[o] + RA[4] * d[o + 1] + RA[5] * d[o + 2], paz = A.p.z + RA[6] * d[o] + RA[7] * d[o + 1] + RA[8] * d[o + 2];
    const pbx = B.p.x + RB[0] * d[o + 3] + RB[1] * d[o + 4] + RB[2] * d[o + 5], pby = B.p.y + RB[3] * d[o + 3] + RB[4] * d[o + 4] + RB[5] * d[o + 5], pbz = B.p.z + RB[6] * d[o + 3] + RB[7] * d[o + 4] + RB[8] * d[o + 5];
    const nbx = d[o + 6], nby = d[o + 7], nbz = d[o + 8];
    const nx = RB[0] * nbx + RB[1] * nby + RB[2] * nbz, ny = RB[3] * nbx + RB[4] * nby + RB[5] * nbz, nz = RB[6] * nbx + RB[7] * nby + RB[8] * nbz;
    // Tangents built in B's frame (stable from step to step, so the accumulated friction impulses stay meaningful).
    perp(nbx, nby, nbz);
    const t1bx = _px, t1by = _py, t1bz = _pz;
    const t2bx = nby * t1bz - nbz * t1by, t2by = nbz * t1bx - nbx * t1bz, t2bz = nbx * t1by - nby * t1bx;
    d[o + 25] = nx; d[o + 26] = ny; d[o + 27] = nz;
    d[o + 28] = RB[0] * t1bx + RB[1] * t1by + RB[2] * t1bz; d[o + 29] = RB[3] * t1bx + RB[4] * t1by + RB[5] * t1bz; d[o + 30] = RB[6] * t1bx + RB[7] * t1by + RB[8] * t1bz;
    d[o + 31] = RB[0] * t2bx + RB[1] * t2by + RB[2] * t2bz; d[o + 32] = RB[3] * t2bx + RB[4] * t2by + RB[5] * t2bz; d[o + 33] = RB[6] * t2bx + RB[7] * t2by + RB[8] * t2bz;
    const mx = 0.5 * (pax + pbx), my = 0.5 * (pay + pby), mz = 0.5 * (paz + pbz);
    const rax = mx - A.p.x, ray = my - A.p.y, raz = mz - A.p.z, rbx = mx - B.p.x, rby = my - B.p.y, rbz = mz - B.p.z;
    d[o + 19] = rax; d[o + 20] = ray; d[o + 21] = raz; d[o + 22] = rbx; d[o + 23] = rby; d[o + 24] = rbz;
    const depth = -((pax - pbx) * nx + (pay - pby) * ny + (paz - pbz) * nz);
    d[o + 9] = depth;
    for (let k = 0; k < 3; k++) {
      const dx = d[o + 25 + 3 * k], dy = d[o + 26 + 3 * k], dz = d[o + 27 + 3 * k];
      const cax = ray * dz - raz * dy, cay = raz * dx - rax * dz, caz = rax * dy - ray * dx;
      const cbx = rby * dz - rbz * dy, cby = rbz * dx - rbx * dz, cbz = rbx * dy - rby * dx;
      const ga = o + 39 + 3 * k, gb = o + 57 + 3 * k;
      d[ga] = IA[0] * cax + IA[1] * cay + IA[2] * caz; d[ga + 1] = IA[3] * cax + IA[4] * cay + IA[5] * caz; d[ga + 2] = IA[6] * cax + IA[7] * cay + IA[8] * caz;
      d[gb] = IB[0] * cbx + IB[1] * cby + IB[2] * cbz; d[gb + 1] = IB[3] * cbx + IB[4] * cby + IB[5] * cbz; d[gb + 2] = IB[6] * cbx + IB[7] * cby + IB[8] * cbz;
      const K = imA + imB + cax * d[ga] + cay * d[ga + 1] + caz * d[ga + 2] + cbx * d[gb] + cby * d[gb + 1] + cbz * d[gb + 2];
      d[o + 34 + k] = K > 1e-30 ? 1 / K : 0;
    }
    const vn = relVel(d, o, 25);
    // Active when touching, or when the gap closes before the next solve (speculative).
    const on = d[o + 34] > 0 && (depth >= 0 || (dt > 0 && vn < 0 && -vn * dt >= -depth));
    d[o + 38] = on ? 1 : 0;
    if (!on) { d[o + 12] = d[o + 13] = d[o + 14] = 0; d[o + 18] = 0; continue; }
    active++;
    if (-vn > out.approachSpeed) out.approachSpeed = -vn;
    // Bounce when approaching faster than restSpeed (also for a gap that closes before the next solve, so the
    // restitution acts on the true impact speed); otherwise rest, or close a speculative gap exactly.
    d[o + 37] = vn < -prm.restSpeed ? -prm.restitution * vn : depth >= 0 ? 0 : depth / dt;
  }
  // --- warm start
  for (let i = 0; i < n; i++) {
    const o = i * MS;
    if (!d[o + 38]) continue;
    const jn = d[o + 12] * ws;
    let t1 = d[o + 13] * ws, t2 = d[o + 14] * ws;
    const tm = Math.sqrt(t1 * t1 + t2 * t2), lim = mu * jn;
    if (tm > lim) { const s = tm > 0 ? lim / tm : 0; t1 *= s; t2 *= s; }
    d[o + 12] = jn; d[o + 13] = t1; d[o + 14] = t2;
    applyDir(d, o, 0, jn, relVel(d, o, 25));
    applyDir(d, o, 1, t1, relVel(d, o, 28));
    applyDir(d, o, 2, t2, relVel(d, o, 31));
  }
  // --- velocity iterations
  const iters = prm.iterations > 0 ? prm.iterations : 1;
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      const o = i * MS;
      if (!d[o + 38]) continue;
      // Friction (2-D, clamped to the cone of the current normal impulse).
      const u1 = relVel(d, o, 28), u2 = relVel(d, o, 31);
      let n1 = d[o + 13] - u1 * d[o + 35], n2 = d[o + 14] - u2 * d[o + 36];
      const tm = Math.sqrt(n1 * n1 + n2 * n2), lim = mu * d[o + 12];
      if (tm > lim) { const s = tm > 0 ? lim / tm : 0; n1 *= s; n2 *= s; }
      const l1 = n1 - d[o + 13], l2 = n2 - d[o + 14];
      d[o + 13] = n1; d[o + 14] = n2;
      applyDir(d, o, 1, l1, u1);
      applyDir(d, o, 2, l2, relVel(d, o, 31));
      // Normal.
      const un = relVel(d, o, 25);
      const target = d[o + 37];
      const jn = Math.max(0, d[o + 12] + (target - un) * d[o + 34]);
      const ln = jn - d[o + 12];
      d[o + 12] = jn;
      applyDir(d, o, 0, ln, un);
    }
  }
  // Write velocities back (angular to local axes).
  A.v.x = vax; A.v.y = vay; A.v.z = vaz;
  A.w.x = RA[0] * wax + RA[3] * way + RA[6] * waz; A.w.y = RA[1] * wax + RA[4] * way + RA[7] * waz; A.w.z = RA[2] * wax + RA[5] * way + RA[8] * waz;
  if (movB) {
    B.v.x = vbx; B.v.y = vby; B.v.z = vbz;
    B.w.x = RB[0] * wbx + RB[3] * wby + RB[6] * wbz; B.w.y = RB[1] * wbx + RB[4] * wby + RB[7] * wbz; B.w.z = RB[2] * wbx + RB[5] * wby + RB[8] * wbz;
  }
  // Friction anchors: a sticking point remembers where it stuck (B-local); a sliding one forgets.
  let sumN = 0;
  for (let i = 0; i < n; i++) {
    const o = i * MS;
    if (!d[o + 38]) continue;
    sumN += d[o + 12];
    const t = Math.sqrt(d[o + 13] * d[o + 13] + d[o + 14] * d[o + 14]);
    if (d[o + 12] > 0 && t < 0.95 * mu * d[o + 12]) {
      if (!d[o + 18]) { d[o + 15] = d[o + 3]; d[o + 16] = d[o + 4]; d[o + 17] = d[o + 5]; d[o + 18] = 1; }
    } else d[o + 18] = 0;
  }
  // --- position correction (NGS on the poses; velocities untouched, so no energy is added)
  const pit = prm.positionIterations > 0 ? prm.positionIterations : 0;
  for (let it = 0; it < pit; it++) {
    qMat(A.q, RA); qMat(B.q, RB);
    invInertiaWorld(RA, A.invI, IA); invInertiaWorld(RB, B.invI, IB);
    for (let i = 0; i < n; i++) {
      const o = i * MS;
      if (!d[o + 38]) continue;
      const pax = A.p.x + RA[0] * d[o] + RA[1] * d[o + 1] + RA[2] * d[o + 2], pay = A.p.y + RA[3] * d[o] + RA[4] * d[o + 1] + RA[5] * d[o + 2], paz = A.p.z + RA[6] * d[o] + RA[7] * d[o + 1] + RA[8] * d[o + 2];
      const pbx = B.p.x + RB[0] * d[o + 3] + RB[1] * d[o + 4] + RB[2] * d[o + 5], pby = B.p.y + RB[3] * d[o + 3] + RB[4] * d[o + 4] + RB[5] * d[o + 5], pbz = B.p.z + RB[6] * d[o + 3] + RB[7] * d[o + 4] + RB[8] * d[o + 5];
      const nx = RB[0] * d[o + 6] + RB[1] * d[o + 7] + RB[2] * d[o + 8], ny = RB[3] * d[o + 6] + RB[4] * d[o + 7] + RB[5] * d[o + 8], nz = RB[6] * d[o + 6] + RB[7] * d[o + 7] + RB[8] * d[o + 8];
      const depth = -((pax - pbx) * nx + (pay - pby) * ny + (paz - pbz) * nz);
      let cx = 0, cy = 0, cz = 0;
      const corr = Math.min(prm.maxCorrection, prm.baumgarte * (depth - prm.slop));
      if (corr > 0) { cx = nx * corr; cy = ny * corr; cz = nz * corr; }
      if (d[o + 18]) {
        // Pull a sticking point back to its anchor (tangential part only).
        const qx = B.p.x + RB[0] * d[o + 15] + RB[1] * d[o + 16] + RB[2] * d[o + 17], qy = B.p.y + RB[3] * d[o + 15] + RB[4] * d[o + 16] + RB[5] * d[o + 17], qz = B.p.z + RB[6] * d[o + 15] + RB[7] * d[o + 16] + RB[8] * d[o + 17];
        let ex = qx - pbx, ey = qy - pby, ez = qz - pbz;
        const en = ex * nx + ey * ny + ez * nz;
        ex -= en * nx; ey -= en * ny; ez -= en * nz;
        const el = Math.sqrt(ex * ex + ey * ey + ez * ez), lim = 0.02;
        if (el > lim) { d[o + 18] = 0; } else { cx += prm.baumgarte * ex; cy += prm.baumgarte * ey; cz += prm.baumgarte * ez; }
      }
      const cl = Math.sqrt(cx * cx + cy * cy + cz * cz);
      if (cl < 1e-9) continue;
      const ux = cx / cl, uy = cy / cl, uz = cz / cl;
      const mx = 0.5 * (pax + pbx), my = 0.5 * (pay + pby), mz = 0.5 * (paz + pbz);
      const rax = mx - A.p.x, ray = my - A.p.y, raz = mz - A.p.z, rbx = mx - B.p.x, rby = my - B.p.y, rbz = mz - B.p.z;
      const cax = ray * uz - raz * uy, cay = raz * ux - rax * uz, caz = rax * uy - ray * ux;
      const cbx = rby * uz - rbz * uy, cby = rbz * ux - rbx * uz, cbz = rbx * uy - rby * ux;
      const gax = IA[0] * cax + IA[1] * cay + IA[2] * caz, gay = IA[3] * cax + IA[4] * cay + IA[5] * caz, gaz = IA[6] * cax + IA[7] * cay + IA[8] * caz;
      const gbx = IB[0] * cbx + IB[1] * cby + IB[2] * cbz, gby = IB[3] * cbx + IB[4] * cby + IB[5] * cbz, gbz = IB[6] * cbx + IB[7] * cby + IB[8] * cbz;
      const K = imA + imB + cax * gax + cay * gay + caz * gaz + cbx * gbx + cby * gby + cbz * gbz;
      if (!(K > 1e-30)) continue;
      const P = cl / K;
      A.p.x += ux * P * imA; A.p.y += uy * P * imA; A.p.z += uz * P * imA;
      rotateBy(A.q, gax * P, gay * P, gaz * P);
      if (movB) {
        B.p.x -= ux * P * imB; B.p.y -= uy * P * imB; B.p.z -= uz * P * imB;
        rotateBy(B.q, -gbx * P, -gby * P, -gbz * P);
      }
    }
  }
  m.dtPrev = dt;
  out.energy = dE < 0 ? -dE : 0;
  out.impulse.x = jx; out.impulse.y = jy; out.impulse.z = jz;
  out.angularImpulse.x = lx; out.angularImpulse.y = ly; out.angularImpulse.z = lz;
  out.normalImpulse = sumN;
  out.points = active;
  return out;
}

/** q <- rotation by the small world-axes rotation vector (x, y, z) applied after q; normalised. */
function rotateBy(q: Quat, x: number, y: number, z: number): void {
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  // dq = ½ (θ, 0) ⊗ q
  q.x = qx + 0.5 * (x * qw + y * qz - z * qy);
  q.y = qy + 0.5 * (y * qw + z * qx - x * qz);
  q.z = qz + 0.5 * (z * qw + x * qy - y * qx);
  q.w = qw + 0.5 * (-x * qx - y * qy - z * qz);
  const l = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w) || 1;
  q.x /= l; q.y /= l; q.z /= l; q.w /= l;
}

// ================================================================================================ cache

/** Manifolds per pair of bodies, keyed by object identity (e.g. the two Craft). Lives outside the saved state. */
export class ContactCache {
  private readonly map = new Map<object, Map<object, Manifold>>();
  private pass = 0;
  /** The manifold of the ordered pair (a, b), created on first use. */
  get(a: object, b: object): Manifold {
    let inner = this.map.get(a);
    if (!inner) { inner = new Map(); this.map.set(a, inner); }
    let m = inner.get(b);
    if (!m) { m = new Manifold(); inner.set(b, m); }
    m.used = this.pass + 1;
    return m;
  }
  /** Call once after each contact pass: forgets pairs that were not looked at in it. */
  sweep(): void {
    this.pass++;
    for (const [a, inner] of this.map) {
      for (const [b, m] of inner) if (m.used < this.pass) inner.delete(b);
      if (inner.size === 0) this.map.delete(a);
    }
  }
  clear(): void { this.map.clear(); }
}

/**
 * One contact pass for a pair: collide, then solve. Returns the number of points (0 = apart; `out` cleared).
 * The convenience entry point for world/contact.ts.
 */
export function contactPair(ca: Compound, A: ContactBody, cb: Compound, B: ContactBody, m: Manifold, dt: number, prm: ContactParams, out: ContactResult): number {
  const n = collide(ca, A, cb, B, m);
  solveManifold(m, A, B, dt, prm, out);
  return n;
}
