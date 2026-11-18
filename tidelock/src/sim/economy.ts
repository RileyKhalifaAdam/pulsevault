// Market simulation. INTERFACE STUB: the exported names and signatures below are the contract the game loop
// (src/sim/game.ts) is written against. The economy engineer replaces the bodies with the real supply-and-demand
// model and may add exports and fields, but must keep every export here compatible.
//
// One cargo unit is one tonne (core/types CARGO_UNIT_MASS). Prices are credits per unit.

import type { CommodityCategory } from '../core/types';
import type { GalaxyDef } from './universe';

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

/** Plain JSON-serialisable economy state (lives in the save file). */
export interface EconomyState {
  seed: number;
  /** Last simulated day (sim time / 86400, floored). */
  day: number;
  /** Per-station market state; shape is private to this module. */
  markets: Record<string, unknown>;
}

export function initEconomy(_galaxy: GalaxyDef, seed: number): EconomyState {
  return { seed, day: 0, markets: {} };
}

/** Advance the economy to `day` (call once per elapsed sim day, in order). */
export function tickEconomy(state: EconomyState, _galaxy: GalaxyDef, day: number): EconomyEvent[] {
  state.day = day;
  return [];
}

/** The station's market board, sorted by category then name. Empty for stations without a market. */
export function marketListing(_state: EconomyState, galaxy: GalaxyDef, _stationId: string): MarketRow[] {
  return galaxy.commodities.map((c) => ({
    commodityId: c.id,
    name: c.name,
    category: c.category,
    buyPrice: Math.round(c.basePrice * 1.05),
    sellPrice: Math.round(c.basePrice * 0.95),
    stock: 100,
    demand: 0.5,
    trend: 0 as const,
    avgPrice: c.basePrice,
    legal: true,
  }));
}

function flatQuote(galaxy: GalaxyDef, commodityId: string, units: number, mul: number): TradeQuote {
  const c = galaxy.commodities.find((x) => x.id === commodityId);
  const n = Math.max(0, Math.min(100, Math.floor(units)));
  const price = c ? Math.round(c.basePrice * mul) : 0;
  return { units: c ? n : 0, total: price * n, average: price, maxUnits: c ? 100 : 0 };
}

/** Cost for the player to buy `units` here. Does not change the market. */
export function quoteBuy(_state: EconomyState, galaxy: GalaxyDef, _stationId: string, commodityId: string, units: number): TradeQuote {
  return flatQuote(galaxy, commodityId, units, 1.05);
}

/** Proceeds for the player selling `units` here. Does not change the market. */
export function quoteSell(_state: EconomyState, galaxy: GalaxyDef, _stationId: string, commodityId: string, units: number): TradeQuote {
  return flatQuote(galaxy, commodityId, units, 0.95);
}

/** Execute a purchase: moves stock and price, returns what was actually traded. */
export function applyBuy(state: EconomyState, galaxy: GalaxyDef, stationId: string, commodityId: string, units: number): TradeQuote {
  return quoteBuy(state, galaxy, stationId, commodityId, units);
}

/** Execute a sale: moves stock and price, returns what was actually traded. */
export function applySell(state: EconomyState, galaxy: GalaxyDef, stationId: string, commodityId: string, units: number): TradeQuote {
  return quoteSell(state, galaxy, stationId, commodityId, units);
}

/** Propellant price at a station with the 'refuel' service, cr per kg. */
export function propellantPrice(_state: EconomyState, _galaxy: GalaxyDef, _stationId: string): number {
  return 0.4;
}
