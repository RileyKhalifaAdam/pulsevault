// W2-E items 1, 3, 5 — hands: reach, handholds and grip, push-off (docs/SIMULATION.md §2 W2-E; `body-reach-arm`,
// `body-handholds-grab-ship`, `body-pushoff-jump-physics`). Pure TypeScript, deterministic, allocation-free per
// call (module scratch), SI units, plain-JSON state.
//
// Model.
// - Reach: shoulders ±0.19 m lateral and 0.25 m below the eye (body frame), arm 0.72 m, torso lean ≤ 0.25 m standing
//   or ≤ 0.10 m harnessed along the lean direction. A point is reachable when the hand gets within the arm of it with
//   the least lean, and the shoulder→hand segment crosses no box (boxes the shoulder is inside, e.g. its own seat,
//   are skipped). One constant set for devices, props and holds. reachCached keeps a 5 Hz cache for presentation.
// - Grip: a critically damped spring between the grip point and the shoulder, ω = 25 rad/s, muscle force ≤ 350 N
//   (with the felt load fed forward), 4 exact sub-steps per tick (unsaturated: the error's exact transition;
//   saturated: exactly ballistic under the capped force). A rail or edge holds ≤ 200 N along its axis; beyond, the
//   hand slides along it with 150 N of kinetic friction and sticks again below 2 cm/s; it lets go when it slides off
//   an end or the arm is pulled past full extension. Pull input shortens the target arm (hand over hand).
// - Push-off: the push must lie in the friction cone, ≤ 35° from the surface normal (μ = tan 35° = 0.70, the boots'
//   μ_s); a wish outside is clamped to the cone edge (the foot or hand would slip). Legs ≤ 1 kN over 0.25 s
//   (3.125 m/s; peeling the boot magnets costs bootWell(0) = 2 J → 3.117 m/s), arms ≤ 300 N over 0.3 s (1.125 m/s).
//   The flick speed maps to effort (0..1) linearly.
// - Momentum exchange with the ship: every hand and push impulse J on the body is recorded with the opposite sign in
//   a ReactionLedger (craft axes): J_ship = −ΣJ, L_ship = −Σ∫p × F (about the CoM). The body's attitude is slaved to
//   the ship until W3-D gives it its own, so the wrist and shoulder couples close inside the ship: the reaction
//   moment is −p × F, which conserves total angular momentum exactly (tests/hands.test.ts).
//
// WIRING (wave 2):
// - crew.ts stepCrew, floating with a grip, per tick (h = Q): stepGrip(grip, holds, crew CoM p, crew.vel, felt (crewFelt
//   + tides.tidalAccel), Q, ledger) instead of the free sub-step for that tick (the grip owns the body's motion while
//   held; the contact solver still runs for walls). GRIP_LOST → emit 'contact' with a = BODY_CREW, J = 0 (or a new
//   'grab'/'release' kind: events.ts needs it — requested). Under warp (h > QS_DT) a held body is quasi-static:
//   gripEquilibrium (the spring's equilibrium under the felt load, or lost when it exceeds the limits).
// - Input (app/input.ts → session latch): a tap on a surface while floating → pickHandhold(holds, n, touch, …)
//   → grab(grip, holds, i, p, shoulderOffset, ledger); a drag while held → setGripPull; a flick on a surface →
//   startPush(push, n, dir, flickEffort(speed), limb); a tap on the held hold → release(grip).
// - Push per tick while active: pushTick(push, p, v, Q, ledger, out) gives the tick's mean acceleration for crew.ts
//   `sub`; at the end pushPeel(push, v, ledger) when the boots were gripped (replaces JUMP_SPEED / PUSH_SPEED / the
//   look-direction push in pushOffCrew).
// - The ship: once per tick, after the crew step, consumeReaction(ledger, J, L) → the craft takes Δv = q·J/M and
//   Δω = I⁻¹·L (craft axes) through the wave-2 impulse hook (W2-D hub: §1.4 `extImpulse {J, L}` is listed for wave 3;
//   it is needed now — requested). The crew then sees the ship's jump through the ledger's dvImpulse like any other.
// - Devices (devices.ts, reach 'arm'): reachPoint(eye, bodyQ, leanDir, leanMax, device.pos, boxes, n, r).ok replaces
//   "within 0.9 m of the eye". Props pick-up uses the same call.
// - Save: saveGrip / loadGrip, savePush / loadPush, saveReaction / loadReaction (loader defaults: not holding, not
//   pushing, empty ledger). Reach caches are not saved (presentation only; decisions call reachPoint at the latched
//   input tick).
// - §1.4 fields: reads the felt acceleration (from ShipMotion/BodyMotion) only; writes the ReactionLedger, which the
//   hub turns into the craft impulse (`extImpulse`, requested for wave 2).

import type { Quat, V3 } from '../core/types';
import { HOLD_STRIDE } from '../data/handholds';
import { BOOT_MU_S, oscTransition, Q, SUBSTEPS, TORSO_MASS } from './body';

const mcos = (x: number): number => Math.cos(x);
const msin = (x: number): number => Math.sin(x);

export const BODY_MASS = TORSO_MASS;
export const SHOULDER_LAT = 0.19;
export const SHOULDER_DROP = 0.25;
export const ARM_LEN = 0.72;
export const REACH_LEAN_STAND = 0.25;
export const REACH_LEAN_HELM = 0.1;
/** The hand's own size: the occlusion segment stops this short of the target, m. */
export const HAND_CLEAR = 0.03;
/** The reach cache refresh period, ticks (5 Hz). */
export const REACH_CACHE_TICKS = 24;
/** A tap this close to a hold grabs it, m. */
export const PICK_RADIUS = 0.15;
export const GRIP_OMEGA = 25;
export const GRIP_FMAX = 350;
export const RAIL_HOLD_F = 200;
export const RAIL_SLIDE_F = 150;
export const SLIDE_STICK_V = 0.02;
/** Shortest arm the pull target may ask for (hand at the chest), m; longest (a slightly bent arm), m. */
export const ARM_MIN = 0.2;
export const ARM_PULL_MAX = 0.68;
export const PUSH_CONE = (35 * Math.PI) / 180;
export const LEG_PUSH_F = 1000;
export const LEG_PUSH_T = 0.25;
export const ARM_PUSH_F = 300;
export const ARM_PUSH_T = 0.3;
export const LIMB_LEGS = 0;
export const LIMB_ARMS = 1;

const HS = Q / SUBSTEPS;
const W2 = GRIP_OMEGA * GRIP_OMEGA;
const AMAX = GRIP_FMAX / BODY_MASS;
const PHI = new Float64Array(4);
oscTransition(PHI, 0, GRIP_OMEGA, 1, HS);
const PHI_RT = new Float64Array(4);
let rtH = 0;

// ------------------------------------------------------------------------------------------------ reaction ledger

/** Impulse (N·s) and angular impulse about the CoM (N·m·s) the body has put into the ship since the last consumption. */
export interface ReactionLedger {
  J: V3;
  L: V3;
}
export const createReaction = (): ReactionLedger => ({ J: { x: 0, y: 0, z: 0 }, L: { x: 0, y: 0, z: 0 } });

/** Copy and zero (once per tick, by the session). */
export function consumeReaction(led: ReactionLedger, J: V3, L: V3): void {
  J.x = led.J.x; J.y = led.J.y; J.z = led.J.z; L.x = led.L.x; L.y = led.L.y; L.z = led.L.z;
  led.J.x = led.J.y = led.J.z = 0; led.L.x = led.L.y = led.L.z = 0;
}

/**
 * Record a body step: it went (p0, v0) → (p1, v1) over hs under its own felt f (ship frame) plus the hand/limb force.
 * The limb's impulse is J = m(v1 − v0) − m·f·hs; the ship takes −J and −[m(p1×v1 − p0×v0) − m·p̄×f·hs].
 * Returns |J|/hs (the mean limb force, N).
 */
function record(led: ReactionLedger | null, m: number, p0x: number, p0y: number, p0z: number, v0x: number, v0y: number, v0z: number, p: V3, v: V3, f: V3, hs: number): number {
  const jx = m * (v.x - v0x - f.x * hs), jy = m * (v.y - v0y - f.y * hs), jz = m * (v.z - v0z - f.z * hs);
  if (led) {
    led.J.x -= jx; led.J.y -= jy; led.J.z -= jz;
    const mx = 0.5 * (p0x + p.x), my = 0.5 * (p0y + p.y), mz = 0.5 * (p0z + p.z);
    const lx = m * (p.y * v.z - p.z * v.y - (p0y * v0z - p0z * v0y)) - m * hs * (my * f.z - mz * f.y);
    const ly = m * (p.z * v.x - p.x * v.z - (p0z * v0x - p0x * v0z)) - m * hs * (mz * f.x - mx * f.z);
    const lz = m * (p.x * v.y - p.y * v.x - (p0x * v0y - p0y * v0x)) - m * hs * (mx * f.y - my * f.x);
    led.L.x -= lx; led.L.y -= ly; led.L.z -= lz;
  }
  return Math.sqrt(jx * jx + jy * jy + jz * jz) / hs;
}

// ------------------------------------------------------------------------------------------------ reach

/** A yaw-only body frame (upright, facing (−sin y, 0, −cos y)): ship ← body. */
export function yawQuat(yaw: number, out: Quat): Quat {
  out.x = 0; out.y = msin(0.5 * yaw); out.z = 0; out.w = mcos(0.5 * yaw);
  return out;
}

/** out = q·(x, y, z). */
function rot(out: V3, q: Quat, x: number, y: number, z: number): V3 {
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

/** Shoulder (side −1 left, +1 right) of a body whose eye is at `eye` with body frame q (ship ← body), craft axes. */
export function shoulderPoint(eye: V3, q: Quat, side: number, out: V3): V3 {
  rot(out, q, (side < 0 ? -1 : 1) * SHOULDER_LAT, -SHOULDER_DROP, 0);
  out.x += eye.x; out.y += eye.y; out.z += eye.z;
  return out;
}

/** Does the segment A→B cross any box (min/max ×3, stride 6)? Boxes that contain A are skipped (the body's own seat). */
export function segmentBlocked(boxes: Float64Array, n: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  for (let i = 0, k = 0; i < n; i++, k += 6) {
    if (ax >= boxes[k] && ax <= boxes[k + 3] && ay >= boxes[k + 1] && ay <= boxes[k + 4] && az >= boxes[k + 2] && az <= boxes[k + 5]) continue;
    let t0 = 0, t1 = 1, miss = false;
    for (let a = 0; a < 3 && !miss; a++) {
      const p = a === 0 ? ax : a === 1 ? ay : az, d = a === 0 ? dx : a === 1 ? dy : dz, lo = boxes[k + a], hi = boxes[k + 3 + a];
      if (d === 0) { if (p < lo || p > hi) miss = true; continue; }
      let ta = (lo - p) / d, tb = (hi - p) / d;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) miss = true;
    }
    if (!miss) return true;
  }
  return false;
}

export interface ReachResult {
  ok: boolean;
  /** −1 left, +1 right (0 when unreachable). */
  side: number;
  /** Lean needed, m; distance shoulder (leaned) → target, m. */
  lean: number;
  dist: number;
  /** True when the arm is long enough but a box is in the way. */
  occluded: boolean;
}
export const createReachResult = (): ReachResult => ({ ok: false, side: 0, lean: 0, dist: 0, occluded: false });

const SH: V3 = { x: 0, y: 0, z: 0 };

/** Least lean ℓ ∈ [0, leanMax] along d that brings S + ℓd within ARM_LEN of P; −1 when none. */
function leastLean(S: V3, d: V3 | null, leanMax: number, P: V3): number {
  const wx = P.x - S.x, wy = P.y - S.y, wz = P.z - S.z, w2 = wx * wx + wy * wy + wz * wz, A2 = ARM_LEN * ARM_LEN;
  if (w2 <= A2) return 0;
  if (!d || !(leanMax > 0)) return -1;
  const wd = wx * d.x + wy * d.y + wz * d.z, disc = wd * wd - w2 + A2;
  if (disc < 0) return -1;
  const l = wd - Math.sqrt(disc);
  return l >= 0 && l <= leanMax ? l : -1;
}

/**
 * Can the hand reach P? eye and body frame q (ship ← body), the lean direction (unit, craft axes; null = none) and
 * limit (REACH_LEAN_STAND / REACH_LEAN_HELM ∩ the head clearance), the collision boxes. Prefers the shoulder that
 * needs less lean; tries the other when the first is occluded.
 */
export function reachPoint(eye: V3, q: Quat, dir: V3 | null, leanMax: number, P: V3, boxes: Float64Array, n: number, out: ReachResult): ReachResult {
  out.ok = false; out.side = 0; out.lean = 0; out.dist = 0; out.occluded = false;
  shoulderPoint(eye, q, -1, SH);
  const lL = leastLean(SH, dir, leanMax, P);
  shoulderPoint(eye, q, 1, SH);
  const lR = leastLean(SH, dir, leanMax, P);
  for (let pass = 0; pass < 2; pass++) {
    let side: number, l: number;
    const rFirst = lR >= 0 && (lL < 0 || lR < lL || (lR === lL && rightCloser(eye, q, P)));
    if (pass === 0) { side = rFirst ? 1 : -1; l = rFirst ? lR : lL; } else { side = rFirst ? -1 : 1; l = rFirst ? lL : lR; }
    if (l < 0) continue;
    shoulderPoint(eye, q, side, SH);
    if (dir) { SH.x += l * dir.x; SH.y += l * dir.y; SH.z += l * dir.z; }
    const dx = P.x - SH.x, dy = P.y - SH.y, dz = P.z - SH.z, dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const s = dl > HAND_CLEAR ? (dl - HAND_CLEAR) / dl : 0;
    if (segmentBlocked(boxes, n, SH.x, SH.y, SH.z, SH.x + s * dx, SH.y + s * dy, SH.z + s * dz)) { out.occluded = true; continue; }
    out.ok = true; out.side = side; out.lean = l; out.dist = dl; out.occluded = false;
    return out;
  }
  return out;
}

const SH2: V3 = { x: 0, y: 0, z: 0 };
function rightCloser(eye: V3, q: Quat, P: V3): boolean {
  shoulderPoint(eye, q, 1, SH2);
  const r = (P.x - SH2.x) ** 2 + (P.y - SH2.y) ** 2 + (P.z - SH2.z) ** 2;
  shoulderPoint(eye, q, -1, SH2);
  const l = (P.x - SH2.x) ** 2 + (P.y - SH2.y) ** 2 + (P.z - SH2.z) ** 2;
  return r <= l;
}

/** A 5 Hz cache of reach results per target slot, for presentation (highlights, prompts). Not saved. */
export interface ReachCache {
  epoch: Float64Array;
  ok: Uint8Array;
}
export const createReachCache = (slots: number): ReachCache => ({ epoch: new Float64Array(slots).fill(-1), ok: new Uint8Array(slots) });

const RC: ReachResult = createReachResult();
/** Cached reachPoint(…).ok for slot i, refreshed once per REACH_CACHE_TICKS-aligned epoch of the tick. */
export function reachCached(c: ReachCache, i: number, tick: number, eye: V3, q: Quat, dir: V3 | null, leanMax: number, P: V3, boxes: Float64Array, n: number): boolean {
  const e = Math.floor(tick / REACH_CACHE_TICKS);
  if (c.epoch[i] !== e) { c.ok[i] = reachPoint(eye, q, dir, leanMax, P, boxes, n, RC).ok ? 1 : 0; c.epoch[i] = e; }
  return c.ok[i] === 1;
}

// ------------------------------------------------------------------------------------------------ handholds

/** Closest point on hold i (compiled table) to P → out; returns the parameter u ∈ [0, 1] along a→b. */
export function closestOnHold(holds: Float64Array, i: number, P: V3, out: V3): number {
  const o = i * HOLD_STRIDE, ax = holds[o], ay = holds[o + 1], az = holds[o + 2];
  const dx = holds[o + 3] - ax, dy = holds[o + 4] - ay, dz = holds[o + 5] - az, L2 = dx * dx + dy * dy + dz * dz;
  let u = L2 > 0 ? ((P.x - ax) * dx + (P.y - ay) * dy + (P.z - az) * dz) / L2 : 0;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  out.x = ax + u * dx; out.y = ay + u * dy; out.z = az + u * dz;
  return u;
}

const HP: V3 = { x: 0, y: 0, z: 0 };
export const pickResult = { hold: -1, d: 0, x: 0, y: 0, z: 0 };

/** The hold closest to a touched point (within PICK_RADIUS), or −1. Writes pickResult. */
export function pickHandhold(holds: Float64Array, nHolds: number, touch: V3, radius = PICK_RADIUS): number {
  let best = -1, bd = radius;
  for (let i = 0; i < nHolds; i++) {
    closestOnHold(holds, i, touch, HP);
    const d = Math.sqrt((HP.x - touch.x) ** 2 + (HP.y - touch.y) ** 2 + (HP.z - touch.z) ** 2) - holds[i * HOLD_STRIDE + 6];
    if (d <= bd) { bd = d; best = i; pickResult.x = HP.x; pickResult.y = HP.y; pickResult.z = HP.z; }
  }
  pickResult.hold = best; pickResult.d = best >= 0 ? bd : 0;
  return best;
}

// ------------------------------------------------------------------------------------------------ grip

export const GRIP_FREE = 0;
export const GRIP_HELD = 1;
export const GRIP_SLIDING = 2;
export const GRIP_LOST = 3;

export interface GripState {
  on: boolean;
  hold: number;
  /** Grip point (craft axes); target shoulder − grip (craft axes); shoulder − body point (craft axes, fixed while held). */
  g: V3;
  tgt: V3;
  off: V3;
  slide: boolean;
  /** Largest mean hand force over the last tick's sub-steps, N (output: audio, tests; not read by the world). */
  fPeak: number;
}

export const createGrip = (): GripState => ({
  on: false, hold: -1, g: { x: 0, y: 0, z: 0 }, tgt: { x: 0, y: 0, z: 0 }, off: { x: 0, y: 0, z: 0 }, slide: false, fPeak: 0,
});

const SP: V3 = { x: 0, y: 0, z: 0 };

/**
 * Take hold of hold i with the hand at the shoulder p + off: the grip point is the hold's closest point to the
 * shoulder; the spring's target is the shoulder where it is now (the arm takes the motion from there). False when
 * the hold is beyond the arm.
 */
export function grab(gs: GripState, holds: Float64Array, i: number, p: V3, off: V3): boolean {
  SP.x = p.x + off.x; SP.y = p.y + off.y; SP.z = p.z + off.z;
  closestOnHold(holds, i, SP, gs.g);
  const tx = SP.x - gs.g.x, ty = SP.y - gs.g.y, tz = SP.z - gs.g.z, l = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (l > ARM_LEN) return false;
  gs.on = true; gs.hold = i; gs.slide = false; gs.fPeak = 0;
  gs.off.x = off.x; gs.off.y = off.y; gs.off.z = off.z;
  gs.tgt.x = tx; gs.tgt.y = ty; gs.tgt.z = tz;
  return true;
}

export function release(gs: GripState): void { gs.on = false; gs.hold = -1; gs.slide = false; }

/** Pull: the target arm length (clamped to ARM_MIN..ARM_PULL_MAX), along dir (unit, grip → shoulder) or the present one. */
export function setGripPull(gs: GripState, ext: number, dir: V3 | null = null): void {
  let dx = dir ? dir.x : gs.tgt.x, dy = dir ? dir.y : gs.tgt.y, dz = dir ? dir.z : gs.tgt.z;
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(l > 0)) { dx = 0; dy = 1; dz = 0; } else { dx /= l; dy /= l; dz /= l; }
  const e = ext < ARM_MIN ? ARM_MIN : ext > ARM_PULL_MAX ? ARM_PULL_MAX : ext;
  gs.tgt.x = dx * e; gs.tgt.y = dy * e; gs.tgt.z = dz * e;
}

const FZ: V3 = { x: 0, y: 0, z: 0 };

/**
 * One step of a held body (h = Q: 4 exact sub-steps; h ≤ 0.02 s: the same with coefficients for that h). p, v =
 * the body point (CoM) and velocity relative to the ship, craft axes, updated in place. f = felt acceleration at
 * the body (constant over the step). The hand's reaction goes into led. Returns GRIP_HELD, GRIP_SLIDING or GRIP_LOST.
 */
export function stepGrip(gs: GripState, holds: Float64Array, p: V3, v: V3, f: V3 | null, h: number, led: ReactionLedger | null): number {
  if (!gs.on) return GRIP_FREE;
  const ff = f ?? FZ, hs = h / SUBSTEPS, m = BODY_MASS;
  let P = PHI;
  if (h !== Q) { if (rtH !== hs) { oscTransition(PHI_RT, 0, GRIP_OMEGA, 1, hs); rtH = hs; } P = PHI_RT; }
  const o = gs.hold * HOLD_STRIDE, kind = holds[o + 7];
  let axx = 0, axy = 0, axz = 0, rail = false;
  if (kind === 0 || kind === 2) {
    const dx = holds[o + 3] - holds[o], dy = holds[o + 4] - holds[o + 1], dz = holds[o + 5] - holds[o + 2], l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (l > 0) { axx = dx / l; axy = dy / l; axz = dz / l; rail = true; }
  }
  const aHold = RAIL_HOLD_F / m, aKin = RAIL_SLIDE_F / m;
  gs.fPeak = 0;
  for (let i = 0; i < SUBSTEPS; i++) {
    const p0x = p.x, p0y = p.y, p0z = p.z, v0x = v.x, v0y = v.y, v0z = v.z;
    const tx = gs.g.x + gs.tgt.x - gs.off.x, ty = gs.g.y + gs.tgt.y - gs.off.y, tz = gs.g.z + gs.tgt.z - gs.off.z;
    const ex = p.x - tx, ey = p.y - ty, ez = p.z - tz;
    // muscle acceleration the critically damped spring asks for, with the felt load fed forward
    let amx = -W2 * ex - 2 * GRIP_OMEGA * v.x - ff.x, amy = -W2 * ey - 2 * GRIP_OMEGA * v.y - ff.y, amz = -W2 * ez - 2 * GRIP_OMEGA * v.z - ff.z;
    if (rail && !gs.slide && Math.abs(amx * axx + amy * axy + amz * axz) > aHold) gs.slide = true;
    if (gs.slide) {
      // along the rail: kinetic friction against the hand's slip (the hand slides with the body); across: the spring
      const va = v.x * axx + v.y * axy + v.z * axz, an = amx * axx + amy * axy + amz * axz;
      amx -= an * axx; amy -= an * axy; amz -= an * axz;
      const al = Math.sqrt(amx * amx + amy * amy + amz * amz);
      if (al > AMAX) { const s = AMAX / al; amx *= s; amy *= s; amz *= s; }
      const fa = ff.x * axx + ff.y * axy + ff.z * axz;
      let ka = va > 0 ? -aKin : va < 0 ? aKin : 0;
      // friction cannot reverse the slip within the sub-step: stop exactly at zero slip
      const vaEnd = va + (ka + fa) * hs;
      let stick = false;
      if (va !== 0 && vaEnd * va <= 0 && Math.abs(fa) <= aHold) { ka = -va / hs - fa; stick = true; }
      const ax = amx + ka * axx + ff.x, ay = amy + ka * axy + ff.y, az = amz + ka * axz + ff.z;
      p.x += v.x * hs + 0.5 * ax * hs * hs; p.y += v.y * hs + 0.5 * ay * hs * hs; p.z += v.z * hs + 0.5 * az * hs * hs;
      v.x += ax * hs; v.y += ay * hs; v.z += az * hs;
      // the hand slides with the body along the rail
      const dpa = (p.x - p0x) * axx + (p.y - p0y) * axy + (p.z - p0z) * axz;
      gs.g.x += dpa * axx; gs.g.y += dpa * axy; gs.g.z += dpa * axz;
      const u = ((gs.g.x - holds[o]) * axx + (gs.g.y - holds[o + 1]) * axy + (gs.g.z - holds[o + 2]) * axz);
      const L = Math.sqrt((holds[o + 3] - holds[o]) ** 2 + (holds[o + 4] - holds[o + 1]) ** 2 + (holds[o + 5] - holds[o + 2]) ** 2);
      const vaNow = v.x * axx + v.y * axy + v.z * axz;
      if (stick || (vaNow < SLIDE_STICK_V && vaNow > -SLIDE_STICK_V && Math.abs(fa) <= aHold)) gs.slide = false;
      const F = record(led, m, p0x, p0y, p0z, v0x, v0y, v0z, p, v, ff, hs);
      if (F > gs.fPeak) gs.fPeak = F;
      if (u < 0 || u > L) { release(gs); return GRIP_LOST; }
    } else {
      const al = Math.sqrt(amx * amx + amy * amy + amz * amz);
      let exact = false;
      if (al <= AMAX) {
        // exact: the error is critically damped about the fixed target — kept only if the muscle demand is within the
        // limit at both ends of the sub-step (in between it can exceed by O((ωh)²) = 0.3% at most); otherwise the
        // start demand is held over the sub-step (ballistic, within the limit)
        const nx = tx + P[0] * ex + P[1] * v.x, nvx = P[2] * ex + P[3] * v.x;
        const ny = ty + P[0] * ey + P[1] * v.y, nvy = P[2] * ey + P[3] * v.y;
        const nz = tz + P[0] * ez + P[1] * v.z, nvz = P[2] * ez + P[3] * v.z;
        const bx = -W2 * (nx - tx) - 2 * GRIP_OMEGA * nvx - ff.x, by = -W2 * (ny - ty) - 2 * GRIP_OMEGA * nvy - ff.y, bz = -W2 * (nz - tz) - 2 * GRIP_OMEGA * nvz - ff.z;
        if (bx * bx + by * by + bz * bz <= AMAX * AMAX) { p.x = nx; p.y = ny; p.z = nz; v.x = nvx; v.y = nvy; v.z = nvz; exact = true; }
      }
      if (!exact) {
        const s = al > AMAX ? AMAX / al : 1, ax = amx * s + ff.x, ay = amy * s + ff.y, az = amz * s + ff.z;
        p.x += v.x * hs + 0.5 * ax * hs * hs; p.y += v.y * hs + 0.5 * ay * hs * hs; p.z += v.z * hs + 0.5 * az * hs * hs;
        v.x += ax * hs; v.y += ay * hs; v.z += az * hs;
      }
      const F = record(led, m, p0x, p0y, p0z, v0x, v0y, v0z, p, v, ff, hs);
      if (F > gs.fPeak) gs.fPeak = F;
    }
    // the arm cannot stretch: past full extension the hand is pulled off the hold
    const sx = p.x + gs.off.x - gs.g.x, sy = p.y + gs.off.y - gs.g.y, sz = p.z + gs.off.z - gs.g.z;
    if (sx * sx + sy * sy + sz * sz > ARM_LEN * ARM_LEN) { release(gs); return GRIP_LOST; }
  }
  return gs.slide ? GRIP_SLIDING : GRIP_HELD;
}

/**
 * Quasi-static hold under warp (h > 0.02 s): the body sits at the spring's equilibrium (the target, the felt load
 * fed forward) with v = 0 while the felt load needs ≤ GRIP_FMAX (and ≤ RAIL_HOLD_F along a rail); otherwise the hand
 * lets go (GRIP_LOST; the body then drifts, quasistatic.ts). No reaction: a steady hold passes the felt load into
 * the ship continuously, which is already the ship's own acceleration.
 */
export function gripEquilibrium(gs: GripState, holds: Float64Array, p: V3, v: V3, f: V3): number {
  if (!gs.on) return GRIP_FREE;
  const fl = Math.sqrt(f.x * f.x + f.y * f.y + f.z * f.z);
  const o = gs.hold * HOLD_STRIDE, kind = holds[o + 7];
  let fa = 0;
  if (kind === 0 || kind === 2) {
    const dx = holds[o + 3] - holds[o], dy = holds[o + 4] - holds[o + 1], dz = holds[o + 5] - holds[o + 2], l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (l > 0) fa = Math.abs(f.x * dx + f.y * dy + f.z * dz) / l;
  }
  if (fl * BODY_MASS > GRIP_FMAX || fa * BODY_MASS > RAIL_HOLD_F) { release(gs); return GRIP_LOST; }
  p.x = gs.g.x + gs.tgt.x - gs.off.x; p.y = gs.g.y + gs.tgt.y - gs.off.y; p.z = gs.g.z + gs.tgt.z - gs.off.z;
  v.x = v.y = v.z = 0;
  gs.slide = false;
  return GRIP_HELD;
}

// ------------------------------------------------------------------------------------------------ push-off

export const PUSH_NONE = 0;
export const PUSH_IN_CONE = 1;
export const PUSH_CLAMPED = 2;

export interface PushState {
  on: boolean;
  limb: number;
  /** Elapsed and total push time, s; force, N; unit push direction on the body and the surface normal, craft axes. */
  t: number;
  T: number;
  F: number;
  d: V3;
  n: V3;
}
export const createPush = (): PushState => ({ on: false, limb: LIMB_LEGS, t: 0, T: 0, F: 0, d: { x: 0, y: 1, z: 0 }, n: { x: 0, y: 1, z: 0 } });

/** Effort 0..1 from the flick speed (any unit) over the speed of a full push in the same unit. */
export const flickEffort = (speed: number, full: number): number => (!(speed > 0) || !(full > 0) ? 0 : speed >= full ? 1 : speed / full);

/**
 * Start a push off a surface with unit normal n (out of the surface, craft axes) in the wished direction `want`:
 * inside the 35° cone it is used as is; outside it is clamped to the cone edge (the limb would slip); a wish into
 * the surface gives no push. Force = effort × the limb's maximum, for the limb's fixed stroke time.
 */
export function startPush(ps: PushState, n: V3, want: V3, effort: number, limb: number): number {
  const nl = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z), wl = Math.sqrt(want.x * want.x + want.y * want.y + want.z * want.z);
  if (!(nl > 0) || !(wl > 0) || !(effort > 0)) return PUSH_NONE;
  const nx = n.x / nl, ny = n.y / nl, nz = n.z / nl, wx = want.x / wl, wy = want.y / wl, wz = want.z / wl;
  const c = wx * nx + wy * ny + wz * nz;
  if (!(c > 0)) return PUSH_NONE;
  let res = PUSH_IN_CONE, dx = wx, dy = wy, dz = wz;
  const cc = mcos(PUSH_CONE);
  if (c < cc) {
    const tx = wx - c * nx, ty = wy - c * ny, tz = wz - c * nz, tl = Math.sqrt(tx * tx + ty * ty + tz * tz), ss = msin(PUSH_CONE);
    dx = cc * nx + (ss * tx) / tl; dy = cc * ny + (ss * ty) / tl; dz = cc * nz + (ss * tz) / tl;
    res = PUSH_CLAMPED;
  }
  const e = effort > 1 ? 1 : effort;
  ps.on = true; ps.limb = limb; ps.t = 0;
  ps.T = limb === LIMB_ARMS ? ARM_PUSH_T : LEG_PUSH_T;
  ps.F = e * (limb === LIMB_ARMS ? ARM_PUSH_F : LEG_PUSH_F);
  ps.d.x = dx; ps.d.y = dy; ps.d.z = dz; ps.n.x = nx; ps.n.y = ny; ps.n.z = nz;
  return res;
}

/** The cone the push used: tan 35° = 0.700, the boots' static friction (body.ts BOOT_MU_S). */
export const PUSH_MU = Math.tan(PUSH_CONE);
export const PUSH_MU_MATCHES_BOOTS = Math.abs(PUSH_MU - BOOT_MU_S) < 0.01;

/**
 * The push's mean acceleration over the next step h (the limb force while it lasts, F·d/m × duty), into out; the
 * reaction −F·d·dt at the body point p goes into led. Advances the push; it ends when t reaches T.
 * Returns the time of this step the force acted, s.
 */
export function pushTick(ps: PushState, p: V3, h: number, led: ReactionLedger | null, out: V3): number {
  out.x = out.y = out.z = 0;
  if (!ps.on) return 0;
  const left = ps.T - ps.t, dt = left < h ? (left > 0 ? left : 0) : h;
  const a = ps.F / BODY_MASS, k = (a * dt) / h;
  out.x = k * ps.d.x; out.y = k * ps.d.y; out.z = k * ps.d.z;
  if (led) {
    const J = ps.F * dt, jx = J * ps.d.x, jy = J * ps.d.y, jz = J * ps.d.z;
    led.J.x -= jx; led.J.y -= jy; led.J.z -= jz;
    led.L.x -= p.y * jz - p.z * jy; led.L.y -= p.z * jx - p.x * jz; led.L.z -= p.x * jy - p.y * jx;
  }
  ps.t += dt;
  if (ps.t >= ps.T) ps.on = false;
  return dt;
}

/**
 * Peel the boot magnets at the end of a leg push: the normal speed loses the well's work W (bootWell(gap), J):
 * ½m·vn'² = ½m·vn² − W. Returns false when the body cannot escape (vn' = 0: the boots catch it again). The
 * magnets' impulse goes to the ship (led).
 */
export function pushPeel(n: V3, v: V3, W: number, p: V3, led: ReactionLedger | null): boolean {
  const vn = v.x * n.x + v.y * n.y + v.z * n.z;
  if (!(vn > 0)) return false;
  const e = vn * vn - (2 * W) / BODY_MASS, vn1 = e > 0 ? Math.sqrt(e) : 0, dv = vn1 - vn;
  v.x += dv * n.x; v.y += dv * n.y; v.z += dv * n.z;
  if (led) {
    const J = BODY_MASS * dv, jx = J * n.x, jy = J * n.y, jz = J * n.z;
    led.J.x -= jx; led.J.y -= jy; led.J.z -= jz;
    led.L.x -= p.y * jz - p.z * jy; led.L.y -= p.z * jx - p.x * jz; led.L.z -= p.x * jy - p.y * jx;
  }
  return vn1 > 0;
}

// ------------------------------------------------------------------------------------------------ save / load

const num = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const v3o = (x: unknown, dx = 0, dy = 0, dz = 0): V3 => {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  return { x: num(o.x, dx), y: num(o.y, dy), z: num(o.z, dz) };
};
const rec = (d: unknown): Record<string, unknown> => (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;

export const saveGrip = (g: GripState): GripState => ({ on: g.on, hold: g.hold, g: { ...g.g }, tgt: { ...g.tgt }, off: { ...g.off }, slide: g.slide, fPeak: g.fPeak });
/** Loader default: not holding. nHolds guards a layout change (a hold index past the table drops the grip). */
export function loadGrip(data: unknown, nHolds: number): GripState {
  const o = rec(data), hold = typeof o.hold === 'number' && Number.isInteger(o.hold) ? o.hold : -1;
  const on = o.on === true && hold >= 0 && hold < nHolds;
  return { on, hold: on ? hold : -1, g: v3o(o.g), tgt: v3o(o.tgt), off: v3o(o.off), slide: on && o.slide === true, fPeak: num(o.fPeak, 0) };
}

export const savePush = (p: PushState): PushState => ({ on: p.on, limb: p.limb, t: p.t, T: p.T, F: p.F, d: { ...p.d }, n: { ...p.n } });
export function loadPush(data: unknown): PushState {
  const o = rec(data), T = num(o.T, 0);
  return { on: o.on === true && T > 0, limb: o.limb === LIMB_ARMS ? LIMB_ARMS : LIMB_LEGS, t: num(o.t, 0), T, F: num(o.F, 0), d: v3o(o.d, 0, 1, 0), n: v3o(o.n, 0, 1, 0) };
}

export const saveReaction = (r: ReactionLedger): ReactionLedger => ({ J: { ...r.J }, L: { ...r.L } });
export const loadReaction = (data: unknown): ReactionLedger => { const o = rec(data); return { J: v3o(o.J), L: v3o(o.L) }; };
