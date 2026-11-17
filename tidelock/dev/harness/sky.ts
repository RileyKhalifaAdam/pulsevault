// Visual harness for the sky and the star.
//
//   dev/sky.html?view=sky&seed=7&look=core&yaw=0&pitch=0&fov=55&quality=high
//
//   view      sky | star-far | star-near | glare | env          (default sky)
//   seed      sky seed (integer)
//   look      core | anti | north | neb0 | neb1 | axis           where yaw/pitch 0 points (sky / env views)
//   yaw,pitch look offsets in degrees; fov is the vertical field of view in degrees
//   temp      star effective temperature, K        activity  0..1        sid  star id (changes spots)
//   ang       star angular radius, degrees         ox, oy    star offset from the view centre, degrees
//   vis       star visibility 0..1 (glare view: a dark planet limb covers the rest)
//   quality   low | medium | high | ultra          t  visual clock, s      anim=1 keeps animating
//   exposure  sky exposure                         ev tone-map exposure    bloom  bloom strength
//   label=1   prints the parameters and bake times on the page
//
// Everything renders through a local HDR target -> bloom (down/up-sample chain) -> ACES filmic -> sRGB so
// the screenshots approximate the shipping post pipeline (which lives elsewhere and is not used here).

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
const activity = num('activity', 0.6);
const angDeg = num('ang', view === 'star-near' ? 10 : view === 'glare' ? 0.7 : 0.35);
const vis = num('vis', 1);
const time0 = num('t', 12);
const anim = num('anim', 0) === 1;
const skyExposure = num('exposure', view === 'star-near' ? 0.35 : 1);
const ev = num('ev', 1);
const bloomStrength = num('bloom', 0.06);
const DEG = Math.PI / 180;

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
const sky = createSky(renderer, seed, quality);
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
const roll = num('roll', 0) * DEG;
const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), base, upRef);
camera.quaternion.setFromRotationMatrix(m);
camera.rotateY(-num('yaw', 0) * DEG);
camera.rotateX(num('pitch', 0) * DEG);
camera.rotateZ(roll);
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
  star: { temperature: temp, luminosity: 0.01, spectralClass: 'M4V', color: [1, 0.5, 0.2], activity },
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
const starDirView = new THREE.Vector3(Math.tan(num('ox', 0) * DEG), Math.tan(num('oy', view === 'star-near' ? 0 : 0) * DEG), -1).normalize();
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
  if (view === 'glare' && vis < 1) {
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
const hdr = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
const LEVELS = 6;
const down: THREE.WebGLRenderTarget[] = [];
const upT: THREE.WebGLRenderTarget[] = [];
for (let i = 0; i < LEVELS; i++) {
  const w = Math.max(2, Math.round(W / 2 ** (i + 1)));
  const h = Math.max(2, Math.round(H / 2 ** (i + 1)));
  const opts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter } as const;
  down.push(new THREE.WebGLRenderTarget(w, h, opts));
  upT.push(new THREE.WebGLRenderTarget(w, h, opts));
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
     o = vec4(c / 8.0, 1.0);
   }`,
  { uTex: { value: null }, uTexel: { value: new THREE.Vector2() } },
);
const upMat = mkPass(
  `precision highp float; uniform sampler2D uTex; uniform sampler2D uAdd; uniform vec2 uTexel; uniform float uAddW; in vec2 vUv; out vec4 o;
   void main(){
     vec3 c = texture(uTex, vUv).rgb * 4.0;
     c += (texture(uTex, vUv + uTexel * vec2(-1.0, 0.0)).rgb + texture(uTex, vUv + uTexel * vec2(1.0, 0.0)).rgb
         + texture(uTex, vUv + uTexel * vec2(0.0, -1.0)).rgb + texture(uTex, vUv + uTexel * vec2(0.0, 1.0)).rgb) * 2.0;
     c += texture(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(uTex, vUv + uTexel * vec2(1.0, -1.0)).rgb
        + texture(uTex, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(uTex, vUv + uTexel * vec2(1.0, 1.0)).rgb;
     o = vec4(c / 16.0 + texture(uAdd, vUv).rgb * uAddW, 1.0);
   }`,
  { uTex: { value: null }, uAdd: { value: null }, uTexel: { value: new THREE.Vector2() }, uAddW: { value: 1 } },
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
  { uScene: { value: hdr.texture }, uBloom: { value: null }, uStrength: { value: bloomStrength }, uExposure: { value: ev } },
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

function frame(time: number): void {
  if (starVisual) starVisual.update({ time, cameraPosLocal: camLocal, pixelRadius: Math.tan(ang) * focalPx });
  if (glare) glare.update({ starDirView, starColor, angularRadius: ang, visibility: vis, aspect, fov: fovDeg * DEG });
  sky.update({ cameraQuat: camera.quaternion, exposure: skyExposure });

  renderer.setRenderTarget(hdr);
  renderer.clear();
  renderer.render(scene, camera);

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
}

if (num('label', 0) === 1) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:8px;bottom:8px;font:11px ui-monospace,monospace;color:#9ab;white-space:pre;pointer-events:none';
  el.textContent = `${view} seed ${seed} q ${quality}\nsky bake ${sky.bakeMs.toFixed(0)} ms` + (starVisual ? `  star bake ${starVisual.bakeMs.toFixed(0)} ms\n${temp} K  ang ${angDeg} deg  act ${activity}` : '');
  document.body.appendChild(el);
}
console.log(`[harness] sky bake ${sky.bakeMs.toFixed(0)} ms` + (starVisual ? `, star bake ${starVisual.bakeMs.toFixed(0)} ms` : ''));
(window as unknown as Record<string, unknown>).__bake = { sky: sky.bakeMs, star: starVisual ? starVisual.bakeMs : 0 };

let frames = 0;
const start = performance.now();
const loop = (): void => {
  const t = anim ? time0 + (performance.now() - start) / 1000 : time0;
  frame(t);
  frames++;
  if (frames === 2) (window as unknown as Record<string, unknown>).__ready = true;
  if (anim || frames < 3) requestAnimationFrame(loop);
};
requestAnimationFrame(loop);
