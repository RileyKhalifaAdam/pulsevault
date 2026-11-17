// FATHOM — capital of the Umbral League, in so far as the League admits to having one.
//
// A dim mid-M dwarf. The League's seat is not on a world at all but on a trade spindle over the
// ice moon Sounding, deep in the dark-ringed ice giant Abyssal's family of moons, where the jump
// beacon delivers ships a short burn from the docks. The one temperate world, Benthos, is more
// night than day. The worlds are named from the deep sea none of the founders ever saw.

import { AU, DEG, EARTH_MASS, SOLAR_MASS } from '../../core/units';
import { hexToLinear as hex } from '../powers';
import type { SystemSpec } from './spec';

const hexes = (...h: string[]) => h.map(hex);

export const FATHOM: SystemSpec = {
  id: 'fathom',
  name: 'Fathom',
  baseSecurity: 0.62,
  description:
    'Fathom is the heart of the Umbral League: a dim star, a dark-ringed ice giant, and a free port where debts are called across a table forty metres long. ' +
    'Nobody here will ask your business. Everybody will know it by the second day.',
  star: {
    name: 'Fathom',
    kind: 'main',
    mass: 0.16 * SOLAR_MASS,
    activity: 0.7,
    description:
      'Fathom is a small M dwarf of 16 % of a solar mass, deep red and restless. ' +
      'It flares hard several times a year, and the League\'s habit of living on night sides and under ice began as simple prudence.',
  },
  bodies: [
    {
      key: 'leadline',
      name: 'Leadline',
      cls: 'barren',
      mass: 0.4 * EARTH_MASS,
      orbit: { a: 0.018 * AU, e: 0.01, i: 0.8 * DEG },
      atmosphere: null,
      visual: { palette: hexes('#1e1f22', '#44464b', '#74777c', '#a9abad'), roughness: 0.75, craters: 0.9 },
      description:
        'Leadline is a dense grey cinder on a two-day orbit, stripped of its air by Fathom\'s flares long ago. ' +
        'League navigators take their first fix on it when they come out of a jump, as sailors once swung a weight to find the bottom.',
    },
    {
      key: 'thermocline',
      name: 'Thermocline',
      cls: 'desert',
      mass: 0.6 * EARTH_MASS,
      orbit: { a: 0.036 * AU, e: 0.008, i: 0.4 * DEG },
      atmosphere: { pressure: 0.5e5, molarMass: 0.04, color: hex('#D6A878'), sunsetColor: hex('#7FA6D9'), opacity: 0.4, greenhouse: 15 },
      visual: { palette: hexes('#553c23', '#946635', '#c49557', '#e3cb9c'), roughness: 0.5, craters: 0.12, cloudCover: 0.08, ice: 0 },
      description:
        'Thermocline is a tide-locked dust bowl, hot enough on the day side to bake clay and cold enough at midnight to freeze its own air into frost. ' +
        'The wind between the two never stops, and has filed the terminator hills into blades.',
    },
    {
      key: 'benthos',
      name: 'Benthos',
      cls: 'eyeball',
      mass: 0.85 * EARTH_MASS,
      orbit: { a: 0.066 * AU, e: 0.006, i: 0 },
      atmosphere: { pressure: 0.9e5, molarMass: 0.02897, color: hex('#7C9CCB'), sunsetColor: hex('#F0703A'), opacity: 0.5, greenhouse: 30 },
      visual: {
        palette: hexes('#1c2426', '#2b3a3a', '#4c5148', '#7f7a68', '#d7d6cf'),
        roughness: 0.5,
        oceanLevel: 0.5,
        oceanColor: hex('#0a2a3c'),
        ice: 0.78,
        cloudCover: 0.45,
        cloudColor: [0.86, 0.87, 0.9],
        cityLights: 0.55,
      },
      description:
        'Benthos sits at the cold edge of Fathom\'s habitable zone: an ice world with a single thawed sea under the noon point and a shore of dark orchards around it. ' +
        'Its people chose the night side of the shoreline, and light their towns violet so the flare watch can tell them from fires.',
    },
    {
      key: 'abyssal',
      name: 'Abyssal',
      cls: 'iceGiant',
      mass: 17 * EARTH_MASS,
      orbit: { a: 0.21 * AU, e: 0.02, i: 0.6 * DEG, lan: 2.0 },
      axialTilt: 23 * DEG,
      rings: { inner: 1.6, outer: 2.3, color: hex('#4a4e5a'), opacity: 0.45 },
      visual: { palette: hexes('#1f4f6e', '#2f7a8c', '#173a5c', '#58a3a8'), bands: 6, storms: 0.3 },
      description:
        'Abyssal is a Neptune-mass ice giant the colour of deep water, circled by narrow rings of ice so dark with tholin dust that they show only where they cross the planet. ' +
        'Everything the League values orbits it: ice, hydrogen, and privacy.',
    },
    {
      key: 'halocline',
      name: 'Halocline',
      cls: 'ice',
      parent: 'abyssal',
      mass: 6e21,
      orbit: { a: 1.2e8, e: 0.004 },
      atmosphere: null,
      visual: { palette: hexes('#5d7f96', '#93b8c9', '#c9e0e8', '#eef7f9'), roughness: 0.3, craters: 0.25, ice: 1 },
      description:
        'Halocline is a small bright ice moon just beyond the rings, salted with frost from its own geysers. ' +
        'Skimmer crews use it as a mark: inside its orbit the ring claims begin and the arguments with them.',
    },
    {
      key: 'sounding',
      name: 'Sounding',
      cls: 'ice',
      parent: 'abyssal',
      mass: 5.5e22,
      orbit: { a: 2.3e8, e: 0.003 },
      atmosphere: null,
      visual: { palette: hexes('#6f8aa3', '#a9bfd2', '#d3e0ea', '#edf3f8'), roughness: 0.3, craters: 0.2, ice: 1 },
      description:
        'Sounding is the League\'s home ice: a moon of clean water ice nearly four thousand kilometres across, mined by cooperatives since before there was a League. ' +
        'Its quarries are cut in terraces that catch Abyssal\'s blue light like the steps of an amphitheatre.',
    },
    {
      key: 'trench',
      name: 'Trench',
      cls: 'barren',
      parent: 'abyssal',
      mass: 1.2e22,
      orbit: { a: 4.3e8, e: 0.04 },
      atmosphere: null,
      visual: { palette: hexes('#161618', '#2c2b2e', '#4b4a4e', '#75747a'), roughness: 0.8, craters: 0.85 },
      description:
        'Trench is a captured outer moon as black as lamp soot, on a loose eight-day orbit. ' +
        'Ships that would rather not be seen arriving at the Long Table tend to arrive behind Trench first.',
    },
    {
      key: 'hadal',
      name: 'Hadal',
      cls: 'ice',
      mass: 0.3 * EARTH_MASS,
      orbit: { a: 0.42 * AU, e: 0.05, i: 3.1 * DEG, lan: 0.9 },
      atmosphere: null,
      visual: { palette: hexes('#66584e', '#a59f98', '#d5d9dc', '#eef2f5'), roughness: 0.35, craters: 0.4, ice: 1 },
      description:
        'Hadal is the outermost world of Fathom, eighty-five kelvin of nitrogen frost over water-ice bedrock. ' +
        'The League keeps its oldest claims here, and its longest feuds.',
    },
  ],
  stations: [
    {
      key: 'long-table',
      name: 'The Long Table',
      parent: 'sounding',
      visualId: 'spindle',
      altitude: 300e3,
      m0: 0.9,
      economies: ['service', 'extraction'],
      population: 1_900_000,
      capital: true,
      owner: 'compact',
      description:
        'The Long Table is a trade spindle over the quarries of Sounding, named for the table in its core where every League member may call a debt and be heard. ' +
        'It has no customs hall. It has a great many people who notice things.',
    },
    {
      key: 'meltwater-works',
      name: 'Meltwater Works',
      parent: 'abyssal',
      visualId: 'refinery',
      altitude: 0,
      orbitRadii: 2.62,
      m0: 2.2,
      economies: ['refinery', 'extraction'],
      population: 22_000,
      owner: 'meltwater',
      description:
        'Meltwater Works rides just outside Abyssal\'s dark rings, cracking ring ice and scooped hydrogen into the reaction mass that half the League flies on. ' +
        'Its tank farm is the largest in the Reach and is never more than a third full.',
    },
    {
      key: 'undertow',
      name: 'Undertow',
      parent: 'benthos',
      visualId: 'ringHabitat',
      altitude: 450e3,
      m0: 5.1,
      economies: ['agriculture', 'service'],
      population: 2_400_000,
      owner: 'orchards',
      description:
        'Undertow is a habitat ring over the night shore of Benthos, home to the orchard cooperatives and the market where the League buys its fruit. ' +
        'It was spun up by hand, a spoke a year, and the spokes do not quite match.',
    },
    {
      key: 'scupper',
      name: 'The Scupper',
      parent: 'benthos',
      visualId: 'outpost',
      altitude: 3_400e3,
      m0: 1.7,
      economies: ['service'],
      population: 6_200,
      services: ['market', 'missions', 'refuel', 'repair', 'blackmarket'],
      owner: 'ledger',
      description:
        'The Scupper is a cluster of second-hand habitat cans a short burn above Undertow, where cargo that should not exist is weighed, priced and forgotten. ' +
        'The League knows about it. The League has decided not to.',
    },
    {
      key: 'hadal-deep',
      name: 'Hadal Deep',
      parent: 'hadal',
      visualId: 'outpost',
      altitude: 350e3,
      economies: ['extraction'],
      population: 900,
      owner: 'icewrights',
      description:
        'Hadal Deep is a claim office and fuel cache over the frozen edge of the system, two pads and a still. ' +
        'Crews who winter here come back rich or do not come back to the trade.',
    },
  ],
  sites: [
    {
      key: 'black-shoals',
      name: 'The Black Shoals',
      parent: 'abyssal',
      kind: 'ring',
      radius: 0,
      radii: 2.05,
      richness: 0.85,
      ores: [
        { commodityId: 'water_ice', weight: 5 },
        { commodityId: 'cryovolatiles', weight: 4 },
        { commodityId: 'silicate_ore', weight: 1 },
        { commodityId: 'uraninite', weight: 0.4 },
      ],
    },
    {
      key: 'bathyal-scatter',
      name: 'The Bathyal Scatter',
      parent: 'star',
      kind: 'belt',
      radius: 0.115 * AU,
      e: 0.04,
      i: 2.4 * DEG,
      lan: 3.3,
      richness: 0.5,
      ores: [
        { commodityId: 'silicate_ore', weight: 4 },
        { commodityId: 'ferronickel_ore', weight: 3 },
        { commodityId: 'lanthanide_ore', weight: 1.5 },
        { commodityId: 'ilmenite', weight: 1 },
      ],
    },
    {
      key: 'hadal-moraine',
      name: 'The Hadal Moraine',
      parent: 'hadal',
      kind: 'belt',
      radius: 3.6e7,
      e: 0.04,
      richness: 0.6,
      ores: [
        { commodityId: 'water_ice', weight: 4 },
        { commodityId: 'cryovolatiles', weight: 3 },
        { commodityId: 'uraninite', weight: 1 },
      ],
    },
  ],
  factions: [
    {
      key: 'compact',
      name: 'Compact of the Long Table',
      government: 'confederacy',
      powerId: 'league',
      influence: 0.36,
      controls: true,
      description:
        'The standing moot of League port captains, which meets at the table it is named for and can bind its members to exactly what they agreed and no more. ' +
        'It is the nearest thing the Umbral League has to a government, and it would rather you did not use the word.',
    },
    {
      key: 'icewrights',
      name: 'Sounding Icewrights\' Cooperative',
      government: 'cooperative',
      powerId: 'league',
      influence: 0.26,
      description:
        'The oldest cooperative in the Reach: the quarry crews of Sounding, one share and one vote apiece. ' +
        'The Icewrights set the price of water for the League and have never raised it in a famine.',
    },
    {
      key: 'orchards',
      name: 'Benthos Dusk Orchards',
      government: 'cooperative',
      powerId: 'league',
      influence: 0.18,
      description:
        'The growers of the Benthos night shore, who feed the League and mean to be thanked for it. ' +
        'Their meetings are held outdoors, in the dark, and run until everybody has spoken.',
    },
    {
      key: 'meltwater',
      name: 'Meltwater Bonded Carriers',
      government: 'corporate',
      powerId: null,
      influence: 0.12,
      description:
        'A tanker company from the core that bought into the Abyssal ring trade and stayed. ' +
        'Meltwater pays League dues without joining, an arrangement both sides describe as temporary.',
    },
    {
      key: 'ledger',
      name: 'Nobody\'s Ledger',
      government: 'anarchy',
      powerId: 'league',
      influence: 0.08,
      description:
        'Less a faction than an understanding among the brokers of the Scupper: no names, no records, debts settled in person. ' +
        'The Long Table has never recognised it and has never once moved against it.',
    },
  ],
};
