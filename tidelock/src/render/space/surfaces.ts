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
// diffuse. Sizes: 2048 ultra (64 MB with mips), 1024 high and medium (16 MB), 512 low (4 MB). The atlas is shared
// and reference counted: the cockpit and exterior can adopt it with acquireSurfaceAtlas + surfaceMaterial.
//
// PHOTO DETAIL (photo/detail.ts): on top of the trim, every tile that has a photo-scanned counterpart (TILE_PHOTO)
// blends it in the same shader — detail uv = metres / photo tileMetres; colour = trim x (photo / photo mean albedo);
// normal = whiteout blend of the photo normal into the trim normal; AO x= photo AO; roughness += photo roughness -
// photo mean roughness; metalness stays the trim's. A second lookup of the same photo, 5.8x larger and rotated,
// modulates the colour at low frequency so big surfaces do not repeat. Cut-out sets (grating, netting) REPLACE the
// trim (their own colour, normal, roughness and opacity). PHOTO_GLSL / photoConstsGlsl() let the cockpit, hull and
// props shaders sample the same arrays with their own projections.
//
// RAY-TRACER RECORD (read by the lighting engineer's src/render/rt): every mesh built on these materials carries
//   mesh.userData.rt = {
//     albedo: [r, g, b],      linear, area-weighted mean over the mesh (vertex colour x tile mean), for a quick read
//     roughness, metalness,   area-weighted means
//     tiles: RT_TILE,         per tile index (vertex attribute `tile` % 16): { albedo, roughness, metalness } of the
//                             surface as shaded (trim + photo calibrated: the photo blend preserves the mean)
//     perVertex: 'tile+color' albedo of a hit = RT_TILE[tile % 16].albedo x vertex `color` (barycentric)
//     demodulate: { map, uv: 'uv', tileRect: 'uTiles', photo }  the textures that carry the surface's colour detail:
//                             the atlas albedo (uv wrapped into the tile rect, see tileRect) and the photo albedo
//                             arrays (photo.uniforms.uPhAlbB / uPhAlbS, layer TILE_PHOTO, uv x TILE_PHOTO scale).
//                             Trace light only, divide nothing: multiply the traced irradiance by the albedo the
//                             raster pass already shaded (or by these maps) so sunlit texture detail survives.
//   }
// The cockpit sets the same record with tiles: null and perVertex: 'color+pbr' (albedo = vertex colour, roughness
// = pbr.x, metalness = pbr.y), the hull (hullMaterials.ts) per material with perVertex: 'aTint^2 x livery'.

import * as THREE from 'three';
import type { Quality } from '../pipeline';
import { PHOTO_MATERIAL_IDS, type PhotoMaterialId } from './photo/index';
import { PHOTO_PACK } from './photo/pack.generated';
import { PHOTO_LAYER, acquirePhotoDetail, releasePhotoDetail, type PhotoDetail } from './photo/detail';

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
  whitePanel: [0.66, 0.655, 0.64], brushed: [0.25, 0.24, 0.23], gunmetal: [0.12, 0.12, 0.13], tread: [0.075, 0.075, 0.077],
  grating: [0.08, 0.08, 0.08], padded: [0.5, 0.5, 0.5], leather: [0.45, 0.45, 0.45], veneer: [0.09, 0.05, 0.03],
  warmPanel: [0.25, 0.21, 0.17], fabric: [0.55, 0.55, 0.55], darkFloor: [0.087, 0.083, 0.077], netting: [0.05, 0.05, 0.045],
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
  // 'high' stays at 1024: the photo arrays (47.6 MB) carry the close-up detail now, the trim only shapes it
  return q === 'low' ? 512 : q === 'ultra' ? 2048 : 1024;
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
/** Time spent drawing the stencil block on a canvas (diagnostics). */
export let STENCIL_MS = 0;
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
    // off-white clear-coated paint: albedo ~0.69 (0.65-0.75), satin
    const base = 0.69 * (0.95 + 0.1 * n1) * (1 - grime * 0.22) * (1 + sc * 0.06);
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
    const st = nz(u, v * 90, 1, 4) * 0.6 + nz(u * 0.5, v * 180, 2, 5) * 0.4;
    const n1 = nz(u, v, 2, 6);
    const sc = scratch(u, v, 7, 21, 0.015);
    const k = 0.95 + 0.07 * st + 0.04 * n1 + sc * 0.08;
    // brushed stainless: F0 ~0.56, faintly warm, roughness 0.3-0.45 (smoother read as a mirror catching the probe)
    set(o, 0.58 * k, 0.56 * k, 0.53 * k, 0.34 + 0.1 * st + 0.06 * n1 - sc * 0.06, 1);
    o.h = 0.000008 * st;
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
    // dark rubber: albedo 0.05-0.08, roughness ~0.7 (polished where the boots wear the lozenges)
    let al = 0.062 + loz * 0.018 * wear + (1 - loz) * 0.02 * dust;
    let ro = 0.72 - loz * 0.14 * wear;
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
    const rings = frac(v * 34 + w * 1.4 + nz(u, v * 6, 1, 16) * 0.7);
    const s = sm(0.0, 0.3, rings) * sm(1.0, 0.6, rings);
    const pore = sm(0.6, 0.72, nz(u * 0.25, v, 12, 17));
    const k = 0.8 + 0.32 * s - 0.1 * pore + 0.1 * (w - 0.5);
    set(o, 0.09 * k, 0.052 * k, 0.03 * k, 0.28 + 0.06 * w + pore * 0.06, 0);
    o.h = -pore * 0.00002 + s * 0.00001;
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
    set(o, 0.27 * k, 0.225 * k, 0.185 * k, 0.48 + 0.12 * fine, 0);
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
    o.h = t * 0.0005 + fz * 0.0007;
    o.ao = 0.85 + 0.15 * t;
  },
  darkFloor(u, v, o) {
    const eu = Math.abs(frac(u * 2) - 0.5);
    const ev = Math.abs(frac(v * 2) - 0.5);
    const seam = sm(0.497, 0.493, Math.max(eu, ev));
    const sp = nz(u, v, 40, 21);
    const sc = nz(u, v * 3, 3, 22);
    // satin warm-grey composite deck (albedo ~0.085, was 0.055; roughness ~0.33, was 0.46): a sun patch on it
    // reads as a sharp, slightly glossy pool of light instead of a dull smear
    const k = 0.085 * (0.92 + 0.16 * sp) + 0.01 * sm(0.62, 0.8, sc);
    set(o, k, k * 0.95, k * 0.88, 0.33 + 0.08 * sc - 0.05 * sp, 0);
    o.h = -0.001 * (1 - seam) + 0.00003 * sp;
    o.ao = 0.5 + 0.5 * seam;
  },
  netting(u, v, o) {
    const P = 4;
    const a = frac((u + v) * P);
    const b = frac((u - v) * P);
    const da = Math.abs(a - 0.5);
    const db = Math.abs(b - 0.5);
    const ra = sm(0.43, 0.465, da);
    const rb = sm(0.43, 0.465, db);
    const knot = da > 0.42 && db > 0.42 ? 1 : 0;
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
  // CPU-backed: the read-back below must not wait for the GPU to drain the loading work queued before it
  const g = cv.getContext('2d', { willReadFrequently: true });
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

function* generateSteps(S: number): Generator<void, SurfaceAtlas, void> {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  let paused = 0;
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
      const ts = typeof performance !== 'undefined' ? performance.now() : 0;
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
      STENCIL_MS = (typeof performance !== 'undefined' ? performance.now() : 0) - ts;
      continue;
    }
    const gen = GEN[id];
    if (!gen) continue;
    for (let y = cy0; y < cy1; y++) {
      if ((y & 15) === 15) {
        const tp = typeof performance !== 'undefined' ? performance.now() : 0;
        yield;
        paused += (typeof performance !== 'undefined' ? performance.now() : 0) - tp;
      }
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
  const genMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0 - paused;
  return {
    size: S,
    map: mk(alb, true),
    normalMap: mk(nrm, false),
    ormMap: mk(orm, false),
    bytes: Math.round(S * S * 4 * 3 * 1.334),
    genMs,
  };
}

function generate(S: number): SurfaceAtlas {
  const g = generateSteps(S);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/**
 * The shared atlas at `size`, generated in time slices: call step(ms) once per frame until it returns the atlas
 * (already acquired for the caller). Lets 'high' start on a smaller atlas and swap the full one in.
 */
export function acquireSurfaceAtlasProgressive(size: number): { step(budgetMs: number): SurfaceAtlas | null } {
  const have = atlases.get(size);
  if (have) {
    have.refs++;
    return { step: () => have.atlas };
  }
  const g = generateSteps(size);
  let done: SurfaceAtlas | null = null;
  return {
    step(budgetMs: number): SurfaceAtlas | null {
      if (done) return done;
      const t = performance.now();
      while (performance.now() - t < budgetMs) {
        const r = g.next();
        if (r.done) {
          const e = atlases.get(size);
          if (e) {
            for (const tx of [r.value.map, r.value.normalMap, r.value.ormMap]) tx.dispose();
            e.refs++;
            done = e.atlas;
          } else {
            atlases.set(size, { atlas: r.value, refs: 1 });
            done = r.value;
          }
          return done;
        }
      }
      return null;
    },
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

// ---------------------------------------------------------------------------------------------------------
// photo detail: which photo set each tile blends, and how strongly

export interface TilePhoto {
  id: PhotoMaterialId;
  /** colour, normal, roughness strength (0 = none, 1 = as scanned) and the low-frequency anti-repeat lookup */
  colour: number;
  normal: number;
  rough: number;
  macro: number;
  /** the photo replaces the trim (cut-out sets): its colour, normal, roughness, opacity; metalness `metal` */
  replace?: { metal: number };
}
export const TILE_PHOTO: Partial<Record<TileId, TilePhoto>> = {
  whitePanel: { id: 'whitePanel', colour: 1, normal: 1, rough: 1, macro: 0.35 },
  brushed: { id: 'brushed', colour: 0.8, normal: 0.8, rough: 0.8, macro: 0.25 },
  gunmetal: { id: 'gunmetal', colour: 1, normal: 1, rough: 1, macro: 0.3 },
  tread: { id: 'tread', colour: 1, normal: 1, rough: 0.8, macro: 0.25 },
  grating: { id: 'grating', colour: 1, normal: 1, rough: 1, macro: 0.2, replace: { metal: 0.9 } },
  padded: { id: 'fabric', colour: 0.8, normal: 0.8, rough: 0.8, macro: 0.2 },
  // grain and creases are what make leather read at arm's length: the scan's normal at 1.6x
  leather: { id: 'leather', colour: 1, normal: 1.6, rough: 1, macro: 0.3 },
  // walnut under a clear coat: the scan's raw-wood roughness only faintly shows through the lacquer
  veneer: { id: 'veneer', colour: 1, normal: 0.5, rough: 0.25, macro: 0.3 },
  warmPanel: { id: 'whitePanel', colour: 0.8, normal: 0.8, rough: 0.8, macro: 0.35 },
  // rugs, bedding, upholstery: the wool's relief and a stronger low-frequency mottle keep a rug from reading flat
  fabric: { id: 'fabric', colour: 1, normal: 2, rough: 1, macro: 0.5 },
  darkFloor: { id: 'whitePanel', colour: 0.9, normal: 0.8, rough: 0.8, macro: 0.4 },
  netting: { id: 'netting', colour: 1, normal: 1, rough: 1, macro: 0, replace: { metal: 0 } },
  hazard: { id: 'hullPaint', colour: 0.7, normal: 0.8, rough: 0.7, macro: 0 },
  seam: { id: 'gunmetal', colour: 0.8, normal: 0.6, rough: 0.8, macro: 0 },
  vent: { id: 'gunmetal', colour: 0.6, normal: 0.5, rough: 0.6, macro: 0 },
};

/** Per photo set, the constants a shader needs: (albedo layer, linear layer, 1/tileU, 1/tileV), (1/mean rgb, mean roughness). */
export function photoSetConsts(id: PhotoMaterialId): { a: [number, number, number, number]; b: [number, number, number, number] } {
  const L = PHOTO_LAYER[id];
  const set = PHOTO_PACK[id];
  const t = set.tileMetres;
  const m = set.meanAlbedo;
  return { a: [L.alb, L.lin, 1 / t[0], 1 / t[1]], b: [1 / Math.max(m[0], 0.01), 1 / Math.max(m[1], 0.01), 1 / Math.max(m[2], 0.01), set.meanRoughness] };
}

/**
 * GLSL constants for every photo set: `PH_A_<id>` = vec4(albedo layer, linear layer, 1/tileU m, 1/tileV m),
 * `PH_B_<id>` = vec4(1 / mean albedo rgb, mean roughness). For shaders that pick a set themselves.
 */
export function photoConstsGlsl(): string {
  const f = (x: number): string => x.toFixed(5);
  return PHOTO_MATERIAL_IDS.map((id) => {
    const c = photoSetConsts(id);
    return `const vec4 PH_A_${id} = vec4(${c.a.map(f).join(', ')});\nconst vec4 PH_B_${id} = vec4(${c.b.map(f).join(', ')});`;
  }).join('\n');
}

/** Samplers and helpers of the photo arrays (pair with photoDetail.uniforms). */
export const PHOTO_GLSL = /* glsl */ `
uniform mediump sampler2DArray uPhAlbB;
uniform mediump sampler2DArray uPhAlbS;
uniform mediump sampler2DArray uPhLin;
uniform float uPhOn;
vec4 phAlbedo(float alb, vec2 uv, vec2 dx, vec2 dy) {
  if (alb < 15.5) return textureGrad(uPhAlbB, vec3(uv, alb), dx, dy);
  return textureGrad(uPhAlbS, vec3(uv, alb - 16.0), dx, dy);
}
vec4 phLinear(float lin, vec2 uv, vec2 dx, vec2 dy) {
  return textureGrad(uPhLin, vec3(uv, lin), dx, dy);
}
// the same photo 5.8x larger and turned 37 deg: its luminance relative to the mean, to break the repeat
float phMacro(float alb, vec2 uv, vec2 dx, vec2 dy, vec3 invMean) {
  const mat2 R = mat2(0.8, 0.6, -0.6, 0.8);
  vec3 c = phAlbedo(alb, R * uv * 0.173 + vec2(0.37, 0.71), R * dx * 0.173, R * dy * 0.173).rgb * invMean;
  return clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.4, 1.8);
}
vec3 phNormal(vec4 lin, float k) {
  vec2 xy = (lin.rg * 2.0 - 1.0) * k;
  return vec3(xy, sqrt(max(0.0, 1.0 - min(dot(xy, xy), 0.96))));
}
// whiteout blend of a detail normal into a base normal (tangent space)
vec3 phWhiteout(vec3 a, vec3 b) {
  return normalize(vec3(a.xy + b.xy, a.z * b.z));
}
// alpha of a cut-out set kept from thinning out in the mips (log2 of texels per pixel at 512)
float phCoverage(float a, vec2 dx, vec2 dy) {
  float lod = max(0.0, 0.5 * log2(max(dot(dx, dx), dot(dy, dy))) + 9.0);
  return clamp(a * (1.0 + 0.3 * lod), 0.0, 1.0);
}
`;

/** Per-tile shaded means (trim + photo calibrated), linear, for bakes and the ray tracer. */
export interface RtSurface {
  albedo: P3;
  roughness: number;
  metalness: number;
}
const TILE_ROUGH: Record<TileId, number> = {
  whitePanel: 0.45, brushed: 0.38, gunmetal: 0.55, tread: 0.68, grating: 0.36, padded: 0.86, leather: 0.52, veneer: 0.3,
  warmPanel: 0.52, fabric: 0.88, darkFloor: 0.36, netting: 0.65, hazard: 0.56, seam: 0.45, vent: 0.5, stencil: 0.47,
};
const TILE_METAL: Record<TileId, number> = {
  whitePanel: 0.02, brushed: 1, gunmetal: 1, tread: 0.08, grating: 0.9, padded: 0, leather: 0, veneer: 0,
  warmPanel: 0, fabric: 0, darkFloor: 0, netting: 0, hazard: 0.2, seam: 1, vent: 0.6, stencil: 0,
};
/** RT_TILE[tile index]: albedo (metals: F0), roughness, metalness. */
export const RT_TILE: readonly RtSurface[] = TILE_IDS.map((id) => {
  const metal = TILE_METAL[id];
  const a = TILE_ALBEDO[id];
  // TILE_ALBEDO holds what diffuse bounces see (metals: a fraction of F0); give the ray tracer F0 for metals
  const k = metal > 0.5 ? 2.2 : 1;
  return { albedo: [Math.min(0.95, a[0] * k), Math.min(0.95, a[1] * k), Math.min(0.95, a[2] * k)] as P3, roughness: TILE_ROUGH[id], metalness: metal };
});

/** The ray-tracer record of a mesh on the surface materials (see the header). Area-weighted over its triangles. */
export function surfaceRtRecord(geo: THREE.BufferGeometry, atlas: SurfaceAtlas, shared: SurfaceShared): Record<string, unknown> {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
  const tile = geo.getAttribute('tile') as THREE.BufferAttribute | undefined;
  const col = geo.getAttribute('color') as THREE.BufferAttribute | undefined;
  const idx = geo.getIndex();
  const acc = [0, 0, 0, 0, 0];
  let area = 0;
  if (pos && tile && idx) {
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (let i = 0; i < idx.count; i += 3) {
      const i0 = idx.getX(i);
      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, idx.getX(i + 1));
      c.fromBufferAttribute(pos, idx.getX(i + 2));
      const ar = b.sub(a).cross(c.sub(a)).length() * 0.5;
      if (!(ar > 0)) continue;
      const t = RT_TILE[Math.round(tile.getX(i0)) % 16] ?? RT_TILE[0];
      const tr = col ? col.getX(i0) : 1;
      const tg = col ? col.getY(i0) : 1;
      const tb = col ? col.getZ(i0) : 1;
      acc[0] += ar * Math.min(0.95, t.albedo[0] * tr);
      acc[1] += ar * Math.min(0.95, t.albedo[1] * tg);
      acc[2] += ar * Math.min(0.95, t.albedo[2] * tb);
      acc[3] += ar * t.roughness;
      acc[4] += ar * t.metalness;
      area += ar;
    }
  }
  const k = area > 0 ? 1 / area : 0;
  return {
    albedo: area > 0 ? [acc[0] * k, acc[1] * k, acc[2] * k] : [0.5, 0.5, 0.5],
    roughness: area > 0 ? acc[3] * k : 0.5,
    metalness: area > 0 ? acc[4] * k : 0,
    tiles: RT_TILE,
    perVertex: 'tile+color',
    demodulate: { map: atlas.map, uv: 'uv', tileRect: shared.uTiles.value, photo: shared.photo ? shared.photo.uniforms : null, tilePhoto: TILE_PHOTO },
  };
}

// ---------------------------------------------------------------------------------------------------------
// materials

export interface SurfaceShared {
  uTiles: { value: THREE.Vector4[] };
  /** Lights-off lightmap (linear half float), and the on/off blend (1 = on). */
  uLmB: { value: THREE.Texture | null };
  uLmMix: { value: number };
  /** How much the normal map tilts the baked light toward "up" (light comes mostly from overhead). */
  uUpK: { value: number };
  /** Reflection strength per unit of baked irradiance. */
  uSpecK: { value: number };
  /** Glow levels per group: main, always, emergency, blink. */
  uGlow: { value: THREE.Vector4 };
  uGain: { value: number };
  /** Photo detail per tile: (u scale, v scale, linear layer or -1, albedo layer), (1/mean rgb, mean roughness),
   * (colour, normal, roughness, macro strength), (replace, replace metalness, 0, 0). */
  uPhA: { value: THREE.Vector4[] };
  uPhB: { value: THREE.Vector4[] };
  uPhC: { value: THREE.Vector4[] };
  uPhD: { value: THREE.Vector4[] };
  /** The shared photo arrays (null: trim only). */
  photo: PhotoDetail | null;
}

export const RGBM_RANGE = 8;

/** Shared uniforms of one set of surface materials. With a quality, the photo detail is acquired (release with
 * releaseSurfaceShared). */
export function createSurfaceShared(q?: Quality): SurfaceShared {
  const uPhA: THREE.Vector4[] = [];
  const uPhB: THREE.Vector4[] = [];
  const uPhC: THREE.Vector4[] = [];
  const uPhD: THREE.Vector4[] = [];
  TILE_IDS.forEach((tid) => {
    const tp = TILE_PHOTO[tid];
    if (!tp) {
      uPhA.push(new THREE.Vector4(0, 0, -1, 0));
      uPhB.push(new THREE.Vector4(1, 1, 1, 0.5));
      uPhC.push(new THREE.Vector4(0, 0, 0, 0));
      uPhD.push(new THREE.Vector4(0, 0, 0, 0));
      return;
    }
    const c = photoSetConsts(tp.id);
    const tm = TILE_METRES[tid];
    // the mesh uv is in repeats of the tile: metres = uv * TILE_METRES; photo uv = metres / photo tileMetres
    uPhA.push(new THREE.Vector4(tm[0] * c.a[2], tm[1] * c.a[3], c.a[1], c.a[0]));
    uPhB.push(new THREE.Vector4(...c.b));
    uPhC.push(new THREE.Vector4(tp.colour, tp.normal, tp.rough, tp.macro));
    uPhD.push(new THREE.Vector4(tp.replace ? 1 : 0, tp.replace?.metal ?? 0, 0, 0));
  });
  return {
    uTiles: { value: TILE_IDS.map((_, i) => new THREE.Vector4(...tileRect(i))) },
    uLmB: { value: null },
    uLmMix: { value: 1 },
    uUpK: { value: 0.55 },
    uSpecK: { value: 1.0 },
    uGlow: { value: new THREE.Vector4(1, 1, 0.3, 1) },
    uGain: { value: 1 },
    uPhA: { value: uPhA },
    uPhB: { value: uPhB },
    uPhC: { value: uPhC },
    uPhD: { value: uPhD },
    photo: q ? acquirePhotoDetail(q) : null,
  };
}

export function releaseSurfaceShared(s: SurfaceShared): void {
  if (s.photo) releasePhotoDetail(s.photo);
  s.photo = null;
}

export type SurfaceKind = 'main' | 'cut' | 'glow';

/**
 * A MeshStandardMaterial that samples the atlas by the `tile` attribute. With `lightMap` (linear, uv channel 1)
 * the baked light replaces ambient and scales the reflections; without it the material is lit by scene lights
 * and the env map as usual (cockpit / exterior adoption). With `shared.photo`, the photo detail blends in
 * (main and cut kinds).
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
  const photo = kind !== 'glow' ? shared.photo : null;
  // defines go into the source, not material.defines: the per-probe clones (probes.ts) copy() the material, and
  // MeshStandardMaterial.copy() resets `defines`
  const defs = photo ? (kind === 'cut' ? '#define TL_PHOTO\n#define TL_CUT\n' : '#define TL_PHOTO\n') : '';
  m.onBeforeCompile = (sh, renderer) => {
    sh.uniforms.uTiles = shared.uTiles;
    sh.uniforms.uLmB = shared.uLmB;
    sh.uniforms.uLmMix = shared.uLmMix;
    sh.uniforms.uUpK = shared.uUpK;
    sh.uniforms.uSpecK = shared.uSpecK;
    sh.uniforms.uGlow = shared.uGlow;
    sh.uniforms.uGain = shared.uGain;
    if (photo) {
      photo.noteRenderer(renderer);
      Object.assign(sh.uniforms, photo.uniforms, { uPhA: shared.uPhA, uPhB: shared.uPhB, uPhC: shared.uPhC, uPhD: shared.uPhD });
    }
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float tile;\nuniform vec4 uTiles[16];\nuniform vec4 uGlow;\nvarying vec4 vTile;\nvarying vec3 vUpV;\nvarying float vGlowK;\nvarying float vTileI;',
      )
      .replace(
        '#include <uv_vertex>',
        '#include <uv_vertex>\nfloat tlI = mod(tile + 0.25, 16.0);\nfloat tlG = floor((tile + 0.25) / 16.0);\nvTileI = floor(tlI);\nvTile = uTiles[int(tlI)];\nvGlowK = dot(uGlow, vec4(equal(vec4(tlG), vec4(0.0, 1.0, 2.0, 3.0))));\nvUpV = normalize((viewMatrix * vec4(normalize((modelMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz), 0.0)).xyz);',
      );
    let f = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec4 vTile;\nvarying vec3 vUpV;\nvarying float vGlowK;\nvarying float vTileI;\nuniform sampler2D uLmB;\nuniform float uLmMix;\nuniform float uUpK;\nuniform float uSpecK;\nuniform float uGain;
#ifdef TL_PHOTO
${PHOTO_GLSL}
uniform vec4 uPhA[16];
uniform vec4 uPhB[16];
uniform vec4 uPhC[16];
uniform vec4 uPhD[16];
#endif`,
      )
      .replace(
        'void main() {',
        `void main() {
  vec2 tlR = vMapUv;
  vec2 tlUV = vTile.xy + fract(tlR) * vTile.zw;
  float tlCap = min(vTile.z, vTile.w) * 0.125;
  vec2 tlRdx = dFdx(tlR);
  vec2 tlRdy = dFdy(tlR);
  vec2 tlDx = tlRdx * vTile.zw;
  vec2 tlDy = tlRdy * vTile.zw;
  tlDx *= min(1.0, tlCap / max(length(tlDx), 1e-6));
  tlDy *= min(1.0, tlCap / max(length(tlDy), 1e-6));
  vec4 tlMapS = textureGrad(map, tlUV, tlDx, tlDy);
#ifdef TL_PHOTO
  int phI = int(vTileI + 0.5);
  vec4 phA = uPhA[phI];
  vec4 phB = uPhB[phI];
  vec4 phC = uPhC[phI];
  bool phRepl = uPhD[phI].x > 0.5;
  bool phUse = uPhOn > 0.5 && phA.z > -0.5;
  vec4 phAlb = vec4(1.0);
  vec4 phLin = vec4(0.5, 0.5, 1.0, phB.w);
  float phMac = 1.0;
  if (phUse) {
    vec2 phUV = tlR * phA.xy;
    vec2 phDx = tlRdx * phA.xy;
    vec2 phDy = tlRdy * phA.xy;
    phAlb = phAlbedo(phA.w, phUV, phDx, phDy);
    phLin = phLinear(phA.z, phUV, phDx, phDy);
    if (phC.w > 0.0) phMac = mix(1.0, phMacro(phA.w, phUV, phDx, phDy, phB.rgb), phC.w);
    if (phRepl) phAlb.a = phCoverage(phAlb.a, phDx, phDy);
  }
#endif`,
      )
      .replace(
        '#include <map_fragment>',
        `diffuseColor *= tlMapS;
#ifdef TL_PHOTO
  if (phUse) {
    if (phRepl) {
      diffuseColor = vec4(phAlb.rgb * phMac, phAlb.a);
#ifndef TL_CUT
      diffuseColor.rgb *= mix(0.03, 1.0, phAlb.a);
#endif
    } else {
      diffuseColor.rgb *= mix(vec3(1.0), clamp(phAlb.rgb * phB.rgb, 0.0, 3.0), phC.x) * phMac;
    }
    diffuseColor.rgb = min(diffuseColor.rgb, vec3(0.9));
  }
#endif`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `vec4 tlOrm = textureGrad(roughnessMap, tlUV, tlDx, tlDy);
float roughnessFactor = roughness * tlOrm.g;
float tlAo = tlOrm.r;
float tlMetal = tlOrm.b;
#ifdef TL_PHOTO
  if (phUse) {
    if (phRepl) {
      roughnessFactor = mix(0.92, phLin.a, phAlb.a);
      tlMetal = uPhD[phI].y * step(0.5, phAlb.a);
      tlAo = mix(0.25, phLin.b, phAlb.a);
    } else {
      roughnessFactor = clamp(roughnessFactor + phC.z * (phLin.a - phB.w), 0.05, 1.0);
      tlAo *= phLin.b;
    }
  }
#endif`,
      )
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = metalness * tlMetal;')
      .replace(
        '#include <normal_fragment_maps>',
        `#ifdef USE_NORMALMAP_TANGENTSPACE
  vec3 mapN = textureGrad( normalMap, tlUV, tlDx, tlDy ).xyz * 2.0 - 1.0;
  mapN.xy *= normalScale;
#ifdef TL_PHOTO
  if (phUse) {
    vec3 phN = phNormal(phLin, phC.y);
    mapN = phRepl ? phN : phWhiteout(mapN, phN);
  }
#endif
  normal = normalize( tbn * mapN );
#endif`,
      )
      .replace('#include <aomap_fragment>', THREE.ShaderChunk.aomap_fragment.replace('texture2D( aoMap, vAoMapUv ).r', 'tlAo'));
    if (kind === 'glow') f = f.replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance = vColor.rgb * tlMapS.rgb * vGlowK * uGain;');
    if (lm) {
      f = f.replace(
        '#include <lights_fragment_maps>',
        `#if defined( RE_IndirectDiffuse )
  vec4 tlA = texture2D( lightMap, vLightMapUv );
  vec4 tlB = texture2D( uLmB, vLightMapUv );
  vec3 tlLm = mix( tlB.rgb, tlA.rgb, uLmMix ) * lightMapIntensity;
  float tlUp = 1.0 + uUpK * ( dot( normal, vUpV ) - dot( nonPerturbedNormal, vUpV ) );
  irradiance += tlLm * max( tlUp, 0.2 );
#endif
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
  float tlL = dot( tlLm, vec3( 0.2126, 0.7152, 0.0722 ) ) * uSpecK;
  radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness ) * tlL;
#endif`,
      );
    }
    sh.fragmentShader = defs + f;
  };
  m.customProgramCacheKey = () => `corvane-surface-2-${kind}-${lm ? 'lm' : 'lit'}${photo ? '-ph' : ''}`;
  return m;
}
