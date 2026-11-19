// The plain inputs the sound model reads each frame (docs/SIMULATION.md §1.4, wave-1 views). Nothing here is a
// command: every value is a record of what the world actually did, so every sound has a physical cause.
// W1-A fills an AudioFrame from the session views once per frame and passes it to `audio.update(frame)`.

import type { PropType } from '../data/props';
import type { V3 } from '../core/types';

export type Posture = 'walking' | 'floating' | 'seated' | 'lying';

export interface AudioCrew {
  /** Eye position, ship-local m (CrewView.eye, which includes W1-C's eyeOffset). */
  eye: V3;
  /** Look yaw about +Y, rad (0 = facing −Z, positive = to the left), as CrewView.yaw. */
  yaw: number;
  posture: Posture;
  /** Boots have hold of a deck (CrewView.gripped). */
  gripped: boolean;
  /** Room the head is in (CrewView.roomId). */
  roomId: string;
}

export interface AudioFrame {
  /** Real (wall-clock) seconds since the previous update. */
  dt: number;
  /** Sim time at the end of this frame, s (events are placed within the frame by their own t). */
  simTime: number;
  /** Achieved time warp (WarpView.achieved). Above 4 continuous sources mute and events are decimated. */
  warp: number;
  /** CraftView.jetDuty: duty actually applied over the last step, 0..1, one per jet (0 when docked, landed, dry). */
  jetDuty: Float64Array;
  /** CraftView.engineLevel: F_s / F_max per main engine, 0..1 (the spool is heard because this is the state). */
  engineLevel: Float64Array;
  /** CraftView.airVelocity: air-relative velocity, inertial m/s; zero outside air. */
  airVelocity: V3;
  /** FlightView.airDensity (outside), kg/m³, and FlightView.dynamicPressure, Pa. */
  airDensity: number;
  dynamicPressure: number;
  /**
   * Outside speed of sound, m/s. Wave 1: the isothermal √(γ·R·T/M) = √(γ·g·H) of the primary's atmosphere
   * (`fillAudioFrame` derives it from the BodyDef, see primarySoundSpeed); W2-B's layered profile replaces it.
   * 0 (no primary given) = 300 m/s.
   */
  soundSpeed: number;
  /** CraftView.heatFlux, W/m². Read for W2-F (skin creaks come from the thermal state, not from this). */
  heatFlux: number;
  /** Cabin pressure of the head's room, Pa. Placeholder 101 325 until W2-D's cabin gas supplies it. */
  cabinPressure: number;
  /** Latched to a station (the station's machinery comes through the collar). */
  docked: boolean;
  crew: AudioCrew;
}

/** Fixed description of the player's ship for the sound model (built once; see `audioShipFromData`). */
export interface AudioShip {
  /** JetDef order: position (ship-local m) and thrust, N. */
  jets: { pos: V3; thrust: number }[];
  /** EngineDef order: nozzle position and max thrust, N. */
  engines: { pos: V3; maxThrust: number }[];
  /** One air-handling fan per room, at the ceiling centre. */
  rooms: { id: string; fan: V3 }[];
  /** Docking collar position (the station's hum enters there). */
  dockingPort: V3;
  /** Prop index (the `a`/`b` of contact events) → type, in the ship's PROPS order. */
  props: PropType[];
}

/** A neutral frame: everything at rest, cabin at 101.325 kPa. Tests and the harness start from this. */
export function restFrame(nJets: number, nEngines: number): AudioFrame {
  return {
    dt: 1 / 60,
    simTime: 0,
    warp: 1,
    jetDuty: new Float64Array(nJets),
    engineLevel: new Float64Array(nEngines),
    airVelocity: { x: 0, y: 0, z: 0 },
    airDensity: 0,
    dynamicPressure: 0,
    soundSpeed: 0,
    heatFlux: 0,
    cabinPressure: 101325,
    docked: false,
    crew: { eye: { x: -0.55, y: 0.25, z: -13.45 }, yaw: 0, posture: 'seated', gripped: false, roomId: 'cockpit' },
  };
}
