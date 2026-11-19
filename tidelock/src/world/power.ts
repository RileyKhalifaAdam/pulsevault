// The electrical system (docs/SIMULATION.md W2-D item 2): reactor (load-following ramp, DRIVE ARM = drive standby),
// the drive bus, and the 120 V DC hotel bus solved algebraically: a power-limited converter (reactor, shore) in
// parallel with the battery V = V_oc(SOC) − I·R_i, constant-power loads (electronics, motor drives) and resistive
// loads (lamps, P ∝ V², flux ∝ (V/V_nom)^1.5), short-circuit faults as conductances; thermal I²t breakers
// (trip at ∫(I² − I_r²)dt > 5 s·I_r²), latched undervoltage trips of electronics below 100 V, drive drop-out of
// motor loads below 90 V.
//
// Exactness: within a step every input is constant, so the bus is piecewise constant between EVENTS (a breaker
// trip, the battery reaching empty or full). powerStep finds the earliest event in closed form, advances to it
// exactly, applies it, re-solves, and repeats (≤ 16 sub-intervals). SOC is then exact for piecewise-constant power at
// any step size: dE = −V_oc·I_b·τ per sub-interval, the bus re-solved at the predicted mid-interval SOC so the
// V_oc(SOC) feedback is second order (one 30 s step vs 300 × 0.1 s: ~1e-9 of ΔSOC; tests). The reactor ramp is integrated
// exactly (piecewise linear). Energy closes: battery + converter = loads + faults + I²R (tests).
//
// WIRING (wave 2): called only from systemsStep (src/world/shipSystems.ts), at the systems rate (10 Hz at 1×,
// ≤ 30 s steps under warp); no limitedBy (events are resolved inside the step). Devices write st.breakers[c]
// (1 in, 0 pulled), st.reactorSet (the reactor output lever, 0..1 of rated; a scram writes 0). Inputs: load demand
// fractions (data/powerNet.ts L_*), DRIVE ARM, engines lit, docked (shore power). Outputs used elsewhere: V and
// lampScale (W2-F lamp flux), driveReady / driveFrac (dynamics: the torch lights only when the drive bus carries
// it, flames out below DRIVE_READY_FRAC), newTrips (master caution, 'breaker' events), heat per load (thermal).
// §1.4 fields: writes power.{soc, breakers, reactorSet}; the rest of PowerState is this package's own saved state.
// Rules: no allocation per step (preallocated out arrays and module scratch), deterministic, SI.

import {
  BATT_E_CAP, BATT_I_CHARGE, BATT_R, BATT_VOC_EMPTY, BATT_VOC_FULL, BREAKER_TRIP_S, BUS_V_NOM, BUS_V_REG, CIRCUITS,
  CONV_P_MAX, CP_DROPOUT_V, DRIVE_BUS_V_NOM, DRIVE_P_ENGINE, DRIVE_READY_FRAC, LOAD_CP, LOADS, N_CIRCUITS, N_ENGINES, N_LOADS,
  REACTOR_ETA, REACTOR_P_RATED, REACTOR_RAMP, SHORE_P, UV_TRIP_V,
} from '../data/powerNet';

export interface PowerState {
  /** Battery state of charge, 0..1 (§1.4). */
  soc: number;
  /** Per circuit: 1 closed (pushed in), 0 open (pulled or tripped) (§1.4). */
  breakers: number[];
  /** Reactor output lever, 0..1 of rated (§1.4). */
  reactorSet: number;
  /** Reactor electrical output now, W. */
  reactorP: number;
  /** Breaker I²t heat, A²·s (≥ 0). */
  i2t: number[];
  /** Bitmask of circuits that tripped and have not been pushed back in. */
  tripped: number;
}

export interface PowerInputs {
  /** Load demand, fraction of nominal (LOADS order). */
  demand: Float64Array;
  /** Fault (short) conductance per circuit, S (W2-C damage; 0 = none). */
  fault: Float64Array;
  /** DRIVE ARM switch (drive standby), 0/1. */
  driveArmed: number;
  /** Engines lit (0..N_ENGINES). */
  lit: number;
  /** Docked with shore power, 0/1. */
  docked: number;
}

export interface PowerOut {
  /** Hotel bus voltage and battery current (A, + discharge) at the END of the step. */
  V: number;
  Ibatt: number;
  /** Lamp flux scale (V/V_nom)^1.5 at the end of the step. */
  lampScale: number;
  /** Step-mean reactor electric output, W, and the drive bus. */
  reactorAvg: number;
  driveFrac: number;
  driveReady: boolean;
  driveBusV: number;
  /** Bitmask of circuits that tripped during this step. */
  newTrips: number;
  /** Energy over the step, J. */
  delivered: Float64Array; // per load
  requested: Float64Array; // per load at nominal (CP) / at V_nom (resistive)
  faultJ: Float64Array; // per circuit
  circuitI: Float64Array; // per circuit, A, at the end of the step
  battJ: number; // internal energy released (+ discharge, − charge)
  battLossJ: number;
  convJ: number; // converter output (reactor + shore)
  shoreJ: number;
  driveJ: number; // electrical energy into the torches (leaves with the exhaust)
  reactorWasteJ: number; // P_e·(1/η − 1)·dt into the reactor bay
  shuntJ: number; // reactor output nobody drew (standby dump), into the reactor bay
  /** Sub-intervals used (diagnostic). */
  segments: number;
}

export function makePowerInputs(): PowerInputs {
  return { demand: new Float64Array(N_LOADS), fault: new Float64Array(N_CIRCUITS), driveArmed: 0, lit: 0, docked: 0 };
}

export function makePowerOut(): PowerOut {
  return {
    V: BUS_V_NOM, Ibatt: 0, lampScale: 1, reactorAvg: 0, driveFrac: 0, driveReady: false, driveBusV: 0, newTrips: 0,
    delivered: new Float64Array(N_LOADS), requested: new Float64Array(N_LOADS), faultJ: new Float64Array(N_CIRCUITS),
    circuitI: new Float64Array(N_CIRCUITS), battJ: 0, battLossJ: 0, convJ: 0, shoreJ: 0, driveJ: 0, reactorWasteJ: 0, shuntJ: 0, segments: 0,
  };
}

export const vocOf = (soc: number): number => BATT_VOC_EMPTY + (BATT_VOC_FULL - BATT_VOC_EMPTY) * soc;

// ------------------------------------------------------------------------------------------------ bus solve

const LOAD_CIRC = Int32Array.from(LOADS.map((l) => l.circuit));
const LOAD_KIND = Int32Array.from(LOADS.map((l) => l.kind));
const LOAD_P = Float64Array.from(LOADS.map((l) => l.P));
const RATING = Float64Array.from(CIRCUITS.map((c) => c.rating));
const UV = Int32Array.from(CIRCUITS.map((c) => (c.uvTrip ? 1 : 0)));
const INV_VNOM2 = 1 / (BUS_V_NOM * BUS_V_NOM);
/** Scratch: per-circuit constant power and conductance of the current sub-interval. */
const CP_C = new Float64Array(N_CIRCUITS);
const GR_C = new Float64Array(N_CIRCUITS);
const SOL = new Float64Array(2); // V, Ib

/**
 * Bus voltage for constant-power load Pcp and conductance Gr, battery V_oc (discharge allowed if battOk), a
 * converter of Pavail W regulating at most Vt. Battery and power-limited converter:
 *   Pavail + V·(V_oc − V)/R = Pcp + Gr·V²  ⇒  (1 + R·Gr)V² − V_oc·V + R(Pcp − Pavail) = 0, V = larger root,
 * then V = min(V, Vt) (the converter regulates when it has the power). No real root: collapse to the battery's
 * maximum-power point V_oc/(2(1 + R·Gr)) (the undervoltage logic then sheds load).
 */
function solveBus(Pcp: number, Gr: number, voc: number, battOk: boolean, Pavail: number, Vt: number): void {
  const a = 1 + BATT_R * Gr;
  const disc = voc * voc - 4 * a * BATT_R * (Pcp - Pavail);
  let V = disc >= 0 ? (voc + Math.sqrt(disc)) / (2 * a) : voc / (2 * a);
  if (V > Vt) V = Vt;
  let Ib = (voc - V) / BATT_R;
  if (Ib > 0 && !battOk) {
    // empty battery: the BMS blocks discharge; the converter alone
    Ib = 0;
    if (Pavail >= Pcp + Gr * Vt * Vt) V = Vt;
    else if (Gr > 0 && Pavail > Pcp) V = Math.sqrt((Pavail - Pcp) / Gr);
    else V = 0;
  }
  SOL[0] = V; SOL[1] = Ib;
}

// ------------------------------------------------------------------------------------------------ the step

const MAX_SEGMENTS = 16;

/**
 * Advance the electrical system by h seconds with constant inputs. Writes o (energies of this step, end-of-step
 * bus state) and updates st. Allocation-free.
 */
export function powerStep(st: PowerState, inp: PowerInputs, o: PowerOut, h: number): void {
  const dem = inp.demand, br = st.breakers, H = st.i2t;
  o.delivered.fill(0); o.requested.fill(0); o.faultJ.fill(0);
  o.battJ = 0; o.battLossJ = 0; o.convJ = 0; o.shoreJ = 0; o.newTrips = 0;
  // a breaker pushed back in clears its trip flag
  for (let c = 0; c < N_CIRCUITS; c++) if (br[c] === 1) st.tripped &= ~(1 << c);
  const shore = inp.docked ? SHORE_P : 0;

  // --- hotel demand at regulation (for the reactor setpoint): closed loads + charging
  let voc = vocOf(st.soc);
  let Vt = BUS_V_REG < voc + BATT_R * BATT_I_CHARGE ? BUS_V_REG : voc + BATT_R * BATT_I_CHARGE;
  if (st.soc >= 1 && Vt > voc) Vt = voc;
  let hotel = 0;
  for (let l = 0; l < N_LOADS; l++) {
    if (br[LOAD_CIRC[l]] !== 1) continue;
    hotel += LOAD_KIND[l] === LOAD_CP ? dem[l] * LOAD_P[l] : dem[l] * LOAD_P[l] * Vt * Vt * INV_VNOM2;
  }
  for (let c = 0; c < N_CIRCUITS; c++) if (br[c] === 1) hotel += inp.fault[c] * Vt * Vt;
  if (Vt > voc) hotel += (Vt * (Vt - voc)) / BATT_R;
  if (hotel > CONV_P_MAX + shore) hotel = CONV_P_MAX + shore;
  let hotelR = hotel - shore;
  if (hotelR < 0) hotelR = 0;
  const driveDemand = (inp.driveArmed ? N_ENGINES : inp.lit) * DRIVE_P_ENGINE;
  const litDemand = inp.lit * DRIVE_P_ENGINE;
  // --- reactor ramp, exact
  const set = st.reactorSet > 0 ? (st.reactorSet < 1 ? st.reactorSet : 1) : 0;
  let target = driveDemand + hotelR;
  if (target > set * REACTOR_P_RATED) target = set * REACTOR_P_RATED;
  const rate = REACTOR_RAMP * REACTOR_P_RATED;
  const P0 = st.reactorP, d = target - P0, ad = d < 0 ? -d : d;
  let E: number, P1: number;
  if (ad <= rate * h) {
    const tau = ad / rate;
    E = 0.5 * (P0 + target) * tau + target * (h - tau);
    P1 = target;
  } else {
    P1 = P0 + (d > 0 ? rate * h : -rate * h);
    E = 0.5 * (P0 + P1) * h;
  }
  st.reactorP = P1;
  const Pavg = E / h;
  o.reactorAvg = Pavg;
  const driveUsed = litDemand < Pavg ? litDemand : Pavg;
  o.driveJ = driveUsed * h;
  let convR = Pavg - driveUsed;
  if (convR > CONV_P_MAX) convR = CONV_P_MAX;
  if (convR < 0) convR = 0;
  const Pavail = convR + shore;
  o.driveFrac = litDemand > 0 ? (Pavg < litDemand ? Pavg / litDemand : 1) : driveDemand > 0 ? ((P1 - hotelR) / driveDemand < 1 ? (P1 - hotelR) / driveDemand : 1) : 0;
  if (o.driveFrac < 0) o.driveFrac = 0;
  o.driveReady = driveDemand > 0 && o.driveFrac >= DRIVE_READY_FRAC;
  o.driveBusV = DRIVE_BUS_V_NOM * o.driveFrac;

  // --- hotel bus, event-driven sub-intervals
  let t = 0, seg = 0, V = 0, Ib = 0;
  while (t < h && seg < MAX_SEGMENTS) {
    seg++;
    voc = vocOf(st.soc);
    Vt = BUS_V_REG < voc + BATT_R * BATT_I_CHARGE ? BUS_V_REG : voc + BATT_R * BATT_I_CHARGE;
    if (st.soc >= 1 && Vt > voc) Vt = voc;
    const battOk = st.soc > 0;
    let cpOut = false;
    for (let pass = 0; pass < 3; pass++) {
      let Pcp = 0, Gr = 0;
      for (let c = 0; c < N_CIRCUITS; c++) { CP_C[c] = 0; GR_C[c] = br[c] === 1 ? inp.fault[c] : 0; }
      for (let l = 0; l < N_LOADS; l++) {
        const c = LOAD_CIRC[l];
        if (br[c] !== 1) continue;
        if (LOAD_KIND[l] === LOAD_CP) { if (!cpOut) CP_C[c] += dem[l] * LOAD_P[l]; } else GR_C[c] += dem[l] * LOAD_P[l] * INV_VNOM2;
      }
      for (let c = 0; c < N_CIRCUITS; c++) { Pcp += CP_C[c]; Gr += GR_C[c]; }
      solveBus(Pcp, Gr, voc, battOk, Pavail, Vt);
      V = SOL[0]; Ib = SOL[1];
      if (V < UV_TRIP_V) {
        let tripped = false;
        for (let c = 0; c < N_CIRCUITS; c++) {
          if (UV[c] && br[c] === 1 && CP_C[c] > 0) { br[c] = 0; st.tripped |= 1 << c; o.newTrips |= 1 << c; tripped = true; }
        }
        if (tripped) continue;
      }
      if (V < CP_DROPOUT_V && !cpOut && Pcp > 0) { cpOut = true; continue; }
      break;
    }
    // second order in the V_oc(SOC) feedback: re-solve once at the predicted mid-interval SOC (same loads)
    if (V > 0 && Ib !== 0 && (Ib < 0 || battOk)) {
      let sm = st.soc - (voc * Ib * (h - t)) / (2 * BATT_E_CAP);
      sm = sm < 0 ? 0 : sm > 1 ? 1 : sm;
      const vm = vocOf(sm);
      let Vtm = BUS_V_REG < vm + BATT_R * BATT_I_CHARGE ? BUS_V_REG : vm + BATT_R * BATT_I_CHARGE;
      if (st.soc >= 1 && Vtm > vm) Vtm = vm;
      let Pcp = 0, Gr = 0;
      for (let c = 0; c < N_CIRCUITS; c++) { Pcp += CP_C[c]; Gr += GR_C[c]; }
      solveBus(Pcp, Gr, vm, battOk, Pavail, Vtm);
      if (SOL[0] >= CP_DROPOUT_V || cpOut) { V = SOL[0]; Ib = SOL[1]; voc = vm; }
    }
    // circuit currents and the earliest event
    let tau = h - t, ev = -1;
    for (let c = 0; c < N_CIRCUITS; c++) {
      const P = CP_C[c] + GR_C[c] * V * V;
      const I = V > 0 ? P / V : 0;
      o.circuitI[c] = I;
      if (br[c] !== 1) continue;
      const Ir2 = RATING[c] * RATING[c], I2 = I * I;
      if (I2 > Ir2) {
        const need = BREAKER_TRIP_S * Ir2 - H[c];
        const tt = need > 0 ? need / (I2 - Ir2) : 0;
        if (tt < tau) { tau = tt; ev = c; }
      }
    }
    const Pint = voc * Ib;
    let evBatt = false;
    if (Pint > 0) {
      const te = (st.soc * BATT_E_CAP) / Pint;
      if (te < tau) { tau = te; ev = -1; evBatt = true; }
    } else if (Pint < 0) {
      const tf = ((1 - st.soc) * BATT_E_CAP) / -Pint;
      if (tf < tau) { tau = tf; ev = -1; evBatt = true; }
    }
    // advance tau with this solution
    let Pload = 0;
    for (let l = 0; l < N_LOADS; l++) {
      const c = LOAD_CIRC[l];
      const req = LOAD_KIND[l] === LOAD_CP ? dem[l] * LOAD_P[l] : dem[l] * LOAD_P[l];
      o.requested[l] += req * tau;
      if (br[c] !== 1) continue;
      const P = LOAD_KIND[l] === LOAD_CP ? (cpOut ? 0 : dem[l] * LOAD_P[l]) : dem[l] * LOAD_P[l] * V * V * INV_VNOM2;
      o.delivered[l] += P * tau;
      Pload += P;
    }
    for (let c = 0; c < N_CIRCUITS; c++) {
      if (br[c] === 1) {
        const Pf = inp.fault[c] * V * V;
        o.faultJ[c] += Pf * tau;
        Pload += Pf;
        const I = o.circuitI[c];
        const hn = H[c] + (I * I - RATING[c] * RATING[c]) * tau;
        H[c] = hn > 0 ? hn : 0;
      } else {
        const hn = H[c] - RATING[c] * RATING[c] * tau; // an open breaker cools
        H[c] = hn > 0 ? hn : 0;
      }
    }
    const Pconv = Pload - V * Ib;
    o.convJ += Pconv * tau;
    o.shoreJ += (Pconv < shore ? (Pconv > 0 ? Pconv : 0) : shore) * tau;
    o.battJ += Pint * tau;
    o.battLossJ += Ib * Ib * BATT_R * tau;
    if (evBatt) st.soc = Pint > 0 ? 0 : 1;
    else {
      const s = st.soc - (Pint * tau) / BATT_E_CAP;
      st.soc = s < 0 ? 0 : s > 1 ? 1 : s;
    }
    if (ev >= 0) {
      br[ev] = 0; H[ev] = BREAKER_TRIP_S * RATING[ev] * RATING[ev];
      st.tripped |= 1 << ev; o.newTrips |= 1 << ev;
    }
    t += tau;
  }
  o.segments = seg;
  o.V = V;
  o.Ibatt = Ib;
  const r = V / BUS_V_NOM;
  o.lampScale = r > 0 ? r * Math.sqrt(r) : 0;
  const reactorConv = o.convJ - o.shoreJ;
  o.shuntJ = E - o.driveJ - reactorConv;
  if (o.shuntJ < 0) o.shuntJ = 0; // round-off guard only
  o.reactorWasteJ = E * (1 / REACTOR_ETA - 1);
}

// ------------------------------------------------------------------------------------------------ state

export function makePowerState(): PowerState {
  return { soc: 0.8, breakers: CIRCUITS.map(() => 1), reactorSet: 1, reactorP: 0, i2t: CIRCUITS.map(() => 0), tripped: 0 };
}

export function savePower(s: PowerState): PowerState {
  return { soc: s.soc, breakers: s.breakers.slice(), reactorSet: s.reactorSet, reactorP: s.reactorP, i2t: s.i2t.slice(), tripped: s.tripped };
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Loader with defaults for every field (additive: an older save without power gets a charged, closed bus). */
export function loadPower(saved: unknown): PowerState {
  const s = makePowerState();
  const o = saved as Partial<PowerState> | null | undefined;
  if (!o || typeof o !== 'object') return s;
  s.soc = Math.min(1, Math.max(0, num(o.soc, s.soc)));
  s.reactorSet = Math.min(1, Math.max(0, num(o.reactorSet, s.reactorSet)));
  s.reactorP = Math.max(0, num(o.reactorP, s.reactorP));
  if (Array.isArray(o.breakers) && o.breakers.length === N_CIRCUITS) s.breakers = o.breakers.map((b) => (b === 1 ? 1 : 0));
  if (Array.isArray(o.i2t) && o.i2t.length === N_CIRCUITS) s.i2t = o.i2t.map((v) => Math.max(0, num(v, 0)));
  s.tripped = num(o.tripped, 0) | 0;
  return s;
}
