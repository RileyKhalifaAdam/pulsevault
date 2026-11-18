// TIDELOCK GameSim: the public contract between the simulation and the app (UI, renderer, audio, main loop).
//
// The app creates one GameSim (createGame / loadGame in ../game.ts), calls step(realDt) once per frame, reads
// the views, calls the actions and listens to `events`. Everything here is plain data in SI units, non-rotating
// system axes (see docs/ARCHITECTURE.md §3). Actions never throw: they return an ActionResult whose `reason`
// is a sentence a player can read.
//
// View objects (flightInfo, targetInfo, contacts, player, shipPose, warp, dockingState, autopilot, trajectory)
// are REUSED between calls: read them, do not keep or mutate them.

import type { Quat, StationDef, SystemDef, V3 } from '../../core/types';
import type { EventBus } from '../../core/events';
import type { AutopilotCommand } from '../autopilot';
import type { EconomyEvent, MarketRow, TradeQuote } from '../economy';
import type { SystemModel, TrajectoryPatch } from '../orbit';
import type { SasMode, VesselControls } from '../physics';
import type { ManeuverNode, NodeDv } from '../planner';
import type { GalaxyDef } from '../universe';
import type { GameState } from './state';

// ------------------------------------------------------------------------------------------------ basics

export type ActionResult = { ok: true } | { ok: false; reason: string };

/** Something the player can select: a station, a body or a mining site of the current system. */
export interface TargetRef {
  kind: 'station' | 'body' | 'site';
  id: string;
}

export type ToastKind = 'info' | 'good' | 'warn' | 'danger';

export type Situation = 'docked' | 'orbit' | 'suborbital' | 'escape' | 'atmosphere' | 'destroyed';

export type DestroyCause = 'impact' | 'heat' | 'collision';

export type PlanKind = 'toTarget' | 'circularizeAtPeriapsis' | 'circularizeAtApoapsis' | 'matchPlane' | 'returnToSafeOrbit';

export interface GameOptions {
  /** Galaxy / economy seed. Default 1. */
  seed?: number;
  pilotName?: string;
}

// ------------------------------------------------------------------------------------------------ events

/**
 * Everything the simulation announces. Listen with `sim.events.on(name, handler)`. Declared as an interface
 * so later subsystems can add their own events by declaration merging.
 */
export interface GameEvents {
  /** Soft capture finished: the ship is berthed. */
  docked: { stationId: string; portId: string };
  /** The clamps let go (the ship then slides clear of the berth for a few seconds). */
  undocked: { stationId: string; portId: string };
  /** Traffic control assigned a berth. */
  dockingGranted: { stationId: string; portId: string };
  /** The berth caught the ship; it is being drawn in (followed by `docked`). */
  dockingCaptured: { stationId: string; portId: string };
  /** Clearance was withdrawn (flew out of the control zone, or cancelled). */
  dockingCancelled: { stationId: string; reason: string };
  nodeAdded: { id: string };
  nodeChanged: { id: string };
  nodeRemoved: { id: string; reason: 'removed' | 'completed' | 'cleared' };
  /** Main drive lit / cut. `nodeId` is the manoeuvre node being flown, if any. */
  burnStarted: { nodeId: string | null };
  burnEnded: { nodeId: string | null };
  soiChanged: { fromBodyId: string; toBodyId: string };
  /** The effective time-warp factor changed. `reason` is '' when the player asked for it. */
  warpChanged: { level: number; reason: string };
  atmosphereEntered: { bodyId: string };
  atmosphereExited: { bodyId: string };
  /** Stored heat passed 70 % of capacity (or the hull started to cook: fraction >= 1). */
  heatWarning: { fraction: number };
  /** Propellant fell below 10 % (fraction > 0) or ran out while thrusting (fraction 0). */
  propellantLow: { fraction: number };
  /** Hit a station. `speed` is the closing speed along the contact normal, m/s; `damage` in hull points. */
  collision: { stationId: string; speed: number; damage: number };
  destroyed: { cause: DestroyCause };
  /** A replacement ship was issued after destruction. */
  rebought: { stationId: string; cost: number };
  /** A fuel tender topped the tanks up in orbit. */
  tenderArrived: { kg: number; cost: number };
  traded: { kind: 'buy' | 'sell'; stationId: string; commodityId: string; units: number; total: number; profit: number };
  refuelled: { stationId: string; kg: number; cost: number };
  repaired: { stationId: string; cost: number };
  targetChanged: { target: TargetRef | null };
  /** Engaged, disengaged, finished or failed, or moved to another phase. */
  autopilotChanged: { engaged: boolean; mode: string; phase: string; failed: string | null };
  /** One economy day was simulated. */
  dayTicked: { day: number; events: EconomyEvent[] };
  saved: { bytes: number };
  /** A line for the HUD message area. */
  toast: { message: string; kind: ToastKind };
  /** A subsystem threw; the game carried on. `where` names the call, `message` the error (show it: bug reports depend on it). */
  fault: { where: string; message: string };
}

// ------------------------------------------------------------------------------------------------ views

export interface WarpView {
  /** Effective time-warp multiplier right now. */
  level: number;
  /** Its index in physics.WARP_LEVELS. */
  index: number;
  /** Multiplier the player asked for. */
  requested: number;
  /** Highest multiplier the situation allows right now. */
  maxAllowed: number;
  /** Why `maxAllowed` is what it is; '' when nothing limits the requested warp. */
  limitReason: string;
}

export interface TrajectoryNodeView {
  id: string;
  /** Sim time of the burn, s. */
  t: number;
  bodyId: string;
  /** m/s */
  dvMagnitude: number;
  /** Seconds at full throttle from the mass the ship will have then (finite even if the tank cannot cover it). */
  burnDuration: number;
  /** False when the propellant on board does not cover this node and the ones before it. */
  affordable: boolean;
  /** False when the predicted trajectory ends (impact, atmosphere) before the node. */
  reached: boolean;
  /** Predicted position at the burn, relative to `bodyId`, m (zero when not reached). */
  r: V3;
  /** Burn vector in system axes, m/s (zero when not reached). */
  dvWorld: V3;
}

export interface EncounterView {
  /** Body whose sphere of influence the trajectory enters (or falls back into). */
  bodyId: string;
  name: string;
  /** Sim time of the SOI change, s. */
  t: number;
  /** Periapsis of the pass, m from the body centre, and its altitude above the surface. */
  periapsisRadius: number;
  periapsisAltitude: number;
  /** Sim time of that periapsis, or null if the arc ends before it. */
  periapsisTime: number | null;
}

export interface TrajectoryView {
  /** Changes only when the prediction was recomputed: redraw the map when it differs from the one you drew. */
  version: number;
  /** Patched conics from now through every node (orbit.ts; draw with orbit.samplePatch). Derived data. */
  patches: TrajectoryPatch[];
  nodes: TrajectoryNodeView[];
  /** SOI changes along the predicted path. */
  encounters: EncounterView[];
  /** Closest pass of the selected target on the path after the last node, or null. Distance to a body is to its centre. */
  closestApproach: { t: number; distance: number; relSpeed: number } | null;
}

export interface AutopilotView {
  engaged: boolean;
  /** 'idle' or the command kind. */
  mode: string;
  phase: string;
  /** One line for the HUD. */
  status: string;
  /** Why the last command ended in failure, until the next engage. */
  failed: string | null;
}

export interface DockingView {
  /** Station the numbers are about: the one that granted clearance, else the targeted or nearest station. */
  stationId: string | null;
  /** Assigned berth, once granted (or the berth the ship is in). */
  portId: string | null;
  granted: boolean;
  inControlZone: boolean;
  /** Distance to the station centre, m (Infinity when there is no station). */
  distance: number;
  /** Speed relative to the station, m/s. */
  relSpeed: number;
  canRequest: boolean;
  /** Why docking cannot be requested right now ('' when it can, or is already granted). */
  blocked: string;
  /** Radius of the station's traffic-control zone, m. */
  controlZone: number;
  /** 'capture' while the berth (or the station tug) draws the ship in, 'release' while it slides clear after undocking. */
  transit: 'capture' | 'release' | null;
  /** True while a station tug is towing the ship to its berth. */
  tug: boolean;
  /** Seconds until the capture / release in progress is over (0 when there is none): "Tug: 12 s". */
  transitSeconds: number;
  /** With clearance: distance from the ship to the berth's mating point, m. Soft capture happens under 30 m and 3 m/s. */
  portDistance: number;
  /** With clearance: mating point relative to the ship, system axes, m. */
  portRel: V3;
  /** With clearance: unit vector out of the berth, system axes. Approach against it. */
  portAxis: V3;
  /** With clearance: distance of the ship off the berth's approach axis, m. */
  lateral: number;
}

export interface NextNodeView {
  id: string;
  /** Seconds until the node's time (negative when overdue). */
  timeTo: number;
  /** Seconds until the burn should start (half the burn before the node). */
  burnStartsIn: number;
  /** m/s still to burn. */
  dvRemaining: number;
  /** Seconds at full throttle for what remains. */
  burnDuration: number;
  /** Burn direction, system axes (unit; zero if unknown). */
  dir: V3;
  /** Angle between the nose and the burn direction, rad. */
  pointingError: number;
}

export interface FlightInfo {
  situation: Situation;
  soiBodyId: string;
  soiBodyName: string;
  /** Height above the body's mean radius, m. */
  altitude: number;
  /** Distance from the body centre, m. */
  radius: number;
  /** Speed relative to the SOI body, m/s. */
  orbitalSpeed: number;
  /** Speed relative to the rotating surface, m/s. */
  surfaceSpeed: number;
  /** Positive = climbing, m/s. */
  verticalSpeed: number;
  /** Altitude of apoapsis / periapsis above the mean radius, m. Apoapsis is Infinity on an open orbit. */
  apoapsisAltitude: number;
  periapsisAltitude: number;
  /** Seconds to each (Infinity when there is none ahead). */
  timeToApoapsis: number;
  timeToPeriapsis: number;
  /** s; Infinity on an open orbit. */
  period: number;
  /** rad, to the system reference plane. */
  inclination: number;
  eccentricity: number;
  propellant: number;
  propellantCapacity: number;
  propellantFraction: number;
  /** m/s left in the tank at the current mass. */
  deltaV: number;
  /** Main-drive acceleration at full throttle now, m/s². */
  maxAccel: number;
  /** Total mass now, kg. */
  mass: number;
  throttle: number;
  sasMode: SasMode;
  /** Stored heat / capacity (above 1 the hull is taking damage). */
  heatFraction: number;
  hullFraction: number;
  inAtmosphere: boolean;
  /** Pa */
  dynamicPressure: number;
  nextNode: NextNodeView | null;
  /** Fuel tender can be called right now (dry tanks in a stable orbit). */
  canCallTender: boolean;
}

export interface TargetInfo {
  ref: TargetRef;
  name: string;
  /** m (to the centre of a body). */
  distance: number;
  /** m/s */
  relSpeed: number;
  /** Rate at which the distance shrinks, m/s (negative when opening). */
  closingSpeed: number;
  /** Target velocity minus ship velocity, system axes, m/s. */
  relVelocity: V3;
  /** Unit vector from the ship to the target, system axes. */
  direction: V3;
  /** Next closest pass on the predicted path (after the flight plan), or null when unknown. */
  closestApproach: { time: number; distance: number } | null;
  /** Angle between the ship's orbit plane and the target's, rad; null unless both orbit the same body. */
  relativeInclination: number | null;
  /** True when ship and target orbit the same body. */
  sameSoi: boolean;
}

export interface Contact {
  ref: TargetRef;
  name: string;
  kind: TargetRef['kind'];
  /** From the ship, m. */
  distance: number;
  /** Body the contact orbits ('' for the primary star). */
  soiBodyId: string;
  /** Position relative to the ship, system axes, m. */
  rel: V3;
}

export interface CargoView {
  commodityId: string;
  name: string;
  units: number;
  /** Average price paid per unit, cr. */
  avgPaid: number;
}

export interface PlayerView {
  pilotName: string;
  credits: number;
  shipId: string;
  shipName: string;
  cargo: CargoView[];
  /** Units (tonnes) on board / hold size. */
  cargoUsed: number;
  cargoCapacity: number;
  /** Credits + trade-in value of the ship + cargo at galactic average prices. */
  netWorth: number;
  stats: { flights: number; dockings: number; profit: number; distance: number; trades: number; rebuys: number; tenders: number };
  /** Last station docked at (where a replacement ship is delivered). */
  lastStationId: string;
}

export interface ShipPose {
  soiBodyId: string;
  /** Relative to the SOI body, system axes. */
  r: V3;
  v: V3;
  /** Ship-local -> world. */
  q: Quat;
  /** Main drive output 0..1 (0 with a dry tank). */
  throttle: number;
  /** RCS translation command, ship-local, each -1..1. */
  rcs: V3;
  /** Stored heat / capacity. */
  heat: number;
  docked: boolean;
  destroyed: boolean;
}

export interface StationPose {
  soiBodyId: string;
  r: V3;
  v: V3;
  /** Station-local -> world (fixed: stations do not rotate). */
  q: Quat;
}

export interface Diagnostics {
  /** Subsystem exceptions caught since the game was created. */
  faults: number;
  lastFault: string;
  /** Sim steps whose result was not finite and was rolled back. */
  rollbacks: number;
}

// ------------------------------------------------------------------------------------------------ the facade

export interface GameSim {
  readonly galaxy: GalaxyDef;
  /** The system the player is in (jumps are not in this build). */
  readonly system: SystemDef;
  readonly model: SystemModel;
  readonly events: EventBus<GameEvents>;
  /** The whole saved state. Read-only for callers: change it through the actions. */
  readonly state: Readonly<GameState>;

  /** Advance the game by one frame of `realDt` seconds (clamped to 0.1 s); applies time warp. */
  step(realDt: number): void;
  /** Sim seconds since the epoch. */
  time(): number;

  // ---- time warp
  warp(): WarpView;
  /** Ask for a warp multiplier (rounded down to a level). Fails, raising warp as far as allowed, when the situation limits it. */
  setWarp(multiplier: number): ActionResult;
  warpUp(): ActionResult;
  warpDown(): ActionResult;

  // ---- manual flight
  /**
   * Stick, throttle and RCS input. Ignored while docked. Call it every frame or only on change, as you like:
   * a throttle value is "player input" only when it differs from the one sent before, so a UI that resends its
   * slider every frame does not fight the flight computer or the automatic cut-off at the end of a node burn.
   * Stick beyond the dead zone, RCS translation or a moved throttle disengage the autopilot.
   */
  setControls(c: Partial<VesselControls>): void;
  /** Change the SAS hold mode (disengages the autopilot). */
  setSas(mode: SasMode): ActionResult;

  // ---- targeting
  setTarget(ref: TargetRef | null): ActionResult;
  target(): TargetRef | null;

  // ---- flight plan
  nodes(): readonly ManeuverNode[];
  addNode(t: number, dv?: Partial<NodeDv>): ActionResult & { id?: string };
  updateNode(id: string, patch: { t?: number; dv?: Partial<NodeDv> }): ActionResult;
  removeNode(id: string): ActionResult;
  clearNodes(): void;
  /** Ask the flight computer for a plan; on success it replaces the flight plan. */
  plan(kind: PlanKind): ActionResult & { summary?: string; totalDv?: number; arrivalTime?: number; warnings?: string[] };
  trajectory(): TrajectoryView;

  // ---- flight computer
  autopilot(): AutopilotView;
  engageAutopilot(cmd: AutopilotCommand): ActionResult;
  disengageAutopilot(): void;

  // ---- docking
  dockingState(): DockingView;
  /**
   * Ask a station for a berth (default: the targeted station, else the nearest). Granted within 50 km and
   * under 200 m/s relative: the station tug then takes the ship to the berth in 15-40 s (warp drops to 1).
   * Flying to within 30 m of a berth's mating point under 3 m/s is a capture too, with or without clearance.
   */
  requestDocking(stationId?: string): ActionResult;
  cancelDocking(): void;
  undock(): ActionResult;
  dockedStation(): StationDef | null;

  // ---- station services (docked only)
  market(): MarketRow[];
  /** Quotes are clamped to what the player can actually do (hold space, credits, units on board, station stock). */
  quoteBuy(commodityId: string, units: number): TradeQuote;
  quoteSell(commodityId: string, units: number): TradeQuote;
  buy(commodityId: string, units: number): ActionResult;
  sell(commodityId: string, units: number): ActionResult;
  refuelQuote(): { kg: number; cost: number; pricePerKg: number };
  /** Buy propellant: `kg`, or as much as the tank takes and the credits cover. */
  refuel(kg?: number): ActionResult;
  repairQuote(): { cost: number };
  repair(): ActionResult;

  // ---- views
  flightInfo(): FlightInfo;
  targetInfo(): TargetInfo | null;
  contacts(): readonly Contact[];
  player(): PlayerView;
  shipPose(): ShipPose;
  /** Where a station is and how it is oriented right now (for the renderer). Null for an unknown id. */
  stationPose(stationId: string): StationPose | null;

  // ---- persistence and failure
  /** The whole game as a JSON string (also announces `saved`). Feed it to loadGame. */
  save(): string;
  /** After destruction: pay a share of the ship's value and wake up docked at the last station in a replacement ship. */
  rebuy(): ActionResult;
  rebuyQuote(): { cost: number; stationId: string };
  /** Dry tanks in a stable orbit: a tender brings 20 % of a tank for a fee and a few hours of sim time. */
  callTender(): ActionResult;
  tenderQuote(): { kg: number; cost: number; hours: number };
  diagnostics(): Diagnostics;
}
