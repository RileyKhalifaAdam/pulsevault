// On-foot controls: a floating left-thumb stick to walk and strafe, drag on the right half to look, and the
// press() helper the on-foot buttons use. True multi-touch: the stick, each look finger and every button track
// their own pointer (walk + look + jump together). Keyboard for desktop testing: WASD, arrows, Space, E, B, C.
import type { UiHost } from '../host';
import { clamp, h } from '../kit';

export interface FootControls {
  /** Full-screen layer under the HUD plates: stick zone (left half) and look drag (right half). */
  surface: HTMLElement;
  stick: HTMLElement;
  update(dt: number): void;
  setActive(on: boolean): void;
  dispose(): void;
}

const STICK_R = 54;
/** Look rate, rad per CSS pixel dragged, at sensitivity 1. */
const LOOK_RATE = 0.0048;
const KEY_LOOK = 1.6;

/**
 * A button that acts on press and works under any finger (the kit's onTap only follows the primary pointer,
 * which the walking thumb already holds).
 */
export function press(el: HTMLElement, fn: () => void): void {
  let id = -1;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (el.getAttribute('aria-disabled') === 'true') return;
    id = e.pointerId;
    el.classList.add('tl-pressed');
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    fn();
  });
  const end = (e: PointerEvent): void => {
    if (e.pointerId !== id) return;
    id = -1;
    el.classList.remove('tl-pressed');
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('lostpointercapture', end);
}

export function createFootControls(host: UiHost): FootControls {
  let active = false;
  const knob = h('i');
  const stick = h('div.hud-stick.foot-stick', null, knob);
  const surface = h('div.hud-surface');
  let stickId = -1;
  let ox = 0;
  let oy = 0;
  let sx = 0;
  let sy = 0;
  const look = new Map<number, { x: number; y: number }>();
  const keys = new Set<string>();

  const sens = (): number => clamp(Number(host.settings.get('stickSensitivity', 1)) || 1, 0.3, 2);
  const invert = (): number => (host.settings.get('invertPitch', false) ? -1 : 1);

  const releaseStick = (): void => {
    stickId = -1;
    sx = sy = 0;
    stick.classList.remove('is-on');
    stick.style.left = stick.style.top = stick.style.bottom = '';
    knob.style.transform = '';
  };
  surface.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try {
      surface.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const game = host.session;
    if (game.crew().asleep) {
      game.interact(); // any touch wakes the pilot
      return;
    }
    const r = surface.getBoundingClientRect();
    if (stickId < 0 && (e.pointerType !== 'mouse' || e.button === 0) && e.clientX - r.left < r.width * 0.5) {
      stickId = e.pointerId;
      ox = e.clientX;
      oy = e.clientY;
      stick.classList.add('is-on');
      stick.style.left = `${ox - r.left}px`;
      stick.style.top = `${oy - r.top}px`;
      stick.style.bottom = 'auto';
      return;
    }
    look.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });
  surface.addEventListener('pointermove', (e) => {
    if (e.pointerId === stickId) {
      let dx = (e.clientX - ox) / STICK_R;
      let dy = (e.clientY - oy) / STICK_R;
      const m = Math.hypot(dx, dy);
      if (m > 1) {
        dx /= m;
        dy /= m;
      }
      sx = dx;
      sy = dy;
      knob.style.transform = `translate(${(dx * STICK_R).toFixed(1)}px,${(dy * STICK_R).toFixed(1)}px)`;
      return;
    }
    const p = look.get(e.pointerId);
    if (!p) return;
    const k = LOOK_RATE * sens();
    // drag right = look right (yaw is positive to the left); drag up = look up
    host.session.addLook(-(e.clientX - p.x) * k, -(e.clientY - p.y) * k * invert());
    p.x = e.clientX;
    p.y = e.clientY;
  });
  const up = (e: PointerEvent): void => {
    if (e.pointerId === stickId) releaseStick();
    look.delete(e.pointerId);
  };
  surface.addEventListener('pointerup', up);
  surface.addEventListener('pointercancel', up);
  surface.addEventListener('lostpointercapture', up);

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!active || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const game = host.session;
    keys.add(e.code);
    if (e.code === 'Space') game.pushOff();
    else if (e.code === 'KeyE' || e.code === 'Enter') game.interact();
    else if (e.code === 'KeyB') game.setBoots(!game.crew().boots);
    else if (e.code === 'KeyC') game.standUp();
    else return;
    e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    keys.delete(e.code);
  };
  const onBlur = (): void => keys.clear();
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  const axis = (neg: string, pos: string): number => (keys.has(pos) ? 1 : 0) - (keys.has(neg) ? 1 : 0);

  let lx = 0;
  let lz = 0;
  return {
    surface,
    stick,
    update(dt) {
      const game = host.session;
      // stick up the screen = forward
      const mx = clamp(sx + axis('KeyA', 'KeyD'), -1, 1);
      const mz = clamp(-sy + axis('KeyS', 'KeyW'), -1, 1);
      if (mx !== lx || mz !== lz) {
        lx = mx;
        lz = mz;
        game.setWalk({ moveX: mx, moveZ: mz });
      }
      const ky = axis('ArrowRight', 'ArrowLeft');
      const kp = axis('ArrowDown', 'ArrowUp');
      if (ky !== 0 || kp !== 0) game.addLook(ky * KEY_LOOK * dt, kp * KEY_LOOK * dt);
    },
    setActive(on) {
      active = on;
      if (!on) {
        keys.clear();
        releaseStick();
        look.clear();
        if (lx !== 0 || lz !== 0) {
          lx = lz = 0;
          host.session.setWalk({ moveX: 0, moveZ: 0 });
        }
      }
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    },
  };
}
