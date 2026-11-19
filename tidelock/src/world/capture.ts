// Soft-capture docking (docs/SIMULATION.md W2-C items 1, 2, 7): a capture ring at each port, a 6-DOF spring-damper
// between the ship's collar and the ring with ±0.3 m of stroke and a stiff hard stop, latches that close only on
// collar–ring contact inside the envelope with LATCH ARM on, attenuation (soft), a hook motor that draws the ring in
// (retract), and the hard joint at < 5 mm / < 0.2°. Latch loads while docked, with ratings.
//
// Before the latches close the ring is a one-sided bumper: one unilateral spring-damper row along the port axis at
// the collar's lowest rim point (so a tilted collar gets the aligning moment F·R of a rim contact, bounded by the
// axial load by construction), Coulomb friction (μ = RING_MU) across it, and the axial hard stop. Every pre-latch
// row is either conservative (its deviation C is a continuous function of the pose and its Jacobian is ∇C) or purely
// dissipative, so an off-axis or tilted touch outside the envelope cannot gain energy. At capture the ring is
// deflected with the collar: the lateral and attitude references (refOff, refQ) start at the collar's pose, so no
// spring loads as a step, and the ring's actuators re-centre them at REF_SLEW_V / REF_SLEW_W (actuator work, a few J).
// Attenuation is declared settled only once the references are centred.
//
// Numerics. Every ring force is applied as an impulse at ONE world point to both bodies, equal and opposite, plus
// equal and opposite pure angular impulses: linear and angular momentum are conserved to rounding. Each row is a soft
// constraint solved implicitly in velocity (Catto): λ = −h·(k·(C + h·Jv⁺) + c·Jv⁺). Paired with a free drift of
// the SAME span h after it (kick, then drift) that is backward Euler of the spring-damper, which never gains energy
// for ANY sequence of step sizes. So io.h is the span ABOUT TO BE TAKEN, and captureStep runs at the START of that
// step, before both bodies drift over it (calling it after a drift with the span just taken is only stable while the
// span does not grow: the review measured +19% energy for Q → 0.5 s). c = 2ζ√(k·m_eff), m_eff = 1/K at the point.
// The force is continuous in time, so the pilot feels F/m (≈ 0.3 m/s² for a 0.3 m/s capture), never Δv/h.
// h ≤ 0, NaN or ∞ does nothing (CAP_NONE, zero impulses; the bodies are not touched).
//
// WIRING (wave 2; replaces tryLatch's instant inelastic capture, DOCK_DISTANCE/SPEED/ANGLE and the auto-arm):
// - world.ts advance(), once t1 is final (after the ephemeris clamp) and BEFORE integrateCraft drifts the craft:
//   ringKicks(world, t, t1 − t) (new, in contact.ts), which for each ship s with a collar near a free, fitting port of
//   station st (or latched to it) does:
//     ringGeom(G, port, s.dockPort); bodyFromCraft(CA, s); bodyFromCraft(CB, st)   // by reference: writes the craft
//     IO.h = t1 − t; IO.armed = s.latchArmed (§1.4, W2-D's device); IO.collarOk = s.damage.zones[collar] > 0
//     code = captureStep(G, s.capture, CA, CB, IO)
//     CAP_CONTACT → emitEvent('contact', …, J = |IO.J|); CAP_CAPTURE → push the Joint {kind 'dock', …s.capture} and
//     emitEvent('capture'); CAP_HARD → captureHarden(G, s.capture, CA, CB, IO) then today's kinematic joint at the
//     current relative pose (localPos/localQ) and emitEvent('latch'); CAP_BREAK → drop the joint, emitEvent('undock'),
//     damage event. Every step with IO.energy > 0 (the hard stop, i.e. the structure, was hit): complianceSplit(
//     IO.energy, K_SHIP, K_STATION) and damageComponent(s.damage, model, COLLAR, share) (damage.ts); IO.heat is the
//     ring dampers' heat (W2-D may put it into the collar zone's node). Ledger: ledgerImpulse(c, q⁻¹·IO.J, q⁻¹·IO.r,
//     inp) and the pure angular part q⁻¹·IO.L into dwImpulse (I⁻¹·L) for the ship; the station likewise with −J, −L.
//   proximityLimit: the gap to the ring face is ringGap(G, CA, CB) (replaces `_pDist − 0.5·DOCK_DISTANCE`), and the
//   span is capped at captureMaxStep(s.capture). The `contact`-at-sync call (resolveContacts after the drift) no
//   longer handles docking.
//   updateJoints: a 'dock' joint in phase soft/retract is NOT kinematic (both bodies stay free); only 'hard' pins.
// - dynamics.ts warp: limitedBy 'capture' while captureMaxStep(s.capture) < step (Q engaged/soft, 0.5 s retract).
// - flight.ts (W2-B, on request): delete the docked thrust/RCS/torque interlock; when hard-docked call
//   latchLoad(LL, F_ship, τ_ship, collar, {ship, station}) each tick and release with latchBreakSpeed() above a rating.
// - Save: saveCapture / loadCapture(raw, docked) per ship (s.capture). `docked` = the ship was hard-docked in a save
//   without capture fields: it loads as hard/latched at ext 0 (an old save's docked ship stays docked).
// §1.4: Joint.phase/stroke/strokeV/rot/rotV are these fields; the Joint needs 9 more, all saved: ext, refQ, refOff,
// dwell, engaged, latched, load, shear, moment (load is read by the hook motor on the next step).
// Reads latchArmed; writes the Joint fields above. Budget: one step ≈ 1.5 µs in node; 0 when no ring is engaged.

import type { DockingPortDef, Quat, V3 } from '../core/types';
import type { ContactBody } from './compound';

// Transcendental wrappers (§1.1 rule 6; wave 2 moves them into math.ts with the others).
const msqrt = (x: number): number => Math.sqrt(x);
const matan2 = (y: number, x: number): number => Math.atan2(y, x);
const msin = (x: number): number => Math.sin(x);
const mcos = (x: number): number => Math.cos(x);

// ------------------------------------------------------------------------------------------------ constants

/** Ring stiffness axial and lateral (N/m), angular (N·m/rad), damping ratio; stroke each way (m). */
export const RING_K = 5e4;
export const RING_KT = 5e5;
export const RING_ZETA = 0.6;
export const RING_STROKE = 0.3;
/** Hard stop beyond the stroke: the structure's stiffness (k_ship, N/m) and a damping ratio giving e ≈ 0.2. */
export const STOP_K = 1e7;
export const STOP_ZETA = 0.456;
/** How far the extended ring stands beyond the port's mating point at capture (drawn in by the hook motor), m. */
export const RING_EXT = 0.3;
/** Radius within which the collar meets the ring face (m), and the largest angle at which it does. */
export const RING_CATCH = 0.6;
export const ENGAGE_ANGLE = (30 * Math.PI) / 180;
const COS_ENGAGE = Math.cos(ENGAGE_ANGLE);
/** Pre-latch: Coulomb friction of collar on ring face; the collar's rim radius (the lever of a tilted contact), m. */
export const RING_MU = 0.3;
export const RING_RADIUS = 0.8;
/** After capture the ring's actuators re-centre its lateral (m/s) and attitude (rad/s) references. */
export const REF_SLEW_V = 0.01;
export const REF_SLEW_W = (0.5 * Math.PI) / 180;
/** Capture envelope (3× IDSS, for a phone): lateral, angle, closing speed. */
export const CAP_LATERAL = 0.3;
export const CAP_ANGLE = (10 * Math.PI) / 180;
export const CAP_SPEED = 0.3;
/** Attenuation is over when relative speed < SETTLE_V and rate < SETTLE_W for SETTLE_T. */
export const SETTLE_V = 2e-3;
export const SETTLE_W = 2e-4;
export const SETTLE_T = 2;
/** Hook motor: force limit (N) and speed (m/s); hard joint tolerances. */
export const HOOK_FORCE = 1e4;
export const HOOK_SPEED = 5e-3;
export const HARD_OFFSET = 5e-3;
export const HARD_ANGLE = (0.2 * Math.PI) / 180;
/** Latch ratings: axial, shear (N), moment (N·m); the latch stiffness that stores the energy released on a break. */
export const LATCH_AXIAL = 1.5e5;
export const LATCH_SHEAR = 5e4;
export const LATCH_MOMENT = 1.5e5;
export const LATCH_K = 1e7;
/** Largest steps: engaged or attenuating, and retracting, s. */
export const Q = 1 / 120;
export const RETRACT_STEP = 0.5;

/** Outcome codes of captureStep. */
export const CAP_NONE = 0;
export const CAP_CONTACT = 1;
export const CAP_CAPTURE = 2;
export const CAP_RETRACT = 3;
export const CAP_HARD = 4;
export const CAP_BREAK = 5;
export const CAP_SEPARATED = 6;

// ------------------------------------------------------------------------------------------------ state

/**
 * Ring state of one ship (saved). The §1.4 Joint fields phase/stroke/strokeV/rot/rotV have these names, so a 'dock'
 * Joint extended with the rest can be passed as is. Port axes: x = port.up, y = dir × up, z = dir (axial; stroke.z
 * > 0 is compression). rot is the rotation vector of the collar from its captured attitude, port axes.
 */
export interface CaptureState {
  phase: 'soft' | 'retract' | 'hard';
  stroke: V3;
  strokeV: V3;
  rot: V3;
  rotV: V3;
  /** The collar is on the ring (pre-latch contact or latched). */
  engaged: boolean;
  /** The latches are closed (soft or retract or hard). */
  latched: boolean;
  /** Ring extension beyond the mating point, m. */
  ext: number;
  /**
   * Ship attitude relative to the station at zero ring rotation, station-local: the collar's attitude at capture,
   * slewed to the opposed-axes attitude (captured roll kept) at REF_SLEW_W.
   */
  refQ: Quat;
  /** Lateral reference of the ring (port axes x = up, y = dir × up; z unused): the collar's offset at capture -> 0. */
  refOff: V3;
  /** Time settled so far, s. */
  dwell: number;
  /** Axial ring force over the last step (N, + pushes the ship out), lateral and moment magnitudes. */
  load: number;
  shear: number;
  moment: number;
}

export function makeCaptureState(): CaptureState {
  const z = (): V3 => ({ x: 0, y: 0, z: 0 });
  return { phase: 'soft', stroke: z(), strokeV: z(), rot: z(), rotV: z(), engaged: false, latched: false, ext: RING_EXT, refQ: { x: 0, y: 0, z: 0, w: 1 }, refOff: z(), dwell: 0, load: 0, shear: 0, moment: 0 };
}

const cpV = (a: V3): V3 => ({ x: a.x, y: a.y, z: a.z });
export function saveCapture(s: CaptureState): CaptureState {
  return { ...s, stroke: cpV(s.stroke), strokeV: cpV(s.strokeV), rot: cpV(s.rot), rotV: cpV(s.rotV), refOff: cpV(s.refOff), refQ: { x: s.refQ.x, y: s.refQ.y, z: s.refQ.z, w: s.refQ.w } };
}
/**
 * Loader with defaults. A save without capture fields loads as no ring engaged, or, with `docked` (the ship is
 * hard-docked in that save), as hard/latched/engaged at ext 0 so it stays docked.
 */
export function loadCapture(raw: unknown, docked = false): CaptureState {
  const has = !!raw && typeof raw === 'object' && 'latched' in (raw as object);
  if (!has && docked) {
    const d = makeCaptureState();
    d.phase = 'hard'; d.latched = true; d.engaged = true; d.ext = 0;
    return d;
  }
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const n = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  const vv = (x: unknown): V3 => { const a = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>; return { x: n(a.x, 0), y: n(a.y, 0), z: n(a.z, 0) }; };
  const s = makeCaptureState();
  s.phase = o.phase === 'retract' || o.phase === 'hard' ? o.phase : 'soft';
  s.stroke = vv(o.stroke); s.strokeV = vv(o.strokeV); s.rot = vv(o.rot); s.rotV = vv(o.rotV); s.refOff = vv(o.refOff);
  s.engaged = o.engaged === true; s.latched = o.latched === true;
  s.ext = n(o.ext, RING_EXT);
  const q = (o.refQ && typeof o.refQ === 'object' ? o.refQ : {}) as Record<string, unknown>;
  s.refQ = { x: n(q.x, 0), y: n(q.y, 0), z: n(q.z, 0), w: n(q.w, 1) };
  s.dwell = n(o.dwell, 0); s.load = n(o.load, 0); s.shear = n(o.shear, 0); s.moment = n(o.moment, 0);
  return s;
}

/** Largest step the ring allows (the `capture` limitedBy reason while finite), s. */
export function captureMaxStep(s: CaptureState): number {
  if (s.latched && s.phase === 'hard') return Infinity;
  if (s.latched && s.phase === 'retract') return RETRACT_STEP;
  return s.engaged || s.latched ? Q : Infinity;
}

/** The phase a DockingView shows: 'free' | 'contact' | 'soft' | 'retract' | 'hard'. */
export function ringPhase(s: CaptureState): string {
  return s.latched ? s.phase : s.engaged ? 'contact' : 'free';
}

// ------------------------------------------------------------------------------------------------ geometry and IO

/** The pair's geometry: the port in station axes, the collar in ship axes (filled by ringGeom; no allocation). */
export interface RingGeom {
  portPos: V3; portDir: V3; portUp: V3;
  collarPos: V3; collarDir: V3;
}
export function makeRingGeom(): RingGeom {
  const z = (): V3 => ({ x: 0, y: 0, z: 0 });
  return { portPos: z(), portDir: z(), portUp: z(), collarPos: z(), collarDir: z() };
}
export function ringGeom(g: RingGeom, port: DockingPortDef, collar: { pos: V3; dir: V3 }): RingGeom {
  const c = (o: V3, a: V3): void => { o.x = a.x; o.y = a.y; o.z = a.z; };
  c(g.portPos, port.pos); c(g.portDir, port.dir); c(g.portUp, port.up); c(g.collarPos, collar.pos); c(g.collarDir, collar.dir);
  return g;
}

/** Inputs (h, armed, collarOk) and outputs (impulses on the ship, world axes; energies) of one step. */
export interface RingIO {
  /** The span about to be taken (the bodies drift over it after the call), s. */
  h: number;
  armed: boolean;
  collarOk: boolean;
  /** Linear impulse on the ship (the station gets −J) at the collar point r (relative to the ship's CoM), world. */
  J: V3;
  r: V3;
  /** Pure angular impulse on the ship (the station gets −L), world. */
  L: V3;
  /** First-contact read-outs: lateral offset, angle, closing speed (m, rad, m/s). */
  lateral: number;
  angle: number;
  closing: number;
  /** Energy dissipated this step in the hard stops (the structure: damage, J) and in the ring's dampers (heat, J). */
  energy: number;
  heat: number;
}
export function makeRingIO(): RingIO {
  const z = (): V3 => ({ x: 0, y: 0, z: 0 });
  return { h: Q, armed: false, collarOk: true, J: z(), r: z(), L: z(), lateral: 0, angle: 0, closing: 0, energy: 0, heat: 0 };
}

// ------------------------------------------------------------------------------------------------ scratch

const RA = new Float64Array(9), RB = new Float64Array(9), IA = new Float64Array(9), IB = new Float64Array(9);
/** Working velocities: vA wA(world) vB wB(world). */
const VW = new Float64Array(12);
/** Geometry: pc, rA, rB, a, u, w (port axes world), dW, vrel, theta(world), wrel. */
const GW = new Float64Array(30);
const MAX_ROWS = 9;
const RS = 24;
// Row layout: 0-2 n, 3-5 (rA×n | n), 6-8 IA⁻¹(..), 9-11 (rB×n | n), 12-14 IB⁻¹(..), 15 K, 16 bias, 17 gamma, 18 lambda,
// 19 type (0 lin, 1 ang), 20 clamp (0 none, 1 λ≥0, −1 λ≤0, 2 |λ|≤μλax, 3 |λ|≤Rλax), 21 role (0 ring lin, 1 ring ang, 2 stop)
const ROWS = new Float64Array(MAX_ROWS * RS);
let nRows = 0, axialRow = -1;

function qMat(q: Quat, R: Float64Array): void {
  const l = msqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w) || 1;
  const x = q.x / l, y = q.y / l, z = q.z / l, w = q.w / l;
  R[0] = 1 - 2 * (y * y + z * z); R[1] = 2 * (x * y - z * w); R[2] = 2 * (x * z + y * w);
  R[3] = 2 * (x * y + z * w); R[4] = 1 - 2 * (x * x + z * z); R[5] = 2 * (y * z - x * w);
  R[6] = 2 * (x * z - y * w); R[7] = 2 * (y * z + x * w); R[8] = 1 - 2 * (x * x + y * y);
}
/** I⁻¹ in world axes: R·diag(inv)·Rᵀ. */
function invInertiaWorld(R: Float64Array, inv: V3, out: Float64Array): void {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[i * 3 + j] = R[i * 3] * inv.x * R[j * 3] + R[i * 3 + 1] * inv.y * R[j * 3 + 1] + R[i * 3 + 2] * inv.z * R[j * 3 + 2];
}

/** Add a row along unit n (world) with deviation C, stiffness k, damping ratio z; type 0 linear at pc, 1 angular. */
function addRow(type: number, nx: number, ny: number, nz: number, C: number, k: number, zeta: number, clamp: number, role: number, h: number, invMA: number, invMB: number): number {
  if (nRows >= MAX_ROWS) return -1;
  const o = nRows * RS, R = ROWS;
  R[o] = nx; R[o + 1] = ny; R[o + 2] = nz;
  let ax = nx, ay = ny, az = nz, bx = nx, by = ny, bz = nz;
  if (type === 0) {
    const rAx = GW[3], rAy = GW[4], rAz = GW[5], rBx = GW[6], rBy = GW[7], rBz = GW[8];
    ax = rAy * nz - rAz * ny; ay = rAz * nx - rAx * nz; az = rAx * ny - rAy * nx;
    bx = rBy * nz - rBz * ny; by = rBz * nx - rBx * nz; bz = rBx * ny - rBy * nx;
  }
  R[o + 3] = ax; R[o + 4] = ay; R[o + 5] = az;
  R[o + 6] = IA[0] * ax + IA[1] * ay + IA[2] * az; R[o + 7] = IA[3] * ax + IA[4] * ay + IA[5] * az; R[o + 8] = IA[6] * ax + IA[7] * ay + IA[8] * az;
  R[o + 9] = bx; R[o + 10] = by; R[o + 11] = bz;
  R[o + 12] = IB[0] * bx + IB[1] * by + IB[2] * bz; R[o + 13] = IB[3] * bx + IB[4] * by + IB[5] * bz; R[o + 14] = IB[6] * bx + IB[7] * by + IB[8] * bz;
  let K = ax * R[o + 6] + ay * R[o + 7] + az * R[o + 8] + bx * R[o + 12] + by * R[o + 13] + bz * R[o + 14];
  if (type === 0) K += invMA + invMB;
  R[o + 15] = K;
  if (k === Infinity) { R[o + 16] = 0; R[o + 17] = 0; } else {
    const c = 2 * zeta * msqrt(k / K), den = c + h * k;
    R[o + 16] = (k * C) / den;
    R[o + 17] = 1 / (h * den);
  }
  R[o + 18] = 0; R[o + 19] = type; R[o + 20] = clamp; R[o + 21] = role;
  return nRows++;
}

function solveRows(iterations: number, invMA: number, invMB: number): void {
  const R = ROWS, V = VW;
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < nRows; i++) {
      const o = i * RS, type = R[o + 19];
      let jv: number;
      if (type === 0) {
        // n·(vA − vB) + (rA×n)·ωA − (rB×n)·ωB
        jv = R[o] * (V[0] - V[6]) + R[o + 1] * (V[1] - V[7]) + R[o + 2] * (V[2] - V[8]) +
          R[o + 3] * V[3] + R[o + 4] * V[4] + R[o + 5] * V[5] - R[o + 9] * V[9] - R[o + 10] * V[10] - R[o + 11] * V[11];
      } else {
        jv = R[o] * (V[3] - V[9]) + R[o + 1] * (V[4] - V[10]) + R[o + 2] * (V[5] - V[11]);
      }
      const lam0 = R[o + 18];
      let lam = lam0 - (jv + R[o + 16] + R[o + 17] * lam0) / (R[o + 15] + R[o + 17]);
      const cl = R[o + 20];
      if (cl === 1) { if (lam < 0) lam = 0; } else if (cl === -1) { if (lam > 0) lam = 0; } else if (cl >= 2) {
        const ax = axialRow >= 0 ? R[axialRow * RS + 18] : 0;
        const lim = (cl === 2 ? GUIDE_MU : RING_RADIUS) * (ax > 0 ? ax : 0);
        if (lam > lim) lam = lim; else if (lam < -lim) lam = -lim;
      }
      const d = lam - lam0;
      if (d === 0) continue;
      R[o + 18] = lam;
      if (type === 0) {
        V[0] += invMA * d * R[o]; V[1] += invMA * d * R[o + 1]; V[2] += invMA * d * R[o + 2];
        V[6] -= invMB * d * R[o]; V[7] -= invMB * d * R[o + 1]; V[8] -= invMB * d * R[o + 2];
      }
      V[3] += d * R[o + 6]; V[4] += d * R[o + 7]; V[5] += d * R[o + 8];
      V[9] -= d * R[o + 12]; V[10] -= d * R[o + 13]; V[11] -= d * R[o + 14];
    }
  }
}

// ------------------------------------------------------------------------------------------------ geometry pass

/**
 * Fill RA/RB, IA/IB, the working velocities and GW: pc(0-2) rA(3-5) rB(6-8) a(9-11) u(12-14) w(15-17) dW(18-20)
 * vrel(21-23) cw(24-26) wrel(27-29). `ext` = the ring's extension.
 */
function geometry(g: RingGeom, A: ContactBody, B: ContactBody, ext: number): void {
  qMat(A.q, RA); qMat(B.q, RB);
  invInertiaWorld(RA, A.invI, IA); invInertiaWorld(RB, B.invI, IB);
  const c = g.collarPos, P = g.portPos, D = g.portDir, U = g.portUp;
  const rAx = RA[0] * c.x + RA[1] * c.y + RA[2] * c.z, rAy = RA[3] * c.x + RA[4] * c.y + RA[5] * c.z, rAz = RA[6] * c.x + RA[7] * c.y + RA[8] * c.z;
  const pcx = A.p.x + rAx, pcy = A.p.y + rAy, pcz = A.p.z + rAz;
  GW[0] = pcx; GW[1] = pcy; GW[2] = pcz; GW[3] = rAx; GW[4] = rAy; GW[5] = rAz;
  GW[6] = pcx - B.p.x; GW[7] = pcy - B.p.y; GW[8] = pcz - B.p.z;
  const ax = RB[0] * D.x + RB[1] * D.y + RB[2] * D.z, ay = RB[3] * D.x + RB[4] * D.y + RB[5] * D.z, az = RB[6] * D.x + RB[7] * D.y + RB[8] * D.z;
  const ux = RB[0] * U.x + RB[1] * U.y + RB[2] * U.z, uy = RB[3] * U.x + RB[4] * U.y + RB[5] * U.z, uz = RB[6] * U.x + RB[7] * U.y + RB[8] * U.z;
  GW[9] = ax; GW[10] = ay; GW[11] = az; GW[12] = ux; GW[13] = uy; GW[14] = uz;
  GW[15] = ay * uz - az * uy; GW[16] = az * ux - ax * uz; GW[17] = ax * uy - ay * ux;
  // ring point (world) and deviation of the collar from it
  const qx = P.x + ext * D.x, qy = P.y + ext * D.y, qz = P.z + ext * D.z;
  GW[18] = pcx - (B.p.x + RB[0] * qx + RB[1] * qy + RB[2] * qz);
  GW[19] = pcy - (B.p.y + RB[3] * qx + RB[4] * qy + RB[5] * qz);
  GW[20] = pcz - (B.p.z + RB[6] * qx + RB[7] * qy + RB[8] * qz);
  // velocities: ω world = R·w
  const V = VW;
  V[0] = A.v.x; V[1] = A.v.y; V[2] = A.v.z;
  V[3] = RA[0] * A.w.x + RA[1] * A.w.y + RA[2] * A.w.z; V[4] = RA[3] * A.w.x + RA[4] * A.w.y + RA[5] * A.w.z; V[5] = RA[6] * A.w.x + RA[7] * A.w.y + RA[8] * A.w.z;
  V[6] = B.v.x; V[7] = B.v.y; V[8] = B.v.z;
  V[9] = RB[0] * B.w.x + RB[1] * B.w.y + RB[2] * B.w.z; V[10] = RB[3] * B.w.x + RB[4] * B.w.y + RB[5] * B.w.z; V[11] = RB[6] * B.w.x + RB[7] * B.w.y + RB[8] * B.w.z;
  // relative velocity at pc
  GW[21] = V[0] + V[4] * rAz - V[5] * rAy - V[6] - (V[10] * GW[8] - V[11] * GW[7]);
  GW[22] = V[1] + V[5] * rAx - V[3] * rAz - V[7] - (V[11] * GW[6] - V[9] * GW[8]);
  GW[23] = V[2] + V[3] * rAy - V[4] * rAx - V[8] - (V[9] * GW[7] - V[10] * GW[6]);
  const d = g.collarDir;
  GW[24] = RA[0] * d.x + RA[1] * d.y + RA[2] * d.z; GW[25] = RA[3] * d.x + RA[4] * d.y + RA[5] * d.z; GW[26] = RA[6] * d.x + RA[7] * d.y + RA[8] * d.z;
  GW[27] = V[3] - V[9]; GW[28] = V[4] - V[10]; GW[29] = V[5] - V[11];
}

/** World rotation vector of the collar's swing from the reversed port axis (roll free) -> T. */
function swingVector(T: Float64Array): void {
  // rotation taking −a to cw: axis (−a) × cw, angle atan2(|·|, −a·cw)
  const ax = -GW[9], ay = -GW[10], az = -GW[11], cx = GW[24], cy = GW[25], cz = GW[26];
  const x = ay * cz - az * cy, y = az * cx - ax * cz, z = ax * cy - ay * cx;
  const s = msqrt(x * x + y * y + z * z), ang = matan2(s, ax * cx + ay * cy + az * cz);
  const k = s > 1e-15 ? ang / s : 1;
  T[0] = x * k; T[1] = y * k; T[2] = z * k;
}

const TH = new Float64Array(3);
const QS: Quat = { x: 0, y: 0, z: 0, w: 1 }, QR: Quat = { x: 0, y: 0, z: 0, w: 1 };

/** Latched rotation error: rotation vector (world) of R_rel ⊗ refQ⁻¹ in station axes, rotated to world -> TH. */
function latchedRotation(A: ContactBody, B: ContactBody, refQ: Quat): void {
  // R_rel = qB⁻¹ ⊗ qA
  const bx = -B.q.x, by = -B.q.y, bz = -B.q.z, bw = B.q.w, a = A.q;
  const rx = bw * a.x + bx * a.w + by * a.z - bz * a.y, ry = bw * a.y - bx * a.z + by * a.w + bz * a.x;
  const rz = bw * a.z + bx * a.y - by * a.x + bz * a.w, rw = bw * a.w - bx * a.x - by * a.y - bz * a.z;
  // e = R_rel ⊗ refQ⁻¹
  const fx = -refQ.x, fy = -refQ.y, fz = -refQ.z, fw = refQ.w;
  let ex = rw * fx + rx * fw + ry * fz - rz * fy, ey = rw * fy - rx * fz + ry * fw + rz * fx;
  let ez = rw * fz + rx * fy - ry * fx + rz * fw, ew = rw * fw - rx * fx - ry * fy - rz * fz;
  if (ew < 0) { ex = -ex; ey = -ey; ez = -ez; ew = -ew; }
  const s = msqrt(ex * ex + ey * ey + ez * ez), k = s > 1e-15 ? (2 * matan2(s, ew)) / s : 2;
  const tx = ex * k, ty = ey * k, tz = ez * k;
  TH[0] = RB[0] * tx + RB[1] * ty + RB[2] * tz; TH[1] = RB[3] * tx + RB[4] * ty + RB[5] * tz; TH[2] = RB[6] * tx + RB[7] * ty + RB[8] * tz;
}

/** refQ at capture: the current relative attitude with its swing removed (axes opposed exactly, roll kept). */
function captureRef(A: ContactBody, B: ContactBody, s: CaptureState): void {
  swingVector(TH);
  // the swing in station axes: Rbᵀ·θ; refQ = q(−swing) ⊗ R_rel (station-local)
  const tx = RB[0] * TH[0] + RB[3] * TH[1] + RB[6] * TH[2], ty = RB[1] * TH[0] + RB[4] * TH[1] + RB[7] * TH[2], tz = RB[2] * TH[0] + RB[5] * TH[1] + RB[8] * TH[2];
  const ang = msqrt(tx * tx + ty * ty + tz * tz), sn = ang > 1e-15 ? msin(-0.5 * ang) / ang : 0;
  QS.x = tx * sn; QS.y = ty * sn; QS.z = tz * sn; QS.w = mcos(0.5 * ang);
  const bx = -B.q.x, by = -B.q.y, bz = -B.q.z, bw = B.q.w, a = A.q;
  QR.x = bw * a.x + bx * a.w + by * a.z - bz * a.y; QR.y = bw * a.y - bx * a.z + by * a.w + bz * a.x;
  QR.z = bw * a.z + bx * a.y - by * a.x + bz * a.w; QR.w = bw * a.w - bx * a.x - by * a.y - bz * a.z;
  const r = s.refQ;
  r.x = QS.w * QR.x + QS.x * QR.w + QS.y * QR.z - QS.z * QR.y;
  r.y = QS.w * QR.y - QS.x * QR.z + QS.y * QR.w + QS.z * QR.x;
  r.z = QS.w * QR.z + QS.x * QR.y - QS.y * QR.x + QS.z * QR.w;
  r.w = QS.w * QR.w - QS.x * QR.x - QS.y * QR.y - QS.z * QR.z;
}

/** Port-axes read-outs of the deviation, relative velocity, rotation and rate into the state. */
function readouts(s: CaptureState, th: Float64Array): void {
  const dx = GW[18], dy = GW[19], dz = GW[20];
  const ux = GW[12], uy = GW[13], uz = GW[14], wx = GW[15], wy = GW[16], wz = GW[17], ax = GW[9], ay = GW[10], az = GW[11];
  s.stroke.x = dx * ux + dy * uy + dz * uz; s.stroke.y = dx * wx + dy * wy + dz * wz; s.stroke.z = -(dx * ax + dy * ay + dz * az);
  const vx = GW[21], vy = GW[22], vz = GW[23];
  s.strokeV.x = vx * ux + vy * uy + vz * uz; s.strokeV.y = vx * wx + vy * wy + vz * wz; s.strokeV.z = -(vx * ax + vy * ay + vz * az);
  s.rot.x = th[0] * ux + th[1] * uy + th[2] * uz; s.rot.y = th[0] * wx + th[1] * wy + th[2] * wz; s.rot.z = th[0] * ax + th[1] * ay + th[2] * az;
  const ox = GW[27], oy = GW[28], oz = GW[29];
  s.rotV.x = ox * ux + oy * uy + oz * uz; s.rotV.y = ox * wx + oy * wy + oz * wz; s.rotV.z = ox * ax + oy * ay + oz * az;
}

// ------------------------------------------------------------------------------------------------ the step

/** Write the working velocities back to the bodies (ω to body axes) and the ship's impulses into io. */
function writeBack(A: ContactBody, B: ContactBody, io: RingIO): void {
  const V = VW;
  // impulses on the ship: J = m·Δv is Σλ·n over the linear rows; the angular split into r×J + L
  let Jx = 0, Jy = 0, Jz = 0, Lx = 0, Ly = 0, Lz = 0;
  for (let i = 0; i < nRows; i++) {
    const o = i * RS, l = ROWS[o + 18];
    if (ROWS[o + 19] === 0) { Jx += l * ROWS[o]; Jy += l * ROWS[o + 1]; Jz += l * ROWS[o + 2]; } else { Lx += l * ROWS[o]; Ly += l * ROWS[o + 1]; Lz += l * ROWS[o + 2]; }
  }
  io.J.x = Jx; io.J.y = Jy; io.J.z = Jz; io.L.x = Lx; io.L.y = Ly; io.L.z = Lz;
  io.r.x = GW[3]; io.r.y = GW[4]; io.r.z = GW[5];
  A.v.x = V[0]; A.v.y = V[1]; A.v.z = V[2];
  B.v.x = V[6]; B.v.y = V[7]; B.v.z = V[8];
  A.w.x = RA[0] * V[3] + RA[3] * V[4] + RA[6] * V[5]; A.w.y = RA[1] * V[3] + RA[4] * V[4] + RA[7] * V[5]; A.w.z = RA[2] * V[3] + RA[5] * V[4] + RA[8] * V[5];
  B.w.x = RB[0] * V[9] + RB[3] * V[10] + RB[6] * V[11]; B.w.y = RB[1] * V[9] + RB[4] * V[10] + RB[7] * V[11]; B.w.z = RB[2] * V[9] + RB[5] * V[10] + RB[8] * V[11];
}

const ITER = 4;

/**
 * One step of the ring between ship A and station B over io.h (after both were advanced to this time): engagement,
 * the envelope test at first contact, the ring rows (soft constraints, implicit), stops, guidance limits, phase
 * changes, latch-load check. Writes A and B velocities in place and the impulses into io. Returns a CAP_* code.
 */
export function captureStep(g: RingGeom, s: CaptureState, A: ContactBody, B: ContactBody, io: RingIO): number {
  const h = io.h;
  io.J.x = io.J.y = io.J.z = 0; io.L.x = io.L.y = io.L.z = 0;
  if (s.latched && s.phase === 'hard') return CAP_NONE;
  const invMA = A.invMass, invMB = B.invMass;
  // the hook motor draws the ring in while it can (load from the last step)
  if (s.latched && s.phase === 'retract' && Math.abs(s.load) <= HOOK_FORCE) {
    const e = s.ext - HOOK_SPEED * h;
    s.ext = e > 0 ? e : 0;
  }
  geometry(g, A, B, s.latched ? s.ext : RING_EXT);
  const ax = GW[9], ay = GW[10], az = GW[11], ux = GW[12], uy = GW[13], uz = GW[14], wx = GW[15], wy = GW[16], wz = GW[17];
  const dx = GW[18], dy = GW[19], dz = GW[20];
  const sx = dx * ux + dy * uy + dz * uz, sy = dx * wx + dy * wy + dz * wz, sa = dx * ax + dy * ay + dz * az; // sa < 0: compressed
  const lat = msqrt(sx * sx + sy * sy);
  const cosAng = -(GW[24] * ax + GW[25] * ay + GW[26] * az);
  let code = CAP_NONE;
  if (s.latched) latchedRotation(A, B, s.refQ); else swingVector(TH);
  readouts(s, TH);
  if (!s.latched) {
    const touching = sa < 0 && lat <= RING_CATCH && cosAng >= COS_ENGAGE;
    if (!touching) {
      const was = s.engaged;
      s.engaged = false; s.load = s.shear = s.moment = 0;
      return was ? CAP_SEPARATED : CAP_NONE;
    }
    if (!s.engaged) {
      s.engaged = true;
      io.lateral = lat;
      io.angle = matan2(msqrt(Math.max(0, 1 - cosAng * cosAng)), cosAng);
      io.closing = -(GW[21] * ax + GW[22] * ay + GW[23] * az);
      code = CAP_CONTACT;
      if (io.armed && io.collarOk && lat <= CAP_LATERAL && io.angle <= CAP_ANGLE && io.closing <= CAP_SPEED) {
        s.latched = true; s.phase = 'soft'; s.ext = RING_EXT; s.dwell = 0;
        captureRef(A, B, s);
        latchedRotation(A, B, s.refQ);
        readouts(s, TH);
        code = CAP_CAPTURE;
      }
    }
  }
  // rows
  nRows = 0; axialRow = -1;
  const L = s.latched;
  axialRow = addRow(0, ax, ay, az, sa, RING_K, RING_ZETA, L ? 0 : 1, 0, h, invMA, invMB);
  addRow(0, ux, uy, uz, sx, RING_K, RING_ZETA, L ? 0 : 2, 0, h, invMA, invMB);
  addRow(0, wx, wy, wz, sy, RING_K, RING_ZETA, L ? 0 : 2, 0, h, invMA, invMB);
  const tu = TH[0] * ux + TH[1] * uy + TH[2] * uz, tw = TH[0] * wx + TH[1] * wy + TH[2] * wz;
  addRow(1, ux, uy, uz, tu, RING_KT, RING_ZETA, L ? 0 : 3, 1, h, invMA, invMB);
  addRow(1, wx, wy, wz, tw, RING_KT, RING_ZETA, L ? 0 : 3, 1, h, invMA, invMB);
  if (L) addRow(1, ax, ay, az, TH[0] * ax + TH[1] * ay + TH[2] * az, RING_KT, RING_ZETA, 0, 1, h, invMA, invMB);
  if (sa < -RING_STROKE) addRow(0, ax, ay, az, sa + RING_STROKE, STOP_K, STOP_ZETA, 1, 2, h, invMA, invMB);
  else if (L && sa > RING_STROKE) addRow(0, ax, ay, az, sa - RING_STROKE, STOP_K, STOP_ZETA, -1, 2, h, invMA, invMB);
  if (lat > RING_STROKE) {
    const k = 1 / lat;
    addRow(0, (sx * ux + sy * wx) * k, (sx * uy + sy * wy) * k, (sx * uz + sy * wz) * k, lat - RING_STROKE, STOP_K, STOP_ZETA, -1, 2, h, invMA, invMB);
  }
  solveRows(ITER, invMA, invMB);
  writeBack(A, B, io);
  // loads through the ring over the step (N, N·m), port axes
  const Jx = io.J.x, Jy = io.J.y, Jz = io.J.z;
  const ja = Jx * ax + Jy * ay + Jz * az, ju = Jx * ux + Jy * uy + Jz * uz, jw = Jx * wx + Jy * wy + Jz * wz;
  s.load = ja / h; s.shear = msqrt(ju * ju + jw * jw) / h;
  const Lu = io.L.x * ux + io.L.y * uy + io.L.z * uz, Lw = io.L.x * wx + io.L.y * wy + io.L.z * wz;
  s.moment = msqrt(Lu * Lu + Lw * Lw) / h;
  if (!L) return code;
  if (Math.abs(s.load) > LATCH_AXIAL || s.shear > LATCH_SHEAR || s.moment > LATCH_MOMENT) {
    s.latched = false; s.phase = 'soft'; s.dwell = 0;
    return CAP_BREAK;
  }
  // phase changes
  const vr = msqrt(GW[21] * GW[21] + GW[22] * GW[22] + GW[23] * GW[23]), wr = msqrt(GW[27] * GW[27] + GW[28] * GW[28] + GW[29] * GW[29]);
  if (s.phase === 'soft') {
    s.dwell = vr < SETTLE_V && wr < SETTLE_W ? s.dwell + h : 0;
    if (s.dwell >= SETTLE_T && code === CAP_NONE) { s.phase = 'retract'; s.dwell = 0; return CAP_RETRACT; }
  } else if (s.phase === 'retract' && s.ext === 0) {
    const off = msqrt(dx * dx + dy * dy + dz * dz), th = msqrt(TH[0] * TH[0] + TH[1] * TH[1] + TH[2] * TH[2]);
    if (off < HARD_OFFSET && th < HARD_ANGLE) { s.phase = 'hard'; return CAP_HARD; }
  }
  return code;
}

/**
 * Make the joint rigid (CAP_HARD): one momentum-conserving impulse pair that removes the remaining relative velocity
 * at the collar point and the relative rotation rate, then the caller pins the pose kinematically. io gets the impulses.
 */
export function captureHarden(g: RingGeom, s: CaptureState, A: ContactBody, B: ContactBody, io: RingIO): void {
  const invMA = A.invMass, invMB = B.invMass;
  geometry(g, A, B, s.ext);
  nRows = 0; axialRow = -1;
  for (let k = 0; k < 3; k++) {
    const o = 9 + 3 * k;
    addRow(0, GW[o], GW[o + 1], GW[o + 2], 0, Infinity, 0, 0, 0, io.h, invMA, invMB);
    addRow(1, GW[o], GW[o + 1], GW[o + 2], 0, Infinity, 0, 0, 1, io.h, invMA, invMB);
  }
  solveRows(16, invMA, invMB);
  writeBack(A, B, io);
}

/** Gap between the collar and the ring face along the port axis (m, ≥ 0 apart; for proximityLimit). */
export function ringGap(g: RingGeom, A: ContactBody, B: ContactBody): number {
  geometry(g, A, B, RING_EXT);
  const sa = GW[18] * GW[9] + GW[19] * GW[10] + GW[20] * GW[11];
  return sa > 0 ? sa : 0;
}

// ------------------------------------------------------------------------------------------------ hard-docked loads

/** Latch loads of a hard-docked ship (W2-C item 2): axial, shear (N) and moment (N·m) at the collar. */
export interface LatchLoad { axial: number; shear: number; moment: number; broken: boolean }
export function makeLatchLoad(): LatchLoad { return { axial: 0, shear: 0, moment: 0, broken: false }; }

/**
 * Loads on a hard latch from the ship's own proper force F and torque τ (about its CoM), ship axes, with the stack
 * accelerating as one body: F_l = F − m_ship·a_stack (a_stack = F / (m_ship + m_station), the station's own proper
 * force being zero), M_l = τ + (−collar) × F_l (the stack's angular acceleration neglected: I_station ≫ I_ship).
 * `broken` when any rating is exceeded. `mShip`/`mStation` travel in the `m` object to keep doubles off the call.
 */
export function latchLoad(out: LatchLoad, F: V3, tau: V3, collar: { pos: V3; dir: V3 }, m: { ship: number; station: number }): LatchLoad {
  const k = m.station / (m.ship + m.station);
  const fx = F.x * k, fy = F.y * k, fz = F.z * k;
  const d = collar.dir, c = collar.pos;
  const ax = fx * d.x + fy * d.y + fz * d.z;
  const sx = fx - ax * d.x, sy = fy - ax * d.y, sz = fz - ax * d.z;
  // moment about the collar: τ + (CoM − collar) × F_l = τ − c × F_l
  const mx = tau.x - (c.y * fz - c.z * fy), my = tau.y - (c.z * fx - c.x * fz), mz = tau.z - (c.x * fy - c.y * fx);
  out.axial = ax;
  out.shear = msqrt(sx * sx + sy * sy + sz * sz);
  out.moment = msqrt(mx * mx + my * my + mz * mz);
  out.broken = Math.abs(ax) > LATCH_AXIAL || out.shear > LATCH_SHEAR || out.moment > LATCH_MOMENT;
  return out;
}

/** Separation speed when a loaded latch breaks: its stored energy F²/(2k) shared as kinetic energy of the pair, m/s. */
export function latchBreakSpeed(l: LatchLoad, m: { ship: number; station: number }): number {
  const F2 = l.axial * l.axial + l.shear * l.shear, E = F2 / (2 * LATCH_K), mu = (m.ship * m.station) / (m.ship + m.station);
  return msqrt((2 * E) / mu);
}
