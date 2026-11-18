// TIDELOCK flight computer: manoeuvre nodes and the planners that produce them.
//
// Everything a phone player should not have to compute by hand — circularising, changing an apsis,
// matching a plane, Hohmann transfers, rendezvous, transfers to moons and planets, mid-course
// corrections, capture and aerocapture — is expressed here as ordinary manoeuvre nodes: impulsive
// burns at a time, given as prograde / normal / radial components. The player can inspect and tweak
// them, fly them by hand or hand them to the autopilot. Nothing here cheats: every plan is built on
// (and checked against) the same patched-conic model the game flies, `orbit.predictTrajectory`.
//
// Conventions (binding, see docs/ARCHITECTURE.md): SI units; states are relative to the centre of
// their SOI body in non-rotating system axes; reference plane XZ, +Y north. Node axes are those of
// `orbit.orbitalFrame`: prograde = v̂, normal = (r × v)^, radial = prograde × normal.
//
// Pure simulation code: no three.js, no DOM, no randomness. Public functions never throw: planners
// return `{ ok: false, reason }` instead. Plans and nodes are plain JSON-serialisable data.

import type { BodyDef, OrbitElements, StateVector, StationDef, V3 } from '../core/types';
import { DAY, fmtDistance, fmtDuration, fmtSpeed } from '../core/units';
import { lambert } from './lambert';
import type { LambertOptions } from './lambert';
import {
  SystemModel,
  closestApproach,
  copyState,
  elementsToStateTo,
  newOrbitalFrame,
  newState,
  orbitInfo,
  orbitNormalFromElements,
  orbitalFrameTo,
  orbitalPeriod,
  predictTrajectory,
  propagateStateTo,
  synodicPeriod,
  timeToNode,
  timeToRadius,
} from './orbit';
import type { OrbitInfo, PredictOptions, TrajectoryPatch, TrajectoryStart } from './orbit';
import { aeroHeatingPower, atmosphereDensity, totalMass } from './physics';
import type { Vessel } from './physics';

const PI = Math.PI;
const TAU = 2 * PI;

// ===================================================================================== types

/** Burn components of a manoeuvre node, m/s, along the orbital frame of the state just before the burn. */
export interface NodeDv {
  /** Along the velocity. */
  prograde: number;
  /** Along the orbit normal r × v. */
  normal: number;
  /** Along prograde × normal (in the orbit plane, away from the body on a circular orbit). */
  radial: number;
}

/** An impulsive burn planned at a sim time. Plain data. */
export interface ManeuverNode {
  id: string;
  /** Sim time of the burn, s. */
  t: number;
  /** Body whose sphere of influence the burn happens in; `dv` is expressed in the orbital frame relative to it. */
  bodyId: string;
  dv: NodeDv;
}

/** What still has to be planned and flown after the nodes of a plan (see {@link planToStation}). */
export type PlanPhase = 'transfer' | 'capture' | 'rendezvous';

/** A cheaper departure opportunity found by {@link planTransferToBody}. Times in sim seconds, Δv in m/s. */
export interface TransferWindow {
  departureTime: number;
  arrivalTime: number;
  /** Estimated total Δv (departure + capture) of a transfer flown at that window. */
  totalDv: number;
}

/** A successful plan. */
export interface PlanOk {
  ok: true;
  /** The burns, in time order. May be empty when nothing needs doing. */
  nodes: ManeuverNode[];
  /** Sum of the node Δv magnitudes, m/s. */
  totalDv: number;
  /** Sim time at which the plan's goal is reached (last burn / arrival), s. */
  arrivalTime: number;
  /** arrivalTime minus the time of the ship state the plan was made for, s. */
  duration: number;
  /** One short human-readable line. */
  summary: string;
  /** Things the player should know (thin margins, approximations…). */
  warnings: string[];
  /** planToStation: phases still to come after these nodes, in order. */
  phases?: PlanPhase[];
  /** planTransferToBody: a later window that is much cheaper than leaving now, if any. */
  nextWindow?: TransferWindow;
  /** planRendezvous: predicted situation right after the velocity-match burn. */
  rendezvous?: { departureTime: number; timeOfFlight: number; distance: number; relSpeed: number };
  /** planTransferToBody / planCorrection: predicted pass at the target body. */
  encounter?: { bodyId: string; periapsisRadius: number; periapsisTime: number; inclination: number };
  /** planAerocapture: the recommended pass. Radii / altitudes in m, heat as a fraction of capacity. */
  aerocapture?: {
    periapsisRadius: number;
    periapsisAltitude: number;
    /** Usable band of vacuum-periapsis altitudes: shallower than `shallow` does not capture, deeper than `deep` overheats or does not come out. */
    corridor: { shallow: number; deep: number };
    peakHeatFraction: number;
    /** Apoapsis radius of the orbit after the pass. */
    exitApoapsis: number;
    /** Speed lost in the pass, m/s. */
    dvShed: number;
    /** Peak deceleration, m/s². */
    peakDecel: number;
    /** Sim time of atmosphere entry, s. */
    entryTime: number;
    /** Estimated prograde Δv at the first apoapsis after the pass to lift the periapsis to {@link safeRadius}, m/s. */
    raiseDv: number;
  };
}

/** A plan that could not be made, and why (short, for the HUD). */
export interface PlanFail {
  ok: false;
  reason: string;
}

/** Result of every planner. */
export type PlanResult = PlanOk | PlanFail;

/** Options shared by the planners. */
export interface PlanOptions {
  /** Earliest time before the first burn, s after the ship state's time (to turn and settle). Default 30. */
  leadTime?: number;
}

/** Default lead time before a planned burn, s. */
export const DEFAULT_LEAD_TIME = 30;

// ===================================================================================== small helpers

const _frame = newOrbitalFrame();
const _s1 = newState();
const _s2 = newState();
const _s3 = newState();

const vlen = (a: V3): number => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
const vdot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const vcross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const vsub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const vadd = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const vscale = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const vaddScaled = (a: V3, b: V3, s: number): V3 => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s });
const vnorm = (a: V3): V3 => {
  const l = vlen(a);
  return l > 0 ? vscale(a, 1 / l) : { x: 0, y: 0, z: 0 };
};
const finiteV = (a: V3): boolean => Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);
const finiteState = (sv: StateVector): boolean => !!sv && !!sv.r && !!sv.v && finiteV(sv.r) && finiteV(sv.v);
const cloneState = (sv: StateVector): StateVector => ({ r: { x: sv.r.x, y: sv.r.y, z: sv.r.z }, v: { x: sv.v.x, y: sv.v.y, z: sv.v.z } });
const wrapTau = (a: number): number => ((a % TAU) + TAU) % TAU;
const wrapPi = (a: number): number => {
  const w = wrapTau(a);
  return w > PI ? w - TAU : w;
};
const clampN = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

const fail = (reason: string): PlanFail => ({ ok: false, reason });

/** A unit vector perpendicular to unit vector `s`, as close as possible to `n` (any perpendicular if they are parallel). */
function perpendicularToward(n: V3, s: V3): V3 {
  const k = vdot(n, s);
  let p = { x: n.x - k * s.x, y: n.y - k * s.y, z: n.z - k * s.z };
  if (!(vlen(p) > 1e-9)) p = vcross(s, Math.abs(s.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 });
  return vnorm(p);
}

/** Unit orbit normal of a state, +Y (or any perpendicular to r) for radial motion. */
function normalOf(sv: StateVector): V3 {
  const h = vcross(sv.r, sv.v);
  const hl = vlen(h);
  if (hl > 1e-12 * vlen(sv.r) * vlen(sv.v) && hl > 0) return vscale(h, 1 / hl);
  return perpendicularToward({ x: 0, y: 1, z: 0 }, vnorm(sv.r));
}

/** Unit horizontal direction of travel at a state: perpendicular to r, in the orbit plane, prograde. */
function horizontalOf(sv: StateVector): V3 {
  return vnorm(vcross(normalOf(sv), sv.r));
}

/**
 * Lowest radius (m from the centre) the flight computer will plan a coasting arc through around
 * `body`: the surface or the top of the atmosphere plus a margin of 2 % of the radius (at least
 * 10 km, at most 100 km). For stars: three radii.
 */
export function safeRadius(body: BodyDef): number {
  if (body.kind === 'star') return 3 * body.radius;
  const top = body.radius + (body.atmosphere ? body.atmosphere.height : 0);
  return top + clampN(0.02 * body.radius, 1e4, 1e5);
}

/** The planner's view of a vessel: its coasting state, SOI body and the sim time `t` (s) of that state. */
export function shipFromVessel(vessel: Vessel, t: number): TrajectoryStart {
  return { bodyId: vessel.soiBodyId, sv: { r: { x: vessel.r.x, y: vessel.r.y, z: vessel.r.z }, v: { x: vessel.v.x, y: vessel.v.y, z: vessel.v.z } }, t };
}

// ===================================================================================== nodes

/**
 * Burn vector of a node in system axes (m/s), given the state `svAtNode` (relative to `node.bodyId`)
 * just before the burn. Writes into `out` and returns it.
 */
export function nodeDvWorld(svAtNode: StateVector, node: ManeuverNode, out: V3 = { x: 0, y: 0, z: 0 }): V3 {
  const f = orbitalFrameTo(_frame, svAtNode);
  const d = node.dv;
  const p = Number.isFinite(d.prograde) ? d.prograde : 0;
  const n = Number.isFinite(d.normal) ? d.normal : 0;
  const r = Number.isFinite(d.radial) ? d.radial : 0;
  out.x = p * f.prograde.x + n * f.normal.x + r * f.radial.x;
  out.y = p * f.prograde.y + n * f.normal.y + r * f.radial.y;
  out.z = p * f.prograde.z + n * f.normal.z + r * f.radial.z;
  return out;
}

/** Magnitude of a node's burn, m/s. */
export function nodeDvMagnitude(node: ManeuverNode): number {
  const d = node.dv;
  const m = Math.sqrt(d.prograde * d.prograde + d.normal * d.normal + d.radial * d.radial);
  return Number.isFinite(m) ? m : 0;
}

/** State right after the impulsive burn of `node`, given the state `sv` (relative to `node.bodyId`) right before it. */
export function applyNode(sv: StateVector, node: ManeuverNode, out: StateVector = newState()): StateVector {
  const dv = nodeDvWorld(sv, node, _applyDv);
  out.r.x = sv.r.x;
  out.r.y = sv.r.y;
  out.r.z = sv.r.z;
  out.v.x = sv.v.x + dv.x;
  out.v.y = sv.v.y + dv.y;
  out.v.z = sv.v.z + dv.z;
  return out;
}
const _applyDv = { x: 0, y: 0, z: 0 };

/** Prograde / normal / radial components (m/s) of a burn vector `dvWorld` (system axes) at state `svAtNode`: the inverse of {@link nodeDvWorld}. */
export function dvToNodeComponents(svAtNode: StateVector, dvWorld: V3): NodeDv {
  const f = orbitalFrameTo(_frame, svAtNode);
  return { prograde: vdot(dvWorld, f.prograde), normal: vdot(dvWorld, f.normal), radial: vdot(dvWorld, f.radial) };
}

/** Build a node from a burn vector in system axes. `kind` only seeds the id. */
export function makeNode(kind: string, t: number, bodyId: string, svAtNode: StateVector, dvWorld: V3): ManeuverNode {
  return { id: `${kind}@${Math.round(t)}`, t, bodyId, dv: dvToNodeComponents(svAtNode, dvWorld) };
}

/** A node of {@link predictWithNodes} with the states around it. */
export interface AppliedNode {
  node: ManeuverNode;
  /** False when the trajectory ended (impact, atmosphere, patch limit) before the node's time; the fields below are then zero. */
  reached: boolean;
  /** Body whose SOI the ship is actually in at the node's time; `before` / `after` are relative to it. */
  bodyId: string;
  /** True when that is not `node.bodyId` (the burn is still applied, with its axes taken relative to `node.bodyId`). */
  soiMismatch: boolean;
  /** State just before / just after the burn. */
  before: StateVector;
  after: StateVector;
  /** The burn in system axes, m/s, and its magnitude. */
  dvWorld: V3;
  dv: number;
  /** Index in `patches` of the first arc after the burn (-1 if not reached). */
  patchIndex: number;
}

/** Result of {@link predictWithNodes}. */
export interface NodePrediction {
  /** The whole patched trajectory: coast to each node (those arcs end as 'max-time' at the node), then the arcs after the last one. Derived data — do not save. */
  patches: TrajectoryPatch[];
  /** One entry per input node, in time order. */
  nodes: AppliedNode[];
  /** Sum of |Δv| over the nodes that were reached, m/s. */
  totalDv: number;
  /** True when every node was reached. */
  complete: boolean;
}

function unreached(node: ManeuverNode): AppliedNode {
  return { node, reached: false, bodyId: node.bodyId, soiMismatch: false, before: newState(), after: newState(), dvWorld: { x: 0, y: 0, z: 0 }, dv: 0, patchIndex: -1 };
}

/**
 * Patched-conic prediction of a flight plan: coast from `start`, apply each node as an impulse at
 * its time (nodes are sorted by time; a node whose time is already past is applied immediately),
 * and continue. `opts` (see `orbit.PredictOptions`) governs the coast after the last node:
 * `maxPatches` (default 4), `maxDuration` (from the last node, default 100 days), `searchPeriods`,
 * `stopAtAtmosphere` (also applied before the nodes).
 *
 * Never throws; an invalid start or unknown body gives an empty prediction with every node unreached.
 */
export function predictWithNodes(model: SystemModel, start: TrajectoryStart, nodes: readonly ManeuverNode[], opts: PredictOptions = {}): NodePrediction {
  const sorted = nodes.slice().sort((a, b) => a.t - b.t);
  const patches: TrajectoryPatch[] = [];
  const applied: AppliedNode[] = [];
  let totalDv = 0;
  let alive = !!start && finiteState(start.sv) && Number.isFinite(start.t) && model.hasBody(start.bodyId);
  let cur: TrajectoryStart = alive ? { bodyId: start.bodyId, sv: start.sv, t: start.t } : { bodyId: '', sv: newState(), t: 0 };
  const stopAtAtmosphere = opts.stopAtAtmosphere ?? true;
  try {
    for (const node of sorted) {
      if (!alive || !Number.isFinite(node.t)) {
        applied.push(unreached(node));
        continue;
      }
      const dt = node.t - cur.t;
      let sv = cur.sv;
      let bodyId = cur.bodyId;
      let tNode = cur.t;
      if (dt > 0) {
        const seg = predictTrajectory(model, cur, { maxPatches: 24, maxDuration: dt, searchPeriods: 1e9, stopAtAtmosphere });
        for (const p of seg) patches.push(p);
        const last = seg.length > 0 ? seg[seg.length - 1] : null;
        const onTime = !!last && Math.abs(last.tEnd - node.t) <= 1e-9 * Math.max(1, Math.abs(node.t)) + 1e-9 * dt;
        if (!last || !onTime || last.endReason === 'impact' || last.endReason === 'atmosphere') {
          alive = false;
          applied.push(unreached(node));
          continue;
        }
        sv = last.svEnd;
        bodyId = last.bodyId;
        tNode = node.t;
        if ((last.endReason === 'soi-exit' || last.endReason === 'soi-enter') && last.nextBodyId) {
          sv = model.changeFrame(last.svEnd, last.bodyId, last.nextBodyId, node.t);
          bodyId = last.nextBodyId;
        }
      }
      const inNodeFrame = bodyId === node.bodyId || !model.hasBody(node.bodyId) ? sv : model.changeFrame(sv, bodyId, node.bodyId, tNode);
      const dvWorld = nodeDvWorld(inNodeFrame, node);
      const before = cloneState(sv);
      const after = cloneState(sv);
      after.v.x += dvWorld.x;
      after.v.y += dvWorld.y;
      after.v.z += dvWorld.z;
      const dv = vlen(dvWorld);
      totalDv += dv;
      applied.push({ node, reached: true, bodyId, soiMismatch: bodyId !== node.bodyId, before, after, dvWorld, dv, patchIndex: patches.length });
      cur = { bodyId, sv: after, t: tNode };
    }
    if (alive) {
      const tail = predictTrajectory(model, cur, opts);
      for (const p of tail) patches.push(p);
    }
  } catch {
    // An unknown body id inside the model: report what was computed so far.
    for (let i = applied.length; i < sorted.length; i++) applied.push(unreached(sorted[i]));
  }
  let complete = true;
  for (const a of applied) if (!a.reached) complete = false;
  return { patches, nodes: applied, totalDv, complete };
}

// ===================================================================================== ship bookkeeping

interface Settled {
  ship: TrajectoryStart;
  body: BodyDef;
  mu: number;
  info: OrbitInfo;
  /** Seconds (from ship.t) the ship stays on its current conic inside this SOI: Infinity for a stable closed orbit. */
  stay: number;
  /** Why the current conic ends, if it does. */
  stayReason: string;
}

/** Put the ship in the frame it belongs to and summarise its orbit. Returns a failure reason on bad input. */
function settle(model: SystemModel, ship: TrajectoryStart): Settled | string {
  if (!ship || typeof ship.bodyId !== 'string' || !model.hasBody(ship.bodyId)) return 'Unknown reference body';
  if (!finiteState(ship.sv) || !Number.isFinite(ship.t)) return 'Invalid ship state';
  const p = predictTrajectory(model, ship, { maxPatches: 1, searchPeriods: 1 });
  if (p.length === 0) return 'Invalid ship state';
  const first = p[0];
  const body = model.body(first.bodyId);
  const settled: TrajectoryStart = { bodyId: first.bodyId, sv: cloneState(first.svStart), t: ship.t };
  const info = orbitInfo(settled.sv, body.mu, ship.t);
  const ends = first.endReason !== 'closed' && first.endReason !== 'max-time';
  return { ship: settled, body, mu: body.mu, info, stay: ends ? first.tEnd - ship.t : Infinity, stayReason: ends ? first.endReason : '' };
}

function stayText(s: Settled): string {
  switch (s.stayReason) {
    case 'impact':
      return `the trajectory hits ${s.body.name} first`;
    case 'atmosphere':
      return `the trajectory enters the atmosphere of ${s.body.name} first`;
    case 'soi-exit':
      return `the ship leaves the sphere of influence of ${s.body.name} first`;
    case 'soi-enter':
      return 'the ship enters another sphere of influence first';
    default:
      return 'the trajectory changes first';
  }
}

function leadOf(opts: PlanOptions | undefined): number {
  const l = opts && Number.isFinite(opts.leadTime) ? (opts.leadTime as number) : DEFAULT_LEAD_TIME;
  return l > 0 ? l : 0;
}

function okPlan(shipT: number, nodes: ManeuverNode[], arrivalTime: number, summary: string, warnings: string[]): PlanOk {
  let totalDv = 0;
  for (const n of nodes) totalDv += nodeDvMagnitude(n);
  return { ok: true, nodes, totalDv, arrivalTime, duration: arrivalTime - shipT, summary, warnings };
}

/** Run a planner body, turning any exception into a failed plan (public functions never throw). */
function guarded(fn: () => PlanResult): PlanResult {
  try {
    const r = fn();
    if (r.ok) {
      for (const n of r.nodes) {
        if (!Number.isFinite(n.t) || !Number.isFinite(n.dv.prograde + n.dv.normal + n.dv.radial)) return fail('Planner produced an invalid burn');
      }
      if (!Number.isFinite(r.totalDv) || !Number.isFinite(r.arrivalTime)) return fail('Planner produced an invalid plan');
    }
    return r;
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Planner error');
  }
}

/** Time (s from now) of the next periapsis / apoapsis pass at least `lead` seconds away; NaN if there is none. */
function timeToApsis(info: OrbitInfo, which: 'periapsis' | 'apoapsis', lead: number): number {
  if (which === 'periapsis') {
    let dt = info.timeToPeriapsis;
    if (info.closed) {
      if (dt < lead) dt += info.period;
      return dt;
    }
    return dt >= 0 ? dt : NaN;
  }
  if (!info.closed) return NaN;
  let dt = info.timeToApoapsis;
  if (dt < lead) dt += info.period;
  return dt;
}

const altText = (body: BodyDef, r: number): string => fmtDistance(r - body.radius);

// ===================================================================================== single-burn planners

/**
 * Circularise: one burn that leaves the ship on a circular orbit at the radius of the burn point.
 * `at` = 'periapsis' or 'apoapsis' of the current orbit, or a sim time (s; clamped to now).
 * Fails when the burn point does not exist (apoapsis of an open orbit, periapsis already passed on an
 * escape trajectory), is below the surface, or is not reached on the current conic.
 */
export function planCircularize(model: SystemModel, ship: TrajectoryStart, at: 'periapsis' | 'apoapsis' | number, opts?: PlanOptions): PlanResult {
  return guarded(() => {
    const s = settle(model, ship);
    if (typeof s === 'string') return fail(s);
    const lead = leadOf(opts);
    let dt: number;
    let where: string;
    if (typeof at === 'number') {
      if (!Number.isFinite(at)) return fail('Invalid burn time');
      dt = Math.max(0, at - s.ship.t);
      where = 'at the chosen time';
    } else {
      dt = timeToApsis(s.info, at, lead);
      where = `at ${at}`;
      if (!Number.isFinite(dt)) return fail(at === 'apoapsis' ? 'The orbit is open: it has no apoapsis' : 'Periapsis is already behind on this escape trajectory');
    }
    if (dt >= s.stay) return fail(`Cannot circularise ${where}: ${stayText(s)}`);
    const sv = propagateStateTo(newState(), s.ship.sv, s.mu, dt);
    const r = vlen(sv.r);
    if (!(r > s.body.radius)) return fail('The burn point is below the surface');
    if (s.body.soi < Infinity && r >= s.body.soi) return fail('The burn point is outside the sphere of influence');
    const warnings: string[] = [];
    if (r < safeRadius(s.body)) warnings.push(s.body.atmosphere && r < s.body.radius + s.body.atmosphere.height ? 'The orbit would lie inside the atmosphere' : 'The orbit would skim the surface');
    const vc = Math.sqrt(s.mu / r);
    const dvWorld = vsub(vscale(horizontalOf(sv), vc), sv.v);
    const tNode = s.ship.t + dt;
    const node = makeNode('circularize', tNode, s.body.id, sv, dvWorld);
    return okPlan(ship.t, [node], tNode, `Circularise ${where} (${altText(s.body, r)}) in ${fmtDuration(dt)}: Δv ${fmtSpeed(vlen(dvWorld))}`, warnings);
  });
}

/**
 * Change one apsis with a single prograde / retrograde burn at the opposite one: `which` = the apsis
 * to move, `newRadius` = its new distance from the body centre, m. (If `newRadius` crosses the burn
 * point's radius the two apsides swap roles — the orbit still passes through `newRadius` opposite
 * the burn.) Moving the periapsis needs a closed orbit; moving the apoapsis of an inbound open orbit
 * is a capture burn at periapsis.
 */
export function planSetApsis(model: SystemModel, ship: TrajectoryStart, which: 'periapsis' | 'apoapsis', newRadius: number, opts?: PlanOptions): PlanResult {
  return guarded(() => {
    const s = settle(model, ship);
    if (typeof s === 'string') return fail(s);
    if (!(newRadius > 0 && newRadius < Infinity)) return fail('Invalid target radius');
    const burnAt = which === 'apoapsis' ? 'periapsis' : 'apoapsis';
    const dt = timeToApsis(s.info, burnAt, leadOf(opts));
    if (!Number.isFinite(dt)) return fail(burnAt === 'apoapsis' ? 'The orbit is open: capture first' : 'Periapsis is already behind on this escape trajectory');
    if (dt >= s.stay) return fail(`Cannot burn at ${burnAt}: ${stayText(s)}`);
    const sv = propagateStateTo(newState(), s.ship.sv, s.mu, dt);
    const r = vlen(sv.r);
    const warnings: string[] = [];
    if (newRadius < s.body.radius) warnings.push(`The new orbit intersects ${s.body.name}`);
    else if (newRadius < safeRadius(s.body)) warnings.push(s.body.atmosphere ? 'The new orbit dips into the atmosphere' : 'The new orbit skims the surface');
    if (s.body.soi < Infinity && newRadius >= s.body.soi) warnings.push(`The new orbit leaves the sphere of influence of ${s.body.name}`);
    const vNew = Math.sqrt(s.mu * (2 / r - 2 / (r + newRadius)));
    const speed = vlen(sv.v);
    const dvWorld = vscale(vnorm(sv.v), vNew - speed);
    const tNode = s.ship.t + dt;
    const node = makeNode(`set-${which}`, tNode, s.body.id, sv, dvWorld);
    return okPlan(ship.t, [node], tNode, `Set ${which} to ${altText(s.body, newRadius)} altitude: burn at ${burnAt} in ${fmtDuration(dt)}, Δv ${fmtSpeed(Math.abs(vNew - speed))}`, warnings);
  });
}

/**
 * Match the plane of another orbit around the same body with one normal burn at the ascending or
 * descending node, whichever is cheaper. `target` is that orbit's elements, or `{ normal }` for a
 * plane given by its normal (system axes). The burn turns the velocity without changing speed or
 * flight-path angle, so the shape of the orbit is kept. Returns no nodes when already in plane.
 */
export function planMatchPlane(model: SystemModel, ship: TrajectoryStart, target: OrbitElements | { normal: V3 }, opts?: PlanOptions): PlanResult {
  return guarded(() => {
    const s = settle(model, ship);
    if (typeof s === 'string') return fail(s);
    const nT = vnorm('normal' in target ? target.normal : orbitNormalFromElements(target));
    if (!(vlen(nT) > 0.5) || !finiteV(nT)) return fail('Invalid target plane');
    const nS = normalOf(s.ship.sv);
    const rel = Math.atan2(vlen(vcross(nS, nT)), vdot(nS, nT));
    if (rel < 1e-7) return okPlan(ship.t, [], ship.t, 'Already in the target plane', []);
    const lead = leadOf(opts);
    let best: { dt: number; sv: StateVector; dvWorld: V3; dv: number; which: string } | null = null;
    for (const which of ['ascending', 'descending'] as const) {
      let dt = timeToNode(s.ship.sv, s.mu, nT, which);
      if (!Number.isFinite(dt)) continue;
      if (dt < lead && s.info.closed) dt += s.info.period;
      if (dt >= s.stay) continue;
      const sv = propagateStateTo(newState(), s.ship.sv, s.mu, dt);
      const rHat = vnorm(sv.r);
      const vr = vdot(sv.v, rHat);
      const vh = vaddScaled(sv.v, rHat, -vr);
      const vt = vlen(vh);
      const tNew = vnorm(vcross(nT, rHat));
      const dvWorld = vsub(vscale(tNew, vt), vh);
      const dv = vlen(dvWorld);
      if (!best || dv < best.dv) best = { dt, sv, dvWorld, dv, which };
    }
    if (!best) return fail('No node with the target plane lies ahead on this trajectory');
    const tNode = s.ship.t + best.dt;
    const node = makeNode('match-plane', tNode, s.body.id, best.sv, best.dvWorld);
    return okPlan(
      ship.t,
      [node],
      tNode,
      `Match plane (${((rel * 180) / PI).toFixed(rel < 0.02 ? 2 : 1)}°) at the ${best.which} node in ${fmtDuration(best.dt)}: Δv ${fmtSpeed(best.dv)}`,
      [],
    );
  });
}

/**
 * Two-burn Hohmann transfer to a circular orbit of radius `radius` (m from the body centre) in the
 * ship's current plane. From a near-circular orbit the first burn is made right away; from an
 * eccentric one it is made at the apsis that makes the transfer cheapest (periapsis when raising,
 * apoapsis when lowering). The second burn circularises half a transfer orbit later.
 */
export function planHohmannToRadius(model: SystemModel, ship: TrajectoryStart, radius: number, opts?: PlanOptions): PlanResult {
  return guarded(() => {
    const s = settle(model, ship);
    if (typeof s === 'string') return fail(s);
    if (!(radius > 0 && radius < Infinity)) return fail('Invalid target radius');
    if (!s.info.closed) return fail('Not in a closed orbit: capture first');
    if (radius <= s.body.radius) return fail('The target orbit is below the surface');
    if (s.body.soi < Infinity && radius >= s.body.soi) return fail(`The target orbit is outside the sphere of influence of ${s.body.name}`);
    const lead = leadOf(opts);
    let dt: number;
    if (s.info.e < 0.005) dt = lead;
    else dt = timeToApsis(s.info, radius >= s.info.periapsis && radius > 0.5 * (s.info.periapsis + s.info.apoapsis) ? 'periapsis' : 'apoapsis', lead);
    if (!Number.isFinite(dt) || dt >= s.stay) return fail(`Cannot start the transfer: ${stayText(s)}`);
    const sv1 = propagateStateTo(newState(), s.ship.sv, s.mu, dt);
    const r1 = vlen(sv1.r);
    const aT = 0.5 * (r1 + radius);
    const v1 = Math.sqrt(s.mu * (2 / r1 - 1 / aT));
    const hor = horizontalOf(sv1);
    const dv1 = vsub(vscale(hor, v1), sv1.v);
    const t1 = s.ship.t + dt;
    const tof = PI * Math.sqrt((aT * aT * aT) / s.mu);
    const after1: StateVector = { r: sv1.r, v: vadd(sv1.v, dv1) };
    const sv2 = propagateStateTo(newState(), after1, s.mu, tof);
    const dv2 = vsub(vscale(horizontalOf(sv2), Math.sqrt(s.mu / radius)), sv2.v);
    const t2 = t1 + tof;
    const warnings: string[] = [];
    if (radius < safeRadius(s.body)) warnings.push(s.body.atmosphere ? 'The target orbit dips into the atmosphere' : 'The target orbit skims the surface');
    if (s.body.soi < Infinity && radius > 0.5 * s.body.soi) warnings.push('The target orbit is high enough to be perturbed out of the sphere of influence');
    const nodes = [makeNode('transfer', t1, s.body.id, sv1, dv1), makeNode('circularize', t2, s.body.id, sv2, dv2)];
    const total = vlen(dv1) + vlen(dv2);
    return okPlan(ship.t, nodes, t2, `Hohmann transfer to ${altText(s.body, radius)} altitude: 2 burns, Δv ${fmtSpeed(total)}, ${fmtDuration(t2 - ship.t)}`, warnings);
  });
}

/** Options of {@link planCapture}. */
export interface CaptureOptions {
  /** Apoapsis radius (m from the centre) of the orbit to capture into. Omit (or set `circular`) for a circular orbit at periapsis. */
  apoapsis?: number;
  /** Capture into a circular orbit at the periapsis radius (the default). */
  circular?: boolean;
}

/**
 * Capture burn: given the ship's state on arrival inside a body's SOI (`arrival.sv` relative to
 * `arrival.bodyId` at time `arrival.t`) and that body's `mu` (m³/s²), one retrograde burn at
 * periapsis that leaves a circular orbit there, or an ellipse with the given apoapsis radius. If
 * periapsis is already behind on an open orbit the burn is made immediately. Pure two-body maths:
 * it does not know the body's size, so check the periapsis altitude yourself.
 */
export function planCapture(arrival: TrajectoryStart, mu: number, opts: CaptureOptions = {}): PlanResult {
  return guarded(() => {
    if (!arrival || !finiteState(arrival.sv) || !Number.isFinite(arrival.t) || !(mu > 0 && mu < Infinity)) return fail('Invalid arrival state');
    if (!(vlen(arrival.sv.r) > 0)) return fail('Invalid arrival state');
    const info = orbitInfo(arrival.sv, mu, arrival.t);
    const dt = info.closed || info.timeToPeriapsis >= 0 ? Math.max(0, info.timeToPeriapsis) : 0;
    const sv = propagateStateTo(newState(), arrival.sv, mu, dt);
    const rp = vlen(sv.r);
    const ap = opts.circular || opts.apoapsis === undefined ? rp : opts.apoapsis;
    if (!(ap > 0 && ap < Infinity)) return fail('Invalid capture apoapsis');
    const vNew = Math.sqrt(mu * (2 / rp - 2 / (rp + ap)));
    const dvWorld = vsub(vscale(horizontalOf(sv), vNew), sv.v);
    const tNode = arrival.t + dt;
    const node = makeNode('capture', tNode, arrival.bodyId, sv, dvWorld);
    const shape = ap === rp ? 'a circular orbit' : `an orbit with apoapsis ${fmtDistance(ap)}`;
    return okPlan(arrival.t, [node], tNode, `Capture into ${shape} at periapsis in ${fmtDuration(dt)}: Δv ${fmtSpeed(vlen(dvWorld))}`, []);
  });
}

/** Apsides of the conic with speed `v` along a fixed direction at radius `r` (flight-path cosine `cg`): [rp, ra] (ra = Infinity when open). */
function apsidesAtSpeed(mu: number, r: number, v: number, cg: number): [number, number] {
  const h = r * v * cg;
  const eps = 0.5 * v * v - mu / r;
  const p = (h * h) / mu;
  const e = Math.sqrt(Math.max(0, 1 + (2 * eps * h * h) / (mu * mu)));
  return [p / (1 + e), e < 1 ? p / (1 - e) : Infinity];
}

/**
 * Panic button: the cheapest simple way back to a stable orbit around the current body — closed,
 * periapsis above {@link safeRadius}, apoapsis well inside the sphere of influence. Handles orbits
 * that dip into the atmosphere or the ground (raise periapsis at apoapsis, or at once if the ground
 * comes first), escape trajectories (capture at periapsis, or brake at once when already outbound)
 * and combinations. Returns no nodes when the orbit is already safe.
 */
export function planReturnToSafeOrbit(model: SystemModel, ship: TrajectoryStart, opts?: PlanOptions): PlanResult {
  return guarded(() => {
    const s = settle(model, ship);
    if (typeof s === 'string') return fail(s);
    const { body, mu, info } = s;
    const lead = leadOf(opts);
    const rSafe = safeRadius(body);
    const rPark = rSafe + 0.01 * body.radius;
    const hasSoi = body.soi < Infinity;
    const rLimit = hasSoi ? 0.85 * body.soi : Infinity;
    const rApo = hasSoi ? Math.max(Math.min(0.5 * body.soi, 20 * rPark), 1.5 * rPark) : Infinity;
    const lowPe = info.periapsis < rSafe;
    const escaping = !info.closed || info.apoapsis > rLimit;
    if (!lowPe && !escaping) return okPlan(ship.t, [], ship.t, 'The orbit is already safe', s.stay < Infinity ? [`Note: ${stayText(s).replace(' first', '')}`] : []);

    const nodes: ManeuverNode[] = [];
    const warnings: string[] = [];
    const t0 = s.ship.t;
    // State to work from: "now" is one lead time ahead (less if the ground is closer than that).
    const tGround = lowPe ? timeToRadius(s.ship.sv, mu, rSafe, 'inward') : Infinity;
    const r0 = vlen(s.ship.sv.r);
    const burnNowDt = Math.min(lead, r0 > rSafe && tGround < Infinity ? 0.5 * tGround : lead, s.stay < Infinity ? 0.5 * s.stay : lead);

    if (!escaping && lowPe && info.apoapsis > rPark && info.timeToApoapsis >= lead && info.timeToApoapsis < tGround && info.timeToApoapsis < s.stay) {
      // Bound, and apoapsis comes before the ground: the classic periapsis raise.
      const sv = propagateStateTo(newState(), s.ship.sv, mu, info.timeToApoapsis);
      const r = vlen(sv.r);
      const vNew = Math.sqrt(mu * (2 / r - 2 / (r + rPark)));
      nodes.push(makeNode('raise-periapsis', t0 + info.timeToApoapsis, body.id, sv, vsub(vscale(horizontalOf(sv), vNew), sv.v)));
    } else if (escaping && !lowPe && info.radialSpeed < 0 && info.timeToPeriapsis > 0 && info.timeToPeriapsis < s.stay) {
      // Inbound on an escape trajectory with a safe periapsis: capture there.
      const sv = propagateStateTo(newState(), s.ship.sv, mu, info.timeToPeriapsis);
      const r = vlen(sv.r);
      const ap = Math.max(rApo < Infinity ? rApo : 4 * r, r);
      const vNew = Math.sqrt(mu * (2 / r - 2 / (r + ap)));
      nodes.push(makeNode('capture', t0 + info.timeToPeriapsis, body.id, sv, vsub(vscale(horizontalOf(sv), vNew), sv.v)));
    } else {
      // Burn (almost) now.
      const sv = propagateStateTo(newState(), s.ship.sv, mu, burnNowDt);
      const tNow = t0 + burnNowDt;
      const r = vlen(sv.r);
      const rHat = vnorm(sv.r);
      const hor = horizontalOf(sv);
      const vr = vdot(sv.v, rHat);
      const vt = vdot(sv.v, hor);
      const candidates: { dvWorld: V3; dv: number }[] = [];
      const consider = (vNew: V3): void => {
        const dvWorld = vsub(vNew, sv.v);
        const speed = vlen(vNew);
        const [rp, ra] = apsidesAtSpeed(mu, r, speed, speed > 0 ? vdot(vNew, hor) / speed : 1);
        if (rp >= rSafe * (1 - 1e-9) && ra <= Math.max(rLimit, r * (1 + 1e-9))) candidates.push({ dvWorld, dv: vlen(dvWorld) });
      };
      if (r > rPark) {
        // (a) keep the radial speed, add horizontal speed until periapsis is at the parking radius.
        const vt2 = Math.sqrt(Math.max(0, (vr * vr + 2 * mu * (1 / rPark - 1 / r)) / ((r * r) / (rPark * rPark) - 1)));
        if (vt2 > vt) consider(vadd(vscale(rHat, vr), vscale(hor, vt2)));
        // (b) make this point the apoapsis of an orbit with periapsis at the parking radius.
        consider(vscale(hor, Math.sqrt(mu * (2 / r - 2 / (r + rPark)))));
        // (c) circularise here.
        consider(vscale(hor, Math.sqrt(mu / r)));
        if (escaping && vr >= 0) {
          // (d) outbound: brake along the velocity until the apoapsis comes down to the parking apoapsis.
          const speed = vlen(sv.v);
          const cg = speed > 0 ? vt / speed : 1;
          const target = Math.max(rApo < Infinity ? rApo : 2 * r, r * 1.0001);
          let lo = 0;
          let hi = speed;
          for (let i = 0; i < 60; i++) {
            const mid = 0.5 * (lo + hi);
            if (apsidesAtSpeed(mu, r, mid, cg)[1] > target) hi = mid;
            else lo = mid;
          }
          consider(vscale(vnorm(sv.v), lo));
        }
      }
      if (candidates.length > 0) {
        let best = candidates[0];
        for (const c of candidates) if (c.dv < best.dv) best = c;
        nodes.push(makeNode('stabilize', tNow, body.id, sv, best.dvWorld));
      } else {
        // Below the parking radius (or nothing above worked): climb out on an ellipse with its
        // periapsis here, then raise the periapsis at the top.
        const ap = Math.max(1.1 * rPark, 1.1 * r);
        const vNew = vscale(hor, Math.sqrt(mu * (2 / r - 2 / (r + ap))));
        nodes.push(makeNode('climb', tNow, body.id, sv, vsub(vNew, sv.v)));
        const half = PI * Math.sqrt(Math.pow(0.5 * (r + ap), 3) / mu);
        const top = propagateStateTo(newState(), { r: sv.r, v: vNew }, mu, half);
        const rt = vlen(top.r);
        nodes.push(makeNode('raise-periapsis', tNow + half, body.id, top, vsub(vscale(horizontalOf(top), Math.sqrt(mu * (2 / rt - 2 / (rt + Math.min(rPark, rt))))), top.v)));
        if (r < rSafe) warnings.push('The ship is already below the safe altitude');
      }
    }

    // Check the result against the real prediction.
    const pred = predictWithNodes(model, s.ship, nodes, { maxPatches: 1, searchPeriods: 1 });
    const last = pred.patches.length > 0 ? pred.patches[pred.patches.length - 1] : null;
    if (!pred.complete || !last) return fail('No safe orbit can be reached from this trajectory');
    if (last.periapsisRadius < rSafe * (1 - 1e-6) || !(last.apoapsisRadius <= Math.max(rLimit, 1.001 * vlen(last.svStart.r)))) {
      warnings.push('The resulting orbit is only marginally stable');
    }
    const tEnd = nodes[nodes.length - 1].t;
    let total = 0;
    for (const n of nodes) total += nodeDvMagnitude(n);
    return okPlan(
      ship.t,
      nodes,
      tEnd,
      `Return to a safe orbit (${altText(body, last.periapsisRadius)} × ${last.apoapsisRadius < Infinity ? altText(body, last.apoapsisRadius) : '∞'}): ${nodes.length} burn${nodes.length > 1 ? 's' : ''}, Δv ${fmtSpeed(total)}`,
      warnings,
    );
  });
}

// ===================================================================================== Lambert transfer search

/** A two-impulse transfer problem for the grid search: who departs, who is the target, and what each end costs. */
interface TransferSpec {
  mu: number;
  /** Reference normal for the Lambert solver (transfers go prograde about it). */
  normal: V3;
  /** State of the departing object / of the target at sim time t (same frame), into `out`. */
  dep: (t: number, out: StateVector) => void;
  arr: (t: number, out: StateVector) => void;
  /** Cost (m/s) of the departure / arrival velocity change (transfer velocity minus object velocity, and the reverse). */
  depCost: (x: number, y: number, z: number) => number;
  arrCost: (x: number, y: number, z: number) => number;
  /** Coasting arcs may not dip below rMin or climb above rMax (m). */
  rMin: number;
  rMax: number;
  /** Departure window, sim seconds. */
  t0: number;
  t1: number;
  tofMin: number;
  tofMax: number;
  /** Orbital periods of the two objects, s (set the grid resolution; Infinity allowed). */
  depPeriod: number;
  arrPeriod: number;
  /** Relative cost added per full window of waiting (prefers earlier departures among near-equals). */
  waitBias: number;
}

interface TransferCand {
  td: number;
  tof: number;
  /** Biased cost used for ranking; dv1 + dv2 is the real Δv. */
  cost: number;
  dv1: number;
  dv2: number;
}

const _lamOpts: LambertOptions = { prograde: true, preferredNormal: { x: 0, y: 1, z: 0 } };
const _tA = newState();
const _tB = newState();
let _cDv1 = 0;
let _cDv2 = 0;

/** True if the conic arc from (r1, v1) to (r2, v2) stays between rMin and rMax. */
function arcSafe(r1: V3, v1: V3, r2: V3, v2: V3, mu: number, rMin: number, rMax: number): boolean {
  const r1n = vlen(r1);
  const r2n = vlen(r2);
  const hx = r1.y * v1.z - r1.z * v1.y;
  const hy = r1.z * v1.x - r1.x * v1.z;
  const hz = r1.x * v1.y - r1.y * v1.x;
  const h2 = hx * hx + hy * hy + hz * hz;
  const p = h2 / mu;
  const eps = 0.5 * (v1.x * v1.x + v1.y * v1.y + v1.z * v1.z) - mu / r1n;
  const e = Math.sqrt(Math.max(0, 1 + (2 * eps * h2) / (mu * mu)));
  const rp = p / (1 + e);
  const ra = e < 1 ? p / (1 - e) : Infinity;
  if (rp >= rMin && ra <= rMax) return true;
  const k = Math.sqrt(p / mu);
  const nu1 = Math.atan2((vdot(r1, v1) / r1n) * k, p / r1n - 1);
  const nu2 = Math.atan2((vdot(r2, v2) / r2n) * k, p / r2n - 1);
  const end = nu1 + wrapTau(nu2 - nu1);
  if (rp < rMin && (nu1 < 0 ? end > 0 : end > TAU)) return false;
  if (ra > rMax && e < 1 && nu1 < PI && end > PI) return false;
  return true;
}

/** Cost of the transfer leaving at `td` with flight time `tof`; Infinity if impossible or unsafe. Leaves the two Δv in _cDv1 / _cDv2. */
function transferCost(spec: TransferSpec, td: number, tof: number, depSv: StateVector | null): number {
  if (!(tof >= spec.tofMin && tof <= spec.tofMax && td >= spec.t0 && td <= spec.t1)) return Infinity;
  let a = depSv;
  if (!a) {
    spec.dep(td, _tA);
    a = _tA;
  }
  spec.arr(td + tof, _tB);
  const sol = lambert(a.r, _tB.r, tof, spec.mu, _lamOpts);
  if (!sol) return Infinity;
  if (!arcSafe(a.r, sol.v1, _tB.r, sol.v2, spec.mu, spec.rMin, spec.rMax)) return Infinity;
  _cDv1 = spec.depCost(sol.v1.x - a.v.x, sol.v1.y - a.v.y, sol.v1.z - a.v.z);
  _cDv2 = spec.arrCost(_tB.v.x - sol.v2.x, _tB.v.y - sol.v2.y, _tB.v.z - sol.v2.z);
  const c = (_cDv1 + _cDv2) * (1 + (spec.waitBias * (td - spec.t0)) / Math.max(spec.t1 - spec.t0, 1e-9));
  return c < Infinity ? c : Infinity;
}

/** Nelder–Mead minimisation of f(x, y) from (x0, y0) with initial steps (dx, dy). f may return Infinity. */
function nelderMead2(f: (x: number, y: number) => number, x0: number, y0: number, dx: number, dy: number, maxIter: number): { x: number; y: number; f: number } {
  const px = [x0, x0 + dx, x0];
  const py = [y0, y0, y0 + dy];
  const pf = [f(px[0], py[0]), f(px[1], py[1]), f(px[2], py[2])];
  if (!(pf[1] < Infinity)) {
    px[1] = x0 - dx;
    pf[1] = f(px[1], py[1]);
  }
  if (!(pf[2] < Infinity)) {
    py[2] = y0 - dy;
    pf[2] = f(px[2], py[2]);
  }
  for (let it = 0; it < maxIter; it++) {
    // Order: 0 best, 2 worst.
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2 - i; j++) {
        if (pf[j] > pf[j + 1] || (pf[j] !== pf[j] && pf[j + 1] === pf[j + 1])) {
          [px[j], px[j + 1]] = [px[j + 1], px[j]];
          [py[j], py[j + 1]] = [py[j + 1], py[j]];
          [pf[j], pf[j + 1]] = [pf[j + 1], pf[j]];
        }
      }
    }
    if (!(pf[0] < Infinity)) break;
    if (Math.abs(px[2] - px[0]) + Math.abs(px[1] - px[0]) < 1e-3 * Math.abs(dx) && Math.abs(py[2] - py[0]) + Math.abs(py[1] - py[0]) < 1e-3 * Math.abs(dy)) break;
    const cx = 0.5 * (px[0] + px[1]);
    const cy = 0.5 * (py[0] + py[1]);
    const rx = cx + (cx - px[2]);
    const ry = cy + (cy - py[2]);
    const fr = f(rx, ry);
    if (fr < pf[0]) {
      const ex = cx + 2 * (cx - px[2]);
      const ey = cy + 2 * (cy - py[2]);
      const fe = f(ex, ey);
      if (fe < fr) {
        px[2] = ex;
        py[2] = ey;
        pf[2] = fe;
      } else {
        px[2] = rx;
        py[2] = ry;
        pf[2] = fr;
      }
    } else if (fr < pf[1]) {
      px[2] = rx;
      py[2] = ry;
      pf[2] = fr;
    } else {
      const outside = fr < pf[2];
      const kx = outside ? cx + 0.5 * (cx - px[2]) : cx - 0.5 * (cx - px[2]);
      const ky = outside ? cy + 0.5 * (cy - py[2]) : cy - 0.5 * (cy - py[2]);
      const fk = f(kx, ky);
      if (fk < (outside ? fr : pf[2])) {
        px[2] = kx;
        py[2] = ky;
        pf[2] = fk;
      } else {
        for (let i = 1; i < 3; i++) {
          px[i] = px[0] + 0.5 * (px[i] - px[0]);
          py[i] = py[0] + 0.5 * (py[i] - py[0]);
          pf[i] = f(px[i], py[i]);
        }
      }
    }
  }
  let b = 0;
  for (let i = 1; i < 3; i++) if (pf[i] < pf[b]) b = i;
  return { x: px[b], y: py[b], f: pf[b] };
}

/** Flight-time samples: geometric from tofMin to tofMax; where neighbours are further apart than a fraction of the target's period, a scan over one target revolution replaces the single sample. */
function tofSamples(tofMin: number, tofMax: number, arrPeriod: number): { tof: number[]; step: number[] } {
  const n = 18;
  const ratio = Math.pow(tofMax / tofMin, 1 / (n - 1));
  const tof: number[] = [];
  const step: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = tofMin * Math.pow(ratio, i);
    const spacing = t * (ratio - 1);
    if (arrPeriod < Infinity && spacing > arrPeriod / 5) {
      const np = 6;
      for (let k = 0; k < np; k++) {
        const tk = t + (k / np - 0.5) * arrPeriod;
        if (tk >= tofMin && tk <= tofMax) {
          tof.push(tk);
          step.push(arrPeriod / (2 * np));
        }
      }
    } else {
      tof.push(t);
      step.push(0.5 * spacing);
    }
  }
  return { tof, step };
}

/**
 * Coarse-to-fine search of the departure-time × flight-time plane for the cheapest transfer.
 * Returns refined local optima, cheapest first: `all` over the whole window, `early` restricted to
 * departures no later than `earlyEnd`.
 */
function searchTransfer(spec: TransferSpec, earlyEnd: number): { all: TransferCand[]; early: TransferCand[] } {
  _lamOpts.preferredNormal = spec.normal;
  const W = spec.t1 - spec.t0;
  const { tof, step } = tofSamples(spec.tofMin, spec.tofMax, spec.arrPeriod);
  const nTof = tof.length;
  const perOrbit = 16;
  const want = spec.depPeriod < Infinity ? Math.round((W * perOrbit) / spec.depPeriod) : 12;
  const nTd = Math.max(1, Math.min(Math.max(6, want), Math.floor(4200 / Math.max(1, nTof)), W > 0 ? 512 : 1));
  const dTd = nTd > 1 ? W / (nTd - 1) : 0;
  const costs = new Float64Array(nTd * nTof);
  const dep = newState();
  for (let i = 0; i < nTd; i++) {
    const td = spec.t0 + i * dTd;
    spec.dep(td, dep);
    for (let j = 0; j < nTof; j++) costs[i * nTof + j] = transferCost(spec, td, tof[j], dep);
  }
  const pickTop = (limitTd: number, count: number): TransferCand[] => {
    const taken: number[] = [];
    const out: TransferCand[] = [];
    for (let c = 0; c < count; c++) {
      let bi = -1;
      let bc = Infinity;
      for (let i = 0; i < nTd; i++) {
        if (spec.t0 + i * dTd > limitTd) break;
        for (let j = 0; j < nTof; j++) {
          const v = costs[i * nTof + j];
          if (!(v < bc)) continue;
          let near = false;
          for (const tk of taken) {
            const ti = Math.floor(tk / nTof);
            const tj = tk % nTof;
            if (Math.abs(ti - i) <= 2 && Math.abs(tj - j) <= 2) near = true;
          }
          if (!near) {
            bc = v;
            bi = i * nTof + j;
          }
        }
      }
      if (bi < 0) break;
      taken.push(bi);
      const i = Math.floor(bi / nTof);
      const j = bi % nTof;
      const tdMax = Math.min(limitTd, spec.t1);
      const stepTd = dTd > 0 ? 0.5 * dTd : 0.02 * tof[j];
      const f = (td: number, tf: number): number => (td > tdMax ? Infinity : transferCost(spec, td, tf, null));
      const r = nelderMead2(f, spec.t0 + i * dTd, tof[j], stepTd, step[j], 70);
      const cost = transferCost(spec, r.x, r.y, null);
      if (cost < Infinity) out.push({ td: r.x, tof: r.y, cost, dv1: _cDv1, dv2: _cDv2 });
    }
    out.sort((a, b) => a.cost - b.cost);
    return out;
  };
  const all = pickTop(Infinity, 3);
  const early = earlyEnd < spec.t1 ? pickTop(earlyEnd, 2) : all;
  return { all, early };
}

const magnitude = (x: number, y: number, z: number): number => Math.sqrt(x * x + y * y + z * z);

// ===================================================================================== rendezvous

/** Options of {@link planRendezvous}. */
export interface RendezvousOptions extends PlanOptions {
  /** Longest wait before the departure burn, s. Default: about one synodic period — at least 1.5 ship orbits, at most 8 orbits of the slower object. */
  maxWait?: number;
  /** Distance from the target at which the ship should end up, m. Default 1500. */
  standoff?: number;
}

/**
 * Rendezvous with something orbiting the same body as the ship (a station, a mining site, a derelict):
 * `targetOrbit` are its elements around `ship.bodyId`.
 *
 * A single-revolution Lambert search over departure time (within a few orbits) and time of flight —
 * coarse grid, then local refinement — minimises the total Δv of the departure burn plus the
 * velocity-match burn at arrival. Transfers whose arc dips below {@link safeRadius} (or leaves the
 * sphere of influence) are rejected. Plane changes are simply part of the two burns.
 *
 * Returns two nodes: the departure burn and the 'match velocity' burn. The arrival point is offset
 * `standoff` metres short of the target along the approach path, so the ship stops beside it, not
 * on top of it. `rendezvous` in the result holds the predicted miss distance and relative speed
 * after the second burn. Because transfers are limited to one revolution, catching a target on
 * (nearly) the same orbit costs more than a patient multi-orbit phasing would.
 */
export function planRendezvous(model: SystemModel, ship: TrajectoryStart, targetOrbit: OrbitElements, opts: RendezvousOptions = {}): PlanResult {
  return guarded(() => {
    const s = settle(model, ship);
    if (typeof s === 'string') return fail(s);
    const { body, mu, info } = s;
    const o = targetOrbit;
    if (!o || !(o.a > 0 && o.a < Infinity && o.e >= 0 && o.e < 1) || !Number.isFinite(o.i + o.lan + o.argp + o.m0 + o.epoch)) return fail('The target is not on a closed orbit');
    const lead = leadOf(opts);
    if (lead >= s.stay) return fail(`No time to plan: ${stayText(s)}`);
    const standoff = clampN(Number.isFinite(opts.standoff) ? (opts.standoff as number) : 1500, 0, 1e5);
    const t0 = s.ship.t + lead;
    const sv0 = propagateStateTo(newState(), s.ship.sv, mu, lead);
    const tgt0 = elementsToStateTo(newState(), o, mu, t0);
    const d0 = vlen(vsub(sv0.r, tgt0.r));
    const vrel0 = vlen(vsub(sv0.v, tgt0.v));
    if (d0 < Math.max(2 * standoff, 3000)) {
      if (vrel0 < 0.05) {
        const p = okPlan(ship.t, [], ship.t, 'Already alongside the target', []);
        p.rendezvous = { departureTime: ship.t, timeOfFlight: 0, distance: d0, relSpeed: vrel0 };
        return p;
      }
      const node = makeNode('match-velocity', t0, body.id, sv0, vsub(tgt0.v, sv0.v));
      const p = okPlan(ship.t, [node], t0, `Match velocity with the target (${fmtDistance(d0)} away): Δv ${fmtSpeed(vrel0)}`, []);
      p.rendezvous = { departureTime: t0, timeOfFlight: 0, distance: d0, relSpeed: 0 };
      return p;
    }

    const Tt = orbitalPeriod(mu, o.a);
    const r0 = vlen(sv0.r);
    const Ts = info.closed ? info.period : TAU * Math.sqrt((r0 * r0 * r0) / mu);
    const S = info.closed ? synodicPeriod(Ts, Tt) : Infinity;
    const Tmax = Math.max(Ts, Tt);
    let W = Number.isFinite(opts.maxWait) ? Math.max(0, opts.maxWait as number) : clampN(1.25 * S, 1.5 * Ts, 8 * Tmax);
    if (s.stay < Infinity) W = Math.min(W, 0.98 * (s.stay - lead));
    const aS = info.closed ? info.a : r0;
    const tofH = PI * Math.sqrt(Math.pow(0.5 * (aS + o.a), 3) / mu);
    const hasSoi = body.soi < Infinity;
    const spec: TransferSpec = {
      mu,
      normal: normalOf(sv0),
      dep: (t, out) => void propagateStateTo(out, sv0, mu, t - t0),
      arr: (t, out) => void elementsToStateTo(out, o, mu, t),
      depCost: magnitude,
      arrCost: magnitude,
      rMin: Math.min(safeRadius(body), 0.999 * Math.min(info.periapsis, o.a * (1 - o.e))),
      rMax: hasSoi ? 0.95 * body.soi : Infinity,
      t0,
      t1: t0 + W,
      tofMin: 0.08 * tofH,
      tofMax: 1.2 * Math.max(Tmax, 2 * tofH),
      depPeriod: Ts,
      arrPeriod: Tt,
      waitBias: 0.03,
    };
    const found = searchTransfer(spec, Infinity);
    if (found.all.length === 0) return fail('No safe transfer to the target was found');

    let fallback: PlanOk | null = null;
    for (const cand of found.all) {
      const dep = newState();
      const arr = newState();
      spec.dep(cand.td, dep);
      spec.arr(cand.td + cand.tof, arr);
      let sol = lambert(dep.r, arr.r, cand.tof, mu, _lamOpts);
      if (!sol) continue;
      let aim: V3 = arr.r;
      if (standoff > 0) {
        // Stop short of the target along the approach path.
        const vrel = vsub(sol.v2, arr.v);
        const vl = vlen(vrel);
        const dir = vl > 1e-3 ? vscale(vrel, -1 / vl) : vnorm(arr.r);
        const aim2 = vaddScaled(arr.r, dir, standoff);
        const sol2 = lambert(dep.r, aim2, cand.tof, mu, _lamOpts);
        if (sol2 && arcSafe(dep.r, sol2.v1, aim2, sol2.v2, mu, spec.rMin, spec.rMax)) {
          sol = sol2;
          aim = aim2;
        }
      }
      const dv1 = vsub(sol.v1, dep.v);
      const dv2 = vsub(arr.v, sol.v2);
      const ta = cand.td + cand.tof;
      const nodes = [makeNode('rendezvous-depart', cand.td, body.id, dep, dv1), makeNode('match-velocity', ta, body.id, { r: aim, v: sol.v2 }, dv2)];
      // Fly it through the real prediction.
      const pred = predictWithNodes(model, s.ship, nodes, { maxPatches: 1, maxDuration: 1 });
      const a2 = pred.nodes[1];
      const warnings: string[] = [];
      let dist = standoff;
      let rel = 0;
      let good = pred.complete && a2.bodyId === body.id;
      if (good) {
        dist = vlen(vsub(a2.after.r, arr.r));
        rel = vlen(vsub(a2.after.v, arr.v));
        if (dist > 3 * standoff + 3000 || rel > 2) good = false;
      }
      if (!good) warnings.push('The transfer is disturbed on the way (another sphere of influence): re-plan after the first burn');
      const plan = okPlan(
        ship.t,
        nodes,
        ta,
        `Rendezvous: burn in ${fmtDuration(cand.td - ship.t)} (Δv ${fmtSpeed(vlen(dv1))}), match velocity ${fmtDuration(ta - ship.t)} from now (Δv ${fmtSpeed(vlen(dv2))})`,
        warnings,
      );
      plan.rendezvous = { departureTime: cand.td, timeOfFlight: cand.tof, distance: dist, relSpeed: rel };
      if (good) return plan;
      if (!fallback) fallback = plan;
    }
    return fallback ?? fail('No safe transfer to the target was found');
  });
}

// ===================================================================================== encounters and shooting

/** How a predicted trajectory meets a target body, as residuals for the shooting method. */
interface Encounter {
  ok: boolean;
  /** True when the trajectory actually enters the target's SOI. */
  entered: boolean;
  /** Scaled residuals: periapsis (via angular momentum) and plane. Both zero = requested periapsis in the requested plane. */
  e1: number;
  e2: number;
  /** Predicted periapsis radius (closest-approach distance when not entered), m, and its sim time. */
  rp: number;
  tPeri: number;
  /** Unit angular momentum of the pass relative to the target, and its angle to the requested normal. */
  hDir: V3;
  inc: number;
  pred: NodePrediction | null;
  patch: TrajectoryPatch | null;
}

const noEncounter = (): Encounter => ({ ok: false, entered: false, e1: 0, e2: 0, rp: 0, tPeri: 0, hDir: { x: 0, y: 1, z: 0 }, inc: 0, pred: null, patch: null });

/**
 * Residuals of a state `rel` relative to the target (mu `muT`) against a pass with periapsis `rpDes`
 * in the plane with normal `nDes`. Works on the angular momentum h = r × v, which is a smooth
 * (nearly linear) function of the miss even for trajectories that pass straight through the centre:
 * h must equal hDes·ĥ, where hDes is the angular momentum of the requested periapsis at this energy
 * and ĥ is nDes made perpendicular to the approach direction.
 */
function encounterResiduals(rel: StateVector, muT: number, rpDes: number, nDes: V3, out: Encounter): void {
  const h = vcross(rel.r, rel.v);
  const r = vlen(rel.r);
  const v = vlen(rel.v);
  const sHat = vnorm(rel.v);
  const hT = perpendicularToward(nDes, sHat);
  const tHat = vcross(sHat, hT);
  const eps = 0.5 * v * v - muT / r;
  const hDes = rpDes * Math.sqrt(Math.max(0, 2 * (eps + muT / rpDes)));
  const scale = hDes > 0 ? hDes : r * v;
  out.e1 = (vdot(h, hT) - hDes) / scale;
  out.e2 = vdot(h, tHat) / scale;
  const hl = vlen(h);
  out.hDir = hl > 0 ? vscale(h, 1 / hl) : hT;
  out.inc = Math.atan2(vlen(vcross(out.hDir, nDes)), vdot(out.hDir, nDes));
}

/**
 * Predict `nodes` from `start` and describe the first pass at `target` after node `varId` (or from
 * the start when null). If the trajectory misses the target's SOI, the closest approach in the
 * parent's frame stands in for it, so the residuals stay meaningful far from the solution.
 */
function evalEncounter(
  model: SystemModel,
  start: TrajectoryStart,
  nodes: readonly ManeuverNode[],
  varId: string | null,
  target: BodyDef,
  rpDes: number,
  nDes: V3,
  horizon: number,
): Encounter {
  const out = noEncounter();
  let lastT = start.t;
  for (const n of nodes) if (n.t > lastT) lastT = n.t;
  const pred = predictWithNodes(model, start, nodes, { maxPatches: 8, maxDuration: Math.max(1, horizon - lastT), searchPeriods: 1, stopAtAtmosphere: false });
  out.pred = pred;
  let i0 = 0;
  if (varId !== null) {
    const a = pred.nodes.find((n) => n.node.id === varId);
    if (!a || !a.reached) return out;
    i0 = a.patchIndex;
  }
  for (let i = i0; i < pred.patches.length; i++) {
    const p = pred.patches[i];
    if (p.bodyId !== target.id) continue;
    encounterResiduals(p.svStart, target.mu, rpDes, nDes, out);
    out.ok = true;
    out.entered = true;
    out.patch = p;
    out.rp = p.periapsisRadius;
    out.tPeri = p.periapsisTime ?? p.tStart + Math.max(0, orbitInfo(p.svStart, p.mu, p.tStart).timeToPeriapsis);
    return out;
  }
  const parent = model.parent(target.id);
  if (!parent) return out;
  let bestD = Infinity;
  let bestT = 0;
  let bestP: TrajectoryPatch | null = null;
  for (let i = i0; i < pred.patches.length; i++) {
    const p = pred.patches[i];
    if (p.bodyId !== parent.id) continue;
    const tB = Math.min(p.tEnd, horizon);
    if (!(tB > p.tStart)) continue;
    model.bodyState(target.id, p.tStart, _s1);
    const ca = closestApproach(p.svStart, _s1, parent.mu, p.tStart, tB, { epoch: p.tStart, maxSamples: 600 });
    if (ca.distance < bestD) {
      bestD = ca.distance;
      bestT = ca.t;
      bestP = p;
    }
  }
  if (!bestP) return out;
  propagateStateTo(_s2, bestP.svStart, parent.mu, bestT - bestP.tStart);
  model.bodyState(target.id, bestT, _s1);
  const rel: StateVector = { r: vsub(_s2.r, _s1.r), v: vsub(_s2.v, _s1.v) };
  if (!(vlen(rel.r) > 0)) return out;
  encounterResiduals(rel, target.mu, rpDes, nDes, out);
  out.ok = true;
  out.rp = bestD;
  out.tPeri = bestT;
  return out;
}

/**
 * Shooting refinement: adjust the three Δv components of `varNode` (its time is kept) until the
 * predicted pass at `target` has periapsis `rpDes` in the plane closest to `nDes`. Damped
 * Gauss–Newton on the two encounter residuals with a finite-difference Jacobian; the step is the
 * minimum-norm one (three unknowns, two conditions), so the burn changes as little as possible.
 */
function shootEncounter(
  model: SystemModel,
  start: TrajectoryStart,
  baseNodes: readonly ManeuverNode[],
  varNode: ManeuverNode,
  target: BodyDef,
  rpDes: number,
  nDes: V3,
  horizon: number,
): { node: ManeuverNode; enc: Encounter; converged: boolean } {
  let x = [varNode.dv.prograde, varNode.dv.normal, varNode.dv.radial];
  const mk = (c: number[]): ManeuverNode => ({ id: varNode.id, t: varNode.t, bodyId: varNode.bodyId, dv: { prograde: c[0], normal: c[1], radial: c[2] } });
  const evalAt = (c: number[]): Encounter => evalEncounter(model, start, [...baseNodes, mk(c)], varNode.id, target, rpDes, nDes, horizon);
  const norm2 = (e: Encounter): number => Math.sqrt(e.e1 * e.e1 + e.e2 * e.e2);
  const tolR = Math.max(20, 1e-6 * rpDes);
  const done = (e: Encounter): boolean => e.ok && e.entered && Math.abs(e.rp - rpDes) <= tolR && Math.abs(e.e2) < 2e-4;
  let E = evalAt(x);
  if (!E.ok) return { node: varNode, enc: E, converged: false };
  const applied = E.pred ? E.pred.nodes.find((n) => n.node.id === varNode.id) : undefined;
  const vNode = applied ? vlen(applied.before.v) : 1000;
  const delta = Math.max(1e-3, 1e-6 * vNode);
  let lambda = 0;
  for (let iter = 0; iter < 18 && !done(E); iter++) {
    const J0 = [0, 0, 0];
    const J1 = [0, 0, 0];
    let jacOk = true;
    for (let k = 0; k < 3; k++) {
      const c = x.slice();
      c[k] = x[k] + delta;
      let d = delta;
      let Ek = evalAt(c);
      if (!Ek.ok) {
        c[k] = x[k] - delta;
        d = -delta;
        Ek = evalAt(c);
      }
      if (!Ek.ok) {
        jacOk = false;
        break;
      }
      J0[k] = (Ek.e1 - E.e1) / d;
      J1[k] = (Ek.e2 - E.e2) / d;
    }
    if (!jacOk) break;
    let a11 = J0[0] * J0[0] + J0[1] * J0[1] + J0[2] * J0[2];
    const a12 = J0[0] * J1[0] + J0[1] * J1[1] + J0[2] * J1[2];
    let a22 = J1[0] * J1[0] + J1[1] * J1[1] + J1[2] * J1[2];
    const tr = a11 + a22;
    a11 += lambda * tr + 1e-14 * tr;
    a22 += lambda * tr + 1e-14 * tr;
    const det = a11 * a22 - a12 * a12;
    if (!(Math.abs(det) > 0)) break;
    const y1 = (-E.e1 * a22 + E.e2 * a12) / det;
    const y2 = (E.e1 * a12 - E.e2 * a11) / det;
    const dx = [J0[0] * y1 + J1[0] * y2, J0[1] * y1 + J1[1] * y2, J0[2] * y1 + J1[2] * y2];
    const dl = Math.sqrt(dx[0] * dx[0] + dx[1] * dx[1] + dx[2] * dx[2]);
    if (!(dl < Infinity)) break;
    const cap = Math.max(Math.sqrt(x[0] * x[0] + x[1] * x[1] + x[2] * x[2]), 0.2 * vNode);
    let sc = dl > cap ? cap / dl : 1;
    let accepted = false;
    const n0 = norm2(E);
    for (let ls = 0; ls < 7; ls++) {
      const c = [x[0] + sc * dx[0], x[1] + sc * dx[1], x[2] + sc * dx[2]];
      const En = evalAt(c);
      if (En.ok && norm2(En) < n0) {
        x = c;
        E = En;
        accepted = true;
        break;
      }
      sc *= 0.35;
    }
    if (accepted) lambda *= 0.25;
    else {
      lambda = lambda === 0 ? 1e-3 : lambda * 10;
      if (lambda > 1e4) break;
    }
  }
  return { node: mk(x), enc: E, converged: done(E) };
}

/** Offset (m, system axes) of the aim point from the target's centre so that an approach with relative velocity `vrel` passes at periapsis `rpDes`, orbiting about `nDes` as nearly as possible. */
function aimOffset(vrel: V3, target: BodyDef, rpDes: number, nDes: V3): V3 {
  const v = vlen(vrel);
  if (!(v > 0)) return { x: 0, y: 0, z: 0 };
  const sHat = vscale(vrel, 1 / v);
  const bHat = vcross(sHat, perpendicularToward(nDes, sHat));
  const soi = target.soi < Infinity ? target.soi : 1e30;
  const vp2 = v * v + 2 * target.mu * (1 / rpDes - 1 / soi);
  const b = Math.min((rpDes * Math.sqrt(Math.max(vp2, 0))) / v, 0.8 * soi);
  return vscale(bHat, b);
}

// ===================================================================================== transfers between bodies

/** Options of {@link planTransferToBody}. */
export interface TransferOptions extends PlanOptions {
  /** Requested periapsis at the target as an altitude above its mean radius, m… */
  periapsisAltitude?: number;
  /** …or as a radius from its centre, m (takes precedence). Default: a low parking altitude just above {@link safeRadius}. */
  periapsisRadius?: number;
  /** Capture into an ellipse with this apoapsis radius (m) instead of a circular orbit. */
  captureApoapsis?: number;
  /** Include the capture burn (default true). False = plan a flyby and judge windows by departure Δv alone. */
  capture?: boolean;
  /** Normal of the plane the arrival orbit should lie in (system axes), e.g. a station's orbit normal. Default +Y: prograde, as close to the reference plane as the approach allows. */
  planeNormal?: V3;
  /** 'now' (default): leave at the first opportunity and report a much cheaper later window in `nextWindow`. 'best': plan for the cheapest window within about one synodic period. */
  window?: 'now' | 'best';
  /** Do not depart before this sim time, s. */
  departAfter?: number;
}

/** Velocity (relative to the body) at position `rb` on the hyperbola that leaves along unit direction `sHat` with excess speed `vInf`. */
function departureVelocity(rb: V3, sHat: V3, vInf: number, mu: number): V3 {
  const r = vlen(rb);
  const rHat = vscale(rb, 1 / r);
  const c = clampN(vdot(rHat, sHat), -0.999999, 1);
  const D = Math.sqrt(1 + (4 * mu) / (r * vInf * vInf * (1 + c)));
  return vadd(vscale(sHat, 0.5 * vInf * (D + 1)), vscale(rHat, 0.5 * vInf * (D - 1)));
}

/** Solve the 3×3 system M·x = b (rows m0..m2) by Cramer's rule; null if singular. */
function solve3(m0: number[], m1: number[], m2: number[], b: number[]): number[] | null {
  const det = m0[0] * (m1[1] * m2[2] - m1[2] * m2[1]) - m0[1] * (m1[0] * m2[2] - m1[2] * m2[0]) + m0[2] * (m1[0] * m2[1] - m1[1] * m2[0]);
  if (!(Math.abs(det) > 0) || !(Math.abs(det) < Infinity)) return null;
  const x0 = b[0] * (m1[1] * m2[2] - m1[2] * m2[1]) - m0[1] * (b[1] * m2[2] - m1[2] * b[2]) + m0[2] * (b[1] * m2[1] - m1[1] * b[2]);
  const x1 = m0[0] * (b[1] * m2[2] - m1[2] * b[2]) - b[0] * (m1[0] * m2[2] - m1[2] * m2[0]) + m0[2] * (m1[0] * b[2] - b[1] * m2[0]);
  const x2 = m0[0] * (m1[1] * b[2] - b[1] * m2[1]) - m0[1] * (m1[0] * b[2] - b[1] * m2[0]) + b[0] * (m1[0] * m2[1] - m1[1] * m2[0]);
  return [x0 / det, x1 / det, x2 / det];
}

/**
 * Where a ship leaving `rb` (relative to body A) with velocity `u` at time `tb` is at time `ta`, in
 * the frame of A's parent (mu `muC`), minus the aim point: exact patched conics (A-conic to A's SOI
 * edge, then the parent's conic), ignoring every other body. Returns false if the ship never
 * leaves A's SOI or leaves it after `ta`.
 */
function ejectionMiss(model: SystemModel, A: BodyDef, muC: number, rb: V3, u: V3, tb: number, aim: V3, ta: number, out: V3): boolean {
  _s1.r.x = rb.x;
  _s1.r.y = rb.y;
  _s1.r.z = rb.z;
  _s1.v.x = u.x;
  _s1.v.y = u.y;
  _s1.v.z = u.z;
  const dtx = timeToRadius(_s1, A.mu, A.soi, 'outward');
  if (!(dtx < Infinity)) return false;
  const tx = tb + dtx;
  if (!(tx < ta)) return false;
  propagateStateTo(_s2, _s1, A.mu, dtx);
  model.bodyState(A.id, tx, _s3);
  _s2.r.x += _s3.r.x;
  _s2.r.y += _s3.r.y;
  _s2.r.z += _s3.r.z;
  _s2.v.x += _s3.v.x;
  _s2.v.y += _s3.v.y;
  _s2.v.z += _s3.v.z;
  propagateStateTo(_s3, _s2, muC, ta - tx);
  out.x = _s3.r.x - aim.x;
  out.y = _s3.r.y - aim.y;
  out.z = _s3.r.z - aim.z;
  return finiteV(out);
}

/** Newton iteration on the post-burn velocity at `rb` so that the ship passes through `aim` at `ta` (see ejectionMiss). */
function solveEjection(model: SystemModel, A: BodyDef, muC: number, rb: V3, u0: V3, tb: number, aim: V3, ta: number): V3 | null {
  let u = { x: u0.x, y: u0.y, z: u0.z };
  const res = { x: 0, y: 0, z: 0 };
  const rk = { x: 0, y: 0, z: 0 };
  if (!ejectionMiss(model, A, muC, rb, u, tb, aim, ta, res)) return null;
  const tol = Math.max(10, 1e-9 * vlen(aim));
  for (let it = 0; it < 20; it++) {
    const n0 = vlen(res);
    if (n0 < tol) return u;
    const d = 1e-6 * vlen(u);
    const cols: V3[] = [];
    for (let k = 0; k < 3; k++) {
      const uk = { x: u.x + (k === 0 ? d : 0), y: u.y + (k === 1 ? d : 0), z: u.z + (k === 2 ? d : 0) };
      if (!ejectionMiss(model, A, muC, rb, uk, tb, aim, ta, rk)) return null;
      cols.push({ x: (rk.x - res.x) / d, y: (rk.y - res.y) / d, z: (rk.z - res.z) / d });
    }
    const step = solve3([cols[0].x, cols[1].x, cols[2].x], [cols[0].y, cols[1].y, cols[2].y], [cols[0].z, cols[1].z, cols[2].z], [-res.x, -res.y, -res.z]);
    if (!step) return null;
    const sl = Math.sqrt(step[0] * step[0] + step[1] * step[1] + step[2] * step[2]);
    let sc = sl > 0.3 * vlen(u) ? (0.3 * vlen(u)) / sl : 1;
    let moved = false;
    for (let ls = 0; ls < 8; ls++) {
      const un = { x: u.x + sc * step[0], y: u.y + sc * step[1], z: u.z + sc * step[2] };
      if (ejectionMiss(model, A, muC, rb, un, tb, aim, ta, rk) && vlen(rk) < n0) {
        u = un;
        res.x = rk.x;
        res.y = rk.y;
        res.z = rk.z;
        moved = true;
        break;
      }
      sc *= 0.4;
    }
    if (!moved) return n0 < 1e3 * tol ? u : null;
  }
  return vlen(res) < 1e3 * tol ? u : null;
}

/** Capture-cost estimate (m/s) for arriving at `target` with relative speed v at its SOI edge and braking at periapsis `rp`. */
function captureCostFn(target: BodyDef, rp: number, opts: TransferOptions): (x: number, y: number, z: number) => number {
  if (opts.capture === false) return () => 0;
  const ap = opts.captureApoapsis !== undefined && opts.captureApoapsis > 0 ? opts.captureApoapsis : rp;
  const vFinal = Math.sqrt(target.mu * (2 / rp - 2 / (rp + ap)));
  const k = 2 * target.mu * (1 / rp - (target.soi < Infinity ? 1 / target.soi : 0));
  return (x, y, z) => Math.abs(Math.sqrt(Math.max(0, x * x + y * y + z * z + k)) - vFinal);
}

/** Assemble the final transfer plan from the refined departure node and the predicted encounter. */
function finishTransfer(shipT: number, node: ManeuverNode, enc: Encounter, target: BodyDef, rpDes: number, opts: TransferOptions, warnings: string[], verb: string): PlanResult {
  const p = enc.patch;
  if (!p) return fail(`The transfer does not reach ${target.name}`);
  const nodes = [node];
  let captureDv = 0;
  if (opts.capture !== false) {
    const svP = propagateStateTo(newState(), p.svStart, p.mu, enc.tPeri - p.tStart);
    const cap = planCapture({ bodyId: target.id, sv: svP, t: enc.tPeri }, target.mu, { apoapsis: opts.captureApoapsis });
    if (cap.ok && cap.nodes.length > 0) {
      nodes.push(cap.nodes[0]);
      captureDv = nodeDvMagnitude(cap.nodes[0]);
    }
  }
  if (target.atmosphere && rpDes < target.radius + target.atmosphere.height) warnings.push('The periapsis is inside the atmosphere: expect drag and heating');
  const dv1 = nodeDvMagnitude(node);
  const plan = okPlan(
    shipT,
    nodes,
    enc.tPeri,
    `${verb} ${target.name}: burn in ${fmtDuration(node.t - shipT)} (Δv ${fmtSpeed(dv1)}), periapsis ${altText(target, enc.rp)} in ${fmtDuration(enc.tPeri - shipT)}` +
      (opts.capture !== false ? `, capture Δv ${fmtSpeed(captureDv)}` : ''),
    warnings,
  );
  plan.encounter = { bodyId: target.id, periapsisRadius: enc.rp, periapsisTime: enc.tPeri, inclination: enc.inc };
  return plan;
}

/** Target is a child of the body the ship orbits (planet -> its moon, or a ship in solar orbit -> a planet). */
function transferDirect(model: SystemModel, s: Settled, T: BodyDef, rpDes: number, nDes: V3, opts: TransferOptions, shipT: number): PlanResult {
  const { body: A, mu, info } = s;
  const orb = T.orbit;
  if (!orb) return fail('The target has no orbit');
  const lead = leadOf(opts);
  const t0 = Math.max(s.ship.t + lead, Number.isFinite(opts.departAfter) ? (opts.departAfter as number) : -Infinity);
  if (t0 - s.ship.t >= s.stay) return fail(`No time to plan: ${stayText(s)}`);
  const sv0 = propagateStateTo(newState(), s.ship.sv, mu, t0 - s.ship.t);
  const r0 = vlen(sv0.r);
  const TT = orbitalPeriod(mu, Math.abs(orb.a));
  const Ts = info.closed ? info.period : TAU * Math.sqrt((r0 * r0 * r0) / mu);
  const S = info.closed ? synodicPeriod(Ts, TT) : Infinity;
  let W = clampN(1.25 * S, 1.5 * Ts, 4 * Math.max(Ts, TT));
  if (s.stay < Infinity) W = Math.min(W, 0.98 * (s.stay - (t0 - s.ship.t)));
  const aS = info.closed ? info.a : r0;
  const tofH = PI * Math.sqrt(Math.pow(0.5 * (aS + Math.abs(orb.a)), 3) / mu);
  const spec: TransferSpec = {
    mu,
    normal: normalOf(sv0),
    dep: (t, out) => void propagateStateTo(out, sv0, mu, t - t0),
    arr: (t, out) => void model.bodyState(T.id, t, out),
    depCost: magnitude,
    arrCost: captureCostFn(T, rpDes, opts),
    rMin: Math.min(safeRadius(A), 0.999 * info.periapsis),
    rMax: A.soi < Infinity ? 0.95 * A.soi : Infinity,
    t0,
    t1: t0 + W,
    tofMin: 0.15 * tofH,
    tofMax: 2.5 * tofH,
    depPeriod: Ts,
    arrPeriod: TT,
    waitBias: 0.03,
  };
  const found = searchTransfer(spec, Infinity);
  if (found.all.length === 0) return fail(`No safe transfer to ${T.name} was found`);
  let best: { node: ManeuverNode; enc: Encounter; err: number } | null = null;
  for (const cand of found.all) {
    const dep = newState();
    const arr = newState();
    spec.dep(cand.td, dep);
    spec.arr(cand.td + cand.tof, arr);
    const sol0 = lambert(dep.r, arr.r, cand.tof, mu, _lamOpts);
    if (!sol0) continue;
    const aim = vadd(arr.r, aimOffset(vsub(sol0.v2, arr.v), T, rpDes, nDes));
    const sol = lambert(dep.r, aim, cand.tof, mu, _lamOpts) ?? sol0;
    const node0 = makeNode('transfer', cand.td, A.id, dep, vsub(sol.v1, dep.v));
    const shot = shootEncounter(model, s.ship, [], node0, T, rpDes, nDes, cand.td + 1.5 * cand.tof);
    if (shot.converged) return finishTransfer(shipT, shot.node, shot.enc, T, rpDes, opts, [], 'Transfer to');
    if (shot.enc.ok && shot.enc.entered) {
      const err = Math.abs(shot.enc.rp - rpDes) / rpDes;
      if (!best || err < best.err) best = { node: shot.node, enc: shot.enc, err };
    }
  }
  if (best && best.err < 0.05) {
    return finishTransfer(shipT, best.node, best.enc, T, rpDes, opts, [`The periapsis could only be refined to ${altText(T, best.enc.rp)}: correct it on the way`], 'Transfer to');
  }
  return fail(`Could not refine a transfer to ${T.name}`);
}

/** Ship orbits body A; target T is a sibling of A (both children of C): eject from A, cross C's space, meet T. */
function transferSibling(model: SystemModel, s: Settled, T: BodyDef, C: BodyDef, rpDes: number, nDes: V3, opts: TransferOptions, shipT: number): PlanResult {
  const { body: A, info } = s;
  if (!A.orbit || !T.orbit) return fail('Bodies without orbits cannot be linked');
  const lead = leadOf(opts);
  const t0 = Math.max(s.ship.t + lead, Number.isFinite(opts.departAfter) ? (opts.departAfter as number) : -Infinity);
  if (t0 - s.ship.t >= s.stay) return fail(`No time to plan: ${stayText(s)}`);
  const sv0 = propagateStateTo(newState(), s.ship.sv, A.mu, t0 - s.ship.t);
  const muC = C.mu;
  const aA = Math.abs(A.orbit.a);
  const aT = Math.abs(T.orbit.a);
  const TA = orbitalPeriod(muC, aA);
  const TT = orbitalPeriod(muC, aT);
  const S = synodicPeriod(TA, TT);
  const Tpark = info.closed ? info.period : 0;
  const W = Math.min(1.3 * S, 4 * Math.max(TA, TT));
  const earlyEnd = t0 + Math.max(2 * Tpark, 0.03 * W);
  const tofH = PI * Math.sqrt(Math.pow(0.5 * (aA + aT), 3) / muC);
  const rPark = info.closed ? info.periapsis : vlen(sv0.r);
  const vPark = info.closed ? Math.sqrt(A.mu * (2 / rPark - 1 / info.a)) : vlen(sv0.v);
  const kEsc = 2 * A.mu * (1 / rPark - 1 / A.soi);
  const depA = model.bodyState(A.id, t0);
  const spec: TransferSpec = {
    mu: muC,
    normal: normalOf(depA),
    dep: (t, out) => void model.bodyState(A.id, t, out),
    arr: (t, out) => void model.bodyState(T.id, t, out),
    depCost: (x, y, z) => Math.abs(Math.sqrt(x * x + y * y + z * z + kEsc) - vPark),
    arrCost: captureCostFn(T, rpDes, opts),
    rMin: safeRadius(C),
    rMax: C.soi < Infinity ? 0.95 * C.soi : Infinity,
    t0,
    t1: t0 + W,
    tofMin: 0.3 * tofH,
    tofMax: 2.5 * tofH,
    depPeriod: TA,
    arrPeriod: TT,
    waitBias: 0.02,
  };
  const found = searchTransfer(spec, earlyEnd);
  const wantBest = opts.window === 'best';
  const list = wantBest || found.early.length === 0 ? found.all : found.early;
  if (list.length === 0) return fail(`No safe transfer to ${T.name} was found`);
  const warnings: string[] = [];
  if (!wantBest && found.early.length === 0) warnings.push('No safe departure right now: planned for the next window instead');

  const rSafeA = safeRadius(A);
  const NB = 36;
  let best: { node: ManeuverNode; enc: Encounter; err: number; cand: TransferCand } | null = null;
  for (const cand of list) {
    const ta = cand.td + cand.tof;
    const dA = model.bodyState(A.id, cand.td);
    const dT = model.bodyState(T.id, ta);
    const sol = lambert(dA.r, dT.r, cand.tof, muC, _lamOpts);
    if (!sol) continue;
    const vx = vsub(sol.v1, dA.v);
    const aim = vadd(dT.r, aimOffset(vsub(sol.v2, dT.v), T, rpDes, nDes));
    const vxMag = vlen(vx);
    const sHat = vscale(vx, 1 / vxMag);
    const vInf = Math.sqrt(Math.max(vxMag * vxMag - (2 * A.mu) / A.soi, 0.09 * vxMag * vxMag));
    // Candidate burn points around one parking orbit, ranked by the hyperbolic-departure estimate.
    const times: number[] = [];
    if (info.closed) {
      const vp = Math.sqrt(vInf * vInf + (2 * A.mu) / rPark);
      const tSoi = timeToRadius({ r: { x: rPark, y: 0, z: 0 }, v: { x: 0, y: 0, z: -vp } }, A.mu, A.soi, 'outward');
      const base = Math.max(t0, cand.td - (tSoi < Infinity ? tSoi : 0) - 0.5 * Tpark);
      for (let k = 0; k < NB; k++) times.push(base + (k * Tpark) / NB);
    } else {
      times.push(t0);
    }
    const guesses = times.map((tb) => {
      const svb = propagateStateTo(newState(), sv0, A.mu, tb - t0);
      const u0 = departureVelocity(svb.r, sHat, vInf, A.mu);
      return { tb, svb, u0, g: vlen(vsub(u0, svb.v)) };
    });
    guesses.sort((a, b) => a.g - b.g);
    let pick: { tb: number; svb: StateVector; u: V3; dv: number } | null = null;
    const tryBurn = (tb: number, svb: StateVector, u0: V3): void => {
      const u = solveEjection(model, A, muC, svb.r, u0, tb, aim, ta);
      if (!u) return;
      // The outbound leg must not dip into the body.
      if (vdot(svb.r, u) < 0) {
        const [rp] = apsidesAtSpeed(A.mu, vlen(svb.r), vlen(u), vlen(vcross(vnorm(svb.r), u)) / vlen(u));
        if (rp < Math.min(rSafeA, 0.999 * info.periapsis)) return;
      }
      const dv = vlen(vsub(u, svb.v));
      if (!pick || dv < pick.dv) pick = { tb, svb, u, dv };
    };
    for (let k = 0; k < Math.min(5, guesses.length); k++) tryBurn(guesses[k].tb, guesses[k].svb, guesses[k].u0);
    if (!pick) continue;
    if (info.closed) {
      // Slide the burn point along the orbit while it keeps getting cheaper.
      let stepT = (0.5 * Tpark) / NB;
      for (let round = 0; round < 4; round++) {
        const cur: { tb: number; svb: StateVector; u: V3; dv: number } = pick;
        for (const sgn of [-1, 1]) {
          const tb = cur.tb + sgn * stepT;
          if (tb < t0) continue;
          const svb = propagateStateTo(newState(), sv0, A.mu, tb - t0);
          tryBurn(tb, svb, vadd(svb.v, vsub(cur.u, cur.svb.v)));
        }
        stepT *= 0.5;
      }
    }
    const chosen: { tb: number; svb: StateVector; u: V3; dv: number } = pick;
    const node0 = makeNode('eject', chosen.tb, A.id, chosen.svb, vsub(chosen.u, chosen.svb.v));
    const shot = shootEncounter(model, s.ship, [], node0, T, rpDes, nDes, ta + 0.5 * cand.tof);
    if (shot.converged) {
      best = { node: shot.node, enc: shot.enc, err: 0, cand };
      break;
    }
    if (shot.enc.ok && shot.enc.entered) {
      const err = Math.abs(shot.enc.rp - rpDes) / rpDes;
      if (!best || err < best.err) best = { node: shot.node, enc: shot.enc, err, cand };
    }
  }
  if (!best || best.err >= 0.05) return fail(`Could not refine a transfer to ${T.name}`);
  if (best.err > 0) warnings.push(`The periapsis could only be refined to ${altText(T, best.enc.rp)}: correct it on the way`);
  const plan = finishTransfer(shipT, best.node, best.enc, T, rpDes, opts, warnings, 'Transfer to');
  if (plan.ok && !wantBest && found.all.length > 0 && found.early.length > 0) {
    const w = found.all[0];
    const now = found.early[0];
    if (w.td > earlyEnd && w.dv1 + w.dv2 < 0.8 * (now.dv1 + now.dv2)) {
      plan.nextWindow = { departureTime: w.td, arrivalTime: w.td + w.tof, totalDv: w.dv1 + w.dv2 };
      plan.warnings.push(`Waiting ${fmtDuration(w.td - shipT)} for the next window would cut Δv to about ${fmtSpeed(w.dv1 + w.dv2)}`);
    }
  }
  return plan;
}

const _esc = newState();

/** Apsides [rp, ra] of the orbit around A's parent after a prograde burn `dv` at state `svb` (rel. A) at `tb`; null if the ship does not leave A's SOI. */
function escapeApsides(model: SystemModel, A: BodyDef, muP: number, svb: StateVector, tb: number, dv: number): [number, number] | null {
  const speed = vlen(svb.v);
  const k = 1 + dv / speed;
  _esc.r.x = svb.r.x;
  _esc.r.y = svb.r.y;
  _esc.r.z = svb.r.z;
  _esc.v.x = svb.v.x * k;
  _esc.v.y = svb.v.y * k;
  _esc.v.z = svb.v.z * k;
  const dtx = timeToRadius(_esc, A.mu, A.soi, 'outward');
  if (!(dtx < Infinity)) return null;
  propagateStateTo(_s2, _esc, A.mu, dtx);
  model.bodyState(A.id, tb + dtx, _s3);
  const r = vadd(_s2.r, _s3.r);
  const v = vadd(_s2.v, _s3.v);
  const rn = vlen(r);
  const vn = vlen(v);
  return apsidesAtSpeed(muP, rn, vn, vlen(vcross(vscale(r, 1 / rn), v)) / vn);
}

/** Ship orbits moon A; target T is A's parent: escape A so that the orbit around T has its far apsis at `rDes`. */
function transferToParent(model: SystemModel, s: Settled, T: BodyDef, rDes: number, opts: TransferOptions, shipT: number): PlanResult {
  const { body: A, info } = s;
  const lead = leadOf(opts);
  const t0 = Math.max(s.ship.t + lead, Number.isFinite(opts.departAfter) ? (opts.departAfter as number) : -Infinity);
  if (t0 - s.ship.t >= s.stay) return fail(`No time to plan: ${stayText(s)}`);
  const sv0 = propagateStateTo(newState(), s.ship.sv, A.mu, t0 - s.ship.t);
  const stA = model.bodyState(A.id, t0);
  const rA = vlen(stA.r);
  const inward = rDes < rA;
  if (Math.abs(rDes - rA) < 1.5 * A.soi) return fail(`The requested orbit is too close to the orbit of ${A.name}`);
  if (!inward && T.soi < Infinity && rDes > 0.9 * T.soi) return fail(`The requested orbit is outside the sphere of influence of ${T.name}`);
  const vA = vlen(stA.v);
  const vx = Math.abs(Math.sqrt(T.mu * (2 / rA - 2 / (rA + rDes))) - vA);
  const g = (svb: StateVector, tb: number, dv: number): number => {
    const ap = escapeApsides(model, A, T.mu, svb, tb, dv);
    if (!ap) return NaN;
    return inward ? ap[0] - rDes : (ap[1] < Infinity ? ap[1] : 1e30) - rDes;
  };
  const solveAt = (tb: number): { tb: number; svb: StateVector; dv: number } | null => {
    const svb = propagateStateTo(newState(), sv0, A.mu, tb - t0);
    const rb = vlen(svb.r);
    const vb = vlen(svb.v);
    const dvGuess = Math.sqrt(vx * vx + 2 * A.mu * (1 / rb - 1 / A.soi)) - vb;
    const dvMin = Math.sqrt(A.mu * (2 / rb - 2 / (rb + A.soi))) * 1.0005 - vb;
    const lo = Math.max(dvMin, 0.4 * dvGuess, 1e-3);
    const hi = 2.5 * Math.max(dvGuess, lo);
    const n = 16;
    let prevDv = NaN;
    let prevG = NaN;
    for (let i = 0; i < n; i++) {
      const dv = lo * Math.pow(hi / lo, i / (n - 1));
      const gi = g(svb, tb, dv);
      // Inward: the periapsis must come down through rDes; outward: the apoapsis must rise through it.
      if (prevG === prevG && gi === gi && (inward ? prevG > 0 && gi <= 0 : prevG < 0 && gi >= 0)) {
        let a = prevDv;
        let b = dv;
        for (let it = 0; it < 50; it++) {
          const m = 0.5 * (a + b);
          const gm = g(svb, tb, m);
          if (gm !== gm) break;
          if (inward ? gm > 0 : gm < 0) a = m;
          else b = m;
        }
        return { tb, svb, dv: 0.5 * (a + b) };
      }
      prevDv = dv;
      prevG = gi;
    }
    return null;
  };
  const NB = 36;
  const Tpark = info.closed ? info.period : 0;
  let pick: { tb: number; svb: StateVector; dv: number } | null = null;
  for (let k = 0; k < (info.closed ? NB : 1); k++) {
    const c = solveAt(t0 + (k * Tpark) / NB);
    if (c && (!pick || c.dv < pick.dv)) pick = c;
  }
  if (!pick) return fail(`No escape burn from ${A.name} reaches the requested orbit`);
  if (info.closed) {
    let stepT = (0.5 * Tpark) / NB;
    for (let round = 0; round < 5; round++) {
      for (const sgn of [-1, 1]) {
        const tb: number = pick.tb + sgn * stepT;
        if (tb < t0) continue;
        const c = solveAt(tb);
        if (c && c.dv < pick.dv) pick = c;
      }
      stepT *= 0.5;
    }
  }
  const node: ManeuverNode = { id: `eject@${Math.round(pick.tb)}`, t: pick.tb, bodyId: A.id, dv: { prograde: pick.dv, normal: 0, radial: 0 } };
  // Verify (and polish) against the full prediction.
  const half = PI * Math.sqrt(Math.pow(0.5 * (rA + rDes), 3) / T.mu);
  const apsisOf = (dv: number): { p: TrajectoryPatch; val: number } | null => {
    node.dv.prograde = dv;
    const pred = predictWithNodes(model, s.ship, [node], { maxPatches: 4, maxDuration: 3 * half + DAY, searchPeriods: 1, stopAtAtmosphere: false });
    const a = pred.nodes[0];
    if (!a.reached) return null;
    for (let i = a.patchIndex; i < pred.patches.length; i++) {
      const p = pred.patches[i];
      if (p.bodyId === T.id) return { p, val: inward ? p.periapsisRadius : p.apoapsisRadius < Infinity ? p.apoapsisRadius : 1e30 };
    }
    return null;
  };
  let cur = apsisOf(pick.dv);
  if (!cur) return fail(`The escape from ${A.name} could not be verified`);
  let dvA = pick.dv;
  const tol = Math.max(100, 1e-6 * rDes);
  for (let it = 0; it < 8 && Math.abs(cur.val - rDes) > tol; it++) {
    const d = 1e-3;
    const nb = apsisOf(dvA + d);
    if (!nb) break;
    const slope = (nb.val - cur.val) / d;
    if (!(Math.abs(slope) > 0)) break;
    const next = dvA - clampN((cur.val - rDes) / slope, -0.2 * dvA, 0.2 * dvA);
    const nx = apsisOf(next);
    if (!nx) break;
    dvA = next;
    cur = nx;
  }
  node.dv.prograde = dvA;
  const fin = apsisOf(dvA);
  if (!fin) return fail(`The escape from ${A.name} could not be verified`);
  const p = fin.p;
  const warnings: string[] = [];
  if (Math.abs(fin.val - rDes) > 0.02 * rDes) warnings.push(`The far apsis could only be set to ${altText(T, fin.val)}`);
  const tApsis = inward ? p.periapsisTime ?? p.tStart + Math.max(0, orbitInfo(p.svStart, p.mu, p.tStart).timeToPeriapsis) : p.apoapsisTime;
  if (tApsis === null || !(tApsis > node.t)) {
    const flyby = okPlan(shipT, [node], node.t, `Escape ${A.name} toward ${T.name}: burn in ${fmtDuration(node.t - shipT)} (Δv ${fmtSpeed(dvA)})`, [...warnings, 'The arrival burn could not be planned: re-plan after escaping']);
    return flyby;
  }
  const nodes = [node];
  let captureDv = 0;
  if (opts.capture !== false) {
    const svP = propagateStateTo(newState(), p.svStart, p.mu, tApsis - p.tStart);
    const rr = vlen(svP.r);
    const ap = inward && opts.captureApoapsis !== undefined && opts.captureApoapsis > 0 ? opts.captureApoapsis : rr;
    const dvW = vsub(vscale(horizontalOf(svP), Math.sqrt(T.mu * (2 / rr - 2 / (rr + ap)))), svP.v);
    nodes.push(makeNode(inward ? 'capture' : 'circularize', tApsis, T.id, svP, dvW));
    captureDv = vlen(dvW);
  }
  if (inward && T.atmosphere && rDes < T.radius + T.atmosphere.height) warnings.push('The periapsis is inside the atmosphere: expect drag and heating');
  const plan = okPlan(
    shipT,
    nodes,
    tApsis,
    `Escape ${A.name} to ${T.name}: burn in ${fmtDuration(node.t - shipT)} (Δv ${fmtSpeed(dvA)}), ${inward ? 'periapsis' : 'apoapsis'} ${altText(T, fin.val)} in ${fmtDuration(tApsis - shipT)}` +
      (opts.capture !== false ? `, ${inward ? 'capture' : 'circularise'} Δv ${fmtSpeed(captureDv)}` : ''),
    warnings,
  );
  const hDir = normalOf(p.svStart);
  plan.encounter = { bodyId: T.id, periapsisRadius: p.periapsisRadius, periapsisTime: tApsis, inclination: Math.acos(clampN(hDir.y, -1, 1)) };
  return plan;
}

/**
 * Transfer from the ship's current orbit to another body, for the four topologies of a system:
 *
 *  - planet -> sibling planet (around the star) and moon -> sibling moon: a Lambert search between
 *    the two bodies in their parent's frame over departure window × time of flight (a coarse
 *    porkchop, then refinement) picks the transfer; the required velocity at the edge of the
 *    departure SOI is turned into an ejection burn on the parking orbit (burn point chosen so the
 *    outgoing leg lines up, normal component included);
 *  - planet -> its moon (the target orbits the body the ship orbits): a direct Lambert transfer;
 *  - moon -> its parent planet: an escape burn sized so that the orbit around the planet has its
 *    periapsis (or apoapsis, for a higher orbit) at the requested radius.
 *
 * In every case the departure node is then refined by shooting through {@link predictWithNodes}
 * until the predicted periapsis at the target matches the request (and, for the first three, the
 * arrival orbit lies as close to `planeNormal` as the approach allows). The plan holds the
 * departure node and the capture node at that periapsis (unless `capture: false`); `arrivalTime`
 * is the periapsis time. For sibling transfers, `nextWindow` reports a later departure that would
 * be much cheaper than leaving now.
 */
export function planTransferToBody(model: SystemModel, ship: TrajectoryStart, targetBodyId: string, opts: TransferOptions = {}): PlanResult {
  return guarded(() => {
    const s = settle(model, ship);
    if (typeof s === 'string') return fail(s);
    if (typeof targetBodyId !== 'string' || !model.hasBody(targetBodyId)) return fail('Unknown target body');
    const A = s.body;
    const T = model.body(targetBodyId);
    if (T.id === A.id) return fail(`Already in the sphere of influence of ${T.name}`);
    let rpDes = T.radius + Math.max(safeRadius(T) - T.radius, 0) + 0.05 * T.radius;
    if (Number.isFinite(opts.periapsisRadius)) rpDes = opts.periapsisRadius as number;
    else if (Number.isFinite(opts.periapsisAltitude)) rpDes = T.radius + (opts.periapsisAltitude as number);
    if (!(rpDes > T.radius)) return fail('The requested periapsis is below the surface');
    const nDes = opts.planeNormal && finiteV(opts.planeNormal) && vlen(opts.planeNormal) > 0 ? vnorm(opts.planeNormal) : { x: 0, y: 1, z: 0 };
    const parentA = model.parent(A.id);
    const parentT = model.parent(T.id);
    if (parentT && parentT.id === A.id) {
      if (!(rpDes < 0.9 * T.soi)) return fail(`The requested periapsis is outside the sphere of influence of ${T.name}`);
      return transferDirect(model, s, T, rpDes, nDes, opts, ship.t);
    }
    if (parentA && parentT && parentA.id === parentT.id) {
      if (!(rpDes < 0.9 * T.soi)) return fail(`The requested periapsis is outside the sphere of influence of ${T.name}`);
      return transferSibling(model, s, T, parentA, rpDes, nDes, opts, ship.t);
    }
    if (parentA && parentA.id === T.id) return transferToParent(model, s, T, rpDes, opts, ship.t);
    return fail(`No single transfer links ${A.name} and ${T.name}: go by way of ${parentA ? parentA.name : 'the star'}`);
  });
}

// ===================================================================================== mid-course correction

/** Options of {@link planCorrection}. */
export interface CorrectionOptions extends PlanOptions {
  /** Plane (its normal, system axes) the pass at the target should lie in, e.g. a station's orbit normal. Default: keep the current approach plane. */
  planeNormal?: V3;
  /** Sim time of the correction burn, s. Default: one lead time from now. */
  t?: number;
  /** How far ahead to look for the encounter, s from the burn. Default 120 days. */
  horizon?: number;
}

/**
 * Mid-course correction: one small burn (default: as soon as possible) after which the predicted
 * pass at `targetBodyId` has periapsis radius `periapsisRadius` (m) — and, if `opts.planeNormal` is
 * given, lies as close to that plane as the approach direction allows. `currentNodes` are the burns
 * already planned: those before the correction (and later ones outside the target's SOI) are flown
 * as planned; burns inside the target's SOI (a capture) are ignored and should be re-planned from
 * the corrected arrival. Found by the same shooting method as the transfers. `arrivalTime` is the
 * new periapsis time.
 */
export function planCorrection(
  model: SystemModel,
  ship: TrajectoryStart,
  currentNodes: readonly ManeuverNode[],
  targetBodyId: string,
  periapsisRadius: number,
  opts: CorrectionOptions = {},
): PlanResult {
  return guarded(() => {
    if (!ship || !finiteState(ship.sv) || !Number.isFinite(ship.t) || !model.hasBody(ship.bodyId)) return fail('Invalid ship state');
    if (typeof targetBodyId !== 'string' || !model.hasBody(targetBodyId)) return fail('Unknown target body');
    const T = model.body(targetBodyId);
    if (!(periapsisRadius > T.radius && periapsisRadius < Infinity)) return fail('The requested periapsis is below the surface');
    const tc = Math.max(Number.isFinite(opts.t) ? (opts.t as number) : ship.t + leadOf(opts), ship.t);
    const keep = (currentNodes ?? []).filter((n) => n && Number.isFinite(n.t) && (n.t < tc || n.bodyId !== T.id));
    const probe: ManeuverNode = { id: `correction@${Math.round(tc)}`, t: tc, bodyId: ship.bodyId, dv: { prograde: 0, normal: 0, radial: 0 } };
    const H = Number.isFinite(opts.horizon) && (opts.horizon as number) > 0 ? (opts.horizon as number) : 120 * DAY;
    const first = evalEncounter(model, ship, [...keep, probe], probe.id, T, periapsisRadius, { x: 0, y: 1, z: 0 }, tc + H);
    const at = first.pred ? first.pred.nodes.find((n) => n.node.id === probe.id) : undefined;
    if (!at || !at.reached) return fail('The trajectory ends before the correction burn');
    probe.bodyId = at.bodyId;
    if (!first.ok) return fail(`The current trajectory does not approach ${T.name}`);
    if (!(first.tPeri > tc)) return fail(`Closest approach to ${T.name} is already behind`);
    const nDes = opts.planeNormal && finiteV(opts.planeNormal) && vlen(opts.planeNormal) > 0 ? vnorm(opts.planeNormal) : first.hDir;
    const horizon = Math.min(tc + H, tc + 1.3 * (first.tPeri - tc) + 3600);
    const shot = shootEncounter(model, ship, keep, probe, T, periapsisRadius, nDes, horizon);
    const e = shot.enc;
    const close = e.ok && e.entered && Math.abs(e.rp - periapsisRadius) < 0.01 * periapsisRadius;
    if (!shot.converged && !close) return fail(`A single correction cannot bring the periapsis at ${T.name} to ${altText(T, periapsisRadius)}`);
    const warnings: string[] = [];
    if (!shot.converged) warnings.push(`The periapsis could only be refined to ${altText(T, e.rp)}`);
    if (T.atmosphere && periapsisRadius < T.radius + T.atmosphere.height) warnings.push('The periapsis is inside the atmosphere: expect drag and heating');
    const dv = nodeDvMagnitude(shot.node);
    const nodes = dv > 1e-6 ? [shot.node] : [];
    const plan = okPlan(
      ship.t,
      nodes,
      e.tPeri,
      nodes.length > 0
        ? `Correction burn in ${fmtDuration(tc - ship.t)}: Δv ${fmtSpeed(dv)} for a ${altText(T, e.rp)} periapsis at ${T.name}`
        : `No correction needed: periapsis ${altText(T, e.rp)} at ${T.name}`,
      warnings,
    );
    plan.encounter = { bodyId: T.id, periapsisRadius: e.rp, periapsisTime: e.tPeri, inclination: e.inc };
    return plan;
  });
}

// ===================================================================================== aerocapture

/** Options of {@link planAerocapture}. */
export interface AerocaptureOptions extends PlanOptions {
  /** Highest acceptable apoapsis radius after the pass, m from the centre. Default half the SOI radius (50 body radii for a body without one). */
  maxApoapsis?: number;
  /** Fraction of the vessel's heat capacity the pass may use, 0..1. Default 0.85. */
  heatMargin?: number;
}

/** Outcome of one simulated atmospheric pass (see simulatePass). */
interface PassOutcome {
  /** 'exit' = came back out above the atmosphere top; 'impact' = hit the surface; 'stuck' = still inside after the time limit. */
  kind: 'exit' | 'impact' | 'stuck';
  /** Highest stored heat during the pass, heat units (J-equivalent). */
  heatPeak: number;
  /** Apoapsis / periapsis radius of the conic after the pass (exit only; apoapsis Infinity when unbound), m. */
  apo: number;
  peri: number;
  /** Speed lost to drag (vacuum speed at the exit radius minus actual), m/s. */
  dvShed: number;
  /** Peak drag deceleration, m/s². */
  peakDecel: number;
  /** Duration of the pass, s. */
  duration: number;
}

/**
 * Fly one pass through the atmosphere of `body` on the conic with specific energy `eps` (J/kg) and
 * vacuum periapsis `rp` (m), from the top of the atmosphere until the ship leaves it again, hits the
 * surface or a time limit runs out. Same laws as physics.ts: gravity of the body, drag
 * ½·ρ·v²·dragArea against the (non-rotating) atmosphere, heating `aeroHeatingPower` against
 * `heatDissipation`. RK4 in the orbit plane with steps that shrink where density and drag change fast.
 */
function simulatePass(body: BodyDef, eps: number, rp: number, stats: Vessel['stats'], mass: number, heat0: number): PassOutcome {
  const mu = body.mu;
  const atm = body.atmosphere;
  const R = body.radius;
  const out: PassOutcome = { kind: 'stuck', heatPeak: heat0, apo: 0, peri: 0, dvShed: 0, peakDecel: 0, duration: 0 };
  if (!atm || !(mass > 0)) return out;
  const rTop = R + atm.height;
  const H = Math.max(1, atm.scaleHeight);
  const h = rp * Math.sqrt(Math.max(0, 2 * (eps + mu / rp)));
  const vTop = Math.sqrt(Math.max(0, 2 * (eps + mu / rTop)));
  const vt0 = h / rTop;
  let x = rTop;
  let y = 0;
  let vx = -Math.sqrt(Math.max(0, vTop * vTop - vt0 * vt0));
  let vy = vt0;
  const kD = (0.5 * Math.max(0, stats.dragArea)) / mass;
  let heat = heat0;
  const diss = Math.max(0, stats.heatDissipation);
  let ax = 0;
  let ay = 0;
  let aD = 0;
  const acc = (px: number, py: number, qx: number, qy: number): void => {
    const r2 = px * px + py * py;
    const r = Math.sqrt(r2);
    const g = -mu / (r2 * r);
    const rho = atmosphereDensity(body, r - R);
    const v = Math.sqrt(qx * qx + qy * qy);
    const d = kD * rho * v;
    aD = d * v;
    ax = g * px - d * qx;
    ay = g * py - d * qy;
  };
  let t = 0;
  const tMax = 6 * 3600;
  let wasInside = false;
  for (let step = 0; step < 40000 && t < tMax; step++) {
    const r = Math.sqrt(x * x + y * y);
    const v = Math.sqrt(vx * vx + vy * vy);
    const vr = (x * vx + y * vy) / r;
    if (r < R) {
      out.kind = 'impact';
      out.duration = t;
      return out;
    }
    if (r < rTop) wasInside = true;
    else if (wasInside && vr > 0) break;
    acc(x, y, vx, vy);
    const rho = atmosphereDensity(body, r - R);
    if (aD > out.peakDecel) out.peakDecel = aD;
    // Step: resolve the density gradient along the radial motion and the drag time scale.
    let dt = Math.min(2, (0.04 * H) / Math.max(Math.abs(vr), 1), aD > 0 ? (0.02 * v) / aD : 2);
    if (dt < 0.005) dt = 0.005;
    // RK4.
    const a1x = ax;
    const a1y = ay;
    const hh = 0.5 * dt;
    acc(x + vx * hh, y + vy * hh, vx + a1x * hh, vy + a1y * hh);
    const a2x = ax;
    const a2y = ay;
    const v2x = vx + a1x * hh;
    const v2y = vy + a1y * hh;
    acc(x + v2x * hh, y + v2y * hh, vx + a2x * hh, vy + a2y * hh);
    const a3x = ax;
    const a3y = ay;
    const v3x = vx + a2x * hh;
    const v3y = vy + a2y * hh;
    acc(x + v3x * dt, y + v3y * dt, vx + a3x * dt, vy + a3y * dt);
    const a4x = ax;
    const a4y = ay;
    const v4x = vx + a3x * dt;
    const v4y = vy + a3y * dt;
    x += (dt / 6) * (vx + 2 * v2x + 2 * v3x + v4x);
    y += (dt / 6) * (vy + 2 * v2y + 2 * v3y + v4y);
    vx += (dt / 6) * (a1x + 2 * a2x + 2 * a3x + a4x);
    vy += (dt / 6) * (a1y + 2 * a2y + 2 * a3y + a4y);
    // Heat (trapezoidal in the heating power).
    const r1 = Math.sqrt(x * x + y * y);
    const p0 = aeroHeatingPower(stats, rho, v);
    const p1 = aeroHeatingPower(stats, atmosphereDensity(body, r1 - R), Math.sqrt(vx * vx + vy * vy));
    heat += (0.5 * (p0 + p1) - diss) * dt;
    if (heat < 0) heat = 0;
    if (heat > out.heatPeak) out.heatPeak = heat;
    t += dt;
  }
  out.duration = t;
  const r = Math.sqrt(x * x + y * y);
  if (!(r >= rTop) || !wasInside) return out;
  out.kind = 'exit';
  const v2 = vx * vx + vy * vy;
  const e2 = 0.5 * v2 - mu / r;
  const hz = x * vy - y * vx;
  const p = (hz * hz) / mu;
  const e = Math.sqrt(Math.max(0, 1 + (2 * e2 * hz * hz) / (mu * mu)));
  out.peri = p / (1 + e);
  out.apo = e < 1 ? p / (1 - e) : Infinity;
  out.dvShed = Math.sqrt(Math.max(0, 2 * (eps + mu / r))) - Math.sqrt(v2);
  return out;
}

/**
 * Aerocapture: the vacuum-periapsis radius at `bodyId` (which must have an atmosphere) for which one
 * pass through the atmosphere sheds enough speed to end bound (apoapsis below `maxApoapsis`) without
 * the vessel's stored heat exceeding `heatMargin` of its heat capacity. `vessel` is the ship as the
 * physics module holds it and `t` the sim time (s) of its state; it must be inside the body's SOI or
 * on a predicted course into it.
 *
 * Each candidate pass is integrated with the physics.ts atmosphere laws (gravity, drag, heating and
 * radiative dissipation; the atmosphere is non-rotating, as in physics.ts). The corridor between the
 * shallowest periapsis that still captures and the deepest that neither overheats nor fails to come
 * back out is found by bisection, and the middle of it is recommended. If the current trajectory
 * misses that periapsis, the plan holds one correction node found by {@link planCorrection}.
 * `aerocapture` in the result describes the pass; after it, raise the periapsis out of the
 * atmosphere at the first apoapsis (`raiseDv` m/s, to be re-planned once the pass is flown).
 * Returns {ok: false} when no corridor exists (too hot, or not enough air to slow down).
 */
export function planAerocapture(model: SystemModel, vessel: Vessel, bodyId: string, t: number, opts: AerocaptureOptions = {}): PlanResult {
  return guarded(() => {
    if (!vessel || !vessel.stats || !Number.isFinite(t)) return fail('Invalid vessel');
    if (typeof bodyId !== 'string' || !model.hasBody(bodyId)) return fail('Unknown target body');
    const B = model.body(bodyId);
    const atm = B.atmosphere;
    if (!atm || !(atm.height > 0) || !(atm.surfaceDensity > 0)) return fail(`${B.name} has no atmosphere to brake in`);
    if (!model.hasBody(vessel.soiBodyId)) return fail('Unknown reference body');
    const ship = shipFromVessel(vessel, t);
    if (!finiteState(ship.sv)) return fail('Invalid vessel state');
    // The arrival conic inside B's SOI.
    const pred = predictTrajectory(model, ship, { maxPatches: 6, maxDuration: 200 * DAY, searchPeriods: 1, stopAtAtmosphere: false });
    const arr = pred.find((p) => p.bodyId === B.id);
    if (!arr) return fail(`The current trajectory does not reach ${B.name}`);
    const infoA = orbitInfo(arr.svStart, B.mu, arr.tStart);
    const eps = infoA.energy;
    const mass = totalMass(vessel);
    const cap = Math.max(1, vessel.stats.heatCapacity);
    const margin = clampN(Number.isFinite(opts.heatMargin) ? (opts.heatMargin as number) : 0.85, 0.05, 1);
    const heatLimit = margin * cap;
    const heat0 = Math.max(0, Number.isFinite(vessel.heat) ? vessel.heat : 0);
    if (heat0 >= heatLimit) return fail('The hull is already too hot for an atmospheric pass');
    const rTop = B.radius + atm.height;
    const hasSoi = B.soi < Infinity;
    let maxApo = Number.isFinite(opts.maxApoapsis) && (opts.maxApoapsis as number) > rTop ? (opts.maxApoapsis as number) : hasSoi ? 0.5 * B.soi : 50 * B.radius;
    if (hasSoi) maxApo = Math.min(maxApo, 0.9 * B.soi);
    if (infoA.closed && infoA.apoapsis <= maxApo && infoA.periapsis > rTop) return fail('Already captured: no aerocapture needed');
    const captures = (o: PassOutcome): boolean => o.kind !== 'exit' || o.apo <= maxApo;
    const bad = (o: PassOutcome): boolean => o.kind !== 'exit' || o.heatPeak > heatLimit;
    const sim = (rp: number): PassOutcome => simulatePass(B, eps, rp, vessel.stats, mass, heat0);
    const rLo = B.radius + 1;
    const rHi = rTop - 1;
    // 1. Shallow edge: the highest periapsis that still captures (deeper passes shed more).
    if (!captures(sim(rLo))) return fail(`Even a grazing pass through the atmosphere of ${B.name} cannot shed enough speed`);
    let shallow: number;
    if (captures(sim(rHi))) shallow = rHi;
    else {
      let a = rLo;
      let b = rHi;
      for (let i = 0; i < 40 && b - a > 1; i++) {
        const m = 0.5 * (a + b);
        if (captures(sim(m))) a = m;
        else b = m;
      }
      shallow = a;
    }
    // 2. Deep edge: the lowest periapsis that comes out without overheating.
    const atShallow = sim(shallow);
    if (bad(atShallow)) {
      return fail(atShallow.kind === 'exit' ? `A pass deep enough to capture at ${B.name} would overheat the hull` : `A pass deep enough to capture at ${B.name} would not come back out`);
    }
    let deep: number;
    if (!bad(sim(rLo))) deep = rLo;
    else {
      let a = rLo;
      let b = shallow;
      for (let i = 0; i < 40 && b - a > 1; i++) {
        const m = 0.5 * (a + b);
        if (bad(sim(m))) a = m;
        else b = m;
      }
      deep = b;
    }
    const width = shallow - deep;
    const rpRec = deep + 0.5 * width;
    const pass = sim(rpRec);
    if (bad(pass) || !captures(pass)) return fail(`No safe aerocapture corridor at ${B.name}`);
    const warnings: string[] = [];
    if (width < 2000) warnings.push(`The corridor is only ${fmtDistance(width)} wide: fly the approach precisely`);
    // Correction burn toward the recommended periapsis if the current pass misses it.
    const nodes: ManeuverNode[] = [];
    const tol = Math.max(200, 0.15 * width);
    if (Math.abs(arr.periapsisRadius - rpRec) > tol) {
      const corr = planCorrection(model, ship, [], B.id, rpRec, { leadTime: opts.leadTime });
      if (corr.ok) for (const n of corr.nodes) nodes.push(n);
      else warnings.push(`Bring the periapsis to ${altText(B, rpRec)} before arrival: ${corr.reason}`);
    }
    // Entry time on the (corrected) arrival conic.
    const pr2 = predictWithNodes(model, ship, nodes, { maxPatches: 6, maxDuration: 200 * DAY, searchPeriods: 1, stopAtAtmosphere: false });
    let entryTime = arr.tStart;
    for (const p of pr2.patches) {
      if (p.bodyId !== B.id || p.tEnd < (nodes.length ? nodes[nodes.length - 1].t : -Infinity)) continue;
      const dtIn = timeToRadius(p.svStart, B.mu, rTop, 'inward');
      if (dtIn < Infinity) entryTime = p.tStart + dtIn;
      break;
    }
    const rSafe = safeRadius(B);
    const raiseDv =
      pass.apo < Infinity && pass.apo > rSafe
        ? Math.sqrt(B.mu * (2 / pass.apo - 2 / (pass.apo + rSafe))) - Math.sqrt(B.mu * (2 / pass.apo - 2 / (pass.apo + pass.peri)))
        : 0;
    if (pass.apo < rSafe) warnings.push('The orbit after the pass stays low: raise it at once');
    warnings.push(`After the pass, raise the periapsis at apoapsis (about ${fmtSpeed(raiseDv)})`);
    const plan = okPlan(
      ship.t,
      nodes,
      entryTime + pass.duration,
      `Aerocapture at ${B.name}: periapsis ${altText(B, rpRec)} (corridor ${altText(B, deep)}–${altText(B, shallow)}), sheds ${fmtSpeed(pass.dvShed)}, peak heat ${Math.round((100 * pass.heatPeak) / cap)} %` +
        (nodes.length ? `; correction Δv ${fmtSpeed(nodeDvMagnitude(nodes[0]))}` : ''),
      warnings,
    );
    plan.aerocapture = {
      periapsisRadius: rpRec,
      periapsisAltitude: rpRec - B.radius,
      corridor: { shallow: shallow - B.radius, deep: deep - B.radius },
      peakHeatFraction: pass.heatPeak / cap,
      exitApoapsis: pass.apo,
      dvShed: pass.dvShed,
      peakDecel: pass.peakDecel,
      entryTime,
      raiseDv,
    };
    return plan;
  });
}

// ===================================================================================== stations

/** Bodies from `id` up to the primary, `id` first. */
function chainOf(model: SystemModel, id: string): string[] {
  const out: string[] = [];
  let cur: BodyDef | null = model.body(id);
  while (cur) {
    out.push(cur.id);
    cur = model.parent(cur.id);
  }
  return out;
}

/** Next body to head for on the way from SOI body `from` to `to` (same as `to` for a single hop), or null if from === to. */
function nextHop(model: SystemModel, from: string, to: string): { hop: string; kind: 'down' | 'up' | 'sibling' } | null {
  if (from === to) return null;
  const cf = chainOf(model, from);
  const ct = chainOf(model, to);
  const lca = ct.find((b) => cf.includes(b)) as string;
  if (lca === from) return { hop: ct[ct.indexOf(lca) - 1], kind: 'down' };
  const pf = cf[1];
  if (pf === lca) return lca === to ? { hop: to, kind: 'up' } : { hop: ct[ct.indexOf(lca) - 1], kind: 'sibling' };
  return { hop: pf, kind: 'up' };
}

/** Options of {@link planToStation}. */
export interface ToStationOptions extends RendezvousOptions {
  /** See {@link TransferOptions.window}. */
  window?: 'now' | 'best';
}

/**
 * Top-level convenience: plan the next leg of a trip to `station`.
 *
 *  - Station around the ship's SOI body: {@link planRendezvous}; `phases` is empty.
 *  - Station around another body: {@link planTransferToBody} toward it with the periapsis at the
 *    station's orbital radius and the arrival in the station's orbital plane, captured into a
 *    circular orbit there; `phases` = ['rendezvous'].
 *  - Station more than one hop away (e.g. a moon of another planet): the first hop only — to the
 *    body on the way, captured low (or near the orbit of the next body) — and `phases` lists what
 *    remains ('transfer' = another call of this function, which also captures; then 'rendezvous').
 */
export function planToStation(model: SystemModel, ship: TrajectoryStart, station: StationDef | string, opts: ToStationOptions = {}): PlanResult {
  return guarded(() => {
    const st = typeof station === 'string' ? model.station(station) : station;
    if (!st || !st.orbit || !model.hasBody(st.parentBodyId)) return fail('Unknown station');
    const s = settle(model, ship);
    if (typeof s === 'string') return fail(s);
    const here = s.body.id;
    const hop = nextHop(model, here, st.parentBodyId);
    if (!hop) {
      const r = planRendezvous(model, s.ship, st.orbit, opts);
      if (r.ok) {
        r.phases = [];
        r.summary = `${st.name}: ${r.summary}`;
      }
      return r;
    }
    const T = model.body(hop.hop);
    const final = T.id === st.parentBodyId;
    const nSt = orbitNormalFromElements(st.orbit);
    let rp: number;
    let planeNormal: V3 | undefined;
    if (final) {
      rp = Math.max(st.orbit.a * (1 - st.orbit.e), T.radius + 1);
      planeNormal = nSt;
    } else {
      // Intermediate body: park where the next leg starts cheaply.
      const nxt = nextHop(model, T.id, st.parentBodyId);
      const child = nxt && nxt.kind === 'down' ? model.body(nxt.hop) : null;
      const low = safeRadius(T) + 0.05 * T.radius;
      rp = child && child.orbit ? Math.max(low, 0.5 * Math.abs(child.orbit.a)) : low;
      if (hop.kind === 'up') {
        const A = s.body;
        const rA = A.orbit ? Math.abs(A.orbit.a) : rp;
        if (Math.abs(rp - rA) < 2 * A.soi) rp = Math.max(low, rA - 3 * A.soi);
      }
    }
    const r = planTransferToBody(model, s.ship, T.id, { periapsisRadius: rp, planeNormal, leadTime: opts.leadTime, window: opts.window });
    if (!r.ok) return r;
    const captured = r.nodes.length > 1;
    r.phases = final ? (captured ? ['rendezvous'] : ['capture', 'rendezvous']) : captured ? ['transfer', 'rendezvous'] : ['capture', 'transfer', 'rendezvous'];
    r.summary = `${st.name}: ${r.summary}`;
    return r;
  });
}

// ===================================================================================== rough travel estimates

/** Result of {@link estimateTravel}. */
export type TravelEstimate =
  | {
      ok: true;
      /** Rough total Δv, m/s (impulsive, Hohmann-class transfers; plane changes included). */
      dv: number;
      /** Rough trip time from `t`, s, including the wait for each transfer window. */
      duration: number;
      /** One entry per hop. */
      legs: { from: string; to: string; dv: number; wait: number; tof: number }[];
      summary: string;
    }
  | { ok: false; reason: string };

/** Radius, speed, unit normal and absolute-frame-free position of a circular-ish orbiter about `bodyId` at time t. */
interface Parking {
  bodyId: string;
  r: number;
  normal: V3;
  /** Current position relative to the body (for phasing). */
  pos: V3;
}

/** Wait (s) until the phase angle between two co-planar circular orbits is right for a Hohmann transfer from r1 to r2 taking `tof`. */
function hohmannWait(mu: number, pos1: V3, r1: number, pos2: V3, r2: number, normal: V3, tof: number): number {
  const n1 = Math.sqrt(mu / (r1 * r1 * r1));
  const n2 = Math.sqrt(mu / (r2 * r2 * r2));
  const dn = n1 - n2;
  if (!(Math.abs(dn) > 1e-15)) return 0;
  const want = PI - n2 * tof;
  const p1 = vnorm(vsub(pos1, vscale(normal, vdot(pos1, normal))));
  const p2 = vnorm(vsub(pos2, vscale(normal, vdot(pos2, normal))));
  const cur = Math.atan2(vdot(vcross(p1, p2), normal), vdot(p1, p2));
  // phase(t) = cur - dn·t; want phase = want (mod 2π).
  const dt = dn > 0 ? wrapTau(cur - want) / dn : wrapTau(want - cur) / -dn;
  return Number.isFinite(dt) && dt >= 0 ? dt : 0;
}

/**
 * Fast rough estimate of the Δv and time of a trip to a station, for mission deadlines and trade
 * planning: no Lambert search and no refinement, just Hohmann-class patched conics between circular
 * orbits along the chain of bodies (escape / capture burns from v∞, plane changes at the slow end,
 * and the wait for each transfer window from the current phases). `from` is a station id (the ship
 * docked there) or a ship state; `t` the sim time, s. Typically good to 10–30 % against the real
 * planners; never throws.
 */
export function estimateTravel(model: SystemModel, from: string | TrajectoryStart, toStationId: string, t: number): TravelEstimate {
  try {
    if (!Number.isFinite(t)) return { ok: false, reason: 'Invalid time' };
    const dst = model.station(toStationId);
    let start: Parking;
    if (typeof from === 'string') {
      const st = model.station(from);
      const sv = model.stationState(st.id, t);
      start = { bodyId: st.parentBodyId, r: vlen(sv.r), normal: normalOf(sv), pos: sv.r };
    } else {
      const s = settle(model, from);
      if (typeof s === 'string') return { ok: false, reason: s };
      const r = s.info.closed ? s.info.a : vlen(s.ship.sv.r);
      start = { bodyId: s.body.id, r: Math.max(r, s.body.radius), normal: normalOf(s.ship.sv), pos: s.ship.sv.r };
    }
    const dsv = model.stationState(dst.id, t);
    const goal: Parking = { bodyId: dst.parentBodyId, r: vlen(dsv.r), normal: normalOf(dsv), pos: dsv.r };
    const legs: { from: string; to: string; dv: number; wait: number; tof: number }[] = [];
    let cur = start;
    let tc = t;
    const circ = (mu: number, r: number): number => Math.sqrt(mu / r);
    const planeDv = (v: number, n1: V3, n2: V3): number => 2 * v * Math.sin(0.5 * Math.atan2(vlen(vcross(n1, n2)), vdot(n1, n2)));
    for (let guard = 0; guard < 8; guard++) {
      const hop = nextHop(model, cur.bodyId, goal.bodyId);
      const A = model.body(cur.bodyId);
      if (!hop) {
        // Same body: Hohmann between the radii, plane change at the higher (slower) end, wait for phasing.
        const h = orbitHohmann(A.mu, cur.r, goal.r);
        const vSlow = circ(A.mu, Math.max(cur.r, goal.r));
        const dPlane = planeDv(vSlow, cur.normal, goal.normal);
        const dv = h.dv1 + Math.sqrt(h.dv2 * h.dv2 + dPlane * dPlane);
        const gPos = model.stationState(dst.id, tc).r;
        const wait = Math.abs(cur.r - goal.r) < 1e-3 * goal.r ? 0.5 * orbitalPeriod(A.mu, goal.r) : hohmannWait(A.mu, cur.pos, cur.r, gPos, goal.r, cur.normal, h.tof);
        legs.push({ from: A.id, to: dst.id, dv, wait, tof: h.tof });
        tc += wait + h.tof;
        break;
      }
      const T = model.body(hop.hop);
      const final = T.id === goal.bodyId;
      const rArr = final ? goal.r : safeRadius(T) + 0.05 * T.radius;
      if (hop.kind === 'down') {
        // Planet -> moon: Hohmann in A's frame to the moon's orbit, capture at the moon.
        const aT = Math.abs(T.orbit ? T.orbit.a : cur.r);
        const h = orbitHohmann(A.mu, cur.r, aT);
        const vInf = Math.abs(h.dv2);
        const cap = Math.sqrt(vInf * vInf + (2 * T.mu) / rArr) - circ(T.mu, rArr);
        const nT = T.orbit ? orbitNormalFromElements(T.orbit) : cur.normal;
        const dPlane = planeDv(circ(A.mu, Math.max(cur.r, aT)), cur.normal, nT);
        const tPos = model.bodyState(T.id, tc).r;
        const wait = hohmannWait(A.mu, cur.pos, cur.r, tPos, aT, cur.normal, h.tof);
        legs.push({ from: A.id, to: T.id, dv: Math.abs(h.dv1) + cap + dPlane, wait, tof: h.tof });
        tc += wait + h.tof;
        cur = { bodyId: T.id, r: rArr, normal: final ? goal.normal : nT, pos: { x: rArr, y: 0, z: 0 } };
        if (final) {
          cur.pos = model.stationState(dst.id, tc).r;
          break;
        }
        continue;
      }
      const C = hop.kind === 'up' ? T : (model.parent(A.id) as BodyDef);
      const aA = Math.abs(A.orbit ? A.orbit.a : 0);
      if (hop.kind === 'up') {
        // Moon -> parent: escape to an orbit around the parent with its far apsis at rArr, then circularise.
        const h = orbitHohmann(C.mu, aA, rArr);
        const vInf = Math.abs(h.dv1);
        const esc = Math.sqrt(vInf * vInf + (2 * A.mu) / cur.r) - circ(A.mu, cur.r);
        legs.push({ from: A.id, to: C.id, dv: esc + Math.abs(h.dv2), wait: 0.5 * orbitalPeriod(A.mu, cur.r), tof: h.tof });
        tc += 0.5 * orbitalPeriod(A.mu, cur.r) + h.tof;
        cur = { bodyId: C.id, r: rArr, normal: A.orbit ? orbitNormalFromElements(A.orbit) : cur.normal, pos: model.bodyState(A.id, tc).r };
        continue; // if the station is around C, the next round is the same-body leg
      }
      // Sibling: Hohmann between the two bodies' orbits in C's frame, escape and capture from v∞.
      const aT = Math.abs(T.orbit ? T.orbit.a : aA);
      const h = orbitHohmann(C.mu, aA, aT);
      const esc = Math.sqrt(h.dv1 * h.dv1 + (2 * A.mu) / cur.r) - circ(A.mu, cur.r);
      const cap = Math.sqrt(h.dv2 * h.dv2 + (2 * T.mu) / rArr) - circ(T.mu, rArr);
      const nA = A.orbit ? orbitNormalFromElements(A.orbit) : cur.normal;
      const nT = T.orbit ? orbitNormalFromElements(T.orbit) : nA;
      const dPlane = planeDv(circ(C.mu, Math.max(aA, aT)), nA, nT);
      const wait = hohmannWait(C.mu, model.bodyState(A.id, tc).r, aA, model.bodyState(T.id, tc).r, aT, nA, h.tof);
      legs.push({ from: A.id, to: T.id, dv: esc + cap + dPlane, wait, tof: h.tof });
      tc += wait + h.tof;
      cur = { bodyId: T.id, r: rArr, normal: final ? goal.normal : nT, pos: { x: rArr, y: 0, z: 0 } };
      if (final) {
        cur.pos = model.stationState(dst.id, tc).r;
        break;
      }
    }
    // Arrived around the station's body: if not already on its orbit, a final in-body rendezvous estimate.
    const last = legs[legs.length - 1];
    if (!last || last.to !== dst.id) {
      const A = model.body(cur.bodyId);
      if (cur.bodyId === goal.bodyId && Math.abs(cur.r - goal.r) > 1e-3 * goal.r) {
        const h = orbitHohmann(A.mu, cur.r, goal.r);
        legs.push({ from: A.id, to: dst.id, dv: h.dvTotal, wait: 0.5 * orbitalPeriod(A.mu, Math.max(cur.r, goal.r)), tof: h.tof });
        tc += 0.5 * orbitalPeriod(A.mu, Math.max(cur.r, goal.r)) + h.tof;
      } else {
        const ph = 0.5 * orbitalPeriod(A.mu, goal.r);
        legs.push({ from: A.id, to: dst.id, dv: 0.02 * circ(A.mu, goal.r), wait: ph, tof: ph });
        tc += 2 * ph;
      }
    }
    let dv = 0;
    for (const l of legs) dv += l.dv;
    const duration = tc - t;
    if (!Number.isFinite(dv) || !Number.isFinite(duration)) return { ok: false, reason: 'No estimate possible' };
    return { ok: true, dv, duration, legs, summary: `About ${fmtSpeed(dv)} and ${fmtDuration(duration)} to ${dst.name}` };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'No estimate possible' };
  }
}

/** Hohmann numbers between circular radii (thin wrapper so a zero radius cannot produce NaN). */
function orbitHohmann(mu: number, r1: number, r2: number): { dv1: number; dv2: number; dvTotal: number; tof: number } {
  const a = Math.max(r1, 1);
  const b = Math.max(r2, 1);
  const aT = 0.5 * (a + b);
  const dv1 = Math.sqrt(mu * (2 / a - 1 / aT)) - Math.sqrt(mu / a);
  const dv2 = Math.sqrt(mu / b) - Math.sqrt(mu * (2 / b - 1 / aT));
  return { dv1, dv2, dvTotal: Math.abs(dv1) + Math.abs(dv2), tof: PI * Math.sqrt((aT * aT * aT) / mu) };
}
