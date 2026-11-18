// Title screen: the wordmark over the live scene. The middle of the screen stays clear.
import { h, Button, wordmark, confirmDialog } from '../kit';
import type { UiHost, UiScreen } from '../host';
import { screenRoot, VERSION_LINE } from './shared';

export function createTitleScreen(host: UiHost): UiScreen {
  const el = screenRoot(host, 'tls-title');
  const btns = h('div.tls-title__btns');
  const mark = wordmark(48);
  mark.removeAttribute('width');
  mark.removeAttribute('height');

  const start = (): void => {
    host.sfx('confirm');
    host.newGame();
    host.go('station');
  };
  const onNew = (): void => {
    if (!host.hasSave()) return start();
    void confirmDialog({
      title: 'Start a new flight?',
      message: 'Your saved flight will be replaced. You start again at Chandler’s Wheel with a stock Wren and 5,000 credits.',
      confirmLabel: 'New flight', cancelLabel: 'Keep my save', danger: true, icon: 'warning',
    }, el).then((yes) => { if (yes) start(); });
  };
  const onContinue = (): void => {
    if (host.continueGame()) {
      host.sfx('confirm');
      host.go(host.game.dockedStation() ? 'station' : 'flight');
    } else {
      host.toast('The saved flight could not be read. Start a new one.', 'bad');
      build();
    }
  };

  function build(): void {
    const saved = host.hasSave();
    btns.replaceChildren();
    if (saved) btns.appendChild(Button({ label: 'Continue', icon: 'play', variant: 'primary', size: 'lg', block: true, onTap: onContinue }).el);
    btns.appendChild(Button({ label: 'New flight', icon: saved ? 'plus' : 'undock', variant: saved ? 'secondary' : 'primary', size: 'lg', block: true, onTap: onNew }).el);
  }

  el.append(
    h('div.tls-title__top', null,
      h('div.tls-title__mark', null, mark),
      h('div.tls-title__rule', { text: 'Orbits are earned' })),
    h('div.tls-title__foot', null,
      h('p.tls-title__premise', { text: 'One small freighter, a red dwarf’s worlds, and real orbital mechanics. Buy low at the Wheel, fly the transfer yourself, sell high at the Lock.' }),
      btns,
      h('div.tls-title__ver', { text: VERSION_LINE })),
  );
  build();

  return {
    el,
    show() { build(); el.hidden = false; },
    hide() { el.hidden = true; },
    update() {},
    dispose() { el.remove(); },
  };
}
