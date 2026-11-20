// The flight computer (SIMULATION.md W1-A 4 → W1-B): pilot input and the attitude hold → thruster and torque commands
// on the player's craft, Flight Assist, and the docking-latch arming. It owns no physics: it writes the craft's
// command fields (throttle, rcs, torque, dockingArmed, holdWakeT) and reads the world.
//
// W1-B (real thrusters): c.rcs and c.torque are fractions (−1..1) of the jets' signed allocation-table columns
// (world/jets.ts), so a full command is exactly what the hull's jets can do in that direction. The hold plans with the
// jets' CURRENT authority (the blowdown pool's pressure), slews at HOLD_MAX_RATE (0.1 rad/s, D3) and, once settled,
// computes the sim time its error will reach the deadband (c.holdWakeT): one deadband law at every warp. Flight Assist
// works the RCS with its real per-axis authority and takes the main drive only above 0.18·a_main (released below
// 0.12·a_main), and only against a reference within FA_RANGE and in line of sight.
//
// The session owns the instance, keeps `world`, `ship`, `devs` and `ix` pointing at the live objects (bind /
// initDevices) and answers the few questions the computer asks it through FlightHost (time acceleration, the next
// planned burn, the target's state).

import type { Quat, V3 } from '../core/types';
import { HOLD_MAX_RATE, HOLD_RATE_GAIN } from '../world/control';
import {
  attitudeError, craftInertia, dockingStatus, findCraft, holdTorque, pointingError, qRot, qRotInv, leverValue, rockerValue, stickAxis,
  type Craft, type DeviceState, type World,
} from '../world';
import { craftMass } from '../world/state';
import {
  assistVisible, faMainDrive, holdCmdToJets, holdWakeTimeVec, IN_P, IN_RCS, makeStepIn, setPressure, torqueAuthority,
} from '../world/jets';
import type { HoldMode, PlannedBurn } from './api';

export const PLAYER_ID = 'player';

/**
 * Flight Assist. With FLT ASSIST lit the DRIVE lever is a speed command: the computer holds the ship's velocity
 * relative to the reference at nose x lever x FA_SPEED, plus FA_NUDGE per axis of the translation controller,
 * using only the real RCS and (armed) the main drive. Reference: the target if it is a craft, else the nearest
 * station, either only within FA_RANGE and in line of sight (no body or its air in between). The loop is
 * proportional (time constant FA_TAU) with saturation; each axis goes quiet below FA_DB_OFF and wakes above FA_DB_ON,
 * so a held velocity costs nothing and the jets never chatter. The main drive takes over the forward component when
 * the demanded acceleration exceeds 0.18·a_main and hands back to the RCS below 0.12·a_main (jets.ts faMainDrive). The
 * gap between the RCS's saturation (about 1 m/s² on the Wren) and the drive's 15% floor is met by saturated RCS.
 */
export const FA_SPEED = 50;
export const FA_NUDGE = 3;
export const FA_RANGE = 100e3;
const FA_TAU = 0.6;
const FA_DB_ON = 0.05;
const FA_DB_OFF = 0.01;
/** Stick below this is no input. */
const STICK_DEADZONE = 0.02;
/** Rate a full stick deflection asks for while a hold is on (fly-by-wire through real torque), rad/s. */
const STICK_RATE = 0.5;
/** 'stability' captures the heading once the ship turns slower than this, rad/s. */
const CAPTURE_RATE = 0.02;
/**
 * Deadband: the controller goes quiet inside the first pair and wakes outside the second (rad, rad/s), the same at
 * every time acceleration. At settle it solves when the coasting error reaches WAKE_ANGLE (c.holdWakeT); the world
 * stops there (W1-A's wakeAt) and the 60 Hz law runs until it settles again. From a 2e-5 rad/s residual that is a
 * wake every ~1500 s of sim time.
 */
export const SETTLE_ANGLE = 0.003;
export const SETTLE_RATE = 2e-5;
export const WAKE_ANGLE = 0.03;
export const WAKE_RATE = 0.01;
/**
 * The wake time allows for the target frame's own angular acceleration (holdTarget's alphaB: on an eccentric orbit the
 * prograde and radial directions turn faster near periapsis), times this margin. No disturbing torque in wave 1 (the
 * gravity gradient comes with W2-B's CMGs).
 */
const HOLD_ALPHA_MARGIN = 1.5;
/**
 * Walking a drift back (rad/s): when the error is small (< 2·WAKE_ANGLE) and the ship nearly at rest relative to the
 * target (< 2·HOLD_DRIFT_RATE), as after a deadband wake, the hold slews at this rate instead of HOLD_MAX_RATE, and once
 * it is moving at it the jets fall silent and the ship COASTS back (a pulse, a coast, a brake: the deadband limit
 * cycle). At HOLD_MAX_RATE the stiff law would spin up to 0.045 rad/s for a 0.03 rad error and spend ~27 kg of
 * hydrazine per wake; this costs well under a kilogram, and the coast is free under time acceleration.
 */
export const HOLD_DRIFT_RATE = WAKE_ANGLE / 60;
/** The coast ends where the linear zone of the hold law takes over at HOLD_DRIFT_RATE: θ = rate / (K/4). */
const DRIFT_ARRIVE = HOLD_DRIFT_RATE / (HOLD_RATE_GAIN / 4);
/** The latch is armed within this distance of a station's bounding sphere, m. */
const ARM_RANGE = 1000;
/** After undocking the latch stays open until the collar is this far from the port, m. */
const REARM_DISTANCE = 12;
const v3 = (): V3 => ({ x: 0, y: 0, z: 0 });
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** What the flight computer asks the session. */
export interface FlightHost {
  /** Time acceleration in force. */
  mult(): number;
  /** The selected target id, or null. */
  readonly targetId: string | null;
  /** The next planned burn (within its grace period), or null. */
  nextBurn(): PlannedBurn | null;
  /** Barycentric state of the target (a world body or craft), or null. */
  targetState(): { r: V3; v: V3; name: string; craft: boolean } | null;
}

/** Indices of the flight devices in the cockpit layout (−1: the ship has none). Shared with the session. */
export interface FlightDeviceIndex {
  rot: number; roll: number; trans: number; transZ: number; throttle: number; arm: number; lights: number; harness: number; assist: number;
}

export class FlightComputer {
  // the live world (set by the session)
  world!: World;
  ship!: Craft;
  devs: DeviceState[] = [];
  ix: FlightDeviceIndex = { rot: -1, roll: -1, trans: -1, transZ: -1, throttle: -1, arm: -1, lights: -1, harness: -1, assist: -1 };

  // pilot input
  pitch = 0;
  yaw = 0;
  roll = 0;
  throttle = 0;
  readonly translate = v3();
  /** Flight Assist latched on; which RCS axes it is working (x, y, z), whether it has the main drive, and whether it fires now. */
  assist = false;
  readonly faOn = [false, false, false];
  faMain = false;
  faFiring = false;
  private readonly FV = v3();
  hold: HoldMode = 'stability';
  readonly holdQ: Quat = { x: 0, y: 0, z: 0, w: 1 };
  holdQValid = false;
  /**
   * The hold is settled inside its deadband (silent until c.holdWakeT). Unsettling a settled hold from outside (the
   * session: a new target, a burn edit, waking) also ends any coast, so the law looks again at once.
   */
  get settled(): boolean {
    return this.settledF;
  }
  set settled(v: boolean) {
    if (this.settledF && !v && this.ship) this.ship.holdWakeT = Infinity;
    this.settledF = v;
  }
  private settledF = false;
  rearmBlock = false;
  /** The throttle the computer last commanded (the lever through DRIVE ARM, or Flight Assist). */
  cmdThrottle = 0;

  // scratch
  /** The jets' per-step input (pool → tank pressure) and the jet torque commands of the hold. */
  private readonly jin = makeStepIn();
  private readonly jcmd = new Float64Array(6);
  /** Flight Assist's RCS acceleration per signed force column (+x, −x, +y, −y, +z, −z), m/s². */
  private readonly fa = new Float64Array(6);
  private readonly I = v3();
  private readonly ERR = v3();
  private readonly WFF = v3();
  private readonly WE = v3();
  private readonly D = v3();
  private readonly OM = v3();
  /** |dΩ/dt| of the hold's target frame, rad/s² (holdTarget; Kepler motion: a pure function of the state). */
  private alphaB = 0;
  private readonly A = v3();

  constructor(private readonly host: FlightHost) {}

  private get targetId(): string | null {
    return this.host.targetId;
  }
  private nextBurn(): PlannedBurn | null {
    return this.host.nextBurn();
  }
  private targetState(): { r: V3; v: V3; name: string; craft: boolean } | null {
    return this.host.targetState();
  }

  setHold(mode: HoldMode): void {
    if (mode === this.hold) return;
    this.hold = mode;
    this.holdQValid = false;
    this.settled = false;
    if (this.ship) this.ship.holdWakeT = Infinity;
  }

  /**
   * Flight Assist's reference frame: the target if it is a craft, else the nearest station — either only within
   * FA_RANGE and in line of sight (segment against every body's radius plus its atmosphere top: the computer's
   * sensors cannot see through Wick). Null when there is none.
   */
  assistRef(): Craft | null {
    const cs = this.world.craft, c = this.ship, id = this.targetId, bodies = this.world.bodies;
    let best: Craft | null = null, bd = FA_RANGE * FA_RANGE;
    for (let i = 0; i < cs.length; i++) {
      const o = cs[i];
      if (o === c || o.destroyed) continue;
      const dx = o.r.x - c.r.x, dy = o.r.y - c.r.y, dz = o.r.z - c.r.z, d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > FA_RANGE * FA_RANGE) continue;
      if (id !== null && o.id === id) { if (assistVisible(c.r, o.r, FA_RANGE, bodies)) return o; continue; }
      if (o.kind !== 'station') continue;
      if (d2 < bd && assistVisible(c.r, o.r, FA_RANGE, bodies)) { bd = d2; best = o; }
    }
    return best;
  }
  faIdle(): void {
    this.faOn[0] = this.faOn[1] = this.faOn[2] = false;
    this.faMain = false;
    this.faFiring = false;
  }
  /**
   * One RCS axis of the assist: thruster command (-1..1) for a velocity error e (m/s), with aP / aN m/s² available
   * in the + / − sense of that axis (a full command delivers exactly that: the signed table column).
   */
  faAxis(i: number, e: number, aP: number, aN: number = aP): number {
    const on = this.faOn, mag = e < 0 ? -e : e;
    if (on[i]) { if (mag < FA_DB_OFF) on[i] = false; } else if (mag > FA_DB_ON) on[i] = true;
    const a = e < 0 ? aN : aP;
    return on[i] && a > 0 ? clamp(e / (a * FA_TAU), -1, 1) : 0;
  }
  /** The DRIVE lever as the assist reads it (speed command, whatever DRIVE ARM says). */
  faLever(): number {
    const i = this.ix.throttle, l = i >= 0 ? leverValue(this.devs[i]) : 0;
    return l > this.throttle ? l : this.throttle;
  }

  /** Keep the docking latch armed near a station (and open for a moment after an undock). */
  arm(): void {
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
  command(): boolean {
    const c = this.ship;
    if (c.destroyed) return false;
    // The flight computer reads the physical controls (the direct inputs of setControls are added: tests only).
    const ds = this.devs, ix = this.ix;
    let p = this.pitch, y = this.yaw, r = this.roll, thr = this.throttle;
    let tx = this.translate.x, ty = this.translate.y, tz = this.translate.z;
    if (ix.rot >= 0) { y += stickAxis(ds[ix.rot].x); p -= stickAxis(ds[ix.rot].y); } // pull back = nose up
    if (ix.roll >= 0) r += rockerValue(ds[ix.roll]);
    if (ix.trans >= 0) { tx += stickAxis(ds[ix.trans].x); ty += stickAxis(ds[ix.trans].y); }
    if (ix.transZ >= 0) tz -= rockerValue(ds[ix.transZ]); // +1 = forward = -Z
    // The throttle lever opens the main-drive valves only while DRIVE ARM is on.
    if (ix.arm >= 0 && ix.throttle >= 0 && ds[ix.arm].made) thr = Math.max(thr, leverValue(ds[ix.throttle]));
    p = clamp(p, -1, 1); y = clamp(y, -1, 1); r = clamp(r, -1, 1);
    tx = clamp(tx, -1, 1); ty = clamp(ty, -1, 1); tz = clamp(tz, -1, 1);
    this.faFiring = false;
    if (this.assist) {
      // Flight Assist: lever and translation controller command a velocity relative to the reference, in ship
      // axes (so it turns with the nose); the computer works the same thrusters the hand would.
      const ref = c.dockedTo === null && (c.propellant > 0 || c.rcsPropellant > 0) ? this.assistRef() : null;
      thr = 0;
      if (ref === null) {
        tx = ty = tz = 0; // no reference (or latched, or dry): the computer fires nothing
        this.faIdle();
      } else {
        // The RCS's real per-axis acceleration at the pool's pressure: the signed force columns of the jet table.
        const m = craftMass(c), aM = c.propellant > 0 ? c.mainThrust / m : 0, A = c.jetAlloc;
        const fa = this.fa;
        fa.fill(0);
        if (A && A.n > 0 && c.rcsPropellant > 0) {
          this.jin[IN_RCS] = c.rcsPropellant;
          setPressure(A, this.jin);
          const k = this.jin[IN_P] / m, au = A.authority;
          for (let i = 0; i < 6; i++) fa[i] = au[i] * k;
        }
        const vl = qRotInv(this.FV, c.q, c.v.x - ref.v.x, c.v.y - ref.v.y, c.v.z - ref.v.z);
        const ez = tz * FA_NUDGE - this.faLever() * FA_SPEED - vl.z; // forward is -Z
        tx = this.faAxis(0, tx * FA_NUDGE - vl.x, fa[0], fa[1]);
        ty = this.faAxis(1, ty * FA_NUDGE - vl.y, fa[2], fa[3]);
        const armed = ix.arm >= 0 && ds[ix.arm].made && aM > 0;
        const aReq = -ez / FA_TAU; // forward acceleration the loop asks for, m/s²
        this.faMain = armed && faMainDrive(this.faMain, aReq, aM);
        if (this.faMain) {
          thr = clamp(aReq / aM, 0, 1);
          tz = 0;
          this.faOn[2] = false;
        } else tz = this.faAxis(2, ez, fa[4], fa[5]);
        this.faFiring = thr > 0 || tx !== 0 || ty !== 0 || tz !== 0;
      }
    }
    if (thr > 0 && this.cmdThrottle === 0) { this.settled = false; c.holdWakeT = Infinity; } // point properly before the drive lights
    this.cmdThrottle = thr;
    const tq = c.torque;
    if (c.dockedTo !== null) {
      // The latch interlocks drive and RCS; the joint carries the attitude.
      c.throttle = 0;
      c.rcs.x = c.rcs.y = c.rcs.z = 0;
      tq.x = tq.y = tq.z = 0;
      this.holdQValid = false;
      this.settled = false;
      c.holdWakeT = Infinity;
      return false;
    }
    c.throttle = thr;
    c.rcs.x = tx; c.rcs.y = ty; c.rcs.z = tz;
    if (c.landedOn !== null) {
      tq.x = tq.y = tq.z = 0;
      this.holdQValid = false;
      this.settled = false;
      c.holdWakeT = Infinity;
      return false;
    }
    const stick = Math.abs(p) > STICK_DEADZONE || Math.abs(y) > STICK_DEADZONE || Math.abs(r) > STICK_DEADZONE;
    if (this.hold === 'off') {
      // Raw torque demand straight onto the jets' torque columns: pitch about +X (nose up), yaw about -Y (nose right),
      // roll about -Z (clockwise). Full stick is all the hull's jets can do that way.
      tq.x = stick ? p : 0; tq.y = stick ? -y : 0; tq.z = stick ? -r : 0;
      this.settled = false;
      c.holdWakeT = Infinity;
      return stick;
    }
    const I = craftInertia(c, this.I), ERR = this.ERR, WE = this.WE, w = c.w;
    this.authority();
    if (stick) {
      // The stick overrides the hold: a rate demand, met with real torque.
      this.settled = false;
      c.holdWakeT = Infinity;
      this.holdQValid = false;
      ERR.x = ERR.y = ERR.z = 0;
      WE.x = w.x - p * STICK_RATE; WE.y = w.y + y * STICK_RATE; WE.z = w.z + r * STICK_RATE;
      holdTorque(ERR, WE, I, c.maxTorque, tq);
      this.toJets(tq);
      return true;
    }
    this.holdTarget();
    const WFF = this.WFF;
    WE.x = w.x - WFF.x; WE.y = w.y - WFF.y; WE.z = w.z - WFF.z;
    const th = Math.sqrt(ERR.x * ERR.x + ERR.y * ERR.y + ERR.z * ERR.z);
    const we = Math.sqrt(WE.x * WE.x + WE.y * WE.y + WE.z * WE.z);
    // The states, all pure functions of saved state (settled, c.holdWakeT): settled (silent until the deadband or
    // c.holdWakeT), coasting back from a drift (not settled, c.holdWakeT finite: silent until the arrival time), working.
    const now = this.world.t;
    if (this.settled) {
      // one law at every warp: wake at the deadband, or at the time solved for it at settle (a rate kick: a disturbance)
      if (we > WAKE_RATE || th > WAKE_ANGLE || now >= c.holdWakeT) { this.settled = false; c.holdWakeT = Infinity; }
    } else if (c.holdWakeT !== Infinity) {
      if (we > WAKE_RATE || th > 2 * WAKE_ANGLE || th < DRIFT_ARRIVE || now >= c.holdWakeT) c.holdWakeT = Infinity;
    }
    if (!this.settled && c.holdWakeT === Infinity && th < SETTLE_ANGLE && we < SETTLE_RATE) {
      this.settled = true;
      // the error coasts as e(t) = e₀ − (ω − ω_target)·t: the first time it reaches the deadband
      c.holdWakeT = now + holdWakeTimeVec(ERR.x, ERR.y, ERR.z, -WE.x, -WE.y, -WE.z, HOLD_ALPHA_MARGIN * this.orbitAlpha(), WAKE_ANGLE);
    }
    if (this.settled || c.holdWakeT !== Infinity) {
      // Deadband (or the coast back): the ship commands nothing, so it coasts and time acceleration is free.
      tq.x = tq.y = tq.z = 0;
      return false;
    }
    // walking a drift back: slowly, unless something has pushed it well outside the deadband or set it turning
    const slow = th < 2 * WAKE_ANGLE && we < 2 * HOLD_DRIFT_RATE;
    holdTorque(ERR, WE, I, c.maxTorque, tq, slow ? HOLD_DRIFT_RATE : HOLD_MAX_RATE);
    this.toJets(tq);
    if (slow && th > 2 * DRIFT_ARRIVE) {
      // moving back at the drift rate along the error (dθ/dt = −ê·(ω − ω_target)): coast until the linear zone
      const closing = (ERR.x * WE.x + ERR.y * WE.y + ERR.z * WE.z) / th;
      const lx = WE.x - (ERR.x / th) * closing, ly = WE.y - (ERR.y / th) * closing, lz = WE.z - (ERR.z / th) * closing;
      if (closing > 0.9 * HOLD_DRIFT_RATE && lx * lx + ly * ly + lz * lz < 0.01 * HOLD_DRIFT_RATE * HOLD_DRIFT_RATE) {
        c.holdWakeT = now + (th - DRIFT_ARRIVE) / closing;
        tq.x = tq.y = tq.z = 0;
        return false;
      }
    }
    return true;
  }

  /** c.maxTorque ← the jets' torque authority at the pool's current pressure (a craft without jets keeps its own). */
  private authority(): void {
    const c = this.ship, A = c.jetAlloc;
    if (!A || A.n === 0) return;
    this.jin[IN_RCS] = c.rcsPropellant;
    torqueAuthority(A, this.jin, c.maxTorque);
  }

  /** The hold's output (−1..1 of the smaller of ± per axis) → the jets' signed torque columns, in place. */
  private toJets(tq: V3): void {
    const A = this.ship.jetAlloc;
    if (!A || A.n === 0) return;
    const cmd = holdCmdToJets(A, tq, this.jcmd);
    tq.x = cmd[3]; tq.y = cmd[4]; tq.z = cmd[5];
  }

  /** Attitude error (ERR, local rotation vector) and the rate the target itself turns at (WFF, local) for the hold. */
  holdTarget(): void {
    const c = this.ship, ERR = this.ERR, WFF = this.WFF, D = this.D, OM = this.OM;
    this.alphaB = 0;
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
        if (r2 > 0) {
          OM.x = hx / r2; OM.y = hy / r2; OM.z = hz / r2;
          // Ω = h/r², h constant: |dΩ/dt| = 2|h|·|r·v|/r⁴
          this.alphaB = (2 * Math.sqrt(hx * hx + hy * hy + hz * hz) * Math.abs(r.x * v.x + r.y * v.y + r.z * v.z)) / (r2 * r2);
        }
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

  /**
   * A bound on the target frame's angular acceleration until the next wake (at settle only): the largest |dΩ/dt| over
   * the whole osculating orbit for the prograde-like and radial holds (at an apsis the present value is 0, so it alone
   * would let the hold sleep through the next periapsis), the present value otherwise.
   */
  private orbitAlpha(): number {
    const m = this.hold, pro = m === 'prograde' || m === 'retrograde' || m === 'burn', rad = m === 'radialIn' || m === 'radialOut';
    let best = this.alphaB;
    if (!pro && !rad) return best;
    const c = this.ship, r = c.rel, v = c.relV, mu = this.world.bodies[c.primary].mu;
    const hx = r.y * v.z - r.z * v.y, hy = r.z * v.x - r.x * v.z, hz = r.x * v.y - r.y * v.x, h = Math.sqrt(hx * hx + hy * hy + hz * hz);
    const rl = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z), v2 = v.x * v.x + v.y * v.y + v.z * v.z;
    const inva = 2 / rl - v2 / mu, p = (h * h) / mu, e2 = 1 - p * inva;
    if (!(inva > 0) || !(h > 0)) return best; // escaping: the present value
    const e = e2 > 0 ? Math.sqrt(e2) : 0, sq = Math.sqrt(mu / p);
    for (let k = 0; k < 32; k++) {
      const nu = (k + 0.5) * (Math.PI / 32); // 0..π covers the orbit (|dΩ/dt| is symmetric in ν)
      const rk = p / (1 + e * Math.cos(nu)), vk2 = mu * (2 / rk - inva), rv = rk * sq * e * Math.sin(nu);
      const a = pro
        ? ((mu * h) / (rk * rk * rk * vk2)) * Math.abs(rv * (3 * rk * vk2 - 2 * mu)) / (rk * rk * rk * vk2)
        : (2 * h * Math.abs(rv)) / (rk * rk * rk * rk);
      if (a > best) best = a;
    }
    return best;
  }

  /** Rate at which the velocity direction turns under the primary's pull: (v × g) / v². */
  progradeRate(hx: number, hy: number, hz: number, r2: number, v2: number): void {
    // v × (−μ r / r³) = μ (r × v) / r³
    if (!(r2 > 0 && v2 > 0)) return;
    const mu = this.world.bodies[this.ship.primary].mu, rl = Math.sqrt(r2);
    const k = mu / (r2 * rl * v2);
    this.OM.x = hx * k; this.OM.y = hy * k; this.OM.z = hz * k;
    // Ω = μh/(r³v²) about the constant h (Kepler): |dΩ/dt| = |Ω|·|d(r³v²)/dt|/(r³v²), d(r³v²)/dt = (r·v)(3·r·v² − 2μ)
    const r = this.ship.rel, v = this.ship.relV, rv = r.x * v.x + r.y * v.y + r.z * v.z;
    const dk = rv * (3 * rl * v2 - 2 * mu);
    this.alphaB = k * Math.sqrt(hx * hx + hy * hy + hz * hz) * Math.abs(dk) / (r2 * rl * v2);
  }
}
