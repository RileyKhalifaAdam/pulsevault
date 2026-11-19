// Camera rig: turns a FrameCamera request into a camera pose relative to its focus.
//
// Pure maths on plain V3 / Quat (doubles; no three.js) so the scene manager can add the pose to the focus's
// absolute position in double precision before anything is cast to float. Nothing here allocates per frame.
//
//   chase    behind and above the ship in a frame that follows the ship's attitude with a spring lag, so a
//            turn is first seen as the hull turning and then the view swinging after it; it also drops back a
//            little under thrust. yaw / pitch orbit the camera about the ship; distance zooms.
//   orbit    the same orbit in a steady north-up frame (inspect a ship, a station or a world).
//   cockpit  the pilot's eye point; yaw / pitch look around.
//   dock     astern of the ship along the assigned port's approach axis, port "up" on screen.
//   flyby    a drifting external camera that the ship passes.
//   lookAt   chase / orbit only: the frame's forward axis points at the target, so the ship sits in the
//            foreground with the target beyond it.
//
// Changes of mode or focus blend over BLEND_TIME from wherever the camera is; `cut()` snaps instead.
// The vertical field of view widens as the viewport gets narrower, so portrait is not tunnel vision.
// The rig keeps third-person cameras outside the focus's bounding sphere; everything else that is solid
// (stations, worlds) is handled by the `collide` callback the scene manager supplies.

import type { Quat, V3 } from '../core/types';
import type { CameraMode, FrameCamera } from './frame';

const DEG = Math.PI / 180;
const BLEND_TIME = 0.9;
const ATTITUDE_TAU = 0.26;
const THRUST_TAU = 0.55;
const ZOOM_TAU = 0.12;
const MAX_ELEVATION = 80 * DEG;

export interface CameraPose {
  /** Camera position relative to the focus centre, world axes, m. */
  offset: V3;
  /** Camera-local (looks down -Z, +Y up, +X right) -> world. */
  q: Quat;
  /** Vertical field of view, rad. */
  fovY: number;
  /** The focus hull must not be drawn (cockpit view). */
  hideFocus: boolean;
  /** The mode actually in effect (requests fall back: dock without a port -> chase, ship modes on a station -> orbit). */
  mode: CameraMode;
}

export interface CameraFocus {
  /** Changes when the camera should treat this as a different object. */
  id: string;
  kind: 'ship' | 'station' | 'body';
  /** Bounding radius, m. */
  radius: number;
  /** Attitude, local -> world (identity for bodies). */
  q: Quat;
  /** Default third-person framing for ships: distance behind and height above the centre, m. */
  chaseDistance: number;
  chaseHeight: number;
  /** Pilot eye point, ship-local m. */
  cockpit: V3;
  /** 0..1, makes the chase camera sag back under thrust. */
  throttle: number;
}

export interface CameraEnv {
  /** Viewport width / height. */
  aspect: number;
  /** Docking port for 'dock': mating point relative to the focus centre, outward axis and up (world axes). */
  dock: { pos: V3; dir: V3; up: V3 } | null;
  /** Position of the lookAt target relative to the focus centre, world axes, or null. */
  lookAt: V3 | null;
  /** Unit "up" of the steady frames (orbit, flyby), world axes — system north unless the scene knows better. */
  up: V3;
  /** Move a camera position (relative to the focus centre, world axes) out of anything solid, in place. */
  collide: ((offset: V3) => void) | null;
}

export interface CameraRig {
  /** Advance the rig by `dt` real seconds and return the pose (the same object every call). */
  update(dt: number, req: FrameCamera, focus: CameraFocus, env: CameraEnv): CameraPose;
  /** Snap to the requested pose on the next update (new system, teleport, respawn). */
  cut(): void;
  /** The focus origin moved by `delta` (world axes, m) for reasons other than motion — keeps a blend continuous. */
  rebase(delta: V3): void;
  readonly pose: CameraPose;
}

/** Vertical field of view for a viewport aspect: 46 degrees in landscape widening to 66 in tall portrait. */
export function fovForAspect(aspect: number): number {
  const t = Math.min(1, Math.max(0, (aspect - 0.62) / (1.3 - 0.62)));
  const s = t * t * (3 - 2 * t);
  return (66 - 20 * s) * DEG;
}

// ------------------------------------------------------------------------------------------------ maths

function qMulTo(out: Quat, a: Quat, b: Quat): Quat {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}

function qRotTo(out: V3, q: Quat, v: V3): V3 {
  const { x, y, z } = v;
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  out.x = x + q.w * tx + (q.y * tz - q.z * ty);
  out.y = y + q.w * ty + (q.z * tx - q.x * tz);
  out.z = z + q.w * tz + (q.x * ty - q.y * tx);
  return out;
}

function qCopy(out: Quat, a: Quat): Quat {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  out.w = a.w;
  return out;
}

function qNormTo(q: Quat): Quat {
  const l = Math.hypot(q.x, q.y, q.z, q.w);
  if (l < 1e-12) {
    q.x = q.y = q.z = 0;
    q.w = 1;
  } else {
    q.x /= l;
    q.y /= l;
    q.z /= l;
    q.w /= l;
  }
  return q;
}

function qSlerpTo(out: Quat, a: Quat, b: Quat, t: number): Quat {
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  let c = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (c < 0) {
    c = -c;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let s0 = 1 - t;
  let s1 = t;
  if (c < 0.9995) {
    const th = Math.acos(c);
    const sn = Math.sin(th);
    s0 = Math.sin((1 - t) * th) / sn;
    s1 = Math.sin(t * th) / sn;
  }
  out.x = a.x * s0 + bx * s1;
  out.y = a.y * s0 + by * s1;
  out.z = a.z * s0 + bz * s1;
  out.w = a.w * s0 + bw * s1;
  return qNormTo(out);
}

const _lx: V3 = { x: 0, y: 0, z: 0 };
const _ly: V3 = { x: 0, y: 0, z: 0 };
const _lz: V3 = { x: 0, y: 0, z: 0 };

/** Quaternion whose local -Z is `forward` and whose local +Y is as close to `up` as it can be. */
export function lookRotationTo(out: Quat, fx: number, fy: number, fz: number, up: V3): Quat {
  let l = Math.hypot(fx, fy, fz);
  if (l < 1e-12) {
    fx = 0;
    fy = 0;
    fz = -1;
    l = 1;
  }
  _lz.x = -fx / l;
  _lz.y = -fy / l;
  _lz.z = -fz / l;
  // x = up × z
  let xx = up.y * _lz.z - up.z * _lz.y;
  let xy = up.z * _lz.x - up.x * _lz.z;
  let xz = up.x * _lz.y - up.y * _lz.x;
  let xl = Math.hypot(xx, xy, xz);
  if (xl < 1e-6) {
    // forward parallel to up: any perpendicular will do
    const ax = Math.abs(_lz.x) < 0.9 ? 1 : 0;
    const ay = ax ? 0 : 1;
    xx = ay * _lz.z;
    xy = -ax * _lz.z;
    xz = ax * _lz.y - ay * _lz.x;
    xl = Math.hypot(xx, xy, xz);
  }
  _lx.x = xx / xl;
  _lx.y = xy / xl;
  _lx.z = xz / xl;
  // y = z × x
  _ly.x = _lz.y * _lx.z - _lz.z * _lx.y;
  _ly.y = _lz.z * _lx.x - _lz.x * _lx.z;
  _ly.z = _lz.x * _lx.y - _lz.y * _lx.x;
  const m00 = _lx.x;
  const m10 = _lx.y;
  const m20 = _lx.z;
  const m01 = _ly.x;
  const m11 = _ly.y;
  const m21 = _ly.z;
  const m02 = _lz.x;
  const m12 = _lz.y;
  const m22 = _lz.z;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    out.w = 0.25 / s;
    out.x = (m21 - m12) * s;
    out.y = (m02 - m20) * s;
    out.z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    out.w = (m21 - m12) / s;
    out.x = 0.25 * s;
    out.y = (m01 + m10) / s;
    out.z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    out.w = (m02 - m20) / s;
    out.x = (m01 + m10) / s;
    out.y = 0.25 * s;
    out.z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    out.w = (m10 - m01) / s;
    out.x = (m02 + m20) / s;
    out.y = (m12 + m21) / s;
    out.z = 0.25 * s;
  }
  return qNormTo(out);
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const Y_UP: V3 = { x: 0, y: 1, z: 0 };

// ------------------------------------------------------------------------------------------------ rig

/** Vertical field of view of the first-person interior view: 60 degrees in landscape, 88 in tall portrait. */
export function interiorFov(aspect: number): number {
  return clamp(2 * Math.atan(1.11 / Math.max(aspect, 0.1)), 60 * DEG, 88 * DEG);
}

export function createCameraRig(): CameraRig {
  const pose: CameraPose = { offset: { x: 0, y: 0, z: 40 }, q: { x: 0, y: 0, z: 0, w: 1 }, fovY: 50 * DEG, hideFocus: false, mode: 'chase' };
  const tOff: V3 = { x: 0, y: 0, z: 0 };
  const tQ: Quat = { x: 0, y: 0, z: 0, w: 1 };
  const fromOff: V3 = { x: 0, y: 0, z: 0 };
  const fromQ: Quat = { x: 0, y: 0, z: 0, w: 1 };
  const frameQ: Quat = { x: 0, y: 0, z: 0, w: 1 }; // lagged frame of the third-person modes
  const wantQ: Quat = { x: 0, y: 0, z: 0, w: 1 };
  const localQ: Quat = { x: 0, y: 0, z: 0, w: 1 };
  const p: V3 = { x: 0, y: 0, z: 0 };
  const tmp: V3 = { x: 0, y: 0, z: 0 };
  const upW: V3 = { x: 0, y: 1, z: 0 };
  const flyOff: V3 = { x: 0, y: 0, z: 0 };
  const flyVel: V3 = { x: 0, y: 0, z: 0 };
  let flyAge = 1e9;
  let flySide = 1;
  let blend = 1;
  let snap = true;
  let lastMode: CameraMode | '' = '';
  let lastFocus = '';
  let lastLook = false;
  let lag = 0;
  let zoom = 1;
  let fov = 0;

  /** Orbit position in a frame: azimuth 0 = astern (+Z), positive to starboard; elevation up. */
  const orbitPoint = (r: number, az: number, el: number): void => {
    const ce = Math.cos(el);
    p.x = r * Math.sin(az) * ce;
    p.y = r * Math.sin(el);
    p.z = r * Math.cos(az) * ce;
  };

  /** Third-person pose: camera at `p` (frame-local) looking at (0, lift, -ahead) with the frame's up. */
  const thirdPerson = (frame: Quat, lift: number, ahead: number): void => {
    lookRotationTo(localQ, -p.x, lift - p.y, -ahead - p.z, Y_UP);
    qMulTo(tQ, frame, localQ);
    qRotTo(tOff, frame, p);
  };

  const update = (dtIn: number, req: FrameCamera, focus: CameraFocus, env: CameraEnv): CameraPose => {
    const dt = clamp(Number.isFinite(dtIn) ? dtIn : 0, 0, 0.25);
    const aspect = env.aspect > 0 ? env.aspect : 1;
    const portrait = clamp((1.1 - aspect) / 0.6, 0, 1);
    const yaw = Number.isFinite(req.yaw) ? req.yaw : 0;
    const pitch = Number.isFinite(req.pitch) ? req.pitch : 0;
    const zoomWant = clamp(Number.isFinite(req.distance) && req.distance > 0 ? req.distance : 1, 0.3, 60);

    let mode: CameraMode = req.mode;
    if (focus.kind !== 'ship') mode = 'orbit';
    else if (mode === 'dock' && !env.dock) mode = 'chase';
    const look = (mode === 'chase' || mode === 'orbit') && env.lookAt !== null && Math.hypot(env.lookAt.x, env.lookAt.y, env.lookAt.z) > focus.radius * 2;

    const changed = mode !== lastMode || focus.id !== lastFocus || look !== lastLook;
    const first = snap || lastMode === '';
    if (first) zoom = zoomWant;
    else zoom += (zoomWant - zoom) * (1 - Math.exp(-dt / ZOOM_TAU));
    lag += (clamp(focus.throttle, 0, 1) - lag) * (1 - Math.exp(-dt / THRUST_TAU));
    if (first) lag = clamp(focus.throttle, 0, 1);

    const up = env.up;
    const ul = Math.hypot(up.x, up.y, up.z);
    if (ul > 1e-6) {
      upW.x = up.x / ul;
      upW.y = up.y / ul;
      upW.z = up.z / ul;
    } else {
      upW.x = 0;
      upW.y = 1;
      upW.z = 0;
    }

    const ship = focus.kind === 'ship';
    const r0 = ship ? Math.hypot(focus.chaseDistance, focus.chaseHeight) : focus.radius * 3.2;
    const e0 = ship ? Math.atan2(focus.chaseHeight, focus.chaseDistance) : 0.3;
    const rMin = focus.radius * (ship ? 1.35 : 1.12) + 0.5;
    let hide = false;
    let fovScale = 1;
    let fovAdd = 0;

    if (mode === 'interior') {
      // first person inside the hull: rigid to the ship (no lag, no blend), eye and look angles from the frame
      const hy = (Number.isFinite(req.lookYaw) ? req.lookYaw : 0) * 0.5;
      const hp = clamp(Number.isFinite(req.lookPitch) ? req.lookPitch : 0, -1.55, 1.55) * 0.5;
      localQ.x = 0;
      localQ.y = Math.sin(hy);
      localQ.z = 0;
      localQ.w = Math.cos(hy);
      wantQ.x = Math.sin(hp);
      wantQ.y = 0;
      wantQ.z = 0;
      wantQ.w = Math.cos(hp);
      qMulTo(localQ, localQ, wantQ);
      qMulTo(tQ, focus.q, localQ);
      tmp.x = req.eye ? req.eye.x : 0;
      tmp.y = req.eye ? req.eye.y : 0;
      tmp.z = req.eye ? req.eye.z : 0;
      qRotTo(tOff, focus.q, tmp);
      hide = true;
      qCopy(frameQ, focus.q);
    } else if (mode === 'cockpit') {
      // look-around: yaw about ship up, then pitch about the turned right axis
      const hy = clamp(yaw, -2.2, 2.2) * 0.5;
      const hp = clamp(-pitch, -1.1, 1.1) * 0.5;
      localQ.x = 0;
      localQ.y = Math.sin(hy);
      localQ.z = 0;
      localQ.w = Math.cos(hy);
      wantQ.x = Math.sin(hp);
      wantQ.y = 0;
      wantQ.z = 0;
      wantQ.w = Math.cos(hp);
      qMulTo(localQ, localQ, wantQ);
      qMulTo(tQ, focus.q, localQ);
      qRotTo(tOff, focus.q, focus.cockpit);
      hide = true;
      fovAdd = 6 * DEG;
      qCopy(frameQ, focus.q);
    } else if (mode === 'flyby') {
      flyAge += dt;
      const far = Math.hypot(flyOff.x, flyOff.y, flyOff.z);
      if (first || changed || flyAge > 16 || far > r0 * 9) {
        // new set-up: ahead of the ship and off to one side, drifting aft so the ship passes close by
        flySide = -flySide;
        p.x = flySide * r0 * 1.5;
        p.y = r0 * 0.35;
        p.z = -r0 * 4.2;
        qRotTo(flyOff, focus.q, p);
        p.x = 0;
        p.y = 0;
        p.z = r0 * 0.6;
        qRotTo(flyVel, focus.q, p);
        flyAge = 0;
        if (!first && !changed) blend = 1; // a cut between set-ups, not a swoop
      }
      flyOff.x += flyVel.x * dt;
      flyOff.y += flyVel.y * dt;
      flyOff.z += flyVel.z * dt;
      const d = Math.hypot(flyOff.x, flyOff.y, flyOff.z);
      if (d < rMin) {
        const k = rMin / Math.max(d, 1e-3);
        flyOff.x *= k;
        flyOff.y *= k;
        flyOff.z *= k;
      }
      tOff.x = flyOff.x;
      tOff.y = flyOff.y;
      tOff.z = flyOff.z;
      lookRotationTo(tQ, -flyOff.x, -flyOff.y, -flyOff.z, upW);
      fovScale = 0.72;
      qCopy(frameQ, focus.q);
    } else {
      // ---- third person: pick the frame, then orbit in it
      let el: number;
      let r: number;
      let lift: number;
      let ahead: number;
      let tau = 0;
      if (mode === 'dock' && env.dock) {
        const d = env.dock;
        lookRotationTo(wantQ, -d.dir.x, -d.dir.y, -d.dir.z, d.up);
        tau = 0.35;
        el = e0 + 0.06 + pitch;
        r = Math.max(r0 * 1.1 * zoom, rMin);
        lift = r * (0.07 + 0.05 * portrait);
        ahead = r * 0.55;
      } else if (look && env.lookAt) {
        // forward toward the target; up from the ship (chase) or north (orbit)
        if (mode === 'chase') {
          tmp.x = 0;
          tmp.y = 1;
          tmp.z = 0;
          qRotTo(tmp, focus.q, tmp);
        } else {
          tmp.x = upW.x;
          tmp.y = upW.y;
          tmp.z = upW.z;
        }
        lookRotationTo(wantQ, env.lookAt.x, env.lookAt.y, env.lookAt.z, tmp);
        tau = 0.4;
        el = e0 + 0.04 + pitch;
        r = Math.max(r0 * zoom, rMin);
        lift = r * (0.08 + 0.06 * portrait);
        ahead = r * 0.6;
      } else if (mode === 'chase') {
        qCopy(wantQ, focus.q);
        tau = ATTITUDE_TAU;
        el = e0 + pitch;
        r = Math.max(r0 * zoom * (1 + 0.1 * lag), rMin);
        lift = r * (0.1 + 0.07 * portrait);
        ahead = r * 0.18;
      } else {
        // orbit: north-up, absolute angles
        if (upW.y > 0.9999) {
          wantQ.x = wantQ.y = wantQ.z = 0;
          wantQ.w = 1;
        } else lookRotationTo(wantQ, 0, 0, -1, upW);
        el = ship ? e0 + pitch : pitch;
        r = Math.max(r0 * zoom, rMin);
        lift = 0;
        ahead = 0;
      }
      if (first || changed || tau <= 0) qCopy(frameQ, wantQ);
      else qSlerpTo(frameQ, frameQ, wantQ, 1 - Math.exp(-dt / tau));
      orbitPoint(r, yaw, clamp(el, -MAX_ELEVATION, MAX_ELEVATION));
      thirdPerson(frameQ, lift, ahead);
    }

    // ---- transitions
    if (first) {
      blend = 1;
      snap = false;
    } else if (changed) {
      fromOff.x = pose.offset.x;
      fromOff.y = pose.offset.y;
      fromOff.z = pose.offset.z;
      qCopy(fromQ, pose.q);
      const jump = Math.hypot(tOff.x - fromOff.x, tOff.y - fromOff.y, tOff.z - fromOff.z);
      // very long moves (a station kilometres away) cut rather than swoop
      blend = jump > Math.max(4000, r0 * 60) ? 1 : 0;
    }
    if (changed && (mode === 'interior' || lastMode === 'interior')) blend = 1; // in and out of the hull is a cut
    lastMode = mode;
    lastFocus = focus.id;
    lastLook = look;

    if (blend < 1) {
      blend = Math.min(1, blend + dt / BLEND_TIME);
      const s = blend * blend * (3 - 2 * blend);
      pose.offset.x = fromOff.x + (tOff.x - fromOff.x) * s;
      pose.offset.y = fromOff.y + (tOff.y - fromOff.y) * s;
      pose.offset.z = fromOff.z + (tOff.z - fromOff.z) * s;
      qSlerpTo(pose.q, fromQ, tQ, s);
      // do not swing through the hull on the way
      if (!hide) {
        const d = Math.hypot(pose.offset.x, pose.offset.y, pose.offset.z);
        if (d < rMin && s > 0.15) {
          const k = rMin / Math.max(d, 1e-3);
          pose.offset.x *= k;
          pose.offset.y *= k;
          pose.offset.z *= k;
        }
      }
    } else {
      pose.offset.x = tOff.x;
      pose.offset.y = tOff.y;
      pose.offset.z = tOff.z;
      qCopy(pose.q, tQ);
    }
    if (env.collide && !hide) env.collide(pose.offset);

    // leaning in (pinch) narrows the interior view: frame.camera.zoom scales the picture, 1..3
    const lean = clamp(typeof req.zoom === 'number' && Number.isFinite(req.zoom) ? req.zoom : 1, 1, 3);
    const fovWant = mode === 'interior' ? 2 * Math.atan(Math.tan(interiorFov(aspect) / 2) / lean) : clamp(fovForAspect(aspect) * fovScale + fovAdd, 20 * DEG, 85 * DEG);
    if (first || fov === 0 || mode === 'interior') fov = fovWant;
    else fov += (fovWant - fov) * (1 - Math.exp(-dt / 0.3));
    pose.fovY = fov;
    pose.hideFocus = hide && blend >= 0.6;
    pose.mode = mode;
    return pose;
  };

  return {
    pose,
    update,
    cut(): void {
      snap = true;
    },
    rebase(delta: V3): void {
      pose.offset.x -= delta.x;
      pose.offset.y -= delta.y;
      pose.offset.z -= delta.z;
      fromOff.x -= delta.x;
      fromOff.y -= delta.y;
      fromOff.z -= delta.z;
    },
  };
}
