// Geometry between a sphere and a station's colliders (spheres and capsules, station-local metres).
// Used by the renderer to keep the camera out of station hulls and by the layout tests; the physical world
// resolves its own contacts in src/world/contact.ts.

import type { StationCollider, V3 } from '../core/types';

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
