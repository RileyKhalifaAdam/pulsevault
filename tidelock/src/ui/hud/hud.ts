// Flight HUD: thin-line instrumentation on dark glass over the live scene. Top: situation, orbit figures,
// propellant, target and next-burn chips, flight-computer line. Bottom: one primary action that follows the
// situation, time warp, SAS, roll, throttle. Direction markers and the target bracket follow scene.project().
import type { UiHost, UiScreen } from '../host';
import type { SceneManager, Projection } from '../../render/scene';
import type { V3 } from '../../core/types';
import { fmtCredits, fmtDistance, fmtDuration, fmtSpeed } from '../../core/units';
import { h, icon, installStyles, onTap, type IconName } from '../kit';
import { createFlightControls, type FlightControls } from '../controls/controls';

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
}

export function createFlightScreen(host: UiHost, scene: SceneManager, hooks: { pause(): void }): FlightScreen {
  installStyles();
  if (!document.getElementById('tl-hud-css')) {
    const s = document.createElement('style');
    s.id = 'tl-hud-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  const fail = (r: { ok: true } | { ok: false; reason: string }): void => {
    if (!r.ok) host.toast(r.reason, 'warn');
  };
  const warp = (dir: -1 | 1): void => fail(dir > 0 ? host.game.warpUp() : host.game.warpDown());
  const controls = createFlightControls(host, { warp, map: () => host.go('map'), pause: hooks.pause });

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
  const main = h('div.hud-main.hud-plate', null,
    h('div.hud-head', null, sit, mapBtn, menuBtn),
    h('div.hud-read', null, alt.el, spd.el, ap.el, pe.el),
    h('div.hud-fuel', null, h('span', { text: 'PROP' }), h('div.hud-fuel-bar', null, fuelFill), fuelDv));

  const tgtName = h('b');
  const tgtSub = h('i');
  const tgt = h('button.hud-chip.hud-chip--tgt.hud-plate', { attrs: { type: 'button' } }, h('small', { text: 'Target · tap' }), tgtName, tgtSub);
  const burnMain = h('b');
  const burnSub = h('i');
  const burn = h('div.hud-chip.hud-chip--burn.hud-plate', null, h('small', { text: 'Next burn' }), burnMain, burnSub);
  const fcText = h('span');
  const fcBtn = h('button', { attrs: { type: 'button' }, text: 'Disengage' });
  const fc = h('div.hud-fc.hud-plate', null, fcText, fcBtn);
  fc.hidden = true;
  onTap(fcBtn, () => host.game.disengageAutopilot());
  const side = h('div.hud-side', null, h('div.hud-chips', null, tgt, burn), fc);
  const top = h('div.hud-top', null, main, side);

  const stationIds = (): string[] =>
    host.game.contacts().filter((c) => c.kind === 'station').map((c) => ({ id: c.ref.id, d: c.distance })).sort((a, b) => a.d - b.d).map((c) => c.id);
  onTap(tgt, () => {
    const ids = stationIds();
    if (!ids.length) return;
    const cur = host.game.target();
    const i = cur ? ids.indexOf(cur.id) : -1;
    fail(host.game.setTarget({ kind: 'station', id: ids[(i + 1) % ids.length] }));
    stamp = 1;
  });

  // ---------------------------------------------------------------- bottom
  const primaryLabel = h('span');
  const primary = h('button.hud-btn.hud-primary', { attrs: { type: 'button' } }, primaryLabel);
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
  const col = h('div.hud-col', null,
    controls.sasDrawer,
    primary,
    h('div.hud-row', null, warpEl),
    h('div.hud-row', null, controls.roll, controls.sas));
  const bottom = h('div.hud-bottom', null, col, controls.throttle);

  // ---------------------------------------------------------------- markers
  const mark = (cls: string, name: IconName): HTMLElement => h(`div.hud-mark.hud-mark--${cls}`, null, icon(name, 28));
  const mPro = mark('pro', 'prograde');
  const mRetro = mark('retro', 'retrograde');
  const mTgt = mark('tgt', 'target');
  const mMnv = mark('mnv', 'node');
  const brkLabel = h('span');
  const setBrk = text(brkLabel);
  const brk = h('div.hud-brk', null, h('u'), h('u'), h('u'), h('u'), brkLabel);
  const marks = h('div.hud-marks', null, mPro, mRetro, mMnv, mTgt, brk);

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
      // slide along the line from the screen centre to the (possibly far off-screen) point
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

  const updateMarkers = (): void => {
    const g = host.game;
    const pose = g.shipPose();
    if (pose.docked || pose.destroyed) {
      mPro.hidden = mRetro.hidden = mTgt.hidden = mMnv.hidden = brk.hidden = true;
      return;
    }
    const v = pose.v;
    placeDir(mPro, v.x, v.y, v.z, false);
    placeDir(mRetro, -v.x, -v.y, -v.z, false);
    const node = g.flightInfo().nextNode;
    if (node) placeDir(mMnv, node.dir.x, node.dir.y, node.dir.z, true);
    else mMnv.hidden = true;
    const ti = g.targetInfo();
    if (!ti) {
      mTgt.hidden = brk.hidden = true;
      return;
    }
    const p = scene.project(ti.ref.id, proj);
    if (p.visible && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      const size = Math.min(240, Math.max(40, p.radiusPx * 2 + 14));
      brk.hidden = false;
      brk.style.width = brk.style.height = `${size.toFixed(0)}px`;
      brk.style.transform = `translate(${(p.x - size / 2).toFixed(1)}px,${(p.y - size / 2).toFixed(1)}px)`;
      brk.style.opacity = p.occluded ? '0.45' : '1';
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
  const setBurnMain = text(burnMain);
  const setBurnSub = text(burnSub);
  const setFc = text(fcText);
  const setWarpX = text(warpX);
  const setWarpWhy = text(warpWhy);
  let fuelShown = -1;
  let stamp = 1;
  const setPrimary = (label: string, tone: string, act: (() => void) | null): void => {
    setPrimaryText(label);
    if (primary.dataset.tone !== tone) primary.dataset.tone = tone;
    primaryAct = act;
  };
  const tIn = (s: number): string => (Number.isFinite(s) ? `in ${fmtDuration(s)}` : '');

  const updateReadouts = (): void => {
    const g = host.game;
    const fi = g.flightInfo();
    setSit(`${fi.soiBodyName} · ${fi.situation}`);
    alt.v(fmtDistance(fi.altitude));
    alt.s(Math.abs(fi.verticalSpeed) >= 0.5 ? `${fi.verticalSpeed > 0 ? '+' : '−'}${fmtSpeed(Math.abs(fi.verticalSpeed))}` : 'level');
    spd.v(fmtSpeed(fi.orbitalSpeed));
    spd.s(fi.throttle > 0 ? `${(fi.maxAccel * fi.throttle).toFixed(1)} m/s²` : 'coasting');
    ap.v(Number.isFinite(fi.apoapsisAltitude) ? fmtDistance(fi.apoapsisAltitude) : 'escape');
    ap.s(tIn(fi.timeToApoapsis));
    pe.v(fmtDistance(fi.periapsisAltitude));
    pe.s(tIn(fi.timeToPeriapsis));
    const f = Math.round(fi.propellantFraction * 100);
    if (f !== fuelShown) {
      fuelShown = f;
      fuelFill.style.transform = `scaleX(${(f / 100).toFixed(2)})`;
      fuelFill.classList.toggle('is-low', f < 10);
    }
    setDv(`${f}% · Δv ${fmtSpeed(fi.deltaV)}`);

    const ti = g.targetInfo();
    if (ti) {
      setTgtName(ti.name);
      const c = ti.closingSpeed;
      setTgtSub(`${fmtDistance(ti.distance)} · ${Math.abs(c) < 0.05 ? 'holding' : `${fmtSpeed(Math.abs(c))} ${c > 0 ? 'closing' : 'opening'}`}`);
    } else {
      setTgtName('None');
      setTgtSub('Tap to pick a station');
    }
    const n = fi.nextNode;
    if (n) {
      setBurnMain(n.burnStartsIn > 0 ? `T− ${fmtDuration(n.burnStartsIn)}` : 'Burning');
      setBurnSub(`Δv ${fmtSpeed(n.dvRemaining)} · ${fmtDuration(n.burnDuration)}`);
    } else {
      setBurnMain('—');
      setBurnSub('No burn planned');
    }
    burn.style.opacity = n ? '1' : '0.6';

    const apv = g.autopilot();
    const fcOn = apv.engaged || !!apv.failed;
    if (fc.hidden === fcOn) fc.hidden = !fcOn;
    if (fcOn) {
      setFc(apv.engaged ? apv.status || 'Flight computer engaged' : `Flight computer: ${apv.failed}`);
      fc.classList.toggle('is-bad', !apv.engaged);
      fcBtn.hidden = !apv.engaged;
    }

    const w = g.warp();
    setWarpX(`×${w.level >= 1000 ? `${w.level / 1000}k` : w.level}`);
    warpX.classList.toggle('is-fast', w.level > 1);
    setWarpWhy(w.limitReason || (w.level > 1 ? 'time warp' : 'real time'));

    // the one primary action
    const d = g.dockingState();
    const pose = g.shipPose();
    const target = g.target();
    if (pose.destroyed) {
      const q = g.rebuyQuote();
      setPrimary(`Ship lost · replacement ${fmtCredits(q.cost)}`, 'red', () => fail(g.rebuy()));
    } else if (d.transit === 'capture' || d.tug) {
      setPrimary(`Tug docking · ${Math.max(0, Math.ceil(d.transitSeconds))} s`, 'dim', null);
    } else if (d.transit === 'release') {
      setPrimary(`Clearing the berth · ${Math.max(0, Math.ceil(d.transitSeconds))} s`, 'dim', null);
    } else if (d.granted) {
      setPrimary('Docking cleared · cancel', 'ion', () => g.cancelDocking());
    } else if (d.canRequest) {
      setPrimary('Request docking', 'green', () => fail(g.requestDocking()));
    } else if (fi.canCallTender) {
      const q = g.tenderQuote();
      setPrimary(`Call fuel tender · ${fmtCredits(q.cost)}`, 'ember', () => fail(g.callTender()));
    } else if (apv.engaged) {
      setPrimary(`Flying: ${cap(apv.phase || apv.mode)}`, 'dim', null);
    } else if (target && target.kind === 'station' && ti) {
      const id = target.id;
      setPrimary(`Go to ${ti.name}`, 'ember', () => fail(g.engageAutopilot({ kind: 'goToStation', stationId: id })));
    } else {
      setPrimary('Select a destination', 'ion', () => host.go('map'));
    }
  };

  return {
    el,
    controls,
    show() {
      if (!el.isConnected) host.root.appendChild(el);
      el.style.display = '';
      controls.setActive(true);
      // A sensible default destination: the nearest station that is not the one we just left.
      const g = host.game;
      if (!g.target() && !g.shipPose().docked) {
        const far = g.contacts().filter((c) => c.kind === 'station' && c.distance > 5000).map((c) => ({ id: c.ref.id, d: c.distance })).sort((a, b) => a.d - b.d)[0];
        if (far) g.setTarget({ kind: 'station', id: far.id });
      }
      stamp = 1;
    },
    hide() {
      el.style.display = 'none';
      controls.setActive(false);
    },
    update(dt) {
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
      el.remove();
    },
  };
}
