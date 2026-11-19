// The Wren's compartments as pure data (docs/SIMULATION.md W3-B items 1–3): the sliding pressure doors (one leaf per
// doorway of src/data/interiors.ts, with its equalisation valve), the dorsal docking hatch with its equalisation valve
// and the docking tunnel behind it, the suit room as the airlock (pump, dump valve), the breach openings (one per
// window, one panel hole per room), and the gas network that holds them all (src/data/cabinNet.ts + the tunnel room).
// No three.js, no DOM. Allocates only at build time.
//
// WIRING (wave 3): setup.ts / load, once per hull type with an interior (derived, never saved):
//     const comp = buildWrenCompartments();            // { def, idx, doors, hatch, vents, rooms }
//     c.cabinNet = compileCabin(comp.def)             // REPLACES compileCabin(buildCabinNet(INTERIORS.wren))
//     c.compNet  = compileCompartments(comp, c.cabinNet)   (src/world/compartments.ts)
//   The gas network keeps W2-D's index conventions (rooms 0..9 = INTERIORS.wren.rooms = thermalNet N_ROOM0 + i,
//   orifice k < 9 = door k, ducts: the 9 fan ducts, then the airlock pump) and appends: room 10 = the docking
//   tunnel (no thermal node: compartments.ts feeds it the corridor's temperature), orifices 9.. = the extras below
//   (EXTRA order), boundary 1 = the docked station's cabin (io.bnd slots 6..11). A save made before wave 3 has 10
//   rooms: cabin.ts loadCabin rejects the mis-sized array and starts a fresh atmosphere (loader default) — the hub
//   may instead copy the 10 saved rooms and add a vacuum tunnel (compartments.ts migrateCabinRooms).
//
// Numbers (each a design value of this file, SI):
//   Doors: the plan's 40 kg leaf for 2.1 m² (19 kg/m²), a 300 N current-limited motor, an unseating cam of mechanical
//     advantage 2 over a 4 mm stroke against a 200 N seal preload plus Δp·A (2.1 kN per kPa on a spine door): the
//     motor can unseat a door only below (2·300 − 200)/2.1 = 190 Pa, so it can never open toward vacuum; once
//     unseated the leaf runs on hardened rollers (rolling resistance 0.001 of the pressure load) so it closes
//     against the flow of a breach. Each door has a 3 cm² equalisation valve (≈ 2 cm bore) in its leaf.
//   Hatch: 0.8 m clear diameter (0.50 m²), 30 kg, opens into the corridor (the cabin pressure seats it), hinge at one
//     edge, handle 0.4 m from the hinge: a 100 N pull (a crew member braced on a handhold) lifts it off its seal
//     only below Δp = 100·0.4/(0.50·0.4) = 200 Pa (the plan's "opens only at Δp < 0.2 kPa"). A 10 cm² equalisation
//     valve (≈ 1.1 cm bore) fills the 1.5 m³ tunnel from vacuum to within 200 Pa in ≈ 1.3 min (tests).
//   Airlock (the suit room, 10.3 m³ free volume): a 0.04 m³/s roughing pump (the plan's S) back into the corridor,
//     compression-ratio limited (K₀ = 200, so S(p) = S₀·(1 − p_out/(K₀·p)) and the ultimate pressure is 0.5 kPa):
//     τ = V/S₀ = 258 s, 101 → 2 kPa in τ·ln((p₀ − p_u)/(p − p_u)) = 18.2 min (the critic's "about 16 min" with the
//     pump curve; the plan's 2.5 m³ and 4 min is a box the Wren does not have), then a 20 cm² dump valve to space (τ = 37 s, 2 kPa → 10 Pa in ≈ 3.3 min).
//   Breach: a cracked window leaks through 1 cm² (the plan's 7.4 h e-fold for 370 m³; 6.3 h for the Wren's 315.7 m³
//     of free air); a broken one opens its whole glazed area; a panel hit punches a hole of
//     φ·(E − u·d·A_f)/(u·d) (the crushed footprint at full crush depth, a fraction φ = 0.1 of which tears open; A_f
//     = 0.05 m² the impactor footprint below which the pressure shell is not perforated), ≤ 2 m² per room.

import type { V3 } from '../core/types';
import { BOUNDARY_SPACE, buildCabinNet, CD_DOOR, CD_HOLE, type CabinNetDef } from './cabinNet';
import { INTERIORS, type Box, type InteriorLayout } from './interiors';

const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });

// ------------------------------------------------------------------------------------------------ constants

/** Door leaf areal mass, kg/m² (the plan's 40 kg for 2.1 m²). */
export const DOOR_AREAL_MASS = 40 / 2.1;
/** Motor force limit (current-limited), N; slide speed limit, m/s; acceleration / deceleration of the profile, m/s². */
export const DOOR_F_MOTOR = 300;
export const DOOR_V_MAX = 1.0;
export const DOOR_A_DEC = 4;
/** Speed-loop time constant of the motor controller, s. */
export const DOOR_T_CTRL = 0.02;
/** Unseating cam: mechanical advantage, stroke (m), stroke time at no load (s), seal preload (N). */
export const DOOR_CAM_MA = 2;
export const DOOR_SEAT_STROKE = 0.004;
export const DOOR_SEAT_T = 0.15;
export const DOOR_SEAL_F = 200;
/** Rolling resistance of the unseated leaf as a fraction of its pressure load, and the Coulomb friction, N. */
export const DOOR_MU_ROLL = 0.001;
export const DOOR_F_COULOMB = 15;
/** Manual crank: force multiplication from the handle to the leaf, and the hand's force limit, N. */
export const DOOR_CRANK_MA = 20;
export const HAND_F_MAX = 150;
/** Auto-close: the pressure-drop sensor threshold, Pa/s (either side). */
export const DOOR_AUTO_DPDT = -500;
/** Equalisation valve in each door leaf, m². */
export const DOOR_VALVE_A = 3e-4;

/** Hatch: clear diameter (m), mass (kg), hinge damping (N·m·s), full-open angle (rad), handle arm (m), crew pull (N). */
export const HATCH_D = 0.8;
export const HATCH_MASS = 30;
export const HATCH_DAMP = 3;
export const HATCH_OPEN = 1.75;
export const HATCH_ARM = 0.4;
export const CREW_PULL_MAX = 100;
/** Angle over which the seal still carries the pressure load, rad (the hatch lifts 1 mm at its far edge per 1.25 mrad). */
export const HATCH_SEAL_ANGLE = 0.005;
/** Dog handle: time to drive the dogs fully in or out, s. */
export const HATCH_DOG_T = 3;
/** Hatch equalisation valve, m² (1 cm²: the tunnel fills in ≈ 1.3 min, a procedure you wait through). */
export const HATCH_VALVE_A = 1e-4;

/** Docking tunnel (collar to collar), m³; the open collar to space (undocked), m²; the station's umbilical and hatch, m². */
export const TUNNEL_V = 1.5;
export const COLLAR_A = Math.PI * 0.4 * 0.4;
export const UMBILICAL_A = 5e-4;
export const STATION_HATCH_A = Math.PI * 0.4 * 0.4;

/** Airlock pump: speed S₀ (m³/s, the plan's S), compression-ratio limit K₀, isothermal efficiency, motor limit (W). */
export const AIRLOCK_S0 = 0.04;
export const AIRLOCK_K0 = 200;
export const AIRLOCK_PUMP_ETA = 0.5;
export const AIRLOCK_PUMP_PMAX = 3000;
/** The pump duct's nominal flow in the gas network, m³/s: 2·S₀ of headroom so the exact-decay flow factor fits ≤ 1. */
export const AIRLOCK_DUCT_Q = 2 * AIRLOCK_S0;
/** The sequencer: pump-down end pressure (the plan's 2 kPa), dump to vacuum below (Pa), dump valve area (m²). */
export const AIRLOCK_P_PUMPED = 2000;
export const AIRLOCK_P_VAC = 10;
export const AIRLOCK_DUMP_A = 2e-3;

/** Breach: crack leak area (m²), panel hole cap per room (m²), impactor footprint (m²), torn fraction of the crushed
 *  footprint, reach from a room box to the outer skin (m). */
export const CRACK_A = 1e-4;
export const HOLE_A_MAX = 2;
export const PERF_FOOTPRINT = 0.05;
export const HOLE_PHI = 0.1;
export const HULL_REACH = 1.0;
/** Free-convection film coefficient for the gas ↔ wall exchange during a blowdown, W/(m²·K). */
export const WALL_H = 10;

// ------------------------------------------------------------------------------------------------ defs

export interface DoorDef {
  id: string;
  /** Room indices of the two sides. */
  a: number;
  b: number;
  /** Gas-network orifice of the doorway and of the leaf's equalisation valve. */
  orifice: number;
  valve: number;
  /** Clear width (along the slide axis) and height, m; flow area W·H. */
  W: number;
  H: number;
  A: number;
  mass: number;
  /** The doorway box (closed leaf), the slide axis (unit, ship axes) and the wall normal axis index (0 x, 2 z). */
  box: Box;
  slide: V3;
  normalAxis: number;
}

export interface HatchDef {
  /** Gas-network orifice of the hatch and its equalisation valve; rooms (corridor side, tunnel side). */
  orifice: number;
  valve: number;
  room: number;
  tunnel: number;
  D: number;
  A: number;
  mass: number;
  /** Moment of inertia about the hinge, kg·m² (a uniform disc about a tangent line: m·(D/2)²·5/4). */
  I: number;
  /** Hatch centre and the hinge axis (unit), ship axes. */
  pos: V3;
  hinge: V3;
}

/** A vent opening to space: where the gas leaves, which way, from which room (exterior side, ship axes). */
export interface VentDef {
  id: string;
  orifice: number;
  room: number;
  pos: V3;
  normal: V3;
  /** 'window' | 'hole' | 'dump' | 'collar'. */
  kind: string;
  /** Window: the damage component id (src/data/hullZones.ts) whose state opens it. */
  component: string;
}

export interface CompartmentIndex {
  nRooms: number;
  tunnel: number;
  corridor: number;
  airlock: number;
  /** Orifices. */
  doorValve0: number;
  window0: number;
  nWindows: number;
  hole0: number;
  dump: number;
  hatchValve: number;
  hatch: number;
  collar: number;
  umbilical: number;
  stationHatch: number;
  /** Duct index of the airlock pump. */
  pumpDuct: number;
  /** Boundary index of the docked station (io.bnd slot base = BND_STRIDE · this). */
  stationBoundary: number;
}

export interface WrenCompartments {
  def: CabinNetDef;
  idx: CompartmentIndex;
  doors: DoorDef[];
  hatch: HatchDef;
  vents: VentDef[];
  /** Room boxes (layout rooms, then the tunnel), for the breach map. */
  boxes: Box[];
  /** Room interior wall area (box surface), m², for the gas ↔ wall exchange. */
  wallA: number[];
}

const WALL_NORMAL: Record<string, V3> = { '+x': v3(1, 0, 0), '-x': v3(-1, 0, 0), '+y': v3(0, 1, 0), '-z': v3(0, 0, -1), '+z': v3(0, 0, 1) };
/** How far outside the window's interior face the gas leaves the hull (the window's exterior), m. */
const WINDOW_OUT = 0.3;

function boxArea(b: Box): number {
  const x = b.max.x - b.min.x, y = b.max.y - b.min.y, z = b.max.z - b.min.z;
  return 2 * (x * y + y * z + z * x);
}

/**
 * The Wren's compartments: the gas network (W2-D's rooms, doors and fans, plus the W3-B extras and the docking
 * tunnel), the door, hatch and vent definitions with their orifice indices.
 */
export function buildWrenCompartments(layout: InteriorLayout = INTERIORS.wren!): WrenCompartments {
  const ri = (id: string): number => layout.rooms.findIndex((r) => r.id === id);
  const nL = layout.rooms.length;
  const extra: { id: string; a: string; b: string; A: number; Cd?: number; pos?: V3; open0?: number }[] = [];
  // door equalisation valves (9)
  for (const d of layout.doors) {
    const c = v3((d.box.min.x + d.box.max.x) / 2, (d.box.min.y + d.box.max.y) / 2, (d.box.min.z + d.box.max.z) / 2);
    extra.push({ id: `valve-${d.id}`, a: d.a, b: d.b, A: DOOR_VALVE_A, Cd: CD_DOOR, pos: c, open0: 0 });
  }
  // windows (8): the glazed area, to space, at the interior face
  for (const w of layout.windows) extra.push({ id: `breach-${w.id}`, a: w.room, b: 'space', A: w.width * w.height, Cd: CD_HOLE, pos: { ...w.center }, open0: 0 });
  // one panel hole per room (position set at the breach)
  for (const r of layout.rooms) {
    const b = r.box;
    extra.push({ id: `hole-${r.id}`, a: r.id, b: 'space', A: HOLE_A_MAX, Cd: CD_HOLE, pos: v3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2), open0: 0 });
  }
  // airlock dump valve (suit room outboard wall)
  const sb = layout.rooms[ri('suitroom')].box;
  const dumpPos = v3(sb.max.x, 0.2, (sb.min.z + sb.max.z) / 2);
  extra.push({ id: 'airlock-dump', a: 'suitroom', b: 'space', A: AIRLOCK_DUMP_A, Cd: CD_HOLE, pos: dumpPos, open0: 0 });
  const def = buildCabinNet(layout, { extra, pumps: [{ id: 'airlock-pump', a: 'suitroom', b: 'corridor', Q: AIRLOCK_DUCT_Q }] });

  // the docking tunnel: room nL, above the corridor's overhead at the dorsal collar
  const hatchItem = layout.interactables.find((i) => i.kind === 'hatch');
  const hp = hatchItem ? v3(hatchItem.pos.x, 1.4, hatchItem.pos.z) : v3(0, 1.4, 2.2);
  const tunnelBox: Box = { min: v3(hp.x - 0.6, 1.4, hp.z - 0.6), max: v3(hp.x + 0.6, 1.4 + TUNNEL_V / 1.44, hp.z + 0.6) };
  const corridor = ri('corridor');
  const tunnel = nL;
  def.rooms.push({ id: 'tunnel', V: TUNNEL_V, box: tunnelBox });
  const nO0 = def.orifices.length;
  const L = 0.6;
  def.orifices.push({ id: 'hatch-valve', a: corridor, b: tunnel, A: HATCH_VALVE_A, Cd: CD_DOOR, pos: { ...hp }, L: 0, open0: 0 });
  def.orifices.push({ id: 'hatch', a: corridor, b: tunnel, A: Math.PI * HATCH_D * HATCH_D / 4, Cd: CD_DOOR, pos: { ...hp }, L, open0: 0 });
  const collarPos = v3(hp.x, tunnelBox.max.y, hp.z);
  def.orifices.push({ id: 'collar', a: tunnel, b: BOUNDARY_SPACE, A: COLLAR_A, Cd: CD_DOOR, pos: collarPos, L: 0, open0: 1 });
  def.orifices.push({ id: 'umbilical', a: tunnel, b: -2, A: UMBILICAL_A, Cd: CD_HOLE, pos: collarPos, L: 0, open0: 0 });
  def.orifices.push({ id: 'station-hatch', a: tunnel, b: -2, A: STATION_HATCH_A, Cd: CD_DOOR, pos: collarPos, L: 0, open0: 0 });
  def.nBoundary = 2;

  const nD = layout.doors.length, nW = layout.windows.length;
  const idx: CompartmentIndex = {
    nRooms: nL + 1, tunnel, corridor, airlock: ri('suitroom'),
    doorValve0: nD, window0: 2 * nD, nWindows: nW, hole0: 2 * nD + nW, dump: 2 * nD + nW + nL,
    hatchValve: nO0, hatch: nO0 + 1, collar: nO0 + 2, umbilical: nO0 + 3, stationHatch: nO0 + 4,
    pumpDuct: def.ducts.findIndex((d) => d.id === 'airlock-pump'), stationBoundary: 1,
  };
  if (def.orifices[idx.dump].id !== 'airlock-dump' || def.orifices[idx.window0].id !== `breach-${layout.windows[0].id}`) throw new Error('compartments: orifice order');

  const doors: DoorDef[] = layout.doors.map((d, k) => {
    const ex = d.box.max.x - d.box.min.x, ez = d.box.max.z - d.box.min.z;
    const normalAxis = ex < ez ? 0 : 2;
    const W = normalAxis === 0 ? ez : ex, H = d.box.max.y - d.box.min.y;
    return {
      id: d.id, a: ri(d.a), b: ri(d.b), orifice: k, valve: nD + k, W, H, A: W * H, mass: DOOR_AREAL_MASS * W * H,
      box: { min: { ...d.box.min }, max: { ...d.box.max } }, slide: normalAxis === 0 ? v3(0, 0, 1) : v3(1, 0, 0), normalAxis,
    };
  });
  const hatch: HatchDef = {
    orifice: idx.hatch, valve: idx.hatchValve, room: corridor, tunnel, D: HATCH_D, A: Math.PI * HATCH_D * HATCH_D / 4, mass: HATCH_MASS,
    I: HATCH_MASS * (HATCH_D / 2) * (HATCH_D / 2) * 1.25, pos: hp, hinge: v3(1, 0, 0),
  };
  const vents: VentDef[] = [];
  layout.windows.forEach((w, i) => {
    const n = WALL_NORMAL[w.wall];
    vents.push({ id: w.id, orifice: idx.window0 + i, room: ri(w.room), pos: v3(w.center.x + n.x * WINDOW_OUT, w.center.y + n.y * WINDOW_OUT, w.center.z + n.z * WINDOW_OUT), normal: { ...n }, kind: 'window', component: w.id });
  });
  layout.rooms.forEach((r, i) => vents.push({ id: `hole-${r.id}`, orifice: idx.hole0 + i, room: i, pos: { ...def.orifices[idx.hole0 + i].pos }, normal: v3(0, 1, 0), kind: 'hole', component: '' }));
  vents.push({ id: 'airlock-dump', orifice: idx.dump, room: idx.airlock, pos: v3(dumpPos.x + 0.4, dumpPos.y, dumpPos.z), normal: v3(1, 0, 0), kind: 'dump', component: '' });
  vents.push({ id: 'collar', orifice: idx.collar, room: tunnel, pos: collarPos, normal: v3(0, 1, 0), kind: 'collar', component: '' });
  const boxes = [...layout.rooms.map((r) => r.box), tunnelBox];
  const wallA = boxes.map(boxArea);
  return { def, idx, doors, hatch, vents, boxes, wallA };
}
