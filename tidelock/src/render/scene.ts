// System scene manager: turns a SceneFrame (simulation state) into the picture.
//
// Rendering contract (docs/ARCHITECTURE.md section 5):
//   * All positions are computed in doubles, in absolute system coordinates (origin: the primary star), and
//     made camera-relative before they are cast to float.
//   * FAR scene (sky, star, worlds, far markers): the camera sits at the origin; every body visual is a unit
//     sphere placed at dir * D and scaled by radius * D / distance, so its angular size is exact at any
//     distance. D grows with the logarithm of the true distance, which keeps the depth order.
//   * NEAR scene (ships, stations, effects), metres, floating origin at the camera. Depth is cleared between
//     the two. A station farther than 60 km is drawn scaled down at 60 km (same angular size) until it is a
//     few pixels across, then it is a point of light in the far scene.
//
// Lighting of the near scene, evaluated at the camera's focus:
//   * key        the star as a directional light, black-body colour (half white-balanced), intensity from the
//                real inverse-square flux compressed so the outer system stays readable, times the eclipse
//                factor: the fraction of the star's disc not covered by a world, reddened through its air.
//   * planetshine light bounced from nearby worlds (albedo colour, lit share of the visible cap, solid angle)
//                as a second, soft directional light.
//   * sky        the sky's prefiltered environment for reflections, with the star's lobe kept in step.
//   * exposure   metered from the light on the focus and the sun-lit worlds in view, adapted over about a
//                second through the pipeline (opens up in shadow and deep space, stops down over a bright world).
//                Inside the ship the pipeline's GPU auto exposure (mean log luminance) takes over.
//
// Inside the player's ship (src/render/probes.ts): the interior is drawn by room (portal culling through the
// door openings), lit by the real star through the window openings with a shadow map fitted to the rooms in
// view, by planetshine (high / ultra), and reflects box-projected per-room probes. The player's own hull is
// drawn in every camera mode: from inside, the interior pass (depth cleared, opaque closed shell) covers it
// everywhere but the window openings, so the nose, wings and engine pods show only through the glass. The
// hull reflects a live capture of the sky and the worlds (medium and up).
//
// The module allocates nothing per frame; the only heavy work is in setSystem (bakes and station geometry).

import * as THREE from 'three';
import type { BodyDef, MiningSiteDef, Quat, StateVector, StationDef, StationLayout, SystemDef, V3 } from '../core/types';
import { newColliderContact, stationContact } from '../data/colliders';
import { SHIP_LAYOUTS } from '../data/shipLayouts';
import { BERTHS, STATION_LAYOUTS } from '../data/stationLayouts';
import type { Quality, RenderLayer, RenderPipeline } from './pipeline';
import { createSky, type Sky } from './space/sky';
import { createStarGlare, createStarVisual, starColorFromTemperature, type StarGlare, type StarVisual } from './space/star';
import { createBodyVisual, type BodyUpdateContext, type BodyVisual } from './space/planet';
import { createShipVisual, type ShipVisual } from './space/ships';
import { createStationVisual, type StationVisual } from './space/stations';
import { EffectsManager, createEnginePlumes, createStrobes, type EnginePlume, type Strobes } from './space/effects';
import { createCameraRig, type CameraEnv, type CameraFocus, type CameraPose } from './camera';
import { addShip, playerShip, type FrameShip, type SceneFrame } from './frame';
import { INTERIORS, type InteriorLayout } from '../data/interiors';
import { createInteriorVisual, type InteriorOptions, type InteriorUpdate, type InteriorVisual } from './space/interior';
import { COCKPITS, type CockpitLayout } from '../data/cockpit';
import type { DeviceView } from '../game/api';
import { createCockpitVisual, type CockpitPick, type CockpitUpdate, type CockpitVisual } from './space/cockpit';
import { InteriorLighting, OutsideEnvironment, textureBytesOf, type InteriorLightingFrame } from './probes';
import { TIER_SETTINGS, renderInfo } from '../app/perf';

/**
 * Cabin light level against the sun (interior lightmaps, probes, emitters and the cockpit glass). Tried at 0.45
 * for hotter sun patches: the GPU auto exposure did not lift the work areas back up within a second, so they
 * read underexposed; 1 keeps the lighting calibration of docs/ARCHITECTURE.md.
 */
const CABIN_GAIN = 1;

// ------------------------------------------------------------------------------------------------ API

/**
 * Something to project or pick:
 *   'tallow.wick' / 'tallow.st.chandlers-wheel' / a site id / a ship id   an object, by id
 *   { dir }                    a direction in world axes seen from the player ship (prograde, a manoeuvre vector…)
 *   { point }                  a point relative to the player ship, world axes, m
 *   { stationId, portId }      the mating point of a docking port
 */
export type SceneRef = string | { dir: V3 } | { point: V3 } | { stationId: string; portId: string };
export type SceneRefKind = 'body' | 'station' | 'site' | 'ship';

export interface Projection {
  /** CSS pixels from the top-left corner of the canvas. When `behind`, a point beyond the screen edge in the direction to turn. */
  x: number;
  y: number;
  /** In front of the camera and inside the viewport. */
  visible: boolean;
  /** Behind the camera plane. */
  behind: boolean;
  /** Metres from the camera (Infinity for a direction). */
  distance: number;
  /** Apparent radius, CSS px (0 for directions and points). */
  radiusPx: number;
  /** Hidden behind a world. */
  occluded: boolean;
}

export interface SceneStats {
  drawCalls: number;
  triangles: number;
  /** The player ship's interior, once built: its own draw calls and triangles (drawn only in the 'interior' view). */
  interior: { drawCalls: number; triangles: number } | null;
  /** The physical controls and screens drawn with the interior (also counted in the frame totals). */
  cockpit: { drawCalls: number; triangles: number } | null;
  /** Interior lighting: rooms drawn, shadow-map and probe-capture draws (included in the totals), memory. */
  lighting: { rooms: number; roomsTotal: number; room: string; drawCalls: number; probeBytes: number; shadowBytes: number; pending: number } | null;
  /** Estimated GPU texture memory: interior + cockpit + player hull + lighting, and the pipeline's targets, bytes. */
  textureBytes: number;
  targetBytes: number;
}

export interface SceneManagerOptions {
  quality: Quality;
  /** Override for the sky bake only (the sky is the longest bake; harnesses lower it). */
  skyQuality?: Quality;
  /** Builds the player ship's interior (default: space/interior.ts). Harnesses substitute stand-ins. */
  interiorFactory?: (layout: InteriorLayout, opts: InteriorOptions) => InteriorVisual;
}

export interface SetSystemOptions {
  /** A world the camera starts close to: baked at full detail straight away instead of sharpening over the first frames. */
  nearBodyId?: string;
}

export interface SceneManager {
  /**
   * Build the visuals of a system (sky, star, worlds, stations), disposing the previous one. Long bakes
   * yield to the event loop between steps; `onProgress` gets 0..1 and a label for a loading bar.
   */
  setSystem(system: SystemDef, onProgress?: (fraction: number, label: string) => void, opts?: SetSystemOptions): Promise<void>;
  /** Update everything from the frame and draw it through the pipeline. */
  render(frame: SceneFrame): void;
  /** Screen position of a reference as of the last rendered frame. Returns `out` (or a shared object). */
  project(ref: SceneRef, out?: Projection): Projection;
  /** Id of the object under a touch (CSS px), with a generous radius; the player's own ship is never picked. */
  pick(x: number, y: number): string | null;
  /**
   * The physical control of the player's ship under a touch (CSS px) as of the last rendered frame, seen
   * through the first-person camera, with the hand position in the device's own axes (see CockpitPick), or
   * null. Only reachable devices are found, the nearest to the finger within a finger's width. With `heldId`
   * the result is always that device: the hand position for a drag that started on it.
   * The returned object is reused between calls.
   */
  pickDevice(x: number, y: number, heldId?: string): CockpitPick | null;
  /** What an id refers to in the current system / frame, or null. */
  refKind(id: string): SceneRefKind | null;
  /** Change the quality tier (also the pipeline's). Rebuilds the current system's visuals; resolves when done. */
  setQuality(q: Quality): Promise<void>;
  /** Rebuild the current system's visuals (after a restored WebGL context). */
  rebuild(): Promise<void>;
  /** True while worlds are still baking sharper textures. */
  busy(): boolean;
  /** Camera pose of the last frame: position relative to the focus, orientation, field of view. */
  readonly camera: Readonly<CameraPose>;
  /** Exposure in stops currently applied. */
  readonly exposure: number;
  stats(): SceneStats;
  dispose(): void;
}

// ------------------------------------------------------------------------------------------------ constants

const AU = 1.495978707e11;
const FAR_PLANE = 80000;
/** Stations beyond this are drawn at this distance, scaled to keep their angular size. */
const STATION_PLACE_MAX = 60000;
/** A station model is shown while its bounding radius is above this many CSS px; the point of light fades in below twice that. */
const STATION_MIN_PX = 3.5;
const MAX_MARKERS = 48;
const CAMERA_RADIUS = 2.5;
const PICK_RADIUS = 30;
const SHIP_IDLE_FRAMES = 240;
/** How far the star's colour is white-balanced toward neutral (0 = raw black body, 1 = white). */
const WHITE_BALANCE = 0.42;
const EV_MIN = -0.8;
const EV_MAX = 2.3;

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const smooth = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const v3 = (): V3 => ({ x: 0, y: 0, z: 0 });
const len3 = (a: V3): number => Math.hypot(a.x, a.y, a.z);

function rotTo(out: V3, q: Quat, x: number, y: number, z: number): V3 {
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  out.x = x + q.w * tx + (q.y * tz - q.z * ty);
  out.y = y + q.w * ty + (q.z * tx - q.x * tz);
  out.z = z + q.w * tz + (q.x * ty - q.y * tx);
  return out;
}
/** Rotate by the conjugate (world -> local). */
function unrotTo(out: V3, q: Quat, x: number, y: number, z: number): V3 {
  const tx = 2 * (-q.y * z + q.z * y);
  const ty = 2 * (-q.z * x + q.x * z);
  const tz = 2 * (-q.x * y + q.y * x);
  out.x = x + q.w * tx + (-q.y * tz + q.z * ty);
  out.y = y + q.w * ty + (-q.z * tx + q.x * tz);
  out.z = z + q.w * tz + (-q.x * ty + q.y * tx);
  return out;
}

/** Artistic star-light intensity (1 = white diffuse reads 1.0) at `dist` metres from a star of `luminosity` Sols. */
function starIntensityAt(dist: number, luminosity: number): number {
  const au = Math.max(dist, 1e6) / AU;
  const flux = Math.max(luminosity, 1e-6) / (au * au); // 1 = Earth's insolation
  return clamp(Math.pow(flux, 0.6), 0.22, 2.6);
}

/** Rough mean albedo colour of a world (for planetshine and far markers). */
function meanAlbedo(def: BodyDef, out: THREE.Color): THREE.Color {
  const pal = def.visual.palette;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < pal.length; i++) {
    r += pal[i][0];
    g += pal[i][1];
    b += pal[i][2];
  }
  const n = Math.max(1, pal.length);
  r /= n;
  g /= n;
  b /= n;
  const vis = def.visual;
  const ocean = clamp(vis.oceanLevel ?? 0, 0, 1) * 0.5;
  if (ocean > 0 && vis.oceanColor) {
    r += (vis.oceanColor[0] - r) * ocean;
    g += (vis.oceanColor[1] - g) * ocean;
    b += (vis.oceanColor[2] - b) * ocean;
  }
  const ice = clamp(vis.ice ?? 0, 0, 1) * 0.45;
  r += (0.62 - r) * ice;
  g += (0.68 - g) * ice;
  b += (0.74 - b) * ice;
  const cloud = clamp(vis.cloudCover ?? 0, 0, 1) * 0.7;
  const cc = vis.cloudColor ?? [0.8, 0.8, 0.8];
  r += (cc[0] * 0.75 - r) * cloud;
  g += (cc[1] * 0.75 - g) * cloud;
  b += (cc[2] * 0.75 - b) * cloud;
  if (def.atmosphere) {
    const k = def.atmosphere.opacity * 0.12;
    r += def.atmosphere.color[0] * k;
    g += def.atmosphere.color[1] * k;
    b += def.atmosphere.color[2] * k;
  }
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const floor = def.atmosphere ? 0.1 : 0.05;
  if (lum < floor) {
    const k = floor / Math.max(lum, 1e-4);
    r *= k;
    g *= k;
    b *= k;
  }
  const m = Math.max(r, g, b);
  if (m > 0.75) {
    r *= 0.75 / m;
    g *= 0.75 / m;
    b *= 0.75 / m;
  }
  return out.setRGB(r, g, b, THREE.LinearSRGBColorSpace);
}

const lumOf = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** Squared distance between the ray o + t d (0 <= t <= tMax, d unit) and the segment a-b. */
function raySegDist2(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMax: number, a: V3, b: V3 | undefined): number {
  const ax = a.x - ox;
  const ay = a.y - oy;
  const az = a.z - oz;
  if (!b) {
    const t = clamp(ax * dx + ay * dy + az * dz, 0, tMax);
    return (ax - dx * t) ** 2 + (ay - dy * t) ** 2 + (az - dz * t) ** 2;
  }
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const ez = b.z - a.z;
  const ee = ex * ex + ey * ey + ez * ez;
  const de = dx * ex + dy * ey + dz * ez;
  const dw = -(dx * ax + dy * ay + dz * az); // d . (o - a)
  const ew = -(ex * ax + ey * ay + ez * az); // e . (o - a)
  const den = ee - de * de;
  let s = den > 1e-9 ? clamp((de * dw - ew) / den, 0, 1) : 0; // parameter on the segment
  let t = clamp(de * s - dw, 0, tMax); // parameter on the ray
  if (ee > 1e-9) s = clamp((de * t - ew) / ee, 0, 1);
  t = clamp(de * s - dw, 0, tMax);
  const px = ax + ex * s - dx * t;
  const py = ay + ey * s - dy * t;
  const pz = az + ez * s - dz * t;
  return px * px + py * py + pz * pz;
}

// ------------------------------------------------------------------------------------------------ far markers

const MARKER_VS = /* glsl */ `precision highp float;
in vec3 position;
in vec4 aDirSize;   // xyz: unit direction from the camera (world axes), w: half-size, CSS px
in vec3 aColor;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec2 uPx;   // NDC per CSS px
out vec2 vP;
out vec3 vCol;
void main() {
  vec4 clip = projectionMatrix * vec4(mat3(viewMatrix) * aDirSize.xyz, 1.0);
  vP = position.xy;
  vCol = aColor;
  if (clip.w <= 1e-4) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  gl_Position = vec4(clip.xy / clip.w + position.xy * aDirSize.w * uPx, 0.0, 1.0);
}`;
const MARKER_FS = /* glsl */ `precision highp float;
in vec2 vP;
in vec3 vCol;
out vec4 outColor;
void main() {
  float d2 = dot(vP, vP);
  float g = max(exp(-d2 * 5.0) - 0.0067, 0.0) + 0.06 * max(exp(-d2 * 1.4) - 0.2466, 0.0);
  outColor = vec4(vCol * g, 0.0);
}`;

interface MarkerBatch {
  mesh: THREE.Mesh;
  dirSize: Float32Array;
  color: Float32Array;
  aDir: THREE.InstancedBufferAttribute;
  aCol: THREE.InstancedBufferAttribute;
  geo: THREE.InstancedBufferGeometry;
  uPx: THREE.Vector2;
  count: number;
}

function createMarkers(): MarkerBatch {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const dirSize = new Float32Array(MAX_MARKERS * 4);
  const color = new Float32Array(MAX_MARKERS * 3);
  const aDir = new THREE.InstancedBufferAttribute(dirSize, 4);
  const aCol = new THREE.InstancedBufferAttribute(color, 3);
  aDir.setUsage(THREE.DynamicDrawUsage);
  aCol.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aDirSize', aDir);
  geo.setAttribute('aColor', aCol);
  geo.instanceCount = 0;
  const uPx = new THREE.Vector2(0.002, 0.002);
  const mat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: MARKER_VS,
    fragmentShader: MARKER_FS,
    uniforms: { uPx: { value: uPx } },
    depthTest: false,
    depthWrite: false,
    transparent: true,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 900;
  mesh.name = 'far-markers';
  return { mesh, dirSize, color, aDir, aCol, geo, uPx, count: 0 };
}

// ------------------------------------------------------------------------------------------------ entries

interface BodyEntry {
  def: BodyDef;
  isStar: boolean;
  visual: BodyVisual | null;
  star: StarVisual | null;
  abs: V3;
  rel: V3;
  dist: number;
  /** unit, from the body toward the primary star */
  sunDir: THREE.Vector3;
  /** star-light intensity at the body, eclipses by larger neighbours included */
  light: number;
  albedo: THREE.Color;
  albedoLum: number;
  radiusPx: number;
  ctx: BodyUpdateContext;
  camLocal: THREE.Vector3;
}

interface StationEntry {
  def: StationDef;
  layout: StationLayout;
  visual: StationVisual;
  q: Quat;
  abs: V3;
  vel: V3;
  rel: V3;
  dist: number;
  radiusPx: number;
  shown: boolean;
  activePort: string | null;
  ctx: { dt: number; time: number; activePortId: string | null };
}

interface SiteEntry {
  def: MiningSiteDef;
  abs: V3;
  rel: V3;
  dist: number;
}

interface ShipEntry {
  id: string;
  visualId: string;
  seed: number;
  visual: ShipVisual;
  plume: EnginePlume | null;
  strobes: Strobes | null;
  group: THREE.Group;
  abs: V3;
  rel: V3;
  dist: number;
  radius: number;
  q: Quat;
  lastSeen: number;
  isPlayer: boolean;
  ctx: { dt: number; time: number; throttle: number; lightsOn: boolean; heat: number; damage: number };
}

const tick = (): Promise<void> =>
  new Promise((resolve) => {
    let done = false;
    const go = (): void => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go);
    setTimeout(go, 40);
  });

// ------------------------------------------------------------------------------------------------ manager

class Manager implements SceneManager {
  private quality: Quality;
  private readonly skyQuality: Quality | undefined;
  private readonly interiorFactory: (layout: InteriorLayout, opts: InteriorOptions) => InteriorVisual;
  private readonly farScene = new THREE.Scene();
  private readonly nearScene = new THREE.Scene();
  private readonly farCam = new THREE.PerspectiveCamera(50, 1, 0.05, 600);
  private readonly nearCam = new THREE.PerspectiveCamera(50, 1, 0.3, FAR_PLANE);
  // first person inside the player's ship: its own scene, drawn last with the depth cleared
  private readonly insideScene = new THREE.Scene();
  private readonly insideCam = new THREE.PerspectiveCamera(60, 1, 0.05, 80);
  private layersInside: RenderLayer[] = [];
  private interior: { shipId: string; visualId: string; visual: InteriorVisual; cockpit: CockpitVisual | null; lighting: InteriorLighting } | null = null;
  /** The Wren's interior built (and its programs compiled, probes captured) while loading, adopted by ensureInterior. */
  private prebuilt: { visualId: string; visual: InteriorVisual; cockpit: CockpitVisual | null; lighting: InteriorLighting } | null = null;
  /** Hulls built while loading so their programs exist before the first frame (kept, never drawn). */
  private warmShips: ShipVisual[] = [];
  private outsideEnv: OutsideEnvironment | null = null;
  private readonly envHide: THREE.Object3D[] = [];
  private hullTexBytes = -1;
  private extraCalls = 0;
  private extraTris = 0;
  private readonly lightFrame: InteriorLightingFrame = {
    eye: { x: 0, y: 0, z: 0 },
    sunDir: new THREE.Vector3(0, 1, 0),
    sunColor: new THREE.Color(0, 0, 0),
    sunIntensity: 0,
    shineDir: new THREE.Vector3(0, -1, 0),
    shineColor: new THREE.Color(0, 0, 0),
    shineIntensity: 0,
    lights: true,
    dt: 0,
  };
  private readonly cockpitCtx: CockpitUpdate = { devices: [], time: 0, lights: true, gain: 1, instruments: null };
  /** Ship pose relative to the camera of the last interior frame, for pickDevice. */
  private pickValid = false;
  private readonly pickRel: V3 = { x: 0, y: 0, z: 0 };
  private readonly pickQ: Quat = { x: 0, y: 0, z: 0, w: 1 };
  private readonly pickO: V3 = { x: 0, y: 0, z: 0 };
  private readonly pickD: V3 = { x: 0, y: 0, z: -1 };
  private readonly pickV = new THREE.Vector3();
  private readonly interiorCtx: Required<InteriorUpdate> = {
    time: 0,
    lights: true,
    eye: { x: 0, y: 0, z: 0 },
    gain: 1,
    sunDir: { x: 0, y: 1, z: 0 },
    sunColor: { r: 0, g: 0, b: 0 },
    windowColor: { r: 0, g: 0, b: 0 },
  };
  private readonly layers: RenderLayer[];
  private readonly key = new THREE.DirectionalLight(0xffffff, 0);
  private readonly shine = new THREE.DirectionalLight(0xffffff, 0);
  private readonly ambient = new THREE.AmbientLight(new THREE.Color(0.55, 0.62, 0.8), Math.PI * 0.006);
  private readonly markers = createMarkers();
  private readonly rig = createCameraRig();

  private system: SystemDef | null = null;
  private generation = 0;
  private loading = false;
  private nearBodyId: string | undefined;

  private sky: Sky | null = null;
  private glare: StarGlare | null = null;
  private fx: EffectsManager | null = null;
  private bodies: BodyEntry[] = [];
  private stations: StationEntry[] = [];
  private sites: SiteEntry[] = [];
  private readonly bodyIndex = new Map<string, BodyEntry>();
  private readonly stationIndex = new Map<string, StationEntry>();
  private readonly siteIndex = new Map<string, SiteEntry>();
  private readonly ships = new Map<string, ShipEntry>();
  private readonly shipList: ShipEntry[] = [];
  private primary: BodyEntry | null = null;

  // light
  private readonly starPhys = new THREE.Color(1, 1, 1);
  private readonly lightColor = new THREE.Color(1, 1, 1);
  private readonly keyColor = new THREE.Color(1, 1, 1);
  private readonly shineColor = new THREE.Color(0, 0, 0);
  private readonly tmpColor = new THREE.Color();
  private readonly sunDirFocus = new THREE.Vector3(1, 0, 0);
  private readonly envDir = new THREE.Vector3(0, 0, 0);
  private readonly envColor = new THREE.Color(0, 0, 0);
  private envIntensity = -1;
  private envAge = 1e9;
  private keyLevel = 1;

  // per-frame state (kept for project / pick)
  private frameNo = 0;
  private clock = 0;
  private simTime = 0;
  private readonly camAbs = v3();
  private readonly camQ: Quat = { x: 0, y: 0, z: 0, w: 1 };
  private readonly camFwd = v3();
  private tanY = 0.4;
  private tanX = 0.4;
  private cssW = 1;
  private cssH = 1;
  private readonly focusAbs = v3();
  private lastFocusId = '';
  private readonly playerAbs = v3();
  private readonly playerVel = v3();
  private hasPlayer = false;
  private ev = 0;
  private evInit = false;
  private glareVis = 1;
  private redden = 0;

  // scratch
  private readonly sv: StateVector = { r: v3(), v: v3() };
  private readonly ta = v3();
  private readonly tb = v3();
  private readonly tc = v3();
  private readonly td = v3();
  private readonly contact = newColliderContact();
  private readonly tv = new THREE.Vector3();
  private readonly tv2 = new THREE.Vector3();
  private readonly projOut: Projection = { x: 0, y: 0, visible: false, behind: false, distance: 0, radiusPx: 0, occluded: false };
  private readonly pickOut: Projection = { x: 0, y: 0, visible: false, behind: false, distance: 0, radiusPx: 0, occluded: false };
  private readonly statsOut: SceneStats = { drawCalls: 0, triangles: 0, interior: null, cockpit: null, lighting: null, textureBytes: 0, targetBytes: 0 };
  private readonly lightingStats = { rooms: 0, roomsTotal: 0, room: '', drawCalls: 0, probeBytes: 0, shadowBytes: 0, pending: 0 };
  private readonly focus: CameraFocus = { id: '', kind: 'ship', radius: 10, q: { x: 0, y: 0, z: 0, w: 1 }, chaseDistance: 34, chaseHeight: 8, cockpit: v3(), throttle: 0 };
  private readonly dockEnv = { pos: v3(), dir: v3(), up: v3() };
  private readonly lookEnv = v3();
  private readonly camEnv: CameraEnv = { aspect: 1, dock: null, lookAt: null, up: { x: 0, y: 1, z: 0 }, collide: null };
  private pose: CameraPose;
  private disposed = false;

  constructor(
    private readonly pipeline: RenderPipeline,
    opts: SceneManagerOptions,
  ) {
    this.quality = opts.quality;
    this.skyQuality = opts.skyQuality;
    this.interiorFactory = opts.interiorFactory ?? createInteriorVisual;
    this.pose = this.rig.pose;
    this.nearScene.add(this.key, this.key.target, this.shine, this.shine.target, this.ambient);
    this.farScene.add(this.markers.mesh);
    this.layers = [
      { scene: this.farScene, camera: this.farCam },
      { scene: this.nearScene, camera: this.nearCam, clearDepth: true },
    ];
    this.layersInside = [...this.layers, { scene: this.insideScene, camera: this.insideCam, clearDepth: true }];
    this.camEnv.collide = this.collideCamera;
    // Shadows: only the interior's sun and planetshine cast them. Their maps are rendered by the interior
    // lighting before the pipeline binds its HDR target (never from inside a layer's render).
    const sm = pipeline.renderer.shadowMap;
    sm.enabled = true;
    sm.type = THREE.PCFSoftShadowMap;
    sm.autoUpdate = false;
  }

  get camera(): Readonly<CameraPose> {
    return this.pose;
  }

  get exposure(): number {
    return this.ev;
  }

  // ---------------------------------------------------------------------------------------------- build

  async setSystem(system: SystemDef, onProgress?: (fraction: number, label: string) => void, opts: SetSystemOptions = {}): Promise<void> {
    const gen = ++this.generation;
    this.loading = true;
    this.disposeSystem();
    this.system = system;
    this.nearBodyId = opts.nearBodyId;
    const renderer = this.pipeline.renderer;
    const q = this.quality;
    const total = 3 + system.bodies.length + system.stations.length;
    let done = 0;
    // load-time breakdown (ms per step) for the perf report: globalThis.__tlLoad
    const loadTimes: string[] = [];
    let loadT = performance.now();
    let loadLabel = 'start';
    const lap = (label: string): void => {
      const now = performance.now();
      loadTimes.push(`${loadLabel} ${(now - loadT).toFixed(0)}`);
      loadT = now;
      loadLabel = label;
    };
    const step = async (label: string): Promise<boolean> => {
      lap(label);
      onProgress?.(Math.min(1, done / total), label);
      done++;
      await tick();
      return gen === this.generation && !this.disposed;
    };

    if (!(await step('Charting the sky'))) return;
    const sky = createSky(renderer, system.skySeed, this.skyQuality ?? q);
    this.sky = sky;
    this.farScene.add(sky.object3d);
    this.nearScene.environment = sky.envMap;
    this.envIntensity = -1;

    for (const def of system.bodies) {
      if (!(await step(def.name))) return;
      const isStar = def.kind === 'star' || def.cls === 'star';
      const entry: BodyEntry = {
        def,
        isStar,
        visual: null,
        star: null,
        abs: v3(),
        rel: v3(),
        dist: 1,
        sunDir: new THREE.Vector3(1, 0, 0),
        light: 1,
        albedo: new THREE.Color(0.3, 0.3, 0.3),
        albedoLum: 0.3,
        radiusPx: 0,
        camLocal: new THREE.Vector3(0, 0, 3),
        ctx: { sunDir: new THREE.Vector3(1, 0, 0), starColor: this.lightColor, starIntensity: 1, time: 0, cameraPosLocal: new THREE.Vector3(0, 0, 3), pixelRadius: 1 },
      };
      entry.ctx.sunDir = entry.sunDir;
      entry.ctx.cameraPosLocal = entry.camLocal;
      if (isStar) {
        entry.star = createStarVisual(renderer, def, q);
        this.farScene.add(entry.star.object3d);
      } else {
        entry.visual = createBodyVisual(renderer, def, q, def.id === opts.nearBodyId ? { initialPixelRadius: 4000 } : {});
        this.farScene.add(entry.visual.object3d);
        meanAlbedo(def, entry.albedo);
        entry.albedoLum = lumOf(entry.albedo);
      }
      this.bodies.push(entry);
      this.bodyIndex.set(def.id, entry);
    }
    this.primary = this.bodies.find((b) => b.def.parentId === null) ?? this.bodies[0] ?? null;
    const star = this.primary?.def.star;
    this.starPhys.copy(starColorFromTemperature(star ? star.temperature : 5800));
    {
      const c = this.starPhys;
      const r = c.r + (1 - c.r) * WHITE_BALANCE;
      const g = c.g + (1 - c.g) * WHITE_BALANCE;
      const b = c.b + (1 - c.b) * WHITE_BALANCE;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const k = Math.min(1 / Math.max(lum, 1e-3), 1.3 / Math.max(r, g, b));
      this.lightColor.setRGB(r * k, g * k, b * k, THREE.LinearSRGBColorSpace);
    }

    for (const def of system.stations) {
      if (!(await step(def.name))) return;
      const layout = STATION_LAYOUTS[def.visualId];
      const visual = createStationVisual(def.visualId, { seed: def.visualSeed, quality: q, name: def.name });
      visual.object3d.visible = false;
      this.nearScene.add(visual.object3d);
      const entry: StationEntry = {
        def,
        layout,
        visual,
        q: { x: 0, y: 0, z: 0, w: 1 }, // overwritten every frame from the station craft in the world
        abs: v3(),
        vel: v3(),
        rel: v3(),
        dist: 1e12,
        radiusPx: 0,
        shown: false,
        activePort: null,
        ctx: { dt: 0, time: 0, activePortId: null },
      };
      this.stations.push(entry);
      this.stationIndex.set(def.id, entry);
    }
    // Mining sites are not part of the physical world yet: none are drawn.
    for (const def of [] as MiningSiteDef[]) {
      const entry: SiteEntry = { def, abs: v3(), rel: v3(), dist: 1e12 };
      this.sites.push(entry);
      this.siteIndex.set(def.id, entry);
    }

    if (!(await step('Lighting'))) return;
    this.glare = createStarGlare(q);
    this.nearScene.add(this.glare.object3d);
    for (const b of this.bodies) if (b.star) this.envHide.push(b.star.object3d);
    const envSize = TIER_SETTINGS[q].envProbe;
    if (envSize > 0) {
      this.outsideEnv = new OutsideEnvironment(renderer, envSize, 4);
      this.nearScene.environment = this.outsideEnv.texture;
    }
    // the player's ship and its interior, built and compiled now (iOS stalls on a first-use compile)
    if (!(await step('Fitting out the ship'))) return;
    this.prebuildInterior('wren');
    const warm = createShipVisual('wren', { quality: q });
    this.warmShips.push(warm);
    this.nearScene.add(warm.object3d);
    warm.object3d.position.set(0, 0, -40);
    this.nearCam.position.set(0, 0, 0);
    this.nearCam.updateMatrixWorld();
    renderer.compile(this.nearScene, this.nearCam);
    warm.object3d.removeFromParent();
    this.fx = new EffectsManager({ quality: q });
    this.nearScene.add(this.fx.object3d);
    this.rig.cut();
    this.evInit = false;
    this.lastFocusId = '';
    this.loading = false;
    lap('ready');
    (globalThis as { __tlLoad?: string }).__tlLoad = loadTimes.join(' · ');
    onProgress?.(1, 'Ready');
  }

  async setQuality(q: Quality): Promise<void> {
    if (q === this.quality) return;
    this.quality = q;
    this.pipeline.setQuality(q);
    await this.rebuild();
  }

  async rebuild(): Promise<void> {
    if (this.system) await this.setSystem(this.system, undefined, { nearBodyId: this.nearBodyId });
  }

  busy(): boolean {
    if (this.loading) return true;
    for (let i = 0; i < this.bodies.length; i++) {
      const v = this.bodies[i].visual;
      if (v && v.info().busy) return true;
    }
    return false;
  }

  stats(): SceneStats {
    const s = this.pipeline.stats();
    this.statsOut.drawCalls = s.drawCalls;
    this.statsOut.triangles = s.triangles;
    const iv = this.interior?.visual;
    this.statsOut.interior = iv ? { drawCalls: iv.drawCalls, triangles: iv.triangles } : null;
    const ck = this.interior?.cockpit;
    this.statsOut.cockpit = ck ? { drawCalls: ck.drawCalls, triangles: ck.triangles } : null;
    this.statsOut.drawCalls += this.extraCalls;
    this.statsOut.triangles += this.extraTris;
    const li = this.interior?.lighting;
    if (li) {
      const ls = this.lightingStats;
      ls.rooms = li.stats.rooms;
      ls.roomsTotal = li.stats.roomsTotal;
      ls.room = li.stats.room;
      ls.drawCalls = li.stats.drawCalls;
      ls.probeBytes = li.stats.probeBytes;
      ls.shadowBytes = li.stats.shadowBytes;
      ls.pending = li.stats.pending;
      this.statsOut.lighting = ls;
    } else this.statsOut.lighting = null;
    this.statsOut.textureBytes = this.textureBytes();
    this.statsOut.targetBytes = s.targetBytes;
    return this.statsOut;
  }

  /** Estimated GPU bytes of the textures of the interior, cockpit, player hull and their lighting. */
  private textureBytes(): number {
    const it = this.interior ?? this.prebuilt;
    let b = 0;
    if (it) b += it.lighting.stats.textureBytes + it.lighting.stats.probeBytes + it.lighting.stats.shadowBytes;
    if (this.hullTexBytes > 0) b += this.hullTexBytes;
    if (this.outsideEnv) b += this.outsideEnv.bytes;
    return b;
  }

  private disposeShip(e: ShipEntry): void {
    if (this.interior && this.interior.shipId === e.id) {
      this.interior.lighting.dispose();
      this.interior.cockpit?.dispose();
      this.interior.visual.dispose();
      this.interior = null;
      this.pickValid = false;
    }
    e.plume?.dispose();
    e.strobes?.dispose();
    e.visual.dispose();
    e.group.removeFromParent();
  }

  /** Build an interior, its cockpit and its lighting (rooms, sun, probes) into the inside scene; compiles and captures. */
  private buildInterior(visualId: string): { visualId: string; visual: InteriorVisual; cockpit: CockpitVisual | null; lighting: InteriorLighting } | null {
    const layout = (INTERIORS as Record<string, InteriorLayout | undefined>)[visualId];
    if (!layout) return null;
    const visual = this.interiorFactory(layout, { quality: this.quality });
    this.insideScene.add(visual.object3d);
    // the physical controls and console screens ride with the interior (same ship-local axes, same pass)
    const cl = (COCKPITS as Record<string, CockpitLayout | undefined>)[visualId];
    const cockpit = cl ? createCockpitVisual(cl, { quality: this.quality }) : null;
    if (cockpit) {
      // a cockpit that tags its own meshes by room (the LIGHTS switch sits in the lounge) keeps an untagged root;
      // an untagged cockpit is all one room
      let tagged = false;
      cockpit.object3d.traverse((o) => {
        if (o !== cockpit.object3d && typeof o.userData.room === 'string') tagged = true;
      });
      if (!tagged && typeof cockpit.object3d.userData.room !== 'string') cockpit.object3d.userData.room = 'cockpit';
      visual.object3d.add(cockpit.object3d);
    }
    const lighting = new InteriorLighting(this.pipeline.renderer, this.insideScene, visual.object3d, layout, this.quality);
    lighting.attach();
    // compile every program (shadow variants included) and capture the probes now, from the helm
    visual.object3d.visible = true;
    visual.object3d.position.set(0, 0, 0);
    visual.object3d.quaternion.set(0, 0, 0, 1);
    const ic = this.insideCam;
    ic.position.set(layout.helmEye.x, layout.helmEye.y, layout.helmEye.z);
    ic.quaternion.set(0, 0, 0, 1);
    ic.updateMatrixWorld();
    lighting.hideDuringCapture = this.glare?.object3d ?? null;
    lighting.warmUp(ic);
    // the baked lightmaps decode asynchronously: once they are in, the probes are captured again (over frames)
    visual.ready
      .then((ok) => {
        if (ok && (this.interior?.lighting === lighting || this.prebuilt?.lighting === lighting)) lighting.recapture();
      })
      .catch(() => undefined);
    ic.position.set(0, 0, 0);
    ic.updateMatrixWorld();
    visual.object3d.visible = false;
    return { visualId, visual, cockpit, lighting };
  }

  private prebuildInterior(visualId: string): void {
    if (this.prebuilt && this.prebuilt.visualId === visualId) return;
    if (this.interior && this.interior.visualId === visualId) return;
    this.prebuilt = this.buildInterior(visualId);
  }

  /** The interior of a ship that has one (built while loading, or when the player's ship first appears), or null. */
  private ensureInterior(e: ShipEntry): InteriorVisual | null {
    const cur = this.interior;
    if (cur && cur.shipId === e.id && cur.visualId === e.visualId) return cur.visual;
    if (cur) {
      cur.lighting.dispose();
      cur.cockpit?.dispose();
      cur.visual.dispose();
      this.interior = null;
    }
    let built = this.prebuilt && this.prebuilt.visualId === e.visualId ? this.prebuilt : null;
    if (!built && this.prebuilt) {
      // built for another hull: its lights must not stay in the inside scene
      this.prebuilt.lighting.dispose();
      this.prebuilt.cockpit?.dispose();
      this.prebuilt.visual.dispose();
    }
    this.prebuilt = null;
    if (!built) built = this.buildInterior(e.visualId);
    if (!built) return null;
    this.interior = { shipId: e.id, ...built };
    return built.visual;
  }

  private disposeSystem(): void {
    for (const e of this.shipList) this.disposeShip(e);
    this.shipList.length = 0;
    this.ships.clear();
    for (const s of this.stations) s.visual.dispose();
    for (const b of this.bodies) {
      b.visual?.dispose();
      b.star?.dispose();
    }
    this.stations = [];
    this.bodies = [];
    this.sites = [];
    this.bodyIndex.clear();
    this.stationIndex.clear();
    this.siteIndex.clear();
    this.primary = null;
    if (this.prebuilt) {
      this.prebuilt.lighting.dispose();
      this.prebuilt.cockpit?.dispose();
      this.prebuilt.visual.dispose();
      this.prebuilt = null;
    }
    for (const w of this.warmShips) w.dispose();
    this.warmShips.length = 0;
    this.envHide.length = 0;
    this.hullTexBytes = -1;
    if (this.outsideEnv) {
      this.nearScene.environment = null;
      this.outsideEnv.dispose();
      this.outsideEnv = null;
    }
    if (this.glare) {
      this.glare.object3d.removeFromParent();
      this.glare.dispose();
      this.glare = null;
    }
    if (this.fx) {
      this.fx.object3d.removeFromParent();
      this.fx.dispose();
      this.fx = null;
    }
    if (this.sky) {
      if (this.nearScene.environment === this.sky.envMap) this.nearScene.environment = null;
      this.sky.object3d.removeFromParent();
      this.sky.dispose();
      this.sky = null;
    }
    this.markers.geo.instanceCount = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.disposeSystem();
    this.markers.geo.dispose();
    (this.markers.mesh.material as THREE.Material).dispose();
    this.system = null;
  }

  // ---------------------------------------------------------------------------------------------- helpers

  /** Fraction 0..1 of the primary's disc visible from `p` (absolute), worlds in the way; sets this.redden. */
  private starVisibility(px: number, py: number, pz: number, skip: BodyEntry | null, minRadius: number): number {
    const star = this.primary;
    this.redden = 0;
    if (!star) return 1;
    const sx = star.abs.x - px;
    const sy = star.abs.y - py;
    const sz = star.abs.z - pz;
    const ds = Math.hypot(sx, sy, sz);
    if (ds < star.def.radius) return 1;
    const thS = Math.asin(Math.min(1, star.def.radius / ds));
    let vis = 1;
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (b === star || b === skip || b.isStar || b.def.radius < minRadius) continue;
      const bx = b.abs.x - px;
      const by = b.abs.y - py;
      const bz = b.abs.z - pz;
      const db = Math.hypot(bx, by, bz);
      if (db >= ds) continue;
      if (db <= b.def.radius) return 0;
      const c = (bx * sx + by * sy + bz * sz) / (db * ds);
      if (c <= 0) continue;
      const phi = Math.acos(Math.min(1, c));
      const thB = Math.asin(b.def.radius / db);
      if (phi >= thB + thS * 1.6 + 0.02) continue;
      // 0 when the disc is fully behind the limb, 1 when it has cleared it
      const x = (phi - (thB - thS)) / (2 * thS);
      vis *= smooth(0, 1, x);
      const atm = b.def.atmosphere;
      if (atm) {
        // light grazing the limb comes through the air: redder the deeper it passes
        const thA = Math.max(thS, (atm.height * 0.5) / Math.max(db, 1));
        const k = 1 - smooth(thB - thS, thB + thS + thA, phi);
        if (k > this.redden) {
          this.redden = k;
          this.tmpColor.setRGB(atm.sunsetColor[0], atm.sunsetColor[1], atm.sunsetColor[2], THREE.LinearSRGBColorSpace);
        }
      }
    }
    return vis;
  }

  /** True when a world lies between the camera and the camera-relative point `rel` at distance `dist`. */
  private occluded(rx: number, ry: number, rz: number, dist: number, skip: BodyEntry | null): boolean {
    if (!(dist > 0)) return false;
    const inv = Number.isFinite(dist) ? 1 / dist : 1;
    const dx = rx * inv;
    const dy = ry * inv;
    const dz = rz * inv;
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (b === skip) continue;
      const t = b.rel.x * dx + b.rel.y * dy + b.rel.z * dz;
      if (t <= 0 || t >= dist) continue;
      const perp2 = b.dist * b.dist - t * t;
      if (perp2 < b.def.radius * b.def.radius) return true;
    }
    return false;
  }

  /** Absolute position of an object by id (current frame). */
  private absOf(id: string, out: V3): boolean {
    const ship = this.ships.get(id);
    if (ship && ship.lastSeen === this.frameNo) {
      out.x = ship.abs.x;
      out.y = ship.abs.y;
      out.z = ship.abs.z;
      return true;
    }
    const e = this.stationIndex.get(id) ?? this.bodyIndex.get(id) ?? this.siteIndex.get(id);
    if (!e) return false;
    out.x = e.abs.x;
    out.y = e.abs.y;
    out.z = e.abs.z;
    return true;
  }

  refKind(id: string): SceneRefKind | null {
    if (this.ships.has(id)) return 'ship';
    if (this.stationIndex.has(id)) return 'station';
    if (this.bodyIndex.has(id)) return 'body';
    if (this.siteIndex.has(id)) return 'site';
    return null;
  }

  /** Camera collision: `offset` is relative to the focus (world axes); pushed out of stations and worlds in place. */
  private readonly collideCamera = (offset: V3): void => {
    const cx = this.focusAbs.x + offset.x;
    const cy = this.focusAbs.y + offset.y;
    const cz = this.focusAbs.z + offset.z;
    for (let i = 0; i < this.stations.length; i++) {
      const st = this.stations[i];
      const rx = cx - st.abs.x;
      const ry = cy - st.abs.y;
      const rz = cz - st.abs.z;
      if (rx * rx + ry * ry + rz * rz > (st.layout.radius + 30) ** 2) continue;
      const local = unrotTo(this.ta, st.q, rx, ry, rz);
      for (let pass = 0; pass < 2; pass++) {
        if (!stationContact(local, CAMERA_RADIUS, st.layout.colliders, this.contact)) break;
        const n = this.contact.normal;
        const d = this.contact.depth + 0.05;
        local.x += n.x * d;
        local.y += n.y * d;
        local.z += n.z * d;
        const w = rotTo(this.tb, st.q, n.x * d, n.y * d, n.z * d);
        offset.x += w.x;
        offset.y += w.y;
        offset.z += w.z;
      }
    }
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      const rx = this.focusAbs.x + offset.x - b.abs.x;
      const ry = this.focusAbs.y + offset.y - b.abs.y;
      const rz = this.focusAbs.z + offset.z - b.abs.z;
      const d = Math.hypot(rx, ry, rz);
      const min = b.def.radius * 1.0002 + 20;
      if (d < min && d > 1) {
        const k = (min - d) / d;
        offset.x += rx * k;
        offset.y += ry * k;
        offset.z += rz * k;
      }
    }
  };

  private ensureShip(s: FrameShip): ShipEntry {
    let e = this.ships.get(s.id);
    if (e && (e.visualId !== s.visualId || e.seed !== s.seed)) {
      this.disposeShip(e);
      this.ships.delete(s.id);
      const i = this.shipList.indexOf(e);
      if (i >= 0) this.shipList.splice(i, 1);
      e = undefined;
    }
    if (!e) {
      const layout = SHIP_LAYOUTS[s.visualId];
      const visual = createShipVisual(s.visualId, { quality: this.quality, seed: s.seed });
      const group = new THREE.Group();
      group.name = `ship:${s.id}`;
      group.add(visual.object3d);
      let plume: EnginePlume | null = null;
      let strobes: Strobes | null = null;
      if (layout.engines.length) {
        plume = createEnginePlumes(layout.engines, { kind: 'fusion', quality: this.quality });
        group.add(plume.object3d);
      }
      if (layout.lights.length) {
        strobes = createStrobes(layout.lights);
        group.add(strobes.object3d);
      }
      this.nearScene.add(group);
      e = {
        id: s.id,
        visualId: s.visualId,
        seed: s.seed,
        visual,
        plume,
        strobes,
        group,
        abs: v3(),
        rel: v3(),
        dist: 0,
        radius: layout.radius,
        q: { x: 0, y: 0, z: 0, w: 1 },
        lastSeen: -1,
        isPlayer: false,
        ctx: { dt: 0, time: 0, throttle: 0, lightsOn: true, heat: 0, damage: 0 },
      };
      this.ships.set(s.id, e);
      this.shipList.push(e);
    }
    return e;
  }

  private pushMarker(rx: number, ry: number, rz: number, dist: number, sizePx: number, r: number, g: number, b: number): void {
    const m = this.markers;
    if (m.count >= MAX_MARKERS || !(dist > 0)) return;
    const i = m.count++;
    const inv = 1 / dist;
    m.dirSize[i * 4] = rx * inv;
    m.dirSize[i * 4 + 1] = ry * inv;
    m.dirSize[i * 4 + 2] = rz * inv;
    m.dirSize[i * 4 + 3] = sizePx;
    m.color[i * 3] = r;
    m.color[i * 3 + 1] = g;
    m.color[i * 3 + 2] = b;
  }

  // ---------------------------------------------------------------------------------------------- frame

  render(frame: SceneFrame): void {
    const pipeline = this.pipeline;
    const dt = clamp(Number.isFinite(frame.dt) ? frame.dt : 0, 0, 0.1);
    if (this.disposed) return;
    if (this.loading || !this.primary) {
      // nothing to show yet: keep the canvas black rather than stale
      if (!this.loading) pipeline.render([], dt);
      return;
    }
    const t = frame.time;
    this.simTime = t;
    this.frameNo++;
    this.clock = (this.clock + dt) % 36000;
    const frameNo = this.frameNo;
    const sv = this.sv;

    // ---- viewport
    const ps = pipeline.stats();
    const pr = Math.max(pipeline.pixelRatio, 1e-3);
    const cssW = Math.max(1, (ps.outputWidth * ps.resolutionScale) / pr);
    const cssH = Math.max(1, (ps.outputHeight * ps.resolutionScale) / pr);
    this.cssW = cssW;
    this.cssH = cssH;
    const aspect = cssW / cssH;

    // ---- absolute positions straight from the world: bodies, station craft, ship craft (barycentric doubles)
    const bodies = this.bodies;
    const fb = frame.bodies;
    for (let i = 0; i < fb.length; i++) {
      const e = this.bodyIndex.get(fb[i].id);
      if (!e) continue;
      const r = fb[i].r;
      e.abs.x = r.x;
      e.abs.y = r.y;
      e.abs.z = r.z;
      // the body visual spins by time / period: hand it the time that gives the world's spin angle
      const period = Math.abs(e.def.rotationPeriod) > 1 ? e.def.rotationPeriod : 86400;
      e.ctx.time = (fb[i].spinAngle / (2 * Math.PI)) * period;
    }
    const stations = this.stations;
    for (let i = 0; i < stations.length; i++) stations[i].activePort = null;
    const craftList = frame.craft;
    frame.ships.length = 0;
    for (let i = 0; i < craftList.length; i++) {
      const c = craftList[i];
      if (c.kind === 'station') {
        const st = this.stationIndex.get(c.id);
        if (!st) continue;
        st.abs.x = c.r.x;
        st.abs.y = c.r.y;
        st.abs.z = c.r.z;
        st.vel.x = c.v.x;
        st.vel.y = c.v.y;
        st.vel.z = c.v.z;
        st.q.x = c.q.x;
        st.q.y = c.q.y;
        st.q.z = c.q.z;
        st.q.w = c.q.w;
      } else if (c.kind === 'ship' && c.shipVisual) {
        const s = addShip(frame);
        s.id = c.id;
        s.visualId = c.shipVisual;
        s.seed = c.visualSeed;
        s.r.x = c.r.x;
        s.r.y = c.r.y;
        s.r.z = c.r.z;
        s.v.x = c.v.x;
        s.v.y = c.v.y;
        s.v.z = c.v.z;
        s.q.x = c.q.x;
        s.q.y = c.q.y;
        s.q.z = c.q.z;
        s.q.w = c.q.w;
        s.throttle = c.throttle;
        s.rcs.x = c.rcs.x;
        s.rcs.y = c.rcs.y;
        s.rcs.z = c.rcs.z;
        s.heat = c.heat < 0 ? 0 : c.heat > 1 ? 1 : c.heat;
        s.damage = c.hull >= 1 ? 0 : c.hull <= 0 ? 1 : 1 - c.hull;
        s.isPlayer = c.isPlayer;
        s.lightsOn = c.hull > 0;
      }
    }
    for (let i = 0; i < frame.stationExtras.length; i++) {
      const st = this.stationIndex.get(frame.stationExtras[i].stationId);
      if (st) st.activePort = frame.stationExtras[i].activePortId;
    }
    const sites = this.sites;
    const player = playerShip(frame);
    let playerEntry: ShipEntry | null = null;
    for (let i = 0; i < frame.ships.length; i++) {
      const s = frame.ships[i];
      const e = this.ensureShip(s);
      e.abs.x = s.r.x;
      e.abs.y = s.r.y;
      e.abs.z = s.r.z;
      e.q.x = s.q.x;
      e.q.y = s.q.y;
      e.q.z = s.q.z;
      e.q.w = s.q.w;
      e.lastSeen = frameNo;
      e.isPlayer = s === player;
      e.ctx.dt = dt;
      e.ctx.time = this.clock;
      e.ctx.throttle = s.throttle;
      e.ctx.lightsOn = s.lightsOn;
      e.ctx.heat = s.heat;
      e.ctx.damage = s.damage;
      if (s === player) {
        playerEntry = e;
        this.playerVel.x = s.v.x;
        this.playerVel.y = s.v.y;
        this.playerVel.z = s.v.z;
      }
    }
    this.hasPlayer = playerEntry !== null;

    // ---- focus
    const cam = frame.camera;
    const focus = this.focus;
    let focusShip: ShipEntry | null = null;
    let focusStation: StationEntry | null = null;
    let focusBody: BodyEntry | null = null;
    if (cam.focusId) {
      const fs = this.ships.get(cam.focusId);
      if (fs && fs.lastSeen === frameNo) focusShip = fs;
      else focusStation = this.stationIndex.get(cam.focusId) ?? null;
      if (!focusShip && !focusStation) focusBody = this.bodyIndex.get(cam.focusId) ?? null;
    }
    if (!focusShip && !focusStation && !focusBody) {
      if (playerEntry) focusShip = playerEntry;
      else if (stations.length) focusStation = (this.system?.capitalStationId ? this.stationIndex.get(this.system.capitalStationId) : null) ?? stations[0];
      else focusBody = bodies[Math.min(1, bodies.length - 1)];
    }
    const prevFocusId = this.lastFocusId;
    if (focusShip) {
      const layout = SHIP_LAYOUTS[focusShip.visualId as keyof typeof SHIP_LAYOUTS];
      focus.id = focusShip.id;
      focus.kind = 'ship';
      focus.radius = layout.radius;
      focus.q.x = focusShip.q.x;
      focus.q.y = focusShip.q.y;
      focus.q.z = focusShip.q.z;
      focus.q.w = focusShip.q.w;
      focus.chaseDistance = layout.chaseCam.distance;
      focus.chaseHeight = layout.chaseCam.height;
      focus.cockpit.x = layout.cockpit.x;
      focus.cockpit.y = layout.cockpit.y;
      focus.cockpit.z = layout.cockpit.z;
      focus.throttle = focusShip.ctx.throttle;
      this.ta.x = focusShip.abs.x;
      this.ta.y = focusShip.abs.y;
      this.ta.z = focusShip.abs.z;
    } else if (focusStation) {
      focus.id = focusStation.def.id;
      focus.kind = 'station';
      focus.radius = focusStation.layout.radius;
      focus.q.x = focusStation.q.x;
      focus.q.y = focusStation.q.y;
      focus.q.z = focusStation.q.z;
      focus.q.w = focusStation.q.w;
      focus.throttle = 0;
      this.ta.x = focusStation.abs.x;
      this.ta.y = focusStation.abs.y;
      this.ta.z = focusStation.abs.z;
    } else {
      const b = focusBody as BodyEntry;
      focus.id = b.def.id;
      focus.kind = 'body';
      focus.radius = b.def.radius * (b.def.rings ? Math.max(1, (b.def.rings.outerRadius / b.def.radius) * 0.7) : 1);
      focus.q.x = focus.q.y = focus.q.z = 0;
      focus.q.w = 1;
      focus.throttle = 0;
      this.ta.x = b.abs.x;
      this.ta.y = b.abs.y;
      this.ta.z = b.abs.z;
    }
    if (prevFocusId && prevFocusId !== focus.id) {
      // keep the camera where it is in space while the rig blends to the new focus
      if (this.absOf(prevFocusId, this.tb)) {
        this.tc.x = this.ta.x - this.tb.x;
        this.tc.y = this.ta.y - this.tb.y;
        this.tc.z = this.ta.z - this.tb.z;
        this.rig.rebase(this.tc);
      } else this.rig.cut();
    }
    this.lastFocusId = focus.id;
    const fAbs = this.focusAbs;
    fAbs.x = this.ta.x;
    fAbs.y = this.ta.y;
    fAbs.z = this.ta.z;
    if (playerEntry) {
      this.playerAbs.x = playerEntry.abs.x;
      this.playerAbs.y = playerEntry.abs.y;
      this.playerAbs.z = playerEntry.abs.z;
    } else {
      this.playerAbs.x = fAbs.x;
      this.playerAbs.y = fAbs.y;
      this.playerAbs.z = fAbs.z;
    }

    // ---- camera
    const env = this.camEnv;
    env.aspect = aspect;
    env.dock = null;
    env.lookAt = null;
    const guide = frame.environment.dockingGuide;
    let guideStation: StationEntry | null = null;
    let guideSize = 14;
    if (guide) {
      const st = this.stationIndex.get(guide.stationId);
      const port = st?.layout.ports.find((p) => p.id === guide.portId);
      if (st && port) {
        guideStation = st;
        guideSize = BERTHS[port.size].frame;
        const d = this.dockEnv;
        rotTo(d.pos, st.q, port.pos.x, port.pos.y, port.pos.z);
        d.pos.x += st.abs.x - fAbs.x;
        d.pos.y += st.abs.y - fAbs.y;
        d.pos.z += st.abs.z - fAbs.z;
        rotTo(d.dir, st.q, port.dir.x, port.dir.y, port.dir.z);
        rotTo(d.up, st.q, port.up.x, port.up.y, port.up.z);
        env.dock = d;
      }
    }
    if (cam.lookAtId && cam.lookAtId !== focus.id && this.absOf(cam.lookAtId, this.tb)) {
      this.lookEnv.x = this.tb.x - fAbs.x;
      this.lookEnv.y = this.tb.y - fAbs.y;
      this.lookEnv.z = this.tb.z - fAbs.z;
      env.lookAt = this.lookEnv;
    }
    const pose = this.rig.update(dt, cam, focus, env);
    this.pose = pose;
    const camAbs = this.camAbs;
    camAbs.x = fAbs.x + pose.offset.x;
    camAbs.y = fAbs.y + pose.offset.y;
    camAbs.z = fAbs.z + pose.offset.z;
    const cq = this.camQ;
    cq.x = pose.q.x;
    cq.y = pose.q.y;
    cq.z = pose.q.z;
    cq.w = pose.q.w;
    rotTo(this.camFwd, cq, 0, 0, -1);
    const tanY = Math.tan(pose.fovY / 2);
    this.tanY = tanY;
    this.tanX = tanY * aspect;
    const focalCss = cssH / (2 * tanY);
    const focalDev = focalCss * pr;

    // ---- camera-relative positions
    let nearest = 1e9;
    let stationNear = 0; // 0..1: how much of the view a station takes (its own lamps must not be over-exposed)
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      b.rel.x = b.abs.x - camAbs.x;
      b.rel.y = b.abs.y - camAbs.y;
      b.rel.z = b.abs.z - camAbs.z;
      b.dist = Math.max(len3(b.rel), 1);
    }
    for (let i = 0; i < stations.length; i++) {
      const st = stations[i];
      st.rel.x = st.abs.x - camAbs.x;
      st.rel.y = st.abs.y - camAbs.y;
      st.rel.z = st.abs.z - camAbs.z;
      st.dist = Math.max(len3(st.rel), 1);
      nearest = Math.min(nearest, st.dist - st.layout.radius);
      stationNear = Math.max(stationNear, smooth(0.02, 0.2, st.layout.radius / st.dist));
    }
    for (let i = 0; i < sites.length; i++) {
      const s = sites[i];
      s.rel.x = s.abs.x - camAbs.x;
      s.rel.y = s.abs.y - camAbs.y;
      s.rel.z = s.abs.z - camAbs.z;
      s.dist = Math.max(len3(s.rel), 1);
    }
    for (let i = this.shipList.length - 1; i >= 0; i--) {
      const e = this.shipList[i];
      if (e.lastSeen !== frameNo) {
        e.group.visible = false;
        if (frameNo - e.lastSeen > SHIP_IDLE_FRAMES) {
          this.disposeShip(e);
          this.ships.delete(e.id);
          this.shipList.splice(i, 1);
        }
        continue;
      }
      e.rel.x = e.abs.x - camAbs.x;
      e.rel.y = e.abs.y - camAbs.y;
      e.rel.z = e.abs.z - camAbs.z;
      e.dist = len3(e.rel);
      nearest = Math.min(nearest, e.dist - e.radius * 2.6);
    }

    // ---- light at the focus
    const star = this.primary;
    const lum = star.def.star ? star.def.star.luminosity : 1;
    const lx = focusBody ? camAbs.x : fAbs.x;
    const ly = focusBody ? camAbs.y : fAbs.y;
    const lz = focusBody ? camAbs.z : fAbs.z;
    {
      const sx = star.abs.x - lx;
      const sy = star.abs.y - ly;
      const sz = star.abs.z - lz;
      const ds = Math.max(Math.hypot(sx, sy, sz), 1);
      this.sunDirFocus.set(sx / ds, sy / ds, sz / ds);
      const vis = this.starVisibility(lx, ly, lz, null, 0);
      const level = starIntensityAt(ds, lum) * vis;
      this.keyLevel = level;
      this.keyColor.copy(this.lightColor);
      if (this.redden > 0) {
        // through the air of the world in the way: toward its sunset colour, and dimmer
        const k = this.redden * 0.85;
        const sc = this.tmpColor;
        const m = Math.max(sc.r, sc.g, sc.b, 1e-3);
        this.keyColor.r *= 1 + (sc.r / m - 1) * k;
        this.keyColor.g *= 1 + (sc.g / m - 1) * k;
        this.keyColor.b *= 1 + (sc.b / m - 1) * k;
      }
      this.key.color.copy(this.keyColor);
      this.key.intensity = Math.PI * level;
      this.key.position.copy(this.sunDirFocus).multiplyScalar(1000);
    }

    // ---- worlds: light, placement, update; planetshine and metering on the way
    let shineE = 0;
    let shineR = 0;
    let shineG = 0;
    let shineB = 0;
    const shineDir = this.tv2.set(0, 0, 0);
    let bright = 0;
    const thV = Math.atan(Math.max(tanY, this.tanX)) * 0.9;
    const m = this.markers;
    m.count = 0;
    m.uPx.set(2 / cssW, 2 / cssH);
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      const R = b.def.radius;
      const D = 10 + 10 * Math.log10(Math.max(b.dist, 1e3) / 1e3);
      const S = (R * D) / b.dist;
      const inv = 1 / b.dist;
      b.camLocal.set(-b.rel.x / R, -b.rel.y / R, -b.rel.z / R);
      const dr = b.dist / R;
      b.radiusPx = dr > 1.0001 ? focalCss / Math.sqrt(dr * dr - 1) : 1e5;
      const obj = b.star ? b.star.object3d : (b.visual as BodyVisual).object3d;
      obj.position.set(b.rel.x * inv * D, b.rel.y * inv * D, b.rel.z * inv * D);
      obj.scale.setScalar(S);
      if (b.star) {
        b.star.update({ time: this.clock, cameraPosLocal: b.camLocal, pixelRadius: b.radiusPx * pr });
        continue;
      }
      // star light on this world
      const sx = star.abs.x - b.abs.x;
      const sy = star.abs.y - b.abs.y;
      const sz = star.abs.z - b.abs.z;
      const ds = Math.max(Math.hypot(sx, sy, sz), 1);
      b.sunDir.set(sx / ds, sy / ds, sz / ds);
      b.light = starIntensityAt(ds, lum) * this.starVisibility(b.abs.x, b.abs.y, b.abs.z, b, R * 0.5);
      b.ctx.starIntensity = b.light;
      b.ctx.pixelRadius = b.radiusPx * pr;
      (b.visual as BodyVisual).update(b.ctx);

      // how much of the cap of this world seen from a point is sun-lit: at the focus (planetshine) and the camera (metering)
      const fx = lx - b.abs.x;
      const fy = ly - b.abs.y;
      const fz = lz - b.abs.z;
      const df = Math.max(Math.hypot(fx, fy, fz), R * 1.0001);
      if (df < R * 80) {
        const sinT = R / df;
        const sinB = Math.sqrt(Math.max(0, 1 - sinT * sinT));
        const cosS = (fx * b.sunDir.x + fy * b.sunDir.y + fz * b.sunDir.z) / df;
        const lit = clamp((cosS + 0.3 * sinB) / (1 + 0.3 * sinB), 0, 1);
        const E = b.light * lit * sinT * sinT * 0.85;
        if (E > 1e-5) {
          shineE += E;
          shineR += b.albedo.r * E;
          shineG += b.albedo.g * E;
          shineB += b.albedo.b * E;
          // from the world's centre, leaning toward its day side
          const w = E * b.albedoLum;
          shineDir.x += (-fx / df + b.sunDir.x * 0.55 * (1 - lit)) * w;
          shineDir.y += (-fy / df + b.sunDir.y * 0.55 * (1 - lit)) * w;
          shineDir.z += (-fz / df + b.sunDir.z * 0.55 * (1 - lit)) * w;
        }
      }
      if (dr > 1.0001) {
        const angR = Math.asin(1 / dr);
        const sep = Math.acos(clamp((b.rel.x * this.camFwd.x + b.rel.y * this.camFwd.y + b.rel.z * this.camFwd.z) * inv, -1, 1));
        const cover = clamp((thV + angR - sep) / (2 * Math.min(thV, angR)), 0, 1) * Math.min(1, (angR * angR) / (thV * thV));
        if (cover > 0) {
          const sinB = Math.sqrt(Math.max(0, 1 - 1 / (dr * dr)));
          const cosS = -(b.rel.x * b.sunDir.x + b.rel.y * b.sunDir.y + b.rel.z * b.sunDir.z) * inv;
          const lit = clamp((cosS + 0.3 * sinB) / (1 + 0.3 * sinB), 0, 1);
          bright += cover * lit * b.albedoLum * b.light;
        }
      }
      // a world too small to resolve is a point of light
      if (b.radiusPx < 2 && !this.occluded(b.rel.x, b.rel.y, b.rel.z, b.dist, b)) {
        const cosS = -(b.rel.x * b.sunDir.x + b.rel.y * b.sunDir.y + b.rel.z * b.sunDir.z) * inv;
        const phase = 0.15 + 0.85 * (0.5 + 0.5 * cosS);
        const k = (1 - smooth(1, 2, b.radiusPx)) * 2.2 * b.light * phase * Math.pow(clamp(b.radiusPx / 2, 0.02, 1), 0.55);
        this.pushMarker(b.rel.x, b.rel.y, b.rel.z, b.dist, 4.5, b.albedo.r * k * this.lightColor.r, b.albedo.g * k * this.lightColor.g, b.albedo.b * k * this.lightColor.b);
      }
    }
    if (shineE > 1e-5) {
      const k = 1 / shineE;
      this.shineColor.setRGB(shineR * k * this.lightColor.r, shineG * k * this.lightColor.g, shineB * k * this.lightColor.b, THREE.LinearSRGBColorSpace);
      const avg = (shineR + shineG + shineB) / 3;
      this.shine.color.copy(this.shineColor);
      this.shine.intensity = Math.PI * shineE * (avg > 0 ? 1 : 0);
      if (shineDir.lengthSq() > 1e-12) this.shine.position.copy(shineDir).normalize().multiplyScalar(1000);
    } else this.shine.intensity = 0;
    const shineLevel = shineE > 1e-5 ? ((shineR + shineG + shineB) / 3) * 1 : 0;

    // ---- cameras
    const near = clamp(nearest * 0.25, 0.3, 60);
    const nc = this.nearCam;
    nc.quaternion.set(cq.x, cq.y, cq.z, cq.w);
    nc.fov = (pose.fovY * 180) / Math.PI;
    nc.aspect = aspect;
    nc.near = near;
    nc.updateProjectionMatrix();
    const fc = this.farCam;
    fc.quaternion.copy(nc.quaternion);
    fc.fov = nc.fov;
    fc.aspect = aspect;
    fc.updateProjectionMatrix();
    const shiftY = pose.mode === 'interior' ? 0 : frame.camera.shiftY ?? 0;
    if (shiftY !== 0) {
      // lens shift: NDC y moves up by shiftY for every point (clip.y += -shiftY * z_view = shiftY * w)
      nc.projectionMatrix.elements[9] -= shiftY;
      nc.projectionMatrixInverse.copy(nc.projectionMatrix).invert();
      fc.projectionMatrix.elements[9] -= shiftY;
      fc.projectionMatrixInverse.copy(fc.projectionMatrix).invert();
    }

    // ---- stations
    for (let i = 0; i < stations.length; i++) {
      const st = stations[i];
      st.radiusPx = (st.layout.radius / st.dist) * focalCss;
      const obj = st.visual.object3d;
      const show = st.radiusPx > STATION_MIN_PX;
      st.shown = show;
      obj.visible = show;
      if (show) {
        const k = st.dist > STATION_PLACE_MAX ? STATION_PLACE_MAX / st.dist : 1;
        obj.position.set(st.rel.x * k, st.rel.y * k, st.rel.z * k);
        obj.scale.setScalar(k);
        obj.quaternion.set(st.q.x, st.q.y, st.q.z, st.q.w);
        st.ctx.dt = dt;
        st.ctx.time = t;
        st.ctx.activePortId = st.activePort;
        st.visual.update(st.ctx);
      }
      const w = 1 - smooth(STATION_MIN_PX, STATION_MIN_PX * 2, st.radiusPx);
      if (w > 0 && !this.occluded(st.rel.x, st.rel.y, st.rel.z, st.dist, null)) {
        // sun-lit hull plus its own lights; never quite gone, so a station can be found by eye
        const lit = this.starVisibility(st.abs.x, st.abs.y, st.abs.z, null, 0) * starIntensityAt(Math.max(len3(st.abs), 1), lum);
        const k = w * clamp(1.7 * Math.sqrt(st.radiusPx / STATION_MIN_PX), 0.16, 1.7);
        const c = this.lightColor;
        this.pushMarker(st.rel.x, st.rel.y, st.rel.z, st.dist, 5, k * (0.3 + 0.7 * lit * c.r), k * (0.24 + 0.7 * lit * c.g), k * (0.16 + 0.7 * lit * c.b));
      }
    }

    // ---- ships and their effects
    const fxm = this.fx;
    const warpFx = frame.warp <= 4;
    for (let i = 0; i < this.shipList.length; i++) {
      const e = this.shipList[i];
      if (e.lastSeen !== frameNo) continue;
      const inRange = e.dist < FAR_PLANE * 0.95;
      // the player's own hull is drawn in every camera mode (from inside it shows through the windows only)
      const hidden = false;
      e.group.visible = inRange;
      e.visual.object3d.visible = !hidden;
      if (!inRange) {
        if (!this.occluded(e.rel.x, e.rel.y, e.rel.z, e.dist, null)) {
          const k = clamp(1.2 * Math.sqrt((e.radius / e.dist) * focalCss), 0.1, 1.2) * (0.25 + 0.75 * this.keyLevel);
          this.pushMarker(e.rel.x, e.rel.y, e.rel.z, e.dist, 4, k, k * 0.95, k * 0.85);
        }
        continue;
      }
      e.group.position.set(e.rel.x, e.rel.y, e.rel.z);
      e.group.quaternion.set(e.q.x, e.q.y, e.q.z, e.q.w);
      e.visual.update(e.ctx);
      if (e.plume) {
        e.plume.setThrottle(e.ctx.throttle);
        e.plume.update(dt, this.clock);
        e.plume.object3d.visible = e.plume.level > 0.004;
      }
      if (e.strobes) {
        e.strobes.object3d.visible = e.ctx.lightsOn && !hidden;
        e.strobes.update(dt, this.clock);
      }
    }
    if (fxm) {
      fxm.object3d.position.set(this.playerAbs.x - camAbs.x, this.playerAbs.y - camAbs.y, this.playerAbs.z - camAbs.z);
      if (warpFx) {
        for (let i = 0; i < frame.ships.length; i++) {
          const s = frame.ships[i];
          const a = s.rcs;
          if (a.x * a.x + a.y * a.y + a.z * a.z < 0.01) continue;
          const e = this.ships.get(s.id);
          if (!e || e.dist > 3000) continue;
          const jets = SHIP_LAYOUTS[s.visualId].rcs;
          for (let j = 0; j < jets.length; j++) {
            const jet = jets[j];
            const fire = -(jet.dir.x * a.x + jet.dir.y * a.y + jet.dir.z * a.z);
            if (fire < 0.25) continue;
            const p = rotTo(this.ta, e.q, jet.pos.x, jet.pos.y, jet.pos.z);
            p.x += e.abs.x - this.playerAbs.x;
            p.y += e.abs.y - this.playerAbs.y;
            p.z += e.abs.z - this.playerAbs.z;
            fxm.rcsPuff(p, rotTo(this.tb, e.q, jet.dir.x, jet.dir.y, jet.dir.z), Math.min(1, fire));
          }
        }
      }
      // docking guide
      if (guideStation && env.dock && playerEntry) {
        const d = env.dock;
        const dp = this.tc;
        dp.x = d.pos.x + fAbs.x - this.playerAbs.x;
        dp.y = d.pos.y + fAbs.y - this.playerAbs.y;
        dp.z = d.pos.z + fAbs.z - this.playerAbs.z;
        this.dockPort.pos = dp;
        this.dockPort.dir = d.dir;
        this.dockPort.up = d.up;
        // alignment: the ship's collar against the port axis, and how far off the axis it sits
        const collar = SHIP_LAYOUTS[playerEntry.visualId as keyof typeof SHIP_LAYOUTS].dockingPort;
        const cd = rotTo(this.ta, playerEntry.q, collar.dir.x, collar.dir.y, collar.dir.z);
        const facing = -(cd.x * d.dir.x + cd.y * d.dir.y + cd.z * d.dir.z);
        const cp = rotTo(this.tb, playerEntry.q, collar.pos.x, collar.pos.y, collar.pos.z);
        const ox = cp.x - dp.x;
        const oy = cp.y - dp.y;
        const oz = cp.z - dp.z;
        const along = ox * d.dir.x + oy * d.dir.y + oz * d.dir.z;
        const lateral = Math.hypot(ox - d.dir.x * along, oy - d.dir.y * along, oz - d.dir.z * along);
        const aligned = smooth(0.9, 0.995, facing) * (1 - smooth(0.25, 1, lateral / Math.max(4, guideSize * 0.5)));
        fxm.dockingGuide(this.dockPort, guideSize, aligned);
      } else fxm.dockingGuide(null);
      // dust drifts past near a station, where there is something to move against
      let dust = 0;
      const dv = this.td;
      dv.x = dv.y = dv.z = 0;
      if (playerEntry && warpFx) {
        for (let i = 0; i < stations.length; i++) {
          const st = stations[i];
          const d = Math.hypot(st.abs.x - this.playerAbs.x, st.abs.y - this.playerAbs.y, st.abs.z - this.playerAbs.z);
          const k = 1 - smooth(st.layout.controlZone * 0.6, st.layout.controlZone * 2.5, d);
          if (k > dust) {
            dust = k;
            dv.x = this.playerVel.x - st.vel.x;
            dv.y = this.playerVel.y - st.vel.y;
            dv.z = this.playerVel.z - st.vel.z;
          }
        }
      }
      fxm.setDust(dv, dust * 0.8);
      // aerobraking
      const reentry = clamp(frame.environment.reentry, 0, 1);
      if (reentry > 0.01 && playerEntry && player) {
        const sp = Math.max(len3(player.v), 1);
        const vl = unrotTo(this.ta, playerEntry.q, player.v.x / sp, player.v.y / sp, player.v.z / sp);
        fxm.reentryPlasma(playerEntry.group, playerEntry.radius, reentry, vl);
      }
      pipeline.setEffect('heat', reentry * 0.8);
      // one-shots (positions relative to the player ship = the fx frame)
      for (let i = 0; i < frame.fx.length; i++) {
        const f = frame.fx[i];
        if (f.kind === 'explosion') fxm.explosion(f.pos, f.size, { kind: f.size > 40 ? 'large' : f.size > 12 ? 'ship' : 'small' });
        else if (f.kind === 'sparks') fxm.impactSparks(f.pos, f.to, f.color, f.size);
        else fxm.laserBeam(f.pos, f.to, f.color, f.size);
      }
      this.ta.x = camAbs.x - this.playerAbs.x;
      this.ta.y = camAbs.y - this.playerAbs.y;
      this.ta.z = camAbs.z - this.playerAbs.z;
      fxm.update(dt, this.clock, this.ta);
    }

    // ---- star glare: hidden by worlds, and by any hull between the lens and the star
    const insideNow = pose.mode === 'interior' && pose.hideFocus && focusShip !== null;
    if (this.hullTexBytes < 0 && playerEntry) this.hullTexBytes = textureBytesOf(playerEntry.visual.object3d);
    const sdx = star.rel.x / star.dist;
    const sdy = star.rel.y / star.dist;
    const sdz = star.rel.z / star.dist;
    let glareVis = star.dist > star.def.radius ? this.starVisibilityFromCamera() : 1;
    if (glareVis > 0) {
      for (let i = 0; i < stations.length && glareVis > 0; i++) {
        const st = stations[i];
        if (!st.shown || st.dist > st.layout.radius + FAR_PLANE) continue;
        const along = st.rel.x * sdx + st.rel.y * sdy + st.rel.z * sdz;
        if (along < -st.layout.radius) continue;
        const perp2 = st.dist * st.dist - along * along;
        if (perp2 > st.layout.radius * st.layout.radius) continue;
        const o = unrotTo(this.ta, st.q, -st.rel.x, -st.rel.y, -st.rel.z);
        const d = unrotTo(this.tb, st.q, sdx, sdy, sdz);
        const cols = st.layout.colliders;
        for (let c = 0; c < cols.length; c++) {
          const col = cols[c];
          const rr = col.radius * 0.9;
          if (raySegDist2(o.x, o.y, o.z, d.x, d.y, d.z, 1e6, col.a, col.b) < rr * rr) {
            glareVis = 0;
            break;
          }
        }
      }
      for (let i = 0; i < this.shipList.length && glareVis > 0; i++) {
        const e = this.shipList[i];
        if (e.lastSeen !== frameNo || !e.visual.object3d.visible || e.dist > FAR_PLANE) continue;
        if (insideNow && e === focusShip) continue; // from inside: the window test below
        const along = e.rel.x * sdx + e.rel.y * sdy + e.rel.z * sdz;
        if (along <= 0) continue;
        const perp = Math.sqrt(Math.max(0, e.dist * e.dist - along * along));
        glareVis *= smooth(e.radius * 0.25, e.radius * 0.6, perp);
      }
    }
    const li = this.interior?.lighting;
    if (insideNow && focusShip && li && glareVis > 0) {
      // the star seen through a window opening of a drawn room; the frames cut it off softly
      const dl = unrotTo(this.tc, focusShip.q, sdx, sdy, sdz);
      glareVis *= li.starThroughWindow(frame.camera.eye ?? this.lightFrame.eye, dl, Math.asin(Math.min(1, star.def.radius / star.dist)));
    }
    this.glareVis += (glareVis - this.glareVis) * (this.evInit ? 1 - Math.exp(-dt / 0.08) : 1);
    if (this.glare) {
      // drawn last, over everything: in the interior pass when inside (the interior would hide it otherwise)
      const host = insideNow ? this.insideScene : this.nearScene;
      if (this.glare.object3d.parent !== host) host.add(this.glare.object3d);
      const dv = unrotTo(this.ta, cq, sdx, sdy, sdz);
      this.tv.set(dv.x, dv.y, dv.z);
      this.glareCtx.starDirView = this.tv;
      this.glareCtx.starColor = this.starPhys;
      this.glareCtx.angularRadius = Math.asin(Math.min(1, star.def.radius / star.dist));
      this.glareCtx.visibility = this.glareVis;
      this.glareCtx.aspect = aspect;
      this.glareCtx.fov = pose.fovY;
      this.glare.update(this.glareCtx);
    }

    // ---- exposure: meter the light on the focus and the sun-lit worlds in view
    const metered = Math.max(0.5 * this.keyLevel + 0.6 * shineLevel + 4 * bright, 0.1);
    // Beside a station in eclipse the meter reads the dark hull and opened right up, so the station's windows and
    // floodlights bloomed into a grey veil over the whole view: stop down toward the lamps' own level there.
    const evWant = clamp(-Math.log2(metered / 0.5), EV_MIN, EV_MAX - (EV_MAX - 0.8) * stationNear);
    if (!this.evInit) {
      this.ev = evWant;
      this.evInit = true;
    } else this.ev += (evWant - this.ev) * (1 - Math.exp(-dt / (evWant < this.ev ? 0.6 : 1.4)));
    pipeline.setExposure(this.ev);
    // inside: the image meters itself (mean log luminance on the GPU), so a sun patch, a dark cabin and a
    // bright world filling the window all expose like a camera would
    pipeline.setAutoExposure(insideNow, AUTO_EXPOSURE);
    if (this.sky) {
      this.sky.update({ exposure: Math.pow(2, -0.55 * this.ev) });
      // keep the star's lobe in the reflection environment in step with the key light
      this.envAge += dt;
      const level = this.keyLevel * 0.22;
      const moved = this.envDir.dot(this.sunDirFocus) < 0.9986; // about 3 degrees
      const changed = Math.abs(level - this.envIntensity) > 0.02 + 0.12 * this.envIntensity || Math.abs(this.envColor.g - this.keyColor.g) > 0.06;
      if (this.envIntensity < 0 || ((moved || changed) && this.envAge > 0.25)) {
        this.sky.setStarLight(this.sunDirFocus, this.keyColor, level);
        this.envDir.copy(this.sunDirFocus);
        this.envColor.copy(this.keyColor);
        this.envIntensity = level;
        this.envAge = 0;
      }
    }

    // ---- markers, draw
    m.geo.instanceCount = m.count;
    m.mesh.visible = m.count > 0;
    if (m.count > 0) {
      m.aDir.needsUpdate = true;
      m.aCol.needsUpdate = true;
    }
    // ---- inside the player's ship: the interior in its own pass over the outside world, lit by itself, so
    // the star does not shine through the bulkheads and the window openings show what is really out there
    let layers = this.layers;
    const inside = insideNow;
    this.extraCalls = 0;
    this.extraTris = 0;
    // the hull's live environment: one face of the outside every few frames (before the HDR target is bound)
    if (this.outsideEnv) {
      this.outsideEnv.update(this.farScene, this.envHide, this.outsideEnv.captures === 0);
      this.extraCalls += this.outsideEnv.drawCalls;
    }
    const host = inside ? focusShip : playerEntry;
    const interior = host ? this.ensureInterior(host) : null;
    this.pickValid = false;
    if (interior) {
      const obj = interior.object3d;
      obj.visible = inside;
      if (inside && focusShip) {
        obj.position.set(focusShip.rel.x, focusShip.rel.y, focusShip.rel.z);
        obj.quaternion.set(focusShip.q.x, focusShip.q.y, focusShip.q.z, focusShip.q.w);
        const ic = this.insideCam;
        ic.quaternion.copy(this.nearCam.quaternion);
        ic.fov = this.nearCam.fov;
        ic.aspect = aspect;
        ic.updateProjectionMatrix();
        const c = this.interiorCtx;
        c.time = this.clock;
        c.lights = frame.cabinLights !== false;
        const eye = frame.camera.eye;
        c.eye.x = eye ? eye.x : 0;
        c.eye.y = eye ? eye.y : 0;
        c.eye.z = eye ? eye.z : 0;
        c.gain = Math.pow(2, -this.ev) * CABIN_GAIN;
        unrotTo(c.sunDir, focusShip.q, this.sunDirFocus.x, this.sunDirFocus.y, this.sunDirFocus.z);
        c.sunColor.r = this.keyColor.r * this.keyLevel;
        c.sunColor.g = this.keyColor.g * this.keyLevel;
        c.sunColor.b = this.keyColor.b * this.keyLevel;
        const sh = (this.shine.intensity / Math.PI) * 1.5;
        c.windowColor.r = this.shine.color.r * sh + c.sunColor.r * 0.1;
        c.windowColor.g = this.shine.color.g * sh + c.sunColor.g * 0.1;
        c.windowColor.b = this.shine.color.b * sh + c.sunColor.b * 0.1;
        interior.update(c);
        if (li) {
          ic.position.set(0, 0, 0);
          ic.updateMatrixWorld();
          const lf = this.lightFrame;
          lf.eye.x = c.eye.x;
          lf.eye.y = c.eye.y;
          lf.eye.z = c.eye.z;
          lf.sunDir.copy(this.sunDirFocus);
          lf.sunColor.copy(this.keyColor);
          lf.sunIntensity = this.key.intensity;
          lf.shineDir.copy(this.shine.position);
          if (lf.shineDir.lengthSq() > 1e-12) lf.shineDir.normalize();
          lf.shineColor.copy(this.shine.color);
          lf.shineIntensity = this.shine.intensity;
          lf.lights = c.lights;
          lf.dt = dt;
          li.update(lf, ic);
          this.extraCalls += li.stats.drawCalls;
          this.extraTris += li.stats.triangles;
        }
        const cockpit = this.interior?.cockpit;
        if (cockpit) {
          const k = this.cockpitCtx;
          k.devices = frame.devices ?? NO_DEVICES;
          k.time = c.time;
          k.lights = c.lights;
          k.gain = c.gain;
          k.instruments = frame.instruments ?? null;
          cockpit.update(k);
          this.pickValid = true;
          this.pickRel.x = focusShip.rel.x;
          this.pickRel.y = focusShip.rel.y;
          this.pickRel.z = focusShip.rel.z;
          this.pickQ.x = focusShip.q.x;
          this.pickQ.y = focusShip.q.y;
          this.pickQ.z = focusShip.q.z;
          this.pickQ.w = focusShip.q.w;
        }
        layers = this.layersInside;
      } else if (this.frameNo % 2 === 0) {
        // outside (the title orbit, a chase view): the interior is hidden, but its time-sliced texture work
        // (the full-size surface atlas) keeps going so it is done before the player steps inside
        const c = this.interiorCtx;
        c.time = this.clock;
        interior.update(c);
      }
    }
    pipeline.render(layers, dt);
    this.publishInfo(inside);
  }

  /** Numbers for the perf overlay and the performance report (src/app/perf.ts). */
  private publishInfo(inside: boolean): void {
    if (this.frameNo % 15 !== 0) return; // a few times a second is plenty (and no string per frame)
    const ps = this.pipeline.stats();
    const t = TIER_SETTINGS[this.quality];
    const ri = renderInfo;
    ri.tier = this.quality;
    ri.msaa = ps.msaa;
    const li = this.interior?.lighting;
    ri.shadow = t.shadow;
    ri.shineShadow = li?.shine ? t.shineShadow : 0;
    ri.probe = t.probe;
    ri.envProbe = this.outsideEnv ? t.envProbe : 0;
    ri.drawCalls = ps.drawCalls + this.extraCalls;
    ri.triangles = ps.triangles + this.extraTris;
    ri.textureBytes = this.textureBytes();
    ri.targetBytes = ps.targetBytes;
    ri.rooms = inside && li ? li.stats.rooms : 0;
    ri.roomsTotal = inside && li ? li.stats.roomsTotal : 0;
    ri.room = inside && li ? li.stats.room : '';
    ri.exposure = ps.autoExposure ? 'auto' : this.ev.toFixed(2);
  }

  private readonly dockPort: { pos: V3; dir: V3; up: V3 } = { pos: v3(), dir: v3(), up: v3() };
  private readonly glareCtx = { starDirView: new THREE.Vector3(0, 0, -1), starColor: new THREE.Color(1, 1, 1), angularRadius: 0.01, visibility: 1, aspect: 1, fov: 1 };

  private starVisibilityFromCamera(): number {
    const keep = this.redden;
    const keepR = this.tmpColor.r;
    const keepG = this.tmpColor.g;
    const keepB = this.tmpColor.b;
    const v = this.starVisibility(this.camAbs.x, this.camAbs.y, this.camAbs.z, null, 0);
    this.redden = keep;
    this.tmpColor.setRGB(keepR, keepG, keepB, THREE.LinearSRGBColorSpace);
    return v;
  }

  // ---------------------------------------------------------------------------------------------- project / pick

  project(ref: SceneRef, out: Projection = this.projOut): Projection {
    let rx = 0;
    let ry = 0;
    let rz = 0;
    let radius = 0;
    let isDir = false;
    let found = true;
    let skip: BodyEntry | null = null;
    if (typeof ref === 'string') {
      const ship = this.ships.get(ref);
      if (ship && ship.lastSeen === this.frameNo) {
        rx = ship.rel.x;
        ry = ship.rel.y;
        rz = ship.rel.z;
        radius = ship.radius;
      } else {
        const st = this.stationIndex.get(ref);
        const b = st ? undefined : this.bodyIndex.get(ref);
        const site = st || b ? undefined : this.siteIndex.get(ref);
        const e = st ?? b ?? site;
        if (e) {
          rx = e.rel.x;
          ry = e.rel.y;
          rz = e.rel.z;
          radius = st ? st.layout.radius : b ? b.def.radius : 0;
          skip = b ?? null;
        } else found = false;
      }
    } else if ('dir' in ref) {
      const l = Math.max(len3(ref.dir), 1e-12);
      rx = ref.dir.x / l;
      ry = ref.dir.y / l;
      rz = ref.dir.z / l;
      isDir = true;
    } else if ('point' in ref) {
      rx = this.playerAbs.x + ref.point.x - this.camAbs.x;
      ry = this.playerAbs.y + ref.point.y - this.camAbs.y;
      rz = this.playerAbs.z + ref.point.z - this.camAbs.z;
    } else {
      const st = this.stationIndex.get(ref.stationId);
      const port = st?.layout.ports.find((p) => p.id === ref.portId);
      if (st && port) {
        const w = rotTo(this.ta, st.q, port.pos.x, port.pos.y, port.pos.z);
        rx = st.rel.x + w.x;
        ry = st.rel.y + w.y;
        rz = st.rel.z + w.z;
      } else found = false;
    }
    if (!found) {
      out.x = out.y = 0;
      out.visible = false;
      out.behind = true;
      out.distance = Infinity;
      out.radiusPx = 0;
      out.occluded = false;
      return out;
    }
    const dist = isDir ? Infinity : Math.hypot(rx, ry, rz);
    const v = unrotTo(this.tb, this.camQ, rx, ry, rz);
    const behind = v.z >= 0;
    const zc = Math.max(Math.abs(v.z), 1e-9 * Math.max(1, Math.abs(v.x), Math.abs(v.y)));
    let nx = v.x / (zc * this.tanX);
    let ny = v.y / (zc * this.tanY);
    if (behind) {
      // keep the bearing, push it beyond the edge so the HUD can clamp an arrow there
      const mag = Math.max(Math.abs(nx), Math.abs(ny), 1e-9);
      const k = 4 / mag;
      nx *= k;
      ny *= k;
    }
    out.x = (nx * 0.5 + 0.5) * this.cssW;
    out.y = (0.5 - ny * 0.5) * this.cssH;
    out.behind = behind;
    out.visible = !behind && Math.abs(nx) <= 1 && Math.abs(ny) <= 1;
    out.distance = dist;
    const focal = this.cssH / (2 * this.tanY);
    out.radiusPx = radius > 0 && dist > radius * 1.0001 ? (radius / Math.sqrt(dist * dist - radius * radius)) * focal : radius > 0 ? 1e5 : 0;
    out.occluded = isDir ? false : this.occluded(rx, ry, rz, dist, skip);
    return out;
  }

  pickDevice(x: number, y: number, heldId?: string): CockpitPick | null {
    const cockpit = this.interior?.cockpit;
    if (!cockpit || !this.pickValid) return null;
    // the touch as a ray from the eye, in the ship's own axes
    const v = this.pickV;
    v.set(((x / this.cssW) * 2 - 1) * this.tanX, (1 - (y / this.cssH) * 2) * this.tanY, -1).normalize().applyQuaternion(this.insideCam.quaternion);
    unrotTo(this.pickD, this.pickQ, v.x, v.y, v.z);
    unrotTo(this.pickO, this.pickQ, -this.pickRel.x, -this.pickRel.y, -this.pickRel.z);
    // a finger covers about 22 CSS px either side of its centre
    const tol = Math.atan((22 * 2 * this.tanY) / Math.max(1, this.cssH));
    return cockpit.pick(this.pickO, this.pickD, tol, heldId);
  }

  pick(x: number, y: number): string | null {
    let best: string | null = null;
    let bestScore = Infinity;
    const p = this.pickOut;
    const consider = (id: string, rank: number): void => {
      this.project(id, p);
      if (p.behind || p.occluded) return;
      const reach = Math.max(p.radiusPx, PICK_RADIUS);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d > reach) return;
      // small things win over the world behind them, things with a visible size over far points of light;
      // among equals the closest to the finger
      const score = (rank + (rank < 2 && p.radiusPx < 1 ? 0.5 : 0)) * 1e6 + (rank >= 2 ? p.radiusPx * 100 : 0) + d;
      if (score < bestScore) {
        bestScore = score;
        best = id;
      }
    };
    for (let i = 0; i < this.shipList.length; i++) {
      const e = this.shipList[i];
      if (e.lastSeen === this.frameNo && !e.isPlayer) consider(e.id, 0);
    }
    for (let i = 0; i < this.stations.length; i++) consider(this.stations[i].def.id, 0);
    for (let i = 0; i < this.sites.length; i++) consider(this.sites[i].def.id, 1);
    for (let i = 0; i < this.bodies.length; i++) consider(this.bodies[i].def.id, 2);
    return best;
  }
}

/**
 * Create the scene manager for a pipeline. Call setSystem() (and await it) before the first render();
 * render() before that only clears the canvas.
 */
const NO_DEVICES: readonly DeviceView[] = [];
/** Inside the ship: key 0.16 on the mean log luminance, -2.5..+3 stops. */
const AUTO_EXPOSURE = { key: 0.16, minEv: -2.5, maxEv: 3, compensation: 0 };

export function createSceneManager(pipeline: RenderPipeline, opts: SceneManagerOptions): SceneManager {
  return new Manager(pipeline, opts);
}
