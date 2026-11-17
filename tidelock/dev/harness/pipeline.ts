// Visual harness for the renderer + HDR post pipeline (src/render/pipeline.ts).
//
//   dev/pipeline.html?quality=high&exposure=0&bloom=0.12&effect=jump&amount=0.7
//
//   quality   low | medium | high | ultra | auto            (default auto: what the device would get)
//   exposure  exposure in stops (EV), default 0             bloom   bloom strength (default: pipeline's)
//   effect    jump | damage | heat | flash (comma list)     amount  0..1, default 0.7
//   view      scene (default) | chart
//               scene: two layers — far: star field, an M-dwarf-orange emissive disc at 40, thin orbit
//                      lines; near (depth cleared): a metallic relay with emissive strips (2–8), a small
//                      engine core (30) and a white ceramic ring under one directional light
//               chart: measurement chart — colour patches x intensity (1/8 … 64), dark / full / HDR
//                      gradients, black / grey / white references. Layout documented at buildChart().
//   look      0 = neutral look (no split-tone, vignette, grain, aberration, sharpen; saturation 1)
//   scale     fix the dynamic-resolution scale (0.6..1)     dpr     override devicePixelRatio
//   sat, contrast, split, vig, grain, ca, sharpen, thr, knee, scatter   individual grade overrides
//   t         post clock at the captured frame, s (grain / heat / damage phase), default 1.3
//   frames    frames rendered before __ready (default 3)    anim=1  keep animating
//   stars     star count over the whole sphere (default 45000)   seed  star-field seed
//   label=1   prints the pipeline stats on the page
//
// window.__h exposes { pipeline, frame(dt), signature(), loseContext(holdMs), log } for scripted checks
// (tests/pipeline.e2e.cjs).

import * as THREE from 'three';
import {
  createPipeline,
  type EffectName,
  type GradeParams,
  type Quality,
  type RenderLayer,
  type RenderPipeline,
} from '../../src/render/pipeline';

const params = new URLSearchParams(location.search);
const has = (k: string): boolean => params.has(k) && params.get(k) !== '';
const num = (k: string, d: number): number => (has(k) ? Number(params.get(k)) : d);
const str = (k: string, d: string): string => params.get(k) ?? d;
const DEG = Math.PI / 180;

const view = str('view', 'scene');
const qualityParam = str('quality', 'auto') as Quality | 'auto';
const anim = num('anim', 0) === 1;
const framesWanted = Math.max(1, num('frames', 3));
const clock = num('t', 1.3);
const dprOverride = num('dpr', 0);

// ------------------------------------------------------------------------------------------------ pipeline
const canvas = document.createElement('canvas');
canvas.style.cssText = 'position:fixed;left:0;top:0;display:block;touch-action:none';
document.body.appendChild(canvas);

const pipeline: RenderPipeline = createPipeline(canvas, { quality: qualityParam, targetFps: 60 });
const renderer = pipeline.renderer;
const log: string[] = [];

if (has('exposure')) pipeline.setExposure(num('exposure', 0));
if (has('bloom')) pipeline.setBloom(num('bloom', 0.12));
if (has('scale')) pipeline.setDynamicResolution(false, num('scale', 1));
{
  const g: GradeParams = {};
  if (num('look', 1) === 0) {
    g.split = 0;
    g.vignette = 0;
    g.grain = 0;
    g.aberration = 0;
    g.sharpen = 0;
    g.saturation = 1;
    g.contrast = 1;
  }
  if (has('sat')) g.saturation = num('sat', 1);
  if (has('contrast')) g.contrast = num('contrast', 1);
  if (has('split')) g.split = num('split', 0);
  if (has('vig')) g.vignette = num('vig', 0);
  if (has('grain')) g.grain = num('grain', 0);
  if (has('ca')) g.aberration = num('ca', 0);
  if (has('sharpen')) g.sharpen = num('sharpen', 0);
  if (has('thr')) g.bloomThreshold = num('thr', 1);
  if (has('knee')) g.bloomKnee = num('knee', 0.5);
  if (has('scatter')) g.bloomScatter = num('scatter', 0.65);
  pipeline.setGrade(g);
}
for (const name of str('effect', '').split(',')) {
  if (name === 'jump' || name === 'damage' || name === 'heat' || name === 'flash') {
    pipeline.setEffect(name as EffectName, num('amount', 0.7));
  }
}

// ------------------------------------------------------------------------------------------------ helpers
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type RGB = readonly [number, number, number];
const hdr = (c: RGB, k: number): THREE.Color => new THREE.Color(c[0] * k, c[1] * k, c[2] * k);

/** Linear-RGB colours used throughout (see docs/ARCHITECTURE.md §6). */
const MDWARF: RGB = [1.0, 0.45, 0.2];
const AMBER: RGB = [1.0, 0.456, 0.089]; // #FFB454
const CYAN: RGB = [0.159, 0.768, 1.0]; // #6FE3FF
const WARM: RGB = [1.0, 0.78, 0.52];
const EMBER_LIGHT: RGB = [1.0, 0.74, 0.52];

// ------------------------------------------------------------------------------------------------ far layer
const farScene = new THREE.Scene();
const farCamera = new THREE.PerspectiveCamera(60, 1, 1, 5000);
const nearScene = new THREE.Scene();
const nearCamera = new THREE.PerspectiveCamera(60, 1, 0.3, 80000);

const starMaterial = new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3,
  uniforms: { uPx: { value: 1 } },
  vertexShader: /* glsl */ `
    precision highp float;
    uniform mat4 modelViewMatrix;
    uniform mat4 projectionMatrix;
    uniform float uPx;            // internal pixels per CSS pixel
    in vec3 position;
    in vec3 color;
    in float size;                // footprint diameter, CSS px
    out vec3 vColor;
    void main() {
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      float s = size * uPx;
      float ps = max(s, 1.6);     // never smaller than the pixel grid can hold: dimmer instead
      vColor = color * (s * s) / (ps * ps);
      gl_PointSize = ps;
    }`,
  fragmentShader: /* glsl */ `
    precision highp float;
    in vec3 vColor;
    out vec4 outColor;
    void main() {
      vec2 p = gl_PointCoord * 2.0 - 1.0;
      float a = max(exp(-4.0 * dot(p, p)) - 0.0183, 0.0) / 0.9817;
      outColor = vec4(vColor * a, 1.0);
    }`,
  blending: THREE.AdditiveBlending,
  depthTest: false,
  depthWrite: false,
});

function buildStars(count: number, seed: number): THREE.Points {
  const rnd = mulberry32(seed);
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  // spectral mix, roughly as the naked-eye sky reads: mostly white/blue-white, a share of warm giants
  const classes: Array<[number, RGB]> = [
    [0.1, [1.0, 0.52, 0.3]],
    [0.16, [1.0, 0.74, 0.5]],
    [0.2, [1.0, 0.91, 0.78]],
    [0.22, [1.0, 0.98, 0.95]],
    [0.2, [0.82, 0.89, 1.0]],
    [0.12, [0.66, 0.78, 1.0]],
  ];
  for (let i = 0; i < count; i++) {
    const z = rnd() * 2 - 1;
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    pos[i * 3] = r * Math.cos(a) * 1000;
    pos[i * 3 + 1] = z * 1000;
    pos[i * 3 + 2] = r * Math.sin(a) * 1000;
    // power-law brightness: thousands of faint stars, a handful that carry real HDR energy
    const flux = Math.min(40, 0.035 / Math.pow(Math.max(rnd(), 1e-6), 0.85));
    let pick = rnd();
    let c = classes[classes.length - 1][1];
    for (const [w, rgb] of classes) {
      if (pick < w) {
        c = rgb;
        break;
      }
      pick -= w;
    }
    col[i * 3] = c[0] * flux;
    col[i * 3 + 1] = c[1] * flux;
    col[i * 3 + 2] = c[2] * flux;
    size[i] = 1.1 + 0.5 * Math.log10(1 + flux * 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('size', new THREE.BufferAttribute(size, 1));
  const points = new THREE.Points(g, starMaterial);
  points.frustumCulled = false;
  return points;
}
farScene.add(buildStars(num('stars', 45000), num('seed', 11)));

// The emissive disc: exactly 40 x M-dwarf orange, flat, so its colour on screen is a measurement.
const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 96), new THREE.MeshBasicMaterial({ color: hdr(MDWARF, 40) }));
farScene.add(disc);

// Thin lines: orbit ellipses around the disc and one long straight trajectory (1 px GL lines).
const orbitGroup = new THREE.Group();
farScene.add(orbitGroup);
function orbit(radiusDeg: number, squash: number, tiltDeg: number, color: THREE.Color): void {
  const pts: THREE.Vector3[] = [];
  const r = Math.tan(radiusDeg * DEG);
  const ct = Math.cos(tiltDeg * DEG);
  const st = Math.sin(tiltDeg * DEG);
  for (let i = 0; i < 256; i++) {
    const a = (i / 256) * Math.PI * 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r * squash;
    pts.push(new THREE.Vector3(x * ct - y * st, x * st + y * ct, 0));
  }
  orbitGroup.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color })));
}
orbit(7, 0.32, 24, hdr(CYAN, 0.55));
orbit(11.5, 0.32, 24, hdr(CYAN, 0.9));
orbit(17, 0.32, 24, hdr(AMBER, 1.6));
orbit(26, 0.32, 24, hdr(CYAN, 0.3));
const trajectory = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.62, -0.2, 0), new THREE.Vector3(0.7, 0.13, 0)]),
  new THREE.LineBasicMaterial({ color: hdr(CYAN, 0.7) }),
);
orbitGroup.add(trajectory);

// ------------------------------------------------------------------------------------------------ near layer
const relay = new THREE.Group();
nearScene.add(relay);
const sun = new THREE.DirectionalLight(new THREE.Color(EMBER_LIGHT[0], EMBER_LIGHT[1], EMBER_LIGHT[2]), Math.PI);
nearScene.add(sun);

{
  const hullMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.6, 0.62, 0.66), metalness: 0.92, roughness: 0.3 });
  const darkMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.1, 0.105, 0.115), metalness: 0.85, roughness: 0.5 });
  const ceramicMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.8, 0.8, 0.8), metalness: 0, roughness: 0.62 });
  const panelMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.018, 0.03, 0.075), metalness: 0.7, roughness: 0.22 });
  const goldMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.83, 0.58, 0.22), metalness: 1, roughness: 0.3 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    relay.add(m);
    return m;
  };
  const alongX = (m: THREE.Mesh): THREE.Mesh => {
    m.rotation.z = -Math.PI / 2;
    return m;
  };

  // pressure hull (long axis X) with segment collars, nose and drive section
  alongX(add(new THREE.CylinderGeometry(0.9, 0.9, 4.2, 64, 1), hullMat));
  for (const x of [-1.9, -0.7, 0.7, 1.9]) alongX(add(new THREE.CylinderGeometry(0.94, 0.94, 0.12, 64, 1), darkMat, x));
  alongX(add(new THREE.CylinderGeometry(0.32, 0.9, 0.9, 64, 1), hullMat, 2.55));
  alongX(add(new THREE.SphereGeometry(0.32, 32, 16), goldMat, 3.0));
  alongX(add(new THREE.CylinderGeometry(0.9, 0.62, 0.5, 64, 1), darkMat, -2.35));
  const bellMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.12, 0.12, 0.13), metalness: 0.9, roughness: 0.45, side: THREE.DoubleSide });
  alongX(add(new THREE.CylinderGeometry(0.5, 0.78, 0.8, 48, 1, true), bellMat, -3.0));
  // engine core: small, blue-white, 30 — the hottest thing on the near layer
  const core = add(new THREE.CircleGeometry(0.6, 48), new THREE.MeshBasicMaterial({ color: hdr([0.62, 0.8, 1.0], 30) }), -3.05);
  core.rotation.y = -Math.PI / 2;

  // habitat ring in white ceramic (the "sun-lit white diffuse = 1.0" reference) on four spokes
  const ring = add(new THREE.TorusGeometry(2.05, 0.2, 20, 128), ceramicMat, 0.2);
  ring.rotation.y = Math.PI / 2;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const spoke = add(new THREE.CylinderGeometry(0.045, 0.045, 1.15, 12), hullMat, 0.2, Math.cos(a) * 1.42, Math.sin(a) * 1.42);
    spoke.rotation.x = a;
  }
  // warm window lights around the ring rim (instanced), 2–5
  const WINDOWS = 72;
  const winGeo = new THREE.BoxGeometry(0.07, 0.012, 0.085);
  const windows = new THREE.InstancedMesh(winGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), WINDOWS);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const rnd = mulberry32(5);
  for (let i = 0; i < WINDOWS; i++) {
    const a = (i / WINDOWS) * Math.PI * 2;
    q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), a);
    m4.compose(new THREE.Vector3(0.2 + (i % 2 ? 0.075 : -0.075), Math.cos(a) * 2.247, Math.sin(a) * 2.247), q, new THREE.Vector3(1, 1, 1));
    windows.setMatrixAt(i, m4);
    windows.setColorAt(i, hdr(WARM, rnd() < 0.3 ? 0.05 : 2 + rnd() * 3));
  }
  relay.add(windows);

  // emissive strips along the hull: amber 6, cyan 3, and a cyan hoop 2.5
  const stripGeo = new THREE.BoxGeometry(2.3, 0.035, 0.05);
  const strip = (angle: number, color: THREE.Color, x: number): void => {
    const s = add(stripGeo, new THREE.MeshBasicMaterial({ color }), x, Math.cos(angle) * 0.905, Math.sin(angle) * 0.905);
    s.rotation.x = angle;
  };
  strip(0.55, hdr(AMBER, 6), 0.55);
  strip(1.35, hdr(AMBER, 3.5), -0.6);
  strip(-0.3, hdr(CYAN, 3), -0.45);
  strip(2.3, hdr(AMBER, 8), 0.3);
  const hoop = add(new THREE.TorusGeometry(0.915, 0.018, 8, 96), new THREE.MeshBasicMaterial({ color: hdr(CYAN, 2.5) }), 1.3);
  hoop.rotation.y = Math.PI / 2;

  // radiator / solar wings on a boom, a mast with a dish, navigation lights
  for (const s of [-1, 1]) {
    const boom = add(new THREE.CylinderGeometry(0.035, 0.035, 2.3, 10), hullMat, -1.25, 0, s * 2.0);
    boom.rotation.x = Math.PI / 2;
    add(new THREE.BoxGeometry(1.5, 0.03, 2.6), panelMat, -1.25, 0, s * 4.3);
    add(new THREE.BoxGeometry(1.56, 0.05, 0.05), hullMat, -1.25, 0, s * 3.0);
    add(new THREE.SphereGeometry(0.045, 12, 8), new THREE.MeshBasicMaterial({ color: s < 0 ? hdr([1, 0.1, 0.06], 8) : hdr([0.1, 1, 0.3], 6) }), -1.25, 0.05, s * 5.62);
  }
  add(new THREE.CylinderGeometry(0.014, 0.014, 2.6, 8), hullMat, 1.4, 2.2, 0); // thin mast: sub-pixel geometry
  add(new THREE.CylinderGeometry(0.01, 0.01, 1.7, 6), hullMat, 1.75, 1.75, 0).rotation.z = -0.5;
  const dishPts: THREE.Vector2[] = [];
  for (let i = 0; i <= 12; i++) {
    const r = (i / 12) * 0.62;
    dishPts.push(new THREE.Vector2(r, r * r * 0.55));
  }
  const dish = add(new THREE.LatheGeometry(dishPts, 48), new THREE.MeshStandardMaterial({ color: new THREE.Color(0.75, 0.76, 0.78), metalness: 0.4, roughness: 0.5, side: THREE.DoubleSide }), 1.4, 3.3, 0);
  dish.rotation.set(0.5, 0, -0.6);
  add(new THREE.SphereGeometry(0.035, 10, 8), new THREE.MeshBasicMaterial({ color: hdr([1, 1, 1], 8) }), 1.4, 3.52, 0);
}

// Environment for the metals: dark space, a warm glow around the star and cool planet-shine from below.
const envScene = new THREE.Scene();
const envUniforms = { uSunDir: { value: new THREE.Vector3(0, 1, 0) } };
envScene.add(
  new THREE.Mesh(
    new THREE.SphereGeometry(10, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: envUniforms,
      vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: /* glsl */ `
        uniform vec3 uSunDir; varying vec3 vDir;
        void main(){
          vec3 d = normalize(vDir);
          float s = max(dot(d, uSunDir), 0.0);
          vec3 c = vec3(0.012, 0.014, 0.02);
          c += vec3(1.0, 0.62, 0.36) * (30.0 * pow(s, 420.0) + 1.3 * pow(s, 7.0));
          // planet-shine: a broad cool limb below, brightest along its sunward edge
          float h = d.y + 0.3 * d.x + 0.25;
          c += vec3(0.22, 0.4, 0.7) * (0.5 * smoothstep(0.05, -0.6, h) + 1.6 * exp(-40.0 * h * h));
          gl_FragColor = vec4(c, 1.0);
        }`,
    }),
  ),
);
let envTarget: THREE.WebGLRenderTarget | null = null;
function buildEnvironment(): void {
  envTarget?.dispose();
  const pmrem = new THREE.PMREMGenerator(renderer);
  envTarget = pmrem.fromScene(envScene, 0, 0.1, 100);
  pmrem.dispose();
  nearScene.environment = envTarget.texture;
}

// ------------------------------------------------------------------------------------------------ chart
// Measurement chart, in fractions of the frame (u from the left, v from the top):
//   patches   8 rows x 10 columns. Row r at v = 0.02 + 0.07 r .. +0.064; column c at u = 0.02 + 0.096 c .. +0.092.
//             Rows: M-dwarf orange, amber, red, blue-white, cyan, blue, green, white.
//             Column c has intensity 2^(c - 3): 1/8 … 64 (max channel).
//   v 0.60–0.66   gradient 0 -> 0.02 (deep shadows: banding / dither)
//   v 0.68–0.74   gradient 0 -> 1
//   v 0.76–0.82   gradient 0 -> 16 (white roll-off)
//   v 0.84–0.90   gradient of M-dwarf orange 0 -> 64
//   v 0.92–0.98   patches at u 0.02–0.30 black, 0.34–0.62 grey 0.18, 0.66–0.98 white 1.0
const CHART_COLOURS: RGB[] = [MDWARF, AMBER, [1, 0.08, 0.04], [0.55, 0.7, 1], CYAN, [0.1, 0.2, 1], [0.12, 0.79, 0.36], [1, 1, 1]];
const chartScene = new THREE.Scene();
const chartCamera = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
function buildChart(): void {
  const pos: number[] = [];
  const col: number[] = [];
  const quad = (u0: number, v0: number, u1: number, v1: number, cl: RGB, cr: RGB): void => {
    const y0 = 1 - v1;
    const y1 = 1 - v0;
    pos.push(u0, y0, 0, u1, y0, 0, u1, y1, 0, u0, y0, 0, u1, y1, 0, u0, y1, 0);
    col.push(...cl, ...cr, ...cr, ...cl, ...cr, ...cl);
  };
  const mul = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
  CHART_COLOURS.forEach((c, r) => {
    for (let i = 0; i < 10; i++) {
      const k = Math.pow(2, i - 3);
      const u = 0.02 + 0.096 * i;
      const v = 0.02 + 0.07 * r;
      quad(u, v, u + 0.092, v + 0.064, mul(c, k), mul(c, k));
    }
  });
  const black: RGB = [0, 0, 0];
  quad(0.02, 0.6, 0.98, 0.66, black, [0.02, 0.02, 0.02]);
  quad(0.02, 0.68, 0.98, 0.74, black, [1, 1, 1]);
  quad(0.02, 0.76, 0.98, 0.82, black, [16, 16, 16]);
  quad(0.02, 0.84, 0.98, 0.9, black, mul(MDWARF, 64));
  quad(0.02, 0.92, 0.3, 0.98, black, black);
  quad(0.34, 0.92, 0.62, 0.98, [0.18, 0.18, 0.18], [0.18, 0.18, 0.18]);
  quad(0.66, 0.92, 0.98, 0.98, [1, 1, 1], [1, 1, 1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true }));
  mesh.frustumCulled = false;
  chartScene.add(mesh);
}
if (view === 'chart') buildChart();

// ------------------------------------------------------------------------------------------------ layout
const TAN_SHORT = Math.tan(21 * DEG); // the short side of the frame always spans 42 degrees
const tmpDir = new THREE.Vector3();
/** Direction for a point `along` the long axis and `across` the short one, in short-half-extent units. */
function place(along: number, across: number, portrait: boolean, out: THREE.Vector3): THREE.Vector3 {
  const x = portrait ? across : -along;
  const y = portrait ? along : across;
  return out.set(x * TAN_SHORT, y * TAN_SHORT, -1).normalize();
}

function layout(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const aspect = w / h;
  const portrait = aspect < 1;
  const fov = 2 * Math.atan(portrait ? TAN_SHORT / aspect : TAN_SHORT) / DEG;
  for (const cam of [farCamera, nearCamera]) {
    cam.fov = fov;
    cam.aspect = aspect;
    cam.updateProjectionMatrix();
  }
  // far: the disc (angular radius 2.3 deg) and the orbits drawn around it
  place(1.12, portrait ? -0.36 : 0.4, portrait, tmpDir);
  disc.position.copy(tmpDir).multiplyScalar(900);
  disc.scale.setScalar(900 * Math.tan(2.3 * DEG));
  disc.lookAt(0, 0, 0);
  orbitGroup.position.copy(tmpDir).multiplyScalar(800);
  orbitGroup.scale.setScalar(800);
  orbitGroup.lookAt(0, 0, 0);
  orbitGroup.rotateZ(portrait ? 0.25 : -0.5);
  // light: from the disc's side of the frame, a little behind the camera so the near side is lit
  sun.position.set(tmpDir.x * 2.6, tmpDir.y * 2.6, 0.75).normalize();
  envUniforms.uSunDir.value.copy(sun.position);
  // near: the relay, three-quarter view
  place(-0.62, portrait ? 0.1 : -0.22, portrait, tmpDir);
  relay.position.copy(tmpDir).multiplyScalar(13.5);
  relay.rotation.set(0.34, portrait ? 0.98 : 0.9, portrait ? 0.34 : 0.14, 'YXZ');
}

// ------------------------------------------------------------------------------------------------ frame loop
const layers: RenderLayer[] =
  view === 'chart'
    ? [{ scene: chartScene, camera: chartCamera }]
    : [
        { scene: farScene, camera: farCamera },
        { scene: nearScene, camera: nearCamera, clearDepth: true },
      ];

function frame(dt: number): void {
  starMaterial.uniforms.uPx.value = pipeline.pixelRatio;
  pipeline.render(layers, dt);
}

const labelEl = num('label', 0) === 1 ? document.createElement('div') : null;
if (labelEl) {
  labelEl.style.cssText =
    'position:fixed;left:8px;bottom:8px;padding:6px 8px;background:rgba(10,14,20,.72);border:1px solid rgba(255,255,255,.08);color:#E8EEF5;font:11px/1.35 ui-monospace,Menlo,monospace;white-space:pre;pointer-events:none';
  document.body.appendChild(labelEl);
}
function updateLabel(): void {
  if (!labelEl) return;
  const s = pipeline.stats();
  labelEl.textContent =
    `quality ${pipeline.quality} (auto: ${s.gpuTier})  msaa ${s.msaa}  passes ${s.postPasses}\n` +
    `scene ${s.width}x${s.height}  out ${s.outputWidth}x${s.outputHeight}  scale ${s.resolutionScale.toFixed(2)}\n` +
    `draws ${s.drawCalls}  tris ${s.triangles}  ${s.frameMs.toFixed(1)} ms  ${(s.targetBytes / 1048576).toFixed(1)} MiB\n` +
    `${s.gpuName.slice(0, 44)}`;
}

function fit(): void {
  layout();
  pipeline.resize(window.innerWidth, window.innerHeight, dprOverride > 0 ? dprOverride : window.devicePixelRatio || 1);
}

let pending = 0;
function renderBurst(n: number, done?: () => void): void {
  const token = ++pending;
  let left = n;
  const step = (): void => {
    if (token !== pending) return;
    frame(clock / n);
    updateLabel();
    if (--left > 0) requestAnimationFrame(step);
    else done?.();
  };
  requestAnimationFrame(step);
}

window.addEventListener('resize', () => {
  fit();
  if (!anim) renderBurst(2);
});

pipeline.onContextLost = () => {
  log.push('lost');
};
pipeline.onContextRestored = () => {
  log.push('restored');
  if (view !== 'chart') buildEnvironment(); // GPU-only data: has to be rendered again
};

interface HarnessApi {
  pipeline: RenderPipeline;
  log: string[];
  frame(dt?: number): void;
  /** Render one frame and return 8x8 mean luminances (0..255) of the canvas plus its mean R, G, B. */
  signature(): number[];
  /** Lose the WebGL context, keep rendering into the void for `holdMs`, restore, render again. */
  loseContext(holdMs?: number): Promise<string[]>;
}
const win = window as unknown as { __ready?: boolean; __h?: HarnessApi };

const readBuf = { data: new Uint8Array(0) };
win.__h = {
  pipeline,
  log,
  frame: (dt = 1 / 60) => frame(dt),
  signature(): number[] {
    frame(0);
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    if (readBuf.data.length !== w * h * 4) readBuf.data = new Uint8Array(w * h * 4);
    const px = readBuf.data;
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const out = new Array<number>(67).fill(0);
    const n = new Array<number>(64).fill(0);
    for (let y = 0; y < h; y++) {
      const gy = Math.min(7, Math.floor((y / h) * 8));
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const cell = gy * 8 + Math.min(7, Math.floor((x / w) * 8));
        out[cell] += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        n[cell]++;
        out[64] += px[i];
        out[65] += px[i + 1];
        out[66] += px[i + 2];
      }
    }
    for (let c = 0; c < 64; c++) out[c] /= Math.max(1, n[c]);
    for (let c = 64; c < 67; c++) out[c] /= w * h;
    return out;
  },
  loseContext(holdMs = 250): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const ext = renderer.getContext().getExtension('WEBGL_lose_context');
      if (!ext) {
        reject(new Error('WEBGL_lose_context unavailable'));
        return;
      }
      canvas.addEventListener(
        'webglcontextrestored',
        () => {
          // our listener runs after the pipeline's: the hooks have fired, targets are back
          setTimeout(() => renderBurst(2, () => resolve(log.slice())), 0);
        },
        { once: true },
      );
      ext.loseContext();
      const spin = setInterval(() => frame(1 / 60), 16); // a game loop does not know yet: must be harmless
      setTimeout(() => {
        clearInterval(spin);
        ext.restoreContext();
      }, holdMs);
    });
  },
};

fit();
if (view !== 'chart') buildEnvironment();
if (anim) {
  let last = performance.now();
  let count = 0;
  const loop = (now: number): void => {
    frame(Math.min(0.1, (now - last) / 1000));
    last = now;
    updateLabel();
    if (++count === framesWanted) win.__ready = true;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
} else {
  renderBurst(framesWanted, () => {
    win.__ready = true;
  });
}
