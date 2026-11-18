// Touch (and keyboard) flight controls: a floating left-thumb stick, roll buttons, a vertical throttle with a
// cut button, the SAS selector and the camera gestures. True multi-touch: every control tracks its own pointer.
// The HUD (src/ui/hud/hud.ts) places the elements and owns the CSS; this module owns the behaviour.
import type { UiHost } from '../host';
import type { HoldMode } from '../../game';
import { clamp, h, icon, onTap, type IconName } from '../kit';

export interface ControlHooks {
  warp(dir: -1 | 1): void;
  map(): void;
  pause(): void;
}

export interface FlightControls {
  /** Full-screen layer under the HUD plates: stick zone and camera gestures. */
  surface: HTMLElement;
  stick: HTMLElement;
  roll: HTMLElement;
  throttle: HTMLElement;
  /** SAS button and its drawer (the drawer is placed by the HUD above the button row). */
  sas: HTMLElement;
  sasDrawer: HTMLElement;
  /** RCS translate-mode toggle (stick = sideways / up-down, roll buttons = back / forward). */
  rcs: HTMLElement;
  readonly rcsOn: boolean;
  /** Camera offsets for SceneFrame.camera. */
  camera: { yaw: number; pitch: number; distance: number };
  update(dt: number): void;
  setActive(on: boolean): void;
  dispose(): void;
}

export const SAS_MODES: { mode: HoldMode; label: string; short: string; icon: IconName }[] = [
  { mode: 'stability', label: 'Hold', short: 'HOLD', icon: 'sas' },
  { mode: 'prograde', label: 'Prograde', short: 'PRO', icon: 'prograde' },
  { mode: 'retrograde', label: 'Retrograde', short: 'RETRO', icon: 'retrograde' },
  { mode: 'normal', label: 'Normal', short: 'NORM', icon: 'normal' },
  { mode: 'antinormal', label: 'Anti-normal', short: 'ANTI', icon: 'antinormal' },
  { mode: 'radialOut', label: 'Radial out', short: 'RAD+', icon: 'radialOut' },
  { mode: 'radialIn', label: 'Radial in', short: 'RAD-', icon: 'radialIn' },
  { mode: 'target', label: 'Target', short: 'TGT', icon: 'target' },
  { mode: 'antiTarget', label: 'Anti-target', short: 'ATGT', icon: 'target' },
  { mode: 'burn', label: 'Burn', short: 'BURN', icon: 'node' },
  { mode: 'off', label: 'Off', short: 'OFF', icon: 'sas' },
];

const STICK_R = 54;

export function createFlightControls(host: UiHost, hooks: ControlHooks): FlightControls {
  const camera = { yaw: 0, pitch: 0.12, distance: 1 };
  let active = false;

  // ------------------------------------------------------------------ stick + camera surface
  const knob = h('i');
  const stick = h('div.hud-stick', null, knob);
  const surface = h('div.hud-surface');
  let stickId = -1;
  let ox = 0;
  let oy = 0;
  let sx = 0;
  let sy = 0;
  const cam = new Map<number, { x: number; y: number }>();
  let pinch = 0;

  const inStickZone = (x: number, y: number): boolean => {
    const r = surface.getBoundingClientRect();
    const px = (x - r.left) / (r.width || 1);
    const py = (y - r.top) / (r.height || 1);
    return r.width < r.height ? px < 0.6 && py > 0.4 : px < 0.42 && py > 0.26;
  };
  const pinchDist = (): number => {
    const p = [...cam.values()];
    return p.length >= 2 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0;
  };
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
    if (stickId < 0 && (e.pointerType !== 'mouse' || e.button === 0) && inStickZone(e.clientX, e.clientY)) {
      stickId = e.pointerId;
      const r = surface.getBoundingClientRect();
      ox = e.clientX;
      oy = e.clientY;
      stick.classList.add('is-on');
      stick.style.left = `${ox - r.left}px`;
      stick.style.top = `${oy - r.top}px`;
      stick.style.bottom = 'auto';
      return;
    }
    if (cam.size < 2) {
      cam.set(e.pointerId, { x: e.clientX, y: e.clientY });
      pinch = pinchDist();
    }
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
    const p = cam.get(e.pointerId);
    if (!p) return;
    if (cam.size === 1) {
      camera.yaw -= (e.clientX - p.x) * 0.006;
      camera.pitch = clamp(camera.pitch + (e.clientY - p.y) * 0.006, -1.35, 1.35);
    }
    p.x = e.clientX;
    p.y = e.clientY;
    if (cam.size >= 2) {
      const d = pinchDist();
      if (pinch > 8 && d > 8) camera.distance = clamp((camera.distance * pinch) / d, 0.45, 8);
      pinch = d;
    }
  });
  const up = (e: PointerEvent): void => {
    if (e.pointerId === stickId) releaseStick();
    if (cam.delete(e.pointerId)) pinch = pinchDist();
  };
  surface.addEventListener('pointerup', up);
  surface.addEventListener('pointercancel', up);
  surface.addEventListener('lostpointercapture', up);
  surface.addEventListener('wheel', (e) => {
    e.preventDefault();
    camera.distance = clamp(camera.distance * Math.exp(e.deltaY * 0.0015), 0.45, 8);
  }, { passive: false });

  // ------------------------------------------------------------------ roll
  let rollTouch = 0;
  const rollBtn = (dir: -1 | 1, label: string): HTMLElement => {
    const b = h('button.hud-btn.hud-btn--sq', { attrs: { type: 'button', 'aria-label': label } });
    b.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${dir < 0 ? 'M5 12a7 7 0 1 1 3 5.7M5 12V7M5 12h5' : 'M19 12a7 7 0 1 0-3 5.7M19 12V7M19 12h-5'}"/></svg>`;
    let id = -1;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      id = e.pointerId;
      try {
        b.setPointerCapture(id);
      } catch {
        /* ignore */
      }
      rollTouch = dir;
      b.classList.add('tl-pressed');
    });
    const end = (e: PointerEvent): void => {
      if (e.pointerId !== id) return;
      id = -1;
      if (rollTouch === dir) rollTouch = 0;
      b.classList.remove('tl-pressed');
    };
    b.addEventListener('pointerup', end);
    b.addEventListener('pointercancel', end);
    b.addEventListener('lostpointercapture', end);
    return b;
  };
  const roll = h('div.hud-roll', null, rollBtn(-1, 'Roll left'), rollBtn(1, 'Roll right'));
  // RCS translate mode (for docking): the stick pushes the ship sideways / up-down, the roll buttons back / forward.
  let rcsOn = false;
  const rcs = h('button.hud-btn.hud-btn--rcs', { attrs: { type: 'button', 'aria-label': 'RCS translate mode', 'aria-pressed': 'false' }, text: 'RCS' });
  const setRcs = (on: boolean): void => {
    rcsOn = on;
    rcs.classList.toggle('is-on', on);
    rcs.setAttribute('aria-pressed', on ? 'true' : 'false');
    stick.classList.toggle('is-rcs', on);
    host.session.setControls({ pitch: 0, yaw: 0, roll: 0, translate: { x: 0, y: 0, z: 0 } });
    lp = ly = lr = ltx = lty = ltz = 0;
  };
  onTap(rcs, () => setRcs(!rcsOn));

  // ------------------------------------------------------------------ throttle
  const fill = h('div.hud-thr-fill');
  const thumb = h('div.hud-thr-thumb');
  const pct = h('span.hud-thr-pct', { text: '0' });
  const track = h('div.hud-thr-track.hud-plate', { attrs: { role: 'slider', 'aria-label': 'Throttle' } }, h('div.hud-thr-ticks'), fill, thumb, pct, h('span.hud-thr-cap', { text: 'THR' }));
  const cut = h('button.hud-btn.hud-btn--cut', { attrs: { type: 'button' }, text: 'CUT' });
  const throttle = h('div.hud-thr', null, track, cut);
  let thrDrag = -1;
  let thrSent = -1;
  let thrShown = -1;
  const sendThrottle = (v: number): void => {
    v = clamp(v, 0, 1);
    thrSent = v;
    host.session.setControls({ throttle: v });
  };
  const thrFromEvent = (e: PointerEvent): void => {
    const r = track.getBoundingClientRect();
    const pad = 10;
    let v = 1 - (e.clientY - r.top - pad) / Math.max(1, r.height - pad * 2);
    v = clamp(v, 0, 1);
    if (v < 0.03) v = 0;
    if (v > 0.97) v = 1;
    sendThrottle(v);
    showThrottle(v);
  };
  const showThrottle = (v: number): void => {
    const r = Math.round(v * 100);
    if (r === thrShown) return;
    thrShown = r;
    fill.style.transform = `scaleY(${(r / 100).toFixed(2)})`;
    thumb.style.bottom = `calc(10px + (100% - 20px) * ${(r / 100).toFixed(2)})`;
    pct.textContent = String(r);
    track.classList.toggle('is-lit', r > 0);
  };
  track.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    thrDrag = e.pointerId;
    try {
      track.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    thrFromEvent(e);
  });
  track.addEventListener('pointermove', (e) => {
    if (e.pointerId === thrDrag) thrFromEvent(e);
  });
  const thrEnd = (e: PointerEvent): void => {
    if (e.pointerId === thrDrag) thrDrag = -1;
  };
  track.addEventListener('pointerup', thrEnd);
  track.addEventListener('pointercancel', thrEnd);
  track.addEventListener('lostpointercapture', thrEnd);
  onTap(cut, () => sendThrottle(0));

  // ------------------------------------------------------------------ SAS
  const sasIcon = h('span.hud-sas-ico');
  const sasLabel = h('span', { text: 'HOLD' });
  const sasBtn = h('button.hud-btn.hud-btn--sas', { attrs: { type: 'button', 'aria-label': 'SAS mode' } }, h('small', { text: 'SAS' }), sasIcon, sasLabel);
  const sas = h('div.hud-sas', null, sasBtn);
  const sasDrawer = h('div.hud-sas-drawer.hud-plate');
  sasDrawer.hidden = true;
  const sasCells = new Map<HoldMode, HTMLElement>();
  for (const m of SAS_MODES) {
    const cell = h('button.hud-sas-cell', { attrs: { type: 'button' } }, icon(m.icon, 22), h('span', { text: m.label }));
    onTap(cell, () => {
      host.session.setHold(m.mode);
      sasDrawer.hidden = true;
    });
    sasCells.set(m.mode, cell);
    sasDrawer.appendChild(cell);
  }
  onTap(sasBtn, () => {
    sasDrawer.hidden = !sasDrawer.hidden;
  });
  let sasShown: HoldMode | '' = '';
  const showSas = (mode: HoldMode): void => {
    if (mode === sasShown) return;
    sasShown = mode;
    const def = SAS_MODES.find((m) => m.mode === mode);
    sasLabel.textContent = def ? def.short : mode === 'off' ? 'OFF' : 'AUTO';
    sasIcon.replaceChildren(icon(def ? def.icon : 'sas', 20));
    for (const [m, cell] of sasCells) cell.classList.toggle('is-on', m === mode);
  };

  // ------------------------------------------------------------------ keyboard
  const keys = new Set<string>();
  const typing = (e: KeyboardEvent): boolean => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!active || typing(e) || e.metaKey) return;
    keys.add(e.code);
    if (e.repeat) return;
    if (e.code === 'Comma') hooks.warp(-1);
    else if (e.code === 'Period') hooks.warp(1);
    else if (e.code === 'KeyM') hooks.map();
    else if (e.code === 'Escape') hooks.pause();
    else if (e.code === 'KeyX') sendThrottle(0);
    else if (e.code === 'KeyZ') sendThrottle(1);
    else if (e.code === 'KeyT') {
      const i = SAS_MODES.findIndex((m) => m.mode === host.session.player().hold);
      host.session.setHold(SAS_MODES[(i + 1) % SAS_MODES.length].mode);
    }
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    keys.delete(e.code);
  };
  const onBlur = (): void => keys.clear();
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  // ------------------------------------------------------------------ per frame
  let lp = 0;
  let ly = 0;
  let lr = 0;
  let ltx = 0;
  let lty = 0;
  let ltz = 0;
  const tr = { x: 0, y: 0, z: 0 };
  const shape = (v: number, gain: number): number => clamp(Math.sign(v) * Math.pow(Math.abs(v), 1.6) * gain, -1, 1);
  const axis = (neg: string, pos: string): number => (keys.has(pos) ? 1 : 0) - (keys.has(neg) ? 1 : 0);

  return {
    surface,
    stick,
    roll,
    throttle,
    sas,
    sasDrawer,
    rcs,
    get rcsOn() {
      return rcsOn;
    },
    camera,
    update(dt) {
      const game = host.session;
      const gain = clamp(Number(host.settings.get('stickSensitivity', 1)) || 1, 0.3, 2);
      const inv = host.settings.get('invertPitch', false) ? -1 : 1;
      // Stick pulled back (down the screen) = nose up, like a flight stick; W = nose down.
      let p = shape(sy, gain) * inv + axis('KeyW', 'KeyS');
      let y = shape(sx, gain) + axis('KeyA', 'KeyD');
      let r = rollTouch + axis('KeyQ', 'KeyE');
      p = clamp(p, -1, 1);
      y = clamp(y, -1, 1);
      r = clamp(r, -1, 1);
      // Translation: IJKL + H/N on a keyboard; in RCS mode the stick and the roll buttons translate instead of turning.
      let tx = axis('KeyJ', 'KeyL');
      let ty = axis('KeyK', 'KeyI');
      let tz = axis('KeyH', 'KeyN');
      if (rcsOn) {
        tx += clamp(sx * 1.4, -1, 1);
        ty += clamp(-sy * 1.4, -1, 1);
        tz += -rollTouch;
        p = axis('KeyW', 'KeyS');
        y = axis('KeyA', 'KeyD');
        r = axis('KeyQ', 'KeyE');
      }
      tx = clamp(tx, -1, 1);
      ty = clamp(ty, -1, 1);
      tz = clamp(tz, -1, 1);
      if (tx !== ltx || ty !== lty || tz !== ltz) {
        ltx = tr.x = tx;
        lty = tr.y = ty;
        ltz = tr.z = tz;
        game.setControls({ translate: tr });
      }
      if (p !== lp || y !== ly || r !== lr) {
        lp = p;
        ly = y;
        lr = r;
        game.setControls({ pitch: p, yaw: y, roll: r });
      }
      const fi = game.player();
      const kt = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1 : 0) - (keys.has('ControlLeft') || keys.has('ControlRight') ? 1 : 0);
      if (kt !== 0) {
        const v = clamp(fi.throttle + kt * dt * 0.7, 0, 1);
        sendThrottle(v);
        showThrottle(v);
      } else if (thrDrag < 0) showThrottle(fi.throttle);
      showSas(fi.hold);
    },
    setActive(on) {
      active = on;
      if (!on) {
        keys.clear();
        releaseStick();
        cam.clear();
        rollTouch = 0;
        sasDrawer.hidden = true;
        if (rcsOn) setRcs(false);
        if (lp !== 0 || ly !== 0 || lr !== 0) {
          lp = ly = lr = 0;
          host.session.setControls({ pitch: 0, yaw: 0, roll: 0 });
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
