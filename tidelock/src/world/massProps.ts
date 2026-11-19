// Mass properties that move (SIMULATION.md W3-A item 1): the centre of mass and the FULL inertia tensor from the dry
// structure (baked shell + items + uniform remainder), the propellant in each tank (where its liquid actually is:
// slosh.ts), the crew and loose objects that ride with the hull, and W3-B's TPS mass per skin zone; propellant draw
// (draw order, crossfeed), transfer pumps, the jet-table rebuild rule (tableCom), the full-tensor Euler equation and
// rotation step, the vent force/torque and extImpulse application, and save/load of the saved fields.
//
// Representation: every mass item is a set of RAW moments about the craft origin, craft axes:
//   [m, ∫x, ∫y, ∫z, ∫xx, ∫yy, ∫zz, ∫xy, ∫xz, ∫yz] dm.   Sets add. From the total:
//   c = ∫p/m;  I_o = tr(S)·E − S  (S = ∫p pᵀ);  I_c = I_o − m(|c|²E − c cᵀ)   (the parallel-axis theorem, exact).
// The inertia tensor is stored as [Ixx, Iyy, Izz, Ixy, Ixz, Iyz] with the TENSOR components (Ixy = −∫(x−cx)(y−cy)dm),
// so I·ω is the angular momentum. I⁻¹ by the adjugate (symmetric, positive definite).
//
// Rules kept: I and I⁻¹ are a pure function of the saved state (tanks m, slosh, tpsMass, the coupled crew/props)
// and are recomputed on EVERY powered step — no "changed by > 1 kg" hysteresis (§ review: it breaks save/load
// bit-identity). The jet table is rebuilt when |c − tableCom| > 2 cm, and tableCom is saved, so the table rebuilt
// at load is the one that was in use. Nothing per step allocates or takes/returns a double through a call boundary
// that TurboFan might not inline (inputs and outputs live in typed arrays, as in jets.ts).
//
// Momentum bookkeeping (what is integrated):
// - The craft's translational state (rel, relV) is the motion of the SYSTEM centre of mass (hull + liquid + coupled
//   crew/props), under external forces only. Internal motion (slosh, transfers, a crew member walking) cannot change
//   it: linear momentum is conserved by construction. Every ship-frame consumer (render mesh, colliders, crew
//   feltAt, collar, jets) is offset by −c: hull origin = r − q·c.
// - Rotation integrates ω with I(t). Propellant LEAVING the ship keeps ω continuous (the departing mass takes its
//   share; jet damping, jets.ts, is the rest). Mass moving INSIDE the ship keeps the total angular momentum
//   I·ω + L_int (L_int = Σ m (p − c) × ṗ, ṗ relative to the hull) exactly: rebaseInternal() after slosh / transfer
//   steps. L_int is also the stored-momentum term h of the gyroscopic coupling (rotateFull RF_H*), like a CMG's.
// - The variable-mass rocket term ṁ·ċ (the remaining CoM moving relative to the structure while propellant flows)
//   is below 1e-7 of the thrust (ċ ≈ mm/s, ṁ ≈ 24 kg/s): not built (§1.1 rule 3).
//
// WIRING (wave 3; nothing here is called yet):
//   * setup.ts addCraft and at load (rebuilt, not saved): c.mass = buildMassModel(shipVisual, tankDefsFor(shipVisual,
//     stats.fuelCapacity·(22.5/24 split of D3: main), rcs capacity), stats.dryMass); c.mp = makeMassOut() (MP_*);
//     §1.4 `tanks` = makeTankState(model) (or loadMassState). gyration and maxTorque stop being a box estimate:
//     massProps() writes MP_I; c.gyration may stay as a view of the principal diagonal / m.
//     The design CoM for the engines' mount cant (gimbal.ts gimbalDefs) = massProps of the FULL tanks.
//     Stations: W2-C's stationMassProps stays (a station's tanks are not modelled here).
//   * dynamics.ts integrateCraft, at the START of every step (powered or rotating; coasting with ω = 0 needs none):
//       massProps(model, c.tanks, c.slosh, c.tpsMass, pts, nPts, c.mp)   (≈ 0.2 µs node, see the report in tests)
//     pts = the crew and props COUPLED to the hull (seated, gripped, resting: [m, x, y, z] in craft axes); a body
//     that lets go leaves pts and W3-D books the momentum it takes with it in extImpulse (a body that grabs on, the
//     reverse). inp[IN_M] = mp[MP_M]; inp[IN_CX..CZ] = mp[MP_CX..CZ]; inp[IN_IX..IZ] = mp[MP_IXX..IZZ] (the jets'
//     diagonal uses stay); §1.4 com = mp[MP_C*], inertia = mp[MP_I*] (views).
//     Rotation: rotateFull(c.w, c.q, c.mp, rf) replaces rotateCraft (rf[RF_DT] = dt, RF_T* = the step's torque about
//     c (jets o.t*, gimbal.ts engines, vent tau, aero), RF_H* = slosh.ts L_int + CMG h). attitude.ts rotateHeld
//     still takes a diagonal inertia (RI_IX..IZ): wave 3 passes mp[MP_IXX..IZZ] there and accepts the products of
//     inertia as a disturbance the hold rejects (the Wren's |Ixy|,|Ixz|,|Iyz| are < 1 % of the diagonal), or
//     ports rotateFull's derivative into it.
//     Propellant: drawMain(model, c.tanks, engineMdot, nEng, h, crossfeed, dw) with engineMdot[i] = F̄_i/vₑ from
//     gimbal.ts' application; drawFluid(model, c.tanks, FLUID_N2H4, o.mdotRcs·h, dw); then poolsOf(model, c.tanks, pl):
//     c.propellant = pl[0], c.rcsPropellant = pl[1] (the per-tank m are the truth; the pools are views).
//     Vent (W3-B): applyVent(c.vent, o) adds F and τ into the step's ThrustOut before ledgerAdd; W3-B debits
//     vent.mdot·h from what it vents (cabin gas, or a tank via drawFluid). extImpulse (W3-D): once per tick,
//     applyExtImpulse(c.extImpulse, c.mp, dvw) → c.relV += q·dvw[0..2], c.w += dvw[3..5], and the same Δv/Δω into
//     the ledger's dvImpulse/dwImpulse (the crew and props feel the hull jump); it zeroes extImpulse.
//     contact.ts: ledgerImpulseFull(c, J, r, c.mp) replaces jets.ts ledgerImpulse (full tensor; r about c).
//     Jet table: if (needsTableRebuild(c.mp, c.tableCom)) { c.jetTable = buildJetTable(c.jets, com, …);
//     c.tableCom = com } — at most once per 2 cm of CoM travel. compound.ts / contact.ts take c as the body origin.
//   * world.ts save/load: saveMassState(c) / loadMassState(raw, model) (tanks m, tableCom, tpsMass with defaults:
//     an old save's main pool is spread over the LH2 tanks by draw order reversed, its RCS pool over the N2H4 tanks).
//   * §1.4 fields read: tanks, slosh, tpsMass, vent, extImpulse, tableCom; written: tanks (m, pos), com, inertia,
//     tableCom (on rebuild); vent is read only; extImpulse is zeroed after it is applied.
// Rate: once per craft step while powered/rotating (≤ 120 Hz at 1×; adaptive steps under warp). Warp: exact (pure
// function of state); declares no limitedBy.

import type { Quat, V3 } from '../core/types';
import { HULL_MOMENTS } from '../data/massPropsBaked';
import { HULL_ZONES, N_HULL_ZONES } from '../data/hullZones';
import { WREN_DRY_ITEMS, genericTanks, tankVolume, wrenTanks, type DryItem, type TankDef } from '../data/tanks';

// =============================================================================================== layout of the typed arrays

export const NM = 10;
export const M_M = 0, M_X = 1, M_Y = 2, M_Z = 3, M_XX = 4, M_YY = 5, M_ZZ = 6, M_XY = 7, M_XZ = 8, M_YZ = 9;

/** massProps output: mass, CoM, inertia tensor about the CoM and its inverse (both [xx, yy, zz, xy, xz, yz]). */
export const MP_M = 0, MP_CX = 1, MP_CY = 2, MP_CZ = 3;
export const MP_IXX = 4, MP_IYY = 5, MP_IZZ = 6, MP_IXY = 7, MP_IXZ = 8, MP_IYZ = 9;
export const MP_JXX = 10, MP_JYY = 11, MP_JZZ = 12, MP_JXY = 13, MP_JXZ = 14, MP_JYZ = 15;
/** Liquid mass of all tanks (kg) and the dry mass actually modelled (kg). */
export const MP_MLIQ = 16, MP_MDRY = 17, MP_LEN = 18;

export const makeMassOut = (): Float64Array => new Float64Array(MP_LEN);

export const FLUID_LH2 = 0, FLUID_N2H4 = 1;
/** Slosh state per tank in §1.4 `slosh` (slosh.ts): bulk offset (3), its rate (3), slosh-mode offset (3), its rate (3). */
export const SL_STRIDE = 12;

/** The jet table is rebuilt when the CoM has moved this far from tableCom, m (SIMULATION W3-A item 1). */
export const TABLE_COM_TOL = 0.02;
/** Transfer pumps (same fluid only), kg/s. */
export const PUMP_MIN = 5;
export const PUMP_MAX = 20;
/** Sub-step of rotateFull: at most this many radians per RK4 step (dynamics.ts ROT_ANGLE). */
export const ROT_ANGLE = 0.05;
/** Least share of the dry mass left for the uniform remainder (keel, frames, systems). */
export const DRY_REST_MIN = 0.1;

// =============================================================================================== model (load time)

/** The at-load mass model of one craft. Rebuilt at load, never saved. */
export interface MassModel {
  hull: string;
  tanks: TankDef[];
  nT: number;
  /** Dry moments (structure, items, tank structures, remainder), scaled to the fit's dryMass. */
  dry: Float64Array;
  /** Per skin zone: moments per kg of TPS on that zone (zone skin moments / zone area). */
  zoneUnit: Float64Array;
  nZones: number;
  /** Per tank: centre (3) and the liquid's own central second moments per kg when smeared over the tank (xx, yy, zz). */
  tc: Float64Array;
  town: Float64Array;
  fluid: Uint8Array;
  group: Uint8Array;
  feeds: Uint32Array;
  cap: Float64Array;
  /** The neutral-axis height for flex.ts (the dry CoM's y) and the hull's z extent [z0, z1]. */
  dryCom: V3;
  zSpan: [number, number];
}

/** Raw moments of a solid box (half extents h) or a Z-axis cylinder (radius h.x, half length h.z) of mass m at c. */
export function solidMoments(shape: 'box' | 'cyl' | 'capsule', c: V3, h: V3, m: number, out: Float64Array, o = 0): Float64Array {
  let kx: number, ky: number, kz: number; // central ∫d_i² per kg
  if (shape === 'box') {
    kx = (h.x * h.x) / 3; ky = (h.y * h.y) / 3; kz = (h.z * h.z) / 3;
  } else if (shape === 'cyl') {
    kx = ky = (h.x * h.x) / 4; kz = (h.z * h.z) / 3;
  } else {
    // capsule: cylinder of half length h.z plus two hemispheres of radius r (exact central moments)
    const r = h.x, a = h.z;
    const Vc = Math.PI * r * r * 2 * a, Vs = (4 / 3) * Math.PI * r * r * r, V = Vc + Vs;
    // radial ∫x² dV: cylinder πr⁴a/2, sphere 4πr⁵/15
    const rad = (Math.PI * r * r * r * r * a) / 2 + (4 * Math.PI * r * r * r * r * r) / 15;
    // axial ∫z² dV: cylinder (2/3)πr²a³; hemispheres at ±a: ∫(a + u)² over a hemisphere = Vs/2·(a² + 2a·3r/8 + r²/5), ×2
    const ax = (2 / 3) * Math.PI * r * r * a * a * a + Vs * (a * a + (3 * a * r) / 4 + (r * r) / 5);
    kx = ky = rad / V; kz = ax / V;
  }
  out[o + M_M] += m;
  out[o + M_X] += m * c.x; out[o + M_Y] += m * c.y; out[o + M_Z] += m * c.z;
  out[o + M_XX] += m * (c.x * c.x + kx); out[o + M_YY] += m * (c.y * c.y + ky); out[o + M_ZZ] += m * (c.z * c.z + kz);
  out[o + M_XY] += m * c.x * c.y; out[o + M_XZ] += m * c.x * c.z; out[o + M_YZ] += m * c.y * c.z;
  return out;
}

/** Centre of the hull's volume (the baked uniform solid), craft axes. */
export function hullCentroid(hull: string | null): V3 {
  const hm = hull ? HULL_MOMENTS[hull] : undefined;
  if (!hm || !(hm.volume[0] > 0)) return { x: 0, y: 0, z: 0 };
  const V = hm.volume[0];
  return { x: hm.volume[1] / V, y: hm.volume[2] / V, z: hm.volume[3] / V };
}

/** The tanks of a hull for a fit's main (LH2) and RCS (N2H4) capacities, kg. Load time. */
export function tankDefsFor(hull: string | null, lh2: number, n2h4: number): TankDef[] {
  if (hull === 'wren') return wrenTanks(lh2, n2h4);
  return genericTanks(hullCentroid(hull), lh2, n2h4);
}

/**
 * Build the mass model (load time). `dryMass` is the fit's stats.dryMass: the total dry mass is always exactly it.
 * Wren: skin shell (HULL_ZONES arealMass on the baked skin) + WREN_DRY_ITEMS + tank structures + the remainder as a
 * uniform solid over the compound (≥ DRY_REST_MIN of the dry mass: lighter fits scale the items down). Other hulls:
 * a uniform solid (no zones yet). Hulls with no baked moments (none today): a 1 m sphere at the origin.
 */
export function buildMassModel(hull: string | null, tanks: TankDef[], dryMass: number): MassModel {
  const hm = hull ? HULL_MOMENTS[hull] : undefined;
  const vol = new Float64Array(NM);
  if (hm && hm.volume[0] > 0) for (let k = 0; k < NM; k++) vol[k] = hm.volume[k] / hm.volume[0];
  else { vol[M_M] = 1; vol[M_XX] = vol[M_YY] = vol[M_ZZ] = 0.1; }
  const dry = new Float64Array(NM);
  const zoneUnit = new Float64Array(N_HULL_ZONES * NM);
  const D = dryMass > 0 ? dryMass : 0;

  // shell
  const shell = new Float64Array(NM);
  let mShell = 0;
  if (hm && hm.skin && hull === 'wren') {
    for (let z = 0; z < N_HULL_ZONES; z++) {
      const A = hm.skin[z * NM];
      const s = HULL_ZONES[z].arealMass;
      for (let k = 0; k < NM; k++) {
        shell[k] += s * hm.skin[z * NM + k];
        zoneUnit[z * NM + k] = A > 0 ? hm.skin[z * NM + k] / A : vol[k];
      }
      mShell += s * A;
    }
  } else {
    for (let z = 0; z < N_HULL_ZONES; z++) for (let k = 0; k < NM; k++) zoneUnit[z * NM + k] = vol[k];
  }
  // items and tank structures
  const items = new Float64Array(NM);
  if (hull === 'wren') for (const it of WREN_DRY_ITEMS as DryItem[]) solidMoments(it.shape, it.c, it.h, it.m, items);
  for (const t of tanks) solidMoments(t.shape === 'box' ? 'box' : 'capsule', t.c, t.h, t.dryMass, items);
  let kShell = 1, kItems = 1;
  const mItems = items[M_M], room = (1 - DRY_REST_MIN) * D;
  if (mShell > room) { kShell = room / mShell; kItems = 0; }
  else if (mShell + mItems > room) kItems = mItems > 0 ? (room - mShell) / mItems : 0;
  for (let k = 0; k < NM; k++) dry[k] = kShell * shell[k] + kItems * items[k];
  const rest = D - dry[M_M];
  for (let k = 0; k < NM; k++) dry[k] += rest * vol[k];
  dry[M_M] = D; // exact

  const nT = tanks.length;
  const tc = new Float64Array(3 * nT), town = new Float64Array(3 * nT);
  const fluid = new Uint8Array(nT), group = new Uint8Array(nT), feeds = new Uint32Array(nT), cap = new Float64Array(nT);
  const tmp = new Float64Array(NM);
  tanks.forEach((t, i) => {
    tc[3 * i] = t.c.x; tc[3 * i + 1] = t.c.y; tc[3 * i + 2] = t.c.z;
    tmp.fill(0);
    solidMoments(t.shape === 'box' ? 'box' : 'capsule', { x: 0, y: 0, z: 0 }, t.h, 1, tmp);
    town[3 * i] = tmp[M_XX]; town[3 * i + 1] = tmp[M_YY]; town[3 * i + 2] = tmp[M_ZZ];
    fluid[i] = t.fluid === 'lh2' ? FLUID_LH2 : FLUID_N2H4;
    group[i] = t.group; feeds[i] = t.feeds >>> 0; cap[i] = t.cap;
  });
  const m = dry[M_M] > 0 ? dry[M_M] : 1;
  let z0 = -16, z1 = 16;
  if (hull === 'wren') { z0 = -16.3; z1 = 15.6; }
  else if (hm && hm.volume[0] > 0) {
    // ±√3 σ_z about the centroid (a uniform rod of the same second moment)
    const cz = vol[M_Z], sz = Math.sqrt(Math.max(0, vol[M_ZZ] - cz * cz));
    z0 = cz - Math.sqrt(3) * sz; z1 = cz + Math.sqrt(3) * sz;
  }
  return {
    hull: hull ?? '', tanks, nT, dry, zoneUnit, nZones: N_HULL_ZONES, tc, town, fluid, group, feeds, cap,
    dryCom: { x: dry[M_X] / m, y: dry[M_Y] / m, z: dry[M_Z] / m }, zSpan: [z0, z1],
  };
}

/** §1.4 tank entries: one per TankDef, full. */
export interface TankState {
  m: number;
  pos: V3;
  cap: number;
}

export function makeTankState(model: MassModel, fill = 1): TankState[] {
  return model.tanks.map((t) => ({ m: t.cap * fill, pos: { x: t.c.x, y: t.c.y, z: t.c.z }, cap: t.cap }));
}

// =============================================================================================== per step: the properties

const S = new Float64Array(NM);

/**
 * Mass, CoM and the full inertia tensor (and its inverse) of the craft now: dry + tanks (liquid at its centre plus the
 * slosh.ts offsets x + e in `slosh`) + TPS per zone + coupled point masses `pts` ([m, x, y, z] × nPts, craft axes).
 * `tps` may be empty or shorter than the zone count (missing zones count 0). Writes `out` (MP_*).
 */
export function massProps(model: MassModel, tanks: readonly TankState[], slosh: ArrayLike<number>, tps: ArrayLike<number>, pts: ArrayLike<number>, nPts: number, out: Float64Array): Float64Array {
  const d = model.dry;
  for (let k = 0; k < NM; k++) S[k] = d[k];
  const tc = model.tc, tw = model.town, nT = model.nT, hasSl = slosh.length >= nT * SL_STRIDE;
  let mliq = 0;
  for (let i = 0; i < nT; i++) {
    const m = tanks[i].m;
    if (!(m > 0)) continue;
    let px = tc[3 * i], py = tc[3 * i + 1], pz = tc[3 * i + 2];
    if (hasSl) {
      const o = i * SL_STRIDE;
      px += slosh[o] + slosh[o + 6]; py += slosh[o + 1] + slosh[o + 7]; pz += slosh[o + 2] + slosh[o + 8];
    }
    mliq += m;
    S[M_M] += m; S[M_X] += m * px; S[M_Y] += m * py; S[M_Z] += m * pz;
    S[M_XX] += m * (px * px + tw[3 * i]); S[M_YY] += m * (py * py + tw[3 * i + 1]); S[M_ZZ] += m * (pz * pz + tw[3 * i + 2]);
    S[M_XY] += m * px * py; S[M_XZ] += m * px * pz; S[M_YZ] += m * py * pz;
  }
  const nz = tps.length < model.nZones ? tps.length : model.nZones, zu = model.zoneUnit;
  for (let z = 0; z < nz; z++) {
    const m = tps[z];
    if (!(m > 0)) continue;
    const o = z * NM;
    for (let k = 0; k < NM; k++) S[k] += m * zu[o + k];
  }
  for (let j = 0; j < nPts; j++) {
    const o = 4 * j, m = pts[o];
    if (!(m > 0)) continue;
    const x = pts[o + 1], y = pts[o + 2], z = pts[o + 3];
    S[M_M] += m; S[M_X] += m * x; S[M_Y] += m * y; S[M_Z] += m * z;
    S[M_XX] += m * x * x; S[M_YY] += m * y * y; S[M_ZZ] += m * z * z;
    S[M_XY] += m * x * y; S[M_XZ] += m * x * z; S[M_YZ] += m * y * z;
  }
  momentsToProps(S, out);
  out[MP_MLIQ] = mliq;
  out[MP_MDRY] = d[M_M];
  return out;
}

/** Raw moments → MP_M, MP_C*, MP_I* (about c) and MP_J* = I⁻¹. */
export function momentsToProps(s: ArrayLike<number>, out: Float64Array): Float64Array {
  const m = s[M_M], im = m > 0 ? 1 / m : 0;
  const cx = s[M_X] * im, cy = s[M_Y] * im, cz = s[M_Z] * im;
  out[MP_M] = m; out[MP_CX] = cx; out[MP_CY] = cy; out[MP_CZ] = cz;
  // central second moments
  const xx = s[M_XX] - m * cx * cx, yy = s[M_YY] - m * cy * cy, zz = s[M_ZZ] - m * cz * cz;
  const xy = s[M_XY] - m * cx * cy, xz = s[M_XZ] - m * cx * cz, yz = s[M_YZ] - m * cy * cz;
  out[MP_IXX] = yy + zz; out[MP_IYY] = xx + zz; out[MP_IZZ] = xx + yy;
  out[MP_IXY] = -xy; out[MP_IXZ] = -xz; out[MP_IYZ] = -yz;
  invertSym(out, MP_IXX, out, MP_JXX);
  return out;
}

/** Inverse of the symmetric 3×3 [a, b, c, d, e, f] = [[a d e], [d b f], [e f c]] at src[o..], into dst[p..]. */
export function invertSym(src: ArrayLike<number>, o: number, dst: Float64Array, p: number): void {
  const a = src[o], b = src[o + 1], c = src[o + 2], d = src[o + 3], e = src[o + 4], f = src[o + 5];
  const A = b * c - f * f, B = a * c - e * e, C = a * b - d * d;
  const D = e * f - c * d, E = d * f - b * e, F = d * e - a * f;
  const det = a * A + d * D + e * E;
  const k = det !== 0 ? 1 / det : 0;
  dst[p] = A * k; dst[p + 1] = B * k; dst[p + 2] = C * k; dst[p + 3] = D * k; dst[p + 4] = E * k; dst[p + 5] = F * k;
}

/** out = T·v for a symmetric tensor stored [xx, yy, zz, xy, xz, yz] at T[o..]. */
export function symMul(T: ArrayLike<number>, o: number, vx: number, vy: number, vz: number, out: V3): V3 {
  out.x = T[o] * vx + T[o + 3] * vy + T[o + 4] * vz;
  out.y = T[o + 3] * vx + T[o + 1] * vy + T[o + 5] * vz;
  out.z = T[o + 4] * vx + T[o + 5] * vy + T[o + 2] * vz;
  return out;
}

/** out = T·v (v a V3; no double arguments, for the per-step paths). */
function symMulV(T: ArrayLike<number>, o: number, v: V3, out: V3): V3 {
  const vx = v.x, vy = v.y, vz = v.z;
  out.x = T[o] * vx + T[o + 3] * vy + T[o + 4] * vz;
  out.y = T[o + 3] * vx + T[o + 1] * vy + T[o + 5] * vz;
  out.z = T[o + 4] * vx + T[o + 5] * vy + T[o + 2] * vz;
  return out;
}

/** True when the jet table must be rebuilt: |c − tableCom| > TABLE_COM_TOL. */
export function needsTableRebuild(mp: ArrayLike<number>, tableCom: V3): boolean {
  const dx = mp[MP_CX] - tableCom.x, dy = mp[MP_CY] - tableCom.y, dz = mp[MP_CZ] - tableCom.z;
  return dx * dx + dy * dy + dz * dz > TABLE_COM_TOL * TABLE_COM_TOL;
}

// =============================================================================================== propellant

/**
 * Draw `dm[k]` kg for each engine k (dm has nEng entries; slots are consumed: on return dm[k] holds what could NOT be
 * drawn) from the LH2 tanks that feed it: the lowest draw-order group with propellant among the tanks whose `feeds`
 * has bit k (every LH2 tank when `crossfeed`), in proportion to their remaining mass (they empty together), then the
 * next group. Writes tank m and nothing else.
 */
export function drawMain(model: MassModel, tanks: TankState[], dm: Float64Array, nEng: number, crossfeed: boolean): void {
  const nT = model.nT, fl = model.fluid, gr = model.group, fe = model.feeds;
  for (let k = 0; k < nEng; k++) {
    let need = dm[k];
    for (let pass = 0; pass < 8 && need > 0; pass++) {
      // lowest group with propellant among the eligible tanks, and their total
      let g = 256, tot = 0;
      for (let i = 0; i < nT; i++) {
        if (fl[i] !== FLUID_LH2 || !(tanks[i].m > 0) || (!crossfeed && (fe[i] & (1 << k)) === 0)) continue;
        if (gr[i] < g) { g = gr[i]; tot = tanks[i].m; } else if (gr[i] === g) tot += tanks[i].m;
      }
      if (g === 256) break;
      const take = need < tot ? need : tot, f = take / tot;
      for (let i = 0; i < nT; i++) {
        if (fl[i] !== FLUID_LH2 || gr[i] !== g || !(tanks[i].m > 0) || (!crossfeed && (fe[i] & (1 << k)) === 0)) continue;
        const m = tanks[i].m, t = take === tot ? m : m * f;
        tanks[i].m = take === tot ? 0 : m - t;
      }
      need -= take;
    }
    dm[k] = need > 1e-12 ? need : 0;
  }
}

/** Draw dm[0] kg of `fluid` from all its tanks in proportion to their remaining mass; dm[0] ← the shortfall. */
export function drawFluid(model: MassModel, tanks: TankState[], fluid: number, dm: Float64Array): void {
  const nT = model.nT, fl = model.fluid;
  let tot = 0;
  for (let i = 0; i < nT; i++) if (fl[i] === fluid && tanks[i].m > 0) tot += tanks[i].m;
  const need = dm[0];
  if (!(tot > 0) || !(need > 0)) return;
  if (need >= tot) {
    for (let i = 0; i < nT; i++) if (fl[i] === fluid) tanks[i].m = 0;
    dm[0] = need - tot;
    return;
  }
  const f = 1 - need / tot;
  for (let i = 0; i < nT; i++) if (fl[i] === fluid && tanks[i].m > 0) tanks[i].m *= f;
  dm[0] = 0;
}

/**
 * Transfer pump from tank `io[0]` to `io[1]` (same fluid only) at io[2] kg/s (clamped to PUMP_MIN..PUMP_MAX) over
 * io[3] s, limited by what the source holds and the room in the target. io[4] ← kg moved. The caller keeps the total
 * angular momentum: massProps before (I_old) and after, then conserveL(w, I_old, mp_new).
 */
export function transferStep(model: MassModel, tanks: TankState[], io: Float64Array): void {
  const a = io[0] | 0, b = io[1] | 0;
  io[4] = 0;
  if (a === b || a < 0 || b < 0 || a >= model.nT || b >= model.nT || model.fluid[a] !== model.fluid[b]) return;
  const r = io[2] < PUMP_MIN ? PUMP_MIN : io[2] > PUMP_MAX ? PUMP_MAX : io[2];
  let dm = r * io[3];
  if (dm > tanks[a].m) dm = tanks[a].m;
  const room = model.cap[b] - tanks[b].m;
  if (dm > room) dm = room;
  if (!(dm > 0)) return;
  tanks[a].m -= dm; tanks[b].m += dm;
  io[4] = dm;
}

/** pools[0] = main (LH2) kg, pools[1] = RCS (N2H4) kg: what c.propellant / c.rcsPropellant show. */
export function poolsOf(model: MassModel, tanks: readonly TankState[], pools: Float64Array): void {
  let a = 0, b = 0;
  for (let i = 0; i < model.nT; i++) { if (model.fluid[i] === FLUID_LH2) a += tanks[i].m; else b += tanks[i].m; }
  pools[0] = a; pools[1] = b;
}

// =============================================================================================== momentum

const T3 = { x: 0, y: 0, z: 0 };
const T4 = { x: 0, y: 0, z: 0 };

/** Keep L = I·ω when the inertia changes from Iold (MP array) to Inew (MP array) by internal redistribution: ω ← I_new⁻¹·I_old·ω. */
export function conserveL(w: V3, mpOld: ArrayLike<number>, mpNew: ArrayLike<number>): void {
  symMulV(mpOld, MP_IXX, w, T3);
  symMulV(mpNew, MP_JXX, T3, w);
}

/**
 * After internal motion with tensor change dI (6, about the new CoM) and internal angular-momentum change dL (3),
 * both from slosh.ts (SO_DI*, SO_DL*): ω ← ω − I_new⁻¹(dI·ω + dL), so I·ω + L_int is unchanged. `mpNew` = massProps
 * after the motion (I_new⁻¹ in MP_J*). Exact to rounding.
 */
export function rebaseInternal(w: V3, mpNew: ArrayLike<number>, so: ArrayLike<number>, oDI: number, oDL: number): void {
  symMulV(so, oDI, w, T3);
  T3.x += so[oDL]; T3.y += so[oDL + 1]; T3.z += so[oDL + 2];
  symMulV(mpNew, MP_JXX, T3, T4);
  w.x -= T4.x; w.y -= T4.y; w.z -= T4.z;
}

/** Angular acceleration from the full-tensor Euler equation: α = I⁻¹(τ − ω × (I·ω + h)), all craft axes. */
export function eulerAccel(mp: ArrayLike<number>, w: V3, tau: V3, h: V3, out: V3): V3 {
  symMulV(mp, MP_IXX, w, T3);
  const Lx = T3.x + h.x, Ly = T3.y + h.y, Lz = T3.z + h.z;
  T4.x = tau.x - (w.y * Lz - w.z * Ly); T4.y = tau.y - (w.z * Lx - w.x * Lz); T4.z = tau.z - (w.x * Ly - w.y * Lx);
  return symMulV(mp, MP_JXX, T4, out);
}

/** rotateFull input/output slots: dt; torque about c (N·m) and stored momentum h (N·m·s), craft axes; sub-steps out. */
export const RF_DT = 0, RF_TX = 1, RF_TY = 2, RF_TZ = 3, RF_HX = 4, RF_HY = 5, RF_HZ = 6, RF_STEPS = 7, RF_LEN = 8;
export const makeRotFull = (): Float64Array => new Float64Array(RF_LEN);

const RK = new Float64Array(28);

// state of a derivative evaluation in typed slots (no double arguments: see the header)
const ST = new Float64Array(7);
function deriv(mp: ArrayLike<number>, rf: Float64Array, o: number): void {
  const wx = ST[0], wy = ST[1], wz = ST[2], qx = ST[3], qy = ST[4], qz = ST[5], qw = ST[6];
  // α = I⁻¹(τ − ω × (Iω + h)) inlined (no V3 temporaries)
  const Lx = mp[MP_IXX] * wx + mp[MP_IXY] * wy + mp[MP_IXZ] * wz + rf[RF_HX];
  const Ly = mp[MP_IXY] * wx + mp[MP_IYY] * wy + mp[MP_IYZ] * wz + rf[RF_HY];
  const Lz = mp[MP_IXZ] * wx + mp[MP_IYZ] * wy + mp[MP_IZZ] * wz + rf[RF_HZ];
  const rx = rf[RF_TX] - (wy * Lz - wz * Ly), ry = rf[RF_TY] - (wz * Lx - wx * Lz), rz = rf[RF_TZ] - (wx * Ly - wy * Lx);
  RK[o] = mp[MP_JXX] * rx + mp[MP_JXY] * ry + mp[MP_JXZ] * rz;
  RK[o + 1] = mp[MP_JXY] * rx + mp[MP_JYY] * ry + mp[MP_JYZ] * rz;
  RK[o + 2] = mp[MP_JXZ] * rx + mp[MP_JYZ] * ry + mp[MP_JZZ] * rz;
  RK[o + 3] = 0.5 * (qw * wx + qy * wz - qz * wy);
  RK[o + 4] = 0.5 * (qw * wy + qz * wx - qx * wz);
  RK[o + 5] = 0.5 * (qw * wz + qx * wy - qy * wx);
  RK[o + 6] = -0.5 * (qx * wx + qy * wy + qz * wz);
}
/** ST ← (ω, q) + k·RK[o..o+6]. */
function stage(wx: Float64Array, k: number, o: number): void {
  for (let j = 0; j < 7; j++) ST[j] = wx[j] + k * RK[o + j];
}
const Y = new Float64Array(7);
const HK = new Float64Array(2);

/**
 * Rotate through rf[RF_DT] under the full tensor (mp, held over the step), the constant torque RF_T* and stored
 * momentum RF_H*: RK4 on (ω, q), sub-stepped so no sub-step turns more than ROT_ANGLE. rf[RF_STEPS] ← sub-steps.
 * Replaces dynamics.ts rotateCraft (which used a diagonal tensor and the commanded torque).
 */
export function rotateFull(w: V3, q: Quat, mp: ArrayLike<number>, rf: Float64Array): void {
  const dt = rf[RF_DT];
  if (!(dt > 0)) { rf[RF_STEPS] = 0; return; }
  Y[0] = w.x; Y[1] = w.y; Y[2] = w.z; Y[3] = q.x; Y[4] = q.y; Y[5] = q.z; Y[6] = q.w;
  // bound on |ω| over the step: |ω| + dt·|I⁻¹τ| (diagonal of I⁻¹ as the scale)
  const jt = Math.abs(mp[MP_JXX] * rf[RF_TX]) + Math.abs(mp[MP_JYY] * rf[RF_TY]) + Math.abs(mp[MP_JZZ] * rf[RF_TZ]);
  const rate = Math.sqrt(Y[0] * Y[0] + Y[1] * Y[1] + Y[2] * Y[2]) + dt * jt;
  let ns = Math.ceil((rate * dt) / ROT_ANGLE);
  if (ns < 1) ns = 1;
  HK[0] = dt / ns; HK[1] = HK[0] / 2;
  for (let i = 0; i < ns; i++) {
    for (let j = 0; j < 7; j++) ST[j] = Y[j];
    deriv(mp, rf, 0);
    stage(Y, HK[1], 0); deriv(mp, rf, 7);
    stage(Y, HK[1], 7); deriv(mp, rf, 14);
    stage(Y, HK[0], 14); deriv(mp, rf, 21);
    const h6 = HK[0] / 6;
    for (let j = 0; j < 7; j++) Y[j] += h6 * (RK[j] + 2 * RK[7 + j] + 2 * RK[14 + j] + RK[21 + j]);
    const s = 1 / Math.sqrt(Y[3] * Y[3] + Y[4] * Y[4] + Y[5] * Y[5] + Y[6] * Y[6]);
    Y[3] *= s; Y[4] *= s; Y[5] *= s; Y[6] *= s;
  }
  w.x = Y[0]; w.y = Y[1]; w.z = Y[2];
  q.x = Y[3]; q.y = Y[4]; q.z = Y[5]; q.w = Y[6];
  rf[RF_STEPS] = ns;
}

// =============================================================================================== vent and external impulses

/** §1.4 vent: proper force F (N) and torque tau (N·m, about c) of venting gas, craft axes; mdot kg/s (W3-B books it). */
export interface Vent {
  F: V3;
  tau: V3;
  mdot: number;
}

/** §1.4 extImpulse: linear J (N·s) and angular L (N·m·s, about c) impulses from the crew and props, craft axes. */
export interface ExtImpulse {
  J: V3;
  L: V3;
}

export const makeVent = (): Vent => ({ F: { x: 0, y: 0, z: 0 }, tau: { x: 0, y: 0, z: 0 }, mdot: 0 });
export const makeExtImpulse = (): ExtImpulse => ({ J: { x: 0, y: 0, z: 0 }, L: { x: 0, y: 0, z: 0 } });

/** Add the vent's force and torque into a step's thrust record (jets.ts ThrustOut: craft axes, torque about c). */
export function applyVent(v: Vent, o: { fx: number; fy: number; fz: number; tx: number; ty: number; tz: number }): void {
  o.fx += v.F.x; o.fy += v.F.y; o.fz += v.F.z;
  o.tx += v.tau.x; o.ty += v.tau.y; o.tz += v.tau.z;
}

/**
 * Apply and zero extImpulse: dvw[0..2] ← J/m (craft axes; the caller rotates it by q into relV), dvw[3..5] ← I⁻¹·L
 * (rad/s, added to ω). Full tensor.
 */
export function applyExtImpulse(e: ExtImpulse, mp: ArrayLike<number>, dvw: Float64Array): void {
  const m = mp[MP_M], im = m > 0 ? 1 / m : 0;
  dvw[0] = e.J.x * im; dvw[1] = e.J.y * im; dvw[2] = e.J.z * im;
  symMulV(mp, MP_JXX, e.L, T3);
  dvw[3] = T3.x; dvw[4] = T3.y; dvw[5] = T3.z;
  e.J.x = e.J.y = e.J.z = 0;
  e.L.x = e.L.y = e.L.z = 0;
}

/** jets.ts ledgerImpulse with the full tensor: Δv += J/m, Δω += I⁻¹(r × J); r about c, craft axes. */
export function ledgerImpulseFull(L: { dvImpulse: V3; dwImpulse: V3 }, J: V3, r: V3, mp: ArrayLike<number>): void {
  const m = mp[MP_M], im = m > 0 ? 1 / m : 0;
  L.dvImpulse.x += J.x * im; L.dvImpulse.y += J.y * im; L.dvImpulse.z += J.z * im;
  T4.x = r.y * J.z - r.z * J.y; T4.y = r.z * J.x - r.x * J.z; T4.z = r.x * J.y - r.y * J.x;
  symMulV(mp, MP_JXX, T4, T3);
  L.dwImpulse.x += T3.x; L.dwImpulse.y += T3.y; L.dwImpulse.z += T3.z;
}

// =============================================================================================== save / load

export interface MassSaved {
  tanks: TankState[];
  tableCom: V3;
  tpsMass: number[];
}

/** JSON-safe copy of the saved W3-A mass fields (tank m, tableCom, tpsMass). pos and cap are derived. */
export function saveMassState(s: MassSaved): Record<string, unknown> {
  return {
    tanks: s.tanks.map((t) => t.m),
    tableCom: { x: s.tableCom.x, y: s.tableCom.y, z: s.tableCom.z },
    tpsMass: s.tpsMass.slice(),
  };
}

const num = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);

/**
 * Read the saved fields with loader defaults. A save without per-tank masses (older versions) spreads `oldMain`
 * (its c.propellant) over the LH2 tanks and `oldRcs` over the N2H4 tanks, filling the LAST draw group first (the
 * tanks that drain first are the ones found empty). tableCom defaults to the CoM of the state (`com`, the caller
 * computes it; the table is then built there); tpsMass to zeros.
 */
export function loadMassState(raw: unknown, model: MassModel, oldMain: number, oldRcs: number, com: V3): MassSaved {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const tanks = makeTankState(model, 0);
  const arr = Array.isArray(o.tanks) ? (o.tanks as unknown[]) : null;
  if (arr && arr.length === model.nT) {
    for (let i = 0; i < model.nT; i++) { const m = num(arr[i], 0); tanks[i].m = m < 0 ? 0 : m > model.cap[i] ? model.cap[i] : m; }
  } else {
    for (const fluid of [FLUID_LH2, FLUID_N2H4]) {
      let left = fluid === FLUID_LH2 ? oldMain : oldRcs;
      if (!(left > 0)) continue;
      for (let g = 255; g >= 0 && left > 0; g--) {
        let cap = 0;
        for (let i = 0; i < model.nT; i++) if (model.fluid[i] === fluid && model.group[i] === g) cap += model.cap[i];
        if (!(cap > 0)) continue;
        const f = left >= cap ? 1 : left / cap;
        for (let i = 0; i < model.nT; i++) if (model.fluid[i] === fluid && model.group[i] === g) tanks[i].m = model.cap[i] * f;
        left -= cap * f;
      }
    }
  }
  const tc = (o.tableCom && typeof o.tableCom === 'object' ? o.tableCom : null) as Record<string, unknown> | null;
  const tableCom = tc ? { x: num(tc.x, com.x), y: num(tc.y, com.y), z: num(tc.z, com.z) } : { x: com.x, y: com.y, z: com.z };
  const tp = Array.isArray(o.tpsMass) ? (o.tpsMass as unknown[]) : [];
  const tpsMass: number[] = new Array(model.nZones);
  for (let z = 0; z < model.nZones; z++) { const m = num(tp[z], 0); tpsMass[z] = m > 0 ? m : 0; }
  return { tanks, tableCom, tpsMass };
}

/** Tank volume helper re-exported for views (m³). */
export const tankVolumeOf = (model: MassModel, i: number): number => tankVolume(model.tanks[i]);
