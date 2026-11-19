// Where the rendezvous sensors sit on each hull (docs/SIMULATION.md W3-C items 1, 2, 4). Ship-local metres
// (forward −Z, up +Y, right +X; origin at the craft origin), boresights as unit vectors. Pure data.
//
// - radar: the S-band dish on the dorsal spine, forward of the collar; its gimbal sweeps a cone of RADAR_GIMBAL about
//   the dorsal axis (+Y), which is also what keeps the ship's own hull out of the beam.
// - lidar: the scanning lidar beside the docking collar, boresight along the collar axis.
// - camera: the centreline docking camera looking out through the collar; image "up" is the ship's nose (−Z).
// Positions were checked against the hull compound (data/hullColliders.ts): every mount is outside it.
//
// WIRING: read by world/sensors.ts (sensorMounts(shipVisual)) and world/dockCam.ts; nothing else. A hull without an
// entry uses its docking collar (or the origin) for all three.

import type { V3 } from '../core/types';

export interface SensorMounts {
  radar: { pos: V3; axis: V3 };
  lidar: { pos: V3; axis: V3 };
  camera: { pos: V3; axis: V3; up: V3 };
}

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });
const PY = v(0, 1, 0);
const NZ = v(0, 0, -1);

export const SENSOR_MOUNTS: Record<string, SensorMounts> = {
  // Collar at (0, 1.95, 2.2) facing +Y; the dorsal hull top is ≈ 1.85 m from z = −12 to z = 4.
  wren: {
    radar: { pos: v(0, 2.35, -3.0), axis: PY },
    lidar: { pos: v(0.95, 2.0, 2.2), axis: PY },
    camera: { pos: v(0, 2.0, 2.2), axis: PY, up: NZ },
  },
};

/** Mounts for a hull: its table entry, else everything on the docking collar (or the origin, looking +Y). */
export function sensorMounts(shipVisual: string | null, dockPort: { pos: V3; dir: V3 } | null): SensorMounts {
  const m = shipVisual ? SENSOR_MOUNTS[shipVisual] : undefined;
  if (m) return m;
  const key = `${shipVisual ?? ''}`;
  let d = FALLBACK.get(key);
  if (!d) {
    const p = dockPort ? dockPort.pos : v(0, 0, 0), a = dockPort ? dockPort.dir : PY;
    const up = Math.abs(a.z) < 0.9 ? NZ : v(0, 1, 0);
    d = { radar: { pos: p, axis: a }, lidar: { pos: p, axis: a }, camera: { pos: p, axis: a, up } };
    FALLBACK.set(key, d);
  }
  return d;
}
const FALLBACK = new Map<string, SensorMounts>();
