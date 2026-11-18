// The state of the physical world: plain JSON-serialisable data, nothing else. See docs/ARCHITECTURE.md §3.
// Everything is SI. Typed-array scratch and the ephemeris cache live outside this state (ephemeris.ts).

import type { DockingPortDef, PadSize, Quat, StationCollider, V3 } from '../core/types';

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

  /** Collision shapes in craft-local metres (stations). Ships collide as their bounding sphere. */
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
}

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
  /** Sim seconds since the epoch. */
  t: number;
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

export const craftMass = (c: Craft): number => c.dryMass + c.propellant;

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
