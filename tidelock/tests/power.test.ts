// Electrical system (src/world/power.ts, src/data/powerNet.ts) and master caution (src/world/caution.ts): W2-D items 2, 6.
import { describe, expect, it } from 'vitest';
import {
  BATT_E_CAP, BATT_R, BREAKER_TRIP_S, CIRCUITS, defaultDemand, DRIVE_P_ENGINE, L_AVIONICS, L_GALLEY, L_LIGHT0, LOADS, N_CIRCUITS,
  REACTOR_P_RATED, REACTOR_RAMP, SCRAM_RAMP, SETBACK_RAMP, STANDBY_MAX_S,
} from '../src/data/powerNet';
import { C_BATTERY, C_CO2, cautionAck, cautionStep, loadCaution, makeCautionState, makeCautionValues, saveCaution } from '../src/world/caution';
import { loadPower, makePowerInputs, makePowerOut, makePowerState, powerStep, savePower, vocOf, type PowerInputs, type PowerOut, type PowerState } from '../src/world/power';
import { makeShipSystems, makeSystemsInputs, makeSystemsState, systemsStep } from '../src/world/shipSystems';

function setup(reactor = 0): { st: PowerState; inp: PowerInputs; o: PowerOut } {
  const st = makePowerState(), inp = makePowerInputs(), o = makePowerOut();
  defaultDemand(inp.demand);
  st.reactorSet = reactor;
  return { st, inp, o };
}

function energyCloses(o: PowerOut): void {
  let loads = 0;
  for (let l = 0; l < LOADS.length; l++) loads += o.delivered[l];
  for (let c = 0; c < N_CIRCUITS; c++) loads += o.faultJ[c];
  const lhs = o.battJ + o.convJ, rhs = loads + o.battLossJ;
  expect(Math.abs(lhs - rhs)).toBeLessThan(1e-9 * (Math.abs(lhs) + Math.abs(rhs)) + 1e-9);
}

describe('hotel bus', () => {
  it('battery only: V = V_oc − I·R_i, energy closes, SOC falls by exactly the internal energy', () => {
    const { st, inp, o } = setup(0);
    const soc0 = st.soc;
    powerStep(st, inp, o, 1);
    expect(o.V).toBeLessThan(vocOf(soc0));
    // solved at the mid-interval SOC (second order in the V_oc feedback)
    expect(o.V).toBeCloseTo(vocOf(0.5 * (soc0 + st.soc)) - o.Ibatt * BATT_R, 6);
    energyCloses(o);
    expect((soc0 - st.soc) * BATT_E_CAP).toBeCloseTo(o.battJ, 6);
  });

  it('SOC (midpoint rule, second order): one 30 s step equals 300 steps of 0.1 s to 1e-8 of ΔSOC', () => {
    const a = setup(0), b = setup(0);
    powerStep(a.st, a.inp, a.o, 30);
    for (let k = 0; k < 300; k++) powerStep(b.st, b.inp, b.o, 0.1);
    const d = 0.8 - a.st.soc;
    console.log(`ΔSOC over 30 s: ${d.toExponential(6)}; |1 step − 300 steps| / ΔSOC = ${(Math.abs(a.st.soc - b.st.soc) / d).toExponential(2)}`);
    expect(Math.abs(a.st.soc - b.st.soc)).toBeLessThan(1e-8 * d);
  });

  it('a long powerStep sub-steps itself: one 3600 s call matches 0.1 s steps to 1e-9 of ΔSOC (review D9)', () => {
    const run = (h: number, T: number, soc0: number): number => {
      const { st, inp, o } = setup(0);
      inp.demand[L_GALLEY] = 1; st.soc = soc0;
      for (let k = 0; k < Math.round(T / h); k++) powerStep(st, inp, o, h);
      return st.soc;
    };
    for (const soc0 of [0.8, 0.3]) {
      const ref = run(0.1, 3600, soc0), one = run(3600, 3600, soc0), w30 = run(30, 3600, soc0);
      const e1 = Math.abs(one - ref) / (soc0 - ref), e30 = Math.abs(w30 - ref) / (soc0 - ref);
      console.log(`D9: SOC ${soc0} over 1 h: rel. error of ΔSOC, one 3600 s call ${e1.toExponential(1)}, 30 s steps ${e30.toExponential(1)}`);
      expect(e1).toBeLessThan(1e-9); expect(e30).toBeLessThan(1e-9);
    }
    // near empty: the trajectory, not the step-counted empty time, is what must agree (empty at 1460.2 s)
    const a = run(0.1, 1440, 0.05), b = run(30, 1440, 0.05), c = run(1440, 1440, 0.05);
    expect(Math.abs(a - b)).toBeLessThan(1e-9); expect(Math.abs(a - c)).toBeLessThan(1e-9);
    expect(a).toBeGreaterThan(0);
  });

  it('the battery runs empty exactly at its energy and the bus then sheds load (electronics trip below 100 V)', () => {
    const { st, inp, o } = setup(0);
    st.soc = 0.001;
    inp.demand[L_GALLEY] = 1;
    powerStep(st, inp, o, 3600);
    expect(st.soc).toBe(0);
    expect(o.battJ).toBeCloseTo(0.001 * BATT_E_CAP, 3);
    expect(o.segments).toBeGreaterThan(1);
    powerStep(st, inp, o, 1);
    expect(o.V).toBe(0);
    expect(st.breakers[2]).toBe(0); // avionics (electronics) latched off
    expect(st.tripped & (1 << 2)).not.toBe(0);
  });

  it('the reactor carries the hotel load and charges the battery; lamps follow V^1.5', () => {
    const { st, inp, o } = setup(1);
    st.soc = 0.5;
    for (let k = 0; k < 50; k++) powerStep(st, inp, o, 0.1);
    expect(o.Ibatt).toBeLessThan(0); // charging
    expect(st.soc).toBeGreaterThan(0.5);
    expect(o.V).toBeGreaterThan(vocOf(st.soc));
    expect(o.lampScale).toBeCloseTo(Math.pow(o.V / 120, 1.5), 12);
    energyCloses(o);
  });
});

describe('breakers', () => {
  it('trip on I²t at exactly 5 s·I_r²/(I² − I_r²), inside a long step', () => {
    for (const h of [30, 0.1]) {
      const { st, inp, o } = setup(1);
      for (let k = 0; k < 100; k++) powerStep(st, inp, o, 0.1); // reactor up, bus regulated
      const c = 7; // utility, 15 A
      inp.demand[L_GALLEY] = 0;
      const V = o.V, Ir = CIRCUITS[c].rating;
      inp.fault[c] = (2 * Ir) / V; // a short drawing 2·I_r at the regulated voltage
      const tTrip = (BREAKER_TRIP_S * Ir * Ir) / (4 * Ir * Ir - Ir * Ir);
      let t = 0, fJ = 0;
      while (st.breakers[c] === 1 && t < 60) { powerStep(st, inp, o, h); t += h; fJ += o.faultJ[c]; }
      expect(st.breakers[c]).toBe(0);
      expect(o.newTrips & (1 << c)).not.toBe(0);
      // the fault drew 2·I_r·V for exactly tTrip seconds
      expect(fJ).toBeCloseTo(inp.fault[c] * V * V * tTrip, 0);
      if (h === 30) expect(t).toBe(30);
      else expect(Math.abs(t - tTrip)).toBeLessThan(0.1 + 1e-9);
      // pushed back in with the short gone: the trip flag clears
      inp.fault[c] = 0; st.breakers[c] = 1;
      powerStep(st, inp, o, 0.1);
      expect(st.tripped & (1 << c)).toBe(0);
    }
  });

  it('a pulled breaker drops its loads', () => {
    const { st, inp, o } = setup(0);
    st.breakers[0] = 0;
    powerStep(st, inp, o, 1);
    expect(o.delivered[L_LIGHT0]).toBe(0);
    expect(o.delivered[L_AVIONICS]).toBeGreaterThan(0);
  });
});

describe('reactor and drive bus', () => {
  it('DRIVE ARM is drive standby: ready only once the reactor carries 2 × 5 MW (≈ 18 s at 2 %/s)', () => {
    const { st, inp, o } = setup(1);
    inp.driveArmed = 1;
    let t = 0;
    while (!o.driveReady && t < 60) { powerStep(st, inp, o, 0.1); t += 0.1; }
    const expectT = (0.98 * 2 * DRIVE_P_ENGINE) / (REACTOR_RAMP * REACTOR_P_RATED);
    expect(Math.abs(t - expectT)).toBeLessThan(0.2);
    expect(o.reactorWasteJ).toBeGreaterThan(0);
    expect(o.shuntJ).toBeGreaterThan(0); // armed but not lit: the standby output is dumped
  });

  it('the ramp is exact at any step size', () => {
    const a = setup(1), b = setup(1);
    for (const x of [a, b]) { x.inp.driveArmed = 1; x.inp.demand.fill(0); x.st.soc = 1; }
    powerStep(a.st, a.inp, a.o, 30);
    let E = 0;
    for (let k = 0; k < 300; k++) { powerStep(b.st, b.inp, b.o, 0.1); E += b.o.reactorAvg * 0.1; }
    expect(a.st.reactorP).toBe(b.st.reactorP);
    expect(Math.abs(a.o.reactorAvg * 30 - E)).toBeLessThan(1e-9 * E);
  });

  it('the standby lapses after STANDBY_MAX_S, exactly inside a long step (two-piece ramp)', () => {
    const a = setup(1), b = setup(1);
    for (const x of [a, b]) { x.inp.driveArmed = 1; x.inp.demand.fill(0); x.st.soc = 1; }
    let E = 0;
    for (let k = 0; k < 1000; k++) { powerStep(a.st, a.inp, a.o, 0.1); E += a.o.reactorAvg * 0.1; }
    powerStep(b.st, b.inp, b.o, 100);
    expect(a.st.standbyS).toBe(STANDBY_MAX_S);
    expect(a.o.standby).toBe(false);
    expect(Math.abs(b.st.reactorP - a.st.reactorP)).toBeLessThan(1e-6 * REACTOR_P_RATED);
    expect(Math.abs(b.o.reactorAvg * 100 - E)).toBeLessThan(1e-9 * E);
    // peak = ramp for 60 s at 2 %/s (33.6 MW > 10 MW: reached at 17.9 s), then down at 2 %/s for 40 s
    const P = Math.max(0, 2 * DRIVE_P_ENGINE - REACTOR_RAMP * REACTOR_P_RATED * 40);
    expect(Math.abs(a.st.reactorP - P)).toBeLessThan(1e3);
  });

  it('the interlock sets the reactor back at SETBACK_RAMP; a scram drives it to zero at SCRAM_RAMP and blocks the drive', () => {
    const { st, inp, o } = setup(1);
    inp.driveArmed = 1; inp.demand.fill(0); st.soc = 1;
    for (let k = 0; k < 300; k++) powerStep(st, inp, o, 0.1);
    expect(o.driveReady).toBe(true);
    const P0 = st.reactorP;
    inp.inhibit = 1;
    powerStep(st, inp, o, 1);
    expect(o.driveReady).toBe(false);
    expect(P0 - st.reactorP).toBeCloseTo(SETBACK_RAMP * REACTOR_P_RATED, 3);
    inp.inhibit = 0; st.scram = 1;
    powerStep(st, inp, o, 0.1);
    expect(st.reactorP).toBe(Math.max(0, P0 - SETBACK_RAMP * REACTOR_P_RATED - SCRAM_RAMP * REACTOR_P_RATED * 0.1));
    powerStep(st, inp, o, 1);
    expect(st.reactorP).toBe(0);
    expect(o.driveReady).toBe(false);
  });

  it('non-finite inputs read as zero; h ≤ 0 is a no-op', () => {
    const { st, inp, o } = setup(1);
    inp.demand[L_GALLEY] = NaN; inp.demand[L_AVIONICS] = Infinity; inp.fault[3] = NaN; inp.lit = NaN; inp.driveArmed = NaN;
    for (let k = 0; k < 10; k++) powerStep(st, inp, o, 0.1);
    expect(Number.isFinite(st.soc) && Number.isFinite(o.V) && Number.isFinite(st.reactorP)).toBe(true);
    const before = JSON.stringify(savePower(st));
    powerStep(st, inp, o, 0); powerStep(st, inp, o, NaN); powerStep(st, inp, o, -5);
    expect(JSON.stringify(savePower(st))).toBe(before);
  });

  it('with the reactor lever down the drive never becomes ready', () => {
    const { st, inp, o } = setup(0);
    inp.driveArmed = 1;
    for (let k = 0; k < 100; k++) powerStep(st, inp, o, 1);
    expect(o.driveReady).toBe(false);
  });
});

describe('state', () => {
  it('save → load → step is bit-identical; the loader fills defaults', () => {
    const run = (saveAt: number): number[] => {
      let { st, inp, o } = setup(1);
      for (let k = 0; k < 500; k++) {
        if (k === saveAt) st = loadPower(JSON.parse(JSON.stringify(savePower(st))));
        inp.driveArmed = k > 100 ? 1 : 0;
        inp.fault[3] = k > 200 && k < 260 ? 0.5 : 0;
        if (k === 300) st.breakers[3] = 1;
        powerStep(st, inp, o, k % 3 ? 0.1 : 17);
      }
      return [st.soc, st.reactorP, ...st.i2t, ...st.breakers, st.tripped, st.standbyS, st.scram];
    };
    const a = run(-1), b = run(230);
    expect(b).toEqual(a);
    const d = loadPower({ soc: 0.3 });
    expect(d.soc).toBe(0.3);
    expect(d.breakers).toEqual(new Array(N_CIRCUITS).fill(1));
    expect(loadPower(null).reactorSet).toBe(1);
  });

  it('costs well under a µs per step', () => {
    const { st, inp, o } = setup(1);
    for (let k = 0; k < 20000; k++) powerStep(st, inp, o, 0.1);
    const N = 200000, t0 = performance.now();
    for (let k = 0; k < N; k++) powerStep(st, inp, o, 0.1);
    const us = ((performance.now() - t0) / N) * 1000;
    console.log(`powerStep: ${us.toFixed(2)} µs`);
    expect(us).toBeLessThan(20);
  });
});

describe('master caution', () => {
  it('latches with hysteresis, wakes on a new condition, acknowledges', () => {
    const cs = makeCautionState(), v = makeCautionValues();
    expect(cautionStep(cs, v)).toBe(0);
    v[C_BATTERY] = 0.19;
    expect(cautionStep(cs, v)).toBe(1 << C_BATTERY);
    expect(cs.lamp).toBe(true);
    v[C_BATTERY] = 0.21; // inside the band: still active, no new wake
    expect(cautionStep(cs, v)).toBe(0);
    expect(cs.active & (1 << C_BATTERY)).not.toBe(0);
    cautionAck(cs);
    expect(cs.lamp).toBe(false);
    v[C_BATTERY] = 0.19;
    expect(cautionStep(cs, v)).toBe(0); // still the same episode
    v[C_BATTERY] = 0.25; cautionStep(cs, v);
    v[C_BATTERY] = 0.19;
    expect(cautionStep(cs, v)).toBe(1 << C_BATTERY); // recurs: wakes again
    v[C_CO2] = 1200;
    expect(cautionStep(cs, v)).toBe(1 << C_CO2);
    expect(loadCaution(JSON.parse(JSON.stringify(saveCaution(cs))))).toEqual(cs);
  });

  it('a breaker trip in the ship systems step wakes the sleeper', () => {
    const sys = makeShipSystems(), st = makeSystemsState(), inp = makeSystemsInputs();
    defaultDemand(inp.power.demand);
    for (let k = 0; k < 20; k++) systemsStep(sys, st, inp, 0.1);
    expect(sys.wake).toBe(0);
    inp.power.fault[4] = 1; // a hard short on LIFE SUP
    let woke = 0;
    for (let k = 0; k < 100 && !woke; k++) { systemsStep(sys, st, inp, 0.1); woke = sys.wake; }
    expect(woke).not.toBe(0);
    expect(st.power.breakers[4]).toBe(0);
    expect(st.caution.lamp).toBe(true);
  });
});
