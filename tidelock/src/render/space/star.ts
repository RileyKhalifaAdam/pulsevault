// The star: an HDR photosphere with convective granulation, limb darkening, spots and faculae, a thin
// chromosphere, a structured corona with streamers and occasional prominences — plus the lens glare that
// goes with it.
//
// createStarVisual draws everything in ONE draw call: a camera-facing quad on which the sphere is
// ray-cast analytically. That gives an exactly round, analytically anti-aliased limb at any size (a hard
// HDR edge on a tessellated sphere would crawl), correct perspective when the star is close, and lets the
// corona, chromosphere and prominences composite against the disc without depth tricks. Detail comes from
// two small cube maps baked once at creation (surface: granulation / fine structure / mottling / spots;
// corona: streamers and rays), so the per-frame cost is three cube fetches on the disc and one off it.
//
// Everything on the disc is far above display white, where a filmic curve has no contrast left, so the
// surface detail is carried by chromaticity: dimmer plasma (lanes, limb, penumbrae) is redder, brighter
// plasma (granule centres, faculae) whiter - what a black body does, exaggerated. Radiance at disc centre
// runs from 55 (far, point-like) through ~10 (disc spanning a third of the screen) to 5 (filling it).
// White dwarfs (class D...) are featureless searing points; brown dwarfs (L/T/Y) dim embers.
//
// Unit-sphere convention: radius 1 = def.radius; the scene manager positions and scales object3d.

import * as THREE from 'three';
import type { BodyDef } from '../../core/types';
import { hash } from '../../core/rng';
import { FULLSCREEN_VS, NOISE_GLSL, SPIKE_ROTATION, bakeCubeFaces, blackbodyLinearRGB, finishGpu, type Quality } from './sky';

export type { Quality } from './sky';

const scratchRGB: [number, number, number] = [1, 1, 1];

/**
 * Black-body colour of a star of the given effective temperature, linear RGB with the largest channel 1.
 * This is the physical chromaticity (use it for the star's light and for createStarGlare's starColor);
 * the disc itself is drawn with richer chroma, see createStarVisual.
 */
export function starColorFromTemperature(kelvin: number): THREE.Color {
  blackbodyLinearRGB(kelvin, scratchRGB);
  return new THREE.Color().setRGB(scratchRGB[0], scratchRGB[1], scratchRGB[2], THREE.LinearSRGBColorSpace);
}

/** Raise a colour's chroma (per-channel power, renormalised so the largest channel stays 1). */
function pushChroma(c: THREE.Color, exponent: number, out: THREE.Vector3): THREE.Vector3 {
  out.set(Math.pow(c.r, exponent), Math.pow(c.g, exponent), Math.pow(c.b, exponent));
  return out.multiplyScalar(1 / Math.max(out.x, out.y, out.z, 1e-6));
}

// ------------------------------------------------------------------------------------------- bake shaders

const MAX_SPOTS = 28;

const SURFACE_BAKE_FS = /* glsl */ `
precision highp float;
precision highp int;
uniform int uFace;
uniform float uInvSize;
uniform float uSeed;
uniform float uActivity;
uniform float uCells;     // granulation cells per radian
uniform int uSpotCount;
uniform vec4 uSpots[${MAX_SPOTS}];   // xyz direction, w angular radius
out vec4 outColor;
${NOISE_GLSL}
void main() {
  vec2 st = gl_FragCoord.xy * uInvSize * 2.0 - 1.0;
  vec3 d = normalize(tlFaceDir(uFace, st));

  // R: granulation - soft bright convective cells of uneven size, separated by cooler lanes
  vec3 p = d * uCells + uSeed;
  p += 0.55 * fbm3(d * (uCells * 0.3) + uSeed, 2);
  vec2 w = worley(p);
  float dome = 1.0 - smoothstep(0.0, 0.8, w.x);
  float gran = (0.3 + 0.7 * smoothstep(0.0, 0.32, w.y - w.x)) * (0.55 + 0.45 * dome);
  gran *= 0.85 + 0.3 * gnoise(p * 0.45 + 7.0);

  // G: finer structure inside the cells
  vec2 w2 = worley(p * 2.7 + 11.0);
  float fine = smoothstep(0.0, 0.35, w2.y - w2.x) * (1.0 - 0.5 * w2.x);

  // B: large-scale mottling (supergranular network) cut by a web of dark filaments on active stars
  float fil = pow(ridged(d * 4.3 + uSeed + 31.0, 4), 2.5);
  float mott = clamp(0.5 + 0.6 * fbm(d * 3.1 + uSeed + 5.0, 5) - 0.9 * fil * uActivity, 0.0, 1.0);

  // A: spots (below 0.5) and faculae (above 0.5)
  float spot = 0.0;
  float facEnv = 0.0;
  for (int i = 0; i < ${MAX_SPOTS}; i++) {
    if (i >= uSpotCount) break;
    vec4 s = uSpots[i];
    float c = clamp(dot(d, s.xyz), -1.0, 1.0);
    if (c < cos(min(s.w * 4.0, 3.1))) continue;
    float ang = acos(c);
    float fi = float(i);
    float wob = fbm(d * (1.1 / s.w) + fi * 7.3, 4);
    float edge = ang / s.w * (1.0 + 0.45 * wob);
    float um = 1.0 - smoothstep(0.36, 0.5, edge);
    float pen = 1.0 - smoothstep(0.82, 1.0, edge);
    vec3 t = normalize(d - s.xyz * c + 1e-5);
    float fib = 0.5 + 0.5 * gnoise(t * 17.0 + fi * 3.1 + vec3(0.0, 0.0, edge * 1.5));
    spot = max(spot, max(um, pen * (0.36 + 0.2 * fib)));
    facEnv = max(facEnv, 1.0 - smoothstep(1.0, 3.4, edge));
  }
  float fn = fbm(d * 26.0 + uSeed + 3.0, 4);
  float fac = smoothstep(0.02, 0.42, fn) * facEnv;
  fac += smoothstep(0.22, 0.6, fbm(d * 15.0 + uSeed + 9.0, 4)) * 0.35 * uActivity;
  fac = clamp(fac, 0.0, 1.0) * step(spot, 0.001);
  float a = 0.5 + 0.5 * fac - 0.5 * spot;

  outColor = vec4(gran, fine, mott, a);
}
`;

const CORONA_BAKE_FS = /* glsl */ `
precision highp float;
precision highp int;
uniform int uFace;
uniform float uInvSize;
uniform float uSeed;
uniform float uActivity;
uniform vec3 uAxis;       // magnetic axis
out vec4 outColor;
${NOISE_GLSL}
void main() {
  vec2 st = gl_FragCoord.xy * uInvSize * 2.0 - 1.0;
  vec3 d = normalize(tlFaceDir(uFace, st));
  float lat = dot(d, uAxis);
  // streamers hug the magnetic equator of a quiet star and spread everywhere on an active one
  float belt = mix(exp(-lat * lat * 6.0), 1.0, clamp(uActivity * 0.8, 0.0, 1.0));
  // r, b: two raw streamer fields (thresholded at run time, so a streamer can taper as it climbs)
  float r = clamp(ridged(d * 1.5 + uSeed, 4) * 1.15, 0.0, 1.0) * belt;
  float b = clamp(ridged(d * 1.5 + uSeed + 19.0, 4) * 1.15, 0.0, 1.0) * belt;
  // fine rays; polar plumes are finer and fainter
  float g = clamp(0.5 + 0.75 * fbm(d * 7.0 + uSeed + 3.0, 4), 0.0, 1.0);
  float a = clamp(0.5 + 0.8 * fbm(d * 28.0 + uSeed + 7.0, 3), 0.0, 1.0);
  outColor = vec4(r, g, b, a);
}
`;

// ------------------------------------------------------------------------------------------- star shaders

const MAX_PROM = 6;

const STAR_VS = /* glsl */ `
precision highp float;
in vec3 position;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec4 uGeom;      // x: quad half-size (radii, already inflated), y: inflate, z: camera distance (radii), w: pixels per radius
out vec2 vS;
void main() {
  vec2 c = position.xy * uGeom.x;
  vS = c / uGeom.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(uRight * c.x + uUp * c.y, 1.0);
}
`;

const STAR_FS = /* glsl */ `
precision highp float;
precision highp int;

uniform lowp samplerCube uSurf;
uniform lowp samplerCube uCorona;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uCamN;
uniform vec4 uGeom;        // x: quad half-size, y: inflate, z: camera distance (radii), w: pixels per radius
uniform mat3 uRotA;        // local -> granulation pattern A
uniform mat3 uRotB;        // local -> granulation pattern B
uniform mat3 uRotS;        // local -> star-fixed frame (spots, corona)
uniform vec4 uMix;         // x: A->B blend, y: contrast compensation, z: corona blend, w: surface cube texels per radian
uniform vec3 uPhoto;       // photosphere radiance at disc centre
uniform vec4 uLimb;        // x: limb-darkening exponent, y: extra darkening of the extreme limb, z: spot depth, w: disc-centre boost
uniform vec3 uTempExp;     // relative intensity -> colour exponents (cooler = redder)
uniform vec4 uAmp;         // granulation, fine, mottling, faculae amplitudes
uniform vec3 uCoronaCol;
uniform vec3 uChromoCol;
uniform vec4 uDetail;      // x: -, y: corona gain, z: chromosphere gain, w: prominence gain
uniform vec4 uProm[${MAX_PROM}];   // xyz anchor direction (local), w height (radii); height 0 = inactive
uniform vec4 uPromB[${MAX_PROM}];  // x: half-width (radii), y: strength, z: thickness, w: lean

in vec2 vS;
out vec4 outColor;

void main() {
  float s = length(vS);
  float d = uGeom.z;
  float inv = inversesqrt(d * d + s * s);
  float rho = s * d * inv;                       // impact parameter of this pixel's ray, in radii
  vec2 sh = vS / max(s, 1e-5);
  vec3 sdir = uRight * sh.x + uUp * sh.y;
  vec3 q = (sdir * d + uCamN * s) * inv;         // direction of the ray's closest point to the centre
  vec3 rd = (sdir * s - uCamN * d) * inv;        // ray direction

  float px = 1.0 / uGeom.w;                      // one pixel, in radii
  float cover = clamp((1.0 - rho) / px + 0.5, 0.0, 1.0);

  vec3 col = vec3(0.0);

  // ------------------------------------------------------------------ corona, chromosphere, prominences
  if (cover < 1.0) {
    float x = max(rho, 1.0);
    float h = x - 1.0;
    vec4 cs = texture(uCorona, uRotS * q);
    float rays = cs.g;
    float fine = cs.a;
    // helmet streamers: broad at the base, tapering to a stalk as they climb
    float t = clamp(h / 2.6, 0.0, 1.0);
    float stream = smoothstep(0.2 + 0.4 * t, 0.62 + 0.3 * t, mix(cs.r, cs.b, uMix.z));
    float inner = exp(-h * 9.0) * (0.7 + 0.6 * rays);
    float mid = exp(-h * 2.0) * (0.035 + 1.25 * stream * (0.45 + 0.8 * fine) + 0.1 * rays);
    float far = 0.03 / (x * x) * (0.2 + 1.6 * stream);
    float win = smoothstep(uGeom.x / uGeom.y, 0.5 * uGeom.x / uGeom.y, s);
    col += uCoronaCol * ((1.25 * inner + 0.62 * mid + far) * uDetail.y * win);

    // chromosphere: a thin, ragged emission rim (spicules)
    float ht = max(0.006 + 0.02 * fine * fine, 1.1 * px);
    col += uChromoCol * (exp(-h / ht) * uDetail.z);

    // prominences: fibrous arches standing on the limb
    if (h < 0.6 && uDetail.w > 0.0) {
      vec2 sp = vS * (x / max(s, 1e-5));   // position in the sky plane, limb at radius 1
      float prom = 0.0;
      for (int i = 0; i < ${MAX_PROM}; i++) {
        vec4 pa = uProm[i];
        if (pa.w <= 0.0) continue;
        vec4 pb = uPromB[i];
        vec2 ap = vec2(dot(pa.xyz, uRight), dot(pa.xyz, uUp));
        float al = length(ap);
        float vis = smoothstep(0.72, 0.96, al);     // only when the anchor is near the limb
        if (vis <= 0.0) continue;
        vec2 c = ap / al;
        vec2 tg = vec2(-c.y, c.x);
        float hh = dot(sp, c) - 1.0;                 // height above the limb along the anchor radius
        float tt = dot(sp, tg) + pb.w * hh;          // tangential offset (leaning arch)
        float e = length(vec2(tt / pb.x, (hh + 0.25 * pa.w) / (1.25 * pa.w)));
        float loop_ = exp(-pow((e - 1.0) / pb.z, 2.0));
        float sheet = 0.3 * smoothstep(1.0, 0.4, e);
        float fib = 0.25 + 1.5 * fine * (0.4 + 0.6 * rays);
        float leg = 0.65 + 0.35 * sign(tt) * sin(pb.w * 7.0);   // one leg brighter than the other
        prom += (loop_ * leg + sheet) * fib * pb.y * vis * smoothstep(-0.01, 0.02, hh);
      }
      col += uChromoCol * (prom * uDetail.w);
    }
  }

  // ------------------------------------------------------------------------------------- photosphere
  if (cover > 0.0) {
    float rc = min(rho, 1.0);
    float mu = sqrt(max(1.0 - rc * rc, 0.0));
    vec3 P = q * rc - rd * mu;                   // point on the unit sphere
    float mue = max(mu, sqrt(px));               // keeps the anti-aliased rim from going black
    float lod = max(log2(uMix.w * px / sqrt(mue)) - 0.35, 0.0);
    vec4 ga = textureLod(uSurf, uRotA * P, lod);
    vec4 gb = textureLod(uSurf, uRotB * P, lod);
    vec4 sf = textureLod(uSurf, uRotS * P, lod);
    float gran = mix(ga.r, gb.r, uMix.x);
    float fine = mix(ga.g, gb.g, uMix.x);
    float bright = 1.0
      + uMix.y * (uAmp.x * (gran - 0.60) + uAmp.y * (fine - 0.56))
      + uAmp.z * (sf.b - 0.5);
    float sv = sf.a * 2.0 - 1.0;
    float spot = clamp(-sv, 0.0, 1.0);
    float fac = clamp(sv, 0.0, 1.0);
    // penumbra about half, umbra a few per cent of the photosphere
    bright *= mix(1.0, uLimb.z, smoothstep(0.0, 0.95, spot));
    bright += fac * uAmp.w * (0.3 + 0.9 * (1.0 - mu));
    bright = max(bright, 0.02);
    // Relative intensity of this point. Everything here is far above display white, so the detail has to
    // live in the chromaticity: cooler (dimmer) plasma is redder, exactly as a black body is, exaggerated.
    float rel = uLimb.w * bright * pow(mue, uLimb.x) * (1.0 - uLimb.y * (1.0 - smoothstep(0.0, 0.32, mu)));
    vec3 photo = uPhoto * pow(vec3(rel), uTempExp);
    col = mix(col, photo, cover);
  }

  outColor = vec4(col, cover);
}
`;

// ------------------------------------------------------------------------------------------------ factory

const STAR_QUALITY: Record<Quality, { surf: number; corona: number; prominences: number }> = {
  low: { surf: 128, corona: 32, prominences: 3 },
  medium: { surf: 256, corona: 64, prominences: 4 },
  high: { surf: 512, corona: 64, prominences: 6 },
  ultra: { surf: 512, corona: 128, prominences: 6 },
};

/** Quad half-size in star radii: how far the corona reaches before it is windowed to zero. */
const CORONA_EXTENT = 6;
/** The disc never renders smaller than this many pixels in radius (a far star stays a steady point). */
const MIN_PIXEL_RADIUS = 1.25;

export interface StarUpdateContext {
  /** Visual clock, seconds. Drives granulation, prominences and the slow cosmetic rotation; any value is safe. */
  time: number;
  /** Camera position in the star's local frame (units of star radii). */
  cameraPosLocal: THREE.Vector3;
  /** Apparent radius of the disc in render-target pixels. */
  pixelRadius: number;
}

export interface StarVisual {
  object3d: THREE.Object3D;
  update(ctx: StarUpdateContext): void;
  /** Milliseconds spent baking at creation (GPU-synchronised). */
  readonly bakeMs: number;
  /** GPU memory held by this star (two baked cube maps), bytes. */
  readonly gpuBytes: number;
  dispose(): void;
}

function hash01(a: number, b: number, c: number): number {
  return hash(`${a}:${b}:${c}`) / 4294967296;
}

/** Uniformly random rotation from three numbers in [0, 1) (Shoemake). */
function randomQuat(u1: number, u2: number, u3: number, out: THREE.Quaternion): THREE.Quaternion {
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  return out.set(a * Math.sin(2 * Math.PI * u2), a * Math.cos(2 * Math.PI * u2), b * Math.sin(2 * Math.PI * u3), b * Math.cos(2 * Math.PI * u3));
}

export function createStarVisual(renderer: THREE.WebGLRenderer, def: BodyDef, quality: Quality): StarVisual {
  const q = STAR_QUALITY[quality] ?? STAR_QUALITY.medium;
  const t0 = performance.now();
  const star = def.star;
  const temperature = star ? star.temperature : 5800;
  const activity = Math.min(1, Math.max(0, star ? star.activity : 0.3));
  const seed = hash(`star:${def.id}:${def.visual.seed}`);
  const seedF = (seed % 4096) / 64;
  const cls = star ? star.spectralClass : '';
  const whiteDwarf = cls.startsWith('D');
  const brownDwarf = /^[LTY]\d/.test(cls);
  const cool = THREE.MathUtils.clamp((6200 - temperature) / 3000, 0, 1);

  // ---- spots: bipolar groups in two activity belts; active dwarfs also carry large high-latitude spots
  const spots: THREE.Vector4[] = Array.from({ length: MAX_SPOTS }, () => new THREE.Vector4(0, 1, 0, 0.01));
  let spotCount = 0;
  const groups = whiteDwarf ? 0 : Math.round(1 + activity * 11);
  const v = new THREE.Vector3();
  for (let g = 0; g < groups && spotCount < MAX_SPOTS - 3; g++) {
    const polar = activity > 0.5 && hash01(seed, g, 1) < 0.25;
    const lat = polar ? (hash01(seed, g, 2) < 0.5 ? 1 : -1) * (0.9 + 0.4 * hash01(seed, g, 3)) : (hash01(seed, g, 2) < 0.5 ? 1 : -1) * (0.12 + 0.5 * hash01(seed, g, 3));
    const lon = hash01(seed, g, 4) * Math.PI * 2;
    const size = (0.03 + 0.1 * hash01(seed, g, 5) * hash01(seed, g, 6)) * (0.55 + 1.7 * activity) * (polar ? 1.6 : 1);
    const members = 1 + Math.floor(hash01(seed, g, 7) * 3);
    for (let m = 0; m < members; m++) {
      const dl = m === 0 ? 0 : (m === 1 ? 1 : -0.6) * size * (2.2 + hash01(seed, g, 8 + m));
      const db = m === 0 ? 0 : (hash01(seed, g, 12 + m) - 0.5) * size * 1.2;
      const la = lat + db;
      const lo = lon + dl / Math.max(0.3, Math.cos(la));
      v.set(Math.cos(la) * Math.cos(lo), Math.sin(la), Math.cos(la) * Math.sin(lo));
      spots[spotCount++].set(v.x, v.y, v.z, size * (m === 0 ? 1 : 0.4 + 0.4 * hash01(seed, g, 16 + m)));
    }
  }

  // ---- bake
  const surfTarget = new THREE.WebGLCubeRenderTarget(q.surf, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.NoColorSpace,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  surfTarget.texture.name = 'tidelock.star.surface';
  const surfMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VS,
    fragmentShader: SURFACE_BAKE_FS,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uFace: { value: 0 },
      uInvSize: { value: 1 / q.surf },
      uSeed: { value: seedF },
      uActivity: { value: activity },
      // (never finer than ~9 texels per cell, or a small cube would alias)
      uCells: { value: Math.min(brownDwarf ? 9 : THREE.MathUtils.lerp(34, 19, cool), q.surf * 0.07) },
      uSpotCount: { value: spotCount },
      uSpots: { value: spots },
    },
  });
  bakeCubeFaces(renderer, surfTarget, surfMaterial);
  surfMaterial.dispose();

  const coronaTarget = new THREE.WebGLCubeRenderTarget(q.corona, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.NoColorSpace,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  coronaTarget.texture.name = 'tidelock.star.corona';
  const tilt = 0.15 + 0.5 * hash01(seed, 90, 0);
  const tiltLon = hash01(seed, 91, 0) * Math.PI * 2;
  const coronaMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VS,
    fragmentShader: CORONA_BAKE_FS,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uFace: { value: 0 },
      uInvSize: { value: 1 / q.corona },
      uSeed: { value: seedF + 3.3 },
      uActivity: { value: activity },
      uAxis: { value: new THREE.Vector3(Math.sin(tilt) * Math.cos(tiltLon), Math.cos(tilt), Math.sin(tilt) * Math.sin(tiltLon)) },
    },
  });
  bakeCubeFaces(renderer, coronaTarget, coronaMaterial);
  coronaMaterial.dispose();
  finishGpu(renderer, surfTarget);
  const bakeMs = performance.now() - t0;
  // surface cube with mips + corona cube, both RGBA8
  const gpuBytes = Math.round(q.surf * q.surf * 6 * 4 * (4 / 3)) + q.corona * q.corona * 6 * 4;

  // ---- colour model
  const base = starColorFromTemperature(temperature);
  // Hot plasma photographed through a filmic curve: a black body's true chromaticity is pale (a 3,400 K
  // dwarf is peach), so chroma is pushed for cool stars - an ember reads as an ember, a white star stays white.
  const photoTint = pushChroma(base, 1 + 1.3 * cool, new THREE.Vector3());
  // dimmer = cooler = redder; the exponents spread toward blue (Wien), most for cool stars
  const a = 0.2 + 1.0 * cool;
  const tempExp = new THREE.Vector3(1, 1 + a, 1 + 2.2 * a);
  // x: limb-darkening exponent, y: extra darkening of the extreme limb, z: spot depth, w: disc-centre boost
  // (a brown dwarf is too dim for a dark limb: it would read as an ink outline)
  const limb = new THREE.Vector4(whiteDwarf ? 0.35 : brownDwarf ? 0.5 : 0.55 + 0.4 * cool, whiteDwarf || brownDwarf ? 0.2 : 0.5, 0.035, 1 + 0.25 * cool);
  // corona: scattered photospheric light, a little paler than the disc
  const coronaCol = pushChroma(base, 1 + 0.75 * cool, new THREE.Vector3());
  // chromosphere / prominences: hydrogen red for sun-like and cooler stars, washing out to blue-white when hot
  const hot = THREE.MathUtils.clamp((temperature - 6200) / 2500, 0, 1);
  const chromoCol = new THREE.Vector3(1.0, 0.15, 0.07).lerp(new THREE.Vector3(base.r, base.g, base.b), 0.2 + 0.8 * hot);
  // a white dwarf is a featureless, searing point; a brown dwarf barely glows
  // (hot stars have radiative envelopes: no convection cells to see)
  const surfaceAmp = whiteDwarf ? 0.04 : 1 - 0.7 * THREE.MathUtils.clamp((temperature - 7000) / 2500, 0, 1);
  const coronaAmp = whiteDwarf ? 0.25 : brownDwarf ? 0.3 : 0.75 + 0.5 * activity;
  const power = brownDwarf ? 0.4 : whiteDwarf ? 1.1 : 1;

  const uniforms = {
    uSurf: { value: surfTarget.texture },
    uCorona: { value: coronaTarget.texture },
    uRight: { value: new THREE.Vector3(1, 0, 0) },
    uUp: { value: new THREE.Vector3(0, 1, 0) },
    uCamN: { value: new THREE.Vector3(0, 0, 1) },
    uGeom: { value: new THREE.Vector4(CORONA_EXTENT, 1, 100, 100) },
    uRotA: { value: new THREE.Matrix3() },
    uRotB: { value: new THREE.Matrix3() },
    uRotS: { value: new THREE.Matrix3() },
    uMix: { value: new THREE.Vector4(0, 1, 0, (q.surf * 2) / Math.PI) },
    uPhoto: { value: new THREE.Vector3(1, 1, 1) },
    uLimb: { value: limb },
    uTempExp: { value: tempExp },
    uAmp: { value: new THREE.Vector4(0.75 * surfaceAmp, 0.26 * surfaceAmp, 0.6 * surfaceAmp, 0.6 * surfaceAmp) },
    uCoronaCol: { value: coronaCol },
    uChromoCol: { value: chromoCol },
    uDetail: { value: new THREE.Vector4(1, 1, 1, 1) },
    uProm: { value: Array.from({ length: MAX_PROM }, () => new THREE.Vector4(0, 1, 0, 0)) },
    uPromB: { value: Array.from({ length: MAX_PROM }, () => new THREE.Vector4(0.05, 1, 0.2, 0)) },
  };

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), CORONA_EXTENT * 1.5);

  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: STAR_VS,
    fragmentShader: STAR_FS,
    uniforms,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: false,
    transparent: true,
    // premultiplied: the disc replaces what is behind it, the corona adds to it
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `star.${def.id}`;

  // scratch
  const n = new THREE.Vector3();
  const right = uniforms.uRight.value;
  const up = uniforms.uUp.value;
  const yAxis = new THREE.Vector3(0, 1, 0);
  const xAxis = new THREE.Vector3(1, 0, 0);
  const qSpin = new THREE.Quaternion();
  const qSpinInv = new THREE.Quaternion();
  const qA = new THREE.Quaternion();
  const m4 = new THREE.Matrix4();
  const anchor = new THREE.Vector3();
  const GRAN_TAU = 7; // seconds for one granulation pattern to hand over to the next
  const SPIN_RATE = 0.0016; // rad/s, cosmetic

  const setPatternRotation = (target: THREE.Matrix3, cycle: number, salt: number): void => {
    randomQuat(hash01(seed, cycle, salt), hash01(seed, cycle, salt + 10), hash01(seed, cycle, salt + 20), qA);
    qA.multiply(qSpinInv);
    target.setFromMatrix4(m4.makeRotationFromQuaternion(qA));
  };

  return {
    object3d: mesh,
    bakeMs,
    gpuBytes,
    update(ctx: StarUpdateContext): void {
      const time = ctx.time;
      // --- billboard basis facing the camera
      const dist = Math.max(ctx.cameraPosLocal.length(), 1e-6);
      n.copy(ctx.cameraPosLocal).multiplyScalar(1 / dist);
      right.crossVectors(Math.abs(n.y) < 0.99 ? yAxis : xAxis, n).normalize();
      up.crossVectors(n, right);
      uniforms.uCamN.value.copy(n);

      const pr = Math.max(ctx.pixelRadius, 1e-3);
      const inflate = Math.max(1, MIN_PIXEL_RADIUS / pr);
      const g = uniforms.uGeom.value;
      // keep the quad in front of the camera when it gets close
      const extent = Math.min(CORONA_EXTENT, Math.max(2.2, dist * 0.92));
      g.set(extent * inflate, inflate, Math.max(dist / inflate, 1.6), pr * inflate);

      // --- rotation and granulation hand-over
      qSpin.setFromAxisAngle(yAxis, time * SPIN_RATE);
      qSpinInv.copy(qSpin).invert();
      uniforms.uRotS.value.setFromMatrix4(m4.makeRotationFromQuaternion(qSpinInv));
      const u = time / GRAN_TAU;
      const fa = u * 0.5 - Math.floor(u * 0.5);
      const wA = 1 - Math.abs(2 * fa - 1);
      const wB = 1 - wA;
      setPatternRotation(uniforms.uRotA.value, Math.floor(u * 0.5), 1);
      setPatternRotation(uniforms.uRotB.value, Math.floor((u + 1) * 0.5), 2);
      const mix = uniforms.uMix.value;
      mix.x = wB;
      mix.y = 1 / Math.sqrt(wA * wA + wB * wB);
      mix.z = 0.5 + 0.5 * Math.sin(time * 0.021);

      // --- brightness: a far star is a brilliant point (55) and still ~10 when its disc spans a third of
      // the screen. Closer than that it fills so much of the frame that the bloom of such a radiance would
      // wash its own spots and granulation away, so it eases on down to 5 (still far above display white).
      const near = THREE.MathUtils.smoothstep(Math.log2(pr), 2.3, 8.0); // ~5 px .. ~256 px
      // a disc drawn larger than it really is (sub-pixel star) gives some of that light back
      const tiny = THREE.MathUtils.clamp((pr * pr) / (MIN_PIXEL_RADIUS * MIN_PIXEL_RADIUS), 0.2, 1);
      const intensity = THREE.MathUtils.lerp(55, 5, near) * power * tiny;
      uniforms.uPhoto.value.copy(photoTint).multiplyScalar(intensity);
      const detail = uniforms.uDetail.value;
      detail.x = near;
      detail.y = THREE.MathUtils.lerp(1.5, 0.8, near) * coronaAmp;
      detail.z = whiteDwarf ? 0 : THREE.MathUtils.lerp(0.5, 2 + 2.5 * cool, THREE.MathUtils.smoothstep(pr, 6, 70));
      detail.w = whiteDwarf || brownDwarf ? 0 : 6 * THREE.MathUtils.smoothstep(pr, 10, 60);

      // --- prominences: each slot lives through a cycle, then moves to a new anchor
      for (let i = 0; i < MAX_PROM; i++) {
        const pa = uniforms.uProm.value[i];
        const pb = uniforms.uPromB.value[i];
        if (i >= q.prominences) {
          pa.w = 0;
          continue;
        }
        const period = 46 + 50 * hash01(seed, i, 40);
        const tt = time / period + hash01(seed, i, 41);
        const cycle = Math.floor(tt);
        const f = tt - cycle;
        const active = hash01(seed, i * 131 + cycle, 42) < 0.3 + 0.6 * activity;
        const env = THREE.MathUtils.smoothstep(f, 0, 0.18) * (1 - THREE.MathUtils.smoothstep(f, 0.62, 1));
        if (!active || env <= 0.001) {
          pa.w = 0;
          continue;
        }
        const la = (hash01(seed, i * 131 + cycle, 43) - 0.5) * 1.9;
        const lo = hash01(seed, i * 131 + cycle, 44) * Math.PI * 2;
        anchor.set(Math.cos(la) * Math.cos(lo), Math.sin(la), Math.cos(la) * Math.sin(lo)).applyQuaternion(qSpin);
        const size = (0.05 + 0.13 * hash01(seed, i * 131 + cycle, 45)) * (0.6 + 0.8 * activity);
        pa.set(anchor.x, anchor.y, anchor.z, size * (0.55 + 0.75 * f));
        pb.set(size * (0.45 + 0.5 * hash01(seed, i * 131 + cycle, 46)), env, 0.11 + 0.09 * hash01(seed, i * 131 + cycle, 47), (hash01(seed, i * 131 + cycle, 48) - 0.5) * 0.9);
      }
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
      surfTarget.dispose();
      coronaTarget.dispose();
    },
  };
}

// -------------------------------------------------------------------------------------------------- glare

const GLARE_VS = /* glsl */ `
precision highp float;
in vec3 position;      // xy corner (-1..1)
in vec4 aElem;         // x: position along the flare axis (0 = on the star), y: half-size (iso units), z: kind, w: amplitude
in vec3 aTint;
uniform vec2 uStar;       // star centre in iso units
uniform vec2 uIsoToNdc;
uniform float uMainSize;
out vec2 vP;
out vec4 vElem;
out vec3 vTint;
void main() {
  bool isMain = aElem.z < 0.5;
  vec2 centre = isMain ? uStar : uStar * (1.0 - aElem.x);
  float halfSize = isMain ? uMainSize : aElem.y;
  vec2 off = position.xy * halfSize;
  vP = isMain ? off : position.xy;
  vElem = aElem;
  vTint = aTint;
  gl_Position = vec4((centre + off) * uIsoToNdc, 0.0, 1.0);
}
`;

const GLARE_FS = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform vec4 uAmp;       // core, halo, veil, spikes
uniform vec4 uShape;     // x: disc radius (iso), y: core width, z: halo width, w: spike length
uniform vec4 uMisc;      // x: main quad half-size, y: ghost gain, z: one pixel (iso), w: spike rotation
uniform vec2 uGhost;     // x: 1 = point-like star .. 0 = large disc, y: -
in vec2 vP;
in vec4 vElem;
in vec3 vTint;
out vec4 outColor;

void main() {
  vec3 col;
  if (vElem.z < 0.5) {
    float r = length(vP);
    float d = max(r - uShape.x, 0.0);
    float cw = uShape.y;
    float core = uAmp.x / pow(1.0 + (d * d) / (cw * cw), 1.5);
    float hw = uShape.z;
    float halo = uAmp.y / (1.0 + (d * d) / (hw * hw));
    float veil = uAmp.z * exp(-d * 2.4);

    // fine ciliary rays: faint, irregular radial streaks in the halo
    float ang = atan(vP.y, vP.x);
    float rays = sin(ang * 17.0 + 1.3) * sin(ang * 29.0 + 4.1) + 0.7 * sin(ang * 53.0 + 2.2) * sin(ang * 7.0 + 0.4)
               + 0.5 * sin(ang * 97.0 + 5.0) * sin(ang * 11.0 + 2.9);
    halo *= 1.0 + 0.13 * rays * smoothstep(0.0, hw * 2.0, d);

    // diffraction spikes of a six-bladed iris
    float spikes = 0.0;
    float cr = cos(uMisc.w);
    float sr = sin(uMisc.w);
    vec2 pr = vec2(cr * vP.x + sr * vP.y, -sr * vP.x + cr * vP.y);
    for (int i = 0; i < 3; i++) {
      float a = float(i) * 1.0471976;
      vec2 t = vec2(cos(a), sin(a));
      float along = abs(dot(pr, t));
      float across = abs(pr.x * t.y - pr.y * t.x);
      float wdt = uMisc.z * 0.85 + along * 0.009;
      float lobe = exp(-across / wdt);
      float len = uShape.w * (i == 0 ? 1.0 : 0.72);
      float al = max(along - uShape.x, 0.0);
      spikes += lobe / (1.0 + (al * al) / (len * len * 0.09)) * exp(-al / len);
    }
    float win = smoothstep(uMisc.x, uMisc.x * 0.55, r);
    // a point-like star burns out; a large disc is left alone (its surface must stay readable)
    win *= mix(smoothstep(uShape.x * 0.97, uShape.x * 1.03, r), 1.0, uGhost.x);
    float total = (core + halo + veil + spikes * uAmp.w) * win;
    col = uColor * total;
    // the very core of a point-like star burns to white
    col += vec3(1.0) * (0.2 * core * win * smoothstep(2.0, 8.0, core));
  } else {
    // lens ghosts: faint, slightly coloured aperture images strung along the flare axis
    float r = length(vP);
    float g;
    if (vElem.z < 1.5) {
      g = smoothstep(1.0, 0.45, r) * (0.6 + 0.4 * r * r);             // soft disc, slightly brighter rim
    } else if (vElem.z < 2.5) {
      g = exp(-pow((r - 0.78) / 0.07, 2.0));                           // thin ring
    } else {
      // hexagonal iris image
      vec2 a = abs(vP);
      float hex = max(a.x * 0.866025 + a.y * 0.5, a.y);
      g = smoothstep(0.86, 0.6, hex) * (0.6 + 0.4 * hex);
    }
    col = uColor * vTint * (g * vElem.w * uMisc.y);
  }
  outColor = vec4(col, 0.0);
}
`;

export interface StarGlareContext {
  /** Unit direction to the star in view space (camera looks down -Z). */
  starDirView: THREE.Vector3;
  /** Linear colour of the star. */
  starColor: THREE.Color;
  /** Angular radius of the disc, rad. */
  angularRadius: number;
  /** 0..1 fraction of the disc not occulted by planets. */
  visibility: number;
  /** Viewport width / height. */
  aspect: number;
  /** Vertical field of view, radians (values above pi are taken as degrees). */
  fov: number;
}

export interface StarGlare {
  /** Places itself in screen space; add it to the last scene drawn (it ignores depth and camera matrices). */
  object3d: THREE.Object3D;
  update(ctx: StarGlareContext): void;
  dispose(): void;
}

const GHOSTS: { k: number; size: number; kind: number; amp: number; tint: [number, number, number] }[] = [
  { k: 1.55, size: 0.04, kind: 1, amp: 0.016, tint: [0.55, 0.85, 1.0] },
  { k: 2.25, size: 0.085, kind: 3, amp: 0.007, tint: [1.0, 0.75, 0.5] },
  { k: 0.62, size: 0.022, kind: 1, amp: 0.02, tint: [0.7, 1.0, 0.8] },
  { k: 1.22, size: 0.014, kind: 1, amp: 0.024, tint: [1.0, 0.9, 0.7] },
  { k: 1.9, size: 0.13, kind: 1, amp: 0.004, tint: [0.75, 0.7, 1.0] },
  { k: 2.8, size: 0.055, kind: 3, amp: 0.006, tint: [0.6, 0.9, 0.95] },
];

export function createStarGlare(quality: Quality): StarGlare {
  const ghostCount = quality === 'low' ? 0 : quality === 'medium' ? 3 : quality === 'high' ? 5 : 6;
  const quads = 1 + ghostCount;
  const position = new Float32Array(quads * 4 * 3);
  const elem = new Float32Array(quads * 4 * 4);
  const tint = new Float32Array(quads * 4 * 3);
  const index: number[] = [];
  const corners = [-1, -1, 1, -1, 1, 1, -1, 1];
  for (let e = 0; e < quads; e++) {
    const gh = e > 0 ? GHOSTS[e - 1] : null;
    for (let c = 0; c < 4; c++) {
      const vi = e * 4 + c;
      position[vi * 3] = corners[c * 2];
      position[vi * 3 + 1] = corners[c * 2 + 1];
      position[vi * 3 + 2] = 0;
      elem[vi * 4] = gh ? gh.k : 0;
      elem[vi * 4 + 1] = gh ? gh.size : 0;
      elem[vi * 4 + 2] = gh ? gh.kind : 0;
      elem[vi * 4 + 3] = gh ? gh.amp : 1;
      tint[vi * 3] = gh ? gh.tint[0] : 1;
      tint[vi * 3 + 1] = gh ? gh.tint[1] : 1;
      tint[vi * 3 + 2] = gh ? gh.tint[2] : 1;
    }
    index.push(e * 4, e * 4 + 1, e * 4 + 2, e * 4, e * 4 + 2, e * 4 + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aElem', new THREE.BufferAttribute(elem, 4));
  geometry.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
  geometry.setIndex(index);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

  const uniforms = {
    uStar: { value: new THREE.Vector2() },
    uIsoToNdc: { value: new THREE.Vector2(1, 1) },
    uMainSize: { value: 1.2 },
    uColor: { value: new THREE.Vector3(1, 1, 1) },
    uAmp: { value: new THREE.Vector4() },
    uShape: { value: new THREE.Vector4(0.01, 0.004, 0.03, 0.3) },
    uMisc: { value: new THREE.Vector4(1.2, 0, 0.002, SPIKE_ROTATION) },
    uGhost: { value: new THREE.Vector2(1, 0) },
  };
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: GLARE_VS,
    fragmentShader: GLARE_FS,
    uniforms,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1000;
  mesh.name = 'star.glare';
  mesh.visible = false;

  const viewport = new THREE.Vector4();
  let pixelIso = 0.002;
  let sqrtAspect = 1;
  mesh.onBeforeRender = (r) => {
    r.getCurrentViewport(viewport);
    // one pixel in iso units (iso: the screen has area 4, whatever its aspect)
    pixelIso = 2 / (Math.max(1, viewport.w) * sqrtAspect);
    uniforms.uMisc.value.z = pixelIso;
  };

  return {
    object3d: mesh,
    update(ctx: StarGlareContext): void {
      const vis = Math.min(1, Math.max(0, ctx.visibility));
      const dir = ctx.starDirView;
      if (vis <= 0.002 || dir.z > -0.08) {
        mesh.visible = false;
        return;
      }
      const fov = ctx.fov > Math.PI ? (ctx.fov * Math.PI) / 180 : ctx.fov;
      const th = Math.tan(fov * 0.5);
      sqrtAspect = Math.sqrt(Math.max(ctx.aspect, 1e-3));
      const ndcX = dir.x / -dir.z / (th * ctx.aspect);
      const ndcY = dir.y / -dir.z / th;
      const mainSize = 1.25;
      // outside the screen by more than the glare can reach: nothing to draw
      const reachX = mainSize / sqrtAspect;
      const reachY = mainSize * sqrtAspect;
      if (Math.abs(ndcX) > 1 + reachX || Math.abs(ndcY) > 1 + reachY) {
        mesh.visible = false;
        return;
      }
      mesh.visible = true;
      uniforms.uIsoToNdc.value.set(1 / sqrtAspect, sqrtAspect);
      uniforms.uStar.value.set(ndcX * sqrtAspect, ndcY / sqrtAspect);
      uniforms.uMainSize.value = mainSize;
      // lens glare takes the star's colour, a little richer than the black body (as the disc does)
      const cmax = Math.max(ctx.starColor.r, ctx.starColor.g, ctx.starColor.b, 1e-6);
      const cr = Math.pow(ctx.starColor.r / cmax, 1.5);
      const cg = Math.pow(ctx.starColor.g / cmax, 1.5);
      const cb = Math.pow(ctx.starColor.b / cmax, 1.5);
      uniforms.uColor.value.set(cr, cg, cb);

      const rIso = Math.tan(Math.min(ctx.angularRadius, 1.2)) / th / sqrtAspect;
      // 1 when the star is a point, 0 when it is a large disc (then the disc itself is the light source)
      const small = 1 - THREE.MathUtils.smoothstep(rIso, 0.012, 0.16);
      // how far off-screen the star is (0 on screen .. 1 well outside)
      const off = THREE.MathUtils.smoothstep(Math.max(Math.abs(ndcX), Math.abs(ndcY)), 0.95, 1.5);
      const amp = uniforms.uAmp.value;
      // a large disc is its own light source (the bloom of the pipeline does the rest): the lens glare
      // belongs to the far, point-like star
      amp.x = vis * (0.3 + 22 * small);
      amp.y = vis * (0.015 + 0.95 * small);
      amp.z = vis * (0.004 + 0.05 * small);
      amp.w = vis * vis * (0.03 + 1.3 * small) * (1 - 0.7 * off);
      const shape = uniforms.uShape.value;
      shape.x = rIso;
      shape.y = Math.max(rIso * 0.35, 1.6 * pixelIso) + 0.0025;
      shape.z = 0.03 + rIso * 0.5;
      shape.w = (0.16 + 0.3 * small) * (0.4 + 0.6 * vis);
      const misc = uniforms.uMisc.value;
      misc.x = mainSize;
      // ghosts line up along the axis through the screen centre; when the star sits on that centre they
      // would stack into a bullseye, so they fade there
      const axis = THREE.MathUtils.smoothstep(Math.hypot(ndcX * sqrtAspect, ndcY / sqrtAspect), 0.05, 0.4);
      misc.y = vis * vis * (1 - off) * small * axis * 7;
      misc.w = SPIKE_ROTATION;
      uniforms.uGhost.value.x = small;
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
