// Cabin gas network (docs/SIMULATION.md W2-D item 3; the transport core W3-B's breach, doors, airlock and
// draught reuse). Per room: moles of N₂, O₂, CO₂, H₂O and the gas temperature T (the 5 numbers per room of §1.4
// cabin.rooms; T is the thermal network's cabin-air node, latched at each step). p = Σn·R·T/V.
//
// Transport between rooms, one implicit step of size h (10 Hz on the grid at 1×, ≤ MAX_GAS_STEP = 10 s under
// warp, the §1.3 table):
//   * Orifices (doors, valves, leaks, breaches): the compressible orifice law, choked below the critical
//     pressure ratio r* = 0.528 (ṁ = C_d·A·p₀·√(γ/(R_s·T₀))·(2/(γ+1))^((γ+1)/(2(γ−1))), 239 kg/s/m² × C_d at
//     101 kPa, 293 K), subsonic ṁ = C_d·A·Y(r)·√(2ρΔp) with the exact isentropic expansion factor Y (a load-time
//     table), regularised below Δp ≈ X_LAM = 0.01 Pa (where the √ law has an infinite slope). Each step uses the
//     law's secant conductance G = ṁ/Δp at the step's start state, so the pressure solve is LINEAR: an
//     M-matrix on the door tree, eliminated leaves → root in O(rooms) (the plan's "elimination on the door
//     tree"). Monotone (no overshoot, Δp keeps its sign), p > 0, unconditionally stable at any h. A secant step
//     is first-order accurate in time: a breach transient is resolved by W3-B's 5 ms sub-steps.
//   * Ducts (ventilation fans, the airlock pump): volumetric flow Q at the inlet's density, ṅ = Q·n/V. A
//     ventilation duct pushes air into the next room and it returns through the door (as on the ISS), so the
//     fan "exchange" between neighbours is a real circulation with a real return draught.
//   * Molecular diffusion through open doors, D·A/L (D = 2e-5 m²/s): the only mixing left with the fans off. In
//     micro-g there is no natural convection, so a sleeper's exhaled CO₂ pools in their cabin (80 W in the 17 m³
//     port cabin reaches the 1 kPa caution in ≈ 12 h with the fans off): the reason real crew quarters have fans.
//   * Species ride the bulk flows upwind, implicitly: one more tree solve with 4 right-hand sides (an M-matrix
//     with unit column sums apart from the outflows, so moles stay ≥ 0 and Σ species = the bulk solve's moles).
//     The solved transfers c·n'_src are then applied in FLUX FORM (subtracted from the source, added to the
//     destination), so every species is conserved to the rounding of the additions, with no solver bias
//     (≤ 1e-15 relative per step, ~1e-14 over 36 000 steps).
// Local processes (crew, scrubber, CHX, panes) are life.ts lifeLocal, applied first (splitting); the O₂ regulator
// (lifeRegulator) acts after the transport, so the rack room ends each step at its setpoint at any h.
//
// Draught (the props' and the crew's air): each opening is a half-space point source/sink of its published
// volumetric flow, u(x) = Σ s·Q/(2π)·(x − x₀)/(|x − x₀|² + a²)^{3/2} (W3-B's u = Q/(2πr²), with a core radius a
// so it is finite at the grille). The published flows (st.draftQ) are a DEAD-BANDED, HYSTERETIC copy of the real
// ones: below DRAFT_ON (2e-3 m³/s, ≈ 1 mm/s through a door) a flow publishes as exactly 0 (the residual flows of a
// quiet ship — crew RQ < 1, the regulator, thermal expansion — are ≤ 1e-4 m³/s), and a published flow changes only
// when the real one moves by > DRAFT_REL (5 %). So with the fans off and the doors equalised the draught is
// EXACTLY zero, and with the fans on it is a constant field: st.draftEpoch advances only on a real change (a fan
// switch, a door, a breach). A loose object therefore never wakes from rounding noise, and sleep warp is kept.
//
// WIRING (wave 2; nothing here is called yet):
//   * setup.ts / load: c.cabinNet = compileCabin(buildCabinNet(INTERIORS.wren!)) (src/data/cabinNet.ts; derived,
//     never saved; one per hull type), c.cabinIo = makeCabinIo(c.cabinNet) (scratch + inputs, never saved),
//     c.cabin = loadCabin(c.cabinNet, saved?.cabin, saved?.life) (fresh: newCabin(net)).
//   * The per-step call is the systems step (shipSystems.ts systemsStep, beside thermalStep), every 12 ticks at
//     1× (h = 0.1 s) and under warp once per quantum with cabinSubsteps(q) steps of ≤ 10 s; no limitedBy (stable
//     at any h). W3-B's breach declares `venting` and runs this same step at 5 ms. Per step, BEFORE stepCabin:
//       io.roomT[i] = thermal.T[N_ROOM0 + i]            (the coupling hook: cabin air = thermal room node)
//       io.paneT[w] = thermal.T[N_PANE0 + WINDOW_GROUP[window w]]
//       io.open[k]  = door k's open fraction (1 in wave 2), breaches (W3-B)
//       io.metab[i] = crew metabolic W per room; io.inp[IN_FANS|IN_PUMP|IN_SCRUB|IN_CHX|IN_REG] = devices × bus
//       io.inp[IN_H] = h; stepCabin(net, c.cabin, io)
//     AFTER: thermal reads io.roomHeat (crew sensible W per room), io.paneHeat (latent W per pane),
//     io.out[OUT_CHX_HEAT] and, for the room-to-room air links (instead of thermalNet's constant DOOR_G + FAN_G),
//     G = CP_AIR_MOLAR·io.edgeExch[child room] (W/K, the symmetric exchange on the edge to its parent).
//     SystemsView: io.p, io.ppO2, io.ppCO2, io.ppH2O, dewPoint(io.ppH2O[i]), st.o2Tank, fogFraction(st.fog[w]).
//     Master caution: io.out[OUT_CAUTION], io.out[OUT_CAUTION_ROSE] (wakes the sleeper).
//   * props.ts / crew.ts (W1-C bodies; W3-B owns the draught behaviour): air velocity at a point of room i is
//     draftAt(net, st, i, x, y, z, out); air density roomDensity(net, st, i) (replaces quasistatic RHO_CABIN);
//     the drag acceleration is draftAccel(k, u, v, out) with W1-C's k = ρ·C_dA/(2m). Re-anchor a drifting or
//     resting body when st.draftEpoch changes; draftBound(net, st, i) bounds |u| in the room for a schedule.
//   * §1.4 fields: writes cabin.rooms (5 per room: nN2, nO2, nCO2, nH2O, T), life.o2Tank; additive (loader
//     defaults): cabin.fog[], cabin.draftQ[], cabin.draftEpoch, cabin.caution, life.condensate.
//   * Save: saveCabin(st) → { cabin, life }; loadCabin(net, cabin, life) → bit-identical continuation.

import type { CabinNetDef } from '../data/cabinNet';
import {
  CV_MOLAR, GAMMA, IN_CHX, IN_FANS, IN_H, IN_LEN, IN_PPO2_SET, IN_PUMP, IN_REG, IN_SCRUB,
  IN_TCOIL, MOLAR_MASS, N_SPECIES, OUT_DRAFT_CHANGED, OUT_LEN, OUT_VENT0, O2_TANK_FULL, PPO2_SET, CHX_COIL_T, R_GAS,
  R_T, ROOM_STRIDE, S_CO2, S_H2O, S_N2, S_O2, cautionUpdate, lifeLocal, lifeRegulator, psat,
} from './life';

// ------------------------------------------------------------------------------------------------ wrappers
// (§1.1 rule 6: wave 2 moves them into src/world/math.ts). Load time only; per step only √ (IEEE-exact).
const mpow = (x: number, y: number): number => Math.pow(x, y);

// ------------------------------------------------------------------------------------------------ constants

/** Longest single implicit gas step under warp, s (§1.3 table). */
export const MAX_GAS_STEP = 10;
/** Gas step on the 1× grid: every 12 ticks of 1/120 s. */
export const GAS_TICKS = 12;
/** Implicit steps for a warp quantum of q seconds. */
export const cabinSubsteps = (q: number): number => (q <= MAX_GAS_STEP ? 1 : Math.ceil(q / MAX_GAS_STEP));

/** Regularisation of the √Δp law below this pressure difference, Pa. */
export const X_LAM = 0.01;
/** Critical pressure ratio and the choked flow function (2/(γ+1))^((γ+1)/(2(γ−1))). */
export const R_STAR = mpow(2 / (GAMMA + 1), GAMMA / (GAMMA - 1));
export const C_STAR = mpow(2 / (GAMMA + 1), (GAMMA + 1) / (2 * (GAMMA - 1)));
/** Molecular diffusivity used for door mixing, m²/s (CO₂, H₂O, O₂ in air: 1.6–2.5e-5). */
export const D_MOL = 2e-5;
/** Draught publication: on / off thresholds (m³/s) and the relative change that republishes. */
export const DRAFT_ON = 2e-3;
export const DRAFT_OFF = 1e-3;
export const DRAFT_REL = 0.05;

/** Default atmosphere (ISS-like): total 101.325 kPa, ppO₂ 21 kPa, ppCO₂ 60 Pa, ppH₂O 1.24 kPa (50 % RH at 294 K). */
export const P_CABIN0 = 101325;
export const PPO2_0 = 21000;
export const PPCO2_0 = 60;
export const PPH2O_0 = 1240;
export const T_CABIN0 = 294;

/** Expansion factor table Y(r), r = p_down/p_up ∈ [R_STAR, 1]: ψ(r)/√(2(1 − r)), ψ the isentropic flow function. */
const Y_N = 64;
const Y_TAB: Float64Array = (() => {
  const t = new Float64Array(Y_N + 1);
  const g = GAMMA;
  for (let j = 0; j <= Y_N; j++) {
    const r = R_STAR + (1 - R_STAR) * (j / Y_N);
    if (j === Y_N) { t[j] = 1; break; }
    const psi = Math.sqrt((2 * g / (g - 1)) * (mpow(r, 2 / g) - mpow(r, (g + 1) / g)));
    t[j] = psi / Math.sqrt(2 * (1 - r));
  }
  return t;
})();

/** Expansion factor Y(r) (linear in the table; Y(1) = 1, Y(r*) = 0.705). */
export function expansionY(r: number): number {
  let u = (r - R_STAR) * (Y_N / (1 - R_STAR));
  if (u <= 0) return Y_TAB[0];
  if (u >= Y_N) return 1;
  const j = u | 0;
  u -= j;
  return Y_TAB[j] + (Y_TAB[j + 1] - Y_TAB[j]) * u;
}

/** Orifice mass flow, kg/s, from up (p_u, T_u, M_u) to down p_d (p_u ≥ p_d), the exact law the step linearises. */
export function orificeMassFlow(CdA: number, pu: number, pd: number, Tu: number, Mu: number): number {
  if (!(pu > 0) || !(pu > pd)) return 0;
  const r = pd / pu;
  if (r <= R_STAR) return CdA * pu * Math.sqrt(GAMMA * Mu / (R_GAS * Tu)) * C_STAR;
  const rho = pu * Mu / (R_GAS * Tu), dp = pu - pd;
  return CdA * Math.sqrt(2 * rho) * expansionY(r) * dp / Math.sqrt(dp + X_LAM);
}

// ------------------------------------------------------------------------------------------------ compiled net

/** The compiled network: typed geometry, the door tree and the solver scratch (never saved; shared by craft). */
export interface CabinNet {
  nR: number;
  nO: number;
  nD: number;
  nP: number;
  /** Links = orifices then ducts (draft and flow arrays use this index). */
  nL: number;
  V: Float64Array;
  // orifices
  oA: Int32Array; oB: Int32Array; oCdA: Float64Array; oDiffQ: Float64Array; oOpen0: Float64Array;
  /** Tree orientation of a room–room link: the child room (−1 for a boundary link) and whether it is end a. */
  oChild: Int32Array; oChildIsA: Uint8Array;
  // ducts
  dA: Int32Array; dB: Int32Array; dQ: Float64Array; dGroup: Int32Array; dGate: Int32Array;
  dChild: Int32Array; dChildIsA: Uint8Array;
  // panes
  pRoom: Int32Array; pA: Float64Array; paneStart: Int32Array; paneList: Int32Array;
  // tree
  parent: Int32Array; order: Int32Array;
  scrubberRoom: number; chxRoom: number; o2Room: number;
  // draught openings per room (CSR): link index, sign (+1: a positive link flow is an inflow here), position, core
  opStart: Int32Array; opLink: Int32Array; opSign: Float64Array; opPos: Float64Array; opCore: Float64Array;
  // scratch
  d: Float64Array; up: Float64Array; dn: Float64Array; rhs: Float64Array; x: Float64Array;
  sd: Float64Array; sup: Float64Array; sdn: Float64Array; srhs: Float64Array;
  G: Float64Array; Qd: Float64Array; Qe: Float64Array; N0: Float64Array; irt: Float64Array; Mm: Float64Array; iNp: Float64Array;
  paneAct: Uint8Array; paneTgt: Float64Array;
  wScr: Float64Array;
  nT: number; tSrc: Int32Array; tDst: Int32Array; tC: Float64Array; tOff: Int32Array;
  /** Species off-diagonal slot codes per link direction (see stepCabin), −1 for a boundary link. */
  oOffAB: Int32Array; oOffBA: Int32Array; dOff: Int32Array; oInflow: Float64Array; nNew: Float64Array;
}

/** Inputs, outputs and per-craft scratch of a cabin step (never saved). */
export interface CabinIo {
  inp: Float64Array;
  metab: Float64Array;
  open: Float64Array;
  roomT: Float64Array;
  paneT: Float64Array;
  monitor: Uint8Array;
  /** Boundary j state: p (Pa), T (K), then the 4 mole fractions (8 slots per boundary; 0 = space). */
  bnd: Float64Array;
  // outputs
  p: Float64Array; ppO2: Float64Array; ppCO2: Float64Array; ppH2O: Float64Array; rho: Float64Array;
  depress: Float64Array;
  roomHeat: Float64Array; paneHeat: Float64Array;
  /** Step-mean molar flow per link (orifices then ducts), a → b positive, mol/s. */
  linkMol: Float64Array;
  /** Per child room: symmetric exchange with its parent (mol/s each way) and net flow parent → child, mol/s. */
  edgeExch: Float64Array; edgeNet: Float64Array;
  out: Float64Array;
}

export interface CabinState {
  /** 5 per room: moles N₂, O₂, CO₂, H₂O, then T (K). */
  rooms: Float64Array;
  /** O₂ tank, kg (§1.4 life.o2Tank). */
  o2Tank: number;
  /** Water in the CHX condensate tank, kg. */
  condensate: number;
  /** Water film per pane, kg/m². */
  fog: Float64Array;
  /** Published draught flow per link, m³/s (a → b positive). */
  draftQ: Float64Array;
  draftEpoch: number;
  /** Latched life-support caution bits (life.ts CAU_*). */
  caution: number;
}

export const N_BOUNDARY = 1;
const BND_STRIDE = 2 + N_SPECIES;

export function compileCabin(def: CabinNetDef): CabinNet {
  const nR = def.rooms.length, nO = def.orifices.length, nD = def.ducts.length, nP = def.panes.length;
  const V = Float64Array.from(def.rooms, (r) => r.V);
  // tree over room–room links (orifices and ducts), BFS from room 0 per component; a cycle is rejected
  const adj: number[][] = def.rooms.map(() => []);
  const addEdge = (a: number, b: number): void => {
    if (a < 0 || b < 0 || a === b) return;
    if (!adj[a].includes(b)) { adj[a].push(b); adj[b].push(a); }
  };
  for (const o of def.orifices) addEdge(o.a, o.b);
  for (const d of def.ducts) addEdge(d.a, d.b);
  const parent = new Int32Array(nR).fill(-2);
  const order = new Int32Array(nR);
  let k = 0;
  const roots = [def.scrubberRoom, ...def.rooms.map((_, i) => i)];
  for (const r0 of roots) {
    if (parent[r0] !== -2) continue;
    parent[r0] = -1;
    order[k++] = r0;
    for (let q = k - 1; q < k; q++) {
      const i = order[q];
      for (const j of adj[i]) {
        if (j === parent[i]) continue;
        if (parent[j] !== -2) throw new Error('cabin: the room links form a loop; the tree solver needs a forest');
        parent[j] = i;
        order[k++] = j;
      }
    }
  }
  const orient = (a: number, b: number): [number, number] => {
    if (a < 0 || b < 0) return [-1, 0];
    if (parent[a] === b) return [a, 1];
    if (parent[b] === a) return [b, 0];
    throw new Error('cabin: link not on the tree');
  };
  const oChild = new Int32Array(nO), oChildIsA = new Uint8Array(nO);
  def.orifices.forEach((o, i) => { const [c, isA] = orient(o.a, o.b); oChild[i] = c; oChildIsA[i] = isA; });
  const dChild = new Int32Array(nD), dChildIsA = new Uint8Array(nD);
  def.ducts.forEach((d, i) => { const [c, isA] = orient(d.a, d.b); dChild[i] = c; dChildIsA[i] = isA; });
  // species off-diagonal slot of a transfer src → dst on the edge with child c: src is the child → (row parent,
  // col child) = 2c + 1; src is the parent → (row child, col parent) = 2c
  const code = (c: number, srcIsChild: boolean): number => (c < 0 ? -1 : 2 * c + (srcIsChild ? 1 : 0));
  const oOffAB = Int32Array.from(def.orifices, (_, i) => code(oChild[i], oChildIsA[i] === 1));
  const oOffBA = Int32Array.from(def.orifices, (_, i) => code(oChild[i], oChildIsA[i] === 0));
  const dOff = Int32Array.from(def.ducts, (_, i) => code(dChild[i], dChildIsA[i] === 1));
  // panes per room
  const paneStart = new Int32Array(nR + 1);
  for (const p of def.panes) paneStart[p.room + 1]++;
  for (let i = 0; i < nR; i++) paneStart[i + 1] += paneStart[i];
  const paneList = new Int32Array(nP);
  const fill = paneStart.slice(0, nR);
  def.panes.forEach((p, w) => { paneList[fill[p.room]++] = w; });
  // draught openings per room
  const ops: { room: number; link: number; sign: number; x: number; y: number; z: number; a: number }[] = [];
  def.orifices.forEach((o, i) => {
    const a = Math.sqrt(o.A / Math.PI);
    if (o.a >= 0) ops.push({ room: o.a, link: i, sign: -1, x: o.pos.x, y: o.pos.y, z: o.pos.z, a });
    if (o.b >= 0) ops.push({ room: o.b, link: i, sign: 1, x: o.pos.x, y: o.pos.y, z: o.pos.z, a });
  });
  def.ducts.forEach((d, i) => {
    if (d.a >= 0) ops.push({ room: d.a, link: nO + i, sign: -1, x: d.inPos.x, y: d.inPos.y, z: d.inPos.z, a: d.grilleR });
    if (d.b >= 0) ops.push({ room: d.b, link: nO + i, sign: 1, x: d.outPos.x, y: d.outPos.y, z: d.outPos.z, a: d.grilleR });
  });
  ops.sort((p, q) => p.room - q.room || p.link - q.link);
  const opStart = new Int32Array(nR + 1);
  for (const o of ops) opStart[o.room + 1]++;
  for (let i = 0; i < nR; i++) opStart[i + 1] += opStart[i];
  return {
    nR, nO, nD, nP, nL: nO + nD, V,
    oA: Int32Array.from(def.orifices, (o) => o.a), oB: Int32Array.from(def.orifices, (o) => o.b),
    oCdA: Float64Array.from(def.orifices, (o) => o.Cd * o.A),
    oDiffQ: Float64Array.from(def.orifices, (o) => (o.b >= 0 && o.L > 0 ? D_MOL * o.A / o.L : 0)),
    oOpen0: Float64Array.from(def.orifices, (o) => o.open0),
    oChild, oChildIsA,
    dA: Int32Array.from(def.ducts, (d) => d.a), dB: Int32Array.from(def.ducts, (d) => d.b),
    dQ: Float64Array.from(def.ducts, (d) => d.Q), dGroup: Int32Array.from(def.ducts, (d) => d.group),
    dGate: Int32Array.from(def.ducts, (d) => d.gate), dChild, dChildIsA,
    pRoom: Int32Array.from(def.panes, (p) => p.room), pA: Float64Array.from(def.panes, (p) => p.A), paneStart, paneList,
    parent, order, scrubberRoom: def.scrubberRoom, chxRoom: def.chxRoom, o2Room: def.o2Room,
    opStart, opLink: Int32Array.from(ops, (o) => o.link), opSign: Float64Array.from(ops, (o) => o.sign),
    opPos: Float64Array.from(ops.flatMap((o) => [o.x, o.y, o.z])), opCore: Float64Array.from(ops, (o) => o.a),
    d: new Float64Array(nR), up: new Float64Array(nR), dn: new Float64Array(nR), rhs: new Float64Array(nR), x: new Float64Array(nR),
    sd: new Float64Array(nR), sup: new Float64Array(nR), sdn: new Float64Array(nR), srhs: new Float64Array(nR * N_SPECIES),
    G: new Float64Array(nO), Qd: new Float64Array(nO), Qe: new Float64Array(nD), N0: new Float64Array(nR), irt: new Float64Array(nR), Mm: new Float64Array(nR), iNp: new Float64Array(nR),
    paneAct: new Uint8Array(nP), paneTgt: new Float64Array(nP),
    wScr: new Float64Array(4),
    nT: 0, tSrc: new Int32Array(3 * nO + nD), tDst: new Int32Array(3 * nO + nD), tC: new Float64Array(3 * nO + nD), tOff: new Int32Array(3 * nO + nD),
    oOffAB, oOffBA, dOff,
    oInflow: new Float64Array(nO), nNew: new Float64Array(nR * N_SPECIES),
  };
}

export function makeCabinIo(net: CabinNet): CabinIo {
  const nR = net.nR;
  const inp = new Float64Array(IN_LEN);
  inp[IN_H] = 0.1; inp[IN_FANS] = 1; inp[IN_PUMP] = 0; inp[IN_SCRUB] = 1; inp[IN_CHX] = 1; inp[IN_REG] = 1;
  inp[IN_TCOIL] = CHX_COIL_T; inp[IN_PPO2_SET] = PPO2_SET;
  return {
    inp, metab: new Float64Array(nR), open: Float64Array.from(net.oOpen0), roomT: new Float64Array(nR).fill(T_CABIN0),
    paneT: new Float64Array(net.nP).fill(T_CABIN0), monitor: new Uint8Array(nR).fill(1),
    bnd: (() => { const b = new Float64Array(N_BOUNDARY * BND_STRIDE); b[1] = 3; return b; })(),
    p: new Float64Array(nR), ppO2: new Float64Array(nR), ppCO2: new Float64Array(nR), ppH2O: new Float64Array(nR),
    rho: new Float64Array(nR), depress: new Float64Array(nR),
    roomHeat: new Float64Array(nR), paneHeat: new Float64Array(net.nP),
    linkMol: new Float64Array(net.nL), edgeExch: new Float64Array(nR), edgeNet: new Float64Array(nR),
    out: new Float64Array(OUT_LEN),
  };
}

/** A fresh cabin at the default atmosphere and T_CABIN0, a full O₂ tank, dry panes, still air. */
export function newCabin(net: CabinNet, T = T_CABIN0): CabinState {
  const rooms = new Float64Array(net.nR * ROOM_STRIDE);
  for (let i = 0; i < net.nR; i++) {
    const c = net.V[i] / (R_GAS * T), b = i * ROOM_STRIDE;
    rooms[b + S_O2] = PPO2_0 * c;
    rooms[b + S_CO2] = PPCO2_0 * c;
    rooms[b + S_H2O] = PPH2O_0 * c;
    rooms[b + S_N2] = (P_CABIN0 - PPO2_0 - PPCO2_0 - PPH2O_0) * c;
    rooms[b + R_T] = T;
  }
  return { rooms, o2Tank: O2_TANK_FULL, condensate: 0, fog: new Float64Array(net.nP), draftQ: new Float64Array(net.nL), draftEpoch: 0, caution: 0 };
}

// ------------------------------------------------------------------------------------------------ the step

/**
 * One cabin gas step of io.inp[IN_H] seconds: life.ts local processes, then implicit transport (bulk pressure
 * solve + upwind species solve on the door tree, applied in flux form), the O₂ regulator, then the outputs, the
 * published draught and the cautions.
 * Allocation-free; deterministic.
 */
export function stepCabin(net: CabinNet, st: CabinState, io: CabinIo): void {
  const h = io.inp[IN_H];
  const nR = net.nR, g = st.rooms, V = net.V, out = io.out;
  // ---- the coupling hook: latch the thermal room temperatures; moles before the step
  for (let i = 0; i < nR; i++) {
    const b = i * ROOM_STRIDE;
    g[b + R_T] = io.roomT[i];
    net.N0[i] = g[b] + g[b + 1] + g[b + 2] + g[b + 3];
  }
  for (let s = 0; s < N_SPECIES; s++) out[OUT_VENT0 + s] = 0;

  // ---- local processes (crew, scrubber, water, regulator)
  lifeLocal(net, st, io);

  // ---- bulk pressure solve: (V/RT)(p' − p) = h·Σ flows(p')
  const d = net.d, up = net.up, dn = net.dn, rhs = net.rhs, x = net.x, P = io.p;
  const irt = net.irt, Mm = net.Mm, iNp = net.iNp;
  for (let i = 0; i < nR; i++) {
    const b = i * ROOM_STRIDE, T = g[b + R_T];
    const N = g[b] + g[b + 1] + g[b + 2] + g[b + 3];
    const ir = 1 / (R_GAS * T);
    irt[i] = ir;
    Mm[i] = N > 0 ? (g[b] * MOLAR_MASS[0] + g[b + 1] * MOLAR_MASS[1] + g[b + 2] * MOLAR_MASS[2] + g[b + 3] * MOLAR_MASS[3]) / N : MOLAR_MASS[S_N2];
    const C = V[i] * ir;
    P[i] = N / C; // start pressure (after the local processes)
    d[i] = C; rhs[i] = N; up[i] = 0; dn[i] = 0;
  }
  const bnd = io.bnd;
  for (let k = 0; k < net.nO; k++) {
    const a = net.oA[k], bb = net.oB[k];
    const open = io.open[k] > 0 ? (io.open[k] < 1 ? io.open[k] : 1) : 0;
    net.G[k] = 0; net.Qd[k] = 0;
    if (!(open > 0)) continue;
    const pa = P[a];
    const pb = bb >= 0 ? P[bb] : bnd[(-1 - bb) * BND_STRIDE];
    // upstream state
    let pu: number, pd: number, Tu: number, Mu: number;
    if (pa >= pb) { pu = pa; pd = pb; Tu = g[a * ROOM_STRIDE + R_T]; Mu = Mm[a]; }
    else if (bb >= 0) { pu = pb; pd = pa; Tu = g[bb * ROOM_STRIDE + R_T]; Mu = Mm[bb]; }
    else { pu = pb; pd = pa; Tu = bnd[(-1 - bb) * BND_STRIDE + 1]; Mu = bndMolarMass(bnd, -1 - bb); }
    const CdA = net.oCdA[k] * open;
    let G = 0;
    if (pu > 0) {
      const dp = pu - pd, r = pd / pu;
      if (r <= R_STAR) G = CdA * pu * Math.sqrt(GAMMA * Mu / (R_GAS * Tu)) * C_STAR / (Mu * dp);
      else {
        const rho = pu * Mu / (R_GAS * Tu);
        G = CdA * Math.sqrt(2 * rho) * expansionY(r) / (Mu * Math.sqrt(dp + X_LAM));
      }
    }
    net.G[k] = G;
    const e = h * G;
    d[a] += e;
    if (bb >= 0) {
      d[bb] += e;
      const ch = net.oChild[k];
      up[ch] -= e; dn[ch] -= e; // symmetric: rows child/parent, cols parent/child
      // molecular diffusion: an exchange Q_d each way at each side's density
      const Qd = net.oDiffQ[k] * open;
      net.Qd[k] = Qd;
      if (Qd > 0) {
        const ea = h * Qd * irt[a], eb = h * Qd * irt[bb];
        d[a] += ea; d[bb] += eb;
        // row b col a gets −ea; row a col b gets −eb
        if (net.oChildIsA[k]) { dn[a] -= ea; up[a] -= eb; } else { up[bb] -= ea; dn[bb] -= eb; }
      }
    } else rhs[a] += e * pb;
  }
  for (let k = 0; k < net.nD; k++) {
    const a = net.dA[k], bb = net.dB[k];
    const grp = net.dGroup[k] === 0 ? io.inp[IN_FANS] : io.inp[IN_PUMP];
    let on = grp > 0 ? (grp < 1 ? grp : 1) : 0;
    const gate = net.dGate[k];
    if (gate >= 0) { const o = io.open[gate]; on *= o > 0 ? (o < 1 ? o : 1) : 0; }
    const Qe = net.dQ[k] * on;
    net.Qe[k] = Qe;
    if (!(Qe > 0)) continue;
    const e = h * Qe * irt[a];
    d[a] += e;
    if (bb >= 0) { if (net.dChildIsA[k]) dn[a] -= e; else up[bb] -= e; }
  }
  treeSolve(net, d, up, dn, rhs, x, 1);

  // ---- flows from the solved pressures; species solve (upwind, implicit)
  const sd = net.sd, sup = net.sup, sdn = net.sdn, srhs = net.srhs;
  for (let i = 0; i < nR; i++) {
    sd[i] = 1; sup[i] = 0; sdn[i] = 0;
    iNp[i] = 1 / (x[i] * V[i] * irt[i]); // 1/N' of the bulk solve (the upwind coefficient's denominator)
    const b = i * ROOM_STRIDE;
    for (let s = 0; s < N_SPECIES; s++) srhs[i * N_SPECIES + s] = g[b + s];
    io.edgeExch[i] = 0; io.edgeNet[i] = 0;
  }
  // record the upwind transfers src → dst with coefficient c (fraction of n'_src moved per step) and the
  // off-diagonal slot each one fills (code 2·child + 1: row parent / col child; 2·child: row child / col parent)
  const tSrc = net.tSrc, tDst = net.tDst, tC = net.tC, tOff = net.tOff;
  let nT = 0;
  for (let k = 0; k < net.nO; k++) {
    const a = net.oA[k], bb = net.oB[k];
    const G = net.G[k];
    const pbN = bb >= 0 ? x[bb] : bnd[(-1 - bb) * BND_STRIDE];
    const q = G * (x[a] - pbN); // mol/s, a → b
    io.linkMol[k] = q;
    net.oInflow[k] = 0;
    if (q > 0) { tSrc[nT] = a; tDst[nT] = bb; tC[nT] = h * q * iNp[a]; tOff[nT] = net.oOffAB[k]; nT++; }
    else if (q < 0) {
      if (bb >= 0) { tSrc[nT] = bb; tDst[nT] = a; tC[nT] = -h * q * iNp[bb]; tOff[nT] = net.oOffBA[k]; nT++; }
      else {
        // inflow from a boundary at its composition (a fixed source of this step)
        const j = (-1 - bb) * BND_STRIDE;
        net.oInflow[k] = -h * q;
        for (let s = 0; s < N_SPECIES; s++) srhs[a * N_SPECIES + s] += -h * q * bnd[j + 2 + s];
      }
    }
    if (bb >= 0) {
      const Qd = net.Qd[k];
      if (Qd > 0) {
        tSrc[nT] = a; tDst[nT] = bb; tC[nT] = h * Qd / V[a]; tOff[nT] = net.oOffAB[k]; nT++;
        tSrc[nT] = bb; tDst[nT] = a; tC[nT] = h * Qd / V[bb]; tOff[nT] = net.oOffBA[k]; nT++;
      }
      const child = net.oChild[k];
      const qPC = net.oChildIsA[k] ? -q : q; // parent → child
      io.edgeNet[child] += qPC;
      io.edgeExch[child] += (qPC < 0 ? -qPC : qPC) + 2 * Qd * x[a] * irt[a];
    }
  }
  for (let k = 0; k < net.nD; k++) {
    const a = net.dA[k], bb = net.dB[k], Qe = net.Qe[k];
    const f = Qe * x[a] * irt[a];
    io.linkMol[net.nO + k] = f;
    if (!(Qe > 0)) continue;
    tSrc[nT] = a; tDst[nT] = bb; tC[nT] = h * Qe / V[a]; tOff[nT] = net.dOff[k]; nT++;
    if (bb >= 0) {
      const child = net.dChild[k];
      const qPC = net.dChildIsA[k] ? -f : f;
      io.edgeNet[child] += qPC;
      io.edgeExch[child] += qPC < 0 ? -qPC : qPC;
    }
  }
  net.nT = nT;
  for (let t = 0; t < nT; t++) {
    const c = tC[t], code = tOff[t];
    sd[tSrc[t]] += c;
    if (code >= 0) { if (code & 1) sdn[code >> 1] -= c; else sup[code >> 1] -= c; }
  }
  treeSolve(net, sd, sup, sdn, srhs, srhs, N_SPECIES);
  for (let i = 0; i < nR; i++) {
    const n = io.edgeNet[i];
    io.edgeExch[i] = 0.5 * (io.edgeExch[i] - (n < 0 ? -n : n));
  }
  // ---- flux form: move the moles by the transfers the implicit solve found (c·n'_src), antisymmetrically from
  // the pre-transport amounts, so every species is conserved to the rounding of the additions (no solver bias)
  const nn = net.nNew;
  for (let i = 0; i < nR; i++) {
    const b = i * ROOM_STRIDE;
    for (let s = 0; s < N_SPECIES; s++) nn[i * N_SPECIES + s] = g[b + s];
  }
  for (let k = 0; k < net.nO; k++) {
    const amt = net.oInflow[k];
    if (amt > 0) {
      const a = net.oA[k], j = (-1 - net.oB[k]) * BND_STRIDE;
      for (let s = 0; s < N_SPECIES; s++) nn[a * N_SPECIES + s] += amt * bnd[j + 2 + s];
    }
  }
  for (let t = 0; t < net.nT; t++) {
    const src = net.tSrc[t], dst = net.tDst[t], c = net.tC[t];
    for (let s = 0; s < N_SPECIES; s++) {
      const m = c * srhs[src * N_SPECIES + s];
      nn[src * N_SPECIES + s] -= m;
      if (dst >= 0) nn[dst * N_SPECIES + s] += m;
      else out[OUT_VENT0 + s] += m;
    }
  }
  // ---- write back; the O₂ regulator (after transport); outputs
  for (let i = 0; i < nR; i++) {
    const b = i * ROOM_STRIDE;
    for (let s = 0; s < N_SPECIES; s++) {
      const n = nn[i * N_SPECIES + s];
      g[b + s] = n > 0 ? n : 0; // never below round-off: the M-matrix keeps n ≥ 0
    }
  }
  lifeRegulator(net, st, io);
  for (let i = 0; i < nR; i++) {
    const b = i * ROOM_STRIDE, T = g[b + R_T];
    const N = g[b] + g[b + 1] + g[b + 2] + g[b + 3];
    const k = R_GAS * T / V[i];
    P[i] = N * k;
    io.ppO2[i] = g[b + S_O2] * k;
    io.ppCO2[i] = g[b + S_CO2] * k;
    io.ppH2O[i] = g[b + S_H2O] * k;
    io.rho[i] = (g[b] * MOLAR_MASS[0] + g[b + 1] * MOLAR_MASS[1] + g[b + 2] * MOLAR_MASS[2] + g[b + 3] * MOLAR_MASS[3]) / V[i];
    io.depress[i] = h > 0 ? (N - net.N0[i]) * k / h : 0;
  }
  publishDraft(net, st, io);
  cautionUpdate(net, st, io);
}

/**
 * Tree elimination for an M-matrix with nonzeros on the diagonal `d` and the tree edges: up[i] = A(i, parent),
 * dn[i] = A(parent, i). `nrhs` right-hand sides interleaved in rhs (stride nrhs); the solution goes to `sol`
 * (may alias rhs; for nrhs = 1 a separate x is used). d and rhs are destroyed.
 */
function treeSolve(net: CabinNet, d: Float64Array, up: Float64Array, dn: Float64Array, rhs: Float64Array, sol: Float64Array, nrhs: number): void {
  const order = net.order, parent = net.parent, n = net.nR;
  for (let q = n - 1; q >= 0; q--) {
    const i = order[q], p = parent[i];
    if (p < 0) continue;
    const f = dn[i] / d[i];
    d[p] -= f * up[i];
    for (let s = 0; s < nrhs; s++) rhs[p * nrhs + s] -= f * rhs[i * nrhs + s];
  }
  for (let q = 0; q < n; q++) {
    const i = order[q], p = parent[i];
    const inv = 1 / d[i];
    for (let s = 0; s < nrhs; s++) {
      const r = rhs[i * nrhs + s] - (p >= 0 ? up[i] * sol[p * nrhs + s] : 0);
      sol[i * nrhs + s] = r * inv;
    }
  }
}

function bndMolarMass(bnd: Float64Array, j: number): number {
  const b = j * BND_STRIDE + 2;
  const m = bnd[b] * MOLAR_MASS[0] + bnd[b + 1] * MOLAR_MASS[1] + bnd[b + 2] * MOLAR_MASS[2] + bnd[b + 3] * MOLAR_MASS[3];
  return m > 0 ? m : MOLAR_MASS[S_N2];
}

// ------------------------------------------------------------------------------------------------ draught

function publishDraft(net: CabinNet, st: CabinState, io: CabinIo): void {
  let changed = 0;
  const g = st.rooms, P = io.p;
  for (let k = 0; k < net.nL; k++) {
    let Qv: number;
    if (k < net.nO) {
      const q = io.linkMol[k];
      const a = net.oA[k], bb = net.oB[k];
      const up = q >= 0 ? a : bb;
      if (up >= 0) Qv = P[up] > 0 ? q * R_GAS * g[up * ROOM_STRIDE + R_T] / P[up] : 0;
      else { const j = (-1 - up) * BND_STRIDE; Qv = io.bnd[j] > 0 ? q * R_GAS * io.bnd[j + 1] / io.bnd[j] : 0; }
    } else Qv = net.Qe[k - net.nO];
    const pub = st.draftQ[k];
    const aQ = Qv < 0 ? -Qv : Qv;
    let next = pub;
    if (pub === 0) { if (aQ >= DRAFT_ON) next = Qv; }
    else if (aQ < DRAFT_OFF) next = 0;
    else { const dq = Qv - pub; if ((dq < 0 ? -dq : dq) > DRAFT_REL * (pub < 0 ? -pub : pub)) next = Qv; }
    if (next !== pub) { st.draftQ[k] = next; changed = 1; }
  }
  if (changed) st.draftEpoch++;
  io.out[OUT_DRAFT_CHANGED] = changed;
}

/** Air velocity (ship axes, m/s) at (x, y, z) in room i from the published draught; out[0..2]. Exactly 0 when
 *  nothing is published (fans off, doors equalised). */
export function draftAt(net: CabinNet, st: CabinState, i: number, x: number, y: number, z: number, out: Float64Array): void {
  let ux = 0, uy = 0, uz = 0;
  for (let o = net.opStart[i]; o < net.opStart[i + 1]; o++) {
    const Q = st.draftQ[net.opLink[o]];
    if (Q === 0) continue;
    const dx = x - net.opPos[3 * o], dy = y - net.opPos[3 * o + 1], dz = z - net.opPos[3 * o + 2];
    const a = net.opCore[o];
    const r2 = dx * dx + dy * dy + dz * dz + a * a;
    const s = net.opSign[o] * Q / (2 * Math.PI * r2 * Math.sqrt(r2));
    ux += s * dx; uy += s * dy; uz += s * dz;
  }
  out[0] = ux; out[1] = uy; out[2] = uz;
}

/** An upper bound of |u| anywhere in room i (Σ|Q|/(2πa²)), m/s: for a drift schedule's drag headroom. */
export function draftBound(net: CabinNet, st: CabinState, i: number): number {
  let u = 0;
  for (let o = net.opStart[i]; o < net.opStart[i + 1]; o++) {
    const Q = st.draftQ[net.opLink[o]];
    const a = net.opCore[o];
    u += (Q < 0 ? -Q : Q) / (2 * Math.PI * a * a);
  }
  return u;
}

/** Quadratic drag acceleration on a body with k = ρ·C_dA/(2m) (W1-C dragK), air u, body v (ship axes): out. */
export function draftAccel(k: number, ux: number, uy: number, uz: number, vx: number, vy: number, vz: number, out: Float64Array): void {
  const rx = ux - vx, ry = uy - vy, rz = uz - vz;
  const m = k * Math.sqrt(rx * rx + ry * ry + rz * rz);
  out[0] = m * rx; out[1] = m * ry; out[2] = m * rz;
}

/** Air density of room i, kg/m³. */
export function roomDensity(net: CabinNet, st: CabinState, i: number): number {
  const b = i * ROOM_STRIDE, g = st.rooms;
  return (g[b] * MOLAR_MASS[0] + g[b + 1] * MOLAR_MASS[1] + g[b + 2] * MOLAR_MASS[2] + g[b + 3] * MOLAR_MASS[3]) / net.V[i];
}

/** Heat capacity of room i's gas, J/K (Σ n·c_v). */
export function roomGasC(st: CabinState, i: number): number {
  const b = i * ROOM_STRIDE, g = st.rooms;
  return g[b] * CV_MOLAR[0] + g[b + 1] * CV_MOLAR[1] + g[b + 2] * CV_MOLAR[2] + g[b + 3] * CV_MOLAR[3];
}

/** Relative humidity of room i (0..1+). */
export function roomRH(io: CabinIo, st: CabinState, i: number): number {
  return io.ppH2O[i] / psat(st.rooms[i * ROOM_STRIDE + R_T]);
}

// ------------------------------------------------------------------------------------------------ save / load

export interface CabinSave {
  rooms: number[];
  fog: number[];
  draftQ: number[];
  draftEpoch: number;
  caution: number;
}
export interface LifeSave {
  o2Tank: number;
  condensate: number;
}

export function saveCabin(st: CabinState): { cabin: CabinSave; life: LifeSave } {
  return {
    cabin: { rooms: Array.from(st.rooms), fog: Array.from(st.fog), draftQ: Array.from(st.draftQ), draftEpoch: st.draftEpoch, caution: st.caution },
    life: { o2Tank: st.o2Tank, condensate: st.condensate },
  };
}

const finite = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);

/** Load with defaults: a missing or mis-sized array gives the fresh value for that part. */
export function loadCabin(net: CabinNet, cabin?: Partial<CabinSave> | null, life?: Partial<LifeSave> | null): CabinState {
  const st = newCabin(net);
  if (cabin) {
    if (Array.isArray(cabin.rooms) && cabin.rooms.length === st.rooms.length && cabin.rooms.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)) st.rooms.set(cabin.rooms);
    if (Array.isArray(cabin.fog) && cabin.fog.length === st.fog.length) st.fog.set(cabin.fog.map((v) => Math.max(0, finite(v, 0))));
    if (Array.isArray(cabin.draftQ) && cabin.draftQ.length === st.draftQ.length) st.draftQ.set(cabin.draftQ.map((v) => finite(v, 0)));
    st.draftEpoch = finite(cabin.draftEpoch, 0);
    st.caution = finite(cabin.caution, 0) | 0;
  }
  if (life) {
    st.o2Tank = Math.max(0, finite(life.o2Tank, O2_TANK_FULL));
    st.condensate = Math.max(0, finite(life.condensate, 0));
  }
  return st;
}

/** Total moles of each species held anywhere (gas + films + condensate + tank), for conservation checks. */
export function inventory(net: CabinNet, st: CabinState, out: Float64Array): void {
  for (let s = 0; s < N_SPECIES; s++) out[s] = 0;
  for (let i = 0; i < net.nR; i++) for (let s = 0; s < N_SPECIES; s++) out[s] += st.rooms[i * ROOM_STRIDE + s];
  for (let w = 0; w < net.nP; w++) out[S_H2O] += st.fog[w] * net.pA[w] / MOLAR_MASS[S_H2O];
  out[S_H2O] += st.condensate / MOLAR_MASS[S_H2O];
  out[S_O2] += st.o2Tank / MOLAR_MASS[S_O2];
}
