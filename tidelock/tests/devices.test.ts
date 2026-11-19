// Physical controls as mechanisms (src/world/devices.ts): they move with their own dynamics, never by being set.
import { describe, expect, it } from 'vitest';
import {
  createDevice, devGrab, devMove, devRelease, devTap, leverValue, rockerValue, stepDevice, stickAxis, LEVER_DETENT, LEVER_RATE, STICK_DEADBAND,
  type DeviceState,
} from '../src/world';

const run = (d: DeviceState, seconds: number, hz = 60, each?: (d: DeviceState, t: number) => void): void => {
  const n = Math.round(seconds * hz);
  for (let i = 0; i < n; i++) { stepDevice(d, 1 / hz); each?.(d, (i + 1) / hz); }
};

describe('physical controls', () => {
  it('a stick follows the hand with limited force and, released, returns to centre in ~0.15 s without overshoot', () => {
    for (const hz of [60, 30, 120]) {
      const d = createDevice('rhc', 'stick2');
      devGrab(d);
      devMove(d, 1, -0.7);
      stepDevice(d, 1 / 240);
      expect(d.x).toBeGreaterThan(0); // it has inertia: one short step does not put it at the target
      expect(d.x).toBeLessThan(0.5);
      run(d, 0.25, hz, (s) => { expect(s.x).toBeLessThanOrEqual(1); expect(s.y).toBeGreaterThanOrEqual(-0.7005); });
      expect(d.x).toBeCloseTo(1, 2);
      expect(d.y).toBeCloseTo(-0.7, 2);
      expect(stickAxis(d.x)).toBeCloseTo(1, 2);
      devRelease(d);
      let minX = 1, maxY = -1, tCentre = Infinity;
      run(d, 0.5, hz, (s, t) => {
        minX = Math.min(minX, s.x);
        maxY = Math.max(maxY, s.y);
        if (tCentre === Infinity && Math.abs(s.x) < 0.02 && Math.abs(s.y) < 0.02) tCentre = t;
      });
      expect(minX).toBeGreaterThanOrEqual(0); // never crosses centre
      expect(maxY).toBeLessThanOrEqual(0);
      expect(tCentre).toBeLessThan(0.2);
      expect(tCentre).toBeGreaterThan(0.05);
      expect(d.x).toBe(0);
      expect(d.y).toBe(0);
      expect(d.vx).toBe(0);
    }
    expect(stickAxis(STICK_DEADBAND * 0.9)).toBe(0);
    expect(stickAxis(-1)).toBe(-1);
    expect(stickAxis(0.5)).toBeGreaterThan(0.4);
  });

  it('a lever moves at a limited rate, stays where it is left, and drops into the detent at zero', () => {
    const d = createDevice('throttle', 'lever');
    devGrab(d);
    devMove(d, 0.7, 0);
    run(d, 0.1);
    expect(d.x).toBeCloseTo(LEVER_RATE * 0.1, 6);
    run(d, 1);
    expect(d.x).toBeCloseTo(0.7, 9);
    devRelease(d);
    const x = d.x;
    run(d, 30);
    stepDevice(d, 5000); // a night's sleep later
    expect(d.x).toBe(x);
    expect(leverValue(d)).toBeCloseTo((0.7 - LEVER_DETENT) / (1 - LEVER_DETENT), 9);
    // untouched moves are ignored
    devMove(d, 0, 0);
    run(d, 0.5);
    expect(d.x).toBe(x);
    // pulled back to just above zero and let go: the detent takes it
    devGrab(d);
    devMove(d, LEVER_DETENT * 0.6, 0);
    run(d, 1);
    devRelease(d);
    run(d, 0.2);
    expect(d.x).toBe(0);
    expect(leverValue(d)).toBe(0);
  });

  it('a tap registers exactly once on a button at any frame rate; a toggle flips and stays; a rocker is momentary', () => {
    for (const hz of [240, 60, 30, 10, 1]) {
      const b = createDevice('hold-pro', 'button');
      expect(devTap(b)).toBe(true);
      let made = false;
      run(b, 1, hz, (s) => { made = made || s.made; });
      if (hz >= 30) expect(made).toBe(true);
      expect(b.count).toBe(1);
      expect(b.made).toBe(false);
      expect(b.x).toBe(0);
      devTap(b);
      run(b, 1, hz);
      expect(b.count).toBe(2);
    }
    // held: pressed for as long as the finger is on it
    const h = createDevice('undock', 'handle');
    devGrab(h);
    run(h, 2);
    expect(h.made).toBe(true);
    expect(h.count).toBe(1);
    devRelease(h);
    run(h, 0.3);
    expect(h.made).toBe(false);

    const t = createDevice('drive-arm', 'toggle');
    expect(t.made).toBe(false);
    devTap(t);
    stepDevice(t, 1 / 60);
    expect(t.made).toBe(false); // the lever takes time to travel
    run(t, 0.2);
    expect(t.made).toBe(true);
    run(t, 60);
    expect(t.made).toBe(true);
    expect(t.x).toBe(1);
    devTap(t);
    run(t, 0.2);
    expect(t.made).toBe(false);
    expect(createDevice('lights', 'toggle', true).made).toBe(true);

    const r = createDevice('roll', 'rocker');
    devGrab(r);
    devMove(r, 0, -1);
    run(r, 0.1);
    expect(rockerValue(r)).toBe(-1);
    devRelease(r);
    run(r, 0.3);
    expect(rockerValue(r)).toBe(0);
    expect(r.x).toBe(0);
    // a touch shorter than a frame still gives a pulse
    devGrab(r);
    devMove(r, 0, 1);
    stepDevice(r, 1 / 60);
    devRelease(r);
    let pulse = 0;
    run(r, 0.5, 60, (s) => { pulse += rockerValue(s) / 60; });
    expect(pulse).toBeGreaterThan(0.08);
    expect(pulse).toBeLessThan(0.25);
    expect(devTap(r)).toBe(false);
  });

  it('state is plain JSON: a round trip in mid-motion continues identically', () => {
    const make = (): DeviceState[] => {
      const s = createDevice('rhc', 'stick2'), l = createDevice('throttle', 'lever'), b = createDevice('b', 'button'), t = createDevice('t', 'toggle');
      devGrab(s); devMove(s, -0.8, 0.4);
      devGrab(l); devMove(l, 1, 0);
      devTap(b); devTap(t);
      return [s, l, b, t];
    };
    const a = make();
    for (const d of a) run(d, 0.05);
    devRelease(a[0]);
    for (const d of a) stepDevice(d, 1 / 60);
    const b = JSON.parse(JSON.stringify(a)) as DeviceState[];
    expect(b).toEqual(a);
    for (const d of a) run(d, 1);
    for (const d of b) run(d, 1);
    expect(b).toEqual(a);
    expect(a[0].x).toBe(0);
    expect(a[1].x).toBe(1);
    expect(a[3].made).toBe(true);
  });
});
