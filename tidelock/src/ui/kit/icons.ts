// TIDELOCK icon set — thin-line inline SVG on a 24 px grid (stroke 1.5, round caps and joins), plus the
// game mark, the TIDELOCK wordmark and the comms portrait glyph. Everything here is original artwork
// drawn as path data; nothing is loaded from outside.
//
//   icon('prograde')            -> <svg class="tl-icon"> at 24 px, coloured by currentColor
//   icon('market', 20)          -> other sizes keep a ~1.5 px visual stroke
//   wordmark(28)                -> the TIDELOCK wordmark, 28 px cap height
//   logoMark(120)               -> the detailed ring / terminator emblem for splash and title
//
// Path grammar used below: segments separated by "|"; a segment starting with "f:" is filled
// (dots, solid marks), everything else is stroked.

const NS = 'http://www.w3.org/2000/svg';

const n = (v: number): string => String(Math.round(v * 100) / 100);

/** Circle as path data. */
const c = (cx: number, cy: number, r: number): string =>
  `M${n(cx - r)} ${n(cy)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
/** Filled dot. */
const dot = (cx: number, cy: number, r = 1.1): string => `f:${c(cx, cy, r)}`;

function gear(cx: number, cy: number, outer: number, root: number, teeth: number): string {
  const step = (Math.PI * 2) / teeth;
  const pts: string[] = [];
  const at = (r: number, a: number): string => `${n(cx + r * Math.sin(a))} ${n(cy - r * Math.cos(a))}`;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    pts.push(at(root, a - step * 0.3), at(outer, a - step * 0.17), at(outer, a + step * 0.17), at(root, a + step * 0.3));
  }
  return `M${pts.join('L')}Z`;
}

function starPath(cx: number, cy: number, outer: number, inner: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i * Math.PI) / 5;
    pts.push(`${n(cx + r * Math.sin(a))} ${n(cy - r * Math.cos(a))}`);
  }
  return `M${pts.join('L')}Z`;
}

/** Eight member dots on a ring (Meridian Assembly emblem). */
function ringDots(cx: number, cy: number, r: number, count: number, dotR: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const a = ((i + 0.5) * Math.PI * 2) / count;
    out.push(dot(cx + r * Math.sin(a), cy - r * Math.cos(a), dotR));
  }
  return out.join('|');
}

const ICONS = {
  // ---------------------------------------------------------------- navigation & flight
  prograde: `${c(12, 12, 4.5)}M3 12h4.5M16.5 12H21M12 3v4.5|${dot(12, 12)}`,
  retrograde: `${c(12, 12, 4.5)}M9.4 9.4l5.2 5.2M14.6 9.4l-5.2 5.2M12 3v4.5M8.1 14.25L4.2 16.5M15.9 14.25l3.9 2.25`,
  normal: `M12 4.5l8 14H4z|${dot(12, 14)}`,
  antinormal: `M12 19.5l-8-14h16z|${dot(12, 10)}`,
  radialIn: `${c(12, 12, 7.5)}M17.3 6.7l-2.6 2.6M6.7 6.7l2.6 2.6M17.3 17.3l-2.6-2.6M6.7 17.3l2.6-2.6|${dot(12, 12)}`,
  radialOut: `${c(12, 12, 3.2)}M14.9 9.1L19 5M9.1 9.1L5 5M14.9 14.9L19 19M9.1 14.9L5 19`,
  target: `${c(12, 12, 6.5)}M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4|${dot(12, 12, 1.2)}`,
  node: `M3 17.5q8 5 17.5-3.5${c(9.5, 15, 3)}M11.8 12.7L19 5.5M14.5 5H19.5v5`,
  apoapsis: `M4 20C4 10 20 10 20 20M12 10.5L9.6 5.5h4.8z`,
  periapsis: `M4 4c0 10 16 10 16 0M12 13.5l-2.4 5h4.8z`,
  orbit: `M3.77 16.75A9.5 4.4-30 1 1 20.23 7.25 9.5 4.4-30 1 1 3.77 16.75|${dot(12, 12, 2.1)}|${dot(19, 11.9, 1.4)}`,
  map: `${c(12, 12, 4.6)}${c(12, 12, 9)}|${dot(12, 12, 1.5)}|${dot(16, 9.7, 1.3)}|${dot(3.55, 15.1, 1.3)}`,
  warp: `M5 6l6 6-6 6M13 6l6 6-6 6`,
  throttle: `M8 4v16M4.5 4H8M4.5 12H8M4.5 20H8M11.5 7.5h8v5h-8z`,
  rcs: `M10 10h4v4h-4zM12 7V3M10.2 4.8L12 3l1.8 1.8M12 17v4M10.2 19.2L12 21l1.8-1.8M7 12H3M4.8 10.2L3 12l1.8 1.8M17 12h4M19.2 10.2L21 12l-1.8 1.8`,
  sas: `${c(12, 12, 8.5)}M3.5 12H8M16 12h4.5M9 14.5l3-3 3 3`,
  dock: `M10 7.5v9M14 7.5v9M2.5 12h5M5.5 10l2 2-2 2M21.5 12h-5M18.5 10l-2 2 2 2`,
  undock: `M10.5 7.5v9M13.5 7.5v9M7.5 12h-5M4.5 10l-2 2 2 2M16.5 12h5M19.5 10l2 2-2 2`,
  autopilot: `${c(12, 12, 9)}M8.5 16L12 7.5l3.5 8.5M9.8 13h4.4`,
  jump: `M12 3.5a4 8.5 0 0 1 0 17 4 8.5 0 0 1 0-17M2.5 12H8M11 12h10.5M18 8.5l3.5 3.5-3.5 3.5`,
  landing: `M8 5l4 4 4-4M8 10.5l4 4 4-4M4 20h16M7 20v-2M17 20v-2`,

  // ---------------------------------------------------------------- ship systems
  hull: `M12 2.5l6 16.5-6-3-6 3zM12 8.5V12`,
  shield: `M12 3l7 3v5.5c0 4.5-3 8-7 9.5-4-1.5-7-5-7-9.5V6z`,
  heat: `M10 5a2 2 0 0 1 4 0v8.6a4 4 0 1 1-4 0zM12 9v6|${dot(12, 16.8, 1.5)}`,
  fuel: `M12 3s-6.5 7.5-6.5 11.5a6.5 6.5 0 0 0 13 0C18.5 10.500 12 3 12 3zM9 14.500a3 3 0 0 0 3 3`,
  power: `M13 2.5l-7.500 11h6l-1 8 8-11.500h-6z`,
  cargo: `M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9`,
  scanner: `${c(12, 12, 9)}M12 7a5 5 0 0 1 5 5M12 12l6.3-6.3|${dot(12, 12, 1.2)}|${dot(8, 15)}`,
  weapon: `${c(9, 15, 4)}M11.800 12.200L19.500 4.500M17.500 3l3.500 3.500M3 21h12`,
  mining: `M13.500 13l4-1.500 3.500 3-1 4.500-5 1.500-3-3zM3 3l8.500 8.500M12.500 8V5.500M8 12.500H5.500`,
  scoop: `M5 9c0 6 4 10 7 10s7-4 7-10M9 3v6M12 3v8.500M15 3v6M12 19v2.500`,
  radiator: `M5 4h14v12H5zM9 4v12M12 4v12M15 4v12M12 16v5M9 21h6`,

  // ---------------------------------------------------------------- station services
  market: `M4 8h15M15.500 4.500L19 8l-3.500 3.500M20 16H5M8.500 12.500L5 16l3.500 3.500`,
  missions: `M7 4.500h10a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5.500a1 1 0 0 1 1-1zM9.500 4.500V3h5v1.500M9 9.500h6M9 13h6M9 16.500h3.500`,
  outfitting: `M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM16.500 14v5M14 16.500h5`,
  shipyard: `M3 21V8.500L12 3l9 5.500V21M12 9l3 10-3-1.500L9 19z`,
  refuel: `M10 5s-5.500 6.300-5.500 9.800a5.500 5.500 0 0 0 11 0C15.500 11.300 10 5 10 5zM18.500 3v5M16 5.500h5`,
  repair: `M19.880 6.670A3.600 3.600 0 1 1 17.330 4.120L17.250 6.750zM13.600 9.200L4.900 17.900a1.700 1.700 0 0 0 2.400 2.400L16 11.600`,
  survey: `${c(12, 12, 6.5)}M6.200 9.500q5.800 2.500 11.600 0M6.200 14.500q5.800 2.500 11.600 0M2.500 6V2.500H6M18 2.500h3.500V6M21.500 18v3.500H18M6 21.500H2.500V18`,
  legal: `M12 4v16M8 20h8M5 7h14M5 7l-2.500 6.500h5zM19 7l-2.500 6.500h5z`,
  blackmarket: `M3 9.500C3 8 6 7.500 8 7.500s3 1 4 1 2-1 4-1 5 .500 5 2c0 4-2.500 6.500-4.500 6.500s-3-2.500-4.500-2.500-2.500 2.500-4.500 2.500S3 13.500 3 9.500zM6.500 11a1.600 1.200 0 1 0 3.200 0 1.600 1.200 0 1 0-3.200 0M14.300 11a1.600 1.200 0 1 0 3.200 0 1.600 1.200 0 1 0-3.200 0`,
  news: `M5 4h14v16H5zM8 8h8v3H8zM8 14h8M8 17h5`,
  factions: `M6 3v18M6 4.500h12l-3 4 3 4H6`,

  // ---------------------------------------------------------------- commodity categories
  food: `M12 21v-9M12 14.500c-4 0-6.500-2.500-6.500-6 3.500 0 6.500 2 6.500 6zM12 11.500c0-4 2.500-6.500 6.500-6.500 0 4-2.500 6.500-6.500 6.500z`,
  minerals: `M12 3l5 6-5 12L7 9zM7 9l5 3 5-3M12 12v9`,
  metals: `M7 13h10l2.500 6h-15zM9 6h6l2 5H7z`,
  chemicals: `M9.500 3h5M10.500 3v6L5 18.500A1.500 1.500 0 0 0 6.300 21h11.400a1.500 1.500 0 0 0 1.300-2.500L13.500 9V3M7.600 15h8.800`,
  machinery: `${gear(12, 12, 9.2, 6.9, 8)}${c(12, 12, 2.8)}`,
  technology: `M7 7h10v10H7zM10 10h4v4h-4zM10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3`,
  medicine: `M9.500 4h5v5.500H20v5h-5.500V20h-5v-5.500H4v-5h5.500z`,
  consumer: `M12.500 3.500h8v8l-9 9-8-8z${c(16.5, 7.5, 1.3)}`,
  energy: `M6 7h12v13.500H6zM10 7V4h4v3M12.800 10L10 14.500h4L11.200 19`,
  weapons: `M12 2.500c2.500 2.500 3.500 5.500 3.500 8.500v7h-7v-7c0-3 1-6 3.500-8.500zM8.500 14.500h7M8.500 18L6 21.500M15.500 18l2.500 3.500`,
  salvage: `M4 5h7L9 9l3 2-2.500 4 2 4H4zM14.500 5H20v14h-5.500l-2-4 2.500-4-3-2z`,
  contraband: `M12 3l9 9-9 9-9-9zM9.500 9.500l5 5M14.500 9.500l-5 5`,

  // ---------------------------------------------------------------- status
  warning: `M12 3.500L21.500 20h-19zM12 10v4.500|${dot(12, 17.2, 1)}`,
  danger: `M8.300 3h7.400L21 8.300v7.400L15.700 21H8.300L3 15.700V8.300zM12 7.500V13|${dot(12, 16.2, 1)}`,
  info: `${c(12, 12, 9)}M12 11v5.500|${dot(12, 7.8, 1)}`,
  check: `M4.500 12.500l5 5L19.500 7`,
  lock: `M6 11h12v9.500H6zM8.500 11V8a3.500 3.500 0 0 1 7 0v3M12 15v2.500`,
  credits: `M17.950 6.650A8 8 0 1 0 17.950 17.350M2.500 10.200h8M2.500 13.800h8`,
  repUp: `M6 12.500l6-6 6 6M6 18.500l6-6 6 6`,
  repDown: `M6 5.500l6 6 6-6M6 11.500l6 6 6-6`,
  time: `${c(12, 12, 9)}M12 7v5l3.500 2`,
  distance: `M4 7v10M20 7v10M4.500 12h15M7.500 9.500L5 12l2.500 2.500M16.500 9.500L19 12l-2.500 2.500`,
  trendUp: `M3 17l6-6 4 4 8-8M15.500 7H21v5.500`,
  trendDown: `M3 7l6 6 4-4 8 8M15.500 17H21v-5.500`,
  trendFlat: `M3 12h17.500M16.500 8l4 4-4 4`,

  // ---------------------------------------------------------------- interface
  close: `M5.500 5.500l13 13M18.500 5.500l-13 13`,
  back: `M20 12H4.500M10.500 5.500L4 12l6.500 6.500`,
  chevronRight: `M9 5l7 7-7 7`,
  chevronLeft: `M15 5l-7 7 7 7`,
  chevronUp: `M5 15l7-7 7 7`,
  chevronDown: `M5 9l7 7 7-7`,
  menu: `M4 7h16M4 12h16M4 17h10`,
  settings: `M4 6h8.500M17.500 6H20${c(15, 6, 2)}M4 12h1.500M10.500 12H20${c(8, 12, 2)}M4 18h6.500M15.500 18H20${c(13, 18, 2)}`,
  soundOn: `M4 9.500h3.500L12 5.500v13l-4.500-4H4zM15.500 9a4.500 4.500 0 0 1 0 6M18 6.500a8 8 0 0 1 0 11`,
  soundOff: `M4 9.500h3.500L12 5.500v13l-4.500-4H4zM16 9.500l5 5M21 9.500l-5 5`,
  play: `M7.500 4.500L19 12 7.500 19.500z`,
  pause: `M8 5v14M16 5v14`,
  plus: `M12 5v14M5 12h14`,
  minus: `M5 12h14`,
  filter: `M4 5h16l-6 7.500V19l-4-2v-4.500z`,
  sort: `M7 4v16M3.500 16.500L7 20l3.500-3.500M17 20V4M13.500 7.500L17 4l3.500 3.500`,
  star: starPath(12, 12.6, 9.3, 3.9),
  bookmark: `M7 3.500h10v17l-5-4-5 4z`,
  search: `${c(10.5, 10.5, 6.5)}M15.300 15.300L20.500 20.500`,
  more: `${dot(5.5, 12, 1.4)}|${dot(12, 12, 1.4)}|${dot(18.5, 12, 1.4)}`,
  comms: `M4 5h16v11h-8l-4.500 4v-4H4zM8 9h8M8 12h5`,
  station: `${c(12, 12, 8.5)}${c(12, 12, 2.6)}M12 3.500v5.900M12 14.600v5.900M3.500 12h5.900M14.600 12h5.900`,
  planet: `${c(12, 12, 6)}M5.900 14.600C3.700 16.200 2.600 17.500 3 18.200c.800 1.400 5.500-.200 10.500-3.200s8.300-6.600 7.500-8c-.400-.700-2-.500-4.300.300`,

  // ---------------------------------------------------------------- powers & game mark
  powerAssembly: `${c(12, 12, 4.8)}M12 7.200v9.600|${ringDots(12, 12, 9.4, 8, 1.05)}`,
  powerHegemony: `M4 17.500h16M7 17.500a5 5 0 0 1 10 0M12 9V4.500M7.600 11.300L5 8.200M16.400 11.300L19 8.200M6.500 21h11`,
  powerLeague: `M15 4.500A8.500 8.500 0 1 0 15 19.500 9 9 0 0 1 15 4.500zM18.500 8.700l1.900 3.300-1.900 3.300-1.900-3.300z`,
  logo: `${c(12, 12, 8.5)}M20.500 12H23|f:M12 3.500a8.500 8.500 0 0 0 0 17 5.600 8.500 0 0 1 0-17z`,
} as const;

export type IconName = keyof typeof ICONS;

/** Every icon name, in declaration order. */
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

/** Icons grouped for the reference sheet (and handy for pickers). */
export const ICON_GROUPS: { title: string; names: IconName[] }[] = [
  {
    title: 'Navigation & flight',
    names: ['prograde', 'retrograde', 'normal', 'antinormal', 'radialIn', 'radialOut', 'target', 'node', 'apoapsis', 'periapsis', 'orbit', 'map', 'warp', 'throttle', 'rcs', 'sas', 'dock', 'undock', 'autopilot', 'jump', 'landing'],
  },
  { title: 'Ship systems', names: ['hull', 'shield', 'heat', 'fuel', 'power', 'cargo', 'scanner', 'weapon', 'mining', 'scoop', 'radiator'] },
  { title: 'Station services', names: ['market', 'missions', 'outfitting', 'shipyard', 'refuel', 'repair', 'survey', 'legal', 'blackmarket', 'news', 'factions'] },
  { title: 'Commodities', names: ['food', 'minerals', 'metals', 'chemicals', 'machinery', 'technology', 'medicine', 'consumer', 'energy', 'weapons', 'salvage', 'contraband'] },
  { title: 'Status', names: ['warning', 'danger', 'info', 'check', 'lock', 'credits', 'repUp', 'repDown', 'time', 'distance', 'trendUp', 'trendDown', 'trendFlat'] },
  {
    title: 'Interface',
    names: ['close', 'back', 'chevronRight', 'chevronLeft', 'chevronUp', 'chevronDown', 'menu', 'settings', 'soundOn', 'soundOff', 'play', 'pause', 'plus', 'minus', 'filter', 'sort', 'star', 'bookmark', 'search', 'more', 'comms', 'station', 'planet'],
  },
  { title: 'Powers & mark', names: ['powerAssembly', 'powerHegemony', 'powerLeague', 'logo'] },
];

const markupCache = new Map<IconName, string>();

function markup(name: IconName): string {
  let m = markupCache.get(name);
  if (m === undefined) {
    let stroke = '';
    let fill = '';
    for (const seg of ICONS[name].split('|')) {
      if (seg.startsWith('f:')) fill += seg.slice(2);
      else stroke += seg;
    }
    m = (stroke ? `<path d="${stroke}"/>` : '') + (fill ? `<path d="${fill}" fill="currentColor" stroke="none"/>` : '');
    markupCache.set(name, m);
  }
  return m;
}

/**
 * Build an icon. Colour comes from `currentColor`; the stroke is compensated so it stays about
 * 1.5 px on screen at any size (1.25 px below 18 px so small glyphs do not clog).
 */
export function icon(name: IconName, size = 24): SVGSVGElement {
  const el = document.createElementNS(NS, 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  const px = size < 18 ? 1.25 : size <= 28 ? 1.5 : 1.5 + (size - 28) * 0.03;
  el.setAttribute('stroke-width', n((px * 24) / size));
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('class', `tl-icon tl-icon--${name}`);
  el.innerHTML = markup(name);
  return el;
}

/** Swap the glyph of an existing icon element in place. */
export function setIcon(el: SVGSVGElement, name: IconName): void {
  el.innerHTML = markup(name);
  el.setAttribute('class', `tl-icon tl-icon--${name}`);
}

/** Raw SVG markup for an icon (for canvas rasterisation or data URLs). */
export function iconMarkup(name: IconName, size = 24, color = '#E8EEF5'): string {
  return `<svg xmlns="${NS}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" color="${color}">${markup(name)}</svg>`;
}

// ------------------------------------------------------------------ wordmark

/** Letter paths on a 24-unit cap height; x advances are listed beside each. */
const LETTERS: { d: string; w: number }[] = [
  { d: 'M0 0H17M8.5 0V24', w: 17 }, // T
  { d: 'M0 0V24', w: 0 }, // I
  { d: 'M0 0H7A12 12 0 0 1 7 24H0Z', w: 19 }, // D
  { d: 'M0 0H15M0 12H11.500M0 24H15', w: 15 }, // E (stemless)
  { d: 'M0 0V24H14', w: 14 }, // L
  { d: 'M0 12A12 12 0 1 0 24 12 12 12 0 1 0 0 12', w: 24 }, // O (the locked world)
  { d: 'M21.190 4.290A12 12 0 1 0 21.190 19.710', w: 21.2 }, // C
  { d: 'M0 0V24M15.500 0L4 12 15.500 24', w: 15.5 }, // K
];
const LETTER_GAP = 11.5;
const O_INDEX = 5;

export interface WordmarkOptions {
  /** Ember crescent inside the O. Default true. */
  accent?: boolean;
  /** Stroke weight in wordmark units (cap height is 24). Default 2.1. */
  weight?: number;
}

/**
 * The TIDELOCK wordmark: geometric thin-stroke capitals with the O drawn as a tidally locked
 * world — a ring holding a lit ember crescent. `height` is the cap height in px.
 */
export function wordmark(height = 24, opts: WordmarkOptions = {}): SVGSVGElement {
  const weight = opts.weight ?? 2.1;
  let x = 0;
  let d = '';
  let oX = 0;
  LETTERS.forEach((l, i) => {
    if (i === O_INDEX) oX = x;
    d += `<path transform="translate(${n(x)} 0)" d="${l.d}"/>`;
    x += l.w + LETTER_GAP;
  });
  const width = x - LETTER_GAP;
  const pad = weight;
  const el = document.createElementNS(NS, 'svg');
  el.setAttribute('viewBox', `${-pad} ${-pad} ${n(width + pad * 2)} ${24 + pad * 2}`);
  el.setAttribute('height', n(height * ((24 + pad * 2) / 24)));
  el.setAttribute('width', n(((width + pad * 2) / 24) * height));
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', String(weight));
  el.setAttribute('stroke-linecap', 'butt');
  el.setAttribute('stroke-linejoin', 'miter');
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', 'TIDELOCK');
  el.setAttribute('class', 'tl-wordmark');
  const crescent =
    opts.accent === false
      ? ''
      : `<path class="tl-wordmark__ember" transform="translate(${n(oX)} 0)" d="M12 3.600a8.400 8.400 0 0 0 0 16.800 4.700 8.400 0 0 1 0-16.800z" fill="var(--tl-ember, #FFB454)" stroke="none"/>`;
  el.innerHTML = d + crescent;
  return el;
}

// ------------------------------------------------------------------ logo mark

/**
 * The game emblem: a tidally locked world (ring + ember day-side crescent) inside a graduated
 * instrument bezel, with one tilted orbit and its satellite in ion cyan. Sized square.
 */
export function logoMark(size = 120): SVGSVGElement {
  const el = document.createElementNS(NS, 'svg');
  el.setAttribute('viewBox', '0 0 120 120');
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('fill', 'none');
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', 'TIDELOCK emblem');
  el.setAttribute('class', 'tl-logomark');
  let ticks = '';
  for (let i = 0; i < 72; i++) {
    const a = (i * Math.PI * 2) / 72;
    const major = i % 6 === 0;
    const r0 = major ? 50.5 : 52.5;
    const r1 = 55;
    ticks += `M${n(60 + r0 * Math.sin(a))} ${n(60 - r0 * Math.cos(a))}L${n(60 + r1 * Math.sin(a))} ${n(60 - r1 * Math.cos(a))}`;
  }
  const id = `tl-lm-${Math.random().toString(36).slice(2, 8)}`;
  el.innerHTML = `
<defs>
  <linearGradient id="${id}-e" x1="28" y1="60" x2="62" y2="60" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#FFD9A0"/><stop offset=".45" stop-color="#FFB454"/><stop offset="1" stop-color="#FFB454" stop-opacity=".0"/>
  </linearGradient>
  <radialGradient id="${id}-g" cx="60" cy="60" r="60" gradientUnits="userSpaceOnUse">
    <stop offset=".35" stop-color="#FFB454" stop-opacity=".16"/><stop offset=".8" stop-color="#FFB454" stop-opacity="0"/>
  </radialGradient>
</defs>
<circle cx="60" cy="60" r="60" fill="url(#${id}-g)"/>
<path class="tl-logomark__bezel" d="${ticks}" stroke="currentColor" stroke-opacity=".34" stroke-width=".8"/>
<circle class="tl-logomark__ring" cx="60" cy="60" r="32" stroke="currentColor" stroke-width="1.6"/>
<path class="tl-logomark__day" d="M60 31.500a28.500 28.500 0 0 0 0 57 15.500 28.500 0 0 1 0-57z" fill="url(#${id}-e)"/>
<path d="M60 31.500a15.500 28.500 0 0 0 0 57" stroke="currentColor" stroke-opacity=".28" stroke-width=".8"/>
<path d="M101.100 41.700A45 13-24 0 0 84.170 38.830M28.090 63.790A45 13-24 0 0 18.900 78.300" stroke="#6FE3FF" stroke-width="1" stroke-opacity=".4"/>
<path class="tl-logomark__orbit" d="M18.900 78.300A45 13-24 0 0 101.100 41.700" stroke="#6FE3FF" stroke-width="1" stroke-opacity=".9"/>
<circle class="tl-logomark__sat" cx="82.200" cy="63" r="2.300" fill="#6FE3FF"/>
<path d="M4 60h9M107 60h9" stroke="currentColor" stroke-opacity=".5" stroke-width="1"/>`;
  return el;
}

// ------------------------------------------------------------------ comms portrait

/**
 * Procedural contact portrait for comms panels: a thin-line head-and-shoulders glyph in a framed
 * viewport with scanlines. `seed` picks one of several silhouettes so recurring contacts stay
 * recognisable; colour comes from currentColor (set it to the speaker's faction colour).
 */
export function portrait(seed = 0, size = 56): SVGSVGElement {
  const el = document.createElementNS(NS, 'svg');
  el.setAttribute('viewBox', '0 0 56 56');
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '1.4');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('class', 'tl-portrait');
  const s = Math.abs(Math.floor(seed));
  const heads = [
    // bare head, short crop
    'M19 26c0-6.500 4-10.500 9-10.500s9 4 9 10.500c0 6-4 10.500-9 10.500s-9-4.500-9-10.500zM19.500 22.500c3-1 5-3.500 5.500-6M36.500 23c-3-.500-5.500-3-6.500-6.500',
    // pressure helmet with visor
    'M17 27c0-8 5-13 11-13s11 5 11 13c0 5-2.500 9.500-6 10.500H23c-3.500-1-6-5.500-6-10.500zM20 24.500h16v6.500c-2 2-4.500 3-8 3s-6-1-8-3z',
    // hooded
    'M28 12.500c-8 0-12 6.500-12 14.500 0 4 1 7.500 3 10h18c2-2.500 3-6 3-10 0-8-4-14.500-12-14.500zM21.500 28c0-4.500 2.800-7.500 6.500-7.500s6.500 3 6.500 7.500-2.800 8-6.500 8-6.500-3.500-6.500-8z',
    // officer cap
    'M19.500 27c0 6 3.800 10 8.500 10s8.500-4 8.500-10M17 22.500h22l-2-6.500c-3-1.500-6-2-9-2s-6 .500-9 2zM16 23c4 1.500 8 2 12 2s8-.500 12-2',
  ];
  const collars = [
    'M9 52c1-8 6.500-11.500 13-12.500l6 5 6-5c6.500 1 12 4.500 13 12.500',
    'M8 52c1.500-7.500 7-11 14-12h12c7 1 12.500 4.500 14 12M22 40v4.500h12V40',
    'M10 52c1-7 6-11 12.500-12.500L28 47l5.500-7.500C40 41 45 45 46 52M28 47v5',
  ];
  let scan = '';
  for (let y = 7; y < 50; y += 3) scan += `M5 ${y}h46`;
  el.innerHTML = `
<path d="${scan}" stroke-opacity=".1" stroke-width="1"/>
<path d="${heads[s % heads.length]}"/>
<path d="${collars[(s >> 2) % collars.length]}"/>
<path d="M4 12V4h8M44 4h8v8M52 44v8h-8M12 52H4v-8" stroke-opacity=".7" stroke-width="1"/>`;
  return el;
}
