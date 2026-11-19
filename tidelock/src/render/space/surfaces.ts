// Procedural PBR surfaces for Corvane ships: ONE atlas (albedo · tangent-space normal · ORM) holding the tiling
// materials and the trim sheets, generated on the CPU at load from periodic noise tables, plus the shader patch
// that lets MeshStandardMaterial tile inside the atlas.
//
// Atlas layout (fractions of the atlas; v = row / size, DataTexture, no flip):
//   rows 0-2: a 4 x 3 grid of tiling materials (each cell keeps a 1/64 wrapped gutter so mips do not bleed)
//   row 3:    trim strips that tile along u only: hazard stripes, bolt seam, vent slots, and the stencil block
//             (placards, screen graphics and a flat white patch, addressed by STENCIL sub-rects)
// Per vertex the mesh carries `uv` in REPEATS (metres / TILE_METRES) and a float attribute `tile`
// (tile index + 16 * glow group); the patched shader wraps uv into the tile's rect with textureGrad, so the
// tiles repeat seamlessly without a draw call per material. A vertex `color` multiplies the albedo (tints:
// the same padded fabric is blue in the suit room and charcoal in a cabin).
//
// ORM: R = ambient occlusion, G = roughness, B = metalness (three.js convention). Albedo <= 0.8, metals have no
// diffuse. Sizes: 2048 high/ultra (64 MB with mips), 1024 medium (16 MB), 512 low (4 MB). The atlas is shared and
// reference counted: the cockpit and exterior can adopt it with acquireSurfaceAtlas + surfaceMaterial.

import * as THREE from 'three';
import type { Quality } from '../pipeline';

export type P3 = [number, number, number];

export const TILE_IDS = [
  'whitePanel', 'brushed', 'gunmetal', 'tread',
  'grating', 'padded', 'leather', 'veneer',
  'warmPanel', 'fabric', 'darkFloor', 'netting',
  'hazard', 'seam', 'vent', 'stencil',
] as const;
export type TileId = (typeof TILE_IDS)[number];
export const TILE = Object.fromEntries(TILE_IDS.map((t, i) => [t, i])) as Record<TileId, number>;

/** Metres covered by one repeat (u, v). Trims: u along the strip, v across it (0..1 spans the strip). */
export const TILE_METRES: Record<TileId, [number, number]> = {
  whitePanel: [0.6, 0.6], brushed: [1.0, 1.0], gunmetal: [0.8, 0.8], tread: [0.5, 0.5],
  grating: [0.3, 0.3], padded: [0.5, 0.5], leather: [0.6, 0.6], veneer: [1.2, 1.2],
  warmPanel: [1.2, 1.2], fabric: [0.3, 0.3], darkFloor: [1.0, 1.0], netting: [0.5, 0.5],
  hazard: [0.4, 0.1], seam: [0.25, 0.06], vent: [0.15, 0.1], stencil: [1.6, 0.4],
};

/** Mean linear albedo seen by diffuse bounces (metals: a fraction of F0), for the light bake. */
export const TILE_ALBEDO: Record<TileId, P3> = {
  whitePanel: [0.6, 0.6, 0.58], brushed: [0.3, 0.24, 0.18], gunmetal: [0.12, 0.12, 0.13], tread: [0.06, 0.06, 0.06],
  grating: [0.08, 0.08, 0.08], padded: [0.5, 0.5, 0.5], leather: [0.45, 0.45, 0.45], veneer: [0.09, 0.05, 0.03],
  warmPanel: [0.38, 0.34, 0.3], fabric: [0.55, 0.55, 0.55], darkFloor: [0.06, 0.06, 0.06], netting: [0.06, 0.06, 0.06],
  hazard: [0.3, 0.22, 0.03], seam: [0.12, 0.12, 0.13], vent: [0.08, 0.08, 0.08], stencil: [0.5, 0.5, 0.5],
};

/** Sub-rects of the stencil block, tile-local [u0, v0, u1, v1]. */
export const STENCIL_LABELS = [
  'CORVANE', 'WREN  CV-2207', 'PRESSURE DOOR', 'CARGO BAY 01',
  'ENGINEERING', 'CAUTION  RAMP', 'LIFE SUPPORT', 'COOLANT LOOP B',
  'NO STEP', 'DOCKING HATCH', 'EVA SUITS', 'HAND HOLD',
  'ui1', 'ui2', 'ui3', 'flat',
] as const;
export type StencilId = (typeof STENCIL_LABELS)[number];
export const STENCIL: Record<StencilId, [number, number, number, number]> = Object.fromEntries(
  STENCIL_LABELS.map((l, i) => {
    const c = i % 4;
    const r = Math.floor(i / 4);
    const e = 0.004;
    return [l, [c * 0.25 + e, r * 0.25 + e, (c + 1) * 0.25 - e, (r + 1) * 0.25 - e]];
  }),
) as Record<StencilId, [number, number, number, number]>;

/** Glow groups (tile attribute = tile + 16 * group). */
export const GLOW_MAIN = 0;
export const GLOW_ALWAYS = 1;
export const GLOW_EMERG = 2;
export const GLOW_BLINK = 3;

const G = 1 / 64;
const STRIPS: Record<string, [number, number]> = {
  hazard: [0.75, 0.8125], seam: [0.8125, 0.84375], vent: [0.84375, 0.875], stencil: [0.875, 1.0],
};
/** Inner rect of a tile in atlas uv: [u0, v0, du, dv]. */
export function tileRect(i: number): [number, number, number, number] {
  if (i < 12) {
    const c = i % 4;
    const r = Math.floor(i / 4);
    return [c * 0.25 + G, r * 0.25 + G, 0.25 - 2 * G, 0.25 - 2 * G];
  }
  const [y0, y1] = STRIPS[TILE_IDS[i]];
  const gv = 1 / 512;
  return [G, y0 + gv, 1 - 2 * G, y1 - y0 - 2 * gv];
}

export function surfaceSize(q: Quality): number {
  return q === 'low' ? 512 : q === 'medium' ? 1024 : 2048;
}

// ---------------------------------------------------------------------------------------------------------
// noise: periodic value-noise fbm in a 256 table, sampled with integer repeats so every tile wraps

const NT = 256;
let NOISE: Float32Array | null = null;
function hash(x: number, y: number, s: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function noiseTable(): Float32Array {
  if (NOISE) return NOISE;
  const t = new Float32Array(NT * NT);
  let amp = 0.5;
  let tot = 0;
  for (let o = 0; o < 6; o++) {
    const p = 4 << o;
    const cs = NT / p;
    for (let y = 0; y < NT; y++) {
      const fy = y / cs;
      const y0 = Math.floor(fy);
      let ty = fy - y0;
      ty = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < NT; x++) {
        const fx = x / cs;
        const x0 = Math.floor(fx);
        let tx = fx - x0;
        tx = tx * tx * (3 - 2 * tx);
        const a = hash(x0 % p, y0 % p, o);
        const b = hash((x0 + 1) % p, y0 % p, o);
        const c = hash(x0 % p, (y0 + 1) % p, o);
        const d = hash((x0 + 1) % p, (y0 + 1) % p, o);
        t[y * NT + x] += amp * (a + (b - a) * tx + (c - a + (a - b + d - c) * tx) * ty);
      }
    }
    tot += amp;
    amp *= 0.55;
  }
  for (let i = 0; i < t.length; i++) t[i] /= tot;
  NOISE = t;
  return t;
}
let NZ: Float32Array = new Float32Array(1);
/** Periodic fbm in [0,1], ~0.5 mean: (u, v) in tile units, k integer repeats per tile, o decorrelating offset. */
function nz(u: number, v: number, k: number, o = 0): number {
  const x = (u * k + o * 0.371) * NT;
  const y = (v * k + o * 0.613) * NT;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = x - xi;
  const ty = y - yi;
  const x0 = xi & 255;
  const y0 = yi & 255;
  const x1 = (x0 + 1) & 255;
  const y1 = (y0 + 1) & 255;
  const a = NZ[y0 * NT + x0];
  const b = NZ[y0 * NT + x1];
  const c = NZ[y1 * NT + x0];
  const d = NZ[y1 * NT + x1];
  return a + (b - a) * tx + (c - a + (a - b + d - c) * tx) * ty;
}
const sat = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const sm = (e0: number, e1: number, x: number): number => {
  const t = sat((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const frac = (x: number): number => x - Math.floor(x);
/** Periodic worley F1 (cell units) on a p x p grid. */
function worley(u: number, v: number, p: number, s: number): number {
  const x = u * p;
  const y = v * p;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let best = 9;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i;
      const cy = yi + j;
      const wx = ((cx % p) + p) % p;
      const wy = ((cy % p) + p) % p;
      const dx = cx + hash(wx, wy, s) - x;
      const dy = cy + hash(wx, wy, s + 7) - y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  return Math.sqrt(best);
}
/** Thin random scratches: 1 on a scratch, 0 elsewhere (p cells per tile, one segment per cell, some empty). */
function scratch(u: number, v: number, p: number, s: number, w: number): number {
  const x = u * p;
  const y = v * p;
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  const hx = ((cx % p) + p) % p;
  const hy = ((cy % p) + p) % p;
  if (hash(hx, hy, s + 3) > 0.45) return 0;
  const a = hash(hx, hy, s) * Math.PI;
  const ox = cx + 0.5 + (hash(hx, hy, s + 1) - 0.5) * 0.6;
  const oy = cy + 0.5 + (hash(hx, hy, s + 2) - 0.5) * 0.6;
  const dx = x - ox;
  const dy = y - oy;
  const along = dx * Math.cos(a) + dy * Math.sin(a);
  const across = Math.abs(-dx * Math.sin(a) + dy * Math.cos(a));
  const len = 0.25 + hash(hx, hy, s + 4) * 0.35;
  if (Math.abs(along) > len) return 0;
  return sat(1 - across / w) * (1 - Math.abs(along) / len);
}

interface Px {
  h: number;
  r: number;
  g: number;
  b: number;
  ro: number;
  me: number;
  ao: number;
  a: number;
}
type Gen = (u: number, v: number, o: Px) => void;
const set = (o: Px, r: number, g: number, b: number, ro: number, me: number): void => {
  o.r = r;
  o.g = g;
  o.b = b;
  o.ro = ro;
  o.me = me;
};

// --- the tiles (u, v in [0,1) tile units; heights in metres) ---------------------------------------------
const GEN: Partial<Record<TileId, Gen>> = {
  whitePanel(u, v, o) {
    const e = Math.min(u, 1 - u, v, 1 - v);
    const seam = sm(0.003, 0.0065, e);
    const step = sm(0.052, 0.064, e);
    const n1 = nz(u, v, 1, 1);
    const fine = nz(u, v, 16, 2);
    let h = -0.0018 * (1 - seam) + 0.0022 * step + 0.00006 * fine;
    const grime = (1 - sm(0.0, 0.05, e)) * 0.5 + (1 - sm(0.0, 0.012, Math.abs(e - 0.05))) * 0.35;
    const sc = scratch(u, v, 9, 11, 0.025) + scratch(u + 0.37, v + 0.21, 14, 12, 0.02);
    const base = 0.62 * (0.95 + 0.1 * n1) * (1 - grime * 0.22) * (1 + sc * 0.06);
    set(o, base, base * 0.99, base * 0.965, 0.4 + 0.14 * nz(u, v, 3, 3) + grime * 0.12 - sc * 0.12, 0);
    // corner screws
    const sx = Math.min(Math.abs(u - 0.032), Math.abs(u - 0.968));
    const sy = Math.min(Math.abs(v - 0.032), Math.abs(v - 0.968));
    const d = Math.hypot(sx, sy);
    if (d < 0.011) {
      h = -0.0006 + 0.0005 * (1 - d / 0.011);
      const slot = Math.abs(sx - sy) < 0.002 ? 0.5 : 1;
      set(o, 0.45 * slot, 0.45 * slot, 0.46 * slot, 0.35, 1);
    }
    o.h = h;
    o.ao = (0.5 + 0.5 * seam) * (1 - 0.18 * (1 - sm(0.0, 0.01, Math.abs(e - 0.05))) * (1 - step));
  },
  brushed(u, v, o) {
    const st = nz(u, v * 37, 1, 4) * 0.6 + nz(u * 0.5, v * 151, 2, 5) * 0.4;
    const n1 = nz(u, v, 2, 6);
    const sc = scratch(u, v, 7, 21, 0.015);
    const k = 0.92 + 0.12 * st + 0.05 * n1 + sc * 0.08;
    set(o, 0.7 * k, 0.56 * k, 0.42 * k, 0.26 + 0.16 * st + 0.06 * n1 - sc * 0.08, 1);
    o.h = 0.00003 * st;
    o.ao = 1;
  },
  gunmetal(u, v, o) {
    const n1 = nz(u, v, 2, 7);
    const n2 = nz(u, v, 12, 8);
    const sc = Math.max(scratch(u, v, 10, 31, 0.02), scratch(u + 0.5, v + 0.3, 6, 32, 0.012));
    const k = 0.85 + 0.25 * n1 + 0.1 * n2 + sc * 0.6;
    set(o, 0.25 * k, 0.26 * k, 0.28 * k, 0.48 + 0.18 * n2 - sc * 0.2, 1);
    o.h = 0.00005 * n2 - sc * 0.00008;
    o.ao = 1;
  },
  tread(u, v, o) {
    const e = Math.min(u, 1 - u, v, 1 - v);
    const rim = 1 - sm(0.025, 0.032, e);
    const N = 8;
    const cx = Math.floor(u * N);
    const cy = Math.floor(v * N);
    const fx = u * N - cx - 0.5;
    const fy = v * N - cy - 0.5;
    const flip = (cx + cy) & 1 ? 1 : -1;
    const a = (fx + flip * fy) * 0.7071;
    const b = (fx - flip * fy) * 0.7071;
    const loz = 1 - sm(0.82, 1.0, Math.abs(a) / 0.36 + Math.abs(b) / 0.1);
    const dust = nz(u, v, 3, 9);
    const wear = nz(u, v, 6, 10);
    let h = loz * 0.0014 + 0.00003 * nz(u, v, 24, 11);
    let al = 0.045 + loz * 0.02 * wear + (1 - loz) * 0.025 * dust;
    let ro = 0.82 - loz * 0.14 * wear;
    let me = 0;
    if (rim > 0) {
      h = h * (1 - rim) + rim * 0.0022;
      al = al * (1 - rim) + rim * 0.3;
      ro = ro * (1 - rim) + rim * 0.4;
      me = rim;
    }
    if (e < 0.004) {
      h = -0.002;
      al = 0.02;
    }
    const bx = Math.min(Math.abs(u - 0.016), Math.abs(u - 0.984));
    const by = Math.min(Math.abs(v - 0.016), Math.abs(v - 0.984));
    if (Math.hypot(bx, by) < 0.009) {
      h = 0.003;
      al = 0.35;
      ro = 0.35;
      me = 1;
    }
    set(o, al, al, al * 1.02, ro, me);
    o.h = h;
    o.ao = e < 0.006 ? 0.4 : 1 - (1 - loz) * 0.15;
  },
  grating(u, v, o) {
    const bu = Math.abs(frac(u * 8) - 0.5);
    const bv = Math.abs(frac(v * 3) - 0.5);
    const barA = sm(0.38, 0.33, bu);
    const barB = sm(0.44, 0.4, bv);
    const bar = Math.max(barA, barB);
    const wear = nz(u, v, 4, 12);
    const k = 0.25 + 0.2 * wear * bar;
    set(o, k, k, k * 1.03, 0.55 - 0.15 * wear, bar > 0.5 ? 1 : 0);
    o.h = bar * 0.004 + barA * 0.001;
    o.a = bar > 0.5 ? 1 : 0;
    if (bar <= 0.5) set(o, 0.01, 0.01, 0.01, 0.9, 0);
    o.ao = 0.2 + 0.8 * bar;
  },
  padded(u, v, o) {
    const ex = Math.min(u, 1 - u);
    const fv = frac(v * 4);
    const pil = Math.sqrt(Math.sin(Math.PI * fv)) * sm(0.0, 0.06, ex);
    const weave = nz(u, v, 32, 13);
    const stitch = Math.abs(fv - 0.5) > 0.44 && frac(u * 60) < 0.55 ? 1 : 0;
    const k = 0.5 * (0.9 + 0.12 * weave) * (0.78 + 0.22 * pil);
    set(o, k, k, k, 0.82 + 0.1 * weave, 0);
    if (stitch && Math.abs(fv - 0.5) < 0.48) set(o, 0.65, 0.65, 0.65, 0.7, 0);
    o.h = pil * 0.008 + weave * 0.0002;
    o.ao = 0.55 + 0.45 * pil;
  },
  leather(u, v, o) {
    const grain = worley(u, v, 90, 41);
    const big = nz(u, v, 2, 14);
    const eu = Math.min(u, 1 - u);
    const ev = Math.min(v, 1 - v);
    const e = Math.min(eu, ev);
    const pillow = sm(0.0, 0.12, e);
    const seamLine = e < 0.006;
    const st1 = Math.abs(e - 0.028) < 0.0035;
    const along = eu < ev ? v : u;
    const stitch = st1 && frac(along * 70) < 0.6;
    const k = 0.48 * (0.9 + 0.15 * big) * (0.92 + 0.1 * grain);
    set(o, k, k, k, 0.42 + 0.16 * grain + 0.1 * (1 - pillow) - 0.08 * big, 0);
    o.h = pillow * 0.006 - grain * 0.0002;
    if (seamLine) o.h -= 0.0012;
    if (stitch) {
      set(o, 0.62, 0.6, 0.55, 0.65, 0);
      o.h += 0.0003;
    }
    o.ao = seamLine ? 0.45 : 0.7 + 0.3 * pillow;
  },
  veneer(u, v, o) {
    const w = nz(u, v, 2, 15);
    const rings = frac(v * 18 + w * 3.2 + nz(u, v * 4, 1, 16) * 1.5);
    const s = sm(0.0, 0.25, rings) * sm(1.0, 0.55, rings);
    const pore = nz(u * 0.25, v, 40, 17) > 0.62 ? 1 : 0;
    const k = 0.75 + 0.5 * s - 0.25 * pore;
    set(o, 0.105 * k, 0.058 * k, 0.032 * k, 0.3 + 0.08 * w + pore * 0.15, 0);
    o.h = -pore * 0.00006 + s * 0.00002;
    o.ao = 1;
  },
  warmPanel(u, v, o) {
    const ev = Math.min(v, 1 - v);
    const eu = Math.min(u, 1 - u);
    const seam = sm(0.002, 0.004, Math.min(ev, eu));
    const groove = 1 - sm(0.0015, 0.0035, Math.abs(v - 0.5));
    const n1 = nz(u, v, 2, 18);
    const fine = nz(u, v, 24, 19);
    const k = (0.94 + 0.08 * n1 + 0.04 * fine) * (0.8 + 0.2 * seam);
    set(o, 0.4 * k, 0.36 * k, 0.315 * k, 0.5 + 0.1 * fine, 0);
    o.h = -0.0015 * (1 - seam) - 0.001 * groove + 0.00005 * fine;
    o.ao = (0.55 + 0.45 * seam) * (1 - 0.3 * groove);
  },
  fabric(u, v, o) {
    const wa = Math.sin(u * Math.PI * 2 * 90) * 0.5 + 0.5;
    const wb = Math.sin(v * Math.PI * 2 * 90) * 0.5 + 0.5;
    const fz = nz(u, v, 8, 20);
    const t = (Math.floor(u * 90) + Math.floor(v * 90)) & 1 ? wa : wb;
    const k = 0.55 * (0.85 + 0.15 * t) * (0.9 + 0.2 * fz);
    set(o, k, k, k, 0.88, 0);
    o.h = t * 0.0002 + fz * 0.0003;
    o.ao = 0.85 + 0.15 * t;
  },
  darkFloor(u, v, o) {
    const eu = Math.abs(frac(u * 2) - 0.5);
    const ev = Math.abs(frac(v * 2) - 0.5);
    const seam = sm(0.497, 0.493, Math.max(eu, ev));
    const sp = nz(u, v, 40, 21);
    const sc = nz(u, v * 3, 3, 22);
    const k = 0.055 * (0.85 + 0.35 * sp) + 0.02 * sm(0.6, 0.8, sc);
    set(o, k, k * 0.98, k * 0.95, 0.5 + 0.2 * sc - 0.1 * sp, 0);
    o.h = -0.001 * (1 - seam) + 0.00003 * sp;
    o.ao = 0.5 + 0.5 * seam;
  },
  netting(u, v, o) {
    const P = 4;
    const a = frac((u + v) * P);
    const b = frac((u - v) * P);
    const da = Math.abs(a - 0.5);
    const db = Math.abs(b - 0.5);
    const ra = sm(0.47, 0.44, da);
    const rb = sm(0.47, 0.44, db);
    const knot = da > 0.4 && db > 0.4 ? 1 : 0;
    const rope = Math.max(ra, rb, knot);
    const braid = frac((ra > rb ? b : a) * 14) < 0.5 ? 0.85 : 1;
    const k = 0.07 * braid;
    set(o, k, k, k * 1.05, 0.8, 0);
    o.a = rope > 0.5 ? 1 : 0;
    o.h = rope * 0.004 + knot * 0.002;
    o.ao = 0.6 + 0.4 * rope;
  },
  hazard(u, v, o) {
    const s = frac(u * 4 + v);
    const yel = s < 0.5;
    const chip = nz(u, v, 6, 23);
    const worn = chip > 0.66 || v < 0.06 || v > 0.94;
    if (worn) set(o, 0.2, 0.2, 0.21, 0.4, 1);
    else if (yel) set(o, 0.62, 0.4, 0.015, 0.55, 0);
    else set(o, 0.025, 0.025, 0.025, 0.6, 0);
    o.h = worn ? -0.0002 : 0;
    o.ao = 1;
  },
  seam(u, v, o) {
    const g1 = Math.abs(v - 0.14) < 0.035 || Math.abs(v - 0.86) < 0.035;
    const fu = (frac(u) - 0.5) * 4.17; // repeat is 0.25 x 0.06 m: aspect 4.17
    const fv = v - 0.5;
    const r = Math.hypot(fu, fv);
    const hex = Math.max(Math.abs(fu), Math.abs(fu) * 0.5 + Math.abs(fv) * 0.866);
    const n = nz(u, v, 4, 24);
    set(o, 0.22 + 0.06 * n, 0.23 + 0.06 * n, 0.25 + 0.06 * n, 0.45, 1);
    o.h = g1 ? -0.0008 : 0;
    o.ao = g1 ? 0.5 : 1;
    if (hex < 0.2) {
      o.h = 0.002 - (r < 0.08 ? 0.0006 : 0);
      set(o, 0.42, 0.42, 0.43, 0.32, 1);
      o.ao = 1;
    } else if (r < 0.26) o.ao = 0.7;
  },
  vent(u, v, o) {
    const fu = frac(u);
    const sl = frac(v * 4);
    const open = fu > 0.08 && fu < 0.92 && v > 0.12 && v < 0.88 && sl > 0.3;
    if (open) {
      set(o, 0.008, 0.008, 0.008, 0.9, 0);
      o.h = -0.004;
      o.ao = 0.15;
    } else {
      set(o, 0.22, 0.23, 0.24, 0.45, 1);
      o.h = sl <= 0.3 && v > 0.12 && v < 0.88 ? 0.001 * Math.sin((sl / 0.3) * Math.PI) : 0;
      o.ao = 0.85;
    }
  },
};

// ---------------------------------------------------------------------------------------------------------
// the atlas

export interface SurfaceAtlas {
  size: number;
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  ormMap: THREE.DataTexture;
  /** GPU bytes incl. mips. */
  bytes: number;
  /** Generation time, ms. */
  genMs: number;
}

const L2S = new Uint8Array(4096);
for (let i = 0; i < 4096; i++) {
  const c = i / 4095;
  L2S[i] = Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
}
const toS = (c: number): number => L2S[Math.max(0, Math.min(4095, (c * 4095) | 0))];

function drawStencil(w: number, h: number): Uint8ClampedArray | null {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const g = cv.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#222';
  g.fillRect(0, 0, w, h);
  const sw = w / 4;
  const sh = h / 4;
  STENCIL_LABELS.forEach((label, i) => {
    const x = (i % 4) * sw;
    const y = Math.floor(i / 4) * sh;
    const p = Math.max(1, sh * 0.06);
    if (label === 'flat') {
      g.fillStyle = '#fff';
      g.fillRect(x, y, sw, sh);
      return;
    }
    if (label.startsWith('ui')) {
      g.fillStyle = '#05080a';
      g.fillRect(x, y, sw, sh);
      g.strokeStyle = '#3fd8f0';
      g.fillStyle = '#3fd8f0';
      g.lineWidth = Math.max(1, sh * 0.03);
      const k = Number(label[2]);
      for (let j = 0; j < 6; j++) {
        const bw = sw * (0.05 + 0.12 * hash(j, k, 5));
        g.globalAlpha = 0.85;
        g.fillRect(x + sw * 0.04, y + sh * (0.12 + j * 0.13), bw, sh * 0.06);
        g.globalAlpha = 0.45;
        g.fillRect(x + sw * 0.22, y + sh * (0.12 + j * 0.13), sw * 0.18 * hash(j, k, 9), sh * 0.04);
      }
      g.globalAlpha = 0.9;
      g.beginPath();
      g.arc(x + sw * 0.7, y + sh * 0.5, sh * 0.32, -2.4, 2.4 * (0.2 + 0.6 * hash(k, 1, 1)));
      g.stroke();
      g.beginPath();
      for (let j = 0; j <= 20; j++) {
        const xx = x + sw * (0.45 + j * 0.0125);
        const yy = y + sh * (0.75 - 0.25 * hash(j, k, 3));
        if (j === 0) g.moveTo(xx, yy);
        else g.lineTo(xx, yy);
      }
      g.stroke();
      g.globalAlpha = 1;
      g.strokeStyle = '#1d6f80';
      g.strokeRect(x + p, y + p, sw - 2 * p, sh - 2 * p);
      return;
    }
    const dark = i % 3 === 1;
    g.fillStyle = dark ? '#1c1d20' : '#cfcfc8';
    g.fillRect(x + p, y + p, sw - 2 * p, sh - 2 * p);
    g.fillStyle = i % 4 === 2 ? '#c8222a' : '#e0a514';
    g.fillRect(x + p, y + p, sh * 0.22, sh - 2 * p);
    g.fillStyle = dark ? '#d8d8d0' : '#26272a';
    g.font = `bold ${Math.round(sh * 0.5)}px "Helvetica Neue", Arial, sans-serif`;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    const tx = x + p + sh * 0.4;
    const maxW = sw - 2 * p - sh * 0.55;
    const tw = g.measureText(label).width;
    g.save();
    g.translate(tx, y + sh * 0.53);
    if (tw > maxW) g.scale(maxW / tw, 1);
    g.fillText(label, 0, 0);
    g.restore();
  });
  return g.getImageData(0, 0, w, h).data;
}

function generate(S: number): SurfaceAtlas {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  NZ = noiseTable();
  const alb = new Uint8Array(S * S * 4);
  const nrm = new Uint8Array(S * S * 4);
  const orm = new Uint8Array(S * S * 4);
  const H = new Float32Array(S * S);
  const px: Px = { h: 0, r: 0, g: 0, b: 0, ro: 0, me: 0, ao: 1, a: 1 };
  for (let ti = 0; ti < 16; ti++) {
    const id = TILE_IDS[ti];
    const [ru, rv, rdu, rdv] = tileRect(ti);
    // the cell including gutters
    let cx0: number, cx1: number, cy0: number, cy1: number;
    if (ti < 12) {
      cx0 = Math.round((ti % 4) * 0.25 * S);
      cx1 = Math.round(((ti % 4) + 1) * 0.25 * S);
      cy0 = Math.round(Math.floor(ti / 4) * 0.25 * S);
      cy1 = Math.round((Math.floor(ti / 4) + 1) * 0.25 * S);
    } else {
      cx0 = 0;
      cx1 = S;
      cy0 = Math.round(STRIPS[id][0] * S);
      cy1 = Math.round(STRIPS[id][1] * S);
    }
    const strip = ti >= 12;
    if (id === 'stencil') {
      const w = cx1 - cx0;
      const h = cy1 - cy0;
      const img = drawStencil(Math.round(rdu * S), Math.round(rdv * S));
      const iw = Math.round(rdu * S);
      const ih = Math.round(rdv * S);
      for (let y = cy0; y < cy1; y++)
        for (let x = cx0; x < cx1; x++) {
          const ix = Math.max(0, Math.min(iw - 1, Math.floor((x + 0.5) - ru * S)));
          const iy = Math.max(0, Math.min(ih - 1, Math.floor((y + 0.5) - rv * S)));
          const i = (y * S + x) * 4;
          const j = (iy * iw + ix) * 4;
          alb[i] = img ? img[j] : 180;
          alb[i + 1] = img ? img[j + 1] : 180;
          alb[i + 2] = img ? img[j + 2] : 180;
          alb[i + 3] = 255;
          orm[i] = 255;
          orm[i + 1] = 120;
          orm[i + 2] = 0;
          orm[i + 3] = 255;
          H[y * S + x] = 0;
        }
      void w;
      void h;
      continue;
    }
    const gen = GEN[id];
    if (!gen) continue;
    for (let y = cy0; y < cy1; y++) {
      let v = ((y + 0.5) / S - rv) / rdv;
      v = strip ? Math.min(0.9999, Math.max(0, v)) : frac(v);
      for (let x = cx0; x < cx1; x++) {
        const u = frac(((x + 0.5) / S - ru) / rdu);
        px.h = 0;
        px.ao = 1;
        px.a = 1;
        gen(u, v, px);
        const i = (y * S + x) * 4;
        alb[i] = toS(Math.min(0.8, px.r));
        alb[i + 1] = toS(Math.min(0.8, px.g));
        alb[i + 2] = toS(Math.min(0.8, px.b));
        alb[i + 3] = px.a >= 0.5 ? 255 : 0;
        orm[i] = Math.round(sat(px.ao) * 255);
        orm[i + 1] = Math.round(sat(Math.max(0.05, px.ro)) * 255);
        orm[i + 2] = Math.round(sat(px.me) * 255);
        orm[i + 3] = 255;
        H[y * S + x] = px.h;
      }
    }
    // normals from the height field (metres), clamped inside the cell
    const [mu, mv] = TILE_METRES[id];
    const dx = mu / (rdu * S);
    const dy = mv / (rdv * S);
    for (let y = cy0; y < cy1; y++) {
      const ya = Math.max(cy0, y - 1);
      const yb = Math.min(cy1 - 1, y + 1);
      for (let x = cx0; x < cx1; x++) {
        const xa = Math.max(cx0, x - 1);
        const xb = Math.min(cx1 - 1, x + 1);
        const gx = (H[y * S + xb] - H[y * S + xa]) / ((xb - xa) * dx);
        const gy = (H[yb * S + x] - H[ya * S + x]) / ((yb - ya) * dy);
        const l = 1 / Math.sqrt(gx * gx + gy * gy + 1);
        const i = (y * S + x) * 4;
        nrm[i] = Math.round((-gx * l * 0.5 + 0.5) * 255);
        nrm[i + 1] = Math.round((-gy * l * 0.5 + 0.5) * 255);
        nrm[i + 2] = Math.round((l * 0.5 + 0.5) * 255);
        nrm[i + 3] = 255;
      }
    }
  }
  const mk = (d: Uint8Array, srgb: boolean): THREE.DataTexture => {
    const t = new THREE.DataTexture(d, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = S >= 2048 ? 8 : S >= 1024 ? 4 : 1;
    t.flipY = false;
    t.needsUpdate = true;
    return t;
  };
  const genMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
  return {
    size: S,
    map: mk(alb, true),
    normalMap: mk(nrm, false),
    ormMap: mk(orm, false),
    bytes: Math.round(S * S * 4 * 3 * 1.334),
    genMs,
  };
}

const atlases = new Map<number, { atlas: SurfaceAtlas; refs: number }>();
/** The shared atlas at `size` (generated on first use, reference counted). */
export function acquireSurfaceAtlas(size: number): SurfaceAtlas {
  let e = atlases.get(size);
  if (!e) {
    e = { atlas: generate(size), refs: 0 };
    atlases.set(size, e);
  }
  e.refs++;
  return e.atlas;
}
export function releaseSurfaceAtlas(a: SurfaceAtlas): void {
  const e = atlases.get(a.size);
  if (!e || e.atlas !== a) return;
  if (--e.refs > 0) return;
  a.map.dispose();
  a.normalMap.dispose();
  a.ormMap.dispose();
  atlases.delete(a.size);
}

// ---------------------------------------------------------------------------------------------------------
// a small environment cube for reflections (PMREM'd by three on first use): bright light strips overhead,
// mid walls with light lines, dark floor. Reflections are scaled by the local baked light in the shader.

export function createReflectionCube(warm: boolean): THREE.CubeTexture | null {
  if (typeof document === 'undefined') return null;
  const faces: HTMLCanvasElement[] = [];
  const N = 64;
  const tone = warm ? [255, 214, 170] : [235, 242, 255];
  const rgb = (k: number): string => `rgb(${Math.round(tone[0] * k)},${Math.round(tone[1] * k)},${Math.round(tone[2] * k)})`;
  for (let f = 0; f < 6; f++) {
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const g = c.getContext('2d');
    if (g) {
      if (f === 2) {
        g.fillStyle = rgb(0.35);
        g.fillRect(0, 0, N, N);
        g.fillStyle = rgb(1);
        for (let i = 0; i < 3; i++) g.fillRect(8 + i * 20, 4, 6, N - 8);
      } else if (f === 3) {
        g.fillStyle = rgb(0.06);
        g.fillRect(0, 0, N, N);
      } else {
        const gr = g.createLinearGradient(0, 0, 0, N);
        gr.addColorStop(0, rgb(0.55));
        gr.addColorStop(0.5, rgb(0.32));
        gr.addColorStop(1, rgb(0.08));
        g.fillStyle = gr;
        g.fillRect(0, 0, N, N);
        g.fillStyle = rgb(0.95);
        g.fillRect(0, 5, N, 3);
        g.fillStyle = rgb(0.12);
        for (let i = 0; i < 4; i++) g.fillRect(i * 16 + 2, 0, 3, N);
      }
    }
    faces.push(c);
  }
  const t = new THREE.CubeTexture(faces);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------------------------------------
// materials

export interface SurfaceShared {
  uTiles: { value: THREE.Vector4[] };
  /** Lights-off lightmap (RGBM), and the on/off blend (1 = on). */
  uLmB: { value: THREE.Texture | null };
  uLmMix: { value: number };
  /** How much the normal map tilts the baked light toward "up" (light comes mostly from overhead). */
  uUpK: { value: number };
  /** Reflection strength per unit of baked irradiance. */
  uSpecK: { value: number };
  /** Glow levels per group: main, always, emergency, blink. */
  uGlow: { value: THREE.Vector4 };
  uGain: { value: number };
}

export const RGBM_RANGE = 8;

export function createSurfaceShared(): SurfaceShared {
  return {
    uTiles: { value: TILE_IDS.map((_, i) => new THREE.Vector4(...tileRect(i))) },
    uLmB: { value: null },
    uLmMix: { value: 1 },
    uUpK: { value: 0.55 },
    uSpecK: { value: 0.5 },
    uGlow: { value: new THREE.Vector4(1, 1, 0.3, 1) },
    uGain: { value: 1 },
  };
}

export type SurfaceKind = 'main' | 'cut' | 'glow';

/**
 * A MeshStandardMaterial that samples the atlas by the `tile` attribute. With `lightMap` (RGBM, uv channel 1)
 * the baked light replaces ambient and scales the reflections; without it the material is lit by scene lights
 * and the env map as usual (cockpit / exterior adoption).
 */
export function surfaceMaterial(
  atlas: SurfaceAtlas,
  shared: SurfaceShared,
  kind: SurfaceKind,
  opts: { lightMap?: THREE.Texture | null; envMap?: THREE.Texture | null } = {},
): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: kind === 'glow' ? 0x000000 : 0xffffff,
    map: atlas.map,
    normalMap: atlas.normalMap,
    roughnessMap: atlas.ormMap,
    metalnessMap: atlas.ormMap,
    aoMap: atlas.ormMap,
    aoMapIntensity: 1,
    roughness: 1,
    metalness: 1,
    vertexColors: true,
    envMap: opts.envMap ?? null,
    envMapIntensity: 1,
    alphaTest: kind === 'cut' ? 0.5 : 0,
    side: kind === 'cut' ? THREE.DoubleSide : THREE.FrontSide,
  });
  const lm = opts.lightMap ?? null;
  if (lm) {
    m.lightMap = lm;
    m.lightMapIntensity = Math.PI;
  }
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTiles = shared.uTiles;
    sh.uniforms.uLmB = shared.uLmB;
    sh.uniforms.uLmMix = shared.uLmMix;
    sh.uniforms.uUpK = shared.uUpK;
    sh.uniforms.uSpecK = shared.uSpecK;
    sh.uniforms.uGlow = shared.uGlow;
    sh.uniforms.uGain = shared.uGain;
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float tile;\nuniform vec4 uTiles[16];\nuniform vec4 uGlow;\nvarying vec4 vTile;\nvarying vec3 vUpV;\nvarying float vGlowK;',
      )
      .replace(
        '#include <uv_vertex>',
        '#include <uv_vertex>\nfloat tlI = mod(tile + 0.25, 16.0);\nfloat tlG = floor((tile + 0.25) / 16.0);\nvTile = uTiles[int(tlI)];\nvGlowK = dot(uGlow, vec4(equal(vec4(tlG), vec4(0.0, 1.0, 2.0, 3.0))));\nvUpV = normalize((viewMatrix * vec4(normalize((modelMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz), 0.0)).xyz);',
      );
    let f = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec4 vTile;\nvarying vec3 vUpV;\nvarying float vGlowK;\nuniform sampler2D uLmB;\nuniform float uLmMix;\nuniform float uUpK;\nuniform float uSpecK;\nuniform float uGain;`,
      )
      .replace(
        'void main() {',
        `void main() {
  vec2 tlR = vMapUv;
  vec2 tlUV = vTile.xy + fract(tlR) * vTile.zw;
  float tlCap = min(vTile.z, vTile.w) * 0.125;
  vec2 tlDx = dFdx(tlR) * vTile.zw;
  vec2 tlDy = dFdy(tlR) * vTile.zw;
  tlDx *= min(1.0, tlCap / max(length(tlDx), 1e-6));
  tlDy *= min(1.0, tlCap / max(length(tlDy), 1e-6));
  vec4 tlMapS = textureGrad(map, tlUV, tlDx, tlDy);`,
      )
      .replace('#include <map_fragment>', 'diffuseColor *= tlMapS;')
      .replace(
        '#include <roughnessmap_fragment>',
        'vec4 tlOrm = textureGrad(roughnessMap, tlUV, tlDx, tlDy);\nfloat roughnessFactor = roughness * tlOrm.g;',
      )
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = metalness * tlOrm.b;')
      .replace(
        '#include <normal_fragment_maps>',
        THREE.ShaderChunk.normal_fragment_maps.replace('texture2D( normalMap, vNormalMapUv )', 'textureGrad( normalMap, tlUV, tlDx, tlDy )'),
      )
      .replace('#include <aomap_fragment>', THREE.ShaderChunk.aomap_fragment.replace('texture2D( aoMap, vAoMapUv ).r', 'tlOrm.r'));
    if (kind === 'glow') f = f.replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance = vColor.rgb * tlMapS.rgb * vGlowK * uGain;');
    if (lm) {
      f = f.replace(
        '#include <lights_fragment_maps>',
        `#if defined( RE_IndirectDiffuse )
  vec4 tlA = texture2D( lightMap, vLightMapUv );
  vec4 tlB = texture2D( uLmB, vLightMapUv );
  vec3 tlLm = mix( tlB.rgb * tlB.a, tlA.rgb * tlA.a, uLmMix ) * ${RGBM_RANGE.toFixed(1)} * lightMapIntensity;
  float tlUp = 1.0 + uUpK * ( dot( normal, vUpV ) - dot( nonPerturbedNormal, vUpV ) );
  irradiance += tlLm * max( tlUp, 0.2 );
#endif
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
  float tlL = dot( tlLm, vec3( 0.2126, 0.7152, 0.0722 ) ) * uSpecK;
  radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness ) * tlL;
#endif`,
      );
    }
    sh.fragmentShader = f;
  };
  m.customProgramCacheKey = () => `corvane-surface-${kind}-${lm ? 'lm' : 'lit'}`;
  return m;
}
