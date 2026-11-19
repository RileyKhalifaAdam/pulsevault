// Relative navigation (docs/SIMULATION.md W3-C item 3): a 6-state extended Kalman filter for the relative position
// and velocity of a rendezvous target's tracked point, propagated with the Clohessy–Wiltshire transition matrix.
//
// Frame. The state lives in the Hill frame of an ANALYTIC circular reference orbit (radius a, rate n = √(μ/a³),
// basis X0, Y0, Z at tRef), set when the track starts through the estimated target position and re-anchored when the
// target drifts more than REANCHOR_DIST from it. x̂ = radial out, ŷ = along-track, ẑ = orbit normal; the frame turns at
// +n about ẑ. Because CW is linear, the DIFFERENCE target − ship of two craft both near the reference obeys CW exactly
// to first order, wherever on the reference they are: no truth is needed to build the frame. State
//   x = [ρ, ρ̇]  with ρ = r_target_point − r_ship (m), ρ̇ its rate as seen in the rotating Hill frame (m/s).
// Inertial: ρ_I = R ρ_H, ρ̇_I = R (ρ̇_H + ω × ρ_H), ω = n ẑ.
//
// Propagation is exact for any span (unconditionally valid under warp, §1.3 "covariance propagated in closed form"):
//   x(t+Δ) = Φ(Δ) x(t) + Φ(Δ/2)·[0; −Δv_H]      (the ship's own proper Δv over the span, applied at mid-span)
//   P(t+Δ) = Φ P Φᵀ + Qd(Δ),   Qd = q ∫₀^Δ Φ_v(u) Φ_v(u)ᵀ du      (white acceleration noise, PSD q per axis)
// Qd is the closed-form integral for nΔ ≥ 0.05 and a 4-point Gauss–Legendre quadrature of the same (analytic,
// smooth) integrand below that, where the closed form loses digits to cancellation (agreement < 1e-12 at the seam).
// P is propagated lazily: x is advanced every tick (cheap, with the ledger's Δv), P only when a measurement or a
// read-out needs it (the input does not enter P, so deferring is exact: Φ(a+b) = Φ(a)Φ(b), Qd composes).
//
// Process noise q (m²/s³) covers what CW leaves out: the nonlinear term ≈ 3n²ρ²/a, the gravity gradient on the tracked
// point's lever arm 3n²|L| (a port is a body-fixed point, not a free particle) and a floor (differential drag, solar
// pressure): a_u = A_FLOOR + 3n²(|L| + ρ²/a),  q = 2·a_u²·TAU_U (a first-order Gauss–Markov bias seen as white).
//
// Updates are sequential scalar updates (uncorrelated noise): range, range-rate, two bearings per line of sight,
// each with a χ² gate. Symmetric form P −= PHᵀ(PHᵀ)ᵀ/S, upper triangle computed and mirrored (P stays exactly
// symmetric, so saving 21 numbers reproduces it bit for bit).
//
// WIRING (wave 3, W3-C; used only through sensors.ts, which owns a NavState per tracked target):
// - session tick (120 Hz, after consumeLedger): navPropagate(S.nav, t, Δv_I) with Δv_I = q·fAcc/m of the tick (the
//   proper Δv the ship actually received: §1.4 fAcc/accT, impulses dvImpulse added); under warp once per quantum.
// - sensors.ts sensorsStep (10 Hz on the tick grid, once per frame under warp) calls navCovAt / navUpdate* / navInit.
// - Reads (ship): rel, relV, primary μ (own-ship state is not estimated, §3). Writes: nothing outside the NavState.
// - Save: saveNav / loadNav (inside saveSensors). Budget: propagate ≈ 0.1 µs, one measurement cycle ≈ 2–3 µs (node).

import type { V3 } from '../core/types';

const msqrt = (x: number): number => Math.sqrt(x);
const msin = (x: number): number => Math.sin(x);
const mcos = (x: number): number => Math.cos(x);

/** Re-anchor the reference orbit when the estimated target point is this far from the reference point, m. */
export const REANCHOR_DIST = 5000;
/** Unmodelled-acceleration floor (m/s²) and its correlation time (s). */
export const A_FLOOR = 2e-5;
export const TAU_U = 30;
/** χ² gate for one scalar innovation (5σ). */
export const GATE2 = 25;
/** Smallest reference rate the formulas accept, rad/s (a heliocentric orbit is ~2e-7). */
const N_MIN = 1e-12;
/** Below this nΔ the Qd integral is taken by quadrature. */
const QD_SERIES = 0.05;

export interface NavState {
  /** False until the first measurement initialises the track. */
  valid: boolean;
  /** Time of x, s. */
  t: number;
  /** Time P is valid at (≤ t), s. */
  tP: number;
  /** Hill-frame state at t: ρ (3), ρ̇ (3). */
  x: Float64Array;
  /** Covariance in Hill coordinates at tP, 6×6 row-major, exactly symmetric. */
  P: Float64Array;
  /** Reference circular orbit: basis at tRef (X0 radial, Y0 along-track, Z normal), radius a, rate n. */
  X0: Float64Array;
  Y0: Float64Array;
  Z: Float64Array;
  a: number;
  n: number;
  tRef: number;
  /** Time of the last accepted measurement, s (−∞ never). */
  tMeas: number;
  /** Lever arm of the tracked point from its body's centre, m (enters q). */
  lever: number;
  /** Accepted / gated-out scalar updates since the track began, and consecutive gated-out ones. */
  nAcc: number;
  nRej: number;
  rejRun: number;
}

export function makeNav(): NavState {
  return {
    valid: false, t: 0, tP: 0, x: new Float64Array(6), P: new Float64Array(36),
    X0: new Float64Array([1, 0, 0]), Y0: new Float64Array([0, 1, 0]), Z: new Float64Array([0, 0, 1]),
    a: 1, n: N_MIN, tRef: 0, tMeas: -Infinity, lever: 0, nAcc: 0, nRej: 0, rejRun: 0,
  };
}

/** Drop the track (the estimate is forgotten; the next measurement re-initialises it). */
export function navReset(nav: NavState): void {
  nav.valid = false;
  nav.x.fill(0);
  nav.P.fill(0);
  nav.tMeas = -Infinity;
  nav.nAcc = nav.nRej = nav.rejRun = 0;
}

// ------------------------------------------------------------------------------------------------ frame

/** Hill basis at time t into FR: columns x̂ (0..2), ŷ (3..5), ẑ (6..8). */
const FR = new Float64Array(9);
function frameAt(nav: NavState, t: number): void {
  const th = nav.n * (t - nav.tRef), c = mcos(th), s = msin(th), X = nav.X0, Y = nav.Y0, Z = nav.Z;
  FR[0] = c * X[0] + s * Y[0]; FR[1] = c * X[1] + s * Y[1]; FR[2] = c * X[2] + s * Y[2];
  FR[3] = -s * X[0] + c * Y[0]; FR[4] = -s * X[1] + c * Y[1]; FR[5] = -s * X[2] + c * Y[2];
  FR[6] = Z[0]; FR[7] = Z[1]; FR[8] = Z[2];
}

/** Hill state h (6) → inertial (6) with the frame in FR and rate n. */
function hillToInertial(h: ArrayLike<number>, n: number, out: Float64Array | number[]): void {
  const px = h[0], py = h[1], pz = h[2];
  const vx = h[3] - n * py, vy = h[4] + n * px, vz = h[5];
  out[0] = FR[0] * px + FR[3] * py + FR[6] * pz;
  out[1] = FR[1] * px + FR[4] * py + FR[7] * pz;
  out[2] = FR[2] * px + FR[5] * py + FR[8] * pz;
  out[3] = FR[0] * vx + FR[3] * vy + FR[6] * vz;
  out[4] = FR[1] * vx + FR[4] * vy + FR[7] * vz;
  out[5] = FR[2] * vx + FR[5] * vy + FR[8] * vz;
}

/** Inertial state (6) → Hill (6) with the frame in FR and rate n. */
function inertialToHill(I: ArrayLike<number>, n: number, out: Float64Array): void {
  const px = FR[0] * I[0] + FR[1] * I[1] + FR[2] * I[2];
  const py = FR[3] * I[0] + FR[4] * I[1] + FR[5] * I[2];
  const pz = FR[6] * I[0] + FR[7] * I[1] + FR[8] * I[2];
  const vx = FR[0] * I[3] + FR[1] * I[4] + FR[2] * I[5];
  const vy = FR[3] * I[3] + FR[4] * I[4] + FR[5] * I[5];
  const vz = FR[6] * I[3] + FR[7] * I[4] + FR[8] * I[5];
  out[0] = px; out[1] = py; out[2] = pz;
  out[3] = vx + n * py; out[4] = vy - n * px; out[5] = vz;
}

/** M (Hill → inertial, 6×6 row-major) for the frame in FR into out. */
function buildM(n: number, out: Float64Array): void {
  out.fill(0);
  for (let i = 0; i < 3; i++) {
    const xi = FR[i], yi = FR[3 + i], zi = FR[6 + i];
    out[i * 6] = xi; out[i * 6 + 1] = yi; out[i * 6 + 2] = zi;
    out[(3 + i) * 6] = n * yi; out[(3 + i) * 6 + 1] = -n * xi;
    out[(3 + i) * 6 + 3] = xi; out[(3 + i) * 6 + 4] = yi; out[(3 + i) * 6 + 5] = zi;
  }
}

/** M⁻¹ (inertial → Hill) for the frame in FR into out. */
function buildMinv(n: number, out: Float64Array): void {
  out.fill(0);
  for (let j = 0; j < 3; j++) {
    const xj = FR[j], yj = FR[3 + j], zj = FR[6 + j];
    out[j] = xj; out[6 + j] = yj; out[12 + j] = zj;
    out[18 + 3 + j] = xj; out[24 + 3 + j] = yj; out[30 + 3 + j] = zj;
    // v_H = Rᵀ v_I − W Rᵀ ρ_I :  −W = n·[[0,1,0],[−1,0,0],[0,0,0]]
    out[18 + j] = n * yj; out[24 + j] = -n * xj;
  }
}

// ------------------------------------------------------------------------------------------------ CW

const PHI = new Float64Array(36);
/** CW transition matrix Φ(Δ) (Hill, row-major) into PHI. */
function buildPhi(n: number, dt: number): void {
  const th = n * dt, s = msin(th), sh = msin(0.5 * th), omc = 2 * sh * sh, c = 1 - omc, inv = 1 / n;
  const F = PHI;
  F.fill(0);
  F[0] = 4 - 3 * c; F[3] = s * inv; F[4] = 2 * omc * inv;
  F[6] = 6 * (s - th); F[7] = 1; F[9] = -2 * omc * inv; F[10] = (4 * s - 3 * th) * inv;
  F[14] = c; F[17] = s * inv;
  F[18] = 3 * n * s; F[21] = c; F[22] = 2 * s;
  F[24] = -6 * n * omc; F[27] = -2 * s; F[28] = 4 * c - 3;
  F[32] = -n * s; F[35] = c;
}

/** x ← Φ(Δ) x (in place) for a 6-vector, without building the matrix. */
function phiApply(n: number, dt: number, x: Float64Array): void {
  const th = n * dt, s = msin(th), sh = msin(0.5 * th), omc = 2 * sh * sh, c = 1 - omc, inv = 1 / n;
  const px = x[0], py = x[1], pz = x[2], vx = x[3], vy = x[4], vz = x[5];
  x[0] = (4 - 3 * c) * px + s * inv * vx + 2 * omc * inv * vy;
  x[1] = 6 * (s - th) * px + py - 2 * omc * inv * vx + (4 * s - 3 * th) * inv * vy;
  x[2] = c * pz + s * inv * vz;
  x[3] = 3 * n * s * px + c * vx + 2 * s * vy;
  x[4] = -6 * n * omc * px - 2 * s * vx + (4 * c - 3) * vy;
  x[5] = -n * s * pz + c * vz;
}

// Gauss–Legendre, 4 points on [-1, 1].
const GLX = [-0.8611363115940526, -0.3399810435848563, 0.3399810435848563, 0.8611363115940526];
const GLW = [0.3478548451374538, 0.6521451548625461, 0.6521451548625461, 0.3478548451374538];
/** ∫₀^Θ f dθ of the 13 non-zero integrand products, order: 00 01 03 04 11 13 14 33 34 44 22 25 55. */
const QI = new Float64Array(13);

function qdIntegrals(Th: number): void {
  const I = QI;
  if (Th >= QD_SERIES) {
    const S = msin(Th), C = mcos(Th), sh = msin(0.5 * Th);
    const Is = 2 * sh * sh, Ic = S, Iss = 0.5 * Th - 0.5 * S * C, Icc = 0.5 * Th + 0.5 * S * C, Isc = 0.5 * S * S;
    const It = 0.5 * Th * Th, Its = S - Th * C, Itc = Th * S - Is, Itt = (Th * Th * Th) / 3;
    const omc2 = Th - 2 * Ic + Icc; // ∫(1−c)²
    I[0] = Iss + 4 * omc2;
    I[1] = 6 * (Is - It - Isc + Itc);
    I[2] = 4 * Is - 3 * Isc;
    I[3] = -2 * Iss + 14 * Ic - 6 * Th - 8 * Icc;
    I[4] = 4 * omc2 + 16 * Iss - 24 * Its + 9 * Itt;
    I[5] = -2 * Ic + 2 * Icc + 8 * Iss - 6 * Its;
    I[6] = -8 * Is + 12 * Isc - 12 * Itc + 9 * It;
    I[7] = Icc + 4 * Iss;
    I[8] = 6 * Isc - 6 * Is;
    I[9] = 4 * Iss + 16 * Icc - 24 * Ic + 9 * Th;
    I[10] = Iss; I[11] = Isc; I[12] = Icc;
    return;
  }
  I.fill(0);
  const h = 0.5 * Th;
  for (let k = 0; k < 4; k++) {
    const th = h * (1 + GLX[k]), w = h * GLW[k];
    const s = msin(th), sh = msin(0.5 * th), omc = 2 * sh * sh, c = 1 - omc, g = 4 * s - 3 * th;
    // X1 = [s, −2omc, ·, c, −2s, ·]; X2 = [2omc, g, ·, 2s, 4c−3, ·]; X3 = [·, ·, s, ·, ·, c]
    const a0 = s, a1 = -2 * omc, a3 = c, a4 = -2 * s;
    const b0 = 2 * omc, b1 = g, b3 = 2 * s, b4 = 4 * c - 3;
    I[0] += w * (a0 * a0 + b0 * b0);
    I[1] += w * (a0 * a1 + b0 * b1);
    I[2] += w * (a0 * a3 + b0 * b3);
    I[3] += w * (a0 * a4 + b0 * b4);
    I[4] += w * (a1 * a1 + b1 * b1);
    I[5] += w * (a1 * a3 + b1 * b3);
    I[6] += w * (a1 * a4 + b1 * b4);
    I[7] += w * (a3 * a3 + b3 * b3);
    I[8] += w * (a3 * a4 + b3 * b4);
    I[9] += w * (a4 * a4 + b4 * b4);
    I[10] += w * s * s; I[11] += w * s * c; I[12] += w * c * c;
  }
}

/** (i, j) of each entry of QI and the power of 1/n it carries beyond q/n. */
const QPAIRS = new Int8Array([0, 0, 0, 1, 0, 3, 0, 4, 1, 1, 1, 3, 1, 4, 3, 3, 3, 4, 4, 4, 2, 2, 2, 5, 5, 5]);
const QSCALE = new Int8Array([3, 3, 2, 2, 3, 2, 2, 1, 1, 1, 3, 2, 1]);

/** Qd(Δ) for PSD q (m²/s³ per axis) at rate n into out (6×6 Hill, symmetric). Exported for tests. */
export function cwProcessNoise(n: number, dt: number, q: number, out: Float64Array): Float64Array {
  if (n < N_MIN) n = N_MIN;
  qdIntegrals(n * dt);
  const I = QI, k1 = q / n, k2 = k1 / n, k3 = k2 / n;
  out.fill(0);
  const pairs = QPAIRS, scale = QSCALE;
  for (let k = 0; k < 13; k++) {
    const i = pairs[2 * k], j = pairs[2 * k + 1], v = (scale[k] === 3 ? k3 : scale[k] === 2 ? k2 : k1) * I[k];
    out[i * 6 + j] = v; out[j * 6 + i] = v;
  }
  return out;
}

/** The CW transition matrix (copy, for tests and planners). */
export function cwPhi(n: number, dt: number, out: Float64Array): Float64Array {
  buildPhi(n < N_MIN ? N_MIN : n, dt);
  out.set(PHI);
  return out;
}

// ------------------------------------------------------------------------------------------------ 6×6 helpers

const TMP = new Float64Array(36);
const TMP2 = new Float64Array(36);
const QD = new Float64Array(36);
const MM = new Float64Array(36);

/** P ← A P Aᵀ (6×6 row-major), result exactly symmetric. */
function congruence(A: Float64Array, P: Float64Array): void {
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      let s = 0;
      for (let k = 0; k < 6; k++) s += A[i * 6 + k] * P[k * 6 + j];
      TMP[i * 6 + j] = s;
    }
  }
  for (let i = 0; i < 6; i++) {
    for (let j = i; j < 6; j++) {
      let s = 0;
      for (let k = 0; k < 6; k++) s += TMP[i * 6 + k] * A[j * 6 + k];
      P[i * 6 + j] = s; P[j * 6 + i] = s;
    }
  }
}

/** Process-noise PSD at the current estimate (see the header). */
export function navProcessNoise(nav: NavState): number {
  const x = nav.x, r2 = x[0] * x[0] + x[1] * x[1] + x[2] * x[2];
  const au = A_FLOOR + 3 * nav.n * nav.n * (nav.lever + r2 / nav.a);
  return 2 * au * au * TAU_U;
}

/** Bring P to time t (closed form; exact for any span). No-op when P is already there. */
export function navCovAt(nav: NavState, t: number): void {
  const dt = t - nav.tP;
  if (!(dt > 0) || !nav.valid) { if (t > nav.tP) nav.tP = t; return; }
  buildPhi(nav.n, dt);
  congruence(PHI, nav.P);
  cwProcessNoise(nav.n, dt, navProcessNoise(nav), QD);
  const P = nav.P;
  for (let i = 0; i < 36; i++) P[i] += QD[i];
  nav.tP = t;
}

const DV = new Float64Array(6);
/**
 * Advance the state to t1 with the ship's proper Δv over the span (inertial, m/s; zero while coasting), applied at
 * mid-span. Exact for a coasting span of any length; second-order in the span for a thrusting one (spans are one tick
 * while thrusting). P is not touched (navCovAt brings it along lazily).
 */
export function navPropagate(nav: NavState, t1: number, dvx: number, dvy: number, dvz: number): void {
  const dt = t1 - nav.t;
  if (!nav.valid) { nav.t = t1; nav.tP = t1; return; }
  if (!(dt > 0)) return;
  phiApply(nav.n, dt, nav.x);
  if (dvx !== 0 || dvy !== 0 || dvz !== 0) {
    // Φ(Δ/2)·[0; −R_midᵀ Δv]: the target-relative state changes opposite to the ship's own Δv.
    frameAt(nav, nav.t + 0.5 * dt);
    DV[0] = DV[1] = DV[2] = 0;
    DV[3] = -(FR[0] * dvx + FR[1] * dvy + FR[2] * dvz);
    DV[4] = -(FR[3] * dvx + FR[4] * dvy + FR[5] * dvz);
    DV[5] = -(FR[6] * dvx + FR[7] * dvy + FR[8] * dvz);
    phiApply(nav.n, 0.5 * dt, DV);
    const x = nav.x;
    for (let i = 0; i < 6; i++) x[i] += DV[i];
  }
  nav.t = t1;
}

// ------------------------------------------------------------------------------------------------ init, re-anchor

const XI = new Float64Array(6);
const PI6 = new Float64Array(36);

/** Set the reference orbit through the target point at (shipRel + ρ_I) relative to the primary (μ). */
function anchor(nav: NavState, t: number, shipRel: V3, shipRelV: V3, mu: number, I: ArrayLike<number>): void {
  const rx = shipRel.x + I[0], ry = shipRel.y + I[1], rz = shipRel.z + I[2];
  const vx = shipRelV.x + I[3], vy = shipRelV.y + I[4], vz = shipRelV.z + I[5];
  const r = msqrt(rx * rx + ry * ry + rz * rz) || 1;
  let hx = ry * vz - rz * vy, hy = rz * vx - rx * vz, hz = rx * vy - ry * vx;
  let hl = msqrt(hx * hx + hy * hy + hz * hz);
  if (!(hl > 0)) { hx = 0; hy = 1; hz = 0; hl = 1; }
  hx /= hl; hy /= hl; hz /= hl;
  const X = nav.X0, Y = nav.Y0, Z = nav.Z;
  X[0] = rx / r; X[1] = ry / r; X[2] = rz / r;
  // Z ⟂ X exactly (the velocity need not be ⟂ r).
  const d = hx * X[0] + hy * X[1] + hz * X[2];
  hx -= d * X[0]; hy -= d * X[1]; hz -= d * X[2];
  hl = msqrt(hx * hx + hy * hy + hz * hz) || 1;
  Z[0] = hx / hl; Z[1] = hy / hl; Z[2] = hz / hl;
  Y[0] = Z[1] * X[2] - Z[2] * X[1]; Y[1] = Z[2] * X[0] - Z[0] * X[2]; Y[2] = Z[0] * X[1] - Z[1] * X[0];
  nav.a = r;
  nav.n = Math.max(N_MIN, msqrt(mu / (r * r * r)));
  nav.tRef = t;
}

/**
 * Start a track at t from an inertial relative state I = [ρ_I, ρ̇_I] (target point − ship) and its inertial covariance
 * P_I (6×6). shipRel/shipRelV: the ship relative to the primary (μ), which fixes the reference orbit.
 */
export function navInit(nav: NavState, t: number, I: ArrayLike<number>, PI: ArrayLike<number>, shipRel: V3, shipRelV: V3, mu: number, lever: number): void {
  anchor(nav, t, shipRel, shipRelV, mu, I);
  frameAt(nav, t);
  inertialToHill(I, nav.n, nav.x);
  buildMinv(nav.n, MM);
  for (let i = 0; i < 36; i++) nav.P[i] = PI[i];
  congruence(MM, nav.P);
  nav.t = nav.tP = t;
  nav.valid = true;
  nav.lever = lever;
  nav.tMeas = t;
  nav.nAcc = nav.nRej = nav.rejRun = 0;
}

/** Inertial covariance at nav.tP into out (6×6). */
export function navCovInertial(nav: NavState, out: Float64Array): Float64Array {
  frameAt(nav, nav.tP);
  buildM(nav.n, MM);
  out.set(nav.P);
  congruence(MM, out);
  return out;
}

/** Re-anchor when the estimated target point has drifted more than REANCHOR_DIST from the reference point. */
export function navMaybeReanchor(nav: NavState, shipRel: V3, shipRelV: V3, mu: number): boolean {
  if (!nav.valid) return false;
  navCovAt(nav, nav.t);
  frameAt(nav, nav.t);
  hillToInertial(nav.x, nav.n, XI);
  const rx = shipRel.x + XI[0], ry = shipRel.y + XI[1], rz = shipRel.z + XI[2];
  const a = nav.a, ex = rx - a * FR[0], ey = ry - a * FR[1], ez = rz - a * FR[2];
  if (ex * ex + ey * ey + ez * ez < REANCHOR_DIST * REANCHOR_DIST) return false;
  navCovInertial(nav, PI6);
  const tm = nav.tMeas, nA = nav.nAcc, nR = nav.nRej, run = nav.rejRun;
  navInit(nav, nav.t, XI, PI6, shipRel, shipRelV, mu, nav.lever);
  nav.tMeas = tm; nav.nAcc = nA; nav.nRej = nR; nav.rejRun = run;
  return true;
}

// ------------------------------------------------------------------------------------------------ read-outs

const XP = new Float64Array(6);
const PP = new Float64Array(36);

/**
 * Inertial relative state of the target point at time t (≥ nav.t; coasting extrapolation in closed form) into out:
 * [ρ_I (3), ρ̇_I (3)]. Pure: never changes the NavState (read-outs at frame times must not touch the world).
 */
export function navInertialAt(nav: NavState, t: number, out: Float64Array | number[]): void {
  XP.set(nav.x);
  if (t > nav.t) phiApply(nav.n, t - nav.t, XP);
  frameAt(nav, t > nav.t ? t : nav.t);
  hillToInertial(XP, nav.n, out);
}

/**
 * The Hill basis at time t (columns x̂, ŷ, ẑ as out[0..2], out[3..5], out[6..8]) and the Hill state extrapolated to t
 * (coasting) into hill[0..5]. Pure. For planners that work in the Hill frame (burnPlan.ts cwIntercept).
 */
export function navHillAt(nav: NavState, t: number, hill: Float64Array | number[], basis: Float64Array | number[]): void {
  XP.set(nav.x);
  if (t > nav.t) phiApply(nav.n, t - nav.t, XP);
  frameAt(nav, t > nav.t ? t : nav.t);
  for (let i = 0; i < 6; i++) hill[i] = XP[i];
  for (let i = 0; i < 9; i++) basis[i] = FR[i];
}

/** Covariance (Hill) brought to time t into PP without changing the NavState. */
function covPeek(nav: NavState, t: number): void {
  PP.set(nav.P);
  const dt = t - nav.tP;
  if (dt > 0 && nav.valid) {
    buildPhi(nav.n, dt);
    congruence(PHI, PP);
    cwProcessNoise(nav.n, dt, navProcessNoise(nav), QD);
    for (let i = 0; i < 36; i++) PP[i] += QD[i];
  }
}

// ------------------------------------------------------------------------------------------------ updates

const HH = new Float64Array(6);
const PH = new Float64Array(6);

/** Inertial row [hp, hv] → Hill row into HH, with the frame in FR. */
function rowToHill(n: number, hpx: number, hpy: number, hpz: number, hvx: number, hvy: number, hvz: number): void {
  const xp = hpx * FR[0] + hpy * FR[1] + hpz * FR[2], yp = hpx * FR[3] + hpy * FR[4] + hpz * FR[5];
  const zp = hpx * FR[6] + hpy * FR[7] + hpz * FR[8];
  const xv = hvx * FR[0] + hvy * FR[1] + hvz * FR[2], yv = hvx * FR[3] + hvy * FR[4] + hvz * FR[5];
  const zv = hvx * FR[6] + hvy * FR[7] + hvz * FR[8];
  HH[0] = xp + n * yv; HH[1] = yp - n * xv; HH[2] = zp; HH[3] = xv; HH[4] = yv; HH[5] = zv;
}

/** One scalar update with innovation `res` and variance R; the row is in HH. Returns false if gated out. */
function scalarUpdate(nav: NavState, res: number, R: number): boolean {
  const P = nav.P, x = nav.x;
  let S = R;
  for (let i = 0; i < 6; i++) {
    let s = 0;
    for (let k = 0; k < 6; k++) s += P[i * 6 + k] * HH[k];
    PH[i] = s;
    S += HH[i] * s;
  }
  if (!(S > 0) || res * res > GATE2 * S) { nav.nRej++; nav.rejRun++; return false; }
  const iS = 1 / S, kr = res * iS;
  for (let i = 0; i < 6; i++) x[i] += PH[i] * kr;
  for (let i = 0; i < 6; i++) {
    const pi = PH[i] * iS;
    for (let j = i; j < 6; j++) {
      const v = P[i * 6 + j] - pi * PH[j];
      P[i * 6 + j] = v; P[j * 6 + i] = v;
    }
  }
  nav.nAcc++;
  nav.rejRun = 0;
  return true;
}

/** Normalised innovation squared of the last scalar update attempt (for NIS statistics in tests). */
export let lastNis = 0;

function prepare(nav: NavState, t: number): void {
  if (nav.t < t) navPropagate(nav, t, 0, 0, 0);
  navCovAt(nav, nav.t);
  frameAt(nav, nav.t);
  hillToInertial(nav.x, nav.n, XI);
}

/**
 * Range from a sensor at offset (ax, ay, az) from the ship origin (inertial axes) to the target point: z (m), σ (m).
 * Returns false if gated out.
 */
export function navUpdateRange(nav: NavState, t: number, ax: number, ay: number, az: number, z: number, sigma: number): boolean {
  prepare(nav, t);
  const dx = XI[0] - ax, dy = XI[1] - ay, dz = XI[2] - az, r = msqrt(dx * dx + dy * dy + dz * dz);
  if (!(r > 1e-6)) return false;
  rowToHill(nav.n, dx / r, dy / r, dz / r, 0, 0, 0);
  const R = sigma * sigma, ok = scalarUpdate(nav, z - r, R);
  if (ok) nav.tMeas = t;
  return ok;
}

/**
 * Range rate from a sensor at offset a moving at ȧ (both inertial, relative to the ship origin: ȧ = ω × a) to the
 * target point: z (m/s), σ (m/s). Linearised about the current estimate.
 */
export function navUpdateRangeRate(nav: NavState, t: number, ax: number, ay: number, az: number, adx: number, ady: number, adz: number, z: number, sigma: number): boolean {
  prepare(nav, t);
  const dx = XI[0] - ax, dy = XI[1] - ay, dz = XI[2] - az, r = msqrt(dx * dx + dy * dy + dz * dz);
  if (!(r > 1e-6)) return false;
  const ux = dx / r, uy = dy / r, uz = dz / r;
  const wx = XI[3] - adx, wy = XI[4] - ady, wz = XI[5] - adz;
  const rd = ux * wx + uy * wy + uz * wz;
  // ∂ṙ/∂ρ = (ḋ − ṙ û)/r, ∂ṙ/∂ρ̇ = û
  rowToHill(nav.n, (wx - rd * ux) / r, (wy - rd * uy) / r, (wz - rd * uz) / r, ux, uy, uz);
  const ok = scalarUpdate(nav, z - rd, sigma * sigma);
  if (ok) nav.tMeas = t;
  return ok;
}

/**
 * Bearing: the measured unit line of sight (mx, my, mz), inertial, from a sensor at offset a; σ (rad) per axis.
 * Two scalar updates across the predicted line of sight. Returns the number accepted (0..2).
 */
export function navUpdateBearing(nav: NavState, t: number, ax: number, ay: number, az: number, mx: number, my: number, mz: number, sigma: number): number {
  prepare(nav, t);
  let acc = 0;
  for (let k = 0; k < 2; k++) {
    if (k === 1) { frameAt(nav, nav.t); hillToInertial(nav.x, nav.n, XI); }
    const dx = XI[0] - ax, dy = XI[1] - ay, dz = XI[2] - az, r = msqrt(dx * dx + dy * dy + dz * dz);
    if (!(r > 1e-6)) return acc;
    const ux = dx / r, uy = dy / r, uz = dz / r;
    // p1 = normalise(û × e) with e the axis least aligned with û; p2 = û × p1
    let ex = 0, ey = 0, ez = 0;
    const ax2 = ux < 0 ? -ux : ux, ay2 = uy < 0 ? -uy : uy, az2 = uz < 0 ? -uz : uz;
    if (ax2 <= ay2 && ax2 <= az2) ex = 1; else if (ay2 <= az2) ey = 1; else ez = 1;
    let p1x = uy * ez - uz * ey, p1y = uz * ex - ux * ez, p1z = ux * ey - uy * ex;
    const l = msqrt(p1x * p1x + p1y * p1y + p1z * p1z);
    p1x /= l; p1y /= l; p1z /= l;
    let px = p1x, py = p1y, pz = p1z;
    if (k === 1) { px = uy * p1z - uz * p1y; py = uz * p1x - ux * p1z; pz = ux * p1y - uy * p1x; }
    // h = û·p = 0 at the estimate; ∂h/∂ρ = p/r (p ⟂ û)
    rowToHill(nav.n, px / r, py / r, pz / r, 0, 0, 0);
    const res = mx * px + my * py + mz * pz;
    if (scalarUpdate(nav, res, sigma * sigma)) { acc++; nav.tMeas = t; }
  }
  return acc;
}

/** 1σ of range and range rate along the estimated line of sight from the ship origin (m, m/s) at t into out[0..1]. Pure. */
export function navLosSigma(nav: NavState, t: number, out: Float64Array | number[]): void {
  if (!nav.valid) { out[0] = out[1] = Infinity; return; }
  covPeek(nav, t);
  navInertialAt(nav, t, XI); // leaves the frame at max(t, nav.t) in FR
  const r = msqrt(XI[0] * XI[0] + XI[1] * XI[1] + XI[2] * XI[2]);
  if (!(r > 1e-6)) { out[0] = out[1] = Infinity; return; }
  const ux = XI[0] / r, uy = XI[1] / r, uz = XI[2] / r;
  const P = PP;
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 0) rowToHill(nav.n, ux, uy, uz, 0, 0, 0);
    else {
      const rd = ux * XI[3] + uy * XI[4] + uz * XI[5];
      rowToHill(nav.n, (XI[3] - rd * ux) / r, (XI[4] - rd * uy) / r, (XI[5] - rd * uz) / r, ux, uy, uz);
    }
    let s = 0;
    for (let i = 0; i < 6; i++) { let a = 0; for (let k = 0; k < 6; k++) a += P[i * 6 + k] * HH[k]; s += HH[i] * a; }
    out[pass] = msqrt(s > 0 ? s : 0);
  }
}

/** 1σ position and velocity (√trace of the Hill blocks; trace is frame-invariant for position), m and m/s, at t. Pure. */
export function navSigma(nav: NavState, t: number, out: Float64Array | number[]): void {
  if (!nav.valid) { out[0] = out[1] = Infinity; return; }
  covPeek(nav, t);
  const P = PP;
  out[0] = msqrt(P[0] + P[7] + P[14]);
  out[1] = msqrt(P[21] + P[28] + P[35]);
}

/** Hill covariance brought to t (copy into out, pure), for tests and the NEES check. */
export function navCovPeek(nav: NavState, t: number, out: Float64Array): Float64Array {
  covPeek(nav, t);
  out.set(PP);
  return out;
}

// ------------------------------------------------------------------------------------------------ save / load

/** Plain numbers (44): [valid, t, tP, x(6), P upper(21), X0(3), Z(3), a, n, tRef, tMeas, lever, nAcc, nRej, rejRun]; Y0 = Z × X0 is rebuilt. */
export function saveNav(nav: NavState): number[] {
  const o: number[] = [nav.valid ? 1 : 0, nav.t, nav.tP];
  for (let i = 0; i < 6; i++) o.push(nav.x[i]);
  for (let i = 0; i < 6; i++) for (let j = i; j < 6; j++) o.push(nav.P[i * 6 + j]);
  for (let i = 0; i < 3; i++) o.push(nav.X0[i]);
  for (let i = 0; i < 3; i++) o.push(nav.Z[i]);
  o.push(nav.a, nav.n, nav.tRef, Number.isFinite(nav.tMeas) ? nav.tMeas : -1e300, nav.lever, nav.nAcc, nav.nRej, nav.rejRun);
  return o;
}

/** Inverse of saveNav; a missing or short record gives an empty (invalid) track. */
export function loadNav(raw: unknown, out: NavState = makeNav()): NavState {
  navReset(out);
  const a = Array.isArray(raw) ? (raw as unknown[]) : null;
  if (!a || a.length < 44) return out;
  const num = (i: number, d = 0): number => (typeof a[i] === 'number' && Number.isFinite(a[i] as number) ? (a[i] as number) : d);
  let k = 0;
  out.valid = num(k++) === 1; out.t = num(k++); out.tP = num(k++);
  for (let i = 0; i < 6; i++) out.x[i] = num(k++);
  for (let i = 0; i < 6; i++) for (let j = i; j < 6; j++) { const v = num(k++); out.P[i * 6 + j] = v; out.P[j * 6 + i] = v; }
  for (let i = 0; i < 3; i++) out.X0[i] = num(k++);
  for (let i = 0; i < 3; i++) out.Z[i] = num(k++);
  const X = out.X0, Y = out.Y0, Z = out.Z; // exactly as anchor() builds it
  Y[0] = Z[1] * X[2] - Z[2] * X[1]; Y[1] = Z[2] * X[0] - Z[0] * X[2]; Y[2] = Z[0] * X[1] - Z[1] * X[0];
  out.a = num(k++, 1); out.n = num(k++, N_MIN); out.tRef = num(k++);
  const tm = num(k++, -1e300); out.tMeas = tm <= -1e299 ? -Infinity : tm;
  out.lever = num(k++); out.nAcc = num(k++); out.nRej = num(k++); out.rejRun = num(k++);
  return out;
}
