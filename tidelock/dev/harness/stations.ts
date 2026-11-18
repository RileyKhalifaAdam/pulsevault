// Visual harness for src/render/space/stations.ts (+ data/stationLayouts.ts), rendered through the real
// src/render/pipeline.ts so stills match the game.
//
//   dev/stations.html?station=ringHabitat&seed=1&yaw=30&pitch=18&dist=0&port=N2&night=0&mode=view
//
//   station   ringHabitat | spindle | refinery | outpost | drydock | citadel
//   seed      visual seed (module arrangement)            name   name painted on the hull
//   yaw/pitch camera azimuth / elevation round the station, deg (station frame: +Y spin axis)
//   dist      camera distance, m (0 = fit the station)   zoom   multiplies the fitted distance
//   tx,ty,tz  look-at point, station metres               fov    vertical field of view, deg (default 38)
//   port      id of the active (highlighted) port; 'none' (default in view mode) or e.g. N2
//   night=1   star behind the station (backlit; windows and floodlights carry the shape)
//   sun=az,el star direction (deg, station frame) instead of the default key placement
//   star      k (default warm K-type) | ember (red dwarf) | white
//   mode      view (default) | ship: park a Wren on the approach of `port` (default: first S/M port);
//             yaw/pitch/dist then orbit a point between the Wren and the berth
//   planet    eyeball (default) | gasGiant | none: world in the background
//   q         low | medium | high (default) | ultra      lod  auto | hero (default) | far
//   sheet=1   contact sheet: every archetype in a grid    time  seconds (rotor / blink phase)
//   colliders=1 draw the layout's colliders and port axes  info=1 triangles / draw calls / build ms
//   live=1    keep animating                             ev    exposure in stops
import * as THREE from 'three';
import type { BodyDef, StationVisualId } from '../../src/core/types';
import { createPipeline, type Quality, type RenderLayer } from '../../src/render/pipeline';
import { createSky } from '../../src/render/space/sky';
import { createBodyVisual, type BodyVisual } from '../../src/render/space/planet';
import { createShipVisual, type ShipVisual } from '../../src/render/space/ships';
import { createStationVisual, type StationVisual } from '../../src/render/space/stations';
import { STATION_LAYOUTS } from '../../src/data/stationLayouts';
import { generateGalaxy } from '../../src/sim/universe';

const params = new URLSearchParams(location.search);
const has = (k: string): boolean => params.has(k) && params.get(k) !== '';
const num = (k: string, d: number): number => (has(k) ? Number(params.get(k)) : d);
const str = (k: string, d: string): string => params.get(k) ?? d;
const DEG = Math.PI / 180;

const ALL: StationVisualId[] = ['ringHabitat', 'spindle', 'refinery', 'outpost', 'drydock', 'citadel'];
const stationId = (ALL as string[]).includes(str('station', 'ringHabitat')) ? (str('station', 'ringHabitat') as StationVisualId) : 'ringHabitat';
const quality = str('q', 'high') as Quality;
const sheet = num('sheet', 0) === 1;
const live = num('live', 0) === 1;
const night = num('night', 0) === 1;
const shipMode = str('mode', 'view') === 'ship';
const lodMode = str('lod', 'hero') as 'auto' | 'hero' | 'far';

// ------------------------------------------------------------------------------------------------ stage

const W = window.innerWidth;
const H = window.innerHeight;
const cols = sheet ? (W > H ? 3 : 2) : 1;
const rows = sheet ? Math.ceil(ALL.length / cols) : 1;
const cw = Math.floor(W / cols);
const chh = Math.floor(H / rows);

const canvas = document.createElement('canvas');
canvas.style.cssText = sheet ? 'position:fixed;left:0;top:0;visibility:hidden' : 'position:fixed;left:0;top:0;display:block';
document.body.appendChild(canvas);
const pipeline = createPipeline(canvas, { quality, dynamicResolution: false });
pipeline.resize(cw, chh, window.devicePixelRatio);
if (has('ev')) pipeline.setExposure(num('ev', 0));
const renderer = pipeline.renderer;

let sheetCtx: CanvasRenderingContext2D | null = null;
if (sheet) {
  const cv = document.createElement('canvas');
  cv.width = W * window.devicePixelRatio;
  cv.height = H * window.devicePixelRatio;
  cv.style.cssText = `position:fixed;left:0;top:0;width:${W}px;height:${H}px;display:block`;
  document.body.appendChild(cv);
  sheetCtx = cv.getContext('2d');
}
const label = document.createElement('pre');
label.style.cssText = 'position:fixed;left:8px;bottom:8px;margin:0;font:11px ui-monospace,monospace;color:#9fb3c8;white-space:pre;text-shadow:0 0 3px #000';
document.body.appendChild(label);

// ------------------------------------------------------------------------------------------------ light

const starKind = str('star', 'k');
const starColor = starKind === 'ember' ? new THREE.Color(1.0, 0.62, 0.38) : starKind === 'white' ? new THREE.Color(1.0, 0.97, 0.94) : new THREE.Color(1.0, 0.86, 0.72);
const sunDir = new THREE.Vector3();

const farScene = new THREE.Scene();
const nearScene = new THREE.Scene();
const sky = createSky(renderer, num('sky', 7), 'low');
farScene.add(sky.object3d);
const key = new THREE.DirectionalLight(starColor, Math.PI);
nearScene.add(key);
nearScene.add(key.target);
const shine = new THREE.DirectionalLight(new THREE.Color(0.55, 0.62, 0.75), 0.18);
nearScene.add(shine);
nearScene.add(shine.target);
nearScene.add(new THREE.AmbientLight(new THREE.Color(0.5, 0.55, 0.65), 0.012));

const camera = new THREE.PerspectiveCamera(num('fov', 38), cw / chh, 0.5, 80000);
const farCam = new THREE.PerspectiveCamera(camera.fov, camera.aspect, 0.01, 1000);

// backdrop world (far scene units: body radii)
const planetKind = str('planet', 'eyeball');
let planet: BodyVisual | null = null;
let planetDef: BodyDef | null = null;
if (planetKind !== 'none') {
  const galaxy = generateGalaxy(1);
  for (const sys of galaxy.systems) {
    for (const b of sys.bodies) if (!planetDef && b.cls === planetKind) planetDef = b;
  }
  if (planetDef) {
    planet = createBodyVisual(renderer, planetDef, 'low', { initialPixelRadius: 900 });
    farScene.add(planet.object3d);
  }
}
const planetPos = new THREE.Vector3();
const planetCtx = { sunDir, starColor, starIntensity: 1, time: 0, cameraPosLocal: new THREE.Vector3(), pixelRadius: 600 };

// ------------------------------------------------------------------------------------------------ content

interface Shot {
  id: StationVisualId;
  visual: StationVisual;
  ship: ShipVisual | null;
  target: THREE.Vector3;
  yaw: number;
  pitch: number;
  dist: number;
  active: string | null;
  /** camera basis for ship mode (port frame) */
  frame: { d: THREE.Vector3; u: THREE.Vector3; s: THREE.Vector3 } | null;
}

const shots: Shot[] = [];
const t0 = performance.now();
for (const id of sheet ? ALL : [stationId]) {
  const L = STATION_LAYOUTS[id];
  const visual = createStationVisual(id, { seed: num('seed', 1), quality, name: str('name', id === 'ringHabitat' ? 'HALCYON REACH' : id === 'outpost' ? 'KESTREL 4' : 'TIDE WORKS'), lod: lodMode });
  const shot: Shot = { id, visual, ship: null, target: new THREE.Vector3(num('tx', 0), num('ty', 0), num('tz', 0)), yaw: num('yaw', 32) * DEG, pitch: num('pitch', 20) * DEG, dist: 0, active: null, frame: null };
  const fit = (L.radius / Math.tan((camera.fov * DEG) / 2)) * (camera.aspect < 1 ? 1 / camera.aspect : 1) * 0.92;
  shot.dist = has('dist') && num('dist', 0) > 0 ? num('dist', 0) : fit * num('zoom', 1);
  const portParam = str('port', shipMode ? 'auto' : 'none');
  const port = portParam === 'auto' ? (L.ports.find((p) => p.size !== 'L') ?? L.ports[0]) : L.ports.find((p) => p.id === portParam);
  if (port) shot.active = port.id;
  if (shipMode && port) {
    const ship = createShipVisual('wren', { quality: quality === 'ultra' ? 'ultra' : quality, seed: 1, lod: 'hero' });
    const d = new THREE.Vector3(port.dir.x, port.dir.y, port.dir.z);
    const u = new THREE.Vector3(port.up.x, port.up.y, port.up.z);
    const s = new THREE.Vector3().crossVectors(u, d);
    const out = num('out', 70);
    // collar (+Y) toward the berth, nose along the port's up
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(d.clone().negate(), u.clone().negate()), d.clone().negate(), u.clone().negate());
    ship.object3d.quaternion.setFromRotationMatrix(m);
    ship.object3d.position.set(port.pos.x, port.pos.y, port.pos.z).addScaledVector(d, out);
    visual.object3d.add(ship.object3d);
    shot.ship = ship;
    shot.frame = { d, u, s };
    shot.target.copy(ship.object3d.position).addScaledVector(d, -out * 0.45);
    shot.dist = has('dist') ? num('dist', 160) : 160;
    shot.yaw = num('yaw', 28) * DEG;
    shot.pitch = num('pitch', 12) * DEG;
  }
  if (num('colliders', 0) === 1) addColliders(visual.object3d, id);
  shots.push(shot);
}
const buildMs = performance.now() - t0;

function addColliders(parent: THREE.Object3D, id: StationVisualId): void {
  const L = STATION_LAYOUTS[id];
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.0, 0.5, 1.0), wireframe: true, transparent: true, opacity: 0.35 });
  for (const c of L.colliders) {
    if (c.kind === 'sphere' || !c.b) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(c.radius, 12, 8), mat);
      m.position.set(c.a.x, c.a.y, c.a.z);
      parent.add(m);
    } else {
      const a = new THREE.Vector3(c.a.x, c.a.y, c.a.z);
      const b = new THREE.Vector3(c.b.x, c.b.y, c.b.z);
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(c.radius, a.distanceTo(b), 4, 10), mat);
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      parent.add(m);
    }
  }
  const lm = new THREE.LineBasicMaterial({ color: 0x33ff66 });
  for (const p of L.ports) {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z), new THREE.Vector3(p.pos.x + p.dir.x * 320, p.pos.y + p.dir.y * 320, p.pos.z + p.dir.z * 320)]);
    parent.add(new THREE.Line(g, lm));
  }
}

// ------------------------------------------------------------------------------------------------ camera + light per shot

const camDir = new THREE.Vector3();
const tmp = new THREE.Vector3();

function place(shot: Shot): void {
  const cp = Math.cos(shot.pitch);
  if (shot.frame) {
    const { d, u, s } = shot.frame;
    camDir.copy(d).multiplyScalar(Math.cos(shot.yaw) * cp).addScaledVector(s, Math.sin(shot.yaw) * cp).addScaledVector(u, Math.sin(shot.pitch));
    camera.up.copy(u);
  } else {
    camDir.set(Math.sin(shot.yaw) * cp, Math.sin(shot.pitch), Math.cos(shot.yaw) * cp);
    camera.up.set(0, 1, 0);
  }
  camera.position.copy(shot.target).addScaledVector(camDir, shot.dist);
  camera.lookAt(shot.target);
  camera.updateMatrixWorld();
  // star: key from front-right-above, or (night) from behind the station, a little off its limb
  if (has('sun')) {
    const [a, e] = str('sun', '40,30').split(',').map(Number);
    sunDir.set(Math.sin(a * DEG) * Math.cos(e * DEG), Math.sin(e * DEG), Math.cos(a * DEG) * Math.cos(e * DEG));
  } else {
    const right = tmp.setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    if (night) sunDir.copy(camDir).multiplyScalar(-1).addScaledVector(right, 0.35).addScaledVector(up, 0.12).normalize();
    else sunDir.copy(camDir).multiplyScalar(0.35).addScaledVector(right, 0.85).addScaledVector(up, 0.55).normalize();
  }
  key.position.copy(sunDir).multiplyScalar(1000);
  // far scene: same orientation at the origin; the world hangs below the line of sight
  farCam.quaternion.copy(camera.quaternion);
  farCam.aspect = camera.aspect;
  farCam.fov = camera.fov;
  farCam.updateProjectionMatrix();
  farCam.updateMatrixWorld();
  if (planet) {
    const fwd = new THREE.Vector3().setFromMatrixColumn(farCam.matrixWorld, 2).negate();
    const upv = new THREE.Vector3().setFromMatrixColumn(farCam.matrixWorld, 1);
    const pd = num('pdist', 2.7);
    const down = num('pdown', 31) * DEG;
    planetPos.copy(fwd).multiplyScalar(Math.cos(down)).addScaledVector(upv, -Math.sin(down)).normalize().multiplyScalar(pd);
    planet.object3d.position.copy(planetPos);
    planetCtx.cameraPosLocal.copy(planetPos).negate();
    planetCtx.pixelRadius = (chh * window.devicePixelRatio * 0.5) / Math.tan((camera.fov * DEG) / 2) / Math.sqrt(pd * pd - 1);
    // planet-shine: a dim fill from the world's direction
    shine.position.copy(planetPos).normalize().multiplyScalar(1000);
    shine.intensity = 0.16 * Math.max(0.15, 0.5 + 0.5 * planetPos.clone().normalize().dot(sunDir) * -1);
  } else shine.position.set(0, -1000, 0);
  sky.setStarLight(sunDir, starColor, 1);
  nearScene.environment = sky.envMap;
}

// ------------------------------------------------------------------------------------------------ frame loop

const layers: RenderLayer[] = [
  { scene: farScene, camera: farCam },
  { scene: nearScene, camera, clearDepth: true },
];
let time = num('time', 12);
let frames = 0;
let lastT = performance.now();

function drawShot(shot: Shot, dt: number): void {
  nearScene.add(shot.visual.object3d);
  place(shot);
  shot.visual.update({ dt, time, activePortId: shot.active });
  shot.ship?.update({ dt, time, throttle: 0, lightsOn: true, heat: 0, damage: 0 });
  if (planet) planet.update({ ...planetCtx, time });
  sky.update({});
  pipeline.render(layers, dt);
  nearScene.remove(shot.visual.object3d);
}

function frame(): void {
  const now = performance.now();
  const dt = frames === 0 ? 0 : Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  time += dt;
  if (sheet && sheetCtx) {
    const pr = window.devicePixelRatio;
    shots.forEach((s, i) => {
      drawShot(s, dt);
      sheetCtx!.drawImage(canvas, (i % cols) * cw * pr, Math.floor(i / cols) * chh * pr, cw * pr, chh * pr);
      sheetCtx!.fillStyle = '#9fb3c8';
      sheetCtx!.font = `${11 * pr}px ui-monospace,monospace`;
      sheetCtx!.fillText(s.id, ((i % cols) * cw + 6) * pr, (Math.floor(i / cols) * chh + 14) * pr);
    });
  } else drawShot(shots[0], dt);
  frames++;
  if (frames === 2) {
    if (num('info', 0) === 1) {
      const lines = shots.map((s) => `${s.id}: ${s.visual.stats.map((x) => `lod${x.lod} ${x.triangles} tris / ${x.drawCalls} calls / ${x.buildMs.toFixed(0)} ms`).join(' · ')}`);
      const st = pipeline.stats();
      lines.push(`frame: ${st.drawCalls} calls, ${st.triangles} tris · build ${buildMs.toFixed(0)} ms · ${quality}`);
      label.textContent = lines.join('\n');
      console.log(lines.join(' | '));
    }
    (window as unknown as { __ready: boolean }).__ready = true;
  }
  if (live || frames < 2) requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

(window as unknown as { __h: unknown }).__h = { shots, pipeline, sky, planet };
