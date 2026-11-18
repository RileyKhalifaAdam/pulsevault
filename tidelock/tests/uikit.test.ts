// UI kit: the parts that run without a DOM (reactivity, helpers, icon set integrity).
// Layout and behaviour are covered in a real browser by tests/uikit.e2e.cjs.

import { describe, expect, it } from 'vitest';
import { clamp, cx, derived, disposer, easeInOut, easeOut, lerp, signal, uid } from '../src/ui/kit/kit';
import { ICON_GROUPS, ICON_NAMES, iconMarkup, type IconName } from '../src/ui/kit/icons';
import { TONES, rgbToCss } from '../src/ui/kit/components';
import { toneColor } from '../src/ui/kit/charts';

describe('signals', () => {
  it('notifies subscribers with the new and previous value, and skips identical writes', () => {
    const s = signal(1);
    const seen: [number, number][] = [];
    const off = s.sub((v, prev) => seen.push([v, prev]));
    s.set(2);
    s.set(2);
    s.update((v) => v + 3);
    off();
    s.set(9);
    expect(seen).toEqual([[2, 1], [5, 2]]);
    expect(s.get()).toBe(9);
  });

  it('sub(fn, true) fires immediately', () => {
    const s = signal('a');
    let got = '';
    s.sub((v) => (got = v), true);
    expect(got).toBe('a');
  });

  it('derived recomputes from its dependencies until disposed', () => {
    const price = signal(100);
    const qty = signal(3);
    const total = derived([price, qty], () => price.get() * qty.get());
    const seen: number[] = [];
    total.sub((v) => seen.push(v));
    qty.set(4);
    price.set(50);
    expect(total.get()).toBe(200);
    expect(seen).toEqual([400, 200]);
    total.dispose();
    qty.set(10);
    expect(total.get()).toBe(200);
  });
});

describe('helpers', () => {
  it('cx joins truthy class names', () => {
    expect(cx('a', false, null, undefined, 'b', '' as string, 'c')).toBe('a b c');
  });

  it('clamp, lerp and easings behave at the ends', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(lerp(10, 20, 0.25)).toBe(12.5);
    for (const ease of [easeOut, easeInOut]) {
      expect(ease(0)).toBe(0);
      expect(ease(1)).toBe(1);
      expect(ease(0.5)).toBeGreaterThan(0);
      expect(ease(0.5)).toBeLessThan(1);
    }
  });

  it('disposer runs callbacks once, in reverse order', () => {
    const order: number[] = [];
    const d = disposer();
    d.add(() => order.push(1));
    d.add(null);
    d.add(() => order.push(2));
    d.run();
    d.run();
    expect(order).toEqual([2, 1]);
  });

  it('uid values are unique', () => {
    expect(new Set([uid(), uid(), uid('x')]).size).toBe(3);
  });

  it('rgbToCss converts linear RGB to sRGB', () => {
    expect(rgbToCss([0, 0, 0])).toBe('rgb(0, 0, 0)');
    expect(rgbToCss([1, 1, 1])).toBe('rgb(255, 255, 255)');
    expect(rgbToCss([0.2159, 0.2159, 0.2159])).toBe('rgb(128, 128, 128)');
    expect(rgbToCss([2, -1, 0.5])).toBe('rgb(255, 0, 188)');
  });

  it('toneColor resolves tones and passes CSS colours through', () => {
    expect(toneColor('ember')).toBe('#ffb454');
    expect(toneColor('#7fb2ff')).toBe('#7fb2ff');
    expect(toneColor(undefined, 'green')).toBe('#63e6a1');
    for (const t of TONES) expect(toneColor(t)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('icon set', () => {
  it('has the documented breadth and every icon is in exactly one group', () => {
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(70);
    const grouped = ICON_GROUPS.flatMap((g) => g.names);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...ICON_NAMES].sort());
  });

  it('covers every contract category the interface needs a glyph for', () => {
    const needed: IconName[] = [
      // StationService
      'market', 'missions', 'outfitting', 'shipyard', 'refuel', 'repair', 'survey', 'legal', 'blackmarket',
      // CommodityCategory
      'food', 'minerals', 'metals', 'chemicals', 'machinery', 'technology', 'medicine', 'consumer', 'energy', 'weapons', 'salvage', 'contraband',
      // powers and the game mark
      'powerAssembly', 'powerHegemony', 'powerLeague', 'logo',
    ];
    for (const name of needed) expect(ICON_NAMES).toContain(name);
  });

  it('emits well-formed path data that stays on the 24 px grid', () => {
    for (const name of ICON_NAMES) {
      const m = iconMarkup(name);
      expect(m.startsWith('<svg')).toBe(true);
      const paths = [...m.matchAll(/ d="([^"]+)"/g)].map((x) => x[1]);
      expect(paths.length).toBeGreaterThan(0);
      for (const d of paths) {
        expect(d, name).toMatch(/^[MmLlHhVvCcSsQqAaZz0-9 .,-]+$/);
        expect(d[0], name).toBe('M');
        // Absolute move-to coordinates are the anchors of each sub-path: all must be on the canvas.
        for (const [, x, y] of d.matchAll(/M(-?[\d.]+)[ ,](-?[\d.]+)/g)) {
          expect(Number(x), `${name} x`).toBeGreaterThanOrEqual(0);
          expect(Number(x), `${name} x`).toBeLessThanOrEqual(24);
          expect(Number(y), `${name} y`).toBeGreaterThanOrEqual(0);
          expect(Number(y), `${name} y`).toBeLessThanOrEqual(24);
        }
      }
    }
  });
});
