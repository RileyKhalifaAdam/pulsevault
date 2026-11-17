// Planets and moons: every non-star BodyClass, with atmosphere, clouds, oceans, city lights, lava and rings.
//
// How it is drawn
//   * ONE draw call per body. A quad covers the body on screen (a camera-facing billboard when the camera
//     is far, the whole screen when it is close or inside the air) and the fragment shader intersects the
//     unit sphere, the atmosphere shell and the ring plane analytically along the view ray, compositing them
//     front to back. The limb is therefore exactly round and anti-aliased at any distance, the atmosphere
//     has no shell geometry that could show an edge, it is right from afar / low orbit / inside the upper
//     air, and rings sort correctly against the globe without depth tricks. (shader: planet/body.glsl)
//   * All expensive procedural detail is baked once into cube maps by GPU render-to-texture
//     (planet/bake_*.glsl): elevation (RGBA16F, temporary) -> albedo + sea-level/gloss code (RGBA8) and
//     body-space normal + emissive mask (RGBA8); clouds (R8); giants bake a single albedo cube.
//     A small tiling detail texture (shared by all bodies) carries the surface from the baked texel
//     scale down to low orbit.
//   * LOD by apparent size: a body is baked at its tier's smallest cube (256 px per face; 512 on ultra) at
//     creation and re-baked at 512 / 1024 (quality permitting) when it grows on screen, one cube face per
//     update() so there is no long stall; it drops back when it shrinks, so only the one or two bodies the
//     player is close to hold big textures. Scatter steps and optional taps also scale with pixelRadius.
//     Texture memory per body at the top LOD of each tier (solid world with clouds / giant):
//     low 4.5 / 2 MiB, medium 18 / 8 MiB, high 66 / 32 MiB, ultra 72 / 32 MiB; every body at rest: 4.5 / 2.
//
// Conventions
//   * Unit sphere at the origin: radius 1 = def.radius. The scene manager only positions and uniformly
//     scales `object3d` (do not parent it under rotated nodes; a rotation of object3d itself is honoured).
//   * Spin axis = system +Y tilted by def.axialTilt toward +Z (the same convention as sim/universe.ts
//     bodySpinAxis); rings lie in the equatorial plane. Prograde spin at 2*pi/rotationPeriod from ctx.time.
//     A tidally locked *planet* (kind 'planet', so its parent is the star) keeps body +X on the sub-stellar
//     point; locked moons simply spin once per rotationPeriod, which is their orbital period.
//   * Atmosphere: the shell tops out at 1 + atmosphere.height / def.radius, clamped to 7..11 visual scale
//     heights; the visual scale height is 1.8 x the physical one, clamped to 0.3 %..1 % of the radius, so
//     a real (sub-pixel) air layer still reads as a thin luminous limb. That is the only exaggeration.
//   * Light units: sun-lit white diffuse = starColor * starIntensity (1.0 for a normally lit body).
//
// Output is premultiplied alpha into the HDR target (blend ONE, ONE_MINUS_SRC_ALPHA), depth test on,
// depth write off: bodies are sorted back to front by three.js like any transparent object.

import * as THREE from 'three';
import type { BodyClass, BodyDef, RGB, RingDef } from '../../core/types';
import { makeRng, type Rng } from '../../core/rng';
import NOISE_GLSL from './planet/noise.glsl';
import BAKE_HEIGHT_GLSL from './planet/bake_height.glsl';
import BAKE_SURFACE_GLSL from './planet/bake_surface.glsl';
import BAKE_GIANT_GLSL from './planet/bake_giant.glsl';
import BAKE_CLOUD_GLSL from './planet/bake_cloud.glsl';
import SCATTER_GLSL from './planet/scatter.glsl';
import BODY_GLSL from './planet/body.glsl';

export type Quality = 'low' | 'medium' | 'high' | 'ultra';

export interface BodyUpdateContext {
  /** Unit, world axes, from the body toward the star. */
  sunDir: THREE.Vector3;
  /** Linear star colour. */
  starColor: THREE.Color;
  /** Scales starColor; 1 = sun-lit white diffuse is 1.0. The scene manager folds eclipses in here. */
  starIntensity: number;
  /** Sim seconds. */
  time: number;
  /** Camera relative to the body centre, in units of body radius, world axes. */
  cameraPosLocal: THREE.Vector3;
  /** Apparent radius in device pixels (drives LOD). */
  pixelRadius: number;
}

export interface BodyVisualInfo {
  /** Cube-face resolution currently displayed. */
  resolution: number;
  /** True while a re-bake at another resolution is in progress. */
  busy: boolean;
  /** GPU texture memory held by this body right now, bytes (shared detail texture excluded). */
  textureBytes: number;
  /** CPU-side time spent submitting the last completed bake, ms (not a GPU timing). */
  bakeMs: number;
}

export interface BodyVisual {
  object3d: THREE.Object3D;
  update(ctx: BodyUpdateContext): void;
  dispose(): void;
  /** Diagnostics for harnesses and the debug overlay. */
  info(): BodyVisualInfo;
}

export interface BodyVisualOptions {
  /** Apparent radius (device px) expected on the first frame: bakes that LOD synchronously at creation. */
  initialPixelRadius?: number;
}

// ------------------------------------------------------------------------------------------------ tiers

interface Tier {
  /** Cube-face resolutions, smallest first; the body moves between them with apparent size. */
  levels: readonly number[];
  cloudMax: number;
  steps: number;
  detail: 0 | 1 | 2;
}

const TIERS: Record<Quality, Tier> = {
  low: { levels: [256], cloudMax: 256, steps: 6, detail: 1 },
  medium: { levels: [256, 512], cloudMax: 512, steps: 8, detail: 2 },
  high: { levels: [256, 512, 1024], cloudMax: 512, steps: 10, detail: 2 },
  ultra: { levels: [512, 1024], cloudMax: 1024, steps: 14, detail: 2 },
};
const MAX_STEPS = 16;

function pickLevel(tier: Tier, pixelRadius: number, current: number): number {
  let lvl = current;
  while (lvl + 1 < tier.levels.length && pixelRadius > tier.levels[lvl] * 0.6) lvl++;
  while (lvl > 0 && pixelRadius < tier.levels[lvl - 1] * 0.36) lvl--;
  return lvl;
}

const TAU = Math.PI * 2;
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const cubeBytes = (res: number, bpp: number, mips: boolean): number => Math.round(res * res * 6 * bpp * (mips ? 4 / 3 : 1));

// --------------------------------------------------------------------------------------- shared resources

const BAKE_VS = /* glsl */ `in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const BAKE_HEAD = /* glsl */ `precision highp float;
precision highp int;
uniform int uFace;
uniform float uRes;
out vec4 fragColor;
// GL cube-map face conventions, so a later texture(cube, dir) returns what was baked for dir.
vec3 cubeDir(int face, vec2 uv) {
  vec2 c = uv * 2.0 - 1.0;
  if (face == 0) return vec3(1.0, -c.y, -c.x);
  if (face == 1) return vec3(-1.0, -c.y, c.x);
  if (face == 2) return vec3(c.x, 1.0, c.y);
  if (face == 3) return vec3(c.x, -1.0, -c.y);
  if (face == 4) return vec3(c.x, -c.y, 1.0);
  return vec3(-c.x, -c.y, -1.0);
}
`;

interface Shared {
  refs: number;
  tri: THREE.BufferGeometry;
  scene: THREE.Scene;
  mesh: THREE.Mesh;
  camera: THREE.OrthographicCamera;
  detail: THREE.DataTexture;
}
let shared: Shared | null = null;

function acquireShared(): Shared {
  if (!shared) {
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(tri);
    mesh.frustumCulled = false;
    scene.add(mesh);
    shared = { refs: 0, tri, scene, mesh, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), detail: makeDetailTexture() };
  }
  shared.refs++;
  return shared;
}

function releaseShared(): void {
  if (!shared) return;
  if (--shared.refs <= 0) {
    shared.tri.dispose();
    shared.detail.dispose();
    shared = null;
  }
}

/**
 * Tiling 256x256 detail texture: rg = slope of a fractal height field, b = that height, a = billow noise.
 * Built on the CPU once (a few ms); sampled triplanar at two scales by the body shader.
 */
function makeDetailTexture(): THREE.DataTexture {
  const N = 256;
  const lattice = (ix: number, iy: number, period: number, seed: number): number => {
    const x = ((ix % period) + period) % period;
    const y = ((iy % period) + period) % period;
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1274126177)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
  // periodic gradient noise, about [-0.7, 0.7]
  const perlin = (x: number, y: number, period: number, seed: number): number => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const g = (cx: number, cy: number, dx: number, dy: number): number => {
      const a = lattice(cx, cy, period, seed) * TAU;
      return Math.cos(a) * dx + Math.sin(a) * dy;
    };
    const a = g(ix, iy, fx, fy);
    const b = g(ix + 1, iy, fx - 1, fy);
    const c = g(ix, iy + 1, fx, fy - 1);
    const d = g(ix + 1, iy + 1, fx - 1, fy - 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const height = new Float32Array(N * N);
  const billow = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N;
      const v = y / N;
      let h = 0;
      let r = 0;
      let bl = 0;
      let amp = 0.5;
      let f = 4;
      for (let o = 0; o < 5; o++) {
        const n = perlin(u * f, v * f, f, 11 + o);
        h += amp * n;
        r += amp * (1 - Math.min(Math.abs(n) * 2.4, 1));
        bl += amp * Math.abs(perlin(u * f * 1.25, v * f * 1.25, f * 1.25, 71 + o));
        amp *= 0.56;
        f *= 2;
      }
      height[y * N + x] = h * 0.75 + (r - 0.55) * 0.5;
      billow[y * N + x] = bl;
    }
  }
  const stats = (a: Float32Array): [number, number] => {
    let m = 0;
    for (let i = 0; i < a.length; i++) m += a[i];
    m /= a.length;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
    return [m, Math.sqrt(s / a.length)];
  };
  const [hm, hs] = stats(height);
  const [bm, bs] = stats(billow);
  const sx = new Float32Array(N * N);
  const sy = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const xm = (x + N - 1) % N;
      const xp = (x + 1) % N;
      const ym = (y + N - 1) % N;
      const yp = (y + 1) % N;
      sx[y * N + x] = height[y * N + xp] - height[y * N + xm];
      sy[y * N + x] = height[yp * N + x] - height[ym * N + x];
    }
  }
  const [, ss] = stats(sx);
  const data = new Uint8Array(N * N * 4);
  const enc = (val: number): number => Math.round(clamp(0.5 + val, 0, 1) * 255);
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = enc((sx[i] / ss) * 0.17);
    data[i * 4 + 1] = enc((sy[i] / ss) * 0.17);
    data[i * 4 + 2] = enc(((height[i] - hm) / hs) * 0.2);
    data[i * 4 + 3] = enc(((billow[i] - bm) / bs) * 0.2);
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** 1024x1 radial ring profile: rgb = sqrt(colour), a = relative optical depth. Zones, gaps, ringlets. */
function makeRingTexture(def: RingDef): THREE.DataTexture {
  const N = 1024;
  const rng = makeRng((def.seed ^ 0x51ed270b) >>> 0);
  const noiseSeed = rng.int(1, 1 << 20);
  const hash1 = (i: number, s: number): number => {
    let h = (Math.imul(i, 374761393) + Math.imul(s, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
  const n1 = (x: number, s: number): number => {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);
    return hash1(i, s) * (1 - u) + hash1(i + 1, s) * u;
  };
  const sstep = (a: number, b: number, x: number): number => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  // broad zones: faint inner ring, dense main ring, a division, a medium outer ring, a faint fringe
  const a = rng.range(0.14, 0.3);
  const b = rng.range(0.52, 0.68);
  const gap = rng.range(0.022, 0.05);
  const c = rng.range(0.86, 0.94);
  const tauIn = rng.range(0.06, 0.22);
  const tauMain = rng.range(0.7, 1.0);
  const tauOut = rng.range(0.32, 0.6);
  const tauFringe = rng.range(0.05, 0.2);
  const gaps: { u: number; w: number; d: number }[] = [];
  const ng = rng.int(7, 14);
  for (let i = 0; i < ng; i++) gaps.push({ u: rng.range(0.05, 0.97), w: rng.range(0.0015, 0.007), d: rng.range(0.5, 0.97) });
  gaps.push({ u: c - rng.range(0.03, 0.07), w: 0.006, d: 0.97 });
  const data = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    const u = (i + 0.5) / N;
    const e = 0.006;
    let env = tauIn * (1 - sstep(a - e, a + e, u));
    env += tauMain * sstep(a - e, a + e, u) * (1 - sstep(b - e * 0.5, b + e * 0.5, u));
    env += tauOut * sstep(b + gap - e * 0.5, b + gap + e * 0.5, u) * (1 - sstep(c - e, c + e, u));
    env += tauFringe * sstep(c - e, c + e, u);
    // ringlets: multi-scale radial structure, stronger in the dense ring
    const fine = (n1(u * 23, noiseSeed) - 0.5) * 0.5 + (n1(u * 71, noiseSeed + 1) - 0.5) * 0.45 + (n1(u * 211, noiseSeed + 2) - 0.5) * 0.4 + (n1(u * 520, noiseSeed + 3) - 0.5) * 0.3;
    let dens = env * clamp(0.9 + fine * 1.5, 0.12, 1.7);
    for (const g of gaps) {
      const d = (u - g.u) / g.w;
      dens *= 1 - g.d * Math.exp(-d * d);
    }
    dens *= sstep(0, 0.012, u) * (1 - sstep(0.985, 1, u));
    dens = clamp(dens, 0, 1);
    // colour: denser material is brighter and more neutral; the inner ring is darker and warmer
    const tone = 0.62 + 0.38 * sstep(0.05, 0.7, dens) + (n1(u * 9, noiseSeed + 7) - 0.5) * 0.18;
    const warm = 1 - sstep(a * 0.6, a * 1.4, u);
    const col: RGB = [
      clamp(def.color[0] * tone * (1 - 0.1 * warm), 0, 0.9),
      clamp(def.color[1] * tone * (1 - 0.2 * warm), 0, 0.9),
      clamp(def.color[2] * tone * (1 - 0.32 * warm), 0, 0.9),
    ];
    data[i * 4] = Math.round(Math.sqrt(col[0]) * 255);
    data[i * 4 + 1] = Math.round(Math.sqrt(col[1]) * 255);
    data[i * 4 + 2] = Math.round(Math.sqrt(col[2]) * 255);
    data[i * 4 + 3] = Math.round(dens * 255);
  }
  const tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------------------------------------------ recipe

type SolidClass = Exclude<BodyClass, 'star' | 'gasGiant' | 'iceGiant'>;
const CLS_ID: Record<SolidClass, number> = { barren: 0, rocky: 1, desert: 2, lava: 3, ice: 4, ocean: 5, terran: 6, eyeball: 7 };

const FALLBACK_PALETTE: Record<Exclude<BodyClass, 'star'>, RGB[]> = {
  barren: [[0.035, 0.032, 0.03], [0.13, 0.12, 0.11], [0.29, 0.27, 0.23], [0.55, 0.5, 0.42]],
  rocky: [[0.056, 0.022, 0.013], [0.17, 0.06, 0.03], [0.37, 0.14, 0.06], [0.6, 0.33, 0.17]],
  desert: [[0.09, 0.045, 0.017], [0.3, 0.13, 0.036], [0.55, 0.3, 0.095], [0.77, 0.6, 0.33]],
  lava: [[0.005, 0.003, 0.003], [0.018, 0.007, 0.005], [0.05, 0.014, 0.007], [0.16, 0.036, 0.01]],
  ice: [[0.2, 0.28, 0.38], [0.46, 0.56, 0.66], [0.71, 0.79, 0.86], [0.89, 0.92, 0.95]],
  ocean: [[0.003, 0.02, 0.058], [0.006, 0.06, 0.15], [0.024, 0.14, 0.24], [0.66, 0.61, 0.4]],
  terran: [[0.012, 0.04, 0.02], [0.044, 0.13, 0.037], [0.23, 0.23, 0.093], [0.46, 0.35, 0.19], [0.77, 0.74, 0.69]],
  eyeball: [[0.02, 0.017, 0.014], [0.037, 0.038, 0.023], [0.093, 0.063, 0.033], [0.24, 0.18, 0.098], [0.66, 0.6, 0.5]],
  gasGiant: [[0.55, 0.41, 0.23], [0.37, 0.2, 0.098], [0.75, 0.65, 0.45], [0.23, 0.13, 0.074], [0.66, 0.51, 0.3]],
  iceGiant: [[0.1, 0.43, 0.55], [0.19, 0.59, 0.66], [0.06, 0.3, 0.45], [0.36, 0.72, 0.76]],
};

interface Recipe {
  giant: boolean;
  cls: Exclude<BodyClass, 'star'>;
  clsId: number;
  seed: THREE.Vector3;
  palette: Float32Array;
  paletteN: number;
  rough: number;
  craters: number;
  lava: number;
  ice: number;
  city: number;
  locked: boolean;
  hasOcean: boolean;
  oceanLevel: number;
  oceanColor: RGB;
  hasClouds: boolean;
  cloudCover: number;
  cloudStyle: number;
  cloudColor: RGB;
  bands: number;
  storms: number;
  emissive: 0 | 1 | 2;
}

function buildRecipe(def: BodyDef): Recipe {
  if (def.cls === 'star') throw new Error('createBodyVisual: stars are drawn by createStarVisual');
  const cls = def.cls;
  const v = def.visual;
  const giant = cls === 'gasGiant' || cls === 'iceGiant';
  const src = v.palette && v.palette.length >= 2 ? v.palette : FALLBACK_PALETTE[cls];
  const paletteN = Math.min(src.length, 6);
  const palette = new Float32Array(18);
  for (let i = 0; i < 6; i++) {
    const c = src[Math.min(i, paletteN - 1)];
    palette[i * 3] = c[0];
    palette[i * 3 + 1] = c[1];
    palette[i * 3 + 2] = c[2];
  }
  const dflt = (x: number | undefined, d: number): number => (x === undefined || !Number.isFinite(x) ? d : clamp(x, 0, 1));
  const by = (m: Partial<Record<BodyClass, number>>, d: number): number => m[cls] ?? d;
  const hasAir = def.atmosphere !== null;
  const hasOcean = cls === 'terran' || cls === 'ocean' || cls === 'eyeball';
  const cloudCover = hasAir && !giant ? dflt(v.cloudCover, by({ terran: 0.5, ocean: 0.6, eyeball: 0.45, desert: 0.1, rocky: 0.03 }, 0)) : 0;
  const locked = def.tidallyLocked && def.kind === 'planet';
  const lava = dflt(v.lava, cls === 'lava' ? 0.8 : 0);
  const city = dflt(v.cityLights, 0);
  const s = v.seed >>> 0;
  return {
    giant,
    cls,
    clsId: giant ? -1 : CLS_ID[cls as SolidClass],
    seed: new THREE.Vector3(s & 0xffff, (s >>> 16) & 0xffff, (Math.imul(s, 2654435761) >>> 20) & 0xfff),
    palette,
    paletteN,
    rough: dflt(v.roughness, 0.5),
    craters: dflt(v.craters, by({ barren: 0.8, rocky: 0.35, desert: 0.1, lava: 0.1, ice: 0.25 }, 0)),
    lava,
    ice: dflt(v.ice, by({ ice: 1, terran: 0.18, ocean: 0.1, rocky: 0.12, eyeball: 0.55 }, 0)),
    city,
    locked,
    hasOcean,
    oceanLevel: dflt(v.oceanLevel, cls === 'ocean' ? 0.93 : cls === 'eyeball' ? 0.45 : 0.6),
    oceanColor: v.oceanColor ?? [0.004, 0.033, 0.098],
    hasClouds: cloudCover > 0.01,
    cloudCover,
    cloudStyle: cls === 'eyeball' || (locked && hasOcean) ? 1 : cls === 'desert' || cls === 'rocky' || cls === 'lava' || cls === 'ice' ? 2 : 0,
    cloudColor: v.cloudColor ?? [0.9, 0.9, 0.9],
    bands: clamp(v.bands ?? (cls === 'gasGiant' ? 12 : 6), 2, 28),
    storms: dflt(v.storms, cls === 'gasGiant' ? 0.5 : 0.2),
    emissive: cls === 'lava' ? 1 : city > 0.005 && !giant ? 2 : 0,
  };
}

function randomUnit(rng: Rng, latLo: number, latHi: number, out: Float32Array, o: number): number {
  const lat = rng.range(latLo, latHi) * (rng.chance(0.5) ? 1 : -1);
  const lon = rng.range(0, TAU);
  out[o] = Math.cos(lat) * Math.cos(lon);
  out[o + 1] = Math.sin(lat);
  out[o + 2] = Math.cos(lat) * Math.sin(lon);
  return lat;
}

// ---------------------------------------------------------------------------------------------- baking

interface Baked {
  res: number;
  albedo: THREE.WebGLCubeRenderTarget;
  normal: THREE.WebGLCubeRenderTarget | null;
  cloud: THREE.WebGLCubeRenderTarget | null;
  bytes: number;
}

interface BakeJob {
  steps: (() => void)[];
  next: number;
  out: Baked;
  temp: THREE.WebGLCubeRenderTarget[];
  ms: number;
  level: number;
}

function disposeBaked(b: Baked | null): void {
  if (!b) return;
  b.albedo.dispose();
  b.normal?.dispose();
  b.cloud?.dispose();
}

function cubeTarget(res: number, type: THREE.TextureDataType, format: THREE.PixelFormat, mips: boolean): THREE.WebGLCubeRenderTarget {
  const rt = new THREE.WebGLCubeRenderTarget(res, {
    type,
    format,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false, // switched on for the last face only, so mips are built once
    minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    colorSpace: THREE.NoColorSpace,
  });
  rt.texture.name = `planet-${res}`;
  return rt;
}

class Baker {
  private readonly sh: Shared;
  private readonly mats: THREE.RawShaderMaterial[] = [];
  private heightMat: THREE.RawShaderMaterial | null = null;
  private albedoMat: THREE.RawShaderMaterial | null = null;
  private normalMat: THREE.RawShaderMaterial | null = null;
  private giantMat: THREE.RawShaderMaterial | null = null;
  private cloudMat: THREE.RawShaderMaterial | null = null;
  private seaLevel: number | null = null;
  /** Cloudiness value above which the sky is covered, so that `cloudCover` of the globe is under cloud. */
  cloudThreshold = 0.5;
  private cloudThresholdKnown = false;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly rec: Recipe,
    private readonly tier: Tier,
  ) {
    this.sh = acquireShared();
  }

  private material(body: string, defines: Record<string, string | number>, uniforms: Record<string, THREE.IUniform>): THREE.RawShaderMaterial {
    const m = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: BAKE_VS,
      fragmentShader: `${BAKE_HEAD}\n${NOISE_GLSL}\n${body}`,
      defines,
      uniforms: { uFace: { value: 0 }, uRes: { value: 1 }, uSeedI: { value: this.rec.seed }, ...uniforms },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.mats.push(m);
    return m;
  }

  private ensureMaterials(): void {
    const r = this.rec;
    if (r.giant) {
      if (this.giantMat) return;
      const rng = makeRng((r.seed.x * 65536 + r.seed.y + 977) >>> 0);
      const centres = new Float32Array(32);
      const params = new Float32Array(32);
      const gas = r.cls === 'gasGiant';
      const n = r.storms <= 0.02 ? 0 : clamp(Math.round(1 + r.storms * 7), 1, 8);
      for (let i = 0; i < n; i++) {
        const big = i === 0;
        const lat = randomUnit(rng, big ? 0.2 : 0.3, big ? 0.48 : 1.05, centres, i * 4);
        centres[i * 4 + 3] = big ? rng.range(0.09, 0.15) * (0.6 + 0.8 * r.storms) : rng.range(0.025, 0.06);
        const type = big ? (gas ? 0 : 2) : rng.chance(0.6) ? 1 : 2;
        params[i * 4] = rng.range(2.5, 4.5) * (lat > 0 ? -1 : 1);
        params[i * 4 + 1] = type;
        params[i * 4 + 2] = big ? rng.range(1.5, 2.0) : rng.range(1.15, 1.6);
        params[i * 4 + 3] = big ? 0.9 : rng.range(0.6, 0.9);
      }
      this.giantMat = this.material(BAKE_GIANT_GLSL, {}, {
        uPal: { value: r.palette },
        uPalN: { value: r.paletteN },
        uBands: { value: r.bands },
        uTurb: { value: gas ? 0.65 + 0.7 * r.storms : 0.3 + 0.5 * r.storms },
        uContrast: { value: gas ? 1.0 : 0.5 },
        uStorm: { value: centres },
        uStormP: { value: params },
        uStormN: { value: n },
        uFine: { value: 1 },
      });
      return;
    }
    if (this.heightMat) return;
    const defines = { CLS: r.clsId };
    this.heightMat = this.material(BAKE_HEIGHT_GLSL, defines, {
      uRough: { value: r.rough },
      uCraters: { value: r.craters },
      uLavaAmt: { value: r.lava },
      uIce: { value: r.ice },
      uLocked: { value: r.locked ? 1 : 0 },
      uSeaLevel: { value: 0 },
      uPack: { value: 0 },
      uFine: { value: 1 },
    });
    const surfaceUniforms = (): Record<string, THREE.IUniform> => ({
      tHeight: { value: null },
      uPal: { value: r.palette },
      uPalN: { value: r.paletteN },
      uIce: { value: r.ice },
      uCity: { value: r.city },
      uNormalK: { value: 0.05 },
      uTexel: { value: 0.01 },
    });
    this.albedoMat = this.material(BAKE_SURFACE_GLSL, defines, surfaceUniforms());
    this.normalMat = this.material(BAKE_SURFACE_GLSL, { ...defines, OUT_NORMAL: 1 }, surfaceUniforms());
    if (r.hasClouds) {
      const rng = makeRng((r.seed.x * 65536 + r.seed.y + 4099) >>> 0);
      const centres = new Float32Array(32);
      const twist = new Float32Array(8);
      const n = r.cloudStyle === 0 ? rng.int(4, 7) : r.cloudStyle === 1 ? rng.int(2, 4) : 0;
      for (let i = 0; i < n; i++) {
        const lat = randomUnit(rng, 0.5, 1.1, centres, i * 4);
        if (r.cloudStyle === 1) {
          // on a locked world the storms ride the terminator ring, not the dry sub-stellar face
          const a = rng.range(0, TAU);
          const x = rng.range(0.0, 0.3);
          const rr = Math.sqrt(1 - x * x);
          centres[i * 4] = x;
          centres[i * 4 + 1] = rr * Math.cos(a);
          centres[i * 4 + 2] = rr * Math.sin(a);
        }
        centres[i * 4 + 3] = rng.range(0.11, 0.22);
        twist[i] = rng.range(2.4, 4.4) * (lat > 0 ? 1 : -1);
      }
      this.cloudMat = this.material(BAKE_CLOUD_GLSL, {}, {
        uStyle: { value: r.cloudStyle },
        uVortex: { value: centres },
        uVortexS: { value: twist },
        uVortexN: { value: n },
        uPack: { value: 0 },
      });
    }
  }

  /** Runs `fn` with the renderer's target / flags saved and restored. */
  private guarded(fn: () => void): void {
    const r = this.renderer;
    const oldTarget = r.getRenderTarget();
    const oldFace = r.getActiveCubeFace();
    const oldMip = r.getActiveMipmapLevel();
    const oldAutoClear = r.autoClear;
    const oldXr = r.xr.enabled;
    r.xr.enabled = false;
    r.autoClear = false;
    try {
      fn();
    } finally {
      r.setRenderTarget(oldTarget, oldFace, oldMip);
      r.autoClear = oldAutoClear;
      r.xr.enabled = oldXr;
    }
  }

  private face(target: THREE.WebGLCubeRenderTarget, face: number, mat: THREE.RawShaderMaterial, mips: boolean): void {
    mat.uniforms.uFace.value = face;
    mat.uniforms.uRes.value = target.width;
    mat.uniformsNeedUpdate = true;
    target.texture.generateMipmaps = mips && face === 5;
    this.sh.mesh.material = mat;
    this.renderer.setRenderTarget(target, face);
    this.renderer.render(this.sh.scene, this.sh.camera);
  }

  /**
   * Renders `mat` (in its uPack mode) into a small RGBA8 cube and returns the value below which `fraction`
   * of the sphere lies. `decode` turns a texel into the scalar. Texels are weighted by solid angle.
   */
  private quantile(mat: THREE.RawShaderMaterial, fraction: number, decode: (r: number, g: number) => number): number {
    const S = 64;
    const rt = cubeTarget(S, THREE.UnsignedByteType, THREE.RGBAFormat, false);
    const buf = new Uint8Array(S * S * 4);
    const BINS = 2048;
    const hist = new Float64Array(BINS);
    let total = 0;
    mat.uniforms.uPack.value = 1;
    for (let f = 0; f < 6; f++) {
      this.face(rt, f, mat, false);
      // three restores "the current target's framebuffer" after a read-back, which throws for a cube target
      this.renderer.setRenderTarget(null);
      this.renderer.readRenderTargetPixels(rt, 0, 0, S, S, buf, f);
      for (let y = 0; y < S; y++) {
        const b = ((y + 0.5) / S) * 2 - 1;
        for (let x = 0; x < S; x++) {
          const a = ((x + 0.5) / S) * 2 - 1;
          const w = Math.pow(1 + a * a + b * b, -1.5);
          const i = (y * S + x) * 4;
          const val = clamp(decode(buf[i], buf[i + 1]), 0, 0.99999);
          hist[Math.floor(val * BINS)] += w;
          total += w;
        }
      }
    }
    mat.uniforms.uPack.value = 0;
    rt.dispose();
    let acc = 0;
    const want = clamp(fraction, 0, 1) * total;
    for (let i = 0; i < BINS; i++) {
      acc += hist[i];
      if (acc >= want) return (i + 0.5) / BINS;
    }
    return 1;
  }

  /** Builds the list of bake steps for one resolution. Each step renders at most one cube face. */
  createJob(level: number): BakeJob {
    this.ensureMaterials();
    const res = this.tier.levels[level];
    const r = this.rec;
    const fine = res >= 1024 ? 1 : res >= 512 ? 0.5 : 0.25;
    const steps: (() => void)[] = [];
    const temp: THREE.WebGLCubeRenderTarget[] = [];
    const albedo = cubeTarget(res, THREE.UnsignedByteType, THREE.RGBAFormat, true);
    let bytes = cubeBytes(res, 4, true);
    const out: Baked = { res, albedo, normal: null, cloud: null, bytes: 0 };

    if (r.giant) {
      const mat = this.giantMat as THREE.RawShaderMaterial;
      for (let f = 0; f < 6; f++) {
        steps.push(() => {
          mat.uniforms.uFine.value = fine;
          this.face(albedo, f, mat, true);
        });
      }
    } else {
      const hm = this.heightMat as THREE.RawShaderMaterial;
      const am = this.albedoMat as THREE.RawShaderMaterial;
      const nm = this.normalMat as THREE.RawShaderMaterial;
      const height = cubeTarget(res, THREE.HalfFloatType, THREE.RGBAFormat, false);
      temp.push(height);
      const normal = cubeTarget(res, THREE.UnsignedByteType, THREE.RGBAFormat, true);
      out.normal = normal;
      bytes += cubeBytes(res, 4, true);
      steps.push(() => {
        hm.uniforms.uFine.value = 0.25;
        if (this.seaLevel === null) {
          // sea-level datum so that `oceanLevel` of the globe really is under water
          this.seaLevel = r.hasOcean ? this.quantile(hm, r.oceanLevel, (R, G) => (R + G / 255) / 255) * 2 - 1 : 0;
        }
        hm.uniforms.uSeaLevel.value = this.seaLevel;
      });
      for (let f = 0; f < 6; f++) {
        steps.push(() => {
          hm.uniforms.uFine.value = fine;
          this.face(height, f, hm, false);
        });
      }
      const texel = Math.PI / 2 / res;
      for (let f = 0; f < 6; f++) {
        steps.push(() => {
          am.uniforms.tHeight.value = height.texture;
          this.face(albedo, f, am, true);
        });
      }
      for (let f = 0; f < 6; f++) {
        steps.push(() => {
          nm.uniforms.tHeight.value = height.texture;
          nm.uniforms.uTexel.value = texel * 1.25;
          this.face(normal, f, nm, true);
        });
      }
      if (r.hasClouds && this.cloudMat) {
        const cm = this.cloudMat;
        const cres = Math.min(res, this.tier.cloudMax);
        const cloud = cubeTarget(cres, THREE.UnsignedByteType, THREE.RedFormat, true);
        out.cloud = cloud;
        bytes += cubeBytes(cres, 1, true);
        steps.push(() => {
          if (!this.cloudThresholdKnown) {
            this.cloudThreshold = this.quantile(cm, 1 - r.cloudCover, (R) => R / 255);
            this.cloudThresholdKnown = true;
          }
        });
        for (let f = 0; f < 6; f++) steps.push(() => this.face(cloud, f, cm, true));
      }
    }
    out.bytes = bytes;
    return { steps, next: 0, out, temp, ms: 0, level };
  }

  /** Runs up to `count` steps; returns true when the job is complete (temporaries are freed then). */
  run(job: BakeJob, count: number): boolean {
    const t0 = performance.now();
    this.guarded(() => {
      while (count-- > 0 && job.next < job.steps.length) job.steps[job.next++]();
    });
    job.ms += performance.now() - t0;
    if (job.next < job.steps.length) return false;
    for (const t of job.temp) t.dispose();
    job.temp.length = 0;
    return true;
  }

  abort(job: BakeJob): void {
    for (const t of job.temp) t.dispose();
    disposeBaked(job.out);
  }

  dispose(): void {
    for (const m of this.mats) m.dispose();
    this.mats.length = 0;
    releaseShared();
  }
}

// ---------------------------------------------------------------------------------------- runtime shader

const BODY_VS = /* glsl */ `precision highp float;
in vec3 position;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform mat4 modelMatrix;
uniform vec3 cameraPosition;
uniform vec3 uCamPosW;     // camera relative to the body centre, world axes, body radii
uniform mat3 uBodyRot;     // world -> body frame
uniform float uBound;      // bounding radius (air shell or rings), body radii
out vec3 vRay;
void main() {
  float d = length(uCamPosW);
  float S = length(modelMatrix[0].xyz);
  if (d < uBound * 1.3) {
    // close or inside: cover the screen, at the depth of the nearest surface point
    float dist = max(d - 1.0, 0.002) * S;
    float zn = (projectionMatrix[2][2] * -dist + projectionMatrix[3][2]) / dist;
    gl_Position = vec4(position.xy, clamp(zn, -0.9999, 0.9999), 1.0);
    vec3 dirV = vec3((position.x + projectionMatrix[2][0]) / projectionMatrix[0][0], (position.y + projectionMatrix[2][1]) / projectionMatrix[1][1], -1.0);
    vRay = uBodyRot * (transpose(mat3(viewMatrix)) * dirV);
  } else {
    // far: a billboard through the body centre, sized to the tangent cone of the bounding sphere
    vec3 f = -uCamPosW / d;
    vec3 up0 = abs(f.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 r = normalize(cross(f, up0));
    vec3 u = cross(r, f);
    float s = d * uBound / sqrt(d * d - uBound * uBound) * 1.03;
    vec3 rel = -uCamPosW + (r * position.x + u * position.y) * s;
    gl_Position = projectionMatrix * viewMatrix * vec4(cameraPosition + rel * S, 1.0);
    vRay = uBodyRot * rel;
  }
}`;

const BODY_FS_HEAD = /* glsl */ `precision highp float;
precision highp int;
precision mediump sampler2D;
precision mediump samplerCube;
`;

interface Air {
  shell: number;
  H: number;
  betaR: THREE.Vector3;
  betaE: THREE.Vector3;
  betaM: number;
  boost: number;
  sky: THREE.Vector3;
}

function buildAir(def: BodyDef, giant: boolean): Air | null {
  const a = def.atmosphere;
  if (!a || a.opacity <= 0.001) return null;
  const H = clamp((1.8 * a.scaleHeight) / def.radius, 0.003, 0.01);
  const shell = 1 + clamp(a.height / def.radius, 7 * H, 11 * H);
  const opacity = clamp(a.opacity, 0, 1);
  const tauV = 0.45 * opacity * (giant ? 0.55 : 1);
  const cm = Math.max(a.color[0], a.color[1], a.color[2], 1e-3);
  const tint = new THREE.Vector3(a.color[0] / cm, a.color[1] / cm, a.color[2] / cm);
  // Extinction: at least the scattering itself (albedo <= 1, so a thick limb saturates to the sky tint, not
  // to its complement), plus absorption in the channels the sunset colour lacks, so that long light paths
  // (the terminator, a star seen through the limb) end up sunset-coloured.
  const sm = Math.max(a.sunsetColor[0], a.sunsetColor[1], a.sunsetColor[2], 1e-3);
  const e = a.sunsetColor.map((c) => -Math.log(clamp(c / sm, 0.03, 1)));
  const em = Math.max(e[0], e[1], e[2], 1e-3);
  const shape = e.map((x) => (x / em) * (x / em));
  const iMin = shape.indexOf(Math.min(shape[0], shape[1], shape[2]));
  const iMax = shape.indexOf(Math.max(shape[0], shape[1], shape[2]));
  const t3 = [tint.x, tint.y, tint.z];
  const g = t3[iMin];
  const sc = Math.max(t3[iMax] - g, 0.8);
  const kR = tauV / H;
  const betaM = (0.13 * tauV * (0.5 + opacity)) / H;
  const ext = t3.map((t, c) => Math.max(t, g + sc * shape[c]) * kR + betaM);
  return {
    shell,
    H,
    betaR: tint.clone().multiplyScalar(kR),
    betaE: new THREE.Vector3(ext[0], ext[1], ext[2]),
    betaM,
    boost: 1 + 1.2 * opacity,
    sky: tint.clone().multiplyScalar(0.11 * Math.min(1, tauV * 4)),
  };
}

// --------------------------------------------------------------------------------------------- factory

/**
 * Builds the visual for a planet or moon. Bakes the lowest LOD synchronously (or the LOD for
 * `opts.initialPixelRadius`); see the file header for conventions.
 */
export function createBodyVisual(renderer: THREE.WebGLRenderer, def: BodyDef, quality: Quality, opts: BodyVisualOptions = {}): BodyVisual {
  const tier = TIERS[quality] ?? TIERS.medium;
  const rec = buildRecipe(def);
  const baker = new Baker(renderer, rec, tier);
  const sh = shared as Shared;
  const air = buildAir(def, rec.giant);
  const ring = def.rings && def.rings.outerRadius > def.rings.innerRadius && def.rings.opacity > 0.001 ? def.rings : null;
  const ringTex = ring ? makeRingTexture(ring) : null;
  const ringIn = ring ? ring.innerRadius / def.radius : 0;
  const ringOut = ring ? ring.outerRadius / def.radius : 0;

  // ---- per-class runtime look
  const cls = rec.cls;
  const pick = (m: Partial<Record<BodyClass, number>>, d: number): number => m[cls] ?? d;
  const regolith = pick({ barren: 0.6, rocky: 0.25, desert: 0.2, lava: 0.3, ice: 0.4 }, 0);
  const detailNormal = pick({ barren: 1.5, rocky: 1.4, desert: 1.0, lava: 1.3, ice: 0.7, ocean: 0.9, gasGiant: 1.0, iceGiant: 0.7 }, 1.1);
  const detailAlbedo = pick({ barren: 0.24, rocky: 0.22, desert: 0.18, lava: 0.3, ice: 0.1, gasGiant: 0.2, iceGiant: 0.12 }, 0.2);
  const gloss = pick({ ice: 0.55, desert: 0.3, rocky: 0.3, lava: 0.25 }, 0);
  const oc = rec.oceanColor;
  const cityGain = 2.5 + 5.5 * Math.sqrt(rec.city);

  const uniforms: Record<string, THREE.IUniform> = {
    uCamPosW: { value: new THREE.Vector3(0, 0, 3) },
    uBodyRot: { value: new THREE.Matrix3() },
    uBound: { value: Math.max(air ? air.shell : 1, ringOut, 1) * 1.01 },
    uCamPos: { value: new THREE.Vector3(0, 0, 3) },
    uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    uSunColor: { value: new THREE.Vector3(1, 1, 1) },
    uSteps: { value: tier.steps },
    uAtmo: { value: new THREE.Vector4(air ? air.shell : 1, air ? air.H : 0.005, 0.84, air ? air.boost : 1) },
    uBetaR: { value: air ? air.betaR : new THREE.Vector3() },
    uBetaE: { value: air ? air.betaE : new THREE.Vector3() },
    uBetaM: { value: air ? air.betaM : 0 },
    uSkyAmb: { value: air ? air.sky : new THREE.Vector3() },
    tAlbedo: { value: null },
    tNormal: { value: null },
    tCloud: { value: null },
    tDetail: { value: sh.detail },
    tRing: { value: ringTex },
    uSurf: { value: new THREE.Vector4(regolith, 0.0025, detailNormal, detailAlbedo) },
    uOceanDeep: { value: new THREE.Vector4(oc[0], oc[1], oc[2], 0.17) },
    uOceanShallow: { value: new THREE.Vector3(oc[0] * 1.6 + 0.012, oc[1] * 1.9 + 0.05, oc[2] * 1.5 + 0.055) },
    uCloud: { value: new THREE.Vector4(0.5, rec.cloudStyle === 2 ? 0.17 : 0.1, 0.0045, rec.cloudStyle === 2 ? clamp(0.25 + 2.5 * rec.cloudCover, 0.25, 0.6) : 0.97) },
    uCloudColor: { value: new THREE.Vector3(Math.min(rec.cloudColor[0], 0.86), Math.min(rec.cloudColor[1], 0.86), Math.min(rec.cloudColor[2], 0.86)) },
    uCloudRot: { value: new THREE.Vector4(1, 0, 1.0, 0) },
    uEmis: { value: new THREE.Vector4(1.0 * cityGain, 0.6 * cityGain, 0.27 * cityGain, 3 + 7 * rec.lava) },
    uRing: { value: new THREE.Vector4(ringIn, ringOut, ring ? 1 / (ringOut - ringIn) : 1, ring ? 3 * clamp(ring.opacity, 0, 1) : 0) },
    uLod: { value: new THREE.Vector4(0, 1, gloss, 0) },
  };

  const defines: Record<string, string | number> = { EMISSIVE: rec.emissive, DETAIL_LAYERS: tier.detail, MAX_SCATTER_STEPS: MAX_STEPS };
  if (rec.giant) defines.GIANT = 1;
  if (air) defines.HAS_ATMO = 1;
  if (rec.hasClouds) defines.HAS_CLOUDS = 1;
  if (rec.hasOcean) defines.HAS_OCEAN = 1;
  if (ring) defines.HAS_RINGS = 1;

  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: BODY_VS,
    fragmentShader: `${BODY_FS_HEAD}\n${SCATTER_GLSL}\n${BODY_GLSL}`,
    defines,
    uniforms,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });

  const quad = new THREE.BufferGeometry();
  quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  quad.setIndex([0, 1, 2, 0, 2, 3]);
  const mesh = new THREE.Mesh(quad, material);
  mesh.frustumCulled = false;
  mesh.name = `body:${def.id}`;
  const root = new THREE.Group();
  root.name = `planet:${def.id}`;
  root.add(mesh);

  // ---- baked textures and LOD state
  let level = opts.initialPixelRadius !== undefined ? pickLevel(tier, opts.initialPixelRadius, 0) : 0;
  let baked: Baked | null = null;
  let job: BakeJob | null = null;
  let lastBakeMs = 0;
  let disposed = false;

  const adopt = (j: BakeJob): void => {
    disposeBaked(baked);
    baked = j.out;
    level = j.level;
    lastBakeMs = j.ms;
    uniforms.tAlbedo.value = baked.albedo.texture;
    uniforms.tNormal.value = baked.normal ? baked.normal.texture : null;
    uniforms.tCloud.value = baked.cloud ? baked.cloud.texture : null;
    (uniforms.uCloud.value as THREE.Vector4).x = baker.cloudThreshold;
  };
  {
    const first = baker.createJob(level);
    baker.run(first, Infinity);
    adopt(first);
  }

  // ---- orientation
  const axis0 = new THREE.Vector3(0, Math.cos(def.axialTilt), Math.sin(def.axialTilt));
  const period = Math.abs(def.rotationPeriod) > 1 ? def.rotationPeriod : 86400;
  const phase0 = ((def.visual.seed >>> 0) % 3600) / 3600;
  const cloudPeriod = Math.abs(period) * 17;
  const yb = new THREE.Vector3();
  const xb = new THREE.Vector3();
  const zb = new THREE.Vector3();
  const x0 = new THREE.Vector3();
  const z0 = new THREE.Vector3();
  const frac = (x: number): number => x - Math.floor(x);

  const update = (ctx: BodyUpdateContext): void => {
    if (disposed) return;
    const sun = ctx.sunDir;
    yb.copy(axis0).applyQuaternion(root.quaternion);
    x0.set(1, 0, 0).applyQuaternion(root.quaternion);
    z0.crossVectors(x0, yb);
    if (rec.locked) {
      xb.copy(sun).addScaledVector(yb, -sun.dot(yb));
      if (xb.lengthSq() < 1e-8) xb.copy(x0);
      xb.normalize();
      zb.crossVectors(xb, yb);
    } else {
      const th = TAU * frac(ctx.time / period + phase0);
      const c = Math.cos(th);
      const s = Math.sin(th);
      xb.copy(x0).multiplyScalar(c).addScaledVector(z0, -s);
      zb.copy(x0).multiplyScalar(s).addScaledVector(z0, c);
    }
    (uniforms.uBodyRot.value as THREE.Matrix3).set(xb.x, xb.y, xb.z, yb.x, yb.y, yb.z, zb.x, zb.y, zb.z);

    const camW = uniforms.uCamPosW.value as THREE.Vector3;
    camW.copy(ctx.cameraPosLocal);
    const cl = camW.length();
    if (cl < 1.00002) {
      if (cl < 1e-6) camW.set(0, 0, 1.00002);
      else camW.multiplyScalar(1.00002 / cl);
    }
    (uniforms.uCamPos.value as THREE.Vector3).set(camW.dot(xb), camW.dot(yb), camW.dot(zb));
    (uniforms.uSunDir.value as THREE.Vector3).set(sun.dot(xb), sun.dot(yb), sun.dot(zb)).normalize();
    const k = ctx.starIntensity;
    (uniforms.uSunColor.value as THREE.Vector3).set(ctx.starColor.r * k, ctx.starColor.g * k, ctx.starColor.b * k);

    if (rec.hasClouds) {
      const cr = uniforms.uCloudRot.value as THREE.Vector4;
      if (rec.cloudStyle === 1) {
        // the sub-stellar cloud shield stays put on a locked world; it only breathes a little
        const wob = 0.05 * Math.sin(TAU * frac(ctx.time / cloudPeriod));
        cr.x = Math.cos(wob);
        cr.y = Math.sin(wob);
      } else {
        const a = TAU * frac(ctx.time / cloudPeriod);
        cr.x = Math.cos(a);
        cr.y = Math.sin(a);
      }
    }

    // ---- LOD
    const pr = ctx.pixelRadius;
    uniforms.uSteps.value = pr < 10 ? 3 : pr < 40 ? 5 : pr < 120 ? Math.max(6, tier.steps - 2) : tier.steps;
    const lod = uniforms.uLod.value as THREE.Vector4;
    lod.x = tier.detail > 0 && pr > 220 ? 1 : 0;
    lod.y = pr > 30 ? 1 : 0;

    const want = pickLevel(tier, pr, level);
    if (job && job.level !== want && want === level) {
      baker.abort(job);
      job = null;
    }
    if (!job && want !== level) job = baker.createJob(want);
    if (job) {
      if (baker.run(job, 1)) {
        adopt(job);
        job = null;
      }
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (job) baker.abort(job);
    job = null;
    disposeBaked(baked);
    baked = null;
    ringTex?.dispose();
    material.dispose();
    quad.dispose();
    baker.dispose();
    root.removeFromParent();
  };

  const info = (): BodyVisualInfo => ({
    resolution: baked ? baked.res : 0,
    busy: job !== null,
    textureBytes: (baked ? baked.bytes : 0) + (job ? job.out.bytes : 0) + (ringTex ? 1024 * 4 * 2 : 0),
    bakeMs: lastBakeMs,
  });

  return { object3d: root, update, dispose, info };
}
