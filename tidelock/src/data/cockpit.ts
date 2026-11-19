// Physical controls and instruments of a ship, as pure data (no three.js): the single source for the
// simulation (what each control does, how it moves) and the renderer (where it is, what it looks like).
//
// There is no on-screen flight UI. The pilot's hand is a touch on the 3D object: drag a hand controller or a
// lever, tap a button, a switch or a buckle. Read-outs are screens on the console.
// Ship-local axes: forward -Z, up +Y, starboard +X; metres.

import type { ShipVisualId, V3 } from '../core/types';

export type DeviceKind =
  | 'stick2' // two-axis hand controller, spring-centred: follows the hand while held, returns when released
  | 'lever' // one-axis lever with friction: stays where it is put (0..1 along its travel)
  | 'rocker' // momentary three-position switch, spring-centred (-1, 0, +1)
  | 'button' // momentary push-button; its lamp shows the state of what it commands
  | 'toggle' // two-position switch that stays
  | 'handle' // pull handle, momentary
  | 'screen' // display; a tap cycles its page
  | 'buckle' // seat harness: strap in / unstrap
  | 'rest'; // a place to put the body: bunk, bench

/** What a control is wired to. The flight computer reads devices; nothing else commands the ship. */
export type DeviceRole =
  | 'rotation' // stick2: x = yaw (right positive), y = pitch (pull back = nose up, positive)
  | 'roll' // rocker: +1 = roll right
  | 'translation' // stick2: x = RCS right, y = RCS up
  | 'translationZ' // rocker: +1 = RCS forward
  | 'throttle' // lever: main-drive throttle
  | 'driveArm' // toggle: main-drive valves armed (the throttle does nothing while safe)
  | 'holdOff'
  | 'holdStability'
  | 'holdPrograde'
  | 'holdRetrograde'
  | 'holdNormal'
  | 'holdAntinormal'
  | 'holdRadialOut'
  | 'holdRadialIn'
  | 'holdTarget'
  | 'holdDock'
  | 'targetNext' // button: select the next target (stations, then bodies)
  | 'undock' // handle: release the docking latch
  | 'cabinLights' // toggle
  | 'display' // screen
  | 'harness' // buckle on the pilot seat
  | 'bunk' // rest: lie down; lying still for a few seconds is sleep
  | 'tableSeat'; // rest: sit by the window

export interface DeviceDef {
  id: string;
  kind: DeviceKind;
  role: DeviceRole;
  /** Engraved placard text next to the control. */
  label: string;
  room: string;
  /** Centre of the control (pivot of a stick or lever, centre of a button or screen). */
  pos: V3;
  /** Unit vector out of the panel the control sits on, toward the operator. */
  normal: V3;
  /** Unit "up" of the control on its panel (the direction a lever moves to increase, the top of a screen). */
  up: V3;
  /** Touch size: radius for small controls, m; for screens and rests the half-extents along right and up. */
  radius: number;
  halfWidth?: number;
  halfHeight?: number;
  /** Lever / stick travel in metres at the grip (visual and for mapping hand motion to deflection). */
  travel?: number;
  /** Pages a screen cycles through. */
  pages?: string[];
  /** The hand reaches it from the pilot seat, or from anywhere within arm's length (0.9 m of the eye). */
  reach: 'pilotSeat' | 'arm';
}

export interface CockpitLayout {
  shipId: ShipVisualId;
  devices: DeviceDef[];
}

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });
/** Console face: a panel sloping back from its lower edge near the pilot; this is its outward normal. */
const FACE = v(0, 0.5, 0.866);
const FACE_UP = v(0, 0.866, -0.5);
const TOP = v(0, 1, 0);
const AFT = v(0, 0, 1);

const holdButton = (id: string, role: DeviceRole, label: string, col: number, row: number): DeviceDef => ({
  id,
  kind: 'button',
  role,
  label,
  room: 'cockpit',
  // a 5 x 2 block of lamps on the console face in front of the pilot, 6 cm pitch
  pos: v(-0.79 + col * 0.06, 0.02 + row * 0.052, -4.72 - row * 0.03),
  normal: FACE,
  up: FACE_UP,
  radius: 0.026,
  reach: 'pilotSeat',
});

/**
 * Halcyon Wren, pilot station (left seat; eye at about (-0.55, 0.5, -4.05) looking forward).
 * Positions are a starting arrangement: the renderer may move a control a few centimetres so everything is
 * visible and touchable from the seat on a phone held upright, as long as it edits them HERE.
 */
const WREN: CockpitLayout = {
  shipId: 'wren',
  devices: [
    // two screens on the console face, either side of the pilot's centreline
    {
      id: 'screen-flight', kind: 'screen', role: 'display', label: 'FLIGHT', room: 'cockpit',
      pos: v(-0.74, 0.16, -4.86), normal: FACE, up: FACE_UP, radius: 0.16, halfWidth: 0.15, halfHeight: 0.1,
      pages: ['flight'], reach: 'pilotSeat',
    },
    {
      id: 'screen-nav', kind: 'screen', role: 'display', label: 'NAV', room: 'cockpit',
      pos: v(-0.36, 0.16, -4.86), normal: FACE, up: FACE_UP, radius: 0.16, halfWidth: 0.15, halfHeight: 0.1,
      pages: ['orbit', 'docking', 'systems'], reach: 'pilotSeat',
    },
    // attitude-hold lamps
    holdButton('hold-off', 'holdOff', 'OFF', 0, 0),
    holdButton('hold-stab', 'holdStability', 'HOLD', 1, 0),
    holdButton('hold-pro', 'holdPrograde', 'PRO', 2, 0),
    holdButton('hold-retro', 'holdRetrograde', 'RETRO', 3, 0),
    holdButton('hold-tgt', 'holdTarget', 'TGT', 4, 0),
    holdButton('hold-nml', 'holdNormal', 'NML+', 0, 1),
    holdButton('hold-anml', 'holdAntinormal', 'NML-', 1, 1),
    holdButton('hold-rout', 'holdRadialOut', 'RAD+', 2, 1),
    holdButton('hold-rin', 'holdRadialIn', 'RAD-', 3, 1),
    holdButton('hold-dock', 'holdDock', 'DOCK', 4, 1),
    {
      id: 'target-next', kind: 'button', role: 'targetNext', label: 'TARGET', room: 'cockpit',
      pos: v(-0.42, 0.02, -4.72), normal: FACE, up: FACE_UP, radius: 0.028, reach: 'pilotSeat',
    },
    // hand controllers on the console's near edge: translation left hand, rotation right hand
    {
      id: 'thc', kind: 'stick2', role: 'translation', label: 'TRANSLATE', room: 'cockpit',
      pos: v(-0.84, -0.04, -4.62), normal: TOP, up: v(0, 0, -1), radius: 0.06, travel: 0.05, reach: 'pilotSeat',
    },
    {
      id: 'thc-z', kind: 'rocker', role: 'translationZ', label: 'FWD / AFT', room: 'cockpit',
      pos: v(-0.72, -0.05, -4.66), normal: FACE, up: FACE_UP, radius: 0.03, reach: 'pilotSeat',
    },
    {
      id: 'rhc', kind: 'stick2', role: 'rotation', label: 'ROTATE', room: 'cockpit',
      pos: v(-0.3, -0.04, -4.62), normal: TOP, up: v(0, 0, -1), radius: 0.06, travel: 0.06, reach: 'pilotSeat',
    },
    {
      id: 'roll', kind: 'rocker', role: 'roll', label: 'ROLL', room: 'cockpit',
      pos: v(-0.42, -0.05, -4.66), normal: FACE, up: FACE_UP, radius: 0.03, reach: 'pilotSeat',
    },
    // main drive on the centre pedestal, at the pilot's right hand
    {
      id: 'throttle', kind: 'lever', role: 'throttle', label: 'DRIVE', room: 'cockpit',
      pos: v(-0.1, 0.0, -4.5), normal: TOP, up: v(0, 0, -1), radius: 0.06, travel: 0.16, reach: 'pilotSeat',
    },
    {
      id: 'drive-arm', kind: 'toggle', role: 'driveArm', label: 'DRIVE ARM', room: 'cockpit',
      pos: v(0.06, -0.03, -4.62), normal: TOP, up: v(0, 0, -1), radius: 0.03, reach: 'pilotSeat',
    },
    {
      id: 'undock', kind: 'handle', role: 'undock', label: 'LATCH RELEASE', room: 'cockpit',
      pos: v(0.06, -0.03, -4.3), normal: TOP, up: v(0, 0, -1), radius: 0.035, reach: 'pilotSeat',
    },
    // the seat harness: tap to strap in from beside the seat, tap again to unstrap
    {
      id: 'harness', kind: 'buckle', role: 'harness', label: 'HARNESS', room: 'cockpit',
      pos: v(-0.55, 0.0, -4.05), normal: AFT, up: TOP, radius: 0.3, reach: 'arm',
    },
    // around the house
    {
      id: 'lights', kind: 'toggle', role: 'cabinLights', label: 'LIGHTS', room: 'cabin',
      pos: v(-0.62, 0.45, -2.58), normal: AFT, up: TOP, radius: 0.05, reach: 'arm',
    },
    {
      id: 'bunk', kind: 'rest', role: 'bunk', label: 'BUNK', room: 'bunks',
      pos: v(1.27, -0.2, 3.25), normal: TOP, up: v(0, 0, -1), radius: 0.5, halfWidth: 0.32, halfHeight: 1.2, reach: 'arm',
    },
    {
      id: 'table-seat', kind: 'rest', role: 'tableSeat', label: 'BENCH', room: 'cabin',
      pos: v(1.17, -0.28, -2.02), normal: TOP, up: v(0, 0, -1), radius: 0.35, halfWidth: 0.4, halfHeight: 0.27, reach: 'arm',
    },
  ],
};

export const COCKPITS: Partial<Record<ShipVisualId, CockpitLayout>> = { wren: WREN };
