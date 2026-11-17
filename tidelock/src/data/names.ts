// Name material for the Ember Reach. Everything here is our own: star names, the naming themes that
// settlers gave their worlds, station and claim names, and the patterns minor factions are called by.
//
// The generator (sim/universe.ts) passes a seeded Rng and a `used` set so that no name repeats
// anywhere in the cluster.

import type { Rng } from '../core/rng';
import type { Government, StationVisualId } from '../core/types';

/** "Halden's Rest" -> "haldens-rest": lowercase id fragment, [a-z0-9-] only. */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function unique(rng: Rng, used: Set<string>, make: () => string, fallback: (n: number) => string): string {
  for (let k = 0; k < 40; k++) {
    const name = make();
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  for (let n = 2; ; n++) {
    const name = fallback(n);
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
}

// ------------------------------------------------------------------ stars

/** Red dwarfs: ember colours and the surnames of the survey captains who logged them. */
const EMBER_STARS = [
  'Russet', 'Sorrel', 'Umber', 'Cinnabar', 'Garnet', 'Tinder', 'Brevik', 'Tolliver', 'Okoro', 'Ansgar',
  'Maren', 'Calder', 'Harrow', 'Sennet', 'Jorund', 'Kelda', 'Vayle', 'Eskil', 'Roake', 'Hollin',
  'Imre', 'Ostrander', 'Dunmere', 'Farrow', 'Mirren', 'Zennor', 'Lowell', 'Tamsin', 'Wexcombe', 'Istvan',
  'Adebayo', 'Ruddock', 'Carnelian', 'Vermeil', 'Rufous', 'Ochre',
] as const;

/** The few K, G and F stars: gold and daylight. */
const BRIGHT_STARS = ['Saffron', 'Solveig', 'Marigold', 'Citrine', 'Halcyon', 'Aubade', 'Candela', 'Whitlow'] as const;

/** Brown dwarfs: things that failed to catch. */
const DIM_STARS = ['Smoulder', 'Dimmet', 'Sullen', 'Murk', 'Snuff', 'Gutter', 'Dwindle'] as const;

export type StarNameKind = 'ember' | 'bright' | 'dim';

/** An unused star (and system) name of the given kind. */
export function pickStarName(rng: Rng, kind: StarNameKind, used: Set<string>): string {
  const pool: readonly string[] = kind === 'bright' ? BRIGHT_STARS : kind === 'dim' ? DIM_STARS : EMBER_STARS;
  return unique(
    rng,
    used,
    () => rng.pick(pool),
    (n) => `${rng.pick(pool)} ${n}`,
  );
}

// ------------------------------------------------------------------ world naming themes

export interface NameTheme {
  key: string;
  /** Completes the sentence "Its worlds are named …". */
  origin: string;
  /** The origin speaks of a survey crew, not of settlers: fits systems nobody has ever lived in. */
  surveyNamed?: boolean;
  names: readonly string[];
}

/**
 * Each procedural system names its planets and moons from one trade or tradition, the way real
 * settlers do: whoever paid for the first survey got to choose.
 */
export const NAME_THEMES: readonly NameTheme[] = [
  {
    key: 'weaving',
    surveyNamed: true,
    origin: 'from the loom, after the textile cooperative that paid for the first survey',
    names: ['Warp', 'Weft', 'Heddle', 'Shuttle', 'Selvage', 'Bobbin', 'Skein', 'Distaff', 'Treadle', 'Raddle', 'Tenter', 'Fleece'],
  },
  {
    key: 'masonry',
    origin: 'for the mason\'s craft; the first settlers were tunnellers and proud of it',
    names: ['Lintel', 'Keystone', 'Corbel', 'Plinth', 'Ashlar', 'Mullion', 'Buttress', 'Gable', 'Quoin', 'Transom', 'Cornice', 'Purlin'],
  },
  {
    key: 'farming',
    origin: 'for the working year of a farm that none of the founders had ever seen',
    names: ['Furrow', 'Fallow', 'Tilth', 'Sheaf', 'Stook', 'Gleaning', 'Windrow', 'Coulter', 'Swathe', 'Haycock', 'Headland', 'Stubble'],
  },
  {
    key: 'coast',
    surveyNamed: true,
    origin: 'for a coastline on old Earth that the survey captain\'s family still told stories about',
    names: ['Shoal', 'Eddy', 'Skerry', 'Tarn', 'Firth', 'Holm', 'Ness', 'Strand', 'Spit', 'Weir', 'Mere', 'Fen'],
  },
  {
    key: 'clockwork',
    surveyNamed: true,
    origin: 'for the parts of a clock, in the order the expedition\'s instrument-maker listed them',
    names: ['Gnomon', 'Fusee', 'Bezel', 'Arbor', 'Detent', 'Pinion', 'Ratchet', 'Vernier', 'Alidade', 'Remontoire', 'Foliot', 'Mainspring'],
  },
  {
    key: 'scribe',
    origin: 'for the parts of a book; the charter company was founded by archivists',
    names: ['Folio', 'Quire', 'Vellum', 'Colophon', 'Rubric', 'Codex', 'Palimpsest', 'Incipit', 'Gloss', 'Stylus', 'Ostracon', 'Recto'],
  },
  {
    key: 'hearth',
    surveyNamed: true,
    origin: 'for things found around a kitchen fire, a crew joke that outlived the crew',
    names: ['Kettle', 'Trivet', 'Bellows', 'Andiron', 'Skillet', 'Ladle', 'Hob', 'Crock', 'Larder', 'Griddle', 'Saltbox', 'Bannock'],
  },
  {
    key: 'music',
    surveyNamed: true,
    origin: 'in the terms of music, by a survey pilot who had wanted to be a composer',
    names: ['Cadence', 'Descant', 'Ostinato', 'Chanter', 'Hemiola', 'Coda', 'Fermata', 'Madrigal', 'Tacet', 'Rondo', 'Burden', 'Tierce'],
  },
  {
    key: 'smithing',
    origin: 'for the tools of a forge, which is what the founders meant the place to become',
    names: ['Anvil', 'Tongs', 'Quench', 'Bloom', 'Swage', 'Fuller', 'Hardy', 'Bick', 'Tuyere', 'Billet', 'Flux', 'Hammerscale'],
  },
  {
    key: 'dyes',
    origin: 'for the dyer\'s colours, which the first colonists said the star washed out of everything',
    names: ['Woad', 'Weld', 'Indigo', 'Lichen', 'Alum', 'Mordant', 'Fustic', 'Orchil', 'Kermes', 'Sumac', 'Cutch', 'Madder'],
  },
  {
    key: 'hedgerow',
    origin: 'for hedgerow plants, out of a seed catalogue the colony ship carried and never used',
    names: ['Bracken', 'Sedge', 'Teasel', 'Campion', 'Tansy', 'Vetch', 'Bryony', 'Mallow', 'Gorse', 'Comfrey', 'Burdock', 'Yarrow'],
  },
  {
    key: 'winds',
    surveyNamed: true,
    origin: 'for the great winds of Earth, by people who had only ever felt air from a duct',
    names: ['Bora', 'Mistral', 'Sirocco', 'Levanter', 'Khamsin', 'Tramontane', 'Harmattan', 'Zonda', 'Simoom', 'Etesian', 'Solano', 'Brickfielder'],
  },
  {
    key: 'hours',
    origin: 'for the hours of prayer by the congregation that settled them',
    names: ['Matins', 'Lauds', 'Prime', 'Terce', 'Sext', 'Nones', 'Vespers', 'Compline', 'Vigil', 'Angelus', 'Tenebrae', 'Litany'],
  },
  {
    key: 'cartography',
    surveyNamed: true,
    origin: 'out of a map-maker\'s vocabulary, the Survey Office\'s idea of a joke',
    names: ['Graticule', 'Isobar', 'Datum', 'Rhumb', 'Contour', 'Legend', 'Cartouche', 'Portolan', 'Benchmark', 'Azimuth', 'Meander', 'Hachure'],
  },
  {
    key: 'brewing',
    origin: 'for the brewer\'s trade; the founding charter was signed in a tavern',
    names: ['Malt', 'Wort', 'Sparge', 'Barm', 'Lees', 'Tun', 'Firkin', 'Gyle', 'Kilderkin', 'Cooper', 'Hogshead', 'Spile'],
  },
  {
    key: 'glass',
    origin: 'from the glassblower\'s bench, after the guild that built the first domes',
    names: ['Cullet', 'Marver', 'Pontil', 'Lehr', 'Frit', 'Gaffer', 'Cane', 'Batch', 'Crizzle', 'Prunt', 'Gather', 'Annealer'],
  },
  {
    key: 'mining',
    surveyNamed: true,
    origin: 'in the plain words of hard-rock miners',
    names: ['Adit', 'Stope', 'Winze', 'Gangue', 'Sump', 'Lode', 'Stull', 'Crosscut', 'Hoist', 'Collar', 'Tailing', 'Overburden'],
  },
  {
    key: 'bees',
    origin: 'for the beekeeper\'s year; the founding family kept the only hives in the Reach',
    names: ['Skep', 'Brood', 'Propolis', 'Comb', 'Nectar', 'Swarm', 'Apiary', 'Forager', 'Cluster', 'Honeyflow', 'Supersedure', 'Smoker'],
  },
  {
    key: 'knots',
    surveyNamed: true,
    origin: 'for knots and rope-work, by a rigger who could tie every one of them',
    names: ['Bowline', 'Sheepshank', 'Clove', 'Bight', 'Splice', 'Lanyard', 'Becket', 'Grommet', 'Toggle', 'Fid', 'Whipping', 'Seizing'],
  },
  {
    key: 'pottery',
    surveyNamed: true,
    origin: 'from the potter\'s shed, for no reason anyone wrote down',
    names: ['Slip', 'Glaze', 'Grog', 'Saggar', 'Bisque', 'Sgraffito', 'Celadon', 'Raku', 'Engobe', 'Greenware', 'Banding', 'Terracotta'],
  },
];

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

/** Roman numeral for a 1-based index (falls back to digits past XII). */
export function roman(n: number): string {
  return ROMAN[n - 1] ?? String(n);
}

// ------------------------------------------------------------------ people and places

/** Family names of the Reach: the founders came from everywhere. */
export const SURNAMES = [
  'Varga', 'Okonjo', 'Castellane', 'Yildirim', 'Adeyemi', 'Thornquist', 'Marchetti', 'Nakagawa', 'Brannigan', 'Halvorsen',
  'Ibarra', 'Kowalczyk', 'Lindqvist', 'Mbeki', 'Novak', 'Oyelaran', 'Petrosyan', 'Quintero', 'Rasmussen', 'Sandoval',
  'Tanaka', 'Ueda', 'Vasquez', 'Whitlock', 'Xuereb', 'Yamamoto', 'Zielinski', 'Abernathy', 'Bergstrom', 'Chaudhry',
  'Delacroix', 'Eriksen', 'Fairweather', 'Gallagher', 'Hashemi', 'Iwasaki', 'Jankowski', 'Kapoor', 'Lemaire', 'Moreau',
  'Nwosu', 'Ortega', 'Pemberton', 'Qureshi', 'Rosenthal', 'Sinclair', 'Takeda', 'Underhill', 'Vandermeer', 'Wainwright',
  'Achebe', 'Banerjee', 'Dragomir', 'Esposito', 'Farouk', 'Greaves', 'Hollis', 'Imanov', 'Jorgensen', 'Khoury',
] as const;

const PLACE_WORDS = [
  'Candlemas', 'Daybreak', 'Longshadow', 'Lowlight', 'Tidewater', 'Greywater', 'Stillwater', 'Windlass', 'Lodestar', 'Farthing',
  'Milestone', 'Latchkey', 'Lantern', 'Sundial', 'Solstice', 'Equinox', 'Perihelion', 'Aphelion', 'Syzygy', 'Penumbra',
  'Morrow', 'Tollgate', 'Threshold', 'Sojourn', 'Respite', 'Anchorage', 'Landfall', 'Leeward', 'Windward', 'Cairn',
  'Waymark', 'Kindling', 'Tinderbox', 'Flint', 'Halfway', 'Journeyman', 'Almanac', 'Plumbline', 'Counterweight', 'Keelson',
  'Saltmarsh', 'Ironwood', 'Blackthorn', 'Whetstone', 'Touchstone', 'Hourglass', 'Firstlight', 'Lastlight', 'Noontide', 'Eventide',
  'Midwatch', 'Dogwatch', 'Lamplight', 'Rushlight', 'Tallyman', 'Outrider', 'Wayfarer', 'Copperline', 'Ninepins', 'Quarterday',
] as const;

/** A name for a station of the given type orbiting `parentName`. */
export function stationName(rng: Rng, visualId: StationVisualId, parentName: string, used: Set<string>): string {
  const W = (): string => rng.pick(PLACE_WORDS);
  const S = (): string => rng.pick(SURNAMES);
  const patterns: Record<StationVisualId, (() => string)[]> = {
    ringHabitat: [() => `${W()} Ring`, () => `${parentName} Highring`, () => `${S()} Ring`, () => `${W()} Wheel`, () => `The ${W()}`],
    spindle: [() => `${W()} Spindle`, () => `${S()} Exchange`, () => `${parentName} Freeport`, () => `${W()} Wharf`, () => `${S()} Entrepot`],
    refinery: [() => `${S()} Smeltery`, () => `${W()} Works`, () => `${parentName} Reduction`, () => `${W()} Stacks`, () => `${S()} Refining`],
    outpost: [
      () => `${S()}'s Rest`,
      () => `${parentName} Lock`,
      () => `${W()} Depot`,
      () => `${parentName} Waystation`,
      () => `${W()} Relay`,
      () => `${S()} Claim`,
      () => `Camp ${W()}`,
    ],
    drydock: [() => `${S()} Yards`, () => `${W()} Slipway`, () => `${parentName} Graving Dock`, () => `${S()} Shipwrights`],
    citadel: [() => `Fort ${S()}`, () => `${W()} Bastion`, () => `${W()} Redoubt`, () => `${parentName} Bulwark`, () => `${S()} Barbican`],
  };
  return unique(
    rng,
    used,
    () => rng.pick(patterns[visualId])(),
    (n) => `${parentName} Station ${n}`,
  );
}

/** Words for ring ice, borrowed from the sea-ice vocabulary of Earth. */
const RING_WORDS = ['Frazil', 'Nilas', 'Graupel', 'Firn', 'Sastrugi', 'Verglas', 'Brash', 'Growler', 'Spindrift', 'Hoarfrost', 'Sleet', 'Glitter'] as const;
/** Words for loose rock. */
const BELT_WORDS = ['Talus', 'Scree', 'Moraine', 'Cobble', 'Breccia', 'Erratic', 'Clast', 'Scoria', 'Tephra', 'Gravel', 'Shingle', 'Boulder'] as const;

/**
 * A name for a mining site in a ring or a rubble belt around `parentName`. `unworked` sites (in
 * systems nobody has settled) get surveyors' names only: no claims, cuts or workings.
 */
export function siteName(rng: Rng, kind: 'ring' | 'belt', parentName: string, used: Set<string>, unworked = false): string {
  const S = (): string => rng.pick(SURNAMES);
  const patterns =
    kind === 'ring'
      ? [
          () => `The ${rng.pick(RING_WORDS)} Shoals`,
          () => `${rng.pick(RING_WORDS)} Drift`,
          unworked ? () => `The ${rng.pick(RING_WORDS)} Reach` : () => `${S()}'s Cut`,
          unworked ? () => `${parentName} ${rng.pick(['A', 'B', 'C', 'D'])}-Ring Shoals` : () => `${parentName} ${rng.pick(['A', 'B', 'C', 'D'])}-Ring Workings`,
        ]
      : [
          () => `The ${rng.pick(BELT_WORDS)} Scatter`,
          unworked ? () => `The ${rng.pick(BELT_WORDS)} Drift` : () => `${S()}'s Claim`,
          () => `${rng.pick(BELT_WORDS)} Field`,
          () => `The ${rng.pick(BELT_WORDS)} Tumble`,
        ];
  return unique(
    rng,
    used,
    () => rng.pick(patterns)(),
    (n) => `${parentName} ${kind === 'ring' ? 'Ring' : 'Belt'} Claim ${n}`,
  );
}

// ------------------------------------------------------------------ factions

const CREEDS = [
  'Long Noon', 'Unsetting Sun', 'Still Horizon', 'Last Dusk', 'Patient Dark', 'Returning Light', 'Narrow Dawn', 'Kindled Lamp',
  'Turning Shadow', 'First Ember',
] as const;

const COLLECTIVE_WORDS = ['Lamplighters', 'Icewrights', 'Longhaul', 'Nightshift', 'Deepwell', 'Pipefitters', 'Dusk Orchard', 'Brinecutters', 'Slow Burn', 'Tidewardens'] as const;

const CLAN_WORDS = [
  'Ashmaw', 'Cinderjack', 'Emberjaw', 'Sootwing', 'Blackdamp', 'Firedamp', 'Slagtooth', 'Coalhand', 'Burnscar', 'Flashpoint',
  'Backdraft', 'Smokestack',
] as const;

/**
 * A name for a minor faction of the given government founded in `systemName`. Criminal factions
 * are Scorch clans and take their names from fire and what it leaves behind.
 */
export function factionName(rng: Rng, government: Government, criminal: boolean, systemName: string, used: Set<string>): string {
  const S = (): string => rng.pick(SURNAMES);
  const sys = systemName;
  if (criminal) {
    const C = (): string => rng.pick(CLAN_WORDS);
    return unique(
      rng,
      used,
      () => rng.pick([() => `Clan ${C()}`, () => `The ${C()} Kin`, () => `${C()} Scorch`])(),
      (n) => `Scorch Clan ${n}`,
    );
  }
  const patterns: Record<Government, (() => string)[]> = {
    democracy: [
      () => `${sys} Commons`,
      () => `Free Electors of ${sys}`,
      () => `${sys} Civic Front`,
      () => `Commonwealth of ${sys}`,
      () => `${sys} Townships`,
      () => `${sys} Franchise Party`,
    ],
    corporate: [
      () => `${S()}-${S()} Combine`,
      () => `${sys} Holdings`,
      () => `${S()} Bonded Freight`,
      () => `${S()} Orbital Works`,
      () => `${sys} Chartered Company`,
      () => `${S()} & Daughters`,
      () => `${rng.pick(PLACE_WORDS)} Mutual Assurance`,
    ],
    cooperative: [
      () => `${sys} Workers' Cooperative`,
      () => `${sys} Ice Crews' Mutual`,
      () => `The ${rng.pick(COLLECTIVE_WORDS)} Collective`,
      () => `${sys} Common Stores`,
      () => `Nightside Graziers of ${sys}`,
      () => `${rng.pick(COLLECTIVE_WORDS)} Cooperative of ${sys}`,
    ],
    technocracy: [
      () => `${sys} Institute`,
      () => `${sys} Bureau of Works`,
      () => `${sys} Syndics`,
      () => `The ${S()} Directorate`,
      () => `${sys} Board of Engineers`,
      () => `Actuaries of ${sys}`,
    ],
    patronage: [
      () => `House ${S()}`,
      () => `House ${S()} of ${sys}`,
      () => `The ${S()} Retinue`,
      () => `${S()} Appanage`,
      () => `Foundry House ${S()}`,
    ],
    dictatorship: [
      () => `${sys} Protectorate`,
      () => `The ${S()} Stewardship`,
      () => `Marshalate of ${sys}`,
      () => `${sys} Emergency Council`,
      () => `${S()}'s Garrison`,
    ],
    theocracy: [
      () => `Congregation of the ${rng.pick(CREEDS)}`,
      () => `Vigil of the ${rng.pick(CREEDS)}`,
      () => `Order of the ${rng.pick(CREEDS)}`,
      () => `Lampkeepers of ${sys}`,
      () => `${sys} Tabernacle`,
    ],
    confederacy: [
      () => `${sys} Free Ports`,
      () => `The ${sys} Compact`,
      () => `Confederated Holds of ${sys}`,
      () => `${sys} Moot`,
      () => `Allied Docks of ${sys}`,
    ],
    anarchy: [() => `${sys} Unbound`, () => `Free Hulls of ${sys}`, () => `The Unlisted of ${sys}`],
  };
  return unique(
    rng,
    used,
    () => rng.pick(patterns[government])(),
    (n) => `${sys} ${government === 'corporate' ? 'Holdings' : 'Council'} ${n}`,
  );
}
