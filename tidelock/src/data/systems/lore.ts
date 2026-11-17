// Survey-office prose for procedurally generated stars, worlds, stations, systems and factions.
// Each description is one physical sentence plus one human sentence, drawn from shuffled decks so a
// line is not reused until every alternative has been dealt. Hand-authored showpieces write their own.

import type { Rng } from '../../core/rng';
import type { BodyClass, EconomyType, Government, PowerId, StationVisualId } from '../../core/types';

export interface LoreDecks {
  /** Deal the next index from a shuffled deck of `size` cards identified by `key`. */
  draw(key: string, size: number): number;
}

/** Shuffled, reshuffling decks keyed by name; deterministic in `rng`. */
export function makeLoreDecks(rng: Rng): LoreDecks {
  const decks = new Map<string, number[]>();
  return {
    draw(key, size) {
      let deck = decks.get(key);
      if (!deck || deck.length === 0) {
        deck = rng.fork(`deck:${key}:${decks.has(key) ? 'again' : 'first'}`).shuffle(Array.from({ length: size }, (_, i) => i));
        decks.set(key, deck);
      }
      return deck.pop() as number;
    },
  };
}

const deal = <T>(decks: LoreDecks, key: string, options: readonly T[]): T => options[decks.draw(key, options.length)];

/** "17 hours", "4.3 days", "2.6 years": an orbital or rotation period in words. */
export function periodWords(seconds: number): string {
  const h = seconds / 3600;
  if (h < 1.5) return `${Math.round(seconds / 60)} minutes`;
  if (h < 48) return `${Math.round(h)} hours`;
  const d = h / 24;
  if (d < 20) return `${d.toFixed(1).replace(/\.0$/, '')} days`;
  if (d < 600) return `${Math.round(d)} days`;
  return `${(d / 365.25).toFixed(1)} years`;
}

// ------------------------------------------------------------------ stars

export interface StarLoreCtx {
  name: string;
  kind: 'main' | 'whiteDwarf' | 'brownDwarf';
  spectralClass: string;
  /** Solar masses. */
  mass: number;
  temperature: number;
  activity: number;
}

export function starLore(decks: LoreDecks, c: StarLoreCtx): string {
  const frac = c.mass < 0.995 ? `${Math.round(c.mass * 100)} % of a solar mass` : `${c.mass.toFixed(2)} solar masses`;
  if (c.kind === 'brownDwarf') {
    return deal(decks, 'star:bd', [
      `${c.name} never lit. It is a ${c.spectralClass} brown dwarf, ${frac}, glowing a dull magenta at ${c.temperature} K from the heat of its own slow collapse.`,
      `A ${c.spectralClass} brown dwarf of ${frac}: too small to fuse hydrogen, too big to be called a planet. At ${c.temperature} K ${c.name} shows as a dim coal against the stars.`,
    ]);
  }
  if (c.kind === 'whiteDwarf') {
    return `${c.name} is the Earth-sized cinder of a dead sun, ${frac} at ${c.temperature} K, with nothing left to burn.`;
  }
  const letter = c.spectralClass[0];
  if (letter === 'M') {
    const flares =
      c.activity > 0.65
        ? 'It flares hard and often; every station here keeps its storm shelters stocked.'
        : c.activity > 0.45
          ? 'A few times a year it throws an X-ray flare that sends every crew to shelter.'
          : 'It is old and quiet for its kind, and flares only rarely.';
    return deal(decks, 'star:m', [
      `${c.name} is a ${c.spectralClass} red dwarf of ${frac}, burning slowly enough to outlast every bright star in the sky. ${flares}`,
      `A small ${c.spectralClass} ember at ${c.temperature} K, ${c.name} gives a steady orange-red light. ${flares}`,
      `${c.name} is a ${c.spectralClass} dwarf, ${frac}, its light the colour of a banked fire. ${flares}`,
      `Like most stars of the Reach, ${c.name} is a red dwarf: class ${c.spectralClass}, ${c.temperature} K, ${frac}. ${flares}`,
    ]);
  }
  const hue = letter === 'K' ? 'amber' : letter === 'G' ? 'yellow-white' : 'white';
  return deal(decks, 'star:bright', [
    `${c.name} is a ${c.spectralClass} star of ${frac}: ${hue}, steady, and dazzling by the standards of the Reach.`,
    `Pilots raised under red dwarfs squint at ${c.name}, a ${hue} ${c.spectralClass} star of ${frac} whose worlds turn and have real days.`,
    `A ${hue} ${c.spectralClass} sun at ${c.temperature} K, ${c.name} is one of the few stars in the Reach bright enough to cast a hard shadow.`,
  ]);
}

// ------------------------------------------------------------------ worlds

export interface BodyLoreCtx {
  name: string;
  cls: BodyClass;
  isMoon: boolean;
  parentName: string;
  starName: string;
  /** Orbital period, s. */
  period: number;
  /** Rotation period, s. */
  day: number;
  /** Mean surface (or 1-bar) temperature, K. */
  temperature: number;
  /** Sub-stellar equilibrium temperature, K. */
  noonTemperature: number;
  ringed: boolean;
  /** Ring tilt, degrees. */
  tiltDeg: number;
  hasAir: boolean;
  /** System has stations. */
  settled: boolean;
  /** Mass in Earth masses. */
  massEarth: number;
}

type Line = (c: BodyLoreCtx) => string;

interface ClassLore {
  planet: Line[];
  moon?: Line[];
  settled: Line[];
  wild: Line[];
}

const LORE: Record<Exclude<BodyClass, 'star'>, ClassLore> = {
  lava: {
    planet: [
      (c) => `${c.name} swings around ${c.starName} every ${periodWords(c.period)}, close enough that rock at its noon point stays molten at ${c.noonTemperature} K.`,
      (c) => `Tide-locked and scoured bare, ${c.name} keeps a magma sea under the noon point and a crust of black glass everywhere else.`,
      (c) => `${c.name} orbits so close to ${c.starName} that one hemisphere glows a dull orange, visible from the next world out.`,
      (c) => `Tides from ${c.starName} knead ${c.name} every ${periodWords(c.period)}; the heat escapes through fissures that cross the planet like stitching.`,
    ],
    moon: [
      (c) => `Squeezed by ${c.parentName}'s tides every ${periodWords(c.period)}, ${c.name} is the most volcanic body in the system: sulphur plains, lava lakes, no craters older than a century.`,
      (c) => `${c.name} is a yellow-and-black moon that turns itself inside out, its volcanoes fed by the pull of ${c.parentName}.`,
    ],
    settled: [
      () => 'Smelter crews call the silicate dust that rains out past the terminator "ashfall" and time their landings around it.',
      () => 'Prospectors skim metal condensates from the cooler ground, a trade with good margins and short careers.',
      () => 'Nobody lives here. A few automated furnaces run until the next flare takes them.',
      () => 'Its glow is the first thing new pilots learn to navigate by.',
    ],
    wild: [
      () => 'No ship has landed; the survey notes say only that the night side might be workable.',
      () => 'Its spectrum shows sodium and iron vapour, which is all anyone has needed to know so far.',
      () => 'The one probe sent down lasted eleven minutes, which the Survey Office recorded as a success.',
    ],
  },
  barren: {
    planet: [
      (c) => `An airless ball of cratered regolith, ${c.name} has changed little since the system's bombardment ended.`,
      (c) => `${c.name} is bare rock under a black sky, ${c.temperature} K at the surface and silent.`,
      (c) => `Grey plains and overlapping craters: ${c.name} lost what air it had to the flares of ${c.starName} long ago.`,
      (c) => `${c.name} is a dense, dark world with a surface of shattered basalt and no atmosphere to soften its shadows.`,
      (c) => `Stripped to the mantle by some old collision, ${c.name} is heavier than it looks and scarred from pole to pole.`,
      (c) => `${c.name} goes around ${c.starName} every ${periodWords(c.period)}, a cinder of iron and silicate baked dry.`,
    ],
    moon: [
      (c) => `A cratered moon of ${c.parentName}, ${c.name} keeps one battered face turned to its planet.`,
      (c) => `${c.name} is a captured lump of rock on a ${periodWords(c.period)} orbit around ${c.parentName}, pocked and dust-grey.`,
      (c) => `Tides from ${c.parentName} stopped ${c.name}'s spin long ago; its far side has never seen the planet at all.`,
      (c) => `${c.name} is small, dark and irregular, more a mountain in orbit than a world.`,
      (c) => `Dust the colour of slate covers ${c.name} to a depth nobody has measured.`,
    ],
    settled: [
      () => 'Its shadowed craters hold a little ice, enough to interest claim-jumpers and nobody else.',
      () => 'Navigation crews calibrate against its limb, which is the most attention it gets.',
      () => 'There are old drill camps on the surface, abandoned when the ore ran thin.',
      () => 'Regolith barges call now and then to load shielding gravel.',
      () => 'A line of dead transponders marks where someone once thought of building.',
      () => 'Apprentice pilots practise their first landings here, where there is nothing to hit.',
    ],
    wild: [
      () => 'Nobody has bothered to land.',
      () => 'It has a catalogue number, a name, and no footprints.',
      () => 'A full survey would be the first close look anyone has taken.',
      () => 'Whatever is in its crust is still there.',
      () => 'The first expedition logged it in a single line.',
    ],
  },
  rocky: {
    planet: [
      (c) => `${c.name} is a cold desert of rust-coloured rock under a thin carbon-dioxide sky.`,
      (c) => `Canyons deep enough to hold their own weather cut across ${c.name}; dust storms can hide the surface for weeks.`,
      (c) => `Thin dry air and ${c.temperature} K at the surface: ${c.name} is almost a place people could live, which is the cruel part.`,
      (c) => `${c.name} has frost at the poles, dry riverbeds at the equator and air too thin to carry a sound.`,
      (c) => `Old shield volcanoes stand above the dust on ${c.name}, tall enough to reach out of most of its atmosphere.`,
    ],
    moon: [
      (c) => `${c.name} is large for a moon and holds a trace of air, enough for haze at the limb and frost in the morning.`,
      (c) => `A rust-red moon of ${c.parentName} with a wisp of atmosphere, ${c.name} was a planet in its own right before it was captured.`,
    ],
    settled: [
      () => 'Pressure-dome homesteads dot the lowlands, growing lichen-crop under glass.',
      () => 'Its canyon settlements trade in salvage and stubbornness.',
      () => 'Aerobraking pilots like it: the air is thin enough to forgive a steep pass.',
      () => 'Water is mined from buried glaciers and argued over at every council.',
      () => 'The old charter towns here have never paid a tax they did not first dispute.',
    ],
    wild: [
      () => 'The dry valleys suggest it was wetter once; nobody has been down to check.',
      () => 'Survey drones report subsurface ice and nothing moving.',
      () => 'It would make a tolerable colony if anyone had a reason to come.',
      () => 'Its thin air is good for one thing, shedding speed, and there is no one here to use it.',
    ],
  },
  desert: {
    planet: [
      (c) => `${c.name} is hot, dry and bright: dune seas the size of continents and salt flats where oceans used to be.`,
      (c) => `A haze of dust keeps the sky of ${c.name} the colour of brass and its surface near ${c.temperature} K.`,
      (c) => `Wind is the only thing that moves on ${c.name}; it has carved the highlands into ridges a kilometre tall.`,
      (c) => `${c.name} kept its atmosphere and lost its water, leaving evaporite basins that glare white from orbit.`,
      (c) => `${c.name} is a furnace with weather: thick dry air, ${c.temperature} K at noon, storms that sandblast anything left outside.`,
    ],
    settled: [
      () => 'Deep wells and mirrored roofs keep its towns alive; the salt goes offworld by the kilotonne.',
      () => 'Its people live in the canyons and come out at dusk.',
      () => 'The flats are mined for lithium and soda, and for fossils nobody can agree on.',
      () => 'Its dense air makes it the best aerobraking target in the system, and the busiest.',
    ],
    wild: [
      () => 'There is air to brake against and nothing at all to land for.',
      () => 'A probe found brine under the salt, and there the matter rests.',
      () => 'Dust devils cross it in columns ten kilometres high, watched by no one.',
    ],
  },
  ice: {
    planet: [
      (c) => `${c.name} is a shell of water ice over rock, fractured by tides and smooth between the cracks.`,
      (c) => `Far from ${c.starName}, ${c.name} is frozen through: nitrogen frost on water-ice bedrock at ${c.temperature} K.`,
      (c) => `Long reddish stains mark where brine has welled up through the crust of ${c.name} and frozen.`,
      (c) => `${c.name} is white, quiet and very cold, its few craters softened by ice that flows like slow water.`,
      (c) => `Under the ice of ${c.name} there is an ocean, kept liquid by the slow flexing of its ${periodWords(c.period)} orbit.`,
      (c) => `${c.name} takes ${periodWords(c.period)} to circle ${c.starName}, which from here is only the brightest star in a dark sky.`,
    ],
    moon: [
      (c) => `${c.name} is an ice moon of ${c.parentName}, its surface a web of ridges where the crust has cracked and healed.`,
      (c) => `Tidal flexing keeps a sea of brine under the shell of ${c.name}; plumes at its south pole feed a faint halo of frost.`,
      (c) => `A small bright moon, ${c.name} is mostly ice around a core of rock no bigger than an asteroid.`,
      (c) => `${c.name} circles ${c.parentName} every ${periodWords(c.period)}, frozen hard and scarred with chains of secondary craters.`,
      (c) => `Half of ${c.name} is clean ice and half is stained dark with dust swept up from the orbit of ${c.parentName}.`,
      (c) => `${c.name} is ${c.temperature} K at the equator and smoother than a billiard ball, resurfaced by its own slow ice.`,
    ],
    settled: [
      () => 'Ice crews cut it by the block; every glass of water in the system has probably been here.',
      () => 'Melt stations on the surface sell reaction mass to anyone who can make the descent.',
      () => 'Its drill towns are warm, crowded and loyal to their own.',
      () => 'The brine has turned up nothing alive, to the regret of several institutes.',
      () => 'Smugglers favour its far side, where the bulk of the moon blocks every prying antenna.',
      () => 'Claim markers ring its poles, most of them lapsed.',
    ],
    wild: [
      () => 'Nobody has drilled it yet.',
      () => 'It would keep a fleet in reaction mass if anyone came to cut it.',
      () => 'The survey flagged possible subsurface water and moved on.',
      () => 'It has been named, measured from a distance, and left alone.',
      () => 'There is a fortune in clean ice here for whoever builds the first depot.',
    ],
  },
  ocean: {
    planet: [
      (c) => `${c.name} is water from pole to pole, a single ocean broken by a few volcanic island chains.`,
      (c) => `Storm bands circle ${c.name} endlessly over an ocean a hundred kilometres deep.`,
      (c) => `From orbit ${c.name} is dark blue and white, with no land larger than a city.`,
    ],
    settled: [
      () => 'Its people live on raft-towns and anchored platforms, farming kelp and brine shrimp.',
      () => 'The archipelagos are the most expensive addresses for ten light-years.',
      () => 'Fresh food goes up; everything else comes down.',
    ],
    wild: [
      () => 'It is the kind of world charters are written for, and nobody has filed one.',
      () => 'No landing has been made; there is nowhere to land.',
    ],
  },
  terran: {
    planet: [
      (c) => `${c.name} has open oceans, weathered continents and a sky a person can stand under.`,
      (c) => `A temperate world with real seasons, ${c.name} turns once every ${periodWords(c.day)}.`,
      (c) => `Cloud, sea and green-brown land: ${c.name} is one of the few worlds in the Reach that needs no dome.`,
    ],
    settled: [
      () => 'Land here is inherited, never sold, and the queue for residency runs to decades.',
      () => 'Its farms feed half the neighbouring systems.',
      () => 'Every child in the Reach has seen pictures of its coasts.',
    ],
    wild: [
      () => 'That it is still unclaimed says more about the distance than the world.',
      () => 'It has its own life, low and green, and no visitors.',
    ],
  },
  eyeball: {
    planet: [
      (c) => `${c.name} keeps one face to ${c.starName}: a baked noon desert, a frozen night, and between them a ring of twilight where water runs.`,
      (c) => `Tide-locked ${c.name} has a storm that never leaves the noon point and glaciers that never leave the dark; people live on the line between.`,
      (c) => `On ${c.name} the sun hangs in one place for ever. The terminator belt, a few hundred kilometres wide, is the only temperate land.`,
      (c) => `The day side of ${c.name} is salt pan and its night side an ice cap kilometres thick; meltwater rivers cross the twilight and vanish at the edge of noon.`,
      (c) => `${c.name} circles ${c.starName} every ${periodWords(c.period)} without ever turning its back. Winds from the night side keep the twilight cool and wet.`,
    ],
    settled: [
      () => 'Its cities follow the terminator in a broken chain, each built in the long shadow of the next ridge.',
      () => 'Dark-leaved crops grow in the permanent dusk, four harvests a year.',
      () => 'Children here learn sunward and nightward before they learn left and right.',
      () => 'The night ice is mined, the noon salt is mined, and the twilight between is farmed to the last terrace.',
      () => 'Every town keeps a flare bell, and everyone knows the way to the cellars.',
    ],
    wild: [
      () => 'The twilight belt is empty. It will not stay empty once someone files the survey.',
      () => 'Nothing lives on it but dark mats along the meltwater, and no one has come to look closer.',
    ],
  },
  gasGiant: {
    planet: [
      (c) => `${c.name} is a banded hydrogen giant of ${Math.round(c.massEarth)} Earth masses, with storms older than any colony in the system.`,
      (c) => `Cream and ochre cloud belts wrap ${c.name}; lightning on its night side can be seen from its moons.`,
      (c) => `The upper air of ${c.name} is cold hydrogen and ammonia ice moving at four hundred metres a second.`,
      (c) => `${c.name} takes ${periodWords(c.period)} to round ${c.starName} and turns once every ${periodWords(c.day)}, flattened visibly at the poles.`,
    ],
    settled: [
      () => 'Scoop ships work its cloud tops for hydrogen, a legal trade with an alarming accident rate.',
      () => 'Its moons are the reason anyone is here.',
      () => 'Traffic control keeps a standing warning about its radiation belts.',
      () => 'Freighters fall past it to steal a little speed on the way out.',
    ],
    wild: [() => 'It would refuel a fleet. None has come.', () => 'A scoop pass here is free for the taking, and a long way from help.'],
  },
  iceGiant: {
    planet: [
      (c) => `${c.name} is a pale ice giant, calm at the cloud tops and violent underneath.`,
      (c) => `Methane gives ${c.name} its colour; its winds are the fastest measured in the system.`,
      (c) => `A cold world of water, ammonia and methane under a hydrogen sky, ${c.name} gives off almost no heat of its own.`,
      (c) => `${c.name} is ${Math.round(c.massEarth)} Earth masses of slush and gas, ${c.temperature} K at the one-bar level.`,
    ],
    settled: [
      () => 'Skimmer crews call its upper air "the easy stuff": slow winds, clean hydrogen, a long way down.',
      () => 'Freighters use it as a slingshot and a filling station.',
      () => 'Its small moons are staked by three different claims offices.',
    ],
    wild: [() => 'It has never been scooped.', () => 'Its small moons have not been counted properly.'],
  },
};

const RING_LINES: Line[] = [
  (c) => `Its rings are bright water ice, tilted ${Math.round(c.tiltDeg)} degrees so that ${c.starName} lights them from edge to edge.`,
  (c) => `A ring system tilted ${Math.round(c.tiltDeg)} degrees to its orbit throws a curved shadow across the cloud tops.`,
  () => 'Its rings are young, the wreck of a moon that strayed inside the Roche limit, and they are thick with clean ice.',
];

/** One or two sentences of survey prose for a generated planet or moon. */
export function bodyLore(decks: LoreDecks, c: BodyLoreCtx): string {
  const lore = LORE[c.cls as Exclude<BodyClass, 'star'>];
  const first = c.isMoon && lore.moon ? deal(decks, `${c.cls}:moon`, lore.moon) : deal(decks, `${c.cls}:planet`, lore.planet);
  let second: Line;
  if (c.ringed) second = deal(decks, 'rings', RING_LINES);
  else second = c.settled ? deal(decks, `${c.cls}:settled`, lore.settled) : deal(decks, `${c.cls}:wild`, lore.wild);
  return `${first(c)} ${second(c)}`;
}

// ------------------------------------------------------------------ stations

export interface StationLoreCtx {
  name: string;
  visualId: StationVisualId;
  bodyName: string;
  economy: EconomyType;
  capital: boolean;
}

type StationLine = (c: StationLoreCtx) => string;

const STATION_SHAPE: Record<StationVisualId, StationLine[]> = {
  ringHabitat: [
    (c) => `${c.name} is a spoked habitat ring nine hundred metres across, turning twice a minute above ${c.bodyName}.`,
    (c) => `The ring of ${c.name} holds parks, courts and a great deal of paperwork, with ${c.bodyName} wheeling past every window.`,
    (c) => `From the promenade of ${c.name}, ${c.bodyName} fills half the sky.`,
    (c) => `${c.name} was spun up three generations ago and has been adding spokes ever since.`,
  ],
  spindle: [
    (c) => `${c.name} is a trade spindle: stacked docking bays around a core of warehouses and counting-rooms.`,
    (c) => `Freight moves through ${c.name} around the clock, drum to drum and ship to ship.`,
    (c) => `The counter-rotating drums of ${c.name} have been docking freighters over ${c.bodyName} for generations.`,
    (c) => `${c.name} is six hundred metres of bays, bond stores and brokers' offices in orbit of ${c.bodyName}.`,
  ],
  refinery: [
    (c) => `${c.name} is seven hundred metres of tanks, smelter stacks and radiators glowing dull red.`,
    (c) => `Ore goes into ${c.name} as rubble and leaves as ingots and slag.`,
    (c) => `The furnaces of ${c.name} have not been cold in living memory.`,
    (c) => `${c.name} hangs over ${c.bodyName} in a haze of its own outgassing, lit from within.`,
  ],
  outpost: [
    (c) => `${c.name} is a cluster of pressure cans on a truss, with two pads and one bar.`,
    (c) => `A frontier outpost of bolted modules and solar wings, ${c.name} keeps station over ${c.bodyName}.`,
    (c) => `${c.name} has a fuel depot, a small crew and a view of ${c.bodyName} that nobody tires of.`,
    (c) => `Everything on ${c.name} has been repaired at least twice.`,
    (c) => `${c.name} began as a survey camp over ${c.bodyName} and never quite got round to closing.`,
    (c) => `Two pads, a fuel farm and a row of second-hand habitat cans: ${c.name} is exactly as big as it needs to be.`,
  ],
  drydock: [
    (c) => `${c.name} is an open-frame yard a kilometre long, with a hull always on the slip.`,
    (c) => `Welding arcs flicker along the gantries of ${c.name} day and night.`,
    (c) => `Half the ships registered in this system first flew from ${c.name}.`,
  ],
  citadel: [
    (c) => `${c.name} is an armoured bastion, its magazines buried under metres of slag-brick.`,
    (c) => `Patrol wings fly from ${c.name}, and its guns cover every approach to ${c.bodyName}.`,
    (c) => `${c.name} was built to be seen: eight hundred metres of plate and battery over ${c.bodyName}.`,
  ],
};

const STATION_TRADE: Record<EconomyType, StationLine[]> = {
  agriculture: [
    () => 'It ships grain and fresh produce from the farms below.',
    () => 'Its hold-masters set the grain price for three systems.',
    () => 'Seed stock, fertiliser and farm machinery go down; harvests come up.',
  ],
  extraction: [
    () => 'Miners sell raw ore here and buy what they need to go back out.',
    () => 'Its assay office is the busiest room aboard.',
    () => 'Claim crews rotate through on six-week shifts and spend their pay before they leave.',
  ],
  refinery: [
    () => 'It buys ore from anyone and sells metal to everyone.',
    () => 'Slag from its furnaces becomes the shielding brick of half the system.',
    () => 'Its price board for ore is the first thing every miner checks.',
  ],
  industrial: [
    () => 'Its workshops turn plate and bar into machine parts and hull sections.',
    () => 'The fabrication decks run three shifts and are always short of metal.',
    () => 'What the system builds, it builds here.',
  ],
  hightech: [
    () => 'Its clean-rooms grow processors, and its institutes pay well for survey data.',
    () => 'Laboratories and instrument makers fill the low-gravity decks.',
    () => 'It imports rare metals by the case and exports them as sensors by the gram.',
  ],
  service: [
    () => 'Banks, brokers and shipping agents fill its inner decks.',
    () => 'Captains come for contracts and stay for the food.',
    () => 'Most of what happens in this system is signed for here.',
  ],
  military: [
    () => 'Garrison contracts keep its market in arms, armour plate and medical stores.',
    () => 'Its quartermasters buy in bulk and ask for delivery yesterday.',
    () => 'Off-duty crews make it a good place to hear where the next trouble will be.',
  ],
  colony: [
    () => 'It is young, short of everything, and pays well for basics.',
    () => 'Half its people arrived within the decade.',
    () => 'Its market wants food, machines and medicine, in that order.',
  ],
  tourism: [
    () => 'Liners bring visitors for the view and for the open sky below.',
    () => 'Its hotels sell the one thing the rest of the Reach cannot make: a horizon.',
    () => 'Luxuries sell here at prices that would start a riot anywhere else.',
  ],
  shipyard: [
    () => 'Hulls are laid down here and fitted out alongside.',
    () => 'It takes in plate, drives and avionics and turns out ships.',
    () => 'Order books are full two years ahead.',
  ],
};

/** Two sentences for a generated station: what it looks like, what it trades. */
export function stationLore(decks: LoreDecks, c: StationLoreCtx): string {
  const shape = deal(decks, `st:${c.visualId}`, STATION_SHAPE[c.visualId]);
  const trade = deal(decks, `trade:${c.economy}`, STATION_TRADE[c.economy]);
  const seat = c.capital ? ' The system is governed from here.' : '';
  return `${shape(c)} ${trade(c)}${seat}`;
}

// ------------------------------------------------------------------ systems

export interface SystemLoreCtx {
  name: string;
  /** Role sentence from the galaxy layout, with {name} already substituted. */
  role: string;
  spectralClass: string;
  planets: number;
  /** Clause completing "Its worlds are named …". */
  themeOrigin: string;
  inhabited: boolean;
  population: number;
  /** A notable feature sentence (rings, habitable world…), if any. */
  feature: string;
}

/** Description of a generated system: role in the cluster, a notable sight, where its names come from. */
export function systemLore(c: SystemLoreCtx): string {
  const names = c.planets >= 2 ? ` Its ${c.planets} worlds are named ${c.themeOrigin}.` : '';
  return `${c.role}${c.feature ? ` ${c.feature}` : ''}${names}`;
}

// ------------------------------------------------------------------ factions

export interface FactionLoreCtx {
  name: string;
  government: Government;
  powerId: PowerId | null;
  systemName: string;
  criminal: boolean;
}

type FactionLine = (c: FactionLoreCtx) => string;

const POWER_NAME: Record<PowerId, string> = {
  assembly: 'the Meridian Assembly',
  hegemony: 'the Auric Hegemony',
  league: 'the Umbral League',
};

const FACTION_LORE: Record<Government, FactionLine[]> = {
  democracy: [
    (c) => `${c.name} holds elections every two years and committee meetings every day. Its delegates are tireless, honest and slow.`,
    (c) => `An elected council of the ${c.systemName} settlements. ${c.name} funds schools and patrols by public vote and publishes every ledger.`,
    (c) => `${c.name} grew out of a dockworkers' strike and has never lost the habit of putting things to a show of hands.`,
  ],
  corporate: [
    (c) => `${c.name} runs its territory as a balance sheet: clean docks, prompt payment and no patience for anything that is not in the contract.`,
    (c) => `A chartered company with offices in ${c.systemName}. ${c.name} answers to its shareholders first and its tenants a distant second.`,
    (c) => `${c.name} began as a freight insurer and now owns most of what it once insured.`,
  ],
  cooperative: [
    (c) => `Every member of ${c.name} holds one share and one vote, and the meetings run long. Outsiders are welcome to trade and not to stay.`,
    (c) => `${c.name} pools the ships, tools and debts of the ${c.systemName} crews. It pays slowly and never cheats.`,
    (c) => `Founded by ice cutters who were tired of company stores, ${c.name} still elects its foremen by the shift.`,
  ],
  technocracy: [
    (c) => `${c.name} appoints by examination and governs by model. Its forecasts are usually right, which makes it few friends.`,
    (c) => `Engineers and actuaries administer ${c.systemName} on behalf of ${c.name}; every decision comes with an appendix.`,
    (c) => `${c.name} keeps the life-support of a dozen habitats running and considers that mandate enough.`,
  ],
  patronage: [
    (c) => `${c.name} houses, feeds and employs its retainers for life and expects the same span of loyalty in return.`,
    (c) => `A foundry dynasty with interests in ${c.systemName}. ${c.name} settles disputes at the family table and pays its debts in metal.`,
    (c) => `The lamps of ${c.name} have burned over the same smelter for six generations, and the house intends six more.`,
  ],
  dictatorship: [
    (c) => `${c.name} took charge of ${c.systemName} during an emergency that has yet to be declared over.`,
    (c) => `Order under ${c.name} is real and so is the curfew. Its ports are safe, searched and quiet.`,
    (c) => `${c.name} is one officer's command grown into a government; the trains of ore run on time.`,
  ],
  theocracy: [
    (c) => `${c.name} teaches that the unmoving sun is a covenant. Its hospices take in anyone; its courts are less forgiving.`,
    (c) => `The faithful of ${c.name} keep the hours by the light on the terminator and tithe a tenth of every cargo.`,
    (c) => `${c.name} ran the first flare shelters in ${c.systemName} and has held the people's gratitude, and their obedience, ever since.`,
  ],
  confederacy: [
    (c) => `${c.name} is a pact of port captains who agree on tariffs, salvage law and nothing else.`,
    (c) => `Each dock in ${c.name} keeps its own rules and its own militia, and sends one voice to the moot.`,
    (c) => `${c.name} exists to keep bigger powers out of ${c.systemName}, and has managed it so far by being more trouble than it is worth.`,
  ],
  anarchy: [
    (c) => `${c.name} is less a government than an agreement not to have one. Disputes are settled by reputation and, failing that, by leaving.`,
    (c) => `Nobody speaks for ${c.name}, which is the point. Its docks ask no questions and keep no records.`,
  ],
};

const CLAN_LORE: FactionLine[] = [
  (c) => `${c.name} is a Scorch clan: raiders, toll-takers and fences working out of ${c.systemName}. They honour their own word and nobody else's law.`,
  (c) => `A Scorch clan with a long memory. ${c.name} takes a cut of every cargo that moves through ${c.systemName} without an escort.`,
  (c) => `${c.name} started as a wildcat crew that lost its claim in court and decided courts were the problem.`,
];

/** Two sentences on a generated faction: how it rules, and whose banner it flies. */
export function factionLore(decks: LoreDecks, c: FactionLoreCtx): string {
  if (c.criminal) return deal(decks, 'faction:clan', CLAN_LORE)(c);
  const base = deal(decks, `faction:${c.government}`, FACTION_LORE[c.government])(c);
  const tail = c.powerId ? ` It stands with ${POWER_NAME[c.powerId]}.` : ' It answers to none of the great powers.';
  return base + tail;
}
