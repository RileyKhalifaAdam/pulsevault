// Visual harness for the Wren's interior (src/render/space/interior.ts + the 'interior' camera of scene.ts):
// the real session world, the player ship placed by hand over Wick's day side, the frame filled by hand.
//
//   dev/interior.html?view=lounge&q=high
//
//   view   lounge       from the companionway door: galley, sofa, the big window
//          sofa         seated on the sofa, looking across the lounge
//          corridor     the octagonal corridor looking aft to the cargo door
//          cabin        the port cabin from its door
//          cargo        the cargo bay from the corridor door
//          engineering  engineering, the reactor and the coolant loop
//          cockpit      seated at the helm
//          night        the lounge view with the cabin lights off
//   ex ey ez            eye override, ship-local m          yaw pitch   look override, deg
//   (each view also fixes where the planet and the star are as seen from the ship; the ship is placed to match)
//   lights=0|1          cabin lights                        q  low (default) | medium | high | ultra
import * as THREE from 'three';
import type { V3 } from '../../src/core/types';
import { createPipeline, type Quality } from '../../src/render/pipeline';
import { createSceneManager } from '../../src/render/scene';
import { beginFrame, createSceneFrame } from '../../src/render/frame';
import { createSession } from '../../src/game';
import { INTERIORS } from '../../src/data/interiors';
import type { CraftView } from '../../src/game/api';

const params = new URLSearchParams(location.search);
const has = (k: string): boolean => params.has(k) && params.get(k) !== '';
const num = (k: string, d: number): number => (has(k) ? Number(params.get(k)) : d);
const DEG = Math.PI / 180;
const view = params.get('view') ?? 'lounge';
const quality = (params.get('q') ?? 'medium') as Quality;

document.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
const canvas = document.createElement('canvas');
canvas.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;display:block';
document.body.appendChild(canvas);
const info = document.createElement('pre');
info.style.cssText = 'position:fixed;left:6px;top:4px;margin:0;font:9px/1.25 monospace;color:#9fd;opacity:0.85;white-space:pre-wrap;pointer-events:none';
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

const layout = INTERIORS.wren;
if (!layout) throw new Error('no Wren interior');
interface Preset {
  eye: V3;
  yaw: number;
  pitch: number;
  /** Where the planet's centre and the star are, as seen from the ship (ship-local directions). */
  nadir: V3;
  sun: V3;
  lights: boolean;
}
const day = { nadir: { x: 0.85, y: -0.45, z: 0.25 }, sun: { x: -0.5, y: 0.7, z: -0.5 } };
const lounge: Preset = { eye: { x: 0.25, y: 0.62, z: -10.3 }, yaw: 172, pitch: -14, ...day, lights: true };
const PRESETS: Record<string, Preset> = {
  lounge,
  sofa: { eye: layout.tableEye, yaw: 78, pitch: -9, nadir: { x: 0.6, y: -0.75, z: 0.3 }, sun: { x: -0.6, y: 0.6, z: -0.5 }, lights: true },
  corridor: { eye: { x: 0.1, y: 0.62, z: -4.35 }, yaw: 180, pitch: -4, ...day, lights: true },
  cabin: { eye: { x: -1.05, y: 0.6, z: -1.35 }, yaw: 38, pitch: -16, ...day, lights: true },
  cargo: { eye: { x: 0.0, y: 0.62, z: 3.3 }, yaw: 180, pitch: -10, ...day, lights: true },
  engineering: { eye: { x: 0.9, y: 0.62, z: 10.25 }, yaw: 200, pitch: -8, ...day, lights: true },
  cockpit: { eye: layout.helmEye, yaw: -6, pitch: -12, nadir: { x: 0, y: -0.857, z: -0.515 }, sun: { x: 0.45, y: 0.6, z: -0.66 }, lights: true },
  night: { ...lounge, lights: false },
};
const preset = PRESETS[view] ?? PRESETS.lounge;
const eye: V3 = { x: num('ex', preset.eye.x), y: num('ey', preset.eye.y), z: num('ez', preset.eye.z) };
const lookYaw = num('yaw', preset.yaw) * DEG;
const lookPitch = num('pitch', preset.pitch) * DEG;
const lights = has('lights') ? num('lights', 1) === 1 : preset.lights;

const pipeline = createPipeline(canvas, { quality });
pipeline.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio);
const scene = createSceneManager(pipeline, { quality });
const session = createSession({ seed: 1 });
const frame = createSceneFrame();

const v = (a: V3): THREE.Vector3 => new THREE.Vector3(a.x, a.y, a.z);
let dipDeg = 0;

/** The session's craft with the player ship moved over Wick's day side and turned by hand. */
function craftViews(): { craft: CraftView[]; playerId: string } {
  const bodies = session.bodies();
  const craft = session.craft();
  const player = craft.find((c) => c.isPlayer) ?? craft[0];
  const primary = bodies.find((b) => b.id === session.flight().primaryId) ?? bodies[0];
  const star = bodies.find((b) => b.def.kind === 'star' || b.def.cls === 'star') ?? bodies[0];
  const pc = v(primary.r);
  const dist = Math.max(v(player.r).sub(pc).length(), primary.def.radius * 1.03);
  const sunDir = v(star.r).sub(pc).normalize();
  const side = new THREE.Vector3().crossVectors(sunDir, new THREE.Vector3(0, 1, 0));
  if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
  side.normalize();
  // attitude and place from where the preset wants the planet and the star to be, seen from the ship
  const nl = v(preset.nadir).normalize();
  const sl = v(preset.sun).normalize();
  const a = Math.PI - Math.acos(Math.max(-1, Math.min(1, nl.dot(sl)))); // angle from the sub-solar point
  const up = sunDir.clone().multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a)).normalize();
  const r = pc.clone().addScaledVector(up, dist);
  dipDeg = Math.acos(Math.min(1, primary.def.radius / dist)) / DEG;
  const frameOf = (e1: THREE.Vector3, s: THREE.Vector3): THREE.Matrix4 => {
    const e2 = s.clone().addScaledVector(e1, -s.dot(e1)).normalize();
    return new THREE.Matrix4().makeBasis(e1, e2, new THREE.Vector3().crossVectors(e1, e2));
  };
  const rot = frameOf(up.clone().negate(), sunDir).multiply(frameOf(nl, sl).transpose());
  const q = new THREE.Quaternion().setFromRotationMatrix(rot);
  const moved: CraftView = { ...player, r: { x: r.x, y: r.y, z: r.z }, v: { ...primary.v }, q: { x: q.x, y: q.y, z: q.z, w: q.w }, throttle: 0 };
  return { craft: craft.map((c) => (c === player ? moved : c)), playerId: player.id };
}

function fill(dt: number): void {
  beginFrame(frame, session.time(), dt, 1);
  const cv = craftViews();
  frame.bodies = session.bodies();
  frame.craft = cv.craft;
  frame.camera.mode = 'interior';
  frame.camera.focusId = cv.playerId;
  frame.camera.eye.x = eye.x;
  frame.camera.eye.y = eye.y;
  frame.camera.eye.z = eye.z;
  frame.camera.lookYaw = lookYaw;
  frame.camera.lookPitch = lookPitch;
  frame.camera.lookAtId = null;
  frame.cabinLights = lights;
}

async function main(): Promise<void> {
  const t0 = performance.now();
  await scene.setSystem(session.system, (f, label) => (info.textContent = `loading ${(f * 100).toFixed(0)}% ${label}`), { nearBodyId: session.flight().primaryId });
  const t1 = performance.now();
  fill(0);
  scene.render(frame);
  const t2 = performance.now();
  for (let i = 0; i < 80 && (i < 12 || scene.busy()); i++) {
    fill(1 / 30);
    scene.render(frame);
    if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
  }
  const st = scene.stats();
  info.textContent =
    `view ${view} · ${quality} · lights ${lights ? 'on' : 'off'} · cam ${scene.camera.mode} fov ${(scene.camera.fovY / DEG).toFixed(0)} · ev ${scene.exposure.toFixed(2)} · limb dip ${dipDeg.toFixed(0)}°\n` +
    `frame: draw calls ${st.drawCalls} · triangles ${st.triangles}\n` +
    `interior: draw calls ${st.interior?.drawCalls ?? '-'} · triangles ${st.interior?.triangles ?? '-'} · system ${((t1 - t0) / 1000).toFixed(1)} s · first frame (interior build) ${((t2 - t1) / 1000).toFixed(2)} s`;
  ready();
}
window.addEventListener('resize', () => pipeline.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio));
main().catch(showError);
