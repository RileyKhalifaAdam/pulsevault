// Cabin gas network (src/world/cabin.ts, src/data/cabinNet.ts): conservation, the orifice law, equalisation,
// the pinhole leak, airlock pump-down, stability at the warp step, determinism, save/load, the draught, cost.
import { describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { INTERIORS } from '../src/data/interiors';
import { BOUNDARY_SPACE, buildCabinNet, lumpedCabinNet, type CabinNetDef } from '../src/data/cabinNet';
import {
  C_STAR, MAX_GAS_STEP, R_STAR, compileCabin, draftAt, draftBound, expansionY, inventory, loadCabin, makeCabinIo,
  newCabin, orificeMassFlow, saveCabin, stepCabin, type CabinIo, type CabinNet, type CabinState,
} from '../src/world/cabin';
import {
  GAMMA, IN_CHX, IN_FANS, IN_H, IN_PUMP, IN_REG, IN_SCRUB, METAB_REF, MOLAR_MASS, OUT_CO2_MADE, OUT_CO2_SCRUBBED,
  OUT_H2O_MADE, OUT_O2_USED, OUT_VENT0, R_GAS, ROOM_STRIDE, S_CO2, S_H2O, S_O2,
} from '../src/world/life';

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
    expect(V).toBeCloseTo(314.8, 1); // minus the solids (racks, reactor, bunks, lockers …)
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
  it('the same pinhole in the Wren\'s cargo bay drains the whole ship (314.8 m³: ≈ 26 days), every species conserved', () => {
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
  it('every species is conserved to 1e-12 (gas + tank + films + condensate + sources − sinks), h = 0.1 and 10 s', () => {
    for (const e of runBooked(0.1, 36000)) expect(e).toBeLessThan(1e-12);
    for (const e of runBooked(10, 8640)) expect(e).toBeLessThan(1e-12);
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
  it('1× (h = 0.1 s) and warp (h = 10 s) agree over 6 h', () => {
    const a = busy(), b = busy();
    a.io.inp[IN_H] = 0.1; b.io.inp[IN_H] = 10;
    for (let n = 0; n < 6 * 36000; n++) stepCabin(a.net, a.st, a.io);
    for (let n = 0; n < 6 * 360; n++) stepCabin(b.net, b.st, b.io);
    for (let i = 0; i < a.net.nR; i++) {
      expect(Math.abs(b.io.ppCO2[i] / a.io.ppCO2[i] - 1)).toBeLessThan(0.02);
      expect(Math.abs(b.io.ppO2[i] / a.io.ppO2[i] - 1)).toBeLessThan(2e-3);
      expect(Math.abs(b.io.p[i] / a.io.p[i] - 1)).toBeLessThan(2e-3);
    }
    // the regulator is a split step: the ship's ppO₂ lags the setpoint by ≤ 10 Pa more at h = 10 s, so the tank
    // (6 kg injected against the venting pump) agrees to 1 %
    expect(Math.abs(b.st.o2Tank - a.st.o2Tank) / (100 - a.st.o2Tank)).toBeLessThan(0.01);
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
  });
  it('fans on: a real, constant field (≈ 0.2 m³/s per door, grille speed ~1 m/s); the epoch moves only on a real change', () => {
    const net = compileCabin(buildCabinNet(WREN));
    const st = newCabin(net), io = makeCabinIo(net);
    io.metab[roomIdx('cockpit')] = 150;
    io.inp[IN_H] = 0.1;
    stepCabin(net, st, io);
    expect(st.draftEpoch).toBe(1);
    for (let k = 0; k < net.nO; k++) expect(Math.abs(Math.abs(st.draftQ[k]) - 0.2)).toBeLessThan(2e-3);
    for (let n = 0; n < 36000; n++) stepCabin(net, st, io);
    io.inp[IN_H] = 10;
    for (let n = 0; n < 8640; n++) {
      if (n % 360 === 0) for (let i = 0; i < net.nR; i++) io.roomT[i] = 294 + ((n / 360) % 3); // thermal swings
      stepCabin(net, st, io);
    }
    expect(st.draftEpoch).toBe(1);
    const u = new Float64Array(3);
    const lounge = roomIdx('lounge');
    draftAt(net, st, lounge, 0, 0.2, -7.5, u);
    const um = Math.hypot(u[0], u[1], u[2]);
    expect(um).toBeGreaterThan(0.005);
    expect(um).toBeLessThan(0.3);
    expect(draftBound(net, st, lounge)).toBeGreaterThan(um);
    io.inp[IN_FANS] = 0; io.inp[IN_H] = 0.1;
    stepCabin(net, st, io);
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
      import { compileCabin, makeCabinIo, newCabin, stepCabin } from './src/world/cabin';
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
    for (const h of [0.1, 10]) {
      const us = B.run(h);
      console.log(`cabin step h=${h}: ${us.toFixed(2)} µs (10 rooms, 10 orifices, 9 fan ducts, 8 panes; best of 8)`);
      expect(us).toBeLessThan(20);
    }
  });
});
