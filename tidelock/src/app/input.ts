// The pilot's touch (docs: the design note at the top of src/data/cockpit.ts and the end of src/game/api.ts).
//
// There is no flight UI. A touch is one of three things:
//   - the HAND: it started on a physical control the pilot can reach. Dragging moves a hand controller, a lever
//     or a rocker (the control follows with its own dynamics); a short tap presses a button, flips a switch,
//     pulls a handle, pages a screen, works the harness buckle, or uses a bunk / bench.
//   - the HEAD: it started anywhere else. Drag = look, two fingers = pinch to lean in (narrow the view),
//     a quick upward flick = jump / push off.
//   - the FEET: the left thumb in the lower-left of the screen while on foot is the walk stick — the only thing
//     ever drawn over the view.
// Three fingers down and up again opens the system menu. Any touch wakes a sleeping pilot (and does nothing else).

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
const WALK_PX = 48;
/** Head turn per pixel of drag at zoom 1, rad. */
const LOOK_RATE = 0.0042;
/** A tap: shorter than this and moved less than this. */
const TAP_MS = 400;
const TAP_PX = 14;
/** A flick: at least this far up, mostly vertical, within this time. */
const FLICK_MS = 300;
const FLICK_PX = 45;
const TRIPLE_MS = 700;

type GestureKind = 'hand' | 'tap' | 'look' | 'walk' | 'dead';
interface Gesture {
  kind: GestureKind;
  def: DeviceDef | null;
  x0: number; y0: number;
  x: number; y: number;
  t0: number;
  moved: number;
  /** Lever position when the hand took it. */
  base: number;
  /** Look applied by this drag (undone if it turns out to be a flick). */
  ay: number; ap: number;
  pinched: boolean;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export function createPlayInput(opts: PlayInputOptions): PlayInput {
  const { surface, session } = opts;
  const gestures = new Map<number, Gesture>();
  let active = false;
  let triple = 0;
  let pinch0 = 0;
  let zoom0 = 1;
  const keys = { x: 0, z: 0, on: false };

  // the walk stick: a ring and a nub, lower left, only while on foot and awake
  const ring = document.createElement('div');
  ring.style.cssText = 'position:absolute;width:112px;height:112px;border-radius:50%;border:1.5px solid rgba(255,255,255,0.3);background:rgba(255,255,255,0.05);'
    + 'transform:translate(-50%,-50%);pointer-events:none;display:none;';
  const nub = document.createElement('div');
  nub.style.cssText = 'position:absolute;left:50%;top:50%;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;background:rgba(255,255,255,0.32);';
  ring.className = 'walk-stick';
  nub.className = 'walk-stick__nub';
  ring.appendChild(nub);
  opts.layer.appendChild(ring);
  const ringRest = (): void => {
    ring.style.left = 'calc(max(16px, env(safe-area-inset-left, 0px)) + 68px)';
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
  const count = (kind: GestureKind): number => {
    let n = 0;
    for (const g of gestures.values()) if (g.kind === kind) n++;
    return n;
  };
  const lookSpan = (): number => {
    let a: Gesture | null = null, b: Gesture | null = null;
    for (const g of gestures.values()) if (g.kind === 'look') { if (!a) a = g; else if (!b) b = g; }
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  /** Take the gesture out of play (hand off the control, feet still). */
  const end = (id: number, g: Gesture): void => {
    if (g.kind === 'hand') session.releaseDevice(id);
    else if (g.kind === 'walk') { session.setWalk({ moveX: 0, moveZ: 0 }); ringRest(); }
    g.kind = 'dead';
  };

  const down = (e: PointerEvent): void => {
    if (!active || gestures.has(e.pointerId)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try { surface.setPointerCapture(e.pointerId); } catch { /* not capturable: moves still arrive on the canvas */ }
    // the event's own clock: a slow frame between finger down and finger up must not turn a tap into a hold
    const now = e.timeStamp || performance.now();
    const g: Gesture = { kind: 'dead', def: null, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t0: now, moved: 0, base: 0, ay: 0, ap: 0, pinched: false };
    gestures.set(e.pointerId, g);
    if (gestures.size >= 3) {
      // three fingers: the system menu; whatever the other fingers were doing stops
      if (gestures.size === 3) triple = now;
      for (const [id, o] of gestures) end(id, o);
      return;
    }
    if (session.crew().asleep) { session.pushOff(); return; } // any touch wakes, and that is all it does
    // a second finger beside one that is looking (or resting on a screen, a switch, a bunk) is a pinch: the pilot
    // leans in, whatever happens to be under the two fingers
    if (gestures.size === 2) {
      let other: Gesture | null = null;
      for (const o of gestures.values()) if (o !== g && (o.kind === 'look' || o.kind === 'tap')) other = o;
      if (other) {
        other.kind = g.kind = 'look';
        other.def = null;
        other.pinched = g.pinched = true;
        pinch0 = lookSpan();
        zoom0 = api.zoom;
        return;
      }
    }
    const hit = opts.pick(e.clientX, e.clientY);
    const def = hit ? defOf(hit.id) : null;
    if (def && reachable(def.id)) {
      g.def = def;
      const k = def.kind;
      if (k === 'stick2' || k === 'lever' || k === 'rocker' || k === 'button' || k === 'handle') {
        if (k === 'lever') g.base = leverAt(def.id);
        if (session.grabDevice(def.id, e.pointerId)) { g.kind = 'hand'; return; }
      } else { g.kind = 'tap'; return; }
    }
    const w = surface.clientWidth || window.innerWidth, h = surface.clientHeight || window.innerHeight;
    if (onFoot() && count('walk') === 0 && e.clientX < 0.5 * w && e.clientY > 0.4 * h) {
      g.kind = 'walk';
      ring.style.left = `${e.clientX}px`;
      ring.style.top = `${e.clientY}px`;
      ring.style.bottom = 'auto';
      ring.style.transform = 'translate(-50%,-50%)';
      ring.style.opacity = '1';
      return;
    }
    g.kind = 'look';
    if (count('look') === 2) {
      pinch0 = lookSpan();
      zoom0 = api.zoom;
      for (const o of gestures.values()) if (o.kind === 'look') o.pinched = true;
    }
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
    switch (g.kind) {
      case 'hand': {
        const def = g.def!;
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
      case 'tap':
        // a drag that began on a switch, a screen or a bunk is the head turning after all
        if (g.moved > TAP_PX) { g.kind = 'look'; g.def = null; }
        break;
      case 'look':
        if (count('look') >= 2) {
          const span = lookSpan();
          if (pinch0 > 10 && span > 10) {
            const z1 = clamp(zoom0 * (span / pinch0), 1, 3);
            if (z1 !== api.zoom) {
              // lean toward what is between the fingers: the head turns so that it stays under them
              const w = surface.clientWidth || window.innerWidth, h = surface.clientHeight || window.innerHeight;
              const f0 = h / 2 / Math.tan(interiorFov(w / Math.max(1, h)) / 2);
              let cx = 0, cy = 0, n = 0;
              for (const o of gestures.values()) if (o.kind === 'look') { cx += o.x; cy += o.y; n++; }
              const ox = cx / n - w / 2, oy = cy / n - h / 2;
              session.addLook(Math.atan(ox / (f0 * z1)) - Math.atan(ox / (f0 * api.zoom)), Math.atan(oy / (f0 * z1)) - Math.atan(oy / (f0 * api.zoom)));
              api.zoom = z1;
            }
          }
        } else {
          const k = (LOOK_RATE * sens) / api.zoom;
          const a = -(g.x - px) * k, p = -(g.y - py) * k;
          g.ay += a; g.ap += p;
          session.addLook(a, p);
        }
        break;
      case 'walk': {
        const vx = clamp(dx / WALK_PX, -1, 1), vz = clamp(-dy / WALK_PX, -1, 1);
        session.setWalk({ moveX: Math.abs(vx) < 0.12 ? 0 : vx, moveZ: Math.abs(vz) < 0.12 ? 0 : vz });
        nub.style.transform = `translate(${(vx * 30).toFixed(1)}px,${(-vz * 30).toFixed(1)}px)`;
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
    switch (g.kind) {
      case 'hand': session.releaseDevice(e.pointerId); break;
      case 'tap':
        if (!cancelled && held < TAP_MS && g.moved <= TAP_PX && g.def) session.tapDevice(g.def.id);
        break;
      case 'walk': session.setWalk({ moveX: 0, moveZ: 0 }); ringRest(); break;
      case 'look': {
        const dx = g.x - g.x0, dy = g.y - g.y0;
        if (!cancelled && !g.pinched && held < FLICK_MS && dy < -FLICK_PX && -dy > 1.4 * Math.abs(dx) && onFoot()) {
          session.addLook(-g.ay, -g.ap); // the flick was not a look
          session.pushOff();
        }
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
  const onCancel = (e: PointerEvent): void => up(e, true);
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
  surface.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);

  function setActive(on: boolean): void {
    if (on === active) return;
    active = on;
    if (!on) {
      for (const [id, g] of gestures) end(id, g);
      gestures.clear();
      held.clear();
      keys.x = keys.z = 0;
      triple = 0;
      session.setWalk({ moveX: 0, moveZ: 0 });
      ring.style.display = 'none';
    }
  }

  function update(_dt: number): void {
    const show = active && onFoot() && !session.crew().asleep;
    const want = show ? 'block' : 'none';
    if (ring.style.display !== want) ring.style.display = want;
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
    surface.removeEventListener('wheel', onWheel);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKey);
    ring.remove();
  }

  return api;
}
