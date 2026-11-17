// Procedural hard-surface modelling toolkit shared by ships.ts and stations.ts.
//
// Everything is built through a MeshBuilder: primitives append vertices to one growable buffer per
// *channel* (hull / glass / glow / flare / decal), so a finished model is at most five draw calls no
// matter how many parts it has. Surface finish (paint, armour, heat tiles, bare metal, carbon, foil,
// radiator, ribbed), albedo, metalness, roughness and wear are per-vertex attributes interpreted by the
// hull uber-material in hullMaterials.ts, so one material covers every finish.
//
// Conventions
//   * metres, right-handed, ship-local axes (forward -Z, up +Y, right +X)
//   * UVs are in METRES of surface (consistent texel density everywhere); the material scales them per layer
//   * lofts / lathes: ring index 0 is the top centre (+Y) and runs toward +X; rings run from -Z to +Z
//   * a "Style" bundles channel + finish + tint; build them with hullStyle() / glowStyle() / flareStyle()…
//   * deterministic: all randomness comes from the builder's seeded generator
//
// Vertex format (all channels): position f32x3, normal f32x3, uv f32x2, aTint u8x4n (rgb = sqrt(linear
// colour), a = baked AO or decal opacity), aSurf u8x4n, aFx u8x4n.  See hullMaterials.ts for semantics.

import * as THREE from 'three';
import type { RGB } from '../../core/types';

// ------------------------------------------------------------------------------------------ channels

export const CH_HULL = 0;
export const CH_GLASS = 1;
export const CH_GLOW = 2;
export const CH_FLARE = 3;
export const CH_DECAL = 4;
export const CHANNEL_COUNT = 5;
export const CHANNEL_NAMES = ['hull', 'glass', 'glow', 'flare', 'decal'] as const;
export type ChannelName = (typeof CHANNEL_NAMES)[number];

/** Texture-array layers of the hull material. */
export const LAYER = {
  /** painted aerospace skin: panel seams, rivets, hatches */
  panel: 0,
  /** thick bolted armour plate */
  armor: 1,
  /** ceramic heat-shield tiles */
  tile: 2,
  /** bare machined / brushed metal */
  metal: 3,
  /** carbon composite weave */
  carbon: 4,
  /** crinkled multi-layer insulation foil */
  foil: 5,
  /** finned radiator panel */
  radiator: 6,
  /** corrugated container / tank wall */
  ribbed: 7,
} as const;

/** Modes of the glow (opaque emissive) material. */
export const GLOW = {
  /** constant light (light bars, lenses, screens) */
  steady: 0,
  /** row of lit windows; uv in metres, u along the strip */
  window: 1,
  /** engine bell interior: uv.y = 0 at the lip .. 1 at the injector */
  engine: 2,
  /** blinking lamp */
  blink: 3,
  /** hot radiator surface: follows the heat uniform */
  heat: 4,
} as const;

export interface Style {
  readonly ch: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** hull: baked AO multiplier; decal: opacity */
  readonly a: number;
  readonly s0: number;
  readonly s1: number;
  readonly s2: number;
  readonly s3: number;
  readonly f0: number;
  readonly f1: number;
  readonly f2: number;
  readonly f3: number;
}

export interface HullStyleOpts {
  /** paint wear 0..1 (how readily paint chips to bare metal along seams) */
  wear?: number;
  /** extra aerobraking-heat mask 0..1 (added to the automatic nose/belly mask) */
  heat?: number;
  /** engine-heat mask 0..1 (glows with throttle) */
  engineHeat?: number;
  /** constant AO multiplier 0..1 */
  ao?: number;
  /** grime amount 0..1 (default 0.5) */
  grime?: number;
  /** livery slot: 0 = use `tint` as is, 1 primary, 2 secondary, 3 accent (tint then multiplies the livery colour) */
  slot?: number;
}

/** Opaque PBR finish. `tint` is linear albedo (keep <= 0.8). */
export function hullStyle(layer: number, tint: RGB, metal: number, rough: number, o: HullStyleOpts = {}): Style {
  return {
    ch: CH_HULL,
    r: tint[0],
    g: tint[1],
    b: tint[2],
    a: o.ao ?? 1,
    s0: layer,
    s1: metal,
    s2: rough,
    s3: o.wear ?? 0.3,
    f0: o.heat ?? 0,
    f1: o.engineHeat ?? 0,
    f2: o.grime ?? 0.5,
    f3: (o.slot ?? 0) / 3,
  };
}

export function retint(st: Style, tint: RGB, mul = 1): Style {
  return { ...st, r: tint[0] * mul, g: tint[1] * mul, b: tint[2] * mul };
}

export interface GlowStyleOpts {
  /** blink period, s (mode blink) — up to 8 s */
  period?: number;
  /** blink phase 0..1 */
  phase?: number;
  /** blink duty 0..1 (fraction of the period the lamp is lit) */
  duty?: number;
  /** true: switched by ctx.lightsOn */
  switched?: boolean;
  /** window mode: window pitch, m (default 0.7) */
  cell?: number;
  /** window mode: the strip runs along uv.y instead of uv.x */
  alongV?: boolean;
}

/** Opaque emissive surface. `intensity` is HDR radiance (lights 2-8, engine cores 10-60). */
export function glowStyle(mode: number, color: RGB, intensity: number, o: GlowStyleOpts = {}): Style {
  return {
    ch: CH_GLOW,
    r: color[0],
    g: color[1],
    b: color[2],
    a: 1,
    s0: mode,
    s1: Math.sqrt(Math.min(1, intensity / 64)),
    s2: Math.min(1, (o.period ?? 0) / 8),
    s3: o.phase ?? 0,
    f0: o.switched ? 1 : 0,
    f1: Math.min(1, (o.cell ?? 0.7) / 4),
    f2: o.duty ?? 0.5,
    f3: o.alongV ? 1 : 0,
  };
}

/** Camera-facing additive glow sprite (nav lights, strobes). `size` is the quad half-size in metres (<= 4). */
export function flareStyle(color: RGB, intensity: number, size: number, o: GlowStyleOpts = {}): Style {
  return {
    ch: CH_FLARE,
    r: color[0],
    g: color[1],
    b: color[2],
    a: 1,
    s0: 0,
    s1: Math.sqrt(Math.min(1, intensity / 64)),
    s2: Math.min(1, (o.period ?? 0) / 8),
    s3: o.phase ?? 0,
    f0: o.switched ? 1 : 0,
    f1: Math.min(1, size / 4),
    f2: o.duty ?? 0.5,
    f3: 0,
  };
}

export function glassStyle(): Style {
  return { ch: CH_GLASS, r: 1, g: 1, b: 1, a: 1, s0: 0, s1: 0, s2: 0, s3: 0, f0: 0, f1: 0, f2: 0, f3: 0 };
}

/** Alpha-blended marking drawn from the decal atlas. `slot` > 0 multiplies the tint by a livery colour (1 primary, 2 secondary, 3 accent). */
export function decalStyle(tint: RGB, alpha = 1, slot = 0): Style {
  return { ch: CH_DECAL, r: tint[0], g: tint[1], b: tint[2], a: alpha, s0: slot, s1: 0, s2: 0, s3: 0, f0: 0, f1: 0, f2: 0, f3: 0 };
}

// ------------------------------------------------------------------------------------------ decal atlas layout

/** The decal atlas is a 16 x 8 grid of square cells (see hullMaterials.ts). */
export const DECAL_COLS = 16;
export const DECAL_ROWS = 8;
export const DECAL_GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-./';
/** Named icon cells: [col, row, colSpan, rowSpan]. Rows 0-2 hold glyphs. */
export const DECAL_ICONS = {
  solid: [0, 3, 1, 1],
  hazard: [1, 3, 3, 1],
  arrow: [4, 3, 1, 1],
  chevrons: [5, 3, 2, 1],
  roundel: [7, 3, 1, 1],
  noStep: [8, 3, 2, 1],
  rescue: [10, 3, 2, 1],
  frame: [12, 3, 2, 1],
  tick: [14, 3, 1, 1],
  cross: [15, 3, 1, 1],
  logoCorvane: [0, 4, 2, 2],
  logoIlmarin: [2, 4, 2, 2],
  logoHadley: [4, 4, 2, 2],
  logoAuric: [6, 4, 2, 2],
  stripeBroken: [8, 4, 4, 1],
  dashes: [8, 5, 4, 1],
  dockTarget: [12, 4, 2, 2],
  panelLabel: [14, 4, 2, 1],
  warnTri: [14, 5, 1, 1],
  dot: [15, 5, 1, 1],
  bigStripe: [0, 6, 8, 2],
  scuff: [8, 6, 4, 2],
  soot: [12, 6, 4, 2],
} as const;
export type DecalIcon = keyof typeof DECAL_ICONS;

/** Atlas rectangle [u0, v0, u1, v1] (v up) of a cell block, shrunk by a small margin. */
export function decalRect(col: number, row: number, cs = 1, rs = 1, margin = 0.004): [number, number, number, number] {
  return [col / DECAL_COLS + margin, 1 - (row + rs) / DECAL_ROWS + margin, (col + cs) / DECAL_COLS - margin, 1 - row / DECAL_ROWS - margin];
}
export function decalIconRect(name: DecalIcon): [number, number, number, number] {
  const c = DECAL_ICONS[name];
  return decalRect(c[0], c[1], c[2], c[3]);
}
export function decalGlyphRect(ch: string): [number, number, number, number] | null {
  const i = DECAL_GLYPHS.indexOf(ch);
  if (i < 0) return null;
  return decalRect(i % DECAL_COLS, Math.floor(i / DECAL_COLS), 1, 1, 0.002);
}

// ------------------------------------------------------------------------------------------ small math helpers

export const TAU = Math.PI * 2;
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smooth = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Small deterministic generator (mulberry32). */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Monotone cubic (PCHIP) curve through keys given as a flat list [t0, v0, t1, v1, ...] with ascending t.
 * Never overshoots, clamps outside the key range.
 */
export function curve(keys: readonly number[]): (t: number) => number {
  const n = keys.length >> 1;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = keys[i * 2];
    ys[i] = keys[i * 2 + 1];
  }
  if (n === 1) return () => ys[0];
  const d = new Float64Array(n - 1);
  const h = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = xs[i + 1] - xs[i];
    d[i] = h[i] > 0 ? (ys[i + 1] - ys[i]) / h[i] : 0;
  }
  const m = new Float64Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return (t: number): number => {
    if (t <= xs[0]) return ys[0];
    if (t >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && t > xs[i + 1]) i++;
    const hh = h[i];
    const s = (t - xs[i]) / hh;
    const s2 = s * s;
    const s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * ys[i] + (s3 - 2 * s2 + s) * hh * m[i] + (-2 * s3 + 3 * s2) * ys[i + 1] + (s3 - s2) * hh * m[i + 1];
  };
}

/** n+1 evenly spaced parameters in [a, b] plus `extra` values, sorted and de-duplicated. */
export function params(n: number, extra: readonly number[] = [], a = 0, b = 1): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(a + ((b - a) * i) / n);
  for (const e of extra) if (e > a && e < b) out.push(e);
  out.sort((p, q) => p - q);
  const res: number[] = [];
  for (const v of out) if (res.length === 0 || v - res[res.length - 1] > 1e-4) res.push(v);
  return res;
}

// ------------------------------------------------------------------------------------------ cross-sections

export interface Corner {
  x: number;
  y: number;
  /** fillet radius, m (0 = hard corner) */
  r: number;
}

/**
 * X-symmetric closed section from right-half corners listed from the top centre to the bottom centre
 * (the first and last corner should lie on x = 0). Every corner emits `segs + 1` points along its
 * fillet, so the point count only depends on the corner count: sections with the same corner count
 * can be lofted into each other. Returns flat [x0, y0, x1, y1, ...] with the ring starting at the top
 * centre and running toward +X.
 */
export function symSection(half: readonly Corner[], segs = 3, out: number[] = []): number[] {
  const n = half.length;
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = half[i];
    // previous / next corner; centreline corners mirror their only neighbour
    const pv = i === 0 ? { x: -half[1].x, y: half[1].y } : half[i - 1];
    const nx = i === n - 1 ? { x: -half[n - 2].x, y: half[n - 2].y } : half[i + 1];
    let ax = pv.x - c.x;
    let ay = pv.y - c.y;
    let bx = nx.x - c.x;
    let by = nx.y - c.y;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    const r = Math.min(c.r, la * 0.48, lb * 0.48);
    if (la > 1e-9) {
      ax /= la;
      ay /= la;
    }
    if (lb > 1e-9) {
      bx /= lb;
      by /= lb;
    }
    const p0x = c.x + ax * r;
    const p0y = c.y + ay * r;
    const p1x = c.x + bx * r;
    const p1y = c.y + by * r;
    const centre = i === 0 || i === n - 1;
    const cnt = centre ? (segs >> 1) + 1 : segs + 1;
    for (let k = 0; k < cnt; k++) {
      let s: number;
      if (centre) {
        const h = k / Math.max(1, cnt - 1); // 0..1 over half the fillet
        s = i === 0 ? 0.5 + 0.5 * h : 0.5 * h;
      } else s = k / segs;
      const w0 = (1 - s) * (1 - s);
      const w1 = 2 * s * (1 - s);
      const w2 = s * s;
      let x = w0 * p0x + w1 * c.x + w2 * p1x;
      const y = w0 * p0y + w1 * c.y + w2 * p1y;
      if (centre && ((i === 0 && k === 0) || (i === n - 1 && k === cnt - 1))) x = 0;
      pts.push(x, y);
    }
  }
  // mirror
  const hN = pts.length >> 1;
  out.length = 0;
  for (let i = 0; i < hN; i++) out.push(pts[i * 2], pts[i * 2 + 1]);
  for (let i = hN - 2; i >= 1; i--) out.push(-pts[i * 2], pts[i * 2 + 1]);
  return out;
}

/** Number of points symSection() returns for `corners` right-half corners. */
export function symSectionCount(corners: number, segs = 3): number {
  const hN = 2 * ((segs >> 1) + 1) + (corners - 2) * (segs + 1);
  return 2 * hN - 2;
}

/**
 * Superellipse section with separate top / bottom half-heights and exponents (2 = ellipse, 4+ = boxy,
 * < 2 = diamond-ish). K points starting at the top centre toward +X.
 */
export function superSection(K: number, w: number, hTop: number, hBot: number, pTop: number, pBot: number, yc = 0, out: number[] = []): number[] {
  out.length = 0;
  for (let i = 0; i < K; i++) {
    const a = (i / K) * TAU;
    const s = Math.sin(a);
    const c = Math.cos(a);
    const p = c >= 0 ? pTop : pBot;
    const e = 2 / p;
    const x = w * Math.sign(s) * Math.pow(Math.abs(s), e);
    const y = (c >= 0 ? hTop : hBot) * Math.sign(c) * Math.pow(Math.abs(c), e);
    out.push(x, yc + y);
  }
  return out;
}

/**
 * Interpolates corner-list sections along a loft. `stations` are [t, corners] pairs with ascending t
 * and identical corner counts; returns a function giving the (PCHIP-blended) corners at any t.
 */
export function sectionCurve(stations: readonly (readonly [number, readonly (readonly [number, number, number])[]])[]): (t: number, out: Corner[]) => Corner[] {
  const nc = stations[0][1].length;
  const fx: ((t: number) => number)[] = [];
  const fy: ((t: number) => number)[] = [];
  const fr: ((t: number) => number)[] = [];
  for (let c = 0; c < nc; c++) {
    const kx: number[] = [];
    const ky: number[] = [];
    const kr: number[] = [];
    for (const [t, cs] of stations) {
      kx.push(t, cs[c][0]);
      ky.push(t, cs[c][1]);
      kr.push(t, cs[c][2]);
    }
    fx.push(curve(kx));
    fy.push(curve(ky));
    fr.push(curve(kr));
  }
  return (t: number, out: Corner[]): Corner[] => {
    for (let c = 0; c < nc; c++) {
      const o = out[c] ?? (out[c] = { x: 0, y: 0, r: 0 });
      o.x = Math.max(0, fx[c](t));
      o.y = fy[c](t);
      o.r = Math.max(0, fr[c](t));
    }
    out.length = nc;
    return out;
  };
}

// ------------------------------------------------------------------------------------------ buffers

class Buf {
  cap = 1024;
  icap = 2048;
  pos = new Float32Array(this.cap * 3);
  nrm = new Float32Array(this.cap * 3);
  uv = new Float32Array(this.cap * 2);
  tint = new Uint8Array(this.cap * 4);
  surf = new Uint8Array(this.cap * 4);
  fx = new Uint8Array(this.cap * 4);
  idx = new Uint32Array(this.icap);
  nv = 0;
  ni = 0;

  growV(): void {
    const c = this.cap * 2;
    const g = <T extends Float32Array | Uint8Array>(a: T, n: number): T => {
      const b = new (a.constructor as { new (n: number): T })(n);
      b.set(a);
      return b;
    };
    this.pos = g(this.pos, c * 3);
    this.nrm = g(this.nrm, c * 3);
    this.uv = g(this.uv, c * 2);
    this.tint = g(this.tint, c * 4);
    this.surf = g(this.surf, c * 4);
    this.fx = g(this.fx, c * 4);
    this.cap = c;
  }

  growI(): void {
    const b = new Uint32Array(this.icap * 2);
    b.set(this.idx);
    this.idx = b;
    this.icap *= 2;
  }
}

// ------------------------------------------------------------------------------------------ surfaces

/**
 * A parametric grid surface kept after it was emitted, so details can be attached to it: sample a
 * point / frame, lay conformal plates or decals on it. u, v are normalised 0..1 (for lofts v is the
 * loft parameter t and u runs around the ring: 0 top centre, 0.25 starboard, 0.5 keel, 0.75 port).
 */
export class Surface {
  constructor(
    readonly nu: number,
    readonly nv: number,
    readonly P: Float32Array,
    readonly N: Float32Array,
    readonly vs: Float32Array | null,
    readonly wrapU: boolean,
    readonly matrix: THREE.Matrix4,
    readonly flipped: boolean,
  ) {}

  private locate(u: number, v: number, o: { i: number; j: number; fu: number; fv: number }): void {
    const nu = this.nu;
    const nv = this.nv;
    if (this.wrapU) u = u - Math.floor(u);
    else u = clamp01(u);
    const x = u * (nu - 1);
    let i = Math.floor(x);
    if (i > nu - 2) i = nu - 2;
    o.i = i;
    o.fu = x - i;
    let j = 0;
    let fv = 0;
    if (this.vs) {
      const vs = this.vs;
      if (v <= vs[0]) {
        j = 0;
        fv = 0;
      } else if (v >= vs[nv - 1]) {
        j = nv - 2;
        fv = 1;
      } else {
        while (j < nv - 2 && v > vs[j + 1]) j++;
        fv = (v - vs[j]) / (vs[j + 1] - vs[j]);
      }
    } else {
      const y = clamp01(v) * (nv - 1);
      j = Math.min(nv - 2, Math.floor(y));
      fv = y - j;
    }
    o.j = j;
    o.fv = fv;
  }

  /** Position and (smooth) normal at (u, v), in the surface's own local space. */
  sample(u: number, v: number, pos: THREE.Vector3, nrm?: THREE.Vector3): void {
    const o = _loc;
    this.locate(u, v, o);
    const nu = this.nu;
    const a = (o.j * nu + o.i) * 3;
    const b = a + 3;
    const c = a + nu * 3;
    const d = c + 3;
    const w00 = (1 - o.fu) * (1 - o.fv);
    const w10 = o.fu * (1 - o.fv);
    const w01 = (1 - o.fu) * o.fv;
    const w11 = o.fu * o.fv;
    const P = this.P;
    pos.set(
      P[a] * w00 + P[b] * w10 + P[c] * w01 + P[d] * w11,
      P[a + 1] * w00 + P[b + 1] * w10 + P[c + 1] * w01 + P[d + 1] * w11,
      P[a + 2] * w00 + P[b + 2] * w10 + P[c + 2] * w01 + P[d + 2] * w11,
    );
    if (nrm) {
      const N = this.N;
      nrm
        .set(
          N[a] * w00 + N[b] * w10 + N[c] * w01 + N[d] * w11,
          N[a + 1] * w00 + N[b + 1] * w10 + N[c + 1] * w01 + N[d + 1] * w11,
          N[a + 2] * w00 + N[b + 2] * w10 + N[c + 2] * w01 + N[d + 2] * w11,
        )
        .normalize();
    }
  }

  /** Metres of surface per unit of u and v at (u, v). */
  metric(u: number, v: number, out: { mu: number; mv: number }): void {
    const e = 0.004;
    this.sample(u - e, v, _sa);
    this.sample(u + e, v, _sb);
    out.mu = Math.max(1e-6, _sa.distanceTo(_sb) / (2 * e));
    const v0 = Math.max(this.vs ? this.vs[0] : 0, v - e);
    const v1 = Math.min(this.vs ? this.vs[this.nv - 1] : 1, v + e);
    this.sample(u, v0, _sa);
    this.sample(u, v1, _sb);
    out.mv = Math.max(1e-6, _sa.distanceTo(_sb) / Math.max(1e-9, v1 - v0));
  }

  /**
   * Local frame at (u, v): origin on the surface, +Y along the outward normal, +Z along increasing v
   * (toward the tail on a loft), +X completing the right-handed set. `lift` raises the origin along the normal.
   */
  frame(u: number, v: number, out: THREE.Matrix4, lift = 0): THREE.Matrix4 {
    const e = 0.004;
    this.sample(u, v, _fp, _fn);
    const v0 = Math.max(this.vs ? this.vs[0] : 0, v - e);
    const v1 = Math.min(this.vs ? this.vs[this.nv - 1] : 1, v + e);
    this.sample(u, v0, _sa);
    this.sample(u, v1, _sb);
    _ft.subVectors(_sb, _sa);
    if (_ft.lengthSq() < 1e-12) _ft.set(0, 0, 1);
    _fx.crossVectors(_fn, _ft);
    if (_fx.lengthSq() < 1e-12) _fx.set(1, 0, 0);
    _fx.normalize();
    _ft.crossVectors(_fx, _fn).normalize();
    _fp.addScaledVector(_fn, lift);
    return out.makeBasis(_fx, _fn, _ft).setPosition(_fp);
  }
}

const _loc = { i: 0, j: 0, fu: 0, fv: 0 };
const _sa = new THREE.Vector3();
const _sb = new THREE.Vector3();
const _fp = new THREE.Vector3();
const _fn = new THREE.Vector3();
const _ft = new THREE.Vector3();
const _fx = new THREE.Vector3();
const _met = { mu: 1, mv: 1 };

// ------------------------------------------------------------------------------------------ builder

export type StyleFn = Style | ((u: number, v: number, qi: number, qj: number) => Style | null);

export interface GridOpts {
  /** vertex counts around (u) and along (v) */
  nu: number;
  nv: number;
  pos: (i: number, j: number, out: THREE.Vector3) => void;
  /** column nu-1 coincides with column 0 */
  wrapU?: boolean;
  /** row nv-1 coincides with row 0 */
  wrapV?: boolean;
  /** style per quad (return null to leave a hole) */
  style: StyleFn;
  /** edges sharper than this stay hard, rad (default 0.7 ≈ 40°) */
  crease?: number;
  /** reverse the facing (default facing is dP/dv × dP/du, i.e. outward for the loft convention) */
  flip?: boolean;
  /** mirror U about the ring's half-way point so the texture is symmetric and seamless (default true when wrapU) */
  uvMirror?: boolean;
  /** UV offsets, m */
  u0?: number;
  v0?: number;
  /** normalised v parameter per row (default j / (nv-1)); used by Surface lookups and the style callback */
  vs?: readonly number[];
  /** custom UVs in metres */
  uv?: (i: number, j: number, out: THREE.Vector2) => void;
}

export interface LoftOpts {
  /** ascending ring parameters */
  ts: readonly number[];
  /** points per ring */
  K: number;
  /** writes K xyz triples for the ring at t */
  ring: (t: number, out: Float32Array) => void;
  style: StyleFn;
  crease?: number;
  /** flat end caps (null/undefined = open) */
  capStart?: Style | null;
  capEnd?: Style | null;
  /** open section: do not close the ring */
  open?: boolean;
  /** force the facing instead of detecting it */
  flip?: boolean;
  uvMirror?: boolean;
  u0?: number;
  v0?: number;
}

export interface LatheOpts {
  /** segments around a full turn (scaled by the builder's detail) */
  segs?: number;
  style: StyleFn;
  /** angular range, rad (default full turn); 0 is +Y, increasing toward +X */
  a0?: number;
  a1?: number;
  crease?: number;
  flip?: boolean;
  /** profile is a closed loop (torus-like) */
  closed?: boolean;
  u0?: number;
  v0?: number;
}

export interface BoxOpts {
  /** edge chamfer, m (shaded as a rounded edge) */
  bevel?: number;
  /** scale of the +Y face relative to the -Y face in x / z (frustum) */
  taperX?: number;
  taperZ?: number;
  /** x / z shift of the +Y face (shear) */
  shiftX?: number;
  shiftZ?: number;
  /** faces to leave out: bit 0 -X, 1 +X, 2 -Y, 3 +Y, 4 -Z, 5 +Z */
  omit?: number;
  /** rotate the texture a quarter turn on every face (e.g. to turn corrugations) */
  swapUV?: boolean;
}

export interface PlateOpts {
  style: Style;
  /** style of the rim (defaults to `style`) */
  edgeStyle?: Style;
  /** inset of the top/bottom faces from the outline, m */
  bevel?: number;
  /** knife edge: the rim collapses to the mid-plane (thin fins, strakes) */
  sharp?: boolean;
  crease?: number;
  /** leave out the bottom (-Y) face */
  noBottom?: boolean;
}

export interface NozzleOpts {
  throatR: number;
  exitR: number;
  length: number;
  /** wall thickness at the lip, m */
  wall?: number;
  /** outer shell finish */
  style: Style;
  /** inner emissive (GLOW.engine) finish, or a hull finish for a cold bell */
  inner: Style;
  /** injector plate style (defaults to `inner`) */
  plate?: Style;
  segs?: number;
  /** stiffening hoops on the outside */
  hoops?: number;
  /** bell curvature exponent (0.5 = round bell, 1 = cone) */
  shape?: number;
}

export interface TrussOpts {
  /** cross-section width and height (defaults to width), m */
  width: number;
  height?: number;
  bays: number;
  /** strut radius, m */
  r: number;
  style: Style;
  /** 3 = triangular, 4 = box section */
  sides?: 3 | 4;
  /** longeron radius (defaults to r * 1.4) */
  chordR?: number;
}

export interface BuiltModel {
  /** one geometry per channel (null when the channel is empty) */
  geometries: (THREE.BufferGeometry | null)[];
  triangles: number;
  vertices: number;
  /** axis-aligned bounds of the hull channel */
  bounds: THREE.Box3;
}

const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _r = new THREE.Vector3();
const _n = new THREE.Vector3();
const _uv = new THREE.Vector2();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _e = new THREE.Euler();
const MIRROR_X = new THREE.Matrix4().makeScale(-1, 1, 1);

export class MeshBuilder {
  /** 1 = hero LOD; lower values reduce tessellation (segment counts are multiplied by it). */
  readonly detail: number;
  /** true when building the hero LOD: add small parts only when set */
  readonly hero: boolean;
  /** multiplies UVs (metres) before they are written: < 1 makes panels bigger (large ships) */
  uvScale: number;
  readonly rand: () => number;

  private readonly bufs: Buf[] = [];
  private readonly mat = new THREE.Matrix4();
  private readonly nmat = new THREE.Matrix3();
  private readonly stack: THREE.Matrix4[] = [];
  private flip = false;
  private depth = 0;

  constructor(o: { detail?: number; uvScale?: number; seed?: number } = {}) {
    this.detail = o.detail ?? 1;
    this.hero = this.detail >= 0.99;
    this.uvScale = o.uvScale ?? 1;
    this.rand = seeded(o.seed ?? 1);
    for (let i = 0; i < CHANNEL_COUNT; i++) this.bufs.push(new Buf());
  }

  // ---------------------------------------------------------------- transforms

  private refresh(): void {
    this.nmat.getNormalMatrix(this.mat);
    this.flip = this.mat.determinant() < 0;
  }

  /** Multiply the current transform by m (until the matching pop()). */
  push(m: THREE.Matrix4): this {
    const s = this.stack[this.depth] ?? (this.stack[this.depth] = new THREE.Matrix4());
    s.copy(this.mat);
    this.depth++;
    this.mat.multiply(m);
    this.refresh();
    return this;
  }

  pop(): this {
    this.depth--;
    this.mat.copy(this.stack[this.depth]);
    this.refresh();
    return this;
  }

  /** Run fn inside the transform m. */
  with(m: THREE.Matrix4, fn: () => void): void {
    this.push(m);
    fn();
    this.pop();
  }

  /** Run fn translated to (x, y, z) and rotated by XYZ Euler angles. */
  at(x: number, y: number, z: number, fn: () => void, rx = 0, ry = 0, rz = 0, scale = 1): void {
    _m.makeRotationFromEuler(_e.set(rx, ry, rz, 'XYZ'));
    if (scale !== 1) _m.scale(_p.set(scale, scale, scale));
    _m.setPosition(x, y, z);
    this.push(_m);
    fn();
    this.pop();
  }

  /** Run fn twice: as is (side = 1) and mirrored across the YZ plane (side = -1). */
  mirror(fn: (side: number) => void): void {
    fn(1);
    this.push(MIRROR_X);
    fn(-1);
    this.pop();
  }

  /** Run fn in a frame whose origin is a and whose +Z axis points at b; fn receives |b - a|. */
  between(ax: number, ay: number, az: number, bx: number, by: number, bz: number, fn: (len: number) => void): void {
    _p.set(bx - ax, by - ay, bz - az);
    const len = _p.length();
    if (len < 1e-9) return;
    _p.multiplyScalar(1 / len);
    // basis: Z = dir, X = any perpendicular (stable choice), Y = Z × X
    if (Math.abs(_p.y) < 0.99) _q.set(0, 1, 0).cross(_p).normalize();
    else _q.set(1, 0, 0).cross(_p).normalize();
    _r.crossVectors(_p, _q);
    _m.makeBasis(_q, _r, _p).setPosition(ax, ay, az);
    this.push(_m);
    fn(len);
    this.pop();
  }

  /** Run fn in the frame of a point on a previously emitted surface (+Y = outward normal, +Z = along v). */
  on(s: Surface, u: number, v: number, fn: () => void, lift = 0, spin = 0): void {
    s.frame(u, v, _m2, lift);
    if (spin !== 0) _m2.multiply(_m.makeRotationY(spin));
    const saved = this.stack[this.depth] ?? (this.stack[this.depth] = new THREE.Matrix4());
    saved.copy(this.mat);
    this.depth++;
    this.mat.copy(s.matrix).multiply(_m2);
    this.refresh();
    fn();
    this.pop();
  }

  /** Copy of the current transform (e.g. to remember an attachment point). */
  currentMatrix(out = new THREE.Matrix4()): THREE.Matrix4 {
    return out.copy(this.mat);
  }

  // ---------------------------------------------------------------- low level

  /** Append a vertex (local coordinates; the current transform is applied). Returns its index. */
  vert(st: Style, x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    const B = this.bufs[st.ch];
    if (B.nv >= B.cap) B.growV();
    const i = B.nv++;
    const e = this.mat.elements;
    const i3 = i * 3;
    B.pos[i3] = e[0] * x + e[4] * y + e[8] * z + e[12];
    B.pos[i3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    B.pos[i3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    const k = this.nmat.elements;
    let ox = k[0] * nx + k[3] * ny + k[6] * nz;
    let oy = k[1] * nx + k[4] * ny + k[7] * nz;
    let oz = k[2] * nx + k[5] * ny + k[8] * nz;
    const l = Math.hypot(ox, oy, oz);
    if (l > 1e-12) {
      ox /= l;
      oy /= l;
      oz /= l;
    } else oy = 1;
    B.nrm[i3] = ox;
    B.nrm[i3 + 1] = oy;
    B.nrm[i3 + 2] = oz;
    const us = st.ch === CH_HULL ? this.uvScale : 1;
    B.uv[i * 2] = u * us;
    B.uv[i * 2 + 1] = v * us;
    const i4 = i * 4;
    B.tint[i4] = Math.round(255 * Math.sqrt(clamp01(st.r)));
    B.tint[i4 + 1] = Math.round(255 * Math.sqrt(clamp01(st.g)));
    B.tint[i4 + 2] = Math.round(255 * Math.sqrt(clamp01(st.b)));
    B.tint[i4 + 3] = Math.round(255 * clamp01(st.a));
    B.surf[i4] = st.s0;
    B.surf[i4 + 1] = Math.round(255 * clamp01(st.s1));
    B.surf[i4 + 2] = Math.round(255 * clamp01(st.s2));
    B.surf[i4 + 3] = Math.round(255 * clamp01(st.s3));
    B.fx[i4] = Math.round(255 * clamp01(st.f0));
    B.fx[i4 + 1] = Math.round(255 * clamp01(st.f1));
    B.fx[i4 + 2] = Math.round(255 * clamp01(st.f2));
    B.fx[i4 + 3] = Math.round(255 * clamp01(st.f3));
    return i;
  }

  /** Append a triangle (counter-clockwise seen from outside, before any mirroring). */
  tri(ch: number, a: number, b: number, c: number): void {
    const B = this.bufs[ch];
    if (B.ni + 3 > B.icap) B.growI();
    B.idx[B.ni++] = a;
    if (this.flip) {
      B.idx[B.ni++] = c;
      B.idx[B.ni++] = b;
    } else {
      B.idx[B.ni++] = b;
      B.idx[B.ni++] = c;
    }
  }

  quad(ch: number, a: number, b: number, c: number, d: number): void {
    this.tri(ch, a, b, c);
    this.tri(ch, a, c, d);
  }

  /** Scale a segment count by the LOD detail. */
  seg(n: number, min = 3): number {
    return Math.max(min, Math.round(n * this.detail));
  }

  // ---------------------------------------------------------------- grid (core of lofts, lathes, pipes)

  /**
   * Emit a parametric grid of quads. Vertices are shared across smooth edges and split across edges
   * sharper than `crease`, across style changes and across UV seams, so hard and soft edges come out
   * right without any per-primitive bookkeeping.
   */
  grid(o: GridOpts): Surface {
    const nu = o.nu;
    const nv = o.nv;
    const wu = !!o.wrapU;
    const wv = !!o.wrapV;
    const P = new Float32Array(nu * nv * 3);
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const k = (j * nu + i) * 3;
        const si = wu && i === nu - 1 ? 0 : i;
        const sj = wv && j === nv - 1 ? 0 : j;
        if (si !== i || sj !== j) {
          const s = (sj * nu + si) * 3;
          P[k] = P[s];
          P[k + 1] = P[s + 1];
          P[k + 2] = P[s + 2];
        } else {
          o.pos(i, j, _p);
          P[k] = _p.x;
          P[k + 1] = _p.y;
          P[k + 2] = _p.z;
        }
      }
    }
    // --- UVs (metres)
    const UV = new Float32Array(nu * nv * 2);
    if (o.uv) {
      for (let j = 0; j < nv; j++)
        for (let i = 0; i < nu; i++) {
          o.uv(i, j, _uv);
          UV[(j * nu + i) * 2] = _uv.x;
          UV[(j * nu + i) * 2 + 1] = _uv.y;
        }
    } else {
      const mirrorU = o.uvMirror ?? wu;
      const u0 = o.u0 ?? 0;
      const v0 = o.v0 ?? 0;
      for (let j = 0; j < nv; j++) {
        let acc = 0;
        UV[j * nu * 2] = 0;
        for (let i = 1; i < nu; i++) {
          const a = (j * nu + i) * 3;
          acc += Math.hypot(P[a] - P[a - 3], P[a + 1] - P[a - 2], P[a + 2] - P[a - 1]);
          UV[(j * nu + i) * 2] = acc;
        }
        for (let i = 0; i < nu; i++) {
          const k = (j * nu + i) * 2;
          UV[k] = (mirrorU ? Math.min(UV[k], acc - UV[k]) : UV[k]) + u0;
        }
      }
      let vacc = v0;
      for (let j = 0; j < nv; j++) {
        if (j > 0) {
          let sum = 0;
          for (let i = 0; i < nu; i++) {
            const a = (j * nu + i) * 3;
            const b = a - nu * 3;
            sum += Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]);
          }
          vacc += sum / nu;
        }
        for (let i = 0; i < nu; i++) UV[(j * nu + i) * 2 + 1] = vacc;
      }
    }
    // --- per-quad normals and styles
    const qu = nu - 1;
    const qv = nv - 1;
    const QN = new Float32Array(qu * qv * 3);
    const QA = new Float32Array(qu * qv);
    const QS: (Style | null)[] = new Array(qu * qv);
    const sgn = o.flip ? -1 : 1;
    const vs = o.vs;
    for (let qj = 0; qj < qv; qj++) {
      for (let qi = 0; qi < qu; qi++) {
        const q = qj * qu + qi;
        let st: Style | null;
        if (typeof o.style === 'function') {
          const vc = vs ? (vs[qj] + vs[qj + 1]) * 0.5 : (qj + 0.5) / qv;
          st = o.style((qi + 0.5) / qu, vc, qi, qj);
        } else st = o.style;
        QS[q] = st;
        const c0 = (qj * nu + qi) * 3;
        const c1 = c0 + 3;
        const c2 = c0 + nu * 3;
        const c3 = c2 + 3;
        // (c3 - c0) x (c1 - c2) = 2 dv x du
        const ax = P[c3] - P[c0];
        const ay = P[c3 + 1] - P[c0 + 1];
        const az = P[c3 + 2] - P[c0 + 2];
        const bx = P[c1] - P[c2];
        const by = P[c1 + 1] - P[c2 + 1];
        const bz = P[c1 + 2] - P[c2 + 2];
        let nx = (ay * bz - az * by) * sgn;
        let ny = (az * bx - ax * bz) * sgn;
        let nz = (ax * by - ay * bx) * sgn;
        const l = Math.hypot(nx, ny, nz);
        if (l > 1e-10) {
          nx /= l;
          ny /= l;
          nz /= l;
          QA[q] = l;
        } else QA[q] = 0;
        QN[q * 3] = nx;
        QN[q * 3 + 1] = ny;
        QN[q * 3 + 2] = nz;
      }
    }
    // --- vertices: cluster the (up to) four quads around each grid point
    const QV = new Int32Array(qu * qv * 4).fill(-1);
    const SN = new Float32Array(nu * nv * 3);
    const cosC = Math.cos(o.crease ?? 0.7);
    const uCount = wu ? nu - 1 : nu;
    const vCount = wv ? nv - 1 : nv;
    const kq = [0, 0, 0, 0];
    const kcol = [0, 0, 0, 0];
    const krow = [0, 0, 0, 0];
    const root = [0, 0, 0, 0];
    const sum = new Float32Array(12);
    const emRoot = [0, 0, 0, 0];
    const emSt: (Style | null)[] = [null, null, null, null];
    const emCol = [0, 0, 0, 0];
    const emRow = [0, 0, 0, 0];
    const emIdx = [0, 0, 0, 0];
    const find = (k: number): number => {
      while (root[k] !== k) k = root[k];
      return k;
    };
    const join = (a: number, b: number): void => {
      const qa = kq[a];
      const qb = kq[b];
      if (qa < 0 || qb < 0) return;
      const d = QN[qa * 3] * QN[qb * 3] + QN[qa * 3 + 1] * QN[qb * 3 + 1] + QN[qa * 3 + 2] * QN[qb * 3 + 2];
      if (d >= cosC) {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) root[rb] = ra;
      }
    };
    for (let j = 0; j < vCount; j++) {
      for (let c = 0; c < uCount; c++) {
        // k: 0 = (c-1, j-1) corner 3, 1 = (c, j-1) corner 2, 2 = (c-1, j) corner 1, 3 = (c, j) corner 0
        for (let k = 0; k < 4; k++) {
          let qi = k & 1 ? c : c - 1;
          let qj = k & 2 ? j : j - 1;
          let col = c;
          let row = j;
          if (qi < 0) {
            if (wu) {
              qi = qu - 1;
              col = nu - 1;
            } else qi = -1;
          } else if (qi >= qu) qi = -1;
          if (qj < 0) {
            if (wv) {
              qj = qv - 1;
              row = nv - 1;
            } else qj = -1;
          } else if (qj >= qv) qj = -1;
          let q = qi < 0 || qj < 0 ? -1 : qj * qu + qi;
          if (q >= 0 && (QS[q] === null || QA[q] === 0)) q = -1;
          kq[k] = q;
          kcol[k] = col;
          krow[k] = row;
          root[k] = k;
        }
        join(0, 1);
        join(0, 2);
        join(1, 3);
        join(2, 3);
        sum.fill(0);
        let sx = 0;
        let sy = 0;
        let sz = 0;
        for (let k = 0; k < 4; k++) {
          const q = kq[k];
          if (q < 0) continue;
          const rr = find(k) * 3;
          const w = QA[q];
          sum[rr] += QN[q * 3] * w;
          sum[rr + 1] += QN[q * 3 + 1] * w;
          sum[rr + 2] += QN[q * 3 + 2] * w;
          sx += QN[q * 3] * w;
          sy += QN[q * 3 + 1] * w;
          sz += QN[q * 3 + 2] * w;
        }
        const sl = Math.hypot(sx, sy, sz) || 1;
        const sk = (j * nu + c) * 3;
        SN[sk] = sx / sl;
        SN[sk + 1] = sy / sl;
        SN[sk + 2] = sz / sl;
        let em = 0;
        for (let k = 0; k < 4; k++) {
          const q = kq[k];
          if (q < 0) continue;
          const rr = find(k);
          const st = QS[q] as Style;
          let vi = -1;
          for (let m = 0; m < em; m++) {
            if (emRoot[m] === rr && emSt[m] === st && emCol[m] === kcol[k] && emRow[m] === krow[k]) {
              vi = emIdx[m];
              break;
            }
          }
          if (vi < 0) {
            const pk = (krow[k] * nu + kcol[k]) * 3;
            const uk = (krow[k] * nu + kcol[k]) * 2;
            vi = this.vert(st, P[pk], P[pk + 1], P[pk + 2], sum[rr * 3], sum[rr * 3 + 1], sum[rr * 3 + 2], UV[uk], UV[uk + 1]);
            emRoot[em] = rr;
            emSt[em] = st;
            emCol[em] = kcol[k];
            emRow[em] = krow[k];
            emIdx[em] = vi;
            em++;
          }
          QV[q * 4 + (3 - k)] = vi;
        }
      }
    }
    // copy smooth normals onto the duplicated seam column / row
    if (wu) for (let j = 0; j < nv; j++) for (let d = 0; d < 3; d++) SN[(j * nu + nu - 1) * 3 + d] = SN[j * nu * 3 + d];
    if (wv) for (let i = 0; i < nu; i++) for (let d = 0; d < 3; d++) SN[((nv - 1) * nu + i) * 3 + d] = SN[i * 3 + d];
    // --- triangles
    const same = (a: number, b: number): boolean => {
      const dx = P[a] - P[b];
      const dy = P[a + 1] - P[b + 1];
      const dz = P[a + 2] - P[b + 2];
      return dx * dx + dy * dy + dz * dz < 1e-12;
    };
    const fl = !!o.flip;
    for (let qj = 0; qj < qv; qj++) {
      for (let qi = 0; qi < qu; qi++) {
        const q = qj * qu + qi;
        const st = QS[q];
        if (!st || QA[q] === 0) continue;
        const a = QV[q * 4];
        const b = QV[q * 4 + 1];
        const c = QV[q * 4 + 2];
        const d = QV[q * 4 + 3];
        const pa = (qj * nu + qi) * 3;
        const pb = pa + 3;
        const pc = pa + nu * 3;
        const pd = pc + 3;
        const ab = same(pa, pb);
        const cd = same(pc, pd);
        const ac = same(pa, pc);
        const bd = same(pb, pd);
        const ch = st.ch;
        const dAD = (P[pa] - P[pd]) ** 2 + (P[pa + 1] - P[pd + 1]) ** 2 + (P[pa + 2] - P[pd + 2]) ** 2;
        const dBC = (P[pb] - P[pc]) ** 2 + (P[pb + 1] - P[pc + 1]) ** 2 + (P[pb + 2] - P[pc + 2]) ** 2;
        if (ab || bd) {
          // triangle a c d
          if (!(ac || cd)) fl ? this.tri(ch, a, d, c) : this.tri(ch, a, c, d);
        } else if (ac || cd) {
          // triangle a d b
          fl ? this.tri(ch, a, b, d) : this.tri(ch, a, d, b);
        } else if (dAD <= dBC) {
          if (fl) {
            this.tri(ch, a, d, c);
            this.tri(ch, a, b, d);
          } else {
            this.tri(ch, a, c, d);
            this.tri(ch, a, d, b);
          }
        } else if (fl) {
          this.tri(ch, a, b, c);
          this.tri(ch, b, d, c);
        } else {
          this.tri(ch, a, c, b);
          this.tri(ch, b, c, d);
        }
      }
    }
    return new Surface(nu, nv, P, SN, vs ? Float32Array.from(vs) : null, wu, this.mat.clone(), fl);
  }

  // ---------------------------------------------------------------- loft

  /**
   * Skin a sequence of rings. The facing is detected automatically for closed rings (outward from the
   * ring centroids). Returns the Surface for attaching details.
   */
  loft(o: LoftOpts): Surface {
    const K = o.K;
    const nv = o.ts.length;
    const closed = !o.open;
    const nu = closed ? K + 1 : K;
    const rings = new Float32Array(nv * K * 3);
    const tmp = new Float32Array(K * 3);
    for (let j = 0; j < nv; j++) {
      o.ring(o.ts[j], tmp);
      rings.set(tmp, j * K * 3);
    }
    let flip = o.flip;
    if (flip === undefined) {
      // facing test: sum of quad normal · (quad centre - ring centroid)
      let acc = 0;
      const cx = new Float32Array(nv * 3);
      for (let j = 0; j < nv; j++) {
        for (let i = 0; i < K; i++) for (let d = 0; d < 3; d++) cx[j * 3 + d] += rings[(j * K + i) * 3 + d] / K;
      }
      for (let j = 0; j < nv - 1; j++) {
        for (let i = 0; i < (closed ? K : K - 1); i++) {
          const i1 = (i + 1) % K;
          const a = (j * K + i) * 3;
          const b = (j * K + i1) * 3;
          const c = ((j + 1) * K + i) * 3;
          const d = ((j + 1) * K + i1) * 3;
          const ux = rings[d] - rings[a];
          const uy = rings[d + 1] - rings[a + 1];
          const uz = rings[d + 2] - rings[a + 2];
          const wx = rings[b] - rings[c];
          const wy = rings[b + 1] - rings[c + 1];
          const wz = rings[b + 2] - rings[c + 2];
          const nx = uy * wz - uz * wy;
          const ny = uz * wx - ux * wz;
          const nz = ux * wy - uy * wx;
          const mx = (rings[a] + rings[d]) * 0.5 - (cx[j * 3] + cx[j * 3 + 3]) * 0.5;
          const my = (rings[a + 1] + rings[d + 1]) * 0.5 - (cx[j * 3 + 1] + cx[j * 3 + 4]) * 0.5;
          const mz = (rings[a + 2] + rings[d + 2]) * 0.5 - (cx[j * 3 + 2] + cx[j * 3 + 5]) * 0.5;
          acc += nx * mx + ny * my + nz * mz;
        }
      }
      flip = acc < 0;
    }
    const surf = this.grid({
      nu,
      nv,
      wrapU: closed,
      pos: (i, j, out) => {
        const k = (j * K + (i % K)) * 3;
        out.set(rings[k], rings[k + 1], rings[k + 2]);
      },
      style: o.style,
      crease: o.crease,
      flip,
      uvMirror: o.uvMirror,
      u0: o.u0,
      v0: o.v0,
      vs: o.ts,
    });
    if (closed) {
      if (o.capStart) this.cap(rings, 0, K, o.capStart, !!flip);
      if (o.capEnd) this.cap(rings, (nv - 1) * K * 3, K, o.capEnd, !flip);
    }
    return surf;
  }

  /** Flat fan cap over a ring of K points stored at `off` in `pts`. */
  private cap(pts: Float32Array, off: number, K: number, st: Style, reverse: boolean): void {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < K; i++) {
      cx += pts[off + i * 3];
      cy += pts[off + i * 3 + 1];
      cz += pts[off + i * 3 + 2];
    }
    cx /= K;
    cy /= K;
    cz /= K;
    // Newell normal
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < K; i++) {
      const a = off + i * 3;
      const b = off + ((i + 1) % K) * 3;
      nx += (pts[a + 1] - pts[b + 1]) * (pts[a + 2] + pts[b + 2]);
      ny += (pts[a + 2] - pts[b + 2]) * (pts[a] + pts[b]);
      nz += (pts[a] - pts[b]) * (pts[a + 1] + pts[b + 1]);
    }
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-10) return;
    nx /= l;
    ny /= l;
    nz /= l;
    if (reverse) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    // tangent axes for planar UVs
    _p.set(nx, ny, nz);
    if (Math.abs(ny) < 0.9) _q.set(0, 1, 0).cross(_p).normalize();
    else _q.set(1, 0, 0).cross(_p).normalize();
    _r.crossVectors(_p, _q);
    const ci = this.vert(st, cx, cy, cz, nx, ny, nz, 0, 0);
    const first = this.bufs[st.ch].nv;
    for (let i = 0; i < K; i++) {
      const a = off + i * 3;
      const dx = pts[a] - cx;
      const dy = pts[a + 1] - cy;
      const dz = pts[a + 2] - cz;
      this.vert(st, pts[a], pts[a + 1], pts[a + 2], nx, ny, nz, dx * _q.x + dy * _q.y + dz * _q.z, dx * _r.x + dy * _r.y + dz * _r.z);
    }
    for (let i = 0; i < K; i++) {
      const a = first + i;
      const b = first + ((i + 1) % K);
      // Newell normal is CCW for the listed order; reverse flips it
      if (reverse) this.tri(st.ch, ci, b, a);
      else this.tri(st.ch, ci, a, b);
    }
  }

  // ---------------------------------------------------------------- lathe and friends

  /**
   * Revolve a profile of (r, z) pairs around the local Z axis. A profile running from -Z to +Z is an
   * outer surface; a closed-wall profile (out along the outside, back along the inside) is consistent.
   */
  lathe(profile: readonly number[], o: LatheOpts): Surface {
    const np = profile.length >> 1;
    const a0 = o.a0 ?? 0;
    const a1 = o.a1 ?? TAU;
    const full = Math.abs(a1 - a0 - TAU) < 1e-6;
    const segs = Math.max(3, Math.round(this.seg(o.segs ?? 24, 6) * Math.min(1, Math.abs(a1 - a0) / TAU + 0.001)));
    const nu = segs + 1;
    const closed = !!o.closed;
    const nv = closed ? np + 1 : np;
    return this.grid({
      nu,
      nv,
      wrapU: full,
      wrapV: closed,
      pos: (i, j, out) => {
        const a = a0 + ((a1 - a0) * i) / segs;
        const k = (j % np) * 2;
        const r = profile[k];
        out.set(r * Math.sin(a), r * Math.cos(a), profile[k + 1]);
      },
      style: o.style,
      crease: o.crease,
      flip: o.flip,
      uvMirror: false,
      u0: o.u0,
      v0: o.v0,
    });
  }

  /** Cylinder / cone frustum along local +Z from 0 to len with bevelled, capped ends. */
  cyl(r0: number, r1: number, len: number, st: Style, o: { segs?: number; bevel?: number; capA?: boolean; capB?: boolean; capStyle?: Style } = {}): Surface {
    const bv = Math.min(o.bevel ?? 0, r0 * 0.5, r1 * 0.5, len * 0.4);
    const prof: number[] = [];
    const capA = o.capA ?? true;
    const capB = o.capB ?? true;
    if (capA) prof.push(0, 0);
    if (bv > 0 && capA) prof.push(r0 - bv, 0, r0, bv);
    else prof.push(r0, 0);
    if (bv > 0 && capB) prof.push(r1, len - bv, r1 - bv, len);
    else prof.push(r1, len);
    if (capB) prof.push(0, len);
    const cs = o.capStyle;
    const np = prof.length >> 1;
    return this.lathe(prof, {
      segs: o.segs ?? 12,
      style: cs ? (_u, _v, _qi, qj) => ((capA && qj === 0) || (capB && qj === np - 2) ? cs : st) : st,
      crease: 0.9,
    });
  }

  /** Sphere of radius r centred on the origin. */
  sphere(r: number, st: StyleFn, segs = 16, squashZ = 1): Surface {
    const rings = this.seg(Math.max(4, segs >> 1), 4);
    const prof: number[] = [];
    for (let i = 0; i <= rings; i++) {
      const a = (i / rings) * Math.PI;
      prof.push(Math.sin(a) * r, -Math.cos(a) * r * squashZ);
    }
    prof[0] = 0;
    prof[prof.length - 2] = 0;
    return this.lathe(prof, { segs, style: st, crease: 1.2 });
  }

  /** Capsule tank along local Z, centred on the origin: cylinder of length `len` plus hemispherical ends. */
  capsule(r: number, len: number, st: StyleFn, segs = 16, endSquash = 1): Surface {
    const n = this.seg(5, 3);
    const prof: number[] = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 0.5;
      prof.push(Math.sin(a) * r, -len / 2 - Math.cos(a) * r * endSquash);
    }
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 0.5;
      prof.push(Math.cos(a) * r, len / 2 + Math.sin(a) * r * endSquash);
    }
    prof[0] = 0;
    prof[prof.length - 2] = 0;
    return this.lathe(prof, { segs, style: st, crease: 1.2 });
  }

  /** Torus (or arc of one) in the local XY plane around Z: ring radius R, tube radius r. */
  torus(R: number, r: number, st: StyleFn, o: { segs?: number; tube?: number; a0?: number; a1?: number } = {}): Surface {
    const tn = this.seg(o.tube ?? 8, 4);
    const prof: number[] = [];
    for (let i = 0; i < tn; i++) {
      const a = (i / tn) * TAU;
      prof.push(R - Math.cos(a) * r, -Math.sin(a) * r);
    }
    return this.lathe(prof, { segs: o.segs ?? 32, style: st, closed: true, a0: o.a0, a1: o.a1, crease: 1.2 });
  }

  /**
   * Ring with a rectangular, bevelled section (docking collars, flanges, turret races): inner radius
   * rIn, outer radius rOut, from z = 0 to z = h.
   */
  ring(rIn: number, rOut: number, h: number, st: StyleFn, o: { segs?: number; bevel?: number; a0?: number; a1?: number } = {}): Surface {
    const b = Math.min(o.bevel ?? 0.02, (rOut - rIn) * 0.45, h * 0.45);
    const prof = [rIn, 0, rOut - b, 0, rOut, b, rOut, h - b, rOut - b, h, rIn + b, h, rIn, h - b, rIn, b];
    // (rIn, 0) corner chamfer omitted on purpose: that edge usually sits against the hull
    return this.lathe(prof, { segs: o.segs ?? 24, style: st, closed: true, a0: o.a0, a1: o.a1, crease: 0.5 });
  }

  /**
   * Rocket nozzle along local +Z: throat at z = 0, exit plane at z = length. The outer shell uses
   * `style`; the inside uses `inner` with uv.y running 0 (lip) .. 1 (injector) for the engine glow.
   */
  nozzle(o: NozzleOpts): void {
    const n = this.seg(o.segs ? Math.max(6, o.segs >> 1) : 9, 4);
    const segs = o.segs ?? 20;
    const wall = o.wall ?? Math.max(0.02, o.exitR * 0.035);
    const shape = o.shape ?? 0.62;
    const rAt = (s: number): number => o.throatR + (o.exitR - o.throatR) * Math.pow(s, shape);
    // outer shell: from the throat collar to the lip
    const outer: number[] = [];
    outer.push(o.throatR * 0.9 + wall, -o.length * 0.08);
    for (let i = 0; i <= n; i++) {
      const s = i / n;
      outer.push(rAt(s) + wall * (1.6 - 0.6 * s), s * o.length);
    }
    outer.push(o.exitR + wall * 0.3, o.length + wall * 0.5);
    outer.push(o.exitR, o.length + wall * 0.15);
    this.lathe(outer, { segs, style: o.style, crease: 0.9 });
    // hoops
    const hoops = this.hero ? (o.hoops ?? 0) : 0;
    for (let h = 0; h < hoops; h++) {
      const s = (h + 0.6) / (hoops + 0.4);
      const r = rAt(s) + wall * (1.6 - 0.6 * s);
      const z = s * o.length;
      const w = wall * 1.6;
      this.lathe([r, z - w, r + w * 0.9, z - w * 0.5, r + w * 0.9, z + w * 0.5, r, z + w], { segs, style: o.style, crease: 0.5 });
    }
    // inner surface (lip -> throat) and injector plate, with engine-glow UVs
    const inner: number[] = [];
    const uvv: number[] = [];
    for (let i = n; i >= 0; i--) {
      const s = i / n;
      inner.push(rAt(s), s * o.length);
      uvv.push(1 - s);
    }
    const np = inner.length >> 1;
    const plate = o.plate ?? o.inner;
    const isg = this.seg(segs, 6);
    this.grid({
      nu: isg + 1,
      nv: np + 1,
      wrapU: true,
      pos: (i, j, out) => {
        const a = (i / isg) * TAU;
        if (j === np) out.set(0, 0, 0.0);
        else out.set(inner[j * 2] * Math.sin(a), inner[j * 2] * Math.cos(a), inner[j * 2 + 1]);
      },
      style: (_u, _v, _qi, qj) => (qj === np - 1 ? plate : o.inner),
      crease: 1.2,
      uv: (i, j, out) => {
        out.set(i / isg, j === np ? 1 : uvv[j] * 0.92);
      },
    });
  }

  /** Parabolic dish opening toward local +Y, rim radius R, with feed horn and tripod. */
  dish(R: number, depth: number, st: Style, back: Style, feed: Style): void {
    const n = this.seg(6, 3);
    const prof: number[] = [];
    // lathe axis is Z; build opening toward +Z then rotate so +Z -> +Y
    const t = Math.max(0.02, R * 0.02);
    for (let i = 0; i <= n; i++) {
      const s = i / n;
      prof.push(s * R, depth * s * s - t); // back (convex) surface, centre -> rim
    }
    prof.push(R + t * 0.5, depth);
    for (let i = n; i >= 0; i--) {
      const s = i / n;
      prof.push(s * R, depth * s * s); // front (concave) surface, rim -> centre
    }
    prof[0] = 0;
    prof[prof.length - 2] = 0;
    const np = prof.length >> 1;
    _m.makeRotationX(-Math.PI / 2);
    this.with(_m.clone(), () => {
      this.lathe(prof, { segs: 24, style: (_u, _v, _qi, qj) => (qj <= n ? back : st), crease: 1.0 });
      void np;
      const f = (R * R) / (4 * depth); // focal length
      const fz = Math.min(f, R * 1.1);
      this.at(0, 0, fz - R * 0.12, () => this.cyl(R * 0.07, R * 0.1, R * 0.22, feed, { segs: 8, bevel: R * 0.015 }));
      if (this.hero) {
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * TAU + 0.5;
          this.strut(Math.sin(a) * R * 0.92, Math.cos(a) * R * 0.92, depth * 0.85, Math.sin(a) * R * 0.08, Math.cos(a) * R * 0.08, fz, R * 0.012, feed, 3);
        }
      }
    });
  }

  // ---------------------------------------------------------------- boxes

  /**
   * Hexahedron from 8 corners indexed by bits (x+ = 1, y+ = 2, z+ = 4), with chamfered edges shaded as
   * rounded edges (face-weighted normals). `st` is one style or six ([-X, +X, -Y, +Y, -Z, +Z]).
   */
  hexa(c: readonly THREE.Vector3[], bevel: number, st: Style | readonly Style[], omit = 0, swapUV = false): void {
    const FACES = HEXA_FACES;
    const fv: number[][] = [[], [], [], [], [], []];
    const styles = Array.isArray(st) ? (st as readonly Style[]) : null;
    const single = st as Style;
    const cen = _r.set(0, 0, 0);
    for (let i = 0; i < 8; i++) cen.add(c[i]);
    cen.multiplyScalar(1 / 8);
    const ccx = cen.x;
    const ccy = cen.y;
    const ccz = cen.z;
    const fn: number[] = [];
    for (let f = 0; f < 6; f++) {
      const F = FACES[f];
      const s = styles ? styles[f] : single;
      const p0 = c[F[0]];
      const p1 = c[F[1]];
      const p3 = c[F[3]];
      // face normal (Newell over the 4 corners)
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (let k = 0; k < 4; k++) {
        const a = c[F[k]];
        const b = c[F[(k + 1) & 3]];
        nx += (a.y - b.y) * (a.z + b.z);
        ny += (a.z - b.z) * (a.x + b.x);
        nz += (a.x - b.x) * (a.y + b.y);
      }
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      fn.push(nx, ny, nz);
      // uv axes: u runs along Z on the X faces and along X on the others (v = n x u), unless swapped
      const ua = c[HEXA_U[f][0]];
      const ub = c[HEXA_U[f][1]];
      let ux = ub.x - ua.x;
      let uy = ub.y - ua.y;
      let uz = ub.z - ua.z;
      if (swapUV) {
        const tx0 = ny * uz - nz * uy;
        const ty0 = nz * ux - nx * uz;
        const tz0 = nx * uy - ny * ux;
        ux = tx0;
        uy = ty0;
        uz = tz0;
      }
      void p1;
      const ul = Math.hypot(ux, uy, uz) || 1;
      ux /= ul;
      uy /= ul;
      uz /= ul;
      const vx = ny * uz - nz * uy;
      const vy = nz * ux - nx * uz;
      const vz = nx * uy - ny * ux;
      // stable pseudo-random UV offset per face so repeated boxes do not show identical texels
      const hsh = Math.sin(p0.x * 12.9898 + p0.y * 78.233 + p0.z * 37.719 + f * 4.1 + this.mat.elements[12] * 3.3 + this.mat.elements[14] * 1.7) * 43758.5453;
      const ou = (hsh - Math.floor(hsh)) * 7;
      const ov = (hsh * 1.37 - Math.floor(hsh * 1.37)) * 7;
      void p3;
      for (let k = 0; k < 4; k++) {
        const p = c[F[k]];
        const a = c[F[(k + 3) & 3]];
        const b = c[F[(k + 1) & 3]];
        let x = p.x;
        let y = p.y;
        let z = p.z;
        if (bevel > 0) {
          const la = Math.hypot(a.x - p.x, a.y - p.y, a.z - p.z) || 1;
          const lb = Math.hypot(b.x - p.x, b.y - p.y, b.z - p.z) || 1;
          const ba = Math.min(bevel, la * 0.45) / la;
          const bb = Math.min(bevel, lb * 0.45) / lb;
          x += (a.x - p.x) * ba + (b.x - p.x) * bb;
          y += (a.y - p.y) * ba + (b.y - p.y) * bb;
          z += (a.z - p.z) * ba + (b.z - p.z) * bb;
        }
        const dx = x - p0.x;
        const dy = y - p0.y;
        const dz = z - p0.z;
        fv[f].push(this.vert(s, x, y, z, nx, ny, nz, dx * ux + dy * uy + dz * uz + ou, dx * vx + dy * vy + dz * vz + ov));
      }
      if (!(omit & (1 << f))) this.quad(s.ch, fv[f][0], fv[f][1], fv[f][2], fv[f][3]);
    }
    if (bevel <= 0) return;
    // chamfers along the 12 edges: for every face edge a->b find the neighbour face holding b->a
    for (let f = 0; f < 6; f++) {
      if (omit & (1 << f)) continue;
      const F = FACES[f];
      for (let k = 0; k < 4; k++) {
        const ca = F[k];
        const cb = F[(k + 1) & 3];
        for (let g = f + 1; g < 6; g++) {
          if (omit & (1 << g)) continue;
          const G = FACES[g];
          for (let m = 0; m < 4; m++) {
            if (G[m] === cb && G[(m + 1) & 3] === ca) {
              // B1, A1, A2, B2 — both faces must share a channel
              const s = styles ? styles[f] : single;
              const sg = styles ? styles[g] : single;
              if (s.ch === sg.ch) this.quad(s.ch, fv[f][(k + 1) & 3], fv[f][k], fv[g][(m + 1) & 3], fv[g][m]);
            }
          }
        }
      }
    }
    // corner triangles
    for (let ci = 0; ci < 8; ci++) {
      const vs: number[] = [];
      let ok = true;
      let chn = -1;
      for (let f = 0; f < 6; f++) {
        const k = FACES[f].indexOf(ci);
        if (k < 0) continue;
        if (omit & (1 << f)) ok = false;
        const s = styles ? styles[f] : single;
        if (chn < 0) chn = s.ch;
        else if (chn !== s.ch) ok = false;
        vs.push(fv[f][k], f);
      }
      if (!ok || vs.length !== 6) continue;
      // orientation: the triangle normal must point away from the centre
      const B = this.bufs[chn];
      const e = this.mat.elements;
      // work in local space using the face normals: outward direction ~ sum of the three face normals
      const ox = fn[vs[1] * 3] + fn[vs[3] * 3] + fn[vs[5] * 3];
      const oy = fn[vs[1] * 3 + 1] + fn[vs[3] * 3 + 1] + fn[vs[5] * 3 + 1];
      const oz = fn[vs[1] * 3 + 2] + fn[vs[3] * 3 + 2] + fn[vs[5] * 3 + 2];
      // transformed positions -> need local-space positions: recompute from buffers via world, compare with transformed outward
      const wx = e[0] * ox + e[4] * oy + e[8] * oz;
      const wy = e[1] * ox + e[5] * oy + e[9] * oz;
      const wz = e[2] * ox + e[6] * oy + e[10] * oz;
      const a = vs[0] * 3;
      const b = vs[2] * 3;
      const d = vs[4] * 3;
      const ux = B.pos[b] - B.pos[a];
      const uy = B.pos[b + 1] - B.pos[a + 1];
      const uz = B.pos[b + 2] - B.pos[a + 2];
      const vx = B.pos[d] - B.pos[a];
      const vy = B.pos[d + 1] - B.pos[a + 1];
      const vz = B.pos[d + 2] - B.pos[a + 2];
      const tx = uy * vz - uz * vy;
      const ty = uz * vx - ux * vz;
      const tz = ux * vy - uy * vx;
      let ccw = tx * wx + ty * wy + tz * wz > 0;
      if (this.flip) ccw = !ccw; // tri() will swap again for mirrored transforms
      if (ccw) this.tri(chn, vs[0], vs[2], vs[4]);
      else this.tri(chn, vs[0], vs[4], vs[2]);
    }
    void ccx;
    void ccy;
    void ccz;
  }

  /** Bevelled box centred on the origin (optionally a frustum / sheared). */
  box(sx: number, sy: number, sz: number, st: Style | readonly Style[], o: BoxOpts = {}): void {
    const hx = sx / 2;
    const hy = sy / 2;
    const hz = sz / 2;
    const tx = o.taperX ?? 1;
    const tz = o.taperZ ?? 1;
    const shx = o.shiftX ?? 0;
    const shz = o.shiftZ ?? 0;
    for (let i = 0; i < 8; i++) {
      const top = (i & 2) !== 0;
      const x = (i & 1 ? hx : -hx) * (top ? tx : 1) + (top ? shx : 0);
      const z = (i & 4 ? hz : -hz) * (top ? tz : 1) + (top ? shz : 0);
      _hc[i].set(x, top ? hy : -hy, z);
    }
    this.hexa(_hc, o.bevel ?? 0, st, o.omit ?? 0, !!o.swapUV);
  }

  /** Box sitting on the local XZ plane (y from 0 to sy) — convenient for parts placed on a surface frame. */
  block(sx: number, sy: number, sz: number, st: Style | readonly Style[], o: BoxOpts = {}): void {
    this.at(0, sy / 2, 0, () => this.box(sx, sy, sz, st, { ...o, omit: (o.omit ?? 0) | 4 }));
  }

  // ---------------------------------------------------------------- plates (extruded outlines)

  /**
   * Extrude an outline lying in the local XZ plane (flat [x0, z0, x1, z1, ...]) to thickness `thick`
   * along Y, centred on y = 0, with chamfered rims. Either winding is accepted.
   */
  plate(outline: readonly number[], thick: number, o: PlateOpts): void {
    const n = outline.length >> 1;
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i < n; i++) pts.push(new THREE.Vector2(outline[i * 2], outline[i * 2 + 1]));
    // make counter-clockwise in (x, z) with z as "y": area > 0
    if (THREE.ShapeUtils.area(pts) < 0) pts.reverse();
    const bevel = Math.max(0, o.bevel ?? 0);
    const h = thick / 2;
    const sharp = !!o.sharp;
    const st = o.style;
    const es = o.edgeStyle ?? st;
    // inward edge normals and inset loop
    const ex: number[] = [];
    const ez: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const dx = b.x - a.x;
      const dz = b.y - a.y;
      const l = Math.hypot(dx, dz) || 1;
      // CCW polygon in (x, z'): inward normal is (-dz, dx)
      ex.push(-dz / l);
      ez.push(dx / l);
    }
    const inset: THREE.Vector2[] = [];
    for (let i = 0; i < n; i++) {
      const p = (i + n - 1) % n;
      const d = 1 + ex[p] * ex[i] + ez[p] * ez[i];
      const k = bevel / Math.max(0.35, d);
      inset.push(new THREE.Vector2(pts[i].x + (ex[p] + ex[i]) * k, pts[i].y + (ez[p] + ez[i]) * k));
    }
    const tris = THREE.ShapeUtils.triangulateShape(bevel > 0 ? inset.map((v) => v.clone()) : pts.map((v) => v.clone()), []);
    const top = bevel > 0 ? inset : pts;
    // top (+Y) and bottom faces. In (x, y, z) a CCW loop in (x, z) faces -Y, so the top needs reversing.
    const tv: number[] = [];
    const bv: number[] = [];
    for (let i = 0; i < n; i++) {
      tv.push(this.vert(st, top[i].x, h, top[i].y, 0, 1, 0, top[i].x, top[i].y));
      if (!o.noBottom) bv.push(this.vert(st, top[i].x, -h, top[i].y, 0, -1, 0, top[i].x + 3.1, top[i].y + 1.7));
    }
    for (const t of tris) {
      this.tri(st.ch, tv[t[0]], tv[t[2]], tv[t[1]]);
      if (!o.noBottom) this.tri(st.ch, bv[t[0]], bv[t[1]], bv[t[2]]);
    }
    // rim: per edge, with smoothing between neighbouring edges below the crease angle
    const cosC = Math.cos(o.crease ?? 0.6);
    let run = 0;
    const yb = sharp ? 0 : Math.max(0, h - Math.min(bevel, h * 0.9));
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const p = (i + n - 1) % n;
      const a = pts[i];
      const b = pts[j];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      // outward normals at both ends (smoothed with the neighbouring edge when nearly collinear)
      let n0x = -ex[i];
      let n0z = -ez[i];
      if (ex[p] * ex[i] + ez[p] * ez[i] >= cosC) {
        n0x = -(ex[p] + ex[i]);
        n0z = -(ez[p] + ez[i]);
      }
      let n1x = -ex[i];
      let n1z = -ez[i];
      if (ex[j] * ex[i] + ez[j] * ez[i] >= cosC) {
        n1x = -(ex[j] + ex[i]);
        n1z = -(ez[j] + ez[i]);
      }
      const u0 = run;
      const u1 = run + len;
      run = u1;
      if (bevel <= 0 && !sharp) {
        const v0 = this.vert(es, a.x, h, a.y, n0x, 0, n0z, u0, h);
        const v1 = this.vert(es, b.x, h, b.y, n1x, 0, n1z, u1, h);
        const v2 = this.vert(es, b.x, -h, b.y, n1x, 0, n1z, u1, -h);
        const v3 = this.vert(es, a.x, -h, a.y, n0x, 0, n0z, u0, -h);
        this.quad(es.ch, v0, v1, v2, v3);
        continue;
      }
      // chamfer strip top -> rim (-> rim bottom) -> bottom; the top/bottom verts carry the face normals
      const t0 = this.vert(es, top[i].x, h, top[i].y, 0, 1, 0, u0, h + bevel);
      const t1 = this.vert(es, top[j].x, h, top[j].y, 0, 1, 0, u1, h + bevel);
      const r0 = this.vert(es, a.x, yb, a.y, n0x, sharp ? 0 : 0.35, n0z, u0, yb);
      const r1 = this.vert(es, b.x, yb, b.y, n1x, sharp ? 0 : 0.35, n1z, u1, yb);
      this.quad(es.ch, t0, t1, r1, r0);
      let l0 = r0;
      let l1 = r1;
      if (!sharp && yb > 0) {
        const s0 = this.vert(es, a.x, -yb, a.y, n0x, -0.35, n0z, u0, -yb);
        const s1 = this.vert(es, b.x, -yb, b.y, n1x, -0.35, n1z, u1, -yb);
        this.quad(es.ch, r0, r1, s1, s0);
        l0 = s0;
        l1 = s1;
      }
      if (!o.noBottom) {
        const b0 = this.vert(es, top[i].x, -h, top[i].y, 0, -1, 0, u0, -h - bevel);
        const b1 = this.vert(es, top[j].x, -h, top[j].y, 0, -1, 0, u1, -h - bevel);
        this.quad(es.ch, l0, l1, b1, b0);
      }
    }
  }

  // ---------------------------------------------------------------- struts, pipes, trusses

  /** Prism strut between two points (no end caps). */
  strut(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, st: Style, sides = 4, r1 = r): void {
    this.between(ax, ay, az, bx, by, bz, (len) => {
      this.grid({
        nu: sides + 1,
        nv: 2,
        wrapU: true,
        pos: (i, j, out) => {
          const a = (i / sides) * TAU + Math.PI / sides;
          const rr = j === 0 ? r : r1;
          out.set(Math.sin(a) * rr, Math.cos(a) * rr, j * len);
        },
        style: st,
        crease: sides <= 4 ? 0.5 : 1.2,
      });
    });
  }

  /**
   * Round pipe through a list of points (flat xyz). `smoothPath` runs a Catmull-Rom curve through them,
   * otherwise corners are mitred. Optional end caps.
   */
  pipe(points: readonly number[], r: number, st: Style, o: { sides?: number; smoothPath?: boolean; caps?: boolean; samples?: number } = {}): Surface {
    const sides = this.seg(o.sides ?? 8, 4);
    let pts: THREE.Vector3[] = [];
    for (let i = 0; i < points.length; i += 3) pts.push(new THREE.Vector3(points[i], points[i + 1], points[i + 2]));
    if (o.smoothPath && pts.length > 2) {
      const cr = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
      pts = cr.getPoints(this.seg((pts.length - 1) * (o.samples ?? 6), pts.length));
    }
    const n = pts.length;
    // parallel-transport frames
    const T: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      T.push(new THREE.Vector3().subVectors(b, a).normalize());
    }
    const N: THREE.Vector3[] = [];
    const B: THREE.Vector3[] = [];
    const n0 = new THREE.Vector3();
    if (Math.abs(T[0].y) < 0.95) n0.set(0, 1, 0);
    else n0.set(1, 0, 0);
    n0.addScaledVector(T[0], -n0.dot(T[0])).normalize();
    N.push(n0);
    B.push(new THREE.Vector3().crossVectors(T[0], n0));
    for (let i = 1; i < n; i++) {
      const nn = N[i - 1].clone();
      nn.addScaledVector(T[i], -nn.dot(T[i]));
      if (nn.lengthSq() < 1e-10) nn.copy(N[i - 1]);
      nn.normalize();
      N.push(nn);
      B.push(new THREE.Vector3().crossVectors(T[i], nn));
    }
    const caps = !!o.caps;
    const nv = caps ? n + 2 : n;
    return this.grid({
      nu: sides + 1,
      nv,
      wrapU: true,
      pos: (i, j, out) => {
        const k = caps ? Math.min(n - 1, Math.max(0, j - 1)) : j;
        const rr = caps && (j === 0 || j === nv - 1) ? 0 : r;
        const a = (i / sides) * TAU;
        // mitre scale at corners so the pipe keeps its radius
        let sc = 1;
        if (k > 0 && k < n - 1) {
          _p.subVectors(pts[k], pts[k - 1]).normalize();
          _q.subVectors(pts[k + 1], pts[k]).normalize();
          const c = Math.max(0.3, Math.sqrt(Math.max(0, (1 + _p.dot(_q)) / 2)));
          sc = 1 / c;
        }
        out.copy(pts[k]).addScaledVector(N[k], Math.cos(a) * rr * sc).addScaledVector(B[k], Math.sin(a) * rr * sc);
      },
      style: st,
      crease: 1.0,
      flip: true,
    });
  }

  /** Lattice beam between two points: longerons, battens and alternating diagonals. */
  truss(ax: number, ay: number, az: number, bx: number, by: number, bz: number, o: TrussOpts): void {
    const sides = o.sides ?? 4;
    const w = o.width / 2;
    const h = (o.height ?? o.width) / 2;
    const bays = Math.max(1, this.hero ? o.bays : Math.ceil(o.bays / 2));
    const cr = o.chordR ?? o.r * 1.4;
    const ss = this.hero ? 4 : 3;
    this.between(ax, ay, az, bx, by, bz, (len) => {
      const cx: number[] = [];
      const cy: number[] = [];
      if (sides === 4) {
        cx.push(-w, w, w, -w);
        cy.push(h, h, -h, -h);
      } else {
        cx.push(0, w, -w);
        cy.push(h, -h * 0.6, -h * 0.6);
      }
      for (let k = 0; k < sides; k++) this.strut(cx[k], cy[k], 0, cx[k], cy[k], len, cr, o.style, ss);
      for (let b = 0; b <= bays; b++) {
        const z = (len * b) / bays;
        for (let k = 0; k < sides; k++) {
          const m = (k + 1) % sides;
          this.strut(cx[k], cy[k], z, cx[m], cy[m], z, o.r, o.style, 3);
          if (b < bays) {
            const z1 = (len * (b + 1)) / bays;
            const alt = (b + k) & 1;
            if (alt) this.strut(cx[k], cy[k], z, cx[m], cy[m], z1, o.r, o.style, 3);
            else this.strut(cx[m], cy[m], z, cx[k], cy[k], z1, o.r, o.style, 3);
          }
        }
      }
    });
  }

  // ---------------------------------------------------------------- surface details

  /**
   * Conformal raised (or sunk) plate over a parameter rectangle of a Surface: real geometric panel
   * breakup that follows the curvature. `lift` is the plate height in metres, `bevel` the width of
   * its sloped rim.
   */
  plateOn(s: Surface, u0: number, u1: number, v0: number, v1: number, o: { lift: number; style: StyleFn; bevel?: number; nu?: number; nv?: number; crease?: number }): Surface {
    const nu = Math.max(2, this.seg(o.nu ?? 4, 2)) + 2;
    const nv = Math.max(2, this.seg(o.nv ?? 4, 2)) + 2;
    const bevel = o.bevel ?? Math.abs(o.lift) * 0.8;
    s.metric((u0 + u1) / 2, (v0 + v1) / 2, _met);
    const du = bevel / _met.mu;
    const dv = bevel / _met.mv;
    const saved = this.stack[this.depth] ?? (this.stack[this.depth] = new THREE.Matrix4());
    saved.copy(this.mat);
    this.depth++;
    this.mat.copy(s.matrix);
    this.refresh();
    const res = this.grid({
      nu,
      nv,
      pos: (i, j, out) => {
        const edge = i === 0 || j === 0 || i === nu - 1 || j === nv - 1;
        const ii = Math.min(nu - 3, Math.max(0, i - 1));
        const jj = Math.min(nv - 3, Math.max(0, j - 1));
        let u = u0 + ((u1 - u0) * ii) / (nu - 3);
        let v = v0 + ((v1 - v0) * jj) / (nv - 3);
        if (i === 0) u -= du * Math.sign(u1 - u0);
        if (i === nu - 1) u += du * Math.sign(u1 - u0);
        if (j === 0) v -= dv * Math.sign(v1 - v0);
        if (j === nv - 1) v += dv * Math.sign(v1 - v0);
        s.sample(u, v, out, _n);
        out.addScaledVector(_n, edge ? -0.012 : o.lift);
      },
      style: o.style,
      crease: o.crease ?? 0.45,
      flip: s.flipped !== (u1 - u0 < 0) ? !(v1 - v0 < 0) : v1 - v0 < 0,
      uvMirror: false,
      u0: this.rand() * 5,
      v0: this.rand() * 5,
    });
    this.pop();
    return res;
  }

  /**
   * Conformal decal centred at (u, v) on a Surface. `w` (advance axis) and `h` are in metres; `rot`
   * is in quarter turns: 0 advance +u / top -v, 1 advance -v / top -u, 2 advance -u / top +v,
   * 3 advance +v / top +u. `rect` is the atlas rectangle from decalIconRect() / decalGlyphRect().
   */
  decalOn(s: Surface, u: number, v: number, w: number, h: number, rect: readonly number[], st: Style, rot = 0, n = 3, lift = 0.012): void {
    s.metric(u, v, _met);
    const su = 1 / _met.mu;
    const sv = 1 / _met.mv;
    const nx = this.hero ? Math.max(2, Math.min(12, Math.round(n * Math.max(1, w / 1.5)))) : 2;
    const ny = this.hero ? Math.max(2, n) : 2;
    const saved = this.stack[this.depth] ?? (this.stack[this.depth] = new THREE.Matrix4());
    saved.copy(this.mat);
    this.depth++;
    this.mat.copy(s.matrix);
    this.refresh();
    const idx: number[] = [];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const fa = i / (nx - 1);
        const fb = j / (ny - 1);
        const a = (fa - 0.5) * w;
        const b = (fb - 0.5) * h;
        let du = 0;
        let dv = 0;
        if (rot === 0) {
          du = a * su;
          dv = -b * sv;
        } else if (rot === 1) {
          dv = -a * sv;
          du = -b * su;
        } else if (rot === 2) {
          du = -a * su;
          dv = b * sv;
        } else {
          dv = a * sv;
          du = b * su;
        }
        s.sample(u + du, v + dv, _p, _n);
        _p.addScaledVector(_n, lift);
        idx.push(this.vert(st, _p.x, _p.y, _p.z, _n.x, _n.y, _n.z, lerp(rect[0], rect[2], fa), lerp(rect[1], rect[3], fb)));
      }
    }
    // facing: compare the first cell's normal with the surface normal
    const B = this.bufs[st.ch];
    const a0 = idx[0] * 3;
    const a1 = idx[1] * 3;
    const a2 = idx[nx] * 3;
    const ux = B.pos[a1] - B.pos[a0];
    const uy = B.pos[a1 + 1] - B.pos[a0 + 1];
    const uz = B.pos[a1 + 2] - B.pos[a0 + 2];
    const vx = B.pos[a2] - B.pos[a0];
    const vy = B.pos[a2 + 1] - B.pos[a0 + 1];
    const vz = B.pos[a2 + 2] - B.pos[a0 + 2];
    const tx = uy * vz - uz * vy;
    const ty = uz * vx - ux * vz;
    const tz = ux * vy - uy * vx;
    let ccw = tx * B.nrm[a0] + ty * B.nrm[a0 + 1] + tz * B.nrm[a0 + 2] > 0;
    if (this.flip) ccw = !ccw;
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = idx[j * nx + i];
        const b = idx[j * nx + i + 1];
        const c = idx[(j + 1) * nx + i + 1];
        const d = idx[(j + 1) * nx + i];
        if (ccw) this.quad(st.ch, a, b, c, d);
        else this.quad(st.ch, a, d, c, b);
      }
    }
    this.pop();
  }

  /** Stencilled text on a Surface (glyph height h metres). Orientation as in decalOn(). */
  textOn(s: Surface, u: number, v: number, text: string, h: number, st: Style, rot = 0, spacing = 0.72): void {
    s.metric(u, v, _met);
    const su = 1 / _met.mu;
    const sv = 1 / _met.mv;
    const adv = h * spacing;
    const total = adv * (text.length - 1);
    for (let k = 0; k < text.length; k++) {
      const rect = decalGlyphRect(text[k]);
      if (!rect) continue;
      const a = -total / 2 + k * adv;
      let du = 0;
      let dv = 0;
      if (rot === 0) du = a * su;
      else if (rot === 1) dv = -a * sv;
      else if (rot === 2) du = -a * su;
      else dv = a * sv;
      this.decalOn(s, u + du, v + dv, h, h, rect, st, rot, 2);
    }
  }

  /**
   * Flat decal in the local XZ plane facing +Y, centred on the origin: atlas +x along local +X, glyph
   * tops toward local -Z.
   */
  decal(w: number, h: number, rect: readonly number[], st: Style, lift = 0.012): void {
    const a = this.vert(st, -w / 2, lift, h / 2, 0, 1, 0, rect[0], rect[1]);
    const b = this.vert(st, w / 2, lift, h / 2, 0, 1, 0, rect[2], rect[1]);
    const c = this.vert(st, w / 2, lift, -h / 2, 0, 1, 0, rect[2], rect[3]);
    const d = this.vert(st, -w / 2, lift, -h / 2, 0, 1, 0, rect[0], rect[3]);
    this.quad(st.ch, a, b, c, d);
  }

  /** Flat stencilled text in the local XZ plane (see decal()). */
  text(text: string, h: number, st: Style, spacing = 0.72): void {
    const adv = h * spacing;
    const total = adv * (text.length - 1);
    for (let k = 0; k < text.length; k++) {
      const rect = decalGlyphRect(text[k]);
      if (!rect) continue;
      this.at(-total / 2 + k * adv, 0, 0, () => this.decal(h, h, rect, st));
    }
  }

  /** Camera-facing additive glow sprite at the local origin (style from flareStyle()). */
  flare(st: Style): void {
    const a = this.vert(st, 0, 0, 0, 0, 0, 1, -1, -1);
    const b = this.vert(st, 0, 0, 0, 0, 0, 1, 1, -1);
    const c = this.vert(st, 0, 0, 0, 0, 0, 1, 1, 1);
    const d = this.vert(st, 0, 0, 0, 0, 0, 1, -1, 1);
    // winding is irrelevant (the flare material is double-sided); bypass mirroring
    const B = this.bufs[CH_FLARE];
    while (B.ni + 6 > B.icap) B.growI();
    B.idx[B.ni++] = a;
    B.idx[B.ni++] = b;
    B.idx[B.ni++] = c;
    B.idx[B.ni++] = a;
    B.idx[B.ni++] = c;
    B.idx[B.ni++] = d;
  }

  /**
   * Scatter mechanical clutter over a w x d rectangle of the local XZ plane (rising along +Y):
   * bevelled blocks on a coarse grid, a few cylinders and pipe runs. Deterministic.
   */
  greebles(w: number, d: number, o: { styles: readonly Style[]; cell?: number; height?: number; density?: number; pipes?: number; pipeStyle?: Style }): void {
    const cell = o.cell ?? 0.4;
    const hMax = o.height ?? 0.25;
    const nx = Math.max(1, Math.round(w / cell));
    const nz = Math.max(1, Math.round(d / cell));
    const cw = w / nx;
    const cd = d / nz;
    const used = new Uint8Array(nx * nz);
    const dens = (o.density ?? 0.55) * (this.hero ? 1 : 0.45);
    const rnd = this.rand;
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        // always consume the same number of randoms per cell so LODs stay coherent
        const r0 = rnd();
        const r1 = rnd();
        const r2 = rnd();
        const r3 = rnd();
        if (used[iz * nx + ix] || r0 > dens) continue;
        let sx = 1;
        let sz = 1;
        if (r1 < 0.3 && ix + 1 < nx && !used[iz * nx + ix + 1]) sx = 2;
        else if (r1 < 0.55 && iz + 1 < nz && !used[(iz + 1) * nx + ix]) sz = 2;
        for (let a = 0; a < sx; a++) for (let b = 0; b < sz; b++) used[(iz + b) * nx + ix + a] = 1;
        const st = o.styles[Math.floor(r2 * o.styles.length) % o.styles.length];
        const h = hMax * (0.25 + 0.75 * r3 * r3);
        const bx = -w / 2 + (ix + sx / 2) * cw;
        const bz = -d / 2 + (iz + sz / 2) * cd;
        const gap = Math.min(cw, cd) * 0.12;
        if (r1 > 0.86 && sx === 1 && sz === 1) {
          const rr = Math.min(cw, cd) * 0.36;
          this.at(bx, 0, bz, () => this.cyl(rr, rr * 0.92, h * 1.2, st, { segs: 8, bevel: rr * 0.18, capA: false }), -Math.PI / 2);
        } else {
          this.at(bx, 0, bz, () => this.block(sx * cw - gap, h, sz * cd - gap, st, { bevel: Math.min(0.03, h * 0.3), taperX: 0.94, taperZ: 0.94 }));
        }
      }
    }
    const pipes = this.hero ? (o.pipes ?? 0) : 0;
    const ps = o.pipeStyle ?? o.styles[0];
    for (let k = 0; k < pipes; k++) {
      const alongX = rnd() < 0.5;
      const t = (rnd() - 0.5) * 0.8;
      const y = hMax * (0.35 + rnd() * 0.5);
      const pr = 0.02 + rnd() * 0.025;
      if (alongX) this.pipe([-w / 2, 0, t * d, -w / 2 + 0.08, y, t * d, w / 2 - 0.08, y, t * d, w / 2, 0, t * d], pr, ps, { sides: 5 });
      else this.pipe([t * w, 0, -d / 2, t * w, y, -d / 2 + 0.08, t * w, y, d / 2 - 0.08, t * w, 0, d / 2], pr, ps, { sides: 5 });
    }
  }

  // ---------------------------------------------------------------- finishing

  /** Vertices emitted so far in a channel (pair with remapEngineHeat() to post-process a part). */
  vertexCount(ch = CH_HULL): number {
    return this.bufs[ch].nv;
  }

  /**
   * Rewrite the engine-heat mask of the hull vertices emitted since `from` as a function of their final
   * (model-space) position, e.g. to grade a bell from a glowing throat to a cool lip. `cur` is the current
   * mask 0..1; return the new one.
   */
  remapEngineHeat(from: number, fn: (x: number, y: number, z: number, cur: number) => number): void {
    const B = this.bufs[CH_HULL];
    for (let i = from; i < B.nv; i++) {
      const cur = B.fx[i * 4 + 1] / 255;
      B.fx[i * 4 + 1] = Math.round(255 * clamp01(fn(B.pos[i * 3], B.pos[i * 3 + 1], B.pos[i * 3 + 2], cur)));
    }
  }

  /** Triangles emitted so far in all channels. */
  get triangleCount(): number {
    let n = 0;
    for (const b of this.bufs) n += b.ni / 3;
    return n;
  }

  /**
   * Bake a cheap voxel ambient-occlusion term into the hull channel's tint alpha: crevices, joints and
   * the gaps between stacked parts darken. Call once, after all geometry is in.
   */
  bakeAO(strength = 0.75, voxel = 0): void {
    const B = this.bufs[CH_HULL];
    if (B.nv === 0) return;
    let minx = Infinity;
    let miny = Infinity;
    let minz = Infinity;
    let maxx = -Infinity;
    let maxy = -Infinity;
    let maxz = -Infinity;
    const P = B.pos;
    for (let i = 0; i < B.nv; i++) {
      const x = P[i * 3];
      const y = P[i * 3 + 1];
      const z = P[i * 3 + 2];
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
      if (z < minz) minz = z;
      if (z > maxz) maxz = z;
    }
    const span = Math.max(maxx - minx, maxy - miny, maxz - minz);
    const vox = voxel > 0 ? voxel : Math.min(0.5, Math.max(0.07, span / 110));
    const pad = 2;
    const gx = Math.ceil((maxx - minx) / vox) + pad * 2 + 1;
    const gy = Math.ceil((maxy - miny) / vox) + pad * 2 + 1;
    const gz = Math.ceil((maxz - minz) / vox) + pad * 2 + 1;
    const occ = new Uint8Array(gx * gy * gz);
    const ox = minx - pad * vox;
    const oy = miny - pad * vox;
    const oz = minz - pad * vox;
    const inv = 1 / vox;
    const mark = (x: number, y: number, z: number): void => {
      const ix = Math.floor((x - ox) * inv);
      const iy = Math.floor((y - oy) * inv);
      const iz = Math.floor((z - oz) * inv);
      occ[(iz * gy + iy) * gx + ix] = 1;
    };
    // rasterise triangles of the hull (and glass) channels
    for (const ch of [CH_HULL, CH_GLASS]) {
      const C = this.bufs[ch];
      const Q = C.pos;
      for (let t = 0; t < C.ni; t += 3) {
        const a = C.idx[t] * 3;
        const b = C.idx[t + 1] * 3;
        const c = C.idx[t + 2] * 3;
        const e1 = Math.hypot(Q[b] - Q[a], Q[b + 1] - Q[a + 1], Q[b + 2] - Q[a + 2]);
        const e2 = Math.hypot(Q[c] - Q[a], Q[c + 1] - Q[a + 1], Q[c + 2] - Q[a + 2]);
        const n = Math.max(1, Math.ceil((Math.max(e1, e2) * inv) / 0.7));
        for (let i = 0; i <= n; i++) {
          for (let j = 0; j <= n - i; j++) {
            const u = i / n;
            const v = j / n;
            const w = 1 - u - v;
            mark(Q[a] * w + Q[b] * u + Q[c] * v, Q[a + 1] * w + Q[b + 1] * u + Q[c + 1] * v, Q[a + 2] * w + Q[b + 2] * u + Q[c + 2] * v);
          }
        }
      }
    }
    const hit = (x: number, y: number, z: number): number => {
      const ix = Math.floor((x - ox) * inv);
      const iy = Math.floor((y - oy) * inv);
      const iz = Math.floor((z - oz) * inv);
      if (ix < 0 || iy < 0 || iz < 0 || ix >= gx || iy >= gy || iz >= gz) return 0;
      return occ[(iz * gy + iy) * gx + ix];
    };
    const N = B.nrm;
    const steps = [1.0, 2.0, 3.3, 5.0];
    const wts = [1.0, 0.8, 0.55, 0.35];
    for (let i = 0; i < B.nv; i++) {
      const nx = N[i * 3];
      const ny = N[i * 3 + 1];
      const nz = N[i * 3 + 2];
      // tangent frame
      let tx: number;
      let ty: number;
      let tz: number;
      if (Math.abs(ny) < 0.9) {
        tx = nz;
        ty = 0;
        tz = -nx;
      } else {
        tx = 0;
        ty = -nz;
        tz = ny;
      }
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      const bx = ny * tz - nz * ty;
      const by = nz * tx - nx * tz;
      const bz = nx * ty - ny * tx;
      const px = P[i * 3] + nx * vox * 1.6;
      const py = P[i * 3 + 1] + ny * vox * 1.6;
      const pz = P[i * 3 + 2] + nz * vox * 1.6;
      let occl = 0;
      let total = 0;
      for (let d = 0; d < 9; d++) {
        let dx = nx;
        let dy = ny;
        let dz = nz;
        let wd = 1;
        if (d > 0) {
          const a = ((d - 1) / 8) * TAU + 0.3;
          const tilt = d & 1 ? 0.55 : 1.05; // rad from the normal
          const ct = Math.cos(tilt);
          const sn = Math.sin(tilt);
          const ca = Math.cos(a) * sn;
          const sa = Math.sin(a) * sn;
          dx = nx * ct + tx * ca + bx * sa;
          dy = ny * ct + ty * ca + by * sa;
          dz = nz * ct + tz * ca + bz * sa;
          wd = ct;
        }
        for (let s = 0; s < 4; s++) {
          const dist = steps[s] * vox;
          total += wts[s] * wd;
          if (hit(px + dx * dist, py + dy * dist, pz + dz * dist)) {
            // this step and everything behind the first hit is occluded
            occl += wts[s] * wd;
            for (let s2 = s + 1; s2 < 4; s2++) {
              total += wts[s2] * wd;
              occl += wts[s2] * wd;
            }
            break;
          }
        }
      }
      const ao = 1 - strength * Math.min(1, (occl / total) * 1.35);
      B.tint[i * 4 + 3] = Math.round(B.tint[i * 4 + 3] * ao);
    }
  }

  /**
   * Finish: derive the automatic heat mask, and produce one indexed BufferGeometry per channel.
   * `heatDir` is the unit direction the hot flow comes FROM during aerobraking (default: ahead-below).
   */
  build(heatDir: readonly [number, number, number] = [0, -0.5, -0.866]): BuiltModel {
    const geometries: (THREE.BufferGeometry | null)[] = [];
    let triangles = 0;
    let vertices = 0;
    const bounds = new THREE.Box3();
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      const B = this.bufs[ch];
      if (B.nv === 0 || B.ni === 0) {
        geometries.push(null);
        continue;
      }
      if (ch === CH_HULL) {
        for (let i = 0; i < B.nv; i++) {
          const d = B.nrm[i * 3] * heatDir[0] + B.nrm[i * 3 + 1] * heatDir[1] + B.nrm[i * 3 + 2] * heatDir[2];
          const aero = d > 0 ? Math.pow(d, 1.5) : 0;
          B.fx[i * 4] = Math.max(B.fx[i * 4], Math.round(aero * 255));
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(B.pos.slice(0, B.nv * 3), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(B.nrm.slice(0, B.nv * 3), 3));
      g.setAttribute('uv', new THREE.BufferAttribute(B.uv.slice(0, B.nv * 2), 2));
      g.setAttribute('aTint', new THREE.BufferAttribute(B.tint.slice(0, B.nv * 4), 4, true));
      g.setAttribute('aSurf', new THREE.BufferAttribute(B.surf.slice(0, B.nv * 4), 4, true));
      g.setAttribute('aFx', new THREE.BufferAttribute(B.fx.slice(0, B.nv * 4), 4, true));
      g.setIndex(new THREE.BufferAttribute(B.nv > 65535 ? B.idx.slice(0, B.ni) : Uint16Array.from(B.idx.subarray(0, B.ni)), 1));
      g.computeBoundingBox();
      g.computeBoundingSphere();
      if (ch === CH_HULL && g.boundingBox) bounds.copy(g.boundingBox);
      geometries.push(g);
      triangles += B.ni / 3;
      vertices += B.nv;
    }
    return { geometries, triangles, vertices, bounds };
  }
}

const _hc: THREE.Vector3[] = [];
for (let i = 0; i < 8; i++) _hc.push(new THREE.Vector3());

/** Faces of a hexahedron as corner indices (bit 0 = +x, bit 1 = +y, bit 2 = +z), CCW from outside. */
const HEXA_FACES: readonly (readonly number[])[] = [
  [0, 4, 6, 2], // -X
  [1, 3, 7, 5], // +X
  [0, 1, 5, 4], // -Y
  [2, 6, 7, 3], // +Y
  [0, 2, 3, 1], // -Z
  [4, 5, 7, 6], // +Z
];

/** Corner pairs giving the texture u axis of each hexahedron face. */
const HEXA_U: readonly (readonly number[])[] = [
  [0, 4],
  [1, 5],
  [0, 1],
  [2, 3],
  [0, 1],
  [4, 5],
];

/** Eight corner vectors for MeshBuilder.hexa() from a flat list of 24 numbers (corner index = x+ | y+<<1 | z+<<2). */
export function corners(flat: readonly number[]): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < 8; i++) out.push(new THREE.Vector3(flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]));
  return out;
}

/**
 * Corners of a prism between two rectangles: the -Z face is (w0 x h0) centred at (x0, y0, z0), the +Z face
 * (w1 x h1) centred at (x1, y1, z1). Handy for wedges, fairings and tapering booms.
 */
export function taperCorners(z0: number, w0: number, h0: number, z1: number, w1: number, h1: number, x0 = 0, y0 = 0, x1 = 0, y1 = 0): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < 8; i++) {
    const back = (i & 4) !== 0;
    const w = back ? w1 : w0;
    const h = back ? h1 : h0;
    out.push(new THREE.Vector3((back ? x1 : x0) + (i & 1 ? w / 2 : -w / 2), (back ? y1 : y0) + (i & 2 ? h / 2 : -h / 2), back ? z1 : z0));
  }
  return out;
}
