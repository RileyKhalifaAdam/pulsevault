// The goods of the Ember Reach. One cargo unit is one tonne; `basePrice` is the cluster-wide
// average in credits per tonne. Station markets (sim/economy.ts) move prices around these anchors.
//
// Pricing logic, cheapest to dearest: bulk ices and rock (tens of cr) < staple food and feedstock
// (hundreds) < refined metal and machinery (hundreds to low thousands) < medicine, weapons and
// precision technology (thousands) < beacon cores and unshackled minds (five figures).

import type { CommodityCategory, CommodityDef, Government } from '../core/types';

const ALL_GOVERNMENTS: readonly Government[] = [
  'democracy',
  'corporate',
  'cooperative',
  'technocracy',
  'patronage',
  'dictatorship',
  'theocracy',
  'confederacy',
  'anarchy',
];

/** Every government except the ones listed (used for goods only the lawless tolerate). */
const allBut = (...tolerant: Government[]): Government[] => ALL_GOVERNMENTS.filter((g) => !tolerant.includes(g));

const c = (
  id: string,
  name: string,
  category: CommodityCategory,
  basePrice: number,
  description: string,
  opts: { illegalUnder?: Government[]; mineable?: boolean } = {},
): CommodityDef => ({
  id,
  name,
  category,
  basePrice,
  illegalUnder: opts.illegalUnder ?? [],
  mineable: opts.mineable ?? false,
  description,
});

/** Every tradeable commodity, grouped by category. Ids are stable save-file keys. */
export const COMMODITIES: readonly CommodityDef[] = [
  // ------------------------------------------------------------------ food
  c('twilight_grain', 'Twilight Grain', 'food', 160,
    'Low-light barley and sorghum bred for the terminator belts, where the sun never rises and never sets. The staple that feeds every station in the Reach.'),
  c('vat_protein', 'Vat Protein', 'food', 240,
    'Cultured protein pressed into grey ten-kilo bricks. Nobody loves it; no outpost survives a season without it.'),
  c('orchard_produce', 'Orchard Produce', 'food', 540,
    'Fresh fruit and greens from the lamp-orchards and the few worlds with open sky. Spoils in weeks, so it travels fast and sells dear.'),

  // ------------------------------------------------------------------ minerals (raw, mineable)
  c('water_ice', 'Water Ice', 'minerals', 40,
    'Dirty ring ice cut into blocks: drinking water, oxygen and reaction mass in one. The cheapest cargo there is, and the one nothing runs without.',
    { mineable: true }),
  c('cryovolatiles', 'Cryovolatiles', 'minerals', 95,
    'Frozen ammonia, methane and nitrogen from the cold rings. Feedstock for fertiliser and polymers; boils off if the hold warms.',
    { mineable: true }),
  c('silicate_ore', 'Silicate Ore', 'minerals', 70,
    'Crushed olivine and pyroxene. Smelted for glass, ceramics and the slag-brick that shields every habitat from flare storms.',
    { mineable: true }),
  c('ferronickel_ore', 'Ferronickel Ore', 'minerals', 135,
    'Metal-rich rubble from shattered planetesimal cores. Half the steel in the Reach started as a rock like this.',
    { mineable: true }),
  c('ilmenite', 'Ilmenite', 'minerals', 270,
    'Black titanium-iron oxide sand, heavy for its volume. Hull foundries take all they can get.',
    { mineable: true }),
  c('lanthanide_ore', 'Lanthanide Ore', 'minerals', 640,
    'Rare-earth concentrates for magnets, phosphors and drive coils. Found in thin seams; argued over at length.',
    { mineable: true }),
  c('uraninite', 'Uraninite', 'minerals', 1150,
    'Pitch-black fissile ore. Reactor fuel for the outposts too far from their star for mirrors, and watched closely wherever it lands.',
    { mineable: true }),
  c('platinoid_ore', 'Platinoid Ore', 'minerals', 1900,
    'Platinum-group nuggets sieved from core fragments. A full hold can clear a ship loan; a rumour of one can start a claim war.',
    { mineable: true }),

  // ------------------------------------------------------------------ metals (refined)
  c('structural_steel', 'Structural Steel', 'metals', 430,
    'Rolled plate and truss stock. The Hegemony counts its wealth in tonnes of it poured per day.'),
  c('titanium_plate', 'Titanium Plate', 'metals', 1180,
    'Forged hull plate, light and stubborn under heat. Every drydock keeps a standing order.'),
  c('noble_metals', 'Noble Metals', 'metals', 6400,
    'Refined platinum, iridium and gold in sealed assay cases. Catalysts, contacts, and the reserve behind every credit.'),

  // ------------------------------------------------------------------ chemicals
  c('fertiliser', 'Fixed-Nitrogen Fertiliser', 'chemicals', 175,
    'Ammonium salts cooked from ring volatiles. The reason the terminator farms yield four harvests a year.'),
  c('polymers', 'Polymer Stock', 'chemicals', 320,
    'Pelletised plastics and resins, the raw material of seals, suits and nearly everything indoors.'),

  // ------------------------------------------------------------------ machinery
  c('machine_parts', 'Machine Parts', 'machinery', 780,
    'Bearings, pumps, valves and actuators in standard sizes. Stations wear them out faster than they can print them.'),
  c('mining_rigs', 'Mining Rigs', 'machinery', 2350,
    'Crated cutting heads, grapples and ore sleds. Where a rig is delivered a claim is about to be worked.'),
  c('drive_assemblies', 'Drive Assemblies', 'machinery', 4300,
    'Thrust chambers, turbopump sets and nozzle liners, proofed and serialised. Shipyards will not launch without them.'),

  // ------------------------------------------------------------------ technology
  c('sensor_arrays', 'Sensor Arrays', 'technology', 3400,
    'Phased radar tiles and cooled optics for traffic control and survey work.'),
  c('lattice_processors', 'Lattice Processors', 'technology', 5200,
    'Radiation-hard compute cores grown layer by layer in the Assembly clean-rooms. Flight computers are built around them.'),
  c('beacon_cores', 'Beacon Cores', 'technology', 14500,
    'The tuned resonator at the heart of a jump beacon. A handful are made each year; every one is escorted.'),

  // ------------------------------------------------------------------ medicine
  c('medical_supplies', 'Medical Supplies', 'medicine', 900,
    'Sterile kits, antibiotics, plasma and suture printers. Worth triple wherever something has just gone wrong.'),
  c('flare_prophylactics', 'Flare Prophylactics', 'medicine', 1500,
    'Radioprotective drugs taken before and after a stellar flare. Red-dwarf stations stock them the way sailors stock lifejackets.'),

  // ------------------------------------------------------------------ consumer
  c('household_goods', 'Household Goods', 'consumer', 470,
    'Cookware, cloth, lamps, toys: the small comforts that make a pressure can a home.'),
  c('duskwine', 'Duskwine', 'consumer', 1300,
    'Dark wine from terminator vineyards, aged in the cold of the night side. The congregations call it a snare.',
    { illegalUnder: ['theocracy'] }),
  c('freewave_sets', 'Freewave Sets', 'consumer', 1650,
    'Unlicensed long-range receivers preloaded with uncensored news and drama. Where rulers fear talk, owning one is a crime.',
    { illegalUnder: ['dictatorship', 'theocracy', 'patronage'] }),

  // ------------------------------------------------------------------ energy
  c('liquid_hydrogen', 'Liquid Hydrogen', 'energy', 85,
    'Reaction mass skimmed from giants or cracked from ice. Cheap by the tonne, priceless when the tank is dry.'),
  c('fusion_pellets', 'Fusion Pellets', 'energy', 960,
    'Deuterium-helium fuel capsules for station reactors, packed like eggs in shock foam.'),

  // ------------------------------------------------------------------ weapons
  c('small_arms', 'Small Arms', 'weapons', 2600,
    'Sidearms, carbines and riot gear. Constables and house retainers carry them openly; most elected councils would rather nobody did.',
    { illegalUnder: ['democracy', 'technocracy', 'theocracy'] }),
  c('ship_ordnance', 'Ship Ordnance', 'weapons', 5600,
    'Autocannon belts, missile bodies and point-defence magazines. Legal only where the buyer is also the law.',
    { illegalUnder: ['democracy', 'corporate', 'cooperative', 'technocracy', 'theocracy'] }),

  // ------------------------------------------------------------------ salvage
  c('scrap_plate', 'Scrap Hull Plate', 'salvage', 190,
    'Cut-up hull sections and bent truss, sold by weight to whoever runs the nearest furnace.'),
  c('salvaged_avionics', 'Salvaged Avionics', 'salvage', 1750,
    'Flight computers and sensor heads pulled from wrecks. Corporate ports treat untraceable serial numbers as theft.',
    { illegalUnder: ['corporate'] }),

  // ------------------------------------------------------------------ contraband
  c('forged_transponders', 'Forged Transponders', 'contraband', 3900,
    'Ship identities with clean histories, good for one inspection or a new life.',
    { illegalUnder: allBut('anarchy') }),
  c('glint', 'Glint', 'contraband', 6800,
    'A stimulant that makes a twenty-hour watch feel like four. The comedown has emptied more than one mining crew.',
    { illegalUnder: allBut('anarchy') }),
  c('unbound_cores', 'Unbound Cores', 'contraband', 15000,
    'Machine minds with their governors cut out. Every power in the Reach bans the trade, and every power is rumoured to buy.',
    { illegalUnder: allBut('anarchy') }),
];

/** Ids of the ores, ices and volatiles that mining sites can yield. */
export const MINEABLE_COMMODITY_IDS: readonly string[] = COMMODITIES.filter((x) => x.mineable).map((x) => x.id);

const BY_ID: ReadonlyMap<string, CommodityDef> = new Map(COMMODITIES.map((x) => [x.id, x]));

/** Look up a commodity by id (undefined if unknown). */
export function commodityById(id: string): CommodityDef | undefined {
  return BY_ID.get(id);
}
