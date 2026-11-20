// The physical world, stages 7–8: prediction, osculating read-outs, benchmark.
import { describe, expect, it } from 'vitest';
import type { V3 } from '../src/core/types';
import { SHIP_LAYOUTS } from '../src/data/shipLayouts';
import { computeStats, defaultLoadout } from '../src/sim/ships';
import { generateGalaxy, getSystem } from '../src/sim/universe';
import {
  addCraft, advance, circularState, createPrediction, createWorld, ephemerisOf, EV_APOAPSIS, EV_ATMOSPHERE, EV_BURN, EV_CLOSEST, EV_IMPACT,
  EV_PERIAPSIS, flightReadout, predict, predictionEvent, Predictor, shipDef, yoshidaStep, type Craft, type Prediction, type World,
} from '../src/world';

const system = getSystem(generateGalaxy(1), 'tallow')!;
const stats = computeStats(defaultLoadout('wren'));
const WICK = 'tallow.wick', WHEEL = 'tallow.st.chandlers-wheel';
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });

/** Ship on a hp × ha orbit of Wick (starting at periapsis), stations present. */
function elliptic(hp: number, ha: number, stations = true): { w: World; ship: Craft; R: number; mu: number; T: number } {
  const w = createWorld(system, { stations });
  const b = w.bodies.find((x) => x.id === WICK)!;
  const rp = b.radius + hp, a = b.radius + (hp + ha) / 2;
  const ship = addCraft(w, shipDef('player', 'Wren', stats, SHIP_LAYOUTS.wren, { primaryId: WICK, r: v3(rp, 0, 0), v: v3(0, 0, -Math.sqrt(b.mu * (2 / rp - 1 / a))) }));
  return { w, ship, R: b.radius, mu: b.mu, T: 2 * Math.PI * Math.sqrt(a ** 3 / b.mu) };
}
const kinds = (p: Prediction, k: number): ReturnType<typeof predictionEvent>[] =>
  Array.from({ length: p.eventCount }, (_, i) => predictionEvent(p, i)).filter((_, i) => p.events[6 * i] === k);
const flyTo = (w: World, t: number, chunk = 250): void => { while (w.t < t) advance(w, Math.min(chunk, t - w.t)); };

describe('prediction', () => {
  it('incremental (SIMULATION.md W1-A 3): a path extended in step-count slices equals one long run, bit for bit', () => {
    const { w, T } = elliptic(300e3, 2000e3);
    advance(w, 500);
    const opts = { duration: 3 * T, targetCraftId: WHEEL };
    const long = createPrediction(512), inc = createPrediction(512);
    const a = new Predictor();
    a.start(w, 'player', opts, long);
    expect(a.run()).toBe(true);
    // the same start, first to one orbit, then extended twice, in slices of 37 steps
    const b = new Predictor();
    b.start(w, 'player', { ...opts, duration: T }, inc);
    let slices = 0;
    while (!b.run(37)) slices++;
    expect(inc.horizon).toBeCloseTo(T, 6);
    expect(b.extend(w.t + 2 * T)).toBe(true);
    while (!b.run(37)) slices++;
    expect(b.extend(w.t + 3 * T)).toBe(true);
    while (!b.run(37)) slices++;
    expect(slices).toBeGreaterThan(5);
    expect(inc.steps).toBe(long.steps);
    expect(inc.count).toBe(long.count);
    expect(Array.from(inc.points.subarray(0, 4 * inc.count))).toEqual(Array.from(long.points.subarray(0, 4 * long.count)));
    expect(Array.from(inc.targetPoints.subarray(0, 4 * inc.count))).toEqual(Array.from(long.targetPoints.subarray(0, 4 * long.count)));
    expect(inc.eventCount).toBe(long.eventCount);
    expect(Array.from(inc.events.subarray(0, 6 * inc.eventCount))).toEqual(Array.from(long.events.subarray(0, 6 * long.eventCount)));
    expect(inc.horizon).toBe(long.horizon);
    // dropping the points behind the present keeps the path from the last point at or before it
    const t1 = long.points[4 * 40 + 3] + 1;
    b.dropBefore(t1);
    expect(inc.points[3]).toBeLessThanOrEqual(t1);
    expect(inc.points[7]).toBeGreaterThan(t1);
    expect(inc.count).toBe(long.count - 40);
  });

  it('held thrust: the ghost burns for the time given at the powered step, then coasts', () => {
    const { w, ship, T } = elliptic(300e3, 300e3, false);
    const coast = createPrediction(512), burn = createPrediction(512);
    predict(w, 'player', { duration: T }, coast);
    const F = stats.mainThrust, md = F / stats.exhaustVelocity, v = ship.relV, vl = len(v);
    predict(w, 'player', { duration: T, thrust: { fx: (F * v.x) / vl, fy: (F * v.y) / vl, fz: (F * v.z) / vl, mdot: md, until: w.t + 20 } }, burn);
    // a prograde burn of 20 s raises the far side of the orbit: half an orbit on, the path is higher
    const at = (p: Prediction, t: number): number => {
      let i = 0;
      while (i + 1 < p.count && p.points[4 * (i + 1) + 3] <= t) i++;
      return Math.hypot(p.points[4 * i], p.points[4 * i + 1], p.points[4 * i + 2]);
    };
    expect(at(burn, w.t + T / 2) - at(coast, w.t + T / 2)).toBeGreaterThan(50e3);
    expect(burn.steps).toBeGreaterThan(coast.steps);
  });

  it('the predicted path is the path that is flown', () => {
    const { w, ship, T } = elliptic(300e3, 2000e3);
    advance(w, 500);
    const wheel = w.craft.find((c) => c.id === WHEEL)!;
    const pred = createPrediction(512);
    predict(w, 'player', { duration: 3 * T, targetCraftId: WHEEL }, pred);
    expect(pred.done).toBe(true);
    expect(pred.horizon).toBeCloseTo(3 * T, 6);
    expect(pred.count).toBeGreaterThan(200);
    expect(pred.count).toBeLessThanOrEqual(512);
    expect(pred.targetCount).toBe(pred.count);
    const peri = kinds(pred, EV_PERIAPSIS), apo = kinds(pred, EV_APOAPSIS), ca = kinds(pred, EV_CLOSEST);
    expect(peri.length).toBe(3);
    expect(apo.length).toBe(3);
    for (const e of peri) expect(Math.abs(e.value - 300e3)).toBeLessThan(300);
    for (const e of apo) expect(Math.abs(e.value - 2000e3)).toBeLessThan(300);
    expect(Math.abs(apo[0].t - (T / 2))).toBeLessThan(2);
    // Closest approach: no sampled separation is smaller than the best event, and the event is near the sampled minimum.
    let dMin = Infinity;
    for (let i = 0; i < pred.count; i++) {
      dMin = Math.min(dMin, Math.hypot(pred.points[4 * i] - pred.targetPoints[4 * i], pred.points[4 * i + 1] - pred.targetPoints[4 * i + 1], pred.points[4 * i + 2] - pred.targetPoints[4 * i + 2]));
    }
    const best = Math.min(...ca.map((e) => e.value));
    expect(ca.length).toBeGreaterThan(0);
    expect(best).toBeLessThanOrEqual(dMin + 1);
    expect(best).toBeGreaterThan(0.8 * dMin - 1000);
    // Fly it (in unrelated chunks) and compare at predicted points.
    let err = 0, errT = 0;
    for (let k = 1; k <= 12; k++) {
      const i = Math.min(pred.count - 1, Math.round((k * (pred.count - 1)) / 12));
      flyTo(w, pred.points[4 * i + 3]);
      err = Math.max(err, Math.hypot(ship.rel.x - pred.points[4 * i], ship.rel.y - pred.points[4 * i + 1], ship.rel.z - pred.points[4 * i + 2]));
      errT = Math.max(errT, Math.hypot(wheel.rel.x - pred.targetPoints[4 * i], wheel.rel.y - pred.targetPoints[4 * i + 1], wheel.rel.z - pred.targetPoints[4 * i + 2]));
    }
    console.log(`prediction vs flight over 3 orbits (${pred.count} points, ${pred.steps} steps): ship ${err.toFixed(2)} m, target ${errT.toFixed(2)} m; closest approach ${best.toFixed(0)} m (sampled ${dMin.toFixed(0)} m)`);
    expect(err).toBeLessThan(100);
    expect(errT).toBeLessThan(100);
  });

  it('applies planned burns as impulses, and works in slices of a time budget', () => {
    const { w, ship, T } = elliptic(300e3, 800e3, false);
    advance(w, 300);
    const burn = { t: w.t + 1200, prograde: 80, normal: 10, radial: -5 };
    const opts = { duration: 1.5 * T, burns: [burn], frameBodyId: 'tallow.star' };
    const pred = createPrediction(256), sliced = createPrediction(256);
    predict(w, 'player', opts, pred);
    const ev = kinds(pred, EV_BURN);
    expect(ev.length).toBe(1);
    expect(ev[0].value).toBeCloseTo(Math.hypot(80, 10, 5), 9);
    expect(ev[0].t).toBe(burn.t);
    // Incremental: a clock that charges 1 ms per look makes every slice stop after 8 steps.
    let clock = 0, slices = 0;
    const pr = new Predictor();
    pr.start(w, 'player', opts, sliced);
    while (!pr.run(4, () => (clock += 3))) slices++;
    expect(slices).toBeGreaterThan(10);
    expect(sliced.count).toBe(pred.count);
    expect(Array.from(sliced.points.subarray(0, 4 * pred.count))).toEqual(Array.from(pred.points.subarray(0, 4 * pred.count)));
    // Fly: coast to the burn, apply the same impulse by hand, coast to the end. The frame is the star.
    flyTo(w, burn.t, 97);
    const r = ship.rel, v = ship.relV, vl = len(v);
    const p = v3(v.x / vl, v.y / vl, v.z / vl);
    let n = v3(r.y * v.z - r.z * v.y, r.z * v.x - r.x * v.z, r.x * v.y - r.y * v.x);
    const nl = len(n);
    n = v3(n.x / nl, n.y / nl, n.z / nl);
    const rad = v3(p.y * n.z - p.z * n.y, p.z * n.x - p.x * n.z, p.x * n.y - p.y * n.x);
    v.x += 80 * p.x + 10 * n.x - 5 * rad.x; v.y += 80 * p.y + 10 * n.y - 5 * rad.y; v.z += 80 * p.z + 10 * n.z - 5 * rad.z;
    const i = pred.count - 1;
    flyTo(w, pred.points[4 * i + 3], 97);
    const star = w.bodies[0];
    const err = Math.hypot(ship.r.x - star.r.x - pred.points[4 * i], ship.r.y - star.r.y - pred.points[4 * i + 1], ship.r.z - star.r.z - pred.points[4 * i + 2]);
    console.log(`prediction with a burn, star frame: end point off by ${err.toFixed(2)} m after ${(pred.horizon / 3600).toFixed(1)} h (${slices} slices)`);
    expect(err).toBeLessThan(100);
  });

  it('foresees atmosphere entry and impact', () => {
    // From 300 km, on an ellipse whose periapsis lies 40 km under the ground.
    const w = createWorld(system, { stations: false });
    const b = w.bodies.find((x) => x.id === WICK)!;
    const r = b.radius + 300e3, a = b.radius + 130e3;
    const ship = addCraft(w, shipDef('player', 'Wren', stats, SHIP_LAYOUTS.wren, { primaryId: WICK, r: v3(r, 0, 0), v: v3(0, 0, -Math.sqrt(b.mu * (2 / r - 1 / a))) }));
    const pred = createPrediction(256);
    predict(w, 'player', { duration: 6000 }, pred);
    const atm = kinds(pred, EV_ATMOSPHERE), imp = kinds(pred, EV_IMPACT);
    expect(atm.length).toBe(1);
    expect(imp.length).toBe(1);
    expect(imp[0].t).toBeGreaterThan(atm[0].t);
    expect(pred.horizon).toBeCloseTo(imp[0].t - pred.t0, 6);
    let entered = -1;
    while (ship.landedOn === null && w.t < pred.t0 + 6000) { advance(w, 1); if (entered < 0 && ship.inAtmosphere) entered = w.t; }
    console.log(`predicted entry ${(atm[0].t - pred.t0).toFixed(1)} s / impact ${(imp[0].t - pred.t0).toFixed(1)} s; flown entry ${(entered - pred.t0).toFixed(1)} s / ground ${(w.t - pred.t0).toFixed(1)} s (${ship.destroyedBy})`);
    expect(Math.abs(entered - atm[0].t)).toBeLessThan(2);
    expect(Math.abs(w.t - imp[0].t)).toBeLessThan(3);
  });
});

describe('read-outs', () => {
  it('osculating elements describe the orbit and are consistent with the flight', () => {
    const { w, R, mu, T } = elliptic(300e3, 2000e3, false);
    let f = flightReadout(w, 'player');
    expect(f.primaryId).toBe(WICK);
    expect(f.situation).toBe('orbit');
    expect(f.altitude).toBeCloseTo(300e3, 3);
    expect(f.periapsisAlt).toBeCloseTo(300e3, 2);
    expect(f.apoapsisAlt).toBeCloseTo(2000e3, 2);
    expect(f.period).toBeCloseTo(T, 6);
    expect(f.eccentricity).toBeCloseTo(1700e3 / (2 * R + 2300e3), 9);
    expect(f.inclination).toBeLessThan(1e-9);
    expect(f.speed).toBeCloseTo(Math.sqrt(mu * (2 / (R + 300e3) - 2 / (2 * R + 2300e3))), 6);
    advance(w, 700);
    f = flightReadout(w, 'player');
    expect(f.verticalSpeed).toBeGreaterThan(0);
    const { timeToApoapsis, apoapsisAlt, timeToPeriapsis } = f;
    expect(timeToPeriapsis).toBeCloseTo(T - 700, 0);
    advance(w, timeToApoapsis);
    f = flightReadout(w, 'player');
    expect(Math.abs(f.verticalSpeed)).toBeLessThan(0.5);
    expect(Math.abs(f.altitude - apoapsisAlt)).toBeLessThan(100);
  });
});

describe('benchmark', () => {
  it('prints the numbers that matter on a phone', () => {
    const ms = (): number => performance.now();
    // Bodies.
    const w0 = createWorld(system, { stations: false });
    const n = w0.bodies.length, mu = w0.bodies.map((b) => b.mu), s = Float64Array.from(w0.ephState), acc = new Float64Array(3 * n);
    for (let k = 0; k < 20000; k++) yoshidaStep(n, mu, s, 0, acc, w0.h);
    let t0 = ms();
    for (let k = 0; k < 200000; k++) yoshidaStep(n, mu, s, 0, acc, w0.h);
    const bodyRate = 200000 / ((ms() - t0) / 1000);
    // One coasting craft.
    const lone = createWorld(system, { stations: false });
    const b = lone.bodies.find((x) => x.id === WICK)!;
    addCraft(lone, shipDef('player', 'Wren', stats, SHIP_LAYOUTS.wren, { primaryId: WICK, ...circularState(b.mu, b.radius + 420e3, 0) }));
    advance(lone, 2e5);
    const e = ephemerisOf(lone);
    let bs = e.steps;
    t0 = ms();
    const r1 = advance(lone, 4e6);
    const wall = ms() - t0;
    const bodySteps = e.steps - bs, craftSteps = r1.steps - bodySteps;
    const craftRate = craftSteps / ((wall - (bodySteps / bodyRate) * 1000) / 1000);
    // The first build's world: 4 stations + the Wren in low orbit of Wick.
    const full = createWorld(system);
    const ship = addCraft(full, shipDef('player', 'Wren', stats, SHIP_LAYOUTS.wren, { primaryId: WICK, ...circularState(b.mu, b.radius + 420e3, 0) }));
    for (let i = 0; i < 600; i++) advance(full, 1 / 60);
    const mem = (): number => (globalThis as unknown as { process?: { memoryUsage(): { heapUsed: number } } }).process?.memoryUsage().heapUsed ?? 0;
    const heap0 = mem();
    t0 = ms();
    let worst = 0;
    for (let i = 0; i < 6000; i++) { const a = ms(); advance(full, 1 / 60); worst = Math.max(worst, ms() - a); }
    const frame = (ms() - t0) / 6000;
    const heap = mem() - heap0;
    ship.throttle = 0.5; ship.torque.y = 0.2;
    t0 = ms();
    for (let i = 0; i < 3000; i++) advance(full, 1 / 60);
    const frameBurn = (ms() - t0) / 3000;
    ship.throttle = 0; ship.torque.y = 0;
    ship.w = v3();
    // Time acceleration inside a 3 ms budget.
    let covered = 0, used = 0, limited = '';
    for (let i = 0; i < 300; i++) { const r = advance(full, 1e9, { budgetMs: 3 }); covered += r.simDt; used += r.simMs; limited = r.limitedBy; }
    const warp = (covered / 300) * 60;
    // Prediction: 3 orbits with a target.
    const pred = createPrediction(512);
    const T = 2 * Math.PI * Math.sqrt((b.radius + 420e3) ** 3 / b.mu);
    for (let i = 0; i < 20; i++) predict(full, 'player', { duration: 3 * T, targetCraftId: WHEEL }, pred);
    t0 = ms();
    for (let i = 0; i < 200; i++) predict(full, 'player', { duration: 3 * T, targetCraftId: WHEEL }, pred);
    const predMs = (ms() - t0) / 200;
    t0 = ms();
    for (let i = 0; i < 200; i++) predict(full, 'player', { duration: 3 * T }, pred);
    const predSolo = (ms() - t0) / 200;
    console.log([
      'BENCHMARK (node on this machine; an A16 core is in the same class)',
      `  body steps/s            ${(bodyRate / 1e6).toFixed(2)} M  (${n} bodies, H = ${w0.h} s -> ${(bodyRate * w0.h / 86400 / 365.25).toFixed(1)} sim years per CPU second)`,
      `  craft steps/s           ${(craftRate / 1e6).toFixed(2)} M  (coasting, low orbit of Wick, ${(4e6 / craftSteps).toFixed(1)} s per step)`,
      `  advance() at 1x         ${(frame * 1000).toFixed(1)} µs per frame (worst ${(worst * 1000).toFixed(0)} µs), 5 craft; under thrust + torque ${(frameBurn * 1000).toFixed(1)} µs`,
      // V8 boxes a double that crosses a non-inlined call or lands in a generic field; JavaScriptCore (Safari) NaN-boxes
      // every double in place, so these heap and GC figures are V8 artefacts and say little about the phone
      // (SIMULATION.md W1-A 7, perf-v8-double-boxing-benchmarks)
      `  heap change, 6000 frames ${(heap / 1024).toFixed(0)} kB (no GC forced; the stepping loops allocate nothing; a V8 figure, see above)`,
      `  time acceleration       ${warp.toExponential(2)}x sustained in a 3 ms budget (mean ${(used / 300).toFixed(2)} ms used, limited by '${limited}')`,
      `  prediction, 3 orbits    ${predMs.toFixed(3)} ms with target (${pred.steps} steps), ${predSolo.toFixed(3)} ms alone`,
    ].join('\n'));
    expect(frame).toBeLessThan(0.3);
    expect(predMs).toBeLessThan(4);
    expect(warp).toBeGreaterThan(1e4);
  });
});
