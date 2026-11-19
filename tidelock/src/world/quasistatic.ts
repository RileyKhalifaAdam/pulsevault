// W1-C quasi-static loose bodies (docs/SIMULATION.md §2 W1-C item 6): the rest and drift modes in closed form and
// the drift/rest scheduler, so loose objects (and the crew body) never block sleep warp. Pure TypeScript,
// deterministic, allocation-free per call, plain-JSON state, SI units, ticks of Q = 1/120 s as integers.
//
// Three modes per body:
//   CONTACT  stepped at Q by the existing solver (props.ts `sub`, crew.ts `sub`). Not handled here, except that
//            serviceBodies applies the tick's ship impulse to its velocity (v_rel += −Δv − Δω×r, ω_rel −= Δω).
//   REST     at rest on a surface (v_rel < 1e-3 m/s) inside the friction cone of the felt acceleration. It wakes
//            when the felt acceleration leaves that cone by more than REST_WAKE_A = 1e-4 m/s², or when a ship
//            impulse leaves the impulse cone (|J_t| ≤ μ(J_n + N·Q), J_n + N·Q ≥ 0). Slow forces (tides, gravity
//            gradient: ~1e-5 m/s² in the cabin, wave 2) stay inside that margin, so they never keep a body awake;
//            their rate bound `fDot` only schedules the next re-check (restWakeTicks).
//   DRIFT    touching nothing, in the ship's CoM-centred inertial frame, in closed form:
//            - no felt acceleration, or a velocity across it: x = x₀ + v₀t − ½a_s t² − D(t)û₀ with the exact
//              fixed-direction quadratic drag |u| = |u₀|/(1 + k|u₀|t), D = |u₀|t − ln(1 + k|u₀|t)/k. The drag the
//              felt part of the velocity would add is bounded and caps the segment (DRAG_EPS_X / _V).
//            - velocity along the felt acceleration (released from rest under thrust or aerobrake): the exact 1-D
//              solution of s' = A − k s|s| (tanh / coth / tan forms; terminal speed √(A/k)).
//            - rotation: torque-free, constant inertial L; closed form for isotropic and axisymmetric inertia,
//              fixed-grid RK4 steps (≤ ROT_STEP rad each) for triaxial bodies (rotSteps gives their cost).
//            Segments end at the first tick where a rigorous bound says the body might touch something (or after
//            5 s, or 0.1/n). A change of the ship's acceleration re-anchors the body at the previous serviced tick
//            (the ledger mean belongs to the interval since then) — cheap; it re-schedules (the box scan) only
//            when the new motion leaves the bounds the schedule was made with (headroom on a_s, ω, α, drag).
// The anchors, schedule bounds and rotation state are saved, so save → load → step is bit-identical, and the step
// sequence depends only on the state (never on the frame budget or on how often a body is evaluated).
//
// WIRING (wave 1):
// - props.ts: PropBody gains `qs: QsState` (createQsState(); loadQsState on load: old saves get CONTACT, which
//   re-derives the mode within a tick). PropBody already has p, v, q, w (ship frame) — it is a QsBody as is.
//   Build once per layout: makeQsWorld(rt.sb, rt.ns, n, { r: rt.bound, k: dragK(CdA, mass) per body (cdaOf until
//   src/data/props.ts carries C_dA), mu: rt.mu, I: rt.Ib }) — it builds its own static grid (1 m cells).
// - props.ts `stepProps` per tick, after W1-B's consumeLedger(c, mean): serviceBodies(bodies, qw, tick, motion,
//   craft.q, mean.dv, mean.dw). It applies the tick's impulse to EVERY body in every mode (do not call
//   applyShipJump separately), moves every DRIFT body (position, velocity, attitude, angular velocity) to its
//   closed form, re-anchors / re-schedules, hands bodies to CONTACT and wakes RESTing bodies. Then the existing
//   sub-steps run only over bodies with mode CONTACT (plus those they touch: the awake-island list). After the
//   contact sub-steps, for each CONTACT body: afterContact(b, i, bodies, qw, tick, motion, craft.q, touching,
//   supportNormal) — it enters REST or DRIFT. This replaces `asleep`/`still`/SLEEP_* and FLOAT_* and the global
//   wake tests (WAKE_DA, WAKE_DW, α²). In the CONTACT sub-step, drag: dragStep(b.v, k, h).
// - W1-A's tick loop: q_next = min(warp quantum, nextBodyEvent(bodies, tick, maxTicks)) ticks; a result of 1
//   with bodyEvent.why === WHY_CONTACT is `limitedBy: 'props'` (or 'crew' for the crew body). Budget a quantum
//   at C_quantum + rotSteps(bodies, ticks)·0.05 µs (triaxial spinning drifters only).
// - The crew body uses the same three modes as its own QsWorld entry: p = the capsule CENTRE = crew.pos +
//   (0, CREW_HEIGHT/2, 0) (crew.pos is the feet), r = CREW_RADIUS, hy = CREW_HEIGHT/2 − CREW_RADIUS (crewQsHy),
//   k = dragK(0.6, 80), mu 0.7, no q/w (attitude is W2-E), selfJump = 1 (crew.ts applies the jump itself through
//   bootImpulse / the harness while in CONTACT). Copy p − (0, H/2, 0) back to crew.pos after serviceBodies.

import type { Quat, V3 } from '../core/types';
import { feltAt } from './crew';
import type { BodyMotion } from './body';

// transcendental wrappers (wave 1 moves them into src/world/math.ts, §1.1 rule 6)
const mlog1p = (x: number): number => Math.log1p(x);
const mlog = (x: number): number => Math.log(x);
const mexp = (x: number): number => Math.exp(x);
const mexpm1 = (x: number): number => Math.expm1(x);
const mcos = (x: number): number => Math.cos(x);
const msin = (x: number): number => Math.sin(x);
const mtan = (x: number): number => Math.tan(x);
const matan = (x: number): number => Math.atan(x);
const mpow = (x: number, y: number): number => Math.pow(x, y);

export const Q = 1 / 120;
export const MODE_CONTACT = 0;
export const MODE_REST = 1;
export const MODE_DRIFT = 2;
/** Rest: speed limit (m/s), wake margin outside the friction cone (m/s²), entry margin (half of it: hysteresis). */
export const REST_V = 1e-3;
export const REST_WAKE_A = 1e-4;
export const REST_ENTER_A = 0.5e-4;
/** Drift segment caps: at most 5 s, at most 0.1/n (n = orbital mean motion). */
export const DRIFT_MAX = 5;
export const DRIFT_N = 0.1;
/**
 * Penetration a drifting body may reach before CONTACT takes it, m: the contact solver's own slop (props.ts SLOP).
 * It lets a body slide along a surface it touches without being pinned to Q by rounding.
 */
export const DRIFT_SLOP = 5e-4;
/** A segment shorter than this many ticks hands the body to CONTACT. */
export const DRIFT_MIN_TICKS = 2;
/** Cabin air density until W2-D's cabin model supplies it, kg/m³. */
export const RHO_CABIN = 1.2;
/** A schedule this far ahead means "never", ticks. */
export const NEVER = 2 ** 52;
/**
 * Schedule headroom: a re-anchor keeps the segment end while |a_s − a_sched| + |d|·|d̂ − d̂_sched| ≤ dB and |d| ≤
 * dragB, with dB = A_HEAD·|a_sched| + A_FLOOR, dragB = DRAG_HEAD·|d_sched| (d = the drag model's directional
 * excess, dragExcess); |ω| ≤ W_HEAD·|ω_sched| + W_FLOOR (+ α_B·t); |α| ≤ AL_HEAD·|α_sched| + AL_FLOOR. The floors
 * are at the tidal scale (wave 2): slow forces never re-schedule, any real firing does once.
 */
export const A_HEAD = 0.25;
export const A_FLOOR = 1e-5;
export const DRAG_HEAD = 1.25;
export const W_HEAD = 1.25;
export const W_FLOOR = 1e-6;
export const AL_HEAD = 1.5;
export const AL_FLOOR = 1e-8;
/**
 * Drag under a felt acceleration with a velocity across it: the closed form does not drag the felt part of the
 * velocity; the segment is capped so that the neglected drag moves the body < DRAG_EPS_X (m) and changes its
 * velocity < DRAG_EPS_V (m/s). The 1-D form is used when the cross velocity is < ONE_D_REL of the speed scale.
 */
export const DRAG_EPS_X = 1e-3;
export const DRAG_EPS_V = 5e-3;
export const ONE_D_REL = 0.02;
/** Rotation per step of the triaxial RK4 grid, rad (props.ts ROT_STEP). */
export const ROT_STEP = 0.2;
/** First search radius of the static grid, s of travel (a second pass widens it when nothing is that close). */
export const GRID_PASS_T = 0.5;

export interface QsState {
  mode: number;
  /** REST: unit normal of the supporting surface (craft axes, out of the surface). */
  n: V3;
  /** DRIFT anchor, inertial axes, origin at the ship's CoM: position, velocity, the ship's proper acceleration
   * (constant on the segment) and the air-relative velocity at the anchor. */
  x0: V3;
  v0: V3;
  aS: V3;
  u0: V3;
  /** Anchor tick, the tick at which the segment (or the rest re-check) ends, the last serviced tick. */
  tick0: number;
  tickEnd: number;
  tickS: number;
  /** The schedule's bounds: a_s it was made for (inertial), acceleration budget dB, the drag excess bound dragB along
   * dragD (unit, inertial), |ω|, |α| bounds, its tick. */
  aR: V3;
  dB: number;
  dragB: number;
  dragD: V3;
  wB: number;
  alB: number;
  tickB: number;
  /** Rotation anchor: attitude (object → inertial), inertial angular momentum (kg·m²/s), its tick; rn = ticks per
   * RK4 step (triaxial; 0 = closed form, −1 = no rotation). */
  rq: Quat;
  rL: V3;
  rTick: number;
  rn: number;
}

/** Anything that can drift or rest: centre position and velocity relative to the ship (craft axes) and its mode;
 * optionally its attitude (object → craft axes) and angular velocity relative to the ship (craft axes). */
export interface QsBody {
  p: V3;
  v: V3;
  q?: Quat;
  w?: V3;
  qs: QsState;
}

/** Uniform grid over the static boxes (cell lists), built once per layout. */
export interface QsGrid {
  o: Float64Array;
  n: Int32Array;
  cell: number;
  start: Int32Array;
  items: Int32Array;
  stamp: Int32Array;
  /** Query counter for the stamps (not state: results do not depend on it). */
  tick: number;
}

/** The static geometry and per-body constants (built once per layout; typed arrays). */
export interface QsWorld {
  /** Static boxes: minX, minY, minZ, maxX, maxY, maxZ (craft axes). */
  boxes: Float64Array;
  nBoxes: number;
  /** Bounding radius (m), drag constant k = ρ·C_dA/(2m) (1/m), static friction μ_s, per body. */
  r: Float64Array;
  k: Float64Array;
  mu: Float64Array;
  /** Half-length (m) of a capsule segment along craft +Y (the upright crew); absent / 0 = a sphere of radius r. */
  hy?: Float64Array;
  /** Principal moments of inertia, object axes (3 per body), kg·m²; absent = rotation not handled here. */
  I?: Float64Array;
  /** 1 = the caller applies the ship impulse to this body itself while it is in CONTACT (crew: boots, harness). */
  selfJump?: Uint8Array;
  /** Static grid (makeQsGrid); absent = every box is scanned. */
  grid?: QsGrid;
}

const v3 = (): V3 => ({ x: 0, y: 0, z: 0 });

export const createQsState = (): QsState => ({
  mode: MODE_CONTACT, n: { x: 0, y: 1, z: 0 }, x0: v3(), v0: v3(), aS: v3(), u0: v3(), tick0: 0, tickEnd: 0, tickS: 0,
  aR: v3(), dB: 0, dragB: 0, dragD: v3(), wB: 0, alB: 0, tickB: 0, rq: { x: 0, y: 0, z: 0, w: 1 }, rL: v3(), rTick: 0, rn: -1,
});

/** Drag constant k = ρ·C_dA/(2m), 1/m: the air-relative speed e-folds every 1/k of path (v = v₀/(1 + k v₀ t)). */
export const dragK = (cdA: number, mass: number, rho: number = RHO_CABIN): number => (mass > 0 && cdA > 0 ? (rho * cdA) / (2 * mass) : 0);

/** C_dA (m²) of the plan's reference objects; others: a tumbling convex body, C_d ≈ 1 on its mean projected area S/4. */
export const CDA_REF: Readonly<Record<string, number>> = { pillow: 0.19, pen: 0.002, mug: 0.006, crew: 0.6 };
export const cdaOf = (type: string, surfaceArea: number): number => CDA_REF[type] ?? 0.25 * surfaceArea;

/** The crew capsule's half segment for QsWorld.hy: CREW_HEIGHT/2 − CREW_RADIUS (crew.ts constants). */
export const crewQsHy = (height: number, radius: number): number => (height * 0.5 > radius ? height * 0.5 - radius : 0);

/** Quadratic drag over h, exact for a fixed direction (the CONTACT-mode update): v ← v/(1 + k|v|h). */
export function dragStep(v: V3, k: number, h: number): void {
  if (!(k > 0)) return;
  const s = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z), f = 1 / (1 + k * s * h);
  v.x *= f; v.y *= f; v.z *= f;
}

/** Static grid over boxes (cell lists), cell edge `cell` m. Allocates: once per layout. */
export function makeQsGrid(boxes: Float64Array, nBoxes: number, cell = 1): QsGrid {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < nBoxes; k++) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], boxes[6 * k + c]); hi[c] = Math.max(hi[c], boxes[6 * k + 3 + c]); }
  if (nBoxes === 0) { lo[0] = lo[1] = lo[2] = 0; hi[0] = hi[1] = hi[2] = 1; }
  const g: QsGrid = { o: Float64Array.from(lo), n: new Int32Array(3), cell, start: new Int32Array(1), items: new Int32Array(0), stamp: new Int32Array(nBoxes), tick: 0 };
  for (let c = 0; c < 3; c++) g.n[c] = Math.max(1, Math.ceil((hi[c] - lo[c]) / cell));
  const nc = g.n[0] * g.n[1] * g.n[2], lists: number[][] = [];
  for (let c = 0; c < nc; c++) lists.push([]);
  for (let k = 0; k < nBoxes; k++) {
    const a0 = cellOf(g, boxes[6 * k], 0), a1 = cellOf(g, boxes[6 * k + 3], 0), b0 = cellOf(g, boxes[6 * k + 1], 1), b1 = cellOf(g, boxes[6 * k + 4], 1);
    const c0 = cellOf(g, boxes[6 * k + 2], 2), c1 = cellOf(g, boxes[6 * k + 5], 2);
    for (let x = a0; x <= a1; x++) for (let y = b0; y <= b1; y++) for (let z = c0; z <= c1; z++) lists[(x * g.n[1] + y) * g.n[2] + z].push(k);
  }
  g.start = new Int32Array(nc + 1);
  for (let c = 0; c < nc; c++) g.start[c + 1] = g.start[c] + lists[c].length;
  g.items = Int32Array.from(lists.flat());
  return g;
}

function cellOf(g: QsGrid, x: number, c: number): number {
  const i = Math.floor((x - g.o[c]) / g.cell), n = g.n[c] - 1;
  return i < 0 ? 0 : i > n ? n : i;
}

/** A QsWorld for n bodies with its static grid. Optional per-body arrays default to r 0.05, k 0, μ 0.5. */
export function makeQsWorld(
  boxes: Float64Array, nBoxes: number, n: number,
  o: { r?: ArrayLike<number>; k?: ArrayLike<number>; mu?: ArrayLike<number>; hy?: ArrayLike<number>; I?: ArrayLike<number>; selfJump?: ArrayLike<number>; cell?: number } = {},
): QsWorld {
  const f = (a: ArrayLike<number> | undefined, d: number, m = 1): Float64Array => {
    const out = new Float64Array(n * m).fill(d);
    if (a) for (let i = 0; i < out.length && i < a.length; i++) out[i] = a[i];
    return out;
  };
  const w: QsWorld = { boxes, nBoxes, r: f(o.r, 0.05), k: f(o.k, 0), mu: f(o.mu, 0.5), grid: makeQsGrid(boxes, nBoxes, o.cell ?? 1) };
  if (o.hy) w.hy = f(o.hy, 0);
  if (o.I) w.I = f(o.I, 0, 3);
  if (o.selfJump) { w.selfJump = new Uint8Array(n); for (let i = 0; i < n && i < o.selfJump.length; i++) w.selfJump[i] = o.selfJump[i] ? 1 : 0; }
  return w;
}

// ------------------------------------------------------------------------------------------------ rotation helpers

/** out = q·(x,y,z) (craft → inertial). */
function rot(out: V3, q: Quat, x: number, y: number, z: number): void {
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
}
/** out = q⁻¹·(x,y,z) (inertial → craft). */
function rotInv(out: V3, q: Quat, x: number, y: number, z: number): void {
  const qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
}
/** out = a·b (Hamilton). out may alias a or b. */
function qmul(out: Quat, a: Quat, b: Quat): void {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  out.x = x; out.y = y; out.z = z; out.w = w;
}
/** out = a⁻¹·b. */
function qmulInv(out: Quat, a: Quat, b: Quat): void {
  const ax = -a.x, ay = -a.y, az = -a.z, aw = a.w;
  const x = aw * b.x + ax * b.w + ay * b.z - az * b.y;
  const y = aw * b.y - ax * b.z + ay * b.w + az * b.x;
  const z = aw * b.z + ax * b.y - ay * b.x + az * b.w;
  const w = aw * b.w - ax * b.x - ay * b.y - az * b.z;
  out.x = x; out.y = y; out.z = z; out.w = w;
}
/** out = rotation by angle `ang` about unit axis (x, y, z). */
function qaxis(out: Quat, x: number, y: number, z: number, ang: number): void {
  const h = 0.5 * ang, s = msin(h);
  out.x = x * s; out.y = y * s; out.z = z * s; out.w = mcos(h);
}
function qnorm(q: Quat): void {
  const l = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  if (l > 0) { const s = 1 / l; q.x *= s; q.y *= s; q.z *= s; q.w *= s; }
}

// ------------------------------------------------------------------------------------------------ rest

const F: V3 = v3();

/**
 * How far the felt acceleration f is outside the friction cone of a surface with normal n (out of the surface):
 * |f_t| − μ·max(0, −f·n) + max(0, f·n), m/s² (≤ 0 inside the cone; a pull off the surface counts in full).
 */
export function restMargin(f: V3, n: V3, mu: number): number {
  const fn = f.x * n.x + f.y * n.y + f.z * n.z;
  const tx = f.x - fn * n.x, ty = f.y - fn * n.y, tz = f.z - fn * n.z;
  return Math.sqrt(tx * tx + ty * ty + tz * tz) - mu * (fn < 0 ? -fn : 0) + (fn > 0 ? fn : 0);
}

/**
 * Does a surface (normal n, out of it) hold a resting body through a ship-frame velocity jump `j` (m/s, the
 * jump the body would take if loose: −Δv − Δω×r)? The surface must supply Δv = −j: it pushes freely, pulls at most
 * the felt load's impulse N·h (fn = f·n, into the surface when < 0), and passes |Δv_t| ≤ μ(Δv_n + N·h).
 */
export function restHoldsJump(j: V3, n: V3, mu: number, fn: number, h: number): boolean {
  const rx = -j.x, ry = -j.y, rz = -j.z, rn = rx * n.x + ry * n.y + rz * n.z;
  const cap = (fn < 0 ? -fn : 0) * h, nImp = rn + cap;
  if (nImp < 0) return false;
  const tx = rx - rn * n.x, ty = ry - rn * n.y, tz = rz - rn * n.z;
  return tx * tx + ty * ty + tz * tz <= mu * mu * nImp * nImp;
}

/** Ticks until the cone margin could exceed REST_WAKE_A, given |d(felt)/dt| ≤ fDot (NEVER when fDot = 0). */
export function restWakeTicks(margin: number, fDot: number): number {
  if (!(fDot > 0)) return NEVER;
  const t = (REST_WAKE_A - margin) / (2 * fDot);
  if (!(t > Q)) return 1;
  const k = Math.floor(t / Q);
  return k < NEVER ? k : NEVER;
}

/** Felt acceleration at a point fixed in the ship (v = 0), with the motion's terms. */
function feltFixed(m: BodyMotion, p: V3): V3 {
  return feltAt(m, p.x, p.y, p.z, 0, 0, 0, F);
}

/** Put a body that came to rest on a surface (unit normal n, craft axes) into REST if the cone holds. */
export function tryRest(b: QsBody, mu: number, tick: number, m: BodyMotion, nx: number, ny: number, nz: number): boolean {
  const v = b.v;
  if (v.x * v.x + v.y * v.y + v.z * v.z >= REST_V * REST_V) return false;
  const s = b.qs;
  s.n.x = nx; s.n.y = ny; s.n.z = nz;
  const g = restMargin(feltFixed(m, b.p), s.n, mu);
  if (!(g <= REST_ENTER_A)) return false;
  s.mode = MODE_REST;
  v.x = v.y = v.z = 0;
  if (b.w) { b.w.x = b.w.y = b.w.z = 0; }
  s.tick0 = tick; s.tickS = tick;
  const w = restWakeTicks(g, m.fDot);
  s.tickEnd = w >= NEVER ? NEVER : tick + w;
  return true;
}

// ------------------------------------------------------------------------------------------------ drift: translation

const X: V3 = v3();
const VV: V3 = v3();
const AN: V3 = v3();
const WI: V3 = v3();

/** Drag model of an anchor: 0 none, 1 fixed direction along û₀ (+ felt free), 2 exact 1-D along the felt. */
function dragMode(s: QsState, k: number): number {
  const u = s.u0, a = s.aS, uu = u.x * u.x + u.y * u.y + u.z * u.z;
  if (!(k > 0)) return 0;
  const A2 = a.x * a.x + a.y * a.y + a.z * a.z;
  if (!(A2 > 0)) return uu > 0 ? 1 : 0;
  const A = Math.sqrt(A2), ex = -a.x / A, ey = -a.y / A, ez = -a.z / A, s0 = u.x * ex + u.y * ey + u.z * ez;
  const px = u.x - s0 * ex, py = u.y - s0 * ey, pz = u.z - s0 * ez, pp = px * px + py * py + pz * pz;
  const vt2 = A / k, sc2 = uu > vt2 ? uu : vt2;
  return pp <= ONE_D_REL * ONE_D_REL * sc2 ? 2 : uu > 0 ? 1 : 0;
}

/** ln cosh y, overflow-free. */
const lncosh = (y: number): number => { const a = y < 0 ? -y : y; return a + mlog1p(mexp(-2 * a)) - Math.LN2; };
/** ln sinh y, y > 0. */
const lnsinh = (y: number): number => y + mlog(-mexpm1(-2 * y)) - Math.LN2;
/** tanh y, y ≥ 0. */
const tanhP = (y: number): number => { const e = mexp(-2 * y); return -mexpm1(-2 * y) / (1 + e); };
const atanhP = (x: number): number => 0.5 * mlog1p((2 * x) / (1 - x));

/** Closed-form drift state at `tick`, inertial axes (CoM-centred): position into x, velocity into vOut. */
export function driftEval(s: QsState, tick: number, k: number, x: V3, vOut: V3): void {
  const t = (tick - s.tick0) * Q;
  const a = s.aS, u = s.u0, x0 = s.x0, v0 = s.v0;
  const mode = t > 0 ? dragMode(s, k) : 0;
  if (mode === 2) {
    // 1-D along ê = −â_s: s' = A − k s|s|; v = v₀ + (s − s₀)ê, x = x₀ + v₀t + (S − s₀t)ê
    const A = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z), ex = -a.x / A, ey = -a.y / A, ez = -a.z / A;
    const s0 = u.x * ex + u.y * ey + u.z * ez, vt = Math.sqrt(A / k), g = Math.sqrt(A * k), ik = 1 / k;
    let sp: number, S: number;
    if (s0 >= 0) {
      const r = s0 / vt;
      if (r === 1) { sp = vt; S = vt * t; }
      else if (r < 1) { const c = atanhP(r), y = c + g * t; sp = vt * tanhP(y); S = (lncosh(y) - lncosh(c)) * ik; }
      else { const c = atanhP(1 / r), y = c + g * t; sp = vt / tanhP(y); S = (lnsinh(y) - lnsinh(c)) * ik; }
    } else {
      const th0 = matan(s0 / vt), t1 = -th0 / g;
      if (t <= t1) { const th = th0 + g * t; sp = vt * mtan(th); S = -(mlog(mcos(th)) - mlog(mcos(th0))) * ik; }
      else { const y = g * (t - t1); sp = vt * tanhP(y); S = mlog(mcos(th0)) * ik + lncosh(y) * ik; }
    }
    const dS = S - s0 * t, dv = sp - s0;
    x.x = x0.x + v0.x * t + dS * ex; x.y = x0.y + v0.y * t + dS * ey; x.z = x0.z + v0.z * t + dS * ez;
    vOut.x = v0.x + dv * ex; vOut.y = v0.y + dv * ey; vOut.z = v0.z + dv * ez;
    return;
  }
  let px = x0.x + v0.x * t - 0.5 * a.x * t * t, py = x0.y + v0.y * t - 0.5 * a.y * t * t, pz = x0.z + v0.z * t - 0.5 * a.z * t * t;
  let vx = v0.x - a.x * t, vy = v0.y - a.y * t, vz = v0.z - a.z * t;
  if (mode === 1) {
    const sp = Math.sqrt(u.x * u.x + u.y * u.y + u.z * u.z), z = k * sp * t;
    const D = sp * t - mlog1p(z) / k, dV = sp - sp / (1 + z);
    const ux = u.x / sp, uy = u.y / sp, uz = u.z / sp;
    px -= D * ux; py -= D * uy; pz -= D * uz;
    vx -= dV * ux; vy -= dV * uy; vz -= dV * uz;
  }
  x.x = px; x.y = py; x.z = pz;
  vOut.x = vx; vOut.y = vy; vOut.z = vz;
}

/**
 * The drag model's excess approach acceleration beyond max(0, n·a_s): for every unit n, −n·(model's x'' + a_s)
 * ≤ max(0, n·a_s)·0 + mag·max(0, n·dir). Fixed-direction model: k|u₀|² along û₀. 1-D model (s = u·ê, ê = −â):
 * 0 ≤ s₀ ≤ v_t adds nothing (the net acceleration is λ(−a_s), λ ∈ [0, 1]); s₀ > v_t: (k s₀² − A) along ê;
 * s₀ < 0: k s₀² along −ê. Returns mag; the direction goes to DD.
 */
const DD: V3 = v3();
function dragExcess(s: QsState, k: number): number {
  const mode = dragMode(s, k);
  DD.x = 0; DD.y = 0; DD.z = 0;
  if (mode === 0) return 0;
  const u = s.u0, uu = u.x * u.x + u.y * u.y + u.z * u.z;
  if (mode === 1) { const l = Math.sqrt(uu); DD.x = u.x / l; DD.y = u.y / l; DD.z = u.z / l; return k * uu; }
  const a = s.aS, A = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z), ex = -a.x / A, ey = -a.y / A, ez = -a.z / A;
  const s0 = u.x * ex + u.y * ey + u.z * ez, ks = k * s0 * s0;
  if (s0 < 0) { DD.x = -ex; DD.y = -ey; DD.z = -ez; return ks; }
  if (ks > A) { DD.x = ex; DD.y = ey; DD.z = ez; return ks - A; }
  return 0;
}

/** Inertial state at the ship frame: p = q⁻¹x, v = q⁻¹v_in − ω × p. */
function inertialToShip(q: Quat, w: V3, xi: V3, vi: V3, p: V3, v: V3): void {
  rotInv(p, q, xi.x, xi.y, xi.z);
  rotInv(v, q, vi.x, vi.y, vi.z);
  const px = p.x, py = p.y, pz = p.z;
  v.x -= w.y * pz - w.z * py; v.y -= w.z * px - w.x * pz; v.z -= w.x * py - w.y * px;
}

/** Drift state at `tick` in the ship frame (craft axes): p = q⁻¹x, v = q⁻¹v_in − ω × p. */
export function driftToShip(s: QsState, tick: number, k: number, q: Quat, w: V3, p: V3, v: V3): void {
  driftEval(s, tick, k, X, VV);
  inertialToShip(q, w, X, VV, p, v);
}

/** Re-anchor at `tick` from an inertial state (x, v): the ship's acceleration aIn (inertial); the air co-rotates. */
function reanchor(s: QsState, tick: number, x: V3, v: V3, aIn: V3, q: Quat, w: V3): void {
  s.x0.x = x.x; s.x0.y = x.y; s.x0.z = x.z;
  s.v0.x = v.x; s.v0.y = v.y; s.v0.z = v.z;
  s.aS.x = aIn.x; s.aS.y = aIn.y; s.aS.z = aIn.z;
  rot(WI, q, w.x, w.y, w.z);
  // air-relative velocity u = v − ω × x (inertial axes)
  s.u0.x = v.x - (WI.y * x.z - WI.z * x.y); s.u0.y = v.y - (WI.z * x.x - WI.x * x.z); s.u0.z = v.z - (WI.x * x.y - WI.y * x.x);
  s.tick0 = tick;
}

/** Anchor a free body at `tick` from its ship-frame state (p, v, and q, w when present), attitude q, motion m. */
export function anchorDrift(b: QsBody, tick: number, m: BodyMotion, q: Quat, wd?: QsWorld, i = 0): void {
  const s = b.qs, p = b.p, v = b.v, w = m.w;
  s.mode = MODE_DRIFT;
  rot(s.x0, q, p.x, p.y, p.z);
  // inertial velocity relative to the CoM: v + ω × p, in inertial axes
  rot(s.v0, q, v.x + (w.y * p.z - w.z * p.y), v.y + (w.z * p.x - w.x * p.z), v.z + (w.x * p.y - w.y * p.x));
  rot(s.aS, q, m.a.x, m.a.y, m.a.z);
  // the cabin air co-rotates with the ship: the air-relative velocity is the ship-frame velocity
  rot(s.u0, q, v.x, v.y, v.z);
  s.tick0 = tick;
  s.tickEnd = tick;
  s.tickS = tick;
  anchorRot(b, wd, i, tick, m, q);
}

const NI: V3 = v3();

/**
 * Longest time (s) the anchored body certainly touches nothing. For every static box, with n₀ the unit direction
 * from the box's closest point to the body (a sphere of radius r, or the upright capsule segment ±hy about p) and
 * d₀ that distance, convexity gives gap(τ) ≥ d₀ − r + n₀·Δp_ship(τ) and, in inertial axes,
 *   −n₀·Δp ≤ c τ + ½A τ²,  c = max(0, −N₀·v₀) + ω_B·r_eff,  A = max(0, N₀·a_R) + dB + α_B·r_eff,
 * (+ dragB·max(0, N₀·d̂)), where N₀ = q·n₀, dB bounds |a_s − a_R| for every later re-anchor of this schedule,
 * dragB along d̂ the drag model's excess (dragExcess), and r_eff bounds |x(τ)|
 * over DRIFT_MAX (the walls sweep as the ship turns). Other bodies take half their gap each, isotropic. Every gap
 * gets DRIFT_SLOP. With a static grid only boxes within the isotropic reach are visited (two passes). Then the
 * caps: DRIFT_MAX, DRIFT_N/n, 0.2/|ω| with drag (the air co-rotates), and the neglected-drag caps of the
 * fixed-direction model under a felt acceleration. The schedule fields (aR, dB, wB, alB) must be set.
 */
export function driftBound(b: QsBody, i: number, bodies: readonly QsBody[], w: QsWorld, m: BodyMotion, q: Quat): number {
  const s = b.qs, p = b.p, r = w.r[i], k = w.k[i], hy = w.hy ? w.hy[i] : 0;
  const v0 = s.v0, aR = s.aR, dB = s.dB, wB = s.wB, alB = s.alB, dragB = s.dragB;
  const vl = Math.sqrt(v0.x * v0.x + v0.y * v0.y + v0.z * v0.z), al2 = Math.sqrt(aR.x * aR.x + aR.y * aR.y + aR.z * aR.z);
  const x0l = Math.sqrt(s.x0.x * s.x0.x + s.x0.y * s.x0.y + s.x0.z * s.x0.z);
  const T = DRIFT_MAX, rEff = x0l + vl * T + 0.5 * (al2 + dB + dragB) * T * T;
  const cRot = wB * rEff, aRot = alB * rEff;
  let best = DRIFT_MAX;
  if (m.n2 > 0) { const c = DRIFT_N / Math.sqrt(m.n2); if (c < best) best = c; }
  const W = m.w, wl = Math.sqrt(W.x * W.x + W.y * W.y + W.z * W.z);
  const dm = dragMode(s, k);
  if (dm !== 0 && wl > 0) { const c = 0.2 / wl; if (c < best) best = c; }
  if (dm === 1 && al2 > 0) {
    // the felt part of the velocity is not dragged: k(U A t³/3 + A² t⁴/12) < ε_x, k(U A t² + A² t³/3) < ε_v
    const u = s.u0, U = Math.sqrt(u.x * u.x + u.y * u.y + u.z * u.z), A = al2;
    let c = mpow((6 * DRAG_EPS_X) / (k * A * A), 0.25);
    if (c < best) best = c;
    c = mpow((1.5 * DRAG_EPS_V) / (k * A * A), 1 / 3);
    if (c < best) best = c;
    if (U > 0) {
      c = mpow((1.5 * DRAG_EPS_X) / (k * U * A), 1 / 3);
      if (c < best) best = c;
      c = Math.sqrt(DRAG_EPS_V / (2 * k * U * A));
      if (c < best) best = c;
    }
  }
  if (dm === 2) {
    // the 1-D form does not drag the cross velocity u⊥: k·u_max·|u⊥|·t < ε_v, ½k·u_max·|u⊥|·t² < ε_x
    const u = s.u0, A = al2, ex = -aR.x / A, ey = -aR.y / A, ez = -aR.z / A, s0 = u.x * ex + u.y * ey + u.z * ez;
    const px = u.x - s0 * ex, py = u.y - s0 * ey, pz = u.z - s0 * ez, up = Math.sqrt(px * px + py * py + pz * pz);
    if (up > 0) {
      const uu = Math.sqrt(u.x * u.x + u.y * u.y + u.z * u.z), vt = Math.sqrt(A / k), r1 = k * (uu > vt ? uu : vt) * up;
      let c = DRAG_EPS_V / r1;
      if (c < best) best = c;
      c = Math.sqrt((2 * DRAG_EPS_X) / r1);
      if (c < best) best = c;
    }
  }
  const cI = vl + cRot, aI = al2 + dB + dragB + aRot;
  const g = w.grid;
  if (!g) {
    for (let j = 0, o = 0; j < w.nBoxes; j++, o += 6) { const t = boxTime(w.boxes, o, p, r, hy, v0, aR, dB, s.dragD, dragB, cRot, aRot, cI, aI, q); if (t < best) best = t; }
  } else {
    const stamp = ++g.tick, st = g.stamp, items = g.items, start = g.start, gy = g.n[1], gz = g.n[2], bx = w.boxes;
    let Tp = best < GRID_PASS_T ? best : GRID_PASS_T;
    for (let pass = 0; pass < 2; pass++) {
      const reach = cI * Tp + 0.5 * aI * Tp * Tp + r + DRIFT_SLOP;
      const x0 = cellOf(g, p.x - reach, 0), x1 = cellOf(g, p.x + reach, 0), y0 = cellOf(g, p.y - hy - reach, 1), y1 = cellOf(g, p.y + hy + reach, 1);
      const z0 = cellOf(g, p.z - reach, 2), z1 = cellOf(g, p.z + reach, 2);
      for (let gx = x0; gx <= x1; gx++) for (let gyi = y0; gyi <= y1; gyi++) for (let gzi = z0; gzi <= z1; gzi++) {
        const c = (gx * gy + gyi) * gz + gzi;
        for (let it = start[c], end = start[c + 1]; it < end; it++) {
          const j = items[it];
          if (st[j] === stamp) continue;
          st[j] = stamp;
          const t = boxTime(bx, 6 * j, p, r, hy, v0, aR, dB, s.dragD, dragB, cRot, aRot, cI, aI, q);
          if (t < best) best = t;
        }
      }
      // every box not visited is farther than `reach`: it cannot be touched before Tp
      if (best <= Tp) break;
      Tp = best;
    }
  }
  // other bodies: each may close half the gap (isotropic, ship frame: |v_rel| plus the turning terms)
  for (let j = 0; j < bodies.length; j++) {
    if (j === i) continue;
    const o = bodies[j], dx = o.p.x - p.x, dy = o.p.y - p.y, dz = o.p.z - p.z;
    let gp = Math.sqrt(dx * dx + dy * dy + dz * dz) - r - w.r[j] - hy - (w.hy ? w.hy[j] : 0);
    gp += DRIFT_SLOP;
    if (gp < 0) gp = 0;
    if (o.qs.mode !== MODE_REST) gp *= 0.5;
    const t = cI > 0 || aI > 0 ? (2 * gp) / (cI + Math.sqrt(cI * cI + 2 * aI * gp)) : Infinity;
    if (t < best) best = t;
  }
  return best;
}

function boxTime(
  bx: Float64Array, o: number, p: V3, r: number, hy: number, v0: V3, aR: V3, dB: number, dd: V3, dragB: number, cRot: number, aRot: number, cI: number, aI: number, q: Quat,
): number {
  const qx = p.x < bx[o] ? bx[o] : p.x > bx[o + 3] ? bx[o + 3] : p.x;
  const qz = p.z < bx[o + 2] ? bx[o + 2] : p.z > bx[o + 5] ? bx[o + 5] : p.z;
  // the segment [p.y − hy, p.y + hy] against [minY, maxY]
  const ya = p.y - hy, yb = p.y + hy;
  let ny: number;
  if (yb < bx[o + 1]) ny = yb - bx[o + 1];
  else if (ya > bx[o + 4]) ny = ya - bx[o + 4];
  else ny = 0;
  let nx = p.x - qx, nz = p.z - qz;
  const d = Math.sqrt(nx * nx + ny * ny + nz * nz);
  let c: number, A: number, g: number;
  if (d > 0) {
    nx /= d; ny /= d; nz /= d;
    rot(NI, q, nx, ny, nz);
    const vn = NI.x * v0.x + NI.y * v0.y + NI.z * v0.z, an = NI.x * aR.x + NI.y * aR.y + NI.z * aR.z;
    const dn = NI.x * dd.x + NI.y * dd.y + NI.z * dd.z;
    c = (vn < 0 ? -vn : 0) + cRot;
    A = (an > 0 ? an : 0) + dB + (dn > 0 ? dragB * dn : 0) + aRot;
    g = d - r;
  } else {
    c = cI; A = aI; g = 0;
  }
  g += DRIFT_SLOP;
  if (g < 0) g = 0;
  return c > 0 || A > 0 ? (2 * g) / (c + Math.sqrt(c * c + 2 * A * g)) : Infinity;
}

/**
 * Schedule the anchored body's segment end (the anchor must be at `tick`); records the bounds the schedule holds
 * for. False (and mode CONTACT) when it is within DRIFT_MIN_TICKS of a touch.
 */
export function scheduleDrift(b: QsBody, i: number, bodies: readonly QsBody[], w: QsWorld, tick: number, m: BodyMotion, q: Quat): boolean {
  const s = b.qs, W = m.w, al = m.alpha, a = s.aS;
  s.aR.x = a.x; s.aR.y = a.y; s.aR.z = a.z;
  s.dB = A_HEAD * Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z) + A_FLOOR;
  s.dragB = DRAG_HEAD * dragExcess(s, w.k[i]);
  s.dragD.x = DD.x; s.dragD.y = DD.y; s.dragD.z = DD.z;
  s.wB = W_HEAD * Math.sqrt(W.x * W.x + W.y * W.y + W.z * W.z) + W_FLOOR;
  s.alB = AL_HEAD * Math.sqrt(al.x * al.x + al.y * al.y + al.z * al.z) + AL_FLOOR;
  s.tickB = tick;
  const t = driftBound(b, i, bodies, w, m, q);
  const k = Math.floor(t / Q);
  if (!(k >= DRIFT_MIN_TICKS)) { s.mode = MODE_CONTACT; s.tickEnd = tick; return false; }
  s.mode = MODE_DRIFT;
  s.tickEnd = tick + k;
  return true;
}

/** True when the ship's proper acceleration (inertial axes, into AN) is no longer the anchor's. */
function accelChanged(s: QsState, m: BodyMotion, q: Quat): boolean {
  rot(AN, q, m.a.x, m.a.y, m.a.z);
  if (AN.x === s.aS.x && AN.y === s.aS.y && AN.z === s.aS.z) return false;
  // exact zero vs a rounding residue of a zero rotation is the same motion
  const dx = AN.x - s.aS.x, dy = AN.y - s.aS.y, dz = AN.z - s.aS.z;
  return dx * dx + dy * dy + dz * dz > 1e-24 * (1 + AN.x * AN.x + AN.y * AN.y + AN.z * AN.z);
}

/** Does the current anchor and motion still lie inside the bounds the schedule was made with? */
function withinSchedule(s: QsState, k: number, m: BodyMotion, tick: number): boolean {
  const a = s.aS, aR = s.aR, dx = a.x - aR.x, dy = a.y - aR.y, dz = a.z - aR.z;
  const dm = dragExcess(s, k);
  if (dm > s.dragB) return false;
  const ex = DD.x - s.dragD.x, ey = DD.y - s.dragD.y, ez = DD.z - s.dragD.z;
  if (Math.sqrt(dx * dx + dy * dy + dz * dz) + dm * Math.sqrt(ex * ex + ey * ey + ez * ez) > s.dB) return false;
  const W = m.w, al = m.alpha, alm = Math.sqrt(al.x * al.x + al.y * al.y + al.z * al.z);
  if (alm > s.alB) return false;
  const wm = Math.sqrt(W.x * W.x + W.y * W.y + W.z * W.z);
  return wm <= s.wB + s.alB * (tick - s.tickB) * Q;
}

// ------------------------------------------------------------------------------------------------ drift: rotation

const QA: Quat = { x: 0, y: 0, z: 0, w: 1 };
const QB: Quat = { x: 0, y: 0, z: 0, w: 1 };
const QI: Quat = { x: 0, y: 0, z: 0, w: 1 };
const WO: V3 = v3();
const T1: V3 = v3();
const T2: V3 = v3();
const AXE = [v3(), v3(), v3()];
AXE[0].x = 1; AXE[1].y = 1; AXE[2].z = 1;

/** Inertia kind: 0 none, 1 isotropic, 2 axisymmetric (axisOut = the distinct axis), 3 triaxial. */
let axisOut = 0;
function inertiaKind(I: Float64Array | undefined, i: number): number {
  if (!I) return 0;
  const a = I[3 * i], b = I[3 * i + 1], c = I[3 * i + 2];
  if (!(a > 0 && b > 0 && c > 0)) return 0;
  const tol = 1e-9 * (a + b + c);
  const ab = Math.abs(a - b) <= tol, bc = Math.abs(b - c) <= tol, ac = Math.abs(a - c) <= tol;
  if (ab && bc) return 1;
  if (ab) { axisOut = 2; return 2; }
  if (bc) { axisOut = 0; return 2; }
  if (ac) { axisOut = 1; return 2; }
  return 3;
}

/** out = R·I⁻¹·Rᵀ·L (inertial ω from inertial L), R = attitude qi (object → inertial). */
function omegaOf(out: V3, qi: Quat, I: Float64Array, i: number, L: V3): void {
  rotInv(T1, qi, L.x, L.y, L.z);
  rot(out, qi, T1.x / I[3 * i], T1.y / I[3 * i + 1], T1.z / I[3 * i + 2]);
}

function anchorRot(b: QsBody, w: QsWorld | undefined, i: number, tick: number, m: BodyMotion, q: Quat): void {
  const s = b.qs;
  s.rTick = tick;
  const kind = w && b.q && b.w ? inertiaKind(w.I, i) : 0;
  if (kind === 0 || !b.q || !b.w || !w || !w.I) { s.rn = -1; return; }
  const I = w.I;
  qmul(s.rq, q, b.q); qnorm(s.rq);
  // inertial ω (inertial axes) = q·(ω_rel + Ω)
  rot(WO, q, b.w.x + m.w.x, b.w.y + m.w.y, b.w.z + m.w.z);
  // L = R·I·Rᵀ·ω
  rotInv(T1, s.rq, WO.x, WO.y, WO.z);
  rot(s.rL, s.rq, T1.x * I[3 * i], T1.y * I[3 * i + 1], T1.z * I[3 * i + 2]);
  if (kind !== 3) { s.rn = 0; return; }
  // |ω| over the motion ≤ min(|L|/I_min, √(2E/I_min)), 2E = ω·L (both conserved)
  const L = s.rL, Ll = Math.sqrt(L.x * L.x + L.y * L.y + L.z * L.z), e2 = WO.x * L.x + WO.y * L.y + WO.z * L.z;
  const Imin = Math.min(I[3 * i], I[3 * i + 1], I[3 * i + 2]), wE = Math.sqrt((e2 > 0 ? e2 : 0) / Imin), wL = Ll / Imin;
  const wmax = wE < wL ? wE : wL;
  const n = wmax > 0 ? Math.floor(ROT_STEP / (wmax * Q)) : NEVER;
  s.rn = n < 1 ? 1 : n > 1e6 ? 1e6 : n;
}

const RK = new Float64Array(16);
/** dq/dt = ½ ω(q) ⊗ q into RK[o..o+3], for q = (x, y, z, w) (constant inertial L; ω = R I⁻¹ Rᵀ L). */
function qdot(o: number, x: number, y: number, z: number, w: number, I: Float64Array, i: number, L: V3): void {
  QB.x = x; QB.y = y; QB.z = z; QB.w = w;
  omegaOf(T2, QB, I, i, L);
  const wx = T2.x, wy = T2.y, wz = T2.z;
  RK[o] = 0.5 * (w * wx + wy * z - wz * y); RK[o + 1] = 0.5 * (w * wy + wz * x - wx * z);
  RK[o + 2] = 0.5 * (w * wz + wx * y - wy * x); RK[o + 3] = -0.5 * (wx * x + wy * y + wz * z);
}
/** One classical RK4 step of the torque-free attitude (4th order, no transcendentals), then renormalised. */
function rotMid(qi: Quat, I: Float64Array, i: number, L: V3, h: number): void {
  const x = qi.x, y = qi.y, z = qi.z, w = qi.w, hh = 0.5 * h;
  qdot(0, x, y, z, w, I, i, L);
  qdot(4, x + hh * RK[0], y + hh * RK[1], z + hh * RK[2], w + hh * RK[3], I, i, L);
  qdot(8, x + hh * RK[4], y + hh * RK[5], z + hh * RK[6], w + hh * RK[7], I, i, L);
  qdot(12, x + h * RK[8], y + h * RK[9], z + h * RK[10], w + h * RK[11], I, i, L);
  const h6 = h / 6;
  qi.x = x + h6 * (RK[0] + 2 * RK[4] + 2 * RK[8] + RK[12]); qi.y = y + h6 * (RK[1] + 2 * RK[5] + 2 * RK[9] + RK[13]);
  qi.z = z + h6 * (RK[2] + 2 * RK[6] + 2 * RK[10] + RK[14]); qi.w = w + h6 * (RK[3] + 2 * RK[7] + 2 * RK[11] + RK[15]);
  qnorm(qi);
}

/**
 * Attitude (object → inertial, into QI) and inertial angular velocity (inertial axes, into WO) at `tick`. The
 * triaxial path advances the saved grid state (rq, rTick) by whole steps ≤ tick; the remainder is one partial step
 * that is not saved, so the result does not depend on how often it is evaluated.
 */
function rotEval(s: QsState, I: Float64Array, i: number, tick: number): void {
  const kind = inertiaKind(I, i), L = s.rL;
  const Ll = Math.sqrt(L.x * L.x + L.y * L.y + L.z * L.z);
  if (kind === 3) {
    const n = s.rn;
    while (s.rTick + n <= tick) { rotMid(s.rq, I, i, L, n * Q); s.rTick += n; }
    QI.x = s.rq.x; QI.y = s.rq.y; QI.z = s.rq.z; QI.w = s.rq.w;
    if (tick > s.rTick) rotMid(QI, I, i, L, (tick - s.rTick) * Q);
    omegaOf(WO, QI, I, i, L);
    return;
  }
  const t = (tick - s.rTick) * Q;
  if (kind === 1) {
    const Iv = (I[3 * i] + I[3 * i + 1] + I[3 * i + 2]) / 3;
    if (Ll > 0) { qaxis(QA, L.x / Ll, L.y / Ll, L.z / Ll, (Ll / Iv) * t); qmul(QI, QA, s.rq); qnorm(QI); }
    else { QI.x = s.rq.x; QI.y = s.rq.y; QI.z = s.rq.z; QI.w = s.rq.w; }
    WO.x = L.x / Iv; WO.y = L.y / Iv; WO.z = L.z / Iv;
    return;
  }
  // axisymmetric: Q(t) = R(L̂, |L|t/I₁)·Q₀·R(ê₃, βt), β = (1 − I₃/I₁)ω₃, ω = L/I₁ + β·e₃(t)
  const c = axisOut, I3 = I[3 * i + c], I1 = 0.5 * (I[3 * i + (c + 1) % 3] + I[3 * i + (c + 2) % 3]);
  const e = AXE[c];
  rot(T1, s.rq, e.x, e.y, e.z);
  const w3 = (L.x * T1.x + L.y * T1.y + L.z * T1.z) / I3, beta = (1 - I3 / I1) * w3;
  qaxis(QB, e.x, e.y, e.z, beta * t);
  qmul(QI, s.rq, QB);
  if (Ll > 0) { qaxis(QA, L.x / Ll, L.y / Ll, L.z / Ll, (Ll / I1) * t); qmul(QI, QA, QI); rot(T2, QA, T1.x, T1.y, T1.z); }
  else { T2.x = T1.x; T2.y = T1.y; T2.z = T1.z; }
  qnorm(QI);
  WO.x = L.x / I1 + beta * T2.x; WO.y = L.y / I1 + beta * T2.y; WO.z = L.z / I1 + beta * T2.z;
}

/** Write the drifting body's ship-frame attitude and angular velocity at `tick`. */
function rotToShip(b: QsBody, w: QsWorld, i: number, tick: number, m: BodyMotion, q: Quat): void {
  const s = b.qs;
  if (s.rn < 0 || !b.q || !b.w || !w.I) return;
  rotEval(s, w.I, i, tick);
  qmulInv(b.q, q, QI); qnorm(b.q);
  rotInv(b.w, q, WO.x, WO.y, WO.z);
  b.w.x -= m.w.x; b.w.y -= m.w.y; b.w.z -= m.w.z;
}

/** RK4 steps the triaxial drifting bodies will take over the next `ticks` (for the warp-quantum budget). */
export function rotSteps(bodies: readonly QsBody[], ticks: number): number {
  let n = 0;
  for (let i = 0; i < bodies.length; i++) { const s = bodies[i].qs; if (s.mode === MODE_DRIFT && s.rn > 0) n += Math.ceil(ticks / s.rn); }
  return n;
}

// ------------------------------------------------------------------------------------------------ the scheduler

export const WHY_NONE = 0;
export const WHY_CONTACT = 1;
export const WHY_DRIFT = 2;
export const WHY_REST = 3;
/** Why the last nextBodyEvent result is what it is (WHY_*), and the body index that set it (-1 for none). */
export const bodyEvent = { why: WHY_NONE, body: -1 };

/**
 * Ticks (≥ 1) until some body needs the world at tick resolution, at most tMaxTicks: 1 while any body is in
 * CONTACT (the caller reports limitedBy 'props' / 'crew'), else the earliest DRIFT segment end or REST re-check.
 */
export function nextBodyEvent(bodies: readonly QsBody[], tick: number, tMaxTicks: number): number {
  let best = tMaxTicks > 1 ? tMaxTicks : 1, why = WHY_NONE, who = -1;
  for (let i = 0; i < bodies.length; i++) {
    const s = bodies[i].qs;
    if (s.mode === MODE_CONTACT) { bodyEvent.why = WHY_CONTACT; bodyEvent.body = i; return 1; }
    const d = s.tickEnd - tick;
    if (d < best) { best = d < 1 ? 1 : d; why = s.mode === MODE_DRIFT ? WHY_DRIFT : WHY_REST; who = i; }
  }
  bodyEvent.why = why; bodyEvent.body = who;
  return best;
}

const JMP: V3 = v3();
const DVI: V3 = v3();
const ZERO: V3 = { x: 0, y: 0, z: 0 };

/** Counters for tests and benches: re-anchors and re-schedules done by serviceBodies since the last reset. */
export const qsStats = { reanchors: 0, reschedules: 0 };

/**
 * At a tick boundary (every tick at 1×, every quantum end under warp), with m = the ledger mean since the last
 * call and dv, dw = the ship's impulsive Δv, Δω over that interval (craft axes; null = none):
 * - CONTACT: v += −Δv − Δω×p, ω_rel −= Δω (unless selfJump).
 * - DRIFT: if the ship's acceleration changed, re-anchor at the last serviced tick with the new a_s (the mean
 *   belongs to the whole interval); evaluate at `tick`; an impulse changes the inertial velocity by −q·Δv (the
 *   Δω part follows from the new ω) and re-schedules; so does the segment end or a motion outside the schedule's
 *   bounds (or the hand-over to CONTACT). Writes p, v (and q, w) in the ship frame.
 * - REST: an impulse outside the impulse cone wakes it to CONTACT with the jump applied; the felt cone is
 *   re-checked and wakes it when the margin exceeds REST_WAKE_A.
 * Returns the number of bodies in CONTACT afterwards.
 */
export function serviceBodies(
  bodies: readonly QsBody[], w: QsWorld, tick: number, m: BodyMotion, q: Quat, dv: V3 | null = null, dw: V3 | null = null,
): number {
  const Dv = dv ?? ZERO, Dw = dw ?? ZERO;
  const jumped = Dv.x !== 0 || Dv.y !== 0 || Dv.z !== 0 || Dw.x !== 0 || Dw.y !== 0 || Dw.z !== 0;
  if (jumped) rot(DVI, q, Dv.x, Dv.y, Dv.z);
  let nc = 0;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i], s = b.qs, k = w.k[i];
    if (s.mode === MODE_DRIFT) {
      const changed = accelChanged(s, m, q);
      if (changed) {
        driftEval(s, s.tickS < tick ? s.tickS : tick, k, X, VV);
        reanchor(s, s.tickS < tick ? s.tickS : tick, X, VV, AN, q, m.w);
        qsStats.reanchors++;
      }
      if (tick >= s.tickEnd || jumped || !withinSchedule(s, k, m, tick)) {
        driftEval(s, tick, k, X, VV);
        if (jumped) { VV.x -= DVI.x; VV.y -= DVI.y; VV.z -= DVI.z; }
        reanchor(s, tick, X, VV, s.aS, q, m.w);
        inertialToShip(q, m.w, X, VV, b.p, b.v);
        qsStats.reschedules++;
        scheduleDrift(b, i, bodies, w, tick, m, q);
      } else {
        driftToShip(s, tick, k, q, m.w, b.p, b.v);
      }
      rotToShip(b, w, i, tick, m, q);
      s.tickS = tick;
    } else if (s.mode === MODE_REST) {
      const f = feltFixed(m, b.p);
      if (jumped) {
        const p = b.p;
        JMP.x = -Dv.x - (Dw.y * p.z - Dw.z * p.y); JMP.y = -Dv.y - (Dw.z * p.x - Dw.x * p.z); JMP.z = -Dv.z - (Dw.x * p.y - Dw.y * p.x);
        const fn = f.x * s.n.x + f.y * s.n.y + f.z * s.n.z;
        if (!restHoldsJump(JMP, s.n, w.mu[i], fn, Q)) {
          s.mode = MODE_CONTACT; s.tickEnd = tick;
          b.v.x += JMP.x; b.v.y += JMP.y; b.v.z += JMP.z;
          if (b.w) { b.w.x -= Dw.x; b.w.y -= Dw.y; b.w.z -= Dw.z; }
        }
      }
      if (s.mode === MODE_REST) {
        const g = restMargin(f, s.n, w.mu[i]);
        if (g > REST_WAKE_A) { s.mode = MODE_CONTACT; s.tickEnd = tick; }
        else if (tick >= s.tickEnd) { const kk = restWakeTicks(g, m.fDot); s.tickEnd = kk >= NEVER ? NEVER : tick + kk; }
      }
      s.tickS = tick;
    } else if (jumped && !(w.selfJump && w.selfJump[i])) {
      const p = b.p, v = b.v;
      v.x += -Dv.x - (Dw.y * p.z - Dw.z * p.y); v.y += -Dv.y - (Dw.z * p.x - Dw.x * p.z); v.z += -Dv.z - (Dw.x * p.y - Dw.y * p.x);
      if (b.w) { b.w.x -= Dw.x; b.w.y -= Dw.y; b.w.z -= Dw.z; }
    }
    if (s.mode === MODE_CONTACT) nc++;
  }
  return nc;
}

/**
 * After the CONTACT solver's step for body i: touching (with the support normal nx, ny, nz) and slow and inside
 * the cone → REST; otherwise → DRIFT (when the segment would be ≥ DRIFT_MIN_TICKS; bodies touching a box they are
 * not approaching may drift along it). Returns the new mode.
 */
export function afterContact(
  b: QsBody, i: number, bodies: readonly QsBody[], w: QsWorld, tick: number, m: BodyMotion, q: Quat, touching: boolean, nx: number, ny: number, nz: number,
): number {
  if (touching && tryRest(b, w.mu[i], tick, m, nx, ny, nz)) return MODE_REST;
  anchorDrift(b, tick, m, q, w, i);
  scheduleDrift(b, i, bodies, w, tick, m, q);
  return b.qs.mode;
}

// ------------------------------------------------------------------------------------------------ save / load

const num = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const lv = (x: unknown, d: V3): V3 => {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  return { x: num(o.x, d.x), y: num(o.y, d.y), z: num(o.z, d.z) };
};
const lq = (x: unknown): Quat => {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  return { x: num(o.x, 0), y: num(o.y, 0), z: num(o.z, 0), w: num(o.w, 1) };
};
const Z3: V3 = { x: 0, y: 0, z: 0 };
const UP: V3 = { x: 0, y: 1, z: 0 };

export function saveQsState(s: QsState): QsState {
  return {
    mode: s.mode, n: { ...s.n }, x0: { ...s.x0 }, v0: { ...s.v0 }, aS: { ...s.aS }, u0: { ...s.u0 }, tick0: s.tick0, tickEnd: s.tickEnd, tickS: s.tickS,
    aR: { ...s.aR }, dB: s.dB, dragB: s.dragB, dragD: { ...s.dragD }, wB: s.wB, alB: s.alB, tickB: s.tickB, rq: { ...s.rq }, rL: { ...s.rL }, rTick: s.rTick, rn: s.rn,
  };
}

/**
 * Loader with defaults: a save without the field gives CONTACT, which re-derives REST / DRIFT within a tick. A
 * DRIFT save without the schedule bounds gets dB = wB = alB = 0, which re-schedules at the next service.
 */
export function loadQsState(data: unknown): QsState {
  const o = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const mode = o.mode === MODE_REST || o.mode === MODE_DRIFT ? (o.mode as number) : MODE_CONTACT;
  const tick0 = num(o.tick0, 0);
  return {
    mode, n: lv(o.n, UP), x0: lv(o.x0, Z3), v0: lv(o.v0, Z3), aS: lv(o.aS, Z3), u0: lv(o.u0, Z3),
    tick0, tickEnd: num(o.tickEnd, 0), tickS: num(o.tickS, tick0),
    aR: lv(o.aR, Z3), dB: num(o.dB, 0), dragB: num(o.dragB, 0), dragD: lv(o.dragD, Z3), wB: num(o.wB, 0), alB: num(o.alB, 0), tickB: num(o.tickB, tick0),
    rq: lq(o.rq), rL: lv(o.rL, Z3), rTick: num(o.rTick, tick0), rn: num(o.rn, -1),
  };
}
