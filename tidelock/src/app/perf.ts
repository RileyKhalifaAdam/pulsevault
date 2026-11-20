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
/** The 60 fps frame budget, and the 30 fps one used while ray tracing at High (the owner's choice). */
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
  return rt === 'high' ? BUDGET_30 : BUDGET_60;
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

/** Means over this long of real time (SIMULATION.md W1-A 4: Safari's clock is 1 ms coarse; means, not percentiles). */
export const MEAN_SECONDS = 2;
/** The thermal proxy: one p50 of frame and render per minute, for the last TREND_MINUTES. */
export const TREND_MINUTES = 20;
/**
 * GPU-bound: the frame is over its target interval while the main thread idles at least this share of it (the CPU
 * waits on the GPU). Then the resolution goes down, and the CPU (the simulation budget) is never blamed.
 */
export const GPU_IDLE_SHARE = 0.25;

export interface PerfSnapshot {
  samples: number;
  /** 2 s means (ms): frame interval, simulation, render CPU, idle = frame − sim − render; work units, ms per unit. */
  frameMean: number;
  simMean: number;
  renderMean: number;
  idleMean: number;
  unitsMean: number;
  msPerUnit: number;
  /** The target interval of this tier (33.3 ms ray tracing at High, else 16.7) and the GPU-bound inference. */
  target: number;
  gpuBound: boolean;
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
  // 2 s means (accumulating, and the last complete window) and the 20 min trend (per-minute p50s, a ring)
  private acc2 = new Float64Array(6);
  private mean2 = new Float64Array(6);
  private meanReady = false;
  private minuteAcc = 0;
  private readonly trendFrame = new Float32Array(TREND_MINUTES);
  private readonly trendRender = new Float32Array(TREND_MINUTES);
  private trendHead = 0;
  private trendCount = 0;
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
   * High (the owner's ~30 fps choice). The thresholds scale with it.
   */
  budgetMs = BUDGET_60;
  /** Free-form lines for the report (device, renderer). */
  device: string[] = [];

  constructor(tier: PerfTier) {
    this.tier = tier;
    this.maxTier = tier;
    this.snap = { samples: 0, frameMean: 0, simMean: 0, renderMean: 0, idleMean: 0, unitsMean: 0, msPerUnit: 0, target: BUDGET_60, gpuBound: false, fps: 0, frameP50: 0, frameP95: 0, simP50: 0, simP95: 0, renderP50: 0, renderP95: 0, steps: 0, drawCalls: 0, triangles: 0, scale: 1, tier, note: '' };
  }

  /**
   * One rendered frame: the interval since the previous one, simulation and render CPU time (ms), integration steps
   * and work units (the session's budget currency) taken.
   */
  record(frameMs: number, simMs: number, renderMs: number, steps: number, units = 0): void {
    if (!(frameMs > 0) || frameMs > 250) return; // a hidden tab or a stall is not a frame
    // 2 s means: [real ms, frames, sim ms, render ms, idle ms, units]
    const a = this.acc2;
    const idle = frameMs - simMs - renderMs;
    a[0] += frameMs; a[1] += 1; a[2] += simMs; a[3] += renderMs; a[4] += idle > 0 ? idle : 0; a[5] += units;
    if (a[0] >= MEAN_SECONDS * 1000) {
      const m = this.mean2;
      for (let k = 0; k < 6; k++) { m[k] = a[k]; a[k] = 0; }
      this.meanReady = true;
    }
    this.minuteAcc += frameMs;
    if (this.minuteAcc >= 60000 && this.count >= 30) {
      this.minuteAcc = 0;
      const t = this.trendHead;
      this.trendFrame[t] = this.pct(this.frame, 0.5);
      this.trendRender[t] = this.pct(this.render, 0.5);
      this.trendHead = (t + 1) % TREND_MINUTES;
      if (this.trendCount < TREND_MINUTES) this.trendCount++;
    }
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

  /** The 2 s means (the last complete window; before the first, the running one). */
  private means(o: PerfSnapshot): void {
    const m = this.meanReady ? this.mean2 : this.acc2, f = m[1] > 0 ? m[1] : 1;
    o.frameMean = m[0] / f;
    o.simMean = m[2] / f;
    o.renderMean = m[3] / f;
    o.idleMean = m[4] / f;
    o.unitsMean = m[5] / f;
    o.msPerUnit = m[5] > 0 ? m[2] / m[5] : 0;
    o.target = this.budgetMs;
    o.gpuBound = PerfMonitor.gpuBound(o.frameMean, o.idleMean, this.budgetMs);
  }

  /**
   * The inference (SIMULATION.md W1-A 4): over the target interval with the main thread idle for ≥ GPU_IDLE_SHARE of
   * the target means the GPU is the limit, not the CPU.
   */
  static gpuBound(frameMean: number, idleMean: number, target: number): boolean {
    return frameMean > target * 1.06 && idleMean >= GPU_IDLE_SHARE * target;
  }

  /** The thermal proxy: per-minute p50 of frame and render, oldest first ("f/r" ms), up to 20 minutes. */
  trend(): string {
    const out: string[] = [];
    for (let k = 0; k < this.trendCount; k++) {
      const i = (this.trendHead - this.trendCount + k + TREND_MINUTES) % TREND_MINUTES;
      out.push(`${this.trendFrame[i].toFixed(1)}/${this.trendRender[i].toFixed(1)}`);
    }
    return out.join(' ');
  }

  snapshot(): PerfSnapshot {
    const o = this.snap;
    const n = this.count;
    o.samples = n;
    this.means(o);
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
    // RT High (33 ms target): frames at ≈ 33 ms with the CPU idle are the owner's choice working, not a miss
    this.means(this.snap);
    const rtOnTarget = k >= 1.5 && p50 < this.budgetMs * 1.06 && p95 < RT_OVER_MS && this.snap.idleMean >= GPU_IDLE_SHARE * this.budgetMs;
    const ch = this.change;
    ch.tier = null;
    if (p95 > overMs && !capped && !rtOnTarget) {
      this.under = this.calm = 0;
      this.over += step;
      if (this.over < OVER_SECONDS) return null;
      this.over = 0;
      if (this.scale > MIN_SCALE + 1e-3) {
        this.scale = Math.max(MIN_SCALE, Math.round((this.scale - 0.1) * 100) / 100);
        this.note = `scale down to ${this.scale.toFixed(2)} (p95 ${p95.toFixed(1)} ms${this.snap.gpuBound ? ', GPU-bound: idle ' + this.snap.idleMean.toFixed(1) + ' ms' : ''})`;
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
      `2 s means: frame ${f(s.frameMean)} ms (target ${f(s.target)}) · sim ${s.simMean.toFixed(2)} · render cpu ${f(s.renderMean)} · idle ${f(s.idleMean)}${s.gpuBound ? ' · GPU-bound' : ''}`,
      `sim work ${s.unitsMean.toFixed(0)} units/frame · ${(s.msPerUnit * 1000).toFixed(2)} µs/unit · steps/frame ${f(s.steps)}`,
      `frame ms p50 ${f(s.frameP50)} p95 ${f(s.frameP95)} (the governors' input)`,
      `trend (per minute, frame/render p50 ms): ${this.trend() || 'not yet'}`,
      `draw calls ${s.drawCalls} · triangles ${s.triangles}`,
      `tier ${s.tier} · resolution scale ${s.scale.toFixed(2)} · auto tier ${this.autoTier ? 'on' : 'off'} · frame budget ${this.budgetMs.toFixed(1)} ms`,
      ...renderInfoText().split('\n'),
      s.note ? `last auto change: ${s.note}` : 'no auto change yet',
      ...extra,
    ].join('\n');
  }
}

// ---------------------------------------------------------------------------------------------- autosave

/** The periodic save: every AUTOSAVE_SECONDS of play, on a frame with at least AUTOSAVE_IDLE_MS of idle main thread. */
export const AUTOSAVE_SECONDS = 60;
export const AUTOSAVE_IDLE_MS = 4;
/** After this long overdue, the save goes on the next frame whatever its idle (never lost to a busy stretch). */
const AUTOSAVE_OVERDUE = 30;

/**
 * The periodic save without a hitch (SIMULATION.md W1-A 6, perf-autosave-hitch). Storage is probed once: when the
 * probe fails (the viewer blocks localStorage) nothing is ever serialised, because the string would go nowhere.
 * Otherwise the session is serialised on a frame that left idle time, and written in a following setTimeout(0) so
 * the write is not inside the frame either. Pure: the storage, the timer and the serialiser are injected.
 */
export class Autosave {
  /** False when the storage probe failed: no periodic stringify at all. */
  readonly enabled: boolean;
  private since = 0;
  private pending: string | null = null;
  /** Serialisations made (tests and the report). */
  count = 0;
  constructor(
    probe: () => boolean,
    private readonly write: (json: string) => boolean,
    private readonly later: (fn: () => void) => void = (fn) => { setTimeout(fn, 0); },
  ) {
    let ok = false;
    try { ok = probe(); } catch { ok = false; }
    this.enabled = ok;
  }
  /** A save was made some other way (an event, the menu): the period starts again. */
  saved(): void {
    this.since = 0;
  }
  /** Once per running frame: real seconds since the last, the idle the last frame left (ms), the serialiser. */
  frame(dt: number, idleMs: number, serialise: () => string): void {
    if (!this.enabled || this.pending !== null) return;
    this.since += dt;
    if (this.since < AUTOSAVE_SECONDS) return;
    if (idleMs < AUTOSAVE_IDLE_MS && this.since < AUTOSAVE_SECONDS + AUTOSAVE_OVERDUE) return;
    this.since = 0;
    this.pending = serialise();
    this.count++;
    this.later(() => {
      const j = this.pending;
      this.pending = null;
      if (j !== null) { try { this.write(j); } catch { /* the next period tries again */ } }
    });
  }
}
