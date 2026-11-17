// Procedural modelling toolkit: winding / normal consistency of every primitive, curves and sections.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CH_HULL, LAYER, MeshBuilder, curve, hullStyle, symSection, symSectionCount, taperCorners } from '../src/render/space/geo';

const ST = hullStyle(LAYER.metal, [0.5, 0.5, 0.5], 1, 0.4);

/** Fraction of triangles whose winding agrees with their vertex normals, and (optionally) faces away from `centre`. */
function facing(b: MeshBuilder, centre?: THREE.Vector3): { tris: number; winding: number; outward: number } {
  const g = b.build().geometries[CH_HULL] as THREE.BufferGeometry;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  const idx = g.index as THREE.BufferAttribute;
  const a = new THREE.Vector3();
  const c = new THREE.Vector3();
  const d = new THREE.Vector3();
  const n = new THREE.Vector3();
  const vn = new THREE.Vector3();
  const mid = new THREE.Vector3();
  let tris = 0;
  let winding = 0;
  let outward = 0;
  for (let i = 0; i < idx.count; i += 3) {
    a.fromBufferAttribute(pos, idx.getX(i));
    c.fromBufferAttribute(pos, idx.getX(i + 1));
    d.fromBufferAttribute(pos, idx.getX(i + 2));
    n.subVectors(c, a).cross(vn.subVectors(d, a));
    if (n.length() < 1e-9) continue; // degenerate sliver
    n.normalize();
    tris++;
    vn.fromBufferAttribute(nrm, idx.getX(i)).add(mid.fromBufferAttribute(nrm, idx.getX(i + 1))).add(mid.fromBufferAttribute(nrm, idx.getX(i + 2)));
    if (n.dot(vn) > 0) winding++;
    if (centre) {
      mid.copy(a).add(c).add(d).multiplyScalar(1 / 3).sub(centre);
      if (n.dot(mid) > -1e-6) outward++;
    }
  }
  return { tris, winding, outward };
}

const O = new THREE.Vector3();
const convex: [string, (b: MeshBuilder) => void, THREE.Vector3][] = [
  ['box', (b) => b.box(2, 1, 3, ST, { bevel: 0.1 }), O],
  ['tapered box', (b) => b.box(2, 1, 3, ST, { bevel: 0.05, taperX: 0.6, taperZ: 0.8, shiftX: 0.2 }), O],
  ['hexa', (b) => b.hexa(taperCorners(-1, 2, 1, 1, 1, 0.5), 0.05, ST), O],
  ['cylinder', (b) => b.cyl(1, 0.6, 2, ST, { segs: 12, bevel: 0.1 }), new THREE.Vector3(0, 0, 1)],
  ['sphere', (b) => b.sphere(1, ST, 16), O],
  ['capsule', (b) => b.capsule(0.5, 2, ST, 12), O],
  ['plate', (b) => b.plate([-1, -1, 1, -1, 1.5, 1, -1, 1], 0.2, { style: ST, bevel: 0.05 }), new THREE.Vector3(0.1, 0, 0)],
  ['sharp plate', (b) => b.plate([1, 1, -1, 1, -1, -1, 1, -1], 0.2, { style: ST, bevel: 0.05, sharp: true }), O],
  ['strut', (b) => b.strut(0, 0, -1, 0, 0, 1, 0.2, ST, 6), O],
  ['pipe', (b) => b.pipe([0, 0, -1, 0, 0, 1], 0.2, ST, { caps: true }), O],
];
const other: [string, (b: MeshBuilder) => void][] = [
  ['torus', (b) => b.torus(1, 0.2, ST)],
  ['ring', (b) => b.ring(0.6, 1, 0.3, ST)],
  ['nozzle', (b) => b.nozzle({ throatR: 0.3, exitR: 1, length: 1.5, style: ST, inner: ST, hoops: 2 })],
  ['dish', (b) => b.dish(1, 0.3, ST, ST, ST)],
  ['truss', (b) => b.truss(0, 0, 0, 0, 0, 6, { width: 1, bays: 4, r: 0.05, style: ST })],
  ['bent pipe', (b) => b.pipe([0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 1], 0.1, ST, { smoothPath: true })],
  ['greebles', (b) => b.greebles(3, 2, { styles: [ST], pipes: 3 })],
  [
    'loft with a conformal plate',
    (b) => {
      const s = b.loft({
        ts: [0, 1, 2, 3],
        K: 16,
        ring: (t, out) => {
          for (let i = 0; i < 16; i++) {
            const a = (i / 16) * Math.PI * 2;
            out[i * 3] = Math.sin(a) * (1 + 0.2 * t);
            out[i * 3 + 1] = Math.cos(a) * 0.7;
            out[i * 3 + 2] = t;
          }
        },
        style: ST,
        capStart: ST,
        capEnd: ST,
      });
      b.plateOn(s, 0.05, 0.2, 0.5, 2.5, { lift: 0.05, style: ST });
      b.plateOn(s, 0.8, 0.95, 0.5, 2.5, { lift: 0.05, style: ST });
    },
  ],
];

describe('geo primitives', () => {
  it.each(convex)('%s faces outward, plain and mirrored', (_name, make, centre) => {
    const b = new MeshBuilder();
    make(b);
    const f = facing(b, centre);
    expect(f.tris).toBeGreaterThan(3);
    expect(f.winding).toBe(f.tris);
    expect(f.outward).toBe(f.tris);
    // the same part under a mirror (negative determinant) and an offset rotation
    const m = new MeshBuilder();
    m.push(new THREE.Matrix4().makeScale(-1, 1, 1));
    make(m);
    m.pop();
    const fm = facing(m, new THREE.Vector3(-centre.x, centre.y, centre.z));
    expect(fm.winding).toBe(fm.tris);
    expect(fm.outward).toBe(fm.tris);
  });

  it.each(other)('%s has windings that agree with its normals', (_name, make) => {
    const b = new MeshBuilder();
    make(b);
    const f = facing(b);
    expect(f.tris).toBeGreaterThan(8);
    expect(f.winding / f.tris).toBeGreaterThan(0.995);
    const m = new MeshBuilder();
    m.mirror((side) => {
      if (side < 0) make(m);
    });
    const fm = facing(m);
    expect(fm.winding / fm.tris).toBeGreaterThan(0.995);
  });

  it('halves tessellation at the reduced LOD and leaves out hero-only parts', () => {
    const hi = new MeshBuilder({ detail: 1 });
    const lo = new MeshBuilder({ detail: 0.5 });
    for (const b of [hi, lo]) {
      b.sphere(1, ST, 24);
      b.nozzle({ throatR: 0.3, exitR: 1, length: 1.5, style: ST, inner: ST, hoops: 3 });
    }
    expect(lo.triangleCount).toBeLessThan(hi.triangleCount * 0.5);
    expect(lo.hero).toBe(false);
  });

  it('bakes darker ambient occlusion into a crevice than onto an open face', () => {
    const b = new MeshBuilder();
    b.box(4, 0.2, 4, ST); // deck
    b.at(-0.35, 0.6, 0, () => b.box(0.5, 1, 3, ST));
    b.at(0.35, 0.6, 0, () => b.box(0.5, 1, 3, ST)); // two walls 0.2 m apart
    b.bakeAO(0.8, 0.05);
    const g = b.build().geometries[CH_HULL] as THREE.BufferGeometry;
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    const tint = g.getAttribute('aTint');
    let slot = 0;
    let ns = 0;
    let open = 0;
    let no = 0;
    for (let i = 0; i < pos.count; i++) {
      const inSlot = Math.abs(pos.getX(i)) < 0.11 && pos.getY(i) > 0.2 && Math.abs(nrm.getX(i)) > 0.9;
      const outer = Math.abs(pos.getX(i)) > 0.59 && Math.abs(pos.getX(i)) < 0.61 && pos.getY(i) > 0.9 && Math.abs(nrm.getX(i)) > 0.9;
      if (inSlot) {
        slot += tint.getW(i);
        ns++;
      } else if (outer) {
        open += tint.getW(i);
        no++;
      }
    }
    expect(ns).toBeGreaterThan(0);
    expect(no).toBeGreaterThan(0);
    expect(slot / ns).toBeLessThan((open / no) * 0.92);
  });
});

describe('geo curves and sections', () => {
  it('interpolates keys monotonically without overshoot', () => {
    const f = curve([0, 0, 1, 1, 2, 1, 3, 4]);
    expect(f(-1)).toBe(0);
    expect(f(0.5)).toBeGreaterThan(0);
    expect(f(1.5)).toBeCloseTo(1, 6);
    expect(f(5)).toBe(4);
    let prev = -Infinity;
    for (let t = 0; t <= 3; t += 0.05) {
      const v = f(t);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(v).toBeLessThanOrEqual(4 + 1e-9);
      prev = v;
    }
  });

  it('builds symmetric closed sections with a fixed point count', () => {
    for (const segs of [2, 3, 4]) {
      const half = [
        { x: 0, y: 1, r: 0.2 },
        { x: 1, y: 0.8, r: 0.2 },
        { x: 1.4, y: 0, r: 0.05 },
        { x: 1, y: -0.8, r: 0.3 },
        { x: 0, y: -1, r: 0.2 },
      ];
      const pts = symSection(half, segs);
      const K = pts.length / 2;
      expect(K).toBe(symSectionCount(half.length, segs));
      expect(pts[0]).toBe(0); // starts on the centreline at the top
      for (let i = 1; i < K; i++) {
        expect(pts[(K - i) * 2]).toBeCloseTo(-pts[i * 2], 9);
        expect(pts[(K - i) * 2 + 1]).toBeCloseTo(pts[i * 2 + 1], 9);
      }
    }
  });
});
