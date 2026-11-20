// Prediction: the craft integrator run on a ghost. Same forces, same step rule, same ephemeris — so the path
// drawn is the path that will be flown (thrust is the pilot's business: planned burns are impulses on the
// ghost). Output goes into caller-owned typed arrays; nothing allocates while stepping.

import type { Ephemeris } from './ephemeris';
import { ephemerisOf } from './ephemeris';
import { chooseDt, loadParticle, Particle, stepCoast, stepForced, updatePrimary } from './dynamics';
import { bodyIndex, findCraft, type World } from './state';

export const EV_PERIAPSIS = 0;
export const EV_APOAPSIS = 1;
export const EV_CLOSEST = 2;
export const EV_ATMOSPHERE = 3;
export const EV_IMPACT = 4;
export const EV_BURN = 5;
export const PREDICT_EVENT_KINDS = ['periapsis', 'apoapsis', 'closestApproach', 'atmosphere', 'impact', 'burn'] as const;
export type PredictEventKind = (typeof PREDICT_EVENT_KINDS)[number];

/** A predicted path. Arrays belong to the caller and are overwritten by each prediction. */
export interface Prediction {
  /** Packed x, y, z, t per point: position relative to the frame body (inertial axes) at that point's time. */
  points: Float64Array;
  count: number;
  /** The target craft's path at the same times, same packing (count 0 without a target). */
  targetPoints: Float64Array;
  targetCount: number;
  /** Packed kind, t, x, y, z, value per event. value: altitude (apsides, atmosphere), separation (closest approach), Δv (burn), speed (impact). */
  events: Float64Array;
  eventCount: number;
  /** Index of the frame body in world.bodies. */
  frameBody: number;
  /** Start time and sim seconds covered so far. */
  t0: number;
  horizon: number;
  /** Ghost steps taken. */
  steps: number;
  done: boolean;
}

export function createPrediction(maxPoints = 512, maxEvents = 32): Prediction {
  return {
    points: new Float64Array(4 * maxPoints), count: 0, targetPoints: new Float64Array(4 * maxPoints), targetCount: 0,
    events: new Float64Array(6 * maxEvents), eventCount: 0, frameBody: 0, t0: 0, horizon: 0, steps: 0, done: true,
  };
}

/** Event `i` of a prediction as an object (allocates; for UI code, not for loops). */
export function predictionEvent(p: Prediction, i: number): { kind: PredictEventKind; t: number; r: { x: number; y: number; z: number }; value: number } {
  const e = p.events, o = 6 * i;
  return { kind: PREDICT_EVENT_KINDS[e[o]], t: e[o + 1], r: { x: e[o + 2], y: e[o + 3], z: e[o + 4] }, value: e[o + 5] };
}

/** A planned impulsive burn: components along prograde, orbit normal (r × v) and radial-out, relative to the ghost's primary at time t. */
export interface PredictBurn {
  t: number;
  prograde: number;
  normal: number;
  radial: number;
}

export interface PredictOptions {
  /** Sim seconds to look ahead. */
  duration: number;
  /** Points to keep (≤ capacity of the output; the path is thinned evenly when it would overflow). */
  maxPoints?: number;
  /** Body the points are relative to (default: the craft's primary). */
  frameBodyId?: string | null;
  burns?: readonly PredictBurn[];
  /** Craft whose path is predicted alongside, for closest approaches. */
  targetCraftId?: string | null;
  /**
   * Held thrust (SIMULATION.md W1-A 3): from the start until `until` (sim time) the ghost flies under this force (N,
   * inertial axes, held fixed) and burns mdot kg/s (stepForced at the powered step), then coasts. Absent: it coasts.
   */
  thrust?: { fx: number; fy: number; fz: number; mdot: number; until: number } | null;
}

const MAX_BURNS = 16;

/**
 * An incremental prediction: start() it, then run() it in slices of a STEP COUNT (SIMULATION.md W1-A 11: the caller
 * budgets steps against its own cost-per-step estimate; Safari's clock is 1 ms coarse) until it returns true.
 * Incremental (W1-A 3): extend() moves the far end on and run() continues from where the ghost is, and dropBefore()
 * discards the points behind the present. The ghost never takes the shortened last step to the horizon: that step is
 * taken on a copy and gives only the TIP (the last point, its events, `horizon`), which the next extend() replaces.
 * So an extended prediction is a prefix-continuation of one long run: the same steps, the same points, bit for bit.
 */
export class Predictor {
  private G = new Particle();
  private T = new Particle();
  private GT = new Particle();
  private TT = new Particle();
  private committed = 0;
  private evCommitted = 0;
  private thrustUntil = -Infinity;
  private tfx = 0; private tfy = 0; private tfz = 0; private tmd = 0;
  private readonly burns = new Float64Array(4 * MAX_BURNS);
  private F = new Float64Array(96);
  private F2 = new Float64Array(96);
  private world: World | null = null;
  private eph: Ephemeris | null = null;
  private out: Prediction = createPrediction(2, 1);
  private hasT = false;
  /** The path ended for good (impact, landed, the ephemeris ring full): extend() does nothing. */
  private stopped = false;
  private frame = 0;
  private t = 0;
  private tEnd = 0;
  private cov = 0;
  private n = 0;
  private nb = 0;
  private ib = 0;
  private maxPts = 0;
  private stride = 1;
  private since = 0;
  private gx = 0; private gy = 0; private gz = 0;
  private hx = 0; private hy = 0; private hz = 0;
  private ta = 0; private da = -1; private tb = 0; private db = -1;
  private bx = 0; private by = 0; private bz = 0;

  /** Begin predicting `craftId` from the world's present state. */
  start(world: World, craftId: string, opts: PredictOptions, out: Prediction): void {
    const eph = ephemerisOf(world);
    this.world = world; this.eph = eph; this.out = out;
    if (this.F.length < eph.n3) { this.F = new Float64Array(eph.n3); this.F2 = new Float64Array(eph.n3); }
    out.count = 0; out.targetCount = 0; out.eventCount = 0; out.t0 = world.t; out.horizon = 0; out.steps = 0; out.done = false;
    this.stopped = false;
    const c = findCraft(world, craftId);
    if (!c) { out.done = true; this.stopped = true; return; }
    const G = this.G, T = this.T;
    loadParticle(G, c);
    G.heat = 0; G.heatCap = 1e300;
    const tc = opts.targetCraftId ? findCraft(world, opts.targetCraftId) : null;
    this.hasT = tc !== null && tc !== c;
    if (tc && this.hasT) { loadParticle(T, tc); T.heat = 0; T.heatCap = 1e300; }
    const f = opts.frameBodyId ? bodyIndex(world, opts.frameBodyId) : -1;
    this.frame = out.frameBody = f >= 0 ? f : c.primary;
    this.maxPts = Math.max(4, Math.min(opts.maxPoints ?? 1e9, (out.points.length >> 2) - 1)); // one slot for the tip
    this.stride = 1; this.since = 0;
    this.t = world.t; this.tEnd = world.t + opts.duration; this.n = 0;
    this.cov = eph.ensure(world.t);
    this.da = this.db = -1;
    // Burns, sorted by time, those in the past dropped.
    this.nb = 0; this.ib = 0;
    const bs = opts.burns;
    if (bs) {
      for (let i = 0; i < bs.length && this.nb < MAX_BURNS; i++) {
        const b = bs[i];
        if (b.t < world.t || b.t > this.tEnd) continue;
        let k = this.nb++;
        while (k > 0 && this.burns[4 * (k - 1)] > b.t) {
          for (let j = 0; j < 4; j++) this.burns[4 * k + j] = this.burns[4 * (k - 1) + j];
          k--;
        }
        this.burns[4 * k] = b.t; this.burns[4 * k + 1] = b.prograde; this.burns[4 * k + 2] = b.normal; this.burns[4 * k + 3] = b.radial;
      }
    }
    const th = opts.thrust;
    if (th && th.until > world.t && c.landedOn === null) {
      this.thrustUntil = th.until; this.tfx = th.fx; this.tfy = th.fy; this.tfz = th.fz; this.tmd = th.mdot;
    } else { this.thrustUntil = -Infinity; this.tfx = this.tfy = this.tfz = this.tmd = 0; }
    G.fx = G.fy = G.fz = G.mdot = 0;
    this.committed = 0; this.evCommitted = 0;
    this.place(world.t);
    this.emit(world.t, true);
    out.count = this.committed;
    if (c.landedOn !== null) { out.done = true; this.stopped = true; }
  }

  /** The sim time the prediction runs to. */
  end(): number {
    return this.tEnd;
  }

  /** Move the far end on to `tEnd` (later than now): run() then continues the same ghost. False if nothing to do. */
  extend(tEnd: number): boolean {
    const o = this.out;
    if (!this.world || !(tEnd > this.tEnd) || this.stopped) return false;
    this.tEnd = tEnd;
    o.count = this.committed;
    o.eventCount = this.evCommitted;
    o.targetCount = this.hasT ? o.count : 0;
    o.done = false;
    return true;
  }

  /** Drop the points (and events) before time t, keeping the last point at or before it so the path starts there. */
  dropBefore(t: number): void {
    const o = this.out, p = o.points, q = o.targetPoints;
    let i = 0;
    while (i + 1 < this.committed && p[4 * (i + 1) + 3] <= t) i++;
    if (i > 0) {
      const n = o.count; // committed + the tip
      p.copyWithin(0, 4 * i, 4 * n);
      if (this.hasT) q.copyWithin(0, 4 * i, 4 * n);
      this.committed -= i;
      o.count = n - i;
      o.targetCount = this.hasT ? o.count : 0;
    }
    const e = o.events;
    let k = 0;
    while (k < this.evCommitted && e[6 * k + 1] < t) k++;
    if (k > 0) {
      e.copyWithin(0, 6 * k, 6 * o.eventCount);
      this.evCommitted -= k;
      o.eventCount -= k;
    }
  }

  /** Frame-relative positions of the ghost (and target) at time t into gx.. / hx.. */
  private place(t: number): void {
    const F = this.F, G = this.G, T = this.T;
    this.eph!.relPositions(t, this.frame, F);
    this.gx = G.x + F[3 * G.p]; this.gy = G.y + F[3 * G.p + 1]; this.gz = G.z + F[3 * G.p + 2];
    if (this.hasT) { this.hx = T.x + F[3 * T.p]; this.hy = T.y + F[3 * T.p + 1]; this.hz = T.z + F[3 * T.p + 2]; }
  }

  private emit(t: number, force: boolean): void {
    const o = this.out;
    if (!force && ++this.since < this.stride) return;
    this.since = 0;
    const p = o.points, q = o.targetPoints;
    if (this.committed >= this.maxPts) {
      let k = 0;
      for (let i = 0; i < this.committed; i += 2, k++) {
        const a = 4 * i, b = 4 * k;
        p[b] = p[a]; p[b + 1] = p[a + 1]; p[b + 2] = p[a + 2]; p[b + 3] = p[a + 3];
        q[b] = q[a]; q[b + 1] = q[a + 1]; q[b + 2] = q[a + 2]; q[b + 3] = q[a + 3];
      }
      this.committed = k;
      this.stride *= 2;
    }
    this.point(this.committed++, t);
  }

  /** Write the current ghost (and target) position at point slot i. */
  private point(i: number, t: number): void {
    const o = this.out, p = o.points, q = o.targetPoints, b = 4 * i;
    p[b] = this.gx; p[b + 1] = this.gy; p[b + 2] = this.gz; p[b + 3] = t;
    if (this.hasT) { q[b] = this.hx; q[b + 1] = this.hy; q[b + 2] = this.hz; q[b + 3] = t; }
  }

  /** Record an event at frame-relative position (x, y, z). */
  private event(kind: number, t: number, x: number, y: number, z: number, value: number): void {
    const o = this.out, e = o.events;
    if (6 * (o.eventCount + 1) > e.length) return;
    const b = 6 * o.eventCount++;
    e[b] = kind; e[b + 1] = t; e[b + 2] = x; e[b + 3] = y; e[b + 4] = z; e[b + 5] = value;
  }

  /** Record an event at a position relative to body `p`. */
  private eventAt(kind: number, t: number, p: number, x: number, y: number, z: number, value: number): void {
    const F = this.F2;
    this.eph!.relPositions(t, this.frame, F);
    this.event(kind, t, x + F[3 * p], y + F[3 * p + 1], z + F[3 * p + 2], value);
  }

  private applyBurn(t: number): void {
    const G = this.G, o = 4 * this.ib++;
    const pro = this.burns[o + 1], nor = this.burns[o + 2], rad = this.burns[o + 3];
    const v = Math.sqrt(G.vx * G.vx + G.vy * G.vy + G.vz * G.vz) || 1;
    const px = G.vx / v, py = G.vy / v, pz = G.vz / v;
    let nx = G.y * G.vz - G.z * G.vy, ny = G.z * G.vx - G.x * G.vz, nz = G.x * G.vy - G.y * G.vx;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const rx = py * nz - pz * ny, ry = pz * nx - px * nz, rz = px * ny - py * nx;
    G.vx += pro * px + nor * nx + rad * rx;
    G.vy += pro * py + nor * ny + rad * ry;
    G.vz += pro * pz + nor * nz + rad * rz;
    this.eventAt(EV_BURN, t, G.p, G.x, G.y, G.z, Math.sqrt(pro * pro + nor * nor + rad * rad));
  }

  /**
   * Continue for at most `maxSteps` ghost steps. Returns true when the prediction reaches its end (the tip written).
   * (A function as the first argument is the old millisecond form, kept for tools: run(ms, now).)
   */
  run(maxSteps = Infinity, now?: () => number): boolean {
    const o = this.out;
    if (o.done || !this.world || !this.eph) return true;
    const clock = now !== undefined && maxSteps < Infinity;
    const start = clock ? now!() : 0;
    const world = this.world, eph = this.eph, bodies = world.bodies, G = this.G, T = this.T, hasT = this.hasT;
    let t = this.t, n = this.n, taken = 0;
    for (;;) {
      while (this.ib < this.nb && this.burns[4 * this.ib] <= t) this.applyBurn(t);
      if ((n & 15) === 0) {
        updatePrimary(world, eph, null, G, t);
        if (hasT) updatePrimary(world, eph, null, T, t);
      }
      const b = bodies[G.p];
      const thrusting = t < this.thrustUntil && G.prop > 0;
      let dt = chooseDt(G, b, thrusting, false);
      if (hasT) { const d2 = chooseDt(T, bodies[T.p], false, false); if (d2 < dt) dt = d2; }
      if (this.ib < this.nb && t + dt > this.burns[4 * this.ib]) dt = this.burns[4 * this.ib] - t;
      if (thrusting) {
        if (t + dt > this.thrustUntil) dt = this.thrustUntil - t;
        G.fx = this.tfx; G.fy = this.tfy; G.fz = this.tfz; G.mdot = this.tmd;
      } else if (G.mdot !== 0) { G.fx = G.fy = G.fz = G.mdot = 0; }
      if (t + dt > this.cov) {
        const want = t + dt + 64 * eph.h;
        this.cov = eph.ensure(want < this.tEnd + dt ? want : this.tEnd + dt);
        if (this.cov < t + dt && this.cov < this.tEnd) {
          // The ephemeris ring is full: the prediction ends where the cache does.
          this.tEnd = this.cov; this.stopped = true;
          if (this.cov <= t) { this.finish(t, t); return true; }
        }
      }
      if (t + dt >= this.tEnd) {
        // the last, shortened step: on a copy (the tip); the ghost stays on its own step grid
        this.tip(t, this.tEnd - t, b, thrusting);
        this.t = t; this.n = n;
        o.steps = n;
        return true;
      }
      const x0 = G.x, y0 = G.y, z0 = G.z, vx0 = G.vx, vy0 = G.vy, vz0 = G.vz;
      if (G.inAtm || thrusting) stepForced(G, b, eph, t, dt); else stepCoast(G, eph, t, dt);
      if (thrusting) G.prop -= this.tmd * dt;
      if (hasT) { if (T.inAtm) stepForced(T, bodies[T.p], eph, t, dt); else stepCoast(T, eph, t, dt); }
      const tn = t + dt;
      this.place(tn);
      const r1 = Math.sqrt(G.x * G.x + G.y * G.y + G.z * G.z);
      this.stepEvents(G, b, t, dt, x0, y0, z0, vx0, vy0, vz0);
      if (r1 < b.radius + G.contactH) {
        this.event(EV_IMPACT, tn, this.gx, this.gy, this.gz, Math.sqrt(G.vx * G.vx + G.vy * G.vy + G.vz * G.vz));
        this.emit(tn, true);
        this.evCommitted = o.eventCount;
        this.stopped = true;
        t = tn; n++;
        this.t = t; this.n = n;
        this.finish(t, -1);
        return true;
      }
      if (hasT) {
        const sx = this.gx - this.hx, sy = this.gy - this.hy, sz = this.gz - this.hz;
        const dc = sx * sx + sy * sy + sz * sz;
        if (this.da >= 0 && this.db < this.da && this.db <= dc) {
          // Minimum of the squared separation bracketed by three samples: vertex of the parabola through them.
          const ta = this.ta, tb = this.tb, da = this.da, db = this.db;
          const p = (tb - ta) * (db - dc), q = (tb - tn) * (db - da);
          const den = p - q;
          let tv = tb, dv = db;
          if (den !== 0) {
            tv = tb - (0.5 * ((tb - ta) * p - (tb - tn) * q)) / den;
            dv = (da * (tv - tb) * (tv - tn)) / ((ta - tb) * (ta - tn)) + (db * (tv - ta) * (tv - tn)) / ((tb - ta) * (tb - tn)) + (dc * (tv - ta) * (tv - tb)) / ((tn - ta) * (tn - tb));
          }
          this.event(EV_CLOSEST, tv, this.bx, this.by, this.bz, Math.sqrt(dv > 0 ? dv : 0));
        }
        this.ta = this.tb; this.da = this.db;
        this.tb = tn; this.db = dc;
        this.bx = this.gx; this.by = this.gy; this.bz = this.gz;
      }
      this.emit(tn, (this.ib < this.nb && this.burns[4 * this.ib] <= tn) || (thrusting && tn >= this.thrustUntil));
      this.evCommitted = o.eventCount;
      t = tn; n++; taken++;
      if (taken >= maxSteps && !clock) break;
      if (clock && (taken & 7) === 0 && now!() - start > maxSteps) break;
    }
    this.t = t; this.n = n;
    o.count = this.committed;
    o.targetCount = hasT ? o.count : 0;
    o.horizon = t - o.t0; o.steps = n;
    return false;
  }

  /** Apsis and atmosphere-entry events inside the step just taken from (x0…, v0…) at t over dt (G is at its end). */
  private stepEvents(G: Particle, b: World['bodies'][number], t: number, dt: number, x0: number, y0: number, z0: number, vx0: number, vy0: number, vz0: number): void {
    const r0 = Math.sqrt(x0 * x0 + y0 * y0 + z0 * z0), rv0 = x0 * vx0 + y0 * vy0 + z0 * vz0;
    const r1 = Math.sqrt(G.x * G.x + G.y * G.y + G.z * G.z), rv1 = G.x * G.vx + G.y * G.vy + G.z * G.vz;
    if ((rv0 < 0 && rv1 >= 0) || (rv0 > 0 && rv1 <= 0)) {
      // Apsis inside the step: root of r·v by linear interpolation, position by the cubic through both ends.
      const f = rv0 / (rv0 - rv1), u = 1 - f;
      const h00 = (1 + 2 * f) * u * u, h10 = f * u * u * dt, h01 = f * f * (3 - 2 * f), h11 = -f * f * u * dt;
      const ex = h00 * x0 + h10 * vx0 + h01 * G.x + h11 * G.vx;
      const ey = h00 * y0 + h10 * vy0 + h01 * G.y + h11 * G.vy;
      const ez = h00 * z0 + h10 * vz0 + h01 * G.z + h11 * G.vz;
      this.eventAt(rv0 < 0 ? EV_PERIAPSIS : EV_APOAPSIS, t + f * dt, G.p, ex, ey, ez, Math.sqrt(ex * ex + ey * ey + ez * ez) - b.radius);
    }
    const atm = b.atmosphere;
    if (atm !== null) {
      const top = b.radius + atm.height;
      if (r0 >= top && r1 < top) {
        const f = (r0 - top) / (r0 - r1);
        this.eventAt(EV_ATMOSPHERE, t + f * dt, G.p, x0 + f * (G.x - x0), y0 + f * (G.y - y0), z0 + f * (G.z - z0), atm.height);
      }
    }
  }

  /** The shortened last step from t over dt, on copies of the ghost (and target): the tip point and its events. */
  private tip(t: number, dt: number, b: World['bodies'][number], thrusting: boolean): void {
    const G = this.G, T = this.T, GT = this.GT, TT = this.TT, eph = this.eph!, hasT = this.hasT;
    copyParticle(GT, G);
    if (hasT) copyParticle(TT, T);
    if (dt > 0) {
      if (GT.inAtm || thrusting) stepForced(GT, b, eph, t, dt); else stepCoast(GT, eph, t, dt);
      if (hasT) { if (TT.inAtm) stepForced(TT, this.world!.bodies[TT.p], eph, t, dt); else stepCoast(TT, eph, t, dt); }
    }
    // place() and the event helpers read G/T: point them at the copies for the tip
    this.swapGhosts();
    this.place(t + dt);
    if (dt > 0) this.stepEvents(this.G, b, t, dt, G.x, G.y, G.z, G.vx, G.vy, G.vz);
    this.swapGhosts();
    this.finish(t + dt, t + dt);
  }

  private swapGhosts(): void {
    const g = this.G, h = this.T;
    this.G = this.GT; this.GT = g;
    this.T = this.TT; this.TT = h;
  }

  /** Close the output: committed points plus (tipT ≥ 0) the tip at slot `committed`; horizon to `end`. */
  private finish(end: number, tipT: number): void {
    const o = this.out;
    if (tipT >= 0) this.point(this.committed, tipT);
    o.count = this.committed + (tipT >= 0 ? 1 : 0);
    o.targetCount = this.hasT ? o.count : 0;
    o.horizon = end - o.t0;
    o.done = true;
  }
}

function copyParticle(a: Particle, b: Particle): void {
  a.p = b.p; a.x = b.x; a.y = b.y; a.z = b.z; a.vx = b.vx; a.vy = b.vy; a.vz = b.vz; a.m = b.m; a.prop = b.prop; a.heat = b.heat;
  a.fx = b.fx; a.fy = b.fy; a.fz = b.fz; a.mdot = b.mdot; a.cdA = b.cdA; a.heatArea = b.heatArea; a.heatCap = b.heatCap; a.heatDiss = b.heatDiss;
  a.contactH = b.contactH; a.reachMax = b.reachMax; a.inAtm = b.inAtm; a.drag = b.drag; a.load = b.load;
}

const SHARED = new Predictor();

/** Predict in one call (see Predictor for the incremental form). Returns `out`. */
export function predict(world: World, craftId: string, opts: PredictOptions, out: Prediction): Prediction {
  SHARED.start(world, craftId, opts, out);
  SHARED.run();
  return out;
}
