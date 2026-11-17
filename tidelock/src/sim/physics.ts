// TIDELOCK vessel dynamics: the flight model.
//
// What lives here
//   * `Vessel` — the plain, JSON-serialisable dynamic state of one ship, and `createVessel`.
//   * Mass / Δv bookkeeping (Tsiolkovsky), thrust-to-weight, burn time.
//   * `stepVessel`  — numeric integration (fixed-substep RK4) of gravity + main drive + RCS + drag,
//                     with propellant flow, flame-out, aero heating, fuel scooping, attitude dynamics
//                     and exact SOI / surface crossings. Used in real time and "physical" warp (<= 10x).
//   * `coastVessel` — analytic Kepler propagation on rails for high warp, built on
//                     `orbit.predictTrajectory`, so what the map predicts is exactly what happens.
//   * Attitude: torque-limited rotation, rate-command manual input, SAS direction hold.
//   * Warp rules, relative motion, atmosphere helpers and station collision helpers.
//
// Model (docs/ARCHITECTURE.md §4): bodies ride fixed Kepler rails; a ship feels only the gravity of the
// body whose sphere of influence (SOI) it is in. `vessel.r` / `vessel.v` are relative to the centre of
// `vessel.soiBodyId` in non-rotating system axes. SI units throughout. Ship-local axes: forward -Z,
// up +Y, right +X; `vessel.q` maps local -> world; `vessel.w` is the angular velocity in ship-local axes.
//
// Atmospheres are treated as non-rotating (drag and heating use the speed relative to the body centre).
//
// No three.js, no DOM, no Math.random()/Date.now(): runs in plain node. The per-frame paths
// (`stepVessel`, `relativeMotion`, the helpers) do not allocate, except for the events themselves and
// the one-off object when the SAS first stores a direction.

import type { BodyDef, OrbitElements, Quat, StateVector, StationCollider, V3, VesselStats } from '../core/types';
import { DAY } from '../core/units';
import { cross, neg, qFromTo, qLook, qMul, qNormalize } from '../core/vec';
import {
  newOrbitalFrame,
  newState,
  orbitNormalFromElements,
  orbitalFrameTo,
  predictTrajectory,
  timeToRadius,
  type SystemModel,
} from './orbit';

// ===================================================================================== constants

/** Selectable time-warp factors. Factors up to {@link PHYSICS_WARP_MAX} integrate numerically; the rest coast on rails. */
export const WARP_LEVELS: readonly number[] = Object.freeze([1, 2, 4, 10, 50, 100, 1000, 10000, 100000, 1000000]);

/** Highest warp factor flown with `stepVessel` (thrust, drag and attitude stay live). Above it use `coastVessel`. */
export const PHYSICS_WARP_MAX = 10;

/** Largest integration sub-step of `stepVessel`, s. A call with a longer `dt` is split into equal sub-steps. */
export const MAX_SUBSTEP = 1 / 30;

/** Sub-step budget of one `stepVessel` call: beyond `MAX_SUBSTEP * MAX_SUBSTEPS` (~136 s) the sub-step grows instead (see stepVessel). */
export const MAX_SUBSTEPS = 4096;

/**
 * Convective heating coefficient (Sutton–Graves form, SI): stagnation heat flux
 * `q = HEAT_FLUX_COEFF * sqrt(rho) * v^3` in W/m² for a 1 m nose radius.
 */
export const HEAT_FLUX_COEFF = 1.7415e-4;

/** Fraction of the mass flux through the drag area (`rho * v * dragArea`) a fuel scoop captures. */
export const SCOOP_INTAKE_FRACTION = 0.5;

/** Hull lost per second, as a fraction of `hullMax`, when stored heat is at twice `heatCapacity` (scales linearly from 0 at capacity). */
export const OVERHEAT_HULL_RATE = 0.1;

/** Stored heat saturates at this multiple of `stats.heatCapacity`. */
export const HEAT_SATURATION = 2;

/**
 * Minimum altitude, in body radii, for each entry of {@link WARP_LEVELS} (index-aligned). Rails warp
 * (> {@link PHYSICS_WARP_MAX}) additionally needs to be above the atmosphere.
 */
export const WARP_MIN_ALTITUDE_RADII: readonly number[] = Object.freeze([0, 0, 0, 0, 0, 0.02, 0.05, 0.5, 2, 8]);

/** Default real-time warning (s) `maxWarpAllowed` keeps before any event: a factor L is allowed only while the event is more than `L * lead` sim seconds away. */
export const WARP_EVENT_LEAD = 0.25;

/** Rotation inputs smaller than this (absolute, 0..1) count as released. */
export const INPUT_DEADZONE = 0.02;

/** SAS: the braking curve uses this fraction of the available angular acceleration, leaving margin to track it. */
const SAS_BRAKE_FRACTION = 0.8;
/** SAS: pointing error (rad) below which the controller is a linear, critically damped PD. */
const SAS_LINEAR_ANGLE = 0.1;
/** SAS: upper bound on the proportional gain k (1/s); the PD natural frequency is 2k. */
const SAS_MAX_GAIN = 3;
/** Stability hold captures the current heading once the ship turns slower than this, rad/s. */
const STABILITY_CAPTURE_RATE = 0.002;

/** `coastVessel` searches at most this many revolutions per prediction (orbit.ts caps its encounter search at 100,000). */
const COAST_CHUNK_PERIODS = 50000;
/** `coastVessel` gives up (stopReason 'budget') after this many predictions in one call. */
const COAST_MAX_CHUNKS = 256;

// ===================================================================================== vessel state

/** Flight-control inputs. All dimensionless; values outside the stated ranges are clamped, NaN counts as 0. */
export interface VesselControls {
  /** Pitch rate command, -1..1. +1 = nose up (rotation about ship +X). */
  pitch: number;
  /** Yaw rate command, -1..1. +1 = nose right (rotation about ship -Y). */
  yaw: number;
  /** Roll rate command, -1..1. +1 = clockwise seen from behind, right wing down (rotation about ship forward, -Z). */
  roll: number;
  /** Main-drive throttle, 0..1. Thrust acts along ship forward (-Z). */
  throttle: number;
  /** RCS translation, each axis -1..1, ship-local: the force is `translate * stats.rcsThrust` (so z = -1 pushes forward). */
  translate: V3;
}

/**
 * SAS hold modes.
 *  off          – no hold; with the stick released the ship just stops rotating
 *  stability    – hold the current heading (re-captured after manual input)
 *  prograde / retrograde – along / against the velocity relative to the SOI body
 *  normal / antinormal   – along / against the orbit normal (r × v)
 *  radialOut / radialIn  – in the orbit plane, perpendicular to the velocity, away from / toward the body
 *  target / antiTarget   – toward / away from the selected target
 *  maneuver     – along the burn vector of the active manoeuvre node
 *  killRelative – along the burn direction that cancels the velocity relative to the target
 */
export type SasMode =
  | 'off'
  | 'stability'
  | 'prograde'
  | 'retrograde'
  | 'normal'
  | 'antinormal'
  | 'radialOut'
  | 'radialIn'
  | 'target'
  | 'antiTarget'
  | 'maneuver'
  | 'killRelative';

/**
 * Dynamic state of one ship. Plain data: `JSON.parse(JSON.stringify(vessel))` is an identical vessel.
 * Units SI; `r`, `v` relative to the centre of `soiBodyId` in non-rotating system axes.
 */
export interface Vessel {
  id: string;
  name: string;
  /** Body whose sphere of influence the vessel is in. */
  soiBodyId: string;
  /** Position relative to the SOI body's centre, m. */
  r: V3;
  /** Velocity relative to the SOI body, m/s. */
  v: V3;
  /** Orientation, ship-local -> world (unit quaternion). */
  q: Quat;
  /** Angular velocity in ship-local axes, rad/s. */
  w: V3;
  /** Propellant on board, kg (one tank: main drive, RCS, jump drive). */
  fuel: number;
  /** Cargo on board, kg. */
  cargoMass: number;
  /** Fitted-ship statistics (see core/types). */
  stats: VesselStats;
  controls: VesselControls;
  sasMode: SasMode;
  /** World direction (unit, system axes) the SAS is holding ship-forward on, or null when it has none. Maintained by `stepVessel`. */
  sasTarget: V3 | null;
  /** Hull integrity points, 0..stats.hullMax. */
  hull: number;
  /** Shield points, 0..stats.shieldMax (owned by combat; not touched here). */
  shield: number;
  /** Stored heat, same units as stats.heatCapacity (J-equivalent). */
  heat: number;
  /** Station id while docked, else null. A docked vessel rides its station. */
  dockedAt: string | null;
  destroyed: boolean;
}

/** Initial values for {@link createVessel}. Everything except id, SOI body and state has a default. */
export interface VesselInit {
  id: string;
  /** Default: the id. */
  name?: string;
  soiBodyId: string;
  /** Position / velocity relative to `soiBodyId`, m and m/s. */
  r: V3;
  v: V3;
  /** Default: identity (forward = world -Z). */
  q?: Quat;
  /** Default: zero. */
  w?: V3;
  /** kg. Default: full tank. */
  fuel?: number;
  /** kg. Default 0. */
  cargoMass?: number;
  /** Default 'stability'. */
  sasMode?: SasMode;
  /** Default: stats.hullMax / stats.shieldMax / 0. */
  hull?: number;
  shield?: number;
  heat?: number;
  dockedAt?: string | null;
}

/** A fresh vessel. `stats` and the vectors of `init` are copied, so the result shares nothing with its inputs. */
export function createVessel(stats: VesselStats, init: VesselInit): Vessel {
  const q = init.q ? qNormalize(init.q) : { x: 0, y: 0, z: 0, w: 1 };
  return {
    id: init.id,
    name: init.name ?? init.id,
    soiBodyId: init.soiBodyId,
    r: { x: init.r.x, y: init.r.y, z: init.r.z },
    v: { x: init.v.x, y: init.v.y, z: init.v.z },
    q,
    w: init.w ? { x: init.w.x, y: init.w.y, z: init.w.z } : { x: 0, y: 0, z: 0 },
    fuel: clampRange(init.fuel ?? stats.fuelCapacity, 0, stats.fuelCapacity),
    cargoMass: Math.max(0, init.cargoMass ?? 0),
    stats: { ...stats },
    controls: { pitch: 0, yaw: 0, roll: 0, throttle: 0, translate: { x: 0, y: 0, z: 0 } },
    sasMode: init.sasMode ?? 'stability',
    sasTarget: null,
    hull: init.hull ?? stats.hullMax,
    shield: init.shield ?? stats.shieldMax,
    heat: init.heat ?? 0,
    dockedAt: init.dockedAt ?? null,
    destroyed: false,
  };
}

/** Change the SAS mode and drop the held direction, so the new mode starts from the current situation. */
export function setSasMode(vessel: Vessel, mode: SasMode): void {
  vessel.sasMode = mode;
  vessel.sasTarget = null;
}

// ===================================================================================== small helpers

/** Clamp to [lo, hi]; NaN -> 0 (clamped). */
function clampRange(x: number, lo: number, hi: number): number {
  if (x >= lo) return x <= hi ? x : hi;
  if (x < lo) return lo;
  return lo > 0 ? lo : hi < 0 ? hi : 0;
}

/** Write the normalised (x, y, z) into `out`; null if the vector is zero or not finite. */
function normTo(out: V3, x: number, y: number, z: number): V3 | null {
  const l = Math.sqrt(x * x + y * y + z * z);
  if (!(l > 1e-12 && l < Infinity)) return null;
  out.x = x / l;
  out.y = y / l;
  out.z = z / l;
  return out;
}

/** Unit vector of ship forward (-Z local) in world axes. */
export function vesselForward(vessel: Vessel, out: V3 = { x: 0, y: 0, z: 0 }): V3 {
  const q = vessel.q;
  out.x = -2 * (q.x * q.z + q.w * q.y);
  out.y = -2 * (q.y * q.z - q.w * q.x);
  out.z = -(1 - 2 * (q.x * q.x + q.y * q.y));
  return out;
}

// ===================================================================================== mass & Δv

/** Total mass now, kg: dry mass + propellant + cargo. */
export function totalMass(vessel: Vessel): number {
  return vessel.stats.dryMass + Math.max(0, vessel.fuel) + Math.max(0, vessel.cargoMass);
}

/** Main-drive acceleration (m/s²) at `throttle` (0..1, default full) for the current mass; 0 with an empty tank. */
export function currentAccel(vessel: Vessel, throttle = 1): number {
  if (!(vessel.fuel > 0)) return 0;
  return (vessel.stats.mainThrust * clampRange(throttle, 0, 1)) / totalMass(vessel);
}

/** Δv (m/s) the main drive can still deliver: vₑ · ln(m₀ / (m₀ − propellant)). */
export function deltaVRemaining(vessel: Vessel): number {
  const m0 = totalMass(vessel);
  const fuel = Math.max(0, vessel.fuel);
  const m1 = m0 - fuel;
  if (!(m1 > 0) || !(vessel.stats.exhaustVelocity > 0) || !(vessel.stats.mainThrust > 0)) return 0;
  return vessel.stats.exhaustVelocity * Math.log(m0 / m1);
}

/** Propellant (kg) a main-drive burn of `dv` (m/s) consumes from the current mass. May exceed `vessel.fuel`. */
export function propellantForDv(vessel: Vessel, dv: number): number {
  const ve = vessel.stats.exhaustVelocity;
  if (!(ve > 0)) return dv > 0 ? Infinity : 0;
  return totalMass(vessel) * -Math.expm1(-Math.abs(dv) / ve);
}

/**
 * Duration (s) of a main-drive burn of `dv` (m/s) at `throttle` (default full), accounting for the
 * mass lost while burning. Infinity if there is no thrust or not enough propellant on board.
 */
export function burnDuration(vessel: Vessel, dv: number, throttle = 1): number {
  const st = vessel.stats;
  const thrust = st.mainThrust * clampRange(throttle, 0, 1);
  if (!(Math.abs(dv) > 0)) return 0;
  if (!(thrust > 0) || !(st.exhaustVelocity > 0)) return Infinity;
  const prop = propellantForDv(vessel, dv);
  if (prop > Math.max(0, vessel.fuel) * (1 + 1e-12)) return Infinity;
  return (prop * st.exhaustVelocity) / thrust;
}

/** Δv (m/s) a main-drive burn of `duration` seconds at `throttle` delivers from the current mass (stops at flame-out). */
export function burnDeltaV(vessel: Vessel, duration: number, throttle = 1): number {
  const st = vessel.stats;
  const thrust = st.mainThrust * clampRange(throttle, 0, 1);
  if (!(thrust > 0) || !(st.exhaustVelocity > 0) || !(duration > 0)) return 0;
  const m0 = totalMass(vessel);
  const used = Math.min(Math.max(0, vessel.fuel), (thrust / st.exhaustVelocity) * duration);
  return st.exhaustVelocity * Math.log(m0 / (m0 - used));
}

/**
 * Thrust-to-weight ratio of the main drive at full throttle against the gravity of `body` at
 * distance `radius` from its centre (default: where the vessel is). Infinity where there is no gravity.
 */
export function twr(vessel: Vessel, body: BodyDef, radius?: number): number {
  const r = radius ?? Math.sqrt(vessel.r.x * vessel.r.x + vessel.r.y * vessel.r.y + vessel.r.z * vessel.r.z);
  const g = body.mu / (r * r);
  const a = vessel.stats.mainThrust / totalMass(vessel);
  return g > 0 ? a / g : Infinity;
}

/** True while the main drive or the RCS is producing thrust (needs propellant). */
export function isThrusting(vessel: Vessel): boolean {
  if (!(vessel.fuel > 0) || vessel.destroyed) return false;
  const c = vessel.controls;
  const st = vessel.stats;
  if (c.throttle > 0 && st.mainThrust > 0 && st.exhaustVelocity > 0) return true;
  const tr = c.translate;
  return (tr.x !== 0 || tr.y !== 0 || tr.z !== 0) && st.rcsThrust > 0 && st.rcsExhaustVelocity > 0 && Number.isFinite(tr.x + tr.y + tr.z);
}

// ===================================================================================== atmosphere

/**
 * Atmospheric density (kg/m³) at `altitude` (m above `body.radius`). Exponential with the body's scale
 * height, shifted and rescaled so it is exactly `surfaceDensity` at altitude 0 and exactly 0 at
 * `atmosphere.height` (continuous at the top, so entering the atmosphere is smooth):
 * `rho0 · (e^(−h/H) − e^(−top/H)) / (1 − e^(−top/H))`. Below the surface it stays at the surface value;
 * 0 for airless bodies and above the top.
 */
export function atmosphereDensity(body: BodyDef, altitude: number): number {
  const atm = body.atmosphere;
  if (!atm || !(altitude < atm.height) || !(atm.scaleHeight > 0)) return 0;
  if (altitude <= 0) return atm.surfaceDensity;
  const off = Math.exp(-atm.height / atm.scaleHeight);
  return (atm.surfaceDensity * (Math.exp(-altitude / atm.scaleHeight) - off)) / (1 - off);
}

/** Alias of {@link atmosphereDensity}. */
export const density = atmosphereDensity;

/** Dynamic pressure ½·ρ·v², Pa, for density `rho` (kg/m³) and airspeed `speed` (m/s). */
export function dynamicPressure(rho: number, speed: number): number {
  return 0.5 * rho * speed * speed;
}

/** Convective stagnation heat flux, W/m²: {@link HEAT_FLUX_COEFF}·√ρ·v³ (ρ in kg/m³, v in m/s). */
export function heatFlux(rho: number, speed: number): number {
  return HEAT_FLUX_COEFF * Math.sqrt(rho > 0 ? rho : 0) * speed * speed * speed;
}

/**
 * Rate at which aerodynamic heating adds to `vessel.heat`, in heat units per second (W-equivalent):
 * `heatFlux(rho, speed) · stats.dragArea / stats.heatShield`. Compare with `stats.heatDissipation`.
 */
export function aeroHeatingPower(stats: VesselStats, rho: number, speed: number): number {
  const shield = stats.heatShield > 0 ? stats.heatShield : 1;
  return (heatFlux(rho, speed) * Math.max(0, stats.dragArea)) / shield;
}

/** Drag deceleration (m/s²) of a ship of `mass` kg: ½·ρ·v²·dragArea / mass. */
export function dragAccel(stats: VesselStats, mass: number, rho: number, speed: number): number {
  return mass > 0 ? (dynamicPressure(rho, speed) * Math.max(0, stats.dragArea)) / mass : 0;
}

/** Propellant a fuel scoop gathers per second, kg/s, at density `rho` and speed `speed` (0 without a scoop). */
export function scoopRate(stats: VesselStats, rho: number, speed: number): number {
  return stats.hasFuelScoop ? SCOOP_INTAKE_FRACTION * rho * speed * Math.max(0, stats.dragArea) : 0;
}

/** Altitude of the vessel above the mean radius of `body` (its SOI body), m. */
export function altitudeOf(vessel: Vessel, body: BodyDef): number {
  return Math.sqrt(vessel.r.x * vessel.r.x + vessel.r.y * vessel.r.y + vessel.r.z * vessel.r.z) - body.radius;
}

/** True if the vessel is below the top of the atmosphere of `body` (its SOI body). */
export function inAtmosphere(vessel: Vessel, body: BodyDef): boolean {
  const atm = body.atmosphere;
  return !!atm && altitudeOf(vessel, body) < atm.height;
}

// ===================================================================================== events

/** Things that happen to a vessel during a step. `t` is the sim time (s) of the event. */
export type VesselEvent =
  /** Crossed a sphere of influence; the vessel's state is now relative to `toBodyId`. */
  | { type: 'soi-change'; t: number; fromBodyId: string; toBodyId: string }
  | { type: 'atmosphere-enter'; t: number; bodyId: string }
  | { type: 'atmosphere-exit'; t: number; bodyId: string }
  /** Hit the surface at `speed` m/s (relative to the body centre). Always followed by 'destroyed'. */
  | { type: 'impact'; t: number; bodyId: string; speed: number }
  /** The tank ran dry while thrusting. */
  | { type: 'flameout'; t: number }
  /** Stored heat rose above stats.heatCapacity: the hull is taking damage. */
  | { type: 'overheat'; t: number }
  | { type: 'destroyed'; t: number; cause: 'impact' | 'heat' };

const NO_EVENTS: readonly VesselEvent[] = Object.freeze([]) as readonly VesselEvent[];

let _events: VesselEvent[] | null = null;

function pushEvent(e: VesselEvent): void {
  if (_events === null) _events = [];
  _events.push(e);
}

// ===================================================================================== SAS

/** What the SAS needs to know about the world outside the vessel. All vectors in system (world) axes. */
export interface SasContext {
  /** Target position relative to the vessel (target − vessel), m. For 'target' / 'antiTarget'. */
  targetRelPos?: V3 | null;
  /** Target velocity relative to the vessel (target − vessel), m/s. For 'killRelative'. */
  targetRelVel?: V3 | null;
  /** Burn vector of the active manoeuvre node (any length). For 'maneuver'. */
  maneuverDir?: V3 | null;
}

/** Environment of a `stepVessel` call: currently the SAS context. */
export type StepEnv = SasContext;

const NO_ENV: SasContext = Object.freeze({});
const _frame = newOrbitalFrame();
const _dir: V3 = { x: 0, y: 0, z: 0 };

/**
 * World direction (unit vector, system axes) a SAS mode wants ship-forward to point along, written
 * into `out`; null when the mode has no direction right now ('off', a target mode without a target,
 * 'maneuver' without a node, 'killRelative' at rest relative to the target).
 * 'stability' returns the held heading, or the current heading if none is held yet.
 * Orbit-relative modes use the manoeuvre frame of `orbit.orbitalFrame` (prograde, normal, radial).
 */
export function sasDirection(mode: SasMode, vessel: Vessel, ctx: SasContext = NO_ENV, out: V3 = { x: 0, y: 0, z: 0 }): V3 | null {
  switch (mode) {
    case 'off':
      return null;
    case 'stability': {
      const s = vessel.sasTarget;
      return s ? (normTo(out, s.x, s.y, s.z) ?? vesselForward(vessel, out)) : vesselForward(vessel, out);
    }
    case 'prograde':
    case 'retrograde':
    case 'normal':
    case 'antinormal':
    case 'radialOut':
    case 'radialIn': {
      const f = orbitalFrameTo(_frame, vessel);
      const a = mode === 'prograde' || mode === 'retrograde' ? f.prograde : mode === 'normal' || mode === 'antinormal' ? f.normal : f.radial;
      const s = mode === 'prograde' || mode === 'normal' || mode === 'radialOut' ? 1 : -1;
      return normTo(out, a.x * s, a.y * s, a.z * s);
    }
    case 'target': {
      const p = ctx.targetRelPos;
      return p ? normTo(out, p.x, p.y, p.z) : null;
    }
    case 'antiTarget': {
      const p = ctx.targetRelPos;
      return p ? normTo(out, -p.x, -p.y, -p.z) : null;
    }
    case 'maneuver': {
      const d = ctx.maneuverDir;
      return d ? normTo(out, d.x, d.y, d.z) : null;
    }
    case 'killRelative': {
      const d = ctx.targetRelVel;
      if (!d || !(d.x * d.x + d.y * d.y + d.z * d.z > 1e-8)) return null;
      return normTo(out, d.x, d.y, d.z);
    }
  }
}

/** Angle (rad, 0..π) between ship forward and the world direction `dir` (any length; 0 for a zero vector). */
export function pointingError(vessel: Vessel, dir: V3): number {
  const q = vessel.q;
  const fx = -2 * (q.x * q.z + q.w * q.y);
  const fy = -2 * (q.y * q.z - q.w * q.x);
  const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
  const cx = fy * dir.z - fz * dir.y;
  const cy = fz * dir.x - fx * dir.z;
  const cz = fx * dir.y - fy * dir.x;
  return Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), fx * dir.x + fy * dir.y + fz * dir.z);
}

/** Angular acceleration available now, rad/s²: `stats.maxAngularAccel` scaled by dry mass / total mass. */
export function angularAccelLimit(vessel: Vessel): number {
  const m = totalMass(vessel);
  return m > 0 ? (vessel.stats.maxAngularAccel * vessel.stats.dryMass) / m : vessel.stats.maxAngularAccel;
}

/**
 * Advance attitude by `h` seconds. Torque-limited: |Δw| <= aMax·h.
 *  - Manual pitch/yaw input, or no direction to hold: rate command (stick · maxAngularRate); released = stop.
 *  - Otherwise: slew ship-forward onto the world direction (dx, dy, dz). The commanded rate follows a
 *    braking curve w(θ) = k·θ near the target and √(2·a·(θ − θs/2)) beyond θs = a/k², capped at
 *    maxAngularRate, and the rate error is closed with gain 4k: for small errors that is exactly the
 *    critically damped PD  α = −ωn²·θ − 2·ωn·w  with ωn = 2k; for large ones the curve never asks for
 *    more than `SAS_BRAKE_FRACTION` of the available torque to stop, so the slew does not overshoot.
 * Roll always follows the roll stick as a rate command.
 */
function stepAttitude(vessel: Vessel, h: number, manual: boolean, hasDir: boolean, dx: number, dy: number, dz: number, mass: number): void {
  if (!(h > 0)) return;
  const st = vessel.stats;
  const c = vessel.controls;
  const q = vessel.q;
  const w = vessel.w;
  // At rest with nothing commanded and nothing to hold: stays at rest.
  if (!hasDir && !manual && w.x === 0 && w.y === 0 && w.z === 0 && !(c.roll !== 0)) return;
  const aMax = Math.max(0, (st.maxAngularAccel * st.dryMass) / mass);
  const rMax = Math.max(0, st.maxAngularRate);
  let wdx = 0;
  let wdy = 0;
  const wdz = -clampRange(c.roll, -1, 1) * rMax;
  let blend = 1;
  if (manual || !hasDir) {
    wdx = clampRange(c.pitch, -1, 1) * rMax;
    wdy = -clampRange(c.yaw, -1, 1) * rMax;
  } else {
    // Target direction in ship-local axes: conj(q) · d.
    const qx = -q.x;
    const qy = -q.y;
    const qz = -q.z;
    const qw = q.w;
    const tx = 2 * (qy * dz - qz * dy);
    const ty = 2 * (qz * dx - qx * dz);
    const tz = 2 * (qx * dy - qy * dx);
    const lx = dx + qw * tx + (qy * tz - qz * ty);
    const ly = dy + qw * ty + (qz * tx - qx * tz);
    const lz = dz + qw * tz + (qx * ty - qy * tx);
    // Rotation axis forward × d = (ly, -lx, 0); angle from forward (0, 0, -1) to d.
    const s = Math.sqrt(lx * lx + ly * ly);
    const theta = Math.atan2(s, -lz);
    let ex = 0;
    let ey = 0;
    if (s > 1e-9 * (s + Math.abs(lz))) {
      ex = ly / s;
      ey = -lx / s;
    } else if (lz > 0) {
      // Dead astern: any axis perpendicular to forward will do. Keep turning the way we already are.
      const wp = Math.sqrt(w.x * w.x + w.y * w.y);
      if (wp > 1e-6) {
        ex = w.x / wp;
        ey = w.y / wp;
      } else {
        ey = 1;
      }
    }
    const aBrake = SAS_BRAKE_FRACTION * aMax;
    let k = Math.sqrt(aBrake / SAS_LINEAR_ANGLE);
    if (k > SAS_MAX_GAIN) k = SAS_MAX_GAIN;
    let rate = 0;
    if (k > 0) {
      const thS = aBrake / (k * k);
      rate = theta <= thS ? k * theta : Math.sqrt(2 * aBrake * (theta - 0.5 * thS));
      if (rate > rMax) rate = rMax;
      if (rate * h > theta) rate = theta / h;
      blend = -Math.expm1(-4 * k * h);
    }
    wdx = ex * rate;
    wdy = ey * rate;
  }
  let ddx = (wdx - w.x) * blend;
  let ddy = (wdy - w.y) * blend;
  let ddz = wdz - w.z; // roll is a plain rate command in every mode
  const lim = aMax * h;
  const dl = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
  if (dl > lim) {
    const f = dl > 0 ? lim / dl : 0;
    ddx *= f;
    ddy *= f;
    ddz *= f;
  }
  w.x += ddx;
  w.y += ddy;
  w.z += ddz;
  // q <- q · exp(w·h / 2)  (body-frame rate: right-multiply).
  const wl = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);
  if (wl < 1e-12) {
    // The PD approaches rest exponentially: call it rest instead of decaying into denormals.
    w.x = 0;
    w.y = 0;
    w.z = 0;
    return;
  }
  const ang = wl * h;
  if (ang > 1e-14) {
    const sh = Math.sin(0.5 * ang) / wl;
    const bx = w.x * sh;
    const by = w.y * sh;
    const bz = w.z * sh;
    const bw = Math.cos(0.5 * ang);
    const ax = q.x;
    const ay = q.y;
    const az = q.z;
    const aw = q.w;
    let nx = aw * bx + ax * bw + ay * bz - az * by;
    let ny = aw * by - ax * bz + ay * bw + az * bx;
    let nz = aw * bz + ax * by - ay * bx + az * bw;
    let nw = aw * bw - ax * bx - ay * by - az * bz;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
    if (nl > 0) {
      nx /= nl;
      ny /= nl;
      nz /= nl;
      nw /= nl;
      q.x = nx;
      q.y = ny;
      q.z = nz;
      q.w = nw;
    }
  }
}

// ===================================================================================== integrator scratch

// Translational state being integrated (relative to the current SOI body), and the total mass.
let _x = 0;
let _y = 0;
let _z = 0;
let _vx = 0;
let _vy = 0;
let _vz = 0;
let _m = 1;
let _fuel = 0;
// Saved copy for re-doing a sub-step.
let _s0x = 0;
let _s0y = 0;
let _s0z = 0;
let _s0vx = 0;
let _s0vy = 0;
let _s0vz = 0;
// Thrust (world axes, N) and total propellant flow (kg/s) held over a sub-step.
let _Fx = 0;
let _Fy = 0;
let _Fz = 0;
let _mdot = 0;
// Acceleration output of accel().
let _ax = 0;
let _ay = 0;
let _az = 0;
// Current SOI body.
let _bi = -1;
let _mu = 0;
let _R = 0;
let _R2 = 0;
let _soi2 = Infinity;
let _atmTop = 0;
let _atmTop2 = 0;
let _rho0 = 0;
let _invH = 0;
let _rhoOff = 0;
let _rhoNorm = 1;
let _scoopable = false;
let _kids: readonly number[] = [];
let _cdA = 0;
// Outputs of aeroRates().
let _heatP = 0;
let _scoopR = 0;
let _lam = 0;
// Radial band (squared) in which each body's SOI can be, relative to its parent; per model.
let _bandModel: SystemModel | null = null;
let _bandLo2 = new Float64Array(0);
let _bandHi2 = new Float64Array(0);

function ensureBands(model: SystemModel): void {
  if (model === _bandModel) return;
  _bi = -1; // the cached body context belongs to the previous model
  const n = model.bodies.length;
  _bandLo2 = new Float64Array(n);
  _bandHi2 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const b = model.bodies[i];
    const o = b.orbit;
    if (!o || model._parent[i] < 0) {
      _bandLo2[i] = Infinity;
      _bandHi2[i] = 0;
      continue;
    }
    const bound = o.a > 0 && o.e < 1;
    const rcMin = Math.abs(o.a * (1 - o.e));
    const rcMax = bound ? o.a * (1 + o.e) : Infinity;
    const lo = Math.max(0, rcMin - b.soi) * (1 - 1e-9);
    const hi = (rcMax + b.soi) * (1 + 1e-9);
    _bandLo2[i] = lo * lo;
    _bandHi2[i] = hi * hi;
  }
  _bandModel = model;
}

function setBody(model: SystemModel, bi: number): void {
  const b = model.bodies[bi];
  _bi = bi;
  _mu = b.mu;
  _R = b.radius;
  _R2 = _R * _R;
  _soi2 = model._parent[bi] >= 0 ? b.soi * b.soi : Infinity;
  const atm = b.atmosphere;
  if (atm && atm.height > 0 && atm.scaleHeight > 0 && atm.surfaceDensity > 0) {
    _atmTop = _R + atm.height;
    _atmTop2 = _atmTop * _atmTop;
    _rho0 = atm.surfaceDensity;
    _invH = 1 / atm.scaleHeight;
    _rhoOff = Math.exp(-atm.height * _invH);
    _rhoNorm = 1 / (1 - _rhoOff);
    _scoopable = atm.scoopable;
  } else {
    _atmTop = 0;
    _atmTop2 = 0;
    _rho0 = 0;
    _invH = 0;
    _rhoOff = 0;
    _rhoNorm = 1;
    _scoopable = false;
  }
  _kids = model._children[bi];
}

/** Density at distance `r` from the centre of the current body (same law as atmosphereDensity). */
function rhoAtRadius(r: number): number {
  if (!(r < _atmTop)) return 0;
  const alt = r - _R;
  if (alt <= 0) return _rho0;
  return _rho0 * (Math.exp(-alt * _invH) - _rhoOff) * _rhoNorm;
}

/** Acceleration (gravity of the current body + held thrust + drag) at a state, into _ax.._az. */
function accel(x: number, y: number, z: number, vx: number, vy: number, vz: number, m: number): void {
  const r2 = x * x + y * y + z * z;
  let ax = 0;
  let ay = 0;
  let az = 0;
  const im = m > 1e-9 ? 1 / m : 0;
  if (r2 > 0) {
    const r = Math.sqrt(r2);
    const k = -_mu / (r2 * r);
    ax = k * x;
    ay = k * y;
    az = k * z;
    if (r < _atmTop) {
      const d = -0.5 * rhoAtRadius(r) * Math.sqrt(vx * vx + vy * vy + vz * vz) * _cdA * im;
      ax += d * vx;
      ay += d * vy;
      az += d * vz;
    }
  }
  _ax = ax + _Fx * im;
  _ay = ay + _Fy * im;
  _az = az + _Fz * im;
}

/** One classical RK4 step of length `h` on (_x.._vz), with the mass falling linearly at _mdot. Does not change _m / _fuel. */
function rk4(h: number): void {
  const x0 = _x;
  const y0 = _y;
  const z0 = _z;
  const vx0 = _vx;
  const vy0 = _vy;
  const vz0 = _vz;
  const m0 = _m;
  const hh = 0.5 * h;
  const mMid = m0 - _mdot * hh;
  const mEnd = m0 - _mdot * h;
  accel(x0, y0, z0, vx0, vy0, vz0, m0);
  const a1x = _ax;
  const a1y = _ay;
  const a1z = _az;
  const v2x = vx0 + a1x * hh;
  const v2y = vy0 + a1y * hh;
  const v2z = vz0 + a1z * hh;
  accel(x0 + vx0 * hh, y0 + vy0 * hh, z0 + vz0 * hh, v2x, v2y, v2z, mMid);
  const a2x = _ax;
  const a2y = _ay;
  const a2z = _az;
  const v3x = vx0 + a2x * hh;
  const v3y = vy0 + a2y * hh;
  const v3z = vz0 + a2z * hh;
  accel(x0 + v2x * hh, y0 + v2y * hh, z0 + v2z * hh, v3x, v3y, v3z, mMid);
  const a3x = _ax;
  const a3y = _ay;
  const a3z = _az;
  accel(x0 + v3x * h, y0 + v3y * h, z0 + v3z * h, vx0 + a3x * h, vy0 + a3y * h, vz0 + a3z * h, mEnd);
  const h6 = h / 6;
  _x = x0 + h * (vx0 + (a1x + a2x + a3x) * h6);
  _y = y0 + h * (vy0 + (a1y + a2y + a3y) * h6);
  _z = z0 + h * (vz0 + (a1z + a2z + a3z) * h6);
  _vx = vx0 + h6 * (a1x + 2 * a2x + 2 * a3x + _ax);
  _vy = vy0 + h6 * (a1y + 2 * a2y + 2 * a3y + _ay);
  _vz = vz0 + h6 * (a1z + 2 * a2z + 2 * a3z + _az);
}

function saveState(): void {
  _s0x = _x;
  _s0y = _y;
  _s0z = _z;
  _s0vx = _vx;
  _s0vy = _vy;
  _s0vz = _vz;
}

function restoreState(): void {
  _x = _s0x;
  _y = _s0y;
  _z = _s0z;
  _vx = _s0vx;
  _vy = _s0vy;
  _vz = _s0vz;
}

/** Thrust for the coming sub-step from the controls and the current attitude: sets _Fx.._Fz (world, N) and _mdot (kg/s). */
function setThrust(vessel: Vessel): void {
  _Fx = 0;
  _Fy = 0;
  _Fz = 0;
  _mdot = 0;
  if (!(_fuel > 0)) return;
  const st = vessel.stats;
  const c = vessel.controls;
  const thr = clampRange(c.throttle, 0, 1);
  const tr = c.translate;
  const hasMain = thr > 0 && st.mainThrust > 0 && st.exhaustVelocity > 0;
  const hasRcs = (tr.x !== 0 || tr.y !== 0 || tr.z !== 0) && st.rcsThrust > 0 && st.rcsExhaustVelocity > 0;
  if (!hasMain && !hasRcs) return;
  let fx = 0;
  let fy = 0;
  let fz = 0;
  let mdot = 0;
  if (hasMain) {
    const F = thr * st.mainThrust;
    fz -= F;
    mdot += F / st.exhaustVelocity;
  }
  if (hasRcs) {
    const tx = clampRange(tr.x, -1, 1);
    const ty = clampRange(tr.y, -1, 1);
    const tz = clampRange(tr.z, -1, 1);
    const F = st.rcsThrust;
    fx += tx * F;
    fy += ty * F;
    fz += tz * F;
    mdot += (F * (Math.abs(tx) + Math.abs(ty) + Math.abs(tz))) / st.rcsExhaustVelocity;
  }
  if (!(mdot > 0)) return;
  // World force = q · f.
  const q = vessel.q;
  const tx2 = 2 * (q.y * fz - q.z * fy);
  const ty2 = 2 * (q.z * fx - q.x * fz);
  const tz2 = 2 * (q.x * fy - q.y * fx);
  _Fx = fx + q.w * tx2 + (q.y * tz2 - q.z * ty2);
  _Fy = fy + q.w * ty2 + (q.z * tx2 - q.x * tz2);
  _Fz = fz + q.w * tz2 + (q.x * ty2 - q.y * tx2);
  _mdot = mdot;
}

/** Heating power, scoop rate and drag rate constant at the current scratch state (inside the atmosphere). */
function aeroRates(st: VesselStats): void {
  const rho = rhoAtRadius(Math.sqrt(_x * _x + _y * _y + _z * _z));
  const sp = Math.sqrt(_vx * _vx + _vy * _vy + _vz * _vz);
  const shield = st.heatShield > 0 ? st.heatShield : 1;
  _heatP = (HEAT_FLUX_COEFF * Math.sqrt(rho) * sp * sp * sp * _cdA) / shield;
  _scoopR = _scoopable && st.hasFuelScoop ? SCOOP_INTAKE_FRACTION * rho * sp * _cdA : 0;
  _lam = (rho * sp * _cdA) / _m;
}

const K_NONE = 0;
const K_IMPACT = 1;
const K_EXIT = 2;
const K_ENTER = 3;

/** Child of the current body whose SOI the scratch state (at time `tAt`) has entered, or -1. */
function findEntry(model: SystemModel, r2: number, tAt: number): number {
  const kids = _kids;
  for (let k = 0; k < kids.length; k++) {
    const ci = kids[k];
    if (r2 < _bandLo2[ci] || r2 > _bandHi2[ci]) continue;
    const rel = model._rel(ci, tAt);
    const dx = _x - rel.r.x;
    const dy = _y - rel.r.y;
    const dz = _z - rel.r.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    const soi = model.bodies[ci].soi;
    const s2 = soi * soi;
    if (d2 >= s2) continue;
    // Deep inside: it belongs there. Near the edge: only on its way in (so an exit never bounces back).
    const closing = -(dx * (_vx - rel.v.x) + dy * (_vy - rel.v.y) + dz * (_vz - rel.v.z));
    if (closing > 0 || d2 < s2 * (1 - 2e-6)) return ci;
  }
  return -1;
}

/** Signed distance past a boundary of the scratch state at time `tAt`: < 0 before the crossing, >= 0 after. */
function boundary(kind: number, model: SystemModel, ci: number, tAt: number): number {
  if (kind === K_IMPACT) return _R - Math.sqrt(_x * _x + _y * _y + _z * _z);
  if (kind === K_EXIT) return Math.sqrt(_x * _x + _y * _y + _z * _z) - Math.sqrt(_soi2);
  const rel = model._rel(ci, tAt);
  const dx = _x - rel.r.x;
  const dy = _y - rel.r.y;
  const dz = _z - rel.r.z;
  return model.bodies[ci].soi - Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * The sub-step of length `h` from the saved state (time `t0`) ended past a boundary. Find the fraction
 * f of it at which the boundary is crossed (regula falsi, Illinois variant) and leave the scratch
 * state at f·h, on or just past the boundary. Returns f in [0, 1].
 */
function refineCrossing(kind: number, model: SystemModel, ci: number, t0: number, h: number): number {
  let fb = 1;
  let gb = boundary(kind, model, ci, t0 + h);
  restoreState();
  let fa = 0;
  let ga = boundary(kind, model, ci, t0);
  if (ga >= 0) return 0;
  if (!(gb >= 0)) {
    // Not actually past it (cannot happen for a consistent detection): keep the full step.
    rk4(h);
    return 1;
  }
  const scale = kind === K_IMPACT ? _R : kind === K_EXIT ? Math.sqrt(_soi2) : model.bodies[ci].soi;
  const tol = 1e-12 * scale + 1e-7;
  let side = 0;
  for (let it = 0; it < 40; it++) {
    let f = (fa * gb - fb * ga) / (gb - ga);
    if (!(f > fa && f < fb)) f = 0.5 * (fa + fb);
    restoreState();
    rk4(f * h);
    const g = boundary(kind, model, ci, t0 + f * h);
    if (g >= 0) {
      fb = f;
      gb = g;
      if (g <= tol) return f;
      if (side === 1) ga *= 0.5;
      side = 1;
    } else {
      fa = f;
      ga = g;
      if (side === -1) gb *= 0.5;
      side = -1;
    }
    if ((fb - fa) * h < 1e-11) break;
  }
  restoreState();
  rk4(fb * h);
  return fb;
}

const _dockSv = newState();

/** Put a docked vessel on its station's state at `t`. Returns false if the station is not in this system. */
function syncDocked(model: SystemModel, vessel: Vessel, t: number): boolean {
  const id = vessel.dockedAt;
  const stations = model.def.stations;
  for (let i = 0; i < stations.length; i++) {
    if (stations[i].id !== id) continue;
    model.stationState(stations[i].id, t, _dockSv);
    vessel.r.x = _dockSv.r.x;
    vessel.r.y = _dockSv.r.y;
    vessel.r.z = _dockSv.r.z;
    vessel.v.x = _dockSv.v.x;
    vessel.v.y = _dockSv.v.y;
    vessel.v.z = _dockSv.v.z;
    vessel.soiBodyId = stations[i].parentBodyId;
    vessel.w.x = 0;
    vessel.w.y = 0;
    vessel.w.z = 0;
    return true;
  }
  return false;
}

/** Radiate stored heat for `dt` seconds with no heat input. */
function coolDown(vessel: Vessel, dt: number): void {
  if (vessel.heat > 0) {
    const h = vessel.heat - Math.max(0, vessel.stats.heatDissipation) * dt;
    vessel.heat = h > 0 ? h : 0;
  }
}

/** Add `pIn` (heat units/s, averaged over the step) for `hs` seconds, radiate, and apply overheat damage. */
function applyHeat(vessel: Vessel, pIn: number, hs: number, tNow: number): void {
  const st = vessel.stats;
  const cap = st.heatCapacity > 0 ? st.heatCapacity : 1;
  const before = vessel.heat > 0 ? vessel.heat : 0;
  let heat = before + (pIn - Math.max(0, st.heatDissipation)) * hs;
  if (!(heat > 0)) heat = 0;
  if (heat > HEAT_SATURATION * cap) heat = HEAT_SATURATION * cap;
  vessel.heat = heat;
  if (heat > cap) {
    if (before <= cap) pushEvent({ type: 'overheat', t: tNow });
    const over = Math.min(1, (heat - cap) / cap);
    vessel.hull -= st.hullMax * OVERHEAT_HULL_RATE * over * hs;
    if (!(vessel.hull > 0)) {
      vessel.hull = 0;
      vessel.destroyed = true;
      pushEvent({ type: 'destroyed', t: tNow, cause: 'heat' });
    }
  }
}

// ===================================================================================== stepVessel

/**
 * Advance a vessel by `dt` seconds of sim time starting at sim time `t`, by numeric integration.
 * Mutates `vessel`; returns the events that occurred (a shared empty array when there were none —
 * do not modify it).
 *
 * Physics per sub-step (equal sub-steps of at most {@link MAX_SUBSTEP}; classical RK4):
 *  - gravity of the current SOI body only (patched conics, identical to `orbit.predictTrajectory`);
 *  - main drive along ship forward, `throttle · mainThrust`, and RCS translation `translate · rcsThrust`
 *    in ship axes; propellant flows at F/vₑ for each, the mass falls during the step (so a burn delivers
 *    the Tsiolkovsky Δv), and the step is split at the instant the tank runs dry ('flameout');
 *  - drag ½·ρ·|v|·v·dragArea in atmospheres, heating `aeroHeatingPower` against
 *    `heatDissipation` / `heatCapacity` with hull damage above capacity ('overheat', 'destroyed'), and
 *    propellant gain from a fuel scoop in scoopable atmospheres;
 *  - SOI exit / entry and surface impact are located inside the sub-step (to ~1e-7 m) and the frame is
 *    changed at that instant, so the absolute state is continuous ('soi-change', 'impact');
 *  - attitude: see `sasDirection` / the SAS notes above. The SAS direction is evaluated once per call
 *    from `env`; thrust uses the attitude at the start of each sub-step.
 *
 * Stable and accurate for dt up to 10× a 60 Hz frame and far beyond. Above MAX_SUBSTEP · MAX_SUBSTEPS
 * (~136 s) the sub-step grows, up to 1% of the local dynamical time √(r³/μ): fine for a frame hitch,
 * but long intervals belong to `coastVessel`. A docked vessel is kept on its station; a destroyed one
 * is left alone. Non-finite input state is left untouched.
 */
export function stepVessel(model: SystemModel, vessel: Vessel, t: number, dt: number, env: StepEnv = NO_ENV): readonly VesselEvent[] {
  if (!(dt > 0) || !(dt < Infinity) || vessel.destroyed) return NO_EVENTS;
  if (vessel.dockedAt !== null) {
    syncDocked(model, vessel, t + dt);
    coolDown(vessel, dt);
    return NO_EVENTS;
  }
  const rv = vessel.r;
  const vv = vessel.v;
  _x = rv.x;
  _y = rv.y;
  _z = rv.z;
  _vx = vv.x;
  _vy = vv.y;
  _vz = vv.z;
  {
    const r2 = _x * _x + _y * _y + _z * _z;
    const v2 = _vx * _vx + _vy * _vy + _vz * _vz;
    if (!(r2 > 0 && r2 < Infinity && v2 < Infinity)) return NO_EVENTS;
  }
  const st = vessel.stats;
  ensureBands(model);
  // The body context survives between calls; rebuild it only when the vessel is somewhere else.
  if (_bi < 0 || model.bodies[_bi].id !== vessel.soiBodyId) setBody(model, model.indexOf(vessel.soiBodyId));
  _fuel = vessel.fuel > 0 ? vessel.fuel : 0;
  const baseMass = Math.max(1, st.dryMass + (vessel.cargoMass > 0 ? vessel.cargoMass : 0));
  _m = baseMass + _fuel;
  _cdA = st.dragArea > 0 ? st.dragArea : 0;
  _events = null;

  // What the attitude controller is doing during this call.
  const c = vessel.controls;
  const manual = Math.abs(c.pitch) > INPUT_DEADZONE || Math.abs(c.yaw) > INPUT_DEADZONE;
  const mode = vessel.sasMode;
  let hasDir = false;
  let dirX = 0;
  let dirY = 0;
  let dirZ = 0;
  if (mode === 'stability') {
    if (manual) {
      vessel.sasTarget = null;
    } else if (vessel.sasTarget === null) {
      const w = vessel.w;
      if (w.x * w.x + w.y * w.y + w.z * w.z < STABILITY_CAPTURE_RATE * STABILITY_CAPTURE_RATE) vessel.sasTarget = vesselForward(vessel);
    }
  } else if (mode !== 'off') {
    const d = sasDirection(mode, vessel, env, _dir);
    if (d) {
      const s = vessel.sasTarget;
      if (s) {
        s.x = d.x;
        s.y = d.y;
        s.z = d.z;
      } else {
        vessel.sasTarget = { x: d.x, y: d.y, z: d.z };
      }
    }
  }
  if (mode !== 'off' && vessel.sasTarget !== null) {
    const s = vessel.sasTarget;
    dirX = s.x;
    dirY = s.y;
    dirZ = s.z;
    hasDir = dirX * dirX + dirY * dirY + dirZ * dirZ > 1e-24 && Number.isFinite(dirX + dirY + dirZ);
  }

  const n0 = Math.ceil(dt / MAX_SUBSTEP - 1e-9);
  let n = n0 < 1 ? 1 : n0 > MAX_SUBSTEPS ? MAX_SUBSTEPS : n0;
  if (n0 > MAX_SUBSTEPS) {
    // An enormous dt: whatever the budget says, never step coarser than 1% of the local dynamical time.
    const r = Math.sqrt(_x * _x + _y * _y + _z * _z);
    const need = Math.ceil(dt / (0.01 * Math.sqrt((r * r * r) / _mu)));
    if (need > n) n = need < 4e6 ? need : 4e6;
  }
  const h = dt / n;
  const hMin = h / 64;
  let elapsed = 0;
  let guard = 64 * n + 64;

  while (guard-- > 0) {
    let hh = dt - elapsed;
    if (!(hh > 1e-9 * h)) break;
    if (hh > h) hh = h;
    const inAtm0 = _x * _x + _y * _y + _z * _z < _atmTop2;
    setThrust(vessel);
    let flame = false;
    if (_mdot > 0 && _mdot * hh >= _fuel) {
      hh = _fuel / _mdot;
      flame = true;
    }
    let heat0 = 0;
    let scoop0 = 0;
    if (inAtm0) {
      aeroRates(st);
      heat0 = _heatP;
      scoop0 = _scoopR;
      // Dense air at speed makes drag stiff: keep (drag rate constant × step) small.
      if (_lam * hh > 0.5) {
        let lim = 0.5 / _lam;
        if (lim < hMin) lim = hMin;
        if (lim < hh) {
          hh = lim;
          flame = false;
        }
      }
    }
    const t0 = t + elapsed;
    saveState();
    rk4(hh);

    // Did this sub-step cross the surface or an SOI?
    let hs = hh;
    let kind = K_NONE;
    let ci = -1;
    const r2b = _x * _x + _y * _y + _z * _z;
    if (r2b <= _R2) {
      kind = K_IMPACT;
    } else if (r2b > _soi2 && (_x * _vx + _y * _vy + _z * _vz > 0 || r2b > _soi2 * (1 + 2e-6))) {
      kind = K_EXIT;
    } else if (_kids.length > 0) {
      ci = findEntry(model, r2b, t0 + hh);
      if (ci >= 0) kind = K_ENTER;
    }
    if (kind !== K_NONE) {
      const f = refineCrossing(kind, model, ci, t0, hh);
      if (f < 1) {
        hs = f * hh;
        flame = false;
      }
    }

    if (_mdot > 0) {
      const left = _fuel - _mdot * hs;
      _fuel = flame || !(left > 0) ? 0 : left;
    }
    elapsed += hs;
    const tNow = t + elapsed;
    if (flame) pushEvent({ type: 'flameout', t: tNow });

    const inAtm1 = _x * _x + _y * _y + _z * _z < _atmTop2;
    let heat1 = 0;
    let scoop1 = 0;
    if (inAtm1) {
      aeroRates(st);
      heat1 = _heatP;
      scoop1 = _scoopR;
    }
    if (heat0 > 0 || heat1 > 0 || vessel.heat > 0) applyHeat(vessel, 0.5 * (heat0 + heat1), hs, tNow);
    if (scoop0 > 0 || scoop1 > 0) {
      const cap = st.fuelCapacity > 0 ? st.fuelCapacity : 0;
      if (_fuel < cap) {
        _fuel += 0.5 * (scoop0 + scoop1) * hs;
        if (_fuel > cap) _fuel = cap;
      }
    }
    if (inAtm0 !== inAtm1) pushEvent({ type: inAtm1 ? 'atmosphere-enter' : 'atmosphere-exit', t: tNow, bodyId: model.bodies[_bi].id });

    stepAttitude(vessel, hs, manual, hasDir, dirX, dirY, dirZ, _m);
    _m = baseMass + _fuel;

    if (kind === K_IMPACT) {
      const id = model.bodies[_bi].id;
      pushEvent({ type: 'impact', t: tNow, bodyId: id, speed: Math.sqrt(_vx * _vx + _vy * _vy + _vz * _vz) });
      if (!vessel.destroyed) {
        vessel.destroyed = true;
        vessel.hull = 0;
        pushEvent({ type: 'destroyed', t: tNow, cause: 'impact' });
      }
      break;
    }
    if (kind === K_EXIT) {
      const from = _bi;
      const to = model._parent[from];
      const rel = model._rel(from, tNow);
      _x += rel.r.x;
      _y += rel.r.y;
      _z += rel.r.z;
      _vx += rel.v.x;
      _vy += rel.v.y;
      _vz += rel.v.z;
      setBody(model, to);
      vessel.soiBodyId = model.bodies[to].id;
      pushEvent({ type: 'soi-change', t: tNow, fromBodyId: model.bodies[from].id, toBodyId: model.bodies[to].id });
    } else if (kind === K_ENTER) {
      const from = _bi;
      const rel = model._rel(ci, tNow);
      _x -= rel.r.x;
      _y -= rel.r.y;
      _z -= rel.r.z;
      _vx -= rel.v.x;
      _vy -= rel.v.y;
      _vz -= rel.v.z;
      setBody(model, ci);
      vessel.soiBodyId = model.bodies[ci].id;
      pushEvent({ type: 'soi-change', t: tNow, fromBodyId: model.bodies[from].id, toBodyId: model.bodies[ci].id });
    }
    if (vessel.destroyed) break;
  }

  rv.x = _x;
  rv.y = _y;
  rv.z = _z;
  vv.x = _vx;
  vv.y = _vy;
  vv.z = _vz;
  vessel.fuel = _fuel;
  const ev = _events;
  _events = null;
  return ev ?? NO_EVENTS;
}

// ===================================================================================== coastVessel

/**
 * Why `coastVessel` returned.
 *  done       – coasted the whole `dt`
 *  atmosphere – stopped at the top of an atmosphere (or was already inside one): fly it with stepVessel
 *  impact     – hit the surface of an airless body; the vessel is destroyed
 *  destroyed  – the vessel was already destroyed; nothing was done
 *  budget     – ran out of work budget before `dt` was used up (extreme dt); call again from `tReached`
 */
export type CoastStopReason = 'done' | 'atmosphere' | 'impact' | 'destroyed' | 'budget';

/** Result of {@link coastVessel}. */
export interface CoastResult {
  /** Sim time the vessel's state is now valid at, s: `t + dt` unless the coast stopped early. */
  tReached: number;
  stopReason: CoastStopReason;
  /** SOI changes, atmosphere entry and impact, in time order. */
  events: VesselEvent[];
}

const _coastSv = newState();
const ORBIT_SAS: ReadonlySet<SasMode> = new Set<SasMode>(['prograde', 'retrograde', 'normal', 'antinormal', 'radialOut', 'radialIn']);

function setVesselState(vessel: Vessel, sv: StateVector): void {
  vessel.r.x = sv.r.x;
  vessel.r.y = sv.r.y;
  vessel.r.z = sv.r.z;
  vessel.v.x = sv.v.x;
  vessel.v.y = sv.v.y;
  vessel.v.z = sv.v.z;
}

/**
 * Coast a vessel on rails from sim time `t` for up to `dt` seconds: exact Kepler propagation through
 * the same patched-conic sequence `orbit.predictTrajectory` draws, for any `dt` (this is what high
 * warp uses). Mutates `vessel`.
 *
 *  - Every SOI exit / entry inside the interval is taken at its exact time ('soi-change' events); the
 *    encounter search cannot step over one however large `dt` is.
 *  - The coast stops exactly at the top of an atmosphere ('atmosphere', state on the boundary heading
 *    in) and at the surface of an airless body ('impact', vessel destroyed). If the vessel is already
 *    inside an atmosphere nothing happens and `tReached` = `t`.
 *  - Thrust controls are ignored (the caller only coasts when not thrusting, see `maxWarpAllowed`).
 *    Stored heat radiates away; rotation stops; with an orbit-relative SAS mode the ship is left
 *    pointing along that direction at the end.
 *  - A docked vessel follows its station.
 *
 * Cost: one trajectory prediction per call in the normal case (~0.1 ms); allocates the result.
 */
export function coastVessel(model: SystemModel, vessel: Vessel, t: number, dt: number): CoastResult {
  const events: VesselEvent[] = [];
  if (!(dt > 0) || !(dt < Infinity)) return { tReached: t, stopReason: 'done', events };
  const tEnd = t + dt;
  if (vessel.destroyed) return { tReached: tEnd, stopReason: 'destroyed', events };
  if (vessel.dockedAt !== null) {
    syncDocked(model, vessel, tEnd);
    coolDown(vessel, dt);
    return { tReached: tEnd, stopReason: 'done', events };
  }
  if (inAtmosphere(vessel, model.body(vessel.soiBodyId))) return { tReached: t, stopReason: 'atmosphere', events };

  let tNow = t;
  let reason: CoastStopReason = 'budget';
  for (let iter = 0; iter < COAST_MAX_CHUNKS; iter++) {
    const remaining = tEnd - tNow;
    if (!(remaining > 0)) {
      tNow = tEnd;
      reason = 'done';
      break;
    }
    // Limit one prediction to a bounded number of revolutions of the current orbit.
    const body = model.body(vessel.soiBodyId);
    const r = Math.sqrt(vessel.r.x * vessel.r.x + vessel.r.y * vessel.r.y + vessel.r.z * vessel.r.z);
    const alpha = 2 / r - (vessel.v.x * vessel.v.x + vessel.v.y * vessel.v.y + vessel.v.z * vessel.v.z) / body.mu;
    let chunk = remaining;
    if (alpha > 0) {
      const lim = (COAST_CHUNK_PERIODS * 2 * Math.PI) / (Math.sqrt(body.mu) * alpha * Math.sqrt(alpha));
      if (lim < chunk) chunk = lim;
    }
    const last = chunk >= remaining;
    const patches = predictTrajectory(
      model,
      { bodyId: vessel.soiBodyId, sv: vessel, t: tNow },
      { maxPatches: 8, maxDuration: chunk, searchPeriods: 1e15, stopAtAtmosphere: true },
    );
    if (patches.length === 0) {
      // Non-finite state: nothing can be propagated.
      tNow = tEnd;
      reason = 'done';
      break;
    }
    let stop = false;
    for (let i = 0; i < patches.length; i++) {
      const p = patches[i];
      if (p.bodyId !== vessel.soiBodyId) {
        events.push({ type: 'soi-change', t: p.tStart, fromBodyId: vessel.soiBodyId, toBodyId: p.bodyId });
        vessel.soiBodyId = p.bodyId;
      }
      const er = p.endReason;
      if ((er === 'soi-exit' || er === 'soi-enter') && p.nextBodyId !== null) {
        if (i === patches.length - 1) {
          // The prediction ran out of patches on a transition: carry the state across it ourselves.
          model.changeFrame(p.svEnd, p.bodyId, p.nextBodyId, p.tEnd, _coastSv);
          setVesselState(vessel, _coastSv);
          events.push({ type: 'soi-change', t: p.tEnd, fromBodyId: p.bodyId, toBodyId: p.nextBodyId });
          vessel.soiBodyId = p.nextBodyId;
          tNow = p.tEnd;
        }
        continue;
      }
      setVesselState(vessel, p.svEnd);
      tNow = p.tEnd;
      if (er === 'atmosphere') {
        // Land a hair inside the boundary so the hand-over to stepVessel does not report the entry twice.
        const pb = model.body(p.bodyId);
        const top = pb.radius + (pb.atmosphere ? pb.atmosphere.height : 0);
        const rr = Math.sqrt(vessel.r.x * vessel.r.x + vessel.r.y * vessel.r.y + vessel.r.z * vessel.r.z);
        if (rr >= top && rr > 0) {
          const f = (top * (1 - 1e-13)) / rr;
          vessel.r.x *= f;
          vessel.r.y *= f;
          vessel.r.z *= f;
        }
        if (p.tEnd > t) events.push({ type: 'atmosphere-enter', t: p.tEnd, bodyId: p.bodyId });
        reason = 'atmosphere';
        stop = true;
      } else if (er === 'impact') {
        const sp = Math.sqrt(vessel.v.x * vessel.v.x + vessel.v.y * vessel.v.y + vessel.v.z * vessel.v.z);
        events.push({ type: 'impact', t: p.tEnd, bodyId: p.bodyId, speed: sp });
        vessel.destroyed = true;
        vessel.hull = 0;
        events.push({ type: 'destroyed', t: p.tEnd, cause: 'impact' });
        reason = 'impact';
        stop = true;
      } else if (last && er === 'max-time') {
        tNow = tEnd;
        reason = 'done';
        stop = true;
      }
      break;
    }
    if (stop) break;
  }

  const elapsed = tNow - t;
  if (elapsed > 0) {
    coolDown(vessel, elapsed);
    vessel.w.x = 0;
    vessel.w.y = 0;
    vessel.w.z = 0;
    if (!vessel.destroyed && ORBIT_SAS.has(vessel.sasMode)) {
      const d = sasDirection(vessel.sasMode, vessel, NO_ENV, _dir);
      if (d) {
        const q = qNormalize(qMul(qFromTo(vesselForward(vessel), d), vessel.q));
        vessel.q.x = q.x;
        vessel.q.y = q.y;
        vessel.q.z = q.z;
        vessel.q.w = q.w;
        vessel.sasTarget = { x: d.x, y: d.y, z: d.z };
      }
    }
  }
  return { tReached: tNow, stopReason: reason, events };
}

// ===================================================================================== warp

/** The next thing on a coasting vessel's trajectory that ends the current conic. */
export interface TrajectoryEvent {
  /** Sim time of the event, s. */
  time: number;
  kind: 'soi-exit' | 'soi-enter' | 'impact' | 'atmosphere';
  /** The body concerned: the SOI being entered or left, or the body hit. */
  bodyId: string;
}

/**
 * The next SOI change, atmosphere entry or impact on the vessel's coasting trajectory after sim time
 * `t`, looking at most `horizon` seconds ahead (default 100 days) and, on a closed orbit, one
 * revolution; null if there is none (or the vessel is docked, destroyed or inside an atmosphere, where
 * a vacuum prediction means nothing). Costs one single-patch trajectory prediction (~0.05 ms).
 */
export function nextTrajectoryEvent(model: SystemModel, vessel: Vessel, t: number, horizon = 100 * DAY): TrajectoryEvent | null {
  if (vessel.destroyed || vessel.dockedAt !== null) return null;
  if (inAtmosphere(vessel, model.body(vessel.soiBodyId))) return null;
  const patches = predictTrajectory(model, { bodyId: vessel.soiBodyId, sv: vessel, t }, { maxPatches: 1, maxDuration: horizon });
  if (patches.length === 0) return null;
  const p = patches[0];
  if (p.bodyId !== vessel.soiBodyId) {
    // The state already belongs to another frame: the change is due now.
    const entering = model.parent(p.bodyId)?.id === vessel.soiBodyId;
    return { time: t, kind: entering ? 'soi-enter' : 'soi-exit', bodyId: entering ? p.bodyId : vessel.soiBodyId };
  }
  switch (p.endReason) {
    case 'soi-exit':
      return { time: p.tEnd, kind: 'soi-exit', bodyId: p.bodyId };
    case 'soi-enter':
      return { time: p.tEnd, kind: 'soi-enter', bodyId: p.nextBodyId ?? p.bodyId };
    case 'impact':
      return { time: p.tEnd, kind: 'impact', bodyId: p.bodyId };
    case 'atmosphere':
      return { time: p.tEnd, kind: 'atmosphere', bodyId: p.bodyId };
    default:
      return null;
  }
}

/** What limits time warp besides the vessel's own situation. */
export interface WarpContext {
  /** Sim time (s) the game must not warp past: the next manoeuvre-node burn start, a deadline, an arrival… */
  nextStopTime?: number;
  /** Hard cap on the warp factor from other systems (combat, traffic control, a nearby contact…). */
  cap?: number;
  /** Real seconds of warning to keep before an event at the allowed warp. Default {@link WARP_EVENT_LEAD}. */
  lead?: number;
  /** How far ahead to look for trajectory events, s. Default: just far enough for the highest warp level. */
  horizon?: number;
}

const NO_WARP_CTX: WarpContext = Object.freeze({});

/**
 * Seconds of sim time from `t` until the next event warp must not run past: the earlier of
 * `ctx.nextStopTime` and the next SOI change / atmosphere entry / impact on the coasting trajectory
 * (see {@link nextTrajectoryEvent}; not evaluated while thrusting, where the trajectory is changing).
 * Infinity if nothing is coming within the horizon; never negative.
 */
export function timeToNextEvent(model: SystemModel, vessel: Vessel, t: number, ctx: WarpContext = NO_WARP_CTX): number {
  let dt = Infinity;
  if (ctx.nextStopTime !== undefined && ctx.nextStopTime < Infinity) dt = ctx.nextStopTime - t;
  if (!isThrusting(vessel)) {
    const ev = nextTrajectoryEvent(model, vessel, t, ctx.horizon ?? 100 * DAY);
    if (ev && ev.time - t < dt) dt = ev.time - t;
  }
  return dt > 0 ? dt : 0;
}

/**
 * The highest entry of {@link WARP_LEVELS} the vessel may use at sim time `t`.
 *
 *  - Destroyed: 1. Docked: anything (subject to `ctx`).
 *  - Thrusting (main drive or RCS with propellant) or inside an atmosphere: at most
 *    {@link PHYSICS_WARP_MAX} — those are flown with `stepVessel`.
 *  - Rails warp needs altitude: level i requires altitude >= WARP_MIN_ALTITUDE_RADII[i] body radii, and
 *    the vessel must not be about to descend below that altitude.
 *  - Never past the next event: a factor L is allowed only while the next event (see `timeToNextEvent`,
 *    plus the altitude limit above) is more than `L · lead` sim seconds away, so warp steps down as an
 *    event approaches and a frame can never jump over one (lead >= the real frame time).
 *
 * Cheap enough to call every frame (one single-patch prediction when coasting).
 */
export function maxWarpAllowed(model: SystemModel, vessel: Vessel, t: number, ctx: WarpContext = NO_WARP_CTX): number {
  if (vessel.destroyed) return 1;
  const top = WARP_LEVELS.length - 1;
  const lead = ctx.lead !== undefined && ctx.lead > 0 ? ctx.lead : WARP_EVENT_LEAD;
  let cap = ctx.cap !== undefined && ctx.cap >= 1 ? ctx.cap : WARP_LEVELS[top];
  const tStop = ctx.nextStopTime !== undefined ? ctx.nextStopTime - t : Infinity;
  if (vessel.dockedAt !== null) {
    for (let i = top; i > 0; i--) {
      const L = WARP_LEVELS[i];
      if (L <= cap && L * lead <= tStop) return L;
    }
    return 1;
  }
  const body = model.body(vessel.soiBodyId);
  const atmH = body.atmosphere ? body.atmosphere.height : 0;
  const alt = altitudeOf(vessel, body);
  const physicalOnly = isThrusting(vessel) || (atmH > 0 && alt < atmH);
  if (physicalOnly && cap > PHYSICS_WARP_MAX) cap = PHYSICS_WARP_MAX;
  let tte = tStop;
  if (!physicalOnly) {
    const ev = nextTrajectoryEvent(model, vessel, t, ctx.horizon ?? WARP_LEVELS[top] * lead * 1.01);
    if (ev && ev.time - t < tte) tte = ev.time - t;
  }
  for (let i = top; i > 0; i--) {
    const L = WARP_LEVELS[i];
    if (L > cap || L * lead > tte) continue;
    if (L > PHYSICS_WARP_MAX) {
      const minAlt = Math.max(WARP_MIN_ALTITUDE_RADII[i] * body.radius, atmH);
      if (alt < minAlt) continue;
      if (minAlt > 0 && L * lead > timeToRadius(vessel, body.mu, body.radius + minAlt, 'inward')) continue;
    }
    return L;
  }
  return 1;
}

// ===================================================================================== relative motion

/** Anything with a state relative to a body: a Vessel, or the result of `stationFramedState` / `orbiterFramedState`. */
export interface FramedState {
  /** Body the state is relative to. */
  soiBodyId: string;
  /** m, relative to that body's centre, system axes. */
  r: V3;
  /** m/s, relative to that body. */
  v: V3;
}

/** A fresh framed state (zero vectors). */
export const newFramedState = (bodyId = ''): FramedState => ({ soiBodyId: bodyId, r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } });

/** State of a station at sim time `t`, relative to the body it orbits, as a {@link FramedState}. */
export function stationFramedState(model: SystemModel, stationId: string, t: number, out: FramedState = newFramedState()): FramedState {
  model.stationState(stationId, t, out);
  out.soiBodyId = model.station(stationId).parentBodyId;
  return out;
}

/** State of anything on the Kepler orbit `orbit` around `parentBodyId` at sim time `t`, as a {@link FramedState}. */
export function orbiterFramedState(
  model: SystemModel,
  orbit: OrbitElements,
  parentBodyId: string,
  t: number,
  out: FramedState = newFramedState(),
): FramedState {
  model.orbiterState(orbit, parentBodyId, t, out);
  out.soiBodyId = parentBodyId;
  return out;
}

/** Motion of a target relative to an observer, in system (world) axes. */
export interface RelativeMotion {
  /** Target position minus observer position, m. */
  r: V3;
  /** Target velocity minus observer velocity, m/s. */
  v: V3;
  /** |r|, m. */
  distance: number;
  /** |v|, m/s. */
  speed: number;
  /** Rate at which the distance shrinks, m/s (negative when opening). */
  closingSpeed: number;
  /** Time (s, >= 0) to the closest approach if both kept their current velocities; 0 when already opening. */
  timeToClosest: number;
  /** Separation (m) at that closest approach. */
  missDistance: number;
}

/** A fresh {@link RelativeMotion} (all zero). */
export const newRelativeMotion = (): RelativeMotion => ({
  r: { x: 0, y: 0, z: 0 },
  v: { x: 0, y: 0, z: 0 },
  distance: 0,
  speed: 0,
  closingSpeed: 0,
  timeToClosest: 0,
  missDistance: 0,
});

const _relA = newState();
const _relB = newState();

/**
 * Motion of `to` relative to `from` at sim time `t` (both states must be valid at `t`). They may be in
 * the same SOI frame or in different ones: different frames are bridged through the absolute states
 * of their bodies. `timeToClosest` / `missDistance` are the straight-line (constant relative velocity)
 * estimate — right for the last kilometres of a rendezvous; use `orbit.closestApproach` for whole orbits.
 * Writes into `out` (no allocation) and returns it.
 */
export function relativeMotion(model: SystemModel, from: FramedState, to: FramedState, t: number, out: RelativeMotion = newRelativeMotion()): RelativeMotion {
  let rx = to.r.x - from.r.x;
  let ry = to.r.y - from.r.y;
  let rz = to.r.z - from.r.z;
  let vx = to.v.x - from.v.x;
  let vy = to.v.y - from.v.y;
  let vz = to.v.z - from.v.z;
  if (to.soiBodyId !== from.soiBodyId) {
    const a = model.bodyAbsState(from.soiBodyId, t, _relA);
    const b = model.bodyAbsState(to.soiBodyId, t, _relB);
    rx += b.r.x - a.r.x;
    ry += b.r.y - a.r.y;
    rz += b.r.z - a.r.z;
    vx += b.v.x - a.v.x;
    vy += b.v.y - a.v.y;
    vz += b.v.z - a.v.z;
  }
  out.r.x = rx;
  out.r.y = ry;
  out.r.z = rz;
  out.v.x = vx;
  out.v.y = vy;
  out.v.z = vz;
  const d = Math.sqrt(rx * rx + ry * ry + rz * rz);
  const v2 = vx * vx + vy * vy + vz * vz;
  const rdv = rx * vx + ry * vy + rz * vz;
  out.distance = d;
  out.speed = Math.sqrt(v2);
  out.closingSpeed = d > 0 ? -rdv / d : 0;
  const tca = rdv < 0 && v2 > 0 ? -rdv / v2 : 0;
  out.timeToClosest = tca;
  const mx = rx + vx * tca;
  const my = ry + vy * tca;
  const mz = rz + vz * tca;
  out.missDistance = Math.sqrt(mx * mx + my * my + mz * mz);
  return out;
}

// ===================================================================================== station collisions

/**
 * Inertial attitude of a station (station-local -> world): local +Y along the orbit normal, local +X
 * toward the orbit's periapsis direction (the reference direction of `argp`; for the zero-element
 * orbit this is the identity). Fixed for the life of the station — stations do not rotate.
 */
export function stationAttitude(orbit: OrbitElements): Quat {
  const ci = Math.cos(orbit.i);
  const si = Math.sin(orbit.i);
  const cO = Math.cos(orbit.lan);
  const sO = Math.sin(orbit.lan);
  const cw = Math.cos(orbit.argp);
  const sw = Math.sin(orbit.argp);
  const xAxis: V3 = { x: cO * cw - sO * sw * ci, y: sw * si, z: -(sO * cw + cO * sw * ci) };
  const yAxis = orbitNormalFromElements(orbit);
  // qLook: local -Z -> forward, local +Y -> up; so forward = -(X × Y).
  return qLook(neg(cross(xAxis, yAxis)), yAxis);
}

/** Express a world-axes vector (e.g. ship position minus station position) in station-local axes: conj(q) · v. */
export function toStationLocal(v: V3, stationQ: Quat, out: V3 = { x: 0, y: 0, z: 0 }): V3 {
  const qx = -stationQ.x;
  const qy = -stationQ.y;
  const qz = -stationQ.z;
  const qw = stationQ.w;
  const tx = 2 * (qy * v.z - qz * v.y);
  const ty = 2 * (qz * v.x - qx * v.z);
  const tz = 2 * (qx * v.y - qy * v.x);
  const x = v.x + qw * tx + (qy * tz - qz * ty);
  const y = v.y + qw * ty + (qz * tx - qx * tz);
  const z = v.z + qw * tz + (qx * ty - qy * tx);
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

/** Express a station-local vector in world axes: q · v. */
export function fromStationLocal(v: V3, stationQ: Quat, out: V3 = { x: 0, y: 0, z: 0 }): V3 {
  const qx = stationQ.x;
  const qy = stationQ.y;
  const qz = stationQ.z;
  const qw = stationQ.w;
  const tx = 2 * (qy * v.z - qz * v.y);
  const ty = 2 * (qz * v.x - qx * v.z);
  const tz = 2 * (qx * v.y - qy * v.x);
  const x = v.x + qw * tx + (qy * tz - qz * ty);
  const y = v.y + qw * ty + (qz * tx - qx * tz);
  const z = v.z + qw * tz + (qx * ty - qy * tx);
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

/** A contact between a ship's collision sphere and a station collider, in station-local coordinates. */
export interface ColliderContact {
  /** Penetration depth, m (> 0 when overlapping; negative = clearance when reported by `colliderDistance`). */
  depth: number;
  /** Unit vector from the collider toward the ship centre: push the ship along it by `depth` to separate. */
  normal: V3;
  /** Point on the collider surface nearest the ship centre, station-local m. */
  point: V3;
  /** Index of the collider in the array given to `stationContact` (0 for a single test). */
  index: number;
}

/** A fresh {@link ColliderContact}. */
export const newColliderContact = (): ColliderContact => ({ depth: 0, normal: { x: 0, y: 1, z: 0 }, point: { x: 0, y: 0, z: 0 }, index: 0 });

/**
 * Geometry between a sphere (centre `center`, station-local metres, radius `radius`) and one collider
 * (sphere, or capsule = segment a–b swept by `radius`). Fills `out` (depth may be negative: clearance)
 * and returns true when they overlap (depth > 0). No allocation.
 */
export function sphereColliderContact(center: V3, radius: number, collider: StationCollider, out: ColliderContact): boolean {
  const a = collider.a;
  let qx = a.x;
  let qy = a.y;
  let qz = a.z;
  let axx = 0;
  let axy = 0;
  let axz = 0;
  const b = collider.kind === 'capsule' ? collider.b : undefined;
  if (b) {
    axx = b.x - a.x;
    axy = b.y - a.y;
    axz = b.z - a.z;
    const l2 = axx * axx + axy * axy + axz * axz;
    if (l2 > 0) {
      let u = ((center.x - a.x) * axx + (center.y - a.y) * axy + (center.z - a.z) * axz) / l2;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      qx += axx * u;
      qy += axy * u;
      qz += axz * u;
    }
  }
  let nx = center.x - qx;
  let ny = center.y - qy;
  let nz = center.z - qz;
  const d = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (d > 1e-9) {
    nx /= d;
    ny /= d;
    nz /= d;
  } else {
    // Centre on the collider's axis: any direction perpendicular to the axis (or +Y for a sphere).
    const l = Math.sqrt(axx * axx + axy * axy + axz * axz);
    if (l > 0) {
      // Perpendicular to the axis, built from the world axis least aligned with it.
      const ux = axx / l;
      const uy = axy / l;
      const uz = axz / l;
      if (Math.abs(uy) < 0.9) {
        nx = -ux * uy;
        ny = 1 - uy * uy;
        nz = -uz * uy;
      } else {
        nx = 1 - ux * ux;
        ny = -uy * ux;
        nz = -uz * ux;
      }
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= nl;
      ny /= nl;
      nz /= nl;
    } else {
      nx = 0;
      ny = 1;
      nz = 0;
    }
  }
  out.depth = radius + collider.radius - d;
  out.normal.x = nx;
  out.normal.y = ny;
  out.normal.z = nz;
  out.point.x = qx + nx * collider.radius;
  out.point.y = qy + ny * collider.radius;
  out.point.z = qz + nz * collider.radius;
  out.index = 0;
  return out.depth > 0;
}

const _contact = newColliderContact();

/**
 * Test a sphere (centre in station-local metres, radius m) against all of a station's colliders.
 * Fills `out` with the deepest contact — or, when nothing overlaps, with the nearest collider (depth
 * negative = clearance) — and returns true when there is an overlap. With no colliders `out.depth`
 * is -Infinity. No allocation.
 */
export function stationContact(center: V3, radius: number, colliders: readonly StationCollider[], out: ColliderContact = newColliderContact()): boolean {
  out.depth = -Infinity;
  for (let i = 0; i < colliders.length; i++) {
    sphereColliderContact(center, radius, colliders[i], _contact);
    if (_contact.depth > out.depth) {
      out.depth = _contact.depth;
      out.normal.x = _contact.normal.x;
      out.normal.y = _contact.normal.y;
      out.normal.z = _contact.normal.z;
      out.point.x = _contact.point.x;
      out.point.y = _contact.point.y;
      out.point.z = _contact.point.z;
      out.index = i;
    }
  }
  return out.depth > 0;
}
