// Rendezvous sensors (docs/SIMULATION.md W3-C items 1–3): an S-band radar with a transponder on the target, a
// scanning lidar on the docking collar, their beam limits, noise and acquisition, line of sight against bodies (plus
// their sensible atmosphere) and craft structure, and the relative-navigation filter (relnav.ts) they feed. Flight
// Assist, the TGT and DOCK holds and the docking page read ONLY what this file returns; truth is read here (it is
// the sensor's physics) and in contact mechanics, nowhere else.
//
// Model (SI; all directions inertial unless named otherwise).
// - Tracked point: a station's designated docking port (its mating point; the transponder and the lidar
//   retro-reflector plate sit on each port, as on real ports), else the target craft's origin. Changing the
//   designated port starts a new track.
// - Radar 200 m … 200 km: σ_r = max(0.5 m, 1e-3·r), σ_ṙ = 0.02 m/s, angles 0.1° per axis. Needs the line of sight to
//   lie inside the ±70° gimbal cone about the dorsal axis, a port transponder facing within 80°, and 3 s of
//   continuous visibility to acquire.
// - Lidar 1 m … 2 km: σ_r = 2 cm, bearing 0.02° per axis, scan cone ±30° about the collar axis, the reflector plate
//   facing within 60°, 1 s to acquire. Inside 200 m it measures the 6-DOF pose of the port target: the port axis and
//   up vector with σ = 0.2° per axis, smoothed with τ = 0.5 s (the DOCK hold's reference).
// - Line of sight: the segment sensor → tracked point against every body's sphere of radius R + atm.height (the
//   sensible atmosphere top, §1.4 atm.top), and against every craft's compound collider (stations: their colliders;
//   ships: the hull), including the target's own structure when a port is tracked (the last END_MARGIN metres at the
//   port are not tested: the mating point sits on the structure). A craft-origin target is omni (its own hull is
//   not tested).
// - Noise: Gaussian, from a counter hash of (seed, tick, channel), never Math.random: replays and save/load repeat it.
// - Measurement cycle: 10 Hz on the tick grid; under warp once per quantum (the quantum sequence does not depend on
//   the frame rate, so neither does the filter). Acquisition timers advance by the span since the last cycle.
//
// WIRING (wave 3; replaces session.assistRef's truth read and holdTarget's truth for 'target'/'antiTarget'/'dock'):
// - session tick, after consumeLedger: navPropagate(S.nav, t, Δv_I) (relnav.ts), Δv_I = q·(fAcc/m) + q·dvImpulse.
//   Then, when tick % SENSOR_TICKS === 0 (or once per warp quantum longer than that):
//     sensorsStep(S, IN) with IN = {world, ship, target: findCraft(world, S.targetId), tick, t: world.t,
//     radarOn, lidarOn} — radarOn/lidarOn from W2-D's breakers (power.ts) when they exist, else true.
// - session.setTarget(id) / dockingStatus port choice → sensorsTarget(S, id, portIndex) (portIndex: designatePort()).
// - Flight Assist: sensorAssistRef(S, t, V) → false = NO REF (FA fires nothing); true: V is the ship's velocity
//   relative to the tracked point (inertial), replacing c.v − ref.v. TGT hold: sensorLos(S, t, D, OM) replaces the
//   truth dx/ux; DOCK hold: sensorPortAxis(S, t, A) replaces dockingStatus().portAxis. Docking page / SensorView
//   (§1.4 views): sensorReadout(S, t, OUT).
// - Save: saveSensors(S) / loadSensors(raw) in the session save (≈ 0.7 kB, doubles packed exactly by pack64.ts); derived data (mounts, compounds) is
//   rebuilt. §1.4 contract: reads Craft rel/relV/q/w/colliders/ports/primary, Body r/radius/atmosphere; writes only
//   the SensorState (SensorView for the API layer). No limitedBy: the cycle is exact at any span.
// - Budget (measured in node, tests/sensors.test.ts): one full cycle with radar + lidar + pose at the Wheel
//   ≈ 3–5 µs; per-tick navPropagate ≈ 0.1 µs.

import type { Quat, V3 } from '../core/types';
import type { Craft, World } from './state';
import { craftCompound, type Compound } from './compound';
import { sensorMounts } from '../data/sensorMounts';
import { qRot, qRotInv } from './math';
import { packF64, unpackF64 } from './pack64';
import {
  makeNav, navInertialAt, navInit, navLosSigma, navMaybeReanchor, navReset, navUpdateBearing, navUpdateRange,
  navUpdateRangeRate, saveNav, loadNav, type NavState,
} from './relnav';

const msqrt = (x: number): number => Math.sqrt(x);
const mlog = (x: number): number => Math.log(x);
const mcos = (x: number): number => Math.cos(x);
const mexp = (x: number): number => Math.exp(x);

const DEG = Math.PI / 180;

/** Ticks between measurement cycles at 1× (120 Hz / 12 = 10 Hz). */
export const SENSOR_TICKS = 12;

export const RADAR_RMIN = 200;
export const RADAR_RMAX = 200e3;
export const RADAR_SIG_R_MIN = 0.5;
export const RADAR_SIG_R_REL = 1e-3;
export const RADAR_SIG_RD = 0.02;
export const RADAR_SIG_ANG = 0.1 * DEG;
export const RADAR_GIMBAL = 70 * DEG;
export const RADAR_ACQ = 3;
export const RADAR_FACING = 80 * DEG;

export const LIDAR_RMIN = 1;
export const LIDAR_RMAX = 2000;
export const LIDAR_SIG_R = 0.02;
export const LIDAR_SIG_B = 0.02 * DEG;
export const LIDAR_CONE = 30 * DEG;
export const LIDAR_ACQ = 1;
export const LIDAR_FACING = 60 * DEG;
export const POSE_RANGE = 200;
export const POSE_SIG = 0.2 * DEG;
export const POSE_TAU = 0.5;

/** The estimate may steer Flight Assist and the holds this long after the last accepted measurement, s. */
export const COAST_MAX = 2;
/** Prior 1σ of the velocity across the line of sight when a track starts, m/s. */
export const V_PRIOR = 50;
/** Consecutive gated-out updates after which the track is re-initialised from the measurement. */
export const REINIT_REJECTS = 6;
/** The last metres of the line of sight at a tracked port, not tested against the target's own structure. */
export const END_MARGIN = 3;

const COS_GIMBAL = mcos(RADAR_GIMBAL), COS_RFACE = mcos(RADAR_FACING);
const COS_LCONE = mcos(LIDAR_CONE), COS_LFACE = mcos(LIDAR_FACING);

/** Track quality, best available. */
export const TRACK_NONE = 0;
export const TRACK_RADAR = 1;
export const TRACK_LIDAR = 2;
export const TRACK_POSE = 3;

/** Visibility codes (why a sensor does not see the point), for tests and the docking page. */
export const VIS_OK = 0;
export const VIS_OFF = 1;
export const VIS_RANGE = 2;
export const VIS_FOV = 3;
export const VIS_FACING = 4;
export const VIS_BODY = 5;
export const VIS_CRAFT = 6;
export const VIS_NOTARGET = 7;

export interface SensorState {
  targetId: string | null;
  /** Index into the target's ports, −1 = its origin. */
  port: number;
  /** Continuous visibility so far (s), −1 = not visible at the last cycle. */
  radarAcq: number;
  lidarAcq: number;
  radarLock: boolean;
  lidarLock: boolean;
  /** Time of the last cycle, s (−1 = none yet). */
  tLast: number;
  nav: NavState;
  /** Smoothed port pose (inertial axis, up) and the time of its last measurement. */
  pose: Float64Array;
  poseValid: boolean;
  poseT: number;
  /** Last raw measurements (display): radar range, range rate, lidar range; NaN when none. */
  zRange: number;
  zRate: number;
  zLidar: number;
  /** Why each sensor did not see the point at the last cycle (VIS_*). */
  radarVis: number;
  lidarVis: number;
  seed: number;
}

export function makeSensors(seed = 0x5e45): SensorState {
  return {
    targetId: null, port: -1, radarAcq: -1, lidarAcq: -1, radarLock: false, lidarLock: false, tLast: -1,
    nav: makeNav(), pose: new Float64Array(6), poseValid: false, poseT: -1, zRange: NaN, zRate: NaN, zLidar: NaN,
    radarVis: VIS_NOTARGET, lidarVis: VIS_NOTARGET, seed: seed >>> 0,
  };
}

/** Designate a target (and port); a change drops the track. */
export function sensorsTarget(S: SensorState, id: string | null, port = -1): void {
  if (S.targetId === id && S.port === port) return;
  S.targetId = id; S.port = id === null ? -1 : port;
  S.radarAcq = S.lidarAcq = -1;
  S.radarLock = S.lidarLock = false;
  S.poseValid = false; S.poseT = -1;
  S.zRange = S.zRate = S.zLidar = NaN;
  navReset(S.nav);
}

/** The port of `station` a ship of size `pad` would be guided to from ship-relative position: nearest fitting, facing. */
export function designatePort(station: Craft, pad: string, fromX: number, fromY: number, fromZ: number): number {
  const ps = station.ports, q = station.q;
  let best = -1, bd = Infinity;
  const ord = pad === 'S' ? 0 : pad === 'M' ? 1 : 2;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i], o = p.size === 'S' ? 0 : p.size === 'M' ? 1 : 2;
    if (o < ord) continue;
    qRot(T0, q, p.pos.x, p.pos.y, p.pos.z);
    qRot(T1, q, p.dir.x, p.dir.y, p.dir.z);
    // (from − port)·dir > 0: the port faces the ship
    const dx = fromX - (station.r.x + T0.x), dy = fromY - (station.r.y + T0.y), dz = fromZ - (station.r.z + T0.z);
    const d2 = dx * dx + dy * dy + dz * dz, f = dx * T1.x + dy * T1.y + dz * T1.z;
    const score = f > 0 ? d2 : d2 * 16;
    if (score < bd) { bd = score; best = i; }
  }
  return best;
}

// ------------------------------------------------------------------------------------------------ noise

function mix32(h: number): number {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
/** Uniform in (0, 1) from (seed, tick, channel). */
export function noiseU(seed: number, tick: number, ch: number): number {
  const lo = tick % 4294967296, hi = (tick - lo) / 4294967296;
  let h = mix32((seed ^ Math.imul(ch + 1, 0x9e3779b1)) >>> 0);
  h = mix32((h ^ lo) >>> 0);
  h = mix32((h ^ Math.imul(hi + 1, 0x632be5ab)) >>> 0);
  return (h + 0.5) / 4294967296;
}
/** Standard normal from (seed, tick, channel); channel pairs (2k, 2k+1) are consumed per draw. */
export function noiseG(seed: number, tick: number, ch: number): number {
  const u1 = noiseU(seed, tick, 2 * ch), u2 = noiseU(seed, tick, 2 * ch + 1);
  return msqrt(-2 * mlog(u1)) * mcos(2 * Math.PI * u2);
}

// ------------------------------------------------------------------------------------------------ line of sight

let _sx = 0, _sy = 0, _sz = 0;

/** Squared distance between segments p1q1 and p2q2 (Ericson 5.1.9), scalars only. */
function segSegDist2(p1x: number, p1y: number, p1z: number, q1x: number, q1y: number, q1z: number,
  p2x: number, p2y: number, p2z: number, q2x: number, q2y: number, q2z: number): number {
  const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
  const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
  let s: number, t: number;
  if (a <= 1e-18 && e <= 1e-18) { s = t = 0; }
  else if (a <= 1e-18) { s = 0; t = f / e; t = t < 0 ? 0 : t > 1 ? 1 : t; }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-18) { t = 0; s = -c / a; s = s < 0 ? 0 : s > 1 ? 1 : s; }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z, den = a * e - b * b;
      s = den > 1e-18 * a * e ? (b * f - c * e) / den : 0;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = -c / a; s = s < 0 ? 0 : s > 1 ? 1 : s; }
      else if (t > 1) { t = 1; s = (b - c) / a; s = s < 0 ? 0 : s > 1 ? 1 : s; }
    }
  }
  const ex = p1x + d1x * s - (p2x + d2x * t), ey = p1y + d1y * s - (p2y + d2y * t), ez = p1z + d1z * s - (p2z + d2z * t);
  return ex * ex + ey * ey + ez * ez;
}

/** Does segment a→b pass within r of point c? */
function segSphere(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, r: number): boolean {
  const dx = bx - ax, dy = by - ay, dz = bz - az, l2 = dx * dx + dy * dy + dz * dz;
  let t = l2 > 0 ? ((cx - ax) * dx + (cy - ay) * dy + (cz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - cx, ey = ay + t * dy - cy, ez = az + t * dz - cz;
  return ex * ex + ey * ey + ez * ez < r * r;
}

const PS = 16; // floats per part in Compound.data (compound.ts)
const KIND_BOX = 2;

/** Does the craft-local segment a→b intersect the compound? Read-only use of compound.ts data. */
export function segmentHitsCompound(k: Compound, ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  if (!segSphere(ax, ay, az, bx, by, bz, k.cx, k.cy, k.cz, k.radius)) return false;
  const d = k.data, bs = k.bs;
  for (let i = 0; i < k.n; i++) {
    if (!segSphere(ax, ay, az, bx, by, bz, bs[4 * i], bs[4 * i + 1], bs[4 * i + 2], bs[4 * i + 3])) continue;
    const o = i * PS;
    if (k.kind[i] === KIND_BOX) {
      // Slab test in the box axes.
      const px = ax - d[o], py = ay - d[o + 1], pz = az - d[o + 2];
      const vx = bx - ax, vy = by - ay, vz = bz - az;
      let t0 = 0, t1 = 1, hit = true;
      for (let k3 = 0; k3 < 3 && hit; k3++) {
        const u = o + 6 + 3 * k3, h = d[o + 3 + k3];
        const p = px * d[u] + py * d[u + 1] + pz * d[u + 2], v = vx * d[u] + vy * d[u + 1] + vz * d[u + 2];
        if (v > -1e-12 && v < 1e-12) { if (p < -h || p > h) hit = false; continue; }
        let ta = (-h - p) / v, tb = (h - p) / v;
        if (ta > tb) { const s = ta; ta = tb; tb = s; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) hit = false;
      }
      if (hit) return true;
    } else {
      const r = d[o + 6];
      if (segSegDist2(ax, ay, az, bx, by, bz, d[o], d[o + 1], d[o + 2], d[o + 3], d[o + 4], d[o + 5]) < r * r) return true;
    }
  }
  return false;
}

const T0 = { x: 0, y: 0, z: 0 }, T1 = { x: 0, y: 0, z: 0 }, T2 = { x: 0, y: 0, z: 0 };

/**
 * Line of sight from ship-relative point a to ship-relative point b (inertial axes, m; the ship at the origin):
 * VIS_OK, VIS_BODY or VIS_CRAFT. `target` is the tracked craft: tested only when `portTracked`, with the last
 * END_MARGIN metres at b left out.
 */
export function lineOfSight(world: World, ship: Craft, target: Craft | null, portTracked: boolean,
  ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const bodies = world.bodies, pb = bodies[ship.primary];
  // Ship position relative to the primary is ship.rel; a body j is at (bj.r − pb.r) − ship.rel from the ship.
  for (let j = 0; j < bodies.length; j++) {
    const b = bodies[j];
    const cx = j === ship.primary ? -ship.rel.x : b.r.x - pb.r.x - ship.rel.x;
    const cy = j === ship.primary ? -ship.rel.y : b.r.y - pb.r.y - ship.rel.y;
    const cz = j === ship.primary ? -ship.rel.z : b.r.z - pb.r.z - ship.rel.z;
    const R = b.radius + (b.atmosphere ? b.atmosphere.height : 0);
    if (segSphere(ax, ay, az, bx, by, bz, cx, cy, cz, R)) return VIS_BODY;
  }
  const cs = world.craft;
  const lx = bx - ax, ly = by - ay, lz = bz - az, len = msqrt(lx * lx + ly * ly + lz * lz);
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (c === ship) continue;
    let ex = bx, ey = by, ez = bz;
    if (c === target) {
      if (!portTracked) continue;
      if (len <= END_MARGIN) continue;
      const k = (len - END_MARGIN) / len;
      ex = ax + lx * k; ey = ay + ly * k; ez = az + lz * k;
    }
    // Craft centre relative to the ship (same primary: the precise difference of rel).
    let ox: number, oy: number, oz: number;
    if (c.primary === ship.primary) { ox = c.rel.x - ship.rel.x; oy = c.rel.y - ship.rel.y; oz = c.rel.z - ship.rel.z; }
    else { ox = c.r.x - ship.r.x; oy = c.r.y - ship.r.y; oz = c.r.z - ship.r.z; }
    const k = craftCompound(c);
    const reach = msqrt(k.cx * k.cx + k.cy * k.cy + k.cz * k.cz) + k.radius;
    if (!segSphere(ax, ay, az, ex, ey, ez, ox, oy, oz, reach)) continue;
    qRotInv(T0, c.q, ax - ox, ay - oy, az - oz);
    qRotInv(T1, c.q, ex - ox, ey - oy, ez - oz);
    if (segmentHitsCompound(k, T0.x, T0.y, T0.z, T1.x, T1.y, T1.z)) return VIS_CRAFT;
  }
  return VIS_OK;
}

// ------------------------------------------------------------------------------------------------ geometry

/** Ship-relative position and velocity of the tracked point (truth: the sensor's physics), inertial. */
const GP = new Float64Array(6);
/** Port axis and up, inertial (truth), when a port is tracked. */
const GA = new Float64Array(6);
const WI = { x: 0, y: 0, z: 0 };

function trackedPoint(ship: Craft, tgt: Craft, port: number): boolean {
  const same = tgt.primary === ship.primary;
  GP[0] = same ? tgt.rel.x - ship.rel.x : tgt.r.x - ship.r.x;
  GP[1] = same ? tgt.rel.y - ship.rel.y : tgt.r.y - ship.r.y;
  GP[2] = same ? tgt.rel.z - ship.rel.z : tgt.r.z - ship.r.z;
  GP[3] = same ? tgt.relV.x - ship.relV.x : tgt.v.x - ship.v.x;
  GP[4] = same ? tgt.relV.y - ship.relV.y : tgt.v.y - ship.v.y;
  GP[5] = same ? tgt.relV.z - ship.relV.z : tgt.v.z - ship.v.z;
  if (port < 0 || port >= tgt.ports.length) return false;
  const p = tgt.ports[port];
  qRot(T0, tgt.q, p.pos.x, p.pos.y, p.pos.z);
  qRot(WI, tgt.q, tgt.w.x, tgt.w.y, tgt.w.z);
  GP[0] += T0.x; GP[1] += T0.y; GP[2] += T0.z;
  GP[3] += WI.y * T0.z - WI.z * T0.y; GP[4] += WI.z * T0.x - WI.x * T0.z; GP[5] += WI.x * T0.y - WI.y * T0.x;
  qRot(T1, tgt.q, p.dir.x, p.dir.y, p.dir.z);
  qRot(T2, tgt.q, p.up.x, p.up.y, p.up.z);
  GA[0] = T1.x; GA[1] = T1.y; GA[2] = T1.z; GA[3] = T2.x; GA[4] = T2.y; GA[5] = T2.z;
  return true;
}

/** A sensor mount in inertial axes relative to the ship origin (SA: pos, SAV: its velocity ω × a, SAX: axis). */
const SA = { x: 0, y: 0, z: 0 }, SAV = { x: 0, y: 0, z: 0 }, SAX = { x: 0, y: 0, z: 0 };
function mountInertial(ship: Craft, pos: V3, axis: V3): void {
  qRot(SA, ship.q, pos.x, pos.y, pos.z);
  qRot(SAX, ship.q, axis.x, axis.y, axis.z);
  qRot(WI, ship.q, ship.w.x, ship.w.y, ship.w.z);
  SAV.x = WI.y * SA.z - WI.z * SA.y; SAV.y = WI.z * SA.x - WI.x * SA.z; SAV.z = WI.x * SA.y - WI.y * SA.x;
}

/**
 * Can the sensor at SA (axis SAX) see the tracked point GP? Range window, cone about the axis, the port facing it
 * (cos ≥ cosFace when a port is tracked), line of sight. Returns VIS_*; the range is left in _range.
 */
let _range = 0;
function visible(world: World, ship: Craft, tgt: Craft, portTracked: boolean, rmin: number, rmax: number, cosCone: number, cosFace: number): number {
  const dx = GP[0] - SA.x, dy = GP[1] - SA.y, dz = GP[2] - SA.z, r = msqrt(dx * dx + dy * dy + dz * dz);
  _range = r;
  if (!(r >= rmin && r <= rmax)) return VIS_RANGE;
  if (dx * SAX.x + dy * SAX.y + dz * SAX.z < cosCone * r) return VIS_FOV;
  if (portTracked && -(dx * GA[0] + dy * GA[1] + dz * GA[2]) < cosFace * r) return VIS_FACING;
  return lineOfSight(world, ship, tgt, portTracked, SA.x, SA.y, SA.z, GP[0], GP[1], GP[2]);
}

// ------------------------------------------------------------------------------------------------ the cycle

export interface SensorIn {
  world: World;
  ship: Craft;
  /** The craft named by S.targetId, or null. */
  target: Craft | null;
  /** Integer tick index (keys the noise). */
  tick: number;
  /** Sim time of this cycle, s (= tick/120 on the grid; world.t). */
  t: number;
  radarOn: boolean;
  lidarOn: boolean;
}

const MU = { x: 0, y: 0, z: 0 };
const PINIT = new Float64Array(36);
const IINIT = new Float64Array(6);
const E1 = { x: 0, y: 0, z: 0 }, E2 = { x: 0, y: 0, z: 0 };

/** Two unit vectors ⟂ (ux, uy, uz) into E1, E2. */
function perp(ux: number, uy: number, uz: number): void {
  const ax = ux < 0 ? -ux : ux, ay = uy < 0 ? -uy : uy, az = uz < 0 ? -uz : uz;
  let ex = 0, ey = 0, ez = 0;
  if (ax <= ay && ax <= az) ex = 1; else if (ay <= az) ey = 1; else ez = 1;
  let px = uy * ez - uz * ey, py = uz * ex - ux * ez, pz = ux * ey - uy * ex;
  const l = msqrt(px * px + py * py + pz * pz);
  px /= l; py /= l; pz /= l;
  E1.x = px; E1.y = py; E1.z = pz;
  E2.x = uy * pz - uz * py; E2.y = uz * px - ux * pz; E2.z = ux * py - uy * px;
}

/** Measured unit line of sight into MU: true direction (ux, uy, uz) tipped by two Gaussian angles of σ. */
function noisyLos(ux: number, uy: number, uz: number, sigma: number, g1: number, g2: number): void {
  perp(ux, uy, uz);
  const a = sigma * g1, b = sigma * g2;
  let x = ux + a * E1.x + b * E2.x, y = uy + a * E1.y + b * E2.y, z = uz + a * E1.z + b * E2.z;
  const l = msqrt(x * x + y * y + z * z);
  x /= l; y /= l; z /= l;
  MU.x = x; MU.y = y; MU.z = z;
}

/** Start the track from one measurement: sensor at SA, range z along MU, range rate zr (NaN = none). */
function initTrack(S: SensorState, ship: Craft, mu: number, t: number, z: number, sigR: number, zr: number, sigRd: number, sigAng: number, lever: number): void {
  const ux = MU.x, uy = MU.y, uz = MU.z;
  IINIT[0] = SA.x + z * ux; IINIT[1] = SA.y + z * uy; IINIT[2] = SA.z + z * uz;
  const vr = zr === zr ? zr : 0;
  IINIT[3] = SAV.x + vr * ux; IINIT[4] = SAV.y + vr * uy; IINIT[5] = SAV.z + vr * uz;
  perp(ux, uy, uz);
  const sp = z * sigAng, svr = zr === zr ? sigRd : V_PRIOR;
  PINIT.fill(0);
  const a = sigR * sigR, b = sp * sp, c = svr * svr, d = V_PRIOR * V_PRIOR;
  for (let i = 0; i < 3; i++) {
    const ui = i === 0 ? ux : i === 1 ? uy : uz, e1i = i === 0 ? E1.x : i === 1 ? E1.y : E1.z, e2i = i === 0 ? E2.x : i === 1 ? E2.y : E2.z;
    for (let j = 0; j < 3; j++) {
      const uj = j === 0 ? ux : j === 1 ? uy : uz, e1j = j === 0 ? E1.x : j === 1 ? E1.y : E1.z, e2j = j === 0 ? E2.x : j === 1 ? E2.y : E2.z;
      const ee = e1i * e1j + e2i * e2j;
      PINIT[i * 6 + j] = a * ui * uj + b * ee;
      PINIT[(3 + i) * 6 + 3 + j] = c * ui * uj + d * ee;
    }
  }
  navInit(S.nav, t, IINIT, PINIT, ship.rel, ship.relV, mu, lever);
}

/**
 * One measurement cycle at IN.t. Runs acquisition, draws the measurements of every locked sensor and feeds the
 * filter. The caller has propagated S.nav to IN.t with the ship's Δv (navPropagate); if not, the span is coasted.
 * Returns the track quality (TRACK_*).
 */
export function sensorsStep(S: SensorState, IN: SensorIn): number {
  const { world, ship, target: tgt, tick, t } = IN;
  const dt = S.tLast >= 0 && t > S.tLast ? t - S.tLast : 0;
  S.tLast = t;
  S.zRange = S.zRate = S.zLidar = NaN;
  if (tgt === null || tgt === ship || tgt.id !== S.targetId || tgt.destroyed) {
    S.radarAcq = S.lidarAcq = -1; S.radarLock = S.lidarLock = false;
    S.radarVis = S.lidarVis = VIS_NOTARGET;
    return TRACK_NONE;
  }
  const portTracked = trackedPoint(ship, tgt, S.port);
  const lever = portTracked ? msqrt(tgt.ports[S.port].pos.x ** 2 + tgt.ports[S.port].pos.y ** 2 + tgt.ports[S.port].pos.z ** 2) : 0;
  const mu = world.bodies[ship.primary].mu;
  const M = sensorMounts(ship.shipVisual, ship.dockPort);
  const nav = S.nav, seed = S.seed;
  let track = TRACK_NONE;

  // ---- radar
  mountInertial(ship, M.radar.pos, M.radar.axis);
  let vis = IN.radarOn ? visible(world, ship, tgt, portTracked, RADAR_RMIN, RADAR_RMAX, COS_GIMBAL, COS_RFACE) : VIS_OFF;
  S.radarVis = vis;
  S.radarAcq = vis === VIS_OK ? (S.radarAcq >= 0 ? S.radarAcq + dt : 0) : -1;
  S.radarLock = S.radarAcq >= RADAR_ACQ - 1e-9;
  if (S.radarLock) {
    const r = _range, dx = GP[0] - SA.x, dy = GP[1] - SA.y, dz = GP[2] - SA.z, ux = dx / r, uy = dy / r, uz = dz / r;
    const rd = ux * (GP[3] - SAV.x) + uy * (GP[4] - SAV.y) + uz * (GP[5] - SAV.z);
    const sigR = Math.max(RADAR_SIG_R_MIN, RADAR_SIG_R_REL * r);
    const z = r + sigR * noiseG(seed, tick, 0), zr = rd + RADAR_SIG_RD * noiseG(seed, tick, 1);
    noisyLos(ux, uy, uz, RADAR_SIG_ANG, noiseG(seed, tick, 2), noiseG(seed, tick, 3));
    S.zRange = z; S.zRate = zr;
    if (!nav.valid || nav.rejRun >= REINIT_REJECTS) initTrack(S, ship, mu, t, z, sigR, zr, RADAR_SIG_RD, RADAR_SIG_ANG, lever);
    else {
      navUpdateRange(nav, t, SA.x, SA.y, SA.z, z, sigR);
      navUpdateRangeRate(nav, t, SA.x, SA.y, SA.z, SAV.x, SAV.y, SAV.z, zr, RADAR_SIG_RD);
      navUpdateBearing(nav, t, SA.x, SA.y, SA.z, MU.x, MU.y, MU.z, RADAR_SIG_ANG);
    }
    track = TRACK_RADAR;
  }

  // ---- lidar (and pose)
  mountInertial(ship, M.lidar.pos, M.lidar.axis);
  vis = IN.lidarOn ? visible(world, ship, tgt, portTracked, LIDAR_RMIN, LIDAR_RMAX, COS_LCONE, COS_LFACE) : VIS_OFF;
  S.lidarVis = vis;
  S.lidarAcq = vis === VIS_OK ? (S.lidarAcq >= 0 ? S.lidarAcq + dt : 0) : -1;
  S.lidarLock = S.lidarAcq >= LIDAR_ACQ - 1e-9;
  if (S.lidarLock) {
    const r = _range, dx = GP[0] - SA.x, dy = GP[1] - SA.y, dz = GP[2] - SA.z, ux = dx / r, uy = dy / r, uz = dz / r;
    const z = r + LIDAR_SIG_R * noiseG(seed, tick, 4);
    noisyLos(ux, uy, uz, LIDAR_SIG_B, noiseG(seed, tick, 5), noiseG(seed, tick, 6));
    S.zLidar = z;
    if (!nav.valid || nav.rejRun >= REINIT_REJECTS) initTrack(S, ship, mu, t, z, LIDAR_SIG_R, NaN, 0, LIDAR_SIG_B, lever);
    else {
      navUpdateRange(nav, t, SA.x, SA.y, SA.z, z, LIDAR_SIG_R);
      navUpdateBearing(nav, t, SA.x, SA.y, SA.z, MU.x, MU.y, MU.z, LIDAR_SIG_B);
    }
    track = TRACK_LIDAR;
    if (portTracked && r <= POSE_RANGE) {
      poseMeasure(S, tick, t);
      track = TRACK_POSE;
    }
  }
  if (nav.valid) navMaybeReanchor(nav, ship.rel, ship.relV, mu);
  return track;
}

/** The lidar's pose of the port: truth GA tipped by a Gaussian rotation of σ = POSE_SIG per axis, then smoothed. */
function poseMeasure(S: SensorState, tick: number, t: number): void {
  const gx = POSE_SIG * noiseG(S.seed, tick, 7), gy = POSE_SIG * noiseG(S.seed, tick, 8), gz = POSE_SIG * noiseG(S.seed, tick, 9);
  // Small rotation v ↦ v + g × v (first order; σ = 3.5 mrad), renormalised below.
  const p = S.pose;
  const ax = GA[0] + (gy * GA[2] - gz * GA[1]), ay = GA[1] + (gz * GA[0] - gx * GA[2]), az = GA[2] + (gx * GA[1] - gy * GA[0]);
  const bx = GA[3] + (gy * GA[5] - gz * GA[4]), by = GA[4] + (gz * GA[3] - gx * GA[5]), bz = GA[5] + (gx * GA[4] - gy * GA[3]);
  const dt = t - S.poseT;
  if (!S.poseValid || !(dt > 0) || dt > 1) {
    p[0] = ax; p[1] = ay; p[2] = az; p[3] = bx; p[4] = by; p[5] = bz;
  } else {
    const k = 1 - mexp(-dt / POSE_TAU);
    p[0] += k * (ax - p[0]); p[1] += k * (ay - p[1]); p[2] += k * (az - p[2]);
    p[3] += k * (bx - p[3]); p[4] += k * (by - p[4]); p[5] += k * (bz - p[5]);
  }
  let l = msqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
  p[0] /= l; p[1] /= l; p[2] /= l;
  const d = p[3] * p[0] + p[4] * p[1] + p[5] * p[2];
  p[3] -= d * p[0]; p[4] -= d * p[1]; p[5] -= d * p[2];
  l = msqrt(p[3] * p[3] + p[4] * p[4] + p[5] * p[5]);
  p[3] /= l; p[4] /= l; p[5] /= l;
  S.poseValid = true;
  S.poseT = t;
}

// ------------------------------------------------------------------------------------------------ read-outs (pure)

const X6 = new Float64Array(6);

/** Is the estimate fit to steer by (a track, or coasting ≤ COAST_MAX since the last accepted measurement)? */
export function sensorUsable(S: SensorState, t: number): boolean {
  return S.nav.valid && t - S.nav.tMeas <= COAST_MAX;
}

/** Flight Assist's reference: the ship's velocity relative to the tracked point (inertial) into V. False = NO REF. */
export function sensorAssistRef(S: SensorState, t: number, V: V3): boolean {
  if (!sensorUsable(S, t)) return false;
  navInertialAt(S.nav, t, X6);
  V.x = -X6[3]; V.y = -X6[4]; V.z = -X6[5];
  return true;
}

/** TGT hold: direction to the tracked point D (inertial, not normalised) and the line-of-sight rate OM (rad/s). */
export function sensorLos(S: SensorState, t: number, D: V3, OM: V3): boolean {
  if (!sensorUsable(S, t)) return false;
  navInertialAt(S.nav, t, X6);
  const dx = X6[0], dy = X6[1], dz = X6[2], ux = X6[3], uy = X6[4], uz = X6[5], d2 = dx * dx + dy * dy + dz * dz;
  D.x = dx; D.y = dy; D.z = dz;
  if (d2 > 0) { OM.x = (dy * uz - dz * uy) / d2; OM.y = (dz * ux - dx * uz) / d2; OM.z = (dx * uy - dy * ux) / d2; }
  else { OM.x = OM.y = OM.z = 0; }
  return true;
}

/** DOCK hold: the port axis (inertial unit vector) from the lidar pose, if measured within COAST_MAX. */
export function sensorPortAxis(S: SensorState, t: number, A: V3, up?: V3): boolean {
  if (!S.poseValid || t - S.poseT > COAST_MAX) return false;
  const p = S.pose;
  A.x = p[0]; A.y = p[1]; A.z = p[2];
  if (up) { up.x = p[3]; up.y = p[4]; up.z = p[5]; }
  return true;
}

export interface SensorReadout {
  track: number;
  /** False: "NO TRACK" (no sensor locked). */
  tracking: boolean;
  /** False: Flight Assist shows NO REF. */
  usable: boolean;
  /** Estimated range (m) and range rate (m/s, > 0 opening) from the ship origin, and their 1σ. NaN without estimate. */
  range: number;
  rangeRate: number;
  sigRange: number;
  sigRate: number;
  /** Estimated ship-relative position and velocity of the tracked point, inertial. */
  rel: V3;
  relV: V3;
  /** Acquisition progress 0..1. */
  radarAcq: number;
  lidarAcq: number;
  radarVis: number;
  lidarVis: number;
  /** Seconds since the last accepted measurement (∞ never). */
  coast: number;
}

export function makeSensorReadout(): SensorReadout {
  return {
    track: 0, tracking: false, usable: false, range: NaN, rangeRate: NaN, sigRange: Infinity, sigRate: Infinity,
    rel: { x: 0, y: 0, z: 0 }, relV: { x: 0, y: 0, z: 0 }, radarAcq: 0, lidarAcq: 0, radarVis: VIS_NOTARGET, lidarVis: VIS_NOTARGET, coast: Infinity,
  };
}

const SG = new Float64Array(2);
/** Everything the docking page and SensorView show, at time t. Pure. */
export function sensorReadout(S: SensorState, t: number, o: SensorReadout): SensorReadout {
  o.track = S.lidarLock ? (S.poseValid && t - S.poseT <= COAST_MAX && S.poseT === S.tLast ? TRACK_POSE : TRACK_LIDAR) : S.radarLock ? TRACK_RADAR : TRACK_NONE;
  o.tracking = S.radarLock || S.lidarLock;
  o.usable = sensorUsable(S, t);
  o.radarAcq = S.radarAcq < 0 ? 0 : Math.min(1, S.radarAcq / RADAR_ACQ);
  o.lidarAcq = S.lidarAcq < 0 ? 0 : Math.min(1, S.lidarAcq / LIDAR_ACQ);
  o.radarVis = S.radarVis; o.lidarVis = S.lidarVis;
  o.coast = S.nav.valid ? t - S.nav.tMeas : Infinity;
  if (!S.nav.valid) {
    o.range = o.rangeRate = NaN; o.sigRange = o.sigRate = Infinity;
    o.rel.x = o.rel.y = o.rel.z = o.relV.x = o.relV.y = o.relV.z = 0;
    return o;
  }
  navInertialAt(S.nav, t, X6);
  const r = msqrt(X6[0] * X6[0] + X6[1] * X6[1] + X6[2] * X6[2]);
  o.rel.x = X6[0]; o.rel.y = X6[1]; o.rel.z = X6[2];
  o.relV.x = X6[3]; o.relV.y = X6[4]; o.relV.z = X6[5];
  o.range = r;
  o.rangeRate = r > 0 ? (X6[0] * X6[3] + X6[1] * X6[4] + X6[2] * X6[5]) / r : 0;
  navLosSigma(S.nav, t, SG);
  o.sigRange = SG[0]; o.sigRate = SG[1];
  return o;
}

// ------------------------------------------------------------------------------------------------ save / load

export interface SensorsSave {
  id: string | null;
  port: number;
  /** packF64 of [radarAcq, lidarAcq, radarLock, lidarLock, tLast, poseValid, poseT, pose(6), seed, radarVis, lidarVis, nav(44)]. */
  d: string;
}
const NS = 16;

export function saveSensors(S: SensorState): SensorsSave {
  const p = S.pose;
  const a = [S.radarAcq, S.lidarAcq, S.radarLock ? 1 : 0, S.lidarLock ? 1 : 0, S.tLast, S.poseValid ? 1 : 0, S.poseT, p[0], p[1], p[2], p[3], p[4], p[5], S.seed, S.radarVis, S.lidarVis];
  const nav = saveNav(S.nav);
  for (let i = 0; i < nav.length; i++) a.push(nav[i]);
  return { id: S.targetId, port: S.port, d: packF64(a) };
}

/** Inverse of saveSensors; anything missing loads as "no target" (the track re-acquires). */
export function loadSensors(raw: unknown, out: SensorState = makeSensors()): SensorState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<SensorsSave>;
  sensorsTarget(out, null, -1);
  const id = typeof r.id === 'string' ? r.id : null;
  out.targetId = id;
  out.port = id !== null && typeof r.port === 'number' ? r.port | 0 : -1;
  const a = unpackF64(r.d);
  const s = a && a.length >= NS ? a : null;
  const num = (i: number, d: number): number => (s && Number.isFinite(s[i]) ? s[i] : d);
  out.radarAcq = num(0, -1); out.lidarAcq = num(1, -1);
  out.radarLock = num(2, 0) === 1; out.lidarLock = num(3, 0) === 1;
  out.tLast = num(4, -1); out.poseValid = num(5, 0) === 1; out.poseT = num(6, -1);
  for (let i = 0; i < 6; i++) out.pose[i] = num(7 + i, 0);
  out.seed = num(13, out.seed) >>> 0;
  out.radarVis = num(14, VIS_NOTARGET); out.lidarVis = num(15, VIS_NOTARGET);
  loadNav(s ? s.slice(NS) : null, out.nav);
  return out;
}

/** Ship-local unit vector of the line of sight to the tracked point estimate (for a gimbal display). */
export function sensorLosBody(S: SensorState, ship: { q: Quat }, t: number, out: V3): boolean {
  if (!S.nav.valid) return false;
  navInertialAt(S.nav, t, X6);
  const r = msqrt(X6[0] * X6[0] + X6[1] * X6[1] + X6[2] * X6[2]) || 1;
  qRotInv(out, ship.q, X6[0] / r, X6[1] / r, X6[2] / r);
  return true;
}
