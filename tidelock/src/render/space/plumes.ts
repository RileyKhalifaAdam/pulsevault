// Honest exhaust on the GPU (SIMULATION.md W1-E items 1, 2): the RCS condensate puffs of a PuffPool and the main
// plume's free expansion in vacuum. The physics and every constant live in plumeCore.ts (pure, tested).
//
// WIRING (wave 1, W1-E; nothing here is called yet):
//   * scene.ts: `this.puffs = new PuffRenderer(pool)`; `this.nearScene.add(this.puffs.mesh)` next to fx.object3d.
//     Per frame after pool.frame / pool.consume (plumeCore.ts WIRING):
//       solvePuffFloor(pool, cam, sunDir, vis, budgetPx, occ, nOcc)   // cam: PuffCam (anchor-relative, same basis)
//       this.puffs.update(anchorRelCam.x, .y, .z, sunDir, sunRGB, vis, occ, nOcc, shutter, cam.px)
//     anchorRelCam = pool.anchorPos(tFrame) − camAbs (doubles, then float); sunDir the unit direction to the star
//     (inertial axes); sunRGB = this.key.color × π·starIntensityAt(ds, lum) (the key's irradiance E before its visibility factor); vis =
//     starVisibility at the player (0 in the planet's shadow: nothing is drawn); occ from
//     packOccluders(WREN_OCCLUDERS, q, r − anchor); shutter = frame.realDt; for the solver cam.px = 0.5 ·
//     renderer drawing-buffer height · camera.projectionMatrix.elements[5]; budgetPx = PUFF_FILL_SCREENS × width ×
//     height of the target it draws into; cam.right/up/fwd from camera.matrixWorld (fwd = −z column). One draw call, none while nothing lives. REPLACES EffectsManager.rcsPuff
//     and the scene's `fire < 0.25` loop.
//   * scene.ts addShip: REPLACES createEnginePlumes(...) with
//       createPhysicalPlumes(layout.engines.map((e, i) => ({ pos: e.pos, radius: e.radius,
//         maxThrust: craft.engines[i].maxThrust, ve: craft.engines[i].ve })), { quality })   // once, at add time
//     and per frame `e.plume.setLevels(view.engineLevel)` REPLACES setThrottle(ctx.throttle) + update(dt) (no
//     spool, kick, flicker or noise texture: one instanced draw call per ship, 16 samples, no texture taps); in air
//     `e.plume.setAmbient(p_a)` (Pa, 0 in vacuum) sets the shock-cell spacing. `e.plume.level` readers (hull bell
//     glow) keep reading `.level` (the mean of the levels, no lag).
import * as THREE from 'three';
import {
  MAX_OCCLUDERS,
  HG_G,
  OMEGA0,
  PUFF_STRIDE,
  PLUME_THETA,
  F_MIN,
  plumeCellRadii,
  plumeExitFactor,
  plumeLength,
  plumeGlowLevel,
  type PuffPool,
} from './plumeCore';

// =============================================================================================== puffs

const PUFF_VERT = /* glsl */ `
precision highp float;
in vec4 aA;   // b.xyz (anchor-relative birth position, m), t0 (s rel. epoch)
in vec4 aB;   // u.xyz (anchor-relative velocity, m/s), tEnd
in vec4 aC;   // s0 (m), w (m/s), K = kappa*m/2pi (m^2), kind
uniform float uNow;
uniform vec3 uCam;          // camera, anchor-relative
uniform vec3 uSunDir;       // unit, toward the star
uniform vec3 uSun;          // irradiance scale x colour x planet-shadow visibility
uniform vec4 uOcc[${MAX_OCCLUDERS * 2}];
uniform int uNOcc;
uniform float uShutter;     // s: the frame's exposure, for the motion smear
uniform float uVis;         // sun visibility (planet shadow), 0..1
uniform float uFloor;       // the frame's floor raise phi >= 1 (solvePuffFloor)
uniform float uPx;          // pixels per unit of x/depth: 0.5 * buffer height * projection[1][1]
uniform float uQuadCap;     // px per quad at most (pool.quadCapPx)
out vec2 vUv;               // in sigmas along the two quad axes
out vec3 vCol;
out float vTau;             // centre optical depth after the smear
out float vEdge;            // exp(-tau at the clip edge): subtracted so the quad fades to exactly 0 there
float segDist2(vec3 p, vec3 s, vec3 a, vec3 b) {
  vec3 d1 = s * 1.0e4; vec3 d2 = b - a; vec3 r = p - a;
  float A = dot(d1, d1), E = dot(d2, d2), F = dot(d2, r), C = dot(d1, r), B = dot(d1, d2);
  float den = A * E - B * B;
  float sc = den > 1e-6 ? clamp((B * F - C * E) / den, 0.0, 1.0) : 0.0;
  float tc = (B * sc + F) / max(E, 1e-9);
  if (tc < 0.0) { tc = 0.0; sc = clamp(-C / A, 0.0, 1.0); }
  else if (tc > 1.0) { tc = 1.0; sc = clamp((B - C) / A, 0.0, 1.0); }
  vec3 q = p + d1 * sc - (a + d2 * tc);
  return dot(q, q);
}
void main() {
  float tau = uNow - aA.w;
  if (tau < 0.0 || uNow > aB.w) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 p = aA.xyz + aB.xyz * tau;
  // the hull's own shadow: nothing shows in it
  for (int i = 0; i < ${MAX_OCCLUDERS}; i++) {
    if (i >= uNOcc) break;
    vec4 a = uOcc[i * 2]; vec4 b = uOcc[i * 2 + 1];
    if (segDist2(p, uSunDir, a.xyz, b.xyz) < a.w * a.w) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  }
  float s = aC.x + aC.y * tau;
  vec3 view = normalize(uCam - p);
  float ct = dot(-uSunDir, view);              // scattering angle: incident -sunDir, out toward the eye
  float g = ${HG_G.toFixed(4)};
  float dd = 1.0 + g * g - 2.0 * g * ct;
  float phase = (1.0 - g * g) / (12.566371 * dd * sqrt(dd));
  vCol = uSun * (${OMEGA0.toFixed(4)} * phase);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  // motion smear over the exposure: a Gaussian of width s convolved with a segment of length l
  vec3 vv = mat3(modelViewMatrix) * aB.xyz;
  vec2 vxy = vv.xy - vv.z * mv.xy / min(mv.z, -1e-3);
  float vl = length(vxy);
  vec2 ax = vl > 1e-6 ? vxy / vl : vec2(1.0, 0.0);
  float l = vl * uShutter;
  float sa = sqrt(s * s + l * l / 12.0);
  float tc = aC.z / (s * sa);
  // clip where the radiance at this phase drops below the floor (one LSB), and cap the quad's pixels
  float q = uFloor * ${F_MIN.toExponential(6)} / (${OMEGA0.toFixed(4)} * phase * max(uVis, 1e-6));
  float tm = q < 1.0 ? -log(1.0 - q) : 1e30;
  float depth = -mv.z;
  if (tc <= tm || depth < 1e-3) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float sPx = s * uPx / depth, saPx = sa * uPx / depth;
  float x2 = min(min(2.0 * log(tc / tm), uQuadCap / (4.0 * sPx * saPx)), 9.0);
  if (x2 < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float xr = sqrt(x2);
  vTau = tc;
  vEdge = exp(-tc * exp(-0.5 * x2));
  vec2 c = position.xy * xr;                   // quad corners at the clip radius (<= 3 sigma)
  mv.xy += ax * (c.x * sa) + vec2(-ax.y, ax.x) * (c.y * s);
  vUv = c;
  gl_Position = projectionMatrix * mv;
}
`;

const PUFF_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
in vec3 vCol;
in float vTau;
in float vEdge;
void main() {
  float t = vTau * exp(-0.5 * dot(vUv, vUv));
  gl_FragColor = vec4(vCol * max(vEdge - exp(-t), 0.0), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** The puff pool's single instanced draw call. */
export class PuffRenderer {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly buf: THREE.InstancedInterleavedBuffer;
  private readonly mat: THREE.ShaderMaterial;
  private readonly dirty = new Int32Array(2);
  private readonly occ: Float32Array;
  private readonly occV: THREE.Vector4[];

  constructor(private readonly pool: PuffPool) {
    const quad = new THREE.InstancedBufferGeometry();
    quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    this.geo = quad;
    this.buf = new THREE.InstancedInterleavedBuffer(pool.data, PUFF_STRIDE);
    this.buf.setUsage(THREE.DynamicDrawUsage);
    quad.setAttribute('aA', new THREE.InterleavedBufferAttribute(this.buf, 4, 0));
    quad.setAttribute('aB', new THREE.InterleavedBufferAttribute(this.buf, 4, 4));
    quad.setAttribute('aC', new THREE.InterleavedBufferAttribute(this.buf, 4, 8));
    quad.instanceCount = pool.capacity;
    this.occ = new Float32Array(MAX_OCCLUDERS * 8);
    this.occV = [];
    for (let i = 0; i < MAX_OCCLUDERS * 2; i++) this.occV.push(new THREE.Vector4());
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uNow: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSun: { value: new THREE.Vector3() },
        uOcc: { value: this.occV },
        uNOcc: { value: 0 },
        uShutter: { value: 1 / 60 },
        uVis: { value: 1 },
        uFloor: { value: 1 },
        uPx: { value: 500 },
        uQuadCap: { value: 1e12 },
      },
      vertexShader: PUFF_VERT,
      fragmentShader: PUFF_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });
    this.mesh = new THREE.Mesh(quad, this.mat);
    this.mesh.name = 'fx:puffs';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 21;
  }

  /**
   * Per frame (no allocation): `anchorRelCam` = anchor − camera (m, the mesh's position in the camera-origin near
   * scene); the sun (direction, unshadowed irradiance colour, visibility); the occluders packed by packOccluders
   * (anchor-relative); the frame's real dt (smear); pixels per unit of x/depth (as cam.px). Call solvePuffFloor first (with
   * the same camera, sun and occluders): its pool.floorPhi is the shader's floor raise.
   */
  update(ax: number, ay: number, az: number, sunDir: THREE.Vector3, sunRGB: THREE.Vector3, sunVis: number, occ: Float32Array | null, nOcc: number, shutter: number, pxPerUnit: number): void {
    const pool = this.pool;
    const vis = pool.alive && sunVis > 0 && sunRGB.x + sunRGB.y + sunRGB.z > 0;
    this.mesh.visible = vis;
    const d = pool.takeDirty(this.dirty);
    if (d[1] > 0) {
      // ranges accumulate until three uploads them (it clears them after the upload)
      this.buf.addUpdateRange(d[0] * PUFF_STRIDE, d[1] * PUFF_STRIDE);
      this.buf.needsUpdate = true;
    }
    if (!vis) return;
    const u = this.mat.uniforms;
    this.mesh.position.set(ax, ay, az);
    u.uNow.value = pool.now;
    (u.uCam.value as THREE.Vector3).set(-ax, -ay, -az);
    (u.uSunDir.value as THREE.Vector3).copy(sunDir);
    (u.uSun.value as THREE.Vector3).copy(sunRGB).multiplyScalar(sunVis);
    u.uShutter.value = shutter;
    u.uVis.value = sunVis;
    u.uFloor.value = pool.floorPhi;
    u.uPx.value = pxPerUnit;
    u.uQuadCap.value = Math.min(pool.quadCapPx, 1e30);
    const n = occ ? Math.min(nOcc, MAX_OCCLUDERS) : 0;
    for (let i = 0; i < n * 2; i++) this.occV[i].set(occ![i * 4], occ![i * 4 + 1], occ![i * 4 + 2], occ![i * 4 + 3]);
    u.uNOcc.value = n;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
  }
}

// =============================================================================================== main plume

/** The fusion exhaust's radiance at the exit column, full thrust of the reference engine (render units), and tint. */
export const PLUME_RADIANCE = 30;
export const PLUME_TINT: readonly [number, number, number] = [0.26, 0.5, 1.0];
const PLUME_Z0 = -0.45;
const PLUME_STEPS: Record<string, number> = { low: 10, medium: 12, high: 16, ultra: 20 };

const PLUME_VERT = /* glsl */ `
precision highp float;
in vec4 aNozzle;   // xyz exit centre (parent axes), w exit radius
in float aLevel;   // exit-column radiance factor (plumeExitFactor)
uniform mat4 uInvModel;
out vec3 vPos;
flat out vec3 vCam;
flat out float vLevel;
void main() {
  vPos = position;
  vec3 camLocal = (uInvModel * vec4(cameraPosition, 1.0)).xyz;
  vCam = (camLocal - aNozzle.xyz) / aNozzle.w;
  vLevel = aLevel;
  vec3 p = aLevel > 0.0 ? position : vec3(0.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(aNozzle.xyz + p * aNozzle.w, 1.0);
}
`;

const PLUME_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uTint;      // radiance of the exit column at factor 1
uniform vec4 uBound;     // z0, r0, slope, z1 (nozzle radii)
uniform vec2 uShape;     // tan(theta), shock-cell spacing in radii (0 = vacuum)
in vec3 vPos;
flat in vec3 vCam;
flat in float vLevel;
// n = exp(-r^2/R^2)/R^2, emissivity n^2 (two-body), normalised so the transverse exit column is 1
float emis(vec3 p) {
  float z = p.z;
  float R = z > 0.0 ? 1.0 + z * uShape.x : max(0.55, 1.0 + 0.9 * z);
  float r2 = dot(p.xy, p.xy);
  if (z < 0.0 && r2 > 1.0) return 0.0;      // inside the bell: the wall
  float iR2 = 1.0 / (R * R);
  float n = exp(-r2 * iR2) * iR2;
  float e = n * n * 0.7978846;               // 1/sqrt(pi/2)
  if (uShape.y > 0.0 && z > 0.0) { float c = cos(3.14159265 * z / uShape.y); e *= 0.4 + 1.2 * c * c; }
  return e;
}
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  vec3 ro = vCam;
  vec3 d = vPos - vCam;
  float tFar = length(d);
  vec3 rd = d / tFar;
  float tNear = 0.0;
  if (abs(rd.z) > 1e-5) {
    float ta = (uBound.x - ro.z) / rd.z;
    float tb = (uBound.w - ro.z) / rd.z;
    tNear = max(tNear, min(ta, tb));
  }
  float a0 = uBound.y + uBound.z * (ro.z - uBound.x);
  float b = uBound.z * rd.z;
  float A = dot(rd.xy, rd.xy) - b * b;
  float B = 2.0 * (dot(ro.xy, rd.xy) - a0 * b);
  float C = dot(ro.xy, ro.xy) - a0 * a0;
  float disc = B * B - 4.0 * A * C;
  if (abs(A) > 1e-6) {
    if (disc > 0.0) {
      float te = (-B - sqrt(disc)) / (2.0 * A);
      if (A > 0.0 || (a0 + b * te) > 0.0) tNear = max(tNear, te);
    } else if (A > 0.0) {
      discard;
    }
  }
  float span = tFar - tNear;
  if (span <= 0.0 || vLevel <= 0.0) discard;
  // samples crowd quadratically toward the end nearer the exit plane (the emission falls as R^-4)
  bool fwd = rd.z >= 0.0;
  float j = ign(gl_FragCoord.xy);
  float sum = 0.0;
  for (int i = 0; i < STEPS; i++) {
    float u0 = (float(i) + j) / float(STEPS);
    float w = 2.0 * u0 / float(STEPS);       // dt/du for t = u^2
    float tt = fwd ? tNear + span * u0 * u0 : tFar - span * u0 * u0;
    sum += emis(ro + rd * tt) * w;
  }
  vec3 col = uTint * (sum * span * vLevel);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface PhysicalPlume {
  /** Attach at the parent's origin (ship-local nozzle positions); exhaust toward local +Z. */
  object3d: THREE.Object3D;
  /** Per engine, the applied level F_s/F_max (CraftView.engineLevel); no lag of its own. */
  setLevels(levels: ArrayLike<number>): void;
  /** Ambient static pressure, Pa (0 in vacuum: no cells); sets the shock-cell spacing 1.3·D_e·√(p_e/p_a). */
  setAmbient(pa: number): void;
  /** Mean level, for hull glow and audio readers of the old `level`. */
  readonly level: number;
  dispose(): void;
}

/** One nozzle: exit centre (parent axes) and radius (layout), full thrust (N) and vₑ (m/s) (its EngineDef). */
export interface PlumeNozzle {
  pos: { x: number; y: number; z: number };
  radius: number;
  maxThrust: number;
  ve: number;
}

export interface PhysicalPlumeOptions {
  /** Ambient static pressure at creation, Pa (0 in vacuum, the default); later setAmbient(p_a). */
  ambient?: number;
  quality?: 'low' | 'medium' | 'high' | 'ultra';
  tint?: readonly [number, number, number];
}

/** All of one ship's nozzles in a single instanced, texture-free ray-marched draw call. */
export function createPhysicalPlumes(nozzles: readonly PlumeNozzle[], opts: PhysicalPlumeOptions = {}): PhysicalPlume {
  for (const nz of nozzles) {
    if (!(nz.maxThrust > 0 && nz.ve > 0 && nz.radius > 0)) throw new RangeError('createPhysicalPlumes: every nozzle needs radius, maxThrust and ve > 0');
  }
  const tanT = Math.tan(PLUME_THETA);
  const z1 = plumeLength(tanT);
  const r1 = 2.5 * (1 + z1 * tanT);
  const r0 = 2.2;
  const h = z1 - PLUME_Z0;
  const base = new THREE.CylinderGeometry(r1, r0, h, 20, 1, false);
  base.rotateX(Math.PI / 2);
  base.translate(0, 0, PLUME_Z0 + h / 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setIndex(base.getIndex());
  const n = nozzles.length;
  const inst = new Float32Array(n * 4);
  const lv = new Float32Array(n);
  const levels = new Float32Array(n);
  let reach = 0;
  for (let i = 0; i < n; i++) {
    const nz = nozzles[i];
    inst[i * 4] = nz.pos.x; inst[i * 4 + 1] = nz.pos.y; inst[i * 4 + 2] = nz.pos.z; inst[i * 4 + 3] = nz.radius;
    reach = Math.max(reach, Math.hypot(nz.pos.x, nz.pos.y, nz.pos.z) + nz.radius * (z1 + r1));
  }
  geo.setAttribute('aNozzle', new THREE.InstancedBufferAttribute(inst, 4));
  const lvAttr = new THREE.InstancedBufferAttribute(lv, 1);
  lvAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aLevel', lvAttr);
  geo.instanceCount = n;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), reach);
  const tint = opts.tint ?? PLUME_TINT;
  const uniforms = {
    uTint: { value: new THREE.Vector3(tint[0] * PLUME_RADIANCE, tint[1] * PLUME_RADIANCE, tint[2] * PLUME_RADIANCE) },
    uBound: { value: new THREE.Vector4(PLUME_Z0, r0, (r1 - r0) / h, z1) },
    uShape: { value: new THREE.Vector2(tanT, plumeCellRadii(opts.ambient ?? 0)) },
    uInvModel: { value: new THREE.Matrix4() },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: PLUME_VERT,
    fragmentShader: PLUME_FRAG,
    defines: { STEPS: PLUME_STEPS[opts.quality ?? 'high'] },
    side: THREE.BackSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'plume:physical';
  mesh.renderOrder = 20;
  mesh.visible = false;
  mesh.onBeforeRender = (): void => {
    uniforms.uInvModel.value.copy(mesh.matrixWorld).invert();
    mat.uniformsNeedUpdate = true;
  };
  let mean = 0;
  return {
    object3d: mesh,
    setLevels(src: ArrayLike<number>): void {
      let any = false;
      for (let i = 0; i < n; i++) {
        const l = src[i] ?? 0;
        levels[i] = l;
        const f = plumeExitFactor(l, nozzles[i].maxThrust, nozzles[i].ve, nozzles[i].radius);
        if (lv[i] !== f) { lv[i] = f; lvAttr.needsUpdate = true; }
        if (f > 0) any = true;
      }
      mean = plumeGlowLevel(levels, n);
      mesh.visible = any;
    },
    setAmbient(pa: number): void {
      const c = plumeCellRadii(pa);
      if (uniforms.uShape.value.y !== c) { uniforms.uShape.value.y = c; mat.uniformsNeedUpdate = true; }
    },
    get level(): number {
      return mean;
    },
    dispose(): void {
      mesh.removeFromParent();
      geo.dispose();
      base.dispose();
      mat.dispose();
    },
  };
}
