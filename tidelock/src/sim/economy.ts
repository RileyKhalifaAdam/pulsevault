// Market simulation: supply and demand where distance, delta-v and information matter.
//
// One cargo unit is one tonne (core/types CARGO_UNIT_MASS). Prices are credits per unit.
//
// THE MODEL
//   Static part (derived from the galaxy and the economy seed, never saved): for every station and every
//   commodity it trades, a nominal production P and consumption C in units per day, a throughput T and an
//   equilibrium stock E = COVER_DAYS x T. Station economies (StationDef.economies, primary first) and a
//   population baseline define P and C; production is normalised per commodity so the cluster as a whole is
//   roughly balanced. Each system's capital is its gateway: it trades everything its system trades and is the
//   only station that exchanges goods with neighbouring systems.
//   Dynamic part (EconomyState, plain JSON): per cell the stock, a price memory and a 30-day price history;
//   the active shocks; the political conditions of each station.
//
//   Price = basePrice x clamp(g x (stock / E)^-ELASTICITY, 0.35, 3), cheap where abundant, dear where scarce
//   (g is the political price multiplier, 1 by default). The player pays that plus half the station's spread
//   and receives it minus half the spread, and the cost of n units is the exact integral of the curve over
//   the stock they move - never n x the current price - so splitting an order changes nothing and buying then
//   selling at one market always loses the spread.
//
//   Once per sim day: producers make goods (slowing as storage fills), consumers use them (rationing as stock
//   runs out), and NPC freight carries goods along routes from the cheaper to the dearer end whenever the
//   remembered price difference exceeds the cost of the trip (which grows with delta-v, light-years and the
//   bulk of the cargo). Freight acts on price memory, not on today's price, so a disturbance - a shock, or the
//   player hammering a route - persists for days before the traders catch up.
//
// SEAMS (deliberately left for later sprints)
//   - Politics: StationConditions is the hook; nothing sets it yet (setStationConditions).
//   - Information: bestTrades reads live markets; restrict it with `stationIds` to what the player knows and
//     show remote boards from snapshotMarket() copies.
//   - Refuelling does not draw down the station's liquid hydrogen stock (the game can call applyBuy for it).
//   - Mining sites only bias which ores a system's extraction stations yield; mined cargo is sold like any other.

import type { CommodityCategory, CommodityDef, EconomyType, StationDef, SystemDef } from '../core/types';
import { hash, makeRng } from '../core/rng';
import { commodityById } from '../data/commodities';
import { estimateTransferDv, systemDistance, type GalaxyDef } from './universe';

// ============================================================================================
// Public types
// ============================================================================================

/** One line of a station's market board. */
export interface MarketRow {
  commodityId: string;
  name: string;
  category: CommodityCategory;
  /** What the player pays for the next unit, cr. */
  buyPrice: number;
  /** What the player receives for the next unit, cr. */
  sellPrice: number;
  /** Units the station has for sale. */
  stock: number;
  /** How badly the station wants it, 0 (glutted) .. 1 (desperate). */
  demand: number;
  /** Price direction over the last few days: -1 falling, 0 steady, 1 rising. */
  trend: -1 | 0 | 1;
  /** Galactic average price, cr. */
  avgPrice: number;
  /** False when the commodity is contraband under the station owner's government. */
  legal: boolean;
}

/** Cost or proceeds of trading several units at once (prices move as you trade). */
export interface TradeQuote {
  /** Units actually quoted (the request clamped to what is possible). */
  units: number;
  /** Total credits for those units. */
  total: number;
  /** Average price per unit. */
  average: number;
  /** Largest number of units the station can trade right now. */
  maxUnits: number;
}

export interface EconomyEvent {
  kind: 'shortage' | 'glut' | 'priceSpike';
  stationId: string;
  commodityId: string;
  day: number;
}

/** Dynamic state of one commodity at one station. */
export interface MarketCellState {
  /** Stock, units. */
  s: number;
  /** Price memory: a moving average of the price multiplier, which NPC freight acts on. */
  m: number;
  /** Price history, oldest first: two base-36 digits per daily sample of (price / basePrice x 100). */
  h: string;
}

/** Dynamic state of one station's market, keyed by commodity id. */
export interface StationMarketState {
  cells: Record<string, MarketCellState>;
}

/** A temporary disturbance of one commodity at one station. */
export interface EconomyShock {
  stationId: string;
  commodityId: string;
  kind: 'shortage' | 'glut';
  /** Last day the shock is active. */
  until: number;
  /** Multiplier on consumption (shortage) or production (glut) while active. */
  factor: number;
}

/**
 * Political and situational conditions of a station: the hook for the politics module (boom, famine, war,
 * blockade...). All multipliers; 1 is neutral. `categories` refines them per commodity category and
 * multiplies with the station-wide values.
 */
export interface StationConditions {
  production: number;
  consumption: number;
  price: number;
  categories?: Partial<Record<CommodityCategory, { production?: number; consumption?: number; price?: number }>>;
}

/** Plain JSON-serialisable economy state (lives in the save file). */
export interface EconomyState {
  seed: number;
  /** Last simulated day (sim time / 86400, floored). */
  day: number;
  /** Per-station market state, keyed by station id. */
  markets: Record<string, StationMarketState>;
  /** Active shocks. */
  shocks?: EconomyShock[];
  /** Non-neutral station conditions, keyed by station id (absent = neutral). */
  conditions?: Record<string, StationConditions>;
}

/** What a station makes or wants, for tooltips and the map. */
export interface TradeProfileItem {
  commodityId: string;
  name: string;
  category: CommodityCategory;
  /** 1 minor, 2 significant, 3 major. */
  level: 1 | 2 | 3;
  /** Current price / base price. */
  priceRatio: number;
}

export interface ImportExportSummary {
  /** What it makes, most valuable flow first. */
  exports: TradeProfileItem[];
  /** What it wants, most valuable flow first. */
  imports: TradeProfileItem[];
}

export interface TradeLeg {
  commodityId: string;
  name: string;
  units: number;
  /** Credits paid at the origin. */
  buyTotal: number;
  /** Credits received at the destination. */
  sellTotal: number;
  profit: number;
}

/** One destination with the cargo mix that earns the most there. */
export interface TradeRoute {
  fromStationId: string;
  toStationId: string;
  toName: string;
  toSystemId: string;
  sameSystem: boolean;
  /** Rough one-way transfer delta-v, m/s (same system only; null otherwise). */
  dv: number | null;
  units: number;
  cost: number;
  revenue: number;
  /** Profit for one trip with this hold and this capital, before propellant. */
  profit: number;
  legs: TradeLeg[];
}

export interface BestTradesOptions {
  /** Free cargo units. */
  cargo: number;
  /** Credits available to buy with. */
  capital: number;
  /** Most routes to return (default 6). */
  limit?: number;
  /** Only consider these destinations (e.g. the stations the player has market data for). */
  stationIds?: string[];
  /** Also consider the gateway stations of neighbouring systems (default false). */
  includeNeighbours?: boolean;
  /** Include goods that are illegal at either end (default false). */
  includeIllegal?: boolean;
}

/** A frozen copy of a market board: what the player knew, and when. Plain JSON. */
export interface MarketSnapshot {
  stationId: string;
  day: number;
  rows: MarketRow[];
}

// ============================================================================================
// Tuning
// ============================================================================================

/** Price multiplier bounds around the base price. */
export const PRICE_MIN = 0.35;
export const PRICE_MAX = 3;
/** Days of history kept per cell. */
export const HISTORY_DAYS = 30;

/** Price multiplier = (stock / equilibrium)^-ELASTICITY. */
const ELASTICITY = 0.7;
/** Equilibrium stock is this many days of throughput. */
const COVER_DAYS = 10;
/** Stock / equilibrium at which producers stop (storage full). */
const R_FULL = 2.8;
/** Below this stock / equilibrium consumers are rationed in proportion. */
const R_RATION = 0.6;
/** Stations stop buying above this stock / equilibrium. */
const R_CAP = 4.5;
/** Producers run this much above nominal when their stock is short. */
const PROD_BOOST = 1.3;
/** Consumers use this much more than nominal when goods are plentiful. */
const CONS_GLUT = 0.3;
/** Daily pull toward equilibrium from the economy too small to simulate (workshops, peddlers). */
const RELAX = 0.02;
/** Daily weight of today's price in the price memory. */
const MEM_ALPHA = 0.4;
/** Price-multiplier excess over the transport cost at which a freight route runs at capacity. */
const RAMP = 0.25;
/** Largest share of a stock that freight may carry away in one day. */
const MAX_OUT = 0.25;
/** Route capacity = gain x the smaller throughput of its two ends. */
const GAIN_LOCAL = 2.5;
const GAIN_JUMP = 1.2;
/**
 * Cluster-wide production capacity relative to consumption. Above 1 because producers idle part of their
 * capacity when their warehouses are full: that slack is what lets exporters sit cheap and importers near par.
 */
const BALANCE = 1.45;
/** Slow seasonal swing and day-to-day jitter of production and consumption (fractions of nominal). */
const WAVE = 0.2;
const JITTER = 0.2;
/** Share of the rest of the system's throughput that passes through the gateway's market. */
const GATEWAY_SHARE = 0.6;
/** Days of settling simulated when a new economy is created. */
const WARMUP_DAYS = 90;
/** Chance per station per day of a shock. */
const SHOCK_CHANCE = 0.012;
/** Neighbouring systems trade when no farther apart than this, light-years. */
const TRADE_RANGE_LY = 7;
/** Most days simulated by one tickEconomy call (a longer gap is skipped over, not simulated). */
const MAX_CATCHUP_DAYS = 400;

/** The neutral conditions: nothing changes. */
export const NEUTRAL_CONDITIONS: Readonly<StationConditions> = Object.freeze({ production: 1, consumption: 1, price: 1 });

// Activity per unit of station size; positive = produces, negative = consumes. Tonnages follow from the
// commodity's bulk factor (cheap goods move in far greater tonnage than dear ones).

/** What any population uses, whatever it does for a living (consumption). */
const POPULATION: Readonly<Record<string, number>> = {
  twilight_grain: 3, vat_protein: 2.5, orchard_produce: 1.2, water_ice: 2.5, liquid_hydrogen: 2.5,
  fusion_pellets: 1, medical_supplies: 1, flare_prophylactics: 0.6, household_goods: 1.5, machine_parts: 1,
  polymers: 0.8, structural_steel: 0.5, duskwine: 0.5, freewave_sets: 0.3, sensor_arrays: 0.1,
  lattice_processors: 0.12,
};

const PROFILES: Readonly<Record<EconomyType, Readonly<Record<string, number>>>> = {
  agriculture: {
    twilight_grain: 12, vat_protein: 6, orchard_produce: 5, duskwine: 1.5,
    fertiliser: -5, water_ice: -4, machine_parts: -2, polymers: -1.5,
  },
  extraction: {
    water_ice: 8, cryovolatiles: 5, silicate_ore: 6, ferronickel_ore: 7, ilmenite: 4, lanthanide_ore: 2.5,
    uraninite: 1.5, platinoid_ore: 1.2,
    mining_rigs: -2.5, machine_parts: -3, vat_protein: -1.5, twilight_grain: -1, medical_supplies: -1.5,
    fusion_pellets: -1, household_goods: -1,
  },
  refinery: {
    structural_steel: 9, titanium_plate: 4, noble_metals: 1.2, fertiliser: 5, polymers: 5, liquid_hydrogen: 6,
    fusion_pellets: 2,
    silicate_ore: -5, ferronickel_ore: -8, ilmenite: -4, lanthanide_ore: -1, uraninite: -1.2, platinoid_ore: -1.2,
    cryovolatiles: -4, water_ice: -3, scrap_plate: -3, machine_parts: -2.5, vat_protein: -1, twilight_grain: -1,
    medical_supplies: -0.8,
  },
  industrial: {
    machine_parts: 8, mining_rigs: 3, drive_assemblies: 1.5, household_goods: 6, small_arms: 1, ship_ordnance: 0.6,
    freewave_sets: 0.8,
    structural_steel: -7, titanium_plate: -2.5, polymers: -4, noble_metals: -0.5, lattice_processors: -0.5,
    fusion_pellets: -1.5, salvaged_avionics: -0.5,
  },
  hightech: {
    sensor_arrays: 3, lattice_processors: 3, beacon_cores: 0.8, medical_supplies: 5, flare_prophylactics: 3,
    freewave_sets: 1,
    noble_metals: -1.5, lanthanide_ore: -3, platinoid_ore: -0.6, polymers: -2.5, titanium_plate: -1,
    machine_parts: -1,
  },
  service: {
    scrap_plate: 1,
    orchard_produce: -2, duskwine: -2.5, household_goods: -2.5, freewave_sets: -1, vat_protein: -1,
    twilight_grain: -1, liquid_hydrogen: -2, lattice_processors: -0.4, sensor_arrays: -0.3, medical_supplies: -0.8,
  },
  tourism: {
    orchard_produce: -3, duskwine: -4, household_goods: -2, vat_protein: -1.5, freewave_sets: -0.6,
    medical_supplies: -0.6, liquid_hydrogen: -1.5,
  },
  military: {
    scrap_plate: 1,
    small_arms: -3, ship_ordnance: -3, liquid_hydrogen: -5, fusion_pellets: -2.5, medical_supplies: -3,
    flare_prophylactics: -1, drive_assemblies: -0.8, sensor_arrays: -1, titanium_plate: -1.5, vat_protein: -2,
    machine_parts: -1.5,
  },
  colony: {
    twilight_grain: -2, vat_protein: -2, orchard_produce: -1, water_ice: -2, machine_parts: -3, mining_rigs: -0.8,
    medical_supplies: -2, flare_prophylactics: -1, household_goods: -2.5, polymers: -2, structural_steel: -3,
    fertiliser: -1.5, fusion_pellets: -1.5, sensor_arrays: -0.3,
  },
  shipyard: {
    scrap_plate: 3,
    structural_steel: -8, titanium_plate: -6, drive_assemblies: -3, sensor_arrays: -2, lattice_processors: -2,
    machine_parts: -4, polymers: -2, noble_metals: -0.5, beacon_cores: -0.3, salvaged_avionics: -0.8,
  },
};

/** Tonnes handled per head differ wildly: a refinery crew moves far more than a city of clerks. */
const INTENSITY: Readonly<Record<EconomyType, number>> = {
  agriculture: 1, extraction: 2.5, refinery: 2.5, industrial: 1.3, hightech: 1.3, service: 1, tourism: 1,
  military: 1.5, colony: 1.5, shipyard: 2,
};

/** Weight of the primary, secondary, tertiary... economy of a station. */
const ECONOMY_WEIGHT = [1, 0.6, 0.4, 0.3];

/** Stations with a black market: what the back rooms want, and what the lawless ones turn out. */
const BLACKMARKET_WANTS: Readonly<Record<string, number>> = {
  glint: -0.8, forged_transponders: -0.5, unbound_cores: -0.2, small_arms: -0.5, salvaged_avionics: 1,
};
const LAWLESS_MAKES: Readonly<Record<string, number>> = {
  glint: 3, forged_transponders: 2, unbound_cores: 0.8, salvaged_avionics: 2,
};

// ============================================================================================
// Static model
// ============================================================================================

interface CellDef {
  /** Equilibrium stock, units. */
  E: number;
  /** Nominal production and consumption, units per day. */
  P: number;
  C: number;
  /** Throughput used for market depth and route capacity, units per day. */
  T: number;
  legal: boolean;
  /** Seasonal swing: period in days and phase 0..1. */
  period: number;
  phase: number;
}

interface StationModel {
  id: string;
  def: StationDef;
  system: SystemDef;
  /** Half the buy/sell spread. */
  half: number;
  gateway: boolean;
  /** By commodity index; undefined where the station does not trade it. */
  cells: (CellDef | undefined)[];
  /** Commodity indices traded, in commodity order. */
  traded: number[];
}

/** A freight route for one commodity between two cells (global cell indices). */
interface Leg {
  a: number;
  b: number;
  /** Capacity, units per day. */
  K: number;
  /** Price-multiplier difference below which nobody bothers. */
  tau: number;
}

interface Model {
  commodities: CommodityDef[];
  nC: number;
  cIndex: Map<string, number>;
  stations: StationModel[];
  sIndex: Map<string, number>;
  legs: Leg[];
  /** Gateway station index of each system id. */
  gateways: Map<string, number>;
  /** Neighbouring system ids of each inhabited system id. */
  neighbours: Map<string, string[]>;
}

const MODELS = new WeakMap<GalaxyDef, Map<number, Model>>();

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const unit = (key: string): number => hash(key) / 4294967296;
const finite = (x: unknown, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);

function stationSize(population: number): number {
  return Math.pow(Math.max(50, finite(population, 50)) / 1000, 0.42);
}

/** Relative abundance of each mineable ore in a system's mining sites (1 = average; 1 everywhere if none). */
function oreFactors(system: SystemDef, commodities: CommodityDef[]): Map<string, number> {
  const out = new Map<string, number>();
  const mineable = commodities.filter((c) => c.mineable);
  let total = 0;
  const sum = new Map<string, number>();
  for (const site of system.miningSites ?? []) {
    for (const o of site.ores ?? []) {
      const w = Math.max(0, finite(o.weight, 0)) * Math.max(0, finite(site.richness, 0));
      sum.set(o.commodityId, (sum.get(o.commodityId) ?? 0) + w);
      total += w;
    }
  }
  for (const c of mineable) {
    out.set(c.id, total > 0 ? clamp(0.3 + 0.7 * ((sum.get(c.id) ?? 0) / total) * mineable.length, 0.3, 2.5) : 1);
  }
  return out;
}

function buildModel(galaxy: GalaxyDef, seed: number): Model {
  const commodities = galaxy.commodities ?? [];
  const nC = commodities.length;
  const cIndex = new Map<string, number>();
  commodities.forEach((c, i) => cIndex.set(c.id, i));
  const bulk = commodities.map((c) => Math.pow(300 / Math.max(10, c.basePrice), 0.55));
  const government = new Map<string, string>();
  for (const f of galaxy.factions ?? []) government.set(f.id, f.government);

  const stations: StationModel[] = [];
  const sIndex = new Map<string, number>();
  const prod: number[][] = [];
  const cons: number[][] = [];
  const legalAt: boolean[][] = [];

  for (const system of galaxy.systems ?? []) {
    const ore = oreFactors(system, commodities);
    for (const st of system.stations ?? []) {
      if (!st.services.includes('market')) continue;
      const size = stationSize(st.population);
      const gov = government.get(galaxy.stationOwners?.[st.id] ?? '') ?? '';
      const black = st.services.includes('blackmarket');
      const p = new Array<number>(nC).fill(0);
      const c = new Array<number>(nC).fill(0);
      const add = (profile: Readonly<Record<string, number>>, weight: number, mined: boolean): void => {
        for (const id in profile) {
          const ci = cIndex.get(id);
          if (ci === undefined) continue;
          const w = profile[id];
          const vary = 0.8 + 0.4 * unit(`${seed}:eco:${st.id}:${id}:${w > 0 ? 'p' : 'c'}`);
          const amount = Math.abs(w) * weight * size * bulk[ci] * vary;
          if (w > 0) p[ci] += amount * (mined ? (ore.get(id) ?? 1) : 1);
          else c[ci] += amount;
        }
      };
      for (const id in POPULATION) {
        const ci = cIndex.get(id);
        if (ci !== undefined) c[ci] += POPULATION[id] * size * bulk[ci] * (0.8 + 0.4 * unit(`${seed}:eco:${st.id}:${id}:pop`));
      }
      st.economies.forEach((type, k) => {
        const profile = PROFILES[type];
        if (profile) add(profile, (ECONOMY_WEIGHT[k] ?? 0.3) * INTENSITY[type], type === 'extraction');
      });
      if (black) {
        add(BLACKMARKET_WANTS, 1, false);
        if (gov === 'anarchy') add(LAWLESS_MAKES, 1, false);
      }
      // Law, and "not every station trades every commodity": small places drop the goods they barely touch.
      const cut = size < 1.5 ? 0.9 : size < 4 ? 0.6 : size < 12 ? 0.3 : 0.08;
      const legal = new Array<boolean>(nC).fill(true);
      for (let ci = 0; ci < nC; ci++) {
        legal[ci] = !commodities[ci].illegalUnder.includes(gov as never);
        if ((!legal[ci] && !black) || (p[ci] + c[ci]) / (size * bulk[ci]) < cut) {
          p[ci] = 0;
          c[ci] = 0;
        }
      }
      sIndex.set(st.id, stations.length);
      stations.push({
        id: st.id,
        def: st,
        system,
        half: clamp(0.05 - 0.003 * Math.log(Math.max(100, st.population) / 100), 0.02, 0.05),
        gateway: false,
        cells: new Array<CellDef | undefined>(nC).fill(undefined),
        traded: [],
      });
      prod.push(p);
      cons.push(c);
      legalAt.push(legal);
    }
  }

  // Balance the cluster: scale production so each commodity is made about as fast as it is used.
  for (let ci = 0; ci < nC; ci++) {
    let sp = 0;
    let sc = 0;
    for (let si = 0; si < stations.length; si++) {
      sp += prod[si][ci];
      sc += cons[si][ci];
    }
    if (sc <= 0) continue;
    if (sp <= 0) {
      // Nobody makes it in this cluster: every user is supplied from off the map at par.
      for (let si = 0; si < stations.length; si++) prod[si][ci] = cons[si][ci];
    } else {
      const f = clamp((BALANCE * sc) / sp, 0.2, 5);
      for (let si = 0; si < stations.length; si++) prod[si][ci] *= f;
    }
  }

  // Gateways: the capital of each system (else its largest market).
  const gateways = new Map<string, number>();
  for (const system of galaxy.systems ?? []) {
    let g = system.capitalStationId ? sIndex.get(system.capitalStationId) : undefined;
    if (g === undefined) {
      let best = -1;
      for (const st of system.stations ?? []) {
        const si = sIndex.get(st.id);
        if (si !== undefined && st.population > best) {
          best = st.population;
          g = si;
        }
      }
    }
    if (g !== undefined) {
      gateways.set(system.id, g);
      stations[g].gateway = true;
    }
  }

  // Cells: throughput, transit through the gateway, equilibrium stock.
  const through: number[][] = stations.map((_, si) => prod[si].map((p, ci) => Math.max(p, cons[si][ci])));
  for (const [systemId, g] of gateways) {
    const black = stations[g].def.services.includes('blackmarket');
    for (let ci = 0; ci < nC; ci++) {
      if (!legalAt[g][ci] && !black) continue;
      let rest = 0;
      for (let si = 0; si < stations.length; si++) {
        if (si !== g && stations[si].system.id === systemId) rest += through[si][ci];
      }
      if (rest > 0) through[g][ci] = Math.max(through[g][ci], GATEWAY_SHARE * rest);
    }
  }
  stations.forEach((st, si) => {
    for (let ci = 0; ci < nC; ci++) {
      const T = through[si][ci];
      if (T <= 0) continue;
      st.cells[ci] = {
        E: Math.max(8 + 14 * bulk[ci], COVER_DAYS * T),
        P: prod[si][ci],
        C: cons[si][ci],
        T,
        legal: legalAt[si][ci],
        period: 17 + 44 * unit(`${seed}:eco:${st.id}:${commodities[ci].id}:period`),
        phase: unit(`${seed}:eco:${st.id}:${commodities[ci].id}:phase`),
      };
      st.traded.push(ci);
    }
  });

  // Freight routes.
  const legs: Leg[] = [];
  const link = (a: number, b: number, rel: number, abs: number, gain: number): void => {
    for (const ci of stations[a].traded) {
      const ca = stations[a].cells[ci];
      const cb = stations[b].cells[ci];
      if (!ca || !cb) continue;
      const base = Math.max(1, commodities[ci].basePrice);
      // Carrying a tonne costs about the same whatever it is worth: dear goods travel on thin relative margins.
      const tau = rel * Math.min(1, Math.pow(500 / base, 0.3)) + abs / base;
      legs.push({ a: a * nC + ci, b: b * nC + ci, K: gain * Math.min(ca.T, cb.T), tau });
    }
  };
  for (const system of galaxy.systems ?? []) {
    const local = (system.stations ?? []).map((st) => sIndex.get(st.id)).filter((x): x is number => x !== undefined);
    for (let i = 0; i < local.length; i++) {
      for (let j = i + 1; j < local.length; j++) {
        const dvKm = clamp(finite(estimateTransferDv(system, stations[local[i]].id, stations[local[j]].id), 8000), 0, 40000) / 1000;
        link(local[i], local[j], Math.min(0.4, 0.05 + 0.014 * dvKm), 6 + 3 * dvKm, GAIN_LOCAL);
      }
    }
  }
  const inhabited = (galaxy.systems ?? []).filter((s) => gateways.has(s.id));
  const neighbours = new Map<string, string[]>();
  for (const s of inhabited) neighbours.set(s.id, []);
  const join = (a: SystemDef, b: SystemDef): void => {
    const na = neighbours.get(a.id) as string[];
    if (na.includes(b.id)) return;
    na.push(b.id);
    (neighbours.get(b.id) as string[]).push(a.id);
    const ly = systemDistance(a, b);
    link(gateways.get(a.id) as number, gateways.get(b.id) as number, 0.22 + 0.02 * ly, 40 + 6 * ly, GAIN_JUMP);
  };
  for (let i = 0; i < inhabited.length; i++) {
    for (let j = i + 1; j < inhabited.length; j++) {
      if (systemDistance(inhabited[i], inhabited[j]) <= TRADE_RANGE_LY) join(inhabited[i], inhabited[j]);
    }
  }
  for (const s of inhabited) {
    // Nobody is cut off: an isolated system trades with its nearest inhabited neighbour.
    if ((neighbours.get(s.id) as string[]).length > 0) continue;
    let best: SystemDef | undefined;
    for (const o of inhabited) {
      if (o !== s && (!best || systemDistance(s, o) < systemDistance(s, best))) best = o;
    }
    if (best) join(s, best);
  }

  return { commodities, nC, cIndex, stations, sIndex, legs, gateways, neighbours };
}

function modelOf(galaxy: GalaxyDef, seed: number): Model {
  let bySeed = MODELS.get(galaxy);
  if (!bySeed) {
    bySeed = new Map();
    MODELS.set(galaxy, bySeed);
  }
  let model = bySeed.get(seed);
  if (!model) {
    model = buildModel(galaxy, seed);
    bySeed.set(seed, model);
  }
  return model;
}

// ============================================================================================
// Price curve
// ============================================================================================

/** Price multiplier at stock ratio r with political price gain g. */
function multAt(r: number, g: number): number {
  return r <= 0 ? PRICE_MAX : clamp(g * Math.pow(r, -ELASTICITY), PRICE_MIN, PRICE_MAX);
}

/** Integral of multAt from 0 to r: exact, so quotes are additive however an order is split. */
function areaTo(r: number, g: number): number {
  if (r <= 0) return 0;
  const rHi = Math.pow(PRICE_MAX / g, -1 / ELASTICITY);
  if (r <= rHi) return PRICE_MAX * r;
  const rLo = Math.pow(PRICE_MIN / g, -1 / ELASTICITY);
  const e = 1 - ELASTICITY;
  const top = Math.min(r, rLo);
  let area = PRICE_MAX * rHi + (g * (Math.pow(top, e) - Math.pow(rHi, e))) / e;
  if (r > rLo) area += PRICE_MIN * (r - rLo);
  return area;
}

const HISTORY_SCALE = 100;

function encodeSample(mult: number): string {
  const v = clamp(Math.round(mult * HISTORY_SCALE), 0, 1295);
  return (v < 36 ? '0' : '') + v.toString(36);
}

function decodeHistory(h: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < h.length; i += 2) {
    const v = parseInt(h.slice(i, i + 2), 36);
    out.push(Number.isFinite(v) ? v / HISTORY_SCALE : 1);
  }
  return out;
}

// ============================================================================================
// State access
// ============================================================================================

function conditionsOf(state: EconomyState, stationId: string): StationConditions {
  return state.conditions?.[stationId] ?? NEUTRAL_CONDITIONS;
}

function conditionFactor(cond: StationConditions, category: CommodityCategory, key: 'production' | 'consumption' | 'price'): number {
  const lo = key === 'price' ? 0.25 : 0;
  const hi = key === 'price' ? 4 : 5;
  return clamp(finite(cond[key], 1) * finite(cond.categories?.[category]?.[key], 1), lo, hi);
}

/** Where a market rests before anything has happened to it. */
function restingRatio(cd: CellDef): number {
  return cd.P > 1.15 * cd.C ? 1.6 : cd.C > 1.15 * cd.P ? 0.7 : 1;
}

/** The live state of a cell, created at rest (and the state repaired) if missing or damaged. */
function cellState(state: EconomyState, st: StationModel, commodityId: string, cd: CellDef): MarketCellState {
  if (!state.markets || typeof state.markets !== 'object') state.markets = {};
  let market = state.markets[st.id];
  if (!market || typeof market !== 'object' || !market.cells || typeof market.cells !== 'object') {
    market = { cells: {} };
    state.markets[st.id] = market;
  }
  let cell = market.cells[commodityId];
  if (!cell || typeof cell !== 'object') {
    const r = restingRatio(cd);
    cell = { s: r * cd.E, m: multAt(r, 1), h: '' };
    market.cells[commodityId] = cell;
  }
  if (!Number.isFinite(cell.s) || cell.s < 0) cell.s = restingRatio(cd) * cd.E;
  if (!Number.isFinite(cell.m) || cell.m <= 0) cell.m = multAt(cell.s / cd.E, 1);
  if (typeof cell.h !== 'string') cell.h = '';
  return cell;
}

interface Resolved {
  model: Model;
  st: StationModel;
  ci: number;
  commodity: CommodityDef;
  cd: CellDef;
  cell: MarketCellState;
  /** Political price gain. */
  g: number;
}

function resolve(state: EconomyState, galaxy: GalaxyDef, stationId: string, commodityId: string): Resolved | undefined {
  if (!state || !galaxy) return undefined;
  const model = modelOf(galaxy, state.seed);
  const si = model.sIndex.get(stationId);
  const ci = model.cIndex.get(commodityId);
  if (si === undefined || ci === undefined) return undefined;
  const st = model.stations[si];
  const cd = st.cells[ci];
  if (!cd) return undefined;
  const commodity = model.commodities[ci];
  return {
    model,
    st,
    ci,
    commodity,
    cd,
    cell: cellState(state, st, commodity.id, cd),
    g: conditionFactor(conditionsOf(state, stationId), commodity.category, 'price'),
  };
}

/** Unrounded cost of buying n units out of stock s. */
function rawBuy(x: { cd: CellDef; commodity: CommodityDef; st: StationModel; g: number }, s: number, n: number): number {
  const E = x.cd.E;
  return x.commodity.basePrice * (1 + x.st.half) * E * (areaTo(s / E, x.g) - areaTo((s - n) / E, x.g));
}

/** Unrounded proceeds of selling n units into stock s. */
function rawSell(x: { cd: CellDef; commodity: CommodityDef; st: StationModel; g: number }, s: number, n: number): number {
  const E = x.cd.E;
  return x.commodity.basePrice * (1 - x.st.half) * E * (areaTo((s + n) / E, x.g) - areaTo(s / E, x.g));
}

const maxBuyUnits = (x: Resolved): number => Math.max(0, Math.floor(x.cell.s + 1e-9));
const maxSellUnits = (x: Resolved): number => Math.max(0, Math.floor(R_CAP * x.cd.E - x.cell.s + 1e-9));
const wholeUnits = (units: number, max: number): number => clamp(Math.floor(finite(units, 0) + 1e-9), 0, max);
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

const NO_QUOTE: Readonly<TradeQuote> = Object.freeze({ units: 0, total: 0, average: 0, maxUnits: 0 });

function buyQuote(x: Resolved, units: number): TradeQuote {
  const maxUnits = maxBuyUnits(x);
  const n = wholeUnits(units, maxUnits);
  // Rounded against the player, so unit-by-unit orders never beat one big order.
  const total = n > 0 ? Math.max(1, Math.ceil(rawBuy(x, x.cell.s, n) - 1e-7)) : 0;
  return { units: n, total, average: n > 0 ? total / n : 0, maxUnits };
}

function sellQuote(x: Resolved, units: number): TradeQuote {
  const maxUnits = maxSellUnits(x);
  const n = wholeUnits(units, maxUnits);
  const total = n > 0 ? Math.max(0, Math.floor(rawSell(x, x.cell.s, n) + 1e-7)) : 0;
  return { units: n, total, average: n > 0 ? total / n : 0, maxUnits };
}

// ============================================================================================
// Daily tick
// ============================================================================================

/** One simulated day. `events` is null during the warm-up (no shocks, no news). */
function stepDay(model: Model, state: EconomyState, day: number, events: EconomyEvent[] | null): void {
  const { nC, stations, commodities, legs } = model;
  const n = stations.length * nC;
  const refs = new Array<MarketCellState | undefined>(n);
  const s = new Float64Array(n);
  const m = new Float64Array(n);
  const gain = new Float64Array(n).fill(1);
  const prodMul = new Float64Array(n).fill(1);
  const consMul = new Float64Array(n).fill(1);
  const delta = new Float64Array(n);
  const out = new Float64Array(n);

  for (let si = 0; si < stations.length; si++) {
    const st = stations[si];
    const cond = conditionsOf(state, st.id);
    const neutral = cond === NEUTRAL_CONDITIONS;
    for (const ci of st.traded) {
      const i = si * nC + ci;
      const cell = cellState(state, st, commodities[ci].id, st.cells[ci] as CellDef);
      refs[i] = cell;
      s[i] = cell.s;
      m[i] = cell.m;
      if (!neutral) {
        const cat = commodities[ci].category;
        gain[i] = conditionFactor(cond, cat, 'price');
        prodMul[i] = conditionFactor(cond, cat, 'production');
        consMul[i] = conditionFactor(cond, cat, 'consumption');
      }
    }
  }

  // Shocks: drop the expired, roll new ones, apply the active.
  const shocked = new Set<number>();
  const shocks = (Array.isArray(state.shocks) ? state.shocks : []).filter((k) => k && k.until >= day);
  state.shocks = shocks;
  if (events) {
    const rng = makeRng(hash(`${state.seed}:shock:${day}`));
    for (let si = 0; si < stations.length; si++) {
      if (!rng.chance(SHOCK_CHANCE)) continue;
      const st = stations[si];
      const kind: 'shortage' | 'glut' = rng.chance(0.55) ? 'shortage' : 'glut';
      const pool = st.traded.filter((ci) => {
        const cd = st.cells[ci] as CellDef;
        return kind === 'shortage' ? cd.C > 0 && cd.C >= cd.P : cd.P > 0 && cd.P > cd.C;
      });
      if (pool.length === 0) continue;
      const ci = rng.weighted(pool, (c) => Math.sqrt(((st.cells[c] as CellDef).T * commodities[c].basePrice)));
      const i = si * nC + ci;
      const commodityId = commodities[ci].id;
      const length = rng.int(5, 12);
      const size = rng.next();
      if (shocks.some((k) => k.stationId === st.id && k.commodityId === commodityId)) continue;
      const cd = st.cells[ci] as CellDef;
      if (kind === 'shortage') s[i] *= 0.4 + 0.25 * size;
      else s[i] = Math.min(R_CAP * cd.E, s[i] + (0.6 + 0.6 * size) * cd.E);
      shocks.push({ stationId: st.id, commodityId, kind, until: day + length, factor: 1.5 });
      shocked.add(i);
      events.push({ kind, stationId: st.id, commodityId, day });
    }
  }
  for (const k of shocks) {
    const si = model.sIndex.get(k.stationId);
    const ci = model.cIndex.get(k.commodityId);
    if (si === undefined || ci === undefined) continue;
    const f = clamp(finite(k.factor, 1), 0, 5);
    if (k.kind === 'shortage') consMul[si * nC + ci] *= f;
    else prodMul[si * nC + ci] *= f;
  }

  // NPC freight, decided on remembered prices and limited by what each source can spare.
  const flow = new Float64Array(legs.length);
  for (let k = 0; k < legs.length; k++) {
    const leg = legs[k];
    const diff = m[leg.b] * gain[leg.b] - m[leg.a] * gain[leg.a];
    if (diff > leg.tau) {
      flow[k] = leg.K * Math.min(1, (diff - leg.tau) / RAMP);
      out[leg.a] += flow[k];
    } else if (-diff > leg.tau) {
      flow[k] = -leg.K * Math.min(1, (-diff - leg.tau) / RAMP);
      out[leg.b] -= flow[k];
    }
  }
  for (let k = 0; k < legs.length; k++) {
    const f = flow[k];
    if (f === 0) continue;
    const leg = legs[k];
    const src = f > 0 ? leg.a : leg.b;
    const dst = f > 0 ? leg.b : leg.a;
    const moved = Math.abs(f) * Math.min(1, (MAX_OUT * s[src]) / out[src]);
    delta[src] -= moved;
    delta[dst] += moved;
  }

  // Production, consumption, settling; then prices, memory and history.
  const noise = makeRng(hash(`${state.seed}:noise:${day}`));
  for (let si = 0; si < stations.length; si++) {
    const st = stations[si];
    for (const ci of st.traded) {
      const i = si * nC + ci;
      const cd = st.cells[ci] as CellDef;
      const cell = refs[i] as MarketCellState;
      const r = s[i] / cd.E;
      const season = Math.sin(2 * Math.PI * (day / cd.period + cd.phase));
      const made = cd.P * prodMul[i] * (1 + WAVE * season) * (1 + JITTER * (2 * noise.next() - 1)) * clamp((R_FULL - r) / (R_FULL - 1), 0, PROD_BOOST);
      const used =
        cd.C * consMul[i] * (1 - 0.5 * WAVE * season) * (1 + JITTER * (2 * noise.next() - 1)) *
        Math.min(1, r / R_RATION) * (1 + CONS_GLUT * clamp((r - 1) / (R_FULL - 1), 0, 1));
      const next = clamp(s[i] + made - used + RELAX * (cd.E - s[i]) + delta[i], 0, R_CAP * cd.E);
      const mult = multAt(next / cd.E, 1);
      const shown = clamp(mult * gain[i], PRICE_MIN, PRICE_MAX);
      if (events && !shocked.has(i) && shown >= 1.5 && cell.h.length >= 2) {
        const before = parseInt(cell.h.slice(-2), 36) / HISTORY_SCALE;
        if (before > 0 && shown / before >= 1.2) events.push({ kind: 'priceSpike', stationId: st.id, commodityId: commodities[ci].id, day });
      }
      cell.s = round3(next);
      cell.m = Math.round((m[i] + MEM_ALPHA * (mult - m[i])) * 10000) / 10000;
      cell.h = (cell.h + encodeSample(shown)).slice(-2 * HISTORY_DAYS);
    }
  }
}

// ============================================================================================
// Public API: lifecycle
// ============================================================================================

/** A new economy for this galaxy, settled into its trade pattern. Deterministic for (galaxy, seed). */
export function initEconomy(galaxy: GalaxyDef, seed: number): EconomyState {
  const state: EconomyState = { seed: finite(seed, 0), day: 0, markets: {}, shocks: [], conditions: {} };
  try {
    const model = modelOf(galaxy, state.seed);
    for (const st of model.stations) {
      for (const ci of st.traded) cellState(state, st, model.commodities[ci].id, st.cells[ci] as CellDef);
    }
    for (let d = -WARMUP_DAYS; d < 0; d++) stepDay(model, state, d, null);
  } catch {
    // A malformed galaxy leaves an empty economy rather than an exception.
  }
  return state;
}

/** Advance the economy to `day` (call once per elapsed sim day, in order). */
export function tickEconomy(state: EconomyState, galaxy: GalaxyDef, day: number): EconomyEvent[] {
  const events: EconomyEvent[] = [];
  try {
    const target = Math.floor(finite(day, state.day));
    if (!Number.isFinite(state.day)) state.day = target - 1;
    if (target <= state.day) return events;
    const model = modelOf(galaxy, state.seed);
    for (let d = Math.max(state.day + 1, target - MAX_CATCHUP_DAYS + 1); d <= target; d++) stepDay(model, state, d, events);
    state.day = target;
  } catch {
    // Never throw into the game loop.
  }
  return events;
}

/** Set (or with null clear) the political conditions of a station. They take effect at once on prices. */
export function setStationConditions(state: EconomyState, stationId: string, conditions: StationConditions | null): void {
  if (!state) return;
  if (!state.conditions || typeof state.conditions !== 'object') state.conditions = {};
  if (conditions) state.conditions[stationId] = conditions;
  else delete state.conditions[stationId];
}

/** The political conditions of a station (the neutral default when none are set). */
export function stationConditions(state: EconomyState, stationId: string): StationConditions {
  return state ? conditionsOf(state, stationId) : NEUTRAL_CONDITIONS;
}

// ============================================================================================
// Public API: markets
// ============================================================================================

const AVERAGES = new WeakMap<EconomyState, { day: number; avg: number[] }>();

/** Cluster-wide average price of every commodity today (cached per day). */
function averages(state: EconomyState, model: Model): number[] {
  const cached = AVERAGES.get(state);
  if (cached && cached.day === state.day && cached.avg.length === model.nC) return cached.avg;
  const sum = new Array<number>(model.nC).fill(0);
  const count = new Array<number>(model.nC).fill(0);
  for (const st of model.stations) {
    const cond = conditionsOf(state, st.id);
    for (const ci of st.traded) {
      const cd = st.cells[ci] as CellDef;
      const cell = cellState(state, st, model.commodities[ci].id, cd);
      sum[ci] += multAt(cell.s / cd.E, conditionFactor(cond, model.commodities[ci].category, 'price'));
      count[ci]++;
    }
  }
  const avg = model.commodities.map((c, ci) => Math.round(c.basePrice * (count[ci] > 0 ? sum[ci] / count[ci] : 1)));
  AVERAGES.set(state, { day: state.day, avg });
  return avg;
}

function rowOf(x: Resolved, avgPrice: number): MarketRow {
  const mult = multAt(x.cell.s / x.cd.E, x.g);
  const base = x.commodity.basePrice;
  const buy = buyQuote(x, 1);
  const sell = sellQuote(x, 1);
  const hist = decodeHistory(x.cell.h);
  let trend: -1 | 0 | 1 = 0;
  if (hist.length >= 2) {
    const then = hist[Math.max(0, hist.length - 4)];
    if (mult > then * 1.04) trend = 1;
    else if (mult < then * 0.96) trend = -1;
  }
  return {
    commodityId: x.commodity.id,
    name: x.commodity.name,
    category: x.commodity.category,
    buyPrice: buy.units > 0 ? buy.total : Math.ceil(base * (1 + x.st.half) * mult),
    sellPrice: sell.units > 0 ? sell.total : Math.floor(base * (1 - x.st.half) * mult),
    stock: maxBuyUnits(x),
    demand: clamp(0.5 + (0.5 * Math.log(mult)) / Math.log(PRICE_MAX), 0, 1),
    trend,
    avgPrice,
    legal: x.cd.legal,
  };
}

/** The station's market board, sorted by category then name. Empty for stations without a market. */
export function marketListing(state: EconomyState, galaxy: GalaxyDef, stationId: string): MarketRow[] {
  try {
    const model = modelOf(galaxy, state.seed);
    const si = model.sIndex.get(stationId);
    if (si === undefined) return [];
    const avg = averages(state, model);
    const rows: MarketRow[] = [];
    for (const ci of model.stations[si].traded) {
      const x = resolve(state, galaxy, stationId, model.commodities[ci].id);
      if (x) rows.push(rowOf(x, avg[ci]));
    }
    return rows.sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
}

/** Cost for the player to buy `units` here. Does not change the market. */
export function quoteBuy(state: EconomyState, galaxy: GalaxyDef, stationId: string, commodityId: string, units: number): TradeQuote {
  try {
    const x = resolve(state, galaxy, stationId, commodityId);
    return x ? buyQuote(x, units) : { ...NO_QUOTE };
  } catch {
    return { ...NO_QUOTE };
  }
}

/** Proceeds for the player selling `units` here. Does not change the market. */
export function quoteSell(state: EconomyState, galaxy: GalaxyDef, stationId: string, commodityId: string, units: number): TradeQuote {
  try {
    const x = resolve(state, galaxy, stationId, commodityId);
    return x ? sellQuote(x, units) : { ...NO_QUOTE };
  } catch {
    return { ...NO_QUOTE };
  }
}

/** Execute a purchase: moves stock and price, returns what was actually traded. */
export function applyBuy(state: EconomyState, galaxy: GalaxyDef, stationId: string, commodityId: string, units: number): TradeQuote {
  try {
    const x = resolve(state, galaxy, stationId, commodityId);
    if (!x) return { ...NO_QUOTE };
    const q = buyQuote(x, units);
    x.cell.s = round3(Math.max(0, x.cell.s - q.units));
    return q;
  } catch {
    return { ...NO_QUOTE };
  }
}

/** Execute a sale: moves stock and price, returns what was actually traded. */
export function applySell(state: EconomyState, galaxy: GalaxyDef, stationId: string, commodityId: string, units: number): TradeQuote {
  try {
    const x = resolve(state, galaxy, stationId, commodityId);
    if (!x) return { ...NO_QUOTE };
    const q = sellQuote(x, units);
    x.cell.s = round3(x.cell.s + q.units);
    return q;
  } catch {
    return { ...NO_QUOTE };
  }
}

/** Pumped propellant costs this fraction of crated liquid hydrogen (no handling, no cargo unit). */
const PROPELLANT_DISCOUNT = 0.6;

/** Propellant price at a station with the 'refuel' service, cr per kg: follows the local hydrogen market. */
export function propellantPrice(state: EconomyState, galaxy: GalaxyDef, stationId: string): number {
  const fallback = 0.06;
  try {
    const x = resolve(state, galaxy, stationId, 'liquid_hydrogen');
    if (!x) {
      const h = galaxy.commodities.find((c) => c.id === 'liquid_hydrogen');
      return h ? Math.round(h.basePrice * 1.3 * PROPELLANT_DISCOUNT * 10) / 10000 : fallback;
    }
    const perTonne = x.commodity.basePrice * (1 + x.st.half) * multAt(x.cell.s / x.cd.E, x.g);
    return Math.round(perTonne * PROPELLANT_DISCOUNT * 10) / 10000;
  } catch {
    return fallback;
  }
}

/** True when the station buys and sells this commodity. */
export function tradesCommodity(state: EconomyState, galaxy: GalaxyDef, stationId: string, commodityId: string): boolean {
  try {
    return resolve(state, galaxy, stationId, commodityId) !== undefined;
  } catch {
    return false;
  }
}

/** Daily closing prices (cr, before the spread) of the last ~30 days, oldest first. */
export function priceHistory(state: EconomyState, stationId: string, commodityId: string): number[] {
  try {
    const h = state.markets?.[stationId]?.cells?.[commodityId]?.h;
    if (typeof h !== 'string') return [];
    const base = commodityById(commodityId)?.basePrice ?? 0;
    return decodeHistory(h).map((v) => Math.round(v * base));
  } catch {
    return [];
  }
}

/** What the station makes and what it wants, most valuable flows first (for tooltips and the map). */
export function importExportSummary(state: EconomyState, galaxy: GalaxyDef, stationId: string): ImportExportSummary {
  const out: ImportExportSummary = { exports: [], imports: [] };
  try {
    const model = modelOf(galaxy, state.seed);
    const si = model.sIndex.get(stationId);
    if (si === undefined) return out;
    const st = model.stations[si];
    const cond = conditionsOf(state, stationId);
    const items: { item: TradeProfileItem; value: number }[] = [];
    for (const ci of st.traded) {
      const cd = st.cells[ci] as CellDef;
      const net = cd.P - cd.C;
      if (Math.abs(net) < 0.15 * cd.T) continue;
      const c = model.commodities[ci];
      const cell = cellState(state, st, c.id, cd);
      items.push({
        value: net * c.basePrice,
        item: {
          commodityId: c.id,
          name: c.name,
          category: c.category,
          level: 1,
          priceRatio: Math.round(multAt(cell.s / cd.E, conditionFactor(cond, c.category, 'price')) * 100) / 100,
        },
      });
    }
    const rank = (list: { item: TradeProfileItem; value: number }[]): TradeProfileItem[] => {
      list.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
      const top = list.length > 0 ? Math.abs(list[0].value) : 1;
      return list.slice(0, 8).map(({ item, value }) => ({ ...item, level: Math.abs(value) >= 0.5 * top ? 3 : Math.abs(value) >= 0.15 * top ? 2 : 1 }));
    };
    out.exports = rank(items.filter((x) => x.value > 0));
    out.imports = rank(items.filter((x) => x.value < 0));
  } catch {
    // fall through with what we have
  }
  return out;
}

/** A frozen copy of the station's board as of today: store it to show the player what they last saw. */
export function snapshotMarket(state: EconomyState, galaxy: GalaxyDef, stationId: string): MarketSnapshot {
  return { stationId, day: finite(state?.day, 0), rows: marketListing(state, galaxy, stationId) };
}

// ============================================================================================
// Public API: trade planning
// ============================================================================================

interface Candidate {
  src: Resolved;
  dst: Resolved;
  units: number;
  /** Most units this pairing allows. */
  cap: number;
}

/** The most profitable cargo mix for one destination, filled greedily in chunks (each commodity's profit is concave). */
function planRoute(pairs: { src: Resolved; dst: Resolved }[], cargo: number, capital: number, perCredit: boolean): Candidate[] {
  const list: Candidate[] = pairs.map((p) => ({ ...p, units: 0, cap: Math.min(maxBuyUnits(p.src), maxSellUnits(p.dst)) }));
  const chunk = Math.max(1, Math.ceil(cargo / 240));
  let room = cargo;
  let money = capital;
  const step = (c: Candidate): { q: number; cost: number; gain: number } | undefined => {
    const q = Math.min(chunk, room, c.cap - c.units);
    if (q <= 0) return undefined;
    const cost = rawBuy(c.src, c.src.cell.s - c.units, q);
    if (cost > money) return undefined;
    return { q, cost, gain: rawSell(c.dst, c.dst.cell.s + c.units, q) - cost };
  };
  const next = list.map(step);
  for (;;) {
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < list.length; i++) {
      const n = next[i];
      if (!n || n.gain <= 0) continue;
      const score = perCredit ? n.gain / n.cost : n.gain / n.q;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) break;
    const n = next[best] as { q: number; cost: number; gain: number };
    list[best].units += n.q;
    room -= n.q;
    money -= n.cost;
    // Room and money shrank for everyone: refresh the steps that no longer fit, and the one just taken.
    for (let i = 0; i < list.length; i++) {
      const o = next[i];
      if (i === best || (o && (o.q > room || o.cost > money))) next[i] = step(list[i]);
    }
  }
  return list.filter((c) => c.units > 0);
}

/**
 * Where to take a cargo from here: for each destination the best mix this hold and this purse can carry,
 * ranked by profit per trip (before propellant). Uses today's live markets; pass `stationIds` to limit it to
 * the stations the player has data for.
 */
export function bestTrades(state: EconomyState, galaxy: GalaxyDef, fromStationId: string, options: BestTradesOptions): TradeRoute[] {
  try {
    const model = modelOf(galaxy, state.seed);
    const fi = model.sIndex.get(fromStationId);
    if (fi === undefined) return [];
    const from = model.stations[fi];
    const cargo = Math.max(0, Math.floor(finite(options?.cargo, 0)));
    const capital = Math.max(0, finite(options?.capital, 0));
    if (cargo <= 0 || capital <= 0) return [];
    const allowed = options.stationIds ? new Set(options.stationIds) : null;
    const targets: StationModel[] = model.stations.filter((st) => st !== from && st.system.id === from.system.id);
    if (options.includeNeighbours) {
      for (const id of model.neighbours.get(from.system.id) ?? []) {
        const g = model.gateways.get(id);
        if (g !== undefined) targets.push(model.stations[g]);
      }
    }
    const routes: TradeRoute[] = [];
    for (const to of targets) {
      if (allowed && !allowed.has(to.id)) continue;
      const pairs: { src: Resolved; dst: Resolved }[] = [];
      for (const ci of from.traded) {
        if (!to.cells[ci]) continue;
        const id = model.commodities[ci].id;
        const src = resolve(state, galaxy, from.id, id);
        const dst = resolve(state, galaxy, to.id, id);
        if (!src || !dst) continue;
        if (!options.includeIllegal && (!src.cd.legal || !dst.cd.legal)) continue;
        pairs.push({ src, dst });
      }
      let best: TradeRoute | undefined;
      for (const perCredit of [false, true]) {
        const legs: TradeLeg[] = [];
        let units = 0;
        let cost = 0;
        let revenue = 0;
        for (const c of planRoute(pairs, cargo, capital, perCredit)) {
          const buy = buyQuote(c.src, c.units);
          const sell = sellQuote(c.dst, c.units);
          if (sell.total <= buy.total || cost + buy.total > capital) continue;
          legs.push({ commodityId: c.src.commodity.id, name: c.src.commodity.name, units: c.units, buyTotal: buy.total, sellTotal: sell.total, profit: sell.total - buy.total });
          units += c.units;
          cost += buy.total;
          revenue += sell.total;
        }
        if (legs.length === 0 || (best && best.profit >= revenue - cost)) continue;
        legs.sort((a, b) => b.profit - a.profit);
        const sameSystem = to.system.id === from.system.id;
        const dv = sameSystem ? estimateTransferDv(from.system, from.id, to.id) : undefined;
        best = {
          fromStationId: from.id,
          toStationId: to.id,
          toName: to.def.name,
          toSystemId: to.system.id,
          sameSystem,
          dv: dv !== undefined && Number.isFinite(dv) ? dv : null,
          units,
          cost,
          revenue,
          profit: revenue - cost,
          legs,
        };
      }
      if (best) routes.push(best);
    }
    routes.sort((a, b) => b.profit - a.profit);
    return routes.slice(0, Math.max(1, Math.floor(finite(options.limit, 6))));
  } catch {
    return [];
  }
}
