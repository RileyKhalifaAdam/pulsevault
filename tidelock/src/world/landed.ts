// Landed contact on a rotating body (docs/SIMULATION.md W2-C item 4): what the ground has to supply to keep a resting
// craft pinned, and whether it can. Lift-off when the needed normal force reaches zero (no position jump: the craft
// is released at its pinned pose with the ground's velocity), slide when the tangential load exceeds μ_s·F_n, tip
// when the centre of pressure leaves the support polygon of the hull's ground points. Sliding includes yaw: the
// friction of the support points also has to hold the moment about the normal, and force and yaw moment share the
// friction (elliptic limit surface: (Ft/μFn)² + (Mn/(μFn·r_eff))² ≤ 1, r_eff = mean distance of the support points
// from the centre of pressure, the pressure shared equally). Pure, allocation-free.
//
// WIRING (wave 2, contact.ts updateJoints 'landed' branch, every tick and every quantum while landed):
//   IO.n = local up (unit, world); IO.F = m·g_eff (W1-C landedProperAccel's gravity + centrifugal in the rotating
//   frame, times m) + the applied thrust and jet forces (world); IO.M = the applied torque about the CoM (world);
//   IO.h = CoM height above the ground plane; IO.pts/IO.n = the hull's ground support points (compoundSupport /
//   collidePlanet manifold points, ground-plane coordinates relative to the CoM foot, world axes).
//     flags = groundState(IO)
//   LIFT → release the joint as is (delete the `rel *= 1 + 0.01/r` snap; relV stays the ground velocity, so nothing
//   jumps), SLIDE → release into a rigid body in compound contact with friction (the compound solver), TIP → the same
//   (the contact solve then pivots it about the edge; also returned with no support points, np = 0, since nothing
//   holds the craft up), INVALID (a non-finite input) → keep the pin as it is and do nothing. Otherwise stay pinned.
//   Replaces the aUp > g − v²/r test.
// Reads nothing of §1.4; ≈ 0.1 µs per call in node for 4–8 support points.

import type { V3 } from '../core/types';

/** Static friction of a hull on regolith / rock. */
export const MU_S = 0.6;

export const GROUND_PIN = 0;
export const GROUND_SLIDE = 1;
export const GROUND_TIP = 2;
export const GROUND_LIFT = 4;
/** A non-finite input: the caller keeps the current state (never releases on NaN). */
export const GROUND_INVALID = 8;

const MAXP = 16;

export interface GroundIO {
  /** Unit ground normal (up), world. */
  n: V3;
  /** Net non-contact force on the craft (gravity in the rotating frame + thrust), N, and torque about the CoM, N·m. */
  F: V3;
  M: V3;
  /** CoM height above the ground plane, m. */
  h: number;
  /** Support points relative to the CoM's foot on the plane, world axes (3 per point), and their count. */
  pts: Float64Array;
  np: number;
  /** Outputs: normal force the ground must supply (N, ≤ 0 means none), tangential load (N), centre of pressure. */
  Fn: number;
  Ft: number;
  cop: V3;
  /** Outputs: yaw moment about the normal through the centre of pressure (N·m), friction lever r_eff (m). */
  Mn: number;
  rEff: number;
}

export function makeGroundIO(): GroundIO {
  return { n: { x: 0, y: 1, z: 0 }, F: { x: 0, y: 0, z: 0 }, M: { x: 0, y: 0, z: 0 }, h: 0, pts: new Float64Array(MAXP * 3), np: 0, Fn: 0, Ft: 0, cop: { x: 0, y: 0, z: 0 }, Mn: 0, rEff: 0 };
}

const P2 = new Float64Array(MAXP * 2);
const HULL = new Int16Array(MAXP + 1);

/**
 * Classify the resting contact: GROUND_LIFT, or GROUND_PIN | GROUND_SLIDE | GROUND_TIP flags. The centre of pressure
 * c (relative to the CoM foot) balances the moments: s = −n × (M + h·n × T)/F_n with T the tangential load.
 */
export function groundState(io: GroundIO): number {
  const n = io.n, F = io.F;
  io.Mn = 0; io.rEff = 0;
  if (!finiteIn(io)) { io.Fn = 0; io.Ft = 0; io.cop.x = io.cop.y = io.cop.z = 0; return GROUND_INVALID; }
  const fn = -(F.x * n.x + F.y * n.y + F.z * n.z);
  io.Fn = fn;
  const tx = F.x + fn * n.x, ty = F.y + fn * n.y, tz = F.z + fn * n.z;
  io.Ft = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (!(fn > 0)) { io.cop.x = io.cop.y = io.cop.z = 0; return GROUND_LIFT; }
  // m = M + h·(n × T)
  const h = io.h;
  const mx = io.M.x + h * (n.y * tz - n.z * ty), my = io.M.y + h * (n.z * tx - n.x * tz), mz = io.M.z + h * (n.x * ty - n.y * tx);
  const k = -1 / fn;
  const cx = k * (n.y * mz - n.z * my), cy = k * (n.z * mx - n.x * mz), cz = k * (n.x * my - n.y * mx);
  io.cop.x = cx; io.cop.y = cy; io.cop.z = cz;
  // yaw about the normal through the CoP: M·n + ((0 − c) × T)·n, and the friction lever of the support points
  const Mn = io.M.x * n.x + io.M.y * n.y + io.M.z * n.z - ((cy * tz - cz * ty) * n.x + (cz * tx - cx * tz) * n.y + (cx * ty - cy * tx) * n.z);
  io.Mn = Mn;
  const np = io.np < MAXP ? io.np : MAXP, pts = io.pts;
  let r = 0;
  for (let i = 0; i < np; i++) {
    let dx = pts[i * 3] - cx, dy = pts[i * 3 + 1] - cy, dz = pts[i * 3 + 2] - cz;
    const dn = dx * n.x + dy * n.y + dz * n.z;
    dx -= dn * n.x; dy -= dn * n.y; dz -= dn * n.z;
    r += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  const rEff = np > 0 ? r / np : 0;
  io.rEff = rEff;
  let flags = GROUND_PIN;
  const cap = MU_S * fn, f = io.Ft / cap, y = rEff > 0 ? Mn / (cap * rEff) : Mn !== 0 ? Infinity : 0;
  if (f * f + y * y > 1) flags |= GROUND_SLIDE;
  if (!insideSupport(io, cx, cy, cz)) flags |= GROUND_TIP;
  return flags;
}

function finiteIn(io: GroundIO): boolean {
  const { n, F, M } = io;
  if (!Number.isFinite(n.x + n.y + n.z + F.x + F.y + F.z + M.x + M.y + M.z + io.h)) return false;
  const np = io.np < MAXP ? io.np : MAXP;
  let s = 0;
  for (let i = 0; i < np * 3; i++) s += io.pts[i];
  return Number.isFinite(s);
}

/** Is the in-plane point inside the convex hull of the support points (projected on the plane)? */
function insideSupport(io: GroundIO, cx: number, cy: number, cz: number): boolean {
  const n = io.n, np = io.np < MAXP ? io.np : MAXP;
  if (np === 0) return false;
  // plane basis e1 = n × (x̂ or ŷ) normalised, e2 = n × e1
  const bx = Math.abs(n.x) < 0.9 ? 1 : 0, by = 1 - bx;
  let ex = n.y * 0 - n.z * by, ey = n.z * bx - n.x * 0, ez = n.x * by - n.y * bx;
  const l = Math.sqrt(ex * ex + ey * ey + ez * ez); ex /= l; ey /= l; ez /= l;
  const fx = n.y * ez - n.z * ey, fy = n.z * ex - n.x * ez, fz = n.x * ey - n.y * ex;
  const pts = io.pts;
  for (let i = 0; i < np; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
    P2[i * 2] = x * ex + y * ey + z * ez; P2[i * 2 + 1] = x * fx + y * fy + z * fz;
  }
  const px = cx * ex + cy * ey + cz * ez, py = cx * fx + cy * fy + cz * fz;
  // gift wrapping
  let start = 0;
  for (let i = 1; i < np; i++) if (P2[i * 2] < P2[start * 2] || (P2[i * 2] === P2[start * 2] && P2[i * 2 + 1] < P2[start * 2 + 1])) start = i;
  let m = 0, cur = start;
  do {
    HULL[m++] = cur;
    let nxt = (cur + 1) % np;
    for (let i = 0; i < np; i++) {
      const ax = P2[nxt * 2] - P2[cur * 2], ay = P2[nxt * 2 + 1] - P2[cur * 2 + 1];
      const bx = P2[i * 2] - P2[cur * 2], by = P2[i * 2 + 1] - P2[cur * 2 + 1];
      const cr = ax * by - ay * bx;
      if (cr < 0 || (cr === 0 && bx * bx + by * by > ax * ax + ay * ay)) nxt = i;
    }
    cur = nxt;
  } while (cur !== start && m < MAXP);
  if (m < 3) return false;
  // counter-clockwise hull: inside iff left of (or on) every edge
  for (let i = 0; i < m; i++) {
    const a = HULL[i], b = HULL[(i + 1) % m];
    const ax = P2[b * 2] - P2[a * 2], ay = P2[b * 2 + 1] - P2[a * 2 + 1];
    if (ax * (py - P2[a * 2 + 1]) - ay * (px - P2[a * 2]) < -1e-12) return false;
  }
  return true;
}
