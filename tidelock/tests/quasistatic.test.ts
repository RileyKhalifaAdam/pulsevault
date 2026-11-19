// W1-C quasi-static loose bodies (src/world/quasistatic.ts): drift in closed form, rest in the friction cone, the
// drift/rest scheduler, contact entry with moving walls, continuity, save → load, and a sleep-warp sample.
import { describe, expect, it } from 'vitest';
import type { Quat, V3 } from '../src/core/types';
import { createBodyMotion, type BodyMotion } from '../src/world/body';
import { feltAt } from '../src/world/crew';
import {
  afterContact, anchorDrift, bodyEvent, createQsState, crewQsHy, DRIFT_SLOP, dragK, dragStep, driftEval, driftToShip, loadQsState, makeQsWorld,
  MODE_CONTACT, MODE_DRIFT, MODE_REST, NEVER, nextBodyEvent, Q, qsStats, restHoldsJump, restMargin, rotSteps, saveQsState, scheduleDrift,
  serviceBodies, tryRest, WHY_CONTACT, type QsBody, type QsWorld,
} from '../src/world/quasistatic';

const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const ID: Quat = { x: 0, y: 0, z: 0, w: 1 };
const rotY = (a: number): Quat => ({ x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) });

// A 3 × 2.4 × 6 m room (interior x ±1.5, y 0..2.4, z ±3; forward is −Z) walled by 0.2 m boxes.
const ROOM = Float64Array.from([
  -1.7, -0.2, -3.2, -1.5, 2.6, 3.2, 1.5, -0.2, -3.2, 1.7, 2.6, 3.2, // port, starboard
  -1.7, -0.2, -3.2, 1.7, 0, 3.2, -1.7, 2.4, -3.2, 1.7, 2.6, 3.2, // deck, overhead
  -1.7, -0.2, -3.2, 1.7, 2.6, -3, -1.7, -0.2, 3, 1.7, 2.6, 3.2, // forward, aft bulkheads
]);
function world(n: number, r = 0.05, k = 0, mu = 0.5): QsWorld {
  return { boxes: ROOM, nBoxes: 6, r: new Float64Array(n).fill(r), k: new Float64Array(n).fill(k), mu: new Float64Array(n).fill(mu) };
}
function gapStatic(p: V3, r: number, boxes = ROOM): number {
  let g = Infinity;
  for (let o = 0; o < boxes.length; o += 6) {
    const dx = Math.max(boxes[o] - p.x, 0, p.x - boxes[o + 3]), dy = Math.max(boxes[o + 1] - p.y, 0, p.y - boxes[o + 4]), dz = Math.max(boxes[o + 2] - p.z, 0, p.z - boxes[o + 5]);
    g = Math.min(g, Math.hypot(dx, dy, dz) - r);
  }
  return g;
}
const body = (p: V3, v: V3): QsBody => ({ p: { ...p }, v: { ...v }, qs: createQsState() });
function motion(a: V3 = v3(), w: V3 = v3(), n2 = 0): BodyMotion {
  const m = createBodyMotion();
  m.a.x = a.x; m.a.y = a.y; m.a.z = a.z; m.w.x = w.x; m.w.y = w.y; m.w.z = w.z; m.n2 = n2;
  return m;
}

describe('drift in closed form', () => {
  it('matches a fine RK4 of quadratic cabin-air drag (pillow, C_dA 0.19 m²)', () => {
    const k = dragK(0.19, 0.45);
    expect(1 / k).toBeCloseTo(3.95, 2); // e-folds every ≈ 4 m of path
    const b = body(v3(0, 1, 0), v3(0.8, 0.3, -0.5)), m = motion();
    anchorDrift(b, 0, m, ID);
    const p = v3(), v = v3();
    driftToShip(b.qs, 360, k, ID, m.w, p, v);
    let x = [0, 1, 0, 0.8, 0.3, -0.5];
    const f = (s: number[]): number[] => { const sp = Math.hypot(s[3], s[4], s[5]); return [s[3], s[4], s[5], -k * sp * s[3], -k * sp * s[4], -k * sp * s[5]]; };
    const N = 30000, h = 3 / N;
    for (let i = 0; i < N; i++) {
      const k1 = f(x), k2 = f(x.map((y, j) => y + 0.5 * h * k1[j])), k3 = f(x.map((y, j) => y + 0.5 * h * k2[j])), k4 = f(x.map((y, j) => y + h * k3[j]));
      x = x.map((y, j) => y + (h / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
    }
    expect(p.x).toBeCloseTo(x[0], 10); expect(p.y).toBeCloseTo(x[1], 10); expect(p.z).toBeCloseTo(x[2], 10);
    expect(v.x).toBeCloseTo(x[3], 10); expect(v.z).toBeCloseTo(x[5], 10);
  });

  it('a floating body conserves inertial momentum through a ship turn; the ship-frame path is the Coriolis one', () => {
    const W = v3(0, 0.1, 0), m = motion(v3(), W);
    const b = body(v3(0.5, 1, 0.3), v3(0.1, 0.05, -0.2));
    anchorDrift(b, 0, m, ID);
    const v0 = { ...b.qs.v0 }, X = v3(), V = v3(), p = v3(), v = v3();
    let s = [0.5, 1, 0.3, 0.1, 0.05, -0.2];
    const F = v3();
    const f = (y: number[]): number[] => { feltAt(m, y[0], y[1], y[2], y[3], y[4], y[5], F); return [y[3], y[4], y[5], F.x, F.y, F.z]; };
    const sub = 50, h = Q / sub;
    for (let t = 1; t <= 600; t++) {
      for (let i = 0; i < sub; i++) {
        const k1 = f(s), k2 = f(s.map((y, j) => y + 0.5 * h * k1[j])), k3 = f(s.map((y, j) => y + 0.5 * h * k2[j])), k4 = f(s.map((y, j) => y + h * k3[j]));
        s = s.map((y, j) => y + (h / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
      }
      if (t % 100 === 0) {
        driftEval(b.qs, t, 0, X, V);
        expect(V).toEqual(v0); // inertial velocity: unchanged, bit for bit
        driftToShip(b.qs, t, 0, rotY(0.1 * t * Q), W, p, v);
        expect(p.x).toBeCloseTo(s[0], 9); expect(p.y).toBeCloseTo(s[1], 9); expect(p.z).toBeCloseTo(s[2], 9);
        expect(v.x).toBeCloseTo(s[3], 9); expect(v.z).toBeCloseTo(s[5], 9);
      }
    }
  });
});

/** Run the scheduler like the warp loop: quanta of ≤ cap ticks cut at body events; sample the closed form every tick. */
function runToContact(b: QsBody, w: QsWorld, m: BodyMotion, qAt: (t: number) => Quat, maxTicks: number) {
  const bodies = [b];
  let tick = 0, events = 0, minGap = Infinity;
  const p = v3(), v = v3();
  afterContact(b, 0, bodies, w, 0, m, qAt(0), false, 0, 0, 0);
  while (b.qs.mode === MODE_DRIFT && tick < maxTicks) {
    const e = nextBodyEvent(bodies, tick, 2048);
    for (let t = tick + 1; t <= tick + e; t++) { driftToShip(b.qs, t, w.k[0], qAt(t), m.w, p, v); minGap = Math.min(minGap, gapStatic(p, w.r[0])); }
    tick += e;
    serviceBodies(bodies, w, tick, m, qAt(tick));
    events++;
  }
  return { tick, events, minGap, gap: gapStatic(b.p, w.r[0]) };
}

describe('drift → contact', () => {
  it('stops at contact with a wall that moves into the body while the ship turns', () => {
    const W = v3(0, 0.3, 0), m = motion(v3(), W), w = world(1);
    const qAt = (t: number): Quat => rotY(0.3 * t * Q);
    // at rest in inertial space: in the ship frame it circles at 2.5 m and the side wall sweeps into it
    const p0 = v3(0, 1.2, 2.5), b = body(p0, v3(-(W.y * p0.z), 0, W.y * p0.x));
    const r = runToContact(b, w, m, qAt, 120 * 60);
    expect(b.qs.mode).toBe(MODE_CONTACT);
    expect(r.minGap).toBeGreaterThanOrEqual(-DRIFT_SLOP - 1e-12);
    expect(r.gap).toBeLessThan(0.02);
    // the true first touch (dense scan of the same closed form, no re-anchoring) is not before the hand-over
    const c = body(p0, v3(-(W.y * p0.z), 0, W.y * p0.x));
    anchorDrift(c, 0, m, ID);
    const p = v3(), v = v3();
    let touch = -1;
    for (let t = 1; t < 120 * 60 && touch < 0; t++) { driftToShip(c.qs, t, 0, qAt(t), W, p, v); if (gapStatic(p, 0.05) < 0) touch = t; }
    expect(touch).toBeGreaterThan(r.tick);
    expect(touch - r.tick).toBeLessThan(30);
    console.log(`[qs] rotating wall: ${r.events} drift events, hand-over at tick ${r.tick} (gap ${(r.gap * 1000).toFixed(1)} mm), true touch tick ${touch}`);
  });

  it('aerobrake (20 m/s² drag ledger): a free mug reaches the forward bulkhead and hands over just before it', () => {
    const m = motion(v3(0, 0, 20)), w = world(1, 0.05, dragK(0.006, 0.35));
    const b = body(v3(0, 1.2, 0), v3());
    const r = runToContact(b, w, m, () => ID, 1200);
    expect(b.qs.mode).toBe(MODE_CONTACT);
    expect(b.p.z).toBeLessThan(-2.9); // the forward (−Z) bulkhead is at −3
    expect(r.minGap).toBeGreaterThanOrEqual(-DRIFT_SLOP);
    expect(r.tick * Q).toBeGreaterThan(0.5); expect(r.tick * Q).toBeLessThan(Math.sqrt((2 * 2.95) / 20) + 1e-9);
  });

  it('a body sliding along a wall it does not press is not pinned to Q', () => {
    const m = motion(), w = world(1, 0.05, dragK(0.006, 0.35));
    const b = body(v3(0, 0.05, 0), v3(0.3, 0, 0.2)); // on the deck, zero g
    afterContact(b, 0, [b], w, 0, m, ID, true, 0, 1, 0);
    expect(b.qs.mode).toBe(MODE_DRIFT);
    expect(b.qs.tickEnd).toBeGreaterThan(120); // limited by the side walls ~1.5 m away, not by the deck
  });
});

describe('rest', () => {
  it('rests inside the cone; slow (tidal-scale) forces do not wake it or limit warp; a real push does', () => {
    const w = world(1, 0.05, 0, 0.5);
    const landed = motion(v3(0, 9.81, 0));
    const b = body(v3(0, 0.05, 0), v3(0, 0, 0));
    expect(tryRest(b, 0.5, 0, landed, 0, 1, 0)).toBe(true);
    expect(nextBodyEvent([b], 0, 2048)).toBe(2048);
    // free fall with a 1e-5 m/s² tangential residue (gravity-gradient scale): stays at rest, never re-scheduled
    const tidal = motion(v3(1e-5, 0, 0));
    expect(serviceBodies([b], w, 1e6, tidal, ID)).toBe(0);
    expect(b.qs.mode).toBe(MODE_REST);
    expect(nextBodyEvent([b], 1e6, 2048)).toBe(2048);
    // with a felt-rate bound the re-check is scheduled, far away
    tidal.fDot = 1e-8;
    serviceBodies([b], w, 2e6, tidal, ID);
    expect(b.qs.mode).toBe(MODE_REST);
    expect((b.qs.tickEnd - 2e6) * Q).toBeGreaterThan(4000);
    // a 0.05 m/s² push along the deck with nothing pressing it down: wakes
    expect(serviceBodies([b], w, 2e6 + 1, motion(v3(0.05, 0, 0)), ID)).toBe(1);
    expect(b.qs.mode).toBe(MODE_CONTACT);
    expect(restMargin(v3(0.3, -1, 0), v3(0, 1, 0), 0.5)).toBeCloseTo(-0.2, 15);
  });

  it('rest → drift is continuous in position, velocity and acceleration', () => {
    const W = v3(0.001, 0.002, 0), w = world(1);
    const b = body(v3(0.4, 0.05, -1), v3());
    expect(tryRest(b, 0.5, 0, motion(v3(), W), 0, 1, 0)).toBe(true);
    // the ship starts to accelerate toward −Y: felt pulls the body off the deck → wakes → leaves as DRIFT
    const m = motion(v3(0, -0.5, 0), W), q = rotY(0.7);
    serviceBodies([b], w, 10, m, q);
    expect(b.qs.mode).toBe(MODE_CONTACT);
    const p0 = { ...b.p }, vv0 = { ...b.v };
    expect(afterContact(b, 0, [b], w, 10, m, q, true, 0, 1, 0)).toBe(MODE_DRIFT);
    const p = v3(), v = v3();
    driftToShip(b.qs, 10, 0, q, W, p, v);
    for (const c of ['x', 'y', 'z'] as const) { expect(Math.abs(p[c] - p0[c])).toBeLessThan(1e-15); expect(Math.abs(v[c] - vv0[c])).toBeLessThan(1e-16); }
    // first tick: the ship-frame acceleration is the felt one (+0.5 along Y, plus the tiny turning terms)
    driftToShip(b.qs, 11, 0, q, W, p, v);
    expect(v.y / Q).toBeCloseTo(feltAt(m, p0.x, p0.y, p0.z, 0, 0, 0, v3()).y, 3);
  });
});

describe('save → load', () => {
  it('drift and rest continue bit-identically (same events, same states)', () => {
    const W = v3(0, 0.002, 0), m = motion(v3(), W, 1.2e-6), qAt = (t: number): Quat => rotY(0.002 * t * Q);
    const make = (): QsBody[] => [body(v3(0, 1.2, 0), v3(0.4, 0.1, -0.3)), body(v3(1, 0.05, 2), v3()), body(v3(-1, 2, -2), v3(-0.05, 0.02, 0.6))];
    const w = world(3, 0.05, dragK(0.006, 0.35));
    const A = make();
    afterContact(A[0], 0, A, w, 0, m, qAt(0), false, 0, 0, 0);
    tryRest(A[1], 0.5, 0, m, 0, 1, 0);
    afterContact(A[2], 0, A, w, 0, m, qAt(0), false, 0, 0, 0);
    let tick = 0;
    const run = (B: QsBody[], t0: number, n: number, log: number[]): number => {
      let t = t0;
      for (let k = 0; k < n && nextBodyEvent(B, t, 2048) >= 1 && bodyEvent.why !== WHY_CONTACT; k++) {
        t += nextBodyEvent(B, t, 2048);
        serviceBodies(B, w, t, m, qAt(t));
        log.push(t);
      }
      return t;
    };
    tick = run(A, tick, 5, []);
    const saved = JSON.stringify(A.map((b) => ({ p: b.p, v: b.v, qs: saveQsState(b.qs) })));
    const B: QsBody[] = (JSON.parse(saved) as { p: V3; v: V3; qs: unknown }[]).map((o) => ({ p: o.p, v: o.v, qs: loadQsState(o.qs) }));
    const la: number[] = [], lb: number[] = [];
    const ta = run(A, tick, 40, la), tb = run(B, tick, 40, lb);
    expect(ta).toBe(tb);
    expect(la).toEqual(lb);
    expect(A[1].qs.mode).toBe(MODE_REST);
    for (let i = 0; i < 3; i++) for (const k of ['p', 'v'] as const) for (const c of ['x', 'y', 'z'] as const) expect(Object.is(A[i][k][c], B[i][k][c])).toBe(true);
    expect(JSON.stringify(A.map((b) => b.qs))).toBe(JSON.stringify(B.map((b) => b.qs)));
    // an old save without the field: CONTACT (re-derived within a tick)
    expect(loadQsState(undefined).mode).toBe(MODE_CONTACT);
  });
});

// ------------------------------------------------------------------------------------------------ sleep-warp sample

/** A minimal contact step at Q for a sphere in ROOM (test stand-in for props.ts' solver): zero g, drag, bounces. */
const PLANES = [[1, 0, 0, -1.5], [-1, 0, 0, -1.5], [0, 1, 0, 0], [0, -1, 0, -2.4], [0, 0, 1, -3], [0, 0, -1, -3]];
function contactTick(b: QsBody, k: number, e: number, mu: number, r: number, N: V3): boolean {
  const p = b.p, v = b.v;
  dragStep(v, k, Q);
  p.x += v.x * Q; p.y += v.y * Q; p.z += v.z * Q;
  let touching = false;
  for (const [nx, ny, nz, c] of PLANES) {
    const d = nx * p.x + ny * p.y + nz * p.z - c - r;
    if (d < 1e-4) { touching = true; N.x = nx; N.y = ny; N.z = nz; }
    if (d >= 0) continue;
    p.x -= d * nx; p.y -= d * ny; p.z -= d * nz;
    const vn = v.x * nx + v.y * ny + v.z * nz;
    if (vn >= 0) continue;
    const dvn = -(1 + (-vn > 0.25 ? e : 0)) * vn;
    v.x += dvn * nx; v.y += dvn * ny; v.z += dvn * nz;
    const un = v.x * nx + v.y * ny + v.z * nz, tx = v.x - un * nx, ty = v.y - un * ny, tz = v.z - un * nz, tl = Math.hypot(tx, ty, tz);
    const s = tl > 0 ? Math.max(0, tl - mu * dvn) / tl : 0;
    v.x = un * nx + tx * s; v.y = un * ny + ty * s; v.z = un * nz + tz * s;
  }
  return touching;
}

describe('sleep warp with a thrown mug', () => {
  it('reaches ≥ 0.9e4 within 0.5 s of real time (60 fps, 3 ms budget, A16 cost estimates)', () => {
    // cost model (A16 est.): a Q tick with one body in contact (craft + spine + props island) 40 µs, a quantum 20 µs
    const C_CONTACT = 40, C_QUANTUM = 20, BUDGET = 3000, WANT = 20000; // 1e4 × 1/60 s = 20000 ticks per frame
    const m = motion(v3(), v3(), (2 * Math.PI / 5670) ** 2), w = world(1, 0.05, dragK(0.006, 0.35), 0.5);
    const mug = body(v3(0, 1.2, 0), v3(0.8, 0.3, -0.9));
    const bodies = [mug], N = v3();
    let tick = 0, contactTicks = 0, quanta = 0, firstFull = -1, restAt = -1;
    afterContact(mug, 0, bodies, w, 0, m, ID, false, 0, 0, 0); // let go of it just before lying down
    const rates: number[] = [];
    for (let frame = 0; frame < 120; frame++) {
      let used = 0, done = 0;
      while (done < WANT) {
        const e = Math.min(nextBodyEvent(bodies, tick, 2048), WANT - done);
        if (bodyEvent.why === WHY_CONTACT) {
          if (used + C_CONTACT > BUDGET) break;
          const touching = contactTick(mug, w.k[0], 0.35, 0.5, 0.05, N);
          tick++; done++; used += C_CONTACT; contactTicks++;
          afterContact(mug, 0, bodies, w, tick, m, ID, touching, N.x, N.y, N.z);
        } else {
          if (used + C_QUANTUM > BUDGET) break;
          tick += e; done += e; used += C_QUANTUM; quanta++;
          serviceBodies(bodies, w, tick, m, ID);
        }
        if (restAt < 0 && mug.qs.mode === MODE_REST) restAt = tick;
        expect(gapStatic(mug.p, 0.05)).toBeGreaterThanOrEqual(-DRIFT_SLOP - 1e-9);
      }
      rates.push(done * Q * 60);
      if (firstFull < 0 && done >= 0.9 * WANT) firstFull = frame;
    }
    console.log(`[qs] thrown mug: rest after ${(restAt * Q).toFixed(1)} s sim, ${contactTicks} contact ticks, ${quanta} quanta; warp ≥ 0.9e4 from frame ${firstFull} (${((firstFull + 1) / 60).toFixed(3)} s real); first frames ${rates.slice(0, 4).map((r) => r.toFixed(0)).join(', ')}`);
    expect(firstFull).toBeGreaterThanOrEqual(0);
    expect((firstFull + 1) / 60).toBeLessThanOrEqual(0.5);
    expect(Math.min(...rates.slice(firstFull))).toBeGreaterThanOrEqual(0.9e4);
    expect(mug.qs.mode).toBe(MODE_REST);
  });
});

describe('scheduler independence and cost', () => {
  it('the step sequence does not depend on the frame budget', () => {
    const m = motion(v3(), v3(0, 0.05, 0)), w = world(2, 0.05, dragK(0.006, 0.35)), qAt = (t: number): Quat => rotY(0.05 * t * Q);
    const go = (perFrame: number): string => {
      const B = [body(v3(0, 1.2, 0), v3(0.2, 0.05, -0.1)), body(v3(0.5, 1, 1), v3(-0.1, 0, 0.1))];
      for (const b of B) afterContact(b, 0, B, w, 0, m, qAt(0), false, 0, 0, 0);
      let tick = 0;
      const log: number[] = [];
      for (let f = 0; f < 400 && tick < 60 * 120; f++) for (let k = 0; k < perFrame; k++) {
        const e = nextBodyEvent(B, tick, 2048);
        if (bodyEvent.why === WHY_CONTACT) return log.join(',') + '|' + JSON.stringify(B);
        tick += Math.min(e, 60 * 120 - tick);
        serviceBodies(B, w, tick, m, qAt(tick));
        log.push(tick);
        if (tick >= 60 * 120) break;
      }
      return log.join(',') + '|' + JSON.stringify(B);
    };
    expect(go(1)).toBe(go(7));
  });

  it('µs per call (node)', () => {
    const n = 30, m = motion(v3(), v3(0, 0.01, 0), 1.2e-6), w = world(n, 0.05, dragK(0.006, 0.35));
    const B: QsBody[] = [];
    for (let i = 0; i < n; i++) B.push(body(v3(-1.2 + 0.08 * i, 0.3 + 0.06 * i, -2.5 + 0.17 * i), v3(0.01 * (i % 5), -0.004 * (i % 3), 0.003 * i)));
    for (const b of B) afterContact(b, 0, B, w, 0, m, ID, false, 0, 0, 0);
    const q = rotY(0.001);
    let t0 = performance.now();
    const N = 20000;
    for (let k = 0; k < N; k++) serviceBodies(B, w, 1, m, q); // positions only (no segment ends)
    const pos = ((performance.now() - t0) * 1000) / N;
    t0 = performance.now();
    for (let k = 0; k < N; k++) { const b = B[k % n]; anchorDrift(b, 1, m, q); scheduleDrift(b, k % n, B, w, 1, m, q); }
    const ev = ((performance.now() - t0) * 1000) / N;
    t0 = performance.now();
    let s = 0;
    for (let k = 0; k < N * 10; k++) s += nextBodyEvent(B, 1, 2048);
    const ne = ((performance.now() - t0) * 1000) / (N * 10);
    console.log(`[qs] µs (node): serviceBodies 30 drifting bodies ${pos.toFixed(3)} (${((pos / 30) * 1000).toFixed(0)} ns/body), one segment end (anchor + bound, 6 boxes + 29 bodies) ${ev.toFixed(3)}, nextBodyEvent(30) ${ne.toFixed(3)}`);
    expect(s).toBeGreaterThan(0);
    expect(pos).toBeLessThan(20);
  });
});

// ------------------------------------------------------------------------------------------------ review fixes (D1–D6, D10)

/** Fine RK4 of a free body in the ship frame with cabin-air drag on the full air-relative velocity. */
function rk4Ship(m: BodyMotion, k: number, s0: number[], T: number, n: number): number[] {
  const F = v3();
  const f = (y: number[]): number[] => {
    feltAt(m, y[0], y[1], y[2], y[3], y[4], y[5], F);
    const sp = Math.hypot(y[3], y[4], y[5]);
    return [y[3], y[4], y[5], F.x - k * sp * y[3], F.y - k * sp * y[4], F.z - k * sp * y[5]];
  };
  let s = s0.slice();
  const h = T / n;
  for (let i = 0; i < n; i++) {
    const k1 = f(s), k2 = f(s.map((y, j) => y + 0.5 * h * k1[j])), k3 = f(s.map((y, j) => y + 0.5 * h * k2[j])), k4 = f(s.map((y, j) => y + h * k3[j]));
    s = s.map((y, j) => y + (h / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
  }
  return s;
}

describe('ship impulses reach drifting and resting bodies (D1)', () => {
  it('a 2 m/s latch: a floating body keeps its inertial velocity (−Δv), the Δω part follows; CONTACT and selfJump', () => {
    const w = world(3), m = motion();
    const a = body(v3(0.5, 1.2, 0.3), v3()), c = body(v3(0, 1, 1), v3(0.1, 0, 0)), crew = body(v3(1, 1, 1), v3());
    const B = [a, c, crew];
    w.selfJump = Uint8Array.from([0, 0, 1]);
    afterContact(a, 0, B, w, 0, m, ID, false, 0, 0, 0);
    for (let t = 1; t < 10; t++) serviceBodies(B, w, t, m, ID);
    expect(a.qs.mode).toBe(MODE_DRIFT);
    // the latch: Δv = (0, 0, 2), Δω = (0, 0.1, 0); after it the ship turns at 0.1 rad/s
    const dv = v3(0, 0, 2), dw = v3(0, 0.1, 0), m2 = motion(v3(), dw);
    serviceBodies(B, w, 10, m2, ID, dv, dw);
    const j = v3(-dv.x - (dw.y * a.p.z - dw.z * a.p.y), -dv.y - (dw.z * a.p.x - dw.x * a.p.z), -dv.z - (dw.x * a.p.y - dw.y * a.p.x));
    for (const k of ['x', 'y', 'z'] as const) expect(a.v[k]).toBeCloseTo(j[k], 14);
    expect(c.v.x).toBeCloseTo(0.1 + j.x + (dw.y * a.p.z) - (dw.y * c.p.z), 14); // CONTACT: v += −Δv − Δω×p at its own p
    expect(c.v.z).toBeCloseTo(-2 - (dw.x * c.p.y - dw.y * c.p.x), 14);
    expect(crew.v).toEqual(v3()); // selfJump: crew.ts applies it (boots / harness)
    // 1 s later the floating body is 2 m aft in inertial terms: |x| from the CoM grows as the ship moves away
    let t = 10;
    const qAt = (tt: number): Quat => rotY(0.1 * (tt - 10) * Q);
    while (t < 130) { t++; serviceBodies(B, w, t, m2, qAt(t)); if (a.qs.mode !== MODE_DRIFT) break; }
    const X = v3(), V = v3();
    driftEval(a.qs, t, 0, X, V);
    expect(V.z).toBeCloseTo(-2, 12);
    expect(X.z).toBeCloseTo(0.3 - 2 * (t - 10) * Q, 9);
  });

  it('a resting body: held inside the impulse cone, woken with the jump outside it', () => {
    const w = world(1, 0.05, 0, 0.5), g1 = motion(v3(0, 9.81, 0)), g0 = motion();
    const mk = (m: BodyMotion): QsBody => { const b = body(v3(0, 0.05, 0), v3()); expect(tryRest(b, 0.5, 0, m, 0, 1, 0)).toBe(true); return b; };
    // zero g, a sideways 2 m/s jolt: nothing presses it to the deck → it slides off with the jump
    let b = mk(g0);
    serviceBodies([b], w, 1, g0, ID, v3(2, 0, 0), null);
    expect(b.qs.mode).toBe(MODE_CONTACT); expect(b.v).toEqual(v3(-2, 0, 0));
    // landed (1 g): friction passes μ·g·Q = 0.041 m/s per tick: 0.03 holds, 0.06 slips
    b = mk(g1); serviceBodies([b], w, 1, g1, ID, v3(0.03, 0, 0), null); expect(b.qs.mode).toBe(MODE_REST);
    b = mk(g1); serviceBodies([b], w, 1, g1, ID, v3(0.06, 0, 0), null); expect(b.qs.mode).toBe(MODE_CONTACT); expect(b.v.x).toBe(-0.06);
    // the deck pushing up into it always holds; dropping away faster than g·Q lifts it
    b = mk(g1); serviceBodies([b], w, 1, g1, ID, v3(0, 1, 0), null); expect(b.qs.mode).toBe(MODE_REST);
    b = mk(g1); serviceBodies([b], w, 1, g1, ID, v3(0, -0.1, 0), null); expect(b.qs.mode).toBe(MODE_CONTACT);
    expect(restHoldsJump(v3(0, -0.5, 0.2), v3(0, 1, 0), 0.5, -9.81, Q)).toBe(true); // |0.2| ≤ 0.5·(0.5 + 0.08)
  });
});

describe('a change of the ship acceleration is taken on the interval it belongs to (D2)', () => {
  it('12 m/s² ignition: drift agrees with the exact path at 1× and under a 60-tick quantum', () => {
    const w = world(1), m0 = motion(), m1 = motion(v3(0, 0, 12));
    // at 1×: the tick-10 mean is the first with thrust (the interval (9Q, 10Q])
    const b = body(v3(0, 1.2, 0), v3()); const B = [b];
    afterContact(b, 0, B, w, 0, m0, ID, false, 0, 0, 0);
    for (let t = 1; t <= 70; t++) serviceBodies(B, w, t, t >= 10 ? m1 : m0, ID);
    const T = 61 * Q;
    expect(b.v.z).toBeCloseTo(-12 * T, 12); expect(b.p.z).toBeCloseTo(-6 * T * T, 12);
    // warp-like: serviced at 0 and then once at 60 with the mean of (0, 60]
    const c = body(v3(0, 1.2, 0), v3()); const C = [c];
    afterContact(c, 0, C, w, 0, m0, ID, false, 0, 0, 0);
    serviceBodies(C, w, 60, m1, ID);
    expect(c.v.z).toBeCloseTo(-12 * 60 * Q, 12); expect(c.p.z).toBeCloseTo(-6 * (60 * Q) ** 2, 12);
  });
});

describe('drag under a felt acceleration (D3)', () => {
  const k = dragK(0.19, 0.45), A = 20;
  const cases: [string, V3][] = [['from rest', v3()], ['thrown against the felt', v3(0, 0, 6)], ['faster than terminal', v3(0, 0, -14)]];
  for (const [name, u] of cases) {
    it(`pillow in a 20 m/s² aerobrake, ${name}: the 1-D closed form matches RK4`, () => {
      const m = motion(v3(0, 0, A)), b = body(v3(0, 1.2, 0), u);
      anchorDrift(b, 0, m, ID);
      const p = v3(), v = v3();
      for (const n of [12, 60, 180]) {
        driftToShip(b.qs, n, k, ID, m.w, p, v);
        const r = rk4Ship(m, k, [0, 1.2, 0, u.x, u.y, u.z], n * Q, 4000);
        const ex = Math.hypot(p.x - r[0], p.y - r[1], p.z - r[2]), ev = Math.hypot(v.x - r[3], v.y - r[4], v.z - r[5]);
        expect(ex).toBeLessThan(1e-9);
        expect(ev).toBeLessThan(1e-9);
      }
    });
  }

  it('pillow aerobrake to the bulkhead (drift scheduler) agrees with RK4; thrown sideways the segments are capped', () => {
    const m = motion(v3(0, 0, A)), w = world(1, 0.05, k);
    for (const u of [v3(), v3(0.05, 0, -3), v3(0.8, 0.3, 0)]) {
      const b = body(v3(0, 1.2, 0), u), B = [b];
      afterContact(b, 0, B, w, 0, m, ID, false, 0, 0, 0);
      let tick = 0, segs = 0, maxErr = 0;
      while (b.qs.mode === MODE_DRIFT && tick < 1200) {
        tick += nextBodyEvent(B, tick, 2048); serviceBodies(B, w, tick, m, ID); segs++;
        const r = rk4Ship(m, k, [0, 1.2, 0, u.x, u.y, u.z], tick * Q, 400 + tick * 20);
        maxErr = Math.max(maxErr, Math.hypot(b.p.x - r[0], b.p.y - r[1], b.p.z - r[2]));
      }
      const r = rk4Ship(m, k, [0, 1.2, 0, u.x, u.y, u.z], tick * Q, 20000);
      // what CONTACT stepping would give instead: the contact solver's semi-implicit Euler at Q with dragStep
      const e = body(v3(0, 1.2, 0), u), F = v3();
      for (let t = 0; t < tick; t++) {
        feltAt(m, e.p.x, e.p.y, e.p.z, e.v.x, e.v.y, e.v.z, F);
        e.v.x += F.x * Q; e.v.y += F.y * Q; e.v.z += F.z * Q; dragStep(e.v, k, Q);
        e.p.x += e.v.x * Q; e.p.y += e.v.y * Q; e.p.z += e.v.z * Q;
      }
      const eulerErr = Math.hypot(e.p.x - r[0], e.p.y - r[1], e.p.z - r[2]);
      console.log(`[qs] pillow aerobrake u0 (${u.x}, ${u.y}, ${u.z}): ${segs} segments, hand-over tick ${tick}, v.z ${b.v.z.toFixed(3)} (RK4 ${r[5].toFixed(3)}, terminal ${Math.sqrt(A / k).toFixed(2)}), max |Δp| ${(maxErr * 1000).toFixed(3)} mm (Euler at Q: ${(eulerErr * 1000).toFixed(1)} mm)`);
      expect(b.qs.mode).toBe(MODE_CONTACT);
      expect(Math.abs(b.v.z - r[5])).toBeLessThan(u.x === 0 ? 1e-9 : 0.03);
      expect(maxErr).toBeLessThan(u.x === 0 ? 1e-9 : 0.01);
      if (u.x !== 0) expect(maxErr).toBeLessThan(eulerErr); // more accurate than the CONTACT path it replaces
      expect(-b.v.z).toBeLessThan(Math.sqrt(A / k));
    }
  });
});

describe('re-anchor cheaply, re-schedule rarely, scan only nearby boxes (D4)', () => {
  it('RCS means alternating 0.010 / 0.012 m/s²: one re-anchor per tick, almost no re-schedules', () => {
    const w = makeQsWorld(ROOM, 6, 8, { k: new Float64Array(8).fill(dragK(0.006, 0.35)) });
    const B: QsBody[] = [];
    for (let i = 0; i < 8; i++) B.push(body(v3(-1 + 0.3 * i, 0.6 + 0.2 * i, -2 + 0.5 * i), v3(0.01, -0.005 * (i % 3), 0.004 * i)));
    const ms = [motion(v3(0.010, 0, 0), v3(0, 0.002, 0)), motion(v3(0.012, 0, 0), v3(0, 0.002, 0))];
    for (let i = 0; i < 8; i++) afterContact(B[i], i, B, w, 0, ms[0], ID, false, 0, 0, 0);
    qsStats.reanchors = 0; qsStats.reschedules = 0;
    for (let t = 1; t <= 600; t++) serviceBodies(B, w, t, ms[t & 1], rotY(0.002 * t * Q));
    const drifting = B.filter((b) => b.qs.mode === MODE_DRIFT).length;
    console.log(`[qs] RCS alternation, 8 bodies, 600 ticks: ${qsStats.reanchors} re-anchors, ${qsStats.reschedules} re-schedules, ${drifting} still drifting`);
    expect(qsStats.reschedules).toBeLessThan(0.02 * qsStats.reanchors);
  });

  it('the static grid gives exactly the schedule of the full box scan', () => {
    const boxes = new Float64Array(6 * 60);
    let seed = 12345;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = 0; i < 60; i++) {
      const x = -6 + 12 * rnd(), y = -1 + 4 * rnd(), z = -8 + 16 * rnd(), sx = 0.05 + rnd(), sy = 0.05 + rnd(), sz = 0.05 + rnd();
      boxes.set([x, y, z, x + sx, y + sy, z + sz], 6 * i);
    }
    const wg = makeQsWorld(boxes, 60, 1, { k: [dragK(0.19, 0.45)], hy: [0] }), wn: QsWorld = { ...wg, grid: undefined };
    let same = 0;
    for (let n = 0; n < 300; n++) {
      const p = v3(-6 + 12 * rnd(), -1 + 4 * rnd(), -8 + 16 * rnd()), v = v3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5);
      const m = motion(v3(0.3 * (rnd() - 0.5), 0, 0.3 * (rnd() - 0.5)), v3(0, 0.01 * rnd(), 0));
      const a = body(p, v), b = body(p, v);
      afterContact(a, 0, [a], wg, 0, m, ID, false, 0, 0, 0);
      afterContact(b, 0, [b], wn, 0, m, ID, false, 0, 0, 0);
      expect(a.qs.tickEnd).toBe(b.qs.tickEnd); expect(a.qs.mode).toBe(b.qs.mode);
      if (a.qs.mode === MODE_DRIFT) same++;
    }
    expect(same).toBeGreaterThan(30);
  });
});

/** Gap of an upright capsule (centre p, radius r, half segment hy along +Y) to the room's boxes. */
function gapCapsule(p: V3, r: number, hy: number): number {
  let g = Infinity;
  for (let o = 0; o < ROOM.length; o += 6) {
    const dx = Math.max(ROOM[o] - p.x, 0, p.x - ROOM[o + 3]), dz = Math.max(ROOM[o + 2] - p.z, 0, p.z - ROOM[o + 5]);
    const dy = Math.max(ROOM[o + 1] - (p.y + hy), 0, (p.y - hy) - ROOM[o + 4]);
    g = Math.min(g, Math.hypot(dx, dy, dz) - r);
  }
  return g;
}

describe('the crew drifts as its capsule (D6)', () => {
  it('floating feet-first toward the deck: CONTACT takes over before the feet touch', () => {
    const r = 0.28, hy = crewQsHy(1.75, 0.28);
    const w: QsWorld = { ...world(1, r, dragK(0.6, 80), 0.7), hy: Float64Array.of(hy) };
    // feet 0.25 m above the deck (crew.pos.y = 0.25): the capsule centre is 0.875 m above the feet
    const b = body(v3(0, 0.25 + 0.875, 0.5), v3(0.05, -0.2, 0)), B = [b];
    afterContact(b, 0, B, w, 0, motion(), ID, false, 0, 0, 0);
    expect(b.qs.mode).toBe(MODE_DRIFT);
    let tick = 0, minGap = Infinity;
    const p = v3(), v = v3();
    while (b.qs.mode === MODE_DRIFT && tick < 1200) {
      const e = nextBodyEvent(B, tick, 2048);
      for (let t = tick + 1; t <= tick + e; t++) { driftToShip(b.qs, t, w.k[0], ID, v3(), p, v); minGap = Math.min(minGap, gapCapsule(p, r, hy)); }
      tick += e; serviceBodies(B, w, tick, motion(), ID);
    }
    expect(b.qs.mode).toBe(MODE_CONTACT);
    expect(minGap).toBeGreaterThanOrEqual(-DRIFT_SLOP - 1e-12);
    expect(b.p.y - 0.875).toBeLessThan(0.02); // the feet are at the deck when it hands over
    expect(b.p.y - 0.875).toBeGreaterThan(-DRIFT_SLOP);
  });
});

// rotation: torque-free in inertial space (constant L)
function rk4Rot(q0: Quat, L: V3, I: number[], T: number, n: number): Quat {
  const rv = (q: number[], x: number, y: number, z: number): number[] => {
    const [qx, qy, qz, qw] = q, tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
    return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)];
  };
  const om = (q: number[]): number[] => { const b = rv([-q[0], -q[1], -q[2], q[3]], L.x, L.y, L.z); return rv(q, b[0] / I[0], b[1] / I[1], b[2] / I[2]); };
  const f = (q: number[]): number[] => {
    const [wx, wy, wz] = om(q), [x, y, z, w] = q;
    return [0.5 * (w * wx + wy * z - wz * y), 0.5 * (w * wy + wz * x - wx * z), 0.5 * (w * wz + wx * y - wy * x), 0.5 * (-wx * x - wy * y - wz * z)];
  };
  let q = [q0.x, q0.y, q0.z, q0.w];
  const h = T / n;
  for (let i = 0; i < n; i++) {
    const k1 = f(q), k2 = f(q.map((y, j) => y + 0.5 * h * k1[j])), k3 = f(q.map((y, j) => y + 0.5 * h * k2[j])), k4 = f(q.map((y, j) => y + h * k3[j]));
    q = q.map((y, j) => y + (h / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
    const l = Math.hypot(...q); q = q.map((y) => y / l);
  }
  return { x: q[0], y: q[1], z: q[2], w: q[3] };
}
/** Rotation angle between two attitudes: 2·asin |vec(a⁻¹b)| (accurate near 0). */
const qdist = (a: Quat, b: Quat): number => {
  const x = a.w * b.x - a.x * b.w - a.y * b.z + a.z * b.y, y = a.w * b.y + a.x * b.z - a.y * b.w - a.z * b.x, z = a.w * b.z - a.x * b.y + a.y * b.x - a.z * b.w;
  return 2 * Math.asin(Math.min(1, Math.hypot(x, y, z)));
};
const qmulT = (a: Quat, b: Quat): Quat => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y, y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w, w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});

describe('drifting rotation (D10)', () => {
  const q0: Quat = (() => { const a = 0.7, s = Math.sin(a / 2) / Math.sqrt(3); return { x: s, y: -s, z: s, w: Math.cos(a / 2) }; })();
  for (const [name, I, tol] of [['isotropic', [0.02, 0.02, 0.02], 1e-10], ['axisymmetric (mug-like)', [0.004, 0.0025, 0.004], 1e-10], ['triaxial (book)', [0.002, 0.006, 0.0075], 1e-4]] as const) {
    it(`${name}: matches RK4 of the torque-free motion after 20 s in a turning ship; independent of evaluation pattern`, () => {
      const W = v3(0, 0.05, 0), m = motion(v3(), W), qAt = (t: number): Quat => rotY(0.05 * t * Q);
      const w = makeQsWorld(new Float64Array(0), 0, 1, { I: [...I] });
      const mk = (): QsBody => ({ p: v3(0, 1, 0), v: v3(), q: { ...q0 }, w: v3(1.1, -0.4, 2.3), qs: createQsState() });
      const a = mk(), b = mk();
      afterContact(a, 0, [a], w, 0, m, qAt(0), false, 0, 0, 0);
      afterContact(b, 0, [b], w, 0, m, qAt(0), false, 0, 0, 0);
      const N = 20 * 120;
      for (let t = 1; t <= N; t++) serviceBodies([a], w, t, m, qAt(t)); // every tick (1×)
      for (let t = 0; t < N;) { t = Math.min(N, t + Math.min(997, nextBodyEvent([b], t, 2048))); serviceBodies([b], w, t, m, qAt(t)); } // warp quanta
      expect(JSON.stringify([a.q, a.w, a.qs])).toBe(JSON.stringify([b.q, b.w, b.qs]));
      // reference: inertial ω₀ = q·(w + W), L = R I Rᵀ ω₀ (here q = ID at t = 0)
      const w0 = v3(1.1 + W.x, -0.4 + W.y, 2.3 + W.z);
      const conj = { x: -q0.x, y: -q0.y, z: -q0.z, w: q0.w };
      const toB = qmulT(qmulT(conj, { x: w0.x, y: w0.y, z: w0.z, w: 0 }), q0);
      const Lb = qmulT(qmulT(q0, { x: toB.x * I[0], y: toB.y * I[1], z: toB.z * I[2], w: 0 }), conj);
      const ref = rk4Rot(q0, v3(Lb.x, Lb.y, Lb.z), [...I], N * Q, 200000);
      const got = qmulT(qAt(N), a.q!); // ship → inertial
      const err = qdist(got, ref);
      console.log(`[qs] ${name}: attitude error after 20 s ${err.toExponential(2)} rad; rotation steps per 1e4×-frame (20000 ticks) ${rotSteps([a], 20000)}`);
      expect(err).toBeLessThan(tol);
    });
  }
});
