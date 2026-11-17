// The three great powers of the Ember Reach, their colours, and the kinds of government each one
// breeds among the minor factions in its orbit (used by sim/universe.ts when founding factions and
// by sim/factions.ts when judging who a power will back).

import type { Government, PowerDef, PowerId, RGB } from '../core/types';

/** sRGB hex ("#RRGGBB") -> linear-light RGB triple, the colour convention for all game data. */
export function hexToLinear(hex: string): RGB {
  const h = hex.replace('#', '');
  const ch = (i: number): number => {
    const s = parseInt(h.slice(i, i + 2), 16) / 255;
    const lin = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    return Math.round(lin * 10000) / 10000;
  };
  return [ch(0), ch(2), ch(4)];
}

/** Map colour of factions that answer to no power. */
export const INDEPENDENT_COLOR: RGB = hexToLinear('#8A97A6');
/** Map colour of the Scorch clans. */
export const OUTLAW_COLOR: RGB = hexToLinear('#FF5A4D');

/** System ids of the three capitals (hand-authored in src/data/systems). */
export const ASSEMBLY_CAPITAL = 'chancel';
export const HEGEMONY_CAPITAL = 'oriflamme';
export const LEAGUE_CAPITAL = 'fathom';

export const POWERS: readonly PowerDef[] = [
  {
    id: 'assembly',
    name: 'Meridian Assembly',
    shortName: 'Assembly',
    color: hexToLinear('#3FD0C9'),
    capitalSystemId: ASSEMBLY_CAPITAL,
    ethos: 'Every city a vote, every vote a contract.',
    description:
      'A federation of the terminator cities, founded when the twilight ports of Quorum agreed to settle their ' +
      'tariff wars in a chamber instead of in orbit. The Assembly governs by committee, charter and audit: it is ' +
      'slow, litigious and very rich, and its inspectors are the nearest thing the Reach has to common law. ' +
      'Its member worlds elect delegates or buy seats; either way the Rotunda keeps the ledgers.',
  },
  {
    id: 'hegemony',
    name: 'Auric Hegemony',
    shortName: 'Hegemony',
    color: hexToLinear('#F2B84B'),
    capitalSystemId: HEGEMONY_CAPITAL,
    ethos: 'Order is poured, not voted.',
    description:
      'The dynastic foundry houses of the day side, bound by oath to the Solar Court at Zenith. The houses own ' +
      'the smelters, the yards and the fleets, and they look after their own: a retainer of a great house eats ' +
      'well and is never out of work, and never quite free to leave. The Hegemony builds most of the hulls in ' +
      'the Reach and believes that entitles it to say where they fly.',
  },
  {
    id: 'league',
    name: 'Umbral League',
    shortName: 'League',
    color: hexToLinear('#9B7BFF'),
    capitalSystemId: LEAGUE_CAPITAL,
    ethos: 'No lamp but our own.',
    description:
      'A loose compact of night-side cooperatives, ice crews and free ports that agree on little except that ' +
      'nobody from the day side will ever tell them what to do. The League has no navy, only members who own ' +
      'ships, and no treasury, only a Long Table where debts are called. It mines the ice everyone drinks, asks ' +
      'few questions at its docks, and has outlasted every attempt to tidy it up.',
  },
];

/** Look up a power definition. */
export function powerById(id: PowerId): PowerDef {
  const p = POWERS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown power ${id}`);
  return p;
}

export interface GovernmentWeight {
  government: Government;
  weight: number;
}

/**
 * Governments each power favours among its aligned factions, with relative weights. A faction whose
 * government is not listed for a power is ideologically out of step with it (factions.ts may use
 * that when deciding how warmly a power supports an ally).
 */
export const POWER_GOVERNMENTS: Readonly<Record<PowerId, readonly GovernmentWeight[]>> = {
  assembly: [
    { government: 'democracy', weight: 5 },
    { government: 'corporate', weight: 4 },
    { government: 'technocracy', weight: 2 },
    { government: 'confederacy', weight: 1 },
  ],
  hegemony: [
    { government: 'patronage', weight: 5 },
    { government: 'dictatorship', weight: 2 },
    { government: 'corporate', weight: 2 },
    { government: 'theocracy', weight: 1.5 },
  ],
  league: [
    { government: 'cooperative', weight: 5 },
    { government: 'confederacy', weight: 3 },
    { government: 'technocracy', weight: 1 },
    { government: 'anarchy', weight: 1 },
  ],
};

/** Governments found among unaligned factions. */
export const INDEPENDENT_GOVERNMENTS: readonly GovernmentWeight[] = [
  { government: 'corporate', weight: 3 },
  { government: 'confederacy', weight: 2.5 },
  { government: 'cooperative', weight: 2 },
  { government: 'theocracy', weight: 2 },
  { government: 'democracy', weight: 1.5 },
  { government: 'technocracy', weight: 1.5 },
  { government: 'dictatorship', weight: 1 },
  { government: 'anarchy', weight: 0.5 },
];

/** True if `government` is one the given power favours. */
export function powerFavours(powerId: PowerId, government: Government): boolean {
  return POWER_GOVERNMENTS[powerId].some((g) => g.government === government);
}
