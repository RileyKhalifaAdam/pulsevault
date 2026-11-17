// Visual harness for the planet / moon renderer.
//
//   dev/planet.html?cls=terran&seed=7&view=far&sun=55&quality=high
//
//   cls      barren | rocky | desert | lava | ice | ocean | terran | eyeball | gasGiant | iceGiant
//   seed     visual seed (integer)
//   view     far | orbit | limb | night | crescent | rings        (default far)
//              far       whole globe                      orbit    low orbit, horizon across the frame
//              limb      telephoto on the lit limb        night    night side with a thin crescent
//              crescent  star just behind the globe       rings    ringed giant from above the ring plane
//   sun      star azimuth in degrees: phase angle around the globe (far / limb / night / crescent / rings),
//            or bearing off the view direction (orbit)
//   sunel    star elevation in degrees (above the equator, or above the local horizon in orbit view)
//   quality  low | medium | high | ultra
//   gallery=1   every class in a grid (uses `sun`, `quality`)
//   bench=1     bakes the class at every quality tier's top LOD and prints time + texture memory
//   Extras:  rings=0|1  locked=0|1  city=0..1  cloud=0..1  air=0|1  star=g|k|m|<kelvin>  alt=<km> (orbit)
//            lat, lon, hdg (orbit sub-point and heading, deg)  dist=<radii>  fov=<deg>  tilt=<deg>
//            t=<sim s>  rot=<deg of spin>  anim=1 rate=<sim s per s>  ev=<exposure>  bloom=<0..1>
//            label=1  stars=0  sundisc=0  scale=<world units per radius>  async=1 (LOD re-bake path)
//            sunoff, sunroll (crescent: star offset from the limb / roll, deg)
//
// Renders into a local HDR target -> bloom (down/up-sample chain) -> ACES filmic -> sRGB, approximating
// the shipping post chain. Sets window.__ready once every body has finished baking its LOD and a frame
// has been presented.

import * as THREE from 'three';
import type { AtmosphereDef, BodyClass, BodyDef, BodyVisualDef, RGB, RingDef } from '../../src/core/types';
import { createBodyVisual, type BodyUpdateContext, type BodyVisual, type Quality } from '../../src/render/space/planet';

const params = new URLSearchParams(location.search);
const has = (k: string): boolean => params.has(k) && params.get(k) !== '';
const num = (k: string, d: number): number => (has(k) ? Number(params.get(k)) : d);
const str = (k: string, d: string): string => params.get(k) ?? d;
const DEG = Math.PI / 180;

type Cls = Exclude<BodyClass, 'star'>;
const ALL: Cls[] = ['barren', 'rocky', 'desert', 'lava', 'ice', 'ocean', 'terran', 'eyeball', 'gasGiant', 'iceGiant'];
const view = str('view', 'far');
const gallery = num('gallery', 0) === 1;
const bench = num('bench', 0) === 1;
const cls = (ALL.includes(str('cls', '') as Cls) ? str('cls', '') : view === 'rings' ? 'gasGiant' : 'terran') as Cls;
const seed = num('seed', 7);
const quality = (['low', 'medium', 'high', 'ultra'].includes(str('quality', '')) ? str('quality', '') : 'high') as Quality;
const SCALE = num('scale', 40);

// ------------------------------------------------------------------------------------------- definitions

const hex = (h: string): RGB => {
  const n = parseInt(h.slice(1), 16);
  const f = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
};
const hexes = (...h: string[]): RGB[] => h.map(hex);

// The same palettes and air tints sim/universe.ts hands out, so the harness shows what the game will.
const PALETTES: Record<Cls, RGB[][]> = {
  barren: [hexes('#353230', '#67625c', '#948e84', '#c4bcae'), hexes('#2b2624', '#5a4c44', '#8a7566', '#b9a690'), hexes('#1e1f22', '#44464b', '#74777c', '#a9abad')],
  rocky: [hexes('#43291e', '#74452f', '#a36a46', '#cc9c74'), hexes('#3a3028', '#6a5a48', '#9a8466', '#c8b592'), hexes('#33272a', '#5e4347', '#8c6660', '#b99a86')],
  desert: [hexes('#553c23', '#946635', '#c49557', '#e3cb9c'), hexes('#5c2f1e', '#9a5230', '#c98852', '#e8c79a'), hexes('#4d4530', '#857a50', '#b8ab78', '#e0d7ae')],
  lava: [hexes('#0f0908', '#241410', '#402015', '#6e3519'), hexes('#0b0b0d', '#1e1a1c', '#3a2a26', '#5e3a2a')],
  ice: [hexes('#7b90a6', '#b5c5d4', '#dbe6ee', '#f2f6fa'), hexes('#66584e', '#a59f98', '#d5d9dc', '#eef2f5'), hexes('#5d7f96', '#93b8c9', '#c9e0e8', '#eef7f9')],
  ocean: [hexes('#0a2644', '#12456c', '#2b6887', '#d4cdaa'), hexes('#0b2e3a', '#14566a', '#3a7f86', '#cfc9a8')],
  terran: [hexes('#1d3927', '#3b6536', '#858556', '#b49f78', '#e4e0d8'), hexes('#26341f', '#56683a', '#97895a', '#b7a184', '#e6e2da')],
  eyeball: [hexes('#262320', '#36372a', '#564733', '#877558', '#d4ccbc'), hexes('#231f24', '#3a2f36', '#5a4a44', '#8a7864', '#d6cec2')],
  gasGiant: [
    hexes('#c4ab85', '#a37b58', '#e1d3b3', '#85664d', '#d4bd95'),
    hexes('#b98f6a', '#8c5a3e', '#dcc3a0', '#6e4a38', '#c9a67c'),
    hexes('#d3c49b', '#bda87c', '#e4dabb', '#ab956c', '#cbb98c'),
    hexes('#254568', '#386a9a', '#1b314c', '#5589b8', '#2e5580'),
  ],
  iceGiant: [hexes('#5ab0c4', '#7acbd4', '#4695b3', '#a3dce2'), hexes('#2c5aa8', '#467ac8', '#3665b8', '#7aa3e2'), hexes('#4fa38e', '#74c4a8', '#3f8a80', '#a6dcc8')],
};
const AIR = {
  breathable: { color: hex('#6C9CF0'), sunsetColor: hex('#FF8A4A') },
  dusty: { color: hex('#D9B27C'), sunsetColor: hex('#7FA6D9') },
  thin: { color: hex('#C9A27E'), sunsetColor: hex('#6F93C9') },
  vapour: { color: hex('#FF9A4D'), sunsetColor: hex('#FF5A2A') },
  haze: { color: hex('#E0A050'), sunsetColor: hex('#B8642C') },
  hydrogenWarm: { color: hex('#E8D8B8'), sunsetColor: hex('#F0B070') },
  hydrogenHot: { color: hex('#86AEE6'), sunsetColor: hex('#E8C0A0') },
  methane: { color: hex('#8FD8E8'), sunsetColor: hex('#D8F2F0') },
};

interface DefOpts {
  rings?: boolean;
  locked?: boolean;
  city?: number;
  cloud?: number;
  air?: boolean;
  tilt?: number;
}

function makeDef(c: Cls, s: number, o: DefOpts = {}): BodyDef {
  const pal = PALETTES[c][Math.abs(s) % PALETTES[c].length];
  const air = (tint: { color: RGB; sunsetColor: RGB }, height: number, scaleHeight: number, opacity: number, scoopable = false): AtmosphereDef => ({
    height,
    scaleHeight,
    surfaceDensity: 1.2,
    color: tint.color,
    sunsetColor: tint.sunsetColor,
    opacity,
    scoopable,
  });
  let radius = 6.2e6;
  let atmosphere: AtmosphereDef | null = null;
  let visual: BodyVisualDef = { seed: s, palette: pal };
  let locked = false;
  let tilt = 0.25;
  let period = 86400;
  let rings: RingDef | null = null;
  switch (c) {
    case 'barren':
      radius = 1.74e6;
      visual = { ...visual, roughness: 0.75, craters: 0.85 };
      tilt = 0.03;
      break;
    case 'rocky':
      radius = 3.4e6;
      atmosphere = air(AIR.thin, 110e3, 11e3, 0.16);
      visual = { ...visual, roughness: 0.65, craters: 0.35, ice: 0.15, cloudCover: 0.04 };
      break;
    case 'desert':
      radius = 5.2e6;
      atmosphere = air(AIR.dusty, 150e3, 10e3, 0.45);
      visual = { ...visual, roughness: 0.5, craters: 0.1, cloudCover: 0.12, ice: 0 };
      break;
    case 'lava':
      radius = 4.9e6;
      atmosphere = air(AIR.vapour, 90e3, 9e3, 0.1);
      visual = { ...visual, roughness: 0.65, craters: 0.1, lava: 0.85 };
      break;
    case 'ice':
      radius = 1.56e6;
      visual = { ...visual, roughness: 0.35, craters: 0.25, ice: 1 };
      tilt = 0.02;
      break;
    case 'ocean':
      radius = 7.1e6;
      atmosphere = air(AIR.breathable, 150e3, 8.2e3, 0.65);
      visual = { ...visual, roughness: 0.4, oceanLevel: 0.93, oceanColor: hex('#0c2f55'), ice: 0.12, cloudCover: 0.6, cloudColor: [0.9, 0.9, 0.9] };
      break;
    case 'terran':
      radius = 6.2e6;
      atmosphere = air(AIR.breathable, 140e3, 8.5e3, 0.55);
      visual = { ...visual, roughness: 0.5, oceanLevel: 0.62, oceanColor: hex('#0d3358'), ice: 0.18, cloudCover: 0.5, cloudColor: [0.9, 0.9, 0.9], cityLights: 0.6 };
      tilt = 0.41;
      break;
    case 'eyeball':
      radius = 5.6e6;
      atmosphere = air(AIR.breathable, 130e3, 8.8e3, 0.55);
      visual = { ...visual, roughness: 0.5, oceanLevel: 0.45, oceanColor: hex('#0b2a44'), ice: 0.62, cloudCover: 0.4, cloudColor: [0.88, 0.88, 0.88], cityLights: 0.7 };
      locked = true;
      tilt = 0.02;
      period = 6.2 * 86400;
      break;
    case 'gasGiant':
      radius = 6.9e7;
      atmosphere = air(Math.abs(s) % PALETTES.gasGiant.length === 3 ? AIR.hydrogenHot : AIR.hydrogenWarm, 900e3, 27e3, 0.6, true);
      visual = { ...visual, bands: 12 + (Math.abs(s) % 7), storms: 0.6 };
      tilt = 0.32;
      period = 36000;
      break;
    case 'iceGiant':
      radius = 2.5e7;
      atmosphere = air(AIR.methane, 700e3, 20e3, 0.55, true);
      visual = { ...visual, bands: 5 + (Math.abs(s) % 3), storms: 0.25 };
      tilt = 0.5;
      period = 58000;
      break;
  }
  if (o.rings) {
    rings = {
      innerRadius: radius * (c === 'iceGiant' ? 1.55 : 1.28),
      outerRadius: radius * (c === 'iceGiant' ? 2.05 : 2.32),
      color: c === 'iceGiant' ? [0.5, 0.56, 0.6] : [0.72, 0.64, 0.52],
      opacity: c === 'iceGiant' ? 0.45 : 0.85,
      seed: s * 31 + 5,
    };
  }
  if (o.locked !== undefined) locked = o.locked;
  if (o.city !== undefined) visual.cityLights = o.city;
  if (o.cloud !== undefined) visual.cloudCover = o.cloud;
  if (o.air === false) atmosphere = null;
  if (o.tilt !== undefined) tilt = o.tilt;
  return {
    id: `harness-${c}-${s}`,
    name: c,
    kind: 'planet',
    cls: c,
    parentId: 'star',
    mass: 6e24,
    radius,
    mu: 4e14,
    soi: 1e9,
    orbit: null,
    rotationPeriod: period,
    axialTilt: tilt,
    tidallyLocked: locked,
    atmosphere,
    rings,
    star: null,
    visual,
    temperature: 280,
    description: '',
    surveyValue: 0,
  };
}

function starColor(code: string): THREE.Color {
  // linear RGB of the light, largest channel 1
  const table: Record<string, RGB> = { g: [1.0, 0.94, 0.88], k: [1.0, 0.78, 0.56], m: [1.0, 0.58, 0.32], f: [0.95, 0.97, 1.0] };
  let c = table[code];
  if (!c) {
    const k = clampN(Number(code) || 5800, 2000, 12000);
    const t = (k - 2000) / 4000;
    c = k < 6000 ? [1, 0.42 + 0.52 * Math.min(t, 1), 0.14 + 0.74 * Math.min(t, 1)] : [1 - 0.08 * ((k - 6000) / 6000), 0.96, 1];
  }
  return new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
}
function clampN(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

// ---------------------------------------------------------------------------------------------- renderer

const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 3));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.NoToneMapping;
renderer.setClearColor(0x000000, 1);
renderer.autoClear = false;
document.body.appendChild(renderer.domElement);
const size = renderer.getDrawingBufferSize(new THREE.Vector2());
const W = size.x;
const H = size.y;

const label = document.createElement('div');
label.style.cssText = 'position:fixed;left:8px;bottom:8px;font:11px ui-monospace,monospace;color:#9ab;white-space:pre;pointer-events:none;text-shadow:0 0 3px #000';
document.body.appendChild(label);

// ------------------------------------------------------------------------------------------------- cells

interface Cell {
  def: BodyDef;
  visual: BodyVisual;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  ctx: BodyUpdateContext;
  /** viewport in device px (x, y from the bottom-left, w, h) */
  vp: [number, number, number, number];
  createMs: number;
}

const light = starColor(str('star', 'g'));
const time0 = num('t', 0);
const showStars = num('stars', 1) === 1;
const showSun = num('sundisc', 1) === 1;

function starField(count: number, seedN: number): THREE.Points {
  let s = seedN >>> 0;
  const rnd = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const z = rnd() * 2 - 1;
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    pos[i * 3] = r * Math.cos(a);
    pos[i * 3 + 1] = z;
    pos[i * 3 + 2] = r * Math.sin(a);
    const mag = Math.pow(rnd(), 9) * 2.2 + 0.03 + rnd() * 0.08;
    const warm = rnd();
    col[i * 3] = mag * (0.8 + 0.2 * warm);
    col[i * 3 + 1] = mag * 0.86;
    col[i * 3 + 2] = mag * (1.0 - 0.3 * warm);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: `precision highp float; in vec3 position; in vec3 color; uniform mat4 projectionMatrix; uniform mat4 viewMatrix; uniform float uPx; out vec3 vC;
      void main(){ vC = color; vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0); gl_Position = vec4(p.xy, p.w * 0.999, p.w); gl_PointSize = uPx; }`,
    fragmentShader: `precision highp float; in vec3 vC; out vec4 o; void main(){ vec2 d = gl_PointCoord - 0.5; float a = exp(-dot(d, d) * 14.0); o = vec4(vC * a, 1.0); }`,
    uniforms: { uPx: { value: Math.max(2, Math.round(renderer.getPixelRatio() * 1.6)) } },
    depthTest: false,
    depthWrite: false,
    transparent: true,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = -20;
  return pts;
}

/** A plain HDR star disc with a soft glow, so backlit shots have their light source. Harness only. */
function sunSprite(dir: THREE.Vector3, color: THREE.Color, angRadius: number): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(2, 2);
  const mat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: `precision highp float; in vec3 position; uniform mat4 projectionMatrix; uniform mat4 viewMatrix; uniform vec3 uDir; uniform float uSize; out vec2 vP;
      void main(){ vP = position.xy; vec3 f = normalize(uDir); vec3 r = normalize(cross(vec3(0.0, 1.0, 0.0), f)); vec3 u = cross(f, r);
        vec3 w = f + (r * position.x + u * position.y) * uSize; vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * w, 1.0); gl_Position = vec4(p.xy, p.w * 0.998, p.w); }`,
    fragmentShader: `precision highp float; in vec2 vP; uniform vec3 uColor; uniform float uDisc; out vec4 o;
      void main(){ float d = length(vP); float disc = 1.0 - smoothstep(uDisc * 0.92, uDisc, d);
        float glow = 1.6 * exp(-d / (uDisc * 0.9)) + 0.10 * exp(-d * 9.0) + 0.006 / (0.012 + d * d * 30.0);
        glow *= 1.0 - smoothstep(0.7, 1.0, d);
        o = vec4(uColor * (disc * 46.0 + glow * 2.2), 1.0); }`,
    uniforms: { uDir: { value: dir.clone() }, uSize: { value: Math.tan(angRadius) * 16 }, uColor: { value: color }, uDisc: { value: 1 / 16 } },
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    blending: THREE.AdditiveBlending,
  });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.renderOrder = -10;
  return m;
}

interface Shot {
  /** camera position, body radii, world axes */
  cam: THREE.Vector3;
  /** look-at point, body radii */
  target: THREE.Vector3;
  up: THREE.Vector3;
  fov: number;
  sunDir: THREE.Vector3;
}

function shotFor(def: BodyDef, v: string, aspect: number, distOverride?: number): Shot {
  const axis = new THREE.Vector3(0, Math.cos(def.axialTilt), Math.sin(def.axialTilt));
  const fromAngles = (az: number, el: number): THREE.Vector3 => new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  const portrait = aspect < 1;
  if (v === 'orbit') {
    const giant = def.cls === 'gasGiant' || def.cls === 'iceGiant';
    const h = (num('alt', giant ? 1800 : 200) * 1000) / def.radius;
    const lat = num('lat', 24) * DEG;
    const lon = num('lon', 30) * DEG;
    const up = fromAngles(lon, lat); // local zenith
    const east = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), up).normalize();
    const north = new THREE.Vector3().crossVectors(up, east);
    const hdg = num('hdg', 55) * DEG;
    const fwd = north.clone().multiplyScalar(Math.cos(hdg)).addScaledVector(east, Math.sin(hdg));
    const right = new THREE.Vector3().crossVectors(fwd, up);
    const fov = num('fov', portrait ? 62 : 48);
    const dip = Math.acos(1 / (1 + h));
    const pitch = dip + fov * DEG * num('horizon', 0.1);
    const look = fwd.clone().multiplyScalar(Math.cos(pitch)).addScaledVector(up, -Math.sin(pitch));
    const cam = up.clone().multiplyScalar(1 + h);
    const saz = num('sun', 32) * DEG;
    const sel = num('sunel', 21) * DEG;
    const sunDir = fwd
      .clone()
      .multiplyScalar(Math.cos(saz) * Math.cos(sel))
      .addScaledVector(right, Math.sin(saz) * Math.cos(sel))
      .addScaledVector(up, Math.sin(sel))
      .normalize();
    return { cam, target: cam.clone().add(look), up, fov, sunDir };
  }
  const defaults: Record<string, { dist: number; fov: number; sun: number; sunel: number; camEl: number }> = {
    far: { dist: portrait ? 7.6 : 5.2, fov: 40, sun: 52, sunel: 12, camEl: 10 },
    limb: { dist: 2.4, fov: 20, sun: 62, sunel: 18, camEl: 8 },
    night: { dist: portrait ? 6.6 : 4.6, fov: 40, sun: 150, sunel: 6, camEl: 12 },
    crescent: { dist: portrait ? 5.6 : 4.0, fov: 40, sun: 166, sunel: 3, camEl: 6 },
    rings: { dist: portrait ? 15 : 6.4, fov: 40, sun: 58, sunel: 16, camEl: 17 },
  };
  const d = defaults[v] ?? defaults.far;
  const dist = distOverride ?? num('dist', d.dist);
  const camEl = num('camel', d.camEl) * DEG;
  // camera in a frame where "up" is the spin axis, so rings and bands sit level
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  const cam = fromAngles(0, camEl).multiplyScalar(dist).applyQuaternion(q);
  let sunDir = fromAngles(num('sun', d.sun) * DEG, num('sunel', d.sunel) * DEG)
    .applyQuaternion(q)
    .normalize();
  if (v === 'crescent' && !has('sun')) {
    // the star stands just clear of the top limb as seen from the camera: `sunoff` degrees outside it
    const toC = cam.clone().negate().normalize();
    const lift = Math.asin(1 / dist) + num('sunoff', 0.9) * DEG;
    const side = new THREE.Vector3().crossVectors(toC, axis).normalize();
    const upC = new THREE.Vector3().crossVectors(side, toC);
    const roll = num('sunroll', 12) * DEG;
    sunDir = toC
      .clone()
      .multiplyScalar(Math.cos(lift))
      .addScaledVector(upC.multiplyScalar(Math.cos(roll)).addScaledVector(side, Math.sin(roll)), Math.sin(lift))
      .normalize();
  }
  const target = new THREE.Vector3();
  const up = axis.clone();
  if (v === 'limb') {
    // aim at the limb toward the star side, tilted so the horizon runs diagonally
    const toC = cam.clone().negate().normalize();
    const side = new THREE.Vector3().crossVectors(toC, axis).normalize();
    const a = Math.asin(1 / dist);
    const lim = toC
      .clone()
      .multiplyScalar(Math.cos(a))
      .addScaledVector(side.clone().multiplyScalar(0.8).addScaledVector(axis, 0.6).normalize(), Math.sin(a));
    target.copy(cam).add(lim);
  }
  return { cam, target, up, fov: num('fov', d.fov), sunDir };
}

function makeCell(def: BodyDef, v: string, q: Quality, vp: [number, number, number, number], distOverride?: number): Cell {
  const aspect = vp[2] / vp[3];
  const shot = shotFor(def, v, aspect, distOverride);
  const camera = new THREE.PerspectiveCamera(shot.fov, aspect, 0.01 * SCALE, 4000 * SCALE);
  camera.position.copy(shot.cam).multiplyScalar(SCALE);
  camera.up.copy(shot.up);
  camera.lookAt(shot.target.clone().multiplyScalar(SCALE));
  camera.updateMatrixWorld(true);
  const dist = shot.cam.length();
  const focalPx = vp[3] / 2 / Math.tan((shot.fov * DEG) / 2);
  const pixelRadius = focalPx / Math.sqrt(Math.max(dist * dist - 1, 1e-4));

  const scene = new THREE.Scene();
  if (showStars) scene.add(starField(2600, 1234 + def.visual.seed));
  if (showSun) scene.add(sunSprite(shot.sunDir, light, num('sunang', 0.55) * DEG));
  const t0 = performance.now();
  // async=1 starts at the lowest LOD and lets update() re-bake face by face (the in-game path)
  const visual = createBodyVisual(renderer, def, q, num('async', 0) === 1 ? {} : { initialPixelRadius: pixelRadius });
  renderer.getContext().finish();
  const createMs = performance.now() - t0;
  visual.object3d.scale.setScalar(SCALE);
  scene.add(visual.object3d);
  const ctx: BodyUpdateContext = {
    sunDir: shot.sunDir,
    starColor: light,
    starIntensity: num('sunint', 1),
    time: time0 + (num('rot', 0) / 360) * def.rotationPeriod,
    cameraPosLocal: shot.cam.clone(),
    pixelRadius,
  };
  return { def, visual, scene, camera, ctx, vp, createMs };
}

const optFlag = (k: string): boolean | undefined => (has(k) ? num(k, 0) === 1 : undefined);
const defOpts: DefOpts = {
  rings: optFlag('rings') ?? view === 'rings',
  locked: optFlag('locked'),
  city: has('city') ? num('city', 0) : undefined,
  cloud: has('cloud') ? num('cloud', 0) : undefined,
  air: optFlag('air'),
  tilt: has('tilt') ? num('tilt', 0) * DEG : undefined,
};

const cells: Cell[] = [];
const names: { text: string; x: number; y: number }[] = [];
if (bench) {
  // handled below
} else if (gallery) {
  const list: { c: Cls; o: DefOpts }[] = ALL.map((c) => ({ c, o: {} }));
  list.push({ c: 'gasGiant', o: { rings: true } }, { c: 'lava', o: { locked: true } });
  const cols = W > H ? 6 : 3;
  const rows = Math.ceil(list.length / cols);
  const cw = Math.floor(W / cols);
  const ch = Math.floor(H / rows);
  list.forEach((it, i) => {
    const cx = i % cols;
    const cy = Math.floor(i / cols);
    const def = makeDef(it.c, seed + (i >= ALL.length ? 3 : 0), it.o);
    // frame every globe (or ring system) to the same share of its cell
    const focal = ch / 2 / Math.tan(20 * DEG);
    const want = (0.41 * Math.min(cw, ch)) / (it.o.rings ? 2.4 : 1);
    const dist = Math.sqrt(1 + (focal / want) * (focal / want));
    cells.push(makeCell(def, it.o.rings ? 'rings' : 'far', quality, [cx * cw, H - (cy + 1) * ch, cw, ch], dist));
    names.push({ text: it.c + (it.o.rings ? ' +rings' : it.o.locked ? ' locked' : ''), x: (cx * cw) / renderer.getPixelRatio() + 6, y: (cy * ch) / renderer.getPixelRatio() + 6 });
  });
} else {
  cells.push(makeCell(makeDef(cls, seed, defOpts), view, quality, [0, 0, W, H]));
}

if (gallery && num('label', 1) === 1) {
  for (const n of names) {
    const el = document.createElement('div');
    el.textContent = n.text;
    el.style.cssText = `position:fixed;left:${n.x}px;top:${n.y}px;font:10px ui-monospace,monospace;color:#8fa3b8;letter-spacing:0.08em;text-transform:uppercase;pointer-events:none`;
    document.body.appendChild(el);
  }
}

// --------------------------------------------------------------------------------------------- post chain
const hdr = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
const LEVELS = 6;
const down: THREE.WebGLRenderTarget[] = [];
const upT: THREE.WebGLRenderTarget[] = [];
for (let i = 0; i < LEVELS; i++) {
  const w = Math.max(2, Math.round(W / 2 ** (i + 1)));
  const h = Math.max(2, Math.round(H / 2 ** (i + 1)));
  const o = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter } as const;
  down.push(new THREE.WebGLRenderTarget(w, h, o));
  upT.push(new THREE.WebGLRenderTarget(w, h, o));
}
const fsGeo = new THREE.BufferGeometry();
fsGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
const FS_VS = `precision highp float; in vec3 position; out vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const mkPass = (fs: string, uniforms: Record<string, THREE.IUniform>): THREE.RawShaderMaterial =>
  new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: FS_VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false });
const downMat = mkPass(
  `precision highp float; uniform sampler2D uTex; uniform vec2 uTexel; in vec2 vUv; out vec4 o;
   void main(){
     vec3 c = texture(uTex, vUv).rgb * 4.0;
     c += texture(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb; c += texture(uTex, vUv + uTexel * vec2(1.0, -1.0)).rgb;
     c += texture(uTex, vUv + uTexel * vec2(-1.0, 1.0)).rgb;  c += texture(uTex, vUv + uTexel * vec2(1.0, 1.0)).rgb;
     o = vec4(min(c / 8.0, vec3(64.0)), 1.0);
   }`,
  { uTex: { value: null }, uTexel: { value: new THREE.Vector2() } },
);
const upMat = mkPass(
  `precision highp float; uniform sampler2D uTex; uniform sampler2D uAdd; uniform vec2 uTexel; in vec2 vUv; out vec4 o;
   void main(){
     vec3 c = texture(uTex, vUv).rgb * 4.0;
     c += (texture(uTex, vUv + uTexel * vec2(-1.0, 0.0)).rgb + texture(uTex, vUv + uTexel * vec2(1.0, 0.0)).rgb
         + texture(uTex, vUv + uTexel * vec2(0.0, -1.0)).rgb + texture(uTex, vUv + uTexel * vec2(0.0, 1.0)).rgb) * 2.0;
     c += texture(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(uTex, vUv + uTexel * vec2(1.0, -1.0)).rgb
        + texture(uTex, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(uTex, vUv + uTexel * vec2(1.0, 1.0)).rgb;
     o = vec4(c / 16.0 + texture(uAdd, vUv).rgb, 1.0);
   }`,
  { uTex: { value: null }, uAdd: { value: null }, uTexel: { value: new THREE.Vector2() } },
);
const finalMat = mkPass(
  `precision highp float; uniform sampler2D uScene; uniform sampler2D uBloom; uniform float uStrength; uniform float uExposure; in vec2 vUv; out vec4 o;
   vec3 fit(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
   vec3 aces(vec3 c){
     const mat3 inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
     const mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
     c *= uExposure / 0.6;
     return clamp(outM * fit(inM * c), 0.0, 1.0);
   }
   float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
   void main(){
     vec3 c = texture(uScene, vUv).rgb;
     vec3 b = texture(uBloom, vUv).rgb / ${LEVELS.toFixed(1)};
     c = mix(c, b, uStrength);
     c = aces(max(c, 0.0));
     c = mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
     o = vec4(c + (hash(gl_FragCoord.xy) - 0.5) / 255.0, 1.0);
   }`,
  { uScene: { value: hdr.texture }, uBloom: { value: null }, uStrength: { value: num('bloom', 0.07) }, uExposure: { value: num('ev', 1) } },
);
const postScene = new THREE.Scene();
const postMesh = new THREE.Mesh(fsGeo, downMat);
postMesh.frustumCulled = false;
postScene.add(postMesh);
const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const pass = (mat: THREE.RawShaderMaterial, target: THREE.WebGLRenderTarget | null): void => {
  postMesh.material = mat;
  renderer.setRenderTarget(target);
  renderer.render(postScene, postCam);
};

// --------------------------------------------------------------------------------------------- main loop
const anim = num('anim', 0) === 1;
const rate = num('rate', 600);
let frames = 0;
const syncPx = new Uint8Array(4);
let settled = 0;
const start = performance.now();

function frame(): void {
  const dt = anim ? ((performance.now() - start) / 1000) * rate : 0;
  let busy = false;
  for (const c of cells) {
    const saved = c.ctx.time;
    c.ctx.time = saved + dt;
    c.visual.update(c.ctx);
    c.ctx.time = saved;
    if (c.visual.info().busy) busy = true;
  }
  hdr.scissorTest = false;
  hdr.viewport.set(0, 0, W, H);
  renderer.setRenderTarget(hdr);
  renderer.clear();
  for (const c of cells) {
    hdr.viewport.set(c.vp[0], c.vp[1], c.vp[2], c.vp[3]);
    hdr.scissor.set(c.vp[0], c.vp[1], c.vp[2], c.vp[3]);
    hdr.scissorTest = true;
    renderer.setRenderTarget(hdr);
    renderer.render(c.scene, c.camera);
  }
  hdr.scissorTest = false;
  hdr.viewport.set(0, 0, W, H);
  for (let i = 0; i < LEVELS; i++) {
    const src = i === 0 ? hdr : down[i - 1];
    downMat.uniforms.uTex.value = src.texture;
    downMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
    pass(downMat, down[i]);
  }
  for (let i = LEVELS - 2; i >= 0; i--) {
    const src = i === LEVELS - 2 ? down[LEVELS - 1] : upT[i + 1];
    upMat.uniforms.uTex.value = src.texture;
    upMat.uniforms.uAdd.value = down[i].texture;
    upMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
    pass(upMat, upT[i]);
  }
  finalMat.uniforms.uBloom.value = upT[0].texture;
  pass(finalMat, null);
  // block until the GPU has really finished (bakes included), so __ready means "pixels are on screen"
  renderer.getContext().readPixels(0, 0, 1, 1, WebGL2RenderingContext.RGBA, WebGL2RenderingContext.UNSIGNED_BYTE, syncPx);

  frames++;
  if (!busy) settled++;
  if (settled === 2) {
    if (num('label', 0) === 1 && !gallery) {
      const c = cells[0];
      const inf = c.visual.info();
      label.textContent = `${c.def.cls} seed ${seed} · ${view} · ${quality}\ncube ${inf.resolution}px · ${(inf.textureBytes / 1048576).toFixed(1)} MiB · create ${c.createMs.toFixed(0)} ms`;
    }
    (window as unknown as { __ready: boolean }).__ready = true;
  }
  if (anim || settled < 2) requestAnimationFrame(frame);
}

function runBench(): void {
  const lines: string[] = [`bake benchmark: ${cls} seed ${seed} (SwiftShader timings are not device timings)`];
  const gl = renderer.getContext();
  const px = new Uint8Array(4);
  const tiers: Quality[] = ['low', 'medium', 'high', 'ultra'];
  label.style.cssText += ';top:60px;bottom:auto;font-size:12px;color:#cfe';
  const step = (i: number): void => {
    if (i >= tiers.length) {
      console.error(lines.join(' | '));
      (window as unknown as { __ready: boolean }).__ready = true;
      return;
    }
    const q = tiers[i];
    const t0 = performance.now();
    const v = createBodyVisual(renderer, makeDef(cls, seed, defOpts), q, { initialPixelRadius: 5000 });
    gl.finish();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const ms = performance.now() - t0;
    const inf = v.info();
    lines.push(`${q.padEnd(6)} cube ${String(inf.resolution).padStart(4)} px  bake ${ms.toFixed(0).padStart(6)} ms  textures ${(inf.textureBytes / 1048576).toFixed(1).padStart(6)} MiB`);
    v.dispose();
    label.textContent = lines.join('\n');
    setTimeout(() => step(i + 1), 30);
  };
  setTimeout(() => step(0), 50);
}

if (bench) runBench();
else requestAnimationFrame(frame);
