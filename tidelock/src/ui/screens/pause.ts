// The system menu (three-finger tap; never visible during play): resume, reset to the starting orbit, settings, how it works, performance overlay.
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
<h3>What this is</h3>
<p>A physics sandbox seen through one pair of eyes. You are a body aboard the Wren, a small courier in low orbit of Wick, beside Chandler’s Wheel. The ship moves only because forces act on it, and you move only because you walk, push off, or are carried.</p>
<h3>Your hands</h3>
<p>Nothing is drawn over the view. <b>Touch a control</b> you can reach and your hand is on it: drag a hand controller or a lever and it follows; tap a button, a switch, a handle, a screen. <b>Touch anywhere else</b> and you move your head: drag to look, pinch to lean in, flick upward to jump (boots on the deck) or push off (floating). On your feet, the <b>lower left of the screen</b> is the walk stick: a thumb that lands there only walks (it never turns your head or zooms), so you can walk with the left thumb and look with the right. Pinch with two fingers on the right.</p>
<h3>The pilot seat</h3>
<p>The controls on the console can only be reached from the left seat. Stand beside it and tap the <b>harness buckle</b> to strap in; tap it again to get up. The buckle stays locked while DRIVE ARM is on: under thrust everything loose falls toward the stern.</p>
<h3>Flying</h3>
<p><b>ROTATE</b> (right hand) turns the ship with real torque: sideways is yaw, forward and back is pitch; the <b>ROLL</b> rocker rolls. <b>TRANSLATE</b> (left hand) fires the thrusters sideways and up or down; the <b>FWD / AFT</b> rocker pushes along the nose. Let go and the springs centre them.</p>
<p><b>DRIVE ARM</b> opens the main-drive valves; only then does the <b>DRIVE</b> lever do anything. The lever stays where you leave it. Disarm to close the valves.</p>
<p><b>FLT ASSIST</b> (the lamp button on the desk, right of the DRIVE lever) hands the thrusters to the computer. Lit, the lever is a speed, not a thrust: all the way forward is 50 m/s along the nose, measured against the station you have targeted (or the nearest one within 100 km), and the computer fires the thrusters to hold it — turn the nose and your motion follows; pull the lever back to zero and the ship stops beside the station. TRANSLATE nudges at up to 3 m/s while you hold it. With DRIVE ARM on it uses the main drive to speed up; braking and sideways are always the small thrusters, about 1 m/s². A blinking lamp means no station in range: nothing fires. Tap it again and the controls are direct.
<p>The lamp block picks what the attitude system holds: <b>HOLD</b> stops the rotation and keeps the heading, <b>PRO / RETRO</b> along or against your motion, <b>NML±</b> out of the orbit plane, <b>RAD±</b> away from or toward the world, <b>TGT</b> at the target, <b>DOCK</b> lines the collar up with the nearest port, <b>OFF</b> leaves the ship as it is. One lamp is lit. Moving ROTATE overrides the hold while you hold it over. <b>TARGET</b> steps through the stations, then the worlds.</p>
<h3>A burn, in order</h3>
<p><b>1.</b> Stand behind the left seat, look down and tap the seat (its <b>harness buckle</b>). <b>2.</b> Tap a lamp, say <b>PRO</b>, and wait until the ship has stopped turning. <b>3.</b> Tap <b>DRIVE ARM</b> (left of the lamps); its light comes on. <b>4.</b> Drag the <b>DRIVE</b> lever in the middle of the desk away from you; watch thrust and apoapsis on FLIGHT. <b>5.</b> Drag the lever all the way back toward you, then tap DRIVE ARM again. Only now will the buckle let you out.</p>
<h3>The screens</h3>
<p>FLIGHT shows altitude, speed, apoapsis and periapsis, propellant and Δv. Tap NAV to page between the orbit, docking and systems. They are the only read-outs there are.</p>
<h3>How thrust changes an orbit</h3>
<p>You do not steer toward things. Burn prograde and the far side of your orbit rises; burn retrograde and it falls. Burn at periapsis to move the apoapsis, and at apoapsis to move the periapsis. Turning takes time: wait for the nose before you open the drive.</p>
<h3>Docking</h3>
<p>Match speed with the station, close in slowly, select DOCK, and work the last metres with TRANSLATE. Arrive slow and aligned and the latch closes by itself. <b>LATCH RELEASE</b> lets go.</p>
<h3>Passing time</h3>
<p>Time runs at its own pace. To let hours go by, walk aft to the bunk room, tap the bunk and lie still: after a few seconds you sleep and the hours run as fast as the world allows, until you touch the screen or something disturbs the ship.</p>
<h3>If it goes wrong</h3>
<p>A wrecked ship fades out and you start again beside the Wheel. <b>Reset to starting orbit</b> does the same on request. A three-finger tap opens this menu at any time.</p>
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
        b('Reset to starting orbit', 'undock', () => {
          void confirmDialog({ title: 'Reset to the starting orbit?', message: 'The ship goes back beside Chandler’s Wheel with full tanks, and you stand in the cockpit again.', confirmLabel: 'Reset', cancelLabel: 'Keep flying', icon: 'warning' }, el)
            .then((yes) => {
              if (!yes) return;
              api.hide();
              host.reset();
              api.onResume?.();
            });
        }),
        b('Settings', 'settings', () => api.open('settings')),
        b('How it works', 'info', () => api.open('help')),
        b(`Perf overlay: ${host.perfVisible() ? "on" : "off"}`, 'check', () => { host.setPerfVisible(!host.perfVisible()); api.open('menu'); })),
      h('div.tls-pause__ver', { text: VERSION_LINE }),
    );
  }

  function settings(): void {
    const s = host.settings;
    const q = s.get<string>(SETTING_KEYS.quality, 'auto');
    body.append(
      h('div.tl-label', { text: 'Graphics quality' }),
      SegmentedControl<'auto' | 'low' | 'medium' | 'high'>({
        items: [{ id: 'auto', label: 'Auto' }, { id: 'low', label: 'Low' }, { id: 'medium', label: 'Med' }, { id: 'high', label: 'High' }],
        value: q === 'low' || q === 'medium' || q === 'high' ? q : 'auto', block: true,
        onChange: (v) => { s.set(SETTING_KEYS.quality, v); el.dataset.fx = v === 'low' ? 'lite' : 'full'; },
      }).el,
      h('p.tl-small', { text: 'Auto measures the frame time and lowers the resolution first, then the detail, to stay smooth. The resolution adapts at every setting.' }),
      Slider({
        label: 'Hand and look sensitivity', value: Math.min(2, Math.max(0.5, Number(s.get<number>(SETTING_KEYS.sensitivity, 1)) || 1)), min: 0.5, max: 2, step: 0.1, ticks: 15,
        format: (v) => `${v.toFixed(1)}×`, onChange: (v) => s.set(SETTING_KEYS.sensitivity, Math.round(v * 10) / 10),
      }).el,
      Toggle({ label: 'Invert pitch', hint: 'Finger up on ROTATE raises the nose', value: !!s.get<boolean>(SETTING_KEYS.invertPitch, false), onChange: (v) => s.set(SETTING_KEYS.invertPitch, v) }).el,
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
      title.textContent = view === 'menu' ? 'System' : view === 'settings' ? 'Settings' : 'How it works';
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
