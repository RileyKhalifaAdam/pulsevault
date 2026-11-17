// TIDELOCK UI kit — a tiny dependency-free DOM toolkit.
//
//   h('div.tl-row', { on: { click } }, child, 'text')   element builder (tag.class#id shorthand)
//   svg('path', { d })                                  SVG-namespace builder
//   signal(v) / derived([a, b], fn)                     explicit reactive values (no auto-tracking)
//   onTap / onHoldRepeat / onLongPress / onDrag         touch-first pointer gestures
//   scrollArea / trapFocus                              scrolling and focus inside sheets
//   tween / numberTween / animate / enter / leave       short, purposeful motion (reduced-motion aware)
//
// Everything renders under a `.tl-root` element (see createRoot); styles are injected once by
// installStyles(). Components are plain factories returning { el, update(), destroy() }.

import tokensCss from './tokens.css';
import componentsCss from './components.css';

// ------------------------------------------------------------------ types

export type Child = Node | string | number | boolean | null | undefined | Child[];

export type EventMap = { [K in keyof HTMLElementEventMap]?: (e: HTMLElementEventMap[K]) => void };

export type ClassValue = string | false | null | undefined;

export interface Props {
  /** Class string or list (falsy entries are skipped, so `cond && 'tl-x'` works). */
  class?: ClassValue | ClassValue[];
  /** Inline style: css text or a map (custom properties allowed: { '--tl-c': '#fff' }). */
  style?: string | Record<string, string | number | null | undefined>;
  /** data-* attributes. */
  data?: Record<string, string | number | boolean | null | undefined>;
  /** Raw attributes (null/false removes). */
  attrs?: Record<string, string | number | boolean | null | undefined>;
  /** Event listeners. */
  on?: EventMap;
  /** textContent shortcut. */
  text?: string | number;
  /** Receives the element after creation. */
  ref?: (el: HTMLElement) => void;
}

/** Every component factory returns this shape. */
export interface Component<P = Record<string, never>> {
  el: HTMLElement;
  update(props: Partial<P>): void;
  destroy(): void;
}

// ------------------------------------------------------------------ styles & root

const STYLE_ID = 'tl-kit-styles';

/** Inject the kit stylesheet once (idempotent). */
export function installStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `${tokensCss}\n${componentsCss}`;
  doc.head.appendChild(style);
}

export interface RootOptions {
  /** Cover the viewport (position: fixed; inset: 0). Default true. */
  fixed?: boolean;
  /** 'lite' drops backdrop blur everywhere (low quality tier / battery saver). */
  fx?: 'full' | 'lite';
  /** Let touches fall through empty areas to the canvas below. Default false. */
  passthrough?: boolean;
}

/** Create the scoped UI root. All kit elements, overlays included, must live under one. */
export function createRoot(parent: HTMLElement = document.body, opts: RootOptions = {}): HTMLElement {
  installStyles(parent.ownerDocument);
  const root = h('div.tl-root', {
    class: [opts.fixed !== false && 'tl-root--fixed', opts.passthrough && 'tl-root--pass'],
    data: { fx: opts.fx ?? 'full' },
  });
  parent.appendChild(root);
  return root;
}

/** The root an overlay should mount into: nearest ancestor root, else the first root, else a new one. */
export function rootOf(from?: Element | null): HTMLElement {
  const near = from?.closest<HTMLElement>('.tl-root');
  if (near) return near;
  return document.querySelector<HTMLElement>('.tl-root') ?? createRoot();
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The root's safe-area insets in px (resolves the --tl-safe-* tokens, so harness overrides count). */
export function safeInsets(root: HTMLElement): Insets {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;padding:var(--tl-safe-t) var(--tl-safe-r) var(--tl-safe-b) var(--tl-safe-l)';
  root.appendChild(probe);
  const cs = getComputedStyle(probe);
  const out = { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
  probe.remove();
  return out;
}

// ------------------------------------------------------------------ element builders

const SVG_NS = 'http://www.w3.org/2000/svg';

function append(parent: Node, child: Child): void {
  if (child === null || child === undefined || child === false || child === true) return;
  if (Array.isArray(child)) {
    for (const c of child) append(parent, c);
  } else if (child instanceof Node) {
    parent.appendChild(child);
  } else {
    parent.appendChild(document.createTextNode(String(child)));
  }
}

function applyProps(el: HTMLElement | SVGElement, props: Props): void {
  if (props.class) {
    const list = Array.isArray(props.class) ? props.class : [props.class];
    for (const c of list) if (c) for (const part of c.split(/\s+/)) if (part) el.classList.add(part);
  }
  if (props.style) {
    if (typeof props.style === 'string') el.style.cssText = props.style;
    else for (const k in props.style) setStyle(el, k, props.style[k]);
  }
  if (props.data) for (const k in props.data) {
    const v = props.data[k];
    if (v !== null && v !== undefined && v !== false) el.dataset[k] = String(v);
  }
  if (props.attrs) for (const k in props.attrs) setAttr(el, k, props.attrs[k]);
  if (props.on) for (const k in props.on) {
    el.addEventListener(k, (props.on as Record<string, EventListener>)[k]);
  }
  if (props.text !== undefined) el.textContent = String(props.text);
  if (props.ref) props.ref(el as HTMLElement);
}

/** Set one style property; accepts custom properties and camelCase or kebab-case names. */
export function setStyle(el: HTMLElement | SVGElement, name: string, value: string | number | null | undefined): void {
  const prop = name.startsWith('--') ? name : name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
  if (value === null || value === undefined) el.style.removeProperty(prop);
  else el.style.setProperty(prop, String(value));
}

export function setAttr(el: Element, name: string, value: string | number | boolean | null | undefined): void {
  if (value === null || value === undefined || value === false) el.removeAttribute(name);
  else el.setAttribute(name, value === true ? '' : String(value));
}

/** "button.tl-btn#go" -> "button". */
type TagOf<S extends string> = S extends `${infer T}.${string}` ? TagOf<T> : S extends `${infer T}#${string}` ? TagOf<T> : S;
/** The element type a spec string creates (falls back to HTMLElement for unknown or dynamic tags). */
export type ElementOf<S extends string> = TagOf<S> extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[TagOf<S>] : HTMLElement;

/**
 * Create an element. `spec` is a tag with optional classes/id: "div", "button.tl-btn.tl-btn--primary", "div#hud".
 * The second argument may be a Props object, or omitted (null) to go straight to children.
 */
export function h<S extends string>(spec: S, props?: Props | null, ...children: Child[]): ElementOf<S>;
export function h(spec: string, props?: Props | null, ...children: Child[]): HTMLElement {
  const parts = spec.split(/(?=[.#])/);
  const el = document.createElement(parts[0] || 'div');
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (p[0] === '.') el.classList.add(p.slice(1));
    else el.id = p.slice(1);
  }
  if (props) applyProps(el, props);
  for (const c of children) append(el, c);
  return el;
}

/** Create an SVG element (attributes map straight to attributes). */
export function svg(tag: string, attrs?: Record<string, string | number | null | undefined> | null, ...children: Child[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const k in attrs) {
    const v = attrs[k];
    if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  }
  for (const c of children) append(el, c);
  return el;
}

/** Build a DocumentFragment from children. */
export function frag(...children: Child[]): DocumentFragment {
  const f = document.createDocumentFragment();
  for (const c of children) append(f, c);
  return f;
}

/** Remove all children, then append the new ones. */
export function setChildren(el: Element, ...children: Child[]): void {
  el.textContent = '';
  for (const c of children) append(el, c);
}

/** Set text only when it changed (avoids needless layout in per-frame HUD updates). */
export function setText(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/** Join class names, skipping falsy entries. */
export function cx(...names: (string | false | null | undefined)[]): string {
  let out = '';
  for (const n of names) if (n) out += out ? ` ${n}` : n;
  return out;
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

let uidCounter = 0;
export const uid = (prefix = 'tl'): string => `${prefix}-${(++uidCounter).toString(36)}`;

/** Collects teardown callbacks; run() calls them in reverse order once. */
export interface Disposer {
  add(fn: (() => void) | null | undefined): void;
  run(): void;
}
export function disposer(): Disposer {
  let fns: (() => void)[] = [];
  return {
    add(fn) {
      if (fn) fns.push(fn);
    },
    run() {
      const list = fns;
      fns = [];
      for (let i = list.length - 1; i >= 0; i--) list[i]();
    },
  };
}

/** addEventListener that returns its own remover. */
export function listen<K extends keyof HTMLElementEventMap>(
  target: EventTarget,
  type: K,
  fn: (e: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions | boolean,
): () => void {
  target.addEventListener(type, fn as EventListener, options);
  return () => target.removeEventListener(type, fn as EventListener, options);
}

// ------------------------------------------------------------------ signals

export interface ReadSignal<T> {
  get(): T;
  /** Subscribe; returns the unsubscribe function. `now` also calls fn immediately. */
  sub(fn: (value: T, prev: T) => void, now?: boolean): () => void;
}
export interface Signal<T> extends ReadSignal<T> {
  set(value: T): void;
  update(fn: (value: T) => T): void;
}

/** A value with subscribers. Setting an identical value (Object.is) is a no-op. */
export function signal<T>(initial: T): Signal<T> {
  let value = initial;
  const subs = new Set<(value: T, prev: T) => void>();
  const set = (next: T): void => {
    if (Object.is(next, value)) return;
    const prev = value;
    value = next;
    for (const fn of subs) fn(value, prev);
  };
  return {
    get: () => value,
    set,
    update: (fn) => set(fn(value)),
    sub(fn, now) {
      subs.add(fn);
      if (now) fn(value, value);
      return () => subs.delete(fn);
    },
  };
}

/** A read-only signal recomputed whenever one of `deps` changes. */
export function derived<T>(deps: ReadSignal<unknown>[], compute: () => T): ReadSignal<T> & { dispose(): void } {
  const out = signal(compute());
  const offs = deps.map((d) => d.sub(() => out.set(compute())));
  return { get: out.get, sub: out.sub, dispose: () => offs.forEach((off) => off()) };
}

/** Keep a node's text in sync with a signal. */
export function bindText<T>(node: Node, sig: ReadSignal<T>, format: (v: T) => string = String): () => void {
  return sig.sub((v) => setText(node, format(v)), true);
}

// ------------------------------------------------------------------ feedback hook

/** UI feedback cues; the audio module turns them into ticks (and may add haptics). */
export type FeedbackKind = 'tap' | 'toggle' | 'tick' | 'confirm' | 'deny' | 'open' | 'close' | 'type' | 'alert';

let feedbackHandler: ((kind: FeedbackKind) => void) | null = null;
/** Register the one listener for UI cues (src/audio wires this to its tick sounds). */
export function setFeedbackHandler(fn: ((kind: FeedbackKind) => void) | null): void {
  feedbackHandler = fn;
}
export function feedback(kind: FeedbackKind): void {
  if (feedbackHandler) feedbackHandler(kind);
}

// ------------------------------------------------------------------ gestures

const isDisabled = (el: Element): boolean =>
  (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';

export interface TapOptions {
  /** Movement (px) that turns the press into a scroll/drag and cancels the tap. Default 10. */
  slop?: number;
  /** Cue to emit on a successful tap; false for silence. Default 'tap'. */
  cue?: FeedbackKind | false;
}

/**
 * Tap without the 300 ms delay or ghost clicks: fires on pointerup if the finger stayed put.
 * Adds `.tl-pressed` while the finger is down (the kit never styles :hover). Keyboard / assistive
 * activation (Enter, Space, synthetic click) fires the handler too.
 */
export function onTap(el: HTMLElement, handler: (e: Event) => void, opts: TapOptions = {}): () => void {
  const slop = opts.slop ?? 10;
  const cue = opts.cue === undefined ? 'tap' : opts.cue;
  let id = -1;
  let x0 = 0;
  let y0 = 0;
  const release = (): void => {
    id = -1;
    el.classList.remove('tl-pressed');
  };
  const fire = (e: Event): void => {
    if (isDisabled(el)) return;
    if (cue) feedback(cue);
    handler(e);
  };
  const d = disposer();
  d.add(listen(el, 'pointerdown', (e) => {
    if (!e.isPrimary || e.button > 0 || isDisabled(el)) return;
    id = e.pointerId;
    x0 = e.clientX;
    y0 = e.clientY;
    el.classList.add('tl-pressed');
  }));
  d.add(listen(el, 'pointermove', (e) => {
    if (e.pointerId === id && Math.hypot(e.clientX - x0, e.clientY - y0) > slop) release();
  }));
  d.add(listen(el, 'pointerup', (e) => {
    if (e.pointerId !== id) return;
    release();
    fire(e);
  }));
  d.add(listen(el, 'pointercancel', release));
  d.add(listen(el, 'pointerleave', (e) => {
    if (e.pointerType === 'mouse') release();
  }));
  // Keyboard / screen-reader activation arrives as a click with detail 0.
  d.add(listen(el, 'click', (e) => {
    if (e.detail === 0) fire(e);
  }));
  if (el.tagName !== 'BUTTON' && el.tagName !== 'A') {
    d.add(listen(el, 'keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fire(e);
      }
    }));
  }
  return d.run;
}

export interface HoldRepeatOptions {
  /** Wait before auto-repeat starts, ms. Default 360. */
  delay?: number;
  /** First repeat interval, ms. Default 150. */
  interval?: number;
  /** Fastest repeat interval, ms. Default 28. */
  minInterval?: number;
  /** Interval multiplier per repeat (< 1 accelerates). Default 0.86. */
  accel?: number;
}

/**
 * Press-and-hold with accelerating auto-repeat (steppers, time-warp buttons).
 * `handler(n)` fires once on press (n = 0) and then for every repeat (n = 1, 2, …), so callers can
 * also grow their step with n.
 */
export function onHoldRepeat(el: HTMLElement, handler: (n: number) => void, opts: HoldRepeatOptions = {}): () => void {
  const delay = opts.delay ?? 360;
  const first = opts.interval ?? 150;
  const min = opts.minInterval ?? 28;
  const accel = opts.accel ?? 0.86;
  let timer = 0;
  let id = -1;
  let n = 0;
  let interval = first;
  const stop = (): void => {
    if (id === -1) return;
    id = -1;
    clearTimeout(timer);
    el.classList.remove('tl-pressed');
  };
  const tick = (): void => {
    if (isDisabled(el)) return stop();
    n++;
    feedback('tick');
    handler(n);
    interval = Math.max(min, interval * accel);
    timer = window.setTimeout(tick, interval);
  };
  const d = disposer();
  d.add(listen(el, 'pointerdown', (e) => {
    if (!e.isPrimary || e.button > 0 || isDisabled(el)) return;
    id = e.pointerId;
    n = 0;
    interval = first;
    el.classList.add('tl-pressed');
    feedback('tick');
    handler(0);
    timer = window.setTimeout(tick, delay);
  }));
  d.add(listen(el, 'pointerup', stop));
  d.add(listen(el, 'pointercancel', stop));
  d.add(listen(el, 'pointerleave', stop));
  d.add(listen(el, 'contextmenu', (e) => e.preventDefault()));
  d.add(listen(el, 'click', (e) => {
    if (e.detail === 0 && !isDisabled(el)) handler(0);
  }));
  d.add(stop);
  return d.run;
}

/** Long-press (default 450 ms, cancelled by movement). The following tap is swallowed. */
export function onLongPress(el: HTMLElement, handler: (e: PointerEvent) => void, opts: { ms?: number; slop?: number } = {}): () => void {
  const ms = opts.ms ?? 450;
  const slop = opts.slop ?? 10;
  let timer = 0;
  let id = -1;
  let x0 = 0;
  let y0 = 0;
  const cancel = (): void => {
    id = -1;
    clearTimeout(timer);
  };
  const d = disposer();
  d.add(listen(el, 'pointerdown', (e) => {
    if (!e.isPrimary || e.button > 0) return;
    id = e.pointerId;
    x0 = e.clientX;
    y0 = e.clientY;
    timer = window.setTimeout(() => {
      if (id === -1) return;
      id = -1;
      feedback('confirm');
      handler(e);
    }, ms);
  }));
  d.add(listen(el, 'pointermove', (e) => {
    if (e.pointerId === id && Math.hypot(e.clientX - x0, e.clientY - y0) > slop) cancel();
  }));
  d.add(listen(el, 'pointerup', cancel));
  d.add(listen(el, 'pointercancel', cancel));
  d.add(listen(el, 'contextmenu', (e) => e.preventDefault()));
  d.add(cancel);
  return d.run;
}

export interface DragState {
  /** Current pointer position, client px. */
  x: number;
  y: number;
  /** Offset from where the drag started. */
  dx: number;
  dy: number;
  /** Smoothed velocity, px/ms. */
  vx: number;
  vy: number;
  startX: number;
  startY: number;
}

export interface DragHandlers {
  /** Return false to refuse this drag. */
  start?(s: DragState, e: PointerEvent): boolean | void;
  move?(s: DragState, e: PointerEvent): void;
  end?(s: DragState, cancelled: boolean): void;
}

export interface DragOptions {
  /** Lock to an axis: the drag only begins if the first movement is mostly along it. Default 'both'. */
  axis?: 'x' | 'y' | 'both';
  /** Movement before the drag begins, px. Default 6 (0 = begin on pointerdown). */
  threshold?: number;
}

/**
 * Pointer drag with axis lock and velocity. The element needs a matching `touch-action`
 * (none, pan-x or pan-y) so the browser does not claim the gesture — the kit's CSS sets it
 * for its own draggable parts.
 */
export function onDrag(el: HTMLElement, handlers: DragHandlers, opts: DragOptions = {}): () => void {
  const axis = opts.axis ?? 'both';
  const threshold = opts.threshold ?? 6;
  const s: DragState = { x: 0, y: 0, dx: 0, dy: 0, vx: 0, vy: 0, startX: 0, startY: 0 };
  let id = -1;
  let active = false;
  let lastT = 0;
  const begin = (e: PointerEvent): boolean => {
    if (handlers.start && handlers.start(s, e) === false) return false;
    active = true;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    return true;
  };
  const finish = (cancelled: boolean): void => {
    if (id === -1) return;
    const was = active;
    id = -1;
    active = false;
    if (was && handlers.end) handlers.end(s, cancelled);
  };
  const d = disposer();
  d.add(listen(el, 'pointerdown', (e) => {
    if (!e.isPrimary || e.button > 0 || id !== -1) return;
    id = e.pointerId;
    s.startX = s.x = e.clientX;
    s.startY = s.y = e.clientY;
    s.dx = s.dy = s.vx = s.vy = 0;
    lastT = e.timeStamp;
    if (threshold === 0 && !begin(e)) id = -1;
  }));
  d.add(listen(el, 'pointermove', (e) => {
    if (e.pointerId !== id) return;
    const dt = Math.max(1, e.timeStamp - lastT);
    lastT = e.timeStamp;
    s.vx = lerp(s.vx, (e.clientX - s.x) / dt, 0.5);
    s.vy = lerp(s.vy, (e.clientY - s.y) / dt, 0.5);
    s.x = e.clientX;
    s.y = e.clientY;
    s.dx = s.x - s.startX;
    s.dy = s.y - s.startY;
    if (!active) {
      const ax = Math.abs(s.dx);
      const ay = Math.abs(s.dy);
      if (Math.max(ax, ay) < threshold) return;
      if ((axis === 'x' && ay > ax) || (axis === 'y' && ax > ay) || !begin(e)) {
        id = -1;
        return;
      }
    }
    if (handlers.move) handlers.move(s, e);
  }));
  d.add(listen(el, 'pointerup', () => finish(false)));
  d.add(listen(el, 'pointercancel', () => finish(true)));
  d.add(() => finish(true));
  return d.run;
}

// ------------------------------------------------------------------ scrolling & focus

export interface ScrollOptions {
  axis?: 'y' | 'x';
  /** Fade content out at the scrollable edges. Default true. */
  fade?: boolean;
}

/**
 * Turn `el` into a momentum-scrolling region that works inside a `touch-action: none` page on iOS:
 * native inertial scrolling, contained overscroll (the page behind never rubber-bands) and edge fades
 * that show there is more content. Returns a cleanup function.
 */
export function scrollArea(el: HTMLElement, opts: ScrollOptions = {}): () => void {
  const x = opts.axis === 'x';
  el.classList.add('tl-scroll', x ? 'tl-scroll--x' : 'tl-scroll--y');
  if (opts.fade === false) return () => {};
  el.classList.add('tl-scroll--fade');
  let queued = false;
  const measure = (): void => {
    queued = false;
    const pos = x ? el.scrollLeft : el.scrollTop;
    const max = x ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
    el.classList.toggle('tl-scroll--start', pos > 2);
    el.classList.toggle('tl-scroll--end', pos < max - 2);
  };
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(measure);
  };
  const d = disposer();
  d.add(listen(el, 'scroll', schedule, { passive: true }));
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    d.add(() => ro.disconnect());
  }
  schedule();
  return d.run;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keep keyboard focus inside `container` (modals, sheets). Escape calls `onEscape`.
 * Returns a release function that restores the previously focused element.
 */
export function trapFocus(container: HTMLElement, onEscape?: () => void): () => void {
  const previous = document.activeElement as HTMLElement | null;
  if (!container.hasAttribute('tabindex')) container.tabIndex = -1;
  container.focus({ preventScroll: true });
  const off = listen(container, 'keydown', (e) => {
    if (e.key === 'Escape' && onEscape) {
      e.stopPropagation();
      onEscape();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === container)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  });
  return () => {
    off();
    if (previous && previous.isConnected) previous.focus({ preventScroll: true });
  };
}

// ------------------------------------------------------------------ motion

let reducedQuery: MediaQueryList | null = null;
/** True when the player asked the OS for reduced motion. */
export function reducedMotion(): boolean {
  if (!reducedQuery && typeof matchMedia === 'function') reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');
  return reducedQuery ? reducedQuery.matches : false;
}

export const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);
export const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Run `step(k)` with eased k from 0 to 1 over `ms`. Returns cancel(). Reduced motion jumps to the end. */
export function tween(ms: number, step: (k: number) => void, done?: () => void, ease: (t: number) => number = easeOut): () => void {
  if (ms <= 0 || reducedMotion()) {
    step(1);
    if (done) done();
    return () => {};
  }
  let raf = 0;
  let t0 = -1;
  const frame = (now: number): void => {
    if (t0 < 0) t0 = now;
    const t = Math.min(1, (now - t0) / ms);
    step(ease(t));
    if (t < 1) raf = requestAnimationFrame(frame);
    else if (done) done();
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}

export interface NumberTween {
  el: HTMLSpanElement;
  /** Animate to `value` (or jump when animate is false). */
  set(value: number, animate?: boolean): void;
  readonly value: number;
  destroy(): void;
}

/** A tabular-numeral span whose value counts smoothly to each new target (credits, influence…). */
export function numberTween(format: (n: number) => string, initial = 0, ms = 420): NumberTween {
  const el = h('span.tl-num', { text: format(initial) });
  let shown = initial;
  let target = initial;
  let cancel: () => void = () => {};
  return {
    el,
    get value() {
      return target;
    },
    set(value, animate = true) {
      cancel();
      target = value;
      if (!animate || value === shown) {
        shown = value;
        setText(el, format(value));
        return;
      }
      const from = shown;
      cancel = tween(ms, (k) => {
        shown = lerp(from, value, k);
        setText(el, format(k === 1 ? value : shown));
      });
    },
    destroy() {
      cancel();
    },
  };
}

/** Web Animations wrapper: resolves when finished; instant under reduced motion. */
export function animate(el: Element, keyframes: Keyframe[], ms = 180, easing = 'cubic-bezier(0.2, 0.7, 0.2, 1)'): Promise<void> {
  if (reducedMotion() || typeof el.animate !== 'function') return Promise.resolve();
  return el
    .animate(keyframes, { duration: ms, easing, fill: 'both' })
    .finished.then(
      (a) => {
        // Keep the end state via inline styles only if the caller set them; drop the fill so
        // later CSS transitions are not blocked.
        a.cancel();
      },
      () => {},
    );
}

/** Screen / panel transition flavours. All are transform + opacity only. */
export type TransitionKind = 'fade' | 'rise' | 'drop' | 'push' | 'pop' | 'zoom';

const FRAMES: Record<TransitionKind, Keyframe[]> = {
  fade: [{ opacity: 0 }, { opacity: 1 }],
  rise: [{ opacity: 0, transform: 'translate3d(0, 14px, 0)' }, { opacity: 1, transform: 'none' }],
  drop: [{ opacity: 0, transform: 'translate3d(0, -14px, 0)' }, { opacity: 1, transform: 'none' }],
  push: [{ opacity: 0, transform: 'translate3d(28px, 0, 0)' }, { opacity: 1, transform: 'none' }],
  pop: [{ opacity: 0, transform: 'translate3d(-28px, 0, 0)' }, { opacity: 1, transform: 'none' }],
  zoom: [{ opacity: 0, transform: 'scale(0.97)' }, { opacity: 1, transform: 'none' }],
};

/** Animate an element in. */
export function enter(el: Element, kind: TransitionKind = 'rise', ms = 220): Promise<void> {
  return animate(el, FRAMES[kind], ms);
}

/** Animate an element out (the reverse of `enter`); the caller removes it afterwards. */
export function leave(el: Element, kind: TransitionKind = 'fade', ms = 140): Promise<void> {
  const f = FRAMES[kind];
  return animate(el, [f[1], f[0]], ms, 'cubic-bezier(0.5, 0, 0.9, 0.4)');
}

/**
 * Replace the current screen in `host` with `next`: the old one leaves, the new one enters.
 * `kind` 'push' moves forward (new screen arrives from the right), 'pop' goes back.
 */
export async function swapScreen(host: HTMLElement, next: HTMLElement, kind: TransitionKind = 'push'): Promise<void> {
  const old = host.lastElementChild;
  if (old) {
    await leave(old, kind === 'push' ? 'pop' : kind === 'pop' ? 'push' : 'fade', 110);
    old.remove();
  }
  host.appendChild(next);
  await enter(next, kind, 200);
}

/** Stagger the entrance of a list's children (rows of a freshly opened screen). Capped so long lists stay snappy. */
export function staggerIn(parent: Element, kind: TransitionKind = 'rise', gap = 24, max = 10): void {
  if (reducedMotion()) return;
  const kids = parent.children;
  const n = Math.min(kids.length, max);
  for (let i = 0; i < n; i++) {
    const el = kids[i];
    if (typeof el.animate !== 'function') return;
    el.animate(FRAMES[kind], { duration: 200, delay: i * gap, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', fill: 'backwards' });
  }
}
