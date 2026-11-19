// Located damage (docs/SIMULATION.md W2-C item 5): manifold point -> hull zone (src/data/hullZones.ts) -> the
// component struck (window, collar, RCS quad, drive pod, radiator, tank) or the zone's structural panel; the contact
// energy split between the two bodies by compliance; graded overload; the derived health arrays the allocator,
// dynamics and thermal read. Pure, deterministic, allocation-free per hit/step (module scratch), plain-JSON state.
//
// WIRING (wave 2):
// - contact.ts contactPair / surfaceContact, after solveManifold(m, CA, CB, …, RES) with RES.energy > 0, replacing
//   `c.hull -= RES.energy / c.hullStrength` for both craft (today's double counting):
//     complianceSplit(RES.energy, kOf(s), kOf(o), SPLIT)   // K_SHIP 1e7, K_STATION 1e9, K_GROUND 1e9 N/m
//     ship s (body A): damageFromManifold(s.damage, model(s), m, CA, CB, craftCompound(s).names, SPLIT[0], true)
//     ship o (body B, ship–ship): damageFromManifold(o.damage, model(o), m, CA, CB, names(o), SPLIT[1], false)
//     a station keeps its scalar hull: st.hull -= SPLIT[1] / st.hullStrength
//   then `if (deriveHealth(c.damage, model, c.jetHealth, c.engineHealth, c.radiatorHealth)) rebuild c.jetTable` and
//   c.hull = c.damage.hull; destroy when c.damage.hull <= 0 or c.damage.overloadD >= 1.
//   Landing (surfaceContact): the same with the touchdown's RES.energy and K_GROUND (no LAND_MAX_SPEED cut).
// - setup.ts / load: model = buildDamageModel(c.jets) once per craft (jet -> quad map; rebuilt at load, not saved);
//   c.damage = loadDamageState(saved?.damage). §1.4: `zones` = c.damage.zones, `overloadD` = c.damage.overloadD.
// - session.ts, once per tick after consumeLedger(c, mean): overloadStep(c.damage, mean, c) (n = |mean.f|/(m·g0),
//   D += ((n − 6)/(9 − 6))·T/2 s; replaces the 15 g death in crew/dynamics).
// - Reads nothing of §1.4 but jets; writes zones, overloadD, jetHealth, engineHealth, radiatorHealth (and hull).
// Rate: per contact solve (impact) and once per tick (overload); ~0.2 µs per manifold point in node.

import type { Quat, V3 } from '../core/types';
import {
  DAMAGE_COMPONENTS, DAMAGE_PRIORITY, HULL_ZONES, N_HULL_ZONES, PART_ZONE, RCS_HIT_RADIUS,
  Z_BELLY_AFT, Z_BELLY_FWD, Z_DORSAL_AFT, Z_DORSAL_FWD, Z_FLANK_PORT, Z_FLANK_STBD, Z_NOSE,
} from '../data/hullZones';
import type { ContactBody, Manifold } from './compound';

/** Contact stiffnesses for the compliance split, N/m (W2-C item 5). */
export const K_SHIP = 1e7;
export const K_STATION = 1e9;
export const K_GROUND = 1e9;
/** Graded overload: limit and ultimate load factors, and the time at ultimate load to failure, s. */
export const OVERLOAD_LIMIT = 6;
export const OVERLOAD_ULTIMATE = 9;
export const OVERLOAD_TIME = 2;
export const G0 = 9.80665;

const NC = DAMAGE_COMPONENTS.length;
const KIND_CODE: Record<string, number> = { panel: 0, window: 1, rcs: 2, engine: 3, radiator: 4, collar: 5, tank: 6 };

// ------------------------------------------------------------------------------------------------ state

export interface DamageState {
  /** Health 0..1 per damage component (DAMAGE_COMPONENTS order): the §1.4 `zones` field. */
  zones: number[];
  /** Overload damage 0..1 (1 = structural failure): the §1.4 `overloadD` field. */
  overloadD: number;
  /** Derived (not saved): area-weighted mean health of the 12 structural panels. */
  hull: number;
}

export function makeDamageState(): DamageState {
  const zones: number[] = new Array(NC);
  for (let i = 0; i < NC; i++) zones[i] = 1;
  return { zones, overloadD: 0, hull: 1 };
}

/** JSON-safe copy (every value is a finite double and round-trips exactly). */
export function saveDamageState(d: DamageState): { zones: number[]; overloadD: number } {
  return { zones: d.zones.slice(), overloadD: d.overloadD };
}

/** Loader with defaults: an old save (or a missing / short array) is undamaged; values clamped to [0, 1]. */
export function loadDamageState(raw: unknown): DamageState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = makeDamageState();
  const z = Array.isArray(o.zones) ? o.zones : [];
  for (let i = 0; i < NC; i++) {
    const x = z[i];
    if (typeof x === 'number' && Number.isFinite(x)) d.zones[i] = x < 0 ? 0 : x > 1 ? 1 : x;
  }
  const D = o.overloadD;
  d.overloadD = typeof D === 'number' && Number.isFinite(D) && D > 0 ? (D > 1 ? 1 : D) : 0;
  d.hull = hullMean(d);
  return d;
}

// ------------------------------------------------------------------------------------------------ model (load time)

export interface DamageModel {
  /** Kind code per component, capacities and hit boxes (min xyz, max xyz; NaN = none), all flat. */
  kind: Int8Array;
  cap: Float64Array;
  box: Float64Array;
  /** Part-name -> component for part-bound components (pods, radiators, tanks). */
  partComp: Map<string, number>;
  /** Component index of each jet's RCS quad (-1 = none), and the jets' positions (3 per jet). */
  jetQuad: Int16Array;
  jetPos: Float64Array;
  /** Component index per quad index (0..3), per engine index, per radiator index. */
  quadComp: Int16Array;
  engineComp: Int16Array;
  radiatorComp: Int16Array;
  /** Order in which kinds are tried. */
  order: Int8Array;
  /** Panel areas / total (weights of the hull mean). */
  panelW: Float64Array;
}

/**
 * Build the per-craft model: each jet joins the nearest RCS quad centre (ties go to the starboard quad), hit boxes
 * flattened. Allocates; call once per craft at setup and at load (nothing here is saved).
 */
export function buildDamageModel(jets: readonly { pos: V3 }[]): DamageModel {
  const kind = new Int8Array(NC), cap = new Float64Array(NC), box = new Float64Array(NC * 6).fill(NaN);
  const partComp = new Map<string, number>();
  const quads: number[] = [], engines: number[] = [], rads: number[] = [];
  DAMAGE_COMPONENTS.forEach((c, i) => {
    kind[i] = KIND_CODE[c.kind];
    cap[i] = c.capacity;
    if (c.box) {
      box[i * 6] = c.box.min.x; box[i * 6 + 1] = c.box.min.y; box[i * 6 + 2] = c.box.min.z;
      box[i * 6 + 3] = c.box.max.x; box[i * 6 + 4] = c.box.max.y; box[i * 6 + 5] = c.box.max.z;
    }
    for (const p of c.parts) partComp.set(p, i);
    if (c.kind === 'rcs') quads[c.index] = i;
    if (c.kind === 'engine') engines[c.index] = i;
    if (c.kind === 'radiator') rads[c.index] = i;
  });
  const jetQuad = new Int16Array(jets.length).fill(-1), jetPos = new Float64Array(jets.length * 3);
  jets.forEach((j, k) => {
    jetPos[k * 3] = j.pos.x; jetPos[k * 3 + 1] = j.pos.y; jetPos[k * 3 + 2] = j.pos.z;
    let best = -1, bd = Infinity;
    for (const qi of quads) {
      const c = DAMAGE_COMPONENTS[qi].centre!;
      const d = (j.pos.x - c.x) ** 2 + (j.pos.y - c.y) ** 2 + (j.pos.z - c.z) ** 2;
      if (d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && c.x > 0)) { bd = d; best = qi; }
    }
    jetQuad[k] = best;
  });
  const order = new Int8Array(DAMAGE_PRIORITY.map((k) => KIND_CODE[k]));
  let A = 0;
  for (let z = 0; z < N_HULL_ZONES; z++) A += HULL_ZONES[z].area;
  const panelW = new Float64Array(N_HULL_ZONES);
  for (let z = 0; z < N_HULL_ZONES; z++) panelW[z] = HULL_ZONES[z].area / A;
  return {
    kind, cap, box, partComp, jetQuad, jetPos, quadComp: Int16Array.from(quads), engineComp: Int16Array.from(engines),
    radiatorComp: Int16Array.from(rads), order, panelW,
  };
}

// ------------------------------------------------------------------------------------------------ zone of a point

/**
 * Skin zone of a point on the hull (ship-local) struck on compound part `part` (its name; '' if unknown) with the
 * hull's outward normal `n` there (ship-local). Named parts map directly (PART_ZONE); the big multi-face body parts
 * (hull, belly, stern, cabin) go by the normal and position.
 */
export function zoneOfPoint(part: string, p: V3, n: V3): number {
  const z = PART_ZONE[part];
  if (z !== undefined && z >= 0) return z;
  if (n.z < -0.7) return Z_NOSE;
  if (n.x > 0.7) return Z_FLANK_STBD;
  if (n.x < -0.7) return Z_FLANK_PORT;
  if (n.z > 0.7) return Z_BELLY_AFT;
  if (n.y >= 0) return p.z < 3 ? Z_DORSAL_FWD : Z_DORSAL_AFT;
  return p.z < 1 ? Z_BELLY_FWD : Z_BELLY_AFT;
}

const inBox = (b: Float64Array, i: number, p: V3): boolean => {
  const o = i * 6;
  return p.x >= b[o] && p.x <= b[o + 3] && p.y >= b[o + 1] && p.y <= b[o + 4] && p.z >= b[o + 2] && p.z <= b[o + 5];
};

/**
 * The component a hit at ship-local `p` on part `part` strikes: the first kind in DAMAGE_PRIORITY whose hit volume
 * holds it (window and collar boxes, a sphere of RCS_HIT_RADIUS round any jet of a quad, the part itself for
 * pods, radiators and tanks) and that still has health; else the panel of `zone`.
 */
export function componentAt(d: DamageState, m: DamageModel, part: string, p: V3, zone: number): number {
  const r2 = RCS_HIT_RADIUS * RCS_HIT_RADIUS;
  const pc = m.partComp.get(part);
  for (let k = 0; k < m.order.length; k++) {
    const kc = m.order[k];
    if (kc === 1 || kc === 5) {
      for (let i = 0; i < NC; i++) if (m.kind[i] === kc && d.zones[i] > 0 && inBox(m.box, i, p)) return i;
    } else if (kc === 2) {
      for (let j = 0; j < m.jetQuad.length; j++) {
        const q = m.jetQuad[j];
        if (q < 0 || d.zones[q] <= 0) continue;
        const dx = p.x - m.jetPos[j * 3], dy = p.y - m.jetPos[j * 3 + 1], dz = p.z - m.jetPos[j * 3 + 2];
        if (dx * dx + dy * dy + dz * dz <= r2) return q;
      }
    } else if (pc !== undefined && m.kind[pc] === kc && d.zones[pc] > 0) {
      return pc;
    }
  }
  return zone;
}

/** Put `E` joules into component `i` (overflow beyond its health goes to its zone's panel). Returns the component. */
export function absorb(d: DamageState, m: DamageModel, i: number, E: number): number {
  if (!(E > 0)) return i;
  const h = d.zones[i], need = h * m.cap[i];
  if (E <= need || m.kind[i] === 0) {
    const nh = h - E / m.cap[i];
    d.zones[i] = nh > 0 ? nh : 0;
  } else {
    d.zones[i] = 0;
    const z = DAMAGE_COMPONENTS[i].zone, rest = E - need;
    const nh = d.zones[z] - rest / m.cap[z];
    d.zones[z] = nh > 0 ? nh : 0;
  }
  d.hull = hullMean(d);
  return i;
}

/** One hit: zone, component, absorb. Returns the component index struck. */
export function damageAt(d: DamageState, m: DamageModel, part: string, p: V3, nOut: V3, E: number): number {
  return absorb(d, m, componentAt(d, m, part, p, zoneOfPoint(part, p, nOut)), E);
}

// ------------------------------------------------------------------------------------------------ energy split

/**
 * Split a contact's dissipated energy between the two bodies in proportion to their compliance (springs in series:
 * E_i = E·(1/k_i)/Σ(1/k)). out[0] + out[1] = E (to rounding).
 */
export function complianceSplit(E: number, kA: number, kB: number, out: Float64Array): Float64Array {
  const ca = 1 / kA, cb = 1 / kB;
  out[0] = (E * ca) / (ca + cb);
  out[1] = E - out[0];
  return out;
}

const PW: V3 = { x: 0, y: 0, z: 0 }, PL: V3 = { x: 0, y: 0, z: 0 }, NW: V3 = { x: 0, y: 0, z: 0 }, NL: V3 = { x: 0, y: 0, z: 0 };

function rotInv(out: V3, q: Quat, x: number, y: number, z: number): V3 {
  const qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

/**
 * Spread energy E (this body's share) over the manifold's points by their normal impulse (equally if none) and
 * damage each at its place. `isA`: the damaged craft is body A of the manifold (its part ids are partA). `names`
 * are the craft compound's part names. Returns the component that took the most energy (-1 if none).
 */
export function damageFromManifold(d: DamageState, m: DamageModel, man: Manifold, A: ContactBody, B: ContactBody, names: readonly string[], E: number, isA: boolean): number {
  const n = man.n;
  if (n === 0 || !(E > 0)) return -1;
  let jSum = 0;
  for (let i = 0; i < n; i++) { const j = man.normalImpulse(i); if (j > 0) jSum += j; }
  const self = isA ? A : B;
  let best = -1, bestE = 0;
  for (let i = 0; i < n; i++) {
    const j = man.normalImpulse(i);
    const e = jSum > 0 ? (j > 0 ? (E * j) / jSum : 0) : E / n;
    if (e <= 0) continue;
    man.point(i, A, PW);
    man.normal(i, B, NW);
    rotInv(PL, self.q, PW.x - self.p.x, PW.y - self.p.y, PW.z - self.p.z);
    // The manifold normal points from B to A: A's outward normal at the point is −n, B's is +n.
    if (isA) rotInv(NL, self.q, -NW.x, -NW.y, -NW.z); else rotInv(NL, self.q, NW.x, NW.y, NW.z);
    const part = isA ? man.partA(i) : man.partB(i);
    const c = damageAt(d, m, part >= 0 && part < names.length ? names[part] : '', PL, NL, e);
    if (e > bestE) { bestE = e; best = c; }
  }
  return best;
}

// ------------------------------------------------------------------------------------------------ overload

/**
 * Graded overload over one consumed ledger span (once per tick, per quantum under warp — exact for a constant mean):
 * n = |f|/(m·g0); D += max(0, (n − 6)/(9 − 6))·T / 2 s. Returns nothing; destroy the craft when d.overloadD >= 1.
 */
export function overloadStep(d: DamageState, mean: { f: V3; T: number }, c: { dryMass: number; propellant: number }): void {
  const f = mean.f, m = c.dryMass + c.propellant;
  if (!(mean.T > 0) || !(m > 0)) return;
  const n = Math.sqrt(f.x * f.x + f.y * f.y + f.z * f.z) / (m * G0);
  if (n <= OVERLOAD_LIMIT) return;
  const D = d.overloadD + ((n - OVERLOAD_LIMIT) / (OVERLOAD_ULTIMATE - OVERLOAD_LIMIT)) * (mean.T / OVERLOAD_TIME);
  d.overloadD = D > 1 ? 1 : D;
}

// ------------------------------------------------------------------------------------------------ derived

function hullMean(d: DamageState): number {
  let s = 0, A = 0;
  for (let z = 0; z < N_HULL_ZONES; z++) { const a = HULL_ZONES[z].area; s += a * d.zones[z]; A += a; }
  const h = s / A;
  return d.overloadD >= 1 ? 0 : h;
}

/**
 * Fill the §1.4 health arrays: jetHealth[j] = 1 while its quad has health, 0 once disabled (50 kJ); engineHealth
 * and radiatorHealth = their component's health (thrust × health, rejection × health). Returns true when any
 * jetHealth entry changed (the caller rebuilds the jet allocation table).
 */
export function deriveHealth(d: DamageState, m: DamageModel, jetHealth: number[], engineHealth: number[], radiatorHealth: number[]): boolean {
  let changed = false;
  for (let j = 0; j < jetHealth.length; j++) {
    const q = j < m.jetQuad.length ? m.jetQuad[j] : -1;
    const h = q >= 0 && d.zones[q] <= 0 ? 0 : 1;
    if (jetHealth[j] !== h) { jetHealth[j] = h; changed = true; }
  }
  for (let e = 0; e < engineHealth.length; e++) engineHealth[e] = e < m.engineComp.length ? d.zones[m.engineComp[e]] : 1;
  for (let r = 0; r < radiatorHealth.length; r++) radiatorHealth[r] = r < m.radiatorComp.length ? d.zones[m.radiatorComp[r]] : 1;
  d.hull = hullMean(d);
  return changed;
}

/** Window i (component index): 0 intact, 1 cracked (≥ 10 kJ absorbed), 2 broken (a breach of its breachArea). */
export function windowState(d: DamageState, i: number): number {
  const c = DAMAGE_COMPONENTS[i];
  if (c.kind !== 'window') return 0;
  const h = d.zones[i];
  if (h <= 0) return 2;
  return h <= 1 - c.crack / c.capacity + 1e-12 ? 1 : 0;
}
