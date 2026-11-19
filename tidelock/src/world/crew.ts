// The pilot as a body inside the ship (docs/ARCHITECTURE.md §3). Pure TypeScript, deterministic, plain-JSON state.
//
// The body lives in the ship's frame (ship-local axes: forward -Z, up +Y, starboard +X; origin = the craft's
// origin, taken as its centre of mass). The ship is in free fall, so gravity does not appear: ship and pilot fall
// together. What moves a loose body is the acceleration it feels in that frame:
//
//   felt = -(ship's proper acceleration) - ω × (ω × r) - 2 ω × v - α × r
//
// (thrust presses everything toward the stern; a turning ship adds centrifugal, Coriolis and Euler terms).
// Magnetic boots grip a deck (a room floor) and hold up to BOOT_HOLD; beyond that the body slides and falls
// like anything loose. Movement stays inside the layout's rooms and doors, minus the solids.

import type { V3 } from '../core/types';
import type { Interactable, InteriorLayout } from '../data/interiors';
import { clamp1, qRotInv } from './math';
import { craftMass, type Craft, type World } from './state';

/**
 * Collision radius of the body about its long axis, m. A person sidles through a gap far narrower than their
 * shoulders; the Wren's bunk-room aisle is 0.45 m wide, so the hard radius is the half-depth of a turned body.
 */
export const CREW_RADIUS = 0.18;
export const CREW_HEIGHT = 1.75;
export const CREW_EYE = 1.62;
/** Height of the body's centre of mass above the feet, m. */
export const CREW_COM = 0.95;
export const WALK_SPEED = 1.4;
export const RUN_SPEED = 2.2;
/** How hard booted feet can change the body's velocity along the deck, m/s². */
export const WALK_ACCEL = 8;
/** Felt acceleration (along the deck, or away from it) beyond which the boots let go, m/s². */
export const BOOT_HOLD = 4;
/** Magnets pull the feet toward a deck within this distance, m, with this acceleration, m/s². */
export const BOOT_REACH = 0.4;
export const BOOT_PULL = 2;
const BOOT_SNAP = 0.03;
const BOOT_CATCH_SPEED = 0.3;
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
}

/** The ship's motion as the body needs it, all in ship-local axes. */
export interface ShipMotion {
  /** Proper (non-gravitational) acceleration of the ship, m/s². */
  a: V3;
  /** Angular velocity, rad/s, and angular acceleration, rad/s². */
  w: V3;
  alpha: V3;
}

export interface CrewInput {
  /** Strafe (+ = right) and forward (+ = where the pilot faces), each -1..1. */
  moveX: number;
  moveZ: number;
}

export const createShipMotion = (): ShipMotion => ({ a: { x: 0, y: 0, z: 0 }, w: { x: 0, y: 0, z: 0 }, alpha: { x: 0, y: 0, z: 0 } });

export function createCrew(layout: InteriorLayout, shipId: string): CrewState {
  const s = layout.spawn;
  return {
    shipId, pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z }, vel: { x: 0, y: 0, z: 0 }, yaw: s.yaw, pitch: 0, boots: true, gripped: true,
    posture: 'walking', seat: '', back: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
  };
}

// ------------------------------------------------------------------------------------------------ the ship's motion

/**
 * Proper acceleration and rotation of a craft in its own axes, from its state and commands: main drive and RCS
 * (while there is propellant), the ground's push when it rests on a surface, torque through Euler's equations.
 * Aerodynamic and contact forces during flight are not included.
 */
export function craftMotion(world: World, c: Craft, out: ShipMotion): ShipMotion {
  const a = out.a, al = out.alpha, w = c.w;
  a.x = a.y = a.z = 0;
  al.x = al.y = al.z = 0;
  out.w.x = w.x; out.w.y = w.y; out.w.z = w.z;
  if (c.destroyed) return out;
  const m = craftMass(c);
  if (c.landedOn !== null) {
    // Held up by the ground: the proper acceleration is minus gravity, so the crew feels the body's pull.
    const b = world.bodies[c.primary], r = c.rel;
    const d = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z);
    if (b && d > 0) {
      const g = b.mu / (d * d * d);
      qRotInv(a, c.q, r.x * g, r.y * g, r.z * g);
    }
    return out;
  }
  if (c.dockedTo !== null) return out; // the latch interlocks drive and RCS; the joint carries the attitude
  if (c.propellant > 0) {
    const thr = c.throttle > 1 ? 1 : c.throttle > 0 ? c.throttle : 0;
    a.x = (clamp1(c.rcs.x) * c.rcsThrust) / m;
    a.y = (clamp1(c.rcs.y) * c.rcsThrust) / m;
    a.z = (clamp1(c.rcs.z) * c.rcsThrust - thr * c.mainThrust) / m;
  }
  const g = c.gyration;
  const Ix = m * g.x, Iy = m * g.y, Iz = m * g.z;
  if (Ix > 0 && Iy > 0 && Iz > 0) {
    al.x = (clamp1(c.torque.x) * c.maxTorque.x + (Iy - Iz) * w.y * w.z) / Ix;
    al.y = (clamp1(c.torque.y) * c.maxTorque.y + (Iz - Ix) * w.z * w.x) / Iy;
    al.z = (clamp1(c.torque.z) * c.maxTorque.z + (Ix - Iy) * w.x * w.y) / Iz;
  }
  return out;
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

function sub(s: CrewState, layout: InteriorLayout, c: Compiled, m: ShipMotion, input: CrewInput, h: number): void {
  const p = s.pos, v = s.vel;
  const px = p.x, py = p.y, pz = p.z;
  feltAt(m, p.x, p.y + CREW_COM, p.z, v.x, v.y, v.z, F);
  const deck = deckUnder(layout, p.x, p.y, p.z);
  const hasDeck = deck === deck;
  const along = Math.sqrt(F.x * F.x + F.z * F.z);
  const grip = s.boots && hasDeck && p.y - deck <= BOOT_SNAP && v.y <= BOOT_CATCH_SPEED && along <= BOOT_HOLD && F.y <= BOOT_HOLD;
  if (grip) {
    // The boots hold the feet to the deck; the legs steer the body toward the commanded velocity.
    p.y = deck;
    v.y = 0;
    let mx = input.moveX, mz = input.moveZ;
    let mag = Math.sqrt(mx * mx + mz * mz);
    if (!(mag > 0.02)) { mx = mz = mag = 0; }
    else if (mag > 1) { mx /= mag; mz /= mag; mag = 1; }
    const sp = mag === 0 ? 0 : (mag <= 0.85 ? (WALK_SPEED * mag) / 0.85 : WALK_SPEED + ((RUN_SPEED - WALK_SPEED) * (mag - 0.85)) / 0.15) / mag;
    const cy = Math.cos(s.yaw), sy = Math.sin(s.yaw);
    // right = (cos, 0, -sin), forward = (-sin, 0, -cos)
    const dx = (cy * mx - sy * mz) * sp - v.x, dz = (-sy * mx - cy * mz) * sp - v.z;
    const d = Math.sqrt(dx * dx + dz * dz), lim = WALK_ACCEL * h;
    const k = d > lim ? lim / d : 1;
    v.x += dx * k; v.z += dz * k;
    p.x += v.x * h; p.z += v.z * h;
    collide(c, s, 0, 0, true);
    p.y = deck;
  } else {
    let ay = F.y;
    if (s.boots && hasDeck && p.y > deck && p.y - deck <= BOOT_REACH) ay -= BOOT_PULL; // the magnets draw the feet down
    v.x += F.x * h; v.y += ay * h; v.z += F.z * h;
    p.x += v.x * h; p.y += v.y * h; p.z += v.z * h;
    collide(c, s, CREW_RESTITUTION, CREW_FRICTION, false);
  }
  s.gripped = grip;
  s.posture = grip ? 'walking' : 'floating';
  if (!crewInside(layout, s) || !(p.x === p.x && p.y === p.y && p.z === p.z)) {
    // last line of defence: never leave the ship
    p.x = px; p.y = py; p.z = pz;
    v.x = v.y = v.z = 0;
  }
}

/**
 * Advance the body by dt of ship time. Sub-stepped at 120 Hz or finer (and so that no sub-step moves it more
 * than a few centimetres), so the result does not depend on the frame rate and nothing tunnels.
 */
export function stepCrew(s: CrewState, layout: InteriorLayout, m: ShipMotion, input: CrewInput, dt: number): void {
  if (!(dt > 0) || s.seat !== '') return;
  const c = compile(layout);
  const v = s.vel, a = m.a, w = m.w;
  const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) + RUN_SPEED
    + (Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z) + (w.x * w.x + w.y * w.y + w.z * w.z) * 12) * dt;
  let n = Math.max(Math.ceil(dt / SUB_DT - 1e-9), Math.ceil((speed * dt) / MAX_MOVE));
  if (n < 1) n = 1;
  else if (n > 2000) n = 2000;
  const h = dt / n;
  for (let i = 0; i < n; i++) sub(s, layout, c, m, input, h);
}

/** Jump from the deck (boots gripped), or push off a surface within reach along the look direction. */
export function pushOffCrew(s: CrewState, layout: InteriorLayout): boolean {
  if (s.seat !== '') return false;
  if (s.gripped) {
    s.vel.y = JUMP_SPEED;
    s.gripped = false;
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
