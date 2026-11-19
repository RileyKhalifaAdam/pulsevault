// The cabin gas network of a ship interior (docs/SIMULATION.md W2-D items 3–4, W3-B items 1–3, 7): rooms with
// their free air volume, the openings between them (doors, valves) and to the outside (leaks, breaches), the
// ventilation ducts (fans) and the airlock pump, the window panes that fog, and where the life-support rack
// (O₂ regulator, CO₂ scrubber, condensing heat exchanger) sits. Pure data built from src/data/interiors.ts; no
// three.js, no DOM. Allocates only at build time.
//
// WIRING (wave 2; nothing here is called yet):
//   * setup.ts / load (derived, never saved): c.cabinNet = compileCabin(buildCabinNet(INTERIORS[visual]))
//     (src/world/cabin.ts) once per hull type with an interior; hulls without one get
//     compileCabin(lumpedCabinNet(volume)) (one room, no doors) so life support still runs.
//   * Index conventions other packages rely on: rooms in INTERIORS[visual].rooms order (the same order as
//     src/data/thermalNet.ts N_ROOM0 + i); orifice k < layout.doors.length is door k (layout.doors order),
//     then the `extra` orifices (equalisation valves, W3-B breaches) in the order given; panes in
//     layout.windows order (thermalNet WINDOW_GROUP maps each to its pane node).
//   * W3-B: breaches are `extra` orifices to BOUNDARY_SPACE with their full area; the hull damage sets their open
//     fraction (io.open[k]). Door leaves set the door orifices' open fraction. Nothing else changes.
//
// Geometry: a door's flow area is the product of its box's two largest extents (1.0 × 2.1 m = 2.1 m² for the
// Wren's spine doors, as the plan's A = 2.1 m²). Room volume = box minus the UNION of the solids in it (exact, by
// coordinate compression: overlapping solids such as the sofa and its back count once): 315.70 m³ of free air
// against the plan's 370.5 m³, which is the gross box volume.
// Ventilation (W2-D item 3, "fans exchange 0.2 m³/s between neighbours"): one inter-room ventilation duct per
// door, as on the ISS (an IMV fan pushes air through a duct into the next module; it returns through the
// hatchway). The ducts run outward from the life-support room (the tree root), so the return through each door
// is toward the rack. A duct is gated by its door: closing the door closes the duct valve.
// Supply diffuser (the draught, W3-B item 7 "0.1–0.2 m/s from supply to return grilles"): each fan duct ends in a
// low-velocity diffuser of face velocity DIFFUSER_U = 0.15 m/s (diameter √(4Q/(π·U)) = 1.30 m at 0.2 m³/s), aimed
// from the far end of the room at its return (the door to the parent). A round jet keeps its face velocity over
// its potential core (≈ 6.2 diameters = 8 m, longer than any Wren room), so the supply → return column moves at
// 0.15 m/s, while the room's volume-mean velocity is only Σ Q·Δx / V ≈ 0.01 m/s (the divergence theorem).

import type { V3 } from '../core/types';
import type { Box, InteriorLayout } from './interiors';

/** A boundary node index: orifices / ducts with b = BOUNDARY_SPACE lead to vacuum. Boundary j is −1 − j. */
export const BOUNDARY_SPACE = -1;

export interface CabinRoomDef {
  id: string;
  /** Free air volume, m³. */
  V: number;
  /** The room box (for the draft field's openings and bounds). */
  box: Box;
}

/** A sharp-edged opening: flow by the compressible orifice law (choked when the pressure ratio demands it). */
export interface CabinOrificeDef {
  id: string;
  /** Room index; `b` is a room index or a boundary (−1 − j). */
  a: number;
  b: number;
  /** Full flow area, m² (times the runtime open fraction). */
  A: number;
  /** Discharge coefficient (0.6 sharp-edged door / valve; 0.7 for a crack or a punched hole, choked). */
  Cd: number;
  /** Centre of the opening, ship axes, m. */
  pos: V3;
  /** Centre-to-centre distance of the two rooms, m (molecular diffusion through the opening). 0: none. */
  L: number;
  /** Open fraction at build time (doors 1, valves and breaches 0). */
  open0: number;
}

/** A ducted volumetric mover: a ventilation fan (group FAN) or the airlock pump (group PUMP). */
export interface CabinDuctDef {
  id: string;
  /** From room `a` (inlet grille) to room `b` (outlet grille), or to a boundary (−1 − j). */
  a: number;
  b: number;
  /** Volumetric flow at the inlet's conditions when on, m³/s. */
  Q: number;
  group: number;
  /** Orifice index whose open fraction gates this duct (its door), or −1. */
  gate: number;
  /** Grille centres (ship axes, m) and the grille radius used as the draft core, m. */
  inPos: V3;
  outPos: V3;
  grilleR: number;
  /** Supply jet: origin (centre of the diffuser face), unit direction and diffuser diameter (m; 0 = no jet, the
   *  outlet is a point source). */
  jetPos: V3;
  jetDir: V3;
  jetD: number;
}

export interface CabinPaneDef {
  id: string;
  room: number;
  /** Glazed area, m². */
  A: number;
}

export interface CabinNetDef {
  rooms: CabinRoomDef[];
  orifices: CabinOrificeDef[];
  ducts: CabinDuctDef[];
  panes: CabinPaneDef[];
  /** Life-support rack: the CO₂ scrubber intake, the condensing heat exchanger and the O₂ diffuser + sensor. */
  scrubberRoom: number;
  chxRoom: number;
  o2Room: number;
  /** Number of boundary nodes (boundary 0 = space; W3-B adds e.g. a docked station's cabin as boundary 1). Default:
   *  the most negative b used, at least 1. */
  nBoundary?: number;
}

/** Duct groups (each has its own switch input). */
export const DUCT_FAN = 0;
export const DUCT_PUMP = 1;
export const N_DUCT_GROUPS = 2;

/** Ventilation fan flow per door, m³/s (W2-D item 3), and the grille radius, m. */
export const FAN_Q = 0.2;
export const GRILLE_R = 0.15;
/** Supply diffuser face velocity, m/s (the plan's 0.1–0.2 m/s supply → return). */
export const DIFFUSER_U = 0.15;
/** Airlock pump: S = 0.04 m³/s (W3-B item 3). */
export const PUMP_Q = 0.04;
/** Door discharge coefficient (W2-D item 3) and the crack / hole coefficient (the plan's 239·C_d kg/s/m²). */
export const CD_DOOR = 0.6;
export const CD_HOLE = 0.7;

const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });

function boxVol(b: Box): number {
  return Math.max(0, b.max.x - b.min.x) * Math.max(0, b.max.y - b.min.y) * Math.max(0, b.max.z - b.min.z);
}
/** Volume of the union of boxes clipped to `room`, exact (coordinate compression; load time only). */
export function unionVolInRoom(room: Box, boxes: Box[]): number {
  const cl: Box[] = [];
  for (const b of boxes) {
    const mn = v3(Math.max(room.min.x, b.min.x), Math.max(room.min.y, b.min.y), Math.max(room.min.z, b.min.z));
    const mx = v3(Math.min(room.max.x, b.max.x), Math.min(room.max.y, b.max.y), Math.min(room.max.z, b.max.z));
    if (mx.x > mn.x && mx.y > mn.y && mx.z > mn.z) cl.push({ min: mn, max: mx });
  }
  if (cl.length === 0) return 0;
  const axis = (k: 'x' | 'y' | 'z'): number[] => [...new Set(cl.flatMap((b) => [b.min[k], b.max[k]]))].sort((p, q) => p - q);
  const xs = axis('x'), ys = axis('y'), zs = axis('z');
  let v = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const cx = (xs[i] + xs[i + 1]) / 2;
    for (let j = 0; j + 1 < ys.length; j++) {
      const cy = (ys[j] + ys[j + 1]) / 2;
      for (let k = 0; k + 1 < zs.length; k++) {
        const cz = (zs[k] + zs[k + 1]) / 2;
        if (cl.some((b) => cx > b.min.x && cx < b.max.x && cy > b.min.y && cy < b.max.y && cz > b.min.z && cz < b.max.z)) {
          v += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]) * (zs[k + 1] - zs[k]);
        }
      }
    }
  }
  return v;
}
const centre = (b: Box): V3 => v3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** Flow area of a door box: the product of its two largest extents. */
function doorArea(b: Box): number {
  const e = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].sort((p, q) => q - p);
  return e[0] * e[1];
}

export interface CabinBuildOptions {
  /** Root of the ventilation tree and the life-support rack's room (default 'engineering', else room 0). */
  rackRoom?: string;
  /** Extra orifices (equalisation valves, breaches, umbilicals) given by room ids; b = 'space' for vacuum, or
   *  'boundary:j' for boundary j (W3-B's docked umbilical: j = 1, its p, T, composition in io.bnd). */
  extra?: { id: string; a: string; b: string; A: number; Cd?: number; pos?: V3; open0?: number }[];
  /** Airlock pumps: from room `a` to room `b` (or 'space'). */
  pumps?: { id: string; a: string; b: string; Q?: number }[];
}

/**
 * The gas network of an interior layout. Rooms keep the layout order; door k is orifice k. Ventilation ducts:
 * one per door, outward from the rack room along the door tree.
 */
export function buildCabinNet(layout: InteriorLayout, opts: CabinBuildOptions = {}): CabinNetDef {
  const ri = (id: string): number => {
    if (id === 'space') return BOUNDARY_SPACE;
    if (id.startsWith('boundary:')) return -1 - Number(id.slice(9)); // e.g. 'boundary:1', a docked station's cabin
    const i = layout.rooms.findIndex((r) => r.id === id);
    if (i < 0) throw new Error(`cabinNet: no room '${id}'`);
    return i;
  };
  const rooms: CabinRoomDef[] = layout.rooms.map((r) => {
    const V = boxVol(r.box) - unionVolInRoom(r.box, layout.solids.filter((s) => s.room === r.id).map((s) => s.box));
    return { id: r.id, V, box: r.box };
  });
  const orifices: CabinOrificeDef[] = layout.doors.map((d) => {
    const a = ri(d.a), b = ri(d.b);
    return { id: d.id, a, b, A: doorArea(d.box), Cd: CD_DOOR, pos: centre(d.box), L: dist(centre(layout.rooms[a].box), centre(layout.rooms[b].box)), open0: 1 };
  });
  for (const e of opts.extra ?? []) {
    const a = ri(e.a), b = ri(e.b);
    const pos = e.pos ?? centre(layout.rooms[a].box);
    orifices.push({ id: e.id, a, b, A: e.A, Cd: e.Cd ?? CD_HOLE, pos, L: b >= 0 ? dist(centre(layout.rooms[a].box), centre(layout.rooms[b].box)) : 0, open0: e.open0 ?? 0 });
  }

  const rack = opts.rackRoom ?? (layout.rooms.some((r) => r.id === 'engineering') ? 'engineering' : layout.rooms[0].id);
  const root = ri(rack);

  // ventilation ducts: BFS over the doors from the rack room; one duct parent → child per door
  const ducts: CabinDuctDef[] = [];
  const seen = new Uint8Array(rooms.length);
  seen[root] = 1;
  const queue = [root];
  while (queue.length) {
    const p = queue.shift()!;
    layout.doors.forEach((d, k) => {
      const a = ri(d.a), b = ri(d.b);
      const c = a === p ? b : b === p ? a : -1;
      if (c < 0 || seen[c]) return;
      seen[c] = 1;
      queue.push(c);
      const dc = centre(d.box);
      const pb = layout.rooms[p].box, cb = layout.rooms[c].box;
      // inlet: on the parent's overhead, 0.5 m into the parent from the door; outlet: on the child's overhead,
      // on the far side of the child's centre from the door (clamped 0.3 m inside the box)
      const pc = centre(pb), cc = centre(cb);
      const inX = dc.x + 0.5 * Math.sign(pc.x - dc.x) * (Math.abs(pc.x - dc.x) > 0.2 ? 1 : 0);
      const inZ = dc.z + 0.5 * Math.sign(pc.z - dc.z) * (Math.abs(pc.z - dc.z) > 0.2 ? 1 : 0);
      const clampIn = (x: number, lo: number, hi: number): number => Math.min(hi - 0.3, Math.max(lo + 0.3, x));
      const outX = clampIn(cc.x + 0.6 * (cc.x - dc.x), cb.min.x, cb.max.x);
      const outZ = clampIn(cc.z + 0.6 * (cc.z - dc.z), cb.min.z, cb.max.z);
      // the diffuser face hangs below the overhead by its radius (not below the room's mid-height) and aims at
      // the return (the door's centre)
      const jetD = Math.sqrt(4 * FAN_Q / (Math.PI * DIFFUSER_U));
      const jy = Math.max(cc.y, cb.max.y - 0.05 - jetD / 2);
      const jetPos = v3(outX, jy, outZ);
      const ex = dc.x - outX, ey = dc.y - jy, ez = dc.z - outZ, el = Math.hypot(ex, ey, ez) || 1;
      ducts.push({
        id: `fan-${d.id}`, a: p, b: c, Q: FAN_Q, group: DUCT_FAN, gate: k,
        inPos: v3(clampIn(inX, pb.min.x, pb.max.x), pb.max.y - 0.05, clampIn(inZ, pb.min.z, pb.max.z)),
        outPos: v3(outX, cb.max.y - 0.05, outZ), grilleR: GRILLE_R,
        jetPos, jetDir: v3(ex / el, ey / el, ez / el), jetD,
      });
    });
  }
  for (const p of opts.pumps ?? []) {
    const a = ri(p.a), b = ri(p.b);
    const ab = layout.rooms[a].box;
    const inPos = v3((ab.min.x + ab.max.x) / 2, ab.min.y + 0.05, (ab.min.z + ab.max.z) / 2);
    const outPos = b >= 0 ? centre(layout.rooms[b].box) : inPos;
    ducts.push({ id: p.id, a, b, Q: p.Q ?? PUMP_Q, group: DUCT_PUMP, gate: -1, inPos, outPos, grilleR: GRILLE_R, jetPos: outPos, jetDir: v3(0, 0, 0), jetD: 0 });
  }
  const panes: CabinPaneDef[] = layout.windows.map((w) => ({ id: w.id, room: ri(w.room), A: w.width * w.height }));
  let nB = 1;
  for (const o of orifices) if (o.b < 0) nB = Math.max(nB, -o.b);
  for (const d of ducts) if (d.b < 0) nB = Math.max(nB, -d.b);
  return { rooms, orifices, ducts, panes, scrubberRoom: root, chxRoom: root, o2Room: root, nBoundary: nB };
}

/** One lumped room of volume V (hulls without an interior layout): no doors, no ducts, no panes. */
export function lumpedCabinNet(V: number): CabinNetDef {
  const s = Math.cbrt(V);
  const box: Box = { min: v3(-s / 2, -s / 2, -s / 2), max: v3(s / 2, s / 2, s / 2) };
  return { rooms: [{ id: 'cabin', V, box }], orifices: [], ducts: [], panes: [], scrubberRoom: 0, chxRoom: 0, o2Room: 0 };
}
