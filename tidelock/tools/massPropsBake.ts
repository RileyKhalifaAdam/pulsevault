// Build-time core of the mass-properties bake (SIMULATION.md W3-A item 1). Bundled for node by
// tools/bake-massprops.mjs, which writes src/data/massPropsBaked.ts; imported directly by tests/massprops.test.ts
// (which re-bakes on a coarse grid and checks the generated table is not stale). NOT part of the game bundle.
//
// Per hull: the raw volume moments of the collision compound as a uniform solid (union, overlaps counted once):
//   [V, ∫x, ∫y, ∫z, ∫xx, ∫yy, ∫zz, ∫xy, ∫xz, ∫yz] dV   (craft-local, about the craft origin)
// on a voxel grid of side h (each voxel adds h³·(p pᵀ + h²/12·E) to the second moments: exact for the voxel).
// For the Wren also the skin moments per HULL_ZONES zone (the same 10 numbers with dA in place of dV) from
// tools/aeroBake.ts sampleSkin (the cells W2-B's aero table uses, tagged by damage.ts zoneOfPoint): a thin shell of
// areal mass σ_z on zone z then has moments σ_z·S_z. The mass model (src/world/massProps.ts) is a linear
// combination of these sets, so the dry inertia tensor is the shell's, not a box's.

import { HULL_COLLIDERS, type HullPartDef } from '../src/data/hullColliders';
import { N_HULL_ZONES } from '../src/data/hullZones';
import { compileCompound, compoundContains, type Compound } from '../src/world/compound';
import { sampleSkin } from './aeroBake';

export const NM = 10;

export function compoundOf(hull: string, extra: readonly HullPartDef[] = []): Compound {
  const defs = (HULL_COLLIDERS as Record<string, HullPartDef[] | undefined>)[hull];
  if (!defs) throw new Error(`no hull ${hull}`);
  return compileCompound([...defs, ...extra]);
}

/** Raw volume moments of the compound (uniform solid of unit density) on an h grid. */
export function volumeMoments(cmp: Compound, h: number): number[] {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < cmp.n; i++) {
    x0 = Math.min(x0, cmp.aabb[i * 6]); y0 = Math.min(y0, cmp.aabb[i * 6 + 1]); z0 = Math.min(z0, cmp.aabb[i * 6 + 2]);
    x1 = Math.max(x1, cmp.aabb[i * 6 + 3]); y1 = Math.max(y1, cmp.aabb[i * 6 + 4]); z1 = Math.max(z1, cmp.aabb[i * 6 + 5]);
  }
  // grid anchored at the origin (symmetric hulls give symmetric sums)
  const i0 = Math.floor(x0 / h), i1 = Math.ceil(x1 / h), j0 = Math.floor(y0 / h), j1 = Math.ceil(y1 / h), k0 = Math.floor(z0 / h), k1 = Math.ceil(z1 / h);
  const m = new Array<number>(NM).fill(0);
  const dV = h * h * h, e = (h * h) / 12;
  for (let i = i0; i < i1; i++) {
    const x = (i + 0.5) * h;
    for (let j = j0; j < j1; j++) {
      const y = (j + 0.5) * h;
      for (let k = k0; k < k1; k++) {
        const z = (k + 0.5) * h;
        if (!compoundContains(cmp, x, y, z)) continue;
        m[0] += dV; m[1] += dV * x; m[2] += dV * y; m[3] += dV * z;
        m[4] += dV * (x * x + e); m[5] += dV * (y * y + e); m[6] += dV * (z * z + e);
        m[7] += dV * x * y; m[8] += dV * x * z; m[9] += dV * y * z;
      }
    }
  }
  return m;
}

/** Skin moments per zone (N_HULL_ZONES × NM), Wren only (zone tags need hullZones' PART_ZONE). */
export function skinMoments(cmp: Compound, spacing: number): number[] {
  const skin = sampleSkin(cmp, spacing);
  const out = new Array<number>(N_HULL_ZONES * NM).fill(0);
  for (let c = 0; c < skin.n; c++) {
    const o = c * 9, x = skin.cell[o], y = skin.cell[o + 1], z = skin.cell[o + 2], A = skin.cell[o + 6], zn = skin.cell[o + 8];
    if (!(zn >= 0 && zn < N_HULL_ZONES)) continue;
    const b = zn * NM;
    out[b] += A; out[b + 1] += A * x; out[b + 2] += A * y; out[b + 3] += A * z;
    out[b + 4] += A * x * x; out[b + 5] += A * y * y; out[b + 6] += A * z * z;
    out[b + 7] += A * x * y; out[b + 8] += A * x * z; out[b + 9] += A * y * z;
  }
  return out;
}

export interface MassBake {
  hull: string;
  volume: number[];
  skin: number[] | null;
}

export function bakeHull(hull: string, h = 0.1, spacing = 0.25): MassBake {
  const cmp = compoundOf(hull);
  return { hull, volume: volumeMoments(cmp, h), skin: hull === 'wren' ? skinMoments(cmp, spacing) : null };
}
