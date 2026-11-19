// Shared hull-material library for ships and stations.
//
// Geometry built with geo.ts carries its surface finish per vertex (aTint / aSurf / aFx), so a whole model
// needs only five materials, one per channel:
//
//   hull   MeshStandardMaterial + onBeforeCompile "uber" shader: eight tiling finishes (painted panels with
//          seams, rivets and hatches; bolted armour; ceramic tiles; brushed titanium; carbon weave; crinkled
//          foil; radiator fins; corrugated wall) stored as layers of ONE RGBA8 array texture
//          (rg = tangent normal, b = tone, a = cavity / edge mask) plus a macro-noise layer for grime, edge
//          wear, streaks and damage. Livery colours are uniforms (per-vertex slot), so geometry is shared
//          between ships that differ only in paint.
//   glass  MeshPhysicalMaterial, fresnel-weighted opacity
//   glow   opaque emissive: steady lamps, window strips, engine-bell interiors (follow throttle), blinkers,
//          hot radiators
//   flare  additive camera-facing sprites for navigation lights and strobes
//   decal  alpha-blended stencil markings from a procedural atlas (registry glyphs, hazard stripes, logos)
//
// Textures are generated once per (size, seed) and shared by every material set (reference counted).

import * as THREE from 'three';
import type { RGB } from '../../core/types';
import { CH_DECAL, CH_FLARE, CH_GLASS, CH_GLOW, CH_HULL, DECAL_COLS, DECAL_GLYPHS, DECAL_ICONS, DECAL_ROWS, type DecalIcon } from './geo';
import { PHOTO_GLSL, photoConstsGlsl } from './surfaces';
import { acquirePhotoDetail, releasePhotoDetail, type PhotoDetail } from './photo/detail';

export type HullQuality = 'low' | 'medium' | 'high' | 'ultra';

export interface Livery {
  primary: RGB;
  secondary: RGB;
  accent: RGB;
}

export interface HullMaterialCtx {
  time: number;
  throttle: number;
  lightsOn: boolean;
  /** 0..1 hull / radiator heat (aerobraking glow, hot radiators) */
  heat: number;
  /** 0..1 accumulated damage (scorching) */
  damage: number;
}

export interface HullMaterials {
  hull: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  glow: THREE.ShaderMaterial;
  flare: THREE.ShaderMaterial;
  decal: THREE.MeshStandardMaterial;
  /** materials indexed by geo.ts channel (CH_HULL, CH_GLASS, CH_GLOW, CH_FLARE, CH_DECAL) */
  byChannel: THREE.Material[];
  setLivery(l: Livery): void;
  /** Station mode only (no-op otherwise): radiance a fully floodlit white surface re-emits, linear RGB. */
  setFlood(color: RGB): void;
  update(ctx: HullMaterialCtx): void;
  dispose(): void;
}

// ================================================================================================ textures

const sm = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function rng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value noise: `px` x `py` lattice cells across the n x n tile. */
function vnoise(n: number, px: number, py: number, rnd: () => number, out: Float32Array, amp: number): void {
  const g = new Float32Array(px * py);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  for (let y = 0; y < n; y++) {
    const fy = (y / n) * py;
    const y0 = Math.floor(fy);
    let ty = fy - y0;
    ty = ty * ty * (3 - 2 * ty);
    const ya = (y0 % py) * px;
    const yb = ((y0 + 1) % py) * px;
    for (let x = 0; x < n; x++) {
      const fx = (x / n) * px;
      const x0 = Math.floor(fx);
      let tx = fx - x0;
      tx = tx * tx * (3 - 2 * tx);
      const xa = x0 % px;
      const xb = (x0 + 1) % px;
      const a = g[ya + xa] + (g[ya + xb] - g[ya + xa]) * tx;
      const b = g[yb + xa] + (g[yb + xb] - g[yb + xa]) * tx;
      out[y * n + x] += (a + (b - a) * ty - 0.5) * amp;
    }
  }
}

function fbm(n: number, px: number, py: number, oct: number, rnd: () => number, gain = 0.5): Float32Array {
  const out = new Float32Array(n * n);
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < oct && px <= n / 2 && py <= n / 2; o++) {
    vnoise(n, px, py, rnd, out, amp);
    norm += amp * 0.5;
    amp *= gain;
    px *= 2;
    py *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i] / (2 * norm) + 0.5; // ~0..1
  return out;
}

/** Height / tone / mask working buffers of one texture layer. */
class Field {
  readonly h: Float32Array;
  readonly t: Float32Array;
  readonly m: Float32Array;
  readonly k: number;
  constructor(readonly n: number) {
    this.h = new Float32Array(n * n);
    this.t = new Float32Array(n * n).fill(0.5);
    this.m = new Float32Array(n * n).fill(0.5);
    this.k = n - 1;
  }

  /** Raised plate filling [x0,x1) x [y0,y1) with a groove of half-width `gap` around it. */
  plate(x0: number, y0: number, x1: number, y1: number, gap: number, bevel: number, height: number, tone: number, wearW: number): void {
    const { n, h, t, m, k } = this;
    const gb = gap + bevel;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const d = Math.min(x - x0, x1 - 1 - x, y - y0, y1 - 1 - y) + 0.5;
        const i = (y & k) * n + (x & k);
        const g = sm(gap, gb, d);
        h[i] = height * g;
        t[i] = tone;
        m[i] = d < gb ? 0.5 * sm(0, gb, d) : 0.5 + 0.5 * Math.max(0, 1 - (d - gb) / wearW);
      }
    }
  }

  /** Dome (amp > 0) or dimple (amp < 0). */
  bump(cx: number, cy: number, r: number, amp: number, mask = -1): void {
    const { n, h, m, k } = this;
    const R = Math.ceil(r + 1);
    for (let y = Math.floor(cy - R); y <= cy + R; y++) {
      for (let x = Math.floor(cx - R); x <= cx + R; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
        if (d >= 1.25) continue;
        const i = (y & k) * n + (x & k);
        if (d < 1) {
          h[i] += amp * Math.sqrt(1 - d * d);
          if (mask >= 0) m[i] = mask;
        } else if (mask >= 0) m[i] = Math.min(m[i], 0.25);
      }
    }
  }

  /** Groove (depth > 0) or ridge (depth < 0) along a segment. */
  line(x0: number, y0: number, x1: number, y1: number, w: number, depth: number, mask = -1): void {
    const { n, h, m, k } = this;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const ll = dx * dx + dy * dy || 1;
    const R = Math.ceil(w + 1);
    for (let y = Math.floor(Math.min(y0, y1) - R); y <= Math.max(y0, y1) + R; y++) {
      for (let x = Math.floor(Math.min(x0, x1) - R); x <= Math.max(x0, x1) + R; x++) {
        const px = x + 0.5 - x0;
        const py = y + 0.5 - y0;
        const s = Math.min(1, Math.max(0, (px * dx + py * dy) / ll));
        const d = Math.hypot(px - dx * s, py - dy * s);
        if (d >= w) continue;
        const i = (y & k) * n + (x & k);
        const f = 1 - sm(w * 0.35, w, d);
        h[i] -= depth * f;
        if (mask >= 0) m[i] += (mask - m[i]) * f;
      }
    }
  }

  /** Rounded-rectangle access hatch: outline groove, slightly sunk lid. */
  hatch(x0: number, y0: number, x1: number, y1: number, rad: number, w: number, depth: number, inset: number, tone: number): void {
    const { n, h, t, m, k } = this;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const hx = (x1 - x0) / 2 - rad;
    const hy = (y1 - y0) / 2 - rad;
    for (let y = Math.floor(y0 - w - 1); y <= y1 + w + 1; y++) {
      for (let x = Math.floor(x0 - w - 1); x <= x1 + w + 1; x++) {
        const qx = Math.abs(x + 0.5 - cx) - hx;
        const qy = Math.abs(y + 0.5 - cy) - hy;
        const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad;
        if (sd > w) continue;
        const i = (y & k) * n + (x & k);
        if (sd < 0) {
          h[i] -= inset * sm(0, -w, sd);
          t[i] = tone;
        }
        const a = Math.abs(sd);
        if (a < w) {
          const f = 1 - sm(w * 0.3, w, a);
          h[i] -= depth * f;
          m[i] += (0.05 - m[i]) * f;
        } else if (sd < 0 && sd > -w * 4) m[i] = Math.max(m[i], 0.5 + 0.45 * (1 + (sd + w) / (w * 3)));
      }
    }
  }
}

function bsp(x0: number, y0: number, x1: number, y1: number, minS: number, maxS: number, rnd: () => number, out: number[][]): void {
  const w = x1 - x0;
  const h = y1 - y0;
  const canX = w >= minS * 2;
  const canY = h >= minS * 2;
  if ((!canX && !canY) || (w <= maxS && h <= maxS && rnd() < 0.55)) {
    out.push([x0, y0, x1, y1]);
    return;
  }
  const splitX = canX && (!canY || (w > h * 1.15 ? rnd() < 0.9 : w * 1.15 < h ? rnd() < 0.1 : rnd() < 0.5));
  if (splitX) {
    const s = Math.round(x0 + minS + (w - 2 * minS) * rnd());
    bsp(x0, y0, s, y1, minS, maxS, rnd, out);
    bsp(s, y0, x1, y1, minS, maxS, rnd, out);
  } else {
    const s = Math.round(y0 + minS + (h - 2 * minS) * rnd());
    bsp(x0, y0, x1, s, minS, maxS, rnd, out);
    bsp(x0, s, x1, y1, minS, maxS, rnd, out);
  }
}

/** Number of finish layers + the macro-noise layer. */
const LAYERS = 9;

function encode(F: Field, strength: number, layer: number, out: Uint8Array): void {
  const { n, h, t, m, k } = F;
  const base = layer * n * n * 4;
  for (let y = 0; y < n; y++) {
    const ym = ((y - 1) & k) * n;
    const yp = ((y + 1) & k) * n;
    for (let x = 0; x < n; x++) {
      const dx = (h[y * n + ((x + 1) & k)] - h[y * n + ((x - 1) & k)]) * 0.5 * strength;
      const dy = (h[yp + x] - h[ym + x]) * 0.5 * strength;
      const il = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const o = base + (y * n + x) * 4;
      out[o] = Math.round(255 * (0.5 - 0.5 * dx * il));
      out[o + 1] = Math.round(255 * (0.5 - 0.5 * dy * il));
      out[o + 2] = Math.round(255 * Math.min(1, Math.max(0, t[y * n + x])));
      out[o + 3] = Math.round(255 * Math.min(1, Math.max(0, m[y * n + x])));
    }
  }
}

function generateHullArray(n: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n * n * 4 * LAYERS);
  const s = n / 512;
  const rnd = rng(seed * 7919 + 13);
  const grain = fbm(n, 64, 64, 2, rnd);
  const soft = fbm(n, 6, 6, 4, rnd);

  // ---- 0 painted aerospace panels: irregular seams, rivet rows, hatches, louvres
  {
    const F = new Field(n);
    const rects: number[][] = [];
    bsp(0, 0, n, n, 46 * s, 150 * s, rnd, rects);
    for (const r of rects) F.plate(r[0], r[1], r[2], r[3], 1.0 * s, 1.5 * s, 1 + (rnd() - 0.5) * 0.1, 0.5 + (rnd() - 0.5) * 0.3, 5 * s);
    for (const r of rects) {
      const w = r[2] - r[0];
      const hh = r[3] - r[1];
      const kind = rnd();
      if (kind < 0.5 && Math.min(w, hh) > 40 * s) {
        // rivet rows
        const ins = 5.5 * s;
        const nx = Math.max(2, Math.round((w - 2 * ins) / (11 * s)));
        const ny = Math.max(2, Math.round((hh - 2 * ins) / (11 * s)));
        for (let i = 0; i <= nx; i++) {
          const x = r[0] + ins + ((w - 2 * ins) * i) / nx;
          F.bump(x, r[1] + ins, 1.25 * s, 0.42, 0.72);
          F.bump(x, r[3] - ins, 1.25 * s, 0.42, 0.72);
        }
        for (let i = 1; i < ny; i++) {
          const y = r[1] + ins + ((hh - 2 * ins) * i) / ny;
          F.bump(r[0] + ins, y, 1.25 * s, 0.42, 0.72);
          F.bump(r[2] - ins, y, 1.25 * s, 0.42, 0.72);
        }
      } else if (kind < 0.68 && w > 64 * s && hh > 64 * s) {
        // access hatch with four fasteners
        const mx = (0.16 + rnd() * 0.12) * w;
        const my = (0.16 + rnd() * 0.12) * hh;
        const a = [r[0] + mx, r[1] + my, r[2] - mx, r[3] - my];
        F.hatch(a[0], a[1], a[2], a[3], 6 * s, 1.5 * s, 0.9, 0.12, 0.5 + (rnd() - 0.5) * 0.25);
        for (let q = 0; q < 4; q++) F.bump(q & 1 ? a[2] - 7 * s : a[0] + 7 * s, q & 2 ? a[3] - 7 * s : a[1] + 7 * s, 1.8 * s, -0.5, 0.2);
      } else if (kind < 0.76 && w > 50 * s && hh > 50 * s) {
        // louvre slots
        const cnt = Math.max(3, Math.floor((hh * 0.5) / (7 * s)));
        const y0 = (r[1] + r[3]) / 2 - (cnt - 1) * 3.5 * s;
        for (let q = 0; q < cnt; q++) F.line(r[0] + w * 0.22, y0 + q * 7 * s, r[2] - w * 0.22, y0 + q * 7 * s, 2.2 * s, 1.1, 0.02);
      } else if (kind > 0.93) {
        // single inspection port
        F.bump(r[0] + w * (0.3 + 0.4 * rnd()), r[1] + hh * (0.3 + 0.4 * rnd()), 4.5 * s, -0.6, 0.15);
      }
    }
    for (let i = 0; i < n * n; i++) {
      F.h[i] += (grain[i] - 0.5) * 0.05;
      F.t[i] += (soft[i] - 0.5) * 0.16 + (grain[i] - 0.5) * 0.05;
    }
    encode(F, 1.5 * s, 0, out);
  }

  // ---- 1 bolted armour plate
  {
    const F = new Field(n);
    const rects: number[][] = [];
    bsp(0, 0, n, n, 120 * s, 300 * s, rnd, rects);
    for (const r of rects) {
      F.plate(r[0], r[1], r[2], r[3], 2.2 * s, 4.5 * s, 1 + (rnd() - 0.5) * 0.5, 0.5 + (rnd() - 0.5) * 0.3, 9 * s);
      const ins = 13 * s;
      const w = r[2] - r[0];
      const hh = r[3] - r[1];
      const nx = Math.max(1, Math.round((w - 2 * ins) / (60 * s)));
      const ny = Math.max(1, Math.round((hh - 2 * ins) / (60 * s)));
      for (let i = 0; i <= nx; i++) {
        for (let j = 0; j <= ny; j++) {
          if (i > 0 && i < nx && j > 0 && j < ny) continue;
          const bx = r[0] + ins + ((w - 2 * ins) * i) / nx;
          const by = r[1] + ins + ((hh - 2 * ins) * j) / ny;
          F.bump(bx, by, 3.6 * s, 0.75, 0.85);
          F.bump(bx, by, 1.5 * s, -0.35);
        }
      }
    }
    for (let q = 0; q < 26; q++) {
      const x = rnd() * n;
      const y = rnd() * n;
      const a = rnd() * 6.283;
      const l = (10 + rnd() * 50) * s;
      F.line(x, y, x + Math.cos(a) * l, y + Math.sin(a) * l, 1.1 * s, 0.22, 0.85);
    }
    for (let i = 0; i < n * n; i++) {
      F.h[i] += (grain[i] - 0.5) * 0.12 + (soft[i] - 0.5) * 0.2;
      F.t[i] += (soft[i] - 0.5) * 0.25 + (grain[i] - 0.5) * 0.08;
    }
    encode(F, 1.7 * s, 1, out);
  }

  // ---- 2 ceramic heat tiles (staggered)
  {
    const F = new Field(n);
    const cols = 6;
    const cw = n / cols;
    for (let j = 0; j < cols; j++) {
      const off = j & 1 ? cw / 2 : 0;
      for (let i = 0; i < cols; i++) {
        const r = rnd();
        const tone = r > 0.93 ? 0.85 : r < 0.06 ? 0.2 : 0.5 + (rnd() - 0.5) * 0.22;
        F.plate(Math.round(i * cw + off), Math.round(j * cw), Math.round((i + 1) * cw + off), Math.round((j + 1) * cw), 0.9 * s, 1.6 * s, 1 + (rnd() - 0.5) * 0.25, tone, 3 * s);
      }
    }
    for (let i = 0; i < n * n; i++) {
      F.h[i] += (grain[i] - 0.5) * 0.16;
      F.t[i] += (grain[i] - 0.5) * 0.1;
    }
    encode(F, 1.4 * s, 2, out);
  }

  // ---- 3 brushed bare metal with sparse seams
  {
    const F = new Field(n);
    const brush = fbm(n, 4, 128, 2, rnd, 0.6);
    const rects: number[][] = [];
    bsp(0, 0, n, n, 160 * s, 300 * s, rnd, rects);
    for (const r of rects) F.plate(r[0], r[1], r[2], r[3], 0.8 * s, 1.3 * s, 1, 0.5 + (rnd() - 0.5) * 0.2, 3 * s);
    for (const r of rects) {
      if (rnd() < 0.6) {
        const ins = 7 * s;
        const cnt = Math.max(2, Math.round((r[2] - r[0] - 2 * ins) / (18 * s)));
        for (let i = 0; i <= cnt; i++) F.bump(r[0] + ins + ((r[2] - r[0] - 2 * ins) * i) / cnt, r[1] + ins, 1.4 * s, -0.4, 0.2);
      }
    }
    for (let i = 0; i < n * n; i++) {
      F.h[i] += (brush[i] - 0.5) * 0.22;
      F.t[i] += (brush[i] - 0.5) * 0.3 + (soft[i] - 0.5) * 0.25;
      F.m[i] += (brush[i] - 0.5) * 0.15;
    }
    encode(F, 1.3 * s, 3, out);
  }

  // ---- 4 carbon composite, 2/2 twill
  {
    const F = new Field(n);
    const c = 8 * s;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const cx = Math.floor(x / c);
        const cy = Math.floor(y / c);
        const fx = (x + 0.5) / c - cx;
        const fy = (y + 0.5) / c - cy;
        const warp = ((cx + cy) & 3) < 2;
        const prof = warp ? Math.sin(fx * Math.PI) : Math.sin(fy * Math.PI);
        const i = y * n + x;
        F.h[i] = 0.45 * Math.sqrt(Math.max(0, prof)) + (grain[i] - 0.5) * 0.06;
        F.t[i] = (warp ? 0.62 : 0.4) + (grain[i] - 0.5) * 0.08;
        F.m[i] = 0.3 + 0.3 * prof;
      }
    }
    encode(F, 1.2 * s, 4, out);
  }

  // ---- 5 crinkled insulation foil with quilting
  {
    const F = new Field(n);
    const a = fbm(n, 7, 7, 5, rnd, 0.62);
    const b = fbm(n, 11, 11, 4, rnd, 0.6);
    for (let i = 0; i < n * n; i++) {
      const r1 = 1 - Math.abs(a[i] * 2 - 1);
      const r2 = 1 - Math.abs(b[i] * 2 - 1);
      F.h[i] = r1 * r1 * 1.5 + r2 * r2 * 0.9;
      F.t[i] = 0.3 + 0.5 * a[i];
      F.m[i] = 0.35 + 0.4 * r1;
    }
    const q = n / 4;
    for (let i = 0; i < 4; i++) {
      F.line(i * q, 0, i * q, n, 2.2 * s, 1.0, 0.1);
      F.line(0, i * q, n, i * q, 2.2 * s, 1.0, 0.1);
      for (let j = 0; j < 16; j++) {
        F.bump(i * q, (j + 0.5) * (n / 16), 1.6 * s, 0.5);
        F.bump((j + 0.5) * (n / 16), i * q, 1.6 * s, 0.5);
      }
    }
    encode(F, 1.25 * s, 5, out);
  }

  // ---- 6 radiator: fins along v, headers across
  {
    const F = new Field(n);
    const fins = 32;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const f = ((x + 0.5) / n) * fins;
        const p = Math.abs(f - Math.floor(f) - 0.5) * 2; // 0 at fin centre .. 1 between
        const i = y * n + x;
        F.h[i] = 1 - sm(0.25, 0.8, p);
        F.t[i] = 0.42 + 0.2 * (1 - p) + (soft[i] - 0.5) * 0.2;
        F.m[i] = 0.5 - 0.42 * sm(0.4, 0.95, p);
      }
    }
    for (let j = 0; j < 2; j++) {
      const y0 = Math.round((j + 0.5) * (n / 2) - 7 * s);
      F.plate(0, y0, n, Math.round(y0 + 14 * s), 0, 2 * s, 1.5, 0.55, 3 * s);
      for (let i = 0; i < 8; i++) F.bump((i + 0.5) * (n / 8), y0 + 7 * s, 2 * s, 0.5, 0.8);
    }
    encode(F, 1.6 * s, 6, out);
  }

  // ---- 7 corrugated wall (ribs run along v) with frame rails
  {
    const F = new Field(n);
    const ribs = 8;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const f = ((x + 0.5) / n) * ribs;
        const p = Math.abs(f - Math.floor(f) - 0.5) * 2;
        const i = y * n + x;
        F.h[i] = 2.2 * (1 - sm(0.42, 0.72, p)) + (grain[i] - 0.5) * 0.08;
        F.t[i] = 0.5 + (soft[i] - 0.5) * 0.3 + (grain[i] - 0.5) * 0.06;
        F.m[i] = 0.5 - 0.35 * sm(0.5, 0.9, p) + 0.35 * sm(0.5, 0.36, p) * sm(0.2, 0.36, p);
      }
    }
    const y0 = Math.round(n - 10 * s);
    F.plate(0, y0, n, n, 0, 2.5 * s, 3.0, 0.5, 3 * s);
    F.plate(0, 0, n, Math.round(10 * s), 0, 2.5 * s, 3.0, 0.5, 3 * s);
    encode(F, 1.1 * s, 7, out);
  }

  // ---- 8 macro noise: r clouds, g vertical streaks, b fine grain, a blotches
  {
    const clouds = fbm(n, 4, 4, 6, rnd, 0.55);
    const streak = fbm(n, 48, 3, 3, rnd, 0.55);
    const blot = fbm(n, 9, 9, 5, rnd, 0.6);
    const fine = fbm(n, 128, 128, 1, rnd);
    const base = 8 * n * n * 4;
    for (let i = 0; i < n * n; i++) {
      out[base + i * 4] = Math.round(255 * Math.min(1, Math.max(0, (clouds[i] - 0.5) * 1.9 + 0.5)));
      out[base + i * 4 + 1] = Math.round(255 * Math.min(1, Math.max(0, (streak[i] - 0.5) * 2.2 + 0.5)));
      out[base + i * 4 + 2] = Math.round(255 * Math.min(1, Math.max(0, (fine[i] - 0.5) * 1.6 + 0.5)));
      out[base + i * 4 + 3] = Math.round(255 * Math.min(1, Math.max(0, (blot[i] - 0.5) * 2.4 + 0.5)));
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ micro detail

/**
 * Hero micro-detail map (one RGBA8 2D texture, tiles every 2 m of hull UV): rg = tangent normal of a fine
 * pressed-panel pattern (shallow stamped beads, fastener dimples) plus micro-scratches and grain; b = roughness /
 * albedo modulation (scratches polish, smudges dull); a = 0.5 (unused). Sampled on top of the tiling finish by
 * hulls that ask for it (the player's Wren), so close-ups hold up without a bigger array texture.
 */
function generateMicro(n: number, seed: number): Uint8Array<ArrayBuffer> {
  const s = n / 1024;
  const rnd = rng(seed * 4481 + 71);
  const F = new Field(n);
  const grain = fbm(n, 256, 256, 1, rnd);
  const smudge = fbm(n, 6, 6, 4, rnd, 0.55);
  // pressed panels: stamped rectangles with a soft bead round them, a few fastener dimples at the corners
  const rects: number[][] = [];
  bsp(0, 0, n, n, 150 * s, 420 * s, rnd, rects);
  for (const r of rects) {
    const ins = 10 * s;
    F.hatch(r[0] + ins, r[1] + ins, r[2] - ins, r[3] - ins, 18 * s, 4 * s, 0.35, -0.12, 0.5);
    if (rnd() < 0.6) for (let q = 0; q < 4; q++) F.bump(q & 1 ? r[2] - ins - 9 * s : r[0] + ins + 9 * s, q & 2 ? r[3] - ins - 9 * s : r[1] + ins + 9 * s, 3.2 * s, -0.35, 0.3);
  }
  for (let i = 0; i < n * n; i++) {
    F.h[i] += (grain[i] - 0.5) * 0.05;
    F.t[i] = 0.5 + (smudge[i] - 0.5) * 0.5;
  }
  // micro-scratches: short straight hairlines, mostly along one direction (wiping, handling), some random
  const cnt = Math.round(2600 * s * s);
  for (let i = 0; i < cnt; i++) {
    const x = rnd() * n;
    const y = rnd() * n;
    const a = rnd() < 0.7 ? 0.35 + (rnd() - 0.5) * 0.5 : rnd() * Math.PI;
    const len = (8 + rnd() * rnd() * 110) * s;
    const x1 = x + Math.cos(a) * len;
    const y1 = y + Math.sin(a) * len;
    F.line(x, y, x1, y1, Math.max(0.9, 1.1 * s), 0.05);
    // polish along the scratch (tone up = smoother, brighter)
    const steps = Math.ceil(len);
    for (let k = 0; k <= steps; k++) {
      const px = Math.round(x + ((x1 - x) * k) / steps) & (n - 1);
      const py = Math.round(y + ((y1 - y) * k) / steps) & (n - 1);
      const j = py * n + px;
      F.t[j] = Math.min(1, F.t[j] + 0.28);
    }
  }
  const out = new Uint8Array(n * n * 4);
  encode(F, 1.0 * s + 0.6, 0, out);
  for (let i = 0; i < n * n; i++) out[i * 4 + 3] = 128;
  return out;
}

// ------------------------------------------------------------------------------------------------ decal atlas

// Stroke font on a 4 x 6 grid (y down). Each glyph: strokes separated by spaces, points as digit pairs.
const STROKES: Record<string, string> = {
  A: '0601204146 0343', B: '06003041423303 3344453606', C: '4130100105163645', D: '06003041453606', E: '40000646 0333',
  F: '400006 0333', G: '41301001051636454323', H: '0006 4046 0343', I: '1030 2026 1636', J: '4045361605', K: '0006 400346',
  L: '000646', M: '0600234046', N: '06004640', O: '103041453616050110', P: '06003041423303', Q: '103041453616050110 2446',
  R: '06003041423303 2346', S: '413010010213334445361605', T: '0040 2026', U: '000516364540', V: '002640', W: '0016233640',
  X: '0046 4006', Y: '002340 2326', Z: '00400646', '0': '103041453616050110 1531', '1': '112026 1636', '2': '01103041420646',
  '3': '01103041423313 334445361605', '4': '300444 3036', '5': '400003334445361605', '6': '4130100105163645443303', '7': '004026',
  '8': '103041423313020110 1304051636454433', '9': '0516364541301001021343', '-': '0343', '.': '2526', '/': '0640',
};
const STENCIL_CUT = 'ABDOPQR0689CGSU235';

function drawGlyph(g: CanvasRenderingContext2D, ch: string, x: number, y: number, unit: number, weight = 0.92): void {
  const def = STROKES[ch];
  if (!def) return;
  g.lineWidth = unit * weight;
  g.lineCap = 'butt';
  g.lineJoin = 'round';
  for (const st of def.split(' ')) {
    g.beginPath();
    for (let i = 0; i < st.length; i += 2) {
      const px = x + Number(st[i]) * unit;
      const py = y + Number(st[i + 1]) * unit;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    if (st.length === 4 && st.slice(0, 2) === st.slice(2)) g.lineTo(x + Number(st[0]) * unit + 0.01, y + Number(st[1]) * unit);
    g.stroke();
  }
  if (STENCIL_CUT.includes(ch)) g.clearRect(x + 2 * unit - unit * 0.16, y - unit, unit * 0.32, unit * 8);
}

function drawText(g: CanvasRenderingContext2D, text: string, cx: number, cy: number, unit: number): void {
  const adv = unit * 5.6;
  let x = cx - (adv * (text.length - 1)) / 2 - unit * 2;
  for (const ch of text) {
    if (ch !== ' ') drawGlyph(g, ch, x, cy - unit * 3, unit);
    x += adv;
  }
}

function generateDecalAtlas(cell: number, seed: number): THREE.DataTexture {
  const W = cell * DECAL_COLS;
  const H = cell * DECAL_ROWS;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  const c = cell;
  // glyphs
  for (let i = 0; i < DECAL_GLYPHS.length; i++) {
    const unit = (c * 0.74) / 6;
    drawGlyph(g, DECAL_GLYPHS[i], (i % DECAL_COLS) * c + c / 2 - unit * 2, Math.floor(i / DECAL_COLS) * c + c * 0.13, unit);
  }
  const icon = (name: DecalIcon, fn: (x: number, y: number, w: number, h: number) => void): void => {
    const d = DECAL_ICONS[name];
    g.save();
    g.beginPath();
    g.rect(d[0] * c, d[1] * c, d[2] * c, d[3] * c);
    g.clip();
    fn(d[0] * c, d[1] * c, d[2] * c, d[3] * c);
    g.restore();
  };
  const poly = (pts: number[]): void => {
    g.beginPath();
    for (let i = 0; i < pts.length; i += 2) (i ? g.lineTo(pts[i], pts[i + 1]) : g.moveTo(pts[i], pts[i + 1]));
    g.closePath();
    g.fill();
  };
  icon('solid', (x, y, w, h) => g.fillRect(x, y, w, h));
  icon('hazard', (x, y, w, h) => {
    const p = h * 0.5;
    for (let k = -2; k < (w / p) * 0.5 + 2; k++) poly([x + k * 2 * p, y + h, x + k * 2 * p + p, y + h, x + k * 2 * p + p + h, y, x + k * 2 * p + h, y]);
  });
  icon('arrow', (x, y, w, h) => {
    poly([x + w * 0.5, y + h * 0.08, x + w * 0.9, y + h * 0.5, x + w * 0.64, y + h * 0.5, x + w * 0.64, y + h * 0.92, x + w * 0.36, y + h * 0.92, x + w * 0.36, y + h * 0.5, x + w * 0.1, y + h * 0.5]);
  });
  icon('chevrons', (x, y, w, h) => {
    for (let k = 0; k < 4; k++) {
      const o = x + w * (0.06 + k * 0.23);
      poly([o, y + h * 0.12, o + w * 0.1, y + h * 0.12, o + w * 0.2, y + h * 0.5, o + w * 0.1, y + h * 0.88, o, y + h * 0.88, o + w * 0.1, y + h * 0.5]);
    }
  });
  icon('roundel', (x, y, w, h) => {
    g.lineWidth = w * 0.12;
    g.beginPath();
    g.arc(x + w / 2, y + h / 2, w * 0.36, 0, 6.2832);
    g.stroke();
    g.beginPath();
    g.arc(x + w / 2, y + h / 2, w * 0.14, 0, 6.2832);
    g.fill();
  });
  const frame = (x: number, y: number, w: number, h: number, lw: number): void => {
    g.lineWidth = lw;
    g.strokeRect(x + lw * 1.2, y + lw * 1.2, w - lw * 2.4, h - lw * 2.4);
  };
  icon('noStep', (x, y, w, h) => {
    frame(x, y, w, h, h * 0.06);
    drawText(g, 'NO STEP', x + w / 2, y + h / 2, h * 0.075);
  });
  icon('rescue', (x, y, w, h) => {
    frame(x, y, w, h, h * 0.06);
    drawText(g, 'RESCUE', x + w * 0.42, y + h / 2, h * 0.075);
    poly([x + w * 0.8, y + h * 0.3, x + w * 0.92, y + h * 0.5, x + w * 0.8, y + h * 0.7]);
  });
  icon('frame', (x, y, w, h) => {
    const l = h * 0.07;
    const m = h * 0.1;
    const q = h * 0.3;
    g.fillRect(x + m, y + m, q, l);
    g.fillRect(x + m, y + m, l, q);
    g.fillRect(x + w - m - q, y + m, q, l);
    g.fillRect(x + w - m - l, y + m, l, q);
    g.fillRect(x + m, y + h - m - l, q, l);
    g.fillRect(x + m, y + h - m - q, l, q);
    g.fillRect(x + w - m - q, y + h - m - l, q, l);
    g.fillRect(x + w - m - l, y + h - m - q, l, q);
  });
  icon('tick', (x, y, w, h) => g.fillRect(x + w * 0.42, y + h * 0.1, w * 0.16, h * 0.8));
  icon('cross', (x, y, w, h) => {
    g.fillRect(x + w * 0.42, y + h * 0.1, w * 0.16, h * 0.8);
    g.fillRect(x + w * 0.1, y + h * 0.42, w * 0.8, h * 0.16);
  });
  icon('logoCorvane', (x, y, w, h) => {
    // swept double wing
    poly([x + w * 0.08, y + h * 0.3, x + w * 0.5, y + h * 0.52, x + w * 0.92, y + h * 0.3, x + w * 0.92, y + h * 0.44, x + w * 0.5, y + h * 0.7, x + w * 0.08, y + h * 0.44]);
    poly([x + w * 0.26, y + h * 0.62, x + w * 0.5, y + h * 0.76, x + w * 0.74, y + h * 0.62, x + w * 0.74, y + h * 0.72, x + w * 0.5, y + h * 0.88, x + w * 0.26, y + h * 0.72]);
    g.beginPath();
    g.arc(x + w * 0.5, y + h * 0.25, w * 0.07, 0, 6.2832);
    g.fill();
  });
  icon('logoIlmarin', (x, y, w, h) => {
    g.lineWidth = w * 0.07;
    g.beginPath();
    g.arc(x + w / 2, y + h / 2, w * 0.38, 0.5, 5.78);
    g.stroke();
    for (let k = 0; k < 3; k++) g.fillRect(x + w * 0.36, y + h * (0.34 + k * 0.13), w * (0.54 - k * 0.08), h * 0.06);
  });
  icon('logoHadley', (x, y, w, h) => {
    g.lineWidth = w * 0.07;
    g.beginPath();
    for (let k = 0; k <= 6; k++) {
      const a = (k / 6) * 6.2832 + 0.5236;
      const px = x + w / 2 + Math.cos(a) * w * 0.4;
      const py = y + h / 2 + Math.sin(a) * h * 0.4;
      if (k) g.lineTo(px, py);
      else g.moveTo(px, py);
    }
    g.closePath();
    g.stroke();
    g.fillRect(x + w * 0.33, y + h * 0.3, w * 0.09, h * 0.4);
    g.fillRect(x + w * 0.58, y + h * 0.3, w * 0.09, h * 0.4);
    g.fillRect(x + w * 0.33, y + h * 0.455, w * 0.34, h * 0.09);
  });
  icon('logoAuric', (x, y, w, h) => {
    poly([x + w * 0.5, y + h * 0.2, x + w * 0.68, y + h * 0.5, x + w * 0.5, y + h * 0.8, x + w * 0.32, y + h * 0.5]);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * 6.2832 + 0.3927;
      g.save();
      g.translate(x + w / 2, y + h / 2);
      g.rotate(a);
      g.fillRect(w * 0.3, -h * 0.025, w * 0.14, h * 0.05);
      g.restore();
    }
  });
  icon('stripeBroken', (x, y, w, h) => {
    let o = x;
    for (let k = 0; k < 7; k++) {
      const l = w * 0.3 * Math.pow(0.62, k);
      g.fillRect(o, y + h * 0.3, l, h * 0.4);
      o += l + w * 0.035;
    }
  });
  icon('dashes', (x, y, w, h) => {
    for (let k = 0; k < 8; k++) g.fillRect(x + (k + 0.15) * (w / 8), y + h * 0.4, (w / 8) * 0.7, h * 0.2);
  });
  icon('dockTarget', (x, y, w, h) => {
    g.lineWidth = w * 0.035;
    for (const r of [0.42, 0.26]) {
      g.beginPath();
      g.arc(x + w / 2, y + h / 2, w * r, 0, 6.2832);
      g.stroke();
    }
    g.fillRect(x + w * 0.04, y + h * 0.485, w * 0.36, h * 0.03);
    g.fillRect(x + w * 0.6, y + h * 0.485, w * 0.36, h * 0.03);
    g.fillRect(x + w * 0.485, y + h * 0.04, w * 0.03, h * 0.36);
    g.fillRect(x + w * 0.485, y + h * 0.6, w * 0.03, h * 0.36);
  });
  icon('panelLabel', (x, y, w, h) => {
    frame(x, y, w, h, h * 0.045);
    const r = rng(seed + 77);
    for (let k = 0; k < 4; k++) {
      let o = x + w * 0.1;
      while (o < x + w * 0.86) {
        const l = w * (0.03 + r() * 0.1);
        g.fillRect(o, y + h * (0.2 + k * 0.17), Math.min(l, x + w * 0.9 - o), h * 0.07);
        o += l + w * 0.025;
      }
    }
  });
  icon('warnTri', (x, y, w, h) => {
    g.lineWidth = w * 0.09;
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(x + w * 0.5, y + h * 0.14);
    g.lineTo(x + w * 0.88, y + h * 0.84);
    g.lineTo(x + w * 0.12, y + h * 0.84);
    g.closePath();
    g.stroke();
    g.fillRect(x + w * 0.46, y + h * 0.4, w * 0.08, h * 0.22);
    g.fillRect(x + w * 0.46, y + h * 0.67, w * 0.08, h * 0.07);
  });
  icon('dot', (x, y, w, h) => {
    g.beginPath();
    g.arc(x + w / 2, y + h / 2, w * 0.4, 0, 6.2832);
    g.fill();
  });
  icon('bigStripe', (x, y, w, h) => {
    poly([x, y + h * 0.18, x + w * 0.8, y + h * 0.18, x + w * 0.96, y + h * 0.66, x, y + h * 0.66]);
    poly([x, y + h * 0.76, x + w * 0.985, y + h * 0.76, x + w, y + h * 0.84, x, y + h * 0.84]);
  });
  icon('scuff', (x, y, w, h) => {
    const r = rng(seed + 5);
    for (let k = 0; k < 90; k++) {
      g.globalAlpha = 0.08 + r() * 0.3;
      const yy = y + h * (0.1 + 0.8 * r());
      const xx = x + w * r() * 0.8;
      g.fillRect(xx, yy, w * (0.04 + r() * 0.25), Math.max(1, h * 0.012 * (0.5 + r())));
    }
    g.globalAlpha = 1;
  });
  icon('soot', (x, y, w, h) => {
    const r = rng(seed + 9);
    for (let k = 0; k < 40; k++) {
      const cx = x + w * (0.05 + 0.3 * r() * r());
      const cy = y + h * (0.3 + 0.4 * r());
      const len = w * (0.3 + 0.6 * r());
      const gr = g.createLinearGradient(cx, 0, cx + len, 0);
      gr.addColorStop(0, `rgba(255,255,255,${0.1 + 0.1 * r()})`);
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.beginPath();
      g.ellipse(cx + len * 0.5, cy, len * 0.5, h * (0.06 + 0.16 * r()), 0, 0, 6.2832);
      g.fill();
    }
    g.fillStyle = '#fff';
  });
  // read back alpha, erode with speckle wear (not the soft icons), flip to v-up
  const img = g.getImageData(0, 0, W, H).data;
  const out = new Uint8Array(W * H);
  const r = rng(seed + 31);
  const softRow0 = 6 * c;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let a = img[(y * W + x) * 4 + 3];
      if (a > 0 && !(y >= softRow0 && x >= 8 * c)) {
        const q = r();
        if (q < 0.035) a = Math.round(a * 0.35);
        else if (q < 0.12) a = Math.round(a * 0.8);
      }
      out[(H - 1 - y) * W + x] = a;
    }
  }
  const tex = new THREE.DataTexture(out, W, H, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------------------------------------------ texture cache

interface TexSet {
  hull: THREE.DataArrayTexture;
  decal: THREE.DataTexture;
  refs: number;
}
interface MicroSet {
  tex: THREE.DataTexture;
  refs: number;
}
const microCache = new Map<string, MicroSet>();
/** hero micro-detail map size by tier (GPU: 4 B/texel + mips: 22 / 5.6 / 1.4 / 1.4 MB) */
export const MICRO_SIZE: Record<HullQuality, number> = { low: 512, medium: 512, high: 1024, ultra: 2048 };

function acquireMicro(quality: HullQuality, seed: number): { key: string; tex: THREE.DataTexture } {
  const key = `${quality}:${seed}`;
  let set = microCache.get(key);
  if (!set) {
    const n = MICRO_SIZE[quality];
    const tex = new THREE.DataTexture(generateMicro(n, seed), n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = TEX_ANISO[quality];
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    set = { tex, refs: 0 };
    microCache.set(key, set);
  }
  set.refs++;
  return { key, tex: set.tex };
}

function releaseMicro(key: string): void {
  const set = microCache.get(key);
  if (!set) return;
  if (--set.refs <= 0) {
    set.tex.dispose();
    microCache.delete(key);
  }
}
const texCache = new Map<string, TexSet>();

const TEX_SIZE: Record<HullQuality, number> = { low: 256, medium: 512, high: 512, ultra: 1024 };
const TEX_ANISO: Record<HullQuality, number> = { low: 1, medium: 2, high: 4, ultra: 8 };

function acquireTextures(quality: HullQuality, seed: number): { key: string; set: TexSet } {
  const key = `${quality}:${seed}`;
  let set = texCache.get(key);
  if (!set) {
    const n = TEX_SIZE[quality];
    const hull = new THREE.DataArrayTexture(generateHullArray(n, seed), n, n, LAYERS);
    hull.format = THREE.RGBAFormat;
    hull.type = THREE.UnsignedByteType;
    hull.wrapS = hull.wrapT = THREE.RepeatWrapping;
    hull.magFilter = THREE.LinearFilter;
    hull.minFilter = THREE.LinearMipmapLinearFilter;
    hull.generateMipmaps = true;
    hull.anisotropy = TEX_ANISO[quality];
    hull.colorSpace = THREE.NoColorSpace;
    hull.needsUpdate = true;
    const decal = generateDecalAtlas(quality === 'ultra' ? 128 : 64, seed);
    set = { hull, decal, refs: 0 };
    texCache.set(key, set);
  }
  set.refs++;
  return { key, set };
}

function releaseTextures(key: string): void {
  const set = texCache.get(key);
  if (!set) return;
  if (--set.refs <= 0) {
    set.hull.dispose();
    set.decal.dispose();
    texCache.delete(key);
  }
}

// ================================================================================================ shaders

const ATTR_VERT_PARS = /* glsl */ `
attribute vec4 aTint;
attribute vec4 aSurf;
attribute vec4 aFx;
varying vec4 vTint;
varying vec4 vSurf;
varying vec4 vFx;
varying vec2 vHullUv;
`;
const ATTR_VERT = /* glsl */ `
vTint = aTint; vSurf = aSurf; vFx = aFx; vHullUv = uv;
`;

const HULL_FRAG_PARS = /* glsl */ `
uniform mediump sampler2DArray uHullTex;
#ifdef HULL_MICRO
uniform sampler2D uHullMicro;
#endif
uniform vec3 uLivery[3];
uniform float uHeat;
uniform float uThrottle;
uniform float uDamage;
#ifdef HULL_STATION
uniform vec3 uFlood;
#endif
varying vec4 vTint;
varying vec4 vSurf;
varying vec4 vFx;
varying vec2 vHullUv;
const float HULL_SCALE[8] = float[8](0.25, 0.3, 0.6, 0.45, 1.3, 0.5, 1.1, 0.5);
const float HULL_NRM[8] = float[8](1.0, 1.15, 0.9, 0.6, 0.5, 1.2, 1.2, 1.3);
mat3 hullTBN(vec3 eyePos, vec3 N, vec2 st) {
  vec3 q0 = dFdx(eyePos);
  vec3 q1 = dFdy(eyePos);
  vec2 st0 = dFdx(st);
  vec2 st1 = dFdy(st);
  vec3 q1perp = cross(q1, N);
  vec3 q0perp = cross(N, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float sc = det == 0.0 ? 0.0 : inversesqrt(det);
  return mat3(T * sc, B * sc, N);
}
`;

// Replaces <map_fragment>: everything the finish needs is computed once here.
const HULL_FRAG_MAIN = /* glsl */ `
#ifdef HULL_PHOTO
vec2 hUvDx = dFdx(vHullUv);
vec2 hUvDy = dFdy(vHullUv);
#endif
float hLayer = floor(vSurf.x * 255.0 + 0.5);
int hLi = int(clamp(hLayer, 0.0, 7.0));
vec4 hTex = texture(uHullTex, vec3(vHullUv * HULL_SCALE[hLi], hLayer));
vec4 hMac = texture(uHullTex, vec3(vHullUv * 0.061 + 0.37, 8.0));
vec4 hMid = texture(uHullTex, vec3(vHullUv.yx * 0.37 + 0.11, 8.0));
vec3 hAlbedo = vTint.rgb * vTint.rgb;
float hSlot = floor(vFx.w * 3.0 + 0.5);
if (hSlot > 0.5) hAlbedo *= uLivery[int(hSlot) - 1];
float hTone = hTex.b;
float hCav = clamp(1.0 - hTex.a * 2.0, 0.0, 1.0);
float hEdge = clamp(hTex.a * 2.0 - 1.0, 0.0, 1.0);
#ifdef HULL_STATION
// megastructure plating: the same finish again, seven times coarser, so structure survives distance
vec4 hBig = texture(uHullTex, vec3(vHullUv * (HULL_SCALE[hLi] * 0.14) + 0.31, hLayer));
hTone = mix(hTone, hBig.b, 0.6);
hCav = max(hCav, 0.9 * clamp(1.0 - hBig.a * 2.0, 0.0, 1.0));
hEdge = max(hEdge, 0.6 * clamp(hBig.a * 2.0 - 1.0, 0.0, 1.0));
#endif
float hRough = vSurf.z;
float hMetal = vSurf.y;
float hAO = vTint.a;
// tone variation: per-panel shade, large soft clouds
hAlbedo *= (0.8 + 0.4 * hTone) * (0.88 + 0.24 * hMac.r);
hRough += (hTone - 0.5) * 0.22 + (hMid.r - 0.5) * 0.2;
#ifdef HULL_MICRO
// hero micro detail: pressed-panel beads on painted / armour finishes, scratches and smudges everywhere
vec4 hMic = texture(uHullMicro, vHullUv * 0.5);
float hMicN = hLi <= 1 ? 1.0 : (hLi == 3 || hLi == 4 ? 0.45 : 0.25);
hRough += (0.5 - hMic.b) * 0.3;
hAlbedo *= 0.95 + 0.1 * hMic.b;
#endif
// photo-scanned detail (hero hull, photo/detail.ts): painted livery -> hullPaint, drive-throat metal -> nozzle,
// bare metal -> brushed / gunmetal; colour x photo/mean, roughness offset, whiteout normal (HULL_FRAG_NORMAL)
float hPk = 0.0;
float hPc = 1.0;
vec4 hPhAlb = vec4(1.0);
vec4 hPhLin = vec4(0.5, 0.5, 1.0, 0.5);
vec4 hPB = vec4(1.0);
#ifdef HULL_PHOTO
{
  vec4 hPA = vec4(0.0);
  if (vFx.y > 0.004) { hPA = PH_A_nozzle; hPB = PH_B_nozzle; hPk = 0.8; }
  // the scanned paint carries rust-brown dirt patches: on the clear-coated livery only its fine variation is
  // kept (colour 0.4, ratio clamped), the orange peel, chips and roughness come through in full
  else if (hSlot > 0.5 && hLi <= 1) { hPA = PH_A_hullPaint; hPB = PH_B_hullPaint; hPk = 1.0; hPc = 0.4; }
  else if (hLi == 3 && dot(hAlbedo, vec3(0.333)) > 0.25) { hPA = PH_A_brushed; hPB = PH_B_brushed; hPk = 0.7; }
  else if (hLi == 3) { hPA = PH_A_gunmetal; hPB = PH_B_gunmetal; hPk = 0.8; }
  hPk *= uPhOn;
  if (hPk > 0.0) {
    hPhAlb = phAlbedo(hPA.x, vHullUv * hPA.zw, hUvDx * hPA.zw, hUvDy * hPA.zw);
    hPhLin = phLinear(hPA.y, vHullUv * hPA.zw, hUvDx * hPA.zw, hUvDy * hPA.zw);
    hAlbedo *= mix(vec3(1.0), clamp(hPhAlb.rgb * hPB.rgb, 0.72, 1.2), hPk * hPc);
    hRough += hPk * (hPhLin.a - hPB.w);
  }
}
#endif
// grime: seams, cavities, streaks, and wherever the baked AO says dirt would collect; clear-coated livery paint
// (slots 1 and 3) is kept clean: grime there is a faint film, not a grey wash over the white armour
float hGrime = vFx.z * clamp(hCav * 0.95 + 0.5 * hMac.g * hMac.a + (1.0 - hAO) * 0.6, 0.0, 1.0);
#ifndef HULL_STATION
if (abs(hSlot - 1.0) < 0.5 || hSlot > 2.5) hGrime *= 0.45;
#endif
hAlbedo *= 1.0 - 0.72 * hGrime;
hRough += 0.3 * hGrime;
// paint worn to bare metal along plate edges and in chipped patches
float hWearSrc = hEdge * (0.55 + 0.75 * hMac.a) + smoothstep(0.7, 0.95, hMid.b) * smoothstep(0.55, 0.9, hMac.a) * 0.75;
float hWear = smoothstep(0.62, 0.95, hWearSrc * (0.35 + 1.5 * vSurf.w)) * step(0.004, vSurf.w);
hAlbedo = mix(hAlbedo, vec3(0.5, 0.51, 0.53), hWear);
hMetal = mix(hMetal, 1.0, hWear);
hRough = mix(hRough, 0.34, hWear);
// scorching from damage
float hScorch = uDamage > 0.001 ? smoothstep(1.02 - uDamage, 1.22 - uDamage, hMac.a * 0.55 + hMid.r * 0.45 + 0.15) : 0.0;
hAlbedo = mix(hAlbedo, vec3(0.012), hScorch * 0.9);
hRough = mix(hRough, 0.92, hScorch);
hMetal *= 1.0 - 0.7 * hScorch;
// cavity darkening also under direct light (there are no shadow maps)
hAlbedo *= mix(1.0, hAO, 0.55);
#ifndef HULL_STATION
// white armour paint stays an off-white paint (albedo 0.65-0.75), whatever the tone noise multiplied in
if (abs(hSlot - 1.0) < 0.5 && hWear < 0.5) hAlbedo = clamp(hAlbedo, vec3(0.0), vec3(0.78)) * mix(1.0, 1.08, hAO);
#endif
hRough = clamp(hRough, 0.07, 1.0);
#ifndef HULL_STATION
// heat tint: metal next to the drive throats oxidises from straw through bronze and violet to blue
if (vFx.y > 0.004) {
  float hOx = vFx.y;
  vec3 hOxC = mix(vec3(1.0, 0.8, 0.5), vec3(0.62, 0.42, 0.72), smoothstep(0.25, 0.6, hOx));
  hOxC = mix(hOxC, vec3(0.34, 0.4, 0.62), smoothstep(0.6, 0.95, hOx));
  hAlbedo *= mix(vec3(1.0), hOxC, 0.85 * smoothstep(0.0, 0.25, hOx));
  hRough = mix(hRough, 0.5, 0.3 * hOx);
}
#endif
// clear coat over painted livery colours (primary armour and accent paint), lost where it is worn or dirty
float hCoat = (abs(hSlot - 1.0) < 0.5 || hSlot > 2.5) ? (1.0 - hWear) * (1.0 - 0.75 * hGrime) * (1.0 - hScorch) : 0.0;
// heat: aerobraking / radiators (uHeat) and engine-adjacent metal (uThrottle)
float hHeatA = vFx.x * uHeat;
float hHeatE = vFx.y * uThrottle;
vec3 hEmis = vec3(1.0, 0.24, 0.035) * (hHeatA * hHeatA * 3.0 * (0.5 + 0.9 * hTone) * (1.0 - 0.7 * hCav))
           + mix(vec3(0.8, 0.06, 0.008), vec3(1.0, 0.42, 0.1), hHeatE) * (hHeatE * hHeatE * hHeatE * 0.9 * (0.55 + 0.9 * hTone));
hEmis *= 1.0 - 0.6 * hScorch;
#ifdef HULL_STATION
// the engine-heat channel carries baked floodlight exposure instead: the surface re-emits its own colour
hEmis = vec3(1.0, 0.24, 0.035) * (hHeatA * hHeatA * 3.0 * (0.5 + 0.9 * hTone) * (1.0 - 0.7 * hCav)) * (1.0 - 0.6 * hScorch)
      + hAlbedo * uFlood * (vFx.y * vFx.y * (1.0 - 0.55 * hCav));
#endif
diffuseColor.rgb = hAlbedo;
`;

const HULL_FRAG_NORMAL = /* glsl */ `
{
  vec3 hN = vec3((hTex.rg * 2.0 - 1.0) * HULL_NRM[hLi] * (1.0 - 0.35 * hWear), 0.0);
#ifdef HULL_MICRO
  hN.xy += (hMic.rg * 2.0 - 1.0) * (0.85 * hMicN);
#endif
#ifdef HULL_STATION
  hN.xy += (hBig.rg * 2.0 - 1.0) * (HULL_NRM[hLi] * 0.85);
#endif
  hN.xy += (hPhLin.rg * 2.0 - 1.0) * hPk;
  hN.z = sqrt(max(0.04, 1.0 - dot(hN.xy, hN.xy)));
  normal = normalize(hullTBN(-vViewPosition, normal, vHullUv) * hN);
}
`;

const HULL_FRAG_AO = /* glsl */ `
{
  float hOcc = hAO * (1.0 - 0.5 * hCav) * mix(1.0, hPhLin.b, hPk);
  reflectedLight.indirectDiffuse *= hOcc;
  reflectedLight.indirectSpecular *= mix(1.0, hOcc * hOcc, 0.85);
  reflectedLight.directSpecular *= mix(1.0, hAO, 0.6);
}
`;

const DECAL_FRAG_PARS = /* glsl */ `
uniform sampler2D uDecalTex;
uniform vec3 uLivery[3];
varying vec4 vTint;
varying vec4 vSurf;
varying vec4 vFx;
varying vec2 vHullUv;
`;
const DECAL_FRAG_MAIN = /* glsl */ `
{
  vec3 dCol = vTint.rgb * vTint.rgb;
  float dSlot = floor(vSurf.x * 255.0 + 0.5);
  if (dSlot > 0.5) dCol *= uLivery[int(dSlot) - 1];
  diffuseColor.rgb = dCol;
  diffuseColor.a = vTint.a * texture2D(uDecalTex, vHullUv).r;
  if (diffuseColor.a < 0.012) discard;
}
`;

const GLOW_VERT = /* glsl */ `
attribute vec4 aTint;
attribute vec4 aSurf;
attribute vec4 aFx;
varying vec4 vTint;
varying vec4 vSurf;
varying vec4 vFx;
varying vec2 vGUv;
varying vec3 vVN;
varying vec3 vVP;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vTint = aTint; vSurf = aSurf; vFx = aFx; vGUv = uv;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vVN = normalMatrix * normal;
  vVP = mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
}
`;

const GLOW_FRAG = /* glsl */ `
uniform float uTime;
uniform float uThrottle;
uniform float uLightsOn;
uniform float uHeat;
uniform float uDamage;
varying vec4 vTint;
varying vec4 vSurf;
varying vec4 vFx;
varying vec2 vGUv;
varying vec3 vVN;
varying vec3 vVP;
#include <common>
#include <logdepthbuf_pars_fragment>
float gHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
void main() {
  #include <logdepthbuf_fragment>
  float mode = floor(vSurf.x * 255.0 + 0.5);
  vec3 col = vTint.rgb * vTint.rgb;
  float I = vSurf.y * vSurf.y * 64.0;
  float sw = mix(1.0, uLightsOn, step(0.5, vFx.x));
  float facing = clamp(dot(normalize(vVN), normalize(-vVP)), 0.0, 1.0);
  vec3 outc;
  if (mode < 0.5) {
    outc = col * I * sw * (0.55 + 0.45 * facing);
  } else if (mode < 1.5) {
    // window strip: panes with mullions, most lit, some dark, slight colour and level variation
    float cell = max(0.05, vFx.y * 4.0);
    vec2 wuv = vFx.w > 0.5 ? vGUv.yx : vGUv;
    float cx = wuv.x / cell;
    float id = floor(cx);
    float fx = fract(cx);
    float pane = smoothstep(0.0, 0.07, fx) * smoothstep(1.0, 0.93, fx);
    float r = gHash(vec2(id, floor(wuv.y * 0.5) + 7.0));
    float lit = step(0.24, r) * (0.45 + 0.55 * fract(r * 7.13));
    float inner = 0.7 + 0.3 * gHash(vec2(floor(cx * 3.0), floor(wuv.y * 9.0)));
    vec3 wcol = mix(col, col * vec3(0.8, 0.95, 1.25), step(0.82, fract(r * 3.7)));
    outc = wcol * I * lit * inner * pane * (0.5 + 0.5 * facing) * mix(1.0, 0.25 + 0.75 * sw, 1.0) + vec3(0.004) * pane;
  } else if (mode < 2.5) {
    // engine bell interior: uv.y = 0 at the lip .. 1 at the injector. The wall is incandescent: nearly
    // dark at the lip, saturated engine colour half-way down, white-hot at the throat (bloom does the rest).
    float d = clamp(vGUv.y, 0.0, 1.0);
    float thr = clamp(uThrottle, 0.0, 1.0) * (1.0 - 0.5 * uDamage);
    float flick = 1.0 + 0.06 * sin(uTime * 61.0 + vGUv.x * 40.0) * thr;
    // regenerative-cooling channels along the wall and a few stiffening bands
    float ribs = 0.82 + 0.18 * sin(vGUv.x * 6.2832 * 40.0);
    float bands = 0.8 + 0.2 * smoothstep(0.3, 0.5, abs(fract(d * 6.0) - 0.5));
    float d2 = d * d;
    float wall = 0.3 * d * sqrt(d) + 0.8 * d2 * d2 * d;
    float core = smoothstep(0.84, 1.0, d);
    // saturated engine colour on the cooler outer wall, white-hot toward the throat
    vec3 sat = col * col * sqrt(col);
    sat /= max(max(sat.r, sat.g), max(sat.b, 1e-3));
    vec3 hot = mix(sat, vec3(1.0, 0.96, 0.9), clamp(d2 * 1.15 + core, 0.0, 1.0));
    float lip = smoothstep(0.0, 0.14, d);
    float k = thr * (0.004 + lip * wall * mix(ribs * bands, 1.0, d) + 0.9 * core) * flick;
    // seen along the axis the hot gas column adds to the wall glow
    k *= 0.8 + 0.35 * facing;
    vec3 idle = vec3(1.0, 0.3, 0.06) * (0.004 + 0.05 * d2 * d2);
    outc = hot * I * k + idle * (1.0 - thr) + vec3(0.004, 0.0045, 0.005) * ribs;
  } else if (mode < 3.5) {
    float period = max(0.05, vSurf.z * 8.0);
    float ph = fract(uTime / period + vSurf.w);
    float on = step(ph, max(0.02, vFx.z));
    outc = col * I * (0.04 + 0.96 * on) * sw;
  } else {
    float h = clamp(uHeat, 0.0, 1.0);
    outc = col * I * h * h * (0.6 + 0.4 * facing);
  }
  gl_FragColor = vec4(outc, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const FLARE_VERT = /* glsl */ `
attribute vec4 aTint;
attribute vec4 aSurf;
attribute vec4 aFx;
uniform float uTime;
uniform float uLightsOn;
varying vec3 vFCol;
varying vec2 vFP;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  float I = aSurf.y * aSurf.y * 64.0;
  float period = aSurf.z * 8.0;
  float on = 1.0;
  if (period > 0.01) {
    float ph = fract(uTime / period + aSurf.w);
    on = step(ph, max(0.02, aFx.z));
  }
  on *= mix(1.0, uLightsOn, step(0.5, aFx.x));
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  float size = aFx.y * 4.0;
  float dist = max(0.0, -mvPosition.z);
  // keep a minimum angular size so strobes stay visible far away, and fade the overscaled sprite
  float minSize = dist * 0.0028;
  float fade = min(1.0, size / max(minSize, 1e-4));
  size = max(size, minSize);
  mvPosition.xy += uv * size;
  mvPosition.z += min(size * 0.6, 0.6);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  vFCol = aTint.rgb * aTint.rgb * I * on * mix(0.35, 1.0, fade);
  vFP = uv;
}
`;

const FLARE_FRAG = /* glsl */ `
varying vec3 vFCol;
varying vec2 vFP;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  float r2 = dot(vFP, vFP);
  float g = exp(-r2 * 44.0) + 0.045 * exp(-r2 * 6.0);
  g *= smoothstep(1.0, 0.55, sqrt(r2));
  // faint horizontal streak, like a lens
  g += 0.03 * exp(-abs(vFP.y) * 40.0) * exp(-vFP.x * vFP.x * 4.0);
  gl_FragColor = vec4(vFCol * g, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ================================================================================================ factory

export interface HullMaterialOptions {
  livery: Livery;
  /** texture-set seed (ships share one set per quality unless they ask for another seed) */
  seed?: number;
  quality: HullQuality;
  /**
   * Megastructure mode (stations.ts). Two changes to the hull finish: a second, seven times coarser sample
   * of the layer adds large plating that still reads from kilometres away, and the per-vertex engine-heat
   * mask (hullStyle `engineHeat`) is reinterpreted as baked floodlight exposure — the surface re-emits its
   * own albedo times `flood` (linear RGB radiance of a fully lit white surface). Ships never set this.
   */
  station?: { flood: RGB };
  /**
   * Hero finish (the player's ship): a clear coat over the livery paint (MeshPhysicalMaterial, geometric
   * normal under the coat), the micro-detail map (MICRO_SIZE by tier) and, when `doubleSided`, the hull
   * drawn from inside too (the skin seen past the window reveals from the cabin).
   */
  hero?: { clearcoat?: boolean; doubleSided?: boolean };
}

/**
 * Create the five channel materials for one model. Textures are shared and reference counted; the
 * material instances (and their uniforms) belong to the caller. Call dispose() when the model goes away.
 */
export function createHullMaterials(opts: HullMaterialOptions): HullMaterials {
  const { key, set } = acquireTextures(opts.quality, opts.seed ?? 1);
  const liv = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const U = {
    uHullTex: { value: set.hull },
    uDecalTex: { value: set.decal },
    uLivery: { value: liv },
    uTime: { value: 0 },
    uThrottle: { value: 0 },
    uLightsOn: { value: 1 },
    uHeat: { value: 0 },
    uDamage: { value: 0 },
    uFlood: { value: new THREE.Vector3() },
  };
  const station = opts.station;
  if (station) U.uFlood.value.set(station.flood[0], station.flood[1], station.flood[2]);
  const hero = station ? undefined : opts.hero;
  const coat = !!hero?.clearcoat;
  const micro = hero ? acquireMicro(opts.quality, opts.seed ?? 1) : null;
  // the hero hull shares the photo-scanned detail of the interior (one set of arrays for the whole ship)
  const photo: PhotoDetail | null = hero && typeof document !== 'undefined' ? acquirePhotoDetail(opts.quality) : null;
  const uMicro = { value: micro ? micro.tex : null };

  const hull: THREE.MeshStandardMaterial = coat
    ? new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0, clearcoat: 0.85, clearcoatRoughness: 0.06 })
    : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0 });
  if (hero?.doubleSided) hull.side = THREE.DoubleSide;
  {
    const withDefines = hull as THREE.Material & { defines?: Record<string, string> };
    const d: Record<string, string> = { ...(withDefines.defines ?? {}) };
    if (station) d.HULL_STATION = '';
    if (micro) d.HULL_MICRO = '';
    if (photo) d.HULL_PHOTO = '';
    withDefines.defines = d;
  }
  hull.onBeforeCompile = (shader, renderer) => {
    Object.assign(shader.uniforms, { uHullTex: U.uHullTex, uLivery: U.uLivery, uHeat: U.uHeat, uThrottle: U.uThrottle, uDamage: U.uDamage, uFlood: U.uFlood, uHullMicro: uMicro });
    if (photo) {
      photo.noteRenderer(renderer);
      Object.assign(shader.uniforms, photo.uniforms);
    }
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${ATTR_VERT_PARS}`).replace('#include <begin_vertex>', `#include <begin_vertex>\n${ATTR_VERT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${HULL_FRAG_PARS}${photo ? `\n${PHOTO_GLSL}\n${photoConstsGlsl()}` : ''}`)
      .replace('#include <map_fragment>', HULL_FRAG_MAIN)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = hRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = hMetal;')
      .replace('#include <normal_fragment_maps>', HULL_FRAG_NORMAL)
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance += hEmis;')
      .replace('#include <aomap_fragment>', HULL_FRAG_AO);
    if (coat) shader.fragmentShader = shader.fragmentShader.replace('material.clearcoat = clearcoat;', 'material.clearcoat = clearcoat * hCoat;');
  };
  hull.customProgramCacheKey = () => (station ? 'tidelock-hull-4-station' : `tidelock-hull-4${micro ? '-micro' : ''}${coat ? '-coat' : ''}${photo ? '-ph' : ''}`);

  const glass = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0.016, 0.022, 0.03),
    roughness: 0.035,
    metalness: 0,
    ior: 1.52,
    specularIntensity: 1,
    envMapIntensity: 1.8,
    transparent: true,
    opacity: 0.46,
    depthWrite: true,
  });
  glass.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      /* glsl */ `
      float gF = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 3.0);
      float gS = max(max(totalSpecular.r, totalSpecular.g), totalSpecular.b);
      // a faint cool sheen toward grazing angles so a canopy reads as glass even against black space
      vec3 gRim = vec3(0.07, 0.1, 0.14) * gF;
      diffuseColor.a = clamp(opacity + 0.5 * gF + gS, 0.0, 1.0);
      gl_FragColor = vec4(outgoingLight + gRim, diffuseColor.a);
      `,
    );
  };
  glass.customProgramCacheKey = () => 'tidelock-glass-2';

  const glow = new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uThrottle: U.uThrottle, uLightsOn: U.uLightsOn, uHeat: U.uHeat, uDamage: U.uDamage },
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
  });

  const flare = new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uLightsOn: U.uLightsOn },
    vertexShader: FLARE_VERT,
    fragmentShader: FLARE_FRAG,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const decal = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.62,
    metalness: 0.05,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  decal.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { uDecalTex: U.uDecalTex, uLivery: U.uLivery });
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${ATTR_VERT_PARS}`).replace('#include <begin_vertex>', `#include <begin_vertex>\n${ATTR_VERT}`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${DECAL_FRAG_PARS}`).replace('#include <map_fragment>', DECAL_FRAG_MAIN);
  };
  decal.customProgramCacheKey = () => 'tidelock-decal-1';

  const byChannel: THREE.Material[] = [];
  byChannel[CH_HULL] = hull;
  byChannel[CH_GLASS] = glass;
  byChannel[CH_GLOW] = glow;
  byChannel[CH_FLARE] = flare;
  byChannel[CH_DECAL] = decal;

  const setLivery = (l: Livery): void => {
    liv[0].set(l.primary[0], l.primary[1], l.primary[2]);
    liv[1].set(l.secondary[0], l.secondary[1], l.secondary[2]);
    liv[2].set(l.accent[0], l.accent[1], l.accent[2]);
  };
  setLivery(opts.livery);

  let disposed = false;
  return {
    hull,
    glass,
    glow,
    flare,
    decal,
    byChannel,
    setLivery,
    setFlood(color: RGB): void {
      U.uFlood.value.set(color[0], color[1], color[2]);
    },
    update(ctx: HullMaterialCtx): void {
      U.uTime.value = ctx.time;
      U.uThrottle.value = ctx.throttle;
      U.uLightsOn.value = ctx.lightsOn ? 1 : 0;
      U.uHeat.value = ctx.heat;
      U.uDamage.value = ctx.damage;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const m of byChannel) m.dispose();
      releaseTextures(key);
      if (micro) releaseMicro(micro.key);
      if (photo) releasePhotoDetail(photo);
    },
  };
}
