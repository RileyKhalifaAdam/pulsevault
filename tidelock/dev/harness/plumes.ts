// Visual harness for the honest exhaust (src/render/space/plumeCore.ts + plumes.ts), W1-E items 1–2.
//
//   dev/plumes.html?scene=turn|burn&t=<s>&shadow=1&level=<0..1>&az=<deg>&el=<deg>&dist=<m>&v=<m/s>
//
//   turn    a yaw turn: the nose jet on one side and the tail jet on the other pulse (8 ticks on, 22 off) plus a
//           0.3-duty pulse train on a pitch pair; the ship yaws at 0.05 rad/s and flies at `v` (default 7800 m/s,
//           the puffs keep their own inertial motion: the camera follows the ship). shadow=1: the planet's shadow
//           (sun visibility 0) — nothing may show.
//   burn    both engines held at `level` (engineLevel, F_s/F_max): no spool, no kick, no flicker.
//   t       sim seconds stepped at the 120 Hz tick before the still (default 2.31 for turn: 50 ms after an edge)
//   info=1  prints the live parcel count and the draw calls
import * as THREE from 'three';
import { SHIP_LAYOUTS } from '../../src/data/shipLayouts';
import { jetsFromLayout } from '../../src/world/jets';
import { PuffPool, TICK, WREN_OCCLUDERS, packOccluders, MAX_OCCLUDERS } from '../../src/render/space/plumeCore';
import { PuffRenderer, createPhysicalPlumes } from '../../src/render/space/plumes';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number): number => (params.has(k) ? Number(params.get(k)) : d);
const scene = params.get('scene') ?? 'turn';
const shadow = params.get('shadow') === '1';

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
const world = new THREE.Scene();
world.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(num('fov', 55), window.innerWidth / window.innerHeight, 0.3, 20000);

// the star: direction (inertial), colour × intensity; the planet's shadow multiplies it to 0
const sunDir = new THREE.Vector3(num('sx', -0.25), num('sy', 0.55), num('sz', -0.8)).normalize();
const sunVis = shadow ? 0 : 1;
const keyCol = new THREE.Color(1.0, 0.86, 0.72);
const keyI = 3;
const key = new THREE.DirectionalLight(keyCol, keyI * sunVis);
world.add(key, key.target);

// a Wren stand-in: fuselage, wing / pod span, nozzles (the real hull lives in ships.ts; this keeps the page small)
const ship = new THREE.Group();
const hullMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d4, roughness: 0.55, metalness: 0.05 });
const fus = new THREE.Mesh(new THREE.CapsuleGeometry(2.6, 24, 6, 16), hullMat);
fus.rotation.x = Math.PI / 2;
const wing = new THREE.Mesh(new THREE.BoxGeometry(19, 1.2, 7), hullMat);
wing.position.set(0, -0.3, 7.5);
ship.add(fus, wing);
for (const e of SHIP_LAYOUTS.wren.engines) {
  const bell = new THREE.Mesh(new THREE.CylinderGeometry(e.radius, e.radius * 0.6, 2.2, 20, 1, true), new THREE.MeshStandardMaterial({ color: 0x555555, side: THREE.DoubleSide }));
  bell.rotation.x = Math.PI / 2;
  bell.position.set(e.pos.x, e.pos.y, e.pos.z - 1.1);
  ship.add(bell);
}
world.add(ship);

const layout = SHIP_LAYOUTS.wren;
const jets = jetsFromLayout(layout.rcs);
const pool = new PuffPool(2048);
const puffs = new PuffRenderer(pool);
world.add(puffs.mesh);
const plume = createPhysicalPlumes(layout.engines, { quality: 'high' });
ship.add(plume.object3d);

// ship state: absolute (doubles), yawing
const v = num('v', 7800);
const r0 = { x: 1.0e11, y: 2.0e6, z: -3.0e6 };
const shipR = { x: r0.x, y: r0.y, z: r0.z };
const shipV = { x: 0, y: 0, z: -v };
const w = { x: 0, y: scene === 'turn' ? 0.05 : 0, z: 0 };
const q = { x: 0, y: 0, z: 0, w: 1 };
const grav = { x: 0, y: -8.2, z: 0 };
const duty = new Float64Array(jets.length);
const levels = [0, 0];
const T = num('t', scene === 'turn' ? 2.31 : 1);
const nTicks = Math.round(T / TICK);
const ang0 = num('yaw0', 0.4);

function dutyAt(k: number): void {
  duty.fill(0);
  if (scene !== 'turn') return;
  const ph = k % 30;
  if (ph < 8) { duty[0] = 1; duty[5] = 1; } // nose +X exhaust, tail −X exhaust: a yaw couple
  if (k % 4 === 0) { duty[2] = 0.3; duty[9] = 0.3; } // a short pitch pulse train
}

function stateAt(t: number): void {
  // the ship in free fall: r = r0 + v t + ½ g t² (exact), yaw = ang0 + ω t
  shipR.x = r0.x + shipV.x * t;
  shipR.y = r0.y + shipV.y * t + 0.5 * grav.y * t * t;
  shipR.z = r0.z + shipV.z * t;
  const a = (ang0 + w.y * t) / 2;
  q.x = 0; q.y = Math.sin(a); q.z = 0; q.w = Math.cos(a);
}

const vNow = { x: 0, y: 0, z: 0 };
for (let k = 1; k <= nTicks; k++) {
  const t = k * TICK;
  stateAt(t);
  vNow.x = shipV.x; vNow.y = shipV.y + grav.y * t; vNow.z = shipV.z;
  pool.frame(t, shipR, vNow, grav);
  dutyAt(k);
  pool.emit(0, { r: shipR, v: vNow, q, w }, jets, duty, k);
}
const t = nTicks * TICK;
if (scene === 'burn') { levels[0] = levels[1] = num('level', 1); plume.setLevels(levels); }

// camera relative to the ship (floating origin at the ship: the ship is drawn at 0)
const az = (num('az', scene === 'turn' ? 35 : 120) * Math.PI) / 180;
const el = (num('el', scene === 'turn' ? 22 : 12) * Math.PI) / 180;
const dist = num('dist', scene === 'turn' ? 62 : 95);
const tgt = new THREE.Vector3(0, 0, scene === 'burn' ? 40 : 0);
camera.position.set(Math.sin(az) * Math.cos(el) * dist, Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist).add(tgt);
camera.lookAt(tgt);
ship.quaternion.set(q.x, q.y, q.z, q.w);
key.position.copy(sunDir).multiplyScalar(100);

// anchor − ship (the near scene's origin is the ship here)
const A = pool.anchorPos(t, { x: 0, y: 0, z: 0 });
const ax = A.x - shipR.x, ay = A.y - shipR.y, az2 = A.z - shipR.z;
const occ = new Float32Array(MAX_OCCLUDERS * 8);
const nOcc = packOccluders(WREN_OCCLUDERS, q, shipR.x - A.x, shipR.y - A.y, shipR.z - A.z, occ);
const sunRGB = new THREE.Vector3(keyCol.r, keyCol.g, keyCol.b).multiplyScalar(keyI * sunVis);
// puffs.update wants anchor − camera; the camera sits at camera.position relative to the ship origin
puffs.update(ax - camera.position.x, ay - camera.position.y, az2 - camera.position.z, sunDir, sunRGB, occ, nOcc, 1 / 60);
puffs.mesh.position.set(ax, ay, az2); // this page draws in ship-origin coordinates, not camera-origin
puffs.mesh.visible = pool.alive && sunVis > 0;
(puffs.mesh.material as THREE.ShaderMaterial).uniforms.uCam.value.set(camera.position.x - ax, camera.position.y - ay, camera.position.z - az2);

renderer.render(world, camera);
const info = document.createElement('div');
info.style.cssText = 'position:fixed;left:8px;top:8px;font:11px monospace;color:#9ab;white-space:pre';
info.textContent = `${scene}${shadow ? ' (planet shadow)' : ''} t=${t.toFixed(3)} s  live=${pool.liveCount()}  calls=${renderer.info.render.calls}` + (scene === 'burn' ? `  engineLevel=${levels[0]}` : '');
document.body.appendChild(info);
(window as unknown as { __ready: boolean }).__ready = true;
