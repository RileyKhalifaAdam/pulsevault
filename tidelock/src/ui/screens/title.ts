// Title: the wordmark over the pilot's own view, and how the hands work — there is nothing on screen during
// play to explain it. One action: tap anywhere to begin.
import { h, onTap, wordmark } from '../kit';
import type { UiHost, UiScreen } from '../host';
import { screenRoot, VERSION_LINE } from './shared';

const HANDS: [string, string][] = [
  ['Touch a control', 'your hand is on it: drag a stick or a lever, tap a button, a switch, the buckle'],
  ['Touch anywhere else', 'drag to look · pinch to lean in · flick up to jump or push off'],
  ['Left thumb', 'walks, while you are on your feet'],
  ['Three fingers', 'tap for the system menu'],
];

export function createTitleScreen(host: UiHost): UiScreen {
  const el = screenRoot(host, 'tls-title');
  el.style.pointerEvents = 'auto';
  el.style.background = 'linear-gradient(180deg, rgba(4,7,12,0.82) 0%, rgba(4,7,12,0.35) 38%, rgba(4,7,12,0.55) 62%, rgba(4,7,12,0.9) 100%)';
  const mark = wordmark(48);
  mark.removeAttribute('width');
  mark.removeAttribute('height');
  const hands = h('div', null, ...HANDS.map(([a, b]) => h('p', null, h('b', { text: `${a} — ` }), b)));
  hands.style.cssText = 'max-width:360px;font-family:var(--tl-font-body);font-size:14px;line-height:1.45;color:#c9d4df;text-shadow:0 1px 8px #000;';
  for (const p of Array.from(hands.children) as HTMLElement[]) p.style.margin = '0 0 6px';
  const begin = h('div', { text: 'Tap to begin' });
  begin.style.cssText = 'font-size:15px;font-weight:600;letter-spacing:0.32em;text-transform:uppercase;color:var(--tl-text);padding:14px 0 6px;';
  el.append(
    h('div.tls-title__top', null,
      h('div.tls-title__mark', null, mark),
      h('div.tls-title__rule', { text: 'A working physical world' })),
    h('div.tls-title__foot', null,
      h('p.tls-title__premise', { text: 'You are aboard the Wren, beside Chandler’s Wheel. You are standing behind the left seat: look down, tap the seat to strap in, and fly her with your hands.' }),
      hands,
      begin,
      h('div.tls-title__ver', { text: VERSION_LINE })),
  );
  onTap(el, () => { host.sfx('confirm'); host.go('flight'); });
  return {
    el,
    show() { el.hidden = false; },
    hide() { el.hidden = true; },
    update() {},
    dispose() { el.remove(); },
  };
}
