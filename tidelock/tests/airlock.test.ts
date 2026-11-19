// W3-B airlock (src/world/airlock.ts through compartments.ts): pump-down time against the closed form at 1× and under
// sleep-warp quanta (exact pump, no limitedBy while pumping), the dump to vacuum, repressurisation; and the docking
// tunnel: crack the hatch's equalisation valve, open the hatch.
import { describe, expect, it } from 'vitest';
import { AIRLOCK_K0, AIRLOCK_P_PUMPED, AIRLOCK_S0, buildWrenCompartments } from '../src/data/compartments';
import { compileCabin, makeCabinIo, newCabin } from '../src/world/cabin';
import { AL_IDLE, AL_PUMP, AL_VAC, A_CMD, A_PHASE, airlockPumpTime } from '../src/world/airlock';
import { compartmentsGas, compartmentsQuantum, compartmentsTick, compileCompartments, initTunnel, makeCompIo, makeCompartments, ventingLimit } from '../src/world/compartments';
import { D_S, DOOR_STRIDE, H_DOGCMD, H_TH, H_VALVE } from '../src/world/doors';
import { ROOM_STRIDE } from '../src/world/life';

const TH = new Float64Array(40).fill(294);
const RT0 = 24;
const QS = 2048 / 120;

function setup() {
  const comp = buildWrenCompartments();
  const net = compileCabin(comp.def);
  const cn = compileCompartments(comp, net);
  const st = newCabin(net);
  initTunnel(cn, st);
  const io = makeCabinIo(net);
  io.metab.fill(0); io.inp[3] = 0; io.inp[4] = 0; io.inp[5] = 0;
  const cs = makeCompartments(cn), cio = makeCompIo(cn);
  for (let k = 0; k < 5; k++) compartmentsGas(cn, cs, net, st, io, cio, TH, RT0, 0.1);
  return { comp, net, cn, st, io, cs, cio };
}

describe('airlock cycle', () => {
  it('pump-down to 2 kPa matches τ·ln((p0 − p_u)/(p − p_u)) at 1× and in sleep quanta (≈ 18 min); dump; repress', () => {
    const results: number[] = [];
    let V = 0, pOut = 0;
    for (const mode of ['1x', 'warp'] as const) {
      const s = setup();
      const A = s.comp.idx.airlock;
      V = s.net.V[A];
      s.cs.airlock[A_CMD] = 1;
      let t = 0, tPumpStart = -1, tPumped = -1, tVac = -1, limited = 0;
      const p0 = s.io.p[A];
      for (let n = 0; t < 3000 && tVac < 0; n++) {
        if (mode === '1x') {
          if (!compartmentsTick(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, RT0) && n % 12 === 0) compartmentsGas(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, RT0, 0.1);
          t += 1 / 120;
        } else {
          if (s.cs.airlock[A_PHASE] === AL_PUMP && ventingLimit(s.cs, QS) !== '') limited++;
          compartmentsQuantum(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, RT0, QS);
          t += QS;
        }
        const ph = s.cs.airlock[A_PHASE];
        if (tPumpStart < 0 && ph === AL_PUMP) tPumpStart = t;
        if (tPumped < 0 && ph > AL_PUMP) tPumped = t;
        if (ph === AL_VAC) tVac = t;
      }
      pOut = s.io.p[s.comp.idx.corridor];
      const exact = airlockPumpTime(V, p0, AIRLOCK_P_PUMPED, pOut);
      const step = mode === '1x' ? 0.1 : QS;
      const tp = tPumped - tPumpStart;
      console.log(`airlock ${mode}: V ${V.toFixed(2)} m³, τ ${(V / AIRLOCK_S0).toFixed(0)} s, p_u ${(pOut / AIRLOCK_K0).toFixed(0)} Pa; pump-down ${(tp / 60).toFixed(2)} min (closed form ${(exact / 60).toFixed(2)} min, ±1 step ${step.toFixed(2)} s); vacuum at ${(tVac / 60).toFixed(2)} min; quanta limited while pumping: ${limited}`);
      expect(Math.abs(tp - exact)).toBeLessThan(2 * step + 0.003 * exact);
      expect(limited).toBe(0);
      expect(s.io.p[A]).toBeLessThan(15);
      expect(s.cs.mech.door[s.cn.alDoor * DOOR_STRIDE + D_S]).toBe(0);
      results.push(tp);
      // repress through the door's valve, then the door opens
      s.cs.airlock[A_CMD] = -1;
      let tr = 0;
      for (let n = 0; n < 120 * 1200 && s.cs.airlock[A_PHASE] !== AL_IDLE; n++) {
        if (!compartmentsTick(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, RT0) && n % 12 === 0) compartmentsGas(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, RT0, 0.1);
        tr += 1 / 120;
      }
      for (let n = 0; n < 240; n++) compartmentsTick(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, RT0);
      console.log(`  repress through the 3 cm² door valve: ${(tr / 60).toFixed(1)} min; door open fraction ${s.io.open[s.cn.comp.doors[s.cn.alDoor].orifice].toFixed(2)}`);
      expect(s.cs.airlock[A_PHASE]).toBe(AL_IDLE);
      expect(s.io.open[s.cn.comp.doors[s.cn.alDoor].orifice]).toBeGreaterThan(0.9);
    }
    expect(Math.abs(results[0] - results[1]) / results[0]).toBeLessThan(0.02);
  });
});

describe('docking tunnel and hatch', () => {
  it('docked: the tunnel is vacuum; the hatch will not open; crack the valve, wait, open it; the station hatch follows', () => {
    const s = setup();
    const ix = s.comp.idx;
    s.cio.inp.docked = 1;
    s.cs.mech.hatch[H_DOGCMD] = 1;
    s.cio.inp.mech.pull = 40;
    const step = (sec: number) => {
      for (let n = 0; n < sec * 120; n++) if (!compartmentsTick(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, RT0) && n % 12 === 0) compartmentsGas(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, RT0, 0.1);
    };
    step(10);
    expect(s.io.p[ix.tunnel]).toBeLessThan(1);
    expect(s.cs.mech.hatch[H_TH]).toBe(0);
    s.cs.mech.hatch[H_VALVE] = 1;
    let t = 0;
    while (s.cs.mech.hatch[H_TH] === 0 && t < 1800) { step(1); t++; }
    console.log(`hatch valve: tunnel ${(s.io.p[ix.tunnel] / 1000).toFixed(2)} kPa, hatch swings after ${(t / 60).toFixed(1)} min; station hatch ${s.cs.stationHatch}`);
    expect(t).toBeGreaterThan(60); expect(t).toBeLessThan(400);
    step(60);
    expect(s.cs.mech.hatch[H_TH]).toBeGreaterThan(1);
    expect(s.cs.stationHatch).toBe(1);
    // undocking with the hatch open would vent the ship through the collar: the collar is a vent
    const n0 = s.st.rooms[ix.corridor * ROOM_STRIDE];
    s.cio.inp.docked = 0;
    step(1);
    expect(s.st.rooms[ix.corridor * ROOM_STRIDE]).toBeLessThan(n0);
    expect(s.cs.venting).toBe(1);
  });
});
