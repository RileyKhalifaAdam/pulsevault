// The docking camera as pure geometry and sensor physics (docs/SIMULATION.md W3-C item 4): where the camera on the
// collar is and how it is turned (so a later render step can draw the real scene from it), what it would see of the
// target port and the station (pixel position, apparent size, lateral offset and misalignment relative to the
// boresight, roll, occlusion), whether the star is in the frame (blooming), auto-exposure with τ = 0.5 s (exact
// exponential in log exposure, any step), and the pixel noise model (shot noise ∝ √signal plus read noise).
//
// Camera: 60° horizontal FOV, 256×192 px, pinhole; camera-local axes as a three.js camera (looks along −Z, +Y up,
// +X right). Image coordinates: u right, v down, origin at the top-left pixel corner; the principal point is the
// centre (128, 96). On the Wren the camera looks out of the dorsal collar (+Y) with the nose (−Z) at the top of the
// image, so the ship's +X appears on the image's LEFT, as it would through that window.
//
// WIRING (wave 3):
// - render/dockcam.ts (new, W3-C render step), once per camera frame (every DOCKCAM_TICKS ticks = 10 Hz) while
//   dockCamActive(pageShown, range) is true (the docking page is shown and a station is within 2 km, §1.2.2 gate):
//     dockCamView(world, ship, station, portIx, sunBody, VIEW)   // VIEW.camPos (ship-relative, inertial), VIEW.camQ
//     → set the 256×192 render camera to (ship render position + VIEW.camPos, VIEW.camQ), fov = DOCKCAM_VFOV (deg),
//       render before the frame's HDR target is bound, use the target as the NAV glass emissiveMap;
//     dockCamExpose(EXP, meanLog2Luminance of the last frame, dt) → EXP.gain multiplies the HDR → display mapping;
//     dockCamNoiseSigma(signal01) / dockCamSeed(tick) feed the noise shader; VIEW.sunBloomPx sizes the bloom streak.
// - The docking page may draw an overlay from VIEW (port reticle at u, v; offX/offY; tilt; roll).
// - Reads Craft rel/q/w/ports/colliders and the star's Body r (all read-only). Writes only its outputs and the
//   exposure state, which is a per-viewer render state: NOT saved (it re-converges in ~1.5 s after a load).
// - Cost: dockCamView ≈ 1 µs in node (one line-of-sight test against the station compound).

import type { Quat, V3 } from '../core/types';
import type { Body, Craft, World } from './state';
import { sensorMounts } from '../data/sensorMounts';
import { qRot } from './math';
import { lineOfSight, VIS_OK } from './sensors';

const msqrt = (x: number): number => Math.sqrt(x);
const mtan = (x: number): number => Math.tan(x);
const matan = (x: number): number => Math.atan(x);
const matan2 = (y: number, x: number): number => Math.atan2(y, x);
const mexp = (x: number): number => Math.exp(x);
const mlog2 = (x: number): number => Math.log2(x);
const mcbrt = (x: number): number => Math.cbrt(x);

const DEG = Math.PI / 180;
export const DOCKCAM_W = 256;
export const DOCKCAM_H = 192;
export const DOCKCAM_HFOV = 60 * DEG;
/** Focal length in pixels and the vertical FOV (rad; three.js wants degrees: DOCKCAM_VFOV / DEG). */
export const DOCKCAM_F = DOCKCAM_W / 2 / mtan(DOCKCAM_HFOV / 2);
export const DOCKCAM_VFOV = 2 * matan(DOCKCAM_H / 2 / DOCKCAM_F);
export const DOCKCAM_TICKS = 12;
export const DOCKCAM_RANGE = 2000;
/** The docking target ring's radius on the port, m (the soft-capture ring, capture.ts RING_RADIUS). */
export const PORT_RING_RADIUS = 0.8;
/** Auto-exposure time constant (s), mid-grey target, exposure gain limits (log2). */
export const EXPOSURE_TAU = 0.5;
export const EXPOSURE_GREY = 0.18;
export const EXPOSURE_LOG2_MIN = -24;
export const EXPOSURE_LOG2_MAX = 8;
/** Sensor: full-well capacity and read noise, electrons. */
export const FULL_WELL = 12000;
export const READ_NOISE = 6;

/** Is the camera worth rendering now (§1.2.2 gate)? */
export function dockCamActive(pageShown: boolean, rangeToStation: number): boolean {
  return pageShown && rangeToStation < DOCKCAM_RANGE;
}
/** Is `tick` a camera frame? (10 Hz on the tick grid) */
export const dockCamDue = (tick: number): boolean => tick % DOCKCAM_TICKS === 0;

export interface DockCamView {
  /** Camera position relative to the ship origin (inertial axes, m) and its attitude (camera-local → world). */
  camPos: V3;
  camQ: Quat;
  /** The port centre: in front of the camera, inside the frame, and not hidden by structure. */
  portInFront: boolean;
  portInFrame: boolean;
  portOccluded: boolean;
  /** Pixel position of the port centre, its depth along the boresight (m) and the ring's apparent radius (px). */
  u: number;
  v: number;
  depth: number;
  ringPx: number;
  /** Lateral offset of the port centre from the boresight, camera right / up, m. */
  offX: number;
  offY: number;
  /** Angle between the reversed port axis and the boresight (rad) and its direction in the image (rad, from +u toward −v). */
  tilt: number;
  tiltDir: number;
  /** Roll of the port's up vector against the image up, rad. */
  roll: number;
  /** The station's bounding sphere: centre pixel, apparent radius (px), in front. */
  stU: number;
  stV: number;
  stPx: number;
  stInFront: boolean;
  /** The star: in the frame, pixel position, apparent radius (px), and the bloom radius at the current exposure (px). */
  sunInFrame: boolean;
  sunU: number;
  sunV: number;
  sunPx: number;
  sunBloomPx: number;
}

export function makeDockCamView(): DockCamView {
  return {
    camPos: { x: 0, y: 0, z: 0 }, camQ: { x: 0, y: 0, z: 0, w: 1 }, portInFront: false, portInFrame: false, portOccluded: false,
    u: 0, v: 0, depth: 0, ringPx: 0, offX: 0, offY: 0, tilt: 0, tiltDir: 0, roll: 0, stU: 0, stV: 0, stPx: 0, stInFront: false,
    sunInFrame: false, sunU: 0, sunV: 0, sunPx: 0, sunBloomPx: 0,
  };
}

const CR = { x: 0, y: 0, z: 0 }, CU = { x: 0, y: 0, z: 0 }, CB = { x: 0, y: 0, z: 0 };
const T0 = { x: 0, y: 0, z: 0 }, T1 = { x: 0, y: 0, z: 0 }, T2 = { x: 0, y: 0, z: 0 };

/** Unit quaternion of the rotation whose matrix has columns X, Y, Z (Shepperd). */
function quatFromBasis(X: V3, Y: V3, Z: V3, out: Quat): void {
  const m00 = X.x, m10 = X.y, m20 = X.z, m01 = Y.x, m11 = Y.y, m21 = Y.z, m02 = Z.x, m12 = Z.y, m22 = Z.z;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = 0.5 / msqrt(tr + 1);
    out.w = 0.25 / s; out.x = (m21 - m12) * s; out.y = (m02 - m20) * s; out.z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * msqrt(1 + m00 - m11 - m22);
    out.w = (m21 - m12) / s; out.x = 0.25 * s; out.y = (m01 + m10) / s; out.z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * msqrt(1 + m11 - m00 - m22);
    out.w = (m02 - m20) / s; out.x = (m01 + m10) / s; out.y = 0.25 * s; out.z = (m12 + m21) / s;
  } else {
    const s = 2 * msqrt(1 + m22 - m00 - m11);
    out.w = (m10 - m01) / s; out.x = (m02 + m20) / s; out.y = (m12 + m21) / s; out.z = 0.25 * s;
  }
  const l = msqrt(out.x * out.x + out.y * out.y + out.z * out.z + out.w * out.w);
  out.x /= l; out.y /= l; out.z /= l; out.w /= l;
}

/** Project a camera-relative inertial vector (x, y, z) onto the camera axes: _cx (right), _cy (up), _cd (depth). */
let _cx = 0, _cy = 0, _cd = 0;
function toCam(x: number, y: number, z: number): void {
  _cx = x * CR.x + y * CR.y + z * CR.z;
  _cy = x * CU.x + y * CU.y + z * CU.z;
  _cd = x * CB.x + y * CB.y + z * CB.z;
}

/**
 * What the docking camera of `ship` sees of `station`'s port `portIx` (−1: no port; only the station sphere) and of
 * the star `sun` (null: none). `exposureLog2` (dockCamExpose) sizes the star's bloom. Writes out; returns out.
 */
export function dockCamView(world: World, ship: Craft, station: Craft | null, portIx: number, sun: Body | null, out: DockCamView, exposureLog2 = 0): DockCamView {
  const M = sensorMounts(ship.shipVisual, ship.dockPort).camera;
  qRot(out.camPos, ship.q, M.pos.x, M.pos.y, M.pos.z);
  qRot(CB, ship.q, M.axis.x, M.axis.y, M.axis.z);
  qRot(CU, ship.q, M.up.x, M.up.y, M.up.z);
  // right = boresight × up (camera +X), re-orthogonalised up = right × boresight
  CR.x = CB.y * CU.z - CB.z * CU.y; CR.y = CB.z * CU.x - CB.x * CU.z; CR.z = CB.x * CU.y - CB.y * CU.x;
  const l = msqrt(CR.x * CR.x + CR.y * CR.y + CR.z * CR.z);
  CR.x /= l; CR.y /= l; CR.z /= l;
  CU.x = CR.y * CB.z - CR.z * CB.y; CU.y = CR.z * CB.x - CR.x * CB.z; CU.z = CR.x * CB.y - CR.y * CB.x;
  T0.x = -CB.x; T0.y = -CB.y; T0.z = -CB.z; // camera +Z = −boresight
  quatFromBasis(CR, CU, T0, out.camQ);
  const f = DOCKCAM_F, cu = DOCKCAM_W / 2, cv = DOCKCAM_H / 2;
  out.portInFront = out.portInFrame = out.portOccluded = false;
  out.stInFront = false;
  if (station !== null) {
    const same = station.primary === ship.primary;
    const sx = (same ? station.rel.x - ship.rel.x : station.r.x - ship.r.x) - out.camPos.x;
    const sy = (same ? station.rel.y - ship.rel.y : station.r.y - ship.r.y) - out.camPos.y;
    const sz = (same ? station.rel.z - ship.rel.z : station.r.z - ship.r.z) - out.camPos.z;
    toCam(sx, sy, sz);
    out.stInFront = _cd > 0;
    if (_cd > 0) { out.stU = cu + (f * _cx) / _cd; out.stV = cv - (f * _cy) / _cd; out.stPx = (f * station.radius) / _cd; }
    if (portIx >= 0 && portIx < station.ports.length) {
      const p = station.ports[portIx];
      qRot(T0, station.q, p.pos.x, p.pos.y, p.pos.z);
      qRot(T1, station.q, p.dir.x, p.dir.y, p.dir.z);
      qRot(T2, station.q, p.up.x, p.up.y, p.up.z);
      const px = sx + T0.x, py = sy + T0.y, pz = sz + T0.z;
      toCam(px, py, pz);
      out.offX = _cx; out.offY = _cy; out.depth = _cd;
      out.portInFront = _cd > 0;
      if (_cd > 0) {
        out.u = cu + (f * _cx) / _cd; out.v = cv - (f * _cy) / _cd;
        out.ringPx = (f * PORT_RING_RADIUS) / msqrt(_cx * _cx + _cy * _cy + _cd * _cd);
        out.portInFrame = out.u >= 0 && out.u <= DOCKCAM_W && out.v >= 0 && out.v <= DOCKCAM_H;
      }
      // misalignment: the reversed port axis against the boresight
      toCam(-T1.x, -T1.y, -T1.z);
      out.tilt = matan2(msqrt(_cx * _cx + _cy * _cy), _cd);
      out.tiltDir = matan2(_cy, _cx);
      // roll: the port's up projected into the image plane, against image up
      toCam(T2.x, T2.y, T2.z);
      out.roll = matan2(-_cx, _cy);
      if (out.portInFront) {
        const ox = out.camPos.x, oy = out.camPos.y, oz = out.camPos.z;
        out.portOccluded = lineOfSight(world, ship, station, true, ox, oy, oz, ox + px, oy + py, oz + pz) !== VIS_OK;
      }
    }
  }
  out.sunInFrame = false;
  out.sunBloomPx = 0;
  if (sun !== null) {
    const bp = world.bodies[ship.primary];
    const dx = sun.r.x - bp.r.x - ship.rel.x, dy = sun.r.y - bp.r.y - ship.rel.y, dz = sun.r.z - bp.r.z - ship.rel.z;
    toCam(dx, dy, dz);
    if (_cd > 0) {
      out.sunU = cu + (f * _cx) / _cd; out.sunV = cv - (f * _cy) / _cd;
      const dist = msqrt(dx * dx + dy * dy + dz * dz);
      out.sunPx = (f * sun.radius) / dist;
      const m = out.sunPx + 0.5;
      out.sunInFrame = out.sunU > -m && out.sunU < DOCKCAM_W + m && out.sunV > -m && out.sunV < DOCKCAM_H + m;
      if (out.sunInFrame) out.sunBloomPx = sunBloom(out.sunPx, exposureLog2);
    }
  }
  return out;
}

/**
 * Bloom radius (px) of the star's disc: charge spills while the PSF-spread signal exceeds the full well. The disc's
 * surface brightness at gain 2^e is ≈ SUN_SIGNAL·2^e full wells; a PSF wing falling as (r0/r)³ stays above one full
 * well out to r0·(over)^(1/3).
 */
/** Star disc signal at gain 1 in full wells (est., tuned with the render step's HDR scale). */
export const SUN_SIGNAL = 4e6;
export function sunBloom(sunPx: number, exposureLog2: number): number {
  const over = SUN_SIGNAL * 2 ** exposureLog2;
  const r0 = sunPx > 0.5 ? sunPx : 0.5;
  return over > 1 ? r0 * mcbrt(over) : 0;
}

// ------------------------------------------------------------------------------------------------ exposure, noise

export interface DockCamExposure {
  /** log2 of the gain applied to scene luminance. */
  log2Gain: number;
  valid: boolean;
}
export const makeDockCamExposure = (): DockCamExposure => ({ log2Gain: 0, valid: false });

/**
 * Auto-exposure: the gain relaxes toward the one that puts the frame's mean log2 luminance at mid-grey with τ, exact
 * for a span of any length at a constant scene (log gain is a first-order lag). Returns the gain (linear).
 */
export function dockCamExpose(e: DockCamExposure, meanLog2Luminance: number, dt: number): number {
  let target = mlog2(EXPOSURE_GREY) - meanLog2Luminance;
  if (target < EXPOSURE_LOG2_MIN) target = EXPOSURE_LOG2_MIN; else if (target > EXPOSURE_LOG2_MAX) target = EXPOSURE_LOG2_MAX;
  if (!e.valid) { e.log2Gain = target; e.valid = true; }
  else if (dt > 0) e.log2Gain = target + (e.log2Gain - target) * mexp(-dt / EXPOSURE_TAU);
  return 2 ** e.log2Gain;
}

/** 1σ pixel noise for an exposed signal s (0..1 of full well): √(shot + read²) / full well. */
export function dockCamNoiseSigma(s: number): number {
  const e = (s > 0 ? s : 0) * FULL_WELL;
  return msqrt(e + READ_NOISE * READ_NOISE) / FULL_WELL;
}

/** A 32-bit noise seed for camera frame `tick` (deterministic; the shader hashes pixel coordinates with it). */
export function dockCamSeed(tick: number): number {
  let h = (tick % 4294967296) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
  return h >>> 0;
}
