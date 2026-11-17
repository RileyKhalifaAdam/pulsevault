// TIDELOCK orbital-mechanics core.
//
// Everything the game knows about Kepler motion lives here: element <-> state conversion,
// universal-variable propagation, body positions on rails (SystemModel), sphere-of-influence
// bookkeeping, event timing on a conic, closest approach, patched-conic trajectory prediction and
// polyline sampling for the map.
//
// Conventions (binding, see docs/ARCHITECTURE.md):
//   * SI units: metres, seconds, kilograms, radians. `mu` is always G*mass of the central body, m^3/s^2.
//   * Right-handed axes, reference plane XZ, +Y north. Prograde = counter-clockwise seen from +Y
//     (from +X toward -Z). A zero-element orbit has its periapsis on +X and moves toward -Z there.
//     (Textbook z-up formulas with (x, y, z)_textbook -> (x, z, -y).)
//   * A StateVector is always relative to the centre of the body being orbited, in non-rotating
//     system axes. "Absolute" means relative to the system's primary star.
//
// This file is pure simulation code: no three.js, no DOM, no Math.random()/Date.now().
// Functions with an `out` argument (or a `...To` name) do not allocate and may be called every frame.

import type { BodyDef, MiningSiteDef, OrbitElements, StateVector, StationDef, SystemDef, V3 } from '../core/types';
import { DAY, G } from '../core/units';
import { TAU, wrapPi, wrapTau } from '../core/vec';

const PI = Math.PI;

// ===================================================================================== basics

/** A fresh zero state vector. */
export const newState = (): StateVector => ({ r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } });

/** Copy `sv` into `out` (no allocation). Returns `out`. */
export function copyState(out: StateVector, sv: StateVector): StateVector {
  out.r.x = sv.r.x;
  out.r.y = sv.r.y;
  out.r.z = sv.r.z;
  out.v.x = sv.v.x;
  out.v.y = sv.v.y;
  out.v.z = sv.v.z;
  return out;
}

/** A fresh element set (circular, equatorial, 1 m — overwrite before use). */
export const newElements = (): OrbitElements => ({ a: 1, e: 0, i: 0, lan: 0, argp: 0, m0: 0, epoch: 0 });

/** Orbital speed (m/s) at radius `r` (m) on an orbit of semi-major axis `a` (m; negative = hyperbola, Infinity = parabola). */
export function visViva(mu: number, r: number, a: number): number {
  const v2 = mu * (2 / r - 1 / a);
  return v2 > 0 ? Math.sqrt(v2) : 0;
}

/** Circular-orbit speed (m/s) at radius `r` (m). */
export const circularSpeed = (mu: number, r: number): number => Math.sqrt(mu / r);

/** Escape speed (m/s) at radius `r` (m). */
export const escapeSpeed = (mu: number, r: number): number => Math.sqrt((2 * mu) / r);

/** Orbital period (s) for semi-major axis `a` (m). Infinity for open orbits (a <= 0 or non-finite). */
export function orbitalPeriod(mu: number, a: number): number {
  return a > 0 && a < Infinity ? TAU * Math.sqrt((a * a * a) / mu) : Infinity;
}

/** Mean motion (rad/s) for semi-major axis `a` (m); for hyperbolas (a < 0) the hyperbolic mean motion. */
export function meanMotion(mu: number, a: number): number {
  const A = Math.abs(a);
  return Math.sqrt(mu / (A * A * A));
}

/** Synodic period (s) of two orbits with periods `t1`, `t2` (s). Infinity when they are equal. */
export function synodicPeriod(t1: number, t2: number): number {
  const d = Math.abs(1 / t1 - 1 / t2);
  return d > 0 ? 1 / d : Infinity;
}

/** Sphere-of-influence radius (m) of a body of mass `m` orbiting a body of mass `M` at semi-major axis `a` (m). */
export const soiRadius = (a: number, m: number, M: number): number => a * Math.pow(m / M, 0.4);

export interface HohmannTransfer {
  /** Prograde Δv of the departure burn, m/s (negative = retrograde, i.e. when r2 < r1). */
  dv1: number;
  /** Prograde Δv of the arrival (circularisation) burn, m/s (negative when r2 < r1). */
  dv2: number;
  /** |dv1| + |dv2|, m/s. */
  dvTotal: number;
  /** Time of flight, s (half the transfer-ellipse period). */
  tof: number;
  /** Semi-major axis of the transfer ellipse, m. */
  aTransfer: number;
  /** Angle (rad, in (-π, π], positive = ahead/prograde) the target must lead the ship by at departure. */
  phaseAngle: number;
}

/** Hohmann transfer between coplanar circular orbits of radius `r1` -> `r2` (m) around a body with `mu`. */
export function hohmann(mu: number, r1: number, r2: number): HohmannTransfer {
  const aT = 0.5 * (r1 + r2);
  const dv1 = Math.sqrt(mu * (2 / r1 - 1 / aT)) - Math.sqrt(mu / r1);
  const dv2 = Math.sqrt(mu / r2) - Math.sqrt(mu * (2 / r2 - 1 / aT));
  const tof = PI * Math.sqrt((aT * aT * aT) / mu);
  const phase = wrapPi(PI - Math.sqrt(mu / (r2 * r2 * r2)) * tof);
  return { dv1, dv2, dvTotal: Math.abs(dv1) + Math.abs(dv2), tof, aTransfer: aT, phaseAngle: phase };
}

/**
 * Phase angle (rad, in (-π, π]) from position `from` to position `to`, measured in the plane
 * perpendicular to the unit vector `normal` (default +Y, the system north). Positive = `to` is ahead
 * of `from` in the prograde (counter-clockwise seen from `normal`) direction.
 */
export function phaseAngle(from: V3, to: V3, normal?: V3): number {
  const nx = normal ? normal.x : 0;
  const ny = normal ? normal.y : 1;
  const nz = normal ? normal.z : 0;
  const cx = from.y * to.z - from.z * to.y;
  const cy = from.z * to.x - from.x * to.z;
  const cz = from.x * to.y - from.y * to.x;
  const sinPart = nx * cx + ny * cy + nz * cz;
  const fn = from.x * nx + from.y * ny + from.z * nz;
  const tn = to.x * nx + to.y * ny + to.z * nz;
  const cosPart = from.x * to.x + from.y * to.y + from.z * to.z - fn * tn;
  return sinPart === 0 && cosPart === 0 ? 0 : Math.atan2(sinPart, cosPart);
}

// ===================================================================================== Stumpff functions

let _c2 = 0;
let _c3 = 0;

/** Evaluate both Stumpff functions into the module scratch (_c2 = C(z), _c3 = S(z)). */
function stumpff(z: number): void {
  if (z > 1) {
    const s = Math.sqrt(z);
    _c2 = (1 - Math.cos(s)) / z;
    _c3 = (s - Math.sin(s)) / (z * s);
  } else if (z < -1) {
    const s = Math.sqrt(-z);
    _c2 = (Math.cosh(s) - 1) / -z;
    _c3 = (Math.sinh(s) - s) / (-z * s);
  } else {
    // Power series, accurate to rounding for |z| <= 1 (avoids the 0/0 of the closed forms).
    _c2 =
      0.5 *
      (1 - (z / 12) * (1 - (z / 30) * (1 - (z / 56) * (1 - (z / 90) * (1 - (z / 132) * (1 - (z / 182) * (1 - (z / 240) * (1 - (z / 306) * (1 - z / 380)))))))));
    _c3 =
      (1 / 6) *
      (1 - (z / 20) * (1 - (z / 42) * (1 - (z / 72) * (1 - (z / 110) * (1 - (z / 156) * (1 - (z / 210) * (1 - (z / 272) * (1 - (z / 342) * (1 - z / 420)))))))));
  }
}

/** Stumpff function C(z) = (1 - cos√z)/z (and its analytic continuation for z <= 0). */
export function stumpffC(z: number): number {
  stumpff(z);
  return _c2;
}

/** Stumpff function S(z) = (√z - sin√z)/√z³ (and its analytic continuation for z <= 0). */
export function stumpffS(z: number): number {
  stumpff(z);
  return _c3;
}

// ===================================================================================== Kepler's equation

/** E - sin E without cancellation for small E (`sinE` = sin E, already computed by the caller). */
function eMinusSin(E: number, sinE: number): number {
  if (E < 0.6 && E > -0.6) {
    const x = E * E;
    return ((E * x) / 6) * (1 - (x / 20) * (1 - (x / 42) * (1 - (x / 72) * (1 - (x / 110) * (1 - (x / 156) * (1 - (x / 210) * (1 - x / 272)))))));
  }
  return E - sinE;
}

/** sinh H - H without cancellation for small H (`sinhH` = sinh H). */
function sinhMinus(H: number, sinhH: number): number {
  if (H < 0.6 && H > -0.6) {
    const x = H * H;
    return ((H * x) / 6) * (1 + (x / 20) * (1 + (x / 42) * (1 + (x / 72) * (1 + (x / 110) * (1 + (x / 156) * (1 + (x / 210) * (1 + x / 272)))))));
  }
  return sinhH - H;
}

/** Positive real root of c3·x³ + c1·x = m for c1 >= 0, c3 > 0, m > 0 (cancellation-free Cardano). */
function cubicRoot(c1: number, c3: number, m: number): number {
  const p3 = c1 / (3 * c3);
  const w = m / (2 * c3);
  if (!(w < 1e100)) return Infinity;
  const A = Math.cbrt(w + Math.sqrt(w * w + p3 * p3 * p3));
  const B = p3 / A;
  return (2 * w) / (A * A + p3 + B * B);
}

/** Solve M = E - e·sin E for M in [0, π], e in [0, 1]. Guarded Halley iteration inside a shrinking bracket. */
function keplerEllipticPos(m: number, e: number): number {
  if (!(m > 0)) return 0;
  if (m >= PI) return PI;
  let lo = 0;
  let hi = PI;
  let E: number;
  if (e < 0.7) {
    E = m + e * Math.sin(m);
  } else {
    // Near-parabolic orbits: f(E) <= (1-e)E + eE³/6, so this root is a tight lower bound.
    E = cubicRoot(1 - e, e / 6, m);
    if (E > PI) E = PI;
  }
  for (let it = 0; it < 64; it++) {
    const s = Math.sin(E);
    const c = Math.cos(E);
    const f = (1 - e) * s + eMinusSin(E, s) - m;
    if (f === 0) return E;
    if (f > 0) hi = E;
    else lo = E;
    const fp = 1 - e + e * (1 - c);
    let dE = -f / fp;
    dE = -f / (fp + 0.5 * dE * e * s);
    let En = E + dE;
    if (!(En > lo && En < hi)) En = 0.5 * (lo + hi);
    if (Math.abs(En - E) <= 1e-15 * En) return En;
    E = En;
  }
  return E;
}

/** Solve M = e·sinh H - H for M >= 0, e >= 1. Guarded Halley iteration inside a shrinking bracket. */
function keplerHyperbolicPos(m: number, e: number): number {
  if (!(m > 0)) return 0;
  // Rigorous upper bound: e·sinh H - H >= sinh H - H >= 0.7·sinh H for H >= 3.
  let hi = Math.max(3, Math.asinh(m / 0.7)) + 1e-9;
  let lo = 0;
  // f(H) >= (e-1)H + eH³/6, so this root is a tight upper bound (excellent near e = 1).
  let H = cubicRoot(e - 1, e / 6, m);
  if (!(H < hi)) H = hi;
  for (let it = 0; it < 64; it++) {
    const sh = Math.sinh(H);
    const ch = Math.cosh(H);
    const f = (e - 1) * sh + sinhMinus(H, sh) - m;
    if (f === 0) return H;
    if (f > 0) hi = H;
    else lo = H;
    const fp = e - 1 + e * (ch - 1);
    let dH = -f / fp;
    dH = -f / (fp + 0.5 * dH * e * sh);
    let Hn = H + dH;
    if (!(Hn > lo && Hn < hi)) Hn = 0.5 * (lo + hi);
    if (Math.abs(Hn - H) <= 1e-15 * Hn) return Hn;
    H = Hn;
  }
  return H;
}

/**
 * Solve Kepler's equation M = E - e·sin E for the eccentric anomaly E (rad), 0 <= e <= 1.
 * Any M is accepted; the result lies in the same revolution as M (E - M is 2π-periodic).
 */
export function solveKepler(M: number, e: number): number {
  const k = TAU * Math.round(M / TAU);
  const m = M - k;
  return k + (m < 0 ? -keplerEllipticPos(-m, e) : keplerEllipticPos(m, e));
}

/** Solve the hyperbolic Kepler equation M = e·sinh H - H for H (rad), e >= 1. */
export function solveKeplerHyperbolic(M: number, e: number): number {
  return M < 0 ? -keplerHyperbolicPos(-M, e) : keplerHyperbolicPos(M, e);
}

// ===================================================================================== elements <-> state

let _px = 0;
let _py = 0;
let _pvx = 0;
let _pvy = 0;

/**
 * Position/velocity in the perifocal frame (x toward periapsis, y 90° ahead in the direction of
 * motion) for mean anomaly `M`. Uses forms that stay accurate as e -> 1. Results in _px.._pvy.
 */
function perifocalFromMean(a: number, e: number, mu: number, M: number): void {
  if (a > 0) {
    const m = M - TAU * Math.round(M / TAU);
    const E = m < 0 ? -keplerEllipticPos(-m, e) : keplerEllipticPos(m, e);
    const s = Math.sin(E);
    const c = Math.cos(E);
    const sh = Math.sin(0.5 * E);
    const q = Math.sqrt(Math.abs((1 - e) * (1 + e)));
    const rp = a * (1 - e);
    const lift = 2 * a * sh * sh;
    const r = rp + e * lift;
    const vf = r > 0 ? Math.sqrt(mu * a) / r : 0;
    _px = rp - lift;
    _py = a * q * s;
    _pvx = -vf * s;
    _pvy = vf * q * c;
  } else {
    const A = -a;
    const H = M < 0 ? -keplerHyperbolicPos(-M, e) : keplerHyperbolicPos(M, e);
    const s = Math.sinh(H);
    const c = Math.cosh(H);
    const sh = Math.sinh(0.5 * H);
    const q = Math.sqrt(Math.abs((e - 1) * (e + 1)));
    const rp = A * (e - 1);
    const lift = 2 * A * sh * sh;
    const r = rp + e * lift;
    const vf = r > 0 ? Math.sqrt(mu * A) / r : 0;
    _px = rp - lift;
    _py = A * q * s;
    _pvx = -vf * s;
    _pvy = vf * q * c;
  }
}

/**
 * State vector (relative to the central body) of an orbit given by classical elements at sim time `t`.
 * Writes into `out` and returns it; no allocation.
 *
 * `a` > 0 selects the elliptic branch (e <= 1), `a` < 0 the hyperbolic branch (e >= 1). A true
 * parabola (a = ±Infinity) cannot be expressed in OrbitElements; `stateToElements` never produces one.
 */
export function elementsToStateTo(out: StateVector, el: OrbitElements, mu: number, t: number): StateVector {
  const ci = Math.cos(el.i);
  const si = Math.sin(el.i);
  const cO = Math.cos(el.lan);
  const sO = Math.sin(el.lan);
  const cw = Math.cos(el.argp);
  const sw = Math.sin(el.argp);
  // Perifocal unit vectors P (toward periapsis) and Q in project axes.
  const Px = cO * cw - sO * sw * ci;
  const Py = sw * si;
  const Pz = -(sO * cw + cO * sw * ci);
  const Qx = -cO * sw - sO * cw * ci;
  const Qy = cw * si;
  const Qz = sO * sw - cO * cw * ci;
  const A = Math.abs(el.a);
  perifocalFromMean(el.a, el.e, mu, el.m0 + Math.sqrt(mu / (A * A * A)) * (t - el.epoch));
  out.r.x = _px * Px + _py * Qx;
  out.r.y = _px * Py + _py * Qy;
  out.r.z = _px * Pz + _py * Qz;
  out.v.x = _pvx * Px + _pvy * Qx;
  out.v.y = _pvx * Py + _pvy * Qy;
  out.v.z = _pvx * Pz + _pvy * Qz;
  return out;
}

/** Allocating form of {@link elementsToStateTo}. */
export function elementsToState(el: OrbitElements, mu: number, t: number): StateVector {
  return elementsToStateTo(newState(), el, mu, t);
}

/** Unit normal (angular-momentum direction) of an orbit given by elements. */
export function orbitNormalFromElements(el: OrbitElements, out: V3 = { x: 0, y: 0, z: 0 }): V3 {
  const si = Math.sin(el.i);
  out.x = Math.sin(el.lan) * si;
  out.y = Math.cos(el.i);
  out.z = Math.cos(el.lan) * si;
  return out;
}

let _lastNu = 0;

/**
 * Classical elements of the orbit through state `sv` (relative to a body with `mu`) at sim time `t`
 * (which becomes the epoch). Writes into `out` and returns it; no allocation. Never returns NaN for a
 * finite state with r > 0:
 *   * circular orbits (e < 1e-11) get e = 0, argp = 0 and the mean anomaly measured from the node;
 *   * equatorial orbits (prograde or retrograde) get lan = 0, with the node on +X;
 *   * an exactly parabolic state is nudged to e = 1 ± 1e-13 with the same periapsis;
 *   * a radial (rectilinear) trajectory gets e = 1 with a finite `a` and an arbitrary plane through r.
 * Round trip state -> elements -> state is exact to rounding except in those snapped cases, where the
 * relative error stays below ~1e-10.
 */
export function stateToElementsTo(out: OrbitElements, sv: StateVector, mu: number, t = 0): OrbitElements {
  const rx = sv.r.x;
  const ry = sv.r.y;
  const rz = sv.r.z;
  const vx = sv.v.x;
  const vy = sv.v.y;
  const vz = sv.v.z;
  const r = Math.sqrt(rx * rx + ry * ry + rz * rz);
  const v2 = vx * vx + vy * vy + vz * vz;
  const rv = rx * vx + ry * vy + rz * vz;
  let hx = ry * vz - rz * vy;
  let hy = rz * vx - rx * vz;
  let hz = rx * vy - ry * vx;
  const h2 = hx * hx + hy * hy + hz * hz;
  let alpha = 2 / r - v2 / mu;
  const p = h2 / mu;
  // Eccentricity vector (points at periapsis).
  const k1 = v2 - mu / r;
  let ex = (k1 * rx - rv * vx) / mu;
  let ey = (k1 * ry - rv * vy) / mu;
  let ez = (k1 * rz - rv * vz) / mu;
  let e = Math.sqrt(ex * ex + ey * ey + ez * ez);

  if (h2 <= 1e-24 * r * r * v2) {
    // Radial motion (or at rest): no orbit plane. Pick the plane through r that is as "equatorial" as possible.
    const ux = rx / r;
    const uy = ry / r;
    const uz = rz / r;
    hx = -uy * ux;
    hy = 1 - uy * uy;
    hz = -uy * uz;
    if (hx * hx + hy * hy + hz * hz < 1e-6) {
      hx = 1 - ux * ux;
      hy = -ux * uy;
      hz = -ux * uz;
    }
    ex = -ux;
    ey = -uy;
    ez = -uz;
  }
  const hm = Math.sqrt(hx * hx + hy * hy + hz * hz);
  const wx = hx / hm;
  const wy = hy / hm;
  const wz = hz / hm;

  // Semi-major axis and eccentricity, each taken from the best-conditioned source for the regime.
  let a: number;
  let thin = false;
  if (p <= 1e-6 * r) {
    // Needle-thin or rectilinear: energy is well conditioned, shape comes from p.
    thin = true;
    if (Math.abs(alpha) * r < 1e-12) alpha = 1e-12 / r; // radial *and* parabolic: a very long ellipse
    a = 1 / alpha;
    const pa = p * alpha;
    e = 1 - pa / (1 + Math.sqrt(Math.max(0, 1 - pa)));
  } else if (Math.abs(alpha) * r < 0.1) {
    // Near-parabolic: energy is ill conditioned, so define `a` from p and e (keeps the shape exact).
    if (Math.abs(1 - e) < 1e-13) e = alpha > 0 ? 1 - 1e-13 : 1 + 1e-13;
    a = p / ((1 - e) * (1 + e));
  } else {
    a = 1 / alpha;
  }

  // Orientation: inclination and node.
  const nn = Math.sqrt(wx * wx + wz * wz); // sin(i)
  let inc: number;
  let lan: number;
  let nx: number;
  let nz: number; // unit node vector (nx, 0, nz)
  if (nn < 1e-11) {
    inc = wy >= 0 ? 0 : PI;
    lan = 0;
    nx = 1;
    nz = 0;
  } else {
    inc = Math.atan2(nn, wy);
    lan = wrapTau(Math.atan2(wx, wz));
    nx = wz / nn;
    nz = -wx / nn;
  }

  // Argument of periapsis and true anomaly, both measured in the direction of motion.
  let argp = 0;
  let nu: number;
  if (!thin && e < 1e-11) {
    e = 0;
    // w · (N × r), N · r
    nu = Math.atan2(wx * (-nz * ry) + wy * (nz * rx - nx * rz) + wz * (nx * ry), nx * rx + nz * rz);
  } else {
    argp = wrapTau(Math.atan2(wx * (-nz * ey) + wy * (nz * ex - nx * ez) + wz * (nx * ey), nx * ex + nz * ez));
    nu = Math.atan2(
      wx * (ey * rz - ez * ry) + wy * (ez * rx - ex * rz) + wz * (ex * ry - ey * rx),
      ex * rx + ey * ry + ez * rz,
    );
  }

  let m0: number;
  if (a > 0) {
    let E: number;
    if (thin) {
      E = Math.atan2((rv / Math.sqrt(mu)) * Math.sqrt(alpha), 1 - alpha * r);
      nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(0.5 * E), Math.sqrt(Math.max(0, 1 - e)) * Math.cos(0.5 * E));
    } else {
      E = 2 * Math.atan2(Math.sqrt(Math.max(0, 1 - e)) * Math.sin(0.5 * nu), Math.sqrt(1 + e) * Math.cos(0.5 * nu));
    }
    const s = Math.sin(E);
    m0 = wrapTau((1 - e) * s + eMinusSin(E, s));
  } else {
    let H: number;
    if (thin) {
      H = Math.asinh(((rv / Math.sqrt(mu)) * Math.sqrt(-alpha)) / e);
      nu = 2 * Math.atan2(Math.sqrt(e + 1) * Math.sinh(0.5 * H), Math.sqrt(Math.max(0, e - 1)) * Math.cosh(0.5 * H));
    } else {
      let th = Math.sqrt(Math.max(0, e - 1) / (e + 1)) * Math.tan(0.5 * nu);
      const lim = 1 - 1e-16;
      if (th > lim) th = lim;
      else if (th < -lim) th = -lim;
      H = 2 * Math.atanh(th);
    }
    const s = Math.sinh(H);
    m0 = (e - 1) * s + sinhMinus(H, s);
  }

  _lastNu = nu;
  out.a = a;
  out.e = e;
  out.i = inc;
  out.lan = lan;
  out.argp = argp;
  out.m0 = m0;
  out.epoch = t;
  return out;
}

/** Allocating form of {@link stateToElementsTo}. */
export function stateToElements(sv: StateVector, mu: number, t = 0): OrbitElements {
  return stateToElementsTo(newElements(), sv, mu, t);
}

// ===================================================================================== universal-variable propagation

let _u0 = 1;
let _u1 = 0;
let _u2 = 0;

/**
 * Solve the universal Kepler equation  r0·U1(x) + σ0·U2(x) + U3(x) = target  for x, where
 * target = √mu·dt. Laguerre–Conway iteration, kept inside a bracket (F is monotonic: F' = r > 0),
 * with bisection whenever a step leaves it. Leaves U0, U1, U2 of the solution in _u0.._u2.
 */
function solveUniversal(r0: number, sigma0: number, alpha: number, target: number): void {
  const sgn = target < 0 ? -1 : 1;
  // Keep cosh/sinh finite on hyperbolas.
  const cap = alpha < 0 ? 600 / Math.sqrt(-alpha) : Infinity;
  let lo = sgn > 0 ? 0 : -cap;
  let hi = sgn > 0 ? cap : 0;

  let x: number;
  if (alpha > 0) {
    x = target * alpha;
  } else {
    x = target / r0;
    if (alpha < 0) {
      // Large-time asymptote of the hyperbolic equation.
      const sa = Math.sqrt(-alpha);
      const arg = (-2 * alpha * Math.abs(target) * sa) / (1 - alpha * r0 + sgn * sigma0 * sa);
      if (arg > 1 && arg < Infinity) {
        const xs = (sgn * Math.log(arg)) / sa;
        if (Math.abs(xs) < Math.abs(x)) x = xs;
      }
    }
  }
  if (!(x > lo && x < hi)) x = lo > -Infinity && hi < Infinity ? 0.5 * (lo + hi) : target / r0;

  for (let it = 0; it < 80; it++) {
    const x2 = x * x;
    const z = alpha * x2;
    stumpff(z);
    const u0 = 1 - z * _c2;
    const u1 = x * (1 - z * _c3);
    const u2 = x2 * _c2;
    const u3 = x2 * x * _c3;
    _u0 = u0;
    _u1 = u1;
    _u2 = u2;
    const F = r0 * u1 + sigma0 * u2 + u3 - target;
    if (F === 0) return;
    if (F < 0) lo = x;
    else hi = x;
    const Fp = r0 * u0 + sigma0 * u1 + u2;
    const Fpp = sigma0 * u0 + (1 - alpha * r0) * u1;
    const disc = Math.sqrt(Math.abs(16 * Fp * Fp - 20 * F * Fpp));
    let xn = x - (5 * F) / (Fp + (Fp >= 0 ? disc : -disc));
    if (!(xn > lo && xn < hi)) {
      if (lo > -Infinity && hi < Infinity) xn = 0.5 * (lo + hi);
      else if (hi === Infinity) xn = lo > 0 ? 2 * lo : Math.abs(target / r0);
      else xn = hi < 0 ? 2 * hi : -Math.abs(target / r0);
    }
    if (Math.abs(xn - x) <= 1e-15 * Math.abs(xn)) return;
    x = xn;
  }
}

/**
 * Kepler propagation: advance state `sv` (relative to a body with `mu`) by `dt` seconds along its
 * conic. Valid for every conic (elliptic, parabolic, hyperbolic, rectilinear), forward (dt > 0) and
 * backward (dt < 0), any |dt| (whole periods are removed first on closed orbits).
 * Writes into `out` (which may be `sv` itself) and returns it; no allocation.
 * A non-finite `dt` is treated as 0.
 */
export function propagateStateTo(out: StateVector, sv: StateVector, mu: number, dt: number): StateVector {
  const rx = sv.r.x;
  const ry = sv.r.y;
  const rz = sv.r.z;
  const vx = sv.v.x;
  const vy = sv.v.y;
  const vz = sv.v.z;
  if (!(dt < Infinity && dt > -Infinity)) dt = 0;
  const r0 = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (dt === 0 || !(r0 > 0) || !(mu > 0)) {
    // No time passes, or there is no gravity: straight line.
    out.r.x = rx + vx * dt;
    out.r.y = ry + vy * dt;
    out.r.z = rz + vz * dt;
    out.v.x = vx;
    out.v.y = vy;
    out.v.z = vz;
    return out;
  }
  const sqrtMu = Math.sqrt(mu);
  const sigma0 = (rx * vx + ry * vy + rz * vz) / sqrtMu;
  const alpha = 2 / r0 - (vx * vx + vy * vy + vz * vz) / mu;
  let tau = dt;
  if (alpha > 0) {
    const period = TAU / (sqrtMu * alpha * Math.sqrt(alpha));
    if (Math.abs(dt) > 0.5 * period) tau = dt - period * Math.round(dt / period);
  }
  solveUniversal(r0, sigma0, alpha, sqrtMu * tau);
  const r = r0 * _u0 + sigma0 * _u1 + _u2;
  const f = 1 - _u2 / r0;
  const g = (r0 * _u1 + sigma0 * _u2) / sqrtMu;
  const fd = (-sqrtMu * _u1) / (r * r0);
  const gd = 1 - _u2 / r;
  out.r.x = f * rx + g * vx;
  out.r.y = f * ry + g * vy;
  out.r.z = f * rz + g * vz;
  out.v.x = fd * rx + gd * vx;
  out.v.y = fd * ry + gd * vy;
  out.v.z = fd * rz + gd * vz;
  return out;
}

/** Allocating form of {@link propagateStateTo}. */
export function propagateState(sv: StateVector, mu: number, dt: number): StateVector {
  return propagateStateTo(newState(), sv, mu, dt);
}

// ===================================================================================== conic scalars & timing

/** Scalar description of the conic through a state; internal scratch type. */
interface Conic {
  mu: number;
  sqrtMu: number;
  /** Current radius, m. */
  r: number;
  v2: number;
  /** r·v / √mu. Positive when moving away from the body. */
  sigma: number;
  /** 1/a (2/r - v²/mu); > 0 ellipse, 0 parabola, < 0 hyperbola. */
  alpha: number;
  /** |r × v|. */
  h: number;
  /** Semi-latus rectum, m. */
  p: number;
  e: number;
  /** Periapsis radius, m. */
  rp: number;
  /** Apoapsis radius, m (Infinity when open). */
  ra: number;
  /** Period, s (Infinity when open). */
  period: number;
  /** Time since periapsis passage, s; in (-T/2, T/2] on closed orbits, negative before periapsis. */
  tNow: number;
}

const newConic = (): Conic => ({ mu: 0, sqrtMu: 0, r: 0, v2: 0, sigma: 0, alpha: 0, h: 0, p: 0, e: 0, rp: 0, ra: 0, period: 0, tNow: 0 });

function conicFromState(c: Conic, sv: StateVector, mu: number): void {
  const rx = sv.r.x;
  const ry = sv.r.y;
  const rz = sv.r.z;
  const vx = sv.v.x;
  const vy = sv.v.y;
  const vz = sv.v.z;
  const r = Math.sqrt(rx * rx + ry * ry + rz * rz);
  const v2 = vx * vx + vy * vy + vz * vz;
  const sqrtMu = Math.sqrt(mu);
  const sigma = (rx * vx + ry * vy + rz * vz) / sqrtMu;
  const alpha = 2 / r - v2 / mu;
  const hx = ry * vz - rz * vy;
  const hy = rz * vx - rx * vz;
  const hz = rx * vy - ry * vx;
  const h2 = hx * hx + hy * hy + hz * hz;
  const p = h2 / mu;
  // Each branch is a sum of non-negative terms: no cancellation anywhere.
  const k = 1 - alpha * r;
  const e = alpha >= 0 ? Math.sqrt(k * k + alpha * sigma * sigma) : Math.sqrt(1 - p * alpha);
  const rp = p / (1 + e);
  c.mu = mu;
  c.sqrtMu = sqrtMu;
  c.r = r;
  c.v2 = v2;
  c.sigma = sigma;
  c.alpha = alpha;
  c.h = Math.sqrt(h2);
  c.p = p;
  c.e = e;
  c.rp = rp;
  let chi: number;
  let z: number;
  if (alpha > 0) {
    const sa = Math.sqrt(alpha);
    c.period = TAU / (sqrtMu * alpha * sa);
    c.ra = c.period < Infinity ? (1 + e) / alpha : Infinity;
    const E = Math.atan2(sigma * sa, k);
    chi = E / sa;
    z = E * E;
  } else if (alpha < 0) {
    c.period = Infinity;
    c.ra = Infinity;
    const sa = Math.sqrt(-alpha);
    const H = Math.asinh((sigma * sa) / e);
    chi = H / sa;
    z = -H * H;
  } else {
    c.period = Infinity;
    c.ra = Infinity;
    chi = sigma;
    z = 0;
  }
  stumpff(z);
  c.tNow = (chi * (rp + e * chi * chi * _c3)) / sqrtMu;
}

/** Time (s, >= 0) from periapsis to the outward crossing of radius R, rp <= R <= ra. All conics. */
function timeFromPeriapsisToRadius(c: Conic, R: number): number {
  const w = (R - c.rp) / c.e;
  if (!(w > 0)) return 0;
  const al = c.alpha;
  let chi: number;
  let z: number;
  if (al > 0) {
    const q = 0.5 * al * w;
    if (q >= 1) return 0.5 * c.period;
    const E = 2 * Math.asin(Math.sqrt(q));
    chi = E / Math.sqrt(al);
    z = E * E;
  } else if (al < 0) {
    const H = 2 * Math.asinh(Math.sqrt(-0.5 * al * w));
    chi = H / Math.sqrt(-al);
    z = -H * H;
  } else {
    chi = Math.sqrt(2 * w);
    z = 0;
  }
  stumpff(z);
  return (chi * (c.rp + c.e * chi * chi * _c3)) / c.sqrtMu;
}

/** Signed time (s) from periapsis to true anomaly `nu` in (-π, π]. ±Infinity beyond a hyperbola's asymptote. */
function timeFromPeriapsisToNu(c: Conic, nu: number): number {
  const sh = Math.sin(0.5 * nu);
  const ch = Math.cos(0.5 * nu);
  const al = c.alpha;
  const k = Math.sqrt(1 + c.e);
  let chi: number;
  let z: number;
  if (al > 0) {
    const E = 2 * Math.atan2(Math.sqrt(al * c.rp) * sh, k * ch);
    chi = E / Math.sqrt(al);
    z = E * E;
  } else if (al < 0) {
    const th = (Math.sqrt(-al * c.rp) * sh) / (k * ch);
    if (!(th > -1 && th < 1)) return sh >= 0 ? Infinity : -Infinity;
    const H = 2 * Math.atanh(th);
    chi = H / Math.sqrt(-al);
    z = -H * H;
  } else {
    if (!(ch > 1e-300)) return sh >= 0 ? Infinity : -Infinity;
    chi = (Math.sqrt(2 * c.rp) * sh) / ch;
    z = 0;
  }
  stumpff(z);
  return (chi * (c.rp + c.e * chi * chi * _c3)) / c.sqrtMu;
}

/** Time (s, >= 0) until the conic next crosses radius R outward / inward; Infinity if it never does. */
function crossingDt(c: Conic, R: number, outward: boolean): number {
  if (!(R >= c.rp && R <= c.ra)) return Infinity;
  const tR = timeFromPeriapsisToRadius(c, R);
  let d = (outward ? tR : -tR) - c.tNow;
  if (d < 0) {
    // "Exactly now" within rounding counts as now.
    if (d > -1e-10 * Math.sqrt((c.r * c.r * c.r) / c.mu)) return 0;
    if (!(c.period < Infinity)) return Infinity;
    d += c.period;
    if (d < 0) d = 0;
  }
  return d;
}

const _cq = newConic();

/** Direction of a radius crossing: moving away from the body, or toward it. */
export type RadiusCrossing = 'outward' | 'inward';

/**
 * Time (s, >= 0) from state `sv` until its conic next crosses the sphere of radius `radius` (m, from
 * the body centre) in the given direction: 'outward' for an SOI exit, 'inward' for atmosphere entry or
 * surface impact. Returns Infinity if that never happens (radius outside [periapsis, apoapsis], or the
 * crossing is already behind on an open orbit). Exact (closed form), valid for every conic.
 */
export function timeToRadius(sv: StateVector, mu: number, radius: number, direction: RadiusCrossing): number {
  conicFromState(_cq, sv, mu);
  return crossingDt(_cq, radius, direction === 'outward');
}

/**
 * Time (s, >= 0) from state `sv` until the true anomaly equals `nu` (rad, any revolution).
 * Closed orbits: within one period. Open orbits: Infinity if `nu` is behind or beyond the asymptote.
 */
export function timeToTrueAnomaly(sv: StateVector, mu: number, nu: number): number {
  const c = _cq;
  conicFromState(c, sv, mu);
  const tT = timeFromPeriapsisToNu(c, wrapPi(nu));
  if (!(tT < Infinity && tT > -Infinity)) return Infinity;
  let d = tT - c.tNow;
  if (c.period < Infinity) {
    d -= c.period * Math.floor(d / c.period);
    if (!(d >= 0 && d < c.period)) d = 0;
    return d;
  }
  if (d < 0) return d > -1e-10 * Math.sqrt((c.r * c.r * c.r) / mu) ? 0 : Infinity;
  return d;
}

/** Unit orbit normal (direction of r × v). Falls back to +Y for radial motion. */
export function orbitNormal(sv: StateVector, out: V3 = { x: 0, y: 0, z: 0 }): V3 {
  const hx = sv.r.y * sv.v.z - sv.r.z * sv.v.y;
  const hy = sv.r.z * sv.v.x - sv.r.x * sv.v.z;
  const hz = sv.r.x * sv.v.y - sv.r.y * sv.v.x;
  const h = Math.sqrt(hx * hx + hy * hy + hz * hz);
  if (h > 0) {
    out.x = hx / h;
    out.y = hy / h;
    out.z = hz / h;
  } else {
    out.x = 0;
    out.y = 1;
    out.z = 0;
  }
  return out;
}

/** Angle (rad, 0..π) between the planes of two orbits around the same body. */
export function relativeInclination(svA: StateVector, svB: StateVector): number {
  const ax = svA.r.y * svA.v.z - svA.r.z * svA.v.y;
  const ay = svA.r.z * svA.v.x - svA.r.x * svA.v.z;
  const az = svA.r.x * svA.v.y - svA.r.y * svA.v.x;
  const bx = svB.r.y * svB.v.z - svB.r.z * svB.v.y;
  const by = svB.r.z * svB.v.x - svB.r.x * svB.v.z;
  const bz = svB.r.x * svB.v.y - svB.r.y * svB.v.x;
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  const s = Math.sqrt(cx * cx + cy * cy + cz * cz);
  const d = ax * bx + ay * by + az * bz;
  return s === 0 && d === 0 ? 0 : Math.atan2(s, d);
}

/** Which node of an orbit relative to a reference plane. */
export type NodeKind = 'ascending' | 'descending';

/**
 * Time (s, >= 0) from state `sv` until it next crosses the plane with unit normal `refNormal`
 * through the body centre: 'ascending' = crossing toward the +refNormal side, 'descending' = toward
 * the other side. Pass `orbitNormal(targetSv)` for the node relative to a target's orbit, or +Y for
 * the equatorial node. Infinity when the planes coincide (no node) or, on an open orbit, when the
 * node is behind or beyond the asymptote.
 */
export function timeToNode(sv: StateVector, mu: number, refNormal: V3, which: NodeKind): number {
  const rx = sv.r.x;
  const ry = sv.r.y;
  const rz = sv.r.z;
  const hx = ry * sv.v.z - rz * sv.v.y;
  const hy = rz * sv.v.x - rx * sv.v.z;
  const hz = rx * sv.v.y - ry * sv.v.x;
  const h = Math.sqrt(hx * hx + hy * hy + hz * hz);
  // Ascending-node direction N = refNormal × h.
  let nx = refNormal.y * hz - refNormal.z * hy;
  let ny = refNormal.z * hx - refNormal.x * hz;
  let nz = refNormal.x * hy - refNormal.y * hx;
  const n = Math.sqrt(nx * nx + ny * ny + nz * nz);
  const refLen = Math.sqrt(refNormal.x * refNormal.x + refNormal.y * refNormal.y + refNormal.z * refNormal.z);
  if (!(h > 0) || !(n > 1e-12 * h * refLen)) return Infinity;
  if (which === 'descending') {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  // Angle from the current position to the node, in the direction of motion.
  const cx = ry * nz - rz * ny;
  const cy = rz * nx - rx * nz;
  const cz = rx * ny - ry * nx;
  const theta = Math.atan2((hx * cx + hy * cy + hz * cz) / h, rx * nx + ry * ny + rz * nz);
  const c = _cq;
  conicFromState(c, sv, mu);
  // True anomaly now, from the same scalars the timing uses.
  const nuNow = trueAnomalyOfConic(c);
  const tT = timeFromPeriapsisToNu(c, wrapPi(nuNow + theta));
  if (!(tT < Infinity && tT > -Infinity)) return Infinity;
  let d = tT - c.tNow;
  if (c.period < Infinity) {
    d -= c.period * Math.floor(d / c.period);
    if (!(d >= 0 && d < c.period)) d = 0;
    // A node "exactly behind us" by rounding is the node we are sitting on.
    if (c.period - d < 1e-10 * c.period) d = 0;
    return d;
  }
  if (d < 0) return d > -1e-10 * Math.sqrt((c.r * c.r * c.r) / mu) ? 0 : Infinity;
  return d;
}

/** True anomaly (rad, (-π, π]) of the current position, from conic scalars only. */
function trueAnomalyOfConic(c: Conic): number {
  // e·cos ν = p/r - 1 ;  e·sin ν = σ·√p / r
  const y = (c.sigma * Math.sqrt(c.p)) / c.r;
  const x = c.p / c.r - 1;
  return x === 0 && y === 0 ? 0 : Math.atan2(y, x);
}

// ===================================================================================== orbit summary

export interface OrbitInfo {
  /** Classical elements with epoch = the `t` passed to orbitInfo. */
  elements: OrbitElements;
  /** True for bound (elliptic) orbits. */
  closed: boolean;
  /** Semi-major axis, m (negative for hyperbolas). */
  a: number;
  e: number;
  /** Inclination to the XZ reference plane, rad. */
  i: number;
  /** Period, s (Infinity when open). */
  period: number;
  /** Periapsis radius from the body centre, m. */
  periapsis: number;
  /** Apoapsis radius from the body centre, m (Infinity when open). */
  apoapsis: number;
  /**
   * Seconds until the next periapsis passage. Closed orbits: in [0, period). Open orbits: positive
   * while inbound, negative (= minus the time since periapsis) once outbound.
   */
  timeToPeriapsis: number;
  /** Seconds until the next apoapsis passage, in [0, period); Infinity when open. */
  timeToApoapsis: number;
  /** True anomaly now, rad in (-π, π]. For circular orbits measured from the ascending node (or +X). */
  trueAnomaly: number;
  /** Specific orbital energy v²/2 - mu/r, J/kg (negative when bound). */
  energy: number;
  /** Specific angular momentum r × v, m²/s. */
  h: V3;
  /** Eccentricity vector (points at periapsis, length e). */
  eVec: V3;
  /** Semi-latus rectum, m. */
  semiLatusRectum: number;
  /** Current distance from the body centre, m. */
  radius: number;
  /** Current speed, m/s. */
  speed: number;
  /** Current radial (vertical) speed, m/s; positive = climbing. */
  radialSpeed: number;
}

/**
 * Everything the HUD and map want to know about the orbit through `sv` around a body with `mu`.
 * `t` (sim seconds) is only used as the epoch of the returned elements. Allocates; call it when the
 * numbers are displayed, not in inner loops.
 */
export function orbitInfo(sv: StateVector, mu: number, t = 0): OrbitInfo {
  const elements = stateToElementsTo(newElements(), sv, mu, t);
  const nu = _lastNu;
  const c = _cq;
  conicFromState(c, sv, mu);
  const closed = c.period < Infinity;
  const rx = sv.r.x;
  const ry = sv.r.y;
  const rz = sv.r.z;
  const vx = sv.v.x;
  const vy = sv.v.y;
  const vz = sv.v.z;
  const rv = rx * vx + ry * vy + rz * vz;
  const k1 = c.v2 - mu / c.r;
  let tPe: number;
  let tAp: number;
  if (closed) {
    tPe = c.tNow <= 0 ? -c.tNow : c.period - c.tNow;
    tAp = 0.5 * c.period - c.tNow;
    if (tAp < 0) tAp += c.period;
  } else {
    tPe = -c.tNow;
    tAp = Infinity;
  }
  return {
    elements,
    closed,
    a: elements.a,
    e: elements.e,
    i: elements.i,
    period: c.period,
    periapsis: c.rp,
    apoapsis: c.ra,
    timeToPeriapsis: tPe,
    timeToApoapsis: tAp,
    trueAnomaly: nu,
    energy: -0.5 * mu * c.alpha,
    h: { x: ry * vz - rz * vy, y: rz * vx - rx * vz, z: rx * vy - ry * vx },
    eVec: { x: (k1 * rx - rv * vx) / mu, y: (k1 * ry - rv * vy) / mu, z: (k1 * rz - rv * vz) / mu },
    semiLatusRectum: c.p,
    radius: c.r,
    speed: Math.sqrt(c.v2),
    radialSpeed: c.r > 0 ? rv / c.r : 0,
  };
}

export interface OrbitalFrame {
  /** Unit vector along the velocity. */
  prograde: V3;
  /** Unit vector along r × v (orbit normal; +Y for a prograde equatorial orbit). */
  normal: V3;
  /** prograde × normal: in the orbit plane, pointing away from the body on a circular orbit. */
  radial: V3;
}

/** A fresh orbital frame (prograde -Z, normal +Y, radial +X). */
export const newOrbitalFrame = (): OrbitalFrame => ({ prograde: { x: 0, y: 0, z: -1 }, normal: { x: 0, y: 1, z: 0 }, radial: { x: 1, y: 0, z: 0 } });

/**
 * Orthonormal manoeuvre frame of a state: prograde (v̂), normal ((r × v)^) and radial
 * (prograde × normal). Burn components are expressed along these. Always returns a valid
 * right-handed orthonormal triad, even for zero velocity or purely radial motion.
 * Writes into `out` and returns it; no allocation.
 */
export function orbitalFrameTo(out: OrbitalFrame, sv: StateVector): OrbitalFrame {
  const rx = sv.r.x;
  const ry = sv.r.y;
  const rz = sv.r.z;
  let px = sv.v.x;
  let py = sv.v.y;
  let pz = sv.v.z;
  let pl = Math.sqrt(px * px + py * py + pz * pz);
  const rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (!(pl > 0)) {
    // At rest: call "prograde" the direction a prograde circular orbit would move (+Y × r).
    px = rz;
    py = 0;
    pz = -rx;
    pl = Math.sqrt(px * px + pz * pz);
    if (!(pl > 0)) {
      px = 0;
      pz = -1;
      pl = 1;
    }
  }
  px /= pl;
  py /= pl;
  pz /= pl;
  // normal = r × prograde, made exactly perpendicular to prograde.
  let nx = ry * pz - rz * py;
  let ny = rz * px - rx * pz;
  let nz = rx * py - ry * px;
  let nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!(nl > 1e-12 * rl)) {
    // Radial motion: take the direction perpendicular to prograde that is closest to +Y (else +X).
    nx = -py * px;
    ny = 1 - py * py;
    nz = -py * pz;
    nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nl < 1e-6) {
      nx = 1 - px * px;
      ny = -px * py;
      nz = -px * pz;
      nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    }
  }
  nx /= nl;
  ny /= nl;
  nz /= nl;
  out.prograde.x = px;
  out.prograde.y = py;
  out.prograde.z = pz;
  out.normal.x = nx;
  out.normal.y = ny;
  out.normal.z = nz;
  out.radial.x = py * nz - pz * ny;
  out.radial.y = pz * nx - px * nz;
  out.radial.z = px * ny - py * nx;
  return out;
}

/** Allocating form of {@link orbitalFrameTo}. */
export function orbitalFrame(sv: StateVector): OrbitalFrame {
  return orbitalFrameTo(newOrbitalFrame(), sv);
}

// ===================================================================================== closest approach

export interface Approach {
  /** Sim time of the approach, s. */
  t: number;
  /** Separation at that time, m. */
  distance: number;
  /** Relative speed at that time, m/s. */
  relSpeed: number;
}

export interface ApproachOptions {
  /** Sim time at which `svA` and `svB` are valid, s. Default: `tStart`. */
  epoch?: number;
  /** Upper bound on scan samples (each costs two Kepler propagations). Default 6000. */
  maxSamples?: number;
}

const _caA = newState();
const _caB = newState();
let _caD2 = 0;
let _caS = 0;
let _caV2 = 0;
let _caRmin = 0;

/** Relative geometry of A and B `dt` seconds after their epoch, into the _ca scratch. */
function relEval(svA: StateVector, svB: StateVector, mu: number, dt: number): void {
  propagateStateTo(_caA, svA, mu, dt);
  propagateStateTo(_caB, svB, mu, dt);
  const dx = _caB.r.x - _caA.r.x;
  const dy = _caB.r.y - _caA.r.y;
  const dz = _caB.r.z - _caA.r.z;
  const dvx = _caB.v.x - _caA.v.x;
  const dvy = _caB.v.y - _caA.v.y;
  const dvz = _caB.v.z - _caA.v.z;
  _caD2 = dx * dx + dy * dy + dz * dz;
  _caS = dx * dvx + dy * dvy + dz * dvz;
  _caV2 = dvx * dvx + dvy * dvy + dvz * dvz;
  const ra2 = _caA.r.x * _caA.r.x + _caA.r.y * _caA.r.y + _caA.r.z * _caA.r.z;
  const rb2 = _caB.r.x * _caB.r.x + _caB.r.y * _caB.r.y + _caB.r.z * _caB.r.z;
  _caRmin = Math.sqrt(Math.min(ra2, rb2));
}

/**
 * Every local minimum of the separation between two objects orbiting the same body, for
 * tStart <= t <= tEnd, in time order. `svA` / `svB` are their states at `opts.epoch` (default
 * tStart). The window ends count as minima when the objects are separating at tStart / still
 * closing at tEnd, so the result is never empty.
 *
 * Method: adaptive scan of the range rate (step ≈ 1/40 of the local circular period, so fast
 * periapsis passes are sampled densely), then every closing→opening sign change is refined by a
 * bracketed secant (Illinois) iteration to ~1e-7 s. A V-shaped fast flyby is therefore found no
 * matter how narrow it is.
 */
export function closestApproaches(
  svA: StateVector,
  svB: StateVector,
  mu: number,
  tStart: number,
  tEnd: number,
  opts: ApproachOptions = {},
): Approach[] {
  const t0 = opts.epoch ?? tStart;
  const maxSamples = Math.max(16, opts.maxSamples ?? 6000);
  const out: Approach[] = [];
  const here = (t: number): Approach => ({ t, distance: Math.sqrt(_caD2), relSpeed: Math.sqrt(_caV2) });
  relEval(svA, svB, mu, tStart - t0);
  const span = tEnd - tStart;
  if (!(span > 0)) {
    out.push(here(tStart));
    return out;
  }
  const minStep = span / maxSamples;
  const maxStep = span / 16;
  let t = tStart;
  let s = _caS;
  if (s >= 0) out.push(here(t));
  while (t < tEnd) {
    let step = 0.15 * Math.sqrt((_caRmin * _caRmin * _caRmin) / mu);
    if (!(step > minStep)) step = minStep;
    if (step > maxStep) step = maxStep;
    let tn = t + step;
    if (tn >= tEnd || tEnd - tn < 0.25 * step) tn = tEnd;
    relEval(svA, svB, mu, tn - t0);
    const sn = _caS;
    const rmin = _caRmin;
    if (s < 0 && sn >= 0) {
      // Bracketed root of the range rate: closing at `a`, opening at `b`.
      let a = t;
      let fa = s;
      let b = tn;
      let fb = sn;
      let side = 0;
      const tol = Math.max(1e-7, 1e-13 * Math.max(Math.abs(a), Math.abs(b)));
      for (let it = 0; it < 80 && b - a > tol; it++) {
        let m = b - (fb * (b - a)) / (fb - fa);
        if (!(m > a && m < b)) m = 0.5 * (a + b);
        relEval(svA, svB, mu, m - t0);
        const fm = _caS;
        if (fm < 0) {
          a = m;
          fa = fm;
          if (side === -1) fb *= 0.5;
          side = -1;
        } else {
          b = m;
          fb = fm;
          if (side === 1) fa *= 0.5;
          side = 1;
        }
      }
      const tm = 0.5 * (a + b);
      relEval(svA, svB, mu, tm - t0);
      out.push(here(tm));
    }
    s = sn;
    _caRmin = rmin;
    t = tn;
  }
  if (s < 0) {
    relEval(svA, svB, mu, tEnd - t0);
    out.push(here(tEnd));
  }
  return out;
}

/**
 * Closest approach between two objects orbiting the same body within tStart <= t <= tEnd: time (s),
 * separation (m) and relative speed (m/s). `svA` / `svB` are their states at `opts.epoch` (default
 * tStart). See {@link closestApproaches} for the method.
 */
export function closestApproach(
  svA: StateVector,
  svB: StateVector,
  mu: number,
  tStart: number,
  tEnd: number,
  opts: ApproachOptions = {},
): Approach {
  const all = closestApproaches(svA, svB, mu, tStart, tEnd, opts);
  let best = all[0];
  for (let i = 1; i < all.length; i++) if (all[i].distance < best.distance) best = all[i];
  return best;
}

// ===================================================================================== bodies on rails

/** A fixed Kepler orbit with everything time-independent precomputed. */
class Rail {
  readonly el: OrbitElements;
  readonly mu: number;
  private readonly n: number;
  private readonly Px: number;
  private readonly Py: number;
  private readonly Pz: number;
  private readonly Qx: number;
  private readonly Qy: number;
  private readonly Qz: number;

  constructor(el: OrbitElements, mu: number) {
    this.el = el;
    this.mu = mu;
    const A = Math.abs(el.a);
    this.n = Math.sqrt(mu / (A * A * A));
    const ci = Math.cos(el.i);
    const si = Math.sin(el.i);
    const cO = Math.cos(el.lan);
    const sO = Math.sin(el.lan);
    const cw = Math.cos(el.argp);
    const sw = Math.sin(el.argp);
    this.Px = cO * cw - sO * sw * ci;
    this.Py = sw * si;
    this.Pz = -(sO * cw + cO * sw * ci);
    this.Qx = -cO * sw - sO * cw * ci;
    this.Qy = cw * si;
    this.Qz = sO * sw - cO * cw * ci;
  }

  /** State relative to the orbited body at sim time `t`, into `out`. Identical to elementsToStateTo. */
  eval(t: number, out: StateVector): StateVector {
    const el = this.el;
    perifocalFromMean(el.a, el.e, this.mu, el.m0 + this.n * (t - el.epoch));
    out.r.x = _px * this.Px + _py * this.Qx;
    out.r.y = _px * this.Py + _py * this.Qy;
    out.r.z = _px * this.Pz + _py * this.Qz;
    out.v.x = _pvx * this.Px + _pvy * this.Qx;
    out.v.y = _pvx * this.Py + _pvy * this.Qy;
    out.v.z = _pvx * this.Pz + _pvy * this.Qz;
    return out;
  }
}

/** Copy of `body` with `mu` = G·mass and `soi` recomputed from its orbit and `parent` (Infinity for the primary); tidally locked bodies also get rotationPeriod = orbital period. */
export function deriveBodyFields(body: BodyDef, parent: BodyDef | null): BodyDef {
  const mu = G * body.mass;
  let soi = Infinity;
  let rotationPeriod = body.rotationPeriod;
  if (parent && body.orbit) {
    soi = soiRadius(Math.abs(body.orbit.a), body.mass, parent.mass);
    if (body.tidallyLocked) rotationPeriod = orbitalPeriod(G * parent.mass, body.orbit.a);
  }
  return { ...body, mu, soi, rotationPeriod };
}

/**
 * Copy of a system with the derived fields of every body recomputed (see {@link deriveBodyFields}).
 * Use after generating or editing masses / orbits so `mu` and `soi` stay physically consistent.
 */
export function deriveSystem(def: SystemDef): SystemDef {
  const done = new Map<string, BodyDef>();
  const bodies = def.bodies.map((b) => {
    const nb = deriveBodyFields(b, b.parentId === null ? null : (done.get(b.parentId) ?? null));
    done.set(nb.id, nb);
    return nb;
  });
  return { ...def, bodies };
}

/**
 * Kepler-rails model of one star system, built once from a SystemDef (which it treats as immutable).
 *
 * Frames: `bodyState` is relative to the body's parent; `...AbsState` is relative to the primary
 * star. All states are in non-rotating system axes, SI units. Every state method takes an optional
 * `out` to write into (no allocation) and returns it; without `out` a new StateVector is returned.
 * Body states are cached per body for the last time asked, so asking for every body every frame
 * (and for children after their parents) costs one Kepler solve per body.
 *
 * Unknown ids throw: they are programming errors, not runtime conditions.
 */
export class SystemModel {
  readonly def: SystemDef;
  /** All bodies, primary first, parents before children (same order as the SystemDef). */
  readonly bodies: readonly BodyDef[];
  /** The primary star (the origin of absolute coordinates). */
  readonly primary: BodyDef;
  /** Circular arrival orbit of the jump beacon around `def.jumpBeacon.bodyId` (reference plane, phase 0 at t = 0). */
  readonly beaconOrbit: OrbitElements;

  /** @internal Rail of each body (null for the primary), index-aligned with `bodies`. */
  readonly _rails: (Rail | null)[] = [];
  /** @internal Parent index of each body (-1 for the primary). */
  readonly _parent: number[] = [];
  /** @internal Child indices of each body. */
  readonly _children: number[][] = [];

  private readonly index = new Map<string, number>();
  private readonly childDefs: BodyDef[][] = [];
  private readonly relCache: StateVector[] = [];
  private readonly absCache: StateVector[] = [];
  private readonly relTime: number[] = [];
  private readonly absTime: number[] = [];
  private readonly orbiters = new Map<string, { rail: Rail; parent: number }>();
  private readonly stations = new Map<string, StationDef>();
  private readonly sites = new Map<string, MiningSiteDef>();
  private readonly beaconParent: number;
  private readonly tmp = newState();

  constructor(def: SystemDef) {
    this.def = def;
    this.bodies = def.bodies;
    if (def.bodies.length === 0 || def.bodies[0].parentId !== null) {
      throw new Error(`SystemModel(${def.id}): the first body must be the primary star`);
    }
    this.primary = def.bodies[0];
    def.bodies.forEach((b, i) => {
      if (this.index.has(b.id)) throw new Error(`SystemModel(${def.id}): duplicate body id ${b.id}`);
      let parent = -1;
      if (i > 0) {
        const p = b.parentId === null ? undefined : this.index.get(b.parentId);
        if (p === undefined || !b.orbit) {
          throw new Error(`SystemModel(${def.id}): body ${b.id} needs an orbit around a parent listed before it`);
        }
        parent = p;
        this._children[p].push(i);
        this.childDefs[p].push(b);
      }
      this.index.set(b.id, i);
      this._parent.push(parent);
      this._children.push([]);
      this.childDefs.push([]);
      this._rails.push(parent >= 0 && b.orbit ? new Rail(b.orbit, def.bodies[parent].mu) : null);
      this.relCache.push(newState());
      this.absCache.push(newState());
      this.relTime.push(NaN);
      this.absTime.push(NaN);
    });
    for (const s of def.stations) {
      const p = this.indexOf(s.parentBodyId);
      this.stations.set(s.id, s);
      this.orbiters.set(s.id, { rail: new Rail(s.orbit, def.bodies[p].mu), parent: p });
    }
    for (const s of def.miningSites) {
      const p = this.indexOf(s.parentBodyId);
      this.sites.set(s.id, s);
      this.orbiters.set(s.id, { rail: new Rail(s.orbit, def.bodies[p].mu), parent: p });
    }
    this.beaconParent = this.indexOf(def.jumpBeacon.bodyId);
    this.beaconOrbit = { a: def.jumpBeacon.orbitRadius, e: 0, i: 0, lan: 0, argp: 0, m0: 0, epoch: 0 };
  }

  // ---------------------------------------------------------------- lookup

  /** Index of a body in `bodies`. Throws on an unknown id. */
  indexOf(bodyId: string): number {
    const i = this.index.get(bodyId);
    if (i === undefined) throw new Error(`SystemModel(${this.def.id}): unknown body ${bodyId}`);
    return i;
  }

  hasBody(bodyId: string): boolean {
    return this.index.has(bodyId);
  }

  /** Body definition by id. */
  body(bodyId: string): BodyDef {
    return this.bodies[this.indexOf(bodyId)];
  }

  /** Parent body, or null for the primary. */
  parent(bodyId: string): BodyDef | null {
    const p = this._parent[this.indexOf(bodyId)];
    return p < 0 ? null : this.bodies[p];
  }

  /** Bodies orbiting `bodyId` directly (planets of the star, moons of a planet), in definition order. */
  children(bodyId: string): readonly BodyDef[] {
    return this.childDefs[this.indexOf(bodyId)];
  }

  /** 0 for the primary, 1 for its planets, 2 for moons… */
  depth(bodyId: string): number {
    let d = 0;
    for (let i = this._parent[this.indexOf(bodyId)]; i >= 0; i = this._parent[i]) d++;
    return d;
  }

  /** Station definition by id. */
  station(stationId: string): StationDef {
    const s = this.stations.get(stationId);
    if (!s) throw new Error(`SystemModel(${this.def.id}): unknown station ${stationId}`);
    return s;
  }

  /** Mining-site definition by id. */
  site(siteId: string): MiningSiteDef {
    const s = this.sites.get(siteId);
    if (!s) throw new Error(`SystemModel(${this.def.id}): unknown mining site ${siteId}`);
    return s;
  }

  // ---------------------------------------------------------------- bodies

  /** @internal Cached state of body `i` relative to its parent at `t`. The returned object is owned by the model. */
  _rel(i: number, t: number): StateVector {
    const c = this.relCache[i];
    if (this.relTime[i] !== t) {
      const rail = this._rails[i];
      if (rail) rail.eval(t, c);
      this.relTime[i] = t;
    }
    return c;
  }

  /** @internal Cached state of body `i` relative to the primary at `t`. The returned object is owned by the model. */
  _abs(i: number, t: number): StateVector {
    const c = this.absCache[i];
    if (this.absTime[i] !== t) {
      const p = this._parent[i];
      if (p >= 0) {
        const pa = this._abs(p, t);
        const rel = this._rel(i, t);
        c.r.x = pa.r.x + rel.r.x;
        c.r.y = pa.r.y + rel.r.y;
        c.r.z = pa.r.z + rel.r.z;
        c.v.x = pa.v.x + rel.v.x;
        c.v.y = pa.v.y + rel.v.y;
        c.v.z = pa.v.z + rel.v.z;
      }
      this.absTime[i] = t;
    }
    return c;
  }

  /** State of a body relative to its parent at sim time `t` (zero for the primary). */
  bodyState(bodyId: string, t: number, out: StateVector = newState()): StateVector {
    return copyState(out, this._rel(this.indexOf(bodyId), t));
  }

  /** State of a body relative to the primary star at sim time `t`. */
  bodyAbsState(bodyId: string, t: number, out: StateVector = newState()): StateVector {
    return copyState(out, this._abs(this.indexOf(bodyId), t));
  }

  /** Position of a body relative to the primary star at sim time `t`, m. */
  bodyAbsPosition(bodyId: string, t: number, out: V3 = { x: 0, y: 0, z: 0 }): V3 {
    const a = this._abs(this.indexOf(bodyId), t).r;
    out.x = a.x;
    out.y = a.y;
    out.z = a.z;
    return out;
  }

  // ---------------------------------------------------------------- stations, sites, arbitrary orbiters

  /** State of anything on a Kepler orbit `orbit` around `parentBodyId`, relative to that body, at `t`. */
  orbiterState(orbit: OrbitElements, parentBodyId: string, t: number, out: StateVector = newState()): StateVector {
    return elementsToStateTo(out, orbit, this.body(parentBodyId).mu, t);
  }

  /** As {@link orbiterState}, relative to the primary star. */
  orbiterAbsState(orbit: OrbitElements, parentBodyId: string, t: number, out: StateVector = newState()): StateVector {
    const i = this.indexOf(parentBodyId);
    elementsToStateTo(out, orbit, this.bodies[i].mu, t);
    return this.addAbs(out, i, t);
  }

  /** State of a station relative to its parent body at `t` (precomputed rail; cheaper than orbiterState). */
  stationState(stationId: string, t: number, out: StateVector = newState()): StateVector {
    this.station(stationId);
    return this.orbiters.get(stationId)!.rail.eval(t, out);
  }

  /** State of a station relative to the primary star at `t`. */
  stationAbsState(stationId: string, t: number, out: StateVector = newState()): StateVector {
    this.station(stationId);
    const o = this.orbiters.get(stationId)!;
    o.rail.eval(t, out);
    return this.addAbs(out, o.parent, t);
  }

  /** State of a mining site relative to its parent body at `t`. */
  siteState(siteId: string, t: number, out: StateVector = newState()): StateVector {
    this.site(siteId);
    return this.orbiters.get(siteId)!.rail.eval(t, out);
  }

  /** State of a mining site relative to the primary star at `t`. */
  siteAbsState(siteId: string, t: number, out: StateVector = newState()): StateVector {
    this.site(siteId);
    const o = this.orbiters.get(siteId)!;
    o.rail.eval(t, out);
    return this.addAbs(out, o.parent, t);
  }

  /** State on the jump-beacon arrival orbit relative to `def.jumpBeacon.bodyId` at `t`. */
  beaconState(t: number, out: StateVector = newState()): StateVector {
    return elementsToStateTo(out, this.beaconOrbit, this.bodies[this.beaconParent].mu, t);
  }

  /** State on the jump-beacon arrival orbit relative to the primary star at `t`. */
  beaconAbsState(t: number, out: StateVector = newState()): StateVector {
    elementsToStateTo(out, this.beaconOrbit, this.bodies[this.beaconParent].mu, t);
    return this.addAbs(out, this.beaconParent, t);
  }

  // ---------------------------------------------------------------- frame changes

  private addAbs(out: StateVector, i: number, t: number): StateVector {
    const a = this._abs(i, t);
    out.r.x += a.r.x;
    out.r.y += a.r.y;
    out.r.z += a.r.z;
    out.v.x += a.v.x;
    out.v.y += a.v.y;
    out.v.z += a.v.z;
    return out;
  }

  /** Convert a state relative to `bodyId` into one relative to the primary star, at sim time `t`. `out` may be `sv`. */
  toAbsolute(sv: StateVector, bodyId: string, t: number, out: StateVector = newState()): StateVector {
    if (out !== sv) copyState(out, sv);
    return this.addAbs(out, this.indexOf(bodyId), t);
  }

  /** Convert a state relative to the primary star into one relative to `bodyId`, at sim time `t`. `out` may be `svAbs`. */
  fromAbsolute(svAbs: StateVector, bodyId: string, t: number, out: StateVector = newState()): StateVector {
    const a = this._abs(this.indexOf(bodyId), t);
    out.r.x = svAbs.r.x - a.r.x;
    out.r.y = svAbs.r.y - a.r.y;
    out.r.z = svAbs.r.z - a.r.z;
    out.v.x = svAbs.v.x - a.v.x;
    out.v.y = svAbs.v.y - a.v.y;
    out.v.z = svAbs.v.z - a.v.z;
    return out;
  }

  /** Re-express a state relative to `fromBodyId` as relative to `toBodyId`, at sim time `t`. `out` may be `sv`. */
  changeFrame(sv: StateVector, fromBodyId: string, toBodyId: string, t: number, out: StateVector = newState()): StateVector {
    if (out !== sv) copyState(out, sv);
    if (fromBodyId === toBodyId) return out;
    this.addAbs(out, this.indexOf(fromBodyId), t);
    return this.fromAbsolute(out, toBodyId, t, out);
  }

  // ---------------------------------------------------------------- spheres of influence

  /** The body whose sphere of influence governs the absolute position `absPos` at `t`: the deepest SOI containing it. */
  soiBodyAt(absPos: V3, t: number): BodyDef {
    let cur = 0;
    for (;;) {
      let found = -1;
      let best = 1;
      const kids = this._children[cur];
      for (let k = 0; k < kids.length; k++) {
        const ci = kids[k];
        const a = this._abs(ci, t).r;
        const dx = absPos.x - a.x;
        const dy = absPos.y - a.y;
        const dz = absPos.z - a.z;
        const soi = this.bodies[ci].soi;
        const q = (dx * dx + dy * dy + dz * dz) / (soi * soi);
        if (q < best) {
          best = q;
          found = ci;
        }
      }
      if (found < 0) return this.bodies[cur];
      cur = found;
    }
  }

  /** As {@link soiBodyAt} for a position given relative to `bodyId`. */
  soiBodyFor(r: V3, bodyId: string, t: number): BodyDef {
    const a = this._abs(this.indexOf(bodyId), t).r;
    const p = this.tmp.r;
    p.x = r.x + a.x;
    p.y = r.y + a.y;
    p.z = r.z + a.z;
    return this.soiBodyAt(p, t);
  }
}

// ===================================================================================== patched conics

export type PatchEndReason = 'soi-exit' | 'soi-enter' | 'impact' | 'atmosphere' | 'max-time' | 'closed';

/** One conic arc of a predicted trajectory, inside a single sphere of influence. */
export interface TrajectoryPatch {
  /** Body whose SOI this arc is in; all states here are relative to it. */
  bodyId: string;
  /** That body's gravitational parameter, m³/s². */
  mu: number;
  /** Sim time the arc starts / ends, s. */
  tStart: number;
  tEnd: number;
  /** State at tStart / tEnd, relative to `bodyId`. */
  svStart: StateVector;
  svEnd: StateVector;
  /** Elements of the conic, epoch = tStart. */
  elements: OrbitElements;
  /**
   * Why the arc ends:
   *  soi-exit   – leaves this body's SOI into the parent's (`nextBodyId`)
   *  soi-enter  – enters the SOI of a child body (`nextBodyId`)
   *  impact     – reaches the surface
   *  atmosphere – reaches the top of the atmosphere (the vacuum prediction stops being valid)
   *  closed     – bound orbit with nothing happening in the searched window; tEnd = tStart + searchPeriods·period
   *  max-time   – ran out of `maxDuration`
   */
  endReason: PatchEndReason;
  /** Body of the following patch for soi-exit / soi-enter, else null. */
  nextBodyId: string | null;
  /** Periapsis radius of the conic from the body centre, m (may be below the surface). */
  periapsisRadius: number;
  /** Sim time of the first periapsis passage inside [tStart, tEnd], or null if the arc ends before reaching it. */
  periapsisTime: number | null;
  /** Apoapsis radius of the conic, m (Infinity when open). */
  apoapsisRadius: number;
  /** Sim time of the first apoapsis passage inside [tStart, tEnd], or null. */
  apoapsisTime: number | null;
  /** Period of the conic, s (Infinity when open). */
  period: number;
}

export interface TrajectoryStart {
  /** Body the state is relative to. */
  bodyId: string;
  sv: StateVector;
  /** Sim time of the state, s. */
  t: number;
}

export interface PredictOptions {
  /** Maximum number of conic arcs to return. Default 4. */
  maxPatches?: number;
  /** Prediction horizon from the start time, s. Default 100 days. */
  maxDuration?: number;
  /** How many revolutions of a closed orbit to search for encounters before calling it 'closed'. Default 1. */
  searchPeriods?: number;
  /** End the prediction at the top of an atmosphere (default true). False = treat atmospheres as vacuum. */
  stopAtAtmosphere?: boolean;
}

const _pSv = newState();
const _pEnd = newState();
const _pc = newConic();
const _seShip = newState();
const _seChild = newState();

/**
 * Scan dtA <= dt <= dtB for the first time the ship (state `sv0` at `t0`, orbiting `mu`) enters the
 * sphere of radius `soi` around the body on `rail`. Returns the dt of entry, or Infinity.
 *
 * Conservative advancement: with d(t) the separation, d'' >= -|Δa| >= -accel, so from a sample with
 * gap g = d - soi > 0 and closing speed c the sphere cannot be reached before
 * τ = 2g / (c + √(c² + 2·accel·g)). Stepping by τ can never jump over an encounter, however fast
 * or brief, and converges quadratically onto the boundary when there is one.
 */
function searchEntry(
  rail: Rail,
  soi: number,
  muChild: number,
  sv0: StateVector,
  t0: number,
  mu: number,
  accel: number,
  tol: number,
  dtA: number,
  dtB: number,
): number {
  let dt = dtA;
  let prevDt = dtA;
  let prevOutside = false;
  for (let it = 0; it < 20000; it++) {
    propagateStateTo(_seShip, sv0, mu, dt);
    rail.eval(t0 + dt, _seChild);
    const dx = _seShip.r.x - _seChild.r.x;
    const dy = _seShip.r.y - _seChild.r.y;
    const dz = _seShip.r.z - _seChild.r.z;
    const dvx = _seShip.v.x - _seChild.v.x;
    const dvy = _seShip.v.y - _seChild.v.y;
    const dvz = _seShip.v.z - _seChild.v.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(d > 0)) return dt;
    const closing = -(dx * dvx + dy * dvy + dz * dvz) / d;
    const g = d - soi;
    if (g > tol) {
      const disc = Math.sqrt(closing * closing + 2 * accel * g);
      let step = closing > 0 ? (2 * g) / (closing + disc) : (disc - closing) / accel;
      const minStep = 8e-16 * (Math.abs(t0) + Math.abs(dt)) + 1e-12;
      if (!(step > minStep)) step = minStep;
      prevDt = dt;
      prevOutside = true;
      dt += step;
      if (dt >= dtB) return Infinity;
      continue;
    }
    const v2 = dvx * dvx + dvy * dvy + dvz * dvz;
    if (closing > 0) {
      if (g < -tol) {
        // Already inside. If we stepped over the boundary, back up onto it (never before the last outside sample).
        if (!prevOutside) return dt;
        const back = dt + g / closing;
        return back > prevDt ? back : prevDt;
      }
      // On the boundary and closing: accept only if the pass really goes inside (not a graze).
      const cx = dy * dvz - dz * dvy;
      const cy = dz * dvx - dx * dvz;
      const cz = dx * dvy - dy * dvx;
      const pc = (cx * cx + cy * cy + cz * cz) / muChild;
      const ec = Math.sqrt(Math.max(0, 1 - pc * (2 / d - v2 / muChild)));
      if (pc / (1 + ec) < soi - 4 * tol) return dt;
    }
    // Receding (we have just left this SOI) or grazing: creep along until clear of the boundary.
    const creep = Math.max(2 * (tol - g), 1e-7 * soi) / Math.max(Math.sqrt(v2), 1e-9);
    prevDt = dt;
    prevOutside = false;
    dt += creep;
    if (dt >= dtB) return Infinity;
  }
  return Infinity;
}

/**
 * First time (dt from t0, < dtMax) the ship on conic `c` (state `sv0` at `t0`, in the frame of the
 * body with `mu` and surface radius `bodyRadius`) enters the SOI of child body `ci`; Infinity if none.
 * Only the time intervals in which the ship's radius lies inside the radial band the child's SOI can
 * occupy are searched.
 */
function findSoiEntry(
  model: SystemModel,
  ci: number,
  sv0: StateVector,
  t0: number,
  mu: number,
  bodyRadius: number,
  c: Conic,
  dtMax: number,
): number {
  const child = model.bodies[ci];
  const rail = model._rails[ci];
  const orb = child.orbit;
  if (!rail || !orb || !(dtMax > 0)) return Infinity;
  const soi = child.soi;
  const bound = orb.a > 0 && orb.e < 1;
  const rcMin = Math.abs(orb.a * (1 - orb.e));
  const rcMax = bound ? orb.a * (1 + orb.e) : Infinity;
  const bandLo = Math.max(0, (rcMin - soi) * (1 - 1e-9));
  const bandHi = (rcMax + soi) * (1 + 1e-9);
  if (c.rp > bandHi || c.ra < bandLo) return Infinity;
  const lo = Math.max(bandLo, c.rp);
  const hi = Math.min(bandHi, c.ra);
  const closed = c.period < Infinity;
  const tauLo = lo <= c.rp ? 0 : timeFromPeriapsisToRadius(c, lo);
  const tauHi = closed && hi >= c.ra ? 0.5 * c.period : timeFromPeriapsisToRadius(c, hi);
  const rsMin = Math.max(lo, bodyRadius, 1);
  const accel = mu * (1 / (rsMin * rsMin) + 1 / (rcMin * rcMin));
  const tol = Math.max(1e-10 * soi, 3e-14 * (Math.min(hi, rcMax + soi) + rcMin));

  for (let k = 0; k < 100000; k++) {
    const base = -c.tNow + (closed ? k * c.period : 0);
    const first = base - tauHi;
    if (first >= dtMax) break;
    let found = Infinity;
    if (tauLo === 0) {
      const a = first > 0 ? first : 0;
      const b = Math.min(base + tauHi, dtMax);
      if (b > a) found = searchEntry(rail, soi, child.mu, sv0, t0, mu, accel, tol, a, b);
    } else {
      let a = first > 0 ? first : 0;
      let b = Math.min(base - tauLo, dtMax);
      if (b > a) found = searchEntry(rail, soi, child.mu, sv0, t0, mu, accel, tol, a, b);
      if (!(found < Infinity)) {
        a = base + tauLo > 0 ? base + tauLo : 0;
        b = Math.min(base + tauHi, dtMax);
        if (b > a) found = searchEntry(rail, soi, child.mu, sv0, t0, mu, accel, tol, a, b);
      }
    }
    if (found < Infinity) return found;
    if (!closed) break;
  }
  return Infinity;
}

/**
 * Move the state into the frame it geometrically belongs to at time `t`: up to the parent while it is
 * outside its body's SOI and not coming back in, down into a child whose SOI it is inside.
 * Mutates `sv`; returns the new body index.
 */
function normaliseFrame(model: SystemModel, bi: number, sv: StateVector, t: number): number {
  for (let guard = 0; guard < 8; guard++) {
    const body = model.bodies[bi];
    const parent = model._parent[bi];
    if (parent >= 0) {
      conicFromState(_pc, sv, body.mu);
      if (_pc.r > body.soi && (_pc.sigma >= 0 || _pc.rp >= body.soi)) {
        const rel = model._rel(bi, t);
        sv.r.x += rel.r.x;
        sv.r.y += rel.r.y;
        sv.r.z += rel.r.z;
        sv.v.x += rel.v.x;
        sv.v.y += rel.v.y;
        sv.v.z += rel.v.z;
        bi = parent;
        continue;
      }
    }
    let into = -1;
    const kids = model._children[bi];
    for (let k = 0; k < kids.length && into < 0; k++) {
      const ci = kids[k];
      const child = model.bodies[ci];
      const rel = model._rel(ci, t);
      const dx = sv.r.x - rel.r.x;
      const dy = sv.r.y - rel.r.y;
      const dz = sv.r.z - rel.r.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d >= child.soi) continue;
      // Deep inside: it belongs there. Near the edge: only if it is on its way in.
      const closing = -(dx * (sv.v.x - rel.v.x) + dy * (sv.v.y - rel.v.y) + dz * (sv.v.z - rel.v.z));
      if (d < child.soi * (1 - 1e-6) || closing > 0) into = ci;
    }
    if (into < 0) return bi;
    const rel = model._rel(into, t);
    sv.r.x -= rel.r.x;
    sv.r.y -= rel.r.y;
    sv.r.z -= rel.r.z;
    sv.v.x -= rel.v.x;
    sv.v.y -= rel.v.y;
    sv.v.z -= rel.v.z;
    bi = into;
  }
  return bi;
}

/**
 * Patched-conic prediction: the sequence of Kepler arcs a coasting ship will fly, starting from
 * `start` (state relative to `start.bodyId` at time `start.t`), under the game's physics model
 * (bodies on rails, the ship feels only the body whose SOI it is in).
 *
 * Each arc ends at the first of: surface impact, atmosphere entry, leaving the SOI, entering a child
 * body's SOI (children move on their rails — encounters are found by a search that cannot step over
 * one, see `searchEntry`), one full revolution of a closed orbit with nothing happening, or the time
 * horizon. After an SOI change the next arc starts from exactly the same absolute state, so the
 * trajectory is continuous: `model.toAbsolute(p[i].svEnd, p[i].bodyId, p[i].tEnd)` equals
 * `model.toAbsolute(p[i+1].svStart, p[i+1].bodyId, p[i+1].tStart)` to rounding.
 *
 * If the start state is geometrically outside its body's SOI (and leaving), or inside a child's SOI,
 * the first patch is expressed in the frame it belongs to, so `patches[0].bodyId` can differ from
 * `start.bodyId`.
 *
 * Cost: well under a millisecond for typical 4-patch predictions; allocates only the returned patches.
 */
export function predictTrajectory(model: SystemModel, start: TrajectoryStart, opts: PredictOptions = {}): TrajectoryPatch[] {
  const maxPatches = Math.max(1, opts.maxPatches ?? 4);
  const maxDuration = opts.maxDuration ?? 100 * DAY;
  const searchPeriods = Math.max(1, opts.searchPeriods ?? 1);
  const stopAtAtmosphere = opts.stopAtAtmosphere ?? true;
  const patches: TrajectoryPatch[] = [];
  const sv = copyState(_pSv, start.sv);
  let t = start.t;
  const tLimit = t + maxDuration;
  let bi = normaliseFrame(model, model.indexOf(start.bodyId), sv, t);
  const c = _pc;

  for (let k = 0; k < maxPatches; k++) {
    const body = model.bodies[bi];
    const mu = body.mu;
    conicFromState(c, sv, mu);

    // Events on this conic alone.
    let dtEvent = Infinity;
    let reason: PatchEndReason = 'max-time';
    let next = -1;
    if (c.rp < body.radius) {
      const d = c.r < body.radius * (1 - 1e-12) ? 0 : crossingDt(c, body.radius, false);
      if (d < dtEvent) {
        dtEvent = d;
        reason = 'impact';
      }
    }
    if (stopAtAtmosphere && body.atmosphere) {
      const d = crossingDt(c, body.radius + body.atmosphere.height, false);
      if (d < dtEvent) {
        dtEvent = d;
        reason = 'atmosphere';
      }
    }
    const parent = model._parent[bi];
    if (parent >= 0) {
      let d = Infinity;
      if (c.r >= body.soi && (c.sigma >= 0 || c.rp >= body.soi)) d = 0;
      else if (c.ra > body.soi) d = crossingDt(c, body.soi, true);
      if (d < dtEvent) {
        dtEvent = d;
        reason = 'soi-exit';
        next = parent;
      }
    }

    // How far this arc could run without an encounter.
    const dtMax = Math.max(0, tLimit - t);
    const closed = c.period < Infinity;
    const window = closed ? searchPeriods * c.period : Infinity;
    let dt = Math.min(dtEvent, dtMax, window);

    // Encounters with child bodies before that.
    let enter = -1;
    const kids = model._children[bi];
    for (let j = 0; j < kids.length; j++) {
      const d = findSoiEntry(model, kids[j], sv, t, mu, body.radius, c, dt);
      if (d < dt) {
        dt = d;
        enter = kids[j];
      }
    }
    if (enter >= 0) {
      reason = 'soi-enter';
      next = enter;
    } else if (!(dtEvent <= dtMax && dtEvent <= window)) {
      next = -1;
      if (closed && window <= dtMax) reason = 'closed';
      else reason = 'max-time';
    }

    const tEnd = t + dt;
    const svEnd = propagateStateTo(newState(), sv, mu, dt);
    // Apsis passages inside the arc.
    let tPe: number | null = null;
    let tAp: number | null = null;
    const slack = 1e-9 * dt;
    if (closed) {
      const dPe = c.tNow <= 0 ? -c.tNow : c.period - c.tNow;
      let dAp = 0.5 * c.period - c.tNow;
      if (dAp < 0) dAp += c.period;
      if (dPe <= dt + slack) tPe = t + dPe;
      if (dAp <= dt + slack) tAp = t + dAp;
    } else if (c.tNow <= 0 && -c.tNow <= dt + slack) {
      tPe = t - c.tNow;
    }
    if ((reason === 'impact' || reason === 'atmosphere') && tPe !== null && tPe >= tEnd) tPe = null;

    patches.push({
      bodyId: body.id,
      mu,
      tStart: t,
      tEnd,
      svStart: copyState(newState(), sv),
      svEnd,
      elements: stateToElementsTo(newElements(), sv, mu, t),
      endReason: reason,
      nextBodyId: next >= 0 ? model.bodies[next].id : null,
      periapsisRadius: c.rp,
      periapsisTime: tPe,
      apoapsisRadius: c.ra,
      apoapsisTime: tAp,
      period: c.period,
    });

    if (reason === 'soi-exit') {
      const rel = model._rel(bi, tEnd);
      sv.r.x = svEnd.r.x + rel.r.x;
      sv.r.y = svEnd.r.y + rel.r.y;
      sv.r.z = svEnd.r.z + rel.r.z;
      sv.v.x = svEnd.v.x + rel.v.x;
      sv.v.y = svEnd.v.y + rel.v.y;
      sv.v.z = svEnd.v.z + rel.v.z;
    } else if (reason === 'soi-enter') {
      const rel = model._rel(next, tEnd);
      sv.r.x = svEnd.r.x - rel.r.x;
      sv.r.y = svEnd.r.y - rel.r.y;
      sv.r.z = svEnd.r.z - rel.r.z;
      sv.v.x = svEnd.v.x - rel.v.x;
      sv.v.y = svEnd.v.y - rel.v.y;
      sv.v.z = svEnd.v.z - rel.v.z;
    } else {
      break;
    }
    bi = next;
    t = tEnd;
    if (!(t < tLimit)) break;
  }
  return patches;
}

/**
 * State on a patch at sim time `t`, relative to `patch.bodyId` (Kepler propagation from the patch
 * start). `t` is not clamped: outside [tStart, tEnd] the conic is simply continued.
 */
export function patchStateAt(patch: TrajectoryPatch, t: number, out: StateVector = newState()): StateVector {
  return propagateStateTo(out, patch.svStart, patch.mu, t - patch.tStart);
}

/**
 * State on a predicted trajectory at sim time `t`: finds the patch containing `t`, writes the state
 * (relative to that patch's body) into `out` and returns the patch index (-1 if `patches` is empty).
 * Before the first patch the first conic is extended backward; after the last one the last conic is
 * extended forward if it ended as 'closed' or 'max-time', otherwise the state is held at its end.
 */
export function trajectoryStateAt(patches: readonly TrajectoryPatch[], t: number, out: StateVector): number {
  const n = patches.length;
  if (n === 0) return -1;
  let i = 0;
  while (i < n - 1 && t > patches[i].tEnd) i++;
  const p = patches[i];
  let tt = t;
  if (t > p.tEnd && p.endReason !== 'closed' && p.endReason !== 'max-time') tt = p.tEnd;
  propagateStateTo(out, p.svStart, p.mu, tt - p.tStart);
  return i;
}

// ===================================================================================== polylines for the map

/** "Intermediate anomaly" θ(ν): halfway (geometrically) between true and eccentric anomaly; k = ((1+e)/(1-e))^¼. */
function thetaOfNu(nu: number, k: number): number {
  const base = TAU * Math.floor((nu + PI) / TAU);
  const x = 0.5 * (nu - base);
  return base + 2 * Math.atan2(Math.sin(x), k * Math.cos(x));
}

function nuOfTheta(theta: number, k: number): number {
  const base = TAU * Math.floor((theta + PI) / TAU);
  const x = 0.5 * (theta - base);
  return base + 2 * Math.atan2(k * Math.sin(x), Math.cos(x));
}

const _spTmp = newState();

/**
 * Polyline of a trajectory patch for drawing: `n` points (x, y, z triples, metres, relative to
 * `patch.bodyId`) from the patch start to its end, in the direction of travel. The first and last
 * points are exactly `svStart.r` and `svEnd.r`, so consecutive patches join without gaps once each
 * is offset by its body's position. Arcs longer than one revolution are drawn as one full ellipse.
 * Points are spaced evenly in an anomaly midway between true and eccentric anomaly: dense around
 * periapsis, yet never coarse at apoapsis. Pass `out` (length >= 3n) to avoid allocating.
 */
export function samplePatch(patch: TrajectoryPatch, n = 64, out?: Float64Array): Float64Array {
  const count = Math.max(2, Math.floor(n));
  const o = out && out.length >= 3 * count ? out : new Float64Array(3 * count);
  const mu = patch.mu;
  const s = patch.svStart;
  const rx = s.r.x;
  const ry = s.r.y;
  const rz = s.r.z;
  const vx = s.v.x;
  const vy = s.v.y;
  const vz = s.v.z;
  const r = Math.sqrt(rx * rx + ry * ry + rz * rz);
  const v2 = vx * vx + vy * vy + vz * vz;
  const rv = rx * vx + ry * vy + rz * vz;
  const hx = ry * vz - rz * vy;
  const hy = rz * vx - rx * vz;
  const hz = rx * vy - ry * vx;
  const h2 = hx * hx + hy * hy + hz * hz;
  const dur = patch.tEnd - patch.tStart;
  const closed = patch.period < Infinity;
  const full = closed && dur >= patch.period * (1 - 1e-9);
  const last = count - 1;

  if (!(h2 > 1e-20 * r * r * v2)) {
    // Radial trajectory: no usable anomaly, sample in time.
    const span = full ? patch.period : dur;
    for (let i = 0; i < count; i++) {
      propagateStateTo(_spTmp, s, mu, (span * i) / last);
      o[3 * i] = _spTmp.r.x;
      o[3 * i + 1] = _spTmp.r.y;
      o[3 * i + 2] = _spTmp.r.z;
    }
  } else {
    const h = Math.sqrt(h2);
    const p = h2 / mu;
    const k1 = v2 - mu / r;
    let Px = (k1 * rx - rv * vx) / mu;
    let Py = (k1 * ry - rv * vy) / mu;
    let Pz = (k1 * rz - rv * vz) / mu;
    const e = Math.sqrt(Px * Px + Py * Py + Pz * Pz);
    if (e > 1e-9) {
      Px /= e;
      Py /= e;
      Pz /= e;
    } else {
      Px = rx / r;
      Py = ry / r;
      Pz = rz / r;
    }
    const Wx = hx / h;
    const Wy = hy / h;
    const Wz = hz / h;
    const Qx = Wy * Pz - Wz * Py;
    const Qy = Wz * Px - Wx * Pz;
    const Qz = Wx * Py - Wy * Px;
    const nu0 = Math.atan2(rx * Qx + ry * Qy + rz * Qz, rx * Px + ry * Py + rz * Pz);
    let sweep: number;
    if (full) {
      sweep = TAU;
    } else {
      const q = patch.svEnd.r;
      const nu1 = Math.atan2(q.x * Qx + q.y * Qy + q.z * Qz, q.x * Px + q.y * Py + q.z * Pz);
      sweep = nu1 - nu0;
      if (closed) {
        if (sweep < 0) sweep += TAU;
        // An arc of almost a whole revolution whose end angle rounds onto the start.
        if (sweep < 1e-9 && dur > 0.5 * patch.period) sweep = TAU;
      } else if (sweep < 0) {
        sweep = 0;
      }
    }
    const k = e < 1 ? Math.pow((1 + e) / (1 - e), 0.25) : 1;
    const th0 = thetaOfNu(nu0, k);
    const th1 = thetaOfNu(nu0 + sweep, k);
    for (let i = 0; i < count; i++) {
      const nu = nuOfTheta(th0 + ((th1 - th0) * i) / last, k);
      const cn = Math.cos(nu);
      const sn = Math.sin(nu);
      const den = 1 + e * cn;
      const rad = p / (den > 1e-9 ? den : 1e-9);
      const x = rad * cn;
      const y = rad * sn;
      o[3 * i] = x * Px + y * Qx;
      o[3 * i + 1] = x * Py + y * Qy;
      o[3 * i + 2] = x * Pz + y * Qz;
    }
  }
  // Pin the ends to the exact states so patches join.
  o[0] = rx;
  o[1] = ry;
  o[2] = rz;
  const endR = full ? s.r : patch.svEnd.r;
  o[3 * last] = endR.x;
  o[3 * last + 1] = endR.y;
  o[3 * last + 2] = endR.z;
  return o;
}

/**
 * Polyline of a whole orbit given by elements: `n` points (x, y, z triples, metres, relative to the
 * orbited body). Ellipses: one full revolution starting and ending at periapsis (first point = last
 * point), spaced as in {@link samplePatch}. Hyperbolas: the branch out to radius `rMax` on both sides
 * of periapsis (default 50 periapsis radii), evenly spaced in true anomaly.
 * Pass `out` (length >= 3n) to avoid allocating.
 */
export function sampleOrbit(el: OrbitElements, n = 128, out?: Float64Array, rMax?: number): Float64Array {
  const count = Math.max(2, Math.floor(n));
  const o = out && out.length >= 3 * count ? out : new Float64Array(3 * count);
  const ci = Math.cos(el.i);
  const si = Math.sin(el.i);
  const cO = Math.cos(el.lan);
  const sO = Math.sin(el.lan);
  const cw = Math.cos(el.argp);
  const sw = Math.sin(el.argp);
  const Px = cO * cw - sO * sw * ci;
  const Py = sw * si;
  const Pz = -(sO * cw + cO * sw * ci);
  const Qx = -cO * sw - sO * cw * ci;
  const Qy = cw * si;
  const Qz = sO * sw - cO * cw * ci;
  const e = el.e;
  const p = el.a * (1 - e) * (1 + e);
  const last = count - 1;
  const closed = el.a > 0 && e < 1;
  let k = 1;
  let from = 0;
  let to = TAU;
  if (closed) {
    k = Math.pow((1 + e) / (1 - e), 0.25);
  } else {
    const rp = p / (1 + e);
    const lim = rMax !== undefined && rMax > rp ? rMax : 50 * rp;
    let cosLim = (p / lim - 1) / e;
    if (cosLim < -1) cosLim = -1;
    else if (cosLim > 1) cosLim = 1;
    to = Math.acos(cosLim);
    from = -to;
  }
  for (let i = 0; i < count; i++) {
    const th = from + ((to - from) * i) / last;
    const nu = closed ? nuOfTheta(th, k) : th;
    const cn = Math.cos(nu);
    const sn = Math.sin(nu);
    const den = 1 + e * cn;
    const rad = p / (den > 1e-9 ? den : 1e-9);
    const x = rad * cn;
    const y = rad * sn;
    o[3 * i] = x * Px + y * Qx;
    o[3 * i + 1] = x * Py + y * Qy;
    o[3 * i + 2] = x * Pz + y * Qz;
  }
  if (closed) {
    o[3 * last] = o[0];
    o[3 * last + 1] = o[1];
    o[3 * last + 2] = o[2];
  }
  return o;
}
