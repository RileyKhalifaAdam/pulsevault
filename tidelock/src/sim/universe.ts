// The Ember Reach: galaxy generation and the queries the rest of the simulation asks of it.
//
// generateGalaxy(seed) is a pure function of its seed. It lays out ~24 star systems, builds the six
// hand-authored showpieces (src/data/systems) and generates the rest procedurally, then founds the
// minor factions and deals out their starting influence. Both kinds of system go through the same
// `buildSystem`, which derives everything physics dictates from a compact SystemSpec:
//
//   * stars: mass -> radius, luminosity, temperature, spectral class (main-sequence relations;
//     white and brown dwarfs from mass + cooling temperature)
//   * planets and moons: mass -> radius by composition, mu = G*m, SOI = a*(m/M)^(2/5), tidal locking
//     inside the lock radius, equilibrium temperature from stellar flux (+ greenhouse), isothermal
//     atmospheres (scale height R*T/(M*g), surface density P*M/(R*T))
//   * orbits: spacing by mutual Hill radii, moons between the Roche limit and 0.4 Hill radii, rings
//     inside the Roche limit, every orbit inside half the parent's SOI
//
// Axis convention used here for body spin (BodyDef has only a scalar obliquity): the spin axis is
// system +Y tilted by `axialTilt` toward +Z, i.e. the body's equatorial plane is the orbit plane with
// inclination = axialTilt and lan = 0. Rings, regular moons, ring mining sites and (by default)
// stations lie in that plane. See `bodySpinAxis` / `equatorialOrbit`.
//
// Everything returned is plain data. Nothing here touches three.js, the DOM, Math.random or Date.

import type {
  AtmosphereDef,
  BodyClass,
  BodyDef,
  BodyVisualDef,
  CommodityDef,
  EconomyType,
  FactionDef,
  Government,
  JumpBeaconDef,
  MiningSiteDef,
  OrbitElements,
  PadSize,
  PowerDef,
  PowerId,
  RGB,
  RingDef,
  StarDef,
  StationDef,
  StationService,
  StationVisualId,
  SystemDef,
  V3,
} from '../core/types';
import { hash, makeRng, type Rng } from '../core/rng';
import {
  AU,
  DAY,
  DEG,
  EARTH_MASS,
  EARTH_RADIUS,
  G,
  HOUR,
  JUPITER_MASS,
  JUPITER_RADIUS,
  SOLAR_MASS,
  SOLAR_RADIUS,
  fmtDistance,
  fmtDuration,
  fmtInt,
  fmtSpeed,
} from '../core/units';
import { COMMODITIES } from '../data/commodities';
import {
  INDEPENDENT_COLOR,
  INDEPENDENT_GOVERNMENTS,
  OUTLAW_COLOR,
  POWERS,
  POWER_GOVERNMENTS,
  hexToLinear,
  type GovernmentWeight,
} from '../data/powers';
import {
  NAME_THEMES,
  factionName,
  pickStarName,
  siteName,
  slug,
  stationName,
  type NameTheme,
} from '../data/names';
import type {
  AtmosphereSpec,
  BodySpec,
  FactionSpec,
  RingSpec,
  SiteSpec,
  StarKind,
  StarSpec,
  StationSpec,
  SystemSpec,
} from '../data/systems/spec';
import { SHOWCASE_SYSTEMS } from '../data/systems/index';
import { GALAXY_SLOTS, START_STATION_ID, START_SYSTEM_ID, type GalaxySlot, type StarHint } from '../data/systems/layout';
import {
  bodyLore,
  factionLore,
  starLore,
  stationLore,
  systemLore,
  type LoreDecks,
  makeLoreDecks,
} from '../data/systems/lore';

const TAU = Math.PI * 2;
/** Universal gas constant, J/(mol K). */
const GAS_CONSTANT = 8.314462618;
/** Density at which an atmosphere is treated as ending (sets AtmosphereDef.height), kg/m^3. */
const ATMOSPHERE_CUTOFF_DENSITY = 1e-7;
/** Bulk density of ring ice, kg/m^3 (Roche limit for rings). */
const RING_ICE_DENSITY = 920;
/** Density assumed for a rubble-pile moon when testing against the Roche limit, kg/m^3. */
const RUBBLE_DENSITY = 2000;
/** Maximum single hop for which the cluster is guaranteed connected, light-years. */
export const MAX_GUARANTEED_JUMP_LY = 7;

// =====================================================================================
// 1. Physics helpers
// =====================================================================================

/** Period of an orbit with semi-major axis `a` around a body with gravitational parameter `mu`, s. */
export function orbitalPeriod(mu: number, a: number): number {
  return TAU * Math.sqrt((a * a * a) / mu);
}

/** Circular orbit speed at radius `r`, m/s. */
export function circularSpeed(mu: number, r: number): number {
  return Math.sqrt(mu / r);
}

/** Hill radius of mass `m` orbiting mass `M` at semi-major axis `a`, eccentricity `e`, m. */
export function hillRadius(a: number, e: number, m: number, M: number): number {
  return a * (1 - e) * Math.cbrt(m / (3 * M));
}

/** Patched-conic sphere-of-influence radius a*(m/M)^(2/5), m. */
export function soiRadius(a: number, m: number, M: number): number {
  return a * Math.pow(m / M, 0.4);
}

/** Mean density, kg/m^3. */
export function meanDensity(mass: number, radius: number): number {
  return mass / ((4 / 3) * Math.PI * radius * radius * radius);
}

/** Fluid Roche limit: closest a self-gravitating satellite of the given density can orbit, m. */
export function rocheLimit(primaryRadius: number, primaryDensity: number, satelliteDensity: number): number {
  return 2.44 * primaryRadius * Math.cbrt(primaryDensity / satelliteDensity);
}

/** Stellar flux at `distance` in units of the flux Earth receives from Sol. `luminosity` in solar units. */
export function stellarFlux(luminosity: number, distance: number): number {
  const d = distance / AU;
  return luminosity / (d * d);
}

/** Black-body equilibrium temperature of a fast rotator with Bond albedo `albedo`, K. */
export function equilibriumTemperature(luminosity: number, distance: number, albedo: number): number {
  return 278.3 * Math.pow(stellarFlux(luminosity, distance) * (1 - albedo), 0.25);
}

/** Orbital radius inside which a rocky planet is tidally locked to a star of the given mass within a few Gyr, m. */
export function tidalLockRadius(starMass: number): number {
  return 0.45 * AU * Math.cbrt(starMass / SOLAR_MASS);
}

/** Total delta-v of a two-burn Hohmann transfer between coplanar circular orbits r1 and r2, m/s. */
export function hohmannDv(mu: number, r1: number, r2: number): number {
  if (r1 === r2) return 0;
  const lo = Math.min(r1, r2);
  const hi = Math.max(r1, r2);
  const v1 = Math.sqrt(mu / lo);
  const v2 = Math.sqrt(mu / hi);
  return v1 * (Math.sqrt((2 * hi) / (lo + hi)) - 1) + v2 * (1 - Math.sqrt((2 * lo) / (lo + hi)));
}

export interface StarPhysics {
  /** m */
  radius: number;
  /** Solar luminosities. */
  luminosity: number;
  /** Effective temperature, K. */
  temperature: number;
  spectralClass: string;
  color: RGB;
  activity: number;
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const r4 = (x: number): number => Math.round(x * 10000) / 10000;
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const srgbToLinear = (s: number): number => (s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4));

/** Approximate linear-RGB colour of a black body at temperature T (K), normalised so the brightest channel is 1. */
export function blackbodyColor(T: number): RGB {
  const t = clamp(T, 1000, 40000) / 100;
  let r: number;
  let g: number;
  let b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const lin = [r, g, b].map((x) => srgbToLinear(clamp(x, 0, 255) / 255));
  const m = Math.max(lin[0], lin[1], lin[2]);
  return [r4(lin[0] / m), r4(lin[1] / m), r4(lin[2] / m)];
}

function spectralClassOf(kind: StarKind, T: number): string {
  if (kind === 'whiteDwarf') return `DA${clamp(Math.round(50400 / T), 1, 9)}`;
  if (kind === 'brownDwarf') {
    if (T >= 1300) return `L${clamp(Math.floor((2300 - T) / 100), 0, 9)}`;
    return `T${clamp(Math.floor((1300 - T) / 80), 0, 9)}`;
  }
  const bands: [string, number, number][] = [
    ['A', 10000, 7300],
    ['F', 7300, 6000],
    ['G', 6000, 5300],
    ['K', 5300, 3900],
    ['M', 3900, 2300],
  ];
  for (const [letter, hot, cool] of bands) {
    if (T >= cool) return `${letter}${clamp(Math.floor(((hot - T) / (hot - cool)) * 10), 0, 9)}V`;
  }
  return 'M9V';
}

/**
 * Radius, luminosity, temperature, spectral class and colour of a star from its mass.
 * Main sequence: L = 0.23 M^2.3 (M < 0.43) or M^4, R = M^0.88 (M < 1) or M^0.8, T from Stefan–Boltzmann.
 * White dwarfs: Earth-sized, R ∝ M^(-1/3); brown dwarfs: about one Jupiter radius. Both need a
 * cooling temperature (defaults 9,000 K / 1,400 K).
 */
export function starPhysics(kind: StarKind, mass: number, temperature?: number, activity?: number): StarPhysics {
  const m = mass / SOLAR_MASS;
  let radiusSolar: number;
  let luminosity: number;
  let T: number;
  let act: number;
  if (kind === 'whiteDwarf') {
    radiusSolar = 0.0127 * Math.pow(m / 0.6, -1 / 3);
    T = temperature ?? 9000;
    luminosity = radiusSolar * radiusSolar * Math.pow(T / 5772, 4);
    act = 0;
  } else if (kind === 'brownDwarf') {
    radiusSolar = 0.094 * Math.pow(m / 0.05, -0.1);
    T = temperature ?? 1400;
    luminosity = radiusSolar * radiusSolar * Math.pow(T / 5772, 4);
    act = 0.15;
  } else {
    luminosity = m < 0.43 ? 0.23 * Math.pow(m, 2.3) : Math.pow(m, 4);
    radiusSolar = m < 1 ? Math.pow(m, 0.88) : Math.pow(m, 0.8);
    T = 5772 * Math.pow(luminosity / (radiusSolar * radiusSolar), 0.25);
    act = m < 0.2 ? 0.8 : m < 0.35 ? 0.6 : m < 0.6 ? 0.4 : m < 0.9 ? 0.2 : 0.1;
  }
  return {
    radius: radiusSolar * SOLAR_RADIUS,
    luminosity,
    temperature: Math.round(T),
    spectralClass: spectralClassOf(kind, T),
    color: blackbodyColor(T),
    activity: r3(activity ?? act),
  };
}

const isGiant = (cls: BodyClass): boolean => cls === 'gasGiant' || cls === 'iceGiant';

/**
 * Radius of a planet or moon from its mass and composition class, m.
 * Rock: R ∝ M^0.28 above 0.05 Earth masses, uncompressed 3,400 kg/m^3 below; ice-rich bodies ~19 %
 * larger (2,000 kg/m^3 when small); ice giants 1.6 M^0.3 Earth radii; gas giants near one Jupiter
 * radius (R ∝ M^0.15 below a Jupiter mass, shrinking slowly above it).
 */
export function planetRadius(cls: BodyClass, mass: number): number {
  const me = mass / EARTH_MASS;
  const sphere = (rho: number): number => Math.cbrt((3 * mass) / (4 * Math.PI * rho));
  switch (cls) {
    case 'gasGiant': {
      const mj = mass / JUPITER_MASS;
      return JUPITER_RADIUS * (mj < 1 ? Math.pow(mj, 0.15) : Math.pow(mj, -0.04));
    }
    case 'iceGiant':
      return EARTH_RADIUS * 1.6 * Math.pow(me, 0.3);
    case 'ice':
      return me >= 0.05 ? EARTH_RADIUS * 1.19 * Math.pow(me, 0.28) : sphere(2000);
    case 'ocean':
      return EARTH_RADIUS * 1.06 * Math.pow(me, 0.28);
    default:
      return me >= 0.05 ? EARTH_RADIUS * Math.pow(me, 0.28) : sphere(3400);
  }
}

// =====================================================================================
// 2. Class defaults: albedo, atmospheres, looks, survey value
// =====================================================================================

const ALBEDO: Record<BodyClass, number> = {
  star: 0,
  barren: 0.11,
  rocky: 0.22,
  desert: 0.26,
  lava: 0.08,
  ice: 0.55,
  ocean: 0.3,
  terran: 0.3,
  eyeball: 0.3,
  gasGiant: 0.34,
  iceGiant: 0.3,
};

const SURVEY_BASE: Record<BodyClass, number> = {
  star: 600,
  barren: 500,
  rocky: 1100,
  desert: 1700,
  lava: 2400,
  ice: 1200,
  ocean: 9000,
  terran: 13000,
  eyeball: 10500,
  gasGiant: 3000,
  iceGiant: 2600,
};

const hexes = (...h: string[]): RGB[] => h.map(hexToLinear);

/** Sky tints (day-side scattering colour, sunset colour) by kind of air. */
const AIR = {
  breathable: { color: hexToLinear('#6C9CF0'), sunsetColor: hexToLinear('#FF8A4A') },
  dusty: { color: hexToLinear('#D9B27C'), sunsetColor: hexToLinear('#7FA6D9') },
  thin: { color: hexToLinear('#C9A27E'), sunsetColor: hexToLinear('#6F93C9') },
  vapour: { color: hexToLinear('#FF9A4D'), sunsetColor: hexToLinear('#FF5A2A') },
  haze: { color: hexToLinear('#E0A050'), sunsetColor: hexToLinear('#B8642C') },
  hydrogenWarm: { color: hexToLinear('#E8D8B8'), sunsetColor: hexToLinear('#F0B070') },
  hydrogenHot: { color: hexToLinear('#86AEE6'), sunsetColor: hexToLinear('#E8C0A0') },
  methane: { color: hexToLinear('#8FD8E8'), sunsetColor: hexToLinear('#D8F2F0') },
} as const;

/** Class-default atmosphere for a body whose spec leaves it open. Deterministic in `rng`. */
function defaultAtmosphere(cls: BodyClass, mass: number, eqTemp: number, rng: Rng): AtmosphereSpec | null {
  switch (cls) {
    case 'terran':
    case 'eyeball': {
      const p = rng.range(0.7, 1.4) * 1e5;
      return { pressure: p, molarMass: 0.02897, ...AIR.breathable, opacity: 0.55, greenhouse: 30 * Math.pow(p / 1e5, 0.4) };
    }
    case 'ocean': {
      const p = rng.range(0.9, 1.8) * 1e5;
      return { pressure: p, molarMass: 0.0275, ...AIR.breathable, opacity: 0.65, greenhouse: 32 * Math.pow(p / 1e5, 0.4) };
    }
    case 'desert': {
      const p = rng.range(0.25, 1.6) * 1e5;
      return { pressure: p, molarMass: 0.038, ...AIR.dusty, opacity: 0.45, greenhouse: 22 * Math.sqrt(p / 1e5) };
    }
    case 'rocky': {
      const p = rng.range(400, 4000);
      return { pressure: p, molarMass: 0.0435, ...AIR.thin, opacity: 0.16, greenhouse: 4 };
    }
    case 'lava': {
      if (rng.chance(0.4)) return null;
      return { pressure: rng.range(40, 400), molarMass: 0.05, ...AIR.vapour, opacity: 0.1, greenhouse: 0 };
    }
    case 'ice': {
      // Only large, cold ice worlds hold a dense nitrogen-methane haze; the rest are bare.
      if (mass >= 0.018 * EARTH_MASS && eqTemp < 110 && rng.chance(0.3)) {
        return { pressure: rng.range(0.6, 1.5) * 1e5, molarMass: 0.028, ...AIR.haze, opacity: 0.9, greenhouse: 9 };
      }
      return null;
    }
    case 'gasGiant':
      return {
        pressure: 1e5,
        molarMass: 0.0023,
        ...(eqTemp > 330 ? AIR.hydrogenHot : AIR.hydrogenWarm),
        opacity: 0.6,
        scoopable: true,
      };
    case 'iceGiant':
      return { pressure: 1e5, molarMass: 0.0026, ...AIR.methane, opacity: 0.55, scoopable: true };
    default:
      return null;
  }
}

/** Turn an atmosphere spec into the contract's AtmosphereDef for a body of the given gravity and temperature. */
function buildAtmosphere(spec: AtmosphereSpec, mu: number, radius: number, temperature: number): AtmosphereDef | null {
  const g = mu / (radius * radius);
  const scaleHeight = (GAS_CONSTANT * temperature) / (spec.molarMass * g);
  const surfaceDensity = (spec.pressure * spec.molarMass) / (GAS_CONSTANT * temperature);
  if (surfaceDensity < ATMOSPHERE_CUTOFF_DENSITY * 10) return null;
  const height = Math.min(scaleHeight * Math.log(surfaceDensity / ATMOSPHERE_CUTOFF_DENSITY), 0.25 * radius);
  return {
    height: Math.round(height),
    scaleHeight: Math.round(scaleHeight),
    surfaceDensity: Number(surfaceDensity.toPrecision(4)),
    color: spec.color,
    sunsetColor: spec.sunsetColor,
    opacity: spec.opacity,
    scoopable: spec.scoopable ?? false,
  };
}

const PALETTES: Record<Exclude<BodyClass, 'star' | 'gasGiant'>, RGB[][]> = {
  barren: [
    hexes('#353230', '#67625c', '#948e84', '#c4bcae'),
    hexes('#2b2624', '#5a4c44', '#8a7566', '#b9a690'),
    hexes('#1e1f22', '#44464b', '#74777c', '#a9abad'),
  ],
  rocky: [
    hexes('#43291e', '#74452f', '#a36a46', '#cc9c74'),
    hexes('#3a3028', '#6a5a48', '#9a8466', '#c8b592'),
    hexes('#33272a', '#5e4347', '#8c6660', '#b99a86'),
  ],
  desert: [
    hexes('#553c23', '#946635', '#c49557', '#e3cb9c'),
    hexes('#5c2f1e', '#9a5230', '#c98852', '#e8c79a'),
    hexes('#4d4530', '#857a50', '#b8ab78', '#e0d7ae'),
  ],
  lava: [hexes('#0f0908', '#241410', '#402015', '#6e3519'), hexes('#0b0b0d', '#1e1a1c', '#3a2a26', '#5e3a2a')],
  ice: [
    hexes('#7b90a6', '#b5c5d4', '#dbe6ee', '#f2f6fa'),
    hexes('#66584e', '#a59f98', '#d5d9dc', '#eef2f5'),
    hexes('#5d7f96', '#93b8c9', '#c9e0e8', '#eef7f9'),
  ],
  ocean: [hexes('#0a2644', '#12456c', '#2b6887', '#d4cdaa'), hexes('#0b2e3a', '#14566a', '#3a7f86', '#cfc9a8')],
  terran: [
    hexes('#1d3927', '#3b6536', '#858556', '#b49f78', '#e4e0d8'),
    hexes('#26341f', '#56683a', '#97895a', '#b7a184', '#e6e2da'),
  ],
  // Under red-dwarf light photosynthesis runs dark: terminator vegetation is near black.
  eyeball: [
    hexes('#262320', '#36372a', '#564733', '#877558', '#d4ccbc'),
    hexes('#231f24', '#3a2f36', '#5a4a44', '#8a7864', '#d6cec2'),
  ],
  iceGiant: [
    hexes('#5ab0c4', '#7acbd4', '#4695b3', '#a3dce2'),
    hexes('#2c5aa8', '#467ac8', '#3665b8', '#7aa3e2'),
    hexes('#4fa38e', '#74c4a8', '#3f8a80', '#a6dcc8'),
  ],
};

const GAS_PALETTES = {
  hot: [hexes('#254568', '#386a9a', '#1b314c', '#5589b8', '#2e5580')],
  warm: [
    hexes('#c4ab85', '#a37b58', '#e1d3b3', '#85664d', '#d4bd95'),
    hexes('#b98f6a', '#8c5a3e', '#dcc3a0', '#6e4a38', '#c9a67c'),
  ],
  cold: [
    hexes('#d3c49b', '#bda87c', '#e4dabb', '#ab956c', '#cbb98c'),
    hexes('#c8bfae', '#a89c88', '#ddd6c6', '#8f8474', '#b9ae9a'),
    hexes('#b7a9c4', '#9485a8', '#d2c8dc', '#7a6c90', '#a698b8'),
  ],
};

/** Seeded class-default look for a body. Spec `visual` fields override these. */
function defaultVisual(cls: BodyClass, seed: number, temperature: number, starColor: RGB): BodyVisualDef {
  const rng = makeRng(seed);
  const u = (lo: number, hi: number): number => r3(rng.range(lo, hi));
  switch (cls) {
    case 'star':
      return {
        seed,
        palette: [
          [r4(starColor[0] * 0.55), r4(starColor[1] * 0.4), r4(starColor[2] * 0.3)],
          starColor,
          [1, r4(Math.min(1, starColor[1] * 1.25)), r4(Math.min(1, starColor[2] * 1.5))],
        ],
      };
    case 'barren':
      return { seed, palette: rng.pick(PALETTES.barren), roughness: u(0.6, 0.9), craters: u(0.6, 1) };
    case 'rocky':
      return { seed, palette: rng.pick(PALETTES.rocky), roughness: u(0.5, 0.8), craters: u(0.2, 0.5), ice: u(0.04, 0.22), cloudCover: u(0, 0.08) };
    case 'desert':
      return { seed, palette: rng.pick(PALETTES.desert), roughness: u(0.35, 0.6), craters: u(0.04, 0.18), cloudCover: u(0.05, 0.22), ice: 0 };
    case 'lava':
      return { seed, palette: rng.pick(PALETTES.lava), roughness: u(0.5, 0.8), craters: u(0.05, 0.2), lava: u(0.65, 1) };
    case 'ice':
      return { seed, palette: rng.pick(PALETTES.ice), roughness: u(0.2, 0.5), craters: u(0.1, 0.4), ice: 1 };
    case 'ocean':
      return {
        seed,
        palette: rng.pick(PALETTES.ocean),
        roughness: u(0.3, 0.5),
        oceanLevel: u(0.88, 0.97),
        oceanColor: hexToLinear('#0c2f55'),
        ice: u(0.05, 0.2),
        cloudCover: u(0.5, 0.7),
        cloudColor: [0.9, 0.9, 0.9],
      };
    case 'terran':
      return {
        seed,
        palette: rng.pick(PALETTES.terran),
        roughness: u(0.4, 0.6),
        oceanLevel: u(0.5, 0.7),
        oceanColor: hexToLinear('#0d3358'),
        ice: u(0.1, 0.25),
        cloudCover: u(0.4, 0.6),
        cloudColor: [0.9, 0.9, 0.9],
      };
    case 'eyeball':
      return {
        seed,
        palette: rng.pick(PALETTES.eyeball),
        roughness: u(0.4, 0.6),
        oceanLevel: u(0.35, 0.55),
        oceanColor: hexToLinear('#0b2a44'),
        ice: u(0.45, 0.65),
        cloudCover: u(0.35, 0.6),
        cloudColor: [0.88, 0.88, 0.88],
      };
    case 'gasGiant': {
      const set = temperature > 330 ? GAS_PALETTES.hot : temperature > 135 ? GAS_PALETTES.warm : GAS_PALETTES.cold;
      return { seed, palette: rng.pick(set), bands: rng.int(8, 18), storms: u(0.2, 0.8) };
    }
    case 'iceGiant':
      return { seed, palette: rng.pick(PALETTES.iceGiant), bands: rng.int(4, 8), storms: u(0.05, 0.4) };
  }
}

const PAD_BY_VISUAL: Record<StationVisualId, PadSize> = {
  ringHabitat: 'L',
  spindle: 'L',
  refinery: 'L',
  outpost: 'S',
  drydock: 'L',
  citadel: 'L',
};

/** Services a station of the given type offers by default. */
function defaultServices(visualId: StationVisualId, capital: boolean, security: number, population: number, economies: EconomyType[]): StationService[] {
  let s: StationService[];
  switch (visualId) {
    case 'ringHabitat':
      s = ['market', 'missions', 'outfitting', 'shipyard', 'refuel', 'repair', 'survey', 'legal'];
      break;
    case 'spindle':
      s = ['market', 'missions', 'outfitting', 'refuel', 'repair', 'legal'];
      break;
    case 'refinery':
      s = ['market', 'missions', 'refuel', 'repair'];
      break;
    case 'drydock':
      s = ['market', 'missions', 'outfitting', 'shipyard', 'refuel', 'repair'];
      break;
    case 'citadel':
      s = ['market', 'missions', 'outfitting', 'refuel', 'repair', 'legal'];
      break;
    default:
      s = population >= 8000 ? ['market', 'missions', 'refuel', 'repair'] : ['market', 'refuel'];
  }
  if ((capital || economies.includes('hightech')) && !s.includes('survey')) s.push('survey');
  if (security < 0.4 && visualId !== 'citadel') {
    s = s.filter((x) => x !== 'legal');
    s.push('blackmarket');
  }
  return s;
}

// =====================================================================================
// 3. buildSystem: SystemSpec -> SystemDef
// =====================================================================================

/** Unit spin axis of a body in system axes: +Y tilted by `axialTilt` toward +Z. */
export function bodySpinAxis(body: BodyDef): V3 {
  return { x: 0, y: Math.cos(body.axialTilt), z: Math.sin(body.axialTilt) };
}

/** Circular orbit of radius `r` in the equatorial plane of `body` (the plane of its rings and regular moons). */
export function equatorialOrbit(body: BodyDef, r: number, m0 = 0): OrbitElements {
  return { a: r, e: 0, i: body.axialTilt, lan: 0, argp: 0, m0, epoch: 0 };
}

/** Recommended low parking band around a body as [min, max] radius from its centre, m. */
export function lowOrbitBand(body: BodyDef): [number, number] {
  const top = body.radius + (body.atmosphere?.height ?? 0);
  if (body.radius >= 2.0e6) return [top + 300e3, top + 2000e3];
  return [top + Math.max(25e3, 0.08 * body.radius), top + Math.max(60e3, 0.3 * body.radius)];
}

/** Largest apoapsis radius at which a satellite of `body` is long-term stable: min(0.4 Hill, 0.5 SOI), m. */
export function stableOrbitLimit(body: BodyDef, parent: BodyDef | undefined): number {
  if (!parent || !body.orbit) return Infinity;
  return Math.min(0.4 * hillRadius(body.orbit.a, body.orbit.e, body.mass, parent.mass), 0.5 * body.soi);
}

function ringDef(spec: RingSpec, radius: number, seed: number): RingDef {
  return {
    innerRadius: Math.round(spec.inner * radius),
    outerRadius: Math.round(spec.outer * radius),
    color: spec.color,
    opacity: spec.opacity,
    seed,
  };
}

/**
 * Pick the jump-beacon parking radius around `body`: above 8.5 radii, below 0.47 SOI, and clear of
 * rings, moons (with their SOIs) and anything else already orbiting there. Returns null if no gap fits.
 */
function beaconRadius(body: BodyDef, moons: BodyDef[], occupied: [number, number][]): number | null {
  const lo = Math.max(8.5 * body.radius, (body.rings?.outerRadius ?? 0) * 1.1);
  const hi = 0.47 * body.soi;
  if (!(hi > lo * 1.02)) return null;
  const bands: [number, number][] = occupied.map(([a, b]) => [a * 0.96, b * 1.04]);
  for (const m of moons) {
    if (!m.orbit) continue;
    bands.push([m.orbit.a * (1 - m.orbit.e) - 1.6 * m.soi, m.orbit.a * (1 + m.orbit.e) + 1.6 * m.soi]);
  }
  const steps = 60;
  for (let k = 0; k <= steps; k++) {
    const r = lo * Math.pow(hi / lo, k / steps) * 1.01;
    if (r >= hi) break;
    if (!bands.some(([a, b]) => r >= a && r <= b)) return Math.round(r / 1000) * 1000;
  }
  return null;
}

/**
 * Build the contract SystemDef from an authoring spec at cluster position `pos` (light-years).
 * Bodies are emitted star first, then each planet (inner to outer) followed by its moons.
 */
export function buildSystem(spec: SystemSpec, pos: V3): SystemDef {
  const sysSeed = hash(`system:${spec.id}`);
  const rng = makeRng(sysSeed);
  const bodyId = (key: string): string => `${spec.id}.${key}`;

  // ---- star
  const sp = starPhysics(spec.star.kind, spec.star.mass, spec.star.temperature, spec.star.activity);
  const starDef: StarDef = {
    temperature: sp.temperature,
    luminosity: Number(sp.luminosity.toPrecision(4)),
    spectralClass: sp.spectralClass,
    color: sp.color,
    activity: sp.activity,
  };
  const starSeed = hash(`${spec.id}:star`);
  const star: BodyDef = {
    id: bodyId('star'),
    name: spec.star.name,
    kind: 'star',
    cls: 'star',
    parentId: null,
    mass: spec.star.mass,
    radius: Math.round(sp.radius),
    mu: G * spec.star.mass,
    soi: Infinity,
    orbit: null,
    rotationPeriod: Math.round((spec.star.kind === 'main' ? 20 + 60 * (1 - sp.activity) : spec.star.kind === 'brownDwarf' ? 0.2 : 1.5) * DAY * (0.8 + 0.4 * makeRng(starSeed).next())),
    axialTilt: 0,
    tidallyLocked: false,
    atmosphere: null,
    rings: spec.star.rings ? ringDef(spec.star.rings, sp.radius, hash(`${spec.id}:star:ring`)) : null,
    star: starDef,
    visual: defaultVisual('star', starSeed, sp.temperature, sp.color),
    temperature: sp.temperature,
    description: spec.star.description,
    surveyValue: spec.star.surveyValue ?? (spec.star.kind === 'main' ? SURVEY_BASE.star : spec.star.kind === 'whiteDwarf' ? 7500 : 4200),
  };

  const bodies: BodyDef[] = [star];
  const byKey = new Map<string, BodyDef>([['star', star]]);
  const lockRadius = tidalLockRadius(spec.star.mass);
  const stationPopAt = new Map<string, number>();
  for (const st of spec.stations) stationPopAt.set(st.parent, (stationPopAt.get(st.parent) ?? 0) + st.population);

  const makeBody = (b: BodySpec, parent: BodyDef, starDistance: number): BodyDef => {
    const seed = hash(`${spec.id}:${b.key}`);
    const brng = makeRng(seed);
    const isMoon = parent !== star;
    const radius = b.radius ?? planetRadius(b.cls, b.mass);
    const mu = G * b.mass;
    const e = b.orbit.e ?? 0;
    const orbit: OrbitElements = {
      a: b.orbit.a,
      e,
      i: b.orbit.i ?? (isMoon ? parent.axialTilt : 0),
      lan: b.orbit.lan ?? (isMoon || b.orbit.i === undefined ? 0 : r4(brng.range(0, TAU))),
      argp: b.orbit.argp ?? r4(brng.range(0, TAU)),
      m0: b.orbit.m0 ?? r4(brng.range(0, TAU)),
      epoch: 0,
    };
    const period = orbitalPeriod(parent.mu, orbit.a);
    const rotSeed = brng.next();
    const tiltSeed = brng.next();
    let locked: boolean;
    let rotationPeriod: number;
    if (b.rotationPeriod !== undefined) {
      rotationPeriod = b.rotationPeriod;
      locked = Math.abs(rotationPeriod - period) / period < 1e-6;
    } else {
      locked = isMoon || orbit.a < lockRadius * (isGiant(b.cls) ? 0.35 : 1);
      rotationPeriod = locked ? period : (isGiant(b.cls) ? 9 + 8 * rotSeed : 14 + 30 * rotSeed) * HOUR;
    }
    const axialTilt =
      b.axialTilt ??
      (isMoon ? orbit.i : locked ? 0 : b.rings ? (9 + 18 * tiltSeed) * DEG : isGiant(b.cls) ? 26 * tiltSeed * DEG : 28 * tiltSeed * tiltSeed * DEG);

    const albedo = b.albedo ?? ALBEDO[b.cls];
    const eqTemp = equilibriumTemperature(sp.luminosity, starDistance, albedo);
    const atmoSpec = b.atmosphere === undefined ? defaultAtmosphere(b.cls, b.mass, eqTemp, brng) : b.atmosphere;
    let temperature: number;
    if (isGiant(b.cls)) {
      const internal = b.cls === 'gasGiant' ? 95 * Math.pow(b.mass / JUPITER_MASS, 0.25) : 45;
      temperature = 1.33 * Math.pow(Math.pow(eqTemp, 4) + Math.pow(internal, 4), 0.25);
    } else {
      temperature = eqTemp + (atmoSpec?.greenhouse ?? 0);
    }
    const atmosphere = atmoSpec ? buildAtmosphere(atmoSpec, mu, radius, temperature) : null;

    const visual: BodyVisualDef = { ...defaultVisual(b.cls, seed, temperature, sp.color), ...b.visual, seed };
    const pop = stationPopAt.get(b.key) ?? 0;
    if (b.visual?.cityLights === undefined) {
      visual.cityLights = pop > 0 && !isGiant(b.cls) ? r3(clamp((Math.log10(pop) - 3.5) / 4, 0.05, 1)) : 0;
    }

    let surveyValue = b.surveyValue;
    if (surveyValue === undefined) {
      let v = SURVEY_BASE[b.cls] * clamp(Math.pow(b.mass / (isGiant(b.cls) ? 30 * EARTH_MASS : 0.3 * EARTH_MASS), 0.12), 0.5, 1.8);
      if (b.rings) v *= 1.5;
      if (atmosphere && !isGiant(b.cls)) v *= 1.25;
      if (pop > 0) v *= 0.5;
      surveyValue = Math.max(100, Math.round(v / 50) * 50);
    }

    return {
      id: bodyId(b.key),
      name: b.name,
      kind: isMoon ? 'moon' : 'planet',
      cls: b.cls,
      parentId: parent.id,
      mass: b.mass,
      radius: Math.round(radius),
      mu,
      soi: soiRadius(orbit.a, b.mass, parent.mass),
      orbit,
      rotationPeriod,
      axialTilt,
      tidallyLocked: locked,
      atmosphere,
      rings: b.rings ? ringDef(b.rings, radius, hash(`${spec.id}:${b.key}:ring`)) : null,
      star: null,
      visual,
      temperature: Math.round(temperature),
      description: b.description,
      surveyValue,
    };
  };

  const planets = spec.bodies.filter((b) => !b.parent).sort((x, y) => x.orbit.a - y.orbit.a);
  for (const p of planets) {
    const planet = makeBody(p, star, p.orbit.a);
    bodies.push(planet);
    byKey.set(p.key, planet);
    const moons = spec.bodies.filter((b) => b.parent === p.key).sort((x, y) => x.orbit.a - y.orbit.a);
    for (const m of moons) {
      const moon = makeBody(m, planet, p.orbit.a);
      bodies.push(moon);
      byKey.set(m.key, moon);
    }
  }
  for (const b of spec.bodies) {
    if (!byKey.has(b.key)) throw new Error(`${spec.id}: body ${b.key} has unknown parent ${b.parent}`);
  }
  const need = (key: string, what: string): BodyDef => {
    const b = byKey.get(key);
    if (!b) throw new Error(`${spec.id}: ${what} refers to unknown body ${key}`);
    return b;
  };

  // ---- stations
  const stations: StationDef[] = spec.stations.map((s) => {
    const parent = need(s.parent, `station ${s.key}`);
    const id = `${spec.id}.st.${s.key}`;
    const seed = hash(id);
    return {
      id,
      name: s.name,
      systemId: spec.id,
      parentBodyId: parent.id,
      orbit: {
        a: parent.radius + s.altitude,
        e: s.e ?? 0,
        i: s.i ?? parent.axialTilt,
        lan: s.lan ?? 0,
        argp: 0,
        m0: s.m0 ?? r4(makeRng(seed).range(0, TAU)),
        epoch: 0,
      },
      visualId: s.visualId,
      visualSeed: seed,
      maxPad: s.maxPad ?? PAD_BY_VISUAL[s.visualId],
      economies: s.economies,
      population: s.population,
      services: s.services ?? defaultServices(s.visualId, s.capital === true, spec.baseSecurity, s.population, s.economies),
      description: s.description,
    };
  });

  // ---- mining sites
  const miningSites: MiningSiteDef[] = spec.sites.map((s) => {
    const parent = need(s.parent, `site ${s.key}`);
    const id = `${spec.id}.site.${s.key}`;
    const seed = hash(id);
    const inRing = s.kind === 'ring';
    return {
      id,
      name: s.name,
      systemId: spec.id,
      parentBodyId: parent.id,
      orbit: {
        a: s.radius,
        e: inRing ? 0 : (s.e ?? 0),
        i: inRing ? parent.axialTilt : (s.i ?? parent.axialTilt),
        lan: inRing ? 0 : (s.lan ?? 0),
        argp: 0,
        m0: s.m0 ?? r4(makeRng(seed).range(0, TAU)),
        epoch: 0,
      },
      richness: s.richness,
      ores: s.ores,
      visualSeed: seed,
      kind: s.kind,
    };
  });

  // ---- jump beacon
  const capitalSpec = spec.stations.find((s) => s.capital) ?? spec.stations[0];
  const planetOf = (b: BodyDef): BodyDef => (b.kind === 'moon' ? (bodies.find((x) => x.id === b.parentId) ?? b) : b);
  const planetDefs = bodies.filter((b) => b.kind === 'planet');
  const candidates: BodyDef[] = [];
  if (spec.beaconBody) candidates.push(need(spec.beaconBody, 'beaconBody'));
  if (capitalSpec) candidates.push(planetOf(need(capitalSpec.parent, 'capital')));
  for (const s of spec.stations) candidates.push(planetOf(need(s.parent, 'station')));
  candidates.push(...[...planetDefs].sort((x, y) => y.mass - x.mass));
  let jumpBeacon: JumpBeaconDef | null = null;
  for (const body of candidates) {
    if (body.kind !== 'planet') continue;
    const moons = bodies.filter((b) => b.parentId === body.id);
    const occupied: [number, number][] = [];
    for (const o of [...stations, ...miningSites]) {
      if (o.parentBodyId === body.id) occupied.push([o.orbit.a * (1 - o.orbit.e), o.orbit.a * (1 + o.orbit.e)]);
    }
    const r = beaconRadius(body, moons, occupied);
    if (r !== null) {
      jumpBeacon = { bodyId: body.id, orbitRadius: r };
      break;
    }
  }
  if (!jumpBeacon) throw new Error(`${spec.id}: no planet can host a jump beacon (need SOI > ~18 radii)`);

  const capital = stations.find((_, idx) => spec.stations[idx].capital) ?? stations[0];
  void rng;
  return {
    id: spec.id,
    name: spec.name,
    pos: { x: r3(pos.x), y: r3(pos.y), z: r3(pos.z) },
    bodies,
    stations,
    miningSites,
    jumpBeacon,
    population: stations.reduce((n, s) => n + s.population, 0),
    baseSecurity: spec.baseSecurity,
    capitalStationId: capital ? capital.id : null,
    description: spec.description,
    skySeed: hash(`sky:${spec.id}`),
  };
}

// =====================================================================================
// 4. Queries
// =====================================================================================

/** The generated cluster: every static definition the rest of the simulation starts from. */
export interface GalaxyDef {
  seed: number;
  systems: SystemDef[];
  powers: PowerDef[];
  factions: FactionDef[];
  commodities: CommodityDef[];
  /** Starting influence of each faction in each inhabited system; sums to 1 per system. */
  initialPresence: { systemId: string; factionId: string; influence: number }[];
  /** Controlling faction of each inhabited system at the epoch. */
  initialControl: Record<string, string>;
  /** Owning faction of each station at the epoch (always present in the station's system, never criminal). */
  stationOwners: Record<string, string>;
  startSystemId: string;
  startStationId: string;
}

interface GalaxyIndex {
  systems: Map<string, SystemDef>;
  stations: Map<string, StationDef>;
  bodies: Map<string, BodyDef>;
  factions: Map<string, FactionDef>;
}

const INDEX = new WeakMap<GalaxyDef, GalaxyIndex>();

function indexOf(galaxy: GalaxyDef): GalaxyIndex {
  let idx = INDEX.get(galaxy);
  if (!idx) {
    idx = { systems: new Map(), stations: new Map(), bodies: new Map(), factions: new Map() };
    for (const s of galaxy.systems) {
      idx.systems.set(s.id, s);
      for (const b of s.bodies) idx.bodies.set(b.id, b);
      for (const st of s.stations) idx.stations.set(st.id, st);
    }
    for (const f of galaxy.factions) idx.factions.set(f.id, f);
    INDEX.set(galaxy, idx);
  }
  return idx;
}

/** System by id. */
export function getSystem(galaxy: GalaxyDef, systemId: string): SystemDef | undefined {
  return indexOf(galaxy).systems.get(systemId);
}

/** Body by id, searched in one system or across the galaxy. */
export function getBody(scope: GalaxyDef | SystemDef, bodyId: string): BodyDef | undefined {
  if ('bodies' in scope) return scope.bodies.find((b) => b.id === bodyId);
  return indexOf(scope).bodies.get(bodyId);
}

/** Station by id, searched in one system or across the galaxy. */
export function getStation(scope: GalaxyDef | SystemDef, stationId: string): StationDef | undefined {
  if ('stations' in scope) return scope.stations.find((s) => s.id === stationId);
  return indexOf(scope).stations.get(stationId);
}

/** Faction by id. */
export function getFaction(galaxy: GalaxyDef, factionId: string): FactionDef | undefined {
  return indexOf(galaxy).factions.get(factionId);
}

/** The primary star of a system. */
export function primaryStar(system: SystemDef): BodyDef {
  return system.bodies[0];
}

/** Bodies that orbit `bodyId` directly, in order of distance. */
export function childrenOf(system: SystemDef, bodyId: string): BodyDef[] {
  return system.bodies.filter((b) => b.parentId === bodyId).sort((x, y) => (x.orbit?.a ?? 0) - (y.orbit?.a ?? 0));
}

/** Stations orbiting `bodyId` directly. */
export function stationsAt(system: SystemDef, bodyId: string): StationDef[] {
  return system.stations.filter((s) => s.parentBodyId === bodyId);
}

/** Factions present in a system at the epoch, strongest first. */
export function factionsIn(galaxy: GalaxyDef, systemId: string): { faction: FactionDef; influence: number }[] {
  const idx = indexOf(galaxy);
  return galaxy.initialPresence
    .filter((p) => p.systemId === systemId)
    .map((p) => ({ faction: idx.factions.get(p.factionId) as FactionDef, influence: p.influence }))
    .sort((x, y) => y.influence - x.influence);
}

/** Distance between two systems (or two map positions), light-years. */
export function systemDistance(a: SystemDef | V3, b: SystemDef | V3): number {
  const pa = 'pos' in a ? a.pos : a;
  const pb = 'pos' in b ? b.pos : b;
  return Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
}

/** Other systems within `rangeLy` of `systemId`, nearest first. */
export function systemsWithin(galaxy: GalaxyDef, systemId: string, rangeLy: number): { system: SystemDef; distance: number }[] {
  const from = getSystem(galaxy, systemId);
  if (!from) return [];
  const out: { system: SystemDef; distance: number }[] = [];
  for (const s of galaxy.systems) {
    if (s.id === systemId) continue;
    const d = systemDistance(from, s);
    if (d <= rangeLy) out.push({ system: s, distance: d });
  }
  return out.sort((x, y) => x.distance - y.distance);
}

/**
 * Route between two systems using hops no longer than `jumpRangeLy`: fewest jumps, ties broken by
 * total distance. Returns the system ids from `fromId` to `toId` inclusive, or null if unreachable.
 */
export function shortestRoute(galaxy: GalaxyDef, fromId: string, toId: string, jumpRangeLy: number): string[] | null {
  const idx = indexOf(galaxy);
  if (!idx.systems.has(fromId) || !idx.systems.has(toId)) return null;
  if (fromId === toId) return [fromId];
  const HOP = 1e4; // dominates any distance in the cluster, so jump count is minimised first
  const cost = new Map<string, number>([[fromId, 0]]);
  const prev = new Map<string, string>();
  const open = new Set<string>([fromId]);
  const done = new Set<string>();
  while (open.size > 0) {
    let cur = '';
    let best = Infinity;
    for (const id of open) {
      const c = cost.get(id) as number;
      if (c < best || (c === best && id < cur)) {
        best = c;
        cur = id;
      }
    }
    if (cur === toId) break;
    open.delete(cur);
    done.add(cur);
    const here = idx.systems.get(cur) as SystemDef;
    for (const s of galaxy.systems) {
      if (done.has(s.id)) continue;
      const d = systemDistance(here, s);
      if (d > jumpRangeLy) continue;
      const c = best + HOP + d;
      if (c < (cost.get(s.id) ?? Infinity)) {
        cost.set(s.id, c);
        prev.set(s.id, cur);
        open.add(s.id);
      }
    }
  }
  if (!prev.has(toId)) return null;
  const route = [toId];
  let at = toId;
  while (at !== fromId) {
    at = prev.get(at) as string;
    route.push(at);
  }
  return route.reverse();
}

export interface AltitudeBands {
  /** Body radius (surface, or the 1-bar level of giants), m. All fields are radii from the body's centre. */
  surface: number;
  /** Top of the sensible atmosphere (equals `surface` for vacuum worlds). */
  atmosphereTop: number;
  /** Recommended low parking band. */
  lowOrbit: [number, number];
  /** Ring extent, if any. */
  ring: [number, number] | null;
  /** Closest a rubble-pile moon could hold together. */
  rocheLimit: number;
  /** Jump drives only engage beyond this radius (8 body radii). */
  jumpClear: number;
  /** Largest long-term-stable apoapsis for satellites: min(0.4 Hill, 0.5 SOI). Infinity for the primary. */
  stableLimit: number;
  /** Sphere of influence. */
  soi: number;
}

/** Characteristic orbital radii around a body: where the air ends, where to park, where it is safe to jump. */
export function bodyAltitudeBands(system: SystemDef, bodyId: string): AltitudeBands | undefined {
  const body = getBody(system, bodyId);
  if (!body) return undefined;
  const parent = body.parentId ? getBody(system, body.parentId) : undefined;
  return {
    surface: body.radius,
    atmosphereTop: body.radius + (body.atmosphere?.height ?? 0),
    lowOrbit: lowOrbitBand(body),
    ring: body.rings ? [body.rings.innerRadius, body.rings.outerRadius] : null,
    rocheLimit: rocheLimit(body.radius, meanDensity(body.mass, body.radius), RUBBLE_DENSITY),
    jumpClear: 8 * body.radius,
    stableLimit: stableOrbitLimit(body, parent),
    soi: body.soi,
  };
}

/**
 * Patched-conic estimate of the delta-v to fly from one station to another in the same system, m/s:
 * a Hohmann transfer at the level of their common ancestor, with departure and capture burns made
 * deep in each gravity well (Oberth effect included). Plane changes are added at the slower orbit
 * for stations sharing a parent. Good to ~10-20 % for pricing trips; the flight computer does the
 * real planning.
 */
export function estimateTransferDv(system: SystemDef, fromStationId: string, toStationId: string): number | undefined {
  const A = getStation(system, fromStationId);
  const B = getStation(system, toStationId);
  if (!A || !B) return undefined;
  if (A.id === B.id) return 0;
  const byId = new Map(system.bodies.map((b) => [b.id, b]));
  const chain = (s: StationDef): BodyDef[] => {
    const out: BodyDef[] = [];
    let b = byId.get(s.parentBodyId);
    while (b) {
      out.push(b);
      b = b.parentId ? byId.get(b.parentId) : undefined;
    }
    return out; // station's parent first, primary star last
  };
  const ca = chain(A);
  const cb = chain(B);
  const common = ca.find((b) => cb.includes(b));
  if (!common) return undefined;
  const ia = ca.indexOf(common);
  const ib = cb.indexOf(common);
  // Radius of each side's orbit around the common ancestor.
  const ra = ia === 0 ? A.orbit.a : (ca[ia - 1].orbit as OrbitElements).a;
  const rb = ib === 0 ? B.orbit.a : (cb[ib - 1].orbit as OrbitElements).a;
  const mu = common.mu;
  const at = (ra + rb) / 2;
  const burnAt = (r: number): number => (ra === rb ? 0 : Math.abs(Math.sqrt(mu * (2 / r - 1 / at)) - Math.sqrt(mu / r)));
  // Convert a hyperbolic excess relative to chain[level] into a burn at the station, descending the chain.
  const descend = (c: BodyDef[], level: number, vInf: number, station: StationDef): number => {
    let v = vInf;
    for (let k = level; k >= 0; k--) {
      const body = c[k];
      const r = k === 0 ? station.orbit.a : (c[k - 1].orbit as OrbitElements).a;
      const vp = Math.sqrt(v * v + (2 * body.mu) / r);
      v = vp - Math.sqrt(body.mu / r);
    }
    return v;
  };
  let dv = 0;
  dv += ia === 0 ? burnAt(ra) : descend(ca, ia - 1, burnAt(ra), A);
  dv += ib === 0 ? burnAt(rb) : descend(cb, ib - 1, burnAt(rb), B);
  if (ia === 0 && ib === 0) {
    // Same parent: add the plane change, made at the higher (slower) orbit.
    const n = (o: OrbitElements): V3 => ({ x: Math.sin(o.i) * Math.sin(o.lan), y: Math.cos(o.i), z: Math.sin(o.i) * Math.cos(o.lan) });
    const na = n(A.orbit);
    const nb = n(B.orbit);
    const rel = Math.acos(clamp(na.x * nb.x + na.y * nb.y + na.z * nb.z, -1, 1));
    dv += 2 * Math.sqrt(mu / Math.max(ra, rb)) * Math.sin(rel / 2);
  }
  return dv;
}
