// Visual harness for the hybrid ray tracer (src/render/rt): the Wren interior and cockpit as they are on disk
// plus the hull (BVH only, front-face-only so wings and nose shadow the windows), a sun that throws a patch
// through a window, every tier and effect toggle, and a side-by-side RT off | RT on.
//
//   dev/rt.html?view=lounge&q=medium&split=1&frames=24
//
//   view    lounge (default: starboard window + skylight) | cockpit | cabin
//   q       off | low | medium | high | ultra                split=1   left RT off (the forward shader's own
//   sun bounce refl ao = 0|1  per-effect switches                      sun), right RT on
//   frames  frames accumulated before the shot (default 24)   turn=deg  yaw turned per frame over the last 6 frames
//   debug   0 final | 1 visibility | 2 bounce | 3 reflections | 4 AO | 5 sun direct
//   res     render scale of the whole page (default 1)       ev  exposure stops (default 0)
//   sx sy sz  sun direction override (ship-local)           hull=0  leave the hull out of the BVH
import * as THREE from 'three';
import { INTERIORS } from '../../src/data/interiors';
import { COCKPITS } from '../../src/data/cockpit';
import { createInteriorVisual } from '../../src/render/space/interior';
import { createCockpitVisual } from '../../src/render/space/cockpit';
import { buildShipModel } from '../../src/render/space/ships';
import { createRayTracer, type RtQuality } from '../../src/render/rt';

const params = new URLSearchParams(location.search);
const has = (k: string): boolean => params.has(k) && params.get(k) !== '';
const num = (k: string, d: number): number => (has(k) ? Number(params.get(k)) : d);
const DEG = Math.PI / 180;
const view = params.get('view') ?? 'lounge';
const tier = (params.get('q') ?? 'medium') as RtQuality;
const split = num('split', 0) === 1;
const frames = Math.max(1, num('frames', 24));
const turn = num('turn', 0);
const res = num('res', 1);

document.documentElement.style.cssText = 'height:100%';
document.body.style.cssText = 'margin:0;height:100%;background:#000;overflow:hidden';
const canvas = document.createElement('canvas');
canvas.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;display:block;touch-action:none';
document.body.appendChild(canvas);
const info = document.createElement('pre');
info.style.cssText = 'position:fixed;left:6px;top:4px;margin:0;font:9px/1.25 monospace;color:#9fd;opacity:0.9;white-space:pre-wrap;pointer-events:none;text-shadow:0 0 2px #000';
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

interface Preset {
  eye: [number, number, number];
  yaw: number;
  pitch: number;
  sun: [number, number, number];
}
const PRESETS: Record<string, Preset> = {
  lounge: { eye: [-1.5, 0.6, -5.0], yaw: -34, pitch: -24, sun: [0.9, 0.33, 0.1] },
  cockpit: { eye: [-0.55, 0.25, -13.45], yaw: -8, pitch: -22, sun: [0.25, 0.75, -0.6] },
  cabin: { eye: [1.2, 0.4, -1.6], yaw: -125, pitch: -25, sun: [0.75, 0.35, 0.2] },
};
const preset = PRESETS[view] ?? PRESETS.lounge;
const sunDir = new THREE.Vector3(num('sx', preset.sun[0]), num('sy', preset.sun[1]), num('sz', preset.sun[2])).normalize();
// a sun-like star at 1 AU: angular radius 0.267 deg
const sunAng = Math.asin(6.957e8 / 1.496e11);
// radiance on a white diffuse surface in the interior shader's units, and its x3 lift (interior.ts FRAG);
// the tracer takes three.js irradiance: E = pi * level * 3
const sunLevel = new THREE.Color(1.0, 0.93, 0.84).multiplyScalar(1.6);

async function main(): Promise<void> {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  const dpr = Math.min(2, window.devicePixelRatio) * res;
  renderer.setPixelRatio(dpr);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  // split: both halves show the same view (each rendered at half width)
  const W = Math.max(1, Math.round((window.innerWidth * dpr) / (split ? 2 : 1)));
  const H = Math.max(1, Math.round(window.innerHeight * dpr));
  const t0 = performance.now();

  const layout = INTERIORS.wren!;
  const interior = createInteriorVisual(layout, { quality: 'low' });
  const cockpit = COCKPITS.wren ? createCockpitVisual(COCKPITS.wren, { quality: 'low' }) : null;
  const inside = new THREE.Scene();
  inside.add(interior.object3d);
  if (cockpit) inside.add(cockpit.object3d);
  // outside: the hull, lit by the sun, over a dark sky
  const outside = new THREE.Scene();
  outside.background = new THREE.Color(0.004, 0.006, 0.012);
  const model = buildShipModel('wren', 0);
  const hullGeo = model.geometries[0];
  const hullMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.55, metalness: 0.3 });
  const hull = hullGeo ? new THREE.Mesh(hullGeo, hullMat) : null;
  if (hull) outside.add(hull);
  const key = new THREE.DirectionalLight(0xfff0dd, Math.PI * 1.6);
  key.position.copy(sunDir);
  outside.add(key, new THREE.AmbientLight(0x406080, 0.15));

  const camera = new THREE.PerspectiveCamera(85, W / H, 0.05, 2000);
  const yaw0 = num('yaw', preset.yaw) * DEG;
  const pitch = num('pitch', preset.pitch) * DEG;
  camera.position.set(num('ex', preset.eye[0]), num('ey', preset.eye[1]), num('ez', preset.eye[2]));
  const aim = (yaw: number): void => {
    camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    camera.updateMatrixWorld();
  };
  aim(yaw0);

  // static meshes for the BVH: everything opaque inside, plus the hull as exterior
  const statics: THREE.Mesh[] = [];
  inside.updateMatrixWorld(true);
  inside.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) statics.push(m);
  });
  if (hull && num('hull', 1) === 1) {
    hull.userData.rt = { role: 'exterior' };
    hull.updateMatrixWorld(true);
    statics.push(hull);
  }
  const rt = createRayTracer(renderer, { quality: tier });
  rt.effects.sun = num('sun', 1) === 1;
  rt.effects.bounce = num('bounce', 1) === 1;
  rt.effects.reflections = num('refl', 1) === 1;
  rt.effects.ao = num('ao', 1) === 1;
  rt.debugView = num('debug', 0);
  const tb0 = performance.now();
  await rt.setStaticScene(statics, new THREE.Matrix4(), { onProgress: (f, l) => (info.textContent = `${l} ${(f * 100).toFixed(0)}%`) });
  const tb1 = performance.now();

  const mk = (): THREE.WebGLRenderTarget => {
    const t = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    return t;
  };
  const hdrOn = mk();
  const hdrOff = split ? mk() : null;
  const out = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      uniforms: { uOn: { value: hdrOn.texture }, uOff: { value: hdrOff ? hdrOff.texture : hdrOn.texture }, uSplit: { value: split ? 1 : 0 }, uExp: { value: Math.pow(2, num('ev', 0)) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `uniform sampler2D uOn; uniform sampler2D uOff; uniform float uSplit; uniform float uExp; varying vec2 vUv;
        vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }
        void main(){
          bool left = uSplit > 0.5 && vUv.x < 0.5;
          vec2 uv = uSplit > 0.5 ? vec2(fract(vUv.x * 2.0), vUv.y) : vUv;
          vec3 c = (left ? texture2D(uOff, uv) : texture2D(uOn, uv)).rgb * uExp;
          c = pow(aces(c), vec3(1.0/2.2));
          if (uSplit > 0.5 && abs(vUv.x - 0.5) < 0.002) c = vec3(1.0, 0.8, 0.2);
          gl_FragColor = vec4(c, 1.0);
        }`,
      depthTest: false,
    }),
  );
  out.frustumCulled = false;
  const outScene = new THREE.Scene();
  outScene.add(out);
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const eye = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
  const zero = { r: 0, g: 0, b: 0 };
  const sunC = { r: sunLevel.r, g: sunLevel.g, b: sunLevel.b };
  const win = { r: 0.02, g: 0.025, b: 0.035 };
  const sd = { x: sunDir.x, y: sunDir.y, z: sunDir.z };
  const ship = new THREE.Matrix4();
  const rtSun = { dirShip: sunDir, color: new THREE.Color(sunLevel.r * 3, sunLevel.g * 3, sunLevel.b * 3), angularRadius: sunAng, intensity: Math.PI };

  const drawInside = (target: THREE.WebGLRenderTarget, withSun: boolean, time: number): void => {
    interior.update({ time, lights: true, eye, gain: 1, sunDir: sd, sunColor: withSun ? sunC : zero, windowColor: win });
    cockpit?.update({ devices: [], time, lights: true, gain: 1, instruments: null });
    renderer.setRenderTarget(target);
    renderer.autoClear = false;
    renderer.clear(true, true, true);
    renderer.render(outside, camera);
    renderer.clearDepth();
    renderer.render(inside, camera);
  };

  const px1 = new Uint16Array(4);
  const tf0 = performance.now();
  let traceMs = 0;
  for (let f = 0; f < frames; f++) {
    const time = f / 30;
    if (turn && f >= frames - 6) aim(yaw0 + turn * DEG * (f - (frames - 7)));
    drawInside(hdrOn, tier === 'off' || !rt.effects.sun, time);
    const ts = performance.now();
    rt.render({ camera, shipMatrixWorld: ship, sun: rtSun, lamps: 1, bakedGain: 1, time, frame: f, width: W, height: H });
    rt.composite(hdrOn.texture, hdrOn);
    traceMs += performance.now() - ts;
    renderer.readRenderTargetPixels(hdrOn, 0, 0, 1, 1, px1); // wait for the GPU (keeps SwiftShader's queue short)
    if (f % 2 === 1) await new Promise((r) => setTimeout(r, 0));
  }
  if (hdrOff) drawInside(hdrOff, true, frames / 30);
  renderer.setRenderTarget(null);
  renderer.autoClear = true;
  renderer.render(outScene, ortho);
  const tf1 = performance.now();
  const s = rt.stats();
  const est = (['low', 'medium', 'high', 'ultra'] as const).map((t) => {
    const e = rt.estimate(t);
    return `${t} ${(e.rays / 1e6).toFixed(2)}M rays ${e.ms.toFixed(1)}ms`;
  });
  info.textContent =
    `rt ${s.tier}${split ? ' · left OFF | right ON' : ''} · view ${view} · ${W}x${H} → trace ${s.width}x${s.height} · frames ${frames} (${s.frames} accumulated)${rt.debugView ? ` · debug ${rt.debugView}` : ''}\n` +
    `BVH ${s.triangles} tris ${s.bvhNodes} nodes · build ${s.buildMs.toFixed(0)} ms (setStaticScene ${(tb1 - tb0).toFixed(0)} ms incl. compile) · ${(s.bytes / 1048576).toFixed(1)} MB\n` +
    `work/ray closest ${s.work.closest.nodes.toFixed(1)}n ${s.work.closest.tris.toFixed(1)}t · any ${s.work.any.nodes.toFixed(1)}n ${s.work.any.tris.toFixed(1)}t · rays/frame ${(s.rays / 1e6).toFixed(2)}M\n` +
    `iPhone 15 est (786x1704): ${est.join(' · ')} · recommended ${rt.recommendedTier()}\n` +
    `here: setup ${((tb0 - t0) / 1000).toFixed(1)} s · ${frames} frames ${((tf1 - tf0) / 1000).toFixed(1)} s (rt ${(traceMs / 1000).toFixed(1)} s, SwiftShader CPU)${s.disabled ? ` · DISABLED: ${s.disabled}` : ''}`;
  ready();
}
main().catch(showError);
