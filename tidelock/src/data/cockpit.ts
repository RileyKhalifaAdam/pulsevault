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
  | 'flightAssist' // button, alternate action: Flight Assist on / off (lamp lit = on, blinking = no reference)
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

/**
 * The pilot's flight station: a binnacle standing on the main console in front of the pilot seat, with a
 * sloping instrument face (screens above, lamps and switches below) and a level desk over the knees
 * (hand controllers, rockers, throttle). The renderer builds the housing from this so picture and device
 * positions agree. Profile points are (y, z) in ship axes; the housing spans x0..x1.
 */
export interface StationShape {
  x0: number;
  x1: number;
  /** A point on the instrument face (the screens' centre line) and the face's extent along `up` from it, m. */
  faceOrigin: V3;
  faceNormal: V3;
  faceUp: V3;
  faceTop: number;
  faceBottom: number;
  /** Desk top height and the z of its near (pilot-side) edge; it starts at the lower edge of the face. */
  deskY: number;
  deskNearZ: number;
  /** Where the glare-shield top meets the main console's hood, and where the underside meets its shelf. */
  hoodBack: { y: number; z: number };
  underBack: { y: number; z: number };
}

export interface CockpitLayout {
  shipId: ShipVisualId;
  devices: DeviceDef[];
  station?: StationShape;
}

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });
/** Instrument face: a panel leaning back 30 degrees, square to the seated pilot's line of sight. */
const FACE = v(0, 0.5, 0.866);
const FACE_UP = v(0, 0.866, -0.5);
const TOP = v(0, 1, 0);
const FWD = v(0, 0, -1);
const AFT = v(0, 0, 1);

/** Pilot centreline, and the face's origin: the centre line of the two screens. */
const PX = -0.55;
const FY = 0.217;
const FZ = -4.701;
/** A point on the instrument face: x across, s metres up the face from the screens' centre line. */
const face = (x: number, s: number): V3 => v(x, FY + 0.866 * s, FZ - 0.5 * s);
/** Desk top (level), y of its surface. */
const DESK_Y = -0.011;
const desk = (x: number, z: number): V3 => v(x, DESK_Y, z);

const WREN_STATION: StationShape = {
  x0: PX - 0.32,
  x1: PX + 0.32,
  faceOrigin: v(PX, FY, FZ),
  faceNormal: FACE,
  faceUp: FACE_UP,
  faceTop: 0.108,
  faceBottom: -0.263,
  deskY: DESK_Y,
  deskNearZ: -4.37,
  hoodBack: { y: 0.25, z: -5.09 },
  underBack: { y: -0.16, z: -4.8 },
};

const LAMP_PITCH_X = 0.076;
const LAMP_ROW = [-0.147, -0.221]; // s of the upper and the lower row
const holdButton = (id: string, role: DeviceRole, label: string, col: number, row: number): DeviceDef => ({
  id,
  kind: 'button',
  role,
  label,
  room: 'cockpit',
  // a 5 x 2 block of square lamps on the instrument face under the screens
  pos: face(PX + (col - 2) * LAMP_PITCH_X, LAMP_ROW[row]),
  normal: FACE,
  up: FACE_UP,
  radius: 0.027,
  reach: 'pilotSeat',
});

/**
 * Halcyon Wren, pilot station (left seat; eye at about (-0.55, 0.5, -4.05), looking forward and about 20
 * degrees down). Laid out for a phone held upright, where the view is 88 degrees tall but only 48 wide:
 * everything sits within about 0.3 m of the pilot's centreline, stacked from the screens (top, 0.7 m from
 * the eye) down to the hand controllers at the near corners of the desk.
 */
const WREN: CockpitLayout = {
  shipId: 'wren',
  station: WREN_STATION,
  devices: [
    // two screens side by side at the top of the instrument face
    {
      id: 'screen-flight', kind: 'screen', role: 'display', label: 'FLIGHT', room: 'cockpit',
      pos: face(PX - 0.148, 0), normal: FACE, up: FACE_UP, radius: 0.14, halfWidth: 0.14, halfHeight: 0.093,
      pages: ['flight'], reach: 'pilotSeat',
    },
    {
      id: 'screen-nav', kind: 'screen', role: 'display', label: 'NAV', room: 'cockpit',
      pos: face(PX + 0.148, 0), normal: FACE, up: FACE_UP, radius: 0.14, halfWidth: 0.14, halfHeight: 0.093,
      pages: ['orbit', 'docking', 'systems'], reach: 'pilotSeat',
    },
    // attitude-hold lamps: upper row OFF HOLD PRO RETRO TGT, lower row NML+ NML- RAD+ RAD- DOCK
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
    // right of the lamps: target select above, latch release below
    {
      id: 'target-next', kind: 'button', role: 'targetNext', label: 'TARGET', room: 'cockpit',
      pos: face(PX + 0.25, -0.143), normal: FACE, up: FACE_UP, radius: 0.026, reach: 'pilotSeat',
    },
    // hand controllers at the near corners of the desk: translation left hand, rotation right hand
    {
      id: 'thc', kind: 'stick2', role: 'translation', label: 'TRANSLATE', room: 'cockpit',
      pos: desk(PX - 0.16, -4.42), normal: TOP, up: FWD, radius: 0.045, travel: 0.06, reach: 'pilotSeat',
    },
    {
      id: 'thc-z', kind: 'rocker', role: 'translationZ', label: 'FWD / AFT', room: 'cockpit',
      pos: desk(PX - 0.088, -4.522), normal: TOP, up: FWD, radius: 0.03, reach: 'pilotSeat',
    },
    {
      id: 'rhc', kind: 'stick2', role: 'rotation', label: 'ROTATE', room: 'cockpit',
      pos: desk(PX + 0.16, -4.42), normal: TOP, up: FWD, radius: 0.045, travel: 0.06, reach: 'pilotSeat',
    },
    {
      id: 'roll', kind: 'rocker', role: 'roll', label: 'ROLL', room: 'cockpit',
      pos: desk(PX + 0.088, -4.522), normal: TOP, up: FWD, radius: 0.03, reach: 'pilotSeat',
    },
    // main drive: the throttle slides in a slot down the middle of the desk (forward = more), its arming
    // switch sits under a flip guard on the face to the left of the lamps
    {
      id: 'throttle', kind: 'lever', role: 'throttle', label: 'DRIVE', room: 'cockpit',
      pos: desk(PX, -4.445), normal: TOP, up: FWD, radius: 0.04, travel: 0.12, reach: 'pilotSeat',
    },
    {
      id: 'drive-arm', kind: 'toggle', role: 'driveArm', label: 'DRIVE ARM', room: 'cockpit',
      pos: face(PX - 0.25, -0.18), normal: FACE, up: FACE_UP, radius: 0.028, reach: 'pilotSeat',
    },
    // Flight Assist: an alternate-action lamp button on the desk beside the DRIVE lever it changes the meaning
    // of (lit: the lever commands speed along the nose and the computer holds it; dark: the lever is raw thrust)
    {
      id: 'flt-assist', kind: 'button', role: 'flightAssist', label: 'FLT ASSIST', room: 'cockpit',
      pos: desk(PX + 0.083, -4.452), normal: TOP, up: FWD, radius: 0.026, reach: 'pilotSeat',
    },
    {
      id: 'undock', kind: 'handle', role: 'undock', label: 'LATCH RELEASE', room: 'cockpit',
      pos: face(PX + 0.25, -0.222), normal: FACE, up: FACE_UP, radius: 0.03, reach: 'pilotSeat',
    },
    // the seat harness buckle, in the pilot's lap: tap to strap in from beside the seat, tap again to unstrap
    {
      id: 'harness', kind: 'buckle', role: 'harness', label: 'HARNESS', room: 'cockpit',
      pos: v(PX, -0.01, -4.285), normal: v(0, 0.866, 0.5), up: v(0, 0.5, -0.866), radius: 0.07, reach: 'arm',
    },
    // around the house
    {
      id: 'lights', kind: 'toggle', role: 'cabinLights', label: 'LIGHTS', room: 'cabin',
      pos: v(-0.62, 0.45, -2.598), normal: AFT, up: TOP, radius: 0.05, reach: 'arm',
    },
    {
      id: 'bunk', kind: 'rest', role: 'bunk', label: 'BUNK', room: 'bunks',
      pos: v(1.27, -0.2, 3.25), normal: TOP, up: FWD, radius: 0.5, halfWidth: 0.32, halfHeight: 1.2, reach: 'arm',
    },
    {
      id: 'table-seat', kind: 'rest', role: 'tableSeat', label: 'BENCH', room: 'cabin',
      pos: v(1.17, -0.28, -2.02), normal: TOP, up: FWD, radius: 0.35, halfWidth: 0.4, halfHeight: 0.27, reach: 'arm',
    },
  ],
};

export const COCKPITS: Partial<Record<ShipVisualId, CockpitLayout>> = { wren: WREN };
