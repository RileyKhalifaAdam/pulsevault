// Contact: craft against station colliders (impulses with restitution and friction, damage by the energy
// lost), craft against the ground (wrecked above LAND_MAX_SPEED, otherwise resting contact on the rotating
// surface until thrust lifts it), and docking latches (joints that close inside the tolerances below and are
// released by undock() with a spring impulse). Ships collide as their bounding sphere.
//
// Docking tolerances (chosen for a phone): the ship's collar within DOCK_DISTANCE of the port's mating point,
// relative speed under DOCK_SPEED, collar axis within DOCK_ANGLE of the reversed port axis, port free and
// large enough, latch armed. The latch keeps the relative pose it closed at; linear momentum is conserved.
// While latched the ship's drive and RCS are interlocked (they produce no force).

import type { DockingPortDef, Quat, StationCollider, V3 } from '../core/types';
import { PAD_ORDER } from '../data/stationLayouts';
import { CONTACT_HEIGHT, WHY_CONTACT, WHY_FREE, WHY_PROXIMITY } from './dynamics';
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

const A = { x: 0, y: 0, z: 0 }, B = { x: 0, y: 0, z: 0 }, C = { x: 0, y: 0, z: 0 }, E = { x: 0, y: 0, z: 0 };
const PL = { x: 0, y: 0, z: 0 }, NL = { x: 0, y: 0, z: 0 }, CL = { x: 0, y: 0, z: 0 }, CP = { x: 0, y: 0, z: 0 };
const Q1: Quat = { x: 0, y: 0, z: 0, w: 1 };
let _pDist = 0, _pCos = 0, _pSpeed = 0, _syncWhy = WHY_FREE;

const mass = (c: Craft): number => c.dryMass + c.propellant;

function closestOnCollider(col: StationCollider, p: V3, out: V3): void {
  const a = col.a, b = col.b;
  if (col.kind === 'sphere' || !b) { out.x = a.x; out.y = a.y; out.z = a.z; return; }
  const ex = b.x - a.x, ey = b.y - a.y, ez = b.z - a.z;
  let t = ((p.x - a.x) * ex + (p.y - a.y) * ey + (p.z - a.z) * ez) / (ex * ex + ey * ey + ez * ez);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  out.x = a.x + t * ex; out.y = a.y + t * ey; out.z = a.z + t * ez;
}

// ------------------------------------------------------------------------------------------------ ground

/** A craft has reached the ground of its primary at time t: wreck it or rest it, and pin it to the surface. */
export function surfaceContact(world: World, c: Craft, t: number): void {
  const b = world.bodies[c.primary], n = b.spinAxis, wr = b.spinRate;
  const rel = c.rel, rv = c.relV;
  const vx = rv.x - wr * (n.y * rel.z - n.z * rel.y), vy = rv.y - wr * (n.z * rel.x - n.x * rel.z), vz = rv.z - wr * (n.x * rel.y - n.y * rel.x);
  const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (!c.destroyed) {
    if (!b.solid || speed > LAND_MAX_SPEED) {
      pushEvent(world, { type: 'impact', t, craftId: c.id, with: b.id, speed });
      destroyCraft(world, c, b.solid ? 'impact' : 'crushed', t);
    } else {
      pushEvent(world, { type: 'landed', t, craftId: c.id, bodyId: b.id });
    }
  }
  const ang = b.spinAngle0 + wr * t;
  const lp = rotAxis({ x: 0, y: 0, z: 0 }, n, -ang, rel.x, rel.y, rel.z);
  const k = (b.radius + CONTACT_HEIGHT * c.radius) / Math.sqrt(lp.x * lp.x + lp.y * lp.y + lp.z * lp.z);
  lp.x *= k; lp.y *= k; lp.z *= k;
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

/** Apply impulse J (world axes) at offset `r` (world axes, from the centre of mass) to a craft. */
function applyImpulse(c: Craft, jx: number, jy: number, jz: number, rx: number, ry: number, rz: number): void {
  const m = mass(c), g = c.gyration;
  c.relV.x += jx / m; c.relV.y += jy / m; c.relV.z += jz / m;
  qRotInv(E, c.q, ry * jz - rz * jy, rz * jx - rx * jz, rx * jy - ry * jx);
  c.w.x += E.x / (m * g.x); c.w.y += E.y / (m * g.y); c.w.z += E.z / (m * g.z);
}

/** (r × d)ᵀ I⁻¹ (r × d) for a craft: the rotational part of its inverse effective mass along d at offset r. */
function angularTerm(c: Craft, rx: number, ry: number, rz: number, dx: number, dy: number, dz: number): number {
  const m = mass(c), g = c.gyration;
  qRotInv(E, c.q, ry * dz - rz * dy, rz * dx - rx * dz, rx * dy - ry * dx);
  return (E.x * E.x) / (m * g.x) + (E.y * E.y) / (m * g.y) + (E.z * E.z) / (m * g.z);
}

/** Resolve ship-against-station contacts and close docking latches, with both at time t. */
export function resolveContacts(world: World, t: number): void {
  const craft = world.craft;
  for (let i = 0; i < craft.length; i++) {
    const s = craft[i];
    if (s.kind === 'station' || s.dockedTo !== null || s.landedOn !== null) continue;
    for (let k = 0; k < craft.length; k++) {
      const st = craft[k];
      if (st.kind !== 'station' || st.primary !== s.primary) continue;
      const dx = s.rel.x - st.rel.x, dy = s.rel.y - st.rel.y, dz = s.rel.z - st.rel.z;
      const reach = st.radius + s.radius + DOCK_DISTANCE;
      if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
      qRotInv(PL, st.q, dx, dy, dz);
      if (s.dockingArmed && !s.destroyed && s.dockPort && tryLatch(world, s, st, PL, t)) break;
      // Deepest penetration of the ship's sphere into the station's colliders.
      let pen = 0;
      const cols = st.colliders;
      for (let c = 0; c < cols.length; c++) {
        closestOnCollider(cols[c], PL, CP);
        const ex = PL.x - CP.x, ey = PL.y - CP.y, ez = PL.z - CP.z;
        const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
        const p = s.radius + cols[c].radius - d;
        if (p > pen && d > 1e-9) {
          pen = p;
          NL.x = ex / d; NL.y = ey / d; NL.z = ez / d;
          CL.x = CP.x + NL.x * cols[c].radius; CL.y = CP.y + NL.y * cols[c].radius; CL.z = CP.z + NL.z * cols[c].radius;
        }
      }
      if (pen <= 0) continue;
      const m = mass(s), M = mass(st);
      qRot(A, st.q, NL.x, NL.y, NL.z); // normal, world (station -> ship)
      const nx = A.x, ny = A.y, nz = A.z;
      qRot(B, st.q, CL.x, CL.y, CL.z); // contact offset from the station's centre, world
      const tx = B.x, ty = B.y, tz = B.z;
      const sx = -nx * s.radius, sy = -ny * s.radius, sz = -nz * s.radius; // offset from the ship's centre
      qRot(C, s.q, s.w.x, s.w.y, s.w.z);
      let vx = s.relV.x + (C.y * sz - C.z * sy), vy = s.relV.y + (C.z * sx - C.x * sz), vz = s.relV.z + (C.x * sy - C.y * sx);
      qRot(C, st.q, st.w.x, st.w.y, st.w.z);
      vx -= st.relV.x + (C.y * tz - C.z * ty); vy -= st.relV.y + (C.z * tx - C.x * tz); vz -= st.relV.z + (C.x * ty - C.y * tx);
      const vn = vx * nx + vy * ny + vz * nz;
      if (vn < 0) {
        const kn = 1 / m + 1 / M + angularTerm(st, tx, ty, tz, nx, ny, nz);
        const e = vn < -0.05 ? RESTITUTION : 0;
        const jn = (-(1 + e) * vn) / kn;
        let jx = jn * nx, jy = jn * ny, jz = jn * nz;
        const ux = vx - vn * nx, uy = vy - vn * ny, uz = vz - vn * nz;
        const ut = Math.sqrt(ux * ux + uy * uy + uz * uz);
        if (ut > 1e-6) {
          const dxx = ux / ut, dyy = uy / ut, dzz = uz / ut;
          const kt = 1 / m + 1 / M + angularTerm(s, sx, sy, sz, dxx, dyy, dzz) + angularTerm(st, tx, ty, tz, dxx, dyy, dzz);
          let jt = ut / kt;
          if (jt > FRICTION * jn) jt = FRICTION * jn;
          jx -= jt * dxx; jy -= jt * dyy; jz -= jt * dzz;
        }
        applyImpulse(s, jx, jy, jz, sx, sy, sz);
        applyImpulse(st, -jx, -jy, -jz, tx, ty, tz);
        // Energy lost along the normal does the damage.
        const lost = (0.5 * (1 - e * e) * vn * vn) / kn;
        if (vn < -0.2) pushEvent(world, { type: 'impact', t, craftId: s.id, with: st.id, speed: -vn });
        for (let h = 0; h < 2; h++) {
          const c = h === 0 ? s : st;
          if (c.destroyed) continue;
          c.hull -= lost / c.hullStrength;
          if (c.hull <= 0) destroyCraft(world, c, 'impact', t);
        }
      }
      if (pen > 0.01) {
        const push = pen - 0.01, fs = M / (M + m), ft = m / (M + m);
        s.rel.x += nx * push * fs; s.rel.y += ny * push * fs; s.rel.z += nz * push * fs;
        st.rel.x -= nx * push * ft; st.rel.y -= ny * push * ft; st.rel.z -= nz * push * ft;
      }
    }
  }
}

/** Why the last proximityLimit() was what it was: WHY_CONTACT, WHY_PROXIMITY or WHY_FREE. */
export const proximityWhy = (): number => _syncWhy;

/**
 * Longest time all craft may be advanced before ship/station pairs must be looked at together again: half the
 * earliest possible time for the gap between them (to the nearest collider, or to an armed latch) to close.
 */
export function proximityLimit(world: World): number {
  const craft = world.craft;
  let best = Infinity;
  _syncWhy = WHY_FREE;
  for (let i = 0; i < craft.length; i++) {
    const s = craft[i];
    if (s.kind === 'station' || s.dockedTo !== null || s.landedOn !== null) continue;
    for (let k = 0; k < craft.length; k++) {
      const st = craft[k];
      if (st.kind !== 'station' || st.primary !== s.primary) continue;
      const dx = s.rel.x - st.rel.x, dy = s.rel.y - st.rel.y, dz = s.rel.z - st.rel.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      let gap = d - st.radius - s.radius;
      let near = false;
      if (gap <= 0) {
        near = true;
        gap = Infinity;
        qRotInv(PL, st.q, dx, dy, dz);
        const cols = st.colliders;
        for (let c = 0; c < cols.length; c++) {
          closestOnCollider(cols[c], PL, CP);
          const g = Math.hypot(PL.x - CP.x, PL.y - CP.y, PL.z - CP.z) - cols[c].radius - s.radius;
          if (g < gap) gap = g;
        }
        if (s.dockingArmed && s.dockPort && !s.destroyed) {
          for (let p = 0; p < st.ports.length; p++) {
            portCheck(s, st, st.ports[p], PL);
            if (_pDist - 0.5 * DOCK_DISTANCE < gap) gap = _pDist - 0.5 * DOCK_DISTANCE;
          }
        }
      }
      const v = Math.hypot(s.relV.x - st.relV.x, s.relV.y - st.relV.y, s.relV.z - st.relV.z);
      const thrusting = !s.destroyed && s.propellant > 0 && (s.throttle > 0 || s.rcs.x !== 0 || s.rcs.y !== 0 || s.rcs.z !== 0);
      const a = 0.05 + (thrusting ? (s.mainThrust + s.rcsThrust) / mass(s) : 0);
      let dt = gap > 0 ? (0.5 * (Math.sqrt(v * v + 2 * a * gap) - v)) / a : 0;
      if (dt < 1 / 120) dt = 1 / 120;
      if (dt < best) { best = dt; _syncWhy = near && gap < 5 ? WHY_CONTACT : WHY_PROXIMITY; }
    }
  }
  return best;
}
