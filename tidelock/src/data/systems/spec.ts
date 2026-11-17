// Authoring format for star systems. Hand-authored showpieces (the other files in this folder) and
// the procedural generator (sim/universe.ts) both produce a SystemSpec; sim/universe.ts `buildSystem`
// turns a spec into the SystemDef contract, deriving everything physics dictates (radii from mass,
// mu, SOI, tidal locking, equilibrium temperatures, atmosphere scale heights, orbital elements).
//
// Units are SI like the rest of the simulation: write `0.097 * AU`, `1.2 * EARTH_MASS`, `14 * DEG`.

import type {
  BodyClass,
  BodyVisualDef,
  EconomyType,
  Government,
  PadSize,
  PowerId,
  RGB,
  StationService,
  StationVisualId,
} from '../../core/types';

export type StarKind = 'main' | 'whiteDwarf' | 'brownDwarf';

export interface RingSpec {
  /** Inner / outer edge in multiples of the body's radius. */
  inner: number;
  outer: number;
  color: RGB;
  opacity: number;
}

export interface StarSpec {
  name: string;
  kind: StarKind;
  /** kg */
  mass: number;
  /** Effective temperature, K. Required for white and brown dwarfs (they cool with age); derived for main-sequence stars. */
  temperature?: number;
  /** Flare activity 0..1; derived from mass when omitted. */
  activity?: number;
  /** Debris disc (white dwarfs only). */
  rings?: RingSpec;
  description: string;
  surveyValue?: number;
}

export interface OrbitSpec {
  /** Semi-major axis, m. */
  a: number;
  e?: number;
  /**
   * Inclination, rad, from the system reference plane. Omitted: planets orbit in the reference plane;
   * moons, stations and sites orbit in their parent's equatorial plane (i = parent tilt, lan = 0).
   */
  i?: number;
  lan?: number;
  argp?: number;
  m0?: number;
}

export interface AtmosphereSpec {
  /** Surface pressure, Pa (use 1e5 for the 1-bar reference level of giants). */
  pressure: number;
  /** Mean molar mass of the gas, kg/mol. */
  molarMass: number;
  color: RGB;
  sunsetColor: RGB;
  opacity: number;
  scoopable?: boolean;
  /** Greenhouse warming added to the equilibrium temperature, K. */
  greenhouse?: number;
}

export interface BodySpec {
  /** Local key; the body id becomes `${systemId}.${key}`. */
  key: string;
  name: string;
  cls: BodyClass;
  /** Key of the planet this moon orbits. Omit for planets (they orbit the primary star). */
  parent?: string;
  /** kg */
  mass: number;
  /** m. Omit to derive from mass and class. */
  radius?: number;
  orbit: OrbitSpec;
  /** s. Omit to derive: equal to the orbital period when tidally locked, otherwise seeded. */
  rotationPeriod?: number;
  /** rad. Omit to derive (near zero when tidally locked). */
  axialTilt?: number;
  /** Omit for the class default; null for a vacuum world. */
  atmosphere?: AtmosphereSpec | null;
  rings?: RingSpec;
  /** Bond albedo override. */
  albedo?: number;
  visual?: Partial<BodyVisualDef>;
  description: string;
  surveyValue?: number;
}

export interface StationSpec {
  key: string;
  name: string;
  /** Key of the body it orbits. */
  parent: string;
  visualId: StationVisualId;
  /**
   * Orbit altitude, m above the top of the parent's atmosphere (above the surface of an airless
   * body). Ignored when `orbitRadii` is given.
   */
  altitude: number;
  /** Orbit radius in multiples of the parent's radius, for stations parked beside rings or between moons. */
  orbitRadii?: number;
  e?: number;
  /** rad from the reference plane; omitted = parent's equatorial plane. */
  i?: number;
  lan?: number;
  m0?: number;
  maxPad?: PadSize;
  /** Primary first. */
  economies: EconomyType[];
  /** People who live aboard plus the surface settlements the port serves. */
  population: number;
  /** Omit for the defaults of the station type. */
  services?: StationService[];
  /** The station that anchors the system. */
  capital?: boolean;
  /** Key of the authored faction that owns it (see SystemSpec.factions). */
  owner?: string;
  description: string;
}

export interface SiteSpec {
  key: string;
  name: string;
  /** Key of the body it orbits; 'star' for a heliocentric belt. */
  parent: string;
  kind: 'ring' | 'belt';
  /** Orbit radius (semi-major axis), m from the parent's centre. Ignored when `radii` is given. */
  radius: number;
  /** Orbit radius in multiples of the parent's radius (ring sites). */
  radii?: number;
  e?: number;
  i?: number;
  lan?: number;
  argp?: number;
  m0?: number;
  richness: number;
  ores: { commodityId: string; weight: number }[];
}

export interface FactionSpec {
  /** Local key; the faction id becomes `f.${systemId}.${key}`. */
  key: string;
  name: string;
  government: Government;
  powerId: PowerId | null;
  criminal?: boolean;
  /** Relative starting influence in the home system (normalised by the generator). */
  influence: number;
  /** The faction that controls the system at the start (exactly one per authored system). */
  controls?: boolean;
  description: string;
}

export interface SystemSpec {
  id: string;
  name: string;
  star: StarSpec;
  bodies: BodySpec[];
  stations: StationSpec[];
  sites: SiteSpec[];
  /** Key of the planet the jump beacon orbits. Omit for the main inhabited planet (or the largest planet). */
  beaconBody?: string;
  baseSecurity: number;
  description: string;
  /** Authored native factions (showpieces). Procedural systems leave this to the generator. */
  factions?: FactionSpec[];
}
