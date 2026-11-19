// Life support (docs/SIMULATION.md W2-D item 4, item 3 humidity, item 6 cautions): the crew's metabolism at the
// real rates, the O₂ regulator from the high-pressure tank, the regenerable CO₂ scrubber, the condensing heat
// exchanger, condensation and fog on cold window panes, the saturation-pressure table (dew point without
// Math.log) and the raw values of the life-support caution conditions (caution.ts latches them). Pure,
// deterministic, allocation-free per step; SI units (mol, kg, Pa, K, W, s).
//
// These are the LOCAL (per-room, species-specific) processes of one cabin gas step. src/world/cabin.ts
// stepCabin calls lifeLocal() first and then the transport between rooms (operator splitting; both halves
// conserve every species exactly and keep moles ≥ 0 at any h). Under warp every process is a zero-order source
// (exact: consumption = rate·h, independent of the step size) or backward Euler toward a target (unconditionally
// stable, exact steady state).
//
// WIRING (wave 2; nothing here is called yet):
//   * Through stepCabin only (cabin.ts). Inputs the wiring fills before each cabin step (10 Hz on the 1× grid,
//     ≤ MAX_GAS_STEP s under warp): io.metab[room] = Σ metabolic rate of the crew in that room, W (crew.ts /
//     W2-E: METAB_SLEEP while asleep in the bunk, METAB_REST seated, METAB_WALK on foot, METAB_WORK at a device);
//     inp[IN_SCRUB], inp[IN_CHX] = the scrubber / CHX switch × bus availability (power.ts, 0..1); inp[IN_REG] =
//     O₂ regulator valve (devices, default 1); inp[IN_TCOIL] = the CHX coil temperature (thermal HVAC cooler,
//     default CHX_COIL_T); io.paneT[w] = thermal.T[N_PANE0 + WINDOW_GROUP[window w]].
//   * Outputs for thermal.ts (step means, W): io.roomHeat[room] = crew SENSIBLE heat (metabolic minus the latent
//     heat carried away as vapour; thermal's crew term must use this, not the full metabolic rate, or the latent
//     part is counted twice); io.paneHeat[w] = latent heat released on (+) / taken from (−) pane w;
//     io.out[OUT_CHX_HEAT] = latent heat into the HVAC coolant. For power.ts: SCRUBBER_P, CHX_P, FAN_P.
//   * §1.4: life.o2Tank (kg) is st.o2Tank; additive fields (loader defaults in cabin.ts loadCabin):
//     life.condensate (kg of water in the CHX tank; W3-B's daily condensate dump reads and zeroes it),
//     cabin.fog (kg/m² of water on each pane; W2-F renders fogFraction()).
//   * Master caution (hub): caution.ts is the ONE owner of every latch, lamp and wake (review D7). This file only
//     exports the raw values (cabinCautionValues, written by every stepCabin): io.out[OUT_PPCO2_MAX] → caution.ts
//     C_CO2, io.out[OUT_PPO2_MIN] → C_O2 (the worst MONITORED room), and four more conditions with their
//     thresholds as caution.ts CautionDefs (CABIN_CAUTIONS: cabin pressure low / high, rapid depressurisation,
//     O₂ tank low); wave 2 appends them to caution.ts CAUTIONS (4 new slots) and fills them from
//     io.out[OUT_P_MIN], io.out[OUT_P_MAX], io.out[OUT_DEPRESS_MIN] and st.o2Tank / O2_TANK_FULL.
//   * Crew heat (review D7): shipSystems' `crewW[room]` input must be io.roomHeat[room] (the sensible part), NOT
//     io.metab: the latent part leaves as vapour and returns to thermal through io.paneHeat / OUT_CHX_HEAT where
//     it condenses. (Equivalently crewW = metab·SENSIBLE_FRAC while the crew have O₂.)
//
// Rates (NASA BVAD, the per-crew-member daily average at 11.82 MJ/day of metabolic expenditure = 136.8 W):
// O₂ 0.84 kg/day, CO₂ 1.00 kg/day (RQ = 0.866), water vapour 2.0 kg/day (the plan's humidity figure: respiration,
// perspiration and hygiene). The plan writes "at 100 W"; the BVAD figures belong to 136.8 W (11.82 MJ/day: the
// oxycaloric equivalent is 14.1 MJ per kg of O₂), so the rates scale with W/136.8 here. With one crew member at
// 136.8 W and the scrubber off, CO₂ rises 149 Pa/day and O₂ falls 173 Pa/day in 370.5 m³ at 293 K — the plan's
// numbers, which is the check that the 136.8 W anchor is the one the plan meant.

import type { CabinIo, CabinNet, CabinState } from './cabin';
import type { CautionDef } from './caution';

// ------------------------------------------------------------------------------------------------ wrappers
// (§1.1 rule 6: wave 2 moves them into src/world/math.ts). Used at module load only.
const mexp = (x: number): number => Math.exp(x);

// ------------------------------------------------------------------------------------------------ gas constants

/** Molar gas constant, J/(mol·K). */
export const R_GAS = 8.314462618;
/** Species slots in a room record (5 numbers per room, §1.4 cabin.rooms): moles of N₂, O₂, CO₂, H₂O, then T (K). */
export const S_N2 = 0, S_O2 = 1, S_CO2 = 2, S_H2O = 3, R_T = 4;
export const N_SPECIES = 4;
export const ROOM_STRIDE = 5;
/** Molar masses, kg/mol. */
export const MOLAR_MASS: readonly number[] = [0.0280134, 0.031998, 0.04401, 0.01801528];
/** Molar isochoric heat capacities near 300 K, J/(mol·K) (c_p − R). */
export const CV_MOLAR: readonly number[] = [20.81, 21.07, 28.82, 25.26];
/** Air molar c_p for advected enthalpy, J/(mol·K). */
export const CP_AIR_MOLAR = 29.12;
/** Ratio of specific heats used by the orifice law (air; CO₂ and H₂O are traces). */
export const GAMMA = 1.4;

// ------------------------------------------------------------------------------------------------ metabolism

/** BVAD reference metabolic rate: 11.82 MJ/day, W. */
export const METAB_REF = 11.82e6 / 86400;
export const O2_KG_DAY = 0.84;
export const CO2_KG_DAY = 1.0;
export const H2O_KG_DAY = 2.0;
/** Per watt of metabolic rate, mol/(s·W). */
export const O2_MOL_PER_J = O2_KG_DAY / MOLAR_MASS[S_O2] / 86400 / METAB_REF;
export const CO2_MOL_PER_J = CO2_KG_DAY / MOLAR_MASS[S_CO2] / 86400 / METAB_REF;
export const H2O_MOL_PER_J = H2O_KG_DAY / MOLAR_MASS[S_H2O] / 86400 / METAB_REF;
/** Respiratory quotient (mol CO₂ per mol O₂). */
export const RQ = CO2_MOL_PER_J / O2_MOL_PER_J;
/** Latent heat of vaporisation (skin/lung temperature), J/kg; per mol. */
export const H_FG = 2.43e6;
export const H_FG_MOL = H_FG * MOLAR_MASS[S_H2O];
/** Sensible share of the metabolic heat (the rest leaves as the latent heat of the 2 kg/day of vapour): 0.585. */
export const SENSIBLE_FRAC = 1 - H2O_MOL_PER_J * H_FG_MOL;
/** Activity levels, W (thermal plan: crew 80–250 W). */
export const METAB_SLEEP = 80;
export const METAB_REST = 110;
export const METAB_WALK = 170;
export const METAB_WORK = 250;

// ------------------------------------------------------------------------------------------------ equipment

/** CO₂ scrubber (regenerable, vents the CO₂ overboard): removal η·Q·c_CO₂ (W2-D item 4), electrical power, W. */
export const SCRUB_ETA = 0.9;
export const SCRUB_Q = 0.01;
export const SCRUBBER_P = 500;
/** Condensing heat exchanger: air flow through the coil, efficiency, default coil temperature, fan power. */
export const CHX_Q = 0.05;
export const CHX_ETA = 0.8;
export const CHX_COIL_T = 283.15;
export const CHX_P = 60;
/** Ventilation fans: 0.6 kW in all (W2-D item 2). */
export const FAN_P = 600;
/** O₂ regulator: ppO₂ setpoint in the rack room, maximum flow, tank capacity (W2-D item 4). */
export const PPO2_SET = 21000;
export const O2_FLOW_MAX = 1e-3;
export const O2_TANK_FULL = 100;
/** Pane condensation: convective film coefficient with the fans off (still micro-g air) and on, W/(m²·K);
 *  mass transfer h_m = h_c/(ρ·c_p) (Lewis number ≈ 1). */
export const H_CONV_STILL = 0.5;
export const H_CONV_FAN = 4;
export const RHO_CP_AIR = 1.2 * 1005;
/** Water film for a fully fogged pane, kg/m² (≈ 5 µm of droplets). */
export const FOG_FULL = 5e-3;

// ------------------------------------------------------------------------------------------------ cautions

/** Cabin caution conditions for caution.ts (review D7: caution.ts owns every latch; ppCO₂ > 1 kPa and ppO₂ < 16 kPa
 *  are its existing C_CO2 / C_O2). Append these to caution.ts CAUTIONS; values from cabinCautionValues. */
export const CABIN_CAUTIONS: readonly CautionDef[] = [
  { id: 'cabin-p-low', dir: -1, on: 90000, off: 92000, neutral: 101325 }, // worst monitored room, Pa
  { id: 'cabin-p-high', dir: 1, on: 106000, off: 104000, neutral: 101325 },
  // rapid depressurisation: moles leaving at more than 9 Pa/s (temperature changes excluded), any monitored room
  { id: 'cabin-depress', dir: -1, on: -9, off: -3, neutral: 0 },
  { id: 'o2-tank', dir: -1, on: 0.10, off: 0.12, neutral: 1 }, // st.o2Tank / O2_TANK_FULL
];

// ------------------------------------------------------------------------------------------------ saturation table

/** Saturation vapour pressure table: T from PSAT_T0 in steps of PSAT_DT (Buck 1981, over ice below 273.15 K). */
export const PSAT_T0 = 150;
export const PSAT_DT = 0.5;
export const PSAT_N = 501; // 150 … 400 K
export const PSAT: Float64Array = (() => {
  const t = new Float64Array(PSAT_N);
  for (let i = 0; i < PSAT_N; i++) {
    const c = PSAT_T0 + i * PSAT_DT - 273.15;
    t[i] = c >= 0
      ? 611.21 * mexp((18.678 - c / 234.5) * (c / (257.14 + c)))
      : 611.15 * mexp((23.036 - c / 333.7) * (c / (279.82 + c)));
  }
  return t;
})();

/** Saturation vapour pressure at T, Pa (linear in the table; clamped to its ends). */
export function psat(T: number): number {
  let u = (T - PSAT_T0) / PSAT_DT;
  if (!(u > 0)) return PSAT[0];
  if (u >= PSAT_N - 1) return PSAT[PSAT_N - 1];
  const i = u | 0;
  u -= i;
  return PSAT[i] + (PSAT[i + 1] - PSAT[i]) * u;
}

/** psat(T) written to out[k] (the allocation-free form for the per-step path). */
export function psatInto(T: number, out: Float64Array, k: number): void {
  let u = (T - PSAT_T0) / PSAT_DT;
  if (!(u > 0)) { out[k] = PSAT[0]; return; }
  if (u >= PSAT_N - 1) { out[k] = PSAT[PSAT_N - 1]; return; }
  const i = u | 0;
  u -= i;
  out[k] = PSAT[i] + (PSAT[i + 1] - PSAT[i]) * u;
}

/** Dew (frost) point of a vapour partial pressure, K: the inverse of psat by bisection on the table, no log. */
export function dewPoint(pp: number): number {
  if (!(pp > PSAT[0])) return PSAT_T0;
  if (pp >= PSAT[PSAT_N - 1]) return PSAT_T0 + (PSAT_N - 1) * PSAT_DT;
  let lo = 0, hi = PSAT_N - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (PSAT[mid] <= pp) lo = mid; else hi = mid;
  }
  return PSAT_T0 + (lo + (pp - PSAT[lo]) / (PSAT[hi] - PSAT[lo])) * PSAT_DT;
}

/** Saturation vapour concentration at T, mol/m³. */
export const cSat = (T: number): number => psat(T) / (R_GAS * T);

/** Fog cover of a pane from its water film, 0..1 (W2-F renders it). */
export const fogFraction = (film: number): number => (film <= 0 ? 0 : film >= FOG_FULL ? 1 : film / FOG_FULL);

// ------------------------------------------------------------------------------------------------ io slots

/** Scalar input slots (io.inp). */
export const IN_H = 0; // step, s
export const IN_FANS = 1; // ventilation fans 0..1 (switch × bus)
export const IN_PUMP = 2; // airlock pump 0..1
export const IN_SCRUB = 3; // CO₂ scrubber 0..1
export const IN_CHX = 4; // condensing heat exchanger 0..1
export const IN_REG = 5; // O₂ regulator valve 0..1
export const IN_TCOIL = 6; // CHX coil temperature, K
export const IN_PPO2_SET = 7; // regulator setpoint, Pa
export const IN_LEN = 8;

/** Scalar output slots (io.out); all are for the last step (amounts) or its mean (powers). */
export const OUT_O2_USED = 0; // kg breathed (crew)
export const OUT_CO2_MADE = 1; // kg exhaled
export const OUT_H2O_MADE = 2; // kg of vapour from the crew
export const OUT_CO2_SCRUBBED = 3; // kg removed and vented by the scrubber
export const OUT_O2_INJECTED = 4; // kg from the tank
export const OUT_CHX_WATER = 5; // kg condensed in the CHX
export const OUT_CHX_HEAT = 6; // W of latent heat into the HVAC coolant
export const OUT_HYPOXIA = 7; // 1 when the crew could not get the O₂ they needed (a room ran out)
export const OUT_PPO2_MIN = 8; // lowest ppO₂ of the monitored rooms, Pa (caution.ts C_O2)
export const OUT_PPCO2_MAX = 9; // highest ppCO₂ of the monitored rooms, Pa (caution.ts C_CO2)
export const OUT_DRAFT_CHANGED = 10; // 1 when the published draft field changed (st.draftEpoch advanced)
export const OUT_VENT0 = 11; // + species: mol lost to boundaries (space) through orifices / ducts
export const OUT_P_MIN = OUT_VENT0 + N_SPECIES; // lowest / highest total pressure of the monitored rooms, Pa
export const OUT_P_MAX = OUT_P_MIN + 1;
export const OUT_DEPRESS_MIN = OUT_P_MIN + 2; // most negative mole rate as a pressure rate, Pa/s
export const OUT_LEN = OUT_P_MIN + 3;
/** Output slots that are amounts over the step (summed over the sub-steps of a quantum); OUT_CHX_HEAT is a mean. */
export const OUT_AMOUNT_END = OUT_CHX_WATER + 1;

// ------------------------------------------------------------------------------------------------ local step

/**
 * The per-room, species-specific half of a cabin step over h: crew metabolism (zero-order, exact), the scrubber
 * (backward Euler on c_CO₂ in its room) and the water vapour sinks (CHX and panes: backward Euler toward their
 * saturation targets with an active set, so condensation never turns into evaporation and evaporation never
 * takes more than the film holds). Every mole is booked: film, condensate, scrubbed and breathed amounts are
 * io.out / state. The O₂ regulator is lifeRegulator (after the transport).
 */
export function lifeLocal(net: CabinNet, st: CabinState, io: CabinIo): void {
  const h = io.inp[IN_H];
  const nR = net.nR, g = st.rooms, out = io.out;
  const V = net.V;
  let o2Used = 0, co2Made = 0, h2oMade = 0;
  let hyp = 0;
  // ---- crew
  for (let i = 0; i < nR; i++) {
    const W = io.metab[i];
    const b = i * ROOM_STRIDE;
    if (!(W > 0)) { io.roomHeat[i] = 0; continue; }
    const need = W * O2_MOL_PER_J * h;
    let o2 = need, f = 1;
    // hypoxia (review D8): metabolism is aerobic, so the vapour and the heat scale with the O₂ actually taken
    if (o2 > g[b + S_O2]) { o2 = g[b + S_O2]; hyp = 1; f = need > 0 ? o2 / need : 0; }
    const co2 = o2 * RQ;
    const w = W * H2O_MOL_PER_J * h * f;
    g[b + S_O2] -= o2;
    g[b + S_CO2] += co2;
    g[b + S_H2O] += w;
    o2Used += o2; co2Made += co2; h2oMade += w;
    io.roomHeat[i] = W * f * SENSIBLE_FRAC;
  }
  out[OUT_O2_USED] = o2Used * MOLAR_MASS[S_O2];
  out[OUT_CO2_MADE] = co2Made * MOLAR_MASS[S_CO2];
  out[OUT_H2O_MADE] = h2oMade * MOLAR_MASS[S_H2O];
  out[OUT_HYPOXIA] = hyp;

  // ---- scrubber: dn/dt = −η·Q·n/V
  {
    const i = net.scrubberRoom, b = i * ROOM_STRIDE;
    const k = h * SCRUB_ETA * SCRUB_Q * io.inp[IN_SCRUB] / V[i];
    const n0 = g[b + S_CO2];
    const n1 = n0 / (1 + k);
    g[b + S_CO2] = n1;
    out[OUT_CO2_SCRUBBED] = (n0 - n1) * MOLAR_MASS[S_CO2];
  }

  // ---- water vapour sinks per room (CHX, panes)
  const fan = io.inp[IN_FANS];
  const hm = (H_CONV_STILL + (H_CONV_FAN - H_CONV_STILL) * (fan > 1 ? 1 : fan > 0 ? fan : 0)) / RHO_CP_AIR;
  out[OUT_CHX_WATER] = 0;
  out[OUT_CHX_HEAT] = 0;
  for (let w = 0; w < net.nP; w++) io.paneHeat[w] = 0;
  for (let i = 0; i < nR; i++) {
    const p0 = net.paneStart[i], p1 = net.paneStart[i + 1];
    const chx = i === net.chxRoom ? CHX_ETA * CHX_Q * io.inp[IN_CHX] : 0;
    if (p1 === p0 && !(chx > 0)) continue;
    const b = i * ROOM_STRIDE;
    const sc = net.wScr; // doubles travel in a typed scratch, not as arguments (no heap-number boxing)
    sc[0] = chx; sc[1] = hm;
    waterSinks(net, st, io, i, b, p0, p1);
  }
}

/**
 * The O₂ regulator, applied AFTER the transport of the step (so the rack room ends every step at the setpoint at
 * any h, as on the 10 Hz grid): deadbeat to the setpoint, capped by its flow and by the tank. Exact booking.
 */
export function lifeRegulator(net: CabinNet, st: CabinState, io: CabinIo): void {
  const h = io.inp[IN_H], g = st.rooms, V = net.V, out = io.out;
  {
    const i = net.o2Room, b = i * ROOM_STRIDE;
    const T = g[b + R_T];
    const need = io.inp[IN_PPO2_SET] * V[i] / (R_GAS * T) - g[b + S_O2];
    let inj = 0;
    if (need > 0 && io.inp[IN_REG] > 0) {
      inj = need;
      const cap = O2_FLOW_MAX * io.inp[IN_REG] * h / MOLAR_MASS[S_O2];
      if (inj > cap) inj = cap;
      const tank = st.o2Tank / MOLAR_MASS[S_O2];
      if (inj > tank) inj = tank;
      if (inj < 0) inj = 0;
    }
    g[b + S_O2] += inj;
    const kg = inj * MOLAR_MASS[S_O2];
    st.o2Tank -= kg;
    if (st.o2Tank < 0) st.o2Tank = 0;
    out[OUT_O2_INJECTED] = kg;
  }
}

/**
 * Water vapour in room i with sinks j (the CHX: rate k = η·Q toward p_sat(T_coil)/(R·T_room), condensation only;
 * pane w: rate h_m·A toward p_sat(T_pane)/(R·T_room), condensing onto it or evaporating from its film). Backward Euler for the room
 * concentration c': V·(c' − c₀) = −h·Σ k_j(c' − c_j) over the active sinks, plus fixed evaporation of whole films.
 * Fluxes are computed from c' and the moles are moved by them, so the booking is exact.
 */
function waterSinks(net: CabinNet, st: CabinState, io: CabinIo, i: number, b: number, p0: number, p1: number): void {
  const chx = net.wScr[0], hm = net.wScr[1], h = io.inp[IN_H];
  const g = st.rooms, V = net.V[i], L = net.paneList, MW = MOLAR_MASS[S_H2O];
  const n0 = g[b + S_H2O];
  const c0 = n0 / V;
  const act = net.paneAct; // per pane: 0 inactive, 1 active (linear), 2 fixed (the whole film evaporates)
  const tgt = net.paneTgt;
  let chxOn = 0;
  // targets in room-air terms: the surface holds p_v = p_sat(T_surface), and p_v (not the concentration) equalises
  // across the film at uniform total pressure, so the dew point of the room ends at the surface temperature
  const iRT = 1 / (R_GAS * g[b + R_T]);
  // (psat into typed scratch, not as a return value: a call that is not inlined returns a boxed double)
  let cCoil = 0;
  if (chx > 0) { psatInto(io.inp[IN_TCOIL], net.wScr, 2); cCoil = net.wScr[2] * iRT; }
  if (chx > 0 && c0 > cCoil) chxOn = 1;
  for (let q = p0; q < p1; q++) {
    const w = L[q];
    psatInto(io.paneT[w], tgt, w);
    tgt[w] *= iRT;
    act[w] = c0 > tgt[w] || st.fog[w] > 0 ? 1 : 0;
  }
  let c1 = c0;
  for (let it = 0; it < 6; it++) {
    let num = n0, den = V;
    if (chxOn) { num += h * chx * cCoil; den += h * chx; }
    for (let q = p0; q < p1; q++) {
      const w = L[q];
      if (act[w] === 1) { const k = hm * net.pA[w]; num += h * k * tgt[w]; den += h * k; }
      else if (act[w] === 2) num += st.fog[w] * net.pA[w] / MW;
    }
    c1 = num / den;
    let changed = false;
    if (chxOn && c1 < cCoil) { chxOn = 0; changed = true; }
    for (let q = p0; q < p1; q++) {
      const w = L[q];
      if (act[w] !== 1) continue;
      const flux = hm * net.pA[w] * (c1 - tgt[w]); // mol/s onto the pane (> 0 condensing)
      // the film holds fog·A kg (review D1: the area was missing, so small panes were overdrawn)
      if (flux < 0 && -flux * h * MW > st.fog[w] * net.pA[w]) { act[w] = st.fog[w] > 0 ? 2 : 0; changed = true; }
    }
    if (!changed) break;
  }
  // move the moles by the fluxes at c1
  let nOut = 0;
  if (chxOn) {
    const m = h * chx * (c1 - cCoil);
    nOut += m;
    st.condensate += m * MW;
    io.out[OUT_CHX_WATER] += m * MW;
    if (h > 0) io.out[OUT_CHX_HEAT] += m * H_FG_MOL / h; // (review D6: h = 0 gave NaN)
  }
  for (let q = p0; q < p1; q++) {
    const w = L[q];
    let m = 0;
    if (act[w] === 1) m = h * hm * net.pA[w] * (c1 - tgt[w]);
    else if (act[w] === 2) m = -st.fog[w] * net.pA[w] / MW;
    if (m === 0) continue;
    let film = st.fog[w] + m * MW / net.pA[w];
    if (film < 0) film = 0; // rounding of a whole-film evaporation
    st.fog[w] = film;
    nOut += m;
    if (h > 0) io.paneHeat[w] += m * H_FG_MOL / h;
  }
  let n1 = n0 - nOut;
  if (n1 < 0) n1 = 0;
  g[b + S_H2O] = n1;
}

/**
 * The raw cabin caution values of this step's room states (monitored rooms only) into io.out (caution.ts latches
 * them; see CABIN_CAUTIONS). With no monitored room the values are neutral.
 */
export function cabinCautionValues(net: CabinNet, io: CabinIo): void {
  let ppo2Min = Infinity, ppco2Max = -Infinity, pMin = Infinity, pMax = -Infinity, rMin = Infinity;
  for (let i = 0; i < net.nR; i++) {
    if (!io.monitor[i]) continue;
    if (io.ppO2[i] < ppo2Min) ppo2Min = io.ppO2[i];
    if (io.ppCO2[i] > ppco2Max) ppco2Max = io.ppCO2[i];
    if (io.p[i] < pMin) pMin = io.p[i];
    if (io.p[i] > pMax) pMax = io.p[i];
    if (io.depress[i] < rMin) rMin = io.depress[i];
  }
  const o = io.out;
  o[OUT_PPO2_MIN] = ppo2Min === Infinity ? 21000 : ppo2Min;
  o[OUT_PPCO2_MAX] = ppco2Max === -Infinity ? 0 : ppco2Max;
  o[OUT_P_MIN] = pMin === Infinity ? 101325 : pMin;
  o[OUT_P_MAX] = pMax === -Infinity ? 101325 : pMax;
  o[OUT_DEPRESS_MIN] = rMin === Infinity ? 0 : rMin;
}
