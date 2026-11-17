import { describe, expect, it } from 'vitest';
import { blackbodyLinearRGB } from '../src/render/space/sky';
import { starColorFromTemperature } from '../src/render/space/star';

describe('star colour from temperature', () => {
  it('is normalised linear RGB with the largest channel at 1', () => {
    for (const k of [1500, 2700, 3400, 5800, 9000, 12000, 30000]) {
      const c = starColorFromTemperature(k);
      expect(Math.max(c.r, c.g, c.b)).toBeCloseTo(1, 5);
      for (const v of [c.r, c.g, c.b]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('runs from ember red through white to blue-white', () => {
    const m = starColorFromTemperature(2700);
    expect(m.r).toBe(1);
    expect(m.g).toBeLessThan(0.6);
    expect(m.b).toBeLessThan(0.25);
    expect(m.g).toBeGreaterThan(m.b);

    const g = starColorFromTemperature(5800);
    expect(g.r).toBeGreaterThan(0.9);
    expect(g.b).toBeGreaterThan(0.6);

    const a = starColorFromTemperature(9000);
    expect(a.b).toBe(1);
    expect(a.r).toBeLessThan(a.b);
    expect(a.r).toBeGreaterThan(0.5);
  });

  it('gets monotonically bluer as the temperature rises', () => {
    const out: [number, number, number] = [0, 0, 0];
    let last = -1;
    for (let k = 2000; k <= 20000; k += 500) {
      blackbodyLinearRGB(k, out);
      const blueOverRed = out[2] / out[0];
      expect(blueOverRed).toBeGreaterThan(last);
      last = blueOverRed;
    }
  });
});
