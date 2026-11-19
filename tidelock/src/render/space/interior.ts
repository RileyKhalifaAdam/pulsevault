// Ship interior: the rooms of src/data/interiors.ts as geometry and light, for the first-person camera.
//
// Everything is built from the layout (the same boxes the crew collides with): deck, overhead and bulkheads of
// every room with the door and window openings cut where the data puts them, then each solid modelled inside
// its box as what it is, then the small things that make it a home. Ship-local metres: forward -Z, up +Y,
// starboard +X.
//
// Cost on a phone: TWO draw calls (one opaque mesh, one additive glass mesh), one 1024 atlas, no real lights and
// no shadows. Light is baked per vertex at build time (strip lights, task lights, instrument glow, floor guide
// strips, sky light from the windows, ambient occlusion against the furniture) into two irradiance sets, "cabin
// lights" and "always on", which the shader mixes with `lights`. Direct sunlight is analytic: a fragment is sunlit
// when the ray from it toward the star leaves through a window rectangle of its room, so sun patches crawl over
// the cabin as the ship turns and nothing leaks through the walls.

import * as THREE from 'three';
import type { Box, InteriorDoor, InteriorLayout, InteriorRoom, InteriorSolid, InteriorWindow } from '../../data/interiors';
import type { Quality } from '../pipeline';

export interface InteriorUpdate {
  /** Seconds (any monotonic clock): blinking indicators, light fade. */
  time: number;
  /** Cabin lights on. Off leaves the floor guide strips, the instruments and what comes through the windows. */
  lights: boolean;
  /** Eye position, ship-local m (specular highlights). */
  eye?: { x: number; y: number; z: number };
  /** Display gain: 2^-EV of the pipeline, so the cabin keeps its brightness whatever the outside is exposed for. */
  gain?: number;
  /** Unit direction to the star, ship-local, and its radiance on a white diffuse surface (scene units). */
  sunDir?: { x: number; y: number; z: number };
  sunColor?: { r: number; g: number; b: number };
  /** Diffuse light arriving through the windows (planet shine), scene units. */
  windowColor?: { r: number; g: number; b: number };
}

export interface InteriorVisual {
  object3d: THREE.Object3D;
  update(o: InteriorUpdate): void;
  dispose(): void;
  readonly triangles: number;
  readonly drawCalls: number;
}

export interface InteriorOptions {
  quality: Quality;
  /** Accent colour of the soft furnishings (sRGB hex). */
  livery?: { accent?: number };
}

type P3 = [number, number, number];
type UVR = [number, number, number, number]; // u0, v bottom, u1, v top
interface St {
  c: P3;
  rough: number;
  spec: number;
  emis: number;
  group: number;
}
interface BakeLight {
  p: P3;
  c: P3;
  alt: boolean;
  down: number;
  range: number;
  room: number;
}
interface BoxO {
  bevel?: number;
  /** Bit per face to leave out: 1 -x, 2 +x, 4 -y, 8 +y, 16 -z, 32 +z. */
  skip?: number;
  fs?: (St | undefined)[];
  occ?: boolean;
  invert?: boolean;
  sub?: number;
}

const TAU = Math.PI * 2;
const HP = Math.PI / 2;
const G_MAIN = 1; // cabin lights: off with `lights`
const G_ON = 2; // always on: instruments
const G_BLINK = 3; // indicator lamps
const G_EMERG = 4; // floor guide strips: brighter in the dark
const EMIS_MAX = 8;

const _c = new THREE.Color();
const hex = (h: number): P3 => {
  _c.setHex(h);
  return [_c.r, _c.g, _c.b];
};
const S = (h: number, rough = 0.8, spec = 0.2, emis = 0, group = 0): St => ({ c: hex(h), rough, spec, emis, group });
const glow = (h: number, emis: number, group = G_ON): St => ({ c: hex(h), rough: 0.5, spec: 0, emis, group });
const pt = (a: number, ca: number, u: number, cu: number, v: number, cv: number): P3 => {
  const p: P3 = [0, 0, 0];
  p[a] = ca;
  p[u] = cu;
  p[v] = cv;
  return p;
};

const _t = new THREE.Matrix4();
const _e = new THREE.Euler();

// ------------------------------------------------------------------------------------------------ geometry

class Geo {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  mt: number[] = [];
  uv: number[] = [];
  rm: number[] = [];
  idx: number[] = [];
  occ: number[] = [];
  occRoom: number[] = [];
  lights: BakeLight[] = [];
  room = 0;
  white: [number, number] = [0, 0];
  private readonly M = new THREE.Matrix4();
  private readonly stack: THREE.Matrix4[] = [];
  private depth = 0;

  private push(): void {
    if (!this.stack[this.depth]) this.stack[this.depth] = new THREE.Matrix4();
    this.stack[this.depth].copy(this.M);
    this.depth++;
  }
  private pop(): void {
    this.depth--;
    this.M.copy(this.stack[this.depth]);
  }

  /** Run `fn` in a frame at (x, y, z) turned by ry about +Y, then rx about the turned X, then rz. */
  at(x: number, y: number, z: number, ry: number, fn: () => void, rx = 0, rz = 0): void {
    this.push();
    _t.makeRotationFromEuler(_e.set(rx, ry, rz, 'YXZ')).setPosition(x, y, z);
    this.M.multiply(_t);
    fn();
    this.pop();
  }

  /** Run `fn(length)` in a frame at `a` whose +Z runs to `b` (X is horizontal). */
  along(a: P3, b: P3, fn: (len: number) => void): void {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const L = Math.hypot(dx, dy, dz) || 1e-6;
    const zx = dx / L;
    const zy = dy / L;
    const zz = dz / L;
    let ux = 0;
    let uy = 1;
    if (Math.abs(zy) > 0.95) {
      ux = 1;
      uy = 0;
    }
    let xx = uy * zz;
    let xy = -ux * zz;
    let xz = ux * zy - uy * zx;
    const xl = Math.hypot(xx, xy, xz) || 1;
    xx /= xl;
    xy /= xl;
    xz /= xl;
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;
    this.push();
    _t.set(xx, yx, zx, a[0], xy, yy, zy, a[1], xz, yz, zz, a[2], 0, 0, 0, 1);
    this.M.multiply(_t);
    fn(L);
    this.pop();
  }

  /** Local point -> ship coordinates. */
  tp(p: P3): P3 {
    const e = this.M.elements;
    return [e[0] * p[0] + e[4] * p[1] + e[8] * p[2] + e[12], e[1] * p[0] + e[5] * p[1] + e[9] * p[2] + e[13], e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + e[14]];
  }

  private v(x: number, y: number, z: number, nx: number, ny: number, nz: number, st: St, u: number, w: number): void {
    const e = this.M.elements;
    this.pos.push(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
    this.nrm.push(e[0] * nx + e[4] * ny + e[8] * nz, e[1] * nx + e[5] * ny + e[9] * nz, e[2] * nx + e[6] * ny + e[10] * nz);
    this.col.push(st.c[0], st.c[1], st.c[2]);
    this.mt.push(st.rough, st.spec, st.emis, st.group);
    this.uv.push(u, w);
    this.rm.push(this.room);
  }

  /** Flat quad a-b-c-d (a->b is u, a->d is v), subdivided so no cell is longer than `sub`. */
  q4(a: P3, b: P3, c: P3, d: P3, st: St, hint?: P3 | null, uvr?: UVR | null, sub = 0.5): void {
    const e1x = b[0] - a[0];
    const e1y = b[1] - a[1];
    const e1z = b[2] - a[2];
    const e2x = d[0] - a[0];
    const e2y = d[1] - a[1];
    const e2z = d[2] - a[2];
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-12) return;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    if (hint && nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) {
      const t = b;
      b = d;
      d = t;
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const nu = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / sub - 1e-6));
    const nv = Math.max(1, Math.ceil(Math.hypot(d[0] - a[0], d[1] - a[1], d[2] - a[2]) / sub - 1e-6));
    const base = this.pos.length / 3;
    for (let j = 0; j <= nv; j++) {
      const t = j / nv;
      for (let i = 0; i <= nu; i++) {
        const s = i / nu;
        const w0 = (1 - s) * (1 - t);
        const w1 = s * (1 - t);
        const w2 = s * t;
        const w3 = (1 - s) * t;
        this.v(
          a[0] * w0 + b[0] * w1 + c[0] * w2 + d[0] * w3,
          a[1] * w0 + b[1] * w1 + c[1] * w2 + d[1] * w3,
          a[2] * w0 + b[2] * w1 + c[2] * w2 + d[2] * w3,
          nx,
          ny,
          nz,
          st,
          uvr ? uvr[0] + (uvr[2] - uvr[0]) * s : this.white[0],
          uvr ? uvr[1] + (uvr[3] - uvr[1]) * t : this.white[1],
        );
      }
    }
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        const i0 = base + j * (nu + 1) + i;
        this.idx.push(i0, i0 + 1, i0 + nu + 2, i0, i0 + nu + 2, i0 + nu + 1);
      }
  }

  /** Smooth quad with a normal per corner. */
  qs(a: P3, b: P3, c: P3, d: P3, na: P3, nb: P3, nc: P3, nd: P3, st: St): void {
    const px = c[0] - a[0];
    const py = c[1] - a[1];
    const pz = c[2] - a[2];
    const qx = d[0] - b[0];
    const qy = d[1] - b[1];
    const qz = d[2] - b[2];
    const gx = py * qz - pz * qy;
    const gy = pz * qx - px * qz;
    const gz = px * qy - py * qx;
    const flip = gx * (na[0] + nc[0]) + gy * (na[1] + nc[1]) + gz * (na[2] + nc[2]) < 0;
    const base = this.pos.length / 3;
    const wu = this.white[0];
    const wv = this.white[1];
    this.v(a[0], a[1], a[2], na[0], na[1], na[2], st, wu, wv);
    this.v(b[0], b[1], b[2], nb[0], nb[1], nb[2], st, wu, wv);
    this.v(c[0], c[1], c[2], nc[0], nc[1], nc[2], st, wu, wv);
    this.v(d[0], d[1], d[2], nd[0], nd[1], nd[2], st, wu, wv);
    if (flip) this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    else this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  t3(a: P3, b: P3, c: P3, st: St, hint: P3): void {
    const hl = Math.hypot(hint[0], hint[1], hint[2]) || 1;
    const n: P3 = [hint[0] / hl, hint[1] / hl, hint[2] / hl];
    const gx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    const gy = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    const gz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const flip = gx * n[0] + gy * n[1] + gz * n[2] < 0;
    const base = this.pos.length / 3;
    for (const p of [a, b, c]) this.v(p[0], p[1], p[2], n[0], n[1], n[2], st, this.white[0], this.white[1]);
    if (flip) this.idx.push(base, base + 2, base + 1);
    else this.idx.push(base, base + 1, base + 2);
  }

  private addOcc(lo: P3, hi: P3): void {
    let x0 = 1e9;
    let y0 = 1e9;
    let z0 = 1e9;
    let x1 = -1e9;
    let y1 = -1e9;
    let z1 = -1e9;
    for (let i = 0; i < 8; i++) {
      const p = this.tp([i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);
      x0 = Math.min(x0, p[0]);
      y0 = Math.min(y0, p[1]);
      z0 = Math.min(z0, p[2]);
      x1 = Math.max(x1, p[0]);
      y1 = Math.max(y1, p[1]);
      z1 = Math.max(z1, p[2]);
    }
    const d = [x1 - x0, y1 - y0, z1 - z0].sort((p, q) => q - p);
    if (d[1] < 0.03) return; // sticks cast nothing worth a ray
    this.occ.push(x0, y0, z0, x1, y1, z1);
    this.occRoom.push(this.room);
  }

  /** Explicit occluder (local box) for shapes that are not boxes. */
  shade(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    this.addOcc([Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)], [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)]);
  }

  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, st: St, o: BoxO = {}): void {
    const lo: P3 = [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)];
    const hi: P3 = [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)];
    const b = o.invert ? 0 : Math.min(o.bevel ?? 0, 0.49 * Math.min(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]));
    const skip = o.skip ?? 0;
    const inv = o.invert ? -1 : 1;
    const sub = o.sub ?? 0.5;
    for (let a = 0; a < 3; a++) {
      const u = (a + 1) % 3;
      const v = (a + 2) % 3;
      for (let s = 0; s < 2; s++) {
        const f = a * 2 + s;
        if ((skip >> f) & 1) continue;
        const ca = s ? hi[a] : lo[a];
        const hint: P3 = [0, 0, 0];
        hint[a] = (s ? 1 : -1) * inv;
        this.q4(pt(a, ca, u, lo[u] + b, v, lo[v] + b), pt(a, ca, u, hi[u] - b, v, lo[v] + b), pt(a, ca, u, hi[u] - b, v, hi[v] - b), pt(a, ca, u, lo[u] + b, v, hi[v] - b), o.fs?.[f] ?? st, hint, null, sub);
      }
    }
    if (b > 0) {
      for (let a = 0; a < 3; a++) {
        const u = (a + 1) % 3;
        const v = (a + 2) % 3;
        for (let su = 0; su < 2; su++)
          for (let sv = 0; sv < 2; sv++) {
            const eu = su ? hi[u] : lo[u];
            const ev = sv ? hi[v] : lo[v];
            const du = su ? -b : b;
            const dv = sv ? -b : b;
            const hint: P3 = [0, 0, 0];
            hint[u] = su ? 1 : -1;
            hint[v] = sv ? 1 : -1;
            this.q4(pt(a, lo[a] + b, u, eu, v, ev + dv), pt(a, hi[a] - b, u, eu, v, ev + dv), pt(a, hi[a] - b, u, eu + du, v, ev), pt(a, lo[a] + b, u, eu + du, v, ev), st, hint, null, 1e9);
          }
      }
      for (let i = 0; i < 8; i++) {
        const sx = i & 1;
        const sy = i & 2;
        const sz = i & 4;
        const ex = sx ? hi[0] : lo[0];
        const ey = sy ? hi[1] : lo[1];
        const ez = sz ? hi[2] : lo[2];
        const dx = sx ? -b : b;
        const dy = sy ? -b : b;
        const dz = sz ? -b : b;
        this.t3([ex, ey + dy, ez + dz], [ex + dx, ey, ez + dz], [ex + dx, ey + dy, ez], st, [sx ? 1 : -1, sy ? 1 : -1, sz ? 1 : -1]);
      }
    }
    if (o.occ !== false && !o.invert) this.addOcc(lo, hi);
  }

  /** Rounded box (cushions, mattresses): corner radius r, smooth normals. */
  rbox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number, st: St, seg = 2): void {
    const lo: P3 = [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)];
    const hi: P3 = [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)];
    r = Math.min(r, 0.49 * Math.min(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]));
    const coords = (a: number): number[] => (seg > 1 ? [lo[a], lo[a] + 0.35 * r, lo[a] + r, hi[a] - r, hi[a] - 0.35 * r, hi[a]] : [lo[a], lo[a] + r, hi[a] - r, hi[a]]);
    const proj = (q: P3): [P3, P3] => {
      const inner: P3 = [Math.min(Math.max(q[0], lo[0] + r), hi[0] - r), Math.min(Math.max(q[1], lo[1] + r), hi[1] - r), Math.min(Math.max(q[2], lo[2] + r), hi[2] - r)];
      const dx = q[0] - inner[0];
      const dy = q[1] - inner[1];
      const dz = q[2] - inner[2];
      const l = Math.hypot(dx, dy, dz) || 1;
      const n: P3 = [dx / l, dy / l, dz / l];
      return [[inner[0] + n[0] * r, inner[1] + n[1] * r, inner[2] + n[2] * r], n];
    };
    for (let a = 0; a < 3; a++) {
      const u = (a + 1) % 3;
      const v = (a + 2) % 3;
      const gu = coords(u);
      const gv = coords(v);
      for (let s = 0; s < 2; s++) {
        const ca = s ? hi[a] : lo[a];
        for (let i = 0; i < gu.length - 1; i++)
          for (let j = 0; j < gv.length - 1; j++) {
            const A = proj(pt(a, ca, u, gu[i], v, gv[j]));
            const B = proj(pt(a, ca, u, gu[i + 1], v, gv[j]));
            const C = proj(pt(a, ca, u, gu[i + 1], v, gv[j + 1]));
            const D = proj(pt(a, ca, u, gu[i], v, gv[j + 1]));
            this.qs(A[0], B[0], C[0], D[0], A[1], B[1], C[1], D[1], st);
          }
      }
    }
    this.addOcc(lo, hi);
  }

  /** Cylinder / cone from a to b. caps: 1 = at a, 2 = at b. */
  cyl(a: P3, b: P3, r0: number, r1: number, st: St, segs = 8, caps = 3): void {
    this.along(a, b, (L) => {
      for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * TAU;
        const a1 = ((i + 1) / segs) * TAU;
        const c0 = Math.cos(a0);
        const s0 = Math.sin(a0);
        const c1 = Math.cos(a1);
        const s1 = Math.sin(a1);
        this.qs([c0 * r0, s0 * r0, 0], [c1 * r0, s1 * r0, 0], [c1 * r1, s1 * r1, L], [c0 * r1, s0 * r1, L], [c0, s0, 0], [c1, s1, 0], [c1, s1, 0], [c0, s0, 0], st);
        if (caps & 1) this.t3([0, 0, 0], [c1 * r0, s1 * r0, 0], [c0 * r0, s0 * r0, 0], st, [0, 0, -1]);
        if (caps & 2) this.t3([0, 0, L], [c0 * r1, s0 * r1, L], [c1 * r1, s1 * r1, L], st, [0, 0, 1]);
      }
    });
  }

  /** Round tube through the points. */
  tube(pts: P3[], r: number, st: St, segs = 6): void {
    const n = pts.length;
    if (n < 2) return;
    const rings: { p: P3[]; n: P3[] }[] = [];
    let ref: P3 = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[Math.min(n - 1, i + 1)];
      let tx = p1[0] - p0[0];
      let ty = p1[1] - p0[1];
      let tz = p1[2] - p0[2];
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      if (i === 0) ref = Math.abs(ty) > 0.9 ? [1, 0, 0] : [0, 1, 0];
      const d = ref[0] * tx + ref[1] * ty + ref[2] * tz;
      let nx = ref[0] - tx * d;
      let ny = ref[1] - ty * d;
      let nz = ref[2] - tz * d;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      ref = [nx, ny, nz];
      const bx = ty * nz - tz * ny;
      const by = tz * nx - tx * nz;
      const bz = tx * ny - ty * nx;
      const ring = { p: [] as P3[], n: [] as P3[] };
      for (let j = 0; j <= segs; j++) {
        const a = (j / segs) * TAU;
        const c = Math.cos(a);
        const s = Math.sin(a);
        const q: P3 = [c * nx + s * bx, c * ny + s * by, c * nz + s * bz];
        ring.n.push(q);
        ring.p.push([pts[i][0] + q[0] * r, pts[i][1] + q[1] * r, pts[i][2] + q[2] * r]);
      }
      rings.push(ring);
    }
    for (let i = 0; i < n - 1; i++)
      for (let j = 0; j < segs; j++) this.qs(rings[i].p[j], rings[i].p[j + 1], rings[i + 1].p[j + 1], rings[i + 1].p[j], rings[i].n[j], rings[i].n[j + 1], rings[i + 1].n[j + 1], rings[i + 1].n[j], st);
  }

  /** Ellipsoid. */
  ball(c: P3, rx: number, ry: number, rz: number, st: St, segs = 8): void {
    const nl = Math.max(3, segs >> 1);
    const P = (i: number, j: number): [P3, P3] => {
      const ph = (i / nl) * Math.PI;
      const th = (j / segs) * TAU;
      const sx = Math.sin(ph) * Math.cos(th);
      const sy = Math.cos(ph);
      const sz = Math.sin(ph) * Math.sin(th);
      const l = Math.hypot(sx / rx, sy / ry, sz / rz) || 1;
      return [
        [c[0] + sx * rx, c[1] + sy * ry, c[2] + sz * rz],
        [sx / rx / l, sy / ry / l, sz / rz / l],
      ];
    };
    for (let i = 0; i < nl; i++)
      for (let j = 0; j < segs; j++) {
        const A = P(i, j);
        const B = P(i, j + 1);
        const C = P(i + 1, j + 1);
        const D = P(i + 1, j);
        this.qs(A[0], B[0], C[0], D[0], A[1], B[1], C[1], D[1], st);
      }
  }

  /** Flat annulus in the local XZ plane facing +Y (r0 = 0: a disc). */
  ring(cx: number, cy: number, cz: number, r0: number, r1: number, st: St, segs = 12): void {
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * TAU;
      const a1 = ((i + 1) / segs) * TAU;
      const c0 = Math.cos(a0);
      const s0 = Math.sin(a0);
      const c1 = Math.cos(a1);
      const s1 = Math.sin(a1);
      this.q4([cx + c0 * r0, cy, cz + s0 * r0], [cx + c0 * r1, cy, cz + s0 * r1], [cx + c1 * r1, cy, cz + s1 * r1], [cx + c1 * r0, cy, cz + s1 * r0], st, [0, 1, 0], null, 1e9);
    }
  }

  light(x: number, y: number, z: number, c: P3, intensity: number, alt = false, down = 0, range = 5): void {
    this.lights.push({ p: this.tp([x, y, z]), c: [c[0] * intensity, c[1] * intensity, c[2] * intensity], alt, down, range, room: this.room });
  }

  get triangles(): number {
    return this.idx.length / 3;
  }
}

// ------------------------------------------------------------------------------------------------ atlas

function buildAtlas(layout: InteriorLayout): { tex: THREE.CanvasTexture; R: Record<string, UVR>; white: [number, number] } {
  const SZ = 1024;
  const cv = document.createElement('canvas');
  cv.width = cv.height = SZ;
  const x = cv.getContext('2d') as CanvasRenderingContext2D;
  x.fillStyle = '#000';
  x.fillRect(0, 0, SZ, SZ);
  x.fillStyle = '#fff';
  x.fillRect(0, 0, 20, 18);
  const R: Record<string, UVR> = {};
  const white: [number, number] = [9 / SZ, 1 - 9 / SZ];
  let cx = 4;
  let cy = 22;
  let rowH = 0;
  let seed = 7;
  const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length) % a.length];
  const txt = (s: string, px: number, py: number, size: number, col: string, align: CanvasTextAlign = 'left', weight = 600): void => {
    x.font = `${weight} ${size}px -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif`;
    x.fillStyle = col;
    x.textAlign = align;
    x.textBaseline = 'middle';
    x.fillText(s, px, py);
  };
  const rect = (px: number, py: number, w: number, h: number, col: string): void => {
    x.fillStyle = col;
    x.fillRect(px, py, w, h);
  };
  const rr = (px: number, py: number, w: number, h: number, r: number, col: string): void => {
    x.fillStyle = col;
    x.beginPath();
    x.moveTo(px + r, py);
    x.arcTo(px + w, py, px + w, py + h, r);
    x.arcTo(px + w, py + h, px, py + h, r);
    x.arcTo(px, py + h, px, py, r);
    x.arcTo(px, py, px + w, py, r);
    x.fill();
  };
  const circ = (px: number, py: number, r: number, col: string, stroke = 0): void => {
    x.beginPath();
    x.arc(px, py, r, 0, TAU);
    if (stroke) {
      x.strokeStyle = col;
      x.lineWidth = stroke;
      x.stroke();
    } else {
      x.fillStyle = col;
      x.fill();
    }
  };
  const line = (x0: number, y0: number, x1: number, y1: number, col: string, w = 1): void => {
    x.strokeStyle = col;
    x.lineWidth = w;
    x.beginPath();
    x.moveTo(x0, y0);
    x.lineTo(x1, y1);
    x.stroke();
  };
  const tile = (name: string, w: number, h: number, draw: (w: number, h: number) => void): void => {
    if (cx + w + 4 > SZ) {
      cx = 4;
      cy += rowH + 6;
      rowH = 0;
    }
    if (cy + h > SZ) {
      R[name] = [white[0], white[1], white[0], white[1]];
      return;
    }
    x.save();
    x.translate(cx, cy);
    x.beginPath();
    x.rect(0, 0, w, h);
    x.clip();
    draw(w, h);
    x.restore();
    const inset = 0.75;
    R[name] = [(cx + inset) / SZ, 1 - (cy + h - inset) / SZ, (cx + w - inset) / SZ, 1 - (cy + inset) / SZ];
    cx += w + 8;
    rowH = Math.max(rowH, h);
  };
  const screenBg = (w: number, h: number): void => {
    const g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#04141d');
    g.addColorStop(1, '#0a2733');
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
  };
  const CY = '#7fe9ff';
  const AM = '#ffb347';
  const GR = '#5fe6a2';

  tile('nav', 256, 192, (w, h) => {
    screenBg(w, h);
    const ox = w * 0.4;
    const oy = h * 0.57;
    for (const r of [28, 52, 76]) circ(ox, oy, r, 'rgba(110,210,230,0.16)', 1);
    line(ox - 90, oy, ox + 90, oy, 'rgba(110,210,230,0.14)');
    line(ox, oy - 70, ox, oy + 70, 'rgba(110,210,230,0.14)');
    circ(ox, oy, 22, '#0f5d68');
    x.beginPath();
    x.arc(ox, oy, 22, -2.2, 0.3);
    x.strokeStyle = '#9af3ea';
    x.lineWidth = 2.5;
    x.stroke();
    x.beginPath();
    x.ellipse(ox + 6, oy, 70, 46, -0.3, 0, TAU);
    x.strokeStyle = CY;
    x.lineWidth = 2;
    x.stroke();
    x.beginPath();
    x.ellipse(ox + 14, oy - 4, 92, 58, -0.3, 3.6, 5.2);
    x.strokeStyle = AM;
    x.setLineDash([5, 4]);
    x.stroke();
    x.setLineDash([]);
    x.fillStyle = AM;
    x.beginPath();
    x.moveTo(ox + 62, oy - 34);
    x.lineTo(ox + 73, oy - 29);
    x.lineTo(ox + 62, oy - 23);
    x.fill();
    circ(ox - 58, oy + 22, 3, GR);
    circ(ox + 74, oy - 6, 3, CY);
    txt('ORBIT · WICK', 8, 13, 12, '#a8f1ff');
    const rows = ['AP  412.6 km', 'PE  388.1 km', 'INC  12.4°', 'T   1:32:10', 'ΔV  4 210'];
    rows.forEach((s, i) => txt(s, w - 8, 14 + i * 15, 10, i === 4 ? AM : '#c7f6ff', 'right', 500));
    rect(8, h - 10, w - 16, 3, 'rgba(110,210,230,0.2)');
    rect(8, h - 10, (w - 16) * 0.62, 3, AM);
  });
  tile('att', 192, 192, (w, h) => {
    screenBg(w, h);
    const ox = w / 2;
    const oy = h / 2 + 8;
    circ(ox, oy, 66, 'rgba(110,210,230,0.5)', 1.5);
    circ(ox, oy, 40, 'rgba(110,210,230,0.2)', 1);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * TAU;
      const r0 = i % 2 ? 61 : 56;
      line(ox + Math.cos(a) * r0, oy + Math.sin(a) * r0, ox + Math.cos(a) * 66, oy + Math.sin(a) * 66, CY, 1.2);
    }
    line(ox - 24, oy, ox - 8, oy, '#fff', 2);
    line(ox + 8, oy, ox + 24, oy, '#fff', 2);
    line(ox, oy - 6, ox, oy + 6, '#fff', 2);
    x.strokeStyle = AM;
    x.lineWidth = 2;
    x.strokeRect(ox + 20, oy - 34, 13, 13);
    circ(ox - 30, oy + 26, 6, GR, 2);
    line(ox - 30, oy + 20, ox - 30, oy + 14, GR, 2);
    rr(ox - 34, 6, 68, 18, 4, 'rgba(110,210,230,0.16)');
    txt('HDG 274', ox, 16, 11, '#c7f6ff', 'center');
    txt('RATE 0.02°/s', 8, h - 10, 9, GR, 'left', 500);
    txt('SAS', w - 8, h - 10, 9, AM, 'right');
  });
  tile('sys', 256, 192, (w, h) => {
    screenBg(w, h);
    txt('SYSTEMS', 8, 13, 12, '#a8f1ff');
    const rows: [string, number][] = [
      ['REACTOR', 0.82],
      ['COOLANT', 0.64],
      ['BUS A', 0.93],
      ['BUS B', 0.9],
      ['O₂', 0.76],
      ['CO₂ SCRUB', 0.41],
      ['WATER', 0.58],
    ];
    rows.forEach(([s, v], i) => {
      const y = 34 + i * 21;
      txt(s, 8, y, 10, '#c7f6ff', 'left', 500);
      rr(92, y - 5, 120, 10, 3, 'rgba(110,210,230,0.14)');
      rr(92, y - 5, 120 * v, 10, 3, v > 0.5 ? GR : AM);
      txt(`${Math.round(v * 100)}`, w - 8, y, 10, '#fff', 'right', 500);
    });
    txt('ALL NOMINAL', 8, h - 11, 9, GR);
  });
  tile('eng', 256, 192, (w, h) => {
    screenBg(w, h);
    txt('DRIVE', 8, 13, 12, '#a8f1ff');
    const gauge = (ox: number, v: number, label: string, col: string, val: string): void => {
      x.lineCap = 'round';
      x.beginPath();
      x.arc(ox, 92, 42, 0.75 * Math.PI, 2.25 * Math.PI);
      x.strokeStyle = 'rgba(110,210,230,0.16)';
      x.lineWidth = 9;
      x.stroke();
      x.beginPath();
      x.arc(ox, 92, 42, 0.75 * Math.PI, (0.75 + 1.5 * v) * Math.PI);
      x.strokeStyle = col;
      x.stroke();
      x.lineCap = 'butt';
      txt(val, ox, 90, 20, '#fff', 'center');
      txt(label, ox, 112, 9, '#c7f6ff', 'center', 500);
    };
    gauge(70, 0.0, 'THRUST %', CY, '0');
    gauge(186, 0.71, 'PROPELLANT %', GR, '71');
    txt('Δv 4 210 m/s', 8, h - 26, 11, AM);
    txt('ISP 9 800 s · CHAMBER COLD', 8, h - 11, 9, '#c7f6ff', 'left', 500);
  });
  tile('log', 192, 192, (w, h) => {
    screenBg(w, h);
    const lines = ['07:12 WAKE', '07:14 CABIN 21.5°C', '07:20 NAV ALIGN OK', '07:31 TANK HEATERS ON', '07:38 COMMS: WHEEL TWR', '07:41 BERTH N4 RELEASED', '07:42 RCS CHECK OK', '07:44 DRIVE SAFE', '> _'];
    txt('SHIP LOG', 8, 13, 11, '#a8f1ff');
    lines.forEach((s, i) => txt(s, 8, 32 + i * 16, 9.5, i === lines.length - 1 ? AM : '#9be9bd', 'left', 500));
    void h;
    void w;
  });
  tile('keys', 256, 128, (w, h) => {
    rect(0, 0, w, h, '#0b0d10');
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 8; i++) {
        const lit = rnd() < 0.38;
        const col = lit ? pick([AM, '#e8f4ff', GR, '#ff6a55', CY]) : '#2a3038';
        rr(7 + i * 31, 7 + j * 30, 25, 23, 4, col);
        rect(13 + i * 31, 17 + j * 30, 13, 2, lit ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.18)');
      }
  });
  tile('reactor', 256, 160, (w, h) => {
    screenBg(w, h);
    txt('FUSION CORE', 8, 13, 12, '#a8f1ff');
    for (let i = 5; i >= 1; i--) {
      x.beginPath();
      x.ellipse(84, 88, 14 * i, 9 * i, 0, 0, TAU);
      x.strokeStyle = `rgba(90,240,220,${0.15 + 0.14 * (6 - i)})`;
      x.lineWidth = 2;
      x.stroke();
    }
    circ(84, 88, 7, '#d9fff8');
    ['FIELD 5.2 T', 'TEMP 148 MK', 'OUT 82 %', 'SHIELD OK'].forEach((s, i) => txt(s, w - 8, 40 + i * 20, 10, i === 3 ? GR : '#c7f6ff', 'right', 500));
    for (let i = 0; i < 16; i++) rect(8 + i * 15, h - 14, 11, 6, i < 13 ? GR : 'rgba(110,210,230,0.18)');
  });
  tile('tablet', 144, 192, (w, h) => {
    rect(0, 0, w, h, '#e6ecef');
    rect(0, 0, w, 22, '#2d6a6e');
    txt('MANIFEST', 8, 11, 10, '#fff');
    const g = x.createLinearGradient(0, 30, 0, 80);
    g.addColorStop(0, '#f0b47a');
    g.addColorStop(1, '#27425c');
    x.fillStyle = g;
    x.fillRect(8, 30, w - 16, 50);
    for (let i = 0; i < 8; i++) rect(8, 92 + i * 12, (w - 16) * (0.5 + 0.5 * rnd()), 4, '#56636b');
  });
  tile('clock', 128, 48, (w, h) => {
    rect(0, 0, w, h, '#050607');
    txt('07:42', w / 2, h / 2 + 1, 30, '#6dffb0', 'center', 500);
  });
  tile('switches', 256, 96, (w, h) => {
    rect(0, 0, w, h, '#23262b');
    const names = ['BUS', 'RCS', 'NAV', 'COM', 'ECS', 'LTG', 'AUX', 'APU'];
    names.forEach((s, i) => {
      const px = 16 + i * 32;
      circ(px, 16, 4, pick([GR, GR, AM, '#2a3a30']));
      rr(px - 7, 30, 14, 34, 6, '#0d0f12');
      circ(px, rnd() < 0.7 ? 39 : 55, 7, '#c9ced4');
      txt(s, px, 80, 9, '#c9ced4', 'center');
    });
  });
  tile('leds', 256, 64, (w, h) => {
    rect(0, 0, w, h, '#07080a');
    for (let j = 0; j < 5; j++) for (let i = 0; i < 24; i++) circ(9 + i * 10.4, 8 + j * 12, 2.6, pick([GR, GR, AM, '#4db8ff', '#152018', '#152018']));
  });
  const hazard = (w: number, h: number, x0: number, x1: number): void => {
    x.save();
    x.beginPath();
    x.rect(x0, 0, x1 - x0, h);
    x.clip();
    x.fillStyle = '#17181a';
    for (let i = -h; i < w + h; i += 20) {
      x.beginPath();
      x.moveTo(i, h);
      x.lineTo(i + h, 0);
      x.lineTo(i + h + 10, 0);
      x.lineTo(i + 10, h);
      x.fill();
    }
    x.restore();
  };
  tile('hatch', 256, 64, (w, h) => {
    rect(0, 0, w, h, '#e8b417');
    hazard(w, h, 0, 44);
    hazard(w, h, w - 44, w);
    txt('DOCKING HATCH', w / 2, h / 2 + 1, 19, '#17181a', 'center', 800);
  });
  tile('books', 200, 64, (w, h) => {
    rect(0, 0, w, h, '#1a1410');
    let px = 2;
    while (px < w - 6) {
      const bw = 8 + Math.floor(rnd() * 11);
      const bh = 44 + Math.floor(rnd() * 16);
      rect(px, h - bh, bw - 1, bh, pick(['#a3472e', '#2f6f73', '#c2903a', '#e3d9c2', '#2f4a66', '#6b7a3a', '#7a2f3e', '#3a3f46']));
      rect(px + 1, h - bh + 8, bw - 3, 5, 'rgba(255,255,255,0.4)');
      px += bw;
    }
  });
  const labelTile = (r: InteriorRoom): void =>
    tile(`label:${r.id}`, 256, 40, (w, h) => {
      rr(0, 0, w, h, 8, '#2b3138');
      rr(2, 2, w - 4, h - 4, 7, '#333a42');
      rr(10, 13, 14, 14, 3, AM);
      txt(r.name.toUpperCase(), w / 2 + 8, h / 2 + 1, 20, '#ece9e0', 'center', 700);
    });
  layout.rooms.slice(0, 3).forEach(labelTile);
  tile('haz', 128, 32, (w, h) => {
    rect(0, 0, w, h, '#e8b417');
    hazard(w, h, 0, w);
  });
  tile('sign', 64, 64, (w, h) => {
    rr(0, 0, w, h, 6, '#f2f4f2');
    rect(26, 12, 12, 40, '#2e9a5a');
    rect(12, 26, 40, 12, '#2e9a5a');
  });
  layout.rooms.slice(3, 6).forEach(labelTile);
  ['CREW 1', 'CREW 2'].forEach((s, i) =>
    tile(`tag${i}`, 72, 28, (w, h) => {
      rect(0, 0, w, h, '#ece6d6');
      txt(s, w / 2, h / 2 + 1, 13, '#2a2d31', 'center', 700);
    }),
  );
  layout.rooms.slice(6, 9).forEach(labelTile);
  tile('mirror', 96, 128, (w, h) => {
    const g = x.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#93a6b2');
    g.addColorStop(0.45, '#e3edf2');
    g.addColorStop(0.55, '#c3d2da');
    g.addColorStop(1, '#8598a4');
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
    x.fillStyle = 'rgba(255,255,255,0.35)';
    x.beginPath();
    x.moveTo(10, h);
    x.lineTo(46, 0);
    x.lineTo(60, 0);
    x.lineTo(24, h);
    x.fill();
  });
  tile('plaid', 128, 128, (w, h) => {
    rect(0, 0, w, h, '#2f4a66');
    for (let i = 0; i < 4; i++) {
      rect(0, 8 + i * 32, w, 9, 'rgba(163,71,46,0.75)');
      rect(8 + i * 32, 0, 9, h, 'rgba(163,71,46,0.75)');
      rect(0, 22 + i * 32, w, 2, 'rgba(236,230,214,0.7)');
      rect(22 + i * 32, 0, 2, h, 'rgba(236,230,214,0.7)');
    }
  });
  tile('rug', 256, 128, (w, h) => {
    rect(0, 0, w, h, '#8a4a34');
    x.strokeStyle = '#e3d3b2';
    x.lineWidth = 3;
    x.strokeRect(9, 9, w - 18, h - 18);
    x.strokeStyle = '#2f6f73';
    x.lineWidth = 2;
    x.strokeRect(15, 15, w - 30, h - 30);
    for (let j = 0; j < 3; j++)
      for (let i = 0; i < 7; i++) {
        const px = 38 + i * 30;
        const py = 34 + j * 30;
        x.fillStyle = (i + j) % 2 ? '#c2903a' : '#2f6f73';
        x.beginPath();
        x.moveTo(px, py - 11);
        x.lineTo(px + 11, py);
        x.lineTo(px, py + 11);
        x.lineTo(px - 11, py);
        x.fill();
        circ(px, py, 2.5, '#e3d3b2');
      }
  });
  const cork = (w: number, h: number, notes: number): void => {
    rect(0, 0, w, h, '#b08455');
    for (let i = 0; i < w * h * 0.02; i++) rect(rnd() * w, rnd() * h, 1.5, 1.5, rnd() < 0.5 ? 'rgba(70,45,20,0.35)' : 'rgba(255,230,190,0.3)');
    for (let i = 0; i < notes; i++) {
      const nw = 34 + rnd() * 40;
      const nh = 30 + rnd() * 34;
      const px = 10 + rnd() * (w - nw - 20);
      const py = 10 + rnd() * (h - nh - 20);
      x.save();
      x.translate(px + nw / 2, py + nh / 2);
      x.rotate((rnd() - 0.5) * 0.3);
      const photo = rnd() < 0.4;
      x.fillStyle = 'rgba(0,0,0,0.25)';
      x.fillRect(-nw / 2 + 2, -nh / 2 + 3, nw, nh);
      x.fillStyle = photo ? '#f4f1ea' : pick(['#f3e9a8', '#f6f1e4', '#f2c4c0', '#bfe0e8', '#cfe8c2']);
      x.fillRect(-nw / 2, -nh / 2, nw, nh);
      if (photo) {
        const g = x.createLinearGradient(0, -nh / 2, 0, nh / 2);
        g.addColorStop(0, pick(['#27425c', '#e58a4a', '#7fb0c8']));
        g.addColorStop(1, pick(['#1c2530', '#3f6b4a', '#c98f5a']));
        x.fillStyle = g;
        x.fillRect(-nw / 2 + 3, -nh / 2 + 3, nw - 6, nh - 10);
      } else for (let k = 0; k < 4; k++) rect(-nw / 2 + 5, -nh / 2 + 8 + k * 6, (nw - 10) * (0.5 + 0.5 * rnd()), 1.6, 'rgba(40,40,50,0.6)');
      circ(0, -nh / 2 + 4, 3, pick(['#d0342c', '#2f6fb3', '#f2f2f2', '#e8b417']));
      x.restore();
    }
  };
  tile('pin2', 224, 128, (w, h) => cork(w, h, 6));
  tile('pin1', 300, 224, (w, h) => cork(w, h, 11));
  tile('poster', 168, 224, (w, h) => {
    const g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#15304a');
    g.addColorStop(0.6, '#b8603f');
    g.addColorStop(1, '#f0a45c');
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
    circ(w * 0.62, h * 0.4, 46, '#f4dba6');
    x.beginPath();
    x.ellipse(w * 0.62, h * 0.4, 78, 16, -0.35, 0, TAU);
    x.strokeStyle = 'rgba(255,240,210,0.8)';
    x.lineWidth = 3;
    x.stroke();
    x.fillStyle = '#1b2430';
    x.beginPath();
    x.moveTo(0, h * 0.8);
    x.lineTo(40, h * 0.62);
    x.lineTo(70, h * 0.74);
    x.lineTo(104, h * 0.58);
    x.lineTo(w, h * 0.78);
    x.lineTo(w, h);
    x.lineTo(0, h);
    x.fill();
    txt('T A L L O W', w / 2, h - 30, 17, '#f6ead2', 'center', 800);
    txt('see the long dusk', w / 2, h - 12, 9, '#f6ead2', 'center', 500);
  });
  tile('schem', 300, 224, (w, h) => {
    rect(0, 0, w, h, '#1d4f86');
    for (let i = 0; i < w; i += 20) line(i, 0, i, h, 'rgba(255,255,255,0.1)');
    for (let i = 0; i < h; i += 20) line(0, i, w, i, 'rgba(255,255,255,0.1)');
    x.strokeStyle = '#eaf3ff';
    x.lineWidth = 1.6;
    x.beginPath();
    x.moveTo(30, 96);
    x.lineTo(70, 74);
    x.lineTo(210, 70);
    x.lineTo(232, 80);
    x.lineTo(268, 72);
    x.lineTo(268, 122);
    x.lineTo(232, 114);
    x.lineTo(210, 124);
    x.lineTo(70, 120);
    x.closePath();
    x.stroke();
    for (const px of [96, 150, 190]) line(px, 72, px, 122, 'rgba(234,243,255,0.7)');
    x.strokeRect(46, 86, 20, 12);
    line(30, 146, 268, 146, '#eaf3ff');
    line(30, 141, 30, 151, '#eaf3ff');
    line(268, 141, 268, 151, '#eaf3ff');
    txt('16.0 m', 149, 156, 9, '#eaf3ff', 'center', 500);
    txt('HALCYON WREN · GENERAL ARRANGEMENT', 12, 16, 10, '#eaf3ff');
    x.strokeRect(w - 96, h - 40, 86, 30);
    txt('SHEET 1 / 4', w - 53, h - 25, 9, '#eaf3ff', 'center', 500);
  });

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return { tex, R, white };
}

// ------------------------------------------------------------------------------------------------ looks

interface RoomLook {
  upper: number;
  lower: number;
  floor: number;
  ceil: number;
  /** Bounce light with the cabin lights on (fraction of the strip colour). */
  amb: number;
  /** Ceiling strip lights [x0, z0, x1, z1], their intensity per half metre and colour. */
  strips: [number, number, number, number][];
  stripI: number;
  stripC: P3;
  /** Overhead handholds [x, z]. */
  holds: [number, number][];
  vent?: [number, number];
}
const WARM: P3 = [1.0, 0.8, 0.58];
const NEUTRAL: P3 = [0.97, 0.95, 0.9];
const COOL: P3 = [0.82, 0.9, 1.0];
const LOOKS: Record<string, RoomLook> = {
  cockpit: { upper: 0x8e939a, lower: 0x62666d, floor: 0x3b3d42, ceil: 0x7a7e85, amb: 0.2, strips: [[-1.05, -3.0, -0.4, -3.0], [0.4, -3.0, 1.05, -3.0]], stripI: 0.22, stripC: WARM, holds: [[0, -3.3], [-1.05, -4.2], [1.05, -4.2]], vent: [0, -2.82] },
  cabin: { upper: 0xddd5c5, lower: 0xb7a88e, floor: 0x5a5148, ceil: 0xd6d0c4, amb: 0.2, strips: [[-0.85, -2.3, -0.85, 1.6], [0.85, -2.3, 0.85, 1.6]], stripI: 0.3, stripC: WARM, holds: [[0, -2.1], [0, -1.2], [0, -0.3]] },
  corridor: { upper: 0xd6d2c8, lower: 0x9fa3a6, floor: 0x4a4c50, ceil: 0xd0ccc2, amb: 0.17, strips: [[-0.22, 2.2, -0.22, 4.7]], stripI: 0.26, stripC: WARM, holds: [[0.2, 2.4], [0.2, 3.3], [0.2, 4.2]] },
  bunks: { upper: 0xd9cdb9, lower: 0xa78f73, floor: 0x5d5348, ceil: 0xd2c8b6, amb: 0.14, strips: [[0.72, 2.4, 0.72, 4.1]], stripI: 0.2, stripC: [1.0, 0.72, 0.48], holds: [] },
  washroom: { upper: 0xdfe6e6, lower: 0x7fb0b0, floor: 0x6f7d80, ceil: 0xdde2e2, amb: 0.2, strips: [[-1.05, 2.3, -1.05, 3.1]], stripI: 0.2, stripC: NEUTRAL, holds: [] },
  lockers: { upper: 0xcfd2d2, lower: 0x8a9094, floor: 0x4d4f53, ceil: 0xcfd0cc, amb: 0.16, strips: [[-0.98, 3.75, -0.98, 4.35]], stripI: 0.22, stripC: NEUTRAL, holds: [], vent: [-0.7, 4.38] },
  engineering: { upper: 0xb5b9bb, lower: 0x73787d, floor: 0x3e4044, ceil: 0xa9adb0, amb: 0.14, strips: [[-0.55, 5.3, -0.55, 6.1], [0.45, 5.3, 0.45, 6.1]], stripI: 0.3, stripC: COOL, holds: [[0, 5.5], [0, 6.0]] },
};
function lookOf(r: InteriorRoom): RoomLook {
  const known = LOOKS[r.id];
  if (known) return known;
  const b = r.box;
  const cxm = (b.min.x + b.max.x) / 2;
  const czm = (b.min.z + b.max.z) / 2;
  const alongZ = b.max.z - b.min.z >= b.max.x - b.min.x;
  return {
    upper: 0xd6d2c8,
    lower: 0x9fa3a6,
    floor: 0x4a4c50,
    ceil: 0xd0ccc2,
    amb: 0.17,
    strips: [alongZ ? [cxm, b.min.z + 0.3, cxm, b.max.z - 0.3] : [b.min.x + 0.3, czm, b.max.x - 0.3, czm]],
    stripI: 0.26,
    stripC: WARM,
    holds: [],
  };
}

// ------------------------------------------------------------------------------------------------ bake

/** Ray against box `o` of `B`: entry distance, -1 for a miss, 0 when the origin is inside. */
function rayBox(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, B: ArrayLike<number>, o: number, tmax: number): number {
  let t0 = 0;
  let t1 = tmax;
  if (Math.abs(dx) < 1e-9) {
    if (ox < B[o] || ox > B[o + 3]) return -1;
  } else {
    const inv = 1 / dx;
    let a = (B[o] - ox) * inv;
    let b = (B[o + 3] - ox) * inv;
    if (a > b) {
      const t = a;
      a = b;
      b = t;
    }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return -1;
  }
  if (Math.abs(dy) < 1e-9) {
    if (oy < B[o + 1] || oy > B[o + 4]) return -1;
  } else {
    const inv = 1 / dy;
    let a = (B[o + 1] - oy) * inv;
    let b = (B[o + 4] - oy) * inv;
    if (a > b) {
      const t = a;
      a = b;
      b = t;
    }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return -1;
  }
  if (Math.abs(dz) < 1e-9) {
    if (oz < B[o + 2] || oz > B[o + 5]) return -1;
  } else {
    const inv = 1 / dz;
    let a = (B[o + 2] - oz) * inv;
    let b = (B[o + 5] - oz) * inv;
    if (a > b) {
      const t = a;
      a = b;
      b = t;
    }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return -1;
  }
  return t0;
}

const boxArr = (b: Box, pad = 0): number[] => [b.min.x - pad, b.min.y - pad, b.min.z - pad, b.max.x + pad, b.max.y + pad, b.max.z + pad];

interface WinGeom {
  room: number;
  c: P3;
  n: P3; // outward
  u: P3;
  v: P3;
  hu: number;
  hv: number;
}
function windowGeom(w: InteriorWindow, room: number): WinGeom {
  const c: P3 = [w.center.x, w.center.y, w.center.z];
  const hu = w.width / 2;
  const hv = w.height / 2;
  switch (w.wall) {
    case '+x':
      return { room, c, n: [1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], hu, hv };
    case '-x':
      return { room, c, n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], hu, hv };
    case '+z':
      return { room, c, n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], hu, hv };
    case '-z':
      return { room, c, n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0], hu, hv };
    default:
      return { room, c, n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], hu, hv };
  }
}

const AO_DIRS: P3[] = (() => {
  const out: P3[] = [[0, 0, 1]];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    out.push([Math.cos(a) * 0.64, Math.sin(a) * 0.64, 0.77]);
    const b = a + Math.PI / 4;
    out.push([Math.cos(b) * 0.95, Math.sin(b) * 0.95, 0.31]);
  }
  return out;
})();

function bakeLighting(g: Geo, layout: InteriorLayout, looks: RoomLook[], wins: WinGeom[]): { lit: Float32Array; alt: Float32Array; dir: Float32Array; win: Float32Array } {
  const n = g.pos.length / 3;
  const pos = g.pos;
  const nrm = g.nrm;
  const lit = new Float32Array(n * 3);
  const alt = new Float32Array(n * 3);
  const dir = new Float32Array(n * 3);
  const win = new Float32Array(n * 2);
  const rooms = layout.rooms;
  const idOf = new Map<string, number>();
  rooms.forEach((r, i) => idOf.set(r.id, i));
  const rb = rooms.map((r) => boxArr(r.box));
  const doors = layout.doors.map((d) => ({ a: idOf.get(d.a) ?? -1, b: idOf.get(d.b) ?? -1, bx: boxArr(d.box, 0.05) }));
  const occ = g.occ;
  const no = occ.length / 6;

  // occluder grid
  let gx0 = 1e9;
  let gy0 = 1e9;
  let gz0 = 1e9;
  let gx1 = -1e9;
  let gy1 = -1e9;
  let gz1 = -1e9;
  for (const b of rb) {
    gx0 = Math.min(gx0, b[0] - 0.6);
    gy0 = Math.min(gy0, b[1] - 0.6);
    gz0 = Math.min(gz0, b[2] - 0.6);
    gx1 = Math.max(gx1, b[3] + 0.6);
    gy1 = Math.max(gy1, b[4] + 0.6);
    gz1 = Math.max(gz1, b[5] + 0.6);
  }
  const CELL = 0.5;
  const nx = Math.max(1, Math.ceil((gx1 - gx0) / CELL));
  const ny = Math.max(1, Math.ceil((gy1 - gy0) / CELL));
  const nz = Math.max(1, Math.ceil((gz1 - gz0) / CELL));
  const cells: number[][] = [];
  const ci = (v: number, o: number, m: number): number => Math.min(m - 1, Math.max(0, Math.floor((v - o) / CELL)));
  for (let k = 0; k < no; k++) {
    const o = k * 6;
    for (let ix = ci(occ[o], gx0, nx); ix <= ci(occ[o + 3], gx0, nx); ix++)
      for (let iy = ci(occ[o + 1], gy0, ny); iy <= ci(occ[o + 4], gy0, ny); iy++)
        for (let iz = ci(occ[o + 2], gz0, nz); iz <= ci(occ[o + 5], gz0, nz); iz++) {
          const c = (iz * ny + iy) * nx + ix;
          (cells[c] ??= []).push(k);
        }
  }
  const big: number[][] = rooms.map(() => []);
  for (let k = 0; k < no; k++) {
    const o = k * 6;
    const d = [occ[o + 3] - occ[o], occ[o + 4] - occ[o + 1], occ[o + 5] - occ[o + 2]].sort((p, q) => q - p);
    if (d[1] >= 0.22 && d[2] >= 0.025) big[g.occRoom[k]]?.push(k);
  }
  const roomLights: { l: BakeLight; door: number }[][] = rooms.map(() => []);
  for (const l of g.lights) {
    roomLights[l.room]?.push({ l, door: -1 });
    doors.forEach((d, di) => {
      if (d.a === l.room && d.b >= 0) roomLights[d.b].push({ l, door: di });
      else if (d.b === l.room && d.a >= 0) roomLights[d.a].push({ l, door: di });
    });
  }
  const roomWins: WinGeom[][] = rooms.map(() => []);
  for (const w of wins) roomWins[w.room]?.push(w);

  const inOpening = (R: number, px: number, py: number, pz: number): boolean => {
    for (const d of doors) {
      if (d.a !== R && d.b !== R) continue;
      const b = d.bx;
      if (px >= b[0] && px <= b[3] && py >= b[1] && py <= b[4] && pz >= b[2] && pz <= b[5]) return true;
    }
    for (const w of roomWins[R]) {
      const dx = px - w.c[0];
      const dy = py - w.c[1];
      const dz = pz - w.c[2];
      if (Math.abs(dx * w.n[0] + dy * w.n[1] + dz * w.n[2]) > 0.12) continue;
      if (Math.abs(dx * w.u[0] + dy * w.u[1] + dz * w.u[2]) <= w.hu && Math.abs(dx * w.v[0] + dy * w.v[1] + dz * w.v[2]) <= w.hv) return true;
    }
    return false;
  };
  /** Is the segment O -> O + L (t in 0..1) blocked by the big furniture of the given rooms? */
  const blocked = (ox: number, oy: number, oz: number, lx: number, ly: number, lz: number, ra: number, rbi: number): boolean => {
    const la = big[ra];
    for (let i = 0; i < la.length; i++) if (rayBox(ox, oy, oz, lx, ly, lz, occ, la[i] * 6, 0.98) > 1e-6) return true;
    if (rbi !== ra && rbi >= 0) {
      const lb = big[rbi];
      for (let i = 0; i < lb.length; i++) if (rayBox(ox, oy, oz, lx, ly, lz, occ, lb[i] * 6, 0.98) > 1e-6) return true;
    }
    return false;
  };

  const stamp = new Int32Array(no);
  const cand: number[] = [];
  const AO_D = 0.55;
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    if (g.mt[i * 4 + 2] > 0) {
      win[i * 2 + 1] = 1;
      continue; // emitters are not lit
    }
    const R = g.rm[i];
    const Nx = nrm[i3];
    const Ny = nrm[i3 + 1];
    const Nz = nrm[i3 + 2];
    const ox = pos[i3] + Nx * 0.02;
    const oy = pos[i3 + 1] + Ny * 0.02;
    const oz = pos[i3 + 2] + Nz * 0.02;
    const room = rb[R];
    const inside = ox > room[0] - 1e-3 && ox < room[3] + 1e-3 && oy > room[1] - 1e-3 && oy < room[4] + 1e-3 && oz > room[2] - 1e-3 && oz < room[5] + 1e-3;

    // ---- ambient occlusion
    cand.length = 0;
    for (let ix = ci(ox - AO_D, gx0, nx); ix <= ci(ox + AO_D, gx0, nx); ix++)
      for (let iy = ci(oy - AO_D, gy0, ny); iy <= ci(oy + AO_D, gy0, ny); iy++)
        for (let iz = ci(oz - AO_D, gz0, nz); iz <= ci(oz + AO_D, gz0, nz); iz++) {
          const list = cells[(iz * ny + iy) * nx + ix];
          if (!list) continue;
          for (let k = 0; k < list.length; k++) {
            const b = list[k];
            if (stamp[b] === i + 1) continue;
            stamp[b] = i + 1;
            const o = b * 6;
            if (ox > occ[o] && ox < occ[o + 3] && oy > occ[o + 1] && oy < occ[o + 4] && oz > occ[o + 2] && oz < occ[o + 5]) continue; // we are inside it
            cand.push(o);
          }
        }
    // tangent frame
    let tx: number;
    let ty: number;
    let tz: number;
    if (Math.abs(Ny) < 0.9) {
      tx = -Nz;
      ty = 0;
      tz = Nx;
    } else {
      tx = 0;
      ty = Nz;
      tz = -Ny;
    }
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    const bx = Ny * tz - Nz * ty;
    const by = Nz * tx - Nx * tz;
    const bz = Nx * ty - Ny * tx;
    let occl = 0;
    for (let k = 0; k < AO_DIRS.length; k++) {
      const d = AO_DIRS[k];
      const dx = tx * d[0] + bx * d[1] + Nx * d[2];
      const dy = ty * d[0] + by * d[1] + Ny * d[2];
      const dz = tz * d[0] + bz * d[1] + Nz * d[2];
      let t = AO_D;
      for (let c = 0; c < cand.length; c++) {
        const h = rayBox(ox, oy, oz, dx, dy, dz, occ, cand[c], t);
        if (h >= 0 && h < t) t = h;
      }
      if (inside) {
        let te = 1e9;
        if (dx > 1e-9) te = Math.min(te, (room[3] - ox) / dx);
        else if (dx < -1e-9) te = Math.min(te, (room[0] - ox) / dx);
        if (dy > 1e-9) te = Math.min(te, (room[4] - oy) / dy);
        else if (dy < -1e-9) te = Math.min(te, (room[1] - oy) / dy);
        if (dz > 1e-9) te = Math.min(te, (room[5] - oz) / dz);
        else if (dz < -1e-9) te = Math.min(te, (room[2] - oz) / dz);
        if (te < t && !inOpening(R, ox + dx * te, oy + dy * te, oz + dz * te)) t = Math.max(0, te);
      }
      occl += 1 - t / AO_D;
    }
    const ao = Math.max(0.1, 1 - 0.92 * (occl / AO_DIRS.length));

    // ---- lights
    let mr = 0;
    let mg = 0;
    let mb = 0;
    let ar = 0;
    let ag = 0;
    let ab = 0;
    let ddx = 0;
    let ddy = 0;
    let ddz = 0;
    const ls = roomLights[R];
    for (let k = 0; k < ls.length; k++) {
      const l = ls[k].l;
      const lx = l.p[0] - ox;
      const ly = l.p[1] - oy;
      const lz = l.p[2] - oz;
      const d2 = lx * lx + ly * ly + lz * lz;
      if (d2 > l.range * l.range) continue;
      const d = Math.sqrt(d2) || 1e-6;
      const ndl = (Nx * lx + Ny * ly + Nz * lz) / d;
      if (ndl <= 0) continue;
      const di = ls[k].door;
      if (di >= 0 && rayBox(ox, oy, oz, lx, ly, lz, doors[di].bx, 0, 1) < 0) continue;
      if (blocked(ox, oy, oz, lx, ly, lz, R, l.room)) continue;
      const e = (ndl * (1 - l.down + l.down * Math.max(0, ly / d))) / (d2 + 0.06);
      if (l.alt) {
        ar += l.c[0] * e;
        ag += l.c[1] * e;
        ab += l.c[2] * e;
      } else {
        mr += l.c[0] * e;
        mg += l.c[1] * e;
        mb += l.c[2] * e;
        const wgt = (l.c[0] + l.c[1] + l.c[2]) * e;
        ddx += (lx / d) * wgt;
        ddy += (ly / d) * wgt;
        ddz += (lz / d) * wgt;
      }
    }
    const look = looks[R];
    const k1 = 0.4 + 0.6 * ao;
    const amb = look.amb * ao * (0.86 + 0.14 * Ny);
    lit[i3] = mr * k1 + look.stripC[0] * amb;
    lit[i3 + 1] = mg * k1 + look.stripC[1] * amb;
    lit[i3 + 2] = mb * k1 + look.stripC[2] * amb;
    alt[i3] = ar * k1 + 0.004 * ao;
    alt[i3 + 1] = ag * k1 + 0.004 * ao;
    alt[i3 + 2] = ab * k1 + 0.005 * ao;
    const dl = Math.hypot(ddx, ddy, ddz);
    if (dl > 1e-6) {
      dir[i3] = ddx / dl;
      dir[i3 + 1] = ddy / dl;
      dir[i3 + 2] = ddz / dl;
    } else {
      dir[i3] = Nx;
      dir[i3 + 1] = Ny;
      dir[i3 + 2] = Nz;
    }

    // ---- sky light through the windows of this room
    let wsum = 0;
    const ws = roomWins[R];
    for (let k = 0; k < ws.length; k++) {
      const w = ws[k];
      const lx = w.c[0] - ox;
      const ly = w.c[1] - oy;
      const lz = w.c[2] - oz;
      const d2 = lx * lx + ly * ly + lz * lz;
      const d = Math.sqrt(d2) || 1e-6;
      const ndl = (Nx * lx + Ny * ly + Nz * lz) / d;
      const cw = (lx * w.n[0] + ly * w.n[1] + lz * w.n[2]) / d;
      if (ndl <= 0 || cw <= 0) continue;
      if (blocked(ox, oy, oz, lx, ly, lz, R, R)) continue;
      const A = 4 * w.hu * w.hv;
      wsum += (A * ndl * cw) / (Math.PI * d2 + A);
    }
    win[i * 2] = (wsum * 1.6 + 0.02) * (0.5 + 0.5 * ao);
    win[i * 2 + 1] = ao;
  }
  return { lit, alt, dir, win };
}

// ------------------------------------------------------------------------------------------------ build

interface Built {
  g: Geo;
  glass: Geo;
  wins: WinGeom[];
  looks: RoomLook[];
}

function buildInterior(layout: InteriorLayout, R: Record<string, UVR>, white: [number, number], hi: boolean, accentHex: number): Built {
  const g = new Geo();
  const glass = new Geo();
  g.white = white;
  glass.white = white;
  const rooms = layout.rooms;
  const idOf = new Map<string, number>();
  rooms.forEach((r, i) => idOf.set(r.id, i));
  const looks = rooms.map(lookOf);
  const wins = layout.windows.map((w) => windowGeom(w, idOf.get(w.room) ?? 0));
  const CS = hi ? 12 : 8;

  // shared styles
  const DARK = S(0x1b1d20, 0.6, 0.4);
  const METAL = S(0x2e3136, 0.45, 0.6);
  const STEEL = S(0xb4b9be, 0.3, 0.85);
  const FRAME = S(0x4d535b, 0.5, 0.5);
  const TEX = S(0xffffff, 0.85, 0.08);
  const SCR: St = { c: [1, 1, 1], rough: 0.3, spec: 0, emis: 1.25, group: G_ON };
  const ACC = S(accentHex, 0.95, 0.06);
  const MUSTARD = S(0xc2903a, 0.95, 0.06);
  const RUST = S(0xa3472e, 0.95, 0.06);
  const CREAM = S(0xe8e2d4, 0.9, 0.08);
  const LEATHER = S(0xa9743f, 0.55, 0.35);
  const WOOD = S(0xb98a5a, 0.6, 0.3);
  const BIRCH = S(0xcdb994, 0.6, 0.25);
  const HOLD = S(0xe0a020, 0.5, 0.4);
  const WEB = S(0xcfc8b6, 0.9, 0.08);

  const panel = (w: number, h: number, rect: UVR | null | undefined, st: St, px = 0, py = 0, pz = 0.003): void =>
    g.q4([px - w / 2, py - h / 2, pz], [px + w / 2, py - h / 2, pz], [px + w / 2, py + h / 2, pz], [px - w / 2, py + h / 2, pz], st, null, rect ?? null, 0.4);
  const bezel = (w: number, h: number, st: St, px = 0, py = 0, t = 0.012, d = 0.008): void => {
    g.box(px - w / 2 - t, py - h / 2 - t, 0, px + w / 2 + t, py - h / 2, d, st, { occ: false });
    g.box(px - w / 2 - t, py + h / 2, 0, px + w / 2 + t, py + h / 2 + t, d, st, { occ: false });
    g.box(px - w / 2 - t, py - h / 2, 0, px - w / 2, py + h / 2, d, st, { occ: false });
    g.box(px + w / 2, py - h / 2, 0, px + w / 2 + t, py + h / 2, d, st, { occ: false });
  };
  const screen = (w: number, h: number, name: string, px = 0, py = 0, emis = 1.25): void => {
    bezel(w, h, DARK, px, py);
    panel(w, h, R[name], { ...SCR, emis }, px, py, 0.002);
  };
  /** Frame on a wall: x to the right as you face the wall, y up, z out of the wall. (nx, nz) = the wall's inward normal. */
  const onWall = (nx: number, nz: number, px: number, py: number, pz: number, fn: () => void): void => g.at(px, py, pz, Math.atan2(nx, nz), fn);
  /** Frame lying on a horizontal surface: z up, y = the top of the page, turned by yaw (0: top toward -Z). */
  const flat = (px: number, py: number, pz: number, yaw: number, fn: () => void): void => g.at(px, py, pz, yaw, fn, -HP);
  const mug = (px: number, py: number, pz: number, st: St, handleYaw = 0): void => {
    g.cyl([px, py, pz], [px, py + 0.085, pz], 0.034, 0.037, st, CS, 1);
    g.ring(px, py + 0.083, pz, 0, 0.033, S(0x3a2415, 0.4, 0.5), CS);
    const hx = Math.cos(handleYaw);
    const hz = Math.sin(handleYaw);
    g.tube(
      [
        [px + hx * 0.034, py + 0.066, pz + hz * 0.034],
        [px + hx * 0.06, py + 0.058, pz + hz * 0.06],
        [px + hx * 0.06, py + 0.03, pz + hz * 0.06],
        [px + hx * 0.034, py + 0.02, pz + hz * 0.034],
      ],
      0.006,
      st,
      5,
    );
  };

  // ---------------------------------------------------------------------------------------------- shell
  const F = Math.min(...rooms.map((r) => r.box.min.y));
  const shell = (ri: number): void => {
    const room = rooms[ri];
    const look = looks[ri];
    g.room = ri;
    const lo: P3 = [room.box.min.x, room.box.min.y, room.box.min.z];
    const hi3: P3 = [room.box.max.x, room.box.max.y, room.box.max.z];
    const upper = S(look.upper, 0.82, 0.14);
    const lower = S(look.lower, 0.7, 0.2);
    const seam = S(0x33363a, 0.8, 0.1);
    const kick = S(0x3a3d42, 0.6, 0.3);
    const rail = S(0x676c73, 0.45, 0.5);
    const cove = S(look.lower, 0.75, 0.15);
    const floor = S(look.floor, 0.72, 0.3);
    const floorSeam = S(0x26272a, 0.7, 0.2);
    const ceil = S(look.ceil, 0.88, 0.1);
    for (let face = 0; face < 6; face++) {
      const k = face >> 1; // plane axis
      const atMax = face & 1;
      const c = atMax ? hi3[k] : lo[k];
      const u = k === 0 ? 2 : 0;
      const v = k === 1 ? 2 : 1;
      const hint: P3 = [0, 0, 0];
      hint[k] = atMax ? -1 : 1;
      const holes: [number, number, number, number][] = [];
      if (k !== 1)
        for (const d of layout.doors) {
          if (d.a !== room.id && d.b !== room.id) continue;
          const dl: P3 = [d.box.min.x, d.box.min.y, d.box.min.z];
          const dh: P3 = [d.box.max.x, d.box.max.y, d.box.max.z];
          if (dl[k] < c && dh[k] > c) holes.push([dl[u], dh[u], dl[v], dh[v]]);
        }
      const wallName = (k === 0 ? (atMax ? '+x' : '-x') : k === 1 ? (atMax ? '+y' : '-y') : atMax ? '+z' : '-z') as string;
      for (const w of layout.windows) {
        if (w.room !== room.id || w.wall !== wallName) continue;
        const wc: P3 = [w.center.x, w.center.y, w.center.z];
        holes.push([wc[u] - w.width / 2, wc[u] + w.width / 2, wc[v] - w.height / 2, wc[v] + w.height / 2]);
      }
      const cuts = (a: number, seamStep: number, bands: number[]): number[] => {
        const a0 = lo[a];
        const a1 = hi3[a];
        const out = [a0, a1, ...bands];
        for (const h of holes) out.push(a === u ? h[0] : h[2], a === u ? h[1] : h[3]);
        if (seamStep > 0) {
          const np = Math.max(1, Math.round((a1 - a0) / seamStep));
          for (let i = 1; i < np; i++) {
            const s = a0 + ((a1 - a0) * i) / np;
            out.push(s - 0.004, s + 0.004);
          }
        }
        const sorted = out.filter((q) => q >= a0 - 1e-6 && q <= a1 + 1e-6).sort((p, q) => p - q);
        const uniq: number[] = [];
        for (const q of sorted) if (!uniq.length || q - uniq[uniq.length - 1] > 1e-4) uniq.push(q);
        const fine: number[] = [];
        for (let i = 0; i < uniq.length - 1; i++) {
          const parts = Math.max(1, Math.ceil((uniq[i + 1] - uniq[i]) / 0.38 - 1e-6));
          for (let j = 0; j < parts; j++) fine.push(uniq[i] + ((uniq[i + 1] - uniq[i]) * j) / parts);
        }
        fine.push(uniq[uniq.length - 1]);
        return fine;
      };
      const wall = k !== 1;
      const top = hi3[1];
      const cu = cuts(u, wall ? 0.85 : face === 2 ? 0.6 : 0.8, []);
      const cvv = wall ? cuts(v, 0, [lo[1] + 0.09, lo[1] + 0.65, lo[1] + 0.69, top - 0.1]) : cuts(v, face === 2 ? 0.6 : 0.8, []);
      for (let i = 0; i < cu.length - 1; i++)
        for (let j = 0; j < cvv.length - 1; j++) {
          const um = (cu[i] + cu[i + 1]) / 2;
          const vm = (cvv[j] + cvv[j + 1]) / 2;
          let hole = false;
          for (const h of holes) if (um > h[0] && um < h[1] && vm > h[2] && vm < h[3]) hole = true;
          if (hole) continue;
          const su = cu[i + 1] - cu[i] < 0.0085;
          const sv = cvv[j + 1] - cvv[j] < 0.0085;
          let st: St;
          if (wall) {
            const y = vm - lo[1];
            if (y < 0.09) st = kick;
            else if (y < 0.65) st = su ? seam : lower;
            else if (y < 0.69) st = rail;
            else if (vm < top - 0.1) st = su ? seam : upper;
            else st = cove;
          } else if (face === 2) st = su || sv ? floorSeam : floor;
          else st = su || sv ? seam : ceil;
          g.q4(pt(k, c, u, cu[i], v, cvv[j]), pt(k, c, u, cu[i + 1], v, cvv[j]), pt(k, c, u, cu[i + 1], v, cvv[j + 1]), pt(k, c, u, cu[i], v, cvv[j + 1]), st, hint, null, 1e9);
        }
    }
  };

  // ---------------------------------------------------------------------------------------------- openings
  const windowFrame = (w: InteriorWindow, wg: WinGeom): void => {
    g.room = wg.room;
    const hw = wg.hu;
    const hh = wg.hv;
    const dp = 0.1;
    const rev = S(0x34373c, 0.6, 0.3);
    const trim = S(0x8b9096, 0.45, 0.6);
    const edge = S(0x6fc4b4, 0.15, 0.9);
    const build = (): void => {
      g.q4([-hw, -hh, 0], [hw, -hh, 0], [hw, -hh, -dp], [-hw, -hh, -dp], rev, [0, 1, 0], null, 0.3);
      g.q4([-hw, hh, 0], [hw, hh, 0], [hw, hh, -dp], [-hw, hh, -dp], rev, [0, -1, 0], null, 0.3);
      g.q4([-hw, -hh, 0], [-hw, hh, 0], [-hw, hh, -dp], [-hw, -hh, -dp], rev, [1, 0, 0], null, 0.3);
      g.q4([hw, -hh, 0], [hw, hh, 0], [hw, hh, -dp], [hw, -hh, -dp], rev, [-1, 0, 0], null, 0.3);
      const e = 0.012;
      const z0 = -dp + 0.004;
      const z1 = -dp + 0.03;
      g.box(-hw, -hh, z0, hw, -hh + e, z1, edge, { occ: false });
      g.box(-hw, hh - e, z0, hw, hh, z1, edge, { occ: false });
      g.box(-hw, -hh, z0, -hw + e, hh, z1, edge, { occ: false });
      g.box(hw - e, -hh, z0, hw, hh, z1, edge, { occ: false });
      const t = 0.04;
      const p = 0.014;
      g.box(-hw - t, -hh - t, 0, hw + t, -hh, p, trim, { bevel: 0.004, occ: false });
      g.box(-hw - t, hh, 0, hw + t, hh + t, p, trim, { bevel: 0.004, occ: false });
      g.box(-hw - t, -hh, 0, -hw, hh, p, trim, { bevel: 0.004, occ: false });
      g.box(hw, -hh, 0, hw + t, hh, p, trim, { bevel: 0.004, occ: false });
      if (w.width >= 2 && w.wall !== '+y') for (const mx of [-hw * 0.5, hw * 0.5]) g.box(mx - 0.022, -hh, -dp, mx + 0.022, hh, p, FRAME, { occ: false });
      const z = -dp + 0.012;
      glass.q4(g.tp([-hw, -hh, z]), g.tp([hw, -hh, z]), g.tp([hw, hh, z]), g.tp([-hw, hh, z]), TEX, null, [0, 0, 1, 1], 1e9);
    };
    if (w.wall === '+y') g.at(wg.c[0], wg.c[1], wg.c[2], 0, build, HP);
    else onWall(-wg.n[0], -wg.n[2], wg.c[0], wg.c[1], wg.c[2], build);
  };

  const doorFrame = (d: InteriorDoor): void => {
    const b = d.box;
    const kx = b.max.x - b.min.x < b.max.z - b.min.z;
    const c = kx ? (b.min.x + b.max.x) / 2 : (b.min.z + b.max.z) / 2;
    const h0 = kx ? b.min.z : b.min.x;
    const h1 = kx ? b.max.z : b.max.x;
    const hc = (h0 + h1) / 2;
    const hw = (h1 - h0) / 2;
    const H = b.max.y - b.min.y;
    const ia = idOf.get(d.a) ?? 0;
    const ib = idOf.get(d.b) ?? 0;
    const ca = kx ? (rooms[ia].box.min.x + rooms[ia].box.max.x) / 2 : (rooms[ia].box.min.z + rooms[ia].box.max.z) / 2;
    for (const s of [-1, 1]) {
      const mine = ca - c > 0 === s > 0 ? ia : ib;
      const other = mine === ia ? ib : ia;
      g.room = mine;
      onWall(kx ? s : 0, kx ? 0 : s, kx ? c : hc, b.min.y, kx ? hc : c, () => {
        const jw = 0.07;
        const jd = 0.06;
        g.box(-hw - jw, 0, 0, -hw, H + jw, jd, FRAME, { bevel: 0.008 });
        g.box(hw, 0, 0, hw + jw, H + jw, jd, FRAME, { bevel: 0.008 });
        g.box(-hw, H, 0, hw, H + jw, jd, FRAME, { bevel: 0.008 });
        g.box(-hw, 0, 0, hw, 0.012, jd, STEEL, { occ: false });
        const lh = 0.052;
        panel(lh * 6.4, lh, R[`label:${rooms[other].id}`], TEX, 0, H + jw / 2, jd + 0.002);
        g.box(hw + 0.016, H * 0.52, jd, hw + 0.054, H * 0.52 + 0.085, jd + 0.008, glow(0x58f0a0, 1.1), { occ: false });
      });
    }
  };

  // ---------------------------------------------------------------------------------------------- ceilings, strips
  const fixtures = (ri: number): void => {
    const room = rooms[ri];
    const look = looks[ri];
    const C = room.box.max.y;
    g.room = ri;
    const housing = S(0x8d9196, 0.5, 0.4);
    for (const s of look.strips) {
      const alongX = Math.abs(s[2] - s[0]) > Math.abs(s[3] - s[1]);
      const x0 = Math.min(s[0], s[2]) - (alongX ? 0 : 0.055);
      const x1 = Math.max(s[0], s[2]) + (alongX ? 0 : 0.055);
      const z0 = Math.min(s[1], s[3]) - (alongX ? 0.055 : 0);
      const z1 = Math.max(s[1], s[3]) + (alongX ? 0.055 : 0);
      g.box(x0 - 0.02, C - 0.03, z0 - 0.02, x1 + 0.02, C, z1 + 0.02, housing, { bevel: 0.006, occ: false, skip: 8 });
      g.box(x0, C - 0.042, z0, x1, C - 0.03, z1, { c: look.stripC, rough: 0.5, spec: 0, emis: 3.2, group: G_MAIN }, { occ: false, skip: 8 });
      const len = Math.hypot(s[2] - s[0], s[3] - s[1]);
      const ns = Math.max(2, Math.round(len / 0.6));
      for (let i = 0; i < ns; i++) {
        const t = (i + 0.5) / ns;
        g.light(s[0] + (s[2] - s[0]) * t, C - 0.07, s[1] + (s[3] - s[1]) * t, look.stripC, (look.stripI * len) / ns / 0.5, false, 0.7, 6);
      }
    }
    for (const h of look.holds) {
      const L = 0.18;
      const dpt = 0.085;
      g.tube(
        [
          [h[0], C, h[1] - L],
          [h[0], C - dpt + 0.025, h[1] - L],
          [h[0], C - dpt, h[1] - L + 0.025],
          [h[0], C - dpt, h[1] + L - 0.025],
          [h[0], C - dpt + 0.025, h[1] + L],
          [h[0], C, h[1] + L],
        ],
        0.012,
        HOLD,
        6,
      );
      for (const e of [-L, L]) g.cyl([h[0], C - 0.008, h[1] + e], [h[0], C, h[1] + e], 0.026, 0.026, METAL, 8, 1);
    }
    const vp = look.vent ?? [room.box.max.x - 0.3, room.box.max.z - 0.3];
    g.box(vp[0] - 0.15, C - 0.012, vp[1] - 0.09, vp[0] + 0.15, C, vp[1] + 0.09, housing, { bevel: 0.004, occ: false, skip: 8 });
    for (let i = 0; i < 5; i++) g.box(vp[0] - 0.13, C - 0.016, vp[1] - 0.07 + i * 0.033, vp[0] + 0.13, C - 0.011, vp[1] - 0.052 + i * 0.033, DARK, { occ: false, skip: 8 });

    // floor-level guide strips along the bulkheads, broken at the doors
    const b = room.box;
    const amber = glow(0xffa64a, 1.5, G_EMERG);
    const amberC = hex(0xffa64a);
    const walls: [0 | 2, number, number, number, number][] = [
      [0, b.min.x, 1, b.min.z, b.max.z],
      [0, b.max.x, -1, b.min.z, b.max.z],
      [2, b.min.z, 1, b.min.x, b.max.x],
      [2, b.max.z, -1, b.min.x, b.max.x],
    ];
    for (const [k, c, sgn, a0, a1] of walls) {
      let segs: [number, number][] = [[a0 + 0.04, a1 - 0.04]];
      for (const d of layout.doors) {
        if (d.a !== room.id && d.b !== room.id) continue;
        const dmin = k === 0 ? d.box.min.x : d.box.min.z;
        const dmax = k === 0 ? d.box.max.x : d.box.max.z;
        if (!(dmin < c && dmax > c)) continue;
        const h0 = (k === 0 ? d.box.min.z : d.box.min.x) - 0.09;
        const h1 = (k === 0 ? d.box.max.z : d.box.max.x) + 0.09;
        const next: [number, number][] = [];
        for (const sg of segs) {
          if (h1 <= sg[0] || h0 >= sg[1]) next.push(sg);
          else {
            if (h0 - sg[0] > 0.1) next.push([sg[0], h0]);
            if (sg[1] - h1 > 0.1) next.push([h1, sg[1]]);
          }
        }
        segs = next;
      }
      for (const sg of segs) {
        const y0 = b.min.y + 0.1;
        if (k === 0) g.box(c, y0, sg[0], c + sgn * 0.006, y0 + 0.014, sg[1], amber, { occ: false, sub: 1e9 });
        else g.box(sg[0], y0, c, sg[1], y0 + 0.014, c + sgn * 0.006, amber, { occ: false, sub: 1e9 });
        const ns = Math.max(1, Math.round((sg[1] - sg[0]) / 0.9));
        for (let i = 0; i < ns; i++) {
          const h = sg[0] + ((sg[1] - sg[0]) * (i + 0.5)) / ns;
          const px = k === 0 ? c + sgn * 0.06 : h;
          const pz = k === 0 ? h : c + sgn * 0.06;
          let buried = false;
          for (const so of layout.solids) if (px > so.box.min.x - 0.02 && px < so.box.max.x + 0.02 && pz > so.box.min.z - 0.02 && pz < so.box.max.z + 0.02 && y0 > so.box.min.y - 0.02 && y0 < so.box.max.y + 0.02) buried = true;
          if (!buried) g.light(px, y0 + 0.01, pz, amberC, 0.03, true, 0, 2.2);
        }
      }
    }
  };

  // ---------------------------------------------------------------------------------------------- furniture
  const seat = (W: number, _D: number, _H: number, stickSide: number): void => {
    const shellSt = S(0x383c42, 0.6, 0.35);
    void W;
    g.box(-0.2, 0, -0.3, -0.14, 0.03, 0.3, METAL, { occ: false });
    g.box(0.14, 0, -0.3, 0.2, 0.03, 0.3, METAL, { occ: false });
    g.box(-0.17, 0.03, -0.17, 0.17, 0.07, 0.17, METAL, { bevel: 0.012 });
    g.cyl([0, 0.07, 0], [0, 0.3, 0], 0.06, 0.06, METAL, CS, 0);
    g.box(-0.26, 0.3, -0.3, 0.26, 0.37, 0.3, shellSt, { bevel: 0.02 });
    g.rbox(-0.23, 0.36, -0.2, 0.23, 0.46, 0.31, 0.04, LEATHER, 2);
    g.at(
      0,
      0.38,
      -0.25,
      0,
      () => {
        g.box(-0.25, 0, -0.07, 0.25, 0.7, -0.02, shellSt, { bevel: 0.02 });
        g.rbox(-0.21, 0.04, -0.035, 0.21, 0.5, 0.05, 0.035, LEATHER, 2);
        g.rbox(-0.13, 0.53, -0.035, 0.13, 0.69, 0.055, 0.035, LEATHER, 2);
        for (const sx of [-1, 1]) g.along([sx * 0.1, 0.55, 0.054], [sx * 0.075, 0.1, 0.058], (L) => g.box(-0.022, -0.003, 0, 0.022, 0.003, L, WEB, { occ: false }));
      },
      -0.14,
    );
    for (const sx of [-1, 1]) {
      g.along([sx * 0.075, 0.478, -0.18], [sx * 0.02, 0.472, 0.05], (L) => g.box(-0.022, -0.003, 0, 0.022, 0.003, L, WEB, { occ: false }));
      g.along([sx * 0.232, 0.44, -0.06], [sx * 0.03, 0.473, 0.06], (L) => g.box(-0.02, -0.003, 0, 0.02, 0.003, L, WEB, { occ: false }));
      g.box(sx * 0.27, 0.52, -0.22, sx * 0.335, 0.555, 0.2, shellSt, { bevel: 0.01, occ: false });
      g.box(sx * 0.285, 0.37, -0.2, sx * 0.32, 0.52, -0.12, METAL, { occ: false });
    }
    g.box(-0.036, 0.466, 0.03, 0.036, 0.488, 0.1, STEEL, { bevel: 0.005, occ: false });
    g.box(-0.014, 0.488, 0.05, 0.014, 0.493, 0.08, S(0xc0392b, 0.5, 0.3), { occ: false });
    const sx = stickSide;
    g.cyl([sx * 0.302, 0.555, 0.16], [sx * 0.302, 0.57, 0.16], 0.03, 0.022, DARK, CS, 2);
    g.cyl([sx * 0.302, 0.57, 0.16], [sx * 0.302, 0.65, 0.15], 0.012, 0.012, METAL, 6, 0);
    g.ball([sx * 0.302, 0.672, 0.148], 0.02, 0.032, 0.02, DARK, 8);
  };

  const mainConsole = (W: number, D: number, H: number): void => {
    const hw = W / 2;
    const hd = D / 2;
    const hood = S(0x2a2c30, 0.95, 0.05);
    const face = S(0x2b2e33, 0.7, 0.2);
    const shelf = S(0x3a3e44, 0.6, 0.3);
    const prof: [number, number, St][] = [
      [-hd, H - 0.17, hood],
      [hd - 0.33, H, hood],
      [hd - 0.23, H - 0.03, hood],
      [hd - 0.25, H - 0.06, face],
      [hd - 0.05, H - 0.39, shelf],
      [hd - 0.01, H - 0.43, shelf],
      [hd - 0.01, H - 0.55, DARK],
      [hd - 0.2, H - 0.61, DARK],
      [hd - 0.2, 0, DARK],
    ];
    for (let i = 0; i < prof.length - 1; i++) {
      const p = prof[i];
      const q = prof[i + 1];
      g.q4([-hw, p[1], p[0]], [hw, p[1], p[0]], [hw, q[1], q[0]], [-hw, q[1], q[0]], p[2], [0, q[0] - p[0], -(q[1] - p[1])], null, 0.34);
    }
    g.shade(-hw, 0, -hd, hw, H - 0.2, hd - 0.2);
    g.shade(-hw, H - 0.5, -hd, hw, H - 0.1, hd - 0.1);
    // instrument face: x right, y up the slope, z out toward the crew
    const zb = hd - 0.05;
    const yb = H - 0.39;
    const Lf = Math.hypot(0.2, 0.33);
    g.at(
      0,
      yb,
      zb,
      0,
      () => {
        const y0 = Lf * 0.3;
        const sh = Lf * 0.62;
        const scr = (x0: number, x1: number, name: string): void => screen(x1 - x0, sh, name, (x0 + x1) / 2, y0 + sh / 2);
        scr(-0.83, -0.51, 'nav');
        scr(-0.46, -0.22, 'att');
        scr(-0.16, 0.16, 'sys');
        scr(0.22, 0.54, 'eng');
        scr(0.59, 0.83, 'log');
        for (const sx of [-1, 1]) {
          panel(0.3, 0.15, R.keys, { ...SCR, emis: 0.8 }, sx * 1.06, y0 + sh - 0.075, 0.002);
          bezel(0.3, 0.15, DARK, sx * 1.06, y0 + sh - 0.075);
        }
        for (const cx of [-1.06, -0.67, -0.3, 0.3, 0.67, 1.06]) panel(0.24, 0.085, R.switches, { ...TEX, emis: 0.22, group: G_ON, spec: 0.1 }, cx, 0.052, 0.002);
        // light spilled by the displays onto the crew
        for (const lx of [-0.66, 0, 0.66]) g.light(lx, y0 + sh / 2, 0.12, [0.45, 0.85, 1.0], 0.08, true, 0, 2.6);
      },
      -Math.atan2(0.2, 0.33),
    );
    // things left on the glare shield: a clipboard and a compass ball
    g.at(0.62, H - 0.085, hd - 0.56, -0.3, () => {
      g.box(-0.09, 0, -0.06, 0.09, 0.006, 0.06, S(0x5b4630, 0.7, 0.2), { occ: false });
      g.box(-0.08, 0.006, -0.05, 0.08, 0.009, 0.05, CREAM, { occ: false });
      g.box(-0.03, 0.009, -0.062, 0.03, 0.016, -0.045, STEEL, { occ: false });
    }, -0.31);
    g.ball([-0.0, H - 0.005, hd - 0.42], 0.035, 0.035, 0.035, S(0x101214, 0.2, 0.9), 10);
    g.cyl([-0.0, H - 0.05, hd - 0.42], [0, H - 0.02, hd - 0.42], 0.03, 0.022, METAL, 8, 0);
  };

  const pedestal = (W: number, D: number, H: number): void => {
    const hw = W / 2;
    const hd = D / 2;
    const body = S(0x33373d, 0.6, 0.35);
    const top = S(0x24262a, 0.7, 0.3);
    g.box(-hw, 0, -hd, hw, H - 0.16, hd, body, { bevel: 0.015 });
    g.box(-hw + 0.01, H - 0.16, -hd, hw - 0.01, H - 0.06, 0.05, top, { bevel: 0.012 });
    g.rbox(-hw + 0.03, H - 0.17, 0.09, hw - 0.03, H - 0.125, 0.27, 0.02, S(0x4a3a2c, 0.6, 0.3), 1);
    g.box(-0.14, H - 0.062, -0.34, -0.01, H - 0.054, -0.05, S(0x0e0f11, 0.4, 0.6), { occ: false });
    // (no levers here: the working throttle is the one on the pilot's flight station, src/data/cockpit.ts)
    flat(0.09, H - 0.057, -0.2, HP, () => {
      panel(0.27, 0.135, R.keys, { ...SCR, emis: 0.8 }, 0, 0, 0);
    });
    for (let i = 0; i < 3; i++) {
      g.cyl([-0.1 + i * 0.1, H - 0.06, 0.012], [-0.1 + i * 0.1, H - 0.038, 0.012], 0.016, 0.014, S(0x9aa0a6, 0.4, 0.7), 8, 2);
    }
    g.ring(0, H - 0.158, hd - 0.08, 0.04, 0.05, STEEL, CS);
    mug(0, H - 0.16, hd - 0.08, ACC, 0.6);
    g.light(0, H + 0.1, -0.2, [1.0, 0.7, 0.35], 0.01, true, 0, 1.2);
  };

  const galley = (W: number, D: number, H: number): void => {
    const hw = W / 2;
    const hd = D / 2;
    const stone = S(0xe6e2da, 0.35, 0.5);
    const handle = S(0x2a2c30, 0.4, 0.6);
    g.box(-hw, 0, -hd, hw, 0.08, hd - 0.06, DARK);
    g.box(-hw, 0.08, -hd, hw, H - 0.06, hd - 0.03, BIRCH);
    // worktop around the sink
    const sx0 = -0.52;
    const sx1 = -0.1;
    const sz0 = -0.17;
    const sz1 = 0.15;
    const ty0 = H - 0.06;
    const zf = hd + 0.01;
    g.box(-hw, ty0, -hd, sx0, H, zf, stone);
    g.box(sx1, ty0, -hd, hw, H, zf, stone);
    g.box(sx0, ty0, -hd, sx1, H, sz0, stone, { skip: 3 });
    g.box(sx0, ty0, sz1, sx1, H, zf, stone, { skip: 3 });
    g.box(sx0, H - 0.17, sz0, sx1, H, sz1, STEEL, { invert: true, skip: 8 });
    g.ring((sx0 + sx1) / 2, H - 0.168, 0, 0, 0.025, DARK, 8);
    g.tube(
      [
        [-0.31, H, -0.24],
        [-0.31, H + 0.17, -0.24],
        [-0.31, H + 0.21, -0.2],
        [-0.31, H + 0.2, -0.12],
        [-0.31, H + 0.15, -0.09],
      ],
      0.012,
      STEEL,
      6,
    );
    g.box(-0.25, H, -0.255, -0.2, H + 0.05, -0.225, STEEL, { occ: false });
    // fronts: drawers, sink doors, oven, cold drawers
    const fz0 = hd - 0.03;
    const fz1 = hd - 0.008;
    const front = (x0: number, x1: number, y0: number, y1: number, st: St, vertical = false): void => {
      g.box(x0 + 0.004, y0 + 0.004, fz0, x1 - 0.004, y1 - 0.004, fz1, st, { bevel: 0.004, occ: false, skip: 16 });
      if (vertical) g.box(x1 - 0.045, (y0 + y1) / 2 - 0.08, fz1, x1 - 0.03, (y0 + y1) / 2 + 0.08, fz1 + 0.022, handle, { occ: false });
      else g.box((x0 + x1) / 2 - 0.1, y1 - 0.05, fz1, (x0 + x1) / 2 + 0.1, y1 - 0.035, fz1 + 0.022, handle, { occ: false });
    };
    const fy0 = 0.09;
    const fy1 = H - 0.07;
    const fh = fy1 - fy0;
    front(-hw, -0.6, fy0, fy0 + fh * 0.4, BIRCH);
    front(-hw, -0.6, fy0 + fh * 0.4, fy0 + fh * 0.72, BIRCH);
    front(-hw, -0.6, fy0 + fh * 0.72, fy1, BIRCH);
    front(-0.6, -0.3, fy0, fy1, BIRCH, true);
    front(-0.3, 0, fy0, fy1, BIRCH, true);
    front(0, 0.6, fy0, fy1 - 0.13, S(0x101214, 0.12, 0.9));
    g.box(0.004, fy1 - 0.126, fz0, 0.596, fy1 - 0.004, fz1, METAL, { occ: false, skip: 16 });
    g.at(0.3, fy1 - 0.065, fz1, 0, () => {
      panel(0.16, 0.06, R.clock, { ...SCR, emis: 1.0 }, -0.17, 0, 0.002);
      for (const kx of [0.1, 0.2]) g.cyl([kx, 0, 0], [kx, 0, 0.02], 0.022, 0.02, STEEL, CS, 2);
    });
    front(0.6, hw, fy0, fy0 + fh * 0.5, S(0xb9bec3, 0.35, 0.8));
    front(0.6, hw, fy0 + fh * 0.5, fy1, S(0xb9bec3, 0.35, 0.8));
    // hob
    g.box(0.12, H, -0.2, 0.56, H + 0.006, 0.16, S(0x0d0e10, 0.1, 0.95), { occ: false, skip: 4 });
    for (const [rx, rz, rr] of [
      [0.24, -0.05, 0.075],
      [0.44, -0.05, 0.06],
    ])
      g.ring(rx, H + 0.0068, rz, rr - 0.012, rr, glow(0xd0503a, 0.25), 16);
    g.cyl([0.24, H + 0.007, -0.05], [0.24, H + 0.1, -0.05], 0.07, 0.074, STEEL, CS, 2);
    g.ball([0.24, H + 0.112, -0.05], 0.018, 0.012, 0.018, DARK, 8);
    g.box(0.305, H + 0.05, -0.058, 0.4, H + 0.066, -0.042, DARK, { occ: false });
    // mugs clipped into their rack, a board, jars, a bowl of fruit under a net
    g.box(0.66, H, -0.26, 1.14, H + 0.012, -0.12, S(0x6b7076, 0.5, 0.5), { occ: false });
    [ACC, MUSTARD, CREAM].forEach((st, i) => {
      const mx = 0.74 + i * 0.16;
      mug(mx, H + 0.012, -0.19, st, 0.9 + i * 0.4);
      g.box(mx - 0.045, H + 0.012, -0.255, mx - 0.039, H + 0.07, -0.235, STEEL, { occ: false });
      g.box(mx + 0.039, H + 0.012, -0.255, mx + 0.045, H + 0.07, -0.235, STEEL, { occ: false });
    });
    g.at(-0.95, H, -0.27, 0, () => g.box(-0.16, 0, -0.012, 0.16, 0.24, 0.012, WOOD, { bevel: 0.006 }), -0.14);
    [0x8a5a3a, 0xd9c9a8, 0x5c7a45].forEach((c, i) => {
      const jx = -0.72 + i * 0.085;
      g.cyl([jx, H, -0.22], [jx, H + 0.1, -0.22], 0.034, 0.034, S(c, 0.3, 0.6), CS, 0);
      g.cyl([jx, H + 0.1, -0.22], [jx, H + 0.118, -0.22], 0.036, 0.036, DARK, CS, 2);
    });
    g.cyl([0.86, H, 0.08], [0.86, H + 0.045, 0.08], 0.07, 0.1, S(0xd9d2c4, 0.5, 0.3), CS, 0);
    for (const [ox, oz] of [
      [0.83, 0.06],
      [0.9, 0.07],
      [0.86, 0.115],
    ])
      g.ball([ox, H + 0.058, oz], 0.034, 0.034, 0.034, S(0xe08a2c, 0.6, 0.2), 8);
    // splashback, rail with utensils
    g.box(-hw, H, -hd, hw, H + 0.6, -hd + 0.008, S(0x2d6a6e, 0.25, 0.6), { occ: false, skip: 16 });
    g.tube(
      [
        [-1.12, H + 0.3, -hd + 0.04],
        [-0.6, H + 0.3, -hd + 0.04],
      ],
      0.008,
      STEEL,
      6,
    );
    for (let i = 0; i < 4; i++) {
      const ux = -1.05 + i * 0.12;
      g.box(ux - 0.006, H + 0.12, -hd + 0.03, ux + 0.006, H + 0.3, -hd + 0.036, i % 2 ? STEEL : DARK, { occ: false });
      g.box(ux - 0.025, H + 0.07, -hd + 0.03, ux + 0.025, H + 0.13, -hd + 0.036, i % 2 ? STEEL : DARK, { occ: false });
    }
  };

  const upperCabinet = (W: number, D: number, H: number): void => {
    const hw = W / 2;
    const hd = D / 2;
    g.box(-hw, 0, -hd, hw, H, hd - 0.022, BIRCH);
    const nd = Math.max(1, Math.round(W / 0.6));
    for (let i = 0; i < nd; i++) {
      const x0 = -hw + (W * i) / nd;
      const x1 = -hw + (W * (i + 1)) / nd;
      g.box(x0 + 0.004, 0.004, hd - 0.022, x1 - 0.004, H - 0.004, hd, BIRCH, { bevel: 0.004, occ: false, skip: 16 });
      g.box((x0 + x1) / 2 - 0.06, 0.03, hd, (x0 + x1) / 2 + 0.06, 0.045, hd + 0.02, S(0x2a2c30, 0.4, 0.6), { occ: false });
    }
    const c: P3 = [1.0, 0.86, 0.68];
    g.box(-hw + 0.1, -0.012, -0.02, hw - 0.1, 0, 0.04, { c, rough: 0.5, spec: 0, emis: 2.6, group: G_MAIN }, { occ: false, skip: 8 });
    const ns = Math.max(2, Math.round(W / 0.5));
    for (let i = 0; i < ns; i++) g.light(-hw + (W * (i + 0.5)) / ns, -0.04, 0.02, c, 0.05, false, 1, 2.2);
  };

  const table = (W: number, D: number, H: number): void => {
    const hw = W / 2;
    const hd = D / 2;
    g.box(-hw, H - 0.04, -hd, hw, H, hd, WOOD, { bevel: 0.012 });
    const lip = S(0x8c6238, 0.6, 0.3);
    g.box(-hw, H, hd - 0.014, hw, H + 0.012, hd, lip, { occ: false });
    g.box(-hw, H, -hd + 0.014, -hw + 0.014, H + 0.012, hd - 0.014, lip, { occ: false });
    g.box(hw - 0.014, H, -hd + 0.014, hw, H + 0.012, hd - 0.014, lip, { occ: false });
    g.box(-0.05, 0.03, 0.08, 0.05, H - 0.04, 0.18, METAL, { bevel: 0.012 });
    g.box(-0.24, 0, -0.02, 0.24, 0.03, 0.3, METAL, { bevel: 0.01 });
    g.along([0, H - 0.3, -hd], [0, H - 0.05, -hd + 0.25], (L) => g.box(-0.02, -0.012, 0, 0.02, 0.012, L, METAL, { occ: false }));
    // on it: a mug, a tablet left on, a paperback
    mug(0.28, H, 0.12, ACC, 2.2);
    flat(-0.2, H + 0.004, 0.1, -HP + 0.25, () => {
      g.box(-0.085, -0.115, -0.004, 0.085, 0.115, 0.004, DARK, { bevel: 0.003, occ: false });
      panel(0.15, 0.2, R.tablet, { ...SCR, emis: 0.7 }, 0, 0, 0.0055);
    });
    g.at(0.1, H, -0.2, 0.5, () => {
      g.box(-0.07, 0, -0.1, 0.07, 0.022, 0.1, RUST, { occ: false });
      g.box(-0.068, 0.003, -0.098, 0.072, 0.019, 0.098, CREAM, { occ: false });
    });
    g.light(-0.2, H + 0.1, 0.1, [0.8, 0.9, 1.0], 0.006, true, 0, 1.2);
  };

  const bench = (W: number, D: number, H: number): void => {
    const hw = W / 2;
    const hd = D / 2;
    const base = S(0x8b8478, 0.7, 0.2);
    g.box(-hw, 0, -hd, hw, 0.06, hd - 0.04, DARK);
    g.box(-hw, 0.06, -hd, hw, H - 0.1, hd, base, { bevel: 0.008 });
    g.box(-0.08, H - 0.2, hd, 0.08, H - 0.185, hd + 0.015, METAL, { occ: false });
    for (const s of [-1, 1]) {
      const x0 = s < 0 ? -hw + 0.012 : 0.006;
      const x1 = s < 0 ? -0.006 : hw - 0.012;
      g.rbox(x0, H - 0.11, -hd + 0.03, x1, H, hd - 0.008, 0.04, ACC, 2);
      g.rbox(x0, H + 0.01, -hd - 0.05, x1, H + 0.46, -hd + 0.045, 0.04, ACC, 2);
    }
    g.box(-hw, H - 0.1, -hd - 0.065, hw, H + 0.5, -hd - 0.04, base, { bevel: 0.006 });
  };

  const sofa = (W: number, D: number, H: number): void => {
    const hw = W / 2;
    const hd = D / 2;
    g.box(-hw, 0, -hd, hw, 0.1, hd - 0.05, DARK);
    g.box(-hw, 0.1, -hd, hw, H - 0.15, hd, S(0x9a7430, 0.9, 0.08), { bevel: 0.01 });
    for (const s of [-1, 1]) {
      const x0 = s < 0 ? -hw + 0.01 : 0.006;
      const x1 = s < 0 ? -0.006 : hw - 0.01;
      g.rbox(x0, H - 0.17, -hd + 0.14, x1, H, hd - 0.005, 0.05, MUSTARD, 2);
      g.rbox(x0, H - 0.03, -hd, x1, H + 0.47, -hd + 0.16, 0.055, MUSTARD, 2);
    }
    g.at(-hw + 0.2, H + 0.13, 0.02, 0.5, () => g.rbox(-0.16, -0.16, -0.05, 0.16, 0.16, 0.05, 0.045, ACC, 2), -0.35, 0.2);
    g.rbox(hw - 0.36, H - 0.005, -0.06, hw - 0.04, H + 0.04, 0.26, 0.018, RUST, 1);
    flat(hw - 0.2, H + 0.0415, 0.1, 0, () => panel(0.28, 0.28, R.plaid, TEX, 0, 0, 0));
  };

  const bunk = (W: number, D: number, H: number, upper: boolean, ceilAbove: number): void => {
    const hw = W / 2;
    const hd = D / 2;
    const frame = S(0xc8c6c0, 0.6, 0.25);
    let top = H;
    if (upper) {
      g.box(-hw, 0, -hd, hw, H, hd, frame, { bevel: 0.01 });
      g.box(-hw * 0.75, H, hd - 0.02, hw * 0.6, H + 0.13, hd, frame, { bevel: 0.006 });
      g.rbox(-hw + 0.02, H, -hd + 0.02, hw - 0.02, H + 0.11, hd - 0.03, 0.035, CREAM, 1);
      top = H + 0.11;
    } else {
      g.box(-hw, 0, -hd, hw, 0.06, hd - 0.04, DARK);
      g.box(-hw, 0.06, -hd, hw, H - 0.13, hd, frame, { bevel: 0.01 });
      for (const s of [-1, 1]) {
        g.box(s < 0 ? -hw + 0.02 : 0.01, 0.09, hd, s < 0 ? -0.01 : hw - 0.02, H - 0.16, hd + 0.012, S(0xb7b3a8, 0.6, 0.25), { bevel: 0.004, occ: false, skip: 16 });
        g.box(s * hw * 0.5 - 0.09, H - 0.24, hd + 0.012, s * hw * 0.5 + 0.09, H - 0.225, hd + 0.03, METAL, { occ: false });
      }
      g.rbox(-hw + 0.015, H - 0.14, -hd + 0.015, hw - 0.015, H, hd - 0.015, 0.04, CREAM, 2);
    }
    // bedding: pillow at the head (fore), blanket, sleep restraint straps
    g.rbox(-hw + 0.05, top - 0.02, -hd + 0.07, -hw + 0.5, top + 0.075, hd - 0.08, 0.04, S(0xf2efe8, 0.95, 0.05), 2);
    const blanket = upper ? S(0x7a2f3e, 0.95, 0.05) : S(0x34506b, 0.95, 0.05);
    g.rbox(-hw + 0.62, top - 0.06, -hd + 0.012, hw - 0.03, top + 0.03, hd - 0.012, 0.035, blanket, 2);
    g.rbox(-hw + 0.56, top - 0.05, -hd + 0.01, -hw + 0.72, top + 0.04, hd - 0.01, 0.03, CREAM, 1);
    flat((0.62 + W - 0.03) / 2 - hw + 0.05, top + 0.0312, 0, HP, () => panel(D - 0.12, W - 0.85, upper ? null : R.plaid, upper ? blanket : TEX, 0, 0, 0));
    for (const sx of [-hw + 1.0, -hw + 1.7]) {
      g.box(sx - 0.025, top + 0.03, -hd + 0.02, sx + 0.025, top + 0.036, hd - 0.02, WEB, { occ: false });
      g.box(sx - 0.03, top + 0.034, hd - 0.12, sx + 0.03, top + 0.046, hd - 0.06, STEEL, { occ: false });
    }
    // reading light on the head wall
    const ly = top + 0.42;
    const lc: P3 = [1.0, 0.78, 0.5];
    g.tube(
      [
        [-hw, ly, -hd + 0.12],
        [-hw + 0.06, ly + 0.02, -hd + 0.12],
        [-hw + 0.14, ly - 0.02, -hd + 0.14],
      ],
      0.008,
      METAL,
      6,
    );
    g.cyl([-hw + 0.13, ly - 0.01, -hd + 0.138], [-hw + 0.19, ly - 0.06, -hd + 0.16], 0.016, 0.04, DARK, CS, 1);
    g.at(-hw + 0.191, ly - 0.061, -hd + 0.1605, 0, () => g.ring(0, 0, 0, 0, 0.034, { c: lc, rough: 0.5, spec: 0, emis: 2.4, group: G_MAIN }, CS), 0.35, -2.2);
    g.light(-hw + 0.22, ly - 0.1, -hd + 0.17, lc, 0.035, false, 0.6, 1.6);
    // privacy curtain gathered at the foot
    const cy1 = upper ? ceilAbove : H + 0.68;
    for (let i = 0; i < 5; i++) g.cyl([hw - 0.06 - i * 0.045, top - 0.1, hd - 0.035 - (i % 2) * 0.02], [hw - 0.06 - i * 0.045, cy1 - 0.02, hd - 0.035 - (i % 2) * 0.02], 0.026, 0.026, ACC, 6, 0);
    g.tube(
      [
        [-hw + 0.02, cy1 - 0.025, hd - 0.04],
        [hw - 0.02, cy1 - 0.025, hd - 0.04],
      ],
      0.007,
      STEEL,
      5,
    );
    if (!upper) {
      // a shelf of books and a photo inside the alcove
      onWall(0, 1, 0.35, top + 0.3, -hd, () => {
        g.box(-0.24, 0, 0, 0.24, 0.014, 0.11, WOOD, { occ: false });
        g.box(-0.22, 0.014, 0.02, 0.1, 0.105, 0.09, S(0x1a1410, 0.8, 0.1), { occ: false });
        panel(0.32, 0.091, R.books, TEX, -0.06, 0.0595, 0.0905);
        g.box(0.13, 0.014, 0.03, 0.22, 0.09, 0.04, CREAM, { occ: false });
        panel(0.07, 0.056, R.poster, TEX, 0.175, 0.052, 0.0405);
      });
    }
  };

  const lockerBank = (W: number, D: number, H: number): void => {
    const hw = W / 2;
    const hd = D / 2;
    const steel = S(0x8d9aa3, 0.45, 0.55);
    g.box(-hw, 0, -hd, hw, H, hd - 0.02, S(0x6f7b83, 0.5, 0.45));
    const nd = Math.max(2, Math.round(W / 0.34));
    for (let i = 0; i < nd; i++) {
      const x0 = -hw + (W * i) / nd;
      const x1 = -hw + (W * (i + 1)) / nd;
      const xm = (x0 + x1) / 2;
      g.box(x0 + 0.006, 0.09, hd - 0.02, x1 - 0.006, H - 0.11, hd, steel, { bevel: 0.006, occ: false, skip: 16 });
      for (const vy of [0.2, H - 0.3]) for (let k = 0; k < 4; k++) g.box(xm - 0.08, vy + k * 0.028, hd, xm + 0.08, vy + k * 0.028 + 0.01, hd + 0.003, DARK, { occ: false, skip: 16 });
      g.box(x1 - 0.06, H * 0.48, hd, x1 - 0.03, H * 0.48 + 0.12, hd + 0.02, METAL, { bevel: 0.004, occ: false });
      g.at(xm, H * 0.7, hd, 0, () => panel(0.13, 0.05, R[`tag${i % 2}`], TEX, 0, 0, 0.002));
      g.box(x0 + 0.03, H - 0.16, hd, x0 + 0.045, H - 0.145, hd + 0.004, glow(i === 1 ? 0xffb347 : 0x58f0a0, 1.2, G_BLINK), { occ: false });
    }
  };

  const washFixture = (W: number, D: number, H: number): void => {
    const hw = W / 2;
    const hd = D / 2;
    const white = S(0xeef0ee, 0.35, 0.5);
    g.box(-hw, 0, -hd, hw, 0.06, hd - 0.04, DARK);
    g.box(-hw, 0.06, -hd, hw, H - 0.07, hd - 0.02, white);
    g.box(-hw + 0.006, 0.08, hd - 0.02, hw - 0.006, H - 0.08, hd, S(0x7fb0b0, 0.4, 0.4), { bevel: 0.005, occ: false, skip: 16 });
    g.box(hw - 0.07, H * 0.45, hd, hw - 0.055, H * 0.45 + 0.14, hd + 0.02, STEEL, { occ: false });
    const bx = 0.16;
    const bz0 = -0.1;
    const bz1 = 0.12;
    const ty0 = H - 0.07;
    g.box(-hw, ty0, -hd, -bx, H, hd + 0.01, white);
    g.box(bx, ty0, -hd, hw, H, hd + 0.01, white);
    g.box(-bx, ty0, -hd, bx, H, bz0, white, { skip: 3 });
    g.box(-bx, ty0, bz1, bx, H, hd + 0.01, white, { skip: 3 });
    g.box(-bx, H - 0.13, bz0, bx, H, bz1, STEEL, { invert: true, skip: 8 });
    g.tube(
      [
        [0, H, -0.15],
        [0, H + 0.1, -0.15],
        [0, H + 0.12, -0.11],
        [0, H + 0.1, -0.05],
      ],
      0.01,
      STEEL,
      6,
    );
    g.cyl([-0.24, H, -0.12], [-0.24, H + 0.1, -0.12], 0.025, 0.025, ACC, CS, 2);
    g.cyl([0.25, H, -0.1], [0.25, H + 0.08, -0.1], 0.028, 0.032, S(0xf2efe8, 0.4, 0.4), CS, 0);
    // mirror, its light, a towel on a rail
    onWall(0, 1, 0, H + 0.2, -hd, () => {
      g.box(-0.24, 0, 0, 0.24, 0.6, 0.012, STEEL, { bevel: 0.004, occ: false, skip: 16 });
      panel(0.44, 0.56, R.mirror, { ...TEX, rough: 0.08, spec: 1, emis: 0.1, group: G_MAIN }, 0, 0.3, 0.0125);
      const c: P3 = [1, 0.98, 0.94];
      g.box(-0.22, 0.63, 0, 0.22, 0.665, 0.035, { c, rough: 0.5, spec: 0, emis: 3, group: G_MAIN }, { occ: false, skip: 16 });
      g.light(0, 0.63, 0.12, c, 0.09, false, 0.3, 2.6);
      g.tube(
        [
          [-0.75, 0.42, 0],
          [-0.75, 0.42, 0.05],
          [-0.42, 0.42, 0.05],
          [-0.42, 0.42, 0],
        ],
        0.008,
        STEEL,
        6,
      );
      g.rbox(-0.72, 0.0, 0.035, -0.45, 0.435, 0.07, 0.012, RUST, 1);
    });
  };

  const reactor = (W: number, D: number, H: number): void => {
    const hw = W / 2;
    const hd = D / 2;
    const gun = S(0x4a4f55, 0.5, 0.5);
    const light = S(0x7d848b, 0.45, 0.55);
    const teal: P3 = hex(0x3fe0d0);
    g.box(-hw, 0, -hd, hw, 0.12, hd, DARK, { bevel: 0.02 });
    g.at(0, 0.06, hd, 0, () => panel(W - 0.1, 0.07, R.haz, TEX, 0, 0, 0.002));
    g.box(-hw + 0.08, 0.12, -hd, hw - 0.08, H - 0.28, hd - 0.07, gun, { bevel: 0.07 });
    g.box(-hw + 0.2, H - 0.28, -hd, hw - 0.2, H - 0.02, hd - 0.16, light, { bevel: 0.04 });
    const zf = hd - 0.07;
    // vents with the core glowing behind them
    g.at(0, 0, zf, 0, () => {
      panel(0.88, 0.5, null, { c: teal, rough: 0.5, spec: 0, emis: 2.2, group: G_ON }, 0, 0.53, 0.002);
      for (let i = 0; i < 8; i++) g.box(-0.45, 0.292 + i * 0.062, 0.012, 0.45, 0.326 + i * 0.062, 0.04, METAL, { occ: false });
      g.box(-0.48, 0.26, 0, -0.44, 0.8, 0.05, light, { occ: false });
      g.box(0.44, 0.26, 0, 0.48, 0.8, 0.05, light, { occ: false });
      g.box(-0.48, 0.8, 0, 0.48, 0.83, 0.05, light, { occ: false });
      g.box(-0.48, 0.23, 0, 0.48, 0.26, 0.05, light, { occ: false });
    });
    for (const lx of [-0.25, 0.25]) g.light(lx, 0.53, hd + 0.2, teal, 0.07, true, 0, 3.2);
    // sight port with its bolt circle, status display
    g.at(-0.24, 1.06, zf, 0, () => {
      g.at(0, 0, 0, 0, () => {
        g.cyl([0, 0, 0], [0, 0.04, 0], 0.19, 0.18, light, 16, 0);
        g.ring(0, 0.04, 0, 0.13, 0.18, light, 16);
        g.ring(0, 0.03, 0, 0, 0.13, { c: teal, rough: 0.2, spec: 0, emis: 1.3, group: G_ON }, 16);
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * TAU;
          g.cyl([Math.cos(a) * 0.155, 0.04, Math.sin(a) * 0.155], [Math.cos(a) * 0.155, 0.052, Math.sin(a) * 0.155], 0.012, 0.012, STEEL, 6, 2);
        }
      }, HP);
    });
    g.at(0.3, 1.08, zf, 0, () => screen(0.4, 0.25, 'reactor'));
    g.at(0.3, 0.9, zf, 0, () => panel(0.36, 0.045, R.leds, { ...SCR, emis: 1.2, group: G_BLINK }, 0, 0, 0.002));
    // plumbing: to the overhead, and coolant loops out of the flanks
    const lagged = S(0xd8d0bc, 0.8, 0.1);
    for (const px of [-0.28, 0.28]) {
      g.cyl([px, H - 0.02, -0.18], [px, H + 0.36, -0.18], 0.06, 0.06, lagged, CS, 0);
      g.cyl([px, H + 0.1, -0.18], [px, H + 0.125, -0.18], 0.075, 0.075, STEEL, CS, 3);
    }
    const copper = S(0xb0703c, 0.35, 0.8);
    for (const s of [-1, 1]) {
      g.tube(
        [
          [s * (hw - 0.09), 0.5, 0.1],
          [s * (hw + 0.02), 0.5, 0.1],
          [s * (hw + 0.06), 0.54, 0.1],
          [s * (hw + 0.06), 1.1, 0.1],
          [s * (hw + 0.06), 1.16, 0.06],
          [s * (hw + 0.06), 1.16, -hd],
        ],
        0.03,
        copper,
        8,
      );
      g.cyl([s * (hw + 0.06), 0.8, 0.1], [s * (hw + 0.06), 0.83, 0.1], 0.042, 0.042, STEEL, CS, 3);
    }
    g.at(hw + 0.06, 0.95, 0.14, 0, () => {
      const pts: P3[] = [];
      for (let i = 0; i <= 12; i++) pts.push([Math.cos((i / 12) * TAU) * 0.06, Math.sin((i / 12) * TAU) * 0.06, 0]);
      g.tube(pts, 0.008, S(0xc0392b, 0.5, 0.3), 5);
      g.cyl([0, 0, -0.04], [0, 0, 0.004], 0.012, 0.012, STEEL, 6, 2);
    });
  };

  const rack = (W: number, D: number, H: number): void => {
    const hw = W / 2;
    const hd = D / 2;
    g.box(-hw, 0, -hd, hw, H, hd - 0.03, S(0x2a2d31, 0.6, 0.4));
    const bays = Math.max(1, Math.round(W / 0.5));
    const unitCols = [0x3a3e44, 0x4b5057, 0x2f3338, 0xbfb7a4, 0x3a3e44, 0x555b63];
    for (let bi = 0; bi < bays; bi++) {
      const x0 = -hw + (W * bi) / bays;
      const x1 = -hw + (W * (bi + 1)) / bays;
      g.box(x0, 0, hd - 0.03, x0 + 0.025, H, hd, METAL, { occ: false });
      g.box(x1 - 0.025, 0, hd - 0.03, x1, H, hd, METAL, { occ: false });
      const nU = 6;
      const u0 = 0.12;
      const uh = (H - 0.3) / nU;
      for (let ui = 0; ui < nU; ui++) {
        const y0 = u0 + ui * uh;
        const kind = (ui + bi * 2) % 4;
        g.box(x0 + 0.03, y0 + 0.006, hd - 0.03, x1 - 0.03, y0 + uh - 0.006, hd - 0.006, S(unitCols[(ui + bi * 3) % unitCols.length], 0.5, 0.45), { bevel: 0.004, occ: false, skip: 16 });
        const xm = (x0 + x1) / 2;
        const ym = y0 + uh / 2;
        for (const s of [-1, 1]) g.box(xm + s * 0.18 - 0.006, ym - 0.05, hd - 0.006, xm + s * 0.18 + 0.006, ym + 0.05, hd + 0.014, STEEL, { occ: false });
        g.at(xm, ym, hd - 0.006, 0, () => {
          if (kind === 0) panel(0.3, 0.075, R.leds, { ...SCR, emis: 1.3, group: G_BLINK }, 0, 0, 0.002);
          else if (kind === 1) for (let k = 0; k < 6; k++) g.box(-0.14, -0.06 + k * 0.022, 0, 0.14, -0.052 + k * 0.022, 0.003, DARK, { occ: false, skip: 16 });
          else if (kind === 2) {
            panel(0.15, 0.11, R.log, { ...SCR, emis: 0.9 }, -0.07, 0, 0.002);
            panel(0.13, 0.065, R.keys, { ...SCR, emis: 0.7 }, 0.085, 0, 0.002);
          } else {
            panel(0.3, 0.04, R.leds, { ...SCR, emis: 1.3, group: G_BLINK }, 0, 0.035, 0.002);
            for (let k = 0; k < 4; k++) g.cyl([-0.12 + k * 0.08, -0.035, 0], [-0.12 + k * 0.08, -0.035, 0.016], 0.016, 0.014, STEEL, 8, 2);
          }
        });
      }
    }
    g.light(0, H * 0.5, hd + 0.25, [0.4, 1.0, 0.6], 0.012, true, 0, 2.0);
    [0xd9b23a, 0x3a78c2, 0x9a9da1].forEach((c, i) => {
      const cx = -hw + 0.2 + i * 0.07;
      g.tube(
        [
          [cx, H - 0.16, hd - 0.004],
          [cx, H - 0.14, hd + 0.03],
          [cx, H - 0.06, hd + 0.05],
          [cx + 0.03, H - 0.02, hd + 0.08],
          [cx + 0.03, H, hd + 0.2],
        ],
        0.009,
        S(c, 0.6, 0.2),
        5,
      );
    });
  };

  const workbench = (W: number, D: number, H: number): void => {
    const hw = W / 2;
    const hd = D / 2;
    const blue = S(0x4b6478, 0.5, 0.45);
    const red = S(0xa33a2a, 0.45, 0.5);
    g.box(-hw, 0, -hd, -hw + 0.04, H - 0.06, hd, blue);
    g.box(hw - 0.04, 0, -hd, hw, H - 0.06, hd, blue);
    g.box(-hw, 0, -hd, hw, H - 0.06, -hd + 0.02, blue);
    g.box(-hw, H - 0.06, -hd, hw, H, hd + 0.01, WOOD, { bevel: 0.008 });
    g.box(-hw + 0.04, 0.05, -hd + 0.02, -0.04, H - 0.07, hd - 0.02, red);
    for (let i = 0; i < 4; i++) {
      const y0 = 0.07 + i * 0.185;
      g.box(-hw + 0.05, y0, hd - 0.02, -0.05, y0 + 0.17, hd - 0.004, red, { bevel: 0.004, occ: false, skip: 16 });
      g.box(-hw + 0.12, y0 + 0.12, hd - 0.004, -0.12, y0 + 0.135, hd + 0.014, STEEL, { occ: false });
    }
    g.box(0.0, 0.3, -hd + 0.02, hw - 0.04, 0.32, hd - 0.03, blue, { occ: false });
    g.box(0.08, 0.32, -hd + 0.08, 0.42, 0.52, hd - 0.1, S(0x5c6b3a, 0.7, 0.2), { bevel: 0.01 });
    g.box(0.1, 0.02, -hd + 0.1, 0.4, 0.26, hd - 0.1, S(0x9aa0a6, 0.6, 0.3), { bevel: 0.01 });
    // top: cutting mat, vise, a unit under repair, hand tools
    g.box(-0.3, H, -0.18, 0.3, H + 0.004, 0.2, S(0x2f6b4f, 0.8, 0.1), { occ: false, skip: 4 });
    g.at(-hw + 0.14, H, 0.14, 0, () => {
      g.box(-0.06, 0, -0.05, 0.06, 0.05, 0.05, METAL, { bevel: 0.006 });
      g.box(-0.05, 0.05, -0.06, 0.05, 0.11, -0.03, STEEL, { occ: false });
      g.box(-0.05, 0.05, 0.02, 0.05, 0.11, 0.05, STEEL, { occ: false });
      g.cyl([0, 0.075, 0.05], [0, 0.075, 0.14], 0.008, 0.008, STEEL, 6, 2);
      g.cyl([-0.04, 0.075, 0.135], [0.04, 0.075, 0.135], 0.005, 0.005, STEEL, 6, 3);
    });
    g.at(0.02, H + 0.004, 0.0, 0.3, () => {
      g.box(-0.09, 0, -0.06, 0.09, 0.05, 0.06, S(0xbfb7a4, 0.5, 0.3), { bevel: 0.006 });
      g.box(-0.07, 0.05, -0.045, 0.02, 0.052, 0.045, S(0x1f4d2e, 0.5, 0.4), { occ: false });
      g.box(-0.06, 0.052, -0.03, -0.03, 0.062, 0.0, DARK, { occ: false });
      [0xc0392b, 0xd9b23a, 0x3a78c2].forEach((c, i) =>
        g.tube(
          [
            [0.0, 0.055, -0.03 + i * 0.03],
            [0.06, 0.09, -0.03 + i * 0.03],
            [0.13, 0.03, -0.05 + i * 0.05],
            [0.17, 0.004, -0.06 + i * 0.06],
          ],
          0.004,
          S(c, 0.6, 0.2),
          4,
        ),
      );
      g.box(0.034, 0.052, -0.02, 0.04, 0.056, 0.02, glow(0x58f0a0, 1.5, G_BLINK), { occ: false });
    });
    g.at(0.26, H + 0.004, 0.12, -0.5, () => {
      g.box(-0.09, 0, -0.012, 0.09, 0.008, 0.012, STEEL, { occ: false });
      g.box(0.08, 0, -0.025, 0.115, 0.008, 0.025, STEEL, { occ: false });
    });
    g.cyl([0.2, H + 0.016, -0.1], [0.3, H + 0.016, -0.13], 0.014, 0.014, S(0xe0902a, 0.5, 0.3), 8, 3);
    g.cyl([0.3, H + 0.016, -0.13], [0.4, H + 0.016, -0.16], 0.004, 0.004, STEEL, 5, 2);
    // magnifier lamp
    const lc: P3 = [1, 0.95, 0.85];
    g.tube(
      [
        [0.45, H, -hd + 0.05],
        [0.45, H + 0.3, -hd + 0.05],
        [0.4, H + 0.42, -hd + 0.1],
        [0.24, H + 0.36, -hd + 0.2],
      ],
      0.009,
      METAL,
      6,
    );
    g.cyl([0.24, H + 0.37, -hd + 0.2], [0.24, H + 0.34, -hd + 0.2], 0.07, 0.075, DARK, CS, 1);
    g.at(0.24, H + 0.339, -hd + 0.2, 0, () => g.ring(0, 0, 0, 0.035, 0.068, { c: lc, rough: 0.5, spec: 0, emis: 2.6, group: G_MAIN }, 16), Math.PI);
    g.light(0.24, H + 0.3, -hd + 0.2, lc, 0.045, false, 0.8, 1.8);
    // pegboard with the tools on it
    onWall(0, 1, 0, H + 0.14, -hd, () => {
      g.box(-hw + 0.03, 0, 0, hw - 0.03, 0.62, 0.014, S(0xcbb891, 0.8, 0.1), { bevel: 0.004, occ: false, skip: 16 });
      const z = 0.014;
      for (let i = 0; i < 5; i++) {
        const tx = -hw + 0.12 + i * 0.075;
        const len = 0.3 - i * 0.035;
        g.box(tx - 0.009, 0.52 - len, z, tx + 0.009, 0.52, z + 0.008, STEEL, { occ: false });
        g.box(tx - 0.02, 0.5, z, tx + 0.02, 0.55, z + 0.008, STEEL, { occ: false });
      }
      g.box(0.0, 0.2, z, 0.022, 0.5, z + 0.02, WOOD, { occ: false });
      g.box(-0.05, 0.47, z, 0.075, 0.53, z + 0.035, METAL, { bevel: 0.005, occ: false });
      g.box(0.14, 0.3, z, 0.165, 0.52, z + 0.02, S(0xe0902a, 0.5, 0.3), { occ: false });
      g.box(0.149, 0.1, z + 0.006, 0.156, 0.3, z + 0.013, STEEL, { occ: false });
      g.cyl([0.3, 0.42, z], [0.3, 0.42, z + 0.04], 0.055, 0.055, S(0x8a8f95, 0.7, 0.2), CS, 2);
      g.cyl([0.3, 0.42, z + 0.04], [0.3, 0.42, z + 0.042], 0.025, 0.025, DARK, CS, 2);
      g.box(0.24, 0.1, z, 0.44, 0.24, z + 0.05, S(0x3a78c2, 0.5, 0.3), { bevel: 0.006, occ: false });
    });
  };

  const facing = (s: InteriorSolid, room: InteriorRoom): { ry: number; free: boolean } => {
    const b = s.box;
    const r = room.box;
    if (s.kind === 'seat') return { ry: Math.PI, free: true };
    const cx = (b.min.x + b.max.x) / 2;
    const cz = (b.min.z + b.max.z) / 2;
    if (s.kind === 'bench') {
      let best: InteriorSolid | null = null;
      let bd = 1e9;
      for (const o of layout.solids) {
        if (o.kind !== 'table' || o.room !== s.room) continue;
        const d = Math.hypot((o.box.min.x + o.box.max.x) / 2 - cx, (o.box.min.z + o.box.max.z) / 2 - cz);
        if (d < bd) {
          bd = d;
          best = o;
        }
      }
      if (best) {
        const dx = (best.box.min.x + best.box.max.x) / 2 - cx;
        const dz = (best.box.min.z + best.box.max.z) / 2 - cz;
        return { ry: Math.abs(dz) >= Math.abs(dx) ? (dz > 0 ? 0 : Math.PI) : dx > 0 ? HP : -HP, free: false };
      }
    }
    const dy = b.max.y - b.min.y;
    let area = 0;
    let ry = 0;
    const tryWall = (touch: boolean, a: number, yaw: number): void => {
      if (touch && a > area) {
        area = a;
        ry = yaw;
      }
    };
    tryWall(Math.abs(b.min.x - r.min.x) < 0.08, (b.max.z - b.min.z) * dy, HP);
    tryWall(Math.abs(b.max.x - r.max.x) < 0.08, (b.max.z - b.min.z) * dy, -HP);
    tryWall(Math.abs(b.min.z - r.min.z) < 0.08, (b.max.x - b.min.x) * dy, 0);
    tryWall(Math.abs(b.max.z - r.max.z) < 0.08, (b.max.x - b.min.x) * dy, Math.PI);
    return { ry, free: area === 0 };
  };

  const solid = (s: InteriorSolid): void => {
    const ri = idOf.get(s.room) ?? 0;
    const room = rooms[ri];
    g.room = ri;
    const b = s.box;
    const { ry, free } = facing(s, room);
    const sideways = Math.abs(Math.sin(ry)) > 0.5;
    const W = sideways ? b.max.z - b.min.z : b.max.x - b.min.x;
    const D = sideways ? b.max.x - b.min.x : b.max.z - b.min.z;
    const H = b.max.y - b.min.y;
    const cx = (b.min.x + b.max.x) / 2;
    const cz = (b.min.z + b.max.z) / 2;
    g.at(cx, b.min.y, cz, ry, () => {
      switch (s.kind) {
        case 'seat':
          seat(W, D, H + 0.75, cx < 0 ? 1 : -1);
          break;
        case 'console':
          if (free) pedestal(W, D, H);
          else mainConsole(W, D, H);
          break;
        case 'counter':
          galley(W, D, H);
          break;
        case 'cabinet':
          upperCabinet(W, D, H);
          break;
        case 'table':
          table(W, D, H);
          break;
        case 'bench':
          bench(W, D, H);
          break;
        case 'sofa':
          sofa(W, D, H);
          break;
        case 'bunk':
          bunk(W, D, H, b.min.y > room.box.min.y + 0.1, room.box.max.y - b.min.y);
          break;
        case 'locker':
          lockerBank(W, D, H);
          break;
        case 'fixture':
          washFixture(W, D, H);
          break;
        case 'machinery':
          reactor(W, D, H);
          break;
        case 'rack':
          rack(W, D, H);
          break;
        case 'workbench':
          workbench(W, D, H);
          break;
        default:
          g.box(-W / 2, 0, -D / 2, W / 2, H, D / 2, FRAME, { bevel: 0.02 });
      }
    });
  };

  // ---------------------------------------------------------------------------------------------- the home in it
  const decor = (): void => {
    const roomOf = (id: string): InteriorRoom | null => rooms[idOf.get(id) ?? -1] ?? null;
    const enter = (id: string): InteriorRoom | null => {
      const r = roomOf(id);
      if (r) g.room = idOf.get(id) ?? 0;
      return r;
    };
    // cockpit: switch panels under the side windows, an eyebrow panel over the windscreen
    for (const w of layout.windows) {
      const r = roomOf(w.room);
      if (!r || !layout.interactables.some((i) => i.kind === 'helm' && i.room === w.room)) continue;
      g.room = idOf.get(w.room) ?? 0;
      if (w.wall === '+x' || w.wall === '-x') {
        const n = w.wall === '+x' ? -1 : 1;
        onWall(n, 0, w.center.x, w.center.y - w.height / 2 - 0.07, w.center.z, () => {
          const pw = w.width * 0.78;
          g.box(-pw / 2, -0.32, 0, pw / 2, 0, 0.05, S(0x2b2e33, 0.7, 0.2), { bevel: 0.01 });
          g.at(0, -0.16, 0.05, 0, () => {
            panel(0.3, 0.15, R.keys, { ...SCR, emis: 0.75 }, -pw / 2 + 0.2, 0.06, 0.002);
            panel(0.28, 0.1, R.switches, { ...TEX, emis: 0.22, group: G_ON }, -pw / 2 + 0.2, -0.085, 0.002);
            panel(0.28, 0.1, R.switches, { ...TEX, emis: 0.22, group: G_ON }, pw / 2 - 0.2, 0.08, 0.002);
            panel(0.3, 0.075, R.leds, { ...SCR, emis: 1.1, group: G_BLINK }, pw / 2 - 0.2, -0.03, 0.002);
            for (let k = 0; k < 3; k++) g.cyl([-0.1 + k * 0.1, -0.1, 0], [-0.1 + k * 0.1, -0.1, 0.02], 0.018, 0.015, STEEL, 8, 2);
          });
          g.light(0, -0.1, 0.25, [1.0, 0.75, 0.4], 0.008, true, 0, 1.5);
        });
      } else if (w.wall === '-z' || w.wall === '+z') {
        const gap = r.box.max.y - (w.center.y + w.height / 2);
        if (gap > 0.16)
          onWall(0, w.wall === '-z' ? 1 : -1, w.center.x, w.center.y + w.height / 2 + 0.06, w.center.z, () => {
            g.box(-0.7, 0, 0, 0.7, gap - 0.08, 0.04, S(0x2b2e33, 0.7, 0.2), { bevel: 0.008, occ: false });
            for (const px of [-0.5, -0.17, 0.17, 0.5]) panel(0.3, Math.min(0.11, gap - 0.1), R.switches, { ...TEX, emis: 0.22, group: G_ON }, px, (gap - 0.08) / 2, 0.042);
          });
      }
    }
    // docking hatch in the overhead
    for (const it of layout.interactables) {
      const r = roomOf(it.room);
      if (!r) continue;
      g.room = idOf.get(it.room) ?? 0;
      if (it.kind === 'hatch') {
        const C = r.box.max.y;
        g.at(it.pos.x, C, it.pos.z, 0, () => {
          // local +Y points down out of the overhead
          g.cyl([0, 0, 0], [0, 0.05, 0], 0.47, 0.45, FRAME, 24, 0);
          g.ring(0, 0.05, 0, 0.39, 0.45, S(0xe8b417, 0.6, 0.3), 24);
          g.ring(0, 0.03, 0, 0, 0.39, S(0x9aa0a6, 0.4, 0.6), 24);
          for (let i = 0; i < 12; i++) {
            const a = (i / 12) * TAU;
            g.cyl([Math.cos(a) * 0.42, 0.05, Math.sin(a) * 0.42], [Math.cos(a) * 0.42, 0.058, Math.sin(a) * 0.42], 0.014, 0.014, DARK, 6, 2);
          }
          const pts: P3[] = [];
          for (let i = 0; i <= 16; i++) pts.push([Math.cos((i / 16) * TAU) * 0.14, 0.085, Math.sin((i / 16) * TAU) * 0.14]);
          g.tube(pts, 0.011, S(0xc0392b, 0.5, 0.35), 6);
          for (let i = 0; i < 3; i++) {
            const a = (i / 3) * TAU;
            g.tube(
              [
                [0, 0.07, 0],
                [Math.cos(a) * 0.14, 0.085, Math.sin(a) * 0.14],
              ],
              0.008,
              STEEL,
              5,
            );
          }
          g.cyl([0, 0.03, 0], [0, 0.075, 0], 0.035, 0.03, STEEL, 10, 2);
          g.box(0.22, 0.03, -0.03, 0.26, 0.04, 0.03, glow(0x58f0a0, 1.4), { occ: false });
        }, Math.PI);
        g.at(it.pos.x, C - 0.002, it.pos.z - 0.62, Math.PI, () => panel(0.5, 0.125, R.hatch, TEX, 0, 0, 0), HP);
      } else if (it.kind === 'lights') {
        // on the nearest bulkhead
        const b = r.box;
        const cand: [number, number, number, number, number][] = [
          [Math.abs(it.pos.x - b.min.x), 1, 0, b.min.x, it.pos.z],
          [Math.abs(it.pos.x - b.max.x), -1, 0, b.max.x, it.pos.z],
          [Math.abs(it.pos.z - b.min.z), 0, 1, it.pos.x, b.min.z],
          [Math.abs(it.pos.z - b.max.z), 0, -1, it.pos.x, b.max.z],
        ];
        cand.sort((p, q) => p[0] - q[0]);
        const [, nx, nz, px, pz] = cand[0];
        onWall(nx, nz, px, it.pos.y, pz, () => {
          g.box(-0.05, -0.07, 0, 0.05, 0.07, 0.016, S(0xd9d6ce, 0.5, 0.3), { bevel: 0.004, occ: false, skip: 16 });
          g.box(-0.02, -0.035, 0.016, 0.02, 0.035, 0.024, S(0xf2f0ea, 0.4, 0.4), { occ: false });
          g.box(-0.012, 0.045, 0.016, 0.012, 0.055, 0.019, glow(0xffb347, 1.6), { occ: false });
        });
      }
    }
    // cabin
    const cabin = enter('cabin');
    if (cabin) {
      const b = cabin.box;
      // rug on the open deck
      flat(0.02, b.min.y + 0.004, -0.75, HP, () => panel(1.9, 1.1, R.rug, { ...TEX, rough: 0.95 }, 0, 0, 0));
      // pin-board on the fore bulkhead, poster on the aft one
      onWall(0, 1, 1.08, 0.5, b.min.z, () => {
        g.box(-0.37, -0.28, 0, 0.37, 0.28, 0.012, WOOD, { bevel: 0.004, occ: false, skip: 16 });
        panel(0.7, 0.52, R.pin1, TEX, 0, 0, 0.0125);
      });
      onWall(0, -1, 1.03, 0.42, b.max.z, () => {
        g.box(-0.2, -0.265, 0, 0.2, 0.265, 0.01, DARK, { occ: false, skip: 16 });
        panel(0.38, 0.507, R.poster, TEX, 0, 0, 0.0105);
      });
      // plant under a grow light, on a shelf over the sofa
      onWall(0, -1, -1.12, 0.42, b.max.z, () => {
        g.box(-0.36, 0, 0, 0.36, 0.022, 0.17, WOOD, { bevel: 0.005 });
        g.box(-0.27, 0.022, 0.03, 0.27, 0.12, 0.15, S(0xe9e4d8, 0.5, 0.3), { bevel: 0.01 });
        g.box(-0.255, 0.118, 0.04, 0.255, 0.121, 0.14, S(0x2a1f17, 0.95, 0.02), { occ: false });
        const greens = [0x3f7d3a, 0x56923f, 0x2f6a35, 0x6aa348];
        let sd = 11;
        const rn = (): number => (sd = (sd * 16807) % 2147483647) / 2147483647;
        for (let i = 0; i < 16; i++) {
          const px = -0.22 + rn() * 0.44;
          const hgt = 0.08 + rn() * 0.2;
          const lean = (rn() - 0.5) * 0.14;
          const pz = 0.06 + rn() * 0.06;
          const st = S(greens[i % 4], 0.6, 0.25);
          g.tube(
            [
              [px, 0.12, pz],
              [px + lean * 0.4, 0.12 + hgt * 0.6, pz + 0.01],
              [px + lean, 0.12 + hgt, pz + 0.03],
            ],
            0.004,
            st,
            4,
          );
          g.at(px + lean, 0.12 + hgt, pz + 0.035, rn() * TAU, () => g.ball([0.03, 0, 0], 0.045, 0.006, 0.024, st, 6), 0, 0.5 - rn());
          g.at(px + lean * 0.5, 0.12 + hgt * 0.6, pz + 0.02, rn() * TAU, () => g.ball([0.028, 0, 0], 0.04, 0.006, 0.022, st, 6), 0, 0.5 - rn());
        }
        // a trailing vine
        const vine: P3[] = [];
        for (let i = 0; i <= 8; i++) vine.push([0.3 + Math.sin(i * 0.9) * 0.015, 0.12 - i * 0.045 + (i === 0 ? 0 : 0), 0.15 + Math.min(i, 2) * 0.012]);
        g.tube(vine, 0.004, S(0x3f7d3a, 0.6, 0.2), 4);
        for (let i = 1; i <= 8; i++) g.at(vine[i][0], vine[i][1], vine[i][2] + 0.01, i * 2.4, () => g.ball([0.022, 0, 0], 0.03, 0.005, 0.02, S(greens[i % 4], 0.6, 0.25), 6), 0, 0.9);
        const pink: P3 = [1.0, 0.42, 0.85];
        g.box(-0.28, 0.6, 0, 0.28, 0.63, 0.13, METAL, { bevel: 0.006, occ: false });
        g.box(-0.25, 0.592, 0.03, 0.25, 0.6, 0.1, { c: pink, rough: 0.5, spec: 0, emis: 2.4, group: G_MAIN }, { occ: false, skip: 8 });
        for (const lx of [-0.13, 0.13]) g.light(lx, 0.55, 0.08, pink, 0.022, false, 0.8, 1.3);
      });
      // bookshelf with a retaining bar, aft of the table window
      onWall(-1, 0, b.max.x, 0.45, 1.05, () => {
        g.box(-0.36, 0, 0, 0.36, 0.016, 0.13, WOOD, { occ: false });
        g.box(-0.34, 0.016, 0.01, 0.22, 0.165, 0.11, S(0x1a1410, 0.8, 0.1), { occ: false });
        panel(0.56, 0.149, R.books, TEX, -0.06, 0.0905, 0.1105);
        g.tube(
          [
            [-0.36, 0.09, 0.125],
            [0.36, 0.09, 0.125],
          ],
          0.005,
          STEEL,
          5,
        );
        g.ball([0.29, 0.07, 0.065], 0.045, 0.054, 0.045, S(0x2f6f73, 0.3, 0.6), 10);
      });
      // extinguisher on the fore bulkhead
      onWall(0, 1, -0.84, -0.28, b.min.z, () => {
        g.cyl([0, -0.2, 0.06], [0, 0.16, 0.06], 0.05, 0.05, S(0xc0392b, 0.35, 0.6), CS, 1);
        g.ball([0, 0.16, 0.06], 0.05, 0.03, 0.05, S(0xc0392b, 0.35, 0.6), 8);
        g.cyl([0, 0.18, 0.06], [0, 0.23, 0.06], 0.014, 0.014, DARK, 6, 2);
        g.box(-0.06, -0.02, 0, 0.06, 0.01, 0.07, METAL, { occ: false });
      });
      // conduit along the overhead to starboard
      const C = b.max.y;
      g.box(b.max.x - 0.14, C - 0.045, b.min.z + 0.05, b.max.x - 0.05, C, b.max.z - 0.05, S(0xa9a79f, 0.6, 0.25), { occ: false, skip: 8, sub: 0.6 });
      for (const jz of [-1.9, 0.2]) g.box(b.max.x - 0.17, C - 0.06, jz, b.max.x - 0.02, C, jz + 0.16, S(0x8d9196, 0.5, 0.4), { bevel: 0.006, occ: false, skip: 8 });
    }
    // corridor: a second pin-board, first-aid box
    const corridor = enter('corridor');
    if (corridor) {
      const b = corridor.box;
      onWall(-1, 0, b.max.x, 0.42, 4.2, () => {
        g.box(-0.3, -0.18, 0, 0.3, 0.18, 0.01, WOOD, { occ: false, skip: 16 });
        panel(0.57, 0.326, R.pin2, TEX, 0, 0, 0.0105);
      });
      onWall(1, 0, b.min.x, 0.42, 3.375, () => {
        g.box(-0.12, -0.12, 0, 0.12, 0.12, 0.05, S(0xf2f4f2, 0.5, 0.3), { bevel: 0.006, occ: false, skip: 16 });
        panel(0.16, 0.16, R.sign, TEX, 0, 0, 0.051);
      });
    }
    // locker room: mag boots by the door, a helmet on its cradle
    const lockers = enter('lockers');
    if (lockers) {
      const b = lockers.box;
      for (const dx of [0, 0.14]) {
        g.box(b.max.x - 0.42 + dx, b.min.y, b.min.z + 0.06, b.max.x - 0.32 + dx, b.min.y + 0.03, b.min.z + 0.34, METAL, { occ: false });
        g.box(b.max.x - 0.415 + dx, b.min.y + 0.03, b.min.z + 0.07, b.max.x - 0.325 + dx, b.min.y + 0.12, b.min.z + 0.33, S(0xd8d4ca, 0.6, 0.25), { bevel: 0.015 });
        g.box(b.max.x - 0.41 + dx, b.min.y + 0.12, b.min.z + 0.07, b.max.x - 0.33 + dx, b.min.y + 0.3, b.min.z + 0.17, S(0xd8d4ca, 0.6, 0.25), { bevel: 0.015 });
      }
      onWall(0, -1, b.max.x - 0.35, 0.3, b.max.z, () => {
        g.box(-0.13, -0.02, 0, 0.13, 0, 0.2, METAL, { occ: false });
        g.ball([0, 0.13, 0.15], 0.14, 0.14, 0.14, S(0xe9e7e0, 0.35, 0.6), 12);
        g.ball([0, 0.14, 0.21], 0.105, 0.085, 0.1, S(0x2a2218, 0.1, 1), 10);
      });
    }
    // engineering: blueprint, hazard line at the reactor, conduits across the overhead
    const eng = enter('engineering');
    if (eng) {
      const b = eng.box;
      const C = b.max.y;
      onWall(0, 1, 1.05, 0.5, b.min.z, () => {
        g.box(-0.34, -0.26, 0, 0.34, 0.26, 0.008, S(0xd9d6ce, 0.6, 0.2), { occ: false, skip: 16 });
        panel(0.66, 0.493, R.schem, TEX, 0, 0, 0.0085);
      });
      const re = layout.solids.find((s) => s.kind === 'machinery' && s.room === eng.id);
      if (re) flat((re.box.min.x + re.box.max.x) / 2, b.min.y + 0.004, re.box.min.z - 0.1, 0, () => panel(re.box.max.x - re.box.min.x + 0.3, 0.09, R.haz, TEX, 0, 0, 0));
      g.box(b.min.x + 0.5, C - 0.05, 6.2, b.max.x, C, 6.29, S(0xa9a79f, 0.6, 0.25), { occ: false, skip: 8, sub: 0.6 });
      [0xd9b23a, 0x3a78c2, 0xc0392b].forEach((c, i) =>
        g.tube(
          [
            [b.min.x + 0.5, C - 0.03, 5.92 + i * 0.03],
            [0.2, C - 0.03, 5.92 + i * 0.03],
            [0.9, C - 0.03, 5.95 + i * 0.03],
            [b.max.x - 0.03, C - 0.03, 5.95 + i * 0.03],
            [b.max.x - 0.03, C - 0.6, 6.5 + i * 0.03],
            [b.max.x - 0.03, 0.2, 6.5 + i * 0.03],
          ],
          0.01,
          S(c, 0.6, 0.2),
          5,
        ),
      );
      g.box(b.max.x - 0.06, 0.12, 6.44, b.max.x, 0.3, 6.62, S(0x8d9196, 0.5, 0.4), { bevel: 0.006, occ: false });
    }
  };

  // ---------------------------------------------------------------------------------------------- assemble
  for (let i = 0; i < rooms.length; i++) shell(i);
  layout.windows.forEach((w, i) => windowFrame(w, wins[i]));
  for (const d of layout.doors) doorFrame(d);
  for (let i = 0; i < rooms.length; i++) fixtures(i);
  for (const s of layout.solids) solid(s);
  decor();
  void F;
  return { g, glass, wins, looks };
}

// ------------------------------------------------------------------------------------------------ materials

const VERT = /* glsl */ `
attribute vec3 aCol;
attribute vec4 aMat;
attribute vec3 aLit;
attribute vec3 aAlt;
attribute vec3 aDir;
attribute vec2 aWin;
varying vec3 vP;
varying vec3 vN;
varying vec3 vCol;
varying vec4 vMat;
varying vec2 vUv;
varying vec3 vLit;
varying vec3 vAlt;
varying vec3 vDir;
varying vec2 vWin;
void main() {
  vP = position;
  vN = normal;
  vCol = aCol;
  vMat = aMat;
  vUv = uv;
  vLit = aLit;
  vAlt = aAlt;
  vDir = aDir;
  vWin = aWin;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uAtlas;
uniform float uOn;
uniform float uGain;
uniform float uTime;
uniform vec3 uEye;
uniform vec3 uWinColor;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform int uWinCount;
uniform vec3 uWinC[8];
uniform vec4 uWinU[8];
uniform vec4 uWinV[8];
uniform vec3 uWinN[8];
uniform vec3 uRoomMin[8];
uniform vec3 uRoomMax[8];
uniform int uOccCount;
uniform vec3 uOccMin[12];
uniform vec3 uOccMax[12];
varying vec3 vP;
varying vec3 vN;
varying vec3 vCol;
varying vec4 vMat;
varying vec2 vUv;
varying vec3 vLit;
varying vec3 vAlt;
varying vec3 vDir;
varying vec2 vWin;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
// 0 where the furniture (the layout's solid boxes) stands between P and the star
float sunShadow(vec3 P) {
  vec3 d = uSunDir + step(abs(uSunDir), vec3(1e-4)) * 2e-4;
  vec3 inv = 1.0 / d;
  for (int i = 0; i < 12; i++) {
    if (i >= uOccCount) break;
    vec3 a = (uOccMin[i] - P) * inv;
    vec3 b = (uOccMax[i] - P) * inv;
    vec3 lo = min(a, b);
    vec3 hi = max(a, b);
    if (max(max(lo.x, lo.y), max(lo.z, 0.0)) < min(min(hi.x, hi.y), hi.z)) return 0.0;
  }
  return 1.0;
}
// 1 where the ray from P toward the star leaves through a window of the room P is in
float sunThroughWindows(vec3 P) {
  float m = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= uWinCount) break;
    vec3 q = step(uRoomMin[i], P) * step(P, uRoomMax[i]);
    if (q.x * q.y * q.z < 0.5) continue;
    float denom = dot(uSunDir, uWinN[i]);
    if (denom < 0.02) continue;
    float t = dot(uWinC[i] - P, uWinN[i]) / denom;
    if (t <= 0.0) continue;
    vec3 h = P + uSunDir * t - uWinC[i];
    float du = abs(dot(h, uWinU[i].xyz)) - uWinU[i].w;
    float dv = abs(dot(h, uWinV[i].xyz)) - uWinV[i].w;
    float soft = 0.008 + 0.012 * t;
    m = max(m, 1.0 - smoothstep(-soft, soft, max(du, dv)));
  }
  return m;
}
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(uEye - vP);
  vec4 tex = texture2D(uAtlas, vUv);
  float rough = vMat.x;
  float spec = vMat.y;
  float emis = vMat.z * ${EMIS_MAX.toFixed(1)};
  float grp = floor(vMat.w * 255.0 + 0.5);
  float n = vnoise(vP * 64.0);
  vec3 alb = vCol * tex.rgb * (1.0 + (n - 0.5) * 0.18 * rough);

  vec3 lamp = vLit * uOn + vAlt * mix(3.5, 0.45, uOn); // eyes open up when the cabin lights go out
  float ndl = dot(N, uSunDir);
  float sun = 0.0;
  if (ndl > 0.0 && uSunColor.r + uSunColor.g + uSunColor.b > 1e-5) {
    sun = sunThroughWindows(vP);
    if (sun > 0.0) sun *= sunShadow(vP + N * 0.03) * ndl * smoothstep(0.1, 0.4, vWin.y);
  }
  // the patch is lifted over what the outside exposure would give it, so it reads against the cabin lights
  vec3 col = alb * (lamp * uGain + vWin.x * uWinColor + uSunColor * sun * 3.0);

  // highlights from the dominant baked light, and a grazing sheen
  vec3 L = normalize(vDir + N * 1e-3);
  vec3 H = normalize(L + V);
  float sp = pow(max(dot(N, H), 0.0), mix(140.0, 6.0, rough)) * mix(3.0, 0.2, rough);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
  col += (sp * 0.5 + fres * 0.22) * spec * lamp * uGain;
  vec3 Hs = normalize(uSunDir + V);
  col += uSunColor * sun * spec * pow(max(dot(N, Hs), 0.0), mix(140.0, 6.0, rough)) * mix(1.5, 0.1, rough);

  float g = 0.0;
  if (grp > 3.5) g = mix(1.8, 0.4, uOn);
  else if (grp > 2.5) g = 0.3 + 0.7 * step(0.0, sin(uTime * (1.5 + 4.0 * hash(floor(vP * 28.0))) + 40.0 * hash(floor(vP * 28.0) + 3.1)));
  else if (grp > 1.5) g = 1.0;
  else if (grp > 0.5) g = uOn;
  col += vCol * tex.rgb * emis * g * uGain;
  gl_FragColor = vec4(col, 1.0);
}`;

const GLASS_FRAG = /* glsl */ `
precision highp float;
uniform float uOn;
uniform float uGain;
uniform vec3 uEye;
varying vec3 vP;
varying vec3 vN;
varying vec2 vUv;
void main() {
  vec3 V = normalize(uEye - vP);
  float fres = pow(1.0 - abs(dot(normalize(vN), V)), 3.0);
  float s = smoothstep(0.55, 1.0, sin((vUv.x * 1.7 + vUv.y) * 7.0)) * 0.5 + smoothstep(0.8, 1.0, sin((vUv.x * 1.7 + vUv.y) * 19.0 + 1.3)) * 0.3;
  vec3 warm = vec3(1.0, 0.82, 0.6);
  vec3 refl = warm * (0.012 + 0.11 * fres + 0.022 * s * (0.3 + fres)) * (0.15 + 0.85 * uOn) * uGain;
  gl_FragColor = vec4(refl, 1.0);
}`;

const GLASS_VERT = /* glsl */ `
varying vec3 vP;
varying vec3 vN;
varying vec2 vUv;
void main() {
  vP = position;
  vN = normal;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/**
 * Build the interior of a ship from its layout. `object3d` is in ship-local metres: give it the ship's pose and
 * draw it in its own pass (after the outside world, depth cleared) with a camera whose near plane is ~0.05 m.
 */
export function createInteriorVisual(layout: InteriorLayout, opts: InteriorOptions): InteriorVisual {
  const atlas = buildAtlas(layout);
  const built = buildInterior(layout, atlas.R, atlas.white, opts.quality !== 'low', opts.livery?.accent ?? 0x3d6e75);
  const g = built.g;
  const bake = bakeLighting(g, layout, built.looks, built.wins);
  const n = g.pos.length / 3;
  const mat = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    mat[i * 4] = Math.round(Math.min(1, Math.max(0, g.mt[i * 4])) * 255);
    mat[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, g.mt[i * 4 + 1])) * 255);
    mat[i * 4 + 2] = Math.round(Math.min(1, g.mt[i * 4 + 2] / EMIS_MAX) * 255);
    mat[i * 4 + 3] = g.mt[i * 4 + 3];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(g.pos), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(g.nrm), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.uv), 2));
  geo.setAttribute('aCol', new THREE.BufferAttribute(new Float32Array(g.col), 3));
  geo.setAttribute('aMat', new THREE.BufferAttribute(mat, 4, true));
  geo.setAttribute('aLit', new THREE.BufferAttribute(bake.lit, 3));
  geo.setAttribute('aAlt', new THREE.BufferAttribute(bake.alt, 3));
  geo.setAttribute('aDir', new THREE.BufferAttribute(bake.dir, 3));
  geo.setAttribute('aWin', new THREE.BufferAttribute(bake.win, 2));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(g.idx), 1));

  const V3 = (p: P3): THREE.Vector3 => new THREE.Vector3(p[0], p[1], p[2]);
  const wins = built.wins.slice(0, 8);
  const pad = <T>(a: T[], fill: () => T, len = 8): T[] => {
    while (a.length < len) a.push(fill());
    return a;
  };
  // the furniture that can shadow a sun patch: the solids of the rooms that have windows. Seats and consoles are
  // left out: their boxes are much bigger than they are, and a sunlit dashboard is worth more than its shadow.
  const occ = layout.solids.filter((s) => s.kind !== 'seat' && s.kind !== 'console' && wins.some((w) => layout.rooms[w.room].id === s.room)).slice(0, 12);
  const uniforms = {
    uOccCount: { value: occ.length },
    uOccMin: { value: pad(occ.map((s) => new THREE.Vector3(s.box.min.x + 0.012, s.box.min.y, s.box.min.z + 0.012)), () => new THREE.Vector3(), 12) },
    uOccMax: { value: pad(occ.map((s) => new THREE.Vector3(s.box.max.x - 0.012, s.box.max.y - 0.012, s.box.max.z - 0.012)), () => new THREE.Vector3(), 12) },
    uAtlas: { value: atlas.tex },
    uOn: { value: 1 },
    uGain: { value: 1 },
    uTime: { value: 0 },
    uEye: { value: new THREE.Vector3() },
    uWinColor: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Vector3() },
    uWinCount: { value: wins.length },
    uWinC: { value: pad(wins.map((w) => V3(w.c)), () => new THREE.Vector3()) },
    uWinU: { value: pad(wins.map((w) => new THREE.Vector4(w.u[0], w.u[1], w.u[2], w.hu)), () => new THREE.Vector4()) },
    uWinV: { value: pad(wins.map((w) => new THREE.Vector4(w.v[0], w.v[1], w.v[2], w.hv)), () => new THREE.Vector4()) },
    uWinN: { value: pad(wins.map((w) => V3(w.n)), () => new THREE.Vector3()) },
    uRoomMin: {
      value: pad(
        wins.map((w) => {
          const b = layout.rooms[w.room].box;
          return new THREE.Vector3(b.min.x - 0.2, b.min.y - 0.2, b.min.z - 0.2);
        }),
        () => new THREE.Vector3(),
      ),
    },
    uRoomMax: {
      value: pad(
        wins.map((w) => {
          const b = layout.rooms[w.room].box;
          return new THREE.Vector3(b.max.x + 0.2, b.max.y + 0.2, b.max.z + 0.2);
        }),
        () => new THREE.Vector3(),
      ),
    },
  };
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG });
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.name = 'interior';

  const gg = built.glass;
  const glassGeo = new THREE.BufferGeometry();
  glassGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(gg.pos), 3));
  glassGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(gg.nrm), 3));
  glassGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(gg.uv), 2));
  glassGeo.setIndex(new THREE.BufferAttribute(new Uint16Array(gg.idx), 1));
  const glassMat = new THREE.ShaderMaterial({
    uniforms: { uOn: uniforms.uOn, uGain: uniforms.uGain, uEye: uniforms.uEye },
    vertexShader: GLASS_VERT,
    fragmentShader: GLASS_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const glassMesh = new THREE.Mesh(glassGeo, glassMat);
  glassMesh.frustumCulled = false;
  glassMesh.renderOrder = 2;
  glassMesh.name = 'interior-glass';

  const root = new THREE.Group();
  root.name = `interior:${layout.shipId}`;
  root.add(mesh, glassMesh);

  let on = -1;
  let lastTime = 0;
  return {
    object3d: root,
    triangles: g.triangles + gg.triangles,
    drawCalls: 2,
    update(o: InteriorUpdate): void {
      const want = o.lights ? 1 : 0;
      const dt = Math.min(0.1, Math.max(0, o.time - lastTime));
      lastTime = o.time;
      if (on < 0) on = want;
      else on += (want - on) * (1 - Math.exp(-dt / 0.18));
      if (Math.abs(on - want) < 0.003) on = want;
      uniforms.uOn.value = on;
      uniforms.uTime.value = o.time % 1000;
      uniforms.uGain.value = o.gain ?? 1;
      if (o.eye) uniforms.uEye.value.set(o.eye.x, o.eye.y, o.eye.z);
      if (o.sunDir) uniforms.uSunDir.value.set(o.sunDir.x, o.sunDir.y, o.sunDir.z).normalize();
      if (o.sunColor) uniforms.uSunColor.value.set(o.sunColor.r, o.sunColor.g, o.sunColor.b);
      else uniforms.uSunColor.value.set(0, 0, 0);
      if (o.windowColor) uniforms.uWinColor.value.set(o.windowColor.r, o.windowColor.g, o.windowColor.b);
      else uniforms.uWinColor.value.set(0, 0, 0);
    },
    dispose(): void {
      root.removeFromParent();
      geo.dispose();
      glassGeo.dispose();
      material.dispose();
      glassMat.dispose();
      atlas.tex.dispose();
    },
  };
}
