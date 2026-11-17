// Tests for src/sim/universe.ts and the data it is built from — the generated Ember Reach.
//
// Every galaxy-wide invariant is checked over several seeds. The physical checks are written here
// from first principles (Roche limit, Hill radius, SOI, Hohmann transfers, black-body temperatures)
// rather than by calling the generator's own helpers, so that a wrong formula in the generator
// cannot vouch for itself. The generator's `validateSystem` is run as well, as a second opinion.

import { describe, expect, it, vi } from 'vitest';
import type { BodyDef, FactionDef, MiningSiteDef, OrbitElements, PowerId, StationDef, SystemDef } from '../src/core/types';
import { AU, DEG, EARTH_MASS, G, SOLAR_MASS, SOLAR_RADIUS } from '../src/core/units';
import { COMMODITIES, MINEABLE_COMMODITY_IDS } from '../src/data/commodities';
import { POWERS, POWER_GOVERNMENTS } from '../src/data/powers';
import { SystemModel, deriveSystem, orbitNormalFromElements } from '../src/sim/orbit';
import {
  MAX_GUARANTEED_JUMP_LY,
  bodySpinAxis,
  describeSystem,
  estimateTransferDv,
  factionsIn,
  generateGalaxy,
  getBody,
  getFaction,
  getStation,
  getSystem,
  shortestRoute,
  systemDistance,
  systemsWithin,
  tidalLockRadius,
  validateSystem,
  type GalaxyDef,
} from '../src/sim/universe';

const SEEDS = [1, 2, 3, 77, 2907, 123456789];
const GALAXIES: GalaxyDef[] = SEEDS.map((seed) => generateGalaxy(seed));

// ---------------------------------------------------------------- helpers (independent of the generator)

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`missing ${what}`);
  return value;
}

const isGiant = (b: BodyDef): boolean => b.cls === 'gasGiant' || b.cls === 'iceGiant';
/** Radius of the top of the atmosphere (the surface of an airless body), m. */
const topOf = (b: BodyDef): number => b.radius + (b.atmosphere?.height ?? 0);
const peri = (o: OrbitElements): number => o.a * (1 - o.e);
const apo = (o: OrbitElements): number => o.a * (1 + o.e);
const density = (b: BodyDef): number => b.mass / ((4 / 3) * Math.PI * b.radius ** 3);
/** Fluid Roche limit of `primary` for a satellite of density `rho`, m. */
const roche = (primary: BodyDef, rho: number): number => 2.44 * primary.radius * Math.cbrt(density(primary) / rho);
const hill = (o: OrbitElements, m: number, M: number): number => o.a * (1 - o.e) * Math.cbrt(m / (3 * M));
/** Stellar flux at distance `a` from a star of luminosity `L` (solar), in Earth-insolation units. */
const fluxAt = (L: number, a: number): number => L / (a / AU) ** 2;
/** Black-body equilibrium temperature at flux S (Earth = 1) and Bond albedo A, K. */
const eqTemp = (S: number, A: number): number => 278.3 * Math.pow(S * (1 - A), 0.25);

/** Two-burn Hohmann transfer between coplanar circular orbits, m/s. */
function hohmann(mu: number, r1: number, r2: number): number {
  const at = (r1 + r2) / 2;
  const dv1 = Math.abs(Math.sqrt(mu * (2 / r1 - 1 / at)) - Math.sqrt(mu / r1));
  const dv2 = Math.abs(Math.sqrt(mu / r2) - Math.sqrt(mu * (2 / r2 - 1 / at)));
  return dv1 + dv2;
}

const bodyOf = (system: SystemDef, id: string): BodyDef => must(system.bodies.find((b) => b.id === id), `body ${id}`);

/**
 * Simple delta-v between two stations: a Hohmann transfer when they share a parent; when one orbits
 * a moon and the other that moon's planet, a Hohmann transfer at the planet with the departure burn
 * made in low orbit of the moon (patched conic). Infinity for anything farther apart.
 */
function hopDv(system: SystemDef, a: StationDef, b: StationDef): number {
  const pa = bodyOf(system, a.parentBodyId);
  const pb = bodyOf(system, b.parentBodyId);
  if (pa.id === pb.id) return hohmann(pa.mu, a.orbit.a, b.orbit.a);
  let low: StationDef;
  let high: StationDef;
  let moon: BodyDef;
  let planet: BodyDef;
  if (pa.parentId === pb.id) [low, high, moon, planet] = [a, b, pa, pb];
  else if (pb.parentId === pa.id) [low, high, moon, planet] = [b, a, pb, pa];
  else return Infinity;
  const r1 = must(moon.orbit, 'moon orbit').a;
  const r2 = high.orbit.a;
  const at = (r1 + r2) / 2;
  const vInf = Math.abs(Math.sqrt(planet.mu * (2 / r1 - 1 / at)) - Math.sqrt(planet.mu / r1));
  const depart = Math.sqrt(vInf * vInf + (2 * moon.mu) / low.orbit.a) - Math.sqrt(moon.mu / low.orbit.a);
  const arrive = Math.abs(Math.sqrt(planet.mu / r2) - Math.sqrt(planet.mu * (2 / r2 - 1 / at)));
  return depart + arrive;
}

function cheapestHop(system: SystemDef): number {
  let best = Infinity;
  for (let i = 0; i < system.stations.length; i++) {
    for (let j = i + 1; j < system.stations.length; j++) best = Math.min(best, hopDv(system, system.stations[i], system.stations[j]));
  }
  return best;
}

/** Ids reachable from `from` with hops of at most `range` light-years, ignoring `without`. */
function reachable(galaxy: GalaxyDef, from: string, range: number, without?: string): Set<string> {
  const pos = new Map(galaxy.systems.map((s) => [s.id, s.pos]));
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const cur = must(pos.get(queue.pop() as string), 'position');
    for (const s of galaxy.systems) {
      if (seen.has(s.id) || s.id === without) continue;
      if (Math.hypot(cur.x - s.pos.x, cur.y - s.pos.y, cur.z - s.pos.z) <= range) {
        seen.add(s.id);
        queue.push(s.id);
      }
    }
  }
  return seen;
}

/** Fewest hops from `from` to every system at `range` light-years (breadth-first). */
function hopCounts(galaxy: GalaxyDef, from: string, range: number): Map<string, number> {
  const out = new Map<string, number>([[from, 0]]);
  let frontier = [from];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      const here = must(galaxy.systems.find((s) => s.id === id), id);
      for (const s of galaxy.systems) {
        if (out.has(s.id)) continue;
        if (Math.hypot(here.pos.x - s.pos.x, here.pos.y - s.pos.y, here.pos.z - s.pos.z) <= range) {
          out.set(s.id, must(out.get(id), id) + 1);
          next.push(s.id);
        }
      }
    }
    frontier = next;
  }
  return out;
}

const inhabited = (g: GalaxyDef): SystemDef[] => g.systems.filter((s) => s.stations.length > 0);
const presenceIn = (g: GalaxyDef, systemId: string): GalaxyDef['initialPresence'] => g.initialPresence.filter((p) => p.systemId === systemId);
const factionOf = (g: GalaxyDef, id: string): FactionDef => must(g.factions.find((f) => f.id === id), `faction ${id}`);
const orbiters = (s: SystemDef): (StationDef | MiningSiteDef)[] => [...s.stations, ...s.miningSites];

function eachSystem(fn: (system: SystemDef, galaxy: GalaxyDef) => void): void {
  for (const g of GALAXIES) for (const s of g.systems) fn(s, g);
}

// ---------------------------------------------------------------- determinism

describe('generateGalaxy: determinism', () => {
  it('returns the same galaxy for the same seed', () => {
    for (const seed of [1, 77]) {
      const a = generateGalaxy(seed);
      const b = generateGalaxy(seed);
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
      expect(describeSystem(a.systems[1], a)).toBe(describeSystem(b.systems[1], b));
    }
    expect(GALAXIES[0]).toEqual(generateGalaxy(SEEDS[0]));
    expect(GALAXIES[0].seed).toBe(SEEDS[0]);
  });

  it('never touches Math.random or Date.now', () => {
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random called by the simulation');
    });
    const now = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now called by the simulation');
    });
    try {
      const g = generateGalaxy(4242);
      expect(g.systems.length).toBe(24);
      expect(describeSystem(g.systems[3], g).length).toBeGreaterThan(200);
      expect(random).not.toHaveBeenCalled();
      expect(now).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
      now.mockRestore();
    }
  });

  it('gives different seeds different generated systems and the same showpieces', () => {
    const [a, b] = GALAXIES;
    const namesA = a.systems.map((s) => s.name).join('|');
    const namesB = b.systems.map((s) => s.name).join('|');
    expect(namesA).not.toBe(namesB);
    const showpieces = [a.startSystemId, ...a.powers.map((p) => p.capitalSystemId)];
    expect(new Set(showpieces).size).toBe(4);
    for (const id of showpieces) {
      const sa = must(getSystem(a, id), id);
      const sb = must(getSystem(b, id), id);
      expect(sa.bodies).toEqual(sb.bodies);
      expect(sa.stations).toEqual(sb.stations);
      expect(sa.miningSites).toEqual(sb.miningSites);
      expect(sa.jumpBeacon).toEqual(sb.jumpBeacon);
    }
    // Generated systems differ in more than name.
    const differing = a.systems.filter((s, i) => JSON.stringify(s.bodies.map((x) => x.mass)) !== JSON.stringify(b.systems[i].bodies.map((x) => x.mass)));
    expect(differing.length).toBeGreaterThanOrEqual(15);
  });

  it('does not let callers corrupt shared data', () => {
    const a = generateGalaxy(9);
    a.commodities[0].basePrice = -1;
    a.commodities[0].illegalUnder.push('anarchy');
    a.powers[0].name = 'changed';
    const b = generateGalaxy(9);
    expect(b.commodities[0].basePrice).toBeGreaterThan(0);
    expect(b.powers[0].name).toBe(POWERS[0].name);
    expect(COMMODITIES[0].basePrice).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- ids and structure

describe('ids and structure', () => {
  it('has about 24 systems with unique ids and names', () => {
    for (const g of GALAXIES) {
      expect(g.systems.length).toBeGreaterThanOrEqual(22);
      expect(g.systems.length).toBeLessThanOrEqual(26);
      expect(new Set(g.systems.map((s) => s.id)).size).toBe(g.systems.length);
      expect(new Set(g.systems.map((s) => s.name)).size).toBe(g.systems.length);
      for (const s of g.systems) expect(s.id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('gives every body, station, site and faction a unique id', () => {
    for (const g of GALAXIES) {
      const ids: string[] = [];
      for (const s of g.systems) {
        for (const b of s.bodies) ids.push(b.id);
        for (const st of s.stations) ids.push(st.id);
        for (const m of s.miningSites) ids.push(m.id);
        for (const o of [...s.bodies, ...s.stations, ...s.miningSites]) expect(o.id.startsWith(`${s.id}.`), o.id).toBe(true);
        for (const o of orbiters(s)) expect(o.systemId).toBe(s.id);
      }
      for (const f of g.factions) ids.push(f.id);
      for (const s of g.systems) ids.push(s.id);
      expect(new Set(ids).size).toBe(ids.length);
      // No two things share a name either, anywhere in the cluster.
      const names: string[] = [...g.factions.map((f) => f.name)];
      for (const s of g.systems) names.push(...s.bodies.filter((b) => b.kind !== 'star').map((b) => b.name), ...s.stations.map((x) => x.name), ...s.miningSites.map((x) => x.name));
      const repeated = names.filter((n, i) => names.indexOf(n) !== i);
      expect(repeated).toEqual([]);
    }
  });

  it('lists the primary star first and parents before their children', () => {
    eachSystem((s) => {
      const star = s.bodies[0];
      expect(star.kind).toBe('star');
      expect(star.cls).toBe('star');
      expect(star.parentId).toBeNull();
      expect(star.orbit).toBeNull();
      expect(star.soi).toBe(Infinity);
      expect(star.star).not.toBeNull();
      const seen = new Map<string, BodyDef>([[star.id, star]]);
      for (const b of s.bodies.slice(1)) {
        const parent = seen.get(b.parentId as string);
        expect(parent, `${b.id}: parent ${b.parentId} must precede it`).toBeDefined();
        expect(b.orbit, b.id).not.toBeNull();
        expect(b.star, b.id).toBeNull();
        if (b.kind === 'planet') expect(parent?.kind, b.id).toBe('star');
        else {
          expect(b.kind, b.id).toBe('moon');
          expect(parent?.kind, b.id).toBe('planet');
        }
        seen.set(b.id, b);
      }
      for (const o of orbiters(s)) expect(seen.has(o.parentBodyId), o.id).toBe(true);
      expect(seen.has(s.jumpBeacon.bodyId)).toBe(true);
    });
  });

  it('answers lookups by id', () => {
    const g = GALAXIES[0];
    for (const s of g.systems) {
      expect(getSystem(g, s.id)).toBe(s);
      for (const b of s.bodies) {
        expect(getBody(g, b.id)).toBe(b);
        expect(getBody(s, b.id)).toBe(b);
      }
      for (const st of s.stations) {
        expect(getStation(g, st.id)).toBe(st);
        expect(getStation(s, st.id)).toBe(st);
      }
    }
    for (const f of g.factions) expect(getFaction(g, f.id)).toBe(f);
    expect(getSystem(g, 'nowhere')).toBeUndefined();
    expect(getBody(g, 'nowhere.rock')).toBeUndefined();
    expect(getStation(g, 'nowhere.st.dock')).toBeUndefined();
    expect(getStation(g.systems[0], g.systems[1].stations[0]?.id ?? 'x')).toBeUndefined();
  });

  it('passes its own validator and loads into the orbital model', () => {
    eachSystem((s) => {
      expect(validateSystem(s)).toEqual([]);
    });
    for (const s of GALAXIES[0].systems) {
      expect(() => new SystemModel(s)).not.toThrow();
      // The derived fields agree with what the orbit module would compute for itself.
      const derived = deriveSystem(s);
      s.bodies.forEach((b, i) => {
        const d = derived.bodies[i];
        expect(Math.abs(d.mu - b.mu)).toBeLessThanOrEqual(1e-9 * b.mu);
        if (i > 0) {
          expect(Math.abs(d.soi - b.soi)).toBeLessThanOrEqual(1e-9 * b.soi);
          expect(Math.abs(d.rotationPeriod - b.rotationPeriod)).toBeLessThanOrEqual(1e-6 * b.rotationPeriod);
        }
      });
    }
  });
});

// ---------------------------------------------------------------- stars and worlds

describe('stars', () => {
  it('are mostly red dwarfs, with a few K/G/F stars, a white dwarf and brown dwarfs', () => {
    for (const g of GALAXIES) {
      const classes = g.systems.map((s) => must(s.bodies[0].star, 'star').spectralClass);
      const count = (re: RegExp): number => classes.filter((c) => re.test(c)).length;
      expect(count(/^M\dV$/)).toBeGreaterThanOrEqual(0.6 * g.systems.length);
      expect(count(/^K\dV$/)).toBeGreaterThanOrEqual(1);
      expect(count(/^G\dV$/)).toBeGreaterThanOrEqual(1);
      expect(count(/^F\dV$/)).toBeGreaterThanOrEqual(1);
      expect(count(/^[KGF]\dV$/)).toBeLessThanOrEqual(6);
      expect(count(/^D/)).toBe(1);
      expect(count(/^[LT]\d$/)).toBeGreaterThanOrEqual(1);
      for (const c of classes) expect(c).toMatch(/^([FGKM]\dV|DA\d|[LT]\d)$/);
    }
  });

  it('have mass, radius, temperature and luminosity that belong together', () => {
    eachSystem((s) => {
      const b = s.bodies[0];
      const st = must(b.star, 'star');
      const m = b.mass / SOLAR_MASS;
      const r = b.radius / SOLAR_RADIUS;
      expect(b.mu).toBeCloseTo(G * b.mass, -8);
      // Stefan–Boltzmann: L = R^2 T^4 in solar units.
      const sb = r * r * Math.pow(st.temperature / 5772, 4);
      expect(Math.abs(st.luminosity - sb) / sb, `${b.id} luminosity`).toBeLessThan(0.02);
      expect(st.temperature).toBe(b.temperature);
      expect(st.activity).toBeGreaterThanOrEqual(0);
      expect(st.activity).toBeLessThanOrEqual(1);
      for (const ch of st.color) {
        expect(ch).toBeGreaterThanOrEqual(0);
        expect(ch).toBeLessThanOrEqual(1);
      }
      expect(Math.max(...st.color)).toBeCloseTo(1, 3);
      const cls = st.spectralClass;
      if (cls.endsWith('V')) {
        // Main sequence: hotter, bigger and far brighter with mass.
        const band: Record<string, [number, number, number, number]> = {
          // class: [min mass, max mass, min T, max T]
          M: [0.075, 0.62, 2300, 3950],
          K: [0.55, 0.9, 3850, 5350],
          G: [0.82, 1.12, 5250, 6050],
          F: [1.02, 1.6, 5950, 7350],
        };
        const [mLo, mHi, tLo, tHi] = band[cls[0]];
        expect(m, `${b.id} mass`).toBeGreaterThanOrEqual(mLo);
        expect(m, `${b.id} mass`).toBeLessThanOrEqual(mHi);
        expect(st.temperature, `${b.id} temperature`).toBeGreaterThanOrEqual(tLo);
        expect(st.temperature, `${b.id} temperature`).toBeLessThanOrEqual(tHi);
        expect(r / m, `${b.id} radius`).toBeGreaterThan(0.75);
        expect(r / m, `${b.id} radius`).toBeLessThan(1.45);
        // Red in the M dwarfs, near white in the F stars.
        if (cls[0] === 'M') expect(st.color[2]).toBeLessThan(0.45);
        if (cls[0] === 'F') expect(st.color[2]).toBeGreaterThan(0.7);
      } else if (cls.startsWith('D')) {
        // White dwarf: a stellar mass in a body about the size of the Earth.
        expect(m).toBeGreaterThan(0.4);
        expect(m).toBeLessThan(1.3);
        expect(b.radius).toBeGreaterThan(4e6);
        expect(b.radius).toBeLessThan(1.5e7);
        expect(st.temperature).toBeGreaterThan(5000);
      } else {
        // Brown dwarf: below the hydrogen-burning limit, about the size of Jupiter, barely glowing.
        expect(m).toBeGreaterThan(0.012);
        expect(m).toBeLessThan(0.078);
        expect(b.radius).toBeGreaterThan(5e7);
        expect(b.radius).toBeLessThan(9e7);
        expect(st.temperature).toBeLessThan(2400);
        expect(st.luminosity).toBeLessThan(1e-3);
      }
    });
  });
});

describe('planets and moons', () => {
  it('have mu = G·mass, the patched-conic SOI and sensible bulk densities', () => {
    eachSystem((s) => {
      const byId = new Map(s.bodies.map((b) => [b.id, b]));
      for (const b of s.bodies.slice(1)) {
        const parent = must(byId.get(b.parentId as string), 'parent');
        const o = must(b.orbit, 'orbit');
        expect(Math.abs(b.mu - G * b.mass), b.id).toBeLessThanOrEqual(1e-12 * b.mu);
        expect(Math.abs(b.soi - o.a * Math.pow(b.mass / parent.mass, 0.4)), b.id).toBeLessThanOrEqual(1e-9 * b.soi);
        expect(b.soi, `${b.id}: SOI must enclose the body`).toBeGreaterThan(topOf(b));
        expect(b.mass, b.id).toBeLessThan(0.02 * parent.mass);
        const rho = density(b);
        if (isGiant(b)) {
          expect(rho, `${b.id} density`).toBeGreaterThan(250);
          expect(rho, `${b.id} density`).toBeLessThan(4000);
          expect(b.mass).toBeGreaterThan(5 * EARTH_MASS);
          expect(b.radius).toBeGreaterThan(1.4e7);
          expect(b.radius).toBeLessThan(8.5e7);
        } else {
          expect(rho, `${b.id} density`).toBeGreaterThan(b.cls === 'ice' ? 900 : 2400);
          expect(rho, `${b.id} density`).toBeLessThan(8500);
          expect(b.mass).toBeLessThan(5 * EARTH_MASS);
          expect(b.radius).toBeGreaterThan(1e5);
          expect(b.radius).toBeLessThan(1.1e7);
        }
        expect(o.e).toBeGreaterThanOrEqual(0);
        expect(o.e).toBeLessThan(0.2);
        expect(o.epoch).toBe(0);
        expect(b.rotationPeriod).toBeGreaterThan(0);
        expect(b.surveyValue, b.id).toBeGreaterThan(0);
      }
      expect(s.bodies[0].surveyValue).toBeGreaterThan(0);
    });
  });

  it('keeps every orbit inside half the parent SOI with its periapsis above the surface and the air', () => {
    eachSystem((s) => {
      const byId = new Map(s.bodies.map((b) => [b.id, b]));
      for (const b of s.bodies.slice(1)) {
        const parent = must(byId.get(b.parentId as string), 'parent');
        const o = must(b.orbit, 'orbit');
        expect(peri(o), `${b.id} periapsis`).toBeGreaterThan(topOf(parent) + b.radius);
        if (parent.kind !== 'star') expect(apo(o), `${b.id} apoapsis`).toBeLessThan(0.5 * parent.soi);
        // Nothing sweeps through a neighbour: siblings keep clear of each other's SOI.
        for (const other of s.bodies) {
          if (other === b || other.parentId !== b.parentId || !other.orbit || other.orbit.a < o.a) continue;
          expect(peri(other.orbit) - apo(o), `${b.id} vs ${other.id}`).toBeGreaterThan(b.soi + other.soi);
        }
      }
      for (const o of orbiters(s)) {
        const parent = must(byId.get(o.parentBodyId), 'parent');
        expect(peri(o.orbit), `${o.id} periapsis`).toBeGreaterThan(topOf(parent));
        if (parent.kind !== 'star') expect(apo(o.orbit), `${o.id} apoapsis`).toBeLessThan(0.5 * parent.soi);
      }
    });
  });

  it('spaces neighbouring planets by mutual Hill radii', () => {
    eachSystem((s) => {
      const star = s.bodies[0];
      const planets = s.bodies.filter((b) => b.kind === 'planet');
      expect(planets.length).toBeGreaterThanOrEqual(2);
      expect(planets.length).toBeLessThanOrEqual(9);
      for (let k = 0; k + 1 < planets.length; k++) {
        const p = planets[k];
        const q = planets[k + 1];
        const po = must(p.orbit, 'orbit');
        const qo = must(q.orbit, 'orbit');
        expect(qo.a, 'planets are listed inner to outer').toBeGreaterThan(po.a);
        const mutual = Math.cbrt((p.mass + q.mass) / (3 * star.mass)) * 0.5 * (po.a + qo.a);
        expect((peri(qo) - apo(po)) / mutual, `${p.id} / ${q.id}`).toBeGreaterThanOrEqual(5);
      }
      // The innermost planet is outside the star and its Roche limit.
      const inner = planets[0];
      expect(peri(must(inner.orbit, 'orbit'))).toBeGreaterThan(Math.max(2 * star.radius, roche(star, density(inner))));
    });
  });

  it('keeps moons outside the Roche limit and inside 0.4 Hill radii', () => {
    let moons = 0;
    eachSystem((s) => {
      const star = s.bodies[0];
      const byId = new Map(s.bodies.map((b) => [b.id, b]));
      for (const m of s.bodies.filter((b) => b.kind === 'moon')) {
        moons++;
        const planet = must(byId.get(m.parentId as string), 'planet');
        const o = must(m.orbit, 'orbit');
        // Rubble-pile satellite (2,000 kg/m^3) and the moon's own density: outside both limits.
        expect(peri(o), `${m.id} Roche`).toBeGreaterThan(roche(planet, 2000));
        expect(peri(o), `${m.id} Roche`).toBeGreaterThan(roche(planet, density(m)));
        expect(apo(o), `${m.id} Hill`).toBeLessThan(0.4 * hill(must(planet.orbit, 'orbit'), planet.mass, star.mass));
        expect(m.mass, `${m.id} mass ratio`).toBeLessThan(0.02 * planet.mass);
        if (planet.rings) expect(peri(o), `${m.id} is outside the rings`).toBeGreaterThan(planet.rings.outerRadius);
        expect(m.tidallyLocked, `${m.id} is locked to its planet`).toBe(true);
      }
    });
    expect(moons).toBeGreaterThan(100);
  });

  it('tidally locks close-in worlds and puts eyeball worlds in the habitable zone', () => {
    let eyeballs = 0;
    let turning = 0;
    eachSystem((s) => {
      const star = s.bodies[0];
      const L = must(star.star, 'star').luminosity;
      const byId = new Map(s.bodies.map((b) => [b.id, b]));
      for (const b of s.bodies.slice(1)) {
        const parent = must(byId.get(b.parentId as string), 'parent');
        const o = must(b.orbit, 'orbit');
        const period = 2 * Math.PI * Math.sqrt(o.a ** 3 / parent.mu);
        if (b.tidallyLocked) {
          expect(Math.abs(b.rotationPeriod - period) / period, `${b.id} day = year`).toBeLessThan(1e-6);
        } else {
          turning++;
          expect(b.rotationPeriod, b.id).toBeGreaterThan(3 * 3600);
          expect(b.rotationPeriod, b.id).toBeLessThan(0.5 * period);
        }
        if (b.kind === 'planet' && !isGiant(b) && o.a < 0.9 * tidalLockRadius(star.mass)) expect(b.tidallyLocked, `${b.id} should be locked`).toBe(true);
        if (b.kind === 'planet' && o.a > 1.1 * tidalLockRadius(star.mass)) expect(b.tidallyLocked, `${b.id} should turn`).toBe(false);
        if (b.cls === 'eyeball') {
          eyeballs++;
          const flux = fluxAt(L, o.a);
          expect(b.kind).toBe('planet');
          expect(b.tidallyLocked, b.id).toBe(true);
          expect(flux, `${b.id} flux`).toBeGreaterThan(0.3);
          expect(flux, `${b.id} flux`).toBeLessThan(1.6);
          expect(b.atmosphere, b.id).not.toBeNull();
          expect(b.temperature).toBeGreaterThan(215);
          expect(b.temperature).toBeLessThan(325);
          expect(b.mass).toBeGreaterThan(0.3 * EARTH_MASS);
          // Red and orange dwarfs only: under a brighter star the habitable zone lies beyond the lock radius.
          expect(must(star.star, 'star').temperature).toBeLessThan(5300);
        }
        if (b.cls === 'terran') expect(b.tidallyLocked, `${b.id}: a turning world`).toBe(false);
      }
    });
    expect(eyeballs).toBeGreaterThanOrEqual(3 * GALAXIES.length);
    expect(turning).toBeGreaterThan(10 * GALAXIES.length);
  });

  it('sets temperatures from stellar flux', () => {
    eachSystem((s) => {
      const star = s.bodies[0];
      const L = must(star.star, 'star').luminosity;
      const byId = new Map(s.bodies.map((b) => [b.id, b]));
      const planets = s.bodies.filter((b) => b.kind === 'planet');
      for (const b of s.bodies.slice(1)) {
        const planet = b.kind === 'moon' ? must(byId.get(b.parentId as string), 'planet') : b;
        const S = fluxAt(L, must(planet.orbit, 'orbit').a);
        if (isGiant(b)) {
          // One-bar level: warmer than the cloud tops, and never colder than the giant's own heat allows.
          expect(b.temperature, b.id).toBeGreaterThanOrEqual(Math.floor(eqTemp(S, 0.6)));
          expect(b.temperature, b.id).toBeLessThan(1.4 * eqTemp(S, 0) + 220);
        } else {
          // Between a bright (albedo 0.75) and a black body, plus greenhouse warming under air.
          expect(b.temperature, `${b.id} at flux ${S.toFixed(3)}`).toBeGreaterThanOrEqual(Math.floor(eqTemp(S, 0.75)));
          expect(b.temperature, `${b.id} at flux ${S.toFixed(3)}`).toBeLessThanOrEqual(Math.ceil(eqTemp(S, 0)) + (b.atmosphere ? 90 : 1));
        }
        if (b.cls === 'lava' && b.kind === 'planet') expect(S, `${b.id}: lava worlds are scorched`).toBeGreaterThan(2);
        if (b.cls === 'ice') expect(b.temperature, `${b.id}: ice stays frozen`).toBeLessThan(200);
        if (b.cls === 'terran' || b.cls === 'ocean') {
          expect(b.temperature, b.id).toBeGreaterThan(255);
          expect(b.temperature, b.id).toBeLessThan(320);
        }
      }
      // Airless worlds get colder with distance.
      const bare = planets.filter((p) => !p.atmosphere && !isGiant(p) && p.cls !== 'ice');
      for (let k = 0; k + 1 < bare.length; k++) expect(bare[k + 1].temperature).toBeLessThan(bare[k].temperature);
    });
  });

  it('gives atmospheres realistic scale heights and densities', () => {
    let airs = 0;
    eachSystem((s) => {
      for (const b of s.bodies.slice(1)) {
        const at = b.atmosphere;
        if (isGiant(b)) expect(at, `${b.id}: giants have air`).not.toBeNull();
        if (b.cls === 'terran' || b.cls === 'ocean' || b.cls === 'eyeball' || b.cls === 'desert') expect(at, `${b.id} has air`).not.toBeNull();
        if (b.cls === 'barren') expect(at, `${b.id} is airless`).toBeNull();
        if (!at) continue;
        airs++;
        const g = b.mu / (b.radius * b.radius);
        expect(at.scaleHeight, b.id).toBeGreaterThan(2000);
        expect(at.height, b.id).toBeGreaterThan(at.scaleHeight);
        expect(at.height, b.id).toBeLessThanOrEqual(0.25 * b.radius + 1);
        expect(at.surfaceDensity, b.id).toBeGreaterThan(0);
        // The shell ends where the exponential has thinned to nothing (or at the quarter-radius cap).
        const atTop = at.surfaceDensity * Math.exp(-at.height / at.scaleHeight);
        if (at.height < 0.2499 * b.radius) expect(atTop, `${b.id} density at the top`).toBeLessThan(2e-7);
        // H = R T / (M g): the implied molar mass must be a real gas (hydrogen 2 g/mol .. heavy vapours 60 g/mol).
        const molar = (8.314462618 * b.temperature) / (at.scaleHeight * g);
        expect(molar, `${b.id} molar mass`).toBeGreaterThan(0.0019);
        expect(molar, `${b.id} molar mass`).toBeLessThan(0.065);
        // Ideal gas: the implied surface pressure, Pa.
        const pressure = (at.surfaceDensity * 8.314462618 * b.temperature) / molar;
        if (isGiant(b)) {
          expect(at.scoopable, b.id).toBe(true);
          expect(molar, `${b.id}: hydrogen-rich`).toBeLessThan(0.004);
          expect(pressure / 1e5, `${b.id}: one-bar level`).toBeCloseTo(1, 1);
        } else {
          expect(at.scoopable, b.id).toBe(false);
          expect(pressure, b.id).toBeLessThan(1e7);
        }
        if (b.cls === 'terran' || b.cls === 'ocean' || b.cls === 'eyeball') {
          expect(at.surfaceDensity, b.id).toBeGreaterThan(0.5);
          expect(at.surfaceDensity, b.id).toBeLessThan(3.2);
          expect(at.scaleHeight, b.id).toBeGreaterThan(4500);
          expect(at.scaleHeight, b.id).toBeLessThan(14000);
          expect(pressure / 1e5, `${b.id} pressure, bar`).toBeGreaterThan(0.5);
          expect(pressure / 1e5, `${b.id} pressure, bar`).toBeLessThan(2.5);
        }
        expect(at.opacity).toBeGreaterThan(0);
        expect(at.opacity).toBeLessThanOrEqual(1);
      }
    });
    expect(airs).toBeGreaterThan(50);
  });

  it('puts rings only around giants (and one dead star), inside the Roche limit and above the air', () => {
    let ringed = 0;
    eachSystem((s) => {
      for (const b of s.bodies) {
        if (!b.rings) continue;
        ringed++;
        expect(b.rings.outerRadius, b.id).toBeGreaterThan(b.rings.innerRadius);
        expect(b.rings.opacity).toBeGreaterThan(0);
        expect(b.rings.opacity).toBeLessThanOrEqual(1);
        if (b.kind === 'star') {
          // The one exception: the debris disc of the white dwarf, dust inside its Roche limit for rock.
          expect(must(b.star, 'star').spectralClass).toMatch(/^D/);
          expect(b.rings.outerRadius).toBeLessThan(roche(b, 3000));
          expect(b.rings.innerRadius).toBeGreaterThan(20 * b.radius);
          const firstPlanet = must(s.bodies[1].orbit, 'orbit');
          expect(b.rings.outerRadius).toBeLessThan(0.5 * peri(firstPlanet));
          continue;
        }
        expect(isGiant(b), `${b.id}: rings only on giants`).toBe(true);
        expect(b.rings.innerRadius, b.id).toBeGreaterThan(topOf(b));
        expect(b.rings.outerRadius, `${b.id}: ring ice inside the Roche limit`).toBeLessThanOrEqual(roche(b, 920));
        expect(b.rings.outerRadius, b.id).toBeLessThan(3 * b.radius);
        // Rings lie in the equatorial plane, so a ringed giant shows them off with some tilt.
        expect(b.axialTilt, `${b.id} tilt`).toBeGreaterThan(2 * DEG);
      }
    });
    expect(ringed).toBeGreaterThanOrEqual(5 * GALAXIES.length);
  });

  it('keeps inclinations and eccentricities mild, with a few strays', () => {
    for (const g of GALAXIES) {
      const planets = g.systems.flatMap((s) => s.bodies.filter((b) => b.kind === 'planet'));
      const inc = planets.map((p) => must(p.orbit, 'orbit').i / DEG);
      const ecc = planets.map((p) => must(p.orbit, 'orbit').e);
      expect(inc.filter((i) => i < 3).length / inc.length).toBeGreaterThan(0.8);
      expect(Math.max(...inc)).toBeLessThanOrEqual(25.5);
      expect(Math.min(...inc)).toBeGreaterThanOrEqual(0);
      expect(inc.filter((i) => i > 5).length).toBeGreaterThanOrEqual(2);
      expect(ecc.filter((e) => e < 0.05).length / ecc.length).toBeGreaterThan(0.8);
      expect(Math.max(...ecc)).toBeLessThan(0.2);
      // Moons orbit in their planet's equatorial plane (the plane of its rings).
      for (const s of g.systems) {
        const byId = new Map(s.bodies.map((b) => [b.id, b]));
        for (const m of s.bodies.filter((b) => b.kind === 'moon')) {
          const planet = must(byId.get(m.parentId as string), 'planet');
          const n = orbitNormalFromElements(must(m.orbit, 'orbit'));
          const axis = bodySpinAxis(planet);
          expect(n.x * axis.x + n.y * axis.y + n.z * axis.z, `${m.id} plane`).toBeGreaterThan(Math.cos(12 * DEG));
        }
        for (const b of s.bodies.slice(1)) {
          expect(b.axialTilt).toBeGreaterThanOrEqual(0);
          expect(b.axialTilt).toBeLessThan(35 * DEG);
        }
      }
    }
  });
});

// ---------------------------------------------------------------- looks and words

describe('looks and descriptions', () => {
  it('gives every body a drawable palette in linear RGB', () => {
    const palettes = new Set<string>();
    eachSystem((s) => {
      for (const b of s.bodies) {
        const v = b.visual;
        expect(v.palette.length, b.id).toBeGreaterThanOrEqual(3);
        expect(v.palette.length, b.id).toBeLessThanOrEqual(6);
        const colours = [...v.palette, ...(v.oceanColor ? [v.oceanColor] : []), ...(v.cloudColor ? [v.cloudColor] : [])];
        if (b.atmosphere) colours.push(b.atmosphere.color, b.atmosphere.sunsetColor);
        if (b.rings) colours.push(b.rings.color);
        for (const c of colours) {
          expect(c.length).toBe(3);
          for (const ch of c) {
            expect(Number.isFinite(ch), b.id).toBe(true);
            expect(ch, b.id).toBeGreaterThanOrEqual(0);
            expect(ch, b.id).toBeLessThanOrEqual(1);
          }
        }
        // Physically plausible albedos for solid surfaces.
        if (b.kind !== 'star') for (const c of v.palette) expect(Math.max(...c), `${b.id} albedo`).toBeLessThanOrEqual(0.9);
        for (const key of ['roughness', 'oceanLevel', 'ice', 'cloudCover', 'craters', 'lava', 'cityLights', 'storms'] as const) {
          const x = v[key];
          if (x !== undefined) {
            expect(x, `${b.id}.${key}`).toBeGreaterThanOrEqual(0);
            expect(x, `${b.id}.${key}`).toBeLessThanOrEqual(1);
          }
        }
        if (isGiant(b)) {
          expect(must(v.bands, 'bands')).toBeGreaterThanOrEqual(4);
          expect(must(v.bands, 'bands')).toBeLessThanOrEqual(24);
        }
        if (b.cls === 'lava') expect(must(v.lava, 'lava')).toBeGreaterThan(0.3);
        if (b.cls === 'eyeball') expect(must(v.ice, 'night-side ice')).toBeGreaterThan(0.3);
        if (b.kind !== 'star') palettes.add(JSON.stringify(v.palette));
      }
      // Settled worlds glow at night; empty systems do not.
      const lit = s.bodies.filter((b) => (b.visual.cityLights ?? 0) > 0);
      if (s.stations.length === 0) expect(lit.length).toBe(0);
      else expect(lit.length).toBeGreaterThanOrEqual(1);
    });
    // Variety: hardly any two worlds are dealt the same colours.
    const bodies = GALAXIES.reduce((n, g) => n + g.systems.reduce((k, s) => k + s.bodies.length - 1, 0), 0);
    expect(palettes.size).toBeGreaterThan(0.6 * bodies);
  });

  it('describes every system, body and station in a sentence or two', () => {
    for (const g of GALAXIES) {
      const seen = new Set<string>();
      const check = (text: string, what: string, maxSentences: number): void => {
        expect(text.length, `${what}: "${text}"`).toBeGreaterThanOrEqual(50);
        expect(text.length, `${what}: "${text}"`).toBeLessThanOrEqual(420);
        expect(text, what).toMatch(/[.!?]$/);
        expect(text, what).not.toMatch(/undefined|NaN|\{|\}| {2}|\n/);
        expect((text.match(/[.!?](?=\s|$)/g) ?? []).length, `${what}: "${text}"`).toBeLessThanOrEqual(maxSentences);
        expect(seen.has(text), `${what}: repeated description`).toBe(false);
        seen.add(text);
      };
      for (const s of g.systems) {
        check(s.description, s.id, 3);
        expect(s.description).toContain(s.name);
        for (const b of s.bodies) {
          check(b.description, b.id, 4);
          expect(b.description, b.id).toContain(b.name);
        }
        for (const st of s.stations) {
          check(st.description, st.id, 4);
          expect(st.description, st.id).toContain(st.name.replace(/^The /, ''));
        }
        expect(Number.isInteger(s.skySeed)).toBe(true);
      }
      for (const f of g.factions) check(f.description, f.id, 4);
    }
  });

  it('dumps a system as plain text', () => {
    const g = GALAXIES[1];
    for (const s of [must(getSystem(g, g.startSystemId), 'start'), g.systems[4], g.systems[21]]) {
      const text = describeSystem(s, g);
      expect(text).toContain(s.name.toUpperCase());
      expect(text).toContain('Jump beacon');
      for (const b of s.bodies) expect(text).toContain(b.name);
      for (const st of s.stations) expect(text).toContain(st.name);
      for (const m of s.miningSites) expect(text).toContain(m.name);
      for (const p of presenceIn(g, s.id)) expect(text).toContain(factionOf(g, p.factionId).name);
      expect(text).not.toMatch(/undefined|NaN|\[object/);
      // Without the galaxy it still describes the system, just not its politics.
      const bare = describeSystem(s);
      expect(bare).toContain(s.name.toUpperCase());
      expect(bare).not.toContain('FACTIONS');
      expect(bare).not.toMatch(/undefined|NaN|\[object/);
    }
  });
});

// ---------------------------------------------------------------- stations, sites, beacons

describe('stations', () => {
  it('number two to six in every inhabited system, with three or four systems left empty', () => {
    for (const g of GALAXIES) {
      const empty = g.systems.filter((s) => s.stations.length === 0);
      expect(empty.length).toBeGreaterThanOrEqual(3);
      expect(empty.length).toBeLessThanOrEqual(4);
      for (const s of empty) {
        expect(s.population).toBe(0);
        expect(s.capitalStationId).toBeNull();
        expect(presenceIn(g, s.id)).toEqual([]);
        expect(g.initialControl[s.id]).toBeUndefined();
        expect(s.baseSecurity).toBeLessThan(0.3);
      }
      for (const s of inhabited(g)) {
        expect(s.stations.length, s.id).toBeGreaterThanOrEqual(2);
        expect(s.stations.length, s.id).toBeLessThanOrEqual(6);
        expect(s.population).toBe(s.stations.reduce((n, st) => n + st.population, 0));
        const capital = must(s.stations.find((st) => st.id === s.capitalStationId), `${s.id} capital`);
        // The capital is the biggest port, or the second biggest where the seat of power is not the largest town.
        expect(s.stations.filter((st) => st.population > capital.population).length, `${s.id} capital`).toBeLessThanOrEqual(1);
        expect(s.baseSecurity).toBeGreaterThanOrEqual(0);
        expect(s.baseSecurity).toBeLessThanOrEqual(1);
      }
    }
  });

  it('fly near-circular orbits clear of atmospheres, rings and moons', () => {
    let atMoons = 0;
    let high = 0;
    let low = 0;
    let solidHosted = 0;
    eachSystem((s) => {
      const byId = new Map(s.bodies.map((b) => [b.id, b]));
      for (const st of s.stations) {
        const parent = must(byId.get(st.parentBodyId), 'parent');
        expect(parent.kind, `${st.id}: stations orbit worlds`).not.toBe('star');
        expect(st.orbit.e, st.id).toBeLessThanOrEqual(0.02);
        expect(st.orbit.epoch).toBe(0);
        const altitude = peri(st.orbit) - topOf(parent);
        expect(altitude, `${st.id} altitude`).toBeGreaterThanOrEqual(parent.radius >= 2e6 ? 250e3 : 60e3);
        expect(apo(st.orbit), st.id).toBeLessThan(0.5 * parent.soi);
        // Long-term stable: inside 0.4 Hill radii of the parent.
        const grand = must(byId.get(parent.parentId as string), 'grandparent');
        expect(apo(st.orbit), `${st.id} Hill`).toBeLessThan(0.4 * hill(must(parent.orbit, 'orbit'), parent.mass, grand.mass));
        if (parent.rings) expect(peri(st.orbit), `${st.id} clear of rings`).toBeGreaterThan(parent.rings.outerRadius);
        for (const m of s.bodies) {
          if (m.parentId !== parent.id || !m.orbit) continue;
          const clear = peri(st.orbit) > apo(m.orbit) + m.soi || apo(st.orbit) < peri(m.orbit) - m.soi;
          expect(clear, `${st.id} clear of ${m.id}`).toBe(true);
        }
        // By default a station keeps to its parent's equatorial plane.
        const n = orbitNormalFromElements(st.orbit);
        const axis = bodySpinAxis(parent);
        expect(n.x * axis.x + n.y * axis.y + n.z * axis.z, `${st.id} plane`).toBeGreaterThan(Math.cos(30 * DEG));
        if (parent.kind === 'moon') atMoons++;
        if (!isGiant(parent)) {
          solidHosted++;
          if (altitude > 2000e3) high++;
          if (altitude >= 250e3 && altitude <= 2000e3 && parent.radius >= 2e6) low++;
        }
      }
    });
    expect(atMoons).toBeGreaterThanOrEqual(5 * GALAXIES.length);
    expect(high).toBeGreaterThanOrEqual(3 * GALAXIES.length);
    expect(high).toBeLessThan(0.4 * solidHosted);
    expect(low).toBeGreaterThan(0.4 * solidHosted);
  });

  it('offer services by size and a type that fits their trade', () => {
    eachSystem((s) => {
      for (const st of s.stations) {
        expect(new Set(st.services).size, st.id).toBe(st.services.length);
        expect(st.services, st.id).toContain('market');
        expect(st.services, st.id).toContain('refuel');
        expect(st.economies.length, st.id).toBeGreaterThanOrEqual(1);
        expect(new Set(st.economies).size, st.id).toBe(st.economies.length);
        expect(st.population, st.id).toBeGreaterThan(0);
        expect(Number.isInteger(st.visualSeed)).toBe(true);
        expect(['S', 'M', 'L']).toContain(st.maxPad);
        switch (st.visualId) {
          case 'ringHabitat':
            for (const need of ['missions', 'outfitting', 'shipyard', 'repair'] as const) expect(st.services, st.id).toContain(need);
            expect(st.maxPad).toBe('L');
            expect(st.population).toBeGreaterThan(50_000);
            break;
          case 'drydock':
            expect(st.services, st.id).toContain('shipyard');
            expect(st.economies[0]).toBe('shipyard');
            expect(st.maxPad).toBe('L');
            break;
          case 'refinery':
            expect(st.economies[0]).toBe('refinery');
            expect(st.services, st.id).toContain('repair');
            expect(st.services, st.id).not.toContain('shipyard');
            break;
          case 'citadel':
            expect(st.economies).toContain('military');
            break;
          case 'spindle':
            expect(st.services, st.id).toContain('missions');
            expect(st.services, st.id).toContain('outfitting');
            break;
          case 'outpost':
            expect(st.services, st.id).not.toContain('shipyard');
            expect(st.services, st.id).not.toContain('outfitting');
            expect(st.population).toBeLessThan(50_000);
            expect(st.services.length).toBeLessThanOrEqual(5);
            break;
        }
      }
      if (s.stations.length > 0) {
        const capital = must(s.stations.find((st) => st.id === s.capitalStationId), 'capital');
        expect(capital.visualId, `${s.id} capital`).not.toBe('outpost');
        expect(capital.services).toContain('missions');
        expect(capital.services.length).toBeGreaterThanOrEqual(Math.max(...s.stations.map((st) => st.services.length)) - 1);
      }
      // Lawless ports deal under the counter; well-patrolled ones keep a magistrate.
      for (const st of s.stations) {
        if (s.baseSecurity > 0.7) expect(st.services, st.id).not.toContain('blackmarket');
        if (s.baseSecurity < 0.2) expect(st.services, st.id).toContain('blackmarket');
      }
    });
  });

  it('put two stations a short transfer apart in most systems', () => {
    for (const g of GALAXIES) {
      const systems = inhabited(g);
      const hops = systems.map((s) => cheapestHop(s));
      const short = hops.filter((dv) => dv <= 4000).length;
      const inBand = hops.filter((dv) => dv >= 350 && dv <= 4000).length;
      expect(short / systems.length).toBeGreaterThanOrEqual(0.9);
      expect(inBand / systems.length).toBeGreaterThanOrEqual(0.85);
      // The generator's own estimate agrees with the simple Hohmann figure for coplanar pairs sharing a parent.
      for (const s of systems) {
        for (let i = 0; i < s.stations.length; i++) {
          for (let j = i + 1; j < s.stations.length; j++) {
            const a = s.stations[i];
            const b = s.stations[j];
            const est = must(estimateTransferDv(s, a.id, b.id), 'estimate');
            expect(est).toBeGreaterThan(0);
            expect(est).toBeCloseTo(must(estimateTransferDv(s, b.id, a.id), 'estimate'), 3);
            if (a.parentBodyId === b.parentBodyId && a.orbit.i === b.orbit.i && a.orbit.lan === b.orbit.lan) {
              expect(est).toBeCloseTo(hohmann(bodyOf(s, a.parentBodyId).mu, a.orbit.a, b.orbit.a), 3);
            } else if (Number.isFinite(hopDv(s, a, b))) {
              expect(Math.abs(est - hopDv(s, a, b)) / est).toBeLessThan(0.02);
            }
          }
        }
        expect(estimateTransferDv(s, s.stations[0].id, s.stations[0].id)).toBe(0);
        expect(estimateTransferDv(s, s.stations[0].id, 'nowhere')).toBeUndefined();
      }
    }
  });
});

describe('mining sites and jump beacons', () => {
  it('scatter one to four sites per system with ore mixes of mineable commodities', () => {
    const mineable = new Set(MINEABLE_COMMODITY_IDS);
    const kinds = { ring: 0, belt: 0 };
    const oresSeen = new Set<string>();
    eachSystem((s) => {
      expect(s.miningSites.length, s.id).toBeGreaterThanOrEqual(1);
      expect(s.miningSites.length, s.id).toBeLessThanOrEqual(4);
      const byId = new Map(s.bodies.map((b) => [b.id, b]));
      for (const m of s.miningSites) {
        kinds[m.kind]++;
        const parent = must(byId.get(m.parentBodyId), 'parent');
        expect(m.richness, m.id).toBeGreaterThan(0);
        expect(m.richness, m.id).toBeLessThanOrEqual(1);
        expect(m.ores.length, m.id).toBeGreaterThanOrEqual(2);
        expect(new Set(m.ores.map((o) => o.commodityId)).size).toBe(m.ores.length);
        for (const o of m.ores) {
          expect(mineable.has(o.commodityId), `${m.id}: ${o.commodityId}`).toBe(true);
          expect(o.weight).toBeGreaterThan(0);
          oresSeen.add(o.commodityId);
        }
        expect(Number.isInteger(m.visualSeed)).toBe(true);
        expect(peri(m.orbit), `${m.id} clear of the air`).toBeGreaterThan(topOf(parent) + 20e3);
        if (m.kind === 'ring') {
          // Inside a giant's rings, on a circular orbit in the ring plane; ring ice dominates.
          const rings = must(parent.rings, `${m.id}: rings of ${parent.id}`);
          expect(isGiant(parent)).toBe(true);
          expect(m.orbit.a).toBeGreaterThan(rings.innerRadius);
          expect(m.orbit.a).toBeLessThan(rings.outerRadius);
          expect(m.orbit.e).toBe(0);
          expect(m.orbit.i).toBeCloseTo(parent.axialTilt, 9);
          expect(m.orbit.lan).toBe(0);
          expect(m.ores.some((o) => o.commodityId === 'water_ice')).toBe(true);
        } else {
          expect(m.orbit.e).toBeLessThan(0.15);
          if (parent.rings && parent.kind !== 'star') expect(peri(m.orbit), `${m.id}: belt outside the rings`).toBeGreaterThan(parent.rings.outerRadius);
          if (parent.kind === 'star') expect(peri(m.orbit)).toBeGreaterThan(3 * parent.radius);
          else expect(apo(m.orbit)).toBeLessThan(0.5 * parent.soi);
        }
      }
    });
    expect(kinds.ring).toBeGreaterThanOrEqual(4 * GALAXIES.length);
    expect(kinds.belt).toBeGreaterThanOrEqual(15 * GALAXIES.length);
    // Every mineable commodity can actually be mined somewhere.
    expect([...oresSeen].sort()).toEqual([...mineable].sort());
  });

  it('park the jump beacon beyond 8 radii and inside half the SOI of a planet', () => {
    let atCapitalWorld = 0;
    let settled = 0;
    eachSystem((s) => {
      const body = bodyOf(s, s.jumpBeacon.bodyId);
      const r = s.jumpBeacon.orbitRadius;
      expect(body.kind, s.id).toBe('planet');
      expect(r, s.id).toBeGreaterThan(8 * body.radius);
      expect(r, s.id).toBeLessThan(0.5 * body.soi);
      if (body.rings) expect(r).toBeGreaterThan(body.rings.outerRadius);
      // Flat space for the drive: more than 8 radii from every moon too, and outside their SOIs.
      for (const m of s.bodies) {
        if (m.parentId !== body.id || !m.orbit) continue;
        const gap = Math.min(Math.abs(r - peri(m.orbit)), Math.abs(r - apo(m.orbit)));
        expect(gap, `${s.id} beacon vs ${m.id}`).toBeGreaterThan(Math.max(m.soi, 8 * m.radius));
      }
      for (const o of orbiters(s)) {
        if (o.parentBodyId !== body.id) continue;
        expect(r < peri(o.orbit) || r > apo(o.orbit), `${s.id} beacon vs ${o.id}`).toBe(true);
      }
      if (s.capitalStationId) {
        settled++;
        const host = bodyOf(s, must(getStation(s, s.capitalStationId), 'capital').parentBodyId);
        const world = host.kind === 'moon' ? host.parentId : host.id;
        if (world === body.id) atCapitalWorld++;
      } else {
        // Nobody home: the beacon orbits a planet big enough to hold it.
        expect(body.soi / body.radius).toBeGreaterThan(17);
      }
    });
    expect(atCapitalWorld / settled).toBeGreaterThan(0.75);
  });
});

// ---------------------------------------------------------------- the map

describe('the cluster map', () => {
  it('is 35-45 light-years across and connected at 7 ly', () => {
    for (const g of GALAXIES) {
      let extent = 0;
      let nearest = Infinity;
      for (const a of g.systems) {
        for (const b of g.systems) {
          if (a === b) continue;
          const d = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z);
          extent = Math.max(extent, d);
          nearest = Math.min(nearest, d);
          expect(systemDistance(a, b)).toBeCloseTo(d, 9);
          expect(systemDistance(a, b)).toBe(systemDistance(b, a));
        }
        expect(systemDistance(a, a)).toBe(0);
      }
      expect(extent).toBeGreaterThanOrEqual(35);
      expect(extent).toBeLessThanOrEqual(46);
      expect(nearest).toBeGreaterThan(2.5);
      // A flattened disc: far thinner than it is wide.
      const ys = g.systems.map((s) => s.pos.y);
      expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(6);
      expect(MAX_GUARANTEED_JUMP_LY).toBe(7);
      expect(reachable(g, g.startSystemId, 7).size).toBe(g.systems.length);
      // ...and it takes most of that range: short-legged ships cannot leave the core.
      expect(reachable(g, g.startSystemId, 5).size).toBeLessThan(g.systems.length);
    }
  });

  it('has a dense core, arms that hang by chokepoints, and dead-end frontier systems', () => {
    for (const g of GALAXIES) {
      const degree = new Map(g.systems.map((s) => [s.id, systemsWithin(g, s.id, 7).length]));
      expect(must(degree.get(g.startSystemId), 'start')).toBeGreaterThanOrEqual(4);
      expect(Math.max(...degree.values())).toBeGreaterThanOrEqual(4);
      expect(Math.min(...degree.values())).toBe(1);
      const mean = [...degree.values()].reduce((n, d) => n + d, 0) / g.systems.length;
      expect(mean).toBeGreaterThan(1.8);
      expect(mean).toBeLessThan(4.5);
      // Chokepoints: systems whose loss would cut the cluster in two.
      const other = (id: string): string => must(g.systems.find((s) => s.id !== id), 'other').id;
      const chokepoints = g.systems.filter((s) => reachable(g, other(s.id), 7, s.id).size < g.systems.length - 1);
      expect(chokepoints.length).toBeGreaterThanOrEqual(3);
      // Each capital sits at least two jumps from the start; two of the three behind a single gate.
      let gated = 0;
      const hops = hopCounts(g, g.startSystemId, 7);
      for (const p of g.powers) {
        expect(must(hops.get(p.capitalSystemId), p.id)).toBeGreaterThanOrEqual(2);
        if (chokepoints.some((c) => c.id !== p.capitalSystemId && !reachable(g, g.startSystemId, 7, c.id).has(p.capitalSystemId))) gated++;
      }
      expect(gated).toBeGreaterThanOrEqual(2);
      // The uninhabited frontier systems are dead ends at the tips of the arms.
      for (const s of g.systems.filter((x) => x.stations.length === 0)) {
        expect(must(degree.get(s.id), s.id)).toBeLessThanOrEqual(2);
        expect(must(hops.get(s.id), s.id)).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('finds neighbours and shortest routes', () => {
    for (const g of GALAXIES.slice(0, 3)) {
      const start = g.startSystemId;
      const byId = new Map(g.systems.map((s) => [s.id, s]));
      const hops = hopCounts(g, start, 7);
      for (const s of g.systems) {
        const near = systemsWithin(g, s.id, 7);
        expect(near.every((n) => n.system.id !== s.id)).toBe(true);
        for (let k = 0; k < near.length; k++) {
          expect(near[k].distance).toBeLessThanOrEqual(7);
          expect(near[k].distance).toBeCloseTo(systemDistance(s, near[k].system), 9);
          if (k > 0) expect(near[k].distance).toBeGreaterThanOrEqual(near[k - 1].distance);
        }
        expect(near.length).toBe(g.systems.filter((o) => o !== s && systemDistance(o, s) <= 7).length);

        const route = must(shortestRoute(g, start, s.id, 7), `route to ${s.id}`);
        expect(route[0]).toBe(start);
        expect(route[route.length - 1]).toBe(s.id);
        expect(new Set(route).size).toBe(route.length);
        expect(route.length - 1, `fewest jumps to ${s.id}`).toBe(must(hops.get(s.id), s.id));
        for (let k = 0; k + 1 < route.length; k++) {
          expect(systemDistance(must(byId.get(route[k]), route[k]), must(byId.get(route[k + 1]), route[k + 1]))).toBeLessThanOrEqual(7);
        }
        // Routes are reversible in length.
        expect(must(shortestRoute(g, s.id, start, 7), 'way back').length).toBe(route.length);
      }
      expect(systemsWithin(g, 'nowhere', 7)).toEqual([]);
      expect(systemsWithin(g, start, 0.5)).toEqual([]);
      expect(shortestRoute(g, start, start, 7)).toEqual([start]);
      expect(shortestRoute(g, start, 'nowhere', 7)).toBeNull();
      expect(shortestRoute(g, 'nowhere', start, 7)).toBeNull();
      expect(shortestRoute(g, start, g.powers[0].capitalSystemId, 2)).toBeNull();
      // A longer-legged ship never needs more jumps.
      const far = g.systems[g.systems.length - 3].id;
      expect(must(shortestRoute(g, start, far, 12), 'long legs').length).toBeLessThanOrEqual(must(shortestRoute(g, start, far, 7), 'short legs').length);
    }
  });
});

// ---------------------------------------------------------------- commodities and powers

describe('commodities and powers', () => {
  it('offers about thirty commodities across every category at believable prices', () => {
    const g = GALAXIES[0];
    expect(g.commodities).toEqual([...COMMODITIES]);
    expect(g.commodities.length).toBeGreaterThanOrEqual(28);
    expect(g.commodities.length).toBeLessThanOrEqual(40);
    expect(new Set(g.commodities.map((c) => c.id)).size).toBe(g.commodities.length);
    expect(new Set(g.commodities.map((c) => c.name)).size).toBe(g.commodities.length);
    const categories = ['food', 'minerals', 'metals', 'chemicals', 'machinery', 'technology', 'medicine', 'consumer', 'energy', 'weapons', 'salvage', 'contraband'];
    for (const cat of categories) expect(g.commodities.filter((c) => c.category === cat).length, cat).toBeGreaterThanOrEqual(2);
    for (const c of g.commodities) {
      expect(categories).toContain(c.category);
      expect(c.id).toMatch(/^[a-z_]+$/);
      expect(c.basePrice).toBeGreaterThanOrEqual(40);
      expect(c.basePrice).toBeLessThanOrEqual(15000);
      expect(c.description.length).toBeGreaterThan(40);
      expect(new Set(c.illegalUnder).size).toBe(c.illegalUnder.length);
      if (c.category === 'contraband') {
        expect(c.illegalUnder.length).toBeGreaterThanOrEqual(6);
        expect(c.illegalUnder).not.toContain('anarchy');
      }
      if (c.mineable) expect(c.category).toBe('minerals');
    }
    const prices = g.commodities.map((c) => c.basePrice);
    expect(Math.min(...prices)).toBe(must(g.commodities.find((c) => c.id === 'water_ice'), 'water ice').basePrice);
    expect(Math.min(...prices)).toBeLessThanOrEqual(50);
    expect(Math.max(...prices)).toBeGreaterThanOrEqual(12000);
    const mineable = g.commodities.filter((c) => c.mineable);
    expect(mineable.length).toBeGreaterThanOrEqual(6);
    expect(mineable.length).toBeLessThanOrEqual(8);
    expect(mineable.map((c) => c.id)).toEqual([...MINEABLE_COMMODITY_IDS]);
    // Some legal goods are banned somewhere (smuggling needs borders), most are legal everywhere.
    const restricted = g.commodities.filter((c) => c.category !== 'contraband' && c.illegalUnder.length > 0);
    expect(restricted.length).toBeGreaterThanOrEqual(3);
    expect(g.commodities.filter((c) => c.illegalUnder.length === 0).length).toBeGreaterThan(g.commodities.length / 2);
  });

  it('seats the three powers in three different capitals', () => {
    for (const g of GALAXIES) {
      expect(g.powers.map((p) => p.id).sort()).toEqual(['assembly', 'hegemony', 'league']);
      expect(g.powers.map((p) => p.name).sort()).toEqual(['Auric Hegemony', 'Meridian Assembly', 'Umbral League']);
      expect(new Set(g.powers.map((p) => p.capitalSystemId)).size).toBe(3);
      for (const p of g.powers) {
        const capital = must(getSystem(g, p.capitalSystemId), `${p.id} capital`);
        expect(p.capitalSystemId).not.toBe(g.startSystemId);
        expect(p.shortName.length).toBeLessThanOrEqual(10);
        expect(p.description.length).toBeGreaterThan(80);
        expect(p.ethos.length).toBeGreaterThan(10);
        for (const ch of p.color) {
          expect(ch).toBeGreaterThanOrEqual(0);
          expect(ch).toBeLessThanOrEqual(1);
        }
        // Solid at home: its factions rule the capital and hold most of the influence there.
        const ruler = factionOf(g, g.initialControl[capital.id]);
        expect(ruler.powerId).toBe(p.id);
        const share = presenceIn(g, capital.id).reduce((n, x) => n + (factionOf(g, x.factionId).powerId === p.id ? x.influence : 0), 0);
        expect(share, `${p.id} at home`).toBeGreaterThan(0.6);
        expect(presenceIn(g, capital.id).some((x) => factionOf(g, x.factionId).criminal)).toBe(false);
        expect(capital.population).toBeGreaterThan(1e6);
        // ...and around it: the power rules most of its inhabited neighbours.
        const neighbours = systemsWithin(g, capital.id, 7).filter((n) => n.system.stations.length > 0);
        const held = neighbours.filter((n) => factionOf(g, g.initialControl[n.system.id]).powerId === p.id);
        expect(neighbours.length).toBeGreaterThanOrEqual(2);
        expect(held.length / neighbours.length, `${p.id} neighbourhood`).toBeGreaterThanOrEqual(0.6);
      }
      // Law is tightest in the Assembly and Hegemony capitals, loosest among the League.
      const security = (id: PowerId): number => must(getSystem(g, must(g.powers.find((p) => p.id === id), id).capitalSystemId), id).baseSecurity;
      expect(security('assembly')).toBeGreaterThan(0.85);
      expect(security('hegemony')).toBeGreaterThan(0.85);
      expect(security('league')).toBeLessThan(security('assembly'));
    }
  });
});

// ---------------------------------------------------------------- factions

describe('factions', () => {
  it('are three to six per inhabited system with influence summing to one', () => {
    for (const g of GALAXIES) {
      const known = new Set(g.factions.map((f) => f.id));
      const systems = new Set(g.systems.map((s) => s.id));
      for (const p of g.initialPresence) {
        expect(known.has(p.factionId), p.factionId).toBe(true);
        expect(systems.has(p.systemId), p.systemId).toBe(true);
        expect(p.influence).toBeGreaterThan(0.02);
        expect(p.influence).toBeLessThan(0.75);
      }
      for (const s of inhabited(g)) {
        const list = presenceIn(g, s.id);
        expect(list.length, s.id).toBeGreaterThanOrEqual(3);
        expect(list.length, s.id).toBeLessThanOrEqual(6);
        expect(new Set(list.map((p) => p.factionId)).size).toBe(list.length);
        expect(list.reduce((n, p) => n + p.influence, 0), `${s.id} influence`).toBeCloseTo(1, 9);
        // The helper lists the same factions, strongest first.
        const ranked = factionsIn(g, s.id);
        expect(ranked.map((r) => r.faction.id).sort()).toEqual(list.map((p) => p.factionId).sort());
        for (let k = 1; k < ranked.length; k++) expect(ranked[k].influence).toBeLessThanOrEqual(ranked[k - 1].influence);
        // The controlling faction is present, lawful and the strongest lawful faction.
        const ruler = factionOf(g, must(g.initialControl[s.id], `${s.id} control`));
        expect(ruler.criminal).toBe(false);
        const lawful = ranked.filter((r) => !r.faction.criminal);
        expect(lawful[0].faction.id).toBe(ruler.id);
      }
      expect(Object.keys(g.initialControl).sort()).toEqual(inhabited(g).map((s) => s.id).sort());
    }
  });

  it('have homes, colours, varied names and governments that suit their power', () => {
    const tally = new Map<string, Map<string, number>>();
    let aligned = 0;
    let inStep = 0;
    for (const g of GALAXIES) {
      expect(new Set(g.factions.map((f) => f.name)).size).toBe(g.factions.length);
      for (const f of g.factions) {
        const home = must(getSystem(g, f.homeSystemId), `${f.id} home`);
        expect(home.stations.length).toBeGreaterThan(0);
        expect(presenceIn(g, home.id).some((p) => p.factionId === f.id), `${f.id} is present at home`).toBe(true);
        expect(f.name.length).toBeGreaterThan(5);
        expect(f.color.length).toBe(3);
        for (const ch of f.color) {
          expect(ch).toBeGreaterThanOrEqual(0);
          expect(ch).toBeLessThanOrEqual(1);
        }
        if (f.criminal) {
          expect(f.government).toBe('anarchy');
          expect(f.powerId).toBeNull();
          // Outlaw red: the red channel dominates.
          expect(f.color[0]).toBeGreaterThan(2 * f.color[2]);
        }
        if (f.powerId) {
          aligned++;
          if (POWER_GOVERNMENTS[f.powerId].some((x) => x.government === f.government)) inStep++;
          const t = tally.get(f.powerId) ?? new Map<string, number>();
          t.set(f.government, (t.get(f.government) ?? 0) + 1);
          tally.set(f.powerId, t);
        }
      }
      // Every power and plenty of independents are represented; no name pattern dominates.
      for (const p of g.powers) expect(g.factions.filter((f) => f.powerId === p.id).length, p.id).toBeGreaterThanOrEqual(8);
      expect(g.factions.filter((f) => f.powerId === null && !f.criminal).length).toBeGreaterThanOrEqual(8);
      const firstWords = new Map<string, number>();
      for (const f of g.factions) {
        const w = f.name.split(' ')[0];
        firstWords.set(w, (firstWords.get(w) ?? 0) + 1);
      }
      expect(Math.max(...firstWords.values())).toBeLessThanOrEqual(0.25 * g.factions.length);
      expect(new Set(g.factions.map((f) => f.government)).size).toBeGreaterThanOrEqual(8);
    }
    expect(inStep / aligned).toBeGreaterThan(0.9);
    const favourite = (id: PowerId): string => [...must(tally.get(id), id).entries()].sort((x, y) => y[1] - x[1])[0][0];
    expect(favourite('assembly')).toBe('democracy');
    expect(favourite('hegemony')).toBe('patronage');
    expect(favourite('league')).toBe('cooperative');
  });

  it('spread across neighbouring systems and mix along the borders', () => {
    for (const g of GALAXIES) {
      const where = new Map<string, string[]>();
      for (const p of g.initialPresence) where.set(p.factionId, [...(where.get(p.factionId) ?? []), p.systemId]);
      const spanning = [...where.entries()].filter(([, list]) => list.length > 1);
      expect(spanning.length).toBeGreaterThanOrEqual(8);
      for (const [id, list] of spanning) {
        const home = must(getSystem(g, factionOf(g, id).homeSystemId), 'home');
        // A faction only reaches systems one jump from home.
        for (const sid of list) expect(systemDistance(home, must(getSystem(g, sid), sid)), `${id} in ${sid}`).toBeLessThanOrEqual(7.5);
        expect(list.length).toBeLessThanOrEqual(5);
      }
      // Mixed borders: several systems where two or more powers have a foothold.
      const mixed = inhabited(g).filter((s) => new Set(presenceIn(g, s.id).map((p) => factionOf(g, p.factionId).powerId).filter((x) => x !== null)).size >= 2);
      expect(mixed.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('include two or three Scorch clans, at home only where the law is thin', () => {
    for (const g of GALAXIES) {
      const clans = g.factions.filter((f) => f.criminal);
      expect(clans.length).toBeGreaterThanOrEqual(2);
      expect(clans.length).toBeLessThanOrEqual(3);
      for (const clan of clans) {
        expect(must(getSystem(g, clan.homeSystemId), 'home').baseSecurity).toBeLessThan(0.4);
        for (const p of g.initialPresence.filter((x) => x.factionId === clan.id)) {
          expect(must(getSystem(g, p.systemId), p.systemId).baseSecurity, `${clan.id} in ${p.systemId}`).toBeLessThan(0.4);
        }
      }
      // The most lawless inhabited system is an outlaw haven: a clan is strong there.
      const haven = inhabited(g).sort((x, y) => x.baseSecurity - y.baseSecurity)[0];
      const share = presenceIn(g, haven.id).reduce((n, p) => n + (factionOf(g, p.factionId).criminal ? p.influence : 0), 0);
      expect(share).toBeGreaterThan(0.15);
      expect(must(getSystem(g, haven.id), 'haven').stations.every((st) => st.services.includes('blackmarket'))).toBe(true);
    }
  });

  it('gives every station a lawful owner that is present in its system', () => {
    for (const g of GALAXIES) {
      const stationIds = g.systems.flatMap((s) => s.stations.map((st) => st.id));
      expect(Object.keys(g.stationOwners).sort()).toEqual([...stationIds].sort());
      for (const s of inhabited(g)) {
        const present = new Set(presenceIn(g, s.id).map((p) => p.factionId));
        for (const st of s.stations) {
          const owner = factionOf(g, g.stationOwners[st.id]);
          expect(present.has(owner.id), `${st.id}: owner ${owner.id} is not in ${s.id}`).toBe(true);
          expect(owner.criminal, st.id).toBe(false);
        }
        expect(g.stationOwners[must(s.capitalStationId, 'capital')]).toBe(g.initialControl[s.id]);
      }
    }
  });
});

// ---------------------------------------------------------------- the start system

describe('the start system', () => {
  it('is the same classroom under every seed', () => {
    for (const g of GALAXIES) {
      const s = must(getSystem(g, g.startSystemId), 'start system');
      const star = s.bodies[0];
      const byId = new Map(s.bodies.map((b) => [b.id, b]));
      const planets = s.bodies.filter((b) => b.kind === 'planet');
      const moonsOf = (p: BodyDef): BodyDef[] => s.bodies.filter((b) => b.parentId === p.id);
      const at = (bodyId: string): StationDef[] => s.stations.filter((st) => st.parentBodyId === bodyId);

      // A red dwarf, medium security.
      expect(must(star.star, 'star').spectralClass).toMatch(/^M\dV$/);
      expect(must(star.star, 'star').temperature).toBeLessThan(3900);
      expect(s.baseSecurity).toBeGreaterThanOrEqual(0.4);
      expect(s.baseSecurity).toBeLessThanOrEqual(0.7);
      expect(s.stations.length).toBeGreaterThanOrEqual(4);

      // A temperate eyeball world with the capital ring habitat in low orbit and an outpost higher up.
      const eyeball = must(planets.find((p) => p.cls === 'eyeball'), 'eyeball world');
      expect(eyeball.tidallyLocked).toBe(true);
      expect(eyeball.temperature).toBeGreaterThan(260);
      expect(eyeball.temperature).toBeLessThan(300);
      expect(must(eyeball.visual.cityLights, 'city lights')).toBeGreaterThan(0.3);
      const capital = must(getStation(g, g.startStationId), 'start station');
      expect(capital.systemId).toBe(s.id);
      expect(s.capitalStationId).toBe(capital.id);
      expect(capital.parentBodyId).toBe(eyeball.id);
      expect(capital.visualId).toBe('ringHabitat');
      const capitalAltitude = capital.orbit.a - topOf(eyeball);
      expect(capitalAltitude).toBeGreaterThanOrEqual(300e3);
      expect(capitalAltitude).toBeLessThanOrEqual(1000e3);
      for (const need of ['market', 'missions', 'outfitting', 'shipyard', 'refuel', 'repair'] as const) expect(capital.services).toContain(need);
      const upper = must(at(eyeball.id).find((st) => st.visualId === 'outpost' && st.orbit.a > capital.orbit.a), 'outpost above the capital');
      const firstHop = hohmann(eyeball.mu, capital.orbit.a, upper.orbit.a);
      expect(firstHop).toBeGreaterThanOrEqual(500);
      expect(firstHop).toBeLessThanOrEqual(4000);
      expect(estimateTransferDv(s, capital.id, upper.id)).toBeCloseTo(firstHop, 3);
      expect(upper.orbit.i).toBe(capital.orbit.i);

      // Ships arrive around the eyeball world.
      expect(s.jumpBeacon.bodyId).toBe(eyeball.id);

      // A ringed gas giant with 2-3 moons: refinery, ring mining site, moon outpost.
      const giant = must(planets.find((p) => p.cls === 'gasGiant' && p.rings), 'ringed gas giant');
      const moons = moonsOf(giant);
      expect(moons.length).toBeGreaterThanOrEqual(2);
      expect(moons.length).toBeLessThanOrEqual(3);
      expect(must(giant.atmosphere, 'giant air').scoopable).toBe(true);
      const refinery = must(at(giant.id).find((st) => st.visualId === 'refinery'), 'refinery at the giant');
      const ringSite = must(s.miningSites.find((m) => m.kind === 'ring' && m.parentBodyId === giant.id), 'ring site');
      const moonOutpost = must(s.stations.find((st) => st.visualId === 'outpost' && moons.some((m) => m.id === st.parentBodyId)), 'moon outpost');
      expect(hohmann(giant.mu, refinery.orbit.a, ringSite.orbit.a), 'ring site to refinery').toBeLessThan(4000);
      expect(refinery.orbit.i).toBeCloseTo(ringSite.orbit.i, 9);
      expect(hopDv(s, moonOutpost, refinery)).toBeLessThan(12000);
      expect(must(byId.get(moonOutpost.parentBodyId), 'moon').cls).toBe('ice');

      // A scorched lava world innermost, and an ice world.
      expect(planets[0].cls).toBe('lava');
      expect(planets[0].temperature).toBeGreaterThan(700);
      expect(must(planets[0].visual.lava, 'lava')).toBeGreaterThan(0.5);
      expect(planets.some((p) => p.cls === 'ice')).toBe(true);
      expect(planets.indexOf(eyeball)).toBeGreaterThan(0);
      expect(planets.indexOf(giant)).toBeGreaterThan(planets.indexOf(eyeball));

      // Mixed factions: every power and an independent, nobody dominant.
      const present = presenceIn(g, s.id).map((p) => ({ f: factionOf(g, p.factionId), influence: p.influence }));
      for (const p of g.powers) expect(present.some((x) => x.f.powerId === p.id), `${p.id} in the start system`).toBe(true);
      expect(present.some((x) => x.f.powerId === null && !x.f.criminal)).toBe(true);
      expect(present.some((x) => x.f.criminal)).toBe(false);
      expect(Math.max(...present.map((x) => x.influence))).toBeLessThan(0.4);
      expect(factionOf(g, g.initialControl[s.id]).powerId).toBeNull();

      // Neighbours to visit on the first tank.
      expect(systemsWithin(g, s.id, 7).length).toBeGreaterThanOrEqual(4);
    }
  });

  it('keeps the first transfer cheap and the first lessons close together', () => {
    const g = GALAXIES[0];
    const s = must(getSystem(g, g.startSystemId), 'start system');
    const capital = must(getStation(s, g.startStationId), 'start station');
    const eyeball = bodyOf(s, capital.parentBodyId);
    // Low orbit of the home world: about an hour and a half round, like any low orbit of an Earth-sized world.
    const period = 2 * Math.PI * Math.sqrt(capital.orbit.a ** 3 / eyeball.mu);
    expect(period).toBeGreaterThan(80 * 60);
    expect(period).toBeLessThan(110 * 60);
    // The year is short and the neighbours are near: the giant is within half an AU.
    const year = 2 * Math.PI * Math.sqrt(must(eyeball.orbit, 'orbit').a ** 3 / s.bodies[0].mu);
    expect(year).toBeLessThan(60 * 86400);
    const giant = must(s.bodies.find((b) => b.cls === 'gasGiant'), 'giant');
    expect(must(giant.orbit, 'orbit').a).toBeLessThan(0.6 * AU);
    // An aerobraking classroom: a world with thick air between the lava world and home.
    expect(s.bodies.some((b) => b.kind === 'planet' && b.cls === 'desert' && must(b.atmosphere, 'air').surfaceDensity > 0.1)).toBe(true);
  });
});
