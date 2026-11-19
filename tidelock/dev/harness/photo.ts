// Visual harness for the photo-scanned PBR detail pack (src/render/space/photo).
//
//   dev/photo.html?q=high&sun=-35,40&env=0.35&only=leather
//
//   q       low | medium | high (default) | ultra — decode size of the pack and the pipeline tier
//   sun     az,el in degrees (az 0 = from the camera, positive = from the right)     default -40,35
//   env     environment (room PMREM) intensity, default 0.35                         exposure  EV, default 0
//   only    material ids, comma separated (default: all)                             cols  grid columns override
//   live=1  keep rendering every frame (default: stop once settled)
//   zoom    camera distance divisor (zoom=2.5 with one id: arm's-length close-up, ~0.6 m)
//
// Each material on a sphere (r 0.2 m) and a flat panel (0.42 m, tilted 30 deg back) with PHYSICAL UVs
// (uv = metres / tileMetres), under the game's HDR pipeline with a sun-strength key light (white diffuse
// = 1.0 at EV 0). Labels give the id, the metres per repeat and the source.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createPipeline, type Quality } from '../../src/render/pipeline';
import {
  loadPhotoMaterials,
  photoGpuBytes,
  PHOTO_MATERIAL_IDS,
  PHOTO_PAGE_BYTES,
  type PhotoMaterialId,
  type PhotoMaterials,
} from '../../src/render/space/photo';
import { PHOTO_PACK } from '../../src/render/space/photo/pack.generated';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number): number => (params.has(k) && params.get(k) !== '' ? Number(params.get(k)) : d);
const DEG = Math.PI / 180;
const quality = (params.get('q') ?? 'high') as Quality;
const only = (params.get('only') ?? '').split(',').filter((x) => (PHOTO_MATERIAL_IDS as readonly string[]).includes(x)) as PhotoMaterialId[];
const [sunAz, sunEl] = (params.get('sun') ?? '-40,35').split(',').map(Number) as [number, number];

document.body.style.cssText = 'margin:0;background:#000;overflow:hidden;height:100%';
const canvas = document.createElement('canvas');
canvas.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;display:block';
document.body.appendChild(canvas);
const labels = document.createElement('div');
labels.style.cssText = 'position:fixed;inset:0;pointer-events:none;font:600 9px/1.2 -apple-system,system-ui,sans-serif;color:#dfe8f0';
document.body.appendChild(labels);
const info = document.createElement('pre');
info.style.cssText = 'position:fixed;left:6px;bottom:4px;margin:0;font:9px/1.25 monospace;color:#9fd;opacity:0.9;white-space:pre-wrap;pointer-events:none';
document.body.appendChild(info);
const ready = (): void => {
  (window as unknown as { __ready: boolean }).__ready = true;
};
const showError = (e: unknown): void => {
  info.style.color = '#f88';
  info.textContent = `ERROR ${e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)}`;
  ready();
};
window.addEventListener('error', (e) => showError(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => showError(e.reason));

const pipeline = createPipeline(canvas, { quality, dynamicResolution: false });
const renderer = pipeline.renderer;
pipeline.setAutoExposure(false);
pipeline.setExposure(num('exposure', 0));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0.012, 0.014, 0.02);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = num('env', 0.35);
const sun = new THREE.DirectionalLight(0xfff4e6, Math.PI);
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0x9fb4d0, 0x1a1612, 0.15));
const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);

const ids: readonly PhotoMaterialId[] = only.length ? only : PHOTO_MATERIAL_IDS;
const CELL_W = 1.0;
const CELL_H = 0.62;
const SPHERE_R = 0.2;
const PANEL = 0.42;

/** Geometry with uv scaled from 0..1 to metres / tileMetres. */
function physical(g: THREE.BufferGeometry, uMetres: number, vMetres: number, tile: readonly [number, number]): THREE.BufferGeometry {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * uMetres) / tile[0], (uv.getY(i) * vMetres) / tile[1]);
  uv.needsUpdate = true;
  return g;
}

const anchors: { id: PhotoMaterialId; pos: THREE.Vector3; el: HTMLDivElement }[] = [];
let grid = { cols: 2, rows: 6 };

function layout(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  pipeline.resize(w, h, Math.min(window.devicePixelRatio || 1, 2));
  const aspect = w / h;
  const cols = num('cols', ids.length === 1 ? 1 : aspect < 0.8 ? 2 : 4);
  const rows = Math.ceil(ids.length / cols);
  grid = { cols, rows };
  camera.aspect = aspect;
  const gw = cols * CELL_W + 0.1;
  const gh = rows * CELL_H + 0.1;
  const vfov = camera.fov * DEG;
  const dist = (Math.max(gh / 2 / Math.tan(vfov / 2), gw / 2 / (Math.tan(vfov / 2) * aspect)) * 1.02) / num('zoom', 1);
  camera.position.set(0, 0, dist);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  // sun relative to the camera view
  const az = sunAz * DEG;
  const el = sunEl * DEG;
  sun.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(10);
}

function build(photo: PhotoMaterials): void {
  layout();
  const { cols, rows } = grid;
  ids.forEach((id, i) => {
    const p = photo[id];
    const tile = p.tileMetres;
    const cx = ((i % cols) - (cols - 1) / 2) * CELL_W;
    const cy = ((rows - 1) / 2 - Math.floor(i / cols)) * CELL_H + 0.03;
    const cut = p.alphaMap !== null;
    const mat = new THREE.MeshStandardMaterial({
      map: p.map,
      normalMap: p.normalMap,
      roughnessMap: p.ormMap,
      metalnessMap: p.ormMap,
      aoMap: p.ormMap,
      roughness: 1,
      metalness: 1,
      alphaMap: p.alphaMap,
      alphaTest: cut ? 0.5 : 0,
      side: cut ? THREE.DoubleSide : THREE.FrontSide,
    });
    const sphere = new THREE.Mesh(physical(new THREE.SphereGeometry(SPHERE_R, 64, 32), 2 * Math.PI * SPHERE_R, Math.PI * SPHERE_R, tile), mat);
    sphere.position.set(cx - 0.24, cy, 0);
    sphere.rotation.y = -0.4;
    const panel = new THREE.Mesh(physical(new THREE.PlaneGeometry(PANEL, PANEL), PANEL, PANEL, tile), mat);
    panel.position.set(cx + 0.23, cy, 0);
    panel.rotation.x = -30 * DEG;
    scene.add(sphere, panel);
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;transform:translate(-50%,0);white-space:nowrap;text-align:center;text-shadow:0 1px 2px #000';
    el.textContent = `${id} · ${tile[0]} m · ${PHOTO_PACK[id].source.split(':')[1] ?? ''}`;
    labels.appendChild(el);
    anchors.push({ id, pos: new THREE.Vector3(cx, cy - 0.26, 0), el });
  });
}

const v = new THREE.Vector3();
function placeLabels(): void {
  for (const a of anchors) {
    v.copy(a.pos).project(camera);
    a.el.style.left = `${((v.x + 1) / 2) * window.innerWidth}px`;
    a.el.style.top = `${((1 - v.y) / 2) * window.innerHeight}px`;
  }
}

const t0 = performance.now();
loadPhotoMaterials(renderer, quality === 'ultra' ? 'ultra' : quality)
  .then((photo) => {
    const decodeMs = performance.now() - t0;
    build(photo);
    placeLabels();
    let frames = 0;
    let last = performance.now();
    const frame = (): void => {
      const now = performance.now();
      pipeline.render([{ scene, camera }], Math.min(0.1, (now - last) / 1000));
      last = now;
      if (++frames === 6) {
        const s = pipeline.stats();
        info.textContent =
          `photo pack q=${quality}: ${ids.length} sets, decode ${decodeMs.toFixed(0)} ms, GPU ${(photo.gpuBytes / 1048576).toFixed(1)} MB ` +
          `(high ${(photoGpuBytes('high') / 1048576).toFixed(1)} / med ${(photoGpuBytes('medium') / 1048576).toFixed(1)} / low ${(photoGpuBytes('low') / 1048576).toFixed(1)}), ` +
          `page ${(PHOTO_PAGE_BYTES / 1048576).toFixed(2)} MB, aniso ${photo.leather.map.anisotropy}\n` +
          `failed: ${photo.failed.length ? photo.failed.join(', ') : 'none'}   ${s.gpuName}`;
        ready();
      }
      // static scene: stop after the frames that settle the pipeline (keeps headless screenshots fast)
      if (frames < 8 || params.get('live') === '1') requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  })
  .catch(showError);

window.addEventListener('resize', () => {
  layout();
  placeLabels();
});
