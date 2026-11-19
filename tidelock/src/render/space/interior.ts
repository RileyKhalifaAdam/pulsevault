// Ship interior: the rooms of src/data/interiors.ts as geometry and baked light, for the first-person camera.
//
// Everything is built from the layout (the same boxes the crew collides with): every room's deck, overhead and
// bulkheads with the door and window openings cut where the data puts them, dressed in its style (white work
// areas with gunmetal ribs, warm living areas with light lines, the octagonal corridor), then each solid
// modelled inside its box as what it is, then the small things that make it a home.
//
// Rendering contract: MeshStandardMaterials sampling ONE procedural PBR atlas (surfaces.ts) by a per-vertex
// tile id, with a lightmap on uv channel 1 baked at BUILD time by tools/bake-interior.mjs (direct light from
// every strip, line, spot and glow, one bounce, AO; two variants "cabin lights" / "lights off", blended by a
// uniform). Meshes are grouped by room (userData.room); per room at most 4 draw calls (opaque, glow, glass,
// cutout); rooms that cannot be seen from the camera's room through the open doors are hidden every frame.
// The sun is not baked: the shell is closed and opaque and every opaque mesh casts and receives shadows, so a
// shadowed directional light in the interior scene lights the window patches.
//
// buildInterior() is pure (no DOM, no GL): the baker runs the very same code in node, so the lightmap UVs
// match; a geometry key guards against a stale bake (then a flat fallback light is used).

import * as THREE from 'three';
import type { Box, InteriorDoor, InteriorLayout, InteriorRoom, InteriorSolid, InteriorWindow } from '../../data/interiors';
import type { Quality } from '../pipeline';
import {
  GLOW_ALWAYS, GLOW_BLINK, GLOW_EMERG, GLOW_MAIN, STENCIL, TILE, TILE_METRES,
  acquireSurfaceAtlas, acquireSurfaceAtlasProgressive, createReflectionCube, createSurfaceShared, releaseSurfaceAtlas, releaseSurfaceShared,
  surfaceMaterial, surfaceRtRecord, surfaceSize,
  type P3, type StencilId, type TileId,
} from './surfaces';
import { INTERIOR_BAKE } from './interior.bake';

export interface InteriorUpdate {
  /** Seconds (any monotonic clock): blinking indicators, light fade. */
  time: number;
  /** Cabin lights on. Off leaves the emergency strips, the instruments and the reactor glow. */
  lights: boolean;
  /** Eye position, ship-local m (room culling). */
  eye?: { x: number; y: number; z: number };
  /** Display gain: 2^-EV of the pipeline, so the cabin keeps its brightness whatever the outside is exposed for. */
  gain?: number;
  /** Unused here (the sun is a real shadowed light in the interior scene); kept for the caller's contract. */
  sunDir?: { x: number; y: number; z: number };
  sunColor?: { r: number; g: number; b: number };
  windowColor?: { r: number; g: number; b: number };
}

export interface InteriorVisual {
  object3d: THREE.Object3D;
  update(o: InteriorUpdate): void;
  dispose(): void;
  /** Visible this frame (after room culling). */
  readonly triangles: number;
  readonly drawCalls: number;
  /** One group per room id (userData.room), for culling and lighting by room. */
  readonly rooms: Readonly<Record<string, THREE.Group>>;
  /** Room ids drawn this frame. */
  readonly visibleRooms: ReadonlySet<string>;
  /** GPU texture bytes (atlas share + lightmaps). */
  readonly textureBytes: number;
  /** Resolves when the baked lightmaps are decoded and in use (false: stale or missing bake, flat fallback). */
  readonly ready: Promise<boolean>;
}

export interface InteriorOptions {
  quality: Quality;
  /** Accent colour of the soft furnishings (sRGB hex). */
  livery?: { accent?: number };
}

// ---------------------------------------------------------------------------------------------------------
// vector helpers (build time only)

const add = (a: P3, b: P3): P3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: P3, s: number): P3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: P3, b: P3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: P3): number => Math.sqrt(dot(a, a));
const nrm = (a: P3): P3 => {
  const l = len(a);
  return l > 1e-12 ? mul(a, 1 / l) : [0, 0, 0];
};
const UP: P3 = [0, 1, 0];
const ONE: P3 = [1, 1, 1];
const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
function hr(i: number, s: number): number {
  let h = (Math.imul(i, 374761393) + Math.imul(s, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------------------------------------
// builder

export type Kind = 'main' | 'glow' | 'glass' | 'cut';
export interface Mat {
  tile: TileId;
  tint: P3;
  kind: Kind;
  group: number;
}
const mt = (tile: TileId, tint: P3 = ONE, kind: Kind = 'main', group = 0): Mat => ({ tile, tint, kind, group });

export interface Bucket {
  room: number;
  kind: Kind;
  detail: boolean;
  pos: number[];
  nor: number[];
  uv: number[];
  tile: number[];
  col: number[];
  idx: number[];
  /** Lightmap: chart per vertex (-1 none) and chart-local coordinates; uv1 after packing. */
  lmc: number[];
  lms: number[];
  lmt: number[];
  uv1: number[];
}

/** Lightmap charts: 0 planar face, 1 small part (6 axis directions), 2 cylinder strip (4 directions round). */
export type Chart =
  | { t: 0; o: P3; U: P3; V: P3; N: P3; poly: number[]; sw: number; sh: number; ld: number; x: number; y: number; w: number; h: number; dd: number }
  | { t: 1; c: P3; e: P3; x: number; y: number; w: number; h: number }
  | { t: 2; a: P3; d: P3; len: number; p1: P3; p2: P3; r: number; x: number; y: number; w: number; h: number; dd: number };

/** Baked light sources. type 0 line p->a, 1 rect (centre p, half axes a, b), 2 spot at p along n. */
export interface Emitter {
  type: 0 | 1 | 2;
  group: number;
  p: P3;
  a: P3;
  b: P3;
  n: P3;
  c: P3;
  k: number;
  cone: number;
}

interface PolyOpt {
  n?: P3;
  away?: P3;
  toward?: P3;
  U?: P3;
  uv?: 'world' | 'anchor' | 'fit' | 'strip';
  rect?: [number, number, number, number];
  ld?: number;
  ref?: number;
}
interface CBoxOpt {
  only?: string;
  skip?: string;
  fit?: boolean;
  ld?: number;
  face?: Record<string, [Mat, PolyOpt]>;
  noAuto?: boolean;
}

class Builder {
  room = 0;
  readonly buckets: Bucket[] = [];
  private readonly bmap = new Map<string, Bucket>();
  readonly charts: Chart[] = [];
  readonly emitters: Emitter[] = [];
  private partV: Array<[Bucket, number]> | null = null;
  private detail = false;

  constructor(readonly boxes: Box[]) {}

  bk(m: Mat): Bucket {
    const key = `${this.room}|${m.kind}|${this.detail ? 1 : 0}`;
    let b = this.bmap.get(key);
    if (!b) {
      b = { room: this.room, kind: m.kind, detail: this.detail, pos: [], nor: [], uv: [], tile: [], col: [], idx: [], lmc: [], lms: [], lmt: [], uv1: [] };
      this.bmap.set(key, b);
      this.buckets.push(b);
    }
    return b;
  }

  private vert(b: Bucket, p: P3, n: P3, u: number, v: number, m: Mat, c: number, s: number, t: number): number {
    const i = b.pos.length / 3;
    b.pos.push(p[0], p[1], p[2]);
    b.nor.push(n[0], n[1], n[2]);
    b.uv.push(u, v);
    b.tile.push(TILE[m.tile] + 16 * m.group);
    b.col.push(m.tint[0], m.tint[1], m.tint[2]);
    b.lmc.push(c);
    b.lms.push(s);
    b.lmt.push(t);
    if (c === -3 && this.partV) this.partV.push([b, i]);
    return i;
  }

  /** Face of a room box seen from inside? (hidden: flush with the room bound, facing out) */
  hidden(axis: number, side: number, coord: number): boolean {
    const bb = this.boxes[this.room];
    const lo = [bb.min.x, bb.min.y, bb.min.z][axis];
    const hi = [bb.max.x, bb.max.y, bb.max.z][axis];
    return side < 0 ? coord <= lo + 0.002 : coord >= hi - 0.002;
  }

  /** Small things: all faces share one 6-direction lightmap chart. */
  part(fn: () => void, detail = false): void {
    if (this.partV) {
      fn();
      return;
    }
    const prevD = this.detail;
    this.detail = detail || prevD;
    this.partV = [];
    fn();
    const list = this.partV;
    this.partV = null;
    this.detail = prevD;
    if (!list.length) return;
    const lo: P3 = [1e9, 1e9, 1e9];
    const hi: P3 = [-1e9, -1e9, -1e9];
    for (const [b, i] of list)
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], b.pos[i * 3 + a]);
        hi[a] = Math.max(hi[a], b.pos[i * 3 + a]);
      }
    const id = this.charts.length;
    this.charts.push({ t: 1, c: mul(add(lo, hi), 0.5), e: mul(sub(hi, lo), 0.5).map((x) => Math.max(0.004, x)) as P3, x: 0, y: 0, w: 12, h: 2 });
    for (const [b, i] of list) {
      const nx = b.nor[i * 3];
      const ny = b.nor[i * 3 + 1];
      const nz = b.nor[i * 3 + 2];
      const ax = Math.abs(nx);
      const ay = Math.abs(ny);
      const az = Math.abs(nz);
      const k = ax >= ay && ax >= az ? (nx > 0 ? 0 : 1) : ay >= az ? (ny > 0 ? 2 : 3) : nz > 0 ? 4 : 5;
      b.lmc[i] = id;
      b.lms[i] = k;
    }
  }

  poly(ptsIn: P3[], m: Mat, o: PolyOpt = {}): number {
    let pts = ptsIn;
    if (pts.length < 3) return -1;
    let N: P3 = [0, 0, 0];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      N = add(N, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]);
    }
    if (len(N) < 1e-10) return -1;
    N = nrm(N);
    let cen: P3 = [0, 0, 0];
    for (const p of pts) cen = add(cen, p);
    cen = mul(cen, 1 / pts.length);
    let flip = false;
    if (o.n) flip = dot(N, o.n) < 0;
    else if (o.away) flip = dot(N, sub(cen, o.away)) < 0;
    else if (o.toward) flip = dot(N, sub(o.toward, cen)) < 0;
    if (flip) {
      pts = pts.slice().reverse();
      N = mul(N, -1);
    }
    let U: P3 = o.U ? nrm(sub(o.U, mul(N, dot(o.U, N)))) : Math.abs(N[1]) > 0.9 ? [1, 0, 0] : nrm(cross(UP, N));
    if (len(U) < 0.5) U = Math.abs(N[1]) > 0.9 ? [1, 0, 0] : nrm(cross(UP, N));
    const V = cross(N, U);
    const S = pts.map((p) => dot(p, U));
    const T = pts.map((p) => dot(p, V));
    const smin = Math.min(...S);
    const smax = Math.max(...S);
    const tmin = Math.min(...T);
    const tmax = Math.max(...T);
    const sw = Math.max(1e-4, smax - smin);
    const sh = Math.max(1e-4, tmax - tmin);
    const [mu, mv] = TILE_METRES[m.tile];
    const rect = o.rect ?? (m.kind === 'glow' ? STENCIL.flat : undefined);
    const mode = rect ? 'rect' : o.uv ?? 'world';
    const nu = Math.max(1, Math.round(sw / mu));
    const nv = Math.max(1, Math.round(sh / mv));
    // lightmap chart
    let ch = -1;
    let own = false;
    if (m.kind === 'glass') ch = -1;
    else if (this.partV) ch = -3;
    else if (o.ref !== undefined && o.ref >= 0 && this.charts[o.ref].t === 0) ch = o.ref;
    else {
      ch = this.charts.length;
      own = true;
      const poly: number[] = [];
      for (let i = 0; i < pts.length; i++) poly.push(S[i] - smin, T[i] - tmin);
      this.charts.push({
        t: 0, o: add(add(mul(U, smin), mul(V, tmin)), mul(N, dot(pts[0], N))), U, V, N, poly, sw, sh, ld: o.ld ?? 1, x: 0, y: 0, w: 0, h: 0, dd: 0,
      });
    }
    const b = this.bk(m);
    const base = b.pos.length / 3;
    const rc = ch >= 0 && !own ? this.charts[ch] : null;
    for (let i = 0; i < pts.length; i++) {
      const s = S[i] - smin;
      const t = T[i] - tmin;
      let u: number;
      let v: number;
      if (mode === 'rect' && rect) {
        u = rect[0] + (s / sw) * (rect[2] - rect[0]);
        v = rect[1] + (t / sh) * (rect[3] - rect[1]);
      } else if (mode === 'strip') {
        u = s / mu;
        v = 0.02 + 0.96 * (t / sh);
      } else if (mode === 'fit') {
        u = (s / sw) * nu;
        v = (t / sh) * nv;
      } else if (mode === 'anchor') {
        u = s / mu;
        v = t / mv;
      } else {
        u = S[i] / mu;
        v = T[i] / mv;
      }
      let ls = s;
      let lt = t;
      if (rc && rc.t === 0) {
        const d = sub(pts[i], rc.o);
        ls = clamp(dot(d, rc.U), 0, rc.sw);
        lt = clamp(dot(d, rc.V), 0, rc.sh);
      }
      this.vert(b, pts[i], N, u, v, m, ch, ls, lt);
    }
    for (let k = 1; k < pts.length - 1; k++) b.idx.push(base, base + k, base + k + 1);
    return ch;
  }

  quad(o: P3, u: P3, v: P3, m: Mat, opt: PolyOpt = {}): number {
    return this.poly([o, add(o, u), add(add(o, u), v), add(o, v)], m, opt);
  }

  /** Axis-aligned box with chamfered edges (c), outward normals, auto-hidden faces flush with the room. */
  cbox(lo: P3, hi: P3, c: number, m: Mat, o: CBoxOpt = {}): void {
    const cc = Math.max(0, Math.min(c, (hi[0] - lo[0]) * 0.45, (hi[1] - lo[1]) * 0.45, (hi[2] - lo[2]) * 0.45));
    const pt = (i: number, s: number, sides: number[]): P3 => {
      const p: P3 = [0, 0, 0];
      for (let a = 0; a < 3; a++) p[a] = a === i ? (s > 0 ? hi[a] : lo[a]) : sides[a] > 0 ? hi[a] - cc : lo[a] + cc;
      return p;
    };
    const nm = (i: number, s: number): string => 'xyz'[i] + (s > 0 ? '+' : '-');
    const hid: Record<string, boolean> = {};
    const skip = o.skip ?? '';
    for (let i = 0; i < 3; i++)
      for (const s of [-1, 1]) {
        const n = nm(i, s);
        hid[n] = skip.includes(n) || (!o.noAuto && this.hidden(i, s, s > 0 ? hi[i] : lo[i]));
      }
    const ch: Record<string, number> = {};
    const order: Array<[number, number]> = [];
    for (let i = 0; i < 3; i++) for (const s of [-1, 1]) order.push([i, s]);
    if (o.only) order.sort((a, b) => (nm(b[0], b[1]) === o.only ? 1 : 0) - (nm(a[0], a[1]) === o.only ? 1 : 0));
    for (const [i, s] of order) {
      const n = nm(i, s);
      if (hid[n]) continue;
      const j = (i + 1) % 3;
      const k = (i + 2) % 3;
      const sd = (sj: number, sk: number): number[] => {
        const r = [0, 0, 0];
        r[j] = sj;
        r[k] = sk;
        return r;
      };
      const pts = [pt(i, s, sd(-1, -1)), pt(i, s, sd(1, -1)), pt(i, s, sd(1, 1)), pt(i, s, sd(-1, 1))];
      const nv: P3 = [0, 0, 0];
      nv[i] = s;
      const fo = o.face?.[n];
      const ref = o.only && n !== o.only && ch[o.only] !== undefined ? ch[o.only] : undefined;
      ch[n] = this.poly(pts, fo ? fo[0] : m, { uv: o.fit ? 'fit' : undefined, ld: o.ld, ...(fo ? fo[1] : {}), n: nv, ref });
    }
    if (cc <= 0) return;
    const refOf = (names: string[]): number | undefined => {
      if (o.only && ch[o.only] !== undefined) return ch[o.only];
      for (const n of names) if (!hid[n] && ch[n] !== undefined && ch[n] >= 0) return ch[n];
      return undefined;
    };
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++) {
        const k = 3 - i - j;
        for (const si of [-1, 1])
          for (const sj of [-1, 1]) {
            const ni = nm(i, si);
            const nj = nm(j, sj);
            if (hid[ni] && hid[nj]) continue;
            const s1 = [0, 0, 0];
            s1[j] = sj;
            const s2 = [0, 0, 0];
            s2[i] = si;
            const a1 = s1.slice();
            a1[k] = -1;
            const a2 = s1.slice();
            a2[k] = 1;
            const b1 = s2.slice();
            b1[k] = 1;
            const b2 = s2.slice();
            b2[k] = -1;
            const nv: P3 = [0, 0, 0];
            nv[i] = si;
            nv[j] = sj;
            this.poly([pt(i, si, a1), pt(i, si, a2), pt(j, sj, b1), pt(j, sj, b2)], m, { n: nv, ref: refOf([ni, nj]) });
          }
      }
    for (const sx of [-1, 1])
      for (const sy of [-1, 1])
        for (const sz of [-1, 1]) {
          const names = [nm(0, sx), nm(1, sy), nm(2, sz)];
          if (names.every((n) => hid[n])) continue;
          this.poly([pt(0, sx, [0, sy, sz]), pt(1, sy, [sx, 0, sz]), pt(2, sz, [sx, sy, 0])], m, { n: [sx, sy, sz], ref: refOf(names) });
        }
  }

  /** Cylinder a->b (smooth), lightmap strip unless inside a part. */
  cyl(a: P3, b: P3, r: number, segs: number, m: Mat, o: { caps?: boolean; inside?: boolean } = {}): void {
    const d = sub(b, a);
    const L = len(d);
    if (L < 1e-5) return;
    const dn = mul(d, 1 / L);
    const p1 = nrm(cross(dn, Math.abs(dn[1]) < 0.9 ? UP : [1, 0, 0]));
    const p2 = cross(dn, p1);
    let ch = -3;
    if (!this.partV) {
      ch = this.charts.length;
      this.charts.push({ t: 2, a, d: dn, len: L, p1, p2, r, x: 0, y: 0, w: 0, h: 7, dd: 0 });
    }
    const bk = this.bk(m);
    const base = bk.pos.length / 3;
    const [mu, mv] = TILE_METRES[m.tile];
    for (let k = 0; k <= segs; k++) {
      const th = (k / segs) * Math.PI * 2;
      const n = add(mul(p1, Math.cos(th)), mul(p2, Math.sin(th)));
      for (let e = 0; e < 2; e++) {
        const p = add(e ? b : a, mul(n, r));
        this.vert(bk, p, o.inside ? mul(n, -1) : n, (e ? L : 0) / mu, (th * r) / mv, m, ch, e ? L : 0, th);
      }
    }
    for (let k = 0; k < segs; k++) {
      const i0 = base + 2 * k;
      if (o.inside) bk.idx.push(i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2);
      else bk.idx.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3);
    }
    if (o.caps) {
      const ring = (c: P3): P3[] => {
        const r2: P3[] = [];
        for (let k = 0; k < segs; k++) {
          const th = (k / segs) * Math.PI * 2;
          r2.push(add(c, mul(add(mul(p1, Math.cos(th)), mul(p2, Math.sin(th))), r)));
        }
        return r2;
      };
      if (!this.partV) {
        this.part(() => {
          this.poly(ring(a), m, { n: mul(dn, -1) });
          this.poly(ring(b), m, { n: dn });
        });
      } else {
        this.poly(ring(a), m, { n: mul(dn, -1) });
        this.poly(ring(b), m, { n: dn });
      }
    }
  }

  /** Surface of revolution about +Y at c; profile (r, y) bottom to top on the outer surface. Always a part. */
  lathe(c: P3, prof: Array<[number, number]>, segs: number, m: Mat, detail = false): void {
    this.part(() => {
      const bk = this.bk(m);
      const base = bk.pos.length / 3;
      const [mu, mv] = TILE_METRES[m.tile];
      const rmax = Math.max(...prof.map((p) => p[0]), 0.01);
      for (let k = 0; k <= segs; k++) {
        const th = (k / segs) * Math.PI * 2;
        const sn = Math.sin(th);
        const cs = Math.cos(th);
        for (let j = 0; j < prof.length; j++) {
          const pa = prof[Math.max(0, j - 1)];
          const pb = prof[Math.min(prof.length - 1, j + 1)];
          let tr = pb[0] - pa[0];
          let ty = pb[1] - pa[1];
          const tl = Math.hypot(tr, ty) || 1;
          tr /= tl;
          ty /= tl;
          const n: P3 = [ty * sn, -tr, ty * cs];
          const [r, y] = prof[j];
          this.vert(bk, [c[0] + r * sn, c[1] + y, c[2] + r * cs], nrm(n), (th * rmax) / mu, y / mv, m, -3, 0, 0);
        }
      }
      const P = prof.length;
      for (let k = 0; k < segs; k++)
        for (let j = 0; j < P - 1; j++) {
          const i0 = base + k * P + j;
          const i1 = base + (k + 1) * P + j;
          bk.idx.push(i0, i1, i0 + 1, i0 + 1, i1, i1 + 1);
        }
    }, detail);
  }

  /** Quads between two equal-length profiles (planar when edges stay parallel); normals away from `away`. */
  loft(pa: P3[], pb: P3[], m: Mat, away: P3, o: PolyOpt = {}): void {
    for (let k = 0; k < pa.length - 1; k++) this.poly([pa[k], pa[k + 1], pb[k + 1], pb[k]], m, { ...o, away });
  }

  line(p: P3, a: P3, n: P3, c: P3, k: number, group = GLOW_MAIN): void {
    this.emitters.push({ type: 0, group, p, a, b: [0, 0, 0], n: nrm(n), c, k, cone: 0 });
  }
  rect(p: P3, a: P3, b: P3, n: P3, c: P3, k: number, group = GLOW_MAIN): void {
    this.emitters.push({ type: 1, group, p, a, b, n: nrm(n), c, k, cone: 0 });
  }
  spot(p: P3, n: P3, c: P3, k: number, coneDeg: number, group = GLOW_MAIN): void {
    this.emitters.push({ type: 2, group, p, a: [0, 0, 0], b: [0, 0, 0], n: nrm(n), c, k, cone: Math.cos((coneDeg * Math.PI) / 180) });
  }
}

const bx = (b: Builder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: Mat, c = 0, o: CBoxOpt = {}): void =>
  b.cbox([Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)], [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)], c, m, o);

// ---------------------------------------------------------------------------------------------------------
// palette

const COOL: P3 = [0.9, 0.95, 1.0];
const WARM: P3 = [1.0, 0.72, 0.45];
const NEUT: P3 = [1.0, 0.86, 0.7];
const CYAN: P3 = [0.3, 0.85, 1.0];
const EMERG: P3 = [1.0, 0.28, 0.07];
const REACT: P3 = [0.3, 0.72, 1.0];
const BLUE: P3 = [0.17, 0.34, 0.85];
const RED_LEATHER: P3 = [0.62, 0.07, 0.055];
const CHARCOAL: P3 = [0.26, 0.26, 0.28];
const DARK_RED: P3 = [0.55, 0.09, 0.09];
const CREAM: P3 = [1.0, 0.95, 0.86];
const ORANGE: P3 = [1.25, 0.55, 0.1];

const WHITE = mt('whitePanel');
const GUN = mt('gunmetal');
const BRUSH = mt('brushed');
// polished stainless trim: neutral (a blue-tinted F0 above 0.7 read as a mirror smudge on the wardrobe)
const CHROME = mt('brushed', [1.12, 1.12, 1.14]);
const TREAD = mt('tread');
const RUBBER = mt('tread', [0.6, 0.6, 0.6]);
const GRATE = mt('grating');
const WARMP = mt('warmPanel');
const VENEER = mt('veneer');
const DFLOOR = mt('darkFloor');
const STONE = mt('whitePanel', [1.12, 1.06, 0.98]);
const NET = mt('netting', ONE, 'cut');
const GLASS = mt('fabric', ONE, 'glass');
const HAZ = mt('hazard');
const SEAM = mt('seam');
const VENT = mt('vent');
const fab = (t: P3): Mat => mt('fabric', t);
const glow = (c: P3, level: number, group = GLOW_MAIN): Mat => mt('stencil', mul(c, level), 'glow', group);
const SCREEN = (level = 1.6): Mat => mt('stencil', [level, level, level], 'glow', GLOW_ALWAYS);
const BOOKS: P3[] = [[0.5, 0.1, 0.08], [0.12, 0.2, 0.4], [0.7, 0.62, 0.45], [0.15, 0.32, 0.2], [0.3, 0.3, 0.32], [0.75, 0.45, 0.12], [0.85, 0.85, 0.8]];

// ---------------------------------------------------------------------------------------------------------
// walls and openings

interface R {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}
interface Wall {
  ax: number;
  s: number;
  p: number;
  ua: number;
  va: number;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  holes: R[];
  face: string;
}
const wpt = (w: Wall, u: number, v: number, d: number): P3 => {
  const r: P3 = [0, 0, 0];
  r[w.ax] = w.p + w.s * d;
  r[w.ua] = u;
  r[w.va] = v;
  return r;
};
const wnorm = (w: Wall): P3 => {
  const r: P3 = [0, 0, 0];
  r[w.ax] = w.s;
  return r;
};
const front = (w: Wall): string => 'xyz'[w.ax] + (w.s > 0 ? '+' : '-');
function wslab(b: Builder, w: Wall, r: R, d0: number, d1: number, c: number, m: Mat, o: CBoxOpt = {}): void {
  const lo: P3 = [0, 0, 0];
  const hi: P3 = [0, 0, 0];
  const a = w.p + w.s * d0;
  const e = w.p + w.s * d1;
  lo[w.ax] = Math.min(a, e);
  hi[w.ax] = Math.max(a, e);
  lo[w.ua] = Math.min(r.u0, r.u1);
  hi[w.ua] = Math.max(r.u0, r.u1);
  lo[w.va] = Math.min(r.v0, r.v1);
  hi[w.va] = Math.max(r.v0, r.v1);
  b.cbox(lo, hi, c, m, { only: front(w), ...o });
}
function wquad(b: Builder, w: Wall, r: R, d: number, m: Mat, o: PolyOpt = {}): number {
  return b.poly([wpt(w, r.u0, r.v0, d), wpt(w, r.u1, r.v0, d), wpt(w, r.u1, r.v1, d), wpt(w, r.u0, r.v1, d)], m, { n: wnorm(w), ...o });
}
function subtract(r: R, holes: R[]): R[] {
  const hs = holes.filter((h) => h.u0 < r.u1 - 1e-6 && h.u1 > r.u0 + 1e-6 && h.v0 < r.v1 - 1e-6 && h.v1 > r.v0 + 1e-6);
  if (!hs.length) return [r];
  const cut = (lo: number, hi: number, xs: number[]): number[] =>
    [...new Set([lo, hi, ...xs.filter((x) => x > lo && x < hi)])].sort((a, b) => a - b);
  const us = cut(r.u0, r.u1, hs.flatMap((h) => [h.u0, h.u1]));
  const vs = cut(r.v0, r.v1, hs.flatMap((h) => [h.v0, h.v1]));
  const out: R[] = [];
  for (let j = 0; j < vs.length - 1; j++) {
    let run: R | null = null;
    for (let i = 0; i < us.length - 1; i++) {
      const cu = (us[i] + us[i + 1]) / 2;
      const cv = (vs[j] + vs[j + 1]) / 2;
      const blocked = hs.some((h) => cu > h.u0 && cu < h.u1 && cv > h.v0 && cv < h.v1);
      if (blocked) {
        if (run) out.push(run);
        run = null;
      } else if (run) run.u1 = us[i + 1];
      else run = { u0: us[i], v0: vs[j], u1: us[i + 1], v1: vs[j + 1] };
    }
    if (run) out.push(run);
  }
  return out;
}
const grow = (h: R, g: number): R => ({ u0: h.u0 - g, v0: h.v0 - g, u1: h.u1 + g, v1: h.v1 + g });

function roomWalls(L: InteriorLayout, room: InteriorRoom): Wall[] {
  const lo = [room.box.min.x, room.box.min.y, room.box.min.z];
  const hi = [room.box.max.x, room.box.max.y, room.box.max.z];
  const defs: Array<[string, number, number, number, number]> = [
    ['-x', 0, 1, 2, 1], ['+x', 0, -1, 2, 1], ['-z', 2, 1, 0, 1], ['+z', 2, -1, 0, 1], ['-y', 1, 1, 0, 2], ['+y', 1, -1, 0, 2],
  ];
  return defs.map(([face, ax, s, ua, va]) => {
    const w: Wall = { ax, s, p: s > 0 ? lo[ax] : hi[ax], ua, va, u0: lo[ua], u1: hi[ua], v0: lo[va], v1: hi[va], holes: [], face };
    for (const d of L.doors) {
      if (d.a !== room.id && d.b !== room.id) continue;
      const dl = [d.box.min.x, d.box.min.y, d.box.min.z];
      const dh = [d.box.max.x, d.box.max.y, d.box.max.z];
      if (ax === 1 || !(dl[ax] < w.p && dh[ax] > w.p)) continue;
      if (dh[ua] <= w.u0 || dl[ua] >= w.u1) continue;
      w.holes.push({ u0: dl[ua], u1: dh[ua], v0: dl[va], v1: dh[va] });
    }
    for (const win of L.windows) {
      if (win.room !== room.id || win.wall !== face) continue;
      const c = [win.center.x, win.center.y, win.center.z];
      w.holes.push({ u0: c[ua] - win.width / 2, u1: c[ua] + win.width / 2, v0: c[va] - win.height / 2, v1: c[va] + win.height / 2 });
    }
    return w;
  });
}

/** Rib positions along a wall's u (also used by the overhead so frames run continuously). */
function ribsAlong(u0: number, u1: number, step = 0.62): number[] {
  const n = Math.max(1, Math.round((u1 - u0) / step));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(clamp(u0 + ((u1 - u0) * i) / n, u0 + 0.05, u1 - 0.05));
  return out;
}

// --- white work-area walls ---------------------------------------------------------------------------------
function workWall(b: Builder, w: Wall, o: { net?: boolean; padEvery?: number; noCove?: boolean } = {}): void {
  const full: R = { u0: w.u0, v0: w.v0, u1: w.u1, v1: w.v1 };
  for (const r of subtract(full, w.holes)) wquad(b, w, r, 0, GUN, { ld: 0.35 });
  const ribs = ribsAlong(w.u0, w.u1);
  const hg = w.holes.map((h) => grow(h, 0.04));
  for (const u of ribs)
    for (const r of subtract({ u0: u - 0.045, v0: w.v0, u1: u + 0.045, v1: w.v1 }, w.holes))
      if (r.v1 - r.v0 > 0.08) wslab(b, w, r, 0, 0.075, 0.012, GUN, { face: { [front(w)]: [SEAM, { uv: 'strip', U: UP }] } });
  const v0 = w.v0;
  const bands: Array<[number, number, string]> = [
    [v0 + 0.02, v0 + 0.3, 'kick'],
    [v0 + 0.32, v0 + 1.52, 'main'],
    [v0 + 1.54, w.v1 - 0.17, 'upper'],
  ];
  const pad = o.padEvery ?? 3;
  for (let i = 0; i < ribs.length - 1; i++) {
    const bu0 = ribs[i] + 0.057;
    const bu1 = ribs[i + 1] - 0.057;
    if (bu1 - bu0 < 0.1) continue;
    for (const [a, c, band] of bands)
      for (const r of subtract({ u0: bu0, v0: a, u1: bu1, v1: c }, hg)) {
        if (r.u1 - r.u0 < 0.12 || r.v1 - r.v0 < 0.1) continue;
        if (band === 'kick') {
          wslab(b, w, r, 0, 0.028, 0.006, GUN, { face: { [front(w)]: [VENT, { uv: 'strip' }] } });
        } else if (band === 'main' && pad > 0 && i % pad === 1) {
          wslab(b, w, r, 0, 0.07, 0.03, mt('padded', BLUE), { fit: true });
        } else if (band === 'upper' && o.net) {
          wslab(b, w, r, 0, 0.03, 0.012, WHITE, { fit: true });
          wquad(b, w, { u0: r.u0 - 0.04, v0: r.v0 - 0.02, u1: r.u1 + 0.04, v1: r.v1 + 0.02 }, 0.068, NET, { ld: 0.4 });
        } else {
          wslab(b, w, r, 0, 0.03, 0.012, WHITE, { fit: true });
          if (r.u1 - r.u0 > 0.24 && r.v1 - r.v0 > 0.3)
            wslab(b, w, { u0: r.u0 + 0.06, v0: r.v0 + 0.07, u1: r.u1 - 0.06, v1: r.v1 - 0.07 }, 0.03, 0.044, 0.01, WHITE, { fit: true });
        }
      }
  }
  // emergency floor strip
  for (const r of subtract({ u0: w.u0 + 0.05, v0: v0 + 0.04, u1: w.u1 - 0.05, v1: v0 + 0.06 }, w.holes)) {
    wquad(b, w, r, 0.031, glow(EMERG, 3, GLOW_EMERG));
    b.line(wpt(w, r.u0, v0 + 0.05, 0.04), wpt(w, r.u1, v0 + 0.05, 0.04), add(wnorm(w), [0, 0.4, 0]), EMERG, 0.14, GLOW_EMERG);
  }
  if (o.noCove) return;
  // cove LED under a lip at the top
  const inset = w.ax === 0 ? 0.11 : 0;
  for (const r of subtract({ u0: w.u0 + inset, v0: w.v1 - 0.14, u1: w.u1 - inset, v1: w.v1 }, w.holes)) {
    wslab(b, w, r, 0, 0.11, 0.01, WHITE, {});
    const g: P3[] = [wpt(w, r.u0 + 0.02, w.v1 - 0.1405, 0.02), wpt(w, r.u1 - 0.02, w.v1 - 0.1405, 0.02), wpt(w, r.u1 - 0.02, w.v1 - 0.1405, 0.075), wpt(w, r.u0 + 0.02, w.v1 - 0.1405, 0.075)];
    b.poly(g, glow(COOL, 5), { n: [0, -1, 0] });
    b.line(wpt(w, r.u0 + 0.05, w.v1 - 0.15, 0.05), wpt(w, r.u1 - 0.05, w.v1 - 0.15, 0.05), add([0, -1, 0], mul(wnorm(w), 0.6)), COOL, 0.5);
  }
}

function workCeiling(b: Builder, w: Wall, ribV: number[], stripsAt: number[]): void {
  for (const r of subtract({ u0: w.u0, v0: w.v0, u1: w.u1, v1: w.v1 }, w.holes)) wquad(b, w, r, 0, WHITE, { ld: 0.5, uv: 'world' });
  for (const v of ribV)
    for (const r of subtract({ u0: w.u0, v0: v - 0.045, u1: w.u1, v1: v + 0.045 }, w.holes))
      wslab(b, w, r, 0, 0.065, 0.01, GUN, { face: { [front(w)]: [SEAM, { uv: 'strip' }] } });
  for (const x of stripsAt) {
    for (const r of subtract({ u0: x - 0.075, v0: w.v0 + 0.16, u1: x + 0.075, v1: w.v1 - 0.16 }, w.holes)) {
      wslab(b, w, r, 0, 0.075, 0.008, GUN);
      wquad(b, w, { u0: x - 0.028, v0: r.v0 + 0.02, u1: x + 0.028, v1: r.v1 - 0.02 }, 0.0755, glow(COOL, 5.5));
      b.line(wpt(w, x, r.v0 + 0.05, 0.08), wpt(w, x, r.v1 - 0.05, 0.08), [0, -1, 0], COOL, 0.8);
    }
  }
}

function workFloor(b: Builder, w: Wall, excl: R[], m = 0.26): void {
  wquad(b, w, { u0: w.u0, v0: w.v0, u1: w.u1, v1: w.v1 }, 0, GUN, { ld: 0.3 });
  const inner: R = { u0: w.u0 + m, v0: w.v0 + m, u1: w.u1 - m, v1: w.v1 - m };
  for (const r of [
    { u0: w.u0, v0: w.v0, u1: w.u1, v1: inner.v0 },
    { u0: w.u0, v0: inner.v1, u1: w.u1, v1: w.v1 },
    { u0: w.u0, v0: inner.v0, u1: inner.u0, v1: inner.v1 },
    { u0: inner.u1, v0: inner.v0, u1: w.u1, v1: inner.v1 },
  ])
    for (const q of subtract(r, excl)) wquad(b, w, q, 0.003, GRATE, { ld: 0.5 });
  const nu = Math.max(1, Math.round((inner.u1 - inner.u0) / 1.0));
  const nv = Math.max(1, Math.round((inner.v1 - inner.v0) / 0.62));
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const r: R = {
        u0: inner.u0 + ((inner.u1 - inner.u0) * i) / nu + 0.006,
        u1: inner.u0 + ((inner.u1 - inner.u0) * (i + 1)) / nu - 0.006,
        v0: inner.v0 + ((inner.v1 - inner.v0) * j) / nv + 0.006,
        v1: inner.v0 + ((inner.v1 - inner.v0) * (j + 1)) / nv - 0.006,
      };
      for (const q of subtract(r, excl)) if (q.u1 - q.u0 > 0.08 && q.v1 - q.v0 > 0.08) wslab(b, w, q, 0, 0.014, 0.003, TREAD, { fit: true });
    }
}

// --- warm living walls -------------------------------------------------------------------------------------
function livingWall(b: Builder, w: Wall): void {
  for (const r of subtract({ u0: w.u0, v0: w.v0, u1: w.u1, v1: w.v1 }, w.holes)) wquad(b, w, r, 0, WARMP, { ld: 0.45 });
  const v0 = w.v0;
  for (const r of subtract({ u0: w.u0, v0, u1: w.u1, v1: v0 + 0.1 }, w.holes)) wslab(b, w, r, 0, 0.018, 0.004, BRUSH);
  const n = Math.max(1, Math.round((w.u1 - w.u0) / 1.15));
  const hg = w.holes.map((h) => grow(h, 0.03));
  for (let i = 0; i < n; i++) {
    const a = w.u0 + ((w.u1 - w.u0) * i) / n + 0.006;
    const c = w.u0 + ((w.u1 - w.u0) * (i + 1)) / n - 0.006;
    for (const [lo, hi, m] of [[v0 + 0.12, v0 + 1.2, WARMP], [v0 + 1.34, w.v1 - 0.13, BRUSH]] as Array<[number, number, Mat]>)
      for (const r of subtract({ u0: a, v0: lo, u1: c, v1: hi }, hg))
        if (r.u1 - r.u0 > 0.1 && r.v1 - r.v0 > 0.08) wslab(b, w, r, 0, 0.028, 0.012, m, { fit: true });
  }
  // the sweeping light line in a brushed channel
  for (const r of subtract({ u0: w.u0, v0: v0 + 1.21, u1: w.u1, v1: v0 + 1.33 }, hg)) {
    if (r.u1 - r.u0 < 0.1) continue;
    wslab(b, w, r, 0, 0.008, 0.002, BRUSH);
    wquad(b, w, { u0: r.u0 + 0.01, v0: v0 + 1.262, u1: r.u1 - 0.01, v1: v0 + 1.278 }, 0.0085, glow(WARM, 5));
    b.line(wpt(w, r.u0 + 0.03, v0 + 1.27, 0.015), wpt(w, r.u1 - 0.03, v0 + 1.27, 0.015), wnorm(w), WARM, 0.18);
  }
}

function livingCeiling(b: Builder, walls: Wall[], ceil: Wall, spots: boolean): void {
  for (const r of subtract({ u0: ceil.u0, v0: ceil.v0, u1: ceil.u1, v1: ceil.v1 }, ceil.holes)) wquad(b, ceil, r, 0, WARMP, { ld: 0.5 });
  const C = ceil.p;
  for (const w of walls) {
    if (w.ax === 1) continue;
    const ins = w.ax === 0 ? 0.32 : 0;
    const r: R = { u0: w.u0 + ins, v0: C - 0.12, u1: w.u1 - ins, v1: C };
    wslab(b, w, r, 0, 0.32, 0.01, WARMP, { only: undefined });
    wquad(b, w, { u0: r.u0 + 0.01, v0: C - 0.032, u1: r.u1 - 0.01, v1: C - 0.014 }, 0.3205, glow(WARM, 4));
    b.line(wpt(w, r.u0 + 0.05, C - 0.02, 0.34), wpt(w, r.u1 - 0.05, C - 0.02, 0.34), add(mul(wnorm(w), 0.7), [0, 0.8, 0]), WARM, 0.22);
    if (!spots) continue;
    const n = Math.max(1, Math.round((w.u1 - w.u0 - 2 * ins) / 1.15));
    for (let i = 0; i < n; i++) {
      const u = w.u0 + ins + ((w.u1 - w.u0 - 2 * ins) * (i + 0.5)) / n;
      const p = wpt(w, u, C - 0.12, 0.16);
      downlight(b, p, nrm(add([0, -1, 0], mul(wnorm(w), -0.22))), 1.2);
    }
  }
}

function downlight(b: Builder, p: P3, dir: P3, k: number, c: P3 = WARM): void {
  b.part(() => {
    b.lathe(add(p, [0, -0.006, 0]), [[0.05, 0], [0.045, 0.006]], 12, BRUSH);
    b.cyl(add(p, [0, -0.007, 0]), add(p, [0, -0.001, 0]), 0.03, 10, glow(c, 7), { caps: true });
  }, true);
  b.spot(add(p, [0, -0.02, 0]), dir, c, k, 58);
}

// --- deep window frames, door frames -----------------------------------------------------------------------
function windowFrame(b: Builder, w: Wall, h: R, style: 'work' | 'living' | 'cockpit', depth = 0.2): void {
  const rev = style === 'living' ? BRUSH : WHITE;
  const fr = style === 'living' ? BRUSH : style === 'cockpit' ? WHITE : GUN;
  const cen = wpt(w, (h.u0 + h.u1) / 2, (h.v0 + h.v1) / 2, -depth / 2);
  const q = (a: [number, number], c: [number, number]): void => {
    b.poly([wpt(w, a[0], a[1], 0), wpt(w, c[0], c[1], 0), wpt(w, c[0], c[1], -depth), wpt(w, a[0], a[1], -depth)], rev, { toward: cen, ld: 0.6 });
  };
  q([h.u0, h.v0], [h.u1, h.v0]);
  q([h.u1, h.v0], [h.u1, h.v1]);
  q([h.u1, h.v1], [h.u0, h.v1]);
  q([h.u0, h.v1], [h.u0, h.v0]);
  const sd = -depth + 0.035;
  const sw = 0.03;
  for (const r of [
    { u0: h.u0, v0: h.v0, u1: h.u1, v1: h.v0 + sw },
    { u0: h.u0, v0: h.v1 - sw, u1: h.u1, v1: h.v1 },
    { u0: h.u0, v0: h.v0 + sw, u1: h.u0 + sw, v1: h.v1 - sw },
    { u0: h.u1 - sw, v0: h.v0 + sw, u1: h.u1, v1: h.v1 - sw },
  ])
    wslab(b, w, r, -depth, sd, 0.008, RUBBER, { noAuto: true });
  wquad(b, w, h, -depth + 0.02, GLASS);
  const bw = style === 'cockpit' ? 0.12 : 0.085;
  const bd = style === 'cockpit' ? 0.07 : 0.05;
  const seamFace = (U: P3): CBoxOpt => ({ face: { [front(w)]: [style === 'living' ? BRUSH : SEAM, { uv: 'strip', U }] } });
  const ud = wpt(w, 1, 0, 0);
  const uDir = nrm(sub(ud, wpt(w, 0, 0, 0)));
  const vDir = nrm(sub(wpt(w, 0, 1, 0), wpt(w, 0, 0, 0)));
  wslab(b, w, { u0: h.u0 - bw, v0: h.v0 - bw, u1: h.u1 + bw, v1: h.v0 }, 0, bd, 0.015, fr, seamFace(uDir));
  wslab(b, w, { u0: h.u0 - bw, v0: h.v1, u1: h.u1 + bw, v1: h.v1 + bw }, 0, bd, 0.015, fr, seamFace(uDir));
  wslab(b, w, { u0: h.u0 - bw, v0: h.v0, u1: h.u0, v1: h.v1 }, 0, bd, 0.015, fr, seamFace(vDir));
  wslab(b, w, { u0: h.u1, v0: h.v0, u1: h.u1 + bw, v1: h.v1 }, 0, bd, 0.015, fr, seamFace(vDir));
}

const DOOR_LABEL: Record<string, StencilId> = {
  'd-cargo': 'CARGO BAY 01', 'd-engineering': 'ENGINEERING', 'd-suitroom': 'EVA SUITS', 'd-cockpit': 'WREN  CV-2207',
};
function doorFrame(b: Builder, d: InteriorDoor, work: boolean): void {
  const lo = [d.box.min.x, d.box.min.y, d.box.min.z];
  const hi = [d.box.max.x, d.box.max.y, d.box.max.z];
  const ta = hi[0] - lo[0] < hi[2] - lo[2] ? 0 : 2;
  const ua = 2 - ta;
  const P = (lo[ta] + hi[ta]) / 2;
  const w0 = lo[ua];
  const w1 = hi[ua];
  const top = hi[1];
  const F = lo[1];
  const fr = work ? GUN : BRUSH;
  const B = (u0: number, y0: number, t0: number, u1: number, y1: number, t1: number, m: Mat, c: number, o: CBoxOpt = {}): void => {
    const a: P3 = [0, y0, 0];
    const e: P3 = [0, y1, 0];
    a[ua] = u0;
    e[ua] = u1;
    a[ta] = P + t0;
    e[ta] = P + t1;
    b.cbox([Math.min(a[0], e[0]), Math.min(a[1], e[1]), Math.min(a[2], e[2])], [Math.max(a[0], e[0]), Math.max(a[1], e[1]), Math.max(a[2], e[2])], c, m, { noAuto: true, ...o });
  };
  const pt = (u: number, y: number, t: number): P3 => {
    const r: P3 = [0, y, 0];
    r[ua] = u;
    r[ta] = P + t;
    return r;
  };
  const D = 0.18;
  const uAxis: P3 = [0, 0, 0];
  uAxis[ua] = 1;
  B(w0 - 0.11, F, -D, w0, top + 0.14, D, fr, 0.018, { skip: 'y-' });
  B(w1, F, -D, w1 + 0.11, top + 0.14, D, fr, 0.018, { skip: 'y-' });
  B(w0, top, -D, w1, top + 0.14, D, fr, 0.018);
  // rubber seals and the retracted pressure leaf with its hazard edge
  B(w0, F + 0.012, -0.05, w0 + 0.014, top, 0.05, RUBBER, 0.004);
  B(w0 + 0.014, top - 0.014, -0.05, w1, top, 0.05, RUBBER, 0.004);
  const hzFace = (ua === 0 ? 'x-' : 'z-');
  B(w1 - 0.035, F + 0.012, -0.035, w1, top - 0.014, 0.035, GUN, 0.006, { face: { [hzFace]: [HAZ, { uv: 'strip', U: UP }] } });
  // threshold
  const thr = work ? HAZ : BRUSH;
  b.poly([pt(w0, F + 0.012, -D), pt(w1, F + 0.012, -D), pt(w1, F + 0.012, D), pt(w0, F + 0.012, D)], thr, { n: UP, uv: work ? 'strip' : 'world', U: uAxis });
  B(w0, F, -D, w1, F + 0.0115, D, GUN, 0.004, { skip: 'y-y+' });
  // control panels and grab bars on both sides, a label above
  for (const sd of [-1, 1]) {
    const t0 = sd * D;
    const t1 = sd * (D + 0.035);
    b.part(() => {
      B(w1 + 0.13, 0.02, t0, w1 + 0.27, 0.3, t1, GUN, 0.008);
      const fz = sd * (D + 0.0355);
      b.poly([pt(w1 + 0.145, 0.05, fz), pt(w1 + 0.255, 0.05, fz), pt(w1 + 0.255, 0.27, fz), pt(w1 + 0.145, 0.27, fz)], SCREEN(1.4), {
        rect: STENCIL.ui2, n: (() => { const n: P3 = [0, 0, 0]; n[ta] = sd; return n; })(),
      });
    }, true);
    b.part(() => {
      const gu = w0 - 0.2;
      b.cyl(pt(gu, -0.1, sd * (D + 0.07)), pt(gu, 0.85, sd * (D + 0.07)), 0.016, 8, CHROME);
      b.cyl(pt(gu, -0.05, sd * D), pt(gu, -0.05, sd * (D + 0.085)), 0.012, 6, GUN);
      b.cyl(pt(gu, 0.8, sd * D), pt(gu, 0.8, sd * (D + 0.085)), 0.012, 6, GUN);
    }, true);
    const lab = DOOR_LABEL[d.id] ?? 'PRESSURE DOOR';
    const cu = (w0 + w1) / 2;
    const lf = sd * (D + 0.002);
    const n: P3 = [0, 0, 0];
    n[ta] = sd;
    b.poly([pt(cu - 0.3, top + 0.025, lf), pt(cu + 0.3, top + 0.025, lf), pt(cu + 0.3, top + 0.11, lf), pt(cu - 0.3, top + 0.11, lf)], WHITE, { rect: STENCIL[lab], n, U: sd > 0 ? (ta === 2 ? [1, 0, 0] : [0, 0, -1]) : ta === 2 ? [-1, 0, 0] : [0, 0, 1] });
  }
}

// --- the octagonal corridor (and the companionway) ----------------------------------------------------------
function clipHalf(poly: Array<[number, number]>, nx: number, ny: number, c: number): Array<[number, number]> {
  // keep nx*x + ny*y >= c
  const out: Array<[number, number]> = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const e = poly[(i + 1) % poly.length];
    const da = nx * a[0] + ny * a[1] - c;
    const de = nx * e[0] + ny * e[1] - c;
    if (da >= 0) out.push(a);
    if (da >= 0 !== de >= 0) {
      const t = da / (da - de);
      out.push([a[0] + (e[0] - a[0]) * t, a[1] + (e[1] - a[1]) * t]);
    }
  }
  return out;
}
function offsetPoly(p: Array<[number, number]>, t: number): Array<[number, number]> {
  // inward offset of a CCW convex polygon
  const n = p.length;
  const lines = p.map((a, i) => {
    const e = p[(i + 1) % n];
    const dx = e[0] - a[0];
    const dy = e[1] - a[1];
    const l = Math.hypot(dx, dy);
    const nx = -dy / l;
    const ny = dx / l;
    return { nx, ny, c: nx * a[0] + ny * a[1] + t };
  });
  return p.map((_, i) => {
    const A = lines[(i - 1 + n) % n];
    const Bl = lines[i];
    const det = A.nx * Bl.ny - A.ny * Bl.nx;
    return [(A.c * Bl.ny - A.ny * Bl.c) / det, (A.nx * Bl.c - A.c * Bl.nx) / det] as [number, number];
  });
}

function octRoom(b: Builder, L: InteriorLayout, room: InteriorRoom, rings: number[], warmEnd: number): void {
  const bb = room.box;
  const F = bb.min.y;
  const C = bb.max.y;
  const hw = bb.max.x;
  const z0 = bb.min.z;
  const z1 = bb.max.z;
  const ct = 0.28;
  const cb = 0.15;
  const oct: Array<[number, number]> = [
    [-hw + cb, F], [hw - cb, F], [hw, F + cb], [hw, C - ct], [hw - ct, C], [-hw + ct, C], [-hw, C - ct], [-hw, F + cb],
  ];
  const ax: P3 = [0, (F + C) / 2, 0];
  const P = (q: [number, number], z: number): P3 => [q[0], q[1], z];
  const walls = roomWalls(L, room);
  const side = (sx: number): Wall => walls[sx < 0 ? 0 : 1];
  // floor
  const fw = walls[4];
  const floorR: R = { u0: -hw + cb, v0: z0, u1: hw - cb, v1: z1 };
  wquad(b, fw, floorR, 0, DFLOOR, { ld: 0.7 });
  wslab(b, fw, { u0: -0.38, v0: z0 + 0.2, u1: 0.38, v1: z1 - 0.2 }, 0, 0.012, 0.004, TREAD, { fit: true });
  // chamfers: lower are grating vents with emergency strips, upper are gunmetal with a vent line
  for (const sx of [-1, 1]) {
    const lo0 = oct[sx < 0 ? 7 : 1];
    const lo1 = oct[sx < 0 ? 0 : 2];
    b.poly([P(lo0, z0), P(lo1, z0), P(lo1, z1), P(lo0, z1)], GRATE, { toward: [0, 0, (z0 + z1) / 2], ld: 0.5 });
    const g0: [number, number] = [sx * (hw - 0.1), F + 0.05];
    b.poly([[g0[0], g0[1], z0 + 0.05], [g0[0] + sx * 0.012, g0[1] + 0.012, z0 + 0.05], [g0[0] + sx * 0.012, g0[1] + 0.012, z1 - 0.05], [g0[0], g0[1], z1 - 0.05]], glow(EMERG, 3, GLOW_EMERG), { toward: [0, 0.5, (z0 + z1) / 2] });
    b.line([g0[0], g0[1] + 0.01, z0 + 0.1], [g0[0], g0[1] + 0.01, z1 - 0.1], [-sx, 1, 0], EMERG, 0.12, GLOW_EMERG);
    const up0 = oct[sx < 0 ? 5 : 3];
    const up1 = oct[sx < 0 ? 6 : 4];
    b.poly([P(up0, z0), P(up1, z0), P(up1, z1), P(up0, z1)], GUN, { toward: [0, 0, (z0 + z1) / 2], ld: 0.5 });
  }
  // side walls: brushed warm panels between the rings, white aft of warmEnd
  for (const sx of [-1, 1]) {
    const w = side(sx);
    const vlo = F + cb;
    const vhi = C - ct;
    for (const r of subtract({ u0: z0, v0: vlo, u1: z1, v1: vhi }, w.holes)) wquad(b, w, r, 0, GUN, { ld: 0.35 });
    const stops = [z0, ...rings.flatMap((z) => [z - 0.07, z + 0.07]), z1];
    const hg = w.holes.map((h) => grow(h, 0.025));
    for (let i = 0; i < stops.length - 1; i += 2) {
      const a = stops[i] + 0.012;
      const c = stops[i + 1] - 0.012;
      if (c - a < 0.1) continue;
      const white = a >= warmEnd - 0.01;
      for (const [lo, hi] of [[vlo + 0.03, -0.06], [0.22, vhi - 0.02]] as Array<[number, number]>)
        for (const r of subtract({ u0: a, v0: lo, u1: c, v1: hi }, hg))
          if (r.u1 - r.u0 > 0.1 && r.v1 - r.v0 > 0.1) wslab(b, w, r, 0, 0.026, 0.01, white ? WHITE : BRUSH, { fit: true });
      for (const r of subtract({ u0: a, v0: -0.04, u1: c, v1: 0.2 }, hg)) if (r.u1 - r.u0 > 0.1) wslab(b, w, r, 0, 0.012, 0.004, white ? GUN : WARMP, {});
    }
    // handrail in front of the rings, broken at the doors
    const gaps = w.holes.map((h) => [h.u0 - 0.12, h.u1 + 0.12]);
    let za = z0 + 0.25;
    const segs: Array<[number, number]> = [];
    for (const [g0, g1] of [...gaps, [z1 - 0.25, z1 + 1]].sort((p, q) => p[0] - q[0])) {
      if (g0 - za > 0.3) segs.push([za, g0]);
      za = Math.max(za, g1);
    }
    for (const [ra, rc] of segs) rail(b, [sx * (hw - 0.115), 0.08, ra], [sx * (hw - 0.115), 0.08, rc], [sx, 0, 0], 0.115);
  }
  // ceiling
  const cw = walls[5];
  for (const r of subtract({ u0: -hw + ct, v0: z0, u1: hw - ct, v1: z1 }, cw.holes)) wquad(b, cw, r, 0, WARMP, { ld: 0.5 });
  // rings: gunmetal octagon frames with light rings in their upper members
  const inner = offsetPoly(oct, 0.085);
  for (const z of rings) {
    const za = z - 0.07;
    const zc = z + 0.07;
    for (let i = 1; i < 8; i++) {
      if (i === 0) continue;
      const a = oct[i];
      const e = oct[(i + 1) % 8];
      const ia = inner[i];
      const ie = inner[(i + 1) % 8];
      if (i === 0) continue;
      // inner face, two end faces
      b.poly([P(ia, za), P(ie, za), P(ie, zc), P(ia, zc)], GUN, { toward: [0, ax[1], z] });
      b.poly([P(a, za), P(e, za), P(ie, za), P(ia, za)], GUN, { n: [0, 0, -1] });
      b.poly([P(a, zc), P(e, zc), P(ie, zc), P(ia, zc)], GUN, { n: [0, 0, 1] });
      if (i >= 3 && i <= 5) {
        const m0 = add(P(ia, z - 0.018), mul(nrm(sub(ax, P(ia, z))), 0.002));
        const m1 = add(P(ie, z - 0.018), mul(nrm(sub(ax, P(ie, z))), 0.002));
        const s = sub(P(ie, z), P(ia, z));
        const g0 = add(m0, mul(s, 0.08));
        const g1 = add(m0, mul(s, 0.92));
        void m1;
        b.poly([g0, g1, add(g1, [0, 0, 0.036]), add(g0, [0, 0, 0.036])], glow(NEUT, 6), { toward: [0, ax[1], z] });
        const nIn = nrm(cross(s, [0, 0, 1]));
        b.line(add(g0, [0, 0, 0.018]), add(g1, [0, 0, 0.018]), dot(nIn, sub(ax, g0)) > 0 ? nIn : mul(nIn, -1), NEUT, 0.38);
      }
    }
    // the floor member is a threshold plate
    wslab(b, fw, { u0: -hw + cb, v0: za, u1: hw - cb, v1: zc }, 0, 0.016, 0.005, GUN);
  }
  // end walls (octagon minus the door)
  for (const wz of [z0, z1]) {
    const w = wz === z0 ? walls[2] : walls[3];
    const h = w.holes[0];
    const white = wz >= warmEnd;
    const m = white ? WHITE : WARMP;
    const pieces: Array<Array<[number, number]>> = h
      ? [clipHalf(oct, -1, 0, -h.u0), clipHalf(oct, 1, 0, h.u1), clipHalf(clipHalf(clipHalf(oct, 1, 0, h.u0), -1, 0, -h.u1), 0, 1, h.v1)]
      : [oct];
    for (const pc of pieces) if (pc.length >= 3) b.poly(pc.map((q) => [q[0], q[1], wz] as P3), m, { n: wnorm(w), ld: 0.6 });
  }
}

function rail(b: Builder, a: P3, c: P3, wallN: P3, off: number): void {
  b.cyl(a, c, 0.018, 8, CHROME);
  const n = Math.max(2, Math.round(len(sub(c, a)) / 0.7) + 1);
  b.part(() => {
    for (let i = 0; i < n; i++) {
      const p = add(a, mul(sub(c, a), (i + 0.5) / n));
      b.cyl(p, add(p, mul(wallN, off - 0.01)), 0.011, 6, GUN);
      b.cyl(add(p, mul(wallN, off - 0.012)), add(p, mul(wallN, off)), 0.03, 8, GUN, { caps: true });
    }
  }, true);
}

// ---------------------------------------------------------------------------------------------------------
// furniture and equipment

function books(b: Builder, x0: number, x1: number, y: number, z0: number, z1: number, axis: 0 | 2, seed: number): void {
  b.part(() => {
    let p = axis === 0 ? x0 : z0;
    const end = axis === 0 ? x1 : z1;
    let i = 0;
    while (p < end - 0.03) {
      const wdt = 0.022 + hr(i, seed) * 0.035;
      if (p + wdt > end) break;
      const h = 0.16 + hr(i, seed + 1) * 0.12;
      const dp = 0.14 + hr(i, seed + 2) * 0.06;
      const col = BOOKS[Math.floor(hr(i, seed + 3) * BOOKS.length)];
      if (hr(i, seed + 4) < 0.12) {
        p += 0.06;
        i++;
        continue;
      }
      if (axis === 0) bx(b, p, y, z1 - dp, p + wdt, y + h, z1, fab(col), 0.003);
      else bx(b, x1 - dp, y, p, x1, y + h, p + wdt, fab(col), 0.003);
      p += wdt + 0.002;
      i++;
    }
  }, true);
}

function plant(b: Builder, x: number, y: number, z: number, s = 1, seed = 1): void {
  b.lathe([x, y, z], [[0.07 * s, 0], [0.09 * s, 0.14 * s], [0.085 * s, 0.15 * s], [0.0, 0.13 * s]], 12, WHITE, true);
  b.part(() => {
    const leaf = mt('fabric', [0.16, 0.36, 0.1]);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + hr(i, seed) * 0.5;
      const l = (0.18 + hr(i, seed + 1) * 0.12) * s;
      const tilt = 0.5 + hr(i, seed + 2) * 0.6;
      const base: P3 = [x, y + 0.13 * s, z];
      const dir: P3 = [Math.sin(a) * Math.cos(tilt), Math.sin(tilt), Math.cos(a) * Math.cos(tilt)];
      const side = nrm(cross(dir, UP));
      const tip = add(base, mul(dir, l));
      const mid = add(base, mul(dir, l * 0.5));
      const pts: P3[] = [base, add(mid, mul(side, 0.035 * s)), tip, add(mid, mul(side, -0.035 * s))];
      b.poly(pts, leaf, {});
      b.poly(pts.slice().reverse(), leaf, {});
    }
  }, true);
}

function shelfUnit(b: Builder, x0: number, x1: number, zWall: number, dz: number, top: number, F: number, seed: number): void {
  const za = Math.min(zWall, zWall + dz);
  const zb = Math.max(zWall, zWall + dz);
  bx(b, x0, F, za, x0 + 0.03, top, zb, BRUSH, 0.004);
  bx(b, x1 - 0.03, F, za, x1, top, zb, BRUSH, 0.004);
  const levels = [F + 0.06, F + 0.5, F + 0.95, F + 1.4, top];
  levels.forEach((y, i) => {
    bx(b, x0 + 0.03, y - 0.025, za, x1 - 0.03, y, zb, VENEER, 0.004);
    if (i > 0 && i < levels.length - 1) {
      const zf = dz < 0 ? za + 0.02 : zb - 0.02;
      b.cyl([x0 + 0.03, y + 0.07, zf], [x1 - 0.03, y + 0.07, zf], 0.005, 6, CHROME);
    }
  });
  const fz = dz < 0 ? za : zb;
  const bz0 = dz < 0 ? fz : fz - 0.22;
  void bz0;
  for (let i = 1; i < levels.length - 1; i++) {
    const y = levels[i];
    if (i === 2) {
      books(b, x0 + 0.05, x0 + (x1 - x0) * 0.55, y, Math.min(zWall, zWall + dz * 0.95), Math.max(zWall, zWall + dz * 0.95), 0, seed + i);
      plant(b, x1 - 0.18, y, (za + zb) / 2, 0.8, seed + i);
    } else books(b, x0 + 0.05, x1 - 0.05, y, za + 0.01, zb - 0.01, 0, seed + i * 7);
  }
}

function crate(b: Builder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, tint: P3, label: StencilId, faceX: number): void {
  const m = mt('whitePanel', tint);
  bx(b, x0, y0, z0, x1, y1, z1, m, 0.02, { fit: true });
  b.part(() => {
    for (const x of [x0, x1])
      for (const z of [z0, z1]) bx(b, x - 0.035, y0, z - 0.035, x + 0.035, y1 + 0.005, z + 0.035, GUN, 0.006);
    const fx = faceX > 0 ? x1 + 0.003 : x0 - 0.003;
    const cz = (z0 + z1) / 2;
    for (const y of [y0 + 0.08, y1 - 0.08]) bx(b, faceX > 0 ? x1 : x0 - 0.012, y - 0.025, z0 + 0.02, faceX > 0 ? x1 + 0.012 : x0, y + 0.025, z1 - 0.02, GUN, 0.004, { noAuto: true });
    for (const z of [z0 + 0.3, z1 - 0.3]) bx(b, faceX > 0 ? x1 : x0 - 0.008, y0 + 0.1, z - 0.02, faceX > 0 ? x1 + 0.008 : x0, y1 - 0.1, z + 0.02, mt('whitePanel', mul(tint, 0.8)), 0.004, { noAuto: true });
    b.poly([[fx, y1 - 0.2, cz - 0.3], [fx, y1 - 0.2, cz + 0.3], [fx, y1 - 0.11, cz + 0.3], [fx, y1 - 0.11, cz - 0.3]], WHITE, { rect: STENCIL[label], n: [faceX, 0, 0] });
    b.cyl([fx + faceX * 0.03, (y0 + y1) / 2, cz - 0.12], [fx + faceX * 0.03, (y0 + y1) / 2, cz + 0.12], 0.012, 6, GUN);
  }, true);
}

function solids(b: Builder, L: InteriorLayout, idx: Map<string, number>): void {
  const S = (id: string): InteriorSolid | undefined => L.solids.find((s) => s.id === id);
  const at = (room: string): boolean => {
    const i = idx.get(room);
    if (i === undefined) return false;
    b.room = i;
    return true;
  };
  const F = L.rooms[0].box.min.y;
  const C = L.rooms[0].box.max.y;

  // ---- lounge ----
  if (at('lounge')) {
    const fr = S('fridge');
    if (fr) {
      const { min: a, max: e } = fr.box;
      bx(b, a.x, a.y, a.z, e.x - 0.02, e.y, e.z, BRUSH, 0.01);
      bx(b, e.x - 0.02, F + 0.1, a.z + 0.02, e.x, 0.5, e.z - 0.02, CHROME, 0.006);
      bx(b, e.x - 0.02, 0.53, a.z + 0.02, e.x, e.y - 0.04, e.z - 0.02, CHROME, 0.006);
      b.part(() => {
        b.cyl([e.x + 0.035, -0.4, e.z - 0.07], [e.x + 0.035, 0.42, e.z - 0.07], 0.011, 8, GUN);
        b.cyl([e.x + 0.035, 0.62, e.z - 0.07], [e.x + 0.035, 1.1, e.z - 0.07], 0.011, 8, GUN);
        b.poly([[e.x + 0.001, 0.2, a.z + 0.08], [e.x + 0.001, 0.2, a.z + 0.28], [e.x + 0.001, 0.36, a.z + 0.28], [e.x + 0.001, 0.36, a.z + 0.08]], SCREEN(1.2), { rect: STENCIL.ui3, n: [1, 0, 0] });
      }, true);
    }
    const g = S('galley');
    if (g) {
      const { min: a, max: e } = g.box;
      bx(b, a.x, a.y, a.z, e.x - 0.07, a.y + 0.1, e.z, GUN);
      bx(b, a.x, a.y + 0.1, a.z, e.x - 0.03, e.y - 0.04, e.z, WARMP);
      const n = 5;
      for (let i = 0; i < n; i++) {
        const za = a.z + ((e.z - a.z) * i) / n + 0.005;
        const zb = a.z + ((e.z - a.z) * (i + 1)) / n - 0.005;
        bx(b, e.x - 0.03, a.y + 0.13, za, e.x - 0.012, e.y - 0.08, zb, VENEER, 0.004, { fit: true });
        b.part(() => bx(b, e.x - 0.012, e.y - 0.15, za + 0.12, e.x - 0.002, e.y - 0.13, zb - 0.12, CHROME, 0.003), true);
      }
      bx(b, a.x, e.y - 0.04, a.z, e.x + 0.02, e.y, e.z, STONE, 0.006);
      bx(b, a.x, e.y, a.z, a.x + 0.015, 0.6, e.z, BRUSH, 0, { fit: true });
      // sink and faucet, hob
      const sz = a.z + 0.95;
      b.part(() => {
        const y = e.y + 0.001;
        bx(b, a.x + 0.16, y, sz, e.x - 0.08, y + 0.012, sz + 0.03, CHROME, 0.004);
        bx(b, a.x + 0.16, y, sz + 0.47, e.x - 0.08, y + 0.012, sz + 0.5, CHROME, 0.004);
        bx(b, a.x + 0.16, y, sz + 0.03, a.x + 0.19, y + 0.012, sz + 0.47, CHROME, 0.004);
        bx(b, e.x - 0.11, y, sz + 0.03, e.x - 0.08, y + 0.012, sz + 0.47, CHROME, 0.004);
        b.poly([[a.x + 0.19, y + 0.0005, sz + 0.03], [e.x - 0.11, y + 0.0005, sz + 0.03], [e.x - 0.11, y + 0.0005, sz + 0.47], [a.x + 0.19, y + 0.0005, sz + 0.47]], mt('gunmetal', [0.5, 0.5, 0.5]), { n: UP });
        b.cyl([a.x + 0.07, y, sz + 0.25], [a.x + 0.07, y + 0.3, sz + 0.25], 0.016, 10, CHROME);
        b.cyl([a.x + 0.07, y + 0.3, sz + 0.25], [a.x + 0.26, y + 0.3, sz + 0.25], 0.014, 10, CHROME);
        b.cyl([a.x + 0.26, y + 0.3, sz + 0.25], [a.x + 0.26, y + 0.24, sz + 0.25], 0.012, 10, CHROME);
        const hz = a.z + 2.4;
        bx(b, a.x + 0.12, y, hz, e.x - 0.06, y + 0.008, hz + 0.6, mt('gunmetal', [0.25, 0.25, 0.27]), 0.004);
        for (const [dx, dz] of [[0.17, 0.15], [0.17, 0.45], [0.38, 0.3]] as Array<[number, number]>)
          b.lathe([a.x + 0.12 + dx, y + 0.008, hz + dz], [[0.09, 0], [0.085, 0.0015], [0.0, 0.0015]], 16, mt('gunmetal', [0.6, 0.6, 0.65]));
        b.lathe([a.x + 0.3, y, a.z + 3.6], [[0.07, 0], [0.08, 0.1], [0.06, 0.2], [0.03, 0.22], [0, 0.22]], 14, CHROME);
        for (const [mz, c] of [[3.85, CREAM], [3.95, DARK_RED]] as Array<[number, P3]>)
          b.lathe([a.x + 0.45, y, a.z + mz], [[0.035, 0], [0.04, 0.09], [0.036, 0.09], [0.031, 0.008], [0, 0.008]], 12, mt('whitePanel', c));
        bx(b, a.x + 0.015, 0.2, a.z + 1.8, a.x + 0.03, 0.24, a.z + 2.3, GUN);
        for (let k = 0; k < 4; k++) bx(b, a.x + 0.03, 0.04, a.z + 1.88 + k * 0.1, a.x + 0.036, 0.3, a.z + 1.91 + k * 0.1, CHROME, 0.002);
      }, true);
      b.cyl([e.x + 0.03, e.y + 0.035, a.z + 0.05], [e.x + 0.03, e.y + 0.035, e.z - 0.05], 0.008, 6, CHROME);
    }
    const gu = S('galley-upper');
    if (gu) {
      const { min: a, max: e } = gu.box;
      bx(b, a.x, a.y, a.z, e.x - 0.03, e.y, e.z, WARMP);
      const n = 5;
      for (let i = 0; i < n; i++) {
        const za = a.z + ((e.z - a.z) * i) / n + 0.005;
        const zb = a.z + ((e.z - a.z) * (i + 1)) / n - 0.005;
        bx(b, e.x - 0.03, a.y + 0.03, za, e.x - 0.012, e.y - 0.03, zb, WARMP, 0.004, { fit: true });
        b.part(() => bx(b, e.x - 0.012, a.y + 0.06, za + 0.1, e.x - 0.002, a.y + 0.075, zb - 0.1, CHROME, 0.003), true);
      }
      b.poly([[e.x - 0.08, a.y - 0.0015, a.z + 0.05], [e.x - 0.04, a.y - 0.0015, a.z + 0.05], [e.x - 0.04, a.y - 0.0015, e.z - 0.05], [e.x - 0.08, a.y - 0.0015, e.z - 0.05]], glow(WARM, 5), { n: [0, -1, 0] });
      b.line([e.x - 0.06, a.y - 0.01, a.z + 0.1], [e.x - 0.06, a.y - 0.01, e.z - 0.1], [0.25, -1, 0], WARM, 0.75);
    }
    sofa(b, S('sofa'), F);
    const t = S('table');
    if (t) {
      const { min: a, max: e } = t.box;
      bx(b, a.x, e.y - 0.035, a.z, e.x, e.y, e.z, VENEER, 0.012);
      bx(b, a.x + 0.01, e.y - 0.055, a.z + 0.01, e.x - 0.01, e.y - 0.035, e.z - 0.01, BRUSH, 0.004);
      const cx = (a.x + e.x) / 2;
      const cz = (a.z + e.z) / 2;
      bx(b, cx - 0.14, F + 0.03, cz - 0.35, cx + 0.14, e.y - 0.055, cz + 0.35, BRUSH, 0.03);
      bx(b, cx - 0.32, F, cz - 0.6, cx + 0.32, F + 0.03, cz + 0.6, GUN, 0.01);
      // game board with pieces, cups, a tablet
      b.part(() => {
        const y = e.y + 0.001;
        bx(b, cx - 0.22, e.y, cz - 0.22, cx + 0.22, y + 0.012, cz + 0.22, mt('veneer', [1.6, 1.4, 1.2]), 0.004);
        const s = 0.05;
        for (let i = 0; i < 8; i++)
          for (let j = 0; j < 8; j++) {
            const x0 = cx - 0.2 + i * s;
            const z0 = cz - 0.2 + j * s;
            b.poly([[x0, y + 0.0125, z0], [x0 + s, y + 0.0125, z0], [x0 + s, y + 0.0125, z0 + s], [x0, y + 0.0125, z0 + s]], mt('veneer', (i + j) & 1 ? [0.5, 0.45, 0.4] : [4.5, 4.0, 3.4]), { n: UP });
          }
        for (let k = 0; k < 14; k++) {
          const i = Math.floor(hr(k, 31) * 8);
          const j = k < 7 ? Math.floor(hr(k, 32) * 3) : 5 + Math.floor(hr(k, 33) * 3);
          b.lathe([cx - 0.2 + (i + 0.5) * s, y + 0.0125, cz - 0.2 + (j + 0.5) * s], [[0.016, 0], [0.016, 0.006], [0.008, 0.014], [0.011, 0.026], [0, 0.03]], 8, mt('whitePanel', k < 7 ? DARK_RED : CREAM));
        }
      }, true);
      b.part(() => {
        b.lathe([a.x + 0.18, e.y, a.z + 0.3], [[0.035, 0], [0.04, 0.09], [0.036, 0.09], [0.031, 0.008], [0, 0.008]], 12, mt('whitePanel', CREAM));
        bx(b, e.x - 0.32, e.y, e.z - 0.42, e.x - 0.1, e.y + 0.008, e.z - 0.26, GUN, 0.003);
        b.poly([[e.x - 0.31, e.y + 0.0085, e.z - 0.41], [e.x - 0.11, e.y + 0.0085, e.z - 0.41], [e.x - 0.11, e.y + 0.0085, e.z - 0.27], [e.x - 0.31, e.y + 0.0085, e.z - 0.27]], SCREEN(1.3), { rect: STENCIL.ui1, n: UP });
      }, true);
      // rug
      bx(b, a.x - 0.35, F, a.z - 0.8, e.x + 0.27, F + 0.008, e.z + 0.8, fab([0.42, 0.16, 0.12]), 0.003);
      b.spot([cx, C - 0.01, cz - 0.4], [0, -1, 0], WARM, 1.6, 45);
      b.spot([cx, C - 0.01, cz + 0.4], [0, -1, 0], WARM, 1.6, 45);
      for (const dz of [-0.4, 0.4]) downlight(b, [cx, C, cz + dz], [0, -1, 0], 0);
    }
    const lr = L.rooms[idx.get('lounge') ?? 0].box;
    for (const z of [-9.4, -7.9, -6.4]) {
      downlight(b, [-1.3, C, z], [0, -1, 0], 1.5);
      downlight(b, [-0.1, C, z + 0.75], [0, -1, 0], 1.1);
    }
    bx(b, -0.45, F, lr.min.z + 0.3, 0.45, F + 0.004, lr.max.z - 0.3, mt('brushed', [0.8, 0.8, 0.8]), 0.002, { fit: true });
    bx(b, -0.4, F + 0.004, lr.min.z + 0.35, 0.4, F + 0.006, lr.max.z - 0.35, DFLOOR, 0.002, { fit: true });
    shelfUnit(b, 1.0, 2.55, lr.min.z, 0.3, 0.95, F, 11);
    shelfUnit(b, 1.45, 2.65, lr.max.z, -0.3, 0.95, F, 21);
    // sideboard with a lamp and a wall screen, port aft
    bx(b, -2.6, F, lr.max.z - 0.4, -1.1, -0.36, lr.max.z, VENEER, 0.008);
    bx(b, -2.62, -0.36, lr.max.z - 0.42, -1.08, -0.33, lr.max.z, BRUSH, 0.006);
    plant(b, -2.35, -0.33, lr.max.z - 0.2, 1.1, 5);
    b.lathe([-1.35, -0.33, lr.max.z - 0.2], [[0.06, 0], [0.02, 0.02], [0.012, 0.3], [0.1, 0.3], [0.08, 0.48], [0, 0.48]], 14, mt('fabric', CREAM), true);
    b.part(() => b.cyl([-1.35, -0.06, lr.max.z - 0.2], [-1.35, 0.1, lr.max.z - 0.2], 0.075, 12, glow(WARM, 2.2)), true);
    b.spot([-1.35, -0.05, lr.max.z - 0.2], [0, -1, 0], WARM, 0.5, 70);
    bx(b, -2.45, 0.08, lr.max.z - 0.035, -1.25, 0.78, lr.max.z, GUN, 0.01);
    b.poly([[-2.42, 0.11, lr.max.z - 0.036], [-1.28, 0.11, lr.max.z - 0.036], [-1.28, 0.75, lr.max.z - 0.036], [-2.42, 0.75, lr.max.z - 0.036]], SCREEN(1.1), { rect: STENCIL.ui2, n: [0, 0, -1] });
    b.rect([-1.85, 0.43, lr.max.z - 0.05], [0.55, 0, 0], [0, 0.3, 0], [0, 0, -1], CYAN, 0.25, GLOW_ALWAYS);
  }

  // ---- cabins ----
  for (const sx of [-1, 1]) {
    const rid = sx < 0 ? 'cabin-port' : 'cabin-stbd';
    if (!at(rid)) continue;
    const suf = sx < 0 ? 'port' : 'stbd';
    const bed = S(`bed-${suf}`);
    const duvet = sx < 0 ? DARK_RED : CHARCOAL;
    const head = sx < 0 ? CHARCOAL : DARK_RED;
    if (bed) {
      const { min: a, max: e } = bed.box;
      bx(b, a.x + 0.02, a.y, a.z + 0.02, e.x - 0.02, a.y + 0.09, e.z - 0.02, GUN);
      bx(b, a.x, a.y + 0.09, a.z, e.x, -0.72, e.z, VENEER, 0.012);
      bx(b, a.x + 0.03, -0.72, a.z + 0.03, e.x - 0.03, -0.57, e.z - 0.03, fab([0.9, 0.88, 0.84]), 0.04);
      bx(b, a.x + 0.02, -0.6, a.z + 0.75, e.x - 0.02, -0.47, e.z - 0.02, fab(duvet), 0.05);
      bx(b, a.x + 0.02, -0.59, a.z + 0.62, e.x - 0.02, -0.46, a.z + 0.78, fab(CREAM), 0.05);
      bx(b, a.x + 0.12, -0.57, a.z + 0.05, e.x - 0.12, -0.46, a.z + 0.42, fab(CREAM), 0.05);
      for (const z of [a.z + 1.25, a.z + 1.85]) bx(b, a.x - 0.004, -0.63, z - 0.03, e.x + 0.004, -0.455, z + 0.03, fab([0.12, 0.12, 0.13]), 0.006);
      bx(b, a.x, -0.62, a.z - 0.1, e.x, 0.42, a.z - 0.02, mt('padded', head), 0.03, { fit: true });
      const lx = sx < 0 ? a.x + 0.25 : e.x - 0.25;
      b.part(() => {
        bx(b, lx - 0.04, 0.5, a.z - 0.1, lx + 0.04, 0.58, a.z - 0.06, BRUSH, 0.005);
        b.cyl([lx, 0.54, a.z - 0.06], [lx, 0.54, a.z + 0.08], 0.008, 6, BRUSH);
        b.lathe([lx, 0.47, a.z + 0.1], [[0.0, 0], [0.045, 0.0], [0.03, 0.07], [0, 0.075]], 12, BRUSH);
        b.cyl([lx, 0.468, a.z + 0.1], [lx, 0.472, a.z + 0.1], 0.04, 10, glow(WARM, 6), { caps: true });
      }, true);
      b.spot([lx, 0.45, a.z + 0.1], [0, -1, 0.35], WARM, 1.1, 50);
      bx(b, sx < 0 ? e.x + 0.02 : a.x - 0.72, F, a.z + 0.6, sx < 0 ? e.x + 0.72 : a.x - 0.02, F + 0.008, a.z + 1.8, fab([0.55, 0.52, 0.48]), 0.003);
    }
    const wd = S(`wardrobe-${suf}`);
    if (wd) {
      const { min: a, max: e } = wd.box;
      bx(b, a.x, a.y, a.z, e.x, e.y, e.z, WARMP, 0.006);
      const fx = sx < 0 ? e.x : a.x;
      const z2 = (a.z + e.z) / 2;
      for (const [za, zb] of [[a.z + 0.01, z2 - 0.004], [z2 + 0.004, e.z - 0.01]]) {
        bx(b, fx, F + 0.08, za, fx - sx * 0.02, C - 0.06, zb, VENEER, 0.004, { fit: true, noAuto: true });
        b.part(() => b.cyl([fx - sx * 0.04, -0.2, za === a.z + 0.01 ? zb - 0.05 : za + 0.05], [fx - sx * 0.04, 0.5, za === a.z + 0.01 ? zb - 0.05 : za + 0.05], 0.01, 6, CHROME), true);
      }
    }
    const dk = S(`desk-${suf}`);
    if (dk) {
      const { min: a, max: e } = dk.box;
      bx(b, a.x, e.y - 0.035, a.z, e.x, e.y, e.z, VENEER, 0.008);
      const dxa = sx < 0 ? e.x - 0.34 : a.x + 0.01;
      bx(b, dxa, F + 0.06, a.z, dxa + 0.33, e.y - 0.035, e.z - 0.05, WARMP, 0.006);
      for (let i = 0; i < 3; i++) bx(b, dxa + 0.01, F + 0.1 + i * 0.22, e.z - 0.05, dxa + 0.32, F + 0.3 + i * 0.22, e.z - 0.035, VENEER, 0.004, { noAuto: true });
      const lx = sx < 0 ? a.x + 0.12 : e.x - 0.12;
      bx(b, sx < 0 ? a.x + 0.02 : e.x - 0.06, F, a.z + 0.05, sx < 0 ? a.x + 0.06 : e.x - 0.02, e.y - 0.035, e.z - 0.05, BRUSH, 0.006);
      b.part(() => {
        b.cyl([lx, e.y, a.z + 0.12], [lx, e.y + 0.012, a.z + 0.12], 0.05, 12, GUN, { caps: true });
        b.cyl([lx, e.y + 0.01, a.z + 0.12], [lx, e.y + 0.38, a.z + 0.2], 0.007, 6, BRUSH);
        b.cyl([lx, e.y + 0.38, a.z + 0.2], [lx - sx * 0.12, e.y + 0.4, a.z + 0.3], 0.007, 6, BRUSH);
        b.lathe([lx - sx * 0.14, e.y + 0.33, a.z + 0.31], [[0, 0], [0.05, 0], [0.03, 0.07], [0, 0.075]], 12, mt('whitePanel', CREAM));
        b.cyl([lx - sx * 0.14, e.y + 0.328, a.z + 0.31], [lx - sx * 0.14, e.y + 0.332, a.z + 0.31], 0.045, 10, glow(WARM, 6), { caps: true });
        bx(b, (a.x + e.x) / 2 - 0.1, e.y, a.z + 0.25, (a.x + e.x) / 2 + 0.12, e.y + 0.008, a.z + 0.4, GUN, 0.003);
        b.poly([[(a.x + e.x) / 2 - 0.09, e.y + 0.0085, a.z + 0.26], [(a.x + e.x) / 2 + 0.11, e.y + 0.0085, a.z + 0.26], [(a.x + e.x) / 2 + 0.11, e.y + 0.0085, a.z + 0.39], [(a.x + e.x) / 2 - 0.09, e.y + 0.0085, a.z + 0.39]], SCREEN(1.2), { rect: STENCIL.ui3, n: UP });
      }, true);
      b.spot([lx - sx * 0.14, e.y + 0.31, a.z + 0.31], [0, -1, 0], WARM, 0.6, 60);
      for (const y of [0.35, 0.75]) {
        bx(b, a.x, y - 0.025, a.z, e.x, y, a.z + 0.22, VENEER, 0.004);
        books(b, a.x + 0.04, e.x - 0.25, y, a.z + 0.01, a.z + 0.21, 0, y > 0.5 ? 41 + sx : 51 + sx);
      }
    }
  }

  // ---- washroom ----
  if (at('washroom')) {
    const sk = S('wash-sink');
    if (sk) {
      const { min: a, max: e } = sk.box;
      bx(b, a.x, F, a.z, e.x - 0.04, F + 0.1, e.z, GUN);
      bx(b, a.x, F + 0.1, a.z, e.x - 0.01, e.y - 0.04, e.z, VENEER, 0.006, { fit: true });
      bx(b, a.x, e.y - 0.04, a.z, e.x, e.y, e.z, STONE, 0.006);
      b.lathe([(a.x + e.x) / 2 + 0.02, e.y, (a.z + e.z) / 2], [[0.06, 0], [0.16, 0.06], [0.17, 0.1], [0.155, 0.1], [0.05, 0.035], [0, 0.035]], 18, mt('whitePanel', [1.15, 1.15, 1.12]));
      b.part(() => {
        b.cyl([a.x + 0.02, e.y + 0.2, (a.z + e.z) / 2], [a.x + 0.14, e.y + 0.2, (a.z + e.z) / 2], 0.012, 8, CHROME);
        b.cyl([a.x + 0.14, e.y + 0.2, (a.z + e.z) / 2], [a.x + 0.14, e.y + 0.17, (a.z + e.z) / 2], 0.01, 8, CHROME);
      }, true);
      bx(b, a.x, 0.02, a.z + 0.02, a.x + 0.012, 0.8, e.z - 0.02, CHROME, 0.004);
      b.poly([[a.x + 0.02, 0.84, a.z + 0.04], [a.x + 0.02, 0.84, e.z - 0.04], [a.x + 0.02, 0.86, e.z - 0.04], [a.x + 0.02, 0.86, a.z + 0.04]], glow(WARM, 6), { n: [1, 0, 0] });
      b.line([a.x + 0.03, 0.85, a.z + 0.06], [a.x + 0.03, 0.85, e.z - 0.06], [1, -0.3, 0], WARM, 0.6);
    }
    const tl = S('wash-toilet');
    if (tl) {
      const { min: a, max: e } = tl.box;
      const cz = (a.z + e.z) / 2;
      bx(b, a.x, F, a.z + 0.06, a.x + 0.38, e.y - 0.1, e.z - 0.06, WHITE, 0.06);
      b.lathe([a.x + 0.3, e.y - 0.1, cz], [[0.2, 0], [0.22, 0.04], [0.2, 0.06], [0.11, 0.06], [0.1, 0.04], [0, 0.04]], 18, mt('whitePanel', [1.1, 1.1, 1.08]));
      bx(b, a.x, e.y - 0.08, a.z + 0.04, a.x + 0.06, e.y + 0.4, e.z - 0.04, WHITE, 0.03);
      b.part(() => {
        b.cyl([a.x + 0.02, 0.3, e.z + 0.05], [a.x + 0.02, 0.3, e.z + 0.3], 0.015, 8, CHROME);
        b.cyl([a.x + 0.06, -0.5, a.z - 0.05], [a.x + 0.45, -0.5, a.z - 0.05], 0.016, 8, CHROME);
        b.cyl([e.x + 0.12, F + 0.05, a.z], [e.x + 0.12, F + 0.05, e.z], 0.014, 8, CHROME);
      }, true);
    }
    const sh = S('wash-shower');
    if (sh) {
      const { min: a, max: e } = sh.box;
      bx(b, a.x, F, a.z, e.x, F + 0.06, e.z, WHITE, 0.012);
      bx(b, a.x, F + 0.06, a.z, a.x + 0.01, C, e.z, mt('whitePanel', [1.1, 1.1, 1.1]), 0, { fit: true });
      bx(b, a.x + 0.01, F + 0.06, e.z - 0.01, e.x, C, e.z, mt('whitePanel', [1.1, 1.1, 1.1]), 0, { fit: true });
      b.poly([[e.x, F + 0.06, a.z], [e.x, F + 0.06, e.z], [e.x, 1.2, e.z], [e.x, 1.2, a.z]], GLASS, { n: [1, 0, 0] });
      b.poly([[e.x - 0.004, F + 0.06, a.z], [e.x - 0.004, F + 0.06, e.z], [e.x - 0.004, 1.2, e.z], [e.x - 0.004, 1.2, a.z]], GLASS, { n: [-1, 0, 0] });
      b.poly([[a.x, F + 0.06, a.z], [e.x, F + 0.06, a.z], [e.x, 1.2, a.z], [a.x, 1.2, a.z]], GLASS, { n: [0, 0, -1] });
      bx(b, e.x - 0.02, 1.2, a.z - 0.01, e.x + 0.01, 1.23, e.z, CHROME, 0.004);
      bx(b, a.x, 1.2, a.z - 0.015, e.x + 0.01, 1.23, a.z + 0.015, CHROME, 0.004);
      bx(b, e.x - 0.02, F + 0.06, a.z - 0.015, e.x + 0.01, 1.2, a.z + 0.015, CHROME, 0.004);
      b.lathe([(a.x + e.x) / 2, C - 0.08, (a.z + e.z) / 2], [[0.0, 0], [0.12, 0], [0.1, 0.03], [0.02, 0.05], [0.02, 0.08]], 16, CHROME);
      b.spot([(a.x + e.x) / 2, C - 0.02, (a.z + e.z) / 2], [0, -1, 0], WARM, 1.0, 60);
      downlight(b, [(a.x + e.x) / 2 + 0.3, C, a.z + 0.2], [0, -1, 0], 0);
    }
    bx(b, -1.55, 0.45, -0.98, -1.05, 0.47, -0.95, CHROME, 0.005);
    bx(b, -1.5, -0.05, -0.97, -1.1, 0.47, -0.93, fab([0.8, 0.76, 0.7]), 0.015);
  }

  // ---- suit room ----
  if (at('suitroom')) {
    const lk = S('suit-lockers');
    if (lk) {
      const { min: a, max: e } = lk.box;
      bx(b, a.x, F, a.z, e.x, F + 0.12, e.z, GUN, 0.01);
      bx(b, a.x, C - 0.22, a.z, e.x, C, e.z, WHITE, 0.01);
      const n = 3;
      for (let i = 0; i <= n; i++) {
        const z = a.z + ((e.z - a.z) * i) / n;
        bx(b, a.x, F + 0.12, Math.max(a.z, z - 0.025), e.x, C - 0.22, Math.min(e.z, z + 0.025), GUN, 0.008);
      }
      for (let i = 0; i < n; i++) {
        const z0 = a.z + ((e.z - a.z) * i) / n + 0.03;
        const z1 = a.z + ((e.z - a.z) * (i + 1)) / n - 0.03;
        const zc = (z0 + z1) / 2;
        bx(b, e.x - 0.03, F + 0.12, z0, e.x, C - 0.22, z1, mt('padded', BLUE), 0, { fit: true });
        const suit = mt('padded', [1.6, 1.55, 1.5]);
        bx(b, 2.78, -0.12, zc - 0.21, 3.04, 0.55, zc + 0.21, suit, 0.09);
        bx(b, 3.04, -0.02, zc - 0.17, 3.16, 0.5, zc + 0.17, GUN, 0.03);
        b.part(() => {
          b.lathe([2.9, 0.58, zc], [[0.0, 0], [0.12, 0.03], [0.16, 0.16], [0.13, 0.29], [0, 0.32]], 14, mt('whitePanel', [1.15, 1.15, 1.15]));
          bx(b, 2.75, 0.68, zc - 0.1, 2.8, 0.82, zc + 0.1, mt('gunmetal', [0.4, 0.45, 0.5]), 0.03);
          for (const s of [-1, 1]) {
            b.cyl([2.9, 0.45, zc + s * 0.25], [2.9, -0.2, zc + s * 0.28], 0.06, 10, suit, { caps: true });
            b.cyl([2.9, 0.1, zc + s * 0.265], [2.9, 0.16, zc + s * 0.268], 0.064, 10, mt('padded', ORANGE));
            b.cyl([2.9, -0.12, zc + s * 0.1], [2.9, F + 0.22, zc + s * 0.11], 0.075, 10, suit, { caps: true });
            bx(b, 2.82, F + 0.12, zc + s * 0.1 - 0.06, 3.0, F + 0.24, zc + s * 0.1 + 0.06, GUN, 0.02);
          }
          bx(b, 2.77, 0.3, zc - 0.08, 2.79, 0.4, zc + 0.08, mt('padded', ORANGE), 0.01);
        });
        b.poly([[a.x, F + 0.12, z0], [a.x, F + 0.12, z1], [a.x, C - 0.22, z1], [a.x, C - 0.22, z0]], GLASS, { n: [-1, 0, 0] });
        b.spot([a.x + 0.25, C - 0.23, zc], [0.3, -1, 0], COOL, 0.8, 60);
        b.poly([[a.x + 0.05, C - 0.2305, z0 + 0.05], [a.x + 0.2, C - 0.2305, z0 + 0.05], [a.x + 0.2, C - 0.2305, z1 - 0.05], [a.x + 0.05, C - 0.2305, z1 - 0.05]], glow(COOL, 4), { n: [0, -1, 0] });
      }
      b.poly([[a.x - 0.002, C - 0.17, -0.3], [a.x - 0.002, C - 0.17, 0.3], [a.x - 0.002, C - 0.07, 0.3], [a.x - 0.002, C - 0.07, -0.3]], WHITE, { rect: STENCIL['EVA SUITS'], n: [-1, 0, 0], U: [0, 0, 1] });
    }
    const bn = S('suit-bench');
    if (bn) {
      const { min: a, max: e } = bn.box;
      bx(b, a.x + 0.05, F, a.z + 0.04, e.x - 0.05, e.y - 0.07, e.z, GUN, 0.01);
      bx(b, a.x, e.y - 0.07, a.z, e.x, e.y, e.z, mt('padded', BLUE), 0.025, { fit: true });
      bx(b, a.x, 0.5, e.z - 0.25, e.x, 0.53, e.z, GUN, 0.006);
      b.lathe([1.6, 0.53, e.z - 0.13], [[0.0, 0], [0.12, 0.03], [0.15, 0.15], [0.12, 0.27], [0, 0.3]], 14, mt('whitePanel', [1.1, 1.1, 1.1]), true);
      b.lathe([2.1, 0.53, e.z - 0.13], [[0.0, 0], [0.12, 0.03], [0.15, 0.15], [0.12, 0.27], [0, 0.3]], 14, mt('whitePanel', ORANGE), true);
    }
  }

  // ---- cargo bay ----
  if (at('cargo')) {
    const cr = L.rooms[idx.get('cargo') ?? 0].box;
    const tints: P3[] = [[0.62, 0.66, 0.55], [0.85, 0.85, 0.82], [1.1, 0.55, 0.12], [0.5, 0.55, 0.62], [0.62, 0.66, 0.55]];
    const labels: StencilId[] = ['CARGO BAY 01', 'CORVANE', 'LIFE SUPPORT', 'WREN  CV-2207', 'NO STEP'];
    for (const sx of [-1, 1]) {
      const s = S(sx < 0 ? 'crates-port' : 'crates-stbd');
      if (!s) continue;
      const { min: a, max: e } = s.box;
      const xin = sx < 0 ? e.x : a.x;
      const xo = sx < 0 ? a.x : e.x;
      const cuts = [a.z, a.z + 1.2, a.z + 2.2, a.z + 3.4, a.z + 4.6, e.z];
      for (let i = 0; i < cuts.length - 1; i++) {
        const z0 = cuts[i] + 0.02;
        const z1 = cuts[i + 1] - 0.02;
        const tint = tints[(i + (sx > 0 ? 2 : 0)) % tints.length];
        const lab = labels[(i + (sx > 0 ? 1 : 0)) % labels.length];
        const xa = xo + sx * -0.02;
        const xb = xin - sx * 0.04;
        if ((i + (sx > 0 ? 1 : 0)) % 2 === 0) crate(b, Math.min(xa, xb), F, z0, Math.max(xa, xb), e.y - 0.03, z1, tint, lab, -sx);
        else {
          crate(b, Math.min(xa, xb), F, z0, Math.max(xa, xb), F + 0.62, z1, tint, lab, -sx);
          crate(b, Math.min(xa, xb) + (sx < 0 ? 0 : 0.12), F + 0.64, z0 + 0.08, Math.max(xa, xb) - (sx < 0 ? 0.12 : 0), e.y - 0.12, z1 - 0.08, tints[(i + 3) % 5], labels[(i + 2) % 5], -sx);
        }
        for (const z of [z0 + 0.25, z1 - 0.25]) {
          const strap = fab(ORANGE);
          bx(b, xin - sx * 0.045, F, z - 0.025, xin - sx * 0.035, e.y - 0.02, z + 0.025, strap, 0.002, { noAuto: true });
          bx(b, xo, e.y - 0.035, z - 0.025, xin - sx * 0.035, e.y - 0.02, z + 0.025, strap, 0.002, { noAuto: true });
          b.part(() => bx(b, xin - sx * 0.05, -0.1, z - 0.035, xin - sx * 0.03, 0.0, z + 0.035, GUN, 0.004), true);
        }
      }
      const nx = xin + sx * -0.0;
      b.poly([[nx - sx * 0.01, F + 0.02, a.z], [nx - sx * 0.01, F + 0.02, e.z], [nx - sx * 0.01, e.y + 0.02, e.z], [nx - sx * 0.01, e.y + 0.02, a.z]], NET, { n: [-sx, 0, 0], ld: 0.5 });
      b.cyl([nx - sx * 0.01, e.y + 0.03, a.z], [nx - sx * 0.01, e.y + 0.03, e.z], 0.014, 8, GUN);
      bx(b, xin - sx * 0.02, F, a.z - 0.05, xin - sx * 0.1, F + 0.03, e.z + 0.05, GUN, 0.006, { face: { 'y+': [VENT, { uv: 'strip', U: [0, 0, 1] }] } });
    }
    // ventral ramp: tread slats, hazard border, seal, hinge and the rams
    const rz0 = 7.0;
    const rz1 = cr.max.z;
    bx(b, -1.4, F, rz0, 1.4, F + 0.01, rz1, GUN, 0, { skip: 'y-' });
    for (let z = rz0 + 0.18; z < rz1 - 0.12; z += 0.24) bx(b, -1.22, F + 0.01, z - 0.035, 1.22, F + 0.026, z + 0.035, TREAD, 0.004, { fit: true });
    const hz = (x0: number, z0: number, x1: number, z1: number, along: P3): void =>
      bx(b, x0, F, z0, x1, F + 0.014, z1, GUN, 0.003, { face: { 'y+': [HAZ, { uv: 'strip', U: along }] }, skip: 'y-' });
    hz(-1.5, rz0, -1.4, rz1, [0, 0, 1]);
    hz(1.4, rz0, 1.5, rz1, [0, 0, 1]);
    hz(-1.5, rz0 - 0.1, 1.5, rz0, [1, 0, 0]);
    bx(b, -1.4, F + 0.01, rz0, -1.37, F + 0.016, rz1, RUBBER);
    bx(b, 1.37, F + 0.01, rz0, 1.4, F + 0.016, rz1, RUBBER);
    b.cyl([-1.35, F + 0.035, rz0 + 0.04], [1.35, F + 0.035, rz0 + 0.04], 0.035, 12, GUN);
    for (const sx of [-1, 1]) {
      const x = sx * 1.68;
      b.cyl([x, F + 0.1, 7.35], [x, F + 0.1, 8.9], 0.075, 14, mt('gunmetal', [1.4, 0.35, 0.3]), { caps: true });
      b.cyl([x, F + 0.1, 8.9], [x, F + 0.1, 9.75], 0.035, 12, CHROME, { caps: true });
      b.part(() => {
        bx(b, x - 0.09, F, 7.15, x + 0.09, F + 0.2, 7.38, GUN, 0.015);
        bx(b, x - 0.07, F, 9.7, x + 0.07, F + 0.16, 9.88, GUN, 0.015);
        b.cyl([x + sx * 0.06, F + 0.14, 7.5], [x + sx * 0.3, F + 0.02, 7.5], 0.02, 8, RUBBER);
      });
    }
    b.poly([[-0.85, F + 0.0125, 6.55], [0.85, F + 0.0125, 6.55], [0.85, F + 0.0125, 6.82], [-0.85, F + 0.0125, 6.82]], WHITE, { rect: STENCIL['CAUTION  RAMP'], n: UP, U: [1, 0, 0] });
    // gantry rails and a hoist
    for (const x of [-0.65, 0.65]) {
      bx(b, x - 0.06, C - 0.03, cr.min.z + 0.1, x + 0.06, C, cr.max.z - 0.1, GUN, 0.004);
      bx(b, x - 0.012, C - 0.17, cr.min.z + 0.1, x + 0.012, C - 0.03, cr.max.z - 0.1, GUN, 0.003);
      bx(b, x - 0.06, C - 0.2, cr.min.z + 0.1, x + 0.06, C - 0.17, cr.max.z - 0.1, GUN, 0.004);
    }
    b.part(() => {
      bx(b, -0.75, C - 0.36, 5.3, 0.75, C - 0.2, 5.75, mt('whitePanel', [1.1, 0.75, 0.2]), 0.02);
      b.cyl([0, C - 0.36, 5.52], [0, C - 0.7, 5.52], 0.008, 6, GUN);
      bx(b, -0.05, C - 0.82, 5.47, 0.05, C - 0.7, 5.57, GUN, 0.02);
    });
  }

  // ---- engineering ----
  if (at('engineering')) {
    const rc = S('reactor');
    if (rc) {
      const { min: a, max: e } = rc.box;
      const cx = (a.x + e.x) / 2;
      const cz = (a.z + e.z) / 2;
      const R0 = Math.min(e.x - a.x, e.z - a.z) / 2 - 0.02;
      const oct = (r: number, y: number, rot = Math.PI / 8): P3[] => {
        const p: P3[] = [];
        for (let i = 0; i < 8; i++) {
          const t = rot + (i / 8) * Math.PI * 2;
          p.push([cx + r * Math.sin(t), y, cz - r * Math.cos(t)]);
        }
        return p;
      };
      const ctr: P3 = [cx, 0, cz];
      const ring = (r0: number, r1: number, y0: number, y1: number, m: Mat): void => {
        const lo = oct(r0, y0);
        const hi = oct(r1, y1);
        for (let i = 0; i < 8; i++) {
          const j = (i + 1) % 8;
          b.poly([lo[i], lo[j], hi[j], hi[i]], m, { away: [cx, (y0 + y1) / 2, cz] });
        }
      };
      ring(R0 + 0.06, R0 + 0.06, F, F + 0.14, GUN);
      b.poly(oct(R0 + 0.06, F + 0.14), HAZ, { n: UP, uv: 'world' });
      const yv0 = -0.55;
      const yv1 = 0.45;
      const yt = 0.75;
      // housing: 8 faces, the 3 facing the door have glowing vent windows behind grating
      const lo = oct(R0, F + 0.14);
      const hi = oct(R0, yt);
      for (let i = 0; i < 8; i++) {
        const j = (i + 1) % 8;
        const mid = add(mul(add(lo[i], lo[j]), 0.5), [0, 0, 0]);
        const outward = nrm(sub([mid[0], 0, mid[2]], ctr));
        const vent = outward[2] < -0.3 || Math.abs(outward[0]) > 0.9;
        if (!vent) {
          b.poly([lo[i], lo[j], hi[j], hi[i]], WHITE, { n: outward, uv: 'fit' });
          continue;
        }
        const Lp = (p: P3, q: P3, t: number, y: number): P3 => [p[0] + (q[0] - p[0]) * t, y, p[2] + (q[2] - p[2]) * t];
        const f = 0.16;
        b.poly([lo[i], lo[j], Lp(lo[i], lo[j], 1, yv0), Lp(lo[i], lo[j], 0, yv0)], WHITE, { n: outward, uv: 'fit' });
        b.poly([Lp(lo[i], lo[j], 0, yv1), Lp(lo[i], lo[j], 1, yv1), hi[j], hi[i]], WHITE, { n: outward, uv: 'fit' });
        b.poly([Lp(lo[i], lo[j], 0, yv0), Lp(lo[i], lo[j], f, yv0), Lp(lo[i], lo[j], f, yv1), Lp(lo[i], lo[j], 0, yv1)], WHITE, { n: outward });
        b.poly([Lp(lo[i], lo[j], 1 - f, yv0), Lp(lo[i], lo[j], 1, yv0), Lp(lo[i], lo[j], 1, yv1), Lp(lo[i], lo[j], 1 - f, yv1)], WHITE, { n: outward });
        const dIn = mul(outward, -0.06);
        const c0 = Lp(lo[i], lo[j], f, yv0);
        const c1 = Lp(lo[i], lo[j], 1 - f, yv0);
        const c2 = Lp(lo[i], lo[j], 1 - f, yv1);
        const c3 = Lp(lo[i], lo[j], f, yv1);
        b.poly([add(c0, dIn), add(c1, dIn), add(c2, dIn), add(c3, dIn)], glow(REACT, 7, GLOW_ALWAYS), { n: outward });
        b.poly([c0, c1, add(c1, dIn), add(c0, dIn)], GUN, { n: UP });
        b.poly([c3, c2, add(c2, dIn), add(c3, dIn)], GUN, { n: [0, -1, 0] });
        b.poly([c0, c3, add(c3, dIn), add(c0, dIn)], GUN, { toward: add(mul(add(c0, c2), 0.5), dIn) });
        b.poly([c1, c2, add(c2, dIn), add(c1, dIn)], GUN, { toward: add(mul(add(c0, c2), 0.5), dIn) });
        b.poly([add(c0, mul(outward, -0.008)), add(c1, mul(outward, -0.008)), add(c2, mul(outward, -0.008)), add(c3, mul(outward, -0.008))], mt('grating', ONE, 'cut'), { n: outward, ld: 0.4 });
        const cc = mul(add(c0, c2), 0.5);
        b.rect(add(cc, mul(outward, 0.02)), mul(sub(c1, c0), 0.5), [0, (yv1 - yv0) / 2, 0], outward, REACT, 2.2, GLOW_ALWAYS);
      }
      for (const y of [-0.62, 0.52]) ring(R0 + 0.015, R0 + 0.015, y, y + 0.05, GUN);
      ring(R0, R0 - 0.08, yt, yt + 0.1, GUN);
      ring(R0 - 0.08, 0.32, yt + 0.1, yt + 0.22, GUN);
      b.poly(oct(0.32, yt + 0.22), GUN, { n: UP });
      for (const [dx, dz] of [[-0.22, -0.12], [0.22, -0.12], [0, 0.2]] as Array<[number, number]>) {
        b.cyl([cx + dx, yt + 0.2, cz + dz], [cx + dx, C, cz + dz], 0.055, 12, GUN);
        b.part(() => {
          b.cyl([cx + dx, yt + 0.28, cz + dz], [cx + dx, yt + 0.33, cz + dz], 0.08, 12, GUN, { caps: true });
          b.cyl([cx + dx, C - 0.12, cz + dz], [cx + dx, C - 0.07, cz + dz], 0.08, 12, mt('gunmetal', [1.6, 0.3, 0.25]), { caps: true });
        }, true);
      }
      const fz = cz - R0 * Math.cos(Math.PI / 8) - 0.003;
      b.poly([[cx - 0.22, 0.55, fz], [cx + 0.22, 0.55, fz], [cx + 0.22, 0.66, fz], [cx - 0.22, 0.66, fz]], WHITE, { rect: STENCIL.CORVANE, n: [0, 0, -1], U: [-1, 0, 0] });
    }
    const rk = S('eng-racks');
    if (rk) {
      const { min: a, max: e } = rk.box;
      const n = 3;
      for (let i = 0; i < n; i++) {
        const z0 = a.z + ((e.z - a.z) * i) / n + 0.01;
        const z1 = a.z + ((e.z - a.z) * (i + 1)) / n - 0.01;
        bx(b, a.x, F, z0, e.x - 0.03, C - 0.05, z1, GUN, 0.01);
        for (let k = 0; k < 6; k++) {
          const y0 = F + 0.12 + k * 0.36;
          if (y0 + 0.32 > C - 0.08) break;
          bx(b, e.x - 0.03, y0, z0 + 0.03, e.x - 0.01, y0 + 0.32, z1 - 0.03, mt('whitePanel', [0.55, 0.57, 0.6]), 0.004, { fit: true, noAuto: true });
          b.part(() => {
            b.poly([[e.x - 0.009, y0 + 0.04, z0 + 0.06], [e.x - 0.009, y0 + 0.04, z1 - 0.06], [e.x - 0.009, y0 + 0.1, z1 - 0.06], [e.x - 0.009, y0 + 0.1, z0 + 0.06]], VENT, { n: [1, 0, 0], uv: 'strip', U: [0, 0, 1] });
            for (let q = 0; q < 4; q++) {
              const z = z0 + 0.08 + q * 0.035;
              const col: P3 = q === 3 ? [1, 0.55, 0.1] : [0.3, 1, 0.45];
              const gp = q === 1 && (k + i) % 2 ? GLOW_BLINK : GLOW_ALWAYS;
              b.poly([[e.x - 0.008, y0 + 0.24, z], [e.x - 0.008, y0 + 0.24, z + 0.018], [e.x - 0.008, y0 + 0.26, z + 0.018], [e.x - 0.008, y0 + 0.26, z]], glow(col, 6, gp), { n: [1, 0, 0] });
            }
          }, true);
        }
        b.cyl([a.x + 0.2, C - 0.05, (z0 + z1) / 2], [a.x + 0.2, C, (z0 + z1) / 2], 0.04, 8, RUBBER);
      }
      b.rect([e.x + 0.02, 0.2, (a.z + e.z) / 2], [0, 0, 0.8], [0, 0.9, 0], [1, 0, 0], [0.4, 1, 0.6], 0.05, GLOW_ALWAYS);
    }
    const wb = S('workbench');
    if (wb) {
      const { min: a, max: e } = wb.box;
      bx(b, a.x, e.y - 0.05, a.z, e.x, e.y, e.z, GUN, 0.006);
      bx(b, a.x + 0.05, e.y, a.z + 0.1, e.x - 0.05, e.y + 0.005, e.z - 0.1, mt('tread', [1.4, 1.4, 1.4]), 0.003);
      bx(b, a.x + 0.05, F, a.z + 0.05, e.x, e.y - 0.05, a.z + 0.6, WHITE, 0.008);
      for (let i = 0; i < 4; i++) bx(b, a.x + 0.035, F + 0.08 + i * 0.22, a.z + 0.07, a.x + 0.05, F + 0.27 + i * 0.22, a.z + 0.58, mt('whitePanel', [0.9, 0.9, 0.92]), 0.004, { noAuto: true });
      bx(b, a.x + 0.05, F, e.z - 0.08, a.x + 0.12, e.y - 0.05, e.z - 0.02, GUN, 0.006);
      b.part(() => {
        bx(b, a.x + 0.1, e.y, e.z - 0.35, a.x + 0.28, e.y + 0.09, e.z - 0.2, GUN, 0.01);
        bx(b, a.x + 0.08, e.y + 0.09, e.z - 0.34, a.x + 0.3, e.y + 0.12, e.z - 0.21, mt('gunmetal', [1.5, 0.3, 0.25]), 0.006);
        bx(b, a.x + 0.15, e.y + 0.005, a.z + 0.3, a.x + 0.17, e.y + 0.015, a.z + 0.55, CHROME, 0.003);
        b.cyl([a.x + 0.25, e.y + 0.015, a.z + 0.7], [a.x + 0.25, e.y + 0.015, a.z + 0.82], 0.012, 8, mt('padded', ORANGE), { caps: true });
        b.cyl([a.x + 0.25, e.y + 0.015, a.z + 0.82], [a.x + 0.25, e.y + 0.015, a.z + 0.95], 0.004, 6, CHROME);
        bx(b, a.x + 0.35, e.y + 0.005, a.z + 0.75, a.x + 0.47, e.y + 0.06, a.z + 0.95, mt('whitePanel', [1.2, 0.7, 0.1]), 0.008);
        b.poly([[a.x + 0.37, e.y + 0.061, a.z + 0.8], [a.x + 0.45, e.y + 0.061, a.z + 0.8], [a.x + 0.45, e.y + 0.061, a.z + 0.88], [a.x + 0.37, e.y + 0.061, a.z + 0.88]], SCREEN(1.3), { rect: STENCIL.ui3, n: UP });
      }, true);
      bx(b, e.x - 0.025, e.y + 0.1, a.z + 0.05, e.x, e.y + 0.9, e.z - 0.05, mt('grating', [1.6, 1.6, 1.65]), 0.004, { fit: true });
      b.part(() => {
        for (let i = 0; i < 6; i++) {
          const z = a.z + 0.2 + i * 0.2;
          bx(b, e.x - 0.045, e.y + 0.35 + hr(i, 3) * 0.2, z, e.x - 0.025, e.y + 0.65 + hr(i, 4) * 0.15, z + 0.035, i % 2 ? CHROME : mt('padded', ORANGE), 0.004);
        }
      }, true);
      bx(b, e.x - 0.25, e.y + 0.95, a.z + 0.05, e.x, e.y + 0.98, e.z - 0.05, GUN, 0.004);
      b.poly([[e.x - 0.2, e.y + 0.9495, a.z + 0.1], [e.x - 0.05, e.y + 0.9495, a.z + 0.1], [e.x - 0.05, e.y + 0.9495, e.z - 0.1], [e.x - 0.2, e.y + 0.9495, e.z - 0.1]], glow(COOL, 5), { n: [0, -1, 0] });
      b.line([e.x - 0.12, e.y + 0.94, a.z + 0.12], [e.x - 0.12, e.y + 0.94, e.z - 0.12], [-0.3, -1, 0], COOL, 0.8);
    }
    const cl = S('coolant');
    if (cl) {
      const { min: a, max: e } = cl.box;
      const tx = (a.x + e.x) / 2 + 0.05;
      const tz = (a.z + e.z) / 2 + 0.05;
      b.cyl([tx, F + 0.1, tz], [tx, 0.95, tz], 0.3, 18, WHITE);
      b.lathe([tx, 0.95, tz], [[0.3, 0], [0.26, 0.1], [0.12, 0.17], [0, 0.18]], 18, WHITE);
      b.lathe([tx, F, tz], [[0.32, 0], [0.32, 0.1], [0, 0.1]], 18, GUN);
      for (const y of [-0.3, 0.55]) b.cyl([tx, y, tz], [tx, y + 0.06, tz], 0.305, 18, mt('gunmetal', [1.6, 0.3, 0.25]));
      b.poly([[tx - 0.302, 0.15, tz - 0.17], [tx - 0.302, 0.15, tz + 0.17], [tx - 0.302, 0.24, tz + 0.17], [tx - 0.302, 0.24, tz - 0.17]], WHITE, { rect: STENCIL['COOLANT LOOP B'], n: [-1, 0, 0], U: [0, 0, 1] });
      b.cyl([tx, 1.13, tz], [tx, C, tz], 0.06, 12, GUN);
      b.cyl([tx, 1.22, tz], [0.42, 1.22, tz], 0.06, 12, GUN);
      b.part(() => {
        bx(b, a.x, F, a.z + 0.02, a.x + 0.3, F + 0.32, a.z + 0.32, GUN, 0.02);
        b.cyl([a.x + 0.15, F + 0.18, a.z + 0.32], [a.x + 0.15, F + 0.18, a.z + 0.5], 0.09, 14, mt('whitePanel', [1.2, 0.35, 0.3]), { caps: true });
        b.cyl([1.2, 1.22, tz], [1.25, 1.22, tz], 0.085, 12, mt('gunmetal', [1.6, 0.3, 0.25]), { caps: true });
        b.lathe([1.0, 1.29, tz], [[0.0, 0], [0.11, 0.0], [0.11, 0.015], [0.0, 0.015]], 16, mt('gunmetal', [1.6, 0.3, 0.25]));
        b.cyl([1.0, 1.22, tz], [1.0, 1.29, tz], 0.012, 6, GUN);
      }, true);
    }
    // breaker panels, ceiling pipe runs
    const er = L.rooms[idx.get('engineering') ?? 0].box;
    bx(b, er.min.x, -0.25, 12.4, er.min.x + 0.12, 0.9, 13.3, mt('whitePanel', [0.85, 0.85, 0.88]), 0.01);
    b.part(() => {
      for (let r = 0; r < 4; r++)
        for (let c = 0; c < 6; c++) {
          const z = 12.48 + c * 0.13;
          const y = -0.12 + r * 0.24;
          bx(b, er.min.x + 0.12, y, z, er.min.x + 0.15, y + 0.12, z + 0.08, GUN, 0.004, { noAuto: true });
          bx(b, er.min.x + 0.15, y + 0.03 + ((r + c) % 3 === 0 ? 0.04 : 0), z + 0.025, er.min.x + 0.17, y + 0.06 + ((r + c) % 3 === 0 ? 0.04 : 0), z + 0.055, mt('whitePanel', (r + c) % 4 === 0 ? [1.3, 0.25, 0.2] : [1.1, 1.1, 1.1]), 0.003, { noAuto: true });
          b.poly([[er.min.x + 0.151, y + 0.095, z + 0.03], [er.min.x + 0.151, y + 0.095, z + 0.05], [er.min.x + 0.151, y + 0.11, z + 0.05], [er.min.x + 0.151, y + 0.11, z + 0.03]], glow((r + c) % 5 === 0 ? [1, 0.3, 0.1] : [0.3, 1, 0.45], 5, GLOW_ALWAYS), { n: [1, 0, 0] });
        }
      b.poly([[er.min.x + 0.121, 0.75, 12.55], [er.min.x + 0.121, 0.75, 13.15], [er.min.x + 0.121, 0.85, 13.15], [er.min.x + 0.121, 0.85, 12.55]], WHITE, { rect: STENCIL['LIFE SUPPORT'], n: [1, 0, 0], U: [0, 0, -1] });
    }, true);
    for (const [x, y, r] of [[-1.35, 1.24, 0.055], [-1.15, 1.27, 0.035], [1.0, 1.27, 0.04]] as Array<[number, number, number]>) {
      b.cyl([x, y, er.min.z + 0.02], [x, y, er.max.z - 0.02], r, 10, x > 0 ? mt('gunmetal', [1.5, 0.35, 0.3]) : GUN);
      b.part(() => {
        for (let z = er.min.z + 0.4; z < er.max.z; z += 1.0) bx(b, x - r - 0.015, y - r - 0.02, z - 0.02, x + r + 0.015, C, z + 0.02, GUN, 0.004);
      }, true);
    }
  }
}

function sofa(b: Builder, s: InteriorSolid | undefined, F: number): void {
  if (!s) return;
  const { min: a, max: e } = s.box;
  const LEATHER = mt('leather', RED_LEATHER);
  const zc = (a.z + e.z) / 2;
  const hl = (e.z - a.z) / 2;
  const xBack = 2.75;
  const seatY = -0.55;
  const N = 12;
  const xf = (z: number): number => a.x + 0.25 * (1 - Math.pow((z - zc) / hl, 2));
  const prof = (z: number): P3[] => {
    const f = xf(z);
    return [
      [f + 0.08, F, z], [f + 0.08, F + 0.12, z], [f, F + 0.12, z], [f, seatY - 0.11, z], [f + 0.035, seatY - 0.02, z], [f + 0.1, seatY, z], [xBack, seatY, z],
    ];
  };
  const ctr = (z: number): P3 => [2.6, -0.8, z];
  const za = a.z + 0.15;
  const zb = e.z - 0.15;
  for (let i = 0; i < N; i++) {
    const z0 = za + ((zb - za) * i) / N;
    const z1 = za + ((zb - za) * (i + 1)) / N;
    const pa = prof(z0);
    const pb = prof(z1);
    b.loft(pa.slice(0, 2), pb.slice(0, 2), GUN, ctr((z0 + z1) / 2));
    b.loft(pa.slice(1), pb.slice(1), LEATHER, ctr((z0 + z1) / 2));
    const g0: P3 = [xf(z0) + 0.0795, F + 0.085, z0];
    const g1: P3 = [xf(z1) + 0.0795, F + 0.085, z1];
    b.poly([g0, g1, add(g1, [0, 0.025, 0]), add(g0, [0, 0.025, 0])], glow(WARM, 3), { n: [-1, 0, 0] });
    if (i % 3 === 1) b.line([xf(z0) + 0.06, F + 0.1, z0], [xf(z1) + 0.06, F + 0.1, z1], [-1, -0.8, 0], WARM, 0.25);
  }
  bx(b, xBack, F, za, e.x, seatY, zb, LEATHER, 0.01);
  const nc = 4;
  for (let i = 0; i < nc; i++) {
    const z0 = za + ((zb - za) * i) / nc + 0.006;
    const z1 = za + ((zb - za) * (i + 1)) / nc - 0.006;
    bx(b, xBack, seatY, z0, e.x, s.box.max.y + 0.45 > -0.1 ? -0.1 : -0.1, z1, LEATHER, 0.06, { fit: true });
  }
  for (const [z0, z1] of [[a.z, za], [zb, e.z]]) bx(b, a.x + 0.03, F, z0, e.x, -0.36, z1, LEATHER, 0.05, { fit: true });
  b.part(() => {
    bx(b, 2.5, seatY, -9.15, 2.74, seatY + 0.36, -8.75, fab(CREAM), 0.07);
    bx(b, 2.52, seatY, -6.3, 2.74, seatY + 0.33, -5.95, fab([0.75, 0.5, 0.25]), 0.07);
  }, true);
}

// ---------------------------------------------------------------------------------------------------------
// the whole interior

export interface InteriorBuild {
  rooms: string[];
  roomBoxes: Box[];
  buckets: Bucket[];
  charts: Chart[];
  emitters: Emitter[];
  lmW: number;
  lmH: number;
  density: number;
  key: string;
}

const LM_W = 1024;
const LM_H = 1024;
const LM_D = 16;

export function buildInterior(L: InteriorLayout): InteriorBuild {
  const boxes = L.rooms.map((r) => r.box);
  const b = new Builder(boxes);
  const idx = new Map(L.rooms.map((r, i) => [r.id, i] as [string, number]));
  const work = new Set(['cockpit', 'suitroom', 'cargo', 'engineering']);
  const living = new Set(['lounge', 'cabin-port', 'cabin-stbd', 'washroom']);
  L.rooms.forEach((room, ri) => {
    b.room = ri;
    if (room.id === 'corridor') {
      octRoom(b, L, room, [-4.1, -3.1, -2.1, -1.1, -0.5, 0.5, 1.3, 2.75], 2.82);
      hatch(b, room);
      for (const x of [-0.6, 0.6]) b.spot([x, room.box.max.y - 0.05, -3.6], [0, -1, 0], NEUT, 0.0, 50);
      return;
    }
    if (room.id === 'vestibule') {
      octRoom(b, L, room, [-11.0], 99);
      return;
    }
    const walls = roomWalls(L, room);
    const style = work.has(room.id) ? 'work' : living.has(room.id) ? 'living' : 'work';
    const vert = walls.slice(0, 4);
    for (const w of vert) {
      if (style === 'work') workWall(b, w, { net: room.id === 'cargo' && w.ax === 0, padEvery: room.id === 'cockpit' ? 2 : 3, noCove: false });
      else livingWall(b, w);
    }
    const floor = walls[4];
    const ceil = walls[5];
    if (style === 'work') {
      const excl: R[] = room.id === 'cargo' ? [{ u0: -1.5, v0: 6.9, u1: 1.5, v1: room.box.max.z }] : [];
      for (const s of L.solids) if (s.room === room.id && s.kind !== 'console') excl.push({ u0: s.box.min.x - 0.01, v0: s.box.min.z - 0.01, u1: s.box.max.x + 0.01, v1: s.box.max.z + 0.01 });
      workFloor(b, floor, excl);
      const ribV = ribsAlong(room.box.min.z, room.box.max.z);
      const W = room.box.max.x - room.box.min.x;
      const xc = (room.box.max.x + room.box.min.x) / 2;
      let strips = W > 2.8 ? [xc - W / 4, xc + W / 4] : [xc];
      if (room.id === 'cockpit') strips = [-1.28, 1.28];
      workCeiling(b, ceil, ribV, strips);
    } else {
      wquad(b, floor, { u0: floor.u0, v0: floor.v0, u1: floor.u1, v1: floor.v1 }, 0, DFLOOR, { ld: 0.9 });
      livingCeiling(b, vert, ceil, true);
    }
    for (const w of walls) for (const h of w.holes) if (!isDoorHole(L, room, w, h)) windowFrame(b, w, h, room.id === 'cockpit' ? 'cockpit' : style, w.ax === 1 ? 0.3 : room.id === 'lounge' ? 0.26 : 0.2);
    if (room.id === 'cockpit') {
      b.rect([0, 0.02, -14.35], [1.4, 0, 0], [0, 0, 0.18], [0, 1, 0.6], CYAN, 0.35, GLOW_ALWAYS);
      b.rect([0, 0.02, -14.35], [1.4, 0, 0], [0, 0, 0.18], [0, 1, 0.6], COOL, 0.2, GLOW_MAIN);
    }
  });
  for (const d of L.doors) {
    const ia = idx.get(d.a) ?? 0;
    b.room = ia;
    const work2 = ['cockpit', 'suitroom', 'cargo', 'engineering'].includes(d.a) || ['cargo', 'engineering', 'suitroom'].includes(d.b);
    doorFrame(b, d, work2);
  }
  solids(b, L, idx);
  // handrails in the work rooms
  const at = (id: string): boolean => {
    const i = idx.get(id);
    if (i === undefined) return false;
    b.room = i;
    return true;
  };
  if (at('cargo')) {
    const r = L.rooms[b.room].box;
    for (const z of [r.min.z + 0.12, r.max.z - 0.12])
      for (const sx of [-1, 1]) rail(b, [sx * 1.1, 0.35, z], [sx * 2.9, 0.35, z], [0, 0, z < 5 ? -1 : 1], 0.12);
  }
  if (at('engineering')) rail(b, [-1.3, 0.35, 10.12], [-0.75, 0.35, 10.12], [0, 0, -1], 0.12);
  if (at('cockpit')) for (const sx of [-1, 1]) rail(b, [sx * 0.8, 0.95, -11.72], [sx * 1.5, 0.95, -11.72], [0, 0, 1], 0.12);

  // ---- pack the lightmap ----
  const charts = b.charts;
  let D = LM_D;
  let usedH = 0;
  for (let tries = 0; tries < 40; tries++) {
    for (const c of charts) {
      if (c.t === 0) {
        c.dd = D * c.ld;
        c.w = Math.ceil(c.sw * c.dd) + 3;
        c.h = Math.ceil(c.sh * c.dd) + 3;
        if (c.w > LM_W) {
          c.dd *= (LM_W - 3) / c.w;
          c.w = LM_W;
          c.h = Math.ceil(c.sh * c.dd) + 3;
        }
      } else if (c.t === 2) {
        c.dd = D * 0.5;
        c.w = Math.min(LM_W, Math.ceil(c.len * c.dd) + 3);
        c.dd = (c.w - 3) / Math.max(c.len, 1e-3);
      }
    }
    const order = charts.map((_, i) => i).sort((p, q) => charts[q].h - charts[p].h || charts[q].w - charts[p].w || p - q);
    let x = 0;
    let y = 0;
    let rowH = 0;
    for (const i of order) {
      const c = charts[i];
      if (x + c.w > LM_W) {
        y += rowH;
        x = 0;
        rowH = 0;
      }
      c.x = x;
      c.y = y;
      x += c.w;
      rowH = Math.max(rowH, c.h);
    }
    usedH = y + rowH;
    if (usedH <= LM_H) break;
    D *= 0.93;
  }
  const H = Math.min(LM_H, Math.ceil(usedH / 8) * 8);
  // uv1
  for (const bk of b.buckets) {
    const n = bk.lmc.length;
    bk.uv1 = new Array(n * 2).fill(0);
    for (let i = 0; i < n; i++) {
      const c = bk.lmc[i] >= 0 ? charts[bk.lmc[i]] : null;
      if (!c) continue;
      const s = bk.lms[i];
      const t = bk.lmt[i];
      let u: number;
      let v: number;
      if (c.t === 0) {
        u = c.x + 1 + s * c.dd + 0.5;
        v = c.y + 1 + t * c.dd + 0.5;
      } else if (c.t === 1) {
        u = c.x + 2 * s + 1;
        v = c.y + 1;
      } else {
        u = c.x + 1 + s * c.dd + 0.5;
        v = c.y + 1.5 + t / (Math.PI / 2);
      }
      bk.uv1[i * 2] = u / LM_W;
      bk.uv1[i * 2 + 1] = v / H;
    }
  }
  // key: FNV over the packing and the geometry
  let h = 2166136261;
  const mix = (x: number): void => {
    h ^= x & 0xffff;
    h = Math.imul(h, 16777619);
    h ^= (x >>> 16) & 0xffff;
    h = Math.imul(h, 16777619);
  };
  mix(Math.round(D * 1000));
  mix(H);
  for (const c of charts) {
    mix(c.x);
    mix(c.y);
    mix(c.w);
    mix(c.t);
  }
  for (const bk of b.buckets) {
    mix(bk.pos.length);
    for (let i = 0; i < bk.pos.length; i += 7) mix(Math.round(bk.pos[i] * 1000));
  }
  for (const e of b.emitters) mix(Math.round((e.p[0] + e.p[1] * 3 + e.p[2] * 7 + e.k * 11) * 1000));
  return { rooms: L.rooms.map((r) => r.id), roomBoxes: boxes, buckets: b.buckets, charts, emitters: b.emitters, lmW: LM_W, lmH: H, density: D, key: (h >>> 0).toString(16) };
}

function isDoorHole(L: InteriorLayout, room: InteriorRoom, w: Wall, h: R): boolean {
  return L.doors.some((d) => {
    if (d.a !== room.id && d.b !== room.id) return false;
    const lo = [d.box.min.x, d.box.min.y, d.box.min.z];
    return Math.abs(lo[w.ua] - h.u0) < 1e-6 && Math.abs(lo[w.va] - h.v0) < 1e-6;
  });
}

function hatch(b: Builder, room: InteriorRoom): void {
  const C = room.box.max.y;
  const hz = 2.2;
  const r = 0.42;
  // ceiling round the well: square minus circle, 16 convex pieces
  const sq = 0.5;
  const segs = 16;
  for (let i = 0; i < segs; i++) {
    const t0 = (i / segs) * Math.PI * 2;
    const t1 = ((i + 1) / segs) * Math.PI * 2;
    const ray = (t: number): [number, number] => {
      const cx = Math.cos(t);
      const sz = Math.sin(t);
      const k = sq / Math.max(Math.abs(cx), Math.abs(sz));
      return [cx * k, sz * k];
    };
    const o0 = ray(t0);
    const o1 = ray(t1);
    const pts: P3[] = [[Math.cos(t0) * r, C - 0.001, hz + Math.sin(t0) * r], [o0[0], C - 0.001, hz + o0[1]]];
    const tm = (t0 + t1) / 2;
    const cornerT = Math.round(tm / (Math.PI / 2) - 0.5) * (Math.PI / 2) + Math.PI / 4;
    if (Math.abs(tm - cornerT) < Math.PI / segs + 1e-6 && Math.abs(Math.cos(cornerT)) > 0.5) pts.push([Math.sign(Math.cos(cornerT)) * sq, C - 0.001, hz + Math.sign(Math.sin(cornerT)) * sq]);
    pts.push([o1[0], C - 0.001, hz + o1[1]], [Math.cos(t1) * r, C - 0.001, hz + Math.sin(t1) * r]);
    b.poly(pts, GUN, { n: [0, -1, 0], ld: 0.6 });
    b.poly([[Math.cos(t0) * r, C - 0.006, hz + Math.sin(t0) * r], [Math.cos(t0) * (r + 0.09), C - 0.006, hz + Math.sin(t0) * (r + 0.09)], [Math.cos(t1) * (r + 0.09), C - 0.006, hz + Math.sin(t1) * (r + 0.09)], [Math.cos(t1) * r, C - 0.006, hz + Math.sin(t1) * r]], HAZ, { n: [0, -1, 0], uv: 'strip', U: [-Math.sin(tm), 0, Math.cos(tm)] });
  }
  b.cyl([0, C, hz], [0, C + 0.5, hz], r, 24, WHITE, { inside: true });
  b.cyl([0, C - 0.04, hz], [0, C, hz], r + 0.005, 24, GUN, { inside: true });
  b.lathe([0, C + 0.5, hz], [[r, 0], [r - 0.06, -0.02], [0.2, -0.04], [0.0, -0.04]], 24, GUN);
  b.part(() => {
    for (let i = 0; i < 6; i++) {
      const t = (i / 6) * Math.PI * 2;
      const p: P3 = [Math.cos(t) * (r - 0.05), C + 0.45, hz + Math.sin(t) * (r - 0.05)];
      bx(b, p[0] - 0.03, p[1] - 0.03, p[2] - 0.03, p[0] + 0.03, p[1] + 0.02, p[2] + 0.03, mt('gunmetal', [1.5, 0.3, 0.25]), 0.006);
    }
    b.lathe([0, C + 0.36, hz], [[0.17, 0], [0.19, 0.015], [0.17, 0.03], [0.15, 0.015]], 20, CHROME);
    for (let i = 0; i < 3; i++) {
      const t = (i / 3) * Math.PI * 2;
      b.cyl([0, C + 0.375, hz], [Math.cos(t) * 0.16, C + 0.375, hz + Math.sin(t) * 0.16], 0.01, 6, CHROME);
    }
    b.cyl([0, C + 0.375, hz], [0, C + 0.46, hz], 0.03, 10, GUN, { caps: true });
  });
  b.line([-0.3, C + 0.42, hz - 0.3], [0.3, C + 0.42, hz - 0.3], [0, -1, 1], NEUT, 0.3);
  b.poly([[-0.3, C - 0.002, hz - 0.62], [0.3, C - 0.002, hz - 0.62], [0.3, C - 0.002, hz - 0.53], [-0.3, C - 0.002, hz - 0.53]], WHITE, { rect: STENCIL['DOCKING HATCH'], n: [0, -1, 0], U: [1, 0, 0] });
  // ladder on the starboard wall
  const lx = 0.76;
  for (const z of [1.92, 2.48]) {
    b.cyl([lx, room.box.min.y + 0.04, z], [lx, 1.2, z], 0.02, 8, CHROME);
    b.part(() => {
      for (const y of [-0.6, 0.3, 1.1]) b.cyl([lx, y, z], [room.box.max.x - 0.002, y, z], 0.012, 6, GUN);
    }, true);
  }
  b.part(() => {
    for (let y = -0.7; y < 1.15; y += 0.3) b.cyl([lx, y, 1.92], [lx, y, 2.48], 0.016, 8, mt('tread', [2.2, 2.2, 2.2]));
  });
}

// ---------------------------------------------------------------------------------------------------------
// runtime

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
/** float -> IEEE half (round to nearest, no NaN/denormal care beyond flush). */
function half(x: number): number {
  _f32[0] = x;
  const f = _u32[0];
  const e = ((f >>> 23) & 0xff) - 127 + 15;
  if (e <= 0) return 0;
  if (e >= 31) return 0x7bff;
  return (e << 10) | ((f >>> 13) & 0x3ff);
}
/** L plane (log2 max channel, 12 stops from 2^-9) full res, chroma r/sum b/sum half res; row-delta, deflate. */
async function decodeLightmap(b64: string, w: number, h: number): Promise<Uint16Array> {
  const z = base64ToBytes(b64);
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([z as Uint8Array<ArrayBuffer>]).stream().pipeThrough(ds);
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  const P = w * h;
  const w2 = w >> 1;
  const P2 = (w >> 1) * (h >> 1);
  if (buf.length !== P + 2 * P2) throw new Error('lightmap size');
  for (let i = w; i < P; i++) buf[i] = (buf[i] + buf[i - w]) & 255;
  for (const o of [P, P + P2]) for (let i = w2; i < P2; i++) buf[o + i] = (buf[o + i] + buf[o + i - w2]) & 255;
  const ml = new Float32Array(256);
  for (let l = 1; l < 256; l++) ml[l] = Math.pow(2, (l / 255) * 12 - 9);
  const out = new Uint16Array(P * 4);
  const one = half(1);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = (y >> 1) * w2 + (x >> 1);
      const cr = buf[P + c] / 255;
      const cb = buf[P + P2 + c] / 255;
      const cg = Math.max(0, 1 - cr - cb);
      const k = ml[buf[i]] / Math.max(cr, cg, cb, 1e-3);
      out[i * 4] = half(cr * k);
      out[i * 4 + 1] = half(cg * k);
      out[i * 4 + 2] = half(cb * k);
      out[i * 4 + 3] = one;
    }
  return out;
}
function lmTexture(data: Uint16Array, w: number, h: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  t.colorSpace = THREE.NoColorSpace;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  t.channel = 1;
  t.needsUpdate = true;
  return t;
}
const flat = (v: number): THREE.DataTexture => {
  const f = half;
  return lmTexture(new Uint16Array([f(v), f(v * 0.92), f(v * 0.82), f(1)]), 1, 1);
};

interface PortalDoor {
  a: number;
  b: number;
  ta: number;
  p: number;
  u0: number;
  u1: number;
  y0: number;
  y1: number;
}

export function createInteriorVisual(layout: InteriorLayout, opts: InteriorOptions): InteriorVisual {
  const q = opts.quality;
  const t0 = performance.now();
  const B = buildInterior(layout);
  const t1 = performance.now();
  // 'high'/'ultra' start on the 1024 atlas and swap the 2048 one in once it is generated in time slices
  const want = surfaceSize(q);
  let atlas = acquireSurfaceAtlas(Math.min(want, 512));
  let upgrade = want > atlas.size ? acquireSurfaceAtlasProgressive(want) : null;
  let photoState = 'photo pending';
  const status = (): string =>
    `build ${(t1 - t0).toFixed(0)} ms · atlas ${atlas.size} ${atlas.genMs.toFixed(0)} ms${upgrade ? ' (upgrading)' : ''} · bake ${INTERIOR_BAKE.key === B.key ? 'fresh' : 'STALE'} · ${photoState}`;
  const shared = createSurfaceShared(q);
  (globalThis as { __tlInterior?: string }).__tlInterior = status();
  if (shared.photo) {
    const ph = shared.photo;
    void ph.ready.then((ok) => {
      photoState = ok ? `photo ${(ph.bytes / 1048576).toFixed(1)} MB ${ph.decodeMs.toFixed(0)} ms${ph.failed.length ? ` (${ph.failed.length} failed)` : ''}` : 'photo off';
      (globalThis as { __tlInterior?: string }).__tlInterior = status();
    });
  } else photoState = 'photo off';
  const env = createReflectionCube(true);
  let lmA: THREE.DataTexture = flat(0.55);
  let lmB: THREE.DataTexture = flat(0.06);
  shared.uLmB.value = lmB;
  const main = surfaceMaterial(atlas, shared, 'main', { lightMap: lmA, envMap: env });
  const cut = surfaceMaterial(atlas, shared, 'cut', { lightMap: lmA, envMap: env });
  const glowM = surfaceMaterial(atlas, shared, 'glow', { lightMap: lmA, envMap: env });
  const glassK = { value: 1 };
  const glass = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.04, metalness: 0, envMap: env, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  glass.onBeforeCompile = (sh) => {
    sh.uniforms.uGlassK = glassK;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uGlassK;')
      .replace('#include <lights_fragment_maps>', '#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )\n radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness ) * uGlassK;\n#endif');
  };
  glass.customProgramCacheKey = () => 'corvane-glass';
  const mats: Record<Kind, THREE.Material> = { main, cut, glow: glowM, glass };
  const lmMats = [main, cut, glowM];

  const root = new THREE.Group();
  root.name = 'interior';
  const rooms: Record<string, THREE.Group> = {};
  const roomMeshes: THREE.Mesh[][] = [];
  const roomTris: number[] = [];
  const geos: THREE.BufferGeometry[] = [];
  const dropDetail = q === 'low';
  B.rooms.forEach((id, ri) => {
    const g = new THREE.Group();
    g.name = `room:${id}`;
    g.userData.room = id;
    rooms[id] = g;
    root.add(g);
    roomMeshes.push([]);
    roomTris.push(0);
    for (const kind of ['main', 'glow', 'cut', 'glass'] as Kind[]) {
      const parts = B.buckets.filter((bk) => bk.room === ri && bk.kind === kind && !(dropDetail && bk.detail));
      const nv = parts.reduce((s, p) => s + p.pos.length / 3, 0);
      if (!nv) continue;
      const pos = new Float32Array(nv * 3);
      const nor = new Float32Array(nv * 3);
      const uv = new Float32Array(nv * 2);
      const uv1 = new Float32Array(nv * 2);
      const tile = new Float32Array(nv);
      const col = new Float32Array(nv * 3);
      const ni = parts.reduce((s, p) => s + p.idx.length, 0);
      const index = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
      let vo = 0;
      let io = 0;
      for (const p of parts) {
        pos.set(p.pos, vo * 3);
        nor.set(p.nor, vo * 3);
        uv.set(p.uv, vo * 2);
        uv1.set(p.uv1, vo * 2);
        tile.set(p.tile, vo);
        col.set(p.col, vo * 3);
        for (let k = 0; k < p.idx.length; k++) index[io + k] = p.idx[k] + vo;
        vo += p.pos.length / 3;
        io += p.idx.length;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      if (kind !== 'glass') {
        geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        geo.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
        geo.setAttribute('tile', new THREE.BufferAttribute(tile, 1));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      }
      geo.setIndex(new THREE.BufferAttribute(index, 1));
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      geos.push(geo);
      const mesh = new THREE.Mesh(geo, mats[kind]);
      mesh.name = `${id}:${kind}`;
      mesh.userData.room = id;
      mesh.castShadow = kind === 'main' || kind === 'glow';
      mesh.receiveShadow = kind !== 'glass';
      mesh.renderOrder = kind === 'glass' ? 2 : 0;
      // the ray tracer's material record (surfaces.ts header); glass: clear, smooth dielectric
      mesh.userData.rt =
        kind === 'glass'
          ? { albedo: [0, 0, 0], roughness: 0.04, metalness: 0, tiles: null, perVertex: null, demodulate: null, glass: true }
          : kind === 'glow'
            ? { ...surfaceRtRecord(geo, atlas, shared), emissive: true }
            : surfaceRtRecord(geo, atlas, shared);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      g.add(mesh);
      roomMeshes[ri].push(mesh);
      roomTris[ri] += ni / 3;
    }
  });

  // ---- the bake ----
  const bake = INTERIOR_BAKE;
  const fresh = bake.key === B.key && bake.a.length > 0 && typeof DecompressionStream !== 'undefined';
  const ready: Promise<boolean> = fresh
    ? Promise.all([decodeLightmap(bake.a, bake.w, bake.h), decodeLightmap(bake.b, bake.w, bake.h)])
        .then(([a, bb]) => {
          if (disposed) return false;
          const na = lmTexture(a, bake.w, bake.h);
          const nb = lmTexture(bb, bake.w, bake.h);
          // needsUpdate: the per-probe clones of these materials (src/render/probes.ts) follow a version change
          for (const m of lmMats) {
            m.lightMap = na;
            m.needsUpdate = true;
          }
          shared.uLmB.value = nb;
          lmA.dispose();
          lmB.dispose();
          lmA = na;
          lmB = nb;
          return true;
        })
        .catch(() => false)
    : Promise.resolve(false);
  if (!fresh && bake.key !== B.key && typeof console !== 'undefined') console.warn(`[interior] lightmap bake is stale (${bake.key || 'none'} vs ${B.key}); run: node tools/bake-interior.mjs`);

  // ---- portals for room culling ----
  const portals: PortalDoor[] = layout.doors.map((d) => {
    const lo = [d.box.min.x, d.box.min.y, d.box.min.z];
    const hi = [d.box.max.x, d.box.max.y, d.box.max.z];
    const ta = hi[0] - lo[0] < hi[2] - lo[2] ? 0 : 2;
    const ua = 2 - ta;
    return { a: B.rooms.indexOf(d.a), b: B.rooms.indexOf(d.b), ta, p: (lo[ta] + hi[ta]) / 2, u0: lo[ua], u1: hi[ua], y0: lo[1], y1: hi[1] };
  });
  const vis = new Uint8Array(B.rooms.length);
  const chain: number[] = [0, 0, 0, 0, 0, 0];
  const visibleRooms = new Set<string>();
  const ex = [0, 0, 0];
  const pp = [0, 0, 0];
  const through = (pd: PortalDoor, px: number, py: number, pz: number): boolean => {
    pp[0] = px;
    pp[1] = py;
    pp[2] = pz;
    const den = pp[pd.ta] - ex[pd.ta];
    if (Math.abs(den) < 1e-6) return false;
    const t = (pd.p - ex[pd.ta]) / den;
    if (t < -0.02 || t > 1.02) return false;
    const ua = 2 - pd.ta;
    const u = ex[ua] + (pp[ua] - ex[ua]) * t;
    const y = ex[1] + (pp[1] - ex[1]) * t;
    return u > pd.u0 - 0.05 && u < pd.u1 + 0.05 && y > pd.y0 - 0.05 && y < pd.y1 + 0.05;
  };
  const sp = [0, 0, 0];
  const sample = (pd: PortalDoor, k: number): void => {
    const ua = 2 - pd.ta;
    const fu = k === 0 ? 0.5 : k === 1 || k === 3 ? 0.08 : 0.92;
    const fy = k === 0 ? 0.5 : k < 3 ? 0.1 : 0.9;
    sp[pd.ta] = pd.p;
    sp[ua] = pd.u0 + (pd.u1 - pd.u0) * fu;
    sp[1] = pd.y0 + (pd.y1 - pd.y0) * fy;
  };
  const walk = (room: number, depth: number): void => {
    for (let di = 0; di < portals.length; di++) {
      const pd = portals[di];
      if (pd.a !== room && pd.b !== room) continue;
      let used = false;
      for (let c = 0; c < depth; c++) if (chain[c] === di) used = true;
      if (used) continue;
      const other = pd.a === room ? pd.b : pd.a;
      let ok = depth === 0;
      if (!ok)
        for (let k = 0; k < 5 && !ok; k++) {
          sample(pd, k);
          const sx = sp[0];
          const sy = sp[1];
          const sz = sp[2];
          let pass = true;
          for (let c = 0; c < depth && pass; c++) pass = through(portals[chain[c]], sx, sy, sz);
          ok = pass;
        }
      if (!ok) continue;
      vis[other] = 1;
      if (depth < 5) {
        chain[depth] = di;
        walk(other, depth + 1);
      }
    }
  };
  const lastEye = [1e9, 1e9, 1e9];
  let tris = 0;
  let calls = 0;
  const cull = (e: { x: number; y: number; z: number } | undefined): void => {
    if (!e) {
      for (let i = 0; i < vis.length; i++) vis[i] = 1;
    } else {
      if (Math.abs(e.x - lastEye[0]) + Math.abs(e.y - lastEye[1]) + Math.abs(e.z - lastEye[2]) < 0.02) return;
      lastEye[0] = e.x;
      lastEye[1] = e.y;
      lastEye[2] = e.z;
      ex[0] = e.x;
      ex[1] = e.y;
      ex[2] = e.z;
      vis.fill(0);
      let cur = -1;
      let best = 1e9;
      for (let i = 0; i < B.roomBoxes.length; i++) {
        const bb = B.roomBoxes[i];
        const dx = Math.max(bb.min.x - e.x, 0, e.x - bb.max.x);
        const dy = Math.max(bb.min.y - e.y, 0, e.y - bb.max.y);
        const dz = Math.max(bb.min.z - e.z, 0, e.z - bb.max.z);
        const d = dx + dy + dz;
        if (d < best) {
          best = d;
          cur = i;
        }
      }
      if (cur >= 0) {
        vis[cur] = 1;
        walk(cur, 0);
        // standing in a doorway: both sides
        for (const pd of portals) {
          const ua = 2 - pd.ta;
          if (Math.abs(ex[pd.ta] - pd.p) < 0.25 && ex[ua] > pd.u0 - 0.1 && ex[ua] < pd.u1 + 0.1 && (vis[pd.a] || vis[pd.b])) {
            if (!vis[pd.a]) {
              vis[pd.a] = 1;
              walk(pd.a, 0);
            }
            if (!vis[pd.b]) {
              vis[pd.b] = 1;
              walk(pd.b, 0);
            }
          }
        }
      }
    }
    visibleRooms.clear();
    tris = 0;
    calls = 0;
    for (let i = 0; i < B.rooms.length; i++) {
      const id = B.rooms[i];
      const on = vis[i] === 1;
      rooms[id].visible = on;
      if (on) {
        visibleRooms.add(id);
        tris += roomTris[i];
        calls += roomMeshes[i].length;
      }
    }
  };
  cull(undefined);

  let mix = 1;
  let lastT = -1;
  let disposed = false;
  const lmBytes = fresh ? bake.w * bake.h * 8 * 2 : 16;
  return {
    object3d: root,
    get triangles() {
      return tris;
    },
    get drawCalls() {
      return calls;
    },
    rooms,
    visibleRooms,
    get textureBytes() {
      return atlas.bytes + lmBytes + (shared.photo ? shared.photo.bytes : 0);
    },
    ready,
    update(o: InteriorUpdate): void {
      const dt = lastT < 0 ? 1 : clamp(o.time - lastT, 0, 0.5);
      lastT = o.time;
      const target = o.lights ? 1 : 0;
      mix += (target - mix) * (1 - Math.exp(-dt / 0.12));
      if (Math.abs(mix - target) < 0.002) mix = target;
      const gain = o.gain ?? 1;
      shared.uLmMix.value = mix;
      shared.uGain.value = gain;
      for (const m of lmMats) m.lightMapIntensity = Math.PI * gain;
      const blink = Math.sin(o.time * 3.1) > 0.2 ? 1 : 0.15;
      shared.uGlow.value.set(mix, 1, 0.3 + 0.7 * (1 - mix), blink);
      glassK.value = gain * (0.25 + 0.75 * mix) * 0.6;
      cull(o.eye);
      if (upgrade) {
        const next = upgrade.step(5);
        if (next) {
          upgrade = null;
          for (const m of lmMats) {
            m.map = next.map;
            m.normalMap = next.normalMap;
            m.roughnessMap = next.ormMap;
            m.metalnessMap = next.ormMap;
            m.aoMap = next.ormMap;
            m.needsUpdate = true;
          }
          releaseSurfaceAtlas(atlas);
          atlas = next;
          for (const list of roomMeshes)
            for (const mesh of list) {
              const d = (mesh.userData.rt as { demodulate?: { map?: THREE.Texture } } | undefined)?.demodulate;
              if (d) d.map = next.map;
            }
          (globalThis as { __tlInterior?: string }).__tlInterior = status();
        }
      }
    },
    dispose(): void {
      disposed = true;
      for (const g of geos) g.dispose();
      for (const m of Object.values(mats)) m.dispose();
      lmA.dispose();
      lmB.dispose();
      env?.dispose();
      if (upgrade) {
        const late = upgrade.step(1e9);
        if (late) releaseSurfaceAtlas(late);
      }
      releaseSurfaceAtlas(atlas);
      releaseSurfaceShared(shared);
      root.removeFromParent();
    },
  };
}
