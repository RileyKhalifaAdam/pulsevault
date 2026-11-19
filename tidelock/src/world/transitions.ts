// W2-E items 2 and 4 — sit, stand, strap-in and lie as physical motions (never a snap), the neck's slew, the lying
// body frame, and the posture shapes props can hit (docs/SIMULATION.md §2 W2-E; `body-sit-stand-strap-snaps`,
// `body-lying-head-frame`, `eye-head-dynamics`, `body-props-pose-helm`). Pure, deterministic, allocation-free per
// call, SI units, plain-JSON state.
//
// Model.
// - A transition moves the body point (the 80 kg CoM) along a path: a quadratic Bézier P0 → P1 → P2 in craft axes
//   (P0 = where the body is, P2 = where the posture puts it), exactly arc-length parameterised (a 16-segment
//   Gauss–Legendre table rebuilt from the control points — a pure function of saved state — and Newton inside a
//   segment). The limbs act along the path through a force-limited PD:
//   ω = 7 rad/s, ζ = 1; its dynamic part is ≤ aMax·m (legs 600 N, arms 200 N) and the felt load along the tangent
//   is carried on top of it by posture (as body.ts' knee and lean do: a person standing in 1 g is not at the limit).
//   A limb that only pushes (uni = ±1: legs on the deck, unmagnetised) cannot pull: its total force along the path
//   keeps its sign, so standing up in zero g ends with the legs' velocity — the body floats off. Exact per sub-step: unsaturated, the error is
//   critically damped (closed-form transition); saturated, ballistic under the capped force. The path's ends are
//   hard stops (the seat, the deck). Across the path the supports (seat, bunk, hands, feet) hold the body on it.
//   The duration emerges (0.6–1.2 s for the Wren's seat, table and bunk paths).
// - Ends: done when |L − s| < 1 cm and |ṡ| < 5 cm/s; the residual offset and velocity are handed to the harness
//   body (body.ts HarnessBody.x, .v) so nothing snaps. A push-only end (uni = +1) reached while still moving lets the
//   body leave along the tangent with ṡ (posture 'floating').
// - Orientation: the body frame (ship ← body) slerps from qStart to qEnd with the progress s/L (rate ∝ ṡ). Lying, it
//   is the bed's frame: the body's up along the bed toward the head, its face to the overhead, so the camera gains
//   roll; the look then turns inside the neck limits (body.ts clampLook) in that frame.
// - Neck: the head pitch toward the console is a neck rotation at ≤ 250°/s (slewAngle; no overshoot).
// - Momentum: the limbs' and supports' impulse J = m(v₁ − v₀) − m·f·h on the body is recorded with the opposite sign
//   in the hands.ts ReactionLedger: the ship takes it, so a transition conserves momentum in zero g.
// - Posture shapes: seated = torso capsule (pelvis → neck, r 0.17) + thighs capsule (r 0.14, forward 0.45 m); lying
//   = one capsule along the bed (1.5 m, r 0.2); the helm body is the seated pair at the helm seat. A prop sphere
//   hitting a capsule exchanges a normal impulse with restitution e between the prop's mass and the body's 80 kg
//   (at impact the harness spring, 4.4 Hz, is far slower than the contact: the body is a free mass), so props bounce
//   off the seated pilot and the pilot's torso takes the kick (HarnessBody.v += J/m); a throw from a seat pushes the
//   body back the same way (throwReaction).
//
// WIRING (wave 2):
// - crew.ts sitCrew / standCrew / the helm entry and exit in session.ts: instead of setting pos (the snaps), start a
//   transition: startTransition(tr, def, P0 = crew CoM, P1, P2, qStart, qEnd, v0 along the path) with the presets
//   below (pathSeat / pathStand / pathBunk build P1, P2 from the layout's seat and bunk points). Each tick while
//   tr.on: stepTransition(tr, felt at the CoM (crew.ts feltAt with the body's velocity), Q, ledger); crew CoM and
//   velocity come from transitionPose. After the session consumes the ledger, the held body takes the ship's jump
//   through transitionJump(tr, shipJumpAt(p, dv, dw), ledger) (the supports pass the cross part back). On done: TR_SEATED → HarnessBody.x/v = handoverResidual (no snap); TR_FREE →
//   crew.vel = the pose velocity, posture 'floating'. The app.ts look snap on entering the helm is deleted: the
//   neck slews to the console with slewAngle each tick (W2-D hub item 8).
// - Under warp (h > 0.02 s) a transition finishes quasi-statically: finishTransition (end pose, v = 0) — it only
//   lasts ~1 s, so warp never meets it in practice (sleep starts after the lie-down is done).
// - render/camera.ts: eye frame = transitionPose's q (or bedFrame while lying) · the neck look; CrewView gains the
//   body-frame quaternion (requested: CrewView.bodyQ).
// - props.ts contact pass: postureCapsules(kind, base, q, CAPS) once per tick for the seated/lying crew, then
//   sphereCapsule(CAPS, i, prop p, r, n) and bodyPropImpulse(...) for a touching prop; the body's share goes to
//   HarnessBody.v (seated) via applyBodyKick.
// - Save: saveTransition / loadTransition (loader default: no transition), the neck angle is the crew's pitch.
// - §1.4: reads the felt acceleration (ShipMotion); writes the hands.ts ReactionLedger (the ship's impulse, see
//   hands.ts) and the crew's pose. No new craft field.

import type { Quat, V3 } from '../core/types';
import { oscTransition, Q, SUBSTEPS, TORSO_MASS } from './body';
import type { ReactionLedger } from './hands';

const mcos = (x: number): number => Math.cos(x);
const msin = (x: number): number => Math.sin(x);
const macos = (x: number): number => Math.acos(x);

export const TR_OMEGA = 7;
export const LEG_F = 600;
export const ARM_F = 200;
export const TR_DONE_X = 0.01;
export const TR_DONE_V = 0.05;
export const NECK_RATE = (250 * Math.PI) / 180;
export const NSEG = 16;
export const BODY_M = TORSO_MASS;

export const TR_NONE = 0;
export const TR_MOVING = 1;
/** Finished at the end point, held there (seat, bunk, standing on the deck). */
export const TR_SEATED = 2;
/** Finished moving: the body leaves the path with its velocity (zero-g stand-up). */
export const TR_FREE = 3;

/**
 * Limb limits of a transition: aMax = the PD's dynamic muscle acceleration limit (m/s²); uni = 0 both ways, +1 the
 * limbs can only push along +path, −1 only along −path (their total force, felt support included).
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
/** Braking margin of the arrival profile (fraction of the limb's limit used to plan the stop). */
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
  /** TR_MOVING, or how it ended. */
  phase: number;
}

const v3 = (): V3 => ({ x: 0, y: 0, z: 0 });
export const createTransition = (): TransitionState => ({
  on: false, aMax: 0, uni: 0, sn: { x: 0, y: 1, z: 0 }, p0: v3(), p1: v3(), p2: v3(), q0: { x: 0, y: 0, z: 0, w: 1 }, q1: { x: 0, y: 0, z: 0, w: 1 }, s: 0, sd: 0, L: 0, phase: TR_NONE,
});

// arc-length table (derived from the control points; rebuilt on demand, never saved)
const TAB = new Float64Array(NSEG + 1);
const TKEY = new Float64Array(9).fill(NaN);

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
  if (K[0] === tr.p0.x && K[1] === tr.p0.y && K[2] === tr.p0.z && K[3] === tr.p1.x && K[4] === tr.p1.y && K[5] === tr.p1.z && K[6] === tr.p2.x && K[7] === tr.p2.y && K[8] === tr.p2.z) return;
  TAB[0] = 0;
  for (let i = 1; i <= NSEG; i++) TAB[i] = TAB[i - 1] + arc(tr, (i - 1) / NSEG, i / NSEG);
  cacheS = NaN;
  K[0] = tr.p0.x; K[1] = tr.p0.y; K[2] = tr.p0.z; K[3] = tr.p1.x; K[4] = tr.p1.y; K[5] = tr.p1.z; K[6] = tr.p2.x; K[7] = tr.p2.y; K[8] = tr.p2.z;
}

// one-entry memo of the last u(s) for the current control points: a pure function of (points, s), so it changes no
// result (save → load recomputes the same value); a sub-step's end is the next one's start, so it halves the work
let cacheS = NaN, cacheU = 0;

/** Bézier parameter u at arc length s: the segment from the table, then 3 Newton steps on the exact arc length. */
function uAt(tr: TransitionState, s: number): number {
  ensureTable(tr);
  if (s === cacheS) return cacheU;
  cacheU = uSolve(tr, s); cacheS = s;
  return cacheU;
}
function uSolve(tr: TransitionState, s: number): number {
  const L = TAB[NSEG];
  if (!(L > 0) || !(s > 0)) return 0;
  if (s >= L) return 1;
  let lo = 0, hi = NSEG;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (TAB[m] <= s) lo = m; else hi = m; }
  const u0 = lo / NSEG, r = s - TAB[lo];
  let u = u0 + (r / (TAB[hi] - TAB[lo])) / NSEG;
  for (let k = 0; k < 3; k++) {
    const sp = speedU(tr, u);
    if (!(sp > 0)) break;
    u -= (arc(tr, u0, u) - r) / sp;
    if (u < u0) u = u0; else if (u > hi / NSEG) u = hi / NSEG;
  }
  return u;
}

const TT: V3 = v3();
/** Unit tangent at arc length s → out (dp/ds of the arc-length parameterised path). */
function tangentAt(tr: TransitionState, s: number, out: V3): V3 {
  bezD(tr, uAt(tr, s), out);
  const l = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z);
  if (l > 0) { out.x /= l; out.y /= l; out.z /= l; } else {
    out.x = tr.p2.x - tr.p0.x; out.y = tr.p2.y - tr.p0.y; out.z = tr.p2.z - tr.p0.z;
    const m = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z);
    if (m > 0) { out.x /= m; out.y /= m; out.z /= m; } else { out.x = 0; out.y = 1; out.z = 0; }
  }
  return out;
}

/**
 * Start a transition from P0 (the body point now) through P1 to P2 with body frames q0 → q1. v0 = the body's
 * velocity now (craft axes): its component along the start tangent carries over (the cross part is taken by the
 * supports: the reaction goes to the ship). Returns the path length, m.
 */
export function startTransition(
  tr: TransitionState, def: TransitionDef, P0: V3, P1: V3, P2: V3, q0: Quat, q1: Quat, v0: V3 | null, led: ReactionLedger | null = null,
): number {
  tr.on = true; tr.aMax = def.aMax; tr.uni = def.uni; tr.phase = TR_MOVING;
  if (def.n) { tr.sn.x = def.n.x; tr.sn.y = def.n.y; tr.sn.z = def.n.z; } else { tr.sn.x = 0; tr.sn.y = 1; tr.sn.z = 0; }
  tr.p0.x = P0.x; tr.p0.y = P0.y; tr.p0.z = P0.z; tr.p1.x = P1.x; tr.p1.y = P1.y; tr.p1.z = P1.z; tr.p2.x = P2.x; tr.p2.y = P2.y; tr.p2.z = P2.z;
  tr.q0.x = q0.x; tr.q0.y = q0.y; tr.q0.z = q0.z; tr.q0.w = q0.w; tr.q1.x = q1.x; tr.q1.y = q1.y; tr.q1.z = q1.z; tr.q1.w = q1.w;
  ensureTable(tr);
  tr.L = TAB[NSEG]; tr.s = 0;
  tangentAt(tr, 0, TT);
  const tt = TT.x * TT.x + TT.y * TT.y + TT.z * TT.z;
  tr.sd = v0 && tt > 0 ? (v0.x * TT.x + v0.y * TT.y + v0.z * TT.z) / tt : 0;
  if (tr.sd < 0) tr.sd = 0; // the start is a stop: motion back into the seat is taken by it
  if (led && v0) {
    // the supports remove the velocity across the path: J = m(sd·T − v0); the ship takes −J at P0
    const m = BODY_M, jx = m * (tr.sd * TT.x - v0.x), jy = m * (tr.sd * TT.y - v0.y), jz = m * (tr.sd * TT.z - v0.z);
    led.J.x -= jx; led.J.y -= jy; led.J.z -= jz;
    led.L.x -= P0.y * jz - P0.z * jy; led.L.y -= P0.z * jx - P0.x * jz; led.L.z -= P0.x * jy - P0.y * jx;
  }
  return tr.L;
}

const PHI = new Float64Array(4);
oscTransition(PHI, 0, TR_OMEGA, 1, Q / SUBSTEPS);
const PHI_RT = new Float64Array(4);
let rtH = 0;
const PA: V3 = v3();
const PB: V3 = v3();
const TA: V3 = v3();
const TB: V3 = v3();

/**
 * Advance a transition by h (h = Q: 4 exact sub-steps; h ≤ 0.02 s: coefficients for that h; larger: finishes it
 * quasi-statically). f = felt acceleration at the body (craft axes, constant over the step). The supports' and limbs'
 * impulse goes (reversed) into led. Returns the phase (TR_MOVING, TR_SEATED, TR_FREE).
 */
export function stepTransition(tr: TransitionState, f: V3, h: number, led: ReactionLedger | null): number {
  if (!tr.on) return tr.phase;
  if (h > 0.02) return finishTransition(tr, led);
  const hs = h / SUBSTEPS, m = BODY_M, w = TR_OMEGA, w2 = w * w;
  let P = PHI;
  if (h !== Q) { if (rtH !== hs) { oscTransition(PHI_RT, 0, w, 1, hs); rtH = hs; } P = PHI_RT; }
  for (let i = 0; i < SUBSTEPS; i++) {
    tangentAt(tr, tr.s, TA);
    bez(tr, uAt(tr, tr.s), PA);
    const v0x = tr.sd * TA.x, v0y = tr.sd * TA.y, v0z = tr.sd * TA.z;
    const ft = f.x * TA.x + f.y * TA.y + f.z * TA.z;
    const e = tr.s - tr.L, aM = tr.aMax;
    // a push-only limb pressed onto its support by the felt load brakes too (posture, friction): both ways then
    const uni = tr.uni !== 0 && -(f.x * tr.sn.x + f.y * tr.sn.y + f.z * tr.sn.z) < LOAD_MIN ? tr.uni : 0;
    // dynamic PD demand; the limbs' total along the path is that minus the felt load they carry. Arriving faster
    // than the limbs can stop in the distance left (v² > 2·a·margin·|e|), they brake fully: no slam into the seat.
    let am = -w2 * e - 2 * w * tr.sd;
    const brakeOk = uni === 0 || uni * Math.sign(tr.sd) < 0;
    if (brakeOk && tr.sd * e < 0 && tr.sd * tr.sd > 2 * aM * BRAKE_MARGIN * (e < 0 ? -e : e)) am = tr.sd > 0 ? -aM : aM;
    let s = tr.s, sd = tr.sd;
    let exact = false;
    if (am < aM && am > -aM && (uni === 0 || (am - ft) * uni >= 0)) {
      // exact critically damped error, kept when the demand is still within the limits at the sub-step's end
      const s1 = tr.L + P[0] * e + P[1] * sd, sd1 = P[2] * e + P[3] * sd, am1 = -w2 * (s1 - tr.L) - 2 * w * sd1;
      if (am1 <= aM && am1 >= -aM && (uni === 0 || (am1 - ft) * uni >= 0)) { s = s1; sd = sd1; exact = true; }
    }
    if (!exact) {
      let tot = (am > aM ? aM : am < -aM ? -aM : am) - ft;
      if (uni !== 0 && tot * uni < 0) tot = 0;
      const acc = tot + ft;
      s += sd * hs + 0.5 * acc * hs * hs; sd += acc * hs;
    }
    // hard stops at the ends (the seat, the deck); a free end lets the body go
    if (s >= tr.L) {
      if (uni > 0 && sd > 0) { tr.s = tr.L; tr.sd = sd; recordStep(tr, led, PA, v0x, v0y, v0z, f, hs); tr.on = false; tr.phase = TR_FREE; return TR_FREE; }
      s = tr.L; if (sd > 0) sd = 0;
    } else if (s < 0) { s = 0; if (sd < 0) sd = 0; }
    tr.s = s; tr.sd = sd;
    recordStep(tr, led, PA, v0x, v0y, v0z, f, hs);
  }
  if (tr.L - tr.s < TR_DONE_X && tr.sd < TR_DONE_V && tr.sd > -TR_DONE_V) { tr.on = false; tr.phase = TR_SEATED; return TR_SEATED; }
  return TR_MOVING;
}

function recordStep(tr: TransitionState, led: ReactionLedger | null, p0: V3, v0x: number, v0y: number, v0z: number, f: V3, hs: number): void {
  if (!led) return;
  tangentAt(tr, tr.s, TB);
  bez(tr, uAt(tr, tr.s), PB);
  const m = BODY_M, vx = tr.sd * TB.x, vy = tr.sd * TB.y, vz = tr.sd * TB.z;
  const jx = m * (vx - v0x - f.x * hs), jy = m * (vy - v0y - f.y * hs), jz = m * (vz - v0z - f.z * hs);
  led.J.x -= jx; led.J.y -= jy; led.J.z -= jz;
  const mx = 0.5 * (p0.x + PB.x), my = 0.5 * (p0.y + PB.y), mz = 0.5 * (p0.z + PB.z);
  led.L.x -= m * (PB.y * vz - PB.z * vy - (p0.y * v0z - p0.z * v0y)) - m * hs * (my * f.z - mz * f.y);
  led.L.y -= m * (PB.z * vx - PB.x * vz - (p0.z * v0x - p0.x * v0z)) - m * hs * (mz * f.x - mx * f.z);
  led.L.z -= m * (PB.x * vy - PB.y * vx - (p0.x * v0y - p0.y * v0x)) - m * hs * (mx * f.y - my * f.x);
}

/** Finish now (under warp): the end pose at rest; the remaining momentum goes to the ship. */
export function finishTransition(tr: TransitionState, led: ReactionLedger | null): number {
  if (!tr.on) return tr.phase;
  if (led && tr.sd !== 0) {
    tangentAt(tr, tr.s, TA); bez(tr, uAt(tr, tr.s), PA);
    const J = -BODY_M * tr.sd, jx = J * TA.x, jy = J * TA.y, jz = J * TA.z;
    led.J.x -= jx; led.J.y -= jy; led.J.z -= jz;
    led.L.x -= PA.y * jz - PA.z * jy; led.L.y -= PA.z * jx - PA.x * jz; led.L.z -= PA.x * jy - PA.y * jx;
  }
  tr.s = tr.L; tr.sd = 0; tr.on = false; tr.phase = TR_SEATED;
  return TR_SEATED;
}

/** The body point, velocity and body frame now. */
export function transitionPose(tr: TransitionState, p: V3, v: V3, q: Quat | null): void {
  bez(tr, uAt(tr, tr.s), p);
  tangentAt(tr, tr.s, TA);
  v.x = tr.sd * TA.x; v.y = tr.sd * TA.y; v.z = tr.sd * TA.z;
  if (q) slerp(tr.q0, tr.q1, tr.L > 0 ? tr.s / tr.L : 1, q);
}

/** What the harness body starts with when a transition ends at a seat: the end point's offset and the velocity. */
export function handoverResidual(tr: TransitionState, x: V3, v: V3): void {
  bez(tr, uAt(tr, tr.s), PA);
  x.x = PA.x - tr.p2.x; x.y = PA.y - tr.p2.y; x.z = PA.z - tr.p2.z;
  tangentAt(tr, tr.s, TA);
  v.x = tr.sd * TA.x; v.y = tr.sd * TA.y; v.z = tr.sd * TA.z;
}

/**
 * The ship jumped (the body's relative-velocity jump `jump`, body.ts shipJumpAt at the body point): the part along
 * the path adds to ṡ (stopped by the path's ends), the rest is taken by the supports — and goes back to the ship
 * (led). Call after the session consumed the ledger, like every other held body.
 */
export function transitionJump(tr: TransitionState, jump: V3, led: ReactionLedger | null): void {
  if (!tr.on) return;
  tangentAt(tr, tr.s, TA); bez(tr, uAt(tr, tr.s), PA);
  const t2 = TA.x * TA.x + TA.y * TA.y + TA.z * TA.z;
  const sd0 = tr.sd;
  let sd = sd0 + (t2 > 0 ? (jump.x * TA.x + jump.y * TA.y + jump.z * TA.z) / t2 : 0);
  if ((tr.s >= tr.L && sd > 0 && !(tr.uni > 0)) || (tr.s <= 0 && sd < 0)) sd = 0;
  tr.sd = sd;
  if (led) {
    // body: Δv = (sd − sd0)·T; it would have been `jump`: the supports gave m((sd − sd0)T − jump)
    const ds = sd - sd0, m = BODY_M, jx = m * (ds * TA.x - jump.x), jy = m * (ds * TA.y - jump.y), jz = m * (ds * TA.z - jump.z);
    led.J.x -= jx; led.J.y -= jy; led.J.z -= jz;
    led.L.x -= PA.y * jz - PA.z * jy; led.L.y -= PA.z * jx - PA.x * jz; led.L.z -= PA.x * jy - PA.y * jx;
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
  on: t.on, aMax: t.aMax, uni: t.uni, sn: { ...t.sn }, p0: { ...t.p0 }, p1: { ...t.p1 }, p2: { ...t.p2 }, q0: { ...t.q0 }, q1: { ...t.q1 }, s: t.s, sd: t.sd, L: t.L, phase: t.phase,
});
/** Loader default: no transition (an old save is in its posture already). */
export function loadTransition(data: unknown): TransitionState {
  const o = rec(data), L = num(o.L, 0);
  const ph = o.phase === TR_MOVING || o.phase === TR_SEATED || o.phase === TR_FREE ? (o.phase as number) : TR_NONE;
  return {
    on: o.on === true && L > 0, aMax: num(o.aMax, 0), uni: o.uni === 1 || o.uni === -1 ? (o.uni as number) : 0, sn: o.sn ? lv(o.sn) : { x: 0, y: 1, z: 0 }, p0: lv(o.p0), p1: lv(o.p1), p2: lv(o.p2), q0: lq(o.q0), q1: lq(o.q1),
    s: num(o.s, 0), sd: num(o.sd, 0), L, phase: ph,
  };
}
