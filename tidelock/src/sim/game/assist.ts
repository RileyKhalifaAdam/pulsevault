// The flight computer of the first playable build: simple and robust rather than clever.
//  - planRoute: a verified plan to the target (planner first, own Hohmann-with-phasing as the fallback);
//  - a node executor: turn to the burn vector, wait, burn with a taper, cut on delivered delta-v;
//  - goToStation: plan, fly the plan, hand over to the station tug, re-plan (twice at most) on a miss.
// State lives in GameState.assist (plain JSON). The Game calls assistFrame once per frame and assistThrottle
// before every physics step.

import type { StationDef, V3 } from '../../core/types';
import { TAU, clamp, cross, len, norm, sub, wrapPi, wrapTau } from '../../core/vec';
import type { AutopilotCommand } from '../autopilot';
import { closestApproach, newState, orbitInfo, orbitNormal, orbitalPeriod, phaseAngle, propagateStateTo, relativeInclination, type SystemModel, type TrajectoryStart } from '../orbit';
import { WARP_LEVELS, currentAccel, pointingError, setSasMode } from '../physics';
import {
  applyNode,
  dvToNodeComponents,
  makeNode,
  planCircularize,
  planMatchPlane,
  planRendezvous,
  planReturnToSafeOrbit,
  planToStation,
  planTransferToBody,
  predictWithNodes,
  shipFromVessel,
  type ManeuverNode,
  type PlanResult,
} from '../planner';
import type { ActionResult, PlanKind } from './api';
import type { Game } from './sim';
import { SLEW_LEAD, TUG_RANGE, TUG_SPEED, newAssist } from './state';

// ------------------------------------------------------------------------------------------------ text

export function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '--';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 86400)}d ${String(Math.floor((s % 86400) / 3600)).padStart(2, '0')}h`;
}

export function fmtDistance(m: number): string {
  if (!Number.isFinite(m)) return '--';
  const a = Math.abs(m);
  if (a < 1000) return `${Math.round(m)} m`;
  if (a < 1e5) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

const fmtSpeed = (v: number): string => (Math.abs(v) < 1000 ? `${Math.round(v)} m/s` : `${(v / 1000).toFixed(2)} km/s`);

const fail = (reason: string): PlanResult => ({ ok: false, reason });

// ------------------------------------------------------------------------------------------------ planning

/**
 * Closest pass of `st` (m) on the predicted path after the last node of `nodes`, within about half a
 * station orbit; Infinity when the plan cannot be flown as predicted.
 */
export function verifyPlan(model: SystemModel, ship: TrajectoryStart, nodes: readonly ManeuverNode[], st: StationDef): number {
  if (nodes.length === 0) return Infinity;
  const pred = predictWithNodes(model, ship, nodes, { maxPatches: 1, maxDuration: 1 });
  const last = pred.nodes[pred.nodes.length - 1];
  if (!pred.complete || !last || !last.reached || last.bodyId !== st.parentBodyId) return Infinity;
  const mu = model.body(st.parentBodyId).mu;
  const tL = last.node.t;
  const target = model.stationState(st.id, tL);
  const ca = closestApproach(last.after, target, mu, tL, tL + 0.6 * orbitalPeriod(mu, st.orbit.a), { maxSamples: 600 });
  return Number.isFinite(ca.distance) ? ca.distance : Infinity;
}

/**
 * Hohmann transfer with phasing between near-circular, near-coplanar orbits around the same body: wait for
 * the phase angle, burn onto the transfer ellipse, coast half of it, match the station's velocity.
 */
export function hohmannPlan(model: SystemModel, ship: TrajectoryStart, st: StationDef): PlanResult {
  if (st.parentBodyId !== ship.bodyId) return fail('The flight computer cannot plot that route yet.');
  const body = model.body(ship.bodyId);
  const mu = body.mu;
  const info = orbitInfo(ship.sv, mu, ship.t);
  if (!info.closed || info.e > 0.05) return fail('Circularise your orbit first: the flight computer needs a near-circular orbit.');
  if (st.orbit.e > 0.02) return fail('The flight computer cannot plot that route yet.');
  const tgt0 = model.stationState(st.id, ship.t);
  if (relativeInclination(ship.sv, tgt0) > 0.02) return fail(`Match planes with ${st.name} first.`);
  const r1 = info.a;
  const r2 = st.orbit.a;
  if (Math.abs(r2 - r1) < 0.01 * r1) return fail(`${st.name} shares your orbit: change altitude a little to catch up with it.`);
  const n1 = Math.sqrt(mu / (r1 * r1 * r1));
  const n2 = Math.sqrt(mu / (r2 * r2 * r2));
  const rate = n2 - n1;
  const normal = orbitNormal(ship.sv);
  const phi0 = phaseAngle(ship.sv.r, tgt0.r, normal);
  const dep = newState();
  let aT = 0.5 * (r1 + r2);
  let tof = Math.PI * Math.sqrt((aT * aT * aT) / mu);
  let rd = r1;
  const tgt = newState();
  const synodic = TAU / Math.abs(rate);
  // First guess from the mean motions, then Newton on the real geometry (the ship's orbit is only nearly circular):
  // the station must be opposite the departure point when the ship gets there.
  let wait = wrapTau((wrapPi(Math.PI - n2 * tof) - phi0) * Math.sign(rate)) / Math.abs(rate);
  if (wait < 40) wait += synodic;
  for (let i = 0; i < 8; i++) {
    propagateStateTo(dep, ship.sv, mu, wait);
    rd = len(dep.r);
    aT = 0.5 * (rd + r2);
    tof = Math.PI * Math.sqrt((aT * aT * aT) / mu);
    model.stationState(st.id, ship.t + wait + tof, tgt);
    const err = wrapPi(phaseAngle(dep.r, tgt.r, normal) - Math.PI);
    wait -= err / rate;
    if (wait < 40) wait += synodic;
    if (Math.abs(err) < 1e-7) break;
  }
  propagateStateTo(dep, ship.sv, mu, wait);
  rd = len(dep.r);
  aT = 0.5 * (rd + r2);
  tof = Math.PI * Math.sqrt((aT * aT * aT) / mu);
  const tDep = ship.t + wait;
  const tang = norm(cross(normal, dep.r));
  const vT = Math.sqrt(mu * (2 / rd - 1 / aT));
  const dv1: V3 = { x: tang.x * vT - dep.v.x, y: tang.y * vT - dep.v.y, z: tang.z * vT - dep.v.z };
  const node1 = makeNode('hohmann-depart', tDep, body.id, dep, dv1);
  const arr = propagateStateTo(newState(), applyNode(dep, node1), mu, tof);
  const tArr = tDep + tof;
  const stArr = model.stationState(st.id, tArr);
  const dv2 = sub(stArr.v, arr.v);
  const node2 = makeNode('match-velocity', tArr, body.id, arr, dv2);
  const a = len(dv1);
  const b = len(dv2);
  return {
    ok: true,
    nodes: [node1, node2],
    totalDv: a + b,
    arrivalTime: tArr,
    duration: tArr - ship.t,
    summary: `${st.name}: Hohmann transfer, burn in ${fmtDuration(wait)} (Δv ${fmtSpeed(a)}), match velocity ${fmtDuration(tArr - ship.t)} from now (Δv ${fmtSpeed(b)})`,
    warnings: [],
  };
}

const CANNOT = 'The flight computer cannot plot that route yet.';

/** A plan for `kind` from the ship's present state. Never throws. */
export function planRoute(g: Game, kind: PlanKind): PlanResult {
  const s = g.state;
  const model = g.model;
  const ship = shipFromVessel(s.vessel, s.time);
  try {
    switch (kind) {
      case 'circularizeAtPeriapsis':
        return planCircularize(model, ship, 'periapsis');
      case 'circularizeAtApoapsis':
        return planCircularize(model, ship, 'apoapsis');
      case 'returnToSafeOrbit':
        return planReturnToSafeOrbit(model, ship);
      case 'matchPlane': {
        const t = s.target;
        if (!t) return fail('Select a target first.');
        if (t.kind === 'station') {
          const st = g.stationDef(t.id);
          if (!st || st.parentBodyId !== ship.bodyId) return fail('The target orbits another body.');
          return planMatchPlane(model, ship, st.orbit);
        }
        if (t.kind === 'body') {
          const b = model.hasBody(t.id) ? model.body(t.id) : null;
          if (!b || !b.orbit || b.parentId !== ship.bodyId) return fail('The target orbits another body.');
          return planMatchPlane(model, ship, b.orbit);
        }
        return fail(CANNOT);
      }
      case 'toTarget': {
        const t = s.target;
        if (!t) return fail('Select a destination first.');
        if (t.kind === 'body') {
          if (t.id === ship.bodyId) return fail(`You are already orbiting ${model.body(t.id).name}.`);
          return planTransferToBody(model, ship, t.id);
        }
        if (t.kind === 'site') {
          const site = g.system.miningSites.find((m) => m.id === t.id);
          if (!site || site.parentBodyId !== ship.bodyId) return fail(CANNOT);
          return planRendezvous(model, ship, site.orbit);
        }
        const st = g.stationDef(t.id);
        if (!st) return fail('Unknown station.');
        if (st.parentBodyId !== ship.bodyId) {
          let r: PlanResult;
          try {
            r = planToStation(model, ship, st);
          } catch {
            r = fail(CANNOT);
          }
          if (r.ok && r.nodes.length > 0) {
            const pred = predictWithNodes(model, ship, r.nodes, { maxPatches: 4 });
            if (pred.complete && pred.patches.some((p) => p.bodyId === st.parentBodyId)) return r;
          }
          return fail(CANNOT);
        }
        let r: PlanResult;
        try {
          r = planToStation(model, ship, st);
        } catch {
          r = fail('The route planner faulted.');
        }
        if (r.ok && (r.nodes.length === 0 || verifyPlan(model, ship, r.nodes, st) < 20e3)) return r;
        const h = hohmannPlan(model, ship, st);
        if (h.ok) {
          if (verifyPlan(model, ship, h.nodes, st) < 20e3) return h;
          return fail(`No safe route to ${st.name} was found.`);
        }
        return r.ok ? h : fail(r.reason.length > 0 ? r.reason : h.reason);
      }
      default:
        return fail('Unknown plan.');
    }
  } catch (err) {
    return fail(`The flight computer faulted: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ------------------------------------------------------------------------------------------------ state machine

function announce(g: Game): void {
  const a = g.state.assist;
  g.events.emit('autopilotChanged', { engaged: a.mode !== 'idle', mode: a.mode, phase: a.phase, failed: a.failed });
}

function setPhase(g: Game, phase: string): void {
  const a = g.state.assist;
  if (a.phase === phase) return;
  a.phase = phase;
  announce(g);
}

function stop(g: Game, failed: string | null): void {
  const s = g.state;
  const a = s.assist;
  if (a.mode === 'idle') return;
  if (a.phase === 'burn' || s.vessel.controls.throttle > 0) g.cutThrottle();
  a.mode = 'idle';
  a.phase = '';
  a.status = '';
  a.nodeId = null;
  a.dv = null;
  a.failed = failed;
  s.warp.requested = 0;
  if (!s.vessel.destroyed && s.vessel.dockedAt === null) setSasMode(s.vessel, 'stability');
  announce(g);
  if (failed) g.toast(`Flight computer: ${failed}`, 'warn');
}

/** Disengage without a failure (manual input, a new command, the player's choice). */
export function assistDisengage(g: Game): void {
  stop(g, null);
}

export function assistFail(g: Game, reason: string): void {
  stop(g, reason);
}

function inTugRange(g: Game, st: StationDef): boolean {
  const d = g.relStation(st);
  return d < TUG_RANGE * 0.98 && g.relSpeed() < TUG_SPEED * 0.98 && st.parentBodyId === g.state.vessel.soiBodyId;
}

/** Take the first node of the flight plan as the burn to fly: its vector and start time. False when there is none to fly. */
function setupNode(g: Game): boolean {
  const s = g.state;
  const a = s.assist;
  const node = s.nodes[0];
  if (!node) return false;
  const ap = g.appliedFirst();
  if (!ap) {
    assistFail(g, 'the flight plan cannot be flown: the trajectory ends before the burn.');
    return false;
  }
  let dv: V3 = { x: ap.dvWorld.x, y: ap.dvWorld.y, z: ap.dvWorld.z };
  // The last burn of a trip to a station is a velocity match: aim it at the station as it will really be.
  const st = a.stationId ? g.stationDef(a.stationId) : undefined;
  if (st && (a.mode === 'goToStation' || a.mode === 'matchVelocity') && s.nodes.length === 1 && st.parentBodyId === ap.bodyId) {
    const ss = g.model.stationState(st.id, Math.max(node.t, s.time));
    if (len(sub(ss.r, ap.before.r)) < 400e3) {
      dv = sub(ss.v, ap.before.v);
      node.dv = dvToNodeComponents(ap.before, dv);
      g.markDirty();
    }
  }
  a.nodeId = node.id;
  a.dv = dv;
  a.burnStart = Math.max(node.t, s.time) - 0.5 * g.burnTime(len(dv));
  return true;
}

/** All nodes flown (or none to fly). */
function plannedFlightOver(g: Game): void {
  const a = g.state.assist;
  if (a.mode === 'goToStation') setPhase(g, 'arrive');
  else stop(g, null);
}

export function assistEngage(g: Game, cmd: AutopilotCommand): ActionResult {
  const s = g.state;
  const v = s.vessel;
  if (!cmd || typeof cmd.kind !== 'string') return { ok: false, reason: 'Unknown flight computer command.' };
  if (v.destroyed) return { ok: false, reason: 'The ship is lost.' };
  const docked = v.dockedAt !== null;
  const fresh = (mode: typeof s.assist.mode, stationId: string | null, phase: string): void => {
    if (s.assist.mode !== 'idle') stop(g, null);
    s.assist = newAssist();
    s.assist.mode = mode;
    s.assist.stationId = stationId;
    s.assist.phase = phase;
    s.assist.t0 = s.time;
    s.assist.fuel0 = v.fuel;
  };
  switch (cmd.kind) {
    case 'executeNode':
    case 'flyPlan': {
      if (docked || s.transit) return { ok: false, reason: 'Undock before engaging the flight computer.' };
      if (s.nodes.length === 0) return { ok: false, reason: 'There is no manoeuvre node to fly.' };
      if (!(v.fuel > 0)) return { ok: false, reason: 'The tanks are empty.' };
      fresh(cmd.kind, null, 'coast');
      if (!setupNode(g)) return { ok: false, reason: s.assist.failed ?? 'The flight plan cannot be flown.' };
      break;
    }
    case 'goToStation': {
      const st = g.stationDef(cmd.stationId);
      if (!st) return { ok: false, reason: 'Unknown station.' };
      if (v.dockedAt === st.id) return { ok: false, reason: `Already docked at ${st.name}.` };
      if (docked) {
        const r = g.undock();
        if (!r.ok) return r;
      }
      g.setTarget({ kind: 'station', id: st.id });
      fresh('goToStation', st.id, 'clear');
      break;
    }
    case 'dock': {
      const st = g.stationDef(cmd.stationId);
      if (!st) return { ok: false, reason: 'Unknown station.' };
      if (docked) return { ok: false, reason: 'Already docked.' };
      const r = g.requestDocking(st.id);
      if (!r.ok) return r;
      fresh('dock', st.id, 'tug');
      break;
    }
    case 'matchVelocity': {
      const st = g.stationDef(cmd.stationId);
      if (!st) return { ok: false, reason: 'Unknown station.' };
      if (docked || s.transit) return { ok: false, reason: 'Undock before engaging the flight computer.' };
      if (st.parentBodyId !== v.soiBodyId) return { ok: false, reason: `${st.name} orbits another body.` };
      if (!(v.fuel > 0)) return { ok: false, reason: 'The tanks are empty.' };
      const t = s.time + SLEW_LEAD + 5;
      const sv = propagateStateTo(newState(), v, g.model.body(v.soiBodyId).mu, t - s.time);
      const dv = sub(g.model.stationState(st.id, t).v, sv.v);
      if (len(dv) < 0.3) return { ok: false, reason: `Already at rest relative to ${st.name}.` };
      g.installPlan([makeNode('match', t, v.soiBodyId, sv, dv)]);
      fresh('matchVelocity', st.id, 'coast');
      if (!setupNode(g)) return { ok: false, reason: s.assist.failed ?? 'The burn cannot be flown.' };
      break;
    }
    default:
      return { ok: false, reason: 'Unknown flight computer command.' };
  }
  s.warp.requested = 0;
  announce(g);
  assistFrame(g);
  return { ok: true };
}

/** A node burn finished (the Game removed the node). */
export function assistNodeDone(g: Game, nodeId: string): void {
  const s = g.state;
  const a = s.assist;
  if (a.mode === 'idle' || a.nodeId !== nodeId) return;
  a.nodeId = null;
  a.dv = null;
  setSasMode(s.vessel, 'stability');
  if (a.mode === 'executeNode' || s.nodes.length === 0) {
    if (a.mode === 'goToStation') {
      setPhase(g, 'arrive');
      assistFrame(g);
    } else stop(g, null);
    return;
  }
  if (setupNode(g)) setPhase(g, 'coast');
  assistFrame(g);
}

/** Warp the flight computer wants (index into WARP_LEVELS) and the sim time it must not warp past. */
export function assistWarp(g: Game): { index: number; stop: number } {
  const a = g.state.assist;
  if (a.mode !== 'idle' && a.phase === 'coast') return { index: WARP_LEVELS.length - 1, stop: a.burnStart - SLEW_LEAD };
  return { index: 0, stop: Infinity };
}

/** Once per frame, before warp is decided: move through the phases and write the status line. */
export function assistFrame(g: Game, depth = 0): void {
  const phase0 = g.state.assist.phase;
  assistPhase(g);
  // A phase change takes effect at once, so the status line never lags a frame behind.
  const a = g.state.assist;
  if (a.mode !== 'idle' && a.phase !== phase0 && depth < 3) assistFrame(g, depth + 1);
}

function assistPhase(g: Game): void {
  const s = g.state;
  const a = s.assist;
  if (a.mode === 'idle') return;
  const v = s.vessel;
  if (v.destroyed) {
    stop(g, 'the ship was lost.');
    return;
  }
  const st = a.stationId ? g.stationDef(a.stationId) : undefined;
  const name = st ? st.name : 'the station';
  switch (a.phase) {
    case 'clear': {
      if (s.transit) {
        a.status = `Clearing the berth · ${Math.ceil(g.transitRemaining())} s`;
        break;
      }
      if (v.dockedAt !== null) {
        stop(g, null);
        break;
      }
      setPhase(g, 'plan');
      a.status = `Plotting a route to ${name}`;
      break;
    }
    case 'plan': {
      if (!st) {
        stop(g, 'no destination.');
        break;
      }
      if (inTugRange(g, st)) {
        setPhase(g, 'arrive');
        break;
      }
      const r = g.plan('toTarget');
      if (!r.ok) {
        stop(g, r.reason);
        break;
      }
      if (s.nodes.length === 0) {
        setPhase(g, 'arrive');
        break;
      }
      if (setupNode(g)) setPhase(g, 'coast');
      break;
    }
    case 'coast': {
      if (s.nodes.length === 0) {
        plannedFlightOver(g);
        break;
      }
      if (s.nodes[0].id !== a.nodeId || !a.dv) {
        if (!setupNode(g)) break;
      }
      const tb = a.burnStart - s.time;
      if (tb <= SLEW_LEAD) {
        if (!setupNode(g)) break;
        setSasMode(v, 'maneuver');
        setPhase(g, 'slew');
        a.status = `Turning for the burn · T-${fmtDuration(a.burnStart - s.time)}`;
        break;
      }
      a.status = `Coasting to burn · T-${fmtDuration(tb)}`;
      break;
    }
    case 'slew': {
      if (s.nodes.length === 0 || s.nodes[0].id !== a.nodeId || !a.dv) {
        setPhase(g, 'coast');
        break;
      }
      if (v.sasMode !== 'maneuver') setSasMode(v, 'maneuver');
      const tb = a.burnStart - s.time;
      const err = pointingError(v, a.dv);
      if (tb <= 0 && (err < 0.06 || tb < -45)) {
        if (!(v.fuel > 0)) {
          stop(g, 'the tanks are empty.');
          break;
        }
        g.beginBurn(a.nodeId, a.dv);
        setPhase(g, 'burn');
        a.status = `Burning · ${fmtSpeed(len(a.dv))} to go`;
        break;
      }
      a.status = tb > 0 ? `Turning for the burn · T-${fmtDuration(tb)}` : 'Lining up for the burn';
      break;
    }
    case 'burn': {
      if (!s.burn) {
        // The node went away under us (edited or removed).
        if (s.nodes.length === 0) plannedFlightOver(g);
        else setPhase(g, 'coast');
        break;
      }
      if (!(v.fuel > 0)) {
        stop(g, 'out of propellant.');
        break;
      }
      if (v.sasMode !== 'maneuver') setSasMode(v, 'maneuver');
      a.status = `Burning · ${fmtSpeed(len(s.burn.rem))} to go`;
      break;
    }
    case 'arrive': {
      if (!st) {
        stop(g, null);
        break;
      }
      if (inTugRange(g, st)) {
        const r = g.requestDocking(st.id);
        if (r.ok) {
          setPhase(g, 'tug');
          a.status = `Tug has you · ${Math.ceil(g.transitRemaining())} s`;
        } else stop(g, r.reason);
        break;
      }
      if (a.replans < 2) {
        a.replans++;
        setPhase(g, 'plan');
        a.status = `Re-plotting the approach to ${name}`;
        break;
      }
      stop(g, `could not reach ${name}: ended ${fmtDistance(g.relStation(st))} away at ${fmtSpeed(g.relSpeed())}.`);
      break;
    }
    case 'tug': {
      if (v.dockedAt !== null) {
        stop(g, null);
        break;
      }
      if (!s.transit) {
        stop(g, 'docking was cancelled.');
        break;
      }
      a.status = `Tug has you · ${Math.ceil(g.transitRemaining())} s`;
      break;
    }
    default:
      stop(g, null);
  }
}

/** Before each physics step: the throttle of a burn the flight computer is flying (full, tapering at the end). */
export function assistThrottle(g: Game): void {
  const s = g.state;
  const a = s.assist;
  if (a.mode === 'idle' || a.phase !== 'burn' || !s.burn) return;
  const v = s.vessel;
  const rem = len(s.burn.rem);
  const accel = currentAccel(v, 1);
  const err = pointingError(v, s.burn.rem);
  // Off the burn vector (the residual swings at the very end): wait for the SAS rather than push the wrong way.
  if (err > 0.35 && (rem < 0.1 * s.burn.total || err > 1.2)) v.controls.throttle = 0;
  else v.controls.throttle = accel > 0 ? clamp(rem / (accel * 0.8), 0.02, 1) : 1;
  s.input.throttleHold = true;
}
