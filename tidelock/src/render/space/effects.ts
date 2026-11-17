// TIDELOCK visual effects: engine plumes, pooled GPU particles, beams, explosions, shields, jump effects,
// re-entry plasma, docking guides, space dust, strobes and cargo canisters.
//
// Everything here is additive / HDR (light units: emissive 2-8, cores 10-60, see docs/ARCHITECTURE.md),
// procedural, pooled and allocation-free per frame.
//
// Frames
//   * EffectsManager.object3d is a plain group. All positions / velocities passed to the manager are in that
//     group's local frame ("fx frame": metres, a non-rotating frame chosen by the scene manager, normally the
//     one co-moving with the focused vessel). The scene manager positions the group (floating origin); the
//     `cameraPos` given to update() is the camera position in the same fx frame.
//   * Attachable effects (plumes, strobes, canisters) return an object3d to parent under a ship / station.
//
// Draw calls (EffectsManager, only while the respective effect is alive): particles 1, immediate sprites 1,
// beams 1, debris chunks 1, shield / jump bubbles 1, jump tunnel 1, space dust 1, re-entry sheath 1 per ship.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { RGB, V3 } from '../../core/types';

export type FxQuality = 'low' | 'medium' | 'high' | 'ultra';
export type PlumeKind = 'fusion' | 'chemical' | 'ion';
export type ExplosionKind = 'small' | 'ship' | 'large' | 'rock';

// ------------------------------------------------------------------------------------------------ utilities

/** Cosmetic xorshift RNG (deterministic so harness stills are repeatable). */
let _seed = 0x2f6e2b1 | 0;
function rnd(): number {
  _seed ^= _seed << 13;
  _seed ^= _seed >>> 17;
  _seed ^= _seed << 5;
  return (_seed >>> 0) / 4294967296;
}
function rr(lo: number, hi: number): number {
  return lo + (hi - lo) * rnd();
}
/** Re-seed the cosmetic RNG (harness determinism). */
export function seedEffectsRng(seed: number): void {
  _seed = (seed | 0) || 0x2f6e2b1;
}

// scratch direction (unit) written by randDir / coneDir
let _dx = 0;
let _dy = 0;
let _dz = 1;
function randDir(): void {
  const z = rnd() * 2 - 1;
  const a = rnd() * Math.PI * 2;
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  _dx = s * Math.cos(a);
  _dy = s * Math.sin(a);
  _dz = z;
}
/** Random unit direction within `spread` (0 = along axis, 1 = hemisphere, 2 = full sphere) of a unit axis. */
function coneDir(ax: number, ay: number, az: number, spread: number): void {
  // orthonormal basis around the axis
  let ux: number, uy: number, uz: number;
  if (Math.abs(ay) < 0.9) {
    // u = axis x Y
    ux = -az;
    uy = 0;
    uz = ax;
  } else {
    // u = axis x X
    ux = 0;
    uy = az;
    uz = -ay;
  }
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const wx = ay * uz - az * uy;
  const wy = az * ux - ax * uz;
  const wz = ax * uy - ay * ux;
  const c = 1 - rnd() * Math.min(2, Math.max(0, spread));
  const s = Math.sqrt(Math.max(0, 1 - c * c));
  const a = rnd() * Math.PI * 2;
  const cu = s * Math.cos(a);
  const cw = s * Math.sin(a);
  _dx = ax * c + ux * cu + wx * cw;
  _dy = ay * c + uy * cu + wy * cw;
  _dz = az * c + uz * cu + wz * cw;
}

/** Approximate black-body colour (linear RGB, max component 1) for a temperature in kelvin. */
export function blackbodyColor(kelvin: number): RGB {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const lin = (c: number): number => Math.pow(Math.min(255, Math.max(0, c)) / 255, 2.2);
  const out: RGB = [lin(r), lin(g), lin(b)];
  const m = Math.max(out[0], out[1], out[2]) || 1;
  return [out[0] / m, out[1] / m, out[2] / m];
}

// ---- shared tileable 3D noise (32^3 RGBA8, four decorrelated fbm channels), reference counted

let noiseTex: THREE.Data3DTexture | null = null;
let noiseRefs = 0;

function buildNoise3D(n: number): Uint8Array {
  const out = new Uint8Array(n * n * n * 4);
  let s = 0x9e3779b9;
  const rand = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const acc = new Float32Array(n * n * n);
  for (let c = 0; c < 4; c++) {
    acc.fill(0);
    let amp = 0.5;
    for (const p of [4, 8, 16]) {
      const lat = new Float32Array(p * p * p);
      for (let i = 0; i < lat.length; i++) lat[i] = rand();
      const k = p / n;
      for (let z = 0; z < n; z++) {
        const fz = z * k;
        const z0 = Math.floor(fz);
        let tz = fz - z0;
        tz = tz * tz * (3 - 2 * tz);
        const z1 = (z0 + 1) % p;
        for (let y = 0; y < n; y++) {
          const fy = y * k;
          const y0 = Math.floor(fy);
          let ty = fy - y0;
          ty = ty * ty * (3 - 2 * ty);
          const y1 = (y0 + 1) % p;
          for (let x = 0; x < n; x++) {
            const fx = x * k;
            const x0 = Math.floor(fx);
            let tx = fx - x0;
            tx = tx * tx * (3 - 2 * tx);
            const x1 = (x0 + 1) % p;
            const a00 = lat[(z0 * p + y0) * p + x0] * (1 - tx) + lat[(z0 * p + y0) * p + x1] * tx;
            const a01 = lat[(z0 * p + y1) * p + x0] * (1 - tx) + lat[(z0 * p + y1) * p + x1] * tx;
            const a10 = lat[(z1 * p + y0) * p + x0] * (1 - tx) + lat[(z1 * p + y0) * p + x1] * tx;
            const a11 = lat[(z1 * p + y1) * p + x0] * (1 - tx) + lat[(z1 * p + y1) * p + x1] * tx;
            acc[(z * n + y) * n + x] += amp * ((a00 * (1 - ty) + a01 * ty) * (1 - tz) + (a10 * (1 - ty) + a11 * ty) * tz);
          }
        }
      }
      amp *= 0.55;
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < acc.length; i++) {
      if (acc[i] < lo) lo = acc[i];
      if (acc[i] > hi) hi = acc[i];
    }
    const sc = 255 / (hi - lo);
    for (let i = 0; i < acc.length; i++) out[i * 4 + c] = Math.round((acc[i] - lo) * sc);
  }
  return out;
}

function acquireNoise3D(): THREE.Data3DTexture {
  if (!noiseTex) {
    const n = 32;
    const tex = new THREE.Data3DTexture(buildNoise3D(n), n, n, n);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.UnsignedByteType;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.wrapR = THREE.RepeatWrapping;
    tex.generateMipmaps = false;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    noiseTex = tex;
  }
  noiseRefs++;
  return noiseTex;
}
function releaseNoise3D(): void {
  if (--noiseRefs <= 0 && noiseTex) {
    noiseTex.dispose();
    noiseTex = null;
    noiseRefs = 0;
  }
}

// ---- viewport height (pixels) shared by every sprite-like material, refreshed in onBeforeRender

const sharedViewH = { value: 800 };
const _vp = new THREE.Vector4();
function hookViewport(obj: THREE.Object3D, mat: THREE.ShaderMaterial): void {
  obj.onBeforeRender = (renderer: THREE.WebGLRenderer): void => {
    renderer.getCurrentViewport(_vp);
    sharedViewH.value = _vp.w;
    mat.uniformsNeedUpdate = true;
  };
}

function makeQuadGeometry(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

const GLSL_IGN = /* glsl */ `
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`;

// ================================================================================================ engine plume

export interface EnginePlumeOptions {
  /** Nozzle exit radius, m. */
  radius: number;
  kind?: PlumeKind;
  /** Sheath tint, linear RGB (defaults per kind). */
  color?: RGB;
  /** Alternative to `color`: exhaust temperature in kelvin (black-body tint). */
  temperature?: number;
  /** Multiplies the default plume length. */
  lengthScale?: number;
  quality?: FxQuality;
}

export interface EnginePlume {
  /** Attach at the nozzle exit plane; exhaust leaves toward local +Z. */
  object3d: THREE.Object3D;
  /** Commanded throttle 0..1 (the plume follows with spool-up lag). */
  setThrottle(throttle: number): void;
  update(dt: number, time: number): void;
  /** Current spooled output 0..1 (drive hull glow / audio from this). */
  readonly level: number;
  dispose(): void;
}

interface PlumeParams {
  len: number;
  endRadius: number;
  core: number;
  sheath: number;
  spread: number;
  cell: number;
  cellDecay: number;
  shock: number;
  jet: number;
  flow: number;
  absorb: number;
  coreI: number;
  sheathI: number;
  whiten: number;
  tint: RGB;
  tauUp: number;
  tauDown: number;
}

const PLUME_PARAMS: Record<PlumeKind, PlumeParams> = {
  // long, needle-sharp magnetically confined torch
  fusion: {
    len: 30, endRadius: 3.6, core: 0.3, sheath: 0.82, spread: 0.032, cell: 2.5, cellDecay: 9, shock: 1.0, jet: 0.6,
    flow: 1.3, absorb: 1.5, coreI: 34, sheathI: 2.4, whiten: 0.78, tint: [0.26, 0.5, 1.0], tauUp: 0.45, tauDown: 0.6,
  },
  // short, wide, under-expanded vacuum flare with strong shock cells near the bell
  chemical: {
    len: 15, endRadius: 5.2, core: 0.4, sheath: 1.15, spread: 0.1, cell: 1.75, cellDecay: 5, shock: 1.2, jet: 0.72,
    flow: 2.2, absorb: 1.1, coreI: 15, sheathI: 1.35, whiten: 0.62, tint: [1.0, 0.46, 0.17], tauUp: 0.12, tauDown: 0.3,
  },
  // faint, soft, slowly breathing beam
  ion: {
    len: 11, endRadius: 2.8, core: 0.5, sheath: 0.95, spread: 0.04, cell: 3, cellDecay: 1, shock: 0.0, jet: 0.6,
    flow: 0.35, absorb: 0.45, coreI: 5.5, sheathI: 1.25, whiten: 0.45, tint: [0.22, 0.72, 1.0], tauUp: 0.9, tauDown: 1.1,
  },
};

const PLUME_STEPS: Record<FxQuality, number> = { low: 10, medium: 14, high: 20, ultra: 28 };
const PLUME_Z0 = -0.45;
const PLUME_R0 = 0.8;

const PLUME_VERT = /* glsl */ `
precision highp float;
in vec4 aNozzle;
uniform mat4 uInvModel;
out vec3 vPos;
flat out vec3 vCam;
flat out float vSeed;
void main() {
  vPos = position;
  vec3 camLocal = (uInvModel * vec4(cameraPosition, 1.0)).xyz;
  vCam = (camLocal - aNozzle.xyz) / aNozzle.w;
  vSeed = fract(dot(aNozzle.xyz, vec3(0.3183, 0.7071, 0.1731)));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(aNozzle.xyz + position * aNozzle.w, 1.0);
}
`;

const PLUME_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler3D uNoise;
uniform vec3 uTint;      // sheath radiance
uniform vec3 uCoreCol;   // core source radiance
uniform float uTime;
uniform vec4 uShape;     // x current length, y core radius, z sheath radius, w spread   (all in nozzle radii)
uniform vec4 uShock;     // x cell length, y decay length, z strength, w jet radius
uniform vec4 uBound;     // z0, r0, slope, z1
uniform vec4 uMisc;      // x flow speed, y turbulence, z absorption, w level
in vec3 vPos;
flat in vec3 vCam;
flat in float vSeed;
${GLSL_IGN}

// emission (rgb) and extinction (a) per nozzle radius of path
vec4 plume(vec3 p) {
  float z = p.z;
  float r2 = dot(p.xy, p.xy);
  float rb = uBound.y + uBound.z * (z - uBound.x);
  float win = clamp(1.0 - r2 / (rb * rb), 0.0, 1.0);
  win *= win;
  float zz = max(z, 0.0);
  float s = zz / uShape.x;
  float tail = 1.0 - smoothstep(0.45, 1.0, s);
  float r = sqrt(r2);

  // turbulence advected downstream
  vec3 q = vec3(p.xy * 0.19, z * 0.055 - uTime * uMisc.x) + vSeed;
  vec4 nz = texture(uNoise, q);
  float n = nz.r;
  float fine = texture(uNoise, q * vec3(2.9, 2.9, 2.3) + 0.41).g;

  // standing shock cells: the jet boundary breathes and oblique shock cones converge on bright nodes
  float sd = exp(-zz / uShock.y) * uShock.z;
  float cell = zz / uShock.x + 0.42 + (nz.b - 0.5) * 0.1;
  float tri = abs(2.0 * fract(cell) - 1.0);
  float grow = 1.0 + zz * uShape.w;
  float rj = uShock.w * grow;
  float cone = exp(-pow((r - rj * tri) / (0.15 * rj + 0.02), 2.0)) * sd;
  float node = exp(-pow(tri / 0.22, 2.0)) * exp(-r2 / (0.12 * rj * rj)) * sd;

  float rc = uShape.y * grow * mix(1.0, 0.55 + 0.75 * tri, clamp(sd, 0.0, 1.0));
  float core = exp(-r2 / (rc * rc)) * exp(-s * 2.4) * (0.75 + 0.5 * fine);

  float rs = uShape.z * (1.0 + zz * uShape.w * 2.2);
  float sheath = exp(-r2 / (rs * rs)) * exp(-s * 1.7) * mix(1.0, 0.25 + 1.5 * n, uMisc.y);
  // faint outer wisps torn off the sheath
  float wisp = exp(-r2 / (rs * rs * 3.2)) * exp(-s * 1.1) * fine * n * 0.5;

  // glow filling the bell
  float inside = smoothstep(0.08, -0.12, z) * exp(-r2 / 0.42);

  float sigC = uMisc.z * ((core + cone * 0.9 + node * 2.6) * tail + inside * 2.5);
  vec3 e = uCoreCol * sigC + uTint * ((sheath + wisp) * tail * (1.0 + cone * 1.5) + inside * 0.5);
  return vec4(e, sigC + sheath * 0.08) * win;
}

void main() {
  vec3 ro = vCam;
  vec3 d = vPos - vCam;
  float tFar = length(d);
  vec3 rd = d / tFar;
  float tNear = 0.0;
  if (abs(rd.z) > 1e-5) {
    float ta = (uBound.x - ro.z) / rd.z;
    float tb = (uBound.w - ro.z) / rd.z;
    tNear = max(tNear, min(ta, tb));
  }
  float a0 = uBound.y + uBound.z * (ro.z - uBound.x);
  float b = uBound.z * rd.z;
  float A = dot(rd.xy, rd.xy) - b * b;
  float B = 2.0 * (dot(ro.xy, rd.xy) - a0 * b);
  float C = dot(ro.xy, ro.xy) - a0 * a0;
  float disc = B * B - 4.0 * A * C;
  if (abs(A) > 1e-6) {
    if (disc > 0.0) {
      float te = (-B - sqrt(disc)) / (2.0 * A);
      if (A > 0.0 || (a0 + b * te) > 0.0) tNear = max(tNear, te);
    } else if (A > 0.0) {
      discard;
    }
  }
  float span = tFar - tNear;
  if (span <= 0.0) discard;
  float dt = span / float(STEPS);
  float t = tNear + dt * ign(gl_FragCoord.xy);
  vec3 col = vec3(0.0);
  float T = 1.0;
  for (int i = 0; i < STEPS; i++) {
    vec4 es = plume(ro + rd * t);
    float a = 1.0 - exp(-es.a * dt);
    col += T * es.rgb * (es.a > 1e-3 ? a / es.a : dt);
    T *= 1.0 - a;
    t += dt;
  }
  gl_FragColor = vec4(col * uMisc.w, 1.0);
}
`;

/** One plume per nozzle, all in a single instanced draw call. Nozzle positions are in the parent's local frame. */
export function createEnginePlumes(nozzles: readonly { pos: V3; radius: number }[], opts: Omit<EnginePlumeOptions, 'radius'> = {}): EnginePlume {
  const kind = opts.kind ?? 'fusion';
  const P = PLUME_PARAMS[kind];
  const quality = opts.quality ?? 'high';
  const tint: RGB = opts.color ?? (opts.temperature !== undefined ? blackbodyColor(opts.temperature) : P.tint);
  const len = P.len * (opts.lengthScale ?? 1);
  const noise = acquireNoise3D();

  // bounding frustum in nozzle radii: z from inside the bell to the plume end
  const h = len - PLUME_Z0;
  const base = new THREE.CylinderGeometry(P.endRadius, PLUME_R0, h, 20, 1, false);
  base.rotateX(Math.PI / 2);
  base.translate(0, 0, PLUME_Z0 + h / 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setIndex(base.getIndex());
  const inst = new Float32Array(nozzles.length * 4);
  let reach = 0;
  for (let i = 0; i < nozzles.length; i++) {
    const nz = nozzles[i];
    inst[i * 4] = nz.pos.x;
    inst[i * 4 + 1] = nz.pos.y;
    inst[i * 4 + 2] = nz.pos.z;
    inst[i * 4 + 3] = nz.radius;
    reach = Math.max(reach, Math.hypot(nz.pos.x, nz.pos.y, nz.pos.z) + nz.radius * (len + P.endRadius));
  }
  geo.setAttribute('aNozzle', new THREE.InstancedBufferAttribute(inst, 4));
  geo.instanceCount = nozzles.length;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), reach);

  const w = P.whiten;
  const uniforms = {
    uNoise: { value: noise },
    uTint: { value: new THREE.Vector3(tint[0] * P.sheathI, tint[1] * P.sheathI, tint[2] * P.sheathI) },
    uCoreCol: {
      value: new THREE.Vector3((tint[0] * (1 - w) + w) * P.coreI, (tint[1] * (1 - w) + w) * P.coreI, (tint[2] * (1 - w) + w) * P.coreI),
    },
    uTime: { value: 0 },
    uShape: { value: new THREE.Vector4(len, P.core, P.sheath, P.spread) },
    uShock: { value: new THREE.Vector4(P.cell, P.cellDecay, P.shock, P.jet) },
    uBound: { value: new THREE.Vector4(PLUME_Z0, PLUME_R0, (P.endRadius - PLUME_R0) / h, len) },
    uMisc: { value: new THREE.Vector4(P.flow, 1, P.absorb, 0) },
    uInvModel: { value: new THREE.Matrix4() },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: PLUME_VERT,
    fragmentShader: PLUME_FRAG,
    defines: { STEPS: PLUME_STEPS[quality] },
    side: THREE.BackSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = `plume:${kind}`;
  mesh.renderOrder = 20;
  mesh.visible = false;
  mesh.onBeforeRender = (): void => {
    uniforms.uInvModel.value.copy(mesh.matrixWorld).invert();
    mat.uniformsNeedUpdate = true;
  };

  let target = 0;
  let level = 0;
  let kick = 0; // ignition transient
  let clock = rnd() * 50;

  return {
    object3d: mesh,
    setThrottle(throttle: number): void {
      const t = throttle < 0 ? 0 : throttle > 1 ? 1 : throttle;
      if (t > 0.05 && target <= 0.05 && level < 0.05) kick = 1;
      target = t;
    },
    update(dt: number, _time: number): void {
      clock += dt;
      const tau = target > level ? P.tauUp : P.tauDown;
      level += (target - level) * (1 - Math.exp(-dt / tau));
      if (level < 0.0005 && target === 0) level = 0;
      kick *= Math.exp(-dt / 0.18);
      mesh.visible = level > 0.001;
      if (!mesh.visible) return;
      const flick = 1 + 0.035 * Math.sin(clock * 47.0) + 0.025 * Math.sin(clock * 113.0 + 1.3);
      uniforms.uTime.value = clock % 512;
      uniforms.uShape.value.x = len * (0.22 + 0.78 * Math.pow(level, 0.8));
      uniforms.uMisc.value.w = Math.pow(level, 1.15) * flick * (1 + kick * 0.9);
      // shock cells stretch as chamber pressure rises
      uniforms.uShock.value.x = P.cell * (0.7 + 0.3 * level);
    },
    get level(): number {
      return level;
    },
    dispose(): void {
      mesh.removeFromParent();
      geo.dispose();
      base.dispose();
      mat.dispose();
      releaseNoise3D();
    },
  };
}

/** A single plume at the origin of its object3d. */
export function createEnginePlume(opts: EnginePlumeOptions): EnginePlume {
  return createEnginePlumes([{ pos: { x: 0, y: 0, z: 0 }, radius: opts.radius }], opts);
}

// ================================================================================================ strobes

export interface StrobeDef {
  pos: V3;
  color: RGB;
  /** Blink period, s (0 = steady). */
  blink: number;
  /** Apparent lamp radius, m (default 0.12). */
  size?: number;
}

export interface Strobes {
  object3d: THREE.Object3D;
  update(dt: number, time: number): void;
  dispose(): void;
}

const STROBE_VERT = /* glsl */ `
precision highp float;
in vec4 aPosSize;
in vec4 aColBlink;
uniform float uTime;
uniform float uViewH;
uniform float uGain;
out vec2 vUv;
out vec3 vCol;
void main() {
  float period = aColBlink.w;
  float on = 1.0;
  if (period > 0.0) {
    float ph = fract(uTime / period + fract(aPosSize.x * 0.37 + aPosSize.z * 0.11));
    // double flash
    on = max(exp(-ph * period * 28.0), 0.8 * exp(-abs(ph * period - 0.16) * 34.0));
  }
  vec4 mv = modelViewMatrix * vec4(aPosSize.xyz, 1.0);
  float size = aPosSize.w * 7.0;
  float px = size * projectionMatrix[1][1] * uViewH * 0.5 / max(-mv.z, 0.01);
  float boost = 1.0;
  if (px < 5.0) { boost = max(px / 5.0, 0.22); size *= 5.0 / max(px, 1e-3); }
  mv.xy += position.xy * size;
  vUv = position.xy;
  vCol = aColBlink.rgb * on * uGain * boost;
  gl_Position = on < 0.004 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
}
`;
const STROBE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
in vec3 vCol;
void main() {
  float d2 = dot(vUv, vUv);
  float core = exp(-d2 * 46.0);
  float halo = max(exp(-d2 * 5.0) - 0.0067, 0.0) * 0.1;
  float streak = exp(-abs(vUv.y) * 30.0) * max(1.0 - abs(vUv.x), 0.0) * 0.1;
  gl_FragColor = vec4(vCol * (core + halo + streak), 1.0);
}
`;

/** Navigation lights / strobes / beacons as HDR sprites (one draw call). Accepts ShipLayout.lights directly. */
export function createStrobes(lights: readonly StrobeDef[], opts: { intensity?: number } = {}): Strobes {
  const geo = makeQuadGeometry();
  const a = new Float32Array(lights.length * 4);
  const c = new Float32Array(lights.length * 4);
  let reach = 0;
  for (let i = 0; i < lights.length; i++) {
    const l = lights[i];
    a.set([l.pos.x, l.pos.y, l.pos.z, l.size ?? 0.12], i * 4);
    c.set([l.color[0], l.color[1], l.color[2], l.blink], i * 4);
    reach = Math.max(reach, Math.hypot(l.pos.x, l.pos.y, l.pos.z) + 2);
  }
  geo.setAttribute('aPosSize', new THREE.InstancedBufferAttribute(a, 4));
  geo.setAttribute('aColBlink', new THREE.InstancedBufferAttribute(c, 4));
  geo.instanceCount = lights.length;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), reach);
  const uniforms = { uTime: { value: 0 }, uViewH: sharedViewH, uGain: { value: opts.intensity ?? 7 } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: STROBE_VERT,
    fragmentShader: STROBE_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'strobes';
  mesh.renderOrder = 25;
  hookViewport(mesh, mat);
  let clock = 0;
  return {
    object3d: mesh,
    update(dt: number, _time: number): void {
      clock = (clock + dt) % 3600;
      uniforms.uTime.value = clock;
    },
    dispose(): void {
      mesh.removeFromParent();
      geo.dispose();
      mat.dispose();
    },
  };
}

// ================================================================================================ cargo canister

export interface CargoCanister {
  /** ~2.0 m long (local Z) x 1.2 m across, origin at the centre. */
  object3d: THREE.Mesh;
  update(dt: number, time: number): void;
  dispose(): void;
}

let canisterGeo: THREE.BufferGeometry | null = null;
let canisterRefs = 0;

function paint(g: THREE.BufferGeometry, r: number, gg: number, b: number): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    c[i * 3] = r;
    c[i * 3 + 1] = gg;
    c[i * 3 + 2] = b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}
function flat(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const f = g.index ? g.toNonIndexed() : g;
  f.computeVertexNormals();
  return f;
}
function zCyl(r0: number, r1: number, len: number, seg: number, z: number, twist = 0): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, false);
  if (twist) g.rotateY(twist);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, z);
  return flat(g);
}

function buildCanisterGeometry(stripe: RGB): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const tw = Math.PI / 8;
  const body: [number, number, number] = [0.5, 0.51, 0.5];
  const dark: [number, number, number] = [0.07, 0.075, 0.085];
  const steel: [number, number, number] = [0.32, 0.33, 0.35];
  // octagonal pressure body with a livery band
  parts.push(paint(zCyl(0.54, 0.54, 0.62, 8, -0.47, tw), ...body));
  parts.push(paint(zCyl(0.545, 0.545, 0.3, 8, -0.01, tw), stripe[0], stripe[1], stripe[2]));
  parts.push(paint(zCyl(0.54, 0.54, 0.64, 8, 0.46, tw), ...body));
  // reinforcing hoops
  for (const z of [-0.8, -0.16, 0.14, 0.8]) parts.push(paint(zCyl(0.585, 0.585, 0.06, 8, z, tw), ...dark));
  // chamfered ends, recessed plates, grapple bosses
  for (const sgn of [-1, 1]) {
    parts.push(paint(zCyl(sgn < 0 ? 0.44 : 0.54, sgn < 0 ? 0.54 : 0.44, 0.14, 8, sgn * 0.87, tw), ...steel));
    parts.push(paint(zCyl(0.4, 0.4, 0.04, 8, sgn * 0.93, tw), ...dark));
    parts.push(paint(zCyl(sgn < 0 ? 0.13 : 0.17, sgn < 0 ? 0.17 : 0.13, 0.1, 12, sgn * 0.98), ...steel));
    const bar = new THREE.BoxGeometry(0.46, 0.045, 0.045);
    bar.translate(0, 0, sgn * 1.02);
    parts.push(paint(flat(bar), ...dark));
    for (const sx of [-1, 1]) {
      const post = new THREE.BoxGeometry(0.045, 0.045, 0.09);
      post.translate(sx * 0.21, 0, sgn * 0.985);
      parts.push(paint(flat(post), ...dark));
    }
  }
  // corner rails with end lugs
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const rail = new THREE.BoxGeometry(0.075, 0.06, 1.84);
    rail.rotateZ(a - Math.PI / 2);
    rail.translate(Math.cos(a) * 0.585, Math.sin(a) * 0.585, 0);
    parts.push(paint(flat(rail), ...dark));
    for (const sgn of [-1, 1]) {
      const lug = new THREE.BoxGeometry(0.13, 0.1, 0.1);
      lug.rotateZ(a - Math.PI / 2);
      lug.translate(Math.cos(a) * 0.6, Math.sin(a) * 0.6, sgn * 0.9);
      parts.push(paint(flat(lug), ...steel));
    }
  }
  // data plate and status lamp on the top flat (lamp colour > 1 is treated as emissive)
  const plate = new THREE.BoxGeometry(0.26, 0.012, 0.2);
  plate.translate(0, 0.505, 0.5);
  parts.push(paint(flat(plate), 0.72, 0.72, 0.68));
  const lamp = new THREE.BoxGeometry(0.07, 0.03, 0.05);
  lamp.translate(0.2, 0.52, 0.72);
  parts.push(paint(flat(lamp), 0.6, 6.0, 2.4));
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('canister merge failed');
  merged.deleteAttribute('uv');
  merged.computeBoundingSphere();
  return merged;
}

/** Jettisoned / collectable cargo canister. The geometry is shared between all canisters with default stripe. */
export function createCargoCanister(opts: { stripe?: RGB } = {}): CargoCanister {
  const shared = !opts.stripe;
  let geo: THREE.BufferGeometry;
  if (shared) {
    if (!canisterGeo) canisterGeo = buildCanisterGeometry([0.9, 0.42, 0.08]);
    canisterRefs++;
    geo = canisterGeo;
  } else {
    geo = buildCanisterGeometry(opts.stripe as RGB);
  }
  const noise = acquireNoise3D();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.55, roughness: 0.5 });
  const uPulse = { value: 1 };
  mat.onBeforeCompile = (shader): void => {
    shader.uniforms.uFxNoise = { value: noise };
    shader.uniforms.uPulse = uPulse;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFxObj;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFxObj = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFxObj;\nuniform highp sampler3D uFxNoise;\nuniform float uPulse;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 fxLamp = vec3(0.0);
        if (max(vColor.r, max(vColor.g, vColor.b)) > 1.5) { fxLamp = vColor.rgb * uPulse; diffuseColor.rgb = vec3(0.02); }
        vec4 fxN = texture(uFxNoise, vFxObj * 0.9);
        float fxWear = texture(uFxNoise, vFxObj * vec3(3.1, 3.1, 0.7) + 0.3).g;
        diffuseColor.rgb *= 0.72 + 0.5 * fxN.r;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.19, 0.18), smoothstep(0.62, 0.9, fxWear) * 0.55);`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor * (0.6 + 0.9 * fxN.b) + 0.25 * smoothstep(0.55, 0.9, fxWear), 0.08, 1.0);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += fxLamp;');
  };
  mat.customProgramCacheKey = (): string => 'tidelock-canister';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'cargoCanister';
  let clock = rnd() * 10;
  return {
    object3d: mesh,
    update(dt: number, _time: number): void {
      clock += dt;
      const ph = clock % 1.6;
      uPulse.value = ph < 0.12 ? 1 : 0.06;
    },
    dispose(): void {
      mesh.removeFromParent();
      mat.dispose();
      releaseNoise3D();
      if (shared) {
        if (--canisterRefs <= 0 && canisterGeo) {
          canisterGeo.dispose();
          canisterGeo = null;
          canisterRefs = 0;
        }
      } else {
        geo.dispose();
      }
    },
  };
}

// ================================================================================================ sprite batch

/** Sprite shapes. */
const SH_GLOW = 0;
const SH_PUFF = 1;
const SH_STREAK = 2;
const SH_RING = 3;
const SH_FLARE = 4;
const SH_FRAME = 5;
const SH_EMBER = 6;
/** Orientation modes. */
const OR_BILLBOARD = 0;
const OR_VELOCITY = 1;
const OR_PLANE = 2;
/** Colour ramps. */
const RAMP_CONST = 0;
const RAMP_FIRE = 1;
const RAMP_COOL = 2;

const SPRITE_STRIDE = 24;

const SPRITE_VERT = /* glsl */ `
precision highp float;
in vec4 aPosBirth;   // xyz position at birth, w birth time
in vec4 aVelLife;    // xyz velocity (plane normal for OR_PLANE), w lifetime
in vec4 aColor;      // rgb HDR colour, w ramp mode
in vec4 aSize;       // x start half-size, y end half-size, z stretch (s of trail), w drag (1/s)
in vec4 aMisc;       // x shape, y orientation, z seed, w fade-in fraction
in vec4 aAxis;       // xyz plane U axis, w fade-out power
uniform float uTime;
uniform float uViewH;
out vec2 vUv;
out vec3 vCol;
flat out vec4 vInfo; // shape, seed, life fraction, pixel size
void main() {
  float age = uTime - aPosBirth.w;
  float life = aVelLife.w;
  float f = age / max(life, 1e-4);
  if (age < 0.0 || f >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float k = aSize.w;
  float tt = k > 1e-3 ? (1.0 - exp(-k * age)) / k : age;
  float g = 1.0 - (1.0 - f) * (1.0 - f);
  float size = mix(aSize.x, aSize.y, g);
  float fade = smoothstep(0.0, max(aMisc.w, 1e-4), f) * pow(1.0 - f, aAxis.w);
  vec3 col = aColor.rgb;
  if (aColor.w > 1.5) {
    // cooling metal: colour -> deep red
    col = mix(col, col * vec3(1.0, 0.3, 0.07), smoothstep(0.1, 0.9, f));
  } else if (aColor.w > 0.5) {
    // fireball: white-hot -> colour -> dull red
    col = mix(vec3(max(col.r, max(col.g, col.b))) * 1.5, col, smoothstep(0.0, 0.22, f));
    col = mix(col, col * vec3(0.9, 0.2, 0.05), smoothstep(0.3, 1.0, f));
  }
  float pxPerM = projectionMatrix[1][1] * uViewH * 0.5;
  vec2 c = position.xy;
  vec4 mv;
  float px;
  if (aMisc.y < 0.5) {
    mv = modelViewMatrix * vec4(aPosBirth.xyz + aVelLife.xyz * tt, 1.0);
    px = size * pxPerM / max(-mv.z, 0.01);
    if (px < 1.0) { fade *= max(px, 0.15); size /= max(px, 1e-3); }
    mv.xy += c * size;
  } else if (aMisc.y < 1.5) {
    mv = modelViewMatrix * vec4(aPosBirth.xyz + aVelLife.xyz * tt, 1.0);
    vec3 vv = mat3(modelViewMatrix) * (aVelLife.xyz * exp(-k * age));
    float sp = length(vv);
    vec3 dirV = sp > 1e-5 ? vv / sp : vec3(0.0, 1.0, 0.0);
    vec3 sd = cross(dirV, normalize(-mv.xyz));
    float sl = length(sd);
    sd = sl > 1e-4 ? sd / sl : vec3(1.0, 0.0, 0.0);
    px = size * pxPerM / max(-mv.z, 0.01);
    if (px < 0.75) { fade *= max(px / 0.75, 0.2); size *= 0.75 / max(px, 1e-3); }
    float trail = min(sp * aSize.z, sp * age) + size;
    mv.xyz += dirV * ((c.y - 1.0) * 0.5 * trail + size) + sd * (c.x * size);
  } else {
    vec3 n = normalize(aVelLife.xyz);
    vec3 u = aAxis.xyz;
    vec3 v = cross(n, u);
    mv = modelViewMatrix * vec4(aPosBirth.xyz + (u * c.x + v * c.y) * size, 1.0);
    px = size * pxPerM / max(length(mv.xyz), 0.01);
  }
  vUv = c;
  vCol = col * fade;
  vInfo = vec4(aMisc.x, aMisc.z, f, px);
  gl_Position = projectionMatrix * mv;
}
`;

const SPRITE_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler3D uNoise;
uniform float uTime;
in vec2 vUv;
in vec3 vCol;
flat in vec4 vInfo;
float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
  float shape = vInfo.x;
  float seed = vInfo.y;
  float f = vInfo.z;
  float d2 = dot(vUv, vUv);
  float a = 0.0;
  vec3 col = vCol;
  if (shape < 0.5) {
    a = max(exp(-d2 * 5.0) - 0.0067, 0.0);
  } else if (shape < 1.5) {
    // turbulent puff that erodes into wisps as it ages
    float base = max(1.0 - d2, 0.0);
    base *= base;
    vec3 q = vec3(vUv * 0.27 + seed * 7.31, seed * 3.7 + f * 0.3);
    vec4 n = texture(uNoise, q);
    float n2 = texture(uNoise, q * 2.6 + 0.19).g;
    float nn = n.r * 0.68 + n2 * 0.32;
    float thr = mix(0.04, 0.62, f);
    a = smoothstep(thr, thr + 0.5, base * (0.3 + 1.45 * nn));
    col *= 0.45 + 1.5 * a * a;
  } else if (shape < 2.5) {
    float across = max(exp(-vUv.x * vUv.x * 5.5) - 0.0041, 0.0);
    float along = smoothstep(-1.0, 0.72, vUv.y) * (1.0 - smoothstep(0.78, 1.0, vUv.y));
    a = across * along * along;
  } else if (shape < 3.5) {
    float d = sqrt(d2);
    float w = mix(0.11, 0.035, f);
    float ring = exp(-pow((d - 0.86) / w, 2.0));
    float n = texture(uNoise, vec3(vUv * 0.75 + seed * 3.1, seed + f * 0.15)).r;
    a = ring * (0.2 + 1.6 * n * n) + 0.035 * smoothstep(0.9, 0.2, d) * (1.0 - f);
  } else if (shape < 4.5) {
    float core = exp(-d2 * 30.0);
    float halo = max(exp(-d2 * 4.5) - 0.011, 0.0) * 0.14;
    float streak = exp(-abs(vUv.y) * 42.0) * max(1.0 - abs(vUv.x), 0.0) * 0.3;
    streak *= exp(-vUv.x * vUv.x * 1.6);
    a = core + halo + streak;
  } else if (shape < 5.5) {
    // holographic approach frame: rounded outline, corner brackets, side ticks
    float aa = max(fwidth(vUv.x), fwidth(vUv.y));
    float lw = max(0.012, aa * 0.9);
    float sd = sdRoundBox(vUv, vec2(0.9), 0.14);
    float line = 1.0 - smoothstep(lw, lw + aa * 1.2, abs(sd));
    vec2 q = abs(vUv);
    float corner = step(0.58, min(q.x, q.y));
    float tick = (1.0 - smoothstep(lw, lw + aa * 1.2, min(q.x, q.y))) * step(0.74, max(q.x, q.y)) * step(max(q.x, q.y), 0.9);
    float glow = exp(-abs(sd) * 22.0) * 0.16 * step(sd, 0.05);
    a = line * (0.35 + 0.65 * corner) + tick * 0.8 + glow * (0.4 + 0.6 * corner);
  } else {
    a = max(exp(-d2 * 6.0) - 0.0025, 0.0) * (0.55 + 0.45 * sin(uTime * (5.0 + seed * 9.0) + seed * 40.0));
  }
  gl_FragColor = vec4(col * a, 0.0);
}
`;

class SpriteBatch {
  readonly mesh: THREE.Mesh;
  readonly data: Float32Array;
  readonly capacity: number;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly buf: THREE.InstancedInterleavedBuffer;
  private readonly mat: THREE.ShaderMaterial;
  private readonly range = { start: 0, count: 0 };
  private cursor = 0;
  private lo = Infinity;
  private hi = -1;
  /** Latest expiry time of anything emitted (ring mode). */
  expire = -1;
  clock = 0;

  constructor(capacity: number, uTime: { value: number }, noise: THREE.Data3DTexture, private readonly ring: boolean) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * SPRITE_STRIDE);
    this.geo = makeQuadGeometry();
    this.buf = new THREE.InstancedInterleavedBuffer(this.data, SPRITE_STRIDE);
    this.buf.setUsage(THREE.DynamicDrawUsage);
    const names = ['aPosBirth', 'aVelLife', 'aColor', 'aSize', 'aMisc', 'aAxis'];
    for (let i = 0; i < names.length; i++) this.geo.setAttribute(names[i], new THREE.InterleavedBufferAttribute(this.buf, 4, i * 4));
    this.geo.instanceCount = ring ? capacity : 0;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime, uViewH: sharedViewH, uNoise: { value: noise } },
      vertexShader: SPRITE_VERT,
      fragmentShader: SPRITE_FRAG,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      depthWrite: false,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    hookViewport(this.mesh, this.mat);
  }

  /** Immediate mode: start a fresh list for this frame. */
  reset(): void {
    this.cursor = 0;
  }

  emit(
    px: number, py: number, pz: number,
    vx: number, vy: number, vz: number,
    life: number,
    r: number, g: number, b: number, ramp: number,
    size0: number, size1: number, stretch: number, drag: number,
    shape: number, orient: number, fadeIn: number, fadePow: number,
    ax = 1, ay = 0, az = 0, delay = 0,
  ): void {
    let i = this.cursor;
    if (this.ring) {
      this.cursor = (i + 1) % this.capacity;
    } else {
      if (i >= this.capacity) return;
      this.cursor = i + 1;
    }
    if (i < this.lo) this.lo = i;
    if (i > this.hi) this.hi = i;
    const birth = this.clock + delay;
    if (birth + life > this.expire) this.expire = birth + life;
    const d = this.data;
    i *= SPRITE_STRIDE;
    d[i] = px; d[i + 1] = py; d[i + 2] = pz; d[i + 3] = birth;
    d[i + 4] = vx; d[i + 5] = vy; d[i + 6] = vz; d[i + 7] = life;
    d[i + 8] = r; d[i + 9] = g; d[i + 10] = b; d[i + 11] = ramp;
    d[i + 12] = size0; d[i + 13] = size1; d[i + 14] = stretch; d[i + 15] = drag;
    d[i + 16] = shape; d[i + 17] = orient; d[i + 18] = rnd(); d[i + 19] = fadeIn;
    d[i + 20] = ax; d[i + 21] = ay; d[i + 22] = az; d[i + 23] = fadePow;
  }

  /** Shift all stored birth times (clock re-basing). */
  rebase(delta: number): void {
    const d = this.data;
    for (let i = 3; i < d.length; i += SPRITE_STRIDE) d[i] -= delta;
    this.expire -= delta;
    this.lo = 0;
    this.hi = this.capacity - 1;
  }

  /** Upload what changed and decide visibility. */
  flush(): void {
    if (this.ring) {
      this.mesh.visible = this.clock < this.expire;
    } else {
      this.geo.instanceCount = this.cursor;
      this.mesh.visible = this.cursor > 0;
      this.lo = 0;
      this.hi = this.cursor - 1;
    }
    if (this.hi >= this.lo) {
      this.range.start = this.lo * SPRITE_STRIDE;
      this.range.count = (this.hi - this.lo + 1) * SPRITE_STRIDE;
      this.buf.updateRanges.length = 0;
      this.buf.updateRanges.push(this.range);
      this.buf.needsUpdate = true;
    }
    this.lo = Infinity;
    this.hi = -1;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ================================================================================================ beams

const BEAM_STRIDE = 16;
const BEAM_MINING_SLOTS = 4;

const BEAM_VERT = /* glsl */ `
precision highp float;
in vec4 aFromW;    // xyz from, w core half-width (m)
in vec4 aToBirth;  // xyz to, w birth
in vec4 aColDur;   // rgb, w duration
in vec4 aKind;     // x kind (0 pulse, 1 continuous), y seed
uniform float uTime;
uniform float uViewH;
out vec2 vUv;
out vec3 vCol;
flat out vec4 vInfo;  // kind, seed, f, length
void main() {
  float age = uTime - aToBirth.w;
  float f = age / max(aColDur.w, 1e-4);
  if (age < 0.0 || f >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 A = (modelViewMatrix * vec4(aFromW.xyz, 1.0)).xyz;
  vec3 B = (modelViewMatrix * vec4(aToBirth.xyz, 1.0)).xyz;
  float along = position.y * 0.5 + 0.5;
  vec3 P = mix(A, B, along);
  vec3 axis = B - A;
  float len = length(axis);
  vec3 sd = cross(axis, P);
  float sl = length(sd);
  sd = sl > 1e-6 ? sd / sl : vec3(1.0, 0.0, 0.0);
  float halfW = aFromW.w * 7.0;
  float px = halfW * projectionMatrix[1][1] * uViewH * 0.5 / max(-P.z, 0.01);
  float gain = 1.0;
  if (px < 5.0) { gain = max(px / 5.0, 0.3); halfW *= 5.0 / max(px, 1e-3); }
  P += sd * position.x * halfW;
  float env = aKind.x < 0.5 ? smoothstep(0.0, 0.06, f) * pow(1.0 - f, 1.6) : 1.0 - smoothstep(0.4, 1.0, f);
  vUv = vec2(position.x, along);
  vCol = aColDur.rgb * env * gain;
  vInfo = vec4(aKind.x, aKind.y, f, len);
  gl_Position = projectionMatrix * vec4(P, 1.0);
}
`;
const BEAM_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler3D uNoise;
uniform float uTime;
in vec2 vUv;
in vec3 vCol;
flat in vec4 vInfo;
void main() {
  float x = vUv.x * 7.0;
  float core = exp(-x * x * 1.1);
  float glow = max(exp(-abs(x) * 0.85) - 0.0026, 0.0) * 0.22;
  float ends = smoothstep(0.0, 0.004, vUv.y) * smoothstep(1.0, 0.996, vUv.y);
  float mod = 1.0;
  if (vInfo.x > 0.5) {
    float n = texture(uNoise, vec3(vUv.y * vInfo.w * 0.07 - uTime * 2.6, vInfo.y, uTime * 0.9)).r;
    float n2 = texture(uNoise, vec3(vUv.y * vInfo.w * 0.31 - uTime * 7.0, vInfo.y + 0.5, 0.2)).g;
    mod = 0.55 + 0.6 * n + 0.5 * n2 * n2;
    core *= 0.8 + 0.4 * n2;
  }
  float m = max(vCol.r, max(vCol.g, vCol.b));
  vec3 col = mix(vCol, vec3(m), 0.75) * core * 2.2 + vCol * glow;
  gl_FragColor = vec4(col * ends * mod, 0.0);
}
`;

// ================================================================================================ bubbles (shield, jump charge)

const BUBBLE_STRIDE = 16;
const BUBBLE_SLOTS = 8;
const BUBBLE_JUMP_SLOTS = 2;

const BUBBLE_VERT = /* glsl */ `
precision highp float;
in vec4 aCenterR;   // xyz centre at birth, w radius
in vec4 aVelBirth;  // xyz velocity, w birth
in vec4 aHitDur;    // xyz unit direction (hit point / jump axis), w duration
in vec4 aColKind;   // rgb, w kind (0 shield hit, 1 jump charge: fract = progress)
uniform float uTime;
out vec3 vN;
out vec3 vView;
flat out vec4 vHit;   // dir, f
flat out vec4 vCol;   // rgb, kind
flat out vec3 vE1;
flat out vec3 vE2;
flat out float vRadius;
void main() {
  float age = uTime - aVelBirth.w;
  float f = age / max(aHitDur.w, 1e-4);
  if (age < 0.0 || f >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 c = aCenterR.xyz + aVelBirth.xyz * age;
  vec4 wp = modelMatrix * vec4(c + position * aCenterR.w, 1.0);
  vN = normalize(mat3(modelMatrix) * position);
  vView = cameraPosition - wp.xyz;
  vec3 h = normalize(mat3(modelMatrix) * aHitDur.xyz);
  vec3 ref = abs(h.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vE1 = normalize(cross(h, ref));
  vE2 = cross(h, vE1);
  vHit = vec4(h, f);
  vCol = aColKind;
  vRadius = aCenterR.w;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const BUBBLE_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler3D uNoise;
uniform float uTime;
in vec3 vN;
in vec3 vView;
flat in vec4 vHit;
flat in vec4 vCol;
flat in vec3 vE1;
flat in vec3 vE2;
flat in float vRadius;

vec4 hexCell(vec2 p) {
  const vec2 s = vec2(1.0, 1.7320508);
  vec4 hc = floor(vec4(p, p - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
  vec4 h = vec4(p - hc.xy * s, p - (hc.zw + 0.5) * s);
  return dot(h.xy, h.xy) < dot(h.zw, h.zw) ? vec4(h.xy, hc.xy * s) : vec4(h.zw, (hc.zw + 0.5) * s);
}
float hexDist(vec2 p) {
  p = abs(p);
  return max(dot(p, vec2(0.5, 0.8660254)), p.x);
}

void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(vView);
  float nv = abs(dot(n, v));
  float fres = pow(1.0 - nv, 3.0);
  float f = vHit.w;
  vec3 col;
  float alpha = 0.0;
  if (vCol.w < 0.5) {
    // ---- shield impact: hex lattice lit by a ripple radiating from the hit point
    float ct = clamp(dot(n, vHit.xyz), -1.0, 1.0);
    float th = acos(ct);
    vec2 pl = vec2(dot(n, vE1), dot(n, vE2));
    float pll = length(pl);
    vec2 uv = pll > 1e-5 ? pl / pll * th : vec2(0.0);
    float cells = clamp(vRadius / 0.9, 7.0, 26.0);   // hexes per radian
    vec4 hx = hexCell(uv * cells);
    float hd = hexDist(hx.xy);
    float aa = fwidth(hd) * 1.5 + 0.01;
    float edge = smoothstep(0.5 - 0.055 - aa, 0.5 - 0.01, hd);
    float thc = length(hx.zw) / cells;             // angle of the cell centre from the hit
    float front = f * 3.6;                         // ripple front (rad)
    float wave = exp(-pow((thc - front) / 0.2, 2.0));
    float wake = smoothstep(front, front - 1.3, thc) * step(thc, front + 0.2);
    float fadeT = pow(1.0 - f, 1.3);
    float spot = exp(-th * th * 26.0) * exp(-f * 9.0);
    float cellFlash = wave * (0.2 + 0.8 * fract(sin(dot(hx.zw, vec2(12.9898, 78.233))) * 43758.5453));
    float shimmer = texture(uNoise, n * 0.9 + uTime * 0.05).r;
    float i = edge * (wave * 5.0 + wake * 0.9 + 0.12) * fadeT
            + cellFlash * (1.0 - edge) * 1.1 * fadeT
            + fres * (0.5 + 0.5 * shimmer) * fadeT * (0.35 + 0.65 * smoothstep(3.2, 0.0, th))
            + spot * 14.0;
    col = vCol.rgb * i + vec3(1.0) * spot * 5.0;
    if (!gl_FrontFacing) col *= 0.3;
  } else {
    // ---- jump charge: space pinching around the hull. Bright Einstein-like rim, inflowing streaks,
    // darkened interior (premultiplied alpha occludes the stars behind).
    float p = fract(vCol.w);                       // progress 0..1
    float rim = pow(1.0 - nv, 5.0);
    float thin = exp(-pow((1.0 - nv - 0.93) / 0.045, 2.0));
    vec3 q = n * 1.6 + vHit.xyz * (uTime * 0.35);
    float sw = texture(uNoise, q + vec3(0.0, uTime * 0.2, 0.0)).r;
    float sw2 = texture(uNoise, q * 2.7 - uTime * 0.13).g;
    float streaks = pow(sw * sw2 * 2.2, 3.0);
    float pulse = 0.75 + 0.25 * sin(uTime * (6.0 + 22.0 * p * p));
    float e = (rim * (0.6 + 2.4 * p) + thin * (1.0 + 8.0 * p * p) + streaks * (1.0 - nv) * 3.0 * p) * pulse * smoothstep(0.0, 0.08, p);
    vec3 hot = mix(vCol.rgb, vec3(1.0), 0.55 * thin + 0.3 * p * rim);
    col = hot * e * (0.5 + 2.2 * p);
    alpha = gl_FrontFacing ? 0.0 : 0.55 * p * (0.3 + 0.7 * nv * nv);
    if (gl_FrontFacing) col *= 0.6;
  }
  gl_FragColor = vec4(col, alpha);
}
`;

// ================================================================================================ jump tunnel

const TUNNEL_VERT = /* glsl */ `
precision highp float;
out vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const TUNNEL_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler3D uNoise;
uniform float uTime;
uniform float uIntensity;
uniform vec3 uAxis;
uniform vec3 uE1;
uniform vec3 uE2;
in vec3 vDir;
float hash1(float n) { return fract(sin(n * 127.1) * 43758.5453); }
// one layer of radial star streaks: cells in azimuth, streaming outward from the forward point
float streaks(float phi, float u, float cells, float speed, float seed, float sinT) {
  float c = phi * cells;
  float id = floor(c);
  float fx = fract(c) - 0.5;
  float r = hash1(id + seed);
  float r2 = hash1(id * 1.7 + seed + 4.0);
  float lane = 0.5 * (r2 - 0.5);
  float wpx = fwidth(c) * 0.8;
  float width = max(0.06 + 0.1 * r, wpx);
  float line = 1.0 - smoothstep(width * 0.4, width, abs(fx - lane));
  line *= min(1.0, (0.06 + 0.1 * r) / max(wpx, 1e-4));
  float t = u * (0.55 + 0.5 * r2) - uTime * speed * (0.6 + 0.8 * r) + r * 17.0;
  float ph = fract(t);
  float seg = smoothstep(0.0, 0.03, ph) * pow(1.0 - ph, 5.0 + 9.0 * r);
  return line * seg * (0.25 + 1.75 * r * r) * step(0.35, r) * sinT;
}
void main() {
  vec3 d = normalize(vDir);
  float ct = dot(d, uAxis);
  float sinT = sqrt(max(1.0 - ct * ct, 0.0));
  float phi = atan(dot(d, uE2), dot(d, uE1)) / 6.2831853 + 0.5;
  // log-polar depth: equal steps of u are equal ratios of angular distance from the forward point
  float u = log(max(sinT, 1e-4) / (1.0 + ct + 1e-4));
  float fwd = smoothstep(-1.0, 1.0, ct);
  float s = streaks(phi, u, 170.0, 0.9, 1.0, 1.0) + streaks(phi, u, 420.0, 0.6, 31.0, 1.0) * 0.6 + streaks(phi, u, 61.0, 1.5, 77.0, 1.0) * 1.4;
  s *= smoothstep(0.0, 0.12, sinT);
  vec3 blue = vec3(0.62, 0.8, 1.0);
  vec3 warm = vec3(1.0, 0.56, 0.3);
  vec3 sc = mix(warm, blue, smoothstep(-0.5, 0.75, ct));
  // tunnel wall: faint banded haze rushing past
  vec3 q = vec3(cos(phi * 6.2831853), sin(phi * 6.2831853), 0.0) * 0.35;
  float hz = texture(uNoise, q + vec3(0.0, 0.0, u * 0.11 - uTime * 0.19)).r;
  float hz2 = texture(uNoise, q * 2.3 + vec3(0.0, 0.0, u * 0.29 - uTime * 0.41)).g;
  float haze = pow(hz * hz2 * 2.0, 2.0) * sinT;
  vec3 hc = mix(vec3(0.42, 0.2, 0.75), vec3(0.16, 0.42, 0.95), fwd);
  // the destination: a hard bright point ahead with a soft halo; a dim red glow astern
  float ahead = max(ct, 0.0);
  float corePt = pow(ahead, 900.0) * 30.0 + pow(ahead, 60.0) * 1.2 + pow(ahead, 6.0) * 0.12;
  float astern = pow(max(-ct, 0.0), 10.0) * 0.1;
  float k = uIntensity;
  vec3 col = sc * s * (2.2 + 4.0 * fwd) * k
           + hc * haze * 0.55 * k * k
           + vec3(0.75, 0.88, 1.0) * corePt * k * k
           + vec3(1.0, 0.25, 0.08) * astern * k;
  gl_FragColor = vec4(col, 0.0);
}
`;

// ================================================================================================ re-entry plasma sheath

const PLASMA_SLOTS = 2;
const PLASMA_TAIL = 9; // radii

const PLASMA_VERT = /* glsl */ `
precision highp float;
out vec3 vObj;
out vec3 vN;
out vec3 vView;
void main() {
  vObj = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vView = cameraPosition - wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const PLASMA_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler3D uNoise;
uniform float uTime;
uniform float uIntensity;
in vec3 vObj;
in vec3 vN;
in vec3 vView;
void main() {
  float k = uIntensity;
  float d = 1.18 - vObj.y;                         // distance behind the bow-shock apex, radii
  float nv = abs(dot(normalize(vN), normalize(vView)));
  float limb = 1.0 / (0.22 + nv);                  // thin-shell limb brightening
  float az = atan(vObj.z, vObj.x);
  vec3 q = vec3(cos(az) * 0.3, sin(az) * 0.3, d * 0.05 - uTime * 1.25);
  float n1 = texture(uNoise, q).r;
  float n2 = texture(uNoise, q * vec3(3.1, 3.1, 1.7) + 0.37).g;
  float n3 = texture(uNoise, vec3(cos(az) * 1.9, sin(az) * 1.9, d * 0.035 - uTime * 2.3)).b;
  float streak = n1 * 0.5 + n2 * 0.5;
  streak = 0.25 + 1.6 * streak * streak + 1.4 * pow(n3, 4.0);
  float reach = 0.9 + 6.5 * k;                     // tail length grows with heating
  float body = exp(-d / reach) * (1.0 - smoothstep(0.55 * ${PLASMA_TAIL}.0, ${PLASMA_TAIL}.0, d));
  float cap = exp(-d * d * 1.4);                   // stagnation region
  vec3 hot = vec3(1.0, 0.86, 0.72);
  vec3 mid = vec3(1.0, 0.42, 0.14);
  vec3 cool = vec3(0.85, 0.16, 0.34);
  vec3 c = mix(hot, mid, smoothstep(0.0, 1.6, d));
  c = mix(c, cool, smoothstep(1.2, 6.0, d));
  float e = (cap * 5.0 * k + body * streak * 1.5) * limb * 0.45;
  e *= k * (0.6 + 0.4 * k) * 4.0;
  float flick = 0.9 + 0.1 * sin(uTime * 61.0) * sin(uTime * 23.0 + 1.0);
  gl_FragColor = vec4(c * e * flick, 0.0);
}
`;

// ================================================================================================ space dust

const DUST_VERT = /* glsl */ `
precision highp float;
in vec4 aSeed;
uniform vec3 uOffset;    // accumulated travel through the medium / box, 0..1
uniform vec3 uCam;       // camera position, fx frame
uniform vec3 uStreak;    // streak vector, m
uniform float uBox;
uniform float uOpacity;
uniform float uViewH;
out vec2 vUv;
out float vA;
void main() {
  vec3 p = (fract(aSeed.xyz - uOffset) - 0.5) * uBox;
  float dist = length(p);
  vec4 mv = modelViewMatrix * vec4(uCam + p, 1.0);
  vec3 sv = mat3(modelViewMatrix) * uStreak;
  float sl = length(sv);
  vec3 dirV = sl > 1e-4 ? sv / sl : vec3(0.0, 1.0, 0.0);
  vec3 sd = cross(dirV, normalize(-mv.xyz));
  float sdl = length(sd);
  sd = sdl > 1e-4 ? sd / sdl : vec3(1.0, 0.0, 0.0);
  float size = 0.012 + 0.02 * aSeed.w;
  float px = size * projectionMatrix[1][1] * uViewH * 0.5 / max(-mv.z, 0.05);
  float gain = 1.0;
  if (px < 0.9) { gain = max(px / 0.9, 0.12); size *= 0.9 / max(px, 1e-3); }
  mv.xyz += dirV * position.y * (sl * 0.5 + size) + sd * position.x * size;
  float fade = smoothstep(0.5 * uBox, 0.3 * uBox, dist) * smoothstep(1.5, 5.0, dist);
  vA = uOpacity * gain * fade * (0.3 + 0.7 * aSeed.w) / (1.0 + sl / (size * 14.0));
  vUv = position.xy;
  gl_Position = projectionMatrix * mv;
}
`;
const DUST_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
in float vA;
void main() {
  float a = max(exp(-vUv.x * vUv.x * 4.0) - 0.018, 0.0) * (1.0 - smoothstep(0.6, 1.0, abs(vUv.y)));
  gl_FragColor = vec4(vec3(0.8, 0.86, 1.0) * a * vA, 0.0);
}
`;

// ================================================================================================ manager

export interface EffectsManagerOptions {
  quality?: FxQuality;
  /** Particle pool size (default by quality: 1536 / 2560 / 4096 / 6144). */
  maxParticles?: number;
}

export interface DockingPortTransform {
  /** Mating point, fx frame. */
  pos: V3;
  /** Unit vector out of the port. */
  dir: V3;
  /** Unit "up", perpendicular to dir. */
  up: V3;
}

const CHUNKS = 96;
const QUALITY_COUNT: Record<FxQuality, number> = { low: 0.45, medium: 0.7, high: 1, ultra: 1.3 };
const QUALITY_POOL: Record<FxQuality, number> = { low: 1536, medium: 2560, high: 4096, ultra: 6144 };
const SCHEDULE = 16;
const DOCK_FRAMES = 8;

const _q = new THREE.Quaternion();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _tv = new THREE.Vector3();
const _tv2 = new THREE.Vector3();

export class EffectsManager {
  readonly object3d = new THREE.Group();

  private readonly quality: FxQuality;
  private readonly countMul: number;
  private readonly noise: THREE.Data3DTexture;
  private readonly uTime = { value: 0 };
  private clock = 0;
  private lastDt = 1 / 60;

  private readonly particles: SpriteBatch;
  private readonly imm: SpriteBatch;

  // beams
  private readonly beamData: Float32Array;
  private readonly beamBuf: THREE.InstancedInterleavedBuffer;
  private readonly beamGeo: THREE.InstancedBufferGeometry;
  private readonly beamMat: THREE.ShaderMaterial;
  private readonly beamMesh: THREE.Mesh;
  private readonly beamCap = 40;
  private beamCursor = 0;
  private beamExpire = -1;
  private beamDirty = false;
  private readonly mining = new Float32Array(BEAM_MINING_SLOTS * 8); // from xyz, to xyz, power, active
  private readonly miningAcc = new Float32Array(BEAM_MINING_SLOTS * 2);

  // chunks
  private readonly chunkMesh: THREE.InstancedMesh;
  private readonly chunkGeo: THREE.BufferGeometry;
  private readonly chunkMat: THREE.MeshStandardMaterial;
  private readonly chunkAttr: THREE.InstancedBufferAttribute;
  private readonly chunkState = new Float32Array(CHUNKS * 20);
  private chunkCursor = 0;
  private chunkLive = 0;

  // bubbles
  private readonly bubbleData = new Float32Array(BUBBLE_SLOTS * BUBBLE_STRIDE);
  private readonly bubbleBuf: THREE.InstancedInterleavedBuffer;
  private readonly bubbleGeo: THREE.InstancedBufferGeometry;
  private readonly bubbleMat: THREE.ShaderMaterial;
  private readonly bubbleMesh: THREE.Mesh;
  private bubbleCursor = 0;
  private bubbleExpire = -1;
  private bubbleDirty = false;
  private readonly jumpAcc = new Float32Array(BUBBLE_JUMP_SLOTS);

  // tunnel
  private readonly tunnelMesh: THREE.Mesh;
  private readonly tunnelMat: THREE.ShaderMaterial;
  private tunnelTarget = 0;
  private tunnelLevel = 0;

  // plasma
  private readonly plasmaGeo: THREE.BufferGeometry;
  private readonly plasma: { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; target: THREE.Object3D | null; intensity: number; radius: number; touched: boolean; acc: number; dir: THREE.Vector3 }[] = [];

  // dust
  private readonly dustMesh: THREE.Mesh;
  private readonly dustMat: THREE.ShaderMaterial;
  private readonly dustGeo: THREE.InstancedBufferGeometry;
  private readonly dustVel = new THREE.Vector3();
  private readonly dustOff = [0, 0, 0];
  private dustDensity = 0;
  private readonly dustBox = 140;

  // docking guide
  private dockOn = false;
  private dockLevel = 0;
  private readonly dock = new Float32Array(12); // pos, dir, up, size, aligned
  private rcsAcc = 0;
  private trailAcc = 0;

  // scheduled secondary explosions: t, x, y, z, radius, vx, vy, vz
  private readonly sched = new Float32Array(SCHEDULE * 8);

  constructor(opts: EffectsManagerOptions = {}) {
    this.quality = opts.quality ?? 'high';
    this.countMul = QUALITY_COUNT[this.quality];
    this.noise = acquireNoise3D();
    this.object3d.name = 'effects';
    for (let i = 0; i < SCHEDULE; i++) this.sched[i * 8] = -1;

    // ---- particles + immediate sprites
    this.particles = new SpriteBatch(opts.maxParticles ?? QUALITY_POOL[this.quality], this.uTime, this.noise, true);
    this.particles.mesh.name = 'fx:particles';
    this.particles.mesh.renderOrder = 32;
    this.imm = new SpriteBatch(96, this.uTime, this.noise, false);
    this.imm.mesh.name = 'fx:sprites';
    this.imm.mesh.renderOrder = 33;

    // ---- beams
    this.beamData = new Float32Array(this.beamCap * BEAM_STRIDE);
    this.beamGeo = makeQuadGeometry();
    this.beamBuf = new THREE.InstancedInterleavedBuffer(this.beamData, BEAM_STRIDE);
    this.beamBuf.setUsage(THREE.DynamicDrawUsage);
    ['aFromW', 'aToBirth', 'aColDur', 'aKind'].forEach((n, i) => this.beamGeo.setAttribute(n, new THREE.InterleavedBufferAttribute(this.beamBuf, 4, i * 4)));
    this.beamGeo.instanceCount = this.beamCap;
    this.beamMat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uTime, uViewH: sharedViewH, uNoise: { value: this.noise } },
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      depthWrite: false,
      toneMapped: false,
    });
    this.beamMesh = new THREE.Mesh(this.beamGeo, this.beamMat);
    this.beamMesh.name = 'fx:beams';
    this.beamMesh.frustumCulled = false;
    this.beamMesh.visible = false;
    this.beamMesh.renderOrder = 31;
    hookViewport(this.beamMesh, this.beamMat);

    // ---- debris / rock chunks (lit, tumbling, glowing while hot)
    const ico = new THREE.IcosahedronGeometry(1, 1);
    const pa = ico.getAttribute('position');
    for (let i = 0; i < pa.count; i++) {
      // deterministic lumpy shard
      const x = pa.getX(i);
      const y = pa.getY(i);
      const z = pa.getZ(i);
      const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
      const j = 0.72 + 0.5 * (h - Math.floor(h));
      pa.setXYZ(i, x * j, y * j * 0.62, z * j * 0.85);
    }
    this.chunkGeo = ico.toNonIndexed();
    // toNonIndexed duplicates vertices per face: re-weld jitter is already shared, so facets stay closed
    this.chunkGeo.computeVertexNormals();
    ico.dispose();
    this.chunkAttr = new THREE.InstancedBufferAttribute(new Float32Array(CHUNKS * 2), 2);
    this.chunkAttr.setUsage(THREE.DynamicDrawUsage);
    this.chunkGeo.setAttribute('aChunk', this.chunkAttr);
    this.chunkMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.5, roughness: 0.62 });
    this.chunkMat.onBeforeCompile = (shader): void => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aChunk;\nvarying vec2 vChunk;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvChunk = aChunk;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vChunk;')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vChunk.y;')
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          {
            float h = vChunk.x;
            vec3 glow = mix(vec3(1.0, 0.07, 0.01), vec3(1.0, 0.55, 0.2), smoothstep(0.25, 0.8, h));
            glow = mix(glow, vec3(1.0, 0.95, 0.85), smoothstep(0.75, 1.0, h));
            totalEmissiveRadiance += glow * (h * h * 9.0);
          }`,
        );
    };
    this.chunkMat.customProgramCacheKey = (): string => 'tidelock-fx-chunk';
    this.chunkMesh = new THREE.InstancedMesh(this.chunkGeo, this.chunkMat, CHUNKS);
    this.chunkMesh.name = 'fx:chunks';
    this.chunkMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.chunkMesh.setColorAt(0, new THREE.Color(1, 1, 1));
    (this.chunkMesh.instanceColor as THREE.InstancedBufferAttribute).setUsage(THREE.DynamicDrawUsage);
    this.chunkMesh.count = 0;
    this.chunkMesh.frustumCulled = false;
    this.chunkMesh.visible = false;

    // ---- bubbles
    const sph = new THREE.IcosahedronGeometry(1, 9);
    this.bubbleGeo = new THREE.InstancedBufferGeometry();
    this.bubbleGeo.setAttribute('position', sph.getAttribute('position'));
    if (sph.getIndex()) this.bubbleGeo.setIndex(sph.getIndex());
    this.bubbleBuf = new THREE.InstancedInterleavedBuffer(this.bubbleData, BUBBLE_STRIDE);
    this.bubbleBuf.setUsage(THREE.DynamicDrawUsage);
    ['aCenterR', 'aVelBirth', 'aHitDur', 'aColKind'].forEach((n, i) => this.bubbleGeo.setAttribute(n, new THREE.InterleavedBufferAttribute(this.bubbleBuf, 4, i * 4)));
    this.bubbleGeo.instanceCount = BUBBLE_SLOTS;
    this.bubbleMat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uTime, uNoise: { value: this.noise } },
      vertexShader: BUBBLE_VERT,
      fragmentShader: BUBBLE_FRAG,
      transparent: true,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      depthWrite: false,
      toneMapped: false,
    });
    this.bubbleMesh = new THREE.Mesh(this.bubbleGeo, this.bubbleMat);
    this.bubbleMesh.name = 'fx:bubbles';
    this.bubbleMesh.frustumCulled = false;
    this.bubbleMesh.visible = false;
    this.bubbleMesh.renderOrder = 30;

    // ---- jump tunnel (sphere around the camera, behind everything in the near scene)
    this.tunnelMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.uTime,
        uNoise: { value: this.noise },
        uIntensity: { value: 0 },
        uAxis: { value: new THREE.Vector3(0, 0, -1) },
        uE1: { value: new THREE.Vector3(1, 0, 0) },
        uE2: { value: new THREE.Vector3(0, 1, 0) },
      },
      vertexShader: TUNNEL_VERT,
      fragmentShader: TUNNEL_FRAG,
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      depthWrite: false,
      toneMapped: false,
    });
    this.tunnelMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 3), this.tunnelMat);
    this.tunnelMesh.name = 'fx:jumpTunnel';
    this.tunnelMesh.scale.setScalar(30000);
    this.tunnelMesh.frustumCulled = false;
    this.tunnelMesh.visible = false;
    this.tunnelMesh.renderOrder = 5;

    // ---- re-entry sheath (unit radius, apex toward +Y)
    const prof: THREE.Vector2[] = [];
    const segs = 40;
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const d = PLASMA_TAIL * u * u; // dense sampling near the apex
      const r = 1.5 * Math.sqrt(1 - Math.exp(-d / 0.75)) * (1 - 0.5 * smooth01((d - 2) / (PLASMA_TAIL - 2)));
      prof.push(new THREE.Vector2(Math.max(r, 0.0001), 1.18 - d));
    }
    this.plasmaGeo = new THREE.LatheGeometry(prof.reverse(), 32);
    for (let i = 0; i < PLASMA_SLOTS; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uTime: this.uTime, uNoise: { value: this.noise }, uIntensity: { value: 0 } },
        vertexShader: PLASMA_VERT,
        fragmentShader: PLASMA_FRAG,
        side: THREE.DoubleSide,
        transparent: true,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        depthWrite: false,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(this.plasmaGeo, mat);
      mesh.name = 'fx:reentry';
      mesh.renderOrder = 28;
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.plasma.push({ mesh, mat, target: null, intensity: 0, radius: 1, touched: false, acc: 0, dir: new THREE.Vector3(0, 0, -1) });
    }

    // ---- dust
    const dustN = Math.round(260 * this.countMul);
    this.dustGeo = makeQuadGeometry();
    const seeds = new Float32Array(dustN * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = rnd();
    this.dustGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    this.dustGeo.instanceCount = dustN;
    this.dustMat = new THREE.ShaderMaterial({
      uniforms: {
        uOffset: { value: new THREE.Vector3() },
        uCam: { value: new THREE.Vector3() },
        uStreak: { value: new THREE.Vector3() },
        uBox: { value: this.dustBox },
        uOpacity: { value: 0 },
        uViewH: sharedViewH,
      },
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      depthWrite: false,
      toneMapped: false,
    });
    this.dustMesh = new THREE.Mesh(this.dustGeo, this.dustMat);
    this.dustMesh.name = 'fx:dust';
    this.dustMesh.frustumCulled = false;
    this.dustMesh.visible = false;
    this.dustMesh.renderOrder = 29;
    hookViewport(this.dustMesh, this.dustMat);

    this.object3d.add(this.tunnelMesh, this.chunkMesh, this.dustMesh, this.bubbleMesh, this.beamMesh, this.particles.mesh, this.imm.mesh);
  }

  // ---------------------------------------------------------------------------------------------- low level

  private chunk(
    px: number, py: number, pz: number, vx: number, vy: number, vz: number,
    size: number, life: number, heat: number, metal: number, r: number, g: number, b: number,
  ): void {
    const i = this.chunkCursor;
    this.chunkCursor = (i + 1) % CHUNKS;
    const s = this.chunkState;
    const o = i * 20;
    randDir();
    s[o] = px; s[o + 1] = py; s[o + 2] = pz;
    s[o + 3] = vx; s[o + 4] = vy; s[o + 5] = vz;
    s[o + 6] = _dx; s[o + 7] = _dy; s[o + 8] = _dz; // spin axis
    s[o + 9] = rr(0, 6.28); // angle
    s[o + 10] = rr(1.2, 7) * (rnd() < 0.5 ? -1 : 1); // spin rate
    s[o + 11] = size * rr(0.7, 1.3);
    s[o + 12] = size * rr(0.35, 1.0);
    s[o + 13] = size * rr(0.5, 1.2);
    s[o + 14] = this.clock; // birth
    s[o + 15] = life;
    s[o + 16] = heat;
    s[o + 17] = metal;
    s[o + 18] = 0;
    s[o + 19] = 0;
    const col = (this.chunkMesh.instanceColor as THREE.InstancedBufferAttribute).array as Float32Array;
    // colour is stored per slot and compacted in update()
    this.chunkColors[i * 3] = r;
    this.chunkColors[i * 3 + 1] = g;
    this.chunkColors[i * 3 + 2] = b;
    void col;
    if (this.chunkLive < CHUNKS) this.chunkLive++;
  }
  private readonly chunkColors = new Float32Array(CHUNKS * 3);

  private updateChunks(dt: number): void {
    if (this.chunkLive === 0) {
      this.chunkMesh.visible = false;
      return;
    }
    const s = this.chunkState;
    const m = this.chunkMesh.instanceMatrix.array as Float32Array;
    const a = this.chunkAttr.array as Float32Array;
    const col = (this.chunkMesh.instanceColor as THREE.InstancedBufferAttribute).array as Float32Array;
    let j = 0;
    for (let i = 0; i < CHUNKS; i++) {
      const o = i * 20;
      const life = s[o + 15];
      if (life <= 0) continue;
      const age = this.clock - s[o + 14];
      if (age >= life) {
        s[o + 15] = 0;
        continue;
      }
      s[o] += s[o + 3] * dt;
      s[o + 1] += s[o + 4] * dt;
      s[o + 2] += s[o + 5] * dt;
      s[o + 9] += s[o + 10] * dt;
      const f = age / life;
      const shrink = f > 0.8 ? (1 - f) / 0.2 : 1;
      // rotation matrix from axis-angle
      const ax = s[o + 6], ay = s[o + 7], az = s[o + 8];
      const c = Math.cos(s[o + 9]);
      const sn = Math.sin(s[o + 9]);
      const t = 1 - c;
      const sx = s[o + 11] * shrink, sy = s[o + 12] * shrink, sz = s[o + 13] * shrink;
      const k = j * 16;
      m[k] = (t * ax * ax + c) * sx;
      m[k + 1] = (t * ax * ay + sn * az) * sx;
      m[k + 2] = (t * ax * az - sn * ay) * sx;
      m[k + 3] = 0;
      m[k + 4] = (t * ax * ay - sn * az) * sy;
      m[k + 5] = (t * ay * ay + c) * sy;
      m[k + 6] = (t * ay * az + sn * ax) * sy;
      m[k + 7] = 0;
      m[k + 8] = (t * ax * az + sn * ay) * sz;
      m[k + 9] = (t * ay * az - sn * ax) * sz;
      m[k + 10] = (t * az * az + c) * sz;
      m[k + 11] = 0;
      m[k + 12] = s[o];
      m[k + 13] = s[o + 1];
      m[k + 14] = s[o + 2];
      m[k + 15] = 1;
      a[j * 2] = s[o + 16] * Math.exp(-age * 1.1);
      a[j * 2 + 1] = s[o + 17];
      col[j * 3] = this.chunkColors[i * 3];
      col[j * 3 + 1] = this.chunkColors[i * 3 + 1];
      col[j * 3 + 2] = this.chunkColors[i * 3 + 2];
      j++;
    }
    this.chunkLive = j;
    this.chunkMesh.count = j;
    this.chunkMesh.visible = j > 0;
    if (j > 0) {
      this.chunkMesh.instanceMatrix.needsUpdate = true;
      this.chunkAttr.needsUpdate = true;
      (this.chunkMesh.instanceColor as THREE.InstancedBufferAttribute).needsUpdate = true;
    }
  }

  private writeBeam(slot: number, from: V3, to: V3, r: number, g: number, b: number, width: number, duration: number, kind: number): void {
    const d = this.beamData;
    const o = slot * BEAM_STRIDE;
    d[o] = from.x; d[o + 1] = from.y; d[o + 2] = from.z; d[o + 3] = width * 0.5;
    d[o + 4] = to.x; d[o + 5] = to.y; d[o + 6] = to.z; d[o + 7] = this.clock;
    d[o + 8] = r; d[o + 9] = g; d[o + 10] = b; d[o + 11] = duration;
    d[o + 12] = kind; d[o + 13] = rnd(); d[o + 14] = 0; d[o + 15] = 0;
    if (this.clock + duration > this.beamExpire) this.beamExpire = this.clock + duration;
    this.beamDirty = true;
  }

  private writeBubble(
    slot: number, cx: number, cy: number, cz: number, radius: number, vx: number, vy: number, vz: number,
    hx: number, hy: number, hz: number, duration: number, r: number, g: number, b: number, kind: number,
  ): void {
    const d = this.bubbleData;
    const o = slot * BUBBLE_STRIDE;
    d[o] = cx; d[o + 1] = cy; d[o + 2] = cz; d[o + 3] = radius;
    d[o + 4] = vx; d[o + 5] = vy; d[o + 6] = vz; d[o + 7] = this.clock;
    d[o + 8] = hx; d[o + 9] = hy; d[o + 10] = hz; d[o + 11] = duration;
    d[o + 12] = r; d[o + 13] = g; d[o + 14] = b; d[o + 15] = kind;
    if (this.clock + duration > this.bubbleExpire) this.bubbleExpire = this.clock + duration;
    this.bubbleDirty = true;
  }

  // ---------------------------------------------------------------------------------------------- public effects

  /** Cold-gas thruster puff. Call every frame while the thruster fires. `dir` = unit jet direction. */
  rcsPuff(pos: V3, dir: V3, strength = 1, vel?: V3): void {
    const p = this.particles;
    const bx = vel ? vel.x : 0, by = vel ? vel.y : 0, bz = vel ? vel.z : 0;
    this.rcsAcc += 110 * this.lastDt * this.countMul;
    let n = Math.floor(this.rcsAcc);
    this.rcsAcc -= n;
    if (n > 6) n = 6;
    const s = 0.5 + 0.5 * strength;
    for (let i = 0; i < n; i++) {
      coneDir(dir.x, dir.y, dir.z, 0.035);
      const sp = rr(22, 46) * s;
      const sub = -rnd() * this.lastDt;
      p.emit(
        pos.x, pos.y, pos.z, bx + _dx * sp, by + _dy * sp, bz + _dz * sp, rr(0.16, 0.3),
        0.62 * s, 0.72 * s, 0.9 * s, RAMP_CONST, 0.04, rr(0.5, 0.95) * s, 0, 2.2, SH_PUFF, OR_BILLBOARD, 0.04, 1.6, 1, 0, 0, sub,
      );
    }
    // hot pinpoint at the nozzle
    p.emit(pos.x, pos.y, pos.z, bx, by, bz, 0.06, 1.6 * s, 1.9 * s, 2.6 * s, RAMP_CONST, 0.16 * s, 0.1 * s, 0, 0, SH_GLOW, OR_BILLBOARD, 0.01, 1);
  }

  /** Pulsed laser: an instant line from `from` to `to` that flashes and decays over `duration` seconds. */
  laserBeam(from: V3, to: V3, color: RGB, width = 0.12, duration = 0.25): void {
    const slot = BEAM_MINING_SLOTS + this.beamCursor;
    this.beamCursor = (this.beamCursor + 1) % (this.beamCap - BEAM_MINING_SLOTS);
    const k = 5;
    this.writeBeam(slot, from, to, color[0] * k, color[1] * k, color[2] * k, width, duration, 0);
    const p = this.particles;
    p.emit(from.x, from.y, from.z, 0, 0, 0, duration * 0.8, color[0] * 6, color[1] * 6, color[2] * 6, RAMP_CONST, width * 8, width * 4, 0, 0, SH_FLARE, OR_BILLBOARD, 0.02, 1.5);
    p.emit(to.x, to.y, to.z, 0, 0, 0, duration, color[0] * 8, color[1] * 8, color[2] * 8, RAMP_CONST, width * 10, width * 5, 0, 0, SH_GLOW, OR_BILLBOARD, 0.02, 1.5);
  }

  /** Kinetic tracer round (visual only): a glowing streak that flies along `vel`. */
  tracer(pos: V3, vel: V3, color: RGB, life = 1.6): void {
    const k = 9;
    this.particles.emit(pos.x, pos.y, pos.z, vel.x, vel.y, vel.z, life, color[0] * k, color[1] * k, color[2] * k, RAMP_CONST, 0.07, 0.07, 0.022, 0, SH_STREAK, OR_VELOCITY, 0.005, 0.3);
  }

  muzzleFlash(pos: V3, dir: V3, color: RGB, size = 1): void {
    const p = this.particles;
    p.emit(pos.x, pos.y, pos.z, 0, 0, 0, 0.07, color[0] * 14, color[1] * 14, color[2] * 14, RAMP_CONST, 0.9 * size, 0.5 * size, 0, 0, SH_FLARE, OR_BILLBOARD, 0.01, 1);
    for (let i = 0; i < 3; i++) {
      coneDir(dir.x, dir.y, dir.z, 0.05);
      const sp = rr(30, 70) * size;
      p.emit(pos.x, pos.y, pos.z, _dx * sp, _dy * sp, _dz * sp, rr(0.07, 0.13), color[0] * 5, color[1] * 5, color[2] * 5, RAMP_FIRE, 0.12 * size, 0.55 * size, 0, 6, SH_PUFF, OR_BILLBOARD, 0.02, 1.2);
    }
    const n = Math.round(5 * this.countMul);
    for (let i = 0; i < n; i++) {
      coneDir(dir.x, dir.y, dir.z, 0.12);
      const sp = rr(60, 160);
      p.emit(pos.x, pos.y, pos.z, _dx * sp, _dy * sp, _dz * sp, rr(0.12, 0.3), color[0] * 6, color[1] * 6, color[2] * 6, RAMP_COOL, 0.025, 0.02, 0.02, 0, SH_STREAK, OR_VELOCITY, 0.01, 1);
    }
  }

  /** Missile exhaust trail. Call every frame with the missile position and velocity (fx frame). */
  missileTrail(pos: V3, vel: V3, color: RGB): void {
    const p = this.particles;
    const dt = this.lastDt;
    const sp = Math.hypot(vel.x, vel.y, vel.z);
    let n = Math.ceil((sp * dt) / 0.9);
    if (n < 1) n = 1;
    if (n > 10) n = 10;
    const ix = sp > 1e-3 ? vel.x / sp : 0, iy = sp > 1e-3 ? vel.y / sp : 0, iz = sp > 1e-3 ? vel.z / sp : 1;
    for (let i = 0; i < n; i++) {
      const fr = (i + rnd()) / n;
      const back = fr * dt;
      randDir();
      const j = rr(0.5, 3.5);
      p.emit(
        pos.x - vel.x * back, pos.y - vel.y * back, pos.z - vel.z * back,
        -ix * 14 + _dx * j, -iy * 14 + _dy * j, -iz * 14 + _dz * j, rr(0.5, 1.1),
        color[0] * 4.5, color[1] * 4.5, color[2] * 4.5, RAMP_FIRE, 0.14, rr(0.7, 1.3), 0, 1.5, SH_PUFF, OR_BILLBOARD, 0.02, 1.5, 1, 0, 0, -back,
      );
    }
    p.emit(pos.x, pos.y, pos.z, vel.x, vel.y, vel.z, dt * 1.5 + 0.02, color[0] * 16, color[1] * 16, color[2] * 16, RAMP_CONST, 0.8, 0.8, 0, 0, SH_FLARE, OR_BILLBOARD, 0.001, 0.2);
  }

  /** Sparks sprayed from a hull / rock impact around the surface normal. */
  impactSparks(pos: V3, normal: V3, color: RGB, strength = 1): void {
    const p = this.particles;
    const n = Math.round(22 * strength * this.countMul);
    p.emit(pos.x, pos.y, pos.z, 0, 0, 0, 0.12, color[0] * 12, color[1] * 12, color[2] * 12, RAMP_CONST, 0.5 * strength, 1.1 * strength, 0, 0, SH_GLOW, OR_BILLBOARD, 0.01, 2);
    for (let i = 0; i < n; i++) {
      coneDir(normal.x, normal.y, normal.z, 0.75);
      const sp = rr(8, 70) * (0.6 + 0.4 * strength);
      p.emit(pos.x, pos.y, pos.z, _dx * sp, _dy * sp, _dz * sp, rr(0.25, 0.9), color[0] * 7, color[1] * 7, color[2] * 7, RAMP_COOL, 0.022, 0.012, 0.035, 0, SH_STREAK, OR_VELOCITY, 0.01, 1.2);
    }
  }

  /**
   * Explosion in vacuum: flash, fireball that cools white -> orange -> dull red and thins out (no smoke),
   * straight-flying sparks, glowing tumbling debris, expanding shock ring.
   */
  explosion(pos: V3, radius: number, opts?: { kind?: ExplosionKind; vel?: V3; color?: RGB }): void {
    const kind = opts?.kind ?? 'ship';
    const vx = opts?.vel ? opts.vel.x : 0, vy = opts?.vel ? opts.vel.y : 0, vz = opts?.vel ? opts.vel.z : 0;
    this.burst(pos.x, pos.y, pos.z, radius, kind, vx, vy, vz, opts?.color);
    if (kind === 'large') {
      // chain of secondary detonations
      const n = 5;
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < SCHEDULE; k++) {
          if (this.sched[k * 8] < 0) {
            randDir();
            const d = radius * rr(0.3, 0.9);
            const o = k * 8;
            const t = rr(0.12, 1.5);
            this.sched[o] = this.clock + t;
            this.sched[o + 1] = pos.x + _dx * d + vx * t;
            this.sched[o + 2] = pos.y + _dy * d + vy * t;
            this.sched[o + 3] = pos.z + _dz * d + vz * t;
            this.sched[o + 4] = radius * rr(0.25, 0.5);
            this.sched[o + 5] = vx;
            this.sched[o + 6] = vy;
            this.sched[o + 7] = vz;
            break;
          }
        }
      }
    }
  }

  private burst(x: number, y: number, z: number, R: number, kind: ExplosionKind, vx: number, vy: number, vz: number, color?: RGB): void {
    const p = this.particles;
    const q = this.countMul;
    const rock = kind === 'rock';
    const small = kind === 'small';
    const cr = color ? color[0] : 1.0, cg = color ? color[1] : 0.5, cb = color ? color[2] : 0.16;

    if (!rock) {
      // flash + glint
      p.emit(x, y, z, vx, vy, vz, 0.2, 30, 27, 22, RAMP_CONST, R * 0.9, R * 3.2, 0, 0, SH_GLOW, OR_BILLBOARD, 0.02, 2.2);
      p.emit(x, y, z, vx, vy, vz, 0.32, 16, 13, 9, RAMP_CONST, R * 7, R * 5, 0, 0, SH_FLARE, OR_BILLBOARD, 0.03, 1.6);
      // lingering heat glow
      p.emit(x, y, z, vx, vy, vz, small ? 0.7 : 1.5, cr * 1.6, cg * 1.6, cb * 1.6, RAMP_FIRE, R * 1.2, R * 3.4, 0, 0, SH_GLOW, OR_BILLBOARD, 0.02, 1.5);
      // fireball lobes
      const nf = Math.round((small ? 10 : 26) * q);
      for (let i = 0; i < nf; i++) {
        randDir();
        const sp = R * rr(0.5, 2.6);
        const off = R * rr(0.0, 0.25);
        const life = rr(0.7, 1.7) * (small ? 0.6 : 1);
        const k = rr(5, 10);
        p.emit(
          x + _dx * off, y + _dy * off, z + _dz * off, vx + _dx * sp, vy + _dy * sp, vz + _dz * sp, life,
          cr * k, cg * k, cb * k, RAMP_FIRE, R * rr(0.22, 0.4), R * rr(0.8, 1.5), 0, rr(2.2, 3.4), SH_PUFF, OR_BILLBOARD, 0.03, 1.1,
        );
      }
      // white-hot core lobes
      const nc = Math.round((small ? 3 : 7) * q);
      for (let i = 0; i < nc; i++) {
        randDir();
        const sp = R * rr(0.1, 0.8);
        p.emit(x, y, z, vx + _dx * sp, vy + _dy * sp, vz + _dz * sp, rr(0.35, 0.8), 16, 12, 7, RAMP_FIRE, R * 0.3, R * rr(0.7, 1.1), 0, 2.5, SH_PUFF, OR_BILLBOARD, 0.02, 1.4);
      }
    } else {
      // pulverised rock: sun-lit dust lobes, no fire
      const nd = Math.round(22 * q);
      const dr = color ? color[0] : 0.42, dg = color ? color[1] : 0.37, db = color ? color[2] : 0.31;
      for (let i = 0; i < nd; i++) {
        randDir();
        const sp = R * rr(0.3, 1.8);
        const k = rr(0.35, 0.8);
        p.emit(x, y, z, vx + _dx * sp, vy + _dy * sp, vz + _dz * sp, rr(1.6, 3.6), dr * k, dg * k, db * k, RAMP_CONST, R * 0.3, R * rr(1.0, 2.0), 0, 1.2, SH_PUFF, OR_BILLBOARD, 0.04, 1.3);
      }
      p.emit(x, y, z, vx, vy, vz, 0.18, 5, 4.6, 4, RAMP_CONST, R * 0.6, R * 1.8, 0, 0, SH_GLOW, OR_BILLBOARD, 0.02, 2);
    }

    // sparks: straight lines, no drag, cooling
    const ns = Math.round((rock ? 26 : small ? 34 : 96) * q);
    for (let i = 0; i < ns; i++) {
      randDir();
      const sp = R * rr(2.5, 13) * (rnd() < 0.2 ? 1.6 : 1);
      const k = rr(6, 18) * (rock ? 0.5 : 1);
      p.emit(
        x, y, z, vx + _dx * sp, vy + _dy * sp, vz + _dz * sp, rr(0.5, 2.2),
        1.0 * k, 0.72 * k, 0.38 * k, RAMP_COOL, R * rr(0.008, 0.02), R * 0.006, 0.05, 0, SH_STREAK, OR_VELOCITY, 0.01, 1.0,
      );
    }
    // embers: slow, long-lived, twinkling
    const ne = Math.round((rock ? 0 : small ? 10 : 44) * q);
    for (let i = 0; i < ne; i++) {
      randDir();
      const sp = R * rr(0.2, 1.7);
      const k = rr(3, 7);
      p.emit(x, y, z, vx + _dx * sp, vy + _dy * sp, vz + _dz * sp, rr(2.2, 5.5), 1.0 * k, 0.5 * k, 0.16 * k, RAMP_COOL, R * rr(0.012, 0.028), R * 0.01, 0, 0.25, SH_EMBER, OR_BILLBOARD, 0.01, 0.8);
    }
    // shock ring (random plane) + thin expanding gas shell seen as a limb-brightened circle
    if (!small) {
      randDir();
      const nx = _dx, ny = _dy, nz = _dz;
      let ux = -nz, uy = 0, uz = nx;
      if (Math.abs(ny) > 0.9) {
        ux = 0; uy = nz; uz = -ny;
      }
      const ul = Math.hypot(ux, uy, uz) || 1;
      const k = rock ? 0.5 : 2.4;
      p.emit(x, y, z, nx, ny, nz, rock ? 1.2 : 0.95, 0.7 * k, 0.82 * k, 1.0 * k, RAMP_CONST, R * 0.9, R * (rock ? 6 : 10), 0, 0, SH_RING, OR_PLANE, 0.03, 1.5, ux / ul, uy / ul, uz / ul);
      if (!rock) p.emit(x, y, z, vx, vy, vz, 0.6, 1.5, 1.2, 0.9, RAMP_CONST, R * 0.8, R * 5.5, 0, 0, SH_RING, OR_BILLBOARD, 0.03, 1.4);
    }
    // debris
    const nd = Math.round((rock ? 14 : small ? 3 : 11) * Math.min(q, 1));
    for (let i = 0; i < nd; i++) {
      randDir();
      const sp = R * rr(0.4, 3.2);
      if (rock) {
        const g = rr(0.1, 0.24);
        this.chunk(x + _dx * R * 0.3, y + _dy * R * 0.3, z + _dz * R * 0.3, vx + _dx * sp * 0.6, vy + _dy * sp * 0.6, vz + _dz * sp * 0.6, R * rr(0.04, 0.16), rr(6, 11), 0, 0.05, g, g * 0.92, g * 0.82);
      } else {
        const g = rr(0.06, 0.2);
        this.chunk(x + _dx * R * 0.2, y + _dy * R * 0.2, z + _dz * R * 0.2, vx + _dx * sp, vy + _dy * sp, vz + _dz * sp, R * rr(0.03, 0.11), rr(5, 9), rr(0.5, 1), 0.85, g, g, g * 1.05);
      }
    }
  }

  /** Shield flare: hex lattice ripple radiating over a bubble from `hitPoint`. `vel` = the shielded ship's velocity. */
  shieldImpact(center: V3, radius: number, hitPoint: V3, color: RGB, vel?: V3): void {
    const slot = BUBBLE_JUMP_SLOTS + this.bubbleCursor;
    this.bubbleCursor = (this.bubbleCursor + 1) % (BUBBLE_SLOTS - BUBBLE_JUMP_SLOTS);
    let hx = hitPoint.x - center.x, hy = hitPoint.y - center.y, hz = hitPoint.z - center.z;
    const hl = Math.hypot(hx, hy, hz) || 1;
    hx /= hl; hy /= hl; hz /= hl;
    const vx = vel ? vel.x : 0, vy = vel ? vel.y : 0, vz = vel ? vel.z : 0;
    this.writeBubble(slot, center.x, center.y, center.z, radius, vx, vy, vz, hx, hy, hz, 0.85, color[0], color[1], color[2], 0);
    const p = this.particles;
    const px = center.x + hx * radius, py = center.y + hy * radius, pz = center.z + hz * radius;
    p.emit(px, py, pz, vx, vy, vz, 0.16, color[0] * 9 + 3, color[1] * 9 + 3, color[2] * 9 + 3, RAMP_CONST, radius * 0.1, radius * 0.3, 0, 0, SH_FLARE, OR_BILLBOARD, 0.02, 1.6);
    const n = Math.round(10 * this.countMul);
    for (let i = 0; i < n; i++) {
      coneDir(hx, hy, hz, 0.9);
      const sp = rr(10, 50);
      p.emit(px, py, pz, vx + _dx * sp, vy + _dy * sp, vz + _dz * sp, rr(0.2, 0.5), color[0] * 6, color[1] * 6, color[2] * 6, RAMP_CONST, 0.03, 0.015, 0.03, 0, SH_STREAK, OR_VELOCITY, 0.01, 1.3);
    }
  }

  /**
   * Jump-drive charge-up around a ship. Call every frame while charging with progress 0..1; it stops
   * when no longer called. `dir` = unit jump direction (fx frame). `id` 0..1 selects the slot.
   */
  jumpCharge(center: V3, radius: number, progress: number, dir?: V3, id = 0): void {
    const slot = id < 0 ? 0 : id >= BUBBLE_JUMP_SLOTS ? BUBBLE_JUMP_SLOTS - 1 : id | 0;
    const pr = progress < 0 ? 0 : progress > 0.999 ? 0.999 : progress;
    const dx = dir ? dir.x : 0, dy = dir ? dir.y : 0, dz = dir ? dir.z : -1;
    const R = radius * 1.25;
    this.writeBubble(slot, center.x, center.y, center.z, R, 0, 0, 0, dx, dy, dz, 0.2, 0.42, 0.72, 1.0, 1 + pr);
    // motes drawn inward toward the hull
    this.jumpAcc[slot] += (20 + 110 * pr) * this.lastDt * this.countMul;
    let n = Math.floor(this.jumpAcc[slot]);
    this.jumpAcc[slot] -= n;
    if (n > 8) n = 8;
    const p = this.particles;
    for (let i = 0; i < n; i++) {
      randDir();
      const d = R * rr(1.6, 3.2);
      const life = rr(0.5, 0.9);
      const sp = (d - R * 0.4) / life;
      const k = 2 + 5 * pr;
      p.emit(center.x + _dx * d, center.y + _dy * d, center.z + _dz * d, -_dx * sp, -_dy * sp, -_dz * sp, life, 0.45 * k, 0.75 * k, 1.0 * k, RAMP_CONST, radius * 0.012, radius * 0.006, 0.07, 0, SH_STREAK, OR_VELOCITY, 0.5, 0.2);
    }
    // core glow building at the centre
    this.imm.clock = this.clock;
    this.pendingGlow(center.x, center.y, center.z, R * (1.6 + 1.2 * pr), 0.25 * pr, 0.5 * pr, 0.9 * pr);
  }

  /** Departure / arrival flash of a jump: flare, ring and a spray of stretched light along `dir`. */
  jumpFlash(pos: V3, radius: number, dir?: V3): void {
    const p = this.particles;
    const dx = dir ? dir.x : 0, dy = dir ? dir.y : 0, dz = dir ? dir.z : -1;
    p.emit(pos.x, pos.y, pos.z, 0, 0, 0, 0.5, 26, 34, 48, RAMP_CONST, radius * 9, radius * 5, 0, 0, SH_FLARE, OR_BILLBOARD, 0.03, 2.0);
    p.emit(pos.x, pos.y, pos.z, 0, 0, 0, 0.3, 14, 18, 26, RAMP_CONST, radius * 1.5, radius * 5, 0, 0, SH_GLOW, OR_BILLBOARD, 0.03, 2.0);
    p.emit(pos.x, pos.y, pos.z, 0, 0, 0, 0.9, 1.4, 2.2, 3.6, RAMP_CONST, radius * 1.2, radius * 11, 0, 0, SH_RING, OR_BILLBOARD, 0.03, 1.6);
    let ux = -dz, uy = 0, uz = dx;
    if (Math.abs(dy) > 0.9) {
      ux = 0; uy = dz; uz = -dy;
    }
    const ul = Math.hypot(ux, uy, uz) || 1;
    p.emit(pos.x, pos.y, pos.z, dx, dy, dz, 1.1, 0.9, 1.5, 2.6, RAMP_CONST, radius * 1.5, radius * 16, 0, 0, SH_RING, OR_PLANE, 0.03, 1.8, ux / ul, uy / ul, uz / ul);
    const n = Math.round(60 * this.countMul);
    for (let i = 0; i < n; i++) {
      // streaks biased along the jump axis (both ways)
      coneDir(dx, dy, dz, rnd() < 0.7 ? 0.08 : 2);
      const sgn = rnd() < 0.5 ? -1 : 1;
      const sp = radius * rr(8, 60);
      const k = rr(4, 12);
      p.emit(pos.x, pos.y, pos.z, _dx * sp * sgn, _dy * sp * sgn, _dz * sp * sgn, rr(0.35, 1.0), 0.5 * k, 0.75 * k, 1.0 * k, RAMP_CONST, radius * 0.02, radius * 0.008, 0.09, 1.5, SH_STREAK, OR_VELOCITY, 0.01, 1.2);
    }
  }

  /** Transit effect while in jump: stretched starlight streaming past the camera. Call every frame; 0 turns it off. */
  jumpTunnel(intensity: number, dir?: V3): void {
    this.tunnelTarget = intensity < 0 ? 0 : intensity > 1 ? 1 : intensity;
    if (dir) {
      const u = this.tunnelMat.uniforms;
      const ax = u.uAxis.value as THREE.Vector3;
      ax.set(dir.x, dir.y, dir.z).normalize();
      const e1 = u.uE1.value as THREE.Vector3;
      if (Math.abs(ax.y) < 0.9) e1.set(-ax.z, 0, ax.x).normalize();
      else e1.set(0, ax.z, -ax.y).normalize();
      (u.uE2.value as THREE.Vector3).crossVectors(ax, e1);
    }
  }

  /**
   * Aerobraking plasma sheath around `target` (a ship object3d; the sheath is parented to it).
   * Call every frame while heating; `velocityDirLocal` = unit direction of travel through the air in the
   * ship's local axes. Intensity 0..1; fades out when no longer called.
   */
  reentryPlasma(target: THREE.Object3D, radius: number, intensity: number, velocityDirLocal: V3): void {
    let slot = -1;
    for (let i = 0; i < PLASMA_SLOTS; i++) if (this.plasma[i].target === target) slot = i;
    if (slot < 0) for (let i = 0; i < PLASMA_SLOTS; i++) if (this.plasma[i].target === null) slot = i;
    if (slot < 0) return;
    const s = this.plasma[slot];
    if (s.target !== target) {
      s.target = target;
      s.intensity = 0;
      target.add(s.mesh);
    }
    s.touched = true;
    s.radius = radius;
    const k = intensity < 0 ? 0 : intensity > 1 ? 1 : intensity;
    s.intensity += (k - s.intensity) * Math.min(1, this.lastDt * 6);
    s.dir.set(velocityDirLocal.x, velocityDirLocal.y, velocityDirLocal.z).normalize();
    s.mesh.quaternion.setFromUnitVectors(_yAxis, s.dir);
    s.mesh.scale.setScalar(radius);
  }

  /** Mining laser: continuous beam with melt glow, sparks and ejected rock fragments at `to`. Call every frame. */
  miningBeam(from: V3, to: V3, power = 1, slot = 0): void {
    const i = (slot < 0 ? 0 : slot >= BEAM_MINING_SLOTS ? BEAM_MINING_SLOTS - 1 : slot | 0) * 8;
    const m = this.mining;
    m[i] = from.x; m[i + 1] = from.y; m[i + 2] = from.z;
    m[i + 3] = to.x; m[i + 4] = to.y; m[i + 5] = to.z;
    m[i + 6] = power;
    m[i + 7] = 1;
  }

  /** Loose rock fragments knocked off a surface (mining, impacts). */
  rockFragments(pos: V3, normal: V3, count = 6, color?: RGB, hot = 0.6): void {
    const cr = color ? color[0] : 0.2, cg = color ? color[1] : 0.18, cb = color ? color[2] : 0.16;
    for (let i = 0; i < count; i++) {
      coneDir(normal.x, normal.y, normal.z, 0.6);
      const sp = rr(2, 14);
      const g = rr(0.6, 1.2);
      this.chunk(pos.x, pos.y, pos.z, _dx * sp, _dy * sp, _dz * sp, rr(0.06, 0.28), rr(4, 8), hot * rr(0.4, 1), 0.08, cr * g, cg * g, cb * g);
    }
  }

  /** Holographic approach corridor for a docking port (fx frame). Pass null to hide. `aligned` 0..1 tints it green. */
  dockingGuide(port: DockingPortTransform | null, size = 14, aligned = 0): void {
    if (!port) {
      this.dockOn = false;
      return;
    }
    const d = this.dock;
    d[0] = port.pos.x; d[1] = port.pos.y; d[2] = port.pos.z;
    d[3] = port.dir.x; d[4] = port.dir.y; d[5] = port.dir.z;
    d[6] = port.up.x; d[7] = port.up.y; d[8] = port.up.z;
    d[9] = size;
    d[10] = aligned;
    this.dockOn = true;
  }

  /**
   * Space dust that conveys motion. `velRel` = camera velocity relative to the local reference (station,
   * asteroid field, ...) in fx axes, m/s. `density` 0 hides it.
   */
  setDust(velRel: V3, density = 1): void {
    this.dustVel.set(velRel.x, velRel.y, velRel.z);
    this.dustDensity = density;
  }

  // immediate glows requested during the frame (jump charge core etc.)
  private readonly glowQ = new Float32Array(8 * 7);
  private glowN = 0;
  private pendingGlow(x: number, y: number, z: number, size: number, r: number, g: number, b: number): void {
    if (this.glowN >= 8) return;
    const o = this.glowN++ * 7;
    const q = this.glowQ;
    q[o] = x; q[o + 1] = y; q[o + 2] = z; q[o + 3] = size; q[o + 4] = r; q[o + 5] = g; q[o + 6] = b;
  }

  // ---------------------------------------------------------------------------------------------- frame update

  /** Advance all effects. `cameraPos` is the camera position in the fx frame. */
  update(dt: number, _time: number, cameraPos: V3): void {
    const step = dt > 0.1 ? 0.1 : dt < 0 ? 0 : dt;
    this.lastDt = step > 1e-4 ? step : 1 / 60;
    this.clock += step;
    if (this.clock > 900) {
      // re-base the clock so float32 birth times keep their precision
      const delta = 600;
      this.clock -= delta;
      this.particles.rebase(delta);
      for (let i = 0; i < this.beamCap; i++) this.beamData[i * BEAM_STRIDE + 7] -= delta;
      for (let i = 0; i < BUBBLE_SLOTS; i++) this.bubbleData[i * BUBBLE_STRIDE + 7] -= delta;
      for (let i = 0; i < CHUNKS; i++) this.chunkState[i * 20 + 14] -= delta;
      for (let i = 0; i < SCHEDULE; i++) if (this.sched[i * 8] >= 0) this.sched[i * 8] = Math.max(0, this.sched[i * 8] - delta);
      this.beamExpire -= delta;
      this.bubbleExpire -= delta;
      this.beamDirty = true;
      this.bubbleDirty = true;
    }
    const clock = this.clock;
    this.uTime.value = clock;
    this.particles.clock = clock;
    this.imm.clock = clock;
    const p = this.particles;
    const imm = this.imm;
    imm.reset();

    // scheduled secondaries
    for (let k = 0; k < SCHEDULE; k++) {
      const o = k * 8;
      const t = this.sched[o];
      if (t >= 0 && clock >= t) {
        this.sched[o] = -1;
        this.burst(this.sched[o + 1], this.sched[o + 2], this.sched[o + 3], this.sched[o + 4], 'small', this.sched[o + 5], this.sched[o + 6], this.sched[o + 7]);
      }
    }

    // mining beams
    const m = this.mining;
    for (let s = 0; s < BEAM_MINING_SLOTS; s++) {
      const i = s * 8;
      if (m[i + 7] === 0) continue;
      m[i + 7] = 0;
      const pw = m[i + 6];
      _tv.set(m[i], m[i + 1], m[i + 2]);
      _tv2.set(m[i + 3], m[i + 4], m[i + 5]);
      this.writeBeam(s, _tv, _tv2, 1.0 * 4 * pw, 0.5 * 4 * pw, 0.18 * 4 * pw, 0.16, 0.14, 1);
      // direction back toward the emitter (surface normal stand-in)
      let nx = m[i] - m[i + 3], ny = m[i + 1] - m[i + 4], nz = m[i + 2] - m[i + 5];
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const fl = 0.8 + 0.4 * rnd();
      imm.emit(m[i + 3], m[i + 4], m[i + 5], 0, 0, 0, 1, 9 * pw * fl, 5.5 * pw * fl, 2.2 * pw * fl, RAMP_CONST, 1.6, 1.6, 0, 0, SH_GLOW, OR_BILLBOARD, 1e-4, 0);
      imm.emit(m[i + 3], m[i + 4], m[i + 5], 0, 0, 0, 1, 16 * pw, 13 * pw, 9 * pw, RAMP_CONST, 2.6 * fl, 2.6, 0, 0, SH_FLARE, OR_BILLBOARD, 1e-4, 0);
      imm.emit(m[i], m[i + 1], m[i + 2], 0, 0, 0, 1, 6 * pw, 3.5 * pw, 1.4 * pw, RAMP_CONST, 0.7, 0.7, 0, 0, SH_FLARE, OR_BILLBOARD, 1e-4, 0);
      this.miningAcc[s * 2] += 90 * pw * this.lastDt * this.countMul;
      let n = Math.floor(this.miningAcc[s * 2]);
      this.miningAcc[s * 2] -= n;
      if (n > 8) n = 8;
      for (let k = 0; k < n; k++) {
        coneDir(nx, ny, nz, 0.7);
        const sp = rr(6, 46);
        const kk = rr(5, 12);
        p.emit(m[i + 3], m[i + 4], m[i + 5], _dx * sp, _dy * sp, _dz * sp, rr(0.3, 1.1), 1.0 * kk, 0.6 * kk, 0.25 * kk, RAMP_COOL, 0.03, 0.015, 0.04, 0, SH_STREAK, OR_VELOCITY, 0.01, 1.1, 1, 0, 0, -rnd() * this.lastDt);
      }
      // vaporised rock jet
      this.miningAcc[s * 2 + 1] += 14 * pw * this.lastDt;
      if (this.miningAcc[s * 2 + 1] >= 1) {
        this.miningAcc[s * 2 + 1] -= 1;
        coneDir(nx, ny, nz, 0.25);
        const sp = rr(5, 14);
        p.emit(m[i + 3], m[i + 4], m[i + 5], _dx * sp, _dy * sp, _dz * sp, rr(0.7, 1.4), 2.4, 1.3, 0.6, RAMP_FIRE, 0.4, rr(1.6, 3), 0, 1.0, SH_PUFF, OR_BILLBOARD, 0.05, 1.4);
        if (rnd() < 0.35) {
          _tv.set(m[i + 3], m[i + 4], m[i + 5]);
          _tv2.set(nx, ny, nz);
          this.rockFragments(_tv, _tv2, 1, undefined, 0.9);
        }
      }
    }

    // jump-charge core glows
    for (let i = 0; i < this.glowN; i++) {
      const o = i * 7;
      const q = this.glowQ;
      imm.emit(q[o], q[o + 1], q[o + 2], 0, 0, 0, 1, q[o + 4], q[o + 5], q[o + 6], RAMP_CONST, q[o + 3], q[o + 3], 0, 0, SH_GLOW, OR_BILLBOARD, 1e-4, 0);
    }
    this.glowN = 0;

    // docking guide
    this.dockLevel += ((this.dockOn ? 1 : 0) - this.dockLevel) * Math.min(1, step * 5);
    if (this.dockLevel > 0.01) {
      const d = this.dock;
      const size = d[9];
      const al = d[10];
      // right = up x dir
      const rx = d[7] * d[5] - d[8] * d[4];
      const ry = d[8] * d[3] - d[6] * d[5];
      const rz = d[6] * d[4] - d[7] * d[3];
      const cr = 0.435 + (0.39 - 0.435) * al, cg = 0.89 + (0.9 - 0.89) * al, cb = 1.0 + (0.63 - 1.0) * al;
      for (let i = 0; i < DOCK_FRAMES; i++) {
        const dist = size * (0.55 + 0.75 * i + 0.16 * i * i);
        const half = size * 0.5 * (1 + dist / (size * 7));
        const ph = clock * 1.3 + i * 0.75;
        const pulse = 0.28 + 0.72 * Math.pow(0.5 + 0.5 * Math.sin(ph), 6);
        const k = (0.9 + 1.8 * pulse) * this.dockLevel * (1 - 0.06 * i);
        imm.emit(d[0] + d[3] * dist, d[1] + d[4] * dist, d[2] + d[5] * dist, d[3], d[4], d[5], 1, cr * k, cg * k, cb * k, RAMP_CONST, half, half, 0, 0, SH_FRAME, OR_PLANE, 1e-4, 0, rx, ry, rz);
      }
      // centreline beads running toward the port
      const reach = size * (0.55 + 0.75 * 7 + 0.16 * 49);
      for (let i = 0; i < 14; i++) {
        const u = 1 - ((clock * 0.11 + i / 14) % 1);
        const dist = reach * u * u;
        const k = 2.2 * this.dockLevel * Math.sin(u * Math.PI);
        const sz = size * 0.016 * (1 + 4 * u);
        imm.emit(d[0] + d[3] * dist, d[1] + d[4] * dist, d[2] + d[5] * dist, 0, 0, 0, 1, cr * k, cg * k, cb * k, RAMP_CONST, sz, sz, 0, 0, SH_GLOW, OR_BILLBOARD, 1e-4, 0);
      }
    }

    // re-entry sheaths
    for (let i = 0; i < PLASMA_SLOTS; i++) {
      const s = this.plasma[i];
      if (!s.target) continue;
      if (!s.touched) s.intensity -= s.intensity * Math.min(1, step * 4);
      s.touched = false;
      if (s.intensity < 0.004) {
        s.mesh.visible = false;
        if (s.intensity < 0.001) {
          s.mesh.removeFromParent();
          s.target = null;
        }
        continue;
      }
      s.mesh.visible = true;
      s.mat.uniforms.uIntensity.value = s.intensity;
      // sparks shed from the windward side, streaming aft
      s.acc += 70 * s.intensity * s.intensity * this.lastDt * this.countMul;
      let n = Math.floor(s.acc);
      s.acc -= n;
      if (n > 6) n = 6;
      if (n > 0) {
        s.target.getWorldPosition(_tv);
        this.object3d.worldToLocal(_tv);
        _tv2.copy(s.dir).transformDirection(s.target.matrixWorld);
        s.target.getWorldQuaternion(_q);
        for (let k = 0; k < n; k++) {
          coneDir(_tv2.x, _tv2.y, _tv2.z, 0.8);
          const R = s.radius;
          const sp = rr(90, 220) * (0.5 + 0.5 * s.intensity);
          const kk = rr(4, 10);
          p.emit(
            _tv.x + _dx * R * 1.1, _tv.y + _dy * R * 1.1, _tv.z + _dz * R * 1.1,
            -_tv2.x * sp + _dx * 12, -_tv2.y * sp + _dy * 12, -_tv2.z * sp + _dz * 12, rr(0.25, 0.7),
            1.0 * kk, 0.55 * kk, 0.25 * kk, RAMP_COOL, R * 0.012, R * 0.006, 0.05, 0, SH_STREAK, OR_VELOCITY, 0.05, 1.0,
          );
        }
      }
    }

    // jump tunnel
    this.tunnelLevel += (this.tunnelTarget - this.tunnelLevel) * Math.min(1, step * 3.5);
    this.tunnelTarget = 0;
    if (this.tunnelLevel > 0.004) {
      this.tunnelMesh.visible = true;
      this.tunnelMesh.position.set(cameraPos.x, cameraPos.y, cameraPos.z);
      this.tunnelMat.uniforms.uIntensity.value = this.tunnelLevel;
    } else {
      this.tunnelMesh.visible = false;
    }

    // dust
    const dv = this.dustVel;
    const speed = dv.length();
    const vis = this.dustDensity * smooth01((speed - 0.3) / 4) * (1 - 0.85 * smooth01((speed - 400) / 1600));
    if (vis > 0.003) {
      const u = this.dustMat.uniforms;
      const box = this.dustBox;
      this.dustOff[0] = (((this.dustOff[0] + (dv.x * step) / box) % 1) + 1) % 1;
      this.dustOff[1] = (((this.dustOff[1] + (dv.y * step) / box) % 1) + 1) % 1;
      this.dustOff[2] = (((this.dustOff[2] + (dv.z * step) / box) % 1) + 1) % 1;
      (u.uOffset.value as THREE.Vector3).set(this.dustOff[0], this.dustOff[1], this.dustOff[2]);
      (u.uCam.value as THREE.Vector3).set(cameraPos.x, cameraPos.y, cameraPos.z);
      const shutter = 1 / 45;
      let sl = speed * shutter;
      if (sl > 22) sl = 22;
      const k = speed > 1e-3 ? sl / speed : 0;
      (u.uStreak.value as THREE.Vector3).set(dv.x * k, dv.y * k, dv.z * k);
      u.uOpacity.value = 0.55 * vis;
      this.dustMesh.visible = true;
    } else {
      this.dustMesh.visible = false;
    }

    this.updateChunks(step);

    // uploads + visibility
    p.flush();
    imm.flush();
    this.beamMesh.visible = clock < this.beamExpire;
    if (this.beamDirty) {
      this.beamBuf.needsUpdate = true;
      this.beamDirty = false;
    }
    this.bubbleMesh.visible = clock < this.bubbleExpire;
    if (this.bubbleDirty) {
      this.bubbleBuf.needsUpdate = true;
      this.bubbleDirty = false;
    }
  }

  dispose(): void {
    this.object3d.removeFromParent();
    this.particles.dispose();
    this.imm.dispose();
    this.beamGeo.dispose();
    this.beamMat.dispose();
    this.chunkGeo.dispose();
    this.chunkMat.dispose();
    this.chunkMesh.dispose();
    this.bubbleGeo.dispose();
    this.bubbleMat.dispose();
    this.tunnelMesh.geometry.dispose();
    this.tunnelMat.dispose();
    for (const s of this.plasma) {
      s.mesh.removeFromParent();
      s.mat.dispose();
    }
    this.plasmaGeo.dispose();
    this.dustGeo.dispose();
    this.dustMat.dispose();
    releaseNoise3D();
  }
}

function smooth01(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}
