// Flight HUD: thin-line instrumentation on dark glass over the live scene, fed by the Session views only.
// Top: primary body and situation, altitude / speed / apoapsis / periapsis, propellant and Δv, a warning line
// (heat, hull, spin) when something is not nominal, the target chip and a docking / next-burn chip.
// Bottom: undock (when latched), time acceleration (asked vs achieved, and why), hold mode, RCS mode, roll,
// throttle. Direction markers and the target bracket follow scene.project().
import type { UiHost, UiScreen } from '../host';
import type { SceneManager, Projection } from '../../render/scene';
import type { V3 } from '../../core/types';
import { fmtDistance, fmtDuration, fmtSpeed } from '../../core/units';
import type { WarpLimit } from '../../game';
import { h, icon, installStyles, onTap, type IconName } from '../kit';
import { createFlightControls, type FlightControls } from '../controls/controls';
import { createFootHud } from './foot';

const CSS = `
.hud{position:absolute;inset:0;pointer-events:none;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;font-variant-numeric:tabular-nums;
 --gx-l:max(16px,env(safe-area-inset-left,0px));--gx-r:max(16px,env(safe-area-inset-right,0px));--sb:env(safe-area-inset-bottom,0px)}
.hud [hidden]{display:none!important}
.hud button{touch-action:none}
.hud-surface{position:absolute;inset:0;pointer-events:auto;touch-action:none}
.hud-plate{background:rgba(8,12,18,.68);border:1px solid rgba(111,227,255,.22);border-radius:4px;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
.hud-top{position:absolute;left:var(--gx-l);right:var(--gx-r);top:calc(8px + env(safe-area-inset-top,0px));display:flex;flex-wrap:wrap;align-items:flex-start;gap:6px}
.hud-main{flex:1 1 330px;max-width:460px;min-width:0;pointer-events:auto;padding:2px 4px 8px 10px}
.hud-head{display:flex;align-items:center;gap:2px;height:44px}
.hud-sit{flex:1;min-width:0;font-size:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--tl-ion);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hud-ib{width:44px;height:44px;flex:none;display:grid;place-items:center;color:var(--tl-text);border-radius:4px;pointer-events:auto}
.hud-ib.tl-pressed{background:rgba(111,227,255,.16)}
.hud-read{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;padding-right:6px}
.hud-read small{display:block;font-size:10px;letter-spacing:.14em;color:var(--tl-dim);text-transform:uppercase}
.hud-read b{display:block;font-size:15px;font-weight:600;white-space:nowrap}
.hud-read i{display:block;font-style:normal;font-size:11px;color:var(--tl-dim);white-space:nowrap;min-height:15px}
.hud-fuel{display:flex;align-items:center;gap:8px;margin-top:5px;padding-right:6px;font-size:10px;color:var(--tl-dim);letter-spacing:.14em}
.hud-fuel-bar{flex:1;height:4px;background:rgba(255,255,255,.12);border-radius:2px;overflow:hidden}
.hud-fuel-bar i{display:block;height:100%;transform-origin:left;background:var(--tl-ember)}
.hud-fuel-bar i.is-low{background:var(--tl-red)}
.hud-fuel b{color:var(--tl-text);font-weight:600;font-size:12px;letter-spacing:.02em;white-space:nowrap}
.hud-side{flex:1 1 250px;min-width:0;display:flex;flex-direction:column;gap:6px}
.hud-chips{display:flex;gap:6px}
.hud-chip{flex:1 1 0;min-width:0;min-height:48px;padding:5px 10px;pointer-events:auto;text-align:left;display:block}
.hud-chip small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:10px;letter-spacing:.14em;color:var(--tl-dim);text-transform:uppercase}
.hud-chip b{display:block;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hud-chip i{display:block;font-style:normal;font-size:11px;color:var(--tl-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hud-chip--tgt{border-color:rgba(111,227,255,.45)}
.hud-chip--tgt b{color:var(--tl-ion)}
.hud-chip--tgt.tl-pressed{background:rgba(111,227,255,.18)}
.hud-chip--burn b{color:var(--tl-ember)}
.hud-fc{display:flex;align-items:center;gap:8px;pointer-events:auto;padding:0 0 0 10px;min-height:46px;border-color:rgba(255,180,84,.5)}
.hud-fc span{flex:1;min-width:0;font-size:12px;line-height:1.25;color:var(--tl-ember-hi);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.hud-fc.is-bad{border-color:rgba(255,90,77,.6)}
.hud-fc.is-bad span{color:var(--tl-red)}
.hud-fc button{height:46px;flex:none;padding:0 12px;font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--tl-text);border-left:1px solid var(--tl-line-2)}
.hud-fc button.tl-pressed{background:rgba(255,255,255,.1)}
.hud-bottom{position:absolute;left:var(--gx-l);right:var(--gx-r);bottom:calc(10px + var(--sb));display:flex;align-items:flex-end;gap:10px}
.hud-col{position:relative;flex:1 1 auto;min-width:0;max-width:340px;display:flex;flex-direction:column;gap:8px}
.hud-row{display:flex;gap:8px;align-items:stretch}
.hud-btn{pointer-events:auto;min-height:46px;padding:0 10px;border:1px solid rgba(255,255,255,.3);border-radius:4px;background:rgba(8,12,18,.68);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);
 color:var(--tl-text);font-weight:600;font-size:12px;letter-spacing:.12em;text-transform:uppercase;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:0}
.hud-btn.tl-pressed{background:rgba(111,227,255,.22);border-color:var(--tl-ion)}
.hud-btn--sq{width:50px;flex:none;padding:0}
.hud-roll{display:flex;gap:8px}
.hud-primary{width:100%;min-height:52px;font-size:14px;letter-spacing:.1em;border-color:var(--tl-ember);color:var(--tl-ink);background:var(--tl-ember)}
.hud-primary span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hud-primary.tl-pressed{background:var(--tl-ember-hi);border-color:var(--tl-ember-hi)}
.hud-primary[data-tone=ion]{background:rgba(8,12,18,.72);color:var(--tl-ion);border-color:var(--tl-ion)}
.hud-primary[data-tone=green]{background:var(--tl-green);border-color:var(--tl-green)}
.hud-primary[data-tone=red]{background:var(--tl-red);border-color:var(--tl-red)}
.hud-primary[data-tone=dim]{background:rgba(8,12,18,.68);color:var(--tl-dim);border-color:var(--tl-line-2)}
.hud-warp{flex:1 1 0;display:flex;align-items:center;pointer-events:auto;min-width:0}
.hud-warp button{width:46px;height:46px;flex:none;display:grid;place-items:center;color:var(--tl-text)}
.hud-warp button.tl-pressed{background:rgba(111,227,255,.18)}
.hud-warp div{flex:1;min-width:0;text-align:center;line-height:1.15}
.hud-warp b{display:block;font-size:16px;font-weight:600}
.hud-warp b.is-fast{color:var(--tl-ember)}
.hud-warp small{display:block;font-size:10px;color:var(--tl-dim);letter-spacing:.06em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hud-sas{flex:1 1 0;display:flex;min-width:0}
.hud-btn--sas{flex:1;color:var(--tl-ion);border-color:rgba(111,227,255,.45)}
.hud-btn--sas small{color:var(--tl-dim);font-size:10px}
.hud-sas-drawer{position:absolute;left:0;right:0;bottom:calc(100% + 8px);display:grid;grid-template-columns:repeat(3,1fr);gap:4px;padding:6px;pointer-events:auto;background:rgba(8,12,18,.92);z-index:3}
.hud-sas-cell{min-height:54px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--tl-dim);border:1px solid var(--tl-line);border-radius:3px}
.hud-sas-cell.is-on{color:var(--tl-ion);border-color:var(--tl-ion);background:rgba(111,227,255,.1)}
.hud-sas-cell.tl-pressed{background:rgba(111,227,255,.2)}
.hud-thr{flex:none;width:60px;margin-left:auto;display:flex;flex-direction:column;gap:8px}
.hud-thr-track{position:relative;height:190px;pointer-events:auto;touch-action:none;overflow:hidden}
.hud-thr-track.is-lit{border-color:rgba(255,180,84,.7)}
.hud-thr-fill{position:absolute;left:0;right:0;bottom:10px;height:calc(100% - 20px);transform-origin:bottom;transform:scaleY(0);background:linear-gradient(0deg,rgba(255,180,84,.55),rgba(255,180,84,.2))}
.hud-thr-ticks{position:absolute;top:10px;bottom:10px;left:6px;width:8px;background:repeating-linear-gradient(0deg,rgba(255,255,255,.3) 0 1px,transparent 1px 12.5%)}
.hud-thr-thumb{position:absolute;left:3px;right:3px;height:3px;margin-bottom:-1px;bottom:10px;background:var(--tl-ember);box-shadow:0 0 8px var(--tl-ember);border-radius:1px}
.hud-thr-pct{position:absolute;top:8px;left:0;right:0;text-align:center;font-size:15px;font-weight:600;text-shadow:0 0 4px #000}
.hud-thr-cap{position:absolute;bottom:12px;left:0;right:0;text-align:center;font-size:9px;letter-spacing:.16em;color:var(--tl-dim)}
.hud-btn--cut{border-color:rgba(255,90,77,.6);color:var(--tl-red)}
.hud-stick{position:absolute;left:max(92px,24%);bottom:calc(312px + var(--sb));width:112px;height:112px;margin:-56px 0 -56px -56px;border-radius:50%;border:1px solid rgba(111,227,255,.35);opacity:.4;pointer-events:none;background:radial-gradient(circle,rgba(8,12,18,0) 50%,rgba(8,12,18,.4))}
.hud-stick.is-on{opacity:1;border-color:rgba(111,227,255,.75)}
.hud-stick i{position:absolute;left:50%;top:50%;width:46px;height:46px;margin:-23px;border-radius:50%;border:1.5px solid var(--tl-ion);background:rgba(111,227,255,.14)}
.hud-marks{position:absolute;inset:0;overflow:hidden}
.hud-mark{position:absolute;left:-16px;top:-16px;width:32px;height:32px;display:grid;place-items:center;will-change:transform;filter:drop-shadow(0 0 2px rgba(0,0,0,.95))}
.hud-mark.is-off{opacity:.6}
.hud-mark--pro{color:var(--tl-green)}
.hud-mark--retro{color:var(--tl-red)}
.hud-mark--tgt{color:var(--tl-ion)}
.hud-mark--mnv{color:var(--tl-ember)}
.hud-brk{position:absolute;left:0;top:0;will-change:transform}
.hud-brk u{position:absolute;width:9px;height:9px;border:0 solid var(--tl-ion)}
.hud-brk u:nth-child(1){left:0;top:0;border-width:1.5px 0 0 1.5px}
.hud-brk u:nth-child(2){right:0;top:0;border-width:1.5px 1.5px 0 0}
.hud-brk u:nth-child(3){left:0;bottom:0;border-width:0 0 1.5px 1.5px}
.hud-brk u:nth-child(4){right:0;bottom:0;border-width:0 1.5px 1.5px 0}
.hud-brk span{position:absolute;top:calc(100% + 4px);left:50%;transform:translateX(-50%);white-space:nowrap;font-size:11px;font-weight:600;letter-spacing:.08em;padding:2px 6px;background:rgba(8,12,18,.72);border-radius:2px;color:var(--tl-ion)}
.hud-warn{margin-top:5px;padding-right:6px;font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--tl-ember-hi)}
.hud-warn.is-bad{color:var(--tl-red)}
.hud-btn--seat{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;font-size:12px;font-weight:600;letter-spacing:.08em;color:var(--tl-text)}
.hud-btn--seat small{font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--tl-dim);white-space:nowrap}
.hud-btn--leave{flex:1.4 1 0;border-color:rgba(111,227,255,.45);color:var(--tl-ion)}
.hud-btn--leave.is-off{border-color:var(--tl-line-2,rgba(255,255,255,.18));color:var(--tl-dim)}
.hud-btn--leave.is-off small{color:var(--tl-ember-hi)}
.hud-btn--rcs{width:52px;flex:none;padding:0;color:var(--tl-dim)}
.hud-btn--rcs.is-on{background:rgba(255,180,84,.22);border-color:var(--tl-ember);color:var(--tl-ember)}
.hud-stick.is-rcs{border-color:rgba(255,180,84,.8)}
.hud-stick.is-rcs i{border-color:var(--tl-ember);background:rgba(255,180,84,.14)}
.hud-chip--info.is-ready{border-color:var(--tl-green)}
.hud-chip--info.is-ready b{color:var(--tl-green)}
.hud-chip--info.is-dock b{color:var(--tl-ion)}
@media (orientation:landscape){
 .hud-main{flex:0 1 390px}
 .hud-col{margin-left:auto;max-width:300px}
 .hud-thr{margin-left:0}
 .hud-thr-track{height:132px}
 .hud-stick{left:max(130px,16%);bottom:calc(96px + var(--sb))}
 .hud-primary{min-height:48px}
}
`;

const SVG = (d: string): string => `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;

/** Sets textContent only when it changed. */
function text(el: HTMLElement): (s: string) => void {
  let last = '\u0000';
  return (s) => {
    if (s !== last) {
      last = s;
      el.textContent = s;
    }
  };
}

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export interface FlightScreen extends UiScreen {
  controls: FlightControls;
  /** True while the pilot has chosen the view from the seat (SceneFrame.camera.mode 'interior' at the helm eye). */
  readonly cockpit: boolean;
}

const WHY: Record<WarpLimit, string> = { '': '', thrust: 'thrusting', rotation: 'turning', contact: 'in contact', atmosphere: 'in atmosphere', proximity: 'close to something', cpu: 'CPU budget', docked: 'docked', crew: 'on foot' };
const fmtX = (v: number): string => (v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : v >= 10 ? String(Math.round(v)) : String(+v.toFixed(1)));

export function createFlightScreen(host: UiHost, scene: SceneManager, hooks: { pause(): void }): FlightScreen {
  installStyles();
  if (!document.getElementById('tl-hud-css')) {
    const s = document.createElement('style');
    s.id = 'tl-hud-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  const ses = host.session;
  const warp = (dir: -1 | 1): void => {
    if (dir > 0) ses.warpUp();
    else ses.warpDown();
    stamp = 1;
  };
  const controls = createFlightControls(host, { warp, map: () => host.go('map'), pause: hooks.pause });
  // the pilot on foot has a HUD of their own; this screen swaps between the two with Session.mode()
  const foot = createFootHud(host, { pause: hooks.pause });
  let onFoot = false;
  let cockpit = false;

  // ---------------------------------------------------------------- top
  const sit = h('div.hud-sit');
  const mapBtn = h('button.hud-ib', { attrs: { type: 'button', 'aria-label': 'Map' } }, icon('map', 24));
  const menuBtn = h('button.hud-ib', { attrs: { type: 'button', 'aria-label': 'Menu' } });
  menuBtn.innerHTML = SVG('M4 7h16M4 12h16M4 17h16');
  onTap(mapBtn, () => host.go('map'));
  onTap(menuBtn, hooks.pause);
  const cell = (label: string): { el: HTMLElement; v: (s: string) => void; s: (s: string) => void } => {
    const b = h('b');
    const i = h('i');
    return { el: h('div', null, h('small', { text: label }), b, i), v: text(b), s: text(i) };
  };
  const alt = cell('Alt');
  const spd = cell('Speed');
  const ap = cell('Apo');
  const pe = cell('Peri');
  const fuelFill = h('i');
  const fuelDv = h('b');
  const setDv = text(fuelDv);
  const warn = h('div.hud-warn');
  warn.hidden = true;
  const setWarn = text(warn);
  const main = h('div.hud-main.hud-plate', { attrs: { 'data-hud': 'main' } },
    h('div.hud-head', null, sit, mapBtn, menuBtn),
    h('div.hud-read', null, alt.el, spd.el, ap.el, pe.el),
    h('div.hud-fuel', null, h('span', { text: 'PROP' }), h('div.hud-fuel-bar', null, fuelFill), fuelDv),
    warn);

  const tgtName = h('b');
  const tgtSub = h('i');
  const tgt = h('button.hud-chip.hud-chip--tgt.hud-plate', { attrs: { type: 'button', 'aria-label': 'Next target' } }, h('small', { text: 'Target · tap' }), tgtName, tgtSub);
  const infoHead = h('small');
  const infoMain = h('b');
  const infoSub = h('i');
  const info = h('div.hud-chip.hud-chip--burn.hud-chip--info.hud-plate', null, infoHead, infoMain, infoSub);
  const side = h('div.hud-side', null, h('div.hud-chips', null, tgt, info));
  const top = h('div.hud-top', null, main, side);

  /** Stations nearest first, then the bodies; one tap past the end clears the target. */
  const targetIds = (): string[] => {
    const craft = ses.craft();
    let px = 0, py = 0, pz = 0;
    for (const c of craft) if (c.isPlayer) { px = c.r.x; py = c.r.y; pz = c.r.z; }
    const st = craft.filter((c) => c.kind === 'station').map((c) => ({ id: c.id, d: Math.hypot(c.r.x - px, c.r.y - py, c.r.z - pz) })).sort((a, b) => a.d - b.d).map((c) => c.id);
    return [...st, ...ses.bodies().map((b) => b.id)];
  };
  onTap(tgt, () => {
    const ids = targetIds();
    const cur = ses.target();
    const i = cur ? ids.indexOf(cur.id) : -1;
    ses.setTarget(i + 1 < ids.length ? ids[i + 1] : null);
    stamp = 1;
  });

  // ---------------------------------------------------------------- bottom
  const primaryLabel = h('span');
  const primary = h('button.hud-btn.hud-primary', { attrs: { type: 'button' } }, primaryLabel);
  primary.hidden = true;
  const setPrimaryText = text(primaryLabel);
  let primaryAct: (() => void) | null = null;
  onTap(primary, () => {
    primaryAct?.();
    stamp = 1;
  });
  const warpDown = h('button', { attrs: { type: 'button', 'aria-label': 'Slower time' } });
  warpDown.innerHTML = SVG('M12 6l-6 6 6 6M19 6l-6 6 6 6');
  const warpUp = h('button', { attrs: { type: 'button', 'aria-label': 'Faster time' } });
  warpUp.innerHTML = SVG('M12 6l6 6-6 6M5 6l6 6-6 6');
  const warpX = h('b');
  const warpWhy = h('small');
  const warpEl = h('div.hud-warp.hud-plate', null, warpDown, h('div', null, warpX, warpWhy), warpUp);
  onTap(warpDown, () => warp(-1));
  onTap(warpUp, () => warp(1));
  // the seat: view from the cockpit, and unstrap to walk the ship
  const camLabel = h('span', { text: 'CHASE' });
  const camBtn = h('button.hud-btn.hud-btn--seat', { attrs: { type: 'button', 'aria-label': 'Camera view' } }, h('small', { text: 'VIEW' }), camLabel);
  const setCam = text(camLabel);
  onTap(camBtn, () => {
    cockpit = !cockpit;
    controls.camera.yaw = 0;
    controls.camera.pitch = cockpit ? 0 : 0.12;
    setCam(cockpit ? 'COCKPIT' : 'CHASE');
  });
  const leaveLabel = h('span', { text: 'LEAVE SEAT' });
  const leaveWhy = h('small');
  const leaveBtn = h('button.hud-btn.hud-btn--seat.hud-btn--leave', { attrs: { type: 'button' } }, leaveWhy, leaveLabel);
  const setLeaveWhy = text(leaveWhy);
  /** Why the pilot cannot unstrap right now ('' = they can). */
  const seatLock = (): string => {
    const p = ses.player();
    return p.destroyed ? 'ship lost' : p.throttle > 0 ? 'drive is on' : '';
  };
  onTap(leaveBtn, () => {
    const why = seatLock();
    if (why || !ses.leaveHelm()) host.toast(why === 'drive is on' ? 'Cut the drive before you unstrap' : 'You cannot leave the seat right now', 'warn');
    stamp = 1;
  });
  const seatRow = h('div.hud-row', null, camBtn, leaveBtn);
  if (!ses.interior()) seatRow.hidden = true;
  const col = h('div.hud-col', null,
    controls.sasDrawer,
    primary,
    seatRow,
    h('div.hud-row', null, warpEl),
    h('div.hud-row', null, controls.roll, controls.rcs, controls.sas));
  const bottom = h('div.hud-bottom', null, col, controls.throttle);

  // ---------------------------------------------------------------- markers
  const mark = (cls: string, name: IconName): HTMLElement => h(`div.hud-mark.hud-mark--${cls}`, null, icon(name, 28));
  const mPro = mark('pro', 'prograde');
  const mRetro = mark('retro', 'retrograde');
  const mTgt = mark('tgt', 'target');
  const brkLabel = h('span');
  const setBrk = text(brkLabel);
  const brk = h('div.hud-brk', null, h('u'), h('u'), h('u'), h('u'), brkLabel);
  const marks = h('div.hud-marks', null, mPro, mRetro, mTgt, brk);

  const el = h('div.hud', null, controls.surface, controls.stick, marks, top, bottom);
  el.style.display = 'none';

  const proj: Projection = { x: 0, y: 0, visible: false, behind: false, distance: 0, radiusPx: 0, occluded: false };
  const dirRef = { dir: { x: 0, y: 0, z: 0 } as V3 };
  let vw = 0;
  let vh = 0;
  /** Place a marker on a direction; off-screen ones ride the edge (or hide). */
  const placeDir = (m: HTMLElement, x: number, y: number, z: number, edge: boolean): void => {
    const l = Math.hypot(x, y, z);
    if (!(l > 1e-9)) {
      m.hidden = true;
      return;
    }
    dirRef.dir.x = x / l;
    dirRef.dir.y = y / l;
    dirRef.dir.z = z / l;
    const p = scene.project(dirRef, proj);
    if (!p.visible && !edge) {
      m.hidden = true;
      return;
    }
    let px = p.x;
    let py = p.y;
    if (!p.visible) {
      const cx = vw / 2;
      const cy = vh / 2;
      let dx = px - cx;
      let dy = py - cy;
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
        dx = 0;
        dy = 1;
      }
      const k = Math.min((cx - 24) / Math.max(1e-6, Math.abs(dx)), (cy - 24) / Math.max(1e-6, Math.abs(dy)));
      px = cx + dx * k;
      py = cy + dy * k;
    }
    m.hidden = false;
    m.classList.toggle('is-off', !p.visible);
    m.style.transform = `translate(${px.toFixed(1)}px,${py.toFixed(1)}px)`;
  };

  /** Velocity of the player relative to the primary body (world axes) into `out`; false when unknown. */
  const relVel = { x: 0, y: 0, z: 0 };
  const playerRelVel = (): boolean => {
    const craft = ses.craft();
    const bodies = ses.bodies();
    const pid = ses.flight().primaryId;
    let ok = 0;
    for (let i = 0; i < craft.length; i++)
      if (craft[i].isPlayer) {
        relVel.x = craft[i].v.x; relVel.y = craft[i].v.y; relVel.z = craft[i].v.z;
        ok++;
        break;
      }
    for (let i = 0; i < bodies.length; i++)
      if (bodies[i].id === pid) {
        relVel.x -= bodies[i].v.x; relVel.y -= bodies[i].v.y; relVel.z -= bodies[i].v.z;
        ok++;
        break;
      }
    return ok === 2;
  };

  const updateMarkers = (): void => {
    const p = ses.player();
    if (p.dockedTo || p.destroyed) {
      mPro.hidden = mRetro.hidden = mTgt.hidden = brk.hidden = true;
      return;
    }
    if (playerRelVel()) {
      placeDir(mPro, relVel.x, relVel.y, relVel.z, false);
      placeDir(mRetro, -relVel.x, -relVel.y, -relVel.z, false);
    } else mPro.hidden = mRetro.hidden = true;
    const ti = ses.target();
    if (!ti) {
      mTgt.hidden = brk.hidden = true;
      return;
    }
    const pr = scene.project(ti.id, proj);
    if (pr.visible && Number.isFinite(pr.x) && Number.isFinite(pr.y)) {
      const size = Math.min(240, Math.max(40, pr.radiusPx * 2 + 14));
      brk.hidden = false;
      brk.style.width = brk.style.height = `${size.toFixed(0)}px`;
      brk.style.transform = `translate(${(pr.x - size / 2).toFixed(1)}px,${(pr.y - size / 2).toFixed(1)}px)`;
      brk.style.opacity = pr.occluded ? '0.45' : '1';
      setBrk(fmtDistance(ti.distance));
      mTgt.hidden = true;
    } else {
      brk.hidden = true;
      placeDir(mTgt, ti.direction.x, ti.direction.y, ti.direction.z, true);
    }
  };

  // ---------------------------------------------------------------- readouts (a few times a second)
  const setSit = text(sit);
  const setTgtName = text(tgtName);
  const setTgtSub = text(tgtSub);
  const setInfoHead = text(infoHead);
  const setInfoMain = text(infoMain);
  const setInfoSub = text(infoSub);
  const setWarpX = text(warpX);
  const setWarpWhy = text(warpWhy);
  let fuelShown = -1;
  let stamp = 1;
  const tIn = (s: number): string => (Number.isFinite(s) && s >= 0 ? `in ${fmtDuration(s)}` : '');
  const pctOf = (x: number): string => `${Math.round(x * 100)}%`;

  const updateReadouts = (): void => {
    const fi = ses.flight();
    const p = ses.player();
    setSit(`${fi.primaryName} · ${fi.situation}`);
    alt.v(fmtDistance(fi.altitude));
    alt.s(Math.abs(fi.verticalSpeed) >= 0.5 ? `${fi.verticalSpeed > 0 ? '+' : '−'}${fmtSpeed(Math.abs(fi.verticalSpeed))}` : 'level');
    spd.v(fmtSpeed(fi.speed));
    spd.s(fi.accel > 0.005 ? `${fi.accel.toFixed(2)} m/s²` : 'coasting');
    ap.v(Number.isFinite(fi.apoapsisAlt) ? fmtDistance(fi.apoapsisAlt) : 'escape');
    ap.s(tIn(fi.timeToApoapsis));
    pe.v(fmtDistance(fi.periapsisAlt));
    pe.s(tIn(fi.timeToPeriapsis));
    const f = Math.round(p.propellantFraction * 100);
    if (f !== fuelShown) {
      fuelShown = f;
      fuelFill.style.transform = `scaleX(${(f / 100).toFixed(2)})`;
      fuelFill.classList.toggle('is-low', f < 10);
    }
    setDv(`${f}% · Δv ${fmtSpeed(p.deltaV)}`);

    // only what is not nominal
    let w = '';
    if (p.destroyed) w = `Destroyed${p.destroyedBy ? `: ${p.destroyedBy}` : ''}`;
    else {
      if (p.heat > 0.05) w += `Heat ${pctOf(p.heat)}`;
      if (p.hull < 0.995) w += `${w ? ' · ' : ''}Hull ${pctOf(p.hull)}`;
      if (p.spin > 0.03 && (p.hold === 'off' || p.spin > 0.35)) w += `${w ? ' · ' : ''}${p.hold === 'off' ? 'Tumbling' : 'Spin'} ${((p.spin * 180) / Math.PI).toFixed(1)}°/s`;
      if (fi.dynamicPressure > 50) w += `${w ? ' · ' : ''}Q ${(fi.dynamicPressure / 1000).toFixed(1)} kPa`;
    }
    if (warn.hidden === !!w) warn.hidden = !w;
    setWarn(w);
    warn.classList.toggle('is-bad', p.destroyed || p.heat > 0.7 || p.hull < 0.5);

    const ti = ses.target();
    if (ti) {
      setTgtName(ti.name);
      const c = ti.closing;
      setTgtSub(`${fmtDistance(ti.distance)} · ${ti.relSpeed < 0.05 ? 'at rest' : `${fmtSpeed(ti.relSpeed)} ${Math.abs(c) < 0.05 ? 'across' : c > 0 ? 'closing' : 'opening'}`}`);
    } else {
      setTgtName('None');
      setTgtSub('Tap to pick a target');
    }

    // docking guidance when a port is near, else the next planned burn
    const d = ses.docking();
    let mode = '';
    if (!p.dockedTo && d.stationId && d.portId && d.distance < 5000) {
      // the world's own docking read-out: collar-to-port distance, offset from the port axis, collar alignment,
      // closing speed against the station — the latch closes when all of them are inside its tolerances
      mode = d.canLatch ? 'ready' : 'dock';
      const closing = d.closing;
      const ac = Math.abs(closing);
      setInfoHead(`Port ${d.portId} · ${d.portDistance < 100 ? `${d.portDistance.toFixed(1)} m` : fmtDistance(d.portDistance)}`);
      setInfoMain(d.canLatch ? 'Latch ready' : `${d.lateral < 100 ? `${d.lateral.toFixed(1)} m` : fmtDistance(d.lateral)} off axis`);
      setInfoSub(`${((d.alignment * 180) / Math.PI).toFixed(0)}° off · ${ac < 0.005 ? 'holding' : `${ac < 10 ? `${ac.toFixed(2)} m/s` : fmtSpeed(ac)} ${closing > 0 ? 'closing' : 'opening'}`}`);
    } else if (!p.dockedTo && d.stationId && d.distance < 5000) {
      mode = 'dock';
      setInfoHead('Station near');
      setInfoMain(fmtDistance(d.distance));
      setInfoSub(`${fmtSpeed(d.relSpeed)} relative · no port in reach`);
    } else {
      const now = ses.time();
      const burns = ses.burns();
      let next = null;
      for (let i = 0; i < burns.length; i++) if (burns[i].t >= now - 1 && (!next || burns[i].t < next.t)) next = burns[i];
      setInfoHead('Next burn');
      if (next) {
        setInfoMain(`T− ${fmtDuration(Math.max(0, next.t - now))}`);
        setInfoSub(`Δv ${fmtSpeed(Math.hypot(next.prograde, next.normal, next.radial))}`);
      } else {
        setInfoMain('—');
        setInfoSub('Plan one on the map');
      }
      info.style.opacity = next ? '1' : '0.6';
    }
    if (mode) info.style.opacity = '1';
    info.classList.toggle('is-dock', mode === 'dock');
    info.classList.toggle('is-ready', mode === 'ready');

    const wv = ses.warp();
    setWarpX(`×${fmtX(wv.achieved)}`);
    warpX.classList.toggle('is-fast', wv.achieved > 1.05);
    const limited = wv.limitedBy !== '' || wv.achieved < wv.requested * 0.9;
    setWarpWhy(limited ? `asked ×${fmtX(wv.requested)} · ${WHY[wv.limitedBy] || 'limited'}` : wv.requested > 1 ? 'time acceleration' : 'real time');

    // the one situational action: undock when latched, reset when the ship is gone
    let label = '';
    let tone = 'ember';
    let act: (() => void) | null = null;
    if (p.destroyed) {
      label = 'Ship destroyed · reset to orbit';
      tone = 'red';
      act = () => host.reset();
    } else if (p.dockedTo) {
      const id = p.dockedTo;
      const st = ses.craft().find((c) => c.id === id);
      label = `Undock${st ? ` from ${st.name}` : ''}`;
      act = () => {
        if (!ses.undock()) host.toast('The latch did not release', 'warn');
      };
    }
    if (primary.hidden === !!label) primary.hidden = !label;
    if (label) {
      setPrimaryText(label);
      if (primary.dataset.tone !== tone) primary.dataset.tone = tone;
    }
    primaryAct = act;
    const lock = seatLock();
    leaveBtn.classList.toggle('is-off', lock !== '');
    setLeaveWhy(lock || 'walk the ship');
  };
  const setMode = (foot_: boolean): void => {
    onFoot = foot_;
    const shown = el.style.display !== 'none' || foot.el.style.display !== 'none';
    if (!shown) return;
    el.style.display = foot_ ? 'none' : '';
    controls.setActive(!foot_);
    foot.setActive(foot_);
    stamp = 1;
  };

  return {
    el,
    controls,
    get cockpit() {
      return cockpit && !onFoot;
    },
    show() {
      if (!el.isConnected) host.root.appendChild(el);
      if (!foot.el.isConnected) host.root.appendChild(foot.el);
      onFoot = ses.mode() === 'onFoot';
      el.style.display = onFoot ? 'none' : '';
      controls.setActive(!onFoot);
      foot.setActive(onFoot);
      // a sensible default target: the nearest station
      if (!ses.target()) {
        const ids = targetIds();
        if (ids.length) ses.setTarget(ids[0]);
      }
      stamp = 1;
    },
    hide() {
      el.style.display = 'none';
      controls.setActive(false);
      foot.setActive(false);
    },
    update(dt) {
      if ((ses.mode() === 'onFoot') !== onFoot) setMode(!onFoot);
      if (onFoot) {
        foot.update(dt);
        return;
      }
      vw = el.clientWidth;
      vh = el.clientHeight;
      controls.update(dt);
      updateMarkers();
      stamp += dt;
      if (stamp >= 0.2) {
        stamp = 0;
        updateReadouts();
      }
    },
    dispose() {
      controls.dispose();
      foot.dispose();
      el.remove();
    },
  };
}
