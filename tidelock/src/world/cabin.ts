// Cabin gas network (docs/SIMULATION.md W2-D item 3; the transport core W3-B's breach, doors, airlock and
// draught reuse). Per room: moles of N₂, O₂, CO₂, H₂O and the gas temperature T (the 5 numbers per room of §1.4
// cabin.rooms; T is the thermal network's cabin-air node, latched at each step). p = Σn·R·T/V.
//
// Transport between rooms, one implicit step of size h (10 Hz on the grid at 1×, ≤ MAX_GAS_STEP = 20 s under
// warp: one step per 17.07 s sleep quantum; the §1.3 table's 10 s, raised by review D3 with measured accuracy):
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
// Mixing assumption (review D8): micro-g. There is no buoyancy exchange through a door under felt acceleration
// (landed on Wick, a burn), so with the fans off a heavy-gas pool behaves as in free fall. W3-B can add the
// buoyant door exchange (Q ≈ C·A·√(g·H·Δρ/ρ)) as one more symmetric Qd term without changing the solver.
//
// Draught (the props' and the crew's air; W3-B item 7 owns its behaviour). Two published views, both built only
// from the DEAD-BANDED, HYSTERETIC published flows st.draftQ (below DRAFT_ON = 2e-3 m³/s, ≈ 1 mm/s through a door,
// a flow publishes as exactly 0; it republishes only when the real flow moves by > DRAFT_REL = 5 %), so both are
// CONSTANT between draftEpoch changes and exactly zero in a still ship (fans off, doors equalised):
//   * roomAirVel(net, st, i, out): the room's VOLUME-MEAN air velocity, exact for any incompressible field with
//     those opening fluxes (divergence theorem: ∫u dV = Σ_openings x_k·Q_out,k): a uniform velocity U, constant per
//     epoch, ≈ 0.01 m/s with the fans on. This is the one the W1-C DRIFT and REST closed forms take: in a uniform
//     air velocity the drag closed forms hold in the air's frame (anchor u₀ = v − U, add U·t to the path).
//   * draftAt(net, st, i, x, y, z, out): the local field for CONTACT bodies (and the W4 motes): door / grille
//     sinks and sources u = s·Q/(2π)·(x − x₀)/(|x − x₀|² + a²)^{3/2} (W3-B's u = Q/(2πr²), core a) plus each
//     supply diffuser's round jet (potential core u₀ = Q/(πD²/4) for s < 6.2·D, then u₀·6.2D/s; Schlichting profile
//     u/u_c = (1 + (√2−1)(r/(0.094·s))²)^−2): 0.15 m/s along the supply → return column with the fans on.
//     draftBound(net, st, i) bounds |draftAt − roomAirVel| in the room: a DRIFT schedule uses it as its drag
//     headroom, so a drifting body that might enter the jet ends its segment and is stepped (CONTACT) there.
// Sleep warp is kept: the field changes only on a real change (a fan switch, a door, a breach), never from
// rounding, and the per-step value no longer depends on the step size (review D2: thermal's temperature jump
// once per quantum is ramped across the gas sub-steps by stepCabinQuantum, so the expansion flow each sub-step
// sees is the true mean rate, as at 1×).
//
// WIRING (wave 2; nothing here is called yet):
//   * setup.ts / load: c.cabinNet = compileCabin(buildCabinNet(INTERIORS.wren!)) (src/data/cabinNet.ts; derived,
//     never saved; one per hull type), c.cabinIo = makeCabinIo(c.cabinNet) (scratch + inputs, never saved),
//     c.cabin = loadCabin(c.cabinNet, saved?.cabin, saved?.life) (fresh: newCabin(net)).
//   * The per-step call is the systems step (shipSystems.ts systemsStep, beside thermalStep): every 12 ticks at
//     1× stepCabinQuantum(net, st, io, 0.1); under warp once per quantum stepCabinQuantum(net, st, io, q) (it
//     sub-steps itself, cabinSubsteps(q) steps of ≤ MAX_GAS_STEP = 20 s: ONE step per 17.07 s sleep quantum, and
//     ramps the room temperatures from the last latched value to io.roomT across them). No limitedBy (stable
//     at any h). W3-B's breach declares `venting` and calls it at 5 ms. Per call, BEFORE:
//       io.roomT[i] = thermal.T[N_ROOM0 + i]            (the coupling hook: cabin air = thermal room node, at the
//                                                        END of the interval: thermal steps first)
//       io.paneT[w] = thermal.T[N_PANE0 + WINDOW_GROUP[window w]]
//       io.open[k]  = door k's open fraction (1 in wave 2), breaches (W3-B); io.bnd[8j..] boundary j state
//       io.metab[i] = crew metabolic W per room; io.inp[IN_FANS|IN_PUMP|IN_SCRUB|IN_CHX|IN_REG] = devices × bus
//     AFTER (one systems step later is fine: they are step means): thermal's crew input
//     inp.crewW[r] = io.roomHeat[r] (SENSIBLE heat only — not io.metab, or the latent heat is counted twice),
//     io.paneHeat (latent W per pane), io.out[OUT_CHX_HEAT] and, for the room-to-room air links (instead of
//     thermalNet's constant DOOR_G + FAN_G), G = CP_AIR_MOLAR·io.edgeExch[child room] (W/K).
//     SystemsView: io.p, io.ppO2, io.ppCO2, io.ppH2O, dewPoint(io.ppH2O[i]), st.o2Tank, fogFraction(st.fog[w]).
//     Master caution: caution.ts alone latches (review D7): its C_CO2 = io.out[OUT_PPCO2_MAX], C_O2 =
//     io.out[OUT_PPO2_MIN]; append life.ts CABIN_CAUTIONS (4 slots) fed by OUT_P_MIN, OUT_P_MAX, OUT_DEPRESS_MIN,
//     st.o2Tank / O2_TANK_FULL. Nothing here wakes the sleeper by itself.
//   * props.ts / crew.ts (W1-C bodies): REST and DRIFT bodies use U = roomAirVel(net, st, room) (uniform; the W1-C
//     drift form in the air frame) and draftBound as the neglected-drag headroom; CONTACT bodies use
//     draftAt(net, st, i, x, y, z, out) with draftAccel(k, u, v, out). Air density roomDensity(net, st, i)
//     (replaces quasistatic RHO_CABIN). Re-anchor / re-check bodies only when st.draftEpoch changes
//     (io.out[OUT_DRAFT_CHANGED]).
//   * §1.4 fields: writes cabin.rooms (5 per room: nN2, nO2, nCO2, nH2O, T), life.o2Tank; additive (loader
//     defaults): cabin.fog[], cabin.draftQ[], cabin.draftEpoch, life.condensate.
//   * Save: saveCabin(st) → { cabin, life }; loadCabin(net, cabin, life) → bit-identical continuation.
// Cost (node 22, esbuild bundle, warmed): 2.1–2.4 µs per step (was 2.7–3.1); sleep 1e4 at 60 fps = 9.77 quanta
// per frame × 1 step ≈ 20 µs per frame in node (≈ 0.04 ms A16), under half of the §1.2 'Ship systems' 0.1 ms row
// (thermal + power, shipSystems.ts, are ≈ 43 µs node more at one step per quantum). No allocation at steady state
// (--trace-gc: 0 scavenges after warm-up at q = 0.1 and 17.07 s); the n > 1 sub-step path (q > 20 s) still
// allocates ≈ 0.1 kB per quantum.

import type { CabinNetDef } from '../data/cabinNet';
import {
  CV_MOLAR, GAMMA, IN_CHX, IN_FANS, IN_H, IN_LEN, IN_PPO2_SET, IN_PUMP, IN_REG, IN_SCRUB,
  IN_TCOIL, MOLAR_MASS, N_SPECIES, OUT_AMOUNT_END, OUT_CHX_HEAT, OUT_DEPRESS_MIN, OUT_DRAFT_CHANGED, OUT_HYPOXIA, OUT_LEN,
  OUT_PPCO2_MAX, OUT_PPO2_MIN, OUT_P_MAX, OUT_P_MIN, OUT_VENT0, O2_TANK_FULL, PPO2_SET, CHX_COIL_T, R_GAS,
  R_T, ROOM_STRIDE, S_CO2, S_H2O, S_N2, S_O2, cabinCautionValues, lifeLocal, lifeRegulator, psat,
} from './life';

// ------------------------------------------------------------------------------------------------ wrappers
// (§1.1 rule 6: wave 2 moves them into src/world/math.ts). Load time only; per step only √ (IEEE-exact).
const mpow = (x: number, y: number): number => Math.pow(x, y);

// ------------------------------------------------------------------------------------------------ constants

/** Longest single implicit gas step under warp, s. The §1.3 table says ≤ 10 s; review D3 measured the error of
 *  one step per 17.07 s sleep quantum against 1× at 2.3e-3 in the worst room's ppCO₂ (1.1e-3 at 8.5 s: first
 *  order), so the cap is one sleep quantum (deviation, halves the cost). */
export const MAX_GAS_STEP = 20;
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
/** Hot-loop constants in a typed array: a module-level `const` that is not a literal becomes a `var` in the
 *  esbuild bundle, and V8 boxed the arithmetic on it (measured: ~150 B allocated per step; 0 with this). */
const KC = Float64Array.of(MOLAR_MASS[0], MOLAR_MASS[1], MOLAR_MASS[2], MOLAR_MASS[3], 0, 0, 0);
const K_RSTAR = 4, K_CSTAR = 5, K_YSCALE = 6;
/** Round-jet constants: potential-core length / decay constant (u_c = u₀·B·D/s), half-velocity spreading rate,
 *  the Schlichting profile constant (u = u_c/2 at r = S·s). */
export const JET_B = 6.2;
export const JET_S = 0.094;
const JET_A = Math.SQRT2 - 1;
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

KC[K_RSTAR] = R_STAR; KC[K_CSTAR] = C_STAR; KC[K_YSCALE] = Y_N / (1 - R_STAR);
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
  /** Boundary nodes (0 = space). */
  nB: number;
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
  /** Per opening: supply jet (origin x, y, z, direction x, y, z, diameter D; D = 0: a point source / sink). */
  opJet: Float64Array;
  /** Room centres (x, y, z), for the volume-mean velocity. */
  rC: Float64Array;
  // scratch
  d: Float64Array; up: Float64Array; dn: Float64Array; rhs: Float64Array; x: Float64Array;
  sd: Float64Array; sup: Float64Array; sdn: Float64Array; srhs: Float64Array;
  G: Float64Array; Qd: Float64Array; Qe: Float64Array; N0: Float64Array; irt: Float64Array; Mm: Float64Array; iNp: Float64Array;
  paneAct: Uint8Array; paneTgt: Float64Array;
  wScr: Float64Array;
  nT: number; tSrc: Int32Array; tDst: Int32Array; tC: Float64Array; tOff: Int32Array;
  /** Species off-diagonal slot codes per link direction (see stepCabin), −1 for a boundary link. */
  oOffAB: Int32Array; oOffBA: Int32Array; dOff: Int32Array; oInflow: Float64Array; nNew: Float64Array;
  // stepCabinQuantum scratch: temperatures at the start / end of the quantum, sums of the step outputs
  /** Boundary molar masses of this step (scratch). */
  bM: Float64Array;
  qT0: Float64Array; qT1: Float64Array; qOut: Float64Array; qRoom: Float64Array; qPane: Float64Array; qLink: Float64Array;
}

/** Inputs, outputs and per-craft scratch of a cabin step (never saved). */
export interface CabinIo {
  inp: Float64Array;
  metab: Float64Array;
  open: Float64Array;
  roomT: Float64Array;
  paneT: Float64Array;
  monitor: Uint8Array;
  /** Boundary j state: p (Pa), T (K), then the 4 mole fractions (BND_STRIDE = 6 slots per boundary, net.nB of
   *  them; all start as space: p = 0, T = 3 K). */
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
}

export const BND_STRIDE = 2 + N_SPECIES;

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
  const noJet = [0, 0, 0, 0, 0, 0, 0];
  const ops: { room: number; link: number; sign: number; x: number; y: number; z: number; a: number; jet: number[] }[] = [];
  def.orifices.forEach((o, i) => {
    const a = Math.sqrt(o.A / Math.PI);
    if (o.a >= 0) ops.push({ room: o.a, link: i, sign: -1, x: o.pos.x, y: o.pos.y, z: o.pos.z, a, jet: noJet });
    if (o.b >= 0) ops.push({ room: o.b, link: i, sign: 1, x: o.pos.x, y: o.pos.y, z: o.pos.z, a, jet: noJet });
  });
  def.ducts.forEach((d, i) => {
    if (d.a >= 0) ops.push({ room: d.a, link: nO + i, sign: -1, x: d.inPos.x, y: d.inPos.y, z: d.inPos.z, a: d.grilleR, jet: noJet });
    const jet = d.jetD > 0 ? [d.jetPos.x, d.jetPos.y, d.jetPos.z, d.jetDir.x, d.jetDir.y, d.jetDir.z, d.jetD] : noJet;
    if (d.b >= 0) ops.push({ room: d.b, link: nO + i, sign: 1, x: d.outPos.x, y: d.outPos.y, z: d.outPos.z, a: d.grilleR, jet });
  });
  let nB = def.nBoundary ?? 1;
  for (const o of def.orifices) if (-o.b > nB) nB = -o.b;
  for (const d of def.ducts) if (-d.b > nB) nB = -d.b;
  ops.sort((p, q) => p.room - q.room || p.link - q.link);
  const opStart = new Int32Array(nR + 1);
  for (const o of ops) opStart[o.room + 1]++;
  for (let i = 0; i < nR; i++) opStart[i + 1] += opStart[i];
  return {
    nR, nO, nD, nP, nB, nL: nO + nD, V,
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
    opJet: Float64Array.from(ops.flatMap((o) => o.jet)),
    rC: Float64Array.from(def.rooms.flatMap((r) => [(r.box.min.x + r.box.max.x) / 2, (r.box.min.y + r.box.max.y) / 2, (r.box.min.z + r.box.max.z) / 2])),
    d: new Float64Array(nR), up: new Float64Array(nR), dn: new Float64Array(nR), rhs: new Float64Array(nR), x: new Float64Array(nR),
    sd: new Float64Array(nR), sup: new Float64Array(nR), sdn: new Float64Array(nR), srhs: new Float64Array(nR * N_SPECIES),
    G: new Float64Array(nO), Qd: new Float64Array(nO), Qe: new Float64Array(nD), N0: new Float64Array(nR), irt: new Float64Array(nR), Mm: new Float64Array(nR), iNp: new Float64Array(nR),
    paneAct: new Uint8Array(nP), paneTgt: new Float64Array(nP),
    wScr: new Float64Array(4),
    nT: 0, tSrc: new Int32Array(3 * nO + nD), tDst: new Int32Array(3 * nO + nD), tC: new Float64Array(3 * nO + nD), tOff: new Int32Array(3 * nO + nD),
    oOffAB, oOffBA, dOff,
    oInflow: new Float64Array(nO), nNew: new Float64Array(nR * N_SPECIES),
    bM: new Float64Array(nB), qT0: new Float64Array(nR), qT1: new Float64Array(nR), qOut: new Float64Array(OUT_LEN), qRoom: new Float64Array(5 * nR),
    qPane: new Float64Array(nP), qLink: new Float64Array(nO + nD),
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
    bnd: (() => { const b = new Float64Array(net.nB * BND_STRIDE); for (let j = 0; j < net.nB; j++) b[j * BND_STRIDE + 1] = 3; return b; })(),
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
  return { rooms, o2Tank: O2_TANK_FULL, condensate: 0, fog: new Float64Array(net.nP), draftQ: new Float64Array(net.nL), draftEpoch: 0 };
}

// ------------------------------------------------------------------------------------------------ the step

/**
 * One cabin gas step of io.inp[IN_H] seconds: life.ts local processes, then implicit transport (bulk pressure
 * solve + upwind species solve on the door tree, applied in flux form), the O₂ regulator, then the outputs, the
 * published draught and the caution values. The room temperatures are latched from io.roomT at the start.
 * Allocation-free; deterministic. (Wave 2 calls stepCabinQuantum, which calls this.)
 */
export function stepCabin(net: CabinNet, st: CabinState, io: CabinIo): void {
  const h = io.inp[IN_H];
  const nR = net.nR, g = st.rooms, V = net.V, out = io.out, roomT = io.roomT, N0 = net.N0;
  // ---- the coupling hook: latch the thermal room temperatures; moles before the step
  for (let i = 0, b = 0; i < nR; i++, b += ROOM_STRIDE) {
    g[b + R_T] = roomT[i];
    N0[i] = g[b] + g[b + 1] + g[b + 2] + g[b + 3];
  }
  out[OUT_VENT0] = 0; out[OUT_VENT0 + 1] = 0; out[OUT_VENT0 + 2] = 0; out[OUT_VENT0 + 3] = 0;

  // ---- local processes (crew, scrubber, water)
  lifeLocal(net, st, io);

  // ---- bulk pressure solve: (V/RT)(p' − p) = h·Σ flows(p')
  const d = net.d, up = net.up, dn = net.dn, rhs = net.rhs, x = net.x, P = io.p;
  const irt = net.irt, Mm = net.Mm, iNp = net.iNp;
  for (let i = 0, b = 0; i < nR; i++, b += ROOM_STRIDE) {
    const n0 = g[b], n1 = g[b + 1], n2 = g[b + 2], n3 = g[b + 3];
    const N = n0 + n1 + n2 + n3;
    const ir = 1 / (R_GAS * g[b + R_T]);
    irt[i] = ir;
    Mm[i] = N > 0 ? (n0 * KC[0] + n1 * KC[1] + n2 * KC[2] + n3 * KC[3]) / N : KC[0];
    const C = V[i] * ir;
    P[i] = N / C; // start pressure (after the local processes)
    d[i] = C; rhs[i] = N; up[i] = 0; dn[i] = 0;
  }
  const bnd = io.bnd, open = io.open, oA = net.oA, oB = net.oB, G = net.G, Qdv = net.Qd, oChild = net.oChild;
  const nO = net.nO, nD = net.nD, bM = net.bM;
  // boundary molar masses (into a typed scratch: a call returning a double here would box every Mu of the loop)
  for (let j = 0, b = 2; j < net.nB; j++, b += BND_STRIDE) {
    const m = bnd[b] * KC[0] + bnd[b + 1] * KC[1] + bnd[b + 2] * KC[2] + bnd[b + 3] * KC[3];
    bM[j] = m > 0 ? m : KC[0];
  }
  for (let k = 0; k < nO; k++) {
    const a = oA[k], bb = oB[k];
    const ok = open[k];
    const op = ok > 0 ? (ok < 1 ? ok : 1) : 0;
    G[k] = 0; Qdv[k] = 0;
    if (!(op > 0)) continue;
    const pa = P[a];
    const pb = bb >= 0 ? P[bb] : bnd[(-1 - bb) * BND_STRIDE];
    // upstream state
    let pu: number, pd: number, Tu: number, Mu: number;
    if (pa >= pb) { pu = pa; pd = pb; Tu = g[a * ROOM_STRIDE + R_T]; Mu = Mm[a]; }
    else if (bb >= 0) { pu = pb; pd = pa; Tu = g[bb * ROOM_STRIDE + R_T]; Mu = Mm[bb]; }
    else { pu = pb; pd = pa; Tu = bnd[(-1 - bb) * BND_STRIDE + 1]; Mu = bM[-1 - bb]; }
    const CdA = net.oCdA[k] * op;
    let Gk = 0;
    if (pu > 0) {
      const dp = pu - pd, r = pd / pu;
      if (r <= KC[K_RSTAR]) Gk = CdA * pu * Math.sqrt(GAMMA * Mu / (R_GAS * Tu)) * KC[K_CSTAR] / (Mu * dp);
      else {
        // expansionY(r), inlined by hand: a non-inlined call returns a boxed double (an allocation per orifice)
        let u = (r - KC[K_RSTAR]) * KC[K_YSCALE], Y: number;
        if (u >= Y_N) Y = 1;
        else { const j = u | 0; u -= j; Y = Y_TAB[j] + (Y_TAB[j + 1] - Y_TAB[j]) * u; }
        Gk = CdA * Y * Math.sqrt(2 * pu / (Mu * R_GAS * Tu * (dp + X_LAM))); // √(2ρ)/(M·√(Δp+X))
      }
    }
    G[k] = Gk;
    const e = h * Gk;
    d[a] += e;
    if (bb >= 0) {
      d[bb] += e;
      const ch = oChild[k];
      up[ch] -= e; dn[ch] -= e; // symmetric: rows child/parent, cols parent/child
      // molecular diffusion: an exchange Q_d each way at each side's density
      const Qd = net.oDiffQ[k] * op;
      Qdv[k] = Qd;
      if (Qd > 0) {
        const ea = h * Qd * irt[a], eb = h * Qd * irt[bb];
        d[a] += ea; d[bb] += eb;
        // row b col a gets −ea; row a col b gets −eb
        if (net.oChildIsA[k]) { dn[a] -= ea; up[a] -= eb; } else { up[bb] -= ea; dn[bb] -= eb; }
      }
    } else rhs[a] += e * pb;
  }
  const fans = io.inp[IN_FANS], pump = io.inp[IN_PUMP];
  for (let k = 0; k < nD; k++) {
    const a = net.dA[k], bb = net.dB[k];
    const grp = net.dGroup[k] === 0 ? fans : pump;
    let on = grp > 0 ? (grp < 1 ? grp : 1) : 0;
    const gate = net.dGate[k];
    if (gate >= 0) { const o = open[gate]; on *= o > 0 ? (o < 1 ? o : 1) : 0; }
    const Qe = net.dQ[k] * on;
    net.Qe[k] = Qe;
    if (!(Qe > 0)) continue;
    const e = h * Qe * irt[a];
    d[a] += e;
    if (bb >= 0) { if (net.dChildIsA[k]) dn[a] -= e; else up[bb] -= e; }
  }
  treeSolve1(net, d, up, dn, rhs, x);

  // ---- flows from the solved pressures; species solve (upwind, implicit)
  const sd = net.sd, sup = net.sup, sdn = net.sdn, srhs = net.srhs, edgeExch = io.edgeExch, edgeNet = io.edgeNet;
  for (let i = 0, b = 0, c = 0; i < nR; i++, b += ROOM_STRIDE, c += N_SPECIES) {
    sd[i] = 1; sup[i] = 0; sdn[i] = 0;
    iNp[i] = 1 / (x[i] * V[i] * irt[i]); // 1/N' of the bulk solve (the upwind coefficient's denominator)
    srhs[c] = g[b]; srhs[c + 1] = g[b + 1]; srhs[c + 2] = g[b + 2]; srhs[c + 3] = g[b + 3];
    edgeExch[i] = 0; edgeNet[i] = 0;
  }
  // record the upwind transfers src → dst with coefficient c (fraction of n'_src moved per step) and the
  // off-diagonal slot each one fills (code 2·child + 1: row parent / col child; 2·child: row child / col parent)
  const tSrc = net.tSrc, tDst = net.tDst, tC = net.tC, tOff = net.tOff, linkMol = io.linkMol, oInflow = net.oInflow;
  let nT = 0;
  for (let k = 0; k < nO; k++) {
    const a = oA[k], bb = oB[k];
    const Gk = G[k];
    oInflow[k] = 0;
    if (Gk === 0 && Qdv[k] === 0) { linkMol[k] = 0; continue; } // closed
    const pbN = bb >= 0 ? x[bb] : bnd[(-1 - bb) * BND_STRIDE];
    const q = Gk * (x[a] - pbN); // mol/s, a → b
    linkMol[k] = q;
    if (q > 0) { tSrc[nT] = a; tDst[nT] = bb; tC[nT] = h * q * iNp[a]; tOff[nT] = net.oOffAB[k]; nT++; }
    else if (q < 0) {
      if (bb >= 0) { tSrc[nT] = bb; tDst[nT] = a; tC[nT] = -h * q * iNp[bb]; tOff[nT] = net.oOffBA[k]; nT++; }
      else {
        // inflow from a boundary at its composition (a fixed source of this step)
        const j = (-1 - bb) * BND_STRIDE, amt = -h * q, c = a * N_SPECIES;
        oInflow[k] = amt;
        srhs[c] += amt * bnd[j + 2]; srhs[c + 1] += amt * bnd[j + 3]; srhs[c + 2] += amt * bnd[j + 4]; srhs[c + 3] += amt * bnd[j + 5];
      }
    }
    if (bb >= 0) {
      const Qd = Qdv[k];
      if (Qd > 0) {
        tSrc[nT] = a; tDst[nT] = bb; tC[nT] = h * Qd / V[a]; tOff[nT] = net.oOffAB[k]; nT++;
        tSrc[nT] = bb; tDst[nT] = a; tC[nT] = h * Qd / V[bb]; tOff[nT] = net.oOffBA[k]; nT++;
      }
      const child = oChild[k];
      const qPC = net.oChildIsA[k] ? -q : q; // parent → child
      edgeNet[child] += qPC;
      edgeExch[child] += (qPC < 0 ? -qPC : qPC) + 2 * Qd * x[a] * irt[a];
    }
  }
  for (let k = 0; k < nD; k++) {
    const a = net.dA[k], bb = net.dB[k], Qe = net.Qe[k];
    const f = Qe * x[a] * irt[a];
    linkMol[nO + k] = f;
    if (!(Qe > 0)) continue;
    tSrc[nT] = a; tDst[nT] = bb; tC[nT] = h * Qe / V[a]; tOff[nT] = net.dOff[k]; nT++;
    if (bb >= 0) {
      const child = net.dChild[k];
      const qPC = net.dChildIsA[k] ? -f : f;
      edgeNet[child] += qPC;
      edgeExch[child] += qPC < 0 ? -qPC : qPC;
    }
  }
  net.nT = nT;
  for (let t = 0; t < nT; t++) {
    const c = tC[t], code = tOff[t];
    sd[tSrc[t]] += c;
    if (code >= 0) { if (code & 1) sdn[code >> 1] -= c; else sup[code >> 1] -= c; }
  }
  treeSolve4(net, sd, sup, sdn, srhs);
  for (let i = 0; i < nR; i++) {
    const n = edgeNet[i];
    edgeExch[i] = 0.5 * (edgeExch[i] - (n < 0 ? -n : n));
  }
  // ---- flux form: move the moles by the transfers the implicit solve found (c·n'_src), antisymmetrically from
  // the pre-transport amounts, so every species is conserved to the rounding of the additions (no solver bias)
  const nn = net.nNew;
  for (let i = 0, b = 0, c = 0; i < nR; i++, b += ROOM_STRIDE, c += N_SPECIES) {
    nn[c] = g[b]; nn[c + 1] = g[b + 1]; nn[c + 2] = g[b + 2]; nn[c + 3] = g[b + 3];
  }
  for (let k = 0; k < nO; k++) {
    const amt = oInflow[k];
    if (amt > 0) {
      const c = oA[k] * N_SPECIES, j = (-1 - oB[k]) * BND_STRIDE;
      nn[c] += amt * bnd[j + 2]; nn[c + 1] += amt * bnd[j + 3]; nn[c + 2] += amt * bnd[j + 4]; nn[c + 3] += amt * bnd[j + 5];
    }
  }
  let v0 = 0, v1 = 0, v2 = 0, v3 = 0;
  for (let t = 0; t < nT; t++) {
    const s = tSrc[t] * N_SPECIES, dst = tDst[t], c = tC[t];
    const m0 = c * srhs[s], m1 = c * srhs[s + 1], m2 = c * srhs[s + 2], m3 = c * srhs[s + 3];
    nn[s] -= m0; nn[s + 1] -= m1; nn[s + 2] -= m2; nn[s + 3] -= m3;
    if (dst >= 0) {
      const e = dst * N_SPECIES;
      nn[e] += m0; nn[e + 1] += m1; nn[e + 2] += m2; nn[e + 3] += m3;
    } else { v0 += m0; v1 += m1; v2 += m2; v3 += m3; }
  }
  out[OUT_VENT0] = v0; out[OUT_VENT0 + 1] = v1; out[OUT_VENT0 + 2] = v2; out[OUT_VENT0 + 3] = v3;
  // ---- write back; the O₂ regulator (after transport); outputs
  for (let i = 0, b = 0, c = 0; i < nR; i++, b += ROOM_STRIDE, c += N_SPECIES) {
    const a0 = nn[c], a1 = nn[c + 1], a2 = nn[c + 2], a3 = nn[c + 3];
    g[b] = a0 > 0 ? a0 : 0; g[b + 1] = a1 > 0 ? a1 : 0; g[b + 2] = a2 > 0 ? a2 : 0; g[b + 3] = a3 > 0 ? a3 : 0; // never below round-off
  }
  lifeRegulator(net, st, io);
  const ppO2 = io.ppO2, ppCO2 = io.ppCO2, ppH2O = io.ppH2O, rho = io.rho, dep = io.depress;
  const ih = h > 0 ? 1 / h : 0;
  for (let i = 0, b = 0; i < nR; i++, b += ROOM_STRIDE) {
    const n0 = g[b], n1 = g[b + 1], n2 = g[b + 2], n3 = g[b + 3];
    const N = n0 + n1 + n2 + n3;
    const iV = 1 / V[i];
    const k = R_GAS * g[b + R_T] * iV;
    P[i] = N * k;
    ppO2[i] = n1 * k;
    ppCO2[i] = n2 * k;
    ppH2O[i] = n3 * k;
    rho[i] = (n0 * KC[0] + n1 * KC[1] + n2 * KC[2] + n3 * KC[3]) * iV;
    dep[i] = (N - N0[i]) * k * ih;
  }
  publishDraft(net, st, io);
  cabinCautionValues(net, io);
}

/**
 * Advance the cabin by `q` seconds (1×: q = 0.1; warp: one quantum), in cabinSubsteps(q) equal implicit steps,
 * with the room temperatures ramped linearly from their last latched values to io.roomT (the thermal network's
 * value at the END of the interval) across the sub-steps — so each sub-step's thermal expansion flow is the true
 * mean rate and the published draught does not depend on the step size (review D2). Outputs: amounts (OUT_O2_USED
 * … OUT_CHX_WATER, OUT_VENT0+s) are summed over the sub-steps; powers and flows (roomHeat, paneHeat, OUT_CHX_HEAT,
 * linkMol, edgeExch, edgeNet, depress) are means; caution values are the extremes; p, pp*, rho are the end state.
 * io.inp[IN_H] is set to the sub-step. Allocation-free.
 */
export function stepCabinQuantum(net: CabinNet, st: CabinState, io: CabinIo, q: number): void {
  const n = q <= MAX_GAS_STEP ? 1 : Math.ceil(q / MAX_GAS_STEP) | 0; // = cabinSubsteps(q), inlined (no boxed return)
  io.inp[IN_H] = q / n;
  if (n === 1) { stepCabin(net, st, io); return; }
  const nR = net.nR, nP = net.nP, nL = net.nL, T0 = net.qT0, T1 = net.qT1, roomT = io.roomT, out = io.out;
  const sO = net.qOut, sR = net.qRoom, sP = net.qPane, sL = net.qLink;
  for (let i = 0; i < nR; i++) { T0[i] = st.rooms[i * ROOM_STRIDE + R_T]; T1[i] = roomT[i]; }
  sO.fill(0); sR.fill(0); sP.fill(0); sL.fill(0);
  // extremes (typed scratch, not locals: no boxed phis)
  sO[OUT_PPO2_MIN] = Infinity; sO[OUT_PPCO2_MAX] = -Infinity; sO[OUT_P_MIN] = Infinity; sO[OUT_P_MAX] = -Infinity; sO[OUT_DEPRESS_MIN] = Infinity;
  for (let j = 1; j <= n; j++) {
    if (j < n) { const f = j / n; for (let i = 0; i < nR; i++) roomT[i] = T0[i] + (T1[i] - T0[i]) * f; }
    else for (let i = 0; i < nR; i++) roomT[i] = T1[i];
    stepCabin(net, st, io);
    for (let s = 0; s < OUT_AMOUNT_END; s++) sO[s] += out[s];
    sO[OUT_CHX_HEAT] += out[OUT_CHX_HEAT];
    for (let s = 0; s < N_SPECIES; s++) sO[OUT_VENT0 + s] += out[OUT_VENT0 + s];
    if (out[OUT_HYPOXIA] > sO[OUT_HYPOXIA]) sO[OUT_HYPOXIA] = out[OUT_HYPOXIA];
    if (out[OUT_DRAFT_CHANGED] > sO[OUT_DRAFT_CHANGED]) sO[OUT_DRAFT_CHANGED] = out[OUT_DRAFT_CHANGED];
    if (out[OUT_PPO2_MIN] < sO[OUT_PPO2_MIN]) sO[OUT_PPO2_MIN] = out[OUT_PPO2_MIN];
    if (out[OUT_PPCO2_MAX] > sO[OUT_PPCO2_MAX]) sO[OUT_PPCO2_MAX] = out[OUT_PPCO2_MAX];
    if (out[OUT_P_MIN] < sO[OUT_P_MIN]) sO[OUT_P_MIN] = out[OUT_P_MIN];
    if (out[OUT_P_MAX] > sO[OUT_P_MAX]) sO[OUT_P_MAX] = out[OUT_P_MAX];
    if (out[OUT_DEPRESS_MIN] < sO[OUT_DEPRESS_MIN]) sO[OUT_DEPRESS_MIN] = out[OUT_DEPRESS_MIN];
    for (let i = 0; i < nR; i++) {
      sR[i] += io.roomHeat[i]; sR[nR + i] += io.edgeExch[i]; sR[2 * nR + i] += io.edgeNet[i]; sR[3 * nR + i] += io.depress[i];
    }
    for (let w = 0; w < nP; w++) sP[w] += io.paneHeat[w];
    for (let k = 0; k < nL; k++) sL[k] += io.linkMol[k];
  }
  const inv = 1 / n;
  sO[OUT_CHX_HEAT] *= inv;
  for (let s = 0; s < OUT_LEN; s++) out[s] = sO[s];
  for (let i = 0; i < nR; i++) {
    io.roomHeat[i] = sR[i] * inv; io.edgeExch[i] = sR[nR + i] * inv; io.edgeNet[i] = sR[2 * nR + i] * inv; io.depress[i] = sR[3 * nR + i] * inv;
  }
  for (let w = 0; w < nP; w++) io.paneHeat[w] = sP[w] * inv;
  for (let k = 0; k < nL; k++) io.linkMol[k] = sL[k] * inv;
}

/**
 * Tree elimination for an M-matrix with nonzeros on the diagonal `d` and the tree edges: up[i] = A(i, parent),
 * dn[i] = A(parent, i); one right-hand side; the solution goes to `x`. d and rhs are destroyed.
 */
function treeSolve1(net: CabinNet, d: Float64Array, up: Float64Array, dn: Float64Array, rhs: Float64Array, x: Float64Array): void {
  const order = net.order, parent = net.parent, n = net.nR;
  for (let q = n - 1; q >= 0; q--) {
    const i = order[q], p = parent[i];
    if (p < 0) continue;
    const f = dn[i] / d[i];
    d[p] -= f * up[i];
    rhs[p] -= f * rhs[i];
  }
  for (let q = 0; q < n; q++) {
    const i = order[q], p = parent[i];
    x[i] = (p >= 0 ? rhs[i] - up[i] * x[p] : rhs[i]) / d[i];
  }
}

/** The same with the 4 species right-hand sides interleaved in rhs (stride 4), solved in place. */
function treeSolve4(net: CabinNet, d: Float64Array, up: Float64Array, dn: Float64Array, r: Float64Array): void {
  const order = net.order, parent = net.parent, n = net.nR;
  for (let q = n - 1; q >= 0; q--) {
    const i = order[q], p = parent[i];
    if (p < 0) continue;
    const f = dn[i] / d[i];
    d[p] -= f * up[i];
    const a = 4 * p, b = 4 * i;
    r[a] -= f * r[b]; r[a + 1] -= f * r[b + 1]; r[a + 2] -= f * r[b + 2]; r[a + 3] -= f * r[b + 3];
  }
  for (let q = 0; q < n; q++) {
    const i = order[q], p = parent[i];
    const inv = 1 / d[i], b = 4 * i;
    if (p >= 0) {
      const u = up[i], a = 4 * p;
      r[b] = (r[b] - u * r[a]) * inv; r[b + 1] = (r[b + 1] - u * r[a + 1]) * inv;
      r[b + 2] = (r[b + 2] - u * r[a + 2]) * inv; r[b + 3] = (r[b + 3] - u * r[a + 3]) * inv;
    } else { r[b] *= inv; r[b + 1] *= inv; r[b + 2] *= inv; r[b + 3] *= inv; }
  }
}

// ------------------------------------------------------------------------------------------------ draught

function publishDraft(net: CabinNet, st: CabinState, io: CabinIo): void {
  let changed = 0;
  const g = st.rooms, P = io.p, linkMol = io.linkMol, draftQ = st.draftQ, nO = net.nO, nL = net.nL;
  for (let k = 0; k < nL; k++) {
    let Qv: number;
    if (k < nO) {
      const q = linkMol[k];
      if (q === 0) Qv = 0;
      else {
        const up = q >= 0 ? net.oA[k] : net.oB[k];
        if (up >= 0) Qv = P[up] > 0 ? q * R_GAS * g[up * ROOM_STRIDE + R_T] / P[up] : 0;
        else { const j = (-1 - up) * BND_STRIDE; Qv = io.bnd[j] > 0 ? q * R_GAS * io.bnd[j + 1] / io.bnd[j] : 0; }
      }
    } else Qv = net.Qe[k - nO];
    const pub = draftQ[k];
    const aQ = Qv < 0 ? -Qv : Qv;
    let next = pub;
    if (pub === 0) { if (aQ >= DRAFT_ON) next = Qv; }
    else if (aQ < DRAFT_OFF) next = 0;
    else { const dq = Qv - pub; if ((dq < 0 ? -dq : dq) > DRAFT_REL * (pub < 0 ? -pub : pub)) next = Qv; }
    if (next !== pub) { draftQ[k] = next; changed = 1; }
  }
  if (changed) st.draftEpoch++;
  io.out[OUT_DRAFT_CHANGED] = changed;
}

/**
 * Local air velocity (ship axes, m/s) at (x, y, z) in room i from the published draught; out[0..2]: the door and
 * grille sinks / sources plus the supply diffusers' jets (header). For CONTACT bodies and the motes. Exactly 0
 * when nothing is published (fans off, doors equalised).
 */
export function draftAt(net: CabinNet, st: CabinState, i: number, x: number, y: number, z: number, out: Float64Array): void {
  let ux = 0, uy = 0, uz = 0;
  const J = net.opJet, P = net.opPos;
  for (let o = net.opStart[i]; o < net.opStart[i + 1]; o++) {
    const Q = st.draftQ[net.opLink[o]];
    if (Q === 0) continue;
    const D = J[7 * o + 6];
    if (D > 0) {
      // supply jet (Q > 0 is a supply into this room; a reversed duct cannot happen: fans only push)
      const j = 7 * o;
      const dx = x - J[j], dy = y - J[j + 1], dz = z - J[j + 2];
      const ex = J[j + 3], ey = J[j + 4], ez = J[j + 5];
      const s = dx * ex + dy * ey + dz * ez;
      if (!(s > 0)) continue;
      const r2 = dx * dx + dy * dy + dz * dz - s * s;
      const core = JET_B * D;
      const se = s > core ? s : core;
      const u0 = (Q < 0 ? -Q : Q) / (0.25 * Math.PI * D * D);
      const uc = u0 * core / se;
      const w = JET_S * se;
      const f = 1 + JET_A * (r2 > 0 ? r2 : 0) / (w * w);
      const u = uc / (f * f);
      ux += u * ex; uy += u * ey; uz += u * ez;
      continue;
    }
    const dx = x - P[3 * o], dy = y - P[3 * o + 1], dz = z - P[3 * o + 2];
    const a = net.opCore[o];
    const r2 = dx * dx + dy * dy + dz * dz + a * a;
    const s = net.opSign[o] * Q / (2 * Math.PI * r2 * Math.sqrt(r2));
    ux += s * dx; uy += s * dy; uz += s * dz;
  }
  out[0] = ux; out[1] = uy; out[2] = uz;
}

/**
 * The volume-mean air velocity of room i (ship axes, m/s), out[0..2]: exact for any incompressible field with the
 * published opening fluxes (divergence theorem: V·Ū = Σ_k (x_k − c)·Q_out,k). Uniform and constant per
 * draftEpoch: the air velocity the W1-C REST / DRIFT closed forms take. 0 when nothing is published.
 */
export function roomAirVel(net: CabinNet, st: CabinState, i: number, out: Float64Array): void {
  let sx = 0, sy = 0, sz = 0;
  const P = net.opPos, c = net.rC;
  for (let o = net.opStart[i]; o < net.opStart[i + 1]; o++) {
    const Q = st.draftQ[net.opLink[o]];
    if (Q === 0) continue;
    const qo = -net.opSign[o] * Q; // outflow through this opening
    sx += qo * (P[3 * o] - c[3 * i]); sy += qo * (P[3 * o + 1] - c[3 * i + 1]); sz += qo * (P[3 * o + 2] - c[3 * i + 2]);
  }
  const iV = 1 / net.V[i];
  out[0] = sx * iV; out[1] = sy * iV; out[2] = sz * iV;
}

/** An upper bound of |u| anywhere in room i from draftAt (Σ|Q|/(2πa²) + the jets' face velocities), m/s: with
 *  |roomAirVel| it bounds |draftAt − roomAirVel| for a drift schedule's drag headroom. */
export function draftBound(net: CabinNet, st: CabinState, i: number): number {
  let u = 0;
  for (let o = net.opStart[i]; o < net.opStart[i + 1]; o++) {
    const Q = st.draftQ[net.opLink[o]];
    if (Q === 0) continue;
    const aQ = Q < 0 ? -Q : Q;
    const D = net.opJet[7 * o + 6];
    if (D > 0) u += aQ / (0.25 * Math.PI * D * D);
    else { const a = net.opCore[o]; u += aQ / (2 * Math.PI * a * a); }
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
}
export interface LifeSave {
  o2Tank: number;
  condensate: number;
}

export function saveCabin(st: CabinState): { cabin: CabinSave; life: LifeSave } {
  return {
    cabin: { rooms: Array.from(st.rooms), fog: Array.from(st.fog), draftQ: Array.from(st.draftQ), draftEpoch: st.draftEpoch },
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
