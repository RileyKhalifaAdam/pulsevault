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

/** Deck (floor) and overhead (ceiling) heights: one deck, 2.4 m of headroom. */
const F = -1.0;
const C = 1.4;

/**
 * Corvane Wren — a ~31 m courier you can live in. One deck, 28 m of living space front to back, laid out
 * along a central spine:
 *   cockpit · companionway · lounge (open galley to port, curved sofa under a big starboard window,
 *   skylight) · corridor (port cabin, starboard cabin, washroom, suit room off it; dorsal docking hatch in
 *   its overhead) · cargo bay (ventral ramp in its floor, sealed in flight) · engineering.
 * The cockpit and everything in it is the previous Wren cockpit moved by (0, -0.25, -9.4), so the pilot's
 * reach and sight lines are unchanged; src/data/cockpit.ts applies the same offset.
 */
const WREN: InteriorLayout = {
  shipId: 'wren',
  rooms: [
    { id: 'cockpit', name: 'Cockpit', box: box(-1.7, F, -15.0, 1.7, C, -11.6) },
    { id: 'vestibule', name: 'Companionway', box: box(-1.0, F, -11.6, 1.0, C, -10.4) },
    { id: 'lounge', name: 'Lounge', box: box(-3.2, F, -10.4, 3.2, C, -4.6) },
    { id: 'corridor', name: 'Corridor', box: box(-0.9, F, -4.6, 0.9, C, 3.0) },
    { id: 'cabin-port', name: 'Port cabin', box: box(-3.2, F, -4.6, -0.9, C, -1.0) },
    { id: 'cabin-stbd', name: 'Starboard cabin', box: box(0.9, F, -4.6, 3.2, C, -1.0) },
    { id: 'washroom', name: 'Washroom', box: box(-3.2, F, -1.0, -0.9, C, 1.6) },
    { id: 'suitroom', name: 'Suit room', box: box(0.9, F, -1.0, 3.2, C, 1.6) },
    { id: 'cargo', name: 'Cargo bay', box: box(-3.2, F, 3.0, 3.2, C, 10.0) },
    { id: 'engineering', name: 'Engineering', box: box(-2.4, F, 10.0, 2.4, C, 13.4) },
  ],
  doors: [
    { id: 'd-cockpit', a: 'cockpit', b: 'vestibule', box: box(-0.5, F, -11.75, 0.5, 1.1, -11.45) },
    { id: 'd-lounge', a: 'vestibule', b: 'lounge', box: box(-0.5, F, -10.55, 0.5, 1.1, -10.25) },
    { id: 'd-corridor', a: 'lounge', b: 'corridor', box: box(-0.5, F, -4.75, 0.5, 1.1, -4.45) },
    { id: 'd-cabin-port', a: 'corridor', b: 'cabin-port', box: box(-1.05, F, -2.0, -0.75, 1.1, -1.2) },
    { id: 'd-cabin-stbd', a: 'corridor', b: 'cabin-stbd', box: box(0.75, F, -2.0, 1.05, 1.1, -1.2) },
    { id: 'd-washroom', a: 'corridor', b: 'washroom', box: box(-1.05, F, -0.4, -0.75, 1.1, 0.4) },
    { id: 'd-suitroom', a: 'corridor', b: 'suitroom', box: box(0.75, F, -0.4, 1.05, 1.1, 0.4) },
    { id: 'd-cargo', a: 'corridor', b: 'cargo', box: box(-0.8, F, 2.85, 0.8, 1.1, 3.15) },
    { id: 'd-engineering', a: 'cargo', b: 'engineering', box: box(-0.5, F, 9.85, 0.5, 1.1, 10.15) },
  ],
  solids: [
    // cockpit (the previous Wren cockpit, moved by (0, -0.25, -9.4); console widened to the new walls)
    { id: 'console', kind: 'console', room: 'cockpit', box: box(-1.7, F, -15.0, 1.7, 0.0, -14.15) },
    { id: 'pedestal', kind: 'console', room: 'cockpit', box: box(-0.2, F, -14.15, 0.2, -0.3, -13.3) },
    { id: 'seat-pilot', kind: 'seat', room: 'cockpit', box: box(-0.85, F, -13.8, -0.25, 0.1, -13.1) },
    { id: 'seat-copilot', kind: 'seat', room: 'cockpit', box: box(0.25, F, -13.8, 0.85, 0.1, -13.1) },
    { id: 'console-port', kind: 'console', room: 'cockpit', box: box(-1.7, F, -14.15, -1.25, -0.25, -12.6) },
    { id: 'console-stbd', kind: 'console', room: 'cockpit', box: box(1.25, F, -14.15, 1.7, -0.25, -12.6) },
    // lounge: open galley along the port wall, curved sofa under the starboard window, low table
    { id: 'fridge', kind: 'cabinet', room: 'lounge', box: box(-3.2, F, -10.4, -2.4, C, -9.9) },
    { id: 'galley', kind: 'counter', room: 'lounge', box: box(-3.2, F, -9.9, -2.55, -0.08, -5.6) },
    { id: 'galley-upper', kind: 'cabinet', room: 'lounge', box: box(-3.2, 0.6, -9.9, -2.85, C, -5.6) },
    { id: 'sofa', kind: 'sofa', room: 'lounge', box: box(1.75, F, -9.7, 3.2, -0.55, -5.3) },
    { id: 'sofa-back', kind: 'sofa', room: 'lounge', box: box(2.75, F, -9.7, 3.2, -0.1, -5.3) },
    { id: 'table', kind: 'table', room: 'lounge', box: box(0.55, F, -8.4, 1.45, -0.3, -6.6) },
    // port cabin
    { id: 'bed-port', kind: 'bunk', room: 'cabin-port', box: box(-3.2, F, -4.5, -2.0, -0.45, -2.3) },
    { id: 'wardrobe-port', kind: 'locker', room: 'cabin-port', box: box(-3.2, F, -1.6, -2.6, C, -1.0) },
    { id: 'desk-port', kind: 'table', room: 'cabin-port', box: box(-1.9, F, -4.6, -1.0, -0.25, -4.05) },
    // starboard cabin
    { id: 'bed-stbd', kind: 'bunk', room: 'cabin-stbd', box: box(2.0, F, -4.5, 3.2, -0.45, -2.3) },
    { id: 'wardrobe-stbd', kind: 'locker', room: 'cabin-stbd', box: box(2.6, F, -1.6, 3.2, C, -1.0) },
    { id: 'desk-stbd', kind: 'table', room: 'cabin-stbd', box: box(1.0, F, -4.6, 1.9, -0.25, -4.05) },
    // washroom
    { id: 'wash-sink', kind: 'fixture', room: 'washroom', box: box(-3.2, F, -1.0, -2.75, -0.15, -0.45) },
    { id: 'wash-toilet', kind: 'fixture', room: 'washroom', box: box(-3.2, F, -0.25, -2.65, -0.55, 0.3) },
    { id: 'wash-shower', kind: 'fixture', room: 'washroom', box: box(-3.2, F, 0.6, -2.15, C, 1.6) },
    // suit room
    { id: 'suit-lockers', kind: 'locker', room: 'suitroom', box: box(2.6, F, -1.0, 3.2, C, 1.6) },
    { id: 'suit-bench', kind: 'bench', room: 'suitroom', box: box(1.2, F, 1.15, 2.5, -0.55, 1.6) },
    // cargo bay (the ventral ramp is part of the deck between z 7 and 10, |x| < 1.4, sealed in flight)
    { id: 'crates-port', kind: 'rack', room: 'cargo', box: box(-3.2, F, 3.6, -2.0, 0.3, 9.4) },
    { id: 'crates-stbd', kind: 'rack', room: 'cargo', box: box(2.0, F, 3.6, 3.2, 0.3, 9.4) },
    // engineering
    { id: 'reactor', kind: 'machinery', room: 'engineering', box: box(-0.8, F, 12.0, 0.8, 1.0, 13.4) },
    { id: 'eng-racks', kind: 'rack', room: 'engineering', box: box(-2.4, F, 10.4, -1.8, C, 12.2) },
    { id: 'workbench', kind: 'workbench', room: 'engineering', box: box(1.8, F, 10.4, 2.4, -0.05, 11.8) },
    { id: 'coolant', kind: 'machinery', room: 'engineering', box: box(1.6, F, 12.4, 2.4, C, 13.4) },
  ],
  windows: [
    { id: 'w-front', room: 'cockpit', wall: '-z', center: v(0, 0.35, -15.0), width: 3.0, height: 1.2 },
    { id: 'w-cockpit-port', room: 'cockpit', wall: '-x', center: v(-1.7, 0.35, -13.7), width: 2.0, height: 0.9 },
    { id: 'w-cockpit-stbd', room: 'cockpit', wall: '+x', center: v(1.7, 0.35, -13.7), width: 2.0, height: 0.9 },
    { id: 'w-overhead', room: 'cockpit', wall: '+y', center: v(0, C, -13.6), width: 2.0, height: 1.6 },
    { id: 'w-lounge', room: 'lounge', wall: '+x', center: v(3.2, 0.35, -7.5), width: 3.8, height: 1.1 },
    { id: 'w-lounge-sky', room: 'lounge', wall: '+y', center: v(0, C, -7.5), width: 1.4, height: 2.4 },
    { id: 'w-cabin-port', room: 'cabin-port', wall: '-x', center: v(-3.2, 0.2, -3.4), width: 0.9, height: 0.5 },
    { id: 'w-cabin-stbd', room: 'cabin-stbd', wall: '+x', center: v(3.2, 0.2, -3.4), width: 0.9, height: 0.5 },
  ],
  interactables: [
    { id: 'helm', kind: 'helm', room: 'cockpit', pos: v(-0.55, -0.25, -13.1), radius: 1.1, label: 'Take the helm' },
    { id: 'lights', kind: 'lights', room: 'lounge', pos: v(-1.1, 0.2, -10.39), radius: 0.9, label: 'Cabin lights' },
    { id: 'table', kind: 'tableSeat', room: 'lounge', pos: v(2.2, -0.55, -7.5), radius: 1.6, label: 'Sit on the sofa' },
    { id: 'hatch', kind: 'hatch', room: 'corridor', pos: v(0, 1.3, 2.2), radius: 1.2, label: 'Docking hatch' },
    { id: 'bunk', kind: 'bunk', room: 'cabin-port', pos: v(-2.6, -0.45, -3.4), radius: 1.0, label: 'Lie down' },
  ],
  spawn: { pos: v(-0.55, F, -12.7), yaw: 0 },
  helmEye: v(-0.55, 0.25, -13.45),
  bunkEye: v(-2.6, -0.25, -4.2),
  tableEye: v(2.3, 0.2, -7.5),
};

export const INTERIORS: Partial<Record<ShipVisualId, InteriorLayout>> = { wren: WREN };
