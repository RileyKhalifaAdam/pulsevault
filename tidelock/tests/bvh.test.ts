// The ray tracer's BVH (src/render/rt/bvh.ts: three-mesh-bvh SAH build, packed into the float-texture layout
// the GLSL reads, and the JS mirror of the GLSL traversal) against brute force, on the Wren's interior built
// from its data boxes (src/data/interiors.ts), plus an exterior hull shell that is front-face-only.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { INTERIORS } from '../src/data/interiors';
import { buildPacked, mergeStatic, measureWork, trace, traceBrute, type MergedScene } from '../src/render/rt/bvh';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const layout = INTERIORS.wren!;
const mat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.6 });
function boxMesh(b: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }, seg = 0.35): THREE.Mesh {
  const w = b.max.x - b.min.x, h = b.max.y - b.min.y, d = b.max.z - b.min.z;
  const s = (l: number): number => Math.max(1, Math.min(24, Math.round(l / seg)));
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d, s(w), s(h), s(d)), mat);
  m.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
  return m;
}

function buildInterior(): { scene: MergedScene; hull: THREE.Mesh } {
  const meshes = [...layout.rooms.map((r) => boxMesh(r.box)), ...layout.solids.map((s) => boxMesh(s.box, 0.2))];
  // exterior shell around everything (outward-facing box): rays from inside must pass out through it
  const hull = boxMesh({ min: { x: -4.5, y: -2.2, z: -17 }, max: { x: 4.5, y: 2.6, z: 15 } }, 1.0);
  meshes.push(hull);
  const root = new THREE.Group();
  root.add(...meshes);
  const merged = mergeStatic(meshes, new THREE.Matrix4(), { exterior: [hull] });
  return { scene: buildPacked(merged.geometry, merged.surf, merged.ms), hull };
}

describe('rt BVH (packed, JS mirror of the GLSL traversal)', () => {
  const { scene } = buildInterior();
  const rnd = rng(12345);
  const rooms = layout.rooms;
  const randomRay = (): [number, number, number, number, number, number] => {
    const r = rooms[Math.floor(rnd() * rooms.length)].box;
    const ox = r.min.x + 0.05 + rnd() * (r.max.x - r.min.x - 0.1);
    const oy = r.min.y + 0.05 + rnd() * (r.max.y - r.min.y - 0.1);
    const oz = r.min.z + 0.05 + rnd() * (r.max.z - r.min.z - 0.1);
    let dx = rnd() * 2 - 1, dy = rnd() * 2 - 1, dz = rnd() * 2 - 1;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l;
    dy /= l;
    dz /= l;
    return [ox, oy, oz, dx, dy, dz];
  };

  it('has a sensible size', () => {
    expect(scene.triangles).toBeGreaterThan(5000);
    expect(scene.nodeCount).toBeGreaterThan(scene.triangles / 16);
  });

  it('closest hit agrees with brute force on 4000 random rays', () => {
    let mismatches = 0;
    let hits = 0;
    for (let i = 0; i < 4000; i++) {
      const [ox, oy, oz, dx, dy, dz] = randomRay();
      const a = trace(scene, ox, oy, oz, dx, dy, dz, 1e4, false);
      const b = traceBrute(scene, ox, oy, oz, dx, dy, dz, 1e4);
      if (!!a !== !!b || (a && b && Math.abs(a.t - b.t) > 1e-5)) mismatches++;
      if (b) hits++;
    }
    expect(mismatches).toBe(0);
    expect(hits).toBeGreaterThan(3900); // the rooms are closed boxes
  });

  it('any hit agrees with brute force (with a max distance) on 4000 random rays', () => {
    let mismatches = 0;
    let occluded = 0;
    for (let i = 0; i < 4000; i++) {
      const [ox, oy, oz, dx, dy, dz] = randomRay();
      const tMax = 0.2 + rnd() * 3;
      const a = trace(scene, ox, oy, oz, dx, dy, dz, tMax, true);
      const b = traceBrute(scene, ox, oy, oz, dx, dy, dz, tMax);
      if (!!a !== !!b) mismatches++;
      if (a && b && !(a.t < tMax)) mismatches++;
      if (b) occluded++;
    }
    expect(mismatches).toBe(0);
    expect(occluded).toBeGreaterThan(400);
    expect(occluded).toBeLessThan(3900);
  });

  it('the exterior shell is front-face-only: rays leave from inside, hit from outside', () => {
    // from a point outside every room but inside the shell, going up: misses the shell from inside
    const up = trace(scene, 4.0, 0, 0, 0, 1, 0, 1e4, false);
    expect(up).toBeNull();
    // from outside the shell going in: hits the shell at its outer face (y = 2.6)
    const down = trace(scene, 4.0, 5, 0, 0, -1, 0, 1e4, false);
    expect(down).not.toBeNull();
    expect(down!.t).toBeCloseTo(5 - 2.6, 4);
  });

  it('traversal work is small (for the GPU cost model)', () => {
    const w = measureWork(scene, 2048);
    // eslint-disable-next-line no-console
    console.log(`rt work/ray: closest ${w.closest.nodes.toFixed(1)} nodes ${w.closest.tris.toFixed(1)} tris · any ${w.any.nodes.toFixed(1)} nodes ${w.any.tris.toFixed(1)} tris · ${scene.triangles} tris ${scene.nodeCount} nodes`);
    expect(w.closest.nodes).toBeLessThan(120);
  });

  it('builds ~600k triangles within the budget', () => {
    const g = new THREE.SphereGeometry(10, 550, 550);
    const m = new THREE.Mesh(g, mat);
    const merged = mergeStatic([m], new THREE.Matrix4());
    const s = buildPacked(merged.geometry, merged.surf, merged.ms);
    // eslint-disable-next-line no-console
    console.log(`rt build ${s.triangles} tris: merge ${s.mergeMs.toFixed(0)} ms, SAH build ${s.buildMs.toFixed(0)} ms, pack ${s.packMs.toFixed(0)} ms (node, this machine)`);
    expect(s.triangles).toBeGreaterThan(590000);
    expect(s.mergeMs + s.buildMs + s.packMs).toBeLessThan(15000);
    // spot check correctness on the big mesh
    const r = trace(s, 0, 0, 0, 0.3, 0.4, Math.sqrt(1 - 0.25), 1e4, false);
    expect(r && Math.abs(r.t - 10) < 0.05).toBe(true);
  });
});
