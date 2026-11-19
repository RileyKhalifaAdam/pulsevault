// W2-E item 6 — tidal (gravity-gradient) acceleration inside the cabin, and its exact closed form for drifting
// bodies (docs/SIMULATION.md §2 W2-E item 6, `env-tidal-accel-in-cabin`, `body-tidal-gradient`). Pure, deterministic,
// allocation-free per call, SI units, plain-JSON state.
//
// Physics. Relative to the ship's centre of mass, a free body feels a = n²(3r̂(r̂·p) − p) (n² = μ/r³, r̂ the local
// vertical): 1.23e-6 s⁻² at Wick's 712 km orbit, so ≈ 1.2e-5 m/s² 5 m along the vertical. In the ship's CoM-centred
// inertial frame (the frame quasistatic.ts drifts bodies in) r̂ turns with the orbit at n, so the linear ODE
// p̈ = n²(3r̂(t)r̂(t)ᵀ − I)p is exactly the Clohessy–Wiltshire (Hill) system in the LVLH frame of the anchor. Its state
// transition matrix is closed form (one cos/sin pair per evaluation), exact at any step size: warp honest with no
// `limitedBy`. Over a drift segment the body's path is
//   x(t) = x_q(t) + δ(t),  δ = CW(x₀, v₀, t) − (x₀ + v₀t) − T₀a_s·t⁴/24 − Ṫ₀a_s·t⁵/40  (δ̇ likewise),
// where x_q is quasistatic.ts' closed form (x₀ + v₀t − ½a_s t² − drag) and T = n²(3r̂r̂ᵀ − I) at the anchor. Exact for
// a_s = 0 and no drag (coasting: every sleep). With thrust the a_s terms are the first-order tidal response to the
// thrust path, to first order in the vertical's turn (measured 1e-8 m off RK4 over a 5 s segment at 10 m/s², where the
// whole term is 6e-4 m); drag on the tidal velocity (≈ 1e-5 m/s) is neglected
// (k|u|·δ̇·t² < 1e-9 m per segment). Eccentric orbits: n and r̂ are re-taken at every re-anchor (segments ≤ 5 s ≤
// 0.1/n), error O(e·n·t_seg) of the tidal term itself.
// Rest: |a| ≤ 2n²|p| ≈ 4e-5 m/s² anywhere in a 15 m cabin, inside REST_WAKE_A = 1e-4, so tides never wake a resting
// body (friction holds them, as it physically does); tidalFDot bounds d(felt)/dt for restWakeTicks.
//
// WIRING (wave 2; this file replaces nothing, quasistatic.ts / crew.ts / props.ts call it):
// - crew.ts craftMotion (W1-C item 9 already gives BodyMotion.rhat and n2): also
//     motion.fDot = max(motion.fDot, tidalFDot(n2, |ω|, n, R_CABIN, V_MAX))   once per tick (R_CABIN = 15 m Wren).
// - CONTACT bodies (crew.ts `sub`, props.ts `sub`, every sub-step, h = Q): felt += tidalAccel(n2, rhat, p − com).
//   (≈ 2 ns; p = position relative to the CoM, craft axes.)
// - quasistatic.ts needs four small changes (it is W1-C's file; requested, not made here):
//   1. QsState gains `tide: TideAnchor` (createTideAnchor(); saveTideAnchor / loadTideAnchor in save/loadQsState).
//   2. anchorDrift and reanchor: setTideAnchor(s.tide, n2, R̂, Ĥ) with R̂, Ĥ the inertial local vertical and orbit
//      normal at that tick (tideFrame(c.rel, c.vel, μ, …) once per tick in craftMotion; give BodyMotion `rhatI`,
//      `hhatI` or pass them in).
//   3. driftEval: after the closed form, tideDelta(s.tide, s.x0, s.v0, s.aS, t, X, VV) adds δ and δ̇ in place.
//   4. driftBound: aI and each box's A gain tidalAccelBound(n2, rEff) (the tide is ≤ 2n²·|x|); scheduleDrift's
//      A_FLOOR (1e-5) covers it within 4 m of the CoM only.
// - §1.4 contract fields: reads BodyMotion.rhat, n2 (wave 1, W1-C item 9) and the craft's rel/vel (primary-relative);
//   writes only the TideAnchor inside each QsState (saved). No new craft field.

import type { V3 } from '../core/types';

// transcendental wrappers (§1.1 rule 6: wave 1 moves them into src/world/math.ts)
const mcos = (x: number): number => Math.cos(x);
const msin = (x: number): number => Math.sin(x);

export const Q = 1 / 120;

/** Tidal acceleration a = n²(3r̂(r̂·p) − p) at p (relative to the CoM), any consistent axes. out may alias p. */
export function tidalAccel(n2: number, rhat: V3, p: V3, out: V3): V3 {
  const d = 3 * (rhat.x * p.x + rhat.y * p.y + rhat.z * p.z);
  const x = n2 * (d * rhat.x - p.x), y = n2 * (d * rhat.y - p.y), z = n2 * (d * rhat.z - p.z);
  out.x = x; out.y = y; out.z = z;
  return out;
}

/** Upper bound of |tidal acceleration| within distance R of the CoM: the tensor's largest eigenvalue is 2n². */
export const tidalAccelBound = (n2: number, R: number): number => 2 * (n2 > 0 ? n2 : 0) * (R > 0 ? R : 0);

/**
 * Upper bound of |d(tidal felt)/dt| for a body within R of the CoM moving at ≤ V relative to the ship, m/s³:
 * ȧ = n²[3(ṙ̂r̂ᵀ + r̂ṙ̂ᵀ)p + (3r̂r̂ᵀ − I)ṗ], ‖ṙ̂r̂ᵀ + r̂ṙ̂ᵀ‖ = |ṙ̂| ≤ |ω_ship| + θ̇ (θ̇ ≈ n), ‖3r̂r̂ᵀ − I‖ = 2;
 * plus 2R·|d(n²)/dt| (eccentric orbits: d(n²)/dt = −3n²ṙ/r) when given.
 */
export function tidalFDot(n2: number, wShip: number, thetaDot: number, R: number, V: number, dn2dt = 0): number {
  if (!(n2 > 0)) return 0;
  const rr = (wShip > 0 ? wShip : 0) + (thetaDot > 0 ? thetaDot : 0);
  return n2 * (3 * rr * R + 2 * V) + 2 * R * (dn2dt < 0 ? -dn2dt : dn2dt);
}

/** The orbit frame for a tide anchor, from the craft's primary-relative state (inertial axes). */
export interface TideFrame {
  /** n² = μ/r³ (1/s²), n (1/s), θ̇ = |r × v|/r² (1/s), d(n²)/dt (1/s³). */
  n2: number;
  n: number;
  thetaDot: number;
  dn2dt: number;
  /** Unit local vertical and orbit normal, inertial axes. */
  r: V3;
  h: V3;
}

export const createTideFrame = (): TideFrame => ({ n2: 0, n: 0, thetaDot: 0, dn2dt: 0, r: { x: 0, y: 1, z: 0 }, h: { x: 0, y: 0, z: 1 } });

/** Fill a TideFrame from rel (m) and vel (m/s) relative to the primary and μ (m³/s²). Once per tick; no allocation. */
export function tideFrame(rel: V3, vel: V3, mu: number, out: TideFrame): TideFrame {
  const r2 = rel.x * rel.x + rel.y * rel.y + rel.z * rel.z, r = Math.sqrt(r2);
  if (!(r > 0) || !(mu > 0)) { out.n2 = 0; out.n = 0; out.thetaDot = 0; out.dn2dt = 0; return out; }
  out.n2 = mu / (r2 * r); out.n = Math.sqrt(out.n2);
  out.r.x = rel.x / r; out.r.y = rel.y / r; out.r.z = rel.z / r;
  let hx = rel.y * vel.z - rel.z * vel.y, hy = rel.z * vel.x - rel.x * vel.z, hz = rel.x * vel.y - rel.y * vel.x;
  const hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
  if (hl > 0) { hx /= hl; hy /= hl; hz /= hl; } else {
    // radial fall (no orbit normal): any normal to r̂; the frame then does not turn
    const ax = Math.abs(out.r.x) < 0.9 ? 1 : 0, ay = 1 - ax;
    hx = out.r.y * 0 - out.r.z * ay; hy = out.r.z * ax - out.r.x * 0; hz = out.r.x * ay - out.r.y * ax;
    const l = Math.sqrt(hx * hx + hy * hy + hz * hz); hx /= l; hy /= l; hz /= l;
  }
  out.h.x = hx; out.h.y = hy; out.h.z = hz;
  out.thetaDot = hl / r2;
  const rdot = (rel.x * vel.x + rel.y * vel.y + rel.z * vel.z) / r;
  out.dn2dt = (-3 * out.n2 * rdot) / r;
  return out;
}

/**
 * The tide of one drift segment: n at the anchor (0 = no tide), the LVLH axes at the anchor (inertial): x̂ = r̂,
 * ŷ = ẑ × x̂ (along-track), ẑ = ĥ. Plain JSON, saved with the body's drift anchor (QsState) so that save → load →
 * evaluate is bit-identical.
 */
export interface TideAnchor {
  n: number;
  xh: V3;
  yh: V3;
  zh: V3;
}

export const createTideAnchor = (): TideAnchor => ({ n: 0, xh: { x: 1, y: 0, z: 0 }, yh: { x: 0, y: 1, z: 0 }, zh: { x: 0, y: 0, z: 1 } });

/** Anchor the tide: n² and the inertial unit local vertical R and orbit normal H (H ⟂ R; re-orthogonalised). */
export function setTideAnchor(ta: TideAnchor, n2: number, R: V3, H: V3): void {
  ta.n = n2 > 0 ? Math.sqrt(n2) : 0;
  const rl = Math.sqrt(R.x * R.x + R.y * R.y + R.z * R.z);
  if (!(rl > 0)) { ta.n = 0; return; }
  const xx = R.x / rl, xy = R.y / rl, xz = R.z / rl;
  const d = H.x * xx + H.y * xy + H.z * xz;
  let zx = H.x - d * xx, zy = H.y - d * xy, zz = H.z - d * xz;
  const zl = Math.sqrt(zx * zx + zy * zy + zz * zz);
  if (!(zl > 0)) { ta.n = 0; return; }
  zx /= zl; zy /= zl; zz /= zl;
  ta.xh.x = xx; ta.xh.y = xy; ta.xh.z = xz;
  ta.zh.x = zx; ta.zh.y = zy; ta.zh.z = zz;
  ta.yh.x = zy * xz - zz * xy; ta.yh.y = zz * xx - zx * xz; ta.yh.z = zx * xy - zy * xx;
}

/** From a TideFrame (orbit normal from the frame; n² = μ/r³). */
export const setTideAnchorFrom = (ta: TideAnchor, f: TideFrame): void => setTideAnchor(ta, f.n2, f.r, f.h);

const CW = new Float64Array(6);

/**
 * Exact linear tidal flow over t from (x0, v0) (inertial axes, CoM origin, inertial velocity): the CW state
 * transition in the anchor's LVLH frame, rotated back. Writes x, v (may not alias x0/v0). n = 0: free flight.
 */
export function tideFlow(ta: TideAnchor, x0: V3, v0: V3, t: number, x: V3, v: V3): void {
  const n = ta.n;
  if (!(n > 0) || t === 0) {
    x.x = x0.x + v0.x * t; x.y = x0.y + v0.y * t; x.z = x0.z + v0.z * t;
    v.x = v0.x; v.y = v0.y; v.z = v0.z;
    return;
  }
  const X = ta.xh, Y = ta.yh, Z = ta.zh;
  // LVLH coordinates and rotating-frame velocity ρ̇ = Rᵀv − Ω×ρ, Ω = (0, 0, n)
  const rx = x0.x * X.x + x0.y * X.y + x0.z * X.z, ry = x0.x * Y.x + x0.y * Y.y + x0.z * Y.z, rz = x0.x * Z.x + x0.y * Z.y + x0.z * Z.z;
  const ux = v0.x * X.x + v0.y * X.y + v0.z * X.z + n * ry, uy = v0.x * Y.x + v0.y * Y.y + v0.z * Y.z - n * rx;
  const uz = v0.x * Z.x + v0.y * Z.y + v0.z * Z.z;
  const th = n * t, c = mcos(th), s = msin(th), sh = msin(0.5 * th), omc = 2 * sh * sh, in_ = 1 / n;
  // s − θ without cancellation for small θ (series to θ⁹ below 0.1 rad; the first omitted term is ≤ 2e-15 relative)
  let smt: number;
  if (th < 0.1 && th > -0.1) { const t2 = th * th; smt = -th * t2 * (1 / 6 - t2 * (1 / 120 - t2 * (1 / 5040 - t2 / 362880))); }
  else smt = s - th;
  CW[0] = (1 + 3 * omc) * rx + s * in_ * ux + 2 * in_ * omc * uy;
  CW[1] = 6 * smt * rx + ry - 2 * in_ * omc * ux + in_ * (4 * smt + th) * uy;
  CW[2] = c * rz + s * in_ * uz;
  CW[3] = 3 * n * s * rx + c * ux + 2 * s * uy;
  CW[4] = -6 * n * omc * rx - 2 * s * ux + (1 - 4 * omc) * uy;
  CW[5] = -n * s * rz + c * uz;
  // inertial velocity components on the rotated axes: w = ρ̇ + Ω×ρ, then rotate by θ about ẑ back to the anchor axes
  const wx = CW[3] - n * CW[1], wy = CW[4] + n * CW[0], wz = CW[5];
  const px = c * CW[0] - s * CW[1], py = s * CW[0] + c * CW[1], pz = CW[2];
  const qx = c * wx - s * wy, qy = s * wx + c * wy, qz = wz;
  x.x = px * X.x + py * Y.x + pz * Z.x; x.y = px * X.y + py * Y.y + pz * Z.y; x.z = px * X.z + py * Y.z + pz * Z.z;
  v.x = qx * X.x + qy * Y.x + qz * Z.x; v.y = qx * X.y + qy * Y.y + qz * Z.y; v.z = qx * X.z + qy * Y.z + qz * Z.z;
}

const FX: V3 = { x: 0, y: 0, z: 0 };
const FV: V3 = { x: 0, y: 0, z: 0 };

/**
 * Add the tide to a drift closed form in place (quasistatic.ts driftEval, after its own x, v at time t since the
 * anchor): x += CW(x₀, v₀, t) − (x₀ + v₀t) − T₀a_s·t⁴/24 − Ṫ₀a_s·t⁵/40, v += CW_v − v₀ − T₀a_s·t³/6 − Ṫ₀a_s·t⁴/8.
 * aS = the ship's proper acceleration the anchor holds (inertial; quasistatic's path has −½a_s t²).
 */
export function tideDelta(ta: TideAnchor, x0: V3, v0: V3, aS: V3, t: number, x: V3, v: V3): void {
  const n = ta.n;
  if (!(n > 0) || !(t > 0)) return;
  tideFlow(ta, x0, v0, t, FX, FV);
  // the tide's response to the thrust path −½a_s τ² (first order in T, with T(τ) = T₀ + τṪ₀ as r̂ turns at n toward
  // ŷ): −T₀a·t⁴/24 − Ṫ₀a·t⁵/40 and −T₀a·t³/6 − Ṫ₀a·t⁴/8. T₀(−a) = n²(3x̂(x̂·(−a)) + a); Ṫ₀(−a) = −3n³(ŷ(x̂·a) + x̂(ŷ·a)).
  const X = ta.xh, Y = ta.yh, n2 = n * n, ax = X.x * aS.x + X.y * aS.y + X.z * aS.z, ay = Y.x * aS.x + Y.y * aS.y + Y.z * aS.z;
  const tx = n2 * (-3 * ax * X.x + aS.x), ty = n2 * (-3 * ax * X.y + aS.y), tz = n2 * (-3 * ax * X.z + aS.z);
  const k3 = -3 * n2 * n, ux = k3 * (ax * Y.x + ay * X.x), uy = k3 * (ax * Y.y + ay * X.y), uz = k3 * (ax * Y.z + ay * X.z);
  const t2 = t * t, t3 = (t2 * t) / 6, t4 = (t2 * t2) / 24, t4v = (t2 * t2) / 8, t5 = (t2 * t2 * t) / 40;
  x.x += FX.x - (x0.x + v0.x * t) + tx * t4 + ux * t5; x.y += FX.y - (x0.y + v0.y * t) + ty * t4 + uy * t5; x.z += FX.z - (x0.z + v0.z * t) + tz * t4 + uz * t5;
  v.x += FV.x - v0.x + tx * t3 + ux * t4v; v.y += FV.y - v0.y + ty * t3 + uy * t4v; v.z += FV.z - v0.z + tz * t3 + uz * t4v;
}

// ------------------------------------------------------------------------------------------------ save / load

const num = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const v3o = (x: unknown, dx: number, dy: number, dz: number): V3 => {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  return { x: num(o.x, dx), y: num(o.y, dy), z: num(o.z, dz) };
};

export const saveTideAnchor = (ta: TideAnchor): TideAnchor => ({ n: ta.n, xh: { ...ta.xh }, yh: { ...ta.yh }, zh: { ...ta.zh } });

/** Loader default: no tide on the segment (an old save re-anchors with the tide within one segment, ≤ 5 s). */
export function loadTideAnchor(data: unknown): TideAnchor {
  const o = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const n = num(o.n, 0);
  return { n: n > 0 ? n : 0, xh: v3o(o.xh, 1, 0, 0), yh: v3o(o.yh, 0, 1, 0), zh: v3o(o.zh, 0, 0, 1) };
}
