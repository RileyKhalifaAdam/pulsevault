// Dynamic-resolution controller (src/render/post/dynres.ts) under simulated frame pacing.
// Pure logic: no DOM, no three.js. The simulated display is a 60 Hz vsync'd panel, so a frame that costs
// more than one refresh interval is shown one whole interval late — the only signal a browser gives.

import { describe, expect, it } from 'vitest';
import { DynamicResolution } from '../src/render/post/dynres';

const VSYNC = 1000 / 60;

/** Interval at which a frame costing `costMs` is presented on a vsync'd display. */
const present = (costMs: number): number => Math.max(1, Math.ceil(costMs / VSYNC - 1e-9)) * VSYNC;

interface Trace {
  t: number[];
  scale: number[];
  changes: number;
}

/**
 * Run the controller for `seconds`. `interval(t, scale)` returns the next frame interval in ms given the
 * sim time and the scale the frame was rendered at.
 */
function run(dyn: DynamicResolution, seconds: number, interval: (t: number, scale: number) => number, trace?: Trace): Trace {
  const out = trace ?? { t: [], scale: [], changes: 0 };
  let t = out.t.length ? out.t[out.t.length - 1] : 0;
  const end = t + seconds;
  let prev = dyn.scale;
  while (t < end) {
    const ms = interval(t, dyn.scale);
    t += ms / 1000;
    const s = dyn.update(ms);
    if (s !== prev) out.changes++;
    prev = s;
    out.t.push(t);
    out.scale.push(s);
  }
  return out;
}

/** Scale changes between sim times a and b. */
function changesBetween(tr: Trace, a: number, b: number): number {
  let n = 0;
  for (let i = 1; i < tr.t.length; i++) if (tr.t[i] >= a && tr.t[i] < b && tr.scale[i] !== tr.scale[i - 1]) n++;
  return n;
}

/** Fraction of the frames between a and b for which `pred(scale)` holds. */
function fraction(tr: Trace, a: number, b: number, pred: (s: number) => boolean): number {
  let n = 0;
  let k = 0;
  for (let i = 0; i < tr.t.length; i++) {
    if (tr.t[i] < a || tr.t[i] >= b) continue;
    n++;
    if (pred(tr.scale[i])) k++;
  }
  return n ? k / n : 0;
}

function expectValidScales(tr: Trace, min = 0.6, max = 1, step = 0.05): void {
  for (const s of tr.scale) {
    expect(s).toBeGreaterThanOrEqual(min - 1e-9);
    expect(s).toBeLessThanOrEqual(max + 1e-9);
    expect(Math.abs(s / step - Math.round(s / step))).toBeLessThan(1e-6); // quantised: few reallocations
  }
}

/** Deterministic pseudo-random jitter in -1..1. */
function jitter(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

describe('DynamicResolution', () => {
  it('holds full resolution while the frame rate is on target', () => {
    const dyn = new DynamicResolution({ targetFps: 60 });
    const tr = run(dyn, 30, () => VSYNC);
    expect(tr.changes).toBe(0);
    expect(dyn.scale).toBe(1);
    expect(dyn.frameMs).toBeCloseTo(VSYNC, 3);
  });

  it('ignores frame-to-frame jitter and isolated dropped frames', () => {
    const dyn = new DynamicResolution({ targetFps: 60 });
    let i = 0;
    // alternating early/late presents, then noisy timer, then one dropped frame every second
    const a = run(dyn, 20, () => (i++ % 2 ? VSYNC + 3 : VSYNC - 3));
    const b = run(dyn, 20, () => VSYNC + 2.5 * jitter(i++), a);
    const c = run(dyn, 20, () => (i++ % 60 === 0 ? 2 * VSYNC : VSYNC), b);
    expect(c.changes).toBe(0);
    expect(dyn.scale).toBe(1);
  });

  it('ignores hitches (tab switch, shader compile, GC pause)', () => {
    const dyn = new DynamicResolution({ targetFps: 60 });
    let i = 0;
    const tr = run(dyn, 30, () => (i++ % 90 === 45 ? 400 : VSYNC));
    expect(tr.changes).toBe(0);
    expect(dyn.update(0)).toBe(1);
    expect(dyn.update(Number.NaN)).toBe(1);
    expect(dyn.update(-5)).toBe(1);
    expect(dyn.frameMs).toBeLessThan(VSYNC * 1.05);
  });

  it('steps down promptly under sustained overload and never below the minimum', () => {
    const dyn = new DynamicResolution({ targetFps: 60, minScale: 0.6 });
    // GPU-bound: fragment cost goes with pixel count. Full resolution costs 45 ms; 0.6 fits in one refresh.
    const cost = (s: number): number => 2 + 40 * s * s;
    const tr = run(dyn, 12, (_t, s) => present(cost(s)));
    expectValidScales(tr);
    const firstDrop = tr.t[tr.scale.findIndex((s) => s < 1)];
    expect(firstDrop).toBeGreaterThan(0.3); // not on a single bad frame
    expect(firstDrop).toBeLessThan(1.5);
    expect(tr.t[tr.scale.findIndex((s) => s <= 0.6 + 1e-9)]).toBeLessThan(6);
    // 0.6 is the only scale that fits: it stays there apart from brief, backed-off trials of 0.65
    expect(fraction(tr, 6, 12, (s) => s <= 0.6 + 1e-9)).toBeGreaterThan(0.85);
  });

  it('settles just under a GPU-bound limit and backs off probing instead of oscillating', () => {
    const dyn = new DynamicResolution({ targetFps: 60 });
    // Sustainable up to s = sqrt((16.67 - 4) / 20) = 0.796 -> 0.75 on the 0.05 grid.
    const cost = (s: number): number => 4 + 20 * s * s;
    const tr = run(dyn, 240, (_t, s) => present(cost(s)));
    expectValidScales(tr);
    // After convergence the controller sits at 0.75 and only rarely probes 0.8.
    expect(fraction(tr, 60, 240, (s) => Math.abs(s - 0.75) < 1e-6)).toBeGreaterThan(0.9);
    expect(fraction(tr, 60, 240, (s) => s > 0.75 + 1e-6)).toBeLessThan(0.08); // time spent dropping frames
    expect(fraction(tr, 60, 240, (s) => s < 0.75 - 1e-6)).toBeLessThan(0.05); // never sags below the limit for long
    // Hysteresis: each failed probe is two changes (up, down); the back-off stretches them apart.
    expect(changesBetween(tr, 60, 240)).toBeLessThanOrEqual(14);
    expect(changesBetween(tr, 150, 240)).toBeLessThanOrEqual(6);
  });

  it('does not thrash when frame times oscillate around the budget', () => {
    // A scene whose GPU cost swings +-30 % every 6 s (ship rotating past a planet), on the edge of the budget.
    const dyn = new DynamicResolution({ targetFps: 60 });
    const cost = (t: number, s: number): number => 3 + (15 + 4.5 * Math.sin((2 * Math.PI * t) / 6)) * s * s;
    const tr = run(dyn, 180, (t, s) => present(cost(t, s)));
    expectValidScales(tr);
    // Worst case fits at s = sqrt(13.67 / 19.5) = 0.837 -> 0.8; best case fits at 1.0.
    // Stays in the plausible band and does not ride the oscillation up and down every period.
    expect(fraction(tr, 30, 180, (s) => s >= 0.75 - 1e-6)).toBeGreaterThan(0.97);
    const perPeriod = changesBetween(tr, 30, 180) / (150 / 6);
    expect(perPeriod).toBeLessThanOrEqual(2.5);
    expect(changesBetween(tr, 120, 180)).toBeLessThanOrEqual(12);
    // ...and most frames still make their deadline.
    let late = 0;
    let n = 0;
    for (let i = 0; i < tr.t.length; i++) {
      if (tr.t[i] < 30) continue;
      n++;
      if (present(cost(tr.t[i], tr.scale[i])) > VSYNC + 1e-6) late++;
    }
    expect(late / n).toBeLessThan(0.15);
  });

  it('rides out a fast square-wave of good and bad frames without flapping', () => {
    // 0.25 s good / 0.25 s bad regardless of resolution (CPU spikes): resolution is not the problem.
    const dyn = new DynamicResolution({ targetFps: 60 });
    const tr = run(dyn, 120, (t) => (Math.floor(t * 4) % 2 ? 2 * VSYNC : VSYNC));
    expectValidScales(tr);
    // It may give resolution a try, but must not keep toggling: bounded changes, none late in the run…
    expect(tr.changes).toBeLessThanOrEqual(24);
    expect(changesBetween(tr, 90, 120)).toBeLessThanOrEqual(2);
    // …and since lower resolution does not help, it ends up back at full resolution.
    expect(fraction(tr, 90, 120, (s) => s >= 1 - 1e-6)).toBeGreaterThan(0.9);
  });

  it('adopts an external frame-rate cap (Low Power Mode, 30 Hz) and returns to full resolution', () => {
    const dyn = new DynamicResolution({ targetFps: 60 });
    const tr = run(dyn, 90, () => 2 * VSYNC);
    expectValidScales(tr);
    expect(Math.min(...tr.scale)).toBeCloseTo(0.6, 6); // it has to find out first
    expect(dyn.scale).toBe(1);
    expect(dyn.targetFrameMs).toBeGreaterThan(33);
    expect(dyn.targetFrameMs).toBeLessThan(40); // a drop to 20 Hz would still register as overload
    expect(changesBetween(tr, 60, 90)).toBe(0);
    // The cap lifts: the controller re-aims at 60 Hz and stays at full resolution.
    const after = run(dyn, 20, () => VSYNC, tr);
    expect(dyn.targetFrameMs).toBeCloseTo(VSYNC, 1);
    expect(dyn.scale).toBe(1);
    expect(changesBetween(after, 90, 110)).toBe(0);
  });

  it('climbs back quickly once a heavy scene is left behind', () => {
    const dyn = new DynamicResolution({ targetFps: 60 });
    const heavy = (s: number): number => 4 + 20 * s * s;
    const tr = run(dyn, 120, (_t, s) => present(heavy(s))); // long enough for the probe back-off to max out
    expect(dyn.scale).toBeLessThanOrEqual(0.8);
    run(dyn, 60, () => VSYNC, tr);
    expect(dyn.scale).toBe(1);
    const backAt = tr.t[tr.scale.findIndex((s, i) => tr.t[i] > 120 && s >= 1 - 1e-6)];
    expect(backAt - 120).toBeLessThan(55);
  });

  it('respects a custom range, target and a disabled state', () => {
    const dyn = new DynamicResolution({ targetFps: 30, minScale: 0.7, maxScale: 0.9, step: 0.1 });
    expect(dyn.scale).toBeCloseTo(0.9, 6);
    const tr = run(dyn, 20, () => 80);
    expectValidScales(tr, 0.7, 0.9, 0.1);
    expect(Math.min(...tr.scale)).toBeCloseTo(0.7, 6);

    const off = new DynamicResolution({ targetFps: 60 });
    off.enabled = false;
    const tr2 = run(off, 10, () => 50);
    expect(tr2.changes).toBe(0);
    expect(off.scale).toBe(1);
    expect(off.frameMs).toBeGreaterThan(40); // still measures
    off.reset(0.83);
    expect(off.scale).toBeCloseTo(0.85, 6);
  });
});
