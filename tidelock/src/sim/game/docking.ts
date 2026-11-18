// Berth geometry: where a docked ship sits, where it is released, and which berth traffic control hands out.
// Station-local frame (data/stationLayouts.ts): a ship mates its own collar with the port's mating point,
// collar axes opposed, nose along the port's `up` (hulls with a nose collar: belly away from `up`).

import type { DockingPortDef, PadSize, Quat, ShipVisualId, StationDef, StationLayout, V3 } from '../../core/types';
import { SHIP_FORWARD, SHIP_UP, cross, dot, neg, norm, qLook, reject, sub } from '../../core/vec';
import { SHIP_LAYOUTS } from '../../data/shipLayouts';
import { PAD_ORDER, padFits } from '../../data/stationLayouts';
import { stationAttitude } from '../physics';

/** A pose in a station's frame: position (m) and attitude (ship-local -> station-local). */
export interface LocalPose {
  p: V3;
  q: Quat;
}

/** Pose of a hull berthed at `port`: collar on the mating point, collar axis against the port axis. */
export function dockedLocalPose(shipId: ShipVisualId, port: DockingPortDef): LocalPose {
  const collar = SHIP_LAYOUTS[shipId].dockingPort;
  // Ship-local basis: collar axis, a reference perpendicular to it (the nose, or the back for a nose collar), their cross.
  const a1 = norm(collar.dir);
  const ref = Math.abs(dot(a1, SHIP_FORWARD)) > 0.9 ? SHIP_UP : SHIP_FORWARD;
  const a2 = norm(reject(ref, a1));
  const a3 = cross(a1, a2);
  // Station-local basis they map to: into the port, along the port's up, their cross.
  const b1 = neg(norm(port.dir));
  const b2 = norm(reject(port.up, b1));
  const b3 = cross(b1, b2);
  const rot = (v: V3): V3 => {
    const x = dot(a1, v);
    const y = dot(a2, v);
    const z = dot(a3, v);
    return { x: b1.x * x + b2.x * y + b3.x * z, y: b1.y * x + b2.y * y + b3.y * z, z: b1.z * x + b2.z * y + b3.z * z };
  };
  return { p: sub(port.pos, rot(collar.pos)), q: qLook(rot(SHIP_FORWARD), rot(SHIP_UP)) };
}

/** Pose a departing ship is handed over to its pilot in: on the port axis `distance` m out, nose pointing out. */
export function releaseLocalPose(port: DockingPortDef, distance: number): LocalPose {
  const d = norm(port.dir);
  return { p: { x: port.pos.x + d.x * distance, y: port.pos.y + d.y * distance, z: port.pos.z + d.z * distance }, q: qLook(d, port.up) };
}

/**
 * The berth traffic control assigns: one the ship fits, preferring the pad of its own size and, when the
 * ship's position (station-local) is known, the one whose approach corridor it is nearest to.
 */
export function pickPort(layout: StationLayout, shipPad: PadSize, shipLocal: V3 | null): DockingPortDef | null {
  let best: DockingPortDef | null = null;
  let bestScore = Infinity;
  for (const port of layout.ports) {
    if (!padFits(shipPad, port.size)) continue;
    let score = (PAD_ORDER.indexOf(port.size) - PAD_ORDER.indexOf(shipPad)) * 250;
    if (shipLocal) {
      const ex = port.pos.x + port.dir.x * 60 - shipLocal.x;
      const ey = port.pos.y + port.dir.y * 60 - shipLocal.y;
      const ez = port.pos.z + port.dir.z * 60 - shipLocal.z;
      score += Math.sqrt(ex * ex + ey * ey + ez * ez);
    }
    if (score < bestScore) {
      bestScore = score;
      best = port;
    }
  }
  return best;
}

export function findPort(layout: StationLayout, portId: string | null): DockingPortDef | null {
  if (portId === null) return null;
  for (const p of layout.ports) if (p.id === portId) return p;
  return null;
}

const ATTITUDES = new Map<string, Quat>();

/** Inertial attitude of a station (station-local -> world). Fixed, so it is computed once per station. */
export function stationQuat(station: StationDef): Quat {
  let q = ATTITUDES.get(station.id);
  if (!q) {
    q = stationAttitude(station.orbit);
    ATTITUDES.set(station.id, q);
  }
  return q;
}
