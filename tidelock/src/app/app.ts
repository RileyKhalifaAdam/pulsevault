// TIDELOCK app shell: boot, the UiHost, screen flow and the main loop.
//
//   title -> station (docked) -> flight <-> map -> station, driven by the game's docked / undocked events.
//
// URL parameters: q=low|medium|high|ultra (quality for this run), fresh=1 (ignore the saved game).
import type { ShipVisualId } from '../core/types';
import { createPipeline, type Quality, type RenderPipeline } from '../render/pipeline';
import { createSceneManager, type SceneManager } from '../render/scene';
import { addShip, addStationExtra, beginFrame, createSceneFrame, setDockingGuide } from '../render/frame';
import { createGame, loadGame, type GameSim } from '../sim/game';
import { createRoot, Splash, ToastStack, type ToastStackApi } from '../ui/kit';
import type { UiHost, UiScreen } from '../ui/host';
import { createFlightScreen, type FlightScreen } from '../ui/hud/hud';
import { createMapScreen, createPauseMenu, createStationScreen, createTitleScreen } from './screens';
import { noteForReport, showFatal, showPlainMessage } from './errors';

const SAVE_KEY = 'tidelock.save.v1';
const SETTINGS_KEY = 'tidelock.settings.v1';
const QUALITIES: Quality[] = ['low', 'medium', 'high', 'ultra'];
const SHIP_VISUALS: string[] = ['wren', 'drover', 'magpie', 'shrike', 'albatross', 'caravel', 'halberd'];
type ScreenName = 'title' | 'station' | 'flight' | 'map';

// ------------------------------------------------------------------------------------------------ storage (guarded)

function lsGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function hasWebGL2(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

export async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const bootEl = document.getElementById('boot');

  if (!hasWebGL2()) {
    bootEl?.remove();
    showPlainMessage('Graphics unavailable', 'TIDELOCK needs WebGL 2, which this browser or viewer did not provide. Try opening the page in Safari, or turn off Lockdown Mode / low-power restrictions for this page.');
    (window as unknown as { __ready: boolean }).__ready = true;
    return;
  }

  // ---------------------------------------------------------------------------------------------- settings
  let settingsData: Record<string, unknown> = {};
  try {
    const raw = lsGet(SETTINGS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') settingsData = parsed as Record<string, unknown>;
  } catch {
    settingsData = {};
  }
  const asQuality = (v: unknown): Quality | null => (typeof v === 'string' && (QUALITIES as string[]).includes(v) ? (v as Quality) : null);
  const urlQuality = asQuality(params.get('q') ?? params.get('quality'));
  let quality: Quality = urlQuality ?? asQuality(settingsData.quality) ?? 'medium';
  if (settingsData.quality === undefined) settingsData.quality = quality; // screens read the effective tier
  noteForReport(`quality ${quality}`);

  // ---------------------------------------------------------------------------------------------- canvas, pipeline, scene
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;display:block;touch-action:none;';
  document.body.appendChild(canvas);
  const root = createRoot(document.body, { fixed: true, passthrough: true, fx: quality === 'low' ? 'lite' : 'full' });
  root.style.touchAction = 'none';

  const pipeline: RenderPipeline = createPipeline(canvas, { quality });
  const viewSize = (): { w: number; h: number } => {
    const w = Math.max(1, Math.round(document.documentElement.clientWidth || window.innerWidth));
    const hgt = Math.max(1, Math.round(document.documentElement.clientHeight || window.innerHeight));
    return { w, h: hgt };
  };
  let lastW = 0;
  let lastH = 0;
  const layout = (): void => {
    const { w, h } = viewSize();
    if (w === lastW && h === lastH) return;
    lastW = w;
    lastH = h;
    pipeline.resize(w, h, Math.min(window.devicePixelRatio || 1, 2));
    canvas.style.width = '100%';
    canvas.style.height = '100%';
  };
  layout();
  window.addEventListener('resize', layout);
  window.addEventListener('orientationchange', () => setTimeout(layout, 60));
  try {
    window.visualViewport?.addEventListener('resize', layout);
  } catch {
    /* ignore */
  }

  const scene: SceneManager = createSceneManager(pipeline, { quality });

  // iOS: never rubber-band, pinch-zoom or double-tap zoom. Scrollable lists opt out by scrolling themselves.
  const scrollable = (t: EventTarget | null): boolean => {
    let n = t instanceof Element ? t : null;
    while (n && n !== document.body) {
      if (n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1) {
        const cs = getComputedStyle(n);
        if (/(auto|scroll)/.test(cs.overflowY) || /(auto|scroll)/.test(cs.overflowX)) return true;
      }
      n = n.parentElement;
    }
    return false;
  };
  document.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1 || !scrollable(e.target)) e.preventDefault();
  }, { passive: false });
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault());
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------------------------------------------------------------------------------------------- game + host
  const fresh = params.get('fresh') === '1';
  const readSave = (): GameSim | null => {
    const raw = lsGet(SAVE_KEY);
    if (!raw) return null;
    try {
      return loadGame(raw);
    } catch {
      return null;
    }
  };
  let toasts: ToastStackApi | null = null;
  let current: ScreenName | null = null;
  let pauseOpen = false;
  let sinceSave = 0;
  let unbind: (() => void)[] = [];
  const screens = {} as Record<ScreenName, UiScreen>;
  let pause: UiScreen | null = null;
  const TONE = { info: 'ion', good: 'green', warn: 'ember', bad: 'red' } as const;

  const host: UiHost = {
    game: (fresh ? null : readSave()) ?? createGame({ seed: 1 }),
    root,
    go(name) {
      if (pauseOpen) {
        pauseOpen = false;
        pause?.hide();
      }
      if (current === name) return;
      if (current) screens[current].hide();
      current = name;
      noteForReport(`screen ${name}`);
      const s = screens[name];
      s.show();
      if (!s.el.isConnected) root.appendChild(s.el);
    },
    newGame() {
      host.game = createGame({ seed: 1 });
      bindGame();
      current = current === 'station' ? null : current;
      host.go(host.game.shipPose().docked ? 'station' : 'flight');
      host.saveNow();
    },
    continueGame() {
      const g = readSave();
      if (!g) return false;
      host.game = g;
      bindGame();
      host.go(g.shipPose().docked ? 'station' : 'flight');
      return true;
    },
    hasSave: () => !!lsGet(SAVE_KEY),
    saveNow() {
      sinceSave = 0;
      try {
        lsSet(SAVE_KEY, host.game.save());
      } catch (err) {
        noteForReport(`save failed: ${String(err)}`);
      }
    },
    sfx() {
      /* audio is not in this build */
    },
    settings: {
      get<T>(key: string, fallback: T): T {
        const v = settingsData[key];
        return v === undefined || v === null ? fallback : (v as T);
      },
      set(key, value) {
        settingsData[key] = value;
        try {
          lsSet(SETTINGS_KEY, JSON.stringify(settingsData));
        } catch {
          /* ignore */
        }
        if (key === 'quality') {
          const q = asQuality(value);
          if (q && q !== quality) {
            quality = q;
            root.dataset.fx = q === 'low' ? 'lite' : 'full';
            scene.setQuality(q).catch((err) => showFatal(err, 'quality'));
          }
        }
      },
    },
    toast(message, kind = 'info') {
      if (!message) return;
      try {
        toasts ??= ToastStack(root);
        toasts.push({ title: message, tone: TONE[kind] ?? 'ion', duration: kind === 'bad' ? 7000 : 3800 });
      } catch {
        /* a toast must never break the game */
      }
    },
  };

  function bindGame(): void {
    for (const off of unbind) off();
    const ev = host.game.events;
    unbind = [
      ev.on('docked', () => {
        host.saveNow();
        host.go('station');
      }),
      ev.on('undocked', () => host.go('flight')),
      ev.on('rebought', () => {
        host.saveNow();
        host.go(host.game.shipPose().docked ? 'station' : 'flight');
      }),
      ev.on('destroyed', (e) => {
        host.toast(`Ship destroyed (${e.cause})`, 'bad');
        if (current === 'map') host.go('flight');
      }),
      ev.on('toast', (e) => host.toast(e.message, e.kind === 'danger' ? 'bad' : e.kind)),
      ev.on('fault', (e) => {
        noteForReport(`fault ${e.where}: ${e.message}`);
        host.toast(`Fault in ${e.where}: ${e.message}`, 'bad');
      }),
    ];
  }
  bindGame();

  // ---------------------------------------------------------------------------------------------- loading
  const splash = Splash({ status: 'Charting the Tallow system', progress: 0, footer: 'Loading — this takes a few seconds' });
  root.appendChild(splash.el);
  bootEl?.remove();
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  await scene.setSystem(host.game.system, host.game.model, (f, label) => splash.update({ progress: f, status: label || 'Loading' }), { nearBodyId: host.game.shipPose().soiBodyId });
  splash.update({ progress: 1, status: 'Ready' });

  // ---------------------------------------------------------------------------------------------- screens
  const openPause = (): void => {
    if (!pause || pauseOpen) return;
    pauseOpen = true;
    pause.show();
    if (!pause.el.isConnected) root.appendChild(pause.el);
  };
  const flight: FlightScreen = createFlightScreen(host, scene, { pause: openPause });
  screens.flight = flight;
  screens.title = createTitleScreen(host);
  screens.station = createStationScreen(host);
  screens.map = createMapScreen(host);
  pause = createPauseMenu(host);

  // ---------------------------------------------------------------------------------------------- frame
  const frame = createSceneFrame();
  let dockYaw = 0.6;
  let lost = false;
  pipeline.onContextLost = () => {
    lost = true;
  };
  pipeline.onContextRestored = () => {
    scene.rebuild().then(() => {
      lost = false;
      lastW = lastH = 0;
      layout();
    }, (err) => showFatal(err, 'context restore'));
  };

  const fill = (dt: number): void => {
    const game = host.game;
    const pose = game.shipPose();
    beginFrame(frame, game.time(), dt, game.warp().level);
    const s = addShip(frame);
    const shipId = game.player().shipId;
    s.id = 'player';
    s.visualId = (SHIP_VISUALS.includes(shipId) ? shipId : 'wren') as ShipVisualId;
    s.seed = 7;
    s.soiBodyId = pose.soiBodyId;
    s.r.x = pose.r.x; s.r.y = pose.r.y; s.r.z = pose.r.z;
    s.v.x = pose.v.x; s.v.y = pose.v.y; s.v.z = pose.v.z;
    s.q.x = pose.q.x; s.q.y = pose.q.y; s.q.z = pose.q.z; s.q.w = pose.q.w;
    s.throttle = pose.throttle;
    s.rcs.x = pose.rcs.x; s.rcs.y = pose.rcs.y; s.rcs.z = pose.rcs.z;
    s.heat = Math.min(1, Math.max(0, pose.heat));
    s.damage = pose.destroyed ? 1 : 0;
    s.isPlayer = true;
    s.lightsOn = !pose.destroyed;
    const cam = frame.camera;
    cam.focusId = 'player';
    cam.lookAtId = null;
    const d = game.dockingState();
    if (pose.docked) {
      // Dock camera: a slow turn around the berthed ship behind the station screen / title.
      dockYaw += dt * 0.02;
      cam.mode = 'orbit';
      cam.yaw = dockYaw;
      cam.pitch = 0.22;
      cam.distance = 2.2;
      setDockingGuide(frame, null);
    } else {
      const c = flight.controls.camera;
      cam.yaw = c.yaw;
      cam.pitch = c.pitch;
      cam.distance = c.distance;
      if (d.granted && d.stationId && d.portId) {
        addStationExtra(frame, d.stationId, d.portId);
        setDockingGuide(frame, d.stationId, d.portId);
        cam.mode = 'chase';
      } else {
        setDockingGuide(frame, null);
        cam.mode = 'chase';
      }
    }
  };

  let last = performance.now();
  let raf = 0;
  let failed = false;
  const tick = (now: number): void => {
    raf = requestAnimationFrame(tick);
    if (failed || document.hidden) {
      last = now;
      return;
    }
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    try {
      if (pauseOpen && pause && pause.el.getClientRects().length === 0) pauseOpen = false;
      const running = current !== 'title' && current !== null && !pauseOpen;
      if (running) {
        host.game.step(dt);
        sinceSave += dt;
        if (sinceSave >= 60) host.saveNow();
      }
      layout();
      if (!lost) {
        fill(dt);
        scene.render(frame);
      }
      if (current) screens[current].update(dt);
      if (pauseOpen) pause?.update(dt);
    } catch (err) {
      failed = true;
      cancelAnimationFrame(raf);
      showFatal(err, 'frame');
    }
  };

  const onHide = (): void => {
    if (current && current !== 'title') host.saveNow();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) onHide();
    else last = performance.now();
  });
  window.addEventListener('pagehide', onHide);

  // First frames behind the splash, then the title over the live scene.
  fill(0);
  scene.render(frame);
  host.go('title');
  raf = requestAnimationFrame(tick);
  await splash.dismiss().catch(() => splash.destroy());
  const w = window as unknown as { __tidelock: unknown; __ready: boolean };
  w.__tidelock = {
    get game() { return host.game; },
    host,
    scene,
    pipeline,
    get screen() { return current; },
    frame,
  };
  w.__ready = true;
}
