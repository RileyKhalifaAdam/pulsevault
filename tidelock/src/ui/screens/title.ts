// Title screen: the wordmark over the live scene, one line, one button. The middle of the screen stays clear.
import { h, Button, wordmark } from '../kit';
import type { UiHost, UiScreen } from '../host';
import { screenRoot, VERSION_LINE } from './shared';

export function createTitleScreen(host: UiHost): UiScreen {
  const el = screenRoot(host, 'tls-title');
  const mark = wordmark(48);
  mark.removeAttribute('width');
  mark.removeAttribute('height');
  el.append(
    h('div.tls-title__top', null,
      h('div.tls-title__mark', null, mark),
      h('div.tls-title__rule', { text: 'A working physical world' })),
    h('div.tls-title__foot', null,
      h('p.tls-title__premise', { text: 'Real gravity, real thrust, real orbits. Nothing moves unless a force moves it.' }),
      h('div.tls-title__btns', null, Button({ label: 'Enter', icon: 'play', variant: 'primary', size: 'lg', block: true, onTap: () => { host.sfx('confirm'); host.go('flight'); } }).el),
      h('div.tls-title__ver', { text: VERSION_LINE })),
  );
  return {
    el,
    show() { el.hidden = false; },
    hide() { el.hidden = true; },
    update() {},
    dispose() { el.remove(); },
  };
}
