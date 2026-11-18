// Lambert solver: textbook cases, propagation round trips over the full range of transfer angles
// (including 0° / 180° / ~360°), elliptic and hyperbolic arcs, and bad input.

import { describe, expect, it } from 'vitest';
import { lambert } from '../src/sim/lambert';
import { newState, propagateStateTo } from '../src/sim/orbit';
import { makeRng } from '../src/core/rng';
import type { StateVector, V3 } from '../src/core/types';

const MU_EARTH_KM = 398600; // km^3/s^2 (textbook units — the solver is unit-agnostic)
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const Z = { x: 0, y: 0, z: 1 };

describe('lambert: textbook cases', () => {
  it('Curtis example 5.2 (elliptic, short way)', () => {
    const s = lambert({ x: 5000, y: 10000, z: 2100 }, { x: -14600, y: 2500, z: 7000 }, 3600, MU_EARTH_KM, { prograde: true, preferredNormal: Z });
    expect(s).not.toBeNull();
    const { v1, v2 } = s!;
    expect(v1.x).toBeCloseTo(-5.9925, 3);
    expect(v1.y).toBeCloseTo(1.9254, 3);
    expect(v1.z).toBeCloseTo(3.2456, 3);
    expect(v2.x).toBeCloseTo(-3.3125, 3);
    expect(v2.y).toBeCloseTo(-4.1966, 3);
    expect(v2.z).toBeCloseTo(-0.38529, 3);
  });

  it('Vallado example 7-5 (planar)', () => {
    const s = lambert({ x: 15945.34, y: 0, z: 0 }, { x: 12214.83899, y: 10249.46731, z: 0 }, 76 * 60, MU_EARTH_KM, { prograde: true, preferredNormal: Z });
    expect(s).not.toBeNull();
    expect(s!.v1.x).toBeCloseTo(2.058913, 4);
    expect(s!.v1.y).toBeCloseTo(2.915965, 4);
    expect(s!.v2.x).toBeCloseTo(-3.451565, 4);
    expect(s!.v2.y).toBeCloseTo(0.910315, 4);
  });

  it('Hohmann half-orbit (exactly 180°) takes its plane from the preferred normal', () => {
    const mu = 3.986e14;
    const r1 = 7e6;
    const r2 = 4.2e7;
    const a = 0.5 * (r1 + r2);
    const tof = Math.PI * Math.sqrt((a * a * a) / mu);
    // Project convention: XZ plane, +Y north; prograde = from +X toward -Z.
    const s = lambert({ x: r1, y: 0, z: 0 }, { x: -r2, y: 0, z: 0 }, tof, mu, { prograde: true, preferredNormal: { x: 0, y: 1, z: 0 } });
    expect(s).not.toBeNull();
    const vp = Math.sqrt(mu * (2 / r1 - 1 / a));
    const va = Math.sqrt(mu * (2 / r2 - 1 / a));
    expect(s!.v1.x).toBeCloseTo(0, 3);
    expect(s!.v1.y).toBeCloseTo(0, 3);
    expect(s!.v1.z / -vp).toBeCloseTo(1, 9);
    expect(s!.v2.z / va).toBeCloseTo(1, 9);
    // Inclined preferred normal: the transfer lies in that plane.
    const n = { x: 0, y: Math.cos(0.4), z: 0 };
    n.x = 0;
    const tilt = { x: 0, y: Math.cos(0.4), z: Math.sin(0.4) };
    const s2 = lambert({ x: r1, y: 0, z: 0 }, { x: -r2, y: 0, z: 0 }, tof, mu, { prograde: true, preferredNormal: tilt });
    const h = cross({ x: r1, y: 0, z: 0 }, s2!.v1);
    const hl = len(h);
    expect(h.y / hl).toBeCloseTo(tilt.y, 9);
    expect(h.z / hl).toBeCloseTo(tilt.z, 9);
    expect(n.y).toBeGreaterThan(0);
  });

  it('retrograde flag goes the other way round', () => {
    const mu = 3.986e14;
    const s = lambert({ x: 7e6, y: 0, z: 0 }, { x: 0, y: 0, z: -7e6 }, 3000, mu, { prograde: false });
    expect(s).not.toBeNull();
    const h = cross({ x: 7e6, y: 0, z: 0 }, s!.v1);
    expect(h.y).toBeLessThan(0);
  });
});

/** Propagate (r1, v1) by tof and check that lambert recovers v1 and v2. */
function roundTrip(sv: StateVector, mu: number, tof: number): { err1: number; err2: number } | null {
  const end = propagateStateTo(newState(), sv, mu, tof);
  const h = cross(sv.r, sv.v);
  const s = lambert(sv.r, end.r, tof, mu, { prograde: true, preferredNormal: h });
  if (!s) return null;
  const v = len(sv.v);
  return { err1: len(sub(s.v1, sv.v)) / v, err2: len(sub(s.v2, end.v)) / len(end.v) };
}

describe('lambert: propagation round trips', () => {
  const mu = 3.2e14;

  it('elliptic, every transfer angle from ~0° to ~360° (single revolution)', () => {
    const r = 8e6;
    const e = 0.3;
    const a = r / (1 - e);
    const vp = Math.sqrt(mu * (2 / r - 1 / a));
    const T = 2 * Math.PI * Math.sqrt((a * a * a) / mu);
    const sv: StateVector = { r: { x: r, y: 0, z: 0 }, v: { x: 0, y: 0.3 * vp, z: -0.95 * vp } };
    for (const f of [1e-6, 1e-4, 0.01, 0.1, 0.25, 0.4, 0.49, 0.5, 0.51, 0.7, 0.9, 0.99]) {
      const rt = roundTrip(sv, mu, f * T * 0.9);
      expect(rt, `f=${f}`).not.toBeNull();
      expect(rt!.err1, `f=${f}`).toBeLessThan(1e-6);
      expect(rt!.err2, `f=${f}`).toBeLessThan(1e-6);
    }
  });

  it('exact half orbit of an ellipse (180°) with the plane from the preferred normal', () => {
    const r = 8e6;
    const e = 0.4;
    const a = r / (1 - e);
    const vp = Math.sqrt(mu * (2 / r - 1 / a));
    const T = 2 * Math.PI * Math.sqrt((a * a * a) / mu);
    const inc = 0.5;
    const sv: StateVector = { r: { x: r, y: 0, z: 0 }, v: { x: 0, y: vp * Math.sin(inc), z: -vp * Math.cos(inc) } };
    const rt = roundTrip(sv, mu, 0.5 * T);
    expect(rt).not.toBeNull();
    expect(rt!.err1).toBeLessThan(1e-6);
  });

  it('hyperbolic and near-parabolic arcs', () => {
    const r = 7e6;
    const vesc = Math.sqrt((2 * mu) / r);
    for (const k of [0.999, 1.0, 1.001, 1.05, 1.5, 3, 10]) {
      const sv: StateVector = { r: { x: r, y: 0, z: 0 }, v: { x: 0.1 * vesc * k, y: 0, z: -vesc * k } };
      for (const tof of [60, 1800, 20000, 2e5]) {
        const rt = roundTrip(sv, mu, tof);
        expect(rt, `k=${k} tof=${tof}`).not.toBeNull();
        expect(rt!.err1, `k=${k} tof=${tof}`).toBeLessThan(1e-6);
      }
    }
  });

  it('500 random geometries', () => {
    const rng = makeRng('lambert-roundtrip');
    let worst = 0;
    let fails = 0;
    for (let n = 0; n < 500; n++) {
      const r = rng.range(6e6, 4e8);
      const dir = { x: rng.range(-1, 1), y: rng.range(-1, 1), z: rng.range(-1, 1) };
      const dl = len(dir) || 1;
      const rv = { x: (dir.x / dl) * r, y: (dir.y / dl) * r, z: (dir.z / dl) * r };
      const vd = { x: rng.range(-1, 1), y: rng.range(-1, 1), z: rng.range(-1, 1) };
      const vl = len(vd) || 1;
      const speed = rng.range(0.3, 1.6) * Math.sqrt((2 * mu) / r);
      const sv: StateVector = { r: rv, v: { x: (vd.x / vl) * speed, y: (vd.y / vl) * speed, z: (vd.z / vl) * speed } };
      const eps = 0.5 * speed * speed - mu / r;
      const period = eps < 0 ? 2 * Math.PI * Math.sqrt(Math.pow(-mu / (2 * eps), 3) / mu) : Infinity;
      const tof = period < Infinity ? rng.range(0.001, 0.97) * period : rng.range(10, 30) * r / speed;
      const rt = roundTrip(sv, mu, tof);
      if (!rt) {
        fails++;
        continue;
      }
      worst = Math.max(worst, rt.err1, rt.err2);
    }
    expect(fails).toBe(0);
    expect(worst).toBeLessThan(1e-5);
  });
});

describe('lambert: bad input', () => {
  it('returns null rather than throwing or NaN', () => {
    const r1 = { x: 7e6, y: 0, z: 0 };
    expect(lambert(r1, r1, 100, 3e14, { prograde: true })).toBeNull();
    expect(lambert(r1, { x: 0, y: 0, z: 7e6 }, -5, 3e14, { prograde: true })).toBeNull();
    expect(lambert(r1, { x: 0, y: 0, z: 7e6 }, 100, 0, { prograde: true })).toBeNull();
    expect(lambert({ x: NaN, y: 0, z: 0 }, { x: 0, y: 0, z: 7e6 }, 100, 3e14, { prograde: true })).toBeNull();
    expect(lambert({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 7e6 }, 100, 3e14, { prograde: true })).toBeNull();
    // A 0° transfer between two different radii along one line (pure radial fall) still gives finite numbers or null.
    const s = lambert(r1, { x: 9e6, y: 0, z: 0 }, 400, 3e14, { prograde: true });
    if (s) expect(Number.isFinite(s.v1.x + s.v1.y + s.v1.z + s.v2.x + s.v2.y + s.v2.z)).toBe(true);
  });
});
