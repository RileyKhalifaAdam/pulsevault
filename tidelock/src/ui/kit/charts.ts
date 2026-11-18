// TIDELOCK UI kit — small canvas charts: Sparkline, LineChart (line / area, multi-series), BarChart.
// Canvases are sized in device pixels (up to 3×) and hairlines are snapped to whole CSS pixels, so
// everything stays crisp on an iPhone 15. Charts redraw only when their data or size changes.

import { h, clamp, disposer, listen, type Component } from './kit';
import { TONES, setTone, type Tone, type ToneOrColor } from './components';

// ------------------------------------------------------------------ colour

/** Tone -> colour. Mirrors tokens.css (canvas cannot read custom properties cheaply). */
const TONE_HEX: Record<Tone, string> = {
  ember: '#ffb454', ion: '#6fe3ff', red: '#ff5a4d', green: '#63e6a1', neutral: '#c3cfdb', dim: '#8fa3b8',
  assembly: '#3fd0c9', hegemony: '#f2b84b', league: '#9b7bff', independent: '#8a97a6', outlaw: '#ff5a4d',
};
const INK = { text: '#e8eef5', dim: '#8fa3b8', grid: 'rgba(255, 255, 255, 0.07)', axis: 'rgba(255, 255, 255, 0.2)' };

/** Resolve a tone name or CSS colour to a CSS colour string. */
export function toneColor(tone: ToneOrColor | undefined, fallback: Tone = 'ion'): string {
  if (!tone) return TONE_HEX[fallback];
  return (TONES as readonly string[]).includes(tone) ? TONE_HEX[tone as Tone] : tone;
}

let scratch: CanvasRenderingContext2D | null = null;
const rgbCache = new Map<string, [number, number, number]>();

/** Any CSS colour -> [r, g, b] 0..255 (canvas normalises the syntax for us). */
function rgbOf(color: string): [number, number, number] {
  let out = rgbCache.get(color);
  if (out) return out;
  out = [143, 163, 184];
  if (!scratch && typeof document !== 'undefined') scratch = document.createElement('canvas').getContext('2d');
  if (scratch) {
    scratch.fillStyle = '#000';
    scratch.fillStyle = color;
    const s = String(scratch.fillStyle);
    if (s[0] === '#') out = [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
    else {
      const m = s.match(/[\d.]+/g);
      if (m && m.length >= 3) out = [Number(m[0]), Number(m[1]), Number(m[2])];
    }
  }
  rgbCache.set(color, out);
  return out;
}

const alpha = (color: string, a: number): string => {
  const [r, g, b] = rgbOf(color);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

// ------------------------------------------------------------------ canvas surface

interface Surface {
  canvas: HTMLCanvasElement;
  /** Request a redraw on the next frame. */
  invalidate(): void;
  destroy(): void;
}

type Painter = (ctx: CanvasRenderingContext2D, w: number, h: number, font: string) => void;

/** A DPR-aware canvas inside `host`. With `fixed` the size is constant; otherwise it follows the host's box. */
function surface(host: HTMLElement, paint: Painter, fixed?: { w: number; h: number }): Surface {
  const canvas = h('canvas', { attrs: { 'aria-hidden': 'true' } });
  if (fixed) {
    canvas.style.width = `${fixed.w}px`;
    canvas.style.height = `${fixed.h}px`;
  }
  host.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  let queued = 0;
  let family = '';
  const draw = (): void => {
    queued = 0;
    if (!ctx) return;
    const w = fixed ? fixed.w : host.clientWidth;
    const hgt = fixed ? fixed.h : host.clientHeight;
    if (w <= 0 || hgt <= 0) return;
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    const pw = Math.round(w * dpr);
    const ph = Math.round(hgt * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    if (!family && host.isConnected) family = getComputedStyle(host).fontFamily;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    paint(ctx, w, hgt, family || 'system-ui, sans-serif');
  };
  const invalidate = (): void => {
    if (!queued) queued = requestAnimationFrame(draw);
  };
  const d = disposer();
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(invalidate);
    ro.observe(host);
    d.add(() => ro.disconnect());
  }
  d.add(() => cancelAnimationFrame(queued));
  invalidate();
  return { canvas, invalidate, destroy: d.run };
}

/** Snap a 1 px hairline coordinate to the pixel grid. */
const snap = (v: number): number => Math.round(v) + 0.5;

function range(values: number[][], lo?: number, hi?: number, pad = 0.08): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const vs of values) for (const v of vs) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) {
    min = 0;
    max = 1;
  }
  if (max - min < 1e-9) {
    const bump = Math.abs(max) * 0.05 || 1;
    min -= bump;
    max += bump;
  }
  const span = max - min;
  return [lo ?? min - span * pad, hi ?? max + span * pad];
}

function tracePath(ctx: CanvasRenderingContext2D, values: number[], x: (i: number) => number, y: (v: number) => number): void {
  ctx.beginPath();
  let pen = false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      pen = false;
      continue;
    }
    if (pen) ctx.lineTo(x(i), y(v));
    else ctx.moveTo(x(i), y(v));
    pen = true;
  }
}

function endDot(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, r = 2.25): void {
  ctx.fillStyle = alpha(color, 0.22);
  ctx.beginPath();
  ctx.arc(x, y, r + 2.75, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

// ------------------------------------------------------------------ sparkline

export interface SparklineProps {
  values: number[];
  /** px. Default 64 × 24. */
  width?: number;
  height?: number;
  /** A tone / colour, or 'trend' to pick go-green / signal-red from first vs last value. Default 'ion'. */
  tone?: ToneOrColor | 'trend';
  /** Soft fill under the line. */
  area?: boolean;
  /** Dot on the latest value. Default true. */
  dot?: boolean;
  /** Fix the vertical range instead of fitting the data. */
  min?: number;
  max?: number;
}

/** Word-sized trend line for table rows and list rows. */
export function Sparkline(props: SparklineProps): Component<Pick<SparklineProps, 'values' | 'tone'>> {
  let values = props.values;
  let tone = props.tone ?? 'ion';
  const w = props.width ?? 64;
  const hgt = props.height ?? 24;
  const el = h('span.tl-spark', { style: { width: `${w}px`, height: `${hgt}px` }, attrs: { role: 'img' } });
  const describe = (): void => {
    const first = values[0] ?? 0;
    const last = values[values.length - 1] ?? 0;
    el.setAttribute('aria-label', last > first ? 'Trend rising' : last < first ? 'Trend falling' : 'Trend flat');
  };
  const s = surface(el, (ctx, cw, ch) => {
    if (values.length < 2) return;
    const color = tone === 'trend' ? TONE_HEX[values[values.length - 1] >= values[0] ? 'green' : 'red'] : toneColor(tone);
    const [lo, hi] = range([values], props.min, props.max, 0);
    const padX = 1;
    const padR = props.dot === false ? 1 : 5;
    const padY = 4;
    const x = (i: number): number => padX + (i / (values.length - 1)) * (cw - padX - padR);
    const y = (v: number): number => ch - padY - ((v - lo) / (hi - lo)) * (ch - padY * 2);
    if (props.area) {
      tracePath(ctx, values, x, y);
      ctx.lineTo(x(values.length - 1), ch);
      ctx.lineTo(x(0), ch);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, 0, 0, ch);
      g.addColorStop(0, alpha(color, 0.28));
      g.addColorStop(1, alpha(color, 0));
      ctx.fillStyle = g;
      ctx.fill();
    }
    tracePath(ctx, values, x, y);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
    if (props.dot !== false) endDot(ctx, x(values.length - 1), y(values[values.length - 1]), color, 1.75);
  }, { w, h: hgt });
  describe();
  return {
    el,
    update(p) {
      if (p.values) values = p.values;
      if (p.tone) tone = p.tone;
      describe();
      s.invalidate();
    },
    destroy() {
      s.destroy();
      el.remove();
    },
  };
}

// ------------------------------------------------------------------ line / area chart

export interface ChartSeries {
  label?: string;
  color?: ToneOrColor;
  values: number[];
  /** Soft gradient fill under this line. */
  area?: boolean;
  dashed?: boolean;
  /** Draw fainter (context series behind the one that matters). */
  muted?: boolean;
}

export interface ChartMarker {
  /** Sample index the marker sits on. */
  index: number;
  label?: string;
  tone?: ToneOrColor;
}

export interface LineChartProps {
  series: ChartSeries[];
  /** px. Default 132. */
  height?: number;
  /** Labels spread evenly along the x axis (first at the left edge, last at the right). */
  xLabels?: string[];
  /** y tick text. Default: compact number. */
  yFormat?: (v: number) => string;
  /** Number of horizontal divisions. Default 3. */
  yTicks?: number;
  min?: number;
  max?: number;
  /** Vertical event markers. */
  markers?: ChartMarker[];
  /** Touch-and-drag along the chart to read values (never hover). Default false. */
  scrub?: boolean;
  /** Scrub callback: sample index, or null when the finger lifts. */
  onScrub?: (index: number | null) => void;
  ariaLabel?: string;
}

function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

/** Compact axis number with a true minus sign: 950, 1,250, 12k, 3.4M, −900. */
const compact = (v: number): string => {
  const a = Math.abs(v);
  const body = a >= 1e6 ? `${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`
    : a >= 1e4 ? `${(a / 1e3).toFixed(0)}k`
    : a >= 1e3 ? Math.round(a).toLocaleString('en-US')
    : Number.isInteger(a) ? String(a) : a.toFixed(a < 10 ? 1 : 0);
  return v < 0 ? `−${body}` : body;
};

/** Line / area chart with a quiet grid, right-hand value scale, event markers and touch scrubbing. */
export function LineChart(props: LineChartProps): Component<Pick<LineChartProps, 'series' | 'markers' | 'xLabels'>> {
  let series = props.series;
  let markers = props.markers ?? [];
  let xLabels = props.xLabels;
  let scrubIndex: number | null = null;
  const fmt = props.yFormat ?? compact;
  const el = h('div.tl-chart', { class: props.scrub && 'tl-chart--scrub', style: { height: `${props.height ?? 132}px` }, attrs: { role: 'img', 'aria-label': props.ariaLabel ?? 'Chart' } });
  let plot = { l: 0, r: 0, n: 0 };
  const s = surface(el, (ctx, w, hgt, family) => {
    const n = series.reduce((m, sr) => Math.max(m, sr.values.length), 0);
    if (n < 2) return;
    const [dLo, dHi] = range(series.map((sr) => sr.values), props.min, props.max);
    const ticks = Math.max(1, props.yTicks ?? 3);
    const step = niceStep((dHi - dLo) / ticks);
    const lo = props.min ?? Math.floor(dLo / step) * step;
    const hi = props.max ?? Math.ceil(dHi / step) * step;
    ctx.font = `600 11px ${family}`;
    ctx.textBaseline = 'middle';
    const tickVals: number[] = [];
    for (let v = lo; v <= hi + step * 0.001; v += step) tickVals.push(v);
    let gutter = 0;
    for (const v of tickVals) gutter = Math.max(gutter, ctx.measureText(fmt(v)).width);
    const hasMarkLabel = markers.some((m) => m.label);
    const top = hasMarkLabel ? 18 : 7;
    const bottom = hgt - (xLabels && xLabels.length ? 20 : 7);
    const left = 2;
    const right = Math.max(left + 10, w - Math.ceil(gutter) - 10);
    plot = { l: left, r: right, n };
    const x = (i: number): number => left + (i / (n - 1)) * (right - left);
    const y = (v: number): number => bottom - ((v - lo) / (hi - lo)) * (bottom - top);

    // grid + scale
    ctx.lineWidth = 1;
    for (const v of tickVals) {
      const gy = snap(y(v));
      ctx.strokeStyle = v === tickVals[0] ? INK.axis : INK.grid;
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(right + 4, gy);
      ctx.stroke();
      ctx.fillStyle = INK.dim;
      ctx.textAlign = 'left';
      ctx.fillText(fmt(v), right + 10, clamp(gy, 6, hgt - 6));
    }
    if (xLabels && xLabels.length) {
      ctx.fillStyle = INK.dim;
      ctx.textBaseline = 'alphabetic';
      xLabels.forEach((t, i) => {
        const k = xLabels!.length === 1 ? 0 : i / (xLabels!.length - 1);
        ctx.textAlign = i === 0 ? 'left' : i === xLabels!.length - 1 ? 'right' : 'center';
        const lx = left + k * (right - left);
        ctx.fillText(t, lx, hgt - 2);
        ctx.strokeStyle = INK.axis;
        ctx.beginPath();
        ctx.moveTo(snap(clamp(lx, left, right - 1)), bottom);
        ctx.lineTo(snap(clamp(lx, left, right - 1)), bottom + 4);
        ctx.stroke();
      });
      ctx.textBaseline = 'middle';
    }

    // event markers
    for (const m of markers) {
      const mx = snap(x(clamp(m.index, 0, n - 1)));
      const color = toneColor(m.tone, 'ember');
      ctx.strokeStyle = alpha(color, 0.55);
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(mx, top - 4);
      ctx.lineTo(mx, bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      if (m.label) {
        const tw = ctx.measureText(m.label.toUpperCase()).width;
        ctx.fillStyle = color;
        ctx.textAlign = 'left';
        ctx.fillText(m.label.toUpperCase(), clamp(mx - tw / 2, 0, right - tw), 7);
      }
    }

    // series: muted first, then the rest, so the important lines sit on top
    const order = series.slice().sort((a, b) => Number(!!b.muted) - Number(!!a.muted));
    for (const sr of order) {
      const color = toneColor(sr.color);
      if (sr.area) {
        tracePath(ctx, sr.values, x, y);
        ctx.lineTo(x(sr.values.length - 1), bottom);
        ctx.lineTo(x(0), bottom);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, top, 0, bottom);
        g.addColorStop(0, alpha(color, 0.26));
        g.addColorStop(1, alpha(color, 0));
        ctx.fillStyle = g;
        ctx.fill();
      }
      tracePath(ctx, sr.values, x, y);
      ctx.strokeStyle = sr.muted ? alpha(color, 0.5) : color;
      ctx.lineWidth = sr.muted ? 1 : 1.5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      if (sr.dashed) ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      const lastI = sr.values.length - 1;
      if (!sr.muted && scrubIndex === null) endDot(ctx, x(lastI), y(sr.values[lastI]), color);
    }

    // scrub crosshair
    if (scrubIndex !== null) {
      const i = clamp(scrubIndex, 0, n - 1);
      const sx = snap(x(i));
      ctx.strokeStyle = 'rgba(232, 238, 245, 0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx, top - 2);
      ctx.lineTo(sx, bottom);
      ctx.stroke();
      for (const sr of series) {
        const v = sr.values[i];
        if (Number.isFinite(v)) endDot(ctx, x(i), y(v), toneColor(sr.color));
      }
      const lead = series.find((sr) => !sr.muted) ?? series[0];
      const v = lead.values[i];
      if (Number.isFinite(v)) {
        // Value tag at the top of the crosshair, on a dark plate so it reads over the grid and lines.
        const text = fmt(v);
        const tw = ctx.measureText(text).width;
        const tx = clamp(sx - tw / 2, 4, right - tw - 4);
        ctx.fillStyle = 'rgba(8, 11, 16, 0.9)';
        ctx.fillRect(Math.round(tx) - 4, 0, Math.ceil(tw) + 8, 15);
        ctx.fillStyle = INK.text;
        ctx.textAlign = 'left';
        ctx.fillText(text, tx, 8);
      }
    }
  });
  const d = disposer();
  if (props.scrub) {
    let id = -1;
    const at = (e: PointerEvent): void => {
      const r = el.getBoundingClientRect();
      const k = clamp((e.clientX - r.left - plot.l) / Math.max(1, plot.r - plot.l), 0, 1);
      const i = Math.round(k * (plot.n - 1));
      if (i === scrubIndex) return;
      scrubIndex = i;
      props.onScrub?.(i);
      s.invalidate();
    };
    const end = (e: PointerEvent): void => {
      if (e.pointerId !== id) return;
      id = -1;
      scrubIndex = null;
      props.onScrub?.(null);
      s.invalidate();
    };
    d.add(listen(el, 'pointerdown', (e) => {
      if (!e.isPrimary) return;
      id = e.pointerId;
      try {
        el.setPointerCapture(id);
      } catch {
        /* pointer already gone */
      }
      at(e);
    }));
    d.add(listen(el, 'pointermove', (e) => {
      if (e.pointerId === id) at(e);
    }));
    d.add(listen(el, 'pointerup', end));
    d.add(listen(el, 'pointercancel', end));
  }
  return {
    el,
    update(p) {
      if (p.series) series = p.series;
      if (p.markers) markers = p.markers;
      if (p.xLabels) xLabels = p.xLabels;
      s.invalidate();
    },
    destroy() {
      d.run();
      s.destroy();
      el.remove();
    },
  };
}

// ------------------------------------------------------------------ bar chart

export interface BarChartProps {
  values: number[];
  /** One label per bar ('' to skip), drawn under the axis. */
  labels?: string[];
  tone?: ToneOrColor;
  /** Positive bars go green and negative bars red around a zero line (profit / loss, influence change). */
  signed?: boolean;
  /** Index of the bar to emphasise (the others dim). */
  highlight?: number;
  /** px. Default 96. */
  height?: number;
  yFormat?: (v: number) => string;
  /** Show the top value on the right-hand scale. Default true. */
  scale?: boolean;
  ariaLabel?: string;
}

/** Compact bar chart: 2 px gaps, square ends on a hairline baseline. */
export function BarChart(props: BarChartProps): Component<Pick<BarChartProps, 'values' | 'highlight'>> {
  let values = props.values;
  let highlight = props.highlight;
  const fmt = props.yFormat ?? compact;
  const el = h('div.tl-chart', { style: { height: `${props.height ?? 96}px` }, attrs: { role: 'img', 'aria-label': props.ariaLabel ?? 'Bar chart' } });
  setTone(el, props.tone);
  const s = surface(el, (ctx, w, hgt, family) => {
    const n = values.length;
    if (!n) return;
    let max = Math.max(0, ...values);
    let min = Math.min(0, ...values);
    if (max - min < 1e-9) max = min + 1;
    const bstep = niceStep((max - min) / 4);
    max = Math.ceil(max / bstep - 1e-9) * bstep;
    min = Math.floor(min / bstep + 1e-9) * bstep;
    ctx.font = `600 11px ${family}`;
    const showScale = props.scale !== false;
    const topText = fmt(max);
    const lowText = min < 0 ? fmt(min) : '';
    const gutter = showScale ? Math.ceil(Math.max(ctx.measureText(topText).width, ctx.measureText(lowText).width)) + 10 : 0;
    const top = 7;
    const bottom = hgt - (props.labels ? 20 : 7);
    const left = 0;
    const right = w - gutter;
    const y = (v: number): number => bottom - ((v - min) / (max - min)) * (bottom - top);
    const zero = snap(y(0));
    const gap = n > 40 ? 1 : 2;
    const bw = Math.max(1, (right - left - gap * (n - 1)) / n);
    const base = toneColor(props.tone);
    ctx.lineWidth = 1;
    ctx.strokeStyle = INK.grid;
    ctx.beginPath();
    ctx.moveTo(left, snap(top));
    ctx.lineTo(right + 4, snap(top));
    ctx.stroke();
    for (let i = 0; i < n; i++) {
      const v = values[i];
      const color = props.signed ? TONE_HEX[v >= 0 ? 'green' : 'red'] : base;
      const bx = Math.round(left + i * (bw + gap));
      const bx2 = Math.round(left + i * (bw + gap) + bw);
      const by = v >= 0 ? Math.round(y(v)) : Math.round(zero);
      const bh = Math.max(1, Math.abs(Math.round(y(v)) - Math.round(zero)));
      ctx.fillStyle = alpha(color, highlight === undefined ? 0.85 : i === highlight ? 1 : 0.38);
      ctx.fillRect(bx, by, Math.max(1, bx2 - bx), bh);
    }
    ctx.strokeStyle = INK.axis;
    ctx.beginPath();
    ctx.moveTo(left, zero);
    ctx.lineTo(right + 4, zero);
    ctx.stroke();
    ctx.fillStyle = INK.dim;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    if (showScale) {
      ctx.fillText(topText, right + 10, top + 0.5);
      ctx.fillText(fmt(0), right + 10, zero);
      if (min < 0 && bottom - zero > 14) ctx.fillText(lowText, right + 10, bottom);
    }
    if (props.labels) {
      ctx.textBaseline = 'alphabetic';
      props.labels.forEach((t, i) => {
        if (!t) return;
        const cx = left + i * (bw + gap) + bw / 2;
        const tw = ctx.measureText(t).width;
        ctx.textAlign = 'left';
        ctx.fillStyle = i === highlight ? INK.text : INK.dim;
        ctx.fillText(t, clamp(cx - tw / 2, left, right - tw), hgt - 2);
      });
    }
  });
  return {
    el,
    update(p) {
      if (p.values) values = p.values;
      if (p.highlight !== undefined) highlight = p.highlight;
      s.invalidate();
    },
    destroy() {
      s.destroy();
      el.remove();
    },
  };
}

// ------------------------------------------------------------------ legend

/** Line-key legend for multi-series charts; every series is named, so colour is never the only cue. */
export function Legend(items: { label: string; color?: ToneOrColor; value?: string }[]): HTMLElement {
  return h('div.tl-legend', null, items.map((it) => {
    const item = h('span.tl-legend__item', null, h('i.tl-legend__key'), it.label, it.value !== undefined ? h('span.tl-num.tl-legend__value', { text: it.value }) : null);
    setTone(item, it.color ?? 'ion');
    return item;
  }));
}
