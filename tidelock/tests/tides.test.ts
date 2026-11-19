// W2-E tides (src/world/tides.ts): the cabin's tidal acceleration, the exact Hill/CW flow for drifting bodies over
// an orbit, the drift correction with thrust, rest margins, save → load.
import { describe, expect, it } from 'vitest';
import type { V3 } from '../src/core/types';
import { REST_WAKE_A } from '../src/world/quasistatic';
import {
  createTideAnchor, createTideFrame, loadTideAnchor, saveTideAnchor, setTideAnchor, tidalAccel, tidalAccelBound, tidalFDot, tideDelta, tideFlow, tideFrame,
} from '../src/world/tides';

const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
// Wick, the start orbit: μ = 4.38e14 m³/s², a = 7090.5 km (SIMULATION.md W2-D tests)
const MU = 4.38e14, A = 7090.5e3, N2 = MU / (A * A * A), N = Math.sqrt(N2), T_ORB = (2 * Math.PI) / N;
// an orbit in the XZ plane, prograde (counter-clockwise seen from +Y: from +X toward −Z), so ĥ = +Y
const H = v3(0, 1, 0);
const rhatAt = (t: number): V3 => v3(Math.cos(N * t), 0, -Math.sin(N * t));

/** RK4 of p̈ = −a_s + n²(3r̂(t)r̂(t)ᵀ − I)p in inertial axes. */
function rk4(x0: V3, v0: V3, t1: number, h: number, aS: V3 = v3()): [V3, V3] {
  let s = [x0.x, x0.y, x0.z, v0.x, v0.y, v0.z], t = 0;
  const f = (tt: number, y: number[]): number[] => {
    const r = rhatAt(tt), d = 3 * (r.x * y[0] + r.y * y[1] + r.z * y[2]);
    return [y[3], y[4], y[5], N2 * (d * r.x - y[0]) - aS.x, N2 * (d * r.y - y[1]) - aS.y, N2 * (d * r.z - y[2]) - aS.z];
  };
  const n = Math.round(t1 / h);
  for (let i = 0; i < n; i++) {
    const k1 = f(t, s), k2 = f(t + h / 2, s.map((y, j) => y + (h / 2) * k1[j])), k3 = f(t + h / 2, s.map((y, j) => y + (h / 2) * k2[j]));
    const k4 = f(t + h, s.map((y, j) => y + h * k3[j]));
    s = s.map((y, j) => y + (h / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
    t += h;
  }
  return [v3(s[0], s[1], s[2]), v3(s[3], s[4], s[5])];
}

describe('tidal acceleration in the cabin', () => {
  it('is 2n²p along the vertical and −n²p across it (n² = 1.23e-6 s⁻² at Wick)', () => {
    expect(N2).toBeCloseTo(1.2287e-6, 9);
    const r = v3(0, 1, 0), a = v3();
    tidalAccel(N2, r, v3(0, 5, 0), a);
    expect(a.y).toBeCloseTo(2 * N2 * 5, 15);
    tidalAccel(N2, r, v3(5, 0, 0), a);
    expect(a.x).toBeCloseTo(-N2 * 5, 15);
    expect(a.y).toBe(0);
  });

  it('never wakes a resting body: |a| ≤ 2n²R stays inside REST_WAKE_A across a 15 m cabin', () => {
    expect(tidalAccelBound(N2, 15)).toBeLessThan(REST_WAKE_A);
    // and the rate bound used to schedule re-checks is tiny: at 0.1 rad/s of ship turn
    expect(tidalFDot(N2, 0.1, N, 15, 1)).toBeLessThan(1e-5);
  });

  it('tideFrame gives n² = μ/r³, the local vertical and the orbit normal', () => {
    const f = tideFrame(v3(A, 0, 0), v3(0, 0, -Math.sqrt(MU / A)), MU, createTideFrame());
    expect(f.n2).toBeCloseTo(N2, 15);
    expect(f.thetaDot).toBeCloseTo(N, 12);
    expect(f.h.y).toBeCloseTo(1, 12);
    expect(f.dn2dt).toBeCloseTo(0, 20);
  });
});

describe('exact Hill/Clohessy–Wiltshire flow', () => {
  it('matches a fine RK4 of the inertial ODE with the turning vertical over a whole orbit (94.5 min)', () => {
    const ta = createTideAnchor();
    setTideAnchor(ta, N2, rhatAt(0), H);
    const x0 = v3(5, 0.3, -2), v0 = v3(1e-3, -2e-3, 5e-4), x = v3(), v = v3();
    tideFlow(ta, x0, v0, T_ORB, x, v);
    const [xr, vr] = rk4(x0, v0, T_ORB, T_ORB / 20000);
    expect(T_ORB / 60).toBeCloseTo(94.5, 1);
    expect(Math.hypot(x.x - xr.x, x.y - xr.y, x.z - xr.z)).toBeLessThan(1e-7);
    expect(Math.hypot(v.x - vr.x, v.y - vr.y, v.z - vr.z)).toBeLessThan(1e-10);
  });

  it('a chain of 5 s drift segments, each re-anchored at the then-current vertical, reproduces the one-shot orbit', () => {
    const ta = createTideAnchor();
    let x = v3(5, 0, 0), v = v3(0, 0, 0);
    const xn = v3(), vn = v3(), seg = 5, n = Math.round(T_ORB / seg);
    for (let i = 0; i < n; i++) {
      setTideAnchor(ta, N2, rhatAt(i * seg), H);
      tideFlow(ta, x, v, seg, xn, vn);
      x = { ...xn }; v = { ...vn };
    }
    setTideAnchor(ta, N2, rhatAt(0), H);
    const xo = v3(), vo = v3();
    tideFlow(ta, v3(5, 0, 0), v3(), n * seg, xo, vo);
    const [xr] = rk4(v3(5, 0, 0), v3(), n * seg, (n * seg) / 20000);
    const err = Math.hypot(x.x - xo.x, x.y - xo.y, x.z - xo.z), errR = Math.hypot(x.x - xr.x, x.y - xr.y, x.z - xr.z);
    console.log(`[tides] chained ${n}×5 s vs one-shot CW over an orbit: ${err.toExponential(2)} m; vs RK4 ${errR.toExponential(2)} m; |x| = ${Math.hypot(x.x, x.y, x.z).toFixed(2)} m`);
    expect(err).toBeLessThan(1e-9);
    expect(errR).toBeLessThan(1e-7);
  });

  it('the plan case: released 5 m out along the vertical (times to reach 6 m, reported)', () => {
    const ta = createTideAnchor();
    setTideAnchor(ta, N2, rhatAt(0), H);
    const x = v3(), v = v3();
    const reach = (x0: V3, v0: V3, radialOnly: boolean): number => {
      let lo = 0, hi = 2000;
      for (let k = 0; k < 60; k++) {
        const m = 0.5 * (lo + hi);
        tideFlow(ta, x0, v0, m, x, v);
        // radial = along the vertical at that time (the LVLH frame turns with the orbit)
        const r = rhatAt(m), d = radialOnly ? x.x * r.x + x.y * r.y + x.z * r.z : Math.hypot(x.x, x.y, x.z);
        if (d < 6) lo = m; else hi = m;
      }
      return lo;
    };
    // a ship held in LVLH (turning at n): the body at rest in the ship frame has inertial velocity Ω × p
    const lvlh = reach(v3(5, 0, 0), v3(0, 0, -N * 5), true);
    expect(lvlh).toBeCloseTo(Math.acos(14 / 15) / N, 3); // x = (4 − 3 cos nt)·x₀ exactly
    // an inertially fixed ship: the body at rest in inertial space; distance from the CoM
    const fixed = reach(v3(5, 0, 0), v3(), false);
    // the frozen-vertical idealisation p̈ = 2n²p: x₀·cosh(√2 n t)
    const frozen = Math.acosh(1.2) / (Math.SQRT2 * N);
    console.log(`[tides] 5 m → 6 m: LVLH hold ${lvlh.toFixed(1)} s; inertial ship ${fixed.toFixed(1)} s; frozen vertical ${frozen.toFixed(1)} s; plan text ${(Math.acosh(1.2) / (Math.sqrt(3) * N)).toFixed(1)} s`);
    expect(fixed).toBeGreaterThan(300);
    expect(fixed).toBeLessThan(500);
  });

  it('tideDelta added to the drift closed form matches RK4 under thrust over a 5 s segment', () => {
    const ta = createTideAnchor();
    setTideAnchor(ta, N2, rhatAt(0), H);
    const x0 = v3(5, 1, -3), v0 = v3(0.2, -0.1, 0.05), aS = v3(0.5, 0, -9.8), t = 5;
    // quasistatic.ts' closed form without drag: x₀ + v₀t − ½a_s t²
    const x = v3(x0.x + v0.x * t - 0.5 * aS.x * t * t, x0.y + v0.y * t - 0.5 * aS.y * t * t, x0.z + v0.z * t - 0.5 * aS.z * t * t);
    const v = v3(v0.x - aS.x * t, v0.y - aS.y * t, v0.z - aS.z * t);
    tideDelta(ta, x0, v0, aS, t, x, v);
    const [xr, vr] = rk4(x0, v0, t, t / 2000, aS);
    const ex = Math.hypot(x.x - xr.x, x.y - xr.y, x.z - xr.z), ev = Math.hypot(v.x - vr.x, v.y - vr.y, v.z - vr.z);
    console.log(`[tides] 5 s segment at |a_s| = 9.8 m/s²: error ${ex.toExponential(2)} m, ${ev.toExponential(2)} m/s`);
    expect(ex).toBeLessThan(5e-8);
    expect(ev).toBeLessThan(5e-8);
    // and coasting it is the exact flow
    const xc = v3(x0.x + v0.x * t, x0.y + v0.y * t, x0.z + v0.z * t), vc = { ...v0 }, xe = v3(), ve = v3();
    tideDelta(ta, x0, v0, v3(), t, xc, vc);
    tideFlow(ta, x0, v0, t, xe, ve);
    expect(Math.hypot(xc.x - xe.x, xc.y - xe.y, xc.z - xe.z)).toBeLessThan(1e-14);
  });

  it('no tide (n = 0) is free flight, bit for bit', () => {
    const ta = createTideAnchor(), x = v3(), v = v3();
    tideFlow(ta, v3(1, 2, 3), v3(0.1, 0.2, 0.3), 7, x, v);
    expect(x).toEqual(v3(1 + 0.1 * 7, 2 + 0.2 * 7, 3 + 0.3 * 7));
  });
});

describe('save / load', () => {
  it('a saved anchor evaluates bit-identically; junk loads as no tide', () => {
    const ta = createTideAnchor();
    setTideAnchor(ta, N2, rhatAt(123), v3(0.01, 1, 0));
    const tb = loadTideAnchor(JSON.parse(JSON.stringify(saveTideAnchor(ta))));
    const a = v3(), av = v3(), b = v3(), bv = v3();
    tideFlow(ta, v3(4, -1, 2), v3(1e-3, 0, 0), 4.2, a, av);
    tideFlow(tb, v3(4, -1, 2), v3(1e-3, 0, 0), 4.2, b, bv);
    expect(b).toEqual(a); expect(bv).toEqual(av);
    expect(loadTideAnchor(undefined).n).toBe(0);
    expect(loadTideAnchor({ n: 'x' }).n).toBe(0);
  });
});
