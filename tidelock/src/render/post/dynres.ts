// Dynamic resolution controller: picks the internal render scale (minScale..maxScale of the tier's pixel
// ratio) that holds the target frame rate. Pure logic — no three.js, no DOM — so it can be simulated.
//
// The only signal a browser gives us is the interval between animation frames, and that is clamped to
// the display refresh: a frame that takes 9 ms and one that takes 15 ms both arrive after 16.7 ms. So the
// controller cannot read head-room; it works like this instead:
//
//   * DOWN  — when the smoothed interval stays more than `OVER` above the target for `downDelay`
//             seconds (frames are being dropped), step the scale down, proportionally to the overshoot.
//   * UP    — when the interval has sat on the target for `upDelay` seconds, probe one step up.
//   * BACK-OFF — if a probe is followed by a drop within `probeWindow`, the scale it tried is too
//             expensive: double `upDelay` (to at most `maxUpDelay`) before trying again. A probe that
//             survives halves it again. This, the dead band between OVER and UNDER and the settle time
//             after every change are the hysteresis that stops the scale from oscillating.
//   * RATE CAP — if the interval is still over target at the minimum scale (Low Power Mode pins Safari
//             to 30 Hz; a CPU-bound frame does not get cheaper with fewer pixels), resolution is not the
//             bottleneck. The controller adopts the measured interval as its target and climbs back up
//             by probing, instead of rendering a blurry image for nothing.

export interface DynResOptions {
  targetFps?: number;
  minScale?: number;
  maxScale?: number;
  /** Quantisation of the scale; every change reallocates the scene target, so keep it coarse. */
  step?: number;
}

const OVER = 1.12;
const UNDER = 1.05;
const SETTLE = 0.6; // s without decisions after a change (lets the smoothed interval catch up)
const DOWN_DELAY = 0.4; // s over budget before stepping down
const BASE_UP_DELAY = 2.5; // s on target before the first probe
const MAX_UP_DELAY = 40;
const PROBE_WINDOW = 3; // s after a probe during which a drop counts as "that probe failed"
const CAP_DELAY = 3; // s over budget at the minimum scale before adopting the measured rate
const HITCH_MS = 250; // intervals longer than this are pauses (tab switch, GC, shader compile), not load

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
  private overTime = 0;
  private underTime = 0;
  private atMinOverTime = 0;
  private settle = 0;
  private upDelay = BASE_UP_DELAY;
  private sinceProbe = Infinity;

  constructor(opts: DynResOptions = {}) {
    this.minScale = opts.minScale ?? 0.6;
    this.maxScale = opts.maxScale ?? 1.0;
    this.step = opts.step ?? 0.05;
    this.targetMs = 1000 / (opts.targetFps ?? 60);
    this.heldMs = this.targetMs;
    this.frameMs = this.targetMs;
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
    this.frameMs = this.heldMs = this.targetMs;
    this.overTime = this.underTime = this.atMinOverTime = 0;
    this.settle = SETTLE;
    this.upDelay = BASE_UP_DELAY;
    this.sinceProbe = Infinity;
  }

  /**
   * Feed one frame interval (ms). Returns the scale to render the next frame at; when it differs from
   * the previous value the caller reallocates its scene target.
   */
  update(intervalMs: number): number {
    if (!(intervalMs > 0) || intervalMs > HITCH_MS) return this.scale;
    const dt = intervalMs / 1000;
    this.frameMs += (intervalMs - this.frameMs) * 0.1;
    if (!this.enabled) return this.scale;

    this.sinceProbe += dt;
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
    } else {
      this.overTime = Math.max(0, this.overTime - dt * 0.5);
      this.underTime = 0;
    }

    // The outside world got faster again (Low Power Mode off, a heavy scene left): re-aim at the real target.
    if (this.heldMs > this.targetMs && ms < this.heldMs * 0.8) {
      this.heldMs = Math.max(this.targetMs, ms);
      this.underTime = 0;
    }

    if (this.overTime > DOWN_DELAY) {
      if (this.scale > this.minScale + 1e-6) {
        // Fragment cost goes roughly with pixel count, i.e. scale^2.
        const f = Math.min(0.95, Math.max(0.8, Math.sqrt(target / ms)));
        let next = this.quantise(this.scale * f);
        if (next >= this.scale) next = this.quantise(this.scale - this.step);
        if (this.sinceProbe < PROBE_WINDOW) this.upDelay = Math.min(MAX_UP_DELAY, this.upDelay * 2);
        this.sinceProbe = Infinity;
        this.change(next);
      } else {
        this.atMinOverTime += dt;
        if (this.atMinOverTime > CAP_DELAY) {
          this.heldMs = ms;
          this.atMinOverTime = 0;
          this.overTime = this.underTime = 0;
        }
      }
    } else if (this.underTime > this.upDelay && this.scale < this.maxScale - 1e-6) {
      if (this.sinceProbe !== Infinity && this.sinceProbe >= PROBE_WINDOW) {
        this.upDelay = Math.max(BASE_UP_DELAY, this.upDelay * 0.5); // the last probe held
      }
      this.sinceProbe = 0;
      this.change(this.quantise(this.scale + this.step));
    }
    if (ms <= target * OVER) this.atMinOverTime = 0;
    return this.scale;
  }

  private change(next: number): void {
    this.scale = next;
    this.settle = SETTLE;
    this.overTime = this.underTime = 0;
    // Start the new measurement from the target instead of dragging the old overshoot along.
    this.frameMs = this.heldMs;
  }

  private quantise(s: number): number {
    const q = Math.round(s / this.step) * this.step;
    return Math.min(this.maxScale, Math.max(this.minScale, Math.round(q * 1000) / 1000));
  }
}
