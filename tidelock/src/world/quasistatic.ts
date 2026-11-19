// W1-C quasi-static loose bodies (docs/SIMULATION.md §2 W1-C item 6): the rest and drift modes in closed form and
// the drift/rest scheduler, so loose objects (and the crew body) never block sleep warp. Pure TypeScript,
// deterministic, allocation-free per call, plain-JSON state, SI units, ticks of Q = 1/120 s as integers.
//
// Three modes per body:
//   CONTACT  stepped at Q by the existing solver (props.ts `sub`, crew.ts `sub`). Not handled here.
//   REST     at rest on a surface (v_rel < 1e-3 m/s) inside the friction cone of the felt acceleration. It wakes
//            only when the felt acceleration leaves that cone by more than REST_WAKE_A = 1e-4 m/s². Slow forces
//            (tides, gravity gradient: ~1e-5 m/s² in the cabin, wave 2) stay inside that margin, so they never
//            keep a body awake; their rate bound `fDot` only schedules the next re-check (restWakeTicks).
//   DRIFT    touching nothing: x(t) = x₀ + v₀t − ½a_s t² − D(t)û₀ in the ship's CoM-centred inertial frame, with
//            cabin-air drag in closed form along the air-relative velocity, |u|(t) = |u₀|/(1 + k|u₀|t),
//            D(t) = |u₀|t − ln(1 + k|u₀|t)/k. Segments end at the first tick where a rigorous bound says the
//            body might touch something (or after 5 s, or 0.1/n): then it is re-anchored, or handed to CONTACT.
// The anchor (x₀, v₀, a_s, u₀, tick₀, tickEnd) and the rest normal are saved, so save → load → step is
// bit-identical, and the step sequence depends only on the state (never on the frame budget).
//
// WIRING (wave 1):
// - props.ts: give PropBody a `qs: QsState` (createQsState(); loadQsState on load: old saves get CONTACT,
//   which re-derives the mode within a tick). Build a QsWorld once per layout: boxes = rt.sb / rt.ns,
//   r = rt.bound, k = dragK(CdA, mass) (cdaOf below until src/data/props.ts carries C_dA), mu = rt.mu.
// - props.ts `stepProps` per tick (after consumeLedger, applyShipJump): serviceBodies(bodies, qw, tick, motion,
//   craft.q) — it moves every DRIFT body to its closed-form position (ship frame), re-anchors at segment ends,
//   hands bodies to CONTACT and wakes RESTing bodies whose cone broke. Then the existing sub-steps run only over
//   bodies with mode CONTACT (plus those they touch: the awake-island list). After the contact sub-steps, for each
//   CONTACT body: afterContact(b, i, qw, tick, motion, craft.q, touching, supportNormal) — it enters REST or
//   DRIFT. This replaces `asleep`/`still`/SLEEP_* and FLOAT_* and the global wake tests (WAKE_DA, WAKE_DW, α²).
//   In the CONTACT sub-step, drag: dragStep(b.v, k, h). DRIFT bodies' rotation: keep the existing midpoint
//   rotation update (rotQ), stepped at ≤ ROT_STEP/|ω| (rotation is not in closed form here; see report).
// - W1-A's tick loop: q_next = min(warp quantum, nextBodyEvent(bodies, tick, maxTicks)) ticks; a result of 1
//   with bodyEventWhy === WHY_CONTACT is `limitedBy: 'props'` (or 'crew' for the crew body).
// - The crew body uses the same three modes (a QsBody with r = CREW_RADIUS, k from C_dA 0.6 m², μ 0.7).

import type { Quat, V3 } from '../core/types';
import { feltAt } from './crew';
import type { BodyMotion } from './body';

const mlog1p = (x: number): number => Math.log1p(x);

export const Q = 1 / 120;
export const MODE_CONTACT = 0;
export const MODE_REST = 1;
export const MODE_DRIFT = 2;
/** Rest: speed limit (m/s), wake margin outside the friction cone (m/s²), entry margin (half of it: hysteresis). */
export const REST_V = 1e-3;
export const REST_WAKE_A = 1e-4;
export const REST_ENTER_A = 0.5e-4;
/** Drift segment caps: at most 5 s, at most 0.1/n (n = orbital mean motion). */
export const DRIFT_MAX = 5;
export const DRIFT_N = 0.1;
/**
 * Penetration a drifting body may reach before CONTACT takes it, m: the contact solver's own slop (props.ts SLOP).
 * It lets a body slide along a surface it touches without being pinned to Q by rounding.
 */
export const DRIFT_SLOP = 5e-4;
/** A segment shorter than this many ticks hands the body to CONTACT. */
export const DRIFT_MIN_TICKS = 2;
/** Cabin air density until W2-D's cabin model supplies it, kg/m³. */
export const RHO_CABIN = 1.2;
/** A schedule this far ahead means "never", ticks. */
export const NEVER = 2 ** 52;

export interface QsState {
  mode: number;
  /** REST: unit normal of the supporting surface (craft axes, out of the surface). */
  n: V3;
  /** DRIFT anchor, inertial axes, origin at the ship's CoM: position, velocity, the ship's proper acceleration
   * (frozen on the segment) and the air-relative velocity at the anchor. */
  x0: V3;
  v0: V3;
  aS: V3;
  u0: V3;
  /** Anchor tick and the tick at which the segment (or the rest re-check) ends. */
  tick0: number;
  tickEnd: number;
  /** Rotation-rate and angular-acceleration magnitudes the schedule was made for (a larger one re-schedules). */
  wB: number;
  alB: number;
}

/** Anything that can drift or rest: centre position and velocity relative to the ship (craft axes) and its mode. */
export interface QsBody {
  p: V3;
  v: V3;
  qs: QsState;
}

/** The static geometry and per-body constants (built once per layout; typed arrays). */
export interface QsWorld {
  /** Static boxes: minX, minY, minZ, maxX, maxY, maxZ (craft axes). */
  boxes: Float64Array;
  nBoxes: number;
  /** Bounding radius (m), drag constant k = ρ·C_dA/(2m) (1/m), static friction μ_s, per body. */
  r: Float64Array;
  k: Float64Array;
  mu: Float64Array;
}

const v3 = (): V3 => ({ x: 0, y: 0, z: 0 });

export const createQsState = (): QsState => ({
  mode: MODE_CONTACT, n: { x: 0, y: 1, z: 0 }, x0: v3(), v0: v3(), aS: v3(), u0: v3(), tick0: 0, tickEnd: 0, wB: 0, alB: 0,
});

/** Drag constant k = ρ·C_dA/(2m), 1/m: the air-relative speed e-folds every 1/k of path (v = v₀/(1 + k v₀ t)). */
export const dragK = (cdA: number, mass: number, rho: number = RHO_CABIN): number => (mass > 0 && cdA > 0 ? (rho * cdA) / (2 * mass) : 0);

/** C_dA (m²) of the plan's reference objects; others: a tumbling convex body, C_d ≈ 1 on its mean projected area S/4. */
export const CDA_REF: Readonly<Record<string, number>> = { pillow: 0.19, pen: 0.002, mug: 0.006, crew: 0.6 };
export const cdaOf = (type: string, surfaceArea: number): number => CDA_REF[type] ?? 0.25 * surfaceArea;

/** Quadratic drag over h, exact for a fixed direction (the CONTACT-mode update): v ← v/(1 + k|v|h). */
export function dragStep(v: V3, k: number, h: number): void {
  if (!(k > 0)) return;
  const s = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z), f = 1 / (1 + k * s * h);
  v.x *= f; v.y *= f; v.z *= f;
}

// ------------------------------------------------------------------------------------------------ rotation helpers

/** out = q·(x,y,z) (craft → inertial). */
function rot(out: V3, q: Quat, x: number, y: number, z: number): void {
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
}
/** out = q⁻¹·(x,y,z) (inertial → craft). */
function rotInv(out: V3, q: Quat, x: number, y: number, z: number): void {
  const qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
}

// ------------------------------------------------------------------------------------------------ rest

const F: V3 = v3();

/**
 * How far the felt acceleration f is outside the friction cone of a surface with normal n (out of the surface):
 * |f_t| − μ·max(0, −f·n) + max(0, f·n), m/s² (≤ 0 inside the cone; a pull off the surface counts in full).
 */
export function restMargin(f: V3, n: V3, mu: number): number {
  const fn = f.x * n.x + f.y * n.y + f.z * n.z;
  const tx = f.x - fn * n.x, ty = f.y - fn * n.y, tz = f.z - fn * n.z;
  return Math.sqrt(tx * tx + ty * ty + tz * tz) - mu * (fn < 0 ? -fn : 0) + (fn > 0 ? fn : 0);
}

/** Ticks until the cone margin could exceed REST_WAKE_A, given |d(felt)/dt| ≤ fDot (NEVER when fDot = 0). */
export function restWakeTicks(margin: number, fDot: number): number {
  if (!(fDot > 0)) return NEVER;
  const t = (REST_WAKE_A - margin) / (2 * fDot);
  if (!(t > Q)) return 1;
  const k = Math.floor(t / Q);
  return k < NEVER ? k : NEVER;
}

/** Felt acceleration at a point fixed in the ship (v = 0), with the motion's terms. */
function feltFixed(m: BodyMotion, p: V3): V3 {
  return feltAt(m, p.x, p.y, p.z, 0, 0, 0, F);
}

/** Put a body that came to rest on a surface (unit normal n, craft axes) into REST if the cone holds. */
export function tryRest(b: QsBody, mu: number, tick: number, m: BodyMotion, nx: number, ny: number, nz: number): boolean {
  const v = b.v;
  if (v.x * v.x + v.y * v.y + v.z * v.z >= REST_V * REST_V) return false;
  const s = b.qs;
  s.n.x = nx; s.n.y = ny; s.n.z = nz;
  const g = restMargin(feltFixed(m, b.p), s.n, mu);
  if (!(g <= REST_ENTER_A)) return false;
  s.mode = MODE_REST;
  v.x = v.y = v.z = 0;
  s.tick0 = tick;
  const w = restWakeTicks(g, m.fDot);
  s.tickEnd = w >= NEVER ? NEVER : tick + w;
  return true;
}

// ------------------------------------------------------------------------------------------------ drift

const X: V3 = v3();
const VV: V3 = v3();

/** Anchor a free body at `tick` from its ship-frame state (p, v), the ship's attitude q and motion m. */
export function anchorDrift(b: QsBody, tick: number, m: BodyMotion, q: Quat): void {
  const s = b.qs, p = b.p, v = b.v, w = m.w;
  s.mode = MODE_DRIFT;
  rot(s.x0, q, p.x, p.y, p.z);
  // inertial velocity relative to the CoM: v + ω × p, in inertial axes
  rot(s.v0, q, v.x + (w.y * p.z - w.z * p.y), v.y + (w.z * p.x - w.x * p.z), v.z + (w.x * p.y - w.y * p.x));
  rot(s.aS, q, m.a.x, m.a.y, m.a.z);
  // the cabin air co-rotates with the ship: the air-relative velocity is the ship-frame velocity
  rot(s.u0, q, v.x, v.y, v.z);
  s.tick0 = tick;
  s.tickEnd = tick;
}

/** Closed-form drift state at `tick`, inertial axes (CoM-centred): position into x, velocity into vOut. */
export function driftEval(s: QsState, tick: number, k: number, x: V3, vOut: V3): void {
  const t = (tick - s.tick0) * Q;
  const a = s.aS;
  let px = s.x0.x + s.v0.x * t - 0.5 * a.x * t * t, py = s.x0.y + s.v0.y * t - 0.5 * a.y * t * t, pz = s.x0.z + s.v0.z * t - 0.5 * a.z * t * t;
  let vx = s.v0.x - a.x * t, vy = s.v0.y - a.y * t, vz = s.v0.z - a.z * t;
  const u = s.u0, sp = Math.sqrt(u.x * u.x + u.y * u.y + u.z * u.z);
  if (k > 0 && sp > 0 && t > 0) {
    const z = k * sp * t;
    const D = sp * t - mlog1p(z) / k, dV = sp - sp / (1 + z);
    const ux = u.x / sp, uy = u.y / sp, uz = u.z / sp;
    px -= D * ux; py -= D * uy; pz -= D * uz;
    vx -= dV * ux; vy -= dV * uy; vz -= dV * uz;
  }
  x.x = px; x.y = py; x.z = pz;
  vOut.x = vx; vOut.y = vy; vOut.z = vz;
}

/** Drift state at `tick` in the ship frame (craft axes): p = q⁻¹x, v = q⁻¹v_in − ω × p. */
export function driftToShip(s: QsState, tick: number, k: number, q: Quat, w: V3, p: V3, v: V3): void {
  driftEval(s, tick, k, X, VV);
  rotInv(p, q, X.x, X.y, X.z);
  rotInv(v, q, VV.x, VV.y, VV.z);
  const px = p.x, py = p.y, pz = p.z;
  v.x -= w.y * pz - w.z * py; v.y -= w.z * px - w.x * pz; v.z -= w.x * py - w.y * px;
}

const NI: V3 = v3();

/**
 * Longest time (s) the anchored body certainly touches nothing: for every static box, with n the direction from
 * the box to the body and g its gap, the approach −n·(p(τ) − p₀) ≤ c τ + ½A τ² with
 *   c = max(0, −n·v₀) + |ω|·r_eff,   A = max(0, n·a_s) + k|u₀|²·max(0, n·û₀) + |α|·r_eff,
 * r_eff = |x₀| + |v₀|T + ½(|a_s| + k|u₀|²)T² (T = DRIFT_MAX; the walls sweep as the ship turns); other bodies take
 * half their gap each with the isotropic bound. Every gap gets DRIFT_SLOP. Bodies touching a box they are not approaching (sliding along
 * it) are not limited by it. Then the caps: DRIFT_MAX, DRIFT_N/n, and with significant drag 0.2/|ω|.
 */
export function driftBound(b: QsBody, i: number, bodies: readonly QsBody[], w: QsWorld, m: BodyMotion, q: Quat): number {
  const s = b.qs, p = b.p, r = w.r[i], k = w.k[i];
  const W = m.w, al = m.alpha;
  const wl = Math.sqrt(W.x * W.x + W.y * W.y + W.z * W.z), all = Math.sqrt(al.x * al.x + al.y * al.y + al.z * al.z);
  const v0 = s.v0, aS = s.aS, u0 = s.u0;
  const vl = Math.sqrt(v0.x * v0.x + v0.y * v0.y + v0.z * v0.z), al2 = Math.sqrt(aS.x * aS.x + aS.y * aS.y + aS.z * aS.z);
  const ul = Math.sqrt(u0.x * u0.x + u0.y * u0.y + u0.z * u0.z), kd = k * ul * ul;
  const x0l = Math.sqrt(s.x0.x * s.x0.x + s.x0.y * s.x0.y + s.x0.z * s.x0.z);
  const T = DRIFT_MAX, rEff = x0l + vl * T + 0.5 * (al2 + kd) * T * T;
  const cRot = wl * rEff, aRot = all * rEff;
  let best = DRIFT_MAX;
  if (m.n2 > 0) { const c = DRIFT_N / Math.sqrt(m.n2); if (c < best) best = c; }
  if (kd > 1e-6 && wl > 0) { const c = 0.2 / wl; if (c < best) best = c; }
  const bx = w.boxes;
  for (let j = 0, o = 0; j < w.nBoxes; j++, o += 6) {
    const qx = p.x < bx[o] ? bx[o] : p.x > bx[o + 3] ? bx[o + 3] : p.x;
    const qy = p.y < bx[o + 1] ? bx[o + 1] : p.y > bx[o + 4] ? bx[o + 4] : p.y;
    const qz = p.z < bx[o + 2] ? bx[o + 2] : p.z > bx[o + 5] ? bx[o + 5] : p.z;
    let nx = p.x - qx, ny = p.y - qy, nz = p.z - qz;
    const d = Math.sqrt(nx * nx + ny * ny + nz * nz);
    let c: number, A: number, g: number;
    if (d > 0) {
      nx /= d; ny /= d; nz /= d;
      // the normal in inertial axes (the anchor's quantities are inertial)
      rot(NI, q, nx, ny, nz);
      const vn = NI.x * v0.x + NI.y * v0.y + NI.z * v0.z, an = NI.x * aS.x + NI.y * aS.y + NI.z * aS.z;
      const un = ul > 0 ? (NI.x * u0.x + NI.y * u0.y + NI.z * u0.z) / ul : 0;
      c = (vn < 0 ? -vn : 0) + cRot;
      A = (an > 0 ? an : 0) + kd * (un > 0 ? un : 0) + aRot;
      g = d - r;
    } else {
      // centre inside a box (deep overlap): isotropic
      c = vl + cRot; A = al2 + kd + aRot; g = 0;
    }
    g += DRIFT_SLOP; // a body may sink at most DRIFT_SLOP into a surface while drifting, in total
    if (g < 0) g = 0;
    const t = c > 0 || A > 0 ? (2 * g) / (c + Math.sqrt(c * c + 2 * A * g)) : Infinity;
    if (t < best) best = t;
  }
  // other bodies: each may close half the gap (isotropic, ship frame: |v_rel| plus the turning terms)
  const cI = vl + cRot, aI = al2 + kd + aRot;
  for (let j = 0; j < bodies.length; j++) {
    if (j === i) continue;
    const o = bodies[j], dx = o.p.x - p.x, dy = o.p.y - p.y, dz = o.p.z - p.z;
    let g = Math.sqrt(dx * dx + dy * dy + dz * dz) - r - w.r[j];
    g += DRIFT_SLOP;
    if (g < 0) g = 0;
    if (o.qs.mode !== MODE_REST) g *= 0.5;
    const t = cI > 0 || aI > 0 ? (2 * g) / (cI + Math.sqrt(cI * cI + 2 * aI * g)) : Infinity;
    if (t < best) best = t;
  }
  return best;
}

/** Schedule the anchored body's segment end; false (and mode CONTACT) when it is within DRIFT_MIN_TICKS of a touch. */
export function scheduleDrift(b: QsBody, i: number, bodies: readonly QsBody[], w: QsWorld, tick: number, m: BodyMotion, q: Quat): boolean {
  const t = driftBound(b, i, bodies, w, m, q), s = b.qs;
  const W = m.w, al = m.alpha;
  s.wB = Math.sqrt(W.x * W.x + W.y * W.y + W.z * W.z);
  s.alB = Math.sqrt(al.x * al.x + al.y * al.y + al.z * al.z);
  const k = Math.floor(t / Q);
  if (!(k >= DRIFT_MIN_TICKS)) { s.mode = MODE_CONTACT; s.tickEnd = tick; return false; }
  s.mode = MODE_DRIFT;
  s.tickEnd = tick + k;
  return true;
}

/** True when the ship's proper acceleration (inertial axes) is no longer the one the segment froze. */
function motionChanged(s: QsState, m: BodyMotion, q: Quat): boolean {
  rot(X, q, m.a.x, m.a.y, m.a.z);
  if (X.x !== s.aS.x || X.y !== s.aS.y || X.z !== s.aS.z) {
    // exact zero vs a rounding residue of a zero rotation is the same motion
    const dx = X.x - s.aS.x, dy = X.y - s.aS.y, dz = X.z - s.aS.z;
    if (dx * dx + dy * dy + dz * dz > 1e-24 * (1 + X.x * X.x + X.y * X.y + X.z * X.z)) return true;
  }
  const W = m.w, al = m.alpha;
  return W.x * W.x + W.y * W.y + W.z * W.z > s.wB * s.wB || al.x * al.x + al.y * al.y + al.z * al.z > s.alB * s.alB;
}

// ------------------------------------------------------------------------------------------------ the scheduler

export const WHY_NONE = 0;
export const WHY_CONTACT = 1;
export const WHY_DRIFT = 2;
export const WHY_REST = 3;
/** Why the last nextBodyEvent result is what it is (WHY_*), and the body index that set it (-1 for none). */
export const bodyEvent = { why: WHY_NONE, body: -1 };

/**
 * Ticks (≥ 1) until some body needs the world at tick resolution, at most tMaxTicks: 1 while any body is in
 * CONTACT (the caller reports limitedBy 'props' / 'crew'), else the earliest DRIFT segment end or REST re-check.
 */
export function nextBodyEvent(bodies: readonly QsBody[], tick: number, tMaxTicks: number): number {
  let best = tMaxTicks > 1 ? tMaxTicks : 1, why = WHY_NONE, who = -1;
  for (let i = 0; i < bodies.length; i++) {
    const s = bodies[i].qs;
    if (s.mode === MODE_CONTACT) { bodyEvent.why = WHY_CONTACT; bodyEvent.body = i; return 1; }
    const d = s.tickEnd - tick;
    if (d < best) { best = d < 1 ? 1 : d; why = s.mode === MODE_DRIFT ? WHY_DRIFT : WHY_REST; who = i; }
  }
  bodyEvent.why = why; bodyEvent.body = who;
  return best;
}

/**
 * At a tick boundary (every tick at 1×, every quantum end under warp): move each DRIFT body to its closed-form
 * ship-frame position and velocity; at its segment end, or when the ship's motion changed, re-anchor it
 * (continuously: same position and velocity) and re-schedule, or hand it to CONTACT; re-check each REST body's
 * cone (felt at its point) and wake it to CONTACT when the margin exceeds REST_WAKE_A. Returns the number of
 * bodies in CONTACT afterwards.
 */
export function serviceBodies(bodies: readonly QsBody[], w: QsWorld, tick: number, m: BodyMotion, q: Quat): number {
  let nc = 0;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i], s = b.qs;
    if (s.mode === MODE_DRIFT) {
      driftToShip(s, tick, w.k[i], q, m.w, b.p, b.v);
      if (tick >= s.tickEnd || motionChanged(s, m, q)) {
        anchorDrift(b, tick, m, q);
        scheduleDrift(b, i, bodies, w, tick, m, q);
      }
    } else if (s.mode === MODE_REST) {
      const g = restMargin(feltFixed(m, b.p), s.n, w.mu[i]);
      if (g > REST_WAKE_A) { s.mode = MODE_CONTACT; s.tickEnd = tick; }
      else if (tick >= s.tickEnd) { const k = restWakeTicks(g, m.fDot); s.tickEnd = k >= NEVER ? NEVER : tick + k; }
    }
    if (s.mode === MODE_CONTACT) nc++;
  }
  return nc;
}

/**
 * After the CONTACT solver's step for body i: touching (with the support normal nx, ny, nz) and slow and inside
 * the cone → REST; touching nothing it is approaching → DRIFT (when the segment would be ≥ DRIFT_MIN_TICKS).
 * Returns the new mode.
 */
export function afterContact(
  b: QsBody, i: number, bodies: readonly QsBody[], w: QsWorld, tick: number, m: BodyMotion, q: Quat, touching: boolean, nx: number, ny: number, nz: number,
): number {
  if (touching && tryRest(b, w.mu[i], tick, m, nx, ny, nz)) return MODE_REST;
  anchorDrift(b, tick, m, q);
  scheduleDrift(b, i, bodies, w, tick, m, q);
  return b.qs.mode;
}

// ------------------------------------------------------------------------------------------------ save / load

const num = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const lv = (x: unknown, d: V3): V3 => {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  return { x: num(o.x, d.x), y: num(o.y, d.y), z: num(o.z, d.z) };
};
const Z3: V3 = { x: 0, y: 0, z: 0 };
const UP: V3 = { x: 0, y: 1, z: 0 };

export function saveQsState(s: QsState): QsState {
  return { mode: s.mode, n: { ...s.n }, x0: { ...s.x0 }, v0: { ...s.v0 }, aS: { ...s.aS }, u0: { ...s.u0 }, tick0: s.tick0, tickEnd: s.tickEnd, wB: s.wB, alB: s.alB };
}

/** Loader with defaults: a save without the field gives CONTACT, which re-derives REST / DRIFT within a tick. */
export function loadQsState(data: unknown): QsState {
  const o = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const mode = o.mode === MODE_REST || o.mode === MODE_DRIFT ? (o.mode as number) : MODE_CONTACT;
  return {
    mode, n: lv(o.n, UP), x0: lv(o.x0, Z3), v0: lv(o.v0, Z3), aS: lv(o.aS, Z3), u0: lv(o.u0, Z3),
    tick0: num(o.tick0, 0), tickEnd: num(o.tickEnd, 0), wB: num(o.wB, 0), alB: num(o.alB, 0),
  };
}
