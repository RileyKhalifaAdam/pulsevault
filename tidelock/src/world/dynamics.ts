// Craft dynamics: forces and torques, translational and rotational integration.
//
// Translation is integrated in coordinates relative to the craft's primary body. The primary is a choice of
// coordinates only: the acceleration is  −μp·ρ/|ρ|³ + Σj μj·[(dj − ρ)/|dj − ρ|³ − dj/|dj|³]  (+ thrust, drag),
// with dj the position of body j relative to the primary read from the ephemeris — every body pulls at all
// times, and changing primary changes no force. Steps are adaptive (a fraction of the local dynamical time,
// finer under thrust, in air and near the ground); coasting uses 4th-order symplectic Yoshida steps, thrust
// and drag phases classical RK4 on (position, velocity, mass, heat). Rotation: Euler's equations with a
// diagonal inertia tensor, RK4 on (ω, q), sub-stepped by angular rate. Nothing here allocates.

import type { Body, Craft, World } from './state';
import { destroyCraft, pushEvent } from './state';
import type { Ephemeris } from './ephemeris';
import { YC1, YC2, YD1, YD2 } from './ephemeris';
import { airDensity, HEAT_FLUX_COEFF } from './atmosphere';
import { clamp1, qRot, qRotInv } from './math';
import { compoundSupport, craftCompound } from './compound';

/** Step as a fraction of the dynamical time √(r³/μ) of the primary (≈209 steps per circular orbit). */
export const ETA = 0.03;
/** Largest step while a thruster fires or torque is commanded, s. */
export const DT_POWERED = 1 / 60;
/** Smallest step in air and just above ground, s. */
export const DT_ATMOSPHERE_MIN = 1 / 120;
export const DT_SURFACE_MIN = 1 / 60;
/** Rotation sub-step: at most this many radians per step. */
export const ROT_ANGLE = 0.05;
/**
 * A craft without a collision shape touches the ground when its centre is this fraction of its radius above the
 * surface; every other craft touches it with its hull (the support of its compound toward the primary's centre).
 */
export const CONTACT_HEIGHT = 0.35;

/** Why a step was as short as it was (index into the tally array handed to integrateCraft). */
export const WHY_FREE = 0;
export const WHY_THRUST = 1;
export const WHY_ROTATION = 2;
export const WHY_ATMOSPHERE = 3;
export const WHY_PROXIMITY = 4;
export const WHY_CONTACT = 5;

export const STOP_NONE = 0;
export const STOP_SURFACE = 1;

/** Translational state of one craft (or of a prediction ghost) in primary-relative coordinates. */
export class Particle {
  /** Primary body index. */
  p = 0;
  x = 0; y = 0; z = 0;
  vx = 0; vy = 0; vz = 0;
  m = 1;
  prop = 0;
  heat = 0;
  /** Thrust force (N, inertial axes) and propellant flow (kg/s) held over the current step. */
  fx = 0; fy = 0; fz = 0;
  mdot = 0;
  cdA = 0;
  heatArea = 0;
  heatCap = 1;
  heatDiss = 0;
  /** Height of the craft centre above the ground when its hull touches (the hull's reach toward the primary), m. */
  contactH = 0;
  /** Largest reach of the hull in any direction (its compound's bounding sphere about the craft centre), m. */
  reachMax = 0;
  /** Set by chooseDt: inside the primary's atmosphere. */
  inAtm = false;
  /** Set by a forced step: peak drag deceleration and proper acceleration, m/s². */
  drag = 0;
  load = 0;
}

let D = new Float64Array(96);
const S6 = new Float64Array(12);
let _ax = 0, _ay = 0, _az = 0, _hd = 0, _drag = 0, _load = 0, _why = 0, _stop = 0, _steps = 0;

/** Result flags of the last integrateCraft call. */
export const lastStop = (): number => _stop;
/** Why the last chooseDt picked its step. */
export const lastWhy = (): number => _why;

/** Gravitational acceleration at primary-relative (x, y, z) and time t, into _ax.._az. */
function gravity(eph: Ephemeris, t: number, p: number, x: number, y: number, z: number): void {
  if (D.length < eph.n3) D = new Float64Array(eph.n3);
  eph.relPositions(t, p, D);
  const mu = eph.mu, n3 = eph.n3, p3 = 3 * p;
  const r2 = x * x + y * y + z * z;
  const k = -mu[p] / (r2 * Math.sqrt(r2));
  let ax = k * x, ay = k * y, az = k * z;
  for (let o = 0, j = 0; o < n3; o += 3, j++) {
    if (o === p3) continue;
    const dx = D[o], dy = D[o + 1], dz = D[o + 2];
    const ex = dx - x, ey = dy - y, ez = dz - z;
    const d2 = dx * dx + dy * dy + dz * dz, e2 = ex * ex + ey * ey + ez * ez;
    const m = mu[j];
    const di = m / (d2 * Math.sqrt(d2)), ei = m / (e2 * Math.sqrt(e2));
    ax += ex * ei - dx * di;
    ay += ey * ei - dy * di;
    az += ez * ei - dz * di;
  }
  _ax = ax; _ay = ay; _az = az;
}

/** Total acceleration (gravity + held thrust + drag) and heat rate at a state. */
function force(P: Particle, b: Body, eph: Ephemeris, t: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, m: number, heat: number): void {
  gravity(eph, t, P.p, x, y, z);
  const im = 1 / m;
  let nx = P.fx * im, ny = P.fy * im, nz = P.fz * im;
  let hd = (-P.heatDiss * heat) / P.heatCap;
  let drag = 0;
  const atm = b.atmosphere;
  if (atm !== null) {
    const alt = Math.sqrt(x * x + y * y + z * z) - b.radius;
    if (alt < atm.height) {
      const rho = airDensity(atm, alt);
      const w = b.spinRate, sa = b.spinAxis;
      const wx = w * sa.x, wy = w * sa.y, wz = w * sa.z;
      // Air-relative velocity: the atmosphere turns with the body.
      const ux = vx - (wy * z - wz * y), uy = vy - (wz * x - wx * z), uz = vz - (wx * y - wy * x);
      const sp = Math.sqrt(ux * ux + uy * uy + uz * uz);
      const k = 0.5 * rho * sp * P.cdA * im;
      nx -= k * ux; ny -= k * uy; nz -= k * uz;
      drag = k * sp;
      hd += HEAT_FLUX_COEFF * Math.sqrt(rho) * sp * sp * sp * P.heatArea;
    }
  }
  _ax += nx; _ay += ny; _az += nz;
  _hd = hd; _drag = drag; _load = Math.sqrt(nx * nx + ny * ny + nz * nz);
}

/** One RK4 step under thrust and/or drag. The caller debits propellant. */
export function stepForced(P: Particle, b: Body, eph: Ephemeris, t: number, dt: number): void {
  const x0 = P.x, y0 = P.y, z0 = P.z, vx0 = P.vx, vy0 = P.vy, vz0 = P.vz, m0 = P.m, q0 = P.heat;
  const md = P.mdot, h2 = dt / 2, h6 = dt / 6;
  force(P, b, eph, t, x0, y0, z0, vx0, vy0, vz0, m0, q0);
  const a1x = _ax, a1y = _ay, a1z = _az, g1 = _hd;
  let drag = _drag;
  P.load = _load;
  const v2x = vx0 + h2 * a1x, v2y = vy0 + h2 * a1y, v2z = vz0 + h2 * a1z;
  force(P, b, eph, t + h2, x0 + h2 * vx0, y0 + h2 * vy0, z0 + h2 * vz0, v2x, v2y, v2z, m0 - md * h2, q0 + h2 * g1);
  const a2x = _ax, a2y = _ay, a2z = _az, g2 = _hd;
  if (_drag > drag) drag = _drag;
  const v3x = vx0 + h2 * a2x, v3y = vy0 + h2 * a2y, v3z = vz0 + h2 * a2z;
  force(P, b, eph, t + h2, x0 + h2 * v2x, y0 + h2 * v2y, z0 + h2 * v2z, v3x, v3y, v3z, m0 - md * h2, q0 + h2 * g2);
  const a3x = _ax, a3y = _ay, a3z = _az, g3 = _hd;
  if (_drag > drag) drag = _drag;
  const v4x = vx0 + dt * a3x, v4y = vy0 + dt * a3y, v4z = vz0 + dt * a3z;
  force(P, b, eph, t + dt, x0 + dt * v3x, y0 + dt * v3y, z0 + dt * v3z, v4x, v4y, v4z, m0 - md * dt, q0 + dt * g3);
  if (_drag > drag) drag = _drag;
  P.x = x0 + h6 * (vx0 + 2 * v2x + 2 * v3x + v4x);
  P.y = y0 + h6 * (vy0 + 2 * v2y + 2 * v3y + v4y);
  P.z = z0 + h6 * (vz0 + 2 * v2z + 2 * v3z + v4z);
  P.vx = vx0 + h6 * (a1x + 2 * a2x + 2 * a3x + _ax);
  P.vy = vy0 + h6 * (a1y + 2 * a2y + 2 * a3y + _ay);
  P.vz = vz0 + h6 * (a1z + 2 * a2z + 2 * a3z + _az);
  const q = q0 + h6 * (g1 + 2 * g2 + 2 * g3 + _hd);
  P.heat = q > 0 ? q : 0;
  P.m = m0 - md * dt;
  P.drag = drag;
}

/** One 4th-order symplectic (Yoshida) step under gravity alone. */
export function stepCoast(P: Particle, eph: Ephemeris, t: number, dt: number): void {
  const p = P.p;
  let x = P.x, y = P.y, z = P.z, vx = P.vx, vy = P.vy, vz = P.vz;
  let k = YC1 * dt, tt = t + k;
  x += k * vx; y += k * vy; z += k * vz;
  gravity(eph, tt, p, x, y, z);
  k = YD1 * dt;
  vx += k * _ax; vy += k * _ay; vz += k * _az;
  k = YC2 * dt; tt += k;
  x += k * vx; y += k * vy; z += k * vz;
  gravity(eph, tt, p, x, y, z);
  k = YD2 * dt;
  vx += k * _ax; vy += k * _ay; vz += k * _az;
  k = YC2 * dt; tt += k;
  x += k * vx; y += k * vy; z += k * vz;
  gravity(eph, tt, p, x, y, z);
  k = YD1 * dt;
  vx += k * _ax; vy += k * _ay; vz += k * _az;
  k = YC1 * dt;
  P.x = x + k * vx; P.y = y + k * vy; P.z = z + k * vz;
  P.vx = vx; P.vy = vy; P.vz = vz;
  if (P.heat > 0) {
    const q = P.heat * Math.exp((-dt * P.heatDiss) / P.heatCap);
    P.heat = q > 1 ? q : 0;
  }
  P.drag = 0;
  P.load = 0;
}

/**
 * Step size for a particle at its current state: a fraction of the dynamical time; ≤ 1/60 s while powered or
 * torqued; in air limited by the scale height crossed and the speed lost per step; near ground or the top of
 * an atmosphere by half the earliest possible time of arrival. Sets P.inAtm and lastWhy().
 */
export function chooseDt(P: Particle, b: Body, powered: boolean, torquing: boolean): number {
  const x = P.x, y = P.y, z = P.z;
  const r2 = x * x + y * y + z * z, r = Math.sqrt(r2);
  let dt = ETA * Math.sqrt((r2 * r) / b.mu);
  let why = WHY_FREE;
  if (powered) {
    if (dt > DT_POWERED) { dt = DT_POWERED; why = WHY_THRUST; }
  } else if (torquing) {
    if (dt > DT_POWERED) { dt = DT_POWERED; why = WHY_ROTATION; }
  }
  const alt = r - b.radius;
  const vr = (x * P.vx + y * P.vy + z * P.vz) / r;
  const atm = b.atmosphere;
  let clear = alt - P.contactH;
  let floor = DT_SURFACE_MIN;
  let inAtm = false;
  if (atm !== null) {
    if (alt < atm.height) {
      inAtm = true;
      const rho = airDensity(atm, alt);
      const w = b.spinRate, sa = b.spinAxis;
      const wx = w * sa.x, wy = w * sa.y, wz = w * sa.z;
      const ux = P.vx - (wy * z - wz * y), uy = P.vy - (wz * x - wx * z), uz = P.vz - (wx * y - wy * x);
      const sp = Math.sqrt(ux * ux + uy * uy + uz * uz);
      const a = (0.5 * rho * sp * sp * P.cdA) / P.m;
      let da = (0.05 * atm.scaleHeight) / ((vr < 0 ? -vr : vr) + 1);
      const db = (0.02 * sp) / (a + 1e-12);
      if (db < da) da = db;
      if (da > 1) da = 1;
      if (da < DT_ATMOSPHERE_MIN) da = DT_ATMOSPHERE_MIN;
      if (da < dt) { dt = da; why = WHY_ATMOSPHERE; }
    } else {
      clear = alt - atm.height;
      floor = 0.25;
    }
  }
  if (clear > 0) {
    const g = b.mu / r2;
    let dp = (0.5 * clear) / ((vr < 0 ? -vr : 0) + Math.sqrt(2 * g * clear));
    if (dp < floor) dp = floor;
    if (dp < dt) { dt = dp; why = WHY_PROXIMITY; }
  } else if (floor < dt) {
    dt = floor; why = WHY_PROXIMITY;
  }
  P.inAtm = inAtm;
  _why = why;
  return dt;
}

/**
 * Re-choose the primary: the deepest body whose Hill sphere holds the particle, with hysteresis (enter below
 * 0.9, leave above 1.1 Hill radii). A switch re-expresses position and velocity; it changes no force.
 */
export function updatePrimary(world: World, eph: Ephemeris, c: Craft | null, P: Particle, t: number): void {
  const bodies = world.bodies, n = bodies.length, p = P.p;
  if (D.length < eph.n3) D = new Float64Array(eph.n3);
  eph.relPositions(t, p, D);
  let cur = p;
  for (;;) {
    const b = bodies[cur];
    if (b.parent < 0) break;
    const dx = P.x - D[3 * cur], dy = P.y - D[3 * cur + 1], dz = P.z - D[3 * cur + 2];
    const lim = 1.1 * b.hill;
    if (dx * dx + dy * dy + dz * dz > lim * lim) cur = b.parent;
    else break;
  }
  for (let again = true; again; ) {
    again = false;
    for (let j = 0; j < n; j++) {
      const b = bodies[j];
      if (b.parent !== cur || j === p) continue;
      const dx = P.x - D[3 * j], dy = P.y - D[3 * j + 1], dz = P.z - D[3 * j + 2];
      const lim = 0.9 * b.hill;
      if (dx * dx + dy * dy + dz * dz < lim * lim) { cur = j; again = true; break; }
    }
  }
  if (cur === p) return;
  eph.state(t, p, S6, 0);
  eph.state(t, cur, S6, 6);
  P.x += S6[0] - S6[6]; P.y += S6[1] - S6[7]; P.z += S6[2] - S6[8];
  P.vx += S6[3] - S6[9]; P.vy += S6[4] - S6[10]; P.vz += S6[5] - S6[11];
  P.p = cur;
  if (c !== null) {
    c.primary = cur;
    c.inAtmosphere = false;
    pushEvent(world, { type: 'primaryChanged', t, craftId: c.id, from: bodies[p].id, to: bodies[cur].id });
  }
}

// ------------------------------------------------------------------------------------------------ rotation

let _kx = 0, _ky = 0, _kz = 0, _tx = 0, _ty = 0, _tz = 0;
let _d0 = 0, _d1 = 0, _d2 = 0, _d3 = 0, _d4 = 0, _d5 = 0, _d6 = 0;

/** Euler's equations and the quaternion kinematics: derivative of (ω, q). */
function rotDeriv(wx: number, wy: number, wz: number, qx: number, qy: number, qz: number, qw: number): void {
  _d0 = _tx - _kx * wy * wz;
  _d1 = _ty - _ky * wz * wx;
  _d2 = _tz - _kz * wx * wy;
  _d3 = 0.5 * (qw * wx + qy * wz - qz * wy);
  _d4 = 0.5 * (qw * wy + qz * wx - qx * wz);
  _d5 = 0.5 * (qw * wz + qx * wy - qy * wx);
  _d6 = -0.5 * (qx * wx + qy * wy + qz * wz);
}

/**
 * Rotate a craft through `dt`: I·ω̇ = τ − ω × Iω with the commanded torque (limited to maxTorque) when
 * `torquing`, RK4 on (ω, q), sub-stepped so that no step turns more than ROT_ANGLE. Returns the sub-steps taken.
 */
export function rotateCraft(c: Craft, mass: number, dt: number, torquing: boolean): number {
  const g = c.gyration;
  const Ix = mass * g.x, Iy = mass * g.y, Iz = mass * g.z;
  _kx = (Iz - Iy) / Ix; _ky = (Ix - Iz) / Iy; _kz = (Iy - Ix) / Iz;
  if (torquing) {
    _tx = (clamp1(c.torque.x) * c.maxTorque.x) / Ix;
    _ty = (clamp1(c.torque.y) * c.maxTorque.y) / Iy;
    _tz = (clamp1(c.torque.z) * c.maxTorque.z) / Iz;
  } else {
    _tx = _ty = _tz = 0;
  }
  const w = c.w, q = c.q;
  let wx = w.x, wy = w.y, wz = w.z, qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const rate = Math.sqrt(wx * wx + wy * wy + wz * wz) + dt * Math.sqrt(_tx * _tx + _ty * _ty + _tz * _tz);
  const ns = Math.max(1, Math.ceil((rate * dt) / ROT_ANGLE));
  const h = dt / ns, h2 = h / 2, h6 = h / 6;
  for (let i = 0; i < ns; i++) {
    rotDeriv(wx, wy, wz, qx, qy, qz, qw);
    const a0 = _d0, a1 = _d1, a2 = _d2, a3 = _d3, a4 = _d4, a5 = _d5, a6 = _d6;
    rotDeriv(wx + h2 * a0, wy + h2 * a1, wz + h2 * a2, qx + h2 * a3, qy + h2 * a4, qz + h2 * a5, qw + h2 * a6);
    const b0 = _d0, b1 = _d1, b2 = _d2, b3 = _d3, b4 = _d4, b5 = _d5, b6 = _d6;
    rotDeriv(wx + h2 * b0, wy + h2 * b1, wz + h2 * b2, qx + h2 * b3, qy + h2 * b4, qz + h2 * b5, qw + h2 * b6);
    const c0 = _d0, c1 = _d1, c2 = _d2, c3 = _d3, c4 = _d4, c5 = _d5, c6 = _d6;
    rotDeriv(wx + h * c0, wy + h * c1, wz + h * c2, qx + h * c3, qy + h * c4, qz + h * c5, qw + h * c6);
    wx += h6 * (a0 + 2 * b0 + 2 * c0 + _d0);
    wy += h6 * (a1 + 2 * b1 + 2 * c1 + _d1);
    wz += h6 * (a2 + 2 * b2 + 2 * c2 + _d2);
    qx += h6 * (a3 + 2 * b3 + 2 * c3 + _d3);
    qy += h6 * (a4 + 2 * b4 + 2 * c4 + _d4);
    qz += h6 * (a5 + 2 * b5 + 2 * c5 + _d5);
    qw += h6 * (a6 + 2 * b6 + 2 * c6 + _d6);
    const s = 1 / Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
    qx *= s; qy *= s; qz *= s; qw *= s;
  }
  w.x = wx; w.y = wy; w.z = wz;
  q.x = qx; q.y = qy; q.z = qz; q.w = qw;
  return ns;
}

// ------------------------------------------------------------------------------------------------ craft

const P0 = new Particle();
const F0 = { x: 0, y: 0, z: 0 };
const F1 = { x: 0, y: 0, z: 0 };

/** Copy a craft's translational state and constants into a particle. */
export function loadParticle(P: Particle, c: Craft, world?: World): void {
  P.p = c.primary;
  P.x = c.rel.x; P.y = c.rel.y; P.z = c.rel.z;
  P.vx = c.relV.x; P.vy = c.relV.y; P.vz = c.relV.z;
  P.prop = c.propellant;
  P.m = c.dryMass + c.propellant;
  P.heat = c.heat;
  P.cdA = c.dragArea;
  P.heatArea = c.heatArea;
  P.heatCap = c.heatCapacity;
  P.heatDiss = c.heatDissipation;
  const k = craftCompound(c);
  P.reachMax = Math.sqrt(k.cx * k.cx + k.cy * k.cy + k.cz * k.cz) + k.radius;
  // The hull's reach toward the ground; in the stepping loop (world given), far from the ground the bound is enough
  // (it only sizes the approach steps) and the exact reach is taken once within it.
  const r = Math.sqrt(P.x * P.x + P.y * P.y + P.z * P.z), b = world ? world.bodies[c.primary] : null;
  P.contactH = !world || (b && r < b.radius + 2 * P.reachMax) ? hullReach(c, P.x, P.y, P.z) : P.reachMax;
  P.fx = P.fy = P.fz = 0;
  P.mdot = 0;
  P.drag = 0;
  P.load = c.load;
}

const RD = { x: 0, y: 0, z: 0 };
/** How far the craft's hull reaches from its centre toward the primary's centre (the craft at primary-relative x, y, z), m. */
function hullReach(c: Craft, x: number, y: number, z: number): number {
  const l = Math.sqrt(x * x + y * y + z * z) || 1;
  qRotInv(RD, c.q, -x / l, -y / l, -z / l);
  return compoundSupport(craftCompound(c), RD.x, RD.y, RD.z);
}

function storeParticle(P: Particle, c: Craft): void {
  c.primary = P.p;
  c.rel.x = P.x; c.rel.y = P.y; c.rel.z = P.z;
  c.relV.x = P.vx; c.relV.y = P.vy; c.relV.z = P.vz;
  c.propellant = P.prop;
  c.heat = P.heat;
  c.load = P.load;
}

/** The step a free craft would take right now (what advance() sizes its synchronisation spans with). */
export function stepEstimate(world: World, c: Craft): number {
  const P = P0, rc = c.rcs, tq = c.torque;
  loadParticle(P, c, world);
  const live = !c.destroyed;
  const powered = live && c.propellant > 0 && (c.throttle > 0 || rc.x !== 0 || rc.y !== 0 || rc.z !== 0);
  return chooseDt(P, world.bodies[c.primary], powered, live && (tq.x !== 0 || tq.y !== 0 || tq.z !== 0));
}

/** Steps (translation + rotation sub-steps) taken by integrateCraft since the last call of this function. */
export function takeSteps(): number {
  const s = _steps;
  _steps = 0;
  return s;
}

/**
 * Integrate one free craft from t0 to t1 with its own adaptive steps. Returns the time reached: t1, or earlier
 * when it met the ground (lastStop() === STOP_SURFACE; contact.ts decides what happens next).
 * `tally[why]` counts steps by what limited them; a step cut short by t1 counts as `cutWhy`.
 */
export function integrateCraft(world: World, eph: Ephemeris, c: Craft, t0: number, t1: number, tally: Float64Array, cutWhy: number): number {
  const bodies = world.bodies, P = P0;
  loadParticle(P, c, world);
  let t = t0, n = 0;
  _stop = STOP_NONE;
  while (t < t1) {
    if ((n & 15) === 0) updatePrimary(world, eph, c, P, t);
    const b = bodies[P.p];
    const live = !c.destroyed;
    const rc = c.rcs, tq = c.torque, w = c.w;
    const powered = live && P.prop > 0 && (c.throttle > 0 || rc.x !== 0 || rc.y !== 0 || rc.z !== 0);
    const torquing = live && (tq.x !== 0 || tq.y !== 0 || tq.z !== 0);
    let dt = chooseDt(P, b, powered, torquing);
    let why = _why;
    if (P.inAtm !== c.inAtmosphere) {
      c.inAtmosphere = P.inAtm;
      pushEvent(world, { type: 'atmosphere', t, craftId: c.id, bodyId: b.id, entered: P.inAtm });
    }
    let mdot = 0, lx = 0, ly = 0, lz = 0;
    if (powered) {
      const thr = c.throttle > 1 ? 1 : c.throttle < 0 ? 0 : c.throttle;
      const rx = clamp1(rc.x), ry = clamp1(rc.y), rz = clamp1(rc.z);
      mdot = (c.mainThrust * thr) / c.exhaustVelocity + (c.rcsThrust * (Math.abs(rx) + Math.abs(ry) + Math.abs(rz))) / c.rcsExhaustVelocity;
      if (mdot * dt > P.prop) dt = P.prop / mdot;
      lx = rx * c.rcsThrust; ly = ry * c.rcsThrust; lz = rz * c.rcsThrust - thr * c.mainThrust;
      qRot(F0, c.q, lx, ly, lz);
    }
    let last = false;
    if (t + dt >= t1) { dt = t1 - t; last = true; if (why === WHY_FREE) why = cutWhy; }
    if (torquing || w.x !== 0 || w.y !== 0 || w.z !== 0) {
      const ns = rotateCraft(c, P.m, dt, torquing);
      if (ns > 1) { tally[WHY_ROTATION] += ns - 1; n += ns - 1; }
    }
    if (powered) {
      // Thrust direction held over the step: the mean of the attitude before and after the rotation.
      qRot(F1, c.q, lx, ly, lz);
      const sx = F0.x + F1.x, sy = F0.y + F1.y, sz = F0.z + F1.z;
      const sm = Math.sqrt(sx * sx + sy * sy + sz * sz);
      const k = sm > 0 ? Math.sqrt(lx * lx + ly * ly + lz * lz) / sm : 0;
      P.fx = sx * k; P.fy = sy * k; P.fz = sz * k;
      P.mdot = mdot;
    } else {
      P.fx = P.fy = P.fz = 0;
      P.mdot = 0;
    }
    if (powered || P.inAtm) {
      stepForced(P, b, eph, t, dt);
      if (powered) {
        P.prop -= mdot * dt;
        if (P.prop < 1e-9) P.prop = 0;
        P.m = c.dryMass + P.prop;
      }
    } else {
      stepCoast(P, eph, t, dt);
    }
    t = last ? t1 : t + dt;
    n++;
    tally[why]++;
    if (live) {
      if (P.heat >= P.heatCap) destroyCraft(world, c, 'heat', t);
      else if (P.drag > c.maxLoad) destroyCraft(world, c, 'overload', t);
    }
    const r2 = P.x * P.x + P.y * P.y + P.z * P.z, rn = b.radius + P.reachMax;
    if (r2 < rn * rn) {
      // Near the ground the hull's reach follows the attitude step by step: it lands on its lowest point.
      P.contactH = hullReach(c, P.x, P.y, P.z);
      const rs = b.radius + P.contactH;
      if (r2 < rs * rs) { _stop = STOP_SURFACE; break; }
    }
  }
  storeParticle(P, c);
  _steps += n;
  return t;
}
