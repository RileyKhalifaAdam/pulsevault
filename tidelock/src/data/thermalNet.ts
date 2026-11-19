// The Wren's thermal network (docs/SIMULATION.md W2-D item 1, D4): 38 nodes, ~90 links, 19 exterior surfaces and
// 8 window panes, built at module load from HULL_ZONES (src/data/hullZones.ts, W2-C) and the interior rooms and
// windows (src/data/interiors.ts). Pure data; no three.js, no DOM.
//
// WIRING (wave 2): compileThermal(WREN_THERMAL) once at load (src/world/thermal.ts); shipSystems.ts reads the
// index constants, PUMP_LINKS / FAN_LINKS (variable conductances), HVAC and DRIVE constants. Other packages read
// room temperatures as thermal.T[N_ROOM0 + roomIndex] (INTERIORS.wren.rooms order; cabin.ts, W2-D air part) and
// skin temperatures as T[zone] or T[N_TPS_*] for the tiled belly (W2-B: AI_TW wall temperature).
//
// Nodes (index: what, C):
//   0–11  skin zones in HULL_ZONES order: C = arealMass·area·c_material. For the tiled belly zones (4, 5) this is
//         the aluminium structure UNDER the tile: its limit is the 450 K bond line.
//   12,13 TPS tile layer on belly-fwd / belly-aft: 25 mm, ρ 140, c 1000 → 3.5 kJ/m²K, ε 0.85, limit 1900 K; tile
//         conductance k/t = 0.06/0.025 = 2.4 W/m²K to the structure below. The exterior surface of the belly.
//   14–16 internal structure fore / mid / aft (frames, pressure shell): 2 t of aluminium each.
//   17,18 nozzle skirts, engine 0 (starboard) and 1 (port): niobium 300 kg, c 350, ε 0.8, A 8 m², limit 1800 K.
//   19,20 radiator panels starboard / port: 13 m² two-sided each (52 m² in all), ε 0.85, α 0.15, ~100 kJ/K.
//   21    primary coolant loop: NaK-78 pressurised to 2.5 bar (saturation ≈ 1178 K by Clausius–Clapeyron from
//         1058 K at 1 bar, ΔH_vap ≈ 79 kJ/mol; melts at 261 K), 400 kg NaK + 600 kg piping/HX. Interlock 1150 K.
//         (The review's correction: NaK boils near 1058 K at 1 bar, so an 1100 K loop must be pressurised.)
//   22    reactor bay: core, BeO reflector, W/LiH shadow shield (≈ 6 t; LiH c_p 3.5 kJ/kgK) ≈ 12 MJ/K.
//   23    avionics bay (racks, battery): 500 kg, limit 358 K.
//   24–33 cabin air + furnishings per room (INTERIORS.wren.rooms order): ρc_p·V + 8 kJ/(K·m³) of lining and
//         furniture, V = room box minus its solids (370 m³ in all, as the plan's 370.5).
//   34–37 window pane groups (= shutter groups): 0 cockpit front, 1 cockpit sides + overhead, 2 lounge, 3 cabins.
//
// Radiator sizing (D4): εσA·T⁴ = 0.85·σ·52·1100⁴ = 3.67 MW. Drive waste ε_d·½·ṁ·vₑ² = 4.4e-4·½·F·vₑ ≈ 6.0 MW at
// 2 × 400 kN, vₑ 34 km/s; 80% goes to the nozzle skirts (which radiate it themselves: equilibrium ≈ 1600 K at
// 2.4 MW each, τ ≈ 18 s, the afterglow), 20% into the loop. NOTE for the owner (see the report): the reactor's
// waste at the drive load, P_e(1 − η)/η = 10 MW·0.7/0.3 = 23 MW, is ~6× what 52 m² can reject at 1100 K, so full
// burns are limited by the loop + reactor heat capacity (≈ 13 MJ/K): about 8–9 min from a cold loop before the
// 1150 K interlock. That is the plan's "long burns heat the ship and the drive cuts itself", with numbers.

import { HULL_ZONES, N_HULL_ZONES, Z_BELLY_AFT, Z_BELLY_FWD, Z_CANOPY, Z_DORSAL_AFT, Z_DORSAL_FWD, Z_FLANK_PORT, Z_FLANK_STBD, Z_NOSE, Z_POD_PORT, Z_POD_STBD, Z_WING_PORT, Z_WING_STBD, type SkinMaterial } from './hullZones';
import { INTERIORS } from './interiors';
import type { ThermalLinkDef, ThermalNetDef, ThermalNodeDef, ThermalSurfaceDef, ThermalWindowDef } from '../world/thermal';

// ------------------------------------------------------------------------------------------------ indices

export const N_TPS_BF = 12, N_TPS_BA = 13;
export const N_STRUCT_F = 14, N_STRUCT_M = 15, N_STRUCT_A = 16;
/** Nozzle skirt of engine e (ShipLayout.engines order: 0 = starboard). */
export const N_SKIRT0 = 17;
/** Radiator panel k (0 = starboard, DAMAGE_COMPONENTS radiator index). */
export const N_RAD0 = 19;
export const N_LOOP = 21;
export const N_REACTOR = 22;
export const N_AVIONICS = 23;
export const N_ROOM0 = 24;
export const N_PANE0 = 34;
export const N_WREN_NODES = 38;
export const N_SHUTTER_GROUPS = 4;
export const N_ROOMS = 10;

// ------------------------------------------------------------------------------------------------ constants

/** Material data of the skin: specific heat J/(kg·K), solar absorptance, IR emissivity, failure limit K. */
export const SKIN_MATERIAL: Record<SkinMaterial, { c: number; alpha: number; eps: number; limit: number }> = {
  rcc: { c: 1000, alpha: 0.9, eps: 0.85, limit: 1900 },
  glass: { c: 840, alpha: 0.3, eps: 0.85, limit: 450 }, // canopy frame: the seals
  aluminium: { c: 900, alpha: 0.3, eps: 0.85, limit: 775 },
  tile: { c: 900, alpha: 0.85, eps: 0.85, limit: 450 }, // aluminium under the tile: the 450 K bond line
  composite: { c: 1100, alpha: 0.5, eps: 0.85, limit: 450 },
  inconel: { c: 444, alpha: 0.6, eps: 0.75, limit: 1250 },
};

export const TPS_AREAL_C = 3500; // J/(m²·K)
export const TPS_K_OVER_T = 2.4; // W/(m²·K)
export const TPS_LIMIT = 1900;
export const SKIN_STRUCT_U = 0.3; // MLI + standoffs, W/(m²·K)
export const SKIN_LATERAL_G = 2; // between neighbouring zones, W/K
export const STRUCT_C = 2000 * 900;
export const STRUCT_G = 300;
export const ROOM_LINING_U = 1.5; // W/(m²·K) room → structure
export const FURNISH_C = 8000; // J/(K·m³)
export const DOOR_G = 15; // open door, still air, W/K
/** Fan exchange between neighbouring rooms: ρ·c_p·Q at Q = 0.2 m³/s (W2-D item 3). */
export const FAN_G = 1.2 * 1005 * 0.2;
export const PANE_C_PER_M2 = 0.03 * 2500 * 840; // 30 mm of glass, J/(m²·K)
export const PANE_IN_U = 3;
export const PANE_FRAME_G = 1;
export const SKIRT_C = 300 * 350;
export const SKIRT_AREA = 8;
export const SKIRT_LIMIT = 1800;
export const RAD_PANEL_AREA = 13; // one side of one panel, m²
export const RAD_C = 13 * 8 * 700 + 30 * 900;
export const LOOP_C = 400 * 900 + 600 * 500;
export const LOOP_LIMIT = 1150;
/** NaK-78 at 2.5 bar: saturation temperature, K, and melting point, K. */
export const LOOP_T_SAT = 1178;
export const LOOP_T_MELT = 261;
export const REACTOR_C = 12e6;
export const REACTOR_LOOP_G = 2e5;
/** Radiator pump: the largest flow per panel, kg/s, and NaK c_p: G_max = ṁ·c_p per panel. */
export const PUMP_MDOT = 20;
export const NAK_CP = 900;
export const PUMP_G_MAX = PUMP_MDOT * NAK_CP;
export const AVIONICS_C = 500 * 900;

/** Drive waste heat (D4): ε_d of the jet power ½·F·vₑ, and the share into the nozzle skirts (rest: the loop). */
export const DRIVE_WASTE_EPS = 4.4e-4;
export const DRIVE_SKIRT_SHARE = 0.8;
/** Interlocks (driveInhibit): skirt and loop limits, cleared this far below them. */
export const INHIBIT_SKIRT = SKIRT_LIMIT;
export const INHIBIT_LOOP = LOOP_LIMIT;
export const INHIBIT_HYST = 50;

/** Thermostats: room setpoint, deadband half-width and proportional band, K; per-room HVAC capacity, W. */
export const HVAC_SET = 294;
export const HVAC_DEAD = 0.5;
export const HVAC_BAND = 1.5;
/** The coolers reject into the dorsal-aft skin (a body-mounted low-temperature radiator panel). */
export const HVAC_SINK = Z_DORSAL_AFT;
/** Heat-pump COP: a fraction of Carnot, clamped. */
export const HVAC_CARNOT_FRAC = 0.4;
export const HVAC_COP_MAX = 8;
export const HVAC_COP_MIN = 1;
/** Radiator flow thermostat: full flow above LOOP_BYPASS_HI, trickle LOOP_TRICKLE below LOOP_BYPASS_LO, K. */
export const LOOP_BYPASS_LO = 310;
export const LOOP_BYPASS_HI = 350;
export const LOOP_TRICKLE = 0.05;

// ------------------------------------------------------------------------------------------------ build

const WREN = INTERIORS.wren!;
const ROOMS = WREN.rooms;

function boxVol(b: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }): number {
  return Math.max(0, b.max.x - b.min.x) * Math.max(0, b.max.y - b.min.y) * Math.max(0, b.max.z - b.min.z);
}
function clipVol(a: typeof ROOMS[number]['box'], b: typeof ROOMS[number]['box']): number {
  const dx = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
  const dy = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
  const dz = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
  return dx > 0 && dy > 0 && dz > 0 ? dx * dy * dz : 0;
}

/** Free air volume per room (box minus its solids), m³. */
export const ROOM_VOLUME: readonly number[] = ROOMS.map((r) => {
  let v = boxVol(r.box);
  for (const s of WREN.solids) if (s.room === r.id) v -= clipVol(r.box, s.box);
  return v;
});
/** Bounding surface per room, m² (lining area). */
export const ROOM_SURFACE: readonly number[] = ROOMS.map((r) => {
  const dx = r.box.max.x - r.box.min.x, dy = r.box.max.y - r.box.min.y, dz = r.box.max.z - r.box.min.z;
  return 2 * (dx * dy + dy * dz + dx * dz);
});
const roomIndex = (id: string): number => ROOMS.findIndex((r) => r.id === id);
/** Room → structure node. */
const ROOM_STRUCT: Record<string, number> = {
  cockpit: N_STRUCT_F, vestibule: N_STRUCT_F, lounge: N_STRUCT_F,
  corridor: N_STRUCT_M, 'cabin-port': N_STRUCT_M, 'cabin-stbd': N_STRUCT_M, washroom: N_STRUCT_M, suitroom: N_STRUCT_M,
  cargo: N_STRUCT_A, engineering: N_STRUCT_A,
};
/** HVAC capacity per room (heating and cooling each), W: 5 kW in all (W2-D item 2). */
export const HVAC_CAP: readonly number[] = ROOMS.map((r) => (r.id === 'cockpit' || r.id === 'lounge' ? 1200 : 325));

/** Window → shutter group, skin zone. */
const WINDOW_GROUP: Record<string, number> = {
  'w-front': 0, 'w-cockpit-port': 1, 'w-cockpit-stbd': 1, 'w-overhead': 1, 'w-lounge': 2, 'w-lounge-sky': 2, 'w-cabin-port': 3, 'w-cabin-stbd': 3,
};
const WINDOW_SKIN: Record<string, number> = {
  'w-front': Z_CANOPY, 'w-cockpit-port': Z_CANOPY, 'w-cockpit-stbd': Z_CANOPY, 'w-overhead': Z_CANOPY,
  'w-lounge': Z_FLANK_STBD, 'w-lounge-sky': Z_DORSAL_FWD, 'w-cabin-port': Z_FLANK_PORT, 'w-cabin-stbd': Z_FLANK_STBD,
};
const WALL_N: Record<string, [number, number, number]> = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-z': [0, 0, -1], '+z': [0, 0, 1] };

/** Skin zone → structure node. */
const ZONE_STRUCT = [N_STRUCT_F, N_STRUCT_F, N_STRUCT_F, N_STRUCT_M, N_STRUCT_F, N_STRUCT_A, N_STRUCT_M, N_STRUCT_M, N_STRUCT_M, N_STRUCT_M, N_STRUCT_A, N_STRUCT_A];
/** Neighbouring skin zones (lateral conduction through the skin). */
const ZONE_NEIGHBOURS: [number, number][] = [
  [Z_NOSE, Z_CANOPY], [Z_NOSE, Z_BELLY_FWD], [Z_NOSE, Z_FLANK_PORT], [Z_NOSE, Z_FLANK_STBD], [Z_CANOPY, Z_DORSAL_FWD],
  [Z_DORSAL_FWD, Z_DORSAL_AFT], [Z_BELLY_FWD, Z_BELLY_AFT], [Z_DORSAL_FWD, Z_FLANK_PORT], [Z_DORSAL_FWD, Z_FLANK_STBD],
  [Z_DORSAL_AFT, Z_FLANK_PORT], [Z_DORSAL_AFT, Z_FLANK_STBD], [Z_BELLY_FWD, Z_FLANK_PORT], [Z_BELLY_FWD, Z_FLANK_STBD],
  [Z_BELLY_AFT, Z_FLANK_PORT], [Z_BELLY_AFT, Z_FLANK_STBD], [Z_FLANK_PORT, Z_WING_PORT], [Z_FLANK_STBD, Z_WING_STBD],
  [Z_WING_PORT, Z_POD_PORT], [Z_WING_STBD, Z_POD_STBD], [Z_BELLY_AFT, Z_POD_PORT], [Z_BELLY_AFT, Z_POD_STBD],
  [Z_DORSAL_AFT, Z_POD_PORT], [Z_DORSAL_AFT, Z_POD_STBD],
];

const S2 = Math.SQRT1_2;
/** Eight facets of a cylinder along z (lateral area A): projected area ≈ 2rL toward any side. */
function cylinder(A: number, aftCap: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    out.push(Math.cos(a), Math.sin(a), 0, A / 8);
  }
  if (aftCap > 0) out.push(0, 0, 1, aftCap);
  return out;
}
/** Facets per zone (outward normals, craft axes: forward −Z, up +Y, right +X), as fractions of the zone area. */
const ZONE_FACETS: number[][] = [
  [0, 0, -1, 0.5, 0, S2, -S2, 0.15, 0, -S2, -S2, 0.15, S2, 0, -S2, 0.1, -S2, 0, -S2, 0.1], // nose
  [0, 1, 0, 0.5, 0, 0.6, -0.8, 0.5], // canopy
  [0, 1, 0, 0.8, S2, S2, 0, 0.1, -S2, S2, 0, 0.1], // dorsal fore
  [0, 1, 0, 0.8, S2, S2, 0, 0.1, -S2, S2, 0, 0.1], // dorsal aft
  [0, -1, 0, 0.8, S2, -S2, 0, 0.1, -S2, -S2, 0, 0.1], // belly fore (on the TPS node)
  [0, -1, 0, 0.8, S2, -S2, 0, 0.1, -S2, -S2, 0, 0.1], // belly aft (on the TPS node)
  [-1, 0, 0, 0.8, -S2, S2, 0, 0.1, -S2, -S2, 0, 0.1], // port flank
  [1, 0, 0, 0.8, S2, S2, 0, 0.1, S2, -S2, 0, 0.1], // starboard flank
  [0, 1, 0, 0.45, 0, -1, 0, 0.45, -1, 0, 0, 0.1], // port wing (both faces)
  [0, 1, 0, 0.45, 0, -1, 0, 0.45, 1, 0, 0, 0.1], // starboard wing
  [], [], // pods: cylinders, below
];

function build(): ThermalNetDef {
  const nodes: ThermalNodeDef[] = [];
  const links: ThermalLinkDef[] = [];
  const surfaces: ThermalSurfaceDef[] = [];
  const windows: ThermalWindowDef[] = [];
  const node = (id: string, C: number, T0: number, limit = Infinity, caution = Infinity): number => {
    nodes.push({ id, C, T0, limit, caution });
    return nodes.length - 1;
  };
  const link = (a: number, b: number, G: number): number => { links.push({ a, b, G }); return links.length - 1; };
  // window area per skin zone (removed from the zone's exterior surface)
  const winArea = new Array<number>(N_HULL_ZONES).fill(0);
  for (const w of WREN.windows) winArea[WINDOW_SKIN[w.id]] += w.width * w.height;
  // 0–11 skin
  HULL_ZONES.forEach((z) => {
    const m = SKIN_MATERIAL[z.material];
    node(`skin-${z.id}`, z.arealMass * z.area * m.c, z.material === 'tile' ? 270 : 280, m.limit, 0.8 * m.limit);
  });
  // 12, 13 TPS
  node('tps-belly-fwd', TPS_AREAL_C * HULL_ZONES[Z_BELLY_FWD].area, 250, TPS_LIMIT, 0.8 * TPS_LIMIT);
  node('tps-belly-aft', TPS_AREAL_C * HULL_ZONES[Z_BELLY_AFT].area, 250, TPS_LIMIT, 0.8 * TPS_LIMIT);
  // 14–16 structure (the pressure shell's seals)
  node('struct-fwd', STRUCT_C, 293, 450, 360);
  node('struct-mid', STRUCT_C, 293, 450, 360);
  node('struct-aft', STRUCT_C, 293, 450, 360);
  // 17, 18 skirts; 19, 20 radiators; 21 loop; 22 reactor; 23 avionics
  node('skirt-stbd', SKIRT_C, 250, SKIRT_LIMIT, SKIRT_LIMIT - 100);
  node('skirt-port', SKIRT_C, 250, SKIRT_LIMIT, SKIRT_LIMIT - 100);
  node('radiator-stbd', RAD_C, 300, 1200, 1150);
  node('radiator-port', RAD_C, 300, 1200, 1150);
  node('loop', LOOP_C, 320, LOOP_LIMIT, LOOP_LIMIT - 50);
  node('reactor-bay', REACTOR_C, 330, 1250, 1150);
  node('avionics', AVIONICS_C, 300, 358, 340);
  // 24–33 rooms
  ROOMS.forEach((r, i) => node(`room-${r.id}`, 1.2 * 1005 * ROOM_VOLUME[i] + FURNISH_C * ROOM_VOLUME[i], 294));
  // 34–37 pane groups
  const groupArea = [0, 0, 0, 0];
  for (const w of WREN.windows) groupArea[WINDOW_GROUP[w.id]] += w.width * w.height;
  ['pane-front', 'pane-cockpit', 'pane-lounge', 'pane-cabins'].forEach((id, g) => node(id, PANE_C_PER_M2 * groupArea[g], 290, 450, 360));

  // ---- links
  HULL_ZONES.forEach((z, i) => link(i, ZONE_STRUCT[i], SKIN_STRUCT_U * z.area));
  link(N_TPS_BF, Z_BELLY_FWD, TPS_K_OVER_T * HULL_ZONES[Z_BELLY_FWD].area);
  link(N_TPS_BA, Z_BELLY_AFT, TPS_K_OVER_T * HULL_ZONES[Z_BELLY_AFT].area);
  for (const [a, b] of ZONE_NEIGHBOURS) link(a, b, SKIN_LATERAL_G);
  link(N_STRUCT_F, N_STRUCT_M, STRUCT_G);
  link(N_STRUCT_M, N_STRUCT_A, STRUCT_G);
  ROOMS.forEach((r, i) => link(N_ROOM0 + i, ROOM_STRUCT[r.id], ROOM_LINING_U * ROOM_SURFACE[i]));
  for (const d of WREN.doors) FAN_LINKS.push(link(N_ROOM0 + roomIndex(d.a), N_ROOM0 + roomIndex(d.b), DOOR_G + FAN_G));
  for (const w of WREN.windows) {
    const g = WINDOW_GROUP[w.id], ri = roomIndex(w.room), A = w.width * w.height;
    link(N_PANE0 + g, N_ROOM0 + ri, PANE_IN_U * A);
    link(N_PANE0 + g, WINDOW_SKIN[w.id], PANE_FRAME_G);
    windows.push({ id: w.id, pane: N_PANE0 + g, room: N_ROOM0 + ri, skin: WINDOW_SKIN[w.id], group: g, n: WALL_N[w.wall], area: A, tau: 0.8, alphaGlass: 0.06, epsGlass: 0.85, alphaShutter: 0.3 });
  }
  link(N_SKIRT0, Z_POD_STBD, 40);
  link(N_SKIRT0 + 1, Z_POD_PORT, 40);
  link(N_RAD0, Z_FLANK_STBD, 5);
  link(N_RAD0 + 1, Z_FLANK_PORT, 5);
  link(N_LOOP, N_REACTOR, REACTOR_LOOP_G);
  PUMP_LINKS.push(link(N_LOOP, N_RAD0, PUMP_G_MAX));
  PUMP_LINKS.push(link(N_LOOP, N_RAD0 + 1, PUMP_G_MAX));
  link(N_LOOP, N_STRUCT_A, 20);
  link(N_REACTOR, N_ROOM0 + roomIndex('engineering'), 30);
  link(N_REACTOR, N_STRUCT_A, 50);
  link(N_AVIONICS, N_STRUCT_F, 100);
  link(N_AVIONICS, N_ROOM0 + roomIndex('cockpit'), 150);

  // ---- exterior surfaces
  const zoneNode: number[] = [];
  HULL_ZONES.forEach((z, i) => {
    const m = SKIN_MATERIAL[z.material];
    const exterior = i === Z_BELLY_FWD ? N_TPS_BF : i === Z_BELLY_AFT ? N_TPS_BA : i;
    zoneNode.push(exterior);
    const A = Math.max(0.2 * z.area, z.area - winArea[i]);
    const alpha = exterior === i ? m.alpha : 0.85, eps = exterior === i ? m.eps : 0.85;
    const f = i === Z_POD_PORT || i === Z_POD_STBD ? cylinder(0.85, 0.15) : ZONE_FACETS[i];
    const facets: number[] = [];
    for (let k = 0; k < f.length; k += 4) facets.push(f[k], f[k + 1], f[k + 2], f[k + 3] * A);
    surfaces.push({ node: exterior, alpha, eps, area: A, facets, radiator: -1 });
  });
  for (let e = 0; e < 2; e++) {
    surfaces.push({ node: N_SKIRT0 + e, alpha: 0.8, eps: 0.8, area: SKIRT_AREA, facets: cylinder(SKIRT_AREA, 0), radiator: -1 });
  }
  for (let k = 0; k < 2; k++) {
    surfaces.push({ node: N_RAD0 + k, alpha: 0.15, eps: 0.85, area: 2 * RAD_PANEL_AREA, facets: [0, 1, 0, RAD_PANEL_AREA, 0, -1, 0, RAD_PANEL_AREA], radiator: k });
  }
  return { nodes, links, surfaces, windows, zoneNode };
}

/** Link indices of the two radiator pump links (loop ↔ radiator k): G = flow·PUMP_G_MAX·radiatorHealth[k]. */
export const PUMP_LINKS: number[] = [];
/** Link indices of the door links (one per INTERIORS door): G = DOOR_G + fan·FAN_G. */
export const FAN_LINKS: number[] = [];

export const WREN_THERMAL: ThermalNetDef = build();
