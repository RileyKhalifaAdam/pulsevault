// TIDELOCK UI kit — in-flow components. Every factory returns { el, update(partial), destroy() }.
// Overlays (modal, sheet, toast, help, comms, splash) live in overlays.ts; charts in charts.ts.

import {
  h, svg, cx, clamp, setText, setChildren, setStyle, setAttr, disposer, listen, feedback,
  onTap, onHoldRepeat, onDrag, scrollArea, numberTween,
  type Child, type Component, type FeedbackKind, type NumberTween,
} from './kit';
import { icon, setIcon, type IconName } from './icons';

// ------------------------------------------------------------------ tone

export const TONES = ['ember', 'ion', 'red', 'green', 'neutral', 'dim', 'assembly', 'hegemony', 'league', 'independent', 'outlaw'] as const;
export type Tone = (typeof TONES)[number];
/** A named tone or any CSS colour (e.g. a minor faction's own colour as "#7fb2ff"). */
export type ToneOrColor = Tone | (string & {});

const isTone = (t: string): t is Tone => (TONES as readonly string[]).includes(t);

/** Point an element's accent (--tl-c) at a tone or explicit colour; undefined restores inheritance. */
export function setTone(el: HTMLElement | SVGElement, tone: ToneOrColor | undefined | null): void {
  for (const c of Array.from(el.classList)) if (c.startsWith('tl-tone-')) el.classList.remove(c);
  el.style.removeProperty('--tl-c');
  if (!tone) return;
  if (isTone(tone)) el.classList.add(`tl-tone-${tone}`);
  else el.style.setProperty('--tl-c', tone);
}

/** Linear RGB triple (0..1, as stored in sim data) -> CSS colour. */
export function rgbToCss(rgb: readonly [number, number, number]): string {
  const enc = (v: number): number => {
    const c = clamp(v, 0, 1);
    return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);
  };
  return `rgb(${enc(rgb[0])}, ${enc(rgb[1])}, ${enc(rgb[2])})`;
}

const fmtInt = (v: number): string => Math.round(v).toLocaleString('en-US');

// ------------------------------------------------------------------ panel

export interface PanelProps {
  title?: string;
  /** Small index code on the right of the header, e.g. "MKT·02". */
  code?: string;
  icon?: IconName;
  tone?: ToneOrColor;
  /** Tint the border and corner ticks with the tone. */
  accent?: boolean;
  /** No body padding (lists and tables run edge to edge). */
  flush?: boolean;
  tight?: boolean;
  /** Opaque glass without backdrop blur (cheap; use for nested or numerous panels). */
  solid?: boolean;
  /** Header-right controls. */
  actions?: Child;
  class?: string;
}

/** Glass card with corner ticks and an optional header. Children go in `.body`. */
export function Panel(props: PanelProps = {}, ...children: Child[]): Component<Pick<PanelProps, 'title' | 'code' | 'tone'>> & { body: HTMLElement } {
  const titleEl = h('div.tl-panel__title', { text: props.title ?? '' });
  const codeEl = h('div.tl-panel__code', { text: props.code ?? '' });
  const head = props.title !== undefined
    ? h('div.tl-panel__head', null, props.icon ? icon(props.icon, 16) : null, titleEl, props.code !== undefined ? codeEl : null, props.actions ? h('div.tl-panel__actions', null, props.actions) : null)
    : null;
  const body = h('div.tl-panel__body', null, ...children);
  const el = h('section.tl-panel', { class: [props.accent && 'tl-panel--accent', props.flush && 'tl-panel--flush', props.tight && 'tl-panel--tight', props.solid && 'tl-panel--solid', props.class] }, head, body);
  setTone(el, props.tone);
  return {
    el,
    body,
    update(p) {
      if (p.title !== undefined) setText(titleEl, p.title);
      if (p.code !== undefined) setText(codeEl, p.code);
      if (p.tone !== undefined) setTone(el, p.tone);
    },
    destroy() {
      el.remove();
    },
  };
}

// ------------------------------------------------------------------ screen scaffolding

export interface HeaderReadout {
  label: string;
  value: string;
  icon?: IconName;
  tone?: Tone;
}

export interface ScreenHeaderProps {
  title: string;
  /** Location line above the title, e.g. "Lantern Quay · Tessaly". */
  location?: string;
  locationIcon?: IconName;
  onBack?: () => void;
  onClose?: () => void;
  /** Player balance; animates when it changes. */
  credits?: number;
  /** Extra right-hand readouts on the title row (keep to one short one in portrait). */
  readouts?: HeaderReadout[];
  /** Hide the ember index mark. */
  plain?: boolean;
}

/**
 * Screen title bar with back / close, a location line and credit / status readouts. Portrait: the
 * location runs the full width above the title and the readouts share the title's baseline;
 * landscape phones fold everything into one row.
 */
export function ScreenHeader(props: ScreenHeaderProps): Component<Pick<ScreenHeaderProps, 'title' | 'location' | 'credits'>> {
  const d = disposer();
  const titleEl = h('h1.tl-header__title', { text: props.title });
  const locText = document.createTextNode(props.location ?? '');
  const locEl = h('div.tl-header__eyebrow', null, icon(props.locationIcon ?? 'station', 14), h('span.tl-ellipsis', null, locText));
  if (props.location === undefined) locEl.classList.add('tl-hidden');
  let creditsTween: NumberTween | null = null;
  const readouts = h('div.tl-header__readouts');
  for (const r of props.readouts ?? []) {
    readouts.appendChild(
      h('div.tl-header__readout', { class: r.tone && `tl-tone-${r.tone}` },
        h('span.tl-label', null, r.icon ? icon(r.icon, 12) : null, r.label),
        h('span.tl-header__readout-v.tl-num', { class: r.tone && 'tl-tone', text: r.value })),
    );
  }
  if (props.credits !== undefined) {
    creditsTween = numberTween(fmtInt, props.credits);
    d.add(() => creditsTween?.destroy());
    readouts.appendChild(
      h('div.tl-header__readout.tl-header__readout--credits', null,
        h('span.tl-label', null, 'Credits'),
        h('span.tl-header__readout-v', null, creditsTween.el, h('span.tl-unit', null, 'cr'))),
    );
  }
  const navBtn = (name: IconName, label: string, fn: () => void): HTMLElement => {
    const b = h('button.tl-header__nav', { class: name === 'close' && 'tl-header__nav--close', attrs: { type: 'button', 'aria-label': label } }, icon(name, 24));
    d.add(onTap(b, fn, { cue: 'close' }));
    return b;
  };
  const el = h('header.tl-header', { class: [props.plain && 'tl-header--plain', !props.onBack && 'tl-header--nonav', !props.onClose && 'tl-header--noclose'] },
    props.onBack ? navBtn('back', 'Back', props.onBack) : null,
    locEl, titleEl,
    readouts.childElementCount ? readouts : null,
    props.onClose ? navBtn('close', 'Close', props.onClose) : null);
  return {
    el,
    update(p) {
      if (p.title !== undefined) setText(titleEl, p.title);
      if (p.location !== undefined) {
        locText.data = p.location;
        locEl.classList.remove('tl-hidden');
      }
      if (p.credits !== undefined && creditsTween) creditsTween.set(p.credits);
    },
    destroy() {
      d.run();
      el.remove();
    },
  };
}

export interface ScreenProps {
  header?: Component<unknown> | HTMLElement;
  /** Fixed strip under the header (tabs, filters). */
  bar?: Child;
  body?: Child;
  /** Docked action area above the home indicator. */
  footer?: Child;
  /** 'opaque' (default) paints the void backdrop; 'glass' blurs the scene behind; 'clear' is transparent. */
  backdrop?: 'opaque' | 'glass' | 'clear';
  /** Body runs edge to edge (tables); default pads to the gutter. */
  flush?: boolean;
  /** Body scrolls. Default true. */
  scroll?: boolean;
}

/** Full-screen scaffold: header, optional bar, scrolling body, optional docked footer; safe-area aware. */
export function Screen(props: ScreenProps): Component & { body: HTMLElement; foot: HTMLElement | null } {
  const d = disposer();
  const body = h('div.tl-screen__body', { class: props.flush && 'tl-screen__body--flush' }, props.body);
  if (props.scroll !== false) d.add(scrollArea(body));
  const foot = props.footer ? h('div.tl-screen__foot', null, props.footer) : null;
  if (foot) body.style.paddingBottom = 'var(--tl-s5)';
  const headerEl = props.header ? ('el' in props.header ? props.header.el : props.header) : null;
  const el = h('div.tl-screen', { class: props.backdrop === 'glass' ? 'tl-screen--glass' : props.backdrop === 'clear' ? 'tl-screen--clear' : null }, headerEl, props.bar, body, foot);
  return {
    el,
    body,
    foot,
    update() {},
    destroy() {
      d.run();
      el.remove();
    },
  };
}

// ------------------------------------------------------------------ buttons

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'ion' | 'ember';

export interface ButtonProps {
  label?: string;
  icon?: IconName;
  trailingIcon?: IconName;
  /** Right-aligned figure, e.g. the total on a "Buy" button. */
  detail?: string;
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
  disabled?: boolean;
  /** Required for icon-only buttons. */
  ariaLabel?: string;
  onTap?: (e: Event) => void;
  cue?: FeedbackKind | false;
}

const buttonClass = (p: ButtonProps): string =>
  cx('tl-btn', p.variant && p.variant !== 'secondary' && `tl-btn--${p.variant}`, p.size && p.size !== 'md' && `tl-btn--${p.size}`,
    p.block && 'tl-btn--block', !p.label && p.icon && 'tl-btn--icon', p.detail !== undefined && p.block && 'tl-btn--spread');

/** Chamfered action button. Variants: primary (filled ember), secondary, ion, ember, ghost, danger. */
export function Button(props: ButtonProps): Component<Pick<ButtonProps, 'label' | 'detail' | 'disabled' | 'icon'>> {
  const labelEl = h('span.tl-btn__label', { text: props.label ?? '' });
  const detailEl = h('span.tl-btn__detail.tl-num', { text: props.detail ?? '' });
  const iconEl = props.icon ? icon(props.icon, props.size === 'sm' ? 16 : 20) : null;
  const lead = h('span.tl-row', { style: 'gap:8px' }, iconEl, props.label !== undefined ? labelEl : null);
  const el = h('button', { class: buttonClass(props), attrs: { type: 'button', 'aria-label': props.ariaLabel ?? null } },
    props.detail !== undefined ? lead : [iconEl, props.label !== undefined ? labelEl : null],
    props.detail !== undefined ? detailEl : null,
    props.trailingIcon ? icon(props.trailingIcon, 18) : null);
  el.disabled = !!props.disabled;
  const off = props.onTap ? onTap(el, props.onTap, { cue: props.cue ?? (props.variant === 'primary' ? 'confirm' : 'tap') }) : () => {};
  return {
    el,
    update(p) {
      if (p.label !== undefined) setText(labelEl, p.label);
      if (p.detail !== undefined) setText(detailEl, p.detail);
      if (p.disabled !== undefined) el.disabled = p.disabled;
      if (p.icon !== undefined && iconEl) setIcon(iconEl, p.icon);
    },
    destroy() {
      off();
      el.remove();
    },
  };
}

/** Square icon-only button (44 pt). */
export function IconButton(name: IconName, ariaLabel: string, onTapFn: (e: Event) => void, variant: ButtonVariant = 'ghost'): Component<Pick<ButtonProps, 'disabled' | 'icon'>> {
  return Button({ icon: name, ariaLabel, onTap: onTapFn, variant });
}

export interface HoldButtonProps {
  label: string;
  icon?: IconName;
  variant?: ButtonVariant;
  /** Hold time to confirm, ms. Default 900. */
  holdMs?: number;
  block?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
}

/**
 * Hold-to-confirm for irreversible actions (jettison cargo, abandon mission, self-destruct).
 * A ring fills while the finger stays down; releasing early winds it back. Keyboard / assistive
 * activation confirms directly.
 */
export function HoldButton(props: HoldButtonProps): Component<Pick<HoldButtonProps, 'label' | 'disabled'>> {
  const holdMs = props.holdMs ?? 900;
  const labelEl = h('span.tl-btn__label', { text: props.label });
  const ring = svg('svg', { class: 'tl-hold__ring', viewBox: '0 0 26 26' },
    svg('circle', { class: 't', cx: 13, cy: 13, r: 10 }),
    svg('circle', { class: 'p', cx: 13, cy: 13, r: 10, pathLength: 100 }));
  const el = h('button', { class: cx(buttonClass({ variant: props.variant ?? 'danger', block: props.block }), 'tl-hold'), attrs: { type: 'button' } },
    h('span.tl-hold__fill'), ring, props.icon ? icon(props.icon, 20) : null, labelEl);
  el.disabled = !!props.disabled;
  let progress = 0;
  let holding = false;
  let raf = 0;
  let last = 0;
  const paint = (): void => setStyle(el, '--hold', progress.toFixed(3));
  const frame = (now: number): void => {
    const dt = now - last;
    last = now;
    progress = clamp(progress + (holding ? dt / holdMs : -dt / 220), 0, 1);
    paint();
    if (holding && progress >= 1) {
      holding = false;
      progress = 0;
      el.classList.remove('tl-pressed');
      el.classList.add('tl-hold--done');
      window.setTimeout(() => {
        el.classList.remove('tl-hold--done');
        paint();
      }, 360);
      feedback('confirm');
      props.onConfirm();
      return;
    }
    if (holding || progress > 0) raf = requestAnimationFrame(frame);
  };
  const start = (): void => {
    if (el.disabled) return;
    holding = true;
    el.classList.add('tl-pressed');
    feedback('tick');
    cancelAnimationFrame(raf);
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };
  const stop = (): void => {
    if (!holding) return;
    holding = false;
    el.classList.remove('tl-pressed');
  };
  const d = disposer();
  d.add(listen(el, 'pointerdown', (e) => {
    if (e.isPrimary && e.button <= 0) start();
  }));
  d.add(listen(el, 'pointerup', stop));
  d.add(listen(el, 'pointercancel', stop));
  d.add(listen(el, 'pointerleave', stop));
  d.add(listen(el, 'contextmenu', (e) => e.preventDefault()));
  d.add(listen(el, 'click', (e) => {
    if (e.detail === 0 && !el.disabled) props.onConfirm();
  }));
  d.add(() => cancelAnimationFrame(raf));
  return {
    el,
    update(p) {
      if (p.label !== undefined) setText(labelEl, p.label);
      if (p.disabled !== undefined) el.disabled = p.disabled;
    },
    destroy() {
      d.run();
      el.remove();
    },
  };
}

// ------------------------------------------------------------------ toggle

export interface ToggleProps {
  label: string;
  hint?: string;
  value: boolean;
  tone?: ToneOrColor;
  disabled?: boolean;
  onChange?: (value: boolean) => void;
}

/** Instrument switch. The whole row is the touch target; state is shown by position, colour and ON/OFF text. */
export function Toggle(props: ToggleProps): Component<Pick<ToggleProps, 'value' | 'disabled' | 'label'>> {
  let value = props.value;
  const stateEl = h('span.tl-toggle__state');
  const labelEl = h('span.tl-toggle__label', { text: props.label });
  const el = h('button.tl-toggle', { attrs: { type: 'button', role: 'switch' } },
    h('span.tl-toggle__text', null, labelEl, props.hint ? h('span.tl-toggle__hint', { text: props.hint }) : null),
    stateEl,
    h('span.tl-toggle__track', null, h('span.tl-toggle__knob')));
  setTone(el, props.tone);
  el.disabled = !!props.disabled;
  const paint = (): void => {
    el.setAttribute('aria-checked', String(value));
    setText(stateEl, value ? 'On' : 'Off');
  };
  paint();
  const off = onTap(el, () => {
    value = !value;
    paint();
    props.onChange?.(value);
  }, { cue: 'toggle' });
  return {
    el,
    update(p) {
      if (p.label !== undefined) setText(labelEl, p.label);
      if (p.disabled !== undefined) el.disabled = p.disabled;
      if (p.value !== undefined && p.value !== value) {
        value = p.value;
        paint();
      }
    },
    destroy() {
      off();
      el.remove();
    },
  };
}

// ------------------------------------------------------------------ slider

export interface SliderProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  /** Value text; default rounds to the step. */
  format?: (value: number) => string;
  unit?: string;
  /** Number of ruler divisions under the rail (0 hides the ruler). Default 10. */
  ticks?: number;
  tone?: ToneOrColor;
  disabled?: boolean;
  /** Fires continuously while dragging. */
  onInput?: (value: number) => void;
  /** Fires when the finger lifts. */
  onChange?: (value: number) => void;
}

/** Horizontal slider with a ruler. The full 44 pt band is draggable; tap anywhere to jump. */
export function Slider(props: SliderProps): Component<Pick<SliderProps, 'value' | 'disabled'>> {
  const min = props.min ?? 0;
  const max = props.max ?? 1;
  const step = props.step ?? (max - min) / 100;
  const decimals = Math.max(0, Math.min(4, Math.ceil(-Math.log10(step))));
  const format = props.format ?? ((v: number) => v.toFixed(decimals));
  let value = clamp(props.value, min, max);
  const valueEl = h('span.tl-num', { text: format(value) });
  const thumb = h('div.tl-slider__thumb');
  const fill = h('div.tl-slider__fill');
  const zone = h('div.tl-slider__zone', { attrs: { role: 'slider', tabindex: 0, 'aria-valuemin': min, 'aria-valuemax': max, 'aria-label': props.label ?? null } },
    h('div.tl-slider__rail'), fill, props.ticks === 0 ? null : h('div.tl-slider__ticks', { style: { '--ticks': props.ticks ?? 10 } }), thumb);
  const el = h('div.tl-slider', { class: props.disabled && 'tl-slider--disabled' },
    props.label !== undefined || props.unit !== undefined
      ? h('div.tl-slider__head', null, h('span.tl-label', { text: props.label ?? '' }), h('span.tl-slider__value', null, valueEl, props.unit ? h('span.tl-unit', { text: props.unit }) : null))
      : null,
    zone);
  setTone(el, props.tone);
  let width = 0;
  const paint = (): void => {
    const p = max > min ? (value - min) / (max - min) : 0;
    setStyle(zone, '--p', p.toFixed(4));
    setStyle(zone, '--x', `${(p * width).toFixed(1)}px`);
    zone.setAttribute('aria-valuenow', String(value));
    zone.setAttribute('aria-valuetext', format(value));
    setText(valueEl, format(value));
  };
  const setFromX = (clientX: number): boolean => {
    const r = zone.getBoundingClientRect();
    width = r.width;
    const raw = min + clamp((clientX - r.left) / Math.max(1, r.width), 0, 1) * (max - min);
    const next = clamp(Math.round((raw - min) / step) * step + min, min, max);
    if (next === value) return false;
    value = next;
    paint();
    return true;
  };
  const d = disposer();
  d.add(onDrag(zone, {
    start(s) {
      el.classList.add('tl-slider--active');
      if (setFromX(s.x)) {
        feedback('tick');
        props.onInput?.(value);
      }
    },
    move(s) {
      if (setFromX(s.x)) {
        feedback('tick');
        props.onInput?.(value);
      }
    },
    end() {
      el.classList.remove('tl-slider--active');
      props.onChange?.(value);
    },
  }, { threshold: 0 }));
  d.add(listen(zone, 'keydown', (e) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    value = clamp(value + dir * step, min, max);
    paint();
    props.onInput?.(value);
    props.onChange?.(value);
  }));
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      width = zone.clientWidth;
      paint();
    });
    ro.observe(zone);
    d.add(() => ro.disconnect());
  }
  paint();
  return {
    el,
    update(p) {
      if (p.disabled !== undefined) el.classList.toggle('tl-slider--disabled', p.disabled);
      if (p.value !== undefined) {
        value = clamp(p.value, min, max);
        width = zone.clientWidth || width;
        paint();
      }
    },
    destroy() {
      d.run();
      el.remove();
    },
  };
}

// ------------------------------------------------------------------ stepper

export interface StepperProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  format?: (value: number) => string;
  unit?: string;
  block?: boolean;
  /** Narrower value field (tight rows beside a button). */
  compact?: boolean;
  tone?: ToneOrColor;
  ariaLabel?: string;
  onChange?: (value: number) => void;
}

/** − value + with press-and-hold: repeats accelerate, and long holds take 5× then 10× steps. */
export function Stepper(props: StepperProps): Component<Pick<StepperProps, 'value' | 'min' | 'max'>> {
  let min = props.min ?? 0;
  let max = props.max ?? Infinity;
  const step = props.step ?? 1;
  const format = props.format ?? fmtInt;
  let value = clamp(props.value, min, max);
  const valueEl = h('span.tl-num', { text: format(value) });
  const minus = h('button.tl-stepper__btn', { attrs: { type: 'button', 'aria-label': 'Decrease' } }, icon('minus', 20));
  const plus = h('button.tl-stepper__btn', { attrs: { type: 'button', 'aria-label': 'Increase' } }, icon('plus', 20));
  const el = h('div.tl-stepper', { class: [props.block && 'tl-stepper--block', props.compact && 'tl-stepper--compact'], attrs: { role: 'group', 'aria-label': props.ariaLabel ?? null } },
    minus, h('div.tl-stepper__value', null, valueEl, props.unit ? h('span.tl-unit', { text: props.unit }) : null), plus);
  setTone(el, props.tone);
  const paint = (): void => {
    setText(valueEl, format(value));
    (minus as HTMLButtonElement).disabled = value <= min;
    (plus as HTMLButtonElement).disabled = value >= max;
  };
  const bump = (dir: number, n: number): void => {
    const mult = n > 26 ? 10 : n > 10 ? 5 : 1;
    const next = clamp(value + dir * step * mult, min, max);
    if (next === value) return;
    value = next;
    paint();
    props.onChange?.(value);
  };
  paint();
  const offA = onHoldRepeat(minus, (n) => bump(-1, n));
  const offB = onHoldRepeat(plus, (n) => bump(1, n));
  return {
    el,
    update(p) {
      if (p.min !== undefined) min = p.min;
      if (p.max !== undefined) max = p.max;
      if (p.value !== undefined) value = p.value;
      value = clamp(value, min, max);
      paint();
    },
    destroy() {
      offA();
      offB();
      el.remove();
    },
  };
}

// ------------------------------------------------------------------ tabs, segmented control, chips

export interface ChoiceItem<T extends string = string> {
  id: T;
  label?: string;
  icon?: IconName;
  /** Tabs only: small counter. */
  count?: number;
  /** Required when there is no label. */
  ariaLabel?: string;
}

export interface TabsProps<T extends string = string> {
  items: ChoiceItem<T>[];
  value: T;
  /** Stretch tabs to fill the width instead of scrolling. */
  fill?: boolean;
  /** No side gutter (inside a panel). */
  inset?: boolean;
  onChange?: (id: T) => void;
}

/** Underlined tab strip; scrolls sideways when the tabs do not fit. */
export function Tabs<T extends string = string>(props: TabsProps<T>): Component<{ value: T }> {
  let value = props.value;
  const d = disposer();
  const buttons = new Map<T, HTMLElement>();
  const el = h('div.tl-tabs', { class: [props.fill && 'tl-tabs--fill', props.inset && 'tl-tabs--inset'], attrs: { role: 'tablist' } });
  const paint = (): void => {
    for (const [id, b] of buttons) b.setAttribute('aria-selected', String(id === value));
  };
  for (const item of props.items) {
    const b = h('button.tl-tab', { attrs: { type: 'button', role: 'tab', 'aria-label': item.ariaLabel ?? null } },
      item.icon ? icon(item.icon, 18) : null, item.label, item.count ? h('span.tl-tab__count.tl-num', { text: item.count }) : null);
    buttons.set(item.id, b);
    d.add(onTap(b, () => {
      if (item.id === value) return;
      value = item.id;
      paint();
      if (!props.fill) b.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
      props.onChange?.(value);
    }, { cue: 'toggle' }));
    el.appendChild(b);
  }
  if (!props.fill) d.add(scrollArea(el, { axis: 'x' }));
  paint();
  return {
    el,
    update(p) {
      if (p.value !== undefined) {
        value = p.value;
        paint();
      }
    },
    destroy() {
      d.run();
      el.remove();
    },
  };
}

export interface SegmentedProps<T extends string = string> {
  items: ChoiceItem<T>[];
  value: T;
  tone?: ToneOrColor;
  block?: boolean;
  onChange?: (id: T) => void;
}

/** Mutually exclusive choice in one framed strip (Buy / Sell, SAS hold modes, map layers). */
export function SegmentedControl<T extends string = string>(props: SegmentedProps<T>): Component<{ value: T }> {
  let value = props.value;
  const d = disposer();
  const buttons = new Map<T, HTMLElement>();
  const el = h('div.tl-seg', { class: props.block && 'tl-seg--block', attrs: { role: 'group' } });
  setTone(el, props.tone);
  const paint = (): void => {
    for (const [id, b] of buttons) b.setAttribute('aria-pressed', String(id === value));
  };
  for (const item of props.items) {
    const b = h('button.tl-seg__item', { attrs: { type: 'button', 'aria-label': item.ariaLabel ?? null } }, item.icon ? icon(item.icon, 20) : null, item.label);
    buttons.set(item.id, b);
    d.add(onTap(b, () => {
      if (item.id === value) return;
      value = item.id;
      paint();
      props.onChange?.(value);
    }, { cue: 'toggle' }));
    el.appendChild(b);
  }
  paint();
  return {
    el,
    update(p) {
      if (p.value !== undefined) {
        value = p.value;
        paint();
      }
    },
    destroy() {
      d.run();
      el.remove();
    },
  };
}

export interface ChipsProps<T extends string = string> {
  items: ChoiceItem<T>[];
  /** Selected id, or null for none. */
  value: T | null;
  tone?: ToneOrColor;
  inset?: boolean;
  /** Tapping the selected chip clears it. Default true. */
  clearable?: boolean;
  onChange?: (id: T | null) => void;
}

/** Sideways-scrolling filter chips (commodity categories, mission types). */
export function Chips<T extends string = string>(props: ChipsProps<T>): Component<{ value: T | null }> {
  let value = props.value;
  const d = disposer();
  const buttons = new Map<T, HTMLElement>();
  const el = h('div.tl-chips', { class: props.inset && 'tl-chips--inset', attrs: { role: 'group' } });
  setTone(el, props.tone);
  const paint = (): void => {
    for (const [id, b] of buttons) b.setAttribute('aria-pressed', String(id === value));
  };
  for (const item of props.items) {
    const b = h('button.tl-chip', { attrs: { type: 'button', 'aria-label': item.ariaLabel ?? null } },
      h('span.tl-chip__face', null, item.icon ? icon(item.icon, 16) : null, item.label));
    buttons.set(item.id, b);
    d.add(onTap(b, () => {
      value = item.id === value && props.clearable !== false ? null : item.id;
      paint();
      props.onChange?.(value);
    }, { cue: 'toggle' }));
    el.appendChild(b);
  }
  d.add(scrollArea(el, { axis: 'x' }));
  paint();
  return {
    el,
    update(p) {
      if (p.value !== undefined) {
        value = p.value;
        paint();
      }
    },
    destroy() {
      d.run();
      el.remove();
    },
  };
}

// ------------------------------------------------------------------ badge & delta

export interface BadgeProps {
  label: string;
  /** Tone, or any CSS colour for a faction's own colour. */
  tone?: ToneOrColor;
  icon?: IconName;
  solid?: boolean;
  /** Leading status dot. */
  dot?: boolean;
  /** Text and dot only, no frame (dense rows). */
  plain?: boolean;
}

/** Small framed label: faction / power allegiance, system state, legality, mission type. */
export function Badge(props: BadgeProps): Component<Pick<BadgeProps, 'label' | 'tone'>> {
  const text = document.createTextNode(props.label);
  const el = h('span.tl-badge', { class: [props.solid && 'tl-badge--solid', props.dot && 'tl-badge--dot', props.plain && 'tl-badge--plain'] }, props.icon ? icon(props.icon, 12) : null, text);
  setTone(el, props.tone ?? 'neutral');
  return {
    el,
    update(p) {
      if (p.label !== undefined) text.data = p.label;
      if (p.tone !== undefined) setTone(el, p.tone);
    },
    destroy() {
      el.remove();
    },
  };
}

export interface DeltaOptions {
  /** Text for the magnitude; default one decimal with a % sign. */
  format?: (abs: number) => string;
  /** A rise is bad news (buy prices, heat, bounty): swaps the green / red meaning. */
  invert?: boolean;
  /** Magnitudes below this read as flat. Default 0.0005. */
  flat?: number;
  /** Colour the arrow only by direction, without good/bad meaning. */
  neutral?: boolean;
}

/** Signed change with a direction arrow: ▲ +3.4%. Direction is carried by the glyph and sign, not colour alone. */
export function delta(value: number, opts: DeltaOptions = {}): HTMLElement {
  const flat = Math.abs(value) < (opts.flat ?? 0.0005);
  const up = value > 0;
  const format = opts.format ?? ((a: number) => `${(a * 100).toFixed(1)}%`);
  const good = opts.invert ? !up : up;
  const glyph = svg('svg', { viewBox: '0 0 8 8', width: 8, height: 8, 'aria-hidden': 'true' },
    svg('path', { d: flat ? 'M0 3.2h8v1.6H0z' : up ? 'M4 0.5l4 7H0z' : 'M4 7.5l-4-7h8z', fill: 'currentColor' }));
  return h('span.tl-delta.tl-num', { class: flat || opts.neutral ? null : good ? 'tl-delta--good' : 'tl-delta--bad' }, glyph, `${flat ? '' : up ? '+' : '−'}${format(Math.abs(value))}`);
}

// ------------------------------------------------------------------ list

export interface ListRowProps {
  title: string;
  subtitle?: Child;
  /** Row of badges under the subtitle. */
  meta?: Child;
  icon?: IconName;
  tone?: ToneOrColor;
  /** Right-hand figure. */
  value?: string;
  /** Small-caps unit after the figure ("cr", "t"). */
  unit?: string;
  /** Under the value: a delta() element, a countdown… */
  note?: Child;
  chevron?: boolean;
  selected?: boolean;
  onTap?: () => void;
}

/** One row: leading icon tile, title / subtitle / badges, trailing value + note, chevron. */
export function ListRow(props: ListRowProps): Component<Pick<ListRowProps, 'title' | 'value' | 'selected' | 'note'>> {
  const titleEl = h('div.tl-listrow__title', { text: props.title });
  const valueText = document.createTextNode(props.value ?? '');
  const valueEl = h('div.tl-listrow__value.tl-num', null, valueText, props.unit ? h('span.tl-unit', { text: props.unit }) : null);
  const noteEl = h('div', null, props.note);
  const el = h(props.onTap ? 'button.tl-listrow' : 'div.tl-listrow', { class: props.selected && 'tl-listrow--selected', attrs: props.onTap ? { type: 'button' } : undefined },
    props.icon ? h('span.tl-listrow__icon', null, icon(props.icon, 22)) : null,
    h('div.tl-listrow__main', null, titleEl,
      props.subtitle !== undefined ? h('div.tl-listrow__sub', null, props.subtitle) : null,
      props.meta !== undefined ? h('div.tl-listrow__meta', null, props.meta) : null),
    props.value !== undefined || props.note !== undefined ? h('div.tl-listrow__trail', null, props.value !== undefined ? valueEl : null, props.note !== undefined ? noteEl : null) : null,
    props.chevron ? h('span.tl-listrow__chev', null, icon('chevronRight', 18)) : null);
  setTone(el, props.tone);
  const off = props.onTap ? onTap(el, props.onTap) : () => {};
  return {
    el,
    update(p) {
      if (p.title !== undefined) setText(titleEl, p.title);
      if (p.value !== undefined && valueText.data !== p.value) valueText.data = p.value;
      if (p.note !== undefined) setChildren(noteEl, p.note);
      if (p.selected !== undefined) el.classList.toggle('tl-listrow--selected', p.selected);
    },
    destroy() {
      off();
      el.remove();
    },
  };
}

/** Vertical stack of rows with inset hairlines. */
export function List(rows: (Component<never> | Component<unknown> | HTMLElement)[]): Component & { set(rows: (Component<unknown> | HTMLElement)[]): void } {
  const el = h('div.tl-list', { attrs: { role: 'list' } });
  let current: (Component<unknown> | HTMLElement)[] = [];
  const set = (next: (Component<unknown> | HTMLElement)[]): void => {
    for (const r of current) if ('destroy' in r) r.destroy();
    el.textContent = '';
    current = next;
    for (const r of next) el.appendChild('el' in r ? r.el : r);
  };
  set(rows as (Component<unknown> | HTMLElement)[]);
  return {
    el,
    set,
    update() {},
    destroy() {
      set([]);
      el.remove();
    },
  };
}

// ------------------------------------------------------------------ data table

export interface Column<R> {
  id: string;
  label: string;
  /** CSS grid track: "minmax(0,1fr)", "76px"… */
  width: string;
  align?: 'left' | 'right';
  /** Enables tap-to-sort on the header when present. */
  sortValue?: (row: R) => number | string;
  render: (row: R) => Child;
}

export interface SortState {
  id: string;
  dir: 'asc' | 'desc';
}

export interface DataTableProps<R> {
  columns: Column<R>[];
  rows: R[];
  rowKey: (row: R) => string;
  sort?: SortState | null;
  selected?: string | null;
  onRowTap?: (row: R) => void;
  onSort?: (sort: SortState) => void;
  /** The table scrolls itself (sticky header). Set false inside an already scrolling parent. Default true. */
  scroll?: boolean;
}

/**
 * Grid table with a sticky header and tap-to-sort columns (first tap descending for numbers,
 * ascending for text; tap again to flip). Rows are 54 pt tall and fully tappable.
 */
export function DataTable<R>(props: DataTableProps<R>): Component<Pick<DataTableProps<R>, 'rows' | 'selected' | 'sort'>> {
  let rows = props.rows;
  let sort: SortState | null = props.sort ?? null;
  let selected = props.selected ?? null;
  const d = disposer();
  let rowOffs = disposer();
  const cols = props.columns.map((c) => c.width).join(' ');
  const head = h('div.tl-table__head', { attrs: { role: 'row' } });
  const body = h('div.tl-table__body', { attrs: { role: 'rowgroup' } });
  const scroller = h('div.tl-table__scroll', null, head, body);
  const el = h('div.tl-table', { style: { '--cols': cols }, attrs: { role: 'table' } }, scroller);
  if (props.scroll !== false) d.add(scrollArea(scroller, { fade: false }));
  const ths = new Map<string, HTMLElement>();
  for (const c of props.columns) {
    const sortable = !!c.sortValue;
    const caret = svg('svg', { class: 'tl-th__caret', viewBox: '0 0 10 10' }, svg('path', { d: 'M5 8.5L1 2.5h8z', fill: 'currentColor' }));
    const th = h(sortable ? 'button.tl-th' : 'div.tl-th', { class: [c.align === 'right' && 'tl-th--num', sortable && 'tl-th--sortable'], attrs: { role: 'columnheader', type: sortable ? 'button' : null } },
      c.align === 'right' && sortable ? caret : null, c.label, c.align !== 'right' && sortable ? caret : null);
    if (sortable) {
      d.add(onTap(th, () => {
        const probe = rows.length ? c.sortValue!(rows[0]) : 0;
        const firstDir: SortState['dir'] = typeof probe === 'number' ? 'desc' : 'asc';
        sort = sort && sort.id === c.id ? { id: c.id, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { id: c.id, dir: firstDir };
        render();
        props.onSort?.(sort);
      }, { cue: 'toggle' }));
    }
    ths.set(c.id, th);
    head.appendChild(th);
  }
  const sorted = (): R[] => {
    if (!sort) return rows;
    const col = props.columns.find((c) => c.id === sort!.id);
    if (!col || !col.sortValue) return rows;
    const sv = col.sortValue;
    const k = sort.dir === 'asc' ? 1 : -1;
    return rows.slice().sort((a, b) => {
      const x = sv(a);
      const y = sv(b);
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * k;
    });
  };
  const render = (): void => {
    for (const [id, th] of ths) setAttr(th, 'aria-sort', sort && sort.id === id ? (sort.dir === 'asc' ? 'ascending' : 'descending') : null);
    rowOffs.run();
    rowOffs = disposer();
    body.textContent = '';
    for (const row of sorted()) {
      const key = props.rowKey(row);
      const tr = h(props.onRowTap ? 'button.tl-tr' : 'div.tl-tr', { class: key === selected && 'tl-tr--selected', data: { key }, attrs: { role: 'row', type: props.onRowTap ? 'button' : null } });
      for (const c of props.columns) tr.appendChild(h('div.tl-td', { class: c.align === 'right' && 'tl-td--num', attrs: { role: 'cell' } }, c.render(row)));
      if (props.onRowTap) rowOffs.add(onTap(tr, () => props.onRowTap!(row)));
      body.appendChild(tr);
    }
  };
  render();
  return {
    el,
    update(p) {
      let full = false;
      if (p.rows !== undefined) {
        rows = p.rows;
        full = true;
      }
      if (p.sort !== undefined) {
        sort = p.sort;
        full = true;
      }
      if (p.selected !== undefined) {
        selected = p.selected;
        if (!full) for (const tr of Array.from(body.children) as HTMLElement[]) tr.classList.toggle('tl-tr--selected', tr.dataset.key === selected);
      }
      if (full) render();
    },
    destroy() {
      rowOffs.run();
      d.run();
      el.remove();
    },
  };
}

/** Table cell: icon + title + small uppercase sub-line (commodity name / category). */
export function cellMain(iconName: IconName | null, title: string, sub?: string, tone?: ToneOrColor): HTMLElement {
  const el = h('div.tl-cell-main', null,
    iconName ? h('span.tl-cell-main__icon', null, icon(iconName, 20)) : null,
    h('div.tl-cell-main__text', null, h('span.tl-cell-main__title', { text: title }), sub ? h('span.tl-cell-main__sub', { text: sub }) : null));
  setTone(el, tone ?? 'dim');
  return el;
}

/** Table cell: figure with an optional small line under it (a delta() element or text). */
export function cellFigure(text: string, sub?: Child): Child[] {
  return [h('span.tl-num', { text }), sub !== undefined ? (typeof sub === 'string' ? h('span.tl-cell-sub', { text: sub }) : sub) : null];
}

/** Table cell: stock / demand quantity over a thin level bar. `level` is 0..1. */
export function cellStock(level: number, text: string, tone: ToneOrColor = 'ion'): HTMLElement {
  const el = h('div.tl-stock', null, h('span.tl-stock__n.tl-num', { text }),
    h('div.tl-stock__bar', null, h('div.tl-stock__fill', { style: { '--p': clamp(level, 0, 1).toFixed(3) } })));
  setTone(el, tone);
  return el;
}

// ------------------------------------------------------------------ key / value

export interface KVItem {
  k: string;
  v: Child;
  unit?: string;
  tone?: Tone;
}

export interface KeyValueProps {
  items: KVItem[];
  /** Grid columns (grid layout). Default 2. */
  cols?: number;
  /** 'grid' = label over value tiles; 'rows' = label left, value right. */
  layout?: 'grid' | 'rows';
  size?: 'md' | 'lg';
}

/** Labelled readouts. `set(index, value)` updates one figure without rebuilding. */
export function KeyValue(props: KeyValueProps): Component<Pick<KeyValueProps, 'items'>> & { set(index: number, value: string): void } {
  const el = h('dl.tl-kv', { class: [props.layout === 'rows' && 'tl-kv--rows', props.size === 'lg' && 'tl-kv--lg'], style: { '--kv-cols': props.cols ?? 2 } });
  let values: HTMLElement[] = [];
  const build = (items: KVItem[]): void => {
    el.textContent = '';
    values = items.map((it) => {
      const v = h('span', null, it.v);
      el.appendChild(h('div.tl-kv__item', { class: it.tone && `tl-tone-${it.tone}` },
        h('dt.tl-kv__k.tl-label', { text: it.k }),
        h('dd.tl-kv__v.tl-num', null, v, it.unit ? h('span.tl-unit', { text: it.unit }) : null)));
      return v;
    });
  };
  build(props.items);
  return {
    el,
    set(index, value) {
      const v = values[index];
      if (v) setText(v, value);
    },
    update(p) {
      if (p.items) build(p.items);
    },
    destroy() {
      el.remove();
    },
  };
}

export interface ReadoutProps {
  label: string;
  value: string;
  unit?: string;
  tone?: ToneOrColor;
  size?: 'md' | 'lg';
  align?: 'left' | 'right';
  icon?: IconName;
}

/** HUD readout: small label over a large figure. `update({ value })` is cheap enough to call every frame. */
export function Readout(props: ReadoutProps): Component<Pick<ReadoutProps, 'value' | 'tone' | 'label'>> {
  const valueText = document.createTextNode(props.value);
  const labelText = document.createTextNode(props.label);
  const el = h('div.tl-readout', { class: [props.size === 'lg' && 'tl-readout--lg', props.align === 'right' && 'tl-readout--right', props.tone && 'tl-readout--tone'] },
    h('span.tl-label.tl-readout__k', null, props.icon ? icon(props.icon, 12) : null, labelText),
    h('span.tl-readout__v.tl-num', null, valueText, props.unit ? h('span.tl-unit', { text: props.unit }) : null));
  setTone(el, props.tone);
  return {
    el,
    update(p) {
      if (p.value !== undefined && valueText.data !== p.value) valueText.data = p.value;
      if (p.label !== undefined && labelText.data !== p.label) labelText.data = p.label;
      if (p.tone !== undefined) {
        setTone(el, p.tone);
        el.classList.toggle('tl-readout--tone', !!p.tone);
      }
    },
    destroy() {
      el.remove();
    },
  };
}

// ------------------------------------------------------------------ gauges

export interface GaugeProps {
  /** 'linear' bar, 'segmented' blocks, or 'radial' 270° arc. */
  kind?: 'linear' | 'segmented' | 'radial';
  /** Current value in [min, max]. */
  value: number;
  min?: number;
  max?: number;
  label?: string;
  icon?: IconName;
  /** Value text (already formatted); omit to hide. */
  text?: string;
  unit?: string;
  tone?: ToneOrColor;
  /** Segmented: number of blocks. Default 10. */
  segments?: number;
  /** Radial: diameter in px. Default 96. */
  size?: number;
  /** Linear: a reference mark at this value (e.g. Δv required against Δv available). */
  mark?: number;
  /** Radial: red-line zone as [from, to] in value units. */
  zone?: [number, number];
  /** Updated every frame: disables easing so the gauge tracks instantly. */
  live?: boolean;
  thickness?: 'thin' | 'md' | 'thick';
}

const ARC_START = 135; // degrees, clockwise from +X (SVG), sweeping 270°
const ARC_SWEEP = 270;
const polar = (cx: number, cy: number, r: number, deg: number): string => {
  const a = (deg * Math.PI) / 180;
  return `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
};
const arcPath = (cx: number, cy: number, r: number, from: number, to: number): string =>
  `M${polar(cx, cy, r, from)}A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${polar(cx, cy, r, to)}`;

/** Gauge in three shapes sharing one prop set. The unfilled track is a dim step of the same tone. */
export function Gauge(props: GaugeProps): Component<Pick<GaugeProps, 'value' | 'text' | 'tone' | 'mark'>> {
  const kind = props.kind ?? 'linear';
  const min = props.min ?? 0;
  const max = props.max ?? 1;
  const frac = (v: number): number => (max > min ? clamp((v - min) / (max - min), 0, 1) : 0);
  const textNode = document.createTextNode(props.text ?? '');
  let paint: (v: number) => void;
  let el: HTMLElement;
  let markEl: HTMLElement | null = null;

  if (kind === 'radial') {
    const size = props.size ?? 96;
    const r = 42;
    const track = svg('path', { class: 'tl-radial__track', d: arcPath(50, 50, r, ARC_START, ARC_START + ARC_SWEEP), 'stroke-width': 2, fill: 'none' });
    const value = svg('path', { class: 'tl-radial__value', d: arcPath(50, 50, r, ARC_START, ARC_START + ARC_SWEEP), 'stroke-width': 3.2, fill: 'none', pathLength: 100, 'stroke-dasharray': '100 100' });
    let ticks = '';
    for (let i = 0; i <= 10; i++) {
      const a = ARC_START + (ARC_SWEEP * i) / 10;
      ticks += `M${polar(50, 50, r - 5.5, a)}L${polar(50, 50, r - (i % 5 === 0 ? 10 : 8), a)}`;
    }
    const zone = props.zone
      ? svg('path', { class: 'tl-radial__zone', d: arcPath(50, 50, r + 4.5, ARC_START + ARC_SWEEP * frac(props.zone[0]), ARC_START + ARC_SWEEP * frac(props.zone[1])), 'stroke-width': 1.5, fill: 'none' })
      : null;
    el = h('div.tl-radial', { class: [props.live && 'tl-radial--live', size < 84 && 'tl-radial--sm'], style: { width: `${size}px`, height: `${size}px` } },
      svg('svg', { viewBox: '0 0 100 100', width: size, height: size, 'aria-hidden': 'true' }, track, svg('path', { class: 'tl-radial__ticks', d: ticks, 'stroke-width': 1, fill: 'none' }), zone, value),
      h('div.tl-radial__center', null, h('span.tl-radial__num.tl-num', null, textNode), props.unit ? h('span.tl-radial__unit', { text: props.unit }) : null),
      props.label ? h('div.tl-radial__label', { text: props.label }) : null);
    paint = (v) => value.setAttribute('stroke-dashoffset', (100 - frac(v) * 100).toFixed(2));
  } else {
    const head = props.label !== undefined || props.text !== undefined
      ? h('div.tl-gauge__head', null,
          h('span.tl-label.tl-gauge__label', null, props.icon ? icon(props.icon, 14) : null, props.label ?? ''),
          props.text !== undefined ? h('span.tl-gauge__value.tl-num', null, textNode, props.unit ? h('span.tl-unit', { text: props.unit }) : null) : null)
      : null;
    if (kind === 'segmented') {
      const count = props.segments ?? 10;
      const cells: HTMLElement[] = [];
      const bar = h('div.tl-segbar');
      for (let i = 0; i < count; i++) cells.push(bar.appendChild(h('i')));
      el = h('div.tl-gauge', null, head, bar);
      paint = (v) => {
        const lit = frac(v) * count;
        for (let i = 0; i < count; i++) {
          const c = cells[i];
          const on = lit >= i + 0.999;
          const part = !on && lit > i + 0.05;
          if (c.classList.contains('on') !== on) c.classList.toggle('on', on);
          if (c.classList.contains('part') !== part) c.classList.toggle('part', part);
        }
      };
    } else {
      const fill = h('div.tl-bar__fill');
      const bar = h('div.tl-bar', { class: [props.live && 'tl-bar--live', props.thickness === 'thin' && 'tl-bar--thin', props.thickness === 'thick' && 'tl-bar--thick'] }, fill);
      if (props.mark !== undefined) {
        markEl = h('div.tl-bar__mark', { style: { '--m': frac(props.mark).toFixed(4) } });
        bar.appendChild(markEl);
      }
      el = h('div.tl-gauge', { class: props.mark !== undefined && 'tl-gauge--marked' }, head, bar);
      paint = (v) => setStyle(fill, '--p', frac(v).toFixed(4));
    }
  }
  setTone(el, props.tone);
  el.setAttribute('role', 'meter');
  el.setAttribute('aria-valuemin', String(min));
  el.setAttribute('aria-valuemax', String(max));
  if (props.label) el.setAttribute('aria-label', props.label);
  let shown = NaN;
  const set = (v: number): void => {
    if (v === shown) return;
    shown = v;
    paint(v);
    el.setAttribute('aria-valuenow', String(v));
  };
  set(props.value);
  return {
    el,
    update(p) {
      if (p.value !== undefined) set(p.value);
      if (p.text !== undefined && textNode.data !== p.text) textNode.data = p.text;
      if (p.tone !== undefined) setTone(el, p.tone);
      if (p.mark !== undefined && markEl) setStyle(markEl, '--m', frac(p.mark).toFixed(4));
    },
    destroy() {
      el.remove();
    },
  };
}

/** Bare progress bar (no header). */
export function ProgressBar(props: { value: number; tone?: ToneOrColor; thickness?: 'thin' | 'md' | 'thick'; live?: boolean }): Component<Pick<GaugeProps, 'value' | 'tone'>> {
  return Gauge({ kind: 'linear', value: props.value, tone: props.tone, thickness: props.thickness, live: props.live });
}

// ------------------------------------------------------------------ influence

export interface InfluenceSegment {
  id: string;
  label: string;
  /** Share 0..1 (segments need not sum to exactly 1). */
  value: number;
  /** Faction colour: a tone or CSS colour. */
  color: ToneOrColor;
  /** Change since the last tick, in share points (0.012 = +1.2). */
  delta?: number;
  /** Marks the controlling faction. */
  controlling?: boolean;
  /** Extra inline elements after the name (state badges). */
  badges?: Child;
}

export interface InfluenceProps {
  segments: InfluenceSegment[];
  /** Name / share / change rows under the bar. Default true. */
  legend?: boolean;
  /** 0 – 50 – 100 % scale under the bar. */
  scale?: boolean;
}

/**
 * Faction influence in one system: a stacked bar (2 px gaps, controlling faction flagged) with a
 * legend that names every segment — identity never rests on colour alone.
 */
export function StackedInfluenceBar(props: InfluenceProps): Component<Pick<InfluenceProps, 'segments'>> {
  const bar = h('div.tl-influence__bar', { attrs: { role: 'img' } });
  const legend = h('div.tl-influence__legend');
  const el = h('div.tl-influence', null, bar,
    props.scale ? h('div.tl-influence__scale.tl-num', null, h('span', null, '0'), h('span', null, '50'), h('span', null, '100%')) : null,
    props.legend === false ? null : legend);
  const build = (segments: InfluenceSegment[]): void => {
    bar.textContent = '';
    legend.textContent = '';
    bar.setAttribute('aria-label', segments.map((s) => `${s.label} ${(s.value * 100).toFixed(1)}%`).join(', '));
    for (const s of segments) {
      const seg = h('div.tl-influence__seg', { class: s.controlling && 'tl-influence__seg--ctrl', style: { flex: `${Math.max(0.0001, s.value).toFixed(4)} 1 0px` } });
      setTone(seg, s.color);
      bar.appendChild(seg);
      const row = h('div.tl-influence__row', null,
        h('span.tl-influence__sw'),
        h('span.tl-row', { style: 'gap:8px' }, h('span.tl-influence__name', { text: s.label }), s.controlling ? h('span.tl-influence__ctrl', null, 'Control') : null, s.badges),
        h('span.tl-influence__pct.tl-num', { text: `${(s.value * 100).toFixed(1)}%` }),
        s.delta !== undefined ? delta(s.delta, { format: (a) => (a * 100).toFixed(1) }) : h('span'));
      setTone(row, s.color);
      legend.appendChild(row);
    }
  };
  build(props.segments);
  return {
    el,
    update(p) {
      if (p.segments) build(p.segments);
    },
    destroy() {
      el.remove();
    },
  };
}

// ------------------------------------------------------------------ empty state & skeleton

export interface EmptyStateProps {
  icon: IconName;
  title: string;
  message?: string;
  action?: Component<unknown> | HTMLElement;
}

/** Placeholder for an empty list: what is missing and what to do about it. */
export function EmptyState(props: EmptyStateProps): Component {
  const el = h('div.tl-empty', null,
    h('div.tl-empty__icon', null, icon(props.icon, 28)),
    h('div.tl-empty__title', { text: props.title }),
    props.message ? h('p.tl-empty__msg', { text: props.message }) : null,
    props.action ? ('el' in props.action ? props.action.el : props.action) : null);
  return {
    el,
    update() {},
    destroy() {
      el.remove();
    },
  };
}

export interface SkeletonProps {
  /** 'rows' = list rows with an icon tile; 'lines' = text lines. */
  kind?: 'rows' | 'lines';
  count?: number;
}

/** Loading shimmer that mirrors the layout it stands in for. */
export function Skeleton(props: SkeletonProps = {}): Component {
  const count = props.count ?? 3;
  const el = h('div.tl-skel', { attrs: { 'aria-busy': 'true', 'aria-label': 'Loading' } });
  const widths = [72, 54, 88, 63, 80, 46];
  for (let i = 0; i < count; i++) {
    if (props.kind === 'lines') {
      el.appendChild(h('div.tl-skel__bar', { style: `width:${widths[i % widths.length]}%` }));
    } else {
      el.appendChild(h('div.tl-skel__row', null, h('div.tl-skel__box'),
        h('div.tl-col.tl-grow', { style: 'gap:8px' }, h('div.tl-skel__bar', { style: `width:${widths[i % widths.length]}%` }), h('div.tl-skel__bar', { style: `width:${widths[(i + 3) % widths.length] * 0.6}%;height:8px` })),
        h('div.tl-skel__bar', { style: 'width:52px' })));
    }
  }
  return {
    el,
    update() {},
    destroy() {
      el.remove();
    },
  };
}
