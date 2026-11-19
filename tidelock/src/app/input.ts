// The pilot's touch (docs: the design note at the top of src/data/cockpit.ts and the end of src/game/api.ts).
//
// There is no flight UI. Every finger gets exactly ONE role when it comes down, and keeps it until it lifts:
//   - WALK (the feet): on foot and awake, any touch that begins in the walk zone — a generous lower-left region
//     of the glass — is the walk stick. The stick appears where the thumb landed. That finger never turns the
//     head, never zooms and never flicks, even if it wanders out of the zone. One walk finger at a time; a second
//     touch that begins in the zone does nothing. (A quick still tap there still presses the control under it,
//     so a buckle or a switch low on the glass is never out of reach.)
//   - HAND: it began on a physical control the pilot can reach (outside the walk zone, or anywhere while
//     seated). Dragging moves a hand controller, a lever or a rocker; a short tap presses a button, flips a
//     switch, pages a screen, works the harness buckle. A hand on a control never moves the head.
//   - HEAD: everything else. One head finger: drag = look, a quick upward flick = jump / push off. Two head
//     fingers: pinch to lean in (narrow the view); look is suspended while they pinch. A walk or hand finger is
//     never half of a pinch. (A bunk or a bench is a place for the body, not a hand control: a touch on one is a
//     head touch, and a still tap uses it.)
// Three fingers down together and up again opens the system menu. Any touch wakes a sleeping pilot (and does
// nothing else).

import type { DeviceDef } from '../data/cockpit';
import type { Session } from '../game';
import { interiorFov } from '../render/camera';

/** What the scene reports under a finger: the device id (x, y: where on it, unused here). */
export interface DevicePick { id: string; x: number; y: number }

export interface PlayInputOptions {
  /** Element that receives the touches (the game canvas). */
  surface: HTMLElement;
  /** Full-screen layer the walk stick is drawn in. */
  layer: HTMLElement;
  session: Session;
  /** Device under a point (CSS px), or null. */
  pick(x: number, y: number): DevicePick | null;
  /** 0.5..2: scales look speed and hand-controller throw. */
  sensitivity(): number;
  /** Rotation controller: finger up = nose up instead of nose down. */
  invertPitch(): boolean;
  onMenu(): void;
}

export interface PlayInput {
  /** Lean-in / narrow-view factor, 1..3 (frame.camera.zoom). */
  zoom: number;
  setActive(on: boolean): void;
  update(dt: number): void;
  dispose(): void;
}

/** Finger travel for full deflection of a hand controller / the full travel of a lever, CSS px. */
const STICK_PX = 60;
const LEVER_PX = 150;
const ROCKER_PX = 8;
/** Walk stick: thumb travel for full speed = the radius of the ring, CSS px. */
const WALK_PX = 60;
/** Walk zone, as fractions of the surface: left edge to X, Y to the bottom edge. Portrait, then landscape. */
const ZONE_PORTRAIT = { x: 0.5, y: 0.55 };
const ZONE_LANDSCAPE = { x: 0.4, y: 0.35 };
/** Head turn per pixel of drag at zoom 1, rad. */
const LOOK_RATE = 0.0042;
/** A tap: shorter than this and moved less than this. */
const TAP_MS = 400;
const TAP_PX = 14;
/** A flick: at least this far up, mostly vertical, within this time. */
const FLICK_MS = 300;
const FLICK_PX = 45;
/** Three fingers count as the menu gesture when they all landed within this long; lifted again within TRIPLE_MS. */
const TRIPLE_DOWN_MS = 500;
const TRIPLE_MS = 700;

/** The one role a finger has from touch-down to lift ('dead': it does nothing). */
export type TouchRole = 'walk' | 'hand' | 'head' | 'dead';
interface Gesture {
  role: TouchRole;
  /** HAND: the control under the hand. HEAD: the bunk / bench a still tap would use. */
  def: DeviceDef | null;
  /** HAND: the hand holds the control (stick, lever, rocker, button, handle); otherwise a tap works it. */
  grab: boolean;
  x0: number; y0: number;
  x: number; y: number;
  t0: number;
  moved: number;
  /** Lever position when the hand took it. */
  base: number;
  /** Look applied by this drag (undone if it turns out to be a flick). */
  ay: number; ap: number;
  /** HEAD: it has been half of a pinch (so it is not a flick). */
  pinched: boolean;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export function createPlayInput(opts: PlayInputOptions): PlayInput {
  const { surface, session } = opts;
  const gestures = new Map<number, Gesture>();
  let active = false;
  let triple = 0;
  /** The pinch in progress: its two HEAD fingers, their span and the zoom when it began. */
  let pinchA: Gesture | null = null;
  let pinchB: Gesture | null = null;
  let pinch0 = 0;
  let zoom0 = 1;
  const keys = { x: 0, z: 0, on: false };

  // the walk stick: a ring and a nub, only while on foot and awake; it rests lower left and jumps under the thumb
  const ring = document.createElement('div');
  ring.style.cssText = `position:absolute;width:${WALK_PX * 2}px;height:${WALK_PX * 2}px;border-radius:50%;border:1.5px solid rgba(255,255,255,0.3);background:rgba(255,255,255,0.05);`
    + 'transform:translate(-50%,-50%);pointer-events:none;display:none;';
  const nub = document.createElement('div');
  nub.style.cssText = 'position:absolute;left:50%;top:50%;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;background:rgba(255,255,255,0.32);';
  ring.className = 'walk-stick';
  nub.className = 'walk-stick__nub';
  ring.appendChild(nub);
  opts.layer.appendChild(ring);
  const ringRest = (): void => {
    ring.style.left = `calc(max(16px, env(safe-area-inset-left, 0px)) + ${WALK_PX + 12}px)`;
    ring.style.top = 'auto';
    ring.style.bottom = 'calc(env(safe-area-inset-bottom, 0px) + 28px)';
    ring.style.transform = 'translate(-50%, 0)';
    ring.style.opacity = '0.55';
    nub.style.transform = '';
  };
  ringRest();

  const api: PlayInput = { zoom: 1, setActive, update, dispose };

  const defOf = (id: string): DeviceDef | null => session.cockpit()?.devices.find((d) => d.id === id) ?? null;
  const reachable = (id: string): boolean => {
    const ds = session.devices();
    for (let i = 0; i < ds.length; i++) if (ds[i].id === id) return ds[i].reachable;
    return false;
  };
  const leverAt = (id: string): number => {
    const ds = session.devices();
    for (let i = 0; i < ds.length; i++) if (ds[i].id === id) return ds[i].x;
    return 0;
  };
  const onFoot = (): boolean => session.mode() === 'onFoot';
  const count = (role: TouchRole): number => {
    let n = 0;
    for (const g of gestures.values()) if (g.role === role) n++;
    return n;
  };
  /** The reachable control under a point, or null. */
  const deviceAt = (x: number, y: number): DeviceDef | null => {
    const hit = opts.pick(x, y);
    const def = hit ? defOf(hit.id) : null;
    return def && reachable(def.id) ? def : null;
  };
  /** Does a touch at this point begin in the walk zone? */
  const inWalkZone = (x: number, y: number): boolean => {
    const r = surface.getBoundingClientRect();
    const w = r.width || window.innerWidth, h = r.height || window.innerHeight;
    const z = w > h ? ZONE_LANDSCAPE : ZONE_PORTRAIT;
    return x - r.left < z.x * w && y - r.top > z.y * h;
  };
  const stopPinch = (): void => { pinchA = pinchB = null; pinch0 = 0; };
  const startPinch = (a: Gesture, b: Gesture): void => {
    pinchA = a; pinchB = b;
    a.pinched = b.pinched = true;
    pinch0 = Math.hypot(a.x - b.x, a.y - b.y);
    zoom0 = api.zoom;
  };

  /** Take the finger out of play (hand off the control, feet still); it keeps its place but does nothing more. */
  const end = (id: number, g: Gesture): void => {
    if (g.role === 'hand' && g.grab) session.releaseDevice(id);
    else if (g.role === 'walk') { session.setWalk({ moveX: 0, moveZ: 0 }); ringRest(); }
    if (g === pinchA || g === pinchB) stopPinch();
    g.role = 'dead';
  };

  const down = (e: PointerEvent): void => {
    if (!active) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // a finger whose lift was never reported: it is gone, whatever it was doing stops
    const stale = gestures.get(e.pointerId);
    if (stale) { end(e.pointerId, stale); gestures.delete(e.pointerId); }
    e.preventDefault();
    try { surface.setPointerCapture(e.pointerId); } catch { /* not capturable: moves still arrive on the canvas */ }
    // the event's own clock: a slow frame between finger down and finger up must not turn a tap into a hold
    const now = e.timeStamp || performance.now();
    const g: Gesture = { role: 'dead', def: null, grab: false, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t0: now, moved: 0, base: 0, ay: 0, ap: 0, pinched: false };
    let first = now;
    for (const o of gestures.values()) if (o.t0 < first) first = o.t0;
    gestures.set(e.pointerId, g);
    if (gestures.size >= 3 && (triple || now - first < TRIPLE_DOWN_MS)) {
      // three fingers landing together: the system menu; whatever the other fingers were doing stops
      if (gestures.size === 3) triple = now;
      for (const [id, o] of gestures) end(id, o);
      return;
    }
    if (session.crew().asleep) { session.pushOff(); return; } // any touch wakes, and that is all it does
    // WALK: on foot, the lower left of the glass belongs to the feet, whatever is drawn there
    if (onFoot() && inWalkZone(e.clientX, e.clientY)) {
      if (count('walk') > 0) return; // one walk finger at a time; this one does nothing
      g.role = 'walk';
      g.def = deviceAt(e.clientX, e.clientY);
      ring.style.left = `${e.clientX}px`;
      ring.style.top = `${e.clientY}px`;
      ring.style.bottom = 'auto';
      ring.style.transform = 'translate(-50%,-50%)';
      ring.style.opacity = '1';
      nub.style.transform = '';
      return;
    }
    // HAND: it began on a control within reach
    const def = deviceAt(e.clientX, e.clientY);
    if (def && def.kind !== 'rest') {
      const k = def.kind;
      g.def = def;
      if (k === 'stick2' || k === 'lever' || k === 'rocker' || k === 'button' || k === 'handle') {
        if (k === 'lever') g.base = leverAt(def.id);
        if (!session.grabDevice(def.id, e.pointerId)) return; // another hand already has it
        g.grab = true;
      }
      g.role = 'hand';
      return;
    }
    // HEAD: one finger looks, two pinch; any more do nothing
    const heads = count('head');
    if (heads >= 2) return;
    g.role = 'head';
    g.def = def; // a bunk or a bench: a still tap uses it
    if (heads === 1) for (const o of gestures.values()) if (o !== g && o.role === 'head') startPinch(o, g);
  };

  const move = (e: PointerEvent): void => {
    const g = gestures.get(e.pointerId);
    if (!g) return;
    e.preventDefault();
    const px = g.x, py = g.y;
    g.x = e.clientX; g.y = e.clientY;
    const dx = g.x - g.x0, dy = g.y - g.y0;
    const far = Math.hypot(dx, dy);
    if (far > g.moved) g.moved = far;
    const sens = clamp(opts.sensitivity() || 1, 0.5, 2);
    switch (g.role) {
      case 'hand': {
        const def = g.def;
        if (!g.grab || !def) break;
        if (def.kind === 'stick2') {
          let y = (-dy / STICK_PX) * sens;
          if (def.role === 'rotation' && opts.invertPitch()) y = -y;
          session.moveDevice(e.pointerId, clamp((dx / STICK_PX) * sens, -1, 1), clamp(y, -1, 1));
        } else if (def.kind === 'lever') session.moveDevice(e.pointerId, clamp(g.base - dy / LEVER_PX, 0, 1), 0);
        else if (def.kind === 'rocker') {
          // pushed toward whichever end the finger has gone: up / right = +1
          const d = Math.abs(dx) > Math.abs(dy) ? dx : -dy;
          const dir = d > ROCKER_PX ? 1 : d < -ROCKER_PX ? -1 : 0;
          session.moveDevice(e.pointerId, dir, dir);
        }
        break;
      }
      case 'head':
        if (pinchA && pinchB) {
          if (g !== pinchA && g !== pinchB) break;
          const span = Math.hypot(pinchA.x - pinchB.x, pinchA.y - pinchB.y);
          if (pinch0 > 10 && span > 10) {
            const z1 = clamp(zoom0 * (span / pinch0), 1, 3);
            if (z1 !== api.zoom) {
              // lean toward what is between the fingers: the head turns so that it stays under them
              const r = surface.getBoundingClientRect();
              const w = r.width || window.innerWidth, h = r.height || window.innerHeight;
              const f0 = h / 2 / Math.tan(interiorFov(w / Math.max(1, h)) / 2);
              const ox = (pinchA.x + pinchB.x) / 2 - r.left - w / 2, oy = (pinchA.y + pinchB.y) / 2 - r.top - h / 2;
              session.addLook(Math.atan(ox / (f0 * z1)) - Math.atan(ox / (f0 * api.zoom)), Math.atan(oy / (f0 * z1)) - Math.atan(oy / (f0 * api.zoom)));
              api.zoom = z1;
            }
          }
        } else {
          // one head finger: the look follows its own travel since its last event, so nothing jumps after a pinch
          const k = (LOOK_RATE * sens) / api.zoom;
          const a = -(g.x - px) * k, p = -(g.y - py) * k;
          g.ay += a; g.ap += p;
          session.addLook(a, p);
        }
        break;
      case 'walk': {
        const vx = clamp(dx / WALK_PX, -1, 1), vz = clamp(-dy / WALK_PX, -1, 1);
        session.setWalk({ moveX: Math.abs(vx) < 0.12 ? 0 : vx, moveZ: Math.abs(vz) < 0.12 ? 0 : vz });
        const n = Math.max(1, Math.hypot(vx, vz));
        nub.style.transform = `translate(${((vx / n) * (WALK_PX - 23)).toFixed(1)}px,${((-vz / n) * (WALK_PX - 23)).toFixed(1)}px)`;
        break;
      }
      default: break;
    }
  };

  const up = (e: PointerEvent, cancelled: boolean): void => {
    const g = gestures.get(e.pointerId);
    if (!g) return;
    gestures.delete(e.pointerId);
    try { surface.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    const now = e.timeStamp || performance.now(), held = now - g.t0;
    const tapped = !cancelled && held < TAP_MS && g.moved <= TAP_PX;
    switch (g.role) {
      case 'hand':
        if (g.grab) session.releaseDevice(e.pointerId);
        else if (tapped && g.def) session.tapDevice(g.def.id);
        break;
      case 'walk':
        session.setWalk({ moveX: 0, moveZ: 0 });
        ringRest();
        if (tapped && g.def) session.tapDevice(g.def.id); // a still tap low on the glass still presses what is there
        break;
      case 'head': {
        if (g === pinchA || g === pinchB) stopPinch(); // the finger that stays goes back to looking, from where it is
        const dx = g.x - g.x0, dy = g.y - g.y0;
        if (!cancelled && !g.pinched && held < FLICK_MS && dy < -FLICK_PX && -dy > 1.4 * Math.abs(dx) && onFoot()) {
          session.addLook(-g.ay, -g.ap); // the flick was not a look
          session.pushOff();
        } else if (tapped && !g.pinched && g.def) session.tapDevice(g.def.id);
        break;
      }
      default: break;
    }
    if (gestures.size === 0) {
      if (triple && !cancelled && now - triple < TRIPLE_MS) { triple = 0; opts.onMenu(); }
      triple = 0;
    }
  };

  const onUp = (e: PointerEvent): void => up(e, false);
  // a cancelled touch, or one whose capture was taken away, is a finger that has gone: nothing stays held
  const onCancel = (e: PointerEvent): void => up(e, true);
  const dropAll = (): void => {
    for (const [id, g] of gestures) {
      end(id, g);
      try { surface.releasePointerCapture(id); } catch { /* already released */ }
    }
    gestures.clear();
    triple = 0;
  };
  const onHide = (): void => { if (document.visibilityState !== 'visible') dropAll(); };
  const onWheel = (e: WheelEvent): void => {
    if (!active) return;
    e.preventDefault();
    api.zoom = clamp(api.zoom * Math.exp(-e.deltaY * 0.0015), 1, 3);
  };
  // a keyboard, when there is one (desktop testing): WASD / arrows walk, space jumps, Escape opens the menu
  const KEY: Record<string, [number, number]> = { KeyW: [0, 1], ArrowUp: [0, 1], KeyS: [0, -1], ArrowDown: [0, -1], KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0] };
  const held = new Set<string>();
  const onKey = (e: KeyboardEvent): void => {
    if (!active) return;
    const isDown = e.type === 'keydown';
    if (isDown && e.code === 'Escape') { opts.onMenu(); return; }
    if (isDown && e.code === 'Space' && !e.repeat) { session.pushOff(); return; }
    if (!KEY[e.code]) return;
    if (isDown) held.add(e.code); else held.delete(e.code);
    keys.x = keys.z = 0;
    for (const c of held) { keys.x += KEY[c][0]; keys.z += KEY[c][1]; }
    keys.on = true;
  };

  surface.addEventListener('pointerdown', down);
  surface.addEventListener('pointermove', move);
  surface.addEventListener('pointerup', onUp);
  surface.addEventListener('pointercancel', onCancel);
  surface.addEventListener('lostpointercapture', onCancel);
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('blur', dropAll);
  surface.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);

  function setActive(on: boolean): void {
    if (on === active) return;
    active = on;
    if (!on) {
      dropAll();
      held.clear();
      keys.x = keys.z = 0;
      session.setWalk({ moveX: 0, moveZ: 0 });
      ring.style.display = 'none';
    }
  }

  function update(_dt: number): void {
    const show = active && onFoot() && !session.crew().asleep;
    const want = show ? 'block' : 'none';
    if (ring.style.display !== want) ring.style.display = want;
    // strapped in or asleep with the thumb still down: the feet stop, the finger does nothing more
    if (!show) for (const [id, g] of gestures) if (g.role === 'walk') end(id, g);
    if (active && keys.on && count('walk') === 0) {
      session.setWalk({ moveX: clamp(keys.x, -1, 1), moveZ: clamp(keys.z, -1, 1) });
      if (keys.x === 0 && keys.z === 0) keys.on = false;
    }
  }

  function dispose(): void {
    setActive(false);
    surface.removeEventListener('pointerdown', down);
    surface.removeEventListener('pointermove', move);
    surface.removeEventListener('pointerup', onUp);
    surface.removeEventListener('pointercancel', onCancel);
    surface.removeEventListener('lostpointercapture', onCancel);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('blur', dropAll);
    surface.removeEventListener('wheel', onWheel);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKey);
    ring.remove();
  }

  return api;
}
