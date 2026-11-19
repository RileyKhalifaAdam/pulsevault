// On-foot HUD: where the pilot is, what the body feels, the boots, and the handful of things hands can do.
// Shown by the flight screen (hud.ts) while Session.mode() is 'onFoot'. Reuses the flight HUD's plate, button
// and stick styles; the layout works in portrait and landscape and respects the safe areas.
import type { UiHost } from '../host';
import { createFootControls, press, type FootControls } from '../controls/foot';
import { h } from '../kit';

const CSS = `
.foot-top{position:absolute;left:var(--gx-l);right:var(--gx-r);top:calc(58px + env(safe-area-inset-top,0px));display:flex;align-items:flex-start;gap:8px}
.foot-info{flex:0 1 auto;min-width:0;max-width:min(330px,calc(100% - 52px));padding:8px 12px 9px}
.foot-room{display:block;font-size:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--tl-ion);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.foot-felt{display:flex;align-items:center;gap:6px;margin-top:3px;font-size:17px;font-weight:600;color:var(--tl-text);white-space:nowrap}
.foot-felt.is-load{color:var(--tl-ember-hi)}
.foot-arrow{display:inline-grid;place-items:center;width:20px;height:20px;flex:none;will-change:transform}
.foot-arrow[hidden]{display:none}
.foot-sub{display:block;margin-top:2px;font-size:11px;color:var(--tl-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.foot-boots{display:block;margin-top:5px;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--tl-dim)}
.foot-boots[data-s=grip]{color:var(--tl-green)}
.foot-boots[data-s=loose]{color:var(--tl-ember-hi)}
.foot-menu{margin-left:auto;background:rgba(8,12,18,.68);border:1px solid rgba(111,227,255,.22)}
.foot-dot{position:absolute;left:50%;top:50%;width:5px;height:5px;margin:-2.5px;border-radius:50%;background:rgba(232,238,245,.7);box-shadow:0 0 0 1px rgba(8,12,18,.6)}
.foot-pad{position:absolute;right:var(--gx-r);bottom:calc(14px + var(--sb));width:min(230px,56%);display:flex;flex-direction:column;gap:8px}
.foot-pad .hud-btn{flex:1 1 0;min-height:52px;min-width:0;font-size:13px;font-weight:600;letter-spacing:.08em;color:var(--tl-text);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px}
.foot-pad .hud-btn small{font-size:10px;font-weight:600;letter-spacing:.1em;color:var(--tl-dim)}
.foot-pad .hud-btn[aria-pressed=true]{border-color:var(--tl-green)}
.foot-pad .hud-btn[aria-pressed=true] small{color:var(--tl-green)}
.foot-act{min-height:56px!important;flex:none!important;color:var(--tl-ink)!important;font-size:14px!important}
.foot-stand{flex:none!important;border-color:var(--tl-ion)!important;color:var(--tl-ion)!important}
.foot-stick{left:max(92px,24%);bottom:calc(120px + var(--sb));opacity:.28}
.foot-sleep{position:absolute;left:50%;top:42%;transform:translate(-50%,-50%);max-width:calc(100% - 2*var(--gx-l));padding:14px 18px;text-align:center;pointer-events:none}
.foot-sleep b{display:block;font-size:16px;font-weight:600;color:var(--tl-text);white-space:nowrap}
.foot-sleep span{display:block;margin-top:4px;font-size:12px;color:var(--tl-dim);white-space:nowrap}
.foot.is-asleep{background:rgba(2,4,8,.72)}
@media (orientation:landscape){
 .foot-top{top:calc(8px + env(safe-area-inset-top,0px));left:calc(var(--gx-l) + 0px)}
 .foot-info{max-width:min(300px,34%)}
 .foot-pad{width:min(250px,34%)}
 .foot-stick{left:max(130px,16%);bottom:calc(96px + var(--sb))}
 .foot-sleep{top:46%}
}
`;

const ARROW = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V5M6 11l6-6 6 6"/></svg>';
const MENU = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
const G0 = 9.80665;

/** Text setter that only touches the DOM on a change. */
function text(el: HTMLElement): (s: string) => void {
  let last = '';
  return (s) => {
    if (s !== last) {
      last = s;
      el.textContent = s;
    }
  };
}
const two = (n: number): string => (n < 10 ? `0${n}` : String(n));
export function fmtClock(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `Day ${Math.floor(s / 86400) + 1} · ${two(Math.floor(s / 3600) % 24)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
}
const fmtMult = (x: number): string => `×${Math.round(x).toLocaleString('en-US')}`;

export interface FootHud {
  el: HTMLElement;
  controls: FootControls;
  update(dt: number): void;
  setActive(on: boolean): void;
  dispose(): void;
}

export function createFootHud(host: UiHost, hooks: { pause(): void }): FootHud {
  if (!document.getElementById('tl-foot-css')) {
    const s = document.createElement('style');
    s.id = 'tl-foot-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  const ses = host.session;
  const controls = createFootControls(host);

  // ---------------------------------------------------------------- top: room, felt acceleration, boots, clock
  const room = h('b.foot-room');
  const arrow = h('i.foot-arrow');
  arrow.innerHTML = ARROW;
  const feltText = h('span');
  const felt = h('div.foot-felt', null, arrow, feltText);
  const sub = h('span.foot-sub');
  const boots = h('span.foot-boots');
  const info = h('div.foot-info.hud-plate', { attrs: { 'data-hud': 'foot' } }, room, felt, boots, sub);
  const menuBtn = h('button.hud-ib.foot-menu', { attrs: { type: 'button', 'aria-label': 'Menu' } });
  menuBtn.innerHTML = MENU;
  press(menuBtn, hooks.pause);
  const top = h('div.foot-top', null, info, menuBtn);
  const setRoom = text(room);
  const setFelt = text(feltText);
  const setSub = text(sub);
  const setBootsText = text(boots);

  // ---------------------------------------------------------------- bottom right: what hands and feet can do
  const actLabel = h('span');
  const act = h('button.hud-btn.hud-primary.foot-act', { attrs: { type: 'button' } }, actLabel);
  const setAct = text(actLabel);
  press(act, () => {
    if (ses.player().destroyed) host.reset();
    else if (!ses.interact()) host.toast('Nothing in reach', 'info');
    stamp = 1;
  });
  const stand = h('button.hud-btn.foot-stand', { attrs: { type: 'button' }, text: 'STAND UP' });
  press(stand, () => {
    ses.standUp();
    stamp = 1;
  });
  const bootsState = h('small');
  const bootsBtn = h('button.hud-btn', { attrs: { type: 'button', 'aria-label': 'Magnetic boots', 'aria-pressed': 'true' } }, h('span', { text: 'BOOTS' }), bootsState);
  const setBootsState = text(bootsState);
  press(bootsBtn, () => {
    ses.setBoots(!ses.crew().boots);
    stamp = 1;
  });
  const jumpLabel = h('span');
  const jumpHint = h('small');
  const jump = h('button.hud-btn', { attrs: { type: 'button' } }, jumpLabel, jumpHint);
  const setJump = text(jumpLabel);
  const setJumpHint = text(jumpHint);
  press(jump, () => {
    ses.pushOff();
    stamp = 1;
  });
  const row = h('div.hud-row', null, bootsBtn, jump);
  const pad = h('div.foot-pad', null, act, stand, row);

  // ---------------------------------------------------------------- asleep
  const sleepTitle = h('b');
  const sleepSub = h('span');
  const sleep = h('div.foot-sleep.hud-plate', null, sleepTitle, sleepSub);
  const setSleepTitle = text(sleepTitle);
  const setSleepSub = text(sleepSub);
  const dot = h('div.foot-dot');

  const el = h('div.hud.foot', null, controls.surface, controls.stick, dot, top, pad, sleep);
  el.style.display = 'none';

  let stamp = 1;
  const show = (node: HTMLElement, on: boolean): void => {
    if (node.hidden === on) node.hidden = !on;
  };
  let lastRot = '';
  const refresh = (): void => {
    const c = ses.crew();
    const held = c.posture === 'seated' || c.posture === 'lying';
    setRoom(c.roomName || 'Aboard');

    // what the body feels: free fall, or the acceleration in g with where it pushes
    const f = c.felt;
    const mag = Math.hypot(f.x, f.y, f.z);
    const g = mag / G0;
    if (g < 0.005) {
      setFelt('Free fall');
      show(arrow, false);
      felt.classList.remove('is-load');
    } else {
      const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw);
      const right = f.x * cy - f.z * sy, ahead = -f.x * sy - f.z * cy;
      const flat = Math.hypot(f.x, f.z);
      let where: string;
      let rot: number;
      if (Math.abs(f.y) > flat) {
        where = f.y < 0 ? 'to the deck' : 'to the overhead';
        rot = f.y < 0 ? 180 : 0;
      } else {
        where = Math.abs(f.z) >= Math.abs(f.x) ? (f.z > 0 ? 'aft' : 'forward') : f.x > 0 ? 'to starboard' : 'to port';
        rot = (Math.atan2(right, ahead) * 180) / Math.PI; // up the screen = the way the pilot faces
      }
      setFelt(`${g < 0.1 ? g.toFixed(3) : g.toFixed(2)} g ${where}`);
      show(arrow, true);
      const r = `rotate(${rot.toFixed(0)}deg)`;
      if (r !== lastRot) {
        lastRot = r;
        arrow.style.transform = r;
      }
      felt.classList.toggle('is-load', mag > 1);
    }

    const state = held ? 'held' : !c.boots ? 'off' : c.gripped ? 'grip' : 'loose';
    if (boots.dataset.s !== state) boots.dataset.s = state;
    setBootsText(c.posture === 'lying' ? 'In the bunk' : c.posture === 'seated' ? 'Seated' : !c.boots ? 'Boots off · floating' : c.gripped ? 'Boots on · gripping the deck' : mag > 3.9 ? 'Boots on · no grip' : 'Boots on · no deck in reach');
    setSub(fmtClock(ses.time()));

    // buttons
    const p = c.prompt;
    const dead = ses.player().destroyed;
    show(act, dead || (!!p && !c.asleep));
    if (dead) setAct('Ship destroyed · reset to orbit');
    else if (p) setAct(p.kind === 'lights' ? (ses.cabinLights() ? 'Turn the lights off' : 'Turn the lights on') : p.kind === 'hatch' ? 'Try the docking hatch' : p.kind === 'reactor' ? 'Check the reactor' : p.label);
    show(controls.stick, !held);
    show(stand, held && !c.asleep);
    show(row, !held);
    const on = c.boots ? 'true' : 'false';
    if (bootsBtn.getAttribute('aria-pressed') !== on) bootsBtn.setAttribute('aria-pressed', on);
    setBootsState(c.boots ? 'ON' : 'OFF');
    setJump(c.gripped ? 'JUMP' : 'PUSH OFF');
    setJumpHint(c.gripped ? 'off the deck' : 'where you look');

    // asleep
    show(sleep, c.asleep);
    show(dot, !c.asleep && !held);
    el.classList.toggle('is-asleep', c.asleep);
    if (c.asleep) {
      const w = ses.warp();
      setSleepTitle(`Asleep · ${fmtMult(Math.max(1, w.achieved))} · tap to wake`);
      setSleepSub(fmtClock(ses.time()));
    }
  };

  return {
    el,
    controls,
    update(dt) {
      controls.update(dt);
      stamp += dt;
      if (stamp >= 0.1) {
        stamp = 0;
        refresh();
      }
    },
    setActive(on) {
      el.style.display = on ? '' : 'none';
      controls.setActive(on);
      stamp = 1;
    },
    dispose() {
      controls.dispose();
      el.remove();
    },
  };
}
