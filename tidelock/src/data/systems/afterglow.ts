// AFTERGLOW — the oddity: a dead star.
//
// A white dwarf: the Earth-sized, white-hot core of a sun that died four hundred million years
// ago, circled by a glowing disc of dust where its tides are grinding an old asteroid belt to
// powder. In the tiny habitable zone, an ice world has thawed into an ocean, and far out the one
// giant that survived carries an observatory with the best view in the Reach. The worlds are named
// for things left behind.

import { AU, DEG, EARTH_MASS, JUPITER_MASS, SOLAR_MASS } from '../../core/units';
import { hexToLinear as hex } from '../powers';
import type { SystemSpec } from './spec';

const hexes = (...h: string[]) => h.map(hex);

export const AFTERGLOW: SystemSpec = {
  id: 'afterglow',
  name: 'Afterglow',
  baseSecurity: 0.42,
  description:
    'Afterglow is what a sun leaves behind: a white dwarf no bigger than a planet, ringed with the glowing dust of the worlds it has eaten. ' +
    'Astronomers, pilgrims and the very rich come to look at it. Prospectors come for the rubble, which is the richest in the Reach and the hardest to reach.',
  star: {
    name: 'Afterglow',
    kind: 'whiteDwarf',
    mass: 0.62 * SOLAR_MASS,
    temperature: 11800,
    rings: { inner: 60, outer: 140, color: hex('#f2c9a0'), opacity: 0.5 },
    description:
      'Afterglow is a white dwarf: 62 % of a solar mass crushed into a sphere hardly bigger than Wick, still white-hot at 11,800 K with nothing left to burn. ' +
      'A disc of silicate dust circles it inside the Roche limit, lit from within, where its tides are grinding an asteroid belt to powder.',
    surveyValue: 9500,
  },
  bodies: [
    {
      key: 'keepsake',
      name: 'Keepsake',
      cls: 'ocean',
      mass: 0.9 * EARTH_MASS,
      orbit: { a: 0.05 * AU, e: 0.01, i: 0.5 * DEG },
      atmosphere: { pressure: 1.3e5, molarMass: 0.0275, color: hex('#4F8CFF'), sunsetColor: hex('#FFC27A'), opacity: 0.65, greenhouse: 34 },
      visual: {
        palette: hexes('#0a2644', '#12456c', '#2b6887', '#d4cdaa'),
        roughness: 0.35,
        oceanLevel: 0.96,
        oceanColor: hex('#0b3a66'),
        ice: 0.12,
        cloudCover: 0.6,
        cloudColor: [0.95, 0.95, 0.97],
        cityLights: 0.08,
      },
      description:
        'Keepsake was an ice world until its sun died and the habitable zone fell inward to meet it; now it is one warm ocean under a sky of hard blue, lit by a star that is a single blinding point. ' +
        'It has perhaps a billion years before Afterglow cools and the sea freezes again.',
      surveyValue: 16000,
    },
    {
      key: 'token',
      name: 'Token',
      cls: 'barren',
      mass: 0.08 * EARTH_MASS,
      orbit: { a: 0.11 * AU, e: 0.05, i: 2.4 * DEG, lan: 5.0 },
      atmosphere: null,
      visual: { palette: hexes('#26262a', '#4c4c52', '#7c7c82', '#b4b4b8'), roughness: 0.7, craters: 0.6 },
      description:
        'Token is the bare metal core of a planet that lost everything else when the star swelled, a ball of nickel-iron with a surface like slag. ' +
        'Under Afterglow\'s point of light its shadows are as sharp as cut paper.',
    },
    {
      key: 'heirloom',
      name: 'Heirloom',
      cls: 'gasGiant',
      mass: 0.8 * JUPITER_MASS,
      orbit: { a: 0.25 * AU, e: 0.03, i: 0.8 * DEG, lan: 1.2 },
      axialTilt: 3 * DEG,
      visual: { palette: hexes('#c8bfae', '#a89c88', '#ddd6c6', '#8f8474', '#b9ae9a'), bands: 12, storms: 0.35 },
      description:
        'Heirloom is the one giant that outlived its sun, a pale banded world that spiralled inward as the star shed half its mass. ' +
        'In white-dwarf light it has no colour at all, like a photograph of a planet.',
    },
    {
      key: 'memento',
      name: 'Memento',
      cls: 'barren',
      parent: 'heirloom',
      mass: 8e21,
      orbit: { a: 2.4e8, e: 0.005 },
      atmosphere: null,
      visual: { palette: hexes('#353230', '#67625c', '#948e84', '#c4bcae'), roughness: 0.8, craters: 0.9 },
      description:
        'Memento is a battered inner moon of Heirloom whose ice boiled away when the old sun became a giant. ' +
        'What is left is rock, glassed in places, and a great many craters.',
    },
    {
      key: 'cameo',
      name: 'Cameo',
      cls: 'ice',
      parent: 'heirloom',
      mass: 4e22,
      orbit: { a: 5.2e8, e: 0.004 },
      atmosphere: null,
      visual: { palette: hexes('#7b90a6', '#b5c5d4', '#dbe6ee', '#f2f6fa'), roughness: 0.25, craters: 0.2, ice: 1 },
      description:
        'Cameo is a white ice moon with a young, smooth face: it refroze after the star died, and little has hit it since. ' +
        'From its orbit the dust disc of Afterglow is a thin bright line with a spark at the centre.',
    },
    {
      key: 'relic',
      name: 'Relic',
      cls: 'ice',
      mass: 0.15 * EARTH_MASS,
      orbit: { a: 0.6 * AU, e: 0.12, i: 11 * DEG, lan: 3.6 },
      atmosphere: null,
      visual: { palette: hexes('#66584e', '#a59f98', '#d5d9dc', '#eef2f5'), roughness: 0.4, craters: 0.5, ice: 1 },
      description:
        'Relic is a frozen survivor on a tilted, lopsided orbit, knocked there when the star\'s death rearranged the system. ' +
        'Its ice still holds the gases of the old sun\'s last wind, which three institutes would pay to sample.',
    },
  ],
  stations: [
    {
      key: 'lastlight',
      name: 'Lastlight Observatory',
      parent: 'cameo',
      visualId: 'spindle',
      altitude: 250e3,
      m0: 2.0,
      economies: ['hightech', 'tourism'],
      population: 41_000,
      capital: true,
      owner: 'trust',
      description:
        'Lastlight Observatory is a spindle of telescopes, laboratories and expensive hotel rooms over the ice of Cameo, all of them pointed at the dead star. ' +
        'It pays better than anywhere in the Reach for survey data, and charges accordingly for the view.',
    },
    {
      key: 'thaw-station',
      name: 'Thaw Station',
      parent: 'keepsake',
      visualId: 'outpost',
      altitude: 420e3,
      economies: ['colony', 'tourism'],
      population: 2_600,
      owner: 'thaw',
      description:
        'Thaw Station is a company outpost over the new ocean of Keepsake, at the bottom of a gravity well that takes a good ship and a patient pilot to climb. ' +
        'Its residents are surveyors, divers and people who paid a great deal to be alone.',
    },
  ],
  sites: [
    {
      key: 'inheritance',
      name: 'The Inheritance',
      parent: 'star',
      kind: 'belt',
      radius: 0.17 * AU,
      e: 0.08,
      i: 5 * DEG,
      lan: 0.8,
      richness: 0.95,
      ores: [
        { commodityId: 'ferronickel_ore', weight: 4 },
        { commodityId: 'platinoid_ore', weight: 3 },
        { commodityId: 'lanthanide_ore', weight: 2 },
        { commodityId: 'uraninite', weight: 1 },
      ],
    },
    {
      key: 'bequest',
      name: 'The Bequest',
      parent: 'heirloom',
      kind: 'belt',
      radius: 8.6e8,
      e: 0.08,
      i: 21 * DEG,
      lan: 2.9,
      richness: 0.5,
      ores: [
        { commodityId: 'silicate_ore', weight: 3 },
        { commodityId: 'ferronickel_ore', weight: 3 },
        { commodityId: 'ilmenite', weight: 2 },
      ],
    },
  ],
  factions: [
    {
      key: 'trust',
      name: 'The Lastlight Trust',
      government: 'technocracy',
      powerId: null,
      influence: 0.44,
      controls: true,
      description:
        'A foundation of astronomers that owns the observatory and, by a charter all three powers signed, the star. ' +
        'The Trust appoints by publication record, governs by peer review, and has turned down every offer to buy it.',
    },
    {
      key: 'thaw',
      name: 'Keepsake Thaw Company',
      government: 'corporate',
      powerId: 'assembly',
      influence: 0.26,
      description:
        'An Assembly-chartered venture selling shoreline on a world that has only just grown shores. ' +
        'The Thaw Company is patient, well-lawyered, and quietly certain that the Trust\'s charter has a gap in it.',
    },
    {
      key: 'dawn',
      name: 'Congregation of the Second Dawn',
      government: 'theocracy',
      powerId: null,
      influence: 0.18,
      description:
        'Pilgrims who hold that a sun which died and still gives light is a promise. ' +
        'The Congregation keeps a chapel with a window on the star and tithes its members\' passage money to the Trust, which has never known what to say.',
    },
    {
      key: 'skimmers',
      name: 'Heirloom Skimmers\' Mutual',
      government: 'cooperative',
      powerId: 'league',
      influence: 0.12,
      description:
        'The scoop crews and rubble miners who supply the observatory and work the Inheritance on the side. ' +
        'They joined the League for the insurance and stay for the arguments.',
    },
  ],
};
