// Shared plumbing for the screens: the scoped root element, the stylesheet and a few labels.
import { h, installStyles } from '../kit';
import type { UiHost } from '../host';

/** Keys the pause menu writes through host.settings (the app reads them). */
export const SETTING_KEYS = {
  /** 'auto' | 'low' | 'medium' | 'high' (default 'auto': the frame-time record picks) */
  quality: 'quality',
  /** 0.5 .. 2 (default 1) */
  sensitivity: 'stickSensitivity',
  /** boolean (default false) */
  invertPitch: 'invertPitch',
} as const;

export const VERSION_LINE = 'v0.2 · physics sandbox · Tallow system';

const STYLE_ID = 'tls-screen-styles';

const CSS = `
.tls-screen { position: absolute; inset: 0; overflow: hidden; touch-action: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; }
.tls-screen[hidden] { display: none; }
.tls-pad-x { padding-left: calc(var(--tl-gutter) + var(--tl-safe-l)); padding-right: calc(var(--tl-gutter) + var(--tl-safe-r)); }
.tls-dimtxt { color: var(--tl-dim); }
.tls-good { color: var(--tl-green); } .tls-bad { color: var(--tl-red); } .tls-ember { color: var(--tl-ember); } .tls-ion { color: var(--tl-ion); }

/* ---------- station ---------- */
.tls-shead { flex: none; padding: calc(var(--tl-safe-t) + 8px) calc(var(--tl-gutter) + var(--tl-safe-r)) 10px calc(var(--tl-gutter) + var(--tl-safe-l)); border-bottom: 1px solid var(--tl-line); display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 12px; row-gap: 2px; align-items: center; }
.tls-shead__eyebrow { display: flex; align-items: center; gap: 6px; color: var(--tl-ember); font-size: 11px; font-weight: 600; letter-spacing: var(--tl-track-wide); text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tls-shead__name { font-size: 24px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; line-height: 1.1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tls-shead__menu { grid-row: 1 / span 2; grid-column: 2; width: 44px; height: 44px; display: grid; place-items: center; border: 1px solid var(--tl-line-2); color: var(--tl-dim); }
.tls-shead__menu.tl-pressed { background: var(--tl-raise-2); color: var(--tl-text); }
.tls-stats { grid-column: 1 / -1; display: grid; grid-template-columns: auto auto minmax(0, 1fr); gap: 16px; margin-top: 8px; }
.tls-stat { border-left: 1px solid var(--tl-line-2); padding-left: 8px; min-width: 0; }
.tls-stat__k { font-size: 10px; font-weight: 600; letter-spacing: var(--tl-track); text-transform: uppercase; color: var(--tl-dim); }
.tls-stat__v { font-size: 17px; font-weight: 600; white-space: nowrap; letter-spacing: 0.02em; }
.tls-stat__v small { font-size: 11px; color: var(--tl-dim); letter-spacing: 0.1em; margin-left: 3px; font-weight: 600; }
.tls-mhead, .tls-mrow { display: grid; grid-template-columns: 34px minmax(0, 1fr) 66px 66px; column-gap: 10px; align-items: center; padding: 0 calc(var(--tl-gutter) + var(--tl-safe-r)) 0 calc(var(--tl-gutter) + var(--tl-safe-l)); }
.tls-mhead { position: sticky; top: 0; z-index: 2; height: 30px; background: rgba(6, 9, 13, 0.96); border-bottom: 1px solid var(--tl-line); font-size: 10px; font-weight: 600; letter-spacing: var(--tl-track); text-transform: uppercase; color: var(--tl-dim); white-space: nowrap; }
.tls-mhead > :nth-child(n+3), .tls-mrow > :nth-child(n+3) { text-align: right; }
.tls-mrow { position: relative; width: 100%; min-height: 60px; text-align: left; border-bottom: 1px solid var(--tl-line); }
.tls-mrow.tl-pressed { background: var(--tl-raise-2); }
.tls-mrow--held { background: linear-gradient(90deg, rgba(var(--tl-ember-rgb), 0.07), transparent 60%); }
.tls-mrow--held::before { content: ''; position: absolute; left: 0; top: 10px; bottom: 10px; width: 2px; background: var(--tl-ember); }
.tls-mrow__ico { width: 34px; height: 34px; display: grid; place-items: center; border: 1px solid var(--tl-line-2); color: var(--tl-dim); }
.tls-mrow__name { font-size: 15px; font-weight: 600; letter-spacing: 0.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tls-mrow__sub { font-size: 11px; color: var(--tl-dim); letter-spacing: 0.04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
.tls-mrow__p { font-size: 16px; font-weight: 600; white-space: nowrap; }
.tls-mrow__d { font-size: 11px; white-space: nowrap; margin-top: 2px; color: var(--tl-dim); }
.tls-filter { padding: 10px calc(var(--tl-gutter) + var(--tl-safe-r)) 10px calc(var(--tl-gutter) + var(--tl-safe-l)); }
.tls-sec { display: flex; flex-direction: column; gap: 10px; }
.tls-bar-row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.tls-bar-row b { font-weight: 600; font-size: 17px; }
.tls-dep { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--tl-line-2); background: rgba(9, 13, 19, 0.94); }
.tls-dep--target { border-color: rgba(var(--tl-green-rgb), 0.5); }
.tls-dep__top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.tls-dep__name { font-size: 17px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
.tls-dep__dist { font-size: 15px; font-weight: 600; color: var(--tl-ion); white-space: nowrap; }
.tls-foot { display: flex; flex-direction: column; gap: 8px; }
.tls-foot__dest { display: flex; align-items: baseline; gap: 8px; font-size: 13px; min-height: 18px; white-space: nowrap; overflow: hidden; }
.tls-foot__dest .tl-label { flex: none; }
.tls-foot__dest span:last-child { overflow: hidden; text-overflow: ellipsis; }
.tls-warn { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid rgba(var(--tl-red-rgb), 0.5); background: rgba(var(--tl-red-rgb), 0.08); color: #ffc9c3; font-size: 13px; line-height: 1.3; }
.tls-warn svg { color: var(--tl-red); }
.tls-foot__row { display: flex; gap: 8px; align-items: stretch; }
.tls-foot__row > .tl-btn--block { flex: 1 1 0; }
.tls-trade-total { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding-top: 10px; border-top: 1px solid var(--tl-line); }
.tls-trade-total b { font-size: 24px; font-weight: 600; }
.tls-trade-note { font-size: 13px; min-height: 18px; line-height: 1.35; }
.tls-qty { display: flex; gap: 8px; align-items: stretch; }
.tls-qty > .tl-stepper { flex: 1 1 0; }

/* ---------- title ---------- */
.tls-title { display: flex; flex-direction: column; justify-content: space-between; padding: calc(var(--tl-safe-t) + 7%) calc(24px + var(--tl-safe-r)) calc(var(--tl-safe-b) + 18px) calc(24px + var(--tl-safe-l));
  background: linear-gradient(to bottom, rgba(5, 7, 11, 0.78) 0%, rgba(5, 7, 11, 0.25) 24%, rgba(5, 7, 11, 0) 38%, rgba(5, 7, 11, 0) 54%, rgba(5, 7, 11, 0.8) 76%, rgba(5, 7, 11, 0.96) 100%); }
.tls-title__top { display: flex; flex-direction: column; align-items: center; gap: 14px; }
.tls-title__mark { width: min(78%, 380px); color: var(--tl-text); filter: drop-shadow(0 0 14px rgba(var(--tl-ion-rgb), 0.25)); }
.tls-title__mark svg { width: 100%; height: auto; }
.tls-title__rule { display: flex; align-items: center; gap: 12px; width: min(78%, 380px); color: var(--tl-ember); font-size: 11px; font-weight: 600; letter-spacing: 0.42em; text-transform: uppercase; white-space: nowrap; }
.tls-title__rule::before, .tls-title__rule::after { content: ''; flex: 1 1 0; height: 1px; background: linear-gradient(90deg, transparent, rgba(var(--tl-ember-rgb), 0.7)); }
.tls-title__rule::after { transform: scaleX(-1); }
.tls-title__foot { display: flex; flex-direction: column; gap: 16px; align-items: center; }
.tls-title__premise { max-width: 340px; text-align: center; font-family: var(--tl-font-body); font-size: 15px; line-height: 1.5; color: #c9d4df; text-shadow: 0 1px 8px #000; }
.tls-title__btns { display: flex; flex-direction: column; gap: 10px; width: min(100%, 340px); }
.tls-title__ver { font-size: 11px; letter-spacing: var(--tl-track); text-transform: uppercase; color: var(--tl-faint); }

/* ---------- pause ---------- */
.tls-pause { z-index: 30; display: flex; align-items: center; justify-content: center; background: rgba(3, 5, 9, 0.7); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  padding: calc(var(--tl-safe-t) + 12px) calc(16px + var(--tl-safe-r)) calc(var(--tl-safe-b) + 12px) calc(16px + var(--tl-safe-l)); }
.tls-pause__card { position: relative; width: min(100%, 420px); max-height: 100%; display: flex; flex-direction: column; border: 1px solid var(--tl-line-2); background: rgba(8, 11, 16, 0.94); }
.tls-pause__card::before { content: ''; position: absolute; left: -1px; top: -1px; width: 28px; height: 2px; background: var(--tl-ember); }
.tls-pause__head { flex: none; display: flex; align-items: center; gap: 8px; min-height: 52px; padding: 4px 8px 4px 16px; border-bottom: 1px solid var(--tl-line); }
.tls-pause__head h2 { flex: 1 1 0; font-size: 17px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; }
.tls-pause__nav { width: 44px; height: 44px; display: grid; place-items: center; color: var(--tl-dim); }
.tls-pause__nav.tl-pressed { color: var(--tl-text); background: var(--tl-raise-2); }
.tls-pause__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; touch-action: pan-y; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.tls-pause__ver { text-align: center; font-size: 11px; letter-spacing: var(--tl-track); text-transform: uppercase; color: var(--tl-faint); padding-top: 6px; }
.tls-help h3 { font-size: 12px; font-weight: 600; letter-spacing: var(--tl-track); text-transform: uppercase; color: var(--tl-ember); margin: 10px 0 4px; }
.tls-help h3:first-child { margin-top: 0; }
.tls-help p { font-family: var(--tl-font-body); font-size: 14px; line-height: 1.5; color: #c9d4df; margin: 0 0 6px; }
.tls-help b { color: var(--tl-text); font-weight: 600; }
.tls-help i { font-style: normal; color: var(--tl-ion); }

/* ---------- map ---------- */
.tls-map { background: radial-gradient(120% 55% at 70% -12%, rgba(var(--tl-ion-rgb), 0.06), transparent 62%), radial-gradient(95% 50% at -10% 108%, rgba(var(--tl-ember-rgb), 0.06), transparent 60%), var(--tl-void); }
.tls-map canvas { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; }
.tls-map__top { position: absolute; left: 0; right: 0; top: 0; padding: calc(var(--tl-safe-t) + 6px) calc(12px + var(--tl-safe-r)) 0 calc(12px + var(--tl-safe-l)); display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
.tls-map__top > * { pointer-events: auto; }
.tls-map__bar { display: flex; align-items: center; gap: 8px; }
.tls-map__title { flex: 1 1 0; min-width: 0; }
.tls-map__title b { display: block; font-size: 13px; font-weight: 600; letter-spacing: var(--tl-track); text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tls-map__title span { display: block; font-size: 11px; color: var(--tl-dim); letter-spacing: 0.06em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tls-warp { display: flex; align-items: center; border: 1px solid var(--tl-line-2); background: var(--tl-glass-strong); }
.tls-warp__v { min-width: 62px; text-align: center; font-size: 15px; font-weight: 600; color: var(--tl-ion); }
.tls-warp__v small { display: block; font-size: 9px; letter-spacing: var(--tl-track); color: var(--tl-dim); text-transform: uppercase; font-weight: 600; }
.tls-sq { width: 44px; height: 44px; display: grid; place-items: center; color: var(--tl-text); }
.tls-sq.tl-pressed { background: var(--tl-raise-2); }
.tls-sq--frame { border: 1px solid var(--tl-line-2); background: var(--tl-glass-strong); }
.tls-map__limit { align-self: flex-end; font-size: 11px; color: var(--tl-ember); letter-spacing: 0.04em; text-align: right; max-width: 78%; text-shadow: 0 1px 4px #000; pointer-events: none; }
.tls-map__chips { margin: 0 calc(-12px - var(--tl-safe-r)) 0 calc(-12px - var(--tl-safe-l)); }
.tls-map__chips .tl-chips { padding-left: calc(12px + var(--tl-safe-l)); padding-right: calc(12px + var(--tl-safe-r)); }
.tls-map__zoom { position: absolute; right: calc(12px + var(--tl-safe-r)); display: flex; flex-direction: column; gap: 6px; }
.tls-map__dock { position: absolute; left: 0; right: 0; bottom: 0; display: flex; flex-direction: column; gap: 8px; padding: 10px calc(12px + var(--tl-safe-r)) calc(var(--tl-safe-b) + 10px) calc(12px + var(--tl-safe-l)); background: linear-gradient(to top, rgba(5, 7, 11, 0.96) 62%, rgba(5, 7, 11, 0)); pointer-events: none; }
.tls-map__dock > * { pointer-events: auto; }
.tls-map__status { pointer-events: none; display: flex; flex-direction: column; gap: 2px; text-shadow: 0 1px 4px #000; }
.tls-map__status b { font-size: 13px; font-weight: 600; line-height: 1.3; color: var(--tl-ember); letter-spacing: 0.02em; }
.tls-map__status span { font-size: 12px; color: var(--tl-dim); letter-spacing: 0.03em; }
.tls-card { position: relative; border: 1px solid var(--tl-line-2); background: rgba(8, 11, 16, 0.94); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.tls-card::before { content: ''; position: absolute; left: -1px; top: -1px; width: 22px; height: 2px; background: var(--tl-c, var(--tl-ion)); }
.tls-card__head { display: flex; align-items: center; gap: 10px; }
.tls-card__head > div { flex: 1 1 0; min-width: 0; }
.tls-card__name { font-size: 16px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tls-card__sub { font-size: 12px; color: var(--tl-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tls-card__dist { font-size: 15px; font-weight: 600; color: var(--tl-ion); white-space: nowrap; }
.tls-node-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 10px; }
.tls-node-grid .tl-label { margin-bottom: 3px; font-size: 10px; }
.tls-node-grid .tl-stepper { display: flex; width: 100%; }
.tls-node-time { display: flex; align-items: stretch; height: calc(var(--tl-hit) + 2px); border: 1px solid var(--tl-line-2); background: rgba(255, 255, 255, 0.025); }
.tls-node-time > span { flex: 1 1 0; display: grid; place-items: center; font-size: 14px; font-weight: 600; white-space: nowrap; }
.tls-node-time > button { width: 44px; display: grid; place-items: center; color: var(--tl-dim); }
.tls-node-time > button.tl-pressed { background: var(--tl-raise-2); color: var(--tl-text); }
.tls-map__actions { display: flex; gap: 8px; }
.tls-map__actions > .tl-btn { flex: 1 1 0; min-width: 0; padding-left: 8px; padding-right: 8px; }
.tls-map__actions > .tls-narrow { flex: 0 0 auto; }

@media (orientation: landscape) and (max-height: 520px) {
  .tls-shead { padding-top: calc(var(--tl-safe-t) + 6px); padding-bottom: 6px; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr) auto; }
  .tls-shead__name { font-size: 18px; }
  .tls-stats { grid-column: 2; grid-row: 1 / span 2; margin-top: 0; }
  .tls-shead__menu { grid-column: 3; }
  .tls-foot { flex-direction: row; align-items: center; gap: 12px; }
  .tls-foot__dest, .tls-warn { flex: 1 1 0; min-width: 0; }
  .tls-foot__row { flex: 0 0 300px; }
  .tls-title { padding-top: calc(var(--tl-safe-t) + 18px); }
  .tls-title__top { align-items: flex-start; gap: 10px; }
  .tls-title__mark, .tls-title__rule { width: 300px; }
  .tls-title__foot { flex-direction: row; align-items: flex-end; justify-content: space-between; flex-wrap: wrap; gap: 10px 24px; }
  .tls-title__premise { text-align: left; }
  .tls-title__btns { width: 280px; }
  .tls-title__ver { flex-basis: 100%; }
  .tls-pause__card { width: min(100%, 620px); }
  .tls-pause__grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .tls-map__dock { left: auto; top: calc(var(--tl-safe-t) + 58px); width: calc(340px + var(--tl-safe-r)); padding-left: 10px; background: none; justify-content: flex-end; }
  .tls-map__top { right: 0; }
  .tls-map__chips { margin-right: 0; }
  .tls-map__actions > .tl-btn { font-size: 12px; letter-spacing: 0.06em; padding-left: 4px; padding-right: 4px; }
  .tls-map__limit { position: absolute; right: calc(12px + var(--tl-safe-r)); top: calc(var(--tl-safe-t) + 54px); max-width: 300px; }
}
.tls-pause__grid { display: flex; flex-direction: column; gap: 10px; }
`;

function installScreenStyles(doc: Document): void {
  installStyles(doc);
  if (doc.getElementById(STYLE_ID)) return;
  const st = doc.createElement('style');
  st.id = STYLE_ID;
  st.textContent = CSS;
  doc.head.appendChild(st);
}

/** The element of one screen: a kit root of its own (so overlays stay inside it), hidden until show(). */
export function screenRoot(host: UiHost, cls: string): HTMLElement {
  installScreenStyles(host.root.ownerDocument);
  const quality = host.settings.get<string>(SETTING_KEYS.quality, 'high');
  const el = h('div.tl-root.tls-screen', { class: cls, data: { fx: quality === 'low' ? 'lite' : 'full' } });
  el.hidden = true;
  // The page must never rubber-band or zoom under a finger.
  el.addEventListener('gesturestart', (e) => e.preventDefault());
  el.addEventListener('dblclick', (e) => e.preventDefault());
  host.root.appendChild(el);
  return el;
}

const KIND_LABELS: Record<string, string> = { ringHabitat: 'Ring habitat', outpost: 'Outpost', refinery: 'Refinery' };

/** "ringHabitat" -> "Ring habitat". */
export function stationKindLabel(visualId: string): string {
  const known = KIND_LABELS[visualId];
  if (known) return known;
  const words = visualId.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const CLS_LABELS: Record<string, string> = {
  star: 'Red dwarf star', lava: 'Lava world', barren: 'Airless rock', desert: 'Desert world', eyeball: 'Tidally locked ocean world',
  gasGiant: 'Gas giant', ice: 'Ice world', rocky: 'Rocky world',
};
export function bodyClassLabel(cls: string, kind: string): string {
  const base = CLS_LABELS[cls] ?? cls;
  return kind === 'moon' ? base.replace('world', 'moon') : base;
}

/** First sentence of a description. */
export function firstSentence(text: string): string {
  const m = /^.*?[.!?](\s|$)/.exec(text);
  return (m ? m[0] : text).trim();
}

/** Set textContent only when it changed (cheap to call every frame). */
export function put(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}
