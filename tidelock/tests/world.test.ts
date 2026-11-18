// The physical world, stages 1–2: initial conditions and the n-body ephemeris.
import { describe, expect, it } from 'vitest';
import { G } from '../src/core/units';
import { qRotate } from '../src/core/vec';
import { elementsToState } from '../src/sim/orbit';
import { generateGalaxy, getSystem } from '../src/sim/universe';
import { advance, bodyInvariants, bodyOrientation, createWorld, Ephemeris, ephemerisOf, yoshidaStep } from '../src/world';

const system = getSystem(generateGalaxy(1), 'tallow')!;

describe('world setup', () => {
  it('turns the Kepler hierarchy into a barycentric n-body state', () => {
    const w = createWorld(system);
    expect(w.bodies.length).toBe(system.bodies.length);
    let M = 0;
    const c = [0, 0, 0], p = [0, 0, 0];
    for (const b of w.bodies) {
      M += b.mass;
      c[0] += b.mass * b.r.x; c[1] += b.mass * b.r.y; c[2] += b.mass * b.r.z;
      p[0] += b.mass * b.v.x; p[1] += b.mass * b.v.y; p[2] += b.mass * b.v.z;
    }
    expect(Math.hypot(c[0], c[1], c[2]) / M).toBeLessThan(1);
    expect(Math.hypot(p[0], p[1], p[2]) / M).toBeLessThan(1e-9);
    let tMin = Infinity;
    for (const d of system.bodies) if (d.orbit) tMin = Math.min(tMin, 2 * Math.PI * Math.sqrt(d.orbit.a ** 3 / (d.mu + system.bodies.find((x) => x.id === d.parentId)!.mu)));
    expect(w.h).toBeLessThanOrEqual(tMin / 200);
    expect(w.h).toBeGreaterThan(100);
    const stations = w.craft.filter((s) => s.kind === 'station');
    expect(stations.length).toBe(system.stations.length);
    for (const s of stations) {
      const up = qRotate(s.q, { x: 0, y: 1, z: 0 });
      const n = { x: s.rel.y * s.relV.z - s.rel.z * s.relV.y, y: s.rel.z * s.relV.x - s.rel.x * s.relV.z, z: s.rel.x * s.relV.y - s.rel.y * s.relV.x };
      const nl = Math.hypot(n.x, n.y, n.z);
      expect((up.x * n.x + up.y * n.y + up.z * n.z) / nl).toBeGreaterThan(1 - 1e-9);
      expect(Math.hypot(s.w.x, s.w.y, s.w.z)).toBe(0);
      expect(s.dryMass).toBe(1e9);
      expect(s.ports.length).toBeGreaterThan(0);
      expect(s.colliders.length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(JSON.parse(JSON.stringify(w)))).toBe(JSON.stringify(w));
    expect(JSON.stringify(w).length).toBeLessThan(100_000);
  });

  it('keeps a tidally locked world facing its star', () => {
    const w = createWorld(system, { stations: false });
    const wick = w.bodies.find((b) => b.id === 'tallow.wick')!, star = w.bodies[0];
    for (let d = 0; d < 4; d++) {
      const x = qRotate(bodyOrientation(wick), { x: 1, y: 0, z: 0 });
      const s = { x: star.r.x - wick.r.x, y: star.r.y - wick.r.y, z: star.r.z - wick.r.z };
      expect((x.x * s.x + x.y * s.y + x.z * s.z) / Math.hypot(s.x, s.y, s.z)).toBeGreaterThan(0.9995);
      advance(w, 9 * 86400);
    }
  });
});

describe('ephemeris', () => {
  it('two bodies follow the analytic Kepler orbit', () => {
    const mu = [4.777e19, 4.384e14], muT = mu[0] + mu[1];
    const el = { a: 2.3e10, e: 0.2, i: 0.1, lan: 0.3, argp: 0.5, m0: 0.4, epoch: 0 };
    const sv = elementsToState(el, muT, 0);
    const f1 = -mu[1] / muT, f2 = mu[0] / muT;
    const state = [sv.r.x * f1, sv.r.y * f1, sv.r.z * f1, sv.r.x * f2, sv.r.y * f2, sv.r.z * f2, sv.v.x * f1, sv.v.y * f1, sv.v.z * f1, sv.v.x * f2, sv.v.y * f2, sv.v.z * f2];
    const T = 2 * Math.PI * Math.sqrt(el.a ** 3 / muT), h = Math.floor(T / 200);
    const eph = new Ephemeris(mu, h, 0, state, 1024);
    const out = new Float64Array(6);
    let maxErr = 0;
    for (let k = 1; k <= 300; k++) {
      const t = (k * 3 * T) / 300 + 0.37 * h;
      expect(eph.ensure(t)).toBe(t);
      eph.relPositions(t, 0, out);
      const ref = elementsToState(el, muT, t).r;
      maxErr = Math.max(maxErr, Math.hypot(out[3] - ref.x, out[4] - ref.y, out[5] - ref.z));
    }
    console.log(`two-body: max error over 3 orbits = ${maxErr.toFixed(0)} m (${(maxErr / el.a).toExponential(2)} a)`);
    expect(maxErr / el.a).toBeLessThan(1e-4);
  });

  it('conserves energy and angular momentum over 2 years and keeps every planet and moon in its orbit', () => {
    const w = createWorld(system, { stations: false });
    const n = w.bodies.length, mu = w.bodies.map((b) => b.mu);
    const s = Float64Array.from(w.ephState), acc = new Float64Array(3 * n), inv = new Float64Array(4);
    bodyInvariants(n, mu, s, 0, G, inv);
    const e0 = inv[0], l0 = [inv[1], inv[2], inv[3]], lm = Math.hypot(l0[0], l0[1], l0[2]);
    const axis = (i: number): number => {
      const p = w.bodies[i].parent, m = mu[i] + mu[p];
      const r = Math.hypot(s[3 * i] - s[3 * p], s[3 * i + 1] - s[3 * p + 1], s[3 * i + 2] - s[3 * p + 2]);
      const v2 = (s[3 * n + 3 * i] - s[3 * n + 3 * p]) ** 2 + (s[3 * n + 3 * i + 1] - s[3 * n + 3 * p + 1]) ** 2 + (s[3 * n + 3 * i + 2] - s[3 * n + 3 * p + 2]) ** 2;
      return 1 / (2 / r - v2 / m);
    };
    const year = 365.25 * 86400, steps = Math.ceil((2 * year) / w.h), yearStep = Math.round(year / w.h);
    let dE = 0, dL = 0, dA = 0;
    for (let k = 1; k <= steps; k++) {
      yoshidaStep(n, mu, s, 0, acc, w.h);
      if (k % 400 === 0 || k === steps) {
        bodyInvariants(n, mu, s, 0, G, inv);
        dE = Math.max(dE, Math.abs((inv[0] - e0) / e0));
        dL = Math.max(dL, Math.hypot(inv[1] - l0[0], inv[2] - l0[1], inv[3] - l0[2]) / lm);
      }
      if (k === yearStep || k === steps) {
        for (let i = 1; i < n; i++) {
          const a = axis(i), a0 = system.bodies[i].orbit!.a;
          expect(a).toBeGreaterThan(0);
          dA = Math.max(dA, Math.abs(a / a0 - 1));
        }
      }
    }
    console.log(`n-body 2 y: |dE/E| ≤ ${dE.toExponential(2)}, |dL/L| ≤ ${dL.toExponential(2)}, semi-major axes within ${(100 * dA).toFixed(3)} %`);
    expect(dE).toBeLessThan(1e-7);
    expect(dL).toBeLessThan(1e-10);
    expect(dA).toBeLessThan(0.02);
  });

  it('interpolates between nodes to metres and reproduces the direct integration', () => {
    const w = createWorld(system, { stations: false });
    const eph = ephemerisOf(w), n = w.bodies.length, mu = w.bodies.map((b) => b.mu);
    const s = Float64Array.from(w.ephState), acc = new Float64Array(3 * n);
    for (let k = 0; k < 40; k++) yoshidaStep(n, mu, s, 0, acc, w.h);
    const out = new Float64Array(6);
    eph.ensure(41 * w.h);
    let err = 0;
    for (let i = 0; i < n; i++) {
      eph.state(40 * w.h, i, out);
      for (let c = 0; c < 3; c++) { expect(out[c]).toBe(s[3 * i + c]); expect(Math.abs(out[3 + c] - s[3 * n + 3 * i + c])).toBeLessThan(1e-6); }
    }
    yoshidaStep(n, mu, s, 0, acc, w.h / 2);
    for (let i = 0; i < n; i++) {
      eph.state(40.5 * w.h, i, out);
      err = Math.max(err, Math.hypot(out[0] - s[3 * i], out[1] - s[3 * i + 1], out[2] - s[3 * i + 2]));
    }
    console.log(`ephemeris: mid-step interpolation error ≤ ${err.toFixed(3)} m (H = ${w.h} s)`);
    expect(err).toBeLessThan(20);
  });
});
