// Light inside the player's ship, and the live environment outside it.
//
//   rooms        the interior is drawn by room (mesh / group userData.room = a room id of src/data/interiors.ts,
//                inherited from the nearest tagged ancestor; untagged meshes are placed by their centre). Each
//                frame only the camera's room and the rooms seen through the door openings are visible: a
//                portal test on the door boxes, narrowing the screen rectangle at every door. Invisible rooms
//                neither draw, cast nor receive shadows.
//   sun          a directional light from the real star direction (colour and intensity from the scene's key
//                light, eclipse included) with a PCF-soft shadow map fitted to a sphere around the visible
//                rooms. The light-space grid is anchored to the ship and snapped to whole texels, so the patches
//                on the floor do not shimmer while the crew walks; they move only when the ship turns.
//                The shell is closed and opaque, so its light arrives only through the window openings.
//   planetshine  (high / ultra) a second, shadowed directional light from the nearby world in its albedo colour,
//                its map refreshed every third frame. Without a shadow it would leak through the bulkheads, so
//                the lower tiers leave it to the probes.
//   probes       one reflection probe per room (rooms under 3 m² share their larger neighbour's), captured with
//                the cabin lights only (no sun: its patches move, the probe does not), at load and again after
//                the cabin lights change, one cube face per frame; PMREM-filtered; applied box-projected
//                (parallax-corrected in ship-local space) by patching MeshStandardMaterial /
//                MeshPhysicalMaterial through onBeforeCompile — one shader variant for every probe. A material
//                shared by rooms with different probes is cloned per probe and kept in step with its source.
//   outside      the hull's reflection environment: the far scene (sky and worlds, the star's disc left out —
//                the key light gives its highlight) captured into a small cube one face every few frames and
//                PMREM-filtered, so the hull reflects the planet below it.
//
// All renders here happen before the pipeline starts its HDR target (no mid-frame framebuffer switch on the
// tile GPU); their draw calls are counted in `stats`. No allocation per frame.

import * as THREE from 'three';
import type { V3 } from '../core/types';
import type { Box, InteriorLayout } from '../data/interiors';
import { TIER_SETTINGS, type PerfTier } from '../app/perf';

type Quality = PerfTier;

export interface InteriorLightingFrame {
  /** Camera eye, ship-local m. */
  eye: V3;
  /** Unit direction to the star in the inside scene's world axes; colour; three.js intensity (π × level on white). */
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  sunIntensity: number;
  /** Planetshine: direction to the world, its colour, intensity (same units). */
  shineDir: THREE.Vector3;
  shineColor: THREE.Color;
  shineIntensity: number;
  /** Cabin lights on (a change recaptures the probes once the lights have settled). */
  lights: boolean;
  dt: number;
}

export interface InteriorLightingStats {
  rooms: number;
  roomsTotal: number;
  /** Camera's room id ('' = outside every room: everything is drawn). */
  room: string;
  /** Draw calls / triangles of this frame's shadow maps and probe captures. */
  drawCalls: number;
  triangles: number;
  probes: number;
  probeSize: number;
  probeBytes: number;
  shadowBytes: number;
  /** Probe faces still to capture. */
  pending: number;
  /** Materials patched for box-projected probes (clones included). */
  patched: number;
  /** Bytes of the interior's own textures (estimate). */
  textureBytes: number;
}

interface RoomInfo {
  id: string;
  box: Box;
  nodes: THREE.Object3D[];
  /** door index, other room index */
  links: [number, number][];
  probe: number;
  visible: boolean;
  /** Outward normals of its windows (ship-local); empty = no window. */
  windows: V3[];
  /** Casters other than the shell: they cast only while light can come in through a window. */
  casters: THREE.Mesh[];
  /** Seen only through a small opening this frame (portal rectangle under ~2 % of the screen). */
  far: boolean;
}

interface Probe {
  rooms: number[];
  /** Rooms drawn while capturing (the probe's rooms and their door neighbours). */
  show: boolean[];
  pos: THREE.Vector3;
  uMin: { value: THREE.Vector3 };
  uMax: { value: THREE.Vector3 };
  uPos: { value: THREE.Vector3 };
  rt: THREE.WebGLRenderTarget | null;
}

interface Clone {
  src: THREE.MeshStandardMaterial;
  dst: THREE.MeshStandardMaterial;
  version: number;
}

const BP_KEY = '|tl-boxprobe-1';
const SMALL_ROOM_M2 = 3;
const LIGHTS_SETTLE_S = 0.8;
const NEAR = 0.05;

// ------------------------------------------------------------------------------------------- shader patch

const BP_HEAD = /* glsl */ `
#ifdef USE_ENVMAP
uniform mat4 uBpToLocal;
uniform vec3 uBpMin;
uniform vec3 uBpMax;
uniform vec3 uBpPos;
varying vec3 vBpWorld;
#ifdef USE_LIGHTMAP
#define BP_IRR 0.0
#else
#define BP_IRR 1.0
#endif
// world direction -> the probe's (ship-local) cube direction, parallax-corrected against the room box
vec3 bpReflDir(vec3 dirWorld, float roughness) {
  vec3 d = normalize(mat3(uBpToLocal) * dirWorld);
  vec3 p = (uBpToLocal * vec4(vBpWorld, 1.0)).xyz;
  vec3 inside = step(uBpMin - 0.1, p) * step(p, uBpMax + 0.1);
  if (inside.x * inside.y * inside.z < 0.5) return d;
  vec3 t1 = (uBpMax - p) / d;
  vec3 t2 = (uBpMin - p) / d;
  vec3 tf = max(t1, t2);
  float t = max(min(min(tf.x, tf.y), tf.z), 0.0);
  vec3 bp = normalize(p + d * t - uBpPos);
  // a wide lobe has no single hit point: fade the correction out with roughness
  return normalize(mix(bp, d, roughness * roughness));
}
vec3 bpIrrDir(vec3 nWorld) { return normalize(mat3(uBpToLocal) * nWorld); }
#endif
`;

let patchedChunk: string | null | undefined;
function boxProjectedChunk(): string | null {
  if (patchedChunk !== undefined) return patchedChunk;
  let c = THREE.ShaderChunk.envmap_physical_pars_fragment;
  const a = 'textureCubeUV( envMap, envMapRotation * worldNormal, 1.0 )';
  const b = 'textureCubeUV( envMap, envMapRotation * reflectVec, roughness )';
  const irr = 'return PI * envMapColor.rgb * envMapIntensity;';
  if (!c.includes(a) || !c.includes(b) || !c.includes(irr)) {
    patchedChunk = null;
    return null;
  }
  c = c
    .replace(a, 'textureCubeUV( envMap, bpIrrDir( worldNormal ), 1.0 )')
    .replace(b, 'textureCubeUV( envMap, bpReflDir( reflectVec, roughness ), roughness )')
    .replace(irr, 'return PI * envMapColor.rgb * envMapIntensity * BP_IRR;');
  patchedChunk = BP_HEAD + c;
  return patchedChunk;
}

const BP_VERT_DECL = '#include <common>\nvarying vec3 vBpWorld;';
const BP_VERT_MAIN = /* glsl */ `#include <worldpos_vertex>
  vec4 bpW = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
  bpW = batchingMatrix * bpW;
#endif
#ifdef USE_INSTANCING
  bpW = instanceMatrix * bpW;
#endif
  vBpWorld = ( modelMatrix * bpW ).xyz;`;

/** Bytes of GPU memory a texture holds (estimate: 4 B/px, ×4/3 with mipmaps; half-float 8 B/px). */
function textureBytes(t: THREE.Texture): number {
  type Img = { width?: number; height?: number } | null | undefined;
  const img = t.image as Img | Img[];
  if (!img) return 0;
  const faces: Img[] = Array.isArray(img) ? img : [img];
  let px = 0;
  for (const f of faces) px += (f?.width ?? 0) * (f?.height ?? 0);
  const bpp = t.type === THREE.HalfFloatType ? 8 : t.type === THREE.FloatType ? 16 : 4;
  const mips = t.generateMipmaps && t.minFilter !== THREE.LinearFilter && t.minFilter !== THREE.NearestFilter;
  return px * bpp * (mips ? 4 / 3 : 1);
}

/** Estimated GPU bytes of every texture the materials under `root` use (each texture counted once). */
export function textureBytesOf(root: THREE.Object3D, seen: Set<THREE.Texture> = new Set()): number {
  let bytes = 0;
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (!m) return;
    const list = Array.isArray(m) ? m : [m];
    for (const mat of list) {
      for (const key of Object.keys(mat)) {
        const v = (mat as unknown as Record<string, unknown>)[key];
        if (v instanceof THREE.Texture && !seen.has(v)) {
          seen.add(v);
          bytes += textureBytes(v);
        }
      }
      const u = (mat as THREE.ShaderMaterial).uniforms;
      if (u)
        for (const k of Object.keys(u)) {
          const v = u[k]?.value;
          if (v instanceof THREE.Texture && !seen.has(v)) {
            seen.add(v);
            bytes += textureBytes(v);
          }
        }
    }
  });
  return bytes;
}

const inBox = (b: Box, x: number, y: number, z: number, m: number): boolean =>
  x >= b.min.x - m && x <= b.max.x + m && y >= b.min.y - m && y <= b.max.y + m && z >= b.min.z - m && z <= b.max.z + m;

// ------------------------------------------------------------------------------------------- interior

export class InteriorLighting {
  readonly sun = new THREE.DirectionalLight(0xffffff, 0);
  readonly shine: THREE.DirectionalLight | null;
  readonly stats: InteriorLightingStats;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly root: THREE.Object3D;
  private readonly layout: InteriorLayout;
  private readonly rooms: RoomInfo[] = [];
  private readonly roomIndex = new Map<string, number>();
  private readonly probes: Probe[] = [];
  private readonly clones: Clone[] = [];
  private readonly lightList: THREE.DirectionalLight[] = [];
  private readonly shadowEvery: number;
  private readonly shadowSize: number;
  private readonly shineSize: number;
  private readonly probeSize: number;

  // probes
  private readonly uToLocal = { value: new THREE.Matrix4() };
  private cubeRT: THREE.WebGLCubeRenderTarget | null = null;
  private readonly cubeCam: THREE.CubeCamera | null = null;
  private pmrem: THREE.PMREMGenerator | null = null;
  private queue = 0; // faces left: probe = floor((total - queue) / 6)
  private queueStart = 0;
  private settle = 0;
  private lastLights: boolean | null = null;
  private patchOk = false;

  // per-frame scratch
  private readonly mv = new THREE.Matrix4();
  private readonly tv = new THREE.Vector3();
  private readonly tv2 = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private readonly anchor = new THREE.Vector3();
  private readonly axisR = new THREE.Vector3();
  private readonly axisU = new THREE.Vector3();
  private readonly rq = new THREE.Quaternion();
  private readonly rect = new Float32Array(4);
  private frameNo = 0;
  private allVisible = false;
  private visibleCount = 0;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, root: THREE.Object3D, layout: InteriorLayout, quality: Quality) {
    this.renderer = renderer;
    this.scene = scene;
    this.root = root;
    this.layout = layout;
    const tier = TIER_SETTINGS[quality] ?? TIER_SETTINGS.medium;
    this.shadowSize = tier.shadow;
    this.shineSize = tier.shineShadow;
    this.shadowEvery = Math.max(1, tier.shadowEvery);
    this.probeSize = tier.probe;

    const sun = this.sun;
    sun.name = 'interior-sun';
    sun.castShadow = true;
    sun.shadow.mapSize.set(this.shadowSize, this.shadowSize);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.025;
    sun.shadow.autoUpdate = this.shadowEvery === 1;
    scene.add(sun, sun.target);
    this.lightList.push(sun);
    if (this.shineSize > 0) {
      const sh = new THREE.DirectionalLight(0xffffff, 0);
      sh.name = 'interior-planetshine';
      sh.castShadow = true;
      sh.shadow.mapSize.set(this.shineSize, this.shineSize);
      sh.shadow.bias = -0.0008;
      sh.shadow.normalBias = 0.04;
      sh.shadow.autoUpdate = false;
      scene.add(sh, sh.target);
      this.lightList.push(sh);
      this.shine = sh;
    } else this.shine = null;

    // rooms and their door links
    for (const r of layout.rooms) {
      this.roomIndex.set(r.id, this.rooms.length);
      const windows: V3[] = layout.windows
        .filter((w) => w.room === r.id)
        .map((w) => ({ x: w.wall === '+x' ? 1 : w.wall === '-x' ? -1 : 0, y: w.wall === '+y' ? 1 : 0, z: w.wall === '+z' ? 1 : w.wall === '-z' ? -1 : 0 }));
      this.rooms.push({ id: r.id, box: r.box, nodes: [], links: [], probe: -1, visible: true, windows, casters: [], far: false });
    }
    layout.doors.forEach((d, i) => {
      const a = this.roomIndex.get(d.a);
      const b = this.roomIndex.get(d.b);
      if (a === undefined || b === undefined) return;
      this.rooms[a].links.push([i, b]);
      this.rooms[b].links.push([i, a]);
    });
    // probe groups: every room its own, except small rooms, which share their largest neighbour's
    const area = (b: Box): number => (b.max.x - b.min.x) * (b.max.z - b.min.z);
    for (let i = 0; i < this.rooms.length; i++) {
      const r = this.rooms[i];
      if (area(r.box) >= SMALL_ROOM_M2 || r.links.length === 0) continue;
      let best = -1;
      for (const [, o] of r.links) if (area(this.rooms[o].box) >= SMALL_ROOM_M2 && (best < 0 || area(this.rooms[o].box) > area(this.rooms[best].box))) best = o;
      if (best >= 0) r.probe = -2 - best; // resolved below
    }
    for (let i = 0; i < this.rooms.length; i++) {
      if (this.rooms[i].probe !== -1) continue;
      this.rooms[i].probe = this.probes.length;
      this.probes.push(this.newProbe([i]));
    }
    for (let i = 0; i < this.rooms.length; i++) {
      const r = this.rooms[i];
      if (r.probe >= -1) continue;
      const host = this.rooms[-2 - r.probe];
      r.probe = host.probe;
      const p = this.probes[r.probe];
      p.rooms.push(i);
      p.uMin.value.min(this.tv.set(r.box.min.x, r.box.min.y, r.box.min.z));
      p.uMax.value.max(this.tv.set(r.box.max.x, r.box.max.y, r.box.max.z));
    }
    for (const p of this.probes) {
      for (const ri of p.rooms) {
        p.show[ri] = true;
        for (const [, o] of this.rooms[ri].links) p.show[o] = true;
      }
    }

    if (this.probeSize > 0) {
      this.cubeRT = new THREE.WebGLCubeRenderTarget(this.probeSize, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, depthBuffer: true });
      const cam = new THREE.CubeCamera(NEAR, 60, this.cubeRT);
      cam.coordinateSystem = renderer.coordinateSystem;
      cam.updateCoordinateSystem();
      this.cubeCam = cam;
      this.pmrem = new THREE.PMREMGenerator(renderer);
    }

    this.stats = {
      rooms: this.rooms.length,
      roomsTotal: this.rooms.length,
      room: '',
      drawCalls: 0,
      triangles: 0,
      probes: this.probes.length,
      probeSize: this.probeSize,
      probeBytes: 0,
      shadowBytes: (this.shadowSize * this.shadowSize + this.shineSize * this.shineSize) * 4,
      pending: 0,
      patched: 0,
      textureBytes: 0,
    };
  }

  private newProbe(rooms: number[]): Probe {
    const b = this.rooms[rooms[0]].box;
    const min = new THREE.Vector3(b.min.x, b.min.y, b.min.z);
    const max = new THREE.Vector3(b.max.x, b.max.y, b.max.z);
    const pos = min.clone().add(max).multiplyScalar(0.5);
    return { rooms, show: this.rooms.map(() => false), pos, uMin: { value: min }, uMax: { value: max }, uPos: { value: pos }, rt: null };
  }

  /**
   * Collect the room nodes under the root, patch the PBR materials for their probes and allocate the probe
   * targets. Call once, after everything that rides with the interior (the cockpit) has been added.
   */
  attach(): void {
    for (const r of this.rooms) r.nodes.length = 0;
    const box = new THREE.Box3();
    const c = new THREE.Vector3();
    this.root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    const byMat = new Map<THREE.Material, Map<number, THREE.MeshStandardMaterial>>();
    const visit = (o: THREE.Object3D, inherited: number): void => {
      let room = inherited;
      const tag = o.userData?.room;
      if (inherited < 0 && o !== this.root && typeof tag === 'string' && this.roomIndex.has(tag)) {
        // the outermost tagged node is toggled as a whole; everything under it belongs to that room
        room = this.roomIndex.get(tag) as number;
        this.rooms[room].nodes.push(o);
      }
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        let probeRoom = room;
        if (probeRoom < 0 && mesh.geometry) {
          // untagged: the room that holds its centre (drawn always, but it still needs the right probe)
          if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
          box.copy(mesh.geometry.boundingBox as THREE.Box3).applyMatrix4(mesh.matrixWorld).applyMatrix4(inv);
          box.getCenter(c);
          probeRoom = this.roomAt(c.x, c.y, c.z);
        }
        if (probeRoom >= 0) this.patchMesh(mesh, this.rooms[probeRoom].probe, byMat);
      }
      for (const ch of o.children) visit(ch, room);
    };
    visit(this.root, -1);
    this.pruneCasters();
    this.stats.patched = this.patchOk ? [...byMat.values()].reduce((n, m) => n + m.size, 0) : 0;
    this.stats.textureBytes = textureBytesOf(this.root);
    this.allocProbes();
  }

  /**
   * In a room the light cannot enter (no window, or none facing the light) everything inside is in the shadow of
   * its shell: there only the shell (meshes spanning most of the room) casts, the furniture does not. Windowless
   * rooms are pruned once here; rooms with windows switch their furniture per frame (see castersFor).
   */
  private pruneCasters(): void {
    const box = new THREE.Box3();
    const size = new THREE.Vector3();
    const inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    for (const room of this.rooms) {
      room.casters.length = 0;
      const lit = room.windows.length > 0;
      const b = room.box;
      const diag = Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
      for (const n of room.nodes)
        n.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh || !m.castShadow || !m.geometry) return;
          if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
          box.copy(m.geometry.boundingBox as THREE.Box3);
          if ((m as THREE.InstancedMesh).isInstancedMesh) {
            const im = m as THREE.InstancedMesh;
            if (!im.boundingBox) im.computeBoundingBox();
            box.copy(im.boundingBox as THREE.Box3);
          }
          box.applyMatrix4(m.matrixWorld).applyMatrix4(inv).getSize(size);
          if (size.length() >= 0.6 * diag) return;
          if (lit) room.casters.push(m);
          else m.castShadow = false;
        });
    }
  }

  private roomAt(x: number, y: number, z: number): number {
    for (let i = 0; i < this.rooms.length; i++) if (inBox(this.rooms[i].box, x, y, z, 0.02)) return i;
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < this.rooms.length; i++) {
      const b = this.rooms[i].box;
      const dx = Math.max(b.min.x - x, 0, x - b.max.x);
      const dy = Math.max(b.min.y - y, 0, y - b.max.y);
      const dz = Math.max(b.min.z - z, 0, z - b.max.z);
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return bd < 1 ? best : -1;
  }

  private patchMesh(mesh: THREE.Mesh, probe: number, byMat: Map<THREE.Material, Map<number, THREE.MeshStandardMaterial>>): void {
    if (this.probeSize <= 0 || probe < 0) return;
    const chunk = boxProjectedChunk();
    if (!chunk) return;
    this.patchOk = true;
    const one = (m: THREE.Material): THREE.Material => {
      const std = m as THREE.MeshStandardMaterial;
      if (!std.isMeshStandardMaterial) return m;
      let per = byMat.get(m);
      if (!per) {
        per = new Map();
        byMat.set(m, per);
      }
      const have = per.get(probe);
      if (have) return have;
      // the first probe that meets a material patches it in place; later ones get a synced clone
      const dst = per.size === 0 ? std : (std.clone() as THREE.MeshStandardMaterial);
      if (dst !== std) this.clones.push({ src: std, dst, version: std.version });
      this.patchMaterial(dst, std, this.probes[probe]);
      per.set(probe, dst);
      return dst;
    };
    if (Array.isArray(mesh.material)) mesh.material = mesh.material.map(one);
    else mesh.material = one(mesh.material);
  }

  /** The source materials' own onBeforeCompile and program key, before any probe patch. */
  private readonly origin = new WeakMap<THREE.Material, { obc: THREE.Material['onBeforeCompile']; key: string }>();

  private patchMaterial(mat: THREE.MeshStandardMaterial, src: THREE.MeshStandardMaterial, p: Probe): void {
    let o = this.origin.get(src);
    if (!o) {
      o = { obc: src.onBeforeCompile, key: src.customProgramCacheKey() };
      this.origin.set(src, o);
    }
    const prev = o.obc;
    const prevKey = o.key;
    const toLocal = this.uToLocal;
    const chunk = boxProjectedChunk() as string;
    mat.onBeforeCompile = (sh, r) => {
      prev.call(src, sh, r);
      sh.uniforms.uBpToLocal = toLocal;
      sh.uniforms.uBpMin = p.uMin;
      sh.uniforms.uBpMax = p.uMax;
      sh.uniforms.uBpPos = p.uPos;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', BP_VERT_DECL).replace('#include <worldpos_vertex>', BP_VERT_MAIN);
      sh.fragmentShader = sh.fragmentShader.replace('#include <envmap_physical_pars_fragment>', chunk);
    };
    mat.customProgramCacheKey = () => prevKey + BP_KEY;
    mat.userData.tlProbe = p;
    mat.needsUpdate = true;
  }

  /** Probe targets exist before anything compiles, so the probe's texture size (part of the program) never changes. */
  private allocProbes(): void {
    const pm = this.pmrem;
    const cube = this.cubeRT;
    if (!pm || !cube || !this.patchOk) return;
    let bytes = 0;
    for (const p of this.probes) {
      if (!p.rt) p.rt = pm.fromCubemap(cube.texture);
      bytes += p.rt.width * p.rt.height * 8;
    }
    bytes += cube.width * cube.height * 6 * 8 * 2; // the capture cube + PMREM's ping-pong (about the same)
    this.stats.probeBytes = bytes;
    this.root.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (!m) return;
      for (const mat of Array.isArray(m) ? m : [m]) {
        const p = mat.userData.tlProbe as Probe | undefined;
        if (p && p.rt) (mat as THREE.MeshStandardMaterial).envMap = p.rt.texture;
      }
    });
  }

  /**
   * Loading: draw every room once with every light so all programs (shadow depth variants included) compile
   * now, then capture every probe. `camera` is the interior camera.
   */
  warmUp(camera: THREE.PerspectiveCamera): void {
    const r = this.renderer;
    for (const room of this.rooms) for (const n of room.nodes) n.visible = true;
    this.root.updateMatrixWorld(true);
    this.updateToLocal();
    const d = new THREE.Vector3(0.3, 0.8, -0.5).normalize();
    this.fit(this.sun, d, this.wholeShip(), this.shadowSize);
    this.sun.intensity = 1;
    if (this.shine) {
      this.fit(this.shine, d.set(-0.5, -0.7, 0.2).normalize(), this.wholeShip(), this.shineSize);
      this.shine.intensity = 0.1;
    }
    r.compile(this.scene, camera);
    for (const l of this.lightList) l.shadow.needsUpdate = true;
    this.renderShadows();
    // every probe, all faces, now (behind the loading bar)
    this.queue = this.probes.length * 6;
    this.queueStart = this.queue;
    while (this.queue > 0) this.captureStep();
    this.sun.intensity = 0;
    if (this.shine) this.shine.intensity = 0;
  }

  private wholeShip(): Box {
    const b = this.rooms[0].box;
    const out: Box = { min: { ...b.min }, max: { ...b.max } };
    for (const r of this.rooms) {
      out.min.x = Math.min(out.min.x, r.box.min.x);
      out.min.y = Math.min(out.min.y, r.box.min.y);
      out.min.z = Math.min(out.min.z, r.box.min.z);
      out.max.x = Math.max(out.max.x, r.box.max.x);
      out.max.y = Math.max(out.max.y, r.box.max.y);
      out.max.z = Math.max(out.max.z, r.box.max.z);
    }
    return out;
  }

  private updateToLocal(): void {
    this.uToLocal.value.copy(this.root.matrixWorld).invert();
  }

  /** Recapture every probe (spread over frames). */
  recapture(): void {
    if (!this.patchOk) return;
    this.queue = this.probes.length * 6;
    this.queueStart = this.queue;
  }

  private captureStep(): void {
    const cam = this.cubeCam;
    const cube = this.cubeRT;
    const pm = this.pmrem;
    if (!cam || !cube || !pm || this.queue <= 0) {
      this.queue = 0;
      return;
    }
    const done = this.queueStart - this.queue;
    const pi = Math.floor(done / 6);
    const face = done % 6;
    const p = this.probes[pi];
    const r = this.renderer;
    // only the probe's rooms and their neighbours, cabin light only
    for (let i = 0; i < this.rooms.length; i++) {
      const vis = p.show[i];
      for (const n of this.rooms[i].nodes) n.visible = vis;
    }
    const sunI = this.sun.intensity;
    const shI = this.shine ? this.shine.intensity : 0;
    this.sun.intensity = 0;
    if (this.shine) this.shine.intensity = 0;
    const hidden = this.hideDuringCapture;
    const hv = hidden ? hidden.visible : false;
    if (hidden) hidden.visible = false;
    // ship-aligned faces at the probe's centre
    this.root.updateMatrixWorld();
    cam.position.copy(p.pos).applyMatrix4(this.root.matrixWorld);
    this.root.getWorldQuaternion(this.rq);
    cam.quaternion.copy(this.rq);
    cam.updateMatrixWorld(true);
    const prevTarget = r.getRenderTarget();
    r.setRenderTarget(cube, face);
    r.clear(true, true, false);
    r.render(this.scene, cam.children[face] as THREE.Camera);
    r.setRenderTarget(prevTarget);
    if (face === 5 && p.rt) pm.fromCubemap(cube.texture, p.rt);
    this.sun.intensity = sunI;
    if (this.shine) this.shine.intensity = shI;
    if (hidden) hidden.visible = hv;
    this.queue--;
    this.allVisible = false; // visibility was changed: recompute
  }

  /** An object to hide while probes are captured (the star glare when it rides in this scene). */
  hideDuringCapture: THREE.Object3D | null = null;

  /**
   * Per frame, before the pipeline renders: probe capture (if due), room visibility for `camera`, light and
   * shadow fitting, and the shadow maps. `camera` must have up-to-date world and projection matrices.
   */
  update(f: InteriorLightingFrame, camera: THREE.PerspectiveCamera): void {
    const r = this.renderer;
    const info = r.info.render;
    const c0 = info.calls;
    const t0 = info.triangles;
    this.frameNo++;
    this.root.updateMatrixWorld();
    this.updateToLocal();
    for (let i = 0; i < this.clones.length; i++) syncClone(this.clones[i]);

    // probes: after a change of the cabin lights, once they have settled
    if (this.lastLights !== null && f.lights !== this.lastLights) this.settle = LIGHTS_SETTLE_S;
    this.lastLights = f.lights;
    if (this.settle > 0) {
      this.settle -= f.dt;
      if (this.settle <= 0) this.recapture();
    }
    if (this.queue > 0) this.captureStep();
    this.stats.pending = this.queue;

    // ---- rooms
    this.cullRooms(f.eye, camera);

    // ---- lights
    const vis = this.visibleBox();
    this.sun.color.copy(f.sunColor);
    this.sun.intensity = f.sunIntensity;
    const sunOn = f.sunIntensity > 1e-4;
    this.sun.visible = true; // never toggled: the light count is part of every program
    if (sunOn) this.fit(this.sun, f.sunDir, vis, this.shadowSize);
    if (this.shine) {
      this.shine.color.copy(f.shineColor);
      this.shine.intensity = f.shineIntensity;
      if (f.shineIntensity > 1e-4 && this.frameNo % 3 === 0) {
        this.fit(this.shine, f.shineDir, vis, this.shineSize);
        this.shine.shadow.needsUpdate = true;
      }
    }
    if (this.shadowEvery > 1 && this.frameNo % this.shadowEvery === 0) this.sun.shadow.needsUpdate = true;
    this.castersFor(sunOn ? f.sunDir : null, this.shine && f.shineIntensity > 1e-4 ? f.shineDir : null);
    // the shadow maps now, before the pipeline binds its multisampled target
    if (sunOn || (this.shine && this.shine.shadow.needsUpdate)) this.renderShadows();
    this.stats.drawCalls = info.calls - c0;
    this.stats.triangles = info.triangles - t0;
  }

  // A render of the scene through a camera that sees nothing (everything is frustum-culled; casters are found by
  // the shadow cameras), into a 1x1 target: three renders the shadow maps and nothing else. Shadow maps can only
  // be drawn from inside a render() (they need its render state).
  private readonly nullCam = new THREE.PerspectiveCamera(1, 1, 1e6, 1e6 + 1);
  private readonly nullRT = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });

  private renderShadows(): void {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    this.nullCam.position.set(0, 1e7, 0);
    this.nullCam.updateMatrixWorld();
    r.shadowMap.needsUpdate = true;
    r.setRenderTarget(this.nullRT);
    r.render(this.scene, this.nullCam);
    r.shadowMap.needsUpdate = false;
    r.setRenderTarget(prev);
  }

  /** Furniture casts only in the visible rooms with a window facing the sun or the planetshine. */
  private castersFor(sun: THREE.Vector3 | null, shine: THREE.Vector3 | null): void {
    const q = this.rq;
    this.root.getWorldQuaternion(q).invert();
    const s = sun ? this.tv.copy(sun).applyQuaternion(q) : null;
    const p = shine ? this.tv2.copy(shine).applyQuaternion(q) : null;
    for (const room of this.rooms) {
      if (room.casters.length === 0) continue;
      let open = false;
      if (room.visible && !room.far)
        for (const n of room.windows) {
          if (s && n.x * s.x + n.y * s.y + n.z * s.z > 0.02) open = true;
          if (p && n.x * p.x + n.y * p.y + n.z * p.z > 0.02) open = true;
        }
      for (const m of room.casters) m.castShadow = open;
    }
  }

  /** Portal culling from the camera's room through the door boxes; sets node visibility. */
  private cullRooms(eye: V3, camera: THREE.PerspectiveCamera): void {
    const rooms = this.rooms;
    for (const rm of rooms) rm.visible = false;
    let start = -1;
    let start2 = -1;
    for (let i = 0; i < rooms.length; i++) {
      if (inBox(rooms[i].box, eye.x, eye.y, eye.z, 0.02)) {
        if (start < 0) start = i;
        else start2 = i;
      }
    }
    // standing in a doorway: both sides
    const doors = this.layout.doors;
    for (let d = 0; d < doors.length && start2 < 0; d++) {
      if (!inBox(doors[d].box, eye.x, eye.y, eye.z, 0.05)) continue;
      const a = this.roomIndex.get(doors[d].a);
      const b = this.roomIndex.get(doors[d].b);
      if (a !== undefined && b !== undefined) {
        start = a;
        start2 = b;
      }
    }
    if (start < 0) {
      for (const rm of rooms) rm.visible = true;
      this.stats.room = '';
    } else {
      this.stats.room = rooms[start].id;
      this.mv.multiplyMatrices(camera.matrixWorldInverse, this.root.matrixWorld);
      this.visit(start, -1, -1, 1, -1, 1, 0, camera);
      if (start2 >= 0) this.visit(start2, -1, -1, 1, -1, 1, 0, camera);
    }
    let n = 0;
    for (const rm of rooms) {
      if (rm.visible) n++;
      for (const node of rm.nodes) node.visible = rm.visible;
    }
    this.visibleCount = n;
    this.stats.rooms = n;
    this.allVisible = n === rooms.length;
  }

  private visit(ri: number, from: number, x0: number, x1: number, y0: number, y1: number, depth: number, camera: THREE.PerspectiveCamera): void {
    const room = this.rooms[ri];
    // the largest opening it is seen through decides whether its furniture is worth a shadow
    const small = (x1 - x0) * (y1 - y0) < 0.08;
    room.far = room.visible ? room.far && small : small;
    room.visible = true;
    if (depth > 8) return;
    for (const [di, other] of room.links) {
      if (other === from) continue;
      if (!this.portalRect(this.layout.doors[di].box, camera)) continue;
      const nx0 = Math.max(x0, this.rect[0]);
      const ny0 = Math.max(y0, this.rect[1]);
      const nx1 = Math.min(x1, this.rect[2]);
      const ny1 = Math.min(y1, this.rect[3]);
      if (nx1 <= nx0 || ny1 <= ny0) continue;
      this.visit(other, ri, nx0, nx1, ny0, ny1, depth + 1, camera);
    }
  }

  /** NDC rectangle of a door box seen by the camera into this.rect; false when it is wholly behind or off screen. */
  private portalRect(b: Box, camera: THREE.PerspectiveCamera): boolean {
    const m = this.mv.elements;
    const p = camera.projectionMatrix.elements;
    let behind = 0;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < 8; k++) {
      const x = k & 1 ? b.max.x : b.min.x;
      const y = k & 2 ? b.max.y : b.min.y;
      const z = k & 4 ? b.max.z : b.min.z;
      const vx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const vy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const vz = m[2] * x + m[6] * y + m[10] * z + m[14];
      if (vz > -NEAR * 2) {
        behind++;
        continue;
      }
      const w = -vz;
      const cx = (p[0] * vx + p[8] * vz) / w;
      const cy = (p[5] * vy + p[9] * vz) / w;
      if (cx < x0) x0 = cx;
      if (cx > x1) x1 = cx;
      if (cy < y0) y0 = cy;
      if (cy > y1) y1 = cy;
    }
    if (behind === 8) return false;
    if (behind > 0) {
      // the door straddles the camera plane: it may cover anything on screen
      x0 = y0 = -1;
      x1 = y1 = 1;
    }
    if (x1 < -1 || x0 > 1 || y1 < -1 || y0 > 1) return false;
    this.rect[0] = x0;
    this.rect[1] = y0;
    this.rect[2] = x1;
    this.rect[3] = y1;
    return true;
  }

  private readonly visBox: Box = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  private visibleBox(): Box {
    const out = this.visBox;
    let first = true;
    for (const r of this.rooms) {
      if (!r.visible) continue;
      if (first) {
        out.min.x = r.box.min.x;
        out.min.y = r.box.min.y;
        out.min.z = r.box.min.z;
        out.max.x = r.box.max.x;
        out.max.y = r.box.max.y;
        out.max.z = r.box.max.z;
        first = false;
        continue;
      }
      out.min.x = Math.min(out.min.x, r.box.min.x);
      out.min.y = Math.min(out.min.y, r.box.min.y);
      out.min.z = Math.min(out.min.z, r.box.min.z);
      out.max.x = Math.max(out.max.x, r.box.max.x);
      out.max.y = Math.max(out.max.y, r.box.max.y);
      out.max.z = Math.max(out.max.z, r.box.max.z);
    }
    return out;
  }

  /**
   * Fit a directional light's orthographic shadow camera to the sphere around `b` (ship-local), looking along
   * `dir` (world, toward the light), with a world-fixed up axis and its centre snapped to whole texels of a
   * grid anchored to the ship, so the map is stable while nothing rotates.
   */
  private fit(light: THREE.DirectionalLight, dir: THREE.Vector3, b: Box, size: number): void {
    const mw = this.root.matrixWorld;
    const hx = (b.max.x - b.min.x) * 0.5;
    const hy = (b.max.y - b.min.y) * 0.5;
    const hz = (b.max.z - b.min.z) * 0.5;
    // radius quantised to 0.5 m: the texel size changes only when the set of visible rooms does
    const radius = Math.ceil(Math.hypot(hx, hy, hz) * 2 + 0.3) * 0.5;
    const c = this.center.set(b.min.x + hx, b.min.y + hy, b.min.z + hz).applyMatrix4(mw);
    const anchor = this.anchor.setFromMatrixPosition(mw);
    const up = Math.abs(dir.y) > 0.92 ? this.tv2.set(1, 0, 0) : this.tv2.set(0, 1, 0);
    const ax = this.axisR.crossVectors(up, dir).normalize();
    const ay = this.axisU.crossVectors(dir, ax);
    const texel = (2 * radius) / size;
    this.tv.subVectors(c, anchor);
    const u = this.tv.dot(ax);
    const v = this.tv.dot(ay);
    const du = Math.round(u / texel) * texel - u;
    const dv = Math.round(v / texel) * texel - v;
    c.addScaledVector(ax, du).addScaledVector(ay, dv);
    const margin = 1.5;
    light.target.position.copy(c);
    light.position.copy(c).addScaledVector(dir, radius + margin);
    light.updateMatrixWorld();
    light.target.updateMatrixWorld();
    const cam = light.shadow.camera;
    cam.up.copy(up);
    if (cam.left !== -radius || cam.far !== 2 * radius + 2 * margin) {
      cam.left = cam.bottom = -radius;
      cam.right = cam.top = radius;
      cam.near = 0.05;
      cam.far = 2 * radius + 2 * margin;
      cam.updateProjectionMatrix();
    }
  }

  /**
   * How much of the star's disc the eye sees through a window opening (0..1), ship-local eye and unit
   * direction: the ray must leave through a window of a drawn room, with the window frame as a soft edge.
   */
  starThroughWindow(eye: V3, dir: V3, angularRadius: number): number {
    let best = 0;
    const wins = this.layout.windows;
    for (let i = 0; i < wins.length; i++) {
      const w = wins[i];
      const ri = this.roomIndex.get(w.room);
      if (ri !== undefined && !this.rooms[ri].visible && !this.allVisible) continue;
      let dn: number;
      let off: number;
      if (w.wall === '+x' || w.wall === '-x') {
        dn = w.wall === '+x' ? dir.x : -dir.x;
        off = w.wall === '+x' ? w.center.x - eye.x : eye.x - w.center.x;
      } else if (w.wall === '+y') {
        dn = dir.y;
        off = w.center.y - eye.y;
      } else {
        dn = w.wall === '+z' ? dir.z : -dir.z;
        off = w.wall === '+z' ? w.center.z - eye.z : eye.z - w.center.z;
      }
      if (dn <= 1e-4 || off <= 0) continue;
      const t = off / dn;
      const hx = eye.x + dir.x * t - w.center.x;
      const hy = eye.y + dir.y * t - w.center.y;
      const hz = eye.z + dir.z * t - w.center.z;
      let a: number;
      let b: number;
      if (w.wall === '+x' || w.wall === '-x') {
        a = Math.abs(hz);
        b = Math.abs(hy);
      } else if (w.wall === '+y') {
        a = Math.abs(hx);
        b = Math.abs(hz);
      } else {
        a = Math.abs(hx);
        b = Math.abs(hy);
      }
      // distance inside the opening, in metres, against the disc's footprint on the window plane (+ 2 cm frame)
      const soft = Math.max(0.02, t * angularRadius * 2);
      const ia = w.width * 0.5 - a;
      const ib = w.height * 0.5 - b;
      const k = Math.min(1, Math.max(0, ia / soft + 0.5)) * Math.min(1, Math.max(0, ib / soft + 0.5));
      if (k <= best) continue;
      // the segment to the window must stay inside the ship's rooms and doors (no wall in between)
      let clear = true;
      for (let s = 1; s <= 5 && clear; s++) {
        const q = (t * s) / 6;
        const x = eye.x + dir.x * q;
        const y = eye.y + dir.y * q;
        const z = eye.z + dir.z * q;
        let inside = false;
        for (let j = 0; j < this.rooms.length && !inside; j++) inside = inBox(this.rooms[j].box, x, y, z, 0.05);
        for (let j = 0; j < this.layout.doors.length && !inside; j++) inside = inBox(this.layout.doors[j].box, x, y, z, 0.02);
        clear = inside;
      }
      if (clear) best = k;
    }
    return best;
  }

  /** Visible rooms right now (for tests and the harness). */
  visibleRooms(out: string[] = []): string[] {
    out.length = 0;
    for (const r of this.rooms) if (r.visible) out.push(r.id);
    return out;
  }

  get visible(): number {
    return this.visibleCount;
  }

  dispose(): void {
    this.sun.removeFromParent();
    this.sun.target.removeFromParent();
    this.sun.dispose();
    if (this.shine) {
      this.shine.removeFromParent();
      this.shine.target.removeFromParent();
      this.shine.dispose();
    }
    for (const p of this.probes) p.rt?.dispose();
    for (const c of this.clones) c.dst.dispose();
    this.cubeRT?.dispose();
    this.pmrem?.dispose();
    this.nullRT.dispose();
  }
}

/** Keep a per-probe clone in step with the material the modelling code animates. */
function syncClone(c: Clone): void {
  const s = c.src;
  const d = c.dst;
  if (s.version !== c.version) {
    const env = d.envMap;
    const obc = d.onBeforeCompile;
    const key = d.customProgramCacheKey;
    const ud = d.userData;
    d.copy(s);
    d.envMap = env;
    d.onBeforeCompile = obc;
    d.customProgramCacheKey = key;
    d.userData = ud;
    d.needsUpdate = true;
    c.version = s.version;
    return;
  }
  d.color.copy(s.color);
  d.emissive.copy(s.emissive);
  d.emissiveIntensity = s.emissiveIntensity;
  d.roughness = s.roughness;
  d.metalness = s.metalness;
  d.opacity = s.opacity;
  d.lightMapIntensity = s.lightMapIntensity;
  d.aoMapIntensity = s.aoMapIntensity;
  d.envMapIntensity = s.envMapIntensity;
  d.visible = s.visible;
  if (d.map !== s.map || d.emissiveMap !== s.emissiveMap || d.lightMap !== s.lightMap) {
    d.map = s.map;
    d.emissiveMap = s.emissiveMap;
    d.lightMap = s.lightMap;
    d.needsUpdate = true;
  }
}

// ------------------------------------------------------------------------------------------- outside

/**
 * The live reflection environment of the outside: the far scene (sky, worlds) captured around the origin into
 * a small cube, one face every `every` frames, and PMREM-filtered when a cube is complete. World axes.
 */
export class OutsideEnvironment {
  readonly texture: THREE.Texture;
  readonly bytes: number;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly cube: THREE.WebGLCubeRenderTarget;
  private readonly cam: THREE.CubeCamera;
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly rt: THREE.WebGLRenderTarget;
  private face = 0;
  private tick = 0;
  private readonly every: number;
  /** Complete captures so far (0 = the texture is still empty). */
  captures = 0;
  drawCalls = 0;

  constructor(renderer: THREE.WebGLRenderer, size: number, every = 4) {
    this.renderer = renderer;
    this.every = Math.max(1, every);
    this.cube = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, depthBuffer: true });
    this.cam = new THREE.CubeCamera(0.05, 600, this.cube);
    this.cam.coordinateSystem = renderer.coordinateSystem;
    this.cam.updateCoordinateSystem();
    this.cam.updateMatrixWorld(true);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.rt = this.pmrem.fromCubemap(this.cube.texture);
    this.texture = this.rt.texture;
    this.bytes = this.rt.width * this.rt.height * 8 * 2 + size * size * 6 * 8;
  }

  /** One step (call once per frame, before the pipeline renders); `all` captures the whole cube now. */
  update(farScene: THREE.Scene, hide: readonly THREE.Object3D[], all = false): void {
    const r = this.renderer;
    const c0 = r.info.render.calls;
    if (!all && ++this.tick < this.every && this.captures > 0) {
      this.drawCalls = 0;
      return;
    }
    this.tick = 0;
    for (let i = 0; i < hide.length; i++) hide[i].userData.tlVis = hide[i].visible;
    for (let i = 0; i < hide.length; i++) hide[i].visible = false;
    const prev = r.getRenderTarget();
    const n = all ? 6 : 1;
    for (let k = 0; k < n; k++) {
      r.setRenderTarget(this.cube, this.face);
      r.clear(true, true, false);
      r.render(farScene, this.cam.children[this.face] as THREE.Camera);
      this.face = (this.face + 1) % 6;
      if (this.face === 0) {
        this.pmrem.fromCubemap(this.cube.texture, this.rt);
        this.captures++;
      }
    }
    r.setRenderTarget(prev);
    for (let i = 0; i < hide.length; i++) hide[i].visible = hide[i].userData.tlVis !== false;
    this.drawCalls = r.info.render.calls - c0;
  }

  dispose(): void {
    this.cube.dispose();
    this.rt.dispose();
    this.pmrem.dispose();
  }
}
