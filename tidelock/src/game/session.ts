// The session: the thin layer between the client and the physical world (docs/ARCHITECTURE.md §1, api.ts).
// It owns no physics. It turns pilot input into thruster and torque commands on the player's craft, runs the
// attitude-hold controller (real torque, never a set orientation), asks the world to advance inside the frame
// budget, and offers read-only views of the world's state. Deterministic: the only clock it reads is the
// wall clock handed to advance() for the CPU budget.

import { EventBus } from '../core/events';
import type { Quat, ShipVisualId, StationVisualId, SystemDef, V3 } from '../core/types';
import { qLook } from '../core/vec';
import { SHIP_LAYOUTS } from '../data/shipLayouts';
import { START_STATION_ID, START_SYSTEM_ID } from '../data/systems/layout';
import { computeStats, defaultLoadout } from '../sim/ships';
import { generateGalaxy, getSystem } from '../sim/universe';
import {
  addCraft, advance, attitudeError, craftInertia, createPrediction, createWorld, dockingStatus, drainEvents, ephemerisOf, findCraft,
  flightReadout, holdTorque, loadWorld, pointingError, predictionEvent, Predictor, qRot, qRotInv, saveWorld, shipDef, undock,
  type AdvanceOptions, type Craft, type PredictOptions, type World,
} from '../world';
import type {
  BodyView, CraftView, DockingView, FlightView, HoldMode, PlannedBurn, PlayerView, PredictionEvent, PredictionView, Session, SessionEvents,
  SessionOptions, StepInfo, TargetView, WarpLimit, WarpView,
} from './api';

export const PLAYER_ID = 'player';
/** Time-acceleration ladder. */
export const WARP_LADDER: readonly number[] = [1, 2, 5, 10, 50, 100, 1000, 1e4, 1e5, 1e6];
/** The start: this far clear of the station's bounding sphere, ahead of it in the same orbit, m. */
export const START_CLEARANCE = 200;

const SAVE_VERSION = 2;
/** Longest stretch of sim time the attitude controller's command is held while it is working, s. */
const CONTROL_DT = 1 / 50;
/** Stick below this is no input. */
const STICK_DEADZONE = 0.02;
/** Rate a full stick deflection asks for while a hold is on (fly-by-wire through real torque), rad/s. */
const STICK_RATE = 0.5;
/** 'stability' captures the heading once the ship turns slower than this, rad/s. */
const CAPTURE_RATE = 0.02;
/** Deadband: the controller goes quiet inside the first pair and wakes outside the second (rad, rad/s). */
const SETTLE_ANGLE = 0.003;
const SETTLE_RATE = 2e-5;
const WAKE_ANGLE = 0.03;
const WAKE_RATE = 0.01;
/** Under time acceleration nobody steers by the nose: from LOOSE_WARP a settled hold lets the heading drift this
 * far before it corrects, and from SUSPEND_WARP it sleeps until time slows down again (the ship coasts in rotation). */
const LOOSE_WARP = 1000;
const WAKE_ANGLE_LOOSE = 0.3;
const SUSPEND_WARP = 1e4;
/** The latch is armed within this distance of a station's bounding sphere, m. */
const ARM_RANGE = 1000;
/** After undocking the latch stays open until the collar is this far from the port, m. */
const REARM_DISTANCE = 12;
/** Prediction: refresh interval (real seconds), wall-clock budget per refresh (ms), points kept. */
const PREDICT_INTERVAL = 0.5;
const PREDICT_BUDGET_MS = 6;
const PREDICT_POINTS = 512;
/** Frames the achieved time acceleration is averaged over, and frames a limit reason stays shown. */
const WARP_WINDOW = 20;
const LIMIT_STICKY = 20;
/** A planned burn stays "the next burn" for this long after its time, s. */
const BURN_GRACE = 300;

const v3 = (): V3 => ({ x: 0, y: 0, z: 0 });
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : 0);
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

interface SessionState {
  seed: number;
  hold: HoldMode;
  holdQ: Quat | null;
  targetId: string | null;
  predFrame: string | null;
  burns: PlannedBurn[];
  burnSeq: number;
  throttle: number;
  rearmBlock: boolean;
  settled: boolean;
}

const galaxies = new Map<number, SystemDef>();
function startSystem(seed: number): SystemDef {
  let s = galaxies.get(seed);
  if (!s) {
    const g = generateGalaxy(seed);
    s = getSystem(g, START_SYSTEM_ID) ?? g.systems[0];
    galaxies.set(seed, s);
  }
  return s;
}

/**
 * The world at the start: the system at t = 0 and the player's Wren ahead of Chandler's Wheel in the same
 * orbit (the station's state turned about its orbit normal), at rest relative to it, nose toward it, full tanks.
 */
function buildWorld(system: SystemDef): World {
  const world = createWorld(system);
  const st = findCraft(world, START_STATION_ID) ?? world.craft.find((c) => c.kind === 'station') ?? null;
  if (!st) throw new Error('session: the start system has no station');
  const layout = SHIP_LAYOUTS.wren;
  const r = st.rel, v = st.relV;
  let hx = r.y * v.z - r.z * v.y, hy = r.z * v.x - r.x * v.z, hz = r.x * v.y - r.y * v.x;
  const hl = Math.hypot(hx, hy, hz);
  hx /= hl; hy /= hl; hz /= hl;
  const rl = Math.hypot(r.x, r.y, r.z);
  const d = st.radius + START_CLEARANCE;
  const th = 2 * Math.asin(d / (2 * rl)), c = Math.cos(th), s = Math.sin(th);
  // r and v are perpendicular to h: Rodrigues reduces to a·cos + (h × a)·sin.
  const turn = (a: V3): V3 => ({ x: a.x * c + (hy * a.z - hz * a.y) * s, y: a.y * c + (hz * a.x - hx * a.z) * s, z: a.z * c + (hx * a.y - hy * a.x) * s });
  const pr = turn(r), pv = turn(v);
  const q = qLook({ x: r.x - pr.x, y: r.y - pr.y, z: r.z - pr.z }, { x: hx, y: hy, z: hz });
  const ship = addCraft(world, shipDef(PLAYER_ID, 'Wren', computeStats(defaultLoadout('wren')), layout, { primaryId: world.bodies[st.primary].id, r: pr, v: pv, q }));
  ship.visualSeed = 7;
  return world;
}

class WorldSession implements Session {
  readonly events = new EventBus<SessionEvents>();
  readonly system: SystemDef;
  private readonly seed: number;
  private readonly budgetMs: number;
  private world!: World;
  private ship!: Craft;

  // pilot input
  private pitch = 0;
  private yaw = 0;
  private roll = 0;
  private throttle = 0;
  private readonly translate = v3();
  private hold: HoldMode = 'stability';
  private holdQ: Quat = { x: 0, y: 0, z: 0, w: 1 };
  private holdQValid = false;
  private settled = false;
  private rearmBlock = false;

  // time acceleration
  private warpIndex = 0;
  private readonly winSim = new Float64Array(WARP_WINDOW);
  private readonly winReal = new Float64Array(WARP_WINDOW);
  private winN = 0;
  private winAt = 0;
  private limitFrames = 0;
  private clock = 0;
  private readonly info: StepInfo = { simDt: 0, simMs: 0, steps: 0, limitedBy: '' };
  private readonly warpView: WarpView = { requested: 1, achieved: 1, limitedBy: '' };
  private readonly advOpts: AdvanceOptions = { budgetMs: 3, now };

  // target, planned burns, prediction
  private targetId: string | null = null;
  private burnList: PlannedBurn[] = [];
  private burnSeq = 0;
  private predFrame: string | null = null;
  private readonly predictor = new Predictor();
  private readonly work = createPrediction(PREDICT_POINTS, 48);
  private readonly predOpts: PredictOptions = { duration: 0, maxPoints: PREDICT_POINTS, frameBodyId: null, burns: [], targetCraftId: null };
  private readonly pred: PredictionView = { version: 0, frameBodyId: '', points: this.work.points, count: 0, targetPoints: this.work.targetPoints, targetCount: 0, events: [], horizon: 0 };
  private predDirty = true;
  private predClock = -1e9;
  private predT = NaN;
  private predThrust = false;

  // views (reused between calls)
  private bodyViews: BodyView[] = [];
  private craftViews: CraftView[] = [];
  private readonly flightView: FlightView = {
    primaryId: '', primaryName: '', situation: 'orbit', altitude: 0, speed: 0, verticalSpeed: 0, surfaceSpeed: 0, apoapsisAlt: 0, periapsisAlt: 0,
    timeToApoapsis: 0, timeToPeriapsis: 0, period: 0, inclination: 0, eccentricity: 0, accel: 0, airDensity: 0, dynamicPressure: 0,
  };
  private readonly playerView: PlayerView = {
    craftId: PLAYER_ID, name: '', mass: 0, propellant: 0, propellantFraction: 0, deltaV: 0, maxAccel: 0, throttle: 0, hold: 'stability', heat: 0, hull: 1,
    destroyed: false, destroyedBy: '', dockedTo: null, spin: 0,
  };
  private readonly targetView: TargetView = { id: '', name: '', kind: 'craft', distance: 0, relSpeed: 0, closing: 0, direction: v3(), relVelocity: v3() };
  private readonly dockView: DockingView = {
    stationId: null, distance: Infinity, relSpeed: 0, portId: null, portOffset: v3(), portAxis: v3(), portDistance: Infinity, alignment: 0, lateral: 0,
    closing: 0, canLatch: false, dockedTo: null,
  };

  // scratch
  private readonly I = v3();
  private readonly ERR = v3();
  private readonly WFF = v3();
  private readonly WE = v3();
  private readonly D = v3();
  private readonly OM = v3();
  private readonly A = v3();

  constructor(system: SystemDef, world: World, opts: SessionOptions, seed: number, state?: SessionState) {
    this.system = system;
    this.seed = seed;
    this.budgetMs = opts.budgetMs ?? 3;
    this.bind(world);
    if (state) {
      this.hold = state.hold;
      if (state.holdQ) { this.holdQ = { ...state.holdQ }; this.holdQValid = true; }
      this.targetId = state.targetId;
      this.predFrame = state.predFrame;
      this.burnList = state.burns.map((b) => ({ ...b }));
      this.burnSeq = state.burnSeq;
      this.throttle = state.throttle;
      this.rearmBlock = state.rearmBlock;
      this.settled = state.settled;
    } else this.targetId = findCraft(world, START_STATION_ID) ? START_STATION_ID : null;
  }

  private bind(world: World): void {
    const ship = findCraft(world, PLAYER_ID);
    if (!ship) throw new Error('session: the world has no player craft');
    this.world = world;
    this.ship = ship;
    const defs = this.system.bodies;
    this.bodyViews = world.bodies.map((b, i) => ({ id: b.id, def: defs[i] && defs[i].id === b.id ? defs[i] : defs.find((d) => d.id === b.id)!, r: v3(), v: v3(), spinAxis: { ...b.spinAxis }, spinAngle: 0 }));
    this.craftViews = world.craft.map((c) => ({
      id: c.id, name: c.name, kind: c.kind, shipVisual: c.shipVisual as ShipVisualId | null, stationVisual: c.stationVisual as StationVisualId | null,
      visualSeed: c.visualSeed, r: v3(), v: v3(), q: { x: 0, y: 0, z: 0, w: 1 }, throttle: 0, rcs: v3(), heat: 0, hull: 1, isPlayer: c.id === PLAYER_ID,
      dockedTo: null, radius: c.radius,
    }));
    this.predDirty = true;
    this.settled = false;
    this.winN = this.winAt = 0;
    this.limitFrames = 0;
  }

  // ------------------------------------------------------------------------------------------ stepping

  step(realDt: number): StepInfo {
    const info = this.info;
    info.simDt = 0; info.simMs = 0; info.steps = 0; info.limitedBy = '';
    if (!(realDt > 0)) return info;
    if (realDt > 0.1) realDt = 0.1;
    const world = this.world;
    const start = now();
    const want = realDt * WARP_LADDER[this.warpIndex];
    const budget = this.budgetMs;
    this.clock += realDt;
    this.arm();
    let why: WarpLimit = '';
    for (let guard = 0; guard < 1e6; guard++) {
      const left = want - info.simDt;
      if (!(left > 1e-7)) break;
      const active = this.command();
      this.advOpts.budgetMs = budget - (now() - start);
      const res = advance(world, active && left > CONTROL_DT ? CONTROL_DT : left, this.advOpts);
      info.simDt += res.simDt;
      info.steps += res.steps;
      const limited = res.limitedBy;
      if (world.events.length > 0) this.pump();
      if (limited !== '') { why = limited; break; }
      if (want - info.simDt > 1e-7 && now() - start > budget) {
        const c = this.ship;
        why = active ? 'rotation' : c.propellant > 0 && c.dockedTo === null && (c.throttle > 0 || c.rcs.x !== 0 || c.rcs.y !== 0 || c.rcs.z !== 0) ? 'thrust' : 'cpu';
        break;
      }
    }
    info.simMs = now() - start;
    info.limitedBy = why;
    // achieved multiplier over the last frames
    const i = this.winAt;
    this.winSim[i] = info.simDt;
    this.winReal[i] = realDt;
    this.winAt = (i + 1) % WARP_WINDOW;
    if (this.winN < WARP_WINDOW) this.winN++;
    if (why !== '') { this.warpView.limitedBy = why; this.limitFrames = LIMIT_STICKY; }
    else if (this.limitFrames > 0 && --this.limitFrames === 0) this.warpView.limitedBy = '';
    return info;
  }

  time(): number {
    return this.world.t;
  }

  /** Keep the docking latch armed near a station (and open for a moment after an undock). */
  private arm(): void {
    const c = this.ship;
    if (c.destroyed || c.dockedTo !== null) return;
    const d = dockingStatus(this.world, PLAYER_ID);
    if (this.rearmBlock && (d.portId === null || d.portDistance > REARM_DISTANCE)) this.rearmBlock = false;
    let armed = false;
    if (!this.rearmBlock && d.stationId !== null) {
      const st = findCraft(this.world, d.stationId);
      armed = st !== null && d.distance < st.radius + ARM_RANGE;
    }
    c.dockingArmed = armed;
  }

  /** Pilot input and the attitude hold -> commands on the craft. True while the attitude controller is working. */
  private command(): boolean {
    const c = this.ship;
    if (c.destroyed) return false;
    const tq = c.torque, tr = this.translate;
    if (c.dockedTo !== null) {
      // The latch interlocks drive and RCS; the joint carries the attitude.
      c.throttle = 0;
      c.rcs.x = c.rcs.y = c.rcs.z = 0;
      tq.x = tq.y = tq.z = 0;
      this.holdQValid = false;
      this.settled = false;
      return false;
    }
    c.throttle = this.throttle;
    c.rcs.x = tr.x; c.rcs.y = tr.y; c.rcs.z = tr.z;
    if (c.landedOn !== null) {
      tq.x = tq.y = tq.z = 0;
      this.holdQValid = false;
      this.settled = false;
      return false;
    }
    const p = this.pitch, y = this.yaw, r = this.roll;
    const stick = Math.abs(p) > STICK_DEADZONE || Math.abs(y) > STICK_DEADZONE || Math.abs(r) > STICK_DEADZONE;
    if (this.hold === 'off') {
      // Raw torque demand: pitch about +X (nose up), yaw about -Y (nose right), roll about -Z (clockwise).
      tq.x = stick ? p : 0; tq.y = stick ? -y : 0; tq.z = stick ? -r : 0;
      return stick;
    }
    const I = craftInertia(c, this.I), ERR = this.ERR, WE = this.WE, w = c.w;
    if (stick) {
      // The stick overrides the hold: a rate demand, met with real torque.
      this.settled = false;
      this.holdQValid = false;
      ERR.x = ERR.y = ERR.z = 0;
      WE.x = w.x - p * STICK_RATE; WE.y = w.y + y * STICK_RATE; WE.z = w.z + r * STICK_RATE;
      holdTorque(ERR, WE, I, c.maxTorque, tq);
      return true;
    }
    this.holdTarget();
    const WFF = this.WFF;
    WE.x = w.x - WFF.x; WE.y = w.y - WFF.y; WE.z = w.z - WFF.z;
    const th = Math.sqrt(ERR.x * ERR.x + ERR.y * ERR.y + ERR.z * ERR.z);
    const we = Math.sqrt(WE.x * WE.x + WE.y * WE.y + WE.z * WE.z);
    if (this.settled) {
      const warp = WARP_LADDER[this.warpIndex];
      if (warp < SUSPEND_WARP && (th > (warp >= LOOSE_WARP ? WAKE_ANGLE_LOOSE : WAKE_ANGLE) || we > WAKE_RATE)) this.settled = false;
    } else if (th < SETTLE_ANGLE && we < SETTLE_RATE) this.settled = true;
    if (this.settled) {
      // Deadband: a settled ship commands nothing, so it coasts and time acceleration is free.
      tq.x = tq.y = tq.z = 0;
      return false;
    }
    holdTorque(ERR, WE, I, c.maxTorque, tq);
    return true;
  }

  /** Attitude error (ERR, local rotation vector) and the rate the target itself turns at (WFF, local) for the hold. */
  private holdTarget(): void {
    const c = this.ship, ERR = this.ERR, WFF = this.WFF, D = this.D, OM = this.OM;
    ERR.x = ERR.y = ERR.z = 0;
    WFF.x = WFF.y = WFF.z = 0;
    OM.x = OM.y = OM.z = 0;
    let mode = this.hold;
    if (mode === 'dock') {
      const d = dockingStatus(this.world, PLAYER_ID);
      if (d.portId !== null && c.dockPort) {
        // Shortest turn that takes the collar axis onto the reversed port axis (roll about it stays free).
        const a = qRot(this.A, c.q, c.dockPort.dir.x, c.dockPort.dir.y, c.dockPort.dir.z);
        const bx = -d.portAxis.x, by = -d.portAxis.y, bz = -d.portAxis.z;
        const cx = a.y * bz - a.z * by, cy = a.z * bx - a.x * bz, cz = a.x * by - a.y * bx;
        const s = Math.sqrt(cx * cx + cy * cy + cz * cz), co = a.x * bx + a.y * by + a.z * bz;
        if (s > 1e-9) {
          const k = Math.atan2(s, co) / s;
          qRotInv(ERR, c.q, cx * k, cy * k, cz * k);
        } else if (co < 0) {
          const dd = c.dockPort.dir;
          if (Math.abs(dd.x) < 0.9) { ERR.x = Math.PI; } else { ERR.y = Math.PI; }
        }
        this.holdQValid = false;
        return;
      }
      mode = 'stability';
    }
    if (mode === 'stability') {
      const w = c.w;
      if (!this.holdQValid && w.x * w.x + w.y * w.y + w.z * w.z < CAPTURE_RATE * CAPTURE_RATE) {
        const q = c.q, h = this.holdQ;
        h.x = q.x; h.y = q.y; h.z = q.z; h.w = q.w;
        this.holdQValid = true;
      }
      if (this.holdQValid) attitudeError(c.q, this.holdQ, ERR);
      return;
    }
    this.holdQValid = false;
    const r = c.rel, v = c.relV;
    const hx = r.y * v.z - r.z * v.y, hy = r.z * v.x - r.x * v.z, hz = r.x * v.y - r.y * v.x;
    const r2 = r.x * r.x + r.y * r.y + r.z * r.z, v2 = v.x * v.x + v.y * v.y + v.z * v.z;
    const sign = mode === 'retrograde' || mode === 'antinormal' || mode === 'radialIn' || mode === 'antiTarget' ? -1 : 1;
    D.x = D.y = D.z = 0;
    switch (mode) {
      case 'retrograde':
      case 'prograde':
        D.x = v.x; D.y = v.y; D.z = v.z;
        this.progradeRate(hx, hy, hz, r2, v2);
        break;
      case 'antinormal':
      case 'normal':
        D.x = hx; D.y = hy; D.z = hz;
        break;
      case 'radialIn':
      case 'radialOut':
        D.x = r.x; D.y = r.y; D.z = r.z;
        if (r2 > 0) { OM.x = hx / r2; OM.y = hy / r2; OM.z = hz / r2; }
        break;
      case 'antiTarget':
      case 'target': {
        const t = this.targetState();
        if (t) {
          const dx = t.r.x - c.r.x, dy = t.r.y - c.r.y, dz = t.r.z - c.r.z;
          const ux = t.v.x - c.v.x, uy = t.v.y - c.v.y, uz = t.v.z - c.v.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          D.x = dx; D.y = dy; D.z = dz;
          if (d2 > 0) { OM.x = (dy * uz - dz * uy) / d2; OM.y = (dz * ux - dx * uz) / d2; OM.z = (dx * uy - dy * ux) / d2; }
        }
        break;
      }
      case 'burn': {
        const b = this.nextBurn();
        const vl = Math.sqrt(v2), hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
        if (b && vl > 0 && hl > 0) {
          // Same basis the prediction applies the impulse in: prograde, orbit normal, radial-out = prograde × normal.
          const px = v.x / vl, py = v.y / vl, pz = v.z / vl, nx = hx / hl, ny = hy / hl, nz = hz / hl;
          const ox = py * nz - pz * ny, oy = pz * nx - px * nz, oz = px * ny - py * nx;
          D.x = b.prograde * px + b.normal * nx + b.radial * ox;
          D.y = b.prograde * py + b.normal * ny + b.radial * oy;
          D.z = b.prograde * pz + b.normal * nz + b.radial * oz;
          this.progradeRate(hx, hy, hz, r2, v2);
        }
        break;
      }
      default:
        break;
    }
    const dl = Math.sqrt(D.x * D.x + D.y * D.y + D.z * D.z);
    if (!(dl > 1e-9)) return; // nothing to point at: damp rotation only
    D.x *= sign / dl; D.y *= sign / dl; D.z *= sign / dl;
    pointingError(c.q, D, ERR);
    qRotInv(WFF, c.q, OM.x, OM.y, OM.z);
  }

  /** Rate at which the velocity direction turns under the primary's pull: (v × g) / v². */
  private progradeRate(hx: number, hy: number, hz: number, r2: number, v2: number): void {
    // v × (−μ r / r³) = μ (r × v) / r³
    if (!(r2 > 0 && v2 > 0)) return;
    const k = this.world.bodies[this.ship.primary].mu / (r2 * Math.sqrt(r2) * v2);
    this.OM.x = hx * k; this.OM.y = hy * k; this.OM.z = hz * k;
  }

  private nextBurn(): PlannedBurn | null {
    const t = this.world.t - BURN_GRACE;
    let next: PlannedBurn | null = null;
    const bs = this.burnList;
    for (let i = 0; i < bs.length; i++) if (bs[i].t >= t && (!next || bs[i].t < next.t)) next = bs[i];
    return next;
  }

  /** Barycentric state of the target (a world body or craft), or null. */
  private targetState(): { r: V3; v: V3; name: string; craft: boolean } | null {
    const id = this.targetId;
    if (id === null) return null;
    const w = this.world;
    for (let i = 0; i < w.craft.length; i++) if (w.craft[i].id === id) { TS.r = w.craft[i].r; TS.v = w.craft[i].v; TS.name = w.craft[i].name; TS.craft = true; return TS; }
    for (let i = 0; i < w.bodies.length; i++) if (w.bodies[i].id === id) { TS.r = w.bodies[i].r; TS.v = w.bodies[i].v; TS.name = w.bodies[i].name; TS.craft = false; return TS; }
    return null;
  }

  /** World events -> session events (the player's only). */
  private pump(): void {
    const out = this.events;
    for (const e of drainEvents(this.world)) {
      if (e.craftId !== PLAYER_ID) continue;
      switch (e.type) {
        case 'docked':
          this.throttle = 0;
          this.predDirty = true;
          out.emit('docked', { stationId: e.stationId, portId: e.portId });
          break;
        case 'undocked': this.predDirty = true; out.emit('undocked', { stationId: e.stationId }); break;
        case 'impact': this.predDirty = true; out.emit('impact', { speed: e.speed, with: e.with }); break;
        case 'destroyed': this.throttle = 0; out.emit('destroyed', { cause: e.cause }); break;
        case 'atmosphere': out.emit('atmosphere', { bodyId: e.bodyId, entered: e.entered }); break;
        case 'primaryChanged': this.predDirty = true; out.emit('primaryChanged', { from: e.from, to: e.to }); break;
        case 'landed': this.predDirty = true; out.emit('landed', { bodyId: e.bodyId }); break;
        default: break;
      }
    }
  }

  // ------------------------------------------------------------------------------------------ time acceleration

  warp(): WarpView {
    const w = this.warpView;
    w.requested = WARP_LADDER[this.warpIndex];
    let sim = 0, real = 0;
    for (let i = 0; i < this.winN; i++) { sim += this.winSim[i]; real += this.winReal[i]; }
    w.achieved = real > 0 ? sim / real : w.requested;
    return w;
  }
  setWarp(multiplier: number): void {
    let best = 0;
    const m = Math.log(Math.max(1, multiplier));
    for (let i = 1; i < WARP_LADDER.length; i++) if (Math.abs(Math.log(WARP_LADDER[i]) - m) < Math.abs(Math.log(WARP_LADDER[best]) - m)) best = i;
    this.setWarpIndex(best);
  }
  warpUp(): void {
    this.setWarpIndex(this.warpIndex + 1);
  }
  warpDown(): void {
    this.setWarpIndex(this.warpIndex - 1);
  }
  private setWarpIndex(i: number): void {
    i = clamp(i, 0, WARP_LADDER.length - 1);
    if (i === this.warpIndex) return;
    this.warpIndex = i;
    this.settled = false; // the hold looks again (and tightens up when time slows down)
    // the read-out answers at once
    this.winN = this.winAt = 0;
    this.limitFrames = 0;
    this.warpView.limitedBy = '';
  }

  // ------------------------------------------------------------------------------------------ input

  setControls(c: { pitch?: number; yaw?: number; roll?: number; throttle?: number; translate?: V3 }): void {
    if (c.pitch !== undefined) this.pitch = clamp(c.pitch, -1, 1) || 0;
    if (c.yaw !== undefined) this.yaw = clamp(c.yaw, -1, 1) || 0;
    if (c.roll !== undefined) this.roll = clamp(c.roll, -1, 1) || 0;
    if (c.throttle !== undefined) {
      const t = clamp(c.throttle, 0, 1) || 0;
      if (t > 0 && this.throttle === 0) this.settled = false; // point properly before the drive lights
      this.throttle = t;
    }
    if (c.translate) {
      this.translate.x = clamp(c.translate.x, -1, 1) || 0;
      this.translate.y = clamp(c.translate.y, -1, 1) || 0;
      this.translate.z = clamp(c.translate.z, -1, 1) || 0;
    }
  }
  setHold(mode: HoldMode): void {
    if (mode === this.hold) return;
    this.hold = mode;
    this.holdQValid = false;
    this.settled = false;
  }

  // ------------------------------------------------------------------------------------------ views

  bodies(): readonly BodyView[] {
    const bs = this.world.bodies, out = this.bodyViews;
    for (let i = 0; i < out.length; i++) {
      const b = bs[i], o = out[i];
      o.r.x = b.r.x; o.r.y = b.r.y; o.r.z = b.r.z;
      o.v.x = b.v.x; o.v.y = b.v.y; o.v.z = b.v.z;
      o.spinAngle = b.spinAngle;
    }
    return out;
  }
  craft(): readonly CraftView[] {
    const cs = this.world.craft, out = this.craftViews;
    for (let i = 0; i < out.length; i++) {
      const c = cs[i], o = out[i];
      o.r.x = c.r.x; o.r.y = c.r.y; o.r.z = c.r.z;
      o.v.x = c.v.x; o.v.y = c.v.y; o.v.z = c.v.z;
      o.q.x = c.q.x; o.q.y = c.q.y; o.q.z = c.q.z; o.q.w = c.q.w;
      const live = !c.destroyed && c.propellant > 0 && c.dockedTo === null;
      o.throttle = live ? clamp(c.throttle, 0, 1) : 0;
      o.rcs.x = live ? c.rcs.x : 0; o.rcs.y = live ? c.rcs.y : 0; o.rcs.z = live ? c.rcs.z : 0;
      o.heat = c.heatCapacity > 0 ? c.heat / c.heatCapacity : 0;
      o.hull = c.hull;
      o.dockedTo = c.dockedTo;
    }
    return out;
  }
  player(): PlayerView {
    const c = this.ship, o = this.playerView;
    const m = c.dryMass + c.propellant;
    o.name = c.name;
    o.mass = m;
    o.propellant = c.propellant;
    o.propellantFraction = c.propellantCapacity > 0 ? c.propellant / c.propellantCapacity : 0;
    o.deltaV = c.propellant > 0 ? c.exhaustVelocity * Math.log(m / c.dryMass) : 0;
    o.maxAccel = c.propellant > 0 ? c.mainThrust / m : 0;
    o.throttle = this.throttle;
    o.hold = this.hold;
    o.heat = c.heatCapacity > 0 ? c.heat / c.heatCapacity : 0;
    o.hull = c.hull;
    o.destroyed = c.destroyed;
    o.destroyedBy = c.destroyedBy;
    o.dockedTo = c.dockedTo;
    o.spin = Math.sqrt(c.w.x * c.w.x + c.w.y * c.w.y + c.w.z * c.w.z);
    return o;
  }
  flight(): FlightView {
    const f = flightReadout(this.world, PLAYER_ID), o = this.flightView;
    o.primaryId = f.primaryId;
    o.primaryName = this.world.bodies[f.primary].name;
    o.situation = f.situation;
    o.altitude = f.altitude;
    o.speed = f.speed;
    o.verticalSpeed = f.verticalSpeed;
    o.surfaceSpeed = f.surfaceSpeed;
    o.apoapsisAlt = f.apoapsisAlt;
    o.periapsisAlt = f.periapsisAlt;
    o.timeToApoapsis = f.timeToApoapsis;
    o.timeToPeriapsis = f.timeToPeriapsis;
    o.period = f.period;
    o.inclination = f.inclination;
    o.eccentricity = f.eccentricity;
    o.accel = f.accel;
    o.airDensity = f.airDensity;
    o.dynamicPressure = f.dynamicPressure;
    return o;
  }

  setTarget(id: string | null): void {
    if (id === PLAYER_ID) id = null;
    this.targetId = id;
    if (id !== null && this.targetState() === null) this.targetId = null;
    this.predDirty = true;
    if (this.hold === 'target' || this.hold === 'antiTarget') this.settled = false;
  }
  target(): TargetView | null {
    const t = this.targetState();
    if (!t) return null;
    const c = this.ship, o = this.targetView;
    const dx = t.r.x - c.r.x, dy = t.r.y - c.r.y, dz = t.r.z - c.r.z;
    const ux = t.v.x - c.v.x, uy = t.v.y - c.v.y, uz = t.v.z - c.v.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    o.id = this.targetId!;
    o.name = t.name;
    o.kind = t.craft ? 'craft' : 'body';
    o.distance = d;
    o.relSpeed = Math.sqrt(ux * ux + uy * uy + uz * uz);
    o.closing = d > 0 ? -(dx * ux + dy * uy + dz * uz) / d : 0;
    const k = d > 0 ? 1 / d : 0;
    o.direction.x = dx * k; o.direction.y = dy * k; o.direction.z = dz * k;
    o.relVelocity.x = ux; o.relVelocity.y = uy; o.relVelocity.z = uz;
    return o;
  }

  // ------------------------------------------------------------------------------------------ prediction

  prediction(): PredictionView {
    const world = this.world, c = this.ship, view = this.pred;
    const thrust = !c.destroyed && c.dockedTo === null && c.propellant > 0 && (c.throttle > 0 || c.rcs.x !== 0 || c.rcs.y !== 0 || c.rcs.z !== 0);
    if (thrust !== this.predThrust) { this.predThrust = thrust; this.predDirty = true; }
    if (!this.predDirty && (world.t === this.predT || this.clock - this.predClock < PREDICT_INTERVAL)) return view;
    this.predDirty = false;
    this.predClock = this.clock;
    this.predT = world.t;

    // About three orbits of the current path, long enough to show every planned burn, inside the ephemeris ring.
    const b = world.bodies[c.primary];
    const f = flightReadout(world, PLAYER_ID);
    const r = Math.hypot(c.rel.x, c.rel.y, c.rel.z);
    const bound = Number.isFinite(f.period) && f.period > 0;
    const turn = bound ? f.period : 2 * Math.PI * Math.sqrt((r * r * r) / b.mu);
    let duration = bound ? 3 * turn : Math.max(3 * turn, (4 * Math.min(b.hill, 50 * r)) / Math.max(1, f.speed));
    const burns = this.burnList;
    for (let i = 0; i < burns.length; i++) if (burns[i].t >= world.t && burns[i].t - world.t + 1.5 * turn > duration) duration = burns[i].t - world.t + 1.5 * turn;
    const eph = ephemerisOf(world);
    const cap = 0.8 * eph.capacity * world.h;
    if (duration > cap) duration = cap;

    const o = this.predOpts, work = this.work;
    o.duration = duration;
    o.frameBodyId = this.predFrame;
    o.burns = burns;
    const t = this.targetState();
    o.targetCraftId = t && t.craft ? this.targetId : null;
    this.predictor.start(world, PLAYER_ID, o, work);
    this.predictor.run(PREDICT_BUDGET_MS, now);
    view.version++;
    view.frameBodyId = world.bodies[work.frameBody].id;
    view.count = work.count;
    view.targetCount = work.targetCount;
    view.horizon = work.horizon;
    const ev: PredictionEvent[] = [];
    for (let i = 0; i < work.eventCount; i++) ev.push(predictionEvent(work, i));
    view.events = ev;
    return view;
  }
  setPredictionFrame(bodyId: string | null): void {
    if (bodyId !== null && !this.world.bodies.some((b) => b.id === bodyId)) bodyId = null;
    if (bodyId === this.predFrame) return;
    this.predFrame = bodyId;
    this.predDirty = true;
  }
  burns(): readonly PlannedBurn[] {
    return this.burnList;
  }
  addBurn(t: number, dv: { prograde?: number; normal?: number; radial?: number } = {}): string {
    const id = `burn-${++this.burnSeq}`;
    this.burnList.push({ id, t, prograde: dv.prograde ?? 0, normal: dv.normal ?? 0, radial: dv.radial ?? 0 });
    this.burnsChanged();
    return id;
  }
  updateBurn(id: string, patch: Partial<Omit<PlannedBurn, 'id'>>): void {
    const b = this.burnList.find((x) => x.id === id);
    if (!b) return;
    if (patch.t !== undefined && Number.isFinite(patch.t)) b.t = patch.t;
    if (patch.prograde !== undefined && Number.isFinite(patch.prograde)) b.prograde = patch.prograde;
    if (patch.normal !== undefined && Number.isFinite(patch.normal)) b.normal = patch.normal;
    if (patch.radial !== undefined && Number.isFinite(patch.radial)) b.radial = patch.radial;
    this.burnsChanged();
  }
  removeBurn(id: string): void {
    const i = this.burnList.findIndex((x) => x.id === id);
    if (i < 0) return;
    this.burnList.splice(i, 1);
    this.burnsChanged();
  }
  clearBurns(): void {
    if (this.burnList.length === 0) return;
    this.burnList.length = 0;
    this.burnsChanged();
  }
  private burnsChanged(): void {
    this.predDirty = true;
    if (this.hold === 'burn') this.settled = false;
  }

  // ------------------------------------------------------------------------------------------ docking

  docking(): DockingView {
    const d = dockingStatus(this.world, PLAYER_ID), o = this.dockView;
    o.stationId = d.stationId;
    o.distance = d.distance;
    o.relSpeed = d.relSpeed;
    o.portId = d.portId;
    o.dockedTo = d.dockedTo;
    o.canLatch = d.canLatch && this.ship.dockingArmed;
    o.closing = 0;
    if (d.portId !== null) {
      const po = d.portOffset;
      o.portOffset.x = po.x; o.portOffset.y = po.y; o.portOffset.z = po.z;
      o.portAxis.x = d.portAxis.x; o.portAxis.y = d.portAxis.y; o.portAxis.z = d.portAxis.z;
      o.portDistance = d.portDistance;
      o.alignment = d.alignment;
      o.lateral = d.lateral;
      const st = d.stationId !== null ? findCraft(this.world, d.stationId) : null;
      const l = Math.sqrt(po.x * po.x + po.y * po.y + po.z * po.z);
      if (st && l > 1e-9) {
        const c = this.ship;
        o.closing = ((c.v.x - st.v.x) * po.x + (c.v.y - st.v.y) * po.y + (c.v.z - st.v.z) * po.z) / l;
      }
    } else {
      o.portOffset.x = o.portOffset.y = o.portOffset.z = 0;
      o.portAxis.x = o.portAxis.y = o.portAxis.z = 0;
      o.portDistance = Infinity;
      o.alignment = 0;
      o.lateral = 0;
    }
    return o;
  }
  undock(): boolean {
    if (!undock(this.world, PLAYER_ID)) return false;
    this.rearmBlock = true;
    this.settled = false;
    this.predDirty = true;
    this.pump();
    return true;
  }

  // ------------------------------------------------------------------------------------------ life cycle

  reset(): void {
    this.bind(buildWorld(this.system));
    this.pitch = this.yaw = this.roll = this.throttle = 0;
    this.translate.x = this.translate.y = this.translate.z = 0;
    this.hold = 'stability';
    this.holdQValid = false;
    this.rearmBlock = false;
    this.warpIndex = 0;
    this.warpView.limitedBy = '';
    this.targetId = START_STATION_ID;
    if (this.targetState() === null) this.targetId = null;
    this.burnList.length = 0;
    this.predFrame = null;
    this.events.emit('reset', {});
  }
  save(): string {
    const state: SessionState = {
      seed: this.seed, hold: this.hold, holdQ: this.holdQValid ? { ...this.holdQ } : null, targetId: this.targetId, predFrame: this.predFrame,
      burns: this.burnList, burnSeq: this.burnSeq, throttle: this.throttle, rearmBlock: this.rearmBlock, settled: this.settled,
    };
    return JSON.stringify({ tidelock: SAVE_VERSION, session: state, world: saveWorld(this.world) });
  }
}

const TS: { r: V3; v: V3; name: string; craft: boolean } = { r: v3(), v: v3(), name: '', craft: false };

export function createSession(opts: SessionOptions = {}): Session {
  const seed = opts.seed ?? 1;
  const system = startSystem(seed);
  return new WorldSession(system, buildWorld(system), opts, seed);
}

/** Null when the text is not a save of this session. */
export function loadSession(json: string, opts: SessionOptions = {}): Session | null {
  try {
    const data = JSON.parse(json) as { tidelock?: number; session?: SessionState; world?: string };
    if (data.tidelock !== SAVE_VERSION || typeof data.world !== 'string' || !data.session) return null;
    const s = data.session;
    const world = loadWorld(data.world);
    const system = startSystem(typeof s.seed === 'number' ? s.seed : 1);
    if (world.bodies.length !== system.bodies.length || !findCraft(world, PLAYER_ID)) return null;
    return new WorldSession(system, world, opts, s.seed, {
      seed: s.seed, hold: s.hold ?? 'stability', holdQ: s.holdQ ?? null, targetId: s.targetId ?? null, predFrame: s.predFrame ?? null,
      burns: Array.isArray(s.burns) ? s.burns : [], burnSeq: s.burnSeq ?? 0, throttle: s.throttle ?? 0, rearmBlock: !!s.rearmBlock, settled: !!s.settled,
    });
  } catch {
    return null;
  }
}
