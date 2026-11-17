// Dynamic resolution controller: picks the internal render scale (minScale..maxScale of the tier's pixel
// ratio) that holds the target frame rate. Pure logic — no three.js, no DOM — so it can be simulated.
//
// The only signal a browser gives us is the interval between animation frames, and that is clamped to
// the display refresh: a frame that takes 9 ms and one that takes 15 ms both arrive after 16.7 ms. So the
// controller cannot read head-room; it works like this instead:
//
//   * DOWN  — when the smoothed interval stays more than `OVER` above the target for `DOWN_DELAY`
//             seconds (frames are being dropped), step the scale down. On a vsync'd display a frame
//             that is 1 ms late and one that is 15 ms late look the same, so the overshoot is not
//             trusted: the first step is at most 10 %, consecutive ones 15 % and 20 %.
//   * UP    — when the interval has sat on the target for `upDelay` seconds, raise the scale one step
//             — on trial. If frames drop within `TRIAL` seconds, the raise failed: go straight back to
//             the scale that worked, remember the failed scale as a ceiling and double the delay (to at
//             most `MAX_UP_DELAY`) before testing that ceiling again. Climbing back *below* the ceiling
//             always uses the short delay. A raise that survives its trial clears the ceiling.
//             This, the dead band between OVER and UNDER and the settle time after every change are
//             the hysteresis that keeps the scale from oscillating.
//   * RATE CAP — if the interval is still over target at the minimum scale (Low Power Mode pins Safari
//             to 30 Hz; a CPU-bound frame does not get cheaper with fewer pixels), resolution is not the
//             bottleneck. The controller adopts the measured rate (a peak-hold of the smoothed interval,
//             so alternating good and bad stretches do not fool it) as its target and climbs back up by
//             raising on trial, instead of rendering a blurry image for nothing. When the cap lifts, the
//             peak-hold decays and the real target is restored.

export interface DynResOptions {
  targetFps?: number;
  minScale?: number;
  maxScale?: number;
  /** Quantisation of the scale; every change reallocates the scene target, so keep it coarse. */
  step?: number;
}

const OVER = 1.12;
const UNDER = 1.05;
const SETTLE = 0.6; // s without decisions after a step down (lets the smoothed interval catch up)
const SETTLE_UP = 0.25; // s after a raise: a failed trial should cost as few dropped frames as possible
const DOWN_DELAY = 0.4; // s over budget before stepping down
const TRIAL_DOWN_DELAY = 0.25; // … while a raise is on trial
const BASE_UP_DELAY = 2.5; // s on target before a raise
const MAX_UP_DELAY = 30;
const TRIAL = 8; // s a raise stays on trial
const CAP_DELAY = 3; // s over budget at the minimum scale before adopting the measured rate
const HITCH_MS = 250; // intervals longer than this are pauses (tab switch, GC, shader compile), not load
const PEAK_DECAY = 4; // ms per second: how fast the peak-hold of the smoothed interval lets go
const DROP_FLOOR = [0.9, 0.85, 0.8]; // largest step down for the 1st, 2nd, 3rd+ consecutive drop
const CAP_MARGIN = 1.08;
const CALM = 1.5; // s on target after which the next drop counts as a first one again

export class DynamicResolution {
  enabled = true;
  /** Current internal scale, minScale..maxScale. */
  scale: number;
  /** Smoothed frame interval, ms. */
  frameMs: number;

  private minScale: number;
  private maxScale: number;
  private step: number;
  private targetMs: number;
  /** Target actually being held (>= targetMs when the frame rate is capped from outside). */
  private heldMs: number;
  /** Peak-hold of frameMs: the worst recent smoothed interval. */
  private peakMs: number;
  private overTime = 0;
  private underTime = 0;
  private atMinOverTime = 0;
  private settle = 0;
  private upDelay = BASE_UP_DELAY;
  /** Scale in effect before the raise now on trial, or -1. */
  private trialFrom = -1;
  private sinceRaise = Infinity;
  /** Lowest scale that recently failed its trial. */
  private ceiling = Infinity;
  private dropStreak = 0;

  constructor(opts: DynResOptions = {}) {
    this.minScale = opts.minScale ?? 0.6;
    this.maxScale = opts.maxScale ?? 1.0;
    this.step = opts.step ?? 0.05;
    this.targetMs = 1000 / (opts.targetFps ?? 60);
    this.heldMs = this.targetMs;
    this.frameMs = this.targetMs;
    this.peakMs = this.targetMs;
    this.scale = this.maxScale;
  }

  setTargetFps(fps: number): void {
    this.targetMs = 1000 / Math.max(1, fps);
    this.heldMs = this.targetMs;
    this.atMinOverTime = 0;
  }

  get targetFrameMs(): number {
    return this.heldMs;
  }

  /** Forget history (after a resize, a quality change or a context restore). Keeps the current scale. */
  reset(scale?: number): void {
    if (scale !== undefined) this.scale = this.quantise(scale);
    this.frameMs = this.peakMs = this.heldMs = this.targetMs;
    this.overTime = this.underTime = this.atMinOverTime = 0;
    this.settle = SETTLE;
    this.upDelay = BASE_UP_DELAY;
    this.trialFrom = -1;
    this.sinceRaise = Infinity;
    this.ceiling = Infinity;
    this.dropStreak = 0;
  }

  /**
   * Feed one frame interval (ms). Returns the scale to render the next frame at; when it differs from
   * the previous value the caller reallocates its scene target.
   */
  update(intervalMs: number): number {
    if (!(intervalMs > 0) || intervalMs > HITCH_MS) return this.scale;
    const dt = intervalMs / 1000;
    this.frameMs += (intervalMs - this.frameMs) * 0.1;
    this.peakMs = Math.max(this.frameMs, this.peakMs - PEAK_DECAY * dt);
    if (!this.enabled) return this.scale;

    this.sinceRaise += dt;
    if (this.trialFrom >= 0 && this.sinceRaise >= TRIAL) {
      // The raise held. If it reached the old ceiling, the ceiling is gone and so is the back-off.
      if (this.scale >= this.ceiling - 1e-6) {
        this.ceiling = Infinity;
        this.upDelay = BASE_UP_DELAY;
      }
      this.trialFrom = -1;
    }
    if (this.settle > 0) {
      this.settle -= dt;
      return this.scale;
    }

    const ms = this.frameMs;
    const target = this.heldMs;
    if (ms > target * OVER) {
      this.overTime += dt;
      this.underTime = 0;
    } else if (ms < target * UNDER) {
      this.underTime += dt;
      this.overTime = Math.max(0, this.overTime - dt);
      if (this.underTime > CALM) this.dropStreak = 0;
    } else {
      this.overTime = Math.max(0, this.overTime - dt * 0.5);
      this.underTime = 0;
    }

    // The outside world got faster again (Low Power Mode off, a CPU-heavy stretch over): re-aim, in
    // stages as the peak-hold lets go, until the real target is back.
    if (this.heldMs > this.targetMs) {
      if (this.peakMs < this.targetMs * UNDER) {
        this.heldMs = this.targetMs;
        this.underTime = 0;
      } else if (this.peakMs < this.heldMs * 0.8) {
        this.heldMs = this.peakMs;
        this.underTime = 0;
      }
    }

    const onTrial = this.trialFrom >= 0 && this.scale > this.trialFrom;
    if (this.overTime > (onTrial ? TRIAL_DOWN_DELAY : DOWN_DELAY)) {
      if (this.scale > this.minScale + 1e-6) {
        let next: number;
        if (onTrial) {
          next = this.trialFrom;
          this.ceiling = Math.min(this.ceiling, this.scale);
          this.upDelay = Math.min(MAX_UP_DELAY, this.upDelay * 2);
        } else {
          // Fragment cost goes roughly with pixel count, i.e. scale^2.
          const floor = DROP_FLOOR[Math.min(this.dropStreak, DROP_FLOOR.length - 1)];
          const f = Math.min(0.95, Math.max(floor, Math.sqrt(target / ms)));
          next = this.quantise(this.scale * f);
          if (next >= this.scale) next = this.quantise(this.scale - this.step);
          this.dropStreak++;
        }
        this.trialFrom = -1;
        this.change(next, SETTLE);
      } else {
        this.atMinOverTime += dt;
        if (this.atMinOverTime > CAP_DELAY) {
          // A little head-room: the peak-hold has decayed since the worst moment, and the new target
          // must put that moment below the UNDER line or the scale would never be raised again.
          this.heldMs = Math.max(ms, this.peakMs) * CAP_MARGIN;
          this.atMinOverTime = 0;
          this.overTime = this.underTime = 0;
        }
      }
    } else if (this.scale < this.maxScale - 1e-6) {
      const next = this.quantise(this.scale + this.step);
      if (this.underTime > (next >= this.ceiling - 1e-6 ? this.upDelay : BASE_UP_DELAY)) {
        this.trialFrom = this.scale;
        this.sinceRaise = 0;
        this.change(next, SETTLE_UP);
      }
    }
    if (ms <= target * OVER) this.atMinOverTime = 0;
    return this.scale;
  }

  private change(next: number, settle: number): void {
    this.scale = next;
    this.settle = settle;
    this.overTime = this.underTime = 0;
    // Start the new measurement from the target instead of dragging the old overshoot along.
    this.frameMs = this.peakMs = this.heldMs;
  }

  private quantise(s: number): number {
    const q = Math.round(s / this.step) * this.step;
    return Math.min(this.maxScale, Math.max(this.minScale, Math.round(q * 1000) / 1000));
  }
}
