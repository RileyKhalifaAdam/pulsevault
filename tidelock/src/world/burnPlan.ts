// The burn planner (docs/SIMULATION.md W3-C item 6, `fc-planner-unreachable`): impulsive and finite burns planned on
// the ghost integrator of predict.ts (called, not changed), a closed-form CW intercept from the relative-navigation
// estimate, a Newton shooting solver that refines a burn on the ghost in time slices, and the encoder dials.
//
// Finite burns. Thrust F at exhaust velocity vₑ from mass m₀ for Δv takes  t_b = m₀·vₑ/F·(1 − e^(−Δv/vₑ)).
// The burn is placed so its Δv CENTROID falls on the node: t_c = ∫t·a dt / Δv = m₀vₑ/F − vₑ·t_b/Δv from ignition
// (≈ t_b/2 for a short burn; later for a long one, since the ship lightens). That is the placement that matches the
// impulse to first order in the orbital rate (the "centred on the node" of the plan, made exact for a falling mass).
// The ghost takes the burn as K ≤ 12 impulses (predict.ts takes ≤ 16 burns), one per equal-time segment, each with
// the segment's exact rocket-equation Δv_k = vₑ·ln(m_k/m_{k+1}) and applied at the segment's own Δv centroid, so
// gravity acts across the burn as it will in flight. The direction is held constant in the predictor's
// (prograde, normal, radial) basis — the basis the BURN hold steers in — so the ghost and the flown burn follow the
// same steering law. Residual error: O((h·n)²) per segment in direction and the O(h³) kick–drift error (measured in
// tests/burnPlan.test.ts against a flown burn).
//
// WIRING (wave 3):
// - session planned burns (PlannedBurn: t, prograde, normal, radial) gain {finite: boolean}; when building
//   predOpts.burns, a finite burn is expanded with finiteBurnSegments(b, m₀, F, vₑ, SEG, SEGS) into SEGS[0..k) and those go
//   in place of the impulse. F, vₑ: the engine the BURN hold will use (main drive F_max·throttle_set, or RCS).
// - The BURN hold (session.holdTarget 'burn') already points along (prograde, normal, radial); W3-C's session hook
//   lights the drive at burnStart(...) and cuts it at burnStart + t_b (or when the ledger's Δv reaches the plan).
// - Encoders (W3-D's `encoder` device kind): each detent edge → dialStep(plan, axis, ±1, detentsPerSecond); the
//   push-to-enter on the TIME dial commits; the TGT push runs BurnSolver (sliced in the predictor's ≤ 0.3 ms budget).
// - cwIntercept reads the NavState only (sensors.ts): the planner sees the target through the sensors. The ghost of
//   the TARGET in predict.ts still starts from the target's true state (predict.ts loads it from the craft): wave 3
//   should add a `targetState` override to PredictOptions fed from navInertialAt; until then BurnSolver's target leg
//   is truth (flagged in the report).
// - Nothing here is saved except the dials (PlanDials: four integers), which belong in the session save.

import type { V3 } from '../core/types';
import type { PredictBurn, Prediction } from './predict';
import { createPrediction, Predictor } from './predict';
import type { World } from './state';
import { findCraft } from './state';
import type { NavState } from './relnav';
import { navHillAt } from './relnav';
import { perfNow } from './math';

const msqrt = (x: number): number => Math.sqrt(x);
const mexp = (x: number): number => Math.exp(x);
const mlog = (x: number): number => Math.log(x);
const msin = (x: number): number => Math.sin(x);
const mcos = (x: number): number => Math.cos(x);

// ------------------------------------------------------------------------------------------------ finite burns

/** Burn time for Δv from mass m0 at thrust F and exhaust velocity ve, s. */
export function finiteBurnTime(m0: number, F: number, ve: number, dv: number): number {
  if (!(dv > 0) || !(F > 0)) return 0;
  return ((m0 * ve) / F) * (1 - mexp(-dv / ve));
}

/** Time from ignition to the Δv centroid of the burn, s. */
export function burnCentroid(m0: number, F: number, ve: number, dv: number): number {
  if (!(dv > 0) || !(F > 0)) return 0;
  const tb = finiteBurnTime(m0, F, ve, dv), x = dv / ve;
  // m0·ve/F − ve·tb/dv loses digits for a short burn: series in x = Δv/vₑ there.
  if (x < 1e-3) return (tb / 2) * (1 + x / 6 - (x * x) / 72);
  return (m0 * ve) / F - (ve * tb) / dv;
}

/** Ignition time of a finite burn whose Δv centroid is on the node at tNode. */
export function burnStart(tNode: number, m0: number, F: number, ve: number, dv: number): number {
  return tNode - burnCentroid(m0, F, ve, dv);
}

/** Largest number of ghost impulses one finite burn becomes, and the longest segment, s. */
export const MAX_SEGMENTS = 12;
export const SEGMENT_MAX_S = 4;

/**
 * Expand a burn (node time, Δv components in the predictor's basis) into ≤ MAX_SEGMENTS impulses in `out` (reused
 * PredictBurn objects, out.length ≥ MAX_SEGMENTS). Returns the count; burnStart/finiteBurnTime give the window.
 */
export function finiteBurnSegments(b: PredictBurn, m0: number, F: number, ve: number, out: PredictBurn[], maxSeg = MAX_SEGMENTS): number {
  const dv = msqrt(b.prograde * b.prograde + b.normal * b.normal + b.radial * b.radial);
  if (!(dv > 0) || !(F > 0)) {
    const o = out[0];
    o.t = b.t; o.prograde = b.prograde; o.normal = b.normal; o.radial = b.radial;
    return 1;
  }
  const tb = finiteBurnTime(m0, F, ve, dv), t0 = b.t - burnCentroid(m0, F, ve, dv);
  let K = Math.ceil(tb / SEGMENT_MAX_S);
  if (K < 1) K = 1;
  if (K > maxSeg) K = maxSeg;
  if (K > out.length) K = out.length;
  const h = tb / K, mdot = F / ve, ux = b.prograde / dv, uy = b.normal / dv, uz = b.radial / dv;
  for (let k = 0; k < K; k++) {
    const mk = m0 - mdot * k * h, mk1 = k === K - 1 ? m0 * mexp(-dv / ve) : m0 - mdot * (k + 1) * h;
    const dvk = ve * mlog(mk / mk1);
    const o = out[k];
    o.t = t0 + k * h + burnCentroid(mk, F, ve, dvk);
    o.prograde = ux * dvk; o.normal = uy * dvk; o.radial = uz * dvk;
  }
  return K;
}

/** Make the reusable segment buffer for finiteBurnSegments. */
export function makeSegments(n = MAX_SEGMENTS): PredictBurn[] {
  const a: PredictBurn[] = [];
  for (let i = 0; i < n; i++) a.push({ t: 0, prograde: 0, normal: 0, radial: 0 });
  return a;
}

// ------------------------------------------------------------------------------------------------ bases

/** The predictor's burn basis at a primary-relative state: prograde p̂, normal n̂ = (r × v)^, radial p̂ × n̂. */
export function burnBasis(r: V3, v: V3, P: V3, N: V3, Rd: V3): boolean {
  const vl = msqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  let nx = r.y * v.z - r.z * v.y, ny = r.z * v.x - r.x * v.z, nz = r.x * v.y - r.y * v.x;
  const nl = msqrt(nx * nx + ny * ny + nz * nz);
  if (!(vl > 0) || !(nl > 0)) return false;
  P.x = v.x / vl; P.y = v.y / vl; P.z = v.z / vl;
  nx /= nl; ny /= nl; nz /= nl;
  N.x = nx; N.y = ny; N.z = nz;
  Rd.x = P.y * nz - P.z * ny; Rd.y = P.z * nx - P.x * nz; Rd.z = P.x * ny - P.y * nx;
  return true;
}

const BP = { x: 0, y: 0, z: 0 }, BN = { x: 0, y: 0, z: 0 }, BR = { x: 0, y: 0, z: 0 };
/** Inertial Δv → (prograde, normal, radial) at the primary-relative state (r, v). */
export function toBurnComponents(r: V3, v: V3, dv: V3, out: PredictBurn): PredictBurn {
  if (!burnBasis(r, v, BP, BN, BR)) { out.prograde = out.normal = out.radial = 0; return out; }
  out.prograde = dv.x * BP.x + dv.y * BP.y + dv.z * BP.z;
  out.normal = dv.x * BN.x + dv.y * BN.y + dv.z * BN.z;
  out.radial = dv.x * BR.x + dv.y * BR.y + dv.z * BR.z;
  return out;
}
/** (prograde, normal, radial) → inertial direction × magnitude at (r, v). */
export function fromBurnComponents(r: V3, v: V3, b: PredictBurn, out: V3): V3 {
  if (!burnBasis(r, v, BP, BN, BR)) { out.x = out.y = out.z = 0; return out; }
  out.x = b.prograde * BP.x + b.normal * BN.x + b.radial * BR.x;
  out.y = b.prograde * BP.y + b.normal * BN.y + b.radial * BR.y;
  out.z = b.prograde * BP.z + b.normal * BN.z + b.radial * BR.z;
  return out;
}

// ------------------------------------------------------------------------------------------------ CW intercept

const HX = new Float64Array(6), HB = new Float64Array(9);

/**
 * Closed-form two-impulse CW intercept from the navigation estimate: the ship Δv (inertial, m/s) at time t that brings
 * the tracked point's relative position to zero after T seconds (the arrival burn is −ρ̇(T)). False when the
 * transfer is singular (nT a multiple of π in-plane or cross-track) or there is no estimate.
 */
export function cwIntercept(nav: NavState, t: number, T: number, dv: V3, arrive?: V3): boolean {
  if (!nav.valid || !(T > 0)) return false;
  navHillAt(nav, t, HX, HB);
  const n = nav.n, th = n * T, s = msin(th), sh = msin(0.5 * th), omc = 2 * sh * sh, c = 1 - omc, inv = 1 / n;
  // ρ(T) = Φrr ρ0 + Φrv w = 0  with w the post-burn Hill rate; in-plane 2×2 and cross-track 1×1.
  const a = s * inv, b = 2 * omc * inv, cc = -2 * omc * inv, d = (4 * s - 3 * th) * inv;
  const det = a * d - b * cc;
  if (!(Math.abs(det) > 1e-9 * (Math.abs(a * d) + Math.abs(b * cc))) || !(Math.abs(s) > 1e-9)) return false;
  const x = HX[0], y = HX[1], z = HX[2];
  const rx = (4 - 3 * c) * x, ry = 6 * (s - th) * x + y, rz = c * z;
  const wx = (-d * rx + b * ry) / det, wy = (cc * rx - a * ry) / det, wz = (-rz * n) / s;
  // ship Δv (Hill) = ρ̇0 − w  (the relative rate changes opposite to the ship's Δv)
  const ex = HX[3] - wx, ey = HX[4] - wy, ez = HX[5] - wz;
  dv.x = HB[0] * ex + HB[3] * ey + HB[6] * ez;
  dv.y = HB[1] * ex + HB[4] * ey + HB[7] * ez;
  dv.z = HB[2] * ex + HB[5] * ey + HB[8] * ez;
  if (arrive) {
    // relative rate at arrival: Φvr ρ0 + Φvv w, rotated by the frame at t + T; the ship must add −(that)
    const vx = 3 * n * s * x + c * wx + 2 * s * wy, vy = -6 * n * omc * x - 2 * s * wx + (4 * c - 3) * wy, vz = -n * s * z + c * wz;
    const c2 = mcos(th), s2 = s;
    const X0 = c2 * HB[0] + s2 * HB[3], X1 = c2 * HB[1] + s2 * HB[4], X2 = c2 * HB[2] + s2 * HB[5];
    const Y0 = -s2 * HB[0] + c2 * HB[3], Y1 = -s2 * HB[1] + c2 * HB[4], Y2 = -s2 * HB[2] + c2 * HB[5];
    arrive.x = X0 * vx + Y0 * vy + HB[6] * vz;
    arrive.y = X1 * vx + Y1 * vy + HB[7] * vz;
    arrive.z = X2 * vx + Y2 * vy + HB[8] * vz;
  }
  return true;
}

// ------------------------------------------------------------------------------------------------ shooting on the ghost

export interface FiniteParams {
  /** Thrust (N), exhaust velocity (m/s) and mass at ignition (kg) of the engine that will fly it. */
  F: number;
  ve: number;
  m0: number;
}

const SOLVE_DV = 0.05;
const SOLVE_ITERS = 8;

/**
 * Newton shooting on the ghost: adjusts (prograde, normal, radial) of a burn at its node so that the ghost meets the
 * target craft at tArr. Each iteration runs 4 predictions (base + 3 finite-difference columns); every prediction
 * runs in budgeted slices (run(ms) like Predictor), so a frame never pays more than its slice.
 */
export class BurnSolver {
  private readonly pr = new Predictor();
  private readonly out: Prediction = createPrediction(8, 4);
  private readonly seg = makeSegments(MAX_SEGMENTS);
  private readonly burn: PredictBurn = { t: 0, prograde: 0, normal: 0, radial: 0 };
  private readonly trial: PredictBurn = { t: 0, prograde: 0, normal: 0, radial: 0 };
  private readonly opts = { duration: 0, maxPoints: 8, burns: [] as PredictBurn[], targetCraftId: null as string | null };
  private world: World | null = null;
  private craftId = '';
  private fin: FiniteParams | null = null;
  private tArr = 0;
  private phase = 0; // 0 base, 1..3 columns
  private running = false;
  private readonly res = new Float64Array(3);
  private readonly col = new Float64Array(3);
  private readonly J = new Float64Array(9);
  private iter = 0;
  /** Result: the refined burn, the miss at tArr (m) and the iterations used. */
  readonly result: PredictBurn = { t: 0, prograde: 0, normal: 0, radial: 0 };
  miss = Infinity;
  iterations = 0;
  done = true;

  private ax = 0; private ay = 0; private az = 0;

  /**
   * Aim: the ghost should be at target + aim (inertial axes, m) at tArr — e.g. a standoff on the approach axis.
   * finite: null plans an impulse; otherwise the burn is flown as finite segments with these engine numbers.
   */
  start(world: World, craftId: string, targetId: string, guess: PredictBurn, tArr: number, finite: FiniteParams | null, aim?: V3): void {
    this.ax = aim ? aim.x : 0; this.ay = aim ? aim.y : 0; this.az = aim ? aim.z : 0;
    this.world = world; this.craftId = craftId; this.fin = finite; this.tArr = tArr;
    this.opts.targetCraftId = targetId;
    this.burn.t = guess.t; this.burn.prograde = guess.prograde; this.burn.normal = guess.normal; this.burn.radial = guess.radial;
    this.phase = 0; this.iter = 0; this.running = false; this.done = false; this.miss = Infinity;
    this.result.t = guess.t; this.result.prograde = guess.prograde; this.result.normal = guess.normal; this.result.radial = guess.radial;
    if (!findCraft(world, craftId) || !findCraft(world, targetId) || !(tArr > world.t)) this.done = true;
  }

  private launch(): void {
    const b = this.trial, w = this.world!;
    b.t = this.burn.t; b.prograde = this.burn.prograde; b.normal = this.burn.normal; b.radial = this.burn.radial;
    if (this.phase === 1) b.prograde += SOLVE_DV; else if (this.phase === 2) b.normal += SOLVE_DV; else if (this.phase === 3) b.radial += SOLVE_DV;
    const bs = this.opts.burns;
    bs.length = 0;
    if (this.fin) {
      const k = finiteBurnSegments(b, this.fin.m0, this.fin.F, this.fin.ve, this.seg);
      for (let i = 0; i < k; i++) bs.push(this.seg[i]);
    } else bs.push(b);
    this.opts.duration = this.tArr - w.t;
    this.pr.start(w, this.craftId, this.opts, this.out);
    this.running = true;
  }

  /** Final separation vector ghost − target (frame-relative) of the finished prediction into out. */
  private missVec(out: Float64Array, o: number): void {
    const p = this.out, i = 4 * (p.count - 1);
    out[o] = p.points[i] - p.targetPoints[i] - this.ax;
    out[o + 1] = p.points[i + 1] - p.targetPoints[i + 1] - this.ay;
    out[o + 2] = p.points[i + 2] - p.targetPoints[i + 2] - this.az;
  }

  /** Continue for at most budgetMs. Returns true when done (converged, or out of iterations). */
  run(budgetMs = Infinity, now: () => number = perfNow): boolean {
    if (this.done) return true;
    const limited = budgetMs < Infinity, t0 = limited ? now() : 0;
    for (;;) {
      if (!this.running) this.launch();
      const left = limited ? budgetMs - (now() - t0) : Infinity;
      if (limited && left <= 0) return false;
      if (!this.pr.run(left, now)) return false;
      this.running = false;
      const p = this.out;
      if (p.count < 1 || p.targetCount < 1 || Math.abs(p.points[4 * (p.count - 1) + 3] - this.tArr) > 1e-6) { this.done = true; return true; }
      if (this.phase === 0) {
        this.missVec(this.res, 0);
        const m = msqrt(this.res[0] ** 2 + this.res[1] ** 2 + this.res[2] ** 2);
        if (m < this.miss) {
          this.miss = m;
          this.result.t = this.burn.t; this.result.prograde = this.burn.prograde; this.result.normal = this.burn.normal; this.result.radial = this.burn.radial;
        }
        this.iterations = this.iter;
        if (m < 0.5 || this.iter >= SOLVE_ITERS) { this.done = true; return true; }
        this.phase = 1;
      } else {
        const c = this.phase - 1, J = this.J;
        this.missVec(this.col, 0);
        J[c] = (this.col[0] - this.res[0]) / SOLVE_DV;
        J[3 + c] = (this.col[1] - this.res[1]) / SOLVE_DV;
        J[6 + c] = (this.col[2] - this.res[2]) / SOLVE_DV;
        if (this.phase < 3) { this.phase++; continue; }
        // Newton step: J δ = −res (3×3 by Cramer)
        const a = J[0], b = J[1], cc = J[2], d = J[3], e = J[4], f = J[5], g = J[6], h = J[7], k = J[8];
        const A = e * k - f * h, B = -(d * k - f * g), C = d * h - e * g;
        const det = a * A + b * B + cc * C;
        if (!(Math.abs(det) > 1e-30)) { this.done = true; return true; }
        const r0 = -this.res[0], r1 = -this.res[1], r2 = -this.res[2];
        const x = (r0 * A + r1 * (-(b * k - cc * h)) + r2 * (b * f - cc * e)) / det;
        const y = (r0 * B + r1 * (a * k - cc * g) + r2 * (-(a * f - cc * d))) / det;
        const z = (r0 * C + r1 * (-(a * h - b * g)) + r2 * (a * e - b * d)) / det;
        this.burn.prograde += x; this.burn.normal += y; this.burn.radial += z;
        this.iter++;
        this.phase = 0;
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------ encoder dials

/**
 * The four planner dials as integers (exact: no drift however many detents): Δv in centimetres per second along
 * prograde, normal and radial, and the time to the node in tenths of a second. Saved with the session.
 */
export interface PlanDials {
  pro: number;
  nor: number;
  rad: number;
  time: number;
}
export const makeDials = (): PlanDials => ({ pro: 0, nor: 0, rad: 0, time: 0 });
export const DIAL_PRO = 0, DIAL_NOR = 1, DIAL_RAD = 2, DIAL_TIME = 3;
/** Detent value by turning speed: slow, brisk (> 4 detents/s), fast (> 12 detents/s). Units: cm/s or 0.1 s. */
export const DIAL_STEPS_DV = [10, 100, 1000];
export const DIAL_STEPS_TIME = [10, 100, 600];
export const DIAL_DV_LIMIT = 1e6; // 10 km/s
export const DIAL_TIME_LIMIT = 864000; // one day

const clampDv = (v: number): number => (v < -DIAL_DV_LIMIT ? -DIAL_DV_LIMIT : v > DIAL_DV_LIMIT ? DIAL_DV_LIMIT : v);

/** One detent edge (dir = ±1) of dial `axis` turned at `rate` detents/s. */
export function dialStep(d: PlanDials, axis: number, dir: number, rate: number): void {
  const tier = rate > 12 ? 2 : rate > 4 ? 1 : 0, sgn = dir < 0 ? -1 : 1;
  if (axis === DIAL_TIME) {
    const v = d.time + sgn * DIAL_STEPS_TIME[tier];
    d.time = v < 0 ? 0 : v > DIAL_TIME_LIMIT ? DIAL_TIME_LIMIT : v;
    return;
  }
  const step = sgn * DIAL_STEPS_DV[tier];
  if (axis === DIAL_PRO) d.pro = clampDv(d.pro + step);
  else if (axis === DIAL_NOR) d.nor = clampDv(d.nor + step);
  else if (axis === DIAL_RAD) d.rad = clampDv(d.rad + step);
}

/** The dials as a burn at sim time now + time. */
export function dialsToBurn(d: PlanDials, now: number, out: PredictBurn): PredictBurn {
  out.t = now + d.time / 10;
  out.prograde = d.pro / 100; out.normal = d.nor / 100; out.radial = d.rad / 100;
  return out;
}
