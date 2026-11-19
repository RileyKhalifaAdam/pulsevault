// Cryogenic LH2 storage and the ship's overboard dumps (docs/SIMULATION.md W3-B item 5 and review rev-boiloff-vent):
// the physical CAUSE of the vent plumes W3-E sparkles in sunlight.
//
// LH2 tank: heat leak Q = 0.5 W/m² × 100 m² = 50 W through the MLI. Uncooled, it boils Q/h_fg = 50/446e3 kg/s
// = 9.7 kg/day. The leak warms a thermally stratified surface layer (δ = 5 cm over 25 m² of free surface, 88 kg of
// liquid, c = 9.7 kJ/(kg·K)), whose saturation pressure is the tank pressure: Clausius–Clapeyron
// p = p₀·exp(B·(1/T₀ − 1/T)), B = h_fg·M/R = 108 K, from 101.3 kPa at 20.3 K. Uncooled, it reaches the 200 kPa relief
// (23.3 K) in C·ΔT/Q ≈ 14 h; then the relief vents gaseous H₂ at Q/h_fg. Cryocooler: lift Q_c at
// P = Q_c·(T_h/T − 1)/η_rel (T_h = 300 K, η_rel = 0.15): ≈ 4.6 kW to hold the leak at 20.3 K (the plan's 4.7 kW), on
// the bus; it holds the setpoint (lift = leak) or pulls down at its 75 W maximum after an outage. The layer temperature
// is piecewise linear in time between events (setpoint reached, relief reached), so the step is EXACT at any h (event
// splitting, as power.ts): warp-honest without a limitedBy.
// Relief vent: a BALANCED pair (two opposed nozzles on one axis), each taking ṁ/2·(1 ± 0.01) (a 2 % imbalance), cold
// sonic GH₂ (γ ≈ 1.6 with the rotational modes frozen, 23 K): u_eff = 0.56 km/s; per side 0.031 N, net 6e-4 N along
// the axis ≈ 1e-8 m/s² on 67 t — an SRP-sized coast perturbation, booked to vent.ts slot VENT_BOIL.
// Condensate dump: the life-support condensate tank (cabin.ts st.condensate, ≈ 2 kg/day) is dumped once it holds
// 2 kg, at 5 g/s through a heated nozzle (100 W while dumping) until 0.05 kg are left: about once a day, ~6.5 min of
// ice-crystal plume, u ≈ 20 m/s (a liquid jet at 100 kPa, flashing), vent.ts slot VENT_DUMP.
//
// WIRING (wave 3): systemsStep (shipSystems.ts), at the systems rate (10 Hz at 1×, ≤ 120 s spans under warp):
//   cryoStep(cs, inp, out, vent, h) with inp.coolerOn (switch × bus), inp.lh2 (main pool kg: c.propellant, or W3-A's
//   tank), inp.condensate (cabin st.condensate kg); after it: c.propellant −= out.boilKg (W3-A's tank mass),
//   cabin st.condensate −= out.dumpKg, bus loads out.coolerW (+ out.dumpHeaterW), thermal heat out.rejectW into the
//   aft structure node (N_STRUCT_A), then ventPublish(vent, VENT_BOIL, h) and ventPublish(vent, VENT_DUMP, h).
//   Plumes for W3-E: out.plume[*] (on, ṁ, u, T, phase) at CRYO_VENT_POS / DUMP_POS. A 'vent' event (hiss through the
//   structure) when out.reliefOpened / out.dumpStarted. §1.4: writes vent (via vent.ts); reads the LH2 mass.

import type { V3 } from '../core/types';
import { R_GAS } from './life';
import { VENT_BOIL, VENT_DUMP, sonicVentVelocity, ventAdd, type VentState } from './vent';

const mexp = (x: number): number => Math.exp(x);
const mlog = (x: number): number => Math.log(x);

export const LH2_HFG = 446e3;
export const LH2_M = 2.016e-3;
export const LH2_CP = 9.7e3;
export const LH2_RHO = 70.8;
export const TANK_AREA = 100;
export const HEAT_LEAK_FLUX = 0.5;
export const Q_LEAK = HEAT_LEAK_FLUX * TANK_AREA;
export const STRAT_AREA = 25;
export const STRAT_DEPTH = 0.05;
export const T_SAT0 = 20.27;
export const P_SAT0 = 101325;
export const CC_B = LH2_HFG * LH2_M / R_GAS;
export const P_RELIEF = 200e3;
/** Saturation temperature at p (Clausius–Clapeyron). */
export const tSat = (p: number): number => 1 / (1 / T_SAT0 - Math.log(p / P_SAT0) / CC_B);
export const T_RELIEF = tSat(P_RELIEF);
export const T_SET = T_SAT0;
export const COOLER_TH = 300;
export const COOLER_ETA_REL = 0.15;
export const COOLER_Q_MAX = 75;
export const GH2_GAMMA = 1.6;
export const VENT_IMBALANCE = 0.02;
/** Relief pair: midpoint (ship axes, m) and the axis of the first nozzle (the second points the other way). */
export const CRYO_VENT_POS: V3 = { x: 0, y: 1.6, z: 6 };
export const CRYO_VENT_AXIS: V3 = { x: 1, y: 0, z: 0 };
export const CRYO_VENT_ARM = 0.4;
/** Condensate dump. */
export const DUMP_START = 2;
export const DUMP_STOP = 0.05;
export const DUMP_RATE = 5e-3;
export const DUMP_U = 20;
export const DUMP_HEATER_W = 100;
export const DUMP_POS: V3 = { x: 0, y: -1.6, z: 5 };
export const DUMP_DIR: V3 = { x: 0, y: -1, z: 0 };

/** Tank pressure at layer temperature T. */
export const tankPressure = (T: number): number => P_SAT0 * mexp(CC_B * (1 / T_SAT0 - 1 / T));

export interface CryoState {
  /** Stratified layer temperature, K. */
  T: number;
  /** Condensate dump valve open, 0/1. */
  dumping: number;
}

export interface CryoInputs {
  coolerOn: number;
  lh2: number;
  condensate: number;
}

export interface CryoOut {
  boilKg: number;
  dumpKg: number;
  coolerW: number;
  dumpHeaterW: number;
  /** Heat the cooler rejects into the ship (lift + work), W (step mean). */
  rejectW: number;
  pressure: number;
  reliefOpened: boolean;
  dumpStarted: boolean;
  /** Plumes: [relief pair, dump] × (on, ṁ kg/s, u m/s, T K, phase 0 gas / 1 ice). */
  plume: Float64Array;
}

export const makeCryoState = (): CryoState => ({ T: T_SET, dumping: 0 });
export const makeCryoInputs = (): CryoInputs => ({ coolerOn: 1, lh2: 22500, condensate: 0 });
export const makeCryoOut = (): CryoOut => ({ boilKg: 0, dumpKg: 0, coolerW: 0, dumpHeaterW: 0, rejectW: 0, pressure: P_SAT0, reliefOpened: false, dumpStarted: false, plume: new Float64Array(10) });

/** Cooler electrical power for a lift Q at cold temperature T. */
export const coolerPower = (Q: number, T: number): number => (Q > 0 ? Q * (COOLER_TH / T - 1) / COOLER_ETA_REL : 0);

/**
 * Advance the tank and the dumps by h seconds (exact, event-split). Books the vents into `vent` (slots VENT_BOIL,
 * VENT_DUMP; the caller publishes). Allocation-free.
 */
export function cryoStep(cs: CryoState, inp: CryoInputs, o: CryoOut, vent: VentState, h: number): void {
  o.boilKg = 0; o.dumpKg = 0; o.coolerW = 0; o.dumpHeaterW = 0; o.rejectW = 0; o.reliefOpened = false; o.dumpStarted = false;
  o.plume.fill(0);
  if (!(h > 0)) return;
  // ---- LH2 tank
  const mL = inp.lh2 > 0 ? inp.lh2 : 0;
  if (mL > 0) {
    const ms = LH2_RHO * STRAT_AREA * STRAT_DEPTH;
    const C = LH2_CP * (mL < ms ? mL : ms);
    let T = cs.T, t = 0, boil = 0, Ecool = 0, Elift = 0;
    const wasRelief = T >= T_RELIEF;
    const on = inp.coolerOn > 0;
    for (let seg = 0; seg < 4 && t < h; seg++) {
      const left = h - t;
      if (on && T > T_SET) {
        // pull down at full lift (the leak still comes in)
        const rate = (Q_LEAK - COOLER_Q_MAX) / C; // < 0
        const tt = (T - T_SET) / -rate;
        const dt = tt < left ? tt : left;
        const T1 = dt === tt ? T_SET : T + rate * dt;
        // exact ∫ Q·(T_h/T − 1)/η dt along the linear T(t): Q/η·(T_h·ln(T1/T)/rate − dt)
        Elift += COOLER_Q_MAX * dt; Ecool += COOLER_Q_MAX / COOLER_ETA_REL * (COOLER_TH * mlog(T1 / T) / rate - dt);
        T = T1; t += dt;
      } else if (on) {
        // hold the setpoint: lift = leak
        Elift += Q_LEAK * left; Ecool += coolerPower(Q_LEAK, T) * left; t = h;
      } else if (T < T_RELIEF) {
        const rate = Q_LEAK / C;
        const tt = (T_RELIEF - T) / rate;
        const dt = tt < left ? tt : left;
        T = dt === tt ? T_RELIEF : T + rate * dt; t += dt;
      } else {
        boil += Q_LEAK / LH2_HFG * left; t = h;
      }
    }
    if (boil > mL) boil = mL;
    cs.T = T;
    o.boilKg = boil;
    o.coolerW = Ecool / h;
    o.rejectW = (Ecool + Elift) / h;
    o.reliefOpened = !wasRelief && boil > 0;
    o.pressure = tankPressure(T);
    if (boil > 0) {
      const u = sonicVentVelocity(GH2_GAMMA, LH2_M, T_RELIEF);
      const ax = CRYO_VENT_AXIS, c = CRYO_VENT_POS, r = CRYO_VENT_ARM;
      const m1 = 0.5 * boil * (1 + 0.5 * VENT_IMBALANCE), m2 = boil - m1;
      ventAdd(vent, VENT_BOIL, m1, u, c.x + ax.x * r, c.y + ax.y * r, c.z + ax.z * r, ax.x, ax.y, ax.z);
      ventAdd(vent, VENT_BOIL, m2, u, c.x - ax.x * r, c.y - ax.y * r, c.z - ax.z * r, -ax.x, -ax.y, -ax.z);
      const p = o.plume;
      p[0] = 1; p[1] = boil / h; p[2] = u; p[3] = T_RELIEF; p[4] = 0;
    }
  }
  // ---- condensate dump (level switch with hysteresis; constant rate: exact)
  let c = inp.condensate > 0 ? inp.condensate : 0;
  if (cs.dumping === 0 && c >= DUMP_START) { cs.dumping = 1; o.dumpStarted = true; }
  if (cs.dumping === 1) {
    const can = c - DUMP_STOP;
    let dm = DUMP_RATE * h;
    let tOn = h;
    if (dm >= can) { dm = can > 0 ? can : 0; tOn = dm / DUMP_RATE; cs.dumping = 0; }
    c -= dm;
    o.dumpKg = dm;
    o.dumpHeaterW = DUMP_HEATER_W * tOn / h;
    if (dm > 0) {
      ventAdd(vent, VENT_DUMP, dm, DUMP_U, DUMP_POS.x, DUMP_POS.y, DUMP_POS.z, DUMP_DIR.x, DUMP_DIR.y, DUMP_DIR.z);
      const p = o.plume;
      p[5] = 1; p[6] = dm / h; p[7] = DUMP_U; p[8] = 300; p[9] = 1;
    }
  }
}

export const saveCryo = (cs: CryoState): CryoState => ({ T: cs.T, dumping: cs.dumping });
export function loadCryo(raw: unknown): CryoState {
  const cs = makeCryoState();
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (typeof o.T === 'number' && Number.isFinite(o.T) && o.T > 10 && o.T <= T_RELIEF) cs.T = o.T;
  cs.dumping = o.dumping === 1 ? 1 : 0;
  return cs;
}
