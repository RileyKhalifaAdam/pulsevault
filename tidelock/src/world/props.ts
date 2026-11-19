// Loose objects inside a ship as real rigid bodies (docs/ARCHITECTURE.md §3). Pure TypeScript, deterministic,
// plain-JSON state, no allocation in the stepping loop, never throws from a public function.
//
// Every body lives in the ship's frame (ship-local axes, origin = the craft's centre of mass) and feels what the
// crew body feels (src/world/crew.ts `feltAt`): minus the ship's proper acceleration, plus centrifugal, Coriolis
// and Euler terms; gravity cancels because ship and objects fall together. Rotation is full 6-DOF: each body's
// angular momentum is carried in ship axes (constant in inertial space, so it turns by -Ω×L in the ship's
// frame) and the angular velocity is recovered from it through the body's inertia tensor, so things tumble
// honestly (torque-free precession, the tennis-racket flip) and spin is conserved in free fall.
//
// Collision: against the interior (room faces minus door openings, decks, overheads and solids: the same boxes
// the crew collides with), against each other (broad phase on a hashed grid; sphere / capsule / box narrow
// phase) and against the crew capsule (80 kg, so the pilot pushes things and things push the pilot).
// Sequential-impulse solver with restitution and Coulomb friction, then a linear position projection.
// Bodies sleep when at rest on a surface (or perfectly still in free fall) and wake on contact or when the
// ship's motion changes. Stowed bodies (clip / magnet / strap) are fixed to the ship until the inertial force
// on them (mass × felt acceleration, plus the pull of a hand) exceeds their holding force.
//
// Integration (the session/world code owns the calls, once per frame, ship time):
//   const props = createPropsState('wren');            // or loadPropsState(saved)
//   moveGrab(props, handPointShip, dt);                  // only while something is held
//   stepProps(props, shipMotion, crew, dt);              // shipMotion from craftMotion(), crew from stepCrew()
//   visual.update(propViews(props));
// Call stepProps after stepCrew in the same frame: it applies contact impulses to crew.vel (and nudges
// crew.pos out of objects), which stepCrew integrates next frame.

import type { Quat, V3 } from '../core/types';
import { INTERIORS, type InteriorLayout } from '../data/interiors';
import { PROP_TYPES, PROPS, type PropDef, type PropType } from '../data/props';
import { CREW_EYE, CREW_FRICTION, CREW_HEIGHT, CREW_RADIUS, CREW_RESTITUTION, feltAt, type CrewState, type ShipMotion } from './crew';

/** Mass of the crew body (with clothes and kit), kg. */
export const CREW_MASS = 80;
/** Reach of a hand from the eye, m (arm plus a lean: a standing pilot reaches the 0.7 m lounge table). */
export const ARM_REACH = 1.0;
/** Most a hand can pull or push with, N (a heavy crate follows slowly, a mug at once). */
export const HAND_FORCE = 160;
/** Natural frequency of the hand's grip (critically damped spring), rad/s; holding torque limit, N·m. */
const HAND_OMEGA = 30;
const HAND_ROT = 14;
const HAND_TORQUE = 4;
/** How long a throw pushes for: the largest throw impulse is HAND_FORCE × THROW_TIME. */
const THROW_TIME = 0.15;
/** A hand reaching this far from what it grabbed lets go, m. */
const GRAB_SLIP = 0.6;
/** How far outside an object a hand may be and still grab it, m. */
const GRAB_SLOP = 0.12;

const SUB_DT = 1 / 120;
/**
 * Coasting (felt acceleration below LIGHT_A, nothing in hand, the crew still): contacts are slow, light touches, so
 * the step is set by how far things move (MAX_MOVE) and turn (ROT_STEP rad), at least every COAST_DT, not by 120 Hz.
 */
const LIGHT_A = 0.05;
const COAST_DT = 0.25;
const ROT_STEP = 0.2;
/**
 * Most any point of a body may move in one sub-step, m: less than a 4 cm wall panel, so a contact is always seen;
 * the side it is pushed out of is the side it came from (its position before the sub-step).
 */
const MAX_MOVE = 0.03;
const MAX_SUB = 2400;
const ITER = 7;
const SLOP = 0.0005;
const PROJ = 0.5;
/** Approach speed below which a contact does not bounce, m/s (a steady 12 m/s² adds 0.1 m/s per sub-step). */
const BOUNCE_V = 0.25;
const SLEEP_V = 0.06;
const SLEEP_W = 1.0;
const SLEEP_T = 0.25;
const FLOAT_V = 1e-3;
const FLOAT_W = 5e-3;
const WAKE_V = 0.05;
const WAKE_DA = 0.02;
const WAKE_DW = 1e-4;
const WALL = 0.02;
const MAX_CONTACTS = 2048;
const GRID_B = 256;
/** Cell of the static-box grid, m. */
const SCELL = 1.0;

// ------------------------------------------------------------------------------------------------ state

export interface PropBody {
  id: string;
  /** Centre of mass and its velocity relative to the ship, ship axes, m and m/s. */
  p: V3;
  v: V3;
  /** Orientation (object axes → ship axes) and angular velocity relative to the ship, ship axes, rad/s. */
  q: Quat;
  w: V3;
  /** Still held by its clip / magnet / strap. */
  stowed: boolean;
  asleep: boolean;
  /** Seconds it has spent nearly still. */
  still: number;
}

export interface PropGrab {
  /** Held body ('' = nothing held). */
  id: string;
  /** Grip point in the body's own axes, relative to its centre of mass. */
  local: V3;
  /** Hand target and its velocity, ship axes. */
  hand: V3;
  handVel: V3;
  /** Eye of the crew body, refreshed by stepProps; the hand stays within ARM_REACH of it. */
  eye: V3;
}

export interface PropsState {
  layoutId: string;
  /** Ship time simulated, s. */
  t: number;
  bodies: PropBody[];
  grab: PropGrab;
  /** The ship's motion at the last sub-step (to wake sleepers when it changes). */
  lastA: V3;
  lastW: V3;
}

/** What the renderer needs per object. Reused objects: read, do not keep. */
export interface PropView {
  id: string;
  type: PropType;
  pos: V3;
  quat: Quat;
  /** Room the centre is in ('' in a doorway outside every room box). */
  room: string;
  stowed: boolean;
  asleep: boolean;
  grabbed: boolean;
}

// ------------------------------------------------------------------------------------------------ layouts

interface Rt {
  layout: InteriorLayout;
  defs: PropDef[];
  types: PropType[];
  n: number;
  index: Map<string, number>;
  /** Static boxes: minX, minY, minZ, maxX, maxY, maxZ. */
  sb: Float64Array;
  ns: number;
  /** Rooms then doors (the volume a centre must stay in). */
  vol: Float64Array;
  nv: number;
  rmax: number;
  cell: number;
  /** Static boxes bucketed on a grid: origin, cell counts, CSR lists, a stamp per box for de-duplication. */
  sg0: Float64Array;
  sgn: Int32Array;
  sgStart: Int32Array;
  sgItems: Int32Array;
  sgStamp: Int32Array;
  sgTick: number;
  /** 0 sphere, 1 capsule, 2 box; dims (r, halfLen, 0) or (hx, hy, hz). */
  kind: Int8Array;
  dim: Float64Array;
  bound: Float64Array;
  mass: Float64Array;
  invMass: Float64Array;
  Ib: Float64Array;
  invIb: Float64Array;
  e: Float64Array;
  mu: Float64Array;
  hold: Float64Array;
  // scratch, per slot (bodies 0..n-1, crew = n)
  pp: Float64Array;
  im: Float64Array;
  Iw: Float64Array;
  R: Float64Array;
  vw: Float64Array;
  prev: Float64Array;
  prevOk: Uint8Array;
  fm: Float64Array;
  spd: Float64Array;
  cnt: Int32Array;
  dyn: Uint8Array;
  prim: Uint8Array;
  head: Int32Array;
  next: Int32Array;
  stamp: Int32Array;
}

const registry = new Map<string, { layout: InteriorLayout; defs: PropDef[] }>();
const runtimes = new Map<string, Rt>();

/** Register (or replace) a layout and its objects under an id, e.g. for a test room. Built-ins: 'wren'. */
export function definePropsLayout(id: string, layout: InteriorLayout, defs: PropDef[]): void {
  registry.set(id, { layout, defs });
  runtimes.delete(id);
}

function staticBoxes(layout: InteriorLayout): number[] {
  // Same boxes the crew collides with (src/world/crew.ts): solids, decks, overheads, wall panels minus doors.
  const list: number[] = [];
  const add = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void => {
    if (x1 - x0 > 1e-9 && y1 - y0 > 1e-9 && z1 - z0 > 1e-9) list.push(x0, y0, z0, x1, y1, z1);
  };
  for (const s of layout.solids) add(s.box.min.x, s.box.min.y, s.box.min.z, s.box.max.x, s.box.max.y, s.box.max.z);
  for (const r of layout.rooms) {
    const lo = r.box.min, hi = r.box.max;
    add(lo.x, lo.y - 0.5, lo.z, hi.x, lo.y, hi.z);
    add(lo.x, hi.y, lo.z, hi.x, hi.y + 0.5, hi.z);
    for (let f = 0; f < 4; f++) {
      const alongX = f >= 2;
      const at = f === 0 ? lo.x : f === 1 ? hi.x : f === 2 ? lo.z : hi.z;
      const s0 = alongX ? lo.x : lo.z, s1 = alongX ? hi.x : hi.z;
      const holes: { a: number; b: number; y0: number; y1: number }[] = [];
      for (const d of layout.doors) {
        if (d.a !== r.id && d.b !== r.id) continue;
        const dl = d.box.min, dh = d.box.max;
        const crosses = alongX ? dl.z < at && dh.z > at : dl.x < at && dh.x > at;
        const a = Math.max(s0, alongX ? dl.x : dl.z), b = Math.min(s1, alongX ? dh.x : dh.z);
        if (crosses && b > a) holes.push({ a, b, y0: dl.y, y1: dh.y });
      }
      holes.sort((p, q) => p.a - q.a);
      const panel = (a: number, b: number, y0: number, y1: number): void => {
        if (alongX) add(a, y0, at - WALL, b, y1, at + WALL);
        else add(at - WALL, y0, a, at + WALL, y1, b);
      };
      let from = s0;
      for (const hole of holes) {
        panel(from, hole.a, lo.y, hi.y);
        panel(hole.a, hole.b, lo.y, hole.y0);
        panel(hole.a, hole.b, hole.y1, hi.y);
        from = Math.max(from, hole.b);
      }
      panel(from, s1, lo.y, hi.y);
    }
  }
  return list;
}

function runtime(id: string): Rt | null {
  const have = runtimes.get(id);
  if (have) return have;
  let src = registry.get(id);
  if (!src) {
    const layout = INTERIORS[id as keyof typeof INTERIORS], defs = PROPS[id as keyof typeof PROPS];
    if (!layout || !defs) return null;
    src = { layout, defs };
  }
  const { layout, defs } = src;
  const n = defs.length;
  const sbl = staticBoxes(layout);
  const vl: number[] = [];
  let rmax = 1;
  for (const b of [...layout.rooms.map((r) => r.box), ...layout.doors.map((d) => d.box)]) {
    vl.push(b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z);
    rmax = Math.max(rmax, Math.hypot(Math.max(-b.min.x, b.max.x), Math.max(-b.min.y, b.max.y), Math.max(-b.min.z, b.max.z)));
  }
  const rt: Rt = {
    layout, defs, types: defs.map((d) => d.type), n, index: new Map(defs.map((d, i) => [d.id, i])),
    sb: Float64Array.from(sbl), ns: sbl.length / 6, vol: Float64Array.from(vl), nv: vl.length / 6, rmax, cell: 0.5,
    sg0: new Float64Array(3), sgn: new Int32Array(3), sgStart: new Int32Array(1), sgItems: new Int32Array(0), sgStamp: new Int32Array(sbl.length / 6), sgTick: 0,
    kind: new Int8Array(n), dim: new Float64Array(3 * n), bound: new Float64Array(n), mass: new Float64Array(n),
    invMass: new Float64Array(n), Ib: new Float64Array(3 * n), invIb: new Float64Array(3 * n), e: new Float64Array(n),
    mu: new Float64Array(n), hold: new Float64Array(n),
    pp: new Float64Array(3 * (n + 1)), im: new Float64Array(n + 1), Iw: new Float64Array(9 * (n + 1)), R: new Float64Array(9 * n),
    vw: new Float64Array(6 * (n + 1)), prev: new Float64Array(7 * n), prevOk: new Uint8Array(n), fm: new Float64Array(n), spd: new Float64Array(n), cnt: new Int32Array(n + 1),
    dyn: new Uint8Array(n), prim: new Uint8Array(n), head: new Int32Array(GRID_B), next: new Int32Array(n), stamp: new Int32Array(n),
  };
  let maxB = 0;
  for (let i = 0; i < n; i++) {
    const d = defs[i], t = PROP_TYPES[d.type], sh = t.shape, m = t.mass;
    let I0: number, I1: number, I2: number;
    if (sh.kind === 'sphere') {
      rt.kind[i] = 0; rt.dim[3 * i] = sh.r; rt.bound[i] = sh.r;
      I0 = I1 = I2 = 0.4 * m * sh.r * sh.r;
    } else if (sh.kind === 'capsule') {
      const r = sh.r, h = sh.halfLen, L = 2 * h;
      rt.kind[i] = 1; rt.dim[3 * i] = r; rt.dim[3 * i + 1] = h; rt.bound[i] = r + h;
      const vc = Math.PI * r * r * L, vs = (4 / 3) * Math.PI * r * r * r;
      const mc = (m * vc) / (vc + vs), ms = m - mc;
      I1 = mc * r * r * 0.5 + ms * 0.4 * r * r;
      I0 = I2 = mc * (L * L / 12 + r * r / 4) + ms * (0.4 * r * r + L * L / 4 + (3 * L * r) / 8);
    } else {
      const hx = sh.half.x, hy = sh.half.y, hz = sh.half.z;
      rt.kind[i] = 2; rt.dim[3 * i] = hx; rt.dim[3 * i + 1] = hy; rt.dim[3 * i + 2] = hz; rt.bound[i] = Math.hypot(hx, hy, hz);
      I0 = (m / 3) * (hy * hy + hz * hz); I1 = (m / 3) * (hx * hx + hz * hz); I2 = (m / 3) * (hx * hx + hy * hy);
    }
    rt.mass[i] = m; rt.invMass[i] = 1 / m;
    rt.Ib[3 * i] = I0; rt.Ib[3 * i + 1] = I1; rt.Ib[3 * i + 2] = I2;
    rt.invIb[3 * i] = 1 / I0; rt.invIb[3 * i + 1] = 1 / I1; rt.invIb[3 * i + 2] = 1 / I2;
    rt.e[i] = t.restitution; rt.mu[i] = t.friction; rt.hold[i] = d.stow === 'loose' ? 0 : Math.max(0, d.holdN);
    maxB = Math.max(maxB, rt.bound[i]);
  }
  rt.cell = Math.max(0.5, 2 * maxB + 0.05);
  // static grid
  const sb = rt.sb, ns = rt.ns, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < ns; k++) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], sb[6 * k + c]); hi[c] = Math.max(hi[c], sb[6 * k + 3 + c]); }
  if (ns === 0) { lo[0] = lo[1] = lo[2] = 0; hi[0] = hi[1] = hi[2] = 1; }
  for (let c = 0; c < 3; c++) { rt.sg0[c] = lo[c]; rt.sgn[c] = Math.max(1, Math.ceil((hi[c] - lo[c]) / SCELL)); }
  const ncell = rt.sgn[0] * rt.sgn[1] * rt.sgn[2], lists: number[][] = [];
  for (let c = 0; c < ncell; c++) lists.push([]);
  for (let k = 0; k < ns; k++) {
    const r0 = cellRange(rt, sb[6 * k], sb[6 * k + 3], 0), r1 = cellRange(rt, sb[6 * k + 1], sb[6 * k + 4], 1), r2 = cellRange(rt, sb[6 * k + 2], sb[6 * k + 5], 2);
    for (let x = r0[0]; x <= r0[1]; x++) for (let y = r1[0]; y <= r1[1]; y++) for (let z = r2[0]; z <= r2[1]; z++) lists[(x * rt.sgn[1] + y) * rt.sgn[2] + z].push(k);
  }
  rt.sgStart = new Int32Array(ncell + 1);
  for (let c = 0; c < ncell; c++) rt.sgStart[c + 1] = rt.sgStart[c] + lists[c].length;
  rt.sgItems = Int32Array.from(lists.flat());
  runtimes.set(id, rt);
  return rt;
}

function cellRange(rt: Rt, a: number, b: number, c: number): [number, number] {
  const n = rt.sgn[c], o = rt.sg0[c];
  return [Math.max(0, Math.min(n - 1, Math.floor((a - o) / SCELL))), Math.max(0, Math.min(n - 1, Math.floor((b - o) / SCELL)))];
}
const cellOf = (rt: Rt, x: number, c: number): number => {
  const n = rt.sgn[c], i = Math.floor((x - rt.sg0[c]) / SCELL);
  return i < 0 ? 0 : i >= n ? n - 1 : i;
};

const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });

/** A fresh state for a layout with its objects at their start poses, or null for an unknown layout. */
export function createPropsState(layoutId: string): PropsState | null {
  try {
    const rt = runtime(layoutId);
    if (!rt) return null;
    return {
      layoutId, t: 0,
      bodies: rt.defs.map((d) => {
        const q = d.rot, l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
        return {
          id: d.id, p: v3(d.pos.x, d.pos.y, d.pos.z), v: v3(), q: { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l }, w: v3(),
          stowed: d.stow !== 'loose', asleep: true, still: 0,
        };
      }),
      grab: { id: '', local: v3(), hand: v3(), handVel: v3(), eye: v3() },
      lastA: v3(), lastW: v3(),
    };
  } catch {
    return null;
  }
}

/** A plain-JSON copy of the state (JSON.stringify of it round-trips exactly). */
export function savePropsState(s: PropsState): PropsState | null {
  try {
    return JSON.parse(JSON.stringify(s)) as PropsState;
  } catch {
    return null;
  }
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isV3 = (x: unknown): boolean => !!x && typeof x === 'object' && isNum((x as V3).x) && isNum((x as V3).y) && isNum((x as V3).z);

/** Rebuild a state from savePropsState() output (or its JSON text); null if it does not fit its layout. */
export function loadPropsState(data: unknown): PropsState | null {
  try {
    const s = (typeof data === 'string' ? JSON.parse(data) : JSON.parse(JSON.stringify(data))) as PropsState;
    if (!s || typeof s.layoutId !== 'string' || !isNum(s.t) || !Array.isArray(s.bodies)) return null;
    const rt = runtime(s.layoutId);
    if (!rt || s.bodies.length !== rt.n) return null;
    for (let i = 0; i < rt.n; i++) {
      const b = s.bodies[i];
      if (!b || b.id !== rt.defs[i].id || !isV3(b.p) || !isV3(b.v) || !isV3(b.w) || !b.q || !isNum(b.q.w) || !isV3(b.q)) return null;
      b.stowed = !!b.stowed; b.asleep = !!b.asleep; b.still = isNum(b.still) ? b.still : 0;
    }
    const g = s.grab;
    if (!g || typeof g.id !== 'string' || !isV3(g.local) || !isV3(g.hand) || !isV3(g.handVel) || !isV3(g.eye)) {
      s.grab = { id: '', local: v3(), hand: v3(), handVel: v3(), eye: v3() };
    } else if (g.id !== '' && !rt.index.has(g.id)) g.id = '';
    if (!isV3(s.lastA)) s.lastA = v3();
    if (!isV3(s.lastW)) s.lastW = v3();
    return s;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------ small math

/** Rotation matrix (row-major) of q into R at o. */
function quatToR(R: Float64Array, o: number, q: Quat): void {
  const x = q.x, y = q.y, z = q.z, w = q.w;
  R[o] = 1 - 2 * (y * y + z * z); R[o + 1] = 2 * (x * y - z * w); R[o + 2] = 2 * (x * z + y * w);
  R[o + 3] = 2 * (x * y + z * w); R[o + 4] = 1 - 2 * (x * x + z * z); R[o + 5] = 2 * (y * z - x * w);
  R[o + 6] = 2 * (x * z - y * w); R[o + 7] = 2 * (y * z + x * w); R[o + 8] = 1 - 2 * (x * x + y * y);
}

/** out(9 at oo) = R diag(d) Rᵀ. */
function rDiagRt(R: Float64Array, o: number, d0: number, d1: number, d2: number, out: Float64Array, oo: number): void {
  for (let i = 0; i < 3; i++) {
    const a0 = R[o + 3 * i], a1 = R[o + 3 * i + 1], a2 = R[o + 3 * i + 2];
    for (let j = 0; j < 3; j++) out[oo + 3 * i + j] = a0 * d0 * R[o + 3 * j] + a1 * d1 * R[o + 3 * j + 1] + a2 * d2 * R[o + 3 * j + 2];
  }
}

let tx = 0, ty = 0, tz = 0;
/** (tx,ty,tz) = R diag(d) Rᵀ · (x,y,z). */
function rdrt(R: Float64Array, o: number, d0: number, d1: number, d2: number, x: number, y: number, z: number): void {
  const bx = (R[o] * x + R[o + 3] * y + R[o + 6] * z) * d0;
  const by = (R[o + 1] * x + R[o + 4] * y + R[o + 7] * z) * d1;
  const bz = (R[o + 2] * x + R[o + 5] * y + R[o + 8] * z) * d2;
  tx = R[o] * bx + R[o + 1] * by + R[o + 2] * bz;
  ty = R[o + 3] * bx + R[o + 4] * by + R[o + 5] * bz;
  tz = R[o + 6] * bx + R[o + 7] * by + R[o + 8] * bz;
}

// ------------------------------------------------------------------------------------------------ contacts

// per contact: n(3) ra(3) rb(3) pen e mu kN t1(3) t2(3) kT1 kT2 target λn λt1 λt2   (point kept in ra until prep)
const CS = 25;
const cf = new Float64Array(MAX_CONTACTS * CS);
const ci = new Int32Array(MAX_CONTACTS * 2);
let nc = 0;
let curE = 0, curMu = 0;

function addC(a: number, b: number, nx: number, ny: number, nz: number, px: number, py: number, pz: number, pen: number): void {
  if (nc >= MAX_CONTACTS || !(pen > 0)) return;
  const k = nc * CS;
  ci[2 * nc] = a; ci[2 * nc + 1] = b;
  cf[k] = nx; cf[k + 1] = ny; cf[k + 2] = nz; cf[k + 3] = px; cf[k + 4] = py; cf[k + 5] = pz;
  cf[k + 9] = pen; cf[k + 10] = curE; cf[k + 11] = curMu;
  nc++;
}

/** Offset of a body from where it was one sub-step ago (to tell which side of a thin wall it came from). */
let mvx = 0, mvy = 0, mvz = 0;

/** Sphere (or point, r = 0) of slot a against a static box: pushes a out (through the side it came from). */
function sphereAabb(a: number, cx: number, cy: number, cz: number, r: number, sb: Float64Array, k: number): void {
  const x0 = sb[k], y0 = sb[k + 1], z0 = sb[k + 2], x1 = sb[k + 3], y1 = sb[k + 4], z1 = sb[k + 5];
  if (cx < x0 - r || cx > x1 + r || cy < y0 - r || cy > y1 + r || cz < z0 - r || cz > z1 + r) return;
  const qx = cx < x0 ? x0 : cx > x1 ? x1 : cx, qy = cy < y0 ? y0 : cy > y1 ? y1 : cy, qz = cz < z0 ? z0 : cz > z1 ? z1 : cz;
  const dx = cx - qx, dy = cy - qy, dz = cz - qz, d2 = dx * dx + dy * dy + dz * dz;
  if (d2 > r * r) return;
  if (d2 > 1e-16) {
    const d = Math.sqrt(d2);
    addC(a, -1, dx / d, dy / d, dz / d, qx, qy, qz, r - d);
    return;
  }
  const l = cx - x0, rr = x1 - cx, bo = cy - y0, tp = y1 - cy, f = cz - z0, bk = z1 - cz;
  // the face it came in through, if its centre was outside one sub-step ago; else the nearest face
  const sx = cx - mvx, sy = cy - mvy, sz = cz - mvz;
  let o = 0, face = -1;
  if (x0 - sx > o) { o = x0 - sx; face = 0; }
  if (sx - x1 > o) { o = sx - x1; face = 1; }
  if (y0 - sy > o) { o = y0 - sy; face = 2; }
  if (sy - y1 > o) { o = sy - y1; face = 3; }
  if (z0 - sz > o) { o = z0 - sz; face = 4; }
  if (sz - z1 > o) { o = sz - z1; face = 5; }
  let m = l, nx = -1, ny = 0, nz = 0;
  if (face < 0) {
    if (rr < m) { m = rr; nx = 1; }
    if (bo < m) { m = bo; nx = 0; ny = -1; }
    if (tp < m) { m = tp; nx = 0; ny = 1; }
    if (f < m) { m = f; nx = ny = 0; nz = -1; }
    if (bk < m) { m = bk; nx = ny = 0; nz = 1; }
  } else if (face === 1) { m = rr; nx = 1; }
  else if (face === 2) { m = bo; nx = 0; ny = -1; }
  else if (face === 3) { m = tp; nx = 0; ny = 1; }
  else if (face === 4) { m = f; nx = 0; nz = -1; }
  else if (face === 5) { m = bk; nx = 0; nz = 1; }
  addC(a, -1, nx, ny, nz, cx, cy, cz, r + m);
}

/** Sphere (or point) of slot a against the box of body j: pushes a away from j. */
function sphereObb(rt: Rt, a: number, cx: number, cy: number, cz: number, r: number, j: number): void {
  const R = rt.R, o = 9 * j, pp = rt.pp, dim = rt.dim;
  const hx = dim[3 * j], hy = dim[3 * j + 1], hz = dim[3 * j + 2];
  const dx = cx - pp[3 * j], dy = cy - pp[3 * j + 1], dz = cz - pp[3 * j + 2];
  const lx = R[o] * dx + R[o + 3] * dy + R[o + 6] * dz, ly = R[o + 1] * dx + R[o + 4] * dy + R[o + 7] * dz, lz = R[o + 2] * dx + R[o + 5] * dy + R[o + 8] * dz;
  if (lx < -hx - r || lx > hx + r || ly < -hy - r || ly > hy + r || lz < -hz - r || lz > hz + r) return;
  const qx = lx < -hx ? -hx : lx > hx ? hx : lx, qy = ly < -hy ? -hy : ly > hy ? hy : ly, qz = lz < -hz ? -hz : lz > hz ? hz : lz;
  let ex = lx - qx, ey = ly - qy, ez = lz - qz, pen: number;
  const d2 = ex * ex + ey * ey + ez * ez;
  if (d2 > r * r) return;
  if (d2 > 1e-16) {
    const d = Math.sqrt(d2);
    ex /= d; ey /= d; ez /= d; pen = r - d;
  } else {
    const fx = hx - Math.abs(lx), fy = hy - Math.abs(ly), fz = hz - Math.abs(lz);
    ex = ey = ez = 0;
    if (fx <= fy && fx <= fz) { ex = lx < 0 ? -1 : 1; pen = r + fx; }
    else if (fy <= fz) { ey = ly < 0 ? -1 : 1; pen = r + fy; }
    else { ez = lz < 0 ? -1 : 1; pen = r + fz; }
  }
  const nx = R[o] * ex + R[o + 1] * ey + R[o + 2] * ez, ny = R[o + 3] * ex + R[o + 4] * ey + R[o + 5] * ez, nz = R[o + 6] * ex + R[o + 7] * ey + R[o + 8] * ez;
  const px = pp[3 * j] + R[o] * qx + R[o + 1] * qy + R[o + 2] * qz;
  const py = pp[3 * j + 1] + R[o + 3] * qx + R[o + 4] * qy + R[o + 5] * qz;
  const pz = pp[3 * j + 2] + R[o + 6] * qx + R[o + 7] * qy + R[o + 8] * qz;
  addC(a, j, nx, ny, nz, px, py, pz, pen);
}

// segments: [0..5] first, [6..11] second; corners [0..23]
const seg = new Float64Array(12);
const cor = new Float64Array(24);
let segS = 0, segT = 0;

function segOf(rt: Rt, i: number, at: number): void {
  const pp = rt.pp, R = rt.R, o = 9 * i, h = rt.kind[i] === 1 ? rt.dim[3 * i + 1] : 0;
  const ax = R[o + 1] * h, ay = R[o + 4] * h, az = R[o + 7] * h;
  seg[at] = pp[3 * i] - ax; seg[at + 1] = pp[3 * i + 1] - ay; seg[at + 2] = pp[3 * i + 2] - az;
  seg[at + 3] = pp[3 * i] + ax; seg[at + 4] = pp[3 * i + 1] + ay; seg[at + 5] = pp[3 * i + 2] + az;
}

function cornersOf(rt: Rt, i: number): void {
  const pp = rt.pp, R = rt.R, o = 9 * i, hx = rt.dim[3 * i], hy = rt.dim[3 * i + 1], hz = rt.dim[3 * i + 2];
  for (let s = 0; s < 8; s++) {
    const x = s & 1 ? hx : -hx, y = s & 2 ? hy : -hy, z = s & 4 ? hz : -hz;
    cor[3 * s] = pp[3 * i] + R[o] * x + R[o + 1] * y + R[o + 2] * z;
    cor[3 * s + 1] = pp[3 * i + 1] + R[o + 3] * x + R[o + 4] * y + R[o + 5] * z;
    cor[3 * s + 2] = pp[3 * i + 2] + R[o + 6] * x + R[o + 7] * y + R[o + 8] * z;
  }
}

const cl01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Closest points of seg[0..5] and seg[6..11]: parameters into segS, segT (Ericson, RTCD 5.1.9). */
function segSeg(): void {
  const d1x = seg[3] - seg[0], d1y = seg[4] - seg[1], d1z = seg[5] - seg[2];
  const d2x = seg[9] - seg[6], d2y = seg[10] - seg[7], d2z = seg[11] - seg[8];
  const rx = seg[0] - seg[6], ry = seg[1] - seg[7], rz = seg[2] - seg[8];
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
  let s = 0, t = 0;
  if (a <= 1e-12 && e <= 1e-12) { s = t = 0; }
  else if (a <= 1e-12) { s = 0; t = cl01(f / e); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-12) { t = 0; s = cl01(-c / a); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z, den = a * e - b * b;
      s = den > 1e-12 ? cl01((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = cl01(-c / a); }
      else if (t > 1) { t = 1; s = cl01((b - c) / a); }
    }
  }
  segS = s; segT = t;
}

/** Contact between the segment-swept spheres seg[0..5] (slot a, ra) and seg[6..11] (slot b, rb). */
function segContact(a: number, ra: number, b: number, rb: number): void {
  segSeg();
  const s = segS, t = segT;
  const c1x = seg[0] + (seg[3] - seg[0]) * s, c1y = seg[1] + (seg[4] - seg[1]) * s, c1z = seg[2] + (seg[5] - seg[2]) * s;
  const c2x = seg[6] + (seg[9] - seg[6]) * t, c2y = seg[7] + (seg[10] - seg[7]) * t, c2z = seg[8] + (seg[11] - seg[8]) * t;
  let nx = c1x - c2x, ny = c1y - c2y, nz = c1z - c2z;
  const d2 = nx * nx + ny * ny + nz * nz, rs = ra + rb;
  if (d2 >= rs * rs) return;
  const d = Math.sqrt(d2);
  if (d > 1e-9) { nx /= d; ny /= d; nz /= d; } else { nx = 0; ny = 1; nz = 0; }
  const pen = rs - d, m = rb - pen * 0.5;
  addC(a, b, nx, ny, nz, c2x + nx * m, c2y + ny * m, c2z + nz * m, pen);
}

// boxes for the SAT test: centre (0..2), rotation row-major (3..11; column k is axis k), half extents (12..14)
const BA = new Float64Array(15);
const BB = new Float64Array(15);
const P0 = new Float64Array(24);
const P1 = new Float64Array(24);
const SAT_C = new Float64Array(9);
const SAT_AC = new Float64Array(9);

function loadBodyBox(rt: Rt, i: number, X: Float64Array): void {
  X[0] = rt.pp[3 * i]; X[1] = rt.pp[3 * i + 1]; X[2] = rt.pp[3 * i + 2];
  for (let k = 0; k < 9; k++) X[3 + k] = rt.R[9 * i + k];
  X[12] = rt.dim[3 * i]; X[13] = rt.dim[3 * i + 1]; X[14] = rt.dim[3 * i + 2];
}

function loadStaticBox(sb: Float64Array, k: number, X: Float64Array): void {
  X[0] = (sb[k] + sb[k + 3]) * 0.5; X[1] = (sb[k + 1] + sb[k + 4]) * 0.5; X[2] = (sb[k + 2] + sb[k + 5]) * 0.5;
  X[3] = 1; X[4] = 0; X[5] = 0; X[6] = 0; X[7] = 1; X[8] = 0; X[9] = 0; X[10] = 0; X[11] = 1;
  X[12] = (sb[k + 3] - sb[k]) * 0.5; X[13] = (sb[k + 4] - sb[k + 1]) * 0.5; X[14] = (sb[k + 5] - sb[k + 2]) * 0.5;
}

/** Axis k of box X, dotted with (x, y, z). */
const axd = (X: Float64Array, k: number, x: number, y: number, z: number): number => X[3 + k] * x + X[6 + k] * y + X[9 + k] * z;

/**
 * Contacts of the incident box Y's face against the reference face (axis k, outward normal nR) of box X:
 * Y's most opposed face, clipped to the side planes of X's face; points below X's face become contacts.
 * `sg` = +1 when slot a owns Y (pushed along nR), -1 when slot a owns X (pushed along -nR).
 */
function clipFace(a: number, b: number, X: Float64Array, k: number, nx: number, ny: number, nz: number, Y: Float64Array, sg: number): void {
  let m = 0, best = -1;
  for (let j = 0; j < 3; j++) { const d = Math.abs(axd(Y, j, nx, ny, nz)); if (d > best) { best = d; m = j; } }
  const s = axd(Y, m, nx, ny, nz) > 0 ? -1 : 1, em = Y[12 + m] * s;
  const u = (m + 1) % 3, w = (m + 2) % 3, eu = Y[12 + u], ew = Y[12 + w];
  const fx = Y[0] + Y[3 + m] * em, fy = Y[1] + Y[6 + m] * em, fz = Y[2] + Y[9 + m] * em;
  for (let c = 0; c < 4; c++) {
    const su = c === 0 || c === 3 ? eu : -eu, sw = c < 2 ? ew : -ew;
    P0[3 * c] = fx + Y[3 + u] * su + Y[3 + w] * sw;
    P0[3 * c + 1] = fy + Y[6 + u] * su + Y[6 + w] * sw;
    P0[3 * c + 2] = fz + Y[9 + u] * su + Y[9 + w] * sw;
  }
  let cnt = 4, src = P0, dst = P1;
  for (let pl = 0; pl < 4 && cnt > 0; pl++) {
    const ax = (k + 1 + (pl >> 1)) % 3, sgn = pl & 1 ? -1 : 1;
    const dx = X[3 + ax] * sgn, dy = X[6 + ax] * sgn, dz = X[9 + ax] * sgn;
    const off = dx * X[0] + dy * X[1] + dz * X[2] + X[12 + ax];
    let out = 0;
    for (let c = 0; c < cnt; c++) {
      const c2 = c + 1 === cnt ? 0 : c + 1;
      const px = src[3 * c], py = src[3 * c + 1], pz = src[3 * c + 2], qx = src[3 * c2], qy = src[3 * c2 + 1], qz = src[3 * c2 + 2];
      const dp = dx * px + dy * py + dz * pz - off, dq = dx * qx + dy * qy + dz * qz - off;
      if (dp <= 0 && out < 8) { dst[3 * out] = px; dst[3 * out + 1] = py; dst[3 * out + 2] = pz; out++; }
      if (dp * dq < 0 && out < 8) {
        const t = dp / (dp - dq);
        dst[3 * out] = px + (qx - px) * t; dst[3 * out + 1] = py + (qy - py) * t; dst[3 * out + 2] = pz + (qz - pz) * t; out++;
      }
    }
    cnt = out;
    const tmp = src; src = dst; dst = tmp;
  }
  const plane = nx * X[0] + ny * X[1] + nz * X[2] + X[12 + k];
  for (let c = 0; c < cnt; c++) {
    const px = src[3 * c], py = src[3 * c + 1], pz = src[3 * c + 2];
    const d = plane - (nx * px + ny * py + nz * pz);
    if (d > 0) addC(a, b, nx * sg, ny * sg, nz * sg, px + nx * d * 0.5, py + ny * d * 0.5, pz + nz * d * 0.5, d);
  }
}

/** Box BA (slot a) against box BB (slot b, or a static box when b = -1): separating-axis test, then contacts. */
function boxBox(a: number, b: number): void {
  const A = BA, B = BB;
  const tx = B[0] - A[0], ty = B[1] - A[1], tz = B[2] - A[2];
  // which way to push: from where A was a sub-step ago when B is static (a thin wall is never crossed)
  const ux = b < 0 ? tx + mvx : tx, uy = b < 0 ? ty + mvy : ty, uz = b < 0 ? tz + mvz : tz;
  // C[i][j] = a_i · b_j; separating axes: A's faces, B's faces, the nine edge pairs (Gottschalk's OBB test)
  const C = SAT_C, AC = SAT_AC;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const c = A[3 + i] * B[3 + j] + A[6 + i] * B[6 + j] + A[9 + i] * B[9 + j];
    C[3 * i + j] = c; AC[3 * i + j] = Math.abs(c) + 1e-9;
  }
  const ta0 = axd(A, 0, tx, ty, tz), ta1 = axd(A, 1, tx, ty, tz), ta2 = axd(A, 2, tx, ty, tz);
  const ea0 = A[12], ea1 = A[13], ea2 = A[14], eb0 = B[12], eb1 = B[13], eb2 = B[14];
  let best = Infinity, kind = -1, ai = 0, bj = 0;
  for (let i = 0; i < 3; i++) {
    const ov = A[12 + i] + eb0 * AC[3 * i] + eb1 * AC[3 * i + 1] + eb2 * AC[3 * i + 2] - Math.abs(i === 0 ? ta0 : i === 1 ? ta1 : ta2);
    if (ov < 0) return;
    if (ov < best) { best = ov; kind = 0; ai = i; }
  }
  for (let j = 0; j < 3; j++) {
    const tb = C[j] * ta0 + C[3 + j] * ta1 + C[6 + j] * ta2;
    const ov = B[12 + j] + ea0 * AC[j] + ea1 * AC[3 + j] + ea2 * AC[6 + j] - Math.abs(tb);
    if (ov < 0) return;
    if (ov < best * 0.98 - 1e-5) { best = ov; kind = 1; bj = j; }
  }
  for (let i = 0; i < 3; i++) {
    const i1 = (i + 1) % 3, i2 = (i + 2) % 3, ti1 = i1 === 0 ? ta0 : i1 === 1 ? ta1 : ta2, ti2 = i2 === 0 ? ta0 : i2 === 1 ? ta1 : ta2;
    for (let j = 0; j < 3; j++) {
      const cij = C[3 * i + j], l2 = 1 - cij * cij;
      if (l2 < 1e-6) continue;
      const j1 = (j + 1) % 3, j2 = (j + 2) % 3;
      const ra = A[12 + i1] * AC[3 * i2 + j] + A[12 + i2] * AC[3 * i1 + j];
      const rb = B[12 + j1] * AC[3 * i + j2] + B[12 + j2] * AC[3 * i + j1];
      const ov = (ra + rb - Math.abs(ti2 * C[3 * i1 + j] - ti1 * C[3 * i2 + j])) / Math.sqrt(l2);
      if (ov < 0) return;
      if (ov < best * 0.9 - 1e-4) { best = ov; kind = 2; ai = i; bj = j; }
    }
  }
  let lx = 0, ly = 0, lz = 0;
  if (kind === 2) {
    const ax = A[3 + ai], ay = A[6 + ai], az = A[9 + ai], bx = B[3 + bj], by = B[6 + bj], bz = B[9 + bj];
    lx = ay * bz - az * by; ly = az * bx - ax * bz; lz = ax * by - ay * bx;
    const cl = Math.sqrt(lx * lx + ly * ly + lz * lz);
    lx /= cl; ly /= cl; lz /= cl;
  }
  if (kind === 0) {
    const sg = axd(A, ai, ux, uy, uz) > 0 ? 1 : -1;
    clipFace(a, b, A, ai, A[3 + ai] * sg, A[6 + ai] * sg, A[9 + ai] * sg, B, -1);
  } else if (kind === 1) {
    const sg = axd(B, bj, ux, uy, uz) > 0 ? -1 : 1;
    clipFace(a, b, B, bj, B[3 + bj] * sg, B[6 + bj] * sg, B[9 + bj] * sg, A, 1);
  } else if (kind === 2) {
    // edge against edge: n from B to A; the edges of each box nearest the other
    const sgn = lx * ux + ly * uy + lz * uz > 0 ? -1 : 1, nx = lx * sgn, ny = ly * sgn, nz = lz * sgn;
    let px = A[0], py = A[1], pz = A[2], qx = B[0], qy = B[1], qz = B[2];
    for (let k = 0; k < 3; k++) {
      if (k !== ai) { const e = axd(A, k, nx, ny, nz) > 0 ? -A[12 + k] : A[12 + k]; px += A[3 + k] * e; py += A[6 + k] * e; pz += A[9 + k] * e; }
      if (k !== bj) { const e = axd(B, k, nx, ny, nz) > 0 ? B[12 + k] : -B[12 + k]; qx += B[3 + k] * e; qy += B[6 + k] * e; qz += B[9 + k] * e; }
    }
    const ea = A[12 + ai], eb = B[12 + bj];
    seg[0] = px - A[3 + ai] * ea; seg[1] = py - A[6 + ai] * ea; seg[2] = pz - A[9 + ai] * ea;
    seg[3] = px + A[3 + ai] * ea; seg[4] = py + A[6 + ai] * ea; seg[5] = pz + A[9 + ai] * ea;
    seg[6] = qx - B[3 + bj] * eb; seg[7] = qy - B[6 + bj] * eb; seg[8] = qz - B[9 + bj] * eb;
    seg[9] = qx + B[3 + bj] * eb; seg[10] = qy + B[6 + bj] * eb; seg[11] = qz + B[9 + bj] * eb;
    segSeg();
    const s = segS, t = segT;
    addC(a, b, nx, ny, nz,
      (seg[0] + (seg[3] - seg[0]) * s + seg[6] + (seg[9] - seg[6]) * t) * 0.5,
      (seg[1] + (seg[4] - seg[1]) * s + seg[7] + (seg[10] - seg[7]) * t) * 0.5,
      (seg[2] + (seg[5] - seg[2]) * s + seg[8] + (seg[11] - seg[8]) * t) * 0.5, best);
  }
}

/** Body i (any shape) against the static box k. */
function vsStatic(rt: Rt, i: number, k: number): void {
  const kind = rt.kind[i], sb = rt.sb;
  if (kind === 2) {
    loadStaticBox(sb, k, BB);
    boxBox(i, -1);
  } else {
    const r = rt.dim[3 * i];
    if (kind === 0) sphereAabb(i, seg[0], seg[1], seg[2], r, sb, k);
    else {
      sphereAabb(i, seg[0], seg[1], seg[2], r, sb, k);
      sphereAabb(i, (seg[0] + seg[3]) * 0.5, (seg[1] + seg[4]) * 0.5, (seg[2] + seg[5]) * 0.5, r, sb, k);
      sphereAabb(i, seg[3], seg[4], seg[5], r, sb, k);
    }
  }
}

/** Spheres along seg[0..5] (radius r, slot a; 1, 3 or 5 samples) against the box of body j. */
function samplesVsObb(rt: Rt, a: number, r: number, samples: number, j: number): void {
  for (let s = 0; s < samples; s++) {
    const t = samples === 1 ? 0.5 : s / (samples - 1);
    sphereObb(rt, a, seg[0] + (seg[3] - seg[0]) * t, seg[1] + (seg[4] - seg[1]) * t, seg[2] + (seg[5] - seg[2]) * t, r, j);
  }
}

function pairNarrow(rt: Rt, i: number, j: number): void {
  const ki = rt.kind[i], kj = rt.kind[j];
  curE = Math.sqrt(rt.e[i] * rt.e[j]);
  curMu = Math.sqrt(rt.mu[i] * rt.mu[j]);
  if (ki < 2 && kj < 2) {
    segOf(rt, i, 0); segOf(rt, j, 6);
    segContact(i, rt.dim[3 * i], j, rt.dim[3 * j]);
  } else if (ki < 2) {
    segOf(rt, i, 0);
    samplesVsObb(rt, i, rt.dim[3 * i], ki === 0 ? 1 : 3, j);
  } else if (kj < 2) {
    segOf(rt, j, 0);
    samplesVsObb(rt, j, rt.dim[3 * j], kj === 0 ? 1 : 3, i);
  } else {
    loadBodyBox(rt, i, BA);
    loadBodyBox(rt, j, BB);
    boxBox(i, j);
  }
}

/** Body i against the crew capsule (slot n). */
function crewNarrow(rt: Rt, i: number, crew: CrewState): void {
  const n = rt.n, R = CREW_RADIUS, p = crew.pos;
  curE = Math.sqrt(rt.e[i] * CREW_RESTITUTION);
  curMu = Math.sqrt(rt.mu[i] * CREW_FRICTION);
  if (rt.kind[i] < 2) {
    segOf(rt, i, 0);
    seg[6] = p.x; seg[7] = p.y + R; seg[8] = p.z; seg[9] = p.x; seg[10] = p.y + CREW_HEIGHT - R; seg[11] = p.z;
    segContact(i, rt.dim[3 * i], n, R);
    return;
  }
  seg[0] = p.x; seg[1] = p.y + R; seg[2] = p.z; seg[3] = p.x; seg[4] = p.y + CREW_HEIGHT - R; seg[5] = p.z;
  samplesVsObb(rt, n, R, 5, i);
  cornersOf(rt, i);
  const y0 = p.y + R, y1 = p.y + CREW_HEIGHT - R;
  for (let s = 0; s < 8; s++) {
    const x = cor[3 * s], y = cor[3 * s + 1], z = cor[3 * s + 2];
    const qy = y < y0 ? y0 : y > y1 ? y1 : y;
    let nx = x - p.x, ny = y - qy, nz = z - p.z;
    const d2 = nx * nx + ny * ny + nz * nz;
    if (d2 >= R * R || d2 < 1e-18) continue;
    const d = Math.sqrt(d2);
    nx /= d; ny /= d; nz /= d;
    addC(i, n, nx, ny, nz, x, y, z, R - d);
  }
}

// ------------------------------------------------------------------------------------------------ solver

function effMass(rt: Rt, s: number, rx: number, ry: number, rz: number, nx: number, ny: number, nz: number): number {
  if (s < 0) return 0;
  const im = rt.im[s];
  if (im === 0) return 0;
  const cx = ry * nz - rz * ny, cy = rz * nx - rx * nz, cz = rx * ny - ry * nx, I = rt.Iw, o = 9 * s;
  return im + cx * (I[o] * cx + I[o + 1] * cy + I[o + 2] * cz) + cy * (I[o + 3] * cx + I[o + 4] * cy + I[o + 5] * cz) + cz * (I[o + 6] * cx + I[o + 7] * cy + I[o + 8] * cz);
}

let rvx = 0, rvy = 0, rvz = 0;
/** Relative velocity of the contact points (a minus b) into rvx, rvy, rvz. */
function relVec(rt: Rt, a: number, b: number, k: number): void {
  const vw = rt.vw;
  let o = 6 * a;
  rvx = vw[o] + vw[o + 4] * cf[k + 5] - vw[o + 5] * cf[k + 4];
  rvy = vw[o + 1] + vw[o + 5] * cf[k + 3] - vw[o + 3] * cf[k + 5];
  rvz = vw[o + 2] + vw[o + 3] * cf[k + 4] - vw[o + 4] * cf[k + 3];
  if (b >= 0) {
    o = 6 * b;
    rvx -= vw[o] + vw[o + 4] * cf[k + 8] - vw[o + 5] * cf[k + 7];
    rvy -= vw[o + 1] + vw[o + 5] * cf[k + 6] - vw[o + 3] * cf[k + 8];
    rvz -= vw[o + 2] + vw[o + 3] * cf[k + 7] - vw[o + 4] * cf[k + 6];
  }
}

/** Relative velocity of the contact points (a minus b) along (x, y, z). */
function relVel(rt: Rt, a: number, b: number, k: number, x: number, y: number, z: number): number {
  const vw = rt.vw;
  let o = 6 * a;
  let vx = vw[o] + vw[o + 4] * cf[k + 5] - vw[o + 5] * cf[k + 4];
  let vy = vw[o + 1] + vw[o + 5] * cf[k + 3] - vw[o + 3] * cf[k + 5];
  let vz = vw[o + 2] + vw[o + 3] * cf[k + 4] - vw[o + 4] * cf[k + 3];
  if (b >= 0) {
    o = 6 * b;
    vx -= vw[o] + vw[o + 4] * cf[k + 8] - vw[o + 5] * cf[k + 7];
    vy -= vw[o + 1] + vw[o + 5] * cf[k + 6] - vw[o + 3] * cf[k + 8];
    vz -= vw[o + 2] + vw[o + 3] * cf[k + 7] - vw[o + 4] * cf[k + 6];
  }
  return vx * x + vy * y + vz * z;
}

function applyImp(rt: Rt, s: number, rx: number, ry: number, rz: number, px: number, py: number, pz: number): void {
  const im = rt.im[s];
  if (im === 0) return;
  const vw = rt.vw, o = 6 * s, I = rt.Iw, oi = 9 * s;
  vw[o] += px * im; vw[o + 1] += py * im; vw[o + 2] += pz * im;
  const cx = ry * pz - rz * py, cy = rz * px - rx * pz, cz = rx * py - ry * px;
  vw[o + 3] += I[oi] * cx + I[oi + 1] * cy + I[oi + 2] * cz;
  vw[o + 4] += I[oi + 3] * cx + I[oi + 4] * cy + I[oi + 5] * cz;
  vw[o + 5] += I[oi + 6] * cx + I[oi + 7] * cy + I[oi + 8] * cz;
}

function applyPair(rt: Rt, a: number, b: number, k: number, px: number, py: number, pz: number): void {
  applyImp(rt, a, cf[k + 3], cf[k + 4], cf[k + 5], px, py, pz);
  if (b >= 0) applyImp(rt, b, cf[k + 6], cf[k + 7], cf[k + 8], -px, -py, -pz);
}

function solve(rt: Rt): void {
  const pp = rt.pp;
  for (let c = 0; c < nc; c++) {
    const k = c * CS, a = ci[2 * c], b = ci[2 * c + 1];
    const px = cf[k + 3], py = cf[k + 4], pz = cf[k + 5];
    cf[k + 3] = px - pp[3 * a]; cf[k + 4] = py - pp[3 * a + 1]; cf[k + 5] = pz - pp[3 * a + 2];
    if (b >= 0) { cf[k + 6] = px - pp[3 * b]; cf[k + 7] = py - pp[3 * b + 1]; cf[k + 8] = pz - pp[3 * b + 2]; }
    else cf[k + 6] = cf[k + 7] = cf[k + 8] = 0;
    const nx = cf[k], ny = cf[k + 1], nz = cf[k + 2];
    const kn = effMass(rt, a, cf[k + 3], cf[k + 4], cf[k + 5], nx, ny, nz) + effMass(rt, b, cf[k + 6], cf[k + 7], cf[k + 8], nx, ny, nz);
    cf[k + 12] = kn > 1e-12 ? 1 / kn : 0;
    relVec(rt, a, b, k);
    const vn = rvx * nx + rvy * ny + rvz * nz;
    // tangent basis along the sliding direction
    const vx = rvx - vn * nx, vy = rvy - vn * ny, vz = rvz - vn * nz;
    const vt = Math.sqrt(vx * vx + vy * vy + vz * vz);
    let t1x: number, t1y: number, t1z: number;
    if (vt > 1e-9) { t1x = vx / vt; t1y = vy / vt; t1z = vz / vt; }
    else if (Math.abs(nx) < 0.9) { const l = Math.sqrt(nz * nz + ny * ny); t1x = 0; t1y = nz / l; t1z = -ny / l; }
    else { const l = Math.sqrt(nz * nz + nx * nx); t1x = -nz / l; t1y = 0; t1z = nx / l; }
    const t2x = ny * t1z - nz * t1y, t2y = nz * t1x - nx * t1z, t2z = nx * t1y - ny * t1x;
    cf[k + 13] = t1x; cf[k + 14] = t1y; cf[k + 15] = t1z; cf[k + 16] = t2x; cf[k + 17] = t2y; cf[k + 18] = t2z;
    const k1 = effMass(rt, a, cf[k + 3], cf[k + 4], cf[k + 5], t1x, t1y, t1z) + effMass(rt, b, cf[k + 6], cf[k + 7], cf[k + 8], t1x, t1y, t1z);
    const k2 = effMass(rt, a, cf[k + 3], cf[k + 4], cf[k + 5], t2x, t2y, t2z) + effMass(rt, b, cf[k + 6], cf[k + 7], cf[k + 8], t2x, t2y, t2z);
    cf[k + 19] = k1 > 1e-12 ? 1 / k1 : 0;
    cf[k + 20] = k2 > 1e-12 ? 1 / k2 : 0;
    cf[k + 21] = vn < -BOUNCE_V ? -cf[k + 10] * vn : 0;
    cf[k + 22] = cf[k + 23] = cf[k + 24] = 0;
    rt.cnt[a]++;
    if (b >= 0) rt.cnt[b]++;
  }
  for (let it = 0; it < ITER; it++) {
    for (let c = 0; c < nc; c++) {
      const k = c * CS, a = ci[2 * c], b = ci[2 * c + 1];
      if (cf[k + 12] === 0) continue;
      const nx = cf[k], ny = cf[k + 1], nz = cf[k + 2];
      const vn = relVel(rt, a, b, k, nx, ny, nz);
      const old = cf[k + 22];
      let ln = old + (cf[k + 21] - vn) * cf[k + 12];
      if (ln < 0) ln = 0;
      const dl = ln - old;
      cf[k + 22] = ln;
      if (dl !== 0) applyPair(rt, a, b, k, nx * dl, ny * dl, nz * dl);
      const mu = cf[k + 11];
      if (mu <= 0 || ln === 0) continue;
      const t1x = cf[k + 13], t1y = cf[k + 14], t1z = cf[k + 15], t2x = cf[k + 16], t2y = cf[k + 17], t2z = cf[k + 18];
      const o1 = cf[k + 23], o2 = cf[k + 24];
      relVec(rt, a, b, k);
      let l1 = o1 - (rvx * t1x + rvy * t1y + rvz * t1z) * cf[k + 19];
      let l2 = o2 - (rvx * t2x + rvy * t2y + rvz * t2z) * cf[k + 20];
      const lim = mu * ln, lt = Math.sqrt(l1 * l1 + l2 * l2);
      if (lt > lim) { l1 *= lim / lt; l2 *= lim / lt; }
      cf[k + 23] = l1; cf[k + 24] = l2;
      const d1 = l1 - o1, d2 = l2 - o2;
      applyPair(rt, a, b, k, t1x * d1 + t2x * d2, t1y * d1 + t2y * d2, t1z * d1 + t2z * d2);
    }
  }
}

/** Push overlapping things apart (linear only), shared by inverse mass, divided among each body's contacts. */
function project(rt: Rt): void {
  const pp = rt.pp, im = rt.im, cnt = rt.cnt;
  for (let c = 0; c < nc; c++) {
    const k = c * CS, a = ci[2 * c], b = ci[2 * c + 1];
    const corr = (cf[k + 9] - SLOP) * PROJ;
    if (corr <= 0) continue;
    const ia = im[a], ib = b >= 0 ? im[b] : 0, tot = ia + ib;
    if (tot <= 0) continue;
    const nx = cf[k], ny = cf[k + 1], nz = cf[k + 2];
    if (ia > 0) {
      const s = (corr * ia) / tot / cnt[a];
      pp[3 * a] += nx * s; pp[3 * a + 1] += ny * s; pp[3 * a + 2] += nz * s;
    }
    if (ib > 0) {
      const s = (corr * ib) / tot / cnt[b];
      pp[3 * b] -= nx * s; pp[3 * b + 1] -= ny * s; pp[3 * b + 2] -= nz * s;
    }
  }
}

// ------------------------------------------------------------------------------------------------ stepping

/** q ← exp(½·h·w) ⊗ q: turn q by the angular velocity w (ship axes) for time h, exactly. */
function rotQ(q: Quat, wx: number, wy: number, wz: number, h: number): void {
  const wl = Math.sqrt(wx * wx + wy * wy + wz * wz), th = wl * h * 0.5;
  if (!(th > 1e-15)) return;
  const sn = Math.sin(th) / wl, dw = Math.cos(th), dx = wx * sn, dy = wy * sn, dz = wz * sn;
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  let x = dw * qx + dx * qw + dy * qz - dz * qy;
  let y = dw * qy - dx * qz + dy * qw + dz * qx;
  let z = dw * qz + dx * qy - dy * qx + dz * qw;
  let w = dw * qw - dx * qx - dy * qy - dz * qz;
  const l = Math.sqrt(x * x + y * y + z * z + w * w);
  x /= l; y /= l; z /= l; w /= l;
  q.x = x; q.y = y; q.z = z; q.w = w;
}

/** Running totals for a debug overlay or a benchmark (contacts solved, sub-steps taken). */
export const propsStats = { contacts: 0, subSteps: 0 };

const FELT: V3 = { x: 0, y: 0, z: 0 };
const EYE: V3 = { x: 0, y: 0, z: 0 };

function setEye(rt: Rt, crew: CrewState, out: V3): void {
  const L = rt.layout;
  if (crew.seat === 'bunk') { out.x = L.bunkEye.x; out.y = L.bunkEye.y; out.z = L.bunkEye.z; }
  else if (crew.seat === 'table') { out.x = L.tableEye.x; out.y = L.tableEye.y; out.z = L.tableEye.z; }
  else { out.x = crew.pos.x; out.y = crew.pos.y + CREW_EYE; out.z = crew.pos.z; }
}

function makeDyn(rt: Rt, i: number, b: PropBody): void {
  rt.dyn[i] = 1;
  rt.im[i] = rt.invMass[i];
  rDiagRt(rt.R, 9 * i, rt.invIb[3 * i], rt.invIb[3 * i + 1], rt.invIb[3 * i + 2], rt.Iw, 9 * i);
  const o = 6 * i, vw = rt.vw;
  vw[o] = b.v.x; vw[o + 1] = b.v.y; vw[o + 2] = b.v.z; vw[o + 3] = b.w.x; vw[o + 4] = b.w.y; vw[o + 5] = b.w.z;
}

function wake(b: PropBody): void {
  if (b.stowed) return;
  b.asleep = false;
  b.still = 0;
}

function crewNear(rt: Rt, crew: CrewState, i: number, pad: number): boolean {
  const pp = rt.pp, p = crew.pos, r = CREW_RADIUS + rt.bound[i] + pad;
  const y = pp[3 * i + 1], y0 = p.y + CREW_RADIUS, y1 = p.y + CREW_HEIGHT - CREW_RADIUS;
  const dy = y < y0 ? y - y0 : y > y1 ? y - y1 : 0, dx = pp[3 * i] - p.x, dz = pp[3 * i + 2] - p.z;
  return dx * dx + dy * dy + dz * dz < r * r;
}

function sub(s: PropsState, rt: Rt, m: ShipMotion, crew: CrewState | null, gi: number, h: number): void {
  const B = s.bodies, n = rt.n, pp = rt.pp, R = rt.R, vw = rt.vw, im = rt.im, Iw = rt.Iw, dyn = rt.dyn;
  const a = m.a, W = m.w, al = m.alpha, la = s.lastA, lw = s.lastW;
  // a change in the ship's motion wakes everything loose
  const dax = a.x - la.x, day = a.y - la.y, daz = a.z - la.z, dwx = W.x - lw.x, dwy = W.y - lw.y, dwz = W.z - lw.z;
  if (dax * dax + day * day + daz * daz > WAKE_DA * WAKE_DA || dwx * dwx + dwy * dwy + dwz * dwz > WAKE_DW * WAKE_DW || (al.x * al.x + al.y * al.y + al.z * al.z) * rt.rmax * rt.rmax > WAKE_DA * WAKE_DA) {
    for (let i = 0; i < n; i++) wake(B[i]);
  }
  la.x = a.x; la.y = a.y; la.z = a.z; lw.x = W.x; lw.y = W.y; lw.z = W.z;
  const crewIm = crew && crew.seat === '' ? 1 / CREW_MASS : 0;
  const g = s.grab;

  // 1. per body: orientation, stowage, felt acceleration, the hand
  for (let i = 0; i < n; i++) {
    const b = B[i], o9 = 9 * i, o6 = 6 * i;
    quatToR(R, o9, b.q);
    pp[3 * i] = b.p.x; pp[3 * i + 1] = b.p.y; pp[3 * i + 2] = b.p.z;
    if (!dyn[i]) rt.prevOk[i] = 0;
    dyn[i] = 0; rt.prim[i] = 0; rt.cnt[i] = 0; rt.stamp[i] = -1; im[i] = 0;
    for (let k = 0; k < 9; k++) Iw[o9 + k] = 0;
    for (let k = 0; k < 6; k++) vw[o6 + k] = 0;
    const mass = rt.mass[i];
    if (b.stowed) {
      feltAt(m, b.p.x, b.p.y, b.p.z, 0, 0, 0, FELT);
      let fx = mass * FELT.x, fy = mass * FELT.y, fz = mass * FELT.z;
      if (i === gi) {
        // the hand pulls on it too: what the holder must resist is the sum
        const r0 = R[o9] * g.local.x + R[o9 + 1] * g.local.y + R[o9 + 2] * g.local.z;
        const r1 = R[o9 + 3] * g.local.x + R[o9 + 4] * g.local.y + R[o9 + 5] * g.local.z;
        const r2 = R[o9 + 6] * g.local.x + R[o9 + 7] * g.local.y + R[o9 + 8] * g.local.z;
        const k2 = mass * HAND_OMEGA * HAND_OMEGA, c2 = 2 * mass * HAND_OMEGA;
        let hx = k2 * (g.hand.x - b.p.x - r0) + c2 * g.handVel.x, hy = k2 * (g.hand.y - b.p.y - r1) + c2 * g.handVel.y, hz = k2 * (g.hand.z - b.p.z - r2) + c2 * g.handVel.z;
        const hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
        if (hl > HAND_FORCE) { hx *= HAND_FORCE / hl; hy *= HAND_FORCE / hl; hz *= HAND_FORCE / hl; }
        fx += hx; fy += hy; fz += hz;
        if (fx * fx + fy * fy + fz * fz <= rt.hold[i] * rt.hold[i]) {
          // it holds: the hand holding on to a fixed thing pulls the body (and is pulled) the other way
          if (crew && crewIm > 0) { crew.vel.x -= hx * h * crewIm; crew.vel.y -= hy * h * crewIm; crew.vel.z -= hz * h * crewIm; }
          continue;
        }
      }
      if (fx * fx + fy * fy + fz * fz <= rt.hold[i] * rt.hold[i]) continue;
      b.stowed = false; b.asleep = false; b.still = 0;
    }
    if (b.asleep && i !== gi) {
      if (crew && crewIm > 0) {
        const cv = crew.vel;
        if (cv.x * cv.x + cv.y * cv.y + cv.z * cv.z > WAKE_V * WAKE_V && crewNear(rt, crew, i, 0.02)) wake(b);
      }
      if (b.asleep) continue;
    }
    b.asleep = false;
    const v = b.v, w = b.w;
    // how fast it was going before this sub-step's push (what may wake a sleeper it touches)
    rt.spd[i] = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) + Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z) * rt.bound[i];
    feltAt(m, b.p.x, b.p.y, b.p.z, v.x, v.y, v.z, FELT);
    rt.fm[i] = Math.sqrt(FELT.x * FELT.x + FELT.y * FELT.y + FELT.z * FELT.z);
    v.x += FELT.x * h; v.y += FELT.y * h; v.z += FELT.z * h;
    makeDyn(rt, i, b);
    if (i === gi) {
      // critically damped spring from the grip point to the hand, limited to HAND_FORCE; the arm pushes back on the body
      const lx = g.local.x, ly = g.local.y, lz = g.local.z;
      const r0 = R[o9] * lx + R[o9 + 1] * ly + R[o9 + 2] * lz, r1 = R[o9 + 3] * lx + R[o9 + 4] * ly + R[o9 + 5] * lz, r2 = R[o9 + 6] * lx + R[o9 + 7] * ly + R[o9 + 8] * lz;
      const pvx = vw[o6] + vw[o6 + 4] * r2 - vw[o6 + 5] * r1, pvy = vw[o6 + 1] + vw[o6 + 5] * r0 - vw[o6 + 3] * r2, pvz = vw[o6 + 2] + vw[o6 + 3] * r1 - vw[o6 + 4] * r0;
      const k2 = mass * HAND_OMEGA * HAND_OMEGA, c2 = 2 * mass * HAND_OMEGA;
      let fx = k2 * (g.hand.x - b.p.x - r0) + c2 * (g.handVel.x - pvx);
      let fy = k2 * (g.hand.y - b.p.y - r1) + c2 * (g.handVel.y - pvy);
      let fz = k2 * (g.hand.z - b.p.z - r2) + c2 * (g.handVel.z - pvz);
      const fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
      if (fl > HAND_FORCE) { fx *= HAND_FORCE / fl; fy *= HAND_FORCE / fl; fz *= HAND_FORCE / fl; }
      applyImp(rt, i, r0, r1, r2, fx * h, fy * h, fz * h);
      if (crew && crewIm > 0) { crew.vel.x -= fx * h * crewIm; crew.vel.y -= fy * h * crewIm; crew.vel.z -= fz * h * crewIm; }
      // the wrist steadies it: a damping torque against its spin, limited to HAND_TORQUE
      rdrt(R, o9, rt.Ib[3 * i], rt.Ib[3 * i + 1], rt.Ib[3 * i + 2], vw[o6 + 3], vw[o6 + 4], vw[o6 + 5]);
      let qx = -tx * 2 * HAND_ROT, qy = -ty * 2 * HAND_ROT, qz = -tz * 2 * HAND_ROT;
      const ql = Math.sqrt(qx * qx + qy * qy + qz * qz);
      if (ql > HAND_TORQUE) { qx *= HAND_TORQUE / ql; qy *= HAND_TORQUE / ql; qz *= HAND_TORQUE / ql; }
      const o = 9 * i;
      vw[o6 + 3] += (Iw[o] * qx + Iw[o + 1] * qy + Iw[o + 2] * qz) * h;
      vw[o6 + 4] += (Iw[o + 3] * qx + Iw[o + 4] * qy + Iw[o + 5] * qz) * h;
      vw[o6 + 5] += (Iw[o + 6] * qx + Iw[o + 7] * qy + Iw[o + 8] * qz) * h;
    }
  }
  // the crew slot
  const cs = 6 * n;
  im[n] = crewIm; rt.cnt[n] = 0;
  for (let k = 0; k < 9; k++) Iw[9 * n + k] = 0;
  vw[cs] = vw[cs + 1] = vw[cs + 2] = vw[cs + 3] = vw[cs + 4] = vw[cs + 5] = 0;
  if (crew) {
    vw[cs] = crew.vel.x; vw[cs + 1] = crew.vel.y; vw[cs + 2] = crew.vel.z;
    pp[3 * n] = crew.pos.x; pp[3 * n + 1] = crew.pos.y + CREW_HEIGHT * 0.5; pp[3 * n + 2] = crew.pos.z;
  }

  // 2. contacts: the grid
  const cell = rt.cell, head = rt.head, next = rt.next;
  head.fill(-1);
  for (let i = 0; i < n; i++) {
    const ix = Math.floor(pp[3 * i] / cell), iy = Math.floor(pp[3 * i + 1] / cell), iz = Math.floor(pp[3 * i + 2] / cell);
    const hb = ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) & (GRID_B - 1);
    next[i] = head[hb]; head[hb] = i;
  }
  nc = 0;
  const sb = rt.sb, bound = rt.bound;
  for (let i = 0; i < n; i++) {
    if (!dyn[i]) continue;
    rt.prim[i] = 1;
    const cx = pp[3 * i], cy = pp[3 * i + 1], cz = pp[3 * i + 2], bd = bound[i];
    // the interior
    curE = rt.e[i]; curMu = rt.mu[i];
    if (rt.prevOk[i]) { const o7 = 7 * i; mvx = cx - rt.prev[o7]; mvy = cy - rt.prev[o7 + 1]; mvz = cz - rt.prev[o7 + 2]; }
    else mvx = mvy = mvz = 0;
    // the tight world box of the body (its bounding sphere for capsules and spheres)
    let ex = bd, ey = bd, ez = bd;
    if (rt.kind[i] === 2) {
      loadBodyBox(rt, i, BA);
      const o = 9 * i, hx = rt.dim[3 * i], hy = rt.dim[3 * i + 1], hz = rt.dim[3 * i + 2];
      ex = Math.abs(R[o]) * hx + Math.abs(R[o + 1]) * hy + Math.abs(R[o + 2]) * hz;
      ey = Math.abs(R[o + 3]) * hx + Math.abs(R[o + 4]) * hy + Math.abs(R[o + 5]) * hz;
      ez = Math.abs(R[o + 6]) * hx + Math.abs(R[o + 7]) * hy + Math.abs(R[o + 8]) * hz;
    } else segOf(rt, i, 0);
    const tick = ++rt.sgTick, st = rt.sgStamp, items = rt.sgItems, start = rt.sgStart, gy = rt.sgn[1], gz = rt.sgn[2];
    const x0 = cellOf(rt, cx - bd, 0), x1 = cellOf(rt, cx + bd, 0), y0 = cellOf(rt, cy - bd, 1), y1 = cellOf(rt, cy + bd, 1), z0 = cellOf(rt, cz - bd, 2), z1 = cellOf(rt, cz + bd, 2);
    for (let gxi = x0; gxi <= x1; gxi++) for (let gyi = y0; gyi <= y1; gyi++) for (let gzi = z0; gzi <= z1; gzi++) {
      const cell0 = (gxi * gy + gyi) * gz + gzi;
      for (let it = start[cell0], end = start[cell0 + 1]; it < end; it++) {
        const k = items[it];
        if (st[k] === tick) continue;
        st[k] = tick;
        const o = 6 * k;
        if (cx + ex < sb[o] || cx - ex > sb[o + 3] || cy + ey < sb[o + 1] || cy - ey > sb[o + 4] || cz + ez < sb[o + 2] || cz - ez > sb[o + 5]) continue;
        vsStatic(rt, i, o);
      }
    }
    mvx = mvy = mvz = 0;
    // the crew
    if (crew && i !== gi && crewNear(rt, crew, i, 0)) crewNarrow(rt, i, crew);
    // each other
    const sp = rt.spd[i];
    const ix = Math.floor(cx / cell), iy = Math.floor(cy / cell), iz = Math.floor(cz / cell);
    for (let ddx = -1; ddx <= 1; ddx++) for (let ddy = -1; ddy <= 1; ddy++) for (let ddz = -1; ddz <= 1; ddz++) {
      const hb = (((ix + ddx) * 73856093) ^ ((iy + ddy) * 19349663) ^ ((iz + ddz) * 83492791)) & (GRID_B - 1);
      for (let j = head[hb]; j >= 0; j = next[j]) {
        if (j === i || rt.stamp[j] === i) continue;
        rt.stamp[j] = i;
        if (rt.prim[j]) continue;
        const dx = pp[3 * j] - cx, dy = pp[3 * j + 1] - cy, dz = pp[3 * j + 2] - cz, rr = bd + bound[j];
        if (dx * dx + dy * dy + dz * dz >= rr * rr) continue;
        const bj = B[j];
        if (!dyn[j] && bj.asleep && !bj.stowed && (sp > WAKE_V || i === gi)) { wake(bj); makeDyn(rt, j, bj); }
        pairNarrow(rt, i, j);
      }
    }
  }

  // 3. impulses, then write the velocities back
  propsStats.contacts += nc;
  propsStats.subSteps++;
  solve(rt);
  for (let i = 0; i < n; i++) {
    if (!dyn[i]) continue;
    const b = B[i], o = 6 * i;
    b.v.x = vw[o]; b.v.y = vw[o + 1]; b.v.z = vw[o + 2]; b.w.x = vw[o + 3]; b.w.y = vw[o + 4]; b.w.z = vw[o + 5];
  }
  project(rt);
  if (crew && crewIm > 0) {
    crew.vel.x = vw[cs]; crew.vel.y = vw[cs + 1]; crew.vel.z = vw[cs + 2];
    crew.pos.x = pp[3 * n]; crew.pos.y = pp[3 * n + 1] - CREW_HEIGHT * 0.5; crew.pos.z = pp[3 * n + 2];
  }

  // 4. integrate: position, then orientation with the angular momentum carried in ship axes
  const vol = rt.vol, nv = rt.nv;
  for (let i = 0; i < n; i++) {
    if (!dyn[i]) continue;
    const b = B[i], p = b.p, v = b.v, w = b.w, q = b.q, o9 = 9 * i, pr = rt.prev, o7 = 7 * i;
    pr[o7] = pp[3 * i]; pr[o7 + 1] = pp[3 * i + 1]; pr[o7 + 2] = pp[3 * i + 2]; pr[o7 + 3] = q.x; pr[o7 + 4] = q.y; pr[o7 + 5] = q.z; pr[o7 + 6] = q.w;
    rt.prevOk[i] = 1;
    p.x = pp[3 * i] + v.x * h; p.y = pp[3 * i + 1] + v.y * h; p.z = pp[3 * i + 2] + v.z * h;
    const I0 = rt.Ib[3 * i], I1 = rt.Ib[3 * i + 1], I2 = rt.Ib[3 * i + 2];
    rdrt(R, o9, I0, I1, I2, W.x + w.x, W.y + w.y, W.z + w.z);
    let Lx = tx, Ly = ty, Lz = tz;
    const ox = W.y * Lz - W.z * Ly, oy = W.z * Lx - W.x * Lz, oz = W.x * Ly - W.y * Lx;
    Lx -= ox * h; Ly -= oy * h; Lz -= oz * h;
    // midpoint rule on the rotation group: half a step with ω₀, ω at the midpoint from L, a full step with it
    const q0x = q.x, q0y = q.y, q0z = q.z, q0w = q.w;
    rotQ(q, w.x, w.y, w.z, 0.5 * h);
    quatToR(R, o9, q);
    rdrt(R, o9, rt.invIb[3 * i], rt.invIb[3 * i + 1], rt.invIb[3 * i + 2], Lx, Ly, Lz);
    const mx = tx - W.x, my = ty - W.y, mz = tz - W.z;
    q.x = q0x; q.y = q0y; q.z = q0z; q.w = q0w;
    rotQ(q, mx, my, mz, h);
    quatToR(R, o9, q);
    rdrt(R, o9, rt.invIb[3 * i], rt.invIb[3 * i + 1], rt.invIb[3 * i + 2], Lx, Ly, Lz);
    w.x = tx - W.x - al.x * h; w.y = ty - W.y - al.y * h; w.z = tz - W.z - al.z * h;
    // last line of defence: the centre never leaves the rooms and doorways
    let inside = p.x === p.x && p.y === p.y && p.z === p.z && w.x === w.x && w.y === w.y && w.z === w.z;
    if (inside) {
      inside = false;
      for (let k = 0, o = 0; k < nv; k++, o += 6) {
        if (p.x >= vol[o] - 1e-3 && p.x <= vol[o + 3] + 1e-3 && p.y >= vol[o + 1] - 1e-3 && p.y <= vol[o + 4] + 1e-3 && p.z >= vol[o + 2] - 1e-3 && p.z <= vol[o + 5] + 1e-3) { inside = true; break; }
      }
    }
    if (!inside) {
      p.x = pr[o7]; p.y = pr[o7 + 1]; p.z = pr[o7 + 2]; q.x = pr[o7 + 3]; q.y = pr[o7 + 4]; q.z = pr[o7 + 5]; q.w = pr[o7 + 6];
      v.x = v.y = v.z = 0; w.x = w.y = w.z = 0;
    }
    // sleep: at rest on something, or perfectly still with nothing pushing it
    const v2 = v.x * v.x + v.y * v.y + v.z * v.z, w2 = w.x * w.x + w.y * w.y + w.z * w.z;
    const ps = Math.sqrt(v2) + Math.sqrt(w2) * rt.bound[i];
    const quiet = rt.cnt[i] > 0 ? ps < SLEEP_V && w2 < SLEEP_W * SLEEP_W : rt.fm[i] < 1e-6 && v2 < FLOAT_V * FLOAT_V && w2 < FLOAT_W * FLOAT_W;
    b.still = quiet ? b.still + h : 0;
    if (b.still > SLEEP_T && i !== gi) {
      b.asleep = true;
      v.x = v.y = v.z = 0; w.x = w.y = w.z = 0;
    }
  }
}

/**
 * Advance every object by dt of ship time (s) under the ship's motion (craftMotion() output) and with the crew
 * body (null when nobody is aboard). Sub-stepped at 120 Hz or finer, so that no point of any body moves more
 * than MAX_MOVE per sub-step; while the ship coasts (felt acceleration under LIGHT_A, nothing in hand, the crew
 * still) only that motion bound, ROT_STEP of turn and COAST_DT set the step, and a pure free flight clear of every
 * surface goes from gap to gap (freeStep). Returns the number of sub-steps taken (0 when everything slept).
 */
export function stepProps(s: PropsState, ship: ShipMotion, crew: CrewState | null, dt: number): number {
  try {
    if (!(dt > 0) || !Number.isFinite(dt)) return 0;
    const rt = runtime(s.layoutId);
    if (!rt || s.bodies.length !== rt.n) return 0;
    const B = s.bodies, n = rt.n, g = s.grab, a = ship.a, W = ship.w, al = ship.alpha;
    if (crew) setEye(rt, crew, g.eye);
    let gi = g.id === '' ? -1 : rt.index.get(g.id) ?? -1;
    if (gi < 0) g.id = '';
    // anything to do?
    let awake = gi >= 0;
    let vmax = 0, wmax = 0;
    for (let i = 0; i < n; i++) {
      const b = B[i];
      if (!b.asleep && !b.stowed) {
        awake = true;
        const v = b.v, w = b.w, wl = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);
        const sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) + wl * rt.bound[i];
        if (sp > vmax) vmax = sp;
        if (wl > wmax) wmax = wl;
      }
    }
    const la = s.lastA, lw = s.lastW;
    const dax = a.x - la.x, day = a.y - la.y, daz = a.z - la.z, dwx = W.x - lw.x, dwy = W.y - lw.y, dwz = W.z - lw.z;
    if (dax * dax + day * day + daz * daz > WAKE_DA * WAKE_DA || dwx * dwx + dwy * dwy + dwz * dwz > WAKE_DW * WAKE_DW || (al.x * al.x + al.y * al.y + al.z * al.z) * rt.rmax * rt.rmax > WAKE_DA * WAKE_DA) awake = true;
    if (!awake && crew && crew.seat === '') {
      const cv = crew.vel;
      if (cv.x * cv.x + cv.y * cv.y + cv.z * cv.z > WAKE_V * WAKE_V) {
        for (let i = 0; i < n; i++) {
          rt.pp[3 * i] = B[i].p.x; rt.pp[3 * i + 1] = B[i].p.y; rt.pp[3 * i + 2] = B[i].p.z;
          if (!B[i].stowed && crewNear(rt, crew, i, 0.05 + Math.sqrt(cv.x * cv.x + cv.y * cv.y + cv.z * cv.z) * dt)) { awake = true; break; }
        }
      }
    }
    if (!awake) { s.t += dt; return 0; }
    if (gi >= 0) vmax = Math.max(vmax, Math.sqrt(g.handVel.x ** 2 + g.handVel.y ** 2 + g.handVel.z ** 2) + 1);
    if (crew) vmax = Math.max(vmax, Math.sqrt(crew.vel.x ** 2 + crew.vel.y ** 2 + crew.vel.z ** 2));
    const w2 = W.x * W.x + W.y * W.y + W.z * W.z;
    const amax = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z) + (w2 + Math.sqrt(al.x * al.x + al.y * al.y + al.z * al.z)) * rt.rmax + 2 * Math.sqrt(w2) * vmax;
    const cv2 = crew ? crew.vel.x * crew.vel.x + crew.vel.y * crew.vel.y + crew.vel.z * crew.vel.z : 0;
    const light = gi < 0 && amax < LIGHT_A && cv2 < WAKE_V * WAKE_V;
    let nsub = light
      ? Math.max(Math.ceil(dt / COAST_DT - 1e-9), Math.ceil(((vmax + amax * dt) * dt) / MAX_MOVE), Math.ceil((wmax * dt) / ROT_STEP))
      : Math.max(Math.ceil(dt / SUB_DT - 1e-9), Math.ceil(((vmax + amax * dt) * dt) / MAX_MOVE));
    if (nsub < 1) nsub = 1; else if (nsub > MAX_SUB) nsub = MAX_SUB;
    const h = dt / nsub;
    if (gi < 0 && freeStep(rt, s, crew, amax, w2) > h) {
      // Everything awake is in free flight, clear of every surface: take steps as long as the nearest possible
      // contact allows (re-judged every step; back to the fixed step as soon as anything comes near).
      let left = dt, k = 0;
      while (left > 0 && k < nsub) {
        let hk = freeStep(rt, s, crew, amax, w2);
        if (hk < h) hk = h;
        if (hk > left || k === nsub - 1) hk = left;
        sub(s, rt, ship, crew, -1, hk);
        left -= hk;
        k++;
      }
      s.t += dt;
      return k;
    }
    for (let k = 0; k < nsub; k++) {
      sub(s, rt, ship, crew, gi, h);
      if (gi >= 0) {
        // a hand that ends up too far from what it held lets go
        const b = B[gi], o = 9 * gi, R = rt.R, l = g.local;
        const ex = g.hand.x - b.p.x - (R[o] * l.x + R[o + 1] * l.y + R[o + 2] * l.z);
        const ey = g.hand.y - b.p.y - (R[o + 3] * l.x + R[o + 4] * l.y + R[o + 5] * l.z);
        const ez = g.hand.z - b.p.z - (R[o + 6] * l.x + R[o + 7] * l.y + R[o + 8] * l.z);
        if (ex * ex + ey * ey + ez * ez > GRAB_SLIP * GRAB_SLIP) { g.id = ''; gi = -1; }
      }
    }
    s.t += dt;
    return nsub;
  } catch {
    return 0;
  }
}

/**
 * Longest sub-step (s) that free flight allows right now, 0 when some awake body touches something or is near it.
 * The nearest possible contact of each awake body (static boxes, every other body, the crew) is at least its gap;
 * a step may close half of it at the worst relative speed and felt acceleration (so nothing can tunnel), and turns
 * no body (or the cabin) by more than a small angle. Pure in-flight drift in a coasting ship thus costs a few steps
 * per gap crossed instead of 120 per second.
 */
function freeStep(rt: Rt, s: PropsState, crew: CrewState | null, amax: number, w2: number): number {
  const B = s.bodies, n = rt.n, sb = rt.sb, ns = rt.ns;
  let gap = Infinity, vmax = 0, wmax = 0, any = false;
  for (let i = 0; i < n; i++) {
    const b = B[i];
    if (b.asleep || b.stowed) continue;
    if (rt.cnt[i] > 0) return 0;
    any = true;
    const p = b.p, bd = rt.bound[i];
    const v = Math.sqrt(b.v.x * b.v.x + b.v.y * b.v.y + b.v.z * b.v.z), w = Math.sqrt(b.w.x * b.w.x + b.w.y * b.w.y + b.w.z * b.w.z);
    if (v > vmax) vmax = v;
    if (w > wmax) wmax = w;
    for (let k = 0; k < ns; k++) {
      const o = 6 * k;
      const dx = p.x < sb[o] ? sb[o] - p.x : p.x > sb[o + 3] ? p.x - sb[o + 3] : 0;
      const dy = p.y < sb[o + 1] ? sb[o + 1] - p.y : p.y > sb[o + 4] ? p.y - sb[o + 4] : 0;
      const dz = p.z < sb[o + 2] ? sb[o + 2] - p.z : p.z > sb[o + 5] ? p.z - sb[o + 5] : 0;
      const g = Math.sqrt(dx * dx + dy * dy + dz * dz) - bd;
      if (g < gap) gap = g;
    }
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const q = B[j].p, g = Math.sqrt((p.x - q.x) ** 2 + (p.y - q.y) ** 2 + (p.z - q.z) ** 2) - bd - rt.bound[j];
      if (g < gap) gap = g;
    }
    if (crew) {
      const c = crew.pos, y0 = c.y, y1 = c.y + CREW_HEIGHT, cy = p.y < y0 ? y0 : p.y > y1 ? y1 : p.y;
      const g = Math.sqrt((p.x - c.x) ** 2 + (p.y - cy) ** 2 + (p.z - c.z) ** 2) - bd - CREW_RADIUS;
      if (g < gap) gap = g;
    }
  }
  if (!any || !(gap > 0)) return 0;
  // worst closing speed: two bodies head on, or a body and the crew
  const cv = crew ? Math.sqrt(crew.vel.x * crew.vel.x + crew.vel.y * crew.vel.y + crew.vel.z * crew.vel.z) : 0;
  const v = 2 * vmax + cv, a = 2 * amax, half = 0.5 * gap;
  let h = a > 1e-12 ? (Math.sqrt(v * v + 2 * a * half) - v) / a : v > 1e-12 ? half / v : Infinity;
  if (wmax > 0 && 0.2 / wmax < h) h = 0.2 / wmax;
  if (w2 > 0 && 0.05 / Math.sqrt(w2) < h) h = 0.05 / Math.sqrt(w2);
  return h;
}

/**
 * How much ship time one stepProps call may cover cheaply, s (for a caller that advances the world in pieces under
 * time acceleration): Infinity when everything sleeps or is stowed; LONG_CHUNK while the ship coasts (stepped by
 * motion) or everything awake is in free flight clear of every surface (stepped from gap to gap); otherwise
 * SHORT_CHUNK (contact under thrust or spin, a hand, a walking crew: 120 Hz).
 */
export const SHORT_CHUNK = 0.1;
export const LONG_CHUNK = 10;
export function propsChunk(s: PropsState, ship: ShipMotion, crew: CrewState | null): number {
  try {
    const rt = runtime(s.layoutId);
    if (!rt) return Infinity;
    if (s.grab.id !== '') return SHORT_CHUNK;
    let awake = false, vmax = 0;
    for (let i = 0; i < rt.n; i++) {
      const b = s.bodies[i];
      if (b.asleep || b.stowed) continue;
      awake = true;
      const v = Math.sqrt(b.v.x * b.v.x + b.v.y * b.v.y + b.v.z * b.v.z);
      if (v > vmax) vmax = v;
    }
    if (!awake) return Infinity;
    const a = ship.a, W = ship.w, al = ship.alpha, w2 = W.x * W.x + W.y * W.y + W.z * W.z;
    const amax = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z) + (w2 + Math.sqrt(al.x * al.x + al.y * al.y + al.z * al.z)) * rt.rmax + 2 * Math.sqrt(w2) * vmax;
    const cv2 = crew ? crew.vel.x * crew.vel.x + crew.vel.y * crew.vel.y + crew.vel.z * crew.vel.z : 0;
    if (amax < LIGHT_A && cv2 < WAKE_V * WAKE_V) return LONG_CHUNK; // coasting: stepped by motion, not by 120 Hz
    return freeStep(rt, s, crew, amax, w2) > SUB_DT ? LONG_CHUNK : SHORT_CHUNK;
  } catch {
    return SHORT_CHUNK;
  }
}

// ------------------------------------------------------------------------------------------------ hands

/**
 * Take hold of an object at a hand point (ship axes). Fails (false) when the hand is beyond ARM_REACH of the
 * eye, or not on (within a hand's breadth of) the object. A stowed object comes free only when the hand
 * pulls harder than its holder (a strapped crate needs unstow() first). One object at a time.
 */
export function grab(s: PropsState, propId: string, hand: V3, eye: V3): boolean {
  try {
    const rt = runtime(s.layoutId);
    const i = rt ? rt.index.get(propId) ?? -1 : -1;
    if (!rt || i < 0 || !isV3(hand) || !isV3(eye)) return false;
    const ex = hand.x - eye.x, ey = hand.y - eye.y, ez = hand.z - eye.z;
    if (ex * ex + ey * ey + ez * ez > ARM_REACH * ARM_REACH + 1e-9) return false;
    const b = s.bodies[i], dx = hand.x - b.p.x, dy = hand.y - b.p.y, dz = hand.z - b.p.z;
    const lim = rt.bound[i] + GRAB_SLOP;
    if (dx * dx + dy * dy + dz * dz > lim * lim) return false;
    const R = new Float64Array(9);
    quatToR(R, 0, b.q);
    let lx = R[0] * dx + R[3] * dy + R[6] * dz, ly = R[1] * dx + R[4] * dy + R[7] * dz, lz = R[2] * dx + R[5] * dy + R[8] * dz;
    // the grip is on the object: clamp the hand point into its shape
    const d0 = rt.dim[3 * i], d1 = rt.dim[3 * i + 1], d2 = rt.dim[3 * i + 2];
    if (rt.kind[i] === 2) {
      lx = Math.max(-d0, Math.min(d0, lx)); ly = Math.max(-d1, Math.min(d1, ly)); lz = Math.max(-d2, Math.min(d2, lz));
    } else {
      const hl = rt.kind[i] === 1 ? d1 : 0, ay = Math.max(-hl, Math.min(hl, ly));
      const rx = lx, ry = ly - ay, rz = lz, rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
      if (rl > d0) { lx = (rx * d0) / rl; ly = ay + (ry * d0) / rl; lz = (rz * d0) / rl; }
    }
    const g = s.grab;
    g.id = propId;
    g.local.x = lx; g.local.y = ly; g.local.z = lz;
    g.hand.x = hand.x; g.hand.y = hand.y; g.hand.z = hand.z;
    g.handVel.x = g.handVel.y = g.handVel.z = 0;
    g.eye.x = eye.x; g.eye.y = eye.y; g.eye.z = eye.z;
    wake(b);
    return true;
  } catch {
    return false;
  }
}

/** Move the holding hand to a new point (ship axes) over dt; kept within ARM_REACH of the eye. */
export function moveGrab(s: PropsState, hand: V3, dt: number): void {
  try {
    const g = s.grab;
    if (g.id === '' || !isV3(hand)) return;
    let x = hand.x - g.eye.x, y = hand.y - g.eye.y, z = hand.z - g.eye.z;
    const l = Math.sqrt(x * x + y * y + z * z);
    if (l > ARM_REACH) { x *= ARM_REACH / l; y *= ARM_REACH / l; z *= ARM_REACH / l; }
    x += g.eye.x; y += g.eye.y; z += g.eye.z;
    if (dt > 0) { g.handVel.x = (x - g.hand.x) / dt; g.handVel.y = (y - g.hand.y) / dt; g.handVel.z = (z - g.hand.z) / dt; }
    else g.handVel.x = g.handVel.y = g.handVel.z = 0;
    g.hand.x = x; g.hand.y = y; g.hand.z = z;
  } catch {
    /* never throws */
  }
}

/**
 * Let go. With a throw velocity (ship axes, m/s) the hand pushes the object toward it, up to a throw impulse of
 * HAND_FORCE × THROW_TIME (a mug leaves at the asked speed, a crate barely moves); the crew body takes the
 * reaction when given. Returns false when nothing was held.
 */
export function release(s: PropsState, throwVel?: V3, crew?: CrewState | null): boolean {
  try {
    const g = s.grab;
    if (g.id === '') return false;
    const rt = runtime(s.layoutId), i = rt ? rt.index.get(g.id) ?? -1 : -1;
    g.id = '';
    g.handVel.x = g.handVel.y = g.handVel.z = 0;
    if (!rt || i < 0) return false;
    const b = s.bodies[i];
    if (throwVel && isV3(throwVel) && !b.stowed) {
      const m = rt.mass[i];
      let jx = m * (throwVel.x - b.v.x), jy = m * (throwVel.y - b.v.y), jz = m * (throwVel.z - b.v.z);
      const jl = Math.sqrt(jx * jx + jy * jy + jz * jz), lim = HAND_FORCE * THROW_TIME;
      if (jl > lim) { jx *= lim / jl; jy *= lim / jl; jz *= lim / jl; }
      b.v.x += jx / m; b.v.y += jy / m; b.v.z += jz / m;
      if (crew && crew.seat === '') { crew.vel.x -= jx / CREW_MASS; crew.vel.y -= jy / CREW_MASS; crew.vel.z -= jz / CREW_MASS; }
      wake(b);
    }
    return true;
  } catch {
    return false;
  }
}

/** Undo an object's clip / magnet / strap (a crew action, e.g. "Release strap"). */
export function unstow(s: PropsState, propId: string): boolean {
  try {
    const rt = runtime(s.layoutId), i = rt ? rt.index.get(propId) ?? -1 : -1;
    if (i < 0) return false;
    const b = s.bodies[i];
    if (!b.stowed) return false;
    b.stowed = false; b.asleep = false; b.still = 0;
    return true;
  } catch {
    return false;
  }
}

/** The nearest object hit by a ray from `eye` along `dir` within maxDist (m), or ''. For a "Grab" prompt. */
export function pickProp(s: PropsState, eye: V3, dir: V3, maxDist: number = ARM_REACH): string {
  try {
    const rt = runtime(s.layoutId);
    if (!rt) return '';
    const dl = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
    if (!(dl > 0)) return '';
    const ux = dir.x / dl, uy = dir.y / dl, uz = dir.z / dl;
    let best = maxDist, id = '';
    for (let i = 0; i < rt.n; i++) {
      const b = s.bodies[i], ox = eye.x - b.p.x, oy = eye.y - b.p.y, oz = eye.z - b.p.z;
      const bd = rt.bound[i], pb = ox * ux + oy * uy + oz * uz, c = ox * ox + oy * oy + oz * oz - bd * bd, disc = pb * pb - c;
      if (disc < 0 || -pb - Math.sqrt(disc) > best || -pb + Math.sqrt(disc) < 0) continue;
      quatToR(rt.R, 9 * i, b.q);
      const R = rt.R, o = 9 * i;
      let t = Infinity;
      if (rt.kind[i] === 2) {
        // slab test in the box's axes
        let t0 = -Infinity, t1 = Infinity;
        for (let ax = 0; ax < 3; ax++) {
          const e = R[o + ax] * ox + R[o + 3 + ax] * oy + R[o + 6 + ax] * oz, d = R[o + ax] * ux + R[o + 3 + ax] * uy + R[o + 6 + ax] * uz, hx = rt.dim[3 * i + ax];
          if (Math.abs(d) < 1e-12) { if (Math.abs(e) > hx) { t0 = Infinity; break; } continue; }
          let a = (-hx - e) / d, bb = (hx - e) / d;
          if (a > bb) { const tmp = a; a = bb; bb = tmp; }
          if (a > t0) t0 = a;
          if (bb < t1) t1 = bb;
        }
        if (t0 <= t1 && t1 >= 0) t = Math.max(0, t0);
      } else {
        rt.pp[3 * i] = b.p.x; rt.pp[3 * i + 1] = b.p.y; rt.pp[3 * i + 2] = b.p.z;
        segOf(rt, i, 0);
        seg[6] = eye.x; seg[7] = eye.y; seg[8] = eye.z; seg[9] = eye.x + ux * maxDist; seg[10] = eye.y + uy * maxDist; seg[11] = eye.z + uz * maxDist;
        segSeg();
        const s0 = segS, tt = segT;
        const dx = seg[0] + (seg[3] - seg[0]) * s0 - (seg[6] + (seg[9] - seg[6]) * tt);
        const dy = seg[1] + (seg[4] - seg[1]) * s0 - (seg[7] + (seg[10] - seg[7]) * tt);
        const dz = seg[2] + (seg[5] - seg[2]) * s0 - (seg[8] + (seg[11] - seg[8]) * tt);
        const r = rt.dim[3 * i], d2 = dx * dx + dy * dy + dz * dz;
        if (d2 <= r * r) t = Math.max(0, tt * maxDist - Math.sqrt(r * r - d2));
      }
      if (t < best) { best = t; id = b.id; }
    }
    return id;
  } catch {
    return '';
  }
}

// ------------------------------------------------------------------------------------------------ views

const viewCache = new WeakMap<PropsState, PropView[]>();

/** Poses for the renderer (src/render/space/props.ts). The array and its objects are reused between calls. */
export function propViews(s: PropsState): PropView[] {
  try {
    const rt = runtime(s.layoutId);
    if (!rt) return [];
    let out = viewCache.get(s);
    if (!out || out.length !== rt.n) {
      out = rt.defs.map((d) => ({ id: d.id, type: d.type, pos: v3(), quat: { x: 0, y: 0, z: 0, w: 1 }, room: '', stowed: false, asleep: false, grabbed: false }));
      viewCache.set(s, out);
    }
    const rooms = rt.layout.rooms;
    for (let i = 0; i < rt.n; i++) {
      const b = s.bodies[i], o = out[i], p = b.p;
      o.pos.x = p.x; o.pos.y = p.y; o.pos.z = p.z;
      o.quat.x = b.q.x; o.quat.y = b.q.y; o.quat.z = b.q.z; o.quat.w = b.q.w;
      o.stowed = b.stowed; o.asleep = b.asleep; o.grabbed = s.grab.id === b.id;
      let room = '';
      for (let k = 0; k < rooms.length; k++) {
        const lo = rooms[k].box.min, hi = rooms[k].box.max;
        if (p.x >= lo.x && p.x <= hi.x && p.y >= lo.y && p.y <= hi.y && p.z >= lo.z && p.z <= hi.z) { room = rooms[k].id; break; }
      }
      o.room = room;
    }
    return out;
  } catch {
    return [];
  }
}

/** Collision shape and mass of an object, for UI (e.g. "too heavy to carry") and debugging. */
export function propInfo(s: PropsState, propId: string): { type: PropType; mass: number; bound: number } | null {
  const rt = runtime(s.layoutId), i = rt ? rt.index.get(propId) ?? -1 : -1;
  return rt && i >= 0 ? { type: rt.types[i], mass: rt.mass[i], bound: rt.bound[i] } : null;
}
