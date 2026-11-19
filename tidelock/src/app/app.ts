// TIDELOCK app shell: boot, the main loop and its performance record.
//
// The game is first person only and has no flight UI: the frame is always the pilot's own eyes inside the ship
// (camera.mode 'interior' from Session.crew()), and the only inputs are the walk stick, the head and the hand on
// a physical control (src/app/input.ts). The title is one tap; a three-finger tap opens the system menu (reset,
// quality, sensitivity, performance overlay); a destroyed ship fades to black and starts again. The client
// talks to the Session contract (src/game) and nothing else.
//
// URL parameters: q=low|medium|high|ultra (pin the quality tier for this run), rt=off|low|medium|high (ray tracing
// for this run), fresh=1 (ignore the saved flight), perf=1 (open the perf overlay).
//
// Ray tracing (the menu's RT setting, saved as settings.rt): High by default — the owner's choice, ~30 fps — with
// a safety governor (perf.ts RtGovernor): p95 frame time over 40 ms for 3 s steps it down one notch (recorded in
// the performance report), never automatically above the owner's choice. While RT is medium or high the
// resolution controller works to a 33 ms budget instead of 16.7 ms.
import { createPipeline, type Quality, type RenderPipeline } from '../render/pipeline';
import { createSceneManager, type SceneManager } from '../render/scene';
import { addStationExtra, beginFrame, createSceneFrame, setDockingGuide } from '../render/frame';
import { createSession, loadSession, type Session } from '../game';
import { createRoot, Splash } from '../ui/kit';
import type { UiHost, UiScreen } from '../ui/host';
import { createPauseMenu, createTitleScreen, type PauseMenu } from '../ui/screens';
import { createPerfOverlay } from '../ui/perfOverlay';
import { PerfMonitor, RT_CHOICES, RT_DEFAULT, RtGovernor, frameBudgetFor, rtInfoText, renderInfo, startTier, type RtTier } from './perf';
import { noteForReport, showFatal, showPlainMessage } from './errors';
import { createInstrumentData, readInstruments } from '../render/space/instruments';
import { createPlayInput, type DevicePick, type PlayInput } from './input';

const SAVE_KEY = 'tidelock.save.v1';
const SETTINGS_KEY = 'tidelock.settings.v1';
const QUALITIES: Quality[] = ['low', 'medium', 'high', 'ultra'];
type ScreenName = 'title' | 'flight';
/** A wrecked ship: seconds of black before the restart. Asleep: how dark closed eyes are. */
const WRECK_SECONDS = 3.5;
const SLEEP_SHADE = 0.94;

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
  // ('high' on an iPhone 15, the target look) and let the frame-time record move the resolution scale first, then the tier.
  const urlQuality = asQuality(params.get('q') ?? params.get('quality'));
  const phone = (() => {
    try {
      return window.matchMedia('(pointer: coarse)').matches || /iPhone|iPad|Android|Mobile/i.test(navigator.userAgent);
    } catch {
      return true;
    }
  })();
  const autoStart: Quality = startTier(phone ? 'high' : 'ultra');
  const chosen = asQuality(settingsData.quality);
  let quality: Quality = urlQuality ?? chosen ?? autoStart;
  if (settingsData.quality === undefined) settingsData.quality = 'auto';
  const perf = new PerfMonitor(quality);
  perf.autoTier = !urlQuality && !chosen;
  noteForReport(`quality ${quality}${perf.autoTier ? ' (auto)' : ''}`);
  // ray tracing: the URL pins it for this run, else the saved choice, else High
  const asRt = (v: unknown): RtTier | null => (typeof v === 'string' && (RT_CHOICES as readonly string[]).includes(v) ? (v as RtTier) : null);
  const urlRt = asRt(params.get('rt'));
  const rtChoice: RtTier = urlRt ?? asRt(settingsData.rt) ?? RT_DEFAULT;
  if (settingsData.rt === undefined) settingsData.rt = rtChoice;
  const rtGov = new RtGovernor(rtChoice);
  perf.budgetMs = frameBudgetFor('off'); // 33 ms only while traced frames are drawn (the frame loop)
  noteForReport(`ray tracing ${rtChoice}`);

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
  scene.setRayTracing(rtChoice); // before the system loads: the BVH and its programs are built behind the loading bar
  const applyRt = (t: RtTier, why: string): void => {
    scene.setRayTracing(t);
    perf.budgetMs = frameBudgetFor(t);
    perf.clear(4);
    noteForReport(`ray tracing ${t} (${why})`);
  };

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
  let current: ScreenName | null = null;
  let menuOpen = false;
  let sinceSave = 0;
  let title: UiScreen | null = null;
  let menu: PauseMenu | null = null;
  let input: PlayInput | null = null;
  const session: Session = (fresh ? null : readSave()) ?? createSession({ seed: 1 });

  const applyTier = (q: Quality): void => {
    if (q === quality) return;
    quality = q;
    perf.tier = q;
    root.dataset.fx = q === 'low' ? 'lite' : 'full';
    perf.clear(8);
    scene.setQuality(q).catch((err) => showFatal(err, 'quality'));
  };

  const closeMenu = (): void => {
    if (!menuOpen) return;
    menuOpen = false;
    menu?.hide();
    input?.setActive(current === 'flight');
  };
  const openMenu = (): void => {
    if (!menu || menuOpen || current !== 'flight') return;
    menuOpen = true;
    input?.setActive(false);
    host.saveNow();
    menu.show();
    if (!menu.el.isConnected) root.appendChild(menu.el);
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
      closeMenu();
      if (current === name) return;
      if (name === 'flight' && current === 'title') titleOut = TITLE_FADE;
      current = name;
      perf.clear(1); // each screen's frames are their own record
      noteForReport(`screen ${name}`);
      if (name === 'title') {
        titleOut = 0;
        title?.show();
        if (title && !title.el.isConnected) root.appendChild(title.el);
      } else title?.hide();
      input?.setActive(name === 'flight');
    },
    reset() {
      session.reset();
      host.saveNow();
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
        if (key === 'rt') {
          const t = asRt(value) ?? RT_DEFAULT;
          rtGov.choose(t);
          applyRt(t, 'menu');
        }
        if (key === 'quality' && !urlQuality) {
          const q = asQuality(value);
          perf.autoTier = !q;
          perf.maxTier = q ?? autoStart;
          applyTier(q ?? autoStart);
        }
      },
    },
    toast() {
      /* nothing is written over the view: what happened is on the console screens and out of the windows */
    },
  };

  session.events.on('docked', () => host.saveNow());
  session.events.on('crewMode', () => host.saveNow());
  session.events.on('sleep', (e) => {
    if (!e.asleep) host.saveNow();
  });
  session.events.on('destroyed', (e) => noteForReport(`ship destroyed (${e.cause})`));

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
    const ri = scene.rayTracing();
    return [
      `view ${lastW}×${lastH} css px · internal ${st.width}×${st.height}`,
      `time acceleration asked ×${w.requested} achieved ×${w.achieved.toFixed(1)}${w.limitedBy ? ` (${w.limitedBy})` : ''}`,
      `screen ${current ?? '-'} · sim time ${session.time().toFixed(0)} s`,
      `ray tracing: chosen ${rtGov.choice} · in effect ${rtGov.tier} · ${rtInfoText()} · BVH ${ri.triangles} tris built in ${ri.buildMs.toFixed(0)} ms${ri.disabled ? ` · off: ${ri.disabled}` : ''}`,
      rtGov.note ? `ray tracing governor: ${rtGov.note}` : 'ray tracing governor: no change',
      `GPU memory est: textures ${(renderInfo.textureBytes / 1048576).toFixed(0)} MB + targets ${(renderInfo.targetBytes / 1048576).toFixed(0)} MB + ray tracer ${(renderInfo.rtBytes / 1048576).toFixed(0)} MB = ${(renderInfo.totalBytes / 1048576).toFixed(0)} MB`,
    ];
  });
  if (params.get('perf') === '1' || settingsData.perfOverlay === true) overlay.setVisible(true);

  // ---------------------------------------------------------------------------------------------- loading
  const splash = Splash({ status: 'Charting the Tallow system', progress: 0, footer: 'Loading — this takes a few seconds' });
  root.appendChild(splash.el);
  bootEl?.remove();
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  await scene.setSystem(session.system, (f, label) => splash.update({ progress: f, status: label || 'Loading' }), { nearBodyId: session.flight().primaryId });
  splash.update({ progress: 1, status: 'Ready' });

  // ---------------------------------------------------------------------------------------------- title, menu, the pilot's touch
  title = createTitleScreen(host);
  // let the ship show through the title's veil: dark only behind the words at the top and bottom
  title.el.style.background = 'linear-gradient(180deg, rgba(4,7,12,0.72) 0%, rgba(4,7,12,0) 26%, rgba(4,7,12,0) 64%, rgba(4,7,12,0.82) 100%)';
  menu = createPauseMenu(host);
  menu.onResume = closeMenu;
  // scene.pickDevice(x, y): the physical control under a finger, by a ray from the eye through the 3D cockpit.
  input = createPlayInput({
    surface: canvas,
    layer: root,
    session,
    pick: (x, y): DevicePick | null => scene.pickDevice(x, y),
    sensitivity: () => Number(host.settings.get<number>('stickSensitivity', 1)) || 1,
    invertPitch: () => !!host.settings.get<boolean>('invertPitch', false),
    onMenu: openMenu,
  });
  // closed eyes and the end of a wreck: a black shade between the canvas and the (empty) UI layer
  const shade = document.createElement('div');
  shade.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;background:#000;opacity:0;pointer-events:none;';
  document.body.insertBefore(shade, root);
  let shadeNow = 0;
  let wreckT = 0;
  const shadeToward = (target: number, dt: number): void => {
    const rate = target > shadeNow ? 0.6 : 2.5; // eyes close slowly and open fast
    const next = shadeNow + Math.max(-rate * dt, Math.min(rate * dt, target - shadeNow));
    if (next === shadeNow) return;
    shadeNow = next;
    shade.style.opacity = next.toFixed(3);
  };

  // ---------------------------------------------------------------------------------------------- frame
  const frame = createSceneFrame();
  const instruments = createInstrumentData();
  let instrumentsAge = 1;
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

  // ---- the title view: before the tap, a slow cinematic orbit round the Wren with Chandler's Wheel and Wick
  // behind it; the tap fades through black into the pilot's eyes. Title mode only: no gameplay UI is drawn.
  let titleT = 0;
  /** seconds left of the fade to black on the way from the title into first person (0 = not fading) */
  let titleOut = 0;
  const TITLE_FADE = 0.45;
  /** azimuth of the star seen from the ship (north-up orbit frame), fixed when the title starts */
  let titleSunAz = Number.NaN;
  const titleView = (cam: typeof frame.camera, craftId: string, dt: number): boolean => {
    if (current === 'flight' && titleOut <= 0) {
      cam.shiftY = 0;
      return false;
    }
    if (Number.isNaN(titleSunAz)) {
      titleSunAz = 2.35;
      const star = frame.bodies.find((b) => b.def.kind === 'star');
      const me = frame.craft.find((c) => c.id === craftId);
      if (star && me) titleSunAz = Math.atan2(star.r.x - me.r.x, star.r.z - me.r.z);
    }
    if (current === 'flight') {
      titleOut = Math.max(0, titleOut - dt);
      shadeNow = Math.min(1, 1 - titleOut / TITLE_FADE);
      shade.style.opacity = shadeNow.toFixed(3);
    }
    titleT += dt;
    cam.mode = 'orbit';
    cam.focusId = craftId;
    // a slow north-up orbit centred on the ship, a little above her and breathing in and out: one turn in three
    // minutes shows every side, with the Wheel and Wick passing behind; it starts on her sunlit bow quarter
    cam.lookAtId = null;
    // the camera swings slowly to and fro on the sunlit side (the star 30-75 degrees off the view axis), so
    // the white armour always catches the light; the shadow side of a hull in space is black
    cam.yaw = titleSunAz + 0.65 + 0.35 * Math.sin(titleT * 0.045);
    // low over her flank: the star lies near the ecliptic, so the sides catch it and the deck only grazes
    cam.pitch = -0.14 + 0.06 * Math.sin(titleT * 0.031 + 1.1);
    cam.distance = 0.95 + 0.08 * Math.sin(titleT * 0.027);
    cam.zoom = 1;
    // portrait: the ship sits in the clear band between the logo and the words below it
    cam.shiftY = lastH > lastW ? 0.42 : 0.12;
    return true;
  };

  /** Refill the frame from the session: the world as it is, seen from the pilot's eyes. Always first person. */
  const fill = (dt: number): void => {
    beginFrame(frame, session.time(), dt, session.warp().achieved);
    frame.bodies = session.bodies();
    frame.craft = session.craft();
    const p = session.player();
    const cv = session.crew();
    const cam = frame.camera;
    if (titleView(cam, p.craftId, dt)) return finishFill(dt);
    cam.mode = 'interior';
    cam.focusId = p.craftId;
    cam.lookAtId = null;
    cam.yaw = 0;
    cam.pitch = 0;
    cam.distance = 1;
    cam.eye.x = cv.eye.x;
    cam.eye.y = cv.eye.y;
    cam.eye.z = cv.eye.z;
    cam.lookYaw = cv.yaw;
    cam.lookPitch = cv.pitch;
    cam.zoom = input ? input.zoom : 1;
    finishFill(dt);
  };
  /** The part of the frame that does not depend on the camera: the pilot's controls and screens, lights, docking. */
  const finishFill = (dt: number): void => {
    const p = session.player();
    // the physical controls as they are, and what the console screens show (re-read five times a second)
    frame.devices = session.devices();
    instrumentsAge += dt;
    if (instrumentsAge >= 0.2 || !frame.instruments) {
      instrumentsAge = 0;
      frame.instruments = readInstruments(session, instruments, frame.devices, session.cockpit());
    }
    frame.cabinLights = session.cabinLights();
    frame.environment.reentry = session.flight().situation === 'atmosphere' ? Math.min(1, Math.max(0, p.heat * 1.2)) : 0;
    // the port the latch would take keeps its own lights; no drawn guides
    const d = session.docking();
    if (!p.dockedTo && d.stationId && d.portId) addStationExtra(frame, d.stationId, d.portId);
    setDockingGuide(frame, null);
  };

  let lastMode: string | null = null;
  let rtAcc = 0;
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
      if (menuOpen && menu && menu.el.getClientRects().length === 0) closeMenu();
      const running = current === 'flight' && !menuOpen;
      let simMs = 0;
      let steps = 0;
      if (running) {
        const info = session.step(dt);
        simMs = info.simMs;
        steps = info.steps;
        input?.update(dt);
        // sitting down, the pilot's eyes fall on the console: screens in the middle of the view, the windscreen
        // above them, the hand controllers below (a wide phone needs the head a little lower to see the desk)
        const modeNow = session.mode();
        if (modeNow !== lastMode) {
          lastMode = modeNow;
          if (modeNow === 'helm') {
            const cv = session.crew();
            const want = (lastW > lastH ? -30 : -22) * (Math.PI / 180);
            session.addLook(-cv.yaw, want - cv.pitch);
          }
        }
        sinceSave += dt;
        if (sinceSave >= 60) host.saveNow();
        if (session.player().destroyed) {
          // the wreck fades out; then the pilot is back in the starting orbit
          wreckT += dt;
          shadeToward(1, dt);
          if (wreckT >= WRECK_SECONDS && shadeNow >= 1) {
            wreckT = 0;
            host.reset();
          }
        } else {
          wreckT = 0;
          shadeToward(session.crew().asleep ? SLEEP_SHADE : 0, dt);
        }
      }
      layout();
      let renderMs = 0;
      if (!lost) {
        const r0 = performance.now();
        fill(dt);
        scene.render(frame);
        renderMs = performance.now() - r0;
      }
      // the record, and the automatic quality it drives (not while baking, in the menu or on the title)
      if (running && !lost && !scene.busy()) {
        perf.record(frameMs, simMs, renderMs, steps);
        const ch = perf.auto(dt);
        if (ch) {
          pipeline.setDynamicResolution(false, ch.scale);
          if (ch.tier) applyTier(ch.tier);
          noteForReport(`auto quality: ${perf.snapshot().note}`);
          rtGov.settle(4);
        }
        // the ray-tracing governor, twice a second — only while the tracer actually draws (inside the ship): the
        // 33 ms budget and any step-down belong to traced frames; outside, the 60 fps budget applies
        const rtDrawing = renderInfo.rt !== 'off' && renderInfo.rt !== 'building';
        perf.budgetMs = frameBudgetFor(rtDrawing ? rtGov.tier : 'off');
        rtAcc += dt;
        if (!rtDrawing) {
          rtGov.settle(1);
          rtAcc = 0;
        } else if (rtAcc >= 0.5) {
          const next = rtGov.update(rtAcc, perf.p95(), perf.samples);
          rtAcc = 0;
          if (next) applyRt(next, `governor: ${rtGov.note}`);
        }
      }
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
    if (current === 'flight') host.saveNow();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) onHide();
    else last = performance.now();
  });
  window.addEventListener('pagehide', onHide);

  // First frames behind the splash, then the title over the pilot's view.
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
    input,
    get screen() { return current; },
    frame,
  };
  w.__ready = true;
}
