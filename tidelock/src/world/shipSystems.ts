// Ship systems step (docs/SIMULATION.md W2-D items 1, 2, 6): one call advances the thermostats, the electrical
// system, the thermal network, the drive interlock and the master caution, in that order, with every coupling
// explicit and energy-consistent: electrical energy delivered to a load appears as heat in that load's node, the
// coolers move heat from a room to the dorsal radiator skin (plus their compressor work), the reactor's waste and
// standby shunt go to the reactor bay, drive waste ε_d·½F·vₑ goes 80/20 to the nozzle skirt and the loop.
//
// WIRING (wave 2):
//   * setup / load (derived, never saved): sys = makeShipSystems() per craft with the Wren network (other hulls:
//     none yet; they keep today's scalar heat until they get a network). State: c.systems = loadSystems(saved?.systems)
//     — §1.4 `thermal.T`, `power.{soc, breakers, reactorSet}` live in it (state.ts may alias c.thermal = st.thermal,
//     c.power = st.power to keep the contract's field names); `driveInhibit` = st.thermal.inhibit.
//   * session.ts tick loop: every THERMAL_TICKS = 12 ticks at 1× call systemsStep(sys, st, inp, 0.1); under warp once
//     per quantum q with h = q (systemsStep sub-steps itself to ≤ 30 s). Before the call fill inp:
//       env (thermal.ts ENV_*; craft axes), heatIn (= c.heatIn, J since last call; zeroed here), shutters,
//       radiatorHealth, power.demand (data/powerNet.ts L_*), power.fault, power.driveArmed (DRIVE ARM), power.lit,
//       power.docked, pumpCmd, fan (life-support fan switch), crewW (metabolic W per room), jetPower[e] = ½·F̄_e·vₑ
//       (F̄ = step-mean engineThrust), caution[] external slots (caution.ts header).
//   * After it: c.driveInhibit = st.thermal.inhibit; dynamics lights engine e only if out.driveReady && !inhibit and
//     scales its thrust command by min(1, out.driveFrac / DRIVE_READY_FRAC) (flame-out when the drive bus sags);
//     sys.wake ≠ 0 wakes the sleeper; emit 'breaker' events for each bit of sys.newTrips (a = breaker device index,
//     b = 0); W2-F reads sys.pout.lampScale, net.winLight, the node temperatures (radiator and skirt glow).
//   * Replaces: dynamics.ts heat ODE term and the heat ≥ capacity destruction (over-limit skin → W2-C zone health
//     via skinOverLimit), VesselStats.powerOutput/powerDraw (not read by the world today).
// Cost (node 22, esbuild bundle): 4.0 µs per systems step (thermal 2.2 + sources 0.6 + power 0.6 µs); 5.0 µs
// burning; 4.4 µs for one 17 s warp step. At 10 Hz ≈ 0.0007 ms per
// frame; at 1e4 warp with q ≈ 17 s, one step per quantum. §1.2 row "Ship systems": ≤ 0.01 ms per frame at 1×.

import { N_HULL_ZONES } from '../data/hullZones';
import { CIRCUITS, L_COOLER0, L_HEATER0, L_PUMP, LOADS, N_CIRCUITS, N_LOADS } from '../data/powerNet';
import {
  DOOR_G, DRIVE_SKIRT_SHARE, DRIVE_WASTE_EPS, FAN_G, FAN_LINKS, HVAC_BAND, HVAC_CAP, HVAC_CARNOT_FRAC, HVAC_COP_MAX, HVAC_COP_MIN,
  HVAC_DEAD, HVAC_SET, HVAC_SINK, INHIBIT_HYST, INHIBIT_LOOP, INHIBIT_SKIRT, LOOP_BYPASS_HI, LOOP_BYPASS_LO, LOOP_TRICKLE,
  N_AVIONICS, N_LOOP, N_REACTOR, N_ROOM0, N_ROOMS, N_SKIRT0, PUMP_G_MAX, PUMP_LINKS, WREN_THERMAL,
} from '../data/thermalNet';
import { C_BATTERY, C_BREAKER, C_INHIBIT, C_OVERTEMP, C_UNDERVOLT, cautionStep, loadCaution, makeCautionState, makeCautionValues, saveCaution, type CautionState } from './caution';
import { loadPower, makePowerInputs, makePowerOut, makePowerState, powerStep, savePower, type PowerInputs, type PowerOut, type PowerState } from './power';
import {
  BOOK_DU, BOOK_IN, BOOK_RAD, BOOK_RES, compileThermal, ENV_TBG, loadThermal, makeThermalEnv, makeThermalState, resetLinks,
  saveThermal, thermalSources, thermalStep, thermalSubsteps, type ThermalNet, type ThermalNetDef, type ThermalState,
} from './thermal';

export interface SystemsState {
  thermal: ThermalState;
  power: PowerState;
  caution: CautionState;
}

export interface SystemsInputs {
  env: Float64Array;
  /** J per hull zone since the last call (§1.4 heatIn); zeroed by systemsStep. */
  heatIn: number[];
  shutters: number[];
  radiatorHealth: number[];
  power: PowerInputs;
  /** Radiator pump command 0..1, life-support fans 0..1. */
  pumpCmd: number;
  fan: number;
  /** Metabolic heat per room, W. */
  crewW: Float64Array;
  /** Jet power ½·F̄·vₑ per engine over the step, W. */
  jetPower: Float64Array;
  /** Master-caution values (caution.ts slots); the session fills the external ones. */
  caution: Float64Array;
}

export interface ShipSystems {
  def: ThermalNetDef;
  net: ThermalNet;
  Q: Float64Array;
  pout: PowerOut;
  /** Per room: cooling heat request (W, ≥ 0) of this sub-step. */
  coolQ: Float64Array;
  aeroW: Float64Array;
  /** Outputs of the last systemsStep. */
  wake: number;
  newTrips: number;
  /** Max over nodes of T − T_caution, K. */
  overTemp: number;
  /** Book summed over the sub-steps of the last call: heat in, radiated, ΣCΔT, max |residual|, J. */
  book: Float64Array;
}

const LOAD_NODE = Int32Array.from(LOADS.map((l) => l.node));
const FAULT_NODE = Int32Array.from(CIRCUITS.map((c) => c.faultNode));

export function makeShipSystems(def: ThermalNetDef = WREN_THERMAL): ShipSystems {
  const net = compileThermal(def);
  return {
    def, net, Q: new Float64Array(net.n), pout: makePowerOut(), coolQ: new Float64Array(N_ROOMS), aeroW: new Float64Array(N_HULL_ZONES),
    wake: 0, newTrips: 0, overTemp: -Infinity, book: new Float64Array(4),
  };
}

export function makeSystemsInputs(): SystemsInputs {
  return {
    env: makeThermalEnv(), heatIn: new Array<number>(N_HULL_ZONES).fill(0), shutters: [0, 0, 0, 0], radiatorHealth: [1, 1],
    power: makePowerInputs(), pumpCmd: 1, fan: 1, crewW: new Float64Array(N_ROOMS), jetPower: new Float64Array(2), caution: makeCautionValues(),
  };
}

export function makeSystemsState(def: ThermalNetDef = WREN_THERMAL): SystemsState {
  return { thermal: makeThermalState(def), power: makePowerState(), caution: makeCautionState() };
}

/** Advance the ship's systems by h seconds (constant inputs). Allocation-free. */
export function systemsStep(sys: ShipSystems, st: SystemsState, inp: SystemsInputs, h: number): void {
  const net = sys.net, Q = sys.Q, T = st.thermal.T, dem = inp.power.demand, po = sys.pout;
  const n = thermalSubsteps(h), hs = h / n;
  for (let z = 0; z < N_HULL_ZONES; z++) { sys.aeroW[z] = (inp.heatIn[z] || 0) / h; inp.heatIn[z] = 0; }
  const bk = sys.book;
  bk[0] = 0; bk[1] = 0; bk[2] = 0; bk[3] = 0;
  sys.newTrips = 0;
  for (let s = 0; s < n; s++) {
    // --- thermostats (proportional, start-of-step temperatures; gain ≤ 0.5·C/h keeps them stable at any h)
    const Tsink = T[HVAC_SINK];
    for (let r = 0; r < N_ROOMS; r++) {
      const node = N_ROOM0 + r, cap = HVAC_CAP[r];
      const Tr = T[node];
      let K = cap / HVAC_BAND;
      const kmax = (0.5 * net.C[node]) / hs;
      if (K > kmax) K = kmax;
      const dT = Tr - HVAC_SET;
      sys.coolQ[r] = 0;
      dem[L_HEATER0 + r] = 0;
      dem[L_COOLER0 + r] = 0;
      if (dT > HVAC_DEAD) {
        let q = K * (dT - HVAC_DEAD);
        if (q > cap) q = cap;
        let cop = Tsink > Tr ? (HVAC_CARNOT_FRAC * Tr) / (Tsink - Tr) : HVAC_COP_MAX;
        cop = cop > HVAC_COP_MAX ? HVAC_COP_MAX : cop < HVAC_COP_MIN ? HVAC_COP_MIN : cop;
        sys.coolQ[r] = q;
        dem[L_COOLER0 + r] = q / cop / cap;
      } else if (dT < -HVAC_DEAD) {
        let q = K * (-dT - HVAC_DEAD);
        if (q > cap) q = cap;
        dem[L_HEATER0 + r] = q / cap;
      }
    }
    // --- radiator flow: pump command through the loop's bypass thermostat (keeps the NaK off its 261 K melt)
    let by = (T[N_LOOP] - LOOP_BYPASS_LO) / (LOOP_BYPASS_HI - LOOP_BYPASS_LO);
    by = by < LOOP_TRICKLE ? LOOP_TRICKLE : by > 1 ? 1 : by;
    const pc = inp.pumpCmd > 0 ? (inp.pumpCmd < 1 ? inp.pumpCmd : 1) : 0;
    dem[L_PUMP] = pc * by;
    // --- electrical system
    powerStep(st.power, inp.power, po, hs);
    sys.newTrips |= po.newTrips;
    const flow = (po.requested[L_PUMP] > 0 ? po.delivered[L_PUMP] / po.requested[L_PUMP] : 0) * pc * by;
    // --- heat sources of this sub-step, W
    const ih = 1 / hs;
    Q.fill(0);
    for (let l = 0; l < N_LOADS; l++) Q[LOAD_NODE[l]] += po.delivered[l] * ih;
    for (let r = 0; r < N_ROOMS; r++) {
      const q = sys.coolQ[r];
      if (q <= 0) continue;
      const rq = po.requested[L_COOLER0 + r];
      const f = rq > 0 ? po.delivered[L_COOLER0 + r] / rq : 0;
      Q[N_ROOM0 + r] -= q * f;
      Q[HVAC_SINK] += q * f;
    }
    for (let c = 0; c < N_CIRCUITS; c++) Q[FAULT_NODE[c]] += po.faultJ[c] * ih;
    Q[N_AVIONICS] += po.battLossJ * ih;
    Q[N_REACTOR] += (po.reactorWasteJ + po.shuntJ) * ih;
    for (let e = 0; e < 2; e++) {
      const w = DRIVE_WASTE_EPS * inp.jetPower[e];
      Q[N_SKIRT0 + e] += DRIVE_SKIRT_SHARE * w;
      Q[N_LOOP] += (1 - DRIVE_SKIRT_SHARE) * w;
    }
    for (let z = 0; z < N_HULL_ZONES; z++) Q[net.zoneNode[z]] += sys.aeroW[z];
    for (let r = 0; r < N_ROOMS; r++) Q[N_ROOM0 + r] += inp.crewW[r];
    // --- variable links
    resetLinks(net);
    for (let k = 0; k < PUMP_LINKS.length; k++) {
      let hv = k < inp.radiatorHealth.length ? inp.radiatorHealth[k] : 1;
      hv = hv > 0 ? (hv < 1 ? hv : 1) : 0;
      net.G[PUMP_LINKS[k]] = flow * PUMP_G_MAX * hv;
    }
    const fan = inp.fan > 0 ? (inp.fan < 1 ? inp.fan : 1) : 0;
    for (let k = 0; k < FAN_LINKS.length; k++) net.G[FAN_LINKS[k]] = DOOR_G + fan * FAN_G;
    // --- environment and the implicit step
    thermalSources(net, inp.env, inp.shutters, inp.radiatorHealth, Q);
    thermalStep(net, T, Q, hs, inp.env[ENV_TBG]);
    bk[0] += net.book[BOOK_IN]; bk[1] += net.book[BOOK_RAD]; bk[2] += net.book[BOOK_DU];
    if (net.book[BOOK_RES] > bk[3]) bk[3] = net.book[BOOK_RES];
  }
  // --- drive interlock (latched with hysteresis)
  const sk = T[N_SKIRT0] > T[N_SKIRT0 + 1] ? T[N_SKIRT0] : T[N_SKIRT0 + 1];
  const lp = T[N_LOOP];
  if (st.thermal.inhibit) {
    if (sk < INHIBIT_SKIRT - INHIBIT_HYST && lp < INHIBIT_LOOP - INHIBIT_HYST) st.thermal.inhibit = false;
  } else if (sk > INHIBIT_SKIRT || lp > INHIBIT_LOOP) st.thermal.inhibit = true;
  // --- master caution
  let ot = -Infinity;
  for (let i = 0; i < net.n; i++) { const d = T[i] - net.caution[i]; if (d > ot) ot = d; }
  sys.overTemp = ot;
  const cv = inp.caution;
  cv[C_BATTERY] = st.power.soc;
  cv[C_OVERTEMP] = ot;
  cv[C_BREAKER] = sys.newTrips ? 1 : 0;
  cv[C_INHIBIT] = st.thermal.inhibit ? 1 : 0;
  cv[C_UNDERVOLT] = po.V;
  sys.wake = cautionStep(st.caution, cv);
}

/** Kelvin above the failure limit per hull zone (its exterior node: the TPS for the belly), for W2-C zone health. */
export function skinOverLimit(sys: ShipSystems, st: SystemsState, out: Float64Array): void {
  const T = st.thermal.T, net = sys.net;
  for (let z = 0; z < N_HULL_ZONES; z++) {
    const a = T[z] - net.limit[z];
    const e = net.zoneNode[z];
    const b = e !== z ? T[e] - net.limit[e] : a;
    const m = a > b ? a : b;
    out[z] = m > 0 ? m : 0;
  }
}

export function saveSystems(st: SystemsState): SystemsState {
  return { thermal: saveThermal(st.thermal), power: savePower(st.power), caution: saveCaution(st.caution) };
}

export function loadSystems(saved: unknown, def: ThermalNetDef = WREN_THERMAL): SystemsState {
  const o = (saved ?? {}) as Partial<Record<keyof SystemsState, unknown>>;
  return { thermal: loadThermal(o.thermal, def), power: loadPower(o.power), caution: loadCaution(o.caution) };
}

export { BOOK_DU, BOOK_IN, BOOK_RAD, BOOK_RES };
