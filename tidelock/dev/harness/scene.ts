// Visual harness for the scene manager (src/render/scene.ts + camera.ts + frame.ts): the real Tallow system,
// hand-filled SceneFrames, one still per situation of the first playable loop.
//
//   dev/scene.html?shot=dock
//
//   shot   dock      Wren 300 m off Chandler's Wheel on the approach of berth N4, Wick below (chase camera)
//          approach  Chandler's Wheel about 4 km ahead, Wick filling the lower half
//          limb      low orbit over Wick's terminator, heading for sunrise (chase camera)
//          burn      full throttle, prograde, near Chandler's Wheel
//          night     in Wick's shadow, off Chandler's Wheel
//          outpost   on final for berth P2 of Gloaming Lock (dock camera, approach guide on)
//   cam    chase | orbit | dock (default per shot)      yaw, pitch  camera offsets, deg     zoom  distance multiple
//   q      low (default) | medium | high | ultra          frames  frames rendered before the still (default 10)
//   sun    signed sun angle override, deg (0 = noon, + = morning / sun ahead, 180 = midnight)
//   live=1 keep animating (time runs, the Wren coasts on its orbit)
//   cycle=1 rebuild the scene once before the still (the context-restore / quality-change path)
//   advance=1 let sim time run during the pre-roll frames too (warp=N multiplies it): tests the floating origin
import * as THREE from 'three';
import type { Quat, V3 } from '../../src/core/types';
import { createPipeline, type Quality } from '../../src/render/pipeline';
import { createSceneManager, type Projection } from '../../src/render/scene';
import { addShip, addStationExtra, beginFrame, createSceneFrame, setDockingGuide, type CameraMode } from '../../src/render/frame';
import { generateGalaxy } from '../../src/sim/universe';
import { SystemModel, newState, propagateStateTo } from '../../src/sim/orbit';
import { stationAttitude } from '../../src/sim/physics';
import { STATION_LAYOUTS } from '../../src/data/stationLayouts';

const params = new URLSearchParams(location.search);
const has = (k: string): boolean => params.has(k) && params.get(k) !== '';
const num = (k: string, d: number): number => (has(k) ? Number(params.get(k)) : d);
const str = (k: string, d: string): string => params.get(k) ?? d;
const DEG = Math.PI / 180;

type Shot = 'dock' | 'approach' | 'limb' | 'burn' | 'night' | 'outpost';
const SHOTS: Shot[] = ['dock', 'approach', 'limb', 'burn', 'night', 'outpost'];
const shot: Shot = (SHOTS as string[]).includes(str('shot', 'dock')) ? (str('shot', 'dock') as Shot) : 'dock';
const quality = str('q', 'low') as Quality;
const live = num('live', 0) === 1;
const advance = num('advance', 0) === 1;
const warp = num('warp', 1);

const WICK = 'tallow.wick';
const WHEEL = 'tallow.st.chandlers-wheel';
const LOCK = 'tallow.st.gloaming-lock';

// ------------------------------------------------------------------------------------------------ maths

const V = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const add = (a: V3, b: V3, s = 1): V3 => V(a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
const sub = (a: V3, b: V3): V3 => V(a.x - b.x, a.y - b.y, a.z - b.z);
const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: V3, b: V3): V3 => V(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return V(a.x / l, a.y / l, a.z / l);
};
const rot = (q: Quat, v: V3): V3 => {
  const t = new THREE.Vector3(v.x, v.y, v.z).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
  return V(t.x, t.y, t.z);
};
/** Ship attitude (local -Z forward, +Y up) from a forward direction and an approximate up. */
function attitude(fwd: V3, upHint: V3): Quat {
  const f = norm(fwd);
  let u = norm(add(upHint, f, -dot(upHint, f)));
  if (len(u) < 0.5) u = norm(cross(f, V(1, 0, 0)));
  const x = cross(f, u);
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(x.x, x.y, x.z), new THREE.Vector3(u.x, u.y, u.z), new THREE.Vector3(-f.x, -f.y, -f.z));
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

// ------------------------------------------------------------------------------------------------ the system

const galaxy = generateGalaxy(1);
const system = galaxy.systems.find((s) => s.id === galaxy.startSystemId);
if (!system) throw new Error('no start system');
const model = new SystemModel(system);
const wick = model.body(WICK);
const NORTH = V(0, 1, 0);

/** Unit vector from Wick to the star at `t`. */
function sunDir(t: number): V3 {
  return norm(sub(model.bodyAbsPosition(model.primary.id, t), model.bodyAbsPosition(WICK, t)));
}

interface StationCtx {
  t: number;
  r: V3;
  v: V3;
  /** radial out, prograde, to the star */
  rh: V3;
  ph: V3;
  sh: V3;
  /** signed sun angle, rad: 0 noon, + morning (sun ahead), pi midnight */
  sun: number;
}
function stationCtx(id: string, t: number): StationCtx {
  const sv = model.stationState(id, t);
  const rh = norm(sv.r);
  const ph = norm(sv.v);
  const sh = sunDir(t);
  return { t, r: V(sv.r.x, sv.r.y, sv.r.z), v: V(sv.v.x, sv.v.y, sv.v.z), rh, ph, sh, sun: Math.atan2(dot(sh, ph), dot(sh, rh)) };
}
/** Best-scoring time for a station over `orbits` of its revolutions. */
function scan(id: string, orbits: number, score: (c: StationCtx) => number): StationCtx {
  const sv = model.stationState(id, 0);
  const period = (2 * Math.PI * len(sv.r)) / len(sv.v);
  const step = period / 360;
  let best = stationCtx(id, 0);
  let bestS = -Infinity;
  for (let t = 0; t < period * orbits; t += step) {
    const c = stationCtx(id, t);
    const s = score(c);
    if (s > bestS) {
      bestS = s;
      best = c;
    }
  }
  return best;
}
const angDiff = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
function portWorld(stationId: string, portId: string): { pos: V3; dir: V3; up: V3 } {
  const def = model.station(stationId);
  const q = stationAttitude(def.orbit);
  const port = STATION_LAYOUTS[def.visualId].ports.find((p) => p.id === portId);
  if (!port) throw new Error(`no port ${portId}`);
  return { pos: rot(q, port.pos), dir: rot(q, port.dir), up: rot(q, port.up) };
}

// ------------------------------------------------------------------------------------------------ shots

interface Setup {
  time: number;
  r: V3;
  v: V3;
  q: Quat;
  throttle: number;
  cam: { mode: CameraMode; yaw: number; pitch: number; distance: number; lookAtId: string | null };
  guide: { stationId: string; portId: string } | null;
  note: string;
}

function build(): Setup {
  const sunOverride = has('sun') ? num('sun', 0) * DEG : null;
  const sunAt = (d: number): number => sunOverride ?? d * DEG;
  const wickYear = 600; // station revolutions scanned when the attitude of the station matters too
  switch (shot) {
    case 'dock':
    case 'night': {
      const p = portWorld(WHEEL, 'N4');
      const target = sunAt(shot === 'night' ? 180 : -50);
      // the berth faces along the orbit (Wick straight "down" for a ship on its approach) and the star lights the side we see
      const c = scan(WHEEL, wickYear, (k) => -3 * Math.abs(dot(k.rh, p.dir)) - angDiff(k.sun, target) - (shot === 'dock' && dot(k.sh, p.dir) < 0.25 ? 2 : 0));
      const off = add(p.pos, p.dir, 300);
      return {
        time: c.t,
        r: add(c.r, off),
        v: c.v,
        q: attitude(V(-p.dir.x, -p.dir.y, -p.dir.z), c.rh),
        throttle: 0,
        cam: { mode: 'chase', yaw: -22 * DEG, pitch: 6 * DEG, distance: 1, lookAtId: null },
        guide: { stationId: WHEEL, portId: 'N4' },
        note: `sun ${(c.sun / DEG).toFixed(0)} deg, berth N4 at 300 m`,
      };
    }
    case 'approach': {
      const c = scan(WHEEL, 1, (k) => -angDiff(k.sun, sunAt(-55)));
      const th = 17 * DEG;
      const off = add(V(-c.ph.x * Math.cos(th) * 4000, -c.ph.y * Math.cos(th) * 4000, -c.ph.z * Math.cos(th) * 4000), c.rh, Math.sin(th) * 4000);
      return {
        time: c.t,
        r: add(c.r, off),
        v: c.v,
        q: attitude(V(-off.x, -off.y, -off.z), c.rh),
        throttle: 0,
        cam: { mode: 'chase', yaw: 0, pitch: 0, distance: 1, lookAtId: null },
        guide: null,
        note: `sun ${(c.sun / DEG).toFixed(0)} deg, station at 4.0 km`,
      };
    }
    case 'burn': {
      const c = scan(WHEEL, 1, (k) => -angDiff(k.sun, sunAt(-40)));
      const off = add(add(V(), c.ph, -1900), add(V(0, 420, 0), c.rh, 160));
      return {
        time: c.t,
        r: add(c.r, off),
        v: c.v,
        q: attitude(c.ph, c.rh),
        throttle: 1,
        cam: { mode: 'chase', yaw: 26 * DEG, pitch: 10 * DEG, distance: 1, lookAtId: null },
        guide: null,
        note: `sun ${(c.sun / DEG).toFixed(0)} deg, throttle 100%`,
      };
    }
    case 'limb': {
      const a = sunAt(93);
      const s0 = sunDir(0);
      const sp = norm(V(s0.x, 0, s0.z));
      const qh = cross(NORTH, sp);
      const rh = norm(add(V(sp.x * Math.cos(a), 0, sp.z * Math.cos(a)), qh, -Math.sin(a)));
      const ph = cross(NORTH, rh);
      const rr = wick.radius + 260e3;
      const speed = Math.sqrt(wick.mu / rr);
      return {
        time: 0,
        r: V(rh.x * rr, rh.y * rr, rh.z * rr),
        v: V(ph.x * speed, ph.y * speed, ph.z * speed),
        q: attitude(ph, rh),
        throttle: 0,
        cam: { mode: 'chase', yaw: 0, pitch: 0, distance: 1, lookAtId: null },
        guide: null,
        note: `sun ${(a / DEG).toFixed(0)} deg, altitude 260 km`,
      };
    }
    case 'outpost': {
      const p = portWorld(LOCK, 'P2');
      // Wick behind the outpost (a little off-axis), day side toward us, star over our shoulder
      const c = scan(LOCK, 240, (k) => -2 * Math.abs(dot(k.rh, p.dir) - 0.86) - Math.abs(dot(k.sh, p.dir) - 0.55) - (dot(k.sh, k.rh) < 0.2 ? 1 : 0));
      const off = add(p.pos, p.dir, 130);
      return {
        time: c.t,
        r: add(c.r, off),
        v: c.v,
        q: attitude(V(-p.dir.x, -p.dir.y, -p.dir.z), p.up),
        throttle: 0,
        cam: { mode: 'dock', yaw: 0, pitch: 0, distance: 1, lookAtId: null },
        guide: { stationId: LOCK, portId: 'P2' },
        note: `sun ${(c.sun / DEG).toFixed(0)} deg, berth P2 at 130 m`,
      };
    }
  }
}

// ------------------------------------------------------------------------------------------------ stage

const canvas = document.createElement('canvas');
canvas.style.cssText = 'position:fixed;left:0;top:0;display:block';
document.body.appendChild(canvas);
const info = document.createElement('div');
info.style.cssText = 'position:fixed;left:8px;top:8px;right:8px;white-space:pre-wrap;font:10px/1.35 ui-monospace,Menlo,monospace;color:#bfe;text-shadow:0 0 3px #000,0 0 3px #000;pointer-events:none';
document.body.appendChild(info);
const showError = (e: unknown): void => {
  info.style.color = '#f88';
  info.textContent = `ERROR ${e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)}`;
  (window as unknown as { __ready: boolean }).__ready = true;
};
window.addEventListener('error', (e) => showError(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => showError(e.reason));

const pipeline = createPipeline(canvas, { quality, dynamicResolution: false });
pipeline.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio);
const scene = createSceneManager(pipeline, { quality, skyQuality: 'low' });

const setup = build();
if (has('cam')) setup.cam.mode = str('cam', 'chase') as CameraMode;
if (has('yaw')) setup.cam.yaw = num('yaw', 0) * DEG;
if (has('pitch')) setup.cam.pitch = num('pitch', 0) * DEG;
if (has('zoom')) setup.cam.distance = num('zoom', 1);
if (has('throttle')) setup.throttle = num('throttle', 0);

const frame = createSceneFrame();
let simTime = setup.time;
const shipState = newState();
function fill(dt: number): void {
  beginFrame(frame, simTime, dt, 1);
  const s = addShip(frame);
  s.id = 'player';
  s.visualId = 'wren';
  s.seed = 7;
  s.soiBodyId = WICK;
  // the Wren coasts on its Kepler orbit from the set-up state (attitude held inertially)
  propagateStateTo(shipState, setup, wick.mu, simTime - setup.time);
  s.r.x = shipState.r.x;
  s.r.y = shipState.r.y;
  s.r.z = shipState.r.z;
  s.v.x = shipState.v.x;
  s.v.y = shipState.v.y;
  s.v.z = shipState.v.z;
  s.q.x = setup.q.x;
  s.q.y = setup.q.y;
  s.q.z = setup.q.z;
  s.q.w = setup.q.w;
  s.throttle = setup.throttle;
  s.isPlayer = true;
  frame.camera.mode = setup.cam.mode;
  frame.camera.focusId = 'player';
  frame.camera.yaw = setup.cam.yaw;
  frame.camera.pitch = setup.cam.pitch;
  frame.camera.distance = setup.cam.distance;
  frame.camera.lookAtId = setup.cam.lookAtId;
  if (setup.guide) {
    addStationExtra(frame, setup.guide.stationId, setup.guide.portId);
    setDockingGuide(frame, setup.guide.stationId, shot === 'outpost' || setup.cam.mode === 'dock' ? setup.guide.portId : null);
  } else setDockingGuide(frame, null);
}

const proj: Projection = { x: 0, y: 0, visible: false, behind: false, distance: 0, radiusPx: 0, occluded: false };
function describe(ref: string): string {
  const p = scene.project(ref, proj);
  return `${ref.replace('tallow.', '').padEnd(20)} ${p.x.toFixed(0).padStart(5)},${p.y.toFixed(0).padStart(5)} r ${p.radiusPx.toFixed(0).padStart(5)}px ${(p.distance / 1000).toFixed(2)} km${p.visible ? '' : ' off'}${p.behind ? ' behind' : ''}${p.occluded ? ' occluded' : ''}`;
}
function report(extra: string): void {
  const st = scene.stats();
  const ps = pipeline.stats();
  info.textContent =
    `shot ${shot} · ${quality} · ${setup.note}${extra}\n` +
    `draw calls ${st.drawCalls} · triangles ${st.triangles} · ev ${scene.exposure.toFixed(2)} · cam ${scene.camera.mode} fov ${(scene.camera.fovY / DEG).toFixed(0)} · ${ps.outputWidth}x${ps.outputHeight}\n` +
    [WICK, WHEEL, LOCK, 'player'].map(describe).join('\n') +
    `\npick(centre) ${scene.pick(window.innerWidth / 2, window.innerHeight / 2) ?? '-'}`;
}

async function main(): Promise<void> {
  const t0 = performance.now();
  await scene.setSystem(system!, model, (f, label) => (info.textContent = `loading ${(f * 100).toFixed(0)}% ${label}`), { nearBodyId: WICK });
  const loadMs = performance.now() - t0;
  const frames = num('frames', 10);
  for (let i = 0; i < 80 && (i < frames || scene.busy()); i++) {
    const dt = i === 0 ? 0 : 1 / 30;
    if (advance) simTime += dt * warp;
    fill(dt);
    scene.render(frame);
    if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
  }
  if (num('cycle', 0) === 1) {
    // rebuild path (what a restored WebGL context or a quality change runs), then a few more frames
    await scene.rebuild();
    for (let i = 0; i < 80 && (i < 6 || scene.busy()); i++) {
      fill(1 / 30);
      scene.render(frame);
    }
  }
  report(` · load ${(loadMs / 1000).toFixed(1)} s`);
  (window as unknown as { __ready: boolean }).__ready = true;
  if (!live) return;
  let last = performance.now();
  const loop = (now: number): void => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    simTime += dt * warp;
    fill(dt);
    scene.render(frame);
    report('');
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
window.addEventListener('resize', () => pipeline.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio));
main().catch(showError);
