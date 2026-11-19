// Propellant tanks and the dry-mass model of the hulls (SIMULATION.md W3-A item 1, owner decision D2). Pure data.
//
// WIRING (wave 3; nothing imports this yet):
// - setup.ts addCraft / load: model = buildMassModel(hullId, tankDefsFor(hullId, stats.fuelCapacity, rcsCapacity),
//   stats.dryMass) (src/world/massProps.ts) — rebuilt at load, never saved. §1.4 `tanks` holds one {m, pos, cap} per
//   TankDef in this order (m saved; pos and cap derived).
// - hullColliders.ts (W3-A owns it in wave 3): append TANK_FAIRINGS to HULL_COLLIDERS.wren (the conformal tanks of
//   D2 that do not fit inside today's hull), then re-run tools/bake-aero.mjs and tools/bake-massprops.mjs.
//   render/space/ships.ts (buildWren) must draw the same fairings (the belly blister and the two wing-root gloves).
// - hullZones.ts: the 'tank-stbd' / 'tank-port' damage components are the two N2H4 capsules below (radius 0.41 m
//   here vs 0.36 m in the collider: jets.ts' blowdown tank, B = 3, needs 2.24 m³; the 0.36 m capsules hold 1.71 m³).
//   W2-C may add one 'tank' component per LH2 tank (ids below) so a hit can puncture one (W3-B's breach / boil-off).
//
// D2 (default proposal: conformal tanks outside the pressure hull in the belly and the wing roots), sized here:
//   22.5 t LH2 at 70.8 kg/m³ is 317.8 m³. Outside the pressure hull (rooms of interiors.ts + 0.1 m of wall and
//   floor), today's Wren compound has ≈ 520 m³ (measured on a 0.1 m grid), but most of it is skin depth, roof over the
//   skylights, nose, drive cores and radiators. What a tank can honestly occupy inside today's hull is ≈ 168 m³
//   (tests/massprops.test.ts samples it): the under-floor belly (0.63 m deep), the forward 8 m of each drive pod, the
//   dorsal space aft of the collar and the floor of engineering. The remaining ≈ 161 m³ needs conformal additions:
//   a belly blister 1.15 m deep from z −9.5 to +6.9 (it stops ahead of the ventral cargo ramp, z 7–10) and two
//   wing-root gloves (2.25 × 2.2 × 7 m) outboard of the pods. This changes the hull's silhouette: THE OWNER MUST
//   SEE IT (D2). LH2 tank volume 329.0 m³: 3.4 % ullage at 22.5 t.
// The N2H4 pool (1.5 t at 1004 kg/m³, 1.49 m³ of liquid) sits in two diaphragm tanks (positive expulsion: no slosh,
// no ullage need) in the existing 'tank-stbd' / 'tank-port' capsules over the pods.
//
// Axes: ship-local metres (forward −Z, up +Y, starboard +X), origin = the layout origin (today's declared CoM). The
// engines feed from the aft end: every LH2 tank's sump is its aft-bottom edge (outlets +Z and −Y).

import type { V3 } from '../core/types';
import type { HullPartDef } from './hullColliders';

export type Fluid = 'lh2' | 'n2h4';
export type TankShape = 'box' | 'capsule';

/** Outlet faces (bit mask): the liquid covers the sump when it is settled against any of these faces. */
export const OUT_PZ = 1;
export const OUT_NY = 2;
export const OUT_NZ = 4;
export const OUT_PY = 8;
export const OUT_PX = 16;
export const OUT_NX = 32;

export interface TankDef {
  id: string;
  fluid: Fluid;
  /** 'box': half extents h. 'capsule': axis along craft Z, radius h.x (= h.y), half length of the cylinder h.z. */
  shape: TankShape;
  c: V3;
  h: V3;
  /** Propellant capacity, kg (filled to 1 − ullage). */
  cap: number;
  /** Liquid density, kg/m³. */
  density: number;
  /** Draw order: the lowest group with propellant drains first (inside a group, in proportion to capacity). */
  group: number;
  /** Engines this tank can feed with the crossfeed valve closed (bit i = ShipLayout.engines[i]). */
  feeds: number;
  /** Ring baffles (slosh ζ 0.05 instead of 0.02). */
  baffles: boolean;
  /** Diaphragm / bladder tank: the liquid is held (no slosh, never unsettled). */
  diaphragm: boolean;
  /** Sump faces (OUT_*). */
  outlet: number;
  /** Tank structure and insulation, kg (part of the dry mass). */
  dryMass: number;
  /** In a conformal fairing outside today's hull compound (TANK_FAIRINGS). */
  external: boolean;
}

export const LH2_DENSITY = 70.8;
export const N2H4_DENSITY = 1004;
/** Main pool and RCS pool of the Wren (D3: 24 t split 22.5 t LH2 + 1.5 t N2H4). */
export const WREN_LH2 = 22500;
export const WREN_N2H4 = 1500;
/** LH2 tank structure + MLI per kg of LH2 (Al-Li conformal tanks), and N2H4 tank per kg of hydrazine. */
export const LH2_TANK_FRACTION = 0.09;
export const N2H4_TANK_FRACTION = 0.1;

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });

/** Volume of a tank's shape, m³. */
export function tankVolume(t: { shape: TankShape; h: V3 }): number {
  if (t.shape === 'box') return 8 * t.h.x * t.h.y * t.h.z;
  const r = t.h.x;
  return Math.PI * r * r * 2 * t.h.z + (4 / 3) * Math.PI * r * r * r;
}

/** Is a ship-local point inside a tank? (Build/test time only.) */
export function tankContains(t: { shape: TankShape; c: V3; h: V3 }, x: number, y: number, z: number): boolean {
  const dx = x - t.c.x, dy = y - t.c.y, dz = z - t.c.z;
  if (t.shape === 'box') return Math.abs(dx) <= t.h.x && Math.abs(dy) <= t.h.y && Math.abs(dz) <= t.h.z;
  const r = t.h.x, ez = Math.abs(dz) > t.h.z ? Math.abs(dz) - t.h.z : 0;
  return dx * dx + dy * dy + ez * ez <= r * r;
}

const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): { c: V3; h: V3 } => ({
  c: v(0.5 * (x0 + x1), 0.5 * (y0 + y1), 0.5 * (z0 + z1)), h: v(0.5 * (x1 - x0), 0.5 * (y1 - y0), 0.5 * (z1 - z0)),
});

type Geo = { id: string; shape: TankShape; c: V3; h: V3; group: number; feeds: number; baffles: boolean; external: boolean };

/**
 * The Wren's LH2 tanks. Groups: the belly drains first (it is furthest from the design CoM in y and its blister is
 * what a damaged belly loses), then the pod tanks (each feeds its own engine; crossfeed opens the rest to both), then
 * the dorsal and glove tanks.
 */
const WREN_LH2_GEO: Geo[] = [
  // under the floor (y −1.12, 0.12 m below the deck) and through the belly skin into the blister (y −2.9)
  { id: 'lh2-belly-fwd', shape: 'box', ...box(-2.95, -2.9, -9.5, 2.95, -1.12, 1.0), group: 0, feeds: 3, baffles: true, external: true },
  { id: 'lh2-belly-mid', shape: 'box', ...box(-2.95, -2.9, 1.0, 2.95, -1.12, 6.9), group: 0, feeds: 3, baffles: true, external: true },
  // the forward 8 m of each drive pod (the drive core is aft of z 11.2; the pod skin is r 1.27; offset 0.18 m
  // outboard-down so it clears the radiator envelope over the pod's inboard shoulder)
  { id: 'lh2-pod-stbd', shape: 'capsule', c: v(4.95, -0.3, 6.95), h: v(1.05, 1.05, 3.05), group: 1, feeds: 1, baffles: true, external: false },
  { id: 'lh2-pod-port', shape: 'capsule', c: v(-4.95, -0.3, 6.95), h: v(1.05, 1.05, 3.05), group: 1, feeds: 2, baffles: true, external: false },
  // under the engineering floor, aft of the ventral ramp (z 7–10)
  { id: 'lh2-belly-aft', shape: 'box', ...box(-2.95, -1.75, 10.1, 2.95, -1.12, 12.6), group: 0, feeds: 3, baffles: false, external: false },
  // dorsal, aft of the docking collar, between the deck overhead (1.4 + 0.12) and the dorsal skin
  { id: 'lh2-dorsal-aft', shape: 'box', ...box(-2.9, 1.52, 6.4, 2.9, 2.25, 12.6), group: 2, feeds: 3, baffles: false, external: false },
  // wing-root gloves outboard of the pods (conformal fairings over the wing roots)
  { id: 'lh2-glove-stbd', shape: 'box', ...box(6.15, -1.3, 3.0, 8.4, 0.9, 10.0), group: 2, feeds: 1, baffles: true, external: true },
  { id: 'lh2-glove-port', shape: 'box', ...box(-8.4, -1.3, 3.0, -6.15, 0.9, 10.0), group: 2, feeds: 2, baffles: true, external: true },
];

/** The two N2H4 diaphragm tanks: today's 'tank-stbd' / 'tank-port' capsules, radius 0.41 m (jets.ts blowdown B = 3). */
const WREN_N2H4_GEO: Geo[] = [
  { id: 'n2h4-stbd', shape: 'capsule', c: v(4.2, 1.38, 4.3), h: v(0.41, 0.41, 0.81), group: 0, feeds: 3, baffles: false, external: false },
  { id: 'n2h4-port', shape: 'capsule', c: v(-4.2, 1.38, 4.3), h: v(0.41, 0.41, 0.81), group: 0, feeds: 3, baffles: false, external: false },
];

function fill(geo: Geo[], fluid: Fluid, total: number, density: number, frac: number): TankDef[] {
  let V = 0;
  for (const g of geo) V += tankVolume(g);
  return geo.map((g) => {
    const cap = (total * tankVolume(g)) / V;
    return {
      id: g.id, fluid, shape: g.shape, c: { ...g.c }, h: { ...g.h }, cap, density, group: g.group, feeds: g.feeds,
      baffles: g.baffles, diaphragm: fluid === 'n2h4', outlet: fluid === 'n2h4' ? 0 : OUT_PZ | OUT_NY,
      dryMass: frac * cap, external: g.external,
    };
  });
}

/** The Wren's tanks for a fit's main and RCS pools (kg): LH2 tanks first, then N2H4. */
export function wrenTanks(lh2 = WREN_LH2, n2h4 = WREN_N2H4): TankDef[] {
  return [...fill(WREN_LH2_GEO, 'lh2', lh2, LH2_DENSITY, LH2_TANK_FRACTION), ...fill(WREN_N2H4_GEO, 'n2h4', n2h4, N2H4_DENSITY, N2H4_TANK_FRACTION)];
}

/**
 * Any other hull (no interior, no D2 layout yet): one LH2 tank as a cylinder along Z at the hull's volume centroid,
 * 2.5 diameters long, and one N2H4 diaphragm tank at the same place. Mass properties only.
 */
export function genericTanks(centroid: V3, lh2: number, n2h4: number): TankDef[] {
  const out: TankDef[] = [];
  if (lh2 > 0) {
    const V = lh2 / LH2_DENSITY / 0.97;
    // V = πr²·2h + 4/3πr³ with h = 2.5r − r (total length 5r incl. the domes) → V = πr³(3 + 4/3)
    const r = Math.cbrt(V / (Math.PI * (3 + 4 / 3)));
    out.push({ id: 'lh2-main', fluid: 'lh2', shape: 'capsule', c: { ...centroid }, h: v(r, r, 1.5 * r), cap: lh2, density: LH2_DENSITY, group: 0, feeds: 0xff, baffles: true, diaphragm: false, outlet: OUT_PZ | OUT_NY, dryMass: LH2_TANK_FRACTION * lh2, external: false });
  }
  if (n2h4 > 0) {
    const r = Math.cbrt((n2h4 / N2H4_DENSITY) * 1.5 / (Math.PI * (4 / 3)));
    out.push({ id: 'n2h4-main', fluid: 'n2h4', shape: 'capsule', c: { ...centroid }, h: v(r, r, 0), cap: n2h4, density: N2H4_DENSITY, group: 0, feeds: 0xff, baffles: false, diaphragm: true, outlet: 0, dryMass: N2H4_TANK_FRACTION * n2h4, external: false });
  }
  return out;
}

/**
 * Collider parts for the conformal fairings of D2 (wave 3 appends them to HULL_COLLIDERS.wren): the belly blister
 * (below today's belly, y −1.8, down to the tank bottom + 0.05 m of skin) and the two wing-root gloves.
 */
export const TANK_FAIRINGS: HullPartDef[] = [
  { name: 'blister', kind: 'box', c: [0, -2.375, -4.25], h: [3.0, 0.575, 5.3] },
  { name: 'blister-aft', kind: 'box', c: [0, -2.375, 3.975], h: [3.0, 0.575, 2.975] },
  { name: 'glove-stbd', kind: 'box', c: [7.275, -0.2, 6.5], h: [1.175, 1.15, 3.55] },
  { name: 'glove-port', kind: 'box', c: [-7.275, -0.2, 6.5], h: [1.175, 1.15, 3.55] },
];

// ------------------------------------------------------------------------------------------------ dry mass model

/** A solid item of the dry mass: an axis-aligned box or a Z-axis cylinder, uniform density. */
export interface DryItem {
  id: string;
  shape: 'box' | 'cyl';
  c: V3;
  /** Box half extents; cylinder: h.x = radius, h.z = half length. */
  h: V3;
  /** kg, before the budget scaling (see buildMassModel). */
  m: number;
}

/**
 * The Wren's dry mass (fit total stats.dryMass, 42.9 t default) split by what it is:
 * - skin and its structure: HULL_ZONES arealMass × the baked zone areas (≈ 24.6 t), as a shell on the baked skin;
 * - the items below (drive cores, reactor, radiators, interior outfit);
 * - the tank structures (TankDef.dryMass) at their tanks;
 * - the rest (keel, frames, deck, systems: ≈ 5 t at the default fit) as a uniform solid over the hull compound.
 * When a lighter fit leaves less than 10 % of the dry mass for the rest, every non-skin item is scaled down so it
 * stays 10 % (massProps.ts buildMassModel); the total is always stats.dryMass.
 */
export const WREN_DRY_ITEMS: DryItem[] = [
  // magnetic-nozzle drive cores, aft of the pod tanks to the exit plane (z 15.6)
  { id: 'drive-stbd', shape: 'cyl', c: v(4.8, -0.2, 13.4), h: v(0.95, 0.95, 2.2), m: 3000 },
  { id: 'drive-port', shape: 'cyl', c: v(-4.8, -0.2, 13.4), h: v(0.95, 0.95, 2.2), m: 3000 },
  // reactor (engineering, interiors.ts solid 'reactor') and the coolant machinery
  { id: 'reactor', shape: 'box', c: v(0, 0, 12.7), h: v(0.8, 1.0, 0.7), m: 2400 },
  { id: 'coolant', shape: 'box', c: v(2.0, 0.2, 12.9), h: v(0.4, 1.2, 0.5), m: 300 },
  // NaK radiator panels (hullColliders radiator-stbd / -port)
  { id: 'radiator-stbd', shape: 'box', c: v(3.85, 0.83, 7.95), h: v(0.5, 0.23, 5.45), m: 350 },
  { id: 'radiator-port', shape: 'box', c: v(-3.85, 0.83, 7.95), h: v(0.5, 0.23, 5.45), m: 350 },
  // interior outfit: deck plates, partitions, furniture, galley, cockpit consoles, cargo racks (per room)
  { id: 'outfit-cockpit', shape: 'box', c: v(0, 0.2, -13.3), h: v(1.7, 1.2, 1.7), m: 450 },
  { id: 'outfit-lounge', shape: 'box', c: v(0, 0.2, -7.5), h: v(3.2, 1.2, 2.9), m: 420 },
  { id: 'outfit-cabins', shape: 'box', c: v(0, 0.2, -1.0), h: v(3.2, 1.2, 3.6), m: 420 },
  { id: 'outfit-cargo', shape: 'box', c: v(0, 0.2, 6.5), h: v(3.2, 1.2, 3.5), m: 360 },
  { id: 'outfit-eng', shape: 'box', c: v(0, 0.2, 11.7), h: v(2.4, 1.2, 1.7), m: 250 },
];

/** Crew member's mass (with suit-less clothing), kg; the loose-object masses come from data/props.ts. */
export const CREW_MASS = 80;
