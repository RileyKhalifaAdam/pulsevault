// Visual harness for the physical cockpit (src/render/space/cockpit.ts + instruments.ts, src/data/cockpit.ts):
// the real session world, the pilot seated at the helm of the Wren, the frame filled by hand.
//
//   dev/cockpit.html?pitch=-22
//
//   yaw pitch          look, deg (default 0, -22: the seated view)      zoom  lean-in factor 1..3
//   ex ey ez           eye override, ship-local m (default: the helm eye)
//   d=id:x:y,id:x      deflect devices (stick x,y -1..1; lever 0..1; rocker -1|1; toggle/handle 0|1)
//   lit=id,id          lamps lit            held=id,id   hand on these
//   page=orbit|docking|systems              NAV page     demo=1  plausible docking numbers on that page
//   lights=0|1         cabin lights         q  low (default) | medium | high | ultra
//   grid=1             overlay what scene.pickDevice() finds under a grid of touches (one colour per device)
//   pick=x,y           print the pick at that CSS pixel
import * as THREE from 'three';
import type { V3 } from '../../src/core/types';
import { createPipeline, type Quality } from '../../src/render/pipeline';
import { createSceneManager } from '../../src/render/scene';
import { beginFrame, createSceneFrame } from '../../src/render/frame';
import { createSession } from '../../src/game';
import { INTERIORS } from '../../src/data/interiors';
import { COCKPITS } from '../../src/data/cockpit';
import { createInstrumentData, readInstruments } from '../../src/render/space/instruments';
import type { CraftView, DeviceView } from '../../src/game/api';

const params = new URLSearchParams(location.search);
const has = (k: string): boolean => params.has(k) && params.get(k) !== '';
const num = (k: string, d: number): number => (has(k) ? Number(params.get(k)) : d);
const DEG = Math.PI / 180;
const quality = (params.get('q') ?? 'low') as Quality;

document.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
const canvas = document.createElement('canvas');
canvas.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;display:block';
document.body.appendChild(canvas);
const overlay = document.createElement('canvas');
overlay.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none';
document.body.appendChild(overlay);
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

const interior = INTERIORS.wren;
const layoutMaybe = COCKPITS.wren;
if (!interior || !layoutMaybe) throw new Error('no Wren interior / cockpit');
const layout = layoutMaybe;
const eye: V3 = { x: num('ex', interior.helmEye.x), y: num('ey', interior.helmEye.y), z: num('ez', interior.helmEye.z) };
const lookYaw = num('yaw', 0) * DEG;
const lookPitch = num('pitch', -22) * DEG;
const zoom = num('zoom', 1);
const lights = num('lights', 1) === 1;
const page = params.get('page') ?? 'orbit';

// the devices, at rest unless the parameters say otherwise
const litIds = new Set((params.get('lit') ?? 'hold-pro').split(',').filter(Boolean));
const heldIds = new Set((params.get('held') ?? '').split(',').filter(Boolean));
const defl = new Map<string, [number, number]>();
for (const part of (params.get('d') ?? '').split(',').filter(Boolean)) {
  const [id, x, y] = part.split(':');
  defl.set(id, [Number(x ?? 0) || 0, Number(y ?? 0) || 0]);
}
const devices: DeviceView[] = layout.devices.map((d) => ({
  id: d.id,
  x: defl.get(d.id)?.[0] ?? 0,
  y: defl.get(d.id)?.[1] ?? 0,
  lit: litIds.has(d.id) || (d.role === 'driveArm' && (defl.get(d.id)?.[0] ?? 0) > 0.5) || d.role === 'harness' || (d.role === 'cabinLights' && lights),
  held: heldIds.has(d.id),
  reachable: d.reach === 'pilotSeat' || d.role === 'harness',
  page: d.kind === 'screen' ? (d.pages && d.pages.includes(page) ? page : (d.pages?.[0] ?? '')) : '',
}));

const pipeline = createPipeline(canvas, { quality });
pipeline.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio);
const scene = createSceneManager(pipeline, { quality });
const session = createSession({ seed: 1 });
const frame = createSceneFrame();
const data = createInstrumentData();

const v = (a: V3): THREE.Vector3 => new THREE.Vector3(a.x, a.y, a.z);
const NADIR = v({ x: 0, y: -0.857, z: -0.515 }).normalize();
const SUN = v({ x: 0.45, y: 0.6, z: -0.66 }).normalize();

/** The session's craft with the player ship turned so the planet's limb crosses the windscreen. */
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
  const a = Math.PI - Math.acos(Math.max(-1, Math.min(1, NADIR.dot(SUN))));
  const up = sunDir.clone().multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a)).normalize();
  const r = pc.clone().addScaledVector(up, dist);
  const frameOf = (e1: THREE.Vector3, s: THREE.Vector3): THREE.Matrix4 => {
    const e2 = s.clone().addScaledVector(e1, -s.dot(e1)).normalize();
    return new THREE.Matrix4().makeBasis(e1, e2, new THREE.Vector3().crossVectors(e1, e2));
  };
  const rot = frameOf(up.clone().negate(), sunDir).multiply(frameOf(NADIR, SUN).transpose());
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
  frame.camera.zoom = zoom;
  frame.cabinLights = lights;
  frame.devices = devices;
  readInstruments(session, data, devices, layout);
  const thr = devices.find((d) => d.id === 'throttle');
  if (thr && data.flight.armed) data.flight.throttle = thr.x;
  data.systems.cabinLights = lights;
  if (num('demo', 0) === 1) {
    Object.assign(data.docking, { name: "Chandler's Wheel", hasPort: true, range: 12.4, closing: 0.18, lateralX: 0.6, lateralY: -0.35, lateral: 0.69, alignment: 0.06, canLatch: num('latch', 0) === 1, docked: false });
    Object.assign(data.systems, { asleep: true, warp: 8400, warpLimit: 'rotation', heat: 0.42, hull: 0.86 });
  }
  frame.instruments = data;
}

function hue(id: string): string {
  let h = 7;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${(h * 47) % 360} 90% 60%)`;
}

async function main(): Promise<void> {
  await scene.setSystem(session.system, (f, label) => (info.textContent = `loading ${(f * 100).toFixed(0)}% ${label}`), { nearBodyId: session.flight().primaryId });
  session.step(1 / 60);
  for (let i = 0; i < 60 && (i < 14 || scene.busy()); i++) {
    fill(1 / 30);
    scene.render(frame);
    if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
  }
  const st = scene.stats();
  let extra = '';
  if (has('pick')) {
    const [px, py] = (params.get('pick') ?? '').split(',').map(Number);
    const hit = scene.pickDevice(px, py);
    extra = `\npick ${px},${py}: ${hit ? `${hit.id} x ${hit.x.toFixed(2)} y ${hit.y.toFixed(2)}` : 'nothing'}`;
  }
  if (num('grid', 0) === 1) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    overlay.width = w;
    overlay.height = h;
    const c = overlay.getContext('2d') as CanvasRenderingContext2D;
    const seen = new Set<string>();
    for (let y = 5; y < h; y += 10) {
      for (let x = 5; x < w; x += 10) {
        const hit = scene.pickDevice(x, y);
        if (!hit) continue;
        seen.add(hit.id);
        c.fillStyle = hue(hit.id);
        c.fillRect(x - 1.5, y - 1.5, 3, 3);
      }
    }
    extra += `\npicked: ${[...seen].join(' ')}\nnever picked: ${layout.devices.filter((d) => !seen.has(d.id)).map((d) => d.id).join(' ')}`;
  }
  info.textContent =
    `cockpit · ${quality} · look ${(lookYaw / DEG).toFixed(0)} / ${(lookPitch / DEG).toFixed(0)} · zoom ${zoom} · fov ${(scene.camera.fovY / DEG).toFixed(0)} · lights ${lights ? 'on' : 'off'}\n` +
    `frame: draw calls ${st.drawCalls} · triangles ${st.triangles}\n` +
    `interior: ${st.interior?.drawCalls ?? '-'} dc · ${st.interior?.triangles ?? '-'} tris   cockpit: ${st.cockpit?.drawCalls ?? '-'} dc · ${st.cockpit?.triangles ?? '-'} tris${extra}`;
  ready();
}
window.addEventListener('resize', () => pipeline.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio));
main().catch(showError);
