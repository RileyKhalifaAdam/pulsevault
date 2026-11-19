// Getting a running AudioContext on iOS Safari inside the locked-down viewer.
//
// - The context is created, and resume() called, INSIDE a user-activation gesture: pointerup, touchend or click,
//   in the capture phase on window. pointerdown from a touch is not an activation-triggering event (HTML spec,
//   WebKit), so a context made there stays suspended: the first sound comes when the first finger lifts.
// - navigator.audioSession.type = 'playback' (iOS 16.4+) in a try/catch, so the ring/silent switch does not mute
//   WebAudio. Unsupported elsewhere: ignored.
// - The gesture listeners are removed once the context reports 'running', and re-armed whenever it falls back to
//   'suspended' or WebKit's 'interrupted' (a call, Siri, another app's audio): the next tap resumes it.
// - Created at 48 kHz (BAKE_RATE), so the baked buffers play at their own rate; only if the engine refuses the
//   requested rate is the context made at its default rate (and the bank is baked again for it, in slices).
// - Hidden page: suspend (no audio thread while nobody hears it). Visible again: try resume() AND re-arm the tap
//   listeners: outside a gesture WebKit may leave that resume() pending forever (Web Audio: "if not allowed to
//   start, append the promise to [[pending resume promises]]"), with no rejection and no statechange.
// - Native nodes only. No AudioWorklet (the viewer's CSP may refuse its module) and no OfflineAudioContext.

import { BAKE_RATE } from './modal';

export type CtxState = 'none' | 'failed' | AudioContextState | 'interrupted';

const GESTURES = ['pointerup', 'touchend', 'click'] as const;

export interface Unlocker {
  readonly ctx: AudioContext | null;
  state(): CtxState;
  dispose(): void;
}

export interface UnlockOptions {
  win: Window;
  /** Factory (tests); default `new AudioContext({ latencyHint: 'interactive', sampleRate: BAKE_RATE })`. */
  create?: () => AudioContext;
  /** Called once, inside the gesture, when the context first exists. */
  onContext: (ctx: AudioContext) => void;
  onState?: (s: CtxState) => void;
}

/** Set the iOS audio session category so the silent switch does not mute the game. */
export function setPlaybackSession(nav: Navigator | undefined): void {
  try {
    const s = (nav as unknown as { audioSession?: { type: string } } | undefined)?.audioSession;
    if (s) s.type = 'playback';
  } catch {
    /* not supported */
  }
}

export function createUnlocker(o: UnlockOptions): Unlocker {
  const { win } = o;
  const doc = win.document;
  let ctx: AudioContext | null = null;
  let failed = false;
  let armed = false;
  let hiddenSuspend = false;

  const state = (): CtxState => (failed ? 'failed' : ctx ? (ctx.state as CtxState) : 'none');

  const arm = (): void => {
    if (armed) return;
    armed = true;
    for (const g of GESTURES) win.addEventListener(g, onGesture, true);
  };
  const disarm = (): void => {
    if (!armed) return;
    armed = false;
    for (const g of GESTURES) win.removeEventListener(g, onGesture, true);
  };

  const tryResume = (): void => {
    if (!ctx) return;
    try {
      const p = ctx.resume();
      if (p && typeof p.then === 'function') p.then(onStateChange, () => arm());
    } catch {
      arm();
    }
  };

  const onStateChange = (): void => {
    const s = state();
    o.onState?.(s);
    if (s === 'running') disarm();
    else if (s === 'suspended' || s === 'interrupted') {
      if (doc.hidden) return; // we suspended it, or the system did while hidden: resume on visibility
      arm(); // the next tap resumes it; also try now (allowed after a prior activation on most engines)
      if (!hiddenSuspend) tryResume();
    }
  };

  function onGesture(): void {
    setPlaybackSession(win.navigator);
    if (!ctx && !failed) {
      try {
        const w = win as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
        const Ctor = w.AudioContext ?? w.webkitAudioContext;
        if (!o.create && !Ctor) throw new Error('no Web Audio');
        if (o.create) ctx = o.create();
        else {
          try {
            ctx = new Ctor!({ latencyHint: 'interactive', sampleRate: BAKE_RATE });
          } catch {
            ctx = new Ctor!({ latencyHint: 'interactive' }); // an engine that refuses the rate: rebake for its own
          }
        }
      } catch {
        failed = true;
        disarm();
        o.onState?.('failed');
        return;
      }
      const c = ctx as AudioContext;
      c.addEventListener('statechange', onStateChange);
      o.onContext(c);
    }
    hiddenSuspend = false;
    if (ctx && ctx.state !== 'running') tryResume();
    onStateChange();
  }

  const onVisibility = (): void => {
    if (!ctx) return;
    if (doc.hidden) {
      if (ctx.state === 'running') {
        hiddenSuspend = true;
        ctx.suspend().catch(() => { /* ignore */ });
      }
    } else {
      hiddenSuspend = false;
      if (ctx.state !== 'running') arm(); // a resume() outside a gesture may stay pending: the next tap resumes
      tryResume();
    }
  };

  arm();
  doc.addEventListener('visibilitychange', onVisibility);

  return {
    get ctx() { return ctx; },
    state,
    dispose() {
      disarm();
      doc.removeEventListener('visibilitychange', onVisibility);
      if (ctx) {
        ctx.removeEventListener('statechange', onStateChange);
        ctx.close().catch(() => { /* ignore */ });
      }
    },
  };
}
