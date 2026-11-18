// Ship interiors as pure data (no three.js): the single source both the physics (crew collision, mag-boot
// decks, interactables) and the renderer (walls, furniture, windows) are built from.
//
// Ship-local axes: forward -Z, up +Y, right (starboard) +X; metres. The crew can occupy the union of the room
// boxes and the door boxes, minus the solids. Walls are the room faces; a door is an opening where two rooms
// touch. Decks are the floors of the rooms (y = box.min.y): that is what magnetic boots grip.

import type { ShipVisualId, V3 } from '../core/types';

export interface Box {
  min: V3;
  max: V3;
}

export interface InteriorRoom {
  id: string;
  name: string;
  box: Box;
}

/** A doorway: a small box straddling the shared wall of rooms `a` and `b`; walkable. */
export interface InteriorDoor {
  id: string;
  a: string;
  b: string;
  box: Box;
}

export type SolidKind =
  | 'seat'
  | 'console'
  | 'counter'
  | 'cabinet'
  | 'table'
  | 'bench'
  | 'sofa'
  | 'bunk'
  | 'locker'
  | 'fixture'
  | 'machinery'
  | 'rack'
  | 'workbench';

/** Furniture and equipment: blocks the crew, and tells the renderer what to model inside this box. */
export interface InteriorSolid {
  id: string;
  kind: SolidKind;
  room: string;
  box: Box;
}

/** A window opening in a room face. `wall` names the face by its outward normal. */
export interface InteriorWindow {
  id: string;
  room: string;
  wall: '+x' | '-x' | '+y' | '-z' | '+z';
  /** Centre of the opening on that face. */
  center: V3;
  /** Size along the face's two in-plane axes (horizontal first; for '+y' it is x then z), m. */
  width: number;
  height: number;
}

export type InteractKind = 'helm' | 'bunk' | 'lights' | 'hatch' | 'galley' | 'tableSeat' | 'washroom' | 'reactor';

export interface Interactable {
  id: string;
  kind: InteractKind;
  room: string;
  /** Where the thing is; the crew must be within `radius` of it and roughly facing it. */
  pos: V3;
  radius: number;
  /** Button text, e.g. "Take the helm". */
  label: string;
}

export interface InteriorLayout {
  shipId: ShipVisualId;
  rooms: InteriorRoom[];
  doors: InteriorDoor[];
  solids: InteriorSolid[];
  windows: InteriorWindow[];
  interactables: Interactable[];
  /** Where the pilot stands after leaving the helm: feet position and facing (yaw about +Y, 0 = facing -Z). */
  spawn: { pos: V3; yaw: number };
  /** Seated pilot: eye point for the cockpit view. */
  helmEye: V3;
  /** Eye point when lying in the bunk and when sitting at the table. */
  bunkEye: V3;
  tableEye: V3;
}

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box => ({
  min: v(x0, y0, z0),
  max: v(x1, y1, z1),
});

/** Deck (floor) and overhead (ceiling) heights of the Wren's single deck. */
const F = -0.75;
const C = 1.35;

/**
 * Halcyon Wren — a 16 m courier with one deck, 11 m of living space front to back:
 * cockpit · cabin (galley, table, sofa, dorsal docking hatch) · corridor with bunk room, washroom and
 * locker room off it · engineering bay.
 */
const WREN: InteriorLayout = {
  shipId: 'wren',
  rooms: [
    { id: 'cockpit', name: 'Cockpit', box: box(-1.3, F, -5.6, 1.3, C, -2.6) },
    { id: 'cabin', name: 'Cabin', box: box(-1.6, F, -2.6, 1.6, C, 1.9) },
    { id: 'corridor', name: 'Corridor', box: box(-0.5, F, 1.9, 0.5, C, 5.0) },
    { id: 'bunks', name: 'Bunk room', box: box(0.5, F, 1.9, 1.6, C, 4.6) },
    { id: 'washroom', name: 'Washroom', box: box(-1.6, F, 1.9, -0.5, C, 3.5) },
    { id: 'lockers', name: 'Locker room', box: box(-1.6, F, 3.5, -0.5, C, 4.6) },
    { id: 'engineering', name: 'Engineering', box: box(-1.6, F, 5.0, 1.6, C, 7.2) },
  ],
  doors: [
    { id: 'd-cockpit', a: 'cockpit', b: 'cabin', box: box(-0.45, F, -2.75, 0.45, 1.25, -2.45) },
    { id: 'd-corridor', a: 'cabin', b: 'corridor', box: box(-0.45, F, 1.75, 0.45, 1.25, 2.05) },
    { id: 'd-bunks', a: 'corridor', b: 'bunks', box: box(0.35, F, 2.6, 0.65, 1.25, 3.5) },
    { id: 'd-washroom', a: 'corridor', b: 'washroom', box: box(-0.65, F, 2.3, -0.35, 1.25, 3.1) },
    { id: 'd-lockers', a: 'corridor', b: 'lockers', box: box(-0.65, F, 3.65, -0.35, 1.25, 4.45) },
    { id: 'd-engineering', a: 'corridor', b: 'engineering', box: box(-0.45, F, 4.85, 0.45, 1.25, 5.15) },
  ],
  solids: [
    // cockpit
    { id: 'console', kind: 'console', room: 'cockpit', box: box(-1.3, F, -5.6, 1.3, 0.25, -4.75) },
    { id: 'pedestal', kind: 'console', room: 'cockpit', box: box(-0.2, F, -4.75, 0.2, -0.05, -3.9) },
    { id: 'seat-pilot', kind: 'seat', room: 'cockpit', box: box(-0.85, F, -4.4, -0.25, 0.35, -3.7) },
    { id: 'seat-copilot', kind: 'seat', room: 'cockpit', box: box(0.25, F, -4.4, 0.85, 0.35, -3.7) },
    // cabin: galley along the port wall, table and benches to starboard, sofa aft to port
    { id: 'galley', kind: 'counter', room: 'cabin', box: box(-1.6, F, -2.2, -1.0, 0.15, 0.2) },
    { id: 'galley-upper', kind: 'cabinet', room: 'cabin', box: box(-1.6, 0.75, -2.2, -1.25, C, 0.2) },
    { id: 'table', kind: 'table', room: 'cabin', box: box(0.75, F, -1.6, 1.6, 0.02, -0.4) },
    { id: 'bench-fore', kind: 'bench', room: 'cabin', box: box(0.75, F, -2.3, 1.6, -0.3, -1.75) },
    { id: 'bench-aft', kind: 'bench', room: 'cabin', box: box(0.75, F, -0.25, 1.6, -0.3, 0.3) },
    { id: 'sofa', kind: 'sofa', room: 'cabin', box: box(-1.6, F, 0.5, -0.9, -0.3, 1.7) },
    // bunk room
    { id: 'bunk-lower', kind: 'bunk', room: 'bunks', box: box(0.95, F, 2.0, 1.6, -0.25, 4.5) },
    { id: 'bunk-upper', kind: 'bunk', room: 'bunks', box: box(0.95, 0.45, 2.0, 1.6, 0.6, 4.5) },
    // washroom and lockers
    { id: 'wash-fixture', kind: 'fixture', room: 'washroom', box: box(-1.6, F, 1.95, -1.2, 0.1, 2.6) },
    { id: 'lockers', kind: 'locker', room: 'lockers', box: box(-1.6, F, 3.55, -1.25, C, 4.55) },
    // engineering
    { id: 'reactor', kind: 'machinery', room: 'engineering', box: box(-0.7, F, 6.3, 0.7, 1.0, 7.2) },
    { id: 'racks', kind: 'rack', room: 'engineering', box: box(-1.6, F, 5.2, -1.1, C, 6.2) },
    { id: 'workbench', kind: 'workbench', room: 'engineering', box: box(1.0, F, 5.2, 1.6, 0.15, 6.4) },
  ],
  windows: [
    { id: 'w-front', room: 'cockpit', wall: '-z', center: v(0, 0.6, -5.6), width: 2.2, height: 1.0 },
    { id: 'w-cockpit-port', room: 'cockpit', wall: '-x', center: v(-1.3, 0.6, -4.3), width: 1.6, height: 0.8 },
    { id: 'w-cockpit-stbd', room: 'cockpit', wall: '+x', center: v(1.3, 0.6, -4.3), width: 1.6, height: 0.8 },
    { id: 'w-overhead', room: 'cockpit', wall: '+y', center: v(0, C, -4.2), width: 1.6, height: 1.4 },
    { id: 'w-table', room: 'cabin', wall: '+x', center: v(1.6, 0.55, -1.0), width: 1.6, height: 0.7 },
    { id: 'w-sofa', room: 'cabin', wall: '-x', center: v(-1.6, 0.6, 1.1), width: 1.0, height: 0.6 },
    { id: 'w-bunk', room: 'bunks', wall: '+x', center: v(1.6, 0.9, 3.25), width: 0.5, height: 0.4 },
  ],
  interactables: [
    { id: 'helm', kind: 'helm', room: 'cockpit', pos: v(-0.55, 0.0, -3.7), radius: 1.1, label: 'Take the helm' },
    { id: 'lights', kind: 'lights', room: 'cabin', pos: v(-0.6, 0.45, -2.5), radius: 0.9, label: 'Cabin lights' },
    { id: 'galley', kind: 'galley', room: 'cabin', pos: v(-1.0, 0.2, -1.0), radius: 0.9, label: 'Use the galley' },
    { id: 'table', kind: 'tableSeat', room: 'cabin', pos: v(0.75, 0.0, -1.0), radius: 0.9, label: 'Sit by the window' },
    { id: 'hatch', kind: 'hatch', room: 'cabin', pos: v(0, 1.2, 1.15), radius: 1.2, label: 'Docking hatch' },
    { id: 'bunk', kind: 'bunk', room: 'bunks', pos: v(0.95, -0.2, 3.2), radius: 0.9, label: 'Lie down' },
    { id: 'washroom', kind: 'washroom', room: 'washroom', pos: v(-1.2, 0.1, 2.3), radius: 0.8, label: 'Wash up' },
    { id: 'reactor', kind: 'reactor', room: 'engineering', pos: v(0, 0.3, 6.3), radius: 1.0, label: 'Reactor status' },
  ],
  spawn: { pos: v(-0.55, F, -3.3), yaw: 0 },
  helmEye: v(-0.55, 0.5, -4.05),
  bunkEye: v(1.25, 0.0, 2.5),
  tableEye: v(1.15, 0.45, -2.0),
};

export const INTERIORS: Partial<Record<ShipVisualId, InteriorLayout>> = { wren: WREN };
