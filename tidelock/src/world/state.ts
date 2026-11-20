// The state of the physical world: plain JSON-serialisable data, nothing else. See docs/ARCHITECTURE.md §3.
// Everything is SI. Typed-array scratch and the ephemeris cache live outside this state (ephemeris.ts).

import type { DockingPortDef, PadSize, Quat, StationCollider, V3 } from '../core/types';
import { createEventRing, type EventRing } from './events';
import type { EngineDef, JetDef, JetTable } from './jets';

export interface Atmosphere {
  /** Density at the surface, kg/m³. */
  surfaceDensity: number;
  /** Exponential scale height, m. */
  scaleHeight: number;
  /** Altitude of the top (density exactly 0 above it), m. */
  height: number;
}

/** A gravitating body. `r`, `v` and `spinAngle` are valid at `world.t` (refreshed by every advance()). */
export interface Body {
  id: string;
  name: string;
  /** Index of the parent body in `world.bodies`, -1 for the primary star. Hierarchy only: gravity is n-body. */
  parent: number;
  mass: number;
  /** G·mass, m³/s². */
  mu: number;
  radius: number;
  /** True when there is ground to stand on (false for stars and giants). */
  solid: boolean;
  /** Hill radius about the parent, m (1e99 for the star). Used only to choose a craft's integration frame. */
  hill: number;
  /** System-barycentric position and velocity, inertial axes. */
  r: V3;
  v: V3;
  /** Unit spin axis, spin rate (rad/s) and rotation angle (rad) at t = 0 and at world.t. */
  spinAxis: V3;
  spinRate: number;
  spinAngle0: number;
  spinAngle: number;
  atmosphere: Atmosphere | null;
}

export type CraftKind = 'ship' | 'station' | 'debris';

/** A rigid body: ship, station or debris. Its own gravity is neglected. */
export interface Craft {
  id: string;
  name: string;
  kind: CraftKind;
  shipVisual: string | null;
  stationVisual: string | null;
  visualSeed: number;
  /** Size class for docking ports. */
  pad: PadSize;

  dryMass: number;
  propellant: number;
  propellantCapacity: number;
  /** Principal moments of inertia per unit mass, m² (I = total mass · gyration), craft-local axes. */
  gyration: V3;
  /** Bounding / collision sphere radius, m. */
  radius: number;

  /** Main drive thrust at full throttle (N, along local -Z) and exhaust velocity (m/s). */
  mainThrust: number;
  exhaustVelocity: number;
  /** RCS translation thrust per axis (N) and its exhaust velocity (m/s). */
  rcsThrust: number;
  rcsExhaustVelocity: number;
  /** Largest torque of the attitude system about each local axis, N·m. */
  maxTorque: V3;

  /** Cd·A, m². */
  dragArea: number;
  /** Area that takes aerodynamic heating, m² (drag area / heat-shield factor). */
  heatArea: number;
  /** Heat the hull can store before it is destroyed, J, and loss rate at full store, W. */
  heatCapacity: number;
  heatDissipation: number;
  /** Aerodynamic deceleration that breaks the hull, m/s². */
  maxLoad: number;
  /** Impact energy that destroys the hull, J. */
  hullStrength: number;

  /** Collision shapes in craft-local metres (stations). Ships collide with their hull compound (data/hullColliders.ts). */
  colliders: StationCollider[];
  /** Docking ports offered to others (stations). */
  ports: DockingPortDef[];
  /** This craft's own docking collar: local position and outward axis. */
  dockPort: { pos: V3; dir: V3 } | null;

  /** Index of the primary body: the origin of the coordinates this craft is integrated in. Not physics. */
  primary: number;
  /** Position and velocity relative to the primary body, inertial axes — the integrated state of record. */
  rel: V3;
  relV: V3;
  /** System-barycentric position and velocity at world.t (derived). */
  r: V3;
  v: V3;
  /** Attitude: craft-local -> world. */
  q: Quat;
  /** Angular velocity in craft-local axes, rad/s. */
  w: V3;
  /** Stored heat, J. */
  heat: number;
  /** Hull integrity 0..1. */
  hull: number;
  /** Proper (non-gravitational) acceleration during the last step, m/s². */
  load: number;

  /** Commands: main throttle 0..1, RCS translation and torque demand per local axis -1..1, latch armed. */
  throttle: number;
  rcs: V3;
  torque: V3;
  dockingArmed: boolean;

  inAtmosphere: boolean;
  destroyed: boolean;
  destroyedBy: string;
  /** Station craft id / port id while latched. */
  dockedTo: string | null;
  dockPortId: string | null;
  /** Body id while resting on a surface. */
  landedOn: string | null;

  // ---- wave 1 (docs/SIMULATION.md §1.4). Saved; loader defaults in world.ts migrateCraft. ----------------------
  // `propellant` / `propellantCapacity` above are the MAIN (LH2) pool; the RCS has its own hydrazine pool here.
  /** Duty each RCS jet actually applied over the last step, 0..1, JetDef order (0 when landed, docked or dry). W1-B writes. */
  jetDuty: number[];
  /** Thrust state F_s of each main engine, N, and its ignition timer, s (jets.ts ENGINE_UNLIT = −1: not lit). W1-B writes. */
  engineThrust: number[];
  engineTimer: number[];
  /** RCS (hydrazine blowdown) pool and its capacity, kg. Counted in craftMass. */
  rcsPropellant: number;
  rcsPropellantCapacity: number;
  /**
   * The applied-force ledger, craft axes: ∫F·dt (N·s) and ∫τ·dt (N·m·s) of the proper (non-gravitational) force and
   * torque actually applied, and the time accumulated (s), since the session last consumed it (dynamics.ts
   * consumeLedger, once per tick). W1-B writes.
   */
  fAcc: V3;
  tauAcc: V3;
  accT: number;
  /** Impulsive Δv (m/s) and Δω (rad/s) from contacts, latch and undock since the last consumption, craft axes. */
  dvImpulse: V3;
  dwImpulse: V3;
  /** Air-relative velocity u = v_rel − ω_body × r_rel, inertial axes, m/s (zero outside air). W1-B writes per forced step. */
  airVel: V3;
  /** Instantaneous stagnation heat flux, W/m². W1-B writes per forced step. */
  heatFlux: number;
  /** Sim time at which a settled hold must wake, s (+∞ while awake; saved as null). W1-B writes. */
  holdWakeT: number;

  // ---- wave 1, rebuilt at load and never saved (setup.ts buildThrusters; saveWorld strips DERIVED_CRAFT_KEYS) ----
  /** RCS jets {pos, dir (exhaust), thrust, ve} from the hull layout. */
  jets: JetDef[];
  /** Main engines {pos, dir, maxThrust, ve, tauUp, tauDown, delay, minThrottle}. */
  engines: EngineDef[];
  /** The 12 × N allocation table (jetAlloc.table). */
  jetTable: Float64Array;
  /** The whole allocation record the table belongs to (geometry, authority, cost, tank). */
  jetAlloc: JetTable;
  /** Per-step input scratch of jets.ts (makeStepIn). */
  jetIn: Float64Array;
}

/** Craft fields that are derived at load and must never reach a save. */
export const DERIVED_CRAFT_KEYS: readonly string[] = ['jets', 'engines', 'jetTable', 'jetAlloc', 'jetIn'];

/** A constraint created and released by physical conditions: a docking latch or resting contact. */
export interface Joint {
  kind: 'dock' | 'landed';
  craftId: string;
  /** Station craft id (dock) or body id (landed). */
  otherId: string;
  portId: string;
  /** Pose of the craft in the other's frame (station-local axes, or the body's rotating frame at angle 0). */
  localPos: V3;
  localQ: Quat;
}

export type WorldEvent =
  | { type: 'docked'; t: number; craftId: string; stationId: string; portId: string }
  | { type: 'undocked'; t: number; craftId: string; stationId: string }
  | { type: 'impact'; t: number; craftId: string; with: string; speed: number }
  | { type: 'destroyed'; t: number; craftId: string; cause: string }
  | { type: 'atmosphere'; t: number; craftId: string; bodyId: string; entered: boolean }
  | { type: 'primaryChanged'; t: number; craftId: string; from: string; to: string }
  | { type: 'landed'; t: number; craftId: string; bodyId: string }
  | { type: 'liftoff'; t: number; craftId: string; bodyId: string };

export interface World {
  version: 1;
  /** Sim seconds since the epoch. Under the session's fixed tick it is always tick / 120 (never accumulated). */
  t: number;
  /**
   * The fixed-tick index (SIMULATION.md §1.3: Q = 1/120 s; world.ts worldTick, advanceTicks). Saved. Absent in a
   * world from createWorld and in older saves: worldTick() derives it as the last whole tick at or before t.
   */
  tick?: number;
  /** Fixed step of the body integrator, s. */
  h: number;
  /** An integration node of the bodies at or before `t`: step index and packed [positions 3n][velocities 3n]. */
  ephStep: number;
  ephState: number[];
  bodies: Body[];
  craft: Craft[];
  joints: Joint[];
  /** Queue of things that happened; drained by the owner with drainEvents(). */
  events: WorldEvent[];
  /**
   * Persistent contact manifolds (warm-start impulses) per ordered pair of craft ids, written by saveWorld and read
   * back on the first contact pass after a load (contact.ts). Absent in older saves (costs one step of warm start).
   */
  contacts?: { a: string; b: string; m: number[] }[];
}

export function pushEvent(world: World, e: WorldEvent): void {
  world.events.push(e);
}

export function findCraft(world: World, id: string): Craft | null {
  const cs = world.craft;
  for (let i = 0; i < cs.length; i++) if (cs[i].id === id) return cs[i];
  return null;
}

export function bodyIndex(world: World, id: string): number {
  const bs = world.bodies;
  for (let i = 0; i < bs.length; i++) if (bs[i].id === id) return i;
  return -1;
}

/** Total mass: dry structure, the main pool and the RCS pool, kg. */
export const craftMass = (c: Craft): number => c.dryMass + c.propellant + c.rcsPropellant;

const rings = new WeakMap<World, EventRing>();
/**
 * The world's event ring (src/world/events.ts, SIMULATION.md §1.4): output only, never saved, never read by the
 * world. Writers (dynamics' jet edges, contact, props, crew, devices) emit into it; the session drains it once per
 * frame (Session.drainEvents). A loaded world starts with an empty ring.
 */
export function eventRing(world: World): EventRing {
  let r = rings.get(world);
  if (!r) { r = createEventRing(); rings.set(world, r); }
  return r;
}

/** Mark a craft destroyed (it stays in the world as inert wreckage under the same laws). */
export function destroyCraft(world: World, c: Craft, cause: string, t: number): void {
  if (c.destroyed) return;
  c.destroyed = true;
  c.destroyedBy = cause;
  c.hull = 0;
  c.throttle = 0;
  c.rcs.x = c.rcs.y = c.rcs.z = 0;
  c.torque.x = c.torque.y = c.torque.z = 0;
  c.dockingArmed = false;
  pushEvent(world, { type: 'destroyed', t, craftId: c.id, cause });
}
