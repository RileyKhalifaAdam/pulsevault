// Cabin gas network (src/world/cabin.ts, src/data/cabinNet.ts): conservation, the orifice law, equalisation,
// the pinhole leak, airlock pump-down, stability at the warp step, determinism, save/load, the draught, cost.
import { describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { INTERIORS } from '../src/data/interiors';
import { BOUNDARY_SPACE, DIFFUSER_U, buildCabinNet, lumpedCabinNet, unionVolInRoom, type CabinNetDef } from '../src/data/cabinNet';
import {
  BND_STRIDE, C_STAR, MAX_GAS_STEP, R_STAR, cabinSubsteps, compileCabin, draftAt, draftBound, expansionY, inventory, loadCabin,
  makeCabinIo, newCabin, orificeMassFlow, roomAirVel, saveCabin, stepCabin, stepCabinQuantum, type CabinIo, type CabinNet,
  type CabinState,
} from '../src/world/cabin';
import {
  GAMMA, IN_CHX, IN_FANS, IN_H, IN_PUMP, IN_REG, IN_SCRUB, METAB_REF, MOLAR_MASS, OUT_CO2_MADE, OUT_CO2_SCRUBBED,
  OUT_H2O_MADE, OUT_O2_USED, OUT_VENT0, R_GAS, ROOM_STRIDE, S_CO2, S_H2O, S_O2,
} from '../src/world/life';

/** The sleep-warp quantum q = 2¹¹·Q (§1.3). */
const QS = 2048 / 120;

const WREN = INTERIORS.wren!;
const roomIdx = (id: string): number => WREN.rooms.findIndex((r) => r.id === id);

/** A quiet ship: no crew, no life support, warm panes (only transport acts). */
function quiet(io: CabinIo): void {
  io.inp[IN_SCRUB] = 0; io.inp[IN_CHX] = 0; io.inp[IN_REG] = 0;
  io.metab.fill(0);
}
const totalMoles = (net: CabinNet, st: CabinState): number => {
  let n = 0;
  for (let i = 0; i < net.nR; i++) for (let s = 0; s < 4; s++) n += st.rooms[i * ROOM_STRIDE + s];
  return n;
};
const meanP = (net: CabinNet, st: CabinState): number => {
  let n = 0, v = 0;
  for (let i = 0; i < net.nR; i++) { for (let s = 0; s < 4; s++) n += st.rooms[i * ROOM_STRIDE + s]; v += net.V[i] / (R_GAS * st.rooms[i * ROOM_STRIDE + 4]); }
  return n / v;
};

describe('cabin network data', () => {
  it('rooms from the interior boxes minus solids; doors 2.1 m²', () => {
    const def = buildCabinNet(WREN);
    const V = def.rooms.reduce((a, r) => a + r.V, 0);
    const gross = WREN.rooms.reduce((a, r) => a + (r.box.max.x - r.box.min.x) * (r.box.max.y - r.box.min.y) * (r.box.max.z - r.box.min.z), 0);
    expect(gross).toBeCloseTo(370.5, 0); // the plan's 370.5 m³ is the gross box volume
    expect(V).toBeCloseTo(315.70, 2); // minus the UNION of the solids (racks, reactor, bunks, lockers …)
    // review D5: the sofa and its back overlap by 0.45 × 0.45 × 4.4 m and count once
    const lounge = def.rooms[roomIdx('lounge')];
    const lb = WREN.rooms[roomIdx('lounge')].box;
    const sum = WREN.solids.filter((x) => x.room === 'lounge').reduce((a, x) => a + (x.box.max.x - x.box.min.x) * (x.box.max.y - x.box.min.y) * (x.box.max.z - x.box.min.z), 0);
    const g = (lb.max.x - lb.min.x) * (lb.max.y - lb.min.y) * (lb.max.z - lb.min.z);
    expect(lounge.V - (g - sum)).toBeCloseTo(0.45 * 0.45 * 4.4, 9);
    const b = (x0: number, x1: number) => ({ min: { x: x0, y: 0, z: 0 }, max: { x: x1, y: 1, z: 1 } });
    expect(unionVolInRoom(b(0, 10), [b(1, 3), b(2, 4), b(2.5, 3.5), b(9, 12)])).toBeCloseTo(4, 12);
    expect(def.orifices[0].A).toBeCloseTo(2.1, 9);
    expect(def.ducts.filter((d) => d.group === 0).length).toBe(WREN.doors.length);
    expect(() => compileCabin(def)).not.toThrow();
  });
});

describe('orifice law', () => {
  it('choked flow is 239 kg/s per m² × C_d at 101 kPa, 293 K; continuous at r*; incompressible limit', () => {
    const Mair = 0.028965;
    expect(orificeMassFlow(1, 101325, 0, 293, Mair)).toBeCloseTo(239.3, 0);
    expect(C_STAR).toBeCloseTo(0.5787, 4);
    expect(R_STAR).toBeCloseTo(0.5283, 4);
    const pu = 1e5;
    const a = orificeMassFlow(1, pu, pu * R_STAR * (1 - 1e-9), 293, Mair), b = orificeMassFlow(1, pu, pu * R_STAR * (1 + 1e-9), 293, Mair);
    expect(Math.abs(a - b) / a).toBeLessThan(1e-6);
    const rho = pu * Mair / (R_GAS * 293);
    const dp = 50;
    expect(orificeMassFlow(1, pu, pu - dp, 293, Mair) / Math.sqrt(2 * rho * dp)).toBeCloseTo(1, 3);
    expect(expansionY(1)).toBe(1);
    expect(expansionY(R_STAR)).toBeCloseTo(0.705, 3);
  });
});

/** Two rooms joined by one orifice, no ducts, no diffusion. */
function twoRooms(V1: number, V2: number, A: number, Cd = 0.6): CabinNetDef {
  const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
  return {
    rooms: [{ id: 'a', V: V1, box }, { id: 'b', V: V2, box }],
    orifices: [{ id: 'o', a: 0, b: 1, A, Cd, pos: { x: 0, y: 0, z: 0 }, L: 0, open0: 1 }],
    ducts: [], panes: [], scrubberRoom: 0, chxRoom: 0, o2Room: 0,
  };
}

describe('equalisation through an orifice', () => {
  const T = 294;
  function run(V1: number, V2: number, A: number, dp0: number, dp1: number, h: number): { t: number; k: number; cons: number } {
    const net = compileCabin(twoRooms(V1, V2, A));
    const st = newCabin(net, T), io = makeCabinIo(net);
    quiet(io);
    // room a at +dp0 (same composition)
    const s = 1 + dp0 / 101325;
    for (let k = 0; k < 4; k++) st.rooms[k] *= s;
    const n0 = totalMoles(net, st);
    io.inp[IN_H] = h;
    const M = 0.02896;
    const rho = 101325 * M / (R_GAS * T);
    const kk = 0.6 * A * Math.sqrt(2 * rho) * (R_GAS * T / M) * (1 / V1 + 1 / V2);
    let t = 0, dpPrev = dp0;
    for (let n = 0; n < 1e7; n++) {
      stepCabin(net, st, io);
      const dp = io.p[0] - io.p[1];
      if (dp <= dp1) { t += h * (dpPrev - dp1) / (dpPrev - dp); break; } // linear in the last step
      t += h; dpPrev = dp;
    }
    return { t, k: kk, cons: Math.abs(totalMoles(net, st) - n0) / n0 };
  }
  it('a 1 cm² equalisation valve: t = 2(√Δp₀ − √Δp₁)/k', () => {
    const r = run(10.34, 32.83, 1e-4, 1000, 10, 0.1);
    const tA = 2 * (Math.sqrt(1000) - Math.sqrt(10)) / r.k;
    expect(tA).toBeGreaterThan(40);
    expect(Math.abs(r.t / tA - 1)).toBeLessThan(0.02);
    expect(r.cons).toBeLessThan(1e-14);
  });
  it('an open 2.1 m² door equalises 1 kPa between 50 m³ rooms in ≈ 10 ms', () => {
    const r = run(50, 50, 2.1, 1000, 10, 2e-5);
    const tA = 2 * (Math.sqrt(1000) - Math.sqrt(10)) / r.k;
    expect(tA).toBeGreaterThan(0.005);
    expect(tA).toBeLessThan(0.02);
    expect(Math.abs(r.t / tA - 1)).toBeLessThan(0.03);
  });
  it('h = 10 s across the open door: no overshoot, Δp keeps its sign and collapses within two steps', () => {
    const net = compileCabin(twoRooms(50, 50, 2.1));
    const st = newCabin(net, T), io = makeCabinIo(net);
    quiet(io);
    for (let k = 0; k < 4; k++) st.rooms[k] *= 1.05;
    io.inp[IN_H] = MAX_GAS_STEP;
    const dp0 = 0.05 * 101325;
    stepCabin(net, st, io);
    const dp1 = io.p[0] - io.p[1];
    expect(dp1).toBeGreaterThanOrEqual(0);
    expect(dp1).toBeLessThan(2e-3 * dp0); // the secant step from the start state: monotone, first order
    stepCabin(net, st, io);
    const dp2 = io.p[0] - io.p[1];
    expect(dp2).toBeGreaterThanOrEqual(0);
    expect(dp2).toBeLessThan(0.01);
  });
});

/** A lumped room of volume V with a hole of area A (C_d 0.7) to space. */
function leakyRoom(V: number, A: number): CabinNetDef {
  const def = lumpedCabinNet(V);
  def.orifices.push({ id: 'hole', a: 0, b: BOUNDARY_SPACE, A, Cd: 0.7, pos: { x: 0, y: 0, z: 0 }, L: 0, open0: 1 });
  return def;
}
const tauLeak = (V: number, CdA: number, T: number, M: number): number => V / (CdA * Math.sqrt(GAMMA * R_GAS * T / M) * C_STAR);

describe('pinhole leak', () => {
  it('a 1 mm² pinhole e-folds the plan\'s 370.5 m³ in ≈ 31 days (V/(C_d·A·c*)), at h = 10 s', () => {
    const net = compileCabin(leakyRoom(370.5, 1e-6));
    const st = newCabin(net, 293), io = makeCabinIo(net);
    quiet(io);
    io.roomT.fill(293);
    io.inp[IN_H] = 10;
    const p0 = meanP(net, st);
    const M = (st.rooms[0] * MOLAR_MASS[0] + st.rooms[1] * MOLAR_MASS[1] + st.rooms[2] * MOLAR_MASS[2] + st.rooms[3] * MOLAR_MASS[3]) / totalMoles(net, st);
    const days = 5;
    for (let n = 0; n < days * 8640; n++) stepCabin(net, st, io);
    const tau = days * 86400 / Math.log(p0 / meanP(net, st));
    const tA = tauLeak(370.5, 0.7e-6, 293, M);
    expect(Math.abs(tau / tA - 1)).toBeLessThan(1e-3);
    expect(tau / 86400).toBeGreaterThan(30);
    expect(tau / 86400).toBeLessThan(32);
  });
  it('the same pinhole in the Wren\'s cargo bay drains the whole ship (315.7 m³: ≈ 26 days), every species conserved', () => {
    const def = buildCabinNet(WREN, { extra: [{ id: 'pinhole', a: 'cargo', b: 'space', A: 1e-6, open0: 1 }] });
    const net = compileCabin(def);
    const st = newCabin(net, 293), io = makeCabinIo(net);
    quiet(io);
    io.roomT.fill(293);
    io.inp[IN_H] = 10;
    const p0 = meanP(net, st);
    const inv0 = new Float64Array(4), inv1 = new Float64Array(4), vent = new Float64Array(4);
    inventory(net, st, inv0);
    for (let n = 0; n < 2 * 8640; n++) {
      stepCabin(net, st, io);
      for (let s = 0; s < 4; s++) vent[s] += io.out[OUT_VENT0 + s];
    }
    inventory(net, st, inv1);
    for (let s = 0; s < 4; s++) expect(Math.abs(inv1[s] + vent[s] - inv0[s]) / inv0[s]).toBeLessThan(1e-12);
    const tau = 2 * 86400 / Math.log(p0 / meanP(net, st));
    const Vt = def.rooms.reduce((a, r) => a + r.V, 0);
    const tA = tauLeak(Vt, 0.7e-6, 293, 0.02896);
    expect(Math.abs(tau / tA - 1)).toBeLessThan(5e-3);
    expect(tau / 86400).toBeCloseTo(26.2, 0);
  });
});

describe('airlock pump-down', () => {
  it('the suit room (10.3 m³) to 2 kPa at S = 0.04 m³/s takes ln(p₀/p)·V/S ≈ 16.9 min', () => {
    const def = buildCabinNet(WREN, { pumps: [{ id: 'airlock', a: 'suitroom', b: 'corridor' }] });
    const net = compileCabin(def);
    const st = newCabin(net), io = makeCabinIo(net);
    quiet(io);
    const sr = roomIdx('suitroom');
    const door = WREN.doors.findIndex((d) => d.id === 'd-suitroom');
    io.open[door] = 0; // the inner door is shut (its fan duct closes with it)
    io.monitor[sr] = 0;
    io.inp[IN_PUMP] = 1;
    io.inp[IN_H] = 0.1;
    stepCabin(net, st, io);
    const p0 = io.p[sr];
    let t = 0.1, pPrev = p0;
    const n0 = totalMoles(net, st);
    while (io.p[sr] > 2000) { pPrev = io.p[sr]; stepCabin(net, st, io); t += 0.1; }
    t -= 0.1 * (2000 - io.p[sr]) / (pPrev - io.p[sr]);
    const tA = Math.log(p0 / 2000) * def.rooms[sr].V / 0.04 + 0.1;
    expect(Math.abs(t / tA - 1)).toBeLessThan(1e-3);
    expect(t / 60).toBeGreaterThan(16.5);
    expect(t / 60).toBeLessThan(17.3);
    expect(Math.abs(totalMoles(net, st) - n0) / n0).toBeLessThan(1e-12); // pumped into the corridor, not lost
  });
});

/** A busy Wren: crew, all life support, cold panes, a pinhole and the airlock pump running. */
function busy(): { net: CabinNet; st: CabinState; io: CabinIo } {
  const def = buildCabinNet(WREN, { extra: [{ id: 'pinhole', a: 'cargo', b: 'space', A: 1e-6, open0: 1 }], pumps: [{ id: 'airlock', a: 'suitroom', b: 'space', Q: 0.001 }] });
  const net = compileCabin(def);
  const st = newCabin(net), io = makeCabinIo(net);
  io.metab[roomIdx('cockpit')] = 150; io.metab[roomIdx('cabin-port')] = 80;
  io.paneT.fill(276);
  io.roomT.forEach((_, i) => (io.roomT[i] = 290 + i));
  io.inp[IN_PUMP] = 1;
  return { net, st, io };
}

describe('conservation, stability, determinism, save/load', () => {
  function runBooked(h: number, steps: number): number[] {
    const { net, st, io } = busy();
    io.inp[IN_H] = h;
    const inv0 = new Float64Array(4), inv1 = new Float64Array(4);
    inventory(net, st, inv0);
    const src = [0, 0, 0, 0];
    for (let n = 0; n < steps; n++) {
      stepCabin(net, st, io);
      src[S_O2] -= io.out[OUT_O2_USED] / MOLAR_MASS[S_O2];
      src[S_CO2] += io.out[OUT_CO2_MADE] / MOLAR_MASS[S_CO2] - io.out[OUT_CO2_SCRUBBED] / MOLAR_MASS[S_CO2];
      src[S_H2O] += io.out[OUT_H2O_MADE] / MOLAR_MASS[S_H2O];
      for (let s = 0; s < 4; s++) src[s] -= io.out[OUT_VENT0 + s];
    }
    inventory(net, st, inv1);
    return [0, 1, 2, 3].map((s) => Math.abs(inv1[s] - inv0[s] - src[s]) / inv0[s]);
  }
  it('every species is conserved to 1e-12 (gas + tank + films + condensate + sources − sinks), h = 0.1, 10 and 17 s', () => {
    for (const e of runBooked(0.1, 36000)) expect(e).toBeLessThan(1e-12);
    for (const e of runBooked(10, 8640)) expect(e).toBeLessThan(1e-12);
    for (const e of runBooked(QS, 5063)) expect(e).toBeLessThan(1e-12);
    // panes that fog and then EVAPORATE (review D1: the small-pane overdraw created water)
    for (const h of [0.1, 10, QS]) {
      const { net, st, io } = busy();
      io.inp[IN_H] = h;
      const inv0 = new Float64Array(4), inv1 = new Float64Array(4);
      inventory(net, st, inv0);
      let w = 0;
      const steps = Math.round((h < 1 ? 1 : 4) * 3600 / h); // (the kg tank and films round at ~1e-17 per add)
      for (let n = 0; n < steps; n++) {
        io.paneT.fill(n < steps / 2 ? 276 : 305);
        stepCabin(net, st, io);
        w += io.out[OUT_H2O_MADE] / MOLAR_MASS[S_H2O];
        for (let s2 = 0; s2 < 4; s2++) if (s2 === S_H2O) w -= io.out[OUT_VENT0 + s2];
      }
      inventory(net, st, inv1);
      expect(Math.abs(inv1[S_H2O] - inv0[S_H2O] - w) / inv0[S_H2O]).toBeLessThan(1e-12);
    }
  });
  it('stable at h = 10 s: a 0.01 m² breach empties the ship monotonically, no negative moles', () => {
    const def = buildCabinNet(WREN, { extra: [{ id: 'breach', a: 'lounge', b: 'space', A: 0.01, open0: 1 }] });
    const net = compileCabin(def);
    const st = newCabin(net), io = makeCabinIo(net);
    quiet(io); // (with the regulator open the tank holds the ship at its 58 Pa steady state until it is empty)
    io.inp[IN_H] = 10;
    let prev = meanP(net, st);
    for (let n = 0; n < 2000; n++) {
      stepCabin(net, st, io);
      const p = meanP(net, st);
      expect(p).toBeLessThanOrEqual(prev * (1 + 1e-12) + 1e-9);
      prev = p;
      for (let k = 0; k < st.rooms.length; k++) expect(st.rooms[k]).toBeGreaterThanOrEqual(0);
    }
    expect(prev).toBeLessThan(1e-3);
  });
  it('1× (h = 0.1 s) and warp (one step per 17.07 s sleep quantum) agree over 6 h', () => {
    expect(cabinSubsteps(QS)).toBe(1);
    expect(MAX_GAS_STEP).toBeGreaterThanOrEqual(QS);
    const a = busy();
    a.io.inp[IN_H] = 0.1;
    for (let n = 0; n < 6 * 36000; n++) stepCabin(a.net, a.st, a.io);
    for (const q of [10, QS, 2 * QS]) {
      const b = busy();
      const nq = Math.round(6 * 3600 / q);
      for (let n = 0; n < nq; n++) stepCabinQuantum(b.net, b.st, b.io, q);
      let worst = 0;
      for (let i = 0; i < a.net.nR; i++) {
        worst = Math.max(worst, Math.abs(b.io.ppCO2[i] / a.io.ppCO2[i] - 1));
        expect(Math.abs(b.io.ppO2[i] / a.io.ppO2[i] - 1)).toBeLessThan(2e-3);
        expect(Math.abs(b.io.p[i] / a.io.p[i] - 1)).toBeLessThan(2e-3);
      }
      console.log(`q = ${q.toFixed(2)} s (${cabinSubsteps(q)} step/quantum): worst-room ppCO₂ vs 1× after 6 h ${worst.toExponential(2)}`);
      expect(worst).toBeLessThan(q <= QS ? 5e-3 : 1e-2);
      // the regulator is a split step: the ship's ppO₂ lags the setpoint a little more at large h, so the tank
      // (6 kg injected against the venting pump) agrees to 1 %
      expect(Math.abs(b.st.o2Tank - a.st.o2Tank) / (100 - a.st.o2Tank)).toBeLessThan(0.01);
    }
  });
  it('stepCabinQuantum: sub-step amounts sum, means average, and the result equals hand-made sub-steps with ramped T', () => {
    const a = busy(), b = busy();
    const q = 4 * QS; // 4 sub-steps
    expect(cabinSubsteps(q)).toBe(4);
    for (let n = 0; n < 10; n++) {
      const T1 = Array.from(a.io.roomT, (_, i) => 290 + i + 0.2 * (n + 1));
      // a: by hand
      const T0 = Array.from({ length: a.net.nR }, (_, i) => a.st.rooms[i * ROOM_STRIDE + 4]);
      let o2 = 0;
      a.io.inp[IN_H] = q / 4;
      for (let j = 1; j <= 4; j++) {
        for (let i = 0; i < a.net.nR; i++) a.io.roomT[i] = j < 4 ? T0[i] + (T1[i] - T0[i]) * (j / 4) : T1[i];
        stepCabin(a.net, a.st, a.io);
        o2 += a.io.out[OUT_O2_USED];
      }
      for (let i = 0; i < b.net.nR; i++) b.io.roomT[i] = T1[i];
      stepCabinQuantum(b.net, b.st, b.io, q);
      expect(Array.from(b.st.rooms)).toEqual(Array.from(a.st.rooms));
      expect(Math.abs(b.io.out[OUT_O2_USED] - o2)).toBeLessThan(1e-15);
    }
  });
  it('deterministic and save → JSON → load → step is bit-identical', () => {
    const a = busy(), b = busy();
    a.io.inp[IN_H] = b.io.inp[IN_H] = 0.1;
    for (let n = 0; n < 5000; n++) { stepCabin(a.net, a.st, a.io); stepCabin(b.net, b.st, b.io); }
    expect(Array.from(a.st.rooms)).toEqual(Array.from(b.st.rooms));
    const saved = JSON.parse(JSON.stringify(saveCabin(a.st)));
    const c = busy();
    c.st = loadCabin(c.net, saved.cabin, saved.life);
    c.io.inp[IN_H] = a.io.inp[IN_H] = 10;
    for (let n = 0; n < 3000; n++) { stepCabin(a.net, a.st, a.io); stepCabin(c.net, c.st, c.io); }
    expect(JSON.stringify(saveCabin(c.st))).toBe(JSON.stringify(saveCabin(a.st)));
    // loader defaults for an old save
    const d = loadCabin(c.net, null, null);
    expect(d.o2Tank).toBe(100);
    expect(loadCabin(c.net, { rooms: [1, 2] }, {}).rooms.length).toBe(c.net.nR * ROOM_STRIDE);
  });
});

describe('boundaries', () => {
  it('review D8: a docked umbilical to boundary 1 (a station at 101.3 kPa) refills a 70 kPa room with station air', () => {
    const def = lumpedCabinNet(30);
    def.orifices.push({ id: 'umbilical', a: 0, b: -2, A: 5e-3, Cd: 0.6, pos: { x: 0, y: 0, z: 0 }, L: 0, open0: 1 });
    const net = compileCabin(def);
    expect(net.nB).toBe(2);
    const st = newCabin(net, 294), io = makeCabinIo(net);
    quiet(io);
    expect(io.bnd.length).toBe(2 * BND_STRIDE);
    for (let k = 0; k < 4; k++) st.rooms[k] *= 0.7;
    const j = BND_STRIDE; // boundary 1: p, T, then mole fractions N₂, O₂, CO₂, H₂O
    io.bnd[j] = 101325; io.bnd[j + 1] = 294; io.bnd[j + 2] = 0.78; io.bnd[j + 3] = 0.21; io.bnd[j + 4] = 0.0004; io.bnd[j + 5] = 0.0096;
    const n0 = totalMoles(net, st);
    io.inp[IN_H] = 0.1;
    let inflow = 0;
    for (let n = 0; n < 20000; n++) { stepCabin(net, st, io); for (let s = 0; s < 4; s++) inflow -= io.out[OUT_VENT0 + s]; }
    expect(Math.abs(io.p[0] / 101325 - 1)).toBeLessThan(1e-4);
    expect(totalMoles(net, st)).toBeGreaterThan(n0);
    // the space boundary (0) is untouched and still vacuum
    expect(io.bnd[0]).toBe(0);
    expect(buildCabinNet(WREN, { extra: [{ id: 'umb', a: 'suitroom', b: 'boundary:1', A: 5e-3 }] }).nBoundary).toBe(2);
    void inflow;
  });
});

describe('draught', () => {
  it('exactly zero with the fans off and the doors equalised (no wake for loose objects)', () => {
    const net = compileCabin(buildCabinNet(WREN));
    const st = newCabin(net), io = makeCabinIo(net);
    io.inp[IN_FANS] = 0;
    io.metab[roomIdx('lounge')] = METAB_REF;
    io.inp[IN_H] = 0.1;
    const u = new Float64Array(3);
    for (let n = 0; n < 3000; n++) {
      io.roomT[0] += 0.0005; // the thermal network warming the cockpit at 18 K/h (sun through the windows)
      stepCabin(net, st, io);
    }
    expect(Array.from(st.draftQ).every((q) => q === 0)).toBe(true);
    expect(st.draftEpoch).toBe(0);
    draftAt(net, st, roomIdx('lounge'), 0.5, 0, -7, u);
    expect([u[0], u[1], u[2]]).toEqual([0, 0, 0]);
    roomAirVel(net, st, roomIdx('lounge'), u);
    expect([u[0], u[1], u[2]]).toEqual([0, 0, 0]);
  });
  it('review D2: 1× and warp publish the same draught (thermal steps once per quantum, the gas ramps T)', () => {
    // fans off and fans on; the cockpit warming (window sun) or cooling at a steady rate, the rest constant
    for (const fans of [0, 1]) {
      for (const rate of [0.3, 1, -1, 4]) { // K/min (1.57e-3 m³/s of expansion per K/min out of the cockpit)
        const run = (q: number): CabinState => {
          const net = compileCabin(buildCabinNet(WREN));
          const st = newCabin(net), io = makeCabinIo(net);
          io.inp[IN_FANS] = fans;
          io.metab[roomIdx('lounge')] = 110;
          stepCabinQuantum(net, st, io, 0.1);
          const e0 = st.draftEpoch;
          const n = Math.round(Math.min(3600, 30 / Math.abs(rate) * 60) / q); // 1 h, or a 30 K swing
          for (let k = 0; k < n; k++) { io.roomT[0] = 294 + rate / 60 * q * (k + 1); stepCabinQuantum(net, st, io, q); }
          st.draftEpoch -= e0;
          return st;
        };
        const a = run(0.1);
        for (const q of [QS, 4 * QS]) {
          const b = run(q);
          // epochs: a real, changing expansion flow republishes on 5 % steps in both; never on every sub-step
          if (fans === 0) console.log(`fans off, cockpit ${rate} K/min, q ${q.toFixed(1)} s: draftEpoch 1× ${a.draftEpoch}, warp ${b.draftEpoch}`);
          expect(Math.abs(b.draftEpoch - a.draftEpoch)).toBeLessThanOrEqual(1);
          for (let k = 0; k < a.draftQ.length; k++) {
            expect(b.draftQ[k] === 0).toBe(a.draftQ[k] === 0);
            if (a.draftQ[k] !== 0) expect(Math.abs(b.draftQ[k] / a.draftQ[k] - 1)).toBeLessThan(0.11);
          }
        }
        if (rate === 1 && fans === 0) expect(a.draftEpoch).toBe(0); // below DRAFT_ON at 1×, and so under warp
      }
    }
  });
  it('fans on: 0.15 m/s along each supply → return column (W3-B item 7), a uniform mean ≈ 0.01 m/s; constant per epoch', () => {
    const def = buildCabinNet(WREN);
    const net = compileCabin(def);
    const st = newCabin(net), io = makeCabinIo(net);
    io.metab[roomIdx('cockpit')] = 150;
    io.inp[IN_H] = 0.1;
    stepCabin(net, st, io);
    expect(st.draftEpoch).toBe(1);
    for (let k = 0; k < net.nO; k++) expect(Math.abs(Math.abs(st.draftQ[k]) - 0.2)).toBeLessThan(2e-3);
    const u = new Float64Array(3), U = new Float64Array(3);
    for (const d of def.ducts) {
      const room = d.b;
      // on the jet axis, from the diffuser to 80 % of the way to the return door
      const door = def.orifices[d.gate].pos;
      const L = Math.hypot(door.x - d.jetPos.x, door.y - d.jetPos.y, door.z - d.jetPos.z);
      for (const f of [0.2, 0.5, 0.8]) {
        const s = f * L;
        draftAt(net, st, room, d.jetPos.x + s * d.jetDir.x, d.jetPos.y + s * d.jetDir.y, d.jetPos.z + s * d.jetDir.z, u);
        const along = u[0] * d.jetDir.x + u[1] * d.jetDir.y + u[2] * d.jetDir.z;
        expect(along).toBeGreaterThan(0.1);
        expect(along).toBeLessThan(0.25);
      }
      roomAirVel(net, st, room, U);
      const Um = Math.hypot(U[0], U[1], U[2]);
      expect(Um).toBeGreaterThan(1e-4);
      expect(Um).toBeLessThan(0.08); // Σ Q·Δx / V: the room-to-room ventilation cannot move the room's mean faster
      console.log(`${def.rooms[room].id}: V ${net.V[room].toFixed(1)} m³, |Ū| ${Um.toFixed(4)} m/s`);
      if (def.rooms[room].id === 'lounge' || def.rooms[room].id === 'cargo') expect(Um).toBeLessThan(0.02);
      expect(draftBound(net, st, room)).toBeGreaterThanOrEqual(DIFFUSER_U * 0.999);
    }
    // divergence theorem check of roomAirVel on a room whose only openings are one supply and one return
    const cp = roomIdx('cabin-port');
    roomAirVel(net, st, cp, U);
    const dPort = def.ducts.find((d) => d.b === cp)!, oPort = def.orifices[dPort.gate];
    const Q = st.draftQ[net.nO + def.ducts.indexOf(dPort)];
    const sgn = Math.sign(st.draftQ[dPort.gate]) * (oPort.b === cp ? -1 : 1); // the door's flow leaves cp
    expect(sgn).toBe(1);
    expect(U[2]).toBeCloseTo(Q * (oPort.pos.z - dPort.outPos.z) / net.V[cp], 3);
    // the field is constant over a day of warp with thermal swings; the epoch moves only on a real change
    for (let n = 0; n < 36000; n++) stepCabin(net, st, io);
    draftAt(net, st, roomIdx('lounge'), 0, 0.2, -7.5, U);
    for (let n = 0; n < 5063; n++) {
      if (n % 211 === 0) for (let i = 0; i < net.nR; i++) io.roomT[i] = 294 + ((n / 211) % 3);
      stepCabinQuantum(net, st, io, QS);
    }
    expect(st.draftEpoch).toBe(1);
    draftAt(net, st, roomIdx('lounge'), 0, 0.2, -7.5, u);
    expect([u[0], u[1], u[2]]).toEqual([U[0], U[1], U[2]]);
    io.inp[IN_FANS] = 0;
    stepCabinQuantum(net, st, io, 0.1);
    expect(st.draftEpoch).toBe(2);
    expect(Array.from(st.draftQ).every((q) => q === 0)).toBe(true);
  });
});

describe('cost', () => {
  // vitest's module transform turns every imported binding into a getter call, which slows this hot loop ~6×;
  // the shipped code is an esbuild bundle, so measure an esbuild bundle of the same source (plain node).
  it('µs per step (node, warmed, esbuild bundle): the Wren network at h = 0.1 s and 10 s', () => {
    const code = `
      import { INTERIORS } from './src/data/interiors';
      import { buildCabinNet } from './src/data/cabinNet';
      import { compileCabin, makeCabinIo, newCabin, stepCabin, stepCabinQuantum } from './src/world/cabin';
      export function run(h) {
        const def = buildCabinNet(INTERIORS.wren, { extra: [{ id: 'pinhole', a: 'cargo', b: 'space', A: 1e-6, open0: 1 }] });
        const net = compileCabin(def), st = newCabin(net), io = makeCabinIo(net);
        io.metab[0] = 150; io.metab[4] = 80; io.paneT.fill(280); io.inp[0] = h;
        for (let n = 0; n < 30000; n++) stepCabin(net, st, io);
        let best = 1e9;
        for (let r = 0; r < 8; r++) {
          const N = 20000, t0 = performance.now();
          for (let n = 0; n < N; n++) stepCabin(net, st, io);
          best = Math.min(best, ((performance.now() - t0) / N) * 1000);
        }
        return best;
      }`;
    const out = esbuild.buildSync({ stdin: { contents: code, resolveDir: (globalThis as unknown as { process: { cwd(): string } }).process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'iife', globalName: 'B', platform: 'node' });
    const B = new Function(`${out.outputFiles[0].text}; return B;`)() as { run(h: number): number };
    for (const h of [0.1, QS]) {
      const us = B.run(h);
      console.log(`cabin step h=${h.toFixed(2)}: ${us.toFixed(2)} µs (10 rooms, 10 orifices, 9 fan ducts, 8 panes; best of 8)`);
      if (h === QS) console.log(`sleep 1e4 @60 fps: ${(1e4 / 60 / QS).toFixed(2)} quanta/frame × 1 step = ${(us * 1e4 / 60 / QS).toFixed(1)} µs/frame node`);
      expect(us).toBeLessThan(20);
    }
    void stepCabinQuantum;
  });
});
