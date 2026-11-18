// The six station archetypes, modelled procedurally at true scale (metres, station-local frame: +Y is the
// main / spin axis) from the physical layouts in data/stationLayouts.ts.
//
//   ringHabitat  900 m spoked habitat ring turning round a de-spun docking hub
//   spindle      600 m trade spindle: stacked docking tiers, counter-rotating drums, container farm
//   refinery     700 m industrial platform: tank farm, smelter stacks, conveyors, glowing radiator wings
//   outpost      150 m frontier outpost: pressurised cans on a truss, solar wings, antenna farm
//   drydock      1,000 m open-frame shipyard gantry with a hull on the slip
//   citadel      800 m armoured military bastion
//
// A station is a handful of *parts* (the static structure plus each rotating section). Every part is one
// geo.ts MeshBuilder — so at most one draw call per channel — plus two instanced batches:
//
//   hull     PBR uber-material of hullMaterials.ts in "station" mode: megastructure plating at two scales and
//            baked floodlights (per-vertex exposure, the surface re-emits its own albedo)
//   windows  (builder channel CH_GLASS, own shader) procedural window fields: one quad carries hundreds of
//            panes, box-filtered so thousands of windows neither shimmer nor cost triangles; also greenhouse
//            glazing
//   glow     light strips, signs, furnace mouths (hullMaterials glow)
//   lamps    (builder channel CH_FLARE, own shader) energy-conserving light sprites: work lights, beacons,
//            strobes, and the guide lights of each berth, which run a green chase on the active port
//   decal    stencilled markings: port numbers, hazard borders, names
//   crates   InstancedMesh of cargo containers        struts  InstancedMesh of truss members
//
// A cheap far LOD is built by the same code at low detail. Geometry building is pure CPU work
// (buildStationModel also runs in node for the tests); createStationVisual adds materials and the LOD switch.

import * as THREE from 'three';
import type { DockingPortDef, RGB, StationLayout, StationVisualId } from '../../core/types';
import { BERTHS, CITADEL, DRYDOCK, OUTPOST, REFINERY, RING_HABITAT, SPINDLE, STATION_LAYOUTS } from '../../data/stationLayouts';
import {
  CH_DECAL,
  CH_FLARE,
  CH_GLASS,
  CH_GLOW,
  CH_HULL,
  CHANNEL_COUNT,
  GLOW,
  LAYER,
  MeshBuilder,
  decalGlyphRect,
  decalIconRect,
  decalStyle,
  glowStyle,
  hullStyle,
  seeded,
  type BuiltModel,
  type Style,
  type StyleFn,
  type Surface,
} from './geo';
import { createHullMaterials, type HullMaterials, type HullQuality, type Livery } from './hullMaterials';

export type { Livery } from './hullMaterials';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// ================================================================================================ styles

const WARM: RGB = [1.0, 0.76, 0.47];
const WARM2: RGB = [1.0, 0.84, 0.62];
const COOL: RGB = [0.72, 0.86, 1.0];
const WHITE: RGB = [1.0, 0.96, 0.9];
const AMBER: RGB = [1.0, 0.56, 0.13];
const RED: RGB = [1.0, 0.09, 0.04];
const SODIUM: RGB = [1.0, 0.6, 0.22];
const FURNACE: RGB = [1.0, 0.38, 0.07];
const GROW: RGB = [0.9, 1.0, 0.82];
const CYAN: RGB = [0.45, 0.9, 1.0];

const hs = hullStyle;
/** Hull finishes. Slot 1 / 2 / 3 multiply the livery's primary / secondary / accent colour. */
const H = {
  p0: hs(LAYER.panel, [1, 1, 1], 0.12, 0.56, { slot: 1, wear: 0.2, grime: 0.42 }),
  p1: hs(LAYER.panel, [0.84, 0.84, 0.84], 0.12, 0.6, { slot: 1, wear: 0.24, grime: 0.5 }),
  p2: hs(LAYER.panel, [0.68, 0.68, 0.68], 0.14, 0.62, { slot: 1, wear: 0.3, grime: 0.55 }),
  p3: hs(LAYER.armor, [0.78, 0.78, 0.78], 0.25, 0.62, { slot: 1, wear: 0.35, grime: 0.55 }),
  a0: hs(LAYER.armor, [1, 1, 1], 0.3, 0.6, { slot: 1, wear: 0.3, grime: 0.5 }),
  a1: hs(LAYER.armor, [0.78, 0.78, 0.78], 0.32, 0.64, { slot: 1, wear: 0.38, grime: 0.6 }),
  a2: hs(LAYER.armor, [0.58, 0.58, 0.58], 0.35, 0.66, { slot: 1, wear: 0.42, grime: 0.6 }),
  s0: hs(LAYER.panel, [1, 1, 1], 0.2, 0.6, { slot: 2, wear: 0.3, grime: 0.5 }),
  s1: hs(LAYER.armor, [0.75, 0.75, 0.75], 0.3, 0.66, { slot: 2, wear: 0.4, grime: 0.55 }),
  s2: hs(LAYER.panel, [1.5, 1.5, 1.5], 0.2, 0.6, { slot: 2, wear: 0.3, grime: 0.5 }),
  ac: hs(LAYER.panel, [1, 1, 1], 0.1, 0.5, { slot: 3, wear: 0.35, grime: 0.4 }),
  metal: hs(LAYER.metal, [0.46, 0.46, 0.47], 1, 0.42, { wear: 0, grime: 0.5 }),
  steel: hs(LAYER.metal, [0.21, 0.215, 0.225], 0.9, 0.5, { wear: 0, grime: 0.6 }),
  truss: hs(LAYER.metal, [0.3, 0.31, 0.33], 0.9, 0.5, { wear: 0, grime: 0.5 }),
  yellow: hs(LAYER.panel, [0.62, 0.42, 0.045], 0.15, 0.55, { wear: 0.55, grime: 0.6 }),
  foil: hs(LAYER.foil, [0.82, 0.58, 0.22], 1, 0.32, { wear: 0, grime: 0.25 }),
  foilS: hs(LAYER.foil, [0.62, 0.64, 0.68], 1, 0.3, { wear: 0, grime: 0.25 }),
  tile: hs(LAYER.tile, [0.2, 0.2, 0.21], 0.05, 0.8, { wear: 0, grime: 0.5 }),
  tileB: hs(LAYER.tile, [0.13, 0.132, 0.14], 0.05, 0.82, { wear: 0, grime: 0.5 }),
  deck: hs(LAYER.armor, [0.1, 0.105, 0.115], 0.25, 0.78, { wear: 0.5, grime: 0.6 }),
  pit: hs(LAYER.panel, [0.014, 0.014, 0.016], 0, 0.9, { wear: 0, grime: 0 }),
  tank: hs(LAYER.ribbed, [0.64, 0.64, 0.62], 0.2, 0.5, { wear: 0.25, grime: 0.5 }),
  tankB: hs(LAYER.ribbed, [0.44, 0.45, 0.46], 0.25, 0.52, { wear: 0.3, grime: 0.6 }),
  tankR: hs(LAYER.ribbed, [0.42, 0.13, 0.07], 0.2, 0.55, { wear: 0.45, grime: 0.6 }),
  rust: hs(LAYER.armor, [0.2, 0.13, 0.095], 0.4, 0.75, { wear: 0.5, grime: 0.8 }),
  soot: hs(LAYER.armor, [0.06, 0.058, 0.056], 0.3, 0.85, { wear: 0.2, grime: 0.8 }),
  solar: hs(LAYER.tile, [0.012, 0.022, 0.06], 0.75, 0.2, { wear: 0, grime: 0.15 }),
  gun: hs(LAYER.metal, [0.09, 0.092, 0.1], 0.9, 0.45, { wear: 0, grime: 0.6 }),
} as const;

/** Radiator finish by heat level 0..5 (glows with the hull material's heat uniform). */
const RAD: Style[] = [0, 0.3, 0.45, 0.6, 0.75, 0.9].map((h) => hs(LAYER.radiator, [0.075, 0.077, 0.085], 0.85, 0.5, { heat: h, wear: 0, grime: 0.35 }));

/** Faded container paints (linear albedo). */
const CRATE_COLORS: RGB[] = [
  [0.33, 0.07, 0.045],
  [0.05, 0.13, 0.26],
  [0.42, 0.26, 0.05],
  [0.3, 0.31, 0.32],
  [0.52, 0.52, 0.5],
  [0.06, 0.2, 0.13],
  [0.13, 0.135, 0.15],
  [0.36, 0.17, 0.05],
  [0.07, 0.24, 0.27],
];

/**
 * Window field (builder channel CH_GLASS). uv is in metres; `pu` x `pv` is the window pitch, `lit` the
 * fraction of lit panes. mode 0 = windows, 1 = greenhouse glazing. `vary` 0..1 is the brightness spread
 * (0 = an evenly lit opening such as a hangar slot).
 */
function winStyle(color: RGB, intensity: number, pu: number, pv: number, lit = 0.55, o: { fillU?: number; fillV?: number; mode?: number; seed?: number; vary?: number } = {}): Style {
  return {
    ch: CH_GLASS,
    r: color[0],
    g: color[1],
    b: color[2],
    a: lit,
    s0: o.mode ?? 0,
    s1: Math.sqrt(Math.min(1, intensity / 64)),
    s2: Math.min(1, pu / 64),
    s3: Math.min(1, pv / 64),
    f0: o.fillU ?? 0.62,
    f1: o.fillV ?? 0.5,
    f2: o.seed ?? 0,
    f3: o.vary ?? 1,
  };
}

interface LampOpts {
  /** blink period, s (0 = steady) */
  period?: number;
  phase?: number;
  duty?: number;
  /** keep visible from far away (strobes) */
  beacon?: boolean;
  /** 1-based port index: the lamp is a guide light of that berth; `phase` then orders the chase */
  port?: number;
}

/** Light sprite (builder channel CH_FLARE): `size` is the glow radius in metres (<= 64). */
function lampStyle(color: RGB, intensity: number, size: number, o: LampOpts = {}): Style {
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
    f0: o.beacon ? 1 : 0,
    f1: Math.sqrt(Math.min(1, size / 64)),
    f2: o.duty ?? 0.5,
    f3: (o.port ?? 0) / 32,
  };
}

/** Window pitch (u, v) in metres as the shader will decode it from the 8-bit style. */
function winPitch(st: Style): [number, number] {
  return [(Math.max(1, Math.round(st.s2 * 255)) / 255) * 64, (Math.max(1, Math.round(st.s3 * 255)) / 255) * 64];
}

const lit = (color: RGB, intensity: number): Style => glowStyle(GLOW.steady, color, intensity);

const WIN = {
  hab: winStyle(WARM, 4.2, 3.4, 3.5, 0.56, { fillU: 0.6, fillV: 0.46 }),
  habCool: winStyle(WARM2, 3.6, 4.0, 3.5, 0.5, { fillU: 0.66, fillV: 0.42, seed: 0.3 }),
  small: winStyle(WARM, 4.0, 2.6, 3.0, 0.5, { fillU: 0.5, fillV: 0.42, seed: 0.6 }),
  office: winStyle(COOL, 3.2, 3.0, 3.2, 0.62, { fillU: 0.72, fillV: 0.5, seed: 0.45 }),
  lift: winStyle(WARM2, 3.0, 3, 7, 0.7, { fillU: 0.7, fillV: 0.6, seed: 0.8 }),
  green: winStyle(GROW, 2.3, 7, 7, 1, { fillU: 0.93, fillV: 0.93, mode: 1 }),
  bay: winStyle(COOL, 3.4, 9, 64, 1, { fillU: 0.9, fillV: 0.96, vary: 0.25, seed: 0.2 }),
  bayWarm: winStyle(WARM2, 3.2, 8, 64, 1, { fillU: 0.9, fillV: 0.96, vary: 0.3, seed: 0.7 }),
  slit: winStyle(FURNACE, 9, 5, 64, 1, { fillU: 0.86, fillV: 0.9, vary: 0.5, seed: 0.9 }),
} as const;

// ================================================================================================ small helpers

function hsh(a: number, b: number, s: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(s | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Megaplate breakup: picks one of `variants` per block of sx x sy quads. Returns cached styles (shared vertices). */
function plating(variants: readonly Style[], sx: number, sy: number, seed: number): StyleFn {
  return (_u, _v, qi, qj) => variants[Math.floor(hsh(Math.floor(qi / sx), Math.floor(qj / sy), seed) * variants.length) % variants.length];
}

/** Insert points so no segment of an (r, y) profile is longer than maxLen. */
function subdiv(profile: readonly number[], maxLen: number): number[] {
  const out: number[] = [profile[0], profile[1]];
  for (let i = 2; i < profile.length; i += 2) {
    const r0 = profile[i - 2];
    const y0 = profile[i - 1];
    const r1 = profile[i];
    const y1 = profile[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(r1 - r0, y1 - y0) / maxLen));
    for (let k = 1; k <= n; k++) out.push(r0 + ((r1 - r0) * k) / n, y0 + ((y1 - y0) * k) / n);
  }
  return out;
}

/** Mirror an (r, y) profile in y, keeping it running from -y to +y. */
function flipProfile(profile: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = profile.length - 2; i >= 0; i -= 2) out.push(profile[i], -profile[i + 1]);
  return out;
}

const cleanName = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9\-./ ]/g, '').trim();

// ================================================================================================ parts

interface Flood {
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  range: number;
  cosOut: number;
  cosIn: number;
  power: number;
}

/** Flood exposure that maps to the full 8-bit range (the hull material multiplies by its flood colour). */
const FLOOD_MAX = 2;

interface InstData {
  count: number;
  matrix: number[];
  tint: number[];
  surf: number[];
  fx: number[];
  /** instance centres, for the flood bake */
  centre: number[];
}
const newInst = (): InstData => ({ count: 0, matrix: [], tint: [], surf: [], fx: [], centre: [] });

class Part {
  readonly b: MeshBuilder;
  readonly floods: Flood[] = [];
  readonly crates = newInst();
  readonly struts = newInst();
  constructor(
    readonly name: string,
    /** rad/s about +Y (0 = static) */
    readonly spin: number,
    detail: number,
    seed: number,
    uvScale: number,
  ) {
    this.b = new MeshBuilder({ detail, uvScale, seed });
  }
}

/** Container dimensions (x, y, z), m: every crate instance is this box. */
const CRATE: readonly [number, number, number] = [4.6, 4.6, 14];

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _vx = new THREE.Vector3();
const _vy = new THREE.Vector3();
const _vz = new THREE.Vector3();

class Kit {
  readonly parts: Part[] = [];
  part!: Part;
  b!: MeshBuilder;
  /** hero LOD (false: the cheap far LOD) */
  readonly hero: boolean;
  /** seed-dependent variation */
  readonly rnd: () => number;
  readonly layout: StationLayout;

  constructor(
    readonly id: StationVisualId,
    readonly detail: number,
    readonly seed: number,
    /** add tertiary detail (greebles, dense lamps): hero LOD on the upper quality tiers */
    readonly rich: boolean,
    readonly name: string,
    readonly uvScale: number,
  ) {
    this.hero = detail >= 0.55;
    this.rnd = seeded((seed >>> 0) * 2654435761 + 97);
    this.layout = STATION_LAYOUTS[id];
  }

  newPart(name: string, spin = 0): Part {
    const p = new Part(name, spin, this.detail, 1009 + this.parts.length * 77 + (this.seed % 9973), this.uvScale);
    this.parts.push(p);
    if (!this.part) {
      this.part = p;
      this.b = p.b;
    }
    return p;
  }

  /** Emit into another part for the duration of fn. */
  use(p: Part, fn: () => void): void {
    const prev = this.part;
    this.part = p;
    this.b = p.b;
    fn();
    this.part = prev;
    this.b = prev.b;
  }

  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.rnd() * list.length) % list.length];
  }

  // ---------------------------------------------------------------- frames

  /**
   * Frame on a cylinder round the station axis: origin at azimuth `az`, radius r, height y; local +Y points
   * radially out, +Z along station +Y, +X along the tangent. `spin` turns it about the radial (pi = text upright).
   */
  polar(az: number, r: number, y: number, fn: () => void, spin = 0): void {
    const c = Math.cos(az);
    const s = Math.sin(az);
    _m.makeBasis(_vx.set(s, 0, c), _vy.set(c, 0, -s), _vz.set(0, 1, 0)).setPosition(r * c, y, -r * s);
    if (spin !== 0) _m.multiply(_m2.makeRotationY(spin));
    this.b.push(_m);
    fn();
    this.b.pop();
  }

  /** Frame of a docking port: origin at the mating point, +Y out along the port axis, -Z toward the port's `up`. */
  portFrame(p: DockingPortDef, fn: () => void): void {
    _vy.set(p.dir.x, p.dir.y, p.dir.z);
    _vz.set(-p.up.x, -p.up.y, -p.up.z);
    _vx.crossVectors(_vy, _vz);
    _m.makeBasis(_vx, _vy, _vz).setPosition(p.pos.x, p.pos.y, p.pos.z);
    this.b.push(_m);
    fn();
    this.b.pop();
  }

  // ---------------------------------------------------------------- surfaces

  /**
   * Revolve an (r, y) profile round the station axis. A profile running from -y to +y is an outer surface
   * (a closed profile goes up the outside and back down the inside). Arcs are given as station azimuths
   * az0 < az1. UVs are metres: u at the reference radius `uRef` (default: the profile's largest radius, so
   * textures and window columns never shear), v along the profile. The Surface's u runs against the azimuth
   * (u = (pi/2 - az) / tau for a full turn — see uAz) and v is the normalised profile length.
   */
  revolve(profile: readonly number[], style: StyleFn, o: { segs?: number; az0?: number; az1?: number; closed?: boolean; crease?: number; uRef?: number } = {}): Surface {
    const b = this.b;
    const np = profile.length >> 1;
    const full = o.az0 === undefined || o.az1 === undefined;
    const a0 = full ? 0 : Math.PI / 2 - (o.az1 as number);
    const a1 = full ? TAU : Math.PI / 2 - (o.az0 as number);
    const segs = Math.max(full ? 6 : 1, Math.round((b.seg(o.segs ?? 48, 6) * (a1 - a0)) / TAU));
    const closed = !!o.closed;
    const nv = closed ? np + 1 : np;
    let rmax = 0;
    for (let i = 0; i < np; i++) rmax = Math.max(rmax, profile[i * 2]);
    let uRef = o.uRef ?? rmax;
    const vlen: number[] = [0];
    for (let j = 1; j < nv; j++) {
      const k0 = ((j - 1) % np) * 2;
      const k1 = (j % np) * 2;
      vlen.push(vlen[j - 1] + Math.hypot(profile[k1] - profile[k0], profile[k1 + 1] - profile[k0 + 1]));
    }
    const total = vlen[nv - 1] || 1;
    // window fields: a whole number of cells round the arc and along the profile, starting at their edges
    let vScale = 1;
    const isWin = typeof style !== 'function' && style.ch === CH_GLASS;
    if (isWin) {
      const [pu, pv] = winPitch(style);
      uRef = (Math.max(1, Math.round(((a1 - a0) * uRef) / pu)) * pu) / (a1 - a0);
      vScale = (Math.max(1, Math.round(total / pv)) * pv) / total;
    }
    return b.grid({
      nu: segs + 1,
      nv,
      wrapU: full,
      wrapV: closed,
      pos: (i, j, out) => {
        const a = a0 + ((a1 - a0) * i) / segs;
        const k = (j % np) * 2;
        const r = profile[k];
        out.set(r * Math.sin(a), profile[k + 1], -r * Math.cos(a));
      },
      uv: (i, j, out) => {
        out.set((((a1 - a0) * i) / segs + (isWin ? 0 : a0)) * uRef, vlen[j] * vScale);
      },
      style,
      crease: o.crease ?? 0.6,
      uvMirror: false,
      vs: vlen.map((l) => l / total),
    });
  }

  /** Surface u of a full revolve() at station azimuth az. */
  uAz(az: number): number {
    const u = (Math.PI / 2 - az) / TAU;
    return u - Math.floor(u);
  }

  /** Tessellated rectangle in the local XZ plane facing +Y, centred on the origin (nx x nz quads). */
  panel(w: number, d: number, nx: number, nz: number, style: StyleFn): Surface {
    const hero = this.hero;
    const qx = hero ? Math.max(1, nx) : 1;
    const qz = hero ? Math.max(1, nz) : 1;
    return this.b.grid({
      nu: qx + 1,
      nv: qz + 1,
      pos: (i, j, out) => {
        out.set(-w / 2 + (w * i) / qx, 0, -d / 2 + (d * j) / qz);
      },
      style,
      uvMirror: false,
      u0: this.b.rand() * 40,
      v0: this.b.rand() * 40,
    });
  }

  /**
   * Window field on a rectangle in the local XZ plane facing +Y, centred on the origin: columns along X,
   * rows along Z, a whole number of cells each way. Place it a little proud of the wall behind.
   */
  winPanel(w: number, d: number, st: Style): void {
    const [pu, pv] = winPitch(st);
    const nu = Math.max(1, Math.round(w / pu)) * pu;
    const nv = Math.max(1, Math.round(d / pv)) * pv;
    this.b.grid({
      nu: 2,
      nv: 2,
      pos: (i, j, out) => {
        out.set((i - 0.5) * w, 0, (j - 0.5) * d);
      },
      uv: (i, j, out) => {
        out.set(i * nu, j * nv);
      },
      style: st,
      uvMirror: false,
    });
  }

  /** Slab whose tessellated top face lies in the local XZ plane (y = 0) and whose body hangs below it. */
  slab(w: number, t: number, d: number, top: StyleFn, side: Style, n = 6, bevel = 0.3): Surface {
    this.b.at(0, -t / 2, 0, () => this.b.box(w, t, d, side, { bevel, omit: 8 }));
    return this.panel(w, d, n, Math.max(1, Math.round((n * d) / w)), top);
  }

  /** Thin two-sided wall in the local XY plane (normal +-Z), centred in x, rising from y = 0. */
  wall(w: number, h: number, t: number, style: StyleFn, nx = 4, ny = 4, edge: Style = H.steel): void {
    const b = this.b;
    b.at(0, h / 2, 0, () => b.box(w, h, t, edge, { omit: 48 }));
    // style v runs 0 at the foot (y = 0) to 1 at the top on both faces
    const up: StyleFn = typeof style === 'function' ? (u, v, qi, qj) => style(u, 1 - v, qi, qj) : style;
    b.at(0, h / 2, t / 2, () => this.panel(w, h, nx, ny, up), Math.PI / 2);
    b.at(0, h / 2, -t / 2, () => this.panel(w, h, nx, ny, style), -Math.PI / 2);
  }

  /** Stencilled text conformal to a Surface, upright when +v is "up" (rot 2), lifted clear of depth noise. */
  textOn(s: Surface, u: number, v: number, text: string, h: number, st: Style, rot = 2): void {
    const met = { mu: 1, mv: 1 };
    s.metric(u, v, met);
    const adv = h * 0.72;
    const total = adv * (text.length - 1);
    for (let k = 0; k < text.length; k++) {
      const rect = decalGlyphRect(text[k]);
      if (!rect) continue;
      const a = -total / 2 + k * adv;
      let du = 0;
      let dv = 0;
      if (rot === 0) du = a / met.mu;
      else if (rot === 1) dv = -a / met.mv;
      else if (rot === 2) du = -a / met.mu;
      else dv = a / met.mv;
      this.b.decalOn(s, u + du, v + dv, h, h, rect, st, rot, 2, 0.4);
    }
  }

  /** Flat stencilled text in the local XZ plane (tops toward -Z), lifted clear of depth noise. */
  text(text: string, h: number, st: Style, lift = 0.35): void {
    const adv = h * 0.72;
    const total = adv * (text.length - 1);
    for (let k = 0; k < text.length; k++) {
      const rect = decalGlyphRect(text[k]);
      if (!rect) continue;
      this.b.at(-total / 2 + k * adv, 0, 0, () => this.b.decal(h, h, rect, st, lift));
    }
  }

  // ---------------------------------------------------------------- lights

  lamp(x: number, y: number, z: number, color: RGB, intensity: number, size: number, o?: LampOpts): void {
    this.b.at(x, y, z, () => this.b.flare(lampStyle(color, intensity, size, o)));
  }

  /** Red / white strobe with a dim steady marker so the point never vanishes between flashes. */
  beacon(x: number, y: number, z: number, color: RGB = RED, period = 2.4, phase = 0, size = 7): void {
    this.lamp(x, y, z, color, 56, size, { period, phase, duty: 0.07, beacon: true });
    this.lamp(x, y, z, color, 5, size * 0.3);
  }

  /**
   * Floodlight at (x, y, z) aimed at (tx, ty, tz): baked into the hull vertices of this part (see bakeFloods).
   * `range` in metres; `power` is the exposure straight ahead at about a third of the range.
   */
  flood(x: number, y: number, z: number, tx: number, ty: number, tz: number, range: number, power = 1, cone = 52, fixture = true): void {
    this.b.currentMatrix(_m);
    _va.set(x, y, z).applyMatrix4(_m);
    _vb.set(tx, ty, tz).applyMatrix4(_m).sub(_va);
    const sc = _vb.length() / Math.max(1e-6, Math.hypot(tx - x, ty - y, tz - z));
    _vb.normalize();
    this.part.floods.push({
      x: _va.x,
      y: _va.y,
      z: _va.z,
      dx: _vb.x,
      dy: _vb.y,
      dz: _vb.z,
      range: range * sc,
      cosOut: Math.cos(cone * DEG),
      cosIn: Math.cos(cone * 0.45 * DEG),
      power,
    });
    if (fixture) this.lamp(x, y, z, WHITE, 14, Math.max(1.6, range * 0.035));
  }

  // ---------------------------------------------------------------- instanced members

  private pushInst(d: InstData, m: THREE.Matrix4, st: Style, tint?: RGB): void {
    const e = m.elements;
    for (let i = 0; i < 16; i++) d.matrix.push(e[i]);
    const c = tint ?? [st.r, st.g, st.b];
    d.tint.push(Math.round(255 * Math.sqrt(Math.min(1, c[0]))), Math.round(255 * Math.sqrt(Math.min(1, c[1]))), Math.round(255 * Math.sqrt(Math.min(1, c[2]))), 255);
    d.surf.push(st.s0, Math.round(255 * st.s1), Math.round(255 * st.s2), Math.round(255 * st.s3));
    d.fx.push(Math.round(255 * st.f0), 0, Math.round(255 * st.f2), Math.round(255 * st.f3));
    d.centre.push(e[12] + (e[8] * 0.5), e[13] + (e[9] * 0.5), e[14] + (e[10] * 0.5));
    d.count++;
  }

  /** One truss member between two points (local coordinates); instanced. */
  strut(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, st: Style = H.truss): void {
    this.b.currentMatrix(_m);
    _va.set(ax, ay, az).applyMatrix4(_m);
    _vb.set(bx, by, bz).applyMatrix4(_m);
    _vz.subVectors(_vb, _va);
    const len = _vz.length();
    if (len < 1e-6) return;
    _vz.multiplyScalar(1 / len);
    if (Math.abs(_vz.y) < 0.99) _vx.set(0, 1, 0).cross(_vz).normalize();
    else _vx.set(1, 0, 0).cross(_vz).normalize();
    _vy.crossVectors(_vz, _vx);
    // radius follows the local scale of the current transform
    const sc = Math.cbrt(Math.abs(_m.determinant()));
    _m2.makeBasis(_vx.multiplyScalar(r * sc), _vy.multiplyScalar(r * sc), _vz.multiplyScalar(len)).setPosition(_va);
    this.pushInst(this.part.struts, _m2, st);
  }

  /**
   * Lattice beam: `w` x `h` section, `bays` bays, member radius r. Hero LOD: instanced longerons, battens and
   * diagonals; far LOD: longerons only.
   */
  truss(ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number, bays: number, r: number, st: Style = H.truss, h = w): void {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return;
    // section axes: p perpendicular to the beam (stable choice), q = dir x p
    _vz.set(dx / len, dy / len, dz / len);
    if (Math.abs(_vz.y) < 0.99) _vx.set(0, 1, 0).cross(_vz).normalize();
    else _vx.set(1, 0, 0).cross(_vz).normalize();
    _vy.crossVectors(_vz, _vx);
    const px = _vx.x * (w / 2);
    const py = _vx.y * (w / 2);
    const pz = _vx.z * (w / 2);
    const qx = _vy.x * (h / 2);
    const qy = _vy.y * (h / 2);
    const qz = _vy.z * (h / 2);
    const cx = [px + qx, px - qx, -px - qx, -px + qx];
    const cy = [py + qy, py - qy, -py - qy, -py + qy];
    const cz = [pz + qz, pz - qz, -pz - qz, -pz + qz];
    for (let c = 0; c < 4; c++) this.strut(ax + cx[c], ay + cy[c], az + cz[c], bx + cx[c], by + cy[c], bz + cz[c], r * 1.35, st);
    if (!this.hero) return;
    for (let i = 0; i <= bays; i++) {
      const t0 = i / bays;
      const x0 = ax + dx * t0;
      const y0 = ay + dy * t0;
      const z0 = az + dz * t0;
      for (let c = 0; c < 4; c++) {
        const n = (c + 1) % 4;
        this.strut(x0 + cx[c], y0 + cy[c], z0 + cz[c], x0 + cx[n], y0 + cy[n], z0 + cz[n], r, st);
        if (i < bays) {
          const t1 = (i + 1) / bays;
          const x1 = ax + dx * t1;
          const y1 = ay + dy * t1;
          const z1 = az + dz * t1;
          if ((i + c) & 1) this.strut(x0 + cx[c], y0 + cy[c], z0 + cz[c], x1 + cx[n], y1 + cy[n], z1 + cz[n], r, st);
          else this.strut(x0 + cx[n], y0 + cy[n], z0 + cz[n], x1 + cx[c], y1 + cy[c], z1 + cz[c], r, st);
        }
      }
    }
  }

  /** One cargo container (CRATE box, long axis along local Z) at a local position; instanced. */
  crate(x: number, y: number, z: number, tint: RGB, ry = 0): void {
    this.b.currentMatrix(_m);
    _m2.makeRotationY(ry).setPosition(x, y, z);
    _m.multiply(_m2);
    this.pushInst(this.part.crates, _m, CRATE_STYLE, tint);
  }

  /**
   * Block of stacked containers filling nx x ny x nz cells from the local origin (+X, +Y, +Z), long axis
   * along Z. `fill` is the occupancy; the outermost layers are ragged. Far LOD: one box.
   */
  crateBlock(nx: number, ny: number, nz: number, fill = 0.85, seed = 1): void {
    const gx = CRATE[0] + 0.5;
    const gy = CRATE[1] + 0.35;
    const gz = CRATE[2] + 1.2;
    if (!this.hero) {
      const w = nx * gx;
      const h = ny * gy * (0.6 + 0.4 * fill);
      const d = nz * gz;
      this.b.at(w / 2, h / 2, d / 2, () => this.b.box(w, h, d, H.tankB));
      return;
    }
    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        // column height: full inside, ragged at the top
        const hCol = Math.round(ny * (fill > 0.99 ? 1 : Math.min(1, fill * (0.55 + 0.9 * hsh(ix, iz, seed)))));
        const run = hsh(ix >> 1, iz, seed + 7);
        for (let iy = 0; iy < hCol; iy++) {
          // only the visible shell of the block is instanced
          if (ix > 0 && ix < nx - 1 && iz > 0 && iz < nz - 1 && iy < hCol - 1 && iy > 0) continue;
          const r = hsh(ix + iy * 31, iz, seed + 3);
          const col = CRATE_COLORS[Math.floor((r < 0.5 ? run : r) * CRATE_COLORS.length) % CRATE_COLORS.length];
          const k = 0.7 + 0.6 * hsh(ix, iz + iy * 17, seed + 11);
          this.crate(ix * gx + gx / 2, iy * gy + gy / 2, iz * gz + gz / 2, [col[0] * k, col[1] * k, col[2] * k]);
        }
      }
    }
  }

  // ---------------------------------------------------------------- common modules

  /** Spherical tank with a girdle and two pipe stubs, centred on the local origin. */
  tankSphere(r: number, st: Style = H.tank): void {
    const b = this.b;
    b.sphere(r, st, this.hero ? 20 : 10);
    if (!this.hero) return;
    b.at(0, 0, 0, () => b.torus(r * 1.005, r * 0.035, H.steel, { segs: 20, tube: 4 }), Math.PI / 2);
    b.at(0, r * 0.96, 0, () => b.cyl(r * 0.16, r * 0.16, r * 0.12, H.metal, { segs: 8 }), -Math.PI / 2);
  }

  /** Capsule tank along local Z with strap hoops. */
  tankCapsule(r: number, len: number, st: Style = H.tank): void {
    const b = this.b;
    b.capsule(r, len, st, this.hero ? 16 : 8, 0.7);
    if (!this.hero) return;
    for (const z of [-0.33, 0, 0.33]) b.at(0, 0, z * len - r * 0.06, () => b.ring(r * 0.99, r * 1.05, r * 0.12, H.steel, { segs: 16, bevel: 0.05 }));
  }

  /** Dish antenna on a pedestal standing on the local XZ plane, aimed `tilt` rad off +Y toward +Z. */
  dishMast(R: number, mast: number, tilt: number, yaw = 0): void {
    const b = this.b;
    b.at(0, 0, 0, () => b.cyl(R * 0.09, R * 0.07, mast, H.steel, { segs: 6 }), -Math.PI / 2);
    b.at(
      0,
      mast + R * 0.1,
      0,
      () => {
        b.sphere(R * 0.14, H.metal, 8);
        b.at(0, R * 0.1, 0, () => b.dish(R, R * 0.28, H.p1, H.p2, H.steel), tilt);
      },
      0,
      yaw,
    );
  }

  /**
   * A docking berth, built in the port frame from BERTHS[size]: deck plate with markings, docking arm and
   * collar, lit approach frame with a backlit number sign, and two booms of guide lights. Every lamp carries
   * the port index so the active port can pulse.
   */
  berth(p: DockingPortDef, index: number): void {
    const b = this.b;
    const B = BERTHS[p.size];
    const so = B.standoff;
    const h = B.plate;
    const fh = B.frame;
    const fo = B.frameOut;
    const ra = B.arm;
    const tb = p.size === 'S' ? 1.3 : p.size === 'M' ? 2.0 : 2.8;
    const port = index + 1;
    const hero = this.hero;
    this.portFrame(p, () => {
      // deck plate
      b.at(0, -so, 0, () => {
        this.slab(2 * h, 3, 2 * h, H.deck, H.s1, 8, 0.5);
        if (hero) {
          const paint = decalStyle([0.74, 0.72, 0.66], 0.92);
          const warn = decalStyle([0.78, 0.5, 0.05], 0.95);
          const sw = h * 0.085;
          const n = Math.max(2, Math.round((2 * h - 2 * sw) / (3 * sw)));
          const tile = (2 * h - 2 * sw) / n;
          for (let e = 0; e < 4; e++) {
            b.at(0, 0, 0, () => {
              for (let i = 0; i < n; i++) b.at(-h + sw + tile * (i + 0.5), 0, h - sw * 0.9, () => b.decal(tile, sw, decalIconRect('hazard'), warn, 0.3));
            }, 0, (e * Math.PI) / 2);
          }
          b.decal(h * 1.05, h * 1.05, decalIconRect('dockTarget'), paint, 0.3);
          b.at(0, 0, h * 0.66, () => this.text(p.id, h * 0.3, paint, 0.3));
          b.at(0, 0, -h * 0.66, () => this.text(p.id, h * 0.3, paint, 0.3), 0, Math.PI);
          // recessed edge lights
          const el = lit(COOL, 3.2);
          for (let e = 0; e < 4; e++) b.at(0, 0, 0, () => b.at(0, 0.12, h * 0.8, () => b.box(h * 1.3, 0.25, h * 0.022 + 0.25, el)), 0, (e * Math.PI) / 2);
        }
      });
      // docking arm and collar
      b.between(0, -so, 0, 0, -ra * 0.5, 0, (len) => {
        b.cyl(ra * 1.25, ra, len * 0.35, H.s0, { segs: 12, capA: false, capB: false });
        b.at(0, 0, len * 0.35, () => b.cyl(ra, ra, len * 0.65, H.metal, { segs: 12, capA: false, capB: false }));
        if (hero) b.at(0, 0, len * 0.6, () => b.ring(ra, ra * 1.25, ra * 0.5, H.steel, { segs: 12, bevel: 0.1 }));
      });
      b.between(0, -ra * 0.5, 0, 0, 0, 0, (len) => {
        b.ring(ra * 0.62, ra * 1.5, len, H.s0, { segs: hero ? 20 : 10, bevel: 0.12 });
        b.at(0, 0, len * 0.55, () => b.ring(ra * 1.5, ra * 1.72, len * 0.4, lit(CYAN, 4.5), { segs: hero ? 20 : 10, bevel: 0.05 }));
      });
      if (hero) for (let e = 0; e < 4; e++) b.at(0, 0, 0, () => this.b.strut(h * 0.42, -so, h * 0.42, ra * 0.8, -so * 0.45, ra * 0.8, tb * 0.22, H.steel, 4), 0, (e * Math.PI) / 2);
      // approach frame: four beams with light strips, corner posts down to the deck
      const strip = lit(COOL, 5);
      for (let e = 0; e < 4; e++) {
        b.at(0, 0, 0, () => {
          b.at(0, fo, fh, () => {
            b.box(2 * fh + tb, tb, tb, H.s0, { bevel: tb * 0.12 });
            b.at(0, tb * 0.52, 0, () => b.box(2 * fh - tb * 2, tb * 0.08, tb * 0.42, strip));
            if (hero) b.at(0, 0, -tb * 0.52, () => b.box(2 * fh - tb * 2, tb * 0.42, tb * 0.08, strip));
          });
          b.strut(h, -so, h, fh, fo, fh, tb * 0.36, H.steel, 4);
          this.lamp(fh, fo + tb, fh, COOL, 12, tb * 1.6, { port, phase: 0.92 });
          if (hero) {
            for (const t of [-0.5, 0, 0.5]) this.lamp(t * fh, fo + tb * 0.7, fh, COOL, 8, tb * 0.9, { port, phase: 0.92 });
            this.flood(fh * 0.96, fo, fh * 0.96, 0, -so, 0, fh * 3.4 + so, 1.5, 48, false);
          }
        }, 0, (e * Math.PI) / 2);
      }
      // backlit number sign over the frame's top beam (toward the port's up)
      const sh = p.size === 'S' ? 5 : p.size === 'M' ? 8 : 11;
      b.at(0, fo, -(fh + tb + sh * 0.8), () => {
        b.at(0, -0.6, 0, () => b.box(sh * 2.3, 1, sh * 1.5, H.s1, { bevel: 0.2 }));
        b.box(sh * 2.1, 0.3, sh * 1.3, lit(WHITE, 2.6));
        if (hero) b.at(0, 0.16, 0, () => this.text(p.id, sh, decalStyle([0.012, 0.014, 0.018], 1), 0.25));
      });
      if (hero) {
        b.strut(-sh * 0.8, fo, -(fh + tb * 0.5), -sh * 0.8, fo - 0.6, -(fh + tb + sh * 0.3), tb * 0.2, H.steel, 4);
        b.strut(sh * 0.8, fo, -(fh + tb * 0.5), sh * 0.8, fo - 0.6, -(fh + tb + sh * 0.3), tb * 0.2, H.steel, 4);
      }
      // guide booms: lamps chase inward along the approach when the port is active
      const nl = p.size === 'S' ? 4 : p.size === 'M' ? 6 : 8;
      for (const sx of [-1, 1]) {
        b.strut(sx * fh, fo, 0, sx * fh, fo + B.boom, 0, tb * 0.24, H.steel, 3);
        if (hero) {
          b.strut(sx * fh, fo + B.boom * 0.45, 0, sx * fh, fo, fh * 0.5, tb * 0.14, H.steel, 3);
          b.strut(sx * fh, fo + B.boom * 0.45, 0, sx * fh, fo, -fh * 0.5, tb * 0.14, H.steel, 3);
        }
        for (let i = 0; i < nl; i++) {
          const t = (i + 1) / nl;
          this.lamp(sx * fh, fo + B.boom * t, 0, AMBER, 11, tb * 1.1, { port, phase: 0.85 * (1 - t) });
        }
      }
    });
  }

  /** All berths of the layout, into the current part. */
  berths(): void {
    this.layout.ports.forEach((p, i) => this.berth(p, i));
  }
}

const CRATE_STYLE = hs(LAYER.ribbed, [0.5, 0.5, 0.5], 0.3, 0.6, { wear: 0.5, grime: 0.7 });

// ================================================================================================ ring habitat

function buildRingHabitat(k: Kit): void {
  const D = RING_HABITAT;
  const hub = k.newPart('hub', 0);
  const ring = k.newPart('ring', D.spin);
  const rnd = k.rnd;
  const hero = k.hero;

  // ------------------------------------------------------------ de-spun hub
  k.use(hub, () => {
    const b = k.b;
    const pl = plating([H.p0, H.p0, H.p1, H.p2], 3, 1, 11 + k.seed);
    const dk = plating([H.s0, H.s1, H.s0], 2, 1, 5);
    // axle through the rotor sleeve and the two bearing housings
    k.revolve(subdiv([52, -52, 52, -40, 40, -36, 40, 36, 52, 40, 52, 52], 14), dk, { segs: 48 });
    for (const s of [1, -1]) {
      const sec = (pts: number[]): number[] => (s > 0 ? pts : flipProfile(pts));
      k.revolve(sec([52, 52, 44, 58, 34, 66, 34, 92, 46, 100, 60, 106, D.drumR, D.drumY0]), pl, { segs: 48 });
      const wallP = sec(subdiv([D.drumR, 110, D.drumR, 114, D.drumR, 176, D.drumR, 180, D.drumR, 186, D.drumR, 190], 9));
      const wall = k.revolve(
        wallP,
        (u, v, qi, qj) => {
          const y = Math.abs(wallP[qj * 2 + 1] + wallP[qj * 2 + 3]) / 2;
          if (y < 114 || y > 186) return H.s0;
          if (y > 176 && y < 180) return H.ac;
          return (pl as (u: number, v: number, qi: number, qj: number) => Style)(u, v, qi, qj);
        },
        { segs: 72 },
      );
      k.revolve(sec(subdiv([D.drumR, 190, 60, 194, 40, 200, 28, 214, 28, 232, 24, 236, 0, 236], 14)), pl, { segs: 48 });
      // window bands round the drum
      for (const [y0, y1] of [
        [117, 124],
        [127, 134],
        [158, 165],
        [168, 175],
      ]) {
        k.revolve(s > 0 ? [D.drumR + 0.45, y0, D.drumR + 0.45, y1] : [D.drumR + 0.45, -y1, D.drumR + 0.45, -y0], s > 0 ? WIN.hab : WIN.habCool, { segs: 72 });
      }
      k.revolve(s > 0 ? [34.4, 70, 34.4, 88] : [34.4, -88, 34.4, -70], WIN.small, { segs: 48 });
      if (hero) {
        // longitudinal ribs between the berths, flange rings, a ring of lamps on each drum edge
        for (let i = 0; i < 12; i++) k.polar((i * 30 + 15) * DEG, D.drumR - 0.4, s * 150, () => b.block(2.6, 2.2, 78, H.s1, { bevel: 0.4 }));
        for (const y of [110, 190]) {
          for (let i = 0; i < 24; i++) k.polar(i * 15 * DEG, D.drumR + 1.2, s * y, () => k.lamp(0, 0, 0, WARM2, 6, 2.2));
        }
        for (let i = 0; i < 8; i++) k.polar(i * 45 * DEG, 28, s * 223, () => b.block(1.6, 9, 16, H.s0, { taperX: 1, taperZ: 0.4, bevel: 0.2 }));
        // station name, three times round the north drum between the berths
        if (s > 0 && k.name) {
          const hgt = Math.min(8.5, 82 / (k.name.length * 0.72));
          for (const az of [60, 180, 300]) k.textOn(wall, k.uAz(az * DEG), (146 - 110) / 80, k.name, hgt, decalStyle([0.02, 0.022, 0.026], 0.9));
        }
      }
      // floodlights washing the drum walls from the shoulder
      for (let i = 0; i < 6; i++) {
        const az = (i * 60 + 30) * DEG;
        k.flood(Math.cos(az) * 76, s * 200, -Math.sin(az) * 76, Math.cos(az) * 64, s * 150, -Math.sin(az) * 64, 110, 1.1, 56, hero);
      }
    }
    // neck tanks: spheres to the north, foil-wrapped capsules to the south
    const nt = 6;
    for (let i = 0; i < nt; i++) {
      const az = (i * 360) / nt + 30;
      k.polar(az * DEG, 46, 79, () => k.tankSphere(10.5, i % 3 === 0 ? H.tankB : H.tank));
      k.polar(az * DEG, 43, -79, () => b.at(0, 0, 0, () => k.tankCapsule(7, 11, i % 2 ? H.foil : H.foilS)));
      if (hero) {
        k.polar(az * DEG, 34, 79, () => b.strut(0, 0, 0, 0, 3, 0, 1.2, H.steel, 4));
        k.lamp(Math.cos(az * DEG) * 57, 79, -Math.sin(az * DEG) * 57, WARM2, 5, 2);
      }
    }
    // antenna farm on the north shoulder (inside the layout's collider spheres)
    for (const az of [60, 180, 300]) {
      k.polar(az * DEG, 50, 196, () => b.at(0, 0, 0, () => k.dishMast(12.5, 9, 0.5 + rnd() * 0.5, (rnd() - 0.5) * 1.2), Math.PI / 2));
      k.beacon(Math.cos(az * DEG) * 50, 226, -Math.sin(az * DEG) * 50, RED, 2.6, az / 360, 6);
    }
    // radiator vanes on the south drum, hot at the root
    for (const az of D.vaneAz) {
      k.polar(az, D.drumR + 1, -150, () => {
        const len = D.vaneR1 - D.drumR - 1;
        const np = 4;
        for (let i = 0; i < np; i++) {
          const y0 = 5 + (i * (len - 5)) / np;
          const y1 = 5 + ((i + 1) * (len - 5)) / np - 2;
          b.at(0, y0, 0, () => b.at(0, 0, 0, () => k.wall(72, y1 - y0, 1.6, (_u, v) => RAD[Math.max(1, Math.min(5, Math.round(5.2 - (i + v) * 1.05)))], 4, 3), 0, Math.PI / 2, 0));
        }
        k.truss(0, 0, 0, 0, len, 0, 5, hero ? 12 : 4, 0.45, H.steel);
        if (hero) {
          for (const z of [-36.5, 36.5]) b.strut(0, 4, z, 0, len, z, 0.7, H.steel, 4);
          b.at(0, 2.5, 0, () => b.box(5, 5, 74, H.s1, { bevel: 0.5 }));
        }
      });
      k.beacon(Math.cos(az) * (D.vaneR1 + 1), -150, -Math.sin(az) * (D.vaneR1 + 1), WHITE, 3.2, 0.4, 6);
    }
    k.berths();
  });

  // ------------------------------------------------------------ the rotating ring
  k.use(ring, () => {
    const b = k.b;
    const ri = D.ringInner;
    const ro = D.ringOuter;
    const hw = D.ringHalfWidth;
    const ch = 8; // chamfer
    const SEG = 144;
    // closed section: up the outer face, across the north side, down the inner face, back across the south side
    const prof = [
      ro, -hw + ch, ro, -10, ro, 10, ro, hw - ch, // outer rim (3 strips)
      ro - ch, hw, ro - 11, hw, ro - 15, hw, ri + ch, hw, // north side with the livery stripe
      ri, hw - ch, ri, 10, ri, -10, ri, -hw + ch, // inner face (3 strips)
      ri + ch, -hw, ro - 15, -hw, ro - 11, -hw, ro - ch, -hw, // south side
    ];
    const outerPl = plating([H.tile, H.tile, H.tileB, H.a2], 4, 1, 3 + k.seed);
    const sidePl = plating([H.p0, H.p0, H.p1, H.p2], 4, 1, 17 + k.seed);
    const innerPl = plating([H.p0, H.p1, H.p1, H.p2], 2, 1, 29 + k.seed);
    const st = (f: StyleFn, u: number, v: number, qi: number, qj: number): Style => (f as (u: number, v: number, qi: number, qj: number) => Style)(u, v, qi, qj);
    const body = k.revolve(
      prof,
      (u, v, qi, qj) => {
        if (qj < 3) return st(outerPl, u, v, qi, qj);
        if (qj === 3 || qj === 15) return H.s0;
        if (qj === 5 || qj === 13) return H.ac;
        if (qj === 7 || qj === 11) return H.s0;
        if (qj >= 8 && qj <= 10) return st(innerPl, u, v, qi, qj);
        return st(sidePl, u, v, qi, qj);
      },
      { segs: SEG, closed: true, crease: 0.5 },
    );

    // greenhouse sectors on the inner face (seeded), city windows everywhere else
    const nGreen = 3 + Math.floor(rnd() * 2);
    const greenSpan = (nGreen === 3 ? 44 : 34) * DEG;
    const green0 = rnd() * TAU;
    const sectorAz = (i: number): number => green0 + (i * TAU) / nGreen;
    for (let i = 0; i < nGreen; i++) {
      const a0 = sectorAz(i) - greenSpan / 2;
      const a1 = sectorAz(i) + greenSpan / 2;
      // glazed barrel vault standing off the roof, running +y -> -y so it faces the hub
      const vault: number[] = [];
      for (let t = 0; t <= 8; t++) {
        const a = (t / 8) * Math.PI;
        vault.push(ri - 0.6 - Math.sin(a) * 9, Math.cos(a) * 27);
      }
      k.revolve(vault, WIN.green, { segs: SEG, az0: a0, az1: a1, uRef: ri - 6, crease: 1.4 });
      // gable frames at both ends and ribs along the vault
      const ribs = hero ? 5 : 1;
      for (let r = 0; r <= ribs; r++) {
        const az = a0 + ((a1 - a0) * r) / ribs;
        const end = r === 0 || r === ribs;
        const half = (end ? 2.2 : 0.9) / ri;
        const rr = end ? 11.5 : 10;
        b.loft({
          ts: [0, 1],
          K: 10,
          ring: (t, out) => {
            const a = Math.PI / 2 - (az + (t - 0.5) * 2 * half);
            for (let q = 0; q < 10; q++) {
              const w = q < 9 ? (q / 8) * Math.PI : 0;
              const r0 = q < 9 ? ri - 0.3 - Math.sin(w) * rr : ri + 2;
              const y0 = q < 9 ? Math.cos(w) * (end ? 29 : 27.6) : 0;
              out[q * 3] = r0 * Math.sin(a);
              out[q * 3 + 1] = y0;
              out[q * 3 + 2] = -r0 * Math.cos(a);
            }
          },
          style: H.s0,
          capStart: H.s0,
          capEnd: H.s0,
          crease: 0.4,
        });
      }
      // city windows between this greenhouse and the next
      const c0 = a1 + 2.2 / ri;
      const c1 = sectorAz(i + 1) - greenSpan / 2 - 2.2 / ri + (i === nGreen - 1 ? 0 : 0);
      const cEnd = i === nGreen - 1 ? sectorAz(0) + TAU - greenSpan / 2 - 2.2 / ri : c1;
      for (const [y0, y1, w] of [
        [12, 26, WIN.hab],
        [-7, 7, WIN.habCool],
        [-26, -12, WIN.hab],
      ] as [number, number, Style][]) {
        k.revolve([ri - 0.45, y1, ri - 0.45, y0], w, { segs: SEG, az0: c0, az1: cEnd, uRef: ri });
      }
    }
    // windows on both side faces and a porthole row on the inner chamfers
    k.revolve([ro - 18, hw + 0.45, ri + ch + 2.5, hw + 0.45], WIN.hab, { segs: SEG, uRef: (ri + ro) / 2 });
    k.revolve([ri + ch + 2.5, -hw - 0.45, ro - 18, -hw - 0.45], WIN.hab, { segs: SEG, uRef: (ri + ro) / 2 });

    // sector bulkheads: 36 frames standing proud of the section
    const frame = [ro + 2.6, -hw + ch - 1, ro + 2.6, hw - ch + 1, ro - ch + 1.5, hw + 2.6, ri + ch - 1.5, hw + 2.6, ri - 2.6, hw - ch + 1, ri - 2.6, -hw + ch - 1, ri + ch - 1.5, -hw - 2.6, ro - ch + 1.5, -hw - 2.6];
    const nSect = hero ? 36 : 12;
    for (let i = 0; i < nSect; i++) {
      const az = (i * TAU) / nSect;
      const half = 2.4 / ro;
      b.loft({
        ts: [0, 1],
        K: 8,
        ring: (t, out) => {
          const a = Math.PI / 2 - (az + (t - 0.5) * 2 * half);
          for (let q = 0; q < 8; q++) {
            out[q * 3] = frame[q * 2] * Math.sin(a);
            out[q * 3 + 1] = frame[q * 2 + 1];
            out[q * 3 + 2] = -frame[q * 2] * Math.cos(a);
          }
        },
        style: H.s1,
        capStart: H.s1,
        capEnd: H.s1,
        crease: 0.4,
      });
    }
    // rim rails with running lights
    for (const s of [1, -1]) {
      b.at(0, s * (hw - 3.2), 0, () => b.torus(ro - 3.2 + 2.4, 1.5, H.steel, { segs: SEG, tube: 5 }), -Math.PI / 2);
      const nLamp = hero ? 72 : 24;
      for (let i = 0; i < nLamp; i++) k.polar(((i + 0.5) * TAU) / nLamp, ro + 1.6, s * (hw - 3.2), () => k.lamp(0, 0.5, 0, i % 6 === 0 ? AMBER : WARM2, 7, i % 6 === 0 ? 3.4 : 2.4));
    }
    if (hero) {
      // raised shield plates and service blocks on the outer rim
      let perim = 0;
      for (let i = 0; i < prof.length; i += 2) perim += Math.hypot(prof[(i + 2) % prof.length] - prof[i], prof[(i + 3) % prof.length] - prof[i + 1]);
      for (let i = 0; i < 36; i++) {
        const u0 = (i + 0.12) / 36;
        const u1 = (i + 0.88) / 36;
        const which = hsh(i, 1, k.seed);
        if (which < 0.7) b.plateOn(body, u0, u1, 3 / perim, (which < 0.35 ? 38 : 57) / perim, { lift: 2.2, style: which < 0.2 ? H.a1 : H.tileB, nu: 3, nv: 2, bevel: 1.6 });
        if (which > 0.45 && k.rich) b.on(body, (i + 0.5) / 36, 49 / perim, () => b.greebles(44, 9, { styles: [H.s0, H.s1, H.metal, H.steel], cell: 5.5, height: 4.5, density: 0.5 }), 0.4);
      }
    }

    // rotor sleeve round the axle
    k.revolve(subdiv([46, -36, D.sleeveR, -32, D.sleeveR, 32, 46, 36], 12), plating([H.p1, H.p2, H.s0], 4, 1, 7), { segs: 60 });
    k.revolve([D.sleeveR + 0.4, -7.5, D.sleeveR + 0.4, 7.5], WIN.small, { segs: 60 });
    // spokes: lift shafts with lit windows, collars, a pair of stays each, and the mid stay ring
    const midR = 222;
    for (let i = 0; i < D.spokes; i++) {
      const az = D.spokeAz0 + (i * TAU) / D.spokes;
      const cx = Math.cos(az);
      const cz = -Math.sin(az);
      b.between(cx * (D.sleeveR - 2), 0, cz * (D.sleeveR - 2), cx * (ri + 1), 0, cz * (ri + 1), (len) => {
        b.cyl(7.5, 7.5, len, H.p1, { segs: hero ? 12 : 6, capA: false, capB: false });
        b.at(0, 7.9, len / 2, () => k.winPanel(3, len * 0.94, WIN.lift));
        b.at(0, -7.9, len / 2, () => k.winPanel(3, len * 0.94, WIN.lift), Math.PI);
        // root fairing and ring-side foot
        b.cyl(13, 7.5, 26, H.s0, { segs: hero ? 12 : 6, capA: false, capB: false });
        b.at(0, 0, len - 22, () => b.cyl(7.5, 15, 22, H.s0, { segs: hero ? 12 : 6, capA: false, capB: false }));
        if (hero) {
          for (let c = 1; c < 8; c++) b.at(0, 0, (len * c) / 8, () => b.ring(7.5, 9.2, 3.5, H.s1, { segs: 12, bevel: 0.3 }));
          for (let c = 0; c < 16; c++) {
            const z = (len * (c + 0.5)) / 16;
            k.lamp(8.4, 0, z, WARM2, 6, 2);
            k.lamp(-8.4, 0, z, WARM2, 6, 2);
          }
          k.flood(0, 30, len - 60, 0, 0, len, 120, 1.2, 50, false);
          k.flood(0, -30, len - 60, 0, 0, len, 120, 1.2, 50, false);
        }
      });
      for (const sy of [1, -1]) {
        b.strut(cx * 60, sy * 30, cz * 60, cx * (ri + 3), sy * (hw - 6), cz * (ri + 3), 0.8, H.steel, 4);
        if (hero) b.strut(cx * midR, 0, cz * midR, cx * (ri + 3), sy * (hw - 6), cz * (ri + 3), 0.55, H.steel, 4);
      }
      // node on the mid stay ring
      k.polar(az, midR, 0, () => {
        b.at(0, 0, 0, () => b.box(24, 13, 18, H.p2, { bevel: 1.2 }));
        b.at(0, 0, 9.4, () => k.winPanel(20, 6, WIN.small), Math.PI / 2);
        b.at(0, 0, -9.4, () => k.winPanel(20, 6, WIN.small), -Math.PI / 2);
      });
      k.beacon(cx * (ro + 4), 0, cz * (ro + 4), i % 2 ? WHITE : RED, 3, i / D.spokes, 7);
    }
    b.at(0, 0, 0, () => b.torus(midR, 2.2, H.steel, { segs: 96, tube: 5 }), -Math.PI / 2);
    if (hero) {
      for (let i = 0; i < 72; i++) k.polar((i * TAU) / 72, midR, 0, () => k.lamp(0, 0, 2.6, COOL, 5, 1.8));
    }
  });
}

// ================================================================================================ outpost

/**
 * Frontier outpost, built to the OUTPOST dimensions the colliders use: a truss spine along +Y, a docking node at
 * the origin with the two berths on its +-Z faces, habitat cans along X, a second pair of cans higher up,
 * solar wings, radiators, a propellant sphere and an antenna farm on top.
 */
function buildOutpost(k: Kit): void {
  const D = OUTPOST;
  const core = k.newPart('core', 0);
  const hero = k.hero;
  const seg = hero ? 14 : 8;
  k.use(core, () => {
    const b = k.b;
    /** Window strips on four sides of a can built in a `between` frame (axis along local Z). */
    const strips = (r: number, len: number, st: Style): void => {
      const d = len * 0.8;
      b.at(0, r, len / 2, () => k.winPanel(3, d, st));
      b.at(0, -r, len / 2, () => k.winPanel(3, d, st), Math.PI);
      b.at(r, 0, len / 2, () => k.winPanel(3, d, st), 0, 0, -Math.PI / 2);
      b.at(-r, 0, len / 2, () => k.winPanel(3, d, st), 0, 0, Math.PI / 2);
    };
    const can = (ax: number, y: number, bx: number, r: number, st: Style, win: Style): void => {
      b.between(ax, y, 0, bx, y, 0, (len) => {
        b.cyl(r, r, len, st, { segs: seg, bevel: 0.5 });
        strips(r + 0.2, len, win);
        if (hero) for (const f of [0.06, 0.94]) b.at(0, 0, len * f, () => b.ring(r, r + 0.7, 1.4, H.s1, { segs: seg, bevel: 0.2 }));
      });
    };

    // spine
    k.truss(0, -D.trussHalf + 4, 0, 0, D.trussHalf - 6, 0, 7, 16, 0.4);
    // docking node: the berth decks sit on its +-Z faces
    b.at(0, 0, 0, () => b.box(22, 20, 19, H.p2, { bevel: 1.2 }));
    b.at(0, 13, 0, () => b.box(12, 6, 12, H.s1, { bevel: 0.8 }));
    b.at(0, -13, 0, () => b.box(12, 6, 12, H.s1, { bevel: 0.8 }));
    // habitat cans along X, and the second pair higher up the truss
    for (const s of [1, -1]) can(s * 10, 0, s * D.habHalf, 6.6, H.p0, WIN.small);
    can(-D.canHalf, D.canY, D.canHalf, 6, H.p1, WIN.hab);
    b.at(0, D.canY, 0, () => b.box(9, 9, 13.4, H.s0, { bevel: 0.6 }));

    // solar wings: four panels a side on a boom, faces toward +-Z
    for (const s of [1, -1]) {
      b.strut(s * 3, D.wingY, 0, s * D.wingReach, D.wingY, 0, 0.55, H.steel, 6);
      const span = (D.wingReach - 12) / 4;
      for (let i = 0; i < 4; i++) {
        b.at(s * (12 + span * (i + 0.5)), D.wingY, 0.7, () => b.box(span - 1, 15, 0.3, H.solar));
        if (hero) b.strut(s * (12 + span * i), D.wingY - 7.5, 0.3, s * (12 + span * i), D.wingY + 7.5, 0.3, 0.25, H.steel, 4);
      }
      k.beacon(s * (D.wingReach + 1), D.wingY, 0, RED, 2.4, s > 0 ? 0 : 0.5, 6);
      // radiators, edge-on to the star
      b.strut(s * 3, D.radiatorY, 0, s * 32, D.radiatorY, 0, 0.45, H.steel, 6);
      b.at(s * 20, D.radiatorY, 0, () => b.box(23, 0.3, 12, H.s2));
    }

    // propellant sphere, antenna farm, lights
    b.at(0, D.tankY, 0, () => k.tankSphere(15));
    b.at(0, D.trussHalf - 6, 0, () => b.box(11, 2.5, 11, H.s1, { bevel: 0.4 }));
    b.at(0, D.trussHalf - 4.6, 0, () => k.dishMast(6, 5, 0.6, 0.8));
    if (hero) {
      b.at(3.6, D.trussHalf - 4.6, -3.4, () => k.dishMast(2.4, 3, 0.9, 3.6));
      for (let y = -D.trussHalf + 10; y < D.trussHalf - 8; y += 12) {
        k.lamp(3.9, y, 3.9, COOL, 5, 1.8);
        k.lamp(-3.9, y, -3.9, COOL, 5, 1.8);
      }
    }
    k.beacon(0, -D.trussHalf + 2, 0, WHITE, 2.4, 0.25, 6);
    for (const s of [1, -1]) {
      k.flood(0, D.canY - 7, s * 7, 0, 2, s * 11, 70, 1.3);
      k.flood(0, -9, s * 12, 0, D.tankY, s * 9, 50, 1.0, 52, false);
    }
    k.berths();
  });
}

// ================================================================================================ registry

interface ArchetypeDef {
  build: (k: Kit) => void;
  /** hull texture scale: tile size is 4 m / uvScale for painted panels */
  uvScale: number;
  livery: Livery;
  /** radiance a fully floodlit white surface re-emits */
  flood: RGB;
  /** hull-material heat (radiators) */
  heat: number;
}

const ARCHETYPES: Record<StationVisualId, ArchetypeDef> = {
  ringHabitat: { build: buildRingHabitat, uvScale: 0.22, livery: { primary: [0.6, 0.61, 0.6], secondary: [0.1, 0.108, 0.125], accent: [0.72, 0.36, 0.05] }, flood: [1.0, 0.93, 0.8], heat: 0.5 },
  spindle: { build: buildRingHabitat, uvScale: 0.22, livery: { primary: [0.5, 0.51, 0.52], secondary: [0.09, 0.095, 0.11], accent: [0.05, 0.42, 0.45] }, flood: [1.0, 0.93, 0.8], heat: 0.5 },
  refinery: { build: buildRingHabitat, uvScale: 0.22, livery: { primary: [0.33, 0.32, 0.3], secondary: [0.085, 0.085, 0.09], accent: [0.62, 0.4, 0.04] }, flood: [1.0, 0.72, 0.36], heat: 0.62 },
  outpost: { build: buildOutpost, uvScale: 0.5, livery: { primary: [0.55, 0.54, 0.5], secondary: [0.12, 0.125, 0.14], accent: [0.6, 0.2, 0.05] }, flood: [1.0, 0.9, 0.75], heat: 0.45 },
  drydock: { build: buildRingHabitat, uvScale: 0.22, livery: { primary: [0.42, 0.43, 0.45], secondary: [0.1, 0.105, 0.115], accent: [0.66, 0.44, 0.04] }, flood: [1.0, 0.95, 0.86], heat: 0.4 },
  citadel: { build: buildRingHabitat, uvScale: 0.2, livery: { primary: [0.2, 0.21, 0.23], secondary: [0.07, 0.072, 0.08], accent: [0.6, 0.08, 0.04] }, flood: [0.82, 0.9, 1.0], heat: 0.4 },
};

/** Default liveries by archetype (used when the caller does not pass a faction livery). */
export const STATION_LIVERIES: Record<StationVisualId, Livery> = {
  ringHabitat: ARCHETYPES.ringHabitat.livery,
  spindle: ARCHETYPES.spindle.livery,
  refinery: ARCHETYPES.refinery.livery,
  outpost: ARCHETYPES.outpost.livery,
  drydock: ARCHETYPES.drydock.livery,
  citadel: ARCHETYPES.citadel.livery,
};

// ================================================================================================ model building

export interface StationInstances {
  count: number;
  /** column-major 4x4 per instance */
  matrix: Float32Array;
  /** per-instance aTint / aSurf / aFx (hull material vertex format) */
  tint: Uint8Array;
  surf: Uint8Array;
  fx: Uint8Array;
}

export interface StationPartModel {
  name: string;
  /** rad/s about station +Y (0 = static) */
  spin: number;
  model: BuiltModel;
  crates: StationInstances | null;
  struts: StationInstances | null;
  triangles: number;
  drawCalls: number;
}

export interface StationModel {
  visualId: StationVisualId;
  /** 0 = hero, 1 = far */
  lod: 0 | 1;
  parts: StationPartModel[];
  triangles: number;
  drawCalls: number;
  buildMs: number;
}

export interface StationModelOptions {
  seed?: number;
  /** 0 = hero (default), 1 = cheap far LOD */
  lod?: 0 | 1;
  /** tessellation of the hero LOD, 0.55..1 (quality tiers lower it) */
  detail?: number;
  /** tertiary detail (default true for the hero LOD) */
  rich?: boolean;
  name?: string;
  /** bake ambient occlusion and floodlights (default true; tests switch it off for speed) */
  bake?: boolean;
}

const STRUT_TRIS = 8;
const CRATE_TRIS = 12;

function bakeFloods(model: BuiltModel, floods: readonly Flood[]): void {
  const g = model.geometries[CH_HULL];
  if (!g || floods.length === 0) return;
  const P = (g.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
  const N = (g.getAttribute('normal') as THREE.BufferAttribute).array as Float32Array;
  const F = (g.getAttribute('aFx') as THREE.BufferAttribute).array as Uint8Array;
  const n = P.length / 3;
  for (let i = 0; i < n; i++) {
    const e = floodAt(floods, P[i * 3], P[i * 3 + 1], P[i * 3 + 2], N[i * 3], N[i * 3 + 1], N[i * 3 + 2], true);
    F[i * 4 + 1] = Math.round(255 * Math.sqrt(Math.min(1, e / FLOOD_MAX)));
  }
}

function floodAt(floods: readonly Flood[], px: number, py: number, pz: number, nx: number, ny: number, nz: number, lambert: boolean): number {
  let e = 0;
  for (let f = 0; f < floods.length; f++) {
    const L = floods[f];
    const dx = px - L.x;
    const dy = py - L.y;
    const dz = pz - L.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > L.range * L.range || d2 < 1e-6) continue;
    const d = Math.sqrt(d2);
    const c = (dx * L.dx + dy * L.dy + dz * L.dz) / d;
    if (c <= L.cosOut) continue;
    let spot = (c - L.cosOut) / (L.cosIn - L.cosOut);
    spot = spot >= 1 ? 1 : spot * spot * (3 - 2 * spot);
    const ndl = lambert ? Math.max(0, (-(dx * nx + dy * ny + dz * nz) / d + 0.12) / 1.12) : 0.6;
    const q = d / L.range;
    const win = (1 - q * q) * (1 - q * q);
    const r0 = L.range * 0.33;
    e += (L.power * spot * ndl * win * 2) / (1 + (d * d) / (r0 * r0));
  }
  return e;
}

function finishInst(d: InstData, floods: readonly Flood[], bake: boolean): StationInstances | null {
  if (d.count === 0) return null;
  const fx = Uint8Array.from(d.fx);
  if (bake && floods.length) {
    for (let i = 0; i < d.count; i++) {
      const e = floodAt(floods, d.centre[i * 3], d.centre[i * 3 + 1], d.centre[i * 3 + 2], 0, 0, 0, false);
      fx[i * 4 + 1] = Math.round(255 * Math.sqrt(Math.min(1, e / FLOOD_MAX)));
    }
  }
  return { count: d.count, matrix: Float32Array.from(d.matrix), tint: Uint8Array.from(d.tint), surf: Uint8Array.from(d.surf), fx };
}

/**
 * Build the geometry of a station (no materials, no GPU work — also runs in node for tests).
 * Deterministic in (visualId, seed, lod, detail, rich, name).
 */
export function buildStationModel(visualId: StationVisualId, opts: StationModelOptions = {}): StationModel {
  const def = ARCHETYPES[visualId];
  if (!def) throw new Error(`unknown station archetype: ${visualId}`);
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const lod = opts.lod ?? 0;
  const detail = lod === 1 ? 0.3 : Math.min(1, Math.max(0.55, opts.detail ?? 1));
  const k = new Kit(visualId, detail, Math.abs(Math.floor(opts.seed ?? 0)), lod === 0 && (opts.rich ?? true), cleanName(opts.name ?? ''), def.uvScale);
  def.build(k);
  const bake = opts.bake ?? true;
  const radius = k.layout.radius;
  const parts: StationPartModel[] = [];
  let triangles = 0;
  let drawCalls = 0;
  for (const p of k.parts) {
    if (bake) p.b.bakeAO(0.7, Math.max(lod === 1 ? 6 : 1.2, radius / (lod === 1 ? 60 : 105)));
    const model = p.b.build([0, 0, 0]);
    if (bake) bakeFloods(model, p.floods);
    const fl = model.geometries[CH_FLARE];
    if (fl && fl.boundingSphere) fl.boundingSphere.radius += 70; // sprites extend beyond their anchors
    const crates = finishInst(p.crates, p.floods, bake);
    const struts = finishInst(p.struts, p.floods, bake);
    let calls = 0;
    for (const g of model.geometries) if (g) calls++;
    if (crates) calls++;
    if (struts) calls++;
    const tris = model.triangles + (crates ? crates.count * CRATE_TRIS : 0) + (struts ? struts.count * STRUT_TRIS : 0);
    parts.push({ name: p.name, spin: p.spin, model, crates, struts, triangles: tris, drawCalls: calls });
    triangles += tris;
    drawCalls += calls;
  }
  return { visualId, lod, parts, triangles, drawCalls, buildMs: (typeof performance !== 'undefined' ? performance.now() : 0) - t0 };
}

// ================================================================================================ station shaders

const WIN_VERT = /* glsl */ `
attribute vec4 aTint;
attribute vec4 aSurf;
attribute vec4 aFx;
varying vec3 vCol;
varying vec4 vP0;
varying vec4 vP1;
varying vec2 vWUv;
varying vec3 vVN;
varying vec3 vVP;
void main() {
  float I = aSurf.y * aSurf.y * 64.0;
  vCol = aTint.rgb * aTint.rgb * I;
  vP0 = vec4(max(aSurf.z, 0.004) * 64.0, max(aSurf.w, 0.004) * 64.0, aFx.x, aFx.y);
  vP1 = vec4(aTint.a, floor(aSurf.x * 255.0 + 0.5), aFx.z, aFx.w);
  vWUv = uv;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vVN = normalMatrix * normal;
  vVP = mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
}
`;

const WIN_FRAG = /* glsl */ `
varying vec3 vCol;
varying vec4 vP0;   // pitch u, pitch v (m), pane fill u, v
varying vec4 vP1;   // lit fraction, mode, seed, brightness spread
varying vec2 vWUv;
varying vec3 vVN;
varying vec3 vVP;
float wHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
// box-filtered coverage of a pane of width w centred in its cell; converges to w when cells go sub-pixel
float wCov(float x, float w, float fw) {
  float lo = 0.5 - 0.5 * w;
  float hi = 0.5 + 0.5 * w;
  float c = clamp((min(x + 0.5 * fw, hi) - max(x - 0.5 * fw, lo)) / fw, 0.0, 1.0);
  return mix(c, w, smoothstep(0.55, 1.3, fw));
}
void main() {
  vec2 c = vWUv / vP0.xy;
  vec2 id = floor(c);
  vec2 f = c - id;
  vec2 fw = clamp(fwidth(c), vec2(1e-4), vec2(8.0));
  float lodf = smoothstep(0.3, 1.0, max(fw.x, fw.y));
  float facing = clamp(dot(normalize(vVN), normalize(-vVP)), 0.0, 1.0);
  float pane = wCov(f.x, vP0.z, fw.x) * wCov(f.y, vP0.w, fw.y);
  vec3 col;
  float alpha;
  if (vP1.y < 0.5) {
    float r = wHash(id + vP1.z * 157.0);
    float r2 = fract(r * 61.7);
    float r3 = fract(r * 173.3);
    float on = step(r, vP1.x);
    float level = mix(1.0, 0.22 + 0.78 * r2, vP1.w);
    vec3 tint = mix(vec3(1.0), vec3(0.72, 0.9, 1.3), step(0.86, r3));
    tint = mix(tint, vec3(1.25, 0.72, 0.4), step(r3, 0.1));
    // close up: a brighter ceiling band and a mullion give the pane some interior
    float py = clamp((f.y - (0.5 - 0.5 * vP0.w)) / max(vP0.w, 1e-3), 0.0, 1.0);
    float inner = (0.7 + 0.5 * smoothstep(0.55, 0.8, py)) * (1.0 - 0.6 * smoothstep(0.035, 0.0, abs(fract(f.x * 2.0 + r2) - 0.5) - 0.0) * step(0.5, r2));
    inner = mix(inner, 1.0, smoothstep(0.02, 0.2, max(fw.x, fw.y)));
    float near = on * level * inner;
    float far = vP1.x * mix(1.0, 0.61, vP1.w);
    col = vCol * mix(tint, vec3(1.0, 0.99, 1.0), lodf) * (mix(near, far, lodf) * pane * (0.55 + 0.45 * facing));
    col += vec3(0.008, 0.01, 0.013) * pane;
    alpha = pane * 0.95;
  } else {
    // greenhouse glazing: crop bays under grow lights behind a frame grid
    vec2 bay = floor(c / vec2(5.0, 2.0));
    float pr = wHash(bay + vP1.z * 57.0 + 3.0);
    float p2 = fract(pr * 37.3);
    vec3 crop = mix(vec3(0.22, 0.62, 0.12), vec3(0.6, 0.86, 0.22), p2);
    crop = mix(crop, vec3(1.0, 0.3, 0.72), step(0.84, pr));
    crop = mix(crop, vec3(0.95, 0.98, 0.86), step(pr, 0.1));
    float rows = 0.72 + 0.28 * sin(c.y * 6.2832 * 2.0);
    rows = mix(rows, 0.72, smoothstep(0.08, 0.3, fw.y));
    float lamps = pow(max(0.0, sin(c.x * 6.2832)), 14.0);
    lamps = mix(lamps, 0.17, smoothstep(0.15, 0.6, fw.x));
    float level = 0.45 + 0.55 * p2;
    col = vCol * (crop * level * rows + vec3(1.0, 0.95, 0.85) * lamps * 0.9) * pane * (0.6 + 0.4 * facing);
    col += vec3(0.012, 0.014, 0.016) * (1.0 - pane);
    alpha = 1.0;
  }
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const LAMP_VERT = /* glsl */ `
attribute vec4 aTint;
attribute vec4 aSurf;
attribute vec4 aFx;
uniform float uTime;
uniform float uActive;
uniform float uPxAngle;
varying vec3 vLCol;
varying vec2 vLP;
void main() {
  float I = aSurf.y * aSurf.y * 64.0;
  float size = aFx.y * aFx.y * 64.0;
  float period = aSurf.z * 8.0;
  vec3 col = aTint.rgb * aTint.rgb;
  float on = 1.0;
  float port = floor(aFx.w * 32.0 + 0.5);
  if (port > 0.5) {
    if (abs(port - uActive) < 0.5) {
      // active berth: a green chase runs inward along the guide booms, the frame answers at the end
      float ph = fract(uTime * 0.8 - aSurf.w);
      on = 0.3 + 2.4 * smoothstep(0.34, 0.0, ph);
      col = mix(col, vec3(0.25, 1.0, 0.45), 0.8);
    } else on = 0.5;
  } else if (period > 0.01) {
    float ph = fract(uTime / period + aSurf.w);
    on = step(ph, max(0.02, aFx.z));
  }
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  float dist = max(1e-3, -mvPosition.z);
  // never smaller than the pixel grid can hold: dimmer instead (beacons keep a floor so they carry for kilometres)
  float beacon = step(0.5, aFx.x);
  float minSize = dist * uPxAngle * mix(1.5, 3.0, beacon);
  float drawn = max(size, minSize);
  float k = size / drawn;
  float gain = max(k * k, 0.3 * beacon);
  mvPosition.xy += uv * drawn;
  mvPosition.z = min(mvPosition.z + drawn * 0.9, -0.4);
  gl_Position = projectionMatrix * mvPosition;
  vLCol = col * (I * on * gain);
  vLP = uv;
}
`;

const LAMP_FRAG = /* glsl */ `
varying vec3 vLCol;
varying vec2 vLP;
void main() {
  float r2 = dot(vLP, vLP);
  float g = exp(-r2 * 22.0) + 0.1 * exp(-r2 * 4.5);
  g *= smoothstep(1.0, 0.6, sqrt(r2));
  gl_FragColor = vec4(vLCol * g, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ================================================================================================ factory

export interface StationVisualOptions {
  seed: number;
  quality: HullQuality;
  /** faction livery; defaults to STATION_LIVERIES[visualId] */
  livery?: Livery;
  /** painted on the hull where the archetype has a name plate (A-Z, 0-9, space, - . /) */
  name?: string;
  /** 'auto' (default) switches by distance; 'hero' / 'far' pin one level (harness, menus) */
  lod?: 'auto' | 'hero' | 'far';
}

export interface StationUpdateCtx {
  /** seconds since the last update (clamped internally, so time-warp does not blur the rotors) */
  dt: number;
  /** sim time, s (only its value at the first update matters: it sets the phase of rotors and blinkers) */
  time: number;
  /** id of the port whose guide lights should pulse (the player's assigned berth), if any */
  activePortId?: string | null;
}

export interface StationVisual {
  object3d: THREE.Object3D;
  layout: StationLayout;
  update(ctx: StationUpdateCtx): void;
  dispose(): void;
  /** per built LOD: triangles, draw calls and CPU build time */
  stats: { lod: number; triangles: number; drawCalls: number; buildMs: number }[];
}

function unitStrut(): THREE.BufferGeometry {
  const b = new MeshBuilder({ seed: 5, uvScale: 1 });
  b.strut(0, 0, 0, 0, 0, 1, 1, H.truss, 4);
  const g = b.build([0, 0, 0]).geometries[CH_HULL] as THREE.BufferGeometry;
  // texture metres along the member are unknown until it is scaled: a few repeats of brushed metal do
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * 6);
  return g;
}

function unitCrate(): THREE.BufferGeometry {
  const b = new MeshBuilder({ seed: 6, uvScale: 0.55 });
  b.box(CRATE[0], CRATE[1], CRATE[2], CRATE_STYLE, { swapUV: true });
  return b.build([0, 0, 0]).geometries[CH_HULL] as THREE.BufferGeometry;
}

function instancedMesh(base: THREE.BufferGeometry, d: StationInstances, material: THREE.Material): THREE.InstancedMesh {
  const g = new THREE.BufferGeometry();
  g.setIndex(base.getIndex());
  g.setAttribute('position', base.getAttribute('position'));
  g.setAttribute('normal', base.getAttribute('normal'));
  g.setAttribute('uv', base.getAttribute('uv'));
  g.setAttribute('aTint', new THREE.InstancedBufferAttribute(d.tint, 4, true));
  g.setAttribute('aSurf', new THREE.InstancedBufferAttribute(d.surf, 4, true));
  g.setAttribute('aFx', new THREE.InstancedBufferAttribute(d.fx, 4, true));
  const mesh = new THREE.InstancedMesh(g, material, d.count);
  mesh.instanceMatrix.array.set(d.matrix);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}

const _size = new THREE.Vector2();

export function createStationVisual(visualId: StationVisualId, opts: StationVisualOptions): StationVisual {
  const def = ARCHETYPES[visualId];
  if (!def) throw new Error(`unknown station archetype: ${visualId}`);
  const layout = STATION_LAYOUTS[visualId];
  const q = opts.quality;
  const mats: HullMaterials = createHullMaterials({ livery: opts.livery ?? def.livery, quality: q, station: { flood: [def.flood[0] * FLOOD_MAX, def.flood[1] * FLOOD_MAX, def.flood[2] * FLOOD_MAX] } });

  const winMat = new THREE.ShaderMaterial({
    vertexShader: WIN_VERT,
    fragmentShader: WIN_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const lampU = { uTime: { value: 0 }, uActive: { value: 0 }, uPxAngle: { value: 0.0006 } };
  const lampMat = new THREE.ShaderMaterial({
    uniforms: lampU,
    vertexShader: LAMP_VERT,
    fragmentShader: LAMP_FRAG,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const byChannel: THREE.Material[] = [];
  byChannel[CH_HULL] = mats.hull;
  byChannel[CH_GLASS] = winMat;
  byChannel[CH_GLOW] = mats.glow;
  byChannel[CH_FLARE] = lampMat;
  byChannel[CH_DECAL] = mats.decal;

  const mode = opts.lod ?? 'auto';
  const lods: (0 | 1)[] = mode === 'hero' ? [0] : mode === 'far' ? [1] : [0, 1];
  const detail = q === 'low' ? 0.6 : q === 'medium' ? 0.8 : 1;
  const geometries: THREE.BufferGeometry[] = [];
  const rotors: { group: THREE.Object3D; spin: number }[] = [];
  const stats: StationVisual['stats'] = [];
  const levels: THREE.Group[] = [];
  let strutGeo: THREE.BufferGeometry | null = null;
  let crateGeo: THREE.BufferGeometry | null = null;
  // radians per pixel of the target being drawn, for the lamps' minimum size
  const onBeforeLamps = (renderer: THREE.WebGLRenderer, _scene: THREE.Scene, camera: THREE.Camera): void => {
    const rt = renderer.getRenderTarget();
    const h = rt ? rt.height : renderer.getDrawingBufferSize(_size).y;
    lampU.uPxAngle.value = 2 / (Math.max(1e-3, camera.projectionMatrix.elements[5]) * Math.max(1, h));
  };

  for (const lod of lods) {
    const sm = buildStationModel(visualId, { seed: opts.seed, lod, detail, rich: lod === 0 && q !== 'low', name: opts.name });
    const level = new THREE.Group();
    for (const part of sm.parts) {
      const g = new THREE.Group();
      g.name = part.name;
      for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
        const geo = part.model.geometries[ch];
        if (!geo) continue;
        geometries.push(geo);
        const mesh = new THREE.Mesh(geo, byChannel[ch]);
        mesh.renderOrder = ch === CH_FLARE ? 4 : ch === CH_GLASS ? 3 : ch === CH_DECAL ? 2 : 0;
        if (ch === CH_FLARE) mesh.onBeforeRender = onBeforeLamps;
        g.add(mesh);
      }
      if (part.struts) {
        strutGeo ??= unitStrut();
        const m = instancedMesh(strutGeo, part.struts, mats.hull);
        geometries.push(m.geometry);
        g.add(m);
      }
      if (part.crates) {
        crateGeo ??= unitCrate();
        const m = instancedMesh(crateGeo, part.crates, mats.hull);
        geometries.push(m.geometry);
        g.add(m);
      }
      if (part.spin !== 0) rotors.push({ group: g, spin: part.spin });
      level.add(g);
    }
    levels.push(level);
    stats.push({ lod, triangles: sm.triangles, drawCalls: sm.drawCalls, buildMs: sm.buildMs });
  }

  let object3d: THREE.Object3D;
  if (levels.length === 1) object3d = levels[0];
  else {
    const lodObj = new THREE.LOD();
    lodObj.addLevel(levels[0], 0);
    lodObj.addLevel(levels[1], layout.radius * (q === 'ultra' ? 30 : q === 'high' ? 22 : q === 'medium' ? 14 : 9));
    object3d = lodObj;
  }
  object3d.name = `station:${visualId}`;

  const portIndex = new Map<string, number>();
  layout.ports.forEach((p, i) => portIndex.set(p.id, i + 1));
  const matCtx = { time: 0, throttle: 0, lightsOn: true, heat: def.heat, damage: 0 };
  let clock = -1;
  let disposed = false;
  return {
    object3d,
    layout,
    stats,
    update(ctx: StationUpdateCtx): void {
      // a private clock: sim time is too large for float uniforms and races under time-warp
      if (clock < 0) clock = ((ctx.time % 4096) + 4096) % 4096;
      else clock += Math.min(0.25, Math.max(0, ctx.dt));
      for (let i = 0; i < rotors.length; i++) rotors[i].group.rotation.y = (rotors[i].spin * clock) % TAU;
      matCtx.time = clock;
      mats.update(matCtx);
      lampU.uTime.value = clock;
      lampU.uActive.value = ctx.activePortId ? (portIndex.get(ctx.activePortId) ?? 0) : 0;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      object3d.removeFromParent();
      for (const g of geometries) g.dispose();
      strutGeo?.dispose();
      crateGeo?.dispose();
      winMat.dispose();
      lampMat.dispose();
      mats.dispose();
    },
  };
}
