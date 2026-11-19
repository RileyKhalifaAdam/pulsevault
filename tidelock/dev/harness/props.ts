// Visual harness for loose objects (src/world/props.ts physics + src/render/space/props.ts models): a
// lounge-sized box room (6.4 × 2.4 × 5.8 m) with a table and a counter, one of every object type, stepped
// by the real props physics at 60 fps before the frame is drawn.
//
//   dev/props.html?mode=float|thrust|throw|models&t=<seconds>&q=low|medium|high|ultra
//
//   models   the objects at rest on the table and counter, close up
//   float    free fall: everything set drifting and tumbling, t s later (default 1.6)
//   thrust   12 m/s² toward the bow (-Z): the pile against the aft wall (+Z), t s later (default 5)
//   throw    the pilot grabs a mug, lifts it and throws it across the room; its path traced
import * as THREE from 'three';
import type { Quat, V3 } from '../../src/core/types';
import type { InteriorLayout } from '../../src/data/interiors';
import type { PropDef, PropType } from '../../src/data/props';
import { createCrew, createShipMotion, stepCrew } from '../../src/world/crew';
import { createPropsState, definePropsLayout, grab, moveGrab, propViews, release, stepProps } from '../../src/world/props';
import { createPropsVisual } from '../../src/render/space/props';
import type { Quality } from '../../src/render/pipeline';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'models';
const quality = (params.get('q') ?? 'high') as Quality;
const tParam = params.get('t');

document.body.style.cssText = 'margin:0;background:#000;overflow:hidden;height:100%';
document.documentElement.style.height = '100%';
const canvas = document.createElement('canvas');
canvas.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;display:block';
document.body.appendChild(canvas);
const info = document.createElement('pre');
info.style.cssText = 'position:fixed;left:6px;top:4px;margin:0;font:10px/1.3 monospace;color:#9fd;opacity:0.9;white-space:pre-wrap;pointer-events:none';
document.body.appendChild(info);
const ready = (): void => { (window as unknown as { __ready: boolean }).__ready = true; };
const showError = (e: unknown): void => {
  info.style.color = '#f88';
  info.textContent = `ERROR ${e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)}`;
  ready();
};
window.addEventListener('error', (e) => showError(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => showError(e.reason));

// ------------------------------------------------------------------------------------------------ the room
const v = (x: number, y: number, z: number): V3 => ({ x, y, z });
const bx = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => ({ min: v(x0, y0, z0), max: v(x1, y1, z1) });
const F = -1, C = 1.4;
const LAYOUT: InteriorLayout = {
  shipId: 'wren',
  rooms: [{ id: 'lounge', name: 'Lounge', box: bx(-3.2, F, -2.9, 3.2, C, 2.9) }],
  doors: [],
  solids: [
    { id: 'table', kind: 'table', room: 'lounge', box: bx(-0.6, F, -0.9, 0.6, -0.3, 0.9) },
    { id: 'counter', kind: 'counter', room: 'lounge', box: bx(-3.2, F, -2.4, -2.55, -0.08, 1.6) },
  ],
  windows: [], interactables: [],
  spawn: { pos: v(1.1, F, 0.2), yaw: Math.PI / 2 },
  helmEye: v(0, 0, 0), bunkEye: v(0, 0, 0), tableEye: v(0, 0, 0),
};
const yaw = (deg: number): Quat => ({ x: 0, y: Math.sin((deg * Math.PI) / 360), z: 0, w: Math.cos((deg * Math.PI) / 360) });
const S2 = Math.SQRT1_2;
const ALONG_Z: Quat = { x: S2, y: 0, z: 0, w: S2 };
const T = -0.3, K = -0.08; // table and counter tops
const d = (id: string, type: PropType, pos: V3, rot: Quat = yaw(0)): PropDef => ({ id, type, room: 'lounge', pos, rot, stow: 'loose', holdN: 0 });
const DEFS: PropDef[] = [
  d('mug-1', 'mug', v(0.5, T + 0.057, -0.35)),
  d('mug-2', 'mug', v(0.38, T + 0.057, 0.25), yaw(40)),
  d('mug-3', 'mug', v(-2.85, K + 0.057, -1.4), yaw(-30)),
  d('book-1', 'book', v(-0.2, T + 0.017, 0.35), yaw(18)),
  d('book-2', 'book', v(-0.25, T + 0.047, 0.38), yaw(-12)),
  d('tablet', 'tablet', v(-0.1, T + 0.0065, -0.4), yaw(-8)),
  d('pen', 'pen', v(0.12, T + 0.0075, 0.0), { x: 0, y: 0.38, z: -0.6, w: 0.7 }),
  d('bottle', 'bottle', v(-2.85, K + 0.04, -0.6), ALONG_Z),
  d('food-1', 'foodpack', v(-2.9, K + 0.024, 0.0)),
  d('food-2', 'foodpack', v(-2.9, K + 0.024, 0.2), yaw(10)),
  d('plant', 'plantpot', v(-2.88, K + 0.122, 1.1)),
  d('toolbox', 'toolbox', v(0.25, T + 0.112, 0.6), yaw(80)),
  d('spanner', 'spanner', v(-0.3, T + 0.008, -0.05), yaw(35)),
  d('torch', 'torch', v(0.0, T + 0.021, -0.7), { x: 0, y: 0, z: -S2, w: S2 }),
  d('pillow', 'pillow', v(2.4, F + 0.062, -2.2), yaw(20)),
  d('helmet', 'helmet', v(-0.35, T + 0.157, -0.6)),
  d('crate-s', 'crateSmall', v(2.4, F + 0.202, 1.9), yaw(8)),
  d('crate-l', 'crateLarge', v(2.4, F + 0.302, 0.4), yaw(90)),
];
definePropsLayout('harness', LAYOUT, DEFS);

// ------------------------------------------------------------------------------------------------ physics
const state = createPropsState('harness');
if (!state) throw new Error('no props state');
const ship = createShipMotion();
const crew = createCrew(LAYOUT, 'harness');
const H = 1 / 60;
let subs = 0, ms = 0, steps = 0;
const step = (withCrew: boolean): void => {
  const t0 = performance.now();
  if (withCrew) stepCrew(crew, LAYOUT, ship, { moveX: 0, moveZ: 0 }, H);
  subs += stepProps(state, ship, withCrew ? crew : null, H);
  ms += performance.now() - t0;
  steps++;
};
let seed = 12345;
const rnd = (): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
const trail: THREE.Vector3[] = [];
let note = '';

if (mode === 'float') {
  for (const b of state.bodies) {
    const big = b.id.startsWith('crate') || b.id === 'toolbox';
    const sp = big ? 0.15 : 0.6;
    b.v = v((rnd() - 0.5) * sp, 0.25 + rnd() * sp * 0.6, (rnd() - 0.5) * sp);
    b.w = v((rnd() - 0.5) * 4, (rnd() - 0.5) * 4, (rnd() - 0.5) * 4);
    b.asleep = false;
  }
  const t = Number(tParam ?? 1.6);
  for (let i = 0; i < t * 60; i++) step(false);
  note = `free fall, ${t.toFixed(1)} s after everything was set drifting`;
} else if (mode === 'thrust') {
  ship.a.z = -12;
  const t = Number(tParam ?? 5);
  for (let i = 0; i < t * 60; i++) step(false);
  note = `main drive 12 m/s² toward the bow (−Z) for ${t.toFixed(1)} s: everything felt toward the stern (+Z)`;
} else if (mode === 'throw') {
  crew.pos = v(0.95, F, -0.35);
  const eye = v(crew.pos.x, crew.pos.y + 1.62, crew.pos.z);
  const mug = state.bodies.find((b) => b.id === 'mug-1')!;
  const hand = v(mug.p.x, mug.p.y, mug.p.z);
  const ok = grab(state, 'mug-1', hand, eye);
  // lift it to chest height over 0.6 s, then a 0.15 s throwing motion and release toward the far (−X) wall
  for (let i = 0; i < 36; i++) { hand.x += 0.1 / 36; hand.y += (0.35 - (T + 0.057)) / 36; moveGrab(state, hand, H); step(true); trail.push(new THREE.Vector3(mug.p.x, mug.p.y, mug.p.z)); }
  for (let i = 0; i < 9; i++) { hand.x -= 0.04; hand.y += 0.01; moveGrab(state, hand, H); step(true); trail.push(new THREE.Vector3(mug.p.x, mug.p.y, mug.p.z)); }
  release(state, v(-4.5, 0.6, -0.4), crew);
  const t = Number(tParam ?? 0.55);
  for (let i = 0; i < t * 60; i++) { step(true); trail.push(new THREE.Vector3(mug.p.x, mug.p.y, mug.p.z)); }
  note = `grab ${ok ? 'ok' : 'FAILED'}; lifted, thrown at (−4.5, 0.6, −0.4) m/s, ${t.toFixed(2)} s after release; mug v = (${mug.v.x.toFixed(2)}, ${mug.v.y.toFixed(2)}, ${mug.v.z.toFixed(2)})`;
} else {
  for (let i = 0; i < 30; i++) step(false);
  note = 'at rest on the table, the counter and the deck';
}

// ------------------------------------------------------------------------------------------------ the scene
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d10);

const wallMat = new THREE.MeshStandardMaterial({ color: 0x8b939b, roughness: 0.8, metalness: 0.1, side: THREE.BackSide });
const room = new THREE.Mesh(new THREE.BoxGeometry(6.4, 2.4, 5.8), wallMat);
room.position.set(0, 0.2, 0);
room.receiveShadow = true;
scene.add(room);
const deck = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 5.8), new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.7, metalness: 0.2 }));
deck.rotation.x = -Math.PI / 2;
deck.position.y = F + 0.001;
deck.receiveShadow = true;
scene.add(deck);
for (let i = -2; i <= 2; i++) {
  const strip = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.004, 0.03), new THREE.MeshStandardMaterial({ color: 0x2b3036, roughness: 0.6 }));
  strip.position.set(0, F + 0.003, i * 1.2);
  strip.receiveShadow = true;
  scene.add(strip);
}
const solidMat = new THREE.MeshStandardMaterial({ color: 0xc9ccd0, roughness: 0.55, metalness: 0.15 });
for (const s of LAYOUT.solids) {
  const b = s.box, m = new THREE.Mesh(new THREE.BoxGeometry(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z), solidMat);
  m.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
  m.castShadow = m.receiveShadow = true;
  scene.add(m);
}
scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x303438, 0.55));
for (const [x, z] of [[-1.2, -1.0], [1.3, 0.9]]) {
  const l = new THREE.PointLight(0xfff1dc, 9, 9, 1.6);
  l.position.set(x, 1.3, z);
  l.castShadow = true;
  l.shadow.mapSize.set(1024, 1024);
  l.shadow.bias = -0.002;
  l.shadow.radius = 3;
  scene.add(l);
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.02, 24), new THREE.MeshBasicMaterial({ color: 0xfff6e8 }));
  lamp.position.set(x, 1.39, z);
  scene.add(lamp);
}
const key = new THREE.SpotLight(0xdde8ff, 14, 10, 0.75, 0.5, 1.2);
key.position.set(2.6, 1.3, -2.5);
key.target.position.set(-0.5, -0.6, 0.6);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.bias = -0.0008;
scene.add(key, key.target);

const visual = createPropsVisual({ quality });
scene.add(visual.object3d);
visual.update(propViews(state));
if (trail.length > 1) {
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(trail), new THREE.LineBasicMaterial({ color: 0xffb040 })));
  const dots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.008, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffd080 }), trail.length);
  trail.forEach((p, i) => dots.setMatrixAt(i, new THREE.Matrix4().makeTranslation(p.x, p.y, p.z)));
  scene.add(dots);
}

const aspect = window.innerWidth / Math.max(1, window.innerHeight);
const camera = new THREE.PerspectiveCamera(aspect < 1 ? 72 : 58, aspect, 0.02, 30);
if (mode === 'thrust') { camera.position.set(-0.4, 1.0, -2.6); camera.lookAt(0.3, -0.6, 2.4); }
else if (mode === 'float') { camera.position.set(-0.2, 1.15, -2.75); camera.lookAt(0.2, -0.25, 0.9); }
else if (mode === 'throw') { camera.position.set(1.0, 0.7, 2.6); camera.lookAt(-1.0, -0.1, -0.4); }
else { camera.position.set(1.25, 0.35, -1.25); camera.lookAt(-0.2, -0.35, 0.05); }

const awake = state.bodies.filter((b) => !b.asleep).length;
renderer.render(scene, camera);
const calls = renderer.info.render.calls;
info.textContent = `props harness · ${mode} · q=${quality}\n${note}\n${state.bodies.length} bodies, ${awake} awake · ${steps} frames, ${subs} sub-steps, ${(ms / Math.max(1, steps)).toFixed(3)} ms/frame physics · ${calls} draw calls (incl. room)`;
ready();
