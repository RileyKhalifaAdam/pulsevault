// The seven player / NPC hulls (docs/ARCHITECTURE.md section 7), built procedurally with geo.ts and
// shaded with the hull-material library. True size in metres, nose toward -Z, up +Y, starboard +X.
//
//   createShipVisual(id, { quality, livery?, seed? }) -> { object3d, layout, update(ctx), dispose() }
//
// A ship is at most five draw calls (hull, glass, glow, flare sprites, decals) per LOD (the Wren: hero LOD
// ~1e5 triangles, reduced LOD about a third of that). Geometry is
// livery-independent (paint colours are material uniforms) and cached per hull / LOD / variant, so
// traffic that differs only in paint shares vertex buffers. Nozzles, RCS blocks, hardpoint mounts, the
// docking collar and the navigation lights are placed from data/shipLayouts.ts.

import * as THREE from 'three';
import type { RGB, ShipLayout, ShipVisualId, V3 } from '../../core/types';
import { SHIP_LAYOUTS } from '../../data/shipLayouts';
import {
  type BuiltModel,
  CHANNEL_COUNT,
  CH_FLARE,
  CH_GLASS,
  CH_HULL,
  type Corner,
  GLOW,
  LAYER,
  MeshBuilder,
  type Style,
  type Surface,
  TAU,
  curve,
  decalGlyphRect,
  decalIconRect,
  decalStyle,
  flareStyle,
  glassStyle,
  glowStyle,
  hullStyle,
  sectionCurve,
  seeded,
  superSection,
  symSection,
  symSectionCount,
} from './geo';
import { type HullMaterials, type HullQuality, type Livery, createHullMaterials } from './hullMaterials';

export type { Livery } from './hullMaterials';

// ================================================================================================ styles

const W: RGB = [1, 1, 1];

/** Finishes shared by every hull. Paint finishes use livery slots, so geometry is paint-independent. */
const ST = {
  P: hullStyle(LAYER.panel, W, 0.1, 0.5, { slot: 1, wear: 0.36, grime: 0.5 }),
  P2: hullStyle(LAYER.panel, [0.74, 0.74, 0.74], 0.1, 0.58, { slot: 1, wear: 0.42, grime: 0.6 }),
  S: hullStyle(LAYER.panel, W, 0.18, 0.56, { slot: 2, wear: 0.46, grime: 0.6 }),
  S2: hullStyle(LAYER.panel, [0.7, 0.7, 0.7], 0.18, 0.62, { slot: 2, wear: 0.5, grime: 0.65 }),
  A: hullStyle(LAYER.panel, W, 0.08, 0.44, { slot: 3, wear: 0.5, grime: 0.4 }),
  armor: hullStyle(LAYER.armor, [0.9, 0.9, 0.9], 0.2, 0.62, { slot: 1, wear: 0.3, grime: 0.6 }),
  armorS: hullStyle(LAYER.armor, W, 0.22, 0.64, { slot: 2, wear: 0.34, grime: 0.65 }),
  metal: hullStyle(LAYER.metal, [0.6, 0.58, 0.55], 1, 0.34, { wear: 0, grime: 0.3 }),
  steel: hullStyle(LAYER.metal, [0.27, 0.28, 0.3], 1, 0.46, { wear: 0, grime: 0.5 }),
  dark: hullStyle(LAYER.metal, [0.05, 0.053, 0.06], 0.75, 0.58, { wear: 0.2, grime: 0.6 }),
  pit: hullStyle(LAYER.carbon, [0.012, 0.012, 0.014], 0.2, 0.7, { wear: 0, grime: 0.2 }),
  hot: hullStyle(LAYER.metal, [0.2, 0.19, 0.18], 1, 0.44, { wear: 0, grime: 0.55, engineHeat: 1 }),
  tile: hullStyle(LAYER.tile, [0.04, 0.041, 0.046], 0, 0.82, { wear: 0, grime: 0.3, heat: 0.55 }),
  carbon: hullStyle(LAYER.carbon, [0.055, 0.058, 0.064], 0.3, 0.4, { wear: 0, grime: 0.25 }),
  foil: hullStyle(LAYER.foil, [0.86, 0.62, 0.22], 1, 0.3, { wear: 0, grime: 0.1 }),
  foilSilver: hullStyle(LAYER.foil, [0.72, 0.73, 0.75], 1, 0.28, { wear: 0, grime: 0.1 }),
  rad: hullStyle(LAYER.radiator, [0.09, 0.092, 0.1], 0.85, 0.5, { wear: 0, grime: 0.25, heat: 1 }),
  radLight: hullStyle(LAYER.radiator, [0.5, 0.51, 0.52], 0.35, 0.58, { wear: 0, grime: 0.35, heat: 1 }),
  ribP: hullStyle(LAYER.ribbed, W, 0.25, 0.58, { slot: 1, wear: 0.55, grime: 0.65 }),
  ribS: hullStyle(LAYER.ribbed, W, 0.25, 0.6, { slot: 2, wear: 0.55, grime: 0.7 }),
  ribA: hullStyle(LAYER.ribbed, W, 0.2, 0.55, { slot: 3, wear: 0.6, grime: 0.6 }),
  ribGrey: hullStyle(LAYER.ribbed, [0.3, 0.31, 0.32], 0.4, 0.6, { wear: 0.5, grime: 0.7 }),
  ribRust: hullStyle(LAYER.ribbed, [0.3, 0.12, 0.06], 0.3, 0.7, { wear: 0.6, grime: 0.8 }),
  ribBlue: hullStyle(LAYER.ribbed, [0.07, 0.16, 0.3], 0.25, 0.6, { wear: 0.55, grime: 0.7 }),
  ribTan: hullStyle(LAYER.ribbed, [0.5, 0.42, 0.28], 0.25, 0.62, { wear: 0.55, grime: 0.7 }),
  tankWhite: hullStyle(LAYER.metal, [0.72, 0.72, 0.7], 0.25, 0.5, { wear: 0.1, grime: 0.45 }),
  ribGreen: hullStyle(LAYER.ribbed, [0.07, 0.19, 0.11], 0.25, 0.62, { wear: 0.55, grime: 0.7 }),
  ribWhite: hullStyle(LAYER.ribbed, [0.6, 0.6, 0.57], 0.25, 0.6, { wear: 0.5, grime: 0.75 }),
  /** fixed off-white superstructure paint (independent of the livery) */
  white: hullStyle(LAYER.panel, [0.64, 0.63, 0.6], 0.08, 0.5, { wear: 0.3, grime: 0.5 }),
  /** safety yellow for cranes, booms and handling gear */
  yellow: hullStyle(LAYER.panel, [0.6, 0.38, 0.035], 0.12, 0.55, { wear: 0.55, grime: 0.55 }),
  /** rubble in an ore hopper */
  ore: hullStyle(LAYER.foil, [0.1, 0.078, 0.062], 0.3, 0.9, { wear: 0, grime: 0.3 }),
  armorA: hullStyle(LAYER.armor, W, 0.4, 0.5, { slot: 3, wear: 0.6, grime: 0.5 }),
  seat: hullStyle(LAYER.carbon, [0.11, 0.1, 0.09], 0.05, 0.75, { wear: 0, grime: 0.1 }),
  glass: glassStyle(),
} as const;

const DC = {
  white: decalStyle([0.82, 0.82, 0.8], 0.95),
  dark: decalStyle([0.022, 0.024, 0.028], 0.95),
  accent: decalStyle(W, 1, 3),
  secondary: decalStyle(W, 1, 2),
  yellow: decalStyle([0.85, 0.58, 0.04], 0.95),
  red: decalStyle([0.62, 0.05, 0.03], 0.95),
  soot: decalStyle([0.008, 0.008, 0.008], 0.85),
  scuff: decalStyle([0.5, 0.5, 0.5], 0.5),
};

const glowCache = new Map<string, Style>();
function cached(key: string, make: () => Style): Style {
  let s = glowCache.get(key);
  if (!s) {
    s = make();
    glowCache.set(key, s);
  }
  return s;
}
const engineGlow = (c: RGB): Style => cached(`e${c}`, () => glowStyle(GLOW.engine, c, 16));
const lamp = (c: RGB, i: number, switched = false): Style => cached(`l${c}:${i}:${switched}`, () => glowStyle(GLOW.steady, c, i, { switched }));
const windows = (cell: number, alongV: boolean, i = 4.5): Style => cached(`w${cell}:${alongV}:${i}`, () => glowStyle(GLOW.window, [1, 0.76, 0.46], i, { cell, alongV }));
const heatGlow = cached('heat', () => glowStyle(GLOW.heat, [1, 0.3, 0.06], 6));

const WARM: RGB = [1, 0.74, 0.42];
const WHITE: RGB = [1, 0.95, 0.88];
const REDL: RGB = [1, 0.12, 0.05];

type FaceDir = 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz';
const basis = (x: readonly number[], y: readonly number[], z: readonly number[]): THREE.Matrix4 =>
  new THREE.Matrix4().makeBasis(new THREE.Vector3(x[0], x[1], x[2]), new THREE.Vector3(y[0], y[1], y[2]), new THREE.Vector3(z[0], z[1], z[2]));
/**
 * Frames for flat details on an axis-aligned face: local +Y is the face normal, and decal text reads
 * upright for someone looking at the face (text advance = local +X, glyph tops = local -Z).
 */
const FACE: Record<FaceDir, THREE.Matrix4> = {
  px: basis([0, 0, -1], [1, 0, 0], [0, -1, 0]),
  nx: basis([0, 0, 1], [-1, 0, 0], [0, -1, 0]),
  py: new THREE.Matrix4(),
  ny: basis([1, 0, 0], [0, -1, 0], [0, 0, -1]),
  pz: basis([1, 0, 0], [0, 0, 1], [0, -1, 0]),
  nz: basis([-1, 0, 0], [0, 0, -1], [0, -1, 0]),
};
const CYAN: RGB = [0.35, 0.85, 1];
const AMBER: RGB = [1, 0.62, 0.2];

// ================================================================================================ kit

type Sec = readonly (readonly [number, number, number])[];

/** What a paint callback learns about the quad it is colouring. */
interface PaintQ {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  /** sectioned lofts: corner coordinate (k = on the fillet of corner k, k + 0.5 = on the facet after it); tubes: u 0..1 */
  c: number;
  /** +1 starboard half, -1 port half */
  side: number;
  qi: number;
  qj: number;
}
type Paint = Style | ((q: PaintQ) => Style | null);

interface LoftOpts {
  /** number of ring intervals at hero detail */
  n: number;
  /** extra ring positions (z), e.g. paint boundaries */
  extra?: readonly number[];
  paint: Paint;
  capStart?: Style | null;
  capEnd?: Style | null;
  crease?: number;
  segs?: number;
}

function ringZs(n: number, must: readonly number[], z0: number, z1: number): number[] {
  const step = (z1 - z0) / n;
  const out: number[] = [];
  for (const m of must) if (m >= z0 - 1e-6 && m <= z1 + 1e-6) out.push(m);
  for (let i = 0; i <= n; i++) {
    const z = z0 + step * i;
    let ok = true;
    for (const m of must) if (Math.abs(m - z) < step * 0.35) ok = false;
    if (ok) out.push(z);
  }
  out.sort((a, b) => a - b);
  const res: number[] = [];
  for (const z of out) if (!res.length || z - res[res.length - 1] > 1e-4) res.push(z);
  return res;
}

class Kit {
  readonly b: MeshBuilder;
  readonly hero: boolean;
  /** fillet segments of sectioned lofts */
  readonly segs: number;
  readonly L: ShipLayout;
  private readonly q: PaintQ = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, c: 0, side: 1, qi: 0, qj: 0 };

  constructor(
    readonly id: ShipVisualId,
    detail: number,
    readonly variant: number,
    readonly mounts: boolean,
    uvScale: number,
  ) {
    this.b = new MeshBuilder({ detail, uvScale, seed: 977 + variant * 131 });
    this.hero = this.b.hero;
    this.segs = this.hero ? 4 : 2;
    this.L = SHIP_LAYOUTS[id];
  }

  /** u of a point on the facet after corner `k` (f = 0 at corner k's fillet, 1 at the next) of an `nc`-corner section. */
  fu(nc: number, k: number, f: number, port = false, segs = this.segs): number {
    const u = ((segs >> 1) + k * (segs + 1) + f) / symSectionCount(nc, segs);
    return port ? 1 - u : u;
  }

  /** Ascending [u0, u1] spanning f0..f1 of the facet after corner `k` (see fu). */
  fr(nc: number, k: number, f0: number, f1: number, port = false): [number, number] {
    const a = this.fu(nc, k, f0, port);
    const c = this.fu(nc, k, f1, port);
    return a < c ? [a, c] : [c, a];
  }

  /** Raised conformal plate on a facet of a sectioned loft. */
  panel(s: Surface, nc: number, k: number, f0: number, f1: number, z0: number, z1: number, port: boolean, style: Style, lift = 0.025, nu = 3, nv = 4): Surface {
    const [u0, u1] = this.fr(nc, k, f0, f1, port);
    return this.b.plateOn(s, u0, u1, z0, z1, { lift, style, nu, nv });
  }

  /** Row of lit windows on a facet of a sectioned loft (the strip runs along the hull). */
  win(s: Surface, nc: number, k: number, f0: number, f1: number, z0: number, z1: number, port: boolean, cell = 0.7, intensity = 4.5): void {
    const [u0, u1] = this.fr(nc, k, f0, f1, port);
    this.b.plateOn(s, u0, u1, z0, z1, { lift: 0.02, bevel: 0.015, style: windows(cell, true, intensity), nu: 1, nv: 2 });
  }

  /** Window glazing over a parameter rectangle of a surface: a dark reveal with a glass pane above it. */
  glazing(s: Surface, u0: number, u1: number, z0: number, z1: number, nu = 3, nv = 2): void {
    this.b.plateOn(s, u0, u1, z0, z1, { lift: 0.012, style: ST.pit, nu, nv, bevel: 0.01 });
    this.b.plateOn(s, u0, u1, z0, z1, { lift: 0.045, style: ST.glass, nu, nv, bevel: 0.03 });
  }

  /** Run fn in a frame lying on an axis-aligned face through (x, y, z) — see FACE. */
  face(x: number, y: number, z: number, dir: FaceDir, fn: () => void): void {
    this.b.at(x, y, z, () => this.b.with(FACE[dir], fn));
  }

  /** Rounded-box loft from stations [z, halfWidth, yTop, yBottom, cornerRadius]: corners are top centre, top edge, bottom edge, keel. */
  hullBox(st: readonly (readonly number[])[], o: LoftOpts): Surface {
    return this.loft(
      st.map<[number, Sec]>((s) => [s[0], [[0, s[2], 0], [s[1], s[2], s[4] ?? 0.3], [s[1], s[3], s[4] ?? 0.3], [0, s[3], 0]]]),
      o,
    );
  }

  /** Thin fin standing on (x, y): `outline` is [height, z, ...]; `cant` leans it outboard (rad); down = hanging fin. */
  fin(x: number, y: number, outline: readonly number[], thick: number, cant: number, style: Style, edge: Style = ST.metal, down = false, sharp = true): void {
    const a = Math.PI / 2 - cant;
    this.b.at(x, y, 0, () => this.b.plate(outline, thick, { style, edgeStyle: edge, bevel: Math.min(0.12, thick * 0.6), sharp }), 0, 0, down ? -a : a);
  }

  /** Bubble canopy with coaming, seat and lit instruments; `s` scales the Wren-sized original, `len` stretches it. */
  canopy(x: number, y: number, z: number, s: number, pitch = -0.115, len = 1): void {
    const b = this.b;
    b.at(
      x,
      y,
      z,
      () => {
        b.with(new THREE.Matrix4().makeScale(0.92 * s, 0.31 * s, 1.84 * s * len), () => b.sphere(1, ST.dark, 22));
        b.at(0, 0.15 * s, 0, () => b.with(new THREE.Matrix4().makeScale(0.75 * s, 0.62 * s, 1.6 * s * len), () => b.sphere(1, ST.glass, 24)));
        // frame: two hoops over the bubble and a sill round its base
        for (const fz of [-0.42, 0.52]) {
          const rr = Math.sqrt(1 - (fz / 1.0) * (fz / 1.0)) * 1.012;
          b.at(0, 0.15 * s, fz * 1.6 * s * len, () =>
            b.with(new THREE.Matrix4().makeScale(0.75 * s * rr, 0.62 * s * rr, 1), () => b.torus(1, 0.035, ST.steel, { segs: 20, tube: 4, a0: -Math.PI / 2, a1: Math.PI / 2 })),
          );
        }
        // seat, headrest, dash with instrument glow
        b.at(0, 0.36 * s, 0.45 * s, () => b.box(0.52 * s, 0.5 * s, 0.16 * s, ST.seat, { bevel: 0.04 * s }), -0.2);
        b.at(0, 0.66 * s, 0.5 * s, () => b.box(0.26 * s, 0.2 * s, 0.12 * s, ST.seat, { bevel: 0.03 * s }), -0.2);
        b.at(0, 0.3 * s, -0.75 * s, () => {
          b.box(0.95 * s, 0.22 * s, 0.5 * s, ST.pit, { bevel: 0.05 * s });
          b.at(0, 0.115 * s, 0.06 * s, () => b.box(0.5 * s, 0.012, 0.22 * s, lamp(CYAN, 2.2)), 0.5);
          b.at(-0.33 * s, 0.115 * s, 0.1 * s, () => b.box(0.12 * s, 0.012, 0.16 * s, lamp(AMBER, 2.2)), 0.5);
          b.at(0.33 * s, 0.115 * s, 0.1 * s, () => b.box(0.12 * s, 0.012, 0.16 * s, lamp(AMBER, 2.2)), 0.5);
        });
      },
      pitch,
    );
  }

  /** Flood / work lamp: housing, lit lens facing -Z (forward) and a flare. */
  flood(x: number, y: number, z: number, s: number, col: RGB = WARM, intensity = 7): void {
    const b = this.b;
    b.at(x, y, z, () => {
      b.box(0.34 * s, 0.26 * s, 0.3 * s, ST.dark, { bevel: 0.04 * s });
      b.at(0, 0, -0.16 * s, () => b.box(0.26 * s, 0.18 * s, 0.02, lamp(col, intensity, true)));
      if (this.mounts) b.at(0, 0, -0.2 * s, () => b.flare(flareStyle(col, intensity * 0.7, 0.45 * s, { switched: true })));
    });
  }

  private fillQ(R: Float32Array[], K: number, qi: number, qj: number): PaintQ {
    const q = this.q;
    const a = R[qj];
    const c = R[qj + 1];
    const i0 = qi * 3;
    const i1 = ((qi + 1) % K) * 3;
    q.x = (a[i0] + a[i1] + c[i0] + c[i1]) * 0.25;
    q.y = (a[i0 + 1] + a[i1 + 1] + c[i0 + 1] + c[i1 + 1]) * 0.25;
    q.z = (a[i0 + 2] + a[i1 + 2] + c[i0 + 2] + c[i1 + 2]) * 0.25;
    // diagonals: (c1 - a0) x (a1 - c0) ~ dv x du (outward for the loft convention)
    const ux = c[i1] - a[i0];
    const uy = c[i1 + 1] - a[i0 + 1];
    const uz = c[i1 + 2] - a[i0 + 2];
    const vx = a[i1] - c[i0];
    const vy = a[i1 + 1] - c[i0 + 1];
    const vz = a[i1 + 2] - c[i0 + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    q.nx = nx;
    q.ny = ny;
    q.nz = nz;
    q.qi = qi;
    q.qj = qj;
    return q;
  }

  /**
   * Hull loft from X-symmetric corner sections: stations are [z, [[x, y, filletRadius], ...]] with the
   * corners listed from the top centre to the keel. Returns the Surface (v = z in metres).
   */
  loft(st: readonly (readonly [number, Sec])[], o: LoftOpts): Surface {
    const b = this.b;
    const segs = o.segs ?? this.segs;
    const nc = st[0][1].length;
    const K = symSectionCount(nc, segs);
    const hN = K / 2 + 1;
    const e0 = segs >> 1;
    const sc = sectionCurve(st);
    const zs = ringZs(b.seg(o.n, 3), [...st.map((s) => s[0]), ...(o.extra ?? [])], st[0][0], st[st.length - 1][0]);
    const R: Float32Array[] = [];
    const cs: Corner[] = [];
    const flat: number[] = [];
    const paint = o.paint;
    return b.loft({
      ts: zs,
      K,
      ring: (t, out) => {
        sc(t, cs);
        symSection(cs, segs, flat);
        for (let i = 0; i < K; i++) {
          out[i * 3] = flat[i * 2];
          out[i * 3 + 1] = flat[i * 2 + 1];
          out[i * 3 + 2] = t;
        }
        R.push(out.slice());
      },
      style:
        typeof paint === 'function'
          ? (_u, _v, qi, qj) => {
              const q = this.fillQ(R, K, qi, qj);
              q.side = qi < hN - 1 ? 1 : -1;
              const i = q.side > 0 ? qi : K - 1 - qi;
              if (i < e0) q.c = 0;
              else {
                const rel = i - e0;
                const k = Math.floor(rel / (segs + 1));
                q.c = rel % (segs + 1) === 0 ? k + 0.5 : k + 1;
              }
              return paint(q);
            }
          : paint,
      crease: o.crease,
      capStart: o.capStart,
      capEnd: o.capEnd,
    });
  }

  /**
   * Round (superelliptic) loft: keys are [z, rx, ry?, yc?, xc?]; `p` is the superellipse exponent
   * (2 = round, 3+ = boxy). u = 0 on top, 0.25 starboard, 0.5 below.
   */
  tube(keys: readonly (readonly number[])[], o: LoftOpts & { K?: number; p?: number }): Surface {
    const b = this.b;
    const K = b.seg(o.K ?? 20, 8) & ~1;
    const p = o.p ?? 2;
    const flatKeys = (i: number, d: (k: readonly number[]) => number): number[] => {
      void i;
      const out: number[] = [];
      for (const k of keys) out.push(k[0], d(k));
      return out;
    };
    const rx = curve(flatKeys(1, (k) => k[1]));
    const ry = curve(flatKeys(2, (k) => k[2] ?? k[1]));
    const yc = curve(flatKeys(3, (k) => k[3] ?? 0));
    const xc = curve(flatKeys(4, (k) => k[4] ?? 0));
    const zs = ringZs(b.seg(o.n, 2), [...keys.map((k) => k[0]), ...(o.extra ?? [])], keys[0][0], keys[keys.length - 1][0]);
    const R: Float32Array[] = [];
    const flat: number[] = [];
    const paint = o.paint;
    return b.loft({
      ts: zs,
      K,
      ring: (t, out) => {
        superSection(K, Math.max(1e-4, rx(t)), Math.max(1e-4, ry(t)), Math.max(1e-4, ry(t)), p, p, yc(t), flat);
        const x0 = xc(t);
        for (let i = 0; i < K; i++) {
          out[i * 3] = flat[i * 2] + x0;
          out[i * 3 + 1] = flat[i * 2 + 1];
          out[i * 3 + 2] = t;
        }
        R.push(out.slice());
      },
      style:
        typeof paint === 'function'
          ? (u, _v, qi, qj) => {
              const q = this.fillQ(R, K, qi, qj);
              q.c = u;
              q.side = u < 0.5 ? 1 : -1;
              return paint(q);
            }
          : paint,
      crease: o.crease ?? 0.8,
      capStart: o.capStart,
      capEnd: o.capEnd,
      uvMirror: false,
    });
  }

  // ---------------------------------------------------------------- layout-driven parts

  /** Main-engine bell with its exit plane at the layout position; `len` is the bell length. */
  engine(i: number, len: number, col: RGB, hoops = 3): void {
    const b = this.b;
    const e = this.L.engines[i];
    const r = e.radius;
    const v0 = b.vertexCount();
    b.at(e.pos.x, e.pos.y, e.pos.z - len, () => {
      b.nozzle({ throatR: r * 0.4, exitR: r, length: len, style: ST.hot, inner: engineGlow(col), hoops, segs: r > 1.4 ? 28 : 20, wall: Math.max(0.025, r * 0.045) });
      b.at(0, 0, -len * 0.3, () => b.cyl(r * 0.66, r * 0.5, len * 0.3, ST.steel, { segs: 14, bevel: r * 0.05 }));
      if (this.hero) {
        // gimbal actuators and feed lines
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * TAU + 0.785;
          const sx = Math.sin(a);
          const cy = Math.cos(a);
          b.strut(sx * r * 0.62, cy * r * 0.62, -len * 0.22, sx * r * 0.72, cy * r * 0.72, len * 0.34, r * 0.045, ST.metal, 5);
        }
        // turbopump exhaust duct wrapped round the throat
        b.at(0, 0, len * 0.1, () => b.torus(r * 0.7, r * 0.055, ST.steel, { segs: 16, tube: 5 }));
      }
    });
    // the bell glows from the throat outward: grade the heat mask along its length
    const zT = e.pos.z - len;
    b.remapEngineHeat(v0, (_x, _y, z, cur) => cur * Math.pow(1 - Math.min(1, Math.max(0, (z - zT) / len)), 1.4));
  }

  /** RCS quad at every layout position: a low puck let into the hull carrying a main jet and four canted side jets. */
  rcsBlocks(s: number): void {
    if (!this.mounts) return;
    const b = this.b;
    for (const r of this.L.rcs) {
      const p = r.pos;
      const d = r.dir;
      b.between(p.x - d.x * 0.1 * s, p.y - d.y * 0.1 * s, p.z - d.z * 0.1 * s, p.x + d.x, p.y + d.y, p.z + d.z, () => {
        b.cyl(0.3 * s, 0.24 * s, 0.2 * s, ST.steel, { segs: 10, bevel: 0.035 * s, capA: false });
        b.at(0, 0, 0.19 * s, () => b.cyl(0.05 * s, 0.11 * s, 0.11 * s, ST.dark, { segs: 8, capB: false }));
        if (this.hero) {
          for (let q = 0; q < 4; q++) {
            const a = (q / 4) * TAU + 0.785;
            const sx = Math.sin(a);
            const cy = Math.cos(a);
            b.between(sx * 0.12 * s, cy * 0.12 * s, 0.15 * s, sx * 0.34 * s, cy * 0.34 * s, 0.27 * s, () => b.cyl(0.035 * s, 0.075 * s, 0.13 * s, ST.dark, { segs: 6, capB: false }));
          }
        }
      });
    }
  }

  /** Lens + additive flare for every layout light. */
  navLights(s: number): void {
    if (!this.mounts) return;
    const b = this.b;
    for (const l of this.L.lights) {
      const strobe = l.blink > 0;
      const lens = strobe ? glowStyle(GLOW.blink, l.color, 10, { period: l.blink, duty: 0.1, switched: true }) : glowStyle(GLOW.steady, l.color, 5, { switched: true });
      b.at(l.pos.x, l.pos.y, l.pos.z, () => {
        b.sphere(0.075 * s, lens, 8);
        b.flare(flareStyle(l.color, strobe ? 8 : 4.5, Math.min(3.6, (strobe ? 0.6 : 0.5) * s), { period: l.blink, duty: 0.1, switched: true }));
      });
    }
  }

  /** Docking collar with its mating plane at the layout port. */
  dockCollar(r: number): void {
    if (!this.mounts) return;
    const b = this.b;
    const p = this.L.dockingPort.pos;
    const d = this.L.dockingPort.dir;
    const h = r * 0.34;
    b.between(p.x - d.x * h, p.y - d.y * h, p.z - d.z * h, p.x, p.y, p.z, () => {
      b.ring(r * 0.72, r, h, ST.metal, { segs: 24, bevel: r * 0.05 });
      b.at(0, 0, -h * 0.25, () => b.ring(r * 0.7, r * 1.2, h * 0.5, ST.steel, { segs: 24, bevel: r * 0.04 }));
      b.cyl(r * 0.73, r * 0.73, h * 0.55, ST.dark, { segs: 20, capA: false });
      b.at(0, 0, h * 0.56, () => b.cyl(r * 0.2, r * 0.2, 0.02, lamp(AMBER, 1.2), { segs: 8, capA: false }));
      if (this.hero) {
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * TAU + 0.785;
          b.at(Math.sin(a) * r * 1.02, Math.cos(a) * r * 1.02, h * 0.45, () => b.box(r * 0.2, r * 0.16, h * 0.9, ST.steel, { bevel: r * 0.025 }), 0, 0, -a);
        }
      }
    });
  }

  /** Empty weapon mounts: a pylon reaching `reach` metres toward the hull (along `toward`) and a rail. */
  hardpoints(toward: (i: number) => readonly [number, number, number], reach = 0.3): void {
    if (!this.mounts) return;
    const b = this.b;
    this.L.hardpoints.forEach((hp, i) => {
      const s = 0.55 + 0.3 * hp.size;
      const t = toward(i);
      const p = hp.pos;
      b.strut(p.x, p.y, p.z, p.x + t[0] * reach, p.y + t[1] * reach, p.z + t[2] * reach, 0.16 * s, ST.steel, 4);
      b.at(p.x, p.y, p.z, () => {
        b.box(0.26 * s, 0.2 * s, 1.3 * s, ST.dark, { bevel: 0.03 * s });
        b.at(0, 0, -0.5 * s, () => b.box(0.34 * s, 0.26 * s, 0.14 * s, ST.metal, { bevel: 0.02 * s }));
        b.at(0, 0, 0.42 * s, () => b.box(0.34 * s, 0.26 * s, 0.14 * s, ST.metal, { bevel: 0.02 * s }));
      });
    });
  }

  /** Whip antenna from a to b. */
  whip(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r = 0.02): void {
    this.b.strut(ax, ay, az, bx, by, bz, r, ST.steel, 4, r * 0.4);
    this.b.at(ax, ay, az, () => this.b.sphere(r * 2.6, ST.dark, 6));
  }

  /** Flat decal from the icon atlas, lying in the local XZ plane (see MeshBuilder.decal). */
  icon(name: Parameters<typeof decalIconRect>[0], w: number, h: number, st: Style): void {
    this.b.decal(w, h, decalIconRect(name), st);
  }

  /**
   * Armour plate standing `lift` proud of a loft between u positions `ua`, `ub` (either order) and v (= z)
   * z0..z1. Unlike MeshBuilder.plateOn the columns follow the loft's own ring points (`K` per ring), so plates
   * stay exact on faceted sections, and the chamfer is `bevel` metres measured at each edge. Top level only.
   */
  armour(s: Surface, K: number, ua: number, ub: number, z0: number, z1: number, style: Style, lift: number, bevel = 0.045): void {
    const u0 = Math.min(ua, ub);
    const u1 = Math.max(ua, ub);
    if (u1 - u0 < 1e-5 || z1 <= z0) return;
    const m = { mu: 0, mv: 0 };
    const zm = (z0 + z1) / 2;
    s.metric(Math.min(u1, u0 + 0.25 / K), zm, m);
    const du0 = Math.min((u1 - u0) * 0.3, bevel / m.mu);
    s.metric(Math.max(u0, u1 - 0.25 / K), zm, m);
    const du1 = Math.min((u1 - u0) * 0.3, bevel / m.mu);
    s.metric((u0 + u1) / 2, zm, m);
    const dz = Math.min((z1 - z0) * 0.3, bevel / m.mv);
    const a = u0 + du0;
    const c = u1 - du1;
    const us: number[] = [a];
    for (let i = Math.floor(a * K) + 1; i < c * K; i++) if (i / K - us[us.length - 1] > 0.1 / K && c - i / K > 0.1 / K) us.push(i / K);
    us.push(c);
    const nz = Math.max(2, this.b.seg(Math.ceil((z1 - z0) / 0.8), 1) + 1);
    const vs: number[] = [];
    for (let j = 0; j < nz; j++) vs.push(z0 + dz + ((z1 - z0 - 2 * dz) * j) / (nz - 1));
    const nu = us.length + 2;
    const nv = vs.length + 2;
    const nrm = new THREE.Vector3();
    this.b.grid({
      nu,
      nv,
      pos: (i, j, out) => {
        const edge = i === 0 || j === 0 || i === nu - 1 || j === nv - 1;
        const uu = i === 0 ? u0 : i === nu - 1 ? u1 : us[i - 1];
        const vv = j === 0 ? z0 : j === nv - 1 ? z1 : vs[j - 1];
        s.sample(uu, vv, out, nrm);
        out.addScaledVector(nrm, edge ? -0.012 : lift);
      },
      style,
      crease: 0.45,
      flip: s.flipped,
      uvMirror: false,
      u0: this.b.rand() * 5,
      v0: this.b.rand() * 5,
    });
  }

  /** Stencilled text on a Surface like MeshBuilder.textOn, standing `lift` off it (text on raised plates). */
  textLift(s: Surface, u: number, v: number, text: string, h: number, st: Style, rot: number, lift: number, spacing = 0.72): void {
    const m = { mu: 0, mv: 0 };
    s.metric(u, v, m);
    const adv = h * spacing;
    const total = adv * (text.length - 1);
    for (let i = 0; i < text.length; i++) {
      const rect = decalGlyphRect(text[i]);
      if (!rect) continue;
      const a = -total / 2 + i * adv;
      let du = 0;
      let dv = 0;
      if (rot === 0) du = a / m.mu;
      else if (rot === 1) dv = -a / m.mv;
      else if (rot === 2) du = -a / m.mu;
      else dv = a / m.mv;
      this.b.decalOn(s, u + du, v + dv, h, h, rect, st, rot, 2, lift);
    }
  }
}

// ================================================================================================ hulls

// ------------------------------------------------------------------------------------------------ Corvane Wren

/** Finishes of the Wren: white clear-coat armour over a gunmetal body, machinery, red accent paint. */
const WR = {
  /** smooth white clear-coat armour (livery primary) */
  white: hullStyle(LAYER.panel, W, 0.04, 0.34, { slot: 1, wear: 0.2, grime: 0.3 }),
  /** heavier bolted white plate: nose, canopy cowl */
  whiteA: hullStyle(LAYER.armor, [0.97, 0.97, 0.96], 0.04, 0.38, { slot: 1, wear: 0.26, grime: 0.38 }),
  /** dark gunmetal body (livery secondary) */
  gun: hullStyle(LAYER.panel, W, 0.4, 0.42, { slot: 2, wear: 0.12, grime: 0.55 }),
  /** exposed machinery: dark steel, machined bright metal */
  mach: hullStyle(LAYER.metal, [0.17, 0.175, 0.19], 1, 0.4, { wear: 0, grime: 0.65 }),
  bright: hullStyle(LAYER.metal, [0.55, 0.54, 0.52], 1, 0.3, { wear: 0, grime: 0.45 }),
  /** dark composite belly */
  comp: hullStyle(LAYER.carbon, [0.05, 0.052, 0.058], 0.2, 0.55, { wear: 0, grime: 0.45 }),
  /** red accent paint (livery accent) */
  red: hullStyle(LAYER.panel, W, 0.1, 0.38, { slot: 3, wear: 0.45, grime: 0.4 }),
  /** canopy and window frames */
  frame: hullStyle(LAYER.metal, [0.075, 0.08, 0.09], 0.9, 0.34, { wear: 0, grime: 0.35 }),
  /** cockpit / lounge dressing seen through the glass from outside */
  seat: hullStyle(LAYER.carbon, [0.03, 0.03, 0.033], 0.1, 0.6, { wear: 0, grime: 0.1 }),
  amber: hullStyle(LAYER.carbon, [0.62, 0.26, 0.04], 0, 0.62, { wear: 0, grime: 0.1 }),
  leather: hullStyle(LAYER.carbon, [0.28, 0.025, 0.022], 0, 0.5, { wear: 0, grime: 0.1 }),
  veneer: hullStyle(LAYER.ribbed, [0.12, 0.06, 0.03], 0, 0.45, { wear: 0, grime: 0.1 }),
} as const;

type P3 = readonly [number, number, number];
/** One body station: top centre, spine edge, shoulder, chamfer foot, three window-band points (x, y pairs), sill, chine, belly edge, keel. */
const wst = (z: number, top: number, sp: number, sh: P3, ch: P3, sx: readonly number[], sill: P3, chine: P3, be: P3, keel: number): readonly [number, Sec] => [
  z,
  [[0, top, 0], [sp, top - 0.005, 0.05], sh, ch, [sx[0], sx[1], 0.1], [sx[2], sx[3], 0.1], [sx[4], sx[5], 0.1], sill, chine, be, [0, keel, 0]],
];

/**
 * Corvane Wren, 32 m courier you can live in. The body is one sectioned loft drawn round the rooms of
 * data/interiors.ts (a 7.2 x 3.5 m pressure hull from the lounge to engineering, the cockpit under a raked
 * glass canopy at the nose); white armour plates stand proud of the gunmetal body; the two drive pods sit at
 * the wing roots with a machinery valley between pod and hull; swept wings, twin canted fins. The window
 * glass is the loft itself at the interior windows (canopy, lounge window, skylight, cabin portholes), each
 * with a framed reveal back to the room face so the views out work.
 */
function buildWren(k: Kit): void {
  const { b, L, hero } = k;
  const NC = 11;
  const K = symSectionCount(NC, k.segs);
  const half = k.segs >> 1;
  const u = (kk: number, f: number, port = false): number => k.fu(NC, kk, f, port);
  /** u of corner kk itself (the middle of its fillet; exact for the straight window band) */
  const um = (kk: number, port = false, di = 0): number => k.fu(NC, kk, -half + di, port);
  const engCol: RGB = [0.62, 0.8, 1];
  const serial = `CW32-${String(715 + k.variant * 113).padStart(4, '0')}`;
  const CZ0 = -16.05;
  const CZ1 = -12.7;

  // ---- body: nose and canopy, the flare behind the cockpit, the long pressure hull, the stern
  const mid = (z: number): readonly [number, Sec] => wst(z, 1.78, 0.78, [3.1, 1.76, 0.15], [3.6, 1.2, 0.1], [3.6, 0.92, 3.6, 0.45, 3.6, -0.05], [3.6, -0.22, 0.1], [4.3, -0.86, 0.05], [2.9, -1.72, 0.35], -1.72);
  const stations = [
    wst(-16.45, -0.74, 0.03, [0.06, -0.745, 0], [0.08, -0.75, 0], [0.09, -0.755, 0.095, -0.76, 0.1, -0.765], [0.105, -0.77, 0], [0.14, -0.8, 0.01], [0.09, -0.86, 0.02], -0.88),
    wst(-16.3, -0.6, 0.35, [0.55, -0.605, 0.05], [0.64, -0.61, 0.02], [0.66, -0.615, 0.67, -0.62, 0.68, -0.625], [0.7, -0.63, 0.02], [1.1, -0.75, 0.03], [0.65, -1.05, 0.15], -1.1),
    wst(CZ0, -0.44, 0.6, [1.0, -0.445, 0.05], [1.12, -0.45, 0.03], [1.16, -0.452, 1.19, -0.455, 1.22, -0.458], [1.25, -0.46, 0.03], [1.8, -0.7, 0.04], [1.1, -1.35, 0.25], -1.45),
    wst(-15.75, 0.42, 0.7, [1.45, 0.3, 0.3], [1.72, 0.05, 0.1], [1.75, -0.08, 1.77, -0.2, 1.78, -0.31], [1.8, -0.44, 0.06], [2.45, -0.72, 0.05], [1.5, -1.55, 0.3], -1.62),
    wst(-15.35, 1.47, 0.75, [1.62, 1.38, 0.45], [2.02, 0.82, 0.12], [2.04, 0.5, 2.06, 0.15, 2.07, -0.15], [2.09, -0.43, 0.08], [2.85, -0.74, 0.05], [1.8, -1.68, 0.35], -1.71),
    wst(-14.6, 1.93, 0.78, [1.62, 1.88, 0.5], [2.1, 1.22, 0.12], [2.12, 0.92, 2.12, 0.45, 2.13, -0.05], [2.14, -0.42, 0.08], [3.2, -0.76, 0.05], [2.0, -1.72, 0.35], -1.72),
    wst(-13.6, 2.02, 0.78, [1.62, 1.96, 0.5], [2.12, 1.22, 0.12], [2.13, 0.92, 2.13, 0.45, 2.14, -0.05], [2.16, -0.42, 0.08], [3.5, -0.78, 0.05], [2.15, -1.72, 0.35], -1.72),
    wst(CZ1, 2.03, 0.78, [1.66, 1.97, 0.5], [2.15, 1.24, 0.12], [2.16, 0.92, 2.16, 0.45, 2.17, -0.05], [2.2, -0.42, 0.08], [3.75, -0.8, 0.05], [2.3, -1.72, 0.35], -1.72),
    wst(-12.2, 2.0, 0.78, [2.15, 1.9, 0.4], [2.4, 1.3, 0.12], [2.45, 0.92, 2.46, 0.45, 2.47, -0.05], [2.5, -0.3, 0.08], [3.9, -0.82, 0.05], [2.45, -1.72, 0.35], -1.72),
    wst(-11.4, 1.9, 0.78, [2.65, 1.85, 0.35], [3.15, 1.25, 0.12], [3.2, 0.92, 3.2, 0.45, 3.21, -0.05], [3.22, -0.24, 0.1], [4.1, -0.84, 0.05], [2.7, -1.72, 0.35], -1.72),
    mid(-10.65),
    mid(3.2),
    // the engine deck rises behind the docking collar: a wedge in profile, machinery under the raised roof
    wst(6.2, 2.4, 0.78, [2.95, 2.36, 0.2], [3.6, 1.45, 0.1], [3.6, 0.92, 3.6, 0.45, 3.6, -0.05], [3.6, -0.22, 0.1], [4.3, -0.86, 0.05], [2.9, -1.72, 0.35], -1.72),
    wst(10.2, 2.42, 0.78, [2.95, 2.38, 0.2], [3.6, 1.45, 0.1], [3.6, 0.92, 3.6, 0.45, 3.6, -0.05], [3.6, -0.22, 0.1], [4.3, -0.86, 0.05], [2.9, -1.72, 0.35], -1.72),
    wst(12.6, 2.3, 0.78, [2.9, 2.25, 0.2], [3.5, 1.4, 0.1], [3.5, 0.92, 3.5, 0.45, 3.5, -0.05], [3.5, -0.25, 0.1], [4.1, -0.86, 0.05], [2.8, -1.7, 0.35], -1.7),
    wst(14.1, 1.9, 0.7, [2.6, 1.85, 0.15], [3.1, 1.15, 0.1], [3.15, 0.8, 3.15, 0.4, 3.15, -0.05], [3.15, -0.3, 0.1], [3.6, -0.85, 0.05], [2.5, -1.55, 0.3], -1.55),
  ];
  const inZ = (z: number, z0: number, z1: number): boolean => z > z0 && z < z1;
  const body = k.loft(stations, {
    n: 92,
    extra: [-9.4, -5.6, -8.7, -6.3, -3.85, -2.95, -15.3, -12.6, -10.75, 6.8, 10.3, -14.3],
    capStart: WR.whiteA,
    capEnd: WR.mach,
    paint: (q) => {
      const z = q.z;
      if (q.c < 7 && inZ(z, CZ0, CZ1)) return ST.glass; // canopy: everything above the sill
      if (q.c < 1 && inZ(z, -8.7, -6.3)) return ST.glass; // lounge skylight
      if (q.c > 3.5 && q.c < 7.5 && q.y > -0.05 && q.y < 0.45 && inZ(z, -3.85, -2.95)) return ST.glass; // cabin portholes
      if (q.side > 0 && q.c > 3.5 && q.c < 7.5 && q.y > -0.21 && q.y < 0.91 && inZ(z, -9.4, -5.6)) return ST.glass; // lounge window
      return q.c >= 9 ? WR.comp : WR.gun;
    },
  });
  /** armour / trim plate on the body between two u positions (either order), both sides unless `side` given */
  const plate = (ua: (port: boolean) => number, ub: (port: boolean) => number, z0: number, z1: number, style: Style = WR.white, lift = 0.085, side = 0, bevel = 0.045): void => {
    for (const port of [false, true]) {
      if ((side > 0 && port) || (side < 0 && !port)) continue;
      k.armour(body, K, ua(port), ub(port), z0, z1, style, lift, bevel);
    }
  };
  const at = (kk: number, f: number) => (port: boolean): number => u(kk, f, port);
  const atC = (kk: number, di = 0) => (port: boolean): number => um(kk, port, di);

  // ---- white armour: nose, canopy cowl, upper deck, the window band forward of the pods
  plate(at(7, 0.1), at(7, 0.9), -16.32, -14.25, WR.whiteA);
  plate(at(7, 0.1), at(7, 0.9), -14.15, -12.75, WR.whiteA);
  plate(at(8, 0.06), at(8, 0.55), -16.25, -13.2, WR.whiteA);
  plate(at(0, 0.04), atC(3, -1), -12.56, -10.8, WR.whiteA, 0.1);
  plate(atC(3, 1), atC(7), -12.56, -10.8, WR.whiteA, 0.1);
  for (const [z0, z1] of [[-10.6, -8.05], [-7.95, -4.75], [-4.65, -1.2], [3.1, 5.0], [5.1, 7.6], [7.7, 9.6]]) plate(at(1, 0.06), atC(3, -1), z0, z1);
  // the waist over the washroom and suit room: bare gunmetal deck with service hardware round the collar
  if (hero) {
    b.mirror(() => {
      b.at(2.0, 1.78, 0.1, () => b.greebles(1.9, 2.3, { styles: [WR.mach, WR.gun, WR.bright, WR.red], cell: 0.24, height: 0.14, density: 0.62, pipes: 3, pipeStyle: WR.bright }));
      b.at(1.0, 1.8, 0.1, () => b.box(0.08, 0.06, 2.3, WR.red, { bevel: 0.015 }));
    });
  }
  // exposed radiators on the aft deck shoulders between the fins and the hull edge
  plate(at(1, 0.55), at(2, 0.5), 9.9, 13.6, ST.rad, 0.05, 0, 0.03);
  const BAND_T = atC(3, 1);
  for (const side of [1, -1]) {
    const full = side > 0 ? [[-10.6, -9.62], [-5.38, -4.1], [-2.7, -1.3]] : [[-10.6, -7.6], [-7.5, -4.1], [-2.7, -1.3]];
    for (const [z0, z1] of full) plate(BAND_T, atC(5), z0, z1, WR.white, 0.085, side);
    if (side > 0) plate(BAND_T, atC(4), -9.52, -5.48, WR.white, 0.085, side);
    plate(BAND_T, atC(5), -4.0, -2.8, WR.white, 0.085, side);
  }
  // lower shelf (sill to chine): the white arrowhead outline seen from above
  for (const [z0, z1] of [[-12.6, -10.8], [-10.7, -6.2], [-6.1, -1.3], [-1.2, 1.2]]) plate(at(7, 0.1), at(7, 0.86), z0, z1);
  // raised gunmetal dorsal ridge along the spine
  for (const [z0, z1] of [[-10.45, -8.95], [-6.05, 1.2], [3.2, 10.6]]) plate(at(0, 0.03), at(0, 0.84), z0, z1, WR.mach, 0.14, 0, 0.06);
  // ---- canopy frame: windscreen foot, front hoop, rear hoop, sill rails, roof rails
  const FR = WR.frame;
  plate(at(0, 0.02), atC(7, 2), -16.12, -15.93, FR, 0.06, 0, 0.03);
  plate(at(0, 0.02), atC(7, 2), -15.4, -15.27, FR, 0.06, 0, 0.03);
  plate(at(0, 0.02), atC(7, 2), -12.86, -12.6, FR, 0.07, 0, 0.03);
  plate(atC(7, -2), atC(7, 2), -16.0, -12.75, FR, 0.06, 0, 0.025);
  plate(atC(2, -1), atC(2, 1), -15.3, -12.75, FR, 0.05, 0, 0.025);
  // ---- window frames (lounge window, portholes, skylight)
  // (frames sit just outside each opening: their sunk inner edges meet the window edge)
  plate(atC(4, -2), atC(4), -9.56, -5.44, FR, 0.05, 1, 0.02);
  plate(atC(7), atC(7, 2), -9.56, -5.44, FR, 0.05, 1, 0.02);
  plate(atC(4), atC(7), -9.56, -9.4, FR, 0.05, 1, 0.02);
  plate(atC(4), atC(7), -5.6, -5.44, FR, 0.05, 1, 0.02);
  plate(atC(5, -2), atC(5), -4.0, -2.8, FR, 0.06, 0, 0.02);
  plate(atC(6), atC(6, 2), -4.0, -2.8, FR, 0.06, 0, 0.02);
  plate(atC(5), atC(6), -4.0, -3.85, FR, 0.06, 0, 0.02);
  plate(atC(5), atC(6), -2.95, -2.8, FR, 0.06, 0, 0.02);
  plate(at(0, 0.02), atC(1, 1), -8.86, -8.7, FR, 0.05, 0, 0.02);
  plate(at(0, 0.02), atC(1, 1), -6.3, -6.14, FR, 0.05, 0, 0.02);
  plate(atC(1, -1), atC(1, 1), -8.82, -6.18, FR, 0.05, 0, 0.02);
  // ---- cyan edge light: along the chine, along the spine edges
  const CY = lamp(CYAN, 2.4);
  plate(at(7, 0.9), at(7, 0.97), -15.9, 1.5, CY, 0.02, 0, 0.005);
  for (const [z0, z1] of [[-10.5, -8.95], [-6.05, 1.15], [3.3, 9.15]]) plate(at(0, 0.9), at(0, 0.97), z0, z1, CY, 0.02, 0, 0.005);
  // ---- belly: ventral cargo ramp, nose and main gear doors
  plate(at(9, 0.46), at(9, 1), 6.85, 10.25, WR.gun, 0.025, 0, 0.02);
  plate(at(9, 0.8), at(9, 1), -14.3, -12.65, WR.gun, 0.02, 0, 0.015);
  plate(at(9, 0.08), at(9, 0.42), 3.4, 6.2, WR.gun, 0.02, 0, 0.015);
  plate(at(9, 0.08), at(9, 0.42), -8.2, -6.8, WR.gun, 0.02, 0, 0.015);

  // ---- markings on the body
  if (hero) {
    for (const port of [false, true]) {
      const rs = port ? 3 : 1;
      k.textLift(body, u(7, 0.45, port), -11.3, 'WREN', 0.3, DC.white, rs, 0.02);
      k.textLift(body, u(5, 0.5, port), -11.7, serial, 0.2, DC.dark, rs, 0.11);
      b.decalOn(body, u(4, 0.5, port), -1.9, 0.9, 0.16, decalIconRect('stripeBroken'), DC.accent, rs, 3, 0.1);
      b.decalOn(body, u(8, 0.3, port), -14.6, 0.34, 0.34, decalIconRect('rescue'), DC.red, rs, 2, 0.1);
      b.decalOn(body, u(2, 0.5, port), 0.2, 0.8, 0.2, decalIconRect('noStep'), DC.dark, rs, 2, 0.1);
      b.decalOn(body, u(2, 0.4, port), 7.8, 0.6, 0.16, decalIconRect('dashes'), DC.dark, rs, 2, 0.1);
      // ramp and gear-door hazard edges
      b.decalOn(body, u(9, 0.47, port), 8.55, 3.3, 0.12, decalIconRect('hazard'), DC.yellow, 1, 4, 0.04);
      b.decalOn(body, u(9, 0.72, port), 6.9, 1.2, 0.12, decalIconRect('hazard'), DC.yellow, 0, 3, 0.04);
      b.decalOn(body, u(9, 0.72, port), 10.2, 1.2, 0.12, decalIconRect('hazard'), DC.yellow, 0, 3, 0.04);
      b.decalOn(body, u(9, 0.25, port), 4.8, 0.5, 0.5, decalIconRect('warnTri'), DC.yellow, 0, 2, 0.035);
      b.decalOn(body, u(9, 0.2, port), 1.8, 1.4, 0.8, decalIconRect('scuff'), DC.scuff, 0, 2, 0.02);
      b.decalOn(body, u(8, 0.5, port), 4.0, 2.2, 0.5, decalIconRect('soot'), DC.soot, rs, 3, 0.02);
    }
    k.textLift(body, u(9, 0.8), -2.0, 'CORVANE', 0.5, DC.white, 1, 0.02);
    b.decalOn(body, u(0, 0.5), 4.2, 0.4, 0.4, decalIconRect('arrow'), DC.yellow, 0, 2, 0.02);
    b.decalOn(body, u(0, 0.5), 0.2, 0.4, 0.4, decalIconRect('arrow'), DC.yellow, 2, 2, 0.02);
  }

  // ---- window reveals: framed tunnels from the room faces to the skin (views out from inside stay closed)
  const RV = ST.dark;
  b.at(3.41, 0.935, -7.5, () => b.box(0.38, 0.03, 3.86, RV));
  b.at(3.41, -0.215, -7.5, () => b.box(0.38, 0.03, 3.86, RV));
  for (const z of [-9.415, -5.585]) b.at(3.41, 0.36, z, () => b.box(0.38, 1.18, 0.03, RV));
  b.mirror(() => {
    b.at(3.41, 0.465, -3.4, () => b.box(0.38, 0.03, 0.96, RV));
    b.at(3.41, -0.065, -3.4, () => b.box(0.38, 0.03, 0.96, RV));
    for (const z of [-3.865, -2.935]) b.at(3.41, 0.2, z, () => b.box(0.38, 0.56, 0.03, RV));
    b.at(0.715, 1.585, -7.5, () => b.box(0.03, 0.34, 2.43, RV));
    // cockpit: sill ledge under the side glass, the overhead window's surround
    b.at(1.89, -0.445, -13.82, () => b.box(0.36, 0.03, 2.36, RV));
    b.at(1.015, 1.64, -13.6, () => b.box(0.03, 0.46, 1.66, RV));
  });
  for (const z of [-8.715, -6.285]) b.at(0, 1.585, z, () => b.box(1.46, 0.34, 0.03, RV));
  for (const z of [-14.415, -12.785]) b.at(0, 1.64, z, () => b.box(2.06, 0.46, 0.03, RV));
  b.at(0, -0.445, -15.42, () => b.box(3.3, 0.03, 0.8, RV));
  b.at(0, -1.19, -13.3, () => b.box(3.4, 0.04, 3.4, RV));

  // ---- what shows through the glass from outside: console, seats, bulkhead, the lounge (inside the room solids)
  if (hero) {
    b.at(0, -0.52, -14.575, () => b.box(3.3, 0.9, 0.76, WR.seat, { bevel: 0.04 }));
    for (const x of [-0.85, 0, 0.85]) b.at(x, -0.065, -14.6, () => b.box(0.62, 0.01, 0.4, lamp(CYAN, 1.6)));
    b.mirror(() => {
      b.at(0.55, -0.62, -13.42, () => b.box(0.54, 0.24, 0.6, WR.seat, { bevel: 0.05 }));
      b.at(0.55, -0.48, -13.42, () => b.box(0.4, 0.04, 0.46, WR.amber, { bevel: 0.015 }));
      b.at(0.55, -0.32, -13.16, () => b.box(0.54, 0.76, 0.08, WR.seat, { bevel: 0.03 }));
      b.at(1.1, 0.2, -11.63, () => b.box(1.16, 2.36, 0.04, WR.frame));
    });
    b.at(2.47, -0.79, -7.5, () => b.box(1.38, 0.38, 4.3, WR.leather, { bevel: 0.08 }));
    b.at(2.97, -0.58, -7.5, () => b.box(0.4, 0.8, 4.3, WR.leather, { bevel: 0.08 }));
    b.at(0, 1.25, -11.63, () => b.box(1.04, 0.26, 0.04, WR.frame));
    b.at(1.0, -0.68, -7.5, () => b.box(0.84, 0.6, 1.72, WR.veneer, { bevel: 0.03 }));
    b.at(-2.885, 1.0, -7.75, () => b.box(0.02, 0.7, 4.1, lamp(WARM, 1.2, true)));
    b.at(-2.86, -0.55, -7.75, () => b.box(0.6, 0.84, 4.2, WR.gun, { bevel: 0.02 }));
  }

  // ---- forward cheeks: RCS housings and the nose gear bay, the wing roots seen from the cockpit
  b.mirror(() => {
    k.tube(
      [
        [-14.8, 0.1, 0.08, -0.5, 2.4],
        [-13.6, 0.5, 0.3, -0.25, 3.05],
        [-12.5, 0.76, 0.48, 0.02, 3.15],
        [-11.3, 0.76, 0.48, 0.02, 3.15],
        [-10.7, 0.62, 0.4, -0.05, 3.3],
      ],
      { n: 10, K: 24, p: 4, capEnd: WR.mach, paint: (q) => (q.ny > 0.35 ? WR.whiteA : q.z > -10.95 ? WR.mach : WR.gun) },
    );
    if (hero) {
      b.at(3.85, -0.35, -11.2, () => b.box(0.06, 0.32, 0.7, heatGlow));
      b.at(3.2, 0.66, -11.8, () => k.icon('warnTri', 0.24, 0.24, DC.red));
    }
  });

  // ---- drive pods at the wing roots
  const podX = L.engines[0].pos.x;
  const podY = L.engines[0].pos.y;
  for (const s of [1, -1]) {
    const px = s * podX;
    const uo = s > 0 ? 0.25 : 0.75;
    const white = (uu: number): boolean => (s > 0 ? uu < 0.36 || uu > 0.86 : uu > 0.64 || uu < 0.14);
    const pod = k.tube(
      [
        [0.5, 0.22, 0.22, podY + 0.05, px],
        [1.3, 0.78, 0.74, podY + 0.02, px],
        [2.6, 1.15, 1.13, podY, px],
        [3.9, 1.28, 1.28, podY, px],
        [12.8, 1.28, 1.28, podY, px],
        [14.5, 1.25, 1.25, podY, px],
        [15.3, 1.2, 1.2, podY, px],
      ],
      {
        n: 30,
        K: 32,
        extra: [2.6, 2.72, 7.2, 7.32, 12.9, 13.0],
        paint: (q) => {
          if ((q.z > 2.6 && q.z < 2.72) || (q.z > 7.2 && q.z < 7.32) || (q.z > 12.9 && q.z < 13.0)) return WR.mach;
          if (q.z < 2.6) return q.z < 0.8 ? WR.mach : WR.whiteA;
          if (q.z < 7.2 && white(q.c)) return WR.white;
          return q.z > 13.0 ? WR.mach : WR.gun;
        },
      },
    );
    b.at(px, podY, 15.3, () => b.ring(1.11, 1.3, 0.1, WR.mach, { segs: 32, bevel: 0.02 }));
    b.plateOn(pod, uo - 0.06, uo + 0.06, 8.0, 12.5, { lift: 0.05, style: ST.rad, nu: 3, nv: 6, bevel: 0.03 });
    b.plateOn(pod, uo + s * 0.075, uo + s * 0.085, 3.1, 7.1, { lift: 0.012, style: lamp(CYAN, 2.4), nu: 1, nv: 3, bevel: 0.004 });
    if (hero) {
      const rot = s > 0 ? 1 : 3;
      k.textLift(pod, uo - s * 0.02, 5.0, 'CORVANE', 0.36, DC.dark, rot, 0.012);
      b.decalOn(pod, uo + s * 0.05, 6.3, 1.4, 0.14, decalIconRect('stripeBroken'), DC.accent, rot, 4);
      b.decalOn(pod, uo, 14.4, 1.6, 0.8, decalIconRect('soot'), DC.soot, rot, 3);
      b.decalOn(pod, uo + s * 0.12, 10.2, 0.32, 0.32, decalIconRect('warnTri'), DC.red, rot, 2);
      b.decalOn(pod, 0.5, 9.0, 1.8, 0.9, decalIconRect('scuff'), DC.scuff, 0, 2);
    }
    k.engine(s > 0 ? 0 : 1, 2.2, engCol, 4);
  }

  // ---- machinery valleys between hull and pods, wings, fins (mirrored)
  b.mirror(() => {
    b.at(4.15, 0.97, 7.95, () => b.box(1.2, 0.1, 10.7, WR.mach, { bevel: 0.02 }));
    // propellant tank with red bands and saddles
    b.at(4.2, 1.38, 4.3, () => b.capsule(0.34, 2.3, WR.gun, 18));
    for (const z of [3.5, 5.1]) {
      b.at(4.2, 1.38, z, () => b.cyl(0.36, 0.36, 0.09, WR.red, { segs: 18, capA: false, capB: false }));
      b.at(4.2, 1.06, z + 0.045, () => b.box(0.62, 0.12, 0.16, WR.mach, { bevel: 0.02 }));
    }
    // radiator bank
    for (let i = 0; i < 14; i++) b.at(4.15, 1.27, 6.45 + i * 0.31, () => b.box(1.0, 0.48, 0.035, ST.rad));
    for (const x of [3.66, 4.64]) b.at(x, 1.28, 8.47, () => b.box(0.05, 0.52, 4.2, WR.mach));
    // feed lines into the pod, actuators at the stern
    b.pipe([3.74, 1.07, 2.7, 3.74, 1.07, 11.6, 3.95, 0.98, 12.6, 4.3, 0.9, 13.3], 0.055, WR.bright, { smoothPath: true, sides: 8 });
    b.pipe([4.62, 1.12, 3.0, 4.62, 1.12, 12.0, 4.7, 1.0, 13.0], 0.045, WR.mach, { smoothPath: true, sides: 6 });
    b.pipe([3.9, 1.6, 5.4, 3.9, 1.6, 6.2, 3.85, 1.3, 6.5], 0.035, WR.red, { smoothPath: true, sides: 6 });
    if (hero) {
      for (const z of [11.2, 12.1]) {
        b.strut(4.0, 1.0, z, 4.55, 1.2, z + 0.55, 0.06, WR.bright, 6);
        b.at(4.0, 1.08, z, () => b.box(0.22, 0.16, 0.3, WR.red, { bevel: 0.02 }));
      }
      b.at(4.15, 1.05, 12.9, () => b.box(0.9, 0.06, 0.5, heatGlow));
      b.at(4.15, 1.03, 2.75, () => b.greebles(1.1, 0.4, { styles: [WR.mach, WR.gun, WR.bright], cell: 0.18, height: 0.12, density: 0.8 }), 0, Math.PI / 2);
      b.at(4.35, 1.73, 4.3, () => k.icon('warnTri', 0.26, 0.26, DC.red));
    }

    // exposed machinery bay on the hull side ahead of the pods (washroom / suit room)
    k.face(3.6, 0.35, 0.12, 'px', () => {
      b.box(2.7, 0.04, 1.14, WR.mach);
      if (hero) b.greebles(2.5, 0.98, { styles: [WR.mach, WR.gun, WR.bright, WR.red], cell: 0.22, height: 0.16, density: 0.75, pipes: 4, pipeStyle: WR.bright });
      else b.at(0, 0.06, 0, () => b.box(2.4, 0.12, 0.9, WR.gun));
    });

    // wing: gunmetal spar box, white armour skin standing on it, wing-tip pod, cyan leading-edge line
    const wy = -0.42;
    b.at(0, wy, 0, () => b.plate([4.8, 2.6, 9.25, 4.8, 9.25, 8.7, 4.8, 13.4], 0.36, { style: WR.gun, edgeStyle: WR.mach, bevel: 0.12 }));
    b.at(0, wy + 0.2, 0, () => b.plate([6.15, 3.95, 8.95, 5.35, 8.95, 8.25, 6.15, 11.6], 0.07, { style: WR.white, edgeStyle: WR.white, bevel: 0.025 }));
    b.at(0, wy - 0.2, 0, () => b.plate([6.3, 4.6, 8.9, 5.9, 8.9, 8.1, 6.3, 10.9], 0.05, { style: WR.comp, bevel: 0.02 }));
    b.at(0, wy + 0.2, 0, () => b.plate([6.1, 11.8, 8.95, 8.45, 8.95, 8.62, 6.1, 12.2], 0.06, { style: WR.red, bevel: 0.015 }));
    b.between(6.2, wy + 0.245, 3.99, 8.9, wy + 0.245, 5.34, (len) => b.at(0, 0, len / 2, () => b.box(0.035, 0.012, len, lamp(CYAN, 2.4))));
    b.at(9.3, wy, 4.4, () => b.cyl(0.22, 0.2, 4.6, WR.gun, { segs: 12, bevel: 0.06 }));
    b.at(9.3, wy, 4.25, () => b.cyl(0.08, 0.22, 0.16, WR.whiteA, { segs: 12, capA: false }));
    if (hero) {
      b.at(7.4, wy + 0.236, 9.2, () => k.icon('noStep', 0.8, 0.2, DC.dark));
      b.at(7.6, wy + 0.236, 7.0, () => k.icon('scuff', 1.6, 0.8, DC.scuff));
      b.at(6.0, wy + 0.19, 12.0, () => k.icon('soot', 1.2, 0.6, DC.soot));
    }

    // twin canted fins: white armour, gunmetal edges, red tip caps, the logo on the outer face
    const cant = 0.3;
    // (the fin roots stand clear of the cargo-bay and engineering overheads; the strobes sit on the tips)
    const fx = 2.7;
    const fy = 2.28;
    k.fin(fx, fy, [0, 8.5, 0, 13.0, -0.3, 13.95, 2.2, 14.85, 2.2, 13.55], 0.26, cant, WR.white, WR.mach);
    k.fin(fx, fy, [1.82, 13.32, 1.82, 14.7, 2.25, 14.88, 2.25, 13.56], 0.29, cant, WR.red, WR.red);
    k.fin(fx, fy, [-0.1, 8.35, -0.1, 13.0, -0.4, 14.05, 0.3, 14.05, 0.3, 8.6], 0.34, cant, WR.mach, WR.mach);
    if (hero) {
      const hh = 1.25;
      b.at(fx + hh * Math.sin(cant) + 0.131 * Math.cos(cant), fy + hh * Math.cos(cant) - 0.131 * Math.sin(cant), 12.9, () => b.with(FACE.px, () => k.icon('logoCorvane', 0.9, 0.9, DC.accent)), 0, 0, -cant);
    }
  });

  // ---- stern between the pods: machinery wall, heat vents, auxiliary bells, tail light bar
  b.at(0, 0.0, 14.1, () => b.greebles(5.2, 2.4, { styles: [WR.mach, WR.gun, ST.dark, WR.bright], cell: 0.3, height: 0.24, density: hero ? 0.72 : 0.4, pipes: hero ? 6 : 2, pipeStyle: WR.bright }), Math.PI / 2);
  b.mirror(() => {
    b.at(1.55, -0.95, 14.16, () => b.box(1.3, 0.36, 0.1, WR.mach, { bevel: 0.02 }));
    b.at(1.55, -0.95, 14.22, () => b.box(1.14, 0.24, 0.02, heatGlow));
    b.at(0.7, 0.85, 14.2, () => {
      b.nozzle({ throatR: 0.08, exitR: 0.2, length: 0.36, style: ST.hot, inner: engineGlow(engCol), segs: 12, wall: 0.015 });
      b.at(0, 0, -0.05, () => b.ring(0.12, 0.25, 0.08, WR.mach, { segs: 12, bevel: 0.015 }));
    });
  });
  b.at(0, 1.3, 14.14, () => b.box(2.6, 0.04, 0.05, lamp(WARM, 2.6, true)));

  // ---- dorsal: docking collar, sensor mast, antennas; ventral: sensor blister
  k.dockCollar(0.8);
  if (hero) {
    b.at(0, 2.52, 9.6, () => b.box(0.3, 0.12, 1.0, WR.mach, { bevel: 0.03 }));
    k.whip(0.12, 2.56, 9.3, 0.2, 3.5, 9.9, 0.018);
    k.whip(-0.12, 2.56, 9.8, -0.2, 3.2, 10.4, 0.015);
    b.at(0, -1.73, -9.6, () => b.sphere(0.26, WR.comp, 14, 0.45), Math.PI / 2);
    b.at(0, -1.74, 12.4, () => b.box(0.9, 0.1, 1.4, WR.mach, { bevel: 0.03 }));
  }
  k.hardpoints(() => [0, 1, 0], 0.3);
  k.rcsBlocks(0.9);
  k.navLights(1.2);
}

/** Corvane Shrike: long nose, forward-swept wings on chine strakes, twin canted fins, two close-set drives. 15 m. */
function buildShrike(k: Kit): void {
  const { b, hero } = k;
  const NC = 5;
  const engCol: RGB = [0.55, 0.76, 1];
  const reg = `CS-${417 + k.variant * 53}`;

  // ---- fuselage: corners = top centre, shoulder, chine, belly edge, keel
  const body = k.loft(
    [
      [-7.5, [[0, 0.02, 0.01], [0.03, 0.01, 0.01], [0.06, -0.02, 0.01], [0.04, -0.05, 0.01], [0, -0.06, 0.01]]],
      [-6.6, [[0, 0.17, 0.06], [0.16, 0.13, 0.06], [0.3, -0.02, 0.03], [0.2, -0.14, 0.06], [0, -0.17, 0.06]]],
      [-4.5, [[0, 0.42, 0.15], [0.36, 0.33, 0.15], [0.62, -0.02, 0.04], [0.42, -0.3, 0.12], [0, -0.36, 0.15]]],
      [-2.6, [[0, 0.6, 0.2], [0.5, 0.48, 0.2], [0.95, 0.0, 0.05], [0.62, -0.42, 0.15], [0, -0.5, 0.2]]],
      [-0.5, [[0, 0.78, 0.25], [0.72, 0.64, 0.25], [1.5, 0.02, 0.06], [1.0, -0.52, 0.2], [0, -0.6, 0.2]]],
      [2.0, [[0, 0.82, 0.25], [0.95, 0.7, 0.25], [1.72, 0.02, 0.06], [1.35, -0.55, 0.2], [0, -0.62, 0.2]]],
      [4.8, [[0, 0.78, 0.25], [1.15, 0.68, 0.25], [1.7, 0.02, 0.08], [1.4, -0.55, 0.2], [0, -0.6, 0.2]]],
      [6.3, [[0, 0.66, 0.2], [1.15, 0.58, 0.2], [1.58, 0.02, 0.1], [1.3, -0.48, 0.2], [0, -0.5, 0.2]]],
    ],
    {
      n: 30,
      extra: [-6.9, -5.2, 2.4, 4.2, 5.5],
      capStart: ST.carbon,
      capEnd: ST.dark,
      paint: (q) => {
        if (q.z < -6.9) return ST.carbon; // radome
        if (q.z > 5.5) return ST.steel; // engine bay
        if (q.c >= 2.5) return ST.S2;
        if (q.c === 2) return ST.metal; // chine
        if (q.c === 1) return q.z > -5.2 && q.z < 4.2 ? ST.A : ST.P;
        if (q.c === 1.5 && q.z > 2.4) return ST.P2;
        return ST.P;
      },
    },
  );

  k.canopy(0, 0.47, -2.9, 0.62, -0.1, 1.3);

  // ---- dorsal spine with the docking hump
  k.loft(
    [
      [-1.5, [[0, 0.9, 0.05], [0.26, 0.86, 0.08], [0.4, 0.58, 0], [0, 0.58, 0]]],
      [0.2, [[0, 1.0, 0.08], [0.5, 0.96, 0.1], [0.66, 0.66, 0], [0, 0.66, 0]]],
      [2.2, [[0, 1.0, 0.08], [0.5, 0.96, 0.1], [0.66, 0.68, 0], [0, 0.68, 0]]],
      [3.6, [[0, 0.94, 0.08], [0.24, 0.9, 0.1], [0.38, 0.66, 0], [0, 0.66, 0]]],
      [5.9, [[0, 0.72, 0.05], [0.14, 0.7, 0.06], [0.22, 0.5, 0], [0, 0.5, 0]]],
    ],
    { n: 10, capEnd: ST.dark, paint: (q) => (q.c >= 1.5 ? ST.P2 : ST.P), segs: 2 },
  );
  k.dockCollar(0.5);

  b.mirror(() => {
    // ---- forward-swept wing with a slight anhedral, leading-edge strake back along the nose
    b.at(
      0,
      -0.02,
      0,
      () => {
        b.plate([1.45, 0.6, 5.7, -2.0, 5.7, -0.9, 3.4, 2.6, 1.45, 5.7], 0.2, { style: ST.P, edgeStyle: ST.metal, bevel: 0.12, sharp: true });
        b.at(2.35, 0.1, 3.0, () => b.box(1.2, 0.035, 1.7, ST.rad, { bevel: 0.012 }));
        if (hero) {
          b.at(5.33, 0.1, -1.2, () => k.icon('solid', 0.46, 0.78, DC.accent));
          b.at(3.2, 0.1, 1.0, () => k.icon('chevrons', 1.3, 0.5, DC.accent), 0, 0.55);
          b.at(4.3, 0.1, -0.3, () => k.icon('noStep', 0.7, 0.34, DC.white), 0, 0.55);
          // flaperon hinge line and actuator fairings
          b.strut(2.0, 0.11, 4.75, 3.45, 0.11, 2.45, 0.03, ST.dark, 4);
          b.at(2.4, -0.13, 3.6, () => b.box(0.16, 0.12, 0.9, ST.steel, { bevel: 0.03 }));
          b.at(3.1, -0.13, 2.5, () => b.box(0.16, 0.12, 0.8, ST.steel, { bevel: 0.03 }));
        }
      },
      0,
      0,
      -0.06,
    );
    b.at(0, 0.0, 0, () => b.plate([0.45, -4.9, 1.78, -0.35, 1.62, 0.9, 1.0, 0.9], 0.09, { style: ST.P2, edgeStyle: ST.metal, bevel: 0.07, sharp: true }));
    // ---- canted fin
    b.at(
      1.05,
      0.6,
      0,
      () => {
        b.plate([0, 2.6, 2.5, 5.2, 2.5, 6.3, 0, 6.5], 0.14, { style: ST.P, edgeStyle: ST.metal, bevel: 0.08, sharp: true });
        if (hero) {
          b.at(2.18, 0.07, 5.62, () => k.icon('solid', 0.5, 0.95, DC.accent));
          b.at(2.18, -0.07, 5.62, () => k.icon('solid', 0.5, 0.95, DC.accent), Math.PI);
          b.at(1.1, -0.07, 5.0, () => k.icon('logoCorvane', 0.7, 0.7, DC.white), Math.PI, 0, Math.PI / 2);
          b.at(1.1, 0.07, 5.0, () => k.icon('logoCorvane', 0.7, 0.7, DC.white), 0, 0, -Math.PI / 2);
        }
      },
      0,
      0,
      Math.PI / 2 - 0.42,
    );
    // ---- shoulder intake: boxy duct with a dark mouth and a bare lip
    k.tube(
      [
        [-1.3, 0.24, 0.2, 0.33, 1.0],
        [-0.6, 0.34, 0.27, 0.36, 1.08],
        [1.6, 0.36, 0.3, 0.38, 1.2],
        [3.4, 0.3, 0.26, 0.4, 1.25],
        [4.7, 0.1, 0.1, 0.42, 1.2],
      ],
      { n: 8, K: 12, p: 4, extra: [-1.12], capStart: ST.pit, paint: (q) => (q.z < -1.12 ? ST.metal : ST.P2) },
    );
    // ---- nose cannon in a cheek fairing
    b.at(0.44, -0.2, -5.7, () => b.cyl(0.055, 0.055, 1.5, ST.dark, { segs: 8, capB: false }));
    b.at(0.47, -0.2, -3.9, () => b.with(new THREE.Matrix4().makeScale(0.2, 0.17, 0.95), () => b.sphere(1, ST.steel, 10)));
    // ---- afterburner petals fairing between hull and bell
    b.at(0.72, 0.02, 6.15, () => b.cyl(0.62, 0.5, 0.35, ST.dark, { segs: 14, capA: false, capB: false }));
  });
  k.engine(0, 1.25, engCol, 2);
  k.engine(1, 1.25, engCol, 2);

  // ---- markings and panels
  for (const port of [false, true]) {
    k.panel(body, NC, 1, 0.2, 0.85, -6.3, -5.4, port, ST.P2, 0.014, 2, 2);
    if (hero) {
      b.textOn(body, k.fu(NC, 1, 0.5, port), -4.0, reg, 0.24, DC.white, port ? 3 : 1);
      b.decalOn(body, k.fu(NC, 1, 0.55, port), -1.9, 0.8, 0.2, decalIconRect('rescue'), DC.yellow, port ? 3 : 1);
      b.decalOn(body, k.fu(NC, 0, 0.6, port), 3.9, 0.3, 0.3, decalIconRect('warnTri'), DC.red, port ? 3 : 1);
      k.panel(body, NC, 3, 0.15, 0.7, -1.2, 0.4, port, ST.steel, 0.012, 2, 2); // nose-gear / main-gear doors
      k.panel(body, NC, 3, 0.2, 0.8, 2.6, 4.4, port, ST.steel, 0.012, 2, 2);
    }
  }
  if (hero) {
    k.whip(0, 0.98, 3.2, 0.0, 1.5, 3.7, 0.015);
    b.at(0, -0.3, 6.32, () => b.greebles(1.9, 0.5, { styles: [ST.steel, ST.dark, ST.metal], cell: 0.22, height: 0.12, density: 0.7, pipes: 3, pipeStyle: ST.metal }), Math.PI / 2);
  }
  k.hardpoints(() => [0, 1, 0], 0.32);
  k.rcsBlocks(0.6);
  k.navLights(0.9);
}

/** Ilmarin Drover: forward crew module, long truss spine carrying six cargo cans, single big drive bell. 38 m. */
function buildDrover(k: Kit): void {
  const { b, hero } = k;
  const NC = 5;
  const engCol: RGB = [1, 0.78, 0.52];
  const reg = `IL-D${208 + k.variant * 41}`;
  const full: Sec = [[0, 2.2, 0.5], [1.9, 2.0, 0.6], [2.6, -0.2, 0.25], [1.9, -2.0, 0.6], [0, -2.2, 0.5]];

  // ---- crew module: corners = top centre, shoulder, waist, bilge, keel
  const cab = k.loft(
    [
      [-19.0, [[0, 1.0, 0.3], [1.2, 0.9, 0.3], [1.6, -0.2, 0.2], [1.2, -1.2, 0.4], [0, -1.35, 0.3]]],
      [-18.4, [[0, 2.0, 0.4], [1.75, 1.8, 0.5], [2.35, -0.2, 0.25], [1.7, -1.8, 0.5], [0, -2.0, 0.4]]],
      [-17.4, full],
      [-12.6, full],
      [-11.4, [[0, 1.5, 0.4], [1.3, 1.4, 0.4], [1.7, -0.2, 0.25], [1.3, -1.4, 0.4], [0, -1.5, 0.4]]],
    ],
    {
      n: 14,
      extra: [-18.9, -13.7, -13.1],
      capStart: ST.S,
      capEnd: ST.dark,
      paint: (q) => {
        if (q.z < -18.4 && q.z > -18.9 && q.c <= 1) return ST.pit; // behind the windscreen
        if (q.z > -12.6) return ST.steel;
        if (q.c === 2) return ST.metal;
        if (q.c >= 2.5) return ST.S;
        if (q.z > -13.7 && q.z < -13.1) return ST.A;
        if (q.c === 1) return ST.P2;
        return ST.P;
      },
    },
  );
  const uw = k.fu(NC, 1, 0);
  b.plateOn(cab, -uw, uw, -18.87, -18.43, { lift: 0.04, style: ST.glass, nu: 8, nv: 2, bevel: 0.03 });
  b.plateOn(cab, -uw * 0.75, uw * 0.75, -18.87, -18.8, { lift: 0.014, style: lamp(CYAN, 1.5), nu: 6, nv: 1, bevel: 0.01 });
  for (const port of [false, true]) {
    k.win(cab, NC, 1, 0.32, 0.47, -17.0, -14.1, port, 0.48, 3.6);
    k.panel(cab, NC, 0, 0.3, 0.92, -17.1, -15.3, port, ST.P2, 0.03, 2, 3);
    k.panel(cab, NC, 2, 0.2, 0.8, -16.6, -13.6, port, ST.S2, 0.03, 2, 4);
    if (hero) {
      b.textOn(cab, k.fu(NC, 1, 0.76, port), -15.6, reg, 0.46, DC.dark, port ? 3 : 1);
      b.decalOn(cab, k.fu(NC, 1, 0.76, port), -17.55, 0.9, 0.9, decalIconRect('logoIlmarin'), DC.secondary, port ? 3 : 1);
      b.decalOn(cab, k.fu(NC, 0, 0.62, port), -14.0, 0.34, 0.34, decalIconRect('warnTri'), DC.red, port ? 3 : 1);
    }
  }
  k.dockCollar(0.9);
  k.flood(0.95, -0.55, -19.08, 1.1, WHITE, 7);
  k.flood(-0.95, -0.55, -19.08, 1.1, WHITE, 7);
  b.at(0, -1.62, -17.9, () => b.sphere(0.36, ST.dark, 12));
  b.at(0, -0.55, -19.03, () => b.box(1.2, 0.34, 0.06, ST.dark, { bevel: 0.02 }));
  b.at(0, 0.35, -19.03, () => b.box(2.0, 0.5, 0.05, ST.S2, { bevel: 0.02 }));
  if (hero) {
    k.whip(0.95, 2.12, -16.6, 1.3, 3.9, -16.1, 0.022);
    b.strut(-1.0, 2.1, -16.5, -1.0, 2.55, -16.5, 0.07, ST.steel, 6);
    b.at(-1.0, 2.55, -16.5, () => b.dish(0.62, 0.18, ST.tankWhite, ST.steel, ST.steel), -0.45, 0, 0.2);
  }

  // ---- truss spine with the propellant line down its middle
  b.truss(0, 0, -11.4, 0, 0, 10.3, { width: 2.3, bays: 12, r: 0.07, chordR: 0.13, style: ST.steel, sides: 4 });
  b.at(0, 0, -11.4, () => b.cyl(0.42, 0.42, 21.7, ST.foilSilver, { segs: 12, capA: false, capB: false }));
  if (hero) {
    b.pipe([0.72, 0.72, -11.3, 0.72, 0.72, 10.2], 0.08, ST.metal, { sides: 6 });
    b.pipe([-0.72, -0.72, -11.3, -0.72, -0.72, 10.2], 0.06, ST.dark, { sides: 6 });
  }

  // ---- six cargo cans in three pairs
  const cans = [ST.ribRust, ST.ribBlue, ST.ribTan, ST.ribGrey, ST.ribGreen, ST.ribWhite];
  for (let i = 0; i < 3; i++) {
    for (const side of [1, -1]) {
      const z0 = -10.75 + i * 6.95;
      const st = cans[(i * 2 + (side > 0 ? 0 : 1) + k.variant * 5) % cans.length];
      b.at(side * 3.32, 0, z0, () => {
        const can = b.cyl(2.0, 2.0, 6.35, st, { segs: 24, bevel: 0.28, capStyle: ST.steel });
        b.at(0, 0, 0.3, () => b.ring(1.96, 2.1, 0.24, ST.steel, { segs: 24, bevel: 0.04 }));
        b.at(0, 0, 5.81, () => b.ring(1.96, 2.1, 0.24, ST.steel, { segs: 24, bevel: 0.04 }));
        if (hero) {
          b.at(0, 0, 3.1, () => b.ring(1.98, 2.07, 0.14, ST.dark, { segs: 24, bevel: 0.03 }));
          b.at(0, 0, -0.07, () => b.cyl(0.7, 0.7, 0.1, ST.dark, { segs: 12, bevel: 0.03 }));
          b.at(0, 0, 6.32, () => b.cyl(0.7, 0.7, 0.1, ST.dark, { segs: 12, bevel: 0.03 }));
          const u = side > 0 ? 0.25 : 0.75;
          const rot = side > 0 ? 1 : 3;
          b.textOn(can, u, 0.452, `${String.fromCharCode(65 + i)}${side > 0 ? 1 : 2}`, 0.95, DC.white, rot);
          b.decalOn(can, u, 0.56, 1.8, 0.5, decalIconRect('hazard'), DC.yellow, rot);
          b.decalOn(can, u + (side > 0 ? 0.075 : -0.075), 0.5, 2.2, 0.36, decalIconRect('dashes'), DC.white, rot);
        }
      });
      // clamps to the spine
      for (const dz of [1.2, 5.15]) b.at(side * 1.26, 0, z0 + dz, () => b.box(0.5, 1.6, 0.7, ST.dark, { bevel: 0.06 }));
    }
  }

  // ---- engineering section: tanks, radiator fins, thrust structure
  const eng = k.hullBox(
    [
      [10.3, 1.25, 1.25, -1.25, 0.3],
      [11.1, 1.75, 1.75, -1.75, 0.5],
      [14.7, 1.75, 1.75, -1.75, 0.5],
      [15.6, 1.25, 1.25, -1.25, 0.4],
    ],
    { n: 8, capStart: ST.dark, capEnd: ST.dark, paint: (q) => (q.z > 14.7 || q.z < 11.1 ? ST.steel : q.c === 1 || q.c === 2 ? ST.metal : ST.S) },
  );
  for (const port of [false, true]) {
    k.panel(eng, 4, 0, 0.25, 0.9, 11.5, 14.3, port, ST.P, 0.035, 2, 3);
    k.panel(eng, 4, 2, 0.1, 0.75, 11.5, 14.3, port, ST.S2, 0.035, 2, 3);
  }
  b.mirror(() => {
    b.at(2.78, 0, 12.6, () => {
      b.capsule(1.0, 2.2, ST.foil, 18);
      for (const dz of [-0.9, 0.78]) b.at(0, 0, dz, () => b.ring(0.97, 1.05, 0.12, ST.steel, { segs: 18, bevel: 0.03 }));
    });
    if (hero) b.pipe([1.7, 1.2, 14.9, 2.3, 1.1, 14.6, 2.78, 0.6, 14.3], 0.07, ST.metal, { sides: 6, smoothPath: true });
  });
  k.fin(0, 1.7, [0, 10.9, 3.9, 11.9, 3.9, 14.3, 0, 14.9], 0.1, 0, ST.rad, ST.metal, false, false);
  k.fin(0, -1.7, [0, 10.9, 3.9, 11.9, 3.9, 14.3, 0, 14.9], 0.1, 0, ST.rad, ST.metal, true, false);
  if (hero) {
    b.strut(0, 1.75, 10.6, 0, 5.2, 12.2, 0.05, ST.steel, 4);
    b.strut(0, -1.75, 10.6, 0, -5.2, 12.2, 0.05, ST.steel, 4);
    for (const port of [false, true]) b.decalOn(eng, k.fu(4, 0, 0.58, port), 12.9, 1.1, 1.1, decalIconRect('logoIlmarin'), DC.secondary, port ? 3 : 1);
  }
  k.engine(0, 2.6, engCol, 4);
  k.hardpoints(() => [0, 1, 0], 0.35);
  k.rcsBlocks(1.1);
  k.navLights(1.5);
}

/** Hadley-Okafor Magpie: stubby industrial hull, chin laser boom, side ore hoppers, grapple arms. 26 m. */
function buildMagpie(k: Kit): void {
  const { b, hero } = k;
  const NC = 5;
  const engCol: RGB = [1, 0.68, 0.4];
  const reg = `HO-M${31 + k.variant * 7}`;
  const full: Sec = [[0, 3.0, 0], [3.1, 3.0, 0.7], [3.7, -0.3, 0.3], [3.1, -3.0, 0.7], [0, -3.0, 0]];

  // ---- hull: corners = top centre, deck edge, chine, bilge, keel
  const body = k.loft(
    [
      [-7.0, [[0, 1.3, 0], [1.9, 1.3, 0.4], [2.4, -0.3, 0.3], [1.9, -2.0, 0.4], [0, -2.0, 0]]],
      [-6.0, [[0, 2.4, 0], [2.8, 2.4, 0.6], [3.4, -0.3, 0.3], [2.8, -2.8, 0.6], [0, -2.8, 0]]],
      [-4.6, full],
      [7.2, full],
      [8.6, [[0, 2.6, 0], [2.8, 2.6, 0.6], [3.3, -0.3, 0.3], [2.8, -2.6, 0.6], [0, -2.6, 0]]],
      [9.5, [[0, 1.9, 0], [2.2, 1.9, 0.5], [2.6, -0.3, 0.3], [2.2, -2.0, 0.5], [0, -2.0, 0]]],
    ],
    {
      n: 14,
      extra: [-5.2, 6.4],
      capStart: ST.steel,
      capEnd: ST.dark,
      paint: (q) => {
        if (q.z > 8.6) return ST.steel;
        if (q.c === 2) return ST.metal;
        if (q.c >= 2.5) return ST.S;
        if (q.z > 6.4 && q.z < 7.2) return ST.A;
        if (q.c === 1) return ST.P2;
        return ST.P;
      },
    },
  );

  // ---- bow: bumper frame, cooler grille, striped bumper bar
  b.at(0, -0.35, -7.06, () => {
    b.box(3.3, 2.5, 0.16, ST.dark, { bevel: 0.06 });
    b.at(0, 0.25, -0.09, () => b.box(2.6, 1.3, 0.05, ST.rad, { bevel: 0.02 }));
    b.at(0, -0.85, -0.12, () => b.box(3.6, 0.42, 0.3, ST.yellow, { bevel: 0.08 }));
  });
  if (hero) k.face(0, -1.2, -7.345, 'nz', () => k.icon('hazard', 3.0, 0.3, DC.dark));

  // ---- cab: glazed box on the forward deck
  const cab = k.hullBox(
    [
      [-6.45, 1.25, 3.0, 1.5, 0.15],
      [-6.0, 1.5, 4.2, 2.0, 0.3],
      [-3.9, 1.5, 4.2, 2.9, 0.3],
      [-3.3, 1.2, 3.6, 2.9, 0.2],
    ],
    { n: 5, capStart: ST.dark, capEnd: ST.white, paint: (q) => (q.z < -6.0 && q.c <= 1 ? ST.pit : q.c === 0.5 || q.c === 1 ? ST.white : ST.P) },
  );
  const uc = k.fu(4, 1, 0);
  b.plateOn(cab, -uc, uc, -6.43, -6.03, { lift: 0.04, style: ST.glass, nu: 6, nv: 2, bevel: 0.03 });
  b.plateOn(cab, -uc * 0.7, uc * 0.7, -6.42, -6.34, { lift: 0.014, style: lamp(AMBER, 1.6), nu: 4, nv: 1, bevel: 0.01 });
  for (const port of [false, true]) {
    const [u0, u1] = k.fr(4, 1, 0.06, 0.5, port);
    k.glazing(cab, u0, u1, -5.75, -4.25, 2, 3);
  }
  k.flood(1.0, 4.33, -5.9, 1.1);
  k.flood(-1.0, 4.33, -5.9, 1.1);
  b.at(0, 4.2, -4.3, () => {
    b.cyl(0.14, 0.11, 0.2, glowStyle(GLOW.blink, AMBER, 9, { period: 1.1, duty: 0.3, switched: true }), { segs: 8 });
    if (k.mounts) b.at(0, 0, 0.12, () => b.flare(flareStyle(AMBER, 7, 0.55, { period: 1.1, duty: 0.3, switched: true })));
  }, -Math.PI / 2);

  // ---- chin-mounted mining laser on a truss boom
  b.at(0, -2.35, -6.7, () => b.box(1.3, 0.9, 1.3, ST.steel, { bevel: 0.1 }));
  b.truss(0, -2.45, -7.2, 0, -2.85, -10.9, { width: 0.9, bays: 5, r: 0.045, chordR: 0.075, style: ST.yellow, sides: 3 });
  b.at(0, -2.85, -11.35, () => b.box(0.95, 0.85, 1.25, ST.dark, { bevel: 0.1 }));
  b.at(0, -2.85, -13.0, () => {
    b.cyl(0.2, 0.27, 1.2, ST.metal, { segs: 14, bevel: 0.03 });
    for (let i = 0; i < 4; i++) b.at(0, 0, 0.3 + i * 0.2, () => b.ring(0.24, 0.4, 0.07, ST.steel, { segs: 14, bevel: 0.02 }));
    b.at(0, 0, -0.01, () => b.cyl(0.15, 0.15, 0.02, lamp(REDL, 5, true), { segs: 10 }));
    if (k.mounts) b.at(0, 0, -0.06, () => b.flare(flareStyle(REDL, 3, 0.3, { switched: true })));
  });
  if (hero) b.pipe([0.3, -2.1, -6.9, 0.32, -2.2, -8.5, 0.3, -2.5, -10.6, 0.25, -2.6, -11.2], 0.06, ST.dark, { sides: 6, smoothPath: true });

  b.mirror(() => {
    // ---- ore hopper: ribbed bin flaring upward, rim frame, rubble, discharge chute
    b.at(4.85, -0.3, 1.5, () => b.box(1.9, 4.6, 9.4, [ST.ribS, ST.ribS, ST.steel, ST.pit, ST.ribS, ST.ribS], { bevel: 0.08, taperX: 1.42, shiftX: 0.4 }));
    b.at(5.25, 1.92, 1.5, () => b.box(2.3, 0.55, 8.8, ST.ore, { bevel: 0.2, taperX: 0.7, taperZ: 0.94 }));
    for (const x of [3.97, 6.55]) b.at(x, 2.08, 1.5, () => b.box(0.24, 0.32, 9.7, ST.yellow, { bevel: 0.05 }));
    for (const z of [-3.2, -0.07, 3.07, 6.2]) b.at(5.26, 2.08, z, () => b.box(2.8, 0.32, 0.24, ST.yellow, { bevel: 0.05 }));
    b.at(4.85, -2.85, 1.5, () => b.box(1.3, 0.6, 2.0, ST.steel, { bevel: 0.08, taperX: 0.7, taperZ: 0.7 }), Math.PI);
    for (const z of [-1.6, 1.5, 4.6]) b.strut(5.86, -2.5, z, 6.62, 1.95, z, 0.1, ST.steel, 4);
    // conveyor from the refinery drum
    b.pipe([1.1, 4.25, 1.7, 2.7, 4.5, 1.7, 4.5, 3.6, 1.7, 5.2, 2.35, 1.7], 0.2, ST.metal, { sides: 8, smoothPath: true });
    // ---- grapple arm: shoulder turret, two links with hydraulic rams, three-finger claw
    const sh = [2.45, 2.95, -5.55];
    const el = [4.0, 4.0, -8.9];
    const wr = [2.5, 1.3, -11.6];
    b.at(sh[0], sh[1] - 0.25, sh[2], () => b.cyl(0.55, 0.5, 0.55, ST.steel, { segs: 14, bevel: 0.06 }), -Math.PI / 2);
    const link = (p: number[], q: number[], w: number): void => {
      b.between(p[0], p[1], p[2], q[0], q[1], q[2], (len) => {
        b.at(0, 0, len / 2, () => b.box(w, w * 1.3, len, ST.yellow, { bevel: w * 0.14 }));
        b.strut(0, w * 1.0, len * 0.12, 0, w * 0.75, len * 0.72, 0.06, ST.metal, 6);
        b.at(0, w * 0.95, len * 0.12, () => b.box(0.2, 0.2, 0.3, ST.dark, { bevel: 0.03 }));
      });
      b.at(q[0], q[1], q[2], () => b.sphere(w * 0.95, ST.steel, 10));
    };
    b.at(sh[0], sh[1] + 0.35, sh[2], () => b.sphere(0.42, ST.steel, 10));
    link([sh[0], sh[1] + 0.35, sh[2]], el, 0.42);
    link(el, wr, 0.34);
    b.between(wr[0], wr[1], wr[2], wr[0] - 0.25, wr[1] - 0.35, wr[2] - 1.0, () => {
      b.cyl(0.26, 0.3, 0.3, ST.dark, { segs: 10, bevel: 0.03 });
      for (let f = 0; f < 3; f++) {
        const a = (f / 3) * TAU;
        const sx = Math.sin(a);
        const cy = Math.cos(a);
        b.strut(sx * 0.22, cy * 0.22, 0.25, sx * 0.5, cy * 0.5, 0.85, 0.09, ST.steel, 4, 0.075);
        b.strut(sx * 0.5, cy * 0.5, 0.85, sx * 0.12, cy * 0.12, 1.45, 0.075, ST.steel, 4, 0.03);
      }
    });
    // ---- landing skid
    b.at(2.0, -3.42, 1.0, () => b.box(0.5, 0.3, 9.0, ST.steel, { bevel: 0.08 }));
    for (const z of [-2.6, 1.0, 4.6]) b.strut(2.0, -2.9, z, 2.0, -3.35, z, 0.14, ST.dark, 6);
    // ---- exhaust stack and engine mount
    b.at(1.9, 2.9, 4.9, () => b.cyl(0.26, 0.3, 1.5, ST.steel, { segs: 10, capB: false }), -Math.PI / 2);
    b.at(1.75, -0.3, 9.4, () => b.cyl(1.25, 0.95, 0.75, ST.steel, { segs: 16, bevel: 0.05 }));
    if (hero) {
      for (let i = 0; i < 6; i++) k.face(6.675, 2.08, -2.4 + i * 1.55, 'px', () => k.icon('hazard', 0.9, 0.26, DC.dark));
      b.at(6.24, -0.3, 1.5, () => k.face(0.03, 0, 0, 'px', () => k.icon('logoHadley', 1.5, 1.5, DC.accent)), 0, 0, -0.172);
    }
  });

  // ---- refinery drum on the spine, deck radiators, mast
  b.at(0, 3.55, -0.4, () => {
    b.cyl(1.25, 1.25, 4.2, ST.foil, { segs: 20, bevel: 0.16, capStyle: ST.steel });
    for (const z of [0.7, 3.3]) b.at(0, 0, z, () => b.ring(1.22, 1.33, 0.2, ST.steel, { segs: 20, bevel: 0.03 }));
  });
  for (const port of [false, true]) {
    k.panel(body, NC, 0, 0.5, 0.96, 4.4, 7.0, port, ST.rad, 0.04, 2, 4);
    k.panel(body, NC, 1, 0.25, 0.8, -4.4, -3.5, port, ST.P2, 0.03, 2, 2);
    k.panel(body, NC, 2, 0.15, 0.7, 6.7, 8.2, port, ST.steel, 0.03, 2, 2);
    if (hero) {
      b.textOn(body, k.fu(NC, 1, 0.45, port), 7.75, reg, 0.5, DC.dark, port ? 3 : 1);
      b.decalOn(body, k.fu(NC, 1, 0.5, port), -5.3, 1.5, 0.5, decalIconRect('hazard'), DC.dark, port ? 3 : 1);
      b.decalOn(body, k.fu(NC, 0, 0.5, port), -2.6, 0.9, 0.3, decalIconRect('noStep'), DC.dark, port ? 3 : 1);
    }
  }
  k.dockCollar(0.9);
  b.strut(0, 2.6, 7.9, 0, 5.6, 7.9, 0.08, ST.steel, 6, 0.05);
  if (hero) {
    b.strut(-0.9, 4.9, 7.9, 0.9, 4.9, 7.9, 0.04, ST.steel, 4);
    b.at(0.55, 4.3, 7.9, () => b.dish(0.6, 0.17, ST.tankWhite, ST.steel, ST.steel), -1.2);
    b.at(0, -0.3, 9.52, () => b.greebles(3.0, 1.8, { styles: [ST.steel, ST.dark, ST.metal], cell: 0.42, height: 0.3, density: 0.7, pipes: 4, pipeStyle: ST.metal }), Math.PI / 2);
  }
  k.engine(0, 2.3, engCol, 3);
  k.engine(1, 2.3, engCol, 3);
  k.hardpoints(() => [0, -1, 0], 0.32);
  k.rcsBlocks(1.25);
  k.navLights(1.4);
}

/** Ilmarin Albatross: slender hull, huge radiator wings, dish antenna, spherical tanks. 34 m. */
function buildAlbatross(k: Kit): void {
  const { b, hero } = k;
  const engCol: RGB = [0.74, 0.68, 1];
  const reg = `IL-X${12 + k.variant * 9}`;

  // ---- hull: radome, habitat, foil-wrapped spine, service module
  const hull = k.tube(
    [
      [-16.2, 0.3, 0.3],
      [-15.6, 0.75, 0.7],
      [-13.8, 1.3, 1.2],
      [-11.2, 1.6, 1.45],
      [-5.6, 1.6, 1.45],
      [-4.4, 1.1, 1.1],
      [6.4, 1.1, 1.1],
      [7.8, 1.5, 1.5],
      [13.2, 1.5, 1.5],
      [14.3, 1.1, 1.1],
    ],
    {
      n: 40,
      K: 24,
      p: 2.4,
      extra: [-15.2, -14.9, -13.7, -6.4, -5.0, 7.0, 9.0, 9.6, 12.9],
      capStart: ST.carbon,
      capEnd: ST.dark,
      paint: (q) => {
        const side = q.c < 0.5 ? q.c : 1 - q.c; // 0 top .. 0.5 keel
        if (q.z < -15.2) return ST.carbon;
        if (q.z > 12.9) return ST.steel;
        if (q.z > -4.4 && q.z < 6.4) return ST.foilSilver;
        if ((q.z > -5.0 && q.z <= -4.4) || (q.z >= 6.4 && q.z < 7.0)) return ST.steel;
        if (q.z >= 7.0) return side > 0.3 ? ST.S : q.z > 9.0 && q.z < 9.6 ? ST.A : ST.P;
        if (q.z > -14.9 && q.z < -13.7 && side < 0.115) return ST.pit; // behind the windscreen
        if (side > 0.32) return ST.S;
        if (q.z > -6.4 && q.z < -5.6) return ST.A;
        return ST.P;
      },
    },
  );
  b.plateOn(hull, -0.122, 0.122, -14.88, -13.72, { lift: 0.04, style: ST.glass, nu: 8, nv: 3, bevel: 0.03 });
  b.plateOn(hull, -0.09, 0.09, -14.87, -14.75, { lift: 0.014, style: lamp(CYAN, 1.5), nu: 5, nv: 1, bevel: 0.01 });
  for (const s of [1, -1]) {
    const u = (x: number): number => (s > 0 ? x : 1 - x);
    const ord = (a: number, c: number): [number, number] => (a < c ? [a, c] : [c, a]);
    let [u0, u1] = ord(u(0.185), u(0.215));
    b.plateOn(hull, u0, u1, -12.6, -6.8, { lift: 0.02, bevel: 0.015, style: windows(0.55, true, 3.6), nu: 1, nv: 6 });
    [u0, u1] = ord(u(0.035), u(0.15));
    b.plateOn(hull, u0, u1, -12.9, -10.9, { lift: 0.03, style: ST.P2, nu: 3, nv: 3 });
    b.plateOn(hull, u0, u1, 8.3, 12.5, { lift: 0.035, style: ST.P2, nu: 3, nv: 4 });
    [u0, u1] = ord(u(0.27), u(0.31));
    b.plateOn(hull, u0, u1, -12.6, -6.4, { lift: 0.03, style: ST.metal, nu: 1, nv: 6 });
    if (hero) {
      b.textOn(hull, u(0.25), -8.6, reg, 0.5, DC.dark, s > 0 ? 1 : 3);
      b.decalOn(hull, u(0.245), -13.3, 1.0, 1.0, decalIconRect('logoIlmarin'), DC.secondary, s > 0 ? 1 : 3);
      b.decalOn(hull, u(0.1), 10.4, 2.4, 0.6, decalIconRect('stripeBroken'), DC.accent, s > 0 ? 1 : 3);
    }
  }
  k.whip(0, 0, -16.15, 0, 0, -17.0, 0.03);
  k.dockCollar(0.8);

  // ---- high-gain dish on a dorsal mast
  b.strut(0, 1.4, -7.0, 0, 3.05, -7.0, 0.13, ST.steel, 8, 0.1);
  b.at(0, 3.1, -7.0, () => {
    b.box(0.5, 0.36, 0.5, ST.dark, { bevel: 0.06 });
    b.at(0, 0.2, 0, () => b.dish(2.3, 0.62, ST.tankWhite, ST.P2, ST.steel), -0.55, 0, 0.12);
  });

  // ---- four spherical propellant tanks saddled on the spine
  for (const z of [-1.7, 2.5]) {
    b.mirror(() => {
      b.at(2.3, 0, z, () => {
        b.sphere(1.65, ST.foil, 24);
        b.torus(1.665, 0.05, ST.steel, { segs: 28, tube: 5 });
        b.at(0, 0, 0, () => b.torus(1.665, 0.05, ST.steel, { segs: 28, tube: 5 }), 0, Math.PI / 2);
      });
      if (hero) {
        b.strut(1.0, 0.6, z - 1.2, 1.6, 1.2, z - 0.5, 0.06, ST.steel, 4);
        b.strut(1.0, -0.6, z + 1.2, 1.6, -1.2, z + 0.5, 0.06, ST.steel, 4);
      }
    });
  }
  for (const y of [1.45, -1.45]) b.at(0, y, 0.4, () => b.sphere(0.62, ST.tankWhite, 14));
  if (hero) {
    b.mirror(() => b.pipe([2.3, 1.62, -1.7, 2.1, 2.0, 0.4, 2.3, 1.62, 2.5], 0.07, ST.metal, { sides: 6, smoothPath: true }));
    // magnetometer boom (port, asymmetric on purpose)
    b.strut(-1.2, -0.85, -8.2, -5.2, -2.3, -9.6, 0.05, ST.steel, 4, 0.035);
    b.at(-5.3, -2.33, -9.63, () => b.box(0.5, 0.36, 0.7, ST.foil, { bevel: 0.05 }));
  }

  // ---- fold-out radiator wings: three hinged panels a side on a root truss
  b.mirror(() => {
    b.truss(1.4, 0, 9.5, 2.5, 0, 9.5, { width: 0.7, bays: 2, r: 0.04, style: ST.steel, sides: 4 });
    const spans = [
      [2.4, 6.5],
      [6.65, 10.75],
      [10.9, 15.0],
    ];
    spans.forEach(([x0, x1], i) => {
      const outline = i === 2 ? [x0, 6.6, x1, 7.6, x1, 11.4, x0, 12.4] : [x0, 6.6, x1, 6.6, x1, 12.4, x0, 12.4];
      b.plate(outline, 0.08, { style: ST.radLight, edgeStyle: ST.metal, bevel: 0.03 });
      if (i > 0) b.at(x0 - 0.075, 0, 6.75, () => b.cyl(0.075, 0.075, 5.5, ST.steel, { segs: 6 }));
      // coolant loops: chordwise tubes on both faces, dark header strips along the edges
      const inset = i === 2 ? 1.05 : 0.12;
      for (let t = 0; t < 4; t++) {
        const x = x0 + ((x1 - x0) * (t + 0.5)) / 4;
        const zi = i === 2 ? 0.12 + ((inset - 0.12) * (x - x0)) / (x1 - x0) : 0.12;
        for (const y of [0.05, -0.05]) b.strut(x, y, 6.6 + zi + 0.1, x, y, 12.4 - zi - 0.1, 0.035, ST.metal, 4);
      }
      for (const y of [0.046, -0.046]) {
        b.at((x0 + x1) / 2, y, 9.5, () => b.box(x1 - x0 - 0.3, 0.012, 0.5, ST.rad, { bevel: 0.004 }));
      }
    });
    b.at(2.4, 0.1, 9.5, () => b.cyl(0.11, 0.06, 12.5, ST.metal, { segs: 8 }), 0, Math.PI / 2);
    b.at(2.4, -0.1, 9.5, () => b.cyl(0.11, 0.06, 12.5, ST.metal, { segs: 8 }), 0, Math.PI / 2);
    if (hero) {
      b.pipe([1.45, 0.35, 8.4, 2.0, 0.3, 8.2, 2.5, 0.08, 7.2], 0.05, ST.metal, { sides: 5, smoothPath: true });
      b.pipe([1.45, 0.35, 11.2, 2.0, 0.3, 11.5, 2.5, 0.08, 12.0], 0.05, ST.metal, { sides: 5, smoothPath: true });
      b.at(8.7, 0.045, 12.0, () => k.icon('dashes', 3.2, 0.3, DC.dark));
    }
  });

  if (hero) b.at(0, 0, 14.32, () => b.greebles(1.6, 1.6, { styles: [ST.steel, ST.dark, ST.metal], cell: 0.3, height: 0.2, density: 0.6, pipes: 3, pipeStyle: ST.metal }), Math.PI / 2);
  k.engine(0, 2.2, engCol, 3);
  k.engine(1, 2.2, engCol, 3);
  k.hardpoints(() => [0, 1, 0], 0.35);
  k.rcsBlocks(1.0);
  k.navLights(1.5);
}

/** Hadley-Okafor Caravel: container stack caged around a keel, bow shield, bridge tower aft, four drive bells. 72 m. */
function buildCaravel(k: Kit): void {
  const { b, hero } = k;
  const engCol: RGB = [1, 0.8, 0.56];
  const reg = `HO-C${704 + k.variant * 13}`;
  const rnd = seeded(4242 + k.variant * 17);

  // ---- keel and bow shield
  k.hullBox(
    [
      [-29.8, 1.4, 2.9, -2.9, 0.3],
      [21.8, 1.4, 2.9, -2.9, 0.3],
    ],
    { n: 4, paint: ST.steel },
  );
  const bow = k.hullBox(
    [
      [-36.0, 2.5, 2.0, -2.4, 0.6],
      [-34.2, 6.0, 4.6, -4.7, 1.0],
      [-31.2, 8.6, 6.3, -6.3, 1.0],
      [-29.6, 8.6, 6.3, -6.3, 0.6],
    ],
    {
      n: 10,
      extra: [-33.3, -32.5],
      capStart: ST.steel,
      capEnd: ST.dark,
      paint: (q) => (q.z > -33.3 && q.z < -32.5 ? ST.armorA : q.c === 1 || q.c === 2 ? ST.metal : q.z > -31.2 ? ST.armorS : ST.armor),
    },
  );
  for (const port of [false, true]) {
    k.panel(bow, 4, 1, 0.15, 0.85, -31.0, -29.9, port, ST.P2, 0.08, 2, 2);
    k.panel(bow, 4, 0, 0.2, 0.8, -35.3, -33.6, port, ST.armorS, 0.1, 2, 2);
    k.panel(bow, 4, 2, 0.2, 0.8, -35.3, -33.6, port, ST.armorS, 0.1, 2, 2);
    if (hero) {
      b.textOn(bow, k.fu(4, 1, 0.3, port), -32.0, reg, 1.3, DC.white, port ? 3 : 1, 0.74);
      b.decalOn(bow, k.fu(4, 1, 0.68, port), -31.6, 2.6, 2.6, decalIconRect('logoHadley'), DC.accent, port ? 3 : 1);
    }
  }
  k.dockCollar(1.5);
  k.flood(1.9, 1.3, -36.1, 2.2, WHITE, 8);
  k.flood(-1.9, 1.3, -36.1, 2.2, WHITE, 8);
  if (hero) {
    b.strut(2.6, 6.3, -30.6, 2.6, 8.6, -30.6, 0.1, ST.steel, 6, 0.06);
    b.at(-2.4, 6.35, -30.8, () => b.dish(1.1, 0.3, ST.tankWhite, ST.steel, ST.steel), -0.6);
  }

  // ---- four bays of containers: two columns a side, four rows, plus a row above and below the keel
  const cols = [ST.ribRust, ST.ribBlue, ST.ribTan, ST.ribGrey, ST.ribGreen, ST.ribWhite, ST.ribA, ST.ribS, ST.ribRust, ST.ribGrey];
  const marks = ['HKX', 'ILM', 'TDL', 'ORE', 'AUX', 'MRC'];
  for (let bay = 0; bay < 4; bay++) {
    const zc = -22.9 + bay * 12.6;
    for (const side of [1, -1]) {
      for (let col = 0; col < 2; col++) {
        for (let row = 0; row < 4; row++) {
          const r0 = rnd();
          const r1 = rnd();
          const r2 = rnd();
          if (col === 1 && (row === 0 || row === 3) && r0 < 0.32) continue;
          const st = cols[Math.floor(r1 * cols.length) % cols.length];
          const x = side * (3.0 + 3.0 * col);
          const y = -4.5 + 3 * row;
          b.at(x, y, zc, () => b.box(2.86, 2.86, 11.9, st, { bevel: 0.08 }));
          if (hero && col === 1 && r2 < 0.5) {
            k.face(x + side * 1.432, y, zc + (r2 - 0.25) * 8, side > 0 ? 'px' : 'nx', () => {
              b.at(0, 0, -0.5, () => b.text(`${marks[Math.floor(r2 * 12) % marks.length]} ${Math.floor(r1 * 900 + 100)}`, 0.62, st === ST.ribWhite || st === ST.ribTan ? DC.dark : DC.white));
              b.at(0, 0, 0.55, () => k.icon('panelLabel', 1.5, 0.75, st === ST.ribWhite || st === ST.ribTan ? DC.dark : DC.white));
            });
          }
        }
      }
    }
    for (const y of [4.5, -4.5]) {
      const r1 = rnd();
      b.at(0, y, zc, () => b.box(2.86, 2.86, 11.9, cols[Math.floor(r1 * cols.length) % cols.length], { bevel: 0.08 }));
    }
  }
  // ---- cage: ring frames between the bays, corner rails
  for (const z of [-29.25, -16.6, -4.0, 8.6, 21.25]) {
    for (const y of [6.2, -6.2]) b.at(0, y, z, () => b.box(15.9, 0.42, 0.44, ST.steel, { bevel: 0.07 }));
    for (const x of [7.75, -7.75]) b.at(x, 0, z, () => b.box(0.42, 12.8, 0.44, ST.steel, { bevel: 0.07 }));
    b.at(0, 0, z, () => b.box(15.2, 0.3, 0.3, ST.dark));
    b.at(0, 0, z, () => b.box(0.3, 12.2, 0.3, ST.dark));
  }
  for (const x of [7.75, -7.75]) for (const y of [6.2, -6.2]) b.at(x, y, -4.0, () => b.box(0.36, 0.36, 50.9, ST.yellow, { bevel: 0.06 }));

  // ---- superstructure: machinery block with flank radiators, bridge tower, mast
  const base = k.hullBox(
    [
      [21.6, 4.6, 5.0, -4.4, 0.5],
      [22.6, 5.4, 6.0, -5.2, 0.8],
      [29.8, 5.4, 6.0, -5.2, 0.8],
      [30.6, 4.8, 5.2, -4.6, 0.6],
    ],
    { n: 8, capStart: ST.dark, capEnd: ST.dark, paint: (q) => (q.c >= 2 ? ST.S : q.c === 1 ? ST.metal : ST.P) },
  );
  const tower = k.hullBox(
    [
      [23.6, 2.4, 11.6, 5.8, 0.3],
      [24.5, 3.0, 12.8, 5.8, 0.45],
      [28.2, 3.0, 12.8, 5.8, 0.45],
      [29.2, 2.6, 12.0, 5.8, 0.3],
    ],
    { n: 6, capStart: ST.white, capEnd: ST.white, paint: (q) => (q.c === 0.5 ? ST.steel : ST.white) },
  );
  for (const port of [false, true]) {
    k.panel(base, 4, 1, 0.1, 0.56, 23.3, 29.3, port, ST.rad, 0.09, 2, 5);
    k.panel(base, 4, 1, 0.64, 0.92, 23.3, 26.0, port, ST.P2, 0.06, 2, 2);
    k.panel(base, 4, 1, 0.64, 0.92, 26.5, 29.3, port, ST.P2, 0.06, 2, 2);
    k.win(tower, 4, 1, 0.03, 0.12, 24.7, 28.1, port, 0.6, 5);
    k.win(tower, 4, 1, 0.34, 0.4, 24.9, 28.0, port, 0.9, 3.5);
    k.win(tower, 4, 1, 0.6, 0.66, 24.9, 28.0, port, 0.9, 3.5);
    if (hero) b.decalOn(tower, k.fu(4, 1, 0.82, port), 26.4, 1.6, 1.6, decalIconRect('logoHadley'), DC.dark, port ? 3 : 1);
  }
  for (const [y, w] of [
    [11.05, 4.0],
    [9.4, 3.6],
    [7.7, 3.6],
  ]) {
    k.face(0, y, 23.585, 'nz', () => b.box(w, 0.03, 0.5, windows(0.55, false, y > 11 ? 5 : 3.5)));
    k.face(0, y + 0.3, 29.215, 'pz', () => b.box(w + 0.4, 0.03, 0.5, windows(0.55, false, y > 11 ? 5 : 3.5)));
  }
  b.mirror(() => {
    b.at(0, 11.3, 0, () => b.plate([2.9, 24.6, 7.4, 25.3, 7.4, 26.5, 2.9, 27.6], 0.22, { style: ST.white, edgeStyle: ST.steel, bevel: 0.08 }));
    b.strut(3.0, 9.6, 26.0, 6.6, 11.2, 25.9, 0.07, ST.steel, 4);
    b.at(2.7, -5.7, 26.1, () => {
      b.capsule(1.3, 4.4, ST.tankWhite, 16);
      for (const dz of [-1.6, 1.5]) b.at(0, 0, dz, () => b.ring(1.27, 1.37, 0.16, ST.steel, { segs: 16, bevel: 0.03 }));
    });
    if (hero) {
      b.at(1.7, 12.85, 25.2, () => b.dish(0.9, 0.25, ST.tankWhite, ST.steel, ST.steel), -0.5, 0, -0.3);
      k.whip(2.4, 12.8, 28.0, 2.7, 15.4, 28.4, 0.03);
    }
  });
  b.truss(0, 12.8, 26.4, 0, 16.0, 26.4, { width: 0.8, bays: 4, r: 0.04, chordR: 0.06, style: ST.steel, sides: 3 });
  b.at(0, 15.0, 26.4, () => b.box(3.6, 0.32, 0.5, ST.white, { bevel: 0.08 }));
  b.at(0, 13.6, 26.9, () => b.box(1.6, 0.9, 0.3, ST.dark, { bevel: 0.06 }));

  // ---- engine block and four bells
  k.hullBox(
    [
      [30.4, 5.8, 4.8, -4.8, 0.9],
      [33.2, 5.8, 4.8, -4.8, 0.9],
    ],
    { n: 3, capStart: ST.dark, capEnd: ST.dark, paint: (q) => (q.c === 1 || q.c === 2 ? ST.metal : q.c === 1.5 ? ST.S2 : ST.steel) },
  );
  if (hero) b.at(0, 0, 33.22, () => b.greebles(11, 9, { styles: [ST.steel, ST.dark, ST.metal], cell: 0.9, height: 0.55, density: 0.62, pipes: 6, pipeStyle: ST.metal }), Math.PI / 2);
  for (let i = 0; i < 4; i++) k.engine(i, 2.6, engCol, 4);
  k.hardpoints(() => [0, -1, 0], 0.4);
  k.rcsBlocks(2.4);
  k.navLights(2.6);
}

/** Auric Arsenal Halberd: armoured wedge prow, dorsal turret ring, side sponsons, triple drives. 44 m. */
function buildHalberd(k: Kit): void {
  const { b, hero } = k;
  const NC = 5;
  const engCol: RGB = [0.6, 0.85, 1];
  const reg = `AA-${61 + k.variant * 17}`;

  // ---- hull: corners = top centre, deck edge, chine, bilge, keel; the prow closes to a horizontal blade
  const hull = k.loft(
    [
      [-22.0, [[0, 0.12, 0.02], [2.2, 0.1, 0.02], [2.6, -0.2, 0.02], [2.2, -0.5, 0.02], [0, -0.52, 0.02]]],
      [-19.0, [[0, 0.9, 0.1], [2.6, 0.8, 0.15], [3.4, -0.25, 0.05], [2.7, -1.25, 0.15], [0, -1.4, 0.1]]],
      [-13.0, [[0, 2.3, 0.2], [3.3, 2.1, 0.3], [4.8, -0.3, 0.08], [3.6, -2.5, 0.3], [0, -2.8, 0.2]]],
      [-7.0, [[0, 3.2, 0.3], [3.8, 2.9, 0.4], [5.6, -0.3, 0.1], [4.2, -3.1, 0.4], [0, -3.4, 0.3]]],
      [6.0, [[0, 3.2, 0.3], [3.8, 2.9, 0.4], [5.6, -0.3, 0.1], [4.2, -3.1, 0.4], [0, -3.4, 0.3]]],
      [13.0, [[0, 3.2, 0.3], [3.8, 2.8, 0.4], [5.3, -0.3, 0.1], [4.1, -3.0, 0.4], [0, -3.2, 0.3]]],
      [17.5, [[0, 2.6, 0.3], [3.6, 2.4, 0.4], [5.0, -0.3, 0.15], [3.9, -2.5, 0.4], [0, -2.7, 0.3]]],
      [19.0, [[0, 2.0, 0.3], [3.6, 1.9, 0.4], [4.9, -0.3, 0.2], [3.8, -2.2, 0.4], [0, -2.3, 0.3]]],
    ],
    {
      n: 36,
      extra: [-21.3, -9.2, -8.3, 16.6],
      capStart: ST.metal,
      capEnd: ST.dark,
      paint: (q) => {
        if (q.z < -21.3) return ST.metal; // blade edge
        if (q.z > 16.6) return ST.steel;
        if (q.c === 2) return ST.metal;
        if (q.c >= 2.5) return ST.armorS;
        if (q.z > -9.2 && q.z < -8.3) return ST.armorA;
        return ST.armor;
      },
    },
  );
  // ---- appliqué armour: thick conformal plates with gaps between them
  const flank = [-18.4, -13.4, -7.4, -1.0, 5.4, 11.6, 16.4];
  const lower = [-16.0, -9.4, -1.6, 6.6, 14.4];
  for (const port of [false, true]) {
    k.panel(hull, NC, 0, 0.1, 0.9, -19.4, -14.6, port, ST.armor, 0.1, 3, 3);
    k.panel(hull, NC, 0, 0.1, 0.92, -14.1, -9.5, port, ST.armor, 0.1, 3, 3);
    k.panel(hull, NC, 0, 0.64, 0.95, 0.6, 12.4, port, ST.rad, 0.07, 2, 5);
    for (let i = 0; i + 1 < flank.length; i++) k.panel(hull, NC, 1, 0.1, 0.9, flank[i] + 0.25, flank[i + 1] - 0.25, port, i === 2 ? ST.armorS : ST.armor, 0.11, 3, 3);
    for (let i = 0; i + 1 < lower.length; i++) k.panel(hull, NC, 2, 0.12, 0.88, lower[i] + 0.25, lower[i + 1] - 0.25, port, ST.armorS, 0.11, 3, 3);
    if (hero) {
      b.textOn(hull, k.fu(NC, 1, 0.5, port), -10.6, reg, 1.0, DC.white, port ? 3 : 1, 0.74);
      b.decalOn(hull, k.fu(NC, 1, 0.5, port), 8.4, 1.9, 1.9, decalIconRect('logoAuric'), DC.accent, port ? 3 : 1);
      b.decalOn(hull, k.fu(NC, 0, 0.5, port), -16.9, 2.6, 0.7, decalIconRect('chevrons'), DC.accent, 1);
    }
  }

  // ---- dorsal turret: barbette, race ring, armoured house, twin guns
  b.at(0, 2.7, -3.0, () => {
    b.cyl(3.0, 3.0, 0.78, ST.armorS, { segs: 32, bevel: 0.12 });
    b.at(0, 0, 0.78, () => b.ring(2.5, 2.82, 0.2, ST.metal, { segs: 32, bevel: 0.04 }));
  }, -Math.PI / 2);
  b.at(0, 4.28, -3.0, () => {
    b.box(3.7, 1.3, 4.6, ST.armor, { bevel: 0.26, taperX: 0.72, taperZ: 0.78, shiftZ: 0.25 });
    b.at(0, -0.1, -2.35, () => b.box(2.5, 0.9, 0.7, ST.armorS, { bevel: 0.14 }));
    b.at(1.0, 0.7, 0.9, () => b.box(0.8, 0.3, 1.0, ST.dark, { bevel: 0.07 }));
    b.at(-0.9, 0.72, 0.2, () => b.cyl(0.42, 0.42, 0.12, ST.steel, { segs: 12, bevel: 0.03 }), -Math.PI / 2);
    for (const x of [0.72, -0.72]) {
      b.at(x, -0.1, -8.2, () => {
        b.cyl(0.2, 0.22, 5.6, ST.steel, { segs: 12, capB: false });
        b.at(0, 0, 3.9, () => b.cyl(0.32, 0.36, 1.7, ST.dark, { segs: 12, bevel: 0.04 }));
        b.at(0, 0, -0.02, () => b.ring(0.16, 0.34, 0.5, ST.dark, { segs: 12, bevel: 0.05 }));
      }, 0.045);
    }
    if (hero) k.whip(1.4, 0.6, 1.9, 1.5, 2.4, 2.3, 0.025);
  });

  // ---- citadel aft of the turret, slit windows, sensor mast
  const cit = k.hullBox(
    [
      [2.6, 1.6, 4.0, 2.8, 0.3],
      [3.7, 2.2, 4.75, 2.8, 0.45],
      [9.2, 2.2, 4.75, 2.8, 0.45],
      [10.4, 1.5, 3.9, 2.8, 0.3],
    ],
    { n: 6, capStart: ST.armorS, capEnd: ST.armorS, paint: (q) => (q.c === 1 ? ST.armorS : ST.armor) },
  );
  for (const port of [false, true]) k.win(cit, 4, 1, 0.1, 0.24, 3.9, 9.0, port, 0.5, 4);
  b.on(cit, 0, 3.15, () => b.box(2.6, 0.03, 0.26, windows(0.45, false, 4.5)), 0.012);
  b.strut(0, 4.7, 6.0, 0, 7.2, 6.0, 0.12, ST.steel, 6, 0.06);
  b.at(0, 6.2, 6.0, () => b.box(2.4, 0.3, 0.5, ST.dark, { bevel: 0.08 }));
  if (hero) {
    b.at(1.2, 4.8, 8.2, () => b.dish(0.8, 0.22, ST.steel, ST.dark, ST.steel), -0.4, 0, -0.3);
    k.whip(-1.5, 4.7, 8.6, -1.7, 6.6, 9.0, 0.03);
    b.at(0, 4.77, 6.0, () => b.greebles(3.4, 2.4, { styles: [ST.steel, ST.dark, ST.armorS], cell: 0.5, height: 0.25, density: 0.5 }));
  }
  k.dockCollar(1.0);

  b.mirror(() => {
    // ---- sponson: boxy pod on two pylons
    k.tube(
      [
        [-6.2, 0.5, 0.6, -0.3, 7.6],
        [-5.0, 1.3, 1.5, -0.3, 7.6],
        [-2.0, 1.5, 1.75, -0.3, 7.6],
        [9.0, 1.5, 1.75, -0.3, 7.6],
        [11.2, 1.1, 1.3, -0.3, 7.6],
        [12.0, 0.6, 0.7, -0.3, 7.6],
      ],
      {
        n: 14,
        K: 20,
        p: 3.4,
        extra: [-4.4, -3.6, 9.6],
        capStart: ST.steel,
        capEnd: ST.dark,
        paint: (q) => (q.z > 9.6 ? ST.steel : q.z > -4.4 && q.z < -3.6 ? ST.armorA : Math.abs(q.ny) > 0.75 ? ST.armor : ST.armorS),
      },
    );
    for (const z of [-1.2, 6.4]) b.at(5.9, -0.3, z, () => b.box(1.7, 1.3, 3.4, ST.armorS, { bevel: 0.14 }));
    b.at(9.13, -0.3, 2.6, () => b.box(0.12, 1.5, 4.6, ST.rad, { bevel: 0.03 }));
    b.at(7.6, -0.3, 12.0, () => b.box(1.0, 0.5, 0.06, heatGlow));
    // point-defence blister on the sponson shoulder
    b.at(7.6, 1.45, -2.2, () => {
      b.sphere(0.55, ST.armor, 12);
      b.at(0, 0.25, -0.9, () => b.cyl(0.07, 0.07, 0.9, ST.dark, { segs: 6, capB: false }));
    });
    // ---- canted radiator fin on the quarterdeck
    k.fin(2.6, 2.0, [0, 13.4, 3.2, 16.2, 3.2, 18.4, 0, 18.9], 0.2, 0.3, ST.rad, ST.armorS, false, false);
    // ---- engine shroud plates between the bells
    b.at(1.65, -0.2, 19.5, () => b.box(0.3, 3.6, 1.6, ST.armorS, { bevel: 0.08 }));
  });
  if (hero) b.at(0, -0.2, 19.02, () => b.greebles(9.0, 3.6, { styles: [ST.steel, ST.dark, ST.metal], cell: 0.6, height: 0.4, density: 0.6, pipes: 5, pipeStyle: ST.metal }), Math.PI / 2);
  for (let i = 0; i < 3; i++) k.engine(i, 2.5, engCol, 4);
  k.hardpoints((i) => (i < 2 ? [0, 0, 1] : i < 4 ? [0, -1, 0] : [0, 1, 0]), 0.5);
  k.rcsBlocks(1.8);
  k.navLights(2.0);
}


// ================================================================================================ registry

interface HullDef {
  build: (k: Kit) => void;
  /** texture scale: < 1 makes panels larger on big ships */
  uvScale: number;
  livery: Livery;
}

const HULLS: Record<ShipVisualId, HullDef> = {
  // Corvane: clear-coat white armour, gunmetal, signal red
  wren: { build: buildWren, uvScale: 1, livery: { primary: [0.78, 0.78, 0.765], secondary: [0.2, 0.205, 0.22], accent: [0.5, 0.03, 0.025] } },
  // Corvane military: gunship grey, pale grey, red
  shrike: { build: buildShrike, uvScale: 1, livery: { primary: [0.12, 0.13, 0.145], secondary: [0.34, 0.35, 0.36], accent: [0.4, 0.022, 0.01] } },
  // Ilmarin: pale grey, deep blue, amber
  drover: { build: buildDrover, uvScale: 0.75, livery: { primary: [0.66, 0.67, 0.66], secondary: [0.05, 0.11, 0.22], accent: [0.72, 0.4, 0.03] } },
  albatross: { build: buildAlbatross, uvScale: 0.8, livery: { primary: [0.76, 0.76, 0.74], secondary: [0.06, 0.13, 0.25], accent: [0.75, 0.38, 0.03] } },
  // Hadley-Okafor: plant yellow, charcoal, off-white
  magpie: { build: buildMagpie, uvScale: 0.75, livery: { primary: [0.58, 0.37, 0.035], secondary: [0.085, 0.09, 0.095], accent: [0.7, 0.69, 0.65] } },
  caravel: { build: buildCaravel, uvScale: 0.5, livery: { primary: [0.3, 0.31, 0.32], secondary: [0.085, 0.09, 0.095], accent: [0.62, 0.4, 0.035] } },
  // Auric Arsenal: graphite, bronze-grey, gold
  halberd: { build: buildHalberd, uvScale: 0.55, livery: { primary: [0.034, 0.036, 0.042], secondary: [0.1, 0.092, 0.08], accent: [0.72, 0.44, 0.07] } },
};

/** Manufacturer liveries used when the caller does not pass one. */
export const SHIP_LIVERIES: Record<ShipVisualId, Livery> = {
  wren: HULLS.wren.livery,
  shrike: HULLS.shrike.livery,
  drover: HULLS.drover.livery,
  albatross: HULLS.albatross.livery,
  magpie: HULLS.magpie.livery,
  caravel: HULLS.caravel.livery,
  halberd: HULLS.halberd.livery,
};

const LOD_DETAIL = [1, 0.5] as const;
const VARIANTS = 6;

/**
 * Build the merged geometry of a hull (no materials, no GPU work — also runs in node for tests).
 * `lod` 0 = hero, 1 = reduced. `mounts: false` leaves out the layout-driven parts (for layout checks).
 */
export function buildShipModel(id: ShipVisualId, lod: 0 | 1 = 0, seed = 0, mounts = true): BuiltModel {
  const def = HULLS[id];
  if (!def) throw new Error(`unknown hull: ${id}`);
  const k = new Kit(id, LOD_DETAIL[lod], Math.abs(Math.floor(seed)) % VARIANTS, mounts, def.uvScale);
  def.build(k);
  k.b.bakeAO(0.8);
  return k.b.build();
}

// ------------------------------------------------------------------------------------------------ geometry cache

interface CachedModel {
  model: BuiltModel;
  refs: number;
  buildMs: number;
}
const modelCache = new Map<string, CachedModel>();

function acquireModel(id: ShipVisualId, lod: 0 | 1, seed: number): { key: string; entry: CachedModel } {
  const key = `${id}:${lod}:${Math.abs(Math.floor(seed)) % VARIANTS}`;
  let entry = modelCache.get(key);
  if (!entry) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const model = buildShipModel(id, lod, seed);
    const fl = model.geometries[CH_FLARE];
    if (fl && fl.boundingSphere) fl.boundingSphere.radius += 6; // sprites extend beyond their anchor points
    entry = { model, refs: 0, buildMs: (typeof performance !== 'undefined' ? performance.now() : 0) - t0 };
    modelCache.set(key, entry);
  }
  entry.refs++;
  return { key, entry };
}

function releaseModel(key: string): void {
  const entry = modelCache.get(key);
  if (!entry) return;
  if (--entry.refs <= 0) {
    for (const g of entry.model.geometries) g?.dispose();
    modelCache.delete(key);
  }
}

// ================================================================================================ factory

export interface ShipVisualOptions {
  quality: HullQuality;
  livery?: Livery;
  seed?: number;
  /** 'auto' (default) switches by distance; 'hero' / 'low' pin one level (harness, hangar views) */
  lod?: 'auto' | 'hero' | 'low';
}

export interface ShipUpdateCtx {
  dt: number;
  time: number;
  /** 0..1 main-drive throttle (drives the bell interior glow; the plume is a separate effect) */
  throttle: number;
  lightsOn: boolean;
  /** 0..1 hull heat (aerobraking glow, hot radiators) */
  heat: number;
  /** 0..1 damage (scorching, dimmer engines) */
  damage: number;
}

export interface ShipVisual {
  object3d: THREE.Object3D;
  layout: ShipLayout;
  update(ctx: ShipUpdateCtx): void;
  dispose(): void;
  /** per built LOD: triangles, draw calls and CPU build time (0 when the geometry came from the cache) */
  stats: { lod: number; triangles: number; drawCalls: number; buildMs: number }[];
}

export function createShipVisual(id: ShipVisualId, opts: ShipVisualOptions): ShipVisual {
  const def = HULLS[id];
  if (!def) throw new Error(`unknown hull: ${id}`);
  const layout = SHIP_LAYOUTS[id];
  const seed = opts.seed ?? 0;
  // the player's Wren gets the hero finish: clear coat, micro detail, and a skin that is drawn from inside too
  const heroFinish = id === 'wren' ? { clearcoat: opts.quality !== 'low', doubleSided: true } : undefined;
  const mats: HullMaterials = createHullMaterials({ livery: opts.livery ?? def.livery, quality: opts.quality, hero: heroFinish });
  const mode = opts.lod ?? 'auto';
  const lods: (0 | 1)[] = mode === 'hero' ? [0] : mode === 'low' || opts.quality === 'low' ? [1] : [0, 1];

  const keys: string[] = [];
  const stats: ShipVisual['stats'] = [];
  const levels: THREE.Group[] = [];
  for (const lod of lods) {
    const { key, entry } = acquireModel(id, lod, seed);
    keys.push(key);
    const g = new THREE.Group();
    let calls = 0;
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      const geo = entry.model.geometries[ch];
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, mats.byChannel[ch]);
      mesh.renderOrder = ch === CH_GLASS ? 2 : ch === CH_FLARE ? 3 : ch;
      // the ray tracer's material record (surfaces.ts header); the hull's colour is per vertex: aTint.rgb^2 x the
      // livery colour of slot round(aFx.w * 3) (0 = none), roughness aSurf.z, metalness aSurf.y
      const liv = opts.livery ?? def.livery;
      mesh.userData.rt =
        ch === CH_HULL
          ? { albedo: [...liv.primary], roughness: 0.36, metalness: 0.05, tiles: null, perVertex: 'aTint^2 x livery[aFx.w]; aSurf.z rough; aSurf.y metal', livery: liv, demodulate: null }
          : ch === CH_GLASS
            ? { albedo: [0.016, 0.022, 0.03], roughness: 0.035, metalness: 0, glass: true }
            : { albedo: [0, 0, 0], roughness: 1, metalness: 0, emissive: true };
      g.add(mesh);
      calls++;
    }
    levels.push(g);
    stats.push({ lod, triangles: entry.model.triangles, drawCalls: calls, buildMs: entry.refs === 1 ? entry.buildMs : 0 });
  }

  let object3d: THREE.Object3D;
  if (levels.length === 1) object3d = levels[0];
  else {
    const lodObj = new THREE.LOD();
    lodObj.addLevel(levels[0], 0);
    // the reduced level takes over once the hull is a few dozen pixels long (sooner on the medium tier)
    lodObj.addLevel(levels[1], layout.radius * (opts.quality === 'medium' ? 14 : 22));
    object3d = lodObj;
  }
  object3d.name = `ship:${id}`;

  const matCtx = { time: 0, throttle: 0, lightsOn: true, heat: 0, damage: 0 };
  let thr = -1;
  let disposed = false;
  return {
    object3d,
    layout,
    stats,
    update(ctx: ShipUpdateCtx): void {
      // the bells heat up and cool down over a fraction of a second rather than switching
      const target = Math.min(1, Math.max(0, ctx.throttle));
      if (thr < 0) thr = target;
      else thr += (target - thr) * (1 - Math.exp(-Math.max(0, ctx.dt) * (target > thr ? 9 : 3.5)));
      matCtx.time = ctx.time;
      matCtx.throttle = thr;
      matCtx.lightsOn = ctx.lightsOn;
      matCtx.heat = ctx.heat;
      matCtx.damage = ctx.damage;
      mats.update(matCtx);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      object3d.removeFromParent();
      mats.dispose();
      for (const key of keys) releaseModel(key);
    },
  };
}
