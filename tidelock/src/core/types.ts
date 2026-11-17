// TIDELOCK shared contract types.
//
// These are the STATIC definitions every subsystem agrees on: math primitives, orbital elements,
// the generated universe (systems, bodies, stations), commodities, factions, ships and the derived
// vessel statistics the flight model consumes. Dynamic state types (markets, influence, missions,
// vessels…) are exported by the sim module that owns them.
//
// Conventions (see docs/ARCHITECTURE.md for the full list):
//   * SI units everywhere: metres, seconds, kilograms, radians, newtons, kelvin. Money is credits (cr).
//   * Right-handed axes. The reference plane of every system is XZ and +Y is "north".
//     Prograde orbits run counter-clockwise seen from +Y (from +X toward -Z).
//   * Positions/velocities of anything that moves are relative to the centre of the body whose
//     sphere of influence (SOI) it is in, expressed in the non-rotating system axes.
//   * Ship-local axes: forward = -Z, up = +Y, right = +X. An orientation quaternion maps local -> world.
//   * Colours are linear-light RGB triples in 0..1.

// ---------------------------------------------------------------- math

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Linear RGB, each 0..1 (HDR values above 1 are allowed for emissives). */
export type RGB = [number, number, number];

// ---------------------------------------------------------------- orbits

/**
 * Classical Keplerian elements of an orbit around a parent body.
 * `a` > 0 for ellipses, `a` < 0 for hyperbolas (then `m0` is the hyperbolic mean anomaly).
 * Angles follow the system convention: inclination from the XZ plane, `lan` measured from +X
 * toward -Z (counter-clockwise seen from +Y).
 */
export interface OrbitElements {
  /** Semi-major axis, m. */
  a: number;
  /** Eccentricity (0 = circular). */
  e: number;
  /** Inclination, rad. */
  i: number;
  /** Longitude of the ascending node, rad. */
  lan: number;
  /** Argument of periapsis, rad. */
  argp: number;
  /** Mean anomaly at `epoch`, rad. */
  m0: number;
  /** Epoch of `m0`, sim seconds. */
  epoch: number;
}

export interface StateVector {
  r: V3;
  v: V3;
}

// ---------------------------------------------------------------- bodies

export type BodyKind = 'star' | 'planet' | 'moon';

/**
 * Visual / physical archetype of a body.
 *  star      – the primary (or a companion) star
 *  barren    – airless cratered rock (Luna, Mercury)
 *  rocky     – thin-atmosphere rock with canyons and dust (Mars-like)
 *  desert    – hot dry world with dunes and salt flats
 *  lava      – molten day side, glowing cracks
 *  ice       – frozen shell, fractures (Europa-like)
 *  ocean     – global ocean with scattered archipelagos
 *  terran    – temperate continents, oceans, clouds
 *  eyeball   – tidally locked habitable world: scorched sub-stellar point, temperate terminator ring, frozen night side
 *  gasGiant  – banded hydrogen giant with storms
 *  iceGiant  – smooth methane-blue/teal giant
 */
export type BodyClass =
  | 'star'
  | 'barren'
  | 'rocky'
  | 'desert'
  | 'lava'
  | 'ice'
  | 'ocean'
  | 'terran'
  | 'eyeball'
  | 'gasGiant'
  | 'iceGiant';

export interface AtmosphereDef {
  /** Altitude (m above `radius`) where drag and heating become zero; also the visual shell thickness. */
  height: number;
  /** Exponential scale height, m. */
  scaleHeight: number;
  /** Density at the surface (or 1-bar level for giants), kg/m^3. */
  surfaceDensity: number;
  /** Day-side scattering tint. */
  color: RGB;
  /** Terminator / sunset tint. */
  sunsetColor: RGB;
  /** Visual thickness 0..1 (0.1 = wisp, 1 = dense haze). */
  opacity: number;
  /** Hydrogen-rich: a fuel scoop can harvest propellant here. */
  scoopable: boolean;
}

export interface RingDef {
  /** Inner / outer radius, m from the body centre. */
  innerRadius: number;
  outerRadius: number;
  color: RGB;
  /** Overall opacity 0..1. */
  opacity: number;
  seed: number;
}

/** Parameters that drive the procedural look of a body. All optional fields default sensibly per class. */
export interface BodyVisualDef {
  seed: number;
  /** 3–6 colours. Solid bodies: low -> high elevation. Giants: band colours. */
  palette: RGB[];
  /** Terrain roughness 0..1. */
  roughness?: number;
  /** Fraction of the surface under liquid, 0..1. */
  oceanLevel?: number;
  oceanColor?: RGB;
  /** Polar (or night-side, for eyeball worlds) ice extent 0..1. */
  ice?: number;
  /** Cloud cover 0..1. */
  cloudCover?: number;
  cloudColor?: RGB;
  /** Crater density 0..1. */
  craters?: number;
  /** Emissive lava / crack intensity 0..1. */
  lava?: number;
  /** Night-side settlement glow 0..1 (scales with population). */
  cityLights?: number;
  /** Gas / ice giants: number of latitudinal bands (4..24). */
  bands?: number;
  /** Gas / ice giants: storm intensity 0..1. */
  storms?: number;
}

export interface StarDef {
  /** Effective temperature, K (sets the colour of all light in the system). */
  temperature: number;
  /** Luminosity relative to Sol. */
  luminosity: number;
  /** Spectral class label, e.g. "M4V". */
  spectralClass: string;
  /** Display colour derived from temperature. */
  color: RGB;
  /** Flare activity 0..1 (red dwarfs flare often). */
  activity: number;
}

export interface BodyDef {
  id: string;
  name: string;
  kind: BodyKind;
  cls: BodyClass;
  /** null only for the system's primary star. */
  parentId: string | null;
  /** kg */
  mass: number;
  /** Mean radius, m (surface, or the 1-bar level for giants). */
  radius: number;
  /** Gravitational parameter G*mass, m^3/s^2. */
  mu: number;
  /** Sphere-of-influence radius, m (Infinity for the primary star). */
  soi: number;
  /** Orbit around `parentId` (null for the primary star). */
  orbit: OrbitElements | null;
  /** Sidereal rotation period, s (equals the orbital period when tidally locked). */
  rotationPeriod: number;
  /** Obliquity, rad. */
  axialTilt: number;
  tidallyLocked: boolean;
  atmosphere: AtmosphereDef | null;
  rings: RingDef | null;
  /** Present only when kind === 'star'. */
  star: StarDef | null;
  visual: BodyVisualDef;
  /** Mean surface temperature, K (flavour + survey value). */
  temperature: number;
  /** One or two sentences of lore for the survey / map panel. */
  description: string;
  /** Credits paid by the Survey Office for a detailed orbital survey. */
  surveyValue: number;
}

// ---------------------------------------------------------------- stations & sites

export type EconomyType =
  | 'agriculture'
  | 'extraction'
  | 'refinery'
  | 'industrial'
  | 'hightech'
  | 'service'
  | 'military'
  | 'colony'
  | 'tourism'
  | 'shipyard';

export type StationService =
  | 'market'
  | 'missions'
  | 'outfitting'
  | 'shipyard'
  | 'refuel'
  | 'repair'
  | 'survey'
  | 'legal'
  | 'blackmarket';

/**
 * Station archetypes (see render/space/stations.ts and data/stationLayouts.ts):
 *  ringHabitat – 900 m spoked habitat ring around a docking hub (capital-class city station)
 *  spindle     – 600 m trade spindle: stacked docking bays, counter-rotating drums
 *  refinery    – 700 m industrial platform: tanks, smelter stacks, ore conveyors, radiators
 *  outpost     – 150 m frontier outpost: modular cans, truss, solar wings, 2 small pads
 *  drydock     – 1,000 m open-frame shipyard with a hull under construction
 *  citadel     – 800 m armoured military bastion
 */
export type StationVisualId = 'ringHabitat' | 'spindle' | 'refinery' | 'outpost' | 'drydock' | 'citadel';

export type PadSize = 'S' | 'M' | 'L';

export interface StationDef {
  id: string;
  name: string;
  systemId: string;
  /** Body the station orbits. */
  parentBodyId: string;
  orbit: OrbitElements;
  visualId: StationVisualId;
  visualSeed: number;
  /** Largest ship size that can dock. */
  maxPad: PadSize;
  /** Primary first; markets blend them. */
  economies: EconomyType[];
  population: number;
  services: StationService[];
  description: string;
}

/** A mineable asteroid cluster or ring section on its own orbit. */
export interface MiningSiteDef {
  id: string;
  name: string;
  systemId: string;
  parentBodyId: string;
  orbit: OrbitElements;
  /** 0..1 yield multiplier. */
  richness: number;
  /** Commodity ids of the ores found here with relative weights. */
  ores: { commodityId: string; weight: number }[];
  visualSeed: number;
  /** 'ring' sites sit inside a planet's rings (icy, dense); 'belt' sites are rocky and sparse. */
  kind: 'ring' | 'belt';
}

/** Where ships arrive after a jump: a parking orbit around `bodyId`. */
export interface JumpBeaconDef {
  bodyId: string;
  /** Circular arrival-orbit radius, m from the body centre. */
  orbitRadius: number;
}

export interface SystemDef {
  id: string;
  name: string;
  /** Position in the cluster map, light-years. */
  pos: V3;
  /** First entry is the primary star. Parents always precede their children. */
  bodies: BodyDef[];
  stations: StationDef[];
  miningSites: MiningSiteDef[];
  jumpBeacon: JumpBeaconDef;
  /** Total population across stations and surfaces. */
  population: number;
  /** Baseline security 0 (lawless) .. 1 (heavily patrolled) before faction effects. */
  baseSecurity: number;
  /** Station that anchors the system (controlling faction lives here), if inhabited. */
  capitalStationId: string | null;
  description: string;
  /** Seed for the sky (nebulae, star density) seen from this system. */
  skySeed: number;
}

// ---------------------------------------------------------------- politics

export type Government =
  | 'democracy'
  | 'corporate'
  | 'cooperative'
  | 'technocracy'
  | 'patronage'
  | 'dictatorship'
  | 'theocracy'
  | 'confederacy'
  | 'anarchy';

/** The three great powers of the Ember Reach (plus none). */
export type PowerId = 'assembly' | 'hegemony' | 'league';

export interface PowerDef {
  id: PowerId;
  name: string;
  /** Short name for tight UI, e.g. "Assembly". */
  shortName: string;
  color: RGB;
  capitalSystemId: string;
  ethos: string;
  description: string;
}

export interface FactionDef {
  id: string;
  name: string;
  government: Government;
  /** Power this faction is aligned with, or null for independents. */
  powerId: PowerId | null;
  homeSystemId: string;
  color: RGB;
  description: string;
  /** Pirate/outlaw factions never hold stations lawfully and spawn raiders. */
  criminal: boolean;
}

// ---------------------------------------------------------------- economy

export type CommodityCategory =
  | 'food'
  | 'minerals'
  | 'metals'
  | 'chemicals'
  | 'machinery'
  | 'technology'
  | 'medicine'
  | 'consumer'
  | 'energy'
  | 'weapons'
  | 'salvage'
  | 'contraband';

export interface CommodityDef {
  id: string;
  name: string;
  category: CommodityCategory;
  /** Galactic average price per tonne, cr. */
  basePrice: number;
  /** Illegal under these governments (scans there mean fines and reputation loss). */
  illegalUnder: Government[];
  /** Can be mined from asteroids. */
  mineable: boolean;
  description: string;
}

/** One cargo unit is one tonne. */
export const CARGO_UNIT_MASS = 1000;

// ---------------------------------------------------------------- ships

/**
 * Hull designs. Silhouettes are described in docs/ARCHITECTURE.md; geometry lives in
 * render/space/ships.ts, physical layout (nozzles, hardpoints, radius) in data/shipLayouts.ts,
 * stats in sim/ships.ts.
 */
export type ShipVisualId = 'wren' | 'drover' | 'magpie' | 'shrike' | 'albatross' | 'caravel' | 'halberd';

export type ShipRole = 'courier' | 'hauler' | 'miner' | 'fighter' | 'explorer' | 'freighter' | 'gunship';

export type ModuleSlotType =
  | 'engine' // main drive: thrust + exhaust velocity
  | 'rcs' // manoeuvring thrusters + reaction wheels
  | 'reactor' // power
  | 'tank' // propellant
  | 'cargo' // cargo racks
  | 'shield'
  | 'armor'
  | 'weapon' // hardpoint
  | 'radiator' // heat rejection
  | 'jump' // jump drive
  | 'computer' // flight computer tiers
  | 'scanner' // survey / cargo / combat sensors
  | 'utility'; // mining laser, refinery, fuel scoop, heat shield, docking computer…

export interface ModuleSlot {
  type: ModuleSlotType;
  /** 1 (small) .. 4 (capital). A module fits a slot of its size or larger. */
  size: number;
}

export interface ShipDef {
  id: ShipVisualId;
  name: string;
  manufacturer: string;
  role: ShipRole;
  /** Hull price without modules, cr. */
  price: number;
  /** Bare hull mass, kg. */
  hullMass: number;
  /** Hull integrity points. */
  hull: number;
  pad: PadSize;
  slots: ModuleSlot[];
  /** Module ids fitted when bought new, index-aligned with `slots` (null = empty). */
  defaultLoadout: (string | null)[];
  /** Aerodynamic reference area * Cd, m^2 (aerobraking drag). */
  dragArea: number;
  /** Overall length, m. */
  length: number;
  description: string;
}

/**
 * Everything the flight model needs to know about a fitted ship, derived by sim/ships.ts from a
 * ShipDef + fitted modules. Cargo and propellant masses are added on top by the vessel state.
 */
export interface VesselStats {
  /** Hull + modules, kg (no propellant, no cargo). */
  dryMass: number;
  /** Propellant capacity, kg. One tank feeds the main drive, RCS and the jump drive. */
  fuelCapacity: number;
  /** Main drive thrust at full throttle, N. */
  mainThrust: number;
  /** Main drive exhaust velocity, m/s (Isp * g0). */
  exhaustVelocity: number;
  /** Translational RCS thrust per axis, N. */
  rcsThrust: number;
  /** RCS exhaust velocity, m/s. */
  rcsExhaustVelocity: number;
  /** Peak angular acceleration, rad/s^2 (at dry mass; scales down with total mass). */
  maxAngularAccel: number;
  /** Flight-computer rate limit, rad/s. */
  maxAngularRate: number;
  hullMax: number;
  armor: number;
  shieldMax: number;
  /** Shield points regenerated per second (after a recharge delay). */
  shieldRegen: number;
  /** Reactor output, MW, and total draw of fitted modules, MW. */
  powerOutput: number;
  powerDraw: number;
  /** Heat the hull can soak before damage, J-equivalent game units, and steady dissipation per second. */
  heatCapacity: number;
  heatDissipation: number;
  /** Aerobraking: drag area (m^2 * Cd) and heat-flux tolerance multiplier (1 = bare hull). */
  dragArea: number;
  heatShield: number;
  /** Cargo capacity, tonnes. */
  cargoCapacity: number;
  /** Maximum single-jump range, light-years (0 = no jump drive). */
  jumpRange: number;
  /** Propellant burned per light-year jumped, kg. */
  jumpFuelPerLy: number;
  /** Sensor range for resolving contacts, m. */
  sensorRange: number;
  /** Flight computer tier 0..3 (0 manual + node execution, 1 planners, 2 rendezvous, 3 full autopilot & docking). */
  computerTier: number;
  /** Collision radius, m. */
  radius: number;
  hasFuelScoop: boolean;
  hasMiningLaser: boolean;
  hasRefinery: boolean;
  hasSurveyScanner: boolean;
  hasDockingComputer: boolean;
}

// ---------------------------------------------------------------- physical layouts (pure data)

/**
 * Physical layout of a hull, shared by the renderer (where to put plumes, lights, cameras) and the
 * simulation (collision radius, docking collar). Lives in src/data/shipLayouts.ts — no three.js imports.
 * All positions are ship-local metres (forward = -Z, up = +Y, right = +X; origin at the centre of mass).
 */
export interface ShipLayout {
  id: ShipVisualId;
  /** Overall dimensions, m. */
  length: number;
  width: number;
  height: number;
  /** Bounding / collision sphere radius, m. */
  radius: number;
  /** Main drive nozzles; exhaust leaves toward +Z. */
  engines: { pos: V3; radius: number }[];
  /** RCS quads: position and the direction the jet fires. */
  rcs: { pos: V3; dir: V3 }[];
  /** Weapon mounts, index-aligned with the ShipDef's 'weapon' slots. */
  hardpoints: { pos: V3; size: number }[];
  /** Docking collar: position and outward normal. */
  dockingPort: { pos: V3; dir: V3 };
  /** Pilot eye point for the cockpit camera. */
  cockpit: V3;
  /** Default third-person framing: distance behind and height above the centre, m. */
  chaseCam: { distance: number; height: number };
  /** Navigation / strobe lights. `blink` is the period in seconds (0 = steady). */
  lights: { pos: V3; color: RGB; blink: number }[];
}

export interface DockingPortDef {
  id: string;
  /** Mating point in station-local metres. */
  pos: V3;
  /** Unit vector pointing out of the port: ships approach along -dir and sit at pos + dir * clearance. */
  dir: V3;
  /** Unit "up" for docked ships, perpendicular to dir. */
  up: V3;
  size: PadSize;
}

export interface StationCollider {
  kind: 'sphere' | 'capsule';
  /** Centre (sphere) or first end (capsule), station-local metres. */
  a: V3;
  /** Second end for capsules. */
  b?: V3;
  radius: number;
}

/**
 * Physical layout of a station archetype. Lives in src/data/stationLayouts.ts — no three.js imports.
 * Station-local frame: +Y is the main (spin) axis. The simulation holds stations at a fixed inertial
 * attitude with local +Y along the orbit normal; rotating sections are visual only.
 */
export interface StationLayout {
  visualId: StationVisualId;
  /** Bounding sphere radius, m. */
  radius: number;
  ports: DockingPortDef[];
  /** Coarse collision shapes. */
  colliders: StationCollider[];
  /** Traffic-control zone radius, m: inside it the speed limit applies and docking can be requested. */
  controlZone: number;
}
