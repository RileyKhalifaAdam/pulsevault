// W3-C relative navigation: CW transition, closed-form covariance growth, filter consistency (NEES), save/load.
import { describe, expect, it } from 'vitest';
import { makeRng } from '../src/core/rng';
import {
  cwPhi, cwProcessNoise, loadNav, makeNav, navCovAt, navCovPeek, navInertialAt, navInit, navProcessNoise, navPropagate, navUpdateBearing,
  navUpdateRange, navUpdateRangeRate, saveNav, type NavState,
} from '../src/world/relnav';

const N = 1.109e-3; // the Wheel's orbit
const MU = 4.385e14;
const A = Math.cbrt(MU / (N * N));

/** Reference ∫₀^Δ Φ_v Φ_vᵀ du by composite Simpson over cwPhi (independent of the closed form). */
function qdReference(n: number, dt: number, q: number, steps = 4000): Float64Array {
  const out = new Float64Array(36), F = new Float64Array(36), h = dt / steps;
  for (let k = 0; k <= steps; k++) {
    const w = (k === 0 || k === steps ? 1 : k % 2 ? 4 : 2) * h / 3;
    cwPhi(n, k * h, F);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
      let s = 0;
      for (let c = 3; c < 6; c++) s += F[i * 6 + c] * F[j * 6 + c];
      out[i * 6 + j] += w * q * s;
    }
  }
  return out;
}
const relErr = (a: Float64Array, b: Float64Array): number => {
  let num = 0, den = 0;
  for (let i = 0; i < 36; i++) { num = Math.max(num, Math.abs(a[i] - b[i]) / Math.sqrt(Math.abs(b[(i / 6 | 0) * 7]) * Math.abs(b[(i % 6) * 7]) + 1e-300)); den = 1; }
  return num / den;
};

/** Hill frame (same formulas as relnav) for building truth in inertial axes. */
function frame(nav: NavState, t: number): number[] {
  const th = nav.n * (t - nav.tRef), c = Math.cos(th), s = Math.sin(th), X = nav.X0, Y = nav.Y0, Z = nav.Z;
  return [c * X[0] + s * Y[0], c * X[1] + s * Y[1], c * X[2] + s * Y[2], -s * X[0] + c * Y[0], -s * X[1] + c * Y[1], -s * X[2] + c * Y[2], Z[0], Z[1], Z[2]];
}
function hillToI(nav: NavState, t: number, h: ArrayLike<number>): number[] {
  const R = frame(nav, t), n = nav.n;
  const vx = h[3] - n * h[1], vy = h[4] + n * h[0], vz = h[5];
  return [
    R[0] * h[0] + R[3] * h[1] + R[6] * h[2], R[1] * h[0] + R[4] * h[1] + R[7] * h[2], R[2] * h[0] + R[5] * h[1] + R[8] * h[2],
    R[0] * vx + R[3] * vy + R[6] * vz, R[1] * vx + R[4] * vy + R[7] * vz, R[2] * vx + R[5] * vy + R[8] * vz,
  ];
}
/** Cholesky of a 6×6 SPD matrix (lower, row-major); null if not PD. */
function chol(P: ArrayLike<number>): Float64Array | null {
  const L = new Float64Array(36);
  for (let i = 0; i < 6; i++) for (let j = 0; j <= i; j++) {
    let s = P[i * 6 + j];
    for (let k = 0; k < j; k++) s -= L[i * 6 + k] * L[j * 6 + k];
    if (i === j) { if (!(s > 0)) return null; L[i * 7] = Math.sqrt(s); } else L[i * 6 + j] = s / L[j * 7];
  }
  return L;
}
/** eᵀ P⁻¹ e via Cholesky. */
function nees(e: ArrayLike<number>, P: ArrayLike<number>): number {
  const L = chol(P)!;
  const y = new Float64Array(6);
  for (let i = 0; i < 6; i++) { let s = e[i]; for (let k = 0; k < i; k++) s -= L[i * 6 + k] * y[k]; y[i] = s / L[i * 7]; }
  let r = 0;
  for (let i = 0; i < 6; i++) r += y[i] * y[i];
  return r;
}

describe('CW propagation and closed-form covariance', () => {
  it('Qd closed form (and its small-angle quadrature) matches an independent integral at every span', () => {
    const Q = new Float64Array(36);
    let worst = 0;
    for (const dt of [0.01, 0.1, 10, 44, 45.5, 300, 2000, 9000]) {
      cwProcessNoise(N, dt, 1e-6, Q);
      const ref = qdReference(N, dt, 1e-6);
      const e = relErr(Q, ref);
      worst = Math.max(worst, e);
      expect(e).toBeLessThan(1e-9);
    }
    // The double integrator in the limit n → 0: Qd00 = qΔ³/3, Qd03 = qΔ²/2, Qd33 = qΔ.
    cwProcessNoise(1e-9, 10, 2, Q);
    expect(Q[0]).toBeCloseTo((2 * 1000) / 3, 6);
    expect(Q[3]).toBeCloseTo(100, 6);
    expect(Q[21]).toBeCloseTo(20, 9);
    console.log(`Qd closed form vs Simpson reference: worst correlation-normalised error ${worst.toExponential(2)}`);
  });

  it('covariance growth: one closed-form step equals many small steps and the Monte-Carlo spread of the SDE', () => {
    const mk = (): NavState => {
      const nav = makeNav();
      const PI = new Float64Array(36);
      for (let i = 0; i < 6; i++) PI[i * 7] = i < 3 ? 4 : 0.01;
      navInit(nav, 0, [1000, -200, 50, 0.1, 0.2, -0.1], PI, { x: A, y: 0, z: 0 }, { x: 0, y: 0, z: -Math.sqrt(MU / A) }, MU, 0);
      return nav;
    };
    const big = mk(), small = mk();
    // (navCovAt evaluates q from the state, which is not propagated here: both runs use the same q)
    navCovAt(big, 600);
    for (let k = 1; k <= 6000; k++) navCovAt(small, k * 0.1);
    let e = 0;
    for (let i = 0; i < 36; i++) e = Math.max(e, Math.abs(big.P[i] - small.P[i]) / Math.sqrt(big.P[(i / 6 | 0) * 7] * big.P[(i % 6) * 7]));
    expect(e).toBeLessThan(1e-9);
    // Monte Carlo: Euler–Maruyama on ẍ = 3n²x + 2nẏ + w, ÿ = −2nẋ + w, z̈ = −n²z + w with the same PSD q.
    const q = 3e-6;
    const T = 600, h = 0.05, runs = 3000, rng = makeRng(7);
    const s = new Float64Array(36), m = new Float64Array(6);
    for (let r = 0; r < runs; r++) {
      let x = 0, y = 0, z = 0, u = 0, v = 0, w = 0; // start from zero error, no initial covariance
      const sq = Math.sqrt(q * h);
      for (let k = 0; k < T / h; k++) {
        const ax = 3 * N * N * x + 2 * N * v, ay = -2 * N * u, az = -N * N * z;
        x += h * u; y += h * v; z += h * w;
        u += h * ax + sq * rng.gauss(); v += h * ay + sq * rng.gauss(); w += h * az + sq * rng.gauss();
      }
      const st = [x, y, z, u, v, w];
      for (let i = 0; i < 6; i++) { m[i] += st[i]; for (let j = 0; j < 6; j++) s[i * 6 + j] += st[i] * st[j]; }
    }
    const Qd = cwProcessNoise(N, T, q, new Float64Array(36));
    for (const i of [0, 7, 14, 21, 28, 35, 3, 1, 10]) {
      const mc = s[i] / runs;
      const ref = Qd[i], scale = Math.sqrt(Qd[(i / 6 | 0) * 7] * Qd[(i % 6) * 7]);
      expect(Math.abs(mc - ref) / scale).toBeLessThan(0.08); // 3000 runs: ~2.6% statistical 1σ on a variance
    }
    console.log(`covariance growth over 600 s: 1 step vs 6000 steps ${e.toExponential(2)}; Qd00 ${Qd[0].toFixed(3)} m² vs MC ${(s[0] / runs).toFixed(3)} m²`);
  });
});

describe('filter consistency', () => {
  it('NEES is inside the 95% band over 1000 seeded runs (radar at 5 km, then a 60 s gap, then lidar-grade fixes)', () => {
    const runs = 1000;
    const checks = [10, 60, 120, 125, 180];
    const sums = new Float64Array(checks.length);
    const Q = new Float64Array(36), F = new Float64Array(36), Pc = new Float64Array(36);
    for (let r = 0; r < runs; r++) {
      const rng = makeRng(1000 + r);
      const nav = makeNav();
      // truth in the nav's Hill frame, built after init
      const PI = new Float64Array(36);
      const sp = [30, 30, 30, 1, 1, 1];
      for (let i = 0; i < 6; i++) PI[i * 7] = sp[i] * sp[i];
      const est0 = [4000, -3000, 100, -2, 1.5, 0.1];
      navInit(nav, 0, est0, PI, { x: A, y: 0, z: 0 }, { x: 0, y: 0, z: -Math.sqrt(MU / A) }, MU, 0);
      // Truth: estimate + a draw from P (Hill), so the initial error is consistent with P by construction.
      const L = chol(nav.P)!;
      const g = Array.from({ length: 6 }, () => rng.gauss());
      const tr = new Float64Array(6);
      for (let i = 0; i < 6; i++) { let s = nav.x[i]; for (let k = 0; k <= i; k++) s += L[i * 6 + k] * g[k]; tr[i] = s; }
      let t = 0, ci = 0;
      const dt = 0.1;
      while (ci < checks.length) {
        // truth step: Φ x + draw from Qd (exact discrete process)
        cwPhi(nav.n, dt, F);
        cwProcessNoise(nav.n, dt, navProcessNoise(nav), Q); // the PSD the filter assumes
        const LQ = chol(Q)!;
        const w = Array.from({ length: 6 }, () => rng.gauss());
        const nx = new Float64Array(6);
        for (let i = 0; i < 6; i++) {
          let s = 0;
          for (let k = 0; k < 6; k++) s += F[i * 6 + k] * tr[k];
          for (let k = 0; k <= i; k++) s += LQ[i * 6 + k] * w[k];
          nx[i] = s;
        }
        tr.set(nx);
        t = Math.round((t + dt) * 10) / 10;
        navPropagate(nav, t, 0, 0, 0);
        const gap = t > 60 && t <= 120;
        if (!gap) {
          const I = hillToI(nav, t, tr), rr = Math.hypot(I[0], I[1], I[2]);
          const ux = I[0] / rr, uy = I[1] / rr, uz = I[2] / rr;
          const lidar = t > 120;
          const sr = lidar ? 0.02 : Math.max(0.5, 1e-3 * rr), sa = lidar ? 0.02 * Math.PI / 180 : 0.1 * Math.PI / 180;
          navUpdateRange(nav, t, 0, 0, 0, rr + sr * rng.gauss(), sr);
          if (!lidar) navUpdateRangeRate(nav, t, 0, 0, 0, 0, 0, 0, (ux * I[3] + uy * I[4] + uz * I[5]) + 0.02 * rng.gauss(), 0.02);
          // tipped line of sight
          const ax = Math.abs(ux) <= Math.abs(uy) && Math.abs(ux) <= Math.abs(uz) ? [1, 0, 0] : Math.abs(uy) <= Math.abs(uz) ? [0, 1, 0] : [0, 0, 1];
          let p1 = [uy * ax[2] - uz * ax[1], uz * ax[0] - ux * ax[2], ux * ax[1] - uy * ax[0]];
          const l1 = Math.hypot(...p1); p1 = p1.map((c) => c / l1);
          const p2 = [uy * p1[2] - uz * p1[1], uz * p1[0] - ux * p1[2], ux * p1[1] - uy * p1[0]];
          const g1 = sa * rng.gauss(), g2 = sa * rng.gauss();
          const m = [ux + g1 * p1[0] + g2 * p2[0], uy + g1 * p1[1] + g2 * p2[1], uz + g1 * p1[2] + g2 * p2[2]];
          const ml = Math.hypot(...m);
          navUpdateBearing(nav, t, 0, 0, 0, m[0] / ml, m[1] / ml, m[2] / ml, sa);
        }
        if (Math.abs(t - checks[ci]) < 1e-9) {
          navCovPeek(nav, t, Pc);
          const e = new Float64Array(6);
          for (let i = 0; i < 6; i++) e[i] = tr[i] - nav.x[i];
          sums[ci] += nees(e, Pc);
          ci++;
        }
      }
    }
    // Mean NEES of 1000 runs of a 6-dof χ²: 95% band 6 ± 1.96·√(12/1000) = [5.79, 6.21].
    const means = Array.from(sums, (s) => s / runs);
    console.log(`NEES means at ${checks.join(', ')} s: ${means.map((m) => m.toFixed(3)).join(', ')} (95% band 5.79–6.21)`);
    for (const m of means) { expect(m).toBeGreaterThan(5.79); expect(m).toBeLessThan(6.21); }
  });

  it('save → load → step is bit-identical', () => {
    const nav = makeNav();
    const PI = new Float64Array(36);
    for (let i = 0; i < 6; i++) PI[i * 7] = i < 3 ? 100 : 1;
    navInit(nav, 5, [2000, 100, -30, -1, 0.1, 0], PI, { x: A, y: 0, z: 0 }, { x: 0, y: 0, z: -Math.sqrt(MU / A) }, MU, 120);
    const run = (n: NavState, from: number, to: number): void => {
      for (let k = from; k < to; k++) {
        const t = 5 + k / 120;
        navPropagate(n, t, k % 7 === 0 ? 1e-3 : 0, 0, k % 11 === 0 ? -2e-3 : 0);
        if (k % 12 === 0) { navUpdateRange(n, t, 1, 2, 0, 2000 - k * 0.008, 0.5); navUpdateBearing(n, t, 1, 2, 0, 0.998, 0.05, -0.015, 0.0017); }
      }
    };
    run(nav, 1, 600);
    const json = JSON.stringify(saveNav(nav));
    const b = loadNav(JSON.parse(json));
    run(nav, 600, 1200);
    run(b, 600, 1200);
    expect(JSON.stringify(saveNav(b))).toBe(JSON.stringify(saveNav(nav)));
    const o1 = new Float64Array(6), o2 = new Float64Array(6);
    navInertialAt(nav, 20, o1); navInertialAt(b, 20, o2);
    expect(Array.from(o2)).toEqual(Array.from(o1));
    expect(loadNav(undefined).valid).toBe(false);
    expect(loadNav([1, 2, 3]).valid).toBe(false);
  });
});
