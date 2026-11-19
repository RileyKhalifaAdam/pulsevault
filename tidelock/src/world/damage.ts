// Located damage (docs/SIMULATION.md W2-C item 5): manifold point -> hull zone (src/data/hullZones.ts) -> the
// component struck (window, collar, RCS housing, drive pod, radiator, tank) among the components UNDER THAT ZONE'S
// SKIN, or the zone's structural panel; the contact energy split between the two bodies by compliance; energy past a
// destroyed component goes to its zone's panel, past a crushed-through panel to the primary structure, so every joule
// is booked (Σ absorbed = E until the structure is gone: then the ship is lost); the deceleration of an impact as a
// graded-overload dose; graded overload over a tick; the derived health arrays the allocator, dynamics and thermal
// read. Pure, deterministic, allocation-free per hit/step (module scratch), plain-JSON state.
//
// Loss of the craft (replaces hull ≤ 0 from hullStrength and the 15 g death): isDestroyed(d), true when the primary
// structure is used up (structure ≤ 0) or the overload damage reaches 1 (overloadD ≥ 1). A nose-first crash of a 60 t
// Wren: 25 m/s nose cap 0.73, D 0.40; 50 m/s nose cap 0, structure 0.61, D 0.84; ≥ 54 m/s lost (tests/damage.test.ts).
//
// WIRING (wave 2):
// - contact.ts contactPair / surfaceContact, after solveManifold(m, CA, CB, …, RES) with RES.energy > 0, replacing
//   `c.hull -= RES.energy / c.hullStrength` for both craft (today's double counting):
//     complianceSplit(RES.energy, kOf(s), kOf(o), SPLIT)   // K_SHIP 1e7, K_STATION 1e9, K_GROUND 1e9 N/m
//     ship s (body A): k = damageFromManifold(s.damage, model(s), m, CA, CB, craftCompound(s).names, SPLIT[0], true)
//       then impactOverload(s.damage, |RES.impulse|, k >= 0 ? DAMAGE_COMPONENTS[k].zone : Z_NOSE, s)
//     ship o (body B, ship–ship): the same with SPLIT[1], false, and its own impulse magnitude
//     a station keeps its scalar hull: st.hull -= SPLIT[1] / st.hullStrength
//   then `if (deriveHealth(c.damage, model, c.jetHealth, c.engineHealth, c.radiatorHealth)) rebuild c.jetTable`,
//   c.hull = c.damage.hull; destroy the craft when isDestroyed(c.damage).
//   Landing (surfaceContact): the same with the touchdown's RES.energy and K_GROUND (no LAND_MAX_SPEED cut).
// - capture.ts ring steps with IO.energy > 0 (the hard stop): complianceSplit(IO.energy, K_SHIP, K_STATION, SPLIT);
//   damageComponent(s.damage, model, C_COLLAR, SPLIT[0]).
// - setup.ts / load: model = buildDamageModel(c.jets) once per craft (jet -> housing map; rebuilt at load, not saved);
//   c.damage = loadDamageState(saved?.damage). §1.4: `zones` = c.damage.zones, `overloadD` = c.damage.overloadD; one
//   saved field more: c.damage.structure.
// - session.ts, once per tick after consumeLedger(c, mean): overloadStep(c.damage, mean, c) (n = |mean.f|/(m·g0) with
//   m = dry + propellant + rcsPropellant, D += ((n − 6)/(9 − 6))·T/2 s; replaces the 15 g death in crew/dynamics).
//   mean.f leaves out contact impulses (they go to dvImpulse): impactOverload above books those.
// - Reads nothing of §1.4 but jets; writes zones, overloadD, jetHealth, engineHealth, radiatorHealth (and hull).
// Rate: per contact solve (impact) and once per tick (overload); ~0.3 µs per manifold point in node.

import type { Quat, V3 } from '../core/types';
import {
  DAMAGE_COMPONENTS, DAMAGE_PRIORITY, HULL_ZONES, N_HULL_ZONES, PART_ZONE, RCS_HIT_RADIUS, STRUCTURE_CAPACITY,
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
  /** Health 0..1 of the primary structure behind the panels (STRUCTURE_CAPACITY J); 0 = the ship is lost. Saved. */
  structure: number;
  /** Derived (not saved): area-weighted mean health of the 12 structural panels; 0 once destroyed. */
  hull: number;
}

export function makeDamageState(): DamageState {
  const zones: number[] = new Array(NC);
  for (let i = 0; i < NC; i++) zones[i] = 1;
  return { zones, overloadD: 0, structure: 1, hull: 1 };
}

/** JSON-safe copy (every value is a finite double and round-trips exactly). */
export function saveDamageState(d: DamageState): { zones: number[]; overloadD: number; structure: number } {
  return { zones: d.zones.slice(), overloadD: d.overloadD, structure: d.structure };
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
  const S = o.structure;
  d.structure = typeof S === 'number' && Number.isFinite(S) ? (S < 0 ? 0 : S > 1 ? 1 : S) : 1;
  d.hull = hullMean(d);
  return d;
}

/** The craft is lost: primary structure used up, or overload damage complete. */
export function isDestroyed(d: DamageState): boolean {
  return d.structure <= 0 || d.overloadD >= 1;
}

// ------------------------------------------------------------------------------------------------ model (load time)

export interface DamageModel {
  /** Kind code per component, capacities and hit boxes (min xyz, max xyz; NaN = none), all flat. */
  kind: Int8Array;
  cap: Float64Array;
  box: Float64Array;
  /** Part-name -> component for part-bound components (pods, radiators, tanks). */
  partComp: Map<string, number>;
  /** Component index of each jet's RCS housing (-1 = none), and the jets' positions (3 per jet). */
  jetQuad: Int16Array;
  jetPos: Float64Array;
  /** Component index per RCS housing index, per engine index, per radiator index. */
  quadComp: Int16Array;
  engineComp: Int16Array;
  radiatorComp: Int16Array;
  /** The non-panel components of each zone in DAMAGE_PRIORITY order: zoneComp[zoneStart[z] .. zoneStart[z + 1]). */
  zoneStart: Int16Array;
  zoneComp: Int16Array;
  /** Panel areas / total (weights of the hull mean). */
  panelW: Float64Array;
  /** Primary structure capacity, J. */
  structCap: number;
}

/**
 * Build the per-craft model: each jet joins the nearest RCS housing centre, per-zone hit lists, flattened hit boxes.
 * Allocates; call once per craft at setup and at load (nothing here is saved).
 */
export function buildDamageModel(jets: readonly { pos: V3 }[], structureCapacity = STRUCTURE_CAPACITY): DamageModel {
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
      if (d < bd) { bd = d; best = qi; }
    }
    jetQuad[k] = best;
  });
  const prio = (i: number): number => DAMAGE_PRIORITY.indexOf(DAMAGE_COMPONENTS[i].kind);
  const zoneStart = new Int16Array(N_HULL_ZONES + 1), list: number[] = [];
  for (let z = 0; z < N_HULL_ZONES; z++) {
    zoneStart[z] = list.length;
    const cs = HULL_ZONES[z].components.filter((i) => DAMAGE_COMPONENTS[i].kind !== 'panel');
    cs.sort((a, b) => prio(a) - prio(b) || a - b);
    list.push(...cs);
  }
  zoneStart[N_HULL_ZONES] = list.length;
  let A = 0;
  for (let z = 0; z < N_HULL_ZONES; z++) A += HULL_ZONES[z].area;
  const panelW = new Float64Array(N_HULL_ZONES);
  for (let z = 0; z < N_HULL_ZONES; z++) panelW[z] = HULL_ZONES[z].area / A;
  return {
    kind, cap, box, partComp, jetQuad, jetPos, quadComp: Int16Array.from(quads), engineComp: Int16Array.from(engines),
    radiatorComp: Int16Array.from(rads), zoneStart, zoneComp: Int16Array.from(list), panelW, structCap: structureCapacity,
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
 * The component a hit at ship-local `p` on part `part` in skin zone `zone` strikes: the first of that zone's
 * components (in DAMAGE_PRIORITY order) whose hit volume holds the point (window and collar boxes, a sphere of
 * RCS_HIT_RADIUS round any jet of a housing, the part itself for pods, radiators and tanks) and that still has
 * health; else the zone's panel (component index = zone). Never a component under another zone's skin.
 */
export function componentAt(d: DamageState, m: DamageModel, part: string, p: V3, zone: number): number {
  if (!(zone >= 0 && zone < N_HULL_ZONES)) return Z_NOSE;
  const r2 = RCS_HIT_RADIUS * RCS_HIT_RADIUS;
  const pc = m.partComp.get(part);
  for (let k = m.zoneStart[zone], e = m.zoneStart[zone + 1]; k < e; k++) {
    const i = m.zoneComp[k];
    if (d.zones[i] <= 0) continue;
    const kc = m.kind[i];
    if (kc === 1 || kc === 5) {
      if (inBox(m.box, i, p)) return i;
    } else if (kc === 2) {
      for (let j = 0; j < m.jetQuad.length; j++) {
        if (m.jetQuad[j] !== i) continue;
        const dx = p.x - m.jetPos[j * 3], dy = p.y - m.jetPos[j * 3 + 1], dz = p.z - m.jetPos[j * 3 + 2];
        if (dx * dx + dy * dy + dz * dz <= r2) return i;
      }
    } else if (pc === i) {
      return i;
    }
  }
  return zone;
}

/**
 * Put `E` joules into component `i`: beyond its remaining health the rest goes to its zone's panel, beyond the
 * panel's to the primary structure. Returns the energy left over once the structure is gone too (0 while the craft
 * stands; > 0 only for a lost craft), so Σ absorbed + returned = E.
 */
export function absorb(d: DamageState, m: DamageModel, i: number, E: number): number {
  if (!(E > 0)) return 0;
  let rest = E;
  if (m.kind[i] !== 0) {
    const need = d.zones[i] * m.cap[i];
    if (rest <= need) { const h = d.zones[i] - rest / m.cap[i]; d.zones[i] = h > 0 ? h : 0; rest = 0; } else { d.zones[i] = 0; rest -= need; }
  }
  if (rest > 0) {
    const z = DAMAGE_COMPONENTS[i].zone, need = d.zones[z] * m.cap[z];
    if (rest <= need) { const h = d.zones[z] - rest / m.cap[z]; d.zones[z] = h > 0 ? h : 0; rest = 0; } else { d.zones[z] = 0; rest -= need; }
  }
  if (rest > 0) {
    const need = d.structure * m.structCap;
    if (rest <= need) { const h = d.structure - rest / m.structCap; d.structure = h > 0 ? h : 0; rest = 0; } else { d.structure = 0; rest -= need; }
  }
  d.hull = hullMean(d);
  return rest;
}

/** Energy straight into one component (e.g. the collar from the capture ring's hard stop). Returns the overflow. */
export function damageComponent(d: DamageState, m: DamageModel, i: number, E: number): number {
  return absorb(d, m, i, E);
}

/** One hit: zone, component, absorb. Returns the component index struck. */
export function damageAt(d: DamageState, m: DamageModel, part: string, p: V3, nOut: V3, E: number): number {
  const c = componentAt(d, m, part, p, zoneOfPoint(part, p, nOut));
  absorb(d, m, c, E);
  return c;
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

/** Mass of a craft for the load factor: dry + main propellant + RCS propellant (missing fields count 0). */
const massOf = (c: { dryMass: number; propellant: number; rcsPropellant?: number }): number =>
  c.dryMass + c.propellant + (c.rcsPropellant !== undefined && c.rcsPropellant > 0 ? c.rcsPropellant : 0);

/**
 * Graded overload over one consumed ledger span (once per tick, per quantum under warp — exact for a constant mean):
 * n = |f|/(m·g0), m = dry + propellant + RCS propellant; D += max(0, (n − 6)/(9 − 6))·T / 2 s. Destroy the craft
 * when isDestroyed(d).
 */
export function overloadStep(d: DamageState, mean: { f: V3; T: number }, c: { dryMass: number; propellant: number; rcsPropellant?: number }): void {
  const f = mean.f, m = massOf(c);
  if (!(mean.T > 0) || !(m > 0)) return;
  const n = Math.sqrt(f.x * f.x + f.y * f.y + f.z * f.z) / (m * G0);
  if (!(n > OVERLOAD_LIMIT)) return;
  const D = d.overloadD + ((n - OVERLOAD_LIMIT) / (OVERLOAD_ULTIMATE - OVERLOAD_LIMIT)) * (mean.T / OVERLOAD_TIME);
  d.overloadD = D > 1 ? 1 : D;
  if (d.overloadD >= 1) d.hull = 0;
}

/**
 * The overload dose of a contact impulse J (N·s, magnitude on this craft) that struck skin zone `zone`: Δv = J/m
 * over a pulse of T = min(π·√(m/K_SHIP) (the elastic contact's half period), 2·crushDepth/Δv (a constant-force crush
 * through the zone's crushable depth)), n = Δv/(g0·T), D += max(0, (n − 6)/3)·T/2 s. For n ≫ 9 this is a Δv dose,
 * D ≈ Δv/(6·g0) ≈ Δv/59 m/s, nearly independent of T. Returns n. Call once per manifold solve that has a craft.
 */
export function impactOverload(d: DamageState, J: number, zone: number, c: { dryMass: number; propellant: number; rcsPropellant?: number }): number {
  const m = massOf(c);
  if (!(J > 0) || !(m > 0) || !Number.isFinite(J)) return 0;
  const dv = J / m;
  const depth = zone >= 0 && zone < N_HULL_ZONES ? HULL_ZONES[zone].crushDepth : 0.2;
  const T1 = Math.PI * Math.sqrt(m / K_SHIP), T2 = (2 * depth) / dv, T = T1 < T2 ? T1 : T2;
  const n = dv / (G0 * T);
  if (n > OVERLOAD_LIMIT) {
    const D = d.overloadD + ((n - OVERLOAD_LIMIT) / (OVERLOAD_ULTIMATE - OVERLOAD_LIMIT)) * (T / OVERLOAD_TIME);
    d.overloadD = D > 1 ? 1 : D;
    if (d.overloadD >= 1) d.hull = 0;
  }
  return n;
}

// ------------------------------------------------------------------------------------------------ derived

function hullMean(d: DamageState): number {
  let s = 0, A = 0;
  for (let z = 0; z < N_HULL_ZONES; z++) { const a = HULL_ZONES[z].area; s += a * d.zones[z]; A += a; }
  const h = s / A;
  return d.overloadD >= 1 || d.structure <= 0 ? 0 : h;
}

/**
 * Fill the §1.4 health arrays: jetHealth[j] = 1 while its RCS housing has health, 0 once disabled (50 kJ); engineHealth
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
