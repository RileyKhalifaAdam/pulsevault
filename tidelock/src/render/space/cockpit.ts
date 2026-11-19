// The physical cockpit of the Wren, the hero space of the game: the sculpted dashboard and its glare shield,
// the pilot's and the co-pilot's flight stations, side consoles at the elbows, overhead switch panels, the centre
// pedestal, two seats with five-point harnesses, every device of src/data/cockpit.ts as hardware the pilot can see
// move and put a finger on, black-glass displays (instruments.ts) and the holographic situation display
// (hologram.ts).
//
//   const ck = createCockpitVisual(COCKPITS.wren, { quality });
//   interior.object3d.add(ck.object3d);                       // ship-local axes
//   ck.update({ devices: session.devices(), time, lights, gain, instruments });
//   const hit = ck.pick(rayOriginLocal, rayDirLocal, tolerance);   // -> { id, x, y } | null
//
// Physically based (art direction, docs/ARCHITECTURE.md): one MeshStandardMaterial for all the hardware, whose
// albedo, roughness, metalness, wear-detail kind and cavity occlusion ride in vertex attributes, with procedural
// micro-detail in the fragment shader (paint grime and orange peel, brushed metal, leather grain, webbing), so
// white clear-coat panels, gunmetal, rubber, leather and amber padding all draw in one call. It is lit by the
// interior's sun (shadows) and room probe (patched by probes.ts) like the rooms around it.
//
// Draw calls (cockpit room): dashboard shell · stations, seats and fittings · moving parts · glow (legends, lamps,
// LED strips, the hand ring) · FLIGHT glass · NAV glass · side-console glass · hologram = 8, plus 3 for a device
// in another room (the lounge LIGHTS switch), tagged with that room so the portal culling hides it.
import * as THREE from 'three';
import type { CockpitLayout, DeviceDef, DeviceKind, StationShape } from '../../data/cockpit';
import { INTERIORS, type Box } from '../../data/interiors';
import type { DeviceView } from '../../game/api';
import type { Quality } from '../pipeline';
import { SCREEN_H, SCREEN_W, drawAuxScreen, drawFlightScreen, drawNavScreen, drawNoData, type InstrumentData } from './instruments';
import { createHologram } from './hologram';

export interface CockpitUpdate {
  devices: readonly DeviceView[];
  /** Seconds, any monotonic clock (screen refresh, light fade). */
  time: number;
  /** Cabin lights on. Off leaves the lamps, the backlit placards and the screens. */
  lights: boolean;
  /** Display gain (2^-EV of the pipeline), as for the interior. */
  gain?: number;
  /** What the screens show; null leaves them on their last picture. */
  instruments?: InstrumentData | null;
}

export interface CockpitPick {
  id: string;
  /**
   * The hand in the device's own axes: stick2 x right, y along its `up`, each -1..1; lever x = 0..1 along its
   * travel; rocker x = -1 | 0 | +1 (which end the finger is on); screens and rests x, y = -1..1 across them.
   */
  x: number;
  y: number;
}

export interface CockpitVisual {
  object3d: THREE.Object3D;
  update(o: CockpitUpdate): void;
  /**
   * The device under a ray (ship-local origin and unit direction). `tolerance` is the finger's half-width as
   * an angle, rad. With `only`, the hand position on that device wherever the ray goes (for a drag in progress).
   */
  pick(origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, tolerance?: number, only?: string): CockpitPick | null;
  dispose(): void;
  readonly drawCalls: number;
  readonly triangles: number;
}

type RGB = readonly [number, number, number];
type UVR = readonly [number, number, number, number]; // u0, v bottom, u1, v top
/** A surface: linear albedo, roughness, metalness, micro-detail kind (0 none, 1 paint, 2 brushed, 3 grain, 4 weave). */
interface Brush {
  readonly c: RGB;
  readonly r: number;
  readonly m: number;
  readonly d: number;
}
const lin = (hex: number): RGB => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};
const B = (hex: number, r: number, m = 0, d = 1): Brush => ({ c: lin(hex), r, m, d });
const glow = (c: RGB): Brush => ({ c, r: 1, m: 0, d: 0 });

// work-area palette: white clear-coat (albedo ~0.65), gunmetal, soft-touch charcoal, amber and blue padding
const WHITE = B(0xd6d8da, 0.32, 0, 1);
const WHITE2 = B(0xc4c6c8, 0.5, 0, 1);
const GUN = B(0x6e737a, 0.34, 0.85, 2);
const GUND = B(0x474b51, 0.42, 0.8, 2);
const CHAR = B(0x2a2c2f, 0.74, 0, 1);
const MAT = B(0x232427, 0.86, 0, 3);
const FACE = B(0x34373b, 0.52, 0, 1);
const BLACK = B(0x151618, 0.55, 0, 1);
const GLOSS = B(0x0d0e10, 0.15, 0, 0);
const RUBBER = B(0x1b1c1e, 0.84, 0, 3);
const LEATHER = B(0x1f1f21, 0.46, 0, 3);
const AMBERP = B(0xcf6419, 0.55, 0, 3);
const BLUEP = B(0x3b6c9c, 0.62, 0, 4);
const METAL = B(0xc9ccd0, 0.22, 1, 2);
const STEEL = B(0x9ea2a8, 0.36, 1, 2);
const DMETAL = B(0x55585e, 0.3, 1, 2);
const REDP = B(0xb0241a, 0.16, 0, 0);
const ORANGE = B(0xe3711c, 0.36, 0, 0);
const STRAP = B(0x2f2e2c, 0.86, 0, 4);
const CABLE = B(0x17181a, 0.55, 0, 4);
const CABLEB = B(0x2b5079, 0.5, 0, 4);
const CABLEO = B(0xb5561b, 0.5, 0, 4);
const PAINT = B(0xffffff, 0.4, 0, 1); // decal carrier: the decal texture gives the colour

const LAMP_OFF: RGB = [0.05, 0.055, 0.06];
const PLACARD: RGB = [0.3, 0.32, 0.34];
const LED: RGB = [0.85, 0.92, 1.0];
/** Brightness of the glowing things and of the screens (x display gain). */
const K_EM = 1.25;
const K_SCREEN = 2.4;
const STICK_TILT = 0.4;
/** From the worn harness buckle to the middle of the seat it belongs to, ship axes, m; and the seat's touch radius. */
const SEAT_OFFSET = new THREE.Vector3(0, -0.2, 0.2);
const SEAT_RADIUS = 0.27;
const GUARD_HINGE = 0.03;

class Geo {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  pbr: number[] = [];
  idx: number[] = [];
  /** Default uv (a white texel of the decal atlas for hardware, black for glow). */
  du = 0;
  dv = 0;
  /** Cavity occlusion written with the next vertices (1 = open). */
  ao = 1;
  private readonly m = new THREE.Matrix4();
  private readonly nm = new THREE.Matrix3();
  private readonly p = new THREE.Vector3();
  private readonly n = new THREE.Vector3();

  /** Build in this frame. `local` keeps positions in the frame's own coordinates (moving parts; `within` then
   * places the shape inside that frame). */
  frame(f: THREE.Matrix4, local = false, within?: THREE.Matrix4): void {
    if (local && within) this.m.copy(within);
    else if (local) this.m.identity();
    else this.m.copy(f);
    this.nm.getNormalMatrix(this.m);
  }
  get count(): number {
    return this.pos.length / 3;
  }
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, b: Brush, u = NaN, w = NaN): number {
    const i = this.pos.length / 3;
    this.p.set(x, y, z).applyMatrix4(this.m);
    this.pos.push(this.p.x, this.p.y, this.p.z);
    this.n.set(nx, ny, nz).applyMatrix3(this.nm).normalize();
    this.nrm.push(this.n.x, this.n.y, this.n.z);
    this.col.push(b.c[0], b.c[1], b.c[2]);
    this.uv.push(Number.isNaN(u) ? this.du : u, Number.isNaN(w) ? this.dv : w);
    this.pbr.push(b.r, b.m, b.d, this.ao);
    return i;
  }
  /** A triangle, wound so that its face agrees with its vertex normals (front faces only are drawn). */
  tri(a: number, b: number, c: number): void {
    const P = this.pos;
    const N = this.nrm;
    const ux = P[b * 3] - P[a * 3];
    const uy = P[b * 3 + 1] - P[a * 3 + 1];
    const uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3];
    const vy = P[c * 3 + 1] - P[a * 3 + 1];
    const vz = P[c * 3 + 2] - P[a * 3 + 2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const d = cx * (N[a * 3] + N[b * 3] + N[c * 3]) + cy * (N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1]) + cz * (N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2]);
    if (d < 0) this.idx.push(a, c, b);
    else this.idx.push(a, b, c);
  }
  q(a: number, b: number, c: number, d: number): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }
  /** A flat rectangle in the frame's x/y plane at height z, facing +z. Returns its first vertex. */
  rect(cx: number, cy: number, z: number, w: number, h: number, b: Brush, uv?: UVR): number {
    const u0 = uv ? uv[0] : NaN;
    const v0 = uv ? uv[1] : NaN;
    const u1 = uv ? uv[2] : NaN;
    const v1 = uv ? uv[3] : NaN;
    const a = this.v(cx - w / 2, cy - h / 2, z, 0, 0, 1, b, u0, v0);
    const bb = this.v(cx + w / 2, cy - h / 2, z, 0, 0, 1, b, u1, v0);
    const cc = this.v(cx + w / 2, cy + h / 2, z, 0, 0, 1, b, u1, v1);
    const d = this.v(cx - w / 2, cy + h / 2, z, 0, 0, 1, b, u0, v1);
    this.q(a, bb, cc, d);
    return a;
  }
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, b: Brush): void {
    const C = [cx, cy, cz];
    const H = [hx, hy, hz];
    const p = [0, 0, 0];
    const n = [0, 0, 0];
    for (let ax = 0; ax < 3; ax++) {
      const u = (ax + 1) % 3;
      const w = (ax + 2) % 3;
      for (let sg = -1; sg <= 1; sg += 2) {
        n[0] = n[1] = n[2] = 0;
        n[ax] = sg;
        p[ax] = C[ax] + sg * H[ax];
        const i: number[] = [];
        for (const [k0, k1] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          p[u] = C[u] + k0 * H[u];
          p[w] = C[w] + k1 * H[w];
          i.push(this.v(p[0], p[1], p[2], n[0], n[1], n[2], b));
        }
        this.q(i[0], i[1], i[2], i[3]);
      }
    }
  }
  /**
   * A box with rounded edges of radius r (cs steps per quarter round), smooth normals. `puff` bulges one face
   * like a cushion: [axis, sign, height m, subdivisions of the flat part].
   */
  rbox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, r: number, cs: number, b: Brush, puff?: readonly [number, number, number, number]): void {
    const H = [hx, hy, hz];
    r = Math.max(1e-4, Math.min(r, hx * 0.999, hy * 0.999, hz * 0.999));
    const A = [hx - r, hy - r, hz - r];
    const mid = puff ? Math.max(1, puff[3]) : 1;
    const samples = (k: number): number[] => {
      const s: number[] = [];
      for (let j = 0; j <= cs; j++) s.push(-A[k] - r * Math.cos(((j / cs) * Math.PI) / 2));
      for (let j = 1; j < mid; j++) s.push(-A[k] + (2 * A[k] * j) / mid);
      for (let j = cs; j >= 0; j--) s.push(A[k] + r * Math.cos(((j / cs) * Math.PI) / 2));
      return s;
    };
    const S3 = [samples(0), samples(1), samples(2)];
    const p = [0, 0, 0];
    const q = [0, 0, 0];
    const nn = [0, 0, 0];
    for (let ax = 0; ax < 3; ax++) {
      const u = (ax + 1) % 3;
      const w = (ax + 2) % 3;
      const Su = S3[u];
      const Sw = S3[w];
      for (let sg = -1; sg <= 1; sg += 2) {
        const base = this.count;
        const bulge = puff && puff[0] === ax && puff[1] === sg ? puff[2] : 0;
        for (let i = 0; i < Su.length; i++) {
          for (let j = 0; j < Sw.length; j++) {
            p[ax] = sg * H[ax];
            p[u] = Su[i];
            p[w] = Sw[j];
            let l = 0;
            for (let k = 0; k < 3; k++) {
              q[k] = Math.min(A[k], Math.max(-A[k], p[k]));
              nn[k] = p[k] - q[k];
              l += nn[k] * nn[k];
            }
            l = Math.sqrt(l) || 1;
            for (let k = 0; k < 3; k++) nn[k] /= l;
            let ox = q[0] + nn[0] * r;
            let oy = q[1] + nn[1] * r;
            let oz = q[2] + nn[2] * r;
            if (bulge) {
              const fu = A[u] > 0 ? q[u] / A[u] : 0;
              const fw = A[w] > 0 ? q[w] / A[w] : 0;
              const f = (1 - fu * fu) * (1 - fw * fw);
              const o = [0, 0, 0];
              o[ax] = sg * bulge * f;
              ox += o[0];
              oy += o[1];
              oz += o[2];
              // tilt the normal down the slope of the bulge
              const gu = A[u] > 0 ? (-2 * fu * (1 - fw * fw) * bulge) / A[u] : 0;
              const gw = A[w] > 0 ? (-2 * fw * (1 - fu * fu) * bulge) / A[w] : 0;
              const wgt = Math.max(0, nn[ax] * sg);
              nn[u] -= gu * sg * nn[ax] * wgt;
              nn[w] -= gw * sg * nn[ax] * wgt;
            }
            this.v(cx + ox, cy + oy, cz + oz, nn[0], nn[1], nn[2], b);
          }
        }
        for (let i = 0; i < Su.length - 1; i++) {
          for (let j = 0; j < Sw.length - 1; j++) {
            const a0 = base + i * Sw.length + j;
            this.q(a0, a0 + Sw.length, a0 + Sw.length + 1, a0 + 1);
          }
        }
      }
    }
  }
  /** A surface of revolution about the frame's +z through (ox, oy): profile points [radius, z], bottom to top. */
  lathe(prof: readonly (readonly [number, number])[], seg: number, c: Brush | readonly Brush[], o: { x?: number; y?: number; sx?: number; sy?: number; smooth?: boolean } = {}): void {
    const ox = o.x ?? 0;
    const oy = o.y ?? 0;
    const sx = o.sx ?? 1;
    const sy = o.sy ?? 1;
    const tan = (i: number, j: number): [number, number] => {
      const a = prof[Math.max(0, i)];
      const b = prof[Math.min(prof.length - 1, j)];
      const dr = b[0] - a[0];
      const dz = b[1] - a[1];
      const l = Math.hypot(dr, dz) || 1;
      return [dz / l, -dr / l];
    };
    const list = Array.isArray(c) ? (c as readonly Brush[]) : null;
    for (let b = 0; b < prof.length - 1; b++) {
      const [r0, z0] = prof[b];
      const [r1, z1] = prof[b + 1];
      const cc = list ? list[Math.min(b, list.length - 1)] : (c as Brush);
      const n0 = o.smooth ? tan(b - 1, b + 1) : tan(b, b + 1);
      const n1 = o.smooth ? tan(b, b + 2) : n0;
      const base = this.count;
      for (let j = 0; j <= seg; j++) {
        const a = (j / seg) * Math.PI * 2;
        const cs = Math.cos(a);
        const sn = Math.sin(a);
        this.v(ox + r0 * cs * sx, oy + r0 * sn * sy, z0, n0[0] * cs, n0[0] * sn, n0[1], cc);
        this.v(ox + r1 * cs * sx, oy + r1 * sn * sy, z1, n1[0] * cs, n1[0] * sn, n1[1], cc);
      }
      for (let j = 0; j < seg; j++) {
        const i = base + j * 2;
        this.q(i, i + 2, i + 3, i + 1);
      }
    }
  }
  /** A round bar between two points, capped. */
  bar(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number, seg: number, c: Brush): void {
    const w = new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0).normalize();
    const u = new THREE.Vector3().crossVectors(w, Math.abs(w.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)).normalize();
    const t = new THREE.Vector3().crossVectors(w, u);
    const base = this.count;
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const nx = u.x * Math.cos(a) + t.x * Math.sin(a);
      const ny = u.y * Math.cos(a) + t.y * Math.sin(a);
      const nz = u.z * Math.cos(a) + t.z * Math.sin(a);
      this.v(x0 + nx * r, y0 + ny * r, z0 + nz * r, nx, ny, nz, c);
      this.v(x1 + nx * r, y1 + ny * r, z1 + nz * r, nx, ny, nz, c);
    }
    for (let j = 0; j < seg; j++) {
      const i = base + j * 2;
      this.q(i, i + 2, i + 3, i + 1);
    }
    for (const [px, py, pz, s] of [[x0, y0, z0, -1], [x1, y1, z1, 1]] as const) {
      const cb = this.v(px, py, pz, w.x * s, w.y * s, w.z * s, c);
      for (let j = 0; j <= seg; j++) {
        const a = (j / seg) * Math.PI * 2;
        const nx = u.x * Math.cos(a) + t.x * Math.sin(a);
        const ny = u.y * Math.cos(a) + t.y * Math.sin(a);
        const nz = u.z * Math.cos(a) + t.z * Math.sin(a);
        this.v(px + nx * r, py + ny * r, pz + nz * r, w.x * s, w.y * s, w.z * s, c);
      }
      for (let j = 0; j < seg; j++) this.tri(cb, cb + 1 + j, cb + 2 + j);
    }
  }
  /** A polyline of round bars (cables, hoses). */
  tube(pts: readonly (readonly [number, number, number])[], r: number, seg: number, c: Brush): void {
    for (let i = 0; i + 1 < pts.length; i++) this.bar(pts[i][0], pts[i][1], pts[i][2], pts[i + 1][0], pts[i + 1][1], pts[i + 1][2], r, seg, c);
  }
  /** A convex profile of (y, z) points extruded along x (frame coordinates). A null brush skips that side. */
  prismX(prof: readonly (readonly [number, number])[], x0: number, x1: number, cols: readonly (Brush | null)[], cap: Brush | null): void {
    let cy = 0;
    let cz = 0;
    for (const p of prof) {
      cy += p[0] / prof.length;
      cz += p[1] / prof.length;
    }
    for (let i = 0; i < prof.length; i++) {
      const c = cols[i];
      if (!c) continue;
      const p = prof[i];
      const q = prof[(i + 1) % prof.length];
      let ny = q[1] - p[1];
      let nz = -(q[0] - p[0]);
      const l = Math.hypot(ny, nz) || 1;
      ny /= l;
      nz /= l;
      if (ny * ((p[0] + q[0]) / 2 - cy) + nz * ((p[1] + q[1]) / 2 - cz) < 0) {
        ny = -ny;
        nz = -nz;
      }
      const a = this.v(x0, p[0], p[1], 0, ny, nz, c);
      const b = this.v(x1, p[0], p[1], 0, ny, nz, c);
      const cc = this.v(x1, q[0], q[1], 0, ny, nz, c);
      const d = this.v(x0, q[0], q[1], 0, ny, nz, c);
      this.q(a, b, cc, d);
    }
    if (!cap) return;
    for (const [x, s] of [[x0, -1], [x1, 1]] as const) {
      const base = this.count;
      for (const p of prof) this.v(x, p[0], p[1], s, 0, 0, cap);
      for (let i = 1; i < prof.length - 1; i++) this.tri(base, base + i, base + i + 1);
    }
  }
  build(dynamic: boolean): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(new Float32Array(this.pos), 3);
    const na = new THREE.BufferAttribute(new Float32Array(this.nrm), 3);
    const ca = new THREE.BufferAttribute(new Float32Array(this.col), 3);
    if (dynamic) {
      pa.setUsage(THREE.DynamicDrawUsage);
      na.setUsage(THREE.DynamicDrawUsage);
      ca.setUsage(THREE.DynamicDrawUsage);
    }
    g.setAttribute('position', pa);
    g.setAttribute('normal', na);
    g.setAttribute('color', ca);
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('pbr', new THREE.BufferAttribute(new Float32Array(this.pbr), 4));
    g.setIndex(this.count > 65535 ? new THREE.BufferAttribute(new Uint32Array(this.idx), 1) : new THREE.BufferAttribute(new Uint16Array(this.idx), 1));
    g.computeBoundingSphere();
    return g;
  }
}

// ---- the hardware material: per-vertex PBR, procedural wear and micro-detail ---------------------------------
const NOISE = /* glsl */ `
varying vec4 vPbr;
varying vec3 vLoc;
float ckHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float ckNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(ckHash(i), ckHash(i + vec3(1, 0, 0)), f.x), mix(ckHash(i + vec3(0, 1, 0)), ckHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(ckHash(i + vec3(0, 0, 1)), ckHash(i + vec3(1, 0, 1)), f.x), mix(ckHash(i + vec3(0, 1, 1)), ckHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float ckFade(float freq, float fp) { return 1.0 - smoothstep(0.35 / freq, 1.1 / freq, fp); }
`;
const DETAIL = /* glsl */ `
float ckRough = 0.0;
float ckH = 0.0;
float ckAmp = 0.0;
{
  float fp = length(fwidth(vLoc));
#ifdef CK_DETAIL
  int kind = int(vPbr.z + 0.5);
  float grime = ckNoise(vLoc * 4.0) * 0.6 + ckNoise(vLoc * 19.0) * 0.4;
  if (kind == 1) {
    ckRough = (grime - 0.5) * 0.24;
    diffuseColor.rgb *= 1.0 - 0.14 * smoothstep(0.58, 0.86, grime);
    ckH = ckNoise(vLoc * 520.0);
    ckAmp = 0.00005 * ckFade(520.0, fp);
  } else if (kind == 2) {
    float s = ckNoise(vLoc * vec3(9.0, 1500.0, 1500.0));
    ckRough = (s - 0.5) * 0.2 + (grime - 0.5) * 0.14;
    ckH = s;
    ckAmp = 0.000015 * ckFade(1500.0, fp);
  } else if (kind == 3) {
    ckH = ckNoise(vLoc * 820.0) * 0.7 + ckNoise(vLoc * 260.0) * 0.3;
    ckRough = (ckH - 0.5) * 0.14 + (grime - 0.5) * 0.12;
    ckAmp = 0.00011 * ckFade(820.0, fp);
  } else if (kind == 4) {
    vec3 w = vLoc * 1300.0;
    ckH = 0.5 + 0.25 * sin(w.x + w.y * 0.7) * sin(w.z - w.y * 0.7) + 0.25 * ckNoise(vLoc * 400.0);
    ckAmp = 0.00008 * ckFade(1300.0, fp);
  }
#endif
}
`;
const BUMP = /* glsl */ `
{
  vec3 sx = dFdx(-vViewPosition);
  vec3 sy = dFdy(-vViewPosition);
  float hx = dFdx(ckH) * ckAmp;
  float hy = dFdy(ckH) * ckAmp;
  vec3 r1 = cross(sy, normal);
  vec3 r2 = cross(normal, sx);
  float det = dot(sx, r1);
  vec3 grad = sign(det) * (hx * r1 + hy * r2);
  normal = normalize(abs(det) * normal - grad);
}
`;
const AO = /* glsl */ `
{
  float ckAo = vPbr.w * mix(0.5, 1.0, smoothstep(-1.0, -0.2, vLoc.y));
  reflectedLight.indirectDiffuse *= ckAo;
  reflectedLight.indirectSpecular *= mix(1.0, ckAo, 0.7);
}
`;
function hardwareMaterial(map: THREE.Texture, detail: boolean): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, map, roughness: 0.5, metalness: 0 });
  if (detail) (m as unknown as { defines: Record<string, string> }).defines = { CK_DETAIL: '' };
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 pbr;\nvarying vec4 vPbr;\nvarying vec3 vLoc;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPbr = pbr;\nvLoc = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${DETAIL}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(vPbr.x + ckRough, 0.04, 1.0);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vPbr.y;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${BUMP}`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${AO}`);
  };
  m.customProgramCacheKey = () => (detail ? 'tidelock-cockpit-hw-d' : 'tidelock-cockpit-hw');
  return m;
}

/** Black glass over a display: reflective, slightly anti-glare, the picture as emission with a pixel grid that
 * shows only when the eye is close enough to resolve it. */
function glassMaterial(tex: THREE.Texture, w: number, h: number): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({ color: 0x040506, roughness: 0.13, metalness: 0, ior: 1.52, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: K_SCREEN });
  const texel = new THREE.Vector2(w, h);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTexel = { value: texel };
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec2 uTexel;').replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      #ifdef USE_EMISSIVEMAP
      {
        vec2 t = vEmissiveMapUv * uTexel;
        vec2 fw = fwidth(t);
        float k = 1.0 - smoothstep(0.22, 0.55, max(fw.x, fw.y));
        vec2 g = abs(fract(t) - 0.5) * 2.0;
        float cell = (1.0 - smoothstep(0.55, 1.0, g.x)) * (1.0 - smoothstep(0.65, 1.0, g.y));
        float sp = fract(t.x) * 3.0;
        vec3 sub = vec3(1.0 - step(1.0, sp), step(1.0, sp) * (1.0 - step(2.0, sp)), step(2.0, sp));
        totalEmissiveRadiance *= mix(vec3(1.0), (0.2 + 1.0 * cell) * (0.45 + 1.65 * sub), k);
      }
      #endif`,
    );
  };
  m.customProgramCacheKey = () => 'tidelock-cockpit-glass';
  return m;
}

// ---- the atlas of everything written or lit: lamp legends, placards, the highlight ring ----------------------
const AW = 1024;
const AH = 640;
interface Atlas {
  tex: THREE.CanvasTexture;
  lamp: Map<string, UVR>;
  placard: Map<string, UVR>;
  ring: UVR;
  white: UVR;
  dot: UVR;
  scale: UVR;
}
const SANS = '"Arial Narrow", "Helvetica Neue", Helvetica, Arial, sans-serif';
const EXTRA_PLACARDS = ['POWER', 'THERMAL', 'COMMS', 'EXT LIGHTS', 'BREAKERS', 'HOLO', 'LIFE SUPPORT', 'CORVANE'];
function makeAtlas(layout: CockpitLayout, aniso: number): Atlas {
  const cv = document.createElement('canvas');
  cv.width = AW;
  cv.height = AH;
  const c = cv.getContext('2d') as CanvasRenderingContext2D;
  c.fillStyle = '#000';
  c.fillRect(0, 0, AW, AH);
  const uvr = (x: number, y: number, w: number, h: number): UVR => [(x + 0.5) / AW, 1 - (y + h - 0.5) / AH, (x + w - 0.5) / AW, 1 - (y + 0.5) / AH];
  const fit = (s: string, cx: number, cy: number, maxW: number, px: number, color: string): void => {
    c.font = `700 ${px}px ${SANS}`;
    const w = c.measureText(s).width;
    if (w > maxW) c.font = `700 ${Math.floor((px * maxW) / w)}px ${SANS}`;
    c.fillStyle = color;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(s, cx, cy + 2);
  };
  const lamp = new Map<string, UVR>();
  const placard = new Map<string, UVR>();
  let li = 0;
  let pi = 0;
  const addPlacard = (label: string): void => {
    if (placard.has(label) || pi >= 32) return;
    const x = (pi % 4) * 256;
    const y = 256 + Math.floor(pi / 4) * 48;
    pi++;
    fit(label, x + 128, y + 24, 240, 36, '#fff');
    placard.set(label, uvr(x + 2, y + 2, 252, 44));
  };
  for (const d of layout.devices) {
    if (d.kind === 'button') {
      const x = (li % 8) * 128;
      const y = Math.floor(li / 8) * 128;
      li++;
      const round = d.role === 'targetNext';
      // the translucent cap: a diffuser fill, a thin frame, the engraved legend brightest
      const g = c.createRadialGradient(x + 64, y + 64, 8, x + 64, y + 64, 74);
      g.addColorStop(0, 'rgba(255,255,255,0.34)');
      g.addColorStop(1, 'rgba(255,255,255,0.16)');
      c.fillStyle = g;
      c.strokeStyle = 'rgba(255,255,255,0.55)';
      c.lineWidth = 3;
      c.beginPath();
      if (round) c.arc(x + 64, y + 64, 54, 0, Math.PI * 2);
      else c.roundRect(x + 8, y + 8, 112, 112, 14);
      c.fill();
      c.stroke();
      if (d.role === 'flightAssist') {
        fit('FLT', x + 64, y + 44, 92, 38, '#fff');
        fit('ASSIST', x + 64, y + 86, 92, 38, '#fff');
      } else fit(round ? 'NEXT' : d.label, x + 64, y + 64, round ? 80 : 96, 44, '#fff');
      lamp.set(d.id, uvr(x + 2, y + 2, 124, 124));
      if (round) addPlacard(d.label);
    } else if (d.kind !== 'rest') addPlacard(d.label);
  }
  addPlacard('ARMED');
  for (const p of EXTRA_PLACARDS) addPlacard(p);
  // the ring that shows under the hand
  const rx = 512;
  const ry = 128;
  const grd = c.createRadialGradient(rx + 64, ry + 64, 30, rx + 64, ry + 64, 62);
  grd.addColorStop(0, 'rgba(255,255,255,0)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.12)');
  grd.addColorStop(0.8, 'rgba(255,255,255,0.9)');
  grd.addColorStop(0.9, 'rgba(255,255,255,0.35)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = grd;
  c.fillRect(rx, ry, 128, 128);
  c.fillStyle = '#fff';
  c.fillRect(640, 128, 64, 64);
  const dg = c.createRadialGradient(736, 160, 2, 736, 160, 30);
  dg.addColorStop(0, '#fff');
  dg.addColorStop(0.45, 'rgba(255,255,255,0.7)');
  dg.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = dg;
  c.fillRect(704, 128, 64, 64);
  // throttle scale: detent ticks and numbers up a tall cell, 0 at the bottom
  const sx0 = 768;
  const sy0 = 128;
  c.fillStyle = '#fff';
  for (let i = 0; i <= 20; i++) {
    const y = sy0 + 118 - i * 5.4;
    c.fillRect(sx0 + 4, y - 1, i % 5 === 0 ? 22 : 10, i % 5 === 0 ? 3 : 2);
  }
  c.font = `700 20px ${SANS}`;
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  c.fillText('0', sx0 + 32, sy0 + 117);
  c.fillText('50', sx0 + 32, sy0 + 65);
  c.fillText('100', sx0 + 30, sy0 + 12);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = aniso;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return { tex, lamp, placard, ring: uvr(rx, ry, 128, 128), white: uvr(650, 138, 44, 44), dot: uvr(704, 128, 64, 64), scale: uvr(sx0, sy0, 64, 128) };
}

// ---- printed decals on the hardware (multiplied into its albedo): hazard stripes, vents, maker's marks --------
interface Decals {
  tex: THREE.CanvasTexture;
  white: [number, number];
  stripes: UVR;
  grille: UVR;
  logo: UVR;
  serial: UVR;
  warn: UVR;
}
function makeDecals(aniso: number): Decals {
  const W = 512;
  const H = 256;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const c = cv.getContext('2d') as CanvasRenderingContext2D;
  c.fillStyle = '#fff';
  c.fillRect(0, 0, W, H);
  const uvr = (x: number, y: number, w: number, h: number): UVR => [(x + 1) / W, 1 - (y + h - 1) / H, (x + w - 1) / W, 1 - (y + 1) / H];
  // hazard stripes (yellow / black, 45 degrees), with a little wear
  c.save();
  c.beginPath();
  c.rect(64, 0, 128, 64);
  c.clip();
  c.fillStyle = '#e2b11c';
  c.fillRect(64, 0, 128, 64);
  c.fillStyle = '#161616';
  for (let x = 0; x < 260; x += 32) {
    c.beginPath();
    c.moveTo(64 + x, 0);
    c.lineTo(64 + x + 16, 0);
    c.lineTo(64 + x + 16 - 64, 64);
    c.lineTo(64 + x - 64, 64);
    c.fill();
  }
  c.restore();
  // vent grille: dark slots
  c.fillStyle = '#5a5a5a';
  c.fillRect(0, 128, 256, 128);
  c.fillStyle = '#0a0a0a';
  for (let y = 136; y < 248; y += 14) for (let x = 8; x < 248; x += 60) c.fillRect(x, y, 52, 7);
  // maker's mark and serials (dark print on the white panels)
  c.fillStyle = '#2a2d31';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.font = `700 40px ${SANS}`;
  c.fillText('C O R V A N E', 352, 34);
  c.font = `700 26px ${SANS}`;
  c.fillText('WREN  ·  CV-W 2207  ·  FLIGHT DECK', 256, 96);
  c.fillStyle = '#8a1c14';
  c.font = `700 22px ${SANS}`;
  c.fillText('KEEP CLEAR · MOVING CONTROLS', 384, 160);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = aniso;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return { tex, white: [24 / W, 1 - 24 / H], stripes: uvr(64, 0, 128, 64), grille: uvr(0, 128, 256, 128), logo: uvr(200, 8, 304, 52), serial: uvr(16, 76, 480, 40), warn: uvr(264, 140, 240, 40) };
}

interface Bundle {
  room: string;
  /** Stations, seats, fittings, fixed parts of devices (cast shadows). */
  S: Geo;
  /** Moving parts. */
  M: Geo;
  /** Everything that glows (additive). */
  E: Geo;
  mPos: THREE.BufferAttribute | null;
  mNrm: THREE.BufferAttribute | null;
  mBase: Float32Array | null;
  mNBase: Float32Array | null;
  eCol: THREE.BufferAttribute | null;
  ePos: THREE.BufferAttribute | null;
}
interface Dev {
  def: DeviceDef;
  kind: DeviceKind;
  bun: Bundle;
  pos: THREE.Vector3;
  R: THREE.Vector3;
  U: THREE.Vector3;
  N: THREE.Vector3;
  frame: THREE.Matrix4;
  /** Touch shape: a segment (a = b for a point) with a radius, or the rectangle hw x hh in the device plane. */
  a: THREE.Vector3;
  b: THREE.Vector3;
  r: number;
  rect: boolean;
  hw: number;
  hh: number;
  /** Rocker: which local axis it rocks along (0 = right, 1 = up). */
  axis: number;
  /** Emissive vertices to recolour with the lamp (first vertex, count), its halo quad, and its lit colour. */
  lampV: number;
  lampN: number;
  haloV: number;
  lampC: RGB;
  offC: RGB;
  lit: boolean | null;
  /** Buckle: where the touch target is while the harness is not worn (on the seat). */
  alt: THREE.Vector3 | null;
}
interface Part {
  dev: number;
  bun: Bundle;
  v0: number;
  v1: number;
  move: (x: number, y: number, m: THREE.Matrix4) => void;
  lx: number;
  ly: number;
}

export function createCockpitVisual(layout: CockpitLayout, opts: { quality: Quality }): CockpitVisual {
  const q = opts.quality;
  const lo = q === 'low';
  const seg = lo ? 14 : q === 'medium' ? 18 : 24;
  const cs = lo ? 1 : 2;
  const aniso = lo ? 4 : 8;
  const canvasScale = q === 'high' || q === 'ultra' ? 1.5 : q === 'medium' ? 1.25 : 1;
  const atlas = makeAtlas(layout, aniso);
  const decals = makeDecals(aniso);
  const devs: Dev[] = [];
  const parts: Part[] = [];
  const tmp = new THREE.Matrix4();
  const tmp2 = new THREE.Matrix4();
  const I = new THREE.Matrix4();
  const bundles = new Map<string, Bundle>();
  const bundle = (room: string): Bundle => {
    let b = bundles.get(room);
    if (!b) {
      b = { room, S: new Geo(), M: new Geo(), E: new Geo(), mPos: null, mNrm: null, mBase: null, mNBase: null, eCol: null, ePos: null };
      for (const g of [b.S, b.M]) {
        g.du = decals.white[0];
        g.dv = decals.white[1];
      }
      bundles.set(room, b);
    }
    return b;
  };
  const ck = bundle('cockpit');
  const D = new Geo(); // the dashboard shell, side consoles, overhead panels, pedestal (receive and cast)
  D.du = decals.white[0];
  D.dv = decals.white[1];
  const S = ck.S;
  const E = ck.E;
  const aux = new Geo(); // side-console glass
  const upM = (x: number, y: number, z: number): THREE.Matrix4 => tmp.makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0)).setPosition(x, y, z);
  const ALONG_Z = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0));
  /** A panel frame: origin, outward normal, panel up (right = up x normal). */
  const panel = (o: THREE.Vector3, n: THREE.Vector3, up: THREE.Vector3): THREE.Matrix4 => {
    const N = n.clone().normalize();
    const U = up.clone().addScaledVector(N, -up.dot(N)).normalize();
    const R = new THREE.Vector3().crossVectors(U, N).normalize();
    return new THREE.Matrix4().makeBasis(R, U, N).setPosition(o);
  };
  const placardIn = (g: Geo, label: string, cx: number, cy: number, z: number, h: number, c: RGB = PLACARD): void => {
    const uv = atlas.placard.get(label);
    if (uv) g.rect(cx, cy, z, h * (252 / 44), h, glow(c), uv);
  };
  // a small toggle switch on a panel (static): base nut and bat
  const toggleAt = (g: Geo, f: THREE.Matrix4, x: number, y: number, up: boolean): void => {
    g.frame(tmp2.copy(f).multiply(new THREE.Matrix4().makeTranslation(x, y, 0)));
    g.lathe([[0.0065, 0], [0.0065, 0.004], [0.0045, 0.0055]], 6, GUND);
    g.frame(tmp2.copy(f).multiply(new THREE.Matrix4().makeTranslation(x, y, 0)).multiply(new THREE.Matrix4().makeRotationX(up ? -0.45 : 0.45)));
    g.lathe([[0.0022, 0.004], [0.0028, 0.016], [0.0036, 0.02], [0, 0.0215]], 6, METAL, { smooth: true });
  };
  const knobAt = (g: Geo, f: THREE.Matrix4, x: number, y: number, r: number): void => {
    g.frame(tmp2.copy(f).multiply(new THREE.Matrix4().makeTranslation(x, y, 0)));
    g.lathe([[r * 1.3, 0], [r * 1.3, 0.002], [r, 0.003], [r, 0.014], [r * 0.85, 0.016], [0, 0.0165]], lo ? 10 : 16, [GUN, GUN, RUBBER, RUBBER, METAL]);
  };
  const breakerAt = (g: Geo, f: THREE.Matrix4, x: number, y: number, pulled: boolean): void => {
    g.frame(tmp2.copy(f).multiply(new THREE.Matrix4().makeTranslation(x, y, 0)));
    const h = pulled ? 0.016 : 0.009;
    g.lathe([[0.0055, 0], [0.0055, 0.002], [0.0042, 0.003], [0.0042, h], [0, h + 0.0005]], 8, [GUND, GUND, GLOSS, GLOSS]);
  };

  // ---- the room this cockpit sits in (src/data/interiors.ts): dashboard, side consoles, pedestal, seats
  const il = INTERIORS[layout.shipId];
  const room = il ? il.rooms.find((r) => r.id === 'cockpit') : undefined;
  const solid = (id: string): Box | null => (il ? il.solids.find((s) => s.id === id)?.box ?? null : null);
  const st = layout.station;
  const con = solid('console');
  const yF = room ? room.box.min.y : -1;
  const COPX = st ? -2 * st.faceOrigin.x : 0; // the co-pilot station: the pilot's, moved across the centreline
  let holo: THREE.Vector3 | null = null;
  let pilotBack: THREE.Matrix4 | null = null;
  let pilotSeatC = 0;
  let pilotSeatZ = 0;

  if (room && con) {
    const X0 = room.box.min.x + 0.003;
    const X1 = room.box.max.x - 0.003;
    const zF = con.min.z;
    const zB = con.max.z;
    const yT = con.max.y;
    // dashboard: a dark glare-shield top over a white sculpted face, a gunmetal chamfer between them
    const A_: [number, number] = [yT - 0.32, zF];
    const B_: [number, number] = [yT - 0.035, zF + 0.08];
    const C_: [number, number] = [yT, zF + 0.38];
    const D_: [number, number] = [yT - 0.02, zF + 0.58];
    const E_: [number, number] = [yT - 0.07, zF + 0.64];
    const F_: [number, number] = [yT - 0.36, zB - 0.01];
    const G_: [number, number] = [yT - 0.44, zB - 0.09];
    D.frame(I);
    D.prismX([A_, B_, C_, D_, E_, F_, G_], X0, X1, [CHAR, CHAR, CHAR, GUN, WHITE, WHITE2, GUND], WHITE);
    // the face's frame (right +x, up the face, out toward the crew)
    const fu = new THREE.Vector3(0, E_[0] - F_[0], E_[1] - F_[1]).normalize();
    const fn = new THREE.Vector3(0, -fu.z, fu.y);
    if (fn.z < 0) fn.negate();
    const fo = new THREE.Vector3(0, (E_[0] + F_[0]) / 2, (E_[1] + F_[1]) / 2);
    const faceAt = (x: number, lift = 0): THREE.Matrix4 => panel(fo.clone().setX(x).addScaledVector(fn, lift), fn, fu);
    const halfFace = Math.hypot(E_[0] - F_[0], E_[1] - F_[1]) / 2;
    // outboard: a raised white cowl with an inset switch panel, each side of the stations
    const inner = st ? Math.max(Math.abs(st.x0), Math.abs(st.x1)) + 0.05 : 0.9;
    for (const sx of [-1, 1]) {
      const cx = (sx * (inner + X1)) / 2;
      const hw = (X1 - inner) / 2 - 0.02;
      const f = faceAt(cx);
      D.frame(f);
      D.rbox(0, -0.005, 0.012, hw, halfFace - 0.02, 0.014, 0.012, cs, WHITE);
      D.box(0, -0.01, 0.0265, hw - 0.05, halfFace - 0.075, 0.0012, FACE);
      for (let k = 0; k < 6; k++) toggleAt(D, f, -hw + 0.09 + k * 0.05, 0.02, k % 3 !== 1);
      D.frame(f);
      for (let k = 0; k < 2; k++) knobAt(D, tmp.copy(f).multiply(new THREE.Matrix4().makeTranslation(0, 0, 0.027)), hw - 0.16 + k * 0.09, -0.02, 0.012);
      D.frame(f);
      E.frame(f);
      placardIn(E, sx < 0 ? 'EXT LIGHTS' : 'COMMS', -hw + 0.21, 0.065, 0.0285, 0.011);
      if (sx > 0) D.rect(0, -halfFace + 0.03, 0.0275, 0.22, 0.026, PAINT, decals.serial);
      D.frame(f);
      D.box(0, halfFace - 0.032, 0.0275, hw - 0.05, 0.0012, 0.0008, GUN);
    }
    // centre: maker's mark, a vent, the hologram projector on the crest
    const fc = faceAt(0);
    D.frame(fc);
    D.rect(0, 0.06, 0.0012, 0.17, 0.028, PAINT, decals.logo);
    D.rect(0, -0.07, 0.0012, 0.2, 0.06, GUND, decals.grille);
    holo = new THREE.Vector3(st ? (st.x1 + 0) / 2 - 0.005 : 0, C_[0], C_[1]);
    D.frame(upM(holo.x, holo.y - 0.004, holo.z));
    D.lathe([[0.062, 0], [0.062, 0.006], [0.054, 0.012], [0.042, 0.012], [0.04, 0.008]], seg, [GUN, GUN, GUN, BLACK]);
    D.lathe([[0.04, 0.008], [0.034, 0.011], [0, 0.0125]], seg, GLOSS);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + 0.5;
      D.bar(Math.cos(a) * 0.05, Math.sin(a) * 0.05, 0.01, Math.cos(a) * 0.044, Math.sin(a) * 0.044, 0.04, 0.0028, 6, METAL);
    }
    E.frame(upM(holo.x, holo.y + 0.0095, holo.z));
    E.rect(0, 0, 0, 0.09, 0.09, glow([0.15, 0.55, 0.7]), atlas.ring);
    E.frame(faceAt(holo.x, 0));
    placardIn(E, 'HOLO', 0, halfFace - 0.03, 0.002, 0.01);
    // a cool-white LED line under the dash lip, onto the knees
    E.frame(new THREE.Matrix4().makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -1, 0)).setPosition(0, G_[0] - 0.003, G_[1] - 0.03));
    E.rect(0, 0, 0, X1 - X0 - 0.3, 0.006, glow(LED), atlas.white);
    // knee wall with vents, cable runs and clips under the dash
    const kz = zF + 0.4;
    const kTop = A_[0] + ((G_[0] - A_[0]) * (kz - A_[1])) / (G_[1] - A_[1]);
    D.frame(I);
    D.ao = 0.45;
    D.box(0, (yF + kTop) / 2, kz, (X1 - X0) / 2, (kTop - yF) / 2, 0.02, GUND);
    for (const x of [-1.05, -0.4, 0.4, 1.05]) D.rect(x, -0.72, kz + 0.0205, 0.34, 0.14, GUND, decals.grille);
    const runs: [Brush, number, number, number][] = [[CABLE, -0.02, 0.012, 0.03], [CABLE, 0.02, 0.009, 0.045], [CABLEB, 0.0, 0.007, 0.05], [CABLEO, 0.04, 0.006, 0.04], [CABLE, 0.06, 0.011, 0.035]];
    const cz0 = (kz + G_[1]) / 2;
    for (const [b, dz, r, sag] of runs) {
      const pts: [number, number, number][] = [];
      const n = 24;
      for (let i = 0; i <= n; i++) {
        const x = X0 + 0.15 + ((X1 - X0 - 0.3) * i) / n;
        const ph = ((x - X0) / 0.45) % 1;
        pts.push([x, kTop - 0.05 - r - sag * Math.sin(Math.PI * ph), cz0 + dz]);
      }
      D.tube(pts, r, lo ? 5 : 6, b);
    }
    for (let x = X0 + 0.15; x < X1 - 0.1; x += 0.45) D.box(x, kTop - 0.05, cz0 + 0.02, 0.012, 0.012, 0.06, GUN);
    D.ao = 1;
    // grab handles at the windscreen pillars
    for (const sx of [-1, 1]) {
      const x = sx * (X1 - 0.17);
      const z = zF + 0.12;
      D.bar(x, yT + 0.12, z, x, yT + 0.6, z, 0.011, seg, METAL);
      for (const y of [yT + 0.15, yT + 0.57]) D.bar(x, y, z, x + sx * 0.12, y, z, 0.008, 10, GUN);
      D.bar(x, yT + 0.3, z, x, yT + 0.42, z, 0.0135, seg, RUBBER);
    }

    // side consoles at the elbows: white shell, inset dark top with a display, switches, breakers; blue padding
    for (const [id, s] of [['console-port', -1], ['console-stbd', 1]] as const) {
      const bx = solid(id);
      if (!bx) continue;
      const xi = s < 0 ? bx.max.x : bx.min.x;
      const xo = s < 0 ? bx.min.x + 0.003 : bx.max.x - 0.003;
      const yt = bx.max.y;
      const z0 = bx.min.z;
      const z1 = bx.max.z;
      const ax = (a: number): number => xi + s * a; // a metres outboard of the inner face
      const wo = Math.abs(xo - xi);
      D.frame(ALONG_Z);
      D.prismX([[ax(0), yF], [ax(0), yt - 0.12], [ax(0.04), yt - 0.05], [ax(wo - 0.08), yt], [xo, yt - 0.03], [xo, yF]], z0, z1, [WHITE, GUN, WHITE, WHITE2, null, null], WHITE);
      // gunmetal end ribs
      D.frame(I);
      for (const z of [z0 + 0.015, z1 - 0.015]) D.rbox((ax(0) + xo) / 2, (yF + yt) / 2 - 0.01, z, wo / 2 + 0.006, (yt - yF) / 2 - 0.005, 0.016, 0.006, 1, GUN);
      // blue padded panels on the inner face, stitched in three
      for (let k = 0; k < 3; k++) {
        const len = (z1 - z0 - 0.12) / 3;
        D.rbox(ax(-0.012), yt - 0.38, z0 + 0.06 + len * (k + 0.5), 0.014, 0.15, len / 2 - 0.006, 0.012, cs, BLUEP, [0, -s, 0.006, 3]);
      }
      // the top panel
      const tn = new THREE.Vector3(-s * 0.05, wo - 0.12, 0).normalize();
      const tc = new THREE.Vector3((ax(0.04) + ax(wo - 0.08)) / 2, (yt - 0.05 + yt) / 2, (z0 + z1) / 2);
      const tf = panel(tc, tn, new THREE.Vector3(0, 0, -1));
      const tw = Math.hypot(wo - 0.12, 0.05) / 2;
      const tl = (z1 - z0) / 2;
      D.frame(tf);
      D.box(0, 0, 0.0012, tw - 0.03, tl - 0.05, 0.0012, FACE);
      // the display, its bezel, near the dashboard end
      const sy = tl - 0.19;
      D.rbox(0, sy, 0.006, 0.11, 0.072, 0.006, 0.004, 1, BLACK);
      aux.frame(tf);
      aux.rect(0, sy, 0.0122, 0.19, 0.125, PAINT, s < 0 ? [0, 0.5, 1, 1] : [0, 0, 1, 0.5]);
      for (let r = 0; r < 2; r++) for (let k = 0; k < 4; k++) toggleAt(D, tf, -0.075 + k * 0.05, sy - 0.14 - r * 0.06, (k + r) % 2 === 0);
      for (let k = 0; k < 2; k++) knobAt(D, tf, -0.05 + k * 0.1, sy - 0.32, 0.014);
      for (let r = 0; r < 3; r++) for (let k = 0; k < 6; k++) breakerAt(D, tf, -0.09 + k * 0.036, sy - 0.45 - r * 0.04, (k * 7 + r * 3) % 11 === 0);
      E.frame(tf);
      placardIn(E, s < 0 ? 'POWER' : 'THERMAL', 0, sy + 0.088, 0.003, 0.011);
      placardIn(E, 'BREAKERS', 0, sy - 0.405, 0.003, 0.009);
      placardIn(E, s < 0 ? 'LIFE SUPPORT' : 'COMMS', 0, sy - 0.1, 0.003, 0.009);
    }

    // overhead switch panels in the upper corners, beside the overhead window
    for (const s of [-1, 1]) {
      const zA = zF + 0.55;
      const zZ = zB + 1.3;
      const yC = room.box.max.y - 0.003;
      D.frame(ALONG_Z);
      D.prismX([[s * 1.02, yC], [s * (X1 - 0.003), yC], [s * (X1 - 0.003), yC - 0.4], [s * (X1 - 0.08), yC - 0.42]], zA, zZ, [null, null, GUN, FACE], WHITE);
      const p0 = new THREE.Vector3(s * (X1 - 0.08), yC - 0.42, 0);
      const p1 = new THREE.Vector3(s * 1.02, yC, 0);
      const dir = p1.clone().sub(p0);
      const pc = p0.clone().addScaledVector(dir, 0.5).setZ((zA + zZ) / 2);
      const pn = new THREE.Vector3(-s * dir.y, s * dir.x, 0).normalize();
      if (pn.y > 0) pn.negate();
      const pf = panel(pc.addScaledVector(pn, 0.001), pn, new THREE.Vector3(0, 0, -1));
      const pw = dir.length() / 2;
      const pl = (zZ - zA) / 2;
      D.frame(pf);
      for (const yy of [-pl + 0.012, pl - 0.012]) D.rbox(0, yy, 0.006, pw - 0.01, 0.012, 0.006, 0.004, 1, WHITE);
      for (let r = 0; r < 3; r++) for (let k = 0; k < 9; k++) toggleAt(D, pf, -pw + 0.1 + r * 0.17, pl - 0.12 - k * 0.07, (k + r) % 3 !== 0);
      for (let r = 0; r < 2; r++) for (let k = 0; k < 12; k++) breakerAt(D, pf, -pw + 0.13 + r * 0.06, -pl + 0.12 + k * 0.045, (k + r * 5) % 7 === 0);
      // a guarded pair (red covers)
      D.frame(pf);
      for (let k = 0; k < 2; k++) D.rbox(pw - 0.12, -pl + 0.2 + k * 0.08, 0.012, 0.016, 0.026, 0.012, 0.004, 1, REDP);
      // the grab rail along the inner edge
      D.frame(I);
      const xr = s * 1.06;
      D.bar(xr, yC - 0.09, zA + 0.2, xr, yC - 0.09, zZ - 0.2, 0.0115, seg, METAL);
      for (const z of [zA + 0.25, zZ - 0.25]) D.bar(xr, yC - 0.09, z, xr, yC, z, 0.008, 10, GUN);
    }

    // the centre pedestal between the seats
    const pd = solid('pedestal');
    if (pd) {
      const hx = (pd.max.x - pd.min.x) / 2;
      const px = (pd.max.x + pd.min.x) / 2;
      const yt = pd.max.y;
      D.frame(ALONG_Z);
      D.prismX([[px - hx, yF], [px + hx, yF], [px + hx, yt - 0.07], [px + hx - 0.03, yt], [px - hx + 0.03, yt], [px - hx, yt - 0.07]], pd.min.z, pd.max.z, [null, WHITE, GUN, CHAR, GUN, WHITE], WHITE);
      const pf = panel(new THREE.Vector3(px, yt + 0.0005, (pd.min.z + pd.max.z) / 2), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1));
      const pl = (pd.max.z - pd.min.z) / 2;
      for (let k = 0; k < 3; k++) knobAt(D, pf, -0.09 + k * 0.09, pl - 0.09, 0.015);
      for (let k = 0; k < 4; k++) toggleAt(D, pf, -0.09 + k * 0.06, pl - 0.2, k % 2 === 0);
      D.frame(pf);
      D.lathe([[0.04, 0.001], [0.036, -0.002]], seg, GUN, { y: -pl + 0.12 });
      D.lathe([[0.036, -0.002], [0.034, -0.06], [0, -0.06]], seg, GUND, { y: -pl + 0.12 });
      for (const sx of [-1, 1]) D.rbox(sx * (hx - 0.004), 0, -0.2, 0.01, pl - 0.06, 0.12, 0.008, cs, BLUEP, [0, sx, 0.004, 2]);
      E.frame(pf);
      placardIn(E, 'HOLO', -0.09, pl - 0.045, 0.001, 0.009);
    }
  }

  // ---- the seats: sculpted shells on black frames, amber inserts, bolsters, headrest, rails, harness
  const looseHarness = (set: (m: THREE.Matrix4) => void, g: Geo, back: THREE.Matrix4, cx: number, zc: number): void => {
    set(back);
    for (const sx of [-1, 1]) {
      g.box(sx * 0.075, 0.43, -0.069, 0.021, 0.3, 0.0025, STRAP);
      g.box(sx * 0.085, 0.13, -0.071, 0.016, 0.024, 0.003, METAL);
      g.box(sx * 0.075, 0.7, -0.06, 0.03, 0.012, 0.012, GUN);
    }
    set(tmp2.makeTranslation(cx, 0, zc));
    for (const sx of [-1, 1]) {
      g.box(sx * 0.2, -0.428, 0.05, 0.021, 0.0025, 0.18, STRAP);
      g.box(sx * 0.2, -0.426, -0.14, 0.017, 0.003, 0.022, METAL);
    }
    g.box(0, -0.462, -0.21, 0.021, 0.0025, 0.08, STRAP);
    set(tmp2.makeTranslation(cx, -0.46, zc - 0.3).multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2 + 0.2)));
    g.lathe([[0.03, 0], [0.03, 0.008], [0.025, 0.011], [0.012, 0.012], [0, 0.013]], seg, [METAL, METAL, METAL, GLOSS]);
  };
  const seat = (bx: Box, pilot: boolean): void => {
    const cx = (bx.min.x + bx.max.x) / 2;
    const zc = (bx.min.z + bx.max.z) / 2 - 0.03;
    S.frame(I);
    for (const sx of [-1, 1]) {
      S.rbox(cx + sx * 0.17, yF + 0.012, zc, 0.022, 0.012, 0.42, 0.004, 1, GUN);
      for (const z of [zc - 0.38, zc + 0.38, zc]) {
        S.frame(upM(cx + sx * 0.17, yF + 0.024, z));
        S.lathe([[0.007, 0], [0.007, 0.003], [0.005, 0.004], [0, 0.0045]], 6, STEEL);
      }
      S.frame(I);
    }
    S.rbox(cx, yF + 0.058, zc, 0.2, 0.03, 0.24, 0.01, 1, GUND);
    S.frame(upM(cx, yF + 0.085, zc));
    S.lathe([[0.075, 0], [0.075, 0.02], [0.055, 0.035], [0.055, 0.29], [0.075, 0.31], [0.075, 0.34]], seg, GUN);
    S.frame(I);
    S.bar(cx + 0.11, yF + 0.09, zc + 0.16, cx + 0.11, -0.62, zc - 0.06, 0.012, 10, METAL);
    S.bar(cx + 0.11, yF + 0.09, zc + 0.16, cx + 0.11, -0.8, zc + 0.07, 0.019, 10, GUND);
    // pan: leather shell, three stitched amber cushions, bolsters
    S.rbox(cx, -0.565, zc, 0.26, 0.05, 0.29, 0.03, cs, LEATHER);
    for (let i = 0; i < 3; i++) S.rbox(cx, -0.495, zc - 0.19 + i * 0.19, 0.15, 0.03, 0.088, 0.025, cs, AMBERP, [1, 1, 0.008, 2]);
    for (const sx of [-1, 1]) S.rbox(cx + sx * 0.205, -0.48, zc, 0.055, 0.05, 0.27, 0.035, cs, LEATHER);
    // back, raked 9 degrees
    const back = new THREE.Matrix4().makeRotationX(0.15).setPosition(cx, -0.52, bx.max.z - 0.2);
    S.frame(back);
    S.rbox(0, 0.42, 0.02, 0.26, 0.4, 0.05, 0.04, cs, LEATHER);
    S.rbox(0, 0.42, 0.074, 0.245, 0.38, 0.012, 0.01, 1, GUND);
    for (let i = 0; i < 4; i++) S.rbox(0, 0.15 + i * 0.135, -0.035, 0.145, 0.06, 0.025, 0.022, cs, AMBERP, [2, -1, 0.008, 2]);
    for (const sx of [-1, 1]) S.rbox(sx * 0.205, 0.38, -0.035, 0.055, 0.33, 0.05, 0.035, cs, LEATHER);
    S.rbox(0, 0.9, 0.0, 0.16, 0.1, 0.065, 0.05, cs, LEATHER);
    S.rbox(0, 0.9, -0.058, 0.11, 0.065, 0.016, 0.012, cs, AMBERP, [2, -1, 0.006, 2]);
    // the headrest's twin posts
    for (const sx of [-1, 1]) S.bar(sx * 0.08, 0.78, 0.01, sx * 0.08, 0.84, 0.01, 0.007, 8, METAL);
    // armrests on posts
    S.frame(I);
    for (const sx of [-1, 1]) {
      const x = cx + sx * 0.3;
      S.bar(x, -0.6, zc + 0.08, x, -0.38, zc + 0.08, 0.012, 10, GUN);
      S.rbox(x, -0.355, zc + 0.02, 0.034, 0.022, 0.16, 0.018, cs, LEATHER);
      S.rbox(x, -0.334, zc + 0.02, 0.022, 0.006, 0.13, 0.005, 1, AMBERP, [1, 1, 0.003, 2]);
    }
    if (pilot) {
      pilotBack = back;
      pilotSeatC = cx;
      pilotSeatZ = zc;
    } else looseHarness((m) => S.frame(m), S, back, cx, zc);
  };
  const sp = solid('seat-pilot');
  const sc = solid('seat-copilot');
  if (sp) seat(sp, true);
  if (sc) seat(sc, false);

  // ---- the flight stations (the pilot's from the layout; the co-pilot's the same, across the centreline)
  const buildStation = (s: StationShape, dx: number): void => {
    const fo = s.faceOrigin;
    const x0 = s.x0 + dx;
    const x1 = s.x1 + dx;
    const cxm = (s.x0 + s.x1) / 2 - fo.x;
    const hwid = (s.x1 - s.x0) / 2;
    const top: [number, number] = [fo.y + s.faceUp.y * s.faceTop, fo.z + s.faceUp.z * s.faceTop];
    const bot: [number, number] = [fo.y + s.faceUp.y * s.faceBottom, fo.z + s.faceUp.z * s.faceBottom];
    S.frame(I);
    S.prismX([[s.hoodBack.y, s.hoodBack.z], top, bot, [s.underBack.y, s.underBack.z], [s.underBack.y, s.hoodBack.z]], x0, x1, [CHAR, FACE, WHITE2, GUND, null], WHITE);
    const dy = s.deskY;
    const nz = s.deskNearZ;
    S.prismX(
      [[dy, bot[1] - 0.03], [dy, nz], [dy - 0.012, nz + 0.008], [dy - 0.04, nz + 0.008], [dy - 0.052, nz - 0.008], [dy - 0.075, bot[1] - 0.03]],
      x0, x1, [WHITE, GUN, BLACK, BLACK, GUND, null], WHITE,
    );
    // a rubber strip along the foot of the face, a padded nose roll along the desk edge
    S.box((x0 + x1) / 2, dy + 0.0004, bot[1] - 0.012, hwid - 0.01, 0.0006, 0.012, MAT);
    S.bar(x0 + 0.012, dy - 0.007, nz + 0.003, x1 - 0.012, dy - 0.007, nz + 0.003, 0.0125, seg, LEATHER);
    // the instrument face: white cheeks either side, the glare shield's visor over the screens, screws
    const R = new THREE.Vector3().crossVectors(new THREE.Vector3(s.faceUp.x, s.faceUp.y, s.faceUp.z), new THREE.Vector3(s.faceNormal.x, s.faceNormal.y, s.faceNormal.z));
    const ff = new THREE.Matrix4().makeBasis(R, new THREE.Vector3(s.faceUp.x, s.faceUp.y, s.faceUp.z), new THREE.Vector3(s.faceNormal.x, s.faceNormal.y, s.faceNormal.z)).setPosition(fo.x + dx, fo.y, fo.z);
    S.frame(ff);
    for (const sx of [-1, 1]) {
      S.rbox(cxm + sx * (hwid + 0.012), (s.faceTop + s.faceBottom) / 2 + 0.004, 0.022, 0.014, (s.faceTop - s.faceBottom) / 2 + 0.02, 0.032, 0.009, cs, WHITE);
      for (const sy of [s.faceTop - 0.01, s.faceBottom + 0.01]) S.lathe([[0.004, 0], [0.004, 0.0015], [0, 0.002]], 6, STEEL, { x: cxm + sx * (hwid - 0.01), y: sy });
    }
    S.rbox(cxm, s.faceTop + 0.014, 0.036, hwid + 0.03, 0.012, 0.044, 0.009, cs, CHAR);
    S.box(cxm, s.faceTop + 0.0015, 0.004, hwid, 0.0012, 0.004, GUN);
  };
  if (st) {
    buildStation(st, 0);
    if (COPX) buildStation(st, COPX);
  }

  // ---- devices
  const screens: { dev: number; geo: Geo; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture; mat: THREE.MeshPhysicalMaterial; last: number; page: string }[] = [];
  const glassMats: THREE.MeshPhysicalMaterial[] = [];

  /** Build one device's hardware in frame f. `copy` builds a static, unlit replica (the co-pilot's controls). */
  const buildDevice = (def: DeviceDef, i: number, f: THREE.Matrix4, d: Dev, copy: boolean): void => {
    const bun = d.bun;
    const Sg = bun.S;
    const Eg = bun.E;
    const Mg = copy ? Sg : bun.M;
    Sg.frame(f);
    Eg.frame(f);
    const pos = d.pos;
    const travel = def.travel ?? 0.06;
    const eRect = (cx: number, cy: number, z: number, w: number, h: number, c: RGB, uv: UVR): number => Eg.rect(cx, cy, z, w, h, glow(c), uv);
    const placardAt = (label: string, cx: number, cy: number, z: number, h: number): void => placardIn(Eg, label, cx, cy, z, h);
    const part = (build: () => void, move: Part['move']): void => {
      if (copy) {
        move(def.kind === 'lever' ? 0 : 0, 0, tmp2);
        Sg.frame(tmp.copy(f).multiply(tmp2));
        build();
        Sg.frame(f);
        return;
      }
      Mg.frame(f, true);
      const v0 = Mg.count;
      build();
      parts.push({ dev: i, bun, v0, v1: Mg.count, move, lx: NaN, ly: NaN });
    };
    switch (def.kind) {
      case 'screen': {
        d.rect = true;
        const hw = d.hw;
        const hh = d.hh;
        const bw = 0.011;
        // a moulded black bezel, deeper than the glass, keys along the top and down the outboard side
        Sg.rbox(0, hh + bw / 2, 0.0045, hw + bw, bw / 2, 0.0045, 0.002, 1, BLACK);
        Sg.rbox(0, -hh - bw / 2, 0.0045, hw + bw, bw / 2, 0.0045, 0.002, 1, BLACK);
        Sg.rbox(-hw - bw / 2, 0, 0.0045, bw / 2, hh, 0.0045, 0.002, 1, BLACK);
        Sg.rbox(hw + bw / 2, 0, 0.0045, bw / 2, hh, 0.0045, 0.002, 1, BLACK);
        Sg.box(0, 0, 0.0005, hw, hh, 0.0005, GLOSS);
        for (let k = 0; k < 5; k++) Sg.rbox(-hw * 0.72 + k * hw * 0.36, hh + bw / 2, 0.0098, 0.013, 0.0032, 0.0014, 0.001, 1, RUBBER);
        const out = st && def.pos.x < st.faceOrigin.x ? -1 : 1;
        for (let k = 0; k < 4; k++) Sg.rbox(out * (hw + bw / 2), hh * 0.6 - k * hh * 0.4, 0.0098, 0.0032, 0.011, 0.0014, 0.001, 1, RUBBER);
        placardAt(def.label, 0, -hh - bw / 2, 0.0093, 0.0062);
        let scr = screens.find((s) => s.dev === i);
        if (!scr) {
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(SCREEN_W * canvasScale);
          canvas.height = Math.round(SCREEN_H * canvasScale);
          const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
          drawNoData(ctx, SCREEN_W, SCREEN_H, def.label);
          const tex = new THREE.CanvasTexture(canvas);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = aniso;
          tex.generateMipmaps = true;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          const mat = glassMaterial(tex, canvas.width, canvas.height);
          glassMats.push(mat);
          scr = { dev: i, geo: new Geo(), canvas, ctx, tex, mat, last: -1e9, page: '' };
          screens.push(scr);
        }
        scr.geo.frame(f);
        scr.geo.rect(0, 0, 0.0012, hw * 2, hh * 2, PAINT, [0, 0, 1, 1]);
        break;
      }
      case 'button': {
        const round = def.role === 'targetNext';
        const uv = atlas.lamp.get(def.id) ?? atlas.white;
        d.lampC = def.role === 'holdOff' || def.role === 'holdStability' ? [1.7, 1.0, 0.32] : def.role === 'holdDock' || def.role === 'holdTarget' ? [0.4, 1.3, 1.7] : round ? [1.3, 1.35, 1.3] : def.role === 'flightAssist' ? [0.3, 1.0, 1.8] : [0.45, 1.6, 0.75];
        if (round) {
          Sg.lathe([[0.027, 0], [0.027, 0.003], [0.0225, 0.005], [0.0225, 0.011], [0.02, 0.013], [0, 0.013]], seg, [GUN, GUN, BLACK, BLACK, GLOSS]);
          d.lampV = eRect(0, 0, 0.0138, 0.042, 0.042, LAMP_OFF, uv);
          d.lampN = 4;
          placardAt(def.label, 0, 0.0345, 0.0008, 0.0105);
        } else {
          const h = def.role === 'flightAssist' ? 0.022 : 0.027;
          Sg.box(0, 0, 0.0008, h + 0.0035, h + 0.0035, 0.0008, BLACK);
          Sg.rbox(0, 0, 0.0056, h - 0.0016, h - 0.0016, 0.0046, 0.0022, 1, GLOSS);
          d.haloV = eRect(0, 0, 0.0017, 2 * h + 0.034, 2 * h + 0.034, [0, 0, 0], atlas.dot);
          d.lampV = eRect(0, 0, 0.0104, 2 * h - 0.0045, 2 * h - 0.0045, LAMP_OFF, uv);
          d.lampN = 4;
        }
        break;
      }
      case 'stick2': {
        d.a = pos.clone().addScaledVector(d.N, 0.02);
        d.b = pos.clone().addScaledVector(d.N, 0.11);
        d.r = Math.max(def.radius, 0.03);
        // a gunmetal collar and a ribbed rubber boot
        Sg.lathe([[0.05, 0], [0.05, 0.004], [0.046, 0.006]], seg, GUN);
        Sg.lathe([[0.044, 0.005], [0.036, 0.011], [0.04, 0.017], [0.031, 0.023], [0.034, 0.029], [0.024, 0.035], [0.026, 0.039], [0.013, 0.043]], seg, RUBBER, { smooth: true });
        const inner = st ? (def.pos.x < st.faceOrigin.x ? 1 : -1) : 1;
        placardAt(def.label, inner * 0.09, -0.012, 0.0008, 0.0125);
        part(() => {
          if (def.role === 'rotation') {
            // anodised grip with rubber panels, a pinky flare, hat switch and red button on top, trigger forward
            Mg.lathe([[0.008, 0.03], [0.008, 0.05]], seg, METAL);
            Mg.lathe(
              [[0.011, 0.045], [0.02, 0.05], [0.021, 0.056], [0.019, 0.066], [0.0172, 0.078], [0.0185, 0.092], [0.0205, 0.103], [0.0205, 0.113], [0.017, 0.121], [0.009, 0.126], [0, 0.127]],
              seg, [METAL, DMETAL, RUBBER, RUBBER, RUBBER, RUBBER, DMETAL, DMETAL, METAL, METAL], { sy: 1.25, smooth: true },
            );
            Mg.lathe([[0.0065, 0.125], [0.0065, 0.13], [0.004, 0.132], [0, 0.1325]], 10, [METAL, METAL, GLOSS], { y: -0.006 });
            Mg.lathe([[0.0042, 0.125], [0.0042, 0.1295], [0, 0.13]], 8, REDP, { x: 0.01, y: 0.007 });
            Mg.rbox(0, 0.027, 0.088, 0.0045, 0.006, 0.013, 0.002, 1, METAL);
            Mg.rbox(-0.017, 0.006, 0.112, 0.004, 0.006, 0.004, 0.002, 1, GLOSS);
          } else {
            // T-handle: alloy shaft and cross-bar with rubber sleeves
            Mg.lathe([[0.008, 0.03], [0.008, 0.088]], seg, METAL);
            Mg.lathe([[0.013, 0.074], [0.016, 0.082], [0.016, 0.1], [0, 0.102]], seg, DMETAL, { smooth: true });
            Mg.bar(-0.042, 0, 0.092, 0.042, 0, 0.092, 0.0105, seg, METAL);
            for (const sx of [-1, 1]) Mg.bar(sx * 0.014, 0, 0.092, sx * 0.04, 0, 0.092, 0.0135, seg, RUBBER);
            for (const sx of [-1, 1]) Mg.bar(sx * 0.042, 0, 0.092, sx * 0.046, 0, 0.092, 0.012, seg, DMETAL);
          }
        }, (x, y, m) => {
          m.makeRotationX(-y * STICK_TILT).multiply(tmp.makeRotationY(x * STICK_TILT));
        });
        break;
      }
      case 'rocker': {
        const alongUp = def.role !== 'roll';
        d.axis = alongUp ? 1 : 0;
        const lx = alongUp ? 0.016 : 0.033;
        const ly = alongUp ? 0.033 : 0.016;
        Sg.rbox(0, 0, 0.0018, lx + 0.005, ly + 0.005, 0.0018, 0.0015, 1, GUN);
        Sg.box(0, 0, 0.0036, lx + 0.001, ly + 0.001, 0.0004, BLACK);
        placardAt(def.label, 0, -(ly + 0.016), 0.0008, 0.012);
        part(() => {
          Mg.rbox(0, 0, 0.0065, lx - 0.001, ly - 0.001, 0.003, 0.0018, 1, DMETAL);
          for (const s of [-1, 1]) Mg.rbox(alongUp ? 0 : s * (lx - 0.006), alongUp ? s * (ly - 0.006) : 0, 0.0105, alongUp ? lx - 0.0015 : 0.0055, alongUp ? 0.0055 : ly - 0.0015, 0.0022, 0.0015, 1, RUBBER);
          Mg.box(0, 0, 0.0097, alongUp ? lx - 0.004 : 0.0012, alongUp ? 0.0012 : ly - 0.004, 0.0004, ORANGE);
        }, alongUp ? (x, _y, m) => m.makeRotationX(-x * 0.2) : (x, _y, m) => m.makeRotationY(x * 0.2));
        break;
      }
      case 'lever': {
        const h = travel / 2;
        d.a = pos.clone().addScaledVector(d.U, -h).addScaledVector(d.N, 0.035);
        d.b = pos.clone().addScaledVector(d.U, h).addScaledVector(d.N, 0.035);
        d.r = 0.03;
        // the gated quadrant: gunmetal plate, a black slot between alloy rails notched at every quarter, an idle gate
        Sg.rbox(0, 0, 0.0025, 0.03, h + 0.03, 0.0025, 0.003, 1, GUN);
        Sg.box(0, 0, 0.0052, 0.006, h + 0.008, 0.0003, BLACK);
        for (const sx of [-1, 1]) {
          Sg.box(sx * 0.0115, 0, 0.0075, 0.0028, h + 0.012, 0.0025, METAL);
          for (let k = 0; k <= 4; k++) Sg.box(sx * 0.0165, -h + (k * travel) / 4, 0.0058, 0.003, 0.0009, 0.0007, k === 0 ? ORANGE : STEEL);
        }
        Sg.box(0.006, -h - 0.004, 0.0075, 0.009, 0.0025, 0.0025, METAL);
        for (const sy of [-1, 1]) for (const sx of [-1, 1]) Sg.lathe([[0.0025, 0.005], [0.0025, 0.006], [0, 0.0064]], 6, STEEL, { x: sx * 0.024, y: sy * (h + 0.022) });
        eRect(0.04, 0, 0.0008, 0.026, travel + 0.014, [0.5, 0.52, 0.54], atlas.scale);
        placardAt(def.label, 0, h + 0.038, 0.0008, 0.012);
        part(() => {
          Mg.box(0, 0, 0.0085, 0.013, 0.011, 0.0012, STEEL);
          Mg.rbox(0, 0, 0.022, 0.004, 0.006, 0.014, 0.002, 1, METAL);
          Mg.bar(-0.026, 0, 0.044, 0.026, 0, 0.044, 0.0118, seg, ORANGE);
          for (const sx of [-1, 1]) Mg.bar(sx * 0.026, 0, 0.044, sx * 0.031, 0, 0.044, 0.0128, seg, METAL);
          Mg.rbox(0, -0.012, 0.038, 0.011, 0.0025, 0.005, 0.0012, 1, DMETAL);
        }, (x, _y, m) => m.makeTranslation(0, (Math.min(1, Math.max(0, x)) - 0.5) * travel, 0));
        break;
      }
      case 'toggle': {
        const guarded = def.role === 'driveArm';
        const big = guarded ? 1 : 1.5;
        if (guarded) {
          // hazard-striped plate, the switch, a red flip guard hinged above it, and an ARMED lamp below
          Sg.box(0, 0, 0.001, 0.025, 0.037, 0.001, BLACK);
          Sg.rect(0, 0, 0.0021, 0.048, 0.072, PAINT, decals.stripes);
          Sg.box(0, 0, 0.0024, 0.018, 0.03, 0.0005, BLACK);
          Sg.bar(-0.02, GUARD_HINGE, 0.005, 0.02, GUARD_HINGE, 0.005, 0.003, 8, STEEL);
          placardAt(def.label, 0, 0.049, 0.0008, 0.012);
          if (!copy) {
            const uv = atlas.placard.get('ARMED') ?? atlas.white;
            d.lampV = eRect(0, -0.049, 0.0008, 0.013 * (252 / 44), 0.013, LAMP_OFF, uv);
            d.lampN = 4;
            d.lampC = [1.7, 0.3, 0.2];
          }
          part(() => {
            for (const sx of [-1, 1]) Mg.rbox(sx * 0.0155, -0.03, 0.013, 0.0022, 0.03, 0.013, 0.0012, 1, REDP);
            Mg.rbox(0, -0.058, 0.013, 0.0177, 0.0022, 0.013, 0.0012, 1, REDP);
            Mg.rbox(0, -0.004, 0.024, 0.0177, 0.004, 0.0022, 0.0012, 1, REDP);
          }, (x, _y, m) => m.makeTranslation(0, GUARD_HINGE, 0.004).multiply(tmp.makeRotationX(-Math.min(1, Math.max(0, x)) * 1.95)));
        } else {
          Sg.rbox(0, 0, 0.002, 0.03, 0.046, 0.002, 0.004, 1, WHITE);
          for (const sy of [-1, 1]) Sg.lathe([[0.004, 0.003], [0.004, 0.0045], [0, 0.005]], 6, STEEL, { y: sy * 0.036 });
          placardAt(def.label, 0, 0.066, 0.0008, 0.018);
          if (!copy) {
            d.lampV = eRect(0, -0.024, 0.0045, 0.016, 0.016, [0.5, 0.3, 0.08], atlas.dot);
            d.lampN = 4;
            d.lampC = [0.5, 0.3, 0.08];
          }
        }
        Sg.lathe([[0.0085 * big, 0.002], [0.0085 * big, 0.006], [0.006 * big, 0.007]], 6, GUND);
        part(() => {
          Mg.lathe([[0.0032 * big, 0.002], [0.0042 * big, 0.02 * big], [0.0052 * big, 0.026 * big], [0, 0.0275 * big]], 8, METAL, { smooth: true });
        }, (x, _y, m) => m.makeRotationX(-(Math.min(1, Math.max(0, x)) * 2 - 1) * 0.45));
        break;
      }
      case 'handle': {
        // a striped housing round a black well, the T-handle in it
        Sg.box(0, 0, 0.001, 0.04, 0.018, 0.001, BLACK);
        Sg.rect(0, 0, 0.0021, 0.08, 0.036, PAINT, decals.stripes);
        Sg.rbox(0, 0, 0.0028, 0.033, 0.0115, 0.0012, 0.002, 1, BLACK);
        Sg.lathe([[0.011, 0.002], [0.011, 0.006], [0.008, 0.008]], seg, GUN);
        placardAt(def.label, 0, -0.031, 0.0008, 0.0115);
        part(() => {
          Mg.lathe([[0.0045, 0.002], [0.0045, 0.026]], 8, METAL);
          Mg.bar(-0.031, 0, 0.027, 0.031, 0, 0.027, 0.0068, seg, METAL);
          for (const sx of [-1, 1]) Mg.bar(sx * 0.008, 0, 0.027, sx * 0.03, 0, 0.027, 0.0082, seg, RUBBER);
          for (const sx of [-1, 1]) Mg.bar(sx * 0.031, 0, 0.027, sx * 0.034, 0, 0.027, 0.0085, seg, ORANGE);
        }, (x, _y, m) => m.makeTranslation(0, 0, Math.min(1, Math.max(0, x)) * 0.028));
        break;
      }
      case 'buckle': {
        // Worn: a rotary buckle in the pilot's lap, five straps running off it, a green dot when latched.
        // Unfastened: the straps lie down the seat back and over the cushions; the touch target is the seat itself
        // (SEAT_OFFSET below the worn buckle).
        if (copy) break;
        d.alt = pos.clone().add(SEAT_OFFSET);
        part(() => {
          const strap = (ang: number, len: number): void => {
            const rz = new THREE.Matrix4().makeRotationZ(ang);
            Mg.frame(f.clone().multiply(rz), true, rz);
            Mg.box(0, 0.026 + len / 2, 0.002, 0.019, len / 2, 0.0016, STRAP);
            Mg.box(0, 0.033, 0.0042, 0.021, 0.007, 0.0022, METAL);
            Mg.frame(f, true);
          };
          strap(Math.PI / 2, 0.2);
          strap(-Math.PI / 2, 0.2);
          strap(Math.PI - 0.42, 0.16);
          strap(Math.PI + 0.42, 0.16);
          strap(0, 0.08);
          Mg.lathe([[0.031, 0], [0.031, 0.008], [0.026, 0.011], [0.013, 0.012], [0.013, 0.016], [0, 0.0165]], seg, [METAL, METAL, METAL, GLOSS, GLOSS]);
        }, (x, _y, m) => m.makeScale(x > 0.5 ? 1 : 0, x > 0.5 ? 1 : 0, x > 0.5 ? 1 : 0));
        // the loose harness on the pilot seat, folded away (to the buckle) while it is worn
        if (pilotBack) {
          const inv = new THREE.Matrix4().copy(f).invert();
          const pb = pilotBack;
          part(() => {
            looseHarness((m) => Mg.frame(f, true, tmp.copy(inv).multiply(m)), Mg, pb, pilotSeatC, pilotSeatZ);
          }, (x, _y, m) => m.makeScale(x > 0.5 ? 0 : 1, x > 0.5 ? 0 : 1, x > 0.5 ? 0 : 1));
        }
        Eg.frame(f);
        d.offC = [0, 0, 0];
        d.lampV = eRect(0, 0, 0.0172, 0.02, 0.02, d.offC, atlas.dot);
        const pl = atlas.placard.get(def.label);
        if (pl) eRect(0, 0.046, 0.0045, 0.011 * (252 / 44), 0.011, d.offC, pl);
        d.lampN = pl ? 8 : 4;
        d.lampC = [0.4, 1.5, 0.6];
        break;
      }
      case 'rest':
        d.rect = true;
        break;
    }
  };

  layout.devices.forEach((def, i) => {
    const U = new THREE.Vector3(def.up.x, def.up.y, def.up.z).normalize();
    const N = new THREE.Vector3(def.normal.x, def.normal.y, def.normal.z).normalize();
    const R = new THREE.Vector3().crossVectors(U, N).normalize();
    const pos = new THREE.Vector3(def.pos.x, def.pos.y, def.pos.z);
    const f = new THREE.Matrix4().makeBasis(R, U, N).setPosition(pos);
    const mk = (bun: Bundle, p: THREE.Vector3, fr: THREE.Matrix4): Dev => ({
      def, kind: def.kind, bun, pos: p, R, U, N, frame: fr, a: p.clone().addScaledVector(N, 0.008), b: p.clone().addScaledVector(N, 0.008),
      r: def.radius, rect: false, hw: def.halfWidth ?? def.radius, hh: def.halfHeight ?? def.radius, axis: 0, lampV: -1, lampN: 0, haloV: -1, lampC: LAMP_OFF, offC: LAMP_OFF, lit: null, alt: null,
    });
    const d = mk(bundle(def.room), pos, f);
    devs.push(d);
    buildDevice(def, i, f, d, false);
    // the co-pilot's station carries the same controls (static, dark) and repeats the pilot's screens
    if (COPX && def.room === 'cockpit' && def.reach === 'pilotSeat') {
      const p2 = pos.clone().setX(pos.x + COPX);
      const f2 = new THREE.Matrix4().makeBasis(R, U, N).setPosition(p2);
      buildDevice(def, i, f2, mk(ck, p2, f2), true);
    }
  });

  // two rings that sit under the hands
  E.frame(I);
  const ringV = [E.rect(0, 0, 0, 0, 0, glow([0.35, 0.75, 1]), atlas.ring), E.rect(0, 0, 0, 0, 0, glow([0.35, 0.75, 1]), atlas.ring)];
  const ringOn = [-1, -1];

  // ---- materials and meshes
  const hwMat = hardwareMaterial(decals.tex, !lo);
  const emMat = new THREE.MeshBasicMaterial({ vertexColors: true, map: atlas.tex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const root = new THREE.Group();
  root.name = 'cockpit';
  root.userData.room = 'cockpit';
  const geos: THREE.BufferGeometry[] = [];
  let drawCalls = 0;
  let triangles = 0;
  const add = (g: Geo, mat: THREE.Material, roomId: string, dynamic: boolean, shadow: boolean, order = 0): THREE.Mesh | null => {
    if (!g.idx.length) return null;
    const geo = g.build(dynamic);
    geos.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.room = roomId;
    mesh.castShadow = shadow;
    mesh.receiveShadow = shadow;
    mesh.renderOrder = order;
    if (dynamic) mesh.frustumCulled = false;
    root.add(mesh);
    drawCalls++;
    triangles += g.idx.length / 3;
    return mesh;
  };
  add(D, hwMat, 'cockpit', false, true);
  for (const b of bundles.values()) {
    add(b.S, hwMat, b.room, false, true);
    const mm = add(b.M, hwMat, b.room, true, true);
    if (mm) {
      const g = mm.geometry;
      b.mPos = g.getAttribute('position') as THREE.BufferAttribute;
      b.mNrm = g.getAttribute('normal') as THREE.BufferAttribute;
      b.mBase = new Float32Array(b.M.pos);
      b.mNBase = new Float32Array(b.M.nrm);
    }
    const em = add(b.E, emMat, b.room, true, false, 2);
    if (em) {
      b.ePos = em.geometry.getAttribute('position') as THREE.BufferAttribute;
      b.eCol = em.geometry.getAttribute('color') as THREE.BufferAttribute;
    }
  }
  for (const s of screens) {
    const m = add(s.geo, s.mat, 'cockpit', false, false);
    if (m) m.receiveShadow = true;
  }
  // side-console glass: one canvas, drawn once (port half on top, starboard below)
  let auxTex: THREE.CanvasTexture | null = null;
  if (aux.idx.length) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(SCREEN_W * canvasScale);
    canvas.height = Math.round(SCREEN_H * canvasScale) * 2;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    const half = document.createElement('canvas');
    half.width = canvas.width;
    half.height = canvas.height / 2;
    const hc = half.getContext('2d') as CanvasRenderingContext2D;
    drawAuxScreen(hc, SCREEN_W, SCREEN_H, -1);
    ctx.drawImage(half, 0, 0);
    drawAuxScreen(hc, SCREEN_W, SCREEN_H, 1);
    ctx.drawImage(half, 0, half.height);
    auxTex = new THREE.CanvasTexture(canvas);
    auxTex.colorSpace = THREE.SRGBColorSpace;
    auxTex.anisotropy = aniso;
    const am = glassMaterial(auxTex, canvas.width, canvas.height);
    glassMats.push(am);
    const m = add(aux, am, 'cockpit', false, false);
    if (m) m.receiveShadow = true;
  }
  const hologram = holo ? createHologram({ radius: 0.085 }) : null;
  if (hologram && holo) {
    hologram.object3d.position.copy(holo);
    root.add(hologram.object3d);
    drawCalls++;
  }

  const full = new THREE.Matrix4();
  const loc = new THREE.Matrix4();
  const vt = new THREE.Vector3();
  const idIndex = new Map<string, number>();
  let lastDevices: readonly DeviceView[] | null = null;
  let data: InstrumentData | null = null;

  const view = (devices: readonly DeviceView[], i: number): DeviceView | null => {
    const dv = devices[i];
    if (dv && dv.id === devs[i].def.id) return dv;
    let j = idIndex.get(devs[i].def.id);
    if (j === undefined || !devices[j] || devices[j].id !== devs[i].def.id) {
      j = -1;
      for (let k = 0; k < devices.length; k++) if (devices[k].id === devs[i].def.id) j = k;
      idIndex.set(devs[i].def.id, j);
    }
    return j >= 0 ? devices[j] : null;
  };

  const posePart = (p: Part, x: number, y: number): void => {
    p.lx = x;
    p.ly = y;
    p.move(x, y, loc);
    full.multiplyMatrices(devs[p.dev].frame, loc);
    const b = p.bun;
    if (!b.mPos || !b.mNrm || !b.mBase || !b.mNBase) return;
    const arr = b.mPos.array as Float32Array;
    const nar = b.mNrm.array as Float32Array;
    for (let k = p.v0; k < p.v1; k++) {
      vt.set(b.mBase[k * 3], b.mBase[k * 3 + 1], b.mBase[k * 3 + 2]).applyMatrix4(full);
      arr[k * 3] = vt.x;
      arr[k * 3 + 1] = vt.y;
      arr[k * 3 + 2] = vt.z;
      vt.set(b.mNBase[k * 3], b.mNBase[k * 3 + 1], b.mNBase[k * 3 + 2]).transformDirection(full);
      nar[k * 3] = vt.x;
      nar[k * 3 + 1] = vt.y;
      nar[k * 3 + 2] = vt.z;
    }
    b.mPos.needsUpdate = true;
    b.mNrm.needsUpdate = true;
  };
  for (const p of parts) posePart(p, 0, 0);

  const setRing = (slot: number, dev: number, x: number): void => {
    const pa = ck.ePos;
    if (!pa) return;
    const arr = pa.array as Float32Array;
    const v0 = ringV[slot];
    if (dev < 0 || devs[dev].bun !== ck) {
      for (let k = 0; k < 12; k++) arr[v0 * 3 + k] = 0;
    } else {
      const d = devs[dev];
      const s = Math.max(d.r, 0.03) * (d.kind === 'stick2' ? 1.55 : 1.7);
      const lift = d.kind === 'button' ? 0.0125 : 0.0042;
      vt.copy(d.pos).addScaledVector(d.N, lift);
      if (d.kind === 'lever') vt.addScaledVector(d.U, (x - 0.5) * (d.def.travel ?? 0));
      let k = v0 * 3;
      for (let c = 0; c < 4; c++) {
        const a = c === 0 || c === 3 ? -1 : 1;
        const b = c < 2 ? -1 : 1;
        arr[k++] = vt.x + d.R.x * a * s + d.U.x * b * s;
        arr[k++] = vt.y + d.R.y * a * s + d.U.y * b * s;
        arr[k++] = vt.z + d.R.z * a * s + d.U.z * b * s;
      }
    }
    pa.needsUpdate = true;
  };

  const update = (o: CockpitUpdate): void => {
    const gain = o.gain ?? 1;
    emMat.color.setScalar(K_EM * gain);
    // the room probe holds the cabin light as the interior shows it (display gain applied), like the interior's
    // own surfaces; the sun stays in true units
    hwMat.envMapIntensity = gain;
    for (const m of glassMats) {
      m.emissiveIntensity = K_SCREEN * gain;
      m.envMapIntensity = gain;
    }
    const devices = o.devices;
    lastDevices = devices.length ? devices : null;
    if (devices.length) {
      for (let k = 0; k < parts.length; k++) {
        const p = parts[k];
        const dv = view(devices, p.dev);
        if (!dv) continue;
        const px = devs[p.dev].kind === 'buckle' ? (dv.lit ? 1 : 0) : dv.x;
        if (!(Math.abs(px - p.lx) < 1e-4 && Math.abs(dv.y - p.ly) < 1e-4)) posePart(p, px, dv.y);
      }
      let h0 = -1;
      let h1 = -1;
      let x0 = 0;
      let x1 = 0;
      for (let i = 0; i < devs.length; i++) {
        const d = devs[i];
        const dv = view(devices, i);
        if (!dv) continue;
        if (d.lampV >= 0 && d.lit !== dv.lit && d.bun.eCol) {
          d.lit = dv.lit;
          const c = dv.lit ? d.lampC : d.offC;
          const arr = d.bun.eCol.array as Float32Array;
          for (let k = d.lampV; k < d.lampV + d.lampN; k++) {
            arr[k * 3] = c[0];
            arr[k * 3 + 1] = c[1];
            arr[k * 3 + 2] = c[2];
          }
          if (d.haloV >= 0) {
            const hk = dv.lit ? 0.22 : 0;
            for (let k = d.haloV; k < d.haloV + 4; k++) {
              arr[k * 3] = d.lampC[0] * hk;
              arr[k * 3 + 1] = d.lampC[1] * hk;
              arr[k * 3 + 2] = d.lampC[2] * hk;
            }
          }
          d.bun.eCol.needsUpdate = true;
        }
        if (dv.held && !d.rect) {
          if (h0 < 0) {
            h0 = i;
            x0 = dv.x;
          } else if (h1 < 0) {
            h1 = i;
            x1 = dv.x;
          }
        }
      }
      const k0 = h0 < 0 ? -1 : h0 * 1000 + Math.round(x0 * 500);
      const k1 = h1 < 0 ? -1 : h1 * 1000 + Math.round(x1 * 500);
      if (k0 !== ringOn[0]) {
        ringOn[0] = k0;
        setRing(0, h0, x0);
      }
      if (k1 !== ringOn[1]) {
        ringOn[1] = k1;
        setRing(1, h1, x1);
      }
    }
    // the screens: about five pictures a second each, never two in the same frame
    if (o.instruments) data = o.instruments;
    if (hologram) hologram.update(data, o.time, gain);
    if (data) {
      for (let k = 0; k < screens.length; k++) {
        const s = screens[k];
        const dv = devices.length ? view(devices, s.dev) : null;
        const def = devs[s.dev].def;
        const page = dv && dv.page ? dv.page : (def.pages?.[0] ?? 'flight');
        if (o.time - s.last < 0.2 && page === s.page) continue;
        s.last = o.time + (s.last < -1e8 ? k * 0.1 : 0);
        s.page = page;
        if (page === 'flight') drawFlightScreen(s.ctx, SCREEN_W, SCREEN_H, data.flight);
        else drawNavScreen(s.ctx, SCREEN_W, SCREEN_H, page, data);
        s.tex.needsUpdate = true;
        break;
      }
    }
  };

  // ---- picking
  const po = new THREE.Vector3();
  const pd = new THREE.Vector3();
  const pw = new THREE.Vector3();
  const pu = new THREE.Vector3();
  const ph = new THREE.Vector3();
  const pa = new THREE.Vector3();
  const pb = new THREE.Vector3();
  const out: CockpitPick = { id: '', x: 0, y: 0 };
  const clamp1 = (v: number): number => Math.min(1, Math.max(-1, v));
  /** Hand position on device d for the ray po, pd (into out.x, out.y). */
  const hand = (d: Dev): void => {
    out.x = 0;
    out.y = 0;
    const travel = d.def.travel ?? 0.06;
    if (d.kind === 'stick2') {
      // in the plane through the grip that faces the eye: finger right = stick right, finger up = stick along `up`
      pw.copy(d.pos).addScaledVector(d.N, 0.085);
      const t = ph.copy(pw).sub(po).dot(pd);
      ph.copy(po).addScaledVector(pd, t).sub(pw);
      pa.copy(d.R).addScaledVector(pd, -d.R.dot(pd));
      pb.copy(d.U).addScaledVector(pd, -d.U.dot(pd));
      if (pa.lengthSq() > 1e-6) out.x = clamp1(ph.dot(pa.normalize()) / travel);
      if (pb.lengthSq() > 1e-6) out.y = clamp1(ph.dot(pb.normalize()) / travel);
      return;
    }
    // everything else: where the ray meets the plane the control lives in
    const lift = d.kind === 'lever' ? 0.035 : 0.006;
    pw.copy(d.pos).addScaledVector(d.N, lift);
    const dn = pd.dot(d.N);
    if (Math.abs(dn) < 1e-4) return;
    const t = ph.copy(pw).sub(po).dot(d.N) / dn;
    ph.copy(po).addScaledVector(pd, t).sub(pw);
    const a = ph.dot(d.R);
    const b = ph.dot(d.U);
    if (d.kind === 'lever') out.x = Math.min(1, Math.max(0, 0.5 + b / travel));
    else if (d.kind === 'rocker') {
      const s = d.axis === 1 ? b : a;
      out.x = s > 0.003 ? 1 : s < -0.003 ? -1 : 0;
    } else {
      out.x = clamp1(a / d.hw);
      out.y = clamp1(b / d.hh);
    }
  };
  const pick = (origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, tolerance = 0.03, only?: string): CockpitPick | null => {
    po.set(origin.x, origin.y, origin.z);
    pd.set(dir.x, dir.y, dir.z).normalize();
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < devs.length; i++) {
      const d = devs[i];
      if (only !== undefined) {
        if (d.def.id === only) {
          best = i;
          break;
        }
        continue;
      }
      if (lastDevices) {
        const dv = view(lastDevices, i);
        if (dv && !dv.reachable) continue;
      }
      let score: number;
      if (d.rect) {
        const dn = pd.dot(d.N);
        if (dn > -0.05) continue;
        const t = pw.copy(d.pos).sub(po).dot(d.N) / dn;
        if (t <= 0 || t > (d.kind === 'rest' ? 2.6 : 1.4)) continue;
        ph.copy(po).addScaledVector(pd, t).sub(d.pos);
        const ex = Math.max(0, Math.abs(ph.dot(d.R)) - d.hw);
        const ey = Math.max(0, Math.abs(ph.dot(d.U)) - d.hh);
        const dist = Math.hypot(ex, ey);
        score = dist <= 0 ? -0.2 : dist / Math.max(tolerance * t * 0.5, 0.003);
      } else {
        // closest approach of the ray to the device's touch segment
        const loose = d.alt !== null && d.lit !== true;
        const sa = loose && d.alt ? d.alt : d.a;
        const rad = loose ? SEAT_RADIUS : d.r;
        pu.copy(loose && d.alt ? d.alt : d.b).sub(sa);
        pw.copy(po).sub(sa);
        const Bq = pd.dot(pu);
        const Cq = pu.dot(pu);
        const Dq = pd.dot(pw);
        const Eu = pu.dot(pw);
        const den = Cq - Bq * Bq;
        const s = den > 1e-9 ? Math.min(1, Math.max(0, (Eu - Dq * Bq) / den)) : 0;
        const t = s * Bq - Dq;
        if (t <= 0.05 || t > (loose ? 2 : 1.4)) continue;
        const dist = ph.copy(pw).addScaledVector(pd, t).addScaledVector(pu, -s).length();
        score = dist <= rad ? dist / rad - 1 : (dist - rad) / Math.max(tolerance * t, 0.004);
      }
      if (score <= 1 && score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) return null;
    out.id = devs[best].def.id;
    hand(devs[best]);
    return out;
  };

  return {
    object3d: root,
    update,
    pick,
    dispose(): void {
      for (const g of geos) g.dispose();
      hwMat.dispose();
      emMat.dispose();
      atlas.tex.dispose();
      decals.tex.dispose();
      for (const m of glassMats) m.dispose();
      for (const s of screens) s.tex.dispose();
      auxTex?.dispose();
      hologram?.dispose();
      root.removeFromParent();
    },
    drawCalls,
    get triangles(): number {
      return triangles + (hologram ? hologram.triangles : 0);
    },
  };
}
