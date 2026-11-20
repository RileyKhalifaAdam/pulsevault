// Initial conditions: a SystemDef's hierarchy of Kepler elements becomes barycentric state vectors exactly
// once, at t = 0. After that nothing in the world knows about ellipses.

import type { DockingPortDef, PadSize, Quat, StationCollider, SystemDef, V3, VesselStats } from '../core/types';
import { cross, norm, qFromTo, qFromAxisAngle, qMul, qRotate, Y_AXIS, X_AXIS, dot } from '../core/vec';
import { elementsToState } from '../sim/orbit';
import { STATION_LAYOUTS } from '../data/stationLayouts';
import { DEFAULT_MAX_LOAD } from './atmosphere';
import { compoundGyration, hullCompound } from './compound';
import { bodyIndex, type Body, type Craft, type CraftKind, type World } from './state';

/** Body steps per shortest orbital period. */
export const STEPS_PER_SHORTEST_ORBIT = 200;
/** Station mass, kg. */
export const STATION_MASS = 1e9;

export interface CraftDef {
  id: string;
  name: string;
  kind?: CraftKind;
  shipVisual?: string | null;
  stationVisual?: string | null;
  visualSeed?: number;
  pad?: PadSize;
  dryMass: number;
  propellant?: number;
  propellantCapacity?: number;
  /** Bounding radius, m. */
  radius: number;
  /** Box extents (x = width, y = height, z = length), m: principal inertia of a uniform box. Default: a sphere. */
  size?: V3;
  mainThrust?: number;
  exhaustVelocity?: number;
  rcsThrust?: number;
  rcsExhaustVelocity?: number;
  /** Peak angular acceleration at dry mass, rad/s² (sets the max torque per axis). */
  maxAngularAccel?: number;
  dragArea?: number;
  heatShield?: number;
  heatCapacity?: number;
  heatDissipation?: number;
  maxLoad?: number;
  hullStrength?: number;
  colliders?: StationCollider[];
  ports?: DockingPortDef[];
  dockPort?: { pos: V3; dir: V3 } | null;
  /** Body the initial state is relative to, and that state (inertial axes, m and m/s). */
  primaryId: string;
  r: V3;
  v: V3;
  q?: Quat;
  w?: V3;
}

const v3 = (a: V3): V3 => ({ x: a.x, y: a.y, z: a.z });

/** Rotation taking body-local axes at spin angle 0 (+Y = spin axis, +X = prime meridian) to world axes. */
export function spinBase(axis: V3): Quat {
  return qFromTo(Y_AXIS, axis);
}

/** Orientation of a body at its current spin angle: body-local (+Y spin axis, +X prime meridian) -> world. */
export function bodyOrientation(b: Body): Quat {
  return qMul(qFromAxisAngle(b.spinAxis, b.spinAngle), spinBase(b.spinAxis));
}

/** Position and velocity of a circular prograde orbit of radius `r` in the reference plane at phase `phase`. */
export function circularState(mu: number, r: number, phase = 0): { r: V3; v: V3 } {
  const vc = Math.sqrt(mu / r), c = Math.cos(phase), s = Math.sin(phase);
  return { r: { x: r * c, y: 0, z: -r * s }, v: { x: -vc * s, y: 0, z: -vc * c } };
}

/** Add a craft to the world. Its state is given relative to `def.primaryId` in inertial axes. */
export function addCraft(world: World, def: CraftDef): Craft {
  const p = bodyIndex(world, def.primaryId);
  if (p < 0) throw new Error(`addCraft: unknown body ${def.primaryId}`);
  const b = world.bodies[p];
  const R = def.radius;
  const s = def.size;
  // the hull's own shape (its collision compound as a uniform solid) when it has one, else the layout's box
  const hull = (def.kind ?? 'ship') === 'ship' ? hullCompound(def.shipVisual ?? null) : null;
  const gyration = hull
    ? compoundGyration(hull, { x: 0, y: 0, z: 0 })
    : s
      ? { x: (s.y * s.y + s.z * s.z) / 12, y: (s.x * s.x + s.z * s.z) / 12, z: (s.x * s.x + s.y * s.y) / 12 }
      : { x: 0.4 * R * R, y: 0.4 * R * R, z: 0.4 * R * R };
  const alpha = def.maxAngularAccel ?? 0;
  const dragArea = def.dragArea ?? 0;
  const c: Craft = {
    id: def.id,
    name: def.name,
    kind: def.kind ?? 'ship',
    shipVisual: def.shipVisual ?? null,
    stationVisual: def.stationVisual ?? null,
    visualSeed: def.visualSeed ?? 0,
    pad: def.pad ?? 'S',
    dryMass: def.dryMass,
    propellant: def.propellant ?? 0,
    propellantCapacity: def.propellantCapacity ?? def.propellant ?? 0,
    gyration,
    radius: R,
    mainThrust: def.mainThrust ?? 0,
    exhaustVelocity: def.exhaustVelocity ?? 1,
    rcsThrust: def.rcsThrust ?? 0,
    rcsExhaustVelocity: def.rcsExhaustVelocity ?? 1,
    maxTorque: { x: alpha * def.dryMass * gyration.x, y: alpha * def.dryMass * gyration.y, z: alpha * def.dryMass * gyration.z },
    dragArea,
    heatArea: dragArea / (def.heatShield && def.heatShield > 0 ? def.heatShield : 1),
    heatCapacity: def.heatCapacity ?? 2.4e5 * def.dryMass,
    heatDissipation: def.heatDissipation ?? 0,
    maxLoad: def.maxLoad ?? DEFAULT_MAX_LOAD,
    hullStrength: def.hullStrength ?? 0.5 * def.dryMass * 25 * 25,
    colliders: def.colliders ?? [],
    ports: def.ports ?? [],
    dockPort: def.dockPort ?? null,
    primary: p,
    rel: v3(def.r),
    relV: v3(def.v),
    r: { x: b.r.x + def.r.x, y: b.r.y + def.r.y, z: b.r.z + def.r.z },
    v: { x: b.v.x + def.v.x, y: b.v.y + def.v.y, z: b.v.z + def.v.z },
    q: def.q ? { x: def.q.x, y: def.q.y, z: def.q.z, w: def.q.w } : { x: 0, y: 0, z: 0, w: 1 },
    w: def.w ? v3(def.w) : { x: 0, y: 0, z: 0 },
    heat: 0,
    hull: 1,
    load: 0,
    throttle: 0,
    rcs: { x: 0, y: 0, z: 0 },
    torque: { x: 0, y: 0, z: 0 },
    dockingArmed: false,
    inAtmosphere: false,
    destroyed: false,
    destroyedBy: '',
    dockedTo: null,
    dockPortId: null,
    landedOn: null,
  };
  world.craft.push(c);
  return c;
}

/** Physical description of a ship from its derived statistics and (optionally) its hull layout. */
export function shipDef(
  id: string,
  name: string,
  stats: VesselStats,
  layout: { id?: string; length: number; width: number; height: number; radius: number; dockingPort?: { pos: V3; dir: V3 } } | null,
  where: { primaryId: string; r: V3; v: V3; q?: Quat; pad?: PadSize },
): CraftDef {
  return {
    id,
    name,
    kind: 'ship',
    shipVisual: layout?.id ?? null,
    dryMass: stats.dryMass,
    propellant: stats.fuelCapacity,
    propellantCapacity: stats.fuelCapacity,
    radius: layout?.radius ?? stats.radius,
    size: layout ? { x: layout.width, y: layout.height, z: layout.length } : undefined,
    mainThrust: stats.mainThrust,
    exhaustVelocity: stats.exhaustVelocity,
    rcsThrust: stats.rcsThrust,
    rcsExhaustVelocity: stats.rcsExhaustVelocity,
    maxAngularAccel: stats.maxAngularAccel,
    dragArea: stats.dragArea,
    heatShield: stats.heatShield,
    heatCapacity: stats.heatCapacity,
    heatDissipation: stats.heatDissipation,
    dockPort: layout?.dockingPort ?? null,
    ...where,
  };
}

/**
 * Build the world of a star system at t = 0: bodies under full n-body gravity (moons about planets about the
 * star, shifted to the barycentre with zero net momentum) and, unless `stations` is false, its stations as craft.
 */
export function createWorld(system: SystemDef, opts: { stations?: boolean } = {}): World {
  const defs = system.bodies;
  const n = defs.length;
  const state = new Array<number>(6 * n).fill(0);
  const bodies: Body[] = [];
  let tMin = Infinity;
  for (let i = 0; i < n; i++) {
    const d = defs[i];
    const parent = d.parentId === null ? -1 : defs.findIndex((x) => x.id === d.parentId);
    let spinAxis: V3 = { x: 0, y: Math.cos(d.axialTilt), z: Math.sin(d.axialTilt) };
    let spinRate = d.rotationPeriod > 0 ? (2 * Math.PI) / d.rotationPeriod : 0;
    let spinAngle0 = 0;
    let hill = 1e99;
    if (parent >= 0 && d.orbit) {
      const pd = defs[parent];
      const muT = pd.mu + d.mu;
      const sv = elementsToState(d.orbit, muT, 0);
      for (let c = 0; c < 3; c++) {
        state[3 * i + c] = state[3 * parent + c] + [sv.r.x, sv.r.y, sv.r.z][c];
        state[3 * n + 3 * i + c] = state[3 * n + 3 * parent + c] + [sv.v.x, sv.v.y, sv.v.z][c];
      }
      const a = d.orbit.a;
      const meanMotion = Math.sqrt(muT / (a * a * a));
      tMin = Math.min(tMin, (2 * Math.PI) / meanMotion);
      hill = a * (1 - d.orbit.e) * Math.cbrt(d.mass / (3 * pd.mass));
      if (d.tidallyLocked) {
        // Locked worlds turn once per orbit about their orbit normal, prime meridian (local +X) facing the parent.
        spinAxis = norm(cross(sv.r, sv.v));
        spinRate = meanMotion;
        const e1 = qRotate(spinBase(spinAxis), X_AXIS);
        const e2 = cross(spinAxis, e1);
        spinAngle0 = Math.atan2(-dot(sv.r, e2), -dot(sv.r, e1));
      }
    }
    bodies.push({
      id: d.id,
      name: d.name,
      parent,
      mass: d.mass,
      mu: d.mu,
      radius: d.radius,
      solid: d.cls !== 'star' && d.cls !== 'gasGiant' && d.cls !== 'iceGiant',
      hill,
      r: { x: 0, y: 0, z: 0 },
      v: { x: 0, y: 0, z: 0 },
      spinAxis,
      spinRate,
      spinAngle0,
      spinAngle: spinAngle0,
      atmosphere: d.atmosphere
        ? { surfaceDensity: d.atmosphere.surfaceDensity, scaleHeight: d.atmosphere.scaleHeight, height: d.atmosphere.height }
        : null,
    });
  }
  // Barycentric frame with zero net momentum.
  let muSum = 0;
  const com = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    muSum += defs[i].mu;
    for (let c = 0; c < 3; c++) {
      com[c] += defs[i].mu * state[3 * i + c];
      com[3 + c] += defs[i].mu * state[3 * n + 3 * i + c];
    }
  }
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      state[3 * i + c] -= com[c] / muSum;
      state[3 * n + 3 * i + c] -= com[3 + c] / muSum;
    }
    const b = bodies[i];
    b.r = { x: state[3 * i], y: state[3 * i + 1], z: state[3 * i + 2] };
    b.v = { x: state[3 * n + 3 * i], y: state[3 * n + 3 * i + 1], z: state[3 * n + 3 * i + 2] };
  }
  const h = Number.isFinite(tMin) ? Math.max(1, Math.floor(tMin / STEPS_PER_SHORTEST_ORBIT)) : 300;
  const world: World = { version: 1, t: 0, h, ephStep: 0, ephState: state, bodies, craft: [], joints: [], events: [] };

  if (opts.stations !== false) {
    for (const st of system.stations) {
      const p = bodyIndex(world, st.parentBodyId);
      if (p < 0) continue;
      const sv = elementsToState(st.orbit, bodies[p].mu, 0);
      const layout = STATION_LAYOUTS[st.visualId];
      addCraft(world, {
        id: st.id,
        name: st.name,
        kind: 'station',
        stationVisual: st.visualId,
        visualSeed: st.visualSeed,
        pad: st.maxPad,
        dryMass: STATION_MASS,
        radius: layout.radius,
        dragArea: layout.radius * layout.radius,
        heatCapacity: 1e18,
        maxLoad: 1e9,
        hullStrength: 0.5 * STATION_MASS * 25 * 25,
        colliders: layout.colliders,
        ports: layout.ports,
        primaryId: st.parentBodyId,
        r: sv.r,
        v: sv.v,
        // Station-local +Y along the orbit normal; no spin.
        q: qFromTo(Y_AXIS, norm(cross(sv.r, sv.v))),
      });
    }
  }
  return world;
}
