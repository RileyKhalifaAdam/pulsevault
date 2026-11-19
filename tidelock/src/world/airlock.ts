// The airlock cycle and the docking tunnel (docs/SIMULATION.md W3-B item 3).
//
// Airlock = the suit room (10.3 m³ free air). A roughing pump returns its air to the corridor (no air is thrown away
// above 2 kPa), then a dump valve vents the rest to space; repressurisation goes through the door's equalisation
// valve. The pump curve is compression-ratio limited: S(p) = S₀·(1 − p_out/(K₀·p)), i.e. dp/dt = −(S₀/V)·(p − p_u),
// p_u = p_out/K₀ (0.5 kPa against a 101 kPa corridor). Closed form: p(t) = p_u + (p₀ − p_u)·e^(−t/τ), τ = V/S₀ =
// 258 s; 101.3 → 2 kPa in τ·ln((p₀ − p_u)/(p − p_u)) = 18.2 min, then the dump (20 cm², τ ≈ 37 s) to 10 Pa in ≈ 3.3 min.
// Pump power (isothermal compression at 50 %): ṅ·R·T·ln(p_out/p)/η, ≤ 0.7 kW at the end of the pump-down.
//
// Warp honesty without a limitedBy: the gas network moves the pump's air with an implicit (backward Euler) duct
// ṅ = Q·n'/V. airlockPumpFactor chooses Q for the step h so that the room lands EXACTLY on the closed form,
// Q = V·(p/p' − 1)/h with p' = p_u + (p − p_u)·e^(−S₀h/V) (the duct's nominal flow is 2·S₀ so the factor stays
// ≤ 1 up to h ≈ 300 s): at 10 Hz and at one 17 s warp step the pump-down time is the same to < 0.5 % (tests).
// The p_u floor is taken at the step's start pressure, so a long step overshoots p_u by second order only.
//
// Docking tunnel (room `tunnel`, 1.5 m³ between the Wren's hatch and the station's): undocked, its collar is open to
// space (orifice `collar`, a vent); docked, the docking seal closes it; the station's side of the procedure is its
// crew's: they open their umbilical valve (5 cm²) once the tunnel holds half their pressure (or on inp.umbilical),
// and their hatch once its Δp < 200 Pa. Boundary
// 1 of the gas network is the station's cabin (p, T, mole fractions from the station state, default 101.3 kPa air).
// The Wren's hatch has its own equalisation valve (doors.ts / compartments.ts): "crack the equalisation valve, swing
// the hatch open".
//
// WIRING (wave 3): compartments.ts calls airlockStep before every gas step (10 Hz at 1×, once per gas sub-step span
// under warp) with h = the gas sub-step; it writes cabin io.inp[IN_PUMP], io.open[dump], io.open[door valve] and
// the door command; and dockedBoundary(...) into io.bnd for boundary 1 plus io.open[collar | umbilical |
// stationHatch]. Devices: CYCLE OUT / CYCLE IN buttons (st[A_CMD]), a pump switch, the umbilical valve (the
// station's, on the docking page). Outputs: pump electrical W (bus load L_PUMP), phase for the SYS page.
// §1.4: reads cabin.rooms via io.p; saves st.al (phase).

import {
  AIRLOCK_DUCT_Q, AIRLOCK_K0, AIRLOCK_P_PUMPED, AIRLOCK_P_VAC, AIRLOCK_PUMP_ETA, AIRLOCK_PUMP_PMAX, AIRLOCK_S0,
} from '../data/compartments';
import { BND_STRIDE } from './cabin';
import { R_GAS } from './life';

// transcendental wrappers (§1.1 rule 6: to move into src/world/math.ts)
const mexp = (x: number): number => Math.exp(x);
const mlog = (x: number): number => Math.log(x);

/** Sequencer phases. */
export const AL_IDLE = 0, AL_CLOSE = 1, AL_PUMP = 2, AL_DUMP = 3, AL_VAC = 4, AL_REPRESS = 5;
/** Saved slots: phase, command (+1 cycle out, −1 cycle in, 0 none; consumed). */
export const A_PHASE = 0, A_CMD = 1;
export const AIRLOCK_STRIDE = 2;
/** Repressurised when |Δp| across the door is below this, Pa (the door's own unseat limit is 190 Pa). */
export const AL_EQUAL_DP = 100;

export interface AirlockOut {
  /** Pump flow factor for cabin io.inp[IN_PUMP] (0..1 of AIRLOCK_DUCT_Q). */
  pump: number;
  dump: number;
  /** Door equalisation valve command (0..1) and door command (−1 close, +1 open, 0 leave). */
  valve: number;
  door: number;
  /** Pump electrical power, W. */
  pumpW: number;
}

export const makeAirlockOut = (): AirlockOut => ({ pump: 0, dump: 0, valve: 0, door: 0, pumpW: 0 });
export const makeAirlockState = (): Float64Array => new Float64Array(AIRLOCK_STRIDE);

/**
 * The pump's flow factor for one implicit gas step of h seconds that lands the airlock (volume V, pressure p,
 * temperature T) on the closed form against an outlet at pOut (header). Also returns the power through `o`.
 */
export function airlockPumpFactor(V: number, p: number, pOut: number, T: number, h: number, on: number, o: AirlockOut): number {
  o.pumpW = 0;
  if (!(on > 0) || !(h > 0) || !(p > 0)) return 0;
  const pu = pOut / AIRLOCK_K0;
  if (!(p > pu)) return 0;
  const p1 = pu + (p - pu) * mexp(-AIRLOCK_S0 * h / V);
  const Q = V * (p / p1 - 1) / h;
  let f = Q / AIRLOCK_DUCT_Q;
  if (f > 1) f = 1;
  const ndot = (p - p1) * V / (R_GAS * T * h);
  const W = pOut > p ? ndot * R_GAS * T * mlog(pOut / p) / AIRLOCK_PUMP_ETA : 0;
  o.pumpW = W < AIRLOCK_PUMP_PMAX ? W : AIRLOCK_PUMP_PMAX;
  return f * (on < 1 ? on : 1);
}

/** Closed-form pump-down time from p0 to p (s) for volume V against pOut. */
export function airlockPumpTime(V: number, p0: number, p: number, pOut: number): number {
  const pu = pOut / AIRLOCK_K0;
  return (V / AIRLOCK_S0) * Math.log((p0 - pu) / (p - pu));
}

/**
 * Sequencer + pump (before a gas step of h s). pa = airlock pressure, pc = corridor pressure, doorSeated = the door's
 * seat stroke is 0, V and T the airlock's volume and gas temperature, pumpOn = switch × bus.
 */
export function airlockStep(st: Float64Array, pa: number, pc: number, doorSeated: boolean, V: number, T: number, h: number, pumpOn: number, o: AirlockOut): void {
  const cmd = st[A_CMD];
  st[A_CMD] = 0;
  let ph = st[A_PHASE];
  if (cmd > 0 && (ph === AL_IDLE || ph === AL_REPRESS)) ph = AL_CLOSE;
  else if (cmd < 0 && ph !== AL_IDLE) ph = AL_REPRESS;
  o.pump = 0; o.dump = 0; o.valve = 0; o.door = 0; o.pumpW = 0;
  switch (ph) {
    case AL_CLOSE:
      o.door = -1;
      if (doorSeated) ph = AL_PUMP;
      break;
    case AL_PUMP:
      o.door = -1;
      if (pa <= AIRLOCK_P_PUMPED) { ph = AL_DUMP; o.dump = 1; break; }
      o.pump = airlockPumpFactor(V, pa, pc, T, h, pumpOn, o);
      break;
    case AL_DUMP:
      o.door = -1; o.dump = 1;
      if (pa <= AIRLOCK_P_VAC) { ph = AL_VAC; o.dump = 0; }
      break;
    case AL_VAC:
      o.door = -1;
      break;
    case AL_REPRESS: {
      o.valve = 1;
      const dp = pc > pa ? pc - pa : pa - pc;
      if (dp < AL_EQUAL_DP) { ph = AL_IDLE; o.valve = 0; o.door = 1; }
      break;
    }
    default:
      break;
  }
  st[A_PHASE] = ph;
}

/** Docked-station boundary state: write boundary j of cabin io.bnd (p, T, mole fractions N₂ O₂ CO₂ H₂O). */
export function setBoundary(bnd: Float64Array, j: number, p: number, T: number, xN2: number, xO2: number, xCO2: number, xH2O: number): void {
  const o = j * BND_STRIDE;
  bnd[o] = p; bnd[o + 1] = T; bnd[o + 2] = xN2; bnd[o + 3] = xO2; bnd[o + 4] = xCO2; bnd[o + 5] = xH2O;
}

/** Default station cabin: the Wren's own default atmosphere. */
export function setStationAir(bnd: Float64Array, j: number): void {
  const p = 101325;
  setBoundary(bnd, j, p, 294, (p - 21000 - 60 - 1240) / p, 21000 / p, 60 / p, 1240 / p);
}

/** Saved state helpers. */
export const saveAirlock = (st: Float64Array): number[] => Array.from(st);
export function loadAirlock(raw: unknown): Float64Array {
  const st = makeAirlockState();
  if (Array.isArray(raw) && raw.length === st.length && raw.every((x) => typeof x === 'number' && Number.isFinite(x))) st.set(raw);
  return st;
}
