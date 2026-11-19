// Static ship-space scene for the ray tracer: merge the given meshes into one ship-space geometry with
// per-vertex surface data, build ONE BVH over it (three-mesh-bvh, SAH), and pack nodes and triangles into
// float textures laid out exactly as the GLSL traversal in glsl.ts reads them. Also a JS mirror of that
// traversal (closest hit / any hit, with work counters) used by tests/bvh.test.ts and the GPU cost estimate.
//
// No DOM, no WebGL: runs in plain node.
//
// Texture layout (all RGBA32F, TEX_W texels wide, texel i at (i & TEX_MASK, i >> TEX_SHIFT)):
//   nodes  node n = texels 2n, 2n+1:  (min.xyz, w0) (max.xyz, w1)
//            internal: w0 = split axis (0..2), w1 = absolute index of the right child (left child = n + 1)
//            leaf:     w0 = 3 + triangle count, w1 = first triangle
//   tris   triangle t = texels 3t..3t+2: (v0, ia + FRONT_ONLY?) (v1 - v0, ib) (v2 - v0, ic)
//            ia/ib/ic = vertex indices into the surface texture; FRONT_ONLY flags exterior-hull triangles that
//            only count when hit on their front (outward) face, so rays leaving the cabin pass out through
//            the hull skin and still hit wings and nose.
//   surf   (RGBA16F) vertex v = texels 3v..3v+2: (albedo.rgb, roughness) (lit.rgb, metalness) (alt.rgb, exterior)
//            lit = exitant radiance from the (baked) cabin lamps when on; alt = always-on (emissive, night glow).
import * as THREE from 'three';
import { CENTER, MeshBVH, SAH } from 'three-mesh-bvh';
import { TILE_ALBEDO, TILE_IDS } from '../space/surfaces';

/**
 * Mean roughness / metalness of the interior atlas tiles (src/render/space/surfaces.ts, TILE_IDS order), as the
 * ray tracer shades hits and decides which pixels get reflection rays. Approximations of the ORM atlas: keep
 * in step with surfaces.ts when tiles change.
 */
const TILE_ROUGH = [0.45, 0.32, 0.5, 0.7, 0.6, 0.9, 0.5, 0.35, 0.55, 0.95, 0.42, 0.9, 0.6, 0.5, 0.6, 0.5];
const TILE_METAL = [0, 1, 0.8, 0.8, 0.9, 0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0.7, 0];

/** Above this many triangles the build switches from SAH to CENTER splits (4-5x faster to build). */
export const SAH_LIMIT = 200000;

export const TEX_SHIFT = 12;
export const TEX_W = 1 << TEX_SHIFT;
export const TEX_MASK = TEX_W - 1;
/** Added to the first vertex index of a triangle that only counts when hit on its front face. */
export const FRONT_ONLY = 4194304; // 2^22: vertex indices stay exact in float32 up to 4M vertices
export const MAX_DEPTH = 30;
export const STACK_SIZE = 32;
export const MAX_ITERS = 384;

/** Per-vertex surface for shading ray hits and filling the G-buffer. Linear colours. */
export interface VertexSurface {
  albedo: [number, number, number];
  roughness: number;
  metalness: number;
  /** Exitant radiance from the cabin lamps (baked), lamps on. */
  lit: [number, number, number];
  /** Exitant radiance that is always there (emissives). */
  alt: [number, number, number];
}

/**
 * Optional per-mesh override: fill the surface of vertex `i` of `mesh` (its own index space). Return false to
 * fall back to the built-in reader.
 */
export type SurfaceReader = (mesh: THREE.Mesh, vertex: number, material: THREE.Material, out: VertexSurface) => boolean;

export interface MergeOptions {
  /** Meshes that are the exterior hull: front-face-only for rays, never drawn by the G-buffer or composite. */
  exterior?: readonly THREE.Object3D[];
  surface?: SurfaceReader;
  /**
   * Raster grouping key of a mesh (the room it is drawn with). The merged geometry keeps a second, raster index of
   * the non-exterior triangles grouped by this key (in first-seen order), so the G-buffer can draw only the rooms
   * the forward pass draws. Default: '' for every mesh (one group).
   */
  rasterKey?: (mesh: THREE.Mesh) => string;
}

/** The material record a mesh may carry for the ray tracer (src/render/space/surfaces.ts header). */
export interface RtRecord {
  albedo?: readonly number[];
  roughness?: number;
  metalness?: number;
  tiles?: readonly { albedo: readonly number[]; roughness: number; metalness: number }[] | null;
  perVertex?: string | null;
  livery?: { primary: readonly number[]; secondary: readonly number[]; accent: readonly number[] };
  emissive?: boolean;
  glass?: boolean;
  screen?: boolean;
  skip?: boolean;
  role?: string;
}

/** Raster index of the merged scene: triangles grouped by rasterKey, exterior hull left out. */
export interface RasterIndex {
  index: Uint32Array;
  /** key -> [first index, index count] */
  ranges: Map<string, [number, number]>;
}

export interface MergedScene {
  /** Ship-space geometry: position, normal, aSurf (u8n sqrt albedo + rough), aSurf2 (u8n metal, exterior, unlit). Index reordered by the BVH. */
  geometry: THREE.BufferGeometry;
  nodes: Float32Array;
  tris: Float32Array;
  surf: Uint16Array;
  nodeCount: number;
  triangles: number;
  vertices: number;
  /** Rows of each texture (width TEX_W). */
  nodeRows: number;
  triRows: number;
  surfRows: number;
  mergeMs: number;
  buildMs: number;
  packMs: number;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function isExterior(o: THREE.Object3D, ext: readonly THREE.Object3D[] | undefined): boolean {
  const ud = o.userData as { rt?: { role?: string } };
  if (ud.rt?.role === 'exterior') return true;
  if (!ext) return false;
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (ext.includes(p)) return true;
  return false;
}

/** Materials that light does not stop at (glass, additive glows, invisible). */
export function rtSkipsMaterial(m: THREE.Material): boolean {
  const ud = m.userData as { rt?: { skip?: boolean } };
  if (ud.rt?.skip) return true;
  if (!m.visible || m.blending === THREE.AdditiveBlending || !m.colorWrite) return true;
  if (m.transparent && (m.opacity < 0.9 || !m.depthWrite)) return true;
  return false;
}

const tmpColor = new THREE.Color();
interface CpuMap {
  data: ArrayLike<number>;
  w: number;
  h: number;
  half: boolean;
  scale: number;
}
const mapCache = new WeakMap<THREE.Texture, CpuMap | null>();
function cpuMap(t: THREE.Texture | null | undefined): CpuMap | null {
  if (!t) return null;
  if (mapCache.has(t)) return mapCache.get(t) ?? null;
  const img = t.image as { data?: ArrayLike<number>; width?: number; height?: number } | undefined;
  let r: CpuMap | null = null;
  if (img && img.data && img.width && img.height && img.data.length >= img.width * img.height * 4) {
    const half = t.type === THREE.HalfFloatType;
    const scale = t.type === THREE.UnsignedByteType ? 1 / 255 : 1;
    r = { data: img.data, w: img.width, h: img.height, half, scale };
  }
  mapCache.set(t, r);
  return r;
}
function sampleMap(m: CpuMap, u: number, v: number, out: [number, number, number]): void {
  const x = Math.min(m.w - 1, Math.max(0, Math.floor((u - Math.floor(u)) * m.w)));
  const y = Math.min(m.h - 1, Math.max(0, Math.floor((v - Math.floor(v)) * m.h)));
  const o = (y * m.w + x) * 4;
  for (let c = 0; c < 3; c++) {
    const raw = m.data[o + c];
    out[c] = (m.half ? THREE.DataUtils.fromHalfFloat(raw) : raw) * m.scale;
  }
}

const lmTmp: [number, number, number] = [0, 0, 0];
/**
 * Built-in surface reader: the current interior's baked attributes, then standard/basic three.js materials, with
 * the per-mesh material record (mesh.userData.rt: per-tile, per-vertex PBR, livery) taking precedence where given.
 */
function readSurface(geo: THREE.BufferGeometry, i: number, mat: THREE.Material, out: VertexSurface, rec: RtRecord | null = null): void {
  const a = geo.attributes;
  out.metalness = 0;
  out.alt[0] = out.alt[1] = out.alt[2] = 0;
  const aCol = a.aCol as THREE.BufferAttribute | undefined;
  if (aCol) {
    // src/render/space/interior.ts (per-vertex bake): albedo aCol, aMat = (rough, spec, emis/8, group/255)
    const am = a.aMat as THREE.BufferAttribute | undefined;
    const lit = a.aLit as THREE.BufferAttribute | undefined;
    const alt = a.aAlt as THREE.BufferAttribute | undefined;
    out.albedo[0] = aCol.getX(i);
    out.albedo[1] = aCol.getY(i);
    out.albedo[2] = aCol.getZ(i);
    const rough = am ? am.getX(i) : 0.8;
    const spec = am ? am.getY(i) : 0;
    const emis = am ? am.getZ(i) * 8 : 0;
    const grp = am ? Math.round(am.getW(i) * 255) : 0;
    out.roughness = Math.max(0.04, spec > 0.5 ? rough * 0.8 : Math.max(rough, 0.55));
    for (let c = 0; c < 3; c++) {
      const al = out.albedo[c];
      out.lit[c] = al * (lit ? lit.getComponent(i, c) : 0) + (grp === 1 ? al * emis : 0);
      out.alt[c] = al * (alt ? alt.getComponent(i, c) : 0) * 0.45 + (grp > 1 ? al * emis * (grp > 3 ? 0.4 : 1) : 0);
    }
    return;
  }
  const std = mat as THREE.MeshStandardMaterial;
  const col = (mat as THREE.MeshBasicMaterial).color ?? tmpColor.setRGB(0.7, 0.7, 0.7);
  let r = col.r;
  let g = col.g;
  let b = col.b;
  const vc = (mat as THREE.MeshBasicMaterial).vertexColors ? (a.color as THREE.BufferAttribute | undefined) : undefined;
  if (vc) {
    r *= vc.getX(i);
    g *= vc.getY(i);
    b *= vc.getZ(i);
  }
  const tileA = a.tile as THREE.BufferAttribute | undefined; // interior.ts: atlas tile + 16 x glow group
  let tileRough = -1;
  let tileMetal = 0;
  let glow = -1;
  if (tileA) {
    const tv = tileA.getX(i) + 0.25;
    const ti = Math.floor(tv) % 16;
    const rt = rec?.tiles?.[ti];
    const alb = rt ? rt.albedo : (TILE_ALBEDO[TILE_IDS[ti]] ?? [0.5, 0.5, 0.5]);
    r *= alb[0];
    g *= alb[1];
    b *= alb[2];
    tileRough = rt ? rt.roughness : (TILE_ROUGH[ti] ?? 0.6);
    tileMetal = rt ? rt.metalness : (TILE_METAL[ti] ?? 0);
    if (col.r + col.g + col.b < 1e-4 && vc) glow = Math.floor(tv / 16); // the 'glow' material: black base, emissive vertex colour
  }
  const tint = a.aTint as THREE.BufferAttribute | undefined; // ships.ts hull: sqrt(linear) tint, u8n
  let recRough = -1;
  let recMetal = -1;
  if (tint && !vc) {
    r *= tint.getX(i) ** 2;
    g *= tint.getY(i) ** 2;
    b *= tint.getZ(i) ** 2;
    // hull record: x livery colour of slot round(aFx.w * 3); roughness aSurf.z, metalness aSurf.y
    if (rec?.perVertex?.startsWith('aTint')) {
      const fx = a.aFx as THREE.BufferAttribute | undefined;
      const sf = a.aSurf as THREE.BufferAttribute | undefined;
      const slot = fx ? Math.round(fx.getW(i) * 3) : 0;
      const liv = rec.livery;
      const lc = liv ? (slot === 1 ? liv.primary : slot === 2 ? liv.secondary : slot === 3 ? liv.accent : null) : null;
      if (lc) {
        r *= lc[0];
        g *= lc[1];
        b *= lc[2];
      }
      if (sf) {
        recRough = sf.getZ(i);
        recMetal = sf.getY(i);
      }
    }
  }
  const pbr = a.pbr as THREE.BufferAttribute | undefined; // cockpit.ts: vertex colour + pbr (rough, metal)
  if (pbr && rec?.perVertex === 'color+pbr') {
    recRough = pbr.getX(i);
    recMetal = pbr.getY(i);
  }
  if (recRough < 0 && rec && !tileA && !rec.perVertex && typeof rec.roughness === 'number') {
    recRough = rec.roughness;
    recMetal = rec.metalness ?? 0;
  }
  if ((mat as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
    // unlit: the colour already is the exitant radiance (the cockpit's baked vertex colours)
    out.albedo[0] = Math.min(1, r);
    out.albedo[1] = Math.min(1, g);
    out.albedo[2] = Math.min(1, b);
    out.roughness = 0.7;
    out.lit[0] = r;
    out.lit[1] = g;
    out.lit[2] = b;
    return;
  }
  out.albedo[0] = r;
  out.albedo[1] = g;
  out.albedo[2] = b;
  out.roughness = tileRough >= 0 ? tileRough * (std.roughness ?? 1) : recRough >= 0 ? recRough : (std.roughness ?? 0.8);
  out.metalness = tileRough >= 0 ? tileMetal * (std.metalness ?? 1) : recMetal >= 0 ? recMetal : (std.metalness ?? 0);
  out.albedo[0] = Math.min(0.95, out.albedo[0]);
  out.albedo[1] = Math.min(0.95, out.albedo[1]);
  out.albedo[2] = Math.min(0.95, out.albedo[2]);
  out.lit[0] = out.lit[1] = out.lit[2] = 0;
  if (glow >= 0 && vc && tileA) {
    const tv = Math.floor(tileA.getX(i) + 0.25) % 16;
    const alb = TILE_ALBEDO[TILE_IDS[tv]] ?? [0.5, 0.5, 0.5];
    const dst = glow === 0 ? out.lit : out.alt; // group 0 follows the cabin lights
    dst[0] = vc.getX(i) * alb[0] * 2;
    dst[1] = vc.getY(i) * alb[1] * 2;
    dst[2] = vc.getZ(i) * alb[2] * 2;
    out.roughness = 0.6;
    return;
  }
  if (std.lightMap) {
    const m = cpuMap(std.lightMap);
    const uv = (a[`uv${std.lightMap.channel || ''}`] ?? a.uv1 ?? a.uv) as THREE.BufferAttribute | undefined;
    if (m && uv) {
      sampleMap(m, uv.getX(i), std.lightMap.flipY ? 1 - uv.getY(i) : uv.getY(i), lmTmp);
      // three: indirect diffuse = albedo / pi * irradiance. Corvane surfaces (a record with tiles) are designed at
      // lightMapIntensity = pi x display gain, and the gain is applied per frame (RtFrame.bakedGain): use pi here.
      const k = rec?.tiles ? 1 : (std.lightMapIntensity ?? 1) / Math.PI;
      for (let c = 0; c < 3; c++) out.lit[c] = out.albedo[c] * lmTmp[c] * k;
    }
  }
  if (std.emissive) {
    const ei = std.emissiveIntensity ?? 1;
    out.alt[0] = std.emissive.r * ei;
    out.alt[1] = std.emissive.g * ei;
    out.alt[2] = std.emissive.b * ei;
  }
}

/**
 * Merge `meshes` into one ship-space geometry. Vertex positions go through `toShip × mesh.matrixWorld`
 * (toShip = inverse of the ship root's world matrix; identity when the meshes already live in ship-local m).
 */
export function mergeStatic(meshes: readonly THREE.Mesh[], toShip: THREE.Matrix4, opts: MergeOptions = {}): { geometry: THREE.BufferGeometry; surf: Float32Array; ms: number; raster: RasterIndex } {
  const t0 = now();
  interface Part {
    mesh: THREE.Mesh;
    geo: THREE.BufferGeometry;
    tris: [number, number, THREE.Material][]; // index range (start, count) and its material
    ext: boolean;
    key: string;
    start: number;
    end: number;
  }
  const parts: Part[] = [];
  let nv = 0;
  let ni = 0;
  for (const mesh of meshes) {
    const geo = mesh.geometry as THREE.BufferGeometry;
    if (!geo || !geo.attributes.position) continue;
    const ud = mesh.userData as { rt?: { skip?: boolean } };
    if (ud.rt?.skip) continue;
    const count = geo.index ? geo.index.count : geo.attributes.position.count;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const ranges: [number, number, THREE.Material][] = [];
    if (Array.isArray(mesh.material) && geo.groups.length) {
      for (const gr of geo.groups) {
        const m = mats[gr.materialIndex ?? 0];
        if (m && !rtSkipsMaterial(m)) ranges.push([gr.start, Math.min(gr.count, count - gr.start), m]);
      }
    } else if (mats[0] && !rtSkipsMaterial(mats[0])) {
      const dr = geo.drawRange;
      const s = Math.max(0, dr.start);
      ranges.push([s, Math.min(count - s, Number.isFinite(dr.count) ? dr.count : count), mats[0]]);
    }
    if (!ranges.length) continue;
    parts.push({ mesh, geo, tris: ranges, ext: isExterior(mesh, opts.exterior), key: opts.rasterKey ? opts.rasterKey(mesh) : '', start: 0, end: 0 });
    nv += geo.attributes.position.count;
    for (const r of ranges) ni += r[1] - (r[1] % 3);
  }
  // group the parts by raster key (stable): each key's triangles end up contiguous in the raster index
  const keyOrder = new Map<string, number>();
  for (const pt of parts) if (!keyOrder.has(pt.key)) keyOrder.set(pt.key, keyOrder.size);
  parts.sort((x, y) => (keyOrder.get(x.key) as number) - (keyOrder.get(y.key) as number));
  const pos = new Float32Array(nv * 3);
  const nrm = new Float32Array(nv * 3);
  const aSurf = new Uint8Array(nv * 4);
  const aSurf2 = new Uint8Array(nv * 4);
  const surf = new Float32Array(nv * 12);
  const index = new Uint32Array(ni);
  const m4 = new THREE.Matrix4();
  const n3 = new THREE.Matrix3();
  const p = new THREE.Vector3();
  const s: VertexSurface = { albedo: [0, 0, 0], roughness: 0.8, metalness: 0, lit: [0, 0, 0], alt: [0, 0, 0] };
  const seen = new Uint8Array(nv);
  let vb = 0;
  let ib = 0;
  for (const part of parts) {
    const { mesh, geo } = part;
    mesh.updateWorldMatrix(true, false);
    m4.multiplyMatrices(toShip, mesh.matrixWorld);
    n3.getNormalMatrix(m4);
    const P = geo.attributes.position;
    const N = geo.attributes.normal as THREE.BufferAttribute | undefined;
    const vc = P.count;
    for (let i = 0; i < vc; i++) {
      p.fromBufferAttribute(P, i).applyMatrix4(m4);
      pos[(vb + i) * 3] = p.x;
      pos[(vb + i) * 3 + 1] = p.y;
      pos[(vb + i) * 3 + 2] = p.z;
      if (N) {
        p.fromBufferAttribute(N, i).applyMatrix3(n3).normalize();
        nrm[(vb + i) * 3] = p.x;
        nrm[(vb + i) * 3 + 1] = p.y;
        nrm[(vb + i) * 3 + 2] = p.z;
      }
    }
    const idx = geo.index;
    const ib0 = ib;
    const rec = ((mesh.userData as { rt?: RtRecord }).rt ?? null) as RtRecord | null;
    for (const [start, cnt, mat] of part.tris) {
      const n = cnt - (cnt % 3);
      for (let k = 0; k < n; k++) {
        const v = idx ? idx.getX(start + k) : start + k;
        index[ib++] = vb + v;
        if (seen[vb + v]) continue;
        seen[vb + v] = 1;
        if (!opts.surface || !opts.surface(mesh, v, mat, s)) readSurface(geo, v, mat, s, rec);
        const o = (vb + v) * 12;
        surf[o] = s.albedo[0];
        surf[o + 1] = s.albedo[1];
        surf[o + 2] = s.albedo[2];
        surf[o + 3] = s.roughness;
        surf[o + 4] = s.lit[0];
        surf[o + 5] = s.lit[1];
        surf[o + 6] = s.lit[2];
        surf[o + 7] = s.metalness;
        surf[o + 8] = s.alt[0];
        surf[o + 9] = s.alt[1];
        surf[o + 10] = s.alt[2];
        surf[o + 11] = part.ext ? 1 : 0;
        const q = (vb + v) * 4;
        for (let c = 0; c < 3; c++) aSurf[q + c] = Math.round(Math.min(1, Math.sqrt(Math.max(0, s.albedo[c]))) * 255); // sqrt: less banding
        aSurf[q + 3] = Math.round(Math.min(1, Math.max(0, s.roughness)) * 255);
        aSurf2[q] = Math.round(Math.min(1, Math.max(0, s.metalness)) * 255);
        aSurf2[q + 1] = part.ext ? 255 : 0;
        // unlit (MeshBasicMaterial) surfaces never take light in the forward pass: they occlude and show in
        // reflections, but composite() adds nothing to them
        aSurf2[q + 2] = (mat as THREE.MeshBasicMaterial).isMeshBasicMaterial ? 255 : 0;
      }
    }
    if (!N) {
      // flat normals from the triangles (last writer wins on shared vertices; good enough for G-buffer offsets)
      for (let k = ib0; k < ib; k += 3) {
        const a = index[k] * 3, b = index[k + 1] * 3, c = index[k + 2] * 3;
        const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
        const wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2];
        p.set(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx).normalize();
        for (const j of [a, b, c]) {
          nrm[j] = p.x;
          nrm[j + 1] = p.y;
          nrm[j + 2] = p.z;
        }
      }
    }
    part.start = ib0;
    part.end = ib;
    vb += vc;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geometry.setAttribute('aSurf', new THREE.BufferAttribute(aSurf, 4, true));
  geometry.setAttribute('aSurf2', new THREE.BufferAttribute(aSurf2, 4, true));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  // the raster index (before the BVH build reorders `index`): interior triangles only, grouped by key
  const ranges = new Map<string, [number, number]>();
  let rn = 0;
  for (const pt of parts) if (!pt.ext) rn += pt.end - pt.start;
  const rindex = new Uint32Array(rn);
  let ro = 0;
  for (const pt of parts) {
    if (pt.ext || pt.end <= pt.start) continue;
    rindex.set(index.subarray(pt.start, pt.end), ro);
    const r = ranges.get(pt.key);
    if (r) r[1] += pt.end - pt.start;
    else ranges.set(pt.key, [ro, pt.end - pt.start]);
    ro += pt.end - pt.start;
  }
  return { geometry, surf, ms: now() - t0, raster: { index: rindex, ranges } };
}

/** Build the BVH over a merged geometry (reorders its index in place) and pack everything into texture arrays. */
export function buildPacked(geometry: THREE.BufferGeometry, surf: Float32Array, mergeMs = 0): MergedScene {
  const t0 = now();
  // SAH (binned), small leaves: fewer triangle tests per ray, which is what the phone pays for. Measured in
  // node on 604k triangles: SAH 1.2-1.3 s, CENTER 0.28 s, so big scenes take CENTER to stay inside ~1.5 s on a phone.
  const strategy = (geometry.index?.count ?? 0) / 3 > SAH_LIMIT ? CENTER : SAH;
  const bvh = new MeshBVH(geometry, { strategy, maxDepth: MAX_DEPTH, targetLeafSize: 4, setBoundingBox: false, indirect: false, verbose: false });
  const t1 = now();
  const roots = (bvh as unknown as { _roots: ArrayBuffer[] })._roots;
  if (roots.length !== 1) throw new Error(`rt: BVH has ${roots.length} roots (geometry groups?)`);
  const root = roots[0];
  const f32 = new Float32Array(root);
  const u32 = new Uint32Array(root);
  const u16 = new Uint16Array(root);
  const nodeCount = root.byteLength / 32;
  const nodeRows = Math.ceil((nodeCount * 2) / TEX_W);
  const nodes = new Float32Array(nodeRows * TEX_W * 4);
  for (let n = 0; n < nodeCount; n++) {
    const n32 = n * 8;
    const o = n * 8;
    nodes[o] = f32[n32];
    nodes[o + 1] = f32[n32 + 1];
    nodes[o + 2] = f32[n32 + 2];
    nodes[o + 4] = f32[n32 + 3];
    nodes[o + 5] = f32[n32 + 4];
    nodes[o + 6] = f32[n32 + 5];
    if (u16[n32 * 2 + 15] === 0xffff) {
      nodes[o + 3] = 3 + u16[n32 * 2 + 14];
      nodes[o + 7] = u32[n32 + 6];
    } else {
      nodes[o + 3] = u32[n32 + 7];
      nodes[o + 7] = n + u32[n32 + 6];
    }
  }
  const pos = geometry.attributes.position.array as Float32Array;
  const idx = geometry.index!.array as Uint32Array;
  const triangles = idx.length / 3;
  const vertices = pos.length / 3;
  if (vertices >= FRONT_ONLY) throw new Error('rt: too many vertices for the packed triangle format');
  const triRows = Math.max(1, Math.ceil((triangles * 3) / TEX_W));
  const tris = new Float32Array(triRows * TEX_W * 4);
  for (let t = 0; t < triangles; t++) {
    const ia = idx[t * 3], ib = idx[t * 3 + 1], ic = idx[t * 3 + 2];
    const o = t * 12;
    const ax = pos[ia * 3], ay = pos[ia * 3 + 1], az = pos[ia * 3 + 2];
    tris[o] = ax;
    tris[o + 1] = ay;
    tris[o + 2] = az;
    tris[o + 3] = ia + (surf[ia * 12 + 11] > 0.5 ? FRONT_ONLY : 0);
    tris[o + 4] = pos[ib * 3] - ax;
    tris[o + 5] = pos[ib * 3 + 1] - ay;
    tris[o + 6] = pos[ib * 3 + 2] - az;
    tris[o + 7] = ib;
    tris[o + 8] = pos[ic * 3] - ax;
    tris[o + 9] = pos[ic * 3 + 1] - ay;
    tris[o + 10] = pos[ic * 3 + 2] - az;
    tris[o + 11] = ic;
  }
  const surfRows = Math.max(1, Math.ceil((vertices * 3) / TEX_W));
  const half = new Uint16Array(surfRows * TEX_W * 4);
  const toHalf = THREE.DataUtils.toHalfFloat;
  for (let i = 0; i < surf.length; i++) half[i] = toHalf(Math.min(60000, surf[i]));
  const t2 = now();
  return { geometry, nodes, tris, surf: half, nodeCount, triangles, vertices, nodeRows, triRows, surfRows, mergeMs, buildMs: t1 - t0, packMs: t2 - t1 };
}

// ================================================================================== JS mirror of the GLSL

export interface TraceCounters {
  nodes: number;
  tris: number;
}
export interface Hit {
  t: number;
  tri: number;
  u: number;
  v: number;
}

const INF = 1e30;
function slab(n: Float32Array, node: number, ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, tMax: number): number {
  const o = node * 8;
  let t0 = (n[o] - ox) * ix, t1 = (n[o + 4] - ox) * ix;
  let tn = Math.min(t0, t1), tf = Math.max(t0, t1);
  t0 = (n[o + 1] - oy) * iy;
  t1 = (n[o + 5] - oy) * iy;
  tn = Math.max(tn, Math.min(t0, t1));
  tf = Math.min(tf, Math.max(t0, t1));
  t0 = (n[o + 2] - oz) * iz;
  t1 = (n[o + 6] - oz) * iz;
  tn = Math.max(tn, Math.min(t0, t1), 0);
  tf = Math.min(tf, Math.max(t0, t1), tMax);
  return tn <= tf ? tn : INF;
}
const safeInv = (d: number): number => 1 / (Math.abs(d) < 1e-12 ? (d < 0 ? -1e-12 : 1e-12) : d);

/** Möller–Trumbore against packed triangle t; returns t or INF. Same rules as the GLSL. */
export function triangleHit(tr: Float32Array, t: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMax: number, uv?: { u: number; v: number }): number {
  const o = t * 12;
  const e1x = tr[o + 4], e1y = tr[o + 5], e1z = tr[o + 6];
  const e2x = tr[o + 8], e2y = tr[o + 9], e2z = tr[o + 10];
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  const front = tr[o + 3] >= FRONT_ONLY;
  if (front ? det <= 1e-12 : Math.abs(det) <= 1e-12) return INF;
  const inv = 1 / det;
  const sx = ox - tr[o], sy = oy - tr[o + 1], sz = oz - tr[o + 2];
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return INF;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return INF;
  const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
  if (!(tt > 1e-4 && tt < tMax)) return INF;
  if (uv) {
    uv.u = u;
    uv.v = v;
  }
  return tt;
}

const stackN = new Int32Array(STACK_SIZE);
const stackT = new Float32Array(STACK_SIZE);
const uvTmp = { u: 0, v: 0 };
/**
 * Trace one ray through the packed BVH. `any` = stop at the first hit (shadow rays). Returns null on a miss.
 * When the iteration cap is hit an any-hit query reports a hit (no light leaks), a closest-hit one what it has.
 */
export function trace(s: Pick<MergedScene, 'nodes' | 'tris'>, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMax: number, any: boolean, c?: TraceCounters, out?: Hit): Hit | null {
  const n = s.nodes;
  const ix = safeInv(dx), iy = safeInv(dy), iz = safeInv(dz);
  let best = tMax;
  let bestTri = -1;
  let bu = 0, bv = 0;
  let sp = 0;
  let node = 0;
  if (slab(n, 0, ox, oy, oz, ix, iy, iz, best) >= INF) return null;
  for (let it = 0; it < MAX_ITERS; it++) {
    if (c) c.nodes++;
    const w0 = n[node * 8 + 3];
    const w1 = n[node * 8 + 7];
    let next = -1;
    if (w0 >= 3) {
      const cnt = w0 - 3;
      for (let k = 0; k < cnt; k++) {
        if (c) c.tris++;
        const t = triangleHit(s.tris, w1 + k, ox, oy, oz, dx, dy, dz, best, uvTmp);
        if (t < best) {
          best = t;
          bestTri = w1 + k;
          bu = uvTmp.u;
          bv = uvTmp.v;
          if (any) break;
        }
      }
      if (any && bestTri >= 0) break;
    } else {
      const L = node + 1, R = w1;
      const tl = slab(n, L, ox, oy, oz, ix, iy, iz, best);
      const tr = slab(n, R, ox, oy, oz, ix, iy, iz, best);
      if (tl < INF && tr < INF) {
        const near = tl <= tr;
        next = near ? L : R;
        if (sp < STACK_SIZE) {
          stackN[sp] = near ? R : L;
          stackT[sp] = near ? tr : tl;
          sp++;
        }
      } else if (tl < INF) next = L;
      else if (tr < INF) next = R;
    }
    while (next < 0 && sp > 0) {
      sp--;
      if (stackT[sp] < best) next = stackN[sp];
    }
    if (next < 0) {
      if (bestTri < 0) return null;
      break;
    }
    node = next;
    if (it === MAX_ITERS - 1) {
      if (any) bestTri = Math.max(bestTri, 0);
      if (bestTri < 0) return null;
    }
  }
  const h = out ?? { t: 0, tri: 0, u: 0, v: 0 };
  h.t = best;
  h.tri = bestTri;
  h.u = bu;
  h.v = bv;
  return h;
}

/** Brute force over every packed triangle (tests). */
export function traceBrute(s: Pick<MergedScene, 'tris' | 'triangles'>, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMax: number): Hit | null {
  let best = tMax;
  let tri = -1;
  for (let t = 0; t < s.triangles; t++) {
    const d = triangleHit(s.tris, t, ox, oy, oz, dx, dy, dz, best);
    if (d < best) {
      best = d;
      tri = t;
    }
  }
  return tri < 0 ? null : { t: best, tri, u: 0, v: 0 };
}

/**
 * Average traversal work per ray, from deterministic rays leaving random surface points (cosine directions
 * about the face normal, either side), for the GPU cost model. ~2k rays, a few ms.
 */
export function measureWork(s: MergedScene, rays = 2048): { closest: TraceCounters; any: TraceCounters; hitFraction: number } {
  let seed = 0x9e3779b9;
  const rnd = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const closest = { nodes: 0, tris: 0 };
  const any = { nodes: 0, tris: 0 };
  let hits = 0;
  const tr = s.tris;
  for (let r = 0; r < rays; r++) {
    const t = Math.min(s.triangles - 1, Math.floor(rnd() * s.triangles));
    const o = t * 12;
    if (tr[o + 3] >= FRONT_ONLY) continue; // rays start on cabin surfaces
    let a = rnd(), b = rnd();
    if (a + b > 1) {
      a = 1 - a;
      b = 1 - b;
    }
    let nx = tr[o + 5] * tr[o + 10] - tr[o + 6] * tr[o + 9];
    let ny = tr[o + 6] * tr[o + 8] - tr[o + 4] * tr[o + 10];
    let nz = tr[o + 4] * tr[o + 9] - tr[o + 5] * tr[o + 8];
    const nl = Math.hypot(nx, ny, nz) || 1;
    const side = rnd() < 0.5 ? -1 : 1;
    nx = (nx / nl) * side;
    ny = (ny / nl) * side;
    nz = (nz / nl) * side;
    const px = tr[o] + a * tr[o + 4] + b * tr[o + 8] + nx * 0.01;
    const py = tr[o + 1] + a * tr[o + 5] + b * tr[o + 9] + ny * 0.01;
    const pz = tr[o + 2] + a * tr[o + 6] + b * tr[o + 10] + nz * 0.01;
    // cosine direction about n
    const u1 = rnd(), u2 = rnd();
    const rr = Math.sqrt(u1), ph = 2 * Math.PI * u2;
    const lx = rr * Math.cos(ph), ly = rr * Math.sin(ph), lz = Math.sqrt(1 - u1);
    const tx0 = Math.abs(nx) > 0.9 ? 0 : 1, ty0 = Math.abs(nx) > 0.9 ? 1 : 0;
    // t = normalize(cross(n, axis)), b = cross(n, t)
    let tx = ny * 0 - nz * ty0, ty = nz * tx0 - nx * 0, tz = nx * ty0 - ny * tx0;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    const dx = tx * lx + bx * ly + nx * lz, dy = ty * lx + by * ly + ny * lz, dz = tz * lx + bz * ly + nz * lz;
    if (trace(s, px, py, pz, dx, dy, dz, 1e4, false, closest)) hits++;
    trace(s, px, py, pz, dx, dy, dz, 1e4, true, any);
  }
  const k = 1 / rays;
  return { closest: { nodes: closest.nodes * k, tris: closest.tris * k }, any: { nodes: any.nodes * k, tris: any.tris * k }, hitFraction: hits * k };
}
