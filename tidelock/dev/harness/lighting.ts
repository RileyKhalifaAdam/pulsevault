// Visual harness for the lighting and image pipeline inside the Wren (src/render/probes.ts, scene.ts, pipeline.ts):
// the real session world, the player ship placed by hand over Wick so the star and the planet are where the view
// wants them, the 'interior' camera, and the numbers per tier.
//
//   dev/lighting.html?view=lounge
//
//   view   lounge     sun through the big starboard window onto the sofa and the floor
//          cockpit    seated at the helm, sun on the console through the windscreen
//          eclipse    the lounge view with the ship in Wick's shadow
//          window     at the lounge window looking out at the wing, an engine pod and Wick
//          corridor   in the corridor looking forward through the lounge door (room culling)
//          cargo      in the cargo bay looking forward
//          dark       the lounge view with the cabin lights off
//   sx sy sz            star direction override, ship-local      nx ny nz   planet (nadir) direction override
//   ex ey ez            eye override, ship-local m               yaw pitch  look override, deg
//   lights=0|1          cabin lights          q=low|medium|high|ultra      interior=proxy (default) | real
//   frames=N            frames to settle (default 40; auto exposure adapts over ~1 s of frame time)
//   rt=off|low|medium|high   ray-traced sunlight (default high, as the game)
//   turn=deg            head yaw per frame over the last `moving` frames (ghosting check)
//   spin=deg            ship yaw per frame over the last `moving` frames (the sun sweeps in ship space)
//   moving=N            frames of motion at the end (default 2)          settle=0  do not wait for the atlas / photo upgrade
//   rtdebug=1|2|3|4     forward debug view: traced visibility, bounce, reflections, reflection coverage
//   fx=SBR              tracer effects on/off: sun, bounce, reflections (e.g. fx=100)
//
// interior=proxy builds a stand-in from src/data/interiors.ts with MeshStandardMaterial walls, window and
// door openings, furniture boxes and userData.room tags (the contract of the interior being rebuilt), so the
// sun patches, room culling and probes can be inspected before the real one lands.
import * as THREE from 'three';
import type { V3 } from '../../src/core/types';
import { createPipeline, type Quality } from '../../src/render/pipeline';
import { createSceneManager } from '../../src/render/scene';
import { beginFrame, createSceneFrame } from '../../src/render/frame';
import { createSession } from '../../src/game';
import { INTERIORS, type Box, type InteriorLayout } from '../../src/data/interiors';
import type { CraftView } from '../../src/game/api';
import type { InteriorOptions, InteriorUpdate, InteriorVisual } from '../../src/render/space/interior';
import { renderInfoText } from '../../src/app/perf';
import type { RayTracer, RtQuality } from '../../src/render/rt';

const params = new URLSearchParams(location.search);
const has = (k: string): boolean => params.has(k) && params.get(k) !== '';
const num = (k: string, d: number): number => (has(k) ? Number(params.get(k)) : d);
const DEG = Math.PI / 180;
const view = params.get('view') ?? 'lounge';
const quality = (params.get('q') ?? 'medium') as Quality;
const useProxy = (params.get('interior') ?? 'real') === 'proxy';

document.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
const canvas = document.createElement('canvas');
canvas.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;display:block';
document.body.appendChild(canvas);
const info = document.createElement('pre');
info.style.cssText = 'position:fixed;left:6px;top:4px;margin:0;font:9px/1.25 monospace;color:#9fd;opacity:0.85;white-space:pre-wrap;pointer-events:none';
document.body.appendChild(info);
if (params.get('hud') === '0') info.style.visibility = 'hidden';
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
  /** Planet centre and star as seen from the ship (ship-local directions). */
  nadir: V3;
  sun: V3;
  lights: boolean;
}
const lounge: Preset = { eye: { x: -2.1, y: 0.62, z: -4.95 }, yaw: -52, pitch: -16, nadir: { x: 0.3, y: -0.9, z: 0.3 }, sun: { x: 0.8, y: 0.5, z: -0.15 }, lights: true };
// the sun high on the port side: through the skylight onto the red sofa, the planet low in the big window
const sunny: Preset = { ...lounge, nadir: { x: 0.6, y: -0.75, z: 0.2 }, sun: { x: -0.7, y: 0.7, z: 0.1 } };
const PRESETS: Record<string, Preset> = {
  lounge,
  cockpit: { eye: layout.helmEye, yaw: -6, pitch: -14, nadir: { x: 0, y: -0.857, z: -0.515 }, sun: { x: 0.25, y: 0.55, z: -0.8 }, lights: true },
  eclipse: { ...lounge, nadir: { x: 0.3, y: -0.9, z: 0.3 }, sun: { x: 0.25, y: -0.92, z: 0.3 } },
  window: { eye: { x: 1.3, y: 0.55, z: -6.6 }, yaw: -112, pitch: -24, nadir: { x: 0.5, y: -0.85, z: 0.1 }, sun: { x: -0.4, y: 0.6, z: -0.7 }, lights: true },
  corridor: { eye: { x: 0, y: 0.62, z: 2.2 }, yaw: 0, pitch: -4, nadir: { x: 0.3, y: -0.9, z: 0.3 }, sun: { x: 0.8, y: 0.5, z: -0.15 }, lights: true },
  cargo: { eye: { x: 0.4, y: 0.7, z: 9.3 }, yaw: 8, pitch: -10, nadir: { x: 0.3, y: -0.9, z: 0.3 }, sun: { x: 0.8, y: 0.5, z: -0.15 }, lights: true },
  aft: { eye: { x: 0, y: 0.62, z: -4.2 }, yaw: 180, pitch: -4, nadir: { x: 0.3, y: -0.9, z: 0.3 }, sun: { x: 0.8, y: 0.5, z: -0.15 }, lights: true },
  cabin: { eye: { x: 1.25, y: 0.62, z: -1.45 }, yaw: -27, pitch: -20, nadir: { x: 0.3, y: -0.9, z: 0.3 }, sun: { x: 0.8, y: 0.5, z: -0.15 }, lights: true },
  engineering: { eye: { x: 0, y: 0.62, z: 10.4 }, yaw: 180, pitch: -12, nadir: { x: 0.3, y: -0.9, z: 0.3 }, sun: { x: 0.8, y: 0.5, z: -0.15 }, lights: true },
  hero: { eye: layout.helmEye, yaw: 8, pitch: -6, nadir: { x: 0.2, y: -0.6, z: -0.77 }, sun: { x: 0.2, y: 0.85, z: 0.5 }, lights: true },
  dark: { ...lounge, lights: false },
  sunny,
  night: { ...sunny, sun: { x: 0.2, y: -0.95, z: 0.2 }, lights: true },
};
const preset = PRESETS[view] ?? lounge;
const eye: V3 = { x: num('ex', preset.eye.x), y: num('ey', preset.eye.y), z: num('ez', preset.eye.z) };
const lookYaw = num('yaw', preset.yaw) * DEG;
const lookPitch = num('pitch', preset.pitch) * DEG;
const lights = has('lights') ? num('lights', 1) === 1 : preset.lights;
const sunL: V3 = { x: num('sx', preset.sun.x), y: num('sy', preset.sun.y), z: num('sz', preset.sun.z) };
const nadirL: V3 = { x: num('nx', preset.nadir.x), y: num('ny', preset.nadir.y), z: num('nz', preset.nadir.z) };
const frames = num('frames', 40);
const rtTier = (params.get('rt') ?? 'high') as RtQuality;
const turnDeg = num('turn', 0);
const spinDeg = num('spin', 0);
const moving = num('moving', 2);
let spin = 0; // ship yaw added so far, rad
let headYaw = 0;

// ------------------------------------------------------------------------------------------- proxy interior

const lin = (r: number, g: number, b: number): THREE.Color => new THREE.Color().setRGB(r, g, b);
const WORK = new Set(['cockpit', 'suitroom', 'cargo', 'engineering']);
const LIVING = new Set(['lounge', 'cabin-port', 'cabin-stbd', 'washroom']);

function proxyInterior(lay: InteriorLayout, _opts: InteriorOptions): InteriorVisual {
  const root = new THREE.Group();
  root.name = 'interior:proxy';
  const std = (c: THREE.Color, rough: number, metal = 0, emissive?: THREE.Color): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ color: c, roughness: rough, metalness: metal });
    if (emissive) {
      m.emissive.copy(emissive);
      m.emissiveIntensity = 1;
    }
    return m;
  };
  const M = {
    white: std(lin(0.62, 0.62, 0.6), 0.42),
    warm: std(lin(0.32, 0.27, 0.22), 0.35, 0.0),
    brushed: std(lin(0.75, 0.6, 0.45), 0.32, 1.0),
    gunmetal: std(lin(0.32, 0.33, 0.35), 0.38, 1.0),
    floor: std(lin(0.045, 0.045, 0.05), 0.62),
    ceilW: std(lin(0.55, 0.55, 0.54), 0.5),
    ceilL: std(lin(0.25, 0.22, 0.19), 0.45),
    sofa: std(lin(0.22, 0.018, 0.016), 0.48),
    wood: std(lin(0.16, 0.075, 0.032), 0.35),
    console: std(lin(0.6, 0.6, 0.58), 0.3),
    seat: std(lin(0.035, 0.035, 0.038), 0.55),
    cargo: std(lin(0.12, 0.13, 0.12), 0.7),
    chrome: std(lin(0.9, 0.9, 0.9), 0.08, 1.0),
    warmLed: std(lin(0, 0, 0), 1, 0, lin(6, 3.9, 2.2)),
    coolLed: std(lin(0, 0, 0), 1, 0, lin(4.6, 5.0, 5.6)),
  };
  const ambient = new THREE.AmbientLight(lin(1.0, 0.9, 0.8), 0.32);
  root.add(ambient);
  let tris = 0;
  let calls = 0;

  type Rect = [number, number, number, number];
  const faceQuads = (pos: number[], idx: number[], plane: (u: number, v: number) => [number, number, number], n: [number, number, number], u0: number, u1: number, v0: number, v1: number, holes: Rect[]): void => {
    const us = [u0, u1];
    const vs = [v0, v1];
    for (const h of holes) {
      us.push(Math.min(u1, Math.max(u0, h[0])), Math.min(u1, Math.max(u0, h[1])));
      vs.push(Math.min(v1, Math.max(v0, h[2])), Math.min(v1, Math.max(v0, h[3])));
    }
    const su = [...new Set(us)].sort((a, b) => a - b);
    const sv = [...new Set(vs)].sort((a, b) => a - b);
    for (let i = 0; i + 1 < su.length; i++)
      for (let j = 0; j + 1 < sv.length; j++) {
        const cu = (su[i] + su[i + 1]) / 2;
        const cv = (sv[j] + sv[j + 1]) / 2;
        if (holes.some((h) => cu > h[0] && cu < h[1] && cv > h[2] && cv < h[3])) continue;
        const a = plane(su[i], sv[j]);
        const b = plane(su[i + 1], sv[j]);
        const c = plane(su[i + 1], sv[j + 1]);
        const d = plane(su[i], sv[j + 1]);
        const base = pos.length / 3;
        pos.push(...a, ...b, ...c, ...d);
        // winding so the front face looks along the inward normal n
        const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        if (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] >= 0) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        else idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
      }
  };

  for (const room of lay.rooms) {
    const g = new THREE.Group();
    g.name = `room:${room.id}`;
    g.userData.room = room.id;
    root.add(g);
    const b = room.box;
    const work = WORK.has(room.id);
    const living = LIVING.has(room.id);
    const wallMat = work ? M.white : living ? M.warm : M.brushed;
    const ceilMat = work ? M.ceilW : M.ceilL;
    // three surfaces: walls, floor, ceiling (one mesh, three groups)
    const pos: number[] = [];
    const walls: number[] = [];
    const floor: number[] = [];
    const ceil: number[] = [];
    const winHoles = (wall: string): Rect[] =>
      lay.windows
        .filter((w) => w.room === room.id && w.wall === wall)
        .map((w): Rect => {
          const cu = wall === '+x' || wall === '-x' ? w.center.z : w.center.x;
          const cv = wall === '+y' ? w.center.z : w.center.y;
          return [cu - w.width / 2, cu + w.width / 2, cv - w.height / 2, cv + w.height / 2];
        });
    const doorHoles = (axis: 'x' | 'z', at: number): Rect[] =>
      lay.doors
        .filter((d) => (d.a === room.id || d.b === room.id) && d.box.min[axis] - 1e-3 <= at && d.box.max[axis] + 1e-3 >= at)
        .map((d): Rect => (axis === 'x' ? [d.box.min.z, d.box.max.z, d.box.min.y, d.box.max.y] : [d.box.min.x, d.box.max.x, d.box.min.y, d.box.max.y]));
    faceQuads(pos, walls, (u, v) => [b.min.x, v, u], [1, 0, 0], b.min.z, b.max.z, b.min.y, b.max.y, [...winHoles('-x'), ...doorHoles('x', b.min.x)]);
    faceQuads(pos, walls, (u, v) => [b.max.x, v, u], [-1, 0, 0], b.min.z, b.max.z, b.min.y, b.max.y, [...winHoles('+x'), ...doorHoles('x', b.max.x)]);
    faceQuads(pos, walls, (u, v) => [u, v, b.min.z], [0, 0, 1], b.min.x, b.max.x, b.min.y, b.max.y, [...winHoles('-z'), ...doorHoles('z', b.min.z)]);
    faceQuads(pos, walls, (u, v) => [u, v, b.max.z], [0, 0, -1], b.min.x, b.max.x, b.min.y, b.max.y, [...winHoles('+z'), ...doorHoles('z', b.max.z)]);
    faceQuads(pos, floor, (u, v) => [u, b.min.y, v], [0, 1, 0], b.min.x, b.max.x, b.min.z, b.max.z, []);
    faceQuads(pos, ceil, (u, v) => [u, b.max.y, v], [0, -1, 0], b.min.x, b.max.x, b.min.z, b.max.z, winHoles('+y'));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex([...walls, ...floor, ...ceil]);
    geo.addGroup(0, walls.length, 0);
    geo.addGroup(walls.length, floor.length, 1);
    geo.addGroup(walls.length + floor.length, ceil.length, 2);
    geo.computeVertexNormals();
    const shell = new THREE.Mesh(geo, [wallMat, M.floor, ceilMat]);
    shell.castShadow = shell.receiveShadow = true;
    g.add(shell);
    tris += (walls.length + floor.length + ceil.length) / 3;
    calls += 3;
    // gunmetal ribs every ~0.6 m (work) / 1.2 m (corridor rings) across the walls and ceiling
    const ribStep = room.id === 'corridor' ? 1.2 : work ? 0.6 : 0;
    if (ribStep > 0) {
      const n = Math.floor((b.max.z - b.min.z) / ribStep);
      const rib = new THREE.BoxGeometry(1, 1, 1);
      const inst = new THREE.InstancedMesh(rib, M.gunmetal, n * 3);
      const mm = new THREE.Matrix4();
      let k = 0;
      for (let i = 1; i <= n; i++) {
        const z = b.min.z + i * ribStep - ribStep / 2;
        mm.compose(new THREE.Vector3(b.min.x + 0.04, (b.min.y + b.max.y) / 2, z), new THREE.Quaternion(), new THREE.Vector3(0.08, b.max.y - b.min.y, 0.09));
        inst.setMatrixAt(k++, mm);
        mm.compose(new THREE.Vector3(b.max.x - 0.04, (b.min.y + b.max.y) / 2, z), new THREE.Quaternion(), new THREE.Vector3(0.08, b.max.y - b.min.y, 0.09));
        inst.setMatrixAt(k++, mm);
        mm.compose(new THREE.Vector3((b.min.x + b.max.x) / 2, b.max.y - 0.04, z), new THREE.Quaternion(), new THREE.Vector3(b.max.x - b.min.x, 0.08, 0.09));
        inst.setMatrixAt(k++, mm);
      }
      inst.count = k;
      inst.castShadow = inst.receiveShadow = true;
      g.add(inst);
      tris += k * 12;
      calls++;
    }
    // a ceiling light line
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.02, Math.max(0.3, (b.max.z - b.min.z) * 0.7)), work ? M.coolLed : M.warmLed);
    strip.position.set((b.min.x + b.max.x) / 2 + (room.id === 'lounge' ? -1.4 : 0), b.max.y - 0.012, (b.min.z + b.max.z) / 2);
    g.add(strip);
    tris += 12;
    calls++;
  }
  // furniture
  const kindMat = (kind: string, room: string): THREE.Material => {
    if (kind === 'sofa') return M.sofa;
    if (kind === 'table' || kind === 'workbench') return room === 'lounge' || room.startsWith('cabin') ? M.wood : M.gunmetal;
    if (kind === 'console') return M.console;
    if (kind === 'seat') return M.seat;
    if (kind === 'bunk') return M.sofa;
    if (kind === 'rack') return M.cargo;
    if (kind === 'machinery') return M.gunmetal;
    if (kind === 'fixture') return M.chrome;
    if (kind === 'counter' || kind === 'cabinet') return M.brushed;
    return M.white;
  };
  const roomGroup = new Map(root.children.filter((c) => c.userData.room).map((c) => [c.userData.room as string, c]));
  for (const s of lay.solids) {
    const b: Box = s.box;
    const m = new THREE.Mesh(new THREE.BoxGeometry(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z), kindMat(s.kind, s.room));
    m.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
    m.castShadow = m.receiveShadow = true;
    (roomGroup.get(s.room) ?? root).add(m);
    tris += 12;
    calls++;
  }
  return {
    object3d: root,
    update(o: InteriorUpdate): void {
      ambient.intensity = o.lights ? 0.32 : 0.02;
      M.warmLed.emissiveIntensity = M.coolLed.emissiveIntensity = o.lights ? 1 : 0.02;
    },
    dispose(): void {
      root.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      for (const m of Object.values(M)) m.dispose();
      root.removeFromParent();
    },
    triangles: tris,
    drawCalls: calls,
    rooms: Object.fromEntries(roomGroup) as unknown as Record<string, THREE.Group>,
    visibleRooms: new Set(roomGroup.keys()),
    textureBytes: 0,
    ready: Promise.resolve(false),
  };
}

// ------------------------------------------------------------------------------------------- the world

const pipeline = createPipeline(canvas, { quality, dynamicResolution: false });
pipeline.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio);
const scene = createSceneManager(pipeline, { quality, skyQuality: 'low', interiorFactory: useProxy ? proxyInterior : undefined });
const session = createSession({ seed: 1 });
const frame = createSceneFrame();
(window as unknown as { __scene: unknown }).__scene = scene;
const v = (a: V3): THREE.Vector3 => new THREE.Vector3(a.x, a.y, a.z);

/** The session's craft with the player ship moved over Wick and turned so the planet and the star sit where wanted. */
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
  const nl = v(nadirL).normalize();
  const sl = v(sunL).normalize();
  const a = Math.PI - Math.acos(Math.max(-1, Math.min(1, nl.dot(sl))));
  const up = sunDir.clone().multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a)).normalize();
  const r = pc.clone().addScaledVector(up, dist);
  const frameOf = (e1: THREE.Vector3, s: THREE.Vector3): THREE.Matrix4 => {
    const e2 = s.clone().addScaledVector(e1, -s.dot(e1)).normalize();
    return new THREE.Matrix4().makeBasis(e1, e2, new THREE.Vector3().crossVectors(e1, e2));
  };
  const rot = frameOf(up.clone().negate(), sunDir).multiply(frameOf(nl, sl).transpose());
  if (spin !== 0) rot.multiply(new THREE.Matrix4().makeRotationY(spin));
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
  frame.camera.lookYaw = lookYaw + headYaw;
  frame.camera.lookPitch = lookPitch;
  frame.camera.lookAtId = null;
  frame.cabinLights = lights;
}

async function main(): Promise<void> {
  const t0 = performance.now();
  scene.setRayTracing(rtTier);
  // fx=SBR: per-effect switches of the tracer (sun, bounce, reflections), e.g. fx=100 for the sun alone
  const fxp = params.get('fx');
  const dbg = num('rtdebug', 0);
  if (dbg) (scene as unknown as { rt: RayTracer }).rt.debugView = dbg;
  if (fxp && fxp.length >= 3) {
    const tr = (scene as unknown as { rt: RayTracer }).rt;
    tr.effects.sun = fxp[0] === '1';
    tr.effects.bounce = fxp[1] === '1';
    tr.effects.reflections = fxp[2] === '1';
  }
  await scene.setSystem(session.system, (f, label) => (info.textContent = `loading ${(f * 100).toFixed(0)}% ${label}`), { nearBodyId: session.flight().primaryId });
  const t1 = performance.now();
  // the interior's full-size atlas and photo scans arrive over frames: wait for them so views compare like for like
  const upgrading = (): boolean => /upgrading|pending/.test((globalThis as { __tlInterior?: string }).__tlInterior ?? '');
  const settle = num('settle', 1) === 1;
  for (let i = 0; i < frames || (i < 120 && scene.busy()) || (settle && i < 400 && upgrading()); i++) {
    fill(1 / 30);
    scene.render(frame);
    if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
  }
  // then the motion frames (ghosting checks): the head or the ship turning, the last frame is the shot
  for (let k = 0; k < (turnDeg || spinDeg ? moving : 0); k++) {
    spin += spinDeg * DEG;
    headYaw += turnDeg * DEG;
    fill(1 / 30);
    scene.render(frame);
  }
  const st = scene.stats();
  const ps = pipeline.stats();
  const li = st.lighting;
  const mb = (b: number): string => (b / 1048576).toFixed(1);
  const rti = scene.rayTracing();
  info.textContent =
    `lighting ${view} · ${quality} · ${useProxy ? 'proxy' : 'real'} interior · lights ${lights ? 'on' : 'off'} · cam ${scene.camera.mode} fov ${(scene.camera.fovY / DEG).toFixed(0)}\n` +
    `frame: draw calls ${st.drawCalls} · triangles ${st.triangles} · msaa ${ps.msaa} · auto exposure ${ps.autoExposure ? 'on' : 'off'} · ${ps.width}x${ps.height}\n` +
    (li ? `rooms ${li.rooms}/${li.roomsTotal} from ${li.room || '-'} · lighting draws ${li.drawCalls} · probes ${mb(li.probeBytes)} MB · shadows ${mb(li.shadowBytes)} MB\n` : 'no interior lighting\n') +
    `textures ${mb(st.textureBytes)} MB · targets ${mb(st.targetBytes)} MB · programs ${pipeline.renderer.info.programs?.length ?? 0} · load ${((t1 - t0) / 1000).toFixed(1)} s\n` +
    `${(globalThis as { __tlInterior?: string }).__tlInterior ?? ''}\n` +
    `load: ${(globalThis as { __tlLoad?: string }).__tlLoad ?? ''}\n` +
    `rt ${rti.tier} active ${rti.active} · BVH ${rti.triangles} tris ${rti.buildMs.toFixed(0)} ms · ${mb(rti.bytes)} MB · ${(rti.rays / 1e6).toFixed(2)}M rays · est ${rti.msEstimate.toFixed(1)} ms${rti.disabled ? ` · ${rti.disabled}` : ''}${turnDeg || spinDeg ? ` · moving: head ${turnDeg}°/f ship ${spinDeg}°/f over ${moving} f` : ''}\n` +
    `gpu memory: textures ${mb(st.textureBytes)} + targets ${mb(st.targetBytes)} + rt ${mb(st.rtBytes)} = ${mb(st.textureBytes + st.targetBytes + st.rtBytes)} MB\n` +
    renderInfoText();
  ready();
}
window.addEventListener('resize', () => pipeline.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio));
main().catch(showError);
