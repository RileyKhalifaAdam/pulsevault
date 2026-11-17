// UI kit harness: every component of src/ui/kit rendered with in-world content.
//
//   dev/uikit.html?page=components|market|mission|faction|hudbits|icons|splash
//     &scroll=<px>        scroll the main body (long pages)
//     &overlay=modal|sheet|toast|help   (components page) open an overlay
//     &sheet=0            (mission page) board without the briefing sheet
//     &mode=sell          (market page)
//     &ready=1            (splash page) loader replaced by the start button
//     &safe=0             no simulated iPhone 15 safe-area insets / device chrome
//     &fx=lite            no backdrop blur
//     &anim=1             keep typed-on comms text animating

import {
  createRoot, h, setStyle, staggerIn,
  icon, logoMark, wordmark, ICON_GROUPS, type IconName,
  Panel, ScreenHeader, Screen, Button, IconButton, HoldButton, Toggle, Slider, Stepper, Tabs, SegmentedControl, Chips,
  Badge, delta, ListRow, List, DataTable, cellMain, cellFigure, cellStock, KeyValue, Readout, Gauge, ProgressBar,
  StackedInfluenceBar, EmptyState, Skeleton, setTone,
  Sparkline, LineChart, BarChart, Legend,
  Modal, BottomSheet, ToastStack, toast, HelpTip, CommsMessage, Splash,
  type Child, type Column, type ToneOrColor,
} from '../../src/ui/kit';

const q = new URLSearchParams(location.search);
const page = q.get('page') ?? 'components';
const landscape = window.innerWidth > window.innerHeight && window.innerHeight <= 520;
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

// ------------------------------------------------------------------ harness chrome

const css = `
.hx-island { position: absolute; z-index: 200; background: #000; border-radius: 19px; pointer-events: none; top: 11px; left: 50%; width: 124px; height: 36px; margin-left: -62px; }
.hx-home { position: absolute; z-index: 200; left: 50%; bottom: 8px; width: 138px; height: 5px; margin-left: -69px; border-radius: 3px; background: rgba(255, 255, 255, 0.5); pointer-events: none; }
.hx-land .hx-island { top: 50%; left: 11px; width: 36px; height: 124px; margin: -62px 0 0; }
.hx-land .hx-home { width: 210px; margin-left: -105px; bottom: 6px; }
.hx-cols { display: flex; flex-direction: column; gap: 12px; }
.hx-land .hx-cols { flex-direction: row; align-items: flex-start; }
.hx-col { display: flex; flex-direction: column; gap: 12px; min-width: 0; flex: 1 1 0; }
.hx-wrap { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.hx-cap { margin-top: 2px; }
.hx-port .hx-only-land, .hx-land .hx-only-port { display: none !important; }

/* market */
.hx-market { flex: 1 1 0; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
.hx-market__bar { display: flex; flex-direction: column; gap: 4px; padding: 0 var(--tl-gutter) 4px; }
.hx-market__hold { flex: 1 1 0; min-width: 0; }
.hx-land .hx-market { grid-template-columns: minmax(0, 1fr) 304px; column-gap: 12px; padding: 0 var(--tl-gutter) calc(var(--tl-safe-b) + 4px) 0; }
.hx-land .hx-market__bar { flex-direction: row; align-items: center; gap: 12px; padding-right: 0; }
.hx-land .hx-market__bar .tl-seg { flex: none; width: 150px; }
.hx-land .hx-market__detail { grid-column: 2; grid-row: 1 / span 2; align-self: stretch; }
.hx-trend { display: flex; align-items: center; justify-content: flex-end; gap: 4px; color: var(--tl-dim); }
.hx-trade { display: flex; flex-direction: column; gap: 10px; }
.hx-trade__row { display: flex; gap: 8px; align-items: stretch; }

/* hud bits */
.hx-space { position: absolute; inset: 0; width: 100%; height: 100%; }
.hx-hud { position: absolute; inset: 0; display: grid; gap: 10px; padding: calc(var(--tl-safe-t) + 8px) calc(var(--tl-safe-r) + 12px) calc(var(--tl-safe-b) + 10px) calc(var(--tl-safe-l) + 12px);
  grid-template: 'read' auto 'toast' auto 'space' minmax(40px, 1fr) 'gauge' auto 'sas' auto 'comms' auto / minmax(0, 1fr); }
.hx-land .hx-hud { padding-top: 12px; grid-template: 'read toast' auto 'space space' minmax(8px, 1fr) 'sas comms' auto 'gauge comms' auto / minmax(0, 1fr) 312px; column-gap: 12px; }
.hx-hud .tl-toasts { position: relative; top: auto; left: auto; right: auto; width: auto; transform: none; grid-area: toast; }
.hx-gauges { display: flex; flex-wrap: wrap; gap: 14px 18px; align-items: center; }
.hx-gauges__radials { display: flex; gap: 12px; flex: none; justify-content: space-between; }
.hx-port .hx-gauges__radials { width: 100%; padding: 0 6px; }
.hx-gauges__bars { flex: 1 1 150px; min-width: 0; display: grid; gap: 12px 16px; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
.hx-marker { position: absolute; display: flex; align-items: center; gap: 8px; color: var(--tl-c); }
.hx-marker__tag { display: flex; flex-direction: column; gap: 2px; padding-left: 8px; border-left: 1px solid color-mix(in srgb, var(--tl-c) 60%, transparent); }
.hx-marker__tag b { font-size: 11px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; }
.hx-marker__tag span { font-size: 13px; color: var(--tl-text); }

/* icons */
.hx-icons { display: grid; grid-template-columns: repeat(auto-fill, minmax(78px, 1fr)); gap: 4px 2px; }
.hx-icon { display: flex; flex-direction: column; align-items: center; gap: 7px; padding: 10px 0 8px; min-width: 0; color: var(--tl-text); }
.hx-icon span { font-family: var(--tl-font-body); font-size: 11px; color: var(--tl-dim); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hx-marks { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
.hx-power { display: flex; align-items: center; gap: 10px; color: var(--tl-c); }
.hx-power b { display: block; font-size: 13px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: var(--tl-text); }
.hx-power small { display: block; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--tl-dim); margin-top: 2px; }
.hx-sizes { display: flex; align-items: flex-end; gap: 18px; color: var(--tl-text); }

/* faction */
.hx-powers { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.hx-ptile { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.hx-ptile__top { display: flex; align-items: center; gap: 8px; color: var(--tl-c); }
.hx-ptile__n { font-size: 20px; line-height: 1; color: var(--tl-text); }
.hx-versus { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 10px; }
.hx-versus__side { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.hx-versus__side--r { align-items: flex-end; text-align: right; }
.hx-versus__name { font-size: 13px; letter-spacing: 0.02em; line-height: 1.25; }
.hx-versus__score { font-size: 24px; line-height: 1; color: var(--tl-c); }
.hx-days { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 3px; height: 8px; }
.hx-days i { background: rgba(255, 255, 255, 0.08); }
`;
document.head.appendChild(h('style', { text: css }));

const root = createRoot(document.body);
root.classList.add(landscape ? 'hx-land' : 'hx-port');
if (q.get('fx') === 'lite') root.dataset.fx = 'lite';
if (q.get('safe') !== '0') {
  // iPhone 15 insets: portrait 59 / 34, landscape 59 left & right, 21 bottom.
  setStyle(root, '--tl-safe-t', landscape ? '0px' : '59px');
  setStyle(root, '--tl-safe-b', landscape ? '21px' : '34px');
  setStyle(root, '--tl-safe-l', landscape ? '59px' : '0px');
  setStyle(root, '--tl-safe-r', landscape ? '59px' : '0px');
  root.append(h('div.hx-island'), h('div.hx-home'));
}

// ------------------------------------------------------------------ mock data helpers

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A mean-reverting random walk ending at `end`. */
function series(n: number, end: number, vol: number, drift: number, seed: number): number[] {
  const r = rng(seed);
  const out: number[] = [];
  let v = 0;
  for (let i = 0; i < n; i++) {
    v += (r() - 0.5) * vol + drift - v * 0.06;
    out.push(v);
  }
  const off = end - out[n - 1];
  return out.map((x) => x + off);
}

const caption = (text: string): HTMLElement => h('div.tl-label.hx-cap', { text });

// ------------------------------------------------------------------ page: components

function pageComponents(): void {
  const toggles = [
    Toggle({ label: 'Flight assist', hint: 'Damp rotation when the stick is released', value: true }),
    Toggle({ label: 'Auto-drop warp at encounters', value: true, tone: 'ion' }),
    Toggle({ label: 'Report crimes against me', value: false }),
  ];
  const buttons = Panel({ title: 'Buttons', code: 'BTN' },
    h('div.hx-wrap', null,
      Button({ label: 'Accept contract', variant: 'primary', onTap: () => {} }).el,
      Button({ label: 'Plot route', icon: 'node', onTap: () => {} }).el),
    h('div.hx-wrap', null,
      Button({ label: 'Set target', variant: 'ion', icon: 'target', onTap: () => {} }).el,
      Button({ label: 'Burn', variant: 'ember', icon: 'prograde', onTap: () => {} }).el,
      Button({ label: 'Cancel', variant: 'ghost', onTap: () => {} }).el),
    h('div.hx-wrap', null,
      IconButton('bookmark', 'Bookmark', () => {}, 'secondary').el,
      IconButton('filter', 'Filter', () => {}, 'secondary').el,
      IconButton('map', 'Map', () => {}, 'ion').el,
      IconButton('settings', 'Settings', () => {}).el,
      Button({ label: 'Refuel', size: 'sm', icon: 'refuel', onTap: () => {} }).el,
      Button({ label: 'Docked', disabled: true }).el),
    Button({ label: 'Buy 12 t', detail: '1,968 cr', variant: 'primary', block: true, onTap: () => {} }).el,
    h('div.hx-wrap', null,
      HoldButton({ label: 'Hold to jettison', icon: 'cargo', onConfirm: () => toast({ title: 'Cargo jettisoned', message: '6 t of Scrap Hull Plate released.', tone: 'red' }) }).el,
      Button({ label: 'Abandon', variant: 'danger', onTap: () => {} }).el));

  const inputs = Panel({ title: 'Controls', code: 'INP' },
    h('div.tl-col.tl-gap-0', null, toggles.map((t) => t.el)),
    Slider({ label: 'Throttle', value: 64, min: 0, max: 100, step: 1, unit: '%' }).el,
    Slider({ label: 'Time warp limit', value: 4, min: 0, max: 6, step: 1, ticks: 6, tone: 'ion', format: (v) => `×${fmt(Math.pow(10, v))}` }).el,
    h('div.tl-row.tl-row--between', null,
      h('div.tl-col.tl-gap-1', null, h('span.tl-label', null, 'Quantity'), h('span.tl-small', null, 'Hold to step faster')),
      Stepper({ value: 12, min: 0, max: 32, unit: 't', ariaLabel: 'Quantity' }).el));

  const nav = Panel({ title: 'Navigation', code: 'NAV' },
    Tabs({ inset: true, value: 'market', items: [
      { id: 'market', label: 'Market', icon: 'market' }, { id: 'missions', label: 'Missions', icon: 'missions', count: 7 },
      { id: 'outfit', label: 'Outfitting', icon: 'outfitting' }, { id: 'yard', label: 'Shipyard', icon: 'shipyard' },
    ] }).el,
    SegmentedControl({ block: true, value: 'buy', items: [{ id: 'buy', label: 'Buy' }, { id: 'sell', label: 'Sell' }, { id: 'hold', label: 'Hold' }] }).el,
    SegmentedControl({ block: true, tone: 'ion', value: 'prograde', items: [
      { id: 'prograde', icon: 'prograde', ariaLabel: 'Prograde' }, { id: 'retrograde', icon: 'retrograde', ariaLabel: 'Retrograde' },
      { id: 'normal', icon: 'normal', ariaLabel: 'Normal' }, { id: 'antinormal', icon: 'antinormal', ariaLabel: 'Anti-normal' },
      { id: 'radialIn', icon: 'radialIn', ariaLabel: 'Radial in' }, { id: 'radialOut', icon: 'radialOut', ariaLabel: 'Radial out' },
    ] }).el,
    Chips({ inset: true, value: 'food', items: [
      { id: 'food', label: 'Food', icon: 'food' }, { id: 'metals', label: 'Metals', icon: 'metals' }, { id: 'energy', label: 'Energy', icon: 'energy' },
      { id: 'technology', label: 'Technology', icon: 'technology' }, { id: 'medicine', label: 'Medicine', icon: 'medicine' },
    ] }).el);

  const badges = Panel({ title: 'Badges & deltas', code: 'TAG' },
    h('div.hx-wrap', null,
      Badge({ label: 'Assembly', tone: 'assembly', icon: 'powerAssembly' }).el, Badge({ label: 'Hegemony', tone: 'hegemony', icon: 'powerHegemony' }).el,
      Badge({ label: 'League', tone: 'league', icon: 'powerLeague' }).el, Badge({ label: 'Independent', tone: 'independent' }).el,
      Badge({ label: 'Scorch clan', tone: 'outlaw' }).el),
    h('div.hx-wrap', null,
      Badge({ label: 'Boom', tone: 'green', dot: true }).el, Badge({ label: 'Election', tone: 'ion', dot: true }).el,
      Badge({ label: 'Famine', tone: 'red', dot: true }).el, Badge({ label: 'Expansion', tone: 'ember', dot: true }).el,
      Badge({ label: 'War', tone: 'red', solid: true }).el, Badge({ label: 'Rush', tone: 'ember', solid: true }).el),
    h('div.hx-wrap', { style: 'gap:8px 18px' },
      Badge({ label: 'Clean record', tone: 'green', dot: true, plain: true }).el, Badge({ label: 'Wanted · 4,200 cr', tone: 'red', dot: true, plain: true }).el,
      delta(0.034), delta(-0.012), delta(0), delta(0.021, { invert: true })));

  const readouts = Panel({ title: 'Readouts', code: 'KV' },
    KeyValue({ cols: 2, items: [
      { k: 'Δv remaining', v: '4.82', unit: 'km/s', tone: 'ember' }, { k: 'Wet mass', v: '86.4', unit: 't' },
      { k: 'Thrust / weight', v: '1.42' }, { k: 'Jump range', v: '6.2', unit: 'ly', tone: 'ion' },
    ] }).el,
    h('div.tl-divider'),
    KeyValue({ layout: 'rows', items: [
      { k: 'Cargo', v: '14 / 32', unit: 't' }, { k: 'Insurance excess', v: '2,150', unit: 'cr' },
      { k: 'Standing with the Delegacy', v: h('span.tl-pos', null, 'Friendly') },
    ] }).el,
    h('div.tl-row', null, h('span.tl-label', null, 'What is Δv?'),
      HelpTip({ title: 'Delta-v', text: 'How much you can still change your velocity with the propellant aboard. Every manoeuvre spends some; the planner shows the cost before you commit.' }).el));

  const gauges = Panel({ title: 'Gauges', code: 'GAU' },
    h('div.tl-row.tl-row--between', { style: 'padding:0 4px' },
      Gauge({ kind: 'radial', value: 64, max: 100, text: '64', unit: '%', label: 'Throttle', tone: 'ember', size: 92 }).el,
      Gauge({ kind: 'radial', value: 412, max: 600, text: '412', unit: 'K', label: 'Hull temp', tone: 'ion', zone: [480, 600], size: 92 }).el,
      Gauge({ kind: 'radial', value: 82, max: 100, text: '82', unit: '%', label: 'Reactor', tone: 'green', size: 92 }).el),
    Gauge({ label: 'Propellant', icon: 'fuel', value: 0.68, text: '6.8', unit: 't', tone: 'ember' }).el,
    Gauge({ label: 'Δv · need vs have', icon: 'node', value: 4.82, max: 6, mark: 3.42, text: '3.42 / 4.82', unit: 'km/s', tone: 'green' }).el,
    Gauge({ kind: 'segmented', label: 'Hull', icon: 'hull', value: 0.86, text: '86', unit: '%', tone: 'green', segments: 12 }).el,
    Gauge({ kind: 'segmented', label: 'Shield', icon: 'shield', value: 0.42, text: '42', unit: '%', tone: 'ion', segments: 12 }).el,
    h('div.tl-col.tl-gap-1', null, h('span.tl-label', null, 'Jump drive charging'), ProgressBar({ value: 0.37, tone: 'ion', thickness: 'thin' }).el));

  const influence = Panel({ title: 'Influence', code: 'INF' },
    StackedInfluenceBar({ scale: true, segments: FACTIONS.map((f) => ({ id: f.id, label: f.short, value: f.inf, color: f.color, delta: f.d, controlling: f.ctrl })) }).el);

  const price = series(48, 164, 16, 0.4, 11);
  const charts = Panel({ title: 'Charts', code: 'CHT' },
    h('div.tl-row.tl-row--between', null,
      Sparkline({ values: series(24, 10, 3, 0.3, 3), tone: 'trend' }).el, Sparkline({ values: series(24, 10, 3, -0.3, 5), tone: 'trend' }).el,
      Sparkline({ values: series(24, 10, 2, 0.1, 8), tone: 'ion', area: true }).el, Sparkline({ values: series(24, 10, 4, 0, 9), tone: 'ember', area: true }).el),
    caption('Twilight Grain · cr / t · 30 days'),
    LineChart({ height: 124, scrub: true, series: [{ values: price, color: 'ember', area: true }], xLabels: ['−30 d', '−20 d', '−10 d', 'Now'], markers: [{ index: 31, label: 'Famine in Tallow', tone: 'red' }] }).el,
    caption('Profit per run · cr'),
    BarChart({ height: 84, signed: true, values: [1200, 2100, -640, 3200, 1800, -220, 2600, 4100, 3600, -900, 2900, 5200], yFormat: (v) => fmt(v) }).el);

  const list = Panel({ title: 'List', code: 'LST', flush: true },
    List([
      ListRow({ icon: 'refuel', title: 'Refuel', subtitle: 'Liquid hydrogen · 85 cr / t', value: '272 cr', note: h('span.tl-cell-sub', null, '3.2 t'), onTap: () => {} }),
      ListRow({ icon: 'repair', title: 'Repair hull', subtitle: 'Plating and seals · 14 % damage', value: '1,180 cr', tone: 'ember', selected: true, onTap: () => {} }),
      ListRow({ icon: 'legal', title: 'Clear fines', subtitle: 'Chancel Audit Office', value: '0 cr', note: Badge({ label: 'Clean', tone: 'green', plain: true, dot: true }).el, tone: 'ion', onTap: () => {} }),
    ]).el);

  const table = Panel({ title: 'Data table', code: 'TBL', flush: true },
    DataTable<MarketRow>({ scroll: false, columns: marketColumns('buy'), rows: MARKET.slice(0, 4), rowKey: (r) => r.id, sort: { id: 'price', dir: 'desc' }, selected: MARKET[1].id, onRowTap: () => {} }).el);

  const modal = (): void => Modal({
    title: 'Undock without clearance?', icon: 'warning', tone: 'ember',
    message: 'Rotunda Control has not released your clamps. Forcing the collar is a crime in Assembly space and will damage the port.',
    body: KeyValue({ layout: 'rows', items: [{ k: 'Fine', v: '2,400', unit: 'cr' }, { k: 'Standing with the Delegacy', v: h('span.tl-neg', null, '−6') }] }).el,
    actions: [{ label: 'Stay docked', variant: 'ghost' }, { label: 'Request clearance', variant: 'primary' }],
  }).open();
  const sheet = (): void => missionSheet().open();
  const toasts = (): void => {
    toast({ title: 'Docking clearance granted', message: 'The Rotunda · port M-04 · hold 3 m/s inside the zone', tone: 'green', stamp: 'NOW', duration: 0 });
    toast({ title: 'Heat shield at 82 %', message: 'Periapsis 61 km is inside the red band.', tone: 'ember', stamp: 'T−04:10', duration: 0 });
  };
  const states = Panel({ title: 'States & overlays', code: 'FBK' },
    h('div.hx-wrap', null,
      Button({ label: 'Modal', size: 'sm', onTap: modal }).el, Button({ label: 'Sheet', size: 'sm', onTap: sheet }).el, Button({ label: 'Toast', size: 'sm', onTap: toasts }).el),
    Skeleton({ kind: 'rows', count: 2 }).el,
    h('div.tl-divider'),
    EmptyState({ icon: 'missions', title: 'No contracts posted', message: 'The Lodge has nothing for an unknown captain. Trade here or run errands for its allies to be noticed.', action: Button({ label: 'View standing', variant: 'ion', size: 'sm' }) }).el);

  const comms = CommsMessage({
    name: 'Rotunda Control', role: 'Quorum Delegacy · Traffic', tone: 'assembly', glyph: 3,
    lines: ['Wren seven-one, you are inside the control zone. Hold three metres per second and take port M-04 on the dusk side.', 'Clamps will engage on soft capture. Welcome to the Rotunda, Captain.'],
  });
  if (q.get('anim') !== '1') comms.next();

  const sections = [buttons, inputs, nav, badges, readouts, gauges, influence, charts, list, table, states];
  const cols = [h('div.hx-col'), h('div.hx-col')];
  sections.forEach((s, i) => cols[landscape ? i % 2 : 0].appendChild(s.el));
  cols[landscape ? 1 : 0].appendChild(comms.el);
  const screen = Screen({
    header: ScreenHeader({ title: 'Interface kit', location: 'Tidelock · design system', locationIcon: 'logo', onBack: () => {}, credits: 48250 }),
    body: h('div.hx-cols', null, cols[0], landscape ? cols[1] : null),
  });
  root.appendChild(screen.el);
  const overlay = q.get('overlay');
  if (overlay === 'modal') modal();
  if (overlay === 'sheet') sheet();
  if (overlay === 'toast') toasts();
  if (overlay === 'help') requestAnimationFrame(() => (readouts.el.querySelector('.tl-help') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })));
  scrollTo(screen.body);
}

function scrollTo(body: HTMLElement): void {
  const y = Number(q.get('scroll') ?? 0);
  if (y) requestAnimationFrame(() => (body.scrollTop = y));
}

// ------------------------------------------------------------------ page: market

interface MarketRow {
  id: string;
  name: string;
  cat: string;
  icon: IconName;
  price: number;
  avg: number;
  stock: number;
  cap: number;
  hist: number[];
}

const mk = (id: string, name: string, cat: string, price: number, avg: number, stock: number, cap: number, seed: number, drift: number): MarketRow =>
  ({ id, name, cat, icon: cat.toLowerCase() as IconName, price, avg, stock, cap, hist: series(24, price, avg * 0.05, avg * 0.012 * drift, seed) });

const MARKET: MarketRow[] = [
  mk('duskwine', 'Duskwine', 'Consumer', 1412, 1300, 86, 400, 21, 1),
  mk('fusion_pellets', 'Fusion Pellets', 'Energy', 1038, 960, 240, 900, 22, 1),
  mk('household_goods', 'Household Goods', 'Consumer', 455, 470, 1310, 2000, 23, 0),
  mk('liquid_hydrogen', 'Liquid Hydrogen', 'Energy', 78, 85, 9400, 12000, 24, -1),
  mk('machine_parts', 'Machine Parts', 'Machinery', 842, 780, 310, 1500, 25, 1),
  mk('medical_supplies', 'Medical Supplies', 'Medicine', 1004, 900, 64, 600, 26, 1),
  mk('orchard_produce', 'Orchard Produce', 'Food', 498, 540, 2260, 2600, 27, -1),
  mk('polymers', 'Polymer Stock', 'Chemicals', 331, 320, 820, 1800, 28, 0),
  mk('sensor_arrays', 'Sensor Arrays', 'Technology', 3620, 3400, 42, 300, 29, 1),
  mk('structural_steel', 'Structural Steel', 'Metals', 452, 430, 1180, 3000, 30, 0),
  mk('titanium_plate', 'Titanium Plate', 'Metals', 1265, 1180, 205, 1200, 31, 1),
  mk('twilight_grain', 'Twilight Grain', 'Food', 164, 160, 6840, 8000, 32, 0),
  mk('vat_protein', 'Vat Protein', 'Food', 221, 240, 3920, 5000, 33, -1),
  mk('water_ice', 'Water Ice', 'Minerals', 46, 40, 2100, 9000, 34, 1),
];

function marketColumns(mode: 'buy' | 'sell'): Column<MarketRow>[] {
  return [
    { id: 'name', label: 'Commodity', width: 'minmax(0, 1fr)', sortValue: (r) => r.name, render: (r) => cellMain(r.icon, r.name, r.cat) },
    { id: 'price', label: 'cr / t', width: '82px', align: 'right', sortValue: (r) => r.price, render: (r) => cellFigure(fmt(r.price), delta((r.price - r.avg) / r.avg, { invert: mode === 'buy' })) },
    { id: 'stock', label: mode === 'buy' ? 'Stock' : 'Demand', width: '68px', align: 'right', sortValue: (r) => r.stock, render: (r) => cellStock(r.stock / r.cap, fmt(r.stock), r.stock / r.cap < 0.18 ? 'ember' : 'ion') },
    {
      id: 'trend', label: '7 d', width: '66px', align: 'right', sortValue: (r) => r.hist[r.hist.length - 1] - r.hist[0],
      render: (r) => {
        const ch = (r.hist[r.hist.length - 1] - r.hist[0]) / r.avg;
        return h('div.hx-trend', null, Sparkline({ values: r.hist, width: 34, height: 22, tone: 'ion', dot: false }).el, icon(ch > 0.02 ? 'trendUp' : ch < -0.02 ? 'trendDown' : 'trendFlat', 14));
      },
    },
  ];
}

function pageMarket(): void {
  const mode = q.get('mode') === 'sell' ? 'sell' : 'buy';
  const sel = MARKET.find((r) => r.id === 'twilight_grain')!;
  const qty = 12;
  const header = ScreenHeader({ title: 'Market', location: 'Ledgerline Exchange · Chancel', onBack: () => {}, credits: 48250 });
  const table = DataTable<MarketRow>({ columns: marketColumns(mode), rows: MARKET, rowKey: (r) => r.id, sort: { id: 'name', dir: 'asc' }, selected: sel.id, onRowTap: (r) => table.update({ selected: r.id }) });
  const bar = h('div.hx-market__bar', null,
    h('div.tl-row.tl-gap-3', null,
      SegmentedControl({ value: mode, items: [{ id: 'buy', label: 'Buy' }, { id: 'sell', label: 'Sell' }] }).el,
      h('div.hx-market__hold', null, Gauge({ label: 'Hold', icon: 'cargo', value: 14, max: 32, text: '14 / 32', unit: 't', tone: 'ion', thickness: 'thin' }).el)),
    Chips({ inset: true, value: null, items: [
      { id: 'food', label: 'Food', icon: 'food' }, { id: 'minerals', label: 'Minerals', icon: 'minerals' }, { id: 'metals', label: 'Metals', icon: 'metals' },
      { id: 'energy', label: 'Energy', icon: 'energy' }, { id: 'machinery', label: 'Machinery', icon: 'machinery' }, { id: 'technology', label: 'Technology', icon: 'technology' },
      { id: 'medicine', label: 'Medicine', icon: 'medicine' }, { id: 'consumer', label: 'Consumer', icon: 'consumer' },
    ] }).el);
  const total = `${fmt(sel.price * qty)} cr`;
  const verb = mode === 'buy' ? 'Buy' : 'Sell';
  const trade = (): HTMLElement => h('div.hx-trade__row', null,
    Stepper({ value: qty, min: 0, max: 18, unit: 't', ariaLabel: 'Quantity' }).el,
    Button({ label: verb, detail: total, variant: 'primary', block: true, onTap: () => {} }).el);
  const footer = h('div.hx-trade', null,
    h('div.tl-row.tl-row--between', null,
      h('span.tl-label', null, `${sel.name} · ${fmt(sel.price)} cr / t`),
      h('span.tl-label', null, 'Balance after ', h('span.tl-num', { style: 'color:var(--tl-text)' }, `${fmt(48250 - sel.price * qty)} cr`))),
    trade());
  const detail = Panel({ title: sel.name, code: sel.cat, icon: sel.icon, tone: 'ember', class: 'hx-market__detail hx-only-land' },
    h('div.tl-row.tl-row--between.tl-row--top', null,
      Readout({ label: 'Price', value: fmt(sel.price), unit: 'cr / t' }).el,
      Readout({ label: 'Reach average', value: fmt(sel.avg), unit: 'cr', align: 'right' }).el,
      Readout({ label: 'In hold', value: '0', unit: 't', align: 'right' }).el),
    LineChart({ height: 92, scrub: true, series: [{ values: series(40, sel.price, 9, 0.2, 77), color: 'ember', area: true }], xLabels: ['−30 d', '−15 d', 'Now'], yTicks: 2 }).el,
    trade());
  const screen = Screen({ header, flush: true, scroll: false, body: h('div.hx-market', null, bar, table.el, detail.el), footer });
  screen.foot?.classList.add('hx-only-port');
  root.appendChild(screen.el);
}

// ------------------------------------------------------------------ page: mission

interface Mission {
  icon: IconName;
  title: string;
  faction: string;
  tone: ToneOrColor;
  tags: { label: string; tone?: ToneOrColor; solid?: boolean }[];
  reward: number;
  due: string;
  selected?: boolean;
}

const MISSIONS: Mission[] = [
  { icon: 'cargo', title: 'Courier · Teller Yards', faction: 'Ledgerline Mutual', tone: 'assembly', tags: [{ label: 'Rush', tone: 'ember', solid: true }, { label: '6 t' }, { label: 'Δv 3.4 km/s' }], reward: 18400, due: '2d 04h', selected: true },
  { icon: 'food', title: 'Grain relief · Tallow', faction: 'The Quorum Delegacy', tone: 'assembly', tags: [{ label: 'Famine', tone: 'red' }, { label: '24 t' }, { label: '1 jump' }], reward: 41200, due: '6d 12h' },
  { icon: 'survey', title: 'Orbital survey · Docket', faction: 'Chancel Audit Office', tone: 'assembly', tags: [{ label: 'Scanner', tone: 'ion' }, { label: 'Δv 5.1 km/s' }], reward: 12750, due: '9d 00h' },
  { icon: 'target', title: 'Bounty · Vex Corrigan', faction: 'The Quorum Delegacy', tone: 'assembly', tags: [{ label: 'Combat', tone: 'red' }, { label: 'Scorch clan', tone: 'outlaw' }], reward: 56000, due: '4d 08h' },
  { icon: 'scoop', title: 'Hydrogen run · Plenary', faction: 'Plenary Free Skimmers', tone: 'independent', tags: [{ label: 'Scoop', tone: 'ion' }, { label: '12 t' }], reward: 9600, due: '3d 16h' },
  { icon: 'repair', title: 'Tug recovery · Rider', faction: 'Teller Shipwrights’ Lodge', tone: 'independent', tags: [{ label: 'Rendezvous' }, { label: 'Δv 2.2 km/s' }], reward: 22300, due: '5d 02h' },
  { icon: 'scanner', title: 'Relay repair · Recess', faction: 'Chancel Audit Office', tone: 'assembly', tags: [{ label: 'Satellite' }, { label: 'Δv 6.8 km/s', tone: 'red' }], reward: 31900, due: '8d 20h' },
];

function missionSheet(): ReturnType<typeof BottomSheet> {
  const body = [
    h('p.tl-body', null, 'Six tonnes of sealed claim files for the Shipwrights’ Lodge arbitration. They must clear customs at Teller Yards before the hearing opens. The seals are bonded — and while you carry them, so are you.'),
    KeyValue({ cols: 3, items: [
      { k: 'Reward', v: '18,400', unit: 'cr', tone: 'ember' }, { k: 'Deadline', v: '2d 04h' }, { k: 'Cargo', v: '6', unit: 't' },
      { k: 'Transfer', v: '14h 20m' }, { k: 'Window', v: '38m', tone: 'ion' }, { k: 'Risk', v: 'Low', tone: 'green' },
    ] }).el,
    Gauge({ label: 'Δv · need vs have', icon: 'node', value: 4.82, max: 6, mark: 3.42, text: '3.42 / 4.82', unit: 'km/s', tone: 'green' }).el,
    Panel({ title: 'On completion', tone: 'ion', tight: true },
      KeyValue({ layout: 'rows', items: [
        { k: 'Ledgerline Mutual · standing', v: delta(4, { format: (a) => a.toFixed(0) }) },
        { k: 'Ledgerline Mutual · influence', v: delta(0.012, { format: (a) => (a * 100).toFixed(1) }) },
        { k: 'Chancel Audit Office · influence', v: delta(-0.008, { format: (a) => (a * 100).toFixed(1) }) },
      ] }).el).el,
  ];
  return BottomSheet({
    eyebrow: 'Courier contract · Ledgerline Mutual', title: 'Bonded files for Teller Yards', tone: 'assembly',
    headExtra: h('div.hx-wrap', { style: 'margin-top:6px;gap:6px' },
      Badge({ label: 'Assembly', tone: 'assembly', icon: 'powerAssembly' }).el, Badge({ label: 'Rush', tone: 'ember', solid: true }).el, Badge({ label: 'Lawful', tone: 'green', dot: true }).el),
    body,
    footer: [Button({ label: 'Decline', variant: 'ghost', onTap: () => {} }).el, Button({ label: 'Accept contract', variant: 'primary', block: true, onTap: () => {} }).el],
  });
}

function pageMission(): void {
  const rows = MISSIONS.map((m) => {
    const dot = h('span.tl-influence__sw', { style: 'flex:none' });
    setTone(dot, m.tone);
    return ListRow({
      icon: m.icon, title: m.title, tone: m.selected ? 'ember' : 'ion', selected: m.selected,
      subtitle: [dot, h('span.tl-ellipsis', null, m.faction)],
      meta: m.tags.map((t) => Badge({ label: t.label, tone: t.tone ?? 'neutral', solid: t.solid }).el),
      value: `${fmt(m.reward)} cr`,
      note: h('span.tl-delta', null, icon('time', 12), m.due),
      onTap: () => {},
    });
  });
  const list = Panel({ flush: true }, List(rows).el);
  const bar = [
    Tabs({ value: 'open', items: [{ id: 'open', label: 'Available', count: 7 }, { id: 'active', label: 'Active', count: 2 }, { id: 'done', label: 'History' }, { id: 'rep', label: 'Standing' }] }).el,
    h('div', { style: 'padding-top:6px' }, Chips({ value: null, items: [
      { id: 'courier', label: 'Courier', icon: 'cargo' }, { id: 'supply', label: 'Supply', icon: 'market' }, { id: 'survey', label: 'Survey', icon: 'survey' },
      { id: 'bounty', label: 'Bounty', icon: 'target' }, { id: 'rescue', label: 'Rescue', icon: 'repair' },
    ] }).el),
  ];
  const screen = Screen({ header: ScreenHeader({ title: 'Missions', location: 'The Rotunda · Chancel', onBack: () => {}, credits: 48250 }), bar, body: list.el });
  root.appendChild(screen.el);
  if (q.get('sheet') !== '0') missionSheet().open();
  else staggerIn(list.body.firstElementChild!);
  scrollTo(screen.body);
}

// ------------------------------------------------------------------ page: faction

interface Faction {
  id: string;
  name: string;
  short: string;
  gov: string;
  power: 'assembly' | null;
  color: string;
  inf: number;
  d: number;
  ctrl?: boolean;
  states: { label: string; tone: ToneOrColor }[];
  standing: string;
  standingTone: ToneOrColor;
  drift: number;
}

const FACTIONS: Faction[] = [
  { id: 'delegacy', name: 'The Quorum Delegacy', short: 'Quorum Delegacy', gov: 'Democracy', power: 'assembly', color: '#3fd0c9', inf: 0.386, d: -0.014, ctrl: true, states: [{ label: 'Election', tone: 'ion' }], standing: 'Friendly', standingTone: 'green', drift: -0.05 },
  { id: 'audit', name: 'Chancel Audit Office', short: 'Audit Office', gov: 'Technocracy', power: 'assembly', color: '#7fb2ff', inf: 0.241, d: 0.021, states: [{ label: 'Election', tone: 'ion' }], standing: 'Neutral', standingTone: 'neutral', drift: 0.09 },
  { id: 'ledgerline', name: 'Ledgerline Mutual', short: 'Ledgerline Mutual', gov: 'Corporate', power: 'assembly', color: '#e0c27a', inf: 0.198, d: 0.004, states: [{ label: 'Boom', tone: 'green' }], standing: 'Allied', standingTone: 'green', drift: 0.02 },
  { id: 'lodge', name: 'Teller Shipwrights’ Lodge', short: 'Shipwrights’ Lodge', gov: 'Cooperative', power: null, color: '#e58fb1', inf: 0.102, d: -0.006, states: [{ label: 'Strike', tone: 'ember' }], standing: 'Neutral', standingTone: 'neutral', drift: -0.03 },
  { id: 'skimmers', name: 'Plenary Free Skimmers', short: 'Free Skimmers', gov: 'Confederacy', power: null, color: '#8a97a6', inf: 0.073, d: -0.005, states: [], standing: 'Wary', standingTone: 'ember', drift: -0.02 },
];

function pageFaction(): void {
  const hist = FACTIONS.map((f, i) => series(30, f.inf * 100, 1.1, f.drift * 3, 40 + i));
  const influence = Panel({ title: 'Influence', code: 'Day 412', icon: 'factions' },
    StackedInfluenceBar({ scale: true, segments: FACTIONS.map((f) => ({ id: f.id, label: f.short, value: f.inf, color: f.color, delta: f.d, controlling: f.ctrl })) }).el);
  const history = Panel({ title: 'Last 30 days', code: '% share', icon: 'trendUp', tone: 'ion' },
    LineChart({ height: landscape ? 128 : 150, series: FACTIONS.map((f, i) => ({ values: hist[i], color: f.color, muted: i > 2 })), xLabels: ['−30 d', '−20 d', '−10 d', 'Now'], yFormat: (v) => `${v.toFixed(0)}`, markers: [{ index: 22, label: 'Election called', tone: 'ion' }], ariaLabel: 'Influence history' }).el,
    Legend(FACTIONS.map((f) => ({ label: f.short, color: f.color }))));
  const dayCells = ['#3fd0c9', '#7fb2ff', '#3fd0c9', '', ''].map((c) => h('i', { style: c ? `background:${c}` : null as never }));
  const side = (f: Faction, score: number, right: boolean): HTMLElement => {
    const el = h('div.hx-versus__side', { class: right && 'hx-versus__side--r' }, h('span.hx-versus__score.tl-num', { text: score }), h('span.hx-versus__name', { text: f.short }));
    setTone(el, f.color);
    return el;
  };
  const conflict = Panel({ title: 'Election', code: 'Day 3 of 5', icon: 'legal', tone: 'ion', accent: true },
    h('div.hx-versus', null, side(FACTIONS[0], 2, false), h('span.tl-label', null, 'vs'), side(FACTIONS[1], 1, true)),
    h('div.hx-days', null, dayCells),
    h('p.tl-small', null, 'Control of The Rotunda is at stake. Missions and trade for either side move the count. Polls close in 2d 06h.'));
  const factions = Panel({ title: 'Factions', code: '5 present', icon: 'station', flush: true },
    List(FACTIONS.map((f, i) => ListRow({
      icon: f.power ? 'powerAssembly' : 'factions', tone: f.color, title: f.name,
      subtitle: `${f.gov} · ${f.power ? 'Meridian Assembly' : 'Independent'}`,
      meta: [...f.states.map((s) => Badge({ label: s.label, tone: s.tone, dot: true }).el), f.ctrl ? Badge({ label: 'Control', tone: 'neutral' }).el : null, Badge({ label: f.standing, tone: f.standingTone, plain: true, dot: true }).el],
      value: `${(f.inf * 100).toFixed(1)}%`,
      note: Sparkline({ values: hist[i], width: 56, height: 18, tone: f.color }).el,
      onTap: () => {},
    }))).el);
  const ptile = (tone: 'assembly' | 'hegemony' | 'league', ic: IconName, name: string, n: number): HTMLElement => {
    const el = h('div.hx-ptile', null,
      h('div.hx-ptile__top', null, icon(ic, 28), h('div', null, h('div.hx-ptile__n.tl-num', { text: n }), h('div.tl-label', { style: 'margin-top:3px' }, 'systems'))),
      h('div.tl-label', { style: 'color:var(--tl-text)' }, name),
      ProgressBar({ value: n / 24, tone }).el);
    setTone(el, tone);
    return el;
  };
  const powers = Panel({ title: 'Powers in the Reach', code: '24 systems', icon: 'map' },
    h('div.hx-powers', null, ptile('assembly', 'powerAssembly', 'Assembly', 9), ptile('hegemony', 'powerHegemony', 'Hegemony', 8), ptile('league', 'powerLeague', 'League', 5)));
  const a = h('div.hx-col', null, influence.el, conflict.el, landscape ? powers.el : null);
  const b = h('div.hx-col', null, history.el, factions.el, landscape ? null : powers.el);
  const screen = Screen({
    header: ScreenHeader({ title: 'Politics', location: 'Chancel · Assembly space', locationIcon: 'planet', onBack: () => {},
      readouts: [{ label: 'Security', value: 'High', tone: 'green' }, { label: 'Population', value: '38.4 M' }] }),
    body: h('div.hx-cols', null, a, b),
  });
  root.appendChild(screen.el);
  scrollTo(screen.body);
}

// ------------------------------------------------------------------ page: hud bits

function paintSpace(canvas: HTMLCanvasElement): void {
  const w = window.innerWidth;
  const hgt = window.innerHeight;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = w * dpr;
  canvas.height = hgt * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#020305';
  ctx.fillRect(0, 0, w, hgt);
  const r = rng(71);
  for (let i = 0; i < (w * hgt) / 700; i++) {
    const m = Math.pow(r(), 3);
    ctx.fillStyle = `rgba(${r() > 0.8 ? '255,210,170' : '225,235,255'}, ${0.15 + m * 0.8})`;
    ctx.beginPath();
    ctx.arc(r() * w, r() * hgt, 0.3 + m * 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
  // A tidally locked world: lit from the upper left, night side toward us.
  const R = Math.max(w, hgt) * 0.62;
  const cx = landscape ? w * 0.56 : w * 0.78;
  const cy = landscape ? hgt * 0.5 + R * 0.86 : hgt * 0.5 + R * 0.42;
  const halo = ctx.createRadialGradient(cx, cy, R * 0.985, cx, cy, R * 1.06);
  halo.addColorStop(0, 'rgba(255, 150, 80, 0.5)');
  halo.addColorStop(0.35, 'rgba(255, 120, 60, 0.14)');
  halo.addColorStop(1, 'rgba(255, 120, 60, 0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 1.06, 0, Math.PI * 2);
  ctx.fill();
  const lx = cx - R * 0.92;
  const ly = cy - R * 0.74;
  const body = ctx.createRadialGradient(lx, ly, R * 0.05, lx, ly, R * 1.02);
  body.addColorStop(0, '#f0b074');
  body.addColorStop(0.2, '#b8683a');
  body.addColorStop(0.42, '#4a2418');
  body.addColorStop(0.6, '#0d0a0c');
  body.addColorStop(1, '#030407');
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fill();
}

function pageHudbits(): void {
  const space = h('canvas.hx-space');
  paintSpace(space);
  root.appendChild(space);
  const read = Panel({ tight: true, class: 'hx-hud__read' },
    KeyValue({ cols: 3, items: [
      { k: 'Altitude', v: '412.6', unit: 'km' }, { k: 'Orbital vel', v: '7.61', unit: 'km/s' }, { k: 'Δv', v: '4.82', unit: 'km/s', tone: 'ember' },
      { k: 'Apoapsis', v: '1,904', unit: 'km', tone: 'ion' }, { k: 'Periapsis', v: '398', unit: 'km', tone: 'ion' }, { k: 'Node in', v: '12m 40s', tone: 'ember' },
    ] }).el);
  read.el.style.gridArea = 'read';
  const stack = ToastStack(root);
  stack.push({ title: 'Burn complete', message: 'Apoapsis raised to 1,904 km · 212 m/s spent', tone: 'green', stamp: 'T+00:04', duration: 0 });
  stack.push({ title: 'Entering Quorum control zone', tone: 'ion', icon: 'station', stamp: 'NOW', duration: 0 });
  const rs = landscape ? 76 : 92;
  const gauges = Panel({ tight: true },
    h('div.hx-gauges', null,
      h('div.hx-gauges__radials', null,
        Gauge({ kind: 'radial', value: 64, max: 100, text: '64', unit: '%', label: 'Throttle', tone: 'ember', size: rs }).el,
        Gauge({ kind: 'radial', value: 412, max: 600, text: '412', unit: 'K', label: 'Heat', tone: 'ion', zone: [480, 600], size: rs }).el,
        Gauge({ kind: 'radial', value: 82, max: 100, text: '82', unit: '%', label: 'Power', tone: 'green', size: rs }).el),
      h('div.hx-gauges__bars', null,
        Gauge({ label: 'Propellant', icon: 'fuel', value: 0.68, text: '6.8', unit: 't', tone: 'ember' }).el,
        Gauge({ kind: 'segmented', label: 'Hull', icon: 'hull', value: 0.86, text: '86', unit: '%', tone: 'green', segments: 12 }).el,
        Gauge({ kind: 'segmented', label: 'Shield', icon: 'shield', value: 0.42, text: '42', unit: '%', tone: 'ion', segments: 12 }).el,
        landscape ? null : Gauge({ label: 'RCS', icon: 'rcs', value: 0.91, text: '91', unit: '%', tone: 'neutral' }).el)));
  gauges.el.style.gridArea = 'gauge';
  const sas = h('div.tl-row', { style: 'grid-area:sas' },
    h('div.tl-grow', null, SegmentedControl({ block: true, tone: 'ember', value: 'prograde', items: [
      { id: 'sas', icon: 'sas', ariaLabel: 'Stability' }, { id: 'prograde', icon: 'prograde', ariaLabel: 'Prograde' }, { id: 'retrograde', icon: 'retrograde', ariaLabel: 'Retrograde' },
      { id: 'normal', icon: 'normal', ariaLabel: 'Normal' }, { id: 'antinormal', icon: 'antinormal', ariaLabel: 'Anti-normal' }, { id: 'target', icon: 'target', ariaLabel: 'Target' }, { id: 'node', icon: 'node', ariaLabel: 'Manoeuvre' },
    ] }).el));
  sas.querySelector('.tl-seg')?.setAttribute('style', 'background:var(--tl-glass);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)');
  const comms = CommsMessage({
    name: 'Rotunda Control', role: 'Traffic · Quorum Delegacy', tone: 'assembly', glyph: 3, compact: true,
    lines: ['Wren seven-one, hold three metres per second inside the zone and take port M-04 on the dusk side.', 'Clamps engage on soft capture. Welcome to the Rotunda, Captain.'],
  });
  if (q.get('anim') !== '1') comms.next();
  comms.el.style.gridArea = 'comms';
  comms.el.style.alignSelf = 'end';
  const marker = (ic: IconName, tone: ToneOrColor, name: string, value: string, x: string, y: string): HTMLElement => {
    const el = h('div.hx-marker', { style: { left: x, top: y } }, icon(ic, 30), h('div.hx-marker__tag', null, h('b', null, name), h('span.tl-num', null, value)));
    setTone(el, tone);
    return el;
  };
  const spaceArea = h('div', { style: 'grid-area:space;position:relative;min-height:0' },
    marker('target', 'ion', 'Teller Yards', '1,204 km · 38 m/s', landscape ? '54%' : '34%', landscape ? '4%' : '18%'),
    marker('prograde', 'ember', 'Prograde', '7.61 km/s', landscape ? '14%' : '6%', landscape ? '30%' : '62%'));
  root.appendChild(h('div.hx-hud', null, read.el, stack.el, spaceArea, sas, gauges.el, comms.el));
}

// ------------------------------------------------------------------ page: icons

function pageIcons(): void {
  const power = (tone: 'assembly' | 'hegemony' | 'league', ic: IconName, name: string, note: string): HTMLElement => {
    const el = h('div.hx-power', null, icon(ic, 36), h('div', null, h('b', null, name), h('small', null, note)));
    setTone(el, tone);
    return el;
  };
  const marks = Panel({ title: 'Marks', code: 'ID' },
    h('div.hx-marks', null, logoMark(84), h('div.tl-col.tl-gap-3', null, wordmark(22), h('span.tl-label', null, 'Wordmark · emblem · app icon'))),
    h('div.tl-divider'),
    h('div.hx-marks', { style: 'gap:14px 26px' },
      power('assembly', 'powerAssembly', 'Meridian Assembly', 'Ring of members'), power('hegemony', 'powerHegemony', 'Auric Hegemony', 'Day-side sun'), power('league', 'powerLeague', 'Umbral League', 'Night-side crescent')),
    h('div.tl-divider'),
    h('div.tl-row.tl-row--between', null,
      h('div.hx-sizes', null, [16, 20, 24, 32, 44].map((s) => icon('orbit', s))),
      h('div.hx-sizes', { style: 'gap:12px' }, (['ember', 'ion', 'green', 'red'] as const).map((t) => {
        const i = icon('prograde', 24);
        i.style.color = `var(--tl-${t})`;
        return i;
      }))));
  const groups = ICON_GROUPS.map((g) => Panel({ title: g.title, code: String(g.names.length) },
    h('div.hx-icons', null, g.names.map((n) => h('div.hx-icon', null, icon(n, 24), h('span', null, n))))));
  const all = [marks, ...groups];
  const cols = [h('div.hx-col'), h('div.hx-col')];
  all.forEach((p, i) => cols[landscape ? i % 2 : 0].appendChild(p.el));
  const screen = Screen({
    header: ScreenHeader({ title: 'Iconography', location: 'Tidelock · design system', locationIcon: 'logo', onBack: () => {}, readouts: [{ label: 'Glyphs', value: String(ICON_GROUPS.reduce((n, g) => n + g.names.length, 0)) }] }),
    body: h('div.hx-cols', null, cols[0], landscape ? cols[1] : null),
  });
  root.appendChild(screen.el);
  scrollTo(screen.body);
}

// ------------------------------------------------------------------ page: splash

function pageSplash(): void {
  const splash = Splash({ status: 'Charting the Ember Reach', progress: 0.62, footer: 'Build 0.1 · 24 systems' });
  root.appendChild(splash.el);
  if (q.get('ready') === '1') splash.ready('Begin');
}

// ------------------------------------------------------------------ boot

const pages: Record<string, () => void> = { components: pageComponents, market: pageMarket, mission: pageMission, faction: pageFaction, hudbits: pageHudbits, icons: pageIcons, splash: pageSplash };
(pages[page] ?? pageComponents)();
const ready = (): void => {
  requestAnimationFrame(() => requestAnimationFrame(() => ((window as unknown as { __ready: boolean }).__ready = true)));
};
if (document.fonts && document.fonts.ready) document.fonts.ready.then(ready, ready);
else ready();
