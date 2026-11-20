// The session: the thin layer between the client and the physical world (docs/ARCHITECTURE.md §1, api.ts).
// It owns no physics. It turns pilot input into thruster and torque commands on the player's craft, runs the
// attitude-hold controller (real torque, never a set orientation), asks the world to advance inside the frame
// budget, and offers read-only views of the world's state. Deterministic: the only clock it reads is the
// wall clock handed to advance() for the CPU budget.

import { EventBus } from '../core/events';
import type { Quat, ShipVisualId, StationVisualId, SystemDef, V3 } from '../core/types';
import { qLook } from '../core/vec';
import { COCKPITS, type CockpitLayout, type DeviceDef, type DeviceRole } from '../data/cockpit';
import { INTERIORS, type InteriorLayout } from '../data/interiors';
import { SHIP_LAYOUTS } from '../data/shipLayouts';
import { START_STATION_ID, START_SYSTEM_ID } from '../data/systems/layout';
import { computeStats, defaultLoadout, SHIPS } from '../sim/ships';
import { generateGalaxy, getSystem } from '../sim/universe';
import {
  addCraft, advanceTicks, attitudeError, craftInertia, createPrediction, createWorld, dockingStatus, drainEvents, ephemerisOf, findCraft,
  flightReadout, holdTorque, loadWorld, pointingError, predictionEvent, Predictor, qRot, qRotInv, saveWorld, shipDef, takeJolt, undock,
  type Prediction,
  TICK_HZ, worldTick, type Jolt, type Craft, type LimitedBy, type PredictOptions, type World,
} from '../world';
import { craftMass, eventRing } from '../world/state';
import { consumeLedger } from '../world/dynamics';
import { makeLedgerMean, type LedgerMean } from '../world/jets';
import { createEventRing, drain, type SimEvent } from '../world/events';
import { createDutyTape, tapeRecord, tapeReset, type DutyTape } from '../world/dutyTape';
import {
  createBodyTick, createSeatedBody, eyeOffsetOf, loadSeatedBody, saveSeatedBody, stepSeated, type BodyTick, type SeatedBody, type SeatKind,
} from '../world/crew';
import {
  craftMotion, createCrew, createDevice, createShipMotion, crewEye, crewFelt, CREW_COM, devGrab, devMove, devRelease, devTap, feltAt, findPrompt, leverValue, lookCrew,
  pushOffCrew, rockerValue, roomAt, sitCrew, standCrew, stepCrew, stepDevice, stickAxis,
  type CrewState, type DeviceState, type ShipMotion as ShipMotionT,
} from '../world';
import {
  reachAlong, bodyEvent, createPropsState, grab as propHandOn, loadPropsState, moveGrab, pickProp, propInfo, propViews, release as propHandOff,
  nextBodyEvent, savePropsState, stepProps, unstow, type PropsState, type PropView,
} from '../world/props';
import { FA_SPEED, FlightComputer, PLAYER_ID, type FlightDeviceIndex, type FlightHost } from './flight';
import type {
  BodyView, CraftView, CrewView, DeviceView, DockingView, FlightView, HoldMode, PlannedBurn, PlayerMode, PlayerView, PredictionEvent, PredictionView, Session, SessionEvents,
  SessionOptions, StepInfo, TargetView, WarpLimit, WarpView,
} from './api';

export { PLAYER_ID, FA_SPEED, FA_NUDGE, FA_RANGE } from './flight';
/** Time-acceleration ladder. */
export const WARP_LADDER: readonly number[] = [1, 2, 5, 10, 50, 100, 1000, 1e4, 1e5, 1e6];
/** The start: the ship's own bounding sphere this far clear of the station's, ahead of it in the same orbit, m. */
export const START_CLEARANCE = 200;

/** 4: wave 1 (two propellant pools, thruster state, the ledger, the seated body). Older saves load through migrate(). */
export const SAVE_VERSION = 4;
/** Longest real frame the session accepts, s (a longer gap is a hidden page: catchUp). */
const MAX_FRAME = 0.1;
/** D6: time missed while the page was hidden is caught up at this warp (on top), at most one sim day. */
const CATCHUP_WARP = 1e4;
const CATCHUP_MAX_TICKS = 86400 * 120;
/** The largest warp quantum, ticks (2^14 ≈ 137 s). */
const QUANTUM_MAX = 1 << 14;
/**
 * The work-unit budget (SIMULATION.md §1.2.1: Safari's clock is 1 ms coarse). A unit is a craft or body integration
 * step, a loose-object sub-step counts PROP_UNITS, and each step 1 for itself. The cost per unit is learnt from 2 s
 * means of the wall clock (default: 2 µs, the A16 estimate of node's ~1 µs); the clock is only a backstop.
 */
const UNIT_MS_DEFAULT = 0.002;
const UNIT_MS_MIN = 1e-5;
const UNIT_MS_MAX = 0.05;
const PROP_UNITS = 4;
const COST_WINDOW = 2;
const CLOCK_SLACK_MS = 2;
/**
 * Prediction (SIMULATION.md W1-A 3): a restart after a disturbance runs in slices of PREDICT_RESTART_MS, extension at
 * most PREDICT_EXTEND_MS a frame (a cap, not a spend), both counted in steps against the learnt cost per step
 * (default 3 µs, the A16 estimate). While thrusting the path restarts at most every PREDICT_INTERVAL real seconds.
 * The far end is extended once it falls PREDICT_SLACK of the horizon short. Held thrust is flown for ≤ 30 s.
 */
const PREDICT_INTERVAL = 0.5;
const PREDICT_RESTART_MS = 0.4; // + the start and the hand-over (≈ 0.1 ms) = the 0.5 ms a frame of the plan
const PREDICT_EXTEND_MS = 0.3;
const PREDICT_STEP_MS = 0.003;
const PREDICT_SLACK = 0.002;
const PREDICT_THRUST_S = 30;
const PREDICT_REFRESH = 30;
/** Ghost steps per update of the cost-per-step estimate (a few frames of slices: the 1 ms clock averages out). */
const PREDICT_LEARN_STEPS = 400;
const PREDICT_POINTS = 512;
/** Frames the achieved time acceleration is averaged over, and frames a limit reason stays shown. */
const WARP_WINDOW = 20;
const LIMIT_STICKY = 20;
/** A planned burn stays "the next burn" for this long after its time, s. */
const BURN_GRACE = 300;
/** Time acceleration while the pilot sleeps in the bunk (within the world's limits). */
export const SLEEP_WARP = 1e4;
/** Lying still in the bunk this long (real seconds) is falling asleep. */
export const SLEEP_AFTER = 4;
/** The hand reaches a control this far from the eye or the body's middle, m (plus the control's own size). */
export const ARM_REACH = 0.9;
/** Standing this close to the pilot seat (plan distance), the pilot can sit down and fasten the harness, m. */
const SEAT_REACH = 1.2;
/** How far the head turns in the pilot seat, rad. */
const HEAD_YAW = 2.2;
const HEAD_PITCH = 1.1;
// Loose objects: while any is awake (or in hand) a step is no longer than props.ts nextBodyEvent allows (contact: one
// tick; drift and rest in closed form: their next event), so under time acceleration they are as honest as at 1x and
// the budget, not a shortcut, is what limits the warp ('props', 'crew'). Asleep they cost nothing.
/** Smoothing of the hand's velocity (what a released object is thrown with), s. */
const THROW_TAU = 0.05;
/** Its per-tick smoothing factor, 1 − e^(−Q/τ) (a constant: the hand is stepped at Q). */
const THROW_A = 1 - Math.exp(-1 / 120 / THROW_TAU);
/** Fastest an arm moves the hand toward where the finger points, m/s (a throw is at most this fast). */
const HAND_SPEED = 8;
const NO_PROPS: PropView[] = [];
/** Strapped in, the body's centre of mass sits this far below the eye (the felt point at the helm), m. */
const HELM_COM_BELOW_EYE = 0.65;
/** Where the IMU sits when the layout does not say (SIMULATION.md W1-A 8: under the cockpit deck), ship-local m. */
const IMU_DEFAULT: V3 = { x: 0, y: -1.2, z: -12.0 };
/** Hold lamps: the mode each one selects. */
const HOLD_OF: Partial<Record<DeviceRole, HoldMode>> = {
  holdOff: 'off', holdStability: 'stability', holdPrograde: 'prograde', holdRetrograde: 'retrograde', holdNormal: 'normal', holdAntinormal: 'antinormal',
  holdRadialOut: 'radialOut', holdRadialIn: 'radialIn', holdTarget: 'target', holdDock: 'dock',
};

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
  mode?: PlayerMode;
  crew?: CrewState | null;
  lights?: boolean;
  assist?: boolean;
  devices?: DeviceState[];
  pages?: number[];
  head?: number[];
  /** Loose objects (src/world/props.ts); absent in older saves: the objects start where the ship's data puts them. */
  props?: unknown;
  /** Wave 1: the seated body (crew.ts SeatedBody) and the pinch lean 0..1; absent in older saves (defaults: at rest, 0). */
  seated?: unknown;
  lean?: number;
  /**
   * Wave 1 (the fixed tick, SIMULATION.md §1.3): the latched inputs and the controller's state at the tick boundary the
   * save was made on — direct inputs [pitch, yaw, roll, tx, ty, tz], Flight Assist's axes and main-drive latch, its
   * last command, whether the controller worked at its last tick (the step grid), the time lain still in the bunk.
   * The tick itself is world.tick. Absent in older saves: all at rest.
   */
  ctl?: { in?: number[]; faOn?: boolean[]; faMain?: boolean; faFiring?: boolean; cmd?: number; active?: boolean; restT?: number };
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
  const d = st.radius + layout.radius + START_CLEARANCE;
  const th = 2 * Math.asin(d / (2 * rl)), c = Math.cos(th), s = Math.sin(th);
  // r and v are perpendicular to h: Rodrigues reduces to a·cos + (h × a)·sin.
  const turn = (a: V3): V3 => ({ x: a.x * c + (hy * a.z - hz * a.y) * s, y: a.y * c + (hz * a.x - hx * a.z) * s, z: a.z * c + (hx * a.y - hy * a.x) * s });
  const pr = turn(r), pv = turn(v);
  const q = qLook({ x: r.x - pr.x, y: r.y - pr.y, z: r.z - pr.z }, { x: hx, y: hy, z: hz });
  const ship = addCraft(world, shipDef(PLAYER_ID, 'Wren', computeStats(defaultLoadout('wren')), layout, { primaryId: world.bodies[st.primary].id, r: pr, v: pv, q, pad: SHIPS.wren.pad }));
  ship.visualSeed = 7;
  return world;
}

class WorldSession implements Session {
  readonly events = new EventBus<SessionEvents>();
  readonly system: SystemDef;
  private readonly seed: number;
  private budgetMs: number;
  private readonly nowFn: () => number;
  private unitMs: number;
  private readonly unitFixed: boolean;
  private costMs = 0;
  private costUnits = 0;
  private costReal = 0;
  // the fixed tick (SIMULATION.md §1.3): ticks owed to real time (fractional), hidden-page catch-up still owed, whether
  // the controller worked at its last tick (the 60 Hz grid limits the step), what cut the last step short, its steps
  private due = 0;
  private catchUpTicks = 0;
  private ctlActive = false;
  private stepWhy: WarpLimit = '';
  private stepSteps = 0;
  private busy: LimitedBy = '';
  private world!: World;
  private ship!: Craft;

  // the flight computer (src/game/flight.ts: pilot input, holds, Flight Assist, latch arming; W1-B's from day 3)
  private readonly fc: FlightComputer = new FlightComputer(this.flightHost());
  private readonly FV = v3();

  // time acceleration
  private warpIndex = 0;
  private readonly winSim = new Float64Array(WARP_WINDOW);
  private readonly winReal = new Float64Array(WARP_WINDOW);
  private winN = 0;
  private winAt = 0;
  private limitFrames = 0;
  private clock = 0;
  private readonly info: StepInfo = { simDt: 0, simMs: 0, steps: 0, units: 0, limitedBy: '' };
  private readonly warpView: WarpView = { requested: 1, achieved: 1, limitedBy: '' };

  // target, planned burns, prediction
  private targetId: string | null = null;
  private burnList: PlannedBurn[] = [];
  private burnSeq = 0;
  private predFrame: string | null = null;
  // the predictor: the shown (live) path, extended and trimmed; a fresh one computed beside it after a disturbance
  private live = new Predictor();
  private fresh = new Predictor();
  private liveWork = createPrediction(PREDICT_POINTS, 48);
  private freshWork = createPrediction(PREDICT_POINTS, 48);
  private readonly predOpts: PredictOptions = { duration: 0, maxPoints: PREDICT_POINTS, frameBodyId: null, burns: [], targetCraftId: null, thrust: null };
  private readonly predThrustOpt = { fx: 0, fy: 0, fz: 0, mdot: 0, until: 0 };
  private readonly pred: PredictionView = { version: 0, frameBodyId: '', points: this.liveWork.points, count: 0, targetPoints: this.liveWork.targetPoints, targetCount: 0, events: [], horizon: 0 };
  private predDirty = true;
  private predClock = -1e9;
  private predThrust = false;
  private predVisible = true;
  private freshBusy = false;
  private liveOk = false;
  private liveRunning = false;
  private predDuration = 0;
  private freshDuration = 0;
  private predStepMs = PREDICT_STEP_MS;
  private predMs = 0;
  private predSteps = 0;

  // views (reused between calls)
  private bodyViews: BodyView[] = [];
  private craftViews: CraftView[] = [];
  private readonly flightView: FlightView = {
    primaryId: '', primaryName: '', situation: 'orbit', altitude: 0, speed: 0, verticalSpeed: 0, surfaceSpeed: 0, apoapsisAlt: 0, periapsisAlt: 0,
    timeToApoapsis: 0, timeToPeriapsis: 0, period: 0, inclination: 0, eccentricity: 0, accel: 0, airDensity: 0, dynamicPressure: 0,
    specificForce: v3(), rcsPropellant: 0, rcsPropellantCapacity: 0,
  };
  private readonly playerView: PlayerView = {
    craftId: PLAYER_ID, name: '', mass: 0, propellant: 0, propellantFraction: 0, deltaV: 0, maxAccel: 0, throttle: 0, hold: 'stability', heat: 0, hull: 1,
    destroyed: false, destroyedBy: '', dockedTo: null, spin: 0, assist: 'off', assistRef: '', assistSpeed: 0, assistCmd: 0,
  };
  private readonly targetView: TargetView = { id: '', name: '', kind: 'craft', distance: 0, relSpeed: 0, closing: 0, direction: v3(), relVelocity: v3() };
  private readonly dockView: DockingView = {
    stationId: null, distance: Infinity, relSpeed: 0, portId: null, portOffset: v3(), portAxis: v3(), portDistance: Infinity, alignment: 0, lateral: 0,
    closing: 0, canLatch: false, dockedTo: null,
  };


  // the pilot's body
  private playerMode: PlayerMode = 'helm';
  private layout: InteriorLayout | null = null;
  private body: CrewState | null = null;
  private lights = true;
  private asleep = false;
  private sleptFrom = 0;
  private restT = 0;
  private headYaw = 0;
  private headPitch = 0;
  private readonly EYE = v3();

  // the physical controls (src/data/cockpit.ts, src/world/devices.ts) and what the flight computer last read
  private cockpitLayout: CockpitLayout | null = null;
  private devDefs: DeviceDef[] = [];
  private devs: DeviceState[] = [];
  private devViews: DeviceView[] = [];
  private devSeen: number[] = [];
  private devPage: number[] = [];
  private readonly hands = new Map<number, number>();
  private readonly ix: FlightDeviceIndex = { rot: -1, roll: -1, trans: -1, transZ: -1, throttle: -1, arm: -1, lights: -1, harness: -1, assist: -1 };
  private readonly walk = { moveX: 0, moveZ: 0 };
  private readonly motion = createShipMotion();
  private readonly jolt: Jolt = { dv: { x: 0, y: 0, z: 0 }, dw: { x: 0, y: 0, z: 0 }, n: 0 };
  private readonly promptView = { id: '', kind: '', label: '' };
  // loose objects and the hand on one
  private loose: PropsState | null = null;
  private propPointer = -1;
  private propId = '';
  private propDist = 0;
  private propPrevOk = false;
  private readonly propDir = v3();
  private readonly propTarget = v3();
  private readonly propPrev = v3();
  private readonly propVel = v3();
  private readonly PEYE = v3();
  private readonly crewView: CrewView = {
    mode: 'helm', posture: 'seated', pos: v3(), eye: v3(), yaw: 0, pitch: 0, vel: v3(), boots: true, gripped: false, roomId: '', roomName: '',
    felt: v3(), prompt: null, asleep: false, eyeOffset: v3(),
  };
  // wave 1 (SIMULATION.md §1.4): the tick's consumed ledger, the body steppers' tick context, the seated body, the
  // pinch lean, and the output-only records the senses read (the event ring lives with the world: state.ts eventRing)
  private readonly ledger: LedgerMean = makeLedgerMean();
  private tk: BodyTick = createBodyTick(this.ledger, createEventRing());
  private seated: SeatedBody = createSeatedBody();
  private leanT = 0;
  private readonly tape: DutyTape = createDutyTape();
  private readonly IMU = v3();
  private readonly EOFF = v3();

  constructor(system: SystemDef, world: World, opts: SessionOptions, seed: number, state?: SessionState) {
    this.system = system;
    this.seed = seed;
    this.budgetMs = opts.budgetMs ?? 3;
    this.nowFn = opts.now ?? now;
    this.unitFixed = typeof opts.unitMs === 'number' && opts.unitMs > 0;
    this.unitMs = this.unitFixed ? opts.unitMs! : UNIT_MS_DEFAULT;
    this.bind(world);
    if (state) {
      this.fc.hold = state.hold;
      if (state.holdQ) { const h = this.fc.holdQ, q = state.holdQ; h.x = q.x; h.y = q.y; h.z = q.z; h.w = q.w; this.fc.holdQValid = true; }
      this.targetId = state.targetId;
      this.predFrame = state.predFrame;
      this.burnList = state.burns.map((b) => ({ ...b }));
      this.burnSeq = state.burnSeq;
      this.fc.throttle = state.throttle;
      this.fc.rearmBlock = state.rearmBlock;
      this.fc.settled = state.settled;
      this.lights = state.lights !== false;
      this.fc.assist = state.assist === true;
      const num = (x: unknown): number => (typeof x === 'number' && x === x ? x : 0);
      if (Array.isArray(state.devices)) {
        for (const sd of state.devices) {
          const i = sd ? this.devIndex(sd.id) : -1;
          if (i < 0 || this.devs[i].kind !== sd.kind) continue;
          const d = this.devs[i];
          d.x = num(sd.x); d.y = num(sd.y); d.vx = num(sd.vx); d.vy = num(sd.vy); d.press = num(sd.press); d.latch = num(sd.latch);
          d.on = !!sd.on; d.made = !!sd.made; d.count = num(sd.count);
          this.devSeen[i] = d.count;
          const pages = this.devDefs[i].pages, pg = Array.isArray(state.pages) ? num(state.pages[i]) | 0 : 0;
          this.devPage[i] = pages && pg >= 0 && pg < pages.length ? pg : 0;
        }
      }
      if (this.ix.lights >= 0) this.lights = this.devs[this.ix.lights].on;
      if (state.props !== undefined && state.props !== null && this.loose) {
        const ps = loadPropsState(state.props);
        if (ps && ps.layoutId === this.loose.layoutId) this.loose = ps;
      }
      this.seated = loadSeatedBody(state.seated);
      const ctl = state.ctl && typeof state.ctl === 'object' ? state.ctl : null;
      if (ctl) {
        const fc = this.fc, inp = Array.isArray(ctl.in) ? ctl.in : [];
        fc.pitch = num(inp[0]); fc.yaw = num(inp[1]); fc.roll = num(inp[2]);
        fc.translate.x = num(inp[3]); fc.translate.y = num(inp[4]); fc.translate.z = num(inp[5]);
        if (Array.isArray(ctl.faOn)) for (let i = 0; i < 3; i++) fc.faOn[i] = !!ctl.faOn[i];
        fc.faMain = !!ctl.faMain; fc.faFiring = !!ctl.faFiring;
        fc.cmdThrottle = num(ctl.cmd);
        this.ctlActive = !!ctl.active;
        this.restT = num(ctl.restT);
      }
      this.leanT = typeof state.lean === 'number' && state.lean > 0 ? (state.lean < 1 ? state.lean : 1) : 0;
      if (Array.isArray(state.head)) { this.headYaw = clamp(num(state.head[0]), -HEAD_YAW, HEAD_YAW); this.headPitch = clamp(num(state.head[1]), -HEAD_PITCH, HEAD_PITCH); }
      const b = state.crew;
      if (state.mode === 'helm' || !this.layout) { this.playerMode = 'helm'; this.body = null; }
      else if (b && b.pos && b.vel && b.back && typeof b.yaw === 'number') {
        this.playerMode = 'onFoot';
        this.body = JSON.parse(JSON.stringify(b)) as CrewState;
      } else this.startPilot();
    } else {
      this.targetId = findCraft(world, START_STATION_ID) ? START_STATION_ID : null;
      this.startPilot();
    }
  }

  /** What the flight computer asks the session (time acceleration, the target, the next burn). */
  private flightHost(): FlightHost {
    const s = this as unknown as { mult(): number; targetId: string | null; nextBurn(): PlannedBurn | null; targetState(): ReturnType<FlightHost['targetState']> };
    return { mult: () => s.mult(), get targetId() { return s.targetId; }, nextBurn: () => s.nextBurn(), targetState: () => s.targetState() };
  }

  private bind(world: World): void {
    const ship = findCraft(world, PLAYER_ID);
    if (!ship) throw new Error('session: the world has no player craft');
    this.world = world;
    this.ship = ship;
    this.fc.world = world;
    this.fc.ship = ship;
    this.fc.ix = this.ix;
    this.layout = (ship.shipVisual && INTERIORS[ship.shipVisual as ShipVisualId]) || null;
    const defs = this.system.bodies;
    this.bodyViews = world.bodies.map((b, i) => ({ id: b.id, def: defs[i] && defs[i].id === b.id ? defs[i] : defs.find((d) => d.id === b.id)!, r: v3(), v: v3(), spinAxis: { ...b.spinAxis }, spinAngle: 0 }));
    this.craftViews = world.craft.map((c) => ({
      id: c.id, name: c.name, kind: c.kind, shipVisual: c.shipVisual as ShipVisualId | null, stationVisual: c.stationVisual as StationVisualId | null,
      visualSeed: c.visualSeed, r: v3(), v: v3(), q: { x: 0, y: 0, z: 0, w: 1 }, throttle: 0, rcs: v3(), heat: 0, hull: 1, isPlayer: c.id === PLAYER_ID,
      dockedTo: null, radius: c.radius,
      w: v3(), jetDuty: new Float64Array(c.jets.length), engineLevel: new Float64Array(c.engines.length), airVelocity: v3(), heatFlux: 0,
      jets: c.jets, engines: c.engines,
    }));
    this.tk = createBodyTick(this.ledger, eventRing(world));
    this.tk.tick = Math.round(world.t * 120);
    this.tk.q = ship.q;
    const imu = (ship.shipVisual && SHIP_LAYOUTS[ship.shipVisual as ShipVisualId]?.imuPos) || IMU_DEFAULT;
    this.IMU.x = imu.x; this.IMU.y = imu.y; this.IMU.z = imu.z;
    tapeReset(this.tape, 0, ship.jetDuty, ship.jets.length, this.tk.tick); // output only: a new world starts an empty tape
    this.predDirty = true;
    this.freshBusy = this.liveOk = this.liveRunning = false;
    this.pred.count = this.pred.targetCount = 0;
    (this.pred.events as PredictionEvent[]).length = 0;
    this.pred.version++;
    this.due = 0;
    this.ctlActive = false;
    this.fc.settled = false;
    this.winN = this.winAt = 0;
    this.limitFrames = 0;
    this.initDevices();
    this.loose = ship.shipVisual ? createPropsState(ship.shipVisual) : null;
    this.propPointer = -1;
    this.propId = '';
  }

  /** The ship's controls in their resting state: sticks centred, throttle closed, drive safe, cabin lights on. */
  private initDevices(): void {
    const ck = (this.ship.shipVisual && COCKPITS[this.ship.shipVisual as ShipVisualId]) || null;
    this.cockpitLayout = ck;
    const defs = (this.devDefs = ck ? ck.devices : []);
    this.devs = defs.map((d) => createDevice(d.id, d.kind, d.role === 'cabinLights'));
    this.fc.devs = this.devs;
    this.devViews = defs.map((d) => ({ id: d.id, x: 0, y: 0, lit: false, held: false, reachable: false, page: d.pages ? d.pages[0] : '' }));
    this.devSeen = defs.map(() => 0);
    this.devPage = defs.map(() => 0);
    this.hands.clear();
    this.fc.cmdThrottle = 0;
    const ix = this.ix, at = (role: DeviceRole): number => defs.findIndex((d) => d.role === role);
    ix.rot = at('rotation'); ix.roll = at('roll'); ix.trans = at('translation'); ix.transZ = at('translationZ');
    ix.throttle = at('throttle'); ix.arm = at('driveArm'); ix.lights = at('cabinLights'); ix.harness = at('harness'); ix.assist = at('flightAssist');
  }

  /** The start: on foot in the cockpit beside the pilot seat (or strapped in, in a ship with no interior). */
  private startPilot(): void {
    const layout = this.layout;
    this.playerMode = layout ? 'onFoot' : 'helm';
    this.body = layout ? createCrew(layout, PLAYER_ID) : null;
    this.asleep = false;
    this.restT = 0;
    this.headYaw = this.headPitch = 0;
    this.walk.moveX = this.walk.moveZ = 0;
  }

  // ------------------------------------------------------------------------------------------ stepping

  /**
   * One rendered frame (SIMULATION.md §1.3). Real time owes the world `realDt · warp · 120` ticks; the world pays them
   * in whole steps of k ticks, where k depends only on the state and the warp level — the quantum q = 2ⁿ ticks of the
   * warp level, cut short by the 60 Hz controller grid while the controller works, by a settled hold's wake tick and
   * by the loose objects' and the crew's next event — never on the frame rate or the budget. The budget (counted in
   * work units, §1.2.1) only decides how many steps fit in this frame; when it runs out the frame stops on a step
   * boundary and the debt is dropped, so the achieved warp is honest. Inputs set between frames are the commands of
   * the next tick.
   */
  step(realDt: number): StepInfo {
    const info = this.info;
    info.simDt = 0; info.simMs = 0; info.steps = 0; info.units = 0; info.limitedBy = '';
    if (!(realDt > 0)) return info;
    if (realDt > MAX_FRAME) realDt = MAX_FRAME;
    const world = this.world;
    const start = this.clockNow();
    this.clock += realDt;
    const mult = this.mult();
    const normal = realDt * mult * TICK_HZ;
    let extra = 0;
    if (this.catchUpTicks > 0) {
      // the page was hidden (D6): the missed time is paid at CATCHUP_WARP on top, under the same honest budget
      extra = realDt * CATCHUP_WARP * TICK_HZ;
      if (extra > this.catchUpTicks) extra = this.catchUpTicks;
    }
    let due = this.due + normal + extra;
    const near = Math.round(due);
    if (Math.abs(due - near) < 1e-6) due = near; // the frame boundary lands on a tick: no float sliver delays it
    const k0 = worldTick(world);
    const maxUnits = this.budgetMs / this.unitMs;
    let units = 0, why: WarpLimit = '', last: WarpLimit = '', stepUnits = 0, limited = false;
    for (let guard = 0; guard < 1e7; guard++) {
      const k = this.nextStep();
      if (k > due - (worldTick(world) - k0) + 1e-9) break; // the next step lies beyond this frame
      if (guard > 0 && (units + stepUnits > maxUnits || this.clockNow() - start > this.budgetMs + CLOCK_SLACK_MS)) { limited = true; break; }
      last = this.stepWhy;
      stepUnits = this.tickStep(k);
      units += stepUnits;
      info.steps += this.stepSteps;
    }
    const done = worldTick(world) - k0;
    info.simDt = done / TICK_HZ;
    if (limited) {
      const c = this.ship;
      why = this.ctlActive ? 'rotation' : last !== '' ? last : this.busy !== '' ? this.busy
        : c.rcsPropellant + c.propellant > 0 && c.dockedTo === null && (c.throttle > 0 || c.rcs.x !== 0 || c.rcs.y !== 0 || c.rcs.z !== 0) ? 'thrust' : 'cpu';
      this.due = 0; // the world is behind real time by what did not fit: dropped, and shown as the achieved warp
    } else this.due = due - done;
    if (this.catchUpTicks > 0) {
      const paid = done - (normal < done ? normal : done);
      this.catchUpTicks = limited ? this.catchUpTicks - paid : this.catchUpTicks - extra;
      if (this.catchUpTicks < 1) this.catchUpTicks = 0;
    }
    // the cost per work unit (perf.ts reports the same means): ms of wall clock over units over ~2 s
    const ms = this.clockNow() - start;
    info.simMs = ms;
    info.units = units;
    this.learnCost(ms, units, realDt);
    this.runPrediction();
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

  /**
   * The length of the next step, ticks (≥ 1), from the state and the warp level only: to the next quantum boundary;
   * to the next controller tick (every 2 ticks) while the controller works; to a settled hold's wake tick; to the
   * next loose-object or crew event (props.ts nextBodyEvent). Sets stepWhy to what cut it short ('' = the quantum).
   */
  private nextStep(): number {
    const tick = worldTick(this.world), q = this.quantum();
    let k = q - (tick % q), why: WarpLimit = '';
    if (this.ctlActive) { const c = 2 - (tick & 1); if (c < k) { k = c; why = 'rotation'; } }
    const wt = this.ship.holdWakeT;
    if (wt < Infinity && wt === wt) {
      // a settled hold wakes on the first controller tick (an even one) at or after its wake time (W1-B)
      let at = Math.ceil(wt * TICK_HZ - 1e-9);
      if (at & 1) at++;
      const wk = at - tick;
      if (wk >= 1 && wk < k) k = wk;
    }
    if (k > 1 && this.loose && this.propsAwake()) {
      const nb = nextBodyEvent(this.loose, craftMotion(this.world, this.ship, this.motion, this.ledger), this.playerMode === 'onFoot' ? this.body : null, this.tk, k);
      if (nb < k) { k = nb > 1 ? nb : 1; if (bodyEvent.why !== '') why = bodyEvent.why === 'crew' ? 'crew' : 'props'; } // W1-C hook: a drift/rest schedule is not a limit
    } else if (k === 1 && this.loose && this.propsAwake()) why = 'props';
    this.stepWhy = why;
    return k;
  }

  /** The warp level's quantum, ticks: the largest 2ⁿ with 2ⁿ·8 ≤ warp (1 at 1×…5×, 2048 ≈ 17 s at 1e4), ≤ 2^14. */
  private quantum(): number {
    const m = this.catchUpTicks > 0 && CATCHUP_WARP > this.mult() ? CATCHUP_WARP : this.mult();
    let q = 1;
    while (q * 8 <= m && q < QUANTUM_MAX) q *= 2;
    return q;
  }

  /**
   * One step of k ticks: the controller on its grid (every second tick, zero-order hold between), the world, the
   * ledger consumed once, then the bodies, the hand, the loose objects and the mechanisms at h = k·Q, the duty
   * tape and the events. Returns the work units it cost (perf.ts keeps ms per unit).
   */
  private tickStep(k: number): number {
    const world = this.world;
    const tick = worldTick(world);
    if ((tick & 1) === 0) {
      this.fc.arm();
      this.ctlActive = this.fc.command() || this.fc.faFiring; // the assist loop is closed at the control rate too
    }
    const res = advanceTicks(world, k);
    this.busy = res.busy;
    const h = k / TICK_HZ;
    this.consume(k);
    const mo = this.chunkMotion(h);
    if (this.playerMode === 'onFoot') this.stepBody(h, mo);
    this.stepSeat(mo);
    this.handOnProp(h, k);
    const pu = this.stepLoose(h, mo);
    this.stepDevices(h);
    this.drowse(h);
    const c = this.ship;
    tapeRecord(this.tape, 0, c.jetDuty, c.jets.length, worldTick(world));
    if (world.events.length > 0) this.pump();
    this.stepSteps = res.steps;
    return 1 + res.steps + PROP_UNITS * pu;
  }

  /** Wall clock for the budget backstop and the cost estimate (SessionOptions.now; never read by the world). */
  private clockNow(): number {
    return this.nowFn();
  }

  /** ms per work unit from ~2 s means (SessionOptions.unitMs pins it for tests and benchmarks). */
  private learnCost(ms: number, units: number, realDt: number): void {
    if (this.unitFixed) return;
    this.costMs += ms; this.costUnits += units; this.costReal += realDt;
    if (this.costReal < COST_WINDOW || this.costUnits < 200) return;
    let u = this.costMs / this.costUnits;
    if (!(u > UNIT_MS_MIN)) u = UNIT_MS_MIN; else if (u > UNIT_MS_MAX) u = UNIT_MS_MAX;
    this.unitMs = u;
    this.costMs = this.costUnits = this.costReal = 0;
  }

  /** The frame budget for the simulation, ms (3 awake; 8 asleep with the eyes closed, SIMULATION.md §1.2.1). */
  setBudget(ms: number): void {
    if (ms > 0 && Number.isFinite(ms)) this.budgetMs = ms;
  }
  /** The cost estimate the budget counts with, ms per work unit (perf report). */
  costPerUnit(): number {
    return this.unitMs;
  }
  /**
   * The page was hidden or the phone locked for `realSeconds` (D6): the world catches up on that time, at most one sim
   * day, under honest warp (CATCHUP_WARP on top of the warp in force, limited like any warp).
   */
  catchUp(realSeconds: number): void {
    if (!(realSeconds > 0) || !Number.isFinite(realSeconds)) return;
    const t = this.catchUpTicks + realSeconds * this.mult() * TICK_HZ;
    this.catchUpTicks = t < CATCHUP_MAX_TICKS ? t : CATCHUP_MAX_TICKS;
    this.winN = this.winAt = 0;
  }

  time(): number {
    return this.world.t;
  }
  tick(): number {
    return worldTick(this.world);
  }

  /** The warp changed from m0: the ticks still owed to real time are re-counted at the new warp (the real time stays). */
  private rewarp(m0: number): void {
    const m1 = this.mult();
    if (m1 !== m0 && m0 > 0) this.due = (this.due * m1) / m0;
  }

  /** Time acceleration in force: SLEEP_WARP while the pilot sleeps, otherwise 1x (setWarp's ladder is for tests). */
  private mult(): number {
    return this.asleep ? SLEEP_WARP : WARP_LADDER[this.warpIndex];
  }

  /** Lying still in the bunk for SLEEP_AFTER real seconds is falling asleep (counted per step: h of sim time is h/warp of real). */
  private drowse(h: number): void {
    const b = this.body;
    if (this.asleep || this.playerMode !== 'onFoot' || !b || b.seat !== 'bunk' || this.ship.destroyed || this.hands.size > 0) { this.restT = 0; return; }
    this.restT += h / this.mult();
    if (this.restT < SLEEP_AFTER - 1e-9) return;
    this.asleep = true;
    this.sleptFrom = this.world.t;
    this.walk.moveX = this.walk.moveZ = 0;
    this.fc.settled = false;
    this.winN = this.winAt = 0;
    this.events.emit('sleep', { asleep: true, seconds: 0 });
  }

  /** Every mechanism moves with the world; the flight computer acts on the contacts that closed. */
  private stepDevices(dt: number): void {
    const ds = this.devs, seen = this.devSeen;
    for (let i = 0; i < ds.length; i++) {
      const d = ds[i];
      stepDevice(d, dt);
      if (d.count === seen[i]) continue;
      seen[i] = d.count;
      const role = this.devDefs[i].role, hm = HOLD_OF[role];
      if (hm) this.setHold(hm);
      else if (role === 'targetNext') this.nextTarget();
      else if (role === 'undock') this.undock();
      else if (role === 'flightAssist') { this.fc.assist = !this.fc.assist; this.fc.faIdle(); } // alternate action: each press latches the other way
    }
    const li = this.ix.lights;
    if (li >= 0 && ds[li].made !== this.lights) {
      this.lights = ds[li].made;
      this.events.emit('cabinLights', { on: this.lights });
    }
  }

  /** TARGET: the next station, then the bodies, round again. */
  private nextTarget(): void {
    const w = this.world, ids: string[] = [];
    for (const c of w.craft) if (c.kind === 'station') ids.push(c.id);
    for (const b of w.bodies) ids.push(b.id);
    if (ids.length === 0) return;
    this.setTarget(ids[(ids.indexOf(this.targetId ?? '') + 1) % ids.length]);
  }

  /** Is any loose object moving (or in hand)? Asleep and stowed ones cost nothing. */
  private propsAwake(): boolean {
    const ps = this.loose;
    if (!ps) return false;
    if (ps.grab.id !== '') return true;
    const bs = ps.bodies;
    for (let i = 0; i < bs.length; i++) if (!bs[i].asleep && !bs[i].stowed) return true;
    return false;
  }
  /** The loose objects move with what the ship and the pilot's body just did (after the body, as props.ts asks). */
  private stepLoose(dt: number, mo: ShipMotionT): number {
    const ps = this.loose;
    if (!ps) return 0;
    return stepProps(ps, mo, this.playerMode === 'onFoot' ? this.body : null, dt, this.tk);
  }
  /**
   * Once per step (one tick at 1×, the quantum under warp): consume the ship's applied-force ledger (the only
   * consumer, §1.4) and fill the body steppers' tick context — tick index, span, attitude, the look and lean latched
   * at this boundary.
   */
  private consume(k: number): void {
    const tk = this.tk, b = this.body;
    consumeLedger(this.ship, this.ledger);
    tk.tick = worldTick(this.world);
    tk.ticks = k;
    tk.h = k / TICK_HZ;
    tk.q = this.ship.q;
    const foot = this.playerMode === 'onFoot' && b !== null;
    tk.yaw = foot ? b.yaw : this.headYaw;
    tk.pitch = foot ? b.pitch : this.headPitch;
    tk.lean = this.leanT;
  }
  /** Where the pilot sits now (helm, bunk, table) or '' on foot. */
  private seatKind(): SeatKind | '' {
    if (this.playerMode === 'helm') return this.layout ? 'helm' : '';
    const b = this.body;
    return b && b.seat !== '' ? b.seat : '';
  }
  /** The seated body (harness, straps, bench) moves with the ship (W1-C fills crew.ts stepSeated). */
  private stepSeat(mo: ShipMotionT): void {
    const k = this.seatKind(), layout = this.layout;
    if (k !== '' && layout) stepSeated(this.seated, k, layout, mo, this.tk);
  }
  /**
   * What the ship did over the step just taken, as the crew and the loose objects feel it: its thrust and torque
   * (craftMotion) plus the jolt of any contact impulse in the step (an impact, a touchdown, a latch closing, the
   * undock spring) as the mean acceleration over that step — they keep their own velocity while the hull's changes.
   */
  private chunkMotion(dt: number): ShipMotionT {
    const mo = craftMotion(this.world, this.ship, this.motion, this.ledger);
    const j = this.jolt;
    // W1-C hook: contact impulses reach the bodies once, exactly, through the ledger's Δv, Δω (tk.ledger: props
    // serviceBodies, crew boots / harness), not spread as an acceleration; the jolt is only cleared here
    void dt;
    takeJolt(this.ship, j);
    return mo;
  }
  /** Where the eye is now, ship-local (on foot, or the helm eye when strapped in). */
  private eyeNow(out: V3): V3 {
    const b = this.body, layout = this.layout;
    if (this.playerMode === 'onFoot' && b && layout) crewEye(b, layout, out);
    else {
      const e = layout ? layout.helmEye : null;
      out.x = e ? e.x : 0; out.y = e ? e.y : 0; out.z = e ? e.z : 0;
    }
    const d = this.eyeOffset(this.EOFF);
    out.x += d.x; out.y += d.y; out.z += d.z;
    return out;
  }
  /** The body's displacement of the eye (crew.ts eyeOffsetOf; W1-C fills), ship axes. */
  private eyeOffset(out: V3): V3 {
    const k = this.seatKind(), foot = this.playerMode === 'onFoot' ? this.body : null;
    const yaw = foot ? foot.yaw : this.headYaw, pitch = foot ? foot.pitch : this.headPitch;
    return eyeOffsetOf(foot, k !== '' ? this.seated : null, k, this.layout, yaw, pitch, out);
  }
  /**
   * Every step (the hand holds the objects at one tick per step: props.ts asks for it): the hand moves toward the
   * point on the touch ray at the distance it took hold (an arm: at most HAND_SPEED), and its velocity is smoothed
   * for a throw (time constant THROW_TAU, the per-tick factor a precomputed constant). The ray is the one latched at
   * this tick boundary (propMove between frames sets it).
   */
  private handOnProp(h: number, k: number): void {
    const ps = this.loose;
    if (!ps || this.propPointer < 0 || ps.grab.id === '') return;
    const e = this.eyeNow(this.PEYE), d = this.propDir, dist = this.propDist, t = this.propTarget;
    let gx = e.x + d.x * dist - t.x, gy = e.y + d.y * dist - t.y, gz = e.z + d.z * dist - t.z;
    const gl = Math.sqrt(gx * gx + gy * gy + gz * gz), lim = HAND_SPEED * h;
    if (gl > lim) { gx *= lim / gl; gy *= lim / gl; gz *= lim / gl; }
    t.x += gx; t.y += gy; t.z += gz;
    if (this.propPrevOk) {
      const a = k === 1 ? THROW_A : 1 - Math.exp(-h / THROW_TAU), pv = this.propPrev, hv = this.propVel;
      hv.x += ((t.x - pv.x) / h - hv.x) * a; hv.y += ((t.y - pv.y) / h - hv.y) * a; hv.z += ((t.z - pv.z) / h - hv.z) * a;
    }
    this.propPrev.x = t.x; this.propPrev.y = t.y; this.propPrev.z = t.z;
    this.propPrevOk = true;
    moveGrab(ps, t, h);
  }

  /** The pilot's body moves with what the ship just did. */
  private stepBody(dt: number, mo: ShipMotionT): void {
    const b = this.body, layout = this.layout;
    if (!b || !layout || b.seat !== '' || this.warpIndex > 0) return;
    stepCrew(b, layout, mo, this.walk, dt, this.tk);
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
          this.fc.throttle = 0;
          this.predDirty = true;
          out.emit('docked', { stationId: e.stationId, portId: e.portId });
          break;
        case 'undocked': this.predDirty = true; out.emit('undocked', { stationId: e.stationId }); break;
        case 'impact': this.wake(); this.predDirty = true; out.emit('impact', { speed: e.speed, with: e.with }); break;
        case 'destroyed': this.wake(); this.fc.throttle = 0; out.emit('destroyed', { cause: e.cause }); break;
        case 'atmosphere': if (e.entered) this.wake(); out.emit('atmosphere', { bodyId: e.bodyId, entered: e.entered }); break;
        case 'primaryChanged': this.predDirty = true; out.emit('primaryChanged', { from: e.from, to: e.to }); break;
        case 'landed': this.predDirty = true; out.emit('landed', { bodyId: e.bodyId }); break;
        default: break;
      }
    }
  }

  // ------------------------------------------------------------------------------------------ time acceleration

  warp(): WarpView {
    const w = this.warpView;
    w.requested = this.mult();
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
    if (this.asleep) { this.wake(); return; }
    if (i === this.warpIndex) return;
    const m0 = this.mult();
    this.warpIndex = i;
    this.rewarp(m0);
    this.fc.settled = false; // the hold looks again (and tightens up when time slows down)
    // the read-out answers at once
    this.winN = this.winAt = 0;
    this.limitFrames = 0;
    this.warpView.limitedBy = '';
  }

  // ------------------------------------------------------------------------------------------ input

  setControls(c: { pitch?: number; yaw?: number; roll?: number; throttle?: number; translate?: V3 }): void {
    if (c.pitch !== undefined) this.fc.pitch = clamp(c.pitch, -1, 1) || 0;
    if (c.yaw !== undefined) this.fc.yaw = clamp(c.yaw, -1, 1) || 0;
    if (c.roll !== undefined) this.fc.roll = clamp(c.roll, -1, 1) || 0;
    if (c.throttle !== undefined) {
      const t = clamp(c.throttle, 0, 1) || 0;
      if (t > 0 && this.fc.throttle === 0) this.fc.settled = false; // point properly before the drive lights
      this.fc.throttle = t;
    }
    if (c.translate) {
      this.fc.translate.x = clamp(c.translate.x, -1, 1) || 0;
      this.fc.translate.y = clamp(c.translate.y, -1, 1) || 0;
      this.fc.translate.z = clamp(c.translate.z, -1, 1) || 0;
    }
  }
  setHold(mode: HoldMode): void {
    this.fc.setHold(mode);
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
      // wave 1: what was applied (W1-B fills the records)
      o.w.x = c.w.x; o.w.y = c.w.y; o.w.z = c.w.z;
      const jd = o.jetDuty, cd = c.jetDuty;
      for (let j = 0; j < jd.length; j++) jd[j] = j < cd.length ? cd[j] : 0;
      const el = o.engineLevel, ft = c.engineThrust, en = c.engines;
      for (let j = 0; j < el.length; j++) el[j] = j < ft.length && j < en.length && en[j].maxThrust > 0 ? ft[j] / en[j].maxThrust : 0;
      o.airVelocity.x = c.airVel.x; o.airVelocity.y = c.airVel.y; o.airVelocity.z = c.airVel.z;
      o.heatFlux = c.heatFlux;
    }
    return out;
  }
  player(): PlayerView {
    const c = this.ship, o = this.playerView;
    const m = craftMass(c);
    o.name = c.name;
    o.mass = m;
    o.propellant = c.propellant;
    o.propellantFraction = c.propellantCapacity > 0 ? c.propellant / c.propellantCapacity : 0;
    o.deltaV = c.propellant > 0 ? c.exhaustVelocity * Math.log(m / (m - c.propellant)) : 0; // the main pool's Δv
    o.maxAccel = c.propellant > 0 ? c.mainThrust / m : 0;
    o.throttle = this.fc.cmdThrottle > this.fc.throttle ? this.fc.cmdThrottle : this.fc.throttle;
    o.hold = this.fc.hold;
    o.heat = c.heatCapacity > 0 ? c.heat / c.heatCapacity : 0;
    o.hull = c.hull;
    o.destroyed = c.destroyed;
    o.destroyedBy = c.destroyedBy;
    o.dockedTo = c.dockedTo;
    o.spin = Math.sqrt(c.w.x * c.w.x + c.w.y * c.w.y + c.w.z * c.w.z);
    const ref = this.fc.assist ? this.fc.assistRef() : null;
    o.assist = !this.fc.assist ? 'off' : ref ? 'on' : 'noRef';
    o.assistRef = ref ? ref.name : '';
    o.assistSpeed = ref ? Math.hypot(c.v.x - ref.v.x, c.v.y - ref.v.y, c.v.z - ref.v.z) : 0;
    o.assistCmd = this.fc.assist ? this.fc.faLever() * FA_SPEED : 0;
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
    // the IMU: f = −felt at its mounting point (SIMULATION.md W1-A 8), from the same ship motion the crew feels
    const c = this.ship, m = craftMotion(this.world, c, this.motion, this.ledger), im = this.IMU;
    feltAt0(m, im.x, im.y, im.z, o.specificForce);
    o.specificForce.x = -o.specificForce.x; o.specificForce.y = -o.specificForce.y; o.specificForce.z = -o.specificForce.z;
    o.rcsPropellant = c.rcsPropellant;
    o.rcsPropellantCapacity = c.rcsPropellantCapacity;
    return o;
  }

  setTarget(id: string | null): void {
    if (id === PLAYER_ID) id = null;
    this.targetId = id;
    if (id !== null && this.targetState() === null) this.targetId = null;
    this.predDirty = true;
    if (this.fc.hold === 'target' || this.fc.hold === 'antiTarget') this.fc.settled = false;
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

  /**
   * The path the ship will fly (SIMULATION.md W1-A 3). Computed in step(), never here: this only hands out the view.
   * The shown path is extended at its far end and trimmed behind the present (≤ 0.3 ms of steps a frame, usually
   * one coast step every 20–30 s); a disturbance restarts it in 0.5 ms slices while the old path stays shown.
   */
  prediction(): PredictionView {
    return this.pred;
  }
  setPredictionVisible(on: boolean): void {
    this.predVisible = !!on;
  }

  /** The predictor's share of a frame (after the world's step): nothing while nobody can see the path. */
  private runPrediction(): void {
    if (!this.predVisible || this.asleep) return;
    const world = this.world, c = this.ship;
    const thrust = !c.destroyed && c.dockedTo === null && (c.propellant > 0 && c.throttle > 0 || c.rcsPropellant > 0 && (c.rcs.x !== 0 || c.rcs.y !== 0 || c.rcs.z !== 0));
    if (thrust !== this.predThrust) { this.predThrust = thrust; this.predDirty = true; }
    const t0 = this.clockNow();
    let steps = 0;
    const age = this.clock - this.predClock;
    // held thrust changes the path continuously: a new one every PREDICT_INTERVAL; coasting, a fresh one now and then
    // all the same (the hold's jets are real and push a little), so the ghost never strays far from the ship
    if (!this.freshBusy && (thrust ? age >= PREDICT_INTERVAL : age >= PREDICT_REFRESH)) this.predDirty = true;
    if (this.predDirty && (!this.freshBusy || age >= PREDICT_INTERVAL)) this.startFresh();
    if (this.freshBusy) {
      const cap = Math.max(8, Math.floor(PREDICT_RESTART_MS / this.predStepMs));
      const before = this.freshWork.steps;
      const done = this.fresh.run(cap);
      steps += this.freshWork.steps - before;
      if (done) this.showFresh();
    } else if (this.liveOk) {
      // keep the horizon: drop what is behind, extend the far end only as far as it fell short
      const live = this.live, want = world.t + this.predDuration;
      if (want - live.end() > PREDICT_SLACK * this.predDuration && live.extend(want)) this.liveRunning = true;
      if (this.liveRunning) {
        const cap = Math.max(4, Math.floor(PREDICT_EXTEND_MS / this.predStepMs));
        const before = this.liveWork.steps;
        if (this.live.run(cap)) this.liveRunning = false;
        steps += this.liveWork.steps - before;
        this.live.dropBefore(world.t);
        this.publish(this.liveWork);
      } else if (this.liveWork.count > 1 && this.liveWork.points[7] < world.t) {
        this.live.dropBefore(world.t);
        this.publish(this.liveWork);
      }
    }
    if (steps > 0 && !this.unitFixed) {
      this.predMs += this.clockNow() - t0; this.predSteps += steps;
      if (this.predSteps >= PREDICT_LEARN_STEPS) {
        const u = this.predMs / this.predSteps;
        this.predStepMs = u > UNIT_MS_MIN ? (u < UNIT_MS_MAX ? u : UNIT_MS_MAX) : UNIT_MS_MIN;
        this.predMs = this.predSteps = 0;
      }
    }
  }

  /** Begin a fresh prediction from the present state into the spare buffer. */
  private startFresh(): void {
    const world = this.world, c = this.ship;
    this.predDirty = false;
    this.predClock = this.clock;
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
    this.freshDuration = duration;
    const o = this.predOpts;
    o.duration = duration;
    o.frameBodyId = this.predFrame;
    o.burns = burns;
    const t = this.targetState();
    o.targetCraftId = t && t.craft ? this.targetId : null;
    // while the drive burns: the held thrust along the drive axis for min(propellant/ṁ, 30 s), then the coast
    o.thrust = null;
    if (this.predThrust && c.throttle > 0 && c.propellant > 0 && c.exhaustVelocity > 0) {
      const F = c.mainThrust * c.throttle, md = F / c.exhaustVelocity, d = qRot(this.FV, c.q, 0, 0, -1);
      const th = this.predThrustOpt;
      th.fx = F * d.x; th.fy = F * d.y; th.fz = F * d.z; th.mdot = md;
      th.until = world.t + Math.min(c.propellant / md, PREDICT_THRUST_S);
      o.thrust = th;
    }
    this.fresh.start(world, PLAYER_ID, o, this.freshWork);
    this.freshBusy = true;
  }

  /** The fresh prediction is done: it becomes the shown (live) one; the old buffer is the next spare. */
  private showFresh(): void {
    const p = this.live, w = this.liveWork;
    this.live = this.fresh; this.liveWork = this.freshWork;
    this.fresh = p; this.freshWork = w;
    this.freshBusy = false;
    this.liveOk = true;
    this.liveRunning = false;
    this.predDuration = this.freshDuration;
    this.publish(this.liveWork);
  }

  /** Copy the shown prediction's header into the view (the arrays are the buffer's own). */
  private publish(work: Prediction): void {
    const view = this.pred, world = this.world;
    view.version++;
    view.points = work.points;
    view.targetPoints = work.targetPoints;
    view.frameBodyId = world.bodies[work.frameBody].id;
    view.count = work.count;
    view.targetCount = work.targetCount;
    view.horizon = work.horizon;
    const ev = view.events as PredictionEvent[];
    ev.length = 0;
    for (let i = 0; i < work.eventCount; i++) ev.push(predictionEvent(work, i));
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
    if (this.fc.hold === 'burn') this.fc.settled = false;
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
    this.fc.rearmBlock = true;
    this.fc.settled = false;
    this.predDirty = true;
    this.pump();
    return true;
  }

  // ------------------------------------------------------------------------------------------ the pilot's body

  mode(): PlayerMode {
    return this.playerMode;
  }
  interior(): InteriorLayout | null {
    return this.layout;
  }
  cabinLights(): boolean {
    return this.lights;
  }
  crew(): CrewView {
    const o = this.crewView, layout = this.layout, b = this.playerMode === 'onFoot' ? this.body : null;
    const m = craftMotion(this.world, this.ship, this.motion, this.ledger);
    o.mode = this.playerMode;
    o.asleep = this.asleep;
    o.prompt = null;
    if (b && layout) {
      o.posture = b.posture;
      o.pos.x = b.pos.x; o.pos.y = b.pos.y; o.pos.z = b.pos.z;
      o.vel.x = b.vel.x; o.vel.y = b.vel.y; o.vel.z = b.vel.z;
      crewEye(b, layout, o.eye);
      o.yaw = b.yaw; o.pitch = b.pitch;
      o.boots = b.boots; o.gripped = b.gripped;
      crewFelt(b, m, o.felt);
      const it = this.asleep ? null : findPrompt(b, layout);
      if (it && (it.kind === 'helm' || it.kind === 'bunk' || it.kind === 'tableSeat' || it.kind === 'lights')) {
        const p = this.promptView;
        p.id = it.id; p.kind = it.kind; p.label = it.label; o.prompt = p;
      }
    } else {
      // strapped into the pilot seat; the head is free to look around
      const e = layout ? layout.helmEye : o.eye, deck = layout ? layout.spawn.pos.y : 0;
      o.posture = 'seated';
      o.eye.x = e.x; o.eye.y = e.y; o.eye.z = e.z;
      o.pos.x = e.x; o.pos.y = deck; o.pos.z = e.z;
      o.vel.x = o.vel.y = o.vel.z = 0;
      o.yaw = this.headYaw; o.pitch = this.headPitch;
      o.boots = true; o.gripped = false;
      feltAt0(m, e.x, e.y - HELM_COM_BELOW_EYE, e.z, o.felt); // the seated body's centre of mass (W1-A 8)
    }
    const d = this.eyeOffset(o.eyeOffset);
    o.eye.x += d.x; o.eye.y += d.y; o.eye.z += d.z;
    const room = layout ? roomAt(layout, o.pos.x, o.pos.y + CREW_COM, o.pos.z) : null;
    o.roomId = room ? room.id : '';
    o.roomName = room ? room.name : '';
    return o;
  }
  /** Any input from the pilot: the wait for sleep starts again, and a sleeper wakes (true when it did). */
  private touch(): boolean {
    this.restT = 0;
    if (!this.asleep) return false;
    this.wake();
    return true;
  }
  setWalk(c: { moveX?: number; moveZ?: number }): void {
    const w = this.walk;
    if (c.moveX !== undefined) w.moveX = clamp(c.moveX, -1, 1) || 0;
    if (c.moveZ !== undefined) w.moveZ = clamp(c.moveZ, -1, 1) || 0;
    if (w.moveX === 0 && w.moveZ === 0) return;
    this.touch();
    const b = this.body;
    if (this.playerMode === 'onFoot' && b && b.seat !== '') standCrew(b); // any walk input stands up
  }
  addLook(dYaw: number, dPitch: number): void {
    if (!(dYaw !== 0 || dPitch !== 0)) return;
    this.touch();
    if (this.playerMode === 'onFoot') {
      if (this.body) lookCrew(this.body, dYaw, dPitch);
      return;
    }
    this.headYaw = clamp(this.headYaw + dYaw, -HEAD_YAW, HEAD_YAW) || 0;
    this.headPitch = clamp(this.headPitch + dPitch, -HEAD_PITCH, HEAD_PITCH) || 0;
  }
  setBoots(on: boolean): void {
    this.touch();
    if (this.body) this.body.boots = !!on;
  }
  pushOff(): void {
    if (this.touch()) return;
    const b = this.body;
    if (this.playerMode !== 'onFoot' || !b || !this.layout) return;
    if (b.seat !== '') standCrew(b);
    else pushOffCrew(b, this.layout);
  }
  /** Fasten the harness: only from on one's feet (the buckle's reach is checked by the caller). */
  private strapIn(): boolean {
    const b = this.body;
    if (this.playerMode !== 'onFoot' || !b || !this.layout || this.ship.destroyed || b.seat !== '') return false;
    this.playerMode = 'helm';
    this.walk.moveX = this.walk.moveZ = 0;
    this.headYaw = this.headPitch = 0;
    this.events.emit('crewMode', { mode: 'helm' });
    return true;
  }
  /** Release the harness. The buckle is interlocked with the drive: it stays shut while DRIVE ARM is on. */
  leaveHelm(): boolean {
    const c = this.ship, layout = this.layout, ix = this.ix;
    if (this.playerMode !== 'helm' || !layout || c.destroyed) return false;
    const armed = ix.arm >= 0 && (this.devs[ix.arm].on || this.devs[ix.arm].made);
    if (armed || this.fc.cmdThrottle > 0 || this.fc.throttle > 0 || c.throttle > 0) return false;
    this.fc.pitch = this.fc.yaw = this.fc.roll = 0;
    this.fc.translate.x = this.fc.translate.y = this.fc.translate.z = 0;
    for (const i of this.hands.values()) devRelease(this.devs[i]); // hands off the controls
    this.hands.clear();
    const boots = this.body ? this.body.boots : true;
    this.body = createCrew(layout, PLAYER_ID);
    this.body.boots = boots;
    this.walk.moveX = this.walk.moveZ = 0;
    this.setWarpIndex(0);
    this.playerMode = 'onFoot';
    this.restT = 0;
    this.fc.settled = false;
    this.events.emit('crewMode', { mode: 'onFoot' });
    return true;
  }
  standUp(): void {
    this.touch();
    if (this.playerMode === 'onFoot' && this.body) standCrew(this.body);
  }
  /** Lie in the bunk / sit on the bench. */
  private useRest(role: DeviceRole): boolean {
    const b = this.body, layout = this.layout;
    if (this.playerMode !== 'onFoot' || !b || !layout) return false;
    const seat = role === 'bunk' ? 'bunk' : 'table';
    if (b.seat !== seat) sitCrew(b, layout, seat);
    this.restT = 0;
    return true;
  }
  /** Kept for callers of the old contract: the thing in reach, through the same paths as the devices. */
  interact(): boolean {
    if (this.touch()) return true;
    const b = this.body, layout = this.layout;
    if (this.playerMode !== 'onFoot' || !b || !layout) return false;
    const it = findPrompt(b, layout);
    if (!it) return false;
    switch (it.kind) {
      case 'helm': return this.strapIn();
      case 'bunk': return this.useRest('bunk');
      case 'tableSeat': return this.useRest('tableSeat');
      case 'lights': return this.ix.lights >= 0 && devTap(this.devs[this.ix.lights]);
      default: return false; // furniture
    }
  }
  /** End the sleep (any input, or the ship being knocked about). */
  private wake(): void {
    if (!this.asleep) return;
    const m0 = this.mult();
    this.asleep = false;
    this.rewarp(m0);
    this.restT = 0;
    this.fc.settled = false;
    this.winN = this.winAt = 0;
    this.events.emit('sleep', { asleep: false, seconds: this.world.t - this.sleptFrom });
  }

  // ------------------------------------------------------------------------------------------ the pilot's hand

  cockpit(): CockpitLayout | null {
    return this.cockpitLayout;
  }
  private devIndex(id: string): number {
    const defs = this.devDefs;
    for (let i = 0; i < defs.length; i++) if (defs[i].id === id) return i;
    return -1;
  }
  /** Can the hand get to this control from where the body is now? */
  private reach(i: number): boolean {
    const def = this.devDefs[i], layout = this.layout, b = this.body;
    if (this.ship.destroyed || this.asleep) return false;
    if (def.reach === 'pilotSeat') return this.playerMode === 'helm';
    if (def.kind === 'buckle') {
      // the harness goes with the seat: fastened from standing beside it, released from in it
      if (this.playerMode === 'helm') return true;
      if (!b || !layout || b.seat !== '') return false;
      const sx = b.pos.x - layout.helmEye.x, sz = b.pos.z - layout.helmEye.z;
      return sx * sx + sz * sz <= SEAT_REACH * SEAT_REACH;
    }
    let ex: number, ey: number, ez: number, my: number;
    if (this.playerMode === 'helm' || !b || !layout) {
      const e = layout ? layout.helmEye : this.EYE;
      ex = e.x; ey = e.y; ez = e.z; my = e.y - 0.45;
    } else {
      if (b.seat === 'bunk') return def.role === 'bunk'; // lying down: get up first
      if (b.seat === 'table' && def.role === 'tableSeat') return true;
      const e = crewEye(b, layout, this.EYE);
      ex = e.x; ey = e.y; ez = e.z; my = b.seat === '' ? b.pos.y + CREW_COM : e.y - 0.45;
    }
    // from the side the control faces (not through a bulkhead), within arm's length of the eye or the body's middle
    const p = def.pos, n = def.normal;
    let px = p.x, py = p.y, pz = p.z, lim = ARM_REACH + def.radius;
    if (def.kind === 'rest' && def.halfWidth !== undefined && def.halfHeight !== undefined) {
      // a bed or a sofa is touched anywhere on its surface: the nearest point of its rectangle, within arm's length
      const u = def.up, rx = u.y * n.z - u.z * n.y, ry = u.z * n.x - u.x * n.z, rz = u.x * n.y - u.y * n.x;
      const ox = ex - p.x, oy = my - p.y, oz = ez - p.z;
      const a = clamp(ox * rx + oy * ry + oz * rz, -def.halfWidth, def.halfWidth), c = clamp(ox * u.x + oy * u.y + oz * u.z, -def.halfHeight, def.halfHeight);
      px += rx * a + u.x * c; py += ry * a + u.y * c; pz += rz * a + u.z * c;
      lim = ARM_REACH;
    }
    const dx = ex - px, dz = ez - pz, dy = ey - py, dm = my - py;
    if (dx * n.x + dy * n.y + dz * n.z < -0.25) return false;
    return dx * dx + dz * dz + Math.min(dy * dy, dm * dm) <= lim * lim;
  }
  private litOf(i: number): boolean {
    const def = this.devDefs[i], d = this.devs[i], ix = this.ix, role = def.role;
    const hm = HOLD_OF[role];
    if (hm) return this.fc.hold === hm;
    switch (role) {
      case 'driveArm': return d.made;
      case 'flightAssist': return this.fc.assist && (this.fc.assistRef() !== null || this.clock % 0.7 < 0.35); // blinks with no reference
      case 'throttle': return ix.arm >= 0 && this.devs[ix.arm].made && leverValue(d) > 0;
      case 'cabinLights': return this.lights;
      case 'harness': return this.playerMode === 'helm';
      case 'undock': return this.ship.dockedTo !== null;
      case 'display': return !this.ship.destroyed;
      case 'bunk': return this.playerMode === 'onFoot' && !!this.body && this.body.seat === 'bunk';
      case 'tableSeat': return this.playerMode === 'onFoot' && !!this.body && this.body.seat === 'table';
      default: return d.made || d.held;
    }
  }
  devices(): readonly DeviceView[] {
    const out = this.devViews, ds = this.devs, defs = this.devDefs;
    for (let i = 0; i < out.length; i++) {
      const o = out[i], d = ds[i], pages = defs[i].pages;
      o.x = d.x; o.y = d.y;
      o.held = d.held;
      o.lit = this.litOf(i);
      o.reachable = this.reach(i);
      o.page = pages ? pages[this.devPage[i]] ?? pages[0] : '';
    }
    return out;
  }
  grabDevice(id: string, pointerId: number): boolean {
    const i = this.devIndex(id);
    if (i < 0 || this.touch() || !this.reach(i) || this.hands.has(pointerId)) return false; // a touch that wakes does nothing else
    for (const j of this.hands.values()) if (j === i) return false; // one hand to a control
    this.hands.set(pointerId, i);
    devGrab(this.devs[i]);
    return true;
  }
  moveDevice(pointerId: number, x: number, y: number): void {
    const i = this.hands.get(pointerId);
    if (i === undefined) return;
    this.restT = 0;
    devMove(this.devs[i], x, y);
  }
  releaseDevice(pointerId: number): void {
    const i = this.hands.get(pointerId);
    if (i === undefined) return;
    this.hands.delete(pointerId);
    devRelease(this.devs[i]);
  }
  tapDevice(id: string): boolean {
    const i = this.devIndex(id);
    if (i < 0) return false;
    if (this.touch()) return true; // the touch woke the pilot
    if (!this.reach(i)) return false;
    const def = this.devDefs[i], d = this.devs[i];
    switch (def.kind) {
      case 'screen': {
        const n = def.pages ? def.pages.length : 0;
        if (n > 1) this.devPage[i] = (this.devPage[i] + 1) % n;
        devTap(d);
        return true;
      }
      case 'buckle':
        if (!(this.playerMode === 'helm' ? this.leaveHelm() : this.strapIn())) return false;
        devTap(d);
        return true;
      case 'rest':
        if (!this.useRest(def.role)) return false;
        devTap(d);
        return true;
      default:
        return devTap(d); // button, handle, toggle: the mechanism moves and the flight computer sees the contact
    }
  }

  // ------------------------------------------------------------------------------------------ loose objects

  props(): readonly PropView[] {
    return this.loose ? propViews(this.loose) : NO_PROPS;
  }
  /** Unit copy of a direction into out; false when it has no length. */
  private static unit(dir: V3, out: V3): boolean {
    const l = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
    if (!(l > 0) || !Number.isFinite(l)) return false;
    out.x = dir.x / l; out.y = dir.y / l; out.z = dir.z / l;
    return true;
  }
  /** The loose object on the ray from the eye within reach: its id, and the hand point's distance (propDist). */
  private propOnRay(dir: V3): string {
    const ps = this.loose;
    if (!ps || this.ship.destroyed || this.asleep || !WorldSession.unit(dir, this.propDir)) return '';
    const e = this.eyeNow(this.PEYE), u = this.propDir;
    const reach = reachAlong(u.y);
    const id = pickProp(ps, e, u, reach);
    if (id === '') return '';
    const bs = ps.bodies;
    for (let i = 0; i < bs.length; i++) {
      if (bs[i].id !== id) continue;
      const p = bs[i].p, t = (p.x - e.x) * u.x + (p.y - e.y) * u.y + (p.z - e.z) * u.z;
      this.propDist = t < 0 ? 0 : t > reach ? reach : t;
      return id;
    }
    return '';
  }
  propAt(dir: V3): number {
    const ps = this.loose, keep = this.propPointer >= 0;
    if (!ps || keep) return Infinity; // one object in hand at a time
    const id = this.propOnRay(dir);
    const info = id ? propInfo(ps, id) : null;
    return info ? Math.max(0, this.propDist - info.bound) : Infinity;
  }
  propGrab(pointerId: number, dir: V3): boolean {
    const ps = this.loose;
    if (!ps || this.propPointer >= 0 || this.touch()) return false; // a touch that wakes does nothing else
    const id = this.propOnRay(dir);
    if (id === '') return false;
    const e = this.eyeNow(this.PEYE), u = this.propDir, k = this.propDist, t = this.propTarget;
    t.x = e.x + u.x * k; t.y = e.y + u.y * k; t.z = e.z + u.z * k;
    if (!propHandOn(ps, id, t, e)) return false;
    this.propPointer = pointerId;
    this.propId = id;
    this.propPrevOk = false; // the hand starts where it took hold (propTarget)
    this.propVel.x = this.propVel.y = this.propVel.z = 0;
    return true;
  }
  propMove(pointerId: number, dir: V3): void {
    if (pointerId !== this.propPointer || this.propPointer < 0) return;
    this.restT = 0;
    const l = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
    if (!(l > 0) || !Number.isFinite(l)) return;
    this.propDir.x = dir.x / l; this.propDir.y = dir.y / l; this.propDir.z = dir.z / l;
  }
  propRelease(pointerId: number, tap: boolean): void {
    if (pointerId !== this.propPointer || this.propPointer < 0) return;
    this.propPointer = -1;
    const ps = this.loose, id = this.propId;
    this.propId = '';
    if (!ps) return;
    if (tap) {
      propHandOff(ps);
      unstow(ps, id); // a quick tap undoes a clip, a magnet or a strap (no-op for a loose object)
      return;
    }
    propHandOff(ps, this.propVel, this.playerMode === 'onFoot' ? this.body : null);
  }

  // ------------------------------------------------------------------------------------------ senses (wave 1)

  drainEvents(cb: (e: SimEvent, seq: number) => void): number {
    return drain(eventRing(this.world), cb);
  }
  dutyTape(): DutyTape {
    return this.tape;
  }
  frameTime(): number {
    // §1.3: the views hold the latest tick state; at 1× (quantum 1) the frame lies r = owed ticks · Q < Q past it and
    // the renderer extrapolates by r from each view's own v and w. Under warp the frame shows the tick state itself.
    const r = this.quantum() === 1 && this.due > 0 ? (this.due < 1 ? this.due : 1 - 1e-9) / TICK_HZ : 0;
    return this.world.t + r;
  }
  setLean(amount: number): void {
    const a = amount > 0 ? (amount < 1 ? amount : 1) : 0;
    if (a !== this.leanT) this.restT = 0;
    this.leanT = a;
  }

  // ------------------------------------------------------------------------------------------ life cycle

  reset(): void {
    this.bind(buildWorld(this.system));
    this.startPilot();
    this.seated = createSeatedBody();
    this.leanT = 0;
    this.lights = true;
    this.fc.assist = false;
    this.fc.faIdle();
    this.fc.pitch = this.fc.yaw = this.fc.roll = this.fc.throttle = 0;
    this.fc.translate.x = this.fc.translate.y = this.fc.translate.z = 0;
    this.fc.hold = 'stability';
    this.fc.holdQValid = false;
    this.fc.rearmBlock = false;
    this.warpIndex = 0;
    this.warpView.limitedBy = '';
    this.targetId = START_STATION_ID;
    if (this.targetState() === null) this.targetId = null;
    this.burnList.length = 0;
    this.predFrame = null;
    this.events.emit('reset', {});
  }
  save(): string {
    const fc = this.fc;
    const state: SessionState = {
      seed: this.seed, hold: this.fc.hold, holdQ: this.fc.holdQValid ? { ...this.fc.holdQ } : null, targetId: this.targetId, predFrame: this.predFrame,
      burns: this.burnList, burnSeq: this.burnSeq, throttle: this.fc.throttle, rearmBlock: this.fc.rearmBlock, settled: this.fc.settled,
      mode: this.playerMode, crew: this.playerMode === 'onFoot' ? this.body : null, lights: this.lights, assist: this.fc.assist,
      devices: this.devs, pages: this.devPage, head: [this.headYaw, this.headPitch],
      props: this.loose ? savePropsState(this.loose) : null,
      seated: saveSeatedBody(this.seated), lean: this.leanT,
      ctl: {
        in: [fc.pitch, fc.yaw, fc.roll, fc.translate.x, fc.translate.y, fc.translate.z], faOn: fc.faOn.slice(), faMain: fc.faMain, faFiring: fc.faFiring,
        cmd: fc.cmdThrottle, active: this.ctlActive, restT: this.restT,
      },
    };
    return JSON.stringify({ tidelock: SAVE_VERSION, session: state, world: saveWorld(this.world) });
  }
}

/** Felt acceleration of something at rest in the ship at a point. */
const feltAt0 = (m: ReturnType<typeof createShipMotion>, x: number, y: number, z: number, out: V3): V3 => feltAt(m, x, y, z, 0, 0, 0, out);

const TS: { r: V3; v: V3; name: string; craft: boolean } = { r: v3(), v: v3(), name: '', craft: false };

export function createSession(opts: SessionOptions = {}): Session {
  const seed = opts.seed ?? 1;
  const system = startSystem(seed);
  return new WorldSession(system, buildWorld(system), opts, seed);
}

/**
 * SIMULATION.md Decision 4: a save of ANY version is brought up to this one, never discarded. The envelope keeps its
 * shape across versions; every field added since is optional in SessionState (the constructor gives each its
 * default) and every craft field gets its loader default in world.ts migrateCraft (a version-3 save's single 24 t
 * tank becomes 22.5 t LH2 + 1.5 t N2H4, the same total mass). Null only when the text is not a TIDELOCK save.
 */
export function migrate(data: { tidelock?: unknown; session?: unknown; world?: unknown }): { session: SessionState; world: World } | null {
  if (typeof data.tidelock !== 'number' || typeof data.world !== 'string' || !data.session || typeof data.session !== 'object') return null;
  return { session: data.session as SessionState, world: loadWorld(data.world) };
}

/** Null when the text is not a save of this session. */
export function loadSession(json: string, opts: SessionOptions = {}): Session | null {
  try {
    const m = migrate(JSON.parse(json) as Record<string, unknown>);
    if (!m) return null;
    const s = m.session, world = m.world;
    const system = startSystem(typeof s.seed === 'number' ? s.seed : 1);
    if (world.bodies.length !== system.bodies.length || !findCraft(world, PLAYER_ID)) return null;
    return new WorldSession(system, world, opts, s.seed, {
      seed: s.seed, hold: s.hold ?? 'stability', holdQ: s.holdQ ?? null, targetId: s.targetId ?? null, predFrame: s.predFrame ?? null,
      burns: Array.isArray(s.burns) ? s.burns : [], burnSeq: s.burnSeq ?? 0, throttle: s.throttle ?? 0, rearmBlock: !!s.rearmBlock, settled: !!s.settled,
      mode: s.mode === 'helm' ? 'helm' : 'onFoot', crew: s.crew ?? null, lights: s.lights !== false, assist: s.assist === true, devices: s.devices, pages: s.pages, head: s.head,
      props: s.props, seated: s.seated, lean: s.lean, ctl: s.ctl,
    });
  } catch {
    return null;
  }
}
