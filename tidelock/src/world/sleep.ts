// W2-E item 7 — natural sleep: the Borbély two-process model (homeostatic S, circadian C), docs/SIMULATION.md §2
// W2-E item 7 (`body-sleep-metabolism`, the wake part) under owner decision D7, DEFAULT (c): wake-on-touch and
// cautions stay the only ways a sleep ends; S and C are computed and exposed for the SYS page only. The natural wake
// rule is built and tested but GATED (NATURAL_WAKE_DEFAULT = false): with awake time at 1×, S barely rises in a play
// session and the rule would end almost every sleep within minutes (the review hazard; test "D7 hazard").
//
// Model (Daan, Beersma & Borbély 1984, the published constants the plan names):
//   awake:  dS/dt = (1 − S)/τ_r, τ_r = 18.2 h  →  S(t) = 1 − (1 − S₀)·e^{−t/τ_r}
//   asleep: dS/dt = −S/τ_d,      τ_d = 4.2 h   →  S(t) = S₀·e^{−t/τ_d}
//   C(t) = 0.12·sin(2πt/24 h + φ) on the ship clock (sim seconds since the epoch, 00:00 ship time).
//   wake when S − C < 0.17.
// φ = asin((S_w − 0.17)/0.12) − π/2 = −1.96557 rad puts the steady 17 h / 7 h cycle (asleep 23:00, S_s = 0.6557;
// awake 06:00, S_w = 0.1238, the fixed point of the two exponentials) on its crossing; C has its minimum at 01:30 ship
// time and rises through the morning. Closed forms from an anchor (S₀ at tick₀), so the value at a tick does not
// depend on how often it is evaluated: exact at any warp step, save → load bit-identical, zero cost when unread.
//
// WIRING (wave 2):
// - session.ts sleep entry (today's rule, unchanged — D7): fallAsleep(sleep, tick). Every sleep end (touch, caution,
//   W2-D's caution wake): wakeUp(sleep, tick). Nothing per tick.
// - SystemsView (W2-D's SYS page): sleepView(sleep, world.tick, NATURAL_WAKE, out) once per frame or slower → S, C,
//   S − C, the predicted natural wake time (shown only; it ends nothing while the gate is off).
// - Only when the owner answers D7 with (a) or (b): set NATURAL_WAKE = true in the session; W1-A's tick loop then
//   caps the quantum with nextNaturalWake(sleep, tick, maxTicks) (limitedBy: none needed — the warp is not slowed,
//   the sleep ends at that exact tick), and wakeDue(sleep, tick, true) ends the sleep.
// - Save: saveSleepState / loadSleepState (+0.05 kB). Loader default: awake with the post-night S_w at tick 0.
// - §1.4: reads world.tick only; writes its own saved `sleep` record (session/crew state; no craft field).

// transcendental wrappers (§1.1 rule 6)
const mexp = (x: number): number => Math.exp(x);
const msin = (x: number): number => Math.sin(x);

export const TICK_HZ = 120;
export const HOUR = 3600;
export const DAY = 86400;
/** Homeostatic rise (awake) and decay (asleep) time constants, s (Daan, Beersma & Borbély 1984). */
export const TAU_RISE = 18.2 * HOUR;
export const TAU_DECAY = 4.2 * HOUR;
/** Circadian amplitude, period (s) and phase (rad, ship clock; derived above, checked by tests/sleep.test.ts). */
export const C_AMP = 0.12;
export const C_PERIOD = DAY;
export const C_PHASE = -1.9655677059259911;
/** Wake when S − C falls below this. */
export const WAKE_GAP = 0.17;
/** S at the end of a steady night (the 17 h / 7 h fixed point), and at the start of it. */
export const S_WAKE_STEADY = 0.12384834050275276;
export const S_SLEEP_STEADY = 0.6557138065590487;
/** D7 default (c): the natural wake rule is off. */
export const NATURAL_WAKE_DEFAULT = false;
export const NEVER_TICK = 2 ** 52;

/** Anchor of the current wake or sleep episode: S at tick0, and which law runs since. Plain JSON, saved. */
export interface SleepState {
  asleep: boolean;
  s0: number;
  tick0: number;
}

export const createSleepState = (tick = 0, s0 = S_WAKE_STEADY): SleepState => ({ asleep: false, s0, tick0: tick });

const E_RISE = 1 / (TAU_RISE * TICK_HZ);
const E_DECAY = 1 / (TAU_DECAY * TICK_HZ);

/** Homeostatic pressure S at `tick` (closed form from the anchor; ticks before the anchor give S₀). */
export function sleepS(st: SleepState, tick: number): number {
  const dt = tick > st.tick0 ? tick - st.tick0 : 0;
  return st.asleep ? st.s0 * mexp(-dt * E_DECAY) : 1 - (1 - st.s0) * mexp(-dt * E_RISE);
}

/** Circadian process C at `tick` (ship clock = sim time since the epoch at 00:00). */
export function circadianC(tick: number): number {
  // phase from the tick modulo one day: exact integer arithmetic, then one sin (no growth of the argument)
  const d = DAY * TICK_HZ, k = tick - Math.floor(tick / d) * d;
  return C_AMP * msin((2 * Math.PI * k) / d + C_PHASE);
}

/** Re-anchor at `tick` (continuous S) and switch law. */
export function fallAsleep(st: SleepState, tick: number): void {
  if (st.asleep) return;
  st.s0 = sleepS(st, tick); st.tick0 = tick; st.asleep = true;
}
export function wakeUp(st: SleepState, tick: number): void {
  if (!st.asleep) return;
  st.s0 = sleepS(st, tick); st.tick0 = tick; st.asleep = false;
}

/** S − C − WAKE_GAP (< 0 = the two-process model says wake). */
export const wakeMargin = (st: SleepState, tick: number): number => sleepS(st, tick) - circadianC(tick) - WAKE_GAP;

/** True when the natural wake rule (gated, D7) ends this sleep at `tick`. */
export const wakeDue = (st: SleepState, tick: number, natural: boolean): boolean => natural && st.asleep && wakeMargin(st, tick) < 0;

/** Coarse scan step for the wake search, ticks (10 min: S − C changes on hour scales, one root per step at most). */
const SCAN = 600 * TICK_HZ;

/**
 * The first tick in [tick, tick + maxTicks] at which the natural wake rule fires (NEVER_TICK if none, or awake).
 * Deterministic: a 10-min scan, then integer bisection (≤ 17 halvings). Off the per-tick path (once per quantum,
 * only when NATURAL_WAKE is on; ≈ 1 µs per scanned hour in node).
 */
export function nextNaturalWake(st: SleepState, tick: number, maxTicks: number): number {
  if (!st.asleep) return NEVER_TICK;
  if (wakeMargin(st, tick) < 0) return tick;
  const end = tick + (maxTicks > 0 ? maxTicks : 0);
  let lo = tick;
  while (lo < end) {
    const hi = lo + SCAN < end ? lo + SCAN : end;
    if (wakeMargin(st, hi) < 0) {
      let a = lo, b = hi; // margin(a) ≥ 0, margin(b) < 0
      while (b - a > 1) { const m = a + Math.floor((b - a) / 2); if (wakeMargin(st, m) < 0) b = m; else a = m; }
      return b;
    }
    lo = hi;
  }
  return NEVER_TICK;
}

/** What the SYS page shows. */
export interface SleepView {
  S: number;
  C: number;
  /** S − C (wake below WAKE_GAP). */
  gap: number;
  asleep: boolean;
  /** Whether the natural rule is live (D7), and the tick it would end this sleep (NEVER_TICK awake / none in 24 h). */
  natural: boolean;
  wakeTick: number;
}

export const createSleepView = (): SleepView => ({ S: 0, C: 0, gap: 0, asleep: false, natural: false, wakeTick: NEVER_TICK });

/** Fill the SYS-page view. The wake prediction is computed only while asleep (and costs one search). */
export function sleepView(st: SleepState, tick: number, natural: boolean, out: SleepView, predict = true): SleepView {
  out.S = sleepS(st, tick); out.C = circadianC(tick); out.gap = out.S - out.C;
  out.asleep = st.asleep; out.natural = natural;
  out.wakeTick = predict && st.asleep ? nextNaturalWake(st, tick, DAY * TICK_HZ) : NEVER_TICK;
  return out;
}

// ------------------------------------------------------------------------------------------------ save / load

export const saveSleepState = (st: SleepState): SleepState => ({ asleep: st.asleep, s0: st.s0, tick0: st.tick0 });

export function loadSleepState(data: unknown, tick = 0): SleepState {
  const o = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const s0 = typeof o.s0 === 'number' && Number.isFinite(o.s0) && o.s0 >= 0 && o.s0 <= 1 ? o.s0 : S_WAKE_STEADY;
  const t0 = typeof o.tick0 === 'number' && Number.isInteger(o.tick0) && o.tick0 >= 0 ? o.tick0 : tick;
  return { asleep: o.asleep === true, s0, tick0: t0 };
}
