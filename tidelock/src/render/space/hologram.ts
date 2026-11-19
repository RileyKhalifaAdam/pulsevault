// The holographic situation display above the centre of the Wren's dashboard: a live 3D view of what the
// NAV computer knows, from the same InstrumentData the console screens draw (instruments.ts):
//   the primary body as a glowing wireframe globe, the predicted path (cyan), the target and its predicted path
//   (amber, lifted out of the plane by its real out-of-plane offset), the ship marker, apsis ticks, a reference
//   plane with range rings, and the projector's faint light cone.
//
//   const holo = createHologram({ radius: 0.085 });
//   holo.object3d.position.set(x, yDash, z);          // ship-local: the projector lens on the dash top
//   holo.update(instrumentData, time, gain);           // every frame (cheap: uniforms; geometry only on change)
//
// One draw call: every line is a camera-facing ribbon expanded in the vertex shader (anti-aliased, glowing,
// world-space width), additive, depth-faded toward the far side, with scanlines and a gentle flicker. The display
// spins slowly about the orbit normal on the GPU (a uniform), so no vertex is touched per frame.
import * as THREE from 'three';
import type { InstrumentData } from './instruments';

export interface Hologram {
  object3d: THREE.Object3D;
  update(data: InstrumentData | null, time: number, gain: number): void;
  dispose(): void;
  readonly triangles: number;
}

type RGB = readonly [number, number, number];
const CYAN: RGB = [0.28, 0.86, 1.0];
const ICE: RGB = [0.75, 0.95, 1.0];
const AMBER: RGB = [1.0, 0.55, 0.14];
const MAX_SEG = 1500;
/** Height of the display centre above the lens, m; tilt of the plane toward the crew, rad. */
const LIFT = 0.15;
const TILT = 0.62;

const VS = /* glsl */ `
attribute vec3 aDir;
attribute vec4 aP;
attribute vec3 aCol;
uniform float uSpin;
uniform mat3 uTilt;
uniform vec3 uCentre;
uniform float uR;
varying vec3 vCol;
varying float vSide;
varying float vKind;
varying float vI;
varying float vDepth;
varying float vY;
void main() {
  vec3 p = position;
  vec3 d = aDir;
  if (aP.w < 1.5) {
    float c = cos(uSpin);
    float s = sin(uSpin);
    mat3 ry = mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
    p = uTilt * (ry * p) + uCentre;
    d = uTilt * (ry * d);
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  if (aP.w < 1.5) {
    vec3 dv = (modelViewMatrix * vec4(d, 0.0)).xyz;
    vec3 side = cross(dv, normalize(-mv.xyz));
    float l = length(side);
    side = l > 1e-7 ? side / l : vec3(0.0);
    mv.xyz += side * aP.x * aP.y;
  }
  vec4 c0 = modelViewMatrix * vec4(uCentre, 1.0);
  vDepth = clamp((mv.z - c0.z) / uR, -1.0, 1.0);
  vY = (modelMatrix * vec4(p, 1.0)).y;
  vCol = aCol;
  vSide = aP.x;
  vKind = aP.w;
  vI = aP.z;
  gl_Position = projectionMatrix * mv;
}`;

const FS = /* glsl */ `
uniform float uTime;
uniform float uLevel;
varying vec3 vCol;
varying float vSide;
varying float vKind;
varying float vI;
varying float vDepth;
varying float vY;
void main() {
  float a;
  if (vKind < 1.5) {
    float e = abs(vSide);
    a = 1.0 - smoothstep(0.25, 1.0, e);
    a = a * a + 0.9 * (1.0 - smoothstep(0.0, 0.35, e));
  } else {
    a = vSide * vSide;
  }
  float depth = 0.4 + 0.6 * smoothstep(-1.0, 0.7, vDepth);
  float scan = 0.74 + 0.26 * sin(vY * 1300.0 - uTime * 7.0);
  float band = 1.0 + 0.35 * smoothstep(0.96, 1.0, sin(vY * 40.0 - uTime * 2.3));
  gl_FragColor = vec4(vCol * (vI * a * depth * scan * band * uLevel), 1.0);
}`;

export function createHologram(opts: { radius?: number } = {}): Hologram {
  const R = opts.radius ?? 0.085;
  const NV = MAX_SEG * 4;
  const pos = new Float32Array(NV * 3);
  const dir = new Float32Array(NV * 3);
  const par = new Float32Array(NV * 4);
  const col = new Float32Array(NV * 3);
  const idx = new Uint16Array(MAX_SEG * 6);
  for (let i = 0; i < MAX_SEG; i++) {
    const v = i * 4;
    const k = i * 6;
    idx[k] = v;
    idx[k + 1] = v + 1;
    idx[k + 2] = v + 2;
    idx[k + 3] = v;
    idx[k + 4] = v + 2;
    idx[k + 5] = v + 3;
  }
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aDir = new THREE.BufferAttribute(dir, 3).setUsage(THREE.DynamicDrawUsage);
  const aP = new THREE.BufferAttribute(par, 4).setUsage(THREE.DynamicDrawUsage);
  const aCol = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos);
  geo.setAttribute('aDir', aDir);
  geo.setAttribute('aP', aP);
  geo.setAttribute('aCol', aCol);
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, LIFT, 0), R * 1.6);

  const tilt = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationX(TILT));
  const uniforms = {
    uSpin: { value: 0 },
    uTilt: { value: tilt },
    uCentre: { value: new THREE.Vector3(0, LIFT, 0) },
    uR: { value: R },
    uTime: { value: 0 },
    uLevel: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({
    vertexShader: VS,
    fragmentShader: FS,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'hologram';
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.userData.room = 'cockpit';

  let n = 0;
  /** A glowing line from a to b (display coordinates unless `fill`), half-width w m, intensity i. */
  const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number, i: number, c: RGB): void => {
    if (n >= MAX_SEG) return;
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    for (let k = 0; k < 4; k++) {
      const v = n * 4 + k;
      const atB = k === 1 || k === 2;
      pos[v * 3] = atB ? bx : ax;
      pos[v * 3 + 1] = atB ? by : ay;
      pos[v * 3 + 2] = atB ? bz : az;
      dir[v * 3] = dx;
      dir[v * 3 + 1] = dy;
      dir[v * 3 + 2] = dz;
      par[v * 4] = k < 2 ? -1 : 1;
      par[v * 4 + 1] = w;
      par[v * 4 + 2] = i;
      par[v * 4 + 3] = 0;
      col[v * 3] = c[0];
      col[v * 3 + 1] = c[1];
      col[v * 3 + 2] = c[2];
    }
    // corner order for the quad (0 a-, 1 b-, 2 b+, 3 a+): sides -1,-1,+1,+1 along a,b,b,a
    par[(n * 4 + 1) * 4] = -1;
    par[(n * 4 + 2) * 4] = 1;
    par[(n * 4 + 3) * 4] = 1;
    n++;
  };
  /** A filled quad in mesh coordinates (not spun), with a fade per corner (0..1). */
  const fill = (p: readonly number[], f: readonly number[], i: number, c: RGB): void => {
    if (n >= MAX_SEG) return;
    for (let k = 0; k < 4; k++) {
      const v = n * 4 + k;
      pos[v * 3] = p[k * 3];
      pos[v * 3 + 1] = p[k * 3 + 1];
      pos[v * 3 + 2] = p[k * 3 + 2];
      dir[v * 3] = dir[v * 3 + 1] = dir[v * 3 + 2] = 0;
      par[v * 4] = f[k];
      par[v * 4 + 1] = 0;
      par[v * 4 + 2] = i;
      par[v * 4 + 3] = 2;
      col[v * 3] = c[0];
      col[v * 3 + 1] = c[1];
      col[v * 3 + 2] = c[2];
    }
    n++;
  };
  const ring = (r: number, y: number, count: number, w: number, i: number, c: RGB, dash = false): void => {
    for (let k = 0; k < count; k++) {
      if (dash && k % 2 === 1) continue;
      const a0 = (k / count) * Math.PI * 2;
      const a1 = ((k + 1) / count) * Math.PI * 2;
      seg(Math.cos(a0) * r, y, Math.sin(a0) * r, Math.cos(a1) * r, y, Math.sin(a1) * r, w, i, c);
    }
  };

  // the projector's light cone (mesh coordinates, never spun): from the lens up to the display
  const cone: number[] = [];
  const CONE_N = 28;
  const cone0 = 0.026;
  const cone1 = R * 0.95;
  const coneTop = LIFT - R * 0.25;
  for (let k = 0; k < CONE_N; k++) {
    const a0 = (k / CONE_N) * Math.PI * 2;
    const a1 = ((k + 1) / CONE_N) * Math.PI * 2;
    cone.push(Math.cos(a0) * cone0, 0.012, Math.sin(a0) * cone0, Math.cos(a1) * cone0, 0.012, Math.sin(a1) * cone0, Math.cos(a1) * cone1, coneTop, Math.sin(a1) * cone1, Math.cos(a0) * cone1, coneTop, Math.sin(a0) * cone1);
  }
  const CONE_F = [1, 1, 0, 0];
  const quad: number[] = new Array(12).fill(0);

  let ver = -2;
  let lastCount = -1;
  let lastTarget = -1;
  let lastTX = NaN;
  const rebuild = (d: InstrumentData | null): void => {
    n = 0;
    for (let k = 0; k < CONE_N; k++) {
      for (let j = 0; j < 12; j++) quad[j] = cone[k * 12 + j];
      fill(quad, CONE_F, 0.07, CYAN);
    }
    // reference plane: range rings and ticks
    ring(R, 0, 64, 0.0005, 0.22, CYAN, true);
    ring(R * 0.7, 0, 48, 0.00035, 0.12, CYAN);
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const r0 = k % 6 === 0 ? R * 0.9 : R * 0.96;
      seg(Math.cos(a) * r0, 0, Math.sin(a) * r0, Math.cos(a) * R * 1.02, 0, Math.sin(a) * R * 1.02, 0.0005, 0.35, CYAN);
    }
    const o = d ? d.orbit : null;
    // scale: the path, the target's path and the body all inside the display
    let ext = o ? Math.max(1, o.bodyRadius) : 1;
    const bodyR = ext;
    if (o) {
      const fit = (a: Float32Array, cnt: number, z: Float32Array | null): void => {
        for (let i = 0; i < cnt; i++) {
          const x = a[i * 2];
          const y = a[i * 2 + 1];
          const zz = z ? z[i] : 0;
          const r = Math.hypot(x, y, zz);
          if (Number.isFinite(r) && r < bodyR * 40) ext = Math.max(ext, r);
        }
      };
      fit(o.path, o.pathCount, null);
      fit(o.targetPath, o.targetCount, o.targetPathZ);
    }
    const s = R / (ext * 1.04);
    const rg = o ? Math.max(0.01, bodyR * s) : R * 0.45;
    // the globe: latitude rings and meridians, the equator brighter
    for (let k = -2; k <= 2; k++) {
      const lat = (k * Math.PI) / 6;
      ring(rg * Math.cos(lat), rg * Math.sin(lat), 40, k === 0 ? 0.0007 : 0.0005, k === 0 ? 0.55 : 0.3, CYAN);
    }
    for (let m = 0; m < 8; m++) {
      const lo = (m / 8) * Math.PI * 2;
      const cl = Math.cos(lo);
      const sl = Math.sin(lo);
      for (let k = 0; k < 16; k++) {
        const t0 = -Math.PI / 2 + (k / 16) * Math.PI;
        const t1 = -Math.PI / 2 + ((k + 1) / 16) * Math.PI;
        seg(rg * Math.cos(t0) * cl, rg * Math.sin(t0), rg * Math.cos(t0) * sl, rg * Math.cos(t1) * cl, rg * Math.sin(t1), rg * Math.cos(t1) * sl, 0.0005, 0.3, CYAN);
      }
    }
    // the globe's poles: a short axis through it
    seg(0, -rg * 1.25, 0, 0, -rg * 1.02, 0, 0.0005, 0.4, CYAN);
    seg(0, rg * 1.02, 0, 0, rg * 1.25, 0, 0.0005, 0.4, CYAN);
    if (!o || o.pathCount < 2) return;
    // display coordinates: plane x -> x, plane y -> -z, out of plane -> y
    const lim = R * 1.12;
    const path = (a: Float32Array, cnt: number, z: Float32Array | null, w: number, i0: number, c: RGB): void => {
      for (let i = 0; i + 1 < cnt; i++) {
        const ax = a[i * 2] * s;
        const az = -a[i * 2 + 1] * s;
        const ay = z ? z[i] * s : 0;
        const bx = a[i * 2 + 2] * s;
        const bz = -a[i * 2 + 3] * s;
        const by = z ? z[i + 1] * s : 0;
        if (!(Math.hypot(ax, ay, az) < lim && Math.hypot(bx, by, bz) < lim)) continue;
        seg(ax, ay, az, bx, by, bz, w, i0 * (1 - (0.55 * i) / cnt), c);
      }
    };
    path(o.path, o.pathCount, null, 0.0011, 1.25, CYAN);
    if (o.targetCount > 1) path(o.targetPath, o.targetCount, o.targetPathZ, 0.0009, 0.9, AMBER);
    // apsis ticks
    const tick = (x: number, y: number): void => {
      const px = x * s;
      const pz = -y * s;
      const l = Math.hypot(px, pz) || 1;
      seg(px - (px / l) * 0.006, 0, pz - (pz / l) * 0.006, px + (px / l) * 0.006, 0, pz + (pz / l) * 0.006, 0.0007, 0.9, ICE);
    };
    if (o.hasApo) tick(o.apoX, o.apoY);
    if (o.hasPeri) tick(o.periX, o.periY);
    // the ship: a chevron along its motion, a ring around it
    const sx = o.shipX * s;
    const sz = -o.shipY * s;
    let hx = o.pathCount > 1 ? o.path[2] * s - sx : 0;
    let hz = o.pathCount > 1 ? -o.path[3] * s - sz : -1;
    const hl = Math.hypot(hx, hz) || 1;
    hx /= hl;
    hz /= hl;
    const cw = 0.007;
    seg(sx + hx * cw, 0, sz + hz * cw, sx - hx * cw * 0.6 + hz * cw * 0.7, 0, sz - hz * cw * 0.6 - hx * cw * 0.7, 0.0008, 2.2, ICE);
    seg(sx + hx * cw, 0, sz + hz * cw, sx - hx * cw * 0.6 - hz * cw * 0.7, 0, sz - hz * cw * 0.6 + hx * cw * 0.7, 0.0008, 2.2, ICE);
    for (let k = 0; k < 12; k++) {
      const a0 = (k / 12) * Math.PI * 2;
      const a1 = ((k + 1) / 12) * Math.PI * 2;
      seg(sx + Math.cos(a0) * 0.011, 0, sz + Math.sin(a0) * 0.011, sx + Math.cos(a1) * 0.011, 0, sz + Math.sin(a1) * 0.011, 0.0004, 0.8, ICE);
    }
    seg(sx, 0, sz, sx, 0.016, sz, 0.0005, 0.9, ICE);
    // the target: a diamond where it is, a drop line to the plane
    if (o.hasTarget) {
      const tx = o.targetX * s;
      const tz = -o.targetY * s;
      const ty = o.targetZ * s;
      if (Math.hypot(tx, ty, tz) < lim) {
        const q = 0.006;
        seg(tx - q, ty, tz, tx, ty + q, tz, 0.0007, 1.6, AMBER);
        seg(tx, ty + q, tz, tx + q, ty, tz, 0.0007, 1.6, AMBER);
        seg(tx + q, ty, tz, tx, ty - q, tz, 0.0007, 1.6, AMBER);
        seg(tx, ty - q, tz, tx - q, ty, tz, 0.0007, 1.6, AMBER);
        if (Math.abs(ty) > 0.002) seg(tx, ty, tz, tx, 0, tz, 0.0004, 0.5, AMBER);
      }
    }
  };
  rebuild(null);

  const commit = (): void => {
    geo.setDrawRange(0, n * 6);
    aPos.needsUpdate = true;
    aDir.needsUpdate = true;
    aP.needsUpdate = true;
    aCol.needsUpdate = true;
  };
  commit();

  return {
    object3d: mesh,
    update(data, time, gain): void {
      const o = data ? data.orbit : null;
      if (o && (o.version !== ver || o.pathCount !== lastCount || o.targetCount !== lastTarget || o.targetX !== lastTX)) {
        ver = o.version;
        lastCount = o.pathCount;
        lastTarget = o.targetCount;
        lastTX = o.targetX;
        rebuild(data);
        commit();
      }
      uniforms.uSpin.value = (time * 0.12) % (Math.PI * 2);
      uniforms.uTime.value = time % 1000;
      // a gentle flicker: two slow beats and a rare short dip
      const dip = Math.sin(time * 0.71) > 0.985 ? 0.75 : 1;
      uniforms.uLevel.value = gain * dip * (0.94 + 0.04 * Math.sin(time * 13.1) * Math.sin(time * 7.7));
    },
    dispose(): void {
      geo.dispose();
      mat.dispose();
      mesh.removeFromParent();
    },
    get triangles(): number {
      return n * 2;
    },
  };
}
