// TALLOW — the start system, and the classroom.
//
// One quiet red dwarf and everything a new captain needs to learn on: a twilight world with a city
// in low orbit and an outpost a short burn above it; a ringed giant with a refinery, a ring claim
// and an ice moon; a lava world to look at and an ice world to grow into. The worlds are named
// from the chandler's trade (the first charter was a lamp-makers' guild).

import { AU, DEG, EARTH_MASS, JUPITER_MASS, SOLAR_MASS } from '../../core/units';
import { hexToLinear as hex } from '../powers';
import type { SystemSpec } from './spec';

const hexes = (...h: string[]) => h.map(hex);

const SCONCE_ARGP = 0.4;
const SCONCE_M0 = 2.0;
const TROJAN_LAN = 1.1;

export const TALLOW: SystemSpec = {
  id: 'tallow',
  name: 'Tallow',
  baseSecurity: 0.55,
  description:
    'Tallow is where half the captains in the Reach learned to fly: one steady red dwarf, a twilight world with a city in orbit, ' +
    'and a ringed giant close enough to reach on a first loan. Every power keeps an office here and none of them runs the place.',
  star: {
    name: 'Tallow',
    kind: 'main',
    mass: 0.36 * SOLAR_MASS,
    activity: 0.35,
    description:
      'Tallow is a red dwarf of 36 % of a solar mass, old and even-tempered, its light the colour of a candle seen through a hand. ' +
      'It flares perhaps twice a year, politely, and the pilot schools use the warnings as drill.',
  },
  bodies: [
    {
      key: 'spill',
      name: 'Spill',
      cls: 'lava',
      mass: 0.6 * EARTH_MASS,
      orbit: { a: 0.013 * AU, e: 0.012, i: 0.6 * DEG },
      atmosphere: { pressure: 160, molarMass: 0.05, color: hex('#FF9A4D'), sunsetColor: hex('#FF5A2A'), opacity: 0.12, greenhouse: 0 },
      visual: { palette: hexes('#0d0807', '#23120d', '#431f12', '#73361a'), roughness: 0.7, craters: 0.1, lava: 0.9 },
      description:
        'Spill rounds Tallow every twenty-two hours with one face held to the fire; the noon hemisphere is a magma sea that glows across the whole system. ' +
        'Instructors point it out on the first day and tell their students never to go there.',
    },
    {
      key: 'lampblack',
      name: 'Lampblack',
      cls: 'barren',
      mass: 0.3 * EARTH_MASS,
      orbit: { a: 0.042 * AU, e: 0.02, i: 1.1 * DEG },
      atmosphere: null,
      visual: { palette: hexes('#121214', '#26262a', '#45454a', '#77767a'), roughness: 0.75, craters: 0.85 },
      description:
        'Lampblack is an airless world as dark as soot, its crust rich in graphite baked out by five hundred kelvin of sunlight. ' +
        'Nothing reflects off it; pilots find it by the stars it hides.',
    },
    {
      key: 'cresset',
      name: 'Cresset',
      cls: 'desert',
      mass: 0.7 * EARTH_MASS,
      orbit: { a: 0.086 * AU, e: 0.015, i: 0.8 * DEG },
      atmosphere: { pressure: 0.35e5, molarMass: 0.04, color: hex('#DDB07A'), sunsetColor: hex('#86A9DA'), opacity: 0.4, greenhouse: 12 },
      visual: { palette: hexes('#5a2d1c', '#96522e', '#c7884f', '#e9c898'), roughness: 0.5, craters: 0.1, cloudCover: 0.1, ice: 0 },
      description:
        'Cresset is a hot dry world of rust dunes and white salt pans under a brass-coloured sky. ' +
        'Its air is thick enough to brake against and thin enough to forgive, which makes it the pilot schools\' favourite place to teach aerocapture.',
    },
    {
      key: 'wick',
      name: 'Wick',
      cls: 'eyeball',
      mass: 1.1 * EARTH_MASS,
      orbit: { a: 0.155 * AU, e: 0.004, i: 0 },
      atmosphere: { pressure: 0.94e5, molarMass: 0.02897, color: hex('#7FA0D8'), sunsetColor: hex('#FF7A3C'), opacity: 0.55, greenhouse: 30 },
      visual: {
        palette: hexes('#1f2420', '#303a2b', '#5b5138', '#8f7a57', '#d9d0bd'),
        roughness: 0.5,
        oceanLevel: 0.46,
        oceanColor: hex('#0b2c47'),
        ice: 0.58,
        cloudCover: 0.5,
        cloudColor: [0.9, 0.88, 0.86],
        cityLights: 0.62,
      },
      description:
        'Wick keeps one face to Tallow: a noon desert under a storm that never moves, a night of ice, and between them a belt of permanent dusk where rivers run and two million people farm dark-leaved grain. ' +
        'Its towns burn their lamps all day, because it is always evening.',
    },
    {
      key: 'sconce',
      name: 'Sconce',
      cls: 'gasGiant',
      mass: 0.55 * JUPITER_MASS,
      orbit: { a: 0.44 * AU, e: 0.018, i: 0, argp: SCONCE_ARGP, m0: SCONCE_M0 },
      axialTilt: 19 * DEG,
      rings: { inner: 1.35, outer: 2.25, color: hex('#d9cfc0'), opacity: 0.85 },
      visual: { palette: hexes('#d9c7a1', '#b08a5e', '#e8dcc0', '#8a6248', '#c9a878', '#6f7f92'), bands: 14, storms: 0.55 },
      description:
        'Sconce is a butter-and-ochre hydrogen giant of 175 Earth masses, belted with storms and wearing rings of clean water ice tipped nineteen degrees to the sun. ' +
        'Seen from its moons the rings cut the sky in half; seen from Wick it is the brightest thing in the dusk.',
    },
    {
      key: 'pricket',
      name: 'Pricket',
      cls: 'barren',
      parent: 'sconce',
      mass: 4e20,
      orbit: { a: 2.1e8, e: 0.003 },
      atmosphere: null,
      visual: { palette: hexes('#3b3632', '#6b635a', '#99907f', '#c6bca8'), roughness: 0.85, craters: 0.9 },
      description:
        'Pricket is a six-hundred-kilometre shepherd moon that keeps the outer edge of Sconce\'s rings sharp. ' +
        'Its leading face is plastered white with ring frost and its trailing face is bare grey rock.',
    },
    {
      key: 'taper',
      name: 'Taper',
      cls: 'ice',
      parent: 'sconce',
      mass: 9e22,
      orbit: { a: 5.2e8, e: 0.004 },
      atmosphere: null,
      visual: { palette: hexes('#6f8aa3', '#aabfd0', '#d6e3ec', '#f0f5f9'), roughness: 0.3, craters: 0.2, ice: 1 },
      description:
        'Taper is an ice moon the size of a small planet, its shell cracked into long blue fractures by the tides of Sconce. ' +
        'The cutters who work it sell water to the whole system and have never once agreed on a price.',
    },
    {
      key: 'bobeche',
      name: 'Bobeche',
      cls: 'ice',
      parent: 'sconce',
      mass: 2.2e22,
      orbit: { a: 9.4e8, e: 0.012 },
      atmosphere: null,
      visual: { palette: hexes('#5a4b42', '#93887e', '#c9c9c8', '#e9edf0'), roughness: 0.45, craters: 0.5, ice: 1 },
      description:
        'Bobeche is half clean ice and half dark stain, its forward hemisphere dusted brown by grit swept up along its orbit. ' +
        'Nobody lives there; the pilot schools use it as a rendezvous target because it never complains.',
    },
    {
      key: 'douter',
      name: 'Douter',
      cls: 'ice',
      mass: 0.12 * EARTH_MASS,
      orbit: { a: 0.95 * AU, e: 0.06, i: 4.5 * DEG, lan: 2.3 },
      atmosphere: null,
      visual: { palette: hexes('#5d7f96', '#93b8c9', '#c9e0e8', '#eef7f9'), roughness: 0.25, craters: 0.3, ice: 1 },
      description:
        'Douter is the last world of the system, a frozen ball of water ice and carbon-dioxide frost at ninety kelvin, where Tallow is a small red coal that gives light and no warmth. ' +
        'A year and a half to go round, and no reason yet for anyone to stay.',
    },
  ],
  stations: [
    {
      key: 'chandlers-wheel',
      name: 'Chandler\'s Wheel',
      parent: 'wick',
      visualId: 'ringHabitat',
      altitude: 420e3,
      m0: 0.6,
      economies: ['service', 'agriculture'],
      population: 2_600_000,
      capital: true,
      owner: 'guild',
      description:
        'Chandler\'s Wheel is a spoked habitat ring nine hundred metres across, turning twice a minute four hundred kilometres above the dusk belt of Wick. ' +
        'Grain comes up, everything else goes down, and every pilot school in the Reach rents a berth here.',
    },
    {
      key: 'gloaming-lock',
      name: 'Gloaming Lock',
      parent: 'wick',
      visualId: 'outpost',
      altitude: 5_200e3,
      m0: 3.4,
      economies: ['service', 'colony'],
      population: 9_400,
      owner: 'commons',
      description:
        'Gloaming Lock is a customs post and fuel depot a short transfer above the Wheel, high enough to see Wick\'s whole terminator at once. ' +
        'Flying up to it and back is the first examination every student pilot sits.',
    },
    {
      key: 'renderworks',
      name: 'Renderworks',
      parent: 'sconce',
      visualId: 'refinery',
      altitude: 0,
      orbitRadii: 2.42,
      m0: 1.2,
      economies: ['refinery', 'extraction'],
      population: 18_500,
      owner: 'aurelant',
      description:
        'Renderworks rides just outside the rings of Sconce, seven hundred metres of tanks and cracking towers that melt ring ice into water, oxygen and reaction mass. ' +
        'Its furnaces light the ring plane from underneath like a lamp under a table.',
    },
    {
      key: 'taper-lock',
      name: 'Taper Lock',
      parent: 'taper',
      visualId: 'outpost',
      altitude: 260e3,
      economies: ['extraction', 'colony'],
      population: 2_300,
      owner: 'icecutters',
      description:
        'Taper Lock is a cluster of pressure cans and tank farms in low orbit of the ice moon, with Sconce and its rings filling the sky behind. ' +
        'The cutters\' mutual runs it, and the bar keeps a slate for student pilots who made it this far.',
    },
  ],
  sites: [
    {
      key: 'guttering',
      name: 'The Guttering',
      parent: 'sconce',
      kind: 'ring',
      radius: 0,
      radii: 2.12,
      richness: 0.8,
      ores: [
        { commodityId: 'water_ice', weight: 6 },
        { commodityId: 'cryovolatiles', weight: 3 },
        { commodityId: 'silicate_ore', weight: 1 },
      ],
    },
    {
      // Trojan rubble at Sconce's leading Lagrange point: same orbit, sixty degrees ahead.
      key: 'tinder-trojans',
      name: 'The Tinder Trojans',
      parent: 'star',
      kind: 'belt',
      radius: 0.44 * AU,
      e: 0.018,
      i: 1.8 * DEG,
      lan: TROJAN_LAN,
      argp: SCONCE_ARGP - TROJAN_LAN + 2 * Math.PI,
      m0: SCONCE_M0 + Math.PI / 3,
      richness: 0.55,
      ores: [
        { commodityId: 'ferronickel_ore', weight: 4 },
        { commodityId: 'silicate_ore', weight: 4 },
        { commodityId: 'lanthanide_ore', weight: 1.5 },
        { commodityId: 'platinoid_ore', weight: 0.5 },
      ],
    },
  ],
  factions: [
    {
      key: 'guild',
      name: 'The Chandlers\' Guild',
      government: 'confederacy',
      powerId: null,
      influence: 0.31,
      controls: true,
      description:
        'The Chandlers\' Guild began as the lamp-makers who chartered Tallow and is now a pact of dock-masters, pilot schools and grain factors. ' +
        'It runs the Wheel, takes no side among the powers, and charges all three the same berth fees.',
    },
    {
      key: 'commons',
      name: 'Wick Twilight Commons',
      government: 'democracy',
      powerId: 'assembly',
      influence: 0.25,
      description:
        'The elected council of the dusk-belt towns of Wick. The Commons votes on everything from water rights to lamp-oil tax and would like Tallow to take a seat in the Assembly.',
    },
    {
      key: 'aurelant',
      name: 'House Aurelant',
      government: 'patronage',
      powerId: 'hegemony',
      influence: 0.24,
      description:
        'A cadet foundry house of the Hegemony that owns Renderworks and most of the tankers that serve it. ' +
        'House Aurelant pays well, houses its retainers for life, and regards the Guild as a tenant who has forgotten the lease.',
    },
    {
      key: 'icecutters',
      name: 'Taper Icecutters\' Mutual',
      government: 'cooperative',
      powerId: 'league',
      influence: 0.2,
      description:
        'One cutter, one share, one vote. The Mutual works the ice of Taper, sends a delegate to the Long Table when it remembers to, and sells water to people it disapproves of at a fair price.',
    },
  ],
};
