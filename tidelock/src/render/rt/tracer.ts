// Hybrid ray-traced sunlight for the ship interior. See src/render/rt/index.ts for the integration contract.
//
// Per frame (render): G-buffer of the merged static ship mesh at reduced resolution (MRT, RGBA8 + float depth)
// → one trace pass (sun visibility over the star's disc, one-bounce sun GI, GGX reflections, near-field AO;
// every effect a uniform toggle, so tiers never recompile) → temporal accumulation reprojected in ship space
// (depth/normal rejection, neighbourhood clamp while moving, per-effect history caps) → à-trous (edge-aware,
// variance-steered). composite() then draws the same mesh at full resolution over the rasterised interior and
// adds sun direct (GGX + Lambert × traced visibility), sun bounce and reflections, in linear HDR.
import * as THREE from 'three';
import { buildPacked, measureWork, mergeStatic, TEX_W, type MergeOptions, type MergedScene, type TraceCounters } from './bvh';
import { createForwardUniforms, patchTreeForRt, type RtForwardUniforms } from './forward';
import { ATROUS_FRAG, COMPOSITE_FRAG, COMPOSITE_VERT, COPY_FRAG, DEPTH_FRAG, FULLSCREEN_VERT, GBUF_FRAG, GBUF_VERT, TEMPORAL_FRAG, TRACE_FRAG } from './glsl';

export type RtQuality = 'off' | 'low' | 'medium' | 'high' | 'ultra';
export const RT_TIERS: readonly RtQuality[] = ['off', 'low', 'medium', 'high', 'ultra'];

export interface RtSun {
  /** Unit direction to the star, ship-local axes. */
  dirShip: THREE.Vector3;
  /** Linear colour; colour × intensity = irradiance on a surface facing the star (three.js units). */
  color: THREE.Color;
  /** Angular radius of the star's disc as seen from the ship, rad (= asin(R / d)). */
  angularRadius: number;
  intensity: number;
}

export interface RtFrame {
  camera: THREE.Camera;
  /** World matrix of the ship's local frame (the interior root's matrixWorld). */
  shipMatrixWorld: THREE.Matrix4;
  sun: RtSun;
  /** Fallback for reflection rays that leave the ship (a cube in env axes), and how env axes relate to ship axes. */
  envMap?: THREE.CubeTexture | THREE.Texture | null;
  /** Ship → env axes (default: the rotation of shipMatrixWorld, i.e. the env is in world axes). */
  envRotation?: THREE.Matrix3;
  envIntensity?: number;
  /** Cabin lamps 0..1 (reflections and bounce hits see the baked lamp light scaled by this) and the display gain of the bake. */
  lamps?: number;
  bakedGain?: number;
  time: number;
  frame: number;
  /** Full-resolution size the composite target has (default: the renderer's drawing buffer). */
  width?: number;
  height?: number;
  /**
   * Raster keys (rooms) the forward pass draws this frame: the G-buffer draws only these (plus the untagged '').
   * Omitted: everything. Keys are what MergeOptions.rasterKey returned.
   */
  rooms?: readonly string[];
}

export interface RtEffects {
  sun: boolean;
  bounce: boolean;
  reflections: boolean;
  ao: boolean;
}

export interface RtStats {
  tier: RtQuality;
  /** Rays traced last frame (upper bound: every lit pixel, every glossy pixel). */
  rays: number;
  bvhNodes: number;
  triangles: number;
  /** Merge + BVH build + pack, ms (main thread, during setStaticScene). */
  buildMs: number;
  /** Estimated GPU time on an iPhone 15 (A16) at the current resolution and tier, ms. Model, not a measurement. */
  msGpuEstimate: number;
  /** Trace resolution. */
  width: number;
  height: number;
  /** GPU memory of the tracer's own textures and targets, bytes. */
  bytes: number;
  /** Frames accumulated at the centre pixel's history cap (0 after a reset). */
  frames: number;
  /** Why the tracer is off ('' when it runs). */
  disabled: string;
  /** Measured GPU time of the tracer's passes (EXT_disjoint_timer_query_webgl2), ms; -1 where the extension is missing. */
  msGpu: number;
  /** Draw calls and triangles of the tracer's own passes last frame (the room-culled G-buffer). */
  drawCalls: number;
  drawTriangles: number;
  /** Mean traversal work per ray, from JS rays over the built BVH (for the cost model). */
  work: { closest: TraceCounters; any: TraceCounters };
}

export interface RayTracer {
  /** Merge, build the BVH and upload. Meshes must be static in ship space: vertex_ship = shipSpace × mesh.matrixWorld × v. */
  setStaticScene(meshes: THREE.Mesh[], shipSpace: THREE.Matrix4, opts?: MergeOptions & { onProgress?: (f: number, label: string) => void }): Promise<void>;
  /** Compile every program (await from the loader). */
  compile(): Promise<void>;
  render(input: RtFrame): void;
  /**
   * Add the traced light to an HDR image. In place (hdrColor === target.texture, the target still holding the
   * interior pass's depth): exact visibility, dynamic objects keep their pixels. Otherwise hdrColor is copied
   * into target first and only the static mesh's own depth is used.
   */
  composite(hdrColor: THREE.Texture, target: THREE.WebGLRenderTarget): void;
  setQuality(tier: RtQuality): void;
  readonly quality: RtQuality;
  /** Per-effect switches on top of the tier (all true by default). */
  readonly effects: RtEffects;
  /** 0 final, 1 sun visibility, 2 bounce, 3 reflections, 4 AO, 5 sun direct only (debug, written over the image). */
  debugView: number;
  /** Is the traced sun in this frame (false: the forward pass must keep its own sun on the interior). */
  readonly active: boolean;
  /** Would render() produce a traced frame now (scene built, tier on, context alive, sun effect on)? Known before render(). */
  readonly willRun: boolean;
  /**
   * Uniforms of the forward-shader patch (forward.ts): render() fills them, skip() turns them off. The traced
   * light reaches the image only through materials patched with patchMaterials (before they compile).
   */
  readonly forward: RtForwardUniforms;
  /** Patch every lit material under `root` to take the traced light (call before the materials compile). */
  patchMaterials(root: THREE.Object3D): number;
  /** No traced frame this frame (outside the ship): the patched materials fall back to their own lights. */
  skip(): void;
  /** GPU memory a tier would hold at a full-resolution size (static scene + its targets), bytes. */
  bytesAt(tier: RtQuality, width: number, height: number): number;
  /** Restart accumulation (teleport, interior rebuilt). */
  resetHistory(): void;
  stats(): RtStats;
  /** GPU estimate for a tier at a full-resolution size (default iPhone 15 portrait, DPR 2). */
  estimate(tier: RtQuality, width?: number, height?: number): { rays: number; ms: number };
  /** The highest tier whose estimate fits `budgetMs` (default 6) at iPhone 15 portrait, DPR 2. */
  recommendedTier(budgetMs?: number): RtQuality;
  dispose(): void;
}

interface TierDef {
  /** Fraction of the full-resolution pixel count traced. */
  pixels: number;
  fx: [number, number, number, number];
  passes: number;
  /** À-trous kernel radius: 1 = 3x3, 2 = 5x5. */
  radius: number;
}
const TIERS: Record<RtQuality, TierDef> = {
  off: { pixels: 0, fx: [0, 0, 0, 0], passes: 0, radius: 1 },
  low: { pixels: 0.25, fx: [1, 0, 0, 0], passes: 2, radius: 1 },
  medium: { pixels: 0.25, fx: [1, 1, 0, 0], passes: 3, radius: 2 },
  high: { pixels: 0.25, fx: [1, 1, 1, 0], passes: 3, radius: 2 },
  ultra: { pixels: 0.5, fx: [1, 1, 1, 1], passes: 4, radius: 2 },
};

// ---- GPU cost model (A16, 5-core GPU). Assumed effective throughput of divergent fragment-shader traversal:
// ~2.5 G node visits/s and ~3.3 G triangle tests/s for coherent rays (a node visit = 2 child boxes = 4 RGBA32F
// fetches; a triangle = 3 fetches), x1.6 for incoherent (bounce, reflection, AO) rays; texture-bound passes at
// ~50 G fetches/s. Calibrate against the perf overlay once it reports real RT timings.
const NS_NODE = 0.4;
const NS_TRI = 0.3;
const DIVERGENT = 1.6;
const NS_FETCH = 0.02;
const GLOSSY_FRACTION = 0.5; // share of pixels below the reflection roughness cut (for the estimate)
const IPHONE_W = 393 * 2;
const IPHONE_H = 852 * 2;
const REFL_MAX_ROUGH = 0.32;

const tri = new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]);

export function createRayTracer(renderer: THREE.WebGLRenderer, opts: { quality?: RtQuality } = {}): RayTracer {
  const gl = renderer.getContext();
  const floatOk = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
  let quality: RtQuality = opts.quality ?? 'low';
  const effects: RtEffects = { sun: true, bounce: true, reflections: true, ao: true };
  let lost = gl.isContextLost();
  let packed: MergedScene | null = null;
  let texNodes: THREE.DataTexture | null = null;
  let texTris: THREE.DataTexture | null = null;
  let texSurf: THREE.DataTexture | null = null;
  let buildMs = 0;
  let work = { closest: { nodes: 30, tris: 6 }, any: { nodes: 25, tris: 4 } };
  let valid = false; // a traced frame is ready for composite
  let disabled = floatOk ? '' : 'no float colour buffers (EXT_color_buffer_float/half_float)';

  // ---------------------------------------------------------------------------------------- passes
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const fsGeo = new THREE.BufferGeometry();
  fsGeo.setAttribute('position', new THREE.BufferAttribute(tri, 3));
  const raw = (frag: string, uniforms: Record<string, THREE.IUniform>, vert = FULLSCREEN_VERT): THREE.RawShaderMaterial =>
    new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: vert, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });
  const u = <T>(value: T): THREE.IUniform<T> => ({ value });

  const shared = {
    uNodes: u<THREE.Texture | null>(null),
    uTris: u<THREE.Texture | null>(null),
    uSurf: u<THREE.Texture | null>(null),
    uLamps: u(1),
    uBakedGain: u(1),
  };
  const uInvVP = u(new THREE.Matrix4());
  const uEye = u(new THREE.Vector3());
  const uSunDir = u(new THREE.Vector3(0, 1, 0));
  const uSunE = u(new THREE.Vector3());
  const uFx = u(new THREE.Vector4());
  const uSize = u(new THREE.Vector2(1, 1));

  const traceMat = raw(TRACE_FRAG, {
    ...shared,
    uInvVP, uEye, uSunDir, uSunE, uFx, uSize,
    uDepth: u<THREE.Texture | null>(null),
    uG0: u<THREE.Texture | null>(null),
    uG1: u<THREE.Texture | null>(null),
    uCosSun: u(Math.cos(0.0047)),
    uFrame: u(0),
    uEnv: u<THREE.Texture | null>(null),
    uEnvRot: u(new THREE.Matrix3()),
    uEnvGain: u(0),
    uClampL: u(10),
    uReflMaxRough: u(REFL_MAX_ROUGH),
    uAoRadius: u(0.45),
  });
  const temporalMat = raw(TEMPORAL_FRAG, {
    uInvVP, uEye, uSize,
    uRawA: u<THREE.Texture | null>(null),
    uRawB: u<THREE.Texture | null>(null),
    uDepth: u<THREE.Texture | null>(null),
    uG0: u<THREE.Texture | null>(null),
    uPrevDepth: u<THREE.Texture | null>(null),
    uPrevG0: u<THREE.Texture | null>(null),
    uHistA: u<THREE.Texture | null>(null),
    uHistB: u<THREE.Texture | null>(null),
    uHistM: u<THREE.Texture | null>(null),
    uPrevVP: u(new THREE.Matrix4()),
    uPrevInvVP: u(new THREE.Matrix4()),
    uCap: u(new THREE.Vector4(64, 256, 32, 64)),
    uMotion: u(0),
    uMinAlpha: u(0),
    uReset: u(1),
  });
  const atrousMat = raw(ATROUS_FRAG, {
    uInvVP, uEye, uSize,
    uInA: u<THREE.Texture | null>(null),
    uInB: u<THREE.Texture | null>(null),
    uAccA: u<THREE.Texture | null>(null),
    uAccB: u<THREE.Texture | null>(null),
    uM: u<THREE.Texture | null>(null),
    uDepth: u<THREE.Texture | null>(null),
    uG0: u<THREE.Texture | null>(null),
    uStep: u(1),
    uRadius: u(1),
    uVarScale: u(1),
    uReflMaxRough: u(REFL_MAX_ROUGH),
  });
  const copyMat = raw(COPY_FRAG, { uSrc: u<THREE.Texture | null>(null) });
  const gbufMat = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: GBUF_VERT, fragmentShader: GBUF_FRAG, side: THREE.DoubleSide });
  const depthMat = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: COMPOSITE_VERT, fragmentShader: DEPTH_FRAG, side: THREE.DoubleSide, colorWrite: false });
  const compMat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: COMPOSITE_VERT,
    fragmentShader: COMPOSITE_FRAG,
    side: THREE.DoubleSide,
    uniforms: {
      uInvVP, uEye, uSunDir, uSunE, uFx,
      uDenA: u<THREE.Texture | null>(null),
      uDenB: u<THREE.Texture | null>(null),
      uLowDepth: u<THREE.Texture | null>(null),
      uLowG0: u<THREE.Texture | null>(null),
      uLowSize: u(new THREE.Vector2(1, 1)),
      uTargetSize: u(new THREE.Vector2(1, 1)),
      uSunAng: u(0.0047),
      uReflMaxRough: u(REFL_MAX_ROUGH),
      uAoStrength: u(0.6),
      uDebug: u(0),
    },
    depthTest: true,
    depthWrite: false,
    depthFunc: THREE.LessEqualDepth,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.SrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const cu = compMat.uniforms;

  const fsMesh = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(fsGeo, traceMat);
  fsMesh.frustumCulled = false;
  const fsScene = new THREE.Scene();
  fsScene.add(fsMesh);
  fsScene.matrixWorldAutoUpdate = false;
  const shipMesh = (mat: THREE.Material): THREE.Mesh => {
    const m = new THREE.Mesh(fsGeo, mat);
    m.frustumCulled = false;
    m.matrixAutoUpdate = false;
    return m;
  };
  const gbufMesh = shipMesh(gbufMat);
  gbufMesh.material = [gbufMat]; // drawn by geometry groups: the visible rooms' runs of the raster index
  const depthMesh = shipMesh(depthMat);
  const compMesh = shipMesh(compMat);
  const gbufScene = new THREE.Scene();
  gbufScene.add(gbufMesh);
  const depthScene = new THREE.Scene();
  depthScene.add(depthMesh);
  const compScene = new THREE.Scene();
  compScene.add(compMesh);

  // ---------------------------------------------------------------------------------------- targets
  const halfOpts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false } as const;
  const mkG = (): THREE.WebGLRenderTarget => {
    const t = new THREE.WebGLRenderTarget(1, 1, { count: 2, type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true, generateMipmaps: false });
    t.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
    return t;
  };
  let gbuf: THREE.WebGLRenderTarget[] = [];
  let hist: THREE.WebGLRenderTarget[] = [];
  let rawT: THREE.WebGLRenderTarget | null = null;
  let denT: THREE.WebGLRenderTarget | null = null;
  let finalT: THREE.WebGLRenderTarget | null = null;
  let tw = 0;
  let th = 0;
  let cur = 0;
  let frames = 0;
  let resetPending = true;
  function ensureTargets(w: number, h: number): void {
    if (!rawT) {
      gbuf = [mkG(), mkG()];
      hist = [new THREE.WebGLRenderTarget(1, 1, { ...halfOpts, count: 3 }), new THREE.WebGLRenderTarget(1, 1, { ...halfOpts, count: 3 })];
      rawT = new THREE.WebGLRenderTarget(1, 1, { ...halfOpts, count: 2 });
      denT = new THREE.WebGLRenderTarget(1, 1, { ...halfOpts, count: 2 });
    }
    if (w === tw && h === th) return;
    tw = w;
    th = h;
    for (const t of [...gbuf, ...hist, rawT, denT!]) t.setSize(w, h);
    resetPending = true;
  }
  function disposeTargets(): void {
    for (const t of [...gbuf, ...hist, rawT, denT]) {
      if (!t) continue;
      t.depthTexture?.dispose();
      t.dispose();
    }
    gbuf = [];
    hist = [];
    rawT = denT = finalT = null;
    tw = th = 0;
  }

  // ---------------------------------------------------------------------------------------- per-frame state (preallocated)
  const viewShip = new THREE.Matrix4();
  const vp = new THREE.Matrix4();
  const prevVP = new THREE.Matrix4();
  const prevInvVP = new THREE.Matrix4();
  const invShip = new THREE.Matrix4();
  const shipM = new THREE.Matrix4();
  const eye = new THREE.Vector3();
  const prevEye = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const prevFwd = new THREE.Vector3(0, 0, -1);
  const prevSun = new THREE.Vector3(0, 1, 0);
  const sz = new THREE.Vector2();
  const clearC = new THREE.Color();
  const BLACK = new THREE.Color(0, 0, 0);
  let frameCam: THREE.Camera | null = null;
  let lastRays = 0;
  const statsObj: RtStats = { tier: quality, rays: 0, bvhNodes: 0, triangles: 0, buildMs: 0, msGpuEstimate: 0, width: 0, height: 0, bytes: 0, frames: 0, disabled, work, msGpu: -1, drawCalls: 0, drawTriangles: 0 };
  const fu = createForwardUniforms(REFL_MAX_ROUGH);
  // the room-culled G-buffer: the merged scene's raster index (interior triangles grouped by room)
  let rasterGeo: THREE.BufferGeometry | null = null;
  let rasterRanges: { key: string; start: number; count: number }[] = [];
  const groupPool: { start: number; count: number; materialIndex: number }[] = [];
  let rasterTris = 0;
  let sunWasOff = true;
  const viewToShip = new THREE.Matrix4();
  // GPU timing where the browser has it (desktop Chrome; iOS Safari does not)
  type TimerExt = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };
  let timer: TimerExt | null = null;
  try {
    timer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
  } catch {
    timer = null;
  }
  const gl2 = gl as WebGL2RenderingContext;
  const queries: { q: WebGLQuery; busy: boolean }[] = [];
  let activeQuery: { q: WebGLQuery; busy: boolean } | null = null;
  let gpuMs = -1;
  function timerBegin(): void {
    if (!timer || lost) return;
    let slot: { q: WebGLQuery; busy: boolean } | null = null;
    for (let i = 0; i < queries.length; i++) if (!queries[i].busy) slot = queries[i];
    if (!slot && queries.length < 4) {
      const q = gl2.createQuery();
      if (!q) return;
      slot = { q, busy: false };
      queries.push(slot);
    }
    if (!slot) return;
    gl2.beginQuery(timer.TIME_ELAPSED_EXT, slot.q);
    slot.busy = true;
    activeQuery = slot;
  }
  function timerEnd(): void {
    if (!timer || !activeQuery) return;
    gl2.endQuery(timer.TIME_ELAPSED_EXT);
    activeQuery = null;
  }
  function timerPoll(): void {
    if (!timer || lost) return;
    const disjoint = gl2.getParameter(timer.GPU_DISJOINT_EXT) as boolean;
    for (let i = 0; i < queries.length; i++) {
      const s = queries[i];
      if (!s.busy || s === activeQuery) continue;
      if (!gl2.getQueryParameter(s.q, gl2.QUERY_RESULT_AVAILABLE)) continue;
      const ns = gl2.getQueryParameter(s.q, gl2.QUERY_RESULT) as number;
      s.busy = false;
      if (disjoint) continue;
      const ms = ns / 1e6;
      gpuMs = gpuMs < 0 ? ms : gpuMs + (ms - gpuMs) * 0.1;
    }
  }

  const onLost = (e: Event): void => {
    e.preventDefault();
    lost = true;
    valid = false;
    fu.uRtOn.value = 0;
    queries.length = 0;
    activeQuery = null;
  };
  const onRestored = (): void => {
    lost = false;
    valid = false;
    try {
      timer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null; // extension objects die with the context
    } catch {
      timer = null;
    }
    gpuMs = -1;
    // three re-creates GL objects lazily; data textures need re-upload, history is gone
    for (const t of [texNodes, texTris, texSurf]) if (t) t.needsUpdate = true;
    disposeTargets();
    resetPending = true;
  };
  const canvas = renderer.domElement;
  canvas.addEventListener('webglcontextlost', onLost, false);
  canvas.addEventListener('webglcontextrestored', onRestored, false);

  const yieldFrame = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  function pass(mat: THREE.Material, target: THREE.WebGLRenderTarget | null): void {
    fsMesh.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(fsScene, ortho);
  }

  const fxv: [number, number, number, number] = [0, 0, 0, 0];
  function fx(): [number, number, number, number] {
    const t = TIERS[quality].fx;
    fxv[0] = t[0] && effects.sun ? 1 : 0;
    fxv[1] = t[1] && effects.bounce ? 1 : 0;
    fxv[2] = t[2] && effects.reflections ? 1 : 0;
    fxv[3] = t[3] && effects.ao ? 1 : 0;
    return fxv;
  }

  const est = { rays: 0, ms: 0 };
  /** Writes into a shared object (no allocation); copy the fields if you keep them. */
  function estimate(tier: RtQuality, width = IPHONE_W, height = IPHONE_H): { rays: number; ms: number } {
    const t = TIERS[tier];
    est.rays = 0;
    est.ms = 0;
    if (!t.pixels) return est;
    const px = Math.round(width * Math.sqrt(t.pixels)) * Math.round(height * Math.sqrt(t.pixels));
    const any = work.any.nodes * NS_NODE + work.any.tris * NS_TRI;
    const closest = work.closest.nodes * NS_NODE + work.closest.tris * NS_TRI;
    let rpp = 0;
    let ns = 0;
    if (t.fx[0]) { rpp += 1; ns += any; }
    if (t.fx[1]) { rpp += 2; ns += closest * DIVERGENT + any * 1.2; }
    if (t.fx[2]) { rpp += 2; ns += GLOSSY_FRACTION * (closest * DIVERGENT + any * 1.2); }
    if (t.fx[3]) { rpp += 1; ns += any * 0.5 * DIVERGENT; } // short rays
    // G-buffer + trace overhead + temporal (~40 fetches) + à-trous (~40 per pass) per traced pixel; composite at full res
    const fixedNs = NS_FETCH * (12 + 20 + 40 + (t.radius === 2 ? 100 : 40) * t.passes);
    const compNs = NS_FETCH * 24 + 0.15;
    est.rays = Math.round(px * rpp);
    est.ms = (px * (ns + fixedNs) + width * height * compNs) * 1e-6;
    return est;
  }

  /** Bytes per traced pixel: 2 G-buffers (2 x RGBA8 + float depth), 2 histories (3 x RGBA16F), raw and denoised (2 x RGBA16F). */
  const PX_BYTES = 2 * (8 + 4) + 2 * 24 + 16 + 16;
  function staticBytes(): number {
    let b = 0;
    if (texNodes) b += texNodes.image.width * texNodes.image.height * 16;
    if (texTris) b += texTris.image.width * texTris.image.height * 16;
    if (texSurf) b += texSurf.image.width * texSurf.image.height * 8;
    if (packed) b += packed.vertices * (12 + 12 + 8) + packed.triangles * 12 + rasterTris * 12;
    return b;
  }
  function bytes(): number {
    return staticBytes() + tw * th * PX_BYTES;
  }

  async function compile(): Promise<void> {
    if (lost) return;
    const cs = new THREE.Scene();
    for (const m of [traceMat, temporalMat, atrousMat, copyMat]) {
      const mesh = new THREE.Mesh(fsGeo, m);
      mesh.frustumCulled = false;
      cs.add(mesh);
    }
    const geo = rasterGeo ?? (packed ? packed.geometry : fsGeo);
    for (const m of [gbufMat, depthMat, compMat]) {
      const mesh = new THREE.Mesh(geo, m);
      mesh.frustumCulled = false;
      cs.add(mesh);
    }
    await renderer.compileAsync(cs, ortho);
  }

  const api: RayTracer = {
    effects,
    debugView: 0,
    get quality() {
      return quality;
    },
    get active() {
      return valid && quality !== 'off' && !disabled && fx()[0] === 1;
    },
    get willRun() {
      return !lost && quality !== 'off' && !!packed && !disabled && fx()[0] === 1;
    },
    forward: fu,
    patchMaterials(root) {
      return patchTreeForRt(root, fu);
    },
    skip() {
      valid = false;
      fu.uRtOn.value = 0;
      lastRays = 0;
    },
    bytesAt(tier, width, height) {
      const k = TIERS[tier].pixels;
      if (!k) return 0;
      const s = Math.sqrt(k);
      return staticBytes() + Math.round(width * s) * Math.round(height * s) * PX_BYTES;
    },

    async setStaticScene(meshes, shipSpace, o = {}) {
      const prog = o.onProgress ?? ((): void => undefined);
      prog(0, 'ray tracing: merge');
      await yieldFrame();
      const merged = mergeStatic(meshes, shipSpace, o);
      const raster = merged.raster;
      if (merged.geometry.index!.count < 3) throw new Error('rt: no opaque triangles in the static scene');
      prog(0.2, 'ray tracing: BVH');
      await yieldFrame();
      const p = buildPacked(merged.geometry, merged.surf, merged.ms);
      prog(0.7, 'ray tracing: upload');
      await yieldFrame();
      const maxT = renderer.capabilities.maxTextureSize;
      if (Math.max(p.nodeRows, p.triRows, p.surfRows) > maxT) throw new Error(`rt: BVH textures exceed ${maxT} rows`);
      const dt = (data: Float32Array | Uint16Array, rows: number, type: THREE.TextureDataType): THREE.DataTexture => {
        const t = new THREE.DataTexture(data, TEX_W, rows, THREE.RGBAFormat, type);
        t.minFilter = t.magFilter = THREE.NearestFilter;
        t.generateMipmaps = false;
        t.flipY = false;
        t.needsUpdate = true;
        return t;
      };
      texNodes?.dispose();
      texTris?.dispose();
      texSurf?.dispose();
      packed?.geometry.dispose();
      texNodes = dt(p.nodes, p.nodeRows, THREE.FloatType);
      texTris = dt(p.tris, p.triRows, THREE.FloatType);
      texSurf = dt(p.surf, p.surfRows, THREE.HalfFloatType);
      shared.uNodes.value = texNodes;
      shared.uTris.value = texTris;
      shared.uSurf.value = texSurf;
      depthMesh.geometry = compMesh.geometry = p.geometry;
      // the G-buffer draws the same vertices through the raster index, one group per run of visible rooms
      rasterGeo?.dispose();
      rasterGeo = new THREE.BufferGeometry();
      for (const name of ['position', 'normal', 'aSurf', 'aSurf2']) rasterGeo.setAttribute(name, p.geometry.getAttribute(name));
      rasterGeo.setIndex(new THREE.BufferAttribute(raster.index, 1));
      rasterRanges = [];
      for (const [key, [start, count]] of raster.ranges) rasterRanges.push({ key, start, count });
      rasterRanges.sort((x, y) => x.start - y.start);
      while (groupPool.length < rasterRanges.length + 1) groupPool.push({ start: 0, count: 0, materialIndex: 0 });
      rasterTris = raster.index.length / 3;
      gbufMesh.geometry = rasterGeo;
      packed = p;
      buildMs = p.mergeMs + p.buildMs + p.packMs;
      const w = measureWork(p, 1024);
      work = { closest: w.closest, any: w.any };
      statsObj.work = work;
      resetPending = true;
      valid = false;
      prog(0.85, 'ray tracing: shaders');
      await compile();
      prog(1, 'ray tracing: ready');
    },

    compile,

    render(input) {
      valid = false;
      fu.uRtOn.value = 0;
      statsObj.drawCalls = 0;
      statsObj.drawTriangles = 0;
      timerPoll();
      if (lost || quality === 'off' || !packed || disabled) {
        lastRays = 0;
        return;
      }
      const tier = TIERS[quality];
      let W = input.width ?? 0;
      let H = input.height ?? 0;
      if (!W || !H) {
        renderer.getDrawingBufferSize(sz);
        W = sz.x;
        H = sz.y;
      }
      const k = Math.sqrt(tier.pixels);
      ensureTargets(Math.max(1, Math.round(W * k)), Math.max(1, Math.round(H * k)));
      const cam = input.camera;
      frameCam = cam;
      cam.updateMatrixWorld();
      shipM.copy(input.shipMatrixWorld);
      gbufMesh.matrix.copy(shipM);
      gbufMesh.matrixWorld.copy(shipM);
      depthMesh.matrix.copy(shipM);
      depthMesh.matrixWorld.copy(shipM);
      compMesh.matrix.copy(shipM);
      compMesh.matrixWorld.copy(shipM);
      viewShip.multiplyMatrices(cam.matrixWorldInverse, shipM);
      vp.multiplyMatrices(cam.projectionMatrix, viewShip);
      uInvVP.value.copy(vp).invert();
      invShip.copy(shipM).invert();
      eye.setFromMatrixPosition(cam.matrixWorld).applyMatrix4(invShip);
      fwd.set(0, 0, -1).transformDirection(cam.matrixWorld).transformDirection(invShip);
      uEye.value.copy(eye);
      const sun = input.sun;
      uSunDir.value.copy(sun.dirShip).normalize();
      uSunE.value.set(sun.color.r * sun.intensity, sun.color.g * sun.intensity, sun.color.b * sun.intensity);
      const ang = Math.max(1e-4, sun.angularRadius);
      traceMat.uniforms.uCosSun.value = Math.cos(ang);
      cu.uSunAng.value = ang;
      const f = fx();
      // eclipse (or a star too faint to matter): no sun rays at all; the history restarts when it comes back
      const sunOff = uSunE.value.x + uSunE.value.y + uSunE.value.z < 1e-7;
      if (sunOff) f[0] = f[1] = 0;
      else if (sunWasOff) resetPending = true;
      sunWasOff = sunOff;
      uFx.value.set(f[0], f[1], f[2], f[3]);
      uSize.value.set(tw, th);
      shared.uLamps.value = input.lamps ?? 1;
      shared.uBakedGain.value = input.bakedGain ?? 1;
      const tu = traceMat.uniforms;
      tu.uFrame.value = input.frame | 0;
      const env = input.envMap ?? null;
      tu.uEnv.value = env && (env as THREE.CubeTexture).isCubeTexture ? env : null;
      tu.uEnvGain.value = tu.uEnv.value ? (input.envIntensity ?? 1) : 0;
      if (input.envRotation) (tu.uEnvRot.value as THREE.Matrix3).copy(input.envRotation);
      else (tu.uEnvRot.value as THREE.Matrix3).setFromMatrix4(shipM);
      const se = uSunE.value;
      const lumE = 0.2126 * se.x + 0.7152 * se.y + 0.0722 * se.z;
      tu.uClampL.value = Math.max(1e-3, 2 * (lumE / Math.PI) + 4 * (input.bakedGain ?? 1));

      // motion → history clamp; the sun turning in ship space (the ship rotating) → clamp too, and a minimum
      // blend weight, so a sun patch sliding over the floor leaves no trail
      const sunTurn = Math.acos(Math.min(1, Math.max(-1, uSunDir.value.dot(prevSun))));
      const moved = eye.distanceTo(prevEye) / 0.003 + Math.acos(Math.min(1, Math.max(-1, fwd.dot(prevFwd)))) / 0.002 + sunTurn / (ang * 0.25);
      const reset = resetPending;
      resetPending = false;

      // save renderer state
      const prevTarget = renderer.getRenderTarget();
      const prevAuto = renderer.autoClear;
      renderer.getClearColor(clearC);
      const prevAlpha = renderer.getClearAlpha();
      renderer.autoClear = false;
      timerBegin();
      const info = renderer.info.render;
      const calls0 = info.calls;
      const tris0 = info.triangles;

      const G = gbuf[cur];
      const Gp = gbuf[1 - cur];
      // 1. G-buffer: only the rooms the forward pass draws (runs of consecutive ranges merge into one draw)
      if (rasterGeo) {
        const rooms = input.rooms;
        let n = 0;
        let s0 = -1;
        let s1 = -1;
        for (let i = 0; i < rasterRanges.length; i++) {
          const r = rasterRanges[i];
          if (rooms && r.key !== '' && rooms.indexOf(r.key) < 0) continue;
          if (r.start === s1) s1 += r.count;
          else {
            if (s1 > s0) {
              groupPool[n].start = s0;
              groupPool[n].count = s1 - s0;
              n++;
            }
            s0 = r.start;
            s1 = r.start + r.count;
          }
        }
        if (s1 > s0) {
          groupPool[n].start = s0;
          groupPool[n].count = s1 - s0;
          n++;
        }
        const groups = rasterGeo.groups;
        groups.length = 0;
        for (let i = 0; i < n; i++) groups.push(groupPool[i]);
      }
      renderer.setRenderTarget(G);
      renderer.setClearColor(BLACK, 0);
      renderer.clear(true, true, false);
      renderer.render(gbufScene, cam);
      // 2. trace
      tu.uDepth.value = G.depthTexture;
      tu.uG0.value = G.textures[0];
      tu.uG1.value = G.textures[1];
      pass(traceMat, rawT);
      // 3. temporal
      const Hc = hist[cur];
      const Hp = hist[1 - cur];
      const mu = temporalMat.uniforms;
      mu.uRawA.value = rawT!.textures[0];
      mu.uRawB.value = rawT!.textures[1];
      mu.uDepth.value = G.depthTexture;
      mu.uG0.value = G.textures[0];
      mu.uPrevDepth.value = Gp.depthTexture;
      mu.uPrevG0.value = Gp.textures[0];
      mu.uHistA.value = Hp.textures[0];
      mu.uHistB.value = Hp.textures[1];
      mu.uHistM.value = Hp.textures[2];
      (mu.uPrevVP.value as THREE.Matrix4).copy(prevVP);
      (mu.uPrevInvVP.value as THREE.Matrix4).copy(prevInvVP);
      mu.uMotion.value = reset ? 0 : Math.min(1, moved);
      mu.uMinAlpha.value = reset ? 1 : Math.min(1, (sunTurn / ang) * 0.5);
      mu.uReset.value = reset ? 1 : 0;
      pass(temporalMat, Hc);
      frames = reset ? 1 : Math.min(frames + 1, 2048);
      // 4. à-trous: hist → den → raw → den ...
      const au = atrousMat.uniforms;
      au.uAccA.value = Hc.textures[0];
      au.uAccB.value = Hc.textures[1];
      au.uM.value = Hc.textures[2];
      au.uDepth.value = G.depthTexture;
      au.uG0.value = G.textures[0];
      au.uRadius.value = tier.radius;
      let src: THREE.WebGLRenderTarget = Hc;
      let dst: THREE.WebGLRenderTarget = denT!;
      for (let i = 0; i < tier.passes; i++) {
        au.uInA.value = src.textures[0];
        au.uInB.value = src.textures[1];
        au.uStep.value = 1 << i;
        au.uVarScale.value = Math.pow(0.25, i);
        pass(atrousMat, dst);
        src = dst;
        dst = dst === denT ? rawT! : denT!;
      }
      finalT = src;
      cu.uDenA.value = src.textures[0];
      cu.uDenB.value = src.textures[1];
      cu.uLowDepth.value = G.depthTexture;
      cu.uLowG0.value = G.textures[0];
      (cu.uLowSize.value as THREE.Vector2).set(tw, th);

      statsObj.drawCalls = info.calls - calls0;
      statsObj.drawTriangles = info.triangles - tris0;
      timerEnd();
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(clearC, prevAlpha);
      renderer.autoClear = prevAuto;

      // the forward-shader patch (forward.ts) reads the denoised signals at full resolution
      fu.uRtOn.value = 1;
      fu.uRtFx.value.set(f[0], f[1], f[2], f[3]);
      fu.uRtA.value = src.textures[0];
      fu.uRtB.value = src.textures[1];
      fu.uRtDepth.value = G.depthTexture;
      fu.uRtG0.value = G.textures[0];
      fu.uRtLow.value.set(tw, th);
      fu.uRtTarget.value.set(W, H);
      const pcam = cam as THREE.PerspectiveCamera;
      fu.uRtNF.value.set(pcam.near ?? 0.05, pcam.far ?? 80);
      const pe = cam.projectionMatrix.elements;
      fu.uRtProj.value.set(1 / pe[0], 1 / pe[5]);
      // star direction: ship → world → view
      fu.uRtSunDir.value.copy(uSunDir.value).transformDirection(shipM).transformDirection(cam.matrixWorldInverse);
      fu.uRtSunE.value.copy(uSunE.value);
      viewToShip.multiplyMatrices(invShip, cam.matrixWorld);
      fu.uRtViewToShip.value.setFromMatrix4(viewToShip);

      prevVP.copy(vp);
      prevInvVP.copy(uInvVP.value);
      prevEye.copy(eye);
      prevFwd.copy(fwd);
      prevSun.copy(uSunDir.value);
      cur = 1 - cur;
      valid = true;
      const px = tw * th;
      lastRays = px * (f[0] + 2 * f[1] + GLOSSY_FRACTION * (2 * f[2]) + f[3]);
    },

    composite(hdrColor, target) {
      const inPlace = target.texture === hdrColor;
      const prevTarget = renderer.getRenderTarget();
      const prevAuto = renderer.autoClear;
      renderer.autoClear = false;
      if (!inPlace) {
        copyMat.uniforms.uSrc.value = hdrColor;
        pass(copyMat, target);
      }
      if (valid && frameCam && quality !== 'off' && target.depthBuffer) {
        renderer.setRenderTarget(target);
        if (!inPlace) {
          renderer.clear(false, true, false);
          renderer.render(depthScene, frameCam);
        }
        (cu.uTargetSize.value as THREE.Vector2).set(target.width, target.height);
        cu.uDebug.value = api.debugView;
        compMat.blendDst = api.debugView ? THREE.ZeroFactor : THREE.SrcAlphaFactor;
        renderer.render(compScene, frameCam);
      }
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAuto;
    },

    setQuality(tier) {
      if (tier === quality) return;
      quality = tier;
      resetPending = true;
      valid = false;
      fu.uRtOn.value = 0;
      // off: give the targets back (about 35 MB at iPhone 15 portrait); the BVH stays for switching on again
      if (tier === 'off') disposeTargets();
    },

    resetHistory() {
      resetPending = true;
    },

    estimate,

    recommendedTier(budgetMs = 6) {
      let best: RtQuality = 'off';
      for (const t of RT_TIERS) if (t !== 'off' && estimate(t).ms <= budgetMs) best = t;
      return best;
    },

    stats() {
      const s = statsObj;
      s.tier = quality;
      s.rays = lastRays;
      s.bvhNodes = packed?.nodeCount ?? 0;
      s.triangles = packed?.triangles ?? 0;
      s.buildMs = buildMs;
      s.width = tw;
      s.height = th;
      s.msGpuEstimate = tw ? estimate(quality, Math.round(tw / Math.sqrt(TIERS[quality].pixels || 1)), Math.round(th / Math.sqrt(TIERS[quality].pixels || 1))).ms : 0;
      s.bytes = bytes();
      s.frames = frames;
      s.disabled = lost ? 'WebGL context lost' : disabled;
      s.msGpu = timer ? gpuMs : -1;
      return s;
    },

    dispose() {
      canvas.removeEventListener('webglcontextlost', onLost, false);
      canvas.removeEventListener('webglcontextrestored', onRestored, false);
      disposeTargets();
      texNodes?.dispose();
      texTris?.dispose();
      texSurf?.dispose();
      packed?.geometry.dispose();
      packed = null;
      rasterGeo?.dispose();
      rasterGeo = null;
      fu.uRtOn.value = 0;
      fsGeo.dispose();
      for (const m of [traceMat, temporalMat, atrousMat, copyMat, gbufMat, depthMat, compMat]) m.dispose();
      disabled = 'disposed';
    },
  };
  void finalT;
  return api;
}
