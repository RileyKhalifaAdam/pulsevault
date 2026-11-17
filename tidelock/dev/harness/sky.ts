// Visual harness for the sky and the star.
//
//   dev/sky.html?view=sky&seed=7&look=core&yaw=0&pitch=0&fov=55&quality=high
//
//   view      sky | star-far | star-near | glare | env          (default sky)
//   seed      sky seed (integer)
//   look      core | anti | north | neb0 | neb1 | axis           where yaw/pitch 0 points
//   yaw,pitch look offsets in degrees; roll; fov is the vertical field of view in degrees
//   temp      star effective temperature, K        activity  0..1 (default by class)
//   cls       spectral class label (default from temp; "DA5" = white dwarf, "L4" = brown dwarf)
//   sid/sseed star id / visual seed (changes spots, corona, prominences)
//   ang       star angular radius, degrees         ox, oy    star offset from the view centre, degrees
//   vis       star visibility 0..1 (glare view: a dark planet limb covers the rest)
//   glare     0 hides the lens glare               occ=1     always show the dark planet limb
//   quality   low | medium | high | ultra          t  visual clock, s      anim=1 keeps animating
//   skyq      quality of the sky alone (default = quality; "low" keeps star iterations fast)
//   exposure  sky exposure                         ev exposure in stops    bloom  bloom strength
//   tm        pipeline (hue-preserving filmic, as the shipping composite pass) | aces (per channel)
//   label=1   prints the parameters, bake times, draw calls and GPU memory on the page
//
// Everything renders through a local HDR target -> thresholded bloom (Karis bright pass, down / up
// chain) -> filmic tone map -> sRGB, mirroring the constants of src/render/pipeline.ts (threshold 1.0,
// knee 0.5, strength 0.15, scatter 0.7) so the screenshots approximate the shipping look.

import * as THREE from 'three';
import type { BodyDef } from '../../src/core/types';
import { createSky, type Quality } from '../../src/render/space/sky';
import { createStarGlare, createStarVisual, starColorFromTemperature } from '../../src/render/space/star';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number): number => (params.has(k) && params.get(k) !== '' ? Number(params.get(k)) : d);
const str = (k: string, d: string): string => params.get(k) ?? d;

const view = str('view', 'sky');
const seed = num('seed', 1);
const quality = str('quality', 'medium') as Quality;
const fovDeg = num('fov', 55);
const temp = num('temp', 3200);
const defaultClass = temp >= 7300 ? 'A5V' : temp >= 6000 ? 'F5V' : temp >= 5300 ? 'G2V' : temp >= 3900 ? 'K4V' : 'M4V';
const cls = str('cls', defaultClass);
const activity = num('activity', cls.startsWith('D') ? 0 : temp < 3900 ? 0.6 : 0.25);
const angDeg = num('ang', view === 'star-near' ? 10 : view === 'glare' ? 0.7 : 0.35);
const vis = num('vis', 1);
const time0 = num('t', 12);
const anim = num('anim', 0) === 1;
const skyExposure = num('exposure', 1);
const ev = num('ev', 0);
const bloomStrength = num('bloom', 0.15);
const toneMapper = str('tm', 'pipeline');
const DEG = Math.PI / 180;

// Everything heavy runs after the load event so a long software-GL bake cannot stall page navigation.
function main(): void {
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 3));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.NoToneMapping;
renderer.setClearColor(0x000000, 1);
document.body.appendChild(renderer.domElement);

const size = renderer.getDrawingBufferSize(new THREE.Vector2());
const W = size.x;
const H = size.y;
const aspect = W / H;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(fovDeg, aspect, 0.1, 100000);

// ------------------------------------------------------------------------------------------------ content
const sky = createSky(renderer, seed, str('skyq', quality) as Quality);
scene.add(sky.object3d);
sky.update({ exposure: skyExposure });

// where to look
const lookName = str('look', 'core');
const base = new THREE.Vector3(0, 0, -1);
if (lookName === 'core') base.copy(sky.landmarks.core);
else if (lookName === 'anti') base.copy(sky.landmarks.core).negate();
else if (lookName === 'north') base.copy(sky.landmarks.north);
else if (lookName === 'neb0' && sky.landmarks.nebulae[0]) base.copy(sky.landmarks.nebulae[0]);
else if (lookName === 'neb1' && sky.landmarks.nebulae[1]) base.copy(sky.landmarks.nebulae[1]);
// camera frame with 'base' forward and galactic north roughly up
const upRef = Math.abs(base.dot(sky.landmarks.north)) < 0.95 ? sky.landmarks.north.clone() : sky.landmarks.core.clone();
if (lookName === 'axis') upRef.set(0, 1, 0);
const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), base, upRef);
camera.quaternion.setFromRotationMatrix(m);
camera.rotateY(-num('yaw', 0) * DEG);
camera.rotateX(num('pitch', 0) * DEG);
camera.rotateZ(num('roll', 0) * DEG);
camera.updateMatrixWorld(true);

// the star
const starDef: BodyDef = {
  id: str('sid', 'harness-star'),
  name: 'Harness',
  kind: 'star',
  cls: 'star',
  parentId: null,
  mass: 4e29,
  radius: 1.5e8,
  mu: 2.6e19,
  soi: Infinity,
  orbit: null,
  rotationPeriod: 2e6,
  axialTilt: 0,
  tidallyLocked: false,
  atmosphere: null,
  rings: null,
  star: { temperature: temp, luminosity: 0.01, spectralClass: cls, color: [1, 0.5, 0.2], activity },
  visual: { seed: num('sseed', 11), palette: [[1, 1, 1]] },
  temperature: temp,
  description: '',
  surveyValue: 0,
};
const starColor = starColorFromTemperature(temp);
const wantStar = view !== 'sky' && view !== 'env';
const focalPx = H / 2 / Math.tan((fovDeg * DEG) / 2);
const ang = angDeg * DEG;
const D = 1000;
// star direction: view centre plus an offset
const starDirView = new THREE.Vector3(Math.tan(num('ox', 0) * DEG), Math.tan(num('oy', 0) * DEG), -1).normalize();
const starDirWorld = starDirView.clone().applyQuaternion(camera.quaternion);
let starVisual: ReturnType<typeof createStarVisual> | null = null;
let glare: ReturnType<typeof createStarGlare> | null = null;
const camLocal = new THREE.Vector3();
if (wantStar) {
  starVisual = createStarVisual(renderer, starDef, quality);
  const scale = D * Math.sin(ang);
  starVisual.object3d.position.copy(starDirWorld).multiplyScalar(D);
  starVisual.object3d.scale.setScalar(scale);
  scene.add(starVisual.object3d);
  camLocal.copy(starDirWorld).multiplyScalar(-D / scale);
  if (num('glare', 1) === 1) {
    glare = createStarGlare(quality);
    scene.add(glare.object3d);
  }
  if ((view === 'glare' && vis < 1) || num('occ', 0) === 1) {
    // a dark planet limb covering (1 - vis) of the disc; its edge passes through the star along view-x
    const pr = 28 * DEG;
    const edge = (2 * vis - 1) * ang; // signed angular distance of the limb from the star centre
    const planetDirView = new THREE.Vector3(Math.tan(num('ox', 0) * DEG - (pr - edge)), starDirView.y / -starDirView.z, -1).normalize();
    const planet = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    const pd = 400;
    planet.position.copy(planetDirView.applyQuaternion(camera.quaternion)).multiplyScalar(pd);
    planet.scale.setScalar(pd * Math.sin(pr));
    scene.add(planet);
  }
}

if (view === 'env') {
  sky.setStarLight(camera.getWorldDirection(new THREE.Vector3()).applyAxisAngle(camera.up, 2.2), starColor, num('envstar', 1));
  scene.environment = sky.envMap;
  const geo = new THREE.SphereGeometry(1, 64, 32);
  const rough = [0.05, 0.35, 0.8];
  rough.forEach((r, i) => {
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: i === 2 ? 0xbbbbbb : 0xffffff, metalness: i === 2 ? 0 : 1, roughness: r, envMapIntensity: num('envi', 1) }));
    mesh.position.set(0, (i - 1) * 2.4, -9).applyQuaternion(camera.quaternion);
    scene.add(mesh);
  });
}

// --------------------------------------------------------------------------------------------- post chain
const rtOpts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter } as const;
const hdr = new THREE.WebGLRenderTarget(W, H, { ...rtOpts, depthBuffer: true });
const LEVELS = 6;
const down: THREE.WebGLRenderTarget[] = [];
const upT: THREE.WebGLRenderTarget[] = [];
for (let i = 0; i < LEVELS; i++) {
  const w = Math.max(2, Math.round(W / 2 ** (i + 1)));
  const h = Math.max(2, Math.round(H / 2 ** (i + 1)));
  down.push(new THREE.WebGLRenderTarget(w, h, rtOpts));
  upT.push(new THREE.WebGLRenderTarget(w, h, rtOpts));
}
const fsGeo = new THREE.BufferGeometry();
fsGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
const FS_VS = `precision highp float; in vec3 position; out vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const mkPass = (fs: string, uniforms: Record<string, THREE.IUniform>): THREE.RawShaderMaterial =>
  new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: FS_VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false });
const exposureLin = Math.pow(2, ev);
// bright pass: 4 bilinear taps (a 4x4 texel footprint), Karis-weighted so one hot texel cannot flare,
// then a soft-knee threshold on the exposed max channel
const preMat = mkPass(
  `precision highp float; uniform sampler2D uTex; uniform vec2 uTexel; uniform float uExposure; in vec2 vUv; out vec4 o;
   vec3 tap(vec2 d){ vec3 c = max(texture(uTex, vUv + uTexel * d).rgb * uExposure, vec3(0.0)); return c * min(1.0, 64.0 / max(max(c.r, max(c.g, c.b)), 1e-4)); }
   float maxc(vec3 c){ return max(c.r, max(c.g, c.b)); }
   void main(){
     vec3 a = tap(vec2(-1.0, -1.0)), b = tap(vec2(1.0, -1.0)), c = tap(vec2(-1.0, 1.0)), d = tap(vec2(1.0, 1.0));
     float wa = 1.0 / (1.0 + maxc(a)), wb = 1.0 / (1.0 + maxc(b)), wc = 1.0 / (1.0 + maxc(c)), wd = 1.0 / (1.0 + maxc(d));
     vec3 col = (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
     float br = maxc(col);
     float rq = clamp(br - 0.5, 0.0, 1.0);
     rq = 0.5 * rq * rq;
     col *= max(rq, br - 1.0) / max(br, 1e-4);
     o = vec4(col, 1.0);
   }`,
  { uTex: { value: null }, uTexel: { value: new THREE.Vector2() }, uExposure: { value: exposureLin } },
);
const downMat = mkPass(
  `precision highp float; uniform sampler2D uTex; uniform vec2 uTexel; in vec2 vUv; out vec4 o;
   void main(){
     vec3 c = texture(uTex, vUv).rgb * 4.0;
     c += texture(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb; c += texture(uTex, vUv + uTexel * vec2(1.0, -1.0)).rgb;
     c += texture(uTex, vUv + uTexel * vec2(-1.0, 1.0)).rgb;  c += texture(uTex, vUv + uTexel * vec2(1.0, 1.0)).rgb;
     o = vec4(c / 8.0, 1.0);
   }`,
  { uTex: { value: null }, uTexel: { value: new THREE.Vector2() } },
);
const upMat = mkPass(
  `precision highp float; uniform sampler2D uTex; uniform sampler2D uFine; uniform vec2 uTexel; uniform float uScatter; in vec2 vUv; out vec4 o;
   void main(){
     vec3 c = texture(uTex, vUv).rgb * 4.0;
     c += (texture(uTex, vUv + uTexel * vec2(-1.0, 0.0)).rgb + texture(uTex, vUv + uTexel * vec2(1.0, 0.0)).rgb
         + texture(uTex, vUv + uTexel * vec2(0.0, -1.0)).rgb + texture(uTex, vUv + uTexel * vec2(0.0, 1.0)).rgb) * 2.0;
     c += texture(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(uTex, vUv + uTexel * vec2(1.0, -1.0)).rgb
        + texture(uTex, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(uTex, vUv + uTexel * vec2(1.0, 1.0)).rgb;
     o = vec4(mix(texture(uFine, vUv).rgb, c / 16.0, uScatter), 1.0);
   }`,
  { uTex: { value: null }, uFine: { value: null }, uTexel: { value: new THREE.Vector2() }, uScatter: { value: 0.7 } },
);
const finalMat = mkPass(
  `precision highp float; uniform sampler2D uScene; uniform sampler2D uBloom; uniform float uStrength; uniform float uExposure; uniform float uMode; in vec2 vUv; out vec4 o;
   float maxc(vec3 c){ return max(c.r, max(c.g, c.b)); }
   float filmic(float x){ x *= 1.0 / 0.6; return clamp((x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.4329510) + 0.238081), 0.0, 1.0); }
   const mat3 RGB_TO_LMS = mat3(vec3(0.4122214708, 0.2119034982, 0.0883024619), vec3(0.5363325363, 0.6806995451, 0.2817188376), vec3(0.0514459929, 0.1073969566, 0.6299787005));
   const mat3 LMS_TO_RGB = mat3(vec3(4.0767416621, -1.2684380046, -0.0041960863), vec3(-3.3077115913, 2.6097574011, -0.7034186147), vec3(0.2309699292, -0.3413193965, 1.7076147010));
   // the shipping display transform (src/render/post/shaders.ts): filmic curve on the max channel, hue kept
   vec3 toneMapPipeline(vec3 c){
     float p = max(maxc(c), 1e-6);
     float m = filmic(p);
     vec3 col = c * (m / p);
     vec3 lms = pow(max(RGB_TO_LMS * col, vec3(0.0)), vec3(1.0 / 3.0));
     float w = 1.0 - 1.0 / (1.0 + 0.012 * max(p - 1.0, 0.0));
     lms = mix(lms, vec3(pow(m, 1.0 / 3.0)), w);
     return clamp(LMS_TO_RGB * (lms * lms * lms), 0.0, 1.0);
   }
   vec3 fit(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
   vec3 toneMapAces(vec3 c){
     const mat3 inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
     const mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
     return clamp(outM * fit(inM * (c / 0.6)), 0.0, 1.0);
   }
   float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
   void main(){
     vec3 c = max(texture(uScene, vUv).rgb, vec3(0.0)) * uExposure + texture(uBloom, vUv).rgb * uStrength;
     c = uMode > 0.5 ? toneMapAces(c) : toneMapPipeline(c);
     c = mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
     o = vec4(c + (hash(gl_FragCoord.xy) - 0.5) / 255.0, 1.0);
   }`,
  {
    uScene: { value: hdr.texture },
    uBloom: { value: null },
    uStrength: { value: bloomStrength },
    uExposure: { value: exposureLin },
    uMode: { value: toneMapper === 'aces' ? 1 : 0 },
  },
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

let sceneCalls = 0;
let sceneTris = 0;
let scenePoints = 0;

function frame(time: number): void {
  if (starVisual) starVisual.update({ time, cameraPosLocal: camLocal, pixelRadius: Math.tan(ang) * focalPx });
  if (glare) glare.update({ starDirView, starColor, angularRadius: ang, visibility: vis, aspect, fov: fovDeg * DEG });
  sky.update({ exposure: skyExposure });

  renderer.setRenderTarget(hdr);
  renderer.clear();
  renderer.render(scene, camera);
  sceneCalls = renderer.info.render.calls;
  sceneTris = renderer.info.render.triangles;
  scenePoints = renderer.info.render.points;

  preMat.uniforms.uTex.value = hdr.texture;
  preMat.uniforms.uTexel.value.set(1 / hdr.width, 1 / hdr.height);
  pass(preMat, down[0]);
  for (let i = 1; i < LEVELS; i++) {
    const src = down[i - 1];
    downMat.uniforms.uTex.value = src.texture;
    downMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
    pass(downMat, down[i]);
  }
  for (let i = LEVELS - 2; i >= 0; i--) {
    const src = i === LEVELS - 2 ? down[LEVELS - 1] : upT[i + 1];
    upMat.uniforms.uTex.value = src.texture;
    upMat.uniforms.uFine.value = down[i].texture;
    upMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
    pass(upMat, upT[i]);
  }
  finalMat.uniforms.uBloom.value = upT[0].texture;
  pass(finalMat, null);
}

const mb = (bytes: number): string => (bytes / 1048576).toFixed(1);
const win = window as unknown as Record<string, unknown>;
const report = (): void => {
  const stats = {
    view,
    quality,
    skyBakeMs: Math.round(sky.bakeMs),
    starBakeMs: starVisual ? Math.round(starVisual.bakeMs) : 0,
    skyGpuBytes: sky.gpuBytes,
    starGpuBytes: starVisual ? starVisual.gpuBytes : 0,
    drawCalls: sceneCalls,
    triangles: sceneTris,
    points: scenePoints,
    buffer: `${W}x${H}`,
  };
  win.__stats = stats;
  console.log(`[harness] ${JSON.stringify(stats)}`);
  if (num('label', 0) === 1) {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:8px;bottom:8px;font:11px ui-monospace,monospace;color:#9ab;white-space:pre;pointer-events:none';
    el.textContent =
      `${view} seed ${seed} q ${quality}  ${sceneCalls} draws  ${W}x${H}\nsky bake ${sky.bakeMs.toFixed(0)} ms  ${mb(sky.gpuBytes)} MB` +
      (starVisual ? `\nstar bake ${starVisual.bakeMs.toFixed(0)} ms  ${mb(starVisual.gpuBytes)} MB\n${temp} K ${cls}  ang ${angDeg} deg  act ${activity}` : '');
    document.body.appendChild(el);
  }
};

let frames = 0;
const start = performance.now();
const px = new Uint8Array(4);
const loop = (): void => {
  const t = anim ? time0 + (performance.now() - start) / 1000 : time0;
  frame(t);
  frames++;
  if (frames === 2) {
    // wait for the GPU: the frame really is complete before the page reports ready
    const gl = renderer.getContext();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    report();
    win.__ready = true;
  }
  if (anim || frames < 3) requestAnimationFrame(loop);
};
requestAnimationFrame(loop);
}

if (document.readyState === 'complete') setTimeout(main, 0);
else window.addEventListener('load', () => setTimeout(main, 0));
