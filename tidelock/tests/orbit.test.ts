// Tests for src/sim/orbit.ts — the orbital-mechanics core.
//
// Reference results come from sources independent of the code under test wherever possible: a
// brute-force RK4 integrator and a textbook (z-up) element conversion written here, closed-form
// results (Barker's equation, free fall), and well-known real-world numbers.

import { describe, expect, it } from 'vitest';
import type { OrbitElements, StateVector, V3 } from '../src/core/types';
import { makeRng, type Rng } from '../src/core/rng';
import { AU, DAY, DEG, EARTH_MASS, G, SOLAR_MASS } from '../src/core/units';
import { add, addScaled, cross, dot, len, norm, scale, sub, wrapPi } from '../src/core/vec';
import {
  SystemModel,
  circularSpeed,
  closestApproach,
  closestApproaches,
  deriveSystem,
  elementsToState,
  elementsToStateTo,
  escapeSpeed,
  hohmann,
  meanMotion,
  newState,
  orbitInfo,
  orbitNormal,
  orbitNormalFromElements,
  orbitalFrame,
  orbitalPeriod,
  patchStateAt,
  period,
  phaseAngle,
  predictTrajectory,
  propagateState,
  propagateStateTo,
  relativeInclination,
  sampleOrbit,
  samplePatch,
  soiRadius,
  solveKepler,
  solveKeplerHyperbolic,
  stateToElements,
  synodicPeriod,
  timeToNode,
  timeToRadius,
  timeToTrueAnomaly,
  trajectoryStateAt,
  visViva,
  type TrajectoryPatch,
} from '../src/sim/orbit';
import { TEST_IDS as ID, makeTestSystem } from './fixtures/system';

const MU_EARTH = 3.986004418e14;
const R_EARTH = 6378137;
const TAU = Math.PI * 2;

// ------------------------------------------------------------------------------------ helpers

const sv = (rx: number, ry: number, rz: number, vx: number, vy: number, vz: number): StateVector => ({
  r: { x: rx, y: ry, z: rz },
  v: { x: vx, y: vy, z: vz },
});

const finiteState = (s: StateVector): boolean =>
  [s.r.x, s.r.y, s.r.z, s.v.x, s.v.y, s.v.z].every((n) => Number.isFinite(n));

const finiteElements = (e: OrbitElements): boolean => [e.a, e.e, e.i, e.lan, e.argp, e.m0, e.epoch].every((n) => Number.isFinite(n));

/** Relative difference of two states: position against |r|, velocity against max(|v|, local circular speed). */
function stateError(a: StateVector, b: StateVector, mu: number): number {
  const r = len(a.r);
  const dr = len(sub(a.r, b.r)) / r;
  const dv = len(sub(a.v, b.v)) / Math.max(len(a.v), Math.sqrt(mu / r));
  return Math.max(dr, dv);
}

const expectNear = (actual: number, expected: number, tol: number, what = ''): void => {
  expect(Math.abs(actual - expected), `${what} actual ${actual} expected ${expected} ± ${tol}`).toBeLessThanOrEqual(tol);
};

const expectRel = (actual: number, expected: number, tol: number, what = ''): void => {
  expect(Math.abs(actual - expected) / Math.abs(expected), `${what} actual ${actual} expected ${expected} (rel ${tol})`).toBeLessThanOrEqual(tol);
};

const specificEnergy = (s: StateVector, mu: number): number => 0.5 * dot(s.v, s.v) - mu / len(s.r);

const eccVector = (s: StateVector, mu: number): V3 => {
  const r = len(s.r);
  return scale(sub(scale(s.r, dot(s.v, s.v) - mu / r), scale(s.v, dot(s.r, s.v))), 1 / mu);
};

/** One classical RK4 step of two-body motion; `s` = [x, y, z, vx, vy, vz], advanced in place. */
function rk4Step(s: Float64Array, mu: number, h: number): void {
  const acc = (x: number, y: number, z: number): [number, number, number] => {
    const k = -mu / Math.pow(x * x + y * y + z * z, 1.5);
    return [x * k, y * k, z * k];
  };
  const [x, y, z, vx, vy, vz] = s;
  const a1 = acc(x, y, z);
  const x2 = x + 0.5 * h * vx, y2 = y + 0.5 * h * vy, z2 = z + 0.5 * h * vz;
  const vx2 = vx + 0.5 * h * a1[0], vy2 = vy + 0.5 * h * a1[1], vz2 = vz + 0.5 * h * a1[2];
  const a2 = acc(x2, y2, z2);
  const x3 = x + 0.5 * h * vx2, y3 = y + 0.5 * h * vy2, z3 = z + 0.5 * h * vz2;
  const vx3 = vx + 0.5 * h * a2[0], vy3 = vy + 0.5 * h * a2[1], vz3 = vz + 0.5 * h * a2[2];
  const a3 = acc(x3, y3, z3);
  const x4 = x + h * vx3, y4 = y + h * vy3, z4 = z + h * vz3;
  const vx4 = vx + h * a3[0], vy4 = vy + h * a3[1], vz4 = vz + h * a3[2];
  const a4 = acc(x4, y4, z4);
  s[0] = x + (h / 6) * (vx + 2 * vx2 + 2 * vx3 + vx4);
  s[1] = y + (h / 6) * (vy + 2 * vy2 + 2 * vy3 + vy4);
  s[2] = z + (h / 6) * (vz + 2 * vz2 + 2 * vz3 + vz4);
  s[3] = vx + (h / 6) * (a1[0] + 2 * a2[0] + 2 * a3[0] + a4[0]);
  s[4] = vy + (h / 6) * (a1[1] + 2 * a2[1] + 2 * a3[1] + a4[1]);
  s[5] = vz + (h / 6) * (a1[2] + 2 * a2[2] + 2 * a3[2] + a4[2]);
}

const toArr = (s: StateVector): Float64Array => Float64Array.of(s.r.x, s.r.y, s.r.z, s.v.x, s.v.y, s.v.z);
const fromArr = (a: Float64Array): StateVector => sv(a[0], a[1], a[2], a[3], a[4], a[5]);

/** Brute-force two-body propagation: `steps` RK4 steps over `dt` seconds. */
function rk4Propagate(s0: StateVector, mu: number, dt: number, steps: number): StateVector {
  const s = toArr(s0);
  const h = dt / steps;
  for (let i = 0; i < steps; i++) rk4Step(s, mu, h);
  return fromArr(s);
}

/**
 * Textbook element -> state conversion in the usual z-up frame (Newton iteration on Kepler's
 * equation, perifocal coordinates, R3(-Ω)·R1(-i)·R3(-ω)), then mapped into project axes with
 * (x, y, z)_textbook -> (x, z, -y). Elliptic orbits only.
 */
function textbookState(el: OrbitElements, mu: number, t: number): StateVector {
  const { a, e } = el;
  const M = el.m0 + Math.sqrt(mu / (a * a * a)) * (t - el.epoch);
  let E = M + e * Math.sin(M);
  for (let k = 0; k < 60; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const b = Math.sqrt(1 - e * e);
  const xp = a * (Math.cos(E) - e);
  const yp = a * b * Math.sin(E);
  const r = a * (1 - e * Math.cos(E));
  const k = Math.sqrt(mu * a) / r;
  const vxp = -k * Math.sin(E);
  const vyp = k * b * Math.cos(E);
  const cO = Math.cos(el.lan), sO = Math.sin(el.lan);
  const cw = Math.cos(el.argp), sw = Math.sin(el.argp);
  const ci = Math.cos(el.i), si = Math.sin(el.i);
  const m11 = cO * cw - sO * sw * ci, m12 = -cO * sw - sO * cw * ci;
  const m21 = sO * cw + cO * sw * ci, m22 = -sO * sw + cO * cw * ci;
  const m31 = sw * si, m32 = cw * si;
  const X = m11 * xp + m12 * yp, Y = m21 * xp + m22 * yp, Z = m31 * xp + m32 * yp;
  const VX = m11 * vxp + m12 * vyp, VY = m21 * vxp + m22 * vyp, VZ = m31 * vxp + m32 * vyp;
  return sv(X, Z, -Y, VX, VZ, -VY);
}

const randomUnit = (rng: Rng): V3 => norm({ x: rng.gauss(), y: rng.gauss(), z: rng.gauss() });

/** A random, comfortably non-degenerate elliptic element set around a body of radius-scale `rScale`. */
function randomEllipse(rng: Rng, rScale: number, eMax = 0.9): OrbitElements {
  const e = rng.range(0.01, eMax);
  const rp = rScale * Math.exp(rng.range(0, 3));
  return {
    a: rp / (1 - e),
    e,
    i: rng.range(0.05, Math.PI - 0.05),
    lan: rng.range(0, TAU),
    argp: rng.range(0, TAU),
    m0: rng.range(-Math.PI, Math.PI),
    epoch: rng.range(-1e5, 1e5),
  };
}

function randomHyperbola(rng: Rng, rScale: number): OrbitElements {
  const e = rng.range(1.05, 5);
  const rp = rScale * Math.exp(rng.range(0, 3));
  return {
    a: rp / (1 - e),
    e,
    i: rng.range(0.05, Math.PI - 0.05),
    lan: rng.range(0, TAU),
    argp: rng.range(0, TAU),
    m0: rng.range(-3, 3),
    epoch: rng.range(-1e5, 1e5),
  };
}

// ------------------------------------------------------------------------------------ scalar helpers

describe('scalar helpers (real-world numbers)', () => {
  it('gives the period of a 400 km low Earth orbit (~92.6 min)', () => {
    const T = orbitalPeriod(MU_EARTH, R_EARTH + 400e3);
    expectNear(T, 5553.6, 0.5);
    expect(period).toBe(orbitalPeriod);
    expectNear(meanMotion(MU_EARTH, R_EARTH + 400e3) * T, TAU, 1e-12);
  });

  it('puts the geostationary orbit at 42,164 km', () => {
    expectNear(orbitalPeriod(MU_EARTH, 42164.17e3), 86164.09, 0.5);
    // Invert Kepler's third law for one sidereal day.
    const a = Math.cbrt(MU_EARTH * Math.pow(86164.0905 / TAU, 2));
    expectNear(a, 42164.17e3, 100);
    expectNear(circularSpeed(MU_EARTH, a), 3074.66, 0.05);
  });

  it('gives LEO circular speed, surface escape speed and vis-viva', () => {
    expectNear(circularSpeed(MU_EARTH, R_EARTH + 400e3), 7668.6, 0.5);
    expectNear(escapeSpeed(MU_EARTH, R_EARTH), 11179.9, 1);
    expectNear(escapeSpeed(MU_EARTH, 7e6) / circularSpeed(MU_EARTH, 7e6), Math.SQRT2, 1e-12);
    expectNear(visViva(MU_EARTH, 7e6, 7e6), circularSpeed(MU_EARTH, 7e6), 1e-9);
    expectNear(visViva(MU_EARTH, 7e6, Infinity), escapeSpeed(MU_EARTH, 7e6), 1e-9);
    // Hyperbola: v² = v_esc² + v_inf², v_inf² = mu/|a|.
    const a = -2e7;
    expectNear(visViva(MU_EARTH, 7e6, a) ** 2, escapeSpeed(MU_EARTH, 7e6) ** 2 + MU_EARTH / 2e7, 1e-3);
    expect(orbitalPeriod(MU_EARTH, a)).toBe(Infinity);
  });

  it('gives the Earth–Mars synodic period and the Earth SOI', () => {
    expectNear(synodicPeriod(365.256 * DAY, 686.98 * DAY) / DAY, 779.9, 0.2);
    expect(synodicPeriod(100, 100)).toBe(Infinity);
    expectRel(soiRadius(AU, EARTH_MASS, SOLAR_MASS), 9.246e8, 2e-3);
  });

  it('computes the LEO -> GEO Hohmann transfer', () => {
    const r1 = 6678e3;
    const r2 = 42164e3;
    const h = hohmann(MU_EARTH, r1, r2);
    expectNear(h.dv1, 2425.8, 2);
    expectNear(h.dv2, 1466.8, 2);
    expectNear(h.dvTotal, h.dv1 + h.dv2, 1e-9);
    expectNear(h.tof, 18990, 30);
    expectNear(h.phaseAngle / DEG, 100.7, 0.3);
    // Fly it: burn prograde at r1, coast for tof, arrive at r2 needing exactly dv2 to circularise.
    const start = sv(r1, 0, 0, 0, 0, -(circularSpeed(MU_EARTH, r1) + h.dv1));
    const end = propagateState(start, MU_EARTH, h.tof);
    expectRel(len(end.r), r2, 1e-10);
    expectNear(len(end.v) + h.dv2, circularSpeed(MU_EARTH, r2), 1e-6);
    expectNear(end.r.x, -r2, 1e-2);
    // Inward transfer: both burns retrograde, same magnitudes.
    const back = hohmann(MU_EARTH, r2, r1);
    expectNear(back.dv1, -h.dv2, 1e-9);
    expectNear(back.dv2, -h.dv1, 1e-9);
  });

  it('measures phase angles counter-clockwise seen from +Y', () => {
    expectNear(phaseAngle({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: -2 }), Math.PI / 2, 1e-15);
    expectNear(phaseAngle({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 2 }), -Math.PI / 2, 1e-15);
    expectNear(phaseAngle({ x: 1, y: 5, z: 0 }, { x: -3, y: -2, z: 0 }), Math.PI, 1e-15);
    // About an arbitrary normal: rotate `from` by a known angle about it.
    const n = norm({ x: 0.3, y: 0.8, z: -0.5 });
    const from = norm(cross(n, { x: 1, y: 0, z: 0 }));
    const side = cross(n, from);
    const ang = 0.7;
    const to = add(scale(from, Math.cos(ang)), scale(side, Math.sin(ang)));
    expectNear(phaseAngle(from, to, n), ang, 1e-12);
  });
});

// ------------------------------------------------------------------------------------ Kepler's equation

describe("Kepler's equation", () => {
  it('solves the elliptic equation for every M and e in [0, 1)', () => {
    const rng = makeRng('kepler-elliptic');
    let worst = 0;
    for (let k = 0; k < 20000; k++) {
      const e = k % 4 === 0 ? 1 - Math.pow(10, -rng.range(1, 9)) : rng.range(0, 0.999);
      const M = rng.range(-20, 20);
      const E = solveKepler(M, e);
      const res = Math.abs(E - e * Math.sin(E) - M);
      worst = Math.max(worst, res);
      expect(Math.abs(E - M)).toBeLessThanOrEqual(e + 1e-12); // same revolution as M
    }
    expect(worst).toBeLessThan(2e-14 * 20);
    expect(solveKepler(0, 0.5)).toBe(0);
    expectNear(solveKepler(Math.PI, 0.5), Math.PI, 1e-15);
  });

  it('solves the hyperbolic equation', () => {
    const rng = makeRng('kepler-hyperbolic');
    let worst = 0;
    for (let k = 0; k < 20000; k++) {
      const e = k % 4 === 0 ? 1 + Math.pow(10, -rng.range(1, 9)) : rng.range(1.001, 10);
      const M = rng.range(-1, 1) * Math.pow(10, rng.range(-6, 3));
      const H = solveKeplerHyperbolic(M, e);
      const res = Math.abs(e * Math.sinh(H) - H - M) / Math.max(1, Math.abs(M), Math.abs(H));
      worst = Math.max(worst, res);
    }
    expect(worst).toBeLessThan(1e-13);
    expect(solveKeplerHyperbolic(0, 2)).toBe(0);
  });
});

// ------------------------------------------------------------------------------------ axis convention

describe('axis convention (XZ reference plane, +Y north)', () => {
  const mu = MU_EARTH;

  it('puts the zero-element periapsis on +X moving toward -Z', () => {
    const el: OrbitElements = { a: 1e7, e: 0.2, i: 0, lan: 0, argp: 0, m0: 0, epoch: 0 };
    const s = elementsToState(el, mu, 0);
    expectNear(s.r.x, 8e6, 1e-6);
    expectNear(s.r.y, 0, 1e-9);
    expectNear(s.r.z, 0, 1e-6);
    expectNear(s.v.x, 0, 1e-9);
    expectNear(s.v.y, 0, 1e-9);
    expectNear(s.v.z, -visViva(mu, 8e6, 1e7), 1e-9);
    const n = orbitNormal(s);
    expectNear(n.y, 1, 1e-15);
    // Half a period later: apoapsis on -X moving toward +Z.
    const ap = elementsToState(el, mu, orbitalPeriod(mu, 1e7) / 2);
    expectNear(ap.r.x, -1.2e7, 1e-5);
    expect(ap.v.z).toBeGreaterThan(0);
  });

  it('runs prograde orbits counter-clockwise seen from +Y (+X toward -Z)', () => {
    const el: OrbitElements = { a: 1e7, e: 0, i: 0, lan: 0, argp: 0, m0: 0, epoch: 0 };
    const q = elementsToState(el, mu, orbitalPeriod(mu, 1e7) / 4);
    expectNear(q.r.x, 0, 1e-5);
    expectNear(q.r.z, -1e7, 1e-5);
  });

  it('measures inclination from XZ toward +Y and the node from +X toward -Z', () => {
    const i = 30 * DEG;
    // Ascending node on +X: a quarter orbit after the node the body is at its northernmost point.
    const el: OrbitElements = { a: 1e7, e: 0, i, lan: 0, argp: 0, m0: Math.PI / 2, epoch: 0 };
    const s = elementsToState(el, mu, 0);
    expectNear(s.r.x, 0, 1e-6);
    expectNear(s.r.y, 1e7 * Math.sin(i), 1e-6);
    expectNear(s.r.z, -1e7 * Math.cos(i), 1e-6);
    // Node rotated 90° from +X toward -Z.
    const el2: OrbitElements = { a: 1e7, e: 0, i, lan: Math.PI / 2, argp: 0, m0: 0, epoch: 0 };
    const s2 = elementsToState(el2, mu, 0);
    expectNear(s2.r.x, 0, 1e-6);
    expectNear(s2.r.y, 0, 1e-6);
    expectNear(s2.r.z, -1e7, 1e-6);
    expect(s2.v.y).toBeGreaterThan(0); // ascending
    // And back again.
    const back = stateToElements(s2, mu, 0);
    expectNear(back.i, i, 1e-12);
    expectNear(back.lan, Math.PI / 2, 1e-12);
  });

  it('matches the textbook z-up formulas mapped by (x, y, z) -> (x, z, -y)', () => {
    const rng = makeRng('textbook');
    let worst = 0;
    let worstNormal = 0;
    for (let k = 0; k < 3000; k++) {
      const el = randomEllipse(rng, 7e6, 0.95);
      const t = rng.range(-2e5, 2e5);
      const ours = elementsToState(el, mu, t);
      worst = Math.max(worst, stateError(textbookState(el, mu, t), ours, mu));
      const n = orbitNormalFromElements(el);
      worstNormal = Math.max(worstNormal, len(sub(n, orbitNormal(ours))));
    }
    expect(worst).toBeLessThan(1e-11);
    expect(worstNormal).toBeLessThan(1e-12);
  });
});

// ------------------------------------------------------------------------------------ elements <-> state

describe('elements <-> state round trips', () => {
  const mu = MU_EARTH;

  it('elements -> state -> elements over random ellipses and hyperbolas', () => {
    const rng = makeRng('round-trip-elements');
    let worst = 0;
    for (let k = 0; k < 6000; k++) {
      const el = k % 2 === 0 ? randomEllipse(rng, 7e6) : randomHyperbola(rng, 7e6);
      const t = el.epoch + rng.range(-3e4, 3e4);
      const back = stateToElements(elementsToState(el, mu, t), mu, t);
      const mNow = el.m0 + meanMotion(mu, el.a) * (t - el.epoch);
      const dM = el.a > 0 ? Math.abs(wrapPi(back.m0 - mNow)) : Math.abs(back.m0 - mNow) / Math.max(1, Math.abs(mNow));
      const err = Math.max(
        Math.abs(back.a - el.a) / Math.abs(el.a),
        Math.abs(back.e - el.e),
        Math.abs(back.i - el.i),
        Math.abs(wrapPi(back.lan - el.lan)),
        Math.abs(wrapPi(back.argp - el.argp)),
        dM,
      );
      worst = Math.max(worst, err);
      expect(back.epoch).toBe(t);
    }
    expect(worst).toBeLessThan(2e-9);
  });

  it('state -> elements -> state over random states (all conics)', () => {
    const rng = makeRng('round-trip-states');
    let worst = 0;
    for (let k = 0; k < 30000; k++) {
      const r = 7e6 * Math.exp(rng.range(-1, 4));
      const vEsc = escapeSpeed(mu, r);
      const speed = vEsc * (k % 3 === 0 ? rng.range(0.05, 0.98) : k % 3 === 1 ? rng.range(1.02, 3) : rng.range(0.3, 1.5));
      const s: StateVector = { r: scale(randomUnit(rng), r), v: scale(randomUnit(rng), speed) };
      const el = stateToElements(s, mu, 42);
      expect(finiteElements(el)).toBe(true);
      expect(el.a > 0 ? el.e < 1 : el.e > 1).toBe(true);
      worst = Math.max(worst, stateError(s, elementsToState(el, mu, 42), mu));
    }
    expect(worst).toBeLessThan(1e-10);
  });

  it('handles circular orbits (any plane): e = 0, argp = 0', () => {
    const rng = makeRng('circular');
    for (let k = 0; k < 200; k++) {
      const r = 7e6 * Math.exp(rng.range(0, 3));
      const u = randomUnit(rng);
      const t = norm(cross(u, randomUnit(rng)));
      const s: StateVector = { r: scale(u, r), v: scale(t, circularSpeed(mu, r)) };
      const el = stateToElements(s, mu, 0);
      expect(finiteElements(el)).toBe(true);
      expect(el.e).toBeLessThan(1e-9);
      expectRel(el.a, r, 1e-9);
      expect(stateError(s, elementsToState(el, mu, 0), mu)).toBeLessThan(1e-9);
    }
    // Exactly circular and equatorial.
    const s = sv(8e6, 0, 0, 0, 0, -circularSpeed(mu, 8e6));
    const el = stateToElements(s, mu, 0);
    expect(el.e).toBe(0);
    expect(el.argp).toBe(0);
    expect(el.i).toBe(0);
    expect(el.lan).toBe(0);
    expect(stateError(s, elementsToState(el, mu, 0), mu)).toBeLessThan(1e-12);
  });

  it('handles equatorial orbits, prograde and retrograde: lan = 0', () => {
    const rng = makeRng('equatorial');
    for (let k = 0; k < 400; k++) {
      const r = 7e6 * Math.exp(rng.range(0, 3));
      const ang = rng.range(0, TAU);
      const speed = escapeSpeed(mu, r) * rng.range(0.3, 1.6);
      const dir = rng.range(0, TAU);
      const s = sv(r * Math.cos(ang), 0, r * Math.sin(ang), speed * Math.cos(dir), 0, speed * Math.sin(dir));
      const el = stateToElements(s, mu, 0);
      expect(finiteElements(el)).toBe(true);
      const hy = s.r.z * s.v.x - s.r.x * s.v.z;
      expect(el.i).toBe(hy > 0 ? 0 : Math.PI);
      expect(el.lan).toBe(0);
      expect(stateError(s, elementsToState(el, mu, 0), mu)).toBeLessThan(1e-9);
    }
    // Retrograde circular equatorial: the most degenerate combination.
    const s = sv(0, 0, 9e6, -circularSpeed(mu, 9e6), 0, 0);
    const el = stateToElements(s, mu, 0);
    expect(el.i).toBe(Math.PI);
    expect(el.e).toBeLessThan(1e-12);
    expect(stateError(s, elementsToState(el, mu, 0), mu)).toBeLessThan(1e-12);
  });

  it('handles polar orbits', () => {
    const s = sv(8e6, 0, 0, 0, 7000, 0);
    const el = stateToElements(s, mu, 0);
    expectNear(el.i, Math.PI / 2, 1e-15);
    expectNear(el.lan, 0, 1e-15);
    expect(stateError(s, elementsToState(el, mu, 0), mu)).toBeLessThan(1e-12);
  });

  it('handles near-parabolic and exactly parabolic states without NaN', () => {
    const rng = makeRng('parabolic');
    let worst = 0;
    for (let k = 0; k < 4000; k++) {
      const r = 7e6 * Math.exp(rng.range(0, 3));
      const u = randomUnit(rng);
      // Keep the flight-path angle away from radial: this test is about energy, not shape.
      const t = norm(cross(u, randomUnit(rng)));
      const mix = rng.range(-0.9, 0.9);
      const dir = norm(add(scale(t, Math.sqrt(1 - mix * mix)), scale(u, mix)));
      const delta = k % 5 === 0 ? 0 : rng.range(-1, 1) * Math.pow(10, -rng.range(2, 16));
      const s: StateVector = { r: scale(u, r), v: scale(dir, escapeSpeed(mu, r) * (1 + delta)) };
      const el = stateToElements(s, mu, 7);
      expect(finiteElements(el)).toBe(true);
      expect(el.e).not.toBe(1);
      const back = elementsToState(el, mu, 7);
      expect(finiteState(back)).toBe(true);
      worst = Math.max(worst, stateError(s, back, mu));
      // The periapsis radius survives exactly even where the energy is ill conditioned.
      const h = len(cross(s.r, s.v));
      const eTrue = len(eccVector(s, mu));
      expectRel(el.a * (1 - el.e), (h * h) / mu / (1 + eTrue), 1e-9);
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it('handles rectilinear (radial) trajectories and a body at rest', () => {
    const rng = makeRng('radial');
    for (let k = 0; k < 300; k++) {
      const r = 7e6 * Math.exp(rng.range(0, 3));
      const u = randomUnit(rng);
      const speed = k % 7 === 0 ? 0 : k % 7 === 1 ? escapeSpeed(mu, r) : escapeSpeed(mu, r) * rng.range(0.05, 2.5);
      const s: StateVector = { r: scale(u, r), v: scale(u, k % 2 === 0 ? speed : -speed) };
      const el = stateToElements(s, mu, 0);
      expect(finiteElements(el)).toBe(true);
      const back = elementsToState(el, mu, 0);
      expect(finiteState(back)).toBe(true);
      expect(stateError(s, back, mu)).toBeLessThan(1e-9);
    }
  });

  it('stays finite and close for needle-thin, almost radial states', () => {
    const rng = makeRng('needle');
    let worst = 0;
    for (let k = 0; k < 20000; k++) {
      const r = 7e6 * Math.exp(rng.range(-1, 4));
      const u = randomUnit(rng);
      const dir = norm(addScaled(scale(u, k % 2 === 0 ? 1 : -1), randomUnit(rng), Math.pow(10, -rng.range(0.5, 14))));
      const vEsc = escapeSpeed(mu, r);
      const speed = k % 3 === 0 ? vEsc * rng.range(0.05, 3) : k % 3 === 1 ? vEsc * (1 + rng.range(-1, 1) * Math.pow(10, -rng.range(1, 16))) : vEsc * Math.pow(10, -rng.range(0, 6));
      const s: StateVector = { r: scale(u, r), v: scale(dir, speed) };
      const el = stateToElements(s, mu, 0);
      const back = elementsToState(el, mu, 0);
      expect(finiteElements(el) && finiteState(back)).toBe(true);
      worst = Math.max(worst, stateError(s, back, mu));
    }
    // (a, e) cannot hold 1 - e below ~1e-16; see the stateToElementsTo doc comment.
    expect(worst).toBeLessThan(1e-4);
  });
});

// ------------------------------------------------------------------------------------ propagation

describe('Kepler propagation (universal variables)', () => {
  const mu = MU_EARTH;

  it('matches a brute-force RK4 integration on an ellipse, forward and backward', () => {
    const el: OrbitElements = { a: 1.2e7, e: 0.4, i: 0.6, lan: 1.1, argp: 2.3, m0: 0.4, epoch: 0 };
    const s0 = elementsToState(el, mu, 0);
    const T = orbitalPeriod(mu, el.a);
    const dt = 1.37 * T;
    const ref = rk4Propagate(s0, mu, dt, 40000);
    expect(stateError(ref, propagateState(s0, mu, dt), mu)).toBeLessThan(1e-9);
    const refBack = rk4Propagate(s0, mu, -0.61 * T, 20000);
    expect(stateError(refBack, propagateState(s0, mu, -0.61 * T), mu)).toBeLessThan(1e-9);
  });

  it('matches RK4 through a hyperbolic flyby and on a near-parabolic arc', () => {
    // Hyperbola, e = 1.8, starting inbound.
    const hyp: OrbitElements = { a: -9e6, e: 1.8, i: 2.4, lan: 0.3, argp: 5.1, m0: -2.5, epoch: 0 };
    const s0 = elementsToState(hyp, mu, 0);
    expect(dot(s0.r, s0.v)).toBeLessThan(0);
    const dt = 5 / meanMotion(mu, hyp.a);
    const ref = rk4Propagate(s0, mu, dt, 60000);
    expect(dot(ref.r, ref.v)).toBeGreaterThan(0);
    expect(stateError(ref, propagateState(s0, mu, dt), mu)).toBeLessThan(1e-9);
    // Escape speed + 1e-7 (hyperbolic by a hair), 30° off tangential, followed for a long arc.
    const r0 = 7.2e6;
    const speed = escapeSpeed(mu, r0) * (1 + 1e-7);
    const s1 = sv(r0, 0, 0, speed * 0.5, 0, -speed * Math.sqrt(0.75));
    const ref1 = rk4Propagate(s1, mu, 40000, 80000);
    expect(stateError(ref1, propagateState(s1, mu, 40000), mu)).toBeLessThan(1e-9);
    // Exactly parabolic, in two hops.
    const s2 = sv(0, r0, 0, 0, 0, escapeSpeed(mu, r0));
    const ref2 = rk4Propagate(s2, mu, 20000, 40000);
    expect(stateError(ref2, propagateState(propagateState(s2, mu, 12345), mu, 20000 - 12345), mu)).toBeLessThan(1e-9);
  });

  it('matches RK4 on a radial drop and the closed-form free-fall time', () => {
    const r0 = 4e7;
    const rest = sv(0, 0, r0, 0, 0, 0);
    // Time to fall from rest at r0 to radius x·r0:  t = √(r0³/2mu)·(acos√x + √(x(1-x))).
    const x = 0.3;
    const tFall = Math.sqrt((r0 * r0 * r0) / (2 * mu)) * (Math.acos(Math.sqrt(x)) + Math.sqrt(x * (1 - x)));
    const s = propagateState(rest, mu, tFall);
    expectRel(s.r.z, x * r0, 1e-11);
    expectNear(s.r.x, 0, 1e-6);
    expectRel(s.v.z, -Math.sqrt(2 * mu * (1 / (x * r0) - 1 / r0)), 1e-11);
    expect(stateError(rk4Propagate(rest, mu, tFall, 20000), s, mu)).toBeLessThan(1e-9);
    // Through and beyond the singularity: never NaN.
    for (const f of [0.9, 0.999999, 1, 1.000001, 1.5, 2, 7.3]) {
      const tCentre = (Math.PI / 2) * Math.sqrt((r0 * r0 * r0) / (2 * mu));
      expect(finiteState(propagateState(rest, mu, f * tCentre))).toBe(true);
    }
  });

  it('agrees with the element route for random orbits and times', () => {
    const rng = makeRng('propagate-vs-elements');
    let worst = 0;
    for (let k = 0; k < 20000; k++) {
      const el = k % 2 === 0 ? randomEllipse(rng, 7e6, 0.97) : randomHyperbola(rng, 7e6);
      const n = meanMotion(mu, el.a);
      const dt = (rng.range(-1, 1) * (el.a > 0 ? 12 : 4)) / n;
      const s0 = elementsToState(el, mu, el.epoch);
      const a = propagateState(s0, mu, dt);
      const b = elementsToState(el, mu, el.epoch + dt);
      worst = Math.max(worst, stateError(b, a, mu));
    }
    expect(worst).toBeLessThan(1e-10);
  });

  it('is a group: p(dt1 + dt2) = p(dt2)∘p(dt1), p(-dt) undoes p(dt), whole periods are the identity', () => {
    const rng = makeRng('propagate-group');
    let worst = 0;
    let worstInv = 0;
    let worstPeriod = 0;
    for (let k = 0; k < 5000; k++) {
      const el = k % 2 === 0 ? randomEllipse(rng, 7e6, 0.95) : randomHyperbola(rng, 7e6);
      const s0 = elementsToState(el, mu, el.epoch);
      const scaleT = 1 / meanMotion(mu, el.a);
      const dt1 = rng.range(-3, 3) * scaleT;
      const dt2 = rng.range(-3, 3) * scaleT;
      const once = propagateState(s0, mu, dt1 + dt2);
      const twice = propagateState(propagateState(s0, mu, dt1), mu, dt2);
      worst = Math.max(worst, stateError(once, twice, mu));
      worstInv = Math.max(worstInv, stateError(s0, propagateState(propagateState(s0, mu, dt1), mu, -dt1), mu));
      if (el.a > 0) {
        const T = orbitalPeriod(mu, el.a);
        worstPeriod = Math.max(worstPeriod, stateError(s0, propagateState(s0, mu, rng.int(-50, 50) * T), mu));
      }
    }
    expect(worst).toBeLessThan(1e-10);
    expect(worstInv).toBeLessThan(1e-10);
    expect(worstPeriod).toBeLessThan(1e-10);
  });

  it('conserves energy, angular momentum and the eccentricity vector', () => {
    const rng = makeRng('conservation');
    let worstE = 0;
    let worstH = 0;
    let worstEcc = 0;
    for (let k = 0; k < 10000; k++) {
      const el = k % 3 === 0 ? randomHyperbola(rng, 7e6) : randomEllipse(rng, 7e6, 0.97);
      const s0 = elementsToState(el, mu, el.epoch);
      const dt = (rng.range(-1, 1) * (el.a > 0 ? 500 : 6)) / meanMotion(mu, el.a);
      const s1 = propagateState(s0, mu, dt);
      expect(finiteState(s1)).toBe(true);
      const scaleE = mu / len(s0.r) + mu / len(s1.r);
      worstE = Math.max(worstE, Math.abs(specificEnergy(s1, mu) - specificEnergy(s0, mu)) / scaleE);
      const h0 = cross(s0.r, s0.v);
      worstH = Math.max(worstH, len(sub(cross(s1.r, s1.v), h0)) / len(h0));
      worstEcc = Math.max(worstEcc, len(sub(eccVector(s1, mu), eccVector(s0, mu))));
    }
    expect(worstE).toBeLessThan(1e-12);
    expect(worstH).toBeLessThan(1e-12);
    expect(worstEcc).toBeLessThan(1e-11);
  });

  it('handles dt = 0, non-finite dt, tiny and enormous dt, and writing in place', () => {
    const s0 = sv(7e6, 1e6, -2e6, 1200, 3000, -6800);
    expect(propagateState(s0, mu, 0)).toEqual(s0);
    expect(propagateState(s0, mu, NaN)).toEqual(s0);
    expect(propagateState(s0, mu, Infinity)).toEqual(s0);
    // Tiny step: r moves by v·dt.
    const tiny = propagateState(s0, mu, 1e-6);
    expectNear(tiny.r.x - s0.r.x, s0.v.x * 1e-6, 1e-8);
    expectNear(tiny.r.z - s0.r.z, s0.v.z * 1e-6, 1e-8);
    // A million periods later the phase is still right to a few metres.
    const T = orbitInfo(s0, mu).period;
    expect(stateError(s0, propagateState(s0, mu, 1e6 * T), mu)).toBeLessThan(1e-7);
    // Hyperbola, absurdly far in the future / past.
    const hyp = sv(7e6, 0, 0, 0, 2000, -14000);
    for (const dt of [1e9, -1e9, 1e12]) {
      const far = propagateState(hyp, mu, dt);
      expect(finiteState(far)).toBe(true);
      expectRel(specificEnergy(far, mu), specificEnergy(hyp, mu), 1e-9);
    }
    // In place (out === input).
    const inPlace = sv(7e6, 1e6, -2e6, 1200, 3000, -6800);
    const ret = propagateStateTo(inPlace, inPlace, mu, 777);
    expect(ret).toBe(inPlace);
    expect(inPlace).toEqual(propagateState(s0, mu, 777));
    // No gravity: straight line.
    expect(propagateState(sv(1, 2, 3, 4, 5, 6), 0, 2)).toEqual(sv(9, 12, 15, 4, 5, 6));
  });
});

// ------------------------------------------------------------------------------------ orbitInfo & frame

describe('orbitInfo and orbitalFrame', () => {
  const mu = MU_EARTH;

  it('describes an elliptic orbit', () => {
    const el: OrbitElements = { a: 1.5e7, e: 0.35, i: 0.5, lan: 2, argp: 1, m0: 1.3, epoch: 100 };
    const s = elementsToState(el, mu, 100);
    const info = orbitInfo(s, mu, 100);
    expect(info.closed).toBe(true);
    expectRel(info.a, el.a, 1e-12);
    expectNear(info.e, el.e, 1e-12);
    expectNear(info.i, el.i, 1e-12);
    expectRel(info.elements.a, el.a, 1e-12);
    expect(info.elements.epoch).toBe(100);
    expectRel(info.period, TAU * Math.sqrt(el.a ** 3 / mu), 1e-12);
    expectRel(info.periapsis, el.a * (1 - el.e), 1e-12);
    expectRel(info.apoapsis, el.a * (1 + el.e), 1e-12);
    expectRel(info.energy, -mu / (2 * el.a), 1e-12);
    expectRel(info.semiLatusRectum, el.a * (1 - el.e ** 2), 1e-12);
    expectRel(info.radius, len(s.r), 1e-15);
    expectRel(info.speed, len(s.v), 1e-15);
    expectNear(info.radialSpeed, dot(s.r, s.v) / len(s.r), 1e-9);
    // h along the orbit normal with |h| = √(mu·p); eVec toward periapsis with |eVec| = e.
    expectRel(len(info.h), Math.sqrt(mu * el.a * (1 - el.e ** 2)), 1e-12);
    expect(len(sub(norm(info.h), orbitNormalFromElements(el)))).toBeLessThan(1e-12);
    const periapsisDir = norm(elementsToState({ ...el, m0: 0 }, mu, 100).r);
    expectNear(len(info.eVec), el.e, 1e-12);
    expect(len(sub(norm(info.eVec), periapsisDir))).toBeLessThan(1e-12);
    // True anomaly from the geometry.
    const nu = Math.atan2(dot(cross(periapsisDir, s.r), norm(info.h)), dot(periapsisDir, s.r));
    expectNear(info.trueAnomaly, nu, 1e-12);
    // Mean anomaly 1.3 rad: periapsis is (2π - 1.3)/n ahead, apoapsis (π - 1.3)/n ahead.
    const n = meanMotion(mu, el.a);
    expectRel(info.timeToPeriapsis, (TAU - 1.3) / n, 1e-11);
    expectRel(info.timeToApoapsis, (Math.PI - 1.3) / n, 1e-11);
    const atPe = propagateState(s, mu, info.timeToPeriapsis);
    expectRel(len(atPe.r), info.periapsis, 1e-11);
    const atAp = propagateState(s, mu, info.timeToApoapsis);
    expectRel(len(atAp.r), info.apoapsis, 1e-11);
  });

  it('keeps apsis times in [0, period) all around the orbit', () => {
    const el: OrbitElements = { a: 9e6, e: 0.2, i: 1, lan: 0.2, argp: 4, m0: 0, epoch: 0 };
    const T = orbitalPeriod(mu, el.a);
    for (let k = 0; k < 40; k++) {
      const t = (k / 40) * T + 1;
      const info = orbitInfo(elementsToState(el, mu, t), mu, t);
      expect(info.timeToPeriapsis).toBeGreaterThanOrEqual(0);
      expect(info.timeToPeriapsis).toBeLessThan(T);
      expect(info.timeToApoapsis).toBeGreaterThanOrEqual(0);
      expect(info.timeToApoapsis).toBeLessThan(T);
      expectNear(info.timeToPeriapsis, T - t, 1e-6);
      expectNear(info.timeToApoapsis, (((T / 2 - t) % T) + T) % T, 1e-6);
    }
  });

  it('describes a hyperbolic orbit', () => {
    const el: OrbitElements = { a: -2e7, e: 1.6, i: 0.3, lan: 1, argp: 2, m0: -1.2, epoch: 0 };
    const inbound = elementsToState(el, mu, 0);
    const info = orbitInfo(inbound, mu, 0);
    expect(info.closed).toBe(false);
    expect(info.period).toBe(Infinity);
    expect(info.apoapsis).toBe(Infinity);
    expect(info.timeToApoapsis).toBe(Infinity);
    expectRel(info.a, el.a, 1e-12);
    expectNear(info.e, el.e, 1e-12);
    expectRel(info.periapsis, 2e7 * 0.6, 1e-12);
    expectRel(info.energy, mu / 4e7, 1e-12);
    expect(info.trueAnomaly).toBeLessThan(0);
    expectRel(info.timeToPeriapsis, 1.2 / meanMotion(mu, el.a), 1e-11);
    expectRel(len(propagateState(inbound, mu, info.timeToPeriapsis).r), info.periapsis, 1e-11);
    const outbound = orbitInfo(elementsToState(el, mu, 8000), mu, 8000);
    expect(outbound.trueAnomaly).toBeGreaterThan(0);
    expectRel(outbound.timeToPeriapsis, 1.2 / meanMotion(mu, el.a) - 8000, 1e-10);
    expect(outbound.timeToPeriapsis).toBeLessThan(0);
  });

  it('builds a right-handed prograde / normal / radial frame', () => {
    const f = orbitalFrame(sv(7e6, 0, 0, 0, 0, -7500));
    expect(len(sub(f.prograde, { x: 0, y: 0, z: -1 }))).toBe(0);
    expect(len(sub(f.normal, { x: 0, y: 1, z: 0 }))).toBe(0);
    expect(len(sub(f.radial, { x: 1, y: 0, z: 0 }))).toBe(0);
    const rng = makeRng('frame');
    for (let k = 0; k < 500; k++) {
      const s: StateVector = { r: scale(randomUnit(rng), 1e7), v: scale(randomUnit(rng), 5000) };
      const fr = orbitalFrame(s);
      expect(len(sub(fr.prograde, norm(s.v)))).toBeLessThan(1e-14);
      expect(len(sub(fr.normal, norm(cross(s.r, s.v))))).toBeLessThan(1e-12);
      expect(len(sub(fr.radial, cross(fr.prograde, fr.normal)))).toBeLessThan(1e-14);
      expectNear(dot(fr.prograde, fr.normal), 0, 1e-14);
      expectNear(len(fr.radial), 1, 1e-14);
    }
    // Circular orbit: radial is exactly "away from the body".
    const circ = orbitalFrame(sv(0, 0, 8e6, -7000, 0, 0));
    expect(len(sub(circ.radial, { x: 0, y: 0, z: 1 }))).toBeLessThan(1e-15);
    // Degenerate inputs still give an orthonormal triad.
    for (const s of [sv(7e6, 0, 0, 0, 0, 0), sv(7e6, 0, 0, 3000, 0, 0), sv(0, 7e6, 0, 0, -3000, 0), sv(0, 7e6, 0, 0, 0, 0)]) {
      const fr = orbitalFrame(s);
      for (const axis of [fr.prograde, fr.normal, fr.radial]) expectNear(len(axis), 1, 1e-12);
      expectNear(dot(fr.prograde, fr.normal), 0, 1e-12);
      expect(len(sub(fr.radial, cross(fr.prograde, fr.normal)))).toBeLessThan(1e-12);
    }
  });
});

// ------------------------------------------------------------------------------------ event timing

describe('event timing on a conic', () => {
  const mu = MU_EARTH;

  it('finds the next outward / inward crossing of a radius on ellipses', () => {
    const rng = makeRng('radius-crossing');
    for (let k = 0; k < 1500; k++) {
      const el = randomEllipse(rng, 7e6, 0.9);
      const s = elementsToState(el, mu, el.epoch);
      const rp = el.a * (1 - el.e);
      const ra = el.a * (1 + el.e);
      const R = rp + (ra - rp) * rng.range(0.02, 0.98);
      const T = orbitalPeriod(mu, el.a);
      for (const dir of ['outward', 'inward'] as const) {
        const dt = timeToRadius(s, mu, R, dir);
        expect(dt).toBeGreaterThanOrEqual(0);
        expect(dt).toBeLessThan(T);
        const at = propagateState(s, mu, dt);
        expect(Math.abs(len(at.r) - R) / R).toBeLessThan(1e-9);
        const vr = dot(at.r, at.v);
        expect(dir === 'outward' ? vr > 0 : vr < 0).toBe(true);
        // It is the *first* such crossing: no earlier sample is on the far side heading the same way.
        const side = (x: StateVector): boolean => (dir === 'outward' ? len(x.r) > R : len(x.r) < R);
        const startSide = side(s);
        let flipped = false;
        for (let j = 1; j < 40; j++) {
          const here = side(propagateState(s, mu, (dt * j) / 40));
          if (!startSide && here) flipped = true;
        }
        expect(flipped).toBe(false);
      }
      expect(timeToRadius(s, mu, rp * 0.99, 'inward')).toBe(Infinity);
      expect(timeToRadius(s, mu, ra * 1.01, 'outward')).toBe(Infinity);
    }
  });

  it('times SOI exit, re-entry and impact on hyperbolas', () => {
    const el: OrbitElements = { a: -1.5e7, e: 1.5, i: 1.2, lan: 3, argp: 0.4, m0: -4, epoch: 0 };
    const rp = 7.5e6;
    const inbound = elementsToState(el, mu, 0);
    const r0 = len(inbound.r);
    // Inbound: comes down through 2·rp, turns, climbs back out through it and on to 20·rp.
    const tIn = timeToRadius(inbound, mu, 2 * rp, 'inward');
    const tOut = timeToRadius(inbound, mu, 2 * rp, 'outward');
    const tFar = timeToRadius(inbound, mu, 20 * rp, 'outward');
    const tPe = orbitInfo(inbound, mu).timeToPeriapsis;
    expect(tIn).toBeGreaterThan(0);
    expect(tIn).toBeLessThan(tPe);
    expectNear(tOut - tPe, tPe - tIn, 1e-6); // symmetric about periapsis
    expect(tFar).toBeGreaterThan(tOut);
    expectRel(len(propagateState(inbound, mu, tIn).r), 2 * rp, 1e-10);
    expectRel(len(propagateState(inbound, mu, tFar).r), 20 * rp, 1e-10);
    // It never reaches below periapsis, and never comes back in once outbound.
    expect(timeToRadius(inbound, mu, 0.9 * rp, 'inward')).toBe(Infinity);
    const outbound = propagateState(inbound, mu, tOut + 100);
    expect(timeToRadius(outbound, mu, 2 * rp, 'inward')).toBe(Infinity);
    expect(timeToRadius(outbound, mu, 2 * rp, 'outward')).toBe(Infinity);
    expect(timeToRadius(outbound, mu, r0, 'outward')).toBeGreaterThan(0);
    // Already exactly on the sphere, heading out: now.
    const onSphere = propagateState(inbound, mu, tFar);
    expect(timeToRadius(onSphere, mu, len(onSphere.r), 'outward')).toBeLessThan(1e-3);
  });

  it("agrees with Barker's equation on a parabola", () => {
    const rp = 8e6;
    const s = sv(rp, 0, 0, 0, 0, -escapeSpeed(mu, rp));
    for (const D of [0.2, 1, 3, 12]) {
      // r = rp(1 + D²),  t = √(2rp³/mu)·(D + D³/3),  D = tan(ν/2)
      const R = rp * (1 + D * D);
      const t = Math.sqrt((2 * rp ** 3) / mu) * (D + (D * D * D) / 3);
      expectRel(timeToRadius(s, mu, R, 'outward'), t, 1e-7);
      expectRel(timeToTrueAnomaly(s, mu, 2 * Math.atan(D)), t, 1e-7);
      expectRel(len(propagateState(s, mu, t).r), R, 1e-9);
    }
    expect(timeToRadius(s, mu, 2 * rp, 'inward')).toBe(Infinity);
  });

  it('times arrival at a true anomaly', () => {
    const rng = makeRng('true-anomaly');
    for (let k = 0; k < 500; k++) {
      const el = randomEllipse(rng, 7e6, 0.9);
      const s = elementsToState(el, mu, el.epoch);
      const target = rng.range(-Math.PI, Math.PI);
      const dt = timeToTrueAnomaly(s, mu, target);
      expect(dt).toBeGreaterThanOrEqual(0);
      expect(dt).toBeLessThan(orbitalPeriod(mu, el.a));
      const nu = orbitInfo(propagateState(s, mu, dt), mu).trueAnomaly;
      expect(Math.abs(wrapPi(nu - target))).toBeLessThan(1e-8);
    }
    // Hyperbola: asymptote at acos(-1/e).
    const hyp: OrbitElements = { a: -1e7, e: 2, i: 0.4, lan: 0, argp: 0, m0: -1, epoch: 0 };
    const s = elementsToState(hyp, mu, 0);
    const dt = timeToTrueAnomaly(s, mu, 1.5);
    expectNear(orbitInfo(propagateState(s, mu, dt), mu).trueAnomaly, 1.5, 1e-9);
    expect(timeToTrueAnomaly(s, mu, Math.acos(-1 / 2) + 0.01)).toBe(Infinity); // beyond the asymptote
    expect(timeToTrueAnomaly(s, mu, -2)).toBe(Infinity); // already behind
  });

  it('times the ascending and descending nodes against the reference plane and another orbit', () => {
    const rng = makeRng('nodes');
    for (let k = 0; k < 400; k++) {
      const elA = randomEllipse(rng, 7e6, 0.8);
      const elB = randomEllipse(rng, 7e6, 0.8);
      const a = elementsToState(elA, mu, 0);
      const b = elementsToState(elB, mu, 0);
      const T = orbitalPeriod(mu, elA.a);
      const refs: V3[] = [{ x: 0, y: 1, z: 0 }, orbitNormal(b)];
      for (const ref of refs) {
        const tAsc = timeToNode(a, mu, ref, 'ascending');
        const tDesc = timeToNode(a, mu, ref, 'descending');
        for (const [dt, sign] of [[tAsc, 1], [tDesc, -1]] as const) {
          expect(dt).toBeGreaterThanOrEqual(0);
          expect(dt).toBeLessThan(T);
          const at = propagateState(a, mu, dt);
          expect(Math.abs(dot(at.r, ref)) / len(at.r)).toBeLessThan(1e-9);
          expect(Math.sign(dot(at.v, ref))).toBe(sign);
        }
        expect(tAsc).not.toBe(tDesc);
      }
      // Relative inclination is the angle between the normals.
      expectNear(relativeInclination(a, b), Math.acos(dot(orbitNormal(a), orbitNormal(b))), 1e-7);
      expectNear(relativeInclination(a, { r: a.r, v: a.v }), 0, 1e-12);
    }
    // Known geometry: 10° apart about a shared node line.
    const e1: OrbitElements = { a: 1e7, e: 0.1, i: 20 * DEG, lan: 1, argp: 0.5, m0: 0.3, epoch: 0 };
    const e2: OrbitElements = { a: 1.4e7, e: 0.3, i: 30 * DEG, lan: 1, argp: 2.5, m0: 4, epoch: 0 };
    const s1 = elementsToState(e1, mu, 0);
    const s2 = elementsToState(e2, mu, 0);
    expectNear(relativeInclination(s1, s2), 10 * DEG, 1e-12);
    expectNear(relativeInclination(sv(7e6, 0, 0, 0, 0, -7000), sv(7e6, 0, 0, 0, 0, 7000)), Math.PI, 1e-15);
    // Equatorial orbit vs the reference plane: no node.
    expect(timeToNode(sv(7e6, 0, 0, 0, 0, -7000), mu, { x: 0, y: 1, z: 0 }, 'ascending')).toBe(Infinity);
    // Ascending node of e1 is where its argument of latitude is 0: true anomaly -argp.
    expectRel(timeToNode(s1, mu, { x: 0, y: 1, z: 0 }, 'ascending'), timeToTrueAnomaly(s1, mu, -e1.argp), 1e-9);
  });
});

// ------------------------------------------------------------------------------------ closest approach

describe('closestApproach', () => {
  const mu = MU_EARTH;

  it('finds a designed crossing encounter exactly', () => {
    const elA: OrbitElements = { a: 1.1e7, e: 0.2, i: 0.3, lan: 0.5, argp: 1, m0: 0.2, epoch: 0 };
    const tStart = 5000;
    const tMeet = tStart + 4321.5;
    const aAtMeet = elementsToState(elA, mu, tMeet);
    // B crosses A's path at tMeet with a different velocity, offset 2,500 m perpendicular to the relative velocity.
    const vB = add(scale(aAtMeet.v, 0.8), scale(norm(cross(aAtMeet.r, aAtMeet.v)), 2500));
    const dv = sub(vB, aAtMeet.v);
    const offset = scale(norm(cross(dv, aAtMeet.r)), 2500);
    const bAtMeet: StateVector = { r: add(aAtMeet.r, offset), v: vB };
    const a0 = elementsToState(elA, mu, tStart);
    const b0 = propagateState(bAtMeet, mu, tStart - tMeet);
    const ca = closestApproach(a0, b0, mu, tStart, tStart + 9000);
    expectNear(ca.t, tMeet, 1e-3);
    expectNear(ca.distance, 2500, 1e-3);
    expectNear(ca.relSpeed, len(dv), 1e-6);
    // Same answer when the states are given at another epoch.
    const ca2 = closestApproach(propagateState(a0, mu, -700), propagateState(b0, mu, -700), mu, tStart, tStart + 9000, { epoch: tStart - 700 });
    expectNear(ca2.t, tMeet, 1e-3);
    expectNear(ca2.distance, 2500, 1e-3);
  });

  it('never misses a fast, narrow flyby (counter-rotating orbits 50 m apart)', () => {
    const r = 7.0e6;
    const a = sv(r, 0, 0, 0, 0, -circularSpeed(mu, r));
    const b = sv(0, 0, r + 50, -circularSpeed(mu, r + 50), 0, 0); // retrograde, a quarter turn away
    const T = orbitalPeriod(mu, r);
    const all = closestApproaches(a, b, mu, 0, 3 * T);
    // Head-on passes every half period: six of them in three periods.
    const passes = all.filter((p) => p.distance < 1000);
    expect(passes.length).toBe(6);
    for (const p of passes) {
      expectNear(p.distance, 50, 0.05);
      expectNear(p.relSpeed, 2 * circularSpeed(mu, r), 0.1);
    }
    for (let k = 1; k < all.length; k++) expect(all[k].t).toBeGreaterThan(all[k - 1].t);
    const best = closestApproach(a, b, mu, 0, 3 * T);
    expectNear(best.distance, 50, 0.05);
  });

  it('is never beaten by a brute-force scan', () => {
    const rng = makeRng('closest-approach');
    for (let k = 0; k < 25; k++) {
      const elA = randomEllipse(rng, 7e6, 0.6);
      const elB = k % 5 === 0 ? randomHyperbola(rng, 7e6) : randomEllipse(rng, 7e6, 0.6);
      const a = elementsToState(elA, mu, 0);
      const b = elementsToState(elB, mu, 0);
      const span = rng.range(0.3, 4) * orbitalPeriod(mu, elA.a);
      const ca = closestApproach(a, b, mu, 0, span);
      expect(ca.t).toBeGreaterThanOrEqual(0);
      expect(ca.t).toBeLessThanOrEqual(span);
      // What it reports is true…
      const pa = propagateState(a, mu, ca.t);
      const pb = propagateState(b, mu, ca.t);
      expectRel(ca.distance, len(sub(pa.r, pb.r)), 1e-9);
      expectRel(ca.relSpeed, len(sub(pa.v, pb.v)), 1e-9);
      // …and no sampled time is closer.
      let brute = Infinity;
      for (let j = 0; j <= 3000; j++) {
        const t = (span * j) / 3000;
        brute = Math.min(brute, len(sub(propagateState(a, mu, t).r, propagateState(b, mu, t).r)));
      }
      expect(ca.distance).toBeLessThanOrEqual(brute * (1 + 1e-9));
    }
  });

  it('reports the window ends when the objects only separate or only close', () => {
    const a = sv(7e6, 0, 0, 0, 0, -7500);
    const b = sv(7.5e6, 0, 0, 0, 0, -7000); // ahead in radius, slower: separating from the start
    const sep = closestApproach(a, b, mu, 100, 400, { epoch: 100 });
    expect(sep.t).toBe(100);
    expectNear(sep.distance, 5e5, 1e-6);
    const closing = closestApproach(propagateState(a, mu, -300), propagateState(b, mu, -300), mu, 0, 250, { epoch: 0 });
    expect(closing.t).toBe(250);
    const single = closestApproaches(a, b, mu, 50, 50);
    expect(single.length).toBe(1);
    expect(single[0].t).toBe(50);
  });
});

// ------------------------------------------------------------------------------------ SystemModel

describe('test fixture system', () => {
  const def = makeTestSystem();
  const byId = new Map(def.bodies.map((b) => [b.id, b]));

  it('is physically consistent', () => {
    expect(def.bodies[0].kind).toBe('star');
    expect(def.bodies[0].parentId).toBeNull();
    expect(def.bodies[0].soi).toBe(Infinity);
    expectRel(def.bodies[0].mass, 0.12 * SOLAR_MASS, 1e-12);
    def.bodies.forEach((b, idx) => {
      expectRel(b.mu, G * b.mass, 1e-14);
      if (idx === 0) return;
      const parent = byId.get(b.parentId as string);
      expect(parent).toBeDefined();
      expect(def.bodies.indexOf(parent!)).toBeLessThan(idx);
      const o = b.orbit!;
      expectRel(b.soi, o.a * Math.pow(b.mass / parent!.mass, 0.4), 1e-12);
      // Whole SOI stays well inside the parent's SOI and clear of the parent itself.
      expect(o.a * (1 + o.e) + b.soi).toBeLessThan(0.5 * parent!.soi);
      expect(o.a * (1 - o.e) - b.soi).toBeGreaterThan(parent!.radius * 1.2);
      expect(b.soi).toBeGreaterThan(2 * b.radius);
      if (b.tidallyLocked) expectRel(b.rotationPeriod, orbitalPeriod(parent!.mu, o.a), 1e-12);
    });
    for (const o of [...def.stations, ...def.miningSites]) {
      const parent = byId.get(o.parentBodyId)!;
      const rp = o.orbit.a * (1 - o.orbit.e);
      expect(rp).toBeGreaterThan(parent.radius + (parent.atmosphere ? parent.atmosphere.height : 0));
      expect(o.orbit.a * (1 + o.orbit.e)).toBeLessThan(0.5 * parent.soi);
      expect(o.systemId).toBe(def.id);
    }
    const beaconBody = byId.get(def.jumpBeacon.bodyId)!;
    expect(def.jumpBeacon.orbitRadius).toBeGreaterThan(8 * beaconBody.radius);
    expect(def.jumpBeacon.orbitRadius).toBeLessThan(0.5 * beaconBody.soi);
    // Compact red-dwarf distances: every planet within 0.15 AU, periods of days.
    for (const b of def.bodies.filter((x) => x.kind === 'planet')) {
      expect(b.orbit!.a).toBeLessThan(0.15 * AU);
      expect(orbitalPeriod(def.bodies[0].mu, b.orbit!.a)).toBeLessThan(60 * DAY);
    }
    // The second orbiter of the rocky planet: other altitude, ~10° inclination.
    const low = def.stations.find((s) => s.id === ID.stationLow)!;
    const second = def.stations.find((s) => s.id === ID.orbiter2)!;
    expect(second.parentBodyId).toBe(ID.rocky);
    expect(low.parentBodyId).toBe(ID.rocky);
    expectNear(second.orbit.i, 10 * DEG, 1e-12);
    expect(second.orbit.a).toBeGreaterThan(low.orbit.a * 1.2);
    expect(def.stations.find((s) => s.id === ID.stationMoon)!.parentBodyId).toBe(ID.giantMoonLarge);
    expect(byId.get(ID.giant)!.rings).not.toBeNull();
    expect(byId.get(ID.rocky)!.atmosphere).not.toBeNull();
  });

  it('is reproduced by deriveSystem and is independent per call', () => {
    const derived = deriveSystem(def);
    derived.bodies.forEach((b, idx) => {
      expectRel(b.mu, def.bodies[idx].mu, 1e-14);
      if (idx > 0) {
        expectRel(b.soi, def.bodies[idx].soi, 1e-12);
        expectRel(b.rotationPeriod, def.bodies[idx].rotationPeriod, 1e-12);
      } else expect(b.soi).toBe(Infinity);
    });
    const other = makeTestSystem();
    expect(other).toEqual(def);
    expect(other.bodies[1]).not.toBe(def.bodies[1]);
  });
});

describe('SystemModel', () => {
  const def = makeTestSystem();
  const model = new SystemModel(def);
  const star = model.body(ID.star);
  const rocky = model.body(ID.rocky);
  const moon = model.body(ID.rockyMoon);
  const giant = model.body(ID.giant);

  it('looks bodies, parents, children, stations and sites up by id', () => {
    expect(model.primary).toBe(def.bodies[0]);
    expect(model.bodies.length).toBe(7);
    expect(model.body(ID.rocky).name).toBe('Tessaly');
    expect(model.parent(ID.star)).toBeNull();
    expect(model.parent(ID.rockyMoon)).toBe(rocky);
    expect(model.children(ID.star).map((b) => b.id)).toEqual([ID.inner, ID.rocky, ID.giant]);
    expect(model.children(ID.giant).map((b) => b.id)).toEqual([ID.giantMoonSmall, ID.giantMoonLarge]);
    expect(model.children(ID.rockyMoon)).toEqual([]);
    expect(model.depth(ID.star)).toBe(0);
    expect(model.depth(ID.giant)).toBe(1);
    expect(model.depth(ID.giantMoonLarge)).toBe(2);
    expect(model.hasBody(ID.inner)).toBe(true);
    expect(model.hasBody('nope')).toBe(false);
    expect(model.station(ID.stationLow).name).toBe('Tessaly Highport');
    expect(model.site(ID.site).kind).toBe('ring');
    expect(() => model.body('nope')).toThrow();
    expect(() => model.bodyState('nope', 0)).toThrow();
    expect(() => model.station('nope')).toThrow();
    expect(() => model.site(ID.stationLow)).toThrow();
  });

  it('rejects malformed systems', () => {
    const bad = makeTestSystem();
    bad.bodies.reverse();
    expect(() => new SystemModel(bad)).toThrow();
    const dup = makeTestSystem();
    dup.bodies[2] = { ...dup.bodies[2], id: dup.bodies[1].id };
    expect(() => new SystemModel(dup)).toThrow();
  });

  it('puts bodies on their Kepler rails relative to the parent', () => {
    for (const t of [0, 12345.678, 5e6, -3e5]) {
      expect(model.bodyState(ID.star, t)).toEqual(newState());
      for (const b of def.bodies.slice(1)) {
        const parent = model.parent(b.id)!;
        const s = model.bodyState(b.id, t);
        expect(s).toEqual(elementsToState(b.orbit!, parent.mu, t));
        const r = len(s.r);
        expect(r).toBeGreaterThanOrEqual(b.orbit!.a * (1 - b.orbit!.e) * (1 - 1e-12));
        expect(r).toBeLessThanOrEqual(b.orbit!.a * (1 + b.orbit!.e) * (1 + 1e-12));
        // One period later it is back.
        const T = orbitalPeriod(parent.mu, b.orbit!.a);
        expect(stateError(s, model.bodyState(b.id, t + T), parent.mu)).toBeLessThan(1e-9);
      }
    }
    // Prograde: counter-clockwise seen from +Y.
    expect(orbitNormal(model.bodyState(ID.rocky, 0)).y).toBeGreaterThan(0.99);
  });

  it('sums the parent chain for absolute states', () => {
    const t = 98765.4321;
    const planet = model.bodyState(ID.giant, t);
    const moonRel = model.bodyState(ID.giantMoonLarge, t);
    const abs = model.bodyAbsState(ID.giantMoonLarge, t);
    expect(len(sub(abs.r, add(planet.r, moonRel.r)))).toBeLessThan(1e-5);
    expect(len(sub(abs.v, add(planet.v, moonRel.v)))).toBeLessThan(1e-9);
    expect(model.bodyAbsState(ID.giant, t)).toEqual(planet);
    expect(model.bodyAbsState(ID.star, t)).toEqual(newState());
    expect(model.bodyAbsPosition(ID.giantMoonLarge, t)).toEqual(abs.r);
  });

  it('caches by time without ever returning stale data, and writes into `out`', () => {
    const fresh = (): SystemModel => new SystemModel(def);
    const a1 = model.bodyAbsState(ID.rockyMoon, 1000);
    const b1 = model.bodyAbsState(ID.rockyMoon, 2000);
    const a2 = model.bodyAbsState(ID.rockyMoon, 1000);
    expect(a2).toEqual(a1);
    expect(b1).not.toEqual(a1);
    expect(a1).toEqual(fresh().bodyAbsState(ID.rockyMoon, 1000));
    expect(b1).toEqual(fresh().bodyAbsState(ID.rockyMoon, 2000));
    // Asking for the child first, then the parent at another time, then the child again.
    model.bodyState(ID.rocky, 5);
    expect(model.bodyAbsState(ID.rockyMoon, 2000)).toEqual(b1);
    // Results are copies: mutating one does not poison the cache.
    a2.r.x = 1;
    expect(model.bodyAbsState(ID.rockyMoon, 1000)).toEqual(a1);
    const out = newState();
    expect(model.bodyAbsState(ID.rockyMoon, 1000, out)).toBe(out);
    expect(out).toEqual(a1);
    expect(model.bodyState(ID.rockyMoon, 1000, out)).toBe(out);
  });

  it('places stations, sites, arbitrary orbiters and the jump beacon', () => {
    const t = 4242;
    const st = model.station(ID.stationLow);
    const rel = model.stationState(ID.stationLow, t);
    expectRel(len(rel.r), rocky.radius + 4e5, 1e-12);
    expectRel(len(rel.v), circularSpeed(rocky.mu, rocky.radius + 4e5), 1e-12);
    expect(rel).toEqual(elementsToState(st.orbit, rocky.mu, t));
    expect(model.orbiterState(st.orbit, ID.rocky, t)).toEqual(rel);
    const abs = model.stationAbsState(ID.stationLow, t);
    const planetAbs = model.bodyAbsState(ID.rocky, t);
    expect(len(sub(sub(abs.r, planetAbs.r), rel.r))).toBeLessThan(1e-5);
    expect(len(sub(sub(abs.v, planetAbs.v), rel.v))).toBeLessThan(1e-9);
    expect(model.orbiterAbsState(st.orbit, ID.rocky, t)).toEqual(abs);
    // The inclined second orbiter really is inclined by 10°.
    expectNear(relativeInclination(model.stationState(ID.orbiter2, t), rel), 10 * DEG, 1e-9);
    // Station around the giant's larger moon: three frames deep.
    const deep = model.stationAbsState(ID.stationMoon, t);
    const moonAbs = model.bodyAbsState(ID.giantMoonLarge, t);
    expectRel(len(sub(deep.r, moonAbs.r)), len(model.stationState(ID.stationMoon, t).r), 1e-9);
    expect(len(sub(deep.r, moonAbs.r))).toBeLessThan(model.body(ID.giantMoonLarge).soi);
    // Mining site in the rings.
    const site = model.siteState(ID.site, t);
    expect(len(site.r)).toBeGreaterThan(giant.rings!.innerRadius);
    expect(len(site.r)).toBeLessThan(giant.rings!.outerRadius);
    expect(len(sub(model.siteAbsState(ID.site, t).r, add(model.bodyAbsState(ID.giant, t).r, site.r)))).toBeLessThan(1e-5);
    // Beacon: circular parking orbit of the given radius.
    const beacon = model.beaconState(t);
    expectRel(len(beacon.r), def.jumpBeacon.orbitRadius, 1e-12);
    expectRel(len(beacon.v), circularSpeed(giant.mu, def.jumpBeacon.orbitRadius), 1e-12);
    expect(len(sub(model.beaconAbsState(t).r, add(model.bodyAbsState(ID.giant, t).r, beacon.r)))).toBeLessThan(1e-5);
  });

  it('changes frames consistently', () => {
    const t = 777777;
    const local = sv(2e6, 1e5, -3e5, 100, -20, 900);
    const abs = model.toAbsolute(local, ID.rockyMoon, t);
    const moonAbs = model.bodyAbsState(ID.rockyMoon, t);
    expect(len(sub(abs.r, add(moonAbs.r, local.r)))).toBeLessThan(1e-5);
    expect(len(sub(abs.v, add(moonAbs.v, local.v)))).toBeLessThan(1e-9);
    expect(len(sub(model.fromAbsolute(abs, ID.rockyMoon, t).r, local.r))).toBeLessThan(1e-5);
    // Moon frame -> planet frame = add the moon's state relative to the planet.
    const inPlanet = model.changeFrame(local, ID.rockyMoon, ID.rocky, t);
    const moonRel = model.bodyState(ID.rockyMoon, t);
    expect(len(sub(inPlanet.r, add(moonRel.r, local.r)))).toBeLessThan(1e-5);
    expect(len(sub(inPlanet.v, add(moonRel.v, local.v)))).toBeLessThan(1e-9);
    // Across the system and back, in place.
    const there = model.changeFrame(local, ID.rockyMoon, ID.giantMoonSmall, t);
    const back = model.changeFrame(there, ID.giantMoonSmall, ID.rockyMoon, t, there);
    expect(back).toBe(there);
    expect(len(sub(back.r, local.r))).toBeLessThan(1e-4);
    expect(len(sub(back.v, local.v))).toBeLessThan(1e-9);
    expect(model.changeFrame(local, ID.rocky, ID.rocky, t)).toEqual(local);
    expect(model.toAbsolute(local, ID.star, t)).toEqual(local);
  });

  it('finds the governing sphere of influence', () => {
    const t = 31415.9;
    const planetAbs = model.bodyAbsState(ID.rocky, t).r;
    const moonAbs = model.bodyAbsState(ID.rockyMoon, t).r;
    const away = norm(sub(moonAbs, planetAbs));
    expect(model.soiBodyAt(add(planetAbs, { x: 1e7, y: 0, z: 0 }), t)).toBe(rocky);
    expect(model.soiBodyAt(model.stationAbsState(ID.stationLow, t).r, t)).toBe(rocky);
    expect(model.soiBodyAt(add(moonAbs, { x: 0, y: 2e6, z: 0 }), t)).toBe(moon);
    expect(model.soiBodyAt(addScaled(moonAbs, away, moon.soi * 0.999), t)).toBe(moon);
    expect(model.soiBodyAt(addScaled(moonAbs, away, moon.soi * 1.001), t)).toBe(rocky);
    expect(model.soiBodyAt(addScaled(planetAbs, away, rocky.soi * 0.999), t)).toBe(rocky);
    expect(model.soiBodyAt(addScaled(planetAbs, away, rocky.soi * 1.001), t)).toBe(star);
    expect(model.soiBodyAt({ x: 9e9, y: 1e8, z: 9e9 }, t)).toBe(star);
    expect(model.soiBodyAt(model.stationAbsState(ID.stationMoon, t).r, t).id).toBe(ID.giantMoonLarge);
    expect(model.soiBodyAt(model.beaconAbsState(t).r, t)).toBe(giant);
    // The moon has moved on by another time.
    const later = t + 20000;
    const sameSpot = add(model.bodyAbsState(ID.rocky, later).r, add(sub(moonAbs, planetAbs), { x: 0, y: 2e6, z: 0 }));
    expect(model.soiBodyAt(sameSpot, later)).toBe(rocky);
    // Relative form.
    expect(model.soiBodyFor({ x: 0, y: 2e6, z: 0 }, ID.rockyMoon, t)).toBe(moon);
    expect(model.soiBodyFor(model.bodyState(ID.rockyMoon, t).r, ID.rocky, t)).toBe(moon);
  });
});

// ------------------------------------------------------------------------------------ patched conics

/** Absolute-coordinate continuity and time contiguity of consecutive patches. */
function expectContinuous(model: SystemModel, patches: TrajectoryPatch[]): void {
  for (const p of patches) {
    expect(finiteState(p.svStart) && finiteState(p.svEnd)).toBe(true);
    expect(finiteElements(p.elements)).toBe(true);
    expect(Number.isFinite(p.tStart) && Number.isFinite(p.tEnd)).toBe(true);
    expect(p.tEnd).toBeGreaterThanOrEqual(p.tStart);
    expect(p.mu).toBe(model.body(p.bodyId).mu);
  }
  for (let k = 0; k + 1 < patches.length; k++) {
    const a = patches[k];
    const b = patches[k + 1];
    expect(b.tStart).toBe(a.tEnd);
    expect(a.nextBodyId).toBe(b.bodyId);
    expect(a.endReason === 'soi-exit' || a.endReason === 'soi-enter').toBe(true);
    const endAbs = model.toAbsolute(a.svEnd, a.bodyId, a.tEnd);
    const startAbs = model.toAbsolute(b.svStart, b.bodyId, b.tStart);
    expect(len(sub(endAbs.r, startAbs.r))).toBeLessThan(1e-3);
    expect(len(sub(endAbs.v, startAbs.v))).toBeLessThan(1e-7);
  }
  const last = patches[patches.length - 1];
  if (last.endReason !== 'soi-exit' && last.endReason !== 'soi-enter') expect(last.nextBodyId).toBeNull();
}

/**
 * Brute force: first time in (t0, tMax] the ship (state `s0` relative to `bodyId` at `t0`, coasting)
 * is inside the SOI of any child of that body. Fixed-step scan + bisection.
 */
function bruteFirstChildEntry(
  model: SystemModel,
  bodyId: string,
  s0: StateVector,
  t0: number,
  tMax: number,
  step: number,
): { t: number; childId: string } | null {
  const mu = model.body(bodyId).mu;
  const kids = model.children(bodyId);
  const gap = (childId: string, t: number): number =>
    len(sub(propagateState(s0, mu, t - t0).r, model.bodyState(childId, t).r)) - model.body(childId).soi;
  for (let t = t0 + step; t <= tMax; t += step) {
    for (const kid of kids) {
      if (gap(kid.id, t) < 0) {
        let lo = t - step;
        let hi = t;
        for (let k = 0; k < 60; k++) {
          const mid = 0.5 * (lo + hi);
          if (gap(kid.id, mid) < 0) hi = mid;
          else lo = mid;
        }
        return { t: hi, childId: kid.id };
      }
    }
  }
  return null;
}

describe('predictTrajectory (patched conics)', () => {
  const def = makeTestSystem();
  const model = new SystemModel(def);
  const rocky = model.body(ID.rocky);
  const moon = model.body(ID.rockyMoon);
  const giant = model.body(ID.giant);
  const inner = model.body(ID.inner);

  /** Ship in a circular orbit of radius r1 in the moon's orbit plane, `phase` rad behind the moon, after a prograde burn. */
  function transferStart(t0: number, r1: number, phase: number, dv: number): StateVector {
    const ms = model.bodyState(ID.rockyMoon, t0);
    const n = orbitNormal(ms);
    const u = norm(ms.r);
    const w = cross(n, u);
    const dir = sub(scale(u, Math.cos(phase)), scale(w, Math.sin(phase)));
    return { r: scale(dir, r1), v: scale(cross(n, dir), circularSpeed(rocky.mu, r1) + dv) };
  }

  it('reports a stable low orbit as one closed patch', () => {
    const t0 = 500;
    const s = model.stationState(ID.stationLow, t0);
    const patches = predictTrajectory(model, { bodyId: ID.rocky, sv: s, t: t0 });
    expect(patches.length).toBe(1);
    const p = patches[0];
    expect(p.bodyId).toBe(ID.rocky);
    expect(p.endReason).toBe('closed');
    expect(p.nextBodyId).toBeNull();
    expect(p.tStart).toBe(t0);
    expectRel(p.period, orbitalPeriod(rocky.mu, rocky.radius + 4e5), 1e-9);
    expectRel(p.tEnd - p.tStart, p.period, 1e-12);
    expectRel(p.periapsisRadius, rocky.radius + 4e5, 1e-9);
    expectRel(p.apoapsisRadius, rocky.radius + 4e5, 1e-9);
    expect(p.svStart).toEqual(s);
    expect(stateError(s, p.svEnd, rocky.mu)).toBeLessThan(1e-10);
    expectRel(p.elements.a, rocky.radius + 4e5, 1e-9);
    expect(p.elements.epoch).toBe(t0);
    // searchPeriods extends the window.
    const three = predictTrajectory(model, { bodyId: ID.rocky, sv: s, t: t0 }, { searchPeriods: 3 });
    expectRel(three[0].tEnd - t0, 3 * p.period, 1e-12);
  });

  it('stops at the horizon with max-time', () => {
    const s = model.stationState(ID.stationLow, 0);
    const p = predictTrajectory(model, { bodyId: ID.rocky, sv: s, t: 0 }, { maxDuration: 1000 })[0];
    expect(p.endReason).toBe('max-time');
    expect(p.tEnd).toBe(1000);
    expect(stateError(propagateState(s, rocky.mu, 1000), p.svEnd, rocky.mu)).toBeLessThan(1e-14);
    // Elliptic arc from periapsis: the horizon cuts it before apoapsis.
    expect(p.apoapsisTime).toBeNull();
  });

  it('ends at the atmosphere or the surface', () => {
    const rAtm = rocky.radius + rocky.atmosphere!.height;
    // Apoapsis 800 km up, periapsis 300 km underground.
    const ra = rocky.radius + 8e5;
    const rp = rocky.radius - 3e5;
    const s = sv(0, 0, ra, -visViva(rocky.mu, ra, 0.5 * (ra + rp)), 0, 0);
    const p = predictTrajectory(model, { bodyId: ID.rocky, sv: s, t: 10 })[0];
    expect(p.endReason).toBe('atmosphere');
    expect(p.nextBodyId).toBeNull();
    expectRel(len(p.svEnd.r), rAtm, 1e-10);
    expect(dot(p.svEnd.r, p.svEnd.v)).toBeLessThan(0);
    expectRel(p.periapsisRadius, rp, 1e-9);
    expect(p.periapsisTime).toBeNull();
    expectNear(p.tEnd - 10, timeToRadius(s, rocky.mu, rAtm, 'inward'), 1e-9);
    const vac = predictTrajectory(model, { bodyId: ID.rocky, sv: s, t: 10 }, { stopAtAtmosphere: false })[0];
    expect(vac.endReason).toBe('impact');
    expectRel(len(vac.svEnd.r), rocky.radius, 1e-10);
    expect(vac.tEnd).toBeGreaterThan(p.tEnd);
    // Airless moon: straight to impact; RK4 agrees on when.
    const sm = sv(moon.radius + 5e4, 0, 0, -30, 0, -900);
    const pm = predictTrajectory(model, { bodyId: ID.rockyMoon, sv: sm, t: 0 })[0];
    expect(pm.endReason).toBe('impact');
    expectRel(len(pm.svEnd.r), moon.radius, 1e-10);
    expect(stateError(rk4Propagate(sm, moon.mu, pm.tEnd, 4000), pm.svEnd, moon.mu)).toBeLessThan(1e-9);
    // An aerobraking pass (periapsis inside the atmosphere) stops at the interface too.
    const sAero = sv(0, 0, ra, -visViva(rocky.mu, ra, 0.5 * (ra + rocky.radius + 6e4)), 0, 0);
    expect(predictTrajectory(model, { bodyId: ID.rocky, sv: sAero, t: 0 })[0].endReason).toBe('atmosphere');
  });

  it('detects the transfer from low orbit to the moon with the right periapsis (vs brute-force RK4)', () => {
    const t0 = 1000;
    const r1 = rocky.radius + 4e5;
    const h = hohmann(rocky.mu, r1, moon.orbit!.a);
    const s0 = transferStart(t0, r1, h.phaseAngle - 0.2, h.dv1);
    const patches = predictTrajectory(model, { bodyId: ID.rocky, sv: s0, t: t0 }, { maxPatches: 4, maxDuration: 10 * DAY });
    expectContinuous(model, patches);
    expect(patches.length).toBeGreaterThanOrEqual(3);
    const [p0, p1, p2] = patches;
    expect(p0.bodyId).toBe(ID.rocky);
    expect(p0.endReason).toBe('soi-enter');
    expect(p0.nextBodyId).toBe(ID.rockyMoon);
    expectRel(p0.apoapsisRadius, moon.orbit!.a, 1e-9);
    expect(p1.bodyId).toBe(ID.rockyMoon);
    expect(p1.endReason).toBe('soi-exit');
    expect(p1.nextBodyId).toBe(ID.rocky);
    expect(p1.elements.e).toBeGreaterThan(1);
    expect(p2.bodyId).toBe(ID.rocky);
    // SOI boundaries are hit exactly.
    expectRel(len(p1.svStart.r), moon.soi, 1e-9);
    expectRel(len(p1.svEnd.r), moon.soi, 1e-9);
    expect(dot(p1.svStart.r, p1.svStart.v)).toBeLessThan(0);
    expect(dot(p1.svEnd.r, p1.svEnd.v)).toBeGreaterThan(0);
    // The flyby clears the surface and its periapsis is inside the patch.
    expect(p1.periapsisRadius).toBeGreaterThan(moon.radius);
    expect(p1.periapsisTime).not.toBeNull();
    expect(p1.periapsisTime!).toBeGreaterThan(p1.tStart);
    expect(p1.periapsisTime!).toBeLessThan(p1.tEnd);
    expectRel(len(patchStateAt(p1, p1.periapsisTime!).r), p1.periapsisRadius, 1e-9);

    // ---- brute force: integrate ship and moon around the planet with RK4 until the ship enters the moon's SOI.
    const ship = toArr(s0);
    const moonS = toArr(model.bodyState(ID.rockyMoon, t0));
    const sep = (a: Float64Array, b: Float64Array): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const hStep = 1;
    let t = t0;
    let tEntry = NaN;
    for (let k = 0; k < 40000 && Number.isNaN(tEntry); k++) {
      const shipPrev = ship.slice();
      const moonPrev = moonS.slice();
      rk4Step(ship, rocky.mu, hStep);
      rk4Step(moonS, rocky.mu, hStep);
      if (sep(ship, moonS) < moon.soi) {
        let lo = 0;
        let hi = 1;
        for (let j = 0; j < 50; j++) {
          const mid = 0.5 * (lo + hi);
          const a = shipPrev.slice();
          const b = moonPrev.slice();
          rk4Step(a, rocky.mu, mid * hStep);
          rk4Step(b, rocky.mu, mid * hStep);
          if (sep(a, b) < moon.soi) hi = mid;
          else lo = mid;
        }
        ship.set(shipPrev);
        moonS.set(moonPrev);
        rk4Step(ship, rocky.mu, hi * hStep);
        rk4Step(moonS, rocky.mu, hi * hStep);
        tEntry = t + hi * hStep;
      }
      t += hStep;
    }
    expect(Number.isNaN(tEntry)).toBe(false);
    expectNear(p0.tEnd, tEntry, 2e-3, 'SOI entry time');
    // Moon-relative state at entry, and the periapsis of that hyperbola from first principles.
    const rel = Float64Array.of(ship[0] - moonS[0], ship[1] - moonS[1], ship[2] - moonS[2], ship[3] - moonS[3], ship[4] - moonS[4], ship[5] - moonS[5]);
    const relSv = fromArr(rel);
    expect(stateError(relSv, p1.svStart, moon.mu)).toBeLessThan(1e-6);
    const hh = len(cross(relSv.r, relSv.v));
    const pp = (hh * hh) / moon.mu;
    const ee = Math.sqrt(1 + (2 * specificEnergy(relSv, moon.mu) * hh * hh) / (moon.mu * moon.mu));
    expectRel(p1.periapsisRadius, pp / (1 + ee), 1e-6, 'flyby periapsis');
    // Fly the flyby with RK4 in the moon's frame: periapsis time, minimum radius, SOI exit time.
    let tm = tEntry;
    let minR = Infinity;
    let tMin = NaN;
    let tExit = NaN;
    const hm = 0.5;
    for (let k = 0; k < 100000 && Number.isNaN(tExit); k++) {
      const prev = rel.slice();
      rk4Step(rel, moon.mu, hm);
      tm += hm;
      const r = Math.hypot(rel[0], rel[1], rel[2]);
      if (r < minR) {
        minR = r;
        tMin = tm;
      }
      if (r > moon.soi && k > 2) {
        let lo = 0;
        let hi = 1;
        for (let j = 0; j < 50; j++) {
          const mid = 0.5 * (lo + hi);
          const a = prev.slice();
          rk4Step(a, moon.mu, mid * hm);
          if (Math.hypot(a[0], a[1], a[2]) > moon.soi) hi = mid;
          else lo = mid;
        }
        tExit = tm - hm + hi * hm;
      }
    }
    expectRel(p1.periapsisRadius, minR, 1e-6, 'RK4 minimum radius');
    expectNear(p1.periapsisTime!, tMin, 1, 'periapsis time');
    expectNear(p1.tEnd, tExit, 5e-3, 'SOI exit time');
    // After the flyby the planet-centred orbit has changed.
    expect(Math.abs(p2.elements.a - p0.elements.a) / p0.elements.a).toBeGreaterThan(0.01);
    expect(p2.tStart).toBe(p1.tEnd);
  });

  it('a Hohmann transfer timed to arrive just ahead of the moon is captured into its SOI every time', () => {
    const r1 = rocky.radius + 4e5;
    const h = hohmann(rocky.mu, r1, moon.orbit!.a);
    for (const t0 of [0, 7000, 20000, 33333]) {
      for (const lead of [-0.2, -0.1, 0, 0.1, 0.2]) {
        const s0 = transferStart(t0, r1, h.phaseAngle + lead, h.dv1);
        const patches = predictTrajectory(model, { bodyId: ID.rocky, sv: s0, t: t0 }, { maxPatches: 2 });
        expect(patches[0].endReason).toBe('soi-enter');
        expect(patches[0].nextBodyId).toBe(ID.rockyMoon);
        expect(patches[0].tEnd - t0).toBeLessThan(h.tof * 1.3);
        expectContinuous(model, patches);
        const brute = bruteFirstChildEntry(model, ID.rocky, s0, t0, t0 + 2 * h.tof, 5);
        expect(brute).not.toBeNull();
        expectNear(patches[0].tEnd, brute!.t, 1e-4);
      }
    }
    // Far from the right phase there is no encounter: the transfer ellipse just closes.
    const miss = predictTrajectory(model, { bodyId: ID.rocky, sv: transferStart(0, r1, h.phaseAngle + 1.5, h.dv1), t: 0 });
    expect(miss[0].endReason).toBe('closed');
  });

  it('leaves the planet SOI continuously into a star-centred orbit', () => {
    const t0 = 86400;
    const r1 = rocky.radius + 4e5;
    const vInf = 1500;
    const speed = Math.sqrt(escapeSpeed(rocky.mu, r1) ** 2 + vInf * vInf);
    // Depart along the planet's own direction of motion (roughly), from the equatorial parking orbit.
    const s0 = sv(r1, 0, 0, 0, 0, -speed);
    const patches = predictTrajectory(model, { bodyId: ID.rocky, sv: s0, t: t0 }, { maxPatches: 3, maxDuration: 30 * DAY });
    expectContinuous(model, patches);
    const [p0, p1] = patches;
    expect(p0.endReason).toBe('soi-exit');
    expect(p0.nextBodyId).toBe(ID.star);
    expectRel(len(p0.svEnd.r), rocky.soi, 1e-10);
    expectNear(p0.tEnd - t0, timeToRadius(s0, rocky.mu, rocky.soi, 'outward'), 1e-6);
    expect(stateError(rk4Propagate(s0, rocky.mu, p0.tEnd - t0, 30000), p0.svEnd, rocky.mu)).toBeLessThan(1e-8);
    // Hyperbolic excess speed is what we asked for.
    expectRel(Math.sqrt(2 * specificEnergy(p0.svEnd, rocky.mu) + (2 * rocky.mu) / 1e30), vInf, 1e-9);
    expect(p0.elements.e).toBeGreaterThan(1);
    expect(p0.apoapsisRadius).toBe(Infinity);
    expect(p0.period).toBe(Infinity);
    // The star-centred conic starts from planet state + planet-relative state.
    expect(p1.bodyId).toBe(ID.star);
    const planet = model.bodyState(ID.rocky, p0.tEnd);
    expect(len(sub(p1.svStart.r, add(planet.r, p0.svEnd.r)))).toBeLessThan(1e-3);
    expect(len(sub(p1.svStart.v, add(planet.v, p0.svEnd.v)))).toBeLessThan(1e-9);
    expect(p1.elements.a).toBeGreaterThan(0);
    expect(p1.periapsisRadius).toBeGreaterThan(0.5 * rocky.orbit!.a);
    // The ship is outside the planet's SOI for (at least) the first hours of the new arc.
    for (const dt of [60, 3600, 6 * 3600]) {
      const ship = patchStateAt(p1, p1.tStart + dt);
      expect(len(sub(ship.r, model.bodyState(ID.rocky, p1.tStart + dt).r))).toBeGreaterThan(rocky.soi);
    }
  });

  it('does not miss a 165 km/s flyby through a small planet SOI', () => {
    // Retrograde star orbit meeting the inner planet head-on at tMeet, 0.4 SOI off its centre.
    const tMeet = 61234.5;
    const planet = model.bodyState(ID.inner, tMeet);
    const atMeet: StateVector = { r: addScaled(planet.r, orbitNormal(planet), 0.4 * inner.soi), v: scale(planet.v, -1) };
    const s0 = propagateState(atMeet, model.primary.mu, -tMeet);
    const patches = predictTrajectory(model, { bodyId: ID.star, sv: s0, t: 0 }, { maxPatches: 3, maxDuration: 3 * DAY });
    expectContinuous(model, patches);
    const [p0, p1, p2] = patches;
    expect(p0.endReason).toBe('soi-enter');
    expect(p0.nextBodyId).toBe(ID.inner);
    const brute = bruteFirstChildEntry(model, ID.star, s0, 0, 3 * DAY, 10);
    expect(brute).not.toBeNull();
    expect(brute!.childId).toBe(ID.inner);
    expectNear(p0.tEnd, brute!.t, 1e-4);
    const relSpeed = len(p1.svStart.v);
    expect(relSpeed).toBeGreaterThan(1.6e5);
    // In and out in about 2·√(1 - 0.4²)·SOI / v ≈ 150 s, barely deflected.
    expect(p1.endReason).toBe('soi-exit');
    expectRel(p1.tEnd - p1.tStart, (2 * Math.sqrt(1 - 0.16) * inner.soi) / relSpeed, 0.01);
    expectRel(p1.periapsisRadius, 0.4 * inner.soi, 0.01);
    expectNear(p1.periapsisTime!, tMeet, 0.5);
    expect(p2.bodyId).toBe(ID.star);
  });

  it('does not miss a 45 km/s flyby of a small moon, nor the events after it', () => {
    const osk = model.body(ID.giantMoonSmall);
    const tMeet = 30000;
    const ms = model.bodyState(ID.giantMoonSmall, tMeet);
    const inward = scale(norm(ms.r), -1);
    const side = norm(cross(ms.r, ms.v));
    const atMeet: StateVector = {
      r: add(ms.r, scale(side, 0.5 * osk.soi)),
      v: add(scale(inward, 38000), scale(norm(ms.v), 14000)),
    };
    const s0 = propagateState(atMeet, giant.mu, -tMeet);
    expect(len(s0.r)).toBeLessThan(giant.soi);
    const patches = predictTrajectory(model, { bodyId: ID.giant, sv: s0, t: 0 }, { maxPatches: 6, maxDuration: 5 * DAY });
    expectContinuous(model, patches);
    const brute = bruteFirstChildEntry(model, ID.giant, s0, 0, tMeet + 1000, 5);
    expect(brute).not.toBeNull();
    expect(patches[0].endReason).toBe('soi-enter');
    expect(patches[0].nextBodyId).toBe(brute!.childId);
    expectNear(patches[0].tEnd, brute!.t, 1e-4);
    const flyby = patches.find((p) => p.bodyId === ID.giantMoonSmall);
    expect(flyby).toBeDefined();
    expect(flyby!.tStart).toBeLessThan(tMeet);
    expect(flyby!.tEnd).toBeGreaterThan(tMeet);
    expect(flyby!.tEnd - flyby!.tStart).toBeLessThan(400);
    // The prediction ends with something definite (leaving the giant, or hitting its atmosphere).
    const last = patches[patches.length - 1];
    expect(['atmosphere', 'soi-exit', 'closed', 'max-time']).toContain(last.endReason);
  });

  it('puts the start state into the frame it belongs to', () => {
    const t0 = 2222;
    // Deep inside the moon's SOI, but expressed relative to the planet.
    const local = sv(moon.radius + 3e5, 0, 0, 0, 0, -circularSpeed(moon.mu, moon.radius + 3e5));
    const inPlanet = model.changeFrame(local, ID.rockyMoon, ID.rocky, t0);
    const p = predictTrajectory(model, { bodyId: ID.rocky, sv: inPlanet, t: t0 })[0];
    expect(p.bodyId).toBe(ID.rockyMoon);
    expect(p.endReason).toBe('closed');
    expect(len(sub(p.svStart.r, local.r))).toBeLessThan(1e-6);
    // Outside the moon's SOI and receding, but expressed relative to the moon.
    const outside = sv(moon.soi * 1.5, 0, 0, 800, 0, -300);
    const q = predictTrajectory(model, { bodyId: ID.rockyMoon, sv: outside, t: t0 })[0];
    expect(q.bodyId).toBe(ID.rocky);
    const expected = model.changeFrame(outside, ID.rockyMoon, ID.rocky, t0);
    expect(len(sub(q.svStart.r, expected.r))).toBeLessThan(1e-6);
    // The caller's state is never modified.
    expect(outside).toEqual(sv(moon.soi * 1.5, 0, 0, 800, 0, -300));
    // Sitting exactly on the SOI: leaving -> the parent's frame at once (no zero-length arc);
    // arriving -> stays, and flies the pass.
    const leaving = predictTrajectory(model, { bodyId: ID.rockyMoon, sv: sv(moon.soi, 0, 0, 600, 0, -200), t: t0 });
    expect(leaving[0].bodyId).toBe(ID.rocky);
    expect(leaving[0].tEnd).toBeGreaterThan(t0 + 1);
    const arriving = predictTrajectory(model, { bodyId: ID.rockyMoon, sv: sv(moon.soi, 0, 0, -600, 0, -900), t: t0 });
    expect(arriving[0].bodyId).toBe(ID.rockyMoon);
    expect(arriving[0].endReason).toBe('soi-exit');
    expect(arriving[0].tEnd).toBeGreaterThan(t0 + 1000);
    expectContinuous(model, arriving);
    // Garbage in, nothing out.
    expect(predictTrajectory(model, { bodyId: ID.rocky, sv: sv(NaN, 0, 0, 0, 0, 0), t: 0 })).toEqual([]);
    expect(predictTrajectory(model, { bodyId: ID.rocky, sv: sv(0, 0, 0, 1, 2, 3), t: 0 })).toEqual([]);
    expect(predictTrajectory(model, { bodyId: ID.rocky, sv: sv(1e7, 0, 0, 0, Infinity, 0), t: 0 })).toEqual([]);
    expect(() => predictTrajectory(model, { bodyId: 'nope', sv: outside, t: 0 })).toThrow();
    // An infinite horizon is clamped: every time in the result is finite.
    const esc = predictTrajectory(model, { bodyId: ID.star, sv: sv(3e9, 0, 0, 0, 0, -1.5e5), t: 0 }, { maxDuration: Infinity });
    expect(esc[0].endReason).toBe('max-time');
    expect(Number.isFinite(esc[0].tEnd)).toBe(true);
    expect(finiteState(esc[0].svEnd)).toBe(true);
  });

  it('respects maxPatches and looks up states along the prediction', () => {
    const t0 = 1000;
    const r1 = rocky.radius + 4e5;
    const h = hohmann(rocky.mu, r1, moon.orbit!.a);
    const s0 = transferStart(t0, r1, h.phaseAngle - 0.2, h.dv1);
    const start = { bodyId: ID.rocky, sv: s0, t: t0 };
    const one = predictTrajectory(model, start, { maxPatches: 1 });
    expect(one.length).toBe(1);
    expect(one[0].endReason).toBe('soi-enter');
    const patches = predictTrajectory(model, start, { maxPatches: 3 });
    expect(patches.length).toBe(3);
    expect(patches[0]).toEqual(one[0]);
    const out = newState();
    expect(trajectoryStateAt([], t0, out)).toBe(-1);
    expect(trajectoryStateAt(patches, t0, out)).toBe(0);
    expect(out).toEqual(s0);
    const mid1 = 0.5 * (patches[1].tStart + patches[1].tEnd);
    expect(trajectoryStateAt(patches, mid1, out)).toBe(1);
    expect(out).toEqual(patchStateAt(patches[1], mid1));
    expect(len(out.r)).toBeLessThan(moon.soi);
    expect(trajectoryStateAt(patches, patches[2].tStart + 1, out)).toBe(2);
    expect(stateError(patchStateAt(patches[1], patches[1].tEnd), patches[1].svEnd, moon.mu)).toBeLessThan(1e-12);
    // Deterministic and free of hidden state: same input, same output, whatever ran in between.
    predictTrajectory(model, { bodyId: ID.giant, sv: model.beaconState(5), t: 5 });
    expect(predictTrajectory(model, start, { maxPatches: 3 })).toEqual(patches);
  });

  it('never steps over an SOI, a surface or its own SOI boundary (random coasts, brute-force check)', () => {
    const rng = makeRng('predict-fuzz');
    const hosts = [ID.rocky, ID.giant, ID.star, ID.rockyMoon, ID.giantMoonLarge];
    const reasons = new Map<string, number>();
    let multi = 0;
    for (let k = 0; k < 240; k++) {
      const host = model.body(hosts[k % hosts.length]);
      const rMin = (host.radius + (host.atmosphere ? host.atmosphere.height : 0)) * 1.05;
      const rMax = host.soi < Infinity ? host.soi * 0.9 : 2.2e10;
      const r = rMin * Math.pow(rMax / rMin, rng.next());
      const u = randomUnit(rng);
      // Mostly near the reference plane (where the moons are), sometimes anywhere.
      if (k % 3 !== 0) u.y *= 0.05;
      const pos = scale(norm(u), r);
      const tangent = norm(cross({ x: 0, y: 1, z: 0 }, pos));
      const dir = norm(add(add(scale(tangent, rng.range(-1, 1)), scale(norm(pos), rng.range(-1, 1))), { x: 0, y: rng.range(-0.1, 0.1), z: 0 }));
      const speed = circularSpeed(host.mu, r) * rng.range(0.4, 1.8);
      const t0 = rng.range(0, 40 * DAY);
      const s0: StateVector = { r: pos, v: scale(dir, speed) };
      const patches = predictTrajectory(model, { bodyId: host.id, sv: s0, t: t0 }, { maxPatches: 5, maxDuration: 40 * DAY });
      expect(patches.length).toBeGreaterThanOrEqual(1);
      expect(patches.length).toBeLessThanOrEqual(5);
      expectContinuous(model, patches);
      if (patches.length > 1) multi++;
      for (const p of patches) {
        reasons.set(p.endReason, (reasons.get(p.endReason) ?? 0) + 1);
        const body = model.body(p.bodyId);
        const kids = model.children(p.bodyId);
        const span = p.tEnd - p.tStart;
        expect(p.tEnd).toBeLessThanOrEqual(t0 + 40 * DAY * (1 + 1e-12));
        const N = 300;
        for (let j = 1; j < N; j++) {
          const t = p.tStart + (span * j) / N;
          const s = patchStateAt(p, t);
          const rr = len(s.r);
          // Inside its own SOI, above the ground (and the atmosphere, where there is one)…
          if (body.soi < Infinity) expect(rr).toBeLessThan(body.soi * (1 + 1e-9));
          const floor = p.endReason === 'impact' || !body.atmosphere ? body.radius : body.radius + body.atmosphere.height;
          if (p !== patches[0] || len(patches[0].svStart.r) >= floor) expect(rr).toBeGreaterThan(floor * (1 - 1e-9));
          // …and never inside a child's SOI without the prediction having said so.
          for (const kid of kids) {
            const d = len(sub(s.r, model.bodyState(kid.id, t).r));
            expect(d, `${p.bodyId} patch inside ${kid.id} SOI at t=${t} (case ${k})`).toBeGreaterThan(kid.soi * (1 - 1e-6));
          }
        }
        // End conditions are what they claim to be.
        const rEnd = len(p.svEnd.r);
        if (p.endReason === 'soi-exit') expectRel(rEnd, body.soi, 1e-9);
        if (p.endReason === 'impact') expectRel(rEnd, body.radius, 1e-9);
        if (p.endReason === 'atmosphere') expectRel(rEnd, body.radius + body.atmosphere!.height, 1e-9);
        if (p.endReason === 'soi-enter') {
          const kid = model.body(p.nextBodyId!);
          expectRel(len(sub(p.svEnd.r, model.bodyState(kid.id, p.tEnd).r)), kid.soi, 1e-8);
        }
        if (p.endReason === 'closed') expectRel(span, p.period, 1e-12);
      }
    }
    // The fuzz really exercised every kind of ending and plenty of multi-patch trajectories.
    for (const reason of ['soi-exit', 'soi-enter', 'impact', 'atmosphere', 'max-time', 'closed']) {
      expect(reasons.get(reason) ?? 0, `no '${reason}' patch in the fuzz`).toBeGreaterThan(0);
    }
    expect(multi).toBeGreaterThan(40);
  });

  it('predicts four patches in well under 10 ms', () => {
    const t0 = 1000;
    const r1 = rocky.radius + 4e5;
    const h = hohmann(rocky.mu, r1, moon.orbit!.a);
    const starts = [
      { bodyId: ID.rocky, sv: transferStart(t0, r1, h.phaseAngle - 0.2, h.dv1), t: t0 },
      { bodyId: ID.rocky, sv: transferStart(t0, r1, h.phaseAngle + 0.2, h.dv1), t: t0 },
      { bodyId: ID.rocky, sv: sv(r1, 0, 0, 0, 0, -escapeSpeed(rocky.mu, r1) * 1.05), t: t0 },
      { bodyId: ID.giant, sv: model.beaconState(t0), t: t0 },
    ];
    const opts = { maxPatches: 4, maxDuration: 60 * DAY };
    let patchCount = 0;
    for (const s of starts) patchCount += predictTrajectory(model, s, opts).length; // warm-up
    expect(patchCount).toBeGreaterThanOrEqual(8);
    const reps = 50;
    const tA = performance.now();
    for (let k = 0; k < reps; k++) for (const s of starts) predictTrajectory(model, s, opts);
    const msPerCall = (performance.now() - tA) / (reps * starts.length);
    expect(msPerCall).toBeLessThan(10);
  });
});

// ------------------------------------------------------------------------------------ polylines

describe('sampleOrbit / samplePatch', () => {
  const def = makeTestSystem();
  const model = new SystemModel(def);
  const rocky = model.body(ID.rocky);
  const moon = model.body(ID.rockyMoon);

  const point = (buf: Float64Array, k: number): V3 => ({ x: buf[3 * k], y: buf[3 * k + 1], z: buf[3 * k + 2] });

  /** Every point satisfies the conic equation |r| + e·r = p for the orbit through `s`. */
  function expectOnConic(buf: Float64Array, n: number, s: StateVector, mu: number): void {
    const ev = eccVector(s, mu);
    const h = len(cross(s.r, s.v));
    const p = (h * h) / mu;
    const normal = norm(cross(s.r, s.v));
    for (let k = 0; k < n; k++) {
      const q = point(buf, k);
      expect(Math.abs(len(q) + dot(ev, q) - p) / p).toBeLessThan(1e-9);
      expect(Math.abs(dot(q, normal)) / len(q)).toBeLessThan(1e-9);
    }
  }

  it('samples a whole elliptic orbit, closed and denser near periapsis', () => {
    const el: OrbitElements = { a: 2e7, e: 0.7, i: 0.4, lan: 1, argp: 2, m0: 1, epoch: 0 };
    const n = 96;
    const buf = sampleOrbit(el, n);
    expect(buf.length).toBe(3 * n);
    const pe = elementsToState({ ...el, m0: 0 }, rocky.mu, 0);
    expect(len(sub(point(buf, 0), pe.r))).toBeLessThan(1e-6);
    expect(point(buf, n - 1)).toEqual(point(buf, 0));
    expectOnConic(buf, n, pe, rocky.mu);
    // Travels in the direction of motion.
    expect(dot(sub(point(buf, 1), point(buf, 0)), pe.v)).toBeGreaterThan(0);
    // Segment lengths: shortest at periapsis, longest at apoapsis, but never coarse.
    const seg = (k: number): number => len(sub(point(buf, k + 1), point(buf, k)));
    expect(seg(0)).toBeLessThan(0.5 * seg(n / 2 - 1));
    let longest = 0;
    let total = 0;
    for (let k = 0; k < n - 1; k++) {
      longest = Math.max(longest, seg(k));
      total += seg(k);
    }
    expect(longest).toBeLessThan((3 * total) / (n - 1));
    // Angular step at periapsis stays small even though the ship is fast there.
    const ang = Math.acos(dot(norm(point(buf, 0)), norm(point(buf, 1))));
    expect(ang).toBeLessThan((2 * TAU) / n);
    // Reuses the caller's buffer.
    const mine = new Float64Array(3 * n + 9);
    expect(sampleOrbit(el, n, mine)).toBe(mine);
    expect(Array.from(mine.subarray(0, 3 * n))).toEqual(Array.from(buf));
  });

  it('samples a hyperbola symmetrically out to rMax', () => {
    const el: OrbitElements = { a: -1e7, e: 1.5, i: 1, lan: 0.3, argp: 4, m0: 0, epoch: 0 };
    const n = 65;
    const buf = sampleOrbit(el, n, undefined, 2e8);
    const pe = elementsToState(el, rocky.mu, 0);
    expectOnConic(buf, n, pe, rocky.mu);
    expect(len(sub(point(buf, (n - 1) / 2), pe.r))).toBeLessThan(1e-6);
    expectRel(len(point(buf, 0)), 2e8, 1e-9);
    expectRel(len(point(buf, n - 1)), 2e8, 1e-9);
    for (let k = 0; k < n; k++) expect(Number.isFinite(buf[3 * k])).toBe(true);
    expect(dot(sub(point(buf, (n - 1) / 2 + 1), point(buf, (n - 1) / 2)), pe.v)).toBeGreaterThan(0);
  });

  it('samples patches from exact start to exact end', () => {
    const t0 = 1000;
    const r1 = rocky.radius + 4e5;
    const h = hohmann(rocky.mu, r1, moon.orbit!.a);
    const ms = model.bodyState(ID.rockyMoon, t0);
    const nrm = orbitNormal(ms);
    const u = norm(ms.r);
    const phase = h.phaseAngle - 0.2;
    const dir = sub(scale(u, Math.cos(phase)), scale(cross(nrm, u), Math.sin(phase)));
    const s0: StateVector = { r: scale(dir, r1), v: scale(cross(nrm, dir), circularSpeed(rocky.mu, r1) + h.dv1) };
    const patches = predictTrajectory(model, { bodyId: ID.rocky, sv: s0, t: t0 }, { maxPatches: 3 });
    expect(patches.length).toBe(3);
    const n = 48;
    for (const p of patches) {
      const buf = samplePatch(p, n);
      expect(point(buf, 0)).toEqual(p.svStart.r);
      expect(point(buf, n - 1)).toEqual(p.svEnd.r);
      expectOnConic(buf, n, p.svStart, p.mu);
      // Monotonic along the direction of travel: each point is ahead of the previous one.
      const nn = norm(cross(p.svStart.r, p.svStart.v));
      for (let k = 0; k + 1 < n; k++) {
        expect(dot(cross(point(buf, k), point(buf, k + 1)), nn)).toBeGreaterThan(0);
      }
    }
    // Consecutive patches join in absolute coordinates.
    const endAbs = add(point(samplePatch(patches[0], n), n - 1), model.bodyAbsPosition(patches[0].bodyId, patches[0].tEnd));
    const startAbs = add(point(samplePatch(patches[1], n), 0), model.bodyAbsPosition(patches[1].bodyId, patches[1].tStart));
    expect(len(sub(endAbs, startAbs))).toBeLessThan(1e-3);
    // The flyby hyperbola is sampled through its periapsis.
    const fly = samplePatch(patches[1], 201);
    let minR = Infinity;
    for (let k = 0; k < 201; k++) minR = Math.min(minR, len(point(fly, k)));
    expectRel(minR, patches[1].periapsisRadius, 1e-3);
  });

  it('draws a closed patch as one full revolution and survives degenerate input', () => {
    const s = model.stationState(ID.orbiter2, 0);
    const p = predictTrajectory(model, { bodyId: ID.rocky, sv: s, t: 0 })[0];
    expect(p.endReason).toBe('closed');
    const n = 64;
    const buf = samplePatch(p, n);
    expect(point(buf, 0)).toEqual(s.r);
    expect(point(buf, n - 1)).toEqual(s.r);
    expectOnConic(buf, n, s, rocky.mu);
    // All the way round: the points span every quadrant.
    let total = 0;
    for (let k = 0; k + 1 < n; k++) total += Math.acos(Math.min(1, dot(norm(point(buf, k)), norm(point(buf, k + 1)))));
    expectNear(total, TAU, 1e-6);
    // Radial drop onto the airless moon: a straight line, no NaN.
    const drop = sv(0, moon.radius + 2e5, 0, 0, 0, 0);
    const dp = predictTrajectory(model, { bodyId: ID.rockyMoon, sv: drop, t: 0 })[0];
    expect(dp.endReason).toBe('impact');
    const line = samplePatch(dp, 16);
    for (let k = 0; k < 16; k++) {
      expect(Number.isFinite(line[3 * k + 1])).toBe(true);
      expectNear(line[3 * k], 0, 1e-6);
      expectNear(line[3 * k + 2], 0, 1e-6);
    }
    expectRel(line[3 * 15 + 1], moon.radius, 1e-9);
    // Minimum point count is clamped to 2.
    expect(samplePatch(p, 1).length).toBe(6);
    // The out-parameter element route allocates nothing new.
    const out = newState();
    expect(elementsToStateTo(out, p.elements, p.mu, 0)).toBe(out);
    expect(stateError(s, out, rocky.mu)).toBeLessThan(1e-10);
  });
});
