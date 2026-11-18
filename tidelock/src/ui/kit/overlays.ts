// TIDELOCK UI kit — overlays: modal dialog, bottom sheet, toast stack, inline help popover,
// comms message and the boot splash. Overlays mount into the nearest `.tl-root` (see rootOf).

import {
  h, clamp, setText, setChildren, setStyle, disposer, listen, feedback, onTap, onDrag, scrollArea, trapFocus,
  rootOf, safeInsets, reducedMotion,
  type Child, type Component,
} from './kit';
import { icon, logoMark, wordmark, portrait, type IconName } from './icons';
import { Button, HoldButton, Gauge, setTone, type ButtonVariant, type ToneOrColor } from './components';

/** Shared overlay controls. */
export interface Overlay<P> extends Component<P> {
  /** Mount and animate in. `from` picks the root (defaults to the first root on the page). */
  open(from?: Element | null): void;
  /** Animate out and unmount. */
  close(): void;
  readonly isOpen: boolean;
}

/** Run `fn` once the element's own transition ends (with a timer fallback, so it always runs). */
function afterTransition(el: HTMLElement, fn: () => void, fallbackMs = 340): void {
  let done = false;
  let timer = 0;
  const finish = (): void => {
    if (done) return;
    done = true;
    el.removeEventListener('transitionend', onEnd);
    clearTimeout(timer);
    fn();
  };
  const onEnd = (e: TransitionEvent): void => {
    if (e.target === el) finish();
  };
  el.addEventListener('transitionend', onEnd);
  timer = window.setTimeout(finish, reducedMotion() ? 20 : fallbackMs);
}

const isSideSheet = (): boolean => typeof matchMedia === 'function' && matchMedia('(orientation: landscape) and (max-height: 520px)').matches;

// ------------------------------------------------------------------ modal

export interface ModalAction {
  label: string;
  variant?: ButtonVariant;
  icon?: IconName;
  /** Hold-to-confirm instead of a tap (irreversible choices). */
  hold?: boolean;
  /** Return false to keep the dialog open. */
  onTap?: () => boolean | void;
}

export interface ModalProps {
  title: string;
  icon?: IconName;
  tone?: ToneOrColor;
  /** Plain paragraph under the title. */
  message?: string;
  /** Extra content under the message. */
  body?: Child;
  /** Buttons, left to right; the last one is the default action. Defaults to a single "Close". */
  actions?: ModalAction[];
  /** Tapping the scrim or pressing Escape closes. Default true. */
  dismissable?: boolean;
  onClose?: () => void;
}

/** Centred dialog for decisions that must interrupt (confirmations, warnings). */
export function Modal(props: ModalProps): Overlay<Pick<ModalProps, 'title' | 'message'>> {
  const d = disposer();
  const titleEl = h('h2.tl-modal__title', { text: props.title });
  const messageEl = h('p.tl-body', { text: props.message ?? '' });
  const scrim = h('div.tl-scrim.tl-scrim--modal');
  const actions = h('div.tl-modal__actions');
  const dialog = h('div.tl-modal', { attrs: { role: 'dialog', 'aria-modal': 'true' } },
    h('div.tl-modal__head', null, props.icon ? icon(props.icon, 24) : null, titleEl),
    h('div.tl-modal__body', null, props.message !== undefined ? messageEl : null, props.body),
    actions);
  const wrap = h('div.tl-modal-wrap', null, dialog);
  setTone(dialog, props.tone);
  let open = false;
  let release: () => void = () => {};
  const close = (): void => {
    if (!open) return;
    open = false;
    feedback('close');
    release();
    scrim.classList.remove('tl-scrim--in');
    dialog.classList.remove('tl-modal--in');
    afterTransition(dialog, () => {
      if (open) return;
      scrim.remove();
      wrap.remove();
    });
    props.onClose?.();
  };
  for (const a of props.actions ?? [{ label: 'Close' }]) {
    const run = (): void => {
      if (a.onTap?.() !== false) close();
    };
    const btn = a.hold
      ? HoldButton({ label: a.label, icon: a.icon, variant: a.variant ?? 'danger', onConfirm: run })
      : Button({ label: a.label, icon: a.icon, variant: a.variant ?? 'secondary', onTap: run });
    d.add(() => btn.destroy());
    actions.appendChild(btn.el);
  }
  if (props.dismissable !== false) d.add(onTap(scrim, close, { cue: false }));
  return {
    el: dialog,
    get isOpen() {
      return open;
    },
    open(from) {
      if (open) return;
      open = true;
      const root = rootOf(from);
      root.append(scrim, wrap);
      void dialog.offsetWidth; // flush so the entrance transition runs
      scrim.classList.add('tl-scrim--in');
      dialog.classList.add('tl-modal--in');
      feedback('open');
      release = trapFocus(dialog, props.dismissable !== false ? close : undefined);
    },
    close,
    update(p) {
      if (p.title !== undefined) setText(titleEl, p.title);
      if (p.message !== undefined) setText(messageEl, p.message);
    },
    destroy() {
      open = false;
      release();
      d.run();
      scrim.remove();
      wrap.remove();
    },
  };
}

/** Promise-flavoured confirmation dialog: resolves true when the confirming action is chosen. */
export function confirmDialog(opts: { title: string; message?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean; hold?: boolean; icon?: IconName }, from?: Element | null): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    const m = Modal({
      title: opts.title,
      message: opts.message,
      icon: opts.icon ?? (opts.danger ? 'warning' : 'info'),
      tone: opts.danger ? 'red' : 'ember',
      actions: [
        { label: opts.cancelLabel ?? 'Cancel', variant: 'ghost' },
        { label: opts.confirmLabel ?? 'Confirm', variant: opts.danger ? 'danger' : 'primary', hold: opts.hold, onTap: () => void (result = true) },
      ],
      onClose: () => {
        resolve(result);
        window.setTimeout(() => m.destroy(), 400);
      },
    });
    m.open(from);
  });
}

// ------------------------------------------------------------------ bottom sheet

export interface SheetProps {
  title?: string;
  /** Small line above the title (who / where). */
  eyebrow?: string;
  tone?: ToneOrColor;
  /** Sits under the title (badges, a status line). */
  headExtra?: Child;
  body?: Child;
  /** Docked action row; `.tl-btn--block` children share the width. */
  footer?: Child;
  /** Scrim tap, Escape, close button and drag dismiss the sheet. Default true. */
  dismissable?: boolean;
  /** Dim the screen behind. Default true. */
  scrim?: boolean;
  onClose?: () => void;
}

/**
 * Sheet that rises from the bottom edge (portrait) or slides in from the right (landscape phone).
 * Drag the grab bar or header to dismiss; the body scrolls with native momentum.
 */
export function BottomSheet(props: SheetProps): Overlay<Pick<SheetProps, 'title' | 'eyebrow'>> & { body: HTMLElement } {
  const d = disposer();
  const dismissable = props.dismissable !== false;
  const titleEl = h('h2.tl-sheet__title', { text: props.title ?? '' });
  const eyebrowEl = h('div.tl-eyebrow', { text: props.eyebrow ?? '' });
  const body = h('div.tl-sheet__body', null, props.body);
  const grab = h('div.tl-sheet__grab', { attrs: { 'aria-hidden': 'true' } });
  const closeBtn = h('button.tl-header__nav', { attrs: { type: 'button', 'aria-label': 'Close' } }, icon('close', 24));
  const head = h('div.tl-sheet__head', null,
    h('div.tl-sheet__titles', null, props.eyebrow !== undefined ? eyebrowEl : null, titleEl, props.headExtra),
    dismissable ? closeBtn : null);
  const sheet = h('div.tl-sheet', { attrs: { role: 'dialog', 'aria-modal': 'true' } }, grab, head, body,
    props.footer ? h('div.tl-sheet__foot', null, props.footer) : null);
  const scrim = h('div.tl-scrim');
  setTone(sheet, props.tone);
  d.add(scrollArea(body));
  let open = false;
  let release: () => void = () => {};
  const close = (): void => {
    if (!open) return;
    open = false;
    feedback('close');
    release();
    sheet.classList.remove('tl-sheet--dragging', 'tl-sheet--in');
    sheet.style.transform = '';
    scrim.style.opacity = '';
    scrim.classList.remove('tl-scrim--in');
    afterTransition(sheet, () => {
      if (open) return;
      scrim.remove();
      sheet.remove();
    });
    props.onClose?.();
  };
  if (dismissable) {
    d.add(onTap(scrim, close, { cue: false }));
    d.add(onTap(closeBtn, close, { cue: false }));
    let side = false;
    let extent = 1;
    const drag = {
      start(): void {
        side = isSideSheet();
        extent = Math.max(1, side ? sheet.offsetWidth : sheet.offsetHeight);
        sheet.classList.add('tl-sheet--dragging');
      },
      move(s: { dx: number; dy: number }): void {
        const off = Math.max(0, side ? s.dx : s.dy);
        sheet.style.transform = side ? `translate3d(${off.toFixed(1)}px, 0, 0)` : `translate3d(0, ${off.toFixed(1)}px, 0)`;
        scrim.style.opacity = (1 - clamp(off / extent, 0, 1) * 0.8).toFixed(3);
      },
      end(s: { dx: number; dy: number; vx: number; vy: number }, cancelled: boolean): void {
        const off = Math.max(0, side ? s.dx : s.dy);
        const v = side ? s.vx : s.vy;
        if (!cancelled && (off > extent * 0.32 || (v > 0.55 && off > 24))) {
          close();
          return;
        }
        sheet.classList.remove('tl-sheet--dragging');
        sheet.style.transform = '';
        scrim.style.opacity = '';
      },
    };
    d.add(onDrag(grab, drag, { threshold: 4 }));
    d.add(onDrag(head, drag, { threshold: 8 }));
  }
  return {
    el: sheet,
    body,
    get isOpen() {
      return open;
    },
    open(from) {
      if (open) return;
      open = true;
      const root = rootOf(from);
      if (props.scrim !== false) root.appendChild(scrim);
      root.appendChild(sheet);
      void sheet.offsetWidth;
      scrim.classList.add('tl-scrim--in');
      sheet.classList.add('tl-sheet--in');
      feedback('open');
      release = trapFocus(sheet, dismissable ? close : undefined);
    },
    close,
    update(p) {
      if (p.title !== undefined) setText(titleEl, p.title);
      if (p.eyebrow !== undefined) setText(eyebrowEl, p.eyebrow);
    },
    destroy() {
      open = false;
      release();
      d.run();
      scrim.remove();
      sheet.remove();
    },
  };
}

// ------------------------------------------------------------------ toasts

export interface ToastOptions {
  title: string;
  message?: string;
  tone?: ToneOrColor;
  icon?: IconName;
  /** Small right-aligned stamp, e.g. "T+02:14" or "NOW". */
  stamp?: string;
  /** Auto-dismiss after this many ms; 0 keeps it until tapped. Default 4200. */
  duration?: number;
}

export interface ToastStackApi {
  el: HTMLElement;
  /** Show a toast; returns its dismiss function. */
  push(opts: ToastOptions): () => void;
  clear(): void;
  destroy(): void;
}

const TOAST_ICONS: Record<string, IconName> = { red: 'danger', outlaw: 'danger', green: 'check', ember: 'warning', ion: 'info' };

/** A column of transient notices under the top safe area (top-right in landscape). Newest is last; at most `max` show. */
export function ToastStack(from?: Element | null, max = 3): ToastStackApi {
  const el = h('div.tl-toasts', { attrs: { role: 'status', 'aria-live': 'polite' } });
  rootOf(from).appendChild(el);
  const live: { el: HTMLElement; dismiss: () => void }[] = [];
  const push = (opts: ToastOptions): (() => void) => {
    const tone = opts.tone ?? 'ion';
    const node = h('div.tl-toast', null,
      icon(opts.icon ?? TOAST_ICONS[tone] ?? 'info', 18),
      h('div.tl-toast__text', null,
        h('div.tl-toast__title', { text: opts.title }),
        opts.message ? h('div.tl-toast__msg', { text: opts.message }) : null),
      opts.stamp ? h('span.tl-toast__time.tl-num', { text: opts.stamp }) : null);
    setTone(node, tone);
    const d = disposer();
    let gone = false;
    let timer = 0;
    const dismiss = (): void => {
      if (gone) return;
      gone = true;
      clearTimeout(timer);
      d.run();
      const i = live.findIndex((t) => t.el === node);
      if (i >= 0) live.splice(i, 1);
      node.classList.add('tl-toast--out');
      afterTransition(node, () => node.remove(), 260);
    };
    d.add(onTap(node, dismiss, { cue: false }));
    d.add(onDrag(node, {
      move(s) {
        node.style.transform = `translate3d(${s.dx.toFixed(1)}px, 0, 0)`;
        node.style.opacity = (1 - Math.min(1, Math.abs(s.dx) / 160)).toFixed(2);
      },
      end(s, cancelled) {
        if (!cancelled && Math.abs(s.dx) > 70) return dismiss();
        node.style.transform = '';
        node.style.opacity = '';
      },
    }, { axis: 'x', threshold: 8 }));
    el.appendChild(node);
    live.push({ el: node, dismiss });
    while (live.length > max) live[0].dismiss();
    const duration = opts.duration ?? 4200;
    if (duration > 0) timer = window.setTimeout(dismiss, duration);
    feedback(tone === 'red' ? 'alert' : 'tick');
    return dismiss;
  };
  return {
    el,
    push,
    clear() {
      for (const t of live.slice()) t.dismiss();
    },
    destroy() {
      for (const t of live.slice()) t.dismiss();
      el.remove();
    },
  };
}

const stacks = new WeakMap<HTMLElement, ToastStackApi>();

/** Show a toast in the root's shared stack (created on first use). Returns the dismiss function. */
export function toast(opts: ToastOptions, from?: Element | null): () => void {
  const root = rootOf(from);
  let stack = stacks.get(root);
  if (!stack || !stack.el.isConnected) {
    stack = ToastStack(root);
    stacks.set(root, stack);
  }
  return stack.push(opts);
}

// ------------------------------------------------------------------ inline help

export interface HelpProps {
  /** Short heading, e.g. "Δv". */
  title?: string;
  text: string;
  ariaLabel?: string;
}

/**
 * A small (i) that opens a popover explaining the term beside it. Tap to open, tap anywhere to close:
 * no hover involved. The 44 pt hit area overlaps its neighbours through negative margins.
 */
export function HelpTip(props: HelpProps): Component<HelpProps> & { open(): void; close(): void } {
  let title = props.title;
  let text = props.text;
  const btn = h('button.tl-help', { attrs: { type: 'button', 'aria-label': props.ariaLabel ?? `About ${props.title ?? 'this'}`, 'aria-expanded': 'false' } }, icon('info', 16));
  let pop: HTMLElement | null = null;
  let offs = disposer();
  const close = (): void => {
    if (!pop) return;
    offs.run();
    pop.remove();
    pop = null;
    btn.setAttribute('aria-expanded', 'false');
  };
  const open = (): void => {
    if (pop) return;
    const root = rootOf(btn);
    pop = h('div.tl-pop', { attrs: { role: 'tooltip' } }, title ? h('div.tl-pop__title', { text: title }) : null, h('div.tl-pop__text', { text }));
    pop.style.left = '0px';
    pop.style.top = '0px';
    root.appendChild(pop);
    const rr = root.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const safe = safeInsets(root);
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const cx = br.left + br.width / 2 - rr.left;
    const cy = br.top + br.height / 2 - rr.top;
    const left = clamp(cx - pw / 2, safe.left + 12, Math.max(safe.left + 12, rr.width - safe.right - 12 - pw));
    const below = cy + 14 + ph <= rr.height - safe.bottom - 8;
    pop.style.left = `${left.toFixed(1)}px`;
    pop.style.top = `${(below ? cy + 14 : cy - 14 - ph).toFixed(1)}px`;
    setStyle(pop, '--ox', `${(cx - left).toFixed(1)}px`);
    setStyle(pop, '--oy', below ? '0%' : '100%');
    btn.setAttribute('aria-expanded', 'true');
    offs = disposer();
    offs.add(listen(root, 'pointerdown', (e) => {
      const t = e.target as Node;
      if (!btn.contains(t)) close();
    }, true));
    offs.add(listen(root, 'scroll', close, { capture: true, passive: true }));
    offs.add(listen(window, 'resize', close));
  };
  const off = onTap(btn, () => (pop ? close() : open()));
  return {
    el: btn,
    open,
    close,
    update(p) {
      if (p.title !== undefined) title = p.title;
      if (p.text !== undefined) text = p.text;
      if (pop) {
        close();
        open();
      }
    },
    destroy() {
      close();
      off();
      btn.remove();
    },
  };
}

// ------------------------------------------------------------------ comms message

export interface CommsProps {
  /** Speaker name, e.g. "Rotunda Control". */
  name: string;
  /** Role / affiliation line. */
  role?: string;
  /** Speaker colour (their faction or power). */
  tone?: ToneOrColor;
  /** Portrait silhouette seed, or an icon name for non-human speakers (station, ship computer). */
  glyph?: number | IconName;
  /** One entry per message page. */
  lines: string[];
  /** Typing speed, characters per second. Default 70. */
  cps?: number;
  /** Two-line body instead of three (over the flight HUD). */
  compact?: boolean;
  /** Label of the button on the last page. Default "Close". */
  doneLabel?: string;
  onDone?: () => void;
  onPage?: (index: number) => void;
}

/**
 * Incoming transmission: speaker portrait, name, typed-on text, page pips and a Next button.
 * A tap on the text or the button first completes the line, then advances. The full line is laid
 * out invisibly from the start, so the panel never changes size while typing.
 */
export function CommsMessage(props: CommsProps): Component<Pick<CommsProps, 'lines' | 'name' | 'role'>> & { next(): void; readonly page: number } {
  const d = disposer();
  let lines = props.lines.length ? props.lines : [''];
  let page = 0;
  let shown = 0;
  let raf = 0;
  let last = 0;
  let acc = 0;
  const cps = props.cps ?? 70;
  const nameEl = h('span.tl-comms__name', { text: props.name });
  const roleEl = h('span.tl-comms__role', { text: props.role ?? '' });
  const typed = document.createTextNode('');
  const rest = h('span', { style: 'visibility:hidden' });
  const caret = h('span.tl-comms__caret');
  const textEl = h('p.tl-comms__text', { class: props.compact && 'tl-comms__text--compact', attrs: { 'aria-live': 'polite' } }, typed, caret, rest);
  const pips = h('div.tl-comms__pips');
  const countEl = h('span.tl-comms__count.tl-num');
  const nextBtn = Button({ label: 'Next', trailingIcon: 'chevronRight', variant: 'ghost', size: 'sm', onTap: () => advance(), cue: false });
  const el = h('div.tl-comms', { attrs: { role: 'group', 'aria-label': `Message from ${props.name}` } },
    h('div.tl-comms__portrait', null, typeof props.glyph === 'string' ? icon(props.glyph, 30) : portrait(props.glyph ?? 0, 58)),
    h('div.tl-comms__who', null, nameEl, h('span.tl-comms__signal', { attrs: { 'aria-hidden': 'true' } }, h('i'), h('i'), h('i'), h('i')), roleEl),
    textEl,
    h('div.tl-comms__foot', null, h('div.tl-row', { style: 'gap:0' }, pips, countEl), nextBtn.el));
  setTone(el, props.tone ?? 'ion');
  const paint = (): void => {
    const line = lines[page];
    typed.data = line.slice(0, shown);
    setText(rest, line.slice(shown));
    const done = shown >= line.length;
    el.classList.toggle('tl-comms--done', done);
    nextBtn.update({ label: !done ? 'Skip' : page < lines.length - 1 ? 'Next' : (props.doneLabel ?? 'Close') });
  };
  const paintPips = (): void => {
    setChildren(pips, lines.length > 1 ? lines.map((_, i) => h('i', { class: i <= page && 'on' })) : null);
    setText(countEl, lines.length > 1 ? `${page + 1}/${lines.length}` : '');
  };
  const frame = (now: number): void => {
    const line = lines[page];
    acc += ((now - last) / 1000) * cps;
    last = now;
    const step = Math.floor(acc);
    if (step > 0) {
      acc -= step;
      const before = shown;
      shown = Math.min(line.length, shown + step);
      // Breathe at sentence ends.
      if (/[.?!—]/.test(line.slice(before, shown)) && shown < line.length) acc = -cps * 0.22;
      if ((shown & 3) === 0) feedback('type');
      paint();
    }
    if (shown < line.length) raf = requestAnimationFrame(frame);
  };
  const start = (): void => {
    cancelAnimationFrame(raf);
    shown = reducedMotion() ? lines[page].length : 0;
    acc = 0;
    paint();
    paintPips();
    props.onPage?.(page);
    if (shown < lines[page].length) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  };
  const advance = (): void => {
    if (shown < lines[page].length) {
      cancelAnimationFrame(raf);
      shown = lines[page].length;
      paint();
      return;
    }
    feedback('tap');
    if (page < lines.length - 1) {
      page++;
      start();
    } else {
      props.onDone?.();
    }
  };
  d.add(onTap(textEl, advance, { cue: false }));
  d.add(() => cancelAnimationFrame(raf));
  d.add(() => nextBtn.destroy());
  start();
  return {
    el,
    get page() {
      return page;
    },
    next: advance,
    update(p) {
      if (p.name !== undefined) setText(nameEl, p.name);
      if (p.role !== undefined) setText(roleEl, p.role);
      if (p.lines) {
        lines = p.lines.length ? p.lines : [''];
        page = 0;
        start();
      }
    },
    destroy() {
      d.run();
      el.remove();
    },
  };
}

// ------------------------------------------------------------------ splash

export interface SplashProps {
  /** Line under the wordmark. */
  tagline?: string;
  /** Loading status, e.g. "Charting the Ember Reach". */
  status?: string;
  /** 0..1. */
  progress?: number;
  /** Footer line (version / studio). */
  footer?: string;
  /** Called when the player taps the start button shown by ready(). */
  onStart?: () => void;
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Paint the splash backdrop once: a sparse star field and the lit limb of a world along the bottom
 * edge. `limb` is the height of the limb's crest above the bottom edge, px.
 */
function paintSplashSky(canvas: HTMLCanvasElement, limb: number): void {
  const w = canvas.clientWidth;
  const hgt = canvas.clientHeight;
  if (!w || !hgt) return;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(hgt * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  const rnd = mulberry(2907);
  const count = Math.round((w * hgt) / 1500);
  for (let i = 0; i < count; i++) {
    const x = rnd() * w;
    const y = rnd() * hgt;
    const m = Math.pow(rnd(), 3.2);
    const r = 0.35 + m * 0.95;
    const warm = rnd();
    ctx.fillStyle = warm > 0.82 ? `rgba(255, 205, 160, ${0.25 + m * 0.7})` : warm < 0.12 ? `rgba(170, 215, 255, ${0.25 + m * 0.7})` : `rgba(232, 238, 245, ${0.16 + m * 0.7})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // The limb: a huge dark disc rising from below with a thin ember terminator line.
  const R = Math.max(w, hgt) * 1.5;
  const cx = w * 0.5;
  const cy = hgt + R - limb;
  const glow = ctx.createRadialGradient(cx, cy, R - 2, cx, cy, R + hgt * 0.22);
  glow.addColorStop(0, 'rgba(255, 170, 84, 0.26)');
  glow.addColorStop(0.25, 'rgba(255, 150, 70, 0.09)');
  glow.addColorStop(1, 'rgba(255, 150, 70, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, hgt);
  ctx.fillStyle = '#04060a';
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fill();
  const rim = ctx.createLinearGradient(0, 0, w, 0);
  rim.addColorStop(0, 'rgba(255, 180, 84, 0)');
  rim.addColorStop(0.3, 'rgba(255, 196, 120, 0.9)');
  rim.addColorStop(0.62, 'rgba(255, 180, 84, 0.55)');
  rim.addColorStop(1, 'rgba(255, 180, 84, 0)');
  ctx.strokeStyle = rim;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.arc(cx, cy, R, Math.PI, Math.PI * 2);
  ctx.stroke();
}

/**
 * Boot splash: emblem, TIDELOCK wordmark, tagline and a loading line. Call update({ progress, status })
 * while loading, ready() to swap the loader for a start button, and dismiss() to fade out.
 */
export function Splash(props: SplashProps = {}): Component<Pick<SplashProps, 'progress' | 'status'>> & { ready(label?: string): void; dismiss(): Promise<void> } {
  const d = disposer();
  const sky = h('canvas.tl-splash__stars', { attrs: { 'aria-hidden': 'true' } });
  const statusEl = h('span', { text: props.status ?? 'Loading' });
  const pctEl = h('span.tl-num');
  const bar = Gauge({ kind: 'linear', value: props.progress ?? 0, tone: 'ember', thickness: 'thin' });
  const load = h('div.tl-splash__load', null, h('div.tl-splash__status', null, statusEl, pctEl), bar.el);
  const cta = h('div.tl-splash__cta.tl-hidden');
  const el = h('div.tl-splash', { attrs: { role: 'img', 'aria-label': 'TIDELOCK' } },
    sky,
    h('div.tl-splash__mark', null, logoMark(132)),
    h('div.tl-splash__word', null, wordmark(30), h('div.tl-splash__tag', { text: props.tagline ?? 'The Ember Reach · 2907' })),
    load, cta,
    props.footer ? h('div.tl-splash__foot', { text: props.footer }) : null);
  const setProgress = (p: number): void => {
    const v = clamp(p, 0, 1);
    bar.update({ value: v });
    setText(pctEl, `${Math.round(v * 100)}%`);
  };
  setProgress(props.progress ?? 0);
  if (typeof ResizeObserver !== 'undefined') {
    // The crest clears the loader: --tl-limb above the bottom safe-area inset (see .tl-splash).
    const ro = new ResizeObserver(() => paintSplashSky(sky, safeInsets(el).bottom + (parseFloat(getComputedStyle(el).getPropertyValue('--tl-limb')) || 112)));
    ro.observe(sky);
    d.add(() => ro.disconnect());
  }
  return {
    el,
    update(p) {
      if (p.progress !== undefined) setProgress(p.progress);
      if (p.status !== undefined) setText(statusEl, p.status);
    },
    ready(label = 'Begin') {
      load.classList.add('tl-hidden');
      const btn = Button({ label, variant: 'ember', size: 'lg', trailingIcon: 'chevronRight', onTap: () => props.onStart?.(), cue: 'confirm' });
      d.add(() => btn.destroy());
      setChildren(cta, btn.el);
      cta.classList.remove('tl-hidden');
    },
    dismiss() {
      return new Promise((resolve) => {
        el.classList.add('tl-splash--out');
        afterTransition(el, () => {
          el.remove();
          resolve();
        }, 520);
      });
    },
    destroy() {
      d.run();
      el.remove();
    },
  };
}
