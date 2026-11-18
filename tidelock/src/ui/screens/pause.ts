// Pause menu: resume, save, settings, how to play, quit. An overlay above whichever screen is showing.
import { h, icon, onTap, Button, SegmentedControl, Slider, Toggle, confirmDialog } from '../kit';
import type { UiHost, UiScreen } from '../host';
import { screenRoot, SETTING_KEYS, VERSION_LINE } from './shared';

/** The pause overlay. `onResume` (if set) is called when the player resumes; a 'tl-resume' event also bubbles from `el`. */
export interface PauseMenu extends UiScreen {
  onResume: (() => void) | null;
  /** Open on a given page (default 'menu'). */
  open(view?: 'menu' | 'settings' | 'help'): void;
}

const HELP = `
<h3>The readouts</h3>
<p><b>ALT</b> is height above the surface; <b>SPD</b> is speed around the world you orbit. <b>Ap</b> and <b>Pe</b> are the highest and lowest points of your orbit, each with the time until you reach it. <b>Δv</b> is how much speed change is left in the tanks — the only fuel gauge that matters.</p>
<h3>Prograde and retrograde</h3>
<p>In orbit you do not steer toward things; you change your speed and the orbit changes shape. Burn <i>prograde</i> (along your motion) and the far side of the orbit rises. Burn <i>retrograde</i> (against it) and the far side falls. Holding a marker with SAS keeps the nose on it while you work the throttle.</p>
<h3>To Gloaming Lock by hand</h3>
<p><b>1.</b> In Departures, set Gloaming Lock as your destination and launch. <b>2.</b> Open the map and tap <b>Plot course</b>: two burns appear on your path. <b>3.</b> Point prograde and, as the first countdown reaches zero, burn about 940 m/s until the node’s Δv reads zero. Your apoapsis now touches the Lock’s orbit at 5,200 km. <b>4.</b> Coast up — use time warp — and at apoapsis burn prograde again, about 820 m/s, to match the station’s speed. <b>5.</b> Close the last few kilometres gently.</p>
<h3>With the flight computer</h3>
<p>On the map, set the target and tap <b>Go to target</b>. The computer plans the transfer, flies both burns, and brings you in to dock. You may time-warp through the coast; it drops warp before each burn. Touch the stick or throttle at any time to take the ship back.</p>
<h3>Docking</h3>
<p>Within 50 km of a station and under 200 m/s relative speed, request docking. Traffic control assigns a berth and a tug draws you in. Purists can fly it themselves: arrive within 30 m of the berth under 3 m/s and the clamps catch you.</p>
<h3>If it goes wrong</h3>
<p>Dry tanks in a stable orbit? Call a fuel tender. Lost the ship? A replacement waits at your last station, for a price.</p>
`;

export function createPauseMenu(host: UiHost): PauseMenu {
  const el = screenRoot(host, 'tls-pause');
  const title = h('h2');
  const back = h('button.tls-pause__nav', { attrs: { type: 'button', 'aria-label': 'Back' } }, icon('back', 24));
  const body = h('div.tls-pause__body');
  el.appendChild(h('div.tls-pause__card', null, h('div.tls-pause__head', null, back, title), body));
  body.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });

  const resume = (): void => {
    api.hide();
    el.dispatchEvent(new CustomEvent('tl-resume', { bubbles: true }));
    api.onResume?.();
  };
  onTap(back, () => api.open('menu'));

  function menu(): void {
    const b = (label: string, ic: Parameters<typeof icon>[0], fn: () => void, variant: 'primary' | 'secondary' | 'danger' = 'secondary'): HTMLElement =>
      Button({ label, icon: ic, variant, size: 'lg', block: true, onTap: fn }).el;
    body.append(
      b('Resume', 'play', resume, 'primary'),
      h('div.tls-pause__grid', null,
        b('Save now', 'check', () => { host.saveNow(); host.toast('Flight saved.', 'good'); }),
        b('Settings', 'settings', () => api.open('settings')),
        b('How to play', 'info', () => api.open('help')),
        b('Quit to title', 'close', () => {
          void confirmDialog({ title: 'Quit to title?', message: 'Your flight is saved first, exactly as it stands.', confirmLabel: 'Save and quit', cancelLabel: 'Stay', icon: 'warning' }, el)
            .then((yes) => {
              if (!yes) return;
              host.saveNow();
              api.hide();
              host.go('title');
            });
        })),
      h('div.tls-pause__ver', { text: VERSION_LINE }),
    );
  }

  function settings(): void {
    const s = host.settings;
    const q = s.get<string>(SETTING_KEYS.quality, 'high');
    body.append(
      h('div.tl-label', { text: 'Graphics quality' }),
      SegmentedControl<'low' | 'medium' | 'high'>({
        items: [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }],
        value: q === 'low' || q === 'medium' ? q : 'high', block: true,
        onChange: (v) => { s.set(SETTING_KEYS.quality, v); el.dataset.fx = v === 'low' ? 'lite' : 'full'; },
      }).el,
      h('p.tl-small', { text: 'Low saves battery and keeps the frame rate up in Low Power Mode.' }),
      Slider({
        label: 'Stick sensitivity', value: Math.min(2, Math.max(0.5, Number(s.get<number>(SETTING_KEYS.sensitivity, 1)) || 1)), min: 0.5, max: 2, step: 0.1, ticks: 15,
        format: (v) => `${v.toFixed(1)}×`, onChange: (v) => s.set(SETTING_KEYS.sensitivity, Math.round(v * 10) / 10),
      }).el,
      Toggle({ label: 'Invert pitch', hint: 'Pull the stick down to raise the nose', value: !!s.get<boolean>(SETTING_KEYS.invertPitch, false), onChange: (v) => s.set(SETTING_KEYS.invertPitch, v) }).el,
    );
  }

  const api: PauseMenu = {
    el,
    onResume: null,
    open(view = 'menu') {
      body.replaceChildren();
      body.scrollTop = 0;
      back.style.visibility = view === 'menu' ? 'hidden' : '';
      back.style.width = view === 'menu' ? '0' : '';
      title.textContent = view === 'menu' ? 'Paused' : view === 'settings' ? 'Settings' : 'How to play';
      if (view === 'menu') menu();
      else if (view === 'settings') settings();
      else body.appendChild(h('div.tls-help', { ref: (n) => { n.innerHTML = HELP; } }));
      el.hidden = false;
    },
    show() { api.open('menu'); },
    hide() { el.hidden = true; },
    update() {},
    dispose() { el.remove(); },
  };
  return api;
}
