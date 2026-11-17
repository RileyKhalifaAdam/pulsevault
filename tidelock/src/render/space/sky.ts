// Deep-space sky: tens of thousands of individually sharp stars, a galactic band with dust lanes and one
// or two distant nebulae per sky seed.
//
// Cost at run time: two draw calls (one cube-mapped box, one THREE.Points), one cube fetch per pixel.
// Everything expensive (many-octave noise for the band, dust and nebulae) is evaluated exactly once, at
// creation, into an RGBA8 cube map:
//   rgb = sqrt(radiance)   (gamma-2 encoded, dithered, so dark gradients do not band)
//   a   = dust transmittance (the star points read it in the vertex shader, so stars thin out and redden
//         behind the dust lanes exactly where the baked haze is dark)
//
// The module also owns the small prefiltered environment (PMREM) the ships use for reflections: the sky plus
// an optional soft lobe for the star ("the star's light slot", see setStarLight).
//
// Shared helpers for star.ts live here too (noise GLSL, cube baking, black-body colour) so the dependency
// between the two files runs one way only.

import * as THREE from 'three';
import { makeRng, type Rng } from '../../core/rng';

export type Quality = 'low' | 'medium' | 'high' | 'ultra';

// ------------------------------------------------------------------------------------------------ shared

/**
 * Black-body chromaticity as linear sRGB, normalised so the largest channel is 1.
 * Planckian locus fit of Kim et al. (valid 1667 K .. 25000 K, clamped outside), CIE xy -> XYZ -> linear sRGB.
 * Writes into `out` and returns it.
 */
export function blackbodyLinearRGB(kelvin: number, out: [number, number, number]): [number, number, number] {
  const t = Math.min(25000, Math.max(1667, kelvin));
  const t2 = t * t;
  const t3 = t2 * t;
  let x: number;
  if (t <= 4000) x = -0.2661239e9 / t3 - 0.2343589e6 / t2 + 0.8776956e3 / t + 0.17991;
  else x = -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / t + 0.24039;
  const x2 = x * x;
  const x3 = x2 * x;
  let y: number;
  if (t <= 2222) y = -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683;
  else if (t <= 4000) y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
  else y = 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  const X = x / y;
  const Z = (1 - x - y) / y;
  let r = 3.2404542 * X - 1.5371385 - 0.4985314 * Z;
  let g = -0.969266 * X + 1.8760108 + 0.041556 * Z;
  let b = 0.0556434 * X - 0.2040259 + 1.0572252 * Z;
  r = Math.max(r, 0);
  g = Math.max(g, 0);
  b = Math.max(b, 0);
  const m = Math.max(r, g, b, 1e-6);
  out[0] = r / m;
  out[1] = g / m;
  out[2] = b / m;
  return out;
}

/**
 * Noise library shared by every bake shader in sky.ts / star.ts. Integer hashing only (no sin-fract), so
 * the result is identical on every GPU. GLSL ES 3.00, expects `precision highp float; precision highp int;`.
 */
export const NOISE_GLSL = /* glsl */ `
uint tlPcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
uint tlHash3(ivec3 p) {
  return tlPcg(uint(p.x) + tlPcg(uint(p.y) + tlPcg(uint(p.z))));
}
float tlH31(ivec3 p) {
  return float(tlHash3(p) >> 8u) * (1.0 / 16777216.0);
}
vec3 tlH33(ivec3 p) {
  uint h = tlHash3(p);
  return vec3(float(h & 1023u), float((h >> 10u) & 1023u), float((h >> 20u) & 1023u)) * (1.0 / 1023.0);
}
// Gradient noise, roughly [-1, 1].
float gnoise(vec3 p) {
  vec3 fl = floor(p);
  vec3 f = p - fl;
  ivec3 i = ivec3(fl);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dot(tlH33(i) * 2.0 - 1.0, f);
  float n100 = dot(tlH33(i + ivec3(1, 0, 0)) * 2.0 - 1.0, f - vec3(1.0, 0.0, 0.0));
  float n010 = dot(tlH33(i + ivec3(0, 1, 0)) * 2.0 - 1.0, f - vec3(0.0, 1.0, 0.0));
  float n110 = dot(tlH33(i + ivec3(1, 1, 0)) * 2.0 - 1.0, f - vec3(1.0, 1.0, 0.0));
  float n001 = dot(tlH33(i + ivec3(0, 0, 1)) * 2.0 - 1.0, f - vec3(0.0, 0.0, 1.0));
  float n101 = dot(tlH33(i + ivec3(1, 0, 1)) * 2.0 - 1.0, f - vec3(1.0, 0.0, 1.0));
  float n011 = dot(tlH33(i + ivec3(0, 1, 1)) * 2.0 - 1.0, f - vec3(0.0, 1.0, 1.0));
  float n111 = dot(tlH33(i + ivec3(1, 1, 1)) * 2.0 - 1.0, f - vec3(1.0, 1.0, 1.0));
  float nx00 = mix(n000, n100, u.x);
  float nx10 = mix(n010, n110, u.x);
  float nx01 = mix(n001, n101, u.x);
  float nx11 = mix(n011, n111, u.x);
  return mix(mix(nx00, nx10, u.y), mix(nx01, nx11, u.y), u.z) * 1.45;
}
// Fractal sum, roughly [-1, 1].
float fbm(vec3 p, int oct) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < oct; i++) {
    s += a * gnoise(p);
    p = p * 2.03 + vec3(17.31, 5.77, 11.13);
    a *= 0.5;
  }
  return s;
}
vec3 fbm3(vec3 p, int oct) {
  return vec3(fbm(p, oct), fbm(p + vec3(31.7, 13.3, 7.9), oct), fbm(p + vec3(5.1, 47.9, 23.3), oct));
}
// Ridged multifractal, 0..1: thin bright filaments.
float ridged(vec3 p, int oct) {
  float s = 0.0;
  float a = 0.5;
  float w = 1.0;
  for (int i = 0; i < oct; i++) {
    float n = 1.0 - abs(gnoise(p));
    n = clamp(n, 0.0, 1.0);
    n *= n;
    s += n * a * w;
    w = clamp(n * 1.8, 0.0, 1.0);
    p = p * 2.07 + vec3(9.17, 21.3, 3.71);
    a *= 0.5;
  }
  return s;
}
// Cellular noise: x = distance to the nearest feature point, y = to the second nearest.
vec2 worley(vec3 p) {
  vec3 fl = floor(p);
  vec3 f = p - fl;
  ivec3 i = ivec3(fl);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int z = -1; z <= 1; z++) {
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        ivec3 o = ivec3(x, y, z);
        vec3 r = vec3(o) + tlH33(i + o) - f;
        float d = dot(r, r);
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
      }
    }
  }
  return sqrt(vec2(d1, d2));
}
// Direction of a cube-map texel (GL convention): st in [-1, 1].
vec3 tlFaceDir(int face, vec2 st) {
  if (face == 0) return vec3(1.0, -st.y, -st.x);
  if (face == 1) return vec3(-1.0, -st.y, st.x);
  if (face == 2) return vec3(st.x, 1.0, st.y);
  if (face == 3) return vec3(st.x, -1.0, -st.y);
  if (face == 4) return vec3(st.x, -st.y, 1.0);
  return vec3(-st.x, -st.y, -1.0);
}
`;

/** Vertex shader for a full-screen triangle (positions are already clip space). */
export const FULLSCREEN_VS = /* glsl */ `
precision highp float;
in vec3 position;
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

let fsTriangle: THREE.BufferGeometry | null = null;
let fsUsers = 0;

/** One shared full-screen triangle; release with releaseFullscreenTriangle(). */
export function acquireFullscreenTriangle(): THREE.BufferGeometry {
  if (!fsTriangle) {
    fsTriangle = new THREE.BufferGeometry();
    fsTriangle.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    fsTriangle.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  }
  fsUsers++;
  return fsTriangle;
}

export function releaseFullscreenTriangle(): void {
  if (--fsUsers <= 0 && fsTriangle) {
    fsTriangle.dispose();
    fsTriangle = null;
    fsUsers = 0;
  }
}

const bakeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const bakeScene = new THREE.Scene();
const bakeMesh = new THREE.Mesh(undefined, undefined);
bakeMesh.frustumCulled = false;
bakeScene.add(bakeMesh);
bakeScene.matrixAutoUpdate = false;

/**
 * Render `material` (a full-screen RawShaderMaterial with an `int uFace` uniform) into the six faces of a
 * cube render target. Renderer state (target, auto-clear, XR) is restored afterwards.
 */
export function bakeCubeFaces(renderer: THREE.WebGLRenderer, target: THREE.WebGLCubeRenderTarget, material: THREE.RawShaderMaterial): void {
  const oldTarget = renderer.getRenderTarget();
  const oldFace = renderer.getActiveCubeFace();
  const oldMip = renderer.getActiveMipmapLevel();
  const oldAutoClear = renderer.autoClear;
  const oldXr = renderer.xr.enabled;
  renderer.xr.enabled = false;
  renderer.autoClear = false;
  const tri = acquireFullscreenTriangle();
  bakeMesh.geometry = tri;
  bakeMesh.material = material;
  for (let face = 0; face < 6; face++) {
    material.uniforms.uFace.value = face;
    material.uniformsNeedUpdate = true;
    renderer.setRenderTarget(target, face);
    renderer.render(bakeScene, bakeCamera);
  }
  renderer.setRenderTarget(oldTarget, oldFace, oldMip);
  renderer.autoClear = oldAutoClear;
  renderer.xr.enabled = oldXr;
  releaseFullscreenTriangle();
}

// ------------------------------------------------------------------------------------------- sky recipe

const SKY_MAX = 1.0; // radiance that maps to 1.0 in the gamma-2 encoded cube

interface NebulaSpec {
  dir: THREE.Vector3;
  /** Angular radius, rad. */
  size: number;
  /** 1 emission region, 2 supernova remnant, 3 dark cloud with reflection glow. */
  type: number;
  seed: number;
  intensity: number;
  /** 0 = hydrogen red dominated, 1 = oxygen teal dominated. */
  mix: number;
  x: THREE.Vector3;
  y: THREE.Vector3;
}

interface SkyRecipe {
  /** Galactic frame: gx toward the core, gy galactic north, gz completes the right-handed set. */
  gx: THREE.Vector3;
  gy: THREE.Vector3;
  gz: THREE.Vector3;
  diskBright: number;
  bulgeBright: number;
  thickness: number;
  dust: number;
  bulgeL: number;
  bulgeB: number;
  cloudiness: number;
  noiseOffset: number;
  diskTint: [number, number, number];
  bulgeTint: [number, number, number];
  nebulae: NebulaSpec[];
  galaxies: { dir: THREE.Vector3; size: number; intensity: number; ratio: number; angle: number }[];
  clusters: { dir: THREE.Vector3; radius: number; count: number; temp: number }[];
}

function randomUnit(rng: Rng, out: THREE.Vector3): THREE.Vector3 {
  const z = rng.range(-1, 1);
  const a = rng.range(0, Math.PI * 2);
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  return out.set(s * Math.cos(a), z, s * Math.sin(a));
}

function tangentFrame(dir: THREE.Vector3, roll: number, x: THREE.Vector3, y: THREE.Vector3): void {
  const ref = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const a = new THREE.Vector3().crossVectors(ref, dir).normalize();
  const b = new THREE.Vector3().crossVectors(dir, a);
  x.copy(a).multiplyScalar(Math.cos(roll)).addScaledVector(b, Math.sin(roll));
  y.copy(b).multiplyScalar(Math.cos(roll)).addScaledVector(a, -Math.sin(roll));
}

/** Direction from galactic longitude / sine-latitude in the recipe's frame. */
function fromGalactic(r: SkyRecipe, lon: number, sinLat: number, out: THREE.Vector3): THREE.Vector3 {
  const c = Math.sqrt(Math.max(0, 1 - sinLat * sinLat));
  return out
    .set(0, 0, 0)
    .addScaledVector(r.gx, c * Math.cos(lon))
    .addScaledVector(r.gy, sinLat)
    .addScaledVector(r.gz, c * Math.sin(lon))
    .normalize();
}

function makeRecipe(skySeed: number): SkyRecipe {
  const rng = makeRng(`sky:${skySeed}`);
  const gy = randomUnit(rng, new THREE.Vector3());
  const tmp = randomUnit(rng, new THREE.Vector3());
  const gx = tmp.addScaledVector(gy, -tmp.dot(gy)).normalize();
  const gz = new THREE.Vector3().crossVectors(gx, gy).normalize();

  const warmth = rng.range(-1, 1);
  const recipe: SkyRecipe = {
    gx,
    gy,
    gz,
    diskBright: rng.range(0.03, 0.055),
    bulgeBright: rng.range(0.045, 0.085),
    thickness: rng.range(0.055, 0.1),
    dust: rng.range(0.7, 1.35),
    bulgeL: rng.range(0.22, 0.36),
    bulgeB: rng.range(0.13, 0.21),
    cloudiness: rng.range(0.65, 1),
    noiseOffset: rng.range(0, 90),
    diskTint: [0.8 + 0.06 * warmth, 0.87, 1.0 - 0.07 * warmth],
    bulgeTint: [1.0, 0.83 - 0.03 * warmth, 0.6 - 0.07 * warmth],
    nebulae: [],
    galaxies: [],
    clusters: [],
  };

  // One major nebula near the band (not buried in the core), often a second, smaller one elsewhere.
  const types = rng.shuffle([1, 2, 3]);
  const count = rng.chance(0.75) ? 2 : 1;
  for (let i = 0; i < count; i++) {
    const major = i === 0;
    const lon = (rng.chance(0.5) ? 1 : -1) * rng.range(major ? 0.5 : 0.3, major ? 2.3 : 3.0);
    const lat = (rng.chance(0.5) ? 1 : -1) * (major ? rng.range(0.03, 0.2) : rng.range(0.12, 0.5));
    const dir = fromGalactic(recipe, lon, lat, new THREE.Vector3());
    const type = types[i];
    const x = new THREE.Vector3();
    const y = new THREE.Vector3();
    tangentFrame(dir, rng.range(0, Math.PI * 2), x, y);
    let size = major ? rng.range(0.2, 0.33) : rng.range(0.09, 0.16);
    if (type === 2) size *= 0.7; // remnants are compact
    recipe.nebulae.push({
      dir,
      size,
      type,
      seed: rng.range(0, 60),
      intensity: (major ? 1 : 0.8) * rng.range(0.85, 1.15),
      mix: rng.range(0.15, 0.85),
      x,
      y,
    });
  }

  // A few faint external galaxies well off the plane.
  const ng = rng.int(1, 3);
  for (let i = 0; i < ng; i++) {
    const lat = (rng.chance(0.5) ? 1 : -1) * rng.range(0.45, 0.95);
    recipe.galaxies.push({
      dir: fromGalactic(recipe, rng.range(0, Math.PI * 2), lat, new THREE.Vector3()),
      size: i === 0 ? rng.range(0.02, 0.04) : rng.range(0.008, 0.016),
      intensity: rng.range(0.05, 0.1),
      ratio: rng.range(0.22, 0.7),
      angle: rng.range(0, Math.PI),
    });
  }

  // Open clusters (resolved into points by the star generator).
  const nc = rng.int(3, 5);
  for (let i = 0; i < nc; i++) {
    recipe.clusters.push({
      dir: fromGalactic(recipe, rng.range(0, Math.PI * 2), rng.range(-0.3, 0.3), new THREE.Vector3()),
      radius: rng.range(0.008, 0.028),
      count: rng.int(40, 130),
      temp: rng.range(7000, 16000),
    });
  }
  // Young clusters inside emission regions and the star that lights each reflection nebula.
  for (const n of recipe.nebulae) {
    if (n.type === 1) recipe.clusters.push({ dir: n.dir.clone(), radius: n.size * 0.22, count: 70, temp: 18000 });
    if (n.type === 3) recipe.clusters.push({ dir: n.dir.clone().addScaledVector(n.x, 0.22 * n.size).normalize(), radius: n.size * 0.1, count: 14, temp: 12000 });
  }
  return recipe;
}

// ---------------------------------------------------------------------------------------------- shaders

const SKY_BAKE_FS = /* glsl */ `
precision highp float;
precision highp int;

uniform int uFace;
uniform float uInvSize;
uniform vec3 uGx;
uniform vec3 uGy;
uniform vec3 uGz;
uniform vec4 uBandA;      // disk brightness, bulge brightness, thickness, dust amount
uniform vec4 uBandB;      // bulge sigma (lon), bulge sigma (lat), cloudiness, noise offset
uniform vec3 uDiskTint;
uniform vec3 uBulgeTint;
uniform vec4 uNebDir[2];  // xyz direction, w angular radius
uniform vec4 uNebPar[2];  // type, seed, intensity, colour mix
uniform vec3 uNebX[2];
uniform vec3 uNebY[2];
uniform vec4 uGxDir[3];   // xyz direction, w angular size
uniform vec4 uGxPar[3];   // intensity, axis ratio, position angle, -

out vec4 outColor;

${NOISE_GLSL}

const vec3 HA = vec3(1.0, 0.09, 0.07);    // hydrogen-alpha: deep red (kept away from magenta)
const vec3 O3 = vec3(0.07, 0.72, 0.66);   // doubly ionised oxygen: teal
const vec3 REFL = vec3(0.22, 0.42, 1.0);  // dust-scattered blue starlight

// Unresolved starlight of the galaxy and the dust in front of it.
vec3 galaxy(vec3 d, out vec3 trans) {
  vec3 g = vec3(dot(d, uGx), dot(d, uGy), dot(d, uGz));
  float off = uBandB.w;
  float warp = 0.05 * fbm(g * 1.6 + off, 3);
  float sb = g.y + warp;
  float ab = abs(sb);
  float toward = 0.5 + 0.5 * g.x;
  float h = uBandA.z * (0.6 + 0.8 * toward);

  float disk = exp(-ab / h) * (0.1 + 0.9 * pow(toward, 1.7));
  disk += 0.07 * exp(-ab / (h * 3.5)) * (0.25 + 0.75 * toward);
  float bulge = exp(-(g.z * g.z / (uBandB.x * uBandB.x) + sb * sb / (uBandB.y * uBandB.y))) * smoothstep(0.0, 0.55, g.x);

  // star clouds: large patches of denser / thinner unresolved stars
  float c1 = fbm(g * 4.2 + off + 11.0, 5);
  float clouds = mix(1.0, 0.4 + 1.35 * smoothstep(-0.5, 0.55, c1), uBandB.z);
  // semi-resolved grain
  float grain = 0.84 + 0.2 * gnoise(g * 140.0 + off) + 0.12 * gnoise(g * 310.0 + off);

  // dust: a warped sheet hugging the plane plus filaments reaching off it
  vec3 q = vec3(g.x, sb * 2.3, g.z);
  vec3 w = q * 2.5 + off;
  w += 0.65 * fbm3(q * 1.8 + 3.7, 3);
  float d1 = fbm(w * 1.5, 6);
  float d2 = ridged(w * 2.6 + 5.0, 5);
  float plane = exp(-(sb * sb) / (h * h * 0.8));
  float tau = uBandA.w * (4.6 * plane * smoothstep(-0.28, 0.38, d1) * (0.3 + 0.7 * toward)
                        + 2.6 * pow(d2, 2.6) * exp(-ab / (h * 2.8)) * smoothstep(-0.35, 0.3, d1) * (0.35 + 0.65 * toward));
  trans = exp(-tau * vec3(0.62, 1.0, 1.55));

  vec3 col = (uDiskTint * (disk * clouds * uBandA.x) + uBulgeTint * (bulge * (0.7 + 0.3 * clouds) * uBandA.y)) * grain;

  // faint, tiny hydrogen knots strung along the plane (distant star-forming regions)
  float kn = smoothstep(0.42, 0.75, gnoise(q * 19.0 + off * 1.7)) * plane * (0.2 + 0.8 * toward);
  col += HA * (kn * 0.035);
  return col * trans;
}

// One nebula. Returns emitted light; multiplies 'trans' by its own foreground dust.
vec3 nebula(vec3 d, vec4 nd, vec4 np, vec3 nx, vec3 ny, inout vec3 trans) {
  if (np.x < 0.5) return vec3(0.0);
  float cz = dot(d, nd.xyz);
  float size = nd.w;
  if (cz < cos(min(size * 2.7, 1.45))) return vec3(0.0);
  vec2 u = vec2(dot(d, nx), dot(d, ny)) / (max(cz, 0.1) * tan(size));
  float r = length(u);
  float sd = np.y;
  vec3 p = vec3(u * 1.35, sd);
  vec3 wp = p + 0.55 * fbm3(p * 0.85 + 3.1, 4);
  vec3 e = vec3(0.0);
  vec3 tl = vec3(1.0);

  if (np.x < 1.5) {
    // --- emission region: red hydrogen shell around a teal oxygen core, eaten by dark globules
    float n1 = fbm(wp * 1.25, 6) * 0.5 + 0.5;
    float rid = ridged(wp * 1.9 + 5.0, 5);
    float env = exp(-r * r * 1.7);
    float envIn = exp(-r * r * 5.5);
    // cavity blown by the central cluster
    float cav = smoothstep(0.08, 0.5, r + 0.25 * (n1 - 0.5));
    float ha = env * cav * (1.5 * pow(n1, 2.4) + 1.1 * pow(rid, 3.2) * smoothstep(1.5, 0.25, r));
    float n2 = fbm(wp * 1.6 + 9.0, 5) * 0.5 + 0.5;
    float o3 = envIn * (0.35 + 1.2 * pow(n2, 2.0));
    float dk = smoothstep(0.5, 0.74, fbm(wp * 2.2 + 23.0, 6) * 0.5 + 0.5) * exp(-r * r * 0.8);
    float dk2 = pow(ridged(wp * 3.1 + 41.0, 4), 3.0) * exp(-r * r * 1.2);
    tl = exp(-(dk * 3.2 + dk2 * 2.0) * vec3(0.7, 1.0, 1.4));
    e = (HA * ha * mix(1.25, 0.7, np.w) + O3 * o3 * mix(0.35, 0.95, np.w)) * 0.2;
    // thin bright rims where the dark lanes face the cluster
    e += HA * (0.05 * dk * (1.0 - dk) * 4.0 * env);
  } else if (np.x < 2.5) {
    // --- supernova remnant: a thin, broken shell of interleaved teal and red filaments
    float a = atan(u.y, u.x);
    vec3 pa = vec3(cos(a) * 1.7, sin(a) * 1.7, sd);
    float rr = r * (1.0 + 0.22 * fbm(pa * 0.9, 3));
    vec3 pf = vec3(cos(a) * 2.6, sin(a) * 2.6, rr * 7.5 + sd);
    pf += 0.4 * fbm3(pf * 0.6 + 2.0, 3);
    float f1 = pow(ridged(pf, 5), 4.5);
    float f2 = pow(ridged(pf * 1.7 + 7.3, 5), 5.5);
    float gaps = smoothstep(-0.25, 0.35, fbm(pa * 1.3 + 4.0, 3));
    float shell = exp(-pow((rr - 0.8) / 0.17, 2.0)) * (0.25 + 0.75 * gaps);
    float inner = 0.3 * exp(-pow((rr - 0.5) / 0.26, 2.0));
    e = (O3 * f1 * mix(0.55, 1.2, np.w) + HA * f2 * mix(1.3, 0.6, np.w)) * (shell + inner) * 1.15;
    e += (HA * 0.6 + O3 * 0.4) * (0.012 * smoothstep(0.95, 0.3, rr));
  } else {
    // --- dark molecular cloud with a blue reflection glow around one embedded star
    float n1 = fbm(wp * 1.3, 6) * 0.5 + 0.5;
    float dk = smoothstep(0.4, 0.68, n1) * exp(-r * r * 1.0);
    float fil = pow(ridged(wp * 2.4 + 13.0, 5), 2.4) * exp(-r * r * 0.6);
    tl = exp(-(dk * 4.5 + fil * 2.4) * vec3(0.7, 1.0, 1.4));
    vec2 so = u - vec2(0.22, 0.0);
    float n2 = fbm(wp * 2.1 + 31.0, 5) * 0.5 + 0.5;
    float refl = exp(-dot(so, so) * 7.0) * (0.25 + 1.1 * n2 * n2);
    e = REFL * refl * 0.13;
    // dust glowing faintly brown where it is thick, and a little hydrogen at the far edge
    e += vec3(0.75, 0.42, 0.22) * (dk * 0.012);
    vec2 so2 = u + vec2(0.35, 0.2);
    e += HA * (0.05 * exp(-dot(so2, so2) * 5.0) * pow(n2, 2.0));
  }
  trans *= tl;
  return e * tl * np.z;
}

// Distant galaxy: a small inclined exponential disc with a warm core.
vec3 farGalaxy(vec3 d, vec4 gd, vec4 gp) {
  float cz = dot(d, gd.xyz);
  if (gp.x <= 0.0 || cz < cos(min(gd.w * 8.0, 1.2))) return vec3(0.0);
  vec3 ref = abs(gd.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 ax = normalize(cross(ref, gd.xyz));
  vec3 ay = cross(gd.xyz, ax);
  vec2 u = vec2(dot(d, ax), dot(d, ay)) / gd.w;
  float ca = cos(gp.z);
  float sa = sin(gp.z);
  u = vec2(ca * u.x + sa * u.y, -sa * u.x + ca * u.y);
  u.y /= gp.y;
  float r = length(u);
  float arms = 0.75 + 0.25 * sin(atan(u.y, u.x) * 2.0 + r * 5.0);
  vec3 disc = vec3(0.75, 0.85, 1.0) * exp(-r * 1.6) * arms;
  vec3 core = vec3(1.0, 0.85, 0.65) * exp(-r * r * 14.0) * 1.6;
  return (disc + core) * gp.x;
}

void main() {
  vec2 st = gl_FragCoord.xy * uInvSize * 2.0 - 1.0;
  vec3 d = normalize(tlFaceDir(uFace, st));

  vec3 trans;
  vec3 col = galaxy(d, trans);
  for (int i = 0; i < 3; i++) col += farGalaxy(d, uGxDir[i], uGxPar[i]) * trans;
  for (int i = 0; i < 2; i++) {
    vec3 tn = vec3(1.0);
    vec3 e = nebula(d, uNebDir[i], uNebPar[i], uNebX[i], uNebY[i], tn);
    col = col * tn + e;
    trans *= tn;
  }

  vec3 enc = sqrt(clamp(col / ${SKY_MAX.toFixed(1)}, 0.0, 1.0));
  float dither = tlH31(ivec3(gl_FragCoord.xy, uFace)) - 0.5;
  outColor = vec4(enc + dither / 255.0, clamp(trans.g, 0.0, 1.0) + dither / 255.0);
}
`;

const SKY_BOX_VS = /* glsl */ `
precision highp float;
in vec3 position;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
out vec3 vDir;
void main() {
  vDir = position;
  // rotation only: the sky is always centred on the camera, whatever the object's position
  vec4 clip = projectionMatrix * vec4(mat3(modelViewMatrix) * position, 1.0);
  gl_Position = vec4(clip.xy, 0.0, clip.w);
}
`;

const SKY_BOX_FS = /* glsl */ `
precision highp float;
uniform lowp samplerCube uSky;
uniform float uGain;
in vec3 vDir;
out vec4 outColor;
void main() {
  vec3 e = texture(uSky, vDir).rgb;
  outColor = vec4(e * e * uGain, 1.0);
}
`;

const STAR_VS = /* glsl */ `
precision highp float;
in vec3 position;   // unit direction
in vec4 aColor;     // rgb chroma, a = how deep behind the dust the star sits
in float aFlux;     // relative flux, 1 = faintest catalogued star
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform lowp samplerCube uSky;
uniform vec4 uParams;    // x: core sigma (px), y: flux -> peak radiance gain, z: peak cap, w: halo reach (px)
uniform vec2 uViewport;  // px
out vec3 vColor;
out vec4 vShape;         // x: 0.5 / sigma^2, y: sprite size (px), z: standout 0..1, w: sigma (px)

void main() {
  vec4 clip = projectionMatrix * vec4(mat3(modelViewMatrix) * position, 1.0);
  float dust = textureLod(uSky, position, 0.0).a;
  float t = pow(max(dust, 0.0), aColor.a * 2.4);
  float b = aFlux * uParams.y * t;
  if (b < 0.006 || clip.w <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 1.0;
    vColor = vec3(0.0);
    vShape = vec4(1.0);
    return;
  }
  float over = max(b / uParams.z, 1.0);
  float sigma = uParams.x * pow(over, 0.23);
  float peak = min(b, uParams.z) * (1.0 + 0.4 * log2(over));
  float stand = smoothstep(5.0, 45.0, over);
  float coreSize = 2.0 * ceil(3.2 * sigma) + 1.0;
  float haloSize = coreSize + 2.0 * uParams.w * (0.45 + 0.55 * stand);
  // fade the wide glow out before the sprite centre leaves the screen (points are clipped by their centre)
  vec2 ndc = clip.xy / clip.w;
  vec2 edgePx = (1.0 - abs(ndc)) * 0.5 * uViewport;
  stand *= clamp(min(edgePx.x, edgePx.y) / (0.5 * haloSize), 0.0, 1.0);
  float size = stand > 0.001 ? haloSize : coreSize;
  // dust reddens what it does not hide
  vec3 redden = mix(vec3(1.0, 0.72, 0.45), vec3(1.0), smoothstep(0.0, 1.0, t));
  vColor = aColor.rgb * redden * peak;
  vShape = vec4(0.5 / (sigma * sigma), size, stand, sigma);
  gl_Position = vec4(clip.xy, 0.0, clip.w);
  gl_PointSize = size;
}
`;

const STAR_FS = /* glsl */ `
precision highp float;
in vec3 vColor;
in vec4 vShape;
out vec4 outColor;
void main() {
  vec2 d = (gl_PointCoord - 0.5) * vShape.y;
  float r2 = dot(d, d);
  float i = exp(-r2 * vShape.x);
  if (vShape.z > 0.0) {
    // bright standouts: a faint scattering skirt and four thin diffraction spikes, fixed to the camera
    float half_ = 0.5 * vShape.y;
    float win = clamp(1.0 - r2 / (half_ * half_), 0.0, 1.0);
    win *= win;
    float s = vShape.w;
    float halo = 0.035 / (1.0 + r2 / (s * s * 5.0));
    vec2 a = abs(d);
    float across = min(a.x, a.y);
    float along = max(a.x, a.y);
    float spike = exp(-across * across / (0.5 * s * s)) / (1.0 + along * along / (s * s * 30.0));
    i += vShape.z * win * (halo + 0.09 * spike);
  }
  outColor = vec4(vColor * i, 0.0);
}
`;

const ENV_FS = /* glsl */ `
precision highp float;
precision highp int;
uniform int uFace;
uniform float uInvSize;
uniform lowp samplerCube uSky;
uniform float uSkyGain;
uniform vec3 uStarDir;
uniform vec3 uStarColor;   // radiance at the centre of the lobe
uniform float uStarK;      // lobe width: exp(-(1 - cos) / k)
out vec4 outColor;
${NOISE_GLSL}
void main() {
  vec3 col = vec3(0.0);
  // 4 jittered taps: the sky cube has no mip chain
  for (int i = 0; i < 4; i++) {
    vec2 j = vec2(float(i & 1), float(i >> 1)) * 0.5 - 0.25;
    vec2 st = (gl_FragCoord.xy + j) * uInvSize * 2.0 - 1.0;
    vec3 e = texture(uSky, tlFaceDir(uFace, st)).rgb;
    col += e * e;
  }
  col *= 0.25 * uSkyGain;
  vec2 st0 = gl_FragCoord.xy * uInvSize * 2.0 - 1.0;
  vec3 d = normalize(tlFaceDir(uFace, st0));
  col += uStarColor * exp(-(1.0 - dot(d, uStarDir)) / uStarK);
  outColor = vec4(col, 1.0);
}
`;

// ------------------------------------------------------------------------------------------ star catalogue

interface Catalogue {
  position: Float32Array;
  color: Uint8Array;
  flux: Float32Array;
}

function buildCatalogue(recipe: SkyRecipe, skySeed: number, count: number): Catalogue {
  const rng = makeRng(`stars:${skySeed}`);
  const position = new Float32Array(count * 3);
  const color = new Uint8Array(count * 4);
  const flux = new Float32Array(count);
  const v = new THREE.Vector3();
  const rgb: [number, number, number] = [1, 1, 1];
  let n = 0;

  const put = (dir: THREE.Vector3, f: number, temp: number, depth: number): void => {
    if (n >= count) return;
    position[n * 3] = dir.x;
    position[n * 3 + 1] = dir.y;
    position[n * 3 + 2] = dir.z;
    blackbodyLinearRGB(temp, rgb);
    // photographic star colour: real chroma, slightly desaturated toward white
    const sat = 0.82;
    color[n * 4] = Math.round(255 * (1 - sat + sat * rgb[0]));
    color[n * 4 + 1] = Math.round(255 * (1 - sat + sat * rgb[1]));
    color[n * 4 + 2] = Math.round(255 * (1 - sat + sat * rgb[2]));
    color[n * 4 + 3] = Math.round(255 * Math.min(1, Math.max(0, depth)));
    flux[n] = f;
    n++;
  };

  // Cumulative star counts follow N(>F) ~ F^-1.25 (0.5 dex per magnitude).
  const powerFlux = (cap: number): number => Math.min(cap, Math.pow(1 - rng.next(), -0.8));
  const temperature = (): number => {
    const u = rng.next();
    if (u < 0.3) return rng.range(3000, 4600); // K/M giants and dwarfs: orange
    if (u < 0.62) return rng.range(4600, 6500); // G/F: yellow-white
    if (u < 0.9) return rng.range(6500, 10000); // A: white / blue-white
    return rng.range(10000, 24000); // B/O: blue
  };

  // open clusters first so they always fit
  for (const c of recipe.clusters) {
    const ax = new THREE.Vector3();
    const ay = new THREE.Vector3();
    tangentFrame(c.dir, 0, ax, ay);
    for (let i = 0; i < c.count; i++) {
      const rr = c.radius * Math.sqrt(-Math.log(1 - rng.next() * 0.98)) * 0.75;
      const a = rng.range(0, Math.PI * 2);
      v.copy(c.dir).addScaledVector(ax, Math.tan(rr) * Math.cos(a)).addScaledVector(ay, Math.tan(rr) * Math.sin(a)).normalize();
      const t = rng.chance(0.8) ? c.temp * rng.range(0.7, 1.3) : rng.range(3500, 5000);
      put(v, Math.min(900, 2.5 * powerFlux(400)), t, 0.25);
    }
  }

  const fieldCount = Math.floor(count * 0.3);
  const bulgeCount = Math.floor(count * 0.13);
  // nearby field stars: isotropic, hold the bright standouts, mostly in front of the dust
  for (let i = 0; i < fieldCount && n < count; i++) {
    randomUnit(rng, v);
    const f = powerFlux(9000);
    put(v, f, temperature(), rng.next() * (f > 60 ? 0.15 : 0.7));
  }
  // bulge: old, warm, faint, deep behind the dust
  for (let i = 0; i < bulgeCount && n < count; i++) {
    const z = rng.gauss() * recipe.bulgeL * 0.85;
    const y = rng.gauss() * recipe.bulgeB * 0.85;
    v.set(0, 0, 0).addScaledVector(recipe.gx, 1).addScaledVector(recipe.gy, y).addScaledVector(recipe.gz, z).normalize();
    put(v, 0.75 * powerFlux(120), rng.range(3400, 5600), rng.range(0.6, 1));
  }
  // disk: concentrated on the plane and toward the core
  while (n < count) {
    const lon = rng.range(-Math.PI, Math.PI);
    const toward = 0.5 + 0.5 * Math.cos(lon);
    if (rng.next() > 0.1 + 0.9 * Math.pow(toward, 1.7)) continue;
    const h = recipe.thickness * (0.6 + 0.8 * toward) * 1.25;
    const sb = (rng.chance(0.5) ? 1 : -1) * h * -Math.log(1 - rng.next());
    if (Math.abs(sb) > 0.98) continue;
    fromGalactic(recipe, lon, sb, v);
    put(v, 0.8 * powerFlux(600), temperature(), rng.range(0.25, 1));
  }
  return { position, color, flux };
}

// ------------------------------------------------------------------------------------------------ factory

const QUALITY: Record<Quality, { cube: number; stars: number; env: number }> = {
  low: { cube: 512, stars: 30000, env: 64 },
  medium: { cube: 768, stars: 45000, env: 64 },
  high: { cube: 1024, stars: 60000, env: 128 },
  ultra: { cube: 1536, stars: 80000, env: 128 },
};

export interface SkyUpdateContext {
  /** Reserved (the sky is fixed in system axes and needs no camera orientation today). */
  cameraQuat?: THREE.Quaternion;
  /** Camera exposure applied to the whole sky (1 = default; lower it when a sunlit world fills the view). */
  exposure?: number;
}

export interface Sky {
  /** Centred on the camera by the scene manager (translation is ignored anyway); draws behind everything. */
  object3d: THREE.Object3D;
  /** Prefiltered environment (PMREM, CubeUV) for PBR reflections: sky + the star-light slot. */
  envMap: THREE.Texture;
  update(ctx: SkyUpdateContext): void;
  /**
   * Fill (or clear, with intensity 0) the star-light slot of `envMap` and re-filter it in place — the
   * texture object stays the same. `intensity` 1 puts as much light into a soft lobe around `dirWorld` as a
   * directional light that makes white diffuse read 1.0. Costs a few ms; call it on arrival in a system and
   * when the star direction has moved by more than a few degrees, not every frame.
   */
  setStarLight(dirWorld: THREE.Vector3, color: THREE.Color, intensity: number): void;
  /** Milliseconds spent baking at creation (GPU-synchronised). */
  readonly bakeMs: number;
  /** World directions of this sky's features (galactic core, galactic north, nebula centres). */
  readonly landmarks: { core: THREE.Vector3; north: THREE.Vector3; nebulae: THREE.Vector3[] };
  dispose(): void;
}

const ENV_LOBE_K = 0.02; // exp(-(1-cos)/k): about 11 degrees to 1/e

/** Flux of the faintest catalogued star -> peak radiance of its (minimum-size) image. */
const STAR_GAIN = 0.034;
/** Above this peak radiance a star image grows instead of getting brighter (as on film / a sensor). */
const STAR_PEAK_CAP = 2.6;
/** The sky is dim; this is how much of it the reflection environment carries (1 = physically equal). */
const ENV_SKY_GAIN = 1.0;

export function createSky(renderer: THREE.WebGLRenderer, skySeed: number, quality: Quality): Sky {
  const q = QUALITY[quality] ?? QUALITY.medium;
  const t0 = performance.now();
  const recipe = makeRecipe(skySeed);
  const maxCube = renderer.capabilities.maxCubemapSize || 1024;
  const cubeSize = Math.min(q.cube, maxCube);

  // ---- bake the band, dust and nebulae
  const cubeTarget = new THREE.WebGLCubeRenderTarget(cubeSize, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.NoColorSpace,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  cubeTarget.texture.name = 'tidelock.sky';

  const vec4s = (n: number): THREE.Vector4[] => Array.from({ length: n }, () => new THREE.Vector4());
  const vec3s = (n: number): THREE.Vector3[] => Array.from({ length: n }, () => new THREE.Vector3(1, 0, 0));
  const nebDir = vec4s(2);
  const nebPar = vec4s(2);
  const nebX = vec3s(2);
  const nebY = vec3s(2);
  recipe.nebulae.forEach((nb, i) => {
    nebDir[i].set(nb.dir.x, nb.dir.y, nb.dir.z, nb.size);
    nebPar[i].set(nb.type, nb.seed, nb.intensity, nb.mix);
    nebX[i].copy(nb.x);
    nebY[i].copy(nb.y);
  });
  const gxDir = vec4s(3);
  const gxPar = vec4s(3);
  recipe.galaxies.forEach((g, i) => {
    gxDir[i].set(g.dir.x, g.dir.y, g.dir.z, g.size);
    gxPar[i].set(g.intensity, g.ratio, g.angle, 0);
  });

  const bakeMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VS,
    fragmentShader: SKY_BAKE_FS,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uFace: { value: 0 },
      uInvSize: { value: 1 / cubeSize },
      uGx: { value: recipe.gx },
      uGy: { value: recipe.gy },
      uGz: { value: recipe.gz },
      uBandA: { value: new THREE.Vector4(recipe.diskBright, recipe.bulgeBright, recipe.thickness, recipe.dust) },
      uBandB: { value: new THREE.Vector4(recipe.bulgeL, recipe.bulgeB, recipe.cloudiness, recipe.noiseOffset) },
      uDiskTint: { value: new THREE.Vector3(...recipe.diskTint) },
      uBulgeTint: { value: new THREE.Vector3(...recipe.bulgeTint) },
      uNebDir: { value: nebDir },
      uNebPar: { value: nebPar },
      uNebX: { value: nebX },
      uNebY: { value: nebY },
      uGxDir: { value: gxDir },
      uGxPar: { value: gxPar },
    },
  });
  bakeCubeFaces(renderer, cubeTarget, bakeMaterial);
  bakeMaterial.dispose();

  // ---- background box
  const boxGeometry = new THREE.BoxGeometry(2, 2, 2);
  boxGeometry.deleteAttribute('normal');
  boxGeometry.deleteAttribute('uv');
  const boxMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: SKY_BOX_VS,
    fragmentShader: SKY_BOX_FS,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    uniforms: { uSky: { value: cubeTarget.texture }, uGain: { value: SKY_MAX } },
  });
  const box = new THREE.Mesh(boxGeometry, boxMaterial);
  box.frustumCulled = false;
  box.renderOrder = -1000;
  box.name = 'sky.band';

  // ---- star points
  const cat = buildCatalogue(recipe, skySeed, q.stars);
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.BufferAttribute(cat.position, 3));
  starGeometry.setAttribute('aColor', new THREE.BufferAttribute(cat.color, 4, true));
  starGeometry.setAttribute('aFlux', new THREE.BufferAttribute(cat.flux, 1));
  starGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
  const starParams = new THREE.Vector4(0.62, STAR_GAIN, STAR_PEAK_CAP, 22);
  const starViewport = new THREE.Vector2(1, 1);
  const starMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: STAR_VS,
    fragmentShader: STAR_FS,
    depthTest: false,
    depthWrite: false,
    // additive, but kept in the opaque list so it is drawn right after the box and before every body
    transparent: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    uniforms: { uSky: { value: cubeTarget.texture }, uParams: { value: starParams }, uViewport: { value: starViewport } },
  });
  const stars = new THREE.Points(starGeometry, starMaterial);
  stars.frustumCulled = false;
  stars.renderOrder = -999;
  stars.name = 'sky.stars';
  const viewport = new THREE.Vector4();
  let exposure = 1;
  stars.onBeforeRender = (r) => {
    // sizes are in pixels of whatever is being rendered to right now (dynamic resolution, DPR 2-3)
    r.getCurrentViewport(viewport);
    const w = Math.max(1, viewport.z);
    const h = Math.max(1, viewport.w);
    starViewport.set(w, h);
    const scale = Math.min(2.2, Math.max(0.8, Math.sqrt(Math.min(w, h) / 786)));
    starParams.x = 0.62 * scale;
    starParams.y = STAR_GAIN * exposure / (scale * scale);
    starParams.w = 22 * scale;
  };

  const group = new THREE.Group();
  group.name = 'sky';
  group.add(box, stars);

  // ---- environment for reflections
  const envCube = new THREE.WebGLCubeRenderTarget(q.env, {
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    colorSpace: THREE.LinearSRGBColorSpace,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  const envStarDir = new THREE.Vector3(0, 1, 0);
  const envStarColor = new THREE.Vector3(0, 0, 0);
  const envMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VS,
    fragmentShader: ENV_FS,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uFace: { value: 0 },
      uInvSize: { value: 1 / q.env },
      uSky: { value: cubeTarget.texture },
      uSkyGain: { value: SKY_MAX * ENV_SKY_GAIN },
      uStarDir: { value: envStarDir },
      uStarColor: { value: envStarColor },
      uStarK: { value: ENV_LOBE_K },
    },
  });
  const pmrem = new THREE.PMREMGenerator(renderer);
  let pmremTarget: THREE.WebGLRenderTarget | null = null;
  const refilter = (): void => {
    bakeCubeFaces(renderer, envCube, envMaterial);
    pmremTarget = pmrem.fromCubemap(envCube.texture, pmremTarget);
  };
  refilter();
  const envTarget = pmremTarget as unknown as THREE.WebGLRenderTarget;
  envTarget.texture.name = 'tidelock.sky.env';

  // force the GPU to finish so the bake time is honest (and the first frame does not hitch instead)
  const gl = renderer.getContext();
  gl.finish();
  const bakeMs = performance.now() - t0;

  return {
    object3d: group,
    envMap: envTarget.texture,
    bakeMs,
    landmarks: { core: recipe.gx.clone(), north: recipe.gy.clone(), nebulae: recipe.nebulae.map((nb) => nb.dir.clone()) },
    update(ctx: SkyUpdateContext): void {
      if (ctx.exposure !== undefined) {
        exposure = ctx.exposure;
        boxMaterial.uniforms.uGain.value = SKY_MAX * exposure;
      }
    },
    setStarLight(dirWorld: THREE.Vector3, color: THREE.Color, intensity: number): void {
      envStarDir.copy(dirWorld).normalize();
      // a lobe exp(-(1-cos)/k) subtends 2*pi*k sr; irradiance pi gives white diffuse = 1
      const peak = (intensity * Math.PI) / (2 * Math.PI * ENV_LOBE_K);
      envStarColor.set(color.r * peak, color.g * peak, color.b * peak);
      refilter();
    },
    dispose(): void {
      boxGeometry.dispose();
      boxMaterial.dispose();
      starGeometry.dispose();
      starMaterial.dispose();
      cubeTarget.dispose();
      envCube.dispose();
      envMaterial.dispose();
      envTarget.dispose();
      pmrem.dispose();
    },
  };
}
