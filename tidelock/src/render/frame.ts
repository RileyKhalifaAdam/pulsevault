// SceneFrame: everything the renderer needs to draw one frame, as plain data (no three.js, no DOM).
//
// The app owns ONE frame object, refills it every frame from the simulation and hands it to
// SceneManager.render(). Filling never allocates: `beginFrame` empties the lists and the `add*` helpers hand
// out pooled records to overwrite.
//
//   const frame = createSceneFrame();
//   // every frame:
//   beginFrame(frame, sim.time, realDt, warp);
//   const s = addShip(frame);            // pooled record: overwrite every field you care about
//   s.id = 'player'; s.visualId = 'wren'; s.soiBodyId = vessel.soiBodyId; s.isPlayer = true;
//   copyTo(s.r, vessel.r); copyTo(s.v, vessel.v); s.q.x = ...; s.throttle = ...;
//   frame.camera.mode = 'chase'; frame.camera.focusId = 'player';
//   scene.render(frame);
//
// The world comes from the session: `frame.bodies = session.bodies()` and `frame.craft = session.craft()`
// (system-barycentric doubles, attitude quaternions, spin angles). The scene owns no simulation: it draws those
// states, subtracting in doubles before converting to floats. `frame.ships` is filled by the scene itself from
// the craft of kind 'ship' (a FrameShip's `r`, `v` are barycentric; `soiBodyId` is unused).

import type { DeviceView } from '../game/api';
import type { InstrumentData } from './space/instruments';
import type { Quat, RGB, ShipVisualId, V3 } from '../core/types';
import type { BodyView, CraftView } from '../game/api';

export type CameraMode = 'chase' | 'orbit' | 'cockpit' | 'dock' | 'flyby' | 'interior';

export interface FrameShip {
  /** Stable id (the scene keeps one visual per id). */
  id: string;
  visualId: ShipVisualId;
  /** Visual seed (registration, wear). */
  seed: number;
  soiBodyId: string;
  /** m, relative to the SOI body's centre, system axes. */
  r: V3;
  /** m/s, relative to the SOI body. */
  v: V3;
  /** Ship-local -> world. */
  q: Quat;
  /** Main-drive throttle 0..1 (plume, bell glow). */
  throttle: number;
  /**
   * Translation RCS activity in ship-local axes, each component -1..1: the direction the ship is being
   * pushed (+x = to starboard, +y = up, -z = forward). The jets that fire are the ones pointing the other way.
   */
  rcs: V3;
  /** Hull heat 0..1 (aerobraking glow, hot radiators). */
  heat: number;
  /** Accumulated damage 0..1. */
  damage: number;
  /** Exactly one ship per frame should be the player's: HUD directions and effects are relative to it. */
  isPlayer: boolean;
  /** Running lights and strobes on (default true). */
  lightsOn: boolean;
}

export interface FrameStationExtra {
  stationId: string;
  /** Port whose guide lights pulse (the player's assigned berth), or null. */
  activePortId: string | null;
}

export interface FrameCamera {
  /**
   * chase   behind and above the focus ship, following its attitude with a spring lag
   * orbit   free look around the focus (ship, station or body) in a steady, north-up frame
   * cockpit the pilot's eye point of the focus ship (its own hull is drawn: every camera mode shows it)
   * dock    behind the focus ship looking down the approach axis of `environment.dockingGuide`
   *         (falls back to chase without a guide)
   * flyby   a drifting external camera the ship passes by
   * interior first person inside the player's ship: the camera sits at `eye` (ship-local) and looks along
   *         `lookYaw` / `lookPitch`; the ship's interior (src/data/interiors.ts) is drawn around it
   */
  mode: CameraMode;
  /** Ship id for every mode; 'orbit' also accepts a station or body id. Empty = the player ship. */
  focusId: string;
  /** User orbit offset about the focus, rad. chase/dock: 0 = the default position astern; orbit: absolute azimuth. */
  yaw: number;
  /** User orbit offset, rad, positive = camera higher. Clamped by the rig. */
  pitch: number;
  /**
   * Zoom as a multiple of the mode's default distance (dimensionless; 1 = default framing, 0.5 = twice as
   * close). The default is the hull's ShipLayout.chaseCam for ships and about 3.2 bounding radii for stations
   * and bodies. Clamped by the rig so the camera never enters the focus.
   */
  distance: number;
  /** Optional id (body, station, site or ship) the camera should keep in view beyond the focus; null = none. */
  lookAtId: string | null;
  /** 'interior' only: eye position in the focus ship's local axes (forward -Z, up +Y, starboard +X), m. */
  eye: V3;
  /** 'interior' only: look direction, rad. Yaw about +Y (0 = facing -Z, positive = left); pitch positive = up. */
  lookYaw: number;
  lookPitch: number;
  /** 'interior' only: the pilot leaning in / narrowing the view (pinch): 1 = normal, up to 3 = three times closer. */
  zoom: number;
  /** Lens shift, fraction of the half view height the picture moves up (0 = centred; the title frames the ship
   * above its text with it). Third-person only. */
  shiftY?: number;
}

export interface FrameEnvironment {
  /** Aerobraking intensity 0..1 for the player ship (plasma sheath, heat haze). */
  reentry: number;
  /** Holographic approach corridor for this port, or null. */
  dockingGuide: { stationId: string; portId: string } | null;
}

/** Transient one-shot effects (seam: combat and mining will add kinds). Positions are relative to the player ship, world axes, m. */
export type FrameFxKind = 'explosion' | 'sparks' | 'laser';
export interface FrameFx {
  kind: FrameFxKind;
  /** Position (explosion, sparks) or beam start (laser), relative to the player ship. */
  pos: V3;
  /** Surface normal (sparks) or beam end relative to the player ship (laser). */
  to: V3;
  /** Radius of the explosion, m; strength 0..1 of sparks; beam width, m. */
  size: number;
  color: RGB;
}

export interface SceneFrame {
  /** Sim seconds since the epoch. */
  time: number;
  /** Real seconds since the previous frame (drives animation, springs and exposure; not multiplied by warp). */
  dt: number;
  /** Time-warp multiplier in effect (1 = real time). */
  warp: number;
  /** The world this frame: assign the session's views (not copied, read during render only). */
  bodies: readonly BodyView[];
  craft: readonly CraftView[];
  ships: FrameShip[];
  stationExtras: FrameStationExtra[];
  camera: FrameCamera;
  /** Cabin lighting of the player's ship interior (the pilot's switch). */
  cabinLights: boolean;
  /**
   * The physical controls of the player's ship (Session.devices(), not copied) and what its console screens
   * show (readInstruments() of render/space/instruments.ts). Null / omitted: controls at rest, screens keep
   * their last picture.
   */
  devices?: readonly DeviceView[] | null;
  instruments?: InstrumentData | null;
  environment: FrameEnvironment;
  fx: FrameFx[];
  /** @internal pools behind the lists (see beginFrame / add*) */
  _pool: { ships: FrameShip[]; extras: FrameStationExtra[]; fx: FrameFx[]; guide: { stationId: string; portId: string } };
}

const newShip = (): FrameShip => ({
  id: '',
  visualId: 'wren',
  seed: 0,
  soiBodyId: '',
  r: { x: 0, y: 0, z: 0 },
  v: { x: 0, y: 0, z: 0 },
  q: { x: 0, y: 0, z: 0, w: 1 },
  throttle: 0,
  rcs: { x: 0, y: 0, z: 0 },
  heat: 0,
  damage: 0,
  isPlayer: false,
  lightsOn: true,
});

/** A reusable, empty frame. Create one and keep it. */
export function createSceneFrame(): SceneFrame {
  return {
    time: 0,
    dt: 0,
    warp: 1,
    bodies: [],
    craft: [],
    ships: [],
    stationExtras: [],
    camera: { mode: 'chase', focusId: '', yaw: 0, pitch: 0, distance: 1, lookAtId: null, eye: { x: 0, y: 0, z: 0 }, lookYaw: 0, lookPitch: 0, zoom: 1 },
    cabinLights: true,
    devices: null,
    instruments: null,
    environment: { reentry: 0, dockingGuide: null },
    fx: [],
    _pool: { ships: [], extras: [], fx: [], guide: { stationId: '', portId: '' } },
  };
}

/** Start refilling: sets the clock and empties ships, station extras and fx (camera and environment persist). */
export function beginFrame(frame: SceneFrame, time: number, dt: number, warp = 1): SceneFrame {
  frame.time = time;
  frame.dt = dt;
  frame.warp = warp;
  frame.ships.length = 0;
  frame.stationExtras.length = 0;
  frame.fx.length = 0;
  return frame;
}

/** Append a ship and return its (pooled, reset) record to fill in. */
export function addShip(frame: SceneFrame): FrameShip {
  const pool = frame._pool.ships;
  const i = frame.ships.length;
  if (i >= pool.length) pool.push(newShip());
  const s = pool[i];
  s.throttle = 0;
  s.rcs.x = s.rcs.y = s.rcs.z = 0;
  s.heat = 0;
  s.damage = 0;
  s.isPlayer = false;
  s.lightsOn = true;
  s.seed = 0;
  frame.ships.push(s);
  return s;
}

/** Tell a station which port to highlight this frame. */
export function addStationExtra(frame: SceneFrame, stationId: string, activePortId: string | null): FrameStationExtra {
  const pool = frame._pool.extras;
  const i = frame.stationExtras.length;
  if (i >= pool.length) pool.push({ stationId: '', activePortId: null });
  const e = pool[i];
  e.stationId = stationId;
  e.activePortId = activePortId;
  frame.stationExtras.push(e);
  return e;
}

/** Append a transient effect and return its pooled record to fill in. */
export function addFx(frame: SceneFrame, kind: FrameFxKind): FrameFx {
  const pool = frame._pool.fx;
  const i = frame.fx.length;
  if (i >= pool.length) pool.push({ kind, pos: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 0 }, size: 1, color: [1, 1, 1] });
  const f = pool[i];
  f.kind = kind;
  frame.fx.push(f);
  return f;
}

/** Set or clear the docking guide without allocating. */
export function setDockingGuide(frame: SceneFrame, stationId: string | null, portId: string | null = null): void {
  if (!stationId || !portId) {
    frame.environment.dockingGuide = null;
    return;
  }
  const g = frame._pool.guide;
  g.stationId = stationId;
  g.portId = portId;
  frame.environment.dockingGuide = g;
}

/** The player's ship in this frame (the first flagged one, else the first ship), or null. */
export function playerShip(frame: SceneFrame): FrameShip | null {
  const ships = frame.ships;
  for (let i = 0; i < ships.length; i++) if (ships[i].isPlayer) return ships[i];
  return ships.length ? ships[0] : null;
}
