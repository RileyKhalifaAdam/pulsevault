// The seven player / NPC hulls (docs/ARCHITECTURE.md section 7), built procedurally with geo.ts and
// shaded with the hull-material library. True size in metres, nose toward -Z, up +Y, starboard +X.
//
//   createShipVisual(id, { quality, livery?, seed? }) -> { object3d, layout, update(ctx), dispose() }
//
// A ship is at most five draw calls (hull, glass, glow, flare sprites, decals) per LOD. Geometry is
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
  type Corner,
  GLOW,
  LAYER,
  MeshBuilder,
  type Style,
  type Surface,
  TAU,
  curve,
  decalIconRect,
  decalStyle,
  flareStyle,
  glassStyle,
  glowStyle,
  hullStyle,
  sectionCurve,
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
  armor: hullStyle(LAYER.armor, [0.9, 0.9, 0.9], 0.3, 0.6, { slot: 1, wear: 0.62, grime: 0.6 }),
  armorS: hullStyle(LAYER.armor, W, 0.35, 0.62, { slot: 2, wear: 0.66, grime: 0.65 }),
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
  radLight: hullStyle(LAYER.radiator, [0.42, 0.43, 0.45], 0.9, 0.42, { wear: 0, grime: 0.25, heat: 1 }),
  ribP: hullStyle(LAYER.ribbed, W, 0.25, 0.58, { slot: 1, wear: 0.55, grime: 0.65 }),
  ribS: hullStyle(LAYER.ribbed, W, 0.25, 0.6, { slot: 2, wear: 0.55, grime: 0.7 }),
  ribA: hullStyle(LAYER.ribbed, W, 0.2, 0.55, { slot: 3, wear: 0.6, grime: 0.6 }),
  ribGrey: hullStyle(LAYER.ribbed, [0.3, 0.31, 0.32], 0.4, 0.6, { wear: 0.5, grime: 0.7 }),
  ribRust: hullStyle(LAYER.ribbed, [0.3, 0.12, 0.06], 0.3, 0.7, { wear: 0.6, grime: 0.8 }),
  ribBlue: hullStyle(LAYER.ribbed, [0.07, 0.16, 0.3], 0.25, 0.6, { wear: 0.55, grime: 0.7 }),
  ribTan: hullStyle(LAYER.ribbed, [0.5, 0.42, 0.28], 0.25, 0.62, { wear: 0.55, grime: 0.7 }),
  tankWhite: hullStyle(LAYER.metal, [0.72, 0.72, 0.7], 0.25, 0.5, { wear: 0.1, grime: 0.45 }),
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
      }
    });
  }

  /** RCS quad at every layout position: a housing sunk into the hull with a main jet and two side jets. */
  rcsBlocks(s: number): void {
    if (!this.mounts) return;
    const b = this.b;
    for (const r of this.L.rcs) {
      const p = r.pos;
      const d = r.dir;
      b.between(p.x - d.x * 0.24 * s, p.y - d.y * 0.24 * s, p.z - d.z * 0.24 * s, p.x + d.x, p.y + d.y, p.z + d.z, () => {
        b.at(0, 0, 0.12 * s, () => b.box(0.46 * s, 0.46 * s, 0.3 * s, ST.steel, { bevel: 0.05 * s }));
        b.at(0, 0, 0.25 * s, () => b.cyl(0.06 * s, 0.13 * s, 0.13 * s, ST.dark, { segs: 8, capB: false }));
        if (this.hero) {
          for (const sg of [-1, 1]) b.at(0.2 * s * sg, 0, 0.14 * s, () => b.cyl(0.05 * s, 0.1 * s, 0.11 * s, ST.dark, { segs: 6, capB: false }), 0, (Math.PI / 2) * sg);
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
        b.flare(flareStyle(l.color, strobe ? 16 : 5, (strobe ? 1.0 : 0.6) * s, { period: l.blink, duty: 0.1, switched: true }));
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
}

// ================================================================================================ hulls

/** Corvane CD-7 Wren: arrowhead lifting body, twin side-mounted drive pods, bubble canopy. 16 m. */
function buildWren(k: Kit): void {
  const { b, L, hero } = k;
  const NC = 5;
  const podX = L.engines[0].pos.x;
  const podY = L.engines[0].pos.y;
  const engCol: RGB = [0.62, 0.8, 1];
  const reg = `CD7-${204 + k.variant * 37}`;

  // ---- lifting body: corners = top centre, shoulder, chine, belly edge, keel
  const body = k.loft(
    [
      [-8.0, [[0, 0.03, 0.02], [0.05, 0.02, 0.02], [0.1, -0.03, 0.01], [0.06, -0.08, 0.02], [0, -0.1, 0.02]]],
      [-7.3, [[0, 0.27, 0.1], [0.3, 0.21, 0.12], [0.62, -0.03, 0.04], [0.36, -0.22, 0.1], [0, -0.27, 0.1]]],
      [-5.5, [[0, 0.66, 0.3], [0.7, 0.52, 0.3], [1.45, 0.0, 0.06], [0.95, -0.42, 0.2], [0, -0.5, 0.3]]],
      [-3.0, [[0, 0.98, 0.4], [1.05, 0.8, 0.4], [2.25, 0.02, 0.07], [1.6, -0.58, 0.25], [0, -0.68, 0.3]]],
      [0.0, [[0, 1.22, 0.5], [1.35, 1.02, 0.45], [3.0, 0.05, 0.08], [2.3, -0.7, 0.3], [0, -0.8, 0.3]]],
      [3.0, [[0, 1.25, 0.5], [1.5, 1.05, 0.45], [3.45, 0.08, 0.08], [2.7, -0.72, 0.3], [0, -0.82, 0.3]]],
      [5.2, [[0, 1.1, 0.4], [1.5, 0.92, 0.4], [3.3, 0.1, 0.08], [2.6, -0.62, 0.3], [0, -0.72, 0.3]]],
      [6.6, [[0, 0.8, 0.25], [1.4, 0.68, 0.25], [2.9, 0.1, 0.08], [2.3, -0.42, 0.2], [0, -0.5, 0.2]]],
    ],
    {
      n: 34,
      extra: [-7.0, -1.2, 2.2, 5.6],
      capStart: ST.carbon,
      capEnd: ST.dark,
      paint: (q) => {
        if (q.z < -7.0) return ST.carbon; // radome
        if (q.c >= 2.5) return ST.tile; // belly heat shield
        if (q.c === 2) return ST.metal; // bare leading-edge chine
        if (q.c === 1) return q.z > -6.2 && q.z < 5.6 ? ST.A : ST.P; // accent line along the shoulder
        if (q.z > 5.6) return ST.S;
        if (q.c === 1.5) return q.z > 2.2 ? ST.S : q.z > -1.2 ? ST.P2 : ST.P;
        return ST.P;
      },
    },
  );

  // ---- canopy: coaming mound, glass bubble, a hint of cockpit
  b.at(0, 0.71, -3.45, () => {
    b.with(new THREE.Matrix4().makeScale(0.92, 0.31, 1.84), () => b.sphere(1, ST.dark, 22));
    b.at(0, 0.15, 0, () => b.with(new THREE.Matrix4().makeScale(0.75, 0.62, 1.6), () => b.sphere(1, ST.glass, 24)));
    // seat, headrest, dash with instrument glow
    b.at(0, 0.36, 0.45, () => b.box(0.52, 0.5, 0.16, ST.seat, { bevel: 0.04 }), -0.2);
    b.at(0, 0.66, 0.5, () => b.box(0.26, 0.2, 0.12, ST.seat, { bevel: 0.03 }), -0.2);
    b.at(0, 0.3, -0.75, () => {
      b.box(0.95, 0.22, 0.5, ST.pit, { bevel: 0.05 });
      b.at(0, 0.115, 0.06, () => b.box(0.5, 0.012, 0.22, lamp(CYAN, 2.2)), 0.5);
      b.at(-0.33, 0.115, 0.1, () => b.box(0.12, 0.012, 0.16, lamp(AMBER, 2.2)), 0.5);
      b.at(0.33, 0.115, 0.1, () => b.box(0.12, 0.012, 0.16, lamp(AMBER, 2.2)), 0.5);
    });
  }, -0.115);

  // ---- dorsal spine with the docking hump
  k.loft(
    [
      [-1.8, [[0, 1.12, 0.05], [0.18, 1.1, 0.05], [0.24, 0.7, 0], [0, 0.7, 0]]],
      [-0.6, [[0, 1.42, 0.1], [0.45, 1.38, 0.1], [0.56, 0.9, 0], [0, 0.9, 0]]],
      [0.4, [[0, 1.5, 0.1], [0.7, 1.46, 0.1], [0.82, 0.9, 0], [0, 0.9, 0]]],
      [1.9, [[0, 1.5, 0.1], [0.7, 1.46, 0.1], [0.82, 0.9, 0], [0, 0.9, 0]]],
      [3.2, [[0, 1.46, 0.1], [0.4, 1.42, 0.1], [0.52, 0.9, 0], [0, 0.9, 0]]],
      [5.0, [[0, 1.3, 0.08], [0.28, 1.27, 0.08], [0.38, 0.8, 0], [0, 0.8, 0]]],
      [6.55, [[0, 0.95, 0.05], [0.18, 0.93, 0.05], [0.24, 0.5, 0], [0, 0.5, 0]]],
    ],
    { n: 14, capEnd: ST.dark, paint: (q) => (q.c >= 1.5 ? ST.S : q.z > 3.2 ? ST.S : ST.P), segs: 2 },
  );
  k.dockCollar(0.6);
  if (hero) {
    k.whip(0.22, 1.42, 3.7, 0.3, 1.98, 4.05);
    b.at(0, 1.505, 2.55, () => k.icon('arrow', 0.3, 0.3, DC.yellow));
    b.at(0, 1.505, -0.25, () => k.icon('arrow', 0.3, 0.3, DC.yellow), 0, Math.PI);
  }

  // ---- drive pods, pylons, winglets
  b.mirror((side) => {
    const pod = k.tube(
      [
        [1.0, 0.56, 0.56, podY, podX],
        [1.45, 0.7, 0.7, podY, podX],
        [2.6, 0.86, 0.86, podY, podX],
        [4.6, 0.86, 0.86, podY, podX],
        [6.0, 0.76, 0.76, podY, podX],
        [6.75, 0.58, 0.58, podY, podX],
      ],
      {
        n: 16,
        K: 24,
        extra: [1.25, 2.15, 2.5, 5.9],
        paint: (q) => (q.z < 1.25 ? ST.metal : q.z > 5.9 ? ST.steel : q.z > 2.15 && q.z < 2.5 ? ST.A : ST.S),
      },
    );
    // intake: lip, duct, shock cone
    b.at(podX, podY, 1.0, () => {
      b.lathe([0.565, 0, 0.5, 0.03, 0.45, 0.45, 0.4, 0.95, 0, 0.95], { segs: 24, flip: true, style: (_u, _v, _qi, qj) => (qj === 0 ? ST.metal : ST.pit), crease: 0.6 });
      b.lathe([0, 0.05, 0.12, 0.45, 0.2, 0.95], { segs: 12, style: ST.steel, crease: 1.2 });
    });
    // pylon wing joining pod and body
    b.at(0, 0.1, 0, () => b.plate([2.3, 0.7, podX, 1.5, podX, 6.3, 2.2, 6.62], 0.36, { style: ST.S2, edgeStyle: ST.metal, bevel: 0.1 }));
    // winglet with a slight dihedral
    b.at(podX + 0.78, podY, 0, () => b.plate([0, 3.3, 1.15, 5.45, 1.15, 6.32, 0, 6.5], 0.13, { style: ST.P, edgeStyle: ST.metal, bevel: 0.05, sharp: true }), 0, 0, 0.245);
    if (hero) {
      // markings (decals are authored on the starboard side; the mirror handles port)
      void side;
      b.decalOn(pod, 0.125, 3.6, 0.5, 0.5, decalIconRect('logoCorvane'), DC.accent, 1);
      b.decalOn(pod, 0.1, 5.35, 0.9, 0.22, decalIconRect('hazard'), DC.yellow, 1);
    }
  });
  k.engine(0, 1.25, engCol, 3);
  k.engine(1, 1.25, engCol, 3);

  // ---- upper-deck panels: radiators on the aft facets, access plates forward
  for (const port of [false, true]) {
    k.panel(body, NC, 1, 0.14, 0.86, 2.7, 5.0, port, ST.rad, 0.03, 4, 5);
    k.panel(body, NC, 1, 0.2, 0.8, -0.9, 1.5, port, ST.P, 0.022, 3, 5);
    if (hero) {
      k.panel(body, NC, 1, 0.3, 0.75, -4.6, -3.4, port, ST.P2, 0.018, 2, 3);
      b.textOn(body, k.fu(NC, 1, 0.5, port), -2.25, reg, 0.36, DC.dark, port ? 3 : 1);
      b.decalOn(body, k.fu(NC, 1, 0.5, port), 0.3, 1.5, 0.36, decalIconRect('stripeBroken'), DC.accent, port ? 3 : 1);
      b.decalOn(body, k.fu(NC, 1, 0.55, port), -5.4, 0.36, 0.36, decalIconRect('warnTri'), DC.red, port ? 3 : 1);
      b.decalOn(body, k.fu(NC, 1, 0.22, port), 5.85, 0.8, 0.2, decalIconRect('noStep'), DC.white, port ? 3 : 1);
    }
  }

  // ---- aft: body flap, machinery on the bulkhead
  b.at(0, -0.4, 0, () => b.plate([-2.25, 6.4, 2.25, 6.4, 2.0, 7.4, -2.0, 7.4], 0.1, { style: ST.steel, edgeStyle: ST.metal, bevel: 0.03 }));
  b.at(0, 0.3, 6.6, () => b.greebles(3.6, 0.62, { styles: [ST.steel, ST.dark, ST.metal], cell: 0.3, height: 0.2, density: 0.72, pipes: 5, pipeStyle: ST.metal }), Math.PI / 2);
  b.mirror(() => {
    b.at(1.9, -0.12, 6.6, () => b.box(0.9, 0.36, 0.16, ST.dark, { bevel: 0.03 }));
    b.at(1.9, -0.12, 6.69, () => b.box(0.74, 0.22, 0.02, heatGlow));
  });

  // ---- gear doors and belly hardpoints
  if (hero) {
    for (const port of [false, true]) k.panel(body, NC, 3, 0.1, 0.55, 2.4, 4.4, port, ST.steel, 0.012, 2, 2);
  }
  k.hardpoints(() => [0, 1, 0], 0.3);
  k.rcsBlocks(0.8);
  k.navLights(1);
}

// ================================================================================================ registry

interface HullDef {
  build: (k: Kit) => void;
  /** texture scale: < 1 makes panels larger on big ships */
  uvScale: number;
  livery: Livery;
}

const HULLS: Partial<Record<ShipVisualId, HullDef>> = {
  wren: { build: buildWren, uvScale: 1, livery: { primary: [0.74, 0.73, 0.69], secondary: [0.075, 0.082, 0.095], accent: [0.6, 0.15, 0.02] } },
};

/** Manufacturer liveries used when the caller does not pass one. */
export const SHIP_LIVERIES: Record<string, Livery> = Object.fromEntries(Object.entries(HULLS).map(([id, h]) => [id, (h as HullDef).livery]));

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
  const mats: HullMaterials = createHullMaterials({ livery: opts.livery ?? def.livery, quality: opts.quality });
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
    lodObj.addLevel(levels[1], layout.radius * 22);
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
