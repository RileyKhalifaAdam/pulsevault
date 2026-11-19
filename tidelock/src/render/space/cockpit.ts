// The physical cockpit: every device of src/data/cockpit.ts as geometry the pilot can see move and put a
// finger on, the flight station's housing, and the two console screens (instruments.ts) as canvas textures.
//
//   const ck = createCockpitVisual(COCKPITS.wren, { quality });
//   interior.object3d.add(ck.object3d);                       // ship-local axes
//   ck.update({ devices: session.devices(), time, lights, gain, instruments });
//   const hit = ck.pick(rayOriginLocal, rayDirLocal, tolerance);   // -> { id, x, y } | null
//
// Five draw calls: the static hardware, the moving parts (one mesh, re-posed on the CPU only when a device
// moves), everything that glows (lamp legends, backlit placards, the highlight under the hand; additive), and
// the two screens. Lighting of the hardware is baked into vertex colours (cabin lamps overhead, the
// windscreen ahead) and scaled by the cabin light level and the display gain, like the interior around it.
import * as THREE from 'three';
import type { CockpitLayout, DeviceDef, DeviceKind } from '../../data/cockpit';
import type { DeviceView } from '../../game/api';
import type { Quality } from '../pipeline';
import { SCREEN_H, SCREEN_W, drawFlightScreen, drawNavScreen, drawNoData, type InstrumentData } from './instruments';

export interface CockpitUpdate {
  devices: readonly DeviceView[];
  /** Seconds, any monotonic clock (screen refresh, light fade). */
  time: number;
  /** Cabin lights on. Off leaves the lamps, the backlit placards and the screens. */
  lights: boolean;
  /** Display gain (2^-EV of the pipeline), as for the interior. */
  gain?: number;
  /** What the screens show; null leaves them on their last picture. */
  instruments?: InstrumentData | null;
}

export interface CockpitPick {
  id: string;
  /**
   * The hand in the device's own axes: stick2 x right, y along its `up`, each -1..1; lever x = 0..1 along its
   * travel; rocker x = -1 | 0 | +1 (which end the finger is on); screens and rests x, y = -1..1 across them.
   */
  x: number;
  y: number;
}

export interface CockpitVisual {
  object3d: THREE.Object3D;
  update(o: CockpitUpdate): void;
  /**
   * The device under a ray (ship-local origin and unit direction). `tolerance` is the finger's half-width as
   * an angle, rad. With `only`, the hand position on that device wherever the ray goes (for a drag in progress).
   */
  pick(origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, tolerance?: number, only?: string): CockpitPick | null;
  dispose(): void;
  readonly drawCalls: number;
  readonly triangles: number;
}

type RGB = readonly [number, number, number];
type UVR = readonly [number, number, number, number]; // u0, v bottom, u1, v top
const lin = (hex: number): RGB => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};
const PANEL = lin(0x3b3f46);
const HOOD = lin(0x1d1f22);
const DESK = lin(0x33363c);
const DARK = lin(0x18191c);
const BLACK = lin(0x08090a);
const BEZEL = lin(0x141518);
const METAL = lin(0xa9adb3);
const STEEL = lin(0x6f747b);
const RUBBER = lin(0x121315);
const GRIP = lin(0x2a2c30);
const CAP = lin(0x202327);
const PADDLE = lin(0xb9b6ab);
const REDP = lin(0xb3261a);
const ORANGE = lin(0xd0561a);
const YELLOW = lin(0xd9a516);
const STRAP = lin(0x3b3830);

/** Baked light: the cabin lamps overhead and a little from the windscreen. Unit normal in ship axes. */
const L1 = new THREE.Vector3(0.15, 0.8, 0.58).normalize();
const L2 = new THREE.Vector3(0, 0.5, -0.866);
const shade = (n: THREE.Vector3): number => 0.34 + 0.62 * Math.max(0, n.dot(L1)) + 0.16 * Math.max(0, n.dot(L2));

class Geo {
  pos: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  /** Colours go in as they are (things that glow) instead of shaded by the baked light. */
  raw = false;
  private readonly m = new THREE.Matrix4();
  private readonly nm = new THREE.Matrix3();
  private readonly p = new THREE.Vector3();
  private readonly n = new THREE.Vector3();

  /** Build in this frame. `local` keeps positions in the frame's own coordinates (moving parts) but lights them in place. */
  frame(f: THREE.Matrix4, local = false, within?: THREE.Matrix4): void {
    if (local && within) this.m.copy(within);
    else if (local) this.m.identity();
    else this.m.copy(f);
    this.nm.setFromMatrix4(f);
  }
  get count(): number {
    return this.pos.length / 3;
  }
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: RGB, u = 0, w = 0): number {
    const i = this.pos.length / 3;
    this.p.set(x, y, z).applyMatrix4(this.m);
    this.pos.push(this.p.x, this.p.y, this.p.z);
    let s = 1;
    if (!this.raw) s = shade(this.n.set(nx, ny, nz).applyMatrix3(this.nm).normalize());
    this.col.push(c[0] * s, c[1] * s, c[2] * s);
    this.uv.push(u, w);
    return i;
  }
  private q(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }
  /** A flat rectangle in the frame's x/y plane at height z, facing +z. Returns its first vertex. */
  rect(cx: number, cy: number, z: number, w: number, h: number, c: RGB, uv?: UVR): number {
    const u0 = uv ? uv[0] : 0;
    const v0 = uv ? uv[1] : 0;
    const u1 = uv ? uv[2] : 0;
    const v1 = uv ? uv[3] : 0;
    const a = this.v(cx - w / 2, cy - h / 2, z, 0, 0, 1, c, u0, v0);
    const b = this.v(cx + w / 2, cy - h / 2, z, 0, 0, 1, c, u1, v0);
    const cc = this.v(cx + w / 2, cy + h / 2, z, 0, 0, 1, c, u1, v1);
    const d = this.v(cx - w / 2, cy + h / 2, z, 0, 0, 1, c, u0, v1);
    this.q(a, b, cc, d);
    return a;
  }
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, c: RGB): void {
    const C = [cx, cy, cz];
    const H = [hx, hy, hz];
    const p = [0, 0, 0];
    const n = [0, 0, 0];
    for (let ax = 0; ax < 3; ax++) {
      const u = (ax + 1) % 3;
      const w = (ax + 2) % 3;
      for (let sg = -1; sg <= 1; sg += 2) {
        n[0] = n[1] = n[2] = 0;
        n[ax] = sg;
        p[ax] = C[ax] + sg * H[ax];
        const i: number[] = [];
        for (const [k0, k1] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          p[u] = C[u] + k0 * sg * H[u];
          p[w] = C[w] + k1 * H[w];
          i.push(this.v(p[0], p[1], p[2], n[0], n[1], n[2], c));
        }
        this.q(i[0], i[1], i[2], i[3]);
      }
    }
  }
  /** A surface of revolution about the frame's +z through (ox, oy): profile points [radius, z], bottom to top. */
  lathe(prof: readonly (readonly [number, number])[], seg: number, c: RGB | readonly RGB[], o: { x?: number; y?: number; sx?: number; sy?: number; smooth?: boolean } = {}): void {
    const ox = o.x ?? 0;
    const oy = o.y ?? 0;
    const sx = o.sx ?? 1;
    const sy = o.sy ?? 1;
    const tan = (i: number, j: number): [number, number] => {
      const a = prof[Math.max(0, i)];
      const b = prof[Math.min(prof.length - 1, j)];
      const dr = b[0] - a[0];
      const dz = b[1] - a[1];
      const l = Math.hypot(dr, dz) || 1;
      return [dz / l, -dr / l];
    };
    for (let b = 0; b < prof.length - 1; b++) {
      const [r0, z0] = prof[b];
      const [r1, z1] = prof[b + 1];
      const cc = (typeof c[0] === 'number' ? c : (c as readonly RGB[])[Math.min(b, c.length - 1)]) as RGB;
      const n0 = o.smooth ? tan(b - 1, b + 1) : tan(b, b + 1);
      const n1 = o.smooth ? tan(b, b + 2) : n0;
      const base = this.count;
      for (let j = 0; j <= seg; j++) {
        const a = (j / seg) * Math.PI * 2;
        const cs = Math.cos(a);
        const sn = Math.sin(a);
        this.v(ox + r0 * cs * sx, oy + r0 * sn * sy, z0, n0[0] * cs, n0[0] * sn, n0[1], cc);
        this.v(ox + r1 * cs * sx, oy + r1 * sn * sy, z1, n1[0] * cs, n1[0] * sn, n1[1], cc);
      }
      for (let j = 0; j < seg; j++) {
        const i = base + j * 2;
        this.q(i, i + 2, i + 3, i + 1);
      }
    }
  }
  /** A round bar between two points, capped. */
  bar(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number, seg: number, c: RGB): void {
    const w = new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0).normalize();
    const u = new THREE.Vector3().crossVectors(w, Math.abs(w.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)).normalize();
    const t = new THREE.Vector3().crossVectors(w, u);
    const base = this.count;
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const nx = u.x * Math.cos(a) + t.x * Math.sin(a);
      const ny = u.y * Math.cos(a) + t.y * Math.sin(a);
      const nz = u.z * Math.cos(a) + t.z * Math.sin(a);
      this.v(x0 + nx * r, y0 + ny * r, z0 + nz * r, nx, ny, nz, c);
      this.v(x1 + nx * r, y1 + ny * r, z1 + nz * r, nx, ny, nz, c);
    }
    for (let j = 0; j < seg; j++) {
      const i = base + j * 2;
      this.q(i, i + 2, i + 3, i + 1);
    }
    for (const [px, py, pz, s] of [[x0, y0, z0, -1], [x1, y1, z1, 1]] as const) {
      const cb = this.v(px, py, pz, w.x * s, w.y * s, w.z * s, c);
      for (let j = 0; j <= seg; j++) {
        const a = (j / seg) * Math.PI * 2;
        const nx = u.x * Math.cos(a) + t.x * Math.sin(a);
        const ny = u.y * Math.cos(a) + t.y * Math.sin(a);
        const nz = u.z * Math.cos(a) + t.z * Math.sin(a);
        this.v(px + nx * r, py + ny * r, pz + nz * r, w.x * s, w.y * s, w.z * s, c);
      }
      for (let j = 0; j < seg; j++) this.idx.push(cb, cb + 1 + j, cb + 2 + j);
    }
  }
  /** A convex profile of (y, z) points extruded along x (frame coordinates). A null colour skips that side. */
  prismX(prof: readonly (readonly [number, number])[], x0: number, x1: number, cols: readonly (RGB | null)[], cap: RGB): void {
    let cy = 0;
    let cz = 0;
    for (const p of prof) {
      cy += p[0] / prof.length;
      cz += p[1] / prof.length;
    }
    for (let i = 0; i < prof.length; i++) {
      const c = cols[i];
      if (!c) continue;
      const p = prof[i];
      const q = prof[(i + 1) % prof.length];
      let ny = q[1] - p[1];
      let nz = -(q[0] - p[0]);
      const l = Math.hypot(ny, nz) || 1;
      ny /= l;
      nz /= l;
      if (ny * ((p[0] + q[0]) / 2 - cy) + nz * ((p[1] + q[1]) / 2 - cz) < 0) {
        ny = -ny;
        nz = -nz;
      }
      const a = this.v(x0, p[0], p[1], 0, ny, nz, c);
      const b = this.v(x1, p[0], p[1], 0, ny, nz, c);
      const cc = this.v(x1, q[0], q[1], 0, ny, nz, c);
      const d = this.v(x0, q[0], q[1], 0, ny, nz, c);
      this.q(a, b, cc, d);
    }
    for (const [x, s] of [[x0, -1], [x1, 1]] as const) {
      const base = this.count;
      for (const p of prof) this.v(x, p[0], p[1], s, 0, 0, cap);
      for (let i = 1; i < prof.length - 1; i++) this.idx.push(base, base + i, base + i + 1);
    }
  }
  build(dynamic: boolean): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(new Float32Array(this.pos), 3);
    const ca = new THREE.BufferAttribute(new Float32Array(this.col), 3);
    if (dynamic) {
      pa.setUsage(THREE.DynamicDrawUsage);
      ca.setUsage(THREE.DynamicDrawUsage);
    }
    g.setAttribute('position', pa);
    g.setAttribute('color', ca);
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.setIndex(this.count > 65535 ? new THREE.BufferAttribute(new Uint32Array(this.idx), 1) : new THREE.BufferAttribute(new Uint16Array(this.idx), 1));
    return g;
  }
}

// ---- the atlas of everything written or lit: lamp legends, placards, the highlight ring ----------------------
const AW = 1024;
const AH = 512;
interface Atlas {
  tex: THREE.CanvasTexture;
  lamp: Map<string, UVR>;
  placard: Map<string, UVR>;
  ring: UVR;
  white: UVR;
  dot: UVR;
  scale: UVR;
}
const SANS = '"Arial Narrow", "Helvetica Neue", Helvetica, Arial, sans-serif';
function makeAtlas(layout: CockpitLayout, aniso: number): Atlas {
  const cv = document.createElement('canvas');
  cv.width = AW;
  cv.height = AH;
  const c = cv.getContext('2d') as CanvasRenderingContext2D;
  c.fillStyle = '#000';
  c.fillRect(0, 0, AW, AH);
  const uvr = (x: number, y: number, w: number, h: number): UVR => [(x + 0.5) / AW, 1 - (y + h - 0.5) / AH, (x + w - 0.5) / AW, 1 - (y + 0.5) / AH];
  const fit = (s: string, cx: number, cy: number, maxW: number, px: number, color: string): void => {
    c.font = `700 ${px}px ${SANS}`;
    const w = c.measureText(s).width;
    if (w > maxW) c.font = `700 ${Math.floor((px * maxW) / w)}px ${SANS}`;
    c.fillStyle = color;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(s, cx, cy + 2);
  };
  const lamp = new Map<string, UVR>();
  const placard = new Map<string, UVR>();
  let li = 0;
  let pi = 0;
  const addPlacard = (label: string): void => {
    if (placard.has(label)) return;
    const x = (pi % 4) * 256;
    const y = 256 + Math.floor(pi / 4) * 48;
    pi++;
    fit(label, x + 128, y + 24, 240, 36, '#fff');
    placard.set(label, uvr(x + 2, y + 2, 252, 44));
  };
  for (const d of layout.devices) {
    if (d.kind === 'button') {
      const x = (li % 8) * 128;
      const y = Math.floor(li / 8) * 128;
      li++;
      const round = d.role === 'targetNext';
      c.fillStyle = 'rgba(255,255,255,0.26)';
      c.strokeStyle = 'rgba(255,255,255,0.6)';
      c.lineWidth = 4;
      c.beginPath();
      if (round) c.arc(x + 64, y + 64, 54, 0, Math.PI * 2);
      else c.roundRect(x + 9, y + 9, 110, 110, 12);
      c.fill();
      c.stroke();
      fit(round ? 'NEXT' : d.label, x + 64, y + 64, round ? 80 : 96, 46, '#fff');
      lamp.set(d.id, uvr(x + 2, y + 2, 124, 124));
      if (round) addPlacard(d.label);
    } else if (d.kind !== 'rest') addPlacard(d.label);
  }
  addPlacard('ARMED');
  // the ring that shows under the hand
  const rx = 512;
  const ry = 128;
  const grd = c.createRadialGradient(rx + 64, ry + 64, 30, rx + 64, ry + 64, 62);
  grd.addColorStop(0, 'rgba(255,255,255,0)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.12)');
  grd.addColorStop(0.8, 'rgba(255,255,255,0.9)');
  grd.addColorStop(0.9, 'rgba(255,255,255,0.35)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = grd;
  c.fillRect(rx, ry, 128, 128);
  c.fillStyle = '#fff';
  c.fillRect(640, 128, 64, 64);
  const dg = c.createRadialGradient(736, 160, 2, 736, 160, 30);
  dg.addColorStop(0, '#fff');
  dg.addColorStop(0.45, 'rgba(255,255,255,0.8)');
  dg.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = dg;
  c.fillRect(704, 128, 64, 64);
  // throttle scale: ticks and numbers up a tall cell, 0 at the bottom
  const sx0 = 768;
  const sy0 = 128;
  c.fillStyle = '#fff';
  for (let i = 0; i <= 10; i++) {
    const y = sy0 + 118 - i * 10.8;
    c.fillRect(sx0 + 4, y - 1.5, i % 5 === 0 ? 22 : 12, 3);
  }
  c.font = `700 20px ${SANS}`;
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  c.fillText('0', sx0 + 32, sy0 + 117);
  c.fillText('50', sx0 + 32, sy0 + 65);
  c.fillText('100', sx0 + 30, sy0 + 12);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = aniso;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return { tex, lamp, placard, ring: uvr(rx, ry, 128, 128), white: uvr(650, 138, 44, 44), dot: uvr(704, 128, 64, 64), scale: uvr(sx0, sy0, 64, 128) };
}

interface Dev {
  def: DeviceDef;
  kind: DeviceKind;
  pos: THREE.Vector3;
  R: THREE.Vector3;
  U: THREE.Vector3;
  N: THREE.Vector3;
  frame: THREE.Matrix4;
  /** Touch shape: a segment (a = b for a point) with a radius, or the rectangle hw x hh in the device plane. */
  a: THREE.Vector3;
  b: THREE.Vector3;
  r: number;
  rect: boolean;
  hw: number;
  hh: number;
  /** Rocker: which local axis it rocks along (0 = right, 1 = up). */
  axis: number;
  /** Emissive vertices to recolour with the lamp (first vertex, count) and its lit colour. */
  lampV: number;
  lampN: number;
  lampC: RGB;
  offC: RGB;
  lit: boolean | null;
  /** Buckle: where the touch target is while the harness is not worn (on the seat). */
  alt: THREE.Vector3 | null;
}
interface Part {
  dev: number;
  v0: number;
  v1: number;
  move: (x: number, y: number, m: THREE.Matrix4) => void;
  lx: number;
  ly: number;
}

const LAMP_OFF: RGB = [0.1, 0.105, 0.11];
const PLACARD: RGB = [0.42, 0.44, 0.46];
/** Brightness of the hardware under the cabin lamps, of the glowing things, and of the screens (x display gain). */
const K_LIT = 2.1;
const K_EM = 1.25;
const K_SCREEN = 1.05;
const STICK_TILT = 0.4;
/** From the worn harness buckle to the middle of the seat it belongs to, ship axes, m; and the seat's touch radius. */
const SEAT_OFFSET = new THREE.Vector3(0, -0.2, 0.2);
const SEAT_RADIUS = 0.27;
const GUARD_HINGE = 0.03;

export function createCockpitVisual(layout: CockpitLayout, opts: { quality: Quality }): CockpitVisual {
  const hi = opts.quality !== 'low';
  const seg = hi ? 24 : 18;
  const atlas = makeAtlas(layout, hi ? 8 : 4);
  const S = new Geo(); // static hardware
  const M = new Geo(); // moving parts
  const E = new Geo(); // everything that glows
  E.raw = true;
  const devs: Dev[] = [];
  const parts: Part[] = [];
  const tmp = new THREE.Matrix4();
  const IDENT = new THREE.Matrix4();

  // ---- the flight station's housing
  const st = layout.station;
  if (st) {
    S.frame(IDENT);
    const fo = st.faceOrigin;
    const top: [number, number] = [fo.y + st.faceUp.y * st.faceTop, fo.z + st.faceUp.z * st.faceTop];
    const bot: [number, number] = [fo.y + st.faceUp.y * st.faceBottom, fo.z + st.faceUp.z * st.faceBottom];
    S.prismX([[st.hoodBack.y, st.hoodBack.z], top, bot, [st.underBack.y, st.underBack.z], [st.underBack.y, st.hoodBack.z]], st.x0, st.x1, [HOOD, PANEL, DARK, DARK, null], DARK);
    const dy = st.deskY;
    const nz = st.deskNearZ;
    S.prismX(
      [[dy, bot[1] - 0.03], [dy, nz], [dy - 0.012, nz + 0.008], [dy - 0.04, nz + 0.008], [dy - 0.052, nz - 0.008], [dy - 0.075, bot[1] - 0.03]],
      st.x0, st.x1, [DESK, DESK, DARK, DARK, DARK, null], DARK,
    );
    // glare lip over the screens, cheeks down the sides, a screw in each corner of the face
    const R = new THREE.Vector3().crossVectors(new THREE.Vector3(st.faceUp.x, st.faceUp.y, st.faceUp.z), new THREE.Vector3(st.faceNormal.x, st.faceNormal.y, st.faceNormal.z));
    const ff = new THREE.Matrix4().makeBasis(R, new THREE.Vector3(st.faceUp.x, st.faceUp.y, st.faceUp.z), new THREE.Vector3(st.faceNormal.x, st.faceNormal.y, st.faceNormal.z)).setPosition(fo.x, fo.y, fo.z);
    S.frame(ff);
    const hwid = (st.x1 - st.x0) / 2;
    const cxm = (st.x0 + st.x1) / 2 - fo.x;
    S.box(cxm, st.faceTop + 0.004, 0.018, hwid, 0.004, 0.024, HOOD);
    for (const sx of [-1, 1]) {
      S.box(cxm + sx * (hwid - 0.004), (st.faceTop + st.faceBottom) / 2, 0.005, 0.004, (st.faceTop - st.faceBottom) / 2, 0.005, HOOD);
      for (const sy of [st.faceTop - 0.012, st.faceBottom + 0.012]) S.lathe([[0.004, 0], [0.004, 0.0015], [0, 0.002]], 6, STEEL, { x: cxm + sx * (hwid - 0.018), y: sy });
    }
  }

  // ---- devices
  const eRect = (cx: number, cy: number, z: number, w: number, h: number, c: RGB, uv: UVR): number => E.rect(cx, cy, z, w, h, c, uv);
  const placardAt = (label: string, cx: number, cy: number, z: number, h: number): void => {
    const uv = atlas.placard.get(label);
    if (uv) eRect(cx, cy, z, h * (252 / 44), h, PLACARD, uv);
  };
  const part = (dev: number, f: THREE.Matrix4, build: () => void, move: Part['move']): void => {
    M.frame(f, true);
    const v0 = M.count;
    build();
    parts.push({ dev, v0, v1: M.count, move, lx: NaN, ly: NaN });
  };
  const screens: { dev: number; mesh: THREE.Mesh; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture; last: number; page: string }[] = [];
  const screenMat: THREE.MeshBasicMaterial[] = [];

  layout.devices.forEach((def, i) => {
    const U = new THREE.Vector3(def.up.x, def.up.y, def.up.z).normalize();
    const N = new THREE.Vector3(def.normal.x, def.normal.y, def.normal.z).normalize();
    const R = new THREE.Vector3().crossVectors(U, N).normalize();
    const pos = new THREE.Vector3(def.pos.x, def.pos.y, def.pos.z);
    const f = new THREE.Matrix4().makeBasis(R, U, N).setPosition(pos);
    const d: Dev = {
      def, kind: def.kind, pos, R, U, N, frame: f, a: pos.clone().addScaledVector(N, 0.008), b: pos.clone().addScaledVector(N, 0.008),
      r: def.radius, rect: false, hw: def.halfWidth ?? def.radius, hh: def.halfHeight ?? def.radius, axis: 0, lampV: -1, lampN: 0, lampC: LAMP_OFF, offC: LAMP_OFF, lit: null, alt: null,
    };
    devs.push(d);
    S.frame(f);
    E.frame(f);
    const travel = def.travel ?? 0.06;
    switch (def.kind) {
      case 'screen': {
        d.rect = true;
        const hw = d.hw;
        const hh = d.hh;
        const bw = 0.008;
        S.box(0, hh + bw / 2, 0.003, hw + bw, bw / 2, 0.003, BEZEL);
        S.box(0, -hh - bw / 2, 0.003, hw + bw, bw / 2, 0.003, BEZEL);
        S.box(-hw - bw / 2, 0, 0.003, bw / 2, hh, 0.003, BEZEL);
        S.box(hw + bw / 2, 0, 0.003, bw / 2, hh, 0.003, BEZEL);
        placardAt(def.label, 0, hh + bw / 2, 0.0066, 0.0075);
        const canvas = document.createElement('canvas');
        canvas.width = SCREEN_W;
        canvas.height = SCREEN_H;
        const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
        drawNoData(ctx, SCREEN_W, SCREEN_H, def.label);
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = hi ? 8 : 4;
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        const g = new Geo();
        g.raw = true;
        g.frame(f);
        g.rect(0, 0, 0.0012, hw * 2, hh * 2, [1, 1, 1], [0, 0, 1, 1]);
        const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
        screenMat.push(mat);
        const mesh = new THREE.Mesh(g.build(false), mat);
        screens.push({ dev: i, mesh, canvas, ctx, tex, last: -1e9, page: '' });
        break;
      }
      case 'button': {
        const round = def.role === 'targetNext';
        const uv = atlas.lamp.get(def.id) ?? atlas.white;
        d.lampC = def.role === 'holdOff' || def.role === 'holdStability' ? [1.5, 0.95, 0.3] : def.role === 'holdDock' || def.role === 'holdTarget' ? [0.45, 1.25, 1.5] : round ? [1.3, 1.3, 1.2] : [0.5, 1.5, 0.7];
        if (round) {
          S.lathe([[0.027, 0], [0.027, 0.003], [0.0225, 0.005], [0.0225, 0.011], [0.02, 0.013], [0, 0.013]], seg, [STEEL, STEEL, CAP, CAP, CAP]);
          d.lampV = eRect(0, 0, 0.0138, 0.042, 0.042, LAMP_OFF, uv);
          placardAt(def.label, 0, 0.0345, 0.0008, 0.0105);
        } else {
          const h = 0.027;
          S.box(0, 0, 0.001, h + 0.003, h + 0.003, 0.001, BLACK);
          S.box(0, 0, 0.005, h - 0.001, h - 0.001, 0.004, CAP);
          d.lampV = eRect(0, 0, 0.0098, 0.052, 0.052, LAMP_OFF, uv);
        }
        d.lampN = 4;
        break;
      }
      case 'stick2': {
        d.a = pos.clone().addScaledVector(N, 0.02);
        d.b = pos.clone().addScaledVector(N, 0.11);
        d.r = Math.max(def.radius, 0.03);
        S.lathe([[0.047, 0], [0.047, 0.004], [0.044, 0.005], [0.036, 0.011], [0.04, 0.017], [0.03, 0.023], [0.034, 0.029], [0.022, 0.036], [0.013, 0.04]], seg, [STEEL, STEEL, RUBBER, RUBBER, RUBBER, RUBBER, RUBBER, RUBBER], { smooth: true });
        const inner = def.pos.x < (st ? st.faceOrigin.x : def.pos.x) ? 1 : -1;
        placardAt(def.label, inner * 0.09, -0.012, 0.0008, 0.0125);
        part(i, f, () => {
          if (def.role === 'rotation') {
            // a pistol grip: waisted, a red hat switch on top, a trigger guard on the forward side
            M.lathe([[0.008, 0.03], [0.008, 0.05]], seg, METAL);
            M.lathe([[0.01, 0.046], [0.018, 0.052], [0.02, 0.07], [0.0165, 0.088], [0.019, 0.102], [0.021, 0.112], [0.016, 0.121], [0, 0.123]], seg, GRIP, { sy: 1.28, smooth: true });
            M.lathe([[0.007, 0.121], [0.007, 0.127], [0, 0.128]], 8, REDP, { y: 0.004 });
            M.box(0, 0.026, 0.083, 0.004, 0.004, 0.016, STEEL);
          } else {
            // a T-handle: a cross-bar to push and pull
            M.lathe([[0.008, 0.03], [0.008, 0.088]], seg, METAL);
            M.lathe([[0.013, 0.074], [0.016, 0.082], [0.016, 0.1], [0, 0.102]], seg, GRIP, { smooth: true });
            M.bar(-0.04, 0, 0.092, 0.04, 0, 0.092, 0.0125, seg, GRIP);
            for (const sx of [-1, 1]) M.bar(sx * 0.04, 0, 0.092, sx * 0.044, 0, 0.092, 0.014, seg, STEEL);
          }
        }, (x, y, m) => {
          m.makeRotationX(-y * STICK_TILT).multiply(tmp.makeRotationY(x * STICK_TILT));
        });
        break;
      }
      case 'rocker': {
        const alongUp = def.role !== 'roll';
        d.axis = alongUp ? 1 : 0;
        const lx = alongUp ? 0.016 : 0.033;
        const ly = alongUp ? 0.033 : 0.016;
        S.box(0, 0, 0.0015, lx + 0.004, ly + 0.004, 0.0015, BLACK);
        placardAt(def.label, 0, -(ly + 0.016), 0.0008, 0.012);
        part(i, f, () => {
          M.box(0, 0, 0.006, lx - 0.001, ly - 0.001, 0.003, PADDLE);
          for (const s of [-1, 1]) M.box(alongUp ? 0 : s * (lx - 0.006), alongUp ? s * (ly - 0.006) : 0, 0.0105, alongUp ? lx - 0.001 : 0.005, alongUp ? 0.005 : ly - 0.001, 0.0025, PADDLE);
          M.box(0, 0, 0.0092, alongUp ? lx - 0.004 : 0.0012, alongUp ? 0.0012 : ly - 0.004, 0.0004, ORANGE);
        }, alongUp ? (x, _y, m) => m.makeRotationX(-x * 0.2) : (x, _y, m) => m.makeRotationY(x * 0.2));
        break;
      }
      case 'lever': {
        const h = travel / 2;
        d.a = pos.clone().addScaledVector(U, -h).addScaledVector(N, 0.035);
        d.b = pos.clone().addScaledVector(U, h).addScaledVector(N, 0.035);
        d.r = 0.03;
        S.box(0, 0, 0.0015, 0.024, h + 0.02, 0.0015, BEZEL);
        S.box(0, 0, 0.0032, 0.0055, h + 0.006, 0.0003, BLACK);
        for (const s of [-1, 1]) S.box(0, s * (h + 0.011), 0.004, 0.012, 0.003, 0.0025, STEEL);
        eRect(0.037, 0, 0.0008, 0.026, travel + 0.014, [0.5, 0.52, 0.54], atlas.scale);
        placardAt(def.label, 0, h + 0.03, 0.0008, 0.012);
        part(i, f, () => {
          M.box(0, 0, 0.0045, 0.013, 0.011, 0.0012, STEEL);
          M.box(0, 0, 0.022, 0.0035, 0.006, 0.018, METAL);
          M.bar(-0.027, 0, 0.044, 0.027, 0, 0.044, 0.0115, seg, ORANGE);
          for (const sx of [-1, 1]) M.bar(sx * 0.027, 0, 0.044, sx * 0.031, 0, 0.044, 0.0125, seg, DARK);
        }, (x, _y, m) => m.makeTranslation(0, (Math.min(1, Math.max(0, x)) - 0.5) * travel, 0));
        break;
      }
      case 'toggle': {
        const guarded = def.role === 'driveArm';
        const big = guarded ? 1 : 1.5;
        if (guarded) {
          // hazard plate, the switch, a red flip guard hinged above it, and an ARMED lamp below
          S.box(0, 0, 0.001, 0.024, 0.036, 0.001, YELLOW);
          S.box(0, 0, 0.0016, 0.019, 0.031, 0.001, BLACK);
          S.bar(-0.02, GUARD_HINGE, 0.005, 0.02, GUARD_HINGE, 0.005, 0.003, 8, STEEL);
          placardAt(def.label, 0, 0.049, 0.0008, 0.012);
          const uv = atlas.placard.get('ARMED') ?? atlas.white;
          d.lampV = eRect(0, -0.049, 0.0008, 0.013 * (252 / 44), 0.013, LAMP_OFF, uv);
          d.lampN = 4;
          d.lampC = [1.6, 0.3, 0.2];
          part(i, f, () => {
            for (const sx of [-1, 1]) M.box(sx * 0.0155, -0.03, 0.013, 0.0022, 0.03, 0.013, REDP);
            M.box(0, -0.058, 0.013, 0.0177, 0.0022, 0.013, REDP);
            M.box(0, -0.004, 0.024, 0.0177, 0.004, 0.002, REDP);
          }, (x, _y, m) => m.makeTranslation(0, GUARD_HINGE, 0.004).multiply(tmp.makeRotationX(-Math.min(1, Math.max(0, x)) * 1.95)));
        } else {
          S.box(0, 0, 0.0015, 0.03, 0.046, 0.0015, PADDLE);
          for (const sy of [-1, 1]) S.lathe([[0.004, 0.003], [0.004, 0.0042], [0, 0.0046]], 6, STEEL, { y: sy * 0.036 });
          placardAt(def.label, 0, 0.066, 0.0008, 0.018);
          d.lampV = eRect(0, -0.024, 0.0034, 0.016, 0.016, [0.5, 0.3, 0.08], atlas.dot);
          d.lampN = 4;
          d.lampC = [0.5, 0.3, 0.08];
        }
        S.lathe([[0.0085 * big, 0.002], [0.0085 * big, 0.006], [0.006 * big, 0.007]], 6, STEEL);
        part(i, f, () => {
          M.lathe([[0.0032 * big, 0.002], [0.0042 * big, 0.02 * big], [0.0052 * big, 0.026 * big], [0, 0.0275 * big]], 8, METAL, { smooth: true });
        }, (x, _y, m) => m.makeRotationX(-(Math.min(1, Math.max(0, x)) * 2 - 1) * 0.45));
        break;
      }
      case 'handle': {
        S.box(0, 0, 0.001, 0.038, 0.016, 0.001, YELLOW);
        S.box(0, 0, 0.0016, 0.034, 0.012, 0.001, BLACK);
        S.lathe([[0.012, 0.002], [0.012, 0.006], [0.008, 0.008]], seg, STEEL);
        placardAt(def.label, 0, -0.029, 0.0008, 0.0115);
        part(i, f, () => {
          M.lathe([[0.0045, 0.002], [0.0045, 0.026]], 8, METAL);
          M.bar(-0.03, 0, 0.027, 0.03, 0, 0.027, 0.0075, seg, YELLOW);
          for (const sx of [-1, 1]) M.bar(sx * 0.03, 0, 0.027, sx * 0.033, 0, 0.027, 0.0085, seg, DARK);
        }, (x, _y, m) => m.makeTranslation(0, 0, Math.min(1, Math.max(0, x)) * 0.028));
        break;
      }
      case 'buckle': {
        // Worn: a rotary buckle in the pilot's lap with the straps running off it, a green dot when latched.
        // Unfastened it is not drawn: the harness then lies on the seat (the interior's own seat harness),
        // and the touch target is the seat itself (SEAT_OFFSET below the worn buckle).
        d.alt = pos.clone().add(SEAT_OFFSET);
        part(i, f, () => {
          const strap = (ang: number, len: number): void => {
            const rz = new THREE.Matrix4().makeRotationZ(ang);
            M.frame(f.clone().multiply(rz), true, rz);
            M.box(0, 0.026 + len / 2, 0.002, 0.017, len / 2, 0.0015, STRAP);
            M.box(0, 0.032, 0.004, 0.019, 0.007, 0.002, STEEL);
            M.frame(f, true);
          };
          // lap straps to the hips, shoulder straps back toward the pilot (out of sight below the chin)
          strap(Math.PI / 2, 0.2);
          strap(-Math.PI / 2, 0.2);
          strap(Math.PI - 0.42, 0.14);
          strap(Math.PI + 0.42, 0.14);
          M.lathe([[0.029, 0], [0.029, 0.008], [0.025, 0.011], [0.012, 0.012], [0.012, 0.016], [0, 0.0165]], seg, [STEEL, STEEL, STEEL, DARK, DARK]);
        }, (x, _y, m) => m.makeScale(x > 0.5 ? 1 : 0, x > 0.5 ? 1 : 0, x > 0.5 ? 1 : 0));
        d.offC = [0, 0, 0];
        d.lampV = eRect(0, 0, 0.0172, 0.02, 0.02, d.offC, atlas.dot);
        const pl = atlas.placard.get(def.label);
        if (pl) eRect(0, 0.046, 0.0045, 0.011 * (252 / 44), 0.011, d.offC, pl);
        d.lampN = pl ? 8 : 4;
        d.lampC = [0.4, 1.5, 0.6];
        break;
      }
      case 'rest':
        d.rect = true;
        break;
    }
  });

  // two rings that sit under the hands
  E.frame(IDENT);
  const ringV = [E.rect(0, 0, 0, 0, 0, [0.35, 0.75, 1], atlas.ring), E.rect(0, 0, 0, 0, 0, [0.35, 0.75, 1], atlas.ring)];
  const ringOn = [-1, -1];

  const litMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, toneMapped: false });
  const emMat = new THREE.MeshBasicMaterial({ vertexColors: true, map: atlas.tex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const sGeo = S.build(false);
  const mGeo = M.build(true);
  const eGeo = E.build(true);
  const mBase = new Float32Array(M.pos);
  const root = new THREE.Group();
  root.name = 'cockpit';
  const sMesh = new THREE.Mesh(sGeo, litMat);
  const mMesh = new THREE.Mesh(mGeo, litMat);
  const eMesh = new THREE.Mesh(eGeo, emMat);
  eMesh.renderOrder = 2;
  for (const m of [sMesh, mMesh, eMesh]) {
    m.frustumCulled = false;
    root.add(m);
  }
  for (const s of screens) root.add(s.mesh);
  const triangles = (S.idx.length + M.idx.length + E.idx.length) / 3 + screens.length * 2;

  const mPos = mGeo.getAttribute('position') as THREE.BufferAttribute;
  const ePos = eGeo.getAttribute('position') as THREE.BufferAttribute;
  const eCol = eGeo.getAttribute('color') as THREE.BufferAttribute;
  const full = new THREE.Matrix4();
  const loc = new THREE.Matrix4();
  const vt = new THREE.Vector3();
  const idIndex = new Map<string, number>();
  let lastDevices: readonly DeviceView[] | null = null;
  let lightLevel = 1;
  let lastTime = NaN;
  let data: InstrumentData | null = null;

  const view = (devices: readonly DeviceView[], i: number): DeviceView | null => {
    const dv = devices[i];
    if (dv && dv.id === devs[i].def.id) return dv;
    let j = idIndex.get(devs[i].def.id);
    if (j === undefined || !devices[j] || devices[j].id !== devs[i].def.id) {
      j = devices.findIndex((q) => q.id === devs[i].def.id);
      idIndex.set(devs[i].def.id, j);
    }
    return j >= 0 ? devices[j] : null;
  };

  const posePart = (p: Part, x: number, y: number): void => {
    p.lx = x;
    p.ly = y;
    p.move(x, y, loc);
    full.multiplyMatrices(devs[p.dev].frame, loc);
    const arr = mPos.array as Float32Array;
    for (let k = p.v0; k < p.v1; k++) {
      vt.set(mBase[k * 3], mBase[k * 3 + 1], mBase[k * 3 + 2]).applyMatrix4(full);
      arr[k * 3] = vt.x;
      arr[k * 3 + 1] = vt.y;
      arr[k * 3 + 2] = vt.z;
    }
    mPos.needsUpdate = true;
  };
  for (const p of parts) posePart(p, 0, 0);

  const setRing = (slot: number, dev: number, x: number): void => {
    const arr = ePos.array as Float32Array;
    const v0 = ringV[slot];
    if (dev < 0) {
      for (let k = 0; k < 12; k++) arr[v0 * 3 + k] = 0;
    } else {
      const d = devs[dev];
      const s = Math.max(d.r, 0.03) * (d.kind === 'stick2' ? 1.55 : 1.7);
      const lift = d.kind === 'button' ? 0.0125 : 0.0042;
      vt.copy(d.pos).addScaledVector(d.N, lift);
      if (d.kind === 'lever') vt.addScaledVector(d.U, (x - 0.5) * (d.def.travel ?? 0));
      let k = v0 * 3;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        arr[k++] = vt.x + d.R.x * a * s + d.U.x * b * s;
        arr[k++] = vt.y + d.R.y * a * s + d.U.y * b * s;
        arr[k++] = vt.z + d.R.z * a * s + d.U.z * b * s;
      }
    }
    ePos.needsUpdate = true;
  };

  const update = (o: CockpitUpdate): void => {
    const gain = o.gain ?? 1;
    const dt = Number.isFinite(lastTime) ? Math.min(0.25, Math.max(0, o.time - lastTime)) : 1;
    lastTime = o.time;
    lightLevel += ((o.lights ? 1 : 0) - lightLevel) * Math.min(1, dt * 5);
    litMat.color.setScalar(K_LIT * gain * (0.09 + 0.91 * lightLevel));
    emMat.color.setScalar(K_EM * gain);
    for (const m of screenMat) m.color.setScalar(K_SCREEN * gain);
    const devices = o.devices;
    lastDevices = devices.length ? devices : null;
    if (devices.length) {
      for (let k = 0; k < parts.length; k++) {
        const p = parts[k];
        const dv = view(devices, p.dev);
        if (!dv) continue;
        const px = devs[p.dev].kind === 'buckle' ? (dv.lit ? 1 : 0) : dv.x;
        if (!(Math.abs(px - p.lx) < 1e-4 && Math.abs(dv.y - p.ly) < 1e-4)) posePart(p, px, dv.y);
      }
      let h0 = -1;
      let h1 = -1;
      let x0 = 0;
      let x1 = 0;
      for (let i = 0; i < devs.length; i++) {
        const d = devs[i];
        const dv = view(devices, i);
        if (!dv) continue;
        if (d.lampV >= 0 && d.lit !== dv.lit) {
          d.lit = dv.lit;
          const c = dv.lit ? d.lampC : d.offC;
          const arr = eCol.array as Float32Array;
          for (let k = d.lampV; k < d.lampV + d.lampN; k++) {
            arr[k * 3] = c[0];
            arr[k * 3 + 1] = c[1];
            arr[k * 3 + 2] = c[2];
          }
          eCol.needsUpdate = true;
        }
        if (dv.held && !d.rect) {
          if (h0 < 0) {
            h0 = i;
            x0 = dv.x;
          } else if (h1 < 0) {
            h1 = i;
            x1 = dv.x;
          }
        }
      }
      const k0 = h0 < 0 ? -1 : h0 * 1000 + Math.round(x0 * 500);
      const k1 = h1 < 0 ? -1 : h1 * 1000 + Math.round(x1 * 500);
      if (k0 !== ringOn[0]) {
        ringOn[0] = k0;
        setRing(0, h0, x0);
      }
      if (k1 !== ringOn[1]) {
        ringOn[1] = k1;
        setRing(1, h1, x1);
      }
    }
    // the screens: about five pictures a second each, never both in the same frame
    if (o.instruments) data = o.instruments;
    if (data) {
      for (let k = 0; k < screens.length; k++) {
        const s = screens[k];
        const dv = devices.length ? view(devices, s.dev) : null;
        const def = devs[s.dev].def;
        const page = dv && dv.page ? dv.page : (def.pages?.[0] ?? 'flight');
        if (o.time - s.last < 0.2 && page === s.page) continue;
        s.last = o.time + (s.last < -1e8 ? k * 0.1 : 0);
        s.page = page;
        if (page === 'flight') drawFlightScreen(s.ctx, SCREEN_W, SCREEN_H, data.flight);
        else drawNavScreen(s.ctx, SCREEN_W, SCREEN_H, page, data);
        s.tex.needsUpdate = true;
        break;
      }
    }
  };

  // ---- picking
  const po = new THREE.Vector3();
  const pd = new THREE.Vector3();
  const pw = new THREE.Vector3();
  const pu = new THREE.Vector3();
  const ph = new THREE.Vector3();
  const pa = new THREE.Vector3();
  const pb = new THREE.Vector3();
  const out: CockpitPick = { id: '', x: 0, y: 0 };
  const clamp1 = (v: number): number => Math.min(1, Math.max(-1, v));
  /** Hand position on device d for the ray po, pd (into out.x, out.y). */
  const hand = (d: Dev): void => {
    out.x = 0;
    out.y = 0;
    const travel = d.def.travel ?? 0.06;
    if (d.kind === 'stick2') {
      // in the plane through the grip that faces the eye: finger right = stick right, finger up = stick along `up`
      pw.copy(d.pos).addScaledVector(d.N, 0.085);
      const t = pw.clone().sub(po).dot(pd);
      ph.copy(po).addScaledVector(pd, t).sub(pw);
      pa.copy(d.R).addScaledVector(pd, -d.R.dot(pd));
      pb.copy(d.U).addScaledVector(pd, -d.U.dot(pd));
      if (pa.lengthSq() > 1e-6) out.x = clamp1(ph.dot(pa.normalize()) / travel);
      if (pb.lengthSq() > 1e-6) out.y = clamp1(ph.dot(pb.normalize()) / travel);
      return;
    }
    // everything else: where the ray meets the plane the control lives in
    const lift = d.kind === 'lever' ? 0.035 : 0.006;
    pw.copy(d.pos).addScaledVector(d.N, lift);
    const dn = pd.dot(d.N);
    if (Math.abs(dn) < 1e-4) return;
    const t = pw.clone().sub(po).dot(d.N) / dn;
    ph.copy(po).addScaledVector(pd, t).sub(pw);
    const a = ph.dot(d.R);
    const b = ph.dot(d.U);
    if (d.kind === 'lever') out.x = Math.min(1, Math.max(0, 0.5 + b / travel));
    else if (d.kind === 'rocker') {
      const s = d.axis === 1 ? b : a;
      out.x = s > 0.003 ? 1 : s < -0.003 ? -1 : 0;
    } else {
      out.x = clamp1(a / d.hw);
      out.y = clamp1(b / d.hh);
    }
  };
  const pick = (origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, tolerance = 0.03, only?: string): CockpitPick | null => {
    po.set(origin.x, origin.y, origin.z);
    pd.set(dir.x, dir.y, dir.z).normalize();
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < devs.length; i++) {
      const d = devs[i];
      if (only !== undefined) {
        if (d.def.id === only) {
          best = i;
          break;
        }
        continue;
      }
      if (lastDevices) {
        const dv = view(lastDevices, i);
        if (dv && !dv.reachable) continue;
      }
      let score: number;
      if (d.rect) {
        const dn = pd.dot(d.N);
        if (dn > -0.05) continue;
        const t = pw.copy(d.pos).sub(po).dot(d.N) / dn;
        if (t <= 0 || t > (d.kind === 'rest' ? 2.6 : 1.4)) continue;
        ph.copy(po).addScaledVector(pd, t).sub(d.pos);
        const ex = Math.max(0, Math.abs(ph.dot(d.R)) - d.hw);
        const ey = Math.max(0, Math.abs(ph.dot(d.U)) - d.hh);
        const dist = Math.hypot(ex, ey);
        score = dist <= 0 ? -0.2 : dist / Math.max(tolerance * t * 0.5, 0.003);
      } else {
        // closest approach of the ray to the device's touch segment
        const loose = d.alt !== null && d.lit !== true;
        const sa = loose && d.alt ? d.alt : d.a;
        const rad = loose ? SEAT_RADIUS : d.r;
        pu.copy(loose && d.alt ? d.alt : d.b).sub(sa);
        pw.copy(po).sub(sa);
        const B = pd.dot(pu);
        const C = pu.dot(pu);
        const D = pd.dot(pw);
        const Eu = pu.dot(pw);
        const den = C - B * B;
        const s = den > 1e-9 ? Math.min(1, Math.max(0, (Eu - D * B) / den)) : 0;
        const t = s * B - D;
        if (t <= 0.05 || t > (loose ? 2 : 1.4)) continue;
        const dist = ph.copy(pw).addScaledVector(pd, t).addScaledVector(pu, -s).length();
        score = dist <= rad ? dist / rad - 1 : (dist - rad) / Math.max(tolerance * t, 0.004);
      }
      if (score <= 1 && score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) return null;
    out.id = devs[best].def.id;
    hand(devs[best]);
    return out;
  };

  return {
    object3d: root,
    update,
    pick,
    dispose(): void {
      sGeo.dispose();
      mGeo.dispose();
      eGeo.dispose();
      litMat.dispose();
      emMat.dispose();
      atlas.tex.dispose();
      for (const s of screens) {
        s.mesh.geometry.dispose();
        (s.mesh.material as THREE.Material).dispose();
        s.tex.dispose();
      }
      root.removeFromParent();
    },
    drawCalls: 3 + screens.length,
    triangles,
  };
}
