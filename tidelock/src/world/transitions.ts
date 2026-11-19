// W2-E items 2 and 4 — sit, stand, strap-in and lie as physical motions (never a snap), the neck's slew, the lying
// body frame, and the posture shapes props can hit (docs/SIMULATION.md §2 W2-E; `body-sit-stand-strap-snaps`,
// `body-lying-head-frame`, `eye-head-dynamics`, `body-props-pose-helm`). Pure, deterministic, allocation-free per
// call, SI units, plain-JSON state.
//
// Model.
// - A transition moves the body point (the 80 kg CoM) along a path: a quadratic Bézier P0 → P1 → P2 in craft axes
//   (P0 = where the body is, P2 = where the posture puts it), exactly arc-length parameterised (a 16-segment
//   Gauss–Legendre table rebuilt from the control points — a pure function of saved state — and Newton inside a
//   segment), plus a cross offset d (craft axes) that takes up any start velocity not along the path.
// - The muscle limit is on the WHOLE dynamic acceleration vector of the body: |s̈·T + ṡ²κ·N + d̈| ≤ aMax (legs
//   600 N, arms 200 N over 80 kg). The felt load is carried on top of it by posture and the supports (seat, deck,
//   bunk: a person standing in 1 g is not at the limit; 600 N is below the body's weight), as body.ts' knee and lean
//   do. In zero g the felt load is 0, so the limb force m·(a − f) itself is ≤ the limit. The budget is split
//   exactly by the triangle inequality: the cross take-up gets |d̈| ≤ 0.4·aMax, the path the rest; along the path
//   s̈ ≤ √(aP² − (ṡ²κ)²) with κ the cell's exact maximum curvature (closed form: κ = |A×B|/(2|A + uB|³)).
// - Speed plan: ṡ ≤ v(s), where v is the corner limit √(0.6·aMax/κ) braked back along the path at 0.8·√(1−0.6²)·aMax
//   (a backward pass over the 16 cells, derived from the control points like the arc table, never saved). The
//   limbs follow it with a governor (feed-forward of the planned braking plus a 20 /s speed loop), so they slow
//   for the corner instead of being thrown out of it. Push-only limbs that cannot brake stop pushing early
//   (the running minimum of the corner limit ahead).
// - The PD along the path: ω = 7 rad/s, ζ = 1, exact per sub-step while unsaturated (the error's critically damped
//   transition); saturated, ballistic under the capped acceleration. A limb that only pushes (uni = ±1: legs on
//   the deck, unmagnetised, unloaded) cannot pull: its total force along the path keeps its sign, so standing up
//   in zero g ends with the legs' velocity — the body floats off. The path's ends are hard stops (the seat, the
//   deck); the arrival profile brakes to them. The duration emerges: 1.1–1.3 s with the legs, 1.5–1.7 s with the arms
//   for the Wren's helm and bunk (the plan's 0.6–1.2 s limited only the along-path force).
// - Cross take-up (no instant velocity change at the start): d̈ = −ω²d − 2ωḋ capped at 0.4·aMax, d(0) = 0,
//   ḋ(0) = the start velocity not along +T. A start whose cross take-up would need more than 0.15 m is refused
//   (startTransition returns TR_REFUSED_FAST: grab something first).
// - Ends: done when |L − s| < 1 cm, |ṡ| < 5 cm/s, |d| < 1 cm, |ḋ| < 5 cm/s; the residual offset and velocity are
//   handed to the harness body (body.ts HarnessBody.x, .v) so nothing snaps. A push-only end (uni = +1) reached
//   while still moving lets the body leave along the tangent with ṡ (posture 'floating').
// - Orientation: the body frame (ship ← body) slerps from qStart to qEnd with the progress s/(L − 1 cm) (rate ∝ ṡ;
//   exactly qEnd once done). Lying, it
//   is the bed's frame: the body's up along the bed toward the head, its face to the overhead, so the camera gains
//   roll; the look then turns inside the neck limits (body.ts clampLook) in that frame.
// - Neck: the head pitch toward the console is a neck rotation at ≤ 250°/s (slewAngle; no overshoot).
// - Momentum: the limbs' and supports' impulse J = m(v₁ − v₀) − m·f·h on the body is recorded with the opposite sign
//   in the hands.ts ReactionLedger: the ship takes it, so a transition conserves momentum in zero g. Rule (hands.ts
//   header): every support force the crew feels, its share of the felt load included, goes to the ship.
// - Posture shapes: seated = torso capsule (pelvis → neck, r 0.17) + thighs capsule (r 0.14, forward 0.45 m); lying
//   = one capsule along the bed (1.5 m, r 0.2); the helm body is the seated pair at the helm seat. A prop sphere
//   hitting a capsule exchanges a normal impulse with restitution e between the prop's mass and the body's 80 kg
//   (at impact the harness spring, 4.4 Hz, is far slower than the contact: the body is a free mass), so props bounce
//   off the seated pilot and the pilot's torso takes the kick (bodyPropImpulse changes vb = HarnessBody.v in place);
//   a throw from a seat pushes the body back the same way (throwReaction).
//
// WIRING (wave 2):
// - crew.ts sitCrew / standCrew / the helm entry and exit in session.ts, the bunk: instead of setting pos (the
//   snaps), start a transition: P1 = pathSeat(P0, seatPoint, P1) / pathStand(seatPoint, standPoint, P1) /
//   pathBunk(P0, bunkCentre, P1); startTransition(tr, def, P0 = crew CoM, P1, P2, qStart, qEnd (bedFrame for the
//   bunk), v0 = crew.vel). A result ≤ 0 means no transition (TR_REFUSED_FAST: moving too fast across the path; the
//   input is ignored until the crew is slower). Each tick while tr.on: stepTransition(tr, felt at the CoM (crew.ts
//   feltAt with the body's velocity), Q, ledger); crew CoM and velocity come from transitionPose. After the session
//   consumes the ledger, the held body takes the ship's jump through transitionJump(tr, shipJumpAt(p, dv, dw),
//   ledger) (the supports pass the cross part back). On done: TR_SEATED → HarnessBody.x/v = handoverResidual (no
//   snap); TR_FREE → crew.vel = the pose velocity, posture 'floating'. The app.ts look snap on entering the helm is
//   deleted: the neck slews to the console with slewAngle each tick (W2-D hub item 8).
// - Under warp (h > 0.02 s) a transition finishes quasi-statically: finishTransition (end pose, v = 0; the removed
//   momentum goes to the ship) — it only lasts ~1.3 s, so warp never meets it in practice (sleep starts after the
//   lie-down is done).
// - render/camera.ts: eye frame = transitionPose's q (or bedFrame while lying) · the neck look; CrewView gains the
//   body-frame quaternion (requested: CrewView.bodyQ).
// - props.ts contact pass: postureCapsules(kind, base, q, CAPS) once per tick for the seated/lying crew, then
//   sphereCapsule(CAPS, i, prop p, r, n, cp) and bodyPropImpulse(mp, prop v, 80, HarnessBody.v, n, e) for a
//   touching prop (it changes both velocities in place; the harness passes the body's share on to the ship).
// - Save: saveTransition / loadTransition (loader default: no transition; d, ḋ default 0), the neck angle is the
//   crew's pitch.
// - §1.4: reads the felt acceleration (ShipMotion); writes the hands.ts ReactionLedger (the ship's impulse, see
//   hands.ts) and the crew's pose. No new craft field.

import type { Quat, V3 } from '../core/types';
import { oscTransition, Q, SUBSTEPS, TORSO_MASS } from './body';
import type { ReactionLedger } from './hands';

const mcos = (x: number): number => Math.cos(x);
const msin = (x: number): number => Math.sin(x);
const macos = (x: number): number => Math.acos(x);
const fin = (x: number): number => (x - x === 0 ? x : 0);

export const TR_OMEGA = 7;
export const LEG_F = 600;
export const ARM_F = 200;
export const TR_DONE_X = 0.01;
export const TR_DONE_V = 0.05;
export const NECK_RATE = (250 * Math.PI) / 180;
export const NSEG = 16;
export const BODY_M = TORSO_MASS;
/** Share of the limb budget the planned corner speed may use for the centripetal part. */
export const TR_NORMAL_FRAC = 0.6;
/** Share of the limb budget the cross take-up may use (the path gets the rest, triangle inequality). */
export const TR_CROSS_FRAC = 0.4;
/** Largest cross take-up distance a start may need, m; beyond, the start is refused. */
export const TR_CROSS_MAX = 0.15;
/** Speed-governor loop gain, 1/s. */
export const TR_GOV_K = 20;

export const TR_NONE = 0;
export const TR_MOVING = 1;
/** Finished at the end point, held there (seat, bunk, standing on the deck). */
export const TR_SEATED = 2;
/** Finished moving: the body leaves the path with its velocity (zero-g stand-up). */
export const TR_FREE = 3;
/** startTransition results that start nothing: a non-finite or zero-length path; moving too fast across it. */
export const TR_REFUSED_BAD = 0;
export const TR_REFUSED_FAST = -1;

/**
 * Limb limits of a transition: aMax = the muscles' dynamic acceleration limit (m/s², whole vector); uni = 0 both
 * ways, +1 the limbs can only push along +path, −1 only along −path (their total force, felt support included).
 */
export interface TransitionDef {
  aMax: number;
  uni: number;
  /** The support a push-only limb stands on (unit normal, craft axes): pressed onto it by the felt load (≥ LOAD_MIN),
   * the feet brake by posture and friction as well as push; floating free of it they can only push. */
  n?: V3;
}
/** Felt load into a support above which push-only limbs can also brake, m/s². */
export const LOAD_MIN = 1;
/** Braking margin of the arrival and corner profiles (fraction of the available tangential budget planned). */
export const BRAKE_MARGIN = 0.8;
/** Legs pushing the body up off a seat or the deck n (cannot pull unless the boots hold the feet or it is loaded). */
export const legsDef = (bootsHeld: boolean, n: V3 = { x: 0, y: 1, z: 0 }): TransitionDef => ({ aMax: LEG_F / BODY_M, uni: bootsHeld ? 0 : 1, n: { ...n } });
/** Legs lowering the body into a seat with the feet on the deck and the hands on the armrests: both ways. */
export const DEF_SIT: TransitionDef = { aMax: LEG_F / BODY_M, uni: 0 };
/** Arms pulling into a seat or onto the bunk (strap-in in zero g, lie down): both ways, 200 N. */
export const DEF_ARMS: TransitionDef = { aMax: ARM_F / BODY_M, uni: 0 };

export interface TransitionState {
  on: boolean;
  aMax: number;
  uni: number;
  /** Support normal of a push-only limb (craft axes). */
  sn: V3;
  /** Bézier control points, craft axes. */
  p0: V3;
  p1: V3;
  p2: V3;
  /** Body frame at the start and the end (ship ← body). */
  q0: Quat;
  q1: Quat;
  /** Arc length done (m), its rate (m/s), total length (m). */
  s: number;
  sd: number;
  L: number;
  /** Cross offset of the body from the path point (m) and its rate (m/s), craft axes: the start's cross take-up. */
  d: V3;
  dd: V3;
  /** TR_MOVING, or how it ended. */
  phase: number;
}

const v3 = (): V3 => ({ x: 0, y: 0, z: 0 });
export const createTransition = (): TransitionState => ({
  on: false, aMax: 0, uni: 0, sn: { x: 0, y: 1, z: 0 }, p0: v3(), p1: v3(), p2: v3(), q0: { x: 0, y: 0, z: 0, w: 1 }, q1: { x: 0, y: 0, z: 0, w: 1 },
  s: 0, sd: 0, L: 0, d: v3(), dd: v3(), phase: TR_NONE,
});

// ------------------------------------------------------------------------------------------------ derived tables
// Arc length, the cells' maximum curvature and the speed plan: pure functions of (control points, aMax), rebuilt
// on demand, never saved (save → load rebuilds the same values).
const TAB = new Float64Array(NSEG + 1);
const KC = new Float64Array(NSEG + 1); // KC[NSEG] = 0 (pad: "the next cell" of the last one)
const VC2 = new Float64Array(NSEG);
const VB2 = new Float64Array(NSEG + 1);
const VM2 = new Float64Array(NSEG + 1);
const TKEY = new Float64Array(10).fill(NaN);
// scalar scratch in a typed array, not module `let`s: V8 boxes every double stored into a context slot (garbage per
// sub-step); MS[0] = memo s, MS[1] = memo u, MS[2] = the planned braking deceleration, MS[3] = the runtime sub-step
const MS = new Float64Array(4).fill(NaN);

function bez(tr: TransitionState, u: number, out: V3): V3 {
  const a = (1 - u) * (1 - u), b = 2 * u * (1 - u), c = u * u;
  out.x = a * tr.p0.x + b * tr.p1.x + c * tr.p2.x; out.y = a * tr.p0.y + b * tr.p1.y + c * tr.p2.y; out.z = a * tr.p0.z + b * tr.p1.z + c * tr.p2.z;
  return out;
}
function bezD(tr: TransitionState, u: number, out: V3): V3 {
  const a = 2 * (1 - u), b = 2 * u;
  out.x = a * (tr.p1.x - tr.p0.x) + b * (tr.p2.x - tr.p1.x); out.y = a * (tr.p1.y - tr.p0.y) + b * (tr.p2.y - tr.p1.y); out.z = a * (tr.p1.z - tr.p0.z) + b * (tr.p2.z - tr.p1.z);
  return out;
}

// 5-point Gauss–Legendre on [0, 1]
const GLX = [0.04691007703066800, 0.23076534494715845, 0.5, 0.76923465505284155, 0.95308992296933200];
const GLW = [0.11846344252809454, 0.23931433524968324, 0.28444444444444444, 0.23931433524968324, 0.11846344252809454];
const BD: V3 = v3();
const speedU = (tr: TransitionState, u: number): number => { bezD(tr, u, BD); return Math.sqrt(BD.x * BD.x + BD.y * BD.y + BD.z * BD.z); };
/** Arc length from u0 to u1 (Gauss–Legendre; the Bézier speed is the root of a quadratic: smooth). */
function arc(tr: TransitionState, u0: number, u1: number): number {
  const d = u1 - u0;
  let a = 0;
  for (let k = 0; k < 5; k++) a += GLW[k] * speedU(tr, u0 + GLX[k] * d);
  return a * d;
}
function ensureTable(tr: TransitionState): void {
  const K = TKEY;
  if (K[0] === tr.p0.x && K[1] === tr.p0.y && K[2] === tr.p0.z && K[3] === tr.p1.x && K[4] === tr.p1.y && K[5] === tr.p1.z && K[6] === tr.p2.x && K[7] === tr.p2.y && K[8] === tr.p2.z && K[9] === tr.aMax) return;
  TAB[0] = 0;
  for (let i = 1; i <= NSEG; i++) TAB[i] = TAB[i - 1] + arc(tr, (i - 1) / NSEG, i / NSEG);
  // curvature of a quadratic Bézier: B' = 2(A + uB), B'' = 2B ⇒ κ(u) = |A×B| / (2|A + uB|³), largest where |A + uB|
  // is least (u* = −A·B/|B|²): each cell's maximum is at u* clamped into it — exact, not sampled
  const ax = tr.p1.x - tr.p0.x, ay = tr.p1.y - tr.p0.y, az = tr.p1.z - tr.p0.z;
  const bx = tr.p2.x - 2 * tr.p1.x + tr.p0.x, by = tr.p2.y - 2 * tr.p1.y + tr.p0.y, bz = tr.p2.z - 2 * tr.p1.z + tr.p0.z;
  const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx, cr = Math.sqrt(cx * cx + cy * cy + cz * cz);
  const b2 = bx * bx + by * by + bz * bz, us = b2 > 0 ? -(ax * bx + ay * by + az * bz) / b2 : 0;
  const aM = tr.aMax, aN = TR_NORMAL_FRAC * aM;
  const planAb = BRAKE_MARGIN * Math.sqrt(1 - TR_NORMAL_FRAC * TR_NORMAL_FRAC) * aM;
  MS[2] = planAb;
  for (let i = 0; i < NSEG; i++) {
    const lo = i / NSEG, hi = (i + 1) / NSEG, u = us < lo ? lo : us > hi ? hi : us;
    const wx = ax + u * bx, wy = ay + u * by, wz = az + u * bz, w = Math.sqrt(wx * wx + wy * wy + wz * wz);
    const k = cr > 0 ? (w > 0 ? cr / (2 * w * w * w) : Infinity) : 0;
    KC[i] = k;
    VC2[i] = k > 0 ? aN / k : Infinity;
  }
  KC[NSEG] = 0;
  VB2[NSEG] = Infinity; VM2[NSEG] = Infinity;
  for (let i = NSEG - 1; i >= 0; i--) {
    const b = VB2[i + 1] + 2 * planAb * (TAB[i + 1] - TAB[i]);
    VB2[i] = VC2[i] < b ? VC2[i] : b;
    VM2[i] = VC2[i] < VM2[i + 1] ? VC2[i] : VM2[i + 1];
  }
  MS[0] = NaN;
  K[0] = tr.p0.x; K[1] = tr.p0.y; K[2] = tr.p0.z; K[3] = tr.p1.x; K[4] = tr.p1.y; K[5] = tr.p1.z; K[6] = tr.p2.x; K[7] = tr.p2.y; K[8] = tr.p2.z; K[9] = tr.aMax;
}

// one-entry memo of the last u(s) and its cell for the current control points: a pure function of (points, s), so
// it changes no result (save → load recomputes the same value); a sub-step's end is the next one's start
let cacheI = 0;
/** The cell of the last uAt call (0..NSEG−1). */
let cell = 0;

/** Bézier parameter u at arc length tr.s → MS[1] (sets `cell`): the segment from the table, then 3 Newton steps on the exact arc length. */
function uAt(tr: TransitionState): void {
  ensureTable(tr);
  const s = tr.s;
  if (s === MS[0]) { cell = cacheI; return; }
  const L = TAB[NSEG];
  let u = 0, lo = 0;
  if (!(L > 0) || !(s > 0)) { u = 0; lo = 0; } else if (s >= L) { u = 1; lo = NSEG - 1; } else {
    let hi = NSEG;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (TAB[m] <= s) lo = m; else hi = m; }
    const u0 = lo / NSEG, r = s - TAB[lo], u1 = hi / NSEG;
    u = u0 + (r / (TAB[hi] - TAB[lo])) / NSEG;
    for (let k = 0; k < 3; k++) {
      // the speed and the arc length from u0 to u, inline (helpers returning doubles would box them on V8)
      bezD(tr, u, BD);
      const sp = Math.sqrt(BD.x * BD.x + BD.y * BD.y + BD.z * BD.z);
      if (!(sp > 0)) break;
      const du = u - u0;
      let a = 0;
      for (let j = 0; j < 5; j++) { bezD(tr, u0 + GLX[j] * du, BD); a += GLW[j] * Math.sqrt(BD.x * BD.x + BD.y * BD.y + BD.z * BD.z); }
      u -= (a * du - r) / sp;
      if (u < u0) u = u0; else if (u > u1) u = u1;
    }
  }
  MS[0] = s; MS[1] = u; cacheI = lo; cell = lo;
}

/** Point and unit tangent at arc length tr.s → P, T (sets `cell`). Object arguments only (no boxed doubles). */
function poseAt(tr: TransitionState, P: V3, T: V3): void {
  uAt(tr);
  const u = MS[1];
  bez(tr, u, P);
  bezD(tr, u, T);
  const l = Math.sqrt(T.x * T.x + T.y * T.y + T.z * T.z);
  if (l > 0) { T.x /= l; T.y /= l; T.z /= l; } else {
    T.x = tr.p2.x - tr.p0.x; T.y = tr.p2.y - tr.p0.y; T.z = tr.p2.z - tr.p0.z;
    const m = Math.sqrt(T.x * T.x + T.y * T.y + T.z * T.z);
    if (m > 0) { T.x /= m; T.y /= m; T.z /= m; } else { T.x = 0; T.y = 1; T.z = 0; }
  }
}

const TT: V3 = v3();
const PT: V3 = v3();
const finite3 = (a: V3): boolean => a.x - a.x === 0 && a.y - a.y === 0 && a.z - a.z === 0;

/**
 * Start a transition from P0 (the body point now) through P1 to P2 with body frames q0 → q1. v0 = the body's
 * velocity now (craft axes): its component along the start tangent carries over as ṡ, the rest is the cross
 * take-up's ḋ (taken up over time within the muscle budget: no instant change). Returns the path length (m), or
 * TR_REFUSED_BAD (non-finite or zero-length path: nothing starts) / TR_REFUSED_FAST (the cross take-up would need
 * more than TR_CROSS_MAX). A refused start leaves tr.on = false (call it when no transition is running: a start
 * replaces the running one). `led` is unused (kept for the call shape: the start changes no velocity).
 */
export function startTransition(
  tr: TransitionState, def: TransitionDef, P0: V3, P1: V3, P2: V3, q0: Quat, q1: Quat, v0: V3 | null, _led: ReactionLedger | null = null,
): number {
  tr.on = false;
  if (!finite3(P0) || !finite3(P1) || !finite3(P2) || !(def.aMax > 0) || !(def.aMax < Infinity)) { tr.phase = TR_NONE; return TR_REFUSED_BAD; }
  tr.aMax = def.aMax; tr.uni = def.uni === 1 || def.uni === -1 ? def.uni : 0;
  if (def.n && finite3(def.n)) { tr.sn.x = def.n.x; tr.sn.y = def.n.y; tr.sn.z = def.n.z; } else { tr.sn.x = 0; tr.sn.y = 1; tr.sn.z = 0; }
  tr.p0.x = P0.x; tr.p0.y = P0.y; tr.p0.z = P0.z; tr.p1.x = P1.x; tr.p1.y = P1.y; tr.p1.z = P1.z; tr.p2.x = P2.x; tr.p2.y = P2.y; tr.p2.z = P2.z;
  // a path that folds back on itself (P1 collinear and outside P0–P2) would reverse at a point: straighten it
  {
    const ax = P1.x - P0.x, ay = P1.y - P0.y, az = P1.z - P0.z, bx = P2.x - 2 * P1.x + P0.x, by = P2.y - 2 * P1.y + P0.y, bz = P2.z - 2 * P1.z + P0.z;
    const b2 = bx * bx + by * by + bz * bz, us = b2 > 0 ? -(ax * bx + ay * by + az * bz) / b2 : -1;
    if (us > 0 && us < 1) {
      const wx = ax + us * bx, wy = ay + us * by, wz = az + us * bz;
      if (wx * wx + wy * wy + wz * wz < 1e-12 * (ax * ax + ay * ay + az * az + b2)) { tr.p1.x = 0.5 * (P0.x + P2.x); tr.p1.y = 0.5 * (P0.y + P2.y); tr.p1.z = 0.5 * (P0.z + P2.z); }
    }
  }
  tr.q0.x = q0.x; tr.q0.y = q0.y; tr.q0.z = q0.z; tr.q0.w = q0.w; tr.q1.x = q1.x; tr.q1.y = q1.y; tr.q1.z = q1.z; tr.q1.w = q1.w;
  ensureTable(tr);
  const L = TAB[NSEG];
  if (!(L > 1e-6) || !(L < Infinity)) { tr.phase = TR_NONE; tr.L = 0; return TR_REFUSED_BAD; }
  tr.s = 0; tr.sd = 0;
  poseAt(tr, PT, TT);
  const vx = v0 ? fin(v0.x) : 0, vy = v0 ? fin(v0.y) : 0, vz = v0 ? fin(v0.z) : 0;
  let sd = vx * TT.x + vy * TT.y + vz * TT.z;
  if (sd < 0) sd = 0; // backward along the path is part of the cross take-up (d is a free vector)
  const cx = vx - sd * TT.x, cy = vy - sd * TT.y, cz = vz - sd * TT.z, cu = Math.sqrt(cx * cx + cy * cy + cz * cz);
  const adMax = TR_CROSS_FRAC * def.aMax;
  // stop distance of the cross take-up: u/(ωe) unsaturated, + u²/(2·a) while saturated (an upper bound)
  if (cu / (TR_OMEGA * Math.E) + (cu * cu) / (2 * adMax) > TR_CROSS_MAX) { tr.phase = TR_NONE; return TR_REFUSED_FAST; }
  tr.on = true; tr.phase = TR_MOVING; tr.L = L; tr.s = 0; tr.sd = sd;
  tr.d.x = 0; tr.d.y = 0; tr.d.z = 0; tr.dd.x = cx; tr.dd.y = cy; tr.dd.z = cz;
  return L;
}

const PHI = new Float64Array(4);
oscTransition(PHI, 0, TR_OMEGA, 1, Q / SUBSTEPS);
const PHI_RT = new Float64Array(4);
const PA: V3 = v3();
const PB: V3 = v3();
const TA: V3 = v3();
const TB: V3 = v3();

/** Largest |dynamic acceleration| the last stepTransition planned in a sub-step, m/s² (output: tests, audio). */
export const trLast = { aPeak: 0 };

/**
 * Advance a transition by h (h = Q: 4 exact sub-steps; h ≤ 0.02 s: coefficients for that h; larger: finishes it
 * quasi-statically). f = felt acceleration at the body (craft axes, constant over the step; non-finite counts as
 * 0). The supports' and limbs' impulse goes (reversed) into led. Returns the phase (TR_MOVING, TR_SEATED, TR_FREE).
 */
export function stepTransition(tr: TransitionState, f: V3, h: number, led: ReactionLedger | null): number {
  if (!tr.on) return tr.phase;
  if (h > 0.02) return finishTransition(tr, led);
  if (!(h > 0)) return tr.phase;
  const fx = fin(f.x), fy = fin(f.y), fz = fin(f.z);
  const hs = h / SUBSTEPS, m = BODY_M, w = TR_OMEGA, w2 = w * w, aM = tr.aMax, adMax = TR_CROSS_FRAC * aM, L = tr.L;
  let P = PHI;
  if (h !== Q) { if (MS[3] !== hs) { oscTransition(PHI_RT, 0, w, 1, hs); MS[3] = hs; } P = PHI_RT; }
  const p0 = P[0], p1 = P[1], p2 = P[2], p3 = P[3];
  // a push-only limb pressed onto its support by the felt load brakes too (posture, friction): both ways then
  const uni = tr.uni !== 0 && -(fx * tr.sn.x + fy * tr.sn.y + fz * tr.sn.z) < LOAD_MIN ? tr.uni : 0;
  const d = tr.d, dd = tr.dd;
  let aPeak = 0, free = false;
  for (let i = 0; i < SUBSTEPS; i++) {
    poseAt(tr, PA, TA);
    const c = cell;
    // the body point and velocity at the sub-step's start (path + cross offset)
    const bx0 = PA.x + d.x, by0 = PA.y + d.y, bz0 = PA.z + d.z;
    const vx0 = tr.sd * TA.x + dd.x, vy0 = tr.sd * TA.y + dd.y, vz0 = tr.sd * TA.z + dd.z;
    // --- cross take-up: d̈ = −ω²d − 2ωḋ, |d̈| ≤ adMax (exact while unsaturated at both ends, else ballistic)
    let adm = 0;
    if (d.x !== 0 || d.y !== 0 || d.z !== 0 || dd.x !== 0 || dd.y !== 0 || dd.z !== 0) {
      const ax = -w2 * d.x - 2 * w * dd.x, ay = -w2 * d.y - 2 * w * dd.y, az = -w2 * d.z - 2 * w * dd.z, a0 = Math.sqrt(ax * ax + ay * ay + az * az);
      let done = false;
      if (a0 <= adMax) {
        const nx = p0 * d.x + p1 * dd.x, ny = p0 * d.y + p1 * dd.y, nz = p0 * d.z + p1 * dd.z;
        const mx = p2 * d.x + p3 * dd.x, my = p2 * d.y + p3 * dd.y, mz = p2 * d.z + p3 * dd.z;
        const ex = -w2 * nx - 2 * w * mx, ey = -w2 * ny - 2 * w * my, ez = -w2 * nz - 2 * w * mz, a1 = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (a1 <= adMax) {
          d.x = nx; d.y = ny; d.z = nz; dd.x = mx; dd.y = my; dd.z = mz; done = true;
          // the exact critically damped acceleration is monotone in |·| between the ends to O((ωh)²): bound it by both
          adm = (a0 > a1 ? a0 : a1) * (1 + 1e-3);
          if (adm > adMax) adm = adMax;
        }
      }
      if (!done) {
        const k = a0 > adMax ? adMax / a0 : 1, gx = ax * k, gy = ay * k, gz = az * k;
        d.x += dd.x * hs + 0.5 * gx * hs * hs; d.y += dd.y * hs + 0.5 * gy * hs * hs; d.z += dd.z * hs + 0.5 * gz * hs * hs;
        dd.x += gx * hs; dd.y += gy * hs; dd.z += gz * hs;
        adm = a0 * k;
      }
    }
    // --- along the path: the vector budget left, minus the largest centripetal part this sub-step can need
    const aP = aM - adm;
    const kc = KC[c] > KC[c + 1] ? KC[c] : KC[c + 1];
    const sdMax = (tr.sd < 0 ? -tr.sd : tr.sd) + aM * hs, an = kc * sdMax * sdMax;
    const at = an < aP ? Math.sqrt(aP * aP - an * an) : 0;
    const ft = fx * TA.x + fy * TA.y + fz * TA.z;
    const e = tr.s - L;
    // dynamic PD demand; the limbs' total along the path is that minus the felt load they carry
    let am = -w2 * e - 2 * w * tr.sd;
    // speed plan: corner limit braked back along the path (limbs that can brake) or the corner limit ahead (that cannot)
    let governed = false;
    if (tr.sd >= 0) {
      const canBrake = uni <= 0;
      let lim2: number, follow = 0;
      if (canBrake) {
        const ab = MS[2], b = VB2[c + 1] + 2 * ab * (TAB[c + 1] - tr.s);
        if (b < VC2[c]) { lim2 = b; follow = -ab; } else lim2 = VC2[c];
      } else lim2 = VM2[c];
      if (lim2 < Infinity) {
        const gov = follow - TR_GOV_K * (tr.sd - Math.sqrt(lim2));
        if (am > gov) { am = gov; governed = true; }
      }
    } else if (VC2[c] < Infinity) {
      const gov = TR_GOV_K * (-tr.sd - Math.sqrt(VC2[c]));
      if (am < gov) { am = gov; governed = true; }
    }
    // arriving faster than the limbs can stop in the distance left (v² > 2·a·margin·|e|), they brake fully
    const brakeOk = uni === 0 || uni * Math.sign(tr.sd) < 0;
    if (brakeOk && tr.sd * e < 0 && tr.sd * tr.sd > 2 * at * BRAKE_MARGIN * (e < 0 ? -e : e)) { am = tr.sd > 0 ? -at : at; governed = true; }
    let s = tr.s, sd = tr.sd, sAcc = 0;
    let exact = false;
    if (!governed && am <= at && am >= -at && (uni === 0 || (am - ft) * uni >= 0)) {
      // exact critically damped error, kept when the demand is still within the limits at the sub-step's end
      const s1 = L + p0 * e + p1 * sd, sd1 = p2 * e + p3 * sd, am1 = -w2 * (s1 - L) - 2 * w * sd1;
      if (am1 <= at && am1 >= -at && (uni === 0 || (am1 - ft) * uni >= 0)) { s = s1; sd = sd1; exact = true; sAcc = (am < 0 ? -am : am) > (am1 < 0 ? -am1 : am1) ? am : am1; }
    }
    if (!exact) {
      let tot = (am > at ? at : am < -at ? -at : am) - ft;
      if (uni !== 0 && tot * uni < 0) tot = 0;
      const acc = tot + ft;
      s += sd * hs + 0.5 * acc * hs * hs; sd += acc * hs;
      sAcc = acc;
    }
    // hard stops at the ends (the seat, the deck); a free end lets the body go
    if (s >= L) {
      if (uni > 0 && sd > 0) { s = L; free = true; } else { s = L; if (sd > 0) sd = 0; }
    } else if (s < 0) { s = 0; if (sd < 0) sd = 0; }
    tr.s = s; tr.sd = sd;
    const an1 = kc * sd * sd, ad = Math.sqrt(sAcc * sAcc + an1 * an1) + adm;
    if (ad > aPeak) aPeak = ad;
    // ledger: the body's impulse from limbs and supports over the sub-step (inline: no boxed doubles on V8)
    if (led) {
      poseAt(tr, PB, TB);
      const bx = PB.x + d.x, by = PB.y + d.y, bz = PB.z + d.z;
      const vx = sd * TB.x + dd.x, vy = sd * TB.y + dd.y, vz = sd * TB.z + dd.z;
      const jx = m * (vx - vx0 - fx * hs), jy = m * (vy - vy0 - fy * hs), jz = m * (vz - vz0 - fz * hs);
      led.J.x -= jx; led.J.y -= jy; led.J.z -= jz;
      const mx = 0.5 * (bx0 + bx), my = 0.5 * (by0 + by), mz = 0.5 * (bz0 + bz);
      led.L.x -= m * (by * vz - bz * vy - (by0 * vz0 - bz0 * vy0)) - m * hs * (my * fz - mz * fy);
      led.L.y -= m * (bz * vx - bx * vz - (bz0 * vx0 - bx0 * vz0)) - m * hs * (mz * fx - mx * fz);
      led.L.z -= m * (bx * vy - by * vx - (bx0 * vy0 - by0 * vx0)) - m * hs * (mx * fy - my * fx);
    }
    if (free) { trLast.aPeak = aPeak; tr.on = false; tr.phase = TR_FREE; return TR_FREE; }
  }
  trLast.aPeak = aPeak;
  const dx2 = d.x * d.x + d.y * d.y + d.z * d.z, dv2 = dd.x * dd.x + dd.y * dd.y + dd.z * dd.z;
  if (L - tr.s < TR_DONE_X && tr.sd < TR_DONE_V && tr.sd > -TR_DONE_V && dx2 < TR_DONE_X * TR_DONE_X && dv2 < TR_DONE_V * TR_DONE_V) {
    tr.on = false; tr.phase = TR_SEATED; return TR_SEATED;
  }
  return TR_MOVING;
}

/** Finish now (under warp): the end pose at rest; the remaining momentum goes to the ship. */
export function finishTransition(tr: TransitionState, led: ReactionLedger | null): number {
  if (!tr.on) return tr.phase;
  if (led) {
    poseAt(tr, PA, TA);
    const bx = PA.x + tr.d.x, by = PA.y + tr.d.y, bz = PA.z + tr.d.z, m = BODY_M;
    const jx = -m * (tr.sd * TA.x + tr.dd.x), jy = -m * (tr.sd * TA.y + tr.dd.y), jz = -m * (tr.sd * TA.z + tr.dd.z);
    led.J.x -= jx; led.J.y -= jy; led.J.z -= jz;
    led.L.x -= by * jz - bz * jy; led.L.y -= bz * jx - bx * jz; led.L.z -= bx * jy - by * jx;
  }
  tr.s = tr.L; tr.sd = 0; tr.d.x = tr.d.y = tr.d.z = 0; tr.dd.x = tr.dd.y = tr.dd.z = 0; tr.on = false; tr.phase = TR_SEATED;
  return TR_SEATED;
}

/** The body point, velocity and body frame now. */
export function transitionPose(tr: TransitionState, p: V3, v: V3, q: Quat | null): void {
  poseAt(tr, p, TA);
  p.x += tr.d.x; p.y += tr.d.y; p.z += tr.d.z;
  v.x = tr.sd * TA.x + tr.dd.x; v.y = tr.sd * TA.y + tr.dd.y; v.z = tr.sd * TA.z + tr.dd.z;
  // the turn completes over the path less the done tolerance, so the frame is exactly q1 when the transition ends
  // (the harness takes the last ≤ 1 cm of position; no frame snap at the hand-over)
  if (q) { const Le = tr.L - TR_DONE_X, u = Le > 0 ? tr.s / Le : 1; slerp(tr.q0, tr.q1, u > 1 ? 1 : u < 0 ? 0 : u, q); }
}

/** What the harness body starts with when a transition ends at a seat: the end point's offset and the velocity. */
export function handoverResidual(tr: TransitionState, x: V3, v: V3): void {
  poseAt(tr, PA, TA);
  x.x = PA.x + tr.d.x - tr.p2.x; x.y = PA.y + tr.d.y - tr.p2.y; x.z = PA.z + tr.d.z - tr.p2.z;
  v.x = tr.sd * TA.x + tr.dd.x; v.y = tr.sd * TA.y + tr.dd.y; v.z = tr.sd * TA.z + tr.dd.z;
}

/**
 * The ship jumped (the body's relative-velocity jump `jump`, body.ts shipJumpAt at the body point): the part along
 * the path adds to ṡ (stopped by the path's ends), the rest is taken by the supports — and goes back to the ship
 * (led). A jump is a contact event (a docking bump, a kick), not a muscle motion: the seat, bunk or hands take it.
 * Call after the session consumed the ledger, like every other held body.
 */
export function transitionJump(tr: TransitionState, jump: V3, led: ReactionLedger | null): void {
  if (!tr.on || !finite3(jump)) return;
  poseAt(tr, PA, TA);
  const sd0 = tr.sd;
  let sd = sd0 + (jump.x * TA.x + jump.y * TA.y + jump.z * TA.z);
  if ((tr.s >= tr.L && sd > 0 && !(tr.uni > 0)) || (tr.s <= 0 && sd < 0)) sd = 0;
  tr.sd = sd;
  if (led) {
    // body: Δv = (sd − sd0)·T; it would have been `jump`: the supports gave m((sd − sd0)T − jump)
    const bx = PA.x + tr.d.x, by = PA.y + tr.d.y, bz = PA.z + tr.d.z;
    const ds = sd - sd0, m = BODY_M, jx = m * (ds * TA.x - jump.x), jy = m * (ds * TA.y - jump.y), jz = m * (ds * TA.z - jump.z);
    led.J.x -= jx; led.J.y -= jy; led.J.z -= jz;
    led.L.x -= by * jz - bz * jy; led.L.y -= bz * jx - bx * jz; led.L.z -= bx * jy - by * jx;
  }
}

/** out = slerp(a, b, t), shortest arc. out may not alias a or b. */
export function slerp(a: Quat, b: Quat, t: number, out: Quat): Quat {
  let bx = b.x, by = b.y, bz = b.z, bw = b.w, d = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (d < 0) { d = -d; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let ka: number, kb: number;
  if (d > 0.9995) { ka = 1 - t; kb = t; } else {
    const th = macos(d), s = msin(th);
    ka = msin((1 - t) * th) / s; kb = msin(t * th) / s;
  }
  out.x = ka * a.x + kb * bx; out.y = ka * a.y + kb * by; out.z = ka * a.z + kb * bz; out.w = ka * a.w + kb * bw;
  const l = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z + out.w * out.w);
  out.x /= l; out.y /= l; out.z /= l; out.w /= l;
  return out;
}

/**
 * The lying body frame (ship ← body): body +Y (toward the head) along `head` (unit, craft axes, along the bed), the
 * face (body −Z) toward the overhead +Y: body +Z = −Y_ship, body +X = Y × Z. Lying on a bed along −Z with the head
 * forward, the view looks up with the overhead's forward edge at the top of the screen.
 */
export function bedFrame(head: V3, out: Quat): Quat {
  // columns: X = Yb × Zb, Yb = head, Zb = (0, −1, 0)
  const yx = head.x, yy = head.y, yz = head.z, zx = 0, zy = -1, zz = 0;
  const xx = yy * zz - yz * zy, xy = yz * zx - yx * zz, xz = yx * zy - yy * zx;
  return quatFromBasis(xx, xy, xz, yx, yy, yz, zx, zy, zz, out);
}

/** Rotation matrix with columns (X, Y, Z) → quaternion (Shepperd). */
export function quatFromBasis(m00: number, m10: number, m20: number, m01: number, m11: number, m21: number, m02: number, m12: number, m22: number, out: Quat): Quat {
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    out.w = 0.25 * s; out.x = (m21 - m12) / s; out.y = (m02 - m20) / s; out.z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    out.w = (m21 - m12) / s; out.x = 0.25 * s; out.y = (m01 + m10) / s; out.z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    out.w = (m02 - m20) / s; out.x = (m01 + m10) / s; out.y = 0.25 * s; out.z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    out.w = (m10 - m01) / s; out.x = (m02 + m20) / s; out.y = (m12 + m21) / s; out.z = 0.25 * s;
  }
  return out;
}

/** The neck turns toward target at ≤ rate (rad/s) over h, without overshoot. */
export function slewAngle(cur: number, target: number, h: number, rate = NECK_RATE): number {
  const d = target - cur, m = rate * h;
  return d > m ? cur + m : d < -m ? cur - m : target;
}

// ------------------------------------------------------------------------------------------------ path presets

/**
 * Sitting down onto a seat (or strapping in): from the body point P0 to the seated body point S. The pelvis first
 * moves over the seat at the height it has, then down into it (control point above the seat): no wall-clipping
 * straight line through the seat's front edge.
 */
export function pathSeat(P0: V3, S: V3, P1: V3): V3 {
  P1.x = S.x; P1.y = P0.y > S.y ? P0.y : S.y; P1.z = S.z;
  return P1;
}
/** Standing up from a seat: up first, then forward to the standing point. */
export function pathStand(S: V3, E: V3, P1: V3): V3 {
  P1.x = S.x; P1.y = E.y > S.y ? E.y : S.y; P1.z = S.z;
  return P1;
}
/** Clearance of the lying-down path over the mattress, m (the body rolls over the edge, not through it). */
export const BUNK_CLEAR = 0.2;
/**
 * Lying down on a bunk: from the body point P0 to the lying body centre B (on the mattress). The body moves over
 * the bunk at least BUNK_CLEAR above B, then down onto it; the body frame turns from upright to bedFrame with the
 * progress (q0 → q1 in startTransition). Getting up is the same path reversed (pathBunk(B, E, P1) from B to E).
 */
export function pathBunk(P0: V3, B: V3, P1: V3): V3 {
  const top = B.y + BUNK_CLEAR;
  P1.x = B.x; P1.y = P0.y > top ? P0.y : top; P1.z = B.z;
  return P1;
}

// ------------------------------------------------------------------------------------------------ posture shapes

export const POSE_SEATED = 0;
export const POSE_LYING = 1;
export const CAP_STRIDE = 7;
export const TORSO_R = 0.17;
export const THIGH_R = 0.14;
export const LYING_R = 0.2;
export const LYING_LEN = 1.5;

const CA: V3 = v3();
/**
 * Capsules (ax, ay, az, bx, by, bz, r) of the body in a posture, craft axes, into out at slot 0.. Returns the count.
 * Seated: base = the pelvis (seat point), q = the body frame (facing −Z in body axes): torso pelvis → +0.55 m up,
 * thighs pelvis → 0.45 m forward. Lying: base = the body's centre on the bed, q = bedFrame: one capsule ±0.75 m.
 */
export function postureCapsules(kind: number, base: V3, q: Quat, out: Float64Array): number {
  if (kind === POSE_LYING) {
    rotq(CA, q, 0, 0.5 * LYING_LEN - LYING_R, 0);
    out[0] = base.x - CA.x; out[1] = base.y - CA.y; out[2] = base.z - CA.z; out[3] = base.x + CA.x; out[4] = base.y + CA.y; out[5] = base.z + CA.z; out[6] = LYING_R;
    return 1;
  }
  rotq(CA, q, 0, 0.55, 0);
  out[0] = base.x; out[1] = base.y; out[2] = base.z; out[3] = base.x + CA.x; out[4] = base.y + CA.y; out[5] = base.z + CA.z; out[6] = TORSO_R;
  rotq(CA, q, 0, 0, -0.45);
  out[7] = base.x; out[8] = base.y; out[9] = base.z; out[10] = base.x + CA.x; out[11] = base.y + CA.y; out[12] = base.z + CA.z; out[13] = THIGH_R;
  return 2;
}

function rotq(out: V3, q: Quat, x: number, y: number, z: number): V3 {
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty); out.y = y + qw * ty + (qz * tx - qx * tz); out.z = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

/**
 * Sphere (centre p, radius r) against capsule i of caps: returns the penetration depth (> 0 touching) and the unit
 * normal from the capsule toward the sphere in n (and the contact point on the capsule axis in cp).
 */
export function sphereCapsule(caps: Float64Array, i: number, p: V3, r: number, n: V3, cp: V3): number {
  const o = i * CAP_STRIDE, ax = caps[o], ay = caps[o + 1], az = caps[o + 2];
  const dx = caps[o + 3] - ax, dy = caps[o + 4] - ay, dz = caps[o + 5] - az, L2 = dx * dx + dy * dy + dz * dz;
  let u = L2 > 0 ? ((p.x - ax) * dx + (p.y - ay) * dy + (p.z - az) * dz) / L2 : 0;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  cp.x = ax + u * dx; cp.y = ay + u * dy; cp.z = az + u * dz;
  let nx = p.x - cp.x, ny = p.y - cp.y, nz = p.z - cp.z;
  const d = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (d > 0) { nx /= d; ny /= d; nz /= d; } else { nx = 0; ny = 1; nz = 0; }
  n.x = nx; n.y = ny; n.z = nz;
  return caps[o + 6] + r - d;
}

/**
 * Normal impulse between a prop (mass mp, velocity vp) and the body (mass mb, velocity vb at the contact) along n
 * (from body to prop) with restitution e: J = (1 + e)·max(0, −v_rel·n)/(1/mp + 1/mb), applied in place (vp += J n/mp,
 * vb −= J n/mb). Returns J (N·s, ≥ 0). Friction is the props solver's (Coulomb on the same J).
 */
export function bodyPropImpulse(mp: number, vp: V3, mb: number, vb: V3, n: V3, e: number): number {
  const vn = (vp.x - vb.x) * n.x + (vp.y - vb.y) * n.y + (vp.z - vb.z) * n.z;
  if (!(vn < 0)) return 0;
  const J = ((1 + e) * -vn) / (1 / mp + 1 / mb);
  vp.x += (J * n.x) / mp; vp.y += (J * n.y) / mp; vp.z += (J * n.z) / mp;
  vb.x -= (J * n.x) / mb; vb.y -= (J * n.y) / mb; vb.z -= (J * n.z) / mb;
  return J;
}

/** A throw from the seat: the prop leaves with impulse J (N·s, craft axes); the torso takes −J/m (HarnessBody.v). */
export function throwReaction(bodyV: V3, J: V3, m = BODY_M): void {
  bodyV.x -= J.x / m; bodyV.y -= J.y / m; bodyV.z -= J.z / m;
}


// ------------------------------------------------------------------------------------------------ save / load

const num = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const rec = (d: unknown): Record<string, unknown> => (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
const lv = (x: unknown): V3 => { const o = rec(x); return { x: num(o.x, 0), y: num(o.y, 0), z: num(o.z, 0) }; };
const lq = (x: unknown): Quat => {
  const o = rec(x), q = { x: num(o.x, 0), y: num(o.y, 0), z: num(o.z, 0), w: num(o.w, 1) };
  const l = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  return l > 0 ? q : { x: 0, y: 0, z: 0, w: 1 };
};

export const saveTransition = (t: TransitionState): TransitionState => ({
  on: t.on, aMax: t.aMax, uni: t.uni, sn: { ...t.sn }, p0: { ...t.p0 }, p1: { ...t.p1 }, p2: { ...t.p2 }, q0: { ...t.q0 }, q1: { ...t.q1 }, s: t.s, sd: t.sd, L: t.L,
  d: { ...t.d }, dd: { ...t.dd }, phase: t.phase,
});
/** Loader default: no transition (an old save is in its posture already); d, ḋ default 0 (saves before the cross take-up). */
export function loadTransition(data: unknown): TransitionState {
  const o = rec(data), L = num(o.L, 0), aMax = num(o.aMax, 0);
  const ph = o.phase === TR_MOVING || o.phase === TR_SEATED || o.phase === TR_FREE ? (o.phase as number) : TR_NONE;
  const on = o.on === true && L > 0 && aMax > 0;
  return {
    on, aMax, uni: o.uni === 1 || o.uni === -1 ? (o.uni as number) : 0, sn: o.sn ? lv(o.sn) : { x: 0, y: 1, z: 0 }, p0: lv(o.p0), p1: lv(o.p1), p2: lv(o.p2), q0: lq(o.q0), q1: lq(o.q1),
    s: num(o.s, 0), sd: num(o.sd, 0), L, d: lv(o.d), dd: lv(o.dd), phase: on ? TR_MOVING : ph === TR_MOVING ? TR_NONE : ph,
  };
}
