// Shared test fixture: one small, fully specified, physically consistent star system.
//
// A 0.12-solar-mass red dwarf with three planets at realistic compact distances, built by hand (not
// by the galaxy generator) so every sim test has the same known geometry:
//
//   Ashgrove (M6V star, 0.12 Msun)
//   ├─ Cinder    small airless inner world        a = 2.3e9 m   (T ≈ 2.0 d)
//   ├─ Tessaly   rocky world, atmosphere          a = 5.0e9 m   (T ≈ 6.4 d), SOI ≈ 7.5e7 m
//   │   ├─ Pip             moon                   a = 2.6e7 m   (T ≈ 11 h),  SOI ≈ 3.6e6 m
//   │   ├─ Tessaly Highport  station, low orbit   a = 6.95e6 m  (400 km altitude, equatorial)
//   │   └─ Skerry Relay      second orbiter       a = 9.60e6 m  (3,050 km altitude, i = 10°)
//   └─ Brannoch  ringed gas giant, atmosphere     a = 1.6e10 m  (T ≈ 37 d),  SOI ≈ 1.9e9 m
//       ├─ Ring Drift        mining site (rings)  a = 1.18e8 m
//       ├─ Osk             small moon             a = 2.4e8 m,  SOI ≈ 3.5e6 m
//       ├─ Maren           large moon             a = 5.2e8 m,  SOI ≈ 1.4e7 m
//       │   └─ Maren Anchorage  station           a = 3.3e6 m   (800 km altitude)
//       └─ jump beacon parking orbit              r = 8.0e8 m
//
// mu = G·mass and soi = a·(m/M)^(2/5) are computed here, independently of src/sim/orbit.ts, so tests
// can check the module against them. All values are SI (see docs/ARCHITECTURE.md).

import type {
  AtmosphereDef,
  BodyClass,
  BodyDef,
  BodyKind,
  BodyVisualDef,
  MiningSiteDef,
  OrbitElements,
  RingDef,
  StarDef,
  StationDef,
  SystemDef,
} from '../../src/core/types';
import { DEG, EARTH_MASS, G, JUPITER_MASS, SOLAR_MASS, SOLAR_RADIUS } from '../../src/core/units';

/** Ids of everything in the fixture system. */
export const TEST_IDS = {
  system: 'ashgrove',
  star: 'ashgrove-a',
  /** Small airless inner planet. */
  inner: 'cinder',
  /** Rocky planet with an atmosphere and one moon. */
  rocky: 'tessaly',
  rockyMoon: 'pip',
  /** Ringed gas giant with two moons. */
  giant: 'brannoch',
  giantMoonSmall: 'osk',
  giantMoonLarge: 'maren',
  /** Station in low equatorial orbit of the rocky planet. */
  stationLow: 'tessaly-highport',
  /** Station orbiting the giant's larger moon. */
  stationMoon: 'maren-anchorage',
  /** Second orbiter of the rocky planet: higher, inclined ~10° (a rendezvous / plane-change target). */
  orbiter2: 'skerry-relay',
  /** Mining site inside the giant's rings. */
  site: 'brannoch-ring-drift',
} as const;

const TAU = Math.PI * 2;

const el = (a: number, e: number, iDeg: number, lanDeg: number, argpDeg: number, m0Deg: number): OrbitElements => ({
  a,
  e,
  i: iDeg * DEG,
  lan: lanDeg * DEG,
  argp: argpDeg * DEG,
  m0: m0Deg * DEG,
  epoch: 0,
});

interface BodySpec {
  id: string;
  name: string;
  kind: BodyKind;
  cls: BodyClass;
  parent: BodyDef | null;
  mass: number;
  radius: number;
  orbit: OrbitElements | null;
  /** Used when not tidally locked. */
  rotationPeriod?: number;
  axialTilt?: number;
  tidallyLocked?: boolean;
  atmosphere?: AtmosphereDef;
  rings?: RingDef;
  star?: StarDef;
  visual: BodyVisualDef;
  temperature: number;
  description: string;
  surveyValue?: number;
}

function makeBody(s: BodySpec): BodyDef {
  const mu = G * s.mass;
  let soi = Infinity;
  let orbitalPeriod = Infinity;
  if (s.parent && s.orbit) {
    soi = s.orbit.a * Math.pow(s.mass / s.parent.mass, 2 / 5);
    orbitalPeriod = TAU * Math.sqrt((s.orbit.a * s.orbit.a * s.orbit.a) / s.parent.mu);
  }
  const locked = s.tidallyLocked ?? false;
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    cls: s.cls,
    parentId: s.parent ? s.parent.id : null,
    mass: s.mass,
    radius: s.radius,
    mu,
    soi,
    orbit: s.orbit,
    rotationPeriod: locked ? orbitalPeriod : (s.rotationPeriod ?? 86400),
    axialTilt: s.axialTilt ?? 0,
    tidallyLocked: locked,
    atmosphere: s.atmosphere ?? null,
    rings: s.rings ?? null,
    star: s.star ?? null,
    visual: s.visual,
    temperature: s.temperature,
    description: s.description,
    surveyValue: s.surveyValue ?? 0,
  };
}

/**
 * Build the fixture system. Returns a fresh, independent object on every call (safe to mutate).
 * Bodies are listed parents-first; index 0 is the primary star.
 */
export function makeTestSystem(): SystemDef {
  const star = makeBody({
    id: TEST_IDS.star,
    name: 'Ashgrove',
    kind: 'star',
    cls: 'star',
    parent: null,
    mass: 0.12 * SOLAR_MASS,
    radius: 0.15 * SOLAR_RADIUS,
    orbit: null,
    rotationPeriod: 4.1 * 86400,
    star: { temperature: 2900, luminosity: 0.0012, spectralClass: 'M6V', color: [1.0, 0.42, 0.2], activity: 0.55 },
    visual: { seed: 101, palette: [[1.0, 0.36, 0.12], [1.0, 0.55, 0.25], [1.0, 0.8, 0.55]] },
    temperature: 2900,
    description: 'A dim, flare-prone ember star. Its three worlds huddle within a tenth of an astronomical unit.',
  });

  const inner = makeBody({
    id: TEST_IDS.inner,
    name: 'Cinder',
    kind: 'planet',
    cls: 'barren',
    parent: star,
    mass: 0.11 * EARTH_MASS,
    radius: 3.4e6,
    orbit: el(2.3e9, 0.02, 1.2, 40, 75, 200),
    tidallyLocked: true,
    visual: { seed: 102, palette: [[0.18, 0.15, 0.13], [0.32, 0.27, 0.23], [0.5, 0.44, 0.38]], roughness: 0.8, craters: 0.9 },
    temperature: 520,
    description: 'A scorched, airless rock whipping around Ashgrove every two days.',
    surveyValue: 1800,
  });

  const rocky = makeBody({
    id: TEST_IDS.rocky,
    name: 'Tessaly',
    kind: 'planet',
    cls: 'eyeball',
    parent: star,
    mass: 1.1 * EARTH_MASS,
    radius: 6.55e6,
    orbit: el(5.0e9, 0.01, 0, 0, 35, 63),
    tidallyLocked: true,
    atmosphere: {
      height: 1.2e5,
      scaleHeight: 8000,
      surfaceDensity: 1.2,
      color: [0.32, 0.5, 0.9],
      sunsetColor: [1.0, 0.45, 0.2],
      opacity: 0.55,
      scoopable: false,
    },
    visual: {
      seed: 103,
      palette: [[0.08, 0.16, 0.2], [0.2, 0.3, 0.18], [0.45, 0.4, 0.3], [0.85, 0.87, 0.9]],
      roughness: 0.5,
      oceanLevel: 0.45,
      oceanColor: [0.02, 0.07, 0.13],
      ice: 0.5,
      cloudCover: 0.4,
      cityLights: 0.6,
    },
    temperature: 281,
    description: 'A tidally locked terminator world: cities ring the twilight band between glare and ice.',
    surveyValue: 5200,
  });

  const rockyMoon = makeBody({
    id: TEST_IDS.rockyMoon,
    name: 'Pip',
    kind: 'moon',
    cls: 'barren',
    parent: rocky,
    mass: 4.8e22,
    radius: 1.2e6,
    orbit: el(2.6e7, 0.02, 3, 40, 110, 23),
    tidallyLocked: true,
    visual: { seed: 104, palette: [[0.2, 0.2, 0.21], [0.38, 0.37, 0.36], [0.6, 0.59, 0.57]], roughness: 0.7, craters: 0.8 },
    temperature: 240,
    description: 'Tessaly’s close grey moon, eleven hours to an orbit and bright in every terminator sky.',
    surveyValue: 900,
  });

  const giant = makeBody({
    id: TEST_IDS.giant,
    name: 'Brannoch',
    kind: 'planet',
    cls: 'gasGiant',
    parent: star,
    mass: 0.6 * JUPITER_MASS,
    radius: 6.4e7,
    orbit: el(1.6e10, 0.03, 0.8, 130, 250, 310),
    rotationPeriod: 10.6 * 3600,
    axialTilt: 0,
    atmosphere: {
      height: 1.0e6,
      scaleHeight: 4.5e4,
      surfaceDensity: 0.16,
      color: [0.75, 0.62, 0.45],
      sunsetColor: [0.9, 0.4, 0.2],
      opacity: 0.8,
      scoopable: true,
    },
    rings: { innerRadius: 8.6e7, outerRadius: 1.45e8, color: [0.72, 0.66, 0.58], opacity: 0.7, seed: 105 },
    visual: {
      seed: 106,
      palette: [[0.55, 0.4, 0.28], [0.75, 0.62, 0.45], [0.9, 0.82, 0.68], [0.4, 0.28, 0.22]],
      bands: 14,
      storms: 0.5,
    },
    temperature: 120,
    description: 'A banded hydrogen giant wearing broad tan rings; its moons feed the system’s refineries.',
    surveyValue: 7400,
  });

  const giantMoonSmall = makeBody({
    id: TEST_IDS.giantMoonSmall,
    name: 'Osk',
    kind: 'moon',
    cls: 'ice',
    parent: giant,
    mass: 3.0e22,
    radius: 1.25e6,
    orbit: el(2.4e8, 0.005, 0.5, 300, 15, 140),
    tidallyLocked: true,
    visual: { seed: 107, palette: [[0.6, 0.66, 0.72], [0.8, 0.85, 0.9], [0.95, 0.97, 1.0]], roughness: 0.3, ice: 0.9 },
    temperature: 95,
    description: 'A fractured ice moon skating just outside Brannoch’s rings.',
    surveyValue: 1500,
  });

  const giantMoonLarge = makeBody({
    id: TEST_IDS.giantMoonLarge,
    name: 'Maren',
    kind: 'moon',
    cls: 'rocky',
    parent: giant,
    mass: 1.4e23,
    radius: 2.5e6,
    orbit: el(5.2e8, 0.01, 1.5, 80, 200, 265),
    tidallyLocked: true,
    visual: { seed: 108, palette: [[0.3, 0.2, 0.15], [0.5, 0.36, 0.26], [0.7, 0.56, 0.42]], roughness: 0.6, craters: 0.5 },
    temperature: 110,
    description: 'Brannoch’s largest moon, a rust-coloured world of ore seams and deep canyons.',
    surveyValue: 2600,
  });

  const bodies = [star, inner, rocky, rockyMoon, giant, giantMoonSmall, giantMoonLarge];

  const stations: StationDef[] = [
    {
      id: TEST_IDS.stationLow,
      name: 'Tessaly Highport',
      systemId: TEST_IDS.system,
      parentBodyId: rocky.id,
      orbit: el(rocky.radius + 4.0e5, 0, 0, 0, 0, 10),
      visualId: 'ringHabitat',
      visualSeed: 201,
      maxPad: 'L',
      economies: ['service', 'hightech'],
      population: 240000,
      services: ['market', 'missions', 'outfitting', 'shipyard', 'refuel', 'repair', 'survey', 'legal'],
      description: 'The system capital: a habitat ring 400 km above the terminator cities.',
    },
    {
      id: TEST_IDS.stationMoon,
      name: 'Maren Anchorage',
      systemId: TEST_IDS.system,
      parentBodyId: giantMoonLarge.id,
      orbit: el(giantMoonLarge.radius + 8.0e5, 0.001, 0, 0, 30, 120),
      visualId: 'refinery',
      visualSeed: 202,
      maxPad: 'L',
      economies: ['refinery', 'extraction'],
      population: 18000,
      services: ['market', 'missions', 'refuel', 'repair'],
      description: 'Smelter stacks and tank farms in low orbit of Maren, fed by the ring miners.',
    },
    {
      id: TEST_IDS.orbiter2,
      name: 'Skerry Relay',
      systemId: TEST_IDS.system,
      parentBodyId: rocky.id,
      orbit: el(9.6e6, 0.002, 10, 65, 20, 190),
      visualId: 'outpost',
      visualSeed: 203,
      maxPad: 'M',
      economies: ['service'],
      population: 600,
      services: ['refuel', 'repair', 'missions'],
      description: 'A communications outpost on a higher, inclined orbit of Tessaly.',
    },
  ];

  const miningSites: MiningSiteDef[] = [
    {
      id: TEST_IDS.site,
      name: 'Brannoch Ring Drift',
      systemId: TEST_IDS.system,
      parentBodyId: giant.id,
      orbit: el(1.18e8, 0, 0, 0, 0, 77),
      richness: 0.7,
      ores: [
        { commodityId: 'water_ice', weight: 3 },
        { commodityId: 'cryovolatiles', weight: 1 },
      ],
      visualSeed: 301,
      kind: 'ring',
    },
  ];

  return {
    id: TEST_IDS.system,
    name: 'Ashgrove',
    pos: { x: 0, y: 0, z: 0 },
    bodies,
    stations,
    miningSites,
    jumpBeacon: { bodyId: giant.id, orbitRadius: 8.0e8 },
    population: stations.reduce((sum, s) => sum + s.population, 0) + 3_100_000,
    baseSecurity: 0.7,
    capitalStationId: TEST_IDS.stationLow,
    description: 'A compact ember system used as the reference geometry for simulation tests.',
    skySeed: 4242,
  };
}
