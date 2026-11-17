// FALSELIGHT — the outlaw haven.
//
// A brown dwarf: sixty Jupiter masses that never lit, glowing dull magenta from the heat of its own
// collapse. Its inner worlds whirl round it in hours, deep in a gravity well no patrol cares to
// enter; the haven itself hides far out at the cold ice giant Leeshore, where the jump beacon is.
// The worlds are named from the wreckers' trade (false lights on a lee shore, and what washes up).

import { DEG, EARTH_MASS, SOLAR_MASS } from '../../core/units';
import { hexToLinear as hex } from '../powers';
import type { SystemSpec } from './spec';

const hexes = (...h: string[]) => h.map(hex);

/** Lure and Jetsam keep a 2:1 resonance that pumps Lure's eccentricity and keeps it molten. */
const LURE_A = 7.0e8;
const JETSAM_A = LURE_A * Math.pow(2, 2 / 3);

export const FALSELIGHT: SystemSpec = {
  id: 'falselight',
  name: 'Falselight',
  baseSecurity: 0.08,
  description:
    'Falselight is a star that failed and a port that should not exist. ' +
    'The Scorch clans fence their takings here, the breakers cut stolen hulls into honest plate, and the only law is the Moot\'s: pay what you owe, and start nothing inside the docks.',
  star: {
    name: 'Falselight',
    kind: 'brownDwarf',
    mass: 0.058 * SOLAR_MASS,
    temperature: 1650,
    activity: 0.2,
    description:
      'Falselight never lit. It is an L-type brown dwarf of sixty Jupiter masses, glowing a dull magenta at 1,650 K from the heat of its own slow collapse, and so dim that ships have found it by flying into its gravity. ' +
      'The first crew to chart it named it for the lamps wreckers hang on rocks.',
  },
  bodies: [
    {
      key: 'lure',
      name: 'Lure',
      cls: 'lava',
      mass: 0.5 * EARTH_MASS,
      orbit: { a: LURE_A, e: 0.02, i: 0.3 * DEG },
      atmosphere: { pressure: 40, molarMass: 0.064, color: hex('#E8B060'), sunsetColor: hex('#C0502A'), opacity: 0.1, greenhouse: 0 },
      visual: { palette: hexes('#120a08', '#3a1d10', '#7a4416', '#c08a2a'), roughness: 0.6, craters: 0.02, lava: 0.85 },
      description:
        'Lure goes round Falselight in under twelve hours, so close that the brown dwarf spans ten degrees of its sky. ' +
        'The starlight would barely warm it; the tides do the rest, and its whole surface is sulphur flats and open vents.',
    },
    {
      key: 'jetsam',
      name: 'Jetsam',
      cls: 'barren',
      mass: 0.3 * EARTH_MASS,
      orbit: { a: JETSAM_A, e: 0.012, i: 0.5 * DEG },
      atmosphere: null,
      visual: { palette: hexes('#2a2422', '#514540', '#7c6c62', '#a89888'), roughness: 0.75, craters: 0.8 },
      description:
        'Jetsam is a bare brown rock locked two-to-one with Lure, lit the colour of old blood on one side and not at all on the other. ' +
        'Things are left on its night side for collection, and nobody asks by whom.',
    },
    {
      key: 'lagan',
      name: 'Lagan',
      cls: 'ice',
      mass: 0.2 * EARTH_MASS,
      orbit: { a: 2.4e9, e: 0.03, i: 1.9 * DEG, lan: 4.0 },
      atmosphere: null,
      visual: { palette: hexes('#4f4a55', '#8b8793', '#c3c3cc', '#e6e8ee'), roughness: 0.35, craters: 0.4, ice: 1 },
      description:
        'Lagan is a frozen world in the dim middle of the system, its ice faintly pink in the brown dwarf\'s glow. ' +
        'In the wreckers\' tongue lagan is cargo sunk with a buoy on it, to be fetched later; the name is not an accident.',
    },
    {
      key: 'leeshore',
      name: 'Leeshore',
      cls: 'iceGiant',
      mass: 14 * EARTH_MASS,
      orbit: { a: 1.3e10, e: 0.04, i: 1.2 * DEG, lan: 1.0 },
      axialTilt: 12 * DEG,
      visual: { palette: hexes('#1c2340', '#2c3a66', '#141a30', '#47568c'), bands: 5, storms: 0.2 },
      description:
        'Leeshore is an ice giant almost too dark to see, an indigo disc against the stars, colder than anything in the core. ' +
        'It is far enough from Falselight for a jump drive to bite, which is the whole reason the haven is here.',
    },
    {
      key: 'wrack',
      name: 'Wrack',
      cls: 'ice',
      parent: 'leeshore',
      mass: 2.5e22,
      orbit: { a: 1.2e8, e: 0.004 },
      atmosphere: null,
      visual: { palette: hexes('#56505c', '#8f8a98', '#c5c4ce', '#e8e9ef'), roughness: 0.4, craters: 0.5, ice: 1 },
      description:
        'Wrack is a grey ice moon of Leeshore, pitted with the craters of everything the giant has ever swept up. ' +
        'The Moot turns above it, and the clans bury their dead in its ice.',
    },
    {
      key: 'flotsam',
      name: 'Flotsam',
      cls: 'barren',
      parent: 'leeshore',
      mass: 3e21,
      orbit: { a: 2.5e8, e: 0.03 },
      atmosphere: null,
      visual: { palette: hexes('#19191c', '#343338', '#55545a', '#807f86'), roughness: 0.85, craters: 0.9 },
      description:
        'Flotsam is a small dark moon on the edge of Leeshore\'s grip, tumbling slowly and good for nothing. ' +
        'Clan pilots race around it for money.',
    },
  ],
  stations: [
    {
      key: 'wreckers-moot',
      name: 'Wreckers\' Moot',
      parent: 'wrack',
      visualId: 'spindle',
      altitude: 200e3,
      m0: 0.4,
      economies: ['service', 'industrial'],
      population: 86_000,
      capital: true,
      owner: 'moot',
      description:
        'Wreckers\' Moot is a trade spindle assembled from the drums of three different stations, none of them bought. ' +
        'Everything is for sale on its decks except a berth for a warship, and its one rule is kept by everyone at once.',
    },
    {
      key: 'knackers-yard',
      name: 'The Knacker\'s Yard',
      parent: 'leeshore',
      visualId: 'drydock',
      altitude: 0,
      orbitRadii: 3.73,
      m0: 3.0,
      economies: ['shipyard', 'industrial'],
      population: 9_000,
      owner: 'lodge',
      description:
        'The Knacker\'s Yard is an open-frame dock between Leeshore and Wrack where hulls of doubtful title are cut up, renumbered and sold as salvage. ' +
        'Its shipwrights can fit anything to anything and do not want to know where you got it.',
    },
    {
      key: 'blind-tiger',
      name: 'Blind Tiger',
      parent: 'lagan',
      visualId: 'outpost',
      altitude: 400e3,
      economies: ['service'],
      population: 1_400,
      owner: 'tiger',
      description:
        'Blind Tiger is a fuel dock and drinking den over Lagan, deep enough in Falselight\'s gravity that no patrol has ever thought the climb back out worth it. ' +
        'The lights are kept low and the transponders off.',
    },
  ],
  sites: [
    {
      key: 'lee-shoals',
      name: 'The Lee Shoals',
      parent: 'star',
      kind: 'belt',
      radius: 5.6e9,
      e: 0.06,
      i: 4 * DEG,
      lan: 2.7,
      richness: 0.7,
      ores: [
        { commodityId: 'ferronickel_ore', weight: 4 },
        { commodityId: 'silicate_ore', weight: 3 },
        { commodityId: 'uraninite', weight: 1.2 },
        { commodityId: 'platinoid_ore', weight: 0.8 },
      ],
    },
    {
      // A moon that strayed inside Leeshore's Roche limit and has not finished coming apart.
      key: 'breakers',
      name: 'The Breakers',
      parent: 'leeshore',
      kind: 'belt',
      radius: 5.2e7,
      richness: 0.6,
      ores: [
        { commodityId: 'water_ice', weight: 3 },
        { commodityId: 'silicate_ore', weight: 3 },
        { commodityId: 'ferronickel_ore', weight: 2 },
      ],
    },
  ],
  factions: [
    {
      key: 'moot',
      name: 'The Wreckers\' Moot',
      government: 'anarchy',
      powerId: null,
      influence: 0.3,
      controls: true,
      description:
        'The Moot is every captain with a berth at Falselight, met in a ring with their sidearms checked at the door. ' +
        'It keeps the docks neutral, the air breathable and the powers out, and holds that a law nobody voted for is only a threat.',
    },
    {
      key: 'gutterlight',
      name: 'Clan Gutterlight',
      government: 'anarchy',
      powerId: null,
      criminal: true,
      influence: 0.27,
      description:
        'The oldest of the Scorch clans, raiders and toll-takers who learned their trade luring ships onto Falselight before it was charted. ' +
        'They keep their word to each other, their grudges for generations, and a cut of every cargo that crosses the Badlands without an escort.',
    },
    {
      key: 'lodge',
      name: 'Knackers\' Lodge',
      government: 'cooperative',
      powerId: 'league',
      influence: 0.18,
      description:
        'The breakers and shipwrights of the Yard, organised on League lines with a share for every cutter. ' +
        'The Lodge insists it is a salvage cooperative like any other, and the Long Table, which buys its plate, agrees.',
    },
    {
      key: 'tiger',
      name: 'Blind Tiger Syndicate',
      government: 'corporate',
      powerId: null,
      influence: 0.15,
      description:
        'Fences, brokers and bankers to the Badlands, run as a company with dividends and a board. ' +
        'The Syndicate has never committed a crime in person and has financed most of the others.',
    },
    {
      key: 'unlit',
      name: 'Vigil of the Unlit Sun',
      government: 'theocracy',
      powerId: null,
      influence: 0.1,
      description:
        'A sect that came to Falselight to pray to a star that refused to shine, and found the congregation it deserved. ' +
        'The Vigil runs the only hospital in the system and asks no patient how they were hurt.',
    },
  ],
};
