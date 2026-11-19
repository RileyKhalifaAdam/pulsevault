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
//   * session.ts tick loop, at every tick boundary (1×) and every quantum boundary (warp):
//       const h = systemsDue(st, world.tick, quantumTicks, armed || lit); if (h) systemsStep(sys, st, inp, h);
//     = every 12 ticks (h = 0.1 s) at 1×; under warp every K whole quanta, K·q ≤ WARP_SPAN_S = 120 s (q = 2¹¹ ticks:
//     K = 7, h = 119.5 s = 4 implicit sub-steps of 29.9 s; review D8), and every quantum while the drive is armed or
//     lit. Budget-independent (keyed to quanta, st.tick saved). heatIn accumulates J across the span (§1.4). Before
//     the call fill inp:
//       env (thermal.ts ENV_*; craft axes), heatIn (= c.heatIn, J since last call; zeroed here), shutters,
//       radiatorHealth, power.demand (data/powerNet.ts L_*), power.fault, power.driveArmed (DRIVE ARM), power.lit,
//       power.docked, pumpCmd, fan (life-support fan switch), crewW (metabolic W per room), jetPower[e] = ½·F̄_e·vₑ
//       (F̄ = mean engineThrust over the call's span), caution[] external slots (caution.ts header). The scram-guard
//       device resets st.power.scram = 0 (and raises reactorSet).
//   * After it: c.driveInhibit = st.thermal.inhibit; dynamics lights engine e only if out.driveReady && !inhibit and
//     scales its thrust command by min(1, out.driveFrac / DRIVE_READY_FRAC) (flame-out when the drive bus sags);
//     sys.wake ≠ 0 wakes the sleeper; emit 'breaker' events for each bit of sys.newTrips (a = breaker device index,
//     b = 0); W2-F reads sys.pout.lampScale, net.winLight, the node temperatures (radiator and skirt glow).
//   * Replaces: dynamics.ts heat ODE term and the heat ≥ capacity destruction (over-limit skin → W2-C zone health
//     via skinOverLimit), VesselStats.powerOutput/powerDraw (not read by the world today).
//   * Protection (review D1): the interlock is evaluated after EVERY sub-step and fed to powerStep (inp.power.inhibit),
//     which drops the drive standby and sets the reactor back; above SCRAM_LOOP (LOOP_T_SAT − 10 K) or the reactor-bay
//     limit this step scrams the reactor (st.power.scram = 1, reactorSet = 0; the scram-guard device resets it).
//     Lit engines are taken as given for the whole call (the craft integrated that thrust): under warp a burn that
//     crosses the interlock mid-quantum overshoots ≈ 1.7 K per second of burn left in it (the scram backstops).
//   * Master caution (review D5): per-node over-temperature latch st.thermal.hot[] (10 K hysteresis) and pulses — a
//     new hot node or a new breaker trip lights the lamp and wakes even while the slot is already active.
// Cost (node 22, esbuild bundle): 4.2 µs per systems step at h = 0.1 (thermal 2.3 + sources 0.6 + power 0.7 µs);
// 4.6 µs burning; 16.9 µs for one 119.5 s warp call (4 sub-steps). At 10 Hz ≈ 0.0007 ms per frame; at 1e4 warp and
// 60 fps 1.4 calls per frame ≈ 24 µs (≈ 50 µs on the A16, est.), against 41 µs for one call per 17 s quantum.
// §1.2 row "Ship systems": ≤ 0.01 ms per frame at 1×, ≤ 0.1 ms under warp (shared with gas and life support).

import { N_HULL_ZONES } from '../data/hullZones';
import { CIRCUITS, L_COOLER0, L_HEATER0, L_PUMP, LOADS, N_CIRCUITS, N_LOADS } from '../data/powerNet';
import {
  DOOR_G, DRIVE_SKIRT_SHARE, DRIVE_WASTE_EPS, FAN_G, FAN_LINKS, HOT_HYST, HVAC_BAND, HVAC_CARNOT_FRAC, HVAC_COOL_CAP, HVAC_HEAT_CAP, HVAC_COP_MAX, HVAC_COP_MIN,
  HVAC_DEAD, HVAC_SET, HVAC_SINK, INHIBIT_HYST, INHIBIT_LOOP, INHIBIT_SKIRT, LOOP_BYPASS_HI, LOOP_BYPASS_LO, LOOP_TRICKLE,
  N_AVIONICS, N_LOOP, N_RAD0, N_REACTOR, N_ROOM0, N_ROOMS, N_SKIRT0, PUMP_G_MAX, PUMP_LINKS, RAD_EPS, RAD_PANEL_AREA, SCRAM_LOOP,
  SCRAM_REACTOR, WREN_THERMAL,
} from '../data/thermalNet';
import { C_BATTERY, C_BREAKER, C_CABIN_COLD, C_INHIBIT, C_OVERTEMP, C_SCRAM, C_UNDERVOLT, cautionStep, loadCaution, makeCautionState, makeCautionValues, saveCaution, type CautionState } from './caution';
import { loadPower, makePowerInputs, makePowerOut, makePowerState, powerStep, savePower, type PowerInputs, type PowerOut, type PowerState } from './power';
import {
  BOOK_DU, BOOK_IN, BOOK_RAD, BOOK_RES, compileThermal, ENV_LEN, ENV_TBG, loadThermal, makeThermalEnv, makeThermalState, resetLinks,
  saveThermal, SIGMA, THERMAL_TICKS, thermalSources, thermalStep, thermalSubsteps, type ThermalNet, type ThermalNetDef, type ThermalState,
} from './thermal';

export interface SystemsState {
  thermal: ThermalState;
  power: PowerState;
  caution: CautionState;
  /** World tick of the last systemsStep (systemsDue); NaN until the first call after a load. */
  tick: number;
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
  /** Max over nodes of T − T_caution, K (diagnostic; the caution uses the per-node latch thermal.hot). */
  overTemp: number;
  /** Sanitised copy of inp.env used by the last step. */
  env: Float64Array;
  /** Book summed over the sub-steps of the last call: heat in, radiated, ΣCΔT, max |residual|, J. */
  book: Float64Array;
}

const LOAD_NODE = Int32Array.from(LOADS.map((l) => l.node));
const FAULT_NODE = Int32Array.from(CIRCUITS.map((c) => c.faultNode));

export function makeShipSystems(def: ThermalNetDef = WREN_THERMAL): ShipSystems {
  const net = compileThermal(def);
  return {
    def, net, Q: new Float64Array(net.n), pout: makePowerOut(), coolQ: new Float64Array(N_ROOMS), aeroW: new Float64Array(N_HULL_ZONES),
    wake: 0, newTrips: 0, overTemp: -Infinity, env: makeThermalEnv(), book: new Float64Array(4),
  };
}

export function makeSystemsInputs(): SystemsInputs {
  return {
    env: makeThermalEnv(), heatIn: new Array<number>(N_HULL_ZONES).fill(0), shutters: [0, 0, 0, 0], radiatorHealth: [1, 1],
    power: makePowerInputs(), pumpCmd: 1, fan: 1, crewW: new Float64Array(N_ROOMS), jetPower: new Float64Array(2), caution: makeCautionValues(),
  };
}

export function makeSystemsState(def: ThermalNetDef = WREN_THERMAL): SystemsState {
  return { thermal: makeThermalState(def), power: makePowerState(), caution: makeCautionState(), tick: NaN };
}

/** Sim ticks per second (§1.3: Q = 1/120 s). */
export const TICK_HZ = 120;
/** Under warp, the systems step spans about this much sim time (a whole number of quanta; review D8), s. */
export const WARP_SPAN_S = 120;

/**
 * Ticks between systemsStep calls: THERMAL_TICKS (12, 10 Hz) at 1× and whenever a quantum is shorter; under warp the
 * largest whole number of quanta ≤ WARP_SPAN_S (≥ 1), so each call is ceil(h/30) sub-steps of nearly 30 s; exactly
 * one quantum while the drive is armed or lit (the interlock is then checked every quantum and every sub-step).
 * A function of the quantum only, never of the frame budget: the sequence of steps is budget-independent (§1.3).
 */
export function systemsSpanTicks(quantumTicks: number, driveActive: boolean): number {
  if (!(quantumTicks > THERMAL_TICKS)) return THERMAL_TICKS;
  if (driveActive) return quantumTicks;
  const k = Math.floor((WARP_SPAN_S * TICK_HZ) / quantumTicks);
  return (k > 1 ? k : 1) * quantumTicks;
}

/**
 * The scheduler test, called at every tick boundary at 1× and every quantum boundary under warp: returns the h (s)
 * to pass to systemsStep now, or 0 when not due. Records the tick in st.tick (saved).
 */
export function systemsDue(st: SystemsState, tick: number, quantumTicks: number, driveActive: boolean): number {
  const d = tick - st.tick;
  if (!(d >= 0)) { st.tick = tick; return 0; } // first call after a load without a tick
  if (d < systemsSpanTicks(quantumTicks, driveActive)) return 0;
  st.tick = tick;
  return d / TICK_HZ;
}

/** Transcendental wrapper (§1.1 rule 6). */
const expm1_ = (x: number): number => Math.expm1(x);

/**
 * Pumped radiator panel (review D6): the linearised effectiveness–NTU conductance between the loop (the panel inlet)
 * and the panel node (its MEAN temperature Tp), W/K. With N = 4εσTp³·A/(ṁc_p) the outlet approaches the panel's
 * radiative equilibrium as e^−N, Q = ṁc_p(1 − e^−N)(T_in − T_eq), and matching that with a lumped panel gives
 * G = ṁc_p·f(N), f = 1/(1/(1 − e^−N) − 1/N): 2ṁc_p at high flow (linear profile), ṁc_p at low flow.
 */
export function radiatorG(mcp: number, Tp: number, area: number): number {
  if (!(mcp > 0) || !(area > 0)) return 0;
  const t = Tp > 0 ? Tp : 0;
  const N = (4 * RAD_EPS * SIGMA * t * t * t * area) / mcp;
  if (!(N > 1e-4)) return (2 * mcp) / (1 + N / 6);
  const e = -expm1_(-N);
  return (mcp * e * N) / (N - e);
}

const ENV_DEFAULT = makeThermalEnv();
const pos = (v: number): number => (v > 0 && v < 1e30 ? v : 0);

/**
 * Advance the ship's systems by h seconds (constant inputs). Allocation-free. h ≤ 0 or non-finite: no-op (wake 0).
 * Inputs are sanitised (review D4): non-finite env slots read their defaults, non-finite heatIn / jetPower / crewW
 * read 0, so no NaN can enter the network; the interlock, scram and caution tests are NaN-safe regardless.
 */
export function systemsStep(sys: ShipSystems, st: SystemsState, inp: SystemsInputs, h: number): void {
  sys.wake = 0;
  sys.newTrips = 0;
  if (!(h > 0 && h < 1e30)) return;
  const net = sys.net, Q = sys.Q, T = st.thermal.T, dem = inp.power.demand, po = sys.pout, env = sys.env;
  const n = thermalSubsteps(h), hs = h / n;
  for (let i = 0; i < ENV_LEN; i++) { const v = inp.env[i]; env[i] = v > -1e30 && v < 1e30 ? v : ENV_DEFAULT[i]; }
  for (let z = 0; z < N_HULL_ZONES; z++) { const q = inp.heatIn[z]; sys.aeroW[z] = (q > -1e30 && q < 1e30 ? q : 0) / h; inp.heatIn[z] = 0; }
  const jet0 = DRIVE_WASTE_EPS * pos(inp.jetPower[0]), jet1 = DRIVE_WASTE_EPS * pos(inp.jetPower[1]);
  const bk = sys.book;
  bk[0] = 0; bk[1] = 0; bk[2] = 0; bk[3] = 0;
  const pc = inp.pumpCmd > 0 ? (inp.pumpCmd < 1 ? inp.pumpCmd : 1) : 0;
  const fan = inp.fan > 0 ? (inp.fan < 1 ? inp.fan : 1) : 0;
  for (let s = 0; s < n; s++) {
    // --- thermostats (proportional, start-of-step temperatures; gain ≤ 0.5·C/h keeps them stable at any h)
    const Tsink = T[HVAC_SINK];
    for (let r = 0; r < N_ROOMS; r++) {
      const node = N_ROOM0 + r;
      const Tr = T[node];
      const kmax = (0.5 * net.C[node]) / hs;
      const dT = Tr - HVAC_SET;
      sys.coolQ[r] = 0;
      dem[L_HEATER0 + r] = 0;
      dem[L_COOLER0 + r] = 0;
      if (dT > HVAC_DEAD) {
        const cap = HVAC_COOL_CAP[r];
        let K = cap / HVAC_BAND;
        if (K > kmax) K = kmax;
        let q = K * (dT - HVAC_DEAD);
        if (q > cap) q = cap;
        let cop = Tsink > Tr ? (HVAC_CARNOT_FRAC * Tr) / (Tsink - Tr) : HVAC_COP_MAX;
        cop = cop > HVAC_COP_MAX ? HVAC_COP_MAX : cop < HVAC_COP_MIN ? HVAC_COP_MIN : cop;
        sys.coolQ[r] = q;
        dem[L_COOLER0 + r] = q / cop / cap;
      } else if (dT < -HVAC_DEAD) {
        const cap = HVAC_HEAT_CAP[r];
        let K = cap / HVAC_BAND;
        if (K > kmax) K = kmax;
        let q = K * (-dT - HVAC_DEAD);
        if (q > cap) q = cap;
        dem[L_HEATER0 + r] = q / cap;
      }
    }
    // --- radiator flow: pump command through the loop's bypass thermostat (keeps the NaK off its 261 K melt)
    let by = (T[N_LOOP] - LOOP_BYPASS_LO) / (LOOP_BYPASS_HI - LOOP_BYPASS_LO);
    by = by < LOOP_TRICKLE ? LOOP_TRICKLE : by > 1 ? 1 : by;
    dem[L_PUMP] = pc * by;
    // --- electrical system (the interlock drops the drive standby)
    inp.power.inhibit = st.thermal.inhibit ? 1 : 0;
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
    Q[N_SKIRT0] += DRIVE_SKIRT_SHARE * jet0;
    Q[N_SKIRT0 + 1] += DRIVE_SKIRT_SHARE * jet1;
    Q[N_LOOP] += (1 - DRIVE_SKIRT_SHARE) * (jet0 + jet1);
    for (let z = 0; z < N_HULL_ZONES; z++) Q[net.zoneNode[z]] += sys.aeroW[z];
    for (let r = 0; r < N_ROOMS; r++) Q[N_ROOM0 + r] += pos(inp.crewW[r]);
    // --- variable links
    resetLinks(net);
    for (let k = 0; k < PUMP_LINKS.length; k++) {
      let hv = k < inp.radiatorHealth.length ? inp.radiatorHealth[k] : 1;
      hv = hv > 0 ? (hv < 1 ? hv : 1) : 0;
      net.G[PUMP_LINKS[k]] = radiatorG(flow * PUMP_G_MAX * hv, T[N_RAD0 + k], 2 * RAD_PANEL_AREA * hv);
    }
    for (let k = 0; k < FAN_LINKS.length; k++) net.G[FAN_LINKS[k]] = DOOR_G + fan * FAN_G;
    // --- environment and the implicit step
    thermalSources(net, env, inp.shutters, inp.radiatorHealth, Q);
    thermalStep(net, T, Q, hs, env[ENV_TBG]);
    bk[0] += net.book[BOOK_IN]; bk[1] += net.book[BOOK_RAD]; bk[2] += net.book[BOOK_DU];
    if (net.book[BOOK_RES] > bk[3]) bk[3] = net.book[BOOK_RES];
    // --- drive interlock (latched with hysteresis) and the automatic scram, every sub-step, NaN-safe
    const s0 = T[N_SKIRT0], s1 = T[N_SKIRT0 + 1], lp = T[N_LOOP];
    if (st.thermal.inhibit) {
      if (s0 < INHIBIT_SKIRT - INHIBIT_HYST && s1 < INHIBIT_SKIRT - INHIBIT_HYST && lp < INHIBIT_LOOP - INHIBIT_HYST) st.thermal.inhibit = false;
    } else if (!(s0 <= INHIBIT_SKIRT) || !(s1 <= INHIBIT_SKIRT) || !(lp <= INHIBIT_LOOP)) st.thermal.inhibit = true;
    if (!(lp < SCRAM_LOOP) || !(T[N_REACTOR] < SCRAM_REACTOR)) { st.power.scram = 1; st.power.reactorSet = 0; }
  }
  // --- master caution: per-node over-temperature latch (a new hot node is a pulse), breakers, cabin cold
  const hot = st.thermal.hot;
  let pulse = 0, hotN = 0, ot = -Infinity, cold = Infinity;
  for (let i = 0; i < net.n; i++) {
    const t = T[i], c = net.caution[i], d = t - c;
    if (d > ot) ot = d;
    if (hot[i]) { if (t < c - HOT_HYST) hot[i] = 0; } else if (!(t <= c)) { hot[i] = 1; pulse |= 1 << C_OVERTEMP; }
    hotN += hot[i];
  }
  for (let r = 0; r < N_ROOMS; r++) { const t = T[N_ROOM0 + r]; if (t < cold || t !== t) cold = t; }
  if (sys.newTrips) pulse |= 1 << C_BREAKER;
  sys.overTemp = ot;
  const cv = inp.caution;
  cv[C_BATTERY] = st.power.soc;
  cv[C_OVERTEMP] = hotN;
  cv[C_BREAKER] = st.power.tripped ? 1 : 0;
  cv[C_INHIBIT] = st.thermal.inhibit ? 1 : 0;
  cv[C_UNDERVOLT] = po.V;
  cv[C_CABIN_COLD] = cold;
  cv[C_SCRAM] = st.power.scram;
  sys.wake = cautionStep(st.caution, cv, pulse);
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
  return { thermal: saveThermal(st.thermal), power: savePower(st.power), caution: saveCaution(st.caution), tick: st.tick };
}

export function loadSystems(saved: unknown, def: ThermalNetDef = WREN_THERMAL): SystemsState {
  const o = (saved ?? {}) as Partial<Record<keyof SystemsState, unknown>>;
  const tick = typeof o.tick === 'number' && Number.isFinite(o.tick) ? o.tick : NaN;
  return { thermal: loadThermal(o.thermal, def), power: loadPower(o.power), caution: loadCaution(o.caution), tick };
}

export { BOOK_DU, BOOK_IN, BOOK_RAD, BOOK_RES };
