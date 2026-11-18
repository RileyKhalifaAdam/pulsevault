// The four top-level screens the app mounts. The real ones live in src/ui/screens (another engineer's module);
// this file is the single seam: when that module is present, the REAL block at the bottom re-exports it,
// otherwise the small working fallbacks below keep the game playable end to end.
import type { UiHost, UiScreen } from '../ui/host';
import { Button, h, installStyles, setText } from '../ui/kit';
import { fmtCredits, fmtDistance, fmtInt } from '../core/units';

const CSS = `
.fb{position:absolute;inset:0;display:flex;flex-direction:column;box-sizing:border-box;pointer-events:auto;
 padding:calc(16px + env(safe-area-inset-top,0px)) max(16px,env(safe-area-inset-right,0px)) calc(16px + env(safe-area-inset-bottom,0px)) max(16px,env(safe-area-inset-left,0px));}
.fb--title{justify-content:flex-end;align-items:center;gap:12px;background:linear-gradient(180deg,rgba(5,7,11,.15),rgba(5,7,11,0) 40%,rgba(5,7,11,.82));}
.fb-word{margin-bottom:auto;margin-top:14%;text-align:center}
.fb-word b{display:block;font-size:34px;font-weight:600;letter-spacing:.42em;margin-right:-.42em;color:var(--tl-text)}
.fb-word span{display:block;margin-top:10px;font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--tl-ember)}
.fb-stack{display:flex;flex-direction:column;gap:10px;width:100%;max-width:340px}
.fb--panel{background:rgba(5,7,11,.78);gap:10px}
.fb-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex:none}
.fb-head h1{font-size:17px;font-weight:600;letter-spacing:.1em;text-transform:uppercase}
.fb-head span{color:var(--tl-ember);font-size:15px}
.fb-sub{color:var(--tl-dim);font-size:12px;letter-spacing:.06em;flex:none}
.fb-list{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;touch-action:pan-y;border:1px solid var(--tl-line-2);border-radius:4px;background:var(--tl-glass-strong)}
.fb-row{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;padding:6px 8px 6px 12px;border-bottom:1px solid var(--tl-line);min-height:56px}
.fb-row b{display:block;font-weight:600;font-size:14px}
.fb-row small{display:block;color:var(--tl-dim);font-size:11px}
.fb-foot{display:flex;gap:10px;flex:none;flex-wrap:wrap}
.fb-foot>*{flex:1 1 140px}
.fb-sheet{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:var(--tl-scrim);pointer-events:auto;z-index:45;padding:16px}
.fb-sheet>div{width:100%;max-width:340px;display:flex;flex-direction:column;gap:10px;padding:16px;border:1px solid var(--tl-line-2);border-radius:4px;background:var(--tl-glass-strong)}
.fb-sheet h1{font-size:15px;letter-spacing:.14em;text-transform:uppercase;text-align:center;margin-bottom:4px}
`;
function styles(): void {
  installStyles();
  if (document.getElementById('tl-fb-css')) return;
  const s = document.createElement('style');
  s.id = 'tl-fb-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

function screen(host: UiHost, el: HTMLElement, onShow: () => void, onUpdate: (dt: number) => void = () => {}): UiScreen {
  el.style.display = 'none';
  return {
    el,
    show() {
      if (!el.isConnected) host.root.appendChild(el);
      el.style.display = '';
      onShow();
    },
    hide() {
      el.style.display = 'none';
    },
    update: onUpdate,
    dispose() {
      el.remove();
    },
  };
}

function fallbackTitle(host: UiHost): UiScreen {
  styles();
  const stack = h('div.fb-stack');
  const el = h('div.fb.fb--title', null, h('div.fb-word', null, h('b', { text: 'TIDELOCK' }), h('span', { text: 'The Ember Reach · 2907' })), stack);
  return screen(host, el, () => {
    stack.replaceChildren();
    if (host.hasSave())
      stack.appendChild(Button({ label: 'Continue', variant: 'primary', size: 'lg', block: true, onTap: () => { if (!host.continueGame()) host.toast('The saved flight could not be read', 'bad'); } }).el);
    stack.appendChild(Button({ label: 'New flight', variant: host.hasSave() ? 'secondary' : 'primary', size: 'lg', block: true, onTap: () => host.newGame() }).el);
  });
}

function fallbackStation(host: UiHost): UiScreen {
  styles();
  const name = h('h1');
  const credits = h('span');
  const sub = h('div.fb-sub');
  const list = h('div.fb-list');
  const foot = h('div.fb-foot');
  const el = h('div.fb.fb--panel', null, h('div.fb-head', null, name, credits), sub, list, foot);
  let stamp = 0;
  const refresh = (): void => {
    const g = host.game;
    const st = g.dockedStation();
    const p = g.player();
    const fi = g.flightInfo();
    setText(name, st ? st.name : 'In flight');
    setText(credits, fmtCredits(p.credits));
    setText(sub, `Hold ${fmtInt(p.cargoUsed)} / ${fmtInt(p.cargoCapacity)} t · Propellant ${Math.round(fi.propellantFraction * 100)}% · Hull ${Math.round(fi.hullFraction * 100)}%`);
    list.replaceChildren();
    if (!st) return;
    for (const row of g.market()) {
      const have = p.cargo.find((c) => c.commodityId === row.commodityId)?.units ?? 0;
      const id = row.commodityId;
      const act = (kind: 'buy' | 'sell') => (): void => {
        const r = kind === 'buy' ? host.game.buy(id, 1) : host.game.sell(id, 1);
        if (!r.ok) host.toast(r.reason, 'warn');
        refresh();
      };
      list.appendChild(
        h('div.fb-row', null,
          h('div', null, h('b', { text: row.name }), h('small', { text: `Buy ${fmtCredits(row.buyPrice)} · Sell ${fmtCredits(row.sellPrice)} · Stock ${fmtInt(row.stock)} · Held ${have}` })),
          Button({ label: 'Buy', variant: 'ion', size: 'sm', disabled: row.stock <= 0, onTap: act('buy') }).el,
          Button({ label: 'Sell', variant: 'ember', size: 'sm', disabled: have <= 0, onTap: act('sell') }).el),
      );
    }
    const rq = g.refuelQuote();
    foot.replaceChildren(
      Button({ label: rq.kg > 1 ? `Refuel · ${fmtCredits(rq.cost)}` : 'Tanks full', variant: 'secondary', disabled: rq.kg <= 1, onTap: () => { const r = host.game.refuel(); if (!r.ok) host.toast(r.reason, 'warn'); refresh(); } }).el,
      Button({ label: 'Launch', variant: 'primary', icon: 'undock', onTap: () => { const r = host.game.undock(); if (!r.ok) host.toast(r.reason, 'warn'); } }).el,
    );
  };
  return screen(host, el, refresh, (dt) => {
    stamp += dt;
    if (stamp > 5) {
      stamp = 0;
      setText(credits, fmtCredits(host.game.player().credits));
    }
  });
}

function fallbackMap(host: UiHost): UiScreen {
  styles();
  const list = h('div.fb-list');
  const el = h('div.fb.fb--panel', null,
    h('div.fb-head', null, h('h1', { text: 'Navigation' }), h('span', { text: '' })),
    h('div.fb-sub', { text: 'Pick a destination, then use "Go to" on the flight display.' }),
    list,
    h('div.fb-foot', null, Button({ label: 'Back to flight', variant: 'primary', onTap: () => host.go('flight') }).el));
  return screen(host, el, () => {
    list.replaceChildren();
    const g = host.game;
    const cur = g.target();
    const rows = g.contacts().filter((c) => c.kind === 'station').map((c) => ({ id: c.ref.id, name: c.name, distance: c.distance })).sort((a, b) => a.distance - b.distance);
    for (const c of rows) {
      const on = cur?.id === c.id;
      list.appendChild(
        h('div.fb-row', null,
          h('div', null, h('b', { text: c.name }), h('small', { text: fmtDistance(c.distance) })),
          h('span'),
          Button({ label: on ? 'Targeted' : 'Target', variant: on ? 'ember' : 'ion', size: 'sm', onTap: () => { host.game.setTarget({ kind: 'station', id: c.id }); host.go('flight'); } }).el),
      );
    }
  });
}

function fallbackPause(host: UiHost): UiScreen {
  styles();
  const QUALITIES = ['low', 'medium', 'high'];
  const box = h('div');
  const el = h('div.fb-sheet', null, box);
  const s: UiScreen = screen(host, el, () => {
    const q = host.settings.get('quality', 'medium');
    box.replaceChildren(
      h('h1', { text: 'Paused' }),
      Button({ label: 'Resume', variant: 'primary', block: true, onTap: () => s.hide() }).el,
      Button({ label: 'Save now', variant: 'secondary', block: true, onTap: () => { host.saveNow(); host.toast('Flight saved', 'good'); } }).el,
      Button({ label: `Graphics: ${q}`, variant: 'secondary', block: true, onTap: () => { host.settings.set('quality', QUALITIES[(QUALITIES.indexOf(q) + 1) % QUALITIES.length]); s.show(); } }).el,
      Button({ label: `Invert pitch: ${host.settings.get('invertPitch', false) ? 'on' : 'off'}`, variant: 'secondary', block: true, onTap: () => { host.settings.set('invertPitch', !host.settings.get('invertPitch', false)); s.show(); } }).el,
      Button({ label: 'Save and exit to title', variant: 'ghost', block: true, onTap: () => { host.saveNow(); s.hide(); host.go('title'); } }).el,
    );
  });
  return s;
}

// ---- REAL: src/ui/screens exists, so the app mounts the real screens. The fallbacks stay available for emergencies:
// to use them, replace the export line with the four `fallbackScreens` members.
export const fallbackScreens = { createTitleScreen: fallbackTitle, createStationScreen: fallbackStation, createMapScreen: fallbackMap, createPauseMenu: fallbackPause };
export { createTitleScreen, createStationScreen, createMapScreen, createPauseMenu } from '../ui/screens';
