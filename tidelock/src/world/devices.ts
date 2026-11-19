// Physical controls as small simulated mechanisms (docs/ARCHITECTURE.md §3; layout in src/data/cockpit.ts).
// Pure TypeScript, plain-JSON state, deterministic. A control is never "set": the hand gives it a target and
// it gets there with its own inertia, spring, friction and travel time; the flight computer reads the result.
//
//   stick2  two axes, each a mass on a centring spring with damping. The hand is a stiff, force-limited
//           servo toward its target; released, the spring brings the grip back (over-damped: no overshoot).
//   lever   friction holds it where it is put; the hand moves it at a limited rate; a detent at zero.
//   rocker  momentary three-position switch on a spring.
//   button / handle / buckle / screen key / rest pad: a plunger with travel; the contact closes past 60 %.
//   toggle  bistable: a tap throws it to the other side, where it stays.
// Deflections are dimensionless (fractions of the travel).

import type { DeviceKind } from '../data/cockpit';

export interface DeviceState {
  id: string;
  kind: DeviceKind;
  /** Where the mechanism is: stick2 x,y in -1..1; lever x 0..1; rocker x -1..1; plunger / toggle x 0..1. */
  x: number;
  y: number;
  /** Its rate, 1/s. */
  vx: number;
  vy: number;
  /** Where the hand wants it (while held). */
  tx: number;
  ty: number;
  held: boolean;
  /** Seconds the plunger / rocker stays pushed after a tap or a brief touch (so the contact always makes). */
  press: number;
  /** Rocker: the side it was last pushed to (-1, 0, 1). */
  latch: number;
  /** Toggle: the side it rests on. */
  on: boolean;
  /** Contact closed (plunger past its switch point, toggle over centre). */
  made: boolean;
  /** Number of times the contact has closed; a reader keeps its own count to see each closure once. */
  count: number;
}

/** Stick: natural frequency of the centring spring (rad/s) and damping ratio; ~0.15 s back to centre. */
export const STICK_OMEGA = 55;
export const STICK_ZETA = 1.1;
/** The hand on a stick: servo frequency (rad/s) and the most acceleration it can give the grip, 1/s². */
export const HAND_OMEGA = 60;
export const HAND_MAX = 6000;
/** A stick reads zero inside this deflection. */
export const STICK_DEADBAND = 0.06;
/** Lever: fastest hand rate (travel/s), width of the zero detent, and how fast the detent pulls in. */
export const LEVER_RATE = 2.5;
export const LEVER_DETENT = 0.05;
export const DETENT_RATE = 1.5;
/** Plunger / rocker / toggle travel times, s, and the shortest press a tap makes. */
export const PLUNGER_TIME = 0.04;
export const ROCKER_TIME = 0.03;
export const TOGGLE_TIME = 0.05;
export const MIN_PRESS = 0.12;
/** Contact points of a plunger: makes above, breaks below. */
const MAKE = 0.6;
const BREAK = 0.4;
/** Integration step, s (the stick's hand servo needs it this short), and the span beyond which a step just settles. */
const H = 1 / 480;
const SETTLE_DT = 0.5;

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x === x ? x : 0);

export function createDevice(id: string, kind: DeviceKind, on = false): DeviceState {
  const t = kind === 'toggle' && on;
  return { id, kind, x: t ? 1 : 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, held: false, press: 0, latch: 0, on: t, made: t, count: 0 };
}

/** Hand down on the control. */
export function devGrab(d: DeviceState): void {
  d.held = true;
  d.tx = d.kind === 'lever' ? d.x : 0;
  d.ty = 0;
  if (d.kind === 'button' || d.kind === 'handle' || d.kind === 'buckle') d.press = MIN_PRESS;
}

/** Where the hand wants the control (see Session.moveDevice). Ignored unless held. */
export function devMove(d: DeviceState, x: number, y: number): void {
  if (!d.held) return;
  if (d.kind === 'lever') { d.tx = clamp(x, 0, 1); d.ty = 0; return; }
  d.tx = clamp(x, -1, 1);
  d.ty = clamp(y, -1, 1);
}

export function devRelease(d: DeviceState): void {
  d.held = false;
}

/** A short press: plungers go down for MIN_PRESS, a toggle is thrown over. Sticks, levers and rockers ignore it. */
export function devTap(d: DeviceState): boolean {
  switch (d.kind) {
    case 'toggle': d.on = !d.on; return true;
    case 'stick2': case 'lever': case 'rocker': return false;
    default: d.press = MIN_PRESS; return true;
  }
}

/** Stick axis as the flight computer reads it: zero inside the dead-band, full scale at the stop. */
export function stickAxis(x: number): number {
  const a = x < 0 ? -x : x;
  if (!(a > STICK_DEADBAND)) return 0;
  const o = (a - STICK_DEADBAND) / (1 - STICK_DEADBAND);
  return x < 0 ? -(o > 1 ? 1 : o) : o > 1 ? 1 : o;
}

/** Lever as read: zero in the detent, 0..1 over the rest of the travel. */
export function leverValue(d: DeviceState): number {
  return d.x > LEVER_DETENT ? Math.min(1, (d.x - LEVER_DETENT) / (1 - LEVER_DETENT)) : 0;
}

/** Rocker as read: -1, 0 or +1. */
export function rockerValue(d: DeviceState): number {
  return d.x > 0.5 ? 1 : d.x < -0.5 ? -1 : 0;
}

/** True when nothing is moving and nothing is pending: stepping it changes nothing. */
export function deviceAtRest(d: DeviceState): boolean {
  if (d.held || d.press > 0) return false;
  switch (d.kind) {
    case 'stick2': return d.x === 0 && d.y === 0 && d.vx === 0 && d.vy === 0;
    case 'lever': return d.x === 0 || d.x >= LEVER_DETENT;
    case 'toggle': return d.x === (d.on ? 1 : 0);
    default: return d.x === 0;
  }
}

/** One stick axis for H seconds. Returns nothing; writes through the accessor indices to keep it allocation-free. */
function stickStep(x: number, v: number, held: boolean, t: number, out: Float64Array): void {
  const spring = -STICK_OMEGA * STICK_OMEGA * x - 2 * STICK_ZETA * STICK_OMEGA * v;
  let a = spring;
  if (held) {
    // The hand supplies what a critically damped approach to its target needs, up to its strength.
    const want = HAND_OMEGA * HAND_OMEGA * (t - x) - 2 * HAND_OMEGA * v - spring;
    a += want > HAND_MAX ? HAND_MAX : want < -HAND_MAX ? -HAND_MAX : want;
  }
  v += a * H;
  x += v * H;
  if (x > 1) { x = 1; if (v > 0) v = 0; } else if (x < -1) { x = -1; if (v < 0) v = 0; }
  if (!held && x > -1e-3 && x < 1e-3 && v > -0.05 && v < 0.05) { x = 0; v = 0; }
  out[0] = x; out[1] = v;
}
const AX = new Float64Array(2);

const toward = (x: number, target: number, step: number): number => (x < target ? Math.min(target, x + step) : Math.max(target, x - step));

function sub(d: DeviceState, h: number): void {
  switch (d.kind) {
    case 'stick2':
      stickStep(d.x, d.vx, d.held, d.tx, AX); d.x = AX[0]; d.vx = AX[1];
      stickStep(d.y, d.vy, d.held, d.ty, AX); d.y = AX[0]; d.vy = AX[1];
      return;
    case 'lever': {
      const x0 = d.x;
      if (d.held) d.x = toward(d.x, d.tx, LEVER_RATE * h);
      // the detent: inside the notch, and not being pushed out of it, the lever drops to zero
      if (d.x < LEVER_DETENT && (!d.held || d.tx <= LEVER_DETENT)) d.x = toward(d.x, 0, DETENT_RATE * h);
      d.vx = (d.x - x0) / h;
      return;
    }
    case 'rocker': {
      let dir = 0;
      if (d.held) {
        const t = Math.abs(d.ty) >= Math.abs(d.tx) ? d.ty : d.tx;
        dir = t > 0.33 ? 1 : t < -0.33 ? -1 : 0;
        if (dir !== 0) { d.latch = dir; d.press = MIN_PRESS; }
      }
      if (dir === 0 && d.press > 0) dir = d.latch;
      if (d.press > 0 && (d.x > 0.5 || d.x < -0.5)) d.press = Math.max(0, d.press - h);
      d.x = toward(d.x, dir, h / ROCKER_TIME);
      d.made = d.x > 0.5 || d.x < -0.5;
      return;
    }
    case 'toggle': {
      d.x = toward(d.x, d.on ? 1 : 0, h / TOGGLE_TIME);
      const m = d.x > 0.5;
      if (m && !d.made) d.count++;
      d.made = m;
      return;
    }
    default: {
      // plunger: button, handle, buckle, screen key, rest pad
      const down = d.held || d.press > 0;
      d.x = toward(d.x, down ? 1 : 0, h / PLUNGER_TIME);
      if (!d.made && d.x >= MAKE) { d.made = true; d.count++; }
      else if (d.made && d.x <= BREAK) d.made = false;
      // the minimum press runs from the moment the contact is made
      if (d.press > 0 && d.made) d.press = Math.max(0, d.press - h);
      return;
    }
  }
}

/** Advance one mechanism by dt seconds (any dt: it sub-steps; spans longer than half a second settle). */
export function stepDevice(d: DeviceState, dt: number): void {
  if (!(dt > 0) || deviceAtRest(d)) return;
  if (dt > SETTLE_DT) {
    // long enough for every spring and timer to have finished
    const pending = d.press > 0 && !d.made && d.kind !== 'rocker' && d.kind !== 'toggle';
    if (pending) d.count++;
    d.press = 0;
    switch (d.kind) {
      case 'stick2': d.x = d.held ? d.tx : 0; d.y = d.held ? d.ty : 0; d.vx = d.vy = 0; break;
      case 'lever': d.x = d.held ? d.tx : d.x < LEVER_DETENT ? 0 : d.x; if (d.x < LEVER_DETENT && d.tx <= LEVER_DETENT) d.x = 0; d.vx = 0; break;
      case 'rocker': d.x = 0; d.made = false; break;
      case 'toggle': { const m = d.on; if (m && !d.made) d.count++; d.made = m; d.x = m ? 1 : 0; break; }
      default: if (d.held) { if (!d.made && !pending) d.count++; d.made = true; d.x = 1; } else { d.made = false; d.x = 0; } break;
    }
    return;
  }
  const n = Math.max(1, Math.ceil(dt / H - 1e-9));
  const h = dt / n;
  if (d.kind === 'stick2') {
    // the stick integrates at exactly H; the remainder of dt is carried by one shorter look at rest/target
    for (let i = 0; i < n; i++) sub(d, H);
    return;
  }
  for (let i = 0; i < n; i++) sub(d, h);
}
