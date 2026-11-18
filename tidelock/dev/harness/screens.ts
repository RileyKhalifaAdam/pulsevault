// Screens harness: one screen of src/ui/screens against a real game, on a dark stand-in for the 3D scene.
//
//   dev/screens.html?screen=title|station|map|pause
//     &tab=market|ship|departures   (station)      &trade=<commodityId>  open the trade sheet (station)
//     &cargo=1                      buy a little cargo first               &save=1  pretend a save exists (title)
//     &flight=1                     undock and coast 30 s (map)            &plot=1  set Gloaming Lock as target and plot
//     &node=1                       select the first node (map)            &view=settings|help (pause)
//     &safe=0                       no simulated iPhone safe-area insets
import { createGame, type GameSim } from '../../src/sim/game';
import { toast } from '../../src/ui/kit';
import type { UiHost, UiScreen } from '../../src/ui/host';
import { createTitleScreen, createStationScreen, createMapScreen, createPauseMenu } from '../../src/ui/screens';

const q = new URLSearchParams(location.search);
const name = q.get('screen') ?? 'station';
const landscape = innerWidth > innerHeight;
const root = document.createElement('div');
root.style.cssText = 'position:fixed;inset:0;overflow:hidden;background:radial-gradient(60% 34% at 50% 46%, #31566b 0, #12222e 38%, #05070b 72%);';
document.body.appendChild(root);

let game: GameSim = createGame({ seed: 1 });
const store = new Map<string, unknown>();
let current: UiScreen | null = null;
const screens: Record<string, UiScreen> = {};
const host: UiHost = {
  get game() { return game; },
  set game(g) { game = g; },
  root,
  go(s) {
    console.log('go', s);
    current?.hide();
    current = screens[s] ?? null;
    current?.show();
  },
  newGame() { game = createGame({ seed: 1 }); },
  continueGame: () => true,
  hasSave: () => q.get('save') === '1',
  saveNow() { game.save(); },
  sfx() {},
  settings: { get: <T>(k: string, f: T): T => (store.has(k) ? (store.get(k) as T) : f), set: (k, v) => { store.set(k, v); } },
  toast(message, kind = 'info') { toast({ title: message, tone: kind === 'good' ? 'green' : kind === 'bad' ? 'red' : kind === 'warn' ? 'ember' : 'ion' }, current?.el ?? root); },
};

const GLOAMING = 'tallow.st.gloaming-lock';
if (q.get('cargo') === '1') { game.buy('duskwine', 2); game.buy('fertiliser', 3); }
if (q.get('flight') === '1' || q.get('plot') === '1') {
  game.undock();
  for (let i = 0; i < 900; i++) game.step(1 / 30);
}
if (q.get('plot') === '1') { game.setTarget({ kind: 'station', id: GLOAMING }); console.log(JSON.stringify(game.plan('toTarget'))); }

screens.title = createTitleScreen(host);
screens.station = createStationScreen(host);
screens.map = createMapScreen(host);
const pause = createPauseMenu(host);
if (q.get('safe') !== '0') {
  for (const s of [...Object.values(screens), pause]) {
    const st = s.el.style;
    if (landscape) { st.setProperty('--tl-safe-l', '59px'); st.setProperty('--tl-safe-r', '59px'); st.setProperty('--tl-safe-b', '21px'); }
    else { st.setProperty('--tl-safe-t', '59px'); st.setProperty('--tl-safe-b', '34px'); }
  }
}
if (name === 'pause') {
  host.go(game.dockedStation() ? 'station' : 'map');
  pause.open((q.get('view') as 'menu' | 'settings' | 'help' | null) ?? 'menu');
} else host.go(name as 'title' | 'station' | 'map');

Object.assign(window, { __game: () => game, __host: host, __screens: screens, __pause: pause });

let last = performance.now();
let frames = 0;
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  game.step(dt);
  current?.update(dt);
  if (++frames === 3) {
    const tab = q.get('tab');
    if (tab) (document.querySelectorAll('.tl-tab')[tab === 'ship' ? 1 : tab === 'departures' ? 2 : 0] as HTMLElement | undefined)?.click();
    const trade = q.get('trade');
    if (trade) (document.querySelectorAll('.tls-mrow')[Number(trade) || 0] as HTMLElement | undefined)?.click();
  }
  if (frames === 12) (window as unknown as { __ready: boolean }).__ready = true;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
