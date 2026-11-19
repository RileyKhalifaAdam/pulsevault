// Contact: craft against stations and against each other with their real shapes (compound hulls of
// src/data/hullColliders.ts and the stations' colliders, src/world/compound.ts): bounding spheres first, then the
// narrow phase into a persistent manifold and a sequential-impulse solve with restitution and friction; the
// energy the solve dissipates damages both hulls. Craft against the ground: the hull's lowest point meets the
// rotating surface, the touchdown is solved against the spinning ground (wrecked above LAND_MAX_SPEED), then the
// craft rests on its hull as a joint on the rotating surface until thrust lifts it. Docking latches are joints that
// close inside the tolerances below and are released by undock() with a spring impulse. The manifolds (warm-start
// impulses) are part of the saved world (world.contacts), so save -> load -> continue stays bit-identical in contact.
//
// Docking tolerances (chosen for a phone): the ship's collar within DOCK_DISTANCE of the port's mating point,
// relative speed under DOCK_SPEED, collar axis within DOCK_ANGLE of the reversed port axis, port free and
// large enough, latch armed. The latch keeps the relative pose it closed at; linear momentum is conserved.
// While latched the ship's drive and RCS are interlocked (they produce no force).

import type { DockingPortDef, Quat, V3 } from '../core/types';
import { PAD_ORDER } from '../data/stationLayouts';
import {
  bodyFromCraft, collide, collidePlanet, compoundSupport, craftCompound, DEFAULT_CONTACT, makeContactBody, makeContactResult, Manifold,
  manifoldState, planetBody, setManifoldState, solveManifold, type Compound, type ContactParams,
} from './compound';
import { WHY_CONTACT, WHY_FREE, WHY_PROXIMITY } from './dynamics';
import { qAxisTo, qConjMulTo, qMulTo, qRot, qRotInv, rotAxis } from './math';
import { bodyIndex, destroyCraft, findCraft, pushEvent, type Craft, type World } from './state';

export const DOCK_DISTANCE = 4;
export const DOCK_SPEED = 2;
export const DOCK_ANGLE = (20 * Math.PI) / 180;
export const UNDOCK_SPEED = 1;
export const RESTITUTION = 0.2;
export const FRICTION = 0.4;
/** Fastest touchdown (relative to the rotating ground) a hull survives, m/s. */
export const LAND_MAX_SPEED = 5;

/** Impacts faster than this (approach speed along the contact normal, m/s) raise an 'impact' event. */
export const IMPACT_EVENT_SPEED = 0.2;
/** Gap below which proximityLimit() looks at the real shapes (narrow phase with this margin), m. */
const NEAR_MARGIN = 3;

const A = { x: 0, y: 0, z: 0 }, B = { x: 0, y: 0, z: 0 };
const PL = { x: 0, y: 0, z: 0 };
const Q1: Quat = { x: 0, y: 0, z: 0, w: 1 };
const ORIGIN: V3 = { x: 0, y: 0, z: 0 };
let _pDist = 0, _pCos = 0, _pSpeed = 0, _syncWhy = WHY_FREE;

const mass = (c: Craft): number => c.dryMass + c.propellant;

/** Solver parameters: the world's restitution and friction on the compound solver's defaults. */
const PARAMS: ContactParams = { ...DEFAULT_CONTACT, restitution: RESTITUTION, friction: FRICTION };
/** The touchdown solve: impulses only (the joint then places the hull on the ground exactly). */
const TOUCHDOWN: ContactParams = { ...PARAMS, positionIterations: 0 };
const CA = makeContactBody(), CB = makeContactBody();
const RES = makeContactResult();
const SCRATCH = new Manifold();

// ------------------------------------------------------------------------------------------------ manifolds

/** Persistent manifolds of one world, per ordered pair of craft ids; pairs not looked at in a pass are dropped. */
class PairCache {
  readonly map = new Map<string, Map<string, Manifold>>();
  pass = 0;
  get(a: string, b: string): Manifold {
    let inner = this.map.get(a);
    if (!inner) { inner = new Map(); this.map.set(a, inner); }
    let m = inner.get(b);
    if (!m) { m = new Manifold(); inner.set(b, m); }
    m.used = this.pass + 1;
    return m;
  }
  sweep(): void {
    this.pass++;
    this.map.forEach(sweepInner, this);
  }
}
function sweepInner(this: PairCache, inner: Map<string, Manifold>, a: string): void {
  inner.forEach(dropStale, this);
  if (inner.size === 0) this.map.delete(a);
}
function dropStale(this: PairCache, m: Manifold, b: string, inner: Map<string, Manifold>): void {
  if (m.used < this.pass) inner.delete(b);
}
const CACHES = new WeakMap<World, PairCache>();
function cacheOf(world: World): PairCache {
  let c = CACHES.get(world);
  if (!c) {
    c = new PairCache();
    CACHES.set(world, c);
    // A loaded world brings its manifolds (warm-start impulses) along.
    const saved = world.contacts;
    if (saved) for (const s of saved) { const m = c.get(s.a, s.b); setManifoldState(m, s.m); m.used = c.pass; }
  }
  return c;
}

/** The persistent contact state of a world as plain data (saveWorld stores it in world.contacts). */
export function contactsForSave(world: World): { a: string; b: string; m: number[] }[] {
  const out: { a: string; b: string; m: number[] }[] = [];
  const c = CACHES.get(world);
  if (!c) return world.contacts ?? out;
  for (const [a, inner] of c.map) for (const [b, m] of inner) if (m.n > 0) out.push({ a, b, m: manifoldState(m) });
  return out;
}

/** World-axes centre of a craft's compound bounding sphere relative to the craft centre -> out. */
function boundCentre(c: Craft, k: Compound, out: V3): V3 {
  return qRot(out, c.q, k.cx, k.cy, k.cz);
}

// ------------------------------------------------------------------------------------------------ ground

/** How far the craft's hull reaches toward the centre of its primary (from the craft centre), m: its belly when level. */
export function groundReach(c: Craft): number {
  const k = craftCompound(c), r = c.rel, l = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z) || 1;
  qRotInv(A, c.q, -r.x / l, -r.y / l, -r.z / l);
  return compoundSupport(k, A.x, A.y, A.z);
}

/**
 * The hull of a craft has reached the ground of its primary at time t: the touchdown is solved against the
 * rotating ground with the real hull shape (impulses, energy -> hull damage), a crash (faster than LAND_MAX_SPEED
 * relative to the ground, or a broken hull) is a wreck, and the craft is pinned to the surface resting on its hull
 * (its lowest point on the ground, attitude as it touched) until thrust lifts it.
 */
export function surfaceContact(world: World, c: Craft, t: number): void {
  const b = world.bodies[c.primary], n = b.spinAxis, wr = b.spinRate;
  const rel = c.rel, rv = c.relV;
  const vx = rv.x - wr * (n.y * rel.z - n.z * rel.y), vy = rv.y - wr * (n.z * rel.x - n.x * rel.z), vz = rv.z - wr * (n.x * rel.y - n.y * rel.x);
  const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
  const ang = b.spinAngle0 + wr * t;
  if (!c.destroyed) {
    const k = craftCompound(c);
    bodyFromCraft(CA, c);
    planetBody(CB, ORIGIN, n, wr, ang);
    SCRATCH.clear();
    if (collidePlanet(k, CA, CB, b.radius, SCRATCH) > 0) {
      solveManifold(SCRATCH, CA, CB, 0, TOUCHDOWN, RES);
      c.hull -= RES.energy / c.hullStrength;
    }
    if (!b.solid || speed > LAND_MAX_SPEED || c.hull <= 0) {
      pushEvent(world, { type: 'impact', t, craftId: c.id, with: b.id, speed });
      destroyCraft(world, c, b.solid ? 'impact' : 'crushed', t);
    } else {
      pushEvent(world, { type: 'landed', t, craftId: c.id, bodyId: b.id });
    }
  }
  const reach = groundReach(c);
  const lp = rotAxis({ x: 0, y: 0, z: 0 }, n, -ang, rel.x, rel.y, rel.z);
  const kk = (b.radius + reach) / Math.sqrt(lp.x * lp.x + lp.y * lp.y + lp.z * lp.z);
  lp.x *= kk; lp.y *= kk; lp.z *= kk;
  const lq = qMulTo({ x: 0, y: 0, z: 0, w: 1 }, qAxisTo(Q1, n, -ang), c.q);
  world.joints.push({ kind: 'landed', craftId: c.id, otherId: b.id, portId: '', localPos: lp, localQ: lq });
  c.landedOn = b.id;
  c.load = 0;
}

// ------------------------------------------------------------------------------------------------ joints

/**
 * Move every jointed craft with what it is attached to (state at time t), burn propellant of grounded craft
 * that are thrusting over the elapsed `dt`, and release a grounded craft whose thrust exceeds its weight.
 */
export function updateJoints(world: World, t: number, dt: number): void {
  const joints = world.joints;
  for (let i = joints.length - 1; i >= 0; i--) {
    const j = joints[i];
    const c = findCraft(world, j.craftId);
    if (!c) continue;
    if (j.kind === 'landed') {
      const bi = bodyIndex(world, j.otherId);
      const b = world.bodies[bi], n = b.spinAxis, wr = b.spinRate;
      const ang = b.spinAngle0 + wr * t;
      rotAxis(c.rel, n, ang, j.localPos.x, j.localPos.y, j.localPos.z);
      const rel = c.rel;
      c.relV.x = wr * (n.y * rel.z - n.z * rel.y);
      c.relV.y = wr * (n.z * rel.x - n.x * rel.z);
      c.relV.z = wr * (n.x * rel.y - n.y * rel.x);
      c.primary = bi;
      qMulTo(c.q, qAxisTo(Q1, n, ang), j.localQ);
      qRotInv(c.w, c.q, wr * n.x, wr * n.y, wr * n.z);
      if (!c.destroyed && c.propellant > 0 && c.throttle > 0) {
        const thr = c.throttle > 1 ? 1 : c.throttle;
        const m = mass(c);
        const r = Math.sqrt(rel.x * rel.x + rel.y * rel.y + rel.z * rel.z);
        qRot(A, c.q, 0, 0, -1);
        const aUp = ((c.mainThrust * thr) / m) * ((A.x * rel.x + A.y * rel.y + A.z * rel.z) / r);
        const sp2 = c.relV.x * c.relV.x + c.relV.y * c.relV.y + c.relV.z * c.relV.z;
        const burn = ((c.mainThrust * thr) / c.exhaustVelocity) * dt;
        c.propellant = burn < c.propellant ? c.propellant - burn : 0;
        c.load = (c.mainThrust * thr) / m;
        if (aUp > b.mu / (r * r) - sp2 / r) {
          joints.splice(i, 1);
          c.landedOn = null;
          const k = 1 + 0.01 / r;
          rel.x *= k; rel.y *= k; rel.z *= k;
          pushEvent(world, { type: 'liftoff', t, craftId: c.id, bodyId: b.id });
        }
      }
    } else {
      const st = findCraft(world, j.otherId);
      if (!st) continue;
      qRot(A, st.q, j.localPos.x, j.localPos.y, j.localPos.z);
      c.rel.x = st.rel.x + A.x; c.rel.y = st.rel.y + A.y; c.rel.z = st.rel.z + A.z;
      const w = st.w, lp = j.localPos;
      qRot(B, st.q, w.y * lp.z - w.z * lp.y, w.z * lp.x - w.x * lp.z, w.x * lp.y - w.y * lp.x);
      c.relV.x = st.relV.x + B.x; c.relV.y = st.relV.y + B.y; c.relV.z = st.relV.z + B.z;
      c.primary = st.primary;
      qMulTo(c.q, st.q, j.localQ);
      qRotInv(c.w, j.localQ, w.x, w.y, w.z);
      c.load = 0;
    }
  }
}

// ------------------------------------------------------------------------------------------------ docking

const portFree = (world: World, stationId: string, portId: string): boolean => {
  const js = world.joints;
  for (let i = 0; i < js.length; i++) if (js[i].kind === 'dock' && js[i].otherId === stationId && js[i].portId === portId) return false;
  return true;
};

/** Distance collar-to-port, cos of the axis alignment and relative speed of ship `s` against a port. `pl` = ship centre, station-local. */
function portCheck(s: Craft, st: Craft, port: DockingPortDef, pl: V3): void {
  const dp = s.dockPort!;
  qRot(A, s.q, dp.pos.x, dp.pos.y, dp.pos.z);
  qRotInv(A, st.q, A.x, A.y, A.z);
  const dx = pl.x + A.x - port.pos.x, dy = pl.y + A.y - port.pos.y, dz = pl.z + A.z - port.pos.z;
  _pDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  qRot(B, s.q, dp.dir.x, dp.dir.y, dp.dir.z);
  qRotInv(B, st.q, B.x, B.y, B.z);
  _pCos = -(B.x * port.dir.x + B.y * port.dir.y + B.z * port.dir.z);
  const ux = s.relV.x - st.relV.x, uy = s.relV.y - st.relV.y, uz = s.relV.z - st.relV.z;
  _pSpeed = Math.sqrt(ux * ux + uy * uy + uz * uz);
}

const portFits = (s: Craft, port: DockingPortDef): boolean => PAD_ORDER.indexOf(s.pad) <= PAD_ORDER.indexOf(port.size);

function tryLatch(world: World, s: Craft, st: Craft, pl: V3, t: number): boolean {
  const ports = st.ports, cosMin = Math.cos(DOCK_ANGLE);
  for (let i = 0; i < ports.length; i++) {
    const port = ports[i];
    if (!portFits(s, port)) continue;
    portCheck(s, st, port, pl);
    if (_pDist > DOCK_DISTANCE || _pCos < cosMin || _pSpeed > DOCK_SPEED) continue;
    if (!portFree(world, st.id, port.id)) continue;
    // Perfectly inelastic capture: the pair moves on with its common centre-of-mass velocity.
    const m = mass(s), M = mass(st), k = m / (M + m);
    st.relV.x += (s.relV.x - st.relV.x) * k; st.relV.y += (s.relV.y - st.relV.y) * k; st.relV.z += (s.relV.z - st.relV.z) * k;
    world.joints.push({
      kind: 'dock', craftId: s.id, otherId: st.id, portId: port.id,
      localPos: { x: pl.x, y: pl.y, z: pl.z },
      localQ: qConjMulTo({ x: 0, y: 0, z: 0, w: 1 }, st.q, s.q),
    });
    s.dockedTo = st.id;
    s.dockPortId = port.id;
    s.relV.x = st.relV.x; s.relV.y = st.relV.y; s.relV.z = st.relV.z;
    pushEvent(world, { type: 'docked', t, craftId: s.id, stationId: st.id, portId: port.id });
    return true;
  }
  return false;
}

/** Release a docking latch with a spring impulse (UNDOCK_SPEED of separation along the port axis). The latch is disarmed. */
export function undock(world: World, craftId: string): boolean {
  const joints = world.joints;
  for (let i = 0; i < joints.length; i++) {
    const j = joints[i];
    if (j.kind !== 'dock' || j.craftId !== craftId) continue;
    const s = findCraft(world, craftId), st = findCraft(world, j.otherId);
    joints.splice(i, 1);
    if (!s) return false;
    s.dockedTo = null;
    s.dockPortId = null;
    s.dockingArmed = false;
    if (st) {
      const port = st.ports.find((p) => p.id === j.portId);
      if (port) qRot(A, st.q, port.dir.x, port.dir.y, port.dir.z);
      else qRot(A, st.q, j.localPos.x, j.localPos.y, j.localPos.z);
      const l = Math.sqrt(A.x * A.x + A.y * A.y + A.z * A.z) || 1;
      const m = mass(s), M = mass(st);
      const ks = (UNDOCK_SPEED * M) / (M + m) / l, kt = (UNDOCK_SPEED * m) / (M + m) / l;
      s.relV.x += A.x * ks; s.relV.y += A.y * ks; s.relV.z += A.z * ks;
      st.relV.x -= A.x * kt; st.relV.y -= A.y * kt; st.relV.z -= A.z * kt;
      s.v.x += A.x * ks; s.v.y += A.y * ks; s.v.z += A.z * ks;
    }
    pushEvent(world, { type: 'undocked', t: world.t, craftId, stationId: j.otherId });
    return true;
  }
  return false;
}

export interface DockingStatus {
  /** Nearest station (same primary) and the craft's distance / relative speed to it. */
  stationId: string | null;
  distance: number;
  relSpeed: number;
  /** Nearest free port that fits, its mating point relative to the craft centre and its outward axis (world axes). */
  portId: string | null;
  portOffset: V3;
  portAxis: V3;
  /** Collar-to-port distance, angle between the collar axis and the reversed port axis, distance off the port axis. */
  portDistance: number;
  alignment: number;
  lateral: number;
  canLatch: boolean;
  dockedTo: string | null;
}

const STATUS: DockingStatus = {
  stationId: null, distance: Infinity, relSpeed: 0, portId: null, portOffset: { x: 0, y: 0, z: 0 }, portAxis: { x: 0, y: 0, z: 1 },
  portDistance: Infinity, alignment: 0, lateral: 0, canLatch: false, dockedTo: null,
};

/** Docking read-out for a craft. The returned object is reused between calls: do not keep it. */
export function dockingStatus(world: World, craftId: string, out: DockingStatus = STATUS): DockingStatus {
  out.stationId = null; out.portId = null; out.distance = Infinity; out.relSpeed = 0; out.portDistance = Infinity;
  out.alignment = 0; out.lateral = 0; out.canLatch = false; out.dockedTo = null;
  const s = findCraft(world, craftId);
  if (!s) return out;
  out.dockedTo = s.dockedTo;
  let st: Craft | null = null;
  for (const c of world.craft) {
    if (c.kind !== 'station' || c.primary !== s.primary || c === s) continue;
    const d = Math.hypot(s.rel.x - c.rel.x, s.rel.y - c.rel.y, s.rel.z - c.rel.z);
    if (d < out.distance) { out.distance = d; st = c; }
  }
  if (!st) return out;
  out.stationId = st.id;
  out.relSpeed = Math.hypot(s.relV.x - st.relV.x, s.relV.y - st.relV.y, s.relV.z - st.relV.z);
  if (!s.dockPort) return out;
  qRotInv(PL, st.q, s.rel.x - st.rel.x, s.rel.y - st.rel.y, s.rel.z - st.rel.z);
  let best: DockingPortDef | null = null;
  for (const port of st.ports) {
    if (!portFits(s, port) || (!portFree(world, st.id, port.id) && s.dockPortId !== port.id)) continue;
    portCheck(s, st, port, PL);
    if (_pDist < out.portDistance) { out.portDistance = _pDist; best = port; }
  }
  if (!best) return out;
  portCheck(s, st, best, PL);
  out.portId = best.id;
  out.alignment = Math.acos(_pCos > 1 ? 1 : _pCos < -1 ? -1 : _pCos);
  out.canLatch = s.dockedTo === null && !s.destroyed && _pDist <= DOCK_DISTANCE && _pCos >= Math.cos(DOCK_ANGLE) && _pSpeed <= DOCK_SPEED;
  // Collar position relative to the mating point, station-local: split along / across the port axis.
  qRot(A, s.q, s.dockPort.pos.x, s.dockPort.pos.y, s.dockPort.pos.z);
  qRotInv(A, st.q, A.x, A.y, A.z);
  const dx = PL.x + A.x - best.pos.x, dy = PL.y + A.y - best.pos.y, dz = PL.z + A.z - best.pos.z;
  const along = dx * best.dir.x + dy * best.dir.y + dz * best.dir.z;
  out.lateral = Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - along * along));
  qRot(out.portAxis, st.q, best.dir.x, best.dir.y, best.dir.z);
  qRot(out.portOffset, st.q, best.pos.x - PL.x, best.pos.y - PL.y, best.pos.z - PL.z);
  return out;
}

// ------------------------------------------------------------------------------------------------ impacts

/** Can a craft take part in free contact (not latched, not resting on the ground)? */
const free = (c: Craft): boolean => c.dockedTo === null && c.landedOn === null;

/** Narrow phase + solve of one pair (s on A, o on B) with their compounds; damage, impact event. */
function contactPair(world: World, cache: PairCache, s: Craft, ks: Compound, o: Craft, ko: Compound, t: number, dtNext: number): void {
  const m = cache.get(s.id, o.id);
  bodyFromCraft(CA, s);
  bodyFromCraft(CB, o);
  if (collide(ks, CA, ko, CB, m) === 0) return;
  solveManifold(m, CA, CB, dtNext, PARAMS, RES);
  if (RES.points === 0) return;
  if (RES.approachSpeed > IMPACT_EVENT_SPEED) pushEvent(world, { type: 'impact', t, craftId: s.id, with: o.id, speed: RES.approachSpeed });
  if (RES.energy > 0) {
    for (let h = 0; h < 2; h++) {
      const c = h === 0 ? s : o;
      if (c.destroyed) continue;
      c.hull -= RES.energy / c.hullStrength;
      if (c.hull <= 0) destroyCraft(world, c, 'impact', t);
    }
  }
}

/** Do the bounding spheres of two craft (compounds ka, kb) overlap, with `extra` metres to spare? */
function spheresMeet(a: Craft, ka: Compound, b: Craft, kb: Compound, extra: number): boolean {
  boundCentre(a, ka, A);
  boundCentre(b, kb, B);
  const dx = a.rel.x + A.x - b.rel.x - B.x, dy = a.rel.y + A.y - b.rel.y - B.y, dz = a.rel.z + A.z - b.rel.z - B.z;
  const reach = ka.radius + kb.radius + extra;
  return dx * dx + dy * dy + dz * dz <= reach * reach;
}

/**
 * Resolve ship–station and ship–ship contacts with the real shapes and close docking latches, all craft at time t.
 * `dtNext` is the expected time to the next call (the span just taken), for speculative contacts and warm starts.
 */
export function resolveContacts(world: World, t: number, dtNext = 0): void {
  const craft = world.craft, cache = cacheOf(world);
  for (let i = 0; i < craft.length; i++) {
    const s = craft[i];
    if (s.kind === 'station' || !free(s)) continue;
    const ks = craftCompound(s);
    for (let k = 0; k < craft.length; k++) {
      const o = craft[k];
      if (o === s || o.primary !== s.primary) continue;
      if (o.kind === 'station') {
        if (!spheresMeet(s, ks, o, craftCompound(o), DOCK_DISTANCE)) continue;
        if (s.dockingArmed && !s.destroyed && s.dockPort) {
          qRotInv(PL, o.q, s.rel.x - o.rel.x, s.rel.y - o.rel.y, s.rel.z - o.rel.z);
          if (tryLatch(world, s, o, PL, t)) break;
        }
        contactPair(world, cache, s, ks, o, craftCompound(o), t, dtNext);
      } else if (k > i && free(o)) {
        const ko = craftCompound(o);
        if (spheresMeet(s, ks, o, ko, 0)) contactPair(world, cache, s, ks, o, ko, t, dtNext);
      }
    }
  }
  cache.sweep();
}

/** Why the last proximityLimit() was what it was: WHY_CONTACT, WHY_PROXIMITY or WHY_FREE. */
export const proximityWhy = (): number => _syncWhy;

/**
 * Lower bound of the gap between two craft's shapes, m (0 when touching): bounding spheres while they are apart
 * by NEAR_MARGIN or more, else the narrow phase with that margin (its speculative depths are the gaps).
 */
function shapeGap(a: Craft, ka: Compound, b: Craft, kb: Compound): number {
  boundCentre(a, ka, A);
  boundCentre(b, kb, B);
  const g = Math.hypot(a.rel.x + A.x - b.rel.x - B.x, a.rel.y + A.y - b.rel.y - B.y, a.rel.z + A.z - b.rel.z - B.z) - ka.radius - kb.radius;
  if (g >= NEAR_MARGIN) return g;
  bodyFromCraft(CA, a);
  bodyFromCraft(CB, b);
  const n = collide(ka, CA, kb, CB, SCRATCH, NEAR_MARGIN);
  if (n === 0) return NEAR_MARGIN;
  let deepest = -Infinity;
  for (let p = 0; p < n; p++) { const d = SCRATCH.depth(p); if (d > deepest) deepest = d; }
  return deepest >= 0 ? 0 : -deepest;
}

/** Shortest time for a gap to close at relative speed v with at most the craft's thrust (and a little more). */
function closeTime(s: Craft, gap: number, v: number): number {
  const thrusting = !s.destroyed && s.propellant > 0 && (s.throttle > 0 || s.rcs.x !== 0 || s.rcs.y !== 0 || s.rcs.z !== 0);
  const a = 0.05 + (thrusting ? (s.mainThrust + s.rcsThrust) / mass(s) : 0);
  const dt = gap > 0 ? (0.5 * (Math.sqrt(v * v + 2 * a * gap) - v)) / a : 0;
  return dt < 1 / 120 ? 1 / 120 : dt;
}

/**
 * Longest time all craft may be advanced before ship/station and ship/ship pairs must be looked at together again:
 * half the earliest possible time for the gap between their shapes (or to an armed latch) to close.
 */
export function proximityLimit(world: World): number {
  const craft = world.craft;
  let best = Infinity;
  _syncWhy = WHY_FREE;
  for (let i = 0; i < craft.length; i++) {
    const s = craft[i];
    if (s.kind === 'station' || !free(s)) continue;
    const ks = craftCompound(s);
    for (let k = 0; k < craft.length; k++) {
      const o = craft[k];
      if (o === s || o.primary !== s.primary) continue;
      const station = o.kind === 'station';
      if (!station && (k < i || !free(o))) continue;
      const ko = craftCompound(o);
      const dx = s.rel.x - o.rel.x, dy = s.rel.y - o.rel.y, dz = s.rel.z - o.rel.z;
      let gap: number, near = false;
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) - o.radius - s.radius > NEAR_MARGIN + DOCK_DISTANCE) {
        gap = Math.sqrt(dx * dx + dy * dy + dz * dz) - o.radius - s.radius;
      } else {
        gap = shapeGap(s, ks, o, ko);
        near = gap < NEAR_MARGIN;
        if (station && s.dockingArmed && s.dockPort && !s.destroyed) {
          qRotInv(PL, o.q, dx, dy, dz);
          for (let p = 0; p < o.ports.length; p++) {
            portCheck(s, o, o.ports[p], PL);
            if (_pDist - 0.5 * DOCK_DISTANCE < gap) gap = _pDist - 0.5 * DOCK_DISTANCE;
          }
        }
      }
      const v = Math.hypot(s.relV.x - o.relV.x, s.relV.y - o.relV.y, s.relV.z - o.relV.z);
      const dt = closeTime(s, gap, v);
      if (dt < best) { best = dt; _syncWhy = near && gap < 5 ? WHY_CONTACT : WHY_PROXIMITY; }
    }
  }
  return best;
}
