// TIDELOCK autopilot / guidance layer: the part of the flight computer that flies.
//
// The autopilot flies a Vessel exactly as a player could. It writes only `vessel.controls` (throttle, RCS
// translation, roll) and the SAS (`vessel.sasMode` = 'stability' plus the SAS hold direction
// `vessel.sasTarget`, which is how it points the ship: the torque-limited SAS of physics.ts does the turning),
// and it reports the highest time warp it can tolerate. It never edits r, v, q, w or fuel.
//
// Commands
//   executeNode / flyPlan  fly the next / every manoeuvre node of ctx.nodes: slew to the burn vector, coast
//                          (high warp) until the burn should start, burn on velocity-to-be-gained guidance,
//                          throttle down at the end, trim the last cm/s on RCS, remove the node.
//   matchVelocity          null the velocity relative to a station.
//   dock                   closed-loop approach to a docking port: around the station outside its keep-out
//                          sphere, down the port's approach axis under a speed limit, soft capture.
//   goToStation            the whole trip as explicit stages: clear the station we are next to, plan
//                          (planner.planToStation), fly the burns with mid-course corrections, capture,
//                          rendezvous, terminal approach, dock.
//
// Burn guidance. A node is an impulse dv at time tn. The reference is the conic the ship would be on after
// that impulse; during the finite burn the velocity to be gained is vg(t) = v_ref(t) − v_ship(t), thrust
// points along vg and stops when vg is gone. The burn is timed so that its Δv centroid falls on tn, which
// cancels the first-order position error of a finite burn. For a 'match-velocity' node of a rendezvous the
// reference is the station itself, so the burn really ends at rest relative to it.
//
// State is plain JSON (`AutopilotState`): a save made at any moment resumes. Public functions never throw.
// Pure simulation code: no three.js, no DOM, no randomness.

import type { DockingPortDef, Quat, StateVector, StationDef, StationLayout, V3 } from '../core/types';
import { fmtDistance, fmtDuration, fmtSpeed } from '../core/units';
import { PAD_CLEARANCE } from '../data/stationLayouts';
import { newState, predictTrajectory, propagateStateTo } from './orbit';
import type { SystemModel } from './orbit';
import {
  PHYSICS_WARP_MAX,
  WARP_LEVELS,
  currentAccel,
  deltaVRemaining,
  fromStationLocal,
  newColliderContact,
  pointingError,
  stationAttitude,
  stationContact,
  toStationLocal,
  totalMass,
  vesselForward,
} from './physics';
import type { Vessel } from './physics';
import { planCapture, planCorrection, planRendezvousCorrection, planToStation, predictWithNodes, shipFromVessel } from './planner';
import type { ManeuverNode, PlanOk } from './planner';

// ===================================================================================== public contract

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
  /**
   * Machine-readable phase within the mode: 'plan' | 'clear' | 'slew' | 'coast' | 'burn' | 'trim' |
   * 'approach' | 'align' | 'final' | 'match'.
   */
  phase: string;
  /** One human-readable line for the HUD, e.g. "Transfer burn in 2m 10s · 1.84 km/s". Empty when idle. */
  status: string;
  /** Set when the last command ended in failure; cleared by the next engage. */
  failed: string | null;
  /**
   * Implementation-private working data; plain JSON only. Fields the game may read:
   *  `portId`  – docking port chosen for the approach (dock / goToStation), once known;
   *  `trip`    – goToStation bookkeeping: `stage`, `dvPlanned` (m/s, sum of every plan flown so far),
   *              `legs`, `t0` (sim time of engage), `fuel0` (kg at engage).
   */
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

// ===================================================================================== tuning

/** Real seconds of warning the warp ceiling keeps before an autopilot event (must exceed the game's frame time). */
const WARP_LEAD = 0.5;
/** Rails warp ends this many sim seconds before ignition, leaving time to check the attitude under physics. */
const SETTLE_TIME = 8;
/** Pointing error (rad) below which the main drive may light. */
const POINT_TOL = 0.03;
/** Burns smaller than this (m/s) are flown on RCS alone, in whatever attitude the ship has. */
const RCS_ONLY_DV = 0.8;
/** Velocity-to-be-gained (m/s) at which the main drive hands over to the RCS trim. */
const TRIM_AT = 0.4;
/** Velocity-to-be-gained (m/s) at which a burn counts as delivered. */
const TRIM_DONE = 0.012;
/** Time constants (s) of the throttle and RCS velocity loops. */
const THROTTLE_TAU = 1.0;
const RCS_TAU = 1.0;
/** Relative-velocity error (m/s) above which close-range guidance lights the main drive, and below which it stops. */
const MAIN_ON = 1.5;
const MAIN_OFF = 0.4;
/** RCS dead band on the velocity error, m/s. */
const RCS_DEADBAND = 0.004;
/** Speed limits, m/s: outside a station's control zone, inside it, hugging the keep-out sphere, on the approach axis. */
const SPEED_FAR = 100;
const SPEED_ZONE = 30;
const SPEED_SHELL = 8;
const SPEED_AXIS = 5;
/** goToStation hands over to terminal guidance inside this range (m) and relative speed (m/s). */
const TERMINAL_RANGE = 30000;
const TERMINAL_SPEED = 250;
/** `dock` accepts a start inside this range, m. */
const DOCK_RANGE = 60000;
/** Before a departure the ship parks this far (m, beyond the station's bounding radius) ahead of / behind the station on its orbit. */
const CLEAR_DISTANCE = 2000;
/** A station closer than this (m) counts as "next to us" for the departure clearance. */
const CLEAR_RANGE = 5000;
/** Soft capture: ship centre within this distance (m) of its seat on the port axis, lateral error and speed below these. */
const CAPTURE_AXIAL = 1.2;
const CAPTURE_LATERAL = 2.5;
const CAPTURE_SPEED = 0.6;
/** A goToStation trip plans at most this many legs before giving up. */
const MAX_LEGS = 8;
/** A rendezvous is corrected mid-course when the predicted arrival misses the planned stand-off by more than this, m. */
const MISS_TOLERANCE = 1500;

// ===================================================================================== private state shapes

type BurnPhase = 'slew' | 'coast' | 'burn' | 'trim';

/** One node being flown. */
interface Burn {
  nodeId: string;
  /** Snapshot of the node, to notice edits by the player. */
  nodeT: number;
  pro: number;
  nor: number;
  rad: number;
  phase: BurnPhase;
  label: string;
  /** Station whose velocity the burn matches (rendezvous arrival), or null. */
  matchId: string | null;
  /** Reference conic: state (relative to `body`) at sim time `tRef`. The burn ends when the ship has its velocity. */
  body: string;
  tRef: number;
  r: V3;
  v: V3;
  /** Unit burn direction at the node, system axes, and the planned Δv, m/s. */
  dir: V3;
  dv: number;
  /** Sim time the burn should start, and its expected duration, s. */
  tIgnite: number;
  duration: number;
  rcsOnly: boolean;
  /** True when the tanks do not hold enough for the whole burn. */
  short: boolean;
  /** Sim time of ignition / of the start of the RCS trim, or -1. */
  started: number;
  trimT: number;
  /** Thrust direction frozen for the last metres per second, or null while it still tracks vg. */
  hold: V3 | null;
  /** True once the path ahead has been checked for stations. */
  pathChecked: boolean;
}

interface DockData {
  stationId: string;
  portId: string;
  /** Distance (m) along the port axis from the mating point to the gate where the final approach starts. */
  gateDist: number;
  phase: 'approach' | 'final';
  t0: number;
}

interface Leg {
  kind: 'rendezvous' | 'transfer';
  /** Body the leg ends at (the station's parent for a rendezvous). */
  hop: string;
  /** transfer: requested periapsis radius at `hop`, m, and the plane normal of the arrival orbit (or null). */
  rp: number;
  normal: V3 | null;
  /** Planned arrival (rendezvous: time of the velocity match), sim s. */
  arrival: number;
  corrections: number;
  /** Sim time of the next course check, or -1. */
  nextCheck: number;
  /** transfer: true once the capture burn has been re-planned inside the target's sphere of influence. */
  captureDone: boolean;
}

interface Trip {
  stage: 'plan' | 'clear' | 'fly' | 'terminal';
  legs: number;
  leg: Leg | null;
  /** Station being cleared before departure, the side of it we park on (+1 ahead, -1 behind) and how often we tried. */
  clearId: string | null;
  clearSide: number;
  clearTries: number;
  cleared: boolean;
  dvPlanned: number;
  t0: number;
  fuel0: number;
}

interface ApData {
  burn?: Burn | null;
  dock?: DockData | null;
  trip?: Trip | null;
  portId?: string | null;
  /** Close-range guidance: the main drive is in use (hysteresis). */
  mainOn?: boolean;
}

type StepResult = 'running' | 'done' | 'failed';

// ===================================================================================== small helpers

const vlen = (a: V3): number => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
const vdot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const vsub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const vadd = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const vscale = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const vaddScaled = (a: V3, b: V3, s: number): V3 => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s });
const vcross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const vnorm = (a: V3): V3 => {
  const l = vlen(a);
  return l > 0 ? vscale(a, 1 / l) : { x: 0, y: 0, z: 0 };
};
const vcopy = (a: V3): V3 => ({ x: a.x, y: a.y, z: a.z });
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const finite = (a: V3): boolean => Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);

/** World vector -> ship-local axes: conj(q) · v. */
function toShipLocal(q: Quat, v: V3): V3 {
  const qx = -q.x;
  const qy = -q.y;
  const qz = -q.z;
  const qw = q.w;
  const tx = 2 * (qy * v.z - qz * v.y);
  const ty = 2 * (qz * v.x - qx * v.z);
  const tz = 2 * (qx * v.y - qy * v.x);
  return { x: v.x + qw * tx + (qy * tz - qz * ty), y: v.y + qw * ty + (qz * tx - qx * tz), z: v.z + qw * tz + (qx * ty - qy * tx) };
}

/** Ship-up (+Y local) in world axes. */
function vesselUp(q: Quat): V3 {
  return { x: 2 * (q.x * q.y - q.w * q.z), y: 1 - 2 * (q.x * q.x + q.z * q.z), z: 2 * (q.y * q.z + q.w * q.x) };
}

const dataOf = (ap: AutopilotState): ApData => ap.data as ApData;

/** Highest warp level L with L · WARP_LEAD <= `timeToEvent` (sim s) and L <= cap. */
function warpFor(timeToEvent: number, cap = Infinity): number {
  let best = 1;
  for (let i = 0; i < WARP_LEVELS.length; i++) {
    const L = WARP_LEVELS[i];
    if (L <= cap && L * WARP_LEAD <= timeToEvent) best = L;
  }
  return best;
}

function newOutput(ap: AutopilotState): AutopilotOutput {
  return { engaged: ap.mode !== 'idle', maxWarp: 1, nodesChanged: false, captured: null, finished: false };
}

function zeroControls(vessel: Vessel): void {
  const c = vessel.controls;
  c.pitch = 0;
  c.yaw = 0;
  c.roll = 0;
  c.throttle = 0;
  c.translate.x = 0;
  c.translate.y = 0;
  c.translate.z = 0;
}

/** Point the ship: the SAS holds ship-forward on the unit world direction `dir`. */
function aim(vessel: Vessel, dir: V3): void {
  if (!finite(dir) || !(vlen(dir) > 0.5)) return;
  vessel.sasMode = 'stability';
  const s = vessel.sasTarget;
  if (s) {
    s.x = dir.x;
    s.y = dir.y;
    s.z = dir.z;
  } else {
    vessel.sasTarget = vcopy(dir);
  }
}

/** Throttle factor for a pointing error (rad): full inside 0.05, none beyond 0.3. */
function pointingGate(err: number): number {
  return err < 0.05 ? 1 : err > 0.3 ? 0 : (0.3 - err) / 0.25;
}

/** Translational RCS acceleration per axis now, m/s² (0 with an empty tank). */
function rcsAccel(vessel: Vessel): number {
  if (!(vessel.fuel > 0) || !(vessel.stats.rcsExhaustVelocity > 0)) return 0;
  return vessel.stats.rcsThrust / totalMass(vessel);
}

/** RCS translation command that accelerates along the world vector `eW` (a velocity error, m/s). */
function rcsToward(vessel: Vessel, eW: V3, dt: number): void {
  const aR = rcsAccel(vessel);
  const tr = vessel.controls.translate;
  if (!(aR > 0) || !(vlen(eW) > RCS_DEADBAND)) {
    tr.x = 0;
    tr.y = 0;
    tr.z = 0;
    return;
  }
  const l = toShipLocal(vessel.q, eW);
  const k = 1 / (aR * Math.max(RCS_TAU, 2.5 * dt));
  tr.x = clamp(l.x * k, -1, 1);
  tr.y = clamp(l.y * k, -1, 1);
  tr.z = clamp(l.z * k, -1, 1);
}

/** Roll-rate command that turns ship-up toward the world direction `upW` (about the forward axis). */
function rollToward(vessel: Vessel, upW: V3, dt: number): void {
  const f = vesselForward(vessel);
  const k = vdot(upW, f);
  const want = { x: upW.x - k * f.x, y: upW.y - k * f.y, z: upW.z - k * f.z };
  if (!(vlen(want) > 0.2)) {
    vessel.controls.roll = 0;
    return;
  }
  const up = vesselUp(vessel.q);
  const phi = Math.atan2(vdot(f, vcross(up, want)), vdot(up, want));
  const rMax = Math.max(1e-3, vessel.stats.maxAngularRate);
  const rate = clamp(1.2 * phi, -Math.abs(phi) / Math.max(dt, 1e-3), Math.abs(phi) / Math.max(dt, 1e-3));
  vessel.controls.roll = clamp(rate / rMax, -0.6, 0.6);
}

/**
 * Close-range velocity control: make the velocity error `eW` (world axes, m/s: wanted minus actual) go to
 * zero. Large errors are burnt off with the main drive (the ship turns onto the error first), small ones
 * with the RCS in whatever attitude the ship has. `face` (+ optional `faceUp`) is the attitude to hold
 * while the main drive is not needed.
 */
function thrustToward(ap: AutopilotState, vessel: Vessel, dt: number, eW: V3, allowMain: boolean, face: V3 | null, faceUp: V3 | null): void {
  const d = dataOf(ap);
  const eMag = vlen(eW);
  const aM = currentAccel(vessel);
  let main = !!d.mainOn;
  if (!allowMain || !(aM > 0)) main = false;
  else if (!main && eMag > MAIN_ON) main = true;
  else if (main && eMag < MAIN_OFF) main = false;
  d.mainOn = main;
  if (main) {
    const dir = vscale(eW, 1 / eMag);
    aim(vessel, dir);
    const err = pointingError(vessel, dir);
    const along = vdot(eW, vesselForward(vessel));
    vessel.controls.throttle = clamp(along / (aM * Math.max(THROTTLE_TAU, 2.5 * dt)), 0, 1) * pointingGate(err);
  } else if (face) {
    aim(vessel, face);
    if (faceUp) rollToward(vessel, faceUp, dt);
  }
  if (!main || eMag < 2.5) rcsToward(vessel, eW, dt);
}

/**
 * Speed (m/s) at which to close a remaining distance `d` (m) and still stop. The RCS-only profile uses a
 * third of the RCS authority with a 6 s linear tail; beyond `dMain` (m) the main drive may brake too
 * (30 % of its thrust, with an 8 s linear tail that leaves time to turn the ship round).
 */
function brakeSpeed(d: number, vCap: number, aR: number, aM: number, allowMain: boolean, dMain = 0): number {
  const dd = Math.max(0, d);
  const vR = (x: number): number => Math.min(Math.sqrt(0.7 * aR * x), x / 6);
  if (!allowMain || !(aM > 0) || dd <= dMain) return Math.min(vCap, vR(dd));
  const x = dd - dMain;
  const vM = Math.min(Math.sqrt(0.6 * aM * x), Math.max(0, x - 10) / 8);
  return Math.min(vCap, Math.max(vR(dd), vR(dMain) + vM));
}

function stationOf(model: SystemModel, stationId: string): StationDef | null {
  try {
    return model.station(stationId);
  } catch {
    return null;
  }
}

const _stA = newState();
const _stB = newState();

/** Ship position / velocity relative to a station (ship − station), world axes, bridging SOI frames if needed. */
function relativeToStation(model: SystemModel, vessel: Vessel, st: StationDef, t: number): { p: V3; u: V3; dist: number; speed: number; sameSoi: boolean } {
  const ss = model.stationState(st.id, t, _stA);
  let sr = ss.r;
  let sv = ss.v;
  const sameSoi = st.parentBodyId === vessel.soiBodyId;
  if (!sameSoi) {
    const c = model.changeFrame(ss, st.parentBodyId, vessel.soiBodyId, t, _stB);
    sr = c.r;
    sv = c.v;
  }
  const p = vsub(vessel.r, sr);
  const u = vsub(vessel.v, sv);
  return { p, u, dist: vlen(p), speed: vlen(u), sameSoi };
}

/** Nearest station in the vessel's SOI within `maxDist` metres, or null. */
function nearestStation(model: SystemModel, vessel: Vessel, t: number, maxDist: number): { st: StationDef; dist: number } | null {
  let best: { st: StationDef; dist: number } | null = null;
  for (const st of model.def.stations) {
    if (st.parentBodyId !== vessel.soiBodyId) continue;
    const ss = model.stationState(st.id, t, _stA);
    const d = vlen(vsub(vessel.r, ss.r));
    if (d <= maxDist && (!best || d < best.dist)) best = { st, dist: d };
  }
  return best;
}

/** A station within 8 km whose bounding sphere (plus margin) lies on the ray from the ship along `dir`, or null. */
function stationInPath(vessel: Vessel, ctx: AutopilotCtx, dir: V3): StationDef | null {
  for (const st of ctx.model.def.stations) {
    if (st.parentBodyId !== vessel.soiBodyId) continue;
    const ss = ctx.model.stationState(st.id, ctx.t, _stA);
    const rel = vsub(ss.r, vessel.r);
    const d = vlen(rel);
    if (d > 8000) continue;
    const layout = ctx.stationLayout(st.id);
    const keep = (layout ? layout.radius : 400) + vessel.stats.radius + 150;
    if (d < keep) return st;
    const along = vdot(rel, dir);
    if (along <= 0) continue;
    const perp = Math.sqrt(Math.max(0, d * d - along * along));
    if (perp < keep) return st;
  }
  return null;
}

const NODE_LABELS: [string, string][] = [
  ['rendezvous-depart', 'Departure burn'],
  ['match-velocity', 'Velocity match'],
  ['capture', 'Capture burn'],
  ['eject', 'Ejection burn'],
  ['transfer', 'Transfer burn'],
  ['circularize', 'Circularisation'],
  ['correction', 'Course correction'],
  ['match-plane', 'Plane change'],
  ['raise-periapsis', 'Periapsis raise'],
  ['set-', 'Apsis burn'],
];

function nodeLabel(node: ManeuverNode): string {
  for (const [k, label] of NODE_LABELS) if (node.id.startsWith(k)) return label;
  return 'Burn';
}

function nextNode(nodes: readonly ManeuverNode[]): ManeuverNode | null {
  let best: ManeuverNode | null = null;
  for (const n of nodes) if (n && Number.isFinite(n.t) && (!best || n.t < best.t)) best = n;
  return best;
}

function removeNode(nodes: ManeuverNode[], id: string): boolean {
  let removed = false;
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i].id === id) {
      nodes.splice(i, 1);
      removed = true;
    }
  }
  return removed;
}

// ===================================================================================== lifecycle

export function createAutopilot(): AutopilotState {
  return { mode: 'idle', stationId: null, phase: '', status: '', failed: null, data: {} };
}

/** Stop whatever is running and leave the ship safe: throttle 0, stability hold. */
export function disengageAutopilot(ap: AutopilotState, vessel: Vessel): void {
  ap.mode = 'idle';
  ap.stationId = null;
  ap.phase = '';
  ap.status = '';
  ap.data = {};
  zeroControls(vessel);
  vessel.sasMode = 'stability';
  vessel.sasTarget = null;
}

function failAutopilot(ap: AutopilotState, vessel: Vessel, reason: string): void {
  disengageAutopilot(ap, vessel);
  ap.failed = reason;
}

function refuse(ap: AutopilotState, reason: string): AutopilotResult {
  ap.failed = reason;
  return { ok: false, reason };
}

/** Start a command. Returns a human-readable reason when it cannot start. */
export function engageAutopilot(ap: AutopilotState, cmd: AutopilotCommand, vessel: Vessel, ctx: AutopilotCtx): AutopilotResult {
  try {
    if (ap.mode !== 'idle') disengageAutopilot(ap, vessel);
    ap.failed = null;
    ap.data = {};
    ap.status = '';
    ap.phase = '';
    ap.stationId = null;
    if (!cmd || typeof cmd.kind !== 'string') return refuse(ap, 'Unknown autopilot command');
    if (vessel.destroyed) return refuse(ap, 'The ship is lost');
    if (vessel.dockedAt !== null) return refuse(ap, 'Undock before engaging the autopilot');
    if (!finite(vessel.r) || !finite(vessel.v) || !ctx.model.hasBody(vessel.soiBodyId)) return refuse(ap, 'No valid navigation state');
    const d = dataOf(ap);
    switch (cmd.kind) {
      case 'executeNode':
      case 'flyPlan': {
        const node = nextNode(ctx.nodes);
        if (!node) return refuse(ap, 'There is no manoeuvre node to fly');
        if (!(vessel.fuel > 0)) return refuse(ap, 'The tanks are empty');
        const b = setupBurn(vessel, ctx, node, null);
        if (typeof b === 'string') return refuse(ap, b);
        d.burn = b;
        ap.mode = cmd.kind;
        ap.phase = b.phase;
        ap.status = `${b.label} · ${fmtSpeed(b.dv)}`;
        return { ok: true };
      }
      case 'matchVelocity': {
        const st = stationOf(ctx.model, cmd.stationId);
        if (!st) return refuse(ap, 'Unknown station');
        const rel = relativeToStation(ctx.model, vessel, st, ctx.t);
        if (rel.speed > deltaVRemaining(vessel) + 5) return refuse(ap, `Not enough propellant to match velocity with ${st.name} (${fmtSpeed(rel.speed)})`);
        ap.mode = 'matchVelocity';
        ap.stationId = st.id;
        ap.phase = 'match';
        ap.status = `Matching velocity with ${st.name}`;
        return { ok: true };
      }
      case 'dock': {
        const st = stationOf(ctx.model, cmd.stationId);
        if (!st) return refuse(ap, 'Unknown station');
        if (!(vessel.fuel > 0)) return refuse(ap, 'The tanks are empty');
        const rel = relativeToStation(ctx.model, vessel, st, ctx.t);
        if (!rel.sameSoi || rel.dist > DOCK_RANGE) return refuse(ap, `Too far from ${st.name} to dock (${fmtDistance(rel.dist)}): fly a rendezvous first`);
        if (rel.speed > deltaVRemaining(vessel)) return refuse(ap, `Not enough propellant to stop at ${st.name}`);
        const dk = setupDock(vessel, ctx, st);
        if (typeof dk === 'string') return refuse(ap, dk);
        d.dock = dk;
        d.portId = dk.portId;
        ap.mode = 'dock';
        ap.stationId = st.id;
        ap.phase = 'approach';
        ap.status = `Docking at ${st.name}`;
        return { ok: true };
      }
      case 'goToStation': {
        const st = stationOf(ctx.model, cmd.stationId);
        if (!st) return refuse(ap, 'Unknown station');
        if (!(vessel.fuel > 0)) return refuse(ap, 'The tanks are empty');
        if (!ctx.stationLayout(st.id)) return refuse(ap, `No docking data for ${st.name}`);
        const rel = relativeToStation(ctx.model, vessel, st, ctx.t);
        if (!(rel.sameSoi && rel.dist < TERMINAL_RANGE && rel.speed < TERMINAL_SPEED)) {
          // Trial plan: refuse now, with the planner's reason, rather than a few seconds into the trip.
          const trial = planLeg(vessel, ctx, st);
          if (typeof trial === 'string') return refuse(ap, trial);
          const near = nearestStation(ctx.model, vessel, ctx.t, CLEAR_RANGE);
          const short = budgetProblem(vessel, st, trial.plan, near ? 150 : 0);
          if (short) return refuse(ap, short);
        }
        d.trip = { stage: 'plan', legs: 0, leg: null, clearId: null, clearSide: 1, clearTries: 0, cleared: false, dvPlanned: 0, t0: ctx.t, fuel0: vessel.fuel };
        ap.mode = 'goToStation';
        ap.stationId = st.id;
        ap.phase = 'plan';
        ap.status = `Plotting a course to ${st.name}`;
        return { ok: true };
      }
      default:
        return refuse(ap, 'Unknown autopilot command');
    }
  } catch (e) {
    ap.mode = 'idle';
    ap.data = {};
    return refuse(ap, `Flight computer fault: ${e instanceof Error ? e.message : 'unknown'}`);
  }
}

/**
 * Called by the game once before every physics step (stepVessel) with that step's dt, and once per
 * on-rails coast segment. Writes vessel.controls / the SAS hold and returns the warp ceiling for the
 * step after this one.
 */
export function stepAutopilot(ap: AutopilotState, vessel: Vessel, ctx: AutopilotCtx): AutopilotOutput {
  const out = newOutput(ap);
  if (ap.mode === 'idle') return out;
  try {
    if (vessel.destroyed) {
      failAutopilot(ap, vessel, 'The ship was lost');
    } else if (vessel.dockedAt !== null) {
      // Docked by the game (or by hand): nothing left to fly.
      disengageAutopilot(ap, vessel);
      out.finished = true;
    } else {
      zeroControls(vessel);
      const dt = ctx.dt > 0 && ctx.dt < Infinity ? ctx.dt : 1 / 60;
      switch (ap.mode) {
        case 'executeNode':
        case 'flyPlan':
          stepPlanFlight(ap, vessel, ctx, dt, out);
          break;
        case 'matchVelocity':
          stepMatchVelocity(ap, vessel, ctx, dt, out);
          break;
        case 'dock':
          stepDockCommand(ap, vessel, ctx, dt, out);
          break;
        case 'goToStation':
          stepTrip(ap, vessel, ctx, dt, out);
          break;
      }
    }
  } catch (e) {
    failAutopilot(ap, vessel, `Flight computer fault: ${e instanceof Error ? e.message : 'unknown'}`);
  }
  if (!(out.maxWarp >= 1)) out.maxWarp = 1;
  out.engaged = ap.mode !== 'idle';
  return out;
}

function finish(ap: AutopilotState, vessel: Vessel, out: AutopilotOutput): void {
  disengageAutopilot(ap, vessel);
  out.finished = true;
}

// ===================================================================================== node execution

/** Duration (s) of a main-drive burn of `dv` and how long before the node it has to start so its Δv centroid falls on the node. */
function burnTiming(vessel: Vessel, dv: number): { duration: number; lead: number; short: boolean } {
  const ve = vessel.stats.exhaustVelocity;
  const F = vessel.stats.mainThrust;
  if (!(F > 0 && ve > 0) || !(vessel.fuel > 0)) return { duration: 0, lead: 0, short: true };
  const m0 = totalMass(vessel);
  const mdot = F / ve;
  const mMin = m0 - vessel.fuel;
  let m1 = m0 * Math.exp(-dv / ve);
  let short = false;
  if (m1 < mMin) {
    m1 = mMin;
    short = true;
  }
  const T = (m0 - m1) / mdot;
  const dvEff = ve * Math.log(m0 / m1);
  const after = dvEff > 1e-9 ? (ve / (mdot * dvEff)) * (m0 - m1 - m1 * Math.log(m0 / m1)) : 0.5 * T;
  return { duration: T, lead: T - after, short };
}

/** Work out how to fly `node` from the vessel's present coasting state. Returns a reason when it cannot be flown. */
function setupBurn(vessel: Vessel, ctx: AutopilotCtx, node: ManeuverNode, matchId: string | null): Burn | string {
  const pred = predictWithNodes(ctx.model, shipFromVessel(vessel, ctx.t), [node], { maxPatches: 1, maxDuration: 1 });
  const a = pred.nodes[0];
  if (!a || !a.reached) return 'The trajectory ends before the burn point';
  const tRef = Math.max(node.t, ctx.t);
  let refR = a.after.r;
  let refV = a.after.v;
  let dvW = a.dvWorld;
  let match: string | null = null;
  if (matchId) {
    const st = stationOf(ctx.model, matchId);
    if (st && st.parentBodyId === a.bodyId) {
      const ss = ctx.model.stationState(st.id, tRef);
      refR = ss.r;
      refV = ss.v;
      dvW = vsub(ss.v, a.before.v);
      match = st.id;
    }
  }
  const dv = vlen(dvW);
  if (!Number.isFinite(dv)) return 'The manoeuvre node is invalid';
  const dir = dv > 1e-9 ? vscale(dvW, 1 / dv) : vesselForward(vessel);
  const aR = rcsAccel(vessel);
  const rcsOnly = dv < RCS_ONLY_DV && aR > 0;
  let duration: number;
  let lead: number;
  let short = false;
  if (rcsOnly) {
    duration = dv / aR;
    lead = 0.5 * duration;
  } else {
    const tm = burnTiming(vessel, dv);
    duration = tm.duration;
    lead = tm.lead;
    short = tm.short;
  }
  return {
    nodeId: node.id,
    nodeT: node.t,
    pro: node.dv.prograde,
    nor: node.dv.normal,
    rad: node.dv.radial,
    phase: 'slew',
    label: nodeLabel(node),
    matchId: match,
    body: a.bodyId,
    tRef,
    r: vcopy(refR),
    v: vcopy(refV),
    dir,
    dv,
    tIgnite: node.t - lead,
    duration,
    rcsOnly,
    short,
    started: -1,
    trimT: -1,
    hold: null,
    pathChecked: false,
  };
}

const _ref = newState();
const _refIn: StateVector = { r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } };
const _shipIn = newState();

/** Velocity still to be gained, world axes: reference-conic velocity now minus ship velocity. */
function velocityToGain(vessel: Vessel, ctx: AutopilotCtx, b: Burn): V3 {
  const model = ctx.model;
  _refIn.r.x = b.r.x;
  _refIn.r.y = b.r.y;
  _refIn.r.z = b.r.z;
  _refIn.v.x = b.v.x;
  _refIn.v.y = b.v.y;
  _refIn.v.z = b.v.z;
  propagateStateTo(_ref, _refIn, model.body(b.body).mu, ctx.t - b.tRef);
  let v = vessel.v;
  if (vessel.soiBodyId !== b.body) v = model.changeFrame(vessel, vessel.soiBodyId, b.body, ctx.t, _shipIn).v;
  return vsub(_ref.v, v);
}

/**
 * Fly the burn in `d.burn` one step further. 'done' = delivered (the caller removes the node),
 * 'failed' = the autopilot has been failed with a reason.
 */
function runBurn(ap: AutopilotState, vessel: Vessel, ctx: AutopilotCtx, dt: number, out: AutopilotOutput, matchId: string | null): StepResult {
  const d = dataOf(ap);
  let b = d.burn as Burn;
  const t = ctx.t;
  if (b.phase === 'slew' || b.phase === 'coast') {
    const node = ctx.nodes.find((n) => n.id === b.nodeId);
    if (!node) {
      failAutopilot(ap, vessel, 'The manoeuvre node was removed from the flight plan');
      return 'failed';
    }
    if (node.t !== b.nodeT || node.dv.prograde !== b.pro || node.dv.normal !== b.nor || node.dv.radial !== b.rad) {
      const nb = setupBurn(vessel, ctx, node, matchId);
      if (typeof nb === 'string') {
        failAutopilot(ap, vessel, nb);
        return 'failed';
      }
      b = nb;
      d.burn = b;
    }
    if (b.dv < 1e-4) return 'done';
    aim(vessel, b.dir);
    const err = b.rcsOnly ? 0 : pointingError(vessel, b.dir);
    const tti = b.tIgnite - t;
    const aligned = err < POINT_TOL;
    if (tti <= SETTLE_TIME + dt && !b.pathChecked) {
      // Last look before lighting the drive next to a station.
      b.pathChecked = true;
      if (b.dv > 5) {
        const blocker = stationInPath(vessel, ctx, b.dir);
        if (blocker) {
          d.burn = null;
          ap.status = `${blocker.name} is in the burn path`;
          return 'failed';
        }
      }
    }
    if (tti <= 0.5 * dt && aligned) {
      b.phase = 'burn';
      b.started = t;
    } else {
      const after = tti - dt;
      if (!aligned) {
        b.phase = 'slew';
        ap.status = `Aligning for ${b.label.toLowerCase()} · ${fmtSpeed(b.dv)}`;
        out.maxWarp = Math.min(PHYSICS_WARP_MAX, warpFor(after));
      } else {
        b.phase = 'coast';
        ap.status = `${b.label} in ${fmtDuration(Math.max(0, tti))} · ${fmtSpeed(b.dv)}${b.short ? ' · LOW PROPELLANT' : ''}`;
        out.maxWarp = after > SETTLE_TIME ? warpFor(after - SETTLE_TIME) : Math.min(PHYSICS_WARP_MAX, warpFor(after));
      }
      ap.phase = b.phase;
      return 'running';
    }
  }

  // Burning (main drive, then RCS trim).
  const vg = velocityToGain(vessel, ctx, b);
  const g = vlen(vg);
  const aM = currentAccel(vessel);
  const frozen = b.hold !== null && g <= Math.max(1.0, 0.003 * b.dv);
  const along = vdot(vg, vesselForward(vessel));
  if (b.phase === 'burn' && !b.rcsOnly && g >= TRIM_AT && !(frozen && along < 0.15)) {
    if (!(vessel.fuel > 0) || !(aM > 0)) {
      failAutopilot(ap, vessel, `Propellant exhausted: ${fmtSpeed(g)} of the ${b.label.toLowerCase()} not delivered`);
      return 'failed';
    }
    if (t - b.started > 3 * b.duration + 120) {
      failAutopilot(ap, vessel, `The ${b.label.toLowerCase()} did not converge (${fmtSpeed(g)} left)`);
      return 'failed';
    }
    let dir: V3;
    if (frozen) dir = b.hold as V3;
    else {
      dir = vscale(vg, 1 / g);
      b.hold = dir;
    }
    aim(vessel, dir);
    const err = pointingError(vessel, dir);
    vessel.controls.throttle = clamp(along / (aM * Math.max(THROTTLE_TAU, 2.5 * dt)), 0, 1) * pointingGate(err);
    ap.phase = 'burn';
    ap.status = `${b.label}: ${fmtSpeed(g)} to go`;
    out.maxWarp = Math.min(PHYSICS_WARP_MAX, warpFor(g / aM - 3 - dt));
    return 'running';
  }
  // RCS trim.
  if (b.phase !== 'trim') {
    b.phase = 'trim';
    b.trimT = t;
  }
  const aR = rcsAccel(vessel);
  const budget = 10 + (b.rcsOnly ? 2.5 * b.duration : 0) + 2 * (aR > 0 ? TRIM_AT / aR : 0);
  if (g < TRIM_DONE || !(aR > 0) || t - b.trimT > budget) return 'done';
  aim(vessel, b.hold ?? b.dir);
  rcsToward(vessel, vg, dt);
  ap.phase = 'trim';
  ap.status = `${b.label}: trimming ${fmtSpeed(g)}`;
  out.maxWarp = g > 0.3 ? 2 : 1;
  return 'running';
}

function stepPlanFlight(ap: AutopilotState, vessel: Vessel, ctx: AutopilotCtx, dt: number, out: AutopilotOutput): void {
  const d = dataOf(ap);
  if (!d.burn) {
    const node = nextNode(ctx.nodes);
    if (!node) {
      finish(ap, vessel, out);
      return;
    }
    const b = setupBurn(vessel, ctx, node, null);
    if (typeof b === 'string') {
      failAutopilot(ap, vessel, b);
      return;
    }
    d.burn = b;
  }
  const r = runBurn(ap, vessel, ctx, dt, out, null);
  if (r === 'failed') {
    if (ap.mode !== 'idle') failAutopilot(ap, vessel, `${ap.status}: move clear before burning`);
    return;
  }
  if (r === 'done') {
    const id = (d.burn as Burn).nodeId;
    d.burn = null;
    if (removeNode(ctx.nodes, id)) out.nodesChanged = true;
    zeroControls(vessel);
    if (ap.mode === 'executeNode' || !nextNode(ctx.nodes)) finish(ap, vessel, out);
  }
}

// ===================================================================================== match velocity

function stepMatchVelocity(ap: AutopilotState, vessel: Vessel, ctx: AutopilotCtx, dt: number, out: AutopilotOutput): void {
  const st = stationOf(ctx.model, ap.stationId ?? '');
  if (!st) {
    failAutopilot(ap, vessel, 'Unknown station');
    return;
  }
  const rel = relativeToStation(ctx.model, vessel, st, ctx.t);
  if (rel.speed < 0.03) {
    finish(ap, vessel, out);
    return;
  }
  if (!(vessel.fuel > 0)) {
    failAutopilot(ap, vessel, `Propellant exhausted with ${fmtSpeed(rel.speed)} relative to ${st.name}`);
    return;
  }
  thrustToward(ap, vessel, dt, vscale(rel.u, -1), true, null, null);
  ap.phase = 'match';
  ap.status = `Matching velocity with ${st.name} · ${fmtSpeed(rel.speed)}`;
  out.maxWarp = rel.speed > 40 ? PHYSICS_WARP_MAX : rel.speed > 2 ? 4 : 2;
}

// ===================================================================================== docking

interface PortGeometry {
  port: DockingPortDef;
  /** Keep-out sphere around the station and the radius of the shell the ship cruises round it on, m. */
  keepOut: number;
  shell: number;
  /** Distance (m) of the ship's centre from the mating point when docked. */
  seat: number;
  gateDist: number;
}

function keepOutRadius(layout: StationLayout, vessel: Vessel): number {
  return layout.radius + vessel.stats.radius + 25;
}
const shellRadius = (keepOut: number): number => 1.12 * keepOut + 40;

/** Distance along a port's axis from the mating point to where the axis leaves the cruise shell (at least 120 m). */
function gateDistance(port: DockingPortDef, shell: number): number {
  const b = vdot(port.pos, port.dir);
  const c = vdot(port.pos, port.pos) - shell * shell;
  const disc = b * b - c;
  const s = disc > 0 ? -b + Math.sqrt(disc) : 0;
  return Math.max(120, s);
}

const _contact = newColliderContact();

/** True when the ship's collision sphere touches nothing all the way down the port's approach axis. */
function corridorClear(layout: StationLayout, port: DockingPortDef, radius: number, seat: number, gateDist: number): boolean {
  for (let s = seat; s <= gateDist + 1; s += 6) {
    if (stationContact(vaddScaled(port.pos, port.dir, s), radius + 1, layout.colliders, _contact)) return false;
  }
  return true;
}

/** Shortest distance from the origin to the segment a–b. */
function segmentDistance(a: V3, b: V3): number {
  const ab = vsub(b, a);
  const l2 = vdot(ab, ab);
  const u = l2 > 0 ? clamp(-vdot(a, ab) / l2, 0, 1) : 0;
  return vlen(vaddScaled(a, ab, u));
}

/**
 * Next waypoint on the way from P to G (station-local metres) that stays outside the keep-out sphere:
 * straight to G when the line is clear, straight out when inside the sphere, otherwise a point further
 * round the cruise shell. `path` is the distance still to fly to G along that route.
 */
function route(P: V3, G: V3, keepOut: number, shell: number): { W: V3; path: number; direct: boolean } {
  const rP = vlen(P);
  if (rP >= keepOut && segmentDistance(P, G) >= keepOut) return { W: G, path: vlen(vsub(G, P)), direct: true };
  const gHat = vnorm(G);
  const pHat = rP > 1 ? vscale(P, 1 / rP) : gHat;
  const theta = Math.acos(clamp(vdot(pHat, gHat), -1, 1));
  if (rP < keepOut) {
    const W = vscale(pHat, shell);
    return { W, path: shell - rP + shell * theta + Math.abs(vlen(G) - shell), direct: false };
  }
  const phi = Math.min(theta, 0.6);
  let wHat: V3;
  if (theta < 1e-3) wHat = gHat;
  else if (Math.PI - theta < 1e-3) {
    const perp = vnorm(vcross(pHat, Math.abs(pHat.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 }));
    wHat = vadd(vscale(pHat, Math.cos(phi)), vscale(perp, Math.sin(phi)));
  } else {
    const s = Math.sin(theta);
    wHat = vadd(vscale(pHat, Math.sin(theta - phi) / s), vscale(gHat, Math.sin(phi) / s));
  }
  const W = vscale(wHat, shell);
  return { W, path: vlen(vsub(W, P)) + shell * (theta - phi) + Math.abs(vlen(G) - shell), direct: false };
}

/** Speed limit (m/s) at distance `rP` from a station's centre. */
function zoneSpeed(rP: number, shell: number, zone: number): number {
  if (rP > zone) return SPEED_FAR;
  return clamp(SPEED_SHELL + (rP - shell) / 15, SPEED_SHELL, SPEED_ZONE);
}

function portGeometry(layout: StationLayout, vessel: Vessel, port: DockingPortDef): PortGeometry {
  const keepOut = keepOutRadius(layout, vessel);
  const shell = shellRadius(keepOut);
  return { port, keepOut, shell, seat: vessel.stats.radius + 2, gateDist: gateDistance(port, shell) };
}

/** Pick the docking port (nearest suitable by the route to its gate) and set the approach up. */
function setupDock(vessel: Vessel, ctx: AutopilotCtx, st: StationDef): DockData | string {
  const layout = ctx.stationLayout(st.id);
  if (!layout || layout.ports.length === 0) return `No docking data for ${st.name}`;
  const rel = relativeToStation(ctx.model, vessel, st, ctx.t);
  const P = toStationLocal(rel.p, stationAttitude(st.orbit));
  let best: { port: DockingPortDef; gateDist: number; cost: number } | null = null;
  for (const port of layout.ports) {
    if (vessel.stats.radius + 1 > PAD_CLEARANCE[port.size]) continue;
    const g = portGeometry(layout, vessel, port);
    if (!corridorClear(layout, port, vessel.stats.radius, g.seat, g.gateDist)) continue;
    const G = vaddScaled(port.pos, port.dir, g.gateDist);
    const cost = route(P, G, g.keepOut, g.shell).path + 0.5 * g.gateDist;
    if (!best || cost < best.cost) best = { port, gateDist: g.gateDist, cost };
  }
  if (!best) return `No docking port at ${st.name} takes this ship`;
  return { stationId: st.id, portId: best.port.id, gateDist: best.gateDist, phase: 'approach', t0: ctx.t };
}

/** One step of the approach-and-dock guidance in `d.dock`. 'done' = soft capture achieved. */
function runDock(ap: AutopilotState, vessel: Vessel, ctx: AutopilotCtx, dt: number, out: AutopilotOutput): StepResult {
  const d = dataOf(ap);
  const dk = d.dock as DockData;
  const st = stationOf(ctx.model, dk.stationId);
  const layout = st ? ctx.stationLayout(st.id) : null;
  const port = layout ? layout.ports.find((p) => p.id === dk.portId) : undefined;
  if (!st || !layout || !port) {
    failAutopilot(ap, vessel, 'The docking port is no longer available');
    return 'failed';
  }
  const rel = relativeToStation(ctx.model, vessel, st, ctx.t);
  if (!rel.sameSoi || rel.dist > 2 * DOCK_RANGE) {
    failAutopilot(ap, vessel, `Lost ${st.name}: too far away to dock`);
    return 'failed';
  }
  const aR = rcsAccel(vessel);
  if (!(aR > 0)) {
    failAutopilot(ap, vessel, `Propellant exhausted ${fmtDistance(rel.dist)} from ${st.name}`);
    return 'failed';
  }
  if (ctx.t - dk.t0 > 6 * 3600) {
    failAutopilot(ap, vessel, `The approach to ${st.name} timed out`);
    return 'failed';
  }
  const q = stationAttitude(st.orbit);
  const P = toStationLocal(rel.p, q);
  const U = toStationLocal(rel.u, q);
  const g = portGeometry(layout, vessel, port);
  const aM = currentAccel(vessel);
  const dP = vsub(P, port.pos);
  const s = vdot(dP, port.dir);
  const lateral = vaddScaled(dP, port.dir, -s);
  const lat = vlen(lateral);
  const rP = vlen(P);
  const speed = vlen(U);

  if (dk.phase === 'approach') {
    // Already inside the corridor (just undocked, or handed over on the axis): go straight in.
    if (lat < 6 && s > g.seat - 1 && s < dk.gateDist + 10 && speed < SPEED_AXIS + 1) dk.phase = 'final';
  }
  if (dk.phase === 'approach') {
    const G = vaddScaled(port.pos, port.dir, dk.gateDist);
    const toG = vlen(vsub(G, P));
    if (toG < 5 && speed < 0.25) {
      dk.phase = 'final';
    } else {
      const rt = route(P, G, g.keepOut, g.shell);
      const allowMain = rP > g.keepOut && toG > 60;
      const vCap = rP < g.keepOut ? SPEED_AXIS : zoneSpeed(rP, g.shell, layout.controlZone);
      const want = brakeSpeed(rt.path, vCap, aR, aM, allowMain);
      const leg = vsub(rt.W, P);
      const legLen = vlen(leg);
      const vDes = legLen > 0.05 ? vscale(leg, want / legLen) : { x: 0, y: 0, z: 0 };
      const eW = fromStationLocal(vsub(vDes, U), q);
      // With nothing to burn, keep the nose on the braking direction so the drive is ready.
      const retro = speed > 2.5 && allowMain ? vscale(rel.u, -1 / rel.speed) : null;
      thrustToward(ap, vessel, dt, eW, allowMain, retro, null);
      ap.phase = 'approach';
      ap.status = `${rt.direct ? 'Approaching' : 'Rounding'} ${st.name} · ${fmtDistance(rel.dist)} · ${fmtSpeed(speed)}`;
      out.maxWarp = rel.dist > 3000 ? PHYSICS_WARP_MAX : 4;
      return 'running';
    }
  }

  // Final: down the port axis to the seat.
  const dAx = s - g.seat;
  if (dAx < CAPTURE_AXIAL && lat < CAPTURE_LATERAL && speed < CAPTURE_SPEED) {
    out.captured = { stationId: st.id, portId: port.id };
    return 'done';
  }
  let vAx = brakeSpeed(dAx, SPEED_AXIS, aR, aM, false);
  if (lat > 4 && dAx < 100) vAx *= clamp(1 - (lat - 4) / 4, 0, 1);
  let vLat = vscale(lateral, -1 / 5);
  const vl = vlen(vLat);
  if (vl > 1.2) vLat = vscale(vLat, 1.2 / vl);
  const vDes = vaddScaled(vLat, port.dir, -vAx);
  const eL = vsub(vDes, U);
  const eW = fromStationLocal(eL, q);
  // The main drive may only give the kick inward at the top of a long corridor; braking is RCS work.
  const inward = -vdot(eL, port.dir);
  const allowMain = dAx > 150 && inward > 0.8 * vlen(eL);
  const face = fromStationLocal(port.up, q);
  const faceUp = fromStationLocal(vscale(port.dir, -1), q);
  thrustToward(ap, vessel, dt, eW, allowMain, face, faceUp);
  const aligned = pointingError(vessel, face) < 0.1;
  ap.phase = !aligned && !d.mainOn ? 'align' : 'final';
  ap.status = `Final approach to ${st.name} port ${port.id} · ${fmtDistance(Math.max(0, dAx))} · ${fmtSpeed(speed)}`;
  out.maxWarp = dAx > 60 ? 4 : 2;
  return 'running';
}

function stepDockCommand(ap: AutopilotState, vessel: Vessel, ctx: AutopilotCtx, dt: number, out: AutopilotOutput): void {
  const r = runDock(ap, vessel, ctx, dt, out);
  if (r === 'done') finish(ap, vessel, out);
}

// ===================================================================================== goToStation

/** Rough check that the tanks cover a plan; returns the refusal text, or null when they do. */
function budgetProblem(vessel: Vessel, st: StationDef, plan: PlanOk, extra: number): string | null {
  const need = 1.02 * plan.totalDv + 120 + extra;
  const have = deltaVRemaining(vessel);
  if (have >= need) return null;
  return `Not enough propellant for ${st.name}: the trip needs about ${fmtSpeed(need)} of Δv, the tanks hold ${fmtSpeed(have)}`;
}

/** Plan the next leg toward `st` from where the ship is, with enough lead time for the first burn to be centred. */
function planLeg(vessel: Vessel, ctx: AutopilotCtx, st: StationDef): { plan: PlanOk } | string {
  const ship = shipFromVessel(vessel, ctx.t);
  let lead = 60;
  let plan = planToStation(ctx.model, ship, st, { leadTime: lead });
  if (!plan.ok) return plan.reason;
  for (let i = 0; i < 2 && plan.ok && plan.nodes.length > 0; i++) {
    const first = plan.nodes[0];
    const dv = Math.sqrt(first.dv.prograde * first.dv.prograde + first.dv.normal * first.dv.normal + first.dv.radial * first.dv.radial);
    const need = burnTiming(vessel, dv).lead + 45;
    if (first.t - ctx.t >= need) break;
    lead = need + 15;
    plan = planToStation(ctx.model, ship, st, { leadTime: lead });
    if (!plan.ok) return plan.reason;
  }
  return { plan };
}

function stepTrip(ap: AutopilotState, vessel: Vessel, ctx: AutopilotCtx, dt: number, out: AutopilotOutput): void {
  const d = dataOf(ap);
  const trip = d.trip as Trip;
  const st = stationOf(ctx.model, ap.stationId ?? '');
  if (!st) {
    failAutopilot(ap, vessel, 'Unknown station');
    return;
  }
  switch (trip.stage) {
    case 'plan':
      tripPlan(ap, vessel, ctx, out, trip, st);
      return;
    case 'clear':
      tripClear(ap, vessel, ctx, dt, out, trip);
      return;
    case 'fly':
      tripFly(ap, vessel, ctx, dt, out, trip, st);
      return;
    case 'terminal': {
      if (!d.dock) {
        const dk = setupDock(vessel, ctx, st);
        if (typeof dk === 'string') {
          failAutopilot(ap, vessel, dk);
          return;
        }
        d.dock = dk;
        d.portId = dk.portId;
        d.mainOn = false;
      }
      const r = runDock(ap, vessel, ctx, dt, out);
      if (r === 'done') finish(ap, vessel, out);
      return;
    }
  }
}

function tripPlan(ap: AutopilotState, vessel: Vessel, ctx: AutopilotCtx, out: AutopilotOutput, trip: Trip, st: StationDef): void {
  const d = dataOf(ap);
  ap.phase = 'plan';
  ap.status = `Plotting a course to ${st.name}`;
  d.burn = null;
  d.mainOn = false;
  const rel = relativeToStation(ctx.model, vessel, st, ctx.t);
  if (rel.sameSoi && rel.dist < TERMINAL_RANGE && rel.speed < TERMINAL_SPEED) {
    trip.stage = 'terminal';
    trip.leg = null;
    d.dock = null;
    return;
  }
  if (trip.legs >= MAX_LEGS) {
    failAutopilot(ap, vessel, `The flight computer could not find a way to ${st.name}`);
    return;
  }
  const planned = planLeg(vessel, ctx, st);
  if (typeof planned === 'string') {
    failAutopilot(ap, vessel, planned);
    return;
  }
  const plan = planned.plan;
  const near = trip.cleared ? null : nearestStation(ctx.model, vessel, ctx.t, CLEAR_RANGE);
  const short = budgetProblem(vessel, st, plan, near ? 150 : 0);
  if (short) {
    failAutopilot(ap, vessel, short);
    return;
  }
  if (plan.nodes.length > 0) {
    // Which way does the first burn push? Park on that side of any station we are next to.
    const pred = predictWithNodes(ctx.model, shipFromVessel(vessel, ctx.t), [plan.nodes[0]], { maxPatches: 1, maxDuration: 1 });
    const a = pred.nodes[0];
    const side = a && a.reached && vdot(a.dvWorld, a.before.v) < 0 ? -1 : 1;
    if (near) {
      trip.stage = 'clear';
      trip.clearId = near.st.id;
      trip.clearSide = side;
      return;
    }
  }
  if (ctx.nodes.length > 0 || plan.nodes.length > 0) out.nodesChanged = true;
  ctx.nodes.length = 0;
  for (const n of plan.nodes) ctx.nodes.push(n);
  trip.legs++;
  trip.dvPlanned += plan.totalDv;
  const rendezvous = !plan.phases || plan.phases.length === 0;
  trip.leg = {
    kind: rendezvous ? 'rendezvous' : 'transfer',
    hop: rendezvous ? st.parentBodyId : plan.encounter ? plan.encounter.bodyId : st.parentBodyId,
    rp: plan.encounter ? plan.encounter.periapsisRadius : 0,
    normal: null,
    arrival: plan.arrivalTime,
    corrections: 0,
    nextCheck: -1,
    captureDone: false,
  };
  trip.stage = 'fly';
  if (plan.nodes.length === 0 && rendezvous) {
    // Already alongside but outside terminal range cannot happen; treat as arrived.
    trip.stage = 'terminal';
    d.dock = null;
  }
}

/** Move to a parking point ahead of (or behind) the station we are next to, on its own orbit, and stop there. */
function tripClear(ap: AutopilotState, vessel: Vessel, ctx: AutopilotCtx, dt: number, out: AutopilotOutput, trip: Trip): void {
  const d = dataOf(ap);
  const near = stationOf(ctx.model, trip.clearId ?? '');
  if (!near || near.parentBodyId !== vessel.soiBodyId) {
    trip.cleared = true;
    trip.stage = 'plan';
    return;
  }
  const layout = ctx.stationLayout(near.id);
  const radius = layout ? layout.radius : 400;
  const keepOut = radius + vessel.stats.radius + 25;
  const shell = shellRadius(keepOut);
  const model = ctx.model;
  const s0 = model.stationState(near.id, ctx.t);
  const vOrb = Math.max(1, vlen(s0.v));
  const D = radius + CLEAR_DISTANCE;
  const hold = model.stationState(near.id, ctx.t + (trip.clearSide * D) / vOrb);
  const q = stationAttitude(near.orbit);
  const P = toStationLocal(vsub(vessel.r, s0.r), q);
  const U = toStationLocal(vsub(vsub(vessel.v, s0.v), vsub(hold.v, s0.v)), q);
  const H = toStationLocal(vsub(hold.r, s0.r), q);
  const toH = vlen(vsub(H, P));
  const speed = vlen(U);
  if (toH < 25 && speed < 0.03) {
    trip.cleared = true;
    trip.stage = 'plan';
    d.mainOn = false;
    return;
  }
  const aR = rcsAccel(vessel);
  const aM = currentAccel(vessel);
  if (!(aR > 0)) {
    failAutopilot(ap, vessel, 'Propellant exhausted');
    return;
  }
  const rP = vlen(P);
  const rt = route(P, H, keepOut, shell);
  const allowMain = rP > keepOut && toH > 60;
  const vCap = rP < keepOut ? SPEED_AXIS : rP < shell + 150 ? SPEED_SHELL : 40;
  const want = brakeSpeed(rt.path, vCap, aR, aM, allowMain);
  const leg = vsub(rt.W, P);
  const legLen = vlen(leg);
  const vDes = legLen > 0.05 ? vscale(leg, want / legLen) : { x: 0, y: 0, z: 0 };
  const eW = fromStationLocal(vsub(vDes, U), q);
  const retro = speed > 2.5 && allowMain ? vnorm(fromStationLocal(vscale(U, -1), q)) : null;
  thrustToward(ap, vessel, dt, eW, allowMain, retro, null);
  ap.phase = 'clear';
  ap.status = `Clearing ${near.name} · ${fmtDistance(toH)} to the departure point`;
  out.maxWarp = 4;
}

function tripFly(ap: AutopilotState, vessel: Vessel, ctx: AutopilotCtx, dt: number, out: AutopilotOutput, trip: Trip, st: StationDef): void {
  const d = dataOf(ap);
  const leg = trip.leg as Leg;
  const model = ctx.model;

  // Arrived in the target's sphere of influence: the capture burn is re-planned from the real arrival.
  if (leg.kind === 'transfer' && !leg.captureDone && vessel.soiBodyId === leg.hop && (!d.burn || d.burn.phase === 'slew' || d.burn.phase === 'coast')) {
    leg.captureDone = true;
    leg.nextCheck = -1;
    const cap = planCapture(shipFromVessel(vessel, ctx.t), model.body(leg.hop).mu, { circular: true });
    if (!cap.ok) {
      failAutopilot(ap, vessel, cap.reason);
      return;
    }
    ctx.nodes.length = 0;
    for (const n of cap.nodes) ctx.nodes.push(n);
    out.nodesChanged = true;
    d.burn = null;
  }

  // Scheduled course check during a coast.
  if (leg.nextCheck >= 0 && ctx.t >= leg.nextCheck && (!d.burn || d.burn.phase === 'slew' || d.burn.phase === 'coast')) {
    leg.nextCheck = -1;
    if (courseCorrection(vessel, ctx, leg, st)) {
      out.nodesChanged = true;
      d.burn = null;
    }
  }

  if (!d.burn) {
    const node = nextNode(ctx.nodes);
    if (!node) {
      if (leg.kind === 'transfer' && vessel.soiBodyId !== leg.hop) {
        // Nothing left to burn but not there yet: coast on toward the encounter.
        const patches = predictTrajectory(model, shipFromVessel(vessel, ctx.t), { maxPatches: 6, searchPeriods: 2 });
        if (!patches.some((p) => p.bodyId === leg.hop)) {
          failAutopilot(ap, vessel, `The trajectory no longer reaches ${model.body(leg.hop).name}`);
          return;
        }
        ap.phase = 'coast';
        ap.status = `Coasting to ${model.body(leg.hop).name}`;
        out.maxWarp = leg.nextCheck >= 0 ? warpFor(leg.nextCheck - ctx.t - dt) : WARP_LEVELS[WARP_LEVELS.length - 1];
        return;
      }
      // Leg flown: plan what comes next (the terminal approach when we are there).
      trip.stage = 'plan';
      return;
    }
    const b = setupBurn(vessel, ctx, node, leg.kind === 'rendezvous' && node.id.startsWith('match-velocity') ? st.id : null);
    if (typeof b === 'string') {
      failAutopilot(ap, vessel, b);
      return;
    }
    d.burn = b;
  }
  const matchId = (d.burn as Burn).matchId;
  const r = runBurn(ap, vessel, ctx, dt, out, matchId);
  if (r === 'failed') {
    if (ap.mode === 'idle') return;
    // A station is in the burn path: clear it again and re-plan.
    if (trip.clearTries >= 2) {
      failAutopilot(ap, vessel, `${ap.status}: departure abandoned`);
      return;
    }
    const near = nearestStation(model, vessel, ctx.t, 12000);
    trip.clearTries++;
    trip.cleared = !near;
    trip.clearId = near ? near.st.id : null;
    trip.stage = near ? 'clear' : 'plan';
    return;
  }
  if (r === 'running' && leg.nextCheck >= 0 && (d.burn as Burn).phase === 'coast') {
    out.maxWarp = Math.min(out.maxWarp, warpFor(leg.nextCheck - ctx.t - dt));
  }
  if (r === 'done') {
    const id = (d.burn as Burn).nodeId;
    d.burn = null;
    if (removeNode(ctx.nodes, id)) out.nodesChanged = true;
    zeroControls(vessel);
    // After every burn but the last, look at where the ship is really going a little later.
    const next = nextNode(ctx.nodes);
    if (next && leg.corrections < 3) {
      const span = next.t - ctx.t;
      leg.nextCheck = span > 900 ? ctx.t + (leg.kind === 'rendezvous' ? 0.45 : 0.2) * span : -1;
    } else if (!next && leg.kind === 'transfer' && vessel.soiBodyId !== leg.hop && leg.corrections < 3) {
      leg.nextCheck = ctx.t + 600;
    }
  }
}

/**
 * Mid-course check. Rendezvous: if the ship would arrive far from the planned stand-off point, insert a
 * correction and a new velocity-match node. Transfer: if the pass at the target has drifted from the
 * requested periapsis, insert a correction. Returns true when ctx.nodes was changed.
 */
function courseCorrection(vessel: Vessel, ctx: AutopilotCtx, leg: Leg, st: StationDef): boolean {
  const model = ctx.model;
  const ship = shipFromVessel(vessel, ctx.t);
  if (leg.kind === 'rendezvous') {
    const match = ctx.nodes.find((n) => n.id.startsWith('match-velocity'));
    if (!match || vessel.soiBodyId !== st.parentBodyId || match.t - ctx.t < 300) return false;
    const mu = model.body(vessel.soiBodyId).mu;
    const at = propagateStateTo(newState(), ship.sv, mu, match.t - ctx.t);
    const tg = model.stationState(st.id, match.t);
    const miss = vlen(vsub(at.r, tg.r));
    if (Math.abs(miss - 1500) < MISS_TOLERANCE) return false;
    const plan = planRendezvousCorrection(model, ship, st.orbit, match.t, { leadTime: 45 });
    if (!plan.ok || plan.nodes.length === 0) return false;
    const corr = plan.nodes.find((n) => n.id.startsWith('correction'));
    const dv = corr ? Math.sqrt(corr.dv.prograde * corr.dv.prograde + corr.dv.normal * corr.dv.normal + corr.dv.radial * corr.dv.radial) : 0;
    // A sane correction is small; anything else means the geometry is ill-conditioned — leave it to the terminal phase.
    if (dv > 60) return false;
    ctx.nodes.length = 0;
    for (const n of plan.nodes) ctx.nodes.push(n);
    leg.corrections++;
    leg.arrival = plan.arrivalTime;
    return true;
  }
  if (!(leg.rp > 0) || vessel.soiBodyId === leg.hop) return false;
  const keep = ctx.nodes.filter((n) => n.bodyId !== leg.hop);
  const plan = planCorrection(model, ship, keep, leg.hop, leg.rp, { leadTime: 60, planeNormal: leg.normal ?? undefined });
  if (!plan.ok) return false;
  if (plan.nodes.length === 0) return false;
  const corr = plan.nodes[0];
  const dv = Math.sqrt(corr.dv.prograde * corr.dv.prograde + corr.dv.normal * corr.dv.normal + corr.dv.radial * corr.dv.radial);
  if (dv < 0.02 || dv > 0.25 * Math.max(200, deltaVRemaining(vessel))) return false;
  ctx.nodes.push(corr);
  leg.corrections++;
  return true;
}
