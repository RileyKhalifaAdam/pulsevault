// The Wren's hull zones (docs/SIMULATION.md §1.4 "Hull zone table", W2-C item 5): 12 thermal skin zones, each with
// its area, local radius of curvature, skin material and the damage components it contains, plus the damage
// component list (`zones: number[]` holds one health per component, in DAMAGE_COMPONENTS order) and the map from the
// compound's part names (src/data/hullColliders.ts) to skin zones. Pure data; no three.js, no DOM.
//
// WIRING (wave 2):
// - §1.4 puts HULL_ZONES in src/data/hullColliders.ts. It is delivered here (a new file, because hullColliders.ts is
//   a generated file owned elsewhere during the pre-build); wave 2 either moves this content there or re-exports it:
//   `export { HULL_ZONES, DAMAGE_COMPONENTS, PART_ZONE } from './hullZones';` at the end of hullColliders.ts.
// - W2-B tags its skin samples with zoneOfPoint() (src/world/damage.ts) and may replace `area` by its baked areas.
// - W2-D builds its 12 skin nodes from HULL_ZONES (area, arealMass, material) and its radiator nodes from the two
//   'radiator' components (radiatorHealth[k] scales rejection).
// - W2-C (damage.ts) maps manifold points to zones and components; W3-B reads window `breachArea` when broken.
//
// Areas: exterior surface of the compound per zone, measured by sampling every part's surface on a 0.25 m grid and
// keeping the samples outside all other parts (tests/damage.test.ts re-measures them; agreement within 15%).
// Radius: local radius of curvature for stagnation heating (q ∝ 1/√R): leading edges and the nose small, flat
// panels large. Panel capacity = energyDensity (1–5 MJ/m³, crushable structure) × area × crushDepth.
// A component can only be struck through the skin of its own zone (src/world/damage.ts componentAt): its `zone` is
// the zone of the skin over it, so a hit is never booked on a component in another zone.
// RCS: the Wren's 10 jets sit in 6 separate housings (fore: starboard cheek, port cheek, dorsal, ventral; aft: one
// cluster per pod), so there are 6 RCS components, not the plan's 4 quads (the centreline fore jets are neither
// starboard nor port).

import { INTERIORS } from './interiors';
import type { V3 } from '../core/types';

export type SkinMaterial = 'rcc' | 'tile' | 'aluminium' | 'composite' | 'glass' | 'inconel';

export interface HullZone {
  id: string;
  name: string;
  /** Exterior area, m². */
  area: number;
  /** Local radius of curvature at the zone's most exposed point (stagnation heating), m. */
  radius: number;
  material: SkinMaterial;
  /** Skin + structure mass per area that takes the zone's heat, kg/m² (thermal capacity for W2-D). */
  arealMass: number;
  /** Crushable depth of structure behind the skin, m, and its crush energy per volume, J/m³ (damage capacity). */
  crushDepth: number;
  energyDensity: number;
  /** Indices into DAMAGE_COMPONENTS of the components in this zone (its own panel first). */
  components: number[];
}

export type DamageKind = 'panel' | 'window' | 'rcs' | 'engine' | 'radiator' | 'collar' | 'tank';

export interface DamageComponent {
  id: string;
  kind: DamageKind;
  /** Skin zone index (HULL_ZONES) the component sits in. */
  zone: number;
  /**
   * Index among the components of its kind: engine i = ShipLayout.engines[i] (0 = starboard +X), radiator 0 =
   * starboard, rcs cluster 0..5 (fore-stbd, fore-port, fore-dorsal, fore-ventral, aft-stbd, aft-port), window i =
   * order below.
   */
  index: number;
  /** Energy that brings health to 0, J. Windows crack at `crack` J (health ≤ 1 − crack/capacity). */
  capacity: number;
  crack: number;
  /** Hit volume, ship-local AABB (windows, collar), or the compound parts that ARE the component (pods, radiators, tanks). */
  box: { min: V3; max: V3 } | null;
  parts: string[];
  /** RCS clusters: the centre of the housing (jets are assigned to the nearest cluster at load). */
  centre: V3 | null;
  /** Windows: the opening's area (the breach area when broken), m². */
  breachArea: number;
}

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });

/** Zone indices. */
export const Z_NOSE = 0, Z_CANOPY = 1, Z_DORSAL_FWD = 2, Z_DORSAL_AFT = 3, Z_BELLY_FWD = 4, Z_BELLY_AFT = 5;
export const Z_FLANK_PORT = 6, Z_FLANK_STBD = 7, Z_WING_PORT = 8, Z_WING_STBD = 9, Z_POD_PORT = 10, Z_POD_STBD = 11;
export const N_HULL_ZONES = 12;

type ZoneSpec = Omit<HullZone, 'components'>;
const ZONE_SPECS: ZoneSpec[] = [
  { id: 'nose', name: 'Nose cap', area: 46, radius: 0.45, material: 'rcc', arealMass: 40, crushDepth: 0.3, energyDensity: 5e6 },
  { id: 'canopy', name: 'Canopy', area: 26, radius: 1.2, material: 'glass', arealMass: 35, crushDepth: 0.1, energyDensity: 2e6 },
  { id: 'dorsal-fwd', name: 'Dorsal fore', area: 121, radius: 4, material: 'aluminium', arealMass: 18, crushDepth: 0.15, energyDensity: 3e6 },
  { id: 'dorsal-aft', name: 'Dorsal aft', area: 159, radius: 4, material: 'aluminium', arealMass: 18, crushDepth: 0.15, energyDensity: 3e6 },
  { id: 'belly-fwd', name: 'Belly fore', area: 122, radius: 5, material: 'tile', arealMass: 30, crushDepth: 0.2, energyDensity: 3e6 },
  { id: 'belly-aft', name: 'Belly aft', area: 112, radius: 5, material: 'tile', arealMass: 30, crushDepth: 0.2, energyDensity: 3e6 },
  { id: 'flank-port', name: 'Port flank', area: 106, radius: 1.5, material: 'aluminium', arealMass: 18, crushDepth: 0.15, energyDensity: 3e6 },
  { id: 'flank-stbd', name: 'Starboard flank', area: 106, radius: 1.5, material: 'aluminium', arealMass: 18, crushDepth: 0.15, energyDensity: 3e6 },
  { id: 'wing-port', name: 'Port wing', area: 57, radius: 0.25, material: 'composite', arealMass: 12, crushDepth: 0.1, energyDensity: 1.5e6 },
  { id: 'wing-stbd', name: 'Starboard wing', area: 57, radius: 0.25, material: 'composite', arealMass: 12, crushDepth: 0.1, energyDensity: 1.5e6 },
  { id: 'pod-port', name: 'Port drive pod', area: 94, radius: 1.27, material: 'inconel', arealMass: 25, crushDepth: 0.2, energyDensity: 3e6 },
  { id: 'pod-stbd', name: 'Starboard drive pod', area: 94, radius: 1.27, material: 'inconel', arealMass: 25, crushDepth: 0.2, energyDensity: 3e6 },
];

/**
 * Part name -> zone, or -1: a body part with several faces, classified by its outward normal and position
 * (src/world/damage.ts zoneOfPoint). Parts not listed are classified by position as well.
 */
export const PART_ZONE: Record<string, number> = {
  hull: -1, stern: -1, roof: Z_DORSAL_FWD, 'deck-rise': Z_DORSAL_AFT, deck: Z_DORSAL_AFT, 'deck-aft': Z_DORSAL_AFT, belly: -1,
  'chine-stbd': Z_FLANK_STBD, 'chine-port': Z_FLANK_PORT, 'shoulder-stbd': Z_DORSAL_FWD, 'shoulder-port': Z_DORSAL_FWD,
  'shoulder-rise-stbd': Z_DORSAL_AFT, 'shoulder-rise-port': Z_DORSAL_AFT, 'shoulder-aft-stbd': Z_DORSAL_AFT, 'shoulder-aft-port': Z_DORSAL_AFT,
  'tank-stbd': Z_FLANK_STBD, 'tank-port': Z_FLANK_PORT, 'valley-stbd': Z_FLANK_STBD, 'valley-port': Z_FLANK_PORT,
  'radiator-stbd': Z_FLANK_STBD, 'radiator-port': Z_FLANK_PORT,
  'flank-low-stbd': Z_BELLY_FWD, 'flank-low-port': Z_BELLY_FWD, 'flare-low-stbd': Z_BELLY_FWD, 'flare-low-port': Z_BELLY_FWD,
  'flare-top-stbd': Z_DORSAL_FWD, 'flare-top-port': Z_DORSAL_FWD, 'flare-stbd': Z_FLANK_STBD, 'flare-port': Z_FLANK_PORT,
  cabin: -1, 'cockpit-rail-stbd': Z_CANOPY, 'cockpit-rail-port': Z_CANOPY, canopy: Z_CANOPY,
  'cheek-stbd': Z_FLANK_STBD, 'cheek-port': Z_FLANK_PORT, 'cheek-fwd-stbd': Z_NOSE, 'cheek-fwd-port': Z_NOSE,
  windscreen: Z_CANOPY, nose: Z_NOSE, 'nose-fwd': Z_NOSE, chin: Z_NOSE,
  'nose-chine-stbd': Z_NOSE, 'nose-chine-port': Z_NOSE, 'nose-chine-fwd-stbd': Z_NOSE, 'nose-chine-fwd-port': Z_NOSE,
  'pod-stbd': Z_POD_STBD, 'pod-port': Z_POD_PORT, 'pod-aft-stbd': Z_POD_STBD, 'pod-aft-port': Z_POD_PORT,
  'pod-aft45-stbd': Z_POD_STBD, 'pod-aft45-port': Z_POD_PORT, 'pod-nose-stbd': Z_POD_STBD, 'pod-nose-port': Z_POD_PORT,
  'wing-stbd': Z_WING_STBD, 'wing-port': Z_WING_PORT, 'wing-lead-stbd': Z_WING_STBD, 'wing-lead-port': Z_WING_PORT,
  'wing-trail-stbd': Z_WING_STBD, 'wing-trail-port': Z_WING_PORT,
  'fin-lead-stbd': Z_DORSAL_AFT, 'fin-lead-port': Z_DORSAL_AFT, 'fin-tip-stbd': Z_DORSAL_AFT, 'fin-tip-port': Z_DORSAL_AFT,
  'fin-aft-stbd': Z_DORSAL_AFT, 'fin-aft-port': Z_DORSAL_AFT, 'tip-stbd': Z_WING_STBD, 'tip-port': Z_WING_PORT,
};

// ------------------------------------------------------------------------------------------------ components

/** Windows: the Wren's openings (src/data/interiors.ts), extruded outward through the hull as hit volumes. */
const WINDOW_ZONE: Record<string, number> = {
  'w-front': Z_CANOPY, 'w-cockpit-port': Z_CANOPY, 'w-cockpit-stbd': Z_CANOPY, 'w-overhead': Z_CANOPY,
  'w-lounge': Z_FLANK_STBD, 'w-lounge-sky': Z_DORSAL_FWD, 'w-cabin-port': Z_FLANK_PORT, 'w-cabin-stbd': Z_FLANK_STBD,
};
/** How far outward from the interior face a window's hit volume reaches, and its margin round the opening, m. */
const WINDOW_DEPTH = 1.6;
const WINDOW_MARGIN = 0.15;

function windowBox(w: { wall: string; center: V3; width: number; height: number }): { min: V3; max: V3 } {
  const c = w.center, a = 0.5 * w.width + WINDOW_MARGIN, b = 0.5 * w.height + WINDOW_MARGIN;
  switch (w.wall) {
    case '+x': return { min: v(c.x, c.y - b, c.z - a), max: v(c.x + WINDOW_DEPTH, c.y + b, c.z + a) };
    case '-x': return { min: v(c.x - WINDOW_DEPTH, c.y - b, c.z - a), max: v(c.x, c.y + b, c.z + a) };
    case '+y': return { min: v(c.x - a, c.y, c.z - b), max: v(c.x + a, c.y + WINDOW_DEPTH, c.z + b) };
    case '-z': return { min: v(c.x - a, c.y - b, c.z - WINDOW_DEPTH), max: v(c.x + a, c.y + b, c.z) };
    default: return { min: v(c.x - a, c.y - b, c.z), max: v(c.x + a, c.y + b, c.z + WINDOW_DEPTH) };
  }
}

/** Window crack / break energies (W2-C item 5), J. */
export const WINDOW_CRACK = 10e3;
export const WINDOW_BREAK = 30e3;
/**
 * RCS housing disabled, drive pod, radiator, collar and tank capacities, J. STRUCTURE_CAPACITY: the primary structure
 * (keel, frames) behind every panel, which takes what a crushed-through panel passes on; at 0 the ship is lost. It is
 * today's hullStrength for the Wren (½ · 43 t · (25 m/s)²), so the energy scale of a loss is kept.
 */
export const RCS_QUAD_CAPACITY = 50e3;
export const POD_CAPACITY = 500e3;
export const RADIATOR_CAPACITY = 100e3;
export const COLLAR_CAPACITY = 150e3;
export const TANK_CAPACITY = 200e3;
export const STRUCTURE_CAPACITY = 0.5 * 43e3 * 25 * 25;

function buildComponents(): DamageComponent[] {
  const out: DamageComponent[] = [];
  const base = { crack: 0, box: null, parts: [] as string[], centre: null, breachArea: 0 };
  // 0..11: the structural panel of each zone
  ZONE_SPECS.forEach((z, i) => out.push({ ...base, id: `panel-${z.id}`, kind: 'panel', zone: i, index: i, capacity: z.energyDensity * z.area * z.crushDepth }));
  // windows
  const wins = INTERIORS.wren?.windows ?? [];
  let wi = 0;
  for (const w of wins) {
    const zone = WINDOW_ZONE[w.id];
    if (zone === undefined) continue;
    out.push({ ...base, id: w.id, kind: 'window', zone, index: wi++, capacity: WINDOW_BREAK, crack: WINDOW_CRACK, box: windowBox(w), breachArea: w.width * w.height });
  }
  // RCS housings (ShipLayout.wren.rcs): fore on the cheeks (±3.9, 0.2, −12), dorsal (0, 2, −12.5) behind the canopy,
  // ventral (0, −1.7, −12.5) under the cabin; aft round each pod stern (±4.8..6, −1.5..1.1, 11..12)
  const quads: [string, number, V3][] = [
    ['rcs-fore-stbd', Z_FLANK_STBD, v(3.9, 0.2, -12)],
    ['rcs-fore-port', Z_FLANK_PORT, v(-3.9, 0.2, -12)],
    ['rcs-fore-dorsal', Z_CANOPY, v(0, 2, -12.5)],
    ['rcs-fore-ventral', Z_BELLY_FWD, v(0, -1.7, -12.5)],
    ['rcs-aft-stbd', Z_POD_STBD, v(5.2, -0.2, 11.7)],
    ['rcs-aft-port', Z_POD_PORT, v(-5.2, -0.2, 11.7)],
  ];
  quads.forEach(([id, zone, c], i) => out.push({ ...base, id, kind: 'rcs', zone, index: i, capacity: RCS_QUAD_CAPACITY, centre: c }));
  // drive pods (engine 0 = starboard, layout order), radiators, tanks
  out.push({ ...base, id: 'drive-stbd', kind: 'engine', zone: Z_POD_STBD, index: 0, capacity: POD_CAPACITY, parts: ['pod-stbd', 'pod-aft-stbd', 'pod-aft45-stbd', 'pod-nose-stbd'] });
  out.push({ ...base, id: 'drive-port', kind: 'engine', zone: Z_POD_PORT, index: 1, capacity: POD_CAPACITY, parts: ['pod-port', 'pod-aft-port', 'pod-aft45-port', 'pod-nose-port'] });
  out.push({ ...base, id: 'radiator-stbd', kind: 'radiator', zone: Z_FLANK_STBD, index: 0, capacity: RADIATOR_CAPACITY, parts: ['radiator-stbd'] });
  out.push({ ...base, id: 'radiator-port', kind: 'radiator', zone: Z_FLANK_PORT, index: 1, capacity: RADIATOR_CAPACITY, parts: ['radiator-port'] });
  // dorsal docking collar (ShipLayout.dockingPort at (0, 1.95, 2.2), axis +Y)
  out.push({ ...base, id: 'collar', kind: 'collar', zone: Z_DORSAL_FWD, index: 0, capacity: COLLAR_CAPACITY, box: { min: v(-1.2, 1.3, 1.0), max: v(1.2, 2.9, 3.4) } });
  out.push({ ...base, id: 'tank-stbd', kind: 'tank', zone: Z_FLANK_STBD, index: 0, capacity: TANK_CAPACITY, parts: ['tank-stbd'] });
  out.push({ ...base, id: 'tank-port', kind: 'tank', zone: Z_FLANK_PORT, index: 1, capacity: TANK_CAPACITY, parts: ['tank-port'] });
  return out;
}

export const DAMAGE_COMPONENTS: readonly DamageComponent[] = buildComponents();
/** Index of the docking collar (capture.ts routes the ring's hard-stop energy here). */
export const C_COLLAR = DAMAGE_COMPONENTS.findIndex((c) => c.id === 'collar');

export const HULL_ZONES: readonly HullZone[] = ZONE_SPECS.map((z, i) => ({
  ...z,
  components: DAMAGE_COMPONENTS.map((c, k) => (c.zone === i ? k : -1)).filter((k) => k >= 0),
}));

/** Hit-test priority of the kinds: the first matching component takes the energy (then the zone's panel). */
export const DAMAGE_PRIORITY: readonly DamageKind[] = ['window', 'collar', 'rcs', 'engine', 'radiator', 'tank'];

/** Radius round each RCS jet within which a hit (on its zone's skin) strikes its housing, m. */
export const RCS_HIT_RADIUS = 0.8;
