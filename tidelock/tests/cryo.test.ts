// W3-B cryogenics and dumps (src/world/cryo.ts) and TPS ablation (src/world/ablation.ts).
import { describe, expect, it } from 'vitest';
import {
  COOLER_Q_MAX, coolerPower, cryoStep, DUMP_RATE, DUMP_START, DUMP_STOP, LH2_HFG, loadCryo, makeCryoInputs, makeCryoOut, makeCryoState,
  P_RELIEF, Q_LEAK, saveCryo, T_RELIEF, T_SET, tankPressure,
} from '../src/world/cryo';
import { makeVentState, VENT_BOIL, VENT_DUMP, ventConsume, ventPublish, ventTotal } from '../src/world/vent';
import { ablateStep, applyTps, compileTps, H_EFF, loadTps, makeTps, makeTpsOut, T_ABL } from '../src/world/ablation';
import { compileThermal, storedHeat } from '../src/world/thermal';
import { WREN_THERMAL, N_TPS_BF } from '../src/data/thermalNet';
import { Z_BELLY_FWD as ZBF } from '../src/data/hullZones';

describe('LH2 boil-off', () => {
  it('uncooled: relief after ≈ 14 h, then boil-off = Q/h_fg = 9.7 kg/day; the vent pair nets ≈ 1e-3 N', () => {
    expect(Q_LEAK).toBe(50);
    expect(Q_LEAK / LH2_HFG * 86400).toBeCloseTo(9.69, 2);
    expect(tankPressure(T_RELIEF) / P_RELIEF).toBeCloseTo(1, 9);
    const cs = makeCryoState(), inp = makeCryoInputs(), o = makeCryoOut(), v = makeVentState();
    inp.coolerOn = 0;
    let t = 0, tRelief = -1, boil = 0;
    for (; t < 3 * 86400; t += 60) {
      cryoStep(cs, inp, o, v, 60);
      ventPublish(v, VENT_BOIL, 60);
      if (tRelief < 0 && o.reliefOpened) tRelief = t;
      if (tRelief >= 0) boil += o.boilKg;
    }
    const day = (3 * 86400 - tRelief) / 86400;
    const tot = { F: { x: 0, y: 0, z: 0 }, tau: { x: 0, y: 0, z: 0 }, mdot: 0 };
    ventTotal(v, tot);
    console.log(`LH2: relief after ${(tRelief / 3600).toFixed(1)} h; boil-off ${(boil / day).toFixed(2)} kg/day; vent net F ${(tot.F.x * 1000).toFixed(2)} mN, ṁ ${tot.mdot.toExponential(2)} kg/s, a ≈ ${(Math.abs(tot.F.x) / 67e3).toExponential(1)} m/s²`);
    expect(tRelief / 3600).toBeGreaterThan(10); expect(tRelief / 3600).toBeLessThan(20);
    expect(boil / day).toBeCloseTo(Q_LEAK / LH2_HFG * 86400, 1);
    expect(Math.abs(tot.F.x)).toBeGreaterThan(3e-4); expect(Math.abs(tot.F.x)).toBeLessThan(2e-3);
    expect(Math.abs(tot.F.y) + Math.abs(tot.F.z)).toBeLessThan(1e-12);
  });

  it('cooled: no boil-off, ≈ 4.6 kW on the bus; after an outage it pulls down at its 75 W full lift (≈ 29 h from relief); exact at any step', () => {
    const cs = makeCryoState(), inp = makeCryoInputs(), o = makeCryoOut(), v = makeVentState();
    cryoStep(cs, inp, o, v, 10);
    console.log(`cooler: ${(o.coolerW / 1000).toFixed(2)} kW to lift ${Q_LEAK} W at ${T_SET} K`);
    expect(o.coolerW / 1000).toBeGreaterThan(4.3); expect(o.coolerW / 1000).toBeLessThan(4.9);
    expect(o.boilKg).toBe(0);
    // 30 h outage, then the cooler again: one big step equals many small ones (piecewise linear, events split)
    const a = makeCryoState(), b = makeCryoState();
    inp.coolerOn = 0;
    cryoStep(a, inp, o, v, 30 * 3600); const boilA = o.boilKg;
    let boilB = 0;
    for (let i = 0; i < 30 * 36; i++) { cryoStep(b, inp, o, v, 100); boilB += o.boilKg; }
    expect(a.T).toBeCloseTo(b.T, 12);
    expect(boilA / boilB).toBeCloseTo(1, 9);
    inp.coolerOn = 1;
    cryoStep(a, inp, o, v, 3600 * 40); const EA = o.coolerW * 3600 * 40;
    let EB = 0;
    for (let i = 0; i < 14400; i++) { cryoStep(b, inp, o, v, 10); EB += o.coolerW * 10; }
    expect(a.T).toBe(T_SET); expect(b.T).toBe(T_SET);
    expect(EA / EB).toBeCloseTo(1, 9); // the cooler's energy is the exact integral along the linear T(t)
    void COOLER_Q_MAX; void coolerPower;
  });

  it('condensate dump: starts at 2 kg, 5 g/s to 0.05 kg, through the ventral nozzle; save/load', () => {
    const cs = makeCryoState(), inp = makeCryoInputs(), o = makeCryoOut(), v = makeVentState();
    inp.condensate = DUMP_START - 0.01;
    cryoStep(cs, inp, o, v, 1);
    expect(o.dumpKg).toBe(0);
    inp.condensate = DUMP_START;
    let t = 0, dumped = 0;
    while (t < 2000) {
      cryoStep(cs, inp, o, v, 1);
      inp.condensate -= o.dumpKg; dumped += o.dumpKg; t++;
      if (cs.dumping === 0) break;
    }
    expect(inp.condensate).toBeCloseTo(DUMP_STOP, 9);
    expect(t).toBeCloseTo((DUMP_START - DUMP_STOP) / DUMP_RATE, -1);
    ventPublish(v, VENT_DUMP, 1);
    const J = new Float64Array(7);
    ventConsume(v, J);
    expect(J[6]).toBeCloseTo(dumped, 9);
    expect(J[1]).toBeGreaterThan(0); // dumped downward (−y): the ship is pushed +y
    const c2 = loadCryo(JSON.parse(JSON.stringify(saveCryo(cs))));
    expect(c2).toEqual(cs);
  });
});

describe('TPS ablation', () => {
  it('above 800 K the excess heat ablates at 20 MJ/kg: energy exact; the spent zone takes the substrate limit', () => {
    const net = compileThermal(WREN_THERMAL);
    const tn = compileTps(net);
    const tps = makeTps(tn);
    console.log(`TPS: ${tps.map((m) => m.toFixed(0)).join(' / ')} kg (${((tps[0] + tps[1]) * H_EFF / 1e9).toFixed(1)} GJ of ablation)`);
    const T = WREN_THERMAL.nodes.map((n) => n.T0);
    const o = makeTpsOut(tn);
    T[N_TPS_BF] = 1000;
    const E0 = storedHeat(net, T);
    ablateStep(tn, net, T, tps, o);
    expect(T[N_TPS_BF]).toBeCloseTo(T_ABL, 9);
    expect(o.ablatedKg).toBeGreaterThan(0);
    const E1 = storedHeat(net, T);
    expect((E0 - E1) / (o.latentJ + o.sensibleJ) - 1).toBeLessThan(1e-9);
    // spend it all
    T[N_TPS_BF] = 1e6;
    ablateStep(tn, net, T, tps, o);
    expect(tps[0]).toBe(0);
    expect(net.limit[N_TPS_BF]).toBe(net.limit[ZBF]);
    // loader defaults and re-application
    const t2 = loadTps(tn, JSON.parse(JSON.stringify(tps)));
    applyTps(tn, net, t2);
    expect(t2[0]).toBe(0);
    expect(loadTps(tn, null)).toEqual(makeTps(tn));
  });
});
