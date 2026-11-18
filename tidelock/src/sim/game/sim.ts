// The game core: one Game object owns the saved state and implements the GameSim contract (api.ts).
// Plain node: no DOM, no three.js, no Math.random / Date.now. Public methods never throw.

import { CARGO_UNIT_MASS, type DockingPortDef, type Quat, type StateVector, type StationDef, type StationLayout, type SystemDef, type V3 } from '../../core/types';
import { EventBus } from '../../core/events';
import { clamp, dot, len, qConj, qMul, qNormalize, qSlerp } from '../../core/vec';
import { SHIP_LAYOUTS } from '../../data/shipLayouts';
import { STATION_LAYOUTS, padFits } from '../../data/stationLayouts';
import type { AutopilotCommand } from '../autopilot';
import { applyBuy, applySell, marketListing, propellantPrice, quoteBuy as ecoQuoteBuy, quoteSell as ecoQuoteSell, tickEconomy, type MarketRow, type TradeQuote } from '../economy';
import { SystemModel, closestApproach, newState, orbitInfo, orbitalPeriod, relativeInclination } from '../orbit';
import {
  INPUT_DEADZONE,
  PHYSICS_WARP_MAX,
  WARP_LEVELS,
  atmosphereDensity,
  coastVessel,
  createVessel,
  currentAccel,
  deltaVRemaining,
  dynamicPressure,
  fromStationLocal,
  isThrusting,
  maxWarpAllowed,
  newColliderContact,
  pointingError,
  setSasMode,
  stationContact,
  stepVessel,
  toStationLocal,
  totalMass,
  vesselForward,
  type SasMode,
  type Vessel,
  type VesselControls,
  type VesselEvent,
  type WarpContext,
} from '../physics';
import { dvToNodeComponents, predictWithNodes, shipFromVessel, type AppliedNode, type ManeuverNode, type NodeDv } from '../planner';
import { SHIPS, computeStats, defaultLoadout, loadoutResale, loadoutValue } from '../ships';
import { bodySpinAxis, generateGalaxy, getSystem, type GalaxyDef } from '../universe';
import type {
  ActionResult,
  AutopilotView,
  Contact,
  DestroyCause,
  Diagnostics,
  DockingView,
  FlightInfo,
  GameEvents,
  GameOptions,
  GameSim,
  NextNodeView,
  PlanKind,
  PlayerView,
  ShipPose,
  Situation,
  StationPose,
  TargetInfo,
  TargetRef,
  ToastKind,
  TrajectoryView,
  WarpView,
} from './api';
import { assistDisengage, assistEngage, assistFail, assistFrame, assistNodeDone, assistThrottle, assistWarp, fmtDistance, planRoute } from './assist';
import { dockedLocalPose, findPort, pickPort, releaseLocalPose, stationQuat, type LocalPose } from './docking';
import {
  CAPTURE_DISTANCE,
  CAPTURE_SPEED,
  COLLISION_LETHAL_SPEED,
  COLLISION_RESTITUTION,
  COLLISION_SAFE_SPEED,
  HEAT_WARNING_FRACTION,
  LOW_FUEL_FRACTION,
  MAX_DAY_TICKS_PER_FRAME,
  MAX_FRAME_DT,
  MAX_NODES,
  NODE_WARP_LEAD,
  PHYS_STEP,
  REBUY_SHARE,
  REBUY_TIME,
  RELEASE_DISTANCE,
  RELEASE_SPEED,
  RELEASE_TIME,
  REPAIR_SHARE,
  SAVE_FORMAT,
  SAVE_VERSION,
  START_SHIP,
  STATION_PHYSICS_MARGIN,
  TENDER_FEE,
  TENDER_FRACTION,
  TENDER_MAX_FUEL,
  TENDER_PRICE_MULTIPLE,
  TENDER_TIME,
  TUG_MAX_TIME,
  TUG_MIN_TIME,
  TUG_RANGE,
  TUG_SPEED,
  newAssist,
  newGameState,
  type GameState,
} from './state';

const TOP = WARP_LEVELS.length - 1;
/** Highest warp inside a station's keep-out sphere (flown with the integrator, not on rails). */
const NEAR_STATION_WARP = 100;
const DAY = 86400;
const SAS_MODES: readonly SasMode[] = ['off', 'stability', 'prograde', 'retrograde', 'normal', 'antinormal', 'radialOut', 'radialIn', 'target', 'antiTarget', 'maneuver', 'killRelative'];
const NO_QUOTE: TradeQuote = { units: 0, total: 0, average: 0, maxUnits: 0 };
const OK: ActionResult = { ok: true };

const num = (x: unknown, d = 0): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const v3 = (): V3 => ({ x: 0, y: 0, z: 0 });
const cp = (out: V3, a: V3): V3 => {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
};
const finiteV = (a: V3 | undefined | null): boolean => !!a && Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);
const smooth = (x: number): number => {
  const u = clamp(x, 0, 1);
  return u * u * (3 - 2 * u);
};
const no = (reason: string): ActionResult => ({ ok: false, reason });

const _ss = newState();
const _sa = newState();
const _sb = newState();
const _lp = v3();
const _lv = v3();
const _w = v3();
const _fwd = v3();
const _contact = newColliderContact();
const _wctx: WarpContext = {};

export class Game implements GameSim {
  readonly galaxy: GalaxyDef;
  readonly system: SystemDef;
  readonly model: SystemModel;
  readonly events = new EventBus<GameEvents>();
  state: GameState;

  private stationMap = new Map<string, StationDef>();
  private commodities = new Map<string, { name: string; basePrice: number }>();
  private poses = new Map<string, LocalPose>();
  private rev = 1;
  private diag: Diagnostics = { faults: 0, lastFault: '', rollbacks: 0 };
  private traj: TrajectoryView = { version: 0, patches: [], nodes: [], encounters: [], closestApproach: null };
  private trajDirty = true;
  private trajAge = 0;
  /** Burn vector of the first node of the plan, system axes (null when unknown). */
  private nodeDv: V3 | null = null;
  private nearSt: StationDef | null = null;
  private nearDist = Infinity;
  private _rp = v3();
  private _rv = v3();
  private lastRelSpeed = 0;
  private lastTransitP: V3 | null = null;
  private stopTime = Infinity;
  private nearCap = false;
  private wasDestroyed = false;
  private env: { targetRelPos: V3 | null; targetRelVel: V3 | null; maneuverDir: V3 | null } = { targetRelPos: null, targetRelVel: null, maneuverDir: null };
  private tRelP = v3();
  private tRelV = v3();
  private wv: WarpView = { level: 1, index: 0, requested: 1, maxAllowed: 1, limitReason: '' };
  private apv: AutopilotView = { engaged: false, mode: 'idle', phase: '', status: '', failed: null };
  private dkv: DockingView = {
    stationId: null,
    portId: null,
    granted: false,
    inControlZone: false,
    distance: Infinity,
    relSpeed: 0,
    canRequest: false,
    blocked: '',
    controlZone: 0,
    transit: null,
    tug: false,
    transitSeconds: 0,
    portDistance: Infinity,
    portRel: v3(),
    portAxis: v3(),
    lateral: 0,
  };
  private fi: FlightInfo | null = null;
  private fiRev = 0;
  private nnv: NextNodeView = { id: '', timeTo: 0, burnStartsIn: 0, dvRemaining: 0, burnDuration: 0, dir: v3(), pointingError: 0 };
  private ti: TargetInfo | null = null;
  private tiRev = 0;
  private contactList: Contact[] | null = null;
  private contactRev = 0;
  private pv: PlayerView | null = null;
  private pvRev = 0;
  private pose: ShipPose | null = null;
  private stPose: StationPose = { soiBodyId: '', r: v3(), v: v3(), q: { x: 0, y: 0, z: 0, w: 1 } };

  constructor(seed: number, pilotName: string, loaded?: GameState) {
    this.galaxy = generateGalaxy(seed);
    const sys = getSystem(this.galaxy, loaded ? loaded.systemId : this.galaxy.startSystemId);
    if (!sys) throw new Error('unknown system');
    this.system = sys;
    this.model = new SystemModel(sys);
    for (const st of sys.stations) this.stationMap.set(st.id, st);
    for (const c of this.galaxy.commodities) this.commodities.set(c.id, { name: c.name, basePrice: c.basePrice });
    if (loaded) {
      loaded.vessel.stats = computeStats(loaded.loadout);
      this.state = loaded;
    } else {
      const st = this.stationMap.get(this.galaxy.startStationId) ?? sys.stations[0];
      const loadout = defaultLoadout(START_SHIP);
      const port = pickPort(STATION_LAYOUTS[st.visualId], SHIPS[START_SHIP].pad, null);
      const ss = this.model.stationState(st.id, 0);
      const vessel = createVessel(computeStats(loadout), { id: 'player', name: SHIPS[START_SHIP].name, soiBodyId: st.parentBodyId, r: ss.r, v: ss.v, dockedAt: st.id });
      this.state = newGameState(this.galaxy, seed, pilotName, vessel, loadout, port ? port.id : '');
      this.state.docking = { stationId: st.id, portId: port ? port.id : null, granted: false };
    }
    this.wasDestroyed = this.state.vessel.destroyed;
    this.syncDocked();
    this.recompute();
  }

  // ---------------------------------------------------------------------------------------------- helpers (also used by assist.ts)

  stationDef(id: string | null | undefined): StationDef | undefined {
    return id ? this.stationMap.get(id) : undefined;
  }

  private layout(st: StationDef): StationLayout {
    return STATION_LAYOUTS[st.visualId];
  }

  private portPose(st: StationDef, port: DockingPortDef): LocalPose {
    const key = `${st.visualId}:${port.id}:${this.state.loadout.shipId}`;
    let p = this.poses.get(key);
    if (!p) {
      p = dockedLocalPose(this.state.loadout.shipId, port);
      this.poses.set(key, p);
    }
    return p;
  }

  toast(message: string, kind: ToastKind = 'info'): void {
    this.events.emit('toast', { message, kind });
  }

  private fault(where: string, err: unknown): void {
    this.diag.faults++;
    const message = err instanceof Error ? `${err.message}${err.stack ? `\n${err.stack.split('\n').slice(1, 4).join('\n')}` : ''}` : String(err);
    this.diag.lastFault = `${where}: ${message}`;
    this.events.emit('fault', { where, message });
  }

  private act<T>(where: string, fallback: T, fn: () => T): T {
    try {
      const r = fn();
      this.rev++;
      return r;
    } catch (err) {
      this.fault(where, err);
      return fallback;
    }
  }

  markDirty(): void {
    this.trajDirty = true;
  }

  /** Ship minus station, system axes, into the scratch vectors; returns the distance (m). */
  relStation(st: StationDef, outP: V3 = this._rp, outV: V3 = this._rv): number {
    const v = this.state.vessel;
    const t = this.state.time;
    let a: StateVector = v;
    let b: StateVector;
    if (v.soiBodyId === st.parentBodyId) b = this.model.stationState(st.id, t, _ss);
    else {
      a = this.model.toAbsolute(v, v.soiBodyId, t, _sa);
      b = this.model.stationAbsState(st.id, t, _sb);
    }
    outP.x = a.r.x - b.r.x;
    outP.y = a.r.y - b.r.y;
    outP.z = a.r.z - b.r.z;
    outV.x = a.v.x - b.v.x;
    outV.y = a.v.y - b.v.y;
    outV.z = a.v.z - b.v.z;
    this.lastRelSpeed = len(outV);
    return len(outP);
  }

  /** Relative speed (m/s) found by the last relStation call. */
  relSpeed(): number {
    return this.lastRelSpeed;
  }

  /** Seconds at full throttle for `dv` from the present mass (finite even when the tank cannot cover it). */
  burnTime(dv: number, mass = totalMass(this.state.vessel)): number {
    const st = this.state.vessel.stats;
    if (!(st.mainThrust > 0) || !(st.exhaustVelocity > 0)) return 0;
    return (mass * (1 - Math.exp(-Math.abs(dv) / st.exhaustVelocity)) * st.exhaustVelocity) / st.mainThrust;
  }

  cutThrottle(): void {
    this.state.vessel.controls.throttle = 0;
    this.state.input.throttleHold = true;
  }

  transitRemaining(): number {
    const tr = this.state.transit;
    return tr ? Math.max(0, tr.t0 + tr.duration - this.state.time) : 0;
  }

  /** The first node of the plan applied to the present trajectory, or null when it is not reached. */
  appliedFirst(): AppliedNode | null {
    const s = this.state;
    const n = s.nodes[0];
    if (!n) return null;
    const pred = predictWithNodes(this.model, shipFromVessel(s.vessel, s.time), [n], { maxPatches: 1, maxDuration: 1 });
    const a = pred.nodes[0];
    return a && a.reached ? a : null;
  }

  beginBurn(nodeId: string | null, dv: V3): void {
    if (!nodeId) return;
    this.state.burn = { nodeId, rem: { x: dv.x, y: dv.y, z: dv.z }, total: len(dv) };
  }

  /** Replace the flight plan (ids are re-issued). */
  installPlan(nodes: readonly ManeuverNode[]): void {
    const s = this.state;
    for (const n of s.nodes) this.events.emit('nodeRemoved', { id: n.id, reason: 'cleared' });
    s.burn = null;
    s.nodes = nodes
      .slice(0, MAX_NODES)
      .map((n) => ({ id: `n${s.nodeSeq++}`, t: n.t, bodyId: n.bodyId, dv: { prograde: num(n.dv.prograde), normal: num(n.dv.normal), radial: num(n.dv.radial) } }))
      .sort((a, b) => a.t - b.t);
    for (const n of s.nodes) this.events.emit('nodeAdded', { id: n.id });
    this.recompute();
  }

  private placeLocal(st: StationDef, p: V3, q: Quat, vLocal: V3 | null): void {
    const v = this.state.vessel;
    const ss = this.model.stationState(st.id, this.state.time, _ss);
    const sq = stationQuat(st);
    fromStationLocal(p, sq, _w);
    v.r.x = ss.r.x + _w.x;
    v.r.y = ss.r.y + _w.y;
    v.r.z = ss.r.z + _w.z;
    if (vLocal) fromStationLocal(vLocal, sq, _w);
    else _w.x = _w.y = _w.z = 0;
    v.v.x = ss.v.x + _w.x;
    v.v.y = ss.v.y + _w.y;
    v.v.z = ss.v.z + _w.z;
    v.q = qNormalize(qMul(sq, q));
    v.w.x = v.w.y = v.w.z = 0;
    v.soiBodyId = st.parentBodyId;
  }

  /** A docked ship rides its port. */
  private syncDocked(): void {
    const s = this.state;
    const st = this.stationDef(s.vessel.dockedAt);
    if (!st || s.transit) return;
    const layout = this.layout(st);
    const port = findPort(layout, s.dockedPortId) ?? pickPort(layout, SHIPS[s.loadout.shipId].pad, null);
    if (!port) {
      const ss = this.model.stationState(st.id, s.time, _ss);
      cp(s.vessel.r, ss.r);
      cp(s.vessel.v, ss.v);
      return;
    }
    s.dockedPortId = port.id;
    const pose = this.portPose(st, port);
    this.placeLocal(st, pose.p, pose.q, null);
  }

  private scanStations(): void {
    const v = this.state.vessel;
    this.nearSt = null;
    this.nearDist = Infinity;
    for (const st of this.system.stations) {
      if (st.parentBodyId !== v.soiBodyId) continue;
      const d = this.relStation(st, _lp, _lv);
      if (d < this.nearDist) {
        this.nearDist = d;
        this.nearSt = st;
      }
    }
  }

  /** Target minus ship (position, velocity) in system axes; false when there is no valid target. */
  private targetRel(outP: V3, outV: V3): boolean {
    const s = this.state;
    const ref = s.target;
    if (!ref) return false;
    const t = s.time;
    const m = this.model;
    const a = m.toAbsolute(s.vessel, s.vessel.soiBodyId, t, _sa);
    let b: StateVector;
    if (ref.kind === 'station') {
      if (!this.stationMap.has(ref.id)) return false;
      b = m.stationAbsState(ref.id, t, _sb);
    } else if (ref.kind === 'body') {
      if (!m.hasBody(ref.id)) return false;
      b = m.bodyAbsState(ref.id, t, _sb);
    } else {
      if (!this.system.miningSites.some((x) => x.id === ref.id)) return false;
      b = m.siteAbsState(ref.id, t, _sb);
    }
    outP.x = b.r.x - a.r.x;
    outP.y = b.r.y - a.r.y;
    outP.z = b.r.z - a.r.z;
    outV.x = b.v.x - a.v.x;
    outV.y = b.v.y - a.v.y;
    outV.z = b.v.z - a.v.z;
    return true;
  }

  // ---------------------------------------------------------------------------------------------- step

  step(realDt: number): void {
    const s = this.state;
    const v = s.vessel;
    const r0x = v.r.x;
    const r0y = v.r.y;
    const r0z = v.r.z;
    const v0x = v.v.x;
    const v0y = v.v.y;
    const v0z = v.v.z;
    const q0 = v.q;
    const t0 = s.time;
    try {
      this.stepInner(realDt);
    } catch (err) {
      this.fault('step', err);
    }
    if (!finiteV(v.r) || !finiteV(v.v) || !Number.isFinite(s.time) || !Number.isFinite(v.q.x + v.q.y + v.q.z + v.q.w) || !Number.isFinite(v.fuel)) {
      v.r.x = r0x;
      v.r.y = r0y;
      v.r.z = r0z;
      v.v.x = v0x;
      v.v.y = v0y;
      v.v.z = v0z;
      v.q = q0;
      if (!finiteV(v.w)) v.w.x = v.w.y = v.w.z = 0;
      if (!Number.isFinite(v.fuel)) v.fuel = 0;
      s.time = Number.isFinite(s.time) ? s.time : t0;
      v.controls.throttle = 0;
      this.diag.rollbacks++;
    }
    this.rev++;
  }

  private stepInner(realDt: number): void {
    if (!(realDt > 0)) return;
    const dt = Math.min(realDt, MAX_FRAME_DT);
    const s = this.state;
    const v = s.vessel;
    this.scanStations();
    const hasTarget = this.targetRel(this.tRelP, this.tRelV);
    this.env.targetRelPos = hasTarget ? this.tRelP : null;
    this.env.targetRelVel = hasTarget ? this.tRelV : null;
    assistFrame(this);
    this.updateWarp();
    const level = WARP_LEVELS[s.warp.index];
    let simDt = dt * level;
    if (level > 1 && s.time + simDt > this.stopTime) simDt = Math.max(dt, this.stopTime - s.time);
    const tBefore = s.time;

    if (v.destroyed) s.time += simDt;
    else if (s.transit) this.advanceTransit(simDt);
    else if (v.dockedAt !== null) {
      s.time += simDt;
      this.syncDocked();
      if (v.heat > 0) v.heat = Math.max(0, v.heat - v.stats.heatDissipation * simDt);
    } else {
      let railed = false;
      if (level > PHYSICS_WARP_MAX && !this.nearCap) {
        const res = coastVessel(this.model, v, s.time, simDt);
        if (res.tReached > s.time) {
          s.time = res.tReached;
          railed = true;
        }
        if (res.events.length > 0) this.onVesselEvents(res.events);
        if (res.stopReason !== 'done') this.trajDirty = true;
      }
      if (!railed) this.integrate(level > PHYSICS_WARP_MAX && !this.nearCap ? dt * PHYSICS_WARP_MAX : simDt);
      s.player.stats.distance += len(v.v) * (s.time - tBefore);
    }
    if (v.destroyed && !this.wasDestroyed) this.onDestroyed('impact');

    // Economy: one tick per sim day crossed, a few per frame at most.
    const day = Math.floor(s.time / DAY);
    for (let i = 0; i < MAX_DAY_TICKS_PER_FRAME && s.day < day; i++) {
      s.day++;
      const events = tickEconomy(s.economy, this.galaxy, s.day);
      this.events.emit('dayTicked', { day: s.day, events });
    }

    // Warnings.
    if (!v.destroyed) {
      const ff = v.stats.fuelCapacity > 0 ? v.fuel / v.stats.fuelCapacity : 0;
      if (ff < LOW_FUEL_FRACTION && !s.flags.fuelLow && v.dockedAt === null) {
        s.flags.fuelLow = true;
        this.events.emit('propellantLow', { fraction: ff });
        if (ff > 0) this.toast('Propellant below 10 %', 'warn');
      } else if (ff >= LOW_FUEL_FRACTION) s.flags.fuelLow = false;
      const hf = v.stats.heatCapacity > 0 ? v.heat / v.stats.heatCapacity : 0;
      if (hf >= HEAT_WARNING_FRACTION && !s.flags.heatHigh) {
        s.flags.heatHigh = true;
        this.events.emit('heatWarning', { fraction: hf });
      } else if (hf < HEAT_WARNING_FRACTION * 0.9) s.flags.heatHigh = false;
    }

    // Trajectory: refresh when it changed (throttled while thrusting), went stale, or its first arc ran out.
    this.trajAge += dt;
    const first = this.traj.patches[0];
    const thrusting = s.flags.thrusting || isThrusting(v);
    if (thrusting && v.dockedAt === null) this.trajDirty = true;
    if (!s.transit && ((this.trajDirty && (!thrusting || this.trajAge > 0.25)) || this.trajAge > 30 || (first !== undefined && s.time > first.tEnd && this.trajAge > 0.5))) this.recompute();
  }

  /** Numeric flight for `simDt` seconds in steps of PHYS_STEP: thrust, burn tracking, station contact. */
  private integrate(simDt: number): void {
    const s = this.state;
    const v = s.vessel;
    let remaining = simDt;
    while (remaining > 1e-9 && !v.destroyed && v.dockedAt === null && !s.transit) {
      const h = Math.min(remaining, PHYS_STEP);
      remaining -= h;
      assistThrottle(this);
      const assistBurn = s.assist.mode !== 'idle' && s.assist.phase === 'burn';
      const thrusting = v.controls.throttle > 0 && v.fuel > 0;
      if (thrusting !== s.flags.thrusting) {
        s.flags.thrusting = thrusting;
        if (thrusting) {
          // A manual burn near the next node counts against it.
          const n = s.nodes[0];
          if (!s.burn && n && this.nodeDv && s.time > n.t - 0.5 * this.burnTime(len(this.nodeDv)) - 30) this.beginBurn(n.id, this.nodeDv);
          this.events.emit('burnStarted', { nodeId: s.burn ? s.burn.nodeId : null });
        } else {
          this.events.emit('burnEnded', { nodeId: s.burn ? s.burn.nodeId : null });
          this.trajDirty = true;
          if (s.burn && !assistBurn) this.shrinkNode();
        }
      }
      const burn = s.burn;
      this.env.maneuverDir = burn ? burn.rem : (s.assist.dv ?? this.nodeDv);
      const mu = this.model.body(v.soiBodyId).mu;
      const soi = v.soiBodyId;
      let gx = 0;
      let gy = 0;
      let gz = 0;
      const vx = v.v.x;
      const vy = v.v.y;
      const vz = v.v.z;
      if (burn) {
        const r = len(v.r);
        const k = -mu / (r * r * r);
        gx = k * v.r.x;
        gy = k * v.r.y;
        gz = k * v.r.z;
      }
      const events = stepVessel(this.model, v, s.time, h, this.env);
      s.time += h;
      if (events.length > 0) this.onVesselEvents(events);
      if (burn && s.burn === burn && v.soiBodyId === soi && !v.destroyed) {
        // Delivered delta-v = velocity change minus what gravity did (trapezoid).
        const r = len(v.r);
        const k = -mu / (r * r * r);
        burn.rem.x -= v.v.x - vx - 0.5 * h * (gx + k * v.r.x);
        burn.rem.y -= v.v.y - vy - 0.5 * h * (gy + k * v.r.y);
        burn.rem.z -= v.v.z - vz - 0.5 * h * (gz + k * v.r.z);
        const mag = len(burn.rem);
        if (mag < 0.25 || (!assistBurn && thrusting && mag < Math.max(1.5, 0.02 * burn.total) && dot(burn.rem, vesselForward(v, _fwd)) <= 0)) this.completeBurn();
      }
      if (this.nearSt && !v.destroyed) this.proximity(this.nearSt);
    }
  }

  /** The burn of a node is done: cut the drive, drop the node, tell the flight computer. */
  private completeBurn(): void {
    const s = this.state;
    const burn = s.burn;
    if (!burn) return;
    this.cutThrottle();
    s.burn = null;
    const i = s.nodes.findIndex((n) => n.id === burn.nodeId);
    if (i >= 0) {
      s.nodes.splice(i, 1);
      this.events.emit('nodeRemoved', { id: burn.nodeId, reason: 'completed' });
    }
    if (s.flags.thrusting) {
      s.flags.thrusting = false;
      this.events.emit('burnEnded', { nodeId: burn.nodeId });
    }
    this.recompute();
    assistNodeDone(this, burn.nodeId);
  }

  /** A manual burn stopped short: the node keeps what is left of it. */
  private shrinkNode(): void {
    const s = this.state;
    const burn = s.burn;
    if (!burn) return;
    s.burn = null;
    const n = s.nodes.find((x) => x.id === burn.nodeId);
    if (!n) return;
    n.dv = dvToNodeComponents(s.vessel, burn.rem);
    n.t = Math.max(n.t, s.time);
    this.events.emit('nodeChanged', { id: n.id });
    this.trajDirty = true;
  }

  private onVesselEvents(events: readonly VesselEvent[]): void {
    const v = this.state.vessel;
    for (const e of events) {
      switch (e.type) {
        case 'soi-change':
          this.events.emit('soiChanged', { fromBodyId: e.fromBodyId, toBodyId: e.toBodyId });
          this.trajDirty = true;
          break;
        case 'atmosphere-enter':
          this.events.emit('atmosphereEntered', { bodyId: e.bodyId });
          break;
        case 'atmosphere-exit':
          this.events.emit('atmosphereExited', { bodyId: e.bodyId });
          this.trajDirty = true;
          break;
        case 'flameout':
          this.events.emit('propellantLow', { fraction: 0 });
          this.toast('The tanks are dry.', 'danger');
          break;
        case 'overheat':
          this.events.emit('heatWarning', { fraction: v.stats.heatCapacity > 0 ? v.heat / v.stats.heatCapacity : 1 });
          break;
        case 'destroyed':
          this.onDestroyed(e.cause);
          break;
        default:
          break;
      }
    }
  }

  private onDestroyed(cause: DestroyCause): void {
    if (this.wasDestroyed) return;
    this.wasDestroyed = true;
    const s = this.state;
    const v = s.vessel;
    v.destroyed = true;
    v.controls.throttle = 0;
    v.controls.pitch = v.controls.yaw = v.controls.roll = 0;
    s.burn = null;
    s.transit = null;
    s.docking = { stationId: null, portId: null, granted: false };
    s.flags.thrusting = false;
    s.warp.requested = 0;
    if (s.assist.mode !== 'idle') assistFail(this, 'the ship was lost.');
    this.events.emit('destroyed', { cause });
    this.toast('Ship lost.', 'danger');
    this.trajDirty = true;
  }

  /** Close to a station: soft capture at a berth, and collisions with the structure. */
  private proximity(st: StationDef): void {
    const s = this.state;
    const v = s.vessel;
    const layout = this.layout(st);
    const radius = SHIP_LAYOUTS[s.loadout.shipId].radius;
    const d = this.relStation(st);
    this.nearDist = d;
    if (d > layout.radius + radius + 60) return;
    const sq = stationQuat(st);
    toStationLocal(this._rp, sq, _lp);
    toStationLocal(this._rv, sq, _lv);
    const speed = len(_lv);
    if (speed < CAPTURE_SPEED) {
      const pad = SHIPS[s.loadout.shipId].pad;
      for (const port of layout.ports) {
        if (!padFits(pad, port.size)) continue;
        const pose = this.portPose(st, port);
        if (Math.hypot(_lp.x - pose.p.x, _lp.y - pose.p.y, _lp.z - pose.p.z) < CAPTURE_DISTANCE) {
          this.startCapture(st, port, false, 5);
          return;
        }
      }
    }
    if (!stationContact(_lp, radius, layout.colliders, _contact)) return;
    const n = _contact.normal;
    const vn = dot(_lv, n);
    _lp.x += n.x * _contact.depth;
    _lp.y += n.y * _contact.depth;
    _lp.z += n.z * _contact.depth;
    if (vn < 0) {
      const k = -(1 + COLLISION_RESTITUTION) * vn;
      _lv.x += n.x * k;
      _lv.y += n.y * k;
      _lv.z += n.z * k;
      const hit = -vn;
      if (hit > COLLISION_SAFE_SPEED) {
        const damage = (v.stats.hullMax * (hit - COLLISION_SAFE_SPEED)) / (COLLISION_LETHAL_SPEED - COLLISION_SAFE_SPEED);
        v.hull = Math.max(0, v.hull - damage);
        this.events.emit('collision', { stationId: st.id, speed: hit, damage });
        this.toast(`Hit ${st.name} at ${hit.toFixed(1)} m/s`, 'danger');
      }
    }
    const ss = this.model.stationState(st.id, s.time, _ss);
    fromStationLocal(_lp, sq, _w);
    v.r.x = ss.r.x + _w.x;
    v.r.y = ss.r.y + _w.y;
    v.r.z = ss.r.z + _w.z;
    fromStationLocal(_lv, sq, _w);
    v.v.x = ss.v.x + _w.x;
    v.v.y = ss.v.y + _w.y;
    v.v.z = ss.v.z + _w.z;
    this.trajDirty = true;
    if (v.hull <= 0) this.onDestroyed('collision');
  }

  // ---------------------------------------------------------------------------------------------- berths

  private startCapture(st: StationDef, port: DockingPortDef, tug: boolean, duration: number): void {
    const s = this.state;
    const v = s.vessel;
    const sq = stationQuat(st);
    this.relStation(st);
    const p0 = toStationLocal(this._rp, sq, v3());
    v.controls.throttle = 0;
    v.controls.pitch = v.controls.yaw = v.controls.roll = 0;
    v.controls.translate.x = v.controls.translate.y = v.controls.translate.z = 0;
    s.input.throttleHold = true;
    if (s.burn) this.shrinkNode();
    if (s.flags.thrusting) {
      s.flags.thrusting = false;
      this.events.emit('burnEnded', { nodeId: null });
    }
    s.docking = { stationId: st.id, portId: port.id, granted: true };
    s.transit = { kind: 'capture', tug, stationId: st.id, portId: port.id, t0: s.time, duration, p0, q0: qNormalize(qMul(qConj(sq), v.q)) };
    this.lastTransitP = null;
    this.events.emit('dockingGranted', { stationId: st.id, portId: port.id });
    this.events.emit('dockingCaptured', { stationId: st.id, portId: port.id });
    this.toast(tug ? `${st.name} tug has you` : `${st.name}: berth ${port.id} has you`, 'good');
  }

  /** The ship is carried by a berth or a tug: eased kinematically in the station's frame. */
  private advanceTransit(dt: number): void {
    const s = this.state;
    const tr = s.transit;
    if (!tr) return;
    s.time += dt;
    const st = this.stationDef(tr.stationId);
    const port = st ? findPort(this.layout(st), tr.portId) : null;
    if (!st || !port) {
      s.transit = null;
      return;
    }
    const u = clamp((s.time - tr.t0) / tr.duration, 0, 1);
    const docked = this.portPose(st, port);
    let q: Quat;
    if (tr.kind === 'release') {
      const out = releaseLocalPose(port, RELEASE_DISTANCE);
      // Cubic from rest to RELEASE_SPEED at the end.
      const vt = RELEASE_SPEED * tr.duration;
      const f = ((3 * RELEASE_DISTANCE - vt) * u * u + (vt - 2 * RELEASE_DISTANCE) * u * u * u) / RELEASE_DISTANCE;
      _lp.x = docked.p.x + (out.p.x - docked.p.x) * f;
      _lp.y = docked.p.y + (out.p.y - docked.p.y) * f;
      _lp.z = docked.p.z + (out.p.z - docked.p.z) * f;
      q = qSlerp(docked.q, out.q, smooth(u * 1.6));
    } else {
      const VIA = 40;
      const far = tr.tug && Math.hypot(tr.p0.x - docked.p.x, tr.p0.y - docked.p.y, tr.p0.z - docked.p.z) > 2 * VIA;
      if (far) {
        const vx = docked.p.x + port.dir.x * VIA;
        const vy = docked.p.y + port.dir.y * VIA;
        const vz = docked.p.z + port.dir.z * VIA;
        if (u < 0.7) {
          const f = smooth(u / 0.7);
          _lp.x = tr.p0.x + (vx - tr.p0.x) * f;
          _lp.y = tr.p0.y + (vy - tr.p0.y) * f;
          _lp.z = tr.p0.z + (vz - tr.p0.z) * f;
          q = qSlerp(tr.q0, docked.q, f);
        } else {
          const f = smooth((u - 0.7) / 0.3);
          _lp.x = vx + (docked.p.x - vx) * f;
          _lp.y = vy + (docked.p.y - vy) * f;
          _lp.z = vz + (docked.p.z - vz) * f;
          q = docked.q;
        }
      } else {
        const f = smooth(u);
        _lp.x = tr.p0.x + (docked.p.x - tr.p0.x) * f;
        _lp.y = tr.p0.y + (docked.p.y - tr.p0.y) * f;
        _lp.z = tr.p0.z + (docked.p.z - tr.p0.z) * f;
        q = qSlerp(tr.q0, docked.q, f);
      }
    }
    const last = this.lastTransitP;
    if (last && dt > 0) {
      _lv.x = (_lp.x - last.x) / dt;
      _lv.y = (_lp.y - last.y) / dt;
      _lv.z = (_lp.z - last.z) / dt;
    } else _lv.x = _lv.y = _lv.z = 0;
    this.lastTransitP = cp(last ?? v3(), _lp);
    this.placeLocal(st, _lp, q, _lv);
    if (u < 1) return;
    s.transit = null;
    this.lastTransitP = null;
    if (tr.kind === 'release') {
      setSasMode(s.vessel, 'stability');
      this.trajDirty = true;
      this.recompute();
    } else this.finishDock(st, port);
  }

  private finishDock(st: StationDef, port: DockingPortDef): void {
    const s = this.state;
    const v = s.vessel;
    v.dockedAt = st.id;
    s.dockedPortId = port.id;
    s.docking = { stationId: st.id, portId: port.id, granted: false };
    v.controls.throttle = 0;
    v.controls.pitch = v.controls.yaw = v.controls.roll = 0;
    v.controls.translate.x = v.controls.translate.y = v.controls.translate.z = 0;
    s.input.throttleHold = true;
    setSasMode(v, 'stability');
    for (const n of s.nodes) this.events.emit('nodeRemoved', { id: n.id, reason: 'cleared' });
    s.nodes = [];
    s.burn = null;
    s.warp.requested = 0;
    s.player.lastStationId = st.id;
    s.player.stats.dockings++;
    this.syncDocked();
    this.events.emit('docked', { stationId: st.id, portId: port.id });
    this.toast(`Docked at ${st.name}`, 'good');
    this.recompute();
    assistFrame(this);
  }

  private dockingBlock(st: StationDef, dist: number, speed: number, port: DockingPortDef | null): string {
    const v = this.state.vessel;
    if (v.destroyed) return 'The ship is lost.';
    if (st.parentBodyId !== v.soiBodyId || dist > TUG_RANGE) return `${st.name} is ${fmtDistance(dist)} away: the tug works within ${fmtDistance(TUG_RANGE)}.`;
    if (speed > TUG_SPEED) return `Too fast for the tug: ${Math.round(speed)} m/s relative (limit ${TUG_SPEED} m/s).`;
    if (!port) return `No berth at ${st.name} fits this ship.`;
    return '';
  }

  private nearestAny(): StationDef | undefined {
    let best: StationDef | undefined;
    let bd = Infinity;
    for (const st of this.system.stations) {
      const d = this.relStation(st, _lp, _lv);
      if (d < bd) {
        bd = d;
        best = st;
      }
    }
    return best;
  }

  requestDocking(stationId?: string): ActionResult {
    return this.act('requestDocking', no('Docking control did not answer.'), () => {
      const s = this.state;
      const v = s.vessel;
      if (v.destroyed) return no('The ship is lost.');
      if (v.dockedAt !== null) return no('Already docked.');
      if (s.transit) return no(s.transit.kind === 'capture' ? 'Docking is already in progress.' : 'Still leaving the berth.');
      const st = stationId !== undefined ? this.stationDef(stationId) : ((s.target && s.target.kind === 'station' ? this.stationDef(s.target.id) : undefined) ?? this.nearestAny());
      if (!st) return no('No station to dock at.');
      const dist = this.relStation(st);
      const speed = this.lastRelSpeed;
      const port = pickPort(this.layout(st), SHIPS[s.loadout.shipId].pad, toStationLocal(this._rp, stationQuat(st), v3()));
      const blocked = this.dockingBlock(st, dist, speed, port);
      if (blocked !== '' || !port) return no(blocked);
      if (s.assist.mode !== 'idle' && s.assist.mode !== 'goToStation' && s.assist.mode !== 'dock') assistDisengage(this);
      this.startCapture(st, port, true, clamp(TUG_MIN_TIME + dist / 1400, TUG_MIN_TIME, TUG_MAX_TIME));
      return OK;
    });
  }

  cancelDocking(): void {
    this.act('cancelDocking', undefined, () => {
      const s = this.state;
      const tr = s.transit;
      if (!tr || tr.kind !== 'capture') return;
      const st = this.stationDef(tr.stationId);
      s.transit = null;
      this.lastTransitP = null;
      s.docking = { stationId: null, portId: null, granted: false };
      if (st) cp(s.vessel.v, this.model.stationState(st.id, s.time, _ss).v);
      setSasMode(s.vessel, 'stability');
      this.events.emit('dockingCancelled', { stationId: tr.stationId, reason: 'Cancelled by the pilot' });
      this.trajDirty = true;
      assistFrame(this);
    });
  }

  undock(): ActionResult {
    return this.act('undock', no('The clamps did not release.'), () => {
      const s = this.state;
      const v = s.vessel;
      if (v.destroyed) return no('The ship is lost.');
      const st = this.stationDef(v.dockedAt);
      if (!st) return no(s.transit ? 'Already leaving.' : 'Not docked.');
      const layout = this.layout(st);
      const port = findPort(layout, s.dockedPortId) ?? pickPort(layout, SHIPS[s.loadout.shipId].pad, null);
      if (!port) return no('No berth to leave from.');
      const pose = this.portPose(st, port);
      v.dockedAt = null;
      v.controls.throttle = 0;
      s.input.throttleHold = true;
      s.warp.requested = 0;
      s.docking = { stationId: null, portId: null, granted: false };
      s.transit = { kind: 'release', tug: false, stationId: st.id, portId: port.id, t0: s.time, duration: RELEASE_TIME, p0: { ...pose.p }, q0: { ...pose.q } };
      this.lastTransitP = null;
      s.player.stats.flights++;
      this.events.emit('undocked', { stationId: st.id, portId: port.id });
      return OK;
    });
  }

  dockedStation(): StationDef | null {
    return this.stationDef(this.state.vessel.dockedAt) ?? null;
  }

  dockingState(): DockingView {
    const d = this.dkv;
    try {
      const s = this.state;
      const v = s.vessel;
      let st = this.stationDef(v.dockedAt) ?? (s.transit ? this.stationDef(s.transit.stationId) : undefined);
      if (!st && s.target && s.target.kind === 'station') st = this.stationDef(s.target.id);
      if (!st) st = this.nearestAny();
      d.stationId = st ? st.id : null;
      d.portId = null;
      d.granted = s.docking.granted;
      d.transit = s.transit ? s.transit.kind : null;
      d.tug = !!s.transit && s.transit.tug;
      d.transitSeconds = this.transitRemaining();
      d.portDistance = Infinity;
      d.lateral = 0;
      d.canRequest = false;
      if (!st) {
        d.distance = Infinity;
        d.relSpeed = 0;
        d.inControlZone = false;
        d.controlZone = 0;
        d.blocked = 'No station nearby.';
        return d;
      }
      const layout = this.layout(st);
      const dist = this.relStation(st);
      d.distance = dist;
      d.relSpeed = this.lastRelSpeed;
      d.controlZone = layout.controlZone;
      d.inControlZone = dist < layout.controlZone;
      const sq = stationQuat(st);
      toStationLocal(this._rp, sq, _lp);
      let port: DockingPortDef | null = null;
      if (v.dockedAt !== null) port = findPort(layout, s.dockedPortId);
      else if (s.transit) port = findPort(layout, s.transit.portId);
      else if (dist < TUG_RANGE) port = pickPort(layout, SHIPS[s.loadout.shipId].pad, _lp);
      d.blocked = v.dockedAt !== null ? 'Already docked.' : s.transit ? '' : this.dockingBlock(st, dist, this.lastRelSpeed, port ?? pickPort(layout, SHIPS[s.loadout.shipId].pad, null));
      d.canRequest = v.dockedAt === null && !s.transit && d.blocked === '';
      if (port) {
        d.portId = port.id;
        const pose = this.portPose(st, port);
        d.portDistance = Math.hypot(_lp.x - pose.p.x, _lp.y - pose.p.y, _lp.z - pose.p.z);
        _lv.x = port.pos.x - _lp.x;
        _lv.y = port.pos.y - _lp.y;
        _lv.z = port.pos.z - _lp.z;
        const along = -dot(_lv, port.dir);
        d.lateral = Math.sqrt(Math.max(0, _lv.x * _lv.x + _lv.y * _lv.y + _lv.z * _lv.z - along * along));
        fromStationLocal(_lv, sq, d.portRel);
        fromStationLocal(port.dir, sq, d.portAxis);
      }
    } catch (err) {
      this.fault('dockingState', err);
    }
    return d;
  }

  // ---------------------------------------------------------------------------------------------- time warp

  time(): number {
    return this.state.time;
  }

  private updateWarp(): void {
    const s = this.state;
    const v = s.vessel;
    const t = s.time;
    let want = clamp(Math.floor(num(s.warp.requested)), 0, TOP);
    let stop = Infinity;
    let cap = WARP_LEVELS[TOP];
    let reason = '';
    this.nearCap = false;
    if (s.assist.mode !== 'idle') {
      const w = assistWarp(this);
      want = w.index;
      stop = w.stop;
    } else if (v.dockedAt === null && s.nodes.length > 0 && this.nodeDv) {
      const bs = s.nodes[0].t - 0.5 * this.burnTime(len(this.nodeDv)) - NODE_WARP_LEAD;
      if (bs > t) stop = bs;
    }
    if (v.destroyed) {
      cap = 1;
      reason = 'The ship is lost';
    } else if (s.transit) {
      cap = 1;
      reason = s.transit.kind === 'release' ? 'Leaving the berth' : s.transit.tug ? 'Under tow' : 'Docking';
    } else if (v.dockedAt === null && this.nearSt && this.nearDist < this.layout(this.nearSt).radius + STATION_PHYSICS_MARGIN) {
      // Inside a station's keep-out sphere the ship is always integrated (collisions, capture), never on rails.
      cap = NEAR_STATION_WARP;
      this.nearCap = true;
      reason = `Too close to ${this.nearSt.name}`;
    }
    this.stopTime = stop;
    _wctx.cap = cap;
    _wctx.nextStopTime = stop < Infinity ? stop : undefined;
    const allowed = maxWarpAllowed(this.model, v, t, _wctx);
    let ai = 0;
    while (ai < TOP && WARP_LEVELS[ai + 1] <= allowed) ai++;
    const idx = Math.min(want, ai);
    if (ai < want) {
      if (reason === '' || allowed < cap) {
        const body = this.model.body(v.soiBodyId);
        if (v.dockedAt === null && isThrusting(v)) reason = 'Engines firing';
        else if (v.dockedAt === null && body.atmosphere && len(v.r) - body.radius < body.atmosphere.height) reason = 'In the atmosphere';
        else if (stop - t < WARP_LEVELS[ai + 1] * 0.3) reason = 'Burn coming up';
        else if (reason === '') reason = v.dockedAt !== null ? '' : `Too low over ${body.name}`;
      }
    } else reason = '';
    const w = this.wv;
    w.requested = WARP_LEVELS[want];
    w.maxAllowed = allowed;
    w.limitReason = reason;
    if (idx !== s.warp.index) {
      s.warp.index = idx;
      this.events.emit('warpChanged', { level: WARP_LEVELS[idx], reason: idx < want ? reason : '' });
    }
    w.index = s.warp.index;
    w.level = WARP_LEVELS[s.warp.index];
  }

  warp(): WarpView {
    return this.wv;
  }

  setWarp(multiplier: number): ActionResult {
    return this.act('setWarp', no('Time warp is not available.'), () => {
      const s = this.state;
      if (s.assist.mode !== 'idle') return no('The flight computer is managing time warp: disengage it first.');
      const m = num(multiplier, 1);
      let idx = 0;
      while (idx < TOP && WARP_LEVELS[idx + 1] <= m) idx++;
      s.warp.requested = idx;
      this.scanStations();
      this.updateWarp();
      if (s.warp.index < idx) return no(this.wv.limitReason !== '' ? `${this.wv.limitReason}: warp limited to ${this.wv.maxAllowed}×.` : `Warp limited to ${this.wv.maxAllowed}×.`);
      return OK;
    });
  }

  warpUp(): ActionResult {
    return this.setWarp(WARP_LEVELS[Math.min(TOP, this.state.warp.index + 1)]);
  }

  warpDown(): ActionResult {
    return this.setWarp(WARP_LEVELS[Math.max(0, Math.min(this.state.warp.index, this.state.warp.requested) - 1)]);
  }

  // ---------------------------------------------------------------------------------------------- manual flight

  setControls(c: Partial<VesselControls>): void {
    this.act('setControls', undefined, () => {
      const s = this.state;
      const v = s.vessel;
      if (!c || v.destroyed) return;
      const flying = v.dockedAt === null && !s.transit;
      let manual = false;
      let th = -1;
      if (c.throttle !== undefined) {
        const x = clamp(num(c.throttle), 0, 1);
        if (x !== s.input.throttleSent) {
          s.input.throttleSent = x;
          th = x;
          manual = true;
        } else if (!s.input.throttleHold) th = x;
      }
      if (!flying) return;
      const pitch = c.pitch !== undefined ? clamp(num(c.pitch), -1, 1) : null;
      const yaw = c.yaw !== undefined ? clamp(num(c.yaw), -1, 1) : null;
      const roll = c.roll !== undefined ? clamp(num(c.roll), -1, 1) : null;
      if ((pitch !== null && Math.abs(pitch) > INPUT_DEADZONE) || (yaw !== null && Math.abs(yaw) > INPUT_DEADZONE) || (roll !== null && Math.abs(roll) > INPUT_DEADZONE)) manual = true;
      const tr = c.translate;
      if (tr && (num(tr.x) !== 0 || num(tr.y) !== 0 || num(tr.z) !== 0)) manual = true;
      if (manual && s.assist.mode !== 'idle') assistDisengage(this);
      if (th >= 0 && s.assist.mode === 'idle') {
        v.controls.throttle = th;
        s.input.throttleHold = false;
      }
      if (pitch !== null) v.controls.pitch = pitch;
      if (yaw !== null) v.controls.yaw = yaw;
      if (roll !== null) v.controls.roll = roll;
      if (tr) {
        v.controls.translate.x = clamp(num(tr.x), -1, 1);
        v.controls.translate.y = clamp(num(tr.y), -1, 1);
        v.controls.translate.z = clamp(num(tr.z), -1, 1);
      }
    });
  }

  setSas(mode: SasMode): ActionResult {
    return this.act('setSas', no('SAS did not respond.'), () => {
      if (!SAS_MODES.includes(mode)) return no('Unknown SAS mode.');
      const s = this.state;
      if (s.vessel.destroyed) return no('The ship is lost.');
      if (s.assist.mode !== 'idle') assistDisengage(this);
      setSasMode(s.vessel, mode);
      return OK;
    });
  }

  // ---------------------------------------------------------------------------------------------- targeting

  setTarget(ref: TargetRef | null): ActionResult {
    return this.act('setTarget', no('Target not found.'), () => {
      const s = this.state;
      if (ref !== null) {
        const known =
          ref && typeof ref.id === 'string' && (ref.kind === 'station' ? this.stationMap.has(ref.id) : ref.kind === 'body' ? this.model.hasBody(ref.id) : ref.kind === 'site' ? this.system.miningSites.some((m) => m.id === ref.id) : false);
        if (!known) return no('That target is not in this system.');
      }
      const same = (ref === null && s.target === null) || (ref !== null && s.target !== null && ref.kind === s.target.kind && ref.id === s.target.id);
      s.target = ref ? { kind: ref.kind, id: ref.id } : null;
      if (!same) {
        this.events.emit('targetChanged', { target: s.target });
        this.recompute();
      }
      return OK;
    });
  }

  target(): TargetRef | null {
    return this.state.target;
  }

  // ---------------------------------------------------------------------------------------------- flight plan

  nodes(): readonly ManeuverNode[] {
    return this.state.nodes;
  }

  addNode(t: number, dv?: Partial<NodeDv>): ActionResult & { id?: string } {
    return this.act<ActionResult & { id?: string }>('addNode', no('The node could not be added.'), () => {
      const s = this.state;
      if (s.vessel.destroyed) return no('The ship is lost.');
      if (s.nodes.length >= MAX_NODES) return no(`The flight plan holds at most ${MAX_NODES} nodes.`);
      if (!Number.isFinite(t)) return no('The node needs a time.');
      const time = Math.max(t, s.time + 1);
      let bodyId = s.vessel.soiBodyId;
      for (const p of this.traj.patches) if (time >= p.tStart && time <= p.tEnd) bodyId = p.bodyId;
      const node: ManeuverNode = { id: `n${s.nodeSeq++}`, t: time, bodyId, dv: { prograde: num(dv?.prograde), normal: num(dv?.normal), radial: num(dv?.radial) } };
      s.nodes.push(node);
      s.nodes.sort((a, b) => a.t - b.t);
      this.events.emit('nodeAdded', { id: node.id });
      this.recompute();
      return { ok: true, id: node.id };
    });
  }

  updateNode(id: string, patch: { t?: number; dv?: Partial<NodeDv> }): ActionResult {
    return this.act('updateNode', no('The node could not be changed.'), () => {
      const s = this.state;
      const n = s.nodes.find((x) => x.id === id);
      if (!n) return no('No such node.');
      if (patch && patch.t !== undefined && Number.isFinite(patch.t)) n.t = Math.max(patch.t, s.time + 1);
      if (patch && patch.dv) {
        if (patch.dv.prograde !== undefined) n.dv.prograde = num(patch.dv.prograde);
        if (patch.dv.normal !== undefined) n.dv.normal = num(patch.dv.normal);
        if (patch.dv.radial !== undefined) n.dv.radial = num(patch.dv.radial);
      }
      s.nodes.sort((a, b) => a.t - b.t);
      if (s.burn && s.burn.nodeId === id) s.burn = null;
      if (s.assist.nodeId === id) s.assist.dv = null;
      this.events.emit('nodeChanged', { id });
      this.recompute();
      return OK;
    });
  }

  removeNode(id: string): ActionResult {
    return this.act('removeNode', no('The node could not be removed.'), () => {
      const s = this.state;
      const i = s.nodes.findIndex((x) => x.id === id);
      if (i < 0) return no('No such node.');
      s.nodes.splice(i, 1);
      if (s.burn && s.burn.nodeId === id) s.burn = null;
      this.events.emit('nodeRemoved', { id, reason: 'removed' });
      this.recompute();
      return OK;
    });
  }

  clearNodes(): void {
    this.act('clearNodes', undefined, () => {
      if (this.state.nodes.length > 0) this.installPlan([]);
    });
  }

  plan(kind: PlanKind): ActionResult & { summary?: string; totalDv?: number; arrivalTime?: number; warnings?: string[] } {
    return this.act<ActionResult & { summary?: string; totalDv?: number; arrivalTime?: number; warnings?: string[] }>('plan', no('The flight computer faulted.'), () => {
      const s = this.state;
      if (s.vessel.destroyed) return no('The ship is lost.');
      if (s.vessel.dockedAt !== null) return no('Undock first: the flight computer plans from open space.');
      if (s.transit) return no('Wait until the ship is clear of the berth.');
      const r = planRoute(this, kind);
      if (!r.ok) return no(r.reason);
      this.installPlan(r.nodes);
      return { ok: true, summary: r.summary, totalDv: r.totalDv, arrivalTime: r.arrivalTime, warnings: r.warnings };
    });
  }

  /** Recompute the predicted path (bumps `version`). */
  private recompute(): void {
    const s = this.state;
    const v = s.vessel;
    const view = this.traj;
    this.trajDirty = false;
    this.trajAge = 0;
    view.version++;
    view.closestApproach = null;
    view.encounters = [];
    view.nodes = [];
    this.nodeDv = null;
    if (v.destroyed) {
      view.patches = [];
      return;
    }
    try {
      const start = shipFromVessel(v, s.time);
      let nodes: ManeuverNode[] = s.nodes;
      if (s.burn && nodes.length > 0 && nodes[0].id === s.burn.nodeId) {
        nodes = nodes.slice();
        nodes[0] = { id: nodes[0].id, t: s.time, bodyId: v.soiBodyId, dv: dvToNodeComponents(v, s.burn.rem) };
      }
      const pred = predictWithNodes(this.model, start, nodes, { maxPatches: 4 });
      view.patches = pred.patches;
      const budget = deltaVRemaining(v);
      let spent = 0;
      let mass = totalMass(v);
      let lastPatch = 0;
      for (let i = 0; i < pred.nodes.length; i++) {
        const a = pred.nodes[i];
        spent += a.dv;
        view.nodes.push({
          id: a.node.id,
          t: a.node.t,
          bodyId: a.bodyId,
          dvMagnitude: a.dv,
          burnDuration: this.burnTime(a.dv, mass),
          affordable: spent <= budget + 0.5,
          reached: a.reached,
          r: { ...a.before.r },
          dvWorld: { ...a.dvWorld },
        });
        mass *= Math.exp(-a.dv / Math.max(1, v.stats.exhaustVelocity));
        if (a.reached && a.patchIndex >= 0) lastPatch = a.patchIndex;
      }
      const firstNode = pred.nodes[0];
      if (s.burn) this.nodeDv = s.burn.rem;
      else if (firstNode && firstNode.reached) this.nodeDv = { ...firstNode.dvWorld };
      for (let i = 1; i < pred.patches.length; i++) {
        const p = pred.patches[i];
        const prev = pred.patches[i - 1];
        if (prev.endReason !== 'soi-enter' && prev.endReason !== 'soi-exit') continue;
        const body = this.model.body(p.bodyId);
        view.encounters.push({ bodyId: p.bodyId, name: body.name, t: p.tStart, periapsisRadius: p.periapsisRadius, periapsisAltitude: p.periapsisRadius - body.radius, periapsisTime: p.periapsisTime });
      }
      // Closest pass of the target after the last node.
      const ref = s.target;
      if (ref && v.dockedAt === null) {
        const parentId = ref.kind === 'station' ? this.stationDef(ref.id)?.parentBodyId : ref.kind === 'body' ? (this.model.hasBody(ref.id) ? this.model.body(ref.id).parentId : null) : this.system.miningSites.find((m) => m.id === ref.id)?.parentBodyId;
        for (let i = lastPatch; i < pred.patches.length; i++) {
          const p = pred.patches[i];
          if (ref.kind === 'body' && p.bodyId === ref.id) {
            view.closestApproach = { t: p.periapsisTime ?? p.tStart, distance: p.periapsisRadius, relSpeed: Math.sqrt(Math.max(0, p.mu * (2 / p.periapsisRadius - 1 / p.elements.a))) };
            break;
          }
          if (!parentId || p.bodyId !== parentId) continue;
          const tgt = ref.kind === 'station' ? this.model.stationState(ref.id, p.tStart, _sb) : ref.kind === 'body' ? this.model.bodyState(ref.id, p.tStart, _sb) : this.model.siteState(ref.id, p.tStart, _sb);
          const tp = orbitalPeriod(p.mu, Math.max(len(tgt.r), 1));
          const span = Math.min(p.tEnd - p.tStart, 2 * Math.max(tp, Number.isFinite(p.period) ? p.period : tp));
          if (span > 0) {
            const ca = closestApproach(p.svStart, tgt, p.mu, p.tStart, p.tStart + span, { maxSamples: 400 });
            if (Number.isFinite(ca.distance)) view.closestApproach = { t: ca.t, distance: ca.distance, relSpeed: ca.relSpeed };
          }
          break;
        }
      }
    } catch (err) {
      view.patches = [];
      this.fault('trajectory', err);
    }
  }

  trajectory(): TrajectoryView {
    return this.traj;
  }

  // ---------------------------------------------------------------------------------------------- flight computer

  autopilot(): AutopilotView {
    const a = this.state.assist;
    const o = this.apv;
    o.engaged = a.mode !== 'idle';
    o.mode = a.mode;
    o.phase = a.phase;
    o.status = a.status;
    o.failed = a.failed;
    return o;
  }

  engageAutopilot(cmd: AutopilotCommand): ActionResult {
    return this.act('engageAutopilot', no('The flight computer faulted.'), () => assistEngage(this, cmd));
  }

  disengageAutopilot(): void {
    this.act('disengageAutopilot', undefined, () => assistDisengage(this));
  }

  // ---------------------------------------------------------------------------------------------- station services

  private marketStation(): StationDef | null {
    const st = this.dockedStation();
    return st && st.services.includes('market') ? st : null;
  }

  private cargoUsed(): number {
    let n = 0;
    const cargo = this.state.player.cargo;
    for (const k in cargo) n += cargo[k].units;
    return n;
  }

  market(): MarketRow[] {
    const st = this.marketStation();
    return st ? marketListing(this.state.economy, this.galaxy, st.id) : [];
  }

  quoteBuy(commodityId: string, units: number): TradeQuote {
    return this.act('quoteBuy', { ...NO_QUOTE }, () => {
      const st = this.marketStation();
      if (!st) return { ...NO_QUOTE };
      const s = this.state;
      const room = Math.floor(s.vessel.stats.cargoCapacity - this.cargoUsed() + 1e-9);
      let n = Math.min(Math.floor(num(units)), room);
      if (n <= 0) return { ...ecoQuoteBuy(s.economy, this.galaxy, st.id, commodityId, 0), units: 0, total: 0, average: 0 };
      let q = ecoQuoteBuy(s.economy, this.galaxy, st.id, commodityId, n);
      for (let i = 0; i < 64 && q.units > 0 && q.total > s.player.credits; i++) {
        n = Math.max(0, Math.min(q.units - 1, Math.floor((q.units * s.player.credits) / q.total)));
        q = ecoQuoteBuy(s.economy, this.galaxy, st.id, commodityId, n);
      }
      if (q.total > s.player.credits) return { ...q, units: 0, total: 0, average: 0 };
      return q;
    });
  }

  quoteSell(commodityId: string, units: number): TradeQuote {
    return this.act('quoteSell', { ...NO_QUOTE }, () => {
      const st = this.marketStation();
      const lot = this.state.player.cargo[commodityId];
      if (!st || !lot) return { ...NO_QUOTE };
      const n = Math.min(Math.floor(num(units)), Math.floor(lot.units));
      if (n <= 0) return { ...NO_QUOTE };
      return ecoQuoteSell(this.state.economy, this.galaxy, st.id, commodityId, n);
    });
  }

  buy(commodityId: string, units: number): ActionResult {
    return this.act('buy', no('The trade did not go through.'), () => {
      const s = this.state;
      const st = this.marketStation();
      if (!st) return no(s.vessel.dockedAt === null ? 'Dock at a station to trade.' : 'This station has no market.');
      if (!(Math.floor(num(units)) >= 1)) return no('Choose how many tonnes to buy.');
      const q = this.quoteBuy(commodityId, units);
      if (q.units < 1) {
        if (s.vessel.stats.cargoCapacity - this.cargoUsed() < 1) return no('The hold is full.');
        const one = ecoQuoteBuy(s.economy, this.galaxy, st.id, commodityId, 1);
        if (one.units < 1) return no(`${st.name} has none of that for sale.`);
        return no(`Not enough credits: one tonne costs ${one.total} cr.`);
      }
      const done = applyBuy(s.economy, this.galaxy, st.id, commodityId, q.units);
      if (done.units < 1) return no(`${st.name} has none of that for sale.`);
      s.player.credits -= done.total;
      const lot = s.player.cargo[commodityId] ?? (s.player.cargo[commodityId] = { units: 0, paid: 0 });
      lot.units += done.units;
      lot.paid += done.total;
      s.player.stats.trades++;
      s.vessel.cargoMass = this.cargoUsed() * CARGO_UNIT_MASS;
      this.events.emit('traded', { kind: 'buy', stationId: st.id, commodityId, units: done.units, total: done.total, profit: 0 });
      return OK;
    });
  }

  sell(commodityId: string, units: number): ActionResult {
    return this.act('sell', no('The trade did not go through.'), () => {
      const s = this.state;
      const st = this.marketStation();
      if (!st) return no(s.vessel.dockedAt === null ? 'Dock at a station to trade.' : 'This station has no market.');
      const lot = s.player.cargo[commodityId];
      if (!lot || lot.units < 1) return no('None of that on board.');
      if (!(Math.floor(num(units)) >= 1)) return no('Choose how many tonnes to sell.');
      const q = this.quoteSell(commodityId, units);
      if (q.units < 1) return no(`${st.name} is not buying that.`);
      const done = applySell(s.economy, this.galaxy, st.id, commodityId, q.units);
      if (done.units < 1) return no(`${st.name} is not buying that.`);
      const cost = (lot.paid * done.units) / lot.units;
      const profit = Math.round(done.total - cost);
      lot.units -= done.units;
      lot.paid -= cost;
      if (lot.units < 1e-6) delete s.player.cargo[commodityId];
      s.player.credits += done.total;
      s.player.stats.trades++;
      s.player.stats.profit += profit;
      s.vessel.cargoMass = this.cargoUsed() * CARGO_UNIT_MASS;
      this.events.emit('traded', { kind: 'sell', stationId: st.id, commodityId, units: done.units, total: done.total, profit });
      return OK;
    });
  }

  refuelQuote(): { kg: number; cost: number; pricePerKg: number } {
    return this.act('refuelQuote', { kg: 0, cost: 0, pricePerKg: 0 }, () => {
      const s = this.state;
      const st = this.dockedStation();
      if (!st || !st.services.includes('refuel')) return { kg: 0, cost: 0, pricePerKg: 0 };
      const price = propellantPrice(s.economy, this.galaxy, st.id);
      let kg = Math.max(0, s.vessel.stats.fuelCapacity - s.vessel.fuel);
      if (price > 0 && kg * price > s.player.credits) kg = Math.floor(s.player.credits / price);
      return { kg, cost: Math.min(s.player.credits, Math.ceil(kg * price)), pricePerKg: price };
    });
  }

  refuel(kg?: number): ActionResult {
    return this.act('refuel', no('The pumps did not start.'), () => {
      const s = this.state;
      const st = this.dockedStation();
      if (!st) return no('Dock at a station to refuel.');
      if (!st.services.includes('refuel')) return no(`${st.name} does not sell propellant.`);
      const q = this.refuelQuote();
      if (s.vessel.stats.fuelCapacity - s.vessel.fuel < 0.5) return no('The tanks are full.');
      let amount = q.kg;
      if (kg !== undefined) amount = Math.min(amount, Math.max(0, num(kg)));
      if (!(amount > 0)) return no(q.kg > 0 ? 'Choose how much propellant to buy.' : 'Not enough credits for propellant.');
      const cost = Math.min(s.player.credits, Math.ceil(amount * q.pricePerKg));
      s.player.credits -= cost;
      s.vessel.fuel = Math.min(s.vessel.stats.fuelCapacity, s.vessel.fuel + amount);
      this.events.emit('refuelled', { stationId: st.id, kg: amount, cost });
      return OK;
    });
  }

  repairQuote(): { cost: number } {
    const v = this.state.vessel;
    const frac = v.stats.hullMax > 0 ? clamp(1 - v.hull / v.stats.hullMax, 0, 1) : 0;
    return { cost: Math.ceil(REPAIR_SHARE * loadoutValue(this.state.loadout) * frac) };
  }

  repair(): ActionResult {
    return this.act('repair', no('The yard is busy.'), () => {
      const s = this.state;
      const st = this.dockedStation();
      if (!st) return no('Dock at a station for repairs.');
      if (!st.services.includes('repair')) return no(`${st.name} has no repair yard.`);
      const cost = this.repairQuote().cost;
      if (cost <= 0) return no('The hull is sound.');
      if (cost > s.player.credits) return no(`Repairs cost ${cost} cr.`);
      s.player.credits -= cost;
      s.vessel.hull = s.vessel.stats.hullMax;
      this.events.emit('repaired', { stationId: st.id, cost });
      return OK;
    });
  }

  // ---------------------------------------------------------------------------------------------- views

  flightInfo(): FlightInfo {
    if (this.fi && this.fiRev === this.rev) return this.fi;
    const s = this.state;
    const v = s.vessel;
    const body = this.model.body(v.soiBodyId);
    const info = orbitInfo(v, body.mu, s.time);
    const atmH = body.atmosphere ? body.atmosphere.height : 0;
    const alt = info.radius - body.radius;
    const inAtm = atmH > 0 && alt < atmH;
    let situation: Situation;
    if (v.destroyed) situation = 'destroyed';
    else if (v.dockedAt !== null) situation = 'docked';
    else if (inAtm) situation = 'atmosphere';
    else if (!info.closed) situation = 'escape';
    else if (info.periapsis < body.radius + atmH) situation = 'suborbital';
    else situation = 'orbit';
    const axis = bodySpinAxis(body);
    const om = body.rotationPeriod !== 0 && Number.isFinite(body.rotationPeriod) ? (2 * Math.PI) / body.rotationPeriod : 0;
    const sx = v.v.x - om * (axis.y * v.r.z - axis.z * v.r.y);
    const sy = v.v.y - om * (axis.z * v.r.x - axis.x * v.r.z);
    const sz = v.v.z - om * (axis.x * v.r.y - axis.y * v.r.x);
    const surfaceSpeed = Math.hypot(sx, sy, sz);
    const cap = v.stats.fuelCapacity;
    const ff = cap > 0 ? v.fuel / cap : 0;
    let next: NextNodeView | null = null;
    const n = s.nodes[0];
    const dvv = s.burn ? s.burn.rem : (s.assist.dv ?? this.nodeDv);
    if (n && dvv) {
      next = this.nnv;
      const mag = len(dvv);
      next.id = n.id;
      next.timeTo = n.t - s.time;
      next.dvRemaining = mag;
      next.burnDuration = this.burnTime(mag);
      next.burnStartsIn = next.timeTo - 0.5 * next.burnDuration;
      if (mag > 1e-9) {
        next.dir.x = dvv.x / mag;
        next.dir.y = dvv.y / mag;
        next.dir.z = dvv.z / mag;
      } else next.dir.x = next.dir.y = next.dir.z = 0;
      next.pointingError = pointingError(v, dvv);
    }
    const f: FlightInfo = this.fi ?? ({} as FlightInfo);
    f.situation = situation;
    f.soiBodyId = body.id;
    f.soiBodyName = body.name;
    f.altitude = alt;
    f.radius = info.radius;
    f.orbitalSpeed = info.speed;
    f.surfaceSpeed = surfaceSpeed;
    f.verticalSpeed = info.radialSpeed;
    f.apoapsisAltitude = info.closed ? info.apoapsis - body.radius : Infinity;
    f.periapsisAltitude = info.periapsis - body.radius;
    f.timeToApoapsis = info.closed ? info.timeToApoapsis : Infinity;
    f.timeToPeriapsis = info.timeToPeriapsis >= 0 ? info.timeToPeriapsis : Infinity;
    f.period = info.closed ? info.period : Infinity;
    f.inclination = info.i;
    f.eccentricity = info.e;
    f.propellant = v.fuel;
    f.propellantCapacity = cap;
    f.propellantFraction = ff;
    f.deltaV = deltaVRemaining(v);
    f.maxAccel = currentAccel(v, 1);
    f.mass = totalMass(v);
    f.throttle = v.fuel > 0 ? v.controls.throttle : 0;
    f.sasMode = v.sasMode;
    f.heatFraction = v.stats.heatCapacity > 0 ? v.heat / v.stats.heatCapacity : 0;
    f.hullFraction = v.stats.hullMax > 0 ? v.hull / v.stats.hullMax : 0;
    f.inAtmosphere = inAtm;
    f.dynamicPressure = inAtm ? dynamicPressure(atmosphereDensity(body, alt), surfaceSpeed) : 0;
    f.nextNode = next;
    f.canCallTender = situation === 'orbit' && !s.transit && ff < TENDER_MAX_FUEL;
    this.fi = f;
    this.fiRev = this.rev;
    return f;
  }

  targetInfo(): TargetInfo | null {
    const s = this.state;
    const ref = s.target;
    if (!ref) return null;
    if (this.ti && this.tiRev === this.rev && this.ti.ref === ref) return this.ti;
    const o: TargetInfo = this.ti ?? { ref, name: '', distance: 0, relSpeed: 0, closingSpeed: 0, relVelocity: v3(), direction: v3(), closestApproach: null, relativeInclination: null, sameSoi: false };
    if (!this.targetRel(this.tRelP, this.tRelV)) return null;
    const v = s.vessel;
    o.ref = ref;
    const d = len(this.tRelP);
    o.distance = d;
    o.relSpeed = len(this.tRelV);
    o.closingSpeed = d > 0 ? -dot(this.tRelP, this.tRelV) / d : 0;
    cp(o.relVelocity, this.tRelV);
    if (d > 0) {
      o.direction.x = this.tRelP.x / d;
      o.direction.y = this.tRelP.y / d;
      o.direction.z = this.tRelP.z / d;
    }
    let parentId: string | null | undefined;
    if (ref.kind === 'station') {
      const st = this.stationMap.get(ref.id);
      o.name = st ? st.name : ref.id;
      parentId = st?.parentBodyId;
    } else if (ref.kind === 'body') {
      const b = this.model.body(ref.id);
      o.name = b.name;
      parentId = b.parentId;
    } else {
      const site = this.system.miningSites.find((m) => m.id === ref.id);
      o.name = site ? site.name : ref.id;
      parentId = site?.parentBodyId;
    }
    o.sameSoi = parentId === v.soiBodyId;
    o.relativeInclination = null;
    if (o.sameSoi) {
      const tgt = ref.kind === 'station' ? this.model.stationState(ref.id, s.time, _sb) : ref.kind === 'body' ? this.model.bodyState(ref.id, s.time, _sb) : this.model.siteState(ref.id, s.time, _sb);
      const ri = relativeInclination(v, tgt);
      o.relativeInclination = Number.isFinite(ri) ? ri : null;
    }
    const ca = this.traj.closestApproach;
    o.closestApproach = ca ? { time: ca.t, distance: ca.distance } : null;
    this.ti = o;
    this.tiRev = this.rev;
    return o;
  }

  contacts(): readonly Contact[] {
    if (this.contactList && this.contactRev === this.rev) return this.contactList;
    const s = this.state;
    const m = this.model;
    if (!this.contactList) {
      const list: Contact[] = [];
      for (const b of this.system.bodies) list.push({ ref: { kind: 'body', id: b.id }, name: b.name, kind: 'body', distance: 0, soiBodyId: b.parentId ?? '', rel: v3() });
      for (const st of this.system.stations) list.push({ ref: { kind: 'station', id: st.id }, name: st.name, kind: 'station', distance: 0, soiBodyId: st.parentBodyId, rel: v3() });
      for (const site of this.system.miningSites) list.push({ ref: { kind: 'site', id: site.id }, name: site.name, kind: 'site', distance: 0, soiBodyId: site.parentBodyId, rel: v3() });
      this.contactList = list;
    }
    try {
      const a = m.toAbsolute(s.vessel, s.vessel.soiBodyId, s.time, _sa);
      for (const c of this.contactList) {
        const b = c.kind === 'body' ? m.bodyAbsState(c.ref.id, s.time, _sb) : c.kind === 'station' ? m.stationAbsState(c.ref.id, s.time, _sb) : m.siteAbsState(c.ref.id, s.time, _sb);
        c.rel.x = b.r.x - a.r.x;
        c.rel.y = b.r.y - a.r.y;
        c.rel.z = b.r.z - a.r.z;
        c.distance = len(c.rel);
      }
    } catch (err) {
      this.fault('contacts', err);
    }
    this.contactRev = this.rev;
    return this.contactList;
  }

  player(): PlayerView {
    if (this.pv && this.pvRev === this.rev) return this.pv;
    const s = this.state;
    const p = s.player;
    const cargo = Object.keys(p.cargo)
      .map((id) => {
        const lot = p.cargo[id];
        return { commodityId: id, name: this.commodities.get(id)?.name ?? id, units: lot.units, avgPaid: lot.units > 0 ? lot.paid / lot.units : 0 };
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let worth = p.credits + loadoutResale(s.loadout);
    for (const c of cargo) worth += c.units * (this.commodities.get(c.commodityId)?.basePrice ?? 0);
    this.pv = {
      pilotName: p.name,
      credits: p.credits,
      shipId: s.loadout.shipId,
      shipName: SHIPS[s.loadout.shipId].name,
      cargo,
      cargoUsed: this.cargoUsed(),
      cargoCapacity: s.vessel.stats.cargoCapacity,
      netWorth: Math.round(worth),
      stats: p.stats,
      lastStationId: p.lastStationId,
    };
    this.pvRev = this.rev;
    return this.pv;
  }

  shipPose(): ShipPose {
    const v = this.state.vessel;
    const o = this.pose ?? (this.pose = { soiBodyId: '', r: v.r, v: v.v, q: v.q, throttle: 0, rcs: v.controls.translate, heat: 0, docked: false, destroyed: false });
    o.soiBodyId = v.soiBodyId;
    o.r = v.r;
    o.v = v.v;
    o.q = v.q;
    o.throttle = v.fuel > 0 && v.dockedAt === null && !this.state.transit ? v.controls.throttle : 0;
    o.rcs = v.controls.translate;
    o.heat = v.stats.heatCapacity > 0 ? v.heat / v.stats.heatCapacity : 0;
    o.docked = v.dockedAt !== null;
    o.destroyed = v.destroyed;
    return o;
  }

  stationPose(stationId: string): StationPose | null {
    const st = this.stationMap.get(stationId);
    if (!st) return null;
    const o = this.stPose;
    const ss = this.model.stationState(st.id, this.state.time, _ss);
    o.soiBodyId = st.parentBodyId;
    cp(o.r, ss.r);
    cp(o.v, ss.v);
    o.q = stationQuat(st);
    return o;
  }

  diagnostics(): Diagnostics {
    return this.diag;
  }

  // ---------------------------------------------------------------------------------------------- persistence and failure

  save(): string {
    try {
      const json = JSON.stringify({ format: SAVE_FORMAT, version: SAVE_VERSION, state: this.state });
      this.events.emit('saved', { bytes: json.length });
      return json;
    } catch (err) {
      this.fault('save', err);
      return '';
    }
  }

  rebuyQuote(): { cost: number; stationId: string } {
    const s = this.state;
    const st = this.stationDef(s.player.lastStationId) ?? this.system.stations[0];
    return { cost: Math.min(Math.max(0, Math.floor(s.player.credits)), Math.round(REBUY_SHARE * loadoutValue(s.loadout))), stationId: st.id };
  }

  rebuy(): ActionResult {
    return this.act('rebuy', no('The insurer did not answer.'), () => {
      const s = this.state;
      if (!s.vessel.destroyed) return no('The ship is still in one piece.');
      const q = this.rebuyQuote();
      const st = this.stationDef(q.stationId) ?? this.system.stations[0];
      s.player.credits -= q.cost;
      s.player.cargo = {};
      s.player.stats.rebuys++;
      s.time += REBUY_TIME;
      const ss = this.model.stationState(st.id, s.time);
      s.vessel = createVessel(computeStats(s.loadout), { id: 'player', name: SHIPS[s.loadout.shipId].name, soiBodyId: st.parentBodyId, r: ss.r, v: ss.v, dockedAt: st.id });
      this.pose = null;
      this.wasDestroyed = false;
      s.nodes = [];
      s.burn = null;
      s.transit = null;
      s.assist = newAssist();
      s.warp = { requested: 0, index: 0 };
      s.input = { throttleSent: s.input.throttleSent, throttleHold: true };
      s.flags = { fuelLow: false, heatHigh: false, thrusting: false, burnNodeId: null };
      const port = pickPort(this.layout(st), SHIPS[s.loadout.shipId].pad, null);
      s.dockedPortId = port ? port.id : null;
      s.docking = { stationId: st.id, portId: s.dockedPortId, granted: false };
      this.syncDocked();
      this.events.emit('rebought', { stationId: st.id, cost: q.cost });
      this.toast(`Replacement ${SHIPS[s.loadout.shipId].name} delivered at ${st.name}`, 'info');
      this.recompute();
      return OK;
    });
  }

  tenderQuote(): { kg: number; cost: number; hours: number } {
    const s = this.state;
    const v = s.vessel;
    const kg = Math.max(0, Math.min(TENDER_FRACTION * v.stats.fuelCapacity, v.stats.fuelCapacity - v.fuel));
    const price = propellantPrice(s.economy, this.galaxy, s.player.lastStationId);
    return { kg, cost: Math.round(TENDER_FEE + kg * price * TENDER_PRICE_MULTIPLE), hours: TENDER_TIME / 3600 };
  }

  callTender(): ActionResult {
    return this.act('callTender', no('No tender answered.'), () => {
      const s = this.state;
      const v = s.vessel;
      if (v.destroyed) return no('The ship is lost.');
      if (v.dockedAt !== null || s.transit) return no('You are at a station: refuel here.');
      if (v.fuel / v.stats.fuelCapacity >= TENDER_MAX_FUEL) return no('Tenders only come out for dry tanks (under 5 %).');
      if (this.flightInfo().situation !== 'orbit') return no('A tender can only reach a ship in a stable orbit.');
      const q = this.tenderQuote();
      const cost = Math.min(q.cost, Math.max(0, Math.floor(s.player.credits)));
      if (s.assist.mode !== 'idle') assistDisengage(this);
      this.cutThrottle();
      let t = s.time;
      const end = s.time + TENDER_TIME;
      for (let i = 0; i < 8 && t < end; i++) {
        const res = coastVessel(this.model, v, t, end - t);
        if (res.events.length > 0) this.onVesselEvents(res.events);
        if (!(res.tReached > t)) break;
        t = res.tReached;
      }
      s.time = t;
      if (v.destroyed) return no('The ship was lost before the tender arrived.');
      s.player.credits -= cost;
      v.fuel = Math.min(v.stats.fuelCapacity, v.fuel + q.kg);
      s.player.stats.tenders++;
      this.events.emit('tenderArrived', { kg: q.kg, cost });
      this.toast(`Tender delivered ${Math.round(q.kg)} kg of propellant`, 'good');
      this.recompute();
      return OK;
    });
  }
}

// ------------------------------------------------------------------------------------------------ entry points

/** A new game: docked at the start station in a stock ship, full tanks, empty hold. */
export function createGame(options: GameOptions = {}): Game {
  const seed = Number.isFinite(options.seed) ? Math.floor(options.seed as number) : 1;
  const name = typeof options.pilotName === 'string' && options.pilotName.trim() !== '' ? options.pilotName.trim().slice(0, 40) : 'Pilot';
  return new Game(seed, name);
}

/** Restore a game from `save()` output; null when the text is not a usable save. */
export function loadGame(json: string): Game | null {
  try {
    const data: unknown = JSON.parse(json);
    if (!data || typeof data !== 'object') return null;
    const d = data as { format?: unknown; version?: unknown; state?: unknown };
    if (d.format !== SAVE_FORMAT || d.version !== SAVE_VERSION || !d.state || typeof d.state !== 'object') return null;
    const s = d.state as GameState;
    const v = s.vessel;
    if (!Number.isFinite(s.seed) || !Number.isFinite(s.time) || typeof s.systemId !== 'string') return null;
    if (!v || !finiteV(v.r) || !finiteV(v.v) || !finiteV(v.w) || !v.q || !Number.isFinite(v.q.x + v.q.y + v.q.z + v.q.w) || !v.controls || !finiteV(v.controls.translate)) return null;
    if (!Number.isFinite(v.fuel) || !Number.isFinite(v.hull) || typeof v.soiBodyId !== 'string') return null;
    if (!s.loadout || !(s.loadout.shipId in SHIPS) || !Array.isArray(s.loadout.modules)) return null;
    if (!s.player || !Number.isFinite(s.player.credits) || !s.player.cargo || typeof s.player.cargo !== 'object' || !s.player.stats) return null;
    if (!Array.isArray(s.nodes) || !s.economy || typeof s.economy !== 'object' || !s.economy.markets) return null;
    if (!s.assist || !s.warp || !s.input || !s.flags || !s.docking) return null;
    for (const n of s.nodes) if (!n || typeof n.id !== 'string' || !Number.isFinite(n.t) || !n.dv) return null;
    s.warp.requested = clamp(Math.floor(num(s.warp.requested)), 0, TOP);
    s.warp.index = clamp(Math.floor(num(s.warp.index)), 0, TOP);
    const g = new Game(s.seed, s.player.name, s);
    if (!g.model.hasBody(v.soiBodyId)) return null;
    return g;
  } catch {
    return null;
  }
}
