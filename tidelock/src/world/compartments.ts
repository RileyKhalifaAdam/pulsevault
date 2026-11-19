// Compartments: the W3-B sequencer that ties the gas network (cabin.ts) to the doors and hatch (doors.ts), the
// breaches (breach.ts), the airlock and the docking tunnel (airlock.ts) and the vent reaction (vent.ts), and decides
// the gas step: 10 Hz normally, two Q/2 = 4.17 ms sub-steps every tick while VENTING (the plan's "5 ms sub-steps";
// Q/2 is the largest step ≤ 5 ms on the 120 Hz tick grid), and the warp reason `venting`.
//
// Gas temperature (W3-B item 1, "isentropic cooling T ∝ p^((γ−1)/γ), a fog flash below the dew point"): the gas of
// room i is at T_wall,i + ΔT_i, T_wall the thermal network's room node. After each gas step the gas left in a room
// expands adiabatically, T' = T·(N'/N)^(γ−1) (rigid volume: dT/T = (γ−1)·dN/N, the same as T ∝ p^((γ−1)/γ) for the
// resident gas), then relaxes to the walls implicitly with τ_w = N·c_v/(h·A_wall) (h = 10 W/m²K). So a 1 s blowdown is
// nearly isentropic (the lounge gas falls toward ~200 K and fogs) while a 7 h crack is isothermal; the analytic
// adiabatic blowdown p/p₀ = (1 + (γ−1)/2·t/τ)^(−2γ/(γ−1)) and the isothermal e^(−t/τ) are both tests. The heat the
// walls give the gas is an output (qWallW, W into the gas, to take out of the room node); the mist mass per room
// (vapour above saturation at the gas temperature, kg/m³) is an output for W2-F / W3-E.
//
// Venting mode (warp honesty): the implicit gas step is stable at any h but only first-order accurate, so a fast
// transient is resolved, not stepped over. τ_i = max(p_i, 10 kPa)/|dp_i/dt| per room (from the step's depress; the
// airlock while only the pump acts is excluded — the pump is exact at any step); VENTING while ε·min τ < 0.1 s
// (ε = 0.02, i.e. τ < 5 s), with hysteresis (leave above 0.2 s), and forced for one step whenever a vent opening grows
// (a new breach). Outside VENTING the largest honest gas step is ε·τ_min (∞ in a sealed ship): ventingMaxStep is what
// the warp scheduler compares with its quantum (limitedBy 'venting' while smaller). A 1 cm² crack (τ ≈ 6.3 h) allows
// 450 s: sleep warp is untouched. The lounge window: VENTING for ≈ 1.9 s and the warp limited for ≈ 2.8 s, then
// the closed doors hold the rest. A vent that opens INSIDE a warp quantum (a collision under warp) is resolved in Q/2
// sub-steps across that quantum (compartmentsQuantum, ≤ 4096 of them, once).
//
// WIRING (wave 3; session.ts / shipSystems.ts are the hub's):
//   * setup / load: comp = buildWrenCompartments() (data/compartments.ts), c.cabinNet = compileCabin(comp.def),
//     c.compNet = compileCompartments(comp, c.cabinNet); c.comp = loadCompartments(c.compNet, c.cabinNet, saved?.comp)
//     (applies the saved hole geometry to the gas net); a fresh cabin from a pre-wave-3 save: migrateCabinRooms.
//   * Every tick at 1× (session tick loop, after consumeLedger, before the crew and props read the snapshot):
//       if (compartmentsTick(cn, c.comp, net, cabin, io, thermalT, damage, inp)) → the gas was stepped this tick
//     and the 10 Hz systems step must NOT step the gas again (systemsStep calls compartmentsGas(…, 0.1) instead of
//     stepCabinQuantum only when !c.comp.venting). Under warp once per quantum: compartmentsQuantum(…, q).
//   * Warp: quantum ≤ ventingMaxStep(c.comp) or limitedBy 'venting' (api.ts WarpLimit gains 'venting'; world.ts
//     LimitedBy too). The predictor (W3-C) treats c.vent.F as thrust while venting.
//   * After any gas call: ventTotal(c.comp.vent, c.vent) (§1.4 vent), emit 'breach'/'door'/'vent' events from
//     c.comp.out (event kinds the hub adds to events.ts: slamJ per door, ventKg, newBreach), thermal room nodes lose
//     out.qWallW[i], io.roomT for the 11th room (the tunnel) comes from here.
//   * Inputs (CompInputs): docked (0/1), umbilical (0/1, the station's valve), the station's cabin air (boundary 1,
//     default standard air), door motor power, airlock pump switch, damage state (windows), and the mech inputs
//     (crank forces, the crew's pull on the hatch). §1.4: reads zones (via damage), cabin.rooms; writes vent.
// Cost (node 22, esbuild bundle, warmed, best of 6; tests/compartments.test.ts): VENTING tick ≈ 4.7–5 µs (doors + 2
// gas sub-steps + vents + gas temperatures) → ≈ 10 µs per 60 fps frame (≈ 20 µs A16 est., inside the plan's +40 µs
// breach row); quiet tick (doors at rest) 0.35 µs; 10 Hz gas call 3.3 µs (stepCabin on the 11-room, 42-orifice net
// 2.5 µs vs 2.0 µs on W2-D's net); one 17 s quantum 3.7 µs → ≈ 37 µs per frame at 1e4 sleep warp, ≈ 26 µs if the
// hub steps the gas at the systems span (7 quanta, 6 implicit steps: 19 µs per call; RECOMMENDED, see the report).
// --trace-gc: 0 scavenges after warm-up for VENTING ticks, quiet ticks + 10 Hz gas, quanta, and moving doors.

import { IN_H, IN_PUMP, MOLAR_MASS, R_GAS, ROOM_STRIDE, CV_MOLAR, GAMMA, S_H2O, psat } from './life';
import { stepCabinQuantum, stepCabin, type CabinIo, type CabinNet, type CabinState } from './cabin';
import { WALL_H, type WrenCompartments } from '../data/compartments';
import { applyBreachGeometry, breachOpen, breachVent, compileBreach, loadBreach, makeBreachState, saveBreach, type BreachNet, type BreachState } from './breach';
import { compileMech, D_CMD, D_S, D_VALVE, DOOR_STRIDE, doorsAdvance, loadMech, makeMechInputs, makeMechOut, makeMechState, saveMech, type MechInputs, type MechNet, type MechOut, type MechState } from './doors';
import { AL_CLOSE, AL_IDLE, AL_PUMP, AL_VAC, A_PHASE, airlockStep, loadAirlock, makeAirlockOut, makeAirlockState, saveAirlock, setStationAir, type AirlockOut } from './airlock';
import { loadVent, makeVentState, saveVent, VENT_GAS, ventPublish, type VentState } from './vent';
import type { DamageState } from './damage';

const mpow = (x: number, y: number): number => Math.pow(x, y);

/** The tick, s, and the venting sub-step (Q/2). */
export const TICK = 1 / 120;
export const VENT_SUBSTEPS = 2;
/** The normal gas step at 1×, s (12 ticks). */
export const GAS_DT = 0.1;
/** Accuracy: a gas step may be at most VENT_EPS of the shortest pressure time constant. */
export const VENT_EPS = 0.02;
export const VENT_ENTER = GAS_DT;
export const VENT_LEAVE = 2 * GAS_DT;
/** Floor of the pressure in τ = p/|dp/dt|, Pa. */
export const P_TAU_FLOOR = 10e3;
/** Station hatch opens itself (the station crew) below this |Δp|, Pa. */
export const STATION_HATCH_DP = 200;

export interface CompNet {
  comp: WrenCompartments;
  mech: MechNet;
  breach: BreachNet;
  nR: number;
  wallA: Float64Array;
  /** Per vent: CdA of its orifice (for the growth check). */
  ventCdA: Float64Array;
  /** The airlock's door (index into the doors). */
  alDoor: number;
  /** Gas ↔ wall film coefficient, W/(m²·K) (WALL_H; 0 makes every blowdown adiabatic — tests). */
  wallH: number;
}

export interface CompState {
  mech: MechState;
  breach: BreachState;
  airlock: Float64Array;
  /** Gas − wall temperature per room, K. */
  gasDT: Float64Array;
  /** Room pressures (Pa) and their rates (Pa/s) at the end of the last gas step: what the doors' pressure loads and
   *  sensors, the airlock and the dock read between gas steps (kept here, not in the cabin io, so a save holds them). */
  p: Float64Array;
  dep: Float64Array;
  /** 1 while VENTING (gas every tick in Q/2 sub-steps). */
  venting: number;
  /** Shortest pressure time constant of the last gas call, s (Infinity in a still ship). */
  tauMin: number;
  /** Σ CdA of the open vents at the last gas call (a growth forces VENTING). */
  ventCdA: number;
  /** The docked station's hatch, 0/1 (opened by its crew once equalised). */
  stationHatch: number;
  vent: VentState;
}

export interface CompInputs {
  docked: number;
  umbilical: number;
  /** Station cabin (boundary 1) state; null = standard air. */
  stationBnd: Float64Array | null;
  pumpOn: number;
  damage: DamageState | null;
  mech: MechInputs;
}

export interface CompOut {
  /** Heat the walls gave the gas in the last gas call, W per room (take it out of the thermal room node). */
  qWallW: Float64Array;
  /** Condensed mist per room, kg/m³. */
  mist: Float64Array;
  /** Gas temperatures the last gas step used, K. */
  gasT: Float64Array;
  /** Mass vented to space in the last gas call, kg. */
  ventKg: number;
  mech: MechOut;
  airlock: AirlockOut;
}

/** Scratch (never saved). */
export interface CompIo {
  N0: Float64Array;
  inp: CompInputs;
  out: CompOut;
}

export function compileCompartments(comp: WrenCompartments, cnet: CabinNet): CompNet {
  const orificeA = comp.def.orifices.map((o) => o.A);
  const breach = compileBreach(comp.vents, comp.boxes, cnet, orificeA);
  return {
    comp, mech: compileMech(comp.doors, comp.hatch), breach, nR: cnet.nR, wallA: Float64Array.from(comp.wallA),
    ventCdA: Float64Array.from(comp.vents, (v) => cnet.oCdA[v.orifice]),
    alDoor: comp.doors.findIndex((d) => d.a === comp.idx.airlock || d.b === comp.idx.airlock),
    wallH: WALL_H,
  };
}

export function makeCompartments(cn: CompNet): CompState {
  return {
    mech: makeMechState(cn.mech), breach: makeBreachState(cn.breach), airlock: makeAirlockState(), gasDT: new Float64Array(cn.nR),
    p: (() => { const p = new Float64Array(cn.nR).fill(101325); p[cn.comp.idx.tunnel] = 0; return p; })(), dep: new Float64Array(cn.nR),
    venting: 0, tauMin: Infinity, ventCdA: 0, stationHatch: 0, vent: makeVentState(),
  };
}

export function makeCompIo(cn: CompNet): CompIo {
  return {
    N0: new Float64Array(cn.nR),
    inp: { docked: 0, umbilical: 0, stationBnd: null, pumpOn: 1, damage: null, mech: makeMechInputs(cn.mech) },
    out: { qWallW: new Float64Array(cn.nR), mist: new Float64Array(cn.nR), gasT: new Float64Array(cn.nR), ventKg: 0, mech: makeMechOut(cn.mech), airlock: makeAirlockOut() },
  };
}

/** A fresh cabin's tunnel is open to space: start it at vacuum (1e-9 of the default moles). */
export function initTunnel(cn: CompNet, st: CabinState): void {
  const b = cn.comp.idx.tunnel * ROOM_STRIDE;
  for (let s = 0; s < 4; s++) st.rooms[b + s] *= 1e-9;
}

/** A 10-room cabin save (wave 2) → the 11-room network: copy the rooms, add a vacuum tunnel. */
export function migrateCabinRooms(cn: CompNet, saved: number[], st: CabinState): boolean {
  const n = cn.comp.idx.tunnel * ROOM_STRIDE;
  if (!Array.isArray(saved) || saved.length !== n) return false;
  for (let i = 0; i < n; i++) st.rooms[i] = saved[i];
  initTunnel(cn, st);
  return true;
}

// ------------------------------------------------------------------------------------------------ the gas call

/** Σ CdA of the open vents; a growth (a new breach, a vent valve opening) switches VENTING on at once. */
function ventGrowth(cn: CompNet, cs: CompState, open: Float64Array): void {
  let cda = 0;
  const bn = cn.breach;
  for (let i = 0; i < bn.nV; i++) cda += cn.ventCdA[i] * open[bn.orifice[i]];
  if (cda > cs.ventCdA * (1 + 1e-9) + 1e-12) cs.venting = 1;
  cs.ventCdA = cda;
}

/** Before a gas step of h s: openings, airlock, dock, gas temperatures, the moles before. */
function preGas(cn: CompNet, cs: CompState, net: CabinNet, st: CabinState, io: CabinIo, cio: CompIo, thermalT: ArrayLike<number>, roomT0: number, h: number): void {
  const idx = cn.comp.idx, inp = cio.inp, open = io.open, nR = cn.nR;
  // airlock sequencer (its door is a mechanism: the sequencer drives its command; its valve is the repress path)
  const ak = cn.alDoor;
  const ao = cio.out.airlock, ph0 = cs.airlock[A_PHASE];
  const seated = cs.mech.door[ak * DOOR_STRIDE + D_S] <= 0;
  airlockStep(cs.airlock, cs.p[idx.airlock], cs.p[idx.corridor], seated, net.V[idx.airlock], st.rooms[idx.airlock * ROOM_STRIDE + 4], h, inp.pumpOn, ao);
  if (ao.door !== 0) cs.mech.door[ak * DOOR_STRIDE + D_CMD] = ao.door;
  if (cs.airlock[A_PHASE] !== AL_IDLE || ph0 !== AL_IDLE) cs.mech.door[ak * DOOR_STRIDE + D_VALVE] = ao.valve;
  io.inp[IN_PUMP] = ao.pump;
  open[idx.dump] = ao.dump;
  io.monitor[idx.airlock] = cs.airlock[A_PHASE] === AL_IDLE ? 1 : 0;
  open[cn.comp.doors[ak].valve] = cs.mech.door[ak * DOOR_STRIDE + D_VALVE];
  // dock
  const tb = idx.stationBoundary * 6;
  if (inp.stationBnd) for (let s = 0; s < 6; s++) io.bnd[tb + s] = inp.stationBnd[s];
  else setStationAir(io.bnd, idx.stationBoundary);
  const docked = inp.docked > 0;
  if (!docked) cs.stationHatch = 0;
  else if (cs.stationHatch === 0) {
    const d = cs.p[idx.tunnel] - io.bnd[tb];
    if ((d < 0 ? -d : d) < STATION_HATCH_DP) cs.stationHatch = 1;
  }
  open[idx.collar] = docked ? 0 : 1;
  open[idx.umbilical] = docked && (inp.umbilical > 0 || cs.p[idx.tunnel] > 0.5 * io.bnd[tb]) ? 1 : 0;
  open[idx.stationHatch] = cs.stationHatch;
  io.monitor[idx.tunnel] = 0;
  ventGrowth(cn, cs, open);
  // gas temperatures = wall + ΔT; moles before
  const g = st.rooms, gT = cio.out.gasT;
  for (let i = 0; i < nR; i++) {
    const Tw = i === idx.tunnel ? thermalT[roomT0 + idx.corridor] : thermalT[roomT0 + i];
    const T = Tw + cs.gasDT[i];
    io.roomT[i] = T; gT[i] = T;
    const b = i * ROOM_STRIDE;
    cio.N0[i] = g[b] + g[b + 1] + g[b + 2] + g[b + 3];
  }
}

/** After a gas step of h s: vent reaction, isentropic ΔT and wall relaxation, mist, τ and the venting mode. */
function postGas(cn: CompNet, cs: CompState, net: CabinNet, st: CabinState, io: CabinIo, cio: CompIo, thermalT: ArrayLike<number>, roomT0: number, h: number): void {
  const idx = cn.comp.idx, nR = cn.nR, g = st.rooms, out = cio.out;
  out.ventKg += breachVent(cn.breach, cs.breach, net, st, io, out.gasT, h, cs.vent);
  const gm1 = GAMMA - 1;
  let tau = Infinity;
  const pumpOnly = cs.airlock[A_PHASE] === AL_PUMP || cs.airlock[A_PHASE] === AL_VAC || cs.airlock[A_PHASE] === AL_CLOSE;
  for (let i = 0; i < nR; i++) {
    const b = i * ROOM_STRIDE;
    const n0 = g[b], n1 = g[b + 1], n2 = g[b + 2], n3 = g[b + 3], N = n0 + n1 + n2 + n3, N0 = cio.N0[i];
    const Tw = i === idx.tunnel ? thermalT[roomT0 + idx.corridor] : thermalT[roomT0 + i];
    let T = out.gasT[i];
    if (N0 > 0 && N > 0 && N < N0) {
      // adiabatic expansion of the resident gas (filling is left to the thermal net's mixing)
      const x = N / N0 - 1;
      T *= x > -0.05 ? 1 + gm1 * x * (1 + 0.5 * (gm1 - 1) * x) : mpow(N / N0, gm1);
    }
    const Cg = n0 * CV_MOLAR[0] + n1 * CV_MOLAR[1] + n2 * CV_MOLAR[2] + n3 * CV_MOLAR[3];
    const hA = cn.wallH * cn.wallA[i];
    const d1 = T - Tw;
    const dT = Cg > 0 ? d1 * Cg / (Cg + h * hA) : 0; // backward Euler: Cg·(d' − d1)/h = −hA·d'
    out.qWallW[i] = Cg > 0 ? Cg * (dT - d1) / h : 0;
    cs.gasDT[i] = dT;
    // mist: vapour above saturation at the (expansion-cooled) gas temperature; at the wall temperature the
    // life-support water sinks already keep the vapour at or below saturation
    if (dT < -0.1) {
      const Tg = Tw + dT, V = net.V[i];
      const nsat = Tg > 0 ? psat(Tg) * V / (R_GAS * Tg) : 0;
      out.mist[i] = n3 > nsat ? (n3 - nsat) * MOLAR_MASS[S_H2O] / V : 0;
    } else out.mist[i] = 0;
    // pressure time constant
    if (i === idx.airlock && pumpOnly) continue;
    const r = io.depress[i], ar = r < 0 ? -r : r;
    if (ar > 0) { const p = io.p[i] > P_TAU_FLOOR ? io.p[i] : P_TAU_FLOOR; const t = p / ar; if (t < tau) tau = t; }
  }
  cs.tauMin = tau;
  cs.p.set(io.p); cs.dep.set(io.depress);
  const step = VENT_EPS * tau;
  if (cs.venting === 0 && step < VENT_ENTER) cs.venting = 1;
  else if (cs.venting === 1 && step > VENT_LEAVE) cs.venting = 0;
}

/**
 * One gas call of q seconds (stepCabinQuantum inside: ≤ 20 s implicit sub-steps), with every W3-B coupling; books
 * and publishes the vent over q. thermalT = the thermal state's T, roomT0 = thermalNet N_ROOM0. Use this in place of
 * stepCabinQuantum (normal cadence and warp).
 */
export function compartmentsGas(cn: CompNet, cs: CompState, net: CabinNet, st: CabinState, io: CabinIo, cio: CompIo, thermalT: ArrayLike<number>, roomT0: number, q: number): void {
  cio.out.ventKg = 0;
  breachOpen(cn.breach, cs.breach, cio.inp.damage, io.open);
  gasCall(cn, cs, net, st, io, cio, thermalT, roomT0, q);
}

function gasCall(cn: CompNet, cs: CompState, net: CabinNet, st: CabinState, io: CabinIo, cio: CompIo, thermalT: ArrayLike<number>, roomT0: number, q: number): void {
  preGas(cn, cs, net, st, io, cio, thermalT, roomT0, q);
  stepCabinQuantum(net, st, io, q);
  postGas(cn, cs, net, st, io, cio, thermalT, roomT0, q);
  ventPublish(cs.vent, VENT_GAS, q);
}

/**
 * Every tick at 1×: the mechanisms (4 sub-steps), and while VENTING the gas in VENT_SUBSTEPS steps of Q/2 with the
 * vent published over the tick. Returns true when the gas was stepped here (the 10 Hz call must then skip it).
 */
export function compartmentsTick(cn: CompNet, cs: CompState, net: CabinNet, st: CabinState, io: CabinIo, cio: CompIo, thermalT: ArrayLike<number>, roomT0: number): boolean {
  doorsAdvance(cn.mech, cs.mech, cs.p, cs.dep, cio.inp.mech, cio.out.mech, TICK, io.open);
  breachOpen(cn.breach, cs.breach, cio.inp.damage, io.open);
  ventGrowth(cn, cs, io.open);
  if (cs.venting === 0) return false;
  ventFine(cn, cs, net, st, io, cio, thermalT, roomT0, VENT_SUBSTEPS, TICK / VENT_SUBSTEPS);
  ventPublish(cs.vent, VENT_GAS, TICK);
  return true;
}

/** n gas sub-steps of h while VENTING (they stop being VENTING sub-steps only at the next call). */
function ventFine(cn: CompNet, cs: CompState, net: CabinNet, st: CabinState, io: CabinIo, cio: CompIo, thermalT: ArrayLike<number>, roomT0: number, n: number, h: number): void {
  cio.out.ventKg = 0;
  for (let j = 0; j < n; j++) {
    preGas(cn, cs, net, st, io, cio, thermalT, roomT0, h);
    io.inp[IN_H] = h;
    stepCabin(net, st, io);
    postGas(cn, cs, net, st, io, cio, thermalT, roomT0, h);
  }
}

/** n fine gas sub-steps of h s with the vent published over n·h (tests; a hub that wants another sub-step). */
export function compartmentsSubsteps(cn: CompNet, cs: CompState, net: CabinNet, st: CabinState, io: CabinIo, cio: CompIo, thermalT: ArrayLike<number>, roomT0: number, n: number, h: number): void {
  breachOpen(cn.breach, cs.breach, cio.inp.damage, io.open);
  ventFine(cn, cs, net, st, io, cio, thermalT, roomT0, n, h);
  ventPublish(cs.vent, VENT_GAS, n * h);
}

/** Most fine sub-steps one warp quantum may take when a breach opens inside it (17 s at Q/2 = 4096). */
export const MAX_FINE_SUBSTEPS = 4096;

/**
 * Under warp, once per quantum of q s: the mechanisms (exact rest), then one gas call — or, if a vent opened or
 * grew inside the quantum (a collision under warp), the whole quantum in Q/2 sub-steps (≤ MAX_FINE_SUBSTEPS; ≈ 16 ms
 * once in node) so the transient is resolved anyway; the warp is then limited by ventingMaxStep from the next one.
 */
export function compartmentsQuantum(cn: CompNet, cs: CompState, net: CabinNet, st: CabinState, io: CabinIo, cio: CompIo, thermalT: ArrayLike<number>, roomT0: number, q: number): void {
  doorsAdvance(cn.mech, cs.mech, cs.p, cs.dep, cio.inp.mech, cio.out.mech, q, io.open);
  breachOpen(cn.breach, cs.breach, cio.inp.damage, io.open);
  ventGrowth(cn, cs, io.open);
  if (cs.venting === 0) { cio.out.ventKg = 0; gasCall(cn, cs, net, st, io, cio, thermalT, roomT0, q); return; }
  let n = Math.ceil(q / (TICK / VENT_SUBSTEPS) - 1e-9);
  if (n > MAX_FINE_SUBSTEPS) n = MAX_FINE_SUBSTEPS;
  if (n < 1) n = 1;
  ventFine(cn, cs, net, st, io, cio, thermalT, roomT0, n, q / n);
  ventPublish(cs.vent, VENT_GAS, q);
}

/** The largest honest gas step now, s: one tick while VENTING, else ε·τ_min (Infinity in a still ship). */
export function ventingMaxStep(cs: CompState): number {
  return cs.venting ? TICK : VENT_EPS * cs.tauMin;
}

/** The warp reason for a quantum of q s: 'venting' when the gas cannot honestly take it. */
export const ventingLimit = (cs: CompState, q: number): '' | 'venting' => (q > ventingMaxStep(cs) ? 'venting' : '');

// ------------------------------------------------------------------------------------------------ save / load

export interface CompSave {
  mech: { door: number[]; hatch: number[] };
  breach: { hole: number[] };
  airlock: number[];
  gasDT: number[];
  p: number[];
  dep: number[];
  venting: number;
  tauMin: number | null;
  ventCdA: number;
  stationHatch: number;
  vent: ReturnType<typeof saveVent>;
}

export function saveCompartments(cs: CompState): CompSave {
  return {
    mech: saveMech(cs.mech), breach: saveBreach(cs.breach), airlock: saveAirlock(cs.airlock), gasDT: Array.from(cs.gasDT), p: Array.from(cs.p), dep: Array.from(cs.dep),
    venting: cs.venting, tauMin: Number.isFinite(cs.tauMin) ? cs.tauMin : null, ventCdA: cs.ventCdA, stationHatch: cs.stationHatch, vent: saveVent(cs.vent),
  };
}

export function loadCompartments(cn: CompNet, net: CabinNet, raw: unknown): CompState {
  const cs = makeCompartments(cn);
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  cs.mech = loadMech(cn.mech, o.mech);
  cs.breach = loadBreach(cn.breach, o.breach);
  applyBreachGeometry(cn.breach, cs.breach, net);
  cs.airlock = loadAirlock(o.airlock);
  const g = o.gasDT;
  const arr = (a: unknown): a is number[] => Array.isArray(a) && a.length === cn.nR && a.every((x) => typeof x === 'number' && Number.isFinite(x));
  if (arr(g)) cs.gasDT.set(g);
  if (arr(o.p)) cs.p.set(o.p);
  if (arr(o.dep)) cs.dep.set(o.dep);
  cs.venting = o.venting === 1 ? 1 : 0;
  cs.tauMin = typeof o.tauMin === 'number' && Number.isFinite(o.tauMin) ? o.tauMin : Infinity;
  cs.ventCdA = typeof o.ventCdA === 'number' && Number.isFinite(o.ventCdA) ? o.ventCdA : 0;
  cs.stationHatch = o.stationHatch === 1 ? 1 : 0;
  cs.vent = loadVent(o.vent);
  return cs;
}

