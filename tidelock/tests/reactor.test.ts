// W3-B reactor core (src/world/reactor.ts): first-order core, decay heat against the standard fraction curve, exact
// at any step, energy, the DRIVE ARM standby wait, save/load.
import { describe, expect, it } from 'vitest';
import { REACTOR_ETA } from '../src/data/powerNet';
import {
  CO_DECAY_J, CO_THERMAL_J, CORE_TAU, coreAdvance, coreDecay, coreElectric, coreStep, coreThermal, DECAY_C, DELAYED_FRACTION, loadCore,
  makeCore, saveCore, wayWigner,
} from '../src/world/reactor';

const P0 = 10e6 / REACTOR_ETA; // the drive load, thermal

describe('decay heat', () => {
  it('after T_op at P0 the decay heat is 0.066·P0·[t^−0.2 − (t + T_op)^−0.2] to < 1 % (10 s … 1e7 s)', () => {
    for (const Top of [3600, 1e6, 1e8]) {
      const c = makeCore(0);
      coreStep(c, P0, 0, Top); // one exact step of the whole operating time
      coreStep(c, 0, 1, 1e-9); // scram (prompt jump) …
      c.Pf = 0; // … taken as an instantaneous shutdown, the closed form's assumption (the real 80 s tail adds fissions)
      let t = 1e-9, worst = 0;
      for (const tt of [10, 30, 100, 1e3, 1e4, 1e5, 1e6, 1e7]) {
        coreStep(c, 0, 1, tt - t); t = tt;
        const ref = wayWigner(t, Top) * P0;
        const e = coreDecay(c) / ref - 1;
        if (Math.abs(e) > Math.abs(worst)) worst = e;
        expect(Math.abs(e)).toBeLessThan(0.01);
      }
      console.log(`decay heat after T_op ${Top.toExponential(0)} s: worst error ${worst.toExponential(2)} over 10 s … 1e7 s`);
    }
    // the plan's long-operation form 0.066·t^−0.2 at t ≪ T_op
    const c = makeCore(P0);
    coreStep(c, P0, 0, 1e8);
    coreStep(c, 0, 1, 100);
    expect(coreDecay(c) / (DECAY_C * Math.pow(100, -0.2) * P0)).toBeCloseTo(1, 1);
    expect(DELAYED_FRACTION).toBeGreaterThan(0.07); expect(DELAYED_FRACTION).toBeLessThan(0.09);
    console.log(`delayed share Σa = ${(DELAYED_FRACTION * 100).toFixed(2)} %; at 10 s after a long run at ${(P0 / 1e6).toFixed(1)} MW: ${(coreDecay(makeCoreAfter(10)) / 1e6).toFixed(2)} MW, at 1 h ${(coreDecay(makeCoreAfter(3600)) / 1e6).toFixed(2)} MW`);
  });

  it('the scram: prompt drop, then the 80 s period; total heat follows decay heat once the fission tail is gone', () => {
    const c = makeCore(P0);
    coreStep(c, P0, 1, 1e-6);
    expect(c.Pf).toBeCloseTo(0.1 * P0, -3);
    coreStep(c, 0, 1, 2000);
    expect(coreThermal(c) / coreDecay(c) - 1).toBeLessThan(1e-6);
  });
});

function makeCoreAfter(t: number) {
  const c = makeCore(0);
  coreStep(c, P0, 0, 1e7);
  coreStep(c, 0, 1, 1e-9);
  coreStep(c, 0, 1, t);
  return c;
}

describe('first-order core', () => {
  it('follows the setpoint with τ = 30 s; exact at any step; the step energy is the exact integral', () => {
    const a = makeCore(0), b = makeCore(0);
    coreStep(a, P0, 0, 60);
    for (let i = 0; i < 600; i++) coreStep(b, P0, 0, 0.1);
    expect(a.Pf / (P0 * (1 - Math.exp(-60 / CORE_TAU)))).toBeCloseTo(1, 12);
    expect(b.Pf / a.Pf).toBeCloseTo(1, 11);
    let dd = 0;
    for (let i = 0; i < a.D.length; i++) dd += Math.abs(b.D[i] - a.D[i]);
    expect(dd / coreDecay(a)).toBeLessThan(1e-9);
    // energy: one step's integral equals the sum of many small steps' (and a midpoint quadrature)
    const c = makeCore(0.3 * P0), d = makeCore(0.3 * P0);
    coreStep(c, P0, 0, 120);
    const Ec = c.out[CO_THERMAL_J];
    let Ed = 0, Ek = 0;
    for (let i = 0; i < 12000; i++) { coreStep(d, P0, 0, 0.01); Ed += d.out[CO_THERMAL_J]; Ek += d.out[CO_DECAY_J]; }
    expect(Math.abs(Ed / Ec - 1)).toBeLessThan(1e-8);
    void Ek;
  });

  it('DRIVE ARM standby: from hotel load to the 10 MW drive load, the drive bus carries 98 % after ≈ 2 min', () => {
    const c = makeCore(60e3 / REACTOR_ETA);
    coreStep(c, 60e3 / REACTOR_ETA, 0, 1e6);
    const RAMP = new Float64Array(2);
    const target = 10e6 + 60e3;
    let t = 0;
    while (coreElectric(c) - 60e3 < 0.98 * 10e6 && t < 1000) { coreAdvance(c, target, 0, 0.1, RAMP); t += 0.1; }
    console.log(`DRIVE ARM → drive bus 98 %: ${t.toFixed(1)} s (first-order τ = ${CORE_TAU} s; the old 2 %/s ramp took ≈ 18 s)`);
    expect(t).toBeGreaterThan(90); expect(t).toBeLessThan(140);
    expect(RAMP[1]).toBeCloseTo(coreElectric(c), 6);
    // the controller is step-size independent to second order: 0.1 s vs 30 s steps over 10 min
    const e = makeCore(60e3 / REACTOR_ETA), f = makeCore(60e3 / REACTOR_ETA);
    for (let i = 0; i < 6000; i++) coreAdvance(e, target, 0, 0.1, RAMP);
    for (let i = 0; i < 20; i++) coreAdvance(f, target, 0, 30, RAMP);
    console.log(`controller 0.1 s vs 30 s steps after 10 min: ${(coreElectric(f) / coreElectric(e) - 1).toExponential(2)}`);
    expect(Math.abs(coreElectric(f) / coreElectric(e) - 1)).toBeLessThan(1e-3);
  });

  it('save → load → step is bit-identical; loader defaults', () => {
    const a = makeCore(0);
    coreStep(a, P0, 0, 77.7);
    coreStep(a, 0, 1, 12.3);
    const b = loadCore(JSON.parse(JSON.stringify(saveCore(a))));
    for (let i = 0; i < 50; i++) { coreStep(a, 0, 1, 0.1); coreStep(b, 0, 1, 0.1); }
    expect(b.Pf).toBe(a.Pf);
    expect(Array.from(b.D)).toEqual(Array.from(a.D));
    const f = loadCore({ Pf: P0 });
    expect(coreThermal(f)).toBeCloseTo(P0, 0); // groups defaulted to their steady state
    expect(loadCore(null).Pf).toBe(0);
  });
});
