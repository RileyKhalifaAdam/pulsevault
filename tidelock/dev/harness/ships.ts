// Visual harness for src/render/space/ships.ts (+ hullMaterials.ts, geo.ts).
//
//   dev/ships.html?ship=wren&yaw=35&pitch=20&dist=30&throttle=1&livery=default&lod=0
//
//   ship      wren | drover | magpie | shrike | albatross | caravel | halberd
//   yaw       camera azimuth, deg: 0 = behind the ship (chase), 90 = starboard side, 180 = head-on
//   pitch     camera elevation, deg (90 = top view, nose to the right)
//   dist      camera distance, m (default: fits the hull in the frame)        zoom  scale the fitted distance
//   throttle  0..1 engine-bell glow                                            heat / damage  0..1
//   livery    default | assembly | hegemony | league | scorch | plain
//   lod       0 = hero (default), 1 = reduced, auto = distance switch
//   lineup=1  all seven hulls side by side, to scale                           swatch=1  material swatches
//   sheet=1   contact sheet of one hull: front-3/4, rear-3/4, side and top in one image
//   sun=az,el absolute key-light direction, deg (default: 55 deg to the right of the camera, 40 deg up)
//   star      white (default) | ember (red-dwarf light)
//   layout=1  markers at the shipLayouts positions            info=1  triangles / draw calls / build time
//   q         low | medium | high (default) | ultra           time  seconds (blink phase)   lights=0  nav lights off
//   live=1    keep animating (blinkers, flicker)
//   eye=x,y,z first-person camera at a ship-local point (or eye=pilot | eye=lounge), look=yaw,pitch deg
//             (yaw 0 = forward, positive = left); room=<interior room id> draws that room's walls with its
//             window openings cut out (default: the room the eye preset sits in)
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { RGB, ShipLayout, ShipVisualId } from '../../src/core/types';
import { LAYER, MeshBuilder, CHANNEL_COUNT, hullStyle } from '../../src/render/space/geo';
import { createHullMaterials, type HullMaterials, type HullQuality, type Livery } from '../../src/render/space/hullMaterials';
import { createShipVisual, type ShipVisual } from '../../src/render/space/ships';
import { acquirePhotoDetail } from '../../src/render/space/photo/detail';
import { INTERIORS } from '../../src/data/interiors';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number): number => (params.has(k) ? Number(params.get(k)) : d);
const str = (k: string, d: string): string => params.get(k) ?? d;
const DEG = Math.PI / 180;

const ALL: ShipVisualId[] = ['shrike', 'wren', 'magpie', 'albatross', 'drover', 'halberd', 'caravel'];
const shipId = (ALL as string[]).includes(str('ship', 'wren')) ? (str('ship', 'wren') as ShipVisualId) : 'wren';
const quality = str('q', 'high') as HullQuality;
// the hero hull's photo detail decodes asynchronously: render until it is in (photo=0 skips the wait,
// photo=off waits and then switches the detail off)
let photoDone = params.get('photo') === '0';
let photoFrame = -1;
const photoDetail = acquirePhotoDetail(quality);
void photoDetail.ready.then(() => {
  // photo=off: loaded but switched off, for a before/after
  if (params.get('photo') === 'off') photoDetail.uniforms.uPhOn.value = 0;
  photoDone = true;
});
const lodParam = str('lod', '0');
const lodMode = lodParam === 'auto' ? 'auto' : lodParam === '1' ? 'low' : 'hero';
const sheet = params.get('sheet') === '1';

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

const W = window.innerWidth;
const H = window.innerHeight;
const pr = Math.min(window.devicePixelRatio, 2);
// a contact sheet renders four half-size views and tiles them on a 2D canvas
const vw = sheet ? Math.floor(W / 2) : W;
const vh = sheet ? Math.floor(H / 2) : H;

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: sheet });
renderer.setPixelRatio(pr);
renderer.setSize(vw, vh);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
let sheetCtx: CanvasRenderingContext2D | null = null;
if (sheet) {
  const cv = document.createElement('canvas');
  cv.width = W * pr;
  cv.height = H * pr;
  cv.style.cssText = `width:${W}px;height:${H}px;display:block`;
  document.body.appendChild(cv);
  sheetCtx = cv.getContext('2d');
} else document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const EYES: Record<string, { eye: [number, number, number]; look: [number, number]; room: string }> = {
  pilot: { eye: [-0.55, 0.25, -13.45], look: [8, -12], room: 'cockpit' },
  lounge: { eye: [1.6, 0.2, -7.5], look: [-75, -6], room: 'lounge' },
};
const eyeArg = params.get('eye');
const eyePreset = eyeArg ? EYES[eyeArg] : undefined;
const eyePos = eyePreset ? eyePreset.eye : eyeArg ? (eyeArg.split(',').map(Number) as [number, number, number]) : null;
const camera = new THREE.PerspectiveCamera(num('fov', eyePos ? 72 : 32), vw / vh, eyePos ? 0.05 : 0.3, 80000);

// Lighting like the game: one strong warm key (the star), near-black ambient, dim cool planet-shine from
// below, and a small procedural environment for reflections.
const starCol = str('star', 'white') === 'ember' ? new THREE.Color(1.0, 0.66, 0.42) : new THREE.Color(1.0, 0.94, 0.86);
const sunDir = new THREE.Vector3(0, 1, 0);
const key = new THREE.DirectionalLight(starCol, 3);
scene.add(key);
const fill = new THREE.DirectionalLight(new THREE.Color(0.35, 0.5, 0.85), 0.12);
fill.position.set(-0.25, -1, 0.2).multiplyScalar(1000);
scene.add(fill);
scene.add(new THREE.AmbientLight(0x0a0c12, 0.3));

const envScene = new THREE.Scene();
const envMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  uniforms: { uSun: { value: sunDir }, uCol: { value: starCol } },
  vertexShader: 'varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `varying vec3 vD; uniform vec3 uSun; uniform vec3 uCol;
    void main(){ vec3 d = normalize(vD); float s = max(dot(d,uSun),0.0);
      vec3 c = uCol * (pow(s, 700.0) * 700.0 + pow(s, 90.0) * 0.35);
      c += vec3(0.28,0.42,0.7) * 0.11 * smoothstep(0.15, -0.9, d.y);
      c += vec3(0.5,0.52,0.6) * 0.035 * exp(-pow(d.y * 3.0 - d.x * 1.2, 2.0));
      c += vec3(0.014);
      gl_FragColor = vec4(c, 1.0); }`,
});
envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 48, 24), envMat));
const pmrem = new THREE.PMREMGenerator(renderer);
let envRT: THREE.WebGLRenderTarget | null = null;

function setSun(az: number, el: number): void {
  sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  key.position.copy(sunDir).multiplyScalar(1000);
  envRT?.dispose();
  envRT = pmrem.fromScene(envScene, 0.01);
  scene.environment = envRT.texture;
}

// ------------------------------------------------------------------------------------------------ content

const ships: ShipVisual[] = [];
let swatchMats: HullMaterials | null = null;
/** half extents of what has to fit in the frame, and its centre */
const ext = new THREE.Vector3(10, 3, 10);
const centre = new THREE.Vector3();
const t0 = performance.now();

function addMarkers(parent: THREE.Object3D, L: ShipLayout): void {
  const geo = new THREE.SphereGeometry(1, 10, 8);
  const s = Math.max(1, L.radius / 10);
  const mk = (p: { x: number; y: number; z: number }, c: number, r: number): void => {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: c }));
    m.position.set(p.x, p.y, p.z);
    m.scale.setScalar(r * s);
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
  swatchMats = createHullMaterials({ livery: livery ?? { primary: [0.74, 0.73, 0.69], secondary: [0.075, 0.082, 0.095], accent: [0.86, 0.26, 0.03] }, quality });
  for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
    const g = model.geometries[ch];
    if (g) scene.add(new THREE.Mesh(g, swatchMats.byChannel[ch]));
  }
  ext.set(7.5, 5.5, 2);
} else if (params.get('lineup') === '1') {
  // all seven to scale, noses level, smallest first
  const gap = 4;
  const made = ALL.map((id) => createShipVisual(id, { quality, livery, lod: lodMode, seed: num('seed', 0) }));
  const total = made.reduce((a, m) => a + m.layout.width + gap, -gap);
  let x = -total / 2;
  let maxL = 0;
  let maxH = 0;
  for (const m of made) {
    m.object3d.position.set(x + m.layout.width / 2, 0, 0);
    x += m.layout.width + gap;
    maxL = Math.max(maxL, m.layout.length);
    maxH = Math.max(maxH, m.layout.height);
    scene.add(m.object3d);
    ships.push(m);
  }
  ext.set(total / 2, maxH / 2, maxL / 2);
} else {
  const v = createShipVisual(shipId, { quality, livery, lod: lodMode, seed: num('seed', 0) });
  scene.add(v.object3d);
  ships.push(v);
  ext.set(v.layout.width / 2, v.layout.height / 2, v.layout.length / 2);
  if (params.get('layout') === '1') addMarkers(v.object3d, v.layout);
}
const buildMs = performance.now() - t0;

/** The walls of one interior room with its window openings cut out (a stand-in for the interior pass). */
function addRoomShell(roomId: string): void {
  const lay = INTERIORS.wren;
  const room = lay?.rooms.find((r) => r.id === roomId);
  if (!lay || !room) return;
  const b = room.box;
  const mat = new THREE.MeshStandardMaterial({ color: 0x6d7076, roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
  // wall: [name, fixed axis, value, horizontal axis, vertical axis]
  const walls: [string, number, number, number, number][] = [
    ['+x', 0, b.max.x, 2, 1], ['-x', 0, b.min.x, 2, 1], ['+y', 1, b.max.y, 0, 2], ['-y', 1, b.min.y, 0, 2], ['+z', 2, b.max.z, 0, 1], ['-z', 2, b.min.z, 0, 1],
  ];
  const lo = [b.min.x, b.min.y, b.min.z];
  const hi = [b.max.x, b.max.y, b.max.z];
  for (const [name, ax, val, ha, va] of walls) {
    const sh = new THREE.Shape([new THREE.Vector2(lo[ha], lo[va]), new THREE.Vector2(hi[ha], lo[va]), new THREE.Vector2(hi[ha], hi[va]), new THREE.Vector2(lo[ha], hi[va])]);
    for (const w of lay.windows) {
      if (w.room !== roomId || w.wall !== name) continue;
      const c = [w.center.x, w.center.y, w.center.z];
      const x0 = c[ha] - w.width / 2, x1 = c[ha] + w.width / 2, y0 = c[va] - w.height / 2, y1 = c[va] + w.height / 2;
      sh.holes.push(new THREE.Path([new THREE.Vector2(x0, y0), new THREE.Vector2(x0, y1), new THREE.Vector2(x1, y1), new THREE.Vector2(x1, y0)]));
    }
    for (const d of lay.doors) {
      if (d.a !== roomId && d.b !== roomId) continue;
      const dl = [d.box.min.x, d.box.min.y, d.box.min.z];
      const dh = [d.box.max.x, d.box.max.y, d.box.max.z];
      if (val < dl[ax] - 1e-3 || val > dh[ax] + 1e-3) continue;
      sh.holes.push(new THREE.Path([new THREE.Vector2(dl[ha], dl[va] + 1e-3), new THREE.Vector2(dl[ha], dh[va]), new THREE.Vector2(dh[ha], dh[va]), new THREE.Vector2(dh[ha], dl[va] + 1e-3)]));
    }
    const g = new THREE.ShapeGeometry(sh);
    const pa = g.attributes.position;
    for (let i = 0; i < pa.count; i++) {
      const v3 = [0, 0, 0];
      v3[ax] = val;
      v3[ha] = pa.getX(i);
      v3[va] = pa.getY(i);
      pa.setXYZ(i, v3[0], v3[1], v3[2]);
    }
    g.computeVertexNormals();
    scene.add(new THREE.Mesh(g, mat));
  }
  const lamp = new THREE.PointLight(0xffe2c0, 2.5, 8, 2);
  lamp.position.set((b.min.x + b.max.x) / 2, b.max.y - 0.3, (b.min.z + b.max.z) / 2);
  scene.add(lamp);
}
if (eyePos) addRoomShell(params.get('room') ?? eyePreset?.room ?? 'cockpit');
centre.set(num('tx', 0), num('ty', 0), num('tz', 0));

const camDir = new THREE.Vector3();
const camRight = new THREE.Vector3();
const camUp = new THREE.Vector3();

/** Aim the camera from (yaw, pitch) at the centre, at the distance that just fits the content (or `dist`). */
function aim(yaw: number, pitch: number, dist: number, zoom: number): void {
  camDir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  const top = Math.abs(pitch) > 88 * DEG;
  camera.up.set(top ? -1 : 0, top ? 0 : 1, 0);
  camera.position.copy(camDir).add(centre);
  camera.lookAt(centre);
  camera.updateMatrixWorld();
  camRight.setFromMatrixColumn(camera.matrixWorld, 0);
  camUp.setFromMatrixColumn(camera.matrixWorld, 1);
  // projected half extents of the bounding box
  const ex = Math.abs(camRight.x) * ext.x + Math.abs(camRight.y) * ext.y + Math.abs(camRight.z) * ext.z;
  const ey = Math.abs(camUp.x) * ext.x + Math.abs(camUp.y) * ext.y + Math.abs(camUp.z) * ext.z;
  const ez = Math.abs(camDir.x) * ext.x + Math.abs(camDir.y) * ext.y + Math.abs(camDir.z) * ext.z;
  const t = Math.tan((camera.fov * DEG) / 2);
  const fit = Math.max(ex / (t * camera.aspect), ey / t) * 1.12 + ez * 0.6;
  const d = dist > 0 ? dist : fit * zoom;
  camera.position.copy(camDir).multiplyScalar(d).add(centre);
  camera.lookAt(centre);
  if (params.has('sun')) {
    const [a, e] = str('sun', '0,40').split(',').map(Number);
    setSun(a * DEG, e * DEG);
  } else setSun(yaw + 55 * DEG, (top ? 55 : 40) * DEG);
}

const ctx = { dt: 0, time: num('time', 0.05), throttle: num('throttle', 1), lightsOn: params.get('lights') !== '0', heat: num('heat', 0), damage: num('damage', 0) };
const updateAll = (): void => {
  for (const s of ships) s.update(ctx);
  swatchMats?.update(ctx);
};
updateAll();

// ------------------------------------------------------------------------------------------------ post

const target = new THREE.WebGLRenderTarget(vw * pr, vh * pr, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, target);
composer.setPixelRatio(pr);
composer.setSize(vw, vh);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(vw, vh), num('bloom', 0.24), 0.55, 1.2));
composer.addPass(new OutputPass());

const VIEWS: [string, number, number, number][] = [
  ['front 3/4', 142, 20, 0.78],
  ['rear 3/4', 30, 20, 0.78],
  ['side', 90, 3, 0.94],
  ['top', 0, 90, 0.94],
];

function info(): string[] {
  const lines = [`build ${buildMs.toFixed(0)} ms  programs ${renderer.info.programs?.length ?? 0}  geometries ${renderer.info.memory.geometries} textures ${renderer.info.memory.textures}`];
  for (const s of ships) for (const st of s.stats) lines.push(`${s.layout.id} lod${st.lod}: ${st.triangles} tris, ${st.drawCalls} calls, ${st.buildMs.toFixed(0)} ms`);
  return lines;
}

// leak check for scripted runs: dispose everything and report what the renderer still holds
(window as unknown as { __disposeTest: () => unknown }).__disposeTest = () => {
  const before = { ...renderer.info.memory };
  const stats = ships.flatMap((s) => s.stats.map((st) => ({ id: s.layout.id, ...st })));
  for (const s of ships) s.dispose();
  swatchMats?.dispose();
  ships.length = 0;
  composer.render();
  return { before, after: { ...renderer.info.memory }, children: scene.children.filter((c) => (c as THREE.Mesh).isMesh || c.type === 'Group' || c.type === 'LOD').length, stats, buildMs };
};

let frames = 0;
const live = params.get('live') === '1';
function frame(): void {
  if (live) {
    ctx.dt = 1 / 60;
    ctx.time += ctx.dt;
    updateAll();
  }
  if (sheetCtx) {
    VIEWS.forEach(([label, yaw, pitch, zoom], i) => {
      aim(yaw * DEG, pitch * DEG, 0, num('zoom', 1) * zoom);
      composer.render();
      const x = (i % 2) * vw * pr;
      const y = Math.floor(i / 2) * vh * pr;
      sheetCtx.drawImage(renderer.domElement, x, y, vw * pr, vh * pr);
      sheetCtx.fillStyle = '#7fa';
      sheetCtx.font = `${11 * pr}px monospace`;
      sheetCtx.fillText(`${shipId} · ${label}`, x + 8 * pr, y + 16 * pr);
    });
    if (params.get('info') === '1') info().forEach((l, i) => sheetCtx.fillText(l, 8 * pr, (H - 30 + i * 13) * pr));
  } else {
    if (frames === 0 && eyePos) {
      const [ly, lp] = (params.get('look') ?? (eyePreset ? eyePreset.look.join(',') : '0,0')).split(',').map(Number);
      camera.position.set(eyePos[0], eyePos[1], eyePos[2]);
      camera.lookAt(eyePos[0] - Math.sin(ly * DEG) * Math.cos(lp * DEG), eyePos[1] + Math.sin(lp * DEG), eyePos[2] - Math.cos(ly * DEG) * Math.cos(lp * DEG));
      const [a, e] = str('sun', '150,35').split(',').map(Number);
      setSun(a * DEG, e * DEG);
    } else if (frames === 0) aim(num('yaw', 35) * DEG, num('pitch', 20) * DEG, num('dist', 0), num('zoom', 1));
    composer.render();
  }
  frames++;
  if (photoDone && photoFrame < 0) photoFrame = frames;
  if (photoFrame >= 0 && frames === photoFrame + 3) {
    if (params.get('info') === '1' && !sheetCtx) {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:8px;top:8px;font:11px/1.35 monospace;color:#9fc;white-space:pre;background:rgba(0,0,0,.5);padding:4px';
      el.textContent = info().join('\n');
      document.body.appendChild(el);
    }
    (window as unknown as { __ready: boolean }).__ready = true;
  }
  if (live || photoFrame < 0 || frames < photoFrame + 4) requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
