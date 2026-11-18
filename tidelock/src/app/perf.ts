// Smoothness is measured, not assumed (docs/ARCHITECTURE.md §5): a rolling record of frame, simulation and
// render times, plus the automatic quality controller (resolution scale first, then the tier).
// No allocation per frame: fixed rings, percentiles computed on demand a couple of times a second.

export type PerfTier = 'low' | 'medium' | 'high' | 'ultra';
const TIERS: PerfTier[] = ['low', 'medium', 'high', 'ultra'];
const N = 240;
/** Frame-time budget: lower quality when p95 stays above OVER_MS, raise it when comfortably below UNDER_MS. */
const OVER_MS = 20;
const UNDER_MS = 12;
const OVER_SECONDS = 3;
const UNDER_SECONDS = 10;
export const MIN_SCALE = 0.6;

export interface PerfSnapshot {
  samples: number;
  fps: number;
  frameP50: number;
  frameP95: number;
  simP50: number;
  simP95: number;
  renderP50: number;
  renderP95: number;
  /** Integration steps per frame (mean). */
  steps: number;
  drawCalls: number;
  triangles: number;
  scale: number;
  tier: PerfTier;
  /** What the automatic quality last did, for the overlay. */
  note: string;
}

export interface QualityChange {
  scale: number;
  /** Set when the tier has to change too. */
  tier: PerfTier | null;
}

export class PerfMonitor {
  private frame = new Float32Array(N);
  private sim = new Float32Array(N);
  private render = new Float32Array(N);
  private stepsRing = new Float32Array(N);
  private scratch = new Float32Array(N);
  private head = 0;
  private count = 0;
  private drawCalls = 0;
  private triangles = 0;
  private over = 0;
  private under = 0;
  private calm = 0;
  private hold = 2;
  private acc = 0;
  private note = '';
  private readonly snap: PerfSnapshot;
  private readonly change: QualityChange = { scale: 1, tier: null };
  scale = 1;
  tier: PerfTier;
  /** Highest tier the controller may climb back to, and whether it may change the tier at all. */
  maxTier: PerfTier;
  autoTier = true;
  /** Free-form lines for the report (device, renderer). */
  device: string[] = [];

  constructor(tier: PerfTier) {
    this.tier = tier;
    this.maxTier = tier;
    this.snap = { samples: 0, fps: 0, frameP50: 0, frameP95: 0, simP50: 0, simP95: 0, renderP50: 0, renderP95: 0, steps: 0, drawCalls: 0, triangles: 0, scale: 1, tier, note: '' };
  }

  /** One rendered frame: the interval since the previous one, simulation and render CPU time (ms), steps taken. */
  record(frameMs: number, simMs: number, renderMs: number, steps: number): void {
    if (!(frameMs > 0) || frameMs > 250) return; // a hidden tab or a stall is not a frame
    const i = this.head;
    this.frame[i] = frameMs;
    this.sim[i] = simMs;
    this.render[i] = renderMs;
    this.stepsRing[i] = steps;
    this.head = (i + 1) % N;
    if (this.count < N) this.count++;
  }
  setRender(drawCalls: number, triangles: number): void {
    this.drawCalls = drawCalls;
    this.triangles = triangles;
  }
  /** Forget the record (after a tier change or a pause: those frames say nothing about steady state). */
  clear(holdSeconds = 0): void {
    this.count = 0;
    this.head = 0;
    this.over = this.under = 0;
    this.hold = Math.max(this.hold, holdSeconds);
  }

  private pct(ring: Float32Array, p: number, last = this.count): number {
    const n = Math.min(last, this.count);
    if (n === 0) return 0;
    const s = this.scratch;
    for (let k = 0; k < n; k++) s[k] = ring[(this.head - 1 - k + 2 * N) % N];
    const view = s.subarray(0, n);
    view.sort();
    return view[Math.min(n - 1, Math.floor(p * n))];
  }

  snapshot(): PerfSnapshot {
    const o = this.snap;
    const n = this.count;
    o.samples = n;
    o.frameP50 = this.pct(this.frame, 0.5);
    o.frameP95 = this.pct(this.frame, 0.95);
    o.simP50 = this.pct(this.sim, 0.5);
    o.simP95 = this.pct(this.sim, 0.95);
    o.renderP50 = this.pct(this.render, 0.5);
    o.renderP95 = this.pct(this.render, 0.95);
    let sum = 0;
    let st = 0;
    for (let k = 0; k < n; k++) {
      sum += this.frame[k];
      st += this.stepsRing[k];
    }
    o.fps = sum > 0 ? (1000 * n) / sum : 0;
    o.steps = n ? st / n : 0;
    o.drawCalls = this.drawCalls;
    o.triangles = this.triangles;
    o.scale = this.scale;
    o.tier = this.tier;
    o.note = this.note;
    return o;
  }

  /**
   * Automatic quality. Call once per frame with the real frame interval; returns a change to apply (the same
   * object every time) or null. Lowers the resolution scale first, then the tier; climbs back slowly.
   */
  auto(dt: number): QualityChange | null {
    this.acc += dt;
    if (this.acc < 0.5) return null;
    const step = this.acc;
    this.acc = 0;
    if (this.hold > 0) {
      this.hold -= step;
      return null;
    }
    if (this.count < 45) return null;
    const p95 = this.pct(this.frame, 0.95, 120);
    const p50 = this.pct(this.frame, 0.5, 120);
    // Low Power Mode caps rAF at 30 fps: steady 33 ms frames with little work are not a reason to cut quality.
    const work = this.pct(this.sim, 0.95, 120) + this.pct(this.render, 0.95, 120);
    const capped = p50 > 30 && p50 < 36.5 && p95 < 40 && work < UNDER_MS;
    const ch = this.change;
    ch.tier = null;
    if (p95 > OVER_MS && !capped) {
      this.under = this.calm = 0;
      this.over += step;
      if (this.over < OVER_SECONDS) return null;
      this.over = 0;
      if (this.scale > MIN_SCALE + 1e-3) {
        this.scale = Math.max(MIN_SCALE, Math.round((this.scale - 0.1) * 100) / 100);
        this.note = `scale down to ${this.scale.toFixed(2)} (p95 ${p95.toFixed(1)} ms)`;
        ch.scale = this.scale;
        return ch;
      }
      const ti = TIERS.indexOf(this.tier);
      if (this.autoTier && ti > 0) {
        this.tier = TIERS[ti - 1];
        this.scale = 0.8;
        this.note = `tier down to ${this.tier} (p95 ${p95.toFixed(1)} ms)`;
        this.clear(8);
        ch.scale = this.scale;
        ch.tier = this.tier;
        return ch;
      }
      return null;
    }
    this.over = 0;
    if (p95 < UNDER_MS || capped) {
      this.under += step;
      if (this.under < UNDER_SECONDS) return null;
      this.under = 0;
      if (this.scale < 1 - 1e-3) {
        this.scale = Math.min(1, Math.round((this.scale + 0.05) * 100) / 100);
        this.note = `scale up to ${this.scale.toFixed(2)}`;
        ch.scale = this.scale;
        return ch;
      }
      const ti = TIERS.indexOf(this.tier);
      if (this.autoTier && !capped && ti < TIERS.indexOf(this.maxTier) && ++this.calm >= 3) {
        this.calm = 0;
        this.tier = TIERS[ti + 1];
        this.scale = 0.85;
        this.note = `tier up to ${this.tier}`;
        this.clear(8);
        ch.scale = this.scale;
        ch.tier = this.tier;
        return ch;
      }
    } else this.under = 0;
    return null;
  }

  /** The text behind "Copy performance report". */
  report(extra: string[] = []): string {
    const s = this.snapshot();
    const f = (v: number): string => v.toFixed(1);
    return [
      'TIDELOCK performance report',
      ...this.device,
      `fps ${f(s.fps)} over ${s.samples} frames`,
      `frame ms p50 ${f(s.frameP50)} p95 ${f(s.frameP95)}`,
      `sim ms p50 ${s.simP50.toFixed(2)} p95 ${s.simP95.toFixed(2)} · steps/frame ${f(s.steps)}`,
      `render cpu ms p50 ${f(s.renderP50)} p95 ${f(s.renderP95)}`,
      `draw calls ${s.drawCalls} · triangles ${s.triangles}`,
      `tier ${s.tier} · resolution scale ${s.scale.toFixed(2)} · auto tier ${this.autoTier ? 'on' : 'off'}`,
      s.note ? `last auto change: ${s.note}` : 'no auto change yet',
      ...extra,
    ].join('\n');
  }
}
