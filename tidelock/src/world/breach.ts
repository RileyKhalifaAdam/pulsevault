// Hull breach (docs/SIMULATION.md W3-B item 1): the hole from located damage, the vent reaction, and the flow field's
// force on bodies near the hole. The gas itself flows in src/world/cabin.ts (the compressible orifice law, choked
// below r* = 0.528: 239·C_d kg/s per m² at 101 kPa, 293 K); this file decides the openings, books what leaves, and
// reads the field. compartments.ts sequences it (5 ms-class sub-steps while venting, warp reason `venting`).
//
// Holes:
//   * Windows: from the damage state (damage.ts windowState): cracked → CRACK_A = 1 cm² (the plan's 7.4 h e-fold),
//     broken → the glazed area (the 4.18 m² lounge window). Stateless: derived from `zones` every call.
//   * Panels: a hit of energy E on hull zone z (u = energyDensity, d = crushDepth of that zone, HULL_ZONES) crushes
//     a footprint E/(u·d) through the full crush depth; the pressure shell under it perforates only beyond the
//     energy that crushes the impactor's own footprint (E_perf = u·d·A_f, A_f = 0.05 m²), and a fraction φ = 0.1 of
//     the crushed footprint tears open (petalled skin folds most of it shut): A = φ·(E − E_perf)/(u·d), into the
//     room whose box lies within HULL_REACH of the hit (nearest), merged per room (area-weighted position and
//     normal), capped at HOLE_A_MAX. A dorsal hit of 1 MJ: 0.22 m²; 50 kJ: 0.0061 m² (τ ≈ 16 min for the ship).
//     Saved state (st.hole).
// Vent reaction (per gas step h, per vent orifice k to space from room a): dm = ṅ_k·h·M_a (cabin io.linkMol, the
//   step-mean molar flow the implicit solve moved, so Σdm is exactly the mass the rooms lost to space), at
//   u_eff(p_space/p_a, T_gas,a, M_a) (vent.ts: 537 m/s to vacuum at 293 K), along the hole's outward normal at its
//   exterior point → vent.ts slot VENT_GAS. Losing the lounge window with every door open (tests/breach.test.ts):
//   the doors auto-close and seat within 1.9 s, ≈ 240 kg vent (the plan's 445 kg assumed the whole ship empties),
//   |J| ≈ 111 kN·s, Δv ≈ 1.7 m/s on 67 t, L_y ≈ 0.84 MN·m·s, a yaw rate ≈ 0.16 rad/s (the plan's ≈ 0.2) within ≈ 1 s.
// Force on a body (crew, props) at x in room i: quadratic drag in the local air velocity (cabin draftAt, which holds
//   every opening's sink u = Q/(2π(r² + a²)^{3/2})·(x₀ − x)) PLUS the pressure-gradient (buoyancy) force of the
//   accelerating flow, −V_b·∇p = ½ρV_b·∇|u|² for each open hole's sink (Bernoulli; analytic gradient), which near a
//   hole is as large as the drag for a body of a person's volume. Bodies plugging the hole are not modelled.
//
// WIRING (wave 3): compiled once per hull type (compileBreach, derived); state c.breach = loadBreach(bn, saved?.breach)
//   then applyBreachGeometry(bn, c.breach, c.cabinNet) (the hole positions live in the compiled gas net's opening
//   table). contact.ts / damage hook, after `const c = damageAt(d, m, part, p, n, e)` for the SHIP's share e of a hit
//   that struck a panel (c < N_HULL_ZONES): breachHit(bn, c.breach, c.cabinNet, p, n, e, c) → room (−1: unpressurised).
//   compartments.ts calls breachOpen before every gas step and breachVent after it. props.ts / crew.ts (W3-D): CONTACT
//   bodies in a room with an open hole add ventBodyForce(...) (replaces the plain draftAccel for them). §1.4: reads
//   zones (damage), cabin.rooms; writes vent (via vent.ts). Allocation-free per step.

import { HULL_ZONES, N_HULL_ZONES, DAMAGE_COMPONENTS } from '../data/hullZones';
import { CRACK_A, HOLE_A_MAX, HOLE_PHI, HULL_REACH, PERF_FOOTPRINT, type VentDef } from '../data/compartments';
import type { Box } from '../data/interiors';
import { draftAt, type CabinIo, type CabinNet, type CabinState } from './cabin';
import { windowState, type DamageState } from './damage';
import { MOLAR_MASS, R_GAS, ROOM_STRIDE } from './life';
import { VENT_GAS, ventAdd, ventExitVelocity, type VentState } from './vent';

export const VK_WINDOW = 0, VK_HOLE = 1, VK_DUMP = 2, VK_COLLAR = 3;
const KIND: Record<string, number> = { window: VK_WINDOW, hole: VK_HOLE, dump: VK_DUMP, collar: VK_COLLAR };
/** Per-room hole slots: A, px, py, pz (exterior hit point), nx, ny, nz. */
export const HOLE_STRIDE = 7;

export interface BreachNet {
  nV: number;
  orifice: Int32Array;
  room: Int32Array;
  kind: Int8Array;
  pos: Float64Array;
  nrm: Float64Array;
  /** Damage component index of a window vent (−1 otherwise). */
  comp: Int32Array;
  /** Full flow area of the vent's orifice, m². */
  A: Float64Array;
  nRooms: number;
  boxes: Float64Array;
  /** Vent index of each room's panel hole (−1 none) and the hole's opening index in the gas net's draught table. */
  holeVent: Int32Array;
  holeOp: Int32Array;
  /** Scratch. */
  u3: Float64Array;
}

export interface BreachState {
  hole: Float64Array;
}

export function compileBreach(vents: VentDef[], boxes: Box[], cnet: CabinNet, orificeA: ArrayLike<number>): BreachNet {
  const nV = vents.length, nR = boxes.length;
  const holeVent = new Int32Array(nR).fill(-1), holeOp = new Int32Array(nR).fill(-1);
  vents.forEach((v, i) => {
    if (v.kind !== 'hole') return;
    holeVent[v.room] = i;
    for (let o = cnet.opStart[v.room]; o < cnet.opStart[v.room + 1]; o++) if (cnet.opLink[o] === v.orifice) holeOp[v.room] = o;
  });
  return {
    nV,
    orifice: Int32Array.from(vents, (v) => v.orifice), room: Int32Array.from(vents, (v) => v.room),
    kind: Int8Array.from(vents, (v) => KIND[v.kind] ?? VK_HOLE),
    pos: Float64Array.from(vents.flatMap((v) => [v.pos.x, v.pos.y, v.pos.z])),
    nrm: Float64Array.from(vents.flatMap((v) => [v.normal.x, v.normal.y, v.normal.z])),
    comp: Int32Array.from(vents, (v) => (v.kind === 'window' ? DAMAGE_COMPONENTS.findIndex((c) => c.id === v.component) : -1)),
    A: Float64Array.from(vents, (v) => orificeA[v.orifice]),
    nRooms: nR,
    boxes: Float64Array.from(boxes.flatMap((b) => [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z])),
    holeVent, holeOp, u3: new Float64Array(3),
  };
}

export const makeBreachState = (bn: BreachNet): BreachState => ({ hole: new Float64Array(bn.nRooms * HOLE_STRIDE) });

/** Hole area (m²) a hit of E joules on hull zone `zone` tears in the pressure shell (header). */
export function holeAreaFromEnergy(E: number, zone: number): number {
  if (!(E > 0) || !(zone >= 0 && zone < N_HULL_ZONES)) return 0;
  const z = HULL_ZONES[zone], ud = z.energyDensity * z.crushDepth;
  const ex = E - ud * PERF_FOOTPRINT;
  return ex > 0 ? HOLE_PHI * ex / ud : 0;
}

/** Distance from point p to room r's box (0 inside). */
function boxDist(bn: BreachNet, r: number, x: number, y: number, z: number): number {
  const b = bn.boxes, o = 6 * r;
  const dx = x < b[o] ? b[o] - x : x > b[o + 3] ? x - b[o + 3] : 0;
  const dy = y < b[o + 1] ? b[o + 1] - y : y > b[o + 4] ? y - b[o + 4] : 0;
  const dz = z < b[o + 2] ? b[o + 2] - z : z > b[o + 5] ? z - b[o + 5] : 0;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * A hit of E joules (the ship's share) at ship-local p with outward normal n on hull zone `zone`: opens or enlarges
 * the panel hole of the nearest room within HULL_REACH. Returns the room (−1: nothing pressurised behind the skin, or
 * no perforation). Moves the hole's opening in the gas net's draught table.
 */
export function breachHit(bn: BreachNet, bs: BreachState, cnet: CabinNet, px: number, py: number, pz: number, nx: number, ny: number, nz: number, E: number, zone: number): number {
  const dA = holeAreaFromEnergy(E, zone);
  if (!(dA > 0)) return -1;
  let best = -1, bd = HULL_REACH;
  for (let r = 0; r < bn.nRooms; r++) {
    if (bn.holeVent[r] < 0) continue;
    const d = boxDist(bn, r, px, py, pz);
    if (d <= bd) { bd = d; best = r; }
  }
  if (best < 0) return -1;
  const h = bs.hole, o = best * HOLE_STRIDE, A0 = h[o];
  let A1 = A0 + dA;
  if (A1 > HOLE_A_MAX) A1 = HOLE_A_MAX;
  const w = A1 - A0;
  if (!(w > 0)) return best;
  const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  h[o + 1] = (A0 * h[o + 1] + w * px) / A1; h[o + 2] = (A0 * h[o + 2] + w * py) / A1; h[o + 3] = (A0 * h[o + 3] + w * pz) / A1;
  let mx = A0 * h[o + 4] + w * nx / nl, my = A0 * h[o + 5] + w * ny / nl, mz = A0 * h[o + 6] + w * nz / nl;
  const ml = Math.sqrt(mx * mx + my * my + mz * mz) || 1;
  mx /= ml; my /= ml; mz /= ml;
  h[o + 4] = mx; h[o + 5] = my; h[o + 6] = mz;
  h[o] = A1;
  applyHole(bn, bs, cnet, best);
  return best;
}

/** Put room r's hole opening (for the draught field) at the point of its box nearest the exterior hit point. */
function applyHole(bn: BreachNet, bs: BreachState, cnet: CabinNet, r: number): void {
  const op = bn.holeOp[r];
  if (op < 0) return;
  const b = bn.boxes, o = 6 * r, h = bs.hole, q = r * HOLE_STRIDE;
  const cl = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
  cnet.opPos[3 * op] = cl(h[q + 1], b[o], b[o + 3]);
  cnet.opPos[3 * op + 1] = cl(h[q + 2], b[o + 1], b[o + 4]);
  cnet.opPos[3 * op + 2] = cl(h[q + 3], b[o + 2], b[o + 5]);
  cnet.opCore[op] = Math.sqrt((h[q] > 1e-6 ? h[q] : 1e-6) / Math.PI);
}

/** After a load (or a fresh compile): put every saved hole back into the gas net's opening table. */
export function applyBreachGeometry(bn: BreachNet, bs: BreachState, cnet: CabinNet): void {
  for (let r = 0; r < bn.nRooms; r++) if (bs.hole[r * HOLE_STRIDE] > 0) applyHole(bn, bs, cnet, r);
}

/** Write the window and panel-hole open fractions (cabin io.open) from the damage state and the holes. */
export function breachOpen(bn: BreachNet, bs: BreachState, damage: DamageState | null, open: Float64Array): void {
  for (let i = 0; i < bn.nV; i++) {
    const k = bn.kind[i];
    if (k === VK_WINDOW) {
      const c = bn.comp[i];
      const ws = damage && c >= 0 ? windowState(damage, c) : 0;
      open[bn.orifice[i]] = ws === 2 ? 1 : ws === 1 ? CRACK_A / bn.A[i] : 0;
    } else if (k === VK_HOLE) {
      const a = bs.hole[bn.room[i] * HOLE_STRIDE];
      open[bn.orifice[i]] = a > 0 ? a / bn.A[i] : 0;
    }
  }
}

/**
 * Book the gas that left through every vent orifice in the gas step just taken (h seconds; io.linkMol step means;
 * gasT = the rooms' gas temperatures that step used) into vent slot VENT_GAS. Returns the mass vented, kg.
 */
export function breachVent(bn: BreachNet, bs: BreachState, cnet: CabinNet, st: CabinState, io: CabinIo, gasT: Float64Array, h: number, vent: VentState): number {
  let mt = 0;
  const g = st.rooms;
  for (let i = 0; i < bn.nV; i++) {
    const q = io.linkMol[bn.orifice[i]];
    if (!(q > 0)) continue;
    const a = bn.room[i], b = a * ROOM_STRIDE;
    const n0 = g[b], n1 = g[b + 1], n2 = g[b + 2], n3 = g[b + 3], N = n0 + n1 + n2 + n3;
    const M = N > 0 ? (n0 * MOLAR_MASS[0] + n1 * MOLAR_MASS[1] + n2 * MOLAR_MASS[2] + n3 * MOLAR_MASS[3]) / N : MOLAR_MASS[0];
    const dm = q * h * M;
    const pa = io.p[a], pb = io.bnd[0];
    const u = ventExitVelocity(pa > 0 ? pb / pa : 1, gasT[a], M);
    let px: number, py: number, pz: number, nx: number, ny: number, nz: number;
    if (bn.kind[i] === VK_HOLE) {
      const o = a * HOLE_STRIDE, hh = bs.hole;
      px = hh[o + 1]; py = hh[o + 2]; pz = hh[o + 3]; nx = hh[o + 4]; ny = hh[o + 5]; nz = hh[o + 6];
    } else {
      px = bn.pos[3 * i]; py = bn.pos[3 * i + 1]; pz = bn.pos[3 * i + 2]; nx = bn.nrm[3 * i]; ny = bn.nrm[3 * i + 1]; nz = bn.nrm[3 * i + 2];
    }
    ventAdd(vent, VENT_GAS, dm, u, px, py, pz, nx, ny, nz);
    mt += dm;
  }
  void cnet;
  return mt;
}

/**
 * Force (N, ship axes) on a body at (x, y, z) in room i moving at (vx, vy, vz) with drag area CdA (m²) and volume Vb
 * (m³), from the room's air (header): drag in draftAt's local air velocity + the pressure-gradient force of each
 * open vent's sink. out[0..2].
 */
export function ventBodyForce(
  bn: BreachNet, cnet: CabinNet, st: CabinState, io: CabinIo, i: number,
  x: number, y: number, z: number, vx: number, vy: number, vz: number, CdA: number, Vb: number, out: Float64Array,
): void {
  const u = bn.u3;
  draftAt(cnet, st, i, x, y, z, u);
  const rho = io.rho[i];
  const rx = u[0] - vx, ry = u[1] - vy, rz = u[2] - vz;
  const k = 0.5 * rho * CdA * Math.sqrt(rx * rx + ry * ry + rz * rz);
  let fx = k * rx, fy = k * ry, fz = k * rz;
  const P = io.p[i], T = st.rooms[i * ROOM_STRIDE + 4];
  if (P > 0) {
    for (let o = cnet.opStart[i]; o < cnet.opStart[i + 1]; o++) {
      const link = cnet.opLink[o];
      if (link >= cnet.nO || cnet.oB[link] >= 0) continue; // only openings to a boundary
      const q = io.linkMol[link];
      if (!(q > 0)) continue;
      const Q = q * R_GAS * T / P; // m³/s at the room's state
      const a = cnet.opCore[o];
      const dx = x - cnet.opPos[3 * o], dy = y - cnet.opPos[3 * o + 1], dz = z - cnet.opPos[3 * o + 2];
      const r2 = dx * dx + dy * dy + dz * dz, s2 = r2 + a * a;
      const c = Q / (2 * Math.PI);
      const f = rho * Vb * c * c * (a * a - 2 * r2) / (s2 * s2 * s2 * s2);
      fx += f * dx; fy += f * dy; fz += f * dz;
    }
  }
  out[0] = fx; out[1] = fy; out[2] = fz;
}

// ------------------------------------------------------------------------------------------------ save / load

export const saveBreach = (bs: BreachState): { hole: number[] } => ({ hole: Array.from(bs.hole) });

export function loadBreach(bn: BreachNet, raw: unknown): BreachState {
  const bs = makeBreachState(bn);
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const h = o.hole;
  if (Array.isArray(h) && h.length === bs.hole.length && h.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    bs.hole.set(h);
    for (let r = 0; r < bn.nRooms; r++) { const q = r * HOLE_STRIDE; bs.hole[q] = Math.min(HOLE_A_MAX, Math.max(0, bs.hole[q])); }
  }
  return bs;
}
