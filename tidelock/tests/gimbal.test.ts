// W3-A gimbal and TVC (src/world/gimbal.ts): actuator range/rate/lag, the trim through the moving CoM as the tanks
// drain (RCS trim usage → 0 against a fixed mount), engine-out yaw, differential throttle, save/load, cost.

import { describe, expect, it } from 'vitest';
import { SHIP_LAYOUTS } from '../src/data/shipLayouts';
import { MP_CX, MP_CY, MP_CZ, buildMassModel, makeMassOut, makeTankState, massProps, tankDefsFor } from '../src/world/massProps';
import {
  DIFF_MAX, GIMBAL_RANGE, GIMBAL_RATE, GIMBAL_TAU, G_STRIDE, TI_MASK, TI_TX, TI_TY, TI_TZ, engineTorque, gimbalDefs, gimbalStep,
  loadGimbalState, makeGimbalState, makeTvcIn, makeTvcOut, tvcSolve,
} from '../src/world/gimbal';
import { makeRig, rigTick } from './w3aRig';
import { perfNow } from '../src/world/math';
import { IN_H, makeStepIn } from '../src/world/jets';

const IN = makeStepIn();
const at = (h: number) => { IN[IN_H] = h; return IN; };

const DEG = Math.PI / 180;

describe('W3-A gimbal', () => {
  it('actuator: rate limit 15°/s, then a 0.1 s lag, never beyond ±4°', () => {
    const g = makeGimbalState(2);
    g[2] = 10 * DEG; // a command beyond the range is clamped by tvcSolve; here the actuator just follows
    g[2] = GIMBAL_RANGE;
    // rate-limited until 1.5° short: (4 − 1.5)/15 s
    const tLin = (GIMBAL_RANGE - GIMBAL_RATE * GIMBAL_TAU) / GIMBAL_RATE;
    let t = 0;
    const h = 1 / 120;
    while (t + h <= tLin) { gimbalStep(g, 2, at(h)); t += h; }
    expect(g[0]).toBeCloseTo(GIMBAL_RATE * t, 12);
    // exactness: one big step = many small ones
    const a = makeGimbalState(1), b = makeGimbalState(1);
    a[2] = b[2] = -GIMBAL_RANGE;
    gimbalStep(a, 1, at(0.5));
    for (let k = 0; k < 60; k++) gimbalStep(b, 1, at(0.5 / 60));
    expect(a[0]).toBeCloseTo(b[0], 12);
    for (let k = 0; k < 600; k++) gimbalStep(b, 1, at(h));
    expect(b[0]).toBeGreaterThanOrEqual(-GIMBAL_RANGE);
    expect(b[0]).toBeCloseTo(-GIMBAL_RANGE, 9);
    expect(loadGimbalState([1, 1, 1, 1, 1], 1)).toEqual([GIMBAL_RANGE, GIMBAL_RANGE, GIMBAL_RANGE, GIMBAL_RANGE, DIFF_MAX]);
  });

  it('TVC trim: zero torque about the CoM at any fill; a commanded torque is delivered', () => {
    const mass = buildMassModel('wren', tankDefsFor('wren', 22500, 1500), 42900);
    const mp = makeMassOut();
    massProps(mass, makeTankState(mass, 1), [], [], [], 0, mp);
    const defs = gimbalDefs(SHIP_LAYOUTS.wren.engines, { x: mp[MP_CX], y: mp[MP_CY], z: mp[MP_CZ] });
    const T = [400e3, 400e3], g = makeGimbalState(2), ti = makeTvcIn(), to = makeTvcOut(), tq = { x: 0, y: 0, z: 0 };
    for (const fill of [1, 0.7, 0.4, 0.1]) {
      massProps(mass, makeTankState(mass, fill), [], [], [], 0, mp);
      ti[TI_TX] = ti[TI_TY] = ti[TI_TZ] = 0; ti[TI_MASK] = 7;
      for (let k = 0; k < 3; k++) tvcSolve(defs, g, T, mp, ti, to);
      for (let k = 0; k < 2; k++) { g[k * G_STRIDE] = g[k * G_STRIDE + 2]; g[k * G_STRIDE + 1] = g[k * G_STRIDE + 3]; }
      engineTorque(defs, g, T, mp, tq);
      expect(Math.hypot(tq.x, tq.y, tq.z), `fill ${fill}`).toBeLessThan(1);
    }
    // a pitch + yaw command of 0.2 MN·m each is within the authority (≈ 0.38 MN·m per engine)
    ti[TI_TX] = 2e5; ti[TI_TY] = -2e5; ti[TI_TZ] = 0;
    tvcSolve(defs, g, T, mp, ti, to);
    for (let k = 0; k < 2; k++) { g[k * G_STRIDE] = g[k * G_STRIDE + 2]; g[k * G_STRIDE + 1] = g[k * G_STRIDE + 3]; }
    engineTorque(defs, g, T, mp, tq);
    expect(Math.abs(tq.x - 2e5)).toBeLessThan(200);
    expect(Math.abs(tq.y + 2e5)).toBeLessThan(200);
    expect(Math.abs(tq.z)).toBeLessThan(200);
    // beyond the authority: clamped, the residual is reported for the RCS
    ti[TI_TX] = 5e6;
    tvcSolve(defs, g, T, mp, ti, to);
    expect(to[0]).toBeGreaterThan(3e6);
    expect(Math.abs(g[2])).toBeLessThanOrEqual(GIMBAL_RANGE);
  });

  it('a 300 s burn draining the belly: the bells trim the moving CoM and the RCS trim duty drops to ~0 (fixed mount: > 1 %)', () => {
    const run = (locked: boolean) => {
      const r = makeRig({ locked });
      r.s.throttle = 1;
      for (let i = 0; i < 120 * 300; i++) rigTick(r);
      return r;
    };
    const a = run(false), b = run(true);
    const dutyA = (100 * a.rcsDuty) / a.rcsT, dutyB = (100 * b.rcsDuty) / b.rcsT;
    const pitch = a.s.gimbal[0] / DEG;
    console.log(`300 s burn: RCS trim duty ${dutyA.toFixed(4)} % with TVC, ${dutyB.toFixed(2)} % with a fixed mount; bells at ${pitch.toFixed(2)}° pitch; jet table rebuilt ${a.rebuilds}×; attitude error ${(2 * Math.asin(Math.hypot(a.s.q.x, a.s.q.y, a.s.q.z)) / DEG).toExponential(2)}°`);
    expect(dutyA).toBeLessThan(0.05);
    expect(dutyB).toBeGreaterThan(1);
    expect(Math.abs(pitch)).toBeGreaterThan(0.5);
  });

  it('engine-out yaws the ship: the TVC cannot hold the yaw of one 400 kN engine 4.8 m off the axis', () => {
    const mass = buildMassModel('wren', tankDefsFor('wren', 22500, 1500), 42900);
    const mp = makeMassOut();
    massProps(mass, makeTankState(mass, 1), [], [], [], 0, mp);
    const defs = gimbalDefs(SHIP_LAYOUTS.wren.engines, { x: mp[MP_CX], y: mp[MP_CY], z: mp[MP_CZ] });
    const g = makeGimbalState(2), ti = makeTvcIn(), to = makeTvcOut();
    tvcSolve(defs, g, [400e3, 0], mp, ti, to);
    console.log(`engine out: yaw residual ${(to[1] / 1e6).toFixed(2)} MN·m (the RCS has ≈ 0.9)`);
    expect(Math.abs(to[1])).toBeGreaterThan(1e6);
    expect(g[4 + 2]).toBe(0); // the dead engine's bell is not commanded
    expect(g[8]).toBe(0); // no differential throttle with one engine
  });

  it('cost: tvcSolve and gimbalStep per call (node)', () => {
    const mass = buildMassModel('wren', tankDefsFor('wren', 22500, 1500), 42900);
    const mp = makeMassOut();
    massProps(mass, makeTankState(mass, 0.5), [], [], [], 0, mp);
    const defs = gimbalDefs(SHIP_LAYOUTS.wren.engines, { x: 0, y: -0.4, z: 3.4 });
    const g = makeGimbalState(2), ti = makeTvcIn(), to = makeTvcOut(), T = [4e5, 3.9e5];
    const N = 100000;
    for (let k = 0; k < N; k++) { ti[TI_TX] = (k & 7) * 1e4; tvcSolve(defs, g, T, mp, ti, to); }
    let t0 = perfNow();
    for (let k = 0; k < N; k++) { ti[TI_TX] = (k & 7) * 1e4; tvcSolve(defs, g, T, mp, ti, to); }
    const us1 = ((perfNow() - t0) * 1e3) / N;
    at(1 / 120);
    t0 = perfNow();
    for (let k = 0; k < N; k++) { g[2] = (k & 1) * 1e-2; gimbalStep(g, 2, IN); }
    const us2 = ((perfNow() - t0) * 1e3) / N;
    console.log(`cost (node): tvcSolve ${us1.toFixed(3)} µs (60 Hz), gimbalStep ${us2.toFixed(3)} µs`);
    expect(us1).toBeLessThan(8);
    expect(us2).toBeLessThan(1);
  });
});
