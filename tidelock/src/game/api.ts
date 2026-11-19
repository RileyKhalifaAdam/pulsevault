// The session contract: everything the client (renderer, HUD, controls, map) may know about the simulation.
// The client talks to a Session and nothing else. Behind it sits the physical world (src/world): see
// docs/ARCHITECTURE.md. All quantities SI; positions and velocities are system-barycentric, non-rotating
// axes, in doubles, unless a field says otherwise.

import type { EventBus } from '../core/events';
import type { BodyDef, Quat, ShipVisualId, StationVisualId, SystemDef, V3 } from '../core/types';

/** Attitude hold: a controller that commands real torque toward a direction. It never sets orientation. */
export type HoldMode =
  | 'off' // no hold; the ship keeps whatever spin it has
  | 'stability' // damp rotation, then hold the current heading
  | 'prograde' // along velocity relative to the primary body
  | 'retrograde'
  | 'normal' // along the orbit normal r × v
  | 'antinormal'
  | 'radialOut' // away from the primary body
  | 'radialIn'
  | 'target' // toward the selected target
  | 'antiTarget'
  | 'burn' // along the next planned burn
  | 'dock'; // docking collar onto the axis of the nearest free port (holds the heading when there is none)

/** Why time acceleration is lower than requested ('' = it is not). */
export type WarpLimit = '' | 'thrust' | 'rotation' | 'contact' | 'atmosphere' | 'proximity' | 'cpu' | 'docked' | 'crew';

export interface StepInfo {
  /** Sim seconds actually covered by this call. */
  simDt: number;
  /** Wall-clock milliseconds the simulation used. */
  simMs: number;
  /** Integration steps taken (bodies + craft). */
  steps: number;
  limitedBy: WarpLimit;
}

export interface WarpView {
  /** Multiplier the player asked for. */
  requested: number;
  /** Multiplier achieved over the last frames. */
  achieved: number;
  limitedBy: WarpLimit;
}

/** A gravitating body as the renderer and map see it. Objects are reused between calls: do not keep them. */
export interface BodyView {
  id: string;
  /** Static description (name, class, radius, atmosphere, visual seed…). */
  def: BodyDef;
  r: V3;
  v: V3;
  /** Unit spin axis and current rotation angle about it, rad. */
  spinAxis: V3;
  spinAngle: number;
}

export interface CraftView {
  id: string;
  name: string;
  kind: 'ship' | 'station' | 'debris';
  /** Which model to draw. */
  shipVisual: ShipVisualId | null;
  stationVisual: StationVisualId | null;
  visualSeed: number;
  r: V3;
  v: V3;
  /** Craft-local -> world. */
  q: Quat;
  /** Main-drive throttle actually applied, 0..1. */
  throttle: number;
  /** RCS translation activity in craft-local axes, each -1..1. */
  rcs: V3;
  /** Stored heat as a fraction of capacity, 0..1+. */
  heat: number;
  /** Hull as a fraction, 0..1. */
  hull: number;
  isPlayer: boolean;
  /** Craft id this one is latched to, or null. */
  dockedTo: string | null;
  /** Bounding radius, m. */
  radius: number;
}

export type Situation = 'docked' | 'landed' | 'orbit' | 'suborbital' | 'escape' | 'atmosphere' | 'destroyed';

/** Read-outs for the pilot, relative to the primary body. Osculating values: information, never fed back. */
export interface FlightView {
  primaryId: string;
  primaryName: string;
  situation: Situation;
  /** Height above the primary's surface, m. */
  altitude: number;
  /** Speed relative to the primary, m/s. */
  speed: number;
  /** Rate of change of altitude, m/s. */
  verticalSpeed: number;
  /** Speed relative to the rotating surface/air, m/s. */
  surfaceSpeed: number;
  apoapsisAlt: number; // Infinity on an escape path
  periapsisAlt: number;
  timeToApoapsis: number;
  timeToPeriapsis: number;
  period: number;
  inclination: number;
  eccentricity: number;
  /** Proper acceleration felt on board, m/s². */
  accel: number;
  /** Air density, kg/m³, and dynamic pressure, Pa (0 in vacuum). */
  airDensity: number;
  dynamicPressure: number;
}

export interface PlayerView {
  craftId: string;
  name: string;
  /** Total mass, kg, and propellant, kg / fraction of the tank. */
  mass: number;
  propellant: number;
  propellantFraction: number;
  /** Δv left, m/s (from the current mass ratio). */
  deltaV: number;
  /** Acceleration at full throttle now, m/s². */
  maxAccel: number;
  throttle: number;
  hold: HoldMode;
  heat: number;
  hull: number;
  destroyed: boolean;
  /** Human-readable cause when destroyed. */
  destroyedBy: string;
  dockedTo: string | null;
  /** Angular rate, rad/s. */
  spin: number;
  /** Flight Assist: off, on (holding a velocity relative to `assistRef`), or on with no reference in range (it fires nothing). */
  assist: 'off' | 'on' | 'noRef';
  /** Name of the reference craft ('' without one). */
  assistRef: string;
  /** Speed relative to the reference and the speed the DRIVE lever commands along the nose, m/s. */
  assistSpeed: number;
  assistCmd: number;
}

export interface TargetView {
  id: string;
  name: string;
  kind: 'body' | 'craft';
  distance: number;
  /** Magnitude of the relative velocity, m/s. */
  relSpeed: number;
  /** Positive when the distance is shrinking, m/s. */
  closing: number;
  /** Unit vector from the player to the target, world axes. */
  direction: V3;
  /** Target velocity minus player velocity, world axes, m/s. */
  relVelocity: V3;
}

/** A planned impulsive burn (a tool for the pilot; the prediction applies it, the pilot has to fly it). */
export interface PlannedBurn {
  id: string;
  /** Sim time of the burn, s. */
  t: number;
  /** Components relative to the primary body at that time, m/s. */
  prograde: number;
  normal: number;
  radial: number;
}

export interface PredictionEvent {
  kind: 'periapsis' | 'apoapsis' | 'closestApproach' | 'atmosphere' | 'impact' | 'burn';
  t: number;
  /** Position in the prediction frame, m. */
  r: V3;
  /** Altitude (apsides, atmosphere), separation (closest approach) or Δv (burn). */
  value: number;
}

/** The predicted path of the player's craft: the same integrator run on a ghost. */
export interface PredictionView {
  /** Changes whenever the arrays below were recomputed. */
  version: number;
  /** Body the points are relative to (inertial axes, origin at that body's centre at each point's time). */
  frameBodyId: string;
  /** Packed x, y, z, t per point. */
  points: Float64Array;
  count: number;
  /** The target craft's path over the same span, same frame and packing (count 0 when no craft target). */
  targetPoints: Float64Array;
  targetCount: number;
  events: readonly PredictionEvent[];
  /** Sim seconds covered. */
  horizon: number;
}

export interface DockingView {
  /** Nearest station craft id and its distance / relative speed, or null. */
  stationId: string | null;
  distance: number;
  relSpeed: number;
  /** Port the latch would take, with its mating point and outward axis in world axes relative to the player. */
  portId: string | null;
  portOffset: V3;
  portAxis: V3;
  /** Distance from the ship's docking collar to the port's mating point, m (Infinity without a port). */
  portDistance: number;
  /** Latch tolerances and how the ship stands against them. */
  alignment: number; // angle between the ship's collar axis and the reversed port axis, rad
  lateral: number; // collar distance off the port axis, m
  /** Speed toward the mating point relative to the station, m/s (negative when opening). */
  closing: number;
  /** True when every latch condition holds this instant. */
  canLatch: boolean;
  dockedTo: string | null;
}

export interface SessionEvents {
  docked: { stationId: string; portId: string };
  undocked: { stationId: string };
  impact: { speed: number; with: string };
  destroyed: { cause: string };
  atmosphere: { bodyId: string; entered: boolean };
  primaryChanged: { from: string; to: string };
  landed: { bodyId: string };
  reset: Record<string, never>;
  /** The pilot strapped in ('helm') or left the seat ('onFoot'). */
  crewMode: { mode: PlayerMode };
  cabinLights: { on: boolean };
  /** Sleep in the bunk began (asleep true) or ended; `seconds` = sim time slept when it ended. */
  sleep: { asleep: boolean; seconds: number };
}

export interface SessionOptions {
  seed?: number;
  /** Per-frame simulation budget, ms (default 3). */
  budgetMs?: number;
}

export interface Session {
  readonly system: SystemDef;
  readonly events: EventBus<SessionEvents>;

  /** Advance the world by one rendered frame of `realDt` seconds at the requested time acceleration. */
  step(realDt: number): StepInfo;
  time(): number;

  warp(): WarpView;
  setWarp(multiplier: number): void;
  warpUp(): void;
  warpDown(): void;

  /** Pilot input, each -1..1 (throttle 0..1). Rotation inputs command torque; translate commands RCS thrust. */
  setControls(c: { pitch?: number; yaw?: number; roll?: number; throttle?: number; translate?: V3 }): void;
  setHold(mode: HoldMode): void;

  bodies(): readonly BodyView[];
  craft(): readonly CraftView[];
  player(): PlayerView;
  flight(): FlightView;

  /** Target a body id or a craft id; null clears. */
  setTarget(id: string | null): void;
  target(): TargetView | null;

  prediction(): PredictionView;
  /** Body the prediction is drawn around; null = the player's primary. */
  setPredictionFrame(bodyId: string | null): void;
  burns(): readonly PlannedBurn[];
  addBurn(t: number, dv?: { prograde?: number; normal?: number; radial?: number }): string;
  updateBurn(id: string, patch: Partial<Omit<PlannedBurn, 'id'>>): void;
  removeBurn(id: string): void;
  clearBurns(): void;

  docking(): DockingView;
  /** Release the latch with a spring impulse. False when not docked. */
  undock(): boolean;

  /** Put the player back in the starting orbit beside Chandler's Wheel with full tanks. */
  reset(): void;
  save(): string;

  // ---- the pilot as a body inside the ship ---------------------------------------------------------------
  /** 'helm': strapped into the pilot seat, flying. 'onFoot': a body moving inside the ship. */
  mode(): PlayerMode;
  crew(): CrewView;
  /** The player ship's interior layout (src/data/interiors.ts), or null if it has none. */
  interior(): import('../data/interiors').InteriorLayout | null;
  /** Walking input: strafe and forward, each -1..1, relative to where the pilot looks. */
  setWalk(c: { moveX?: number; moveZ?: number }): void;
  /** Turn the head/body: yaw about the deck normal, pitch up/down, rad. */
  addLook(dYaw: number, dPitch: number): void;
  /** Magnetic boots: on = feet grip any deck within reach; off = float free. */
  setBoots(on: boolean): void;
  /** Jump from the deck, or push off whatever surface is within reach when floating, along the look direction. */
  pushOff(): void;
  /** Use the interactable currently in reach (CrewView.prompt). False when there is none. */
  interact(): boolean;
  /** Unstrap from the pilot seat (mode -> 'onFoot') — only allowed while the drive is off. */
  leaveHelm(): boolean;
  /** Stand up from the bunk or the table seat. */
  standUp(): void;
  cabinLights(): boolean;
}

export type PlayerMode = 'helm' | 'onFoot';

/** What the pilot's body is doing. Positions are ship-local (forward -Z, up +Y, right +X), metres. */
export interface CrewView {
  mode: PlayerMode;
  /** 'walking' on a deck in boots, 'floating' free, 'seated' at the helm or table, 'lying' in the bunk. */
  posture: 'walking' | 'floating' | 'seated' | 'lying';
  /** Feet position and eye position. */
  pos: V3;
  eye: V3;
  /** Look direction: yaw about +Y (0 = facing -Z, positive = to the left) and pitch (positive = up), rad. */
  yaw: number;
  pitch: number;
  /** Velocity relative to the ship, ship-local, m/s. */
  vel: V3;
  boots: boolean;
  /** True when the boots have hold of a deck. */
  gripped: boolean;
  roomId: string;
  roomName: string;
  /**
   * Acceleration the body feels in the ship's frame, ship-local, m/s²: zero in free fall, ~12 toward the
   * stern (+Z) under full thrust, plus what the ship's rotation adds. This is what moves a loose body.
   */
  felt: V3;
  /** The interactable in reach, if any. */
  prompt: { id: string; kind: string; label: string } | null;
  /** True while asleep in the bunk (time is being accelerated until woken). */
  asleep: boolean;
}

// ---- physical controls (no on-screen flight UI) -------------------------------------------------------------
// The client's only inputs are: walk (setWalk), look (addLook), a flick to jump / push off (pushOff), and the
// pilot's hand on a physical device (below). Devices are defined in src/data/cockpit.ts. The flight computer
// reads the devices; the client must not call setControls / setHold / setWarp / interact / leaveHelm itself.

/** The live state of one physical control. Objects are reused between calls. */
export interface DeviceView {
  id: string;
  /** Deflection: stick2 x,y in -1..1; lever x in 0..1; rocker x in -1|0|1; toggle x 0|1; button/handle x 1 while pressed. */
  x: number;
  y: number;
  /** Lamp or indicator lit (a hold button whose mode is active, drive armed, harness fastened…). */
  lit: boolean;
  /** True while the pilot's hand is on it. */
  held: boolean;
  /** True when the pilot can reach it from where the body is now. */
  reachable: boolean;
  /** For screens: the page being shown. */
  page: string;
}

export interface Session {
  /** Every device of the player's ship, in the order of the cockpit layout. */
  devices(): readonly DeviceView[];
  cockpit(): import('../data/cockpit').CockpitLayout | null;
  /** Hand down on a device (a touch that started on it). False when it is out of reach. */
  grabDevice(id: string, pointerId: number): boolean;
  /**
   * Hand motion while holding: where the hand wants the control, in the device's own axes
   * (stick2: x right, y along its `up`, each -1..1; lever: x = 0..1). The control follows with its own
   * dynamics (inertia, friction, spring) — it is not set.
   */
  moveDevice(pointerId: number, x: number, y: number): void;
  /** Hand off. Spring-centred controls return; levers and toggles stay. */
  releaseDevice(pointerId: number): void;
  /** A short tap: press a button, flip a toggle, pull a handle, page a screen, fasten or release a buckle, use a rest. */
  tapDevice(id: string): boolean;
}
