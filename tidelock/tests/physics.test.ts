// Tests for src/sim/physics.ts — vessel dynamics on the fixture system.
//
// References are independent of the integrator wherever possible: closed-form Kepler propagation
// (orbit.propagateState), the Tsiolkovsky equation and its closed-form displacement, and scenarios
// built backward from a known periapsis so event times are known analytically.

import { describe, expect, it } from 'vitest';
import type { StateVector, StationCollider, V3, VesselStats } from '../src/core/types';
import { DEG } from '../src/core/units';
import { add, cross, dot, len, norm, qFromAxisAngle, qRotate, scale, sub } from '../src/core/vec';
import { SystemModel, orbitInfo, orbitalFrame, orbitNormalFromElements, propagateState, timeToRadius } from '../src/sim/orbit';
import {
  HEAT_FLUX_COEFF,
  PHYSICS_WARP_MAX,
  WARP_EVENT_LEAD,
  WARP_MIN_ALTITUDE_RADII,
  WARP_LEVELS,
  aeroHeatingPower,
  altitudeOf,
  angularAccelLimit,
  atmosphereDensity,
  burnDeltaV,
  burnDuration,
  coastVessel,
  createVessel,
  currentAccel,
  deltaVRemaining,
  density,
  dynamicPressure,
  fromStationLocal,
  heatFlux,
  inAtmosphere,
  isThrusting,
  maxWarpAllowed,
  newColliderContact,
  nextTrajectoryEvent,
  orbiterFramedState,
  pointingError,
  propellantForDv,
  relativeMotion,
  sasDirection,
  scoopRate,
  setSasMode,
  sphereColliderContact,
  stationAttitude,
  stationContact,
  stationFramedState,
  stepVessel,
  timeToNextEvent,
  toStationLocal,
  totalMass,
  twr,
  vesselForward,
  type SasContext,
  type Vessel,
  type VesselEvent,
} from '../src/sim/physics';
import { TEST_IDS as ID, makeTestSystem } from './fixtures/system';

const TAU = Math.PI * 2;

// ------------------------------------------------------------------------------------ fixture

/** A courier-sized ship: 20 t dry, 15 t propellant, 600 kN at 40 km/s exhaust velocity. */
const STATS: VesselStats = {
  dryMass: 20000,
  fuelCapacity: 15000,
  mainThrust: 600e3,
  exhaustVelocity: 40000,
  rcsThrust: 4000,
  rcsExhaustVelocity: 3000,
  maxAngularAccel: 1.2,
  maxAngularRate: 0.6,
  hullMax: 1000,
  armor: 100,
  shieldMax: 200,
  shieldRegen: 5,
  powerOutput: 20,
  powerDraw: 12,
  heatCapacity: 5e9,
  heatDissipation: 5e6,
  dragArea: 25,
  heatShield: 1,
  cargoCapacity: 8,
  jumpRange: 0,
  jumpFuelPerLy: 0,
  sensorRange: 5e5,
  computerTier: 1,
  radius: 9,
  hasFuelScoop: false,
  hasMiningLaser: false,
  hasRefinery: false,
  hasSurveyScanner: false,
  hasDockingComputer: false,
};

const model = new SystemModel(makeTestSystem());
const star = model.body(ID.star);
const tessaly = model.body(ID.rocky);
const pip = model.body(ID.rockyMoon);
const giant = model.body(ID.giant);

const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
const svOf = (v: Vessel): StateVector => ({ r: { ...v.r }, v: { ...v.v } });
const energy = (v: Vessel, mu: number): number => 0.5 * dot(v.v, v.v) - mu / len(v.r);

function ship(bodyId: string, r: V3, v: V3, extra: Partial<VesselStats> = {}, fuel?: number): Vessel {
  return createVessel({ ...STATS, ...extra }, { id: 'test-ship', soiBodyId: bodyId, r, v, fuel, sasMode: 'off' });
}

/** Circular prograde equatorial orbit of `radius` around a body, starting on +X. */
function circular(bodyId: string, radius: number, extra: Partial<VesselStats> = {}): Vessel {
  const mu = model.body(bodyId).mu;
  return ship(bodyId, v3(radius, 0, 0), v3(0, 0, -Math.sqrt(mu / radius)), extra);
}

interface RunResult {
  t: number;
  events: VesselEvent[];
}

/** Step `vessel` from `t0` for `steps` frames of `dt`. */
function run(vessel: Vessel, t0: number, steps: number, dt: number, env?: SasContext, each?: (t: number, ev: readonly VesselEvent[]) => void): RunResult {
  const events: VesselEvent[] = [];
  let t = t0;
  for (let i = 0; i < steps; i++) {
    const ev = stepVessel(model, vessel, t, dt, env);
    t = t0 + (i + 1) * dt;
    if (ev.length > 0) events.push(...ev);
    if (each) each(t, ev);
  }
  return { t, events };
}

const absState = (v: Vessel, t: number): StateVector => model.toAbsolute(v, v.soiBodyId, t);

// ------------------------------------------------------------------------------------ mass & Δv

describe('mass and Δv bookkeeping', () => {
  const v = ship(ID.star, v3(1e12, 0, 0), v3(0, 0, 0));

  it('totals mass and applies Tsiolkovsky', () => {
    v.cargoMass = 3000;
    expect(totalMass(v)).toBe(38000);
    expect(deltaVRemaining(v)).toBeCloseTo(40000 * Math.log(38000 / 23000), 9);
    expect(currentAccel(v)).toBeCloseTo(600e3 / 38000, 12);
    expect(currentAccel(v, 0.5)).toBeCloseTo(300e3 / 38000, 12);
    v.cargoMass = 0;
    expect(deltaVRemaining(v)).toBeCloseTo(40000 * Math.log(35000 / 20000), 9);
  });

  it('burnDuration accounts for the falling mass and inverts burnDeltaV', () => {
    const dv = 3000;
    const prop = propellantForDv(v, dv);
    expect(prop).toBeCloseTo(35000 * (1 - Math.exp(-dv / 40000)), 6);
    const T = burnDuration(v, dv);
    expect(T).toBeCloseTo(prop / 15, 9); // mdot = F / ve = 15 kg/s
    expect(T).toBeLessThan(dv / currentAccel(v)); // shorter than the constant-mass estimate
    expect(burnDeltaV(v, T)).toBeCloseTo(dv, 8);
    expect(burnDuration(v, dv, 0.5)).toBeCloseTo(2 * T, 9);
    expect(burnDuration(v, deltaVRemaining(v) * 1.01)).toBe(Infinity);
    expect(burnDuration(v, 0)).toBe(0);
    expect(burnDeltaV(v, 1e9)).toBeCloseTo(deltaVRemaining(v), 9); // stops at flame-out
  });

  it('thrust-to-weight uses local gravity', () => {
    const low = circular(ID.rocky, tessaly.radius + 4e5);
    const g = tessaly.mu / (tessaly.radius + 4e5) ** 2;
    expect(twr(low, tessaly)).toBeCloseTo(600e3 / 35000 / g, 10);
    expect(twr(low, tessaly, tessaly.radius)).toBeCloseTo(600e3 / 35000 / (tessaly.mu / tessaly.radius ** 2), 10);
  });

  it('an empty tank gives no acceleration and no Δv', () => {
    const e = ship(ID.star, v3(1e12, 0, 0), v3(0, 0, 0), {}, 0);
    expect(currentAccel(e)).toBe(0);
    expect(deltaVRemaining(e)).toBe(0);
    e.controls.throttle = 1;
    expect(isThrusting(e)).toBe(false);
  });
});

// ------------------------------------------------------------------------------------ orbit stability

describe('a circular orbit stays circular', () => {
  const r0 = tessaly.radius + 4e5;
  const period = TAU * Math.sqrt((r0 * r0 * r0) / tessaly.mu);

  for (const [label, dt] of [
    ['1x', 1 / 60],
    ['10x', 10 / 60],
  ] as const) {
    it(`for 50 orbits at ${label} with bounded energy drift`, () => {
      const v = circular(ID.rocky, r0);
      const start = svOf(v);
      const e0 = energy(v, tessaly.mu);
      const steps = Math.round((50 * period) / dt);
      let maxDr = 0;
      let maxDe = 0;
      let t = 0;
      let events = 0;
      for (let i = 0; i < steps; i++) {
        events += stepVessel(model, v, t, dt).length;
        t = (i + 1) * dt;
        if (i % 4096 === 0) {
          maxDr = Math.max(maxDr, Math.abs(len(v.r) - r0));
          maxDe = Math.max(maxDe, Math.abs(energy(v, tessaly.mu) / e0 - 1));
        }
      }
      maxDr = Math.max(maxDr, Math.abs(len(v.r) - r0));
      maxDe = Math.max(maxDe, Math.abs(energy(v, tessaly.mu) / e0 - 1));
      const ref = propagateState(start, tessaly.mu, t);
      expect(events).toBe(0);
      expect(v.soiBodyId).toBe(ID.rocky);
      expect(maxDe).toBeLessThan(1e-10);
      expect(maxDr).toBeLessThan(0.01);
      // Still in phase with the exact Kepler solution after 50 revolutions (2.2 million km travelled).
      expect(len(sub(v.r, ref.r))).toBeLessThan(1);
      expect(len(sub(v.v, ref.v))).toBeLessThan(1e-3);
      const info = orbitInfo(v, tessaly.mu);
      expect(info.e).toBeLessThan(1e-8);
    });
  }

  it('an eccentric, inclined orbit matches Kepler after one revolution', () => {
    const el = { a: 1.4e7, e: 0.45, i: 0.6, lan: 1.1, argp: 2.3, m0: 0.4, epoch: 0 };
    const s0 = model.orbiterState(el, ID.rocky, 0);
    const v = ship(ID.rocky, s0.r, s0.v);
    const T = TAU * Math.sqrt(el.a ** 3 / tessaly.mu);
    const steps = Math.round(T / (1 / 6));
    const { t } = run(v, 0, steps, 1 / 6);
    const ref = propagateState(s0, tessaly.mu, t);
    expect(len(sub(v.r, ref.r))).toBeLessThan(0.01);
    expect(len(sub(v.v, ref.v))).toBeLessThan(1e-5);
  });

  it('one long step is split into sub-steps and stays accurate', () => {
    const v = circular(ID.rocky, r0);
    const start = svOf(v);
    expect(stepVessel(model, v, 0, 100).length).toBe(0);
    const ref = propagateState(start, tessaly.mu, 100);
    expect(len(sub(v.r, ref.r))).toBeLessThan(1e-4);
    // Far beyond the sub-step budget the step is coarser but still sane…
    const w = circular(ID.rocky, r0);
    stepVessel(model, w, 0, 2000);
    const ref2 = propagateState(start, tessaly.mu, 2000);
    expect(len(sub(w.r, ref2.r))).toBeLessThan(1);
    // …even for a dt of several orbits.
    const u = circular(ID.rocky, r0);
    expect(stepVessel(model, u, 0, 30000).length).toBe(0);
    const ref3 = propagateState(start, tessaly.mu, 30000);
    expect(len(sub(u.r, ref3.r))).toBeLessThan(100);
    expect(Math.abs(len(u.r) - r0)).toBeLessThan(1);
  });
});

// ------------------------------------------------------------------------------------ burns

describe('thrust and propellant', () => {
  // Far from the star (g ≈ 1.6e-5 m/s²); a coasting twin removes what little gravity there is.
  const R0 = v3(1e12, 0, 0);
  const V0 = v3(0, 0, -300);
  const mdot = STATS.mainThrust / STATS.exhaustVelocity;

  function burn(dt: number, duration: number, fuel?: number): { dv: V3; dr: V3; v: Vessel; events: VesselEvent[] } {
    const v = ship(ID.star, R0, V0, {}, fuel);
    const twin = ship(ID.star, R0, V0, {}, fuel);
    v.controls.throttle = 1;
    const steps = Math.round(duration / dt);
    const { events } = run(v, 0, steps, dt);
    run(twin, 0, steps, dt);
    return { dv: sub(v.v, twin.v), dr: sub(v.r, twin.r), v, events };
  }

  for (const [label, dt] of [
    ['1x', 1 / 60],
    ['10x', 10 / 60],
  ] as const) {
    it(`a timed burn delivers exactly the Tsiolkovsky Δv and propellant at ${label}`, () => {
      const T = 120;
      const { dv, dr, v, events } = burn(dt, T);
      const m0 = 35000;
      const m1 = m0 - mdot * T;
      const expected = STATS.exhaustVelocity * Math.log(m0 / m1);
      expect(events).toEqual([]);
      // Ship forward is world -Z at the identity attitude.
      expect(dv.x).toBeCloseTo(0, 9);
      expect(dv.y).toBeCloseTo(0, 9);
      expect(Math.abs(-dv.z / expected - 1)).toBeLessThan(1e-11);
      expect(Math.abs(v.fuel - (15000 - mdot * T))).toBeLessThan(1e-7);
      // Displacement of a rocket burn: ve·(T − (m1/mdot)·ln(m0/m1)).
      const s = STATS.exhaustVelocity * (T - (m1 / mdot) * Math.log(m0 / m1));
      expect(Math.abs(len(dr) / s - 1)).toBeLessThan(1e-6);
      expect(deltaVRemaining(v)).toBeCloseTo(STATS.exhaustVelocity * Math.log(m1 / 20000), 6);
    });
  }

  it('burnDuration is the time the integrator needs for a requested Δv', () => {
    const v = ship(ID.star, R0, V0);
    const twin = ship(ID.star, R0, V0);
    const want = 1234.5;
    const T = burnDuration(v, want);
    v.controls.throttle = 1;
    const whole = Math.floor(T * 60);
    run(v, 0, whole, 1 / 60);
    stepVessel(model, v, whole / 60, T - whole / 60);
    run(twin, 0, whole, 1 / 60);
    stepVessel(model, twin, whole / 60, T - whole / 60);
    expect(Math.abs(len(sub(v.v, twin.v)) - want)).toBeLessThan(1e-8);
  });

  it('half throttle halves the flow, thrust follows the attitude', () => {
    const v = ship(ID.star, R0, V0);
    const twin = ship(ID.star, R0, V0);
    const q = qFromAxisAngle(v3(0, 1, 0), 0.7);
    v.q = { ...q };
    twin.q = { ...q };
    v.controls.throttle = 0.5;
    run(v, 0, 600, 1 / 60);
    run(twin, 0, 600, 1 / 60);
    const dv = sub(v.v, twin.v);
    const expected = STATS.exhaustVelocity * Math.log(35000 / (35000 - 0.5 * mdot * 10));
    expect(Math.abs(len(dv) / expected - 1)).toBeLessThan(1e-10);
    const fwd = qRotate(q, v3(0, 0, -1));
    expect(len(sub(norm(dv), fwd))).toBeLessThan(1e-10);
    expect(len(sub(vesselForward(v), fwd))).toBeLessThan(1e-12);
  });

  it('RCS translation pushes along ship axes and burns propellant at F/ve', () => {
    const v = ship(ID.star, R0, V0);
    const twin = ship(ID.star, R0, V0);
    v.controls.translate = v3(1, 0, -0.5);
    expect(isThrusting(v)).toBe(true);
    run(v, 0, 600, 1 / 60);
    run(twin, 0, 600, 1 / 60);
    const flow = (STATS.rcsThrust * 1.5) / STATS.rcsExhaustVelocity;
    expect(Math.abs(v.fuel - (15000 - flow * 10))).toBeLessThan(1e-8);
    const dv = sub(v.v, twin.v);
    // Force (1, 0, -0.5)·F over a mass falling at `flow`: |dv| = (|F|/flow)·ln(m0/m1).
    const F = STATS.rcsThrust * Math.hypot(1, 0.5);
    const expected = (F / flow) * Math.log(35000 / (35000 - flow * 10));
    expect(Math.abs(len(dv) / expected - 1)).toBeLessThan(1e-10);
    expect(len(sub(norm(dv), norm(v3(1, 0, -0.5))))).toBeLessThan(1e-10);
  });

  for (const [label, dt] of [
    ['1x', 1 / 60],
    ['10x', 10 / 60],
  ] as const) {
    it(`flames out cleanly when the tank runs dry at ${label}`, () => {
      const fuel = 31; // 2.0666… s of burn: runs dry in the middle of a step
      const { dv, v, events } = burn(dt, 6, fuel);
      expect(v.fuel).toBe(0);
      expect(events.map((e) => e.type)).toEqual(['flameout']);
      expect(events[0].t).toBeCloseTo(fuel / mdot, 9);
      const expected = STATS.exhaustVelocity * Math.log(20031 / 20000);
      expect(Math.abs(len(dv) / expected - 1)).toBeLessThan(1e-10);
      expect(isThrusting(v)).toBe(false);
      expect(deltaVRemaining(v)).toBe(0);
      // Nothing more happens afterwards, throttle still open.
      const before = { ...v.v };
      const twin = ship(ID.star, v.r, v.v, {}, 0);
      const after = run(v, 6, 120, dt);
      run(twin, 6, 120, dt);
      expect(after.events).toEqual([]);
      expect(len(sub(v.v, twin.v))).toBe(0);
      expect(len(sub(v.v, before))).toBeLessThan(1e-2); // only the star's faint pull
    });
  }
});

// ------------------------------------------------------------------------------------ attitude

describe('attitude control', () => {
  const far = (): Vessel => ship(ID.star, v3(1e12, 0, 0), v3(0, 0, -300));

  it('manual input is a torque-limited rate command; release stops the rotation', () => {
    const v = far();
    const aMax = angularAccelLimit(v);
    expect(aMax).toBeCloseTo((1.2 * 20000) / 35000, 12);
    v.controls.pitch = 1;
    const dt = 1 / 60;
    let prev = 0;
    let maxAcc = 0;
    run(v, 0, 120, dt, undefined, () => {
      maxAcc = Math.max(maxAcc, Math.abs(v.w.x - prev) / dt);
      prev = v.w.x;
    });
    expect(maxAcc).toBeLessThanOrEqual(aMax * (1 + 1e-9));
    expect(v.w.x).toBeCloseTo(STATS.maxAngularRate, 12); // reached and held the commanded rate
    expect(v.w.y).toBe(0);
    expect(v.w.z).toBe(0);
    // Pitch up: the nose (world -Z at start) swings toward +Y.
    expect(vesselForward(v).y).toBeGreaterThan(0.5);
    // Half deflection commands half the rate.
    v.controls.pitch = 0.5;
    run(v, 2, 60, dt);
    expect(v.w.x).toBeCloseTo(0.3, 12);
    // Release: stops, exactly.
    v.controls.pitch = 0;
    run(v, 3, 120, dt);
    expect(len(v.w)).toBe(0);
    const held = vesselForward(v);
    run(v, 5, 120, dt);
    expect(len(sub(vesselForward(v), held))).toBe(0);
  });

  it('yaw right and roll right turn the way a pilot expects', () => {
    const v = far();
    v.controls.yaw = 1;
    run(v, 0, 60, 1 / 60);
    expect(vesselForward(v).x).toBeGreaterThan(0.1); // nose toward +X (right)
    const u = far();
    u.controls.roll = 1;
    run(u, 0, 60, 1 / 60);
    const right = qRotate(u.q, v3(1, 0, 0));
    expect(right.y).toBeLessThan(-0.1); // right wing down
    expect(len(sub(vesselForward(u), v3(0, 0, -1)))).toBeLessThan(1e-12);
  });

  /** Slew from the identity attitude to `dir`; returns statistics of the manoeuvre. */
  function slew(dir: V3, dt: number, seconds: number, w0?: V3, extra: Partial<VesselStats> = {}): { settle: number; maxRate: number; maxAcc: number; maxRise: number; final: number; finalRate: number; v: Vessel } {
    const v = ship(ID.star, v3(1e12, 0, 0), v3(0, 0, -300), extra);
    setSasMode(v, 'maneuver');
    if (w0) v.w = { ...w0 };
    const env: SasContext = { maneuverDir: dir };
    let prevErr = pointingError(v, dir);
    let prevW = { ...v.w };
    let maxRate = 0;
    let maxAcc = 0;
    let maxRise = 0;
    let settle = Infinity;
    run(v, 0, Math.round(seconds / dt), dt, env, (t) => {
      const err = pointingError(v, dir);
      maxRise = Math.max(maxRise, err - prevErr);
      prevErr = err;
      maxRate = Math.max(maxRate, len(v.w));
      // Per call the rate can change by at most aMax·dt (each sub-step is limited to aMax·h).
      maxAcc = Math.max(maxAcc, len(sub(v.w, prevW)) / dt);
      prevW = { ...v.w };
      if (err > 0.5 * DEG) settle = Infinity;
      else if (settle === Infinity) settle = t;
    });
    return { settle, maxRate, maxAcc, maxRise, final: pointingError(v, dir), finalRate: len(v.w), v };
  }

  const targets: [string, V3][] = [
    ['5°', qRotate(qFromAxisAngle(v3(0, 1, 0), 5 * DEG), v3(0, 0, -1))],
    ['45°', qRotate(qFromAxisAngle(v3(1, 0, 0), 45 * DEG), v3(0, 0, -1))],
    ['90°', v3(1, 0, 0)],
    ['135° oblique', norm(v3(1, 1, 1))],
    ['179.9°', qRotate(qFromAxisAngle(v3(0, 1, 0), 179.9 * DEG), v3(0, 0, -1))],
    ['180°', v3(0, 0, 1)],
  ];

  for (const [label, dt] of [
    ['1x', 1 / 60],
    ['10x', 10 / 60],
  ] as const) {
    for (const [name, dir] of targets) {
      it(`SAS slews ${name} at ${label} without overshoot, inside the torque and rate limits`, () => {
        const angle = Math.acos(Math.max(-1, Math.min(1, dot(dir, v3(0, 0, -1)))));
        const aMax = (1.2 * 20000) / 35000;
        const rMax = STATS.maxAngularRate;
        // Time-optimal (bang-bang) slew time for this angle.
        const ideal = angle > (rMax * rMax) / aMax ? angle / rMax + rMax / aMax : 2 * Math.sqrt(angle / aMax);
        const s = slew(dir, dt, 40);
        expect(s.maxRise).toBeLessThan(1e-9); // the error never grows: no overshoot
        expect(s.maxRate).toBeLessThanOrEqual(rMax * (1 + 1e-9));
        expect(s.maxAcc).toBeLessThanOrEqual(aMax * (1 + 1e-9));
        expect(s.settle).toBeLessThan(1.6 * ideal + 1.5);
        expect(s.final).toBeLessThan(1e-6);
        expect(s.finalRate).toBeLessThan(1e-6);
      });
    }
  }

  const hulls: [string, Partial<VesselStats>][] = [
    ['a sluggish freighter', { maxAngularAccel: 0.08, maxAngularRate: 0.15 }],
    ['an agile fighter', { maxAngularAccel: 4, maxAngularRate: 1.5 }],
    ['a rate-limited ship with torque to spare', { maxAngularAccel: 30, maxAngularRate: 0.3 }],
  ];
  for (const [name, extra] of hulls) {
    for (const dt of [1 / 60, 10 / 60]) {
      it(`the same controller suits ${name} at ${dt > 0.1 ? '10x' : '1x'}`, () => {
        const dir = qRotate(qFromAxisAngle(norm(v3(1, 2, 0)), 120 * DEG), v3(0, 0, -1));
        const aMax = (extra.maxAngularAccel! * 20000) / 35000;
        const rMax = extra.maxAngularRate!;
        const angle = 120 * DEG;
        const ideal = angle > (rMax * rMax) / aMax ? angle / rMax + rMax / aMax : 2 * Math.sqrt(angle / aMax);
        const s = slew(dir, dt, 3 * ideal + 30, undefined, extra);
        expect(s.maxRise).toBeLessThan(1e-9);
        expect(s.maxRate).toBeLessThanOrEqual(rMax * (1 + 1e-9));
        expect(s.maxAcc).toBeLessThanOrEqual(aMax * (1 + 1e-9));
        expect(s.settle).toBeLessThan(1.6 * ideal + 1.5);
        expect(s.final).toBeLessThan(1e-6);
        expect(s.finalRate).toBeLessThan(1e-6);
      });
    }
  }

  it('recovers from a tumble and still converges', () => {
    const dir = norm(v3(-1, 0.5, 0.3));
    const s = slew(dir, 1 / 60, 40, v3(0.3, -0.4, 0.25));
    expect(s.final).toBeLessThan(1e-6);
    expect(s.finalRate).toBeLessThan(1e-6);
    expect(s.maxAcc).toBeLessThanOrEqual((1.2 * 20000) / 35000 * (1 + 1e-9));
  });

  it('a heavier ship turns more slowly (torque limit scales with mass)', () => {
    const light = far();
    light.fuel = 0;
    const heavy = far();
    heavy.cargoMass = 45000;
    expect(angularAccelLimit(light)).toBeCloseTo(1.2, 12);
    expect(angularAccelLimit(heavy)).toBeCloseTo((1.2 * 20000) / 80000, 12);
    for (const v of [light, heavy]) {
      setSasMode(v, 'maneuver');
      run(v, 0, 30, 1 / 60, { maneuverDir: v3(1, 0, 0) });
    }
    expect(pointingError(light, v3(1, 0, 0))).toBeLessThan(pointingError(heavy, v3(1, 0, 0)));
  });

  it('stability hold captures the heading after manual input and keeps it', () => {
    const v = far();
    setSasMode(v, 'stability');
    stepVessel(model, v, 0, 1 / 60);
    expect(v.sasTarget).not.toBeNull();
    expect(len(sub(v.sasTarget!, v3(0, 0, -1)))).toBeLessThan(1e-12);
    v.controls.yaw = -1;
    run(v, 0, 90, 1 / 60);
    expect(v.sasTarget).toBeNull(); // released while the pilot is steering
    v.controls.yaw = 0;
    run(v, 1.5, 180, 1 / 60);
    expect(len(v.w)).toBeLessThan(1e-9);
    expect(v.sasTarget).not.toBeNull();
    expect(pointingError(v, v.sasTarget!)).toBeLessThan(1e-9);
    expect(vesselForward(v).x).toBeLessThan(-0.3); // it did turn left and stayed there
    // A roll command does not disturb the held heading.
    const held = { ...v.sasTarget! };
    v.controls.roll = 1;
    run(v, 5, 120, 1 / 60);
    expect(pointingError(v, held)).toBeLessThan(1e-9);
    expect(Math.abs(v.w.z)).toBeCloseTo(STATS.maxAngularRate, 9);
  });

  it('sasDirection gives the orbit-relative, target and manoeuvre directions', () => {
    const el = { a: 1.4e7, e: 0.3, i: 0.5, lan: 0.8, argp: 1.9, m0: 1.0, epoch: 0 };
    const s0 = model.orbiterState(el, ID.rocky, 0);
    const v = ship(ID.rocky, s0.r, s0.v);
    const f = orbitalFrame(s0);
    const near = (a: V3 | null, b: V3): void => {
      expect(a).not.toBeNull();
      expect(len(sub(a!, b))).toBeLessThan(1e-12);
    };
    near(sasDirection('prograde', v), norm(s0.v));
    near(sasDirection('retrograde', v), scale(norm(s0.v), -1));
    near(sasDirection('normal', v), norm(cross(s0.r, s0.v)));
    near(sasDirection('antinormal', v), scale(norm(cross(s0.r, s0.v)), -1));
    near(sasDirection('radialOut', v), f.radial);
    near(sasDirection('radialIn', v), scale(f.radial, -1));
    expect(dot(sasDirection('radialOut', v)!, s0.r)).toBeGreaterThan(0);
    expect(dot(sasDirection('normal', v)!, orbitNormalFromElements(el))).toBeCloseTo(1, 12);
    const ctx: SasContext = { targetRelPos: v3(300, -400, 1200), targetRelVel: v3(-2, 0.5, 1), maneuverDir: v3(0, 30, 40) };
    near(sasDirection('target', v, ctx), norm(v3(300, -400, 1200)));
    near(sasDirection('antiTarget', v, ctx), norm(v3(-300, 400, -1200)));
    near(sasDirection('killRelative', v, ctx), norm(v3(-2, 0.5, 1)));
    near(sasDirection('maneuver', v, ctx), v3(0, 0.6, 0.8));
    near(sasDirection('stability', v), vesselForward(v));
    expect(sasDirection('off', v, ctx)).toBeNull();
    expect(sasDirection('target', v)).toBeNull();
    expect(sasDirection('maneuver', v, { maneuverDir: v3(0, 0, 0) })).toBeNull();
    expect(sasDirection('killRelative', v, { targetRelVel: v3(0, 0, 0) })).toBeNull();
  });

  it('holds prograde around an orbit and points at a moving target', () => {
    const v = circular(ID.rocky, tessaly.radius + 4e5);
    setSasMode(v, 'prograde');
    const T = TAU * Math.sqrt((tessaly.radius + 4e5) ** 3 / tessaly.mu);
    let worst = 0;
    run(v, 0, Math.round(T / 4 / (1 / 6)), 1 / 6, undefined, (t) => {
      if (t > 20) worst = Math.max(worst, pointingError(v, v.v));
    });
    expect(worst).toBeLessThan(2e-3); // lags the 1.1 mrad/s rotation of prograde by well under a milliradian·s
    expect(pointingError(v, v.v)).toBeLessThan(2e-3);
    // Without a target the mode keeps the last direction instead of tumbling.
    setSasMode(v, 'target');
    run(v, 0, 60, 1 / 60);
    expect(len(v.w)).toBeLessThan(1e-6);
    const rel = v3(0, 1000, 0);
    run(v, 0, 1200, 1 / 60, { targetRelPos: rel });
    expect(pointingError(v, rel)).toBeLessThan(1e-6);
  });
});

// ------------------------------------------------------------------------------------ atmosphere

describe('atmosphere', () => {
  const atm = tessaly.atmosphere!;
  const top = tessaly.radius + atm.height;

  it('density is exponential, exact at the surface and zero at the top', () => {
    expect(atmosphereDensity(tessaly, 0)).toBe(atm.surfaceDensity);
    expect(atmosphereDensity(tessaly, -500)).toBe(atm.surfaceDensity);
    expect(atmosphereDensity(tessaly, atm.height)).toBe(0);
    expect(atmosphereDensity(tessaly, atm.height + 1)).toBe(0);
    expect(atmosphereDensity(tessaly, atm.height - 1)).toBeGreaterThan(0);
    expect(atmosphereDensity(tessaly, atm.height - 1)).toBeLessThan(1e-9);
    expect(atmosphereDensity(tessaly, 30000) / (atm.surfaceDensity * Math.exp(-30000 / atm.scaleHeight)) - 1).toBeLessThan(1e-4);
    expect(atmosphereDensity(tessaly, 8000) / atmosphereDensity(tessaly, 16000)).toBeCloseTo(Math.E, 3);
    expect(atmosphereDensity(pip, 100)).toBe(0);
    expect(density).toBe(atmosphereDensity);
    let prev = Infinity;
    for (let h = 0; h <= atm.height; h += 1000) {
      const d = atmosphereDensity(tessaly, h);
      expect(d).toBeLessThanOrEqual(prev);
      prev = d;
    }
  });

  it('dynamic pressure, heat flux and heating power follow their formulas', () => {
    expect(dynamicPressure(0.02, 3000)).toBeCloseTo(0.5 * 0.02 * 9e6, 6);
    expect(heatFlux(1e-4, 7800)).toBeCloseTo(HEAT_FLUX_COEFF * 0.01 * 7800 ** 3, 3);
    expect(heatFlux(4e-4, 7800) / heatFlux(1e-4, 7800)).toBeCloseTo(2, 12); // ∝ √ρ
    expect(heatFlux(1e-4, 2 * 3900) / heatFlux(1e-4, 3900)).toBeCloseTo(8, 12); // ∝ v³
    expect(aeroHeatingPower(STATS, 1e-4, 7800)).toBeCloseTo(heatFlux(1e-4, 7800) * 25, 3);
    expect(aeroHeatingPower({ ...STATS, heatShield: 4 }, 1e-4, 7800)).toBeCloseTo((heatFlux(1e-4, 7800) * 25) / 4, 3);
  });

  /** Elliptic orbit around Tessaly from apoapsis radius `ra` with periapsis altitude `hp`, starting at apoapsis. */
  function fromApoapsis(ra: number, hp: number, extra: Partial<VesselStats> = {}): Vessel {
    const rp = tessaly.radius + hp;
    const a = 0.5 * (ra + rp);
    const va = Math.sqrt(tessaly.mu * (2 / ra - 1 / a));
    return ship(ID.rocky, v3(-ra, 0, 0), v3(0, 0, va), extra);
  }

  function aerobrake(dt: number, hp: number): { v: Vessel; events: VesselEvent[]; peakHeat: number; apoBefore: number; tPass: number } {
    const v = fromApoapsis(1.2e7, hp);
    const apoBefore = orbitInfo(v, tessaly.mu).apoapsis;
    const coast = coastVessel(model, v, 0, 1e7);
    expect(coast.stopReason).toBe('atmosphere');
    expect(coast.events.map((e) => e.type)).toEqual(['atmosphere-enter']);
    expect(Math.abs(len(v.r) - top)).toBeLessThan(1e-5);
    expect(dot(v.r, v.v)).toBeLessThan(0);
    expect(inAtmosphere(v, tessaly)).toBe(true);
    const events: VesselEvent[] = [];
    let peakHeat = 0;
    let t = coast.tReached;
    const t0 = t;
    for (let i = 0; i < 200000 && !v.destroyed; i++) {
      const ev = stepVessel(model, v, t, dt);
      t = t0 + (i + 1) * dt;
      peakHeat = Math.max(peakHeat, v.heat);
      if (ev.length > 0) events.push(...ev);
      if (ev.some((e) => e.type === 'atmosphere-exit' || e.type === 'impact')) break;
    }
    return { v, events, peakHeat, apoBefore, tPass: t - t0 };
  }

  it('an aerobraking pass lowers the apoapsis and heats the hull', () => {
    const a = aerobrake(1 / 60, 82000);
    const b = aerobrake(10 / 60, 82000);
    const apoA = orbitInfo(a.v, tessaly.mu).apoapsis;
    const apoB = orbitInfo(b.v, tessaly.mu).apoapsis;
    expect(a.events.map((e) => e.type)).toEqual(['atmosphere-exit']);
    expect(b.events.map((e) => e.type)).toEqual(['atmosphere-exit']);
    expect(apoA).toBeLessThan(a.apoBefore - 1e5); // a real saving: more than 100 km off the apoapsis
    expect(apoA).toBeGreaterThan(top); // …and still in orbit
    expect(a.peakHeat).toBeGreaterThan(1e8);
    expect(a.peakHeat).toBeLessThan(STATS.heatCapacity); // survivable at this depth
    expect(a.v.hull).toBe(STATS.hullMax);
    expect(inAtmosphere(a.v, tessaly)).toBe(false);
    // Real time and 10× warp fly the same pass.
    expect(Math.abs(apoA - apoB)).toBeLessThan(5);
    expect(Math.abs(a.peakHeat / b.peakHeat - 1)).toBeLessThan(1e-4);
    // Drag only ever removes orbital energy.
    expect(energy(a.v, tessaly.mu)).toBeLessThan(-tessaly.mu / (1.2e7 + tessaly.radius + 82000));
  });

  it('heat radiates away after the pass', () => {
    const a = aerobrake(10 / 60, 82000);
    const heat = a.v.heat;
    expect(heat).toBeGreaterThan(0);
    run(a.v, 0, 60, 1);
    expect(a.v.heat).toBeCloseTo(Math.max(0, heat - 60 * STATS.heatDissipation), 3);
    coastVessel(model, a.v, 60, heat / STATS.heatDissipation);
    expect(a.v.heat).toBe(0);
  });

  it('a heat shield cuts the heating; too deep a pass overheats and breaks the hull', () => {
    const deep = aerobrake(10 / 60, 72000);
    const types = deep.events.map((e) => e.type);
    expect(types).toContain('overheat');
    expect(deep.v.hull).toBeLessThan(STATS.hullMax);
    expect(deep.peakHeat).toBeGreaterThan(STATS.heatCapacity);
    expect(deep.peakHeat).toBeLessThanOrEqual(2 * STATS.heatCapacity);
    if (deep.v.destroyed) expect(types).toContain('destroyed');
    // Same pass behind a shield.
    const v = fromApoapsis(1.2e7, 72000, { heatShield: 4 });
    coastVessel(model, v, 0, 1e7);
    let peak = 0;
    for (let i = 0; i < 6000 && inAtmosphere(v, tessaly); i++) {
      stepVessel(model, v, i / 6, 1 / 6);
      peak = Math.max(peak, v.heat);
    }
    expect(peak).toBeGreaterThan(1e8);
    expect(peak).toBeLessThan(STATS.heatCapacity);
    expect(v.hull).toBe(STATS.hullMax);
    expect(v.destroyed).toBe(false);
  });

  it('plunging into the surface is an impact with its speed, at the surface', () => {
    const v = ship(ID.rocky, v3(top - 10, 0, 0), v3(-2000, 0, -50), { heatShield: 1e6 });
    const { events } = run(v, 0, 2000, 1 / 6);
    const types = events.map((e) => e.type);
    expect(types).toEqual(['impact', 'destroyed']);
    const imp = events[0];
    if (imp.type !== 'impact') throw new Error('unreachable');
    expect(imp.bodyId).toBe(ID.rocky);
    expect(imp.speed).toBeCloseTo(len(v.v), 9);
    expect(imp.speed).toBeGreaterThan(0);
    expect(Math.abs(len(v.r) - tessaly.radius)).toBeLessThan(1e-4);
    expect(v.destroyed).toBe(true);
    // A destroyed vessel is left alone.
    const frozen = JSON.stringify(v);
    expect(stepVessel(model, v, 500, 1).length).toBe(0);
    expect(coastVessel(model, v, 500, 100).stopReason).toBe('destroyed');
    expect(JSON.stringify(v)).toBe(frozen);
  });

  it('a fuel scoop gathers propellant in a hydrogen atmosphere, and only there', () => {
    const alt = 3.0e5;
    const r = giant.radius + alt;
    const make = (scoop: boolean): Vessel => {
      const v = circular(ID.giant, r, { hasFuelScoop: scoop, heatShield: 1e5 });
      v.fuel = 1000;
      return v;
    };
    const v = make(true);
    const rho = atmosphereDensity(giant, alt);
    const rate = scoopRate(v.stats, rho, len(v.v));
    expect(rate).toBeGreaterThan(1);
    run(v, 0, 120, 1 / 60);
    expect(v.fuel - 1000).toBeGreaterThan(0.7 * rate * 2);
    expect(v.fuel - 1000).toBeLessThan(1.3 * rate * 2);
    const none = make(false);
    run(none, 0, 120, 1 / 60);
    expect(none.fuel).toBe(1000);
    expect(scoopRate(none.stats, rho, 30000)).toBe(0);
    // Never above capacity.
    const full = make(true);
    full.fuel = STATS.fuelCapacity - 1;
    run(full, 0, 120, 1 / 60);
    expect(full.fuel).toBe(STATS.fuelCapacity);
    // Tessaly's air is not scoopable.
    const t = ship(ID.rocky, v3(tessaly.radius + 60000, 0, 0), v3(0, 0, -7000), { hasFuelScoop: true, heatShield: 1e5 });
    t.fuel = 1000;
    run(t, 0, 60, 1 / 60);
    expect(t.fuel).toBe(1000);
  });
});

// ------------------------------------------------------------------------------------ SOI transitions

/**
 * A flyby of Pip built backward from its periapsis (radius `rp`, speed `vp`, at sim time `tPeri`),
 * so the SOI entry / exit times are known in closed form. The start state is in Tessaly's frame,
 * `lead` seconds before the entry. `sense` = -1 flies around the moon the other way.
 */
function pipFlyby(rp: number, vp: number, tPeri: number, lead: number, sense = 1): { start: Vessel; t0: number; tEnter: number; tExit: number; peri: StateVector } {
  const peri: StateVector = { r: v3(rp, 0, 0), v: v3(0, 0.3 * vp, -sense * Math.sqrt(1 - 0.09) * vp) };
  const tau = timeToRadius(peri, pip.mu, pip.soi, 'outward');
  const entryPip = propagateState(peri, pip.mu, -tau);
  const tEnter = tPeri - tau;
  const entryTess = model.changeFrame(entryPip, ID.rockyMoon, ID.rocky, tEnter);
  const s0 = propagateState(entryTess, tessaly.mu, -lead);
  return { start: ship(ID.rocky, s0.r, s0.v), t0: tEnter - lead, tEnter, tExit: tPeri + tau, peri };
}

describe('sphere-of-influence transitions', () => {
  it('stepVessel enters and leaves a moon’s SOI at the analytic times, preserving the absolute state', () => {
    const fb = pipFlyby(2.0e6, 2600, 20000, 300);
    const v = fb.start;
    expect(len(sub(v.r, model.bodyState(ID.rockyMoon, fb.t0).r))).toBeGreaterThan(pip.soi);
    const dt = 1 / 6;
    const steps = Math.round((fb.tExit + 300 - fb.t0) / dt);
    const seen: VesselEvent[] = [];
    let before = absState(v, fb.t0);
    let bodyBefore = v.soiBodyId;
    let relBefore = svOf(v);
    let tPrev = fb.t0;
    let periErr = Infinity;
    run(v, fb.t0, steps, dt, undefined, (t, ev) => {
      for (const e of ev) {
        seen.push(e);
        if (e.type !== 'soi-change') continue;
        // Undo the frame change and compare with the same step flown without it.
        const back = model.changeFrame(v, v.soiBodyId, bodyBefore, t);
        const noChange = propagateState(relBefore, model.body(bodyBefore).mu, dt);
        // (They differ only by the gravity model of the part of the step flown after the crossing.)
        expect(len(sub(back.r, noChange.r))).toBeLessThan(0.2 * dt * dt);
        expect(len(sub(back.v, noChange.v))).toBeLessThan(0.4 * dt);
        // …and the absolute state is continuous across the step.
        const after = absState(v, t);
        expect(len(sub(after.r, add(before.r, scale(before.v, t - tPrev))))).toBeLessThan(0.05);
        expect(len(sub(after.v, before.v))).toBeLessThan(0.5);
      }
      if (v.soiBodyId === ID.rockyMoon && Math.abs(t - 20000) < dt / 2) {
        periErr = len(sub(v.r, propagateState(fb.peri, pip.mu, t - 20000).r));
      }
      before = absState(v, t);
      bodyBefore = v.soiBodyId;
      relBefore = svOf(v);
      tPrev = t;
    });
    expect(seen.map((e) => e.type)).toEqual(['soi-change', 'soi-change']);
    const [inn, out] = seen;
    if (inn.type !== 'soi-change' || out.type !== 'soi-change') throw new Error('unreachable');
    expect([inn.fromBodyId, inn.toBodyId]).toEqual([ID.rocky, ID.rockyMoon]);
    expect([out.fromBodyId, out.toBodyId]).toEqual([ID.rockyMoon, ID.rocky]);
    expect(Math.abs(inn.t - fb.tEnter)).toBeLessThan(1e-4);
    expect(Math.abs(out.t - fb.tExit)).toBeLessThan(1e-4);
    expect(periErr).toBeLessThan(1e-2); // flew the designed periapsis
    expect(v.soiBodyId).toBe(ID.rocky);
  });

  it('coastVessel takes the same transitions exactly, in one call', () => {
    const fb = pipFlyby(2.0e6, 2600, 20000, 300);
    const v = fb.start;
    const res = coastVessel(model, v, fb.t0, fb.tExit + 300 - fb.t0);
    expect(res.stopReason).toBe('done');
    expect(res.tReached).toBe(fb.tExit + 300);
    expect(res.events.map((e) => e.type)).toEqual(['soi-change', 'soi-change']);
    expect(Math.abs(res.events[0].t - fb.tEnter)).toBeLessThan(1e-5);
    expect(Math.abs(res.events[1].t - fb.tExit)).toBeLessThan(1e-5);
    // Stop at the periapsis instead: the state in Pip's frame is the one the flyby was built from.
    const w = pipFlyby(2.0e6, 2600, 20000, 300).start;
    const r2 = coastVessel(model, w, fb.t0, 20000 - fb.t0);
    expect(r2.tReached).toBe(20000);
    expect(w.soiBodyId).toBe(ID.rockyMoon);
    expect(len(sub(w.r, fb.peri.r))).toBeLessThan(1e-3);
    expect(len(sub(w.v, fb.peri.v))).toBeLessThan(1e-6);
  });

  it('coastVessel agrees with stepVessel through the flyby', () => {
    const fb = pipFlyby(2.0e6, 2600, 20000, 300);
    const stepped = fb.start;
    const coasted = pipFlyby(2.0e6, 2600, 20000, 300).start;
    const T = fb.tExit + 600 - fb.t0;
    const steps = Math.round(T / (1 / 6));
    const { t } = run(stepped, fb.t0, steps, 1 / 6);
    coastVessel(model, coasted, fb.t0, t - fb.t0);
    expect(stepped.soiBodyId).toBe(coasted.soiBodyId);
    expect(len(sub(stepped.r, coasted.r))).toBeLessThan(0.05);
    expect(len(sub(stepped.v, coasted.v))).toBeLessThan(1e-4);
  });

  it('coastVessel agrees with stepVessel on a plain orbit and when escaping a planet', () => {
    const el = { a: 1.1e7, e: 0.3, i: 0.4, lan: 2.0, argp: 0.5, m0: 2.5, epoch: 0 };
    const s0 = model.orbiterState(el, ID.rocky, 0);
    const a = ship(ID.rocky, s0.r, s0.v);
    const b = ship(ID.rocky, s0.r, s0.v);
    const { t, events } = run(a, 0, 6 * 3000, 1 / 6);
    const res = coastVessel(model, b, 0, t);
    expect(events).toEqual([]);
    expect(res.events).toEqual([]);
    expect(len(sub(a.r, b.r))).toBeLessThan(1e-3);
    expect(len(sub(a.v, b.v))).toBeLessThan(1e-6);

    // Leaving Tessaly for the star's frame.
    const dir = norm(v3(0.6, 0.1, -0.8));
    const r0 = scale(dir, tessaly.soi - 5e5);
    const v0 = add(scale(dir, 3800), v3(300, 50, 200));
    const c = ship(ID.rocky, r0, v0);
    const d = ship(ID.rocky, r0, v0);
    const absStart = model.toAbsolute({ r: r0, v: v0 }, ID.rocky, 5000);
    const r1 = run(c, 5000, 60 * 300, 1 / 60);
    const r3 = coastVessel(model, d, 5000, 300);
    expect(r1.events.map((e) => e.type)).toEqual(['soi-change']);
    expect(r3.events.map((e) => e.type)).toEqual(['soi-change']);
    expect(c.soiBodyId).toBe(ID.star);
    expect(d.soiBodyId).toBe(ID.star);
    expect(Math.abs(r1.events[0].t - r3.events[0].t)).toBeLessThan(1e-4);
    expect(len(sub(c.r, d.r))).toBeLessThan(0.05);
    expect(len(sub(c.v, d.v))).toBeLessThan(1e-4);
    // The absolute state really is continuous: no jump of more than the distance flown.
    expect(len(sub(absState(d, 5300).r, absStart.r))).toBeLessThan(len(absStart.v) * 300 * 1.01);
    expect(len(sub(absState(d, 5300).v, absStart.v))).toBeLessThan(300);
  });

  it('coastVessel agrees with stepVessel when arriving at a planet from interplanetary space', () => {
    // Inbound at the edge of Brannoch's SOI at t = 9000, started 200 s earlier in the star's frame.
    const dir = norm(v3(-0.5, 0.05, 0.86));
    const entry: StateVector = { r: scale(dir, giant.soi), v: add(scale(dir, -6000), v3(900, 100, 400)) };
    const s0 = propagateState(model.changeFrame(entry, ID.giant, ID.star, 9000), star.mu, -200);
    const a = ship(ID.star, s0.r, s0.v);
    const b = ship(ID.star, s0.r, s0.v);
    const r1 = run(a, 8800, 6 * 500, 1 / 6);
    const r2 = coastVessel(model, b, 8800, 500);
    expect(r1.events.map((e) => e.type)).toEqual(['soi-change']);
    expect(r2.events.map((e) => e.type)).toEqual(['soi-change']);
    expect(a.soiBodyId).toBe(ID.giant);
    expect(b.soiBodyId).toBe(ID.giant);
    expect(Math.abs(r2.events[0].t - 9000)).toBeLessThan(1e-4);
    expect(Math.abs(r1.events[0].t - 9000)).toBeLessThan(1e-3);
    // Positions here are ~1.6e10 m from the star: a few micrometres of rounding per step.
    expect(len(sub(a.r, b.r))).toBeLessThan(0.5);
    expect(len(sub(a.v, b.v))).toBeLessThan(1e-3);
  });

  it('a state already outside its SOI (or deep inside a child’s) is re-framed on the first step', () => {
    const p = model.bodyState(ID.rockyMoon, 100);
    const inside = ship(ID.rocky, add(p.r, v3(2e6, 0, 0)), add(p.v, v3(0, 0, -1400)));
    const abs0 = absState(inside, 100);
    const ev = stepVessel(model, inside, 100, 1 / 60);
    expect(ev.map((e) => e.type)).toEqual(['soi-change']);
    expect(inside.soiBodyId).toBe(ID.rockyMoon);
    expect(len(sub(absState(inside, 100 + 1 / 60).r, add(abs0.r, scale(abs0.v, 1 / 60))))).toBeLessThan(0.01);
    const outside = ship(ID.rockyMoon, v3(pip.soi * 1.5, 0, 0), v3(100, 0, 0));
    const ev2 = stepVessel(model, outside, 100, 1 / 60);
    expect(ev2.map((e) => e.type)).toEqual(['soi-change']);
    expect(outside.soiBodyId).toBe(ID.rocky);
  });
});

// ------------------------------------------------------------------------------------ coasting with huge dt

describe('coastVessel with a huge dt', () => {
  /** State aimed into Pip from its SOI edge, placed `lead` seconds earlier in Tessaly's frame. */
  function aimedAtPip(vEntry: V3, tEnter: number, lead: number): { v: Vessel; t0: number; entryPip: StateVector } {
    const entryPip: StateVector = { r: v3(pip.soi, 0, 0), v: vEntry };
    const entryTess = model.changeFrame(entryPip, ID.rockyMoon, ID.rocky, tEnter);
    const s0 = propagateState(entryTess, tessaly.mu, -lead);
    return { v: ship(ID.rocky, s0.r, s0.v), t0: tEnter - lead, entryPip };
  }

  it('never skips an impact: stops on the surface of the moon it was aimed at', () => {
    const { v, t0, entryPip } = aimedAtPip(v3(-1500, 0, -100), 50000, 900);
    const tImpact = 50000 + timeToRadius(entryPip, pip.mu, pip.radius, 'inward');
    const res = coastVessel(model, v, t0, 1e9);
    expect(res.stopReason).toBe('impact');
    expect(res.events.map((e) => e.type)).toEqual(['soi-change', 'impact', 'destroyed']);
    expect(Math.abs(res.events[0].t - 50000)).toBeLessThan(1e-5);
    expect(Math.abs(res.tReached - tImpact)).toBeLessThan(1e-5);
    expect(v.soiBodyId).toBe(ID.rockyMoon);
    expect(Math.abs(len(v.r) - pip.radius)).toBeLessThan(1e-4);
    expect(v.destroyed).toBe(true);
    const imp = res.events[1];
    if (imp.type !== 'impact') throw new Error('unreachable');
    expect(imp.speed).toBeCloseTo(Math.sqrt(1500 ** 2 + 100 ** 2 + 2 * pip.mu * (1 / pip.radius - 1 / pip.soi)), 6);
  });

  // Three flybys that (found by scanning) lead to very different futures within 3e6 s.
  const futures: [string, number, number, string, string][] = [
    ['three encounters with the moon', 30000, -1, 'pip>tessaly>pip>tessaly>pip>tessaly', 'done'],
    ['two encounters, then the atmosphere', 50000, -1, 'pip>tessaly>pip>tessaly>atmosphere-enter', 'atmosphere'],
    ['two encounters, then escape to the star', 50000, 1, 'pip>tessaly>pip>tessaly>ashgrove-a', 'done'],
  ];
  for (const [label, tPeri, sense, sequence, outcome] of futures) {
    it(`never skips an SOI entry: one huge step equals many small ones (${label})`, () => {
      const total = 3e6;
      const big = pipFlyby(1.9e6, 2300, tPeri, 600, sense);
      const small = pipFlyby(1.9e6, 2300, tPeri, 600, sense);
      const resBig = coastVessel(model, big.start, big.t0, total);
      const chunk = 500;
      const evSmall: VesselEvent[] = [];
      let t = small.t0;
      let reason = 'done';
      const n = Math.round(total / chunk);
      for (let i = 0; i < n && reason === 'done'; i++) {
        const r = coastVessel(model, small.start, t, chunk);
        evSmall.push(...r.events);
        reason = r.stopReason;
        t = reason === 'done' ? small.t0 + (i + 1) * chunk : r.tReached;
      }
      const seq = (ev: VesselEvent[]): string => ev.map((e) => (e.type === 'soi-change' ? e.toBodyId : e.type)).join('>');
      expect(seq(resBig.events)).toBe(sequence);
      expect(seq(evSmall)).toBe(sequence);
      expect(resBig.stopReason).toBe(outcome);
      expect(reason).toBe(outcome);
      expect(Math.abs(resBig.tReached - t)).toBeLessThan(1e-2);
      for (let i = 0; i < evSmall.length; i++) expect(Math.abs(resBig.events[i].t - evSmall[i].t)).toBeLessThan(1e-2);
      expect(Math.abs(resBig.events[0].t - big.tEnter)).toBeLessThan(1e-5);
      expect(Math.abs(resBig.events[1].t - big.tExit)).toBeLessThan(1e-5);
      expect(big.start.soiBodyId).toBe(small.start.soiBodyId);
      // Each flyby amplifies rounding differences, so the end states agree to a relative 1e-4 only.
      expect(len(sub(big.start.r, small.start.r))).toBeLessThan(1e-4 * len(big.start.r));
    });
  }

  it('stops exactly at the top of an atmosphere, and refuses to coast inside one', () => {
    const top = tessaly.radius + tessaly.atmosphere!.height;
    const ra = 3e7;
    const rp = tessaly.radius + 5e4;
    const va = Math.sqrt(tessaly.mu * (2 / ra - 2 / (ra + rp)));
    const v = ship(ID.rocky, v3(0, 0, ra), v3(va * Math.cos(0.3), va * Math.sin(0.3), 0));
    const tEntry = timeToRadius(v, tessaly.mu, top, 'inward');
    expect(nextTrajectoryEvent(model, v, 700)).toEqual({ time: 700 + tEntry, kind: 'atmosphere', bodyId: ID.rocky });
    expect(timeToNextEvent(model, v, 700)).toBeCloseTo(tEntry, 6);
    const res = coastVessel(model, v, 700, 1e12);
    expect(res.stopReason).toBe('atmosphere');
    expect(res.tReached).toBeCloseTo(700 + tEntry, 6);
    expect(Math.abs(len(v.r) - top)).toBeLessThan(1e-5);
    expect(len(v.r)).toBeLessThan(top);
    // Again: nothing moves, no duplicate event.
    const frozen = JSON.stringify(v);
    const again = coastVessel(model, v, res.tReached, 1000);
    expect(again).toEqual({ tReached: res.tReached, stopReason: 'atmosphere', events: [] });
    expect(JSON.stringify(v)).toBe(frozen);
    // The integrator takes over without reporting the entry a second time.
    expect(stepVessel(model, v, res.tReached, 1 / 60).length).toBe(0);
    expect(nextTrajectoryEvent(model, v, res.tReached)).toBeNull();
  });

  it('covers thousands of revolutions and escapes to the star exactly', () => {
    const lowOrbit = circular(ID.rocky, tessaly.radius + 4e5);
    const start = svOf(lowOrbit);
    const res = coastVessel(model, lowOrbit, 0, 1e9); // ~182,000 revolutions, several prediction chunks
    expect(res).toEqual({ tReached: 1e9, stopReason: 'done', events: [] });
    const ref = propagateState(start, tessaly.mu, 1e9);
    expect(len(sub(lowOrbit.r, ref.r))).toBeLessThan(1);
    expect(Math.abs(len(lowOrbit.r) - (tessaly.radius + 4e5))).toBeLessThan(1e-3);

    // Out of Brannoch's SOI and around the star: one call equals many.
    const mk = (): Vessel => ship(ID.giant, v3(4e8, 0, 1e8), v3(18000, 300, 9000));
    const one = mk();
    const many = mk();
    const r1 = coastVessel(model, one, 0, 4e6);
    let t = 0;
    const ev: VesselEvent[] = [];
    for (let i = 0; i < 2000; i++) {
      ev.push(...coastVessel(model, many, t, 2000).events);
      t = (i + 1) * 2000;
    }
    expect(r1.events.map((e) => e.type)).toEqual(ev.map((e) => e.type));
    expect(r1.events.length).toBeGreaterThanOrEqual(1);
    expect(one.soiBodyId).toBe(many.soiBodyId);
    expect(one.soiBodyId).toBe(ID.star);
    expect(len(sub(one.r, many.r))).toBeLessThan(1e-9 * len(one.r) + 0.5);
  });

  it('ignores a zero or invalid dt and survives a broken state', () => {
    const v = circular(ID.rocky, tessaly.radius + 4e5);
    const frozen = JSON.stringify(v);
    expect(coastVessel(model, v, 10, 0)).toEqual({ tReached: 10, stopReason: 'done', events: [] });
    expect(coastVessel(model, v, 10, NaN).tReached).toBe(10);
    expect(coastVessel(model, v, 10, -5).tReached).toBe(10);
    expect(stepVessel(model, v, 10, 0).length).toBe(0);
    expect(stepVessel(model, v, 10, NaN).length).toBe(0);
    expect(JSON.stringify(v)).toBe(frozen);
    const bad = circular(ID.rocky, tessaly.radius + 4e5);
    bad.r.x = NaN;
    expect(stepVessel(model, bad, 0, 1).length).toBe(0);
    expect(coastVessel(model, bad, 0, 100).events).toEqual([]);
    const centre = ship(ID.rocky, v3(0, 0, 0), v3(0, 0, 0));
    expect(stepVessel(model, centre, 0, 1).length).toBe(0);
  });

  it('leaves an orbit-relative SAS pointing the right way after a coast', () => {
    const v = circular(ID.rocky, tessaly.radius + 4e5);
    setSasMode(v, 'retrograde');
    v.w = v3(0.1, 0, 0);
    v.heat = 2e7;
    coastVessel(model, v, 0, 12345);
    expect(pointingError(v, scale(v.v, -1))).toBeLessThan(1e-9);
    expect(len(v.w)).toBe(0);
    expect(v.heat).toBe(0);
    expect(Math.hypot(v.q.x, v.q.y, v.q.z, v.q.w)).toBeCloseTo(1, 12);
  });
});

// ------------------------------------------------------------------------------------ warp

describe('time warp rules', () => {
  const top = WARP_LEVELS[WARP_LEVELS.length - 1];

  it('exposes the agreed levels', () => {
    expect([...WARP_LEVELS]).toEqual([1, 2, 4, 10, 50, 100, 1000, 10000, 100000, 1000000]);
    expect(PHYSICS_WARP_MAX).toBe(10);
  });

  it('allows only physical warp while thrusting or in an atmosphere', () => {
    const v = circular(ID.rocky, tessaly.radius + 2e7);
    expect(maxWarpAllowed(model, v, 0)).toBeGreaterThan(PHYSICS_WARP_MAX);
    v.controls.throttle = 0.2;
    expect(maxWarpAllowed(model, v, 0)).toBe(PHYSICS_WARP_MAX);
    v.controls.throttle = 0;
    v.controls.translate.y = -1;
    expect(maxWarpAllowed(model, v, 0)).toBe(PHYSICS_WARP_MAX);
    v.controls.translate.y = 0;
    v.fuel = 0;
    v.controls.throttle = 1; // dry tank: not thrusting
    expect(maxWarpAllowed(model, v, 0)).toBeGreaterThan(PHYSICS_WARP_MAX);
    const low = ship(ID.rocky, v3(tessaly.radius + 9e4, 0, 0), v3(0, 0, -7900));
    expect(maxWarpAllowed(model, low, 0)).toBe(PHYSICS_WARP_MAX);
  });

  it('caps rails warp by altitude', () => {
    const at = (alt: number): number => maxWarpAllowed(model, circular(ID.rocky, tessaly.radius + alt), 0);
    expect(at(1.25e5)).toBe(50); // just above the atmosphere
    expect(at(2e5)).toBe(100);
    expect(at(4e5)).toBe(1000); // the station's orbit
    expect(at(0.6 * tessaly.radius)).toBe(10000);
    expect(at(1.4e7)).toBe(100000);
    expect(maxWarpAllowed(model, circular(ID.star, 4e9), 0)).toBe(top);
    // On an eccentric orbit the cap anticipates the descent.
    const ra = 6e7;
    const rp = tessaly.radius + 3e5;
    const va = Math.sqrt(tessaly.mu * (2 / ra - 2 / (ra + rp)));
    const v = ship(ID.rocky, v3(ra, 0, 0), v3(0, 0, -va));
    const half = Math.PI * Math.sqrt(((ra + rp) / 2) ** 3 / tessaly.mu);
    const seen: number[] = [];
    let t = 0;
    for (const back of [half, 20000, 5000, 2000, 400, 100, 0]) {
      coastVessel(model, v, t, half - back - t);
      t = half - back;
      const w = maxWarpAllowed(model, v, t);
      seen.push(w);
      // Whatever is allowed: high enough now, and not about to sink below its floor.
      const i = WARP_LEVELS.indexOf(w);
      const floor = Math.max(WARP_MIN_ALTITUDE_RADII[i] * tessaly.radius, tessaly.atmosphere!.height);
      expect(altitudeOf(v, tessaly)).toBeGreaterThanOrEqual(floor);
      expect(timeToRadius(v, tessaly.mu, tessaly.radius + floor, 'inward')).toBeGreaterThanOrEqual(w * WARP_EVENT_LEAD);
    }
    expect(seen).toEqual([100000, 10000, 10000, 1000, 1000, 100, 100]); // down to a 300 km periapsis
  });

  it('respects caps, the destroyed flag and docking', () => {
    const v = circular(ID.star, 4e9);
    expect(maxWarpAllowed(model, v, 0, { cap: 100 })).toBe(100);
    expect(maxWarpAllowed(model, v, 0, { cap: 75 })).toBe(50);
    expect(maxWarpAllowed(model, v, 0, { cap: 1 })).toBe(1);
    v.dockedAt = ID.stationLow;
    expect(maxWarpAllowed(model, v, 0)).toBe(top);
    expect(maxWarpAllowed(model, v, 0, { nextStopTime: 1000 })).toBe(1000);
    v.dockedAt = null;
    v.destroyed = true;
    expect(maxWarpAllowed(model, v, 0)).toBe(1);
  });

  it('steps down before an event and never lets a frame jump over one', () => {
    const v = circular(ID.star, 4e9);
    expect(timeToNextEvent(model, v, 500, { nextStopTime: 800 })).toBe(300);
    expect(timeToNextEvent(model, v, 500)).toBe(Infinity);
    expect(timeToNextEvent(model, v, 900, { nextStopTime: 800 })).toBe(0);
    expect(maxWarpAllowed(model, v, 0, { nextStopTime: 100 })).toBe(100); // 100·0.25 ≤ 100 < 1000·0.25
    expect(maxWarpAllowed(model, v, 0, { nextStopTime: 100, lead: 1 })).toBe(100);
    expect(maxWarpAllowed(model, v, 0, { nextStopTime: 99, lead: 1 })).toBe(50);
    expect(maxWarpAllowed(model, v, 0, { nextStopTime: 0.1 })).toBe(1);

    // Fly a warp-driven loop toward a node 3 days away, then toward an atmosphere.
    const stop = 3 * 86400 + 17.3;
    let t = 0;
    let frames = 0;
    const frame = 1 / 60;
    while (t < stop && frames < 100000) {
      const warp = maxWarpAllowed(model, v, t, { nextStopTime: stop });
      const dt = warp * frame;
      if (warp > 1) expect(t + dt).toBeLessThanOrEqual(stop);
      if (warp > PHYSICS_WARP_MAX) coastVessel(model, v, t, dt);
      else stepVessel(model, v, t, dt);
      t += dt;
      frames++;
    }
    expect(t - stop).toBeLessThan(frame + 1e-9); // arrived at 1×, at most one real frame late
    expect(frames).toBeLessThan(3000); // …in well under a minute of real time
  });

  it('a warp-driven descent arrives at the atmosphere at low warp without passing it', () => {
    const topR = tessaly.radius + tessaly.atmosphere!.height;
    const ra = 4e7;
    const rp = tessaly.radius + 6e4;
    const va = Math.sqrt(tessaly.mu * (2 / ra - 2 / (ra + rp)));
    const v = ship(ID.rocky, v3(ra, 0, 0), v3(0, 0, -va));
    const tEntry = timeToRadius(v, tessaly.mu, topR, 'inward');
    let t = 0;
    let frames = 0;
    let maxWarp = 0;
    let lastWarp = 0;
    const events: VesselEvent[] = [];
    while (!inAtmosphere(v, tessaly) && frames < 200000) {
      const warp = maxWarpAllowed(model, v, t);
      maxWarp = Math.max(maxWarp, warp);
      lastWarp = warp;
      const dt = warp / 60;
      if (warp > PHYSICS_WARP_MAX) {
        const r = coastVessel(model, v, t, dt);
        events.push(...r.events);
        t = r.tReached;
      } else {
        events.push(...stepVessel(model, v, t, dt));
        t += dt;
      }
      frames++;
    }
    expect(maxWarp).toBeGreaterThanOrEqual(10000);
    expect(lastWarp).toBeLessThanOrEqual(PHYSICS_WARP_MAX);
    expect(events.map((e) => e.type)).toEqual(['atmosphere-enter']);
    expect(Math.abs(events[0].t - tEntry)).toBeLessThan(lastWarp / 60 + 1e-6);
    expect(len(v.r)).toBeGreaterThan(topR - 2000); // only just inside
    expect(frames).toBeLessThan(5000);
  });
});

// ------------------------------------------------------------------------------------ relative motion

describe('relative motion', () => {
  it('matches the absolute states for targets in the same and in different SOI frames', () => {
    const t = 12345;
    const v = circular(ID.rocky, tessaly.radius + 5e5);
    const me = absState(v, t);
    const cases = [
      stationFramedState(model, ID.stationLow, t),
      stationFramedState(model, ID.stationMoon, t),
      orbiterFramedState(model, model.station(ID.orbiter2).orbit, ID.rocky, t),
      orbiterFramedState(model, model.site(ID.site).orbit, ID.giant, t),
    ];
    const absolutes = [
      model.stationAbsState(ID.stationLow, t),
      model.stationAbsState(ID.stationMoon, t),
      model.stationAbsState(ID.orbiter2, t),
      model.siteAbsState(ID.site, t),
    ];
    expect(cases.map((c) => c.soiBodyId)).toEqual([ID.rocky, ID.giantMoonLarge, ID.rocky, ID.giant]);
    cases.forEach((target, i) => {
      const rel = relativeMotion(model, v, target, t);
      const dr = sub(absolutes[i].r, me.r);
      const dv = sub(absolutes[i].v, me.v);
      expect(len(sub(rel.r, dr))).toBeLessThan(1e-9 * len(dr) + 1e-4);
      expect(len(sub(rel.v, dv))).toBeLessThan(1e-9 * len(dv) + 1e-7);
      expect(rel.distance).toBeCloseTo(len(rel.r), 6);
      expect(rel.speed).toBeCloseTo(len(rel.v), 9);
      expect(rel.closingSpeed).toBeCloseTo(-dot(rel.r, rel.v) / len(rel.r), 6);
    });
    // Reversing observer and target flips the vectors.
    const a = relativeMotion(model, v, cases[1], t);
    const b = relativeMotion(model, cases[1], v, t);
    expect(len(add(a.r, b.r))).toBeLessThan(1e-3);
    expect(a.closingSpeed).toBeCloseTo(b.closingSpeed, 6);
  });

  it('gives the straight-line closest approach', () => {
    const me = { soiBodyId: ID.rocky, r: v3(7e6, 0, 0), v: v3(0, 0, -7000) };
    const target = { soiBodyId: ID.rocky, r: v3(7e6 + 300, 400, -5000), v: v3(0, 0, -6990) };
    const rel = relativeMotion(model, me, target, 0);
    expect(rel.closingSpeed).toBeCloseTo((5000 * 10) / Math.hypot(300, 400, 5000), 9);
    expect(rel.timeToClosest).toBeCloseTo(500, 9);
    expect(rel.missDistance).toBeCloseTo(500, 6);
    // Opening: no approach ahead.
    const away = relativeMotion(model, me, { ...target, v: v3(0, 0, -7010) }, 0);
    expect(away.closingSpeed).toBeLessThan(0);
    expect(away.timeToClosest).toBe(0);
    expect(away.missDistance).toBeCloseTo(away.distance, 9);
    // Feeds the SAS directly.
    const v = ship(ID.rocky, me.r, me.v);
    expect(len(sub(sasDirection('target', v, { targetRelPos: rel.r })!, norm(rel.r)))).toBeLessThan(1e-12);
    expect(len(sub(sasDirection('killRelative', v, { targetRelVel: rel.v })!, norm(rel.v)))).toBeLessThan(1e-12);
  });

  it('a docked vessel rides its station', () => {
    const v = circular(ID.star, 4e9);
    v.dockedAt = ID.stationLow;
    v.heat = 1e7;
    expect(stepVessel(model, v, 100, 1 / 60).length).toBe(0);
    const s = model.stationState(ID.stationLow, 100 + 1 / 60);
    expect(v.soiBodyId).toBe(ID.rocky);
    expect(len(sub(v.r, s.r))).toBe(0);
    expect(len(sub(v.v, s.v))).toBe(0);
    const res = coastVessel(model, v, 200, 5000);
    expect(res).toEqual({ tReached: 5200, stopReason: 'done', events: [] });
    expect(len(sub(v.r, model.stationState(ID.stationLow, 5200).r))).toBe(0);
    expect(v.heat).toBe(0);
    expect(relativeMotion(model, v, stationFramedState(model, ID.stationLow, 5200), 5200).distance).toBe(0);
  });
});

// ------------------------------------------------------------------------------------ station collisions

describe('station collision helpers', () => {
  const sphere: StationCollider = { kind: 'sphere', a: v3(0, 100, 0), radius: 50 };
  const capsule: StationCollider = { kind: 'capsule', a: v3(-200, 0, 0), b: v3(200, 0, 0), radius: 30 };
  const c = newColliderContact();

  it('sphere against sphere', () => {
    expect(sphereColliderContact(v3(0, 100, 70), 10, sphere, c)).toBe(false);
    expect(c.depth).toBeCloseTo(-10, 12);
    expect(sphereColliderContact(v3(0, 100, 55), 10, sphere, c)).toBe(true);
    expect(c.depth).toBeCloseTo(5, 12);
    expect(c.normal).toEqual(v3(0, 0, 1));
    expect(c.point).toEqual(v3(0, 100, 50));
    // Dead centre still yields a unit normal.
    expect(sphereColliderContact(v3(0, 100, 0), 10, sphere, c)).toBe(true);
    expect(c.depth).toBeCloseTo(60, 12);
    expect(len(c.normal)).toBeCloseTo(1, 12);
  });

  it('sphere against capsule: side, end cap and axis', () => {
    expect(sphereColliderContact(v3(50, 35, 0), 9, capsule, c)).toBe(true);
    expect(c.depth).toBeCloseTo(4, 12);
    expect(c.normal).toEqual(v3(0, 1, 0));
    expect(c.point).toEqual(v3(50, 30, 0));
    expect(sphereColliderContact(v3(236, 0, 0), 9, capsule, c)).toBe(true);
    expect(c.depth).toBeCloseTo(3, 12);
    expect(c.normal).toEqual(v3(1, 0, 0));
    const diag = v3(200 + 30, 30, 0);
    expect(sphereColliderContact(diag, 9, capsule, c)).toBe(false);
    expect(c.depth).toBeCloseTo(39 - Math.hypot(30, 30), 12);
    expect(len(sub(c.normal, norm(v3(1, 1, 0))))).toBeLessThan(1e-12);
    // On the axis: a normal perpendicular to it.
    expect(sphereColliderContact(v3(10, 0, 0), 9, capsule, c)).toBe(true);
    expect(c.depth).toBeCloseTo(39, 12);
    expect(len(c.normal)).toBeCloseTo(1, 12);
    expect(Math.abs(c.normal.x)).toBeLessThan(1e-12);
  });

  it('stationContact reports the deepest overlap, or the nearest clearance', () => {
    const colliders = [sphere, capsule];
    expect(stationContact(v3(0, 60, 0), 12, colliders, c)).toBe(true);
    expect(c.index).toBe(0); // 2 m into the sphere, clear of the capsule by 18 m
    expect(c.depth).toBeCloseTo(22, 12);
    expect(c.normal).toEqual(v3(0, -1, 0));
    expect(stationContact(v3(100, -100, 0), 12, colliders, c)).toBe(false);
    expect(c.index).toBe(1);
    expect(c.depth).toBeCloseTo(-58, 12);
    expect(stationContact(v3(0, 0, 0), 5, [], c)).toBe(false);
    expect(c.depth).toBe(-Infinity);
  });

  it('stationAttitude puts +Y on the orbit normal and +X toward periapsis', () => {
    expect(stationAttitude({ a: 7e6, e: 0, i: 0, lan: 0, argp: 0, m0: 0, epoch: 0 })).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    const el = model.station(ID.orbiter2).orbit;
    const q = stationAttitude(el);
    const y = qRotate(q, v3(0, 1, 0));
    expect(len(sub(y, orbitNormalFromElements(el)))).toBeLessThan(1e-12);
    const peri = norm(model.orbiterState({ ...el, m0: 0 }, ID.rocky, 0).r);
    expect(len(sub(qRotate(q, v3(1, 0, 0)), peri))).toBeLessThan(1e-12);
    const w = v3(120, -40, 900);
    const local = toStationLocal(w, q);
    expect(len(sub(fromStationLocal(local, q), w))).toBeLessThan(1e-10);
    expect(local.y).toBeCloseTo(dot(w, y), 9);
    expect(len(local)).toBeCloseTo(len(w), 9);
  });
});

// ------------------------------------------------------------------------------------ determinism & robustness

describe('determinism and serialisation', () => {
  /** A busy flight: slews, a main-drive burn, RCS, manual steering and an aerobraking pass. */
  function scenario(snapshotAt = -1): string {
    // 150 km periapsis, 900 s before it; a retrograde burn then drops the periapsis into the air.
    const el = { a: 7.85e6, e: 1 - (tessaly.radius + 1.5e5) / 7.85e6, i: 0.2, lan: 0.4, argp: 1.0, m0: 0, epoch: 0 };
    const s0 = propagateState(model.orbiterState(el, ID.rocky, 0), tessaly.mu, -900);
    let v = createVessel(STATS, { id: 'det', name: 'Determinist', soiBodyId: ID.rocky, r: s0.r, v: s0.v, cargoMass: 2500 });
    const log: string[] = [];
    let t = 0;
    for (let i = 0; i < 9000; i++) {
      if (i === snapshotAt) v = JSON.parse(JSON.stringify(v)) as Vessel;
      if (i === 0) setSasMode(v, 'retrograde');
      if (i === 300) v.controls.throttle = 0.7;
      if (i === 330) v.controls.throttle = 0;
      if (i === 400) v.controls.translate = v3(0.5, -1, 0);
      if (i === 700) v.controls.translate = v3(0, 0, 0);
      if (i === 1000) setSasMode(v, 'stability');
      if (i === 1100) v.controls.pitch = 0.8;
      if (i === 1200) v.controls.pitch = 0;
      if (i === 2000) setSasMode(v, 'prograde');
      if (i === 7000) setSasMode(v, 'normal');
      const ev = stepVessel(model, v, t, 1 / 6);
      t = (i + 1) / 6;
      for (const e of ev) log.push(JSON.stringify(e));
    }
    return JSON.stringify(v) + log.join('|');
  }

  it('the same inputs give bit-identical results', () => {
    const a = scenario();
    expect(scenario()).toBe(a);
    // The flight did what it was meant to: burned, entered and left the air, and survived.
    expect(a).toContain('atmosphere-enter');
    expect(a).toContain('atmosphere-exit');
    expect(a).toContain('"destroyed":false');
    expect(a).not.toMatch(/NaN|Infinity|null,null/);
  });

  it('a JSON round trip in mid-flight changes nothing', () => {
    const a = scenario();
    expect(scenario(1)).toBe(a);
    expect(scenario(315)).toBe(a); // mid-burn
    expect(scenario(1150)).toBe(a); // mid-turn
    expect(scenario(5000)).toBe(a);
  });

  it('createVessel copies its inputs and fills the defaults', () => {
    const r = v3(1, 2, 3);
    const v = createVessel(STATS, { id: 'a', soiBodyId: ID.star, r, v: v3(4, 5, 6) });
    r.x = 99;
    expect(v.r.x).toBe(1);
    expect(v.stats).not.toBe(STATS);
    expect(v.stats).toEqual(STATS);
    expect(v).toMatchObject({ name: 'a', fuel: 15000, cargoMass: 0, hull: 1000, shield: 200, heat: 0, dockedAt: null, destroyed: false, sasMode: 'stability', sasTarget: null });
    expect(v.q).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(createVessel(STATS, { id: 'b', soiBodyId: ID.star, r, v: r, fuel: 1e9 }).fuel).toBe(15000);
    expect(JSON.parse(JSON.stringify(v))).toEqual(v);
  });

  it('garbage control inputs are clamped and never produce NaN', () => {
    const v = circular(ID.rocky, tessaly.radius + 4e5);
    v.controls.throttle = 7;
    v.controls.pitch = NaN;
    v.controls.yaw = -50;
    v.controls.roll = Infinity;
    v.controls.translate = v3(NaN, 9, -9);
    setSasMode(v, 'stability');
    const twin = circular(ID.rocky, tessaly.radius + 4e5);
    twin.controls.throttle = 1;
    twin.controls.yaw = -1;
    twin.controls.roll = 1;
    twin.controls.translate = v3(0, 1, -1);
    setSasMode(twin, 'stability');
    run(v, 0, 600, 1 / 60);
    run(twin, 0, 600, 1 / 60);
    for (const x of [v.r.x, v.r.y, v.r.z, v.v.x, v.v.y, v.v.z, v.q.x, v.q.y, v.q.z, v.q.w, v.w.x, v.w.y, v.w.z, v.fuel, v.heat]) {
      expect(Number.isFinite(x)).toBe(true);
    }
    expect(len(v.w)).toBeLessThanOrEqual(STATS.maxAngularRate * Math.SQRT2 * (1 + 1e-9));
    expect(v.fuel).toBeCloseTo(twin.fuel, 9);
    expect(len(sub(v.r, twin.r))).toBeLessThan(1e-6);
    expect(altitudeOf(v, tessaly)).toBeGreaterThan(0);
  });
});
