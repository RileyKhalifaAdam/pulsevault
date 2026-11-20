// Loose objects aboard (src/world/props.ts → propViews) as instanced, ship-local meshes.
//
// Five instanced meshes, one draw call each (plus their shadow passes): each holds the models of a few object
// types merged into one geometry, and a per-instance variant attribute collapses the vertices of the other
// types to a point (degenerate triangles draw nothing). Every vertex carries its own colour, roughness,
// metalness, glow (the tablet screen, the torch lens) and a tint weight: the instance colour tints only the
// parts meant to vary (mug bodies, book covers, cushions, crate shells), so no two books look alike.
//
// Model axes and sizes match the collision shapes in src/data/props.ts exactly (centred on the centre of mass;
// capsules run along +Y). MeshStandardMaterial throughout, with the shared photo scans (photo/detail.ts) as detail.
//
// Rooms: objects roam between rooms, so the meshes stay untagged ('' = drawn in every room) and update() leaves
// out the instances whose room (PropView.room) is not in view — room culling hides them with their room.
// Light: with the shadow-mapped sun (ray tracing off) they cast and receive raster shadows like the furniture.
// With the traced sun they are not in the static BVH: each instance takes its own sun visibility (sunVis, from
// a CPU shadow ray through the same BVH, scene.ts) through the forward patch (rt/forward.ts, RT_DYNAMIC), and
// casts no shadow (none of the traced surfaces can receive one).

import * as THREE from 'three';
import type { PropType } from '../../data/props';
import type { PropView } from '../../world/props';
import type { Quality } from '../pipeline';
import { PHOTO_GLSL, photoConstsGlsl } from './surfaces';
import { acquirePhotoDetail, releasePhotoDetail, type PhotoDetail } from './photo/detail';

export interface PropsVisual {
  /** Ship-local: add it to the ship's interior group. */
  object3d: THREE.Group;
  /**
   * Pose every instance from propViews(state). Allocation-free. `rooms`: the rooms in view (null: all);
   * `sunVis[i]`: traced sun visibility 0..1 of views[i] (null: 1, the shadow-mapped sun decides).
   */
  update(views: readonly PropView[], rooms?: ReadonlySet<string> | null, sunVis?: Float32Array | null): void;
  dispose(): void;
}

const FAMILY: Record<PropType, [number, number]> = {
  mug: [0, 0], bottle: [0, 1], foodpack: [0, 2], plantpot: [0, 3],
  tablet: [1, 0], book: [1, 1], pen: [1, 2],
  toolbox: [2, 0], spanner: [2, 1], torch: [2, 2],
  pillow: [3, 0], helmet: [3, 1],
  crateSmall: [4, 0], crateLarge: [4, 1],
};
const FAMILIES = 5;
const CAPACITY = 48;

// ------------------------------------------------------------------------------------------------ building

/** r roughness, m metalness, glow emissive gain, tint instance-colour weight, ph photo set (PH_* below, 0 none). */
interface Surf { r?: number; m?: number; glow?: number; tint?: number; ph?: number }

// photo detail sets (the shared photo arrays of photo/detail.ts, projected on the model's dominant axis)
const PH_PAINT = 1, PH_BRUSHED = 2, PH_GUNMETAL = 3, PH_LEATHER = 4, PH_FABRIC = 5, PH_HULL = 6;

class Builder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  surf: number[] = [];
  vari: number[] = [];
  phot: number[] = [];
  idx: number[] = [];
  private v = new THREE.Vector3();
  private c = new THREE.Color();
  private nm = new THREE.Matrix3();

  add(g: THREE.BufferGeometry, m: THREE.Matrix4, color: number, s: Surf, variant: number): void {
    const pa = g.getAttribute('position'), na = g.getAttribute('normal'), base = this.pos.length / 3;
    this.nm.getNormalMatrix(m);
    this.c.setHex(color, THREE.SRGBColorSpace);
    for (let i = 0; i < pa.count; i++) {
      this.v.fromBufferAttribute(pa, i).applyMatrix4(m);
      this.pos.push(this.v.x, this.v.y, this.v.z);
      this.v.fromBufferAttribute(na, i).applyMatrix3(this.nm).normalize();
      this.nor.push(this.v.x, this.v.y, this.v.z);
      this.col.push(this.c.r, this.c.g, this.c.b);
      this.surf.push(s.r ?? 0.6, s.m ?? 0, s.glow ?? 0, s.tint ?? 0);
      this.vari.push(variant);
      this.phot.push(s.ph ?? 0);
    }
    const ix = g.getIndex();
    if (ix) for (let i = 0; i < ix.count; i++) this.idx.push(base + ix.getX(i));
    else for (let i = 0; i < pa.count; i++) this.idx.push(base + i);
    g.dispose();
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aSurf', new THREE.Float32BufferAttribute(this.surf, 4));
    g.setAttribute('aVariant', new THREE.Float32BufferAttribute(this.vari, 1));
    g.setAttribute('aPhoto', new THREE.Float32BufferAttribute(this.phot, 1));
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

const E = new THREE.Euler();
const Qt = new THREE.Quaternion();
const S = new THREE.Vector3();
const P = new THREE.Vector3();
/** Matrix: translate (x, y, z), rotate XYZ (rx, ry, rz), scale (sx, sy, sz). */
function M(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  return new THREE.Matrix4().compose(P.set(x, y, z), Qt.setFromEuler(E.set(rx, ry, rz)), S.set(sx, sy, sz));
}

interface Seg { c: number; s: number }

const box = (w: number, h: number, d: number): THREE.BufferGeometry => new THREE.BoxGeometry(w, h, d);
const cyl = (q: Seg, rt: number, rb: number, h: number): THREE.BufferGeometry => new THREE.CylinderGeometry(rt, rb, h, q.c);
const torus = (q: Seg, r: number, t: number, arc = Math.PI * 2): THREE.BufferGeometry => new THREE.TorusGeometry(r, t, Math.max(4, q.c >> 2), q.c, arc);
const sphere = (q: Seg, r: number): THREE.BufferGeometry => new THREE.SphereGeometry(r, q.c, q.s);

/** A rounded, cushion-like block: a superellipsoid of half sizes (a, b, c). */
function cushion(q: Seg, a: number, b: number, c: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, q.c * 2, q.s * 2), p = g.getAttribute('position');
  const f = (x: number, e: number): number => Math.sign(x) * Math.pow(Math.abs(x), e);
  for (let i = 0; i < p.count; i++) p.setXYZ(i, f(p.getX(i), 0.45) * a, f(p.getY(i), 0.8) * b, f(p.getZ(i), 0.45) * c);
  g.computeVertexNormals();
  return g;
}

const DARK = 0x24272b;
const STEEL = 0xc8ccd0;

function mug(b: Builder, q: Seg, v: number): void {
  b.add(cyl(q, 0.04, 0.036, 0.088), M(0, -0.011, 0), 0xf2f2f2, { r: 0.4, tint: 1, ph: PH_PAINT }, v);
  b.add(cyl(q, 0.0365, 0.0365, 0.004), M(0, -0.053, 0), DARK, { r: 0.7 }, v);
  b.add(cyl(q, 0.041, 0.041, 0.014), M(0, 0.04, 0), DARK, { r: 0.55 }, v);
  b.add(cyl(q, 0.034, 0.038, 0.004), M(0, 0.049, 0), 0x3a3e44, { r: 0.5 }, v);
  b.add(box(0.022, 0.004, 0.009), M(0, 0.0515, -0.024), 0x111214, { r: 0.4 }, v);
  b.add(torus(q, 0.023, 0.006, Math.PI), M(0.039, -0.012, 0, 0, 0, -Math.PI / 2), 0xf2f2f2, { r: 0.4, tint: 1, ph: PH_PAINT }, v);
  b.add(torus(q, 0.0402, 0.0018), M(0, 0.02, 0, Math.PI / 2), DARK, { r: 0.6 }, v);
}

function bottle(b: Builder, q: Seg, v: number): void {
  b.add(cyl(q, 0.036, 0.036, 0.16), M(0, -0.035, 0), 0x9aa3ab, { r: 0.3, m: 0.8, ph: PH_BRUSHED }, v);
  b.add(cyl(q, 0.0365, 0.0365, 0.06), M(0, -0.04, 0), 0xffffff, { r: 0.6, tint: 1 }, v);
  b.add(sphere(q, 0.036), M(0, 0.045, 0, 0, 0, 0, 1, 0.6, 1), 0x9aa3ab, { r: 0.3, m: 0.8 }, v);
  b.add(cyl(q, 0.016, 0.016, 0.03), M(0, 0.075, 0), 0x9aa3ab, { r: 0.3, m: 0.8 }, v);
  b.add(cyl(q, 0.019, 0.019, 0.032), M(0, 0.104, 0), 0xe0702a, { r: 0.5 }, v);
  b.add(torus(q, 0.0365, 0.004), M(0, -0.115, 0, Math.PI / 2), 0x80878e, { r: 0.35, m: 0.8 }, v);
}

function foodpack(b: Builder, q: Seg, v: number): void {
  b.add(cushion(q, 0.06, 0.02, 0.048), M(0, 0, 0), 0xb8bcc2, { r: 0.35, m: 0.85, ph: PH_BRUSHED }, v);
  b.add(box(0.012, 0.006, 0.098), M(0.064, 0, 0), 0xa9adb3, { r: 0.4, m: 0.85 }, v);
  b.add(box(0.012, 0.006, 0.098), M(-0.064, 0, 0), 0xa9adb3, { r: 0.4, m: 0.85 }, v);
  b.add(box(0.07, 0.002, 0.06), M(0, 0.0195, 0), 0xffffff, { r: 0.75, tint: 1 }, v);
  b.add(box(0.07, 0.0022, 0.012), M(0, 0.0197, -0.02), 0x202326, { r: 0.7 }, v);
}

function plantpot(b: Builder, q: Seg, v: number): void {
  b.add(box(0.17, 0.12, 0.17), M(0, -0.06, 0), 0xb5653a, { r: 0.85 }, v);
  b.add(box(0.18, 0.016, 0.18), M(0, 0.0, 0), 0xa65a32, { r: 0.85 }, v);
  b.add(box(0.15, 0.01, 0.15), M(0, 0.004, 0), 0x3b2a1e, { r: 1 }, v);
  b.add(box(0.172, 0.01, 0.172), M(0, -0.115, 0), 0x2a2d30, { r: 0.6, m: 0.6 }, v); // magnetic pad
  const leaves: [number, number, number, number, number][] = [
    [0.0, 0.07, 0.0, 0, 0], [0.04, 0.06, 0.02, 0.6, 0.3], [-0.035, 0.055, -0.02, -0.5, 2.0], [0.01, 0.09, -0.035, 0.4, 4.0],
    [-0.03, 0.085, 0.03, -0.3, 1.2], [0.035, 0.095, -0.01, 0.5, 5.2], [-0.005, 0.105, 0.01, 0.1, 3.0],
  ];
  for (const [x, y, z, rx, ry] of leaves) b.add(sphere(q, 0.03), M(x, y, z, rx, ry, 0.3, 1, 0.25, 0.55), 0x4f8a3a, { r: 0.7, tint: 0.3 }, v);
  b.add(cyl(q, 0.004, 0.004, 0.08), M(0, 0.045, 0), 0x3f6a2c, { r: 0.8 }, v);
}

function tablet(b: Builder, q: Seg, v: number): void {
  b.add(box(0.25, 0.009, 0.17), M(0, 0, 0), 0x3a3f45, { r: 0.35, m: 0.7, ph: PH_BRUSHED }, v);
  b.add(box(0.232, 0.001, 0.152), M(0, 0.0046, 0), 0x0d2233, { r: 0.15, glow: 0.6 }, v);
  b.add(box(0.21, 0.0012, 0.012), M(0, 0.0048, -0.062), 0x6fd3ff, { r: 0.2, glow: 1.2 }, v);
  for (let i = 0; i < 3; i++) b.add(box(0.06, 0.0012, 0.05), M(-0.07 + i * 0.07, 0.0048, -0.02), i === 1 ? 0x2f8f6f : 0x24638a, { r: 0.2, glow: 1 }, v);
  b.add(box(0.2, 0.0012, 0.04), M(0, 0.0048, 0.045), 0x1d4a66, { r: 0.2, glow: 0.9 }, v);
  b.add(cyl(q, 0.003, 0.003, 0.0012), M(0.118, 0.0048, 0), 0x050607, { r: 0.1 }, v);
  b.add(cyl(q, 0.006, 0.006, 0.002), M(-0.09, -0.005, 0.06), 0x15171a, { r: 0.2, m: 0.5 }, v);
}

function book(b: Builder, q: Seg, v: number): void {
  b.add(box(0.15, 0.003, 0.22), M(0, 0.0135, 0), 0xffffff, { r: 0.7, tint: 1, ph: PH_LEATHER }, v);
  b.add(box(0.15, 0.003, 0.22), M(0, -0.0135, 0), 0xffffff, { r: 0.7, tint: 1, ph: PH_LEATHER }, v);
  b.add(box(0.007, 0.03, 0.22), M(-0.0715, 0, 0), 0xdddddd, { r: 0.65, tint: 1, ph: PH_LEATHER }, v);
  b.add(box(0.142, 0.024, 0.212), M(0.003, 0, 0), 0xeee4cc, { r: 0.95 }, v);
  for (const z of [-0.085, -0.075, 0.075, 0.085]) b.add(box(0.0075, 0.0305, 0.003), M(-0.0715, 0, z), 0xc9a24a, { r: 0.3, m: 0.9 }, v);
  b.add(box(0.0075, 0.016, 0.07), M(-0.0716, 0, 0), 0xf0e6c8, { r: 0.6 }, v);
  b.add(box(0.07, 0.0006, 0.1), M(0.01, 0.0153, -0.02), 0xf3ead2, { r: 0.6, tint: 0.2 }, v);
}

function pen(b: Builder, q: Seg, v: number): void {
  b.add(cyl(q, 0.0055, 0.0055, 0.1), M(0, -0.005, 0), 0xffffff, { r: 0.3, m: 0.6, tint: 1 }, v);
  b.add(new THREE.ConeGeometry(0.0055, 0.022, q.c), M(0, -0.066, 0, Math.PI), 0x8b9096, { r: 0.25, m: 0.9 }, v);
  b.add(cyl(q, 0.006, 0.006, 0.025), M(0, 0.057, 0), DARK, { r: 0.4, m: 0.5 }, v);
  b.add(box(0.002, 0.04, 0.003), M(0.0065, 0.045, 0), STEEL, { r: 0.2, m: 1 }, v);
}

function toolbox(b: Builder, q: Seg, v: number): void {
  b.add(box(0.44, 0.16, 0.22), M(0, -0.03, 0), 0xb3261e, { r: 0.45, m: 0.5, ph: PH_HULL }, v);
  b.add(box(0.448, 0.05, 0.226), M(0, 0.075, 0), 0x9c2019, { r: 0.45, m: 0.5, ph: PH_HULL }, v);
  b.add(box(0.452, 0.008, 0.23), M(0, 0.048, 0), 0x2a2d31, { r: 0.5, m: 0.6 }, v);
  b.add(torus(q, 0.06, 0.008, Math.PI), M(0, 0.1, 0, -Math.PI / 2, 0, 0, 1, 1, 0.15), DARK, { r: 0.5 }, v);
  for (const x of [-0.06, 0.06]) b.add(box(0.016, 0.01, 0.03), M(x, 0.103, 0), STEEL, { r: 0.3, m: 1 }, v);
  for (const x of [-0.16, 0.16]) b.add(box(0.04, 0.035, 0.008), M(x, 0.045, 0.114), STEEL, { r: 0.25, m: 1 }, v);
  b.add(box(0.12, 0.03, 0.002), M(0, -0.02, 0.111), 0xf0c020, { r: 0.6 }, v);
}

function spanner(b: Builder, q: Seg, v: number): void {
  b.add(box(0.15, 0.007, 0.016), M(0, 0, 0), STEEL, { r: 0.22, m: 1, ph: PH_BRUSHED }, v);
  b.add(torus(q, 0.012, 0.0045), M(0.094, 0, 0, Math.PI / 2), STEEL, { r: 0.22, m: 1 }, v);
  b.add(box(0.014, 0.008, 0.032), M(-0.082, 0, 0), STEEL, { r: 0.22, m: 1 }, v);
  for (const z of [-0.0115, 0.0115]) b.add(box(0.026, 0.008, 0.009), M(-0.1, 0, z), STEEL, { r: 0.22, m: 1 }, v);
  b.add(box(0.06, 0.0072, 0.008), M(0, 0.0003, 0), 0x9ea4aa, { r: 0.5, m: 1 }, v);
}

function torch(b: Builder, q: Seg, v: number): void {
  b.add(cyl(q, 0.017, 0.017, 0.13), M(0, -0.02, 0), 0x22252a, { r: 0.4, m: 0.6, ph: PH_GUNMETAL }, v);
  b.add(cyl(q, 0.021, 0.018, 0.04), M(0, 0.065, 0), 0x2c3036, { r: 0.35, m: 0.7 }, v);
  b.add(cyl(q, 0.0185, 0.0185, 0.002), M(0, 0.0855, 0), 0xfff2cc, { r: 0.1, glow: 2.5 }, v);
  for (const y of [-0.075, -0.065, -0.055, -0.045]) b.add(torus(q, 0.017, 0.0016), M(0, y, 0, Math.PI / 2), 0x3a3e44, { r: 0.5, m: 0.7 }, v);
  b.add(box(0.006, 0.016, 0.01), M(0.0175, 0.02, 0), 0xe0702a, { r: 0.5 }, v);
  b.add(cyl(q, 0.0172, 0.0172, 0.004), M(0, -0.0855, 0), 0x15171a, { r: 0.6 }, v);
}

function pillow(b: Builder, q: Seg, v: number): void {
  b.add(cushion(q, 0.2, 0.058, 0.15), M(0, 0, 0), 0xffffff, { r: 0.95, tint: 1, ph: PH_FABRIC }, v);
  b.add(sphere(q, 0.008), M(0, 0.056, 0, 0, 0, 0, 1, 0.4, 1), 0x6a6a6a, { r: 0.8, tint: 0.6 }, v);
  b.add(sphere(q, 0.008), M(0, -0.056, 0, 0, 0, 0, 1, 0.4, 1), 0x6a6a6a, { r: 0.8, tint: 0.6 }, v);
}

function helmet(b: Builder, q: Seg, v: number): void {
  b.add(sphere(q, 0.15), M(0, 0.005, 0), 0xe9ecef, { r: 0.4, m: 0.05, ph: PH_PAINT }, v);
  b.add(new THREE.SphereGeometry(0.1535, q.c, q.s, Math.PI * 1.5 - 0.95, 1.9, 1.0, 1.1), M(0, 0.005, 0), 0xc9a24a, { r: 0.12, m: 1 }, v);
  b.add(torus(q, 0.105, 0.014), M(0, -0.125, 0, Math.PI / 2), 0x8d949b, { r: 0.3, m: 0.9 }, v);
  b.add(torus(q, 0.1505, 0.005, Math.PI), M(0, 0.005, 0, 0, Math.PI / 2, 0), 0xe0702a, { r: 0.5 }, v);
  for (const x of [-0.148, 0.148]) b.add(cyl(q, 0.014, 0.014, 0.012), M(x, 0.04, 0, 0, 0, Math.PI / 2), 0x3a3e44, { r: 0.4, m: 0.7 }, v);
  b.add(cyl(q, 0.009, 0.009, 0.003), M(0.155, 0.04, 0, 0, 0, Math.PI / 2), 0xfff6dd, { r: 0.1, glow: 2 }, v);
}

function crate(b: Builder, w: number, h: number, d: number, v: number): void {
  const hx = w / 2, hy = h / 2, hz = d / 2, t = 0.022, o = 0.0015;
  b.add(box(w - 0.01, h - 0.01, d - 0.01), M(0, 0, 0), 0x9aa29a, { r: 0.75, m: 0.1, tint: 1, ph: PH_HULL }, v);
  // the edge frame
  for (const y of [-hy + t / 2, hy - t / 2]) for (const z of [-hz + t / 2, hz - t / 2]) b.add(box(w, t, t), M(0, y, z), 0x3b4046, { r: 0.55, m: 0.5, ph: PH_GUNMETAL }, v);
  for (const x of [-hx + t / 2, hx - t / 2]) for (const z of [-hz + t / 2, hz - t / 2]) b.add(box(t, h - 2 * t, t), M(x, 0, z), 0x3b4046, { r: 0.55, m: 0.5, ph: PH_GUNMETAL }, v);
  for (const x of [-hx + t / 2, hx - t / 2]) for (const y of [-hy + t / 2, hy - t / 2]) b.add(box(t, t, d - 2 * t), M(x, y, 0), 0x3b4046, { r: 0.55, m: 0.5, ph: PH_GUNMETAL }, v);
  // two cargo straps around it, with buckles
  for (const x of [-w * 0.27, w * 0.27]) {
    b.add(box(0.045, h + 2 * o, d + 2 * o), M(x, 0, 0), 0xd2691e, { r: 0.9, ph: PH_FABRIC }, v);
    b.add(box(0.05, 0.03, 0.012), M(x, hy * 0.2, hz + 0.006), STEEL, { r: 0.3, m: 1 }, v);
  }
  // stencils on both long faces and the lid: a hazard band, a code block, a cell grid
  for (const s of [-1, 1]) {
    const z = s * (hz + o);
    b.add(box(w * 0.3, h * 0.16, 0.002), M(0, hy * 0.55, z), 0xe0b020, { r: 0.6 }, v);
    for (let i = 0; i < 5; i++) b.add(box(w * 0.022, h * 0.16, 0.0025), M(-w * 0.12 + i * w * 0.06, hy * 0.55, z, 0, 0, 0.6), 0x15171a, { r: 0.6 }, v);
    for (let i = 0; i < 4; i++) b.add(box(w * 0.028, h * 0.2, 0.002), M(-w * 0.07 + i * w * 0.045, -hy * 0.35, z), 0x1c1f22, { r: 0.7 }, v);
    b.add(box(w * 0.08, h * 0.04, 0.002), M(w * 0.1, -hy * 0.35, z), 0x1c1f22, { r: 0.7 }, v);
  }
  b.add(box(w * 0.36, 0.002, d * 0.3), M(0, hy + o, 0), 0xe6e2d6, { r: 0.7 }, v);
  for (let i = 0; i < 3; i++) b.add(box(w * 0.08, 0.0025, d * 0.18), M(-w * 0.1 + i * w * 0.1, hy + o, 0), 0x1c1f22, { r: 0.7 }, v);
}

// ------------------------------------------------------------------------------------------------ materials

/** Collapse the vertices of every model but the instance's own. */
function patchVariant(shader: { vertexShader: string }): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aVariant;\nattribute float iVariant;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nif (abs(aVariant - iVariant) > 0.5) transformed = vec3(0.0);');
}

// photo detail (the same shared arrays and wiring rule as the interior and the cockpit, surfaces.ts): the set per
// vertex (aPhoto), projected on the dominant axis of the model position in metres (detail UV = m / tileMetres);
// colour × photo / mean albedo, roughness + (photo − mean roughness), AO multiplied, metalness kept; the detail
// normal through a screen-space tangent frame of the projection. Fades out where the axis changes.
const PH_TOP = /* glsl */ `
  float prPhW = 0.0;
  vec4 prPhAlb = vec4(1.0);
  vec4 prPhLin = vec4(0.5, 0.5, 1.0, 0.5);
  vec4 prPB = vec4(1.0);
  vec2 prMdx = vec2(0.0);
  vec2 prMdy = vec2(0.0);
#ifdef PR_PHOTO
  {
    vec3 an = abs(normalize(vONrm));
    float mx = max(an.x, max(an.y, an.z));
    vec2 uvm = an.x >= mx ? vLoc.zy : (an.y >= mx ? vLoc.xz : vLoc.xy);
    prMdx = dFdx(uvm);
    prMdy = dFdy(uvm);
    int kind = int(vPhoto + 0.5);
    vec4 pa = vec4(0.0);
    float k = 0.0;
    if (kind == 1) { pa = PH_A_whitePanel; prPB = PH_B_whitePanel; k = 0.7; }
    else if (kind == 2) { pa = PH_A_brushed; prPB = PH_B_brushed; k = 0.8; }
    else if (kind == 3) { pa = PH_A_gunmetal; prPB = PH_B_gunmetal; k = 1.0; }
    else if (kind == 4) { pa = PH_A_leather; prPB = PH_B_leather; k = 1.0; }
    else if (kind == 5) { pa = PH_A_fabric; prPB = PH_B_fabric; k = 1.0; }
    else if (kind == 6) { pa = PH_A_hullPaint; prPB = PH_B_hullPaint; k = 0.8; }
    prPhW = k * uPhOn * smoothstep(0.64, 0.74, mx);
    if (prPhW > 0.0) {
      vec2 sc = pa.zw;
      prMdx *= sc;
      prMdy *= sc;
      prPhAlb = phAlbedo(pa.x, uvm * sc, prMdx, prMdy);
      prPhLin = phLinear(pa.y, uvm * sc, prMdx, prMdy);
    }
  }
#endif
`;
const PH_NORMAL = /* glsl */ `
#ifdef PR_PHOTO
  if (prPhW > 0.0) {
    vec3 q0 = dFdx(-vViewPosition);
    vec3 q1 = dFdy(-vViewPosition);
    vec3 q1p = cross(q1, normal);
    vec3 q0p = cross(normal, q0);
    vec3 T = q1p * prMdx.x + q0p * prMdy.x;
    vec3 Bt = q1p * prMdx.y + q0p * prMdy.y;
    float det = max(dot(T, T), dot(Bt, Bt));
    float sc = det == 0.0 ? 0.0 : inversesqrt(det);
    normal = normalize(mat3(T * sc, Bt * sc, normal) * phNormal(prPhLin, prPhW));
  }
#endif
`;

function propMaterial(photo: PhotoDetail | null): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 1, metalness: 0, envMapIntensity: 1 });
  // defines in the source: the per-probe clones (probes.ts) copy() the material, which resets `defines`
  const defs = photo ? '#define PR_PHOTO\n' : '';
  m.onBeforeCompile = (shader, renderer) => {
    if (photo) {
      photo.noteRenderer(renderer);
      Object.assign(shader.uniforms, photo.uniforms);
    }
    patchVariant(shader);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec4 aSurf;\nattribute float aPhoto;\nattribute float iSunVis;\nvarying vec4 vSurf;\nvarying float vPhoto;\nvarying float vRtSunVis;\nvarying vec3 vLoc;\nvarying vec3 vONrm;',
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLoc = position;\nvONrm = objectNormal;\nvPhoto = aPhoto;\nvRtSunVis = iSunVis;')
      .replace('#include <color_vertex>', '#include <color_vertex>\nvSurf = aSurf;\n#if defined( USE_COLOR ) && defined( USE_INSTANCING_COLOR )\nvColor.xyz = mix(color.xyz, vColor.xyz, aSurf.w);\n#endif');
    shader.fragmentShader =
      defs +
      shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>\nvarying vec4 vSurf;\nvarying float vPhoto;\nvarying float vRtSunVis;\nvarying vec3 vLoc;\nvarying vec3 vONrm;\n${photo ? `${PHOTO_GLSL}\n${photoConstsGlsl()}` : 'const float uPhOn = 0.0;'}`,
        )
        .replace('void main() {', `void main() {\n${PH_TOP}`)
        .replace(
          '#include <color_fragment>',
          '#include <color_fragment>\n#ifdef PR_PHOTO\nif (prPhW > 0.0) diffuseColor.rgb = min(diffuseColor.rgb * mix(vec3(1.0), clamp(prPhAlb.rgb * prPB.rgb, 0.0, 3.0), prPhW), vec3(0.9));\n#endif',
        )
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(vSurf.x + prPhW * (prPhLin.a - prPB.w), 0.04, 1.0);')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vSurf.y;')
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${PH_NORMAL}`)
        .replace(
          '#include <aomap_fragment>',
          '#include <aomap_fragment>\n{ float prAo = mix(1.0, prPhLin.b, prPhW); reflectedLight.indirectDiffuse *= prAo; reflectedLight.indirectSpecular *= mix(1.0, prAo, 0.7); }',
        )
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vSurf.z;');
  };
  m.customProgramCacheKey = () => `tidelock-props-2${photo ? '-ph' : ''}`;
  m.userData.room = '';
  // the ray tracer's forward patch (rt/forward.ts): a moving object takes its own per-instance sun visibility
  m.userData.rtDynamic = true;
  return m;
}

function depthMaterial(): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = patchVariant;
  m.customProgramCacheKey = () => 'tidelock-props-depth-1';
  return m;
}

function distanceMaterial(): THREE.MeshDistanceMaterial {
  const m = new THREE.MeshDistanceMaterial();
  m.onBeforeCompile = patchVariant;
  m.customProgramCacheKey = () => 'tidelock-props-dist-1';
  return m;
}

// ------------------------------------------------------------------------------------------------ the visual

/** Tints per type family (applied to the parts with a tint weight); picked per object from its id. */
const TINTS: number[][] = [
  [0xd9493a, 0x2f7fbf, 0xe8e2d0, 0x3f9b6a, 0xe0a030, 0x7a4fa0], // mugs, bottles' labels, pouch labels, leaves
  [0x8b2e2e, 0x2e4f8b, 0x2f6b47, 0x6b4a2e, 0x4a4a52, 0x9a7a2e], // books, pens
  [0xffffff],
  [0xc8b89a, 0x6f8fa8, 0xa86f6f, 0x8fa86f, 0xd8d0c0], // cushions
  [0x8e9a8a, 0x9a9488, 0x7f8c96, 0xa0a29a], // crate shells
];

function hashId(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function createPropsVisual(opts: { quality: Quality }): PropsVisual {
  const qs = { low: 10, medium: 14, high: 20, ultra: 28 }[opts.quality] ?? 14;
  const q: Seg = { c: qs, s: Math.max(6, qs >> 1) };
  const builders = Array.from({ length: FAMILIES }, () => new Builder());
  mug(builders[0], q, 0); bottle(builders[0], q, 1); foodpack(builders[0], q, 2); plantpot(builders[0], q, 3);
  tablet(builders[1], q, 0); book(builders[1], q, 1); pen(builders[1], q, 2);
  toolbox(builders[2], q, 0); spanner(builders[2], q, 1); torch(builders[2], q, 2);
  pillow(builders[3], q, 0); helmet(builders[3], q, 1);
  crate(builders[4], 0.6, 0.4, 0.4, 0); crate(builders[4], 1.0, 0.6, 0.6, 1);

  const group = new THREE.Group();
  group.name = 'props';
  group.userData.room = '';
  const photo = typeof document !== 'undefined' ? acquirePhotoDetail(opts.quality) : null;
  const material = propMaterial(photo), depth = depthMaterial(), dist = distanceMaterial();
  const sunAttr: THREE.InstancedBufferAttribute[] = [];
  const meshes: THREE.InstancedMesh[] = [];
  const variantAttr: THREE.InstancedBufferAttribute[] = [];
  const slotId: string[][] = [];
  const slotVar: Int8Array[] = [];
  const counts = new Int32Array(FAMILIES);
  const color = new THREE.Color();
  for (let f = 0; f < FAMILIES; f++) {
    const geo = builders[f].build();
    const va = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
    va.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iVariant', va);
    const sa = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY).fill(1), 1);
    sa.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iSunVis', sa);
    sunAttr.push(sa);
    const mesh = new THREE.InstancedMesh(geo, material, CAPACITY);
    mesh.name = `props-${f}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, color.setRGB(1, 1, 1));
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false; // ship-local and always near the camera; instances span the whole ship
    mesh.customDepthMaterial = depth;
    mesh.customDistanceMaterial = dist;
    mesh.userData.room = '';
    group.add(mesh);
    meshes.push(mesh);
    variantAttr.push(va);
    slotId.push(new Array<string>(CAPACITY).fill(''));
    slotVar.push(new Int8Array(CAPACITY).fill(-1));
  }
  const mat4 = new THREE.Matrix4(), pos = new THREE.Vector3(), quat = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);

  return {
    object3d: group,
    update(views: readonly PropView[], rooms?: ReadonlySet<string> | null, sunVis?: Float32Array | null): void {
      counts.fill(0);
      for (let i = 0; i < views.length; i++) {
        const pv = views[i], fam = FAMILY[pv.type];
        if (!fam) continue;
        if (rooms && pv.room !== '' && !rooms.has(pv.room)) continue; // its room is culled
        const f = fam[0], slot = counts[f];
        if (slot >= CAPACITY) continue;
        counts[f] = slot + 1;
        const mesh = meshes[f];
        if (slotId[f][slot] !== pv.id || slotVar[f][slot] !== fam[1]) {
          slotId[f][slot] = pv.id;
          slotVar[f][slot] = fam[1];
          variantAttr[f].setX(slot, fam[1]);
          variantAttr[f].needsUpdate = true;
          const pal = TINTS[f];
          mesh.setColorAt(slot, color.setHex(pal[hashId(pv.id) % pal.length], THREE.SRGBColorSpace));
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        }
        mat4.compose(pos.set(pv.pos.x, pv.pos.y, pv.pos.z), quat.set(pv.quat.x, pv.quat.y, pv.quat.z, pv.quat.w), one);
        mesh.setMatrixAt(slot, mat4);
        sunAttr[f].setX(slot, sunVis && i < sunVis.length ? sunVis[i] : 1);
      }
      for (let f = 0; f < FAMILIES; f++) {
        meshes[f].count = counts[f];
        meshes[f].instanceMatrix.needsUpdate = true;
        sunAttr[f].needsUpdate = true;
        // slots move when objects change rooms: the variant/colour of a reused slot is rewritten above
      }
    },
    dispose(): void {
      for (const m of meshes) { m.geometry.dispose(); m.dispose(); }
      material.dispose(); depth.dispose(); dist.dispose();
      if (photo) releasePhotoDetail(photo);
      group.clear();
    },
  };
}
