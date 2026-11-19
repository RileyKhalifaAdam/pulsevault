// Visual harness for the honest exhaust (src/render/space/plumeCore.ts + plumes.ts, world/dutyTape.ts), W1-E 1–2.
//
// WIRING: none (a dev page). It drives the core exactly as scene.ts will: the world records every 120 Hz tick on the
// duty tape, the renderer runs pool.frame + pool.consume once per frame (every `tpf` ticks) with the tick state.
//
//   dev/plumes.html?scene=turn|hull|hold|burn&t=<s>&shadow=1&level=<0..1>&tpf=<1..4>&az=<deg>&el=<deg>&dist=<m>
//
//   turn    a yaw couple: the nose jet (exhaust +X) and the tail jet (−X) pulse 8 ticks on, 22 off; the ship yaws
//           at 0.05 rad/s and flies at `v` (7800 m/s; the puffs keep their own inertial motion, the camera follows
//           the ship). shadow=1: the planet's shadow (sun visibility 0) — nothing may show.
//   hull    the port nose jet (exhaust −X) pulses with the sun on the starboard side: the puffs that leave inside
//           the fuselage's shadow are dark (capsule occluders), the rest lit. The info line gives the shader twin's
//           covered pixels with and without the occluders.
//   hold    duty 0.3 held on the yaw pair from t = 0.2 s: one opening, then almost nothing (no fog).
//   burn    both engines held at `level` (engineLevel, F_s/F_max): no spool, no kick, no flicker.
//   tpf     ticks per rendered frame (the same tick history gives the same puffs at any value)
import * as THREE from 'three';
import { SHIP_LAYOUTS } from '../../src/data/shipLayouts';
import { jetsFromLayout, engineDef } from '../../src/world/jets';
import { createDutyTape, tapeRecord, tapeReset } from '../../src/world/dutyTape';
import { PuffPool, TICK, WREN_OCCLUDERS, packOccluders, MAX_OCCLUDERS, PUFF_FILL_SCREENS, solvePuffFloor, type PuffCam } from '../../src/render/space/plumeCore';
import { PuffRenderer, createPhysicalPlumes } from '../../src/render/space/plumes';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number): number => (params.has(k) ? Number(params.get(k)) : d);
const scene = params.get('scene') ?? 'turn';
const shadow = params.get('shadow') === '1';
const tpf = Math.max(1, Math.round(num('tpf', 2)));

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.style.margin = '0';
document.body.appendChild(renderer.domElement);
const world = new THREE.Scene();
world.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(num('fov', 55), window.innerWidth / window.innerHeight, 0.3, 20000);

// the star: direction (inertial), colour × irradiance; the planet's shadow is the visibility factor
const sunDefault = scene === 'hull' ? [1, 0.15, 0.1] : [-0.25, 0.55, -0.8];
const sunDir = new THREE.Vector3(num('sx', sunDefault[0]), num('sy', sunDefault[1]), num('sz', sunDefault[2])).normalize();
const sunVis = shadow ? 0 : 1;
const keyCol = new THREE.Color(1.0, 0.86, 0.72);
const keyI = 3;
const key = new THREE.DirectionalLight(keyCol, keyI * sunVis);
world.add(key, key.target);

// a Wren stand-in: fuselage, wing / pod span, nozzles (the real hull lives in ships.ts; this keeps the page small)
const ship = new THREE.Group();
const hullMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d4, roughness: 0.55, metalness: 0.05 });
const fus = new THREE.Mesh(new THREE.CapsuleGeometry(1.7, 24, 6, 16), hullMat);
fus.rotation.x = Math.PI / 2;
fus.position.y = 0.1;
const wing = new THREE.Mesh(new THREE.BoxGeometry(17.6, 1.2, 4), hullMat);
wing.position.set(0, -0.3, 7.5);
ship.add(fus, wing);
const layout = SHIP_LAYOUTS.wren;
for (const e of layout.engines) {
  const bell = new THREE.Mesh(new THREE.CylinderGeometry(e.radius, e.radius * 0.6, 2.2, 20, 1, true), new THREE.MeshStandardMaterial({ color: 0x555555, side: THREE.DoubleSide }));
  bell.rotation.x = Math.PI / 2;
  bell.position.set(e.pos.x, e.pos.y, e.pos.z - 1.1);
  ship.add(bell);
}
world.add(ship);

const jets = jetsFromLayout(layout.rcs);
const pool = new PuffPool(2048);
const tape = createDutyTape();
const puffs = new PuffRenderer(pool);
world.add(puffs.mesh);
const com = { x: 0, y: 0, z: 0 };
const plume = createPhysicalPlumes(
  layout.engines.map((e) => { const d = engineDef(e.pos, com); return { pos: e.pos, radius: e.radius, maxThrust: d.maxThrust, ve: d.ve }; }),
  { quality: 'high' },
);
ship.add(plume.object3d);

// ship state: absolute (doubles), yawing in the turn
const v = num('v', 7800);
const r0 = { x: 1.0e11, y: 2.0e6, z: -3.0e6 };
const shipR = { x: r0.x, y: r0.y, z: r0.z };
const shipV = { x: 0, y: 0, z: -v };
const w = { x: 0, y: scene === 'turn' ? 0.05 : 0, z: 0 };
const q = { x: 0, y: 0, z: 0, w: 1 };
const grav = { x: 0, y: -8.2, z: 0 };
const duty = new Float64Array(jets.length);
const levels = [0, 0];
const T = num('t', scene === 'turn' ? 2.31 : scene === 'hull' ? 0.12 : scene === 'hold' ? 1.5 : 1);
const nTicks = Math.round(T / TICK);
const ang0 = num('yaw0', 0.4);

function dutyAt(k: number): void {
  duty.fill(0);
  if (scene === 'turn') { if (k % 30 < 8) { duty[0] = 1; duty[5] = 1; } }
  else if (scene === 'hull') { if (k >= 2 && k < 6) duty[1] = 1; }
  else if (scene === 'hold') { if (k >= 24) { duty[0] = 0.3; duty[5] = 0.3; } }
}

function stateAt(t: number): void {
  // free fall: r = r0 + v t + ½ g t² (exact), yaw = ang0 + ω t
  shipR.x = r0.x + shipV.x * t;
  shipR.y = r0.y + shipV.y * t + 0.5 * grav.y * t * t;
  shipR.z = r0.z + shipV.z * t;
  const a = (scene === 'turn' ? ang0 + w.y * t : 0) / 2;
  q.x = 0; q.y = Math.sin(a); q.z = 0; q.w = Math.cos(a);
}

const vNow = { x: 0, y: 0, z: 0 };
tapeReset(tape, 0, duty, jets.length, 0);
for (let k = 1; k <= nTicks; k++) {
  dutyAt(k);
  tapeRecord(tape, 0, duty, jets.length, k); // the world, every tick
  if (k % tpf !== 0 && k !== nTicks) continue;
  const t = k * TICK; // the renderer, once a frame, with the tick state at the tape's last tick
  stateAt(t);
  vNow.x = shipV.x; vNow.y = shipV.y + grav.y * t; vNow.z = shipV.z;
  pool.frame(t, shipR, vNow, grav);
  pool.consume(0, { r: shipR, v: vNow, q, w }, jets, tape);
}
const t = nTicks * TICK;
if (scene === 'burn') { levels[0] = levels[1] = num('level', 1); plume.setLevels(levels); }

// camera relative to the ship (this page's origin is the ship)
const azD = scene === 'turn' ? 35 : scene === 'hull' ? -70 : scene === 'hold' ? 35 : 120;
const az = (num('az', azD) * Math.PI) / 180;
const el = (num('el', scene === 'turn' || scene === 'hold' ? 22 : scene === 'hull' ? 8 : 12) * Math.PI) / 180;
const dist = num('dist', scene === 'turn' || scene === 'hold' ? 62 : scene === 'hull' ? 40 : 95);
const tgt = new THREE.Vector3(scene === 'hull' ? -6 : 0, 0, scene === 'burn' ? 40 : scene === 'hull' ? -12 : 0);
camera.position.set(Math.sin(az) * Math.cos(el) * dist, Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist).add(tgt);
camera.lookAt(tgt);
camera.updateMatrixWorld();
ship.quaternion.set(q.x, q.y, q.z, q.w);
key.position.copy(sunDir).multiplyScalar(100);

const A = pool.anchorPos(t, { x: 0, y: 0, z: 0 });
const ax = A.x - shipR.x, ay = A.y - shipR.y, az2 = A.z - shipR.z; // anchor − ship (ship-origin page)
const occ = new Float32Array(MAX_OCCLUDERS * 8);
const nOcc = packOccluders(WREN_OCCLUDERS, q, shipR.x - A.x, shipR.y - A.y, shipR.z - A.z, occ);
const sunRGB = new THREE.Vector3(keyCol.r, keyCol.g, keyCol.b).multiplyScalar(keyI); // unshadowed irradiance
const bufH = renderer.getDrawingBufferSize(new THREE.Vector2());
const pxPerUnit = 0.5 * bufH.y * camera.projectionMatrix.elements[5];
const budget = PUFF_FILL_SCREENS * bufH.x * bufH.y;
// the shader twin: the floor solve (fill without the hull's shadow first, for the info line)
const fwd = new THREE.Vector3(), up = new THREE.Vector3(), right = new THREE.Vector3();
camera.matrixWorld.extractBasis(right, up, fwd);
fwd.negate();
const cam: PuffCam = { p: { x: camera.position.x - ax, y: camera.position.y - ay, z: camera.position.z - az2 }, right, up, fwd, px: pxPerUnit, shutter: 1 / 60 };
solvePuffFloor(pool, cam, sunDir, sunVis, budget, null, 0);
const fillNoOcc = pool.fillHonest;
const t0 = performance.now();
solvePuffFloor(pool, cam, sunDir, sunVis, budget, occ, nOcc);
const solveMs = performance.now() - t0;
const fill = pool.fillPx;
puffs.update(ax - camera.position.x, ay - camera.position.y, az2 - camera.position.z, sunDir, sunRGB, sunVis, occ, nOcc, 1 / 60, pxPerUnit);
puffs.mesh.position.set(ax, ay, az2); // this page draws in ship-origin coordinates, not camera-origin
(puffs.mesh.material as THREE.ShaderMaterial).uniforms.uCam.value.set(camera.position.x - ax, camera.position.y - ay, camera.position.z - az2);

renderer.render(world, camera);
const info = document.createElement('div');
info.style.cssText = 'position:fixed;left:8px;top:8px;font:11px monospace;color:#9ab;white-space:pre';
info.textContent = `${scene}${shadow ? ' (planet shadow)' : ''} t=${t.toFixed(3)} s tpf=${tpf} live=${pool.liveCount()} written=${Array.from(pool.countOut).join('/')} calls=${renderer.info.render.calls}\n` +
  `fill ${(fill / (bufH.x * bufH.y)).toFixed(4)} screens (honest ${(pool.fillHonest / (bufH.x * bufH.y)).toFixed(3)}, budget ${PUFF_FILL_SCREENS}, floor x${pool.floorPhi.toFixed(2)}, solve ${solveMs.toFixed(2)} ms)` + (scene === 'hull' ? `\nhonest fill with the hull's shadow ${(pool.fillHonest / (bufH.x * bufH.y)).toFixed(3)}, without it ${(fillNoOcc / (bufH.x * bufH.y)).toFixed(3)}` : '') +
  (scene === 'burn' ? `  engineLevel=${levels[0]}` : '');
document.body.appendChild(info);
(window as unknown as { __ready: boolean }).__ready = true;
