// ORIFLAMME — capital of the Auric Hegemony.
//
// A golden K dwarf, bright by the standards of the Reach. Zenith, the house world, is a tide-locked
// desert whose day side is one continuous foundry; its moon carries the fleet's bastion. Far out,
// the gold-ringed giant Escutcheon holds the yards that build most of the hulls in the cluster.
// The worlds are named from heraldry.

import { AU, DEG, EARTH_MASS, JUPITER_MASS, SOLAR_MASS } from '../../core/units';
import { hexToLinear as hex } from '../powers';
import type { SystemSpec } from './spec';

const hexes = (...h: string[]) => h.map(hex);

const ESCUTCHEON_ARGP = 1.3;
const ESCUTCHEON_M0 = 4.4;
const RETINUE_LAN = 0.5;

export const ORIFLAMME: SystemSpec = {
  id: 'oriflamme',
  name: 'Oriflamme',
  baseSecurity: 0.92,
  description:
    'Oriflamme is the throne of the Auric Hegemony: a gold sun, a furnace world, and yards that never stop. ' +
    'Order here is absolute and visible, from the patrol wings off Pennon to the house lamps that burn on every dock.',
  star: {
    name: 'Oriflamme',
    kind: 'main',
    mass: 0.7 * SOLAR_MASS,
    activity: 0.12,
    description:
      'Oriflamme is an orange-gold K dwarf of 70 % of a solar mass, steady and nearly flareless. ' +
      'To eyes raised under red embers its light is the colour of poured bronze, and the Hegemony took its name from it.',
  },
  bodies: [
    {
      key: 'bezant',
      name: 'Bezant',
      cls: 'lava',
      mass: 1.4 * EARTH_MASS,
      orbit: { a: 0.035 * AU, e: 0.006, i: 0.7 * DEG },
      atmosphere: { pressure: 300, molarMass: 0.05, color: hex('#FFB060'), sunsetColor: hex('#FF6A30'), opacity: 0.14, greenhouse: 0 },
      visual: { palette: hexes('#0b0b0d', '#1e1a1c', '#3a2a26', '#5e3a2a'), roughness: 0.6, craters: 0.05, lava: 1 },
      description:
        'Bezant circles Oriflamme in under three days, a super-Earth with a magma ocean for a day side and a sky of rock vapour. ' +
        'From Zenith it shows as a coin of red gold beside the sun, and the houses stamp it on their ingots.',
    },
    {
      key: 'zenith',
      name: 'Zenith',
      cls: 'desert',
      mass: 0.9 * EARTH_MASS,
      orbit: { a: 0.38 * AU, e: 0.008, i: 0 },
      atmosphere: { pressure: 0.62e5, molarMass: 0.036, color: hex('#E3C48F'), sunsetColor: hex('#8FB0E0'), opacity: 0.42, greenhouse: 14 },
      visual: {
        palette: hexes('#5a3d22', '#9c6b34', '#cf9f58', '#ecd29c'),
        roughness: 0.45,
        craters: 0.06,
        cloudCover: 0.12,
        cloudColor: [0.9, 0.84, 0.7],
        ice: 0.05,
        cityLights: 1,
      },
      description:
        'Zenith holds one face to its sun, and the great houses built on it: mirror fields, smelters and rolling mills from the noon point to the edge of shadow, under a dust-gold sky. ' +
        'Fifty million retainers live in the cool of the dusk line and work in the light.',
    },
    {
      key: 'pennon',
      name: 'Pennon',
      cls: 'barren',
      parent: 'zenith',
      mass: 6e21,
      orbit: { a: 1.1e8, e: 0.01 },
      atmosphere: null,
      visual: { palette: hexes('#3a3028', '#6a5a48', '#9a8466', '#c8b592'), roughness: 0.8, craters: 0.85 },
      description:
        'Pennon is Zenith\'s one moon, a tan, cratered rock seven hundred kilometres in radius that keeps a four-day orbit. ' +
        'The Regnant Guard has hollowed its near side into magazines and calls the result a fort.',
    },
    {
      key: 'tabard',
      name: 'Tabard',
      cls: 'rocky',
      mass: 0.5 * EARTH_MASS,
      orbit: { a: 0.72 * AU, e: 0.04, i: 2.2 * DEG, lan: 3.0 },
      rotationPeriod: 30 * 3600,
      visual: { palette: hexes('#33272a', '#5e4347', '#8c6660', '#b99a86'), roughness: 0.6, craters: 0.3, ice: 0.22, cloudCover: 0.05 },
      description:
        'Tabard is a cold plum-and-rust desert that turns once in thirty hours, the nearest thing to a free world under Oriflamme. ' +
        'Its dome farmers hold their land by a charter older than the Hegemony and have never let a house forget it.',
    },
    {
      key: 'escutcheon',
      name: 'Escutcheon',
      cls: 'gasGiant',
      mass: 1.4 * JUPITER_MASS,
      orbit: { a: 1.6 * AU, e: 0.045, i: 0.9 * DEG, lan: 0, argp: ESCUTCHEON_ARGP, m0: ESCUTCHEON_M0 },
      axialTilt: 24 * DEG,
      rings: { inner: 1.5, outer: 2.5, color: hex('#d8b878'), opacity: 0.7 },
      visual: { palette: hexes('#e2c58f', '#b98a4e', '#f0e0b8', '#8c6238', '#d0a868', '#a8733f'), bands: 18, storms: 0.45 },
      description:
        'Escutcheon is a bronze-banded giant of 445 Earth masses, ringed in dusty gold and tilted so that the rings stand open to the sun. ' +
        'The Hegemony puts it on its coins, its warships and the wall behind every magistrate.',
    },
    {
      key: 'chevron',
      name: 'Chevron',
      cls: 'barren',
      parent: 'escutcheon',
      mass: 5e22,
      orbit: { a: 4.2e8, e: 0.006 },
      atmosphere: null,
      visual: { palette: hexes('#2b2624', '#5a4c44', '#8a7566', '#b9a690'), roughness: 0.75, craters: 0.7 },
      description:
        'Chevron is the innermost big moon of Escutcheon, a dense brown rock scoured by the giant\'s radiation belts. ' +
        'Convict crews quarried it once; the pits are still visible, and still in shadow.',
    },
    {
      key: 'mantling',
      name: 'Mantling',
      cls: 'ice',
      parent: 'escutcheon',
      mass: 1.6e23,
      orbit: { a: 9.0e8, e: 0.003 },
      atmosphere: null,
      visual: { palette: hexes('#66584e', '#a59f98', '#d5d9dc', '#eef2f5'), roughness: 0.35, craters: 0.3, ice: 1 },
      description:
        'Mantling is a banded ice moon bigger than Mercury, grooved where its crust has spread and refrozen. ' +
        'The yards overhead take its water for coolant and its name for their launch blessings.',
    },
    {
      key: 'orle',
      name: 'Orle',
      cls: 'ice',
      parent: 'escutcheon',
      mass: 2.4e23,
      orbit: { a: 1.9e9, e: 0.03 },
      atmosphere: { pressure: 1.2e5, molarMass: 0.028, color: hex('#E0A050'), sunsetColor: hex('#B8642C'), opacity: 0.92, greenhouse: 9 },
      visual: { palette: hexes('#5a3a1c', '#8a5e2c', '#b98a48', '#d8b070'), roughness: 0.3, craters: 0.05, ice: 0.2, cloudCover: 0.7, cloudColor: [0.82, 0.6, 0.32] },
      description:
        'Orle hides under an orange smog of nitrogen and methane thicker than Quorum\'s air, with hydrocarbon seas at its poles. ' +
        'It is the only moon in the Reach where a pilot can fly a winged ship, and where a dropped tool takes a minute to land.',
    },
    {
      key: 'tressure',
      name: 'Tressure',
      cls: 'ice',
      mass: 0.1 * EARTH_MASS,
      orbit: { a: 3.4 * AU, e: 0.11, i: 9 * DEG, lan: 1.9 },
      atmosphere: null,
      visual: { palette: hexes('#7b90a6', '#b5c5d4', '#dbe6ee', '#f2f6fa'), roughness: 0.3, craters: 0.35, ice: 1 },
      description:
        'Tressure is a frozen outer world on a tilted seven-year orbit, the border of the system in every sense. ' +
        'House exiles are sent to its listening post; a few have asked to stay.',
    },
  ],
  stations: [
    {
      key: 'solar-court',
      name: 'The Solar Court',
      parent: 'zenith',
      visualId: 'ringHabitat',
      altitude: 600e3,
      m0: 0.3,
      economies: ['industrial', 'service'],
      population: 52_000_000,
      capital: true,
      owner: 'maudelaine',
      description:
        'The Solar Court is the seat of the Hegemony: a habitat ring plated in gold-anodised alloy, holding the audience halls of the nine great houses above the day side of Zenith. ' +
        'Petitioners dock at the hub and are made to walk the full spoke.',
    },
    {
      key: 'ingot-row',
      name: 'Ingot Row',
      parent: 'zenith',
      visualId: 'refinery',
      altitude: 2_000e3,
      m0: 2.6,
      economies: ['refinery', 'industrial'],
      population: 340_000,
      owner: 'maudelaine',
      description:
        'Ingot Row is the largest smelter in the Reach, a line of solar furnaces a short burn above the Court that turns out a hull\'s worth of plate every hour. ' +
        'Its radiators glow dull red on the night side like a second sunset.',
    },
    {
      key: 'fort-regnant',
      name: 'Fort Regnant',
      parent: 'pennon',
      visualId: 'citadel',
      altitude: 110e3,
      economies: ['military', 'industrial'],
      population: 64_000,
      owner: 'guard',
      description:
        'Fort Regnant is the fleet anchorage of the Hegemony, an armoured bastion in low orbit of Pennon with its magazines in the moon below. ' +
        'Its guns cover every approach to Zenith, and its officers\' mess is the best place in the system to hear where the next trouble will be.',
    },
    {
      key: 'aurate-yards',
      name: 'Aurate Yards',
      parent: 'mantling',
      visualId: 'drydock',
      altitude: 320e3,
      economies: ['shipyard', 'industrial'],
      population: 120_000,
      owner: 'serrat',
      description:
        'Aurate Yards is a kilometre of open slipway over the ice of Mantling, where House Serrat lays down gunships and heavy freighters three at a time. ' +
        'Half the hulls in the Reach carry its plate stamp somewhere under the paint.',
    },
    {
      key: 'hazewatch',
      name: 'Hazewatch',
      parent: 'orle',
      visualId: 'outpost',
      altitude: 300e3,
      economies: ['extraction', 'colony'],
      population: 3_100,
      owner: 'serrat',
      description:
        'Hazewatch is a tank farm and skimmer base above the smog of Orle, pumping hydrocarbons up from the polar seas for the polymer trade. ' +
        'The crews are on two-year contracts and count the days in orange.',
    },
  ],
  sites: [
    {
      key: 'gilt-shoals',
      name: 'The Gilt Shoals',
      parent: 'escutcheon',
      kind: 'ring',
      radius: 0,
      radii: 2.3,
      richness: 0.7,
      ores: [
        { commodityId: 'silicate_ore', weight: 4 },
        { commodityId: 'water_ice', weight: 3 },
        { commodityId: 'ferronickel_ore', weight: 2 },
        { commodityId: 'lanthanide_ore', weight: 1 },
      ],
    },
    {
      // Trojan rubble at Escutcheon's trailing Lagrange point.
      key: 'retinue',
      name: 'The Retinue',
      parent: 'star',
      kind: 'belt',
      radius: 1.6 * AU,
      e: 0.045,
      i: 2.6 * DEG,
      lan: RETINUE_LAN,
      argp: ESCUTCHEON_ARGP - RETINUE_LAN,
      m0: ESCUTCHEON_M0 - Math.PI / 3,
      richness: 0.65,
      ores: [
        { commodityId: 'ferronickel_ore', weight: 5 },
        { commodityId: 'ilmenite', weight: 3 },
        { commodityId: 'silicate_ore', weight: 2 },
        { commodityId: 'platinoid_ore', weight: 1 },
      ],
    },
    {
      key: 'tilt-yard',
      name: 'The Tilt-Yard',
      parent: 'star',
      kind: 'belt',
      radius: 1.06 * AU,
      e: 0.07,
      i: 4 * DEG,
      lan: 4.6,
      richness: 0.4,
      ores: [
        { commodityId: 'silicate_ore', weight: 4 },
        { commodityId: 'ferronickel_ore', weight: 3 },
        { commodityId: 'uraninite', weight: 1 },
      ],
    },
  ],
  factions: [
    {
      key: 'maudelaine',
      name: 'House Maudelaine',
      government: 'patronage',
      powerId: 'hegemony',
      influence: 0.42,
      controls: true,
      description:
        'First of the nine great houses and keeper of the Solar Court. ' +
        'House Maudelaine has poured steel on Zenith for eleven generations, houses a tenth of its people, and regards the Hegemony as a family business that got out of hand.',
    },
    {
      key: 'serrat',
      name: 'House Serrat',
      government: 'patronage',
      powerId: 'hegemony',
      influence: 0.22,
      description:
        'The shipwright house, masters of Aurate Yards. ' +
        'House Serrat builds for anyone the Court allows and remembers every hull by name; its retainers are born, trained and buried in the yards.',
    },
    {
      key: 'guard',
      name: 'The Regnant Guard',
      government: 'dictatorship',
      powerId: 'hegemony',
      influence: 0.16,
      description:
        'The standing fleet of the Hegemony, sworn to the Court and to no single house. ' +
        'The Guard keeps the lanes clear and the houses honest, and its marshals have twice had to be reminded that they do not rule.',
    },
    {
      key: 'vigil',
      name: 'Vigil of the Long Noon',
      government: 'theocracy',
      powerId: 'hegemony',
      influence: 0.12,
      description:
        'The foundry faith of Zenith, which holds that the unmoving sun is a covenant and labour in its light a sacrament. ' +
        'The Vigil runs the hospices and the shift bells, and no house opens a furnace without its blessing.',
    },
    {
      key: 'freeholders',
      name: 'Tabard Freeholders',
      government: 'democracy',
      powerId: null,
      influence: 0.08,
      description:
        'The dome farmers of Tabard, who settled before the houses came and hold their charter in a vault with three locks. ' +
        'They vote on everything, owe fealty to nobody, and are permitted to exist as proof of the Court\'s magnanimity.',
    },
  ],
};
