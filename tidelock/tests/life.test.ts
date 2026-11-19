// Life support (src/world/life.ts through src/world/cabin.ts stepCabin): metabolic rates, the regulator, the
// scrubber and CHX steady states, fog on cold panes, the saturation table, the caution conditions.
import { describe, expect, it } from 'vitest';
import { INTERIORS } from '../src/data/interiors';
import { BOUNDARY_SPACE, buildCabinNet, lumpedCabinNet, type CabinNetDef } from '../src/data/cabinNet';
import { compileCabin, inventory, loadCabin, makeCabinIo, newCabin, saveCabin, stepCabin, type CabinIo, type CabinNet, type CabinState } from '../src/world/cabin';
import {
  CABIN_CAUTIONS, CHX_ETA, CHX_Q, FOG_FULL, H2O_KG_DAY, H_CONV_FAN, H_FG, IN_CHX, IN_FANS, IN_H, IN_REG, IN_SCRUB, METAB_REF,
  METAB_SLEEP, MOLAR_MASS, O2_TANK_FULL, OUT_CHX_HEAT, OUT_CO2_MADE, OUT_DEPRESS_MIN, OUT_H2O_MADE, OUT_HYPOXIA, OUT_O2_INJECTED,
  OUT_O2_USED, OUT_PPCO2_MAX, OUT_PPO2_MIN, OUT_P_MIN, PPO2_SET, RHO_CP_AIR, ROOM_STRIDE, R_GAS, SCRUB_ETA, SCRUB_Q,
  SENSIBLE_FRAC, S_CO2, S_H2O, S_O2, cSat, dewPoint, fogFraction, psat,
} from '../src/world/life';
import { CAUTIONS, C_CO2, C_O2, type CautionDef } from '../src/world/caution';

/** caution.ts's latch rule for one CautionDef (active past `on`, inactive again only past `off`). */
const latch = (d: CautionDef, active: boolean, v: number): boolean =>
  d.dir > 0 ? (active ? !(v < d.off) : v > d.on) : (active ? !(v > d.off) : v < d.on);
const cab = (id: string): CautionDef => CABIN_CAUTIONS.find((c) => c.id === id)!;

const WREN = INTERIORS.wren!;
const roomIdx = (id: string): number => WREN.rooms.findIndex((r) => r.id === id);
const DAY = 86400;

function lumped(V: number, T = 293.15): { net: CabinNet; st: CabinState; io: CabinIo } {
  const net = compileCabin(lumpedCabinNet(V));
  const st = newCabin(net, T), io = makeCabinIo(net);
  io.roomT.fill(T); io.paneT.fill(T);
  return { net, st, io };
}
const off = (io: CabinIo): void => { io.inp[IN_SCRUB] = 0; io.inp[IN_CHX] = 0; io.inp[IN_REG] = 0; };

describe('saturation table', () => {
  it('psat matches Buck at 0 and 20 °C; dewPoint inverts it without a log', () => {
    expect(Math.abs(psat(273.15) / 611.2 - 1)).toBeLessThan(2e-3); // the 0.5 K table straddles the ice/water switch
    expect(Math.abs(psat(293.15) / 2338.8 - 1)).toBeLessThan(5e-3);
    for (let T = 200; T <= 380; T += 7.3) expect(Math.abs(dewPoint(psat(T)) - T)).toBeLessThan(1e-3);
    expect(cSat(293.15)).toBeCloseTo(psat(293.15) / (R_GAS * 293.15), 12);
  });
});

describe('metabolism at the real rates', () => {
  it('one crew member at 136.8 W: 0.84 kg O₂, 1.0 kg CO₂, 2.0 kg H₂O per day; CO₂ +149 Pa/day, O₂ −173 Pa/day in 370.5 m³', () => {
    const { net, st, io } = lumped(370.5);
    off(io);
    io.metab[0] = METAB_REF;
    io.inp[IN_H] = 10;
    const pco2 = st.rooms[S_CO2] * R_GAS * 293.15 / 370.5, po2 = st.rooms[S_O2] * R_GAS * 293.15 / 370.5;
    let o2 = 0, co2 = 0, w = 0;
    for (let n = 0; n < DAY / 10; n++) {
      stepCabin(net, st, io);
      o2 += io.out[OUT_O2_USED]; co2 += io.out[OUT_CO2_MADE]; w += io.out[OUT_H2O_MADE];
    }
    expect(o2).toBeCloseTo(0.84, 9);
    expect(co2).toBeCloseTo(1.0, 9);
    expect(w).toBeCloseTo(H2O_KG_DAY, 9);
    expect(io.ppCO2[0] - pco2).toBeCloseTo(149.5, 0);
    expect(po2 - io.ppO2[0]).toBeCloseTo(172.6, 0);
    // sensible heat to the room air: metabolic minus the latent heat leaving as vapour
    expect(io.roomHeat[0]).toBeCloseTo(METAB_REF - H2O_KG_DAY / DAY * H_FG, 6);
    expect(io.roomHeat[0]).toBeCloseTo(METAB_REF * SENSIBLE_FRAC, 9);
  });
  it('in the Wren (315.7 m³ of free air) CO₂ rises 175.5 Pa/day with the scrubber off, fans mixing', () => {
    const net = compileCabin(buildCabinNet(WREN));
    const st = newCabin(net, 293.15), io = makeCabinIo(net);
    io.roomT.fill(293.15); io.paneT.fill(293.15);
    off(io);
    io.metab[roomIdx('cockpit')] = METAB_REF;
    io.inp[IN_H] = 10;
    const mean = (): number => { let n = 0, v = 0; for (let i = 0; i < net.nR; i++) { n += st.rooms[i * ROOM_STRIDE + S_CO2]; v += net.V[i]; } return n * R_GAS * 293.15 / v; };
    const c0 = mean();
    for (let n = 0; n < DAY / 10; n++) stepCabin(net, st, io);
    expect(mean() - c0).toBeCloseTo(149.5 * 370.5 / 315.70, 0);
  });
  it('consumables are exact under warp: the same O₂ breathed at h = 0.1 s and h = 10 s', () => {
    const a = lumped(50), b = lumped(50);
    for (const x of [a, b]) { off(x.io); x.io.metab[0] = 170; }
    a.io.inp[IN_H] = 0.1; b.io.inp[IN_H] = 10;
    let oa = 0, ob = 0;
    for (let n = 0; n < 6 * 36000; n++) { stepCabin(a.net, a.st, a.io); oa += a.io.out[OUT_O2_USED]; }
    for (let n = 0; n < 6 * 360; n++) { stepCabin(b.net, b.st, b.io); ob += b.io.out[OUT_O2_USED]; }
    expect(Math.abs(oa / ob - 1)).toBeLessThan(1e-11);
    expect(Math.abs(a.st.rooms[S_CO2] / b.st.rooms[S_CO2] - 1)).toBeLessThan(1e-11);
  });
  it('a crew member in a sealed 2 m³ space uses only the O₂ there (hypoxia flagged, never negative)', () => {
    const { net, st, io } = lumped(2);
    off(io);
    io.metab[0] = 250;
    io.inp[IN_H] = 10;
    let hyp = 0;
    for (let n = 0; n < 4 * 8640; n++) { stepCabin(net, st, io); hyp = Math.max(hyp, io.out[OUT_HYPOXIA]); }
    expect(hyp).toBe(1);
    expect(st.rooms[S_O2]).toBeGreaterThanOrEqual(0);
    expect(io.ppO2[0]).toBeLessThan(1);
    // review D8: aerobic metabolism stops with the O₂: no more vapour, no more heat, so a vented or sealed ship
    // does not grow fog without bound
    const w0 = st.rooms[S_H2O];
    for (let n = 0; n < 100; n++) stepCabin(net, st, io);
    expect(io.out[OUT_H2O_MADE]).toBeLessThan(1e-9 * H2O_KG_DAY);
    expect(io.roomHeat[0]).toBeLessThan(1e-6);
    expect(st.rooms[S_H2O] - w0).toBeLessThan(1e-9);
  });
});

describe('scrubber, CHX, regulator', () => {
  it('scrubber steady state c = P/(η·Q): ≈ 71 Pa of CO₂ for one crew member', () => {
    const { net, st, io } = lumped(100);
    io.inp[IN_CHX] = 0;
    io.metab[0] = METAB_REF;
    io.inp[IN_H] = 10;
    for (let n = 0; n < 3 * 8640; n++) stepCabin(net, st, io);
    const P = 1.0 / MOLAR_MASS[S_CO2] / DAY; // mol/s
    const ss = P / (SCRUB_ETA * SCRUB_Q) * R_GAS * 293.15;
    expect(Math.abs(io.ppCO2[0] / ss - 1)).toBeLessThan(1e-3);
    expect(ss).toBeCloseTo(71, 0);
  });
  it('CHX steady state: p_H₂O = p_sat(T_coil) + P·R·T/(η·Q)', () => {
    const { net, st, io } = lumped(100);
    io.metab[0] = METAB_REF;
    io.inp[IN_H] = 10;
    for (let n = 0; n < 3 * 8640; n++) stepCabin(net, st, io);
    const P = H2O_KG_DAY / MOLAR_MASS[S_H2O] / DAY;
    const ss = psat(283.15) + P / (CHX_ETA * CHX_Q) * R_GAS * 293.15; // dew point → the coil temperature
    expect(Math.abs(io.ppH2O[0] / ss - 1)).toBeLessThan(1e-3);
    expect(st.condensate).toBeGreaterThan(1); // ≈ 2 kg/day collected for the condensate dump
  });
  it('the regulator holds 21 kPa in the rack room and the tank pays exactly for what was breathed', () => {
    const net = compileCabin(buildCabinNet(WREN));
    const st = newCabin(net), io = makeCabinIo(net);
    io.metab[roomIdx('cockpit')] = METAB_REF;
    io.inp[IN_H] = 10;
    for (let n = 0; n < 8640; n++) stepCabin(net, st, io); // settle the gradients
    const inv0 = new Float64Array(4), inv1 = new Float64Array(4);
    inventory(net, st, inv0);
    const tank0 = st.o2Tank;
    let inj = 0, used = 0;
    for (let n = 0; n < 8640; n++) { stepCabin(net, st, io); inj += io.out[OUT_O2_INJECTED]; used += io.out[OUT_O2_USED]; }
    inventory(net, st, inv1);
    expect(io.ppO2[roomIdx('engineering')]).toBeCloseTo(PPO2_SET, 6);
    expect(tank0 - st.o2Tank).toBeCloseTo(inj, 10); // (the 100 kg tank's ulp is 1.4e-14 kg)
    expect(Math.abs(inj / used - 1)).toBeLessThan(2e-3); // in steady state the injection equals the consumption
    expect((inv0[S_O2] - inv1[S_O2]) * MOLAR_MASS[S_O2]).toBeCloseTo(used, 9);
  });
});

describe('fog on cold panes', () => {
  function paneRoom(): { net: CabinNet; st: CabinState; io: CabinIo } {
    const def: CabinNetDef = lumpedCabinNet(30);
    def.panes.push({ id: 'w', room: 0, A: 2 });
    const net = compileCabin(def);
    const st = newCabin(net, 294), io = makeCabinIo(net);
    io.roomT.fill(294);
    return { net, st, io };
  }
  it('condenses below the dew point at h_m·A·(c − c_sat), fogs the pane, releases latent heat; evaporates back; water conserved', () => {
    const { net, st, io } = paneRoom();
    off(io);
    io.paneT[0] = 275;
    io.inp[IN_H] = 0.1;
    const water = (): number => { const v = new Float64Array(4); inventory(net, st, v); return v[S_H2O]; };
    const w0 = water();
    const c0 = st.rooms[S_H2O] / 30;
    stepCabin(net, st, io);
    const hm = H_CONV_FAN / RHO_CP_AIR;
    const m1 = st.fog[0] * 2 / MOLAR_MASS[S_H2O];
    const expectM = 0.1 * hm * 2 * (c0 - psat(275) / (R_GAS * 294)); // first step, c' ≈ c0
    expect(Math.abs(m1 / expectM - 1)).toBeLessThan(1e-4);
    expect(io.paneHeat[0]).toBeGreaterThan(0);
    io.inp[IN_H] = 10;
    for (let n = 0; n < 2160; n++) stepCabin(net, st, io); // 6 h: τ = V/(h_m·A) ≈ 75 min
    expect(fogFraction(st.fog[0])).toBe(1);
    expect(st.fog[0]).toBeGreaterThan(FOG_FULL);
    expect(Math.abs(io.ppH2O[0] - psat(275)) / psat(275)).toBeLessThan(0.02); // the pane dries the room to its dew point
    io.paneT[0] = 300;
    for (let n = 0; n < 2000; n++) stepCabin(net, st, io);
    expect(st.fog[0]).toBe(0);
    expect(io.paneHeat[0]).toBe(0);
    expect(Math.abs(water() / w0 - 1)).toBeLessThan(1e-12);
  });
  it('review D1: a fogged 0.45 m² cabin window warmed to 300 K evaporates at h = 10 s without creating water', () => {
    for (const A of [0.45, 3.6]) {
      const def: CabinNetDef = lumpedCabinNet(20);
      def.panes.push({ id: 'w', room: 0, A });
      const net = compileCabin(def);
      const st = newCabin(net, 294), io = makeCabinIo(net);
      io.roomT.fill(294);
      off(io);
      const water = (): number => { const v = new Float64Array(4); inventory(net, st, v); return v[S_H2O]; };
      const w0 = water();
      io.paneT[0] = 275; io.inp[IN_H] = 10;
      for (let n = 0; n < 1000; n++) stepCabin(net, st, io);
      expect(st.fog[0]).toBeGreaterThan(0);
      expect(Math.abs(water() / w0 - 1)).toBeLessThan(1e-12);
      // the dry-out time at h = 10 s against h = 0.1 s
      const dry = (h: number): number => {
        const s2 = loadCabin(net, saveCabin(st).cabin, saveCabin(st).life), io2 = makeCabinIo(net);
        io2.roomT.fill(294); off(io2); io2.paneT[0] = 300; io2.inp[IN_H] = h;
        let t = 0;
        while (s2.fog[0] > 0 && t < 1e5) { stepCabin(net, s2, io2); t += h; }
        const v = new Float64Array(4); inventory(net, s2, v);
        expect(Math.abs(v[S_H2O] / w0 - 1)).toBeLessThan(1e-12);
        return t;
      };
      const t1 = dry(0.1), t10 = dry(10);
      console.log(`pane ${A} m²: dries in ${t1.toFixed(1)} s at h = 0.1 s, ${t10.toFixed(1)} s at h = 10 s`);
      expect(Math.abs(t10 / t1 - 1)).toBeLessThan(0.02); // backward Euler, first order (was 24 s early at A = 3.6)
    }
  });
});

describe('caution values (caution.ts latches them)', () => {
  const dCO2 = CAUTIONS[C_CO2], dO2 = CAUTIONS[C_O2];
  it('a sleeper in a closed-off cabin with the fans off pools CO₂ to the 1 kPa caution in hours; it rises once', () => {
    expect(dCO2.on).toBe(1000);
    const net = compileCabin(buildCabinNet(WREN));
    const st = newCabin(net), io = makeCabinIo(net);
    io.inp[IN_FANS] = 0;
    io.metab[roomIdx('cabin-port')] = METAB_SLEEP;
    io.inp[IN_H] = 10;
    let rose = 0, tRise = -1, on = false;
    for (let n = 0; n < 2 * 8640; n++) {
      stepCabin(net, st, io);
      const next = latch(dCO2, on, io.out[OUT_PPCO2_MAX]);
      if (next && !on) { rose++; if (tRise < 0) tRise = (n + 1) * 10; }
      on = next;
    }
    expect(rose).toBe(1);
    expect(tRise / 3600).toBeGreaterThan(3);
    expect(tRise / 3600).toBeLessThan(16);
    // with the fans on the scrubber reaches it and the caution never sets
    const st2 = newCabin(net), io2 = makeCabinIo(net);
    io2.metab[roomIdx('cabin-port')] = METAB_SLEEP;
    io2.inp[IN_H] = 10;
    for (let n = 0; n < 2 * 8640; n++) { stepCabin(net, st2, io2); expect(io2.out[OUT_PPCO2_MAX]).toBeLessThan(dCO2.on); }
  });
  it('low ppO₂ is the worst monitored room; it latches below 16 kPa and clears above 16.5 kPa; a low tank', () => {
    const { net, st, io } = lumped(20);
    io.inp[IN_REG] = 0;
    io.metab[0] = METAB_REF;
    io.inp[IN_H] = 10;
    let t = 0, on = false;
    stepCabin(net, st, io);
    while (!(on = latch(dO2, on, io.out[OUT_PPO2_MIN]))) { stepCabin(net, st, io); t += 10; if (t > 10 * DAY) break; }
    expect(io.ppO2[0]).toBeLessThan(16000);
    expect(io.ppO2[0]).toBeGreaterThan(15900);
    expect(io.out[OUT_PPO2_MIN]).toBe(io.ppO2[0]);
    io.inp[IN_REG] = 1;
    st.o2Tank = 5;
    stepCabin(net, st, io);
    let cleared = false;
    for (let n = 0; n < 200 && !cleared; n++) {
      stepCabin(net, st, io);
      on = latch(dO2, on, io.out[OUT_PPO2_MIN]);
      if (!on) { cleared = true; expect(io.ppO2[0]).toBeGreaterThan(16500); }
    }
    expect(cleared).toBe(true);
    expect(latch(cab('o2-tank'), false, st.o2Tank / O2_TANK_FULL)).toBe(true);
    // an unmonitored room (the airlock being pumped) does not count; no monitored room gives neutral values
    io.monitor[0] = 0;
    stepCabin(net, st, io);
    expect(io.out[OUT_PPO2_MIN]).toBe(dO2.neutral);
  });
  it('a 0.01 m² breach: rapid-depress at once, low pressure soon after', () => {
    const def = buildCabinNet(WREN, { extra: [{ id: 'breach', a: 'lounge', b: 'space', A: 0.01, open0: 1 }] });
    const net = compileCabin(def);
    const st = newCabin(net), io = makeCabinIo(net);
    io.inp[IN_H] = 0.1;
    stepCabin(net, st, io);
    expect(latch(cab('cabin-depress'), false, io.out[OUT_DEPRESS_MIN])).toBe(true);
    let t = 0.1, on = false;
    while (!(on = latch(cab('cabin-p-low'), on, io.out[OUT_P_MIN]))) { stepCabin(net, st, io); t += 0.1; }
    expect(t).toBeGreaterThan(10);
    expect(t).toBeLessThan(60); // τ = V/(C_d·A·c*) ≈ 230 s; 90 kPa after ≈ 27 s
  });
  it('review D6: a step of h = 0 changes nothing and writes no NaN', () => {
    const { net, st, io } = lumped(30);
    io.metab[0] = 150;
    io.inp[IN_H] = 10;
    for (let n = 0; n < 100; n++) stepCabin(net, st, io);
    const before = JSON.stringify(saveCabin(st));
    io.inp[IN_H] = 0;
    stepCabin(net, st, io);
    expect(JSON.stringify(saveCabin(st))).toBe(before);
    for (const v of io.out) expect(Number.isFinite(v)).toBe(true);
    expect(io.out[OUT_CHX_HEAT]).toBe(0);
  });
});

void BOUNDARY_SPACE;
