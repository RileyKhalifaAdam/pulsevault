// Pause menu: resume, reset to the starting orbit, settings, how it works, performance overlay. An overlay above whichever screen is showing.
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
<p>A physics sandbox. Your ship is a rigid body in low orbit of Wick, beside Chandler’s Wheel. It moves only because forces act on it: gravity from every world, your main drive, your thrusters, air, and contact.</p>
<h3>The read-outs</h3>
<p><b>ALT</b> is height above the surface, with your climb or sink rate under it. <b>SPEED</b> is speed relative to the world you are closest bound to. <b>APO</b> and <b>PERI</b> are the highest and lowest points of the orbit you are on right now, each with the time until you reach it. <b>PROP</b> shows propellant and <b>Δv</b>: how much speed change is left in the tanks. A warning line appears only when something is off: heat, hull, tumbling.</p>
<h3>How thrust changes an orbit</h3>
<p>You do not steer toward things. Burn <i>prograde</i> (along your motion, the green marker) and the opposite side of your orbit rises; burn <i>retrograde</i> (red marker) and it falls. Burn at periapsis to move the apoapsis, and at apoapsis to move the periapsis. Normal and anti-normal tilt the orbit; radial burns rotate it.</p>
<h3>Holds</h3>
<p>The <b>hold</b> button asks the attitude system to turn the ship with real torque and keep it pointed: prograde, retrograde, normal, radial, at the target, or along a planned burn. <b>Hold</b> alone stops the rotation. <b>Off</b> leaves the ship with whatever spin it has. Turning takes time; wait for the nose before you burn.</p>
<h3>Time acceleration</h3>
<p>The arrows speed time up. The world takes more or larger steps under the same laws, so the request is a wish: while you thrust, turn, touch something or fly through air it runs slower, and the HUD shows what you asked for, what you got, and why.</p>
<h3>The map</h3>
<p>The line is your predicted path, with apoapsis, periapsis, closest approach to the target, atmosphere entry and impact marked. Tap the path to plan a burn there, then set its prograde, normal and radial parts and slide it in time: the path shows what would happen. A plan flies nothing. Point the ship (hold: Burn) and work the throttle yourself.</p>
<h3>Docking by latch</h3>
<p>Match speed with the station first (target chip: relative speed near zero). Close in slowly. Near a port the docking chip shows how far you are off its axis, how far your nose is off, and your closing speed. Switch on <b>RCS</b>: the stick then pushes the ship sideways and up or down, and the two roll buttons push back and forward. Arrive slow and aligned and the latch closes by itself when the chip reads <b>Latch ready</b>. Arrive fast and you bounce, or break.</p>
<h3>Living aboard</h3>
<p>You are a body inside the ship. At the helm, <b>View</b> switches between the chase camera and the pilot’s eyes, and <b>Leave seat</b> unstraps you. On foot the left thumb walks, dragging on the right looks around, and the big button names whatever is in reach: the light switch, the galley, the window seat, a bunk, and the pilot seat to take the helm again.</p>
<p>The ship is in free fall, so nothing holds you down. <b>Boots on</b>: magnets grip the deck and you walk. <b>Boots off</b>: you float, and <b>Push off</b> sends you the way you are looking until you meet a wall. Switch the boots back on near the deck to stand again.</p>
<p>When the drive fires, the ship accelerates and everything loose falls toward the stern at up to 1.2 g. That is why you can only unstrap with the drive off, and why you strap in before a burn. The plate at the top left shows what your body feels.</p>
<p>Time runs at ×1 while you are on your feet. To pass the time, lie down in the bunk and tap <b>Sleep</b>: the hours run fast until you touch the screen or something disturbs the ship.</p>
<h3>If it goes wrong</h3>
<p><b>Reset to starting orbit</b> puts you back beside the Wheel with full tanks.</p>
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
          void confirmDialog({ title: 'Reset to the starting orbit?', message: 'The ship goes back beside Chandler’s Wheel with full tanks. Planned burns are cleared.', confirmLabel: 'Reset', cancelLabel: 'Keep flying', icon: 'warning' }, el)
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
      title.textContent = view === 'menu' ? 'Paused' : view === 'settings' ? 'Settings' : 'How it works';
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
