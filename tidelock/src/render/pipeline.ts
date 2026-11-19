// TIDELOCK renderer + HDR post-processing pipeline.
//
//   layers (far scene, near scene, …) ──► one half-float HDR target (4x MSAA on high/ultra)
//     ──► bloom: Karis-averaged bright pass + 13-tap downsample chain, tent upsample chain (half res ↓)
//     ──► composite: sharpen · chromatic aberration · effects · exposure · bloom · vignette ·
//                    hue-preserving filmic tone map · split-tone grade · sRGB · dither (· grain)
//     ──► FXAA + grain (only on the tiers without MSAA) ──► canvas
//   auto exposure (optional, GPU only, no read-back): scene ──► 128² log-luminance ──► 32² ──► 8² ──► 2²
//     ──► 1x1 adapted log2 exposure (ping-pong, ~1 s) read by the bloom prefilter and the composite
//
// Tiers come from src/app/perf.ts (TIER_SETTINGS): MSAA 4x on high / ultra, 2x on medium, FXAA on low
// (and wherever multisampled half-float targets are refused).
//
// A lean chain of full-screen-triangle passes instead of EffectComposer: no ping-pong copies, no
// per-pass buffer allocation, and the one colour-space conversion is ours. Everything is linear
// working space in half-float targets until the composite encodes sRGB, once.
//
// Resolution: the canvas backing store is `css size × min(devicePixelRatio, tier cap)` and never changes
// with load. Only the HDR scene target is scaled (0.6–1.0, see post/dynres.ts); the composite magnifies
// it. The bloom chain is sized from the CSS size, so its look neither breathes with the resolution scale
// nor changes between quality tiers.
//
// MSAA note. three.js resolves *and invalidates* a multisampled render target at the end of every
// `renderer.render()`, so a second layer drawn into the same target starts from undefined contents on
// tile-based GPUs (every iPhone) — and each resolve is a full store/load of the 4x buffer. The MSAA
// framebuffer is therefore owned here (raw GL renderbuffers), handed to three through a proxy render
// target, and resolved exactly once per frame after the last layer.

import * as THREE from 'three';
import { TIER_SETTINGS } from '../app/perf';
import { detectGpu, type GpuInfo } from './post/detect';
import { DynamicResolution } from './post/dynres';
import {
  ADAPT_FRAG,
  LUM_FRAG,
  REDUCE_FRAG,
  BLOOM_DOWN_FRAG,
  BLOOM_PREFILTER_FRAG,
  BLOOM_UP_FRAG,
  COMPOSITE_FRAG,
  FULLSCREEN_VERT,
  FXAA_FRAG,
} from './post/shaders';

// ---------------------------------------------------------------------------------------------- API

export type Quality = 'low' | 'medium' | 'high' | 'ultra';

export interface RenderLayer {
  scene: THREE.Scene;
  camera: THREE.Camera;
  /** Clear depth before drawing this layer (the near scene over the far scene). */
  clearDepth?: boolean;
}

export type EffectName = 'jump' | 'damage' | 'heat' | 'flash';

type RGBTuple = readonly [number, number, number];

/** Look controls; every field is optional and only the given ones change. */
export interface GradeParams {
  /** Tone-curve contrast around mid grey. 1 = the ACES-fit base curve. Default 1. */
  contrast?: number;
  /** Oklab chroma scale, 1 = neutral. Default 1.04. */
  saturation?: number;
  /** Split-tone colours (linear RGB, only their chroma matters). Defaults: cool shadows, warm highlights. */
  shadowTint?: RGBTuple;
  highlightTint?: RGBTuple;
  /** Split-tone strength 0..1. Default 0.35. */
  split?: number;
  /** Vignette strength 0..1 over the image circle (0.2 ≈ −0.5 EV in the corners). Default 0.2. */
  vignette?: number;
  /** Film grain amplitude in display units. Default 0.025. */
  grain?: number;
  /** Lateral chromatic aberration: red/blue shift in CSS px in the frame corners. Default 0.3. Off on `low`. */
  aberration?: number;
  /** Contrast-adaptive sharpen strength 0..1. Default 0.4. Only on `high` / `ultra`. */
  sharpen?: number;
  /** Exposed scene value (max channel) where bloom starts, and the width of its soft knee. Defaults 1.0 / 0.5. */
  bloomThreshold?: number;
  bloomKnee?: number;
  /** 0..1: how much of the bloom energy goes to the wide halo rather than the tight core. Default 0.7. */
  bloomScatter?: number;
}

export interface AutoExposureOptions {
  /** Mean scene luminance that maps to the key value: exposure = key / mean. Default 0.16. */
  key?: number;
  /** Exposure limits in stops (EV of the multiplier, log2). Defaults -3 / +3. */
  minEv?: number;
  maxEv?: number;
  /** Bias in stops added after metering. Default 0. */
  compensation?: number;
}

export interface PipelineStats {
  /** Scene draw calls / triangles of the last frame (post passes excluded). */
  drawCalls: number;
  triangles: number;
  /** Dynamic resolution scale in effect, 0.6..1. */
  resolutionScale: number;
  /** Smoothed interval between frames and its reciprocal. */
  frameMs: number;
  fps: number;
  /** Tier the auto-detection recommends for this device (not necessarily the one in use). */
  gpuTier: Quality;
  /** Smoothed CPU time spent inside render(), ms. */
  cpuMs: number;
  /** Internal (scene) resolution and canvas backing-store resolution, px. */
  width: number;
  height: number;
  outputWidth: number;
  outputHeight: number;
  /** MSAA samples in use (0 = FXAA path). */
  msaa: number;
  /** Auto exposure in use (GPU metered). */
  autoExposure: boolean;
  /** Full-screen post passes drawn last frame. */
  postPasses: number;
  /** Bytes of GPU memory held by the pipeline's targets (estimate). */
  targetBytes: number;
  gpuName: string;
  software: boolean;
}

export interface PipelineOptions {
  quality?: Quality | 'auto';
  targetFps?: number;
  /** Default: on, except under a software rasteriser (frame times are meaningless there). */
  dynamicResolution?: boolean;
}

export interface RenderPipeline {
  readonly renderer: THREE.WebGLRenderer;
  readonly quality: Quality;
  /**
   * Internal pixels per CSS pixel right now (tier cap × dynamic scale). Screen-space-sized visuals
   * (star points, line widths, sprites) multiply their CSS-pixel size by this.
   */
  readonly pixelRatio: number;
  /** Draw the layers in order into the HDR target, then run the post chain to the canvas. */
  render(layers: readonly RenderLayer[], dt: number): void;
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void;
  setQuality(q: Quality): void;
  /** Exposure in stops (EV). 0 = sun-lit white diffuse (1.0) lands just under display white (0.76 linear). */
  setExposure(ev: number): void;
  /**
   * Physically based auto exposure from the mean log luminance of the frame (metered and adapted on the GPU,
   * ~1 s, clamped). While on, setExposure is ignored for the image; it starts from the current manual value.
   */
  setAutoExposure(enabled: boolean, opts?: AutoExposureOptions): void;
  /** Fraction of the light above the bloom threshold that is scattered into the halo. Default 0.15; 0 = off. */
  setBloom(strength: number): void;
  setGrade(params: GradeParams): void;
  /** Screen-space accents, amount 0..1 (0 = off): jump stretch, damage vignette, heat haze, white flash. */
  setEffect(name: EffectName, amount: number): void;
  /**
   * Turn the frame-time controller on/off; when off the scale is held at `fixedScale` (0.6..1, default 1).
   * It stays off under a software rasteriser.
   */
  setDynamicResolution(enabled: boolean, fixedScale?: number): void;
  /**
   * Cap the MSAA samples below the tier's (memory: the ray tracer's buffers on top of 4x MSAA). Infinity = the
   * tier's own. Never recompiles (the composite only knows MSAA on or off); 0 switches to the FXAA path.
   */
  setMsaaLimit(samples: number): void;
  /** GPU bytes the targets would hold at full resolution (scale 1) with `samples` MSAA (estimate, as targetBytes). */
  targetBytesAt(samples: number): number;
  /** Live counters. Returns the same object every call — copy it if you keep it. */
  stats(): PipelineStats;
  onContextLost: (() => void) | null;
  onContextRestored: (() => void) | null;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------- tiers

interface Tier {
  /** Device-pixel-ratio cap. */
  dpr: number;
  msaa: number;
  chroma: boolean;
  sharpen: boolean;
  bloomHQ: boolean;
  maxBloomLevels: number;
}

const tierOf = (q: Quality): Tier => {
  const t = TIER_SETTINGS[q];
  return { dpr: t.dpr, msaa: t.msaa, chroma: t.chroma, sharpen: t.sharpen, bloomHQ: t.bloomHQ, maxBloomLevels: t.bloomLevels };
};
const TIERS: Record<Quality, Tier> = { low: tierOf('low'), medium: tierOf('medium'), high: tierOf('high'), ultra: tierOf('ultra') };
const LUM_SIZES = [128, 32, 8, 2];

const MIN_SCALE = 0.6;
const BLOOM_CLAMP = 64;
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

type Uniform<T> = { value: T };

function passMaterial(
  fragmentShader: string,
  uniforms: Record<string, THREE.IUniform>,
  extra?: THREE.ShaderMaterialParameters,
): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    ...extra,
  });
}

function colorTarget(type: THREE.TextureDataType, depth: boolean): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(1, 1, {
    type,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    generateMipmaps: false,
    depthBuffer: depth,
    stencilBuffer: false,
  });
}

/** three's XR hook for "render into this framebuffer"; public at runtime, missing from the typings. */
interface ExternalFramebufferHost {
  setRenderTargetFramebuffer(target: THREE.WebGLRenderTarget, framebuffer: WebGLFramebuffer): void;
}

// ---------------------------------------------------------------------------------------------- pipeline

class Pipeline implements RenderPipeline {
  readonly renderer: THREE.WebGLRenderer;
  onContextLost: (() => void) | null = null;
  onContextRestored: (() => void) | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly gpu: GpuInfo;
  private readonly hdrType: THREE.TextureDataType;
  private readonly dyn: DynamicResolution;

  private _quality: Quality;
  private tier: Tier;
  private msaaLimit = Infinity;
  private lost = false;
  private disposed = false;

  // sizes
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private outRatio = 1; // canvas px per CSS px
  private outW = 1;
  private outH = 1;
  private scale = 1;
  private sceneW = 1;
  private sceneH = 1;

  // scene target: a plain render target, or (MSAA) raw renderbuffers behind a proxy + a resolve target
  private msaa = 0;
  private readonly sceneRT: THREE.WebGLRenderTarget;
  private readonly msaaProxy: THREE.WebGLRenderTarget;
  private readonly resolveRT: THREE.WebGLRenderTarget;
  private msaaFbo: WebGLFramebuffer | null = null;
  private msaaColor: WebGLRenderbuffer | null = null;
  private msaaDepth: WebGLRenderbuffer | null = null;
  private readonly invalidateList: number[];

  // post targets
  private readonly bloomRT: THREE.WebGLRenderTarget[] = [];
  private bloomLevels = 0;
  private readonly downStep: THREE.Vector2[] = [];
  private readonly upStep: THREE.Vector2[] = [];
  private readonly ldrRT: THREE.WebGLRenderTarget;

  // full-screen pass plumbing
  private readonly fsGeometry: THREE.BufferGeometry;
  private readonly fsMesh: THREE.Mesh<THREE.BufferGeometry, THREE.RawShaderMaterial>;
  private readonly fsCamera: THREE.Camera;
  private readonly prefilterMat: THREE.RawShaderMaterial;
  private readonly downMat: THREE.RawShaderMaterial;
  private readonly upMat: THREE.RawShaderMaterial;
  private readonly compositeMat: THREE.RawShaderMaterial;
  private readonly fxaaMat: THREE.RawShaderMaterial;
  private readonly lumMat: THREE.RawShaderMaterial;
  private readonly reduceMat: THREE.RawShaderMaterial;
  private readonly adaptMat: THREE.RawShaderMaterial;

  // auto exposure
  private readonly lumRT: THREE.WebGLRenderTarget[] = [];
  private readonly adaptRT: THREE.WebGLRenderTarget[] = [];
  private adaptIdx = 0;
  private auto = false;
  private autoReset = true;
  private readonly uLumSrc: Uniform<THREE.Texture | null> = { value: null };
  private readonly uLumStep: Uniform<THREE.Vector2> = { value: new THREE.Vector2() };
  private readonly uRedSrc: Uniform<THREE.Texture | null> = { value: null };
  private readonly uRedStep: Uniform<THREE.Vector2> = { value: new THREE.Vector2() };
  private readonly uAdaptSrc: Uniform<THREE.Texture | null> = { value: null };
  private readonly uAdaptPrev: Uniform<THREE.Texture | null> = { value: null };
  private readonly uAdapt: Uniform<THREE.Vector4> = { value: new THREE.Vector4(Math.log2(0.16), -3, 3, 0) };
  private readonly uRate: Uniform<THREE.Vector4> = { value: new THREE.Vector4(0.05, 0.02, 1, 0) };
  private readonly uAdaptTex: Uniform<THREE.Texture | null> = { value: null };
  private readonly uAutoMix: Uniform<number> = { value: 0 };

  // uniforms (shared objects, mutated in place — nothing is allocated per frame)
  private readonly uPreSrc: Uniform<THREE.Texture | null> = { value: null };
  private readonly uPreStep: Uniform<THREE.Vector2> = { value: new THREE.Vector2() };
  private readonly uCurve: Uniform<THREE.Vector4> = { value: new THREE.Vector4() };
  private readonly uExposure: Uniform<number> = { value: 1 };
  private readonly uDownSrc: Uniform<THREE.Texture | null> = { value: null };
  private readonly uDownStep: Uniform<THREE.Vector2> = { value: new THREE.Vector2() };
  private readonly uUpSrc: Uniform<THREE.Texture | null> = { value: null };
  private readonly uUpStep: Uniform<THREE.Vector2> = { value: new THREE.Vector2() };
  private readonly uScatter: Uniform<number> = { value: 0.7 };
  private readonly uScene: Uniform<THREE.Texture | null> = { value: null };
  private readonly uBloomTex: Uniform<THREE.Texture | null> = { value: null };
  private readonly uSceneTexel: Uniform<THREE.Vector2> = { value: new THREE.Vector2(1, 1) };
  private readonly uBloomTexel: Uniform<THREE.Vector2> = { value: new THREE.Vector2(1, 1) };
  private readonly uOutSize: Uniform<THREE.Vector2> = { value: new THREE.Vector2(1, 1) };
  private readonly uTone: Uniform<THREE.Vector4> = { value: new THREE.Vector4(1, 0.15, 1, 1) };
  private readonly uLens: Uniform<THREE.Vector4> = { value: new THREE.Vector4(0.2, 0, 0, 0) };
  private readonly uShadowTint: Uniform<THREE.Vector3> = { value: new THREE.Vector3(1, 1, 1) };
  private readonly uHighTint: Uniform<THREE.Vector3> = { value: new THREE.Vector3(1, 1, 1) };
  private readonly uFx: Uniform<THREE.Vector4> = { value: new THREE.Vector4(0, 0, 0, 0) };
  private readonly uGrain: Uniform<THREE.Vector4> = { value: new THREE.Vector4(0, 1, 0, 0) };
  private readonly uLdr: Uniform<THREE.Texture | null> = { value: null };
  private readonly uLdrTexel: Uniform<THREE.Vector2> = { value: new THREE.Vector2(1, 1) };

  // look state
  private scatter = 0.7;
  private scatter0 = 0.7; // blend into the finest bloom level, see updateScatter0()
  private bloomTexelCss = 1; // size of a level-0 bloom texel, CSS px
  private exposureEv = 0;
  private bloomStrength = 0.15;
  private readonly grade = {
    contrast: 1.0,
    saturation: 1.04,
    shadowTint: [0.82, 0.97, 1.2] as [number, number, number],
    highlightTint: [1.08, 1.0, 0.88] as [number, number, number],
    split: 0.35,
    vignette: 0.2,
    grain: 0.025,
    aberration: 0.3,
    sharpen: 0.4,
    bloomThreshold: 1.0,
    bloomKnee: 0.5,
    bloomScatter: 0.7,
  };

  // timing / stats
  private time = 0;
  private frame = 0;
  private lastFrameAt = -1;
  private cpuMs = 0;
  private readonly statsOut: PipelineStats;

  constructor(canvas: HTMLCanvasElement, opts: PipelineOptions) {
    this.canvas = canvas;
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // AA is ours: MSAA on the HDR target or FXAA
      alpha: false,
      stencil: false,
      depth: false, // nothing 3D is ever drawn to the default framebuffer
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.renderer = renderer;
    renderer.setPixelRatio(1); // sizes are managed here, in backing-store pixels
    renderer.autoClear = false;
    renderer.info.autoReset = false;
    renderer.toneMapping = THREE.NoToneMapping; // tone mapping happens in the composite pass
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 1);

    const gl = renderer.getContext() as WebGL2RenderingContext;
    this.gl = gl;
    const floatTargets = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
    this.hdrType = floatTargets ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.gpu = detectGpu(gl, floatTargets);
    this.invalidateList = [gl.COLOR_ATTACHMENT0, gl.DEPTH_ATTACHMENT];

    const q = opts.quality === undefined || opts.quality === 'auto' ? this.gpu.tier : opts.quality;
    this._quality = q;
    this.tier = TIERS[q];
    this.dyn = new DynamicResolution({ targetFps: opts.targetFps ?? 60, minScale: MIN_SCALE, maxScale: 1, step: 0.05 });
    this.dyn.enabled = opts.dynamicResolution ?? !this.gpu.software;

    // targets (sized later)
    this.sceneRT = colorTarget(this.hdrType, true);
    this.msaaProxy = colorTarget(this.hdrType, true); // never initialised by three: stands in for our MSAA FBO
    this.resolveRT = colorTarget(this.hdrType, false);
    this.ldrRT = colorTarget(THREE.UnsignedByteType, false);

    // full-screen triangle
    this.fsGeometry = new THREE.BufferGeometry();
    this.fsGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.fsCamera = new THREE.Camera();
    this.fsCamera.matrixWorldAutoUpdate = false;

    this.prefilterMat = passMaterial(BLOOM_PREFILTER_FRAG, {
      tSrc: this.uPreSrc,
      uStep: this.uPreStep,
      uCurve: this.uCurve,
      uClamp: { value: BLOOM_CLAMP },
      uExposure: this.uExposure,
      tAdapt: this.uAdaptTex,
      uAutoMix: this.uAutoMix,
    });
    this.downMat = passMaterial(BLOOM_DOWN_FRAG, { tSrc: this.uDownSrc, uStep: this.uDownStep });
    this.upMat = passMaterial(
      BLOOM_UP_FRAG,
      { tSrc: this.uUpSrc, uStep: this.uUpStep, uScatter: this.uScatter },
      {
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.SrcAlphaFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.ZeroFactor,
        blendDstAlpha: THREE.OneFactor,
      },
    );
    this.compositeMat = passMaterial(COMPOSITE_FRAG, {
      tScene: this.uScene,
      tBloom: this.uBloomTex,
      uSceneTexel: this.uSceneTexel,
      uBloomTexel: this.uBloomTexel,
      uOutSize: this.uOutSize,
      uTone: this.uTone,
      uLens: this.uLens,
      uShadowTint: this.uShadowTint,
      uHighTint: this.uHighTint,
      uFx: this.uFx,
      uGrain: this.uGrain,
      tAdapt: this.uAdaptTex,
      uAutoMix: this.uAutoMix,
    });
    this.lumMat = passMaterial(LUM_FRAG, { tSrc: this.uLumSrc, uStep: this.uLumStep });
    this.reduceMat = passMaterial(REDUCE_FRAG, { tSrc: this.uRedSrc, uStep: this.uRedStep });
    this.adaptMat = passMaterial(ADAPT_FRAG, { tSrc: this.uAdaptSrc, tPrev: this.uAdaptPrev, uAdapt: this.uAdapt, uRate: this.uRate });
    // the metering chain: tiny half-float targets (log luminance is signed: never on the 8-bit fallback)
    for (const n of LUM_SIZES) {
      const rt = colorTarget(this.hdrType, false);
      rt.setSize(n, n);
      this.lumRT.push(rt);
    }
    for (let i = 0; i < 2; i++) {
      const rt = colorTarget(this.hdrType, false);
      rt.texture.minFilter = rt.texture.magFilter = THREE.NearestFilter;
      rt.setSize(1, 1);
      this.adaptRT.push(rt);
    }
    this.uAdaptTex.value = this.adaptRT[0].texture;
    this.fxaaMat = passMaterial(FXAA_FRAG, { tSrc: this.uLdr, uTexel: this.uLdrTexel, uGrain: this.uGrain });

    this.fsMesh = new THREE.Mesh(this.fsGeometry, this.compositeMat);
    this.fsMesh.frustumCulled = false;
    this.fsMesh.matrixAutoUpdate = false;
    this.fsMesh.matrixWorldAutoUpdate = false;

    this.statsOut = {
      drawCalls: 0,
      triangles: 0,
      resolutionScale: 1,
      frameMs: 1000 / (opts.targetFps ?? 60),
      fps: opts.targetFps ?? 60,
      gpuTier: this.gpu.tier,
      cpuMs: 0,
      width: 1,
      height: 1,
      outputWidth: 1,
      outputHeight: 1,
      msaa: 0,
      autoExposure: false,
      postPasses: 0,
      targetBytes: 0,
      gpuName: this.gpu.renderer,
      software: this.gpu.software,
    };

    canvas.addEventListener('webglcontextlost', this.handleContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored, false);

    this.applyGrade();
    this.configureTier();
    const w = canvas.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 0) || canvas.width || 1;
    const h = canvas.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 0) || canvas.height || 1;
    this.resize(w, h, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
    // Warm-up: one empty frame compiles every program of the chain (metering included) now rather than on
    // the first real frame: iOS stalls on a first-use compile.
    this.auto = this.hdrType === THREE.HalfFloatType;
    this.render(NO_LAYERS, 0);
    this.auto = false;
    this.autoReset = true;
    this.uAutoMix.value = 0;
    this.lastFrameAt = -1;
  }

  get quality(): Quality {
    return this._quality;
  }

  get pixelRatio(): number {
    return this.outRatio * this.scale;
  }

  // ------------------------------------------------------------------------------------------ setup

  /** Everything that depends on the tier but not on the size. */
  private configureTier(): void {
    const tier = this.tier;
    this.msaa = this.hdrType === THREE.HalfFloatType ? this.supportedSamples(Math.min(tier.msaa, this.msaaLimit)) : 0;
    this.applyDefines();
  }

  private applyDefines(): void {
    const tier = this.tier;
    const defines: Record<string, string> = {};
    if (this.msaa > 0) defines.FINAL = '';
    if (tier.chroma) defines.CHROMA = '';
    if (tier.sharpen) defines.SHARPEN = '';
    if (tier.bloomHQ) defines.BLOOM_HQ = '';
    this.compositeMat.defines = defines;
    this.compositeMat.needsUpdate = true;
  }

  /** Largest MSAA sample count ≤ `wanted` that RGBA16F renderbuffers support (0 = none). */
  private supportedSamples(wanted: number): number {
    if (wanted <= 0) return 0;
    const gl = this.gl;
    let best = 0;
    try {
      const list = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES) as Int32Array | null;
      if (list) for (let i = 0; i < list.length; i++) if (list[i] <= wanted && list[i] > best) best = list[i];
    } catch {
      best = 0;
    }
    return best;
  }

  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
    const cssW = Math.max(1, Math.round(cssWidth));
    const cssH = Math.max(1, Math.round(cssHeight));
    const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
    const ratio = Math.min(dpr, this.tier.dpr);
    const outW = Math.max(1, Math.round(cssW * ratio));
    const outH = Math.max(1, Math.round(cssH * ratio));
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    this.outRatio = ratio;
    // The CSS box is set from the caller's numbers and is never touched by the resolution controller.
    const style = this.canvas.style;
    if (style) {
      const sw = `${cssW}px`;
      const sh = `${cssH}px`;
      if (style.width !== sw) style.width = sw;
      if (style.height !== sh) style.height = sh;
    }
    if (outW === this.outW && outH === this.outH && this.bloomLevels > 0) return;
    this.outW = outW;
    this.outH = outH;
    this.renderer.setSize(outW, outH, false);
    this.uOutSize.value.set(outW, outH);
    this.uLdrTexel.value.set(1 / outW, 1 / outH);
    this.allocOutputTargets();
    this.allocSceneTarget();
    this.dyn.reset();
    this.lastFrameAt = -1;
  }

  setQuality(q: Quality): void {
    if (q === this._quality) return;
    this._quality = q;
    this.tier = TIERS[q];
    this.configureTier();
    this.outW = this.outH = 0; // force reallocation
    this.resize(this.cssW, this.cssH, this.dpr);
  }

  setMsaaLimit(samples: number): void {
    const lim = Number.isFinite(samples) ? Math.max(0, Math.floor(samples)) : Infinity;
    if (lim === this.msaaLimit) return;
    this.msaaLimit = lim;
    const before = this.msaa;
    this.configureTier();
    if (this.msaa === before) return;
    if (before > 0) this.releaseMsaa();
    this.outW = this.outH = 0; // force reallocation (the LDR target exists only on the FXAA path)
    this.resize(this.cssW, this.cssH, this.dpr);
  }

  targetBytesAt(samples: number): number {
    const px = this.outW * this.outH;
    const hdrBpp = this.hdrType === THREE.HalfFloatType ? 8 : 4;
    let bytes = samples > 0 ? px * (samples * (hdrBpp + 4) + hdrBpp) : px * (hdrBpp + 4) + px * 4;
    for (let i = 0; i < this.bloomLevels; i++) bytes += this.bloomRT[i].width * this.bloomRT[i].height * hdrBpp;
    return bytes + px * 4;
  }

  setDynamicResolution(enabled: boolean, fixedScale = 1): void {
    if (enabled) {
      // Never under a software rasteriser: its frame times would only drive the scale to the floor.
      this.dyn.enabled = !this.gpu.software;
      this.dyn.reset(this.scale); // the controller carries on from here, on its own grid
    } else {
      this.dyn.enabled = false;
      // an explicit fixed scale may be anything in range, not just a controller step
      this.setScale(Math.min(1, Math.max(MIN_SCALE, Number.isFinite(fixedScale) ? fixedScale : 1)));
    }
  }

  private setScale(s: number): void {
    if (s === this.scale) return;
    this.scale = s;
    this.allocSceneTarget();
  }

  /**
   * The bloom weights are anchored to physical size so every tier shows the same halo. The chain gives
   * level k the weight (1 - s) s^k. The reference chain starts at texels of 1 CSS px; a chain that
   * starts coarser (low-DPR canvases) begins further down that series: its first level stands for the
   * reference's first m = 1 + log2(texel size in CSS px) levels and keeps their combined weight.
   */
  private updateScatter0(): void {
    const m = Math.min(3, Math.max(1, 1 + Math.log2(this.bloomTexelCss)));
    this.scatter0 = Math.pow(this.scatter, m);
  }

  /** Bloom chain and the LDR intermediate: sized from the canvas, independent of the dynamic scale. */
  private allocOutputTargets(): void {
    // Level 0 has texels of 1 CSS px wherever the canvas is fine enough to feed it (>= 1.4 px per CSS px),
    // so medium, high and ultra build the very same chain; coarser canvases start at half their resolution.
    const perOutPx = this.outRatio >= 1.4 ? 1 / this.outRatio : 0.5;
    this.bloomTexelCss = 1 / (this.outRatio * perOutPx);
    const w0 = Math.max(1, Math.round(this.outW * perOutPx));
    const h0 = Math.max(1, Math.round(this.outH * perOutPx));
    // Levels are chosen so the coarsest one is ~12 texels across the short side on every tier: the halo
    // then covers the same fraction of the screen whatever the resolution.
    const short = Math.min(w0, h0);
    const levels = Math.min(this.tier.maxBloomLevels, Math.max(2, Math.round(Math.log2(Math.max(1, short / 12))) + 1));
    while (this.bloomRT.length < levels) {
      this.bloomRT.push(colorTarget(this.hdrType, false));
      this.downStep.push(new THREE.Vector2());
      this.upStep.push(new THREE.Vector2());
    }
    while (this.bloomRT.length > levels) {
      this.bloomRT.pop()?.dispose();
      this.downStep.pop();
      this.upStep.pop();
    }
    this.bloomLevels = levels;
    let w = w0;
    let h = h0;
    for (let i = 0; i < levels; i++) {
      this.bloomRT[i].setSize(w, h);
      this.downStep[i].set(0.5 / w, 0.5 / h); // half a texel of level i = one source texel of a 2:1 step
      if (i > 0) this.upStep[i - 1].set(1 / w, 1 / h); // one texel of level i, used when upsampling into i-1
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
    this.uBloomTexel.value.set(1 / w0, 1 / h0);
    this.updateScatter0();
    if (this.msaa === 0) this.ldrRT.setSize(this.outW, this.outH);
    else this.ldrRT.dispose();
  }

  /** The HDR scene target at the current dynamic scale. */
  private allocSceneTarget(): void {
    const w = Math.max(1, Math.round(this.outW * this.scale));
    const h = Math.max(1, Math.round(this.outH * this.scale));
    this.sceneW = w;
    this.sceneH = h;
    this.uSceneTexel.value.set(1 / w, 1 / h);
    if (this.msaa > 0 && !this.allocMsaa(w, h)) {
      // The driver refused the multisampled half-float framebuffer: fall back to the FXAA path for good.
      this.msaa = 0;
      this.releaseMsaa();
      this.applyDefines();
      this.ldrRT.setSize(this.outW, this.outH);
    }
    if (this.msaa > 0) {
      this.sceneRT.dispose();
    } else {
      this.releaseMsaa();
      this.sceneRT.setSize(w, h);
    }
  }

  private allocMsaa(w: number, h: number): boolean {
    if (this.lost) return true;
    const gl = this.gl;
    const r = this.renderer;
    if (!this.msaaFbo) {
      this.msaaFbo = gl.createFramebuffer();
      this.msaaColor = gl.createRenderbuffer();
      this.msaaDepth = gl.createRenderbuffer();
      if (!this.msaaFbo || !this.msaaColor || !this.msaaDepth) return false;
    }
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.msaaColor);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.msaa, gl.RGBA16F, w, h);
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.msaaDepth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.msaa, gl.DEPTH_COMPONENT24, w, h);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    // Framebuffer bindings go through three's state cache so it never disagrees with GL.
    r.state.bindFramebuffer(gl.FRAMEBUFFER, this.msaaFbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.msaaColor);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.msaaDepth);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    r.setRenderTarget(null);
    if (!ok) return false;
    this.msaaProxy.setSize(w, h);
    this.resolveRT.setSize(w, h);
    (r as unknown as ExternalFramebufferHost).setRenderTargetFramebuffer(this.msaaProxy, this.msaaFbo);
    return true;
  }

  private releaseMsaa(): void {
    const gl = this.gl;
    if (this.msaaFbo) {
      if (this.renderer.getRenderTarget() === this.msaaProxy) this.renderer.setRenderTarget(null);
      gl.deleteFramebuffer(this.msaaFbo);
    }
    if (this.msaaColor) gl.deleteRenderbuffer(this.msaaColor);
    if (this.msaaDepth) gl.deleteRenderbuffer(this.msaaDepth);
    this.msaaFbo = this.msaaColor = this.msaaDepth = null;
    this.resolveRT.dispose();
  }

  // ------------------------------------------------------------------------------------------ look

  setExposure(ev: number): void {
    this.exposureEv = Number.isFinite(ev) ? ev : 0;
    this.uTone.value.x = this.uExposure.value = Math.pow(2, this.exposureEv);
  }

  setAutoExposure(enabled: boolean, opts?: AutoExposureOptions): void {
    const on = enabled && this.hdrType === THREE.HalfFloatType;
    if (on && !this.auto) this.autoReset = true;
    this.auto = on;
    this.uAutoMix.value = on ? 1 : 0;
    if (opts) {
      const a = this.uAdapt.value;
      if (opts.key !== undefined && opts.key > 0) a.x = Math.log2(opts.key);
      if (opts.minEv !== undefined) a.y = opts.minEv;
      if (opts.maxEv !== undefined) a.z = opts.maxEv;
      if (opts.compensation !== undefined) a.w = opts.compensation;
    }
  }

  setBloom(strength: number): void {
    this.bloomStrength = Number.isFinite(strength) ? Math.max(0, strength) : 0;
    this.uTone.value.y = this.bloomStrength;
  }

  setGrade(params: GradeParams): void {
    const g = this.grade;
    if (params.contrast !== undefined) g.contrast = params.contrast;
    if (params.saturation !== undefined) g.saturation = params.saturation;
    if (params.shadowTint !== undefined) {
      g.shadowTint[0] = params.shadowTint[0];
      g.shadowTint[1] = params.shadowTint[1];
      g.shadowTint[2] = params.shadowTint[2];
    }
    if (params.highlightTint !== undefined) {
      g.highlightTint[0] = params.highlightTint[0];
      g.highlightTint[1] = params.highlightTint[1];
      g.highlightTint[2] = params.highlightTint[2];
    }
    if (params.split !== undefined) g.split = params.split;
    if (params.vignette !== undefined) g.vignette = params.vignette;
    if (params.grain !== undefined) g.grain = params.grain;
    if (params.aberration !== undefined) g.aberration = params.aberration;
    if (params.sharpen !== undefined) g.sharpen = params.sharpen;
    if (params.bloomThreshold !== undefined) g.bloomThreshold = params.bloomThreshold;
    if (params.bloomKnee !== undefined) g.bloomKnee = params.bloomKnee;
    if (params.bloomScatter !== undefined) g.bloomScatter = params.bloomScatter;
    this.applyGrade();
  }

  private applyGrade(): void {
    const g = this.grade;
    this.uExposure.value = Math.pow(2, this.exposureEv);
    this.uTone.value.set(this.uExposure.value, this.bloomStrength, Math.max(0.5, g.contrast), Math.max(0, g.saturation));
    const split = Math.min(1, Math.max(0, g.split));
    setTint(this.uShadowTint.value, g.shadowTint, split);
    setTint(this.uHighTint.value, g.highlightTint, split);
    const knee = Math.max(1e-3, g.bloomKnee);
    const thr = Math.max(0, g.bloomThreshold);
    this.uCurve.value.set(thr, thr - knee, 2 * knee, 0.25 / knee);
    this.scatter = Math.min(0.95, Math.max(0, g.bloomScatter));
    this.updateScatter0();
  }

  setEffect(name: EffectName, amount: number): void {
    const a = Number.isFinite(amount) ? Math.min(1, Math.max(0, amount)) : 0;
    const fx = this.uFx.value;
    if (name === 'jump') fx.x = a;
    else if (name === 'damage') fx.y = a;
    else if (name === 'heat') fx.z = a;
    else if (name === 'flash') fx.w = a;
  }

  // ------------------------------------------------------------------------------------------ frame

  render(layers: readonly RenderLayer[], dt: number): void {
    if (this.lost || this.disposed) return;
    const r = this.renderer;
    const now = performance.now();

    // Frame pacing -> dynamic resolution.
    if (this.lastFrameAt >= 0) {
      const s = this.dyn.update(now - this.lastFrameAt); // always fed: it also smooths the frame time for stats()
      if (this.dyn.enabled && s !== this.scale) this.setScale(s);
    }
    this.lastFrameAt = now;
    if (dt > 0 && dt < 1) this.time = (this.time + dt) % 3600;
    this.frame = (this.frame + 1) & 255;

    // ---- scene layers -> HDR target
    r.info.reset();
    const msaa = this.msaa > 0;
    const target = msaa ? this.msaaProxy : this.sceneRT;
    r.setRenderTarget(target);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      // A layer may have rendered shadow maps or other targets; three restores ours, but make sure.
      if (r.getRenderTarget() !== target) r.setRenderTarget(target);
      if (i > 0 && layer.clearDepth) r.clear(false, true, false);
      r.render(layer.scene, layer.camera);
    }
    const st = this.statsOut;
    st.drawCalls = r.info.render.calls;
    st.triangles = r.info.render.triangles;
    const sceneTex = msaa ? this.resolveMsaa() : this.sceneRT.texture;
    let passes = 0;

    // ---- auto exposure: meter this frame, adapt from the last (all on the GPU, no read-back)
    if (this.auto) {
      const lum = this.lumRT;
      this.uLumSrc.value = sceneTex;
      this.uLumStep.value.set(0.25 / LUM_SIZES[0], 0.25 / LUM_SIZES[0]);
      this.pass(this.lumMat, lum[0], true);
      for (let i = 1; i < lum.length; i++) {
        this.uRedSrc.value = lum[i - 1].texture;
        this.uRedStep.value.set(1 / LUM_SIZES[i - 1], 1 / LUM_SIZES[i - 1]);
        this.pass(this.reduceMat, lum[i], true);
      }
      const prev = this.adaptRT[this.adaptIdx];
      const next = this.adaptRT[1 - this.adaptIdx];
      const step = dt > 0 && dt < 0.5 ? dt : 1 / 60;
      const rate = this.uRate.value;
      rate.x = 1 - Math.exp(-step / 0.45); // stopping down (into the light) is quicker
      rate.y = 1 - Math.exp(-step / 1.1); // opening up (into the dark) takes about a second
      rate.z = this.autoReset ? 1 : 0;
      rate.w = this.exposureEv;
      this.autoReset = false;
      this.uAdaptSrc.value = lum[lum.length - 1].texture;
      this.uAdaptPrev.value = prev.texture;
      this.pass(this.adaptMat, next, true);
      this.adaptIdx = 1 - this.adaptIdx;
      this.uAdaptTex.value = next.texture;
      passes += lum.length + 1;
    }

    // ---- bloom
    const n = this.bloomLevels;
    const bloom = this.bloomRT;
    if (this.bloomStrength > 0) {
      this.uPreSrc.value = sceneTex;
      this.uPreStep.value.copy(this.downStep[0]);
      this.pass(this.prefilterMat, bloom[0], true);
      for (let i = 1; i < n; i++) {
        this.uDownSrc.value = bloom[i - 1].texture;
        this.uDownStep.value.copy(this.downStep[i]);
        this.pass(this.downMat, bloom[i], true);
      }
      for (let i = n - 2; i >= 0; i--) {
        this.uUpSrc.value = bloom[i + 1].texture;
        this.uUpStep.value.copy(this.upStep[i]);
        this.uScatter.value = i === 0 ? this.scatter0 : this.scatter;
        this.pass(this.upMat, bloom[i], false); // blends over the level already there
      }
      passes += 2 * n - 1;
    }

    // ---- composite (+ FXAA)
    const g = this.grade;
    const lens = this.uLens.value;
    lens.x = g.vignette;
    lens.y = g.aberration * this.outRatio;
    // Sharpen harder the more the scene is being magnified.
    lens.z = g.sharpen > 0 ? g.sharpen + (1 - this.scale) * 1.2 : 0;
    lens.w = this.time;
    this.uGrain.value.set(g.grain, Math.max(1, this.outRatio * 0.8), this.frame, 0);
    this.uScene.value = sceneTex;
    this.uBloomTex.value = bloom[0].texture;
    if (msaa) {
      this.pass(this.compositeMat, null, false);
      passes += 1;
    } else {
      this.pass(this.compositeMat, this.ldrRT, true);
      this.uLdr.value = this.ldrRT.texture;
      this.pass(this.fxaaMat, null, false);
      passes += 2;
    }

    st.postPasses = passes;
    this.cpuMs += (performance.now() - now - this.cpuMs) * 0.1;
  }

  /** One full-screen triangle into `target` (null = canvas). */
  private pass(material: THREE.RawShaderMaterial, target: THREE.WebGLRenderTarget | null, clear: boolean): void {
    const r = this.renderer;
    this.fsMesh.material = material;
    r.setRenderTarget(target);
    // Clearing tells a tile-based GPU it need not load the old contents of the target.
    if (clear) r.clear(true, false, false);
    r.render(this.fsMesh, this.fsCamera);
  }

  /** Resolve our MSAA framebuffer into the half-float resolve target, once per frame. */
  private resolveMsaa(): THREE.Texture {
    const gl = this.gl;
    const r = this.renderer;
    const rt = this.resolveRT;
    let props = r.properties.get(rt) as { __webglFramebuffer?: WebGLFramebuffer };
    if (props.__webglFramebuffer === undefined) {
      r.initRenderTarget(rt);
      props = r.properties.get(rt) as { __webglFramebuffer?: WebGLFramebuffer };
    }
    const state = r.state;
    state.setScissorTest(false);
    state.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msaaFbo);
    state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, props.__webglFramebuffer ?? null);
    gl.blitFramebuffer(0, 0, this.sceneW, this.sceneH, 0, 0, this.sceneW, this.sceneH, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    // Nothing reads the multisampled colour or depth again: let the GPU drop them instead of storing.
    gl.invalidateFramebuffer(gl.READ_FRAMEBUFFER, this.invalidateList);
    state.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    return rt.texture;
  }

  stats(): PipelineStats {
    const st = this.statsOut;
    st.resolutionScale = this.scale;
    st.frameMs = this.dyn.frameMs;
    st.fps = st.frameMs > 0 ? 1000 / st.frameMs : 0;
    st.cpuMs = this.cpuMs;
    st.width = this.sceneW;
    st.height = this.sceneH;
    st.outputWidth = this.outW;
    st.outputHeight = this.outH;
    st.msaa = this.msaa;
    st.autoExposure = this.auto;
    st.targetBytes = this.targetBytes();
    return st;
  }

  private targetBytes(): number {
    const scenePx = this.sceneW * this.sceneH;
    const hdrBpp = this.hdrType === THREE.HalfFloatType ? 8 : 4;
    // MSAA: colour + depth samples, plus the resolve texture. Otherwise colour + depth.
    let bytes = this.msaa > 0 ? scenePx * (this.msaa * (hdrBpp + 4) + hdrBpp) : scenePx * (hdrBpp + 4);
    for (let i = 0; i < this.bloomLevels; i++) bytes += this.bloomRT[i].width * this.bloomRT[i].height * hdrBpp;
    if (this.msaa === 0) bytes += this.outW * this.outH * 4;
    return bytes + this.outW * this.outH * 4; // canvas backing store
  }

  // ------------------------------------------------------------------------------------------ context

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault(); // allow restoration
    this.lost = true;
    this.onContextLost?.();
  };

  private readonly handleContextRestored = (): void => {
    // three's own listener (registered first) has already rebuilt its GL state; its render targets,
    // programs and buffers are recreated lazily. Only our raw GL objects have to be made again.
    this.lost = false;
    this.msaaFbo = this.msaaColor = this.msaaDepth = null;
    this.renderer.info.autoReset = false;
    this.renderer.setClearColor(0x000000, 1);
    this.configureTier();
    this.allocSceneTarget();
    this.dyn.reset();
    this.lastFrameAt = -1;
    this.autoReset = true;
    this.onContextRestored?.();
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost, false);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored, false);
    if (!this.lost) this.releaseMsaa();
    this.sceneRT.dispose();
    this.resolveRT.dispose();
    this.msaaProxy.dispose();
    this.ldrRT.dispose();
    for (const rt of this.bloomRT) rt.dispose();
    this.bloomRT.length = 0;
    this.prefilterMat.dispose();
    this.downMat.dispose();
    this.upMat.dispose();
    this.compositeMat.dispose();
    this.fxaaMat.dispose();
    this.lumMat.dispose();
    this.reduceMat.dispose();
    this.adaptMat.dispose();
    for (const rt of this.lumRT) rt.dispose();
    for (const rt of this.adaptRT) rt.dispose();
    this.fsGeometry.dispose();
    this.renderer.dispose();
  }
}

const NO_LAYERS: readonly RenderLayer[] = [];

/** Split-tone multiplier: the tint's chroma at unit luminance, blended toward neutral by `strength`. */
function setTint(out: THREE.Vector3, tint: readonly [number, number, number], strength: number): void {
  const l = Math.max(1e-4, tint[0] * LUMA_R + tint[1] * LUMA_G + tint[2] * LUMA_B);
  out.set(1 + (tint[0] / l - 1) * strength, 1 + (tint[1] / l - 1) * strength, 1 + (tint[2] / l - 1) * strength);
}

export function createPipeline(canvas: HTMLCanvasElement, opts: PipelineOptions = {}): RenderPipeline {
  return new Pipeline(canvas, opts);
}
