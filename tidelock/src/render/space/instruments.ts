// The Wren's two console screens: what they show, as plain view objects, and how they are drawn (2D canvas,
// thin-line instrument style on near-black). The cockpit visual (cockpit.ts) owns the canvases and redraws
// them a few times a second; readInstruments() fills the view objects from a Session.
//
//   FLIGHT  primary and situation, altitude, speed, vertical speed, apsides with time to each, propellant and
//           delta-v, drive state, hold mode, felt acceleration, spin, and an attitude disc
//   NAV     pages 'orbit' (predicted path around the primary), 'docking' (range, closing speed, cross-pointer,
//           LATCH READY), 'systems' (propellant, hull, heat, cabin lights, date and time, time acceleration)
import type { CockpitLayout } from '../../data/cockpit';
import type { DeviceView, Session } from '../../game/api';

export const SCREEN_W = 512;
export const SCREEN_H = 340;

export type AttitudeMarkerKind = 'prograde' | 'retrograde' | 'normal' | 'antinormal' | 'radialOut' | 'radialIn' | 'target';
/** A direction in the ship's own axes (forward -Z, up +Y, starboard +X), unit length. */
export interface AttitudeMarker {
  kind: AttitudeMarkerKind;
  x: number;
  y: number;
  z: number;
}

export interface FlightScreenView {
  primaryName: string;
  situation: string;
  altitude: number;
  speed: number;
  verticalSpeed: number;
  apoapsisAlt: number;
  periapsisAlt: number;
  timeToApoapsis: number;
  timeToPeriapsis: number;
  propellantFraction: number;
  deltaV: number;
  armed: boolean;
  /** Main-drive throttle actually applied, 0..1. */
  throttle: number;
  /** Hold mode as shown: OFF, HOLD, PROGRADE… */
  hold: string;
  /** Proper acceleration felt on board, in g. */
  accelG: number;
  /** Spin rate, rad/s. */
  spin: number;
  /** Flight Assist as shown: OFF, ON or NO REF; the reference's name; speed relative to it and the commanded speed, m/s. */
  assist: 'OFF' | 'ON' | 'NO REF';
  assistRef: string;
  assistSpeed: number;
  assistCmd: number;
  markers: AttitudeMarker[];
}

export interface OrbitPageView {
  bodyName: string;
  /** Body radius and everything below in metres, in the orbit plane (x toward the ship now, y along its motion). */
  bodyRadius: number;
  path: Float32Array;
  pathCount: number;
  targetPath: Float32Array;
  /** Out-of-plane offset of each target-path point (along the orbit normal), m: the hologram lifts it in 3D. */
  targetPathZ: Float32Array;
  targetCount: number;
  shipX: number;
  shipY: number;
  hasApo: boolean;
  apoX: number;
  apoY: number;
  hasPeri: boolean;
  periX: number;
  periY: number;
  hasTarget: boolean;
  targetX: number;
  targetY: number;
  /** The target's out-of-plane offset, m. */
  targetZ: number;
  targetName: string;
  apoapsisAlt: number;
  periapsisAlt: number;
  period: number;
  /** @internal PredictionView.version the path was projected from. */
  version: number;
}

export interface DockingPageView {
  name: string;
  hasPort: boolean;
  range: number;
  closing: number;
  /** Port mating point off the ship's collar, across the port axis, in the ship's own right / up, m. */
  lateralX: number;
  lateralY: number;
  lateral: number;
  /** Angle between collar and port axes, rad. */
  alignment: number;
  canLatch: boolean;
  docked: boolean;
}

export interface SystemsPageView {
  propellantFraction: number;
  propellantKg: number;
  hull: number;
  heat: number;
  cabinLights: boolean;
  /** Sim time, s. */
  time: number;
  asleep: boolean;
  /** Time acceleration achieved, and what limits it ('' = nothing). */
  warp: number;
  warpLimit: string;
}

export interface InstrumentData {
  flight: FlightScreenView;
  orbit: OrbitPageView;
  docking: DockingPageView;
  systems: SystemsPageView;
}

const PATH_MAX = 240;

export function createInstrumentData(): InstrumentData {
  return {
    flight: {
      primaryName: '', situation: 'orbit', altitude: 0, speed: 0, verticalSpeed: 0, apoapsisAlt: 0, periapsisAlt: 0,
      timeToApoapsis: 0, timeToPeriapsis: 0, propellantFraction: 1, deltaV: 0, armed: false, throttle: 0, hold: 'OFF',
      accelG: 0, spin: 0, assist: 'OFF', assistRef: '', assistSpeed: 0, assistCmd: 0, markers: [],
    },
    orbit: {
      bodyName: '', bodyRadius: 1, path: new Float32Array(PATH_MAX * 2), pathCount: 0, targetPath: new Float32Array(PATH_MAX * 2),
      targetPathZ: new Float32Array(PATH_MAX), targetCount: 0, shipX: 0, shipY: 0, hasApo: false, apoX: 0, apoY: 0, hasPeri: false, periX: 0, periY: 0, hasTarget: false,
      targetX: 0, targetY: 0, targetZ: 0, targetName: '', apoapsisAlt: 0, periapsisAlt: 0, period: 0, version: -1,
    },
    docking: { name: '', hasPort: false, range: Infinity, closing: 0, lateralX: 0, lateralY: 0, lateral: 0, alignment: 0, canLatch: false, docked: false },
    systems: { propellantFraction: 1, propellantKg: 0, hull: 1, heat: 0, cabinLights: true, time: 0, asleep: false, warp: 1, warpLimit: '' },
  };
}

const HOLD_TEXT: Record<string, string> = {
  off: 'OFF', stability: 'HOLD', prograde: 'PROGRADE', retrograde: 'RETROGRADE', normal: 'NORMAL +', antinormal: 'NORMAL -',
  radialOut: 'RADIAL +', radialIn: 'RADIAL -', target: 'TARGET', antiTarget: 'ANTI-TGT', burn: 'BURN', dock: 'DOCK',
};

interface Q4 {
  x: number;
  y: number;
  z: number;
  w: number;
}
/** World direction -> ship-local (rotate by the conjugate of the ship's attitude). */
function toLocal(out: AttitudeMarker, q: Q4, x: number, y: number, z: number): boolean {
  const l = Math.hypot(x, y, z);
  if (!(l > 1e-12) || !Number.isFinite(l)) return false;
  const vx = x / l;
  const vy = y / l;
  const vz = z / l;
  const qx = -q.x;
  const qy = -q.y;
  const qz = -q.z;
  const qw = q.w;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out.x = vx + qw * tx + (qy * tz - qz * ty);
  out.y = vy + qw * ty + (qz * tx - qx * tz);
  out.z = vz + qw * tz + (qx * ty - qy * tx);
  return true;
}

const tmpM: AttitudeMarker = { kind: 'target', x: 0, y: 0, z: -1 };

/**
 * Fill the screens' view objects from the session (cheap; call it a few times a second or every frame).
 * `devices` (Session.devices()) and `layout` give the drive arming switch; without them the drive shows as
 * armed whenever it is burning.
 */
export function readInstruments(session: Session, out: InstrumentData, devices?: readonly DeviceView[] | null, layout?: CockpitLayout | null): InstrumentData {
  const f = session.flight();
  const p = session.player();
  const bodies = session.bodies();
  const craft = session.craft();
  let me = craft[0];
  for (let i = 0; i < craft.length; i++) if (craft[i].isPlayer) me = craft[i];
  let primary = bodies[0];
  for (let i = 0; i < bodies.length; i++) if (bodies[i].id === f.primaryId) primary = bodies[i];
  const tgt = session.target();

  // ---- FLIGHT
  const fl = out.flight;
  fl.primaryName = f.primaryName;
  fl.situation = f.situation;
  fl.altitude = f.altitude;
  fl.speed = f.speed;
  fl.verticalSpeed = f.verticalSpeed;
  fl.apoapsisAlt = f.apoapsisAlt;
  fl.periapsisAlt = f.periapsisAlt;
  fl.timeToApoapsis = f.timeToApoapsis;
  fl.timeToPeriapsis = f.timeToPeriapsis;
  fl.propellantFraction = p.propellantFraction;
  fl.deltaV = p.deltaV;
  fl.throttle = p.throttle;
  let armed = p.throttle > 0;
  if (devices && layout) {
    for (let i = 0; i < layout.devices.length && i < devices.length; i++) if (layout.devices[i].role === 'driveArm') armed = devices[i].x > 0.5;
  }
  fl.armed = armed;
  fl.hold = HOLD_TEXT[p.hold] ?? String(p.hold).toUpperCase();
  fl.accelG = f.accel / 9.80665;
  fl.spin = p.spin;
  fl.assist = p.assist === 'on' ? 'ON' : p.assist === 'noRef' ? 'NO REF' : 'OFF';
  fl.assistRef = p.assistRef;
  fl.assistSpeed = p.assistSpeed;
  fl.assistCmd = p.assistCmd;
  let n = 0;
  const mark = (kind: AttitudeMarkerKind, x: number, y: number, z: number): void => {
    if (!me || !toLocal(tmpM, me.q, x, y, z)) return;
    let m = fl.markers[n];
    if (!m) fl.markers[n] = m = { kind, x: 0, y: 0, z: -1 };
    m.kind = kind;
    m.x = tmpM.x;
    m.y = tmpM.y;
    m.z = tmpM.z;
    n++;
  };
  if (me && primary) {
    const rx = me.r.x - primary.r.x;
    const ry = me.r.y - primary.r.y;
    const rz = me.r.z - primary.r.z;
    const vx = me.v.x - primary.v.x;
    const vy = me.v.y - primary.v.y;
    const vz = me.v.z - primary.v.z;
    const nx = ry * vz - rz * vy;
    const ny = rz * vx - rx * vz;
    const nz = rx * vy - ry * vx;
    mark('prograde', vx, vy, vz);
    mark('retrograde', -vx, -vy, -vz);
    mark('normal', nx, ny, nz);
    mark('antinormal', -nx, -ny, -nz);
    mark('radialOut', rx, ry, rz);
    mark('radialIn', -rx, -ry, -rz);
  }
  if (tgt) mark('target', tgt.direction.x, tgt.direction.y, tgt.direction.z);
  fl.markers.length = n;

  // ---- NAV orbit: the predicted path laid flat in its own plane
  const o = out.orbit;
  const pr = session.prediction();
  let frameBody = primary;
  for (let i = 0; i < bodies.length; i++) if (bodies[i].id === pr.frameBodyId) frameBody = bodies[i];
  o.bodyName = frameBody ? frameBody.def.name : f.primaryName;
  o.bodyRadius = frameBody ? frameBody.def.radius : 1;
  o.apoapsisAlt = f.apoapsisAlt;
  o.periapsisAlt = f.periapsisAlt;
  o.period = f.period;
  o.targetName = tgt ? tgt.name : '';
  if (pr.version !== o.version || o.pathCount === 0) {
    o.version = pr.version;
    const P = pr.points;
    const cnt = pr.count;
    // plane basis: e1 toward the ship now, e3 the orbit normal, e2 along the motion
    let ax = me && frameBody ? me.r.x - frameBody.r.x : 1;
    let ay = me && frameBody ? me.r.y - frameBody.r.y : 0;
    let az = me && frameBody ? me.r.z - frameBody.r.z : 0;
    let bx = me && frameBody ? me.v.x - frameBody.v.x : 0;
    let by = me && frameBody ? me.v.y - frameBody.v.y : 1;
    let bz = me && frameBody ? me.v.z - frameBody.v.z : 0;
    if (cnt >= 2) {
      ax = P[0];
      ay = P[1];
      az = P[2];
      const k = Math.min(cnt - 1, Math.max(1, Math.floor(cnt / 16))) * 4;
      bx = P[k] - ax;
      by = P[k + 1] - ay;
      bz = P[k + 2] - az;
    }
    const al = Math.hypot(ax, ay, az) || 1;
    const e1x = ax / al;
    const e1y = ay / al;
    const e1z = az / al;
    let e3x = e1y * bz - e1z * by;
    let e3y = e1z * bx - e1x * bz;
    let e3z = e1x * by - e1y * bx;
    const nl = Math.hypot(e3x, e3y, e3z);
    if (nl > 1e-9) {
      e3x /= nl;
      e3y /= nl;
      e3z /= nl;
    } else {
      e3x = 0;
      e3y = 0;
      e3z = 1;
    }
    const e2x = e3y * e1z - e3z * e1y;
    const e2y = e3z * e1x - e3x * e1z;
    const e2z = e3x * e1y - e3y * e1x;
    const lay = (src: Float64Array, count: number, dst: Float32Array, dz?: Float32Array): number => {
      const step = Math.max(1, Math.ceil(count / PATH_MAX));
      let m = 0;
      for (let i = 0; i < count && m < PATH_MAX; i += step) {
        const x = src[i * 4];
        const y = src[i * 4 + 1];
        const z = src[i * 4 + 2];
        dst[m * 2] = x * e1x + y * e1y + z * e1z;
        dst[m * 2 + 1] = x * e2x + y * e2y + z * e2z;
        if (dz) dz[m] = x * e3x + y * e3y + z * e3z;
        m++;
      }
      return m;
    };
    o.pathCount = lay(P, cnt, o.path);
    o.targetCount = lay(pr.targetPoints, pr.targetCount, o.targetPath, o.targetPathZ);
    o.shipX = cnt >= 1 ? o.path[0] : al;
    o.shipY = cnt >= 1 ? o.path[1] : 0;
    o.hasApo = false;
    o.hasPeri = false;
    for (let i = 0; i < pr.events.length; i++) {
      const ev = pr.events[i];
      const x = ev.r.x * e1x + ev.r.y * e1y + ev.r.z * e1z;
      const y = ev.r.x * e2x + ev.r.y * e2y + ev.r.z * e2z;
      if (ev.kind === 'apoapsis' && !o.hasApo) {
        o.hasApo = true;
        o.apoX = x;
        o.apoY = y;
      } else if (ev.kind === 'periapsis' && !o.hasPeri) {
        o.hasPeri = true;
        o.periX = x;
        o.periY = y;
      }
    }
    o.hasTarget = false;
    if (o.targetCount > 0) {
      o.hasTarget = true;
      o.targetX = o.targetPath[0];
      o.targetY = o.targetPath[1];
      o.targetZ = o.targetPathZ[0];
    } else if (tgt && me && frameBody) {
      const tx = me.r.x - frameBody.r.x + tgt.direction.x * tgt.distance;
      const ty = me.r.y - frameBody.r.y + tgt.direction.y * tgt.distance;
      const tz = me.r.z - frameBody.r.z + tgt.direction.z * tgt.distance;
      o.hasTarget = true;
      o.targetX = tx * e1x + ty * e1y + tz * e1z;
      o.targetY = tx * e2x + ty * e2y + tz * e2z;
      o.targetZ = tx * e3x + ty * e3y + tz * e3z;
    }
  }

  // ---- NAV docking
  const dk = session.docking();
  const d = out.docking;
  d.docked = dk.dockedTo !== null;
  d.hasPort = dk.portId !== null;
  let name = '';
  const sid = dk.dockedTo ?? dk.stationId;
  if (sid) for (let i = 0; i < craft.length; i++) if (craft[i].id === sid) name = craft[i].name;
  d.name = name || (tgt ? tgt.name : '');
  d.range = d.hasPort ? dk.portDistance : dk.stationId ? dk.distance : tgt ? tgt.distance : Infinity;
  d.closing = d.hasPort ? dk.closing : tgt ? tgt.closing : 0;
  d.lateral = dk.lateral;
  d.alignment = dk.alignment;
  d.canLatch = dk.canLatch;
  d.lateralX = 0;
  d.lateralY = 0;
  if (d.hasPort && me) {
    // the mating point's offset across the port axis, in the ship's own axes; shown in the two ship axes
    // most across that axis (a dorsal collar reads right / forward, a nose collar right / up)
    const off = { kind: 'target' as const, x: 0, y: 0, z: 0 };
    const ax = { kind: 'target' as const, x: 0, y: 0, z: 0 };
    const ol = Math.hypot(dk.portOffset.x, dk.portOffset.y, dk.portOffset.z);
    if (toLocal(off, me.q, dk.portOffset.x, dk.portOffset.y, dk.portOffset.z) && toLocal(ax, me.q, dk.portAxis.x, dk.portAxis.y, dk.portAxis.z)) {
      const along = (off.x * ax.x + off.y * ax.y + off.z * ax.z) * ol;
      const lx = off.x * ol - ax.x * along;
      const ly = off.y * ol - ax.y * along;
      const lz = off.z * ol - ax.z * along;
      d.lateralX = lx;
      d.lateralY = Math.abs(ax.y) > Math.abs(ax.z) ? -lz : ly;
    }
  }

  // ---- NAV systems
  const s = out.systems;
  const w = session.warp();
  s.propellantFraction = p.propellantFraction;
  s.propellantKg = p.propellant;
  s.hull = p.hull;
  s.heat = p.heat;
  s.cabinLights = session.cabinLights();
  s.time = session.time();
  s.asleep = session.crew().asleep;
  s.warp = w.achieved;
  s.warpLimit = w.limitedBy;
  return out;
}

// ---- drawing -----------------------------------------------------------------------------------------------

const BG = '#010407';
const AMBER = '#ffb347';
const CYAN = '#4fe3ff';
const GREEN = '#58f0a8';
const RED = '#ff5246';
const DIM = '#5f97a6';
const WHITE = '#e9fbff';
const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';
type Ctx = CanvasRenderingContext2D;

const group = (s: string): string => s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
/** [value, unit] */
export function fmtDistance(m: number): [string, string] {
  if (!Number.isFinite(m)) return [m > 0 ? 'ESC' : '---', ''];
  const a = Math.abs(m);
  if (a < 1000) return [m.toFixed(a < 100 ? 1 : 0), 'm'];
  if (a < 1e5) return [(m / 1e3).toFixed(2), 'km'];
  if (a < 1e6) return [(m / 1e3).toFixed(1), 'km'];
  if (a < 1e8) return [group((m / 1e3).toFixed(0)), 'km'];
  if (a < 1e11) return [(m / 1e9).toFixed(a < 1e10 ? 3 : 2), 'Gm'];
  return [(m / 1.495978707e11).toFixed(3), 'AU'];
}
export function fmtSpeed(v: number): [string, string] {
  if (!Number.isFinite(v)) return ['---', ''];
  const a = Math.abs(v);
  if (a < 100) return [v.toFixed(a < 10 ? 2 : 1), 'm/s'];
  if (a < 10000) return [group(v.toFixed(0)), 'm/s'];
  return [(v / 1e3).toFixed(2), 'km/s'];
}
export function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '--:--';
  if (s < 3600) return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
  return `${Math.floor(s / 86400)}d${String(Math.floor((s % 86400) / 3600)).padStart(2, '0')}h`;
}

function text(c: Ctx, s: string, x: number, y: number, px: number, color: string, align: CanvasTextAlign = 'left', weight = 700): number {
  c.font = `${weight} ${px}px ${FONT}`;
  c.fillStyle = color;
  c.textAlign = align;
  c.fillText(s, x, y);
  return c.measureText(s).width;
}
function line(c: Ctx, x0: number, y0: number, x1: number, y1: number, color: string, w = 2): void {
  c.strokeStyle = color;
  c.lineWidth = w;
  c.beginPath();
  c.moveTo(x0, y0);
  c.lineTo(x1, y1);
  c.stroke();
}
/** Glass background: near-black with a faint cyan bloom from the top, a fine plotting grid and corner marks.
 * Draws in logical w x h units whatever the canvas resolution (the canvas may be 1.5x for crisp glass). */
const bgCache = new WeakMap<Ctx, { w: number; h: number; img: HTMLCanvasElement }>();
function background(c: Ctx, w: number, h: number): HTMLCanvasElement {
  const hit = bgCache.get(c);
  if (hit && hit.w === w && hit.h === h && hit.img.width === c.canvas.width) return hit.img;
  const img = document.createElement('canvas');
  img.width = c.canvas.width;
  img.height = c.canvas.height;
  const b = img.getContext('2d') as Ctx;
  b.scale(img.width / w, img.height / h);
  b.fillStyle = BG;
  b.fillRect(0, 0, w, h);
  const g = b.createRadialGradient(w * 0.5, -h * 0.25, 10, w * 0.5, -h * 0.25, h * 1.25);
  g.addColorStop(0, 'rgba(40,150,190,0.16)');
  g.addColorStop(1, 'rgba(40,150,190,0)');
  b.fillStyle = g;
  b.fillRect(0, 0, w, h);
  b.strokeStyle = 'rgba(79,227,255,0.055)';
  b.lineWidth = 1;
  b.beginPath();
  for (let x = 16; x < w; x += 16) {
    b.moveTo(x, 0);
    b.lineTo(x, h);
  }
  for (let y = 16; y < h; y += 16) {
    b.moveTo(0, y);
    b.lineTo(w, y);
  }
  b.stroke();
  b.strokeStyle = 'rgba(79,227,255,0.45)';
  b.lineWidth = 2;
  const k = 14;
  b.beginPath();
  for (const [x, y, sx, sy] of [[3, 3, 1, 1], [w - 3, 3, -1, 1], [3, h - 3, 1, -1], [w - 3, h - 3, -1, -1]]) {
    b.moveTo(x + sx * k, y);
    b.lineTo(x, y);
    b.lineTo(x, y + sy * k);
  }
  b.stroke();
  bgCache.set(c, { w, h, img });
  return img;
}
function clear(c: Ctx, w: number, h: number): void {
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.setLineDash([]);
  c.drawImage(background(c, w, h), 0, 0);
  c.setTransform(c.canvas.width / w, 0, 0, c.canvas.height / h, 0, 0);
  c.textBaseline = 'alphabetic';
  c.lineCap = 'round';
  c.lineJoin = 'round';
}
function bar(c: Ctx, x: number, y: number, w: number, h: number, frac: number, color: string): void {
  const f = Math.min(1, Math.max(0, Number.isFinite(frac) ? frac : 0));
  c.fillStyle = color;
  c.globalAlpha = 0.9;
  c.fillRect(x + 3, y + 3, (w - 6) * f, h - 6);
  c.globalAlpha = 1;
  c.strokeStyle = DIM;
  c.lineWidth = 2;
  c.strokeRect(x, y, w, h);
  for (let i = 1; i < 4; i++) line(c, x + (w * i) / 4, y + h - 6, x + (w * i) / 4, y + h, DIM, 2);
}

const SITUATION: Record<string, [string, string]> = {
  docked: ['DOCKED', GREEN], landed: ['LANDED', GREEN], orbit: ['ORBIT', CYAN], suborbital: ['SUBORBITAL', AMBER],
  escape: ['ESCAPE', AMBER], atmosphere: ['ATMOSPHERE', AMBER], destroyed: ['DESTROYED', RED],
};

function glyph(c: Ctx, kind: AttitudeMarkerKind, x: number, y: number): void {
  const r = 9;
  c.lineWidth = 2.5;
  c.beginPath();
  switch (kind) {
    case 'prograde':
    case 'retrograde':
      c.strokeStyle = GREEN;
      c.arc(x, y, r, 0, Math.PI * 2);
      if (kind === 'prograde') {
        c.moveTo(x - r, y);
        c.lineTo(x - r - 6, y);
        c.moveTo(x + r, y);
        c.lineTo(x + r + 6, y);
        c.moveTo(x, y - r);
        c.lineTo(x, y - r - 6);
      } else {
        c.moveTo(x - 6, y - 6);
        c.lineTo(x + 6, y + 6);
        c.moveTo(x + 6, y - 6);
        c.lineTo(x - 6, y + 6);
      }
      break;
    case 'normal':
    case 'antinormal': {
      const s = kind === 'normal' ? -1 : 1;
      c.strokeStyle = CYAN;
      c.moveTo(x, y + s * r);
      c.lineTo(x - r, y - s * r * 0.8);
      c.lineTo(x + r, y - s * r * 0.8);
      c.closePath();
      break;
    }
    case 'radialOut':
    case 'radialIn':
      c.strokeStyle = AMBER;
      c.rect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6);
      if (kind === 'radialIn') {
        c.moveTo(x - r * 0.8, y - r * 0.8);
        c.lineTo(x + r * 0.8, y + r * 0.8);
      } else {
        c.moveTo(x + 2, y);
        c.arc(x, y, 2, 0, Math.PI * 2);
      }
      break;
    default:
      c.strokeStyle = RED;
      c.moveTo(x, y - r - 3);
      c.lineTo(x + r + 3, y);
      c.lineTo(x, y + r + 3);
      c.lineTo(x - r - 3, y);
      c.closePath();
      c.moveTo(x + 2.5, y);
      c.arc(x, y, 2.5, 0, Math.PI * 2);
  }
  c.stroke();
}

/** The attitude disc: directions as seen from the nose. Centre = straight ahead, rim = dead astern. */
function attitudeDisc(c: Ctx, cx: number, cy: number, R: number, markers: readonly AttitudeMarker[]): void {
  c.strokeStyle = DIM;
  c.lineWidth = 2;
  c.beginPath();
  c.arc(cx, cy, R, 0, Math.PI * 2);
  c.stroke();
  c.setLineDash([4, 6]);
  c.beginPath();
  c.arc(cx, cy, R / 2, 0, Math.PI * 2);
  c.stroke();
  c.setLineDash([]);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    line(c, cx + Math.cos(a) * (R - 7), cy + Math.sin(a) * (R - 7), cx + Math.cos(a) * R, cy + Math.sin(a) * R, DIM, 2);
  }
  // the nose: a small winged cross
  line(c, cx - 14, cy, cx - 5, cy, WHITE, 2.5);
  line(c, cx + 5, cy, cx + 14, cy, WHITE, 2.5);
  line(c, cx, cy - 10, cx, cy - 4, WHITE, 2.5);
  // draw far-side markers first so the near ones stay on top; the target last
  const order = [...markers].sort((a, b) => (a.kind === 'target' ? 1 : 0) - (b.kind === 'target' ? 1 : 0) || b.z - a.z);
  for (const m of order) {
    const ang = Math.acos(Math.min(1, Math.max(-1, -m.z)));
    const l = Math.hypot(m.x, m.y);
    const rr = (ang / Math.PI) * R;
    const ux = l > 1e-6 ? m.x / l : 0;
    const uy = l > 1e-6 ? m.y / l : -1;
    c.globalAlpha = ang > Math.PI / 2 ? 0.55 : 1;
    glyph(c, m.kind, cx + ux * rr, cy - uy * rr);
  }
  c.globalAlpha = 1;
}

export function drawFlightScreen(c: Ctx, w: number, h: number, v: FlightScreenView): void {
  clear(c, w, h);
  // header: where we are, and the drive
  const nameW = text(c, (v.primaryName || '---').toUpperCase(), 12, 29, 25, CYAN);
  const sit = SITUATION[v.situation] ?? [String(v.situation).toUpperCase(), AMBER];
  text(c, sit[0], 24 + nameW, 29, 21, sit[1]);
  const burning = v.throttle > 0.001;
  const dTxt = v.armed ? `ARMED ${Math.round(v.throttle * 100)}%` : 'SAFE';
  c.font = `700 22px ${FONT}`;
  const dw = c.measureText(dTxt).width + 18;
  if (v.armed) {
    c.fillStyle = burning ? RED : AMBER;
    c.fillRect(w - 10 - dw, 6, dw, 29);
    text(c, dTxt, w - 19, 29, 22, BG, 'right');
  } else {
    c.strokeStyle = GREEN;
    c.lineWidth = 2;
    c.strokeRect(w - 10 - dw, 7, dw, 27);
    text(c, dTxt, w - 19, 29, 22, GREEN, 'right');
  }
  line(c, 8, 41, w - 8, 41, DIM, 2);

  // left column
  const row = (y: number, label: string, val: [string, string], color: string, extra = ''): void => {
    text(c, label, 12, y, 22, DIM);
    text(c, val[0], 196, y, 30, color, 'right');
    text(c, val[1], 202, y, 20, DIM);
    if (extra) text(c, extra, 306, y, 20, CYAN, 'right');
  };
  row(73, 'ALT', fmtDistance(v.altitude), WHITE);
  row(107, 'SPD', fmtSpeed(v.speed), WHITE);
  const vs = fmtSpeed(v.verticalSpeed);
  row(141, 'V/S', [(v.verticalSpeed >= 0 ? '+' : '') + vs[0], vs[1]], v.verticalSpeed < 0 && v.situation !== 'orbit' ? AMBER : WHITE);
  row(175, 'AP', fmtDistance(v.apoapsisAlt), WHITE, fmtTime(v.timeToApoapsis));
  row(209, 'PE', fmtDistance(v.periapsisAlt), v.periapsisAlt < 0 ? RED : WHITE, fmtTime(v.timeToPeriapsis));

  attitudeDisc(c, 410, 131, 84, v.markers);
  line(c, 8, 223, w - 8, 223, DIM, 2);

  // hold, felt acceleration, spin
  text(c, 'HOLD', 12, 249, 20, DIM);
  text(c, v.hold, 72, 249, 26, v.hold === 'OFF' ? DIM : AMBER);
  const g = Number.isFinite(v.accelG) ? v.accelG : 0;
  text(c, `${g.toFixed(2)} g`, 372, 249, 24, g > 0.005 ? AMBER : WHITE, 'right');
  const spin = ((Number.isFinite(v.spin) ? v.spin : 0) * 180) / Math.PI;
  text(c, `${spin.toFixed(spin < 10 ? 1 : 0)}°/s`, w - 12, 249, 24, spin > 3 ? AMBER : WHITE, 'right');

  // flight assist: state, reference, speed relative to it -> commanded speed
  if (v.assist === 'NO REF') text(c, 'ASSIST · NO REF', 12, 277, 22, AMBER);
  else {
    text(c, 'ASSIST', 12, 277, 20, DIM);
    if (v.assist === 'ON') {
      const num = (x: number): string => (Number.isFinite(x) ? x : 0).toFixed(Math.abs(x) < 100 ? 1 : 0);
      const sw = text(c, `${num(v.assistSpeed)} → ${num(v.assistCmd)} m/s`, w - 12, 277, 22, WHITE, 'right');
      text(c, 'ON', 92, 277, 22, GREEN);
      let nm = (v.assistRef || '---').toUpperCase();
      c.font = `700 19px ${FONT}`;
      const room = w - 12 - sw - 14 - 130;
      while (nm.length > 3 && c.measureText(nm).width > room) nm = nm.slice(0, -1);
      text(c, nm, 130, 277, 19, CYAN);
    } else text(c, 'OFF', 92, 277, 22, DIM);
  }

  // propellant
  const pf = v.propellantFraction;
  bar(c, 12, 287, w - 24, 9, pf, pf < 0.1 ? RED : pf < 0.25 ? AMBER : GREEN);
  text(c, 'PROP', 12, 322, 20, DIM);
  text(c, `${Math.round(pf * 100)}%`, 72, 322, 27, WHITE);
  const dv = fmtSpeed(v.deltaV);
  text(c, `${dv[0]} ${dv[1]}`, w - 12, 322, 27, WHITE, 'right');
  c.font = `700 27px ${FONT}`;
  const dvw = c.measureText(`${dv[0]} ${dv[1]}`).width;
  text(c, 'ΔV', w - 22 - dvw, 322, 20, DIM, 'right');
}

const NAV_PAGES: [string, string][] = [['orbit', 'ORBIT'], ['docking', 'DOCK'], ['systems', 'SYS']];

function navHeader(c: Ctx, w: number, page: string): void {
  let x = 10;
  for (const [id, label] of NAV_PAGES) {
    c.font = `700 22px ${FONT}`;
    const tw = c.measureText(label).width + 22;
    if (id === page) {
      c.fillStyle = CYAN;
      c.fillRect(x, 6, tw, 29);
      text(c, label, x + 11, 29, 22, BG);
    } else {
      c.strokeStyle = DIM;
      c.lineWidth = 2;
      c.strokeRect(x, 7, tw, 27);
      text(c, label, x + 11, 29, 22, DIM);
    }
    x += tw + 8;
  }
  line(c, 8, 41, w - 8, 41, DIM, 2);
}

function drawOrbit(c: Ctx, w: number, h: number, o: OrbitPageView): void {
  text(c, (o.bodyName || '').toUpperCase(), w - 12, 29, 22, CYAN, 'right');
  // fit the path and the body
  let x0 = -o.bodyRadius;
  let x1 = o.bodyRadius;
  let y0 = -o.bodyRadius;
  let y1 = o.bodyRadius;
  for (let i = 0; i < o.pathCount; i++) {
    const x = o.path[i * 2];
    const y = o.path[i * 2 + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const top = 50;
  const bot = h - 44;
  const k = Math.min((w - 60) / Math.max(x1 - x0, 1), (bot - top - 16) / Math.max(y1 - y0, 1));
  const ox = w / 2 - ((x0 + x1) / 2) * k;
  const oy = (top + bot) / 2 + ((y0 + y1) / 2) * k;
  const X = (x: number): number => ox + x * k;
  const Y = (y: number): number => oy - y * k;
  c.save();
  c.beginPath();
  c.rect(4, 44, w - 8, bot - 40);
  c.clip();
  // the body
  c.fillStyle = '#0d2a33';
  c.strokeStyle = CYAN;
  c.lineWidth = 2;
  c.beginPath();
  c.arc(X(0), Y(0), Math.max(2, o.bodyRadius * k), 0, Math.PI * 2);
  c.fill();
  c.stroke();
  const poly = (pts: Float32Array, n: number, color: string, lw: number, dash: number[]): void => {
    if (n < 2) return;
    c.strokeStyle = color;
    c.lineWidth = lw;
    c.setLineDash(dash);
    c.beginPath();
    c.moveTo(X(pts[0]), Y(pts[1]));
    for (let i = 1; i < n; i++) c.lineTo(X(pts[i * 2]), Y(pts[i * 2 + 1]));
    c.stroke();
    c.setLineDash([]);
  };
  poly(o.targetPath, o.targetCount, RED, 2, [5, 6]);
  poly(o.path, o.pathCount, AMBER, 2.5, []);
  const tag = (x: number, y: number, label: string, color: string): void => {
    const px = X(x);
    const py = Y(y);
    c.strokeStyle = color;
    c.lineWidth = 2.5;
    c.beginPath();
    c.arc(px, py, 6, 0, Math.PI * 2);
    c.stroke();
    const dx = px - X(0);
    const dy = py - Y(0);
    const l = Math.hypot(dx, dy) || 1;
    text(c, label, Math.min(w - 30, Math.max(30, px + (dx / l) * 24)), Math.min(bot - 6, Math.max(top + 14, py + (dy / l) * 20 + 7)), 20, color, 'center');
  };
  if (o.hasApo) tag(o.apoX, o.apoY, 'AP', CYAN);
  if (o.hasPeri) tag(o.periX, o.periY, 'PE', CYAN);
  if (o.hasTarget) {
    const px = X(o.targetX);
    const py = Y(o.targetY);
    if (px > 0 && px < w && py > 44 && py < bot) glyph(c, 'target', px, py);
  }
  // the ship
  const sx = X(o.shipX);
  const sy = Y(o.shipY);
  c.fillStyle = WHITE;
  c.beginPath();
  c.arc(sx, sy, 5.5, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = WHITE;
  c.lineWidth = 2;
  c.beginPath();
  c.arc(sx, sy, 11, 0, Math.PI * 2);
  c.stroke();
  c.restore();
  line(c, 8, bot + 6, w - 8, bot + 6, DIM, 2);
  const ap = fmtDistance(o.apoapsisAlt);
  const pe = fmtDistance(o.periapsisAlt);
  text(c, 'AP', 12, h - 12, 19, DIM);
  text(c, `${ap[0]}${ap[1] ? ' ' + ap[1] : ''}`, 44, h - 12, 23, WHITE);
  text(c, 'PE', 196, h - 12, 19, DIM);
  text(c, `${pe[0]}${pe[1] ? ' ' + pe[1] : ''}`, 228, h - 12, 23, o.periapsisAlt < 0 ? RED : WHITE);
  text(c, fmtTime(o.period), w - 12, h - 12, 23, WHITE, 'right');
  c.font = `700 23px ${FONT}`;
  text(c, 'T', w - 20 - c.measureText(fmtTime(o.period)).width, h - 12, 19, DIM, 'right');
}

function drawDocking(c: Ctx, w: number, h: number, d: DockingPageView): void {
  // cross-pointer: the port's mating point off the collar axis; the ring closes as the axes line up
  const cx = 132;
  const cy = 191;
  const R = 122;
  c.strokeStyle = DIM;
  c.lineWidth = 2;
  c.strokeRect(cx - R, cy - R, R * 2, R * 2);
  line(c, cx - R, cy, cx - 12, cy, DIM, 2);
  line(c, cx + 12, cy, cx + R, cy, DIM, 2);
  line(c, cx, cy - R, cx, cy - 12, DIM, 2);
  line(c, cx, cy + 12, cx, cy + R, DIM, 2);
  c.strokeRect(cx - R / 2, cy - R / 2, R, R);
  let scale = 1;
  for (const s of [1, 5, 25, 100, 500, 2500, 10000]) {
    scale = s;
    if (Math.max(Math.abs(d.lateralX), Math.abs(d.lateralY)) <= s) break;
  }
  if (d.hasPort || d.docked) {
    const px = cx + Math.max(-1, Math.min(1, d.lateralX / scale)) * R;
    const py = cy - Math.max(-1, Math.min(1, d.lateralY / scale)) * R;
    const col = d.canLatch || d.docked ? GREEN : AMBER;
    line(c, px, cy - R + 3, px, cy + R - 3, col, 3);
    line(c, cx - R + 3, py, cx + R - 3, py, col, 3);
    const ar = Math.min(R - 4, 8 + (Math.min(d.alignment, 0.5236) / 0.5236) * (R - 12));
    c.strokeStyle = CYAN;
    c.lineWidth = 2.5;
    c.beginPath();
    c.arc(cx, cy, ar, 0, Math.PI * 2);
    c.stroke();
  }
  text(c, `±${scale} m`, cx + R - 6, cy + R - 8, 18, DIM, 'right');

  const x = 270;
  text(c, (d.name || 'NO TARGET').toUpperCase().slice(0, 16), x, 76, 23, CYAN);
  const row = (y: number, label: string, val: string, color: string): void => {
    text(c, label, x, y, 19, DIM);
    text(c, val, w - 12, y, 27, color, 'right');
  };
  const rg = fmtDistance(d.range);
  row(116, 'RANGE', `${rg[0]} ${rg[1]}`, WHITE);
  const cl = Number.isFinite(d.closing) ? d.closing : 0;
  row(152, 'CLOSE', `${cl >= 0 ? '+' : ''}${cl.toFixed(Math.abs(cl) < 10 ? 2 : 1)}`, cl > 2 && d.range < 200 ? RED : WHITE);
  row(188, 'OFF', d.hasPort ? `${d.lateral.toFixed(d.lateral < 10 ? 2 : 0)} m` : '---', WHITE);
  row(224, 'ALIGN', d.hasPort ? `${((d.alignment * 180) / Math.PI).toFixed(1)}°` : '---', WHITE);
  const banner = d.docked ? 'DOCKED' : d.canLatch ? 'LATCH READY' : d.hasPort ? 'APPROACH' : 'NO PORT';
  if (d.docked || d.canLatch) {
    c.fillStyle = GREEN;
    c.fillRect(x - 4, 258, w - x - 4, 46);
    text(c, banner, (x + w - 8) / 2, 291, 28, BG, 'center');
  } else {
    c.strokeStyle = DIM;
    c.lineWidth = 2;
    c.strokeRect(x - 4, 258, w - x - 4, 46);
    text(c, banner, (x + w - 8) / 2, 291, 26, d.hasPort ? AMBER : DIM, 'center');
  }
}

function drawSystems(c: Ctx, w: number, _h: number, s: SystemsPageView): void {
  const rowBar = (y: number, label: string, frac: number, val: string, color: string): void => {
    text(c, label, 12, y + 20, 20, DIM);
    bar(c, 96, y, 250, 26, frac, color);
    text(c, val, w - 12, y + 22, 26, WHITE, 'right');
  };
  const pf = s.propellantFraction;
  rowBar(56, 'PROP', pf, `${group(s.propellantKg.toFixed(0))} kg`, pf < 0.1 ? RED : pf < 0.25 ? AMBER : GREEN);
  rowBar(98, 'HULL', s.hull, `${Math.round(s.hull * 100)}%`, s.hull < 0.3 ? RED : s.hull < 0.7 ? AMBER : GREEN);
  rowBar(140, 'HEAT', s.heat, `${Math.round(s.heat * 100)}%`, s.heat > 0.8 ? RED : s.heat > 0.5 ? AMBER : CYAN);
  line(c, 8, 184, w - 8, 184, DIM, 2);
  text(c, 'CABIN LIGHTS', 12, 216, 20, DIM);
  text(c, s.cabinLights ? 'ON' : 'OFF', w - 12, 216, 26, s.cabinLights ? GREEN : AMBER, 'right');
  const t = Math.max(0, Number.isFinite(s.time) ? s.time : 0);
  const day = Math.floor(t / 86400) + 1;
  const hh = String(Math.floor((t % 86400) / 3600)).padStart(2, '0');
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const ss = String(Math.floor(t % 60)).padStart(2, '0');
  text(c, `DAY ${day}`, 12, 258, 26, WHITE);
  text(c, `${hh}:${mm}:${ss}`, w - 12, 258, 30, WHITE, 'right');
  line(c, 8, 276, w - 8, 276, DIM, 2);
  text(c, 'TIME', 12, 316, 20, DIM);
  if (s.asleep) {
    text(c, 'ASLEEP', 76, 316, 24, AMBER);
    text(c, `×${group(s.warp.toFixed(0))}`, w - 12, 316, 30, AMBER, 'right');
    if (s.warpLimit) text(c, s.warpLimit.toUpperCase(), 190, 316, 19, DIM);
  } else {
    text(c, '×1', w - 12, 316, 30, WHITE, 'right');
  }
}

export function drawNavScreen(c: Ctx, w: number, h: number, page: string, d: InstrumentData): void {
  clear(c, w, h);
  const pg = page === 'docking' || page === 'systems' ? page : 'orbit';
  navHeader(c, w, pg);
  if (pg === 'orbit') drawOrbit(c, w, h, d.orbit);
  else if (pg === 'docking') drawDocking(c, w, h, d.docking);
  else drawSystems(c, w, h, d.systems);
}

/** What a screen shows before the first data arrives. */
export function drawNoData(c: Ctx, w: number, h: number, label: string): void {
  clear(c, w, h);
  text(c, label, w / 2, h / 2 - 6, 30, DIM, 'center');
  text(c, 'NO DATA', w / 2, h / 2 + 30, 22, DIM, 'center');
}

/**
 * The side-console glass (drawn once at load): a power and thermal bus mimic of our own — busbars, breakers,
 * the radiator loop — static apart from what the cockpit draws over it. `side` -1 port (POWER), +1 starboard
 * (THERMAL).
 */
export function drawAuxScreen(c: Ctx, w: number, h: number, side: number): void {
  clear(c, w, h);
  const title = side < 0 ? 'POWER · BUS A/B' : 'THERMAL · LOOP 1/2';
  text(c, title, 12, 28, 21, CYAN);
  text(c, side < 0 ? 'NOMINAL' : 'IN LIMITS', w - 12, 28, 18, GREEN, 'right');
  line(c, 8, 40, w - 8, 40, DIM, 2);
  const names = side < 0 ? ['REACTOR', 'DRIVE', 'RCS', 'LIFE', 'AVION', 'CABIN'] : ['RAD P', 'RAD S', 'PUMP A', 'PUMP B', 'CABIN', 'AVION'];
  const vals = side < 0 ? [0.82, 0.64, 0.3, 0.46, 0.38, 0.55] : [0.58, 0.61, 0.72, 0.7, 0.42, 0.36];
  const top = 62;
  const pitch = (h - top - 34) / names.length;
  for (let i = 0; i < names.length; i++) {
    const y = top + i * pitch;
    text(c, names[i], 12, y + 17, 17, DIM);
    bar(c, 120, y + 2, w - 210, 18, vals[i], i === 0 ? CYAN : '#2fb6d6');
    text(c, `${Math.round(vals[i] * (side < 0 ? 48 : 340))}${side < 0 ? ' kW' : ' K'}`, w - 12, y + 17, 17, WHITE, 'right');
  }
  line(c, 8, h - 30, w - 8, h - 30, DIM, 2);
  text(c, side < 0 ? 'BUS TIE  CLOSED     BATT 97%' : 'COOLANT 312 K     FLOW 1.8 kg/s', 12, h - 9, 16, DIM);
}
