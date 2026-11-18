// TIDELOCK app shell: boot, the UiHost, screen flow, the main loop and its performance record.
//
//   title -> flight <-> map, with the pause menu and the perf overlay above. The client talks to the Session
//   contract (src/game) and nothing else; the scene draws the world's state as the session reports it.
//
// URL parameters: q=low|medium|high|ultra (pin the quality tier for this run), fresh=1 (ignore the saved flight),
// perf=1 (open the perf overlay).
import { createPipeline, type Quality, type RenderPipeline } from '../render/pipeline';
import { createSceneManager, type SceneManager } from '../render/scene';
import { addStationExtra, beginFrame, createSceneFrame, setDockingGuide } from '../render/frame';
import { createSession, loadSession, type Session } from '../game';
import { createRoot, Splash, ToastStack, type ToastStackApi } from '../ui/kit';
import type { UiHost, UiScreen } from '../ui/host';
import { createFlightScreen, type FlightScreen } from '../ui/hud/hud';
import { createMapScreen, createPauseMenu, createTitleScreen } from '../ui/screens';
import { createPerfOverlay } from '../ui/perfOverlay';
import { fmtSpeed } from '../core/units';
import { PerfMonitor } from './perf';
import { noteForReport, showFatal, showPlainMessage } from './errors';

const SAVE_KEY = 'tidelock.save.v1';
const SETTINGS_KEY = 'tidelock.settings.v1';
const QUALITIES: Quality[] = ['low', 'medium', 'high', 'ultra'];
type ScreenName = 'title' | 'flight' | 'map';

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
  // Quality: the URL pins a tier; a tier chosen in settings pins it too; otherwise ('auto') start at a safe tier
  // (medium on phones) and let the frame-time record move the resolution scale first, then the tier.
  const urlQuality = asQuality(params.get('q') ?? params.get('quality'));
  const phone = (() => {
    try {
      return window.matchMedia('(pointer: coarse)').matches || /iPhone|iPad|Android|Mobile/i.test(navigator.userAgent);
    } catch {
      return true;
    }
  })();
  const autoStart: Quality = phone ? 'medium' : 'high';
  const chosen = asQuality(settingsData.quality);
  let quality: Quality = urlQuality ?? chosen ?? autoStart;
  if (settingsData.quality === undefined) settingsData.quality = 'auto';
  const perf = new PerfMonitor(quality);
  perf.autoTier = !urlQuality && !chosen;
  noteForReport(`quality ${quality}${perf.autoTier ? ' (auto)' : ''}`);

  // ---------------------------------------------------------------------------------------------- canvas, pipeline, scene
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;display:block;touch-action:none;';
  document.body.appendChild(canvas);
  const root = createRoot(document.body, { fixed: true, passthrough: true, fx: quality === 'low' ? 'lite' : 'full' });
  root.style.touchAction = 'none';

  const pipeline: RenderPipeline = createPipeline(canvas, { quality });
  pipeline.setDynamicResolution(false, perf.scale); // the app's own controller drives the scale (perf.ts)
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

  // ---------------------------------------------------------------------------------------------- session + host
  const fresh = params.get('fresh') === '1';
  const readSave = (): Session | null => {
    const raw = lsGet(SAVE_KEY);
    if (!raw) return null;
    try {
      return loadSession(raw);
    } catch {
      return null;
    }
  };
  let toasts: ToastStackApi | null = null;
  let current: ScreenName | null = null;
  let pauseOpen = false;
  let sinceSave = 0;
  const screens = {} as Record<ScreenName, UiScreen>;
  let pause: UiScreen | null = null;
  const TONE = { info: 'ion', good: 'green', warn: 'ember', bad: 'red' } as const;
  const session: Session = (fresh ? null : readSave()) ?? createSession({ seed: 1 });

  const applyTier = (q: Quality): void => {
    if (q === quality) return;
    quality = q;
    perf.tier = q;
    root.dataset.fx = q === 'low' ? 'lite' : 'full';
    perf.clear(8);
    scene.setQuality(q).catch((err) => showFatal(err, 'quality'));
  };

  const host: UiHost = {
    session,
    root,
    perf,
    perfVisible: () => overlay.visible(),
    setPerfVisible(on) {
      overlay.setVisible(on);
      host.settings.set('perfOverlay', on);
    },
    go(name) {
      if (pauseOpen) {
        pauseOpen = false;
        pause?.hide();
      }
      if (current === name) return;
      if (current) screens[current].hide();
      current = name;
      perf.clear(1); // each screen's frames are their own record
      noteForReport(`screen ${name}`);
      const s = screens[name];
      s.show();
      if (!s.el.isConnected) root.appendChild(s.el);
    },
    reset() {
      session.reset();
      host.saveNow();
      host.toast('Back in the starting orbit beside Chandler’s Wheel', 'good');
      if (current !== 'flight') host.go('flight');
    },
    saveNow() {
      sinceSave = 0;
      try {
        lsSet(SAVE_KEY, session.save());
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
        if (key === 'quality' && !urlQuality) {
          const q = asQuality(value);
          perf.autoTier = !q;
          perf.maxTier = q ?? autoStart;
          applyTier(q ?? autoStart);
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

  const craftName = (id: string): string => session.craft().find((c) => c.id === id)?.name ?? id;
  session.events.on('docked', (e) => {
    host.saveNow();
    host.toast(`Latched to ${craftName(e.stationId)}`, 'good');
  });
  session.events.on('undocked', (e) => host.toast(`Released from ${craftName(e.stationId)}`, 'info'));
  session.events.on('impact', (e) => host.toast(`Impact at ${fmtSpeed(e.speed)}`, 'warn'));
  session.events.on('destroyed', (e) => host.toast(`Ship destroyed (${e.cause})`, 'bad'));
  session.events.on('atmosphere', (e) => host.toast(e.entered ? 'Entering atmosphere' : 'Clear of the atmosphere', e.entered ? 'warn' : 'info'));

  // device lines for the performance report
  try {
    const gl = pipeline.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    perf.device = [`user agent: ${navigator.userAgent}`, `screen ${screen.width}×${screen.height} · pixel ratio ${window.devicePixelRatio}`, `WebGL renderer: ${gpu || 'not exposed'}`];
  } catch {
    perf.device = [`user agent: ${navigator.userAgent}`, 'WebGL renderer: not exposed'];
  }
  const overlay = createPerfOverlay(host, () => {
    const st = pipeline.stats();
    const w = session.warp();
    return [`view ${lastW}×${lastH} css px · internal ${st.width}×${st.height}`, `time acceleration asked ×${w.requested} achieved ×${w.achieved.toFixed(1)}${w.limitedBy ? ` (${w.limitedBy})` : ''}`, `screen ${current ?? '-'} · sim time ${session.time().toFixed(0)} s`];
  });
  if (params.get('perf') === '1' || settingsData.perfOverlay === true) overlay.setVisible(true);
  // three-finger tap toggles the overlay
  let tap3 = 0;
  document.addEventListener('touchstart', (e) => {
    tap3 = e.touches.length === 3 ? performance.now() : e.touches.length > 3 ? 0 : tap3;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (tap3 && e.touches.length === 0) {
      if (performance.now() - tap3 < 600) host.setPerfVisible(!overlay.visible());
      tap3 = 0;
    }
  }, { passive: true });

  // ---------------------------------------------------------------------------------------------- loading
  const splash = Splash({ status: 'Charting the Tallow system', progress: 0, footer: 'Loading — this takes a few seconds' });
  root.appendChild(splash.el);
  bootEl?.remove();
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  await scene.setSystem(session.system, (f, label) => splash.update({ progress: f, status: label || 'Loading' }), { nearBodyId: session.flight().primaryId });
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
  screens.map = createMapScreen(host);
  pause = createPauseMenu(host);

  // ---------------------------------------------------------------------------------------------- frame
  const frame = createSceneFrame();
  let titleYaw = 0.6;
  let lost = false;
  pipeline.onContextLost = () => {
    lost = true;
  };
  pipeline.onContextRestored = () => {
    scene.rebuild().then(() => {
      lost = false;
      lastW = lastH = 0;
      layout();
      perf.clear(4);
    }, (err) => showFatal(err, 'context restore'));
  };

  /** Refill the frame from the session: the world's bodies and craft as they are, plus the camera. */
  const fill = (dt: number): void => {
    beginFrame(frame, session.time(), dt, session.warp().achieved);
    frame.bodies = session.bodies();
    frame.craft = session.craft();
    const p = session.player();
    const cam = frame.camera;
    cam.focusId = p.craftId;
    cam.lookAtId = null;
    frame.environment.reentry = session.flight().situation === 'atmosphere' ? Math.min(1, Math.max(0, p.heat * 1.2)) : 0;
    const d = session.docking();
    if (current === 'title' || current === null) {
      // a slow turn around the ship behind the title
      titleYaw += dt * 0.03;
      cam.mode = 'orbit';
      cam.yaw = titleYaw;
      cam.pitch = 0.22;
      cam.distance = 2.2;
      setDockingGuide(frame, null);
      return;
    }
    const c = flight.controls.camera;
    cam.mode = 'chase';
    cam.yaw = c.yaw;
    cam.pitch = c.pitch;
    cam.distance = c.distance;
    if (!p.dockedTo && d.stationId && d.portId) {
      addStationExtra(frame, d.stationId, d.portId);
      setDockingGuide(frame, d.stationId, d.portId);
    } else setDockingGuide(frame, null);
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
    const frameMs = now - last;
    const dt = Math.min(0.1, Math.max(0, frameMs / 1000));
    last = now;
    try {
      if (pauseOpen && pause && pause.el.getClientRects().length === 0) pauseOpen = false;
      const running = current !== 'title' && current !== null && !pauseOpen;
      let simMs = 0;
      let steps = 0;
      if (running) {
        const info = session.step(dt);
        simMs = info.simMs;
        steps = info.steps;
        sinceSave += dt;
        if (sinceSave >= 60) host.saveNow();
      }
      layout();
      let renderMs = 0;
      if (!lost && current !== 'map') {
        const r0 = performance.now();
        fill(dt);
        scene.render(frame);
        renderMs = performance.now() - r0;
      }
      if (current) screens[current].update(dt);
      if (pauseOpen) pause?.update(dt);
      // the record, and the automatic quality it drives (not while baking, paused, or on the 2D map)
      if (running && current === 'flight' && !lost && !scene.busy()) {
        perf.record(frameMs, simMs, renderMs, steps);
        const ch = perf.auto(dt);
        if (ch) {
          pipeline.setDynamicResolution(false, ch.scale);
          if (ch.tier) applyTier(ch.tier);
          noteForReport(`auto quality: ${perf.snapshot().note}`);
        }
      } else if (running && current === 'map') perf.record(frameMs, simMs, 0, steps);
      if (overlay.visible()) {
        const ss = scene.stats();
        perf.setRender(ss.drawCalls, ss.triangles);
        overlay.update(dt);
      }
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
    session,
    perf,
    host,
    scene,
    pipeline,
    get screen() { return current; },
    frame,
  };
  w.__ready = true;
}
