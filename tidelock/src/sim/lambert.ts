// TIDELOCK Lambert solver.
//
// Lambert's problem: given two positions around a body and a time of flight, find the conic that
// connects them. Everything the flight computer plans across open space (rendezvous, transfers to
// moons and planets, mid-course targeting) is built on it.
//
// Method: Izzo's formulation ("Revisiting Lambert's problem", 2015). The geometry collapses to one
// parameter λ (|λ| ≤ 1, negative for transfers of more than half a turn) and a non-dimensional time
// T; the unknown is x (x < 1 ellipse, x = 1 parabola, x > 1 hyperbola), on which T is monotonic for
// a single revolution. x is found by Householder iterations from Izzo's starting guess, kept inside
// a bracket (with bisection whenever a step leaves it), so the solver cannot diverge. The
// formulation has no singularity at a transfer angle of 180° — only the *plane* is undefined there,
// and it is taken from the caller's preferred normal.
//
// Conventions: SI units, any right-handed inertial axes (the project uses XZ as the reference plane
// with +Y north, see docs/ARCHITECTURE.md). Pure simulation code: no three.js, no DOM, no randomness.

import type { V3 } from '../core/types';

const PI = Math.PI;

/** Options of {@link lambert}. */
export interface LambertOptions {
  /**
   * Direction of travel. true = the transfer orbit's angular momentum has a positive component along
   * the reference normal (`preferredNormal`, default +Y: counter-clockwise seen from north, the way
   * planets and almost everything else orbits); false = the opposite way round.
   */
  prograde: boolean;
  /**
   * Reference normal (need not be unit length). It decides which way round "prograde" is and, when
   * r1 and r2 are (anti)parallel so that they do not define a plane (transfer angle 0° or 180°),
   * the transfer plane itself: the orbit normal is this vector made perpendicular to r1.
   * Pass the departure orbit's normal to keep such transfers in the plane the ship is already in.
   * Default +Y.
   */
  preferredNormal?: V3;
}

/** A solution of Lambert's problem: velocities (m/s, same axes as the positions) at departure and arrival. */
export interface LambertSolution {
  /** Velocity on the transfer conic at r1. */
  v1: V3;
  /** Velocity on the transfer conic at r2. */
  v2: V3;
}

/** sin(transfer angle) below which r1, r2 are treated as collinear and the plane comes from the preferred normal. */
const PLANE_EPS = 1e-9;

/** Gauss hypergeometric function 2F1(3, 1; 5/2; x) by its power series (|x| < 1; used only for small |x|). */
function hyp2F1(x: number): number {
  let sum = 1;
  let term = 1;
  for (let j = 0; j < 400; j++) {
    term *= ((3 + j) * (1 + j) * x) / ((2.5 + j) * (j + 1));
    sum += term;
    if (Math.abs(term) <= 1e-17 * Math.abs(sum)) break;
  }
  return sum;
}

/** Non-dimensional time of flight T(x) for the single-revolution transfer with parameter `lam`. */
function tofOfX(x: number, lam: number): number {
  const dist = Math.abs(x - 1);
  const lam2 = lam * lam;
  if (dist < 0.2 && dist > 0.01) {
    // Lagrange form: well conditioned at moderate distance from the parabola.
    const a = 1 / (1 - x * x);
    if (a > 0) {
      const alfa = 2 * Math.acos(x);
      let beta = 2 * Math.asin(Math.min(1, Math.sqrt(lam2 / a)));
      if (lam < 0) beta = -beta;
      return (a * Math.sqrt(a) * (alfa - Math.sin(alfa) - (beta - Math.sin(beta)))) / 2;
    }
    const alfa = 2 * Math.acosh(x);
    let beta = 2 * Math.asinh(Math.sqrt(-lam2 / a));
    if (lam < 0) beta = -beta;
    return (-a * Math.sqrt(-a) * (beta - Math.sinh(beta) - (alfa - Math.sinh(alfa)))) / 2;
  }
  const E = x * x - 1;
  const z = Math.sqrt(Math.max(0, 1 + lam2 * E));
  if (dist <= 0.01) {
    // Battin's series: exact through the parabola.
    const eta = z - lam * x;
    const s1 = 0.5 * (1 - lam - x * eta);
    const q = (4 / 3) * hyp2F1(s1);
    return (eta * eta * eta * q + 4 * lam * eta) / 2;
  }
  // Lancaster–Blanchard form.
  const y = Math.sqrt(Math.abs(E));
  const g = x * z - lam * E;
  let d: number;
  if (E < 0) {
    d = Math.acos(g > 1 ? 1 : g < -1 ? -1 : g);
  } else {
    const f = y * (z - lam * x);
    d = Math.log(f + g);
  }
  return (x - lam * z - d / y) / E;
}

/** Solve T(x) = T for x (single revolution). Returns NaN if no finite solution is found. */
function solveX(T: number, lam: number): number {
  const lam2 = lam * lam;
  const lam3 = lam2 * lam;
  const lam5 = lam3 * lam2;
  // Izzo's starting guess.
  const T00 = Math.acos(lam) + lam * Math.sqrt(Math.max(0, 1 - lam2));
  const T1 = (2 / 3) * (1 - lam3);
  let x: number;
  if (T >= T00) x = -(T - T00) / (T - T00 + 4);
  else if (T <= T1) x = (T1 * (T1 - T)) / (0.4 * (1 - lam5) * T) + 1;
  else x = Math.pow(T / T00, Math.LN2 / Math.log(T1 / T00)) - 1;
  if (!(x > -1 && x < Infinity)) x = 0;

  // T(x) decreases monotonically from +∞ at x = -1 to 0 as x -> ∞: keep a bracket around the root.
  let lo = -1;
  let hi = Infinity;
  const tol = 1e-13 * T;
  for (let it = 0; it < 80; it++) {
    const t = tofOfX(x, lam);
    if (!(t < Infinity && t > -Infinity)) {
      // Evaluation failed (should not happen inside the bracket): shrink toward the safe side.
      x = hi < Infinity ? 0.5 * (lo + hi) : 0.5 * (lo + x);
      continue;
    }
    const delta = t - T;
    if (Math.abs(delta) <= tol) return x;
    if (delta > 0) lo = x;
    else hi = x;
    let xn = NaN;
    const umx2 = 1 - x * x;
    const y2 = 1 - lam2 * umx2;
    if (Math.abs(umx2) > 1e-7 && y2 > 1e-12) {
      const y = Math.sqrt(y2);
      const y3 = y2 * y;
      const dT = (3 * t * x - 2 + (2 * lam3 * x) / y) / umx2;
      const ddT = (3 * t + 5 * x * dT + (2 * (1 - lam2) * lam3) / y3) / umx2;
      const dddT = (7 * x * ddT + 8 * dT - (6 * (1 - lam2) * lam2 * lam3 * x) / (y3 * y2)) / umx2;
      const dT2 = dT * dT;
      xn = x - (delta * (dT2 - (delta * ddT) / 2)) / (dT * (dT2 - delta * ddT) + (dddT * delta * delta) / 6);
    } else {
      // Next to the parabola (or the y = 0 corner) the closed-form derivatives are 0/0: secant slope instead.
      const h = 1e-5;
      const dT = (tofOfX(x + h, lam) - t) / h;
      if (dT < 0) xn = x - delta / dT;
    }
    if (!(xn > lo && xn < hi)) {
      // Step left the bracket (or was not a number): bisect, or march outward while the upper end is open.
      xn = hi < Infinity ? 0.5 * (lo + hi) : x + Math.max(1, Math.abs(x));
    }
    if (Math.abs(xn - x) <= 4e-16 * (1 + Math.abs(x))) return xn;
    x = xn;
  }
  // Out of iterations: accept only a tight bracket.
  return hi - lo <= 1e-9 * (1 + Math.abs(x)) ? x : NaN;
}

/**
 * Single-revolution Lambert solver.
 *
 * Finds the conic around a body with gravitational parameter `mu` (m³/s²) that leaves position `r1`
 * and arrives at position `r2` (m, relative to the body, any inertial axes) exactly `tof` seconds
 * later, having swept less than one full turn. Elliptic, parabolic and hyperbolic transfers are all
 * handled; the transfer angle may be anything in [0°, 360°), including the 0° / 180° cases where r1
 * and r2 are collinear (then the plane is taken from `opts.preferredNormal`).
 *
 * Returns the velocities at both ends (m/s), or null when there is no meaningful answer: non-finite
 * or non-positive inputs, r1 = r2 (a "transfer" back to the same point is not unique), or a failure
 * to converge. Never throws and never returns NaN.
 *
 * Note that the solver knows nothing about the body's size: the caller must reject transfers whose
 * periapsis dips below the surface.
 */
export function lambert(r1: V3, r2: V3, tof: number, mu: number, opts: LambertOptions = { prograde: true }): LambertSolution | null {
  const r1n = Math.sqrt(r1.x * r1.x + r1.y * r1.y + r1.z * r1.z);
  const r2n = Math.sqrt(r2.x * r2.x + r2.y * r2.y + r2.z * r2.z);
  if (!(r1n > 0 && r1n < Infinity && r2n > 0 && r2n < Infinity && tof > 0 && tof < Infinity && mu > 0 && mu < Infinity)) return null;
  const dx = r2.x - r1.x;
  const dy = r2.y - r1.y;
  const dz = r2.z - r1.z;
  const c = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const s = 0.5 * (r1n + r2n + c);
  if (!(c > 1e-13 * s)) return null;

  const i1x = r1.x / r1n;
  const i1y = r1.y / r1n;
  const i1z = r1.z / r1n;
  const i2x = r2.x / r2n;
  const i2y = r2.y / r2n;
  const i2z = r2.z / r2n;

  // Reference normal (unit); +Y when missing or unusable.
  let nx = 0;
  let ny = 1;
  let nz = 0;
  const pn = opts.preferredNormal;
  if (pn) {
    const l = Math.sqrt(pn.x * pn.x + pn.y * pn.y + pn.z * pn.z);
    if (l > 0 && l < Infinity) {
      nx = pn.x / l;
      ny = pn.y / l;
      nz = pn.z / l;
    }
  }
  const prograde = opts.prograde !== false;

  // Transfer plane and angle.
  let hx = i1y * i2z - i1z * i2y;
  let hy = i1z * i2x - i1x * i2z;
  let hz = i1x * i2y - i1y * i2x;
  const sinT = Math.sqrt(hx * hx + hy * hy + hz * hz);
  const cosT = i1x * i2x + i1y * i2y + i1z * i2z;
  let theta: number;
  if (sinT > PLANE_EPS) {
    hx /= sinT;
    hy /= sinT;
    hz /= sinT;
    theta = Math.atan2(sinT, cosT);
    const d = hx * nx + hy * ny + hz * nz;
    if (prograde ? d < 0 : d > 0) {
      // The short way round would be the wrong direction: go the long way.
      hx = -hx;
      hy = -hy;
      hz = -hz;
      theta = 2 * PI - theta;
    }
  } else {
    // Collinear positions: the plane is the reference normal made perpendicular to r1.
    const k = nx * i1x + ny * i1y + nz * i1z;
    hx = nx - k * i1x;
    hy = ny - k * i1y;
    hz = nz - k * i1z;
    let hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
    if (!(hl > 1e-6)) {
      // The reference normal is along r1 too: any perpendicular will do (deterministic choice).
      const ax = Math.abs(i1y) < 0.9 ? 0 : 1;
      const ay = Math.abs(i1y) < 0.9 ? 1 : 0;
      hx = i1y * 0 - i1z * ay;
      hy = i1z * ax - i1x * 0;
      hz = i1x * ay - i1y * ax;
      hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
    }
    hx /= hl;
    hy /= hl;
    hz /= hl;
    if (!prograde) {
      hx = -hx;
      hy = -hy;
      hz = -hz;
    }
    theta = cosT < 0 ? PI : 0;
  }

  const lam = (Math.sqrt(r1n * r2n) / s) * Math.cos(0.5 * theta);
  const lamC = lam > 1 ? 1 : lam < -1 ? -1 : lam;
  const T = Math.sqrt((2 * mu) / (s * s * s)) * tof;
  const x = solveX(T, lamC);
  if (!(x > -1 && x < Infinity)) return null;

  const gamma = Math.sqrt((mu * s) / 2);
  const rho = (r1n - r2n) / c;
  const sigma = Math.sqrt(Math.max(0, 1 - rho * rho));
  const y = Math.sqrt(Math.max(0, 1 - lamC * lamC * (1 - x * x)));
  const vr1 = (gamma * (lamC * y - x - rho * (lamC * y + x))) / r1n;
  const vr2 = (-gamma * (lamC * y - x + rho * (lamC * y + x))) / r2n;
  const vt = gamma * sigma * (y + lamC * x);
  const vt1 = vt / r1n;
  const vt2 = vt / r2n;

  // Transverse unit vectors: h × r̂ (the direction of motion about h).
  const t1x = hy * i1z - hz * i1y;
  const t1y = hz * i1x - hx * i1z;
  const t1z = hx * i1y - hy * i1x;
  const t2x = hy * i2z - hz * i2y;
  const t2y = hz * i2x - hx * i2z;
  const t2z = hx * i2y - hy * i2x;

  const v1 = { x: vr1 * i1x + vt1 * t1x, y: vr1 * i1y + vt1 * t1y, z: vr1 * i1z + vt1 * t1z };
  const v2 = { x: vr2 * i2x + vt2 * t2x, y: vr2 * i2y + vt2 * t2y, z: vr2 * i2z + vt2 * t2z };
  const sum = v1.x + v1.y + v1.z + v2.x + v2.y + v2.z;
  if (!(sum < Infinity && sum > -Infinity)) return null;
  return { v1, v2 };
}
