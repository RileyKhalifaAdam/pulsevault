// CHANCEL — capital of the Meridian Assembly.
//
// An early red dwarf whose twilight world, Quorum, holds the largest cities in the Reach. Low orbit
// is crowded and orderly: the Rotunda, a trade spindle a short burn above it, and a shipyard on the
// captured moon Teller. Further out a storm-banded giant carries a resonant pair of moons, one
// molten, one ice. The worlds are named from the business of a parliament.

import { AU, DEG, EARTH_MASS, JUPITER_MASS, SOLAR_MASS } from '../../core/units';
import { hexToLinear as hex } from '../powers';
import type { SystemSpec } from './spec';

const hexes = (...h: string[]) => h.map(hex);

/** Docket and Ballot keep a 2:1 resonance: Ballot's orbit is 2^(2/3) times Docket's. */
const DOCKET_A = 3.6e8;
const BALLOT_A = DOCKET_A * Math.pow(2, 2 / 3);

export const CHANCEL: SystemSpec = {
  id: 'chancel',
  name: 'Chancel',
  baseSecurity: 0.92,
  description:
    'Chancel is the seat of the Meridian Assembly and the most heavily governed star in the Reach. ' +
    'Its traffic lanes are painted on every chart, its inspectors are incorruptible to the point of tedium, and a quarter of all the people in the cluster live along one strip of dusk on Quorum.',
  star: {
    name: 'Chancel',
    kind: 'main',
    mass: 0.48 * SOLAR_MASS,
    activity: 0.22,
    description:
      'Chancel is a bright early red dwarf of 48 % of a solar mass, as warm in colour as an ember gets before it turns amber. ' +
      'It is quiet enough that the Assembly publishes its flare forecast a year ahead and is seldom wrong.',
  },
  bodies: [
    {
      key: 'gavel',
      name: 'Gavel',
      cls: 'barren',
      mass: 0.25 * EARTH_MASS,
      orbit: { a: 0.03 * AU, e: 0.01, i: 0.9 * DEG },
      atmosphere: null,
      visual: { palette: hexes('#2b2624', '#5a4c44', '#8a7566', '#b9a690'), roughness: 0.8, craters: 0.9 },
      description:
        'Gavel is a scorched iron-rich cinder that circles Chancel in under three days, seven hundred kelvin on its sunward face. ' +
        'It strikes across the star\'s disc so regularly that Quorum\'s first clocks were set by it.',
    },
    {
      key: 'proviso',
      name: 'Proviso',
      cls: 'desert',
      mass: 0.8 * EARTH_MASS,
      orbit: { a: 0.11 * AU, e: 0.012, i: 0.5 * DEG },
      atmosphere: { pressure: 2.4e5, molarMass: 0.04, color: hex('#E2C08A'), sunsetColor: hex('#9DB4D6'), opacity: 0.7, greenhouse: 45 },
      visual: { palette: hexes('#4d4530', '#857a50', '#b8ab78', '#e0d7ae'), roughness: 0.4, craters: 0.05, cloudCover: 0.35, cloudColor: [0.86, 0.8, 0.68], ice: 0 },
      description:
        'Proviso is a pressure-cooker: two and a half bars of dry carbon dioxide over yellow dune seas, hot enough at the surface to cook on the rocks. ' +
        'Its upper air is the busiest aerobraking corridor in Assembly space, and the only one with a queue.',
    },
    {
      key: 'quorum',
      name: 'Quorum',
      cls: 'eyeball',
      mass: 1.35 * EARTH_MASS,
      orbit: { a: 0.235 * AU, e: 0.004, i: 0 },
      atmosphere: { pressure: 1.1e5, molarMass: 0.02897, color: hex('#86A8E0'), sunsetColor: hex('#FF9050'), opacity: 0.6, greenhouse: 30 },
      visual: {
        palette: hexes('#232823', '#34402e', '#5f5a3e', '#93805c', '#dcd4c2'),
        roughness: 0.45,
        oceanLevel: 0.55,
        oceanColor: hex('#0c3050'),
        ice: 0.5,
        cloudCover: 0.55,
        cloudColor: [0.92, 0.9, 0.88],
        cityLights: 1,
      },
      description:
        'Quorum is the great twilight world of the Reach: a ring of dusk four hundred kilometres wide and forty thousand long, lit end to end by thirty-eight million people. ' +
        'From orbit the terminator cities make a second, golden ring around a planet that already wears one of cloud.',
    },
    {
      key: 'teller',
      name: 'Teller',
      cls: 'barren',
      parent: 'quorum',
      mass: 3e21,
      orbit: { a: 9.5e7, e: 0.02 },
      atmosphere: null,
      visual: { palette: hexes('#35322f', '#625d56', '#8e877c', '#bdb5a6'), roughness: 0.8, craters: 0.8 },
      description:
        'Teller is a captured asteroid twelve hundred kilometres across, and it is on loan: tides will bring it down in a few hundred million years. ' +
        'Until then it gives Quorum a shipyard out of the traffic lanes and a moon to count the months by.',
    },
    {
      key: 'rider',
      name: 'Rider',
      cls: 'rocky',
      mass: 0.35 * EARTH_MASS,
      orbit: { a: 0.4 * AU, e: 0.03, i: 1.6 * DEG, lan: 0.7 },
      visual: { palette: hexes('#43291e', '#74452f', '#a36a46', '#cc9c74'), roughness: 0.65, craters: 0.35, ice: 0.18, cloudCover: 0.04 },
      description:
        'Rider is a cold rust desert just far enough from Chancel to turn on its own axis, with frost at the poles and dust storms that last a season. ' +
        'The Assembly has been debating whether to settle it properly for a hundred and forty years.',
    },
    {
      key: 'plenary',
      name: 'Plenary',
      cls: 'gasGiant',
      mass: 0.9 * JUPITER_MASS,
      orbit: { a: 0.85 * AU, e: 0.03, i: 0.4 * DEG, lan: 4.1 },
      axialTilt: 6 * DEG,
      visual: { palette: hexes('#cfc3ae', '#9a8f86', '#e6dfd0', '#7d8794', '#b7a48c'), bands: 16, storms: 0.8 },
      description:
        'Plenary is a grey-and-cream giant of nearly a Jupiter mass, banded like a ledger and never still. ' +
        'Its largest storm, the Standing Order, has held the same latitude since before the Assembly was founded.',
    },
    {
      key: 'docket',
      name: 'Docket',
      cls: 'lava',
      parent: 'plenary',
      mass: 7e22,
      orbit: { a: DOCKET_A, e: 0.0045 },
      atmosphere: { pressure: 2, molarMass: 0.064, color: hex('#E8D27A'), sunsetColor: hex('#C8742A'), opacity: 0.08, greenhouse: 0 },
      visual: { palette: hexes('#151008', '#4a3a12', '#9c7f24', '#d9c45a'), roughness: 0.55, craters: 0.02, lava: 0.7 },
      description:
        'Docket is squeezed by Plenary\'s tides on every orbit and has turned itself inside out many times over: sulphur plains in yellow and black, lava lakes, no crater older than a century. ' +
        'Its resonance with Ballot keeps the fires fed.',
    },
    {
      key: 'ballot',
      name: 'Ballot',
      cls: 'ice',
      parent: 'plenary',
      mass: 1.3e23,
      orbit: { a: BALLOT_A, e: 0.002 },
      atmosphere: null,
      visual: { palette: hexes('#7b90a6', '#b5c5d4', '#dbe6ee', '#f2f6fa'), roughness: 0.25, craters: 0.15, ice: 1 },
      description:
        'Ballot goes round Plenary exactly once for every two turns of Docket, a smooth white moon with an ocean under its shell. ' +
        'Refinery tugs lift its ice by the kilotonne and the scar has yet to show from orbit.',
    },
    {
      key: 'tabling',
      name: 'Tabling',
      cls: 'barren',
      parent: 'plenary',
      mass: 1.5e22,
      orbit: { a: 1.45e9, e: 0.03 },
      atmosphere: null,
      visual: { palette: hexes('#1e1f22', '#44464b', '#74777c', '#a9abad'), roughness: 0.7, craters: 0.95 },
      description:
        'Tabling is a dark, heavily cratered outer moon on a twelve-day orbit, untouched since it formed. ' +
        'Motions to mine it are introduced every session and, true to the name, set aside.',
    },
    {
      key: 'recess',
      name: 'Recess',
      cls: 'ice',
      mass: 0.06 * EARTH_MASS,
      orbit: { a: 1.9 * AU, e: 0.09, i: 7 * DEG, lan: 5.2 },
      atmosphere: null,
      visual: { palette: hexes('#66584e', '#a59f98', '#d5d9dc', '#eef2f5'), roughness: 0.35, craters: 0.4, ice: 1 },
      description:
        'Recess is a small frozen world on a tilted four-year orbit, eighty kelvin and silent. ' +
        'The Assembly keeps a sealed archive vault under its ice, on the principle that nobody will go that far to burn a record.',
    },
  ],
  stations: [
    {
      key: 'rotunda',
      name: 'The Rotunda',
      parent: 'quorum',
      visualId: 'ringHabitat',
      altitude: 520e3,
      m0: 1.0,
      economies: ['service', 'hightech'],
      population: 38_000_000,
      capital: true,
      owner: 'delegacy',
      description:
        'The Rotunda is the chamber of the Meridian Assembly: a white habitat ring over the dusk line of Quorum, with the debating floor in the hub where every delegate floats at the same height. ' +
        'Half the contracts in the Reach are registered here, and all of the appeals.',
    },
    {
      key: 'ledgerline',
      name: 'Ledgerline Exchange',
      parent: 'quorum',
      visualId: 'spindle',
      altitude: 1_900e3,
      m0: 4.0,
      economies: ['service', 'agriculture'],
      population: 210_000,
      owner: 'ledgerline',
      description:
        'Ledgerline Exchange is the Assembly\'s bonded port, a trade spindle one short transfer above the Rotunda where cargo waits while its paperwork clears. ' +
        'Grain futures for the whole cluster are struck on its floor.',
    },
    {
      key: 'teller-yards',
      name: 'Teller Yards',
      parent: 'teller',
      visualId: 'drydock',
      altitude: 90e3,
      economies: ['shipyard', 'industrial'],
      population: 26_000,
      owner: 'lodge',
      description:
        'Teller Yards is an open-frame drydock in low orbit of Quorum\'s little moon, building couriers and survey ships to Assembly specification. ' +
        'Its shipwrights are a lodge, not a company, and will tell you the difference at length.',
    },
    {
      key: 'cloture-works',
      name: 'Cloture Works',
      parent: 'ballot',
      visualId: 'refinery',
      altitude: 380e3,
      economies: ['refinery', 'extraction'],
      population: 9_400,
      owner: 'skimmers',
      description:
        'Cloture Works is a refinery over the ice of Ballot that cracks water and scooped hydrogen into propellant for the Plenary run. ' +
        'It is the one place in Chancel space where a captain can still buy fuel without filling in a form.',
    },
    {
      key: 'riders-halt',
      name: 'Rider\'s Halt',
      parent: 'rider',
      visualId: 'outpost',
      altitude: 340e3,
      economies: ['colony', 'extraction'],
      population: 1_800,
      owner: 'audit',
      description:
        'Rider\'s Halt is a survey outpost and fuel cache over the cold desert of Rider, staffed by people who are waiting for a vote. ' +
        'It pays well for machinery and better for company.',
    },
  ],
  sites: [
    {
      key: 'filibuster',
      name: 'The Filibuster',
      parent: 'plenary',
      kind: 'belt',
      radius: 2.6e9,
      e: 0.07,
      i: 14 * DEG,
      lan: 2.2,
      richness: 0.6,
      ores: [
        { commodityId: 'ferronickel_ore', weight: 4 },
        { commodityId: 'silicate_ore', weight: 3 },
        { commodityId: 'platinoid_ore', weight: 0.8 },
        { commodityId: 'uraninite', weight: 0.7 },
      ],
    },
    {
      key: 'abstention',
      name: 'The Abstention Belt',
      parent: 'star',
      kind: 'belt',
      radius: 0.58 * AU,
      e: 0.05,
      i: 3 * DEG,
      lan: 1.4,
      richness: 0.45,
      ores: [
        { commodityId: 'silicate_ore', weight: 4 },
        { commodityId: 'ferronickel_ore', weight: 3 },
        { commodityId: 'ilmenite', weight: 2 },
        { commodityId: 'lanthanide_ore', weight: 1 },
      ],
    },
  ],
  factions: [
    {
      key: 'delegacy',
      name: 'The Quorum Delegacy',
      government: 'democracy',
      powerId: 'assembly',
      influence: 0.4,
      controls: true,
      description:
        'The elected government of the terminator cities and first among the Assembly\'s members. ' +
        'The Delegacy holds the Rotunda, chairs every committee worth chairing, and believes that anything can be settled if enough people are made to sit through it.',
    },
    {
      key: 'audit',
      name: 'Chancel Audit Office',
      government: 'technocracy',
      powerId: 'assembly',
      influence: 0.22,
      description:
        'The inspectors, actuaries and statisticians who check everyone else\'s sums. ' +
        'The Audit Office is appointed by examination, answers to no party, and is the most feared institution in Assembly space.',
    },
    {
      key: 'ledgerline',
      name: 'Ledgerline Mutual',
      government: 'corporate',
      powerId: 'assembly',
      influence: 0.2,
      description:
        'A freight insurer that grew into the Reach\'s largest clearing house. ' +
        'Ledgerline buys its Assembly seats openly, pays its claims promptly, and has never lost a case it chose to bring.',
    },
    {
      key: 'lodge',
      name: 'Teller Shipwrights\' Lodge',
      government: 'cooperative',
      powerId: null,
      influence: 0.1,
      description:
        'The yard workers of Teller, organised as a lodge with its own apprenticeships, pensions and picket lines. ' +
        'It builds to Assembly contracts and votes against Assembly candidates, on principle.',
    },
    {
      key: 'skimmers',
      name: 'Plenary Free Skimmers',
      government: 'confederacy',
      powerId: null,
      influence: 0.08,
      description:
        'A loose pact of scoop-ship owners and tug crews working Plenary and its moons. ' +
        'They pay their tariffs late, keep Cloture Works unregulated by sheer persistence, and are tolerated because the fuel has to come from somewhere.',
    },
  ],
};
