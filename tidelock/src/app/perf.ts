// Smoothness is measured, not assumed (docs/ARCHITECTURE.md §5): a rolling record of frame, simulation and
// render times, plus the automatic quality controller (resolution scale first, then the tier).
// No allocation per frame: fixed rings, percentiles computed on demand a couple of times a second.

export type PerfTier = 'low' | 'medium' | 'high' | 'ultra';
const TIERS: PerfTier[] = ['low', 'medium', 'high', 'ultra'];
const N = 240;
/**
 * Frame-time budget: lower quality when p95 stays above OVER_MS (a 60 Hz phone misses more than one frame in
 * twenty), raise it when comfortably below UNDER_MS — or, on a 60 Hz display where the interval can never be
 * below 16.7 ms, when every frame makes vsync and the CPU work leaves a wide margin.
 */
const OVER_MS = 17;
const UNDER_MS = 12;
const VSYNC_MS = 17.4;
const VSYNC_WORK_MS = 7;
/** A tier the controller had to leave is not tried again for this long, s (no up/down oscillation). */
const RETRY_SECONDS = 180;
const OVER_SECONDS = 3;
const UNDER_SECONDS = 10;
export const MIN_SCALE = 0.6;

// ---------------------------------------------------------------------------------------------- tiers

/** Everything a quality tier sets in the renderer: the one table the pipeline, the scene and the lighting read. */
export interface TierSettings {
  /** Device-pixel-ratio cap of the canvas (never above 2 on a phone). */
  dpr: number;
  /** MSAA samples on the HDR target (0 = FXAA). */
  msaa: number;
  /** Sun shadow map inside the ship, px (fitted to the visible rooms). */
  shadow: number;
  /** Planetshine shadow map, px; 0 = no planetshine light inside (it would leak through the bulkheads unshadowed). */
  shineShadow: number;
  /** Frames between sun shadow-map updates (1 = every frame). */
  shadowEvery: number;
  /** Reflection probe cube size per room, px. */
  probe: number;
  /** Live environment of the outside (sky + worlds) for the hull's reflections, cube px; 0 = the sky's baked one. */
  envProbe: number;
  /** Post effects. */
  chroma: boolean;
  sharpen: boolean;
  bloomHQ: boolean;
  bloomLevels: number;
  /** Lowest dynamic resolution scale the tier may use. */
  minScale: number;
}

export const TIER_SETTINGS: Record<PerfTier, TierSettings> = {
  low: { dpr: 1.0, msaa: 0, shadow: 512, shineShadow: 0, shadowEvery: 2, probe: 64, envProbe: 0, chroma: false, sharpen: false, bloomHQ: false, bloomLevels: 5, minScale: 0.6 },
  medium: { dpr: 1.5, msaa: 2, shadow: 1024, shineShadow: 0, shadowEvery: 1, probe: 128, envProbe: 64, chroma: true, sharpen: false, bloomHQ: true, bloomLevels: 6, minScale: 0.6 },
  high: { dpr: 2.0, msaa: 4, shadow: 2048, shineShadow: 512, shadowEvery: 1, probe: 128, envProbe: 128, chroma: true, sharpen: true, bloomHQ: true, bloomLevels: 6, minScale: 0.6 },
  ultra: { dpr: 2.0, msaa: 4, shadow: 2048, shineShadow: 1024, shadowEvery: 1, probe: 256, envProbe: 128, chroma: true, sharpen: true, bloomHQ: true, bloomLevels: 6, minScale: 0.7 },
};

/**
 * Tier to start on. An iPhone 15-class phone (the GPU detection says 'high') starts on 'high' — the target
 * look; the automatic controller steps down if p95 frame time stays over budget.
 */
export function startTier(detected: PerfTier): PerfTier {
  return detected === 'ultra' ? 'high' : detected;
}

/** What the renderer last drew, published by the scene manager for the perf overlay and the report. */
export interface RenderInfo {
  tier: PerfTier;
  msaa: number;
  shadow: number;
  shineShadow: number;
  probe: number;
  envProbe: number;
  drawCalls: number;
  triangles: number;
  /** Estimated GPU memory: textures (scene + lighting) and the pipeline's render targets, bytes. */
  textureBytes: number;
  targetBytes: number;
  /** Interior rooms drawn / total, and the camera's room. */
  rooms: number;
  roomsTotal: number;
  room: string;
  /** Exposure: 'auto' (metered on the GPU) or the manual EV. */
  exposure: string;
}

export const renderInfo: RenderInfo = {
  tier: 'medium',
  msaa: 0,
  shadow: 0,
  shineShadow: 0,
  probe: 0,
  envProbe: 0,
  drawCalls: 0,
  triangles: 0,
  textureBytes: 0,
  targetBytes: 0,
  rooms: 0,
  roomsTotal: 0,
  room: '',
  exposure: '',
};

const mb = (b: number): string => (b / 1048576).toFixed(0);

/** Two lines for the perf overlay: tier, shadow and MSAA settings, draws, triangles, GPU memory. */
export function renderInfoText(): string {
  const r = renderInfo;
  return (
    `${r.tier} · msaa ${r.msaa}x · shadow ${r.shadow}${r.shineShadow ? `+${r.shineShadow}` : ''} · probe ${r.probe} · env ${r.envProbe || 'sky'}\n` +
    `draws ${r.drawCalls} · tris ${(r.triangles / 1000).toFixed(0)}k · tex ${mb(r.textureBytes)} MB · rt ${mb(r.targetBytes)} MB` +
    (r.roomsTotal ? ` · rooms ${r.rooms}/${r.roomsTotal} ${r.room}` : '') +
    (r.exposure ? ` · ev ${r.exposure}` : '')
  );
}

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
  /** Seconds left before a tier that had to be left may be tried again. */
  private retry = 0;
  private retryTier: PerfTier | null = null;
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
    if (this.retry > 0) this.retry -= step;
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
        this.retryTier = this.tier;
        this.retry = RETRY_SECONDS;
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
    const vsync = p95 < VSYNC_MS && work < VSYNC_WORK_MS;
    if (p95 < UNDER_MS || capped || vsync) {
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
      const blocked = this.retry > 0 && TIERS[ti + 1] === this.retryTier;
      if (this.autoTier && !capped && !blocked && ti < TIERS.indexOf(this.maxTier) && ++this.calm >= 3) {
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
      ...renderInfoText().split('\n'),
      s.note ? `last auto change: ${s.note}` : 'no auto change yet',
      ...extra,
    ].join('\n');
  }
}
