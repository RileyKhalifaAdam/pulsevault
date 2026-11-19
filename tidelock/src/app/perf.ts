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
/** The 60 fps frame budget, and the 30 fps one used while ray tracing at medium / high (the owner's choice). */
export const BUDGET_60 = 1000 / 60;
export const BUDGET_30 = 1000 / 30;
const VSYNC_MS = 17.4;
const VSYNC_WORK_MS = 7;
/** A tier the controller had to leave is not tried again for this long, s (no up/down oscillation). */
const RETRY_SECONDS = 180;
const OVER_SECONDS = 3;
const UNDER_SECONDS = 10;
export const MIN_SCALE = 0.6;

// ---------------------------------------------------------------------------------------------- ray tracing

export type RtTier = 'off' | 'low' | 'medium' | 'high';
export const RT_CHOICES: readonly RtTier[] = ['off', 'low', 'medium', 'high'];
/** Ray tracing in the system menu: the owner wants it, so the phone starts on High (~30 fps). */
export const RT_DEFAULT: RtTier = 'high';
/** The safety governor: p95 frame time above this for RT_OVER_SECONDS steps the ray tracing down one notch. */
export const RT_OVER_MS = 40;
const RT_OVER_SECONDS = 3;
/** The lowest tier the governor steps down to by itself (the owner can still choose Off in the menu). */
export const RT_FLOOR: RtTier = 'low';
/** Back up one notch (never above the owner's choice) after this long well inside budget, and not sooner than RT_RETRY_SECONDS after a drop. */
const RT_UNDER_MS = 28;
const RT_UNDER_SECONDS = 30;
const RT_RETRY_SECONDS = 180;
/** Frame budget the resolution controller works to for a ray-tracing tier. */
export function frameBudgetFor(rt: RtTier): number {
  return rt === 'high' || rt === 'medium' ? BUDGET_30 : BUDGET_60;
}

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
  /** Ray tracing: tier in effect ('off' when not drawn), rays traced last frame, GPU ms (estimate; measured, -1 if not available). */
  rt: string;
  rtRays: number;
  rtMsEstimate: number;
  rtMsGpu: number;
  /** GPU memory of the ray tracer (BVH + its targets), and the sum of textures + targets + ray tracer, bytes. */
  rtBytes: number;
  totalBytes: number;
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
  rt: 'off',
  rtRays: 0,
  rtMsEstimate: 0,
  rtMsGpu: -1,
  rtBytes: 0,
  totalBytes: 0,
};

const mb = (b: number): string => (b / 1048576).toFixed(0);

/** Two lines for the perf overlay: tier, shadow and MSAA settings, draws, triangles, GPU memory. */
export function renderInfoText(): string {
  const r = renderInfo;
  return (
    `${r.tier} · msaa ${r.msaa}x · shadow ${r.shadow}${r.shineShadow ? `+${r.shineShadow}` : ''} · probe ${r.probe} · env ${r.envProbe || 'sky'}\n` +
    `draws ${r.drawCalls} · tris ${(r.triangles / 1000).toFixed(0)}k · tex ${mb(r.textureBytes)} MB · rt ${mb(r.targetBytes)} MB` +
    (r.roomsTotal ? ` · rooms ${r.rooms}/${r.roomsTotal} ${r.room}` : '') +
    (r.exposure ? ` · ev ${r.exposure}` : '') +
    `\n${rtInfoText()} · gpu mem ${mb(r.totalBytes)} MB (rt ${mb(r.rtBytes)})`
  );
}

/** One line for the overlay: ray-tracing tier, rays per frame, GPU ms (estimate, and measured where possible). */
export function rtInfoText(): string {
  const r = renderInfo;
  if (r.rt === 'off') return 'RT off';
  return `RT ${r.rt} · ${(r.rtRays / 1e6).toFixed(2)}M rays · ~${r.rtMsEstimate.toFixed(1)} ms est${r.rtMsGpu >= 0 ? ` · ${r.rtMsGpu.toFixed(1)} ms gpu` : ''}`;
}

/**
 * The ray-tracing safety governor: p95 frame time above RT_OVER_MS for 3 s steps the tier down one notch (not below
 * RT_FLOOR);
 * after a long calm it may climb back, never above the owner's choice. Call once per frame; returns the tier
 * to switch to, or null. No allocation.
 */
export class RtGovernor {
  /** The owner's choice (the ceiling) and the tier in effect. */
  choice: RtTier;
  tier: RtTier;
  /** What it last did, for the report ('' = nothing yet). */
  note = '';
  private over = 0;
  private under = 0;
  private retry = 0;
  private hold = 2;
  constructor(choice: RtTier) {
    this.choice = choice;
    this.tier = choice;
  }
  /** The owner picked a tier in the menu: it is in effect at once and is the new ceiling. */
  choose(t: RtTier): void {
    this.choice = t;
    this.tier = t;
    this.over = this.under = this.retry = 0;
    this.hold = 4;
  }
  /** Ignore the next seconds (a tier change, a pause: those frames say nothing). */
  settle(seconds: number): void {
    this.hold = Math.max(this.hold, seconds);
    this.over = this.under = 0;
  }
  update(dt: number, p95: number, samples: number): RtTier | null {
    if (this.retry > 0) this.retry -= dt;
    if (this.hold > 0) {
      this.hold -= dt;
      return null;
    }
    if (samples < 45 || (this.tier === 'off' && this.choice === 'off')) {
      this.over = this.under = 0;
      return null;
    }
    // never below Low on its own: Low (sun visibility only, ~5 ms) is not what makes a frame miss 40 ms, and a
    // transient stall (a bake, the app returning from the background) must not take ray tracing away for good
    if (RT_CHOICES.indexOf(this.tier) > RT_CHOICES.indexOf(RT_FLOOR) && p95 > RT_OVER_MS) {
      this.under = 0;
      this.over += dt;
      if (this.over < RT_OVER_SECONDS) return null;
      this.over = 0;
      const i = RT_CHOICES.indexOf(this.tier);
      this.tier = RT_CHOICES[i - 1];
      this.retry = RT_RETRY_SECONDS;
      this.hold = 4;
      this.note = `ray tracing down to ${this.tier} (p95 ${p95.toFixed(1)} ms > ${RT_OVER_MS})`;
      return this.tier;
    }
    this.over = 0;
    if (this.tier !== this.choice && this.retry <= 0 && p95 < RT_UNDER_MS) {
      this.under += dt;
      if (this.under < RT_UNDER_SECONDS) return null;
      this.under = 0;
      const i = RT_CHOICES.indexOf(this.tier);
      this.tier = RT_CHOICES[Math.min(i + 1, RT_CHOICES.indexOf(this.choice))];
      this.retry = RT_RETRY_SECONDS;
      this.hold = 4;
      this.note = `ray tracing back up to ${this.tier} (p95 ${p95.toFixed(1)} ms)`;
      return this.tier;
    }
    this.under = 0;
    return null;
  }
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
  /**
   * Frame budget the resolution / tier controller works to, ms: 16.7 (60 fps) normally, 33.3 while ray tracing at
   * medium or high (the owner's ~30 fps choice). The thresholds scale with it.
   */
  budgetMs = BUDGET_60;
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
    const k = this.budgetMs / BUDGET_60;
    const overMs = OVER_MS * k;
    const underMs = UNDER_MS * k;
    const capped = k < 1.5 && p50 > 30 && p50 < 36.5 && p95 < 40 && work < UNDER_MS;
    const ch = this.change;
    ch.tier = null;
    if (p95 > overMs && !capped) {
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
    const vsync = p95 < VSYNC_MS * k && work < VSYNC_WORK_MS * k;
    if (p95 < underMs || capped || vsync) {
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

  /** p95 frame time over the last `n` frames (the governor's input). */
  p95(n = 120): number {
    return this.pct(this.frame, 0.95, n);
  }
  get samples(): number {
    return this.count;
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
      `tier ${s.tier} · resolution scale ${s.scale.toFixed(2)} · auto tier ${this.autoTier ? 'on' : 'off'} · frame budget ${this.budgetMs.toFixed(1)} ms`,
      ...renderInfoText().split('\n'),
      s.note ? `last auto change: ${s.note}` : 'no auto change yet',
      ...extra,
    ].join('\n');
  }
}
