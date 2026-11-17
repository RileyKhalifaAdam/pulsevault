// Visual harness for src/render/space/effects.ts.
//
//   dev/effects.html?fx=<name>&t=<seconds>&az=<deg>&el=<deg>&dist=<m>&...
//
//   fx     plume | plume-side | rcs | laser | explosion | shield | jump | plasma | dock | dust | canister | all
//   t      simulated time (s) before the still is taken (effects are stepped at 60 Hz up to t)
//   az/el  camera azimuth / elevation in degrees (az 0 = behind the ship on +Z, 90 = starboard side, 180 = head-on)
//   dist   camera distance, m          fov  vertical field of view, deg       tx,ty,tz  look-at target
//   kind   plume: fusion|chemical|ion  explosion: small|ship|large|rock       thr  throttle 0..1    n  engines
//   mode   jump: charge|flash|tunnel   k  plasma intensity / dust speed       q  quality low|medium|high|ultra
//   star   key-light colour: ember (default) | white                         live=1 keeps animating
//   info=1 prints draw calls / triangles of the scene pass
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import {
  EffectsManager,
  createCargoCanister,
  createEnginePlumes,
  createStrobes,
  seedEffectsRng,
  type EnginePlume,
  type ExplosionKind,
  type FxQuality,
  type PlumeKind,
} from '../../src/render/space/effects';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number): number => (params.has(k) ? Number(params.get(k)) : d);
const str = (k: string, d: string): string => params.get(k) ?? d;

const fx = str('fx', 'plume');
const quality = str('q', 'high') as FxQuality;
const T = num('t', NaN);
const live = params.get('live') === '1';

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
const camera = new THREE.PerspectiveCamera(num('fov', 50), window.innerWidth / window.innerHeight, 0.3, 80000);

const starCol = str('star', 'ember') === 'white' ? new THREE.Color(1.0, 0.96, 0.9) : new THREE.Color(1.0, 0.74, 0.5);
const sunDir = new THREE.Vector3(0.55, 0.62, -0.56).normalize();
const key = new THREE.DirectionalLight(starCol, 3);
key.position.copy(sunDir).multiplyScalar(100);
scene.add(key);
const fill = new THREE.DirectionalLight(new THREE.Color(0.35, 0.5, 0.8), 0.07);
fill.position.set(-0.2, -1, 0.3).multiplyScalar(100);
scene.add(fill);
scene.add(new THREE.AmbientLight(0x080a10, 0.25));

// small procedural environment: black sky, the star, dim planet-shine from below
{
  const envScene = new THREE.Scene();
  const envMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { uSun: { value: sunDir }, uCol: { value: starCol } },
    vertexShader: 'varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `varying vec3 vD; uniform vec3 uSun; uniform vec3 uCol;
      void main(){ vec3 d = normalize(vD); float s = max(dot(d,uSun),0.0);
        vec3 c = uCol * (pow(s, 900.0) * 900.0 + pow(s, 30.0) * 0.6);
        c += vec3(0.25,0.4,0.7) * 0.05 * smoothstep(0.1, -0.9, d.y);
        c += vec3(0.012);
        gl_FragColor = vec4(c, 1.0); }`,
  });
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), envMat));
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(envScene, 0.01).texture;
  pm.dispose();
}

// star field
const stars = (() => {
  const n = 2600;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  let s = 12345;
  const r = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < n; i++) {
    const z = r() * 2 - 1;
    const a = r() * Math.PI * 2;
    const q = Math.sqrt(1 - z * z);
    pos.set([q * Math.cos(a) * 40000, z * 40000, q * Math.sin(a) * 40000], i * 3);
    const m = Math.pow(r(), 5) * 1.6 + 0.05;
    const t = r();
    col.set([m * (0.8 + 0.2 * t), m * 0.85, m * (1.0 - 0.3 * t)], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const p = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6 * pr, sizeAttenuation: false, vertexColors: true, toneMapped: false }));
  p.frustumCulled = false;
  scene.add(p);
  return p;
})();

const rt = new THREE.WebGLRenderTarget(window.innerWidth * pr, window.innerHeight * pr, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), num('bloom', 0.5), 0.55, 1.0));
composer.addPass(new OutputPass());

// ------------------------------------------------------------------------------------------------ stand-ins

const hullMat = new THREE.MeshStandardMaterial({ color: 0x8d949c, metalness: 0.8, roughness: 0.42 });
const darkMat = new THREE.MeshStandardMaterial({ color: 0x1c1f24, metalness: 0.85, roughness: 0.5, side: THREE.DoubleSide });

interface Ship {
  group: THREE.Group;
  nozzles: { pos: THREE.Vector3; radius: number }[];
  radius: number;
}
/** Deliberately plain stand-in ship (forward -Z, exhaust +Z), ~16 m. */
function makeShip(engines = 2): Ship {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(1.5, 8, 6, 20), hullMat);
  body.rotation.x = Math.PI / 2;
  g.add(body);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(1.2, 4, 20), hullMat);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -7;
  g.add(nose);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(9, 0.18, 3.2), hullMat);
  wing.position.set(0, -0.2, 2.6);
  g.add(wing);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.6, 2.4), hullMat);
  fin.position.set(0, 2.2, 3.4);
  g.add(fin);
  const nozzles: Ship['nozzles'] = [];
  const R = engines === 1 ? 1.05 : 0.72;
  for (let i = 0; i < engines; i++) {
    const x = engines === 1 ? 0 : (i - (engines - 1) / 2) * 2.0;
    // open bell: throat at z=4.6, exit plane at z=6.4
    const pts = [new THREE.Vector2(R * 0.35, 0), new THREE.Vector2(R * 0.62, 0.5), new THREE.Vector2(R * 0.86, 1.1), new THREE.Vector2(R, 1.8), new THREE.Vector2(R * 1.06, 1.8)];
    const bell = new THREE.Mesh(new THREE.LatheGeometry(pts, 28), darkMat);
    bell.rotation.x = Math.PI / 2;
    bell.position.set(x, 0, 4.6);
    g.add(bell);
    const plug = new THREE.Mesh(new THREE.CircleGeometry(R * 0.36, 16), darkMat);
    plug.position.set(x, 0, 4.61);
    g.add(plug);
    nozzles.push({ pos: new THREE.Vector3(x, 0, 6.4), radius: R });
  }
  return { group: g, nozzles, radius: 8 };
}

// ------------------------------------------------------------------------------------------------ scenario

const manager = new EffectsManager({ quality });
scene.add(manager.object3d);
seedEffectsRng(num('seed', 7));

const cam = { az: num('az', 25), el: num('el', 14), dist: num('dist', 40), target: new THREE.Vector3(num('tx', 0), num('ty', 0), num('tz', 0)) };
const camDefault = (az: number, el: number, dist: number, tx = 0, ty = 0, tz = 0): void => {
  if (!params.has('az')) cam.az = az;
  if (!params.has('el')) cam.el = el;
  if (!params.has('dist')) cam.dist = dist;
  if (!params.has('tx')) cam.target.x = tx;
  if (!params.has('ty')) cam.target.y = ty;
  if (!params.has('tz')) cam.target.z = tz;
};

type StepFn = (t: number, dt: number) => void;
const steps: StepFn[] = [];
const plumes: EnginePlume[] = [];
const updatables: { update(dt: number, time: number): void }[] = [];
let defaultT = 2;
const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

function addPlumeShip(kind: PlumeKind, thr: number, engines: number): Ship {
  const ship = makeShip(engines);
  scene.add(ship.group);
  const plume = createEnginePlumes(ship.nozzles, { kind, quality });
  ship.group.add(plume.object3d);
  plume.setThrottle(thr);
  plumes.push(plume);
  return ship;
}

function setupPlume(side: boolean): void {
  const kind = str('kind', 'fusion') as PlumeKind;
  addPlumeShip(kind, num('thr', 1), num('n', 2));
  if (side) camDefault(90, 4, 46, 0, 0, 14);
  else camDefault(28, 16, 34, 0, 0, 6);
  defaultT = 3;
}

function setupRcs(): void {
  const ship = makeShip(2);
  scene.add(ship.group);
  const jets = [
    { p: V(1.6, 0.4, -4.5), d: V(1, 0.15, 0).normalize() },
    { p: V(-1.6, 0.4, 3.5), d: V(-1, 0.15, 0).normalize() },
    { p: V(0.3, 1.6, -4.2), d: V(0, 1, 0) },
    { p: V(0.0, -1.55, 3.6), d: V(0, -1, 0.1).normalize() },
  ];
  steps.push((t) => {
    for (let i = 0; i < jets.length; i++) if (i < 3 || t > 0.25) manager.rcsPuff(jets[i].p, jets[i].d, i === 2 ? 0.6 : 1);
  });
  camDefault(52, 22, 22, 0, 0.5, -0.5);
  defaultT = 0.6;
}

function setupLaser(): void {
  const a = makeShip(2);
  scene.add(a.group);
  const b = makeShip(1);
  b.group.position.set(60, 14, -210);
  b.group.rotation.y = 1.9;
  scene.add(b.group);
  const red: [number, number, number] = [1.0, 0.16, 0.08];
  const cyan: [number, number, number] = [0.3, 0.85, 1.0];
  const amber: [number, number, number] = [1.0, 0.62, 0.22];
  const muzzleL = V(-3.4, -0.3, -2);
  const muzzleR = V(3.4, -0.3, -2);
  const hit = V(58, 15, -206);
  const dirGun = V(-0.1, 0.02, -1).normalize();
  let lastShot = -1;
  let lastGun = -1;
  const missile = V(0, 0, 0);
  const mvel = V(0, 0, 0);
  steps.push((t, dt) => {
    // alternating pulse lasers every 0.35 s
    const shot = Math.floor(t / 0.35);
    if (shot !== lastShot) {
      lastShot = shot;
      const from = shot % 2 ? muzzleL : muzzleR;
      manager.laserBeam(from, hit, shot % 2 ? red : cyan, 0.14, 0.3);
      manager.impactSparks(hit, V(-0.3, 0.1, 1).normalize(), amber, 1);
    }
    // autocannon from ship B toward the camera side
    const gun = Math.floor(t / 0.07);
    if (gun !== lastGun) {
      lastGun = gun;
      const gp = V(56, 13, -202);
      const gv = V(-52 + Math.sin(gun * 1.7) * 3, -8 + Math.cos(gun * 2.3) * 2, 190).normalize().multiplyScalar(520);
      manager.tracer(gp, gv, amber, 1.2);
      if (gun % 2 === 0) manager.muzzleFlash(gp, gv.clone().normalize(), amber, 1.2);
    }
    // a missile crossing the frame
    missile.set(-30 + 95 * t, 6 + 2.5 * t, -60 - 45 * t);
    mvel.set(95, 2.5, -45);
    manager.missileTrail(missile, mvel, [1.0, 0.72, 0.4]);
    void dt;
    void dirGun;
  });
  camDefault(-18, 12, 30, 2, 2, -8);
  defaultT = 0.83;
}

function setupExplosion(): void {
  const kind = str('kind', 'ship') as ExplosionKind;
  const R = num('r', 10);
  let done = false;
  steps.push(() => {
    if (!done) {
      done = true;
      manager.explosion(V(0, 0, 0), R, { kind });
    }
  });
  // something sun-lit for scale
  const ship = makeShip(2);
  ship.group.position.set(-34, -12, -30);
  ship.group.rotation.set(0.2, 0.9, 0.1);
  scene.add(ship.group);
  camDefault(20, 8, R * 9, 0, 0, 0);
  defaultT = 0.35;
}

function setupShield(): void {
  const ship = makeShip(2);
  scene.add(ship.group);
  let done = false;
  const hitDir = V(0.75, 0.45, 0.5).normalize();
  steps.push((t) => {
    if (!done) {
      done = true;
      manager.shieldImpact(V(0, 0, 0), 11, hitDir.clone().multiplyScalar(11), [0.3, 0.75, 1.0]);
    }
    if (t > 0.3 && t < 0.32) manager.shieldImpact(V(0, 0, 0), 11, V(-0.3, 0.8, 0.5).normalize().multiplyScalar(11), [0.3, 0.75, 1.0]);
  });
  camDefault(38, 18, 38, 0, 0, 0);
  defaultT = 0.2;
}

function setupJump(): void {
  const mode = str('mode', 'charge');
  const ship = addPlumeShip('fusion', mode === 'tunnel' ? 0.15 : 0.0, 2);
  const dir = V(0, 0, -1);
  if (mode === 'charge') {
    steps.push((t) => manager.jumpCharge(ship.group.position, 9, Math.min(1, t / 4), dir));
    camDefault(140, 12, 44, 0, 0, 0);
    defaultT = 3.4;
  } else if (mode === 'flash') {
    let done = false;
    steps.push(() => {
      if (!done) {
        done = true;
        ship.group.visible = false;
        manager.jumpFlash(V(0, 0, 0), 9, dir);
      }
    });
    camDefault(120, 10, 70, 0, 0, 0);
    defaultT = 0.22;
  } else {
    steps.push(() => manager.jumpTunnel(num('k', 1), dir));
    stars.visible = false;
    camDefault(14, 12, 30, 0, 1.5, -6);
    defaultT = 2.5;
  }
}

function setupPlasma(): void {
  const ship = makeShip(2);
  scene.add(ship.group);
  const k = num('k', 0.8);
  const vdir = V(0, -0.34, -1).normalize(); // nose-up entry attitude
  steps.push(() => manager.reentryPlasma(ship.group, ship.radius, k, vdir));
  camDefault(62, 10, 46, 0, 0, 8);
  defaultT = 1.5;
}

function setupDock(): void {
  // stand-in station wall with a docking collar; port looks toward +Z
  const wall = new THREE.Mesh(new THREE.BoxGeometry(120, 80, 6), hullMat);
  wall.position.set(0, 0, -3.2);
  scene.add(wall);
  const collar = new THREE.Mesh(new THREE.TorusGeometry(7, 0.8, 10, 40), darkMat);
  scene.add(collar);
  const lights = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    lights.push({ pos: V(Math.cos(a) * 8.6, Math.sin(a) * 8.6, 0.6), color: [0.4, 1.0, 0.6] as [number, number, number], blink: 0, size: 0.18 });
  }
  lights.push({ pos: V(-58, 38, 0.5), color: [1, 0.1, 0.05] as [number, number, number], blink: 1.4, size: 0.3 });
  lights.push({ pos: V(58, 38, 0.5), color: [0.1, 1, 0.3] as [number, number, number], blink: 1.4, size: 0.3 });
  const st = createStrobes(lights);
  scene.add(st.object3d);
  updatables.push(st);
  steps.push(() => manager.dockingGuide({ pos: V(0, 0, 0), dir: V(0, 0, 1), up: V(0, 1, 0) }, 14, num('aligned', 0)));
  camDefault(13, 7, 150, 0, 2, 40);
  defaultT = 1.2;
}

function setupDust(): void {
  const ship = makeShip(2);
  scene.add(ship.group);
  const v = num('k', 60);
  steps.push(() => manager.setDust(V(0, 0, -v), 1));
  camDefault(18, 12, 30, 0, 1, -4);
  defaultT = 1;
}

function setupCanister(): void {
  const c = createCargoCanister();
  c.object3d.rotation.set(0.35, 0.6, 0.2);
  scene.add(c.object3d);
  updatables.push(c);
  const c2 = createCargoCanister({ stripe: [0.1, 0.55, 0.6] });
  c2.object3d.position.set(2.2, -0.8, -3.4);
  c2.object3d.rotation.set(1.2, 0.2, 1.9);
  scene.add(c2.object3d);
  updatables.push(c2);
  const st = createStrobes([{ pos: V(0, 0.62, -0.7), color: [1, 0.55, 0.1], blink: 1.2, size: 0.05 }]);
  c.object3d.add(st.object3d);
  updatables.push(st);
  camDefault(35, 18, 4.6, 0.4, -0.1, -0.6);
  defaultT = 0.05;
}

function setupAll(): void {
  const ship = addPlumeShip('fusion', 1, 2);
  const b = addPlumeShip('chemical', 1, 1);
  b.group.position.set(-40, 10, -90);
  b.group.rotation.y = -0.7;
  const st = createStrobes([
    { pos: V(-4.5, -0.2, 2.6), color: [1, 0.08, 0.04], blink: 0 },
    { pos: V(4.5, -0.2, 2.6), color: [0.08, 1, 0.25], blink: 0 },
    { pos: V(0, 3.5, 4.4), color: [1, 1, 1], blink: 1.1 },
  ]);
  ship.group.add(st.object3d);
  updatables.push(st);
  let boom = false;
  let lastShot = -1;
  steps.push((t) => {
    manager.rcsPuff(V(1.6, 0.4, -4.5), V(1, 0.1, 0).normalize(), 1);
    manager.setDust(V(0, 0, -40), 1);
    manager.dockingGuide({ pos: V(60, -10, -260), dir: V(-0.3, 0.1, 1).normalize(), up: V(0, 1, 0) }, 14, 0);
    manager.miningBeam(V(-3, -1, -3), V(-22, -9, -48), 1);
    manager.reentryPlasma(b.group, b.radius, 0.5, V(0, 0, -1));
    const shot = Math.floor(t / 0.3);
    if (shot !== lastShot) {
      lastShot = shot;
      manager.laserBeam(V(3.4, -0.3, -2), V(-38, 11, -88), [1, 0.2, 0.1], 0.14, 0.3);
      manager.shieldImpact(b.group.position, 10, V(-36, 11, -82), [0.3, 0.75, 1.0]);
    }
    if (!boom && t > 0.4) {
      boom = true;
      manager.explosion(V(30, 8, -70), 8, { kind: 'large' });
    }
  });
  camDefault(20, 14, 34, 0, 2, -8);
  defaultT = 0.9;
}

switch (fx) {
  case 'plume': setupPlume(false); break;
  case 'plume-side': setupPlume(true); break;
  case 'rcs': setupRcs(); break;
  case 'laser': setupLaser(); break;
  case 'explosion': setupExplosion(); break;
  case 'shield': setupShield(); break;
  case 'jump': setupJump(); break;
  case 'plasma': setupPlasma(); break;
  case 'dock': setupDock(); break;
  case 'dust': setupDust(); break;
  case 'canister': setupCanister(); break;
  default: setupAll(); break;
}

// ------------------------------------------------------------------------------------------------ loop

const camPos = new THREE.Vector3();
function placeCamera(): void {
  const az = (cam.az * Math.PI) / 180;
  const el = (cam.el * Math.PI) / 180;
  camPos.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(cam.dist).add(cam.target);
  camera.position.copy(camPos);
  camera.lookAt(cam.target);
  stars.position.copy(camPos);
}

let simT = 0;
function advance(dt: number): void {
  simT += dt;
  for (const s of steps) s(simT, dt);
  for (const p of plumes) p.update(dt, simT);
  for (const u of updatables) u.update(dt, simT);
  manager.update(dt, simT, camPos);
}

placeCamera();
const endT = Number.isFinite(T) ? T : defaultT;
const DT = 1 / 60;
while (simT < endT - 1e-6) advance(DT);

const info = document.createElement('div');
info.style.cssText = 'position:fixed;left:8px;bottom:8px;font:11px monospace;color:#8fa3b8;white-space:pre';
if (params.get('info') === '1') document.body.appendChild(info);

let frames = 0;
let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  if (live) {
    advance(Math.min(0.05, (now - last) / 1000));
    if (params.get('spin') === '1') cam.az += 0.2;
    placeCamera();
  }
  last = now;
  if (!live && frames >= 3) return;
  if (params.get('info') === '1' && frames === 1) {
    renderer.info.autoReset = false;
    renderer.info.reset();
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    info.textContent = `fx=${fx} t=${simT.toFixed(2)}  calls ${renderer.info.render.calls}  tris ${renderer.info.render.triangles}`;
    renderer.info.autoReset = true;
  }
  composer.render();
  if (++frames === 3) (window as unknown as { __ready: boolean }).__ready = true;
});
