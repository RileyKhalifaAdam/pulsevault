// W2-E natural sleep (src/world/sleep.ts): the Borbély two-process model's published constants, the steady 17 h / 7 h
// cycle, the D7 hazard (as a test so the answer is visible), the gate, anchoring and save → load.
import { describe, expect, it } from 'vitest';
import {
  C_AMP, circadianC, createSleepState, createSleepView, DAY, fallAsleep, HOUR, loadSleepState, NATURAL_WAKE_DEFAULT, NEVER_TICK, nextNaturalWake, S_SLEEP_STEADY,
  S_WAKE_STEADY, saveSleepState, sleepS, sleepView, TAU_DECAY, TAU_RISE, TICK_HZ, wakeDue, wakeMargin, wakeUp, WAKE_GAP,
} from '../src/world/sleep';

const T = (s: number): number => Math.round(s * TICK_HZ);

describe('two-process model constants (Daan, Beersma & Borbély 1984)', () => {
  it('S rises with τ_r = 18.2 h awake and decays with τ_d = 4.2 h asleep (closed form vs RK4 of the ODEs)', () => {
    expect(TAU_RISE).toBe(18.2 * HOUR);
    expect(TAU_DECAY).toBe(4.2 * HOUR);
    const st = createSleepState(0, 0);
    expect(sleepS(st, T(TAU_RISE))).toBeCloseTo(1 - Math.exp(-1), 14);
    // RK4 of dS/dt = (1 − S)/τ_r over 10 h from 0.3
    let S = 0.3;
    const h = 60, f = (s: number): number => (1 - s) / TAU_RISE;
    for (let t = 0; t < 10 * HOUR; t += h) { const k1 = f(S), k2 = f(S + 0.5 * h * k1), k3 = f(S + 0.5 * h * k2), k4 = f(S + h * k3); S += (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4); }
    expect(sleepS(createSleepState(0, 0.3), T(10 * HOUR))).toBeCloseTo(S, 12);
    const sl = createSleepState(0, 0.8);
    fallAsleep(sl, 0);
    expect(sleepS(sl, T(TAU_DECAY))).toBeCloseTo(0.8 / Math.E, 14);
    expect(sleepS(sl, T(TAU_DECAY * Math.LN2))).toBeCloseTo(0.4, 6);
  });

  it('C is 0.12·sin with a 24 h period on the ship clock, lowest at 01:30 and rising through the morning', () => {
    let mx = -1, mn = 1, tMin = 0;
    for (let k = 0; k < 24 * 60; k++) { const c = circadianC(T(k * 60)); if (c > mx) mx = c; if (c < mn) { mn = c; tMin = k; } }
    expect(mx).toBeCloseTo(C_AMP, 5);
    expect(mn).toBeCloseTo(-C_AMP, 5);
    expect(tMin / 60).toBeCloseTo(1.5, 1);
    expect(circadianC(T(7 * HOUR + 5 * DAY))).toBeCloseTo(circadianC(T(7 * HOUR)), 12);
    expect(circadianC(T(6 * HOUR + 60))).toBeGreaterThan(circadianC(T(6 * HOUR)));
  });
});

describe('the steady cycle and the D7 hazard', () => {
  it('after a full 17 h waking day, the model wakes the sleeper about 7 h later (S: 0.124 → 0.656 → 0.124)', () => {
    // wake at 06:00 with the steady S, awake 17 h, asleep at 23:00
    const st = createSleepState(T(6 * HOUR), S_WAKE_STEADY);
    const tSleep = T(23 * HOUR);
    expect(sleepS(st, tSleep)).toBeCloseTo(S_SLEEP_STEADY, 12);
    fallAsleep(st, tSleep);
    const w = nextNaturalWake(st, tSleep, T(DAY));
    const hours = (w - tSleep) / TICK_HZ / HOUR;
    console.log(`[sleep] steady night: wakes after ${hours.toFixed(3)} h; S at wake ${sleepS(st, w).toFixed(4)}`);
    expect(hours).toBeGreaterThan(6.9);
    expect(hours).toBeLessThan(7.1);
    expect(sleepS(st, w)).toBeCloseTo(S_WAKE_STEADY, 3);
    // the found tick is the first one: one tick earlier the margin is still ≥ 0
    expect(wakeMargin(st, w)).toBeLessThan(0);
    expect(wakeMargin(st, w - 1)).toBeGreaterThanOrEqual(0);
  });

  it('D7 hazard: after only 1 h awake (S ≈ 0.17) the model ends a sleep in under 1 h — so the rule stays gated off', () => {
    const st = createSleepState(T(6 * HOUR), S_WAKE_STEADY);
    const t1 = T(7 * HOUR);
    expect(sleepS(st, t1)).toBeCloseTo(0.1707, 3);
    fallAsleep(st, t1);
    const w = nextNaturalWake(st, t1, T(DAY));
    const minutes = (w - t1) / TICK_HZ / 60;
    console.log(`[sleep] D7 hazard: after 1 h awake the model wakes after ${minutes.toFixed(1)} min`);
    expect(minutes).toBeLessThan(60);
    // the default (D7 (c)): the rule never ends a sleep; touch and cautions do (session)
    expect(NATURAL_WAKE_DEFAULT).toBe(false);
    for (let k = 0; k <= 24; k++) expect(wakeDue(st, t1 + T(k * HOUR), NATURAL_WAKE_DEFAULT)).toBe(false);
    expect(wakeDue(st, w, true)).toBe(true);
  });

  it('awake there is no wake prediction; the SYS view reports S, C and S − C', () => {
    const st = createSleepState(T(9 * HOUR), 0.3);
    expect(nextNaturalWake(st, T(10 * HOUR), T(DAY))).toBe(NEVER_TICK);
    const v = sleepView(st, T(10 * HOUR), false, createSleepView());
    expect(v.gap).toBeCloseTo(v.S - v.C, 15);
    expect(v.wakeTick).toBe(NEVER_TICK);
    expect(WAKE_GAP).toBe(0.17);
  });
});

describe('anchoring, determinism, save / load', () => {
  it('S at a tick does not depend on how often it was evaluated, nor on wake/sleep re-anchors that change nothing', () => {
    const a = createSleepState(0, 0.2), b = createSleepState(0, 0.2);
    for (let k = 0; k < 1000; k++) sleepS(b, k * 7919);
    expect(sleepS(a, T(12345))).toBe(sleepS(b, T(12345)));
    fallAsleep(a, T(3600)); fallAsleep(b, T(3600)); fallAsleep(b, T(4000)); // a second fallAsleep is a no-op
    expect(sleepS(a, T(9000))).toBe(sleepS(b, T(9000)));
    wakeUp(a, T(9000));
    expect(sleepS(a, T(9000))).toBeCloseTo(sleepS(b, T(9000)), 15); // continuous across the switch
  });

  it('save → load continues bit-identically; junk loads as the post-night default', () => {
    const st = createSleepState(T(100), 0.4);
    fallAsleep(st, T(5000));
    const ld = loadSleepState(JSON.parse(JSON.stringify(saveSleepState(st))));
    expect(sleepS(ld, T(20000))).toBe(sleepS(st, T(20000)));
    expect(nextNaturalWake(ld, T(20000), T(DAY))).toBe(nextNaturalWake(st, T(20000), T(DAY)));
    const d = loadSleepState({ s0: 7, tick0: -3 }, 42);
    expect(d).toEqual({ asleep: false, s0: S_WAKE_STEADY, tick0: 42 });
  });
});
