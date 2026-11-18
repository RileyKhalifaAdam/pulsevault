// Autopilot / guidance layer. INTERFACE STUB: the exported names and signatures below are the contract the
// game loop (src/sim/game.ts) is written against. The implementation is being written by the flight-assist
// engineer, who replaces the bodies and may add fields, but must keep every export here compatible.
//
// The autopilot flies a Vessel exactly as a player could: it only writes vessel.controls / vessel.sasMode and
// asks for a time-warp ceiling. It never edits r, v or fuel.

import type { StationLayout } from '../core/types';
import type { SystemModel } from './orbit';
import type { Vessel } from './physics';
import type { ManeuverNode } from './planner';

export type AutopilotCommand =
  /** Fly the next node of the flight plan (slew, coast, burn, cut off), then stop. */
  | { kind: 'executeNode' }
  /** Fly every node of the flight plan in order. */
  | { kind: 'flyPlan' }
  /** Plan and fly the whole trip to a station anywhere in the system, then approach and dock. */
  | { kind: 'goToStation'; stationId: string }
  /** Terminal approach and docking; the ship must already be near the station. */
  | { kind: 'dock'; stationId: string }
  /** Null the velocity relative to a station, then hold. */
  | { kind: 'matchVelocity'; stationId: string };

export type AutopilotMode = 'idle' | AutopilotCommand['kind'];

/** Plain JSON-serialisable autopilot state (lives in the save file). */
export interface AutopilotState {
  mode: AutopilotMode;
  /** Station the current command is about, if any. */
  stationId: string | null;
  /** Machine-readable phase within the mode, e.g. 'slew' | 'coast' | 'burn' | 'approach' | 'align' | 'final'. */
  phase: string;
  /** One human-readable line for the HUD, e.g. "Transfer burn in 2m 10s · 1.84 km/s". Empty when idle. */
  status: string;
  /** Set when the last command ended in failure; cleared by the next engage. */
  failed: string | null;
  /** Implementation-private working data; plain JSON only. */
  data: Record<string, unknown>;
}

/** What the game hands the autopilot on every call. */
export interface AutopilotCtx {
  model: SystemModel;
  /** Sim time at the start of the step, s. */
  t: number;
  /** Sim seconds the following physics step will advance. */
  dt: number;
  /** The player's flight plan. Mutable: the autopilot removes nodes it has flown and may insert nodes it planned. */
  nodes: ManeuverNode[];
  /** Physical layout of a station (ports, colliders), or null when unknown. */
  stationLayout(stationId: string): StationLayout | null;
}

export interface AutopilotOutput {
  /** False once the autopilot is idle (finished, failed or never engaged). */
  engaged: boolean;
  /**
   * Highest time-warp multiplier the autopilot can tolerate until the next call (1 = real time).
   * The game still applies its own physics limits on top.
   */
  maxWarp: number;
  /** True when ctx.nodes was changed during this call (the game must re-predict the trajectory). */
  nodesChanged: boolean;
  /** Set on the step in which soft capture at a docking port is achieved; the game then docks the ship. */
  captured: { stationId: string; portId: string } | null;
  /** True on the step in which the command completed successfully. */
  finished: boolean;
}

export type AutopilotResult = { ok: true } | { ok: false; reason: string };

export function createAutopilot(): AutopilotState {
  return { mode: 'idle', stationId: null, phase: '', status: '', failed: null, data: {} };
}

/** Start a command. Returns a human-readable reason when it cannot start. */
export function engageAutopilot(ap: AutopilotState, cmd: AutopilotCommand, _vessel: Vessel, _ctx: AutopilotCtx): AutopilotResult {
  ap.failed = 'Flight computer not installed';
  void cmd;
  return { ok: false, reason: ap.failed };
}

/** Stop whatever is running and leave the ship safe: throttle 0, stability hold. */
export function disengageAutopilot(ap: AutopilotState, vessel: Vessel): void {
  ap.mode = 'idle';
  ap.stationId = null;
  ap.phase = '';
  ap.status = '';
  ap.data = {};
  vessel.controls.throttle = 0;
}

/**
 * Called by the game once before every physics step (stepVessel) with that step's dt, and once per
 * on-rails coast segment. Writes vessel.controls / vessel.sasMode.
 */
export function stepAutopilot(ap: AutopilotState, _vessel: Vessel, _ctx: AutopilotCtx): AutopilotOutput {
  return { engaged: ap.mode !== 'idle', maxWarp: 1, nodesChanged: false, captured: null, finished: false };
}
