// TIDELOCK ship & module catalogue and loadout maths.
//
// What lives here
//   * `SHIPS`    — the seven hulls (docs/ARCHITECTURE.md §7): mass, hull points, typed + sized slots,
//                  the loadout they are sold with.
//   * `MODULES`  — everything that can be bolted into a slot, with `ModuleDef` / `WeaponDef`.
//   * `Loadout`  — `{ shipId, modules }`, index-aligned with the hull's slots, and the pure helpers on
//                  it: `computeStats` (-> core `VesselStats`, the only thing the flight model reads),
//                  `validateLoadout`, `canFit`, prices and resale, Δv / acceleration / jump cost, and the
//                  stat comparisons the outfitting screen shows.
//
// Model (all SI; power in MW, heat in J and W as in sim/physics.ts)
//   dry mass      hull + fitted modules.
//   main drive    thrust adds up; the exhaust velocity is the mass-flow-weighted one, ΣF / Σ(F/vₑ).
//   attitude      peak angular acceleration = Σ torque / (INERTIA_FACTOR · dryMass · length²); the rate
//                 limit is the fastest spin the ship can still arrest within a small stopping angle.
//   heat          capacity = HULL_HEAT_CAPACITY · dryMass (+ heat sinks); rejection = HULL_RADIATION ·
//                 dragArea (+ radiators, − reactor thermal load). Sized against physics.ts: a stock Wren
//                 behaves like twice its 5e9 J / 5e6 W reference ship (the 32 m Wren is two of the old one).
//   jump drive    range = rated range · min(1, √(ratedMass / dryMass)); propellant per light-year scales
//                 with the dry mass being moved. Heavy fits jump shorter.
//   A module only counts while it sits in a slot of its own type and of its size or larger.
//
// Rocket-equation maths is not duplicated here: `deltaV`, `accel`, `propellantFor` and `burnTime` call
// the helpers of sim/physics.ts on a scratch vessel. No three.js, no DOM, no randomness.

import type { ModuleSlot, ModuleSlotType, PadSize, ShipDef, ShipRole, ShipVisualId, VesselStats } from '../core/types';
import { SHIP_LAYOUTS } from '../data/shipLayouts';

// ===================================================================================== constants

/** Heat the structure soaks per kg of dry mass before it starts to fail, J/kg. */
export const HULL_HEAT_CAPACITY = 2.4e5;
/** Heat the bare hull radiates per m² of drag area, W/m². */
export const HULL_RADIATION = 4.0e4;
/** Moment of inertia = INERTIA_FACTOR · dryMass · length² (a slender body about its centre). */
export const INERTIA_FACTOR = 1 / 12;
/** Sensor range of a hull with no scanner fitted, m. */
export const BASE_SENSOR_RANGE = 1.5e5;
/** Jump range falls as (ratedMass / dryMass)^JUMP_MASS_EXPONENT once the ship is heavier than the drive's rating. */
export const JUMP_MASS_EXPONENT = 0.5;
/** Upper bound of the combined heat-shield factor. */
export const HEAT_SHIELD_MAX = 8;
/** Fraction of the list price a station pays for a used module / a bare hull. */
export const MODULE_RESALE = 0.7;
export const HULL_RESALE = 0.8;
/** Flight-computer stopping angle (rad): base and bonus per computer tier. Sets `maxAngularRate`. */
const STOP_ANGLE = 0.18;
const STOP_ANGLE_PER_TIER = 0.02;
const MIN_ANGULAR_RATE = 0.05;
const MAX_ANGULAR_RATE = 1.5;

/** Display names of the slot types. */
export const SLOT_LABELS: Record<ModuleSlotType, string> = {
  engine: 'main drive',
  rcs: 'RCS',
  reactor: 'reactor',
  tank: 'tank',
  cargo: 'cargo',
  shield: 'shield',
  armor: 'armour',
  weapon: 'hardpoint',
  radiator: 'radiator',
  jump: 'jump drive',
  computer: 'flight computer',
  scanner: 'scanner',
  utility: 'utility',
};

// ===================================================================================== types

export type WeaponKind = 'pulse' | 'beam' | 'cannon' | 'rail' | 'missile';

/** Combat statistics of a weapon module (consumed by sim/combat.ts). */
export interface WeaponDef {
  kind: WeaponKind;
  /** Damage per shot (per tick for beams), hit points before the shield / hull multipliers. */
  damage: number;
  /** Damage multiplier against shields / against hull. */
  shieldMult: number;
  hullMult: number;
  /** Effective range, m. */
  range: number;
  /** Projectile speed relative to the firing ship, m/s. `Infinity` = hitscan (lasers). */
  projectileSpeed: number;
  /** Shots (beam ticks) per second. */
  rateOfFire: number;
  /** Energy drawn per shot, MJ (1 MJ = 1 MW for one second). */
  energyPerShot: number;
  /** Waste heat added to the firing ship per shot, J (the unit of `VesselStats.heatCapacity`). */
  heatPerShot: number;
  /** Rounds carried; 0 = needs no ammunition. */
  ammo: number;
  /** Price of one round, cr. */
  ammoPrice: number;
  /** Gimbal (or seeker) half-angle off the mount axis, rad. */
  gimbal: number;
}

/** What a module contributes. Every field is optional; absent = nothing. SI units unless noted. */
export interface ModuleStats {
  /** Main drive: thrust, N, and exhaust velocity, m/s. */
  thrust?: number;
  exhaustVelocity?: number;
  /** RCS: translational thrust per axis, N; exhaust velocity, m/s; attitude torque (thrusters + wheels), N·m. */
  rcsThrust?: number;
  rcsExhaustVelocity?: number;
  torque?: number;
  /** Propellant capacity, kg. */
  fuelCapacity?: number;
  /** Cargo capacity, tonnes. */
  cargoCapacity?: number;
  /** Shield points and points regenerated per second. */
  shield?: number;
  shieldRegen?: number;
  /** Armour rating and extra hull points. */
  armor?: number;
  hull?: number;
  /** Heat rejection, W (negative = thermal load), stored-heat capacity, J, and aerobraking heat-shield factor (multiplies). */
  heatDissipation?: number;
  heatCapacity?: number;
  heatShield?: number;
  /** Jump drive: rated range, ly; heaviest dry mass that still gets it, kg; propellant per ly per tonne of dry mass, kg. */
  jumpRange?: number;
  jumpRatedMass?: number;
  jumpFuelPerLyPerTonne?: number;
  /** Flight computer tier 0..3 (see `VesselStats.computerTier`). */
  computerTier?: number;
  /** Contact-resolving range, m. */
  sensorRange?: number;
  /** Orbital survey speed multiplier (1 = standard). */
  surveyRate?: number;
  /** Ore cut per second, kg/s. */
  miningRate?: number;
  /** Collector / prospector drones carried. */
  limpets?: number;
  surveyScanner?: boolean;
  /** Reads other ships' manifests. */
  cargoScanner?: boolean;
  /** Resolves loadouts and subsystems of contacts; faster weapon locks. */
  combatScanner?: boolean;
  /** Hold is opaque to cargo scans. */
  scanShielded?: boolean;
  fuelScoop?: boolean;
  miningLaser?: boolean;
  refinery?: boolean;
  dockingComputer?: boolean;
}

export interface ModuleDef {
  id: string;
  /** Maker + model + grade, e.g. "Brennan-Sato Tradewind Mk II". The Mk number is the size class. */
  name: string;
  manufacturer: string;
  slotType: ModuleSlotType;
  /** 1..4; fits a slot of this size or larger. */
  size: number;
  /** kg */
  mass: number;
  /** List price, cr. */
  price: number;
  /** Electrical draw, MW, and (reactors) output, MW. */
  powerDraw: number;
  powerOutput: number;
  stats: ModuleStats;
  /** Technology tier 1..4: how advanced a shipyard must be to stock it. */
  tier: number;
  /** Present on weapon modules only. */
  weapon?: WeaponDef;
  /** Modules sharing a `unique` key do not stack: only the first one fitted counts. */
  unique?: string;
  description: string;
}

/** A hull and what is fitted to it: `modules[i]` is the id in `SHIPS[shipId].slots[i]` (null = empty). */
export interface Loadout {
  shipId: ShipVisualId;
  modules: (string | null)[];
}

export type LoadoutProblemCode =
  | 'unknown-ship'
  | 'slot-count'
  | 'unknown-module'
  | 'slot-type'
  | 'slot-size'
  | 'duplicate'
  | 'no-engine'
  | 'no-rcs'
  | 'no-reactor'
  | 'no-tank'
  | 'power'
  | 'no-jump'
  | 'jump-overmass';

export interface LoadoutProblem {
  code: LoadoutProblemCode;
  /** 'error' = the ship may not launch like this; 'warning' = legal but worth telling the player. */
  severity: 'error' | 'warning';
  /** Offending slot index, or null for whole-ship problems. */
  slot: number | null;
  /** Human-readable, ready for the outfitting screen. */
  message: string;
}

/** One row of a stat comparison. Values are SI (see `unit`); format at the edge. */
export interface StatDelta {
  key: string;
  label: string;
  unit: string;
  from: number;
  to: number;
  delta: number;
  /** +1 the change is an improvement, -1 it is worse, 0 neutral / unchanged. */
  verdict: -1 | 0 | 1;
}

export interface FittedWeapon {
  /** Slot index in the loadout. */
  slot: number;
  /** Index among the hull's weapon slots = index into `ShipLayout.hardpoints`. */
  hardpoint: number;
  module: ModuleDef;
  weapon: WeaponDef;
}

// ===================================================================================== module catalogue

const ROMAN = ['', 'I', 'II', 'III', 'IV'];

function mod(
  id: string,
  manufacturer: string,
  model: string,
  slotType: ModuleSlotType,
  size: number,
  tier: number,
  mass: number,
  price: number,
  powerDraw: number,
  stats: ModuleStats,
  description: string,
  extra: { powerOutput?: number; weapon?: WeaponDef; unique?: string; grade?: string } = {},
): ModuleDef {
  const def: ModuleDef = {
    id,
    name: `${manufacturer} ${model} Mk ${extra.grade ?? ROMAN[size]}`,
    manufacturer,
    slotType,
    size,
    mass,
    price,
    powerDraw,
    powerOutput: extra.powerOutput ?? 0,
    stats,
    tier,
    description,
  };
  if (extra.weapon) def.weapon = extra.weapon;
  if (extra.unique) def.unique = extra.unique;
  return def;
}

const DEG = Math.PI / 180;

function wpn(
  kind: WeaponKind,
  damage: number,
  shieldMult: number,
  hullMult: number,
  range: number,
  projectileSpeed: number,
  rateOfFire: number,
  energyPerShot: number,
  heatPerShot: number,
  ammo: number,
  ammoPrice: number,
  gimbalDeg: number,
): { weapon: WeaponDef } {
  return { weapon: { kind, damage, shieldMult, hullMult, range, projectileSpeed, rateOfFire, energyPerShot, heatPerShot, ammo, ammoPrice, gimbal: gimbalDeg * DEG } };
}

// Makers.
const TARN = 'Tarn Reaction Works';
const HEARTH = 'Hearthline';
const VOSS = 'Voss-Ilyin';
const BRENNAN = 'Brennan-Sato';
const ILMARIN = 'Ilmarin';
const CALDER = 'Calder Dynamics';
const OSEI = 'Osei Thermal';
const LUMEN = 'Lumen Forge';
const PALLAS = 'Pallas Cryo';
const HADLEY = 'Hadley-Okafor';
const SABLE = 'Sablewright Fieldworks';
const AURIC = 'Auric Arsenal';
const STILL = 'Stillwater';
const LONG = 'Longreach Foundry';
const KITE = 'Kite & Lantern';
const GREY = 'Greywether Optics';
const MOSS = 'Mossgate Industrial';
const ASH = 'Ashfall Ordnance';

// Family descriptions (shared by every size of a family).
const D_CHEM = 'Methalox booster. Enormous thrust from a light, cheap engine that needs almost no power, and a thirst that empties a tank in minutes.';
const D_NTR = 'Solid-core nuclear-thermal drive. Strong thrust on a self-powered core at twice a chemical engine\'s exhaust velocity; heavy, cheap and good for short hauls.';
const D_PULSE = 'Pulsed fusion drive tuned for thrust. Twice a torch\'s push at three-quarters of its exhaust velocity, and it wants a great deal of power.';
const D_TORCH = 'Steady-burn fusion torch, the Reach\'s everyday drive: balanced thrust and exhaust velocity for a reasonable power bill.';
const D_CRUISE = 'Magnetic-nozzle cruise drive. Less than half a torch\'s thrust, half again its exhaust velocity: the choice when Δv matters more than hurry.';
const D_RCS = 'Monopropellant thruster quads with a reaction-wheel pack. Dependable, cheap, unremarkable.';
const D_RCS_AGILE = 'Hot-gas combat thrusters and oversized control-moment gyros. Far more authority than the standard pack for more mass, power and money.';
const D_RCS_ARC = 'Arcjet thrusters: nearly three times the exhaust velocity of monopropellant for half the push and a real power draw.';
const D_RCT = 'Pebble-bed fission plant. Runs cool, lasts decades, and is the baseline every power budget is drawn against.';
const D_RCT_HI = 'Compact fusion plant: half again the output from the same bay. Heavier, far dearer, and its waste heat eats into the radiator budget.';
const D_TANK = 'Insulated liquid-hydrogen tank with boil-off recovery.';
const D_TANK_SLUSH = 'Slush-hydrogen tank: about 30% more propellant in the same bay, at the cost of mass and a refrigeration load.';
const D_CARGO = 'Open rack for standard one-tonne cargo units.';
const D_CARGO_QUIET = 'Lined hold that returns a clean, empty echo to cargo scanners. Holds less than a rack and costs considerably more.';
const D_CARGO_FUEL = 'Bladder tank that fills a cargo bay with propellant instead of freight: range bought with payload.';
const D_SHIELD = 'Standing deflector field: a deep reserve that recovers at a steady pace once the ship stops taking fire.';
const D_SHIELD_RAPID = 'Fast-cycling deflector: a shallower field that rebuilds more than twice as quickly. It draws more power.';
const D_ARMOR = 'Bolt-on steel-ceramic plate. Stops a lot, weighs a lot.';
const D_ARMOR_CERAMIC = 'Ablative ceramic skin: lighter and thinner than plate, and it sheds re-entry heat as well as gunfire.';
const D_RAD = 'Fold-out panel radiator on a pumped loop.';
const D_RAD_DROP = 'Liquid-droplet radiator: much more rejection per kilogram than panels, for a pump load and a steep price.';
const D_RAD_SINK = 'Phase-change heat sink. Rejects little by itself but soaks a great deal: for ships that take heat in bursts.';
const D_JUMP = 'General-purpose jump drive. Reaches its rated range only while the ship is no heavier than its mass rating.';
const D_JUMP_LR = 'Long-baseline jump drive with a low mass rating: superb range and economy on a light ship, wasted on a heavy one.';
const D_JUMP_ECO = 'Short-hop jump drive: light, cheap, generous mass rating, thirsty and short-ranged.';
const D_CANNON = 'Autocannon. Poor against shields, punishing against hull, almost free of heat; limited by its magazine.';
const D_PULSE_LASER = 'Pulse laser. Instant, accurate and strongest against shields; every shot costs capacitor and heat.';
const D_BEAM = 'Continuous beam laser. The highest sustained damage against shields at short range, and the fastest way to overheat.';
const D_RAIL = 'Coilgun firing a dense penetrator. Long reach and a heavy hit on hull for a large energy and heat spike; nearly fixed mount.';
const D_MISSILE = 'Guided missile rack. Heavy hull damage at long range from a small magazine; weak against shields.';

const INF = Infinity;

const MODULE_LIST: ModuleDef[] = [
  // ---------------------------------------------------------------- main drives (thrust vs exhaust velocity)
  mod('eng_chem_1', TARN, 'Firebrand', 'engine', 1, 1, 850, 3200, 0.2, { thrust: 1.5e6, exhaustVelocity: 4500 }, D_CHEM),
  mod('eng_chem_2', TARN, 'Firebrand', 'engine', 2, 1, 2200, 9000, 0.4, { thrust: 3.6e6, exhaustVelocity: 4550 }, D_CHEM),
  mod('eng_ntr_1', HEARTH, 'Kiln', 'engine', 1, 1, 2700, 6800, 0.4, { thrust: 9.5e5, exhaustVelocity: 9600 }, D_NTR),
  mod('eng_ntr_2', HEARTH, 'Kiln', 'engine', 2, 1, 7000, 19000, 0.8, { thrust: 2.3e6, exhaustVelocity: 10200 }, D_NTR),
  mod('eng_ntr_3', HEARTH, 'Kiln', 'engine', 3, 2, 19000, 58000, 1.6, { thrust: 5.7e6, exhaustVelocity: 11000 }, D_NTR),
  mod('eng_ntr_4', HEARTH, 'Kiln', 'engine', 4, 2, 48000, 175000, 3.2, { thrust: 1.33e7, exhaustVelocity: 11800 }, D_NTR),
  mod('eng_pulse_1', VOSS, 'Mallet', 'engine', 1, 3, 2900, 24000, 8, { thrust: 8.0e5, exhaustVelocity: 25000 }, D_PULSE),
  mod('eng_pulse_2', VOSS, 'Mallet', 'engine', 2, 3, 7500, 67000, 17, { thrust: 1.92e6, exhaustVelocity: 25500 }, D_PULSE),
  mod('eng_pulse_3', VOSS, 'Mallet', 'engine', 3, 3, 20000, 205000, 38, { thrust: 4.8e6, exhaustVelocity: 26000 }, D_PULSE),
  mod('eng_torch_1', BRENNAN, 'Tradewind', 'engine', 1, 2, 2400, 9800, 5, { thrust: 4.0e5, exhaustVelocity: 34000 }, D_TORCH),
  mod('eng_torch_2', BRENNAN, 'Tradewind', 'engine', 2, 2, 6200, 28000, 11, { thrust: 9.6e5, exhaustVelocity: 34000 }, D_TORCH),
  mod('eng_torch_3', BRENNAN, 'Tradewind', 'engine', 3, 2, 16800, 84000, 25, { thrust: 2.4e6, exhaustVelocity: 35000 }, D_TORCH),
  mod('eng_torch_4', BRENNAN, 'Tradewind', 'engine', 4, 3, 43000, 255000, 55, { thrust: 5.6e6, exhaustVelocity: 36000 }, D_TORCH),
  mod('eng_cruise_1', ILMARIN, 'Longwake', 'engine', 1, 3, 2700, 36000, 6, { thrust: 1.9e5, exhaustVelocity: 52000 }, D_CRUISE),
  mod('eng_cruise_2', ILMARIN, 'Longwake', 'engine', 2, 3, 7000, 100000, 13, { thrust: 4.56e5, exhaustVelocity: 55000 }, D_CRUISE),
  mod('eng_cruise_3', ILMARIN, 'Longwake', 'engine', 3, 4, 18900, 300000, 30, { thrust: 1.14e6, exhaustVelocity: 58000 }, D_CRUISE),

  // ---------------------------------------------------------------- RCS + reaction wheels
  mod('rcs_std_1', CALDER, 'Tern', 'rcs', 1, 1, 600, 2400, 0.3, { rcsThrust: 34000, rcsExhaustVelocity: 2400, torque: 4.6e5 }, D_RCS),
  mod('rcs_std_2', CALDER, 'Tern', 'rcs', 2, 1, 1700, 7500, 0.7, { rcsThrust: 100000, rcsExhaustVelocity: 2400, torque: 2.4e6 }, D_RCS),
  mod('rcs_std_3', CALDER, 'Tern', 'rcs', 3, 1, 4500, 24000, 1.6, { rcsThrust: 300000, rcsExhaustVelocity: 2400, torque: 1.0e7 }, D_RCS),
  mod('rcs_std_4', CALDER, 'Tern', 'rcs', 4, 2, 11000, 75000, 3.5, { rcsThrust: 920000, rcsExhaustVelocity: 2400, torque: 3.6e7 }, D_RCS),
  mod('rcs_agile_1', CALDER, 'Dervish', 'rcs', 1, 3, 800, 9500, 0.8, { rcsThrust: 60000, rcsExhaustVelocity: 2900, torque: 7.6e5 }, D_RCS_AGILE),
  mod('rcs_agile_2', CALDER, 'Dervish', 'rcs', 2, 3, 2300, 28000, 1.8, { rcsThrust: 170000, rcsExhaustVelocity: 2900, torque: 4.0e6 }, D_RCS_AGILE),
  mod('rcs_agile_3', CALDER, 'Dervish', 'rcs', 3, 3, 6000, 88000, 4, { rcsThrust: 510000, rcsExhaustVelocity: 2900, torque: 1.7e7 }, D_RCS_AGILE),
  mod('rcs_arc_1', OSEI, 'Whisper', 'rcs', 1, 2, 650, 6800, 1.2, { rcsThrust: 19000, rcsExhaustVelocity: 6500, torque: 4.4e5 }, D_RCS_ARC),
  mod('rcs_arc_2', OSEI, 'Whisper', 'rcs', 2, 2, 1850, 20000, 2.6, { rcsThrust: 55000, rcsExhaustVelocity: 6500, torque: 2.3e6 }, D_RCS_ARC),

  // ---------------------------------------------------------------- reactors
  mod('rct_std_1', HEARTH, 'Cinderbed', 'reactor', 1, 1, 1800, 4800, 0, {}, D_RCT, { powerOutput: 14 }),
  mod('rct_std_2', HEARTH, 'Cinderbed', 'reactor', 2, 1, 4200, 16000, 0, {}, D_RCT, { powerOutput: 36 }),
  mod('rct_std_3', HEARTH, 'Cinderbed', 'reactor', 3, 2, 10000, 56000, 0, {}, D_RCT, { powerOutput: 90 }),
  mod('rct_std_4', HEARTH, 'Cinderbed', 'reactor', 4, 2, 24000, 190000, 0, {}, D_RCT, { powerOutput: 220 }),
  mod('rct_hi_1', LUMEN, 'Daystar', 'reactor', 1, 3, 2100, 22000, 0, { heatDissipation: -0.6e6 }, D_RCT_HI, { powerOutput: 21 }),
  mod('rct_hi_2', LUMEN, 'Daystar', 'reactor', 2, 3, 4900, 72000, 0, { heatDissipation: -1.5e6 }, D_RCT_HI, { powerOutput: 54 }),
  mod('rct_hi_3', LUMEN, 'Daystar', 'reactor', 3, 4, 11500, 240000, 0, { heatDissipation: -3.5e6 }, D_RCT_HI, { powerOutput: 135 }),

  // ---------------------------------------------------------------- propellant tanks
  mod('tank_std_1', PALLAS, 'Cistern', 'tank', 1, 1, 280, 900, 0, { fuelCapacity: 5000 }, D_TANK),
  mod('tank_std_2', PALLAS, 'Cistern', 'tank', 2, 1, 600, 2100, 0, { fuelCapacity: 12000 }, D_TANK),
  mod('tank_std_3', PALLAS, 'Cistern', 'tank', 3, 1, 1500, 5600, 0, { fuelCapacity: 32000 }, D_TANK),
  mod('tank_std_4', PALLAS, 'Cistern', 'tank', 4, 1, 4000, 16000, 0, { fuelCapacity: 90000 }, D_TANK),
  mod('tank_slush_1', PALLAS, 'Deepcold', 'tank', 1, 3, 420, 5200, 0.3, { fuelCapacity: 6500 }, D_TANK_SLUSH),
  mod('tank_slush_2', PALLAS, 'Deepcold', 'tank', 2, 3, 900, 12500, 0.6, { fuelCapacity: 15600 }, D_TANK_SLUSH),
  mod('tank_slush_3', PALLAS, 'Deepcold', 'tank', 3, 3, 2250, 33000, 1.2, { fuelCapacity: 41500 }, D_TANK_SLUSH),

  // ---------------------------------------------------------------- cargo bays
  mod('cargo_rack_1', ILMARIN, 'Packframe', 'cargo', 1, 1, 500, 1200, 0, { cargoCapacity: 8 }, D_CARGO),
  mod('cargo_rack_2', ILMARIN, 'Packframe', 'cargo', 2, 1, 1300, 3800, 0, { cargoCapacity: 24 }, D_CARGO),
  mod('cargo_rack_3', ILMARIN, 'Packframe', 'cargo', 3, 1, 2400, 8500, 0, { cargoCapacity: 48 }, D_CARGO),
  mod('cargo_rack_4', ILMARIN, 'Packframe', 'cargo', 4, 1, 5500, 24000, 0, { cargoCapacity: 140 }, D_CARGO),
  mod('cargo_quiet_1', HADLEY, 'Quiet Hold', 'cargo', 1, 2, 700, 8500, 0.1, { cargoCapacity: 5, scanShielded: true }, D_CARGO_QUIET),
  mod('cargo_quiet_2', HADLEY, 'Quiet Hold', 'cargo', 2, 3, 1800, 24000, 0.2, { cargoCapacity: 15, scanShielded: true }, D_CARGO_QUIET),
  mod('cargo_fuel_1', PALLAS, 'Saddlebag', 'cargo', 1, 1, 450, 2600, 0, { fuelCapacity: 6000 }, D_CARGO_FUEL),
  mod('cargo_fuel_2', PALLAS, 'Saddlebag', 'cargo', 2, 1, 1150, 7200, 0, { fuelCapacity: 17000 }, D_CARGO_FUEL),
  mod('cargo_fuel_3', PALLAS, 'Saddlebag', 'cargo', 3, 2, 2200, 15500, 0, { fuelCapacity: 34000 }, D_CARGO_FUEL),

  // ---------------------------------------------------------------- shields
  mod('shd_std_1', SABLE, 'Parasol', 'shield', 1, 1, 900, 5200, 2.5, { shield: 200, shieldRegen: 5 }, D_SHIELD),
  mod('shd_std_2', SABLE, 'Parasol', 'shield', 2, 2, 1500, 17000, 6, { shield: 480, shieldRegen: 9 }, D_SHIELD),
  mod('shd_std_3', SABLE, 'Parasol', 'shield', 3, 2, 4000, 56000, 14, { shield: 1150, shieldRegen: 17 }, D_SHIELD),
  mod('shd_std_4', SABLE, 'Parasol', 'shield', 4, 3, 9500, 180000, 32, { shield: 2700, shieldRegen: 32 }, D_SHIELD),
  mod('shd_rapid_1', SABLE, 'Flicker', 'shield', 1, 3, 850, 11000, 3.4, { shield: 120, shieldRegen: 12 }, D_SHIELD_RAPID),
  mod('shd_rapid_2', SABLE, 'Flicker', 'shield', 2, 3, 1450, 32000, 8, { shield: 290, shieldRegen: 22 }, D_SHIELD_RAPID),
  mod('shd_rapid_3', SABLE, 'Flicker', 'shield', 3, 4, 3900, 98000, 18, { shield: 700, shieldRegen: 40 }, D_SHIELD_RAPID),

  // ---------------------------------------------------------------- armour
  mod('arm_plate_1', AURIC, 'Scale', 'armor', 1, 1, 1200, 4000, 0, { armor: 60, hull: 150 }, D_ARMOR),
  mod('arm_plate_2', AURIC, 'Scale', 'armor', 2, 1, 3500, 11500, 0, { armor: 140, hull: 350 }, D_ARMOR),
  mod('arm_plate_3', AURIC, 'Scale', 'armor', 3, 2, 12000, 36000, 0, { armor: 300, hull: 800 }, D_ARMOR),
  mod('arm_plate_4', AURIC, 'Scale', 'armor', 4, 2, 30000, 110000, 0, { armor: 620, hull: 1800 }, D_ARMOR),
  mod('arm_ceramic_1', OSEI, 'Emberskin', 'armor', 1, 2, 800, 9000, 0, { armor: 40, hull: 100, heatShield: 1.6 }, D_ARMOR_CERAMIC),
  mod('arm_ceramic_2', OSEI, 'Emberskin', 'armor', 2, 3, 2300, 26000, 0, { armor: 95, hull: 240, heatShield: 1.6 }, D_ARMOR_CERAMIC),
  mod('arm_ceramic_3', OSEI, 'Emberskin', 'armor', 3, 3, 8000, 80000, 0, { armor: 200, hull: 550, heatShield: 1.6 }, D_ARMOR_CERAMIC),

  // ---------------------------------------------------------------- radiators & heat sinks
  mod('rad_std_1', STILL, 'Vane', 'radiator', 1, 1, 450, 2500, 0.2, { heatDissipation: 4.0e6 }, D_RAD),
  mod('rad_std_2', STILL, 'Vane', 'radiator', 2, 1, 1100, 7500, 0.4, { heatDissipation: 1.0e7 }, D_RAD),
  mod('rad_std_3', STILL, 'Vane', 'radiator', 3, 2, 2400, 23000, 0.8, { heatDissipation: 2.6e7 }, D_RAD),
  mod('rad_std_4', STILL, 'Vane', 'radiator', 4, 2, 5500, 70000, 1.6, { heatDissipation: 6.2e7 }, D_RAD),
  mod('rad_drop_2', STILL, 'Rainline', 'radiator', 2, 3, 1300, 26000, 1.5, { heatDissipation: 1.7e7 }, D_RAD_DROP),
  mod('rad_drop_3', STILL, 'Rainline', 'radiator', 3, 4, 2900, 80000, 3.2, { heatDissipation: 4.4e7 }, D_RAD_DROP),
  mod('rad_sink_1', OSEI, 'Coldwell', 'radiator', 1, 2, 700, 6000, 0.1, { heatDissipation: 1.2e6, heatCapacity: 2.5e9 }, D_RAD_SINK),
  mod('rad_sink_2', OSEI, 'Coldwell', 'radiator', 2, 2, 1700, 17000, 0.2, { heatDissipation: 3.0e6, heatCapacity: 6.5e9 }, D_RAD_SINK),

  // ---------------------------------------------------------------- jump drives
  mod('jmp_std_1', LONG, 'Lodestar', 'jump', 1, 1, 1600, 7200, 1.5, { jumpRange: 7, jumpRatedMass: 24000, jumpFuelPerLyPerTonne: 14 }, D_JUMP),
  mod('jmp_std_2', LONG, 'Lodestar', 'jump', 2, 1, 4200, 30000, 3.5, { jumpRange: 8, jumpRatedMass: 115000, jumpFuelPerLyPerTonne: 13 }, D_JUMP),
  mod('jmp_std_3', LONG, 'Lodestar', 'jump', 3, 2, 10000, 95000, 6.5, { jumpRange: 9, jumpRatedMass: 200000, jumpFuelPerLyPerTonne: 12 }, D_JUMP),
  mod('jmp_std_4', LONG, 'Lodestar', 'jump', 4, 2, 22000, 260000, 12, { jumpRange: 7.5, jumpRatedMass: 660000, jumpFuelPerLyPerTonne: 11 }, D_JUMP),
  mod('jmp_lr_1', LONG, 'Deepfield', 'jump', 1, 3, 2300, 38000, 2.5, { jumpRange: 10.5, jumpRatedMass: 20000, jumpFuelPerLyPerTonne: 10 }, D_JUMP_LR),
  mod('jmp_lr_2', LONG, 'Deepfield', 'jump', 2, 4, 4800, 120000, 5, { jumpRange: 16, jumpRatedMass: 44000, jumpFuelPerLyPerTonne: 9 }, D_JUMP_LR),
  mod('jmp_lr_3', LONG, 'Deepfield', 'jump', 3, 4, 11500, 340000, 9, { jumpRange: 15, jumpRatedMass: 150000, jumpFuelPerLyPerTonne: 9 }, D_JUMP_LR),
  mod('jmp_eco_1', LONG, 'Skiff', 'jump', 1, 1, 900, 3000, 1, { jumpRange: 4.5, jumpRatedMass: 30000, jumpFuelPerLyPerTonne: 18 }, D_JUMP_ECO),
  mod('jmp_eco_2', LONG, 'Skiff', 'jump', 2, 1, 2400, 11000, 2.2, { jumpRange: 5.5, jumpRatedMass: 130000, jumpFuelPerLyPerTonne: 17 }, D_JUMP_ECO),

  // ---------------------------------------------------------------- flight computers (Mk I..IV = tier 0..3)
  mod('cmp_0', KITE, 'Almanac', 'computer', 1, 1, 40, 600, 0.1, { computerTier: 0 },
    'Attitude holds and timed execution of manoeuvre nodes you plot yourself. Everything else is the pilot.', { grade: 'I' }),
  mod('cmp_1', KITE, 'Almanac', 'computer', 1, 1, 60, 3200, 0.2, { computerTier: 1 },
    'Adds the planners: circularise, Hohmann and Lambert transfers, plane matches, interplanetary windows, capture.', { grade: 'II' }),
  mod('cmp_2', KITE, 'Almanac', 'computer', 1, 2, 90, 6800, 0.3, { computerTier: 2 },
    'Adds rendezvous planning and guidance: phasing, intercepts and matched-velocity arrivals at stations and ships.', { grade: 'III' }),
  mod('cmp_3', KITE, 'Almanac', 'computer', 1, 3, 130, 9600, 0.5, { computerTier: 3 },
    'Full autopilot: flies any plan end to end, including the approach, and will hand a docking to the docking computer.', { grade: 'IV' }),

  // ---------------------------------------------------------------- scanners
  mod('scn_nav_1', GREY, 'Lookout', 'scanner', 1, 1, 80, 900, 0.2, { sensorRange: 4.0e5 },
    'Navigation radar and transponder interrogator. Resolves traffic well beyond visual range.'),
  mod('scn_survey_1', GREY, 'Cartographer', 'scanner', 1, 2, 220, 8500, 0.6, { sensorRange: 5.0e5, surveyScanner: true, surveyRate: 1 },
    'Multispectral mapping array for orbital surveys the Survey Office will pay for.'),
  mod('scn_survey_2', GREY, 'Cartographer', 'scanner', 2, 3, 520, 34000, 1.4, { sensorRange: 8.0e5, surveyScanner: true, surveyRate: 2.5 },
    'Wide-swath survey array: maps a world in well under half the orbits of the small set.'),
  mod('scn_cargo_1', GREY, 'Tallyman', 'scanner', 1, 2, 150, 5200, 0.5, { sensorRange: 3.0e5, cargoScanner: true },
    'Manifest scanner. Reads what another ship is carrying; customs cutters and pirates both swear by it.'),
  mod('scn_combat_1', GREY, 'Falconer', 'scanner', 1, 2, 260, 11000, 1, { sensorRange: 1.2e6, combatScanner: true },
    'Fire-control radar: long detection range, subsystem resolution and quicker weapon locks.'),
  mod('scn_combat_2', GREY, 'Falconer', 'scanner', 2, 3, 600, 42000, 2.2, { sensorRange: 2.5e6, combatScanner: true },
    'Warship-grade fire-control array. Sees a drive plume across a planetary system\'s inner traffic lanes.'),

  // ---------------------------------------------------------------- utilities
  mod('utl_dock', KITE, 'Harbour Pilot', 'utility', 1, 1, 90, 1800, 0.1, { dockingComputer: true },
    'Docking computer: takes clearance, flies the approach axis and soft-captures without scuffing the paint.', { unique: 'docking computer', grade: 'I' }),
  mod('utl_scoop', PALLAS, 'Gulper', 'utility', 1, 2, 800, 14000, 0.6, { fuelScoop: true },
    'Ram scoop and cryo-compressor. Skims propellant from the upper atmosphere of a hydrogen giant, if the hull survives the pass.', { unique: 'fuel scoop', grade: 'I' }),
  mod('utl_heat_1', OSEI, 'Charcoat', 'utility', 1, 1, 900, 5500, 0, { heatShield: 2.5 },
    'Ablative belly shield. Lets a hull take two and a half times the aerobraking heat flux.', { unique: 'heat shield' }),
  mod('utl_heat_2', OSEI, 'Emberglass', 'utility', 2, 3, 2200, 26000, 0, { heatShield: 4 },
    'Reusable ceramic aeroshell: four times the bare hull\'s heat tolerance for a deep, fast capture pass.', { unique: 'heat shield' }),
  mod('utl_mining_1', MOSS, 'Borer', 'utility', 1, 1, 1400, 12000, 4, { miningLaser: true, miningRate: 8 },
    'Cutting laser on an articulated boom. Breaks ore from asteroids and ring ice.'),
  mod('utl_mining_2', MOSS, 'Borer', 'utility', 2, 2, 3200, 46000, 9, { miningLaser: true, miningRate: 22 },
    'Twin-aperture cutting laser: nearly three times the yield per hour, with the power bill to match.'),
  mod('utl_refinery', MOSS, 'Crucible', 'utility', 2, 2, 3000, 38000, 5, { refinery: true },
    'On-board smelter. Refines ore into metal in the hold, so the same tonnage sells for several times as much.', { unique: 'refinery', grade: 'I' }),
  mod('utl_limpet_1', MOSS, 'Limpet Bay', 'utility', 1, 2, 600, 6500, 0.4, { limpets: 4 },
    'Rack of four tethered drones that prospect rocks and fetch loose cargo and ore fragments.'),
  mod('utl_limpet_2', MOSS, 'Limpet Bay', 'utility', 2, 2, 1400, 19000, 0.8, { limpets: 10 },
    'Ten-drone bay with a faster recovery arm.'),

  // ---------------------------------------------------------------- weapons
  mod('wpn_pulse_1', LUMEN, 'Stiletto', 'weapon', 1, 1, 300, 4200, 1.2, {}, D_PULSE_LASER, wpn('pulse', 14, 1.2, 0.8, 5000, INF, 3, 5, 3.4e6, 0, 0, 6)),
  mod('wpn_pulse_2', LUMEN, 'Stiletto', 'weapon', 2, 2, 650, 14000, 2.6, {}, D_PULSE_LASER, wpn('pulse', 30, 1.2, 0.8, 6000, INF, 2.6, 11, 7.5e6, 0, 0, 5)),
  mod('wpn_pulse_3', LUMEN, 'Stiletto', 'weapon', 3, 3, 1500, 46000, 6, {}, D_PULSE_LASER, wpn('pulse', 66, 1.2, 0.8, 7000, INF, 2.2, 25, 1.7e7, 0, 0, 4)),
  mod('wpn_beam_1', LUMEN, 'Lathe', 'weapon', 1, 2, 380, 9500, 2, {}, D_BEAM, wpn('beam', 5.5, 1.4, 0.6, 3500, INF, 10, 2.2, 1.6e6, 0, 0, 8)),
  mod('wpn_beam_2', LUMEN, 'Lathe', 'weapon', 2, 3, 800, 31000, 4.4, {}, D_BEAM, wpn('beam', 11.5, 1.4, 0.6, 4200, INF, 10, 4.6, 3.3e6, 0, 0, 7)),
  mod('wpn_cannon_1', ASH, 'Hailer', 'weapon', 1, 1, 420, 3600, 0.3, {}, D_CANNON, wpn('cannon', 27, 0.6, 1.4, 3000, 1800, 1.6, 0.3, 6.0e5, 240, 6, 4)),
  mod('wpn_cannon_2', ASH, 'Hailer', 'weapon', 2, 2, 900, 11500, 0.6, {}, D_CANNON, wpn('cannon', 62, 0.6, 1.4, 3600, 1900, 1.3, 0.7, 1.4e6, 180, 14, 3.5)),
  mod('wpn_cannon_3', ASH, 'Hailer', 'weapon', 3, 2, 2100, 38000, 1.2, {}, D_CANNON, wpn('cannon', 150, 0.6, 1.4, 4200, 2000, 0.9, 1.6, 3.2e6, 120, 34, 3)),
  mod('wpn_rail_2', AURIC, 'Longspike', 'weapon', 2, 3, 1100, 44000, 5, {}, D_RAIL, wpn('rail', 190, 0.9, 1.5, 10000, 7000, 0.33, 60, 2.4e7, 40, 60, 1)),
  mod('wpn_rail_3', AURIC, 'Longspike', 'weapon', 3, 4, 2600, 140000, 11, {}, D_RAIL, wpn('rail', 460, 0.9, 1.5, 12000, 8000, 0.25, 150, 6.0e7, 30, 140, 1)),
  mod('wpn_missile_1', ASH, 'Wasp', 'weapon', 1, 2, 350, 6500, 0.2, {}, D_MISSILE, wpn('missile', 180, 0.5, 1.6, 18000, 800, 0.25, 0.1, 2.0e5, 8, 220, 30)),
  mod('wpn_missile_2', ASH, 'Wasp', 'weapon', 2, 2, 800, 21000, 0.4, {}, D_MISSILE, wpn('missile', 420, 0.5, 1.6, 22000, 850, 0.2, 0.1, 4.0e5, 12, 480, 30)),
  mod('wpn_torpedo_3', ASH, 'Gravedigger', 'weapon', 3, 4, 2400, 72000, 0.8, {},
    'Anti-ship torpedo tube. Four slow, enormous warheads that end a freighter outright, if they are allowed to arrive.',
    wpn('missile', 1500, 0.5, 1.8, 30000, 500, 0.08, 0.2, 1.0e6, 4, 2600, 20)),
];

/** Every module, by id. */
export const MODULES: Record<string, ModuleDef> = Object.fromEntries(MODULE_LIST.map((m) => [m.id, m]));

/** Every module in catalogue order (grouped by slot type, families by size). */
export const MODULE_IDS: readonly string[] = MODULE_LIST.map((m) => m.id);

/** The module with this id, or undefined (unknown / null / empty). */
export function getModule(id: string | null | undefined): ModuleDef | undefined {
  return id != null && Object.prototype.hasOwnProperty.call(MODULES, id) ? MODULES[id] : undefined;
}

// ===================================================================================== hulls

type Fit = readonly [type: ModuleSlotType, size: number, moduleId: string | null];

function hull(
  id: ShipVisualId,
  name: string,
  manufacturer: string,
  role: ShipRole,
  price: number,
  hullMass: number,
  hullPoints: number,
  pad: PadSize,
  dragArea: number,
  length: number,
  description: string,
  fit: readonly Fit[],
): ShipDef {
  return {
    id,
    name,
    manufacturer,
    role,
    price,
    hullMass,
    hull: hullPoints,
    pad,
    slots: fit.map(([type, size]) => ({ type, size })),
    defaultLoadout: fit.map((f) => f[2]),
    dragArea,
    length,
    description,
  };
}

/**
 * The seven hulls. Weapon slots are index-aligned with `SHIP_LAYOUTS[id].hardpoints` (same count, same
 * sizes, same order).
 */
export const SHIPS: Record<ShipVisualId, ShipDef> = {
  // The 32 m Wren is the 16 m one scaled by two in mass: twin drive pods (two engine slots), two RCS packs, two
  // reactors, two tanks and two radiators, so full-throttle and RCS acceleration, Δv and heat per tonne are those
  // of the old courier. Length and drag area follow the hull (32 x 19 x 6.6 m); inertia follows mass and length.
  wren: hull('wren', 'Wren', 'Corvane', 'courier', 38000, 24200, 800, 'M', 80, 32,
    'Corvane\'s Wren is the Reach\'s default courier: a 32-metre lifting body with twin drive pods, two cabins, a lounge and a cargo bay that aerobrakes willingly and fits any medium pad. Cheap to run, easy to fly and as much a home as a ship.',
    [
      ['engine', 1, 'eng_torch_1'],
      ['engine', 1, 'eng_torch_1'],
      ['rcs', 1, 'rcs_std_1'],
      ['rcs', 1, 'rcs_std_1'],
      ['reactor', 1, 'rct_std_1'],
      ['reactor', 1, 'rct_std_1'],
      ['tank', 2, 'tank_std_2'],
      ['tank', 2, 'tank_std_2'],
      ['cargo', 2, 'cargo_rack_2'],
      ['shield', 1, 'shd_std_1'],
      ['armor', 1, null],
      ['weapon', 1, 'wpn_pulse_1'],
      ['weapon', 1, null],
      ['radiator', 1, 'rad_std_1'],
      ['radiator', 1, 'rad_std_1'],
      ['jump', 2, 'jmp_std_2'],
      ['computer', 1, 'cmp_3'],
      ['scanner', 1, 'scn_nav_1'],
      ['utility', 1, 'utl_dock'],
      ['utility', 1, null],
    ]),
  drover: hull('drover', 'Drover', 'Ilmarin', 'hauler', 215000, 78000, 1500, 'M', 95, 38,
    'Ilmarin\'s spine-and-cans hauler carries six standard containers behind a small crew module and one very large drive bell. Unglamorous, slow to turn and profitable on any route with a market at each end.',
    [
      ['engine', 2, 'eng_torch_2'],
      ['rcs', 3, 'rcs_std_2'],
      ['reactor', 2, 'rct_std_2'],
      ['tank', 3, 'tank_std_3'],
      ['tank', 2, 'tank_std_2'],
      ['tank', 2, 'tank_std_2'],
      ['cargo', 3, 'cargo_rack_3'],
      ['cargo', 3, 'cargo_rack_3'],
      ['shield', 2, 'shd_std_2'],
      ['armor', 2, null],
      ['weapon', 1, 'wpn_pulse_1'],
      ['weapon', 1, null],
      ['radiator', 2, 'rad_std_2'],
      ['jump', 2, 'jmp_std_2'],
      ['computer', 1, 'cmp_1'],
      ['scanner', 1, 'scn_nav_1'],
      ['utility', 1, 'utl_dock'],
      ['utility', 2, null],
    ]),
  magpie: hull('magpie', 'Magpie', 'Hadley-Okafor', 'miner', 190000, 33000, 1700, 'M', 62, 26,
    'A stubby Hadley-Okafor workboat built around a chin-mounted cutting boom, side hoppers and a pair of grapple arms. It mines, refines and salvages at its own unhurried pace and shrugs off the knocks that come with the trade.',
    [
      ['engine', 2, 'eng_torch_1'],
      ['rcs', 2, 'rcs_std_2'],
      ['reactor', 2, 'rct_std_2'],
      ['tank', 3, 'tank_std_3'],
      ['cargo', 2, 'cargo_rack_2'],
      ['cargo', 2, 'cargo_rack_2'],
      ['shield', 2, 'shd_std_1'],
      ['armor', 2, 'arm_plate_2'],
      ['weapon', 1, 'wpn_pulse_1'],
      ['weapon', 1, null],
      ['radiator', 2, 'rad_std_2'],
      ['jump', 2, 'jmp_std_2'],
      ['computer', 1, 'cmp_1'],
      ['scanner', 1, 'scn_nav_1'],
      ['utility', 2, 'utl_mining_1'],
      ['utility', 2, 'utl_refinery'],
      ['utility', 1, null],
    ]),
  shrike: hull('shrike', 'Shrike', 'Corvane', 'fighter', 148000, 6000, 650, 'S', 17, 15,
    'Corvane\'s interceptor trades endurance for thrust: two close-set pulse drives, forward-swept strakes and four hardpoints on a hull shorter than a Wren. Short-legged and always at the edge of its power budget, it rewards pilots who pick their fights.',
    [
      ['engine', 1, 'eng_pulse_1'],
      ['rcs', 1, 'rcs_agile_1'],
      ['reactor', 1, 'rct_hi_1'],
      ['tank', 1, 'tank_std_1'],
      ['tank', 1, 'tank_std_1'],
      ['cargo', 1, 'cargo_rack_1'],
      ['shield', 2, 'shd_std_1'],
      ['armor', 1, 'arm_plate_1'],
      ['weapon', 2, 'wpn_pulse_2'],
      ['weapon', 2, 'wpn_pulse_2'],
      ['weapon', 1, 'wpn_cannon_1'],
      ['weapon', 1, 'wpn_cannon_1'],
      ['radiator', 2, 'rad_std_2'],
      ['jump', 1, 'jmp_std_1'],
      ['computer', 1, 'cmp_2'],
      ['scanner', 1, 'scn_combat_1'],
      ['utility', 1, null],
    ]),
  albatross: hull('albatross', 'Albatross', 'Ilmarin', 'explorer', 460000, 14800, 1000, 'M', 80, 34,
    'Ilmarin\'s long-range survey ship wraps a high-efficiency cruise drive in spherical tanks and enormous fold-out radiator wings. Nothing in the Reach jumps farther or coasts longer, and almost anything can outrun it.',
    [
      ['engine', 2, 'eng_cruise_2'],
      ['rcs', 2, 'rcs_std_2'],
      ['reactor', 2, 'rct_std_2'],
      ['tank', 3, 'tank_std_3'],
      ['tank', 2, 'tank_std_2'],
      ['tank', 1, 'tank_std_1'],
      ['cargo', 1, 'cargo_rack_1'],
      ['shield', 1, 'shd_std_1'],
      ['armor', 1, null],
      ['weapon', 1, 'wpn_pulse_1'],
      ['weapon', 1, null],
      ['radiator', 3, 'rad_std_3'],
      ['jump', 2, 'jmp_lr_2'],
      ['computer', 1, 'cmp_2'],
      ['scanner', 2, 'scn_survey_2'],
      ['scanner', 1, null],
      ['utility', 1, 'utl_scoop'],
      ['utility', 1, null],
      ['utility', 2, null],
    ]),
  caravel: hull('caravel', 'Caravel', 'Hadley-Okafor', 'freighter', 1650000, 500000, 4200, 'L', 430, 72,
    'Hadley-Okafor\'s heavy freighter is a keel, four drive bells and a container stack the size of a city block. It needs a large pad, a patient captain and a transfer window, and it moves more tonnage per jump than anything else in civilian service.',
    [
      ['engine', 4, 'eng_torch_3'],
      ['rcs', 4, 'rcs_std_4'],
      ['reactor', 3, 'rct_std_3'],
      ['tank', 4, 'tank_std_4'],
      ['tank', 4, 'tank_std_4'],
      ['tank', 3, 'tank_std_3'],
      ['cargo', 4, 'cargo_rack_4'],
      ['cargo', 4, 'cargo_rack_4'],
      ['cargo', 4, 'cargo_rack_4'],
      ['cargo', 4, 'cargo_rack_4'],
      ['shield', 3, 'shd_std_3'],
      ['armor', 3, null],
      ['weapon', 2, 'wpn_cannon_2'],
      ['weapon', 2, 'wpn_cannon_2'],
      ['weapon', 2, null],
      ['weapon', 2, null],
      ['radiator', 3, 'rad_std_3'],
      ['jump', 4, 'jmp_std_4'],
      ['computer', 1, 'cmp_1'],
      ['scanner', 2, 'scn_nav_1'],
      ['utility', 1, 'utl_dock'],
      ['utility', 2, null],
      ['utility', 2, null],
    ]),
  halberd: hull('halberd', 'Halberd', 'Auric Arsenal', 'gunship', 2400000, 103000, 4800, 'L', 150, 44,
    'The Auric Arsenal\'s line gunship: an armoured wedge prow, a dorsal turret ring and six hardpoints fed by a warship-grade reactor. Expensive to buy and to run, and built to end arguments.',
    [
      ['engine', 3, 'eng_torch_3'],
      ['rcs', 3, 'rcs_std_3'],
      ['reactor', 3, 'rct_std_3'],
      ['tank', 3, 'tank_std_3'],
      ['tank', 3, 'tank_std_3'],
      ['tank', 2, 'tank_std_2'],
      ['cargo', 2, 'cargo_rack_2'],
      ['shield', 3, 'shd_std_3'],
      ['armor', 3, 'arm_plate_3'],
      ['weapon', 3, 'wpn_pulse_3'],
      ['weapon', 3, 'wpn_pulse_3'],
      ['weapon', 2, 'wpn_cannon_2'],
      ['weapon', 2, 'wpn_cannon_2'],
      ['weapon', 2, 'wpn_missile_2'],
      ['weapon', 2, 'wpn_missile_2'],
      ['radiator', 3, 'rad_std_3'],
      ['jump', 3, 'jmp_std_3'],
      ['computer', 1, 'cmp_2'],
      ['scanner', 2, 'scn_combat_2'],
      ['utility', 2, null],
      ['utility', 1, null],
    ]),
};

/** Hull ids in shipyard order (cheapest first). */
export const SHIP_IDS: readonly ShipVisualId[] = (Object.keys(SHIPS) as ShipVisualId[]).sort((a, b) => SHIPS[a].price - SHIPS[b].price);

// ===================================================================================== loadouts

/** A fresh copy of the loadout a hull is sold with. */
export function defaultLoadout(shipId: ShipVisualId): Loadout {
  return { shipId, modules: SHIPS[shipId].defaultLoadout.slice() };
}

/** True if `module` (a def or an id) may go into `slot`: same type, module size <= slot size. */
export function canFit(slot: ModuleSlot, module: ModuleDef | string): boolean {
  const m = typeof module === 'string' ? getModule(module) : module;
  return !!m && m.slotType === slot.type && m.size <= slot.size;
}

/** A copy of `loadout` with slot `slotIndex` set to `moduleId` (null empties it). Not validated: see `validateLoadout`. */
export function withModule(loadout: Loadout, slotIndex: number, moduleId: string | null): Loadout {
  const modules = loadout.modules.slice();
  modules[slotIndex] = moduleId;
  return { shipId: loadout.shipId, modules };
}

/**
 * The modules that actually count, index-aligned with the hull's slots: null for empty slots, unknown
 * ids, modules of the wrong type or too large for their slot, and repeats of a `unique` module.
 */
export function fittedModules(loadout: Loadout): (ModuleDef | null)[] {
  const ship = SHIPS[loadout.shipId];
  if (!ship) throw new Error(`ships: unknown hull "${String(loadout.shipId)}"`);
  const seen: string[] = [];
  return ship.slots.map((slot, i) => {
    const m = getModule(loadout.modules[i]);
    if (!m || !canFit(slot, m)) return null;
    if (m.unique) {
      if (seen.includes(m.unique)) return null;
      seen.push(m.unique);
    }
    return m;
  });
}

/** Modules of any size that fit `slot` and are no more advanced than `maxTier`, smallest and cheapest first. */
export function listModulesForSlot(slot: ModuleSlot, maxTier = 4): ModuleDef[] {
  return MODULE_LIST.filter((m) => m.tier <= maxTier && canFit(slot, m)).sort((a, b) => a.size - b.size || a.price - b.price);
}

/** Fitted weapons in hardpoint order (empty hardpoints are skipped; `hardpoint` keeps the mount index). */
export function weaponsOf(loadout: Loadout): FittedWeapon[] {
  const ship = SHIPS[loadout.shipId];
  const fitted = fittedModules(loadout);
  const out: FittedWeapon[] = [];
  let hardpoint = 0;
  for (let i = 0; i < ship.slots.length; i++) {
    if (ship.slots[i].type !== 'weapon') continue;
    const m = fitted[i];
    if (m && m.weapon) out.push({ slot: i, hardpoint, module: m, weapon: m.weapon });
    hardpoint++;
  }
  return out;
}

// ===================================================================================== stats

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/** Flight-model statistics of a fitted ship. Only modules that legally fit their slot count (see `fittedModules`). */
export function computeStats(loadout: Loadout): VesselStats {
  const ship = SHIPS[loadout.shipId];
  const fitted = fittedModules(loadout);

  let dryMass = ship.hullMass;
  let fuelCapacity = 0;
  let thrust = 0;
  let massFlow = 0;
  let rcsThrust = 0;
  let rcsFlow = 0;
  let torque = 0;
  let hullMax = ship.hull;
  let armor = 0;
  let shieldMax = 0;
  let shieldRegen = 0;
  let powerOutput = 0;
  let powerDraw = 0;
  let heatCapacityExtra = 0;
  let heatDissipation = HULL_RADIATION * ship.dragArea;
  let heatShield = 1;
  let cargoCapacity = 0;
  let sensorRange = BASE_SENSOR_RANGE;
  let computerTier = 0;
  let hasFuelScoop = false;
  let hasMiningLaser = false;
  let hasRefinery = false;
  let hasSurveyScanner = false;
  let hasDockingComputer = false;

  for (const m of fitted) {
    if (!m) continue;
    const s = m.stats;
    dryMass += m.mass;
    powerOutput += m.powerOutput;
    powerDraw += m.powerDraw;
    if (s.thrust && s.exhaustVelocity) {
      thrust += s.thrust;
      massFlow += s.thrust / s.exhaustVelocity;
    }
    if (s.rcsThrust && s.rcsExhaustVelocity) {
      rcsThrust += s.rcsThrust;
      rcsFlow += s.rcsThrust / s.rcsExhaustVelocity;
    }
    torque += s.torque ?? 0;
    fuelCapacity += s.fuelCapacity ?? 0;
    cargoCapacity += s.cargoCapacity ?? 0;
    shieldMax += s.shield ?? 0;
    shieldRegen += s.shieldRegen ?? 0;
    armor += s.armor ?? 0;
    hullMax += s.hull ?? 0;
    heatDissipation += s.heatDissipation ?? 0;
    heatCapacityExtra += s.heatCapacity ?? 0;
    if (s.heatShield && s.heatShield > 0) heatShield *= s.heatShield;
    if (s.sensorRange && s.sensorRange > sensorRange) sensorRange = s.sensorRange;
    if (s.computerTier && s.computerTier > computerTier) computerTier = s.computerTier;
    if (s.fuelScoop) hasFuelScoop = true;
    if (s.miningLaser) hasMiningLaser = true;
    if (s.refinery) hasRefinery = true;
    if (s.surveyScanner) hasSurveyScanner = true;
    if (s.dockingComputer) hasDockingComputer = true;
  }

  // Jump: the fitted drive that reaches farthest at this dry mass.
  let jumpRange = 0;
  let jumpFuelPerLy = 0;
  for (const m of fitted) {
    const s = m?.stats;
    if (!s || !s.jumpRange || !s.jumpRatedMass) continue;
    const range = s.jumpRange * Math.min(1, Math.pow(s.jumpRatedMass / dryMass, JUMP_MASS_EXPONENT));
    if (range > jumpRange) {
      jumpRange = range;
      jumpFuelPerLy = ((s.jumpFuelPerLyPerTonne ?? 0) * dryMass) / 1000;
    }
  }

  const inertia = INERTIA_FACTOR * dryMass * ship.length * ship.length;
  const maxAngularAccel = torque > 0 ? torque / inertia : 0;
  const stopAngle = STOP_ANGLE + STOP_ANGLE_PER_TIER * computerTier;
  const maxAngularRate = maxAngularAccel > 0 ? Math.min(MAX_ANGULAR_RATE, Math.max(MIN_ANGULAR_RATE, Math.sqrt(2 * maxAngularAccel * stopAngle))) : 0;

  return {
    dryMass,
    fuelCapacity,
    mainThrust: thrust,
    exhaustVelocity: massFlow > 0 ? thrust / massFlow : 0,
    rcsThrust,
    rcsExhaustVelocity: rcsFlow > 0 ? rcsThrust / rcsFlow : 0,
    maxAngularAccel,
    maxAngularRate,
    hullMax,
    armor,
    shieldMax,
    shieldRegen,
    powerOutput: round6(powerOutput),
    powerDraw: round6(powerDraw),
    heatCapacity: HULL_HEAT_CAPACITY * dryMass + heatCapacityExtra,
    heatDissipation: Math.max(0, heatDissipation),
    dragArea: ship.dragArea,
    heatShield: Math.min(HEAT_SHIELD_MAX, heatShield),
    cargoCapacity,
    jumpRange,
    jumpFuelPerLy,
    sensorRange,
    computerTier,
    radius: SHIP_LAYOUTS[ship.id].radius,
    hasFuelScoop,
    hasMiningLaser,
    hasRefinery,
    hasSurveyScanner,
    hasDockingComputer,
  };
}

// ===================================================================================== validation

const fmt1 = (x: number): string => (Math.round(x * 10) / 10).toFixed(1);

/**
 * Everything wrong with a loadout, most fundamental first; an empty list means it is valid. Errors
 * (wrong slot type / size, unknown ids, a repeated one-off module, no drive / RCS / reactor / tank, power
 * budget exceeded) ground the ship; warnings (no jump drive, jump drive over its mass rating) do not.
 */
export function validateLoadout(loadout: Loadout): LoadoutProblem[] {
  const problems: LoadoutProblem[] = [];
  const add = (code: LoadoutProblemCode, severity: 'error' | 'warning', slot: number | null, message: string): void => {
    problems.push({ code, severity, slot, message });
  };
  const ship = SHIPS[loadout.shipId] as ShipDef | undefined;
  if (!ship) {
    add('unknown-ship', 'error', null, `Unknown hull "${String(loadout.shipId)}".`);
    return problems;
  }
  if (loadout.modules.length !== ship.slots.length) {
    add('slot-count', 'error', null, `The ${ship.name} has ${ship.slots.length} slots but the loadout lists ${loadout.modules.length}.`);
  }
  const seen = new Map<string, number>();
  ship.slots.forEach((slot, i) => {
    const id = loadout.modules[i];
    if (id == null) return;
    const where = `Slot ${i + 1} (${SLOT_LABELS[slot.type]}, size ${slot.size})`;
    const m = getModule(id);
    if (!m) {
      add('unknown-module', 'error', i, `${where} holds an unknown module "${id}".`);
    } else if (m.slotType !== slot.type) {
      add('slot-type', 'error', i, `${where} cannot take the ${m.name}: it is a ${SLOT_LABELS[m.slotType]} module.`);
    } else if (m.size > slot.size) {
      add('slot-size', 'error', i, `${where} is too small for the ${m.name} (size ${m.size}).`);
    } else if (m.unique) {
      const first = seen.get(m.unique);
      if (first !== undefined) add('duplicate', 'error', i, `${where}: only one ${m.unique} can be fitted (slot ${first + 1} already has one).`);
      else seen.set(m.unique, i);
    }
  });

  const stats = computeStats(loadout);
  if (!(stats.mainThrust > 0)) add('no-engine', 'error', null, 'No main drive fitted.');
  if (!(stats.rcsThrust > 0)) add('no-rcs', 'error', null, 'No RCS pack fitted: the ship cannot turn or dock.');
  if (!(stats.powerOutput > 0)) add('no-reactor', 'error', null, 'No reactor fitted.');
  if (!(stats.fuelCapacity > 0)) add('no-tank', 'error', null, 'No propellant tank fitted.');
  if (stats.powerOutput > 0 && stats.powerDraw > stats.powerOutput + 1e-9) {
    add('power', 'error', null, `Power budget exceeded: modules draw ${fmt1(stats.powerDraw)} MW, the reactor supplies ${fmt1(stats.powerOutput)} MW.`);
  }
  if (!(stats.jumpRange > 0)) {
    add('no-jump', 'warning', null, 'No jump drive fitted: the ship cannot leave its system.');
  } else {
    const fitted = fittedModules(loadout);
    const i = fitted.findIndex((m) => !!m && !!m.stats.jumpRange);
    const drive = i >= 0 ? fitted[i] : null;
    const rated = drive?.stats.jumpRatedMass ?? 0;
    if (drive && fitted.filter((m) => !!m && !!m.stats.jumpRange).length === 1 && stats.dryMass > rated) {
      add('jump-overmass', 'warning', i,
        `Dry mass ${fmt1(stats.dryMass / 1000)} t exceeds the ${drive.name}'s ${fmt1(rated / 1000)} t rating: jump range is cut from ${fmt1(drive.stats.jumpRange ?? 0)} to ${fmt1(stats.jumpRange)} ly.`);
    }
  }
  return problems;
}

/** True if the loadout has no errors (warnings allowed): the ship may launch. */
export function isLoadoutValid(loadout: Loadout): boolean {
  return validateLoadout(loadout).every((p) => p.severity !== 'error');
}

// ===================================================================================== money

/** List price of a hull with this loadout: hull + every listed module (known ids), cr. */
export function loadoutValue(loadout: Loadout): number {
  let total = SHIPS[loadout.shipId].price;
  for (const id of loadout.modules) total += getModule(id)?.price ?? 0;
  return total;
}

/** What a shipyard charges for a new hull with its stock loadout, cr. */
export function shipPrice(shipId: ShipVisualId): number {
  return loadoutValue(defaultLoadout(shipId));
}

/** What a station pays for a used module, cr: always below its list price, so buying and selling never profits. */
export function moduleResale(moduleId: string | null): number {
  const m = getModule(moduleId);
  return m ? Math.floor(m.price * MODULE_RESALE) : 0;
}

/** Trade-in value of a ship as fitted, cr: hull at HULL_RESALE plus each module at its resale price. */
export function loadoutResale(loadout: Loadout): number {
  let total = Math.floor(SHIPS[loadout.shipId].price * HULL_RESALE);
  for (const id of loadout.modules) total += moduleResale(id);
  return total;
}

/** Net cost (cr) of putting `moduleId` (null = nothing) into a slot: its list price minus the resale of what is there now. */
export function swapCost(loadout: Loadout, slotIndex: number, moduleId: string | null): number {
  return (getModule(moduleId)?.price ?? 0) - moduleResale(loadout.modules[slotIndex] ?? null);
}

// ===================================================================================== rocket equation

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Total mass, kg, with that propellant and cargo on board. */
const loadedMass = (stats: VesselStats, propellantKg: number, cargoKg: number): number =>
  stats.dryMass + (propellantKg > 0 ? propellantKg : 0) + (cargoKg > 0 ? cargoKg : 0);

/** Main-drive Δv, m/s, with `propellantKg` in the tank (default: full) and `cargoKg` in the hold (default: empty). */
export function deltaV(stats: VesselStats, propellantKg: number = stats.fuelCapacity, cargoKg = 0): number {
  const m0 = loadedMass(stats, propellantKg, cargoKg);
  const m1 = m0 - (propellantKg > 0 ? propellantKg : 0);
  if (!(m1 > 0) || !(stats.exhaustVelocity > 0) || !(stats.mainThrust > 0)) return 0;
  return stats.exhaustVelocity * Math.log(m0 / m1);
}

/** Main-drive acceleration, m/s², at `throttle` (0..1) for that propellant and cargo load; 0 with an empty tank. */
export function accel(stats: VesselStats, propellantKg: number = stats.fuelCapacity, cargoKg = 0, throttle = 1): number {
  if (!(propellantKg > 0)) return 0;
  return (stats.mainThrust * clamp01(throttle)) / loadedMass(stats, propellantKg, cargoKg);
}

/** Propellant (kg) a main-drive burn of `dv` m/s consumes starting from that load. May exceed what is on board. */
export function propellantFor(stats: VesselStats, dv: number, propellantKg: number = stats.fuelCapacity, cargoKg = 0): number {
  const ve = stats.exhaustVelocity;
  if (!(ve > 0)) return dv > 0 ? Infinity : 0;
  return loadedMass(stats, propellantKg, cargoKg) * -Math.expm1(-Math.abs(dv) / ve);
}

/** Duration (s) of a main-drive burn of `dv` m/s starting from that load; Infinity if the tank cannot deliver it. */
export function burnTime(stats: VesselStats, dv: number, propellantKg: number = stats.fuelCapacity, cargoKg = 0, throttle = 1): number {
  const thrust = stats.mainThrust * clamp01(throttle);
  if (!(Math.abs(dv) > 0)) return 0;
  if (!(thrust > 0) || !(stats.exhaustVelocity > 0)) return Infinity;
  const prop = propellantFor(stats, dv, propellantKg, cargoKg);
  if (prop > (propellantKg > 0 ? propellantKg : 0) * (1 + 1e-12)) return Infinity;
  return (prop * stats.exhaustVelocity) / thrust;
}

/**
 * Propellant (kg) a jump of `distanceLy` light-years burns: `stats.jumpFuelPerLy · distance`.
 * Infinity if there is no jump drive or the distance is beyond `stats.jumpRange`; 0 for a non-positive distance.
 */
export function jumpCost(stats: VesselStats, distanceLy: number): number {
  if (!(distanceLy > 0)) return 0;
  if (!(stats.jumpRange > 0) || distanceLy > stats.jumpRange * (1 + 1e-9)) return Infinity;
  return stats.jumpFuelPerLy * distanceLy;
}

// ===================================================================================== comparisons

type Better = -1 | 0 | 1;
type Info = readonly [label: string, unit: string, better: Better];

const MODULE_STAT_INFO: Record<keyof ModuleStats, Info> = {
  thrust: ['Thrust', 'N', 1],
  exhaustVelocity: ['Exhaust velocity', 'm/s', 1],
  rcsThrust: ['RCS thrust', 'N', 1],
  rcsExhaustVelocity: ['RCS exhaust velocity', 'm/s', 1],
  torque: ['Attitude torque', 'N·m', 1],
  fuelCapacity: ['Propellant capacity', 'kg', 1],
  cargoCapacity: ['Cargo capacity', 't', 1],
  shield: ['Shield', 'pts', 1],
  shieldRegen: ['Shield recharge', 'pts/s', 1],
  armor: ['Armour', 'pts', 1],
  hull: ['Hull reinforcement', 'pts', 1],
  heatDissipation: ['Heat rejection', 'W', 1],
  heatCapacity: ['Heat capacity', 'J', 1],
  heatShield: ['Heat-shield factor', '×', 1],
  jumpRange: ['Rated jump range', 'ly', 1],
  jumpRatedMass: ['Jump mass rating', 'kg', 1],
  jumpFuelPerLyPerTonne: ['Jump propellant', 'kg/ly/t', -1],
  computerTier: ['Computer tier', '', 1],
  sensorRange: ['Sensor range', 'm', 1],
  surveyRate: ['Survey speed', '×', 1],
  miningRate: ['Mining rate', 'kg/s', 1],
  limpets: ['Limpet drones', '', 1],
  surveyScanner: ['Survey scanner', '', 1],
  cargoScanner: ['Cargo scanner', '', 1],
  combatScanner: ['Fire control', '', 1],
  scanShielded: ['Scan-shielded hold', '', 1],
  fuelScoop: ['Fuel scoop', '', 1],
  miningLaser: ['Mining laser', '', 1],
  refinery: ['Refinery', '', 1],
  dockingComputer: ['Docking computer', '', 1],
};

const WEAPON_INFO: Record<Exclude<keyof WeaponDef, 'kind'>, Info> = {
  damage: ['Damage per shot', 'pts', 1],
  shieldMult: ['Versus shields', '×', 1],
  hullMult: ['Versus hull', '×', 1],
  range: ['Range', 'm', 1],
  projectileSpeed: ['Projectile speed', 'm/s', 1],
  rateOfFire: ['Rate of fire', '/s', 1],
  energyPerShot: ['Energy per shot', 'MJ', -1],
  heatPerShot: ['Heat per shot', 'J', -1],
  ammo: ['Magazine', 'rounds', 0],
  ammoPrice: ['Ammunition price', 'cr', -1],
  gimbal: ['Gimbal half-angle', 'rad', 1],
};

const VESSEL_STAT_INFO: Record<keyof VesselStats, Info> = {
  dryMass: ['Dry mass', 'kg', -1],
  fuelCapacity: ['Propellant capacity', 'kg', 1],
  mainThrust: ['Thrust', 'N', 1],
  exhaustVelocity: ['Exhaust velocity', 'm/s', 1],
  rcsThrust: ['RCS thrust', 'N', 1],
  rcsExhaustVelocity: ['RCS exhaust velocity', 'm/s', 1],
  maxAngularAccel: ['Turn acceleration', 'rad/s²', 1],
  maxAngularRate: ['Turn rate', 'rad/s', 1],
  hullMax: ['Hull', 'pts', 1],
  armor: ['Armour', 'pts', 1],
  shieldMax: ['Shield', 'pts', 1],
  shieldRegen: ['Shield recharge', 'pts/s', 1],
  powerOutput: ['Power output', 'MW', 1],
  powerDraw: ['Power draw', 'MW', -1],
  heatCapacity: ['Heat capacity', 'J', 1],
  heatDissipation: ['Heat rejection', 'W', 1],
  dragArea: ['Drag area', 'm²', 0],
  heatShield: ['Heat-shield factor', '×', 1],
  cargoCapacity: ['Cargo capacity', 't', 1],
  jumpRange: ['Jump range', 'ly', 1],
  jumpFuelPerLy: ['Jump propellant', 'kg/ly', -1],
  sensorRange: ['Sensor range', 'm', 1],
  computerTier: ['Computer tier', '', 1],
  radius: ['Hull radius', 'm', 0],
  hasFuelScoop: ['Fuel scoop', '', 1],
  hasMiningLaser: ['Mining laser', '', 1],
  hasRefinery: ['Refinery', '', 1],
  hasSurveyScanner: ['Survey scanner', '', 1],
  hasDockingComputer: ['Docking computer', '', 1],
};

const num = (v: number | boolean | undefined): number => (typeof v === 'number' ? v : v ? 1 : 0);

function delta(key: string, info: Info, from: number, to: number): StatDelta {
  const d = from === to ? 0 : to - from;
  const v = (d > 0 ? 1 : d < 0 ? -1 : 0) * info[2];
  return { key, label: info[0], unit: info[1], from, to, delta: d, verdict: v > 0 ? 1 : v < 0 ? -1 : 0 };
}

/**
 * Stat-by-stat difference between the module in a slot (`fromId`, null = empty) and a candidate
 * (`toId`, null = remove), for the outfitting screen. Only rows where either side has a value are
 * returned, in a fixed order: mass, price, power, then contributed stats, then weapon figures
 * (including sustained damage per second, key `dps`).
 */
export function compareModules(fromId: string | null, toId: string | null): StatDelta[] {
  const a = getModule(fromId);
  const b = getModule(toId);
  const rows: StatDelta[] = [];
  const push = (key: string, info: Info, from: number, to: number): void => {
    if (from !== 0 || to !== 0) rows.push(delta(key, info, from, to));
  };
  push('mass', ['Mass', 'kg', -1], a?.mass ?? 0, b?.mass ?? 0);
  push('price', ['Price', 'cr', -1], a?.price ?? 0, b?.price ?? 0);
  push('powerDraw', ['Power draw', 'MW', -1], a?.powerDraw ?? 0, b?.powerDraw ?? 0);
  push('powerOutput', ['Power output', 'MW', 1], a?.powerOutput ?? 0, b?.powerOutput ?? 0);
  for (const key of Object.keys(MODULE_STAT_INFO) as (keyof ModuleStats)[]) {
    push(key, MODULE_STAT_INFO[key], num(a?.stats[key]), num(b?.stats[key]));
  }
  const wa = a?.weapon;
  const wb = b?.weapon;
  if (wa || wb) {
    push('dps', ['Sustained damage', 'pts/s', 1], wa ? wa.damage * wa.rateOfFire : 0, wb ? wb.damage * wb.rateOfFire : 0);
    for (const key of Object.keys(WEAPON_INFO) as (keyof typeof WEAPON_INFO)[]) {
      push(key, WEAPON_INFO[key], wa ? wa[key] : 0, wb ? wb[key] : 0);
    }
  }
  return rows;
}

/**
 * Whole-ship difference between two stat blocks (e.g. before / after a fit): every `VesselStats` field
 * that changed, plus the derived `deltaV` (m/s) and `accel` (m/s²) at full tank and empty hold.
 */
export function compareStats(from: VesselStats, to: VesselStats): StatDelta[] {
  const rows: StatDelta[] = [];
  const push = (key: string, info: Info, a: number, b: number): void => {
    if (a !== b) rows.push(delta(key, info, a, b));
  };
  push('deltaV', ['Δv (full tank, empty hold)', 'm/s', 1], deltaV(from), deltaV(to));
  push('accel', ['Acceleration (full tank)', 'm/s²', 1], accel(from), accel(to));
  for (const key of Object.keys(VESSEL_STAT_INFO) as (keyof VesselStats)[]) {
    push(key, VESSEL_STAT_INFO[key], num(from[key]), num(to[key]));
  }
  return rows;
}
