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
import { NAME_THEMES, factionName, pickStarName, roman, siteName, slug, stationName, type NameTheme } from '../data/names';
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
/** Brightest surface colour channel allowed in a body palette (linear). */
const MAX_ALBEDO = 0.9;
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

interface SkyTint {
  color: RGB;
  sunsetColor: RGB;
}
const sky = (day: string, sunset: string): SkyTint => ({ color: hexToLinear(day), sunsetColor: hexToLinear(sunset) });

/**
 * Sky tints (day-side scattering colour, sunset colour) by kind of air; a world is dealt one of the
 * alternatives. Rayleigh skies are blue with warm sunsets; dust-laden skies are tan with blue sunsets
 * (forward scattering by fine dust), hazes take the colour of their aerosol.
 */
const AIR: Record<'breathable' | 'dusty' | 'thin' | 'vapour' | 'haze' | 'hydrogenWarm' | 'hydrogenHot' | 'methane', readonly SkyTint[]> = {
  breathable: [sky('#6C9CF0', '#FF8A4A'), sky('#5FA6E6', '#FF9E5C'), sky('#7C8FEA', '#FF7462'), sky('#62B0D8', '#F6A24E')],
  dusty: [sky('#D9B27C', '#7FA6D9'), sky('#E2C48E', '#8CB4DE'), sky('#CC9A78', '#7898D2'), sky('#D8BCA0', '#94A8D0')],
  thin: [sky('#C9A27E', '#6F93C9'), sky('#B8A890', '#7C9CCC'), sky('#D0947A', '#6888C4')],
  vapour: [sky('#FF9A4D', '#FF5A2A'), sky('#F2B45C', '#E8642C'), sky('#E88860', '#C8402C')],
  haze: [sky('#E0A050', '#B8642C'), sky('#8098C0', '#C8D4EA'), sky('#D4B078', '#A0704C')],
  hydrogenWarm: [sky('#E8D8B8', '#F0B070'), sky('#E0D0C0', '#E8A888'), sky('#DCDCC4', '#ECC078')],
  hydrogenHot: [sky('#86AEE6', '#E8C0A0'), sky('#7098D8', '#D8B0B0')],
  methane: [sky('#8FD8E8', '#D8F2F0'), sky('#84B8EC', '#D0E4F6'), sky('#98E0D0', '#E0F4E8')],
};

/** Class-default atmosphere for a body whose spec leaves it open. Deterministic in `rng`. */
function defaultAtmosphere(cls: BodyClass, mass: number, eqTemp: number, rng: Rng): AtmosphereSpec | null {
  switch (cls) {
    case 'terran':
    case 'eyeball': {
      const p = rng.range(0.7, 1.4) * 1e5;
      return { pressure: p, molarMass: 0.02897, ...rng.pick(AIR.breathable), opacity: 0.55, greenhouse: 30 * Math.pow(p / 1e5, 0.4) };
    }
    case 'ocean': {
      const p = rng.range(0.9, 1.8) * 1e5;
      return { pressure: p, molarMass: 0.0275, ...rng.pick(AIR.breathable), opacity: 0.65, greenhouse: 32 * Math.pow(p / 1e5, 0.4) };
    }
    case 'desert': {
      const p = rng.range(0.25, 1.6) * 1e5;
      return { pressure: p, molarMass: 0.038, ...rng.pick(AIR.dusty), opacity: r3(0.3 + 0.2 * Math.min(1, p / 1e5)), greenhouse: 22 * Math.sqrt(p / 1e5) };
    }
    case 'rocky': {
      const p = rng.range(400, 4000);
      return { pressure: p, molarMass: 0.0435, ...rng.pick(AIR.thin), opacity: r3(0.1 + p / 4e4), greenhouse: 4 };
    }
    case 'lava': {
      if (rng.chance(0.4)) return null;
      return { pressure: rng.range(40, 400), molarMass: 0.05, ...rng.pick(AIR.vapour), opacity: 0.1, greenhouse: 0 };
    }
    case 'ice': {
      // Only large, cold ice worlds hold a dense nitrogen-methane haze; the rest are bare.
      if (mass >= 0.018 * EARTH_MASS && eqTemp < 110 && rng.chance(0.3)) {
        return { pressure: rng.range(0.6, 1.5) * 1e5, molarMass: 0.028, ...rng.pick(AIR.haze), opacity: r3(rng.range(0.7, 0.92)), greenhouse: 9 };
      }
      return null;
    }
    case 'gasGiant':
      return {
        pressure: 1e5,
        molarMass: 0.0023,
        ...rng.pick(eqTemp > 330 ? AIR.hydrogenHot : AIR.hydrogenWarm),
        opacity: 0.6,
        scoopable: true,
      };
    case 'iceGiant':
      return { pressure: 1e5, molarMass: 0.0026, ...rng.pick(AIR.methane), opacity: 0.55, scoopable: true };
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
    hexes('#3a3020', '#6e5c38', '#a08a58', '#cdbd8c'), // sulphur-stained
    hexes('#2e1c18', '#5c3428', '#8a5a48', '#b89480'), // iron-red regolith
    hexes('#4a4a48', '#7e7c76', '#aeaba2', '#d6d2c8'), // pale anorthosite highlands
  ],
  rocky: [
    hexes('#43291e', '#74452f', '#a36a46', '#cc9c74'),
    hexes('#3a3028', '#6a5a48', '#9a8466', '#c8b592'),
    hexes('#33272a', '#5e4347', '#8c6660', '#b99a86'),
    hexes('#2a2c30', '#4c5058', '#7c7870', '#b0a48c'), // slate basalt under ochre dust
    hexes('#40321a', '#74592c', '#a8884a', '#d0b880'), // yellow ochre
    hexes('#2c2e22', '#505238', '#807c58', '#b0a888'), // olive, sulphide-weathered
  ],
  desert: [
    hexes('#553c23', '#946635', '#c49557', '#e3cb9c'),
    hexes('#5c2f1e', '#9a5230', '#c98852', '#e8c79a'),
    hexes('#4d4530', '#857a50', '#b8ab78', '#e0d7ae'),
    hexes('#5e3a34', '#9c6456', '#cc9c88', '#eedcd0'), // rose rock and white salt
    hexes('#2a2422', '#5a4a40', '#a48c6c', '#dcc8a0'), // black basalt, pale dune seas
    hexes('#4a1e14', '#883a22', '#b8643c', '#dca070'), // deep rust
  ],
  lava: [
    hexes('#0f0908', '#241410', '#402015', '#6e3519'),
    hexes('#0b0b0d', '#1e1a1c', '#3a2a26', '#5e3a2a'),
    hexes('#140c06', '#3b2a10', '#6e5318', '#a8862e'),
    hexes('#0a0c10', '#181c24', '#2c2e38', '#4a4448'), // blue-black glass
    hexes('#120806', '#2e120c', '#52200f', '#863c18'), // oxidised crust
  ],
  ice: [
    hexes('#7b90a6', '#b5c5d4', '#dbe6ee', '#f2f6fa'),
    hexes('#66584e', '#a59f98', '#d5d9dc', '#eef2f5'),
    hexes('#5d7f96', '#93b8c9', '#c9e0e8', '#eef7f9'),
    hexes('#7a5a50', '#b89484', '#e0ccc0', '#f4ece6'), // tholin-pink nitrogen ice
    hexes('#5a8c8c', '#94c4bc', '#cce6dc', '#f0f8f2'), // methane frost
    hexes('#4c5054', '#868c90', '#bcc2c6', '#e6eaec'), // dirty grey
  ],
  ocean: [
    hexes('#0a2644', '#12456c', '#2b6887', '#d4cdaa'),
    hexes('#0b2e3a', '#14566a', '#3a7f86', '#cfc9a8'),
    hexes('#10203f', '#243f73', '#4a6a94', '#c9bfa6'),
    hexes('#08303a', '#0e5560', '#2f8a84', '#d8d2b0'), // shallow teal seas
    hexes('#0c1840', '#1c3070', '#44609c', '#c4bca8'), // deep indigo
  ],
  terran: [
    hexes('#1d3927', '#3b6536', '#858556', '#b49f78', '#e4e0d8'),
    hexes('#26341f', '#56683a', '#97895a', '#b7a184', '#e6e2da'),
    hexes('#2b2f1c', '#6b6a34', '#a58a4e', '#bf9f7c', '#e8e2d4'),
    hexes('#34361c', '#70702e', '#b09448', '#c8a878', '#ece6d8'), // ochre savannah
    hexes('#182c26', '#2e5240', '#6c7c5a', '#a09880', '#e2e4e0'), // cool boreal
  ],
  // Under red-dwarf light photosynthesis runs dark: terminator vegetation is near black.
  eyeball: [
    hexes('#262320', '#36372a', '#564733', '#877558', '#d4ccbc'),
    hexes('#231f24', '#3a2f36', '#5a4a44', '#8a7864', '#d6cec2'),
    hexes('#1d2622', '#2c3d33', '#55523a', '#8c7c5c', '#d8d2c4'),
    hexes('#2a1c18', '#44302a', '#6a4c38', '#94785a', '#d8ccb8'), // rust dusk
    hexes('#161c26', '#243442', '#4a5248', '#847a60', '#d2d0c6'), // blue-black mats
  ],
  iceGiant: [
    hexes('#5ab0c4', '#7acbd4', '#4695b3', '#a3dce2'),
    hexes('#2c5aa8', '#467ac8', '#3665b8', '#7aa3e2'),
    hexes('#4fa38e', '#74c4a8', '#3f8a80', '#a6dcc8'),
    hexes('#6f7fb8', '#8f9fd0', '#5a68a0', '#b9c4e4'),
    hexes('#1f5c66', '#2f8088', '#17474f', '#63aaa8'), // deep teal
    hexes('#a8cfe0', '#c4e0ea', '#8cbcd4', '#e0f0f4'), // pale high haze
  ],
};

const GAS_PALETTES = {
  hot: [
    hexes('#254568', '#386a9a', '#1b314c', '#5589b8', '#2e5580'),
    hexes('#2a5560', '#3f8088', '#1c3a44', '#6aa6a8', '#d8e2e0'),
    hexes('#3a1c24', '#5c2c34', '#24121a', '#84444a', '#482028'), // alkali-dark maroon
  ],
  warm: [
    hexes('#c4ab85', '#a37b58', '#e1d3b3', '#85664d', '#d4bd95'),
    hexes('#b98f6a', '#8c5a3e', '#dcc3a0', '#6e4a38', '#c9a67c'),
    hexes('#c9a08c', '#a8705c', '#e6cdb8', '#7f5648', '#d8b49c'),
    hexes('#d8ccb4', '#8f8f98', '#ece4d2', '#6f7684', '#bdb09a'),
    hexes('#b8a868', '#8c7c44', '#d8cc98', '#6c6038', '#c8b87c'), // olive gold
    hexes('#9cb0a8', '#6c8880', '#d4dcd0', '#4c6460', '#b8c4b8'), // slate green and cream
  ],
  cold: [
    hexes('#d3c49b', '#bda87c', '#e4dabb', '#ab956c', '#cbb98c'),
    hexes('#c8bfae', '#a89c88', '#ddd6c6', '#8f8474', '#b9ae9a'),
    hexes('#b7a9c4', '#9485a8', '#d2c8dc', '#7a6c90', '#a698b8'),
    hexes('#c2c49c', '#9ea078', '#dcdcbc', '#84865e', '#b4b68c'),
    hexes('#a8b8c8', '#8498ac', '#ccd8e0', '#687c94', '#98a8bc'), // ammonia-haze blue grey
  ],
};

/**
 * A palette shifted a little in brightness and warmth, so that two worlds dealt the same base
 * palette still look like different places. Albedos stay plausible (channels capped at 0.9).
 */
function tintPalette(palette: readonly RGB[], rng: Rng, amount = 1): RGB[] {
  const gain = 1 + amount * rng.range(-0.12, 0.1);
  const warm = amount * rng.range(-0.07, 0.07);
  const green = amount * rng.range(-0.03, 0.03);
  return palette.map(([r, g, b]) => [
    r4(clamp(r * gain * (1 + warm), 0, MAX_ALBEDO)),
    r4(clamp(g * gain * (1 + green), 0, MAX_ALBEDO)),
    r4(clamp(b * gain * (1 - warm), 0, MAX_ALBEDO)),
  ]);
}

/** Seeded class-default look for a body. Spec `visual` fields override these. */
function defaultVisual(cls: BodyClass, seed: number, temperature: number, starColor: RGB): BodyVisualDef {
  const v = baseVisual(cls, seed, temperature, starColor);
  if (cls !== 'star') v.palette = tintPalette(v.palette, makeRng(hash(`${seed}:tint`)));
  return v;
}

function baseVisual(cls: BodyClass, seed: number, temperature: number, starColor: RGB): BodyVisualDef {
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
 * rings, moons (their SOIs and 9 of their radii) and anything else already orbiting there. Returns
 * null if no gap fits.
 */
function beaconRadius(body: BodyDef, moons: BodyDef[], occupied: [number, number][]): number | null {
  const lo = Math.max(8.5 * body.radius, (body.rings?.outerRadius ?? 0) * 1.1);
  const hi = 0.47 * body.soi;
  if (!(hi > lo * 1.02)) return null;
  const bands: [number, number][] = occupied.map(([a, b]) => [a * 0.96, b * 1.04]);
  for (const m of moons) {
    if (!m.orbit) continue;
    // Clear of the moon's SOI, and of the 8 radii inside which a jump drive will not engage.
    const clear = Math.max(1.6 * m.soi, 9 * m.radius);
    bands.push([m.orbit.a * (1 - m.orbit.e) - clear, m.orbit.a * (1 + m.orbit.e) + clear]);
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
    let atmoSpec = b.atmosphere === undefined ? defaultAtmosphere(b.cls, b.mass, eqTemp, brng) : b.atmosphere;
    if (atmoSpec && b.atmosphere === undefined) {
      // No two skies quite alike: shift the class tint a little per world.
      const [color, sunsetColor] = tintPalette([atmoSpec.color, atmoSpec.sunsetColor], makeRng(hash(`${seed}:air`)), 0.9);
      atmoSpec = { ...atmoSpec, color, sunsetColor };
    }
    let temperature: number;
    if (isGiant(b.cls)) {
      const internal = b.cls === 'gasGiant' ? 95 * Math.pow(b.mass / JUPITER_MASS, 0.25) : 45;
      temperature = 1.33 * Math.pow(Math.pow(eqTemp, 4) + Math.pow(internal, 4), 0.25);
    } else {
      temperature = eqTemp + (atmoSpec?.greenhouse ?? 0);
    }
    const atmosphere = atmoSpec ? buildAtmosphere(atmoSpec, mu, radius, temperature) : null;

    const visual: BodyVisualDef = { ...defaultVisual(b.cls, seed, temperature, sp.color), ...b.visual, seed };
    // Nothing solid reflects more than fresh snow: cap albedos so sunlit surfaces stay inside the HDR budget.
    visual.palette = visual.palette.map(([r, g, bl]): RGB => [Math.min(r, MAX_ALBEDO), Math.min(g, MAX_ALBEDO), Math.min(bl, MAX_ALBEDO)]);
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
        a: Math.round(s.orbitRadii !== undefined ? s.orbitRadii * parent.radius : parent.radius + (parent.atmosphere?.height ?? 0) + s.altitude),
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
        a: Math.round(s.radii !== undefined ? s.radii * parent.radius : s.radius),
        e: inRing ? 0 : (s.e ?? 0),
        i: inRing ? parent.axialTilt : (s.i ?? parent.axialTilt),
        lan: inRing ? 0 : (s.lan ?? 0),
        argp: inRing ? 0 : (s.argp ?? 0),
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

// =====================================================================================
// 5. Validation
// =====================================================================================

/**
 * Physical sanity checks on a built system; returns a list of problems (empty when sound).
 * The generator uses it to reject a bad roll, and the tests run it over every system.
 */
export function validateSystem(system: SystemDef): string[] {
  const problems: string[] = [];
  const say = (m: string): void => {
    problems.push(`${system.id}: ${m}`);
  };
  const byId = new Map<string, BodyDef>();
  const topOf = (b: BodyDef): number => b.radius + (b.atmosphere?.height ?? 0);
  system.bodies.forEach((b, idx) => {
    if (byId.has(b.id)) say(`duplicate body id ${b.id}`);
    if (Math.abs(b.mu - G * b.mass) > 1e-9 * b.mu) say(`${b.id}: mu is not G*mass`);
    if (b.rings && !isGiant(b.cls) && b.kind !== 'star') say(`${b.id}: rings on a body that is not a giant`);
    if (idx === 0) {
      if (b.kind !== 'star' || b.parentId !== null || b.orbit !== null) say('first body must be the primary star');
      byId.set(b.id, b);
      return;
    }
    const parent = b.parentId ? byId.get(b.parentId) : undefined;
    if (!parent || !b.orbit) {
      say(`${b.id}: parent does not precede it`);
      byId.set(b.id, b);
      return;
    }
    const peri = b.orbit.a * (1 - b.orbit.e);
    const apo = b.orbit.a * (1 + b.orbit.e);
    const roche = rocheLimit(parent.radius, meanDensity(parent.mass, parent.radius), parent.kind === 'star' ? meanDensity(b.mass, b.radius) : RUBBLE_DENSITY);
    if (peri < roche) say(`${b.id}: orbits inside the Roche limit of ${parent.id}`);
    if (peri < topOf(parent) + b.radius) say(`${b.id}: periapsis inside ${parent.id}`);
    if (parent.rings && peri < parent.rings.outerRadius) say(`${b.id}: orbits inside the rings of ${parent.id}`);
    if (parent.kind !== 'star') {
      if (apo >= 0.5 * parent.soi) say(`${b.id}: apoapsis beyond half the SOI of ${parent.id}`);
      const grand = parent.parentId ? byId.get(parent.parentId) : undefined;
      if (grand && parent.orbit && apo > 0.4 * hillRadius(parent.orbit.a, parent.orbit.e, parent.mass, grand.mass)) {
        say(`${b.id}: apoapsis beyond 0.4 Hill radii of ${parent.id}`);
      }
      if (Math.abs(b.soi - soiRadius(b.orbit.a, b.mass, parent.mass)) > 1e-9 * b.soi) say(`${b.id}: SOI is not a*(m/M)^0.4`);
    }
    if (b.rings) {
      const rocheIce = rocheLimit(b.radius, meanDensity(b.mass, b.radius), RING_ICE_DENSITY);
      if (b.rings.outerRadius > rocheIce) say(`${b.id}: rings extend beyond the Roche limit`);
      if (b.rings.innerRadius < topOf(b)) say(`${b.id}: rings dip into the atmosphere`);
    }
    byId.set(b.id, b);
  });
  // Neighbouring planets at least five mutual Hill radii apart (periapsis to apoapsis).
  const star = system.bodies[0];
  const planets = system.bodies.filter((b) => b.kind === 'planet' && b.orbit).sort((x, y) => (x.orbit as OrbitElements).a - (y.orbit as OrbitElements).a);
  for (let k = 0; k + 1 < planets.length; k++) {
    const p = planets[k];
    const q = planets[k + 1];
    const po = p.orbit as OrbitElements;
    const qo = q.orbit as OrbitElements;
    const mutual = Math.cbrt((p.mass + q.mass) / (3 * star.mass)) * 0.5 * (po.a + qo.a);
    const gap = qo.a * (1 - qo.e) - po.a * (1 + po.e);
    if (gap < 5 * mutual) say(`${p.id} and ${q.id} are only ${(gap / mutual).toFixed(1)} mutual Hill radii apart`);
  }
  for (const o of [...system.stations, ...system.miningSites]) {
    const parent = byId.get(o.parentBodyId);
    if (!parent) {
      say(`${o.id}: unknown parent ${o.parentBodyId}`);
      continue;
    }
    const peri = o.orbit.a * (1 - o.orbit.e);
    const apo = o.orbit.a * (1 + o.orbit.e);
    if (peri < topOf(parent) + 20e3) say(`${o.id}: periapsis inside the atmosphere of ${parent.id}`);
    if (parent.kind !== 'star' && apo >= 0.5 * parent.soi) say(`${o.id}: apoapsis beyond half the SOI of ${parent.id}`);
    if ('kind' in o && o.kind === 'ring') {
      if (!parent.rings || o.orbit.a < parent.rings.innerRadius || o.orbit.a > parent.rings.outerRadius) say(`${o.id}: ring site outside the rings`);
    } else if (parent.rings && peri < parent.rings.outerRadius && apo > parent.rings.innerRadius && parent.kind !== 'star') {
      say(`${o.id}: orbit crosses the rings of ${parent.id}`);
    }
    for (const m of system.bodies) {
      if (m.parentId !== parent.id || !m.orbit || parent.kind === 'star') continue;
      if (peri < m.orbit.a * (1 + m.orbit.e) + m.soi && apo > m.orbit.a * (1 - m.orbit.e) - m.soi) say(`${o.id}: orbit crosses the SOI of ${m.id}`);
    }
  }
  const beaconBody = byId.get(system.jumpBeacon.bodyId);
  if (!beaconBody) say('jump beacon orbits an unknown body');
  else if (system.jumpBeacon.orbitRadius <= 8 * beaconBody.radius || system.jumpBeacon.orbitRadius >= 0.5 * beaconBody.soi) {
    say('jump beacon is not between 8 radii and half the SOI');
  }
  return problems;
}

// =====================================================================================
// 6. Procedural systems
// =====================================================================================

interface MoonDraft {
  name: string;
  key: string;
  cls: BodyClass;
  mass: number;
  radius: number;
  a: number;
  e: number;
  /** Largest stable orbit radius around the moon, m. */
  limit: number;
}

interface PlanetDraft {
  name: string;
  key: string;
  cls: BodyClass;
  mass: number;
  radius: number;
  a: number;
  e: number;
  i: number;
  lan: number;
  argp: number;
  m0: number;
  /** Stellar flux, Earth = 1. */
  flux: number;
  /** Largest stable orbit radius around the planet, m. */
  limit: number;
  rings?: RingSpec;
  moons: MoonDraft[];
}

/** A body a station could orbit. */
interface Host {
  key: string;
  name: string;
  cls: BodyClass;
  mass: number;
  radius: number;
  limit: number;
  planet: PlanetDraft;
  moon: MoonDraft | null;
}

const STAR_MASS_RANGE: Record<StarHint, [number, number]> = {
  M: [0.19, 0.46],
  Mlate: [0.13, 0.19],
  K: [0.62, 0.8],
  G: [0.9, 1.05],
  F: [1.15, 1.32],
  brownDwarf: [0.045, 0.07],
};

const RING_LOOKS: { color: RGB; opacity: [number, number] }[] = [
  { color: hexToLinear('#d9d4c8'), opacity: [0.7, 0.9] },
  { color: hexToLinear('#c2b08f'), opacity: [0.5, 0.75] },
  { color: hexToLinear('#9a9aa2'), opacity: [0.35, 0.55] },
  { color: hexToLinear('#c9a898'), opacity: [0.4, 0.6] },
  { color: hexToLinear('#565a66'), opacity: [0.3, 0.45] },
];

type OreTable = [string, number][];
const ORE_TABLES: Record<'ringCold' | 'ringWarm' | 'beltHot' | 'beltMid' | 'beltCold' | 'swarm', OreTable> = {
  ringCold: [['water_ice', 5.5], ['cryovolatiles', 3], ['silicate_ore', 1], ['lanthanide_ore', 0.3]],
  ringWarm: [['silicate_ore', 4], ['water_ice', 2.5], ['ferronickel_ore', 2], ['ilmenite', 0.6]],
  beltHot: [['ferronickel_ore', 4], ['silicate_ore', 3], ['ilmenite', 2], ['platinoid_ore', 0.6]],
  beltMid: [['silicate_ore', 4], ['ferronickel_ore', 3], ['ilmenite', 1.5], ['lanthanide_ore', 1], ['uraninite', 0.5]],
  beltCold: [['silicate_ore', 3], ['water_ice', 3], ['cryovolatiles', 1.5], ['lanthanide_ore', 1], ['uraninite', 0.7]],
  swarm: [['ferronickel_ore', 3], ['silicate_ore', 3], ['platinoid_ore', 0.8], ['uraninite', 0.8]],
};

function oreMix(table: OreTable, rng: Rng): { commodityId: string; weight: number }[] {
  const rows = table.length > 3 && rng.chance(0.3) ? table.slice(0, -1) : table;
  return rows.map(([commodityId, w]) => ({ commodityId, weight: Math.max(0.1, Math.round(w * rng.range(0.7, 1.3) * 10) / 10) }));
}

const round2sig = (x: number): number => {
  const p = Math.pow(10, Math.floor(Math.log10(x)) - 1);
  return Math.round(x / p) * p;
};
const logRange = (rng: Rng, lo: number, hi: number): number => Math.exp(rng.range(Math.log(lo), Math.log(hi)));
const HABITABLE: readonly BodyClass[] = ['eyeball', 'terran', 'ocean'];

function rockyClass(flux: number, mass: number, locked: boolean, rng: Rng, habChance: number): BodyClass {
  const m = mass / EARTH_MASS;
  // Rock at the noon point of a locked world melts at about 110 times Earth's sunlight (1,250 K).
  if (flux > 110) return m >= 0.08 ? 'lava' : 'barren';
  if (flux > 6) return m >= 0.45 && rng.chance(0.4) ? 'desert' : 'barren';
  if (flux > 1.75) return m >= 0.4 ? (rng.chance(0.65) ? 'desert' : 'rocky') : m >= 0.15 && rng.chance(0.5) ? 'rocky' : 'barren';
  if (flux > 0.32) {
    if (m >= 0.35 && flux >= 0.4 && flux <= 1.45 && rng.chance(habChance)) return locked ? 'eyeball' : rng.chance(0.6) ? 'terran' : 'ocean';
    return m >= 0.5 && flux > 0.9 ? 'desert' : m >= 0.1 ? 'rocky' : 'barren';
  }
  if (flux > 0.11) return m >= 0.1 ? (rng.chance(0.6) ? 'rocky' : 'ice') : rng.chance(0.5) ? 'ice' : 'barren';
  return m < 0.02 && rng.chance(0.2) ? 'barren' : 'ice';
}

/** Lay out the planets of a generated system: masses, classes and Hill-spaced orbits (unnamed). */
function draftPlanets(slot: GalaxySlot, starMass: number, sp: StarPhysics, rng: Rng): PlanetDraft[] {
  const M = starMass;
  const bright = slot.star === 'K' || slot.star === 'G' || slot.star === 'F';
  const dim = slot.star === 'brownDwarf';
  const aHZ = AU * Math.sqrt(sp.luminosity);
  const lock = tidalLockRadius(M);
  const aMin = Math.max(1.7 * rocheLimit(sp.radius, meanDensity(M, sp.radius), 4500), 3.5 * sp.radius);
  const fluxAt = (a: number): number => stellarFlux(sp.luminosity, a);
  const rockyMass = (): number => logRange(rng, 0.06, 3.2) * EARTH_MASS;
  /** Ratio of neighbouring semi-major axes for a separation of K mutual Hill radii. */
  const ratio = (m1: number, m2: number, K: number): number => {
    const k = Math.min(0.78, (K / 2) * Math.cbrt((m1 + m2) / (3 * M)));
    return (1 + k) / (1 - k);
  };
  const smallK = (): number => 12 + 44 * Math.pow(rng.next(), 2);
  const giantK = (): number => rng.range(9.5, 13);
  const giantMass = (): { cls: BodyClass; mass: number } => {
    if (dim || rng.chance(bright ? 0.35 : 0.45)) return { cls: 'iceGiant', mass: rng.range(7, 24) * EARTH_MASS };
    return { cls: 'gasGiant', mass: (bright ? logRange(rng, 0.3, 2.2) : logRange(rng, 0.12, 0.9)) * JUPITER_MASS };
  };

  interface Seed {
    a: number;
    mass: number;
    cls?: BodyClass;
  }
  const seeds: Seed[] = [];
  const target = dim ? rng.int(3, 5) : rng.int(4, 7);
  const wantGiants = slot.world === 'ice' || rng.chance(0.72) ? (rng.chance(0.3) ? 2 : 1) : 0;
  const anchored = slot.world === 'eyeball' || slot.world === 'garden';

  if (anchored) {
    // The inhabited world first, in the habitable zone; then the worlds sunward of it.
    let a = aHZ / Math.sqrt(rng.range(0.62, 1.15));
    if (slot.world === 'garden' && a < lock * 1.04 && fluxAt(lock * 1.04) >= 0.45) a = lock * 1.04;
    const cls: BodyClass = a < lock ? 'eyeball' : rng.chance(0.62) ? 'terran' : 'ocean';
    let prev: Seed = { a, mass: rng.range(0.6, 2.2) * EARTH_MASS, cls };
    seeds.push(prev);
    const nIn = rng.int(1, bright ? 2 : 3);
    for (let j = 0; j < nIn; j++) {
      const mass = rockyMass();
      const a2 = prev.a / ratio(mass, prev.mass, smallK());
      if (a2 < aMin) break;
      prev = { a: a2, mass };
      seeds.unshift(prev);
    }
  } else {
    const fluxIn = dim ? rng.range(1.5, 6) : logRange(rng, 10, 300);
    seeds.push({ a: Math.max(aMin * rng.range(1, 1.4), aHZ / Math.sqrt(fluxIn)), mass: rockyMass() });
  }

  const fluxMin = bright ? 0.004 : 0.0025;
  let giants = 0;
  let prev = seeds[seeds.length - 1];
  while (seeds.length < target) {
    let mass = rockyMass();
    let a = prev.a * ratio(mass, prev.mass, prev.cls && isGiant(prev.cls) ? giantK() : smallK());
    let cls: BodyClass | undefined;
    if (fluxAt(a) < 0.12 && giants < wantGiants && rng.chance(0.6)) {
      const g = giantMass();
      cls = g.cls;
      mass = g.mass;
      a = Math.max(a, prev.a * ratio(mass, prev.mass, giantK()));
      giants++;
    }
    if (fluxAt(a) < fluxMin) break;
    prev = { a, mass, cls };
    seeds.push(prev);
  }
  if (giants === 0 && wantGiants > 0) {
    const g = giantMass();
    const a = Math.max(prev.a * ratio(g.mass, prev.mass, giantK()), (aHZ / Math.sqrt(0.12)) * rng.range(1.05, 1.5));
    prev = { a, mass: g.mass, cls: g.cls };
    seeds.push(prev);
  }
  // Somewhere for the jump beacon: a planet whose SOI reaches well past 8 radii.
  const beaconFits = (s: Seed): boolean => 0.47 * soiRadius(s.a, s.mass, M) >= 1.3 * 8.5 * planetRadius(s.cls ?? 'rocky', s.mass);
  if (!seeds.some(beaconFits)) {
    const g = giantMass();
    const need = (1.4 * 8.5 * planetRadius(g.cls, g.mass)) / (0.47 * Math.pow(g.mass / M, 0.4));
    seeds.push({ a: Math.max(prev.a * ratio(g.mass, prev.mass, giantK()), need, (aHZ / Math.sqrt(0.12)) * 1.05), mass: g.mass, cls: g.cls });
  }

  const habChance = slot.world === 'wild' ? 0.3 : anchored ? 0.06 : 0;
  const last = seeds.length - 1;
  return seeds.map((s, idx) => {
    const flux = fluxAt(s.a);
    const cls = s.cls ?? rockyClass(flux, s.mass, s.a < lock, rng, habChance);
    const giant = isGiant(cls);
    // The outermost small world is sometimes a stray on a tilted, lopsided orbit.
    const stray = idx === last && !giant && idx > 0 && s.mass < 0.6 * EARTH_MASS && rng.chance(0.35);
    const e = stray ? rng.range(0.05, 0.11) : Math.min(0.09, 0.002 + Math.abs(rng.gauss()) * (giant ? 0.025 : 0.016));
    const i = stray ? rng.range(6, 24) * DEG : Math.min(4.5, Math.abs(rng.gauss()) * 1.0) * DEG;
    const draft: PlanetDraft = {
      name: '',
      key: '',
      cls,
      mass: s.mass,
      radius: planetRadius(cls, s.mass),
      a: s.a,
      e: r4(e),
      i: r4(i),
      lan: r4(rng.range(0, TAU)),
      argp: r4(rng.range(0, TAU)),
      m0: r4(rng.range(0, TAU)),
      flux,
      limit: Math.min(0.4 * hillRadius(s.a, e, s.mass, M), 0.5 * soiRadius(s.a, s.mass, M)),
      moons: [],
    };
    // Rings need a turning giant: a tide-locked one has no tilt, and its rings would lie edge-on to the star, unlit.
    if (giant && flux < 0.5 && s.a >= 0.35 * lock && rng.chance(cls === 'gasGiant' ? 0.5 : 0.38)) {
      const rocheIce = rocheLimit(draft.radius, meanDensity(draft.mass, draft.radius), RING_ICE_DENSITY) / draft.radius;
      const inner = rng.range(1.22, 1.6);
      const outer = Math.min(0.95 * rocheIce, rng.range(1.95, 2.6));
      if (outer - inner > 0.35) {
        const look = rng.pick(RING_LOOKS);
        draft.rings = { inner: r3(inner), outer: r3(outer), color: tintPalette([look.color], rng, 0.6)[0], opacity: r3(rng.range(look.opacity[0], look.opacity[1])) };
      }
    }
    draft.moons = draftMoons(draft, M, s.a >= lock || M >= 0.6 * SOLAR_MASS, rng);
    return draft;
  });
}

/** For systems that live on ice: make sure the first giant with moons has a big ice moon to live on. */
function ensureIceMoon(planets: PlanetDraft[]): void {
  const giant = planets.find((p) => isGiant(p.cls) && p.moons.length > 0);
  if (!giant || giant.moons.some((m) => m.cls === 'ice' && m.mass >= 2e22)) return;
  const moon = [...giant.moons].sort((x, y) => y.mass - x.mass)[0];
  moon.cls = 'ice';
  moon.mass = Math.max(moon.mass, Math.min(3e22, 2.5e-4 * giant.mass));
  moon.radius = planetRadius('ice', moon.mass);
  moon.limit = Math.min(0.4 * hillRadius(moon.a, moon.e, moon.mass, giant.mass), 0.5 * soiRadius(moon.a, moon.mass, giant.mass));
}

function draftMoons(p: PlanetDraft, starMass: number, moonsSurvive: boolean, rng: Rng): MoonDraft[] {
  const giant = isGiant(p.cls);
  const roche = rocheLimit(p.radius, meanDensity(p.mass, p.radius), RUBBLE_DENSITY);
  const moon = (cls: BodyClass, mass: number, a: number, e: number): MoonDraft => ({
    name: '',
    key: '',
    cls,
    mass,
    radius: planetRadius(cls, mass),
    a,
    e: r4(e),
    limit: Math.min(0.4 * hillRadius(a, e, mass, p.mass), 0.5 * soiRadius(a, mass, p.mass)),
  });
  if (!giant) {
    // Rocky planets keep a moon only where stellar tides have not had time to take it.
    if (!moonsSurvive || p.mass < 0.4 * EARTH_MASS || !rng.chance(0.3)) return [];
    const aMin = Math.max(1.2 * roche, 5 * p.radius);
    const aMax = 0.55 * p.limit;
    if (aMax < aMin * 1.2) return [];
    return [moon('barren', Math.min(logRange(rng, 3e20, 4e22), 0.012 * p.mass), logRange(rng, aMin, aMax), rng.range(0.002, 0.03))];
  }
  const aMin = Math.max(1.15 * roche, 1.3 * (p.rings ? p.rings.outer * p.radius : 0), 2.6 * p.radius);
  const aMax = 0.5 * p.limit;
  const want = rng.int(1, p.cls === 'gasGiant' ? 4 : 3);
  const cap = 2.5e-4 * p.mass;
  const out: MoonDraft[] = [];
  let a = aMin * rng.range(1.02, 1.5);
  while (out.length < want && a < aMax) {
    const big = out.length > 0 || rng.chance(0.4);
    // A moon system holds about 1e-4 of its planet's mass; no single moon more than a few times that.
    const mass = Math.min(cap * rng.range(0.35, 1), big ? logRange(rng, 8e21, 2.2e23) : logRange(rng, 2e20, 6e21));
    const volcanic = big && out.every((m) => m.cls !== 'lava') && a < 8 * p.radius && rng.chance(0.14);
    const cls: BodyClass = volcanic ? 'lava' : p.flux < 0.15 ? (rng.chance(0.78) ? 'ice' : 'barren') : 'barren';
    out.push(moon(cls, mass, a, rng.range(0.001, 0.012)));
    a *= rng.range(1.55, 2.3);
  }
  return out;
}

interface DraftSystem {
  spec: SystemSpec;
  planets: PlanetDraft[];
  /** Key of the body the capital station orbits, if inhabited. */
  mainKey: string | null;
}

const PARTNER_TYPE: Record<EconomyType, StationVisualId> = {
  agriculture: 'spindle',
  service: 'spindle',
  tourism: 'outpost',
  hightech: 'outpost',
  industrial: 'refinery',
  refinery: 'refinery',
  extraction: 'outpost',
  military: 'citadel',
  colony: 'outpost',
  shipyard: 'drydock',
};

function classEconomy(cls: BodyClass): EconomyType {
  switch (cls) {
    case 'eyeball':
    case 'terran':
    case 'ocean':
      return 'agriculture';
    case 'desert':
      return 'industrial';
    case 'rocky':
      return 'colony';
    case 'gasGiant':
    case 'iceGiant':
    case 'lava':
      return 'refinery';
    default:
      return 'extraction';
  }
}

/** Roll the authoring spec of one generated system (descriptions are written after it is built). */
function draftSystem(slot: GalaxySlot, id: string, name: string, theme: NameTheme, rng: Rng, used: Set<string>): DraftSystem {
  const [mLo, mHi] = STAR_MASS_RANGE[slot.star];
  // Small stars are commoner than large ones, so red-dwarf masses lean toward the low end of the range.
  const starMass = r3(mLo + (mHi - mLo) * Math.pow(rng.next(), slot.star === 'M' ? 1.5 : 1)) * SOLAR_MASS;
  const starKind: StarKind = slot.star === 'brownDwarf' ? 'brownDwarf' : 'main';
  const star: StarSpec = { name, kind: starKind, mass: starMass, description: '' };
  if (starKind === 'brownDwarf') star.temperature = Math.round(rng.range(1300, 1900) / 10) * 10;
  const sp = starPhysics(starKind, starMass, star.temperature);
  const planets = draftPlanets(slot, starMass, sp, rng.fork('planets'));
  if (slot.world === 'ice') ensureIceMoon(planets);

  // ---- names: one theme per system, planets inner to outer, each followed by its moons
  const pool = rng.fork('names').shuffle([...theme.names]);
  planets.forEach((p, idx) => {
    p.name = pool.pop() ?? `${name} ${roman(idx + 1)}`;
    p.key = slug(p.name);
    p.moons.forEach((m, k) => {
      m.name = pool.pop() ?? `${p.name} ${'ABCDEFGH'[k]}`;
      m.key = slug(m.name);
    });
  });

  const bodies: BodySpec[] = [];
  for (const p of planets) {
    bodies.push({
      key: p.key,
      name: p.name,
      cls: p.cls,
      mass: p.mass,
      orbit: { a: Math.round(p.a), e: p.e, i: p.i, lan: p.lan, argp: p.argp, m0: p.m0 },
      rings: p.rings,
      description: '',
    });
    for (const m of p.moons) {
      bodies.push({ key: m.key, name: m.name, cls: m.cls, parent: p.key, mass: m.mass, orbit: { a: Math.round(m.a), e: m.e }, description: '' });
    }
  }

  const stations: StationSpec[] = [];
  const sites: SiteSpec[] = [];
  let mainKey: string | null = null;
  const srng = rng.fork('stations');

  // ---- stations
  if (slot.tier > 0 && slot.stations > 0) {
    const hosts: Host[] = [];
    for (const p of planets) {
      hosts.push({ key: p.key, name: p.name, cls: p.cls, mass: p.mass, radius: p.radius, limit: p.limit, planet: p, moon: null });
      for (const m of p.moons) hosts.push({ key: m.key, name: m.name, cls: m.cls, mass: m.mass, radius: m.radius, limit: m.limit, planet: p, moon: m });
    }
    const airGuess = (h: Host): number => (h.cls === 'barren' || (h.cls === 'ice' && h.mass < 0.018 * EARTH_MASS) ? 0 : Math.min(0.25 * h.radius, 600e3));
    const lowBand = (h: Host): [number, number] => (h.radius >= 2e6 ? [320e3, 950e3] : [Math.max(25e3, 0.08 * h.radius) * 1.1, Math.max(60e3, 0.3 * h.radius) * 0.9]);
    const canHost = (h: Host): boolean => !isGiant(h.cls) && h.radius + airGuess(h) + lowBand(h)[1] < 0.85 * h.limit;
    const solid = hosts.filter(canHost);
    const giants = hosts.filter((h) => isGiant(h.cls));

    // The world the system lives on.
    let main: Host | undefined;
    if (slot.world === 'eyeball' || slot.world === 'garden') main = solid.find((h) => !h.moon && HABITABLE.includes(h.cls));
    if (!main && slot.world === 'ice') {
      const iceMoons = solid.filter((h) => h.moon && h.cls === 'ice').sort((x, y) => y.mass - x.mass);
      main = iceMoons[0] ?? solid.filter((h) => h.cls === 'ice').sort((x, y) => y.mass - x.mass)[0];
    }
    if (!main) {
      const rank: Partial<Record<BodyClass, number>> = { eyeball: 0, terran: 0, ocean: 0, desert: 1, rocky: 1, ice: 2, barren: 3, lava: 5 };
      main = solid
        .filter((h) => !h.moon)
        .sort((x, y) => (rank[x.cls] ?? 9) - (rank[y.cls] ?? 9) || Math.abs(Math.log(x.planet.flux)) - Math.abs(Math.log(y.planet.flux)))[0];
    }
    if (!main) main = solid[0];
    if (!main) throw new Error(`${id}: no body can hold a station`);
    mainKey = main.key;

    let hasDrydock = false;
    let hasCitadel = false;
    const usedHosts = new Set<string>();
    const add = (host: Host, visualId: StationVisualId, where: { altitude?: number; orbitRadii?: number }, economies: EconomyType[], population: number, capital = false): void => {
      const stName = stationName(srng, visualId, host.name, used);
      stations.push({
        key: slug(stName),
        name: stName,
        parent: host.key,
        visualId,
        altitude: Math.round(where.altitude ?? 0),
        orbitRadii: where.orbitRadii,
        economies: economies.filter((e, k) => economies.indexOf(e) === k),
        population: Math.round(round2sig(population)),
        capital: capital || undefined,
        description: '',
      });
      usedHosts.add(host.key);
      if (visualId === 'drydock') hasDrydock = true;
      if (visualId === 'citadel') hasCitadel = true;
    };
    const lowAltitude = (h: Host): number => srng.range(lowBand(h)[0], lowBand(h)[1]);

    // 1. The capital, in low orbit of the main world.
    const primary: EconomyType = slot.economy ?? classEconomy(main.cls);
    const secondary: EconomyType = classEconomy(main.cls) !== primary ? classEconomy(main.cls) : 'service';
    const habitableMain = HABITABLE.includes(main.cls);
    const capitalType: StationVisualId =
      slot.tier === 3
        ? 'ringHabitat'
        : slot.tier === 2
          ? primary === 'military'
            ? 'citadel'
            : habitableMain && srng.chance(0.55)
              ? 'ringHabitat'
              : 'spindle'
          : 'spindle';
    const capitalPop = slot.tier === 3 ? logRange(srng, 1.2e6, 2.4e7) : slot.tier === 2 ? logRange(srng, 9e4, 1.4e6) : logRange(srng, 6e3, 6e4);
    const capitalAlt = lowAltitude(main);
    add(main, capitalType, { altitude: capitalAlt }, [primary, secondary], capitalPop, true);

    const secondaryPop = (visualId: StationVisualId): number => {
      switch (visualId) {
        case 'spindle':
          return Math.max(4000, capitalPop * srng.range(0.03, 0.15));
        case 'refinery':
          return logRange(srng, 3e3, 2e4) * slot.tier;
        case 'drydock':
          return logRange(srng, 8e3, 5e4) * slot.tier;
        case 'citadel':
          return logRange(srng, 8e3, 8e4);
        default:
          return logRange(srng, 200, 9000);
      }
    };
    const stationEconomies = (visualId: StationVisualId, h: Host, high: boolean): EconomyType[] => {
      switch (visualId) {
        case 'refinery':
          return ['refinery', 'extraction'];
        case 'drydock':
          return ['shipyard', 'industrial'];
        case 'citadel':
          return ['military'];
        case 'spindle':
          return ['service', primary === 'service' ? secondary : primary];
        default:
          if (high) return habitableMain && srng.chance(0.4) ? ['tourism', 'service'] : ['service', 'colony'];
          return h.cls === 'ice' || h.cls === 'barren' ? ['extraction', 'colony'] : ['colony', 'extraction'];
      }
    };
    /**
     * A second orbit around `h`, a short transfer above the first. `good` when the Hohmann cost between
     * the two lands between 0.6 and 2.8 km/s; otherwise the highest orbit that fits (a cheap hop).
     */
    const higherOrbit = (h: Host, firstAlt: number): { altitude: number; good: boolean } | null => {
      const top = h.radius + airGuess(h);
      const r1 = top + firstAlt;
      const options = [1.35, 1.6, 1.9, 2.3, 2.8, 3.5, 4.5, 6].filter((f) => r1 * f < 0.8 * h.limit && r1 * f < 7.5 * h.radius);
      if (options.length === 0) return null;
      const good = options.filter((f) => {
        const dv = hohmannDv(G * h.mass, r1, r1 * f);
        return dv >= 600 && dv <= 2800;
      });
      const f = good.length > 0 ? srng.pick(good.slice(0, 3)) : options[options.length - 1];
      return { altitude: r1 * f - top, good: good.length > 0 };
    };
    /**
     * An orbit of the giant just outside (failing that, inside) the orbit of one of its moons, clear of
     * every moon's sphere of influence: about a kilometre per second from the moon's own stations.
     * Returned in giant radii.
     */
    const besideMoon = (giant: Host, moon: MoonDraft): number | null => {
      const reach = (m: MoonDraft): number => 1.3 * soiRadius(m.a, m.mass, giant.mass);
      const floor = Math.max(2.2 * giant.radius, 1.1 * (giant.planet.rings?.outer ?? 0) * giant.radius);
      for (const f of [1.12, 1.18, 1.25, 0.88, 0.82, 1.33]) {
        const r = moon.a * f;
        if (r < floor || r > 0.8 * giant.limit) continue;
        if (giant.planet.moons.every((m) => r > m.a * (1 + m.e) + reach(m) || r < m.a * (1 - m.e) - reach(m))) return r / giant.radius;
      }
      return null;
    };
    const giantOrbit = (h: Host): number => (h.planet.rings ? h.planet.rings.outer * srng.range(1.07, 1.16) : srng.range(1.5, 2.2));

    // 2. A partner a short transfer away: higher around the same world or, where a small moon leaves no
    //    room for a second orbit worth the name, circling the giant just beyond the capital's moon.
    if (stations.length < slot.stations) {
      let partner: StationVisualId = PARTNER_TYPE[primary];
      if (partner === capitalType) partner = 'outpost';
      const higher = higherOrbit(main, capitalAlt);
      const giantHost = main.moon ? giants.find((g) => g.planet === main.planet) : undefined;
      const beside = giantHost && main.moon && !higher?.good ? besideMoon(giantHost, main.moon) : null;
      if (giantHost && beside !== null) {
        add(giantHost, partner, { orbitRadii: beside }, stationEconomies(partner, giantHost, true), secondaryPop(partner));
        usedHosts.delete(giantHost.key); // the giant can still take a refinery by its rings
      } else if (higher) {
        add(main, partner, { altitude: higher.altitude }, stationEconomies(partner, main, true), secondaryPop(partner));
      } else if (giantHost) {
        add(giantHost, 'refinery', { orbitRadii: giantOrbit(giantHost) }, ['refinery', 'extraction'], secondaryPop('refinery'));
      }
    }

    // 3. The rest: giants, their big moons, the other worlds.
    const others: Host[] = [];
    for (const g of [...giants].sort((x, y) => y.mass - x.mass)) {
      others.push(g);
      const big = solid.filter((h) => h.moon && h.planet === g.planet).sort((x, y) => y.mass - x.mass)[0];
      if (big) others.push(big);
    }
    const mainA = main.planet.a;
    others.push(...solid.filter((h) => !h.moon).sort((x, y) => Math.abs(Math.log(x.planet.a / mainA)) - Math.abs(Math.log(y.planet.a / mainA))));
    others.push(...solid.filter((h) => h.moon));
    const military = slot.power === 'hegemony' || slot.economy === 'military';
    for (const h of others) {
      if (stations.length >= slot.stations) break;
      if (usedHosts.has(h.key)) continue;
      if (isGiant(h.cls)) {
        add(h, 'refinery', { orbitRadii: giantOrbit(h) }, ['refinery', 'extraction'], secondaryPop('refinery'));
      } else if (h.cls === 'lava') {
        continue;
      } else {
        const visualId: StationVisualId =
          h.moon && slot.tier >= 2 && !hasDrydock && srng.chance(0.5)
            ? 'drydock'
            : military && !hasCitadel && srng.chance(0.6)
              ? 'citadel'
              : 'outpost';
        add(h, visualId, { altitude: lowAltitude(h) }, stationEconomies(visualId, h, false), secondaryPop(visualId));
      }
    }
    // Still short: one more around the main world, higher again.
    if (stations.length < slot.stations) {
      const top = main.radius + airGuess(main);
      const highest = Math.max(...stations.filter((s) => s.parent === main.key).map((s) => s.altitude));
      const r = (top + highest) * srng.range(1.5, 1.9);
      if (r < 0.8 * main.limit && r < 7.5 * main.radius) {
        const visualId: StationVisualId = !hasDrydock && slot.tier >= 2 ? 'drydock' : 'outpost';
        add(main, visualId, { altitude: r - top }, stationEconomies(visualId, main, true), secondaryPop(visualId));
      }
    }
  }

  // ---- mining sites
  const mrng = rng.fork('sites');
  const want = mrng.pick([1, 2, 2, 2, 3, 3, 4]);
  const frontierBonus = slot.tier === 0 ? 0.15 : 0;
  const richness = (): number => r3(clamp(mrng.range(0.25, 0.9) + frontierBonus, 0.2, 1));
  const addSite = (kind: 'ring' | 'belt', parentKey: string, parentName: string, s: Partial<SiteSpec>, ores: OreTable): void => {
    const siteNm = siteName(mrng, kind, parentName, used, slot.tier === 0);
    sites.push({ key: slug(siteNm), name: siteNm, parent: parentKey, kind, radius: 0, richness: richness(), ores: oreMix(ores, mrng), ...s });
  };
  const beltTable = (flux: number): OreTable => (flux > 2 ? ORE_TABLES.beltHot : flux > 0.12 ? ORE_TABLES.beltMid : ORE_TABLES.beltCold);
  const candidates: (() => void)[] = [];
  for (const p of planets) {
    if (p.rings) {
      const rings = p.rings;
      candidates.push(() =>
        addSite('ring', p.key, p.name, { radii: r3(rings.inner + (rings.outer - rings.inner) * mrng.range(0.3, 0.85)) }, p.flux < 0.12 ? ORE_TABLES.ringCold : ORE_TABLES.ringWarm),
      );
    }
  }
  const beltOptions: (() => void)[] = [];
  for (const p of planets) {
    if (!isGiant(p.cls)) continue;
    // Trojans: rubble sharing the giant's orbit, sixty degrees ahead of it or behind.
    beltOptions.push(() => {
      const lan = r4(mrng.range(0, TAU));
      addSite(
        'belt',
        'star',
        name,
        { radius: Math.round(p.a), e: p.e, i: r4(mrng.range(0.5, 4) * DEG), lan, argp: r4((((p.lan + p.argp - lan) % TAU) + TAU) % TAU), m0: r4(p.m0 + (mrng.chance(0.5) ? 1 : -1) * (Math.PI / 3)) },
        beltTable(p.flux),
      );
    });
    // Irregular swarm: captured rubble on a wide, tilted orbit of the giant.
    const outerMoon = p.moons[p.moons.length - 1];
    const lo = Math.max(0.58 * p.limit, outerMoon ? outerMoon.a * 1.25 : 0);
    if (lo < 0.8 * p.limit) {
      beltOptions.push(() => {
        const e = mrng.range(0.03, 0.09);
        addSite('belt', p.key, p.name, { radius: Math.round(mrng.range(lo, 0.8 * p.limit)), e: r3(e), i: r4(mrng.range(4, 24) * DEG), lan: r4(mrng.range(0, TAU)) }, ORE_TABLES.swarm);
      });
    }
  }
  // Belts between worlds that stand far enough apart, and one beyond the last.
  for (let k = 0; k + 1 < planets.length; k++) {
    const p = planets[k];
    const q = planets[k + 1];
    const a = Math.sqrt(p.a * q.a);
    const hill = (x: PlanetDraft): number => x.a * Math.cbrt(x.mass / (3 * starMass));
    if (q.a / p.a >= 2 && a - p.a > 6 * hill(p) && q.a - a > 6 * hill(q)) {
      beltOptions.push(() =>
        addSite('belt', 'star', name, { radius: Math.round(a), e: r3(mrng.range(0.02, 0.08)), i: r4(mrng.range(0.5, 6) * DEG), lan: r4(mrng.range(0, TAU)) }, beltTable(stellarFlux(sp.luminosity, a))),
      );
    }
  }
  const lastPlanet = planets[planets.length - 1];
  const outerBelt = (): void => {
    const a = lastPlanet.a * mrng.range(1.5, 1.9) * (isGiant(lastPlanet.cls) ? 1.25 : 1);
    addSite('belt', 'star', name, { radius: Math.round(a), e: r3(mrng.range(0.03, 0.1)), i: r4(mrng.range(1, 9) * DEG), lan: r4(mrng.range(0, TAU)) }, beltTable(stellarFlux(sp.luminosity, a)));
  };
  candidates.push(...mrng.shuffle(beltOptions));
  for (const make of candidates) {
    if (sites.length >= want) break;
    make();
  }
  if (sites.length === 0 || (sites.length < want && mrng.chance(0.5))) outerBelt();

  const mainHostPlanet = mainKey ? planets.find((p) => p.key === mainKey || p.moons.some((m) => m.key === mainKey)) : undefined;
  return {
    spec: { id, name, star, bodies, stations, sites, beaconBody: mainHostPlanet?.key, baseSecurity: slot.security, description: '' },
    planets,
    mainKey,
  };
}

/** Write the survey prose of a generated system onto its built definition. */
function writeLore(system: SystemDef, draft: DraftSystem, slot: GalaxySlot, theme: NameTheme, decks: LoreDecks): void {
  const star = system.bodies[0];
  const starDef = star.star as StarDef;
  const byId = new Map(system.bodies.map((b) => [b.id, b]));
  star.description = starLore(decks, {
    name: star.name,
    kind: draft.spec.star.kind,
    spectralClass: starDef.spectralClass,
    mass: star.mass / SOLAR_MASS,
    temperature: starDef.temperature,
    activity: starDef.activity,
  });
  const settled = system.stations.length > 0;
  for (const b of system.bodies) {
    if (b.kind === 'star' || !b.orbit) continue;
    const parent = byId.get(b.parentId as string) as BodyDef;
    const planet = b.kind === 'moon' ? parent : b;
    const starDistance = (planet.orbit as OrbitElements).a;
    b.description = bodyLore(decks, {
      name: b.name,
      cls: b.cls,
      isMoon: b.kind === 'moon',
      parentName: parent.name,
      starName: star.name,
      period: orbitalPeriod(parent.mu, b.orbit.a),
      day: b.rotationPeriod,
      temperature: b.temperature,
      noonTemperature: Math.round((equilibriumTemperature(starDef.luminosity, starDistance, ALBEDO[b.cls]) * Math.SQRT2) / 10) * 10,
      ringed: b.rings !== null,
      tiltDeg: b.axialTilt / DEG,
      hasAir: b.atmosphere !== null,
      settled,
      hasStation: system.stations.some((st) => st.parentBodyId === b.id || byId.get(st.parentBodyId)?.parentId === b.id),
      massEarth: b.mass / EARTH_MASS,
      radius: b.radius,
    });
  }
  for (const st of system.stations) {
    st.description = stationLore(decks, {
      name: st.name,
      visualId: st.visualId,
      bodyName: (byId.get(st.parentBodyId) as BodyDef).name,
      economy: st.economies[0],
      capital: st.id === system.capitalStationId,
    });
  }
  const planets = system.bodies.filter((b) => b.kind === 'planet');
  const main = draft.mainKey ? byId.get(`${system.id}.${draft.mainKey}`) : undefined;
  const ringed = planets.find((b) => b.rings);
  const temperate = planets.find((b) => HABITABLE.includes(b.cls));
  let feature = '';
  if (main) {
    if (main.cls === 'eyeball') feature = `Most of its people live along the twilight belt of ${main.name}.`;
    else if (main.cls === 'terran' || main.cls === 'ocean') feature = `${main.name} has open sky and standing water, and its people know what that is worth.`;
    else if (main.cls === 'ice') feature = `Life here turns on the ice of ${main.name}.`;
    else feature = `Its stations hang over ${main.name}, a world nobody would choose and thousands have.`;
  } else if (temperate) feature = `Its temperate world, ${temperate.name}, has never had a charter filed on it.`;
  else if (ringed) feature = `Its ringed giant, ${ringed.name}, has never been scooped.`;
  else {
    const big = [...planets].sort((x, y) => y.mass - x.mass)[0];
    feature = isGiant(big.cls) ? `Its giant, ${big.name}, has never been scooped.` : `Its largest world, ${big.name}, has been mapped from orbit and no closer.`;
  }
  system.description = systemLore({
    name: system.name,
    role: slot.role.replace(/\{name\}/g, system.name),
    spectralClass: starDef.spectralClass,
    planets: planets.length,
    themeOrigin: theme.origin,
    inhabited: settled,
    population: system.population,
    feature,
  });
}

/** Delta-v under which a transfer between two stations counts as a short hop, m/s. */
export const SHORT_HOP_DV = 4000;

/** Cheapest station-to-station transfer in a system by `estimateTransferDv`, m/s (Infinity with fewer than two stations). */
export function cheapestHop(system: SystemDef): number {
  let best = Infinity;
  for (let i = 0; i < system.stations.length; i++) {
    for (let j = i + 1; j < system.stations.length; j++) {
      const dv = estimateTransferDv(system, system.stations[i].id, system.stations[j].id);
      if (dv !== undefined && dv < best) best = dv;
    }
  }
  return best;
}

/** Generate, build and check one procedural system; a roll that breaks a physical rule is thrown away and re-rolled. */
function generateSystem(slot: GalaxySlot, id: string, name: string, theme: NameTheme, pos: V3, rng: Rng, used: Set<string>, decks: LoreDecks): SystemDef {
  let lastProblems: string[] = [];
  for (let attempt = 0; attempt < 24; attempt++) {
    const trial = new Set(used);
    let draft: DraftSystem;
    let system: SystemDef;
    try {
      draft = draftSystem(slot, id, name, theme, rng.fork(`attempt:${attempt}`), trial);
      system = buildSystem(draft.spec, pos);
    } catch (err) {
      lastProblems = [String(err)];
      continue;
    }
    lastProblems = validateSystem(system);
    if (slot.tier > 0 && system.stations.length < Math.min(2, slot.stations)) lastProblems.push(`${id}: too few stations`);
    // Wanted, not required: two stations a short transfer apart. Give up asking after a dozen rolls.
    if (attempt < 12 && system.stations.length >= 2 && cheapestHop(system) > SHORT_HOP_DV) lastProblems.push(`${id}: no two stations within a short transfer`);
    if (lastProblems.length > 0) continue;
    for (const n of trial) used.add(n);
    writeLore(system, draft, slot, theme, decks);
    return system;
  }
  throw new Error(`could not generate system ${id}: ${lastProblems.join('; ')}`);
}

// =====================================================================================
// 7. The galaxy
// =====================================================================================

function connectedWithin(positions: V3[], range: number): boolean {
  if (positions.length === 0) return true;
  const seen = new Set<number>([0]);
  const queue = [0];
  while (queue.length > 0) {
    const cur = queue.pop() as number;
    for (let k = 0; k < positions.length; k++) {
      if (!seen.has(k) && systemDistance(positions[cur], positions[k]) <= range) {
        seen.add(k);
        queue.push(k);
      }
    }
  }
  return seen.size === positions.length;
}

/** Slot positions nudged by the seed, never far enough to cut the 7 ly jump graph. */
function layoutPositions(rng: Rng): V3[] {
  for (let scale = 1; scale > 0.05; scale *= 0.5) {
    const r = rng.fork(`jitter:${scale}`);
    const positions = GALAXY_SLOTS.map((s) =>
      s.showcase
        ? { x: s.pos[0], y: s.pos[1], z: s.pos[2] }
        : { x: s.pos[0] + r.range(-0.35, 0.35) * scale, y: s.pos[1] + r.range(-0.25, 0.25) * scale, z: s.pos[2] + r.range(-0.35, 0.35) * scale },
    );
    if (connectedWithin(positions, MAX_GUARANTEED_JUMP_LY - 0.15)) return positions;
  }
  return GALAXY_SLOTS.map((s) => ({ x: s.pos[0], y: s.pos[1], z: s.pos[2] }));
}

function factionColor(powerId: PowerId | null, criminal: boolean, id: string): RGB {
  const base = criminal ? OUTLAW_COLOR : powerId ? (POWERS.find((p) => p.id === powerId) as PowerDef).color : INDEPENDENT_COLOR;
  const k = 0.84 + (0.32 * (hash(id) % 1000)) / 1000;
  return [r4(clamp(base[0] * k, 0, 1)), r4(clamp(base[1] * k, 0, 1)), r4(clamp(base[2] * k, 0, 1))];
}

interface PresenceDraft {
  faction: FactionDef;
  raw: number;
  native: boolean;
}

/** Found the minor factions of the cluster and deal out their starting influence, control and stations. */
function foundFactions(
  systems: SystemDef[],
  rng: Rng,
  used: Set<string>,
  decks: LoreDecks,
): Pick<GalaxyDef, 'factions' | 'initialPresence' | 'initialControl' | 'stationOwners'> {
  const factions: FactionDef[] = [];
  const ids = new Set<string>();
  const presence = new Map<string, PresenceDraft[]>();
  const control: Record<string, string> = {};
  const owners: Record<string, string> = {};
  const slotOf = new Map<string, GalaxySlot>();
  systems.forEach((s, idx) => slotOf.set(s.id, GALAXY_SLOTS[idx]));
  const inhabited = systems.filter((s) => s.stations.length > 0);
  const capitals = POWERS.map((p) => ({ id: p.id, system: systems.find((s) => s.id === p.capitalSystemId) as SystemDef }));
  const register = (f: FactionDef): FactionDef => {
    factions.push(f);
    ids.add(f.id);
    return f;
  };
  const uniqueId = (base: string): string => {
    let id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    return id;
  };
  const meanNative = (systemId: string): number => {
    const list = (presence.get(systemId) ?? []).filter((p) => p.native && !p.faction.criminal);
    return list.length > 0 ? list.reduce((n, p) => n + p.raw, 0) / list.length : 1;
  };

  // ---- natives
  for (const system of inhabited) {
    const slot = slotOf.get(system.id) as GalaxySlot;
    const frng = rng.fork(`natives:${system.id}`);
    const list: PresenceDraft[] = [];
    presence.set(system.id, list);
    const authored: FactionSpec[] | undefined = slot.showcase ? SHOWCASE_SYSTEMS[slot.showcase].factions : undefined;
    if (authored) {
      for (const a of authored) {
        const id = `f.${system.id}.${a.key}`;
        const f = register({
          id,
          name: a.name,
          government: a.government,
          powerId: a.powerId,
          homeSystemId: system.id,
          color: factionColor(a.powerId, a.criminal === true, id),
          description: a.description,
          criminal: a.criminal === true,
        });
        list.push({ faction: f, raw: a.influence, native: true });
        if (a.controls) control[system.id] = id;
      }
      if (!control[system.id]) control[system.id] = (list.filter((p) => !p.faction.criminal).sort((x, y) => y.raw - x.raw)[0] as PresenceDraft).faction.id;
      continue;
    }
    // Which banner a native faction flies: the local power's, or by distance from each capital where none dominates.
    const weights: { powerId: PowerId | null; w: number }[] = [];
    if (slot.power) {
      const gate = inhabited.some((o) => slotOf.get(o.id)?.region === 'core' && systemDistance(system, o) <= MAX_GUARANTEED_JUMP_LY);
      for (const p of POWERS) weights.push({ powerId: p.id, w: p.id === slot.power ? (gate ? 0.48 : 0.72) : gate ? 0.11 : 0.03 });
      weights.push({ powerId: null, w: gate ? 0.3 : 0.22 });
    } else {
      const share = slot.region === 'badlands' ? 0.3 : 0.6;
      const raw = capitals.map((c) => Math.exp(-systemDistance(system, c.system) / 6));
      const total = raw.reduce((n, x) => n + x, 0);
      capitals.forEach((c, k) => weights.push({ powerId: c.id, w: (share * raw[k]) / total }));
      weights.push({ powerId: null, w: 1 - share });
    }
    const count = slot.tier === 3 ? frng.int(3, 4) : slot.tier === 2 ? frng.int(2, 3) : 2;
    const governments = new Set<Government>();
    for (let k = 0; k < count; k++) {
      const powerId = k === 0 && slot.power ? slot.power : frng.weighted(weights, (x) => x.w).powerId;
      const table: readonly GovernmentWeight[] = powerId ? POWER_GOVERNMENTS[powerId] : INDEPENDENT_GOVERNMENTS;
      const lawless = system.baseSecurity < 0.25;
      let options = table.filter((g) => !governments.has(g.government) && (g.government !== 'anarchy' || (lawless && k > 0) || (!lawless && k > 0 && powerId === 'league')));
      if (options.length === 0) options = table.filter((g) => g.government !== 'anarchy');
      const government = frng.weighted(options, (g) => g.weight).government;
      governments.add(government);
      const name = factionName(frng, government, false, system.name, used);
      const id = uniqueId(`f.${system.id}.${slug(name)}`);
      const f = register({
        id,
        name,
        government,
        powerId,
        homeSystemId: system.id,
        color: factionColor(powerId, false, id),
        description: factionLore(decks, { name, government, powerId, systemName: system.name, criminal: false }),
        criminal: false,
      });
      list.push({ faction: f, raw: k === 0 ? frng.range(1.5, 2.1) : frng.range(0.55, 1.1), native: true });
      if (k === 0) control[system.id] = id;
    }
  }

  // ---- factions that have spread to their neighbours
  const spread = new Map<string, number>();
  const capitalIds = new Set(POWERS.map((p) => p.capitalSystemId));
  for (const system of inhabited) {
    const slot = slotOf.get(system.id) as GalaxySlot;
    if (capitalIds.has(system.id)) continue; // the capitals are solidly their own
    const list = presence.get(system.id) as PresenceDraft[];
    const frng = rng.fork(`spread:${system.id}`);
    const room = 6 - list.length - (system.baseSecurity < 0.4 ? 1 : 0);
    const wantN = Math.max(3 - list.length, slot.showcase ? frng.int(0, 1) : slot.tier >= 2 ? frng.int(1, 2) : frng.int(0, 1));
    const options: { faction: FactionDef; w: number }[] = [];
    for (const other of inhabited) {
      if (other.id === system.id) continue;
      const d = systemDistance(system, other);
      if (d > MAX_GUARANTEED_JUMP_LY) continue;
      const theirs = (presence.get(other.id) as PresenceDraft[]).filter((p) => p.native && !p.faction.criminal);
      theirs.forEach((p) => {
        const f = p.faction;
        if ((spread.get(f.id) ?? 0) >= 3 || f.government === 'anarchy') return;
        const ruler = control[other.id] === f.id ? 2 : 1;
        const kin = slot.power ? (f.powerId === slot.power ? 3 : f.powerId === null ? 1 : 0.35) : 1;
        options.push({ faction: f, w: (ruler * kin) / (1 + d / 4) });
      });
    }
    for (let k = 0; k < Math.min(room, wantN) && options.length > 0; k++) {
      const pick = frng.weighted(options, (o) => o.w);
      options.splice(options.indexOf(pick), 1);
      list.push({ faction: pick.faction, raw: meanNative(system.id) * frng.range(0.25, 0.6), native: false });
      spread.set(pick.faction.id, (spread.get(pick.faction.id) ?? 0) + 1);
    }
  }

  // ---- Scorch clans: at home in the lawless systems, raiding into the ones next door
  const lawless = inhabited.filter((s) => s.baseSecurity < 0.4).sort((x, y) => x.baseSecurity - y.baseSecurity);
  const crng = rng.fork('clans');
  const clans: FactionDef[] = factions.filter((f) => f.criminal);
  const clanless = lawless.filter((s) => !(presence.get(s.id) as PresenceDraft[]).some((p) => p.faction.criminal));
  const newClans = Math.min(clanless.length, Math.max(0, crng.int(2, 3) - clans.length));
  for (let k = 0; k < newClans; k++) {
    const home = clanless[k];
    const name = factionName(crng, 'anarchy', true, home.name, used);
    const id = uniqueId(`f.${home.id}.${slug(name)}`);
    const f = register({
      id,
      name,
      government: 'anarchy',
      powerId: null,
      homeSystemId: home.id,
      color: factionColor(null, true, id),
      description: factionLore(decks, { name, government: 'anarchy', powerId: null, systemName: home.name, criminal: true }),
      criminal: true,
    });
    clans.push(f);
    (presence.get(home.id) as PresenceDraft[]).push({ faction: f, raw: meanNative(home.id) * crng.range(0.45, 0.8), native: true });
  }
  for (const clan of clans) {
    const home = systems.find((s) => s.id === clan.homeSystemId) as SystemDef;
    for (const target of lawless) {
      if (target.id === home.id || systemDistance(home, target) > MAX_GUARANTEED_JUMP_LY + 0.5) continue;
      const list = presence.get(target.id) as PresenceDraft[];
      if (list.length >= 6 || list.some((p) => p.faction.id === clan.id) || !crng.chance(0.65)) continue;
      list.push({ faction: clan, raw: meanNative(target.id) * crng.range(0.2, 0.45), native: false });
    }
  }

  // ---- influence, control, station owners
  const initialPresence: GalaxyDef['initialPresence'] = [];
  for (const system of inhabited) {
    const list = presence.get(system.id) as PresenceDraft[];
    const total = list.reduce((n, p) => n + p.raw, 0);
    const ruler = control[system.id];
    const shares = list.map((p) => ({ factionId: p.faction.id, influence: Math.round((p.raw / total) * 1000) / 1000 }));
    const rest = shares.filter((s) => s.factionId !== ruler).reduce((n, s) => n + s.influence, 0);
    (shares.find((s) => s.factionId === ruler) as { influence: number }).influence = Math.round((1 - rest) * 1000) / 1000;
    shares.sort((x, y) => y.influence - x.influence);
    for (const s of shares) initialPresence.push({ systemId: system.id, factionId: s.factionId, influence: s.influence });

    const slot = slotOf.get(system.id) as GalaxySlot;
    const authored = slot.showcase ? SHOWCASE_SYSTEMS[slot.showcase] : undefined;
    const lawful = list.filter((p) => !p.faction.criminal);
    const orng = rng.fork(`owners:${system.id}`);
    for (const st of system.stations) {
      const ownerKey = authored?.stations.find((s) => `${system.id}.st.${s.key}` === st.id)?.owner;
      if (ownerKey) owners[st.id] = `f.${system.id}.${ownerKey}`;
      else if (st.id === system.capitalStationId) owners[st.id] = ruler;
      else owners[st.id] = orng.weighted(lawful, (p) => (p.faction.id === ruler ? 1.2 : p.native ? 1 : 0.5) * p.raw).faction.id;
    }
  }
  return { factions, initialPresence, initialControl: control, stationOwners: owners };
}

/**
 * Generate the Ember Reach. Pure and deterministic: the same seed always yields the same galaxy.
 * The six showpiece systems are the same under every seed; the seed decides the eighteen generated
 * systems (names, worlds, stations, sites), the minor factions, and small shifts in the map.
 */
export function generateGalaxy(seed: number): GalaxyDef {
  const root = makeRng(hash(`ember-reach:${seed}`));
  const used = new Set<string>();
  for (const spec of Object.values(SHOWCASE_SYSTEMS)) {
    used.add(spec.name);
    for (const b of spec.bodies) used.add(b.name);
    for (const s of spec.stations) used.add(s.name);
    for (const s of spec.sites) used.add(s.name);
    for (const f of spec.factions ?? []) used.add(f.name);
  }
  const decks = makeLoreDecks(root.fork('lore'));
  const positions = layoutPositions(root.fork('map'));
  const themes = root.fork('themes').shuffle([...NAME_THEMES]);
  const nameRng = root.fork('stars');

  // One naming theme per generated system, none used twice (there are more themes than systems).
  // Systems nobody has settled take a theme that a passing survey crew could have chosen.
  const themeOf = new Map<string, NameTheme>();
  for (const slot of GALAXY_SLOTS) {
    if (slot.showcase || slot.tier > 0) continue;
    const k = themes.findIndex((t) => t.surveyNamed);
    themeOf.set(slot.key, themes.splice(k >= 0 ? k : 0, 1)[0]);
  }
  let generated = 0;
  const systems: SystemDef[] = GALAXY_SLOTS.map((slot, idx) => {
    const pos = positions[idx];
    if (slot.showcase) {
      const spec = SHOWCASE_SYSTEMS[slot.showcase];
      if (!spec) throw new Error(`layout names an unknown showpiece: ${slot.showcase}`);
      return buildSystem(spec, pos);
    }
    const kind = slot.star === 'brownDwarf' ? 'dim' : slot.star === 'K' || slot.star === 'G' || slot.star === 'F' ? 'bright' : 'ember';
    const name = pickStarName(nameRng, kind, used);
    const theme = themeOf.get(slot.key) ?? themes[generated++ % themes.length];
    return generateSystem(slot, slug(name), name, theme, pos, root.fork(`system:${slot.key}`), used, decks);
  });

  const politics = foundFactions(systems, root.fork('factions'), used, decks);
  return {
    seed,
    systems,
    powers: POWERS.map((p) => ({ ...p })),
    commodities: COMMODITIES.map((c) => ({ ...c, illegalUnder: [...c.illegalUnder] })),
    ...politics,
    startSystemId: START_SYSTEM_ID,
    startStationId: START_STATION_ID,
  };
}

// =====================================================================================
// 8. describeSystem: a plain-text dump for humans
// =====================================================================================

const fmtPop = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} M` : fmtInt(n));

/**
 * Everything about a system as indented plain text: star, planets with their moons, stations and
 * mining sites, the jump beacon and (when the galaxy is given) who holds what. For debugging, design
 * review and the in-game data panel's long form.
 */
export function describeSystem(system: SystemDef, galaxy?: GalaxyDef): string {
  const out: string[] = [];
  const star = system.bodies[0];
  const sd = star.star as StarDef;
  const byId = new Map(system.bodies.map((b) => [b.id, b]));
  const deg = (rad: number): string => `${(rad / DEG).toFixed(1)}°`;
  const hours = (s: number): string => (s < 48 * HOUR ? `${(s / HOUR).toFixed(1)} h` : s < 600 * DAY ? `${(s / DAY).toFixed(1)} d` : `${(s / (365.25 * DAY)).toFixed(2)} y`);
  const massOf = (b: BodyDef): string =>
    b.mass >= 0.5 * JUPITER_MASS ? `${(b.mass / JUPITER_MASS).toFixed(2)} Mjup` : b.mass >= 0.01 * EARTH_MASS ? `${(b.mass / EARTH_MASS).toFixed(2)} Me` : `${b.mass.toExponential(1)} kg`;

  out.push(`=== ${system.name.toUpperCase()} [${system.id}] ===`);
  out.push(`map (${system.pos.x.toFixed(1)}, ${system.pos.y.toFixed(1)}, ${system.pos.z.toFixed(1)}) ly · population ${fmtPop(system.population)} · security ${system.baseSecurity.toFixed(2)}`);
  out.push(system.description);
  const beaconBody = byId.get(system.jumpBeacon.bodyId) as BodyDef;
  out.push(
    `Jump beacon: ${fmtDistance(system.jumpBeacon.orbitRadius)} orbit of ${beaconBody.name} ` +
      `(${(system.jumpBeacon.orbitRadius / beaconBody.radius).toFixed(1)} radii, ${(system.jumpBeacon.orbitRadius / beaconBody.soi).toFixed(2)} SOI, ` +
      `period ${fmtDuration(orbitalPeriod(beaconBody.mu, system.jumpBeacon.orbitRadius))})`,
  );
  out.push('');
  out.push(
    `STAR ${star.name}  ${sd.spectralClass}  ${(star.mass / SOLAR_MASS).toFixed(3)} Msun  ${(star.radius / SOLAR_RADIUS).toFixed(3)} Rsun  ${sd.temperature} K  ` +
      `L ${sd.luminosity} Lsun  activity ${sd.activity}  habitable zone ~${(Math.sqrt(sd.luminosity / 1.1)).toFixed(3)}-${(Math.sqrt(sd.luminosity / 0.4)).toFixed(3)} AU` +
      (star.rings ? `  disc ${fmtDistance(star.rings.innerRadius)}-${fmtDistance(star.rings.outerRadius)}` : ''),
  );
  out.push(`    ${star.description}`);

  const orbiters = (bodyId: string, pad: string): void => {
    for (const st of system.stations.filter((s) => s.parentBodyId === bodyId).sort((x, y) => x.orbit.a - y.orbit.a)) {
      const parent = byId.get(bodyId) as BodyDef;
      const alt = st.orbit.a - parent.radius - (parent.atmosphere?.height ?? 0);
      const owner = galaxy ? getFaction(galaxy, galaxy.stationOwners[st.id])?.name : undefined;
      out.push(
        `${pad}STATION ${st.name} [${st.visualId} ${st.maxPad}]${st.id === system.capitalStationId ? ' (capital)' : ''}  r ${fmtDistance(st.orbit.a)} (${fmtDistance(alt)} above ${parent.atmosphere ? 'the air' : 'the surface'})  ` +
          `v ${fmtSpeed(circularSpeed(parent.mu, st.orbit.a))}  P ${hours(orbitalPeriod(parent.mu, st.orbit.a))}  i ${deg(st.orbit.i)}  pop ${fmtPop(st.population)}  ${st.economies.join('/')}`,
      );
      out.push(`${pad}    services: ${st.services.join(', ')}${owner ? `  ·  owner: ${owner}` : ''}`);
      out.push(`${pad}    ${st.description}`);
    }
    for (const site of system.miningSites.filter((s) => s.parentBodyId === bodyId).sort((x, y) => x.orbit.a - y.orbit.a)) {
      out.push(
        `${pad}SITE ${site.name} [${site.kind}]  a ${fmtDistance(site.orbit.a)}  e ${site.orbit.e}  i ${deg(site.orbit.i)}  richness ${site.richness}  ` +
          `ores ${site.ores.map((o) => `${o.commodityId} ${o.weight}`).join(', ')}`,
      );
    }
  };
  const body = (b: BodyDef, pad: string): void => {
    const parent = byId.get(b.parentId as string) as BodyDef;
    const o = b.orbit as OrbitElements;
    const planet = b.kind === 'moon' ? parent : b;
    const flux = stellarFlux(sd.luminosity, (planet.orbit as OrbitElements).a);
    const g = b.mu / (b.radius * b.radius);
    out.push(
      `${pad}${b.kind.toUpperCase()} ${b.name} [${b.cls}]  a ${fmtDistance(o.a)}  P ${hours(orbitalPeriod(parent.mu, o.a))}  e ${o.e}  i ${deg(o.i)}  ` +
        `${massOf(b)}  r ${fmtDistance(b.radius)}  g ${g.toFixed(2)} m/s²  ${b.temperature} K  flux ${flux >= 10 ? flux.toFixed(0) : flux.toPrecision(2)}  ` +
        `${b.tidallyLocked ? 'locked' : `day ${hours(b.rotationPeriod)}  tilt ${deg(b.axialTilt)}`}  SOI ${fmtDistance(b.soi)} (${(b.soi / b.radius).toFixed(0)} R)  survey ${fmtInt(b.surveyValue)} cr`,
    );
    if (b.atmosphere) {
      const at = b.atmosphere;
      out.push(
        `${pad}    air: top ${fmtDistance(at.height)}, scale height ${fmtDistance(at.scaleHeight)}, ${at.surfaceDensity} kg/m³ at the ${isGiant(b.cls) ? '1-bar level' : 'surface'}${at.scoopable ? ', scoopable' : ''}`,
      );
    }
    if (b.rings) out.push(`${pad}    rings: ${fmtDistance(b.rings.innerRadius)} - ${fmtDistance(b.rings.outerRadius)} (${(b.rings.innerRadius / b.radius).toFixed(2)}-${(b.rings.outerRadius / b.radius).toFixed(2)} R), opacity ${b.rings.opacity}`);
    out.push(`${pad}    ${b.description}`);
    orbiters(b.id, `${pad}    `);
    for (const child of childrenOf(system, b.id)) body(child, `${pad}    `);
  };
  for (const planet of childrenOf(system, star.id)) body(planet, '  ');
  orbiters(star.id, '  ');

  if (galaxy) {
    const present = factionsIn(galaxy, system.id);
    if (present.length > 0) {
      out.push('');
      out.push('FACTIONS');
      for (const { faction, influence } of present) {
        const banner = faction.criminal ? 'Scorch clan' : faction.powerId ? (galaxy.powers.find((p) => p.id === faction.powerId) as PowerDef).shortName : 'independent';
        const home = faction.homeSystemId === system.id ? '' : `, from ${getSystem(galaxy, faction.homeSystemId)?.name}`;
        out.push(`  ${(influence * 100).toFixed(1).padStart(5)} %  ${faction.name} [${faction.government}, ${banner}${home}]${galaxy.initialControl[system.id] === faction.id ? '  <- controls' : ''}`);
      }
    }
    const near = systemsWithin(galaxy, system.id, MAX_GUARANTEED_JUMP_LY);
    out.push('');
    out.push(`JUMPS within ${MAX_GUARANTEED_JUMP_LY} ly: ${near.map((n) => `${n.system.name} ${n.distance.toFixed(1)}`).join(', ')}`);
  }
  return out.join('\n');
}
