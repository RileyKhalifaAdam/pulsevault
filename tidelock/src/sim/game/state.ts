// GameState: everything the game saves. Plain JSON — no class instances, Maps, Infinity or NaN.
// Static data (galaxy, system model, layouts, ship statistics) is regenerated from `seed` and `loadout`.

import type { Quat, V3 } from '../../core/types';
import { createAutopilot, type AutopilotState } from '../autopilot';
import { initEconomy, type EconomyState } from '../economy';
import type { Vessel } from '../physics';
import type { ManeuverNode } from '../planner';
import type { Loadout } from '../ships';
import type { GalaxyDef } from '../universe';
import type { TargetRef } from './api';

// ------------------------------------------------------------------------------------------------ tunables

export const SAVE_FORMAT = 'tidelock-save';
export const SAVE_VERSION = 1;

/** Longest frame step() accepts, real seconds (a tab switch must not become a giant step). */
export const MAX_FRAME_DT = 0.1;
/** Longest sim interval between two autopilot / collision / capture checks while integrating, s. */
export const PHYS_STEP = 0.1;

export const START_CREDITS = 5000;
export const START_SHIP = 'wren' as const;

/** Soft capture: within this distance of the berth's mating point (m) and below this relative speed (m/s). */
export const CAPTURE_DISTANCE = 30;
export const CAPTURE_SPEED = 3;
/** The autopilot may report capture from a little further out; beyond this the report is ignored. */
export const AUTOPILOT_CAPTURE_DISTANCE = 120;
export const AUTOPILOT_CAPTURE_SPEED = 10;
/** Undocking: the ship is carried this far out along the berth axis (m from the mating point) in this many seconds. */
export const RELEASE_DISTANCE = 20;
export const RELEASE_TIME = 6;
/** Clearance lapses beyond this multiple of the control-zone radius. */
export const CLEARANCE_RANGE = 1.5;

/** Station collisions: harmless below this normal speed (m/s); the hull is lost at about COLLISION_LETHAL_SPEED. */
export const COLLISION_SAFE_SPEED = 3;
export const COLLISION_LETHAL_SPEED = 48;
export const COLLISION_RESTITUTION = 0.3;
/** Inside a station's bounding sphere plus this margin (m) the ship is integrated, never on rails. */
export const STATION_PHYSICS_MARGIN = 100;

/** Warp is brought down this many sim seconds before a node's burn starts. */
export const NODE_WARP_LEAD = 12;
/** ...and before the closest pass of the target, when that pass comes within APPROACH_STOP_DISTANCE. */
export const APPROACH_STOP_LEAD = 30;
export const APPROACH_STOP_DISTANCE = 100e3;

export const MAX_NODES = 8;

export const LOW_FUEL_FRACTION = 0.1;
export const HEAT_WARNING_FRACTION = 0.7;

/** Economy days simulated per frame at most (high warp must not hitch). */
export const MAX_DAY_TICKS_PER_FRAME = 3;

/** Replacement ship: share of the list value charged, and sim time lost. */
export const REBUY_SHARE = 0.05;
export const REBUY_TIME = 6 * 3600;
/** Fuel tender: fraction of a tank delivered, call-out fee (cr), price multiple on propellant, sim time it takes (s). */
export const TENDER_FRACTION = 0.2;
export const TENDER_FEE = 400;
export const TENDER_PRICE_MULTIPLE = 3;
export const TENDER_TIME = 4 * 3600;
/** A tender only comes when the tank is below this fraction. */
export const TENDER_MAX_FUEL = 0.05;

/** Full hull repair costs this share of the ship's list value. */
export const REPAIR_SHARE = 0.08;

// ------------------------------------------------------------------------------------------------ state

export interface CargoLot {
  /** Units (tonnes) on board. */
  units: number;
  /** Credits paid in total for the units still on board (average = paid / units). */
  paid: number;
}

export interface PlayerState {
  name: string;
  credits: number;
  /** By commodity id. */
  cargo: Record<string, CargoLot>;
  /** Last station docked at. */
  lastStationId: string;
  stats: { flights: number; dockings: number; profit: number; distance: number; trades: number; rebuys: number; tenders: number };
}

export interface DockingClearance {
  stationId: string | null;
  portId: string | null;
  granted: boolean;
}

/** The ship being moved by a berth: drawn in after soft capture, or carried clear after undocking. Station-local frame. */
export interface BerthTransit {
  kind: 'capture' | 'release';
  stationId: string;
  portId: string;
  /** Sim time it started and how long it takes, s. */
  t0: number;
  duration: number;
  /** Pose it started from: position (station-local m) and attitude (ship-local -> station-local). */
  p0: V3;
  q0: Quat;
}

/** Progress of the node burn being flown. */
export interface BurnTrack {
  nodeId: string;
  /** What is left of the burn, system axes, m/s. */
  rem: V3;
  /** Size of the burn when it started, m/s. */
  total: number;
}

export interface GameState {
  version: number;
  seed: number;
  /** Sim seconds since the epoch. */
  time: number;
  systemId: string;
  vessel: Vessel;
  loadout: Loadout;
  player: PlayerState;
  target: TargetRef | null;
  /** The flight plan, sorted by time. */
  nodes: ManeuverNode[];
  nodeSeq: number;
  burn: BurnTrack | null;
  autopilot: AutopilotState;
  /** Warp ceiling the autopilot asked for at its last step. */
  apMaxWarp: number;
  docking: DockingClearance;
  /** Berth the ship is in while docked. */
  dockedPortId: string | null;
  transit: BerthTransit | null;
  /** Indices into physics.WARP_LEVELS. */
  warp: { requested: number; index: number };
  input: {
    /** Last throttle value the app sent. */
    throttleSent: number;
    /** The game set the throttle itself (burn cut-off, docking…): ignore resent values until the player moves it. */
    throttleHold: boolean;
  };
  economy: EconomyState;
  /** Last economy day simulated. */
  day: number;
  flags: { fuelLow: boolean; heatHigh: boolean; thrusting: boolean; burnNodeId: string | null };
}

export function newPlayer(name: string, stationId: string): PlayerState {
  return {
    name,
    credits: START_CREDITS,
    cargo: {},
    lastStationId: stationId,
    stats: { flights: 0, dockings: 0, profit: 0, distance: 0, trades: 0, rebuys: 0, tenders: 0 },
  };
}

/** Everything of a new game except the vessel (the game places it on its berth). */
export function newGameState(galaxy: GalaxyDef, seed: number, pilotName: string, vessel: Vessel, loadout: Loadout, portId: string): GameState {
  return {
    version: SAVE_VERSION,
    seed,
    time: 0,
    systemId: galaxy.startSystemId,
    vessel,
    loadout,
    player: newPlayer(pilotName, galaxy.startStationId),
    target: null,
    nodes: [],
    nodeSeq: 1,
    burn: null,
    autopilot: createAutopilot(),
    apMaxWarp: 1,
    docking: { stationId: null, portId: null, granted: false },
    dockedPortId: portId,
    transit: null,
    warp: { requested: 0, index: 0 },
    input: { throttleSent: 0, throttleHold: false },
    economy: initEconomy(galaxy, seed),
    day: 0,
    flags: { fuelLow: false, heatHigh: false, thrusting: false, burnNodeId: null },
  };
}
