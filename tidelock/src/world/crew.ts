// The pilot as a body inside the ship (docs/ARCHITECTURE.md §3). Pure TypeScript, deterministic, plain-JSON state.
//
// The body lives in the ship's frame (ship-local axes: forward -Z, up +Y, starboard +X; origin = the craft's
// origin, taken as its centre of mass). The ship is in free fall, so gravity does not appear: ship and pilot fall
// together. What moves a loose body is the acceleration it feels in that frame:
//
//   felt = -(ship's proper acceleration) - ω × (ω × r) - 2 ω × v - α × r
//
// (thrust presses everything toward the stern; a turning ship adds centrifugal, Coriolis and Euler terms).
// Magnetic boots (SIMULATION.md W1-C 4, body.ts): each sole pulls F(g) = F₀/(1 + g/g₀)² toward a deck; they catch
// only when the soles touch (gap < 2 mm) at ≤ 0.5 m/s, and hold while the felt load along the deck stays inside the
// friction cone μ_s·(ΣF_mag + m·max(0, −f_n)). Beyond it they slip and the body slides and falls like anything
// loose; a ship impulse passes through the soles only up to the shear impulse they can carry (bootImpulse). The
// legs push with F = m(a_cmd − f_t), limited by that traction. Movement stays inside the rooms and doors, minus the
// solids. The eye moves with the body (eyeOffsetOf: knee, head lag, gait bob, lean; harness and head when seated)
// as a translation only.

import type { Quat, V3 } from '../core/types';
import type { Interactable, InteriorLayout } from '../data/interiors';
import { craftMass, type Craft, type World } from './state';
import type { EventRing } from './events';
import type { LedgerMean } from './jets';
import { emitEvent, MAT } from './events';
import {
  BOOT_F0, BOOT_HELD, BOOT_MU_S, bootContact, bootImpulse, bootMagnet, BUNK_DEF, clampEyeOffset, createFootBody, createHarnessBody,
  footEyeOffset, gaitEye, gaitPhase, gaitSpeedCap, HELM_DEF, helmEyeOffset, kneeLand, landedProperAccel, LEAN_MAX_HELM, LEAN_MAX_STAND,
  leanClearance, leanDir, leanTick, legForce, loadHarnessBody, localVertical, motionFromLedger, neckEyeDelta, saveHarnessBody, settleFoot,
  shipJumpAt, SOLE_CATCH, stepFoot, stepHarnessBody, TORSO_MASS, type FootBody, type HarnessBody,
} from './body';

/**
 * Collision radius of the body about its long axis, m: about half a person's shoulder depth-to-width. The
 * narrowest passages of the 32 m Wren are its 1.0 m doorways, which leave a hand's breadth either side.
 */
export const CREW_RADIUS = 0.28;
export const CREW_HEIGHT = 1.75;
export const CREW_EYE = 1.62;
/** Height of the body's centre of mass above the feet, m. */
export const CREW_COM = 0.95;
export const WALK_SPEED = 1.4;
export const RUN_SPEED = 2.2;
/** The body's mass, kg (body.ts TORSO_MASS: the whole pilot for the boots, the legs and the drag). */
export const CREW_MASS = TORSO_MASS;
/** The most acceleration the legs try for along the deck, m/s² (the soles' traction may give less). */
export const WALK_ACCEL = 8;
/**
 * Felt acceleration along the deck that two booted soles hold with nothing pressing them into it, m/s²:
 * μ_s·2F₀/m = 3.5 (more under a load into the deck, less under one away from it).
 */
export const BOOT_HOLD = (BOOT_MU_S * 2 * BOOT_F0) / CREW_MASS;
/** The magnets' pull is followed this far from a deck, m (beyond it F(g) is below 0.1 N per boot). */
export const BOOT_REACH = 0.4;
/** A gripped sole follows a step in the deck (a door sill) up to this height, m; the knee takes it. */
const BOOT_SNAP = 0.03;
/** Sole catch gap, m (body.ts BOOT_CATCH_GAP). */
const CATCH_GAP = 0.002;
export const JUMP_SPEED = 1.5;
export const PUSH_SPEED = 1.2;
/** A surface this close to the body can be pushed off, m. */
export const PUSH_REACH = 0.45;
export const CREW_RESTITUTION = 0.3;
export const CREW_FRICTION = 0.25;
/** Half-thickness of a wall panel, m. */
const WALL = 0.02;
const SUB_DT = 1 / 120;
const MAX_MOVE = 0.06;

export type CrewPosture = 'walking' | 'floating' | 'seated' | 'lying';

export interface CrewState {
  /** Craft the body is aboard. */
  shipId: string;
  /** Feet position and velocity relative to the ship, ship-local axes. */
  pos: V3;
  vel: V3;
  /** Look: yaw about +Y (0 = facing -Z, positive = left) and pitch (positive = up), rad. */
  yaw: number;
  pitch: number;
  boots: boolean;
  /** True while the boots have hold of a deck. */
  gripped: boolean;
  posture: CrewPosture;
  /** What the body sits or lies on ('' when on its feet or loose). */
  seat: '' | 'table' | 'bunk';
  /** Where it stood before it sat or lay down. */
  back: V3;
  /** Knee, head lag, gait phase and lean on foot (body.ts FootBody); absent in older saves (created at rest). */
  foot?: FootBody;
  /** Felt load into the deck at the last tick, m/s² (the gait bob scales with it); absent: 0. */
  fn?: number;
}

/** The ship's motion as the body needs it, all in ship-local axes. */
export interface ShipMotion {
  /** Proper (non-gravitational) acceleration of the ship, m/s². */
  a: V3;
  /** Angular velocity, rad/s, and angular acceleration, rad/s². */
  w: V3;
  alpha: V3;
  /** Unit local vertical (away from the primary) and n² = μ/r³ (1/s²): W1-C item 9, for W2-E's tides. */
  rhat?: V3;
  n2?: number;
  /** Upper bound of |d(felt)/dt| in the cabin, m/s³ (0 in wave 1: no slow forces yet). */
  fDot?: number;
}

export interface CrewInput {
  /** Strafe (+ = right) and forward (+ = where the pilot faces), each -1..1. */
  moveX: number;
  moveZ: number;
}

export const createShipMotion = (): ShipMotion => ({
  a: { x: 0, y: 0, z: 0 }, w: { x: 0, y: 0, z: 0 }, alpha: { x: 0, y: 0, z: 0 }, rhat: { x: 0, y: 1, z: 0 }, n2: 0, fDot: 0,
});

export function createCrew(layout: InteriorLayout, shipId: string): CrewState {
  const s = layout.spawn;
  return {
    shipId, pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z }, vel: { x: 0, y: 0, z: 0 }, yaw: s.yaw, pitch: 0, boots: true, gripped: true,
    posture: 'walking', seat: '', back: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
  };
}

// ------------------------------------------------------------------------------------------------ the ship's motion

const LI: V3 = { x: 0, y: 0, z: 0 };
const LF: V3 = { x: 0, y: 0, z: 0 };
const LT: V3 = { x: 0, y: 0, z: 0 };

/**
 * Proper acceleration and rotation of a craft in its own axes, from what was actually applied (SIMULATION.md §1.4,
 * W1-C 1): a = f̄/m and α = I⁻¹(τ̄ − ω × Iω) from the tick's consumed ledger mean (`mean`, dynamics.ts consumeLedger);
 * without one, from the craft's own unconsumed accumulators (fAcc/accT, a peek that consumes nothing). Engines,
 * jets, drag and the docked joint all reach the body this way; nothing is rebuilt from commands. Landed, the exact
 * ground reaction −g + Ω×(Ω×r) (the ground co-rotates). Also the local vertical r̂ and n² = μ/r³ (item 9).
 */
export function craftMotion(world: World, c: Craft, out: ShipMotion, mean?: LedgerMean | null): ShipMotion {
  const a = out.a, al = out.alpha, w = c.w;
  a.x = a.y = a.z = 0;
  al.x = al.y = al.z = 0;
  out.w.x = w.x; out.w.y = w.y; out.w.z = w.z;
  if (out.fDot !== undefined) out.fDot = 0;
  const b = world.bodies[c.primary];
  if (b) {
    if (out.rhat) out.n2 = localVertical(c.rel, b.mu, c.q, out.rhat);
    else out.n2 = 0;
  }
  if (c.destroyed) return out;
  const m = craftMass(c);
  if (c.landedOn !== null) {
    if (b) landedProperAccel(b.mu, c.rel, b.spinAxis, b.spinRate, c.q, a);
    return out;
  }
  const g = c.gyration;
  LI.x = m * g.x; LI.y = m * g.y; LI.z = m * g.z;
  if (mean) return motionFromLedger(mean.f, mean.tau, mean.T > 0 ? 1 : 0, m, LI, w, out);
  const T = c.accT;
  if (!(T > 0)) return motionFromLedger(c.fAcc, c.tauAcc, 0, m, LI, w, out);
  LF.x = c.fAcc.x; LF.y = c.fAcc.y; LF.z = c.fAcc.z; LT.x = c.tauAcc.x; LT.y = c.tauAcc.y; LT.z = c.tauAcc.z;
  return motionFromLedger(LF, LT, T, m, LI, w, out);
}

/** Acceleration felt at ship-local point (px,py,pz) by something moving at (vx,vy,vz) relative to the ship. */
export function feltAt(m: ShipMotion, px: number, py: number, pz: number, vx: number, vy: number, vz: number, out: V3): V3 {
  const w = m.w, al = m.alpha, a = m.a;
  // ω × r
  const cx = w.y * pz - w.z * py, cy = w.z * px - w.x * pz, cz = w.x * py - w.y * px;
  out.x = -a.x - (w.y * cz - w.z * cy) - 2 * (w.y * vz - w.z * vy) - (al.y * pz - al.z * py);
  out.y = -a.y - (w.z * cx - w.x * cz) - 2 * (w.z * vx - w.x * vz) - (al.z * px - al.x * pz);
  out.z = -a.z - (w.x * cy - w.y * cx) - 2 * (w.x * vy - w.y * vx) - (al.x * py - al.y * px);
  return out;
}

/** Felt acceleration at the body's centre of mass. */
export function crewFelt(s: CrewState, m: ShipMotion, out: V3): V3 {
  const still = s.seat !== '';
  return feltAt(m, s.pos.x, s.pos.y + CREW_COM, s.pos.z, still ? 0 : s.vel.x, still ? 0 : s.vel.y, still ? 0 : s.vel.z, out);
}

// ------------------------------------------------------------------------------------------------ the interior as collision boxes

interface Compiled {
  /** minX, minY, minZ, maxX, maxY, maxZ per box: solids, wall panels (room faces minus door openings), decks, overheads. */
  b: Float64Array;
  n: number;
}

const compiled = new WeakMap<InteriorLayout, Compiled>();

function compile(layout: InteriorLayout): Compiled {
  let c = compiled.get(layout);
  if (c) return c;
  const list: number[] = [];
  const add = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void => {
    if (x1 - x0 > 1e-9 && y1 - y0 > 1e-9 && z1 - z0 > 1e-9) list.push(x0, y0, z0, x1, y1, z1);
  };
  for (const s of layout.solids) add(s.box.min.x, s.box.min.y, s.box.min.z, s.box.max.x, s.box.max.y, s.box.max.z);
  for (const r of layout.rooms) {
    const lo = r.box.min, hi = r.box.max;
    add(lo.x, lo.y - 0.5, lo.z, hi.x, lo.y, hi.z); // deck
    add(lo.x, hi.y, lo.z, hi.x, hi.y + 0.5, hi.z); // overhead
    // the four walls: each face, minus the openings of the doors that cross it
    for (let f = 0; f < 4; f++) {
      const alongX = f >= 2; // faces 2,3 are z = const and run along x
      const at = f === 0 ? lo.x : f === 1 ? hi.x : f === 2 ? lo.z : hi.z;
      const s0 = alongX ? lo.x : lo.z, s1 = alongX ? hi.x : hi.z;
      const holes: { a: number; b: number; y0: number; y1: number }[] = [];
      for (const d of layout.doors) {
        if (d.a !== r.id && d.b !== r.id) continue;
        const dl = d.box.min, dh = d.box.max;
        const crosses = alongX ? dl.z < at && dh.z > at : dl.x < at && dh.x > at;
        const a = Math.max(s0, alongX ? dl.x : dl.z), b = Math.min(s1, alongX ? dh.x : dh.z);
        if (crosses && b > a) holes.push({ a, b, y0: dl.y, y1: dh.y });
      }
      holes.sort((p, q) => p.a - q.a);
      const panel = (a: number, b: number, y0: number, y1: number): void => {
        if (alongX) add(a, y0, at - WALL, b, y1, at + WALL);
        else add(at - WALL, y0, a, at + WALL, y1, b);
      };
      let from = s0;
      for (const hole of holes) {
        panel(from, hole.a, lo.y, hi.y);
        panel(hole.a, hole.b, lo.y, hole.y0); // sill
        panel(hole.a, hole.b, hole.y1, hi.y); // lintel
        from = Math.max(from, hole.b);
      }
      panel(from, s1, lo.y, hi.y);
    }
  }
  c = { b: Float64Array.from(list), n: list.length / 6 };
  compiled.set(layout, c);
  return c;
}

const inBox = (lo: V3, hi: V3, x: number, y: number, z: number, e: number): boolean =>
  x >= lo.x - e && x <= hi.x + e && y >= lo.y - e && y <= hi.y + e && z >= lo.z - e && z <= hi.z + e;

/** The room at a point (a doorway counts as its room `a` unless a room box holds the point), or null. */
export function roomAt(layout: InteriorLayout, x: number, y: number, z: number): { id: string; name: string } | null {
  for (const r of layout.rooms) if (inBox(r.box.min, r.box.max, x, y, z, 1e-9)) return r;
  for (const d of layout.doors) {
    if (inBox(d.box.min, d.box.max, x, y, z, 1e-9)) return layout.rooms.find((r) => r.id === d.a) ?? null;
  }
  return null;
}

/** True when the body's centre is inside the walkable volume: in a room or a doorway and not inside a solid. */
export function crewInside(layout: InteriorLayout, s: CrewState): boolean {
  const x = s.pos.x, y = s.pos.y + CREW_COM, z = s.pos.z;
  let ok = false;
  for (const r of layout.rooms) if (inBox(r.box.min, r.box.max, x, y, z, 1e-6)) { ok = true; break; }
  if (!ok) for (const d of layout.doors) if (inBox(d.box.min, d.box.max, x, y, z, 1e-6)) { ok = true; break; }
  if (!ok || s.pos.y < -1e3) return false;
  if (s.seat !== '') return true; // sitting or lying on the furniture
  for (const b of layout.solids) {
    const lo = b.box.min, hi = b.box.max;
    if (x > lo.x && x < hi.x && z > lo.z && z < hi.z && s.pos.y + CREW_HEIGHT > lo.y + 1e-3 && s.pos.y < hi.y - 1e-3) return false;
  }
  return true;
}

/** Height of the deck under (x, z) at or below the feet (highest room/door floor there), or NaN. */
function deckUnder(layout: InteriorLayout, x: number, y: number, z: number): number {
  let best = NaN;
  for (const r of layout.rooms) {
    const lo = r.box.min, hi = r.box.max;
    if (x >= lo.x && x <= hi.x && z >= lo.z && z <= hi.z && lo.y <= y + 0.05 && !(lo.y <= best)) best = lo.y;
  }
  if (best === best) return best;
  for (const d of layout.doors) {
    const lo = d.box.min, hi = d.box.max;
    if (x >= lo.x && x <= hi.x && z >= lo.z && z <= hi.z && lo.y <= y + 0.05 && !(lo.y <= best)) best = lo.y;
  }
  return best;
}

/**
 * Push the body (an upright cylinder: feet at pos, CREW_RADIUS, CREW_HEIGHT) out of every box it overlaps and
 * take the normal velocity out with restitution `e` and Coulomb friction `mu`. `flat` keeps it on its deck.
 */
function collide(c: Compiled, s: CrewState, e: number, mu: number, flat: boolean): void {
  const p = s.pos, v = s.vel, b = c.b, R = CREW_RADIUS;
  for (let pass = 0; pass < 4; pass++) {
    let hit = false;
    for (let i = 0, k = 0; i < c.n; i++, k += 6) {
      const x0 = b[k], x1 = b[k + 3], z0 = b[k + 2], z1 = b[k + 5];
      if (p.x <= x0 - R || p.x >= x1 + R || p.z <= z0 - R || p.z >= z1 + R) continue;
      const up = b[k + 4] - p.y, down = p.y + CREW_HEIGHT - b[k + 1];
      if (up <= 1e-9 || down <= 1e-9) continue;
      const qx = p.x < x0 ? x0 : p.x > x1 ? x1 : p.x, qz = p.z < z0 ? z0 : p.z > z1 ? z1 : p.z;
      let nx = p.x - qx, nz = p.z - qz, pen: number;
      const d2 = nx * nx + nz * nz;
      if (d2 >= R * R) continue;
      if (d2 > 1e-18) {
        const d = Math.sqrt(d2);
        nx /= d; nz /= d;
        pen = R - d;
      } else {
        // the axis is inside the box's footprint: out through the nearest side
        const l = p.x - x0, r = x1 - p.x, n = p.z - z0, f = z1 - p.z;
        const m = Math.min(l, r, n, f);
        nx = m === l ? -1 : m === r ? 1 : 0;
        nz = nx !== 0 ? 0 : m === n ? -1 : 1;
        pen = R + m;
      }
      let ny = 0;
      const oy = up < down ? up : down;
      if (!flat && oy < pen) {
        ny = up < down ? 1 : -1;
        nx = nz = 0;
        pen = oy;
      }
      hit = true;
      p.x += nx * pen; p.y += ny * pen; p.z += nz * pen;
      const vn = v.x * nx + v.y * ny + v.z * nz;
      if (vn < 0) {
        const j = -(1 + (vn < -0.5 ? e : 0)) * vn;
        v.x += nx * j; v.y += ny * j; v.z += nz * j;
        if (mu > 0) {
          const un = v.x * nx + v.y * ny + v.z * nz;
          const tx = v.x - un * nx, ty = v.y - un * ny, tz = v.z - un * nz;
          const t = Math.sqrt(tx * tx + ty * ty + tz * tz);
          if (t > 1e-9) {
            const k2 = Math.min(1, (mu * j) / t);
            v.x -= tx * k2; v.y -= ty * k2; v.z -= tz * k2;
          }
        }
      }
    }
    if (!hit) break;
  }
}

/** True when some surface is within `reach` of the body. */
function surfaceNear(c: Compiled, s: CrewState, reach: number): boolean {
  const p = s.pos, b = c.b, R = CREW_RADIUS + reach;
  for (let i = 0, k = 0; i < c.n; i++, k += 6) {
    if (p.x <= b[k] - R || p.x >= b[k + 3] + R || p.z <= b[k + 2] - R || p.z >= b[k + 5] + R) continue;
    if (b[k + 4] - p.y <= -reach || p.y + CREW_HEIGHT - b[k + 1] <= -reach) continue;
    return true;
  }
  return false;
}

// ------------------------------------------------------------------------------------------------ stepping

const F: V3 = { x: 0, y: 0, z: 0 };
const LEG: V3 = { x: 0, y: 0, z: 0 };
const UP: V3 = { x: 0, y: 1, z: 0 };
const JMP: V3 = { x: 0, y: 0, z: 0 };
const DVB: V3 = { x: 0, y: 0, z: 0 };
const EVP: V3 = { x: 0, y: 0, z: 0 };
const V0: V3 = { x: 0, y: 0, z: 0 };
const AB: V3 = { x: 0, y: 0, z: 0 };
const LD: V3 = { x: 0, y: 0, z: 0 };
/** Context of the step in progress (events): the ring or null, and the sim time of the tick. */
let subEv: EventRing | null = null;
let subT = 0;

/** The soles' events (body.ts: one per boot; a = 0 left, 1 right): 'boot' on a catch, 'bootOff' when they let go. */
function soleEvent(kind: 'boot' | 'bootOff', s: CrewState, vn: number): void {
  const ev = subEv;
  if (!ev) return;
  EVP.x = s.pos.x; EVP.y = s.pos.y; EVP.z = s.pos.z;
  emitEvent(ev, kind, subT, 0, 1, 0, EVP, UP, vn, MAT.steel, MAT.aluminium);
  emitEvent(ev, kind, subT, 1, 1, 0, EVP, UP, vn, MAT.steel, MAT.aluminium);
}

function letGo(s: CrewState): void {
  if (!s.gripped) return;
  s.gripped = false;
  soleEvent('bootOff', s, s.vel.y);
}

/** Do two booted soles at gap 0 hold the felt load F (m/s², at the body) in their friction cone? */
function soleHolds(f: V3): boolean {
  const N = 2 * BOOT_F0 - CREW_MASS * f.y; // the magnets plus the felt load into the deck (f.y < 0 presses)
  if (!(N > 0)) return false;
  const T = BOOT_MU_S * N;
  return CREW_MASS * CREW_MASS * (f.x * f.x + f.z * f.z) <= T * T;
}

function sub(s: CrewState, layout: InteriorLayout, c: Compiled, m: ShipMotion, input: CrewInput, h: number): void {
  const p = s.pos, v = s.vel;
  const px = p.x, py = p.y, pz = p.z;
  feltAt(m, p.x, p.y + CREW_COM, p.z, v.x, v.y, v.z, F);
  const deck = deckUnder(layout, p.x, p.y, p.z);
  const hasDeck = deck === deck;
  const M = CREW_MASS;
  // a gripped sole stays on its deck (it follows a sill or a step the knee can take); off it, or unbooted, it lets go
  if (s.gripped && !(s.boots && hasDeck && p.y - deck <= BOOT_SNAP && p.y - deck >= -BOOT_SNAP)) letGo(s);
  if (s.gripped && !soleHolds(F)) letGo(s); // the felt load leaves the friction cone (or pulls the soles off): they slip
  if (s.gripped) {
    // the legs steer the body toward the commanded velocity: F_leg = m(a_cmd − f_t), limited by the traction and 1 kN
    p.y = deck;
    v.y = 0;
    let mx = input.moveX, mz = input.moveZ;
    let mag = Math.sqrt(mx * mx + mz * mz);
    if (!(mag > 0.02)) { mx = mz = mag = 0; }
    else if (mag > 1) { mx /= mag; mz /= mag; mag = 1; }
    let sp = mag === 0 ? 0 : mag <= 0.85 ? (WALK_SPEED * mag) / 0.85 : WALK_SPEED + ((RUN_SPEED - WALK_SPEED) * (mag - 0.85)) / 0.15;
    const cap = gaitSpeedCap(-F.y); // 1.1 m/s below 0.3 g felt into the deck, running only at ≥ 0.6 g
    if (sp > cap) sp = cap;
    if (mag > 0) sp /= mag;
    const cy = Math.cos(s.yaw), sy = Math.sin(s.yaw);
    // right = (cos, 0, -sin), forward = (-sin, 0, -cos)
    let ax = ((cy * mx - sy * mz) * sp - v.x) / h, az = ((-sy * mx - cy * mz) * sp - v.z) / h;
    const al = Math.sqrt(ax * ax + az * az);
    if (al > WALK_ACCEL) { ax *= WALK_ACCEL / al; az *= WALK_ACCEL / al; }
    const T = BOOT_MU_S * (2 * BOOT_F0 - M * F.y);
    legForce(M, ax, az, F.x, F.z, T, LEG);
    v.x += (F.x + LEG.x / M) * h; v.z += (F.z + LEG.z / M) * h;
    p.x += v.x * h; p.z += v.z * h;
    collide(c, s, 0, 0, true);
    p.y = deck;
  } else {
    let ay = F.y;
    const gap = hasDeck ? p.y - deck : Infinity;
    // the magnets draw booted soles toward a deck below: 2·F(g)/m
    if (s.boots && gap > 0 && gap <= BOOT_REACH) ay -= (2 * bootMagnet(gap)) / M;
    v.x += F.x * h; v.y += ay * h; v.z += F.z * h;
    p.x += v.x * h; p.y += v.y * h; p.z += v.z * h;
    if (s.boots && hasDeck) {
      // the soles meet the deck: they catch when slow enough and the felt load is inside their cone; else bounce
      const g2 = p.y - deck;
      if (g2 < CATCH_GAP && g2 > -0.25 && bootContact(g2 > 0 ? g2 : 0, v.y, M, 2) === SOLE_CATCH && soleHolds(F)) {
        const vIn = v.y < 0 ? -v.y : 0;
        p.y = deck;
        v.y = 0;
        s.gripped = true;
        if (!s.foot) s.foot = createFootBody();
        kneeLand(s.foot, vIn);
        soleEvent('boot', s, vIn);
      }
    }
    collide(c, s, CREW_RESTITUTION, CREW_FRICTION, s.gripped);
    if (s.gripped) p.y = deck;
  }
  s.posture = s.gripped ? 'walking' : 'floating';
  if (!crewInside(layout, s) || !(p.x === p.x && p.y === p.y && p.z === p.z)) {
    // last line of defence: never leave the ship
    p.x = px; p.y = py; p.z = pz;
    v.x = v.y = v.z = 0;
  }
}

/**
 * The tick's ship impulse (contact, latch, undock: tk.ledger.dv, dw) reaches the body once. Floating, it keeps its
 * inertial velocity (v += −Δv − Δω × r). Gripped, the deck carries it along only up to the shear impulse the soles
 * pass (bootImpulse: J ≤ μ_s·(F_mag + m·max(0, −f_n))·h); beyond that they slip, or lift when the deck drops away.
 */
function shipImpulse(s: CrewState, m: ShipMotion, tk: BodyTick): void {
  const dv = tk.ledger.dv, dw = tk.ledger.dw;
  if (dv.x === 0 && dv.y === 0 && dv.z === 0 && dw.x === 0 && dw.y === 0 && dw.z === 0) return;
  const p = s.pos, v = s.vel;
  EVP.x = p.x; EVP.y = p.y + CREW_COM; EVP.z = p.z;
  shipJumpAt(EVP, dv, dw, JMP);
  if (!s.gripped) { v.x += JMP.x; v.y += JMP.y; v.z += JMP.z; return; }
  feltAt(m, EVP.x, EVP.y, EVP.z, v.x, v.y, v.z, F);
  const r = bootImpulse(CREW_MASS, JMP, UP, 2 * BOOT_F0, F.y, tk.h, DVB);
  v.x += DVB.x; v.y += DVB.y; v.z += DVB.z;
  if (r !== BOOT_HELD) letGo(s);
}

/**
 * Advance the body by dt of ship time. Sub-stepped at 120 Hz or finer (and so that no sub-step moves it more
 * than a few centimetres), so the result does not depend on the frame rate and nothing tunnels. With the session's
 * tick context `tk`: the tick's ship impulse first (shipImpulse), events to tk.events, and once per tick the knee,
 * the head lag, the gait phase and the lean (FootBody; quasi-static — settled — under warp).
 */
export function stepCrew(s: CrewState, layout: InteriorLayout, m: ShipMotion, input: CrewInput, dt: number, tk?: BodyTick): void {
  if (!(dt > 0) || s.seat !== '') return;
  const c = compile(layout);
  subEv = tk ? tk.events : null;
  subT = tk ? tk.tick / 120 : 0;
  if (tk) shipImpulse(s, m, tk);
  const v = s.vel, a = m.a, w = m.w;
  V0.x = v.x; V0.y = v.y; V0.z = v.z;
  const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) + RUN_SPEED
    + (Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z) + (w.x * w.x + w.y * w.y + w.z * w.z) * 12) * dt;
  let n = Math.max(Math.ceil(dt / SUB_DT - 1e-9), Math.ceil((speed * dt) / MAX_MOVE));
  if (n < 1) n = 1;
  else if (n > 2000) n = 2000;
  const h = dt / n;
  for (let i = 0; i < n; i++) sub(s, layout, c, m, input, h);
  subEv = null;
  if (tk) footTick(s, layout, c, m, tk, dt);
}

/** Once per tick on foot: knee and head lag (the body's own acceleration), the gait phase, the lean, the felt load. */
function footTick(s: CrewState, layout: InteriorLayout, c: Compiled, m: ShipMotion, tk: BodyTick, dt: number): void {
  const fb = s.foot ?? (s.foot = createFootBody());
  const p = s.pos, v = s.vel;
  feltAt(m, p.x, p.y + CREW_COM, p.z, v.x, v.y, v.z, F);
  s.fn = s.gripped ? -F.y : 0;
  fb.leanT = tk.lean * LEAN_MAX_STAND;
  if (tk.ticks !== 1) {
    // under warp the body is quasi-static: the springs have settled, the lean is at its equilibrium
    settleFoot(fb);
    leanDir(tk.yaw, false, LD);
    leanTick(fb, F, LD, fb.leanT > 0 || fb.lean > 0 ? footLeanMax(s, layout, c) : LEAN_MAX_STAND, tk.h);
    return;
  }
  AB.x = (v.x - V0.x) / dt; AB.y = (v.y - V0.y) / dt; AB.z = (v.z - V0.z) / dt;
  if (!s.gripped) { AB.x = AB.y = AB.z = 0; } // floating, the head moves with the body (nothing pushes the hips)
  stepFoot(fb, AB);
  fb.phase = s.gripped ? gaitPhase(fb.phase, Math.sqrt(v.x * v.x + v.z * v.z), dt) : fb.phase;
  leanDir(tk.yaw, false, LD);
  leanTick(fb, F, LD, fb.leanT > 0 || fb.lean > 0 ? footLeanMax(s, layout, c) : LEAN_MAX_STAND, dt);
}

/** How far the standing head can lean along the look before its sphere meets something, m (≤ LEAN_MAX_STAND). */
function footLeanMax(s: CrewState, layout: InteriorLayout, c: Compiled): number {
  crewEye(s, layout, EVP);
  return leanClearance(c.b, c.n, EVP, LD, LEAN_MAX_STAND);
}

/** Jump from the deck (boots gripped), or push off a surface within reach along the look direction. */
export function pushOffCrew(s: CrewState, layout: InteriorLayout): boolean {
  if (s.seat !== '') return false;
  if (s.gripped) {
    s.vel.y = JUMP_SPEED;
    s.gripped = false; // the legs pull the soles out of the magnets' well (body.ts bootWell: ≈ 2 J)
    s.posture = 'floating';
    return true;
  }
  if (!surfaceNear(compile(layout), s, PUSH_REACH)) return false;
  const cp = Math.cos(s.pitch);
  s.vel.x += -Math.sin(s.yaw) * cp * PUSH_SPEED;
  s.vel.y += Math.sin(s.pitch) * PUSH_SPEED;
  s.vel.z += -Math.cos(s.yaw) * cp * PUSH_SPEED;
  return true;
}

/** Turn the head/body. */
export function lookCrew(s: CrewState, dYaw: number, dPitch: number): void {
  let y = s.yaw + dYaw;
  if (y > Math.PI) y -= 2 * Math.PI;
  else if (y < -Math.PI) y += 2 * Math.PI;
  s.yaw = y === y ? y : 0;
  const p = s.pitch + dPitch;
  s.pitch = p > 1.45 ? 1.45 : p < -1.45 ? -1.45 : p === p ? p : 0;
}

/** Sit at the table or lie in the bunk: the body is held by the furniture until it stands up. */
export function sitCrew(s: CrewState, layout: InteriorLayout, seat: 'table' | 'bunk'): void {
  if (s.seat === '') { s.back.x = s.pos.x; s.back.y = s.pos.y; s.back.z = s.pos.z; }
  const e = seat === 'bunk' ? layout.bunkEye : layout.tableEye;
  s.seat = seat;
  s.posture = seat === 'bunk' ? 'lying' : 'seated';
  s.pos.x = e.x; s.pos.y = e.y - (seat === 'bunk' ? 0.2 : 0.75); s.pos.z = e.z;
  s.vel.x = s.vel.y = s.vel.z = 0;
  s.gripped = false;
}

export function standCrew(s: CrewState): void {
  if (s.seat === '') return;
  s.seat = '';
  s.pos.x = s.back.x; s.pos.y = s.back.y; s.pos.z = s.back.z;
  s.vel.x = s.vel.y = s.vel.z = 0;
  s.posture = 'floating';
  s.gripped = false;
}

/** Eye position, ship-local. */
export function crewEye(s: CrewState, layout: InteriorLayout, out: V3): V3 {
  if (s.seat === 'bunk') { out.x = layout.bunkEye.x; out.y = layout.bunkEye.y; out.z = layout.bunkEye.z; }
  else if (s.seat === 'table') { out.x = layout.tableEye.x; out.y = layout.tableEye.y; out.z = layout.tableEye.z; }
  else { out.x = s.pos.x; out.y = s.pos.y + CREW_EYE; out.z = s.pos.z; }
  return out;
}

/** The interactable in reach: in the body's room, within its radius (plan distance) and roughly ahead. */
export function findPrompt(s: CrewState, layout: InteriorLayout): Interactable | null {
  if (s.seat !== '') return null;
  const x = s.pos.x, y = s.pos.y + CREW_COM, z = s.pos.z;
  const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
  let best: Interactable | null = null, bestScore = Infinity;
  for (const it of layout.interactables) {
    let here = false;
    for (const r of layout.rooms) if (r.id === it.room && inBox(r.box.min, r.box.max, x, y, z, 1e-6)) { here = true; break; }
    if (!here) for (const d of layout.doors) if ((d.a === it.room || d.b === it.room) && inBox(d.box.min, d.box.max, x, y, z, 1e-6)) { here = true; break; }
    if (!here) continue;
    const dx = it.pos.x - x, dz = it.pos.z - z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > it.radius) continue;
    const facing = d > 0.4 ? (dx * fx + dz * fz) / d : 1;
    if (facing < 0.2) continue;
    const score = d - 0.5 * facing;
    if (score < bestScore) { bestScore = score; best = it; }
  }
  return best;
}

// ================================================================================================ day-1 contract (W1-A)
// The session (W1-A) calls these once per tick (once per quantum under warp) with the BodyTick it fills; W1-C owns
// what happens inside. Each stub keeps today's behaviour (no seated body, no eye offset) until W1-C fills it.

/** What the session hands every body stepper per tick (or per quantum under warp). W1-A fills it; W1-C reads it. */
export interface BodyTick {
  /** World tick index at the END of the step (sim time = tick / 120 s). */
  tick: number;
  /** Ticks this step covers (1 at 1×; the quantum under warp) and its length, s (= ticks / 120). */
  ticks: number;
  h: number;
  /** The step's consumed ledger (dynamics.ts consumeLedger): mean proper force (N) and torque (N·m), impulses Δv, Δω; craft axes. */
  ledger: LedgerMean;
  /** The craft's attitude (local → inertial) at the end of the step. */
  q: Quat;
  /** The world's event ring (output only: emit, never read). */
  events: EventRing;
  /** Look yaw and pitch latched at the tick boundary, rad (CrewView conventions), and the lean the pinch asks for, 0..1. */
  yaw: number;
  pitch: number;
  lean: number;
}

export function createBodyTick(ledger: LedgerMean, events: EventRing): BodyTick {
  return { tick: 0, ticks: 1, h: 1 / 120, ledger, q: { x: 0, y: 0, z: 0, w: 1 }, events, yaw: 0, pitch: 0, lean: 0 };
}

/** Where a seated body sits: the helm (harness), the bunk (straps) or the lounge table bench. */
export type SeatKind = 'helm' | 'bunk' | 'table';
/** The seated body's state (torso, head, lean): body.ts HarnessBody. Saved by the session through save/loadSeatedBody. */
export type SeatedBody = HarnessBody;
export const createSeatedBody = (): SeatedBody => createHarnessBody();
export const saveSeatedBody = (b: SeatedBody): unknown => saveHarnessBody(b);
export const loadSeatedBody = (data: unknown): SeatedBody => loadHarnessBody(data);

/** Height of the seated torso's centre below the eye, m (where the seat and harness hold it). */
export const SEAT_DROP = 0.45;

/** Where the seated body's torso sits (its neutral point), ship-local: below the helm or table eye, at the bunk eye. */
export function seatPoint(seat: SeatKind, layout: InteriorLayout, out: V3): V3 {
  const e = seat === 'helm' ? layout.helmEye : seat === 'bunk' ? layout.bunkEye : layout.tableEye;
  out.x = e.x; out.y = e.y - (seat === 'bunk' ? 0 : SEAT_DROP); out.z = e.z;
  return out;
}
/** The neutral (straight-ahead) eye of a seat. */
const seatEye = (seat: SeatKind, layout: InteriorLayout): V3 => (seat === 'helm' ? layout.helmEye : seat === 'bunk' ? layout.bunkEye : layout.tableEye);

const SP: V3 = { x: 0, y: 0, z: 0 };
const SF: V3 = { x: 0, y: 0, z: 0 };
const SJ: V3 = { x: 0, y: 0, z: 0 };
const SD: V3 = { x: 0, y: 0, z: 0 };
const EO: V3 = { x: 0, y: 0, z: 0 };
const GE: V3 = { x: 0, y: 0, z: 0 };
const NK: V3 = { x: 0, y: 0, z: 0 };
// one-entry cache of the seated head's lean clearance (it depends only on the seat, the twist and the layout)
let clrLayout: InteriorLayout | null = null, clrSeat = '', clrYaw = NaN, clrVal = 0;

function seatLeanMax(layout: InteriorLayout, seat: SeatKind, yaw: number, dir: V3, want: number): number {
  if (clrLayout === layout && clrSeat === seat && clrYaw === yaw) return clrVal;
  const c = compile(layout);
  clrVal = leanClearance(c.b, c.n, seatEye(seat, layout), dir, want);
  clrLayout = layout; clrSeat = seat; clrYaw = yaw;
  return clrVal;
}

/**
 * Step a seated body (harness / bunk straps / table) by one tick context (SIMULATION.md W1-C 2, 3): the tick's ship
 * impulse reaches the torso through the seat point (v += −Δv − Δω × r: a latch or a bump throws it into the straps),
 * then the torso on its unilateral seat / harness springs and the head lag on the torso (body.ts stepHarnessBody: 4
 * exact sub-steps at h = Q; the closed-form equilibrium for h > QS_DT, so a sleeping body under warp never runs a
 * spring at 83 ms) under the felt load at the seat (the tick's ledger mean), and the lean the pinch asks for along
 * the look (harnessed: the torso twists ±40° at most), stopped where the head sphere would meet glass.
 */
export function stepSeated(b: SeatedBody, seat: SeatKind, layout: InteriorLayout, m: ShipMotion, tk: BodyTick): void {
  const def = seat === 'bunk' ? BUNK_DEF : HELM_DEF;
  seatPoint(seat, layout, SP);
  const dv = tk.ledger.dv, dw = tk.ledger.dw;
  if (dv.x !== 0 || dv.y !== 0 || dv.z !== 0 || dw.x !== 0 || dw.y !== 0 || dw.z !== 0) {
    shipJumpAt(SP, dv, dw, SJ);
    b.v.x += SJ.x; b.v.y += SJ.y; b.v.z += SJ.z;
  }
  feltAt(m, SP.x, SP.y, SP.z, 0, 0, 0, SF);
  let dir: V3 | null = null, lmax = 0;
  if (seat !== 'bunk') {
    leanDir(tk.yaw, seat === 'helm', SD);
    dir = SD;
    b.leanT = tk.lean * LEAN_MAX_HELM;
    lmax = b.leanT > 0 || b.lean > 0 ? seatLeanMax(layout, seat, tk.yaw, SD, LEAN_MAX_HELM) : LEAN_MAX_HELM;
  } else b.leanT = 0;
  stepHarnessBody(b, def, SF, dir, lmax, tk.h);
}

/**
 * The eye's displacement by the body, ship axes, m (CrewView.eyeOffset; the session adds it to the neutral eye):
 * seated (`seated` non-null: torso in its harness, head lag, lean; body.ts helmEyeOffset) or on foot (`crew`: knee,
 * head lag, gait bob, lean; footEyeOffset), plus the turn of the head about its neck pivot (neckEyeDelta: on foot the
 * body turns with the yaw, so only the pitch moves the eye about the neck). A translation only: the VOR holds the gaze,
 * the view never tilts. Clamped so the head sphere (r 0.10 m) never passes through glass or a bulkhead.
 */
export function eyeOffsetOf(crew: CrewState | null, seated: SeatedBody | null, seat: SeatKind | '', layout: InteriorLayout | null, yaw: number, pitch: number, out: V3): V3 {
  out.x = 0; out.y = 0; out.z = 0;
  if (!layout) return out;
  const c = compile(layout);
  if (seated && seat !== '') {
    const dir = seat === 'bunk' ? null : leanDir(yaw, seat === 'helm', SD);
    helmEyeOffset(seated, dir, out);
    if (seat !== 'bunk') {
      neckEyeDelta(yaw, pitch, NK);
      out.x += NK.x; out.y += NK.y; out.z += NK.z;
    }
    const e = seatEye(seat, layout);
    EO.x = e.x; EO.y = e.y; EO.z = e.z;
    return clampEyeOffset(c.b, c.n, EO, out);
  }
  if (!crew || crew.seat !== '') return out;
  const fb = crew.foot;
  const v = crew.vel, speed = crew.gripped ? Math.sqrt(v.x * v.x + v.z * v.z) : 0;
  if (fb) {
    leanDir(yaw, false, SD);
    footEyeOffset(fb, SD, gaitEye(fb.phase, crew.fn ?? 0, speed, GE), out);
  }
  // pitch about the neck, turned with the body's yaw
  neckEyeDelta(0, pitch, NK);
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  out.x += NK.z * sy; out.y += NK.y; out.z += NK.z * cy;
  crewEye(crew, layout, EO);
  return clampEyeOffset(c.b, c.n, EO, out);
}
