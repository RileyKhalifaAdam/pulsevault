// Visual harness for src/render/space/ships.ts (+ hullMaterials.ts, geo.ts).
//
//   dev/ships.html?ship=wren&yaw=35&pitch=20&dist=30&throttle=1&livery=default&lod=0
//
//   ship      wren | drover | magpie | shrike | albatross | caravel | halberd
//   yaw       camera azimuth, deg: 0 = behind the ship (chase), 90 = starboard side, 180 = head-on
//   pitch     camera elevation, deg (89 = top view)          dist   camera distance, m (default fits the hull)
//   throttle  0..1 engine-bell glow                          heat / damage  0..1
//   livery    default | assembly | hegemony | league | scorch | plain
//   lod       0 = hero (default), 1 = reduced, auto = distance switch
//   lineup=1  all seven hulls side by side, to scale         swatch=1  material swatches
//   sun=az,el absolute key-light direction, deg (default: 55 deg to the right of the camera, 40 deg up)
//   layout=1  markers at the shipLayouts positions            info=1  triangles / draw calls / build time
//   q         low | medium | high (default) | ultra           time  seconds (blink phase)   lights=0  nav lights off
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { RGB, ShipLayout, ShipVisualId } from '../../src/core/types';
import { LAYER, MeshBuilder, CHANNEL_COUNT, hullStyle } from '../../src/render/space/geo';
import { createHullMaterials, type HullQuality, type Livery } from '../../src/render/space/hullMaterials';
import { SHIP_LIVERIES, createShipVisual, type ShipVisual } from '../../src/render/space/ships';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number): number => (params.has(k) ? Number(params.get(k)) : d);
const str = (k: string, d: string): string => params.get(k) ?? d;
const DEG = Math.PI / 180;

const ALL: ShipVisualId[] = ['wren', 'shrike', 'magpie', 'albatross', 'drover', 'halberd', 'caravel'];
const shipId = str('ship', 'wren') as ShipVisualId;
const quality = str('q', 'high') as HullQuality;
const yaw = num('yaw', 35) * DEG;
const pitch = num('pitch', 20) * DEG;
const lodParam = str('lod', '0');
const lodMode = lodParam === 'auto' ? 'auto' : lodParam === '1' ? 'low' : 'hero';

const LIVERIES: Record<string, Livery | null> = {
  default: null,
  assembly: { primary: [0.62, 0.66, 0.68], secondary: [0.05, 0.2, 0.22], accent: [0.05, 0.62, 0.58] },
  hegemony: { primary: [0.1, 0.095, 0.09], secondary: [0.3, 0.27, 0.22], accent: [0.85, 0.55, 0.1] },
  league: { primary: [0.2, 0.19, 0.26], secondary: [0.06, 0.055, 0.08], accent: [0.34, 0.2, 0.9] },
  scorch: { primary: [0.2, 0.06, 0.04], secondary: [0.04, 0.04, 0.04], accent: [0.85, 0.75, 0.6] },
  plain: { primary: [0.6, 0.6, 0.6], secondary: [0.3, 0.3, 0.3], accent: [0.6, 0.6, 0.6] },
};
const livery = LIVERIES[str('livery', 'default')] ?? undefined;

// ------------------------------------------------------------------------------------------------ stage

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
const pr = Math.min(window.devicePixelRatio, 2);
renderer.setPixelRatio(pr);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(num('fov', 38), window.innerWidth / window.innerHeight, 0.3, 80000);

const camDir = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
let sunAz = yaw + 55 * DEG;
let sunEl = 40 * DEG;
if (params.has('sun')) {
  const [a, e] = str('sun', '0,40').split(',').map(Number);
  sunAz = a * DEG;
  sunEl = e * DEG;
}
const sunDir = new THREE.Vector3(Math.sin(sunAz) * Math.cos(sunEl), Math.sin(sunEl), Math.cos(sunAz) * Math.cos(sunEl));
const starCol = str('star', 'white') === 'ember' ? new THREE.Color(1.0, 0.7, 0.45) : new THREE.Color(1.0, 0.94, 0.86);
const key = new THREE.DirectionalLight(starCol, 3);
key.position.copy(sunDir).multiplyScalar(1000);
scene.add(key);
const fill = new THREE.DirectionalLight(new THREE.Color(0.35, 0.5, 0.85), 0.12);
fill.position.set(-0.25, -1, 0.2).multiplyScalar(1000);
scene.add(fill);
scene.add(new THREE.AmbientLight(0x0a0c12, 0.3));

// small procedural environment: black sky, the star, dim planet-shine from below, a faint band of stars
{
  const envScene = new THREE.Scene();
  const envMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { uSun: { value: sunDir }, uCol: { value: starCol } },
    vertexShader: 'varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `varying vec3 vD; uniform vec3 uSun; uniform vec3 uCol;
      void main(){ vec3 d = normalize(vD); float s = max(dot(d,uSun),0.0);
        vec3 c = uCol * (pow(s, 700.0) * 700.0 + pow(s, 24.0) * 0.8);
        c += vec3(0.28,0.42,0.7) * 0.11 * smoothstep(0.15, -0.9, d.y);
        c += vec3(0.5,0.52,0.6) * 0.035 * exp(-pow(d.y * 3.0 - d.x * 1.2, 2.0));
        c += vec3(0.014);
        gl_FragColor = vec4(c, 1.0); }`,
  });
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 48, 24), envMat));
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(envScene, 0.01).texture;
  pm.dispose();
  envMat.dispose();
}

// ------------------------------------------------------------------------------------------------ content

const ships: ShipVisual[] = [];
let radius = 10;
const centre = new THREE.Vector3();
const t0 = performance.now();

function addMarkers(parent: THREE.Object3D, L: ShipLayout): void {
  const geo = new THREE.SphereGeometry(1, 10, 8);
  const mk = (p: { x: number; y: number; z: number }, c: number, r: number): void => {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: c }));
    m.position.set(p.x, p.y, p.z);
    m.scale.setScalar(r);
    parent.add(m);
  };
  for (const e of L.engines) mk(e.pos, 0xff8800, 0.18);
  for (const r of L.rcs) mk(r.pos, 0x00ffff, 0.1);
  for (const h of L.hardpoints) mk(h.pos, 0xff00ff, 0.14);
  mk(L.dockingPort.pos, 0xffff00, 0.14);
  mk(L.cockpit, 0xffffff, 0.1);
  for (const l of L.lights) mk(l.pos, 0x8888ff, 0.08);
  const box = new THREE.Box3(new THREE.Vector3(-L.width / 2, -L.height / 2, -L.length / 2), new THREE.Vector3(L.width / 2, L.height / 2, L.length / 2));
  parent.add(new THREE.Box3Helper(box, 0x335577));
}

if (params.get('swatch') === '1') {
  // one bevelled block + sphere per finish
  const b = new MeshBuilder({ seed: 3 });
  const names = Object.keys(LAYER) as (keyof typeof LAYER)[];
  const tint: Record<string, [RGB, number, number, number]> = {
    panel: [[1, 1, 1], 0.1, 0.5, 1],
    armor: [[0.9, 0.9, 0.9], 0.3, 0.6, 2],
    tile: [[0.04, 0.041, 0.046], 0, 0.82, 0],
    metal: [[0.6, 0.58, 0.55], 1, 0.34, 0],
    carbon: [[0.055, 0.058, 0.064], 0.3, 0.4, 0],
    foil: [[0.86, 0.62, 0.22], 1, 0.3, 0],
    radiator: [[0.09, 0.092, 0.1], 0.85, 0.5, 0],
    ribbed: [[1, 1, 1], 0.25, 0.58, 3],
  };
  names.forEach((n, i) => {
    const t = tint[n];
    const st = hullStyle(LAYER[n], t[0], t[1], t[2], { slot: t[3], wear: 0.45, grime: 0.5 });
    const x = ((i % 4) - 1.5) * 3.4;
    const y = i < 4 ? 2.6 : -2.6;
    b.at(x, y, 0, () => b.box(2.6, 2.6, 2.6, st, { bevel: 0.08 }), 0.0, 0.5, 0);
    b.at(x, y + 2.2, 0, () => b.sphere(0.8, st, 24));
  });
  b.bakeAO(0.6);
  const model = b.build();
  const mats = createHullMaterials({ livery: livery ?? { primary: [0.74, 0.73, 0.69], secondary: [0.075, 0.082, 0.095], accent: [0.86, 0.26, 0.03] }, quality });
  for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
    const g = model.geometries[ch];
    if (g) scene.add(new THREE.Mesh(g, mats.byChannel[ch]));
  }
  radius = 9;
} else if (params.get('lineup') === '1') {
  let x = 0;
  const gap = 5;
  const made: { v: ShipVisual; w: number }[] = [];
  for (const id of ALL) {
    if (!(id in SHIP_LIVERIES)) continue;
    const v = createShipVisual(id, { quality, livery, lod: lodMode, seed: num('seed', 0) });
    made.push({ v, w: v.layout.width });
  }
  const total = made.reduce((a, m) => a + m.w + gap, -gap);
  x = -total / 2;
  for (const m of made) {
    m.v.object3d.position.set(x + m.w / 2, 0, 0);
    x += m.w + gap;
    scene.add(m.v.object3d);
    ships.push(m.v);
  }
  radius = total * 0.36;
} else {
  const v = createShipVisual(shipId, { quality, livery, lod: lodMode, seed: num('seed', 0) });
  scene.add(v.object3d);
  ships.push(v);
  radius = v.layout.radius;
  if (params.get('layout') === '1') addMarkers(v.object3d, v.layout);
}
const buildMs = performance.now() - t0;

const fitDist = (radius * 0.66) / Math.sin((camera.fov * DEG) / 2) / Math.min(1, camera.aspect * 1.1);
const dist = num('dist', fitDist);
centre.set(num('tx', 0), num('ty', 0), num('tz', 0));
camera.position.copy(camDir).multiplyScalar(dist).add(centre);
camera.up.set(0, 1, 0);
if (Math.abs(pitch) > 88 * DEG) camera.up.set(0, 0, -1);
camera.lookAt(centre);

const ctx = { dt: 0, time: num('time', 0.05), throttle: num('throttle', 1), lightsOn: params.get('lights') !== '0', heat: num('heat', 0), damage: num('damage', 0) };
for (const s of ships) s.update(ctx);

// ------------------------------------------------------------------------------------------------ post

const target = new THREE.WebGLRenderTarget(window.innerWidth * pr, window.innerHeight * pr, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, target);
composer.setPixelRatio(pr);
composer.setSize(window.innerWidth, window.innerHeight);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), num('bloom', 0.24), 0.55, 1.2);
composer.addPass(bloom);
composer.addPass(new OutputPass());

let frames = 0;
const live = params.get('live') === '1';
function frame(): void {
  if (live) {
    ctx.dt = 1 / 60;
    ctx.time += ctx.dt;
    for (const s of ships) s.update(ctx);
  }
  composer.render();
  frames++;
  if (frames === 2) {
    if (params.get('info') === '1') {
      const info = renderer.info;
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:8px;top:8px;font:11px/1.35 monospace;color:#9fc;white-space:pre;background:rgba(0,0,0,.5);padding:4px';
      const lines = [`build ${buildMs.toFixed(0)} ms  programs ${info.programs?.length ?? 0}  geometries ${info.memory.geometries} textures ${info.memory.textures}`];
      for (const s of ships) for (const st of s.stats) lines.push(`${s.layout.id} lod${st.lod}: ${st.triangles} tris, ${st.drawCalls} calls, ${st.buildMs.toFixed(0)} ms`);
      el.textContent = lines.join('\n');
      document.body.appendChild(el);
    }
    (window as unknown as { __ready: boolean }).__ready = true;
  }
  if (live || frames < 3) requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
