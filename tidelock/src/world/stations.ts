// Stations as rigid bodies with a rotor (docs/SIMULATION.md W2-C item 3, D5): mass and inertia from the layouts'
// modules (enclosed volume × density, trusses per metre, panels per area), the habitat ring as a gyrostat rotor with
// its spin from D5, the rotor angle in closed form, the exact torque-free motion of an axisymmetric gyrostat, and the
// contact body of the rotating colliders (velocity Ω × r, spokes turned by θ; an impulse changes the rotor's h).
// Pure, deterministic; the per-step functions allocate nothing. SI, station-local axes (+Y the main/spin axis).
//
// WIRING (wave 2):
// - setup.ts createWorld (W2-B), per station, at construction AND at load (derived, not saved):
//     const mp = stationMassProps(layout)   // cached per layout
//     dryMass = mp.mass; gyration = mp.gyration (the DIAGONAL of the inertia tensor about mp.com in station axes,
//     ÷ mass; NOT principal unless mp.products ≈ 0: true for the Wheel, spindle, outpost and citadel; the refinery's
//     largest product is 46% of its smallest moment and the drydock's 144% (its Iy 2.96e12 vs principal 1.58e12), so
//     those two need W3-A's full tensor `mp.tensor` or principal axes)
//     rotor fields (§1.4, saved): rotorOmega/rotorAngle0/rotorT0/rotorH = initRotor(mp.rotor, t) (or loadRotor(raw))
//   mp.com is the CoM in layout coordinates. Offsets |com|: ringHabitat 0.26 m (0, 0.26, 0), citadel 0.00 m,
//   outpost 24.6 m (0, 24.6, 0), spindle 61.1 m (0, −61.1, 0), refinery 62.0 m (−52.3, 31.2, −11.8), drydock 186.5 m
//   (88.8, 164.0, 2.0). Shift colliders, ports (and the renderer) by −com, or keep `com` (W3-A); either way the craft's
//   position must be the CoM, or gravity and rotation act about the wrong point. Replaces STATION_MASS = 1e9 and
//   the box gyration.
// - dynamics.ts rotateCraft (W2-B's Euler term): I·ω̇ = τ − ω × (I·ω + rotorH). Torque-free and axisymmetric
//   (the Wheel coasting), gyrostatFree(q, w, I, h, dt) is exact at any dt (warp-free); a GG torque needs the ODE.
// - contact.ts: split the station's compound into static and rotating colliders once: rotorSplit(layout) →
//   stationCompound(split.fixed), stationCompound(split.rotor) (cached by array). For the rotor compound use
//   rotorContactBody(RB, station, mp, rotorState, t) instead of bodyFromCraft, solve, then
//   rotorContactAfter(RB, station, mp, rotorState, t). Linear and transverse angular impulse go to the station,
//   the axial part to the rotor (ΔΩ = ΔL_y / I_rotor; θ re-based so the angle stays continuous).
// - Renderer (W2-F): rotorAngle(rotorState, t) for the ring and spokes. Rate: per frame (render), per contact solve.
// Reads §1.4: rotorH, rotorOmega, rotorAngle0, rotorT0 (writes them on an impulse). Budget: rotorContactBody +
// rotorContactAfter ≈ 0.1 µs in node; gyrostatFree ≈ 0.2 µs.

import type { Quat, StationCollider, StationLayout, V3 } from '../core/types';
import { CITADEL, DRYDOCK, OUTPOST, REFINERY, RING_HABITAT, SPINDLE } from '../data/stationLayouts';
import type { ContactBody } from './compound';

// Transcendental wrappers (§1.1 rule 6; wave 2 moves them into math.ts with the others).
const msin = (x: number): number => Math.sin(x);
const mcos = (x: number): number => Math.cos(x);

/** D5 default spin of the Wheel's ring, rad/s: 1 g at the 441 m rim (66 m/s). The layout's 0.09 is the alternative. */
export const WHEEL_SPIN = 0.149;
const TWO_PI = 2 * Math.PI;

// ------------------------------------------------------------------------------------------------ densities

/** Pressurised habitat, per m³ of enclosed volume (W2-C item 3). */
export const RHO_HAB = 120;
/** Industrial halls and machinery, kg/m³; armoured keep; cargo container stacks; dry tanks (contents separate). */
export const RHO_INDUSTRIAL = 250;
export const RHO_ARMOURED = 300;
export const RHO_CARGO = 150;
export const RHO_TANK = 15;
/** Open-frame decks and gantries as a volume, kg/m³; trusses per metre, kg/m; panels (radiators, solar) per m², kg/m². */
export const RHO_FRAME = 30;
export const TRUSS_HEAVY = 5000;
export const TRUSS_LIGHT = 2000;
export const PANEL_AREAL = 8;
export const SOLAR_AREAL = 3;

// ------------------------------------------------------------------------------------------------ modules

/** A module: uniform solid primitive. `rotor` 1 = the habitat rotor, ±2 = counter-rotating drums (+Y / −Y half). */
type Module =
  | { k: 'cyl'; a: V3; b: V3; r: number; rho: number; rotor: number }
  | { k: 'box'; c: V3; h: V3; rho: number; rotor: number }
  | { k: 'sphere'; c: V3; r: number; rho: number; rotor: number }
  | { k: 'annulus'; y: number; ri: number; ro: number; hh: number; rho: number; rotor: number }
  | { k: 'rod'; a: V3; b: V3; mpl: number; rotor: number };

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });
const radial = (az: number, r: number, y: number): V3 => v(mcos(az) * r, y, -msin(az) * r);
const cyl = (a: V3, b: V3, r: number, rho: number, rotor = 0): Module => ({ k: 'cyl', a, b, r, rho, rotor });
const box = (c: V3, h: V3, rho: number, rotor = 0): Module => ({ k: 'box', c, h, rho, rotor });
const sph = (c: V3, r: number, rho: number, rotor = 0): Module => ({ k: 'sphere', c, r, rho, rotor });
const rod = (a: V3, b: V3, mpl: number): Module => ({ k: 'rod', a, b, mpl, rotor: 0 });
const DEG = Math.PI / 180;

function wheelModules(): Module[] {
  const D = RING_HABITAT, m: Module[] = [];
  m.push({ k: 'annulus', y: 0, ri: D.ringInner, ro: D.ringOuter, hh: D.ringHalfWidth, rho: RHO_HAB, rotor: 1 });
  for (let k = 0; k < D.spokes; k++) {
    const az = D.spokeAz0 + (k * TWO_PI) / D.spokes;
    m.push(cyl(radial(az, 66, 0), radial(az, D.ringInner, 0), 9, RHO_HAB, 1));
  }
  m.push(cyl(v(0, -40, 0), v(0, 40, 0), D.sleeveR, RHO_HAB, 1)); // rotor sleeve
  m.push(cyl(v(0, -128, 0), v(0, -40, 0), 46, RHO_HAB));          // de-spun axle
  m.push(cyl(v(0, 40, 0), v(0, 128, 0), 46, RHO_HAB));
  for (const s of [1, -1]) {
    m.push(cyl(v(0, s * D.drumY0, 0), v(0, s * (D.drumY1 - 18), 0), D.drumR, RHO_HAB)); // docking drums
    m.push(cyl(v(0, s * 196, 0), v(0, s * 212, 0), 27, RHO_HAB));                         // polar stacks
  }
  for (const az of [60, 180, 300]) m.push(sph(radial(az * DEG, 50, 212), 18, RHO_FRAME));
  for (const az of D.vaneAz) for (const y of [-174, -150, -126]) {
    // radiator vane: a panel 26 m wide from r 72 to vaneR1, as a rod of its mass per metre
    m.push(rod(radial(az, 72, y), radial(az, D.vaneR1, y), PANEL_AREAL * 26));
  }
  return m;
}

function spindleModules(): Module[] {
  const D = SPINDLE, m: Module[] = [];
  m.push(cyl(v(0, -270, 0), v(0, 274, 0), D.spineR, RHO_INDUSTRIAL));
  for (const s of [1, -1]) m.push(cyl(v(0, s * D.drumY0, 0), v(0, s * D.drumY1, 0), D.drumR, RHO_HAB, s > 0 ? 2 : -2));
  m.push(box(v(0, D.tierL[0], 0), v(D.tierL[1], D.tierL[3], D.tierL[2]), RHO_HAB));
  m.push(box(v(0, D.tierM[0], 0), v(D.tierM[2], D.tierM[3], D.tierM[1]), RHO_HAB));
  m.push(box(v(0, D.tierS[0], 0), v(D.tierS[1], D.tierS[3], D.tierS[2]), RHO_HAB));
  for (let k = 0; k < D.racks; k++) for (const y of [-150, -205, -260]) {
    const az = (k * TWO_PI) / D.racks;
    m.push(cyl(radial(az, 30, y), radial(az, D.rackR - 8, y), 28, RHO_CARGO));
  }
  return m;
}

function refineryModules(): Module[] {
  const D = REFINERY, m: Module[] = [];
  const [px, py, pz, hx, hy, hz] = D.pier;
  m.push(box(v(0, 0, 0), v(D.deckX, D.deckT, D.deckZ), RHO_FRAME));
  m.push(box(v(px, py, pz), v(hx, hy, hz), RHO_HAB));
  for (const [x, z] of D.spheres) m.push(sph(v(x, D.sphereY, z), D.sphereR, RHO_TANK));
  m.push(cyl(v(-235, 36, -30), v(-105, 36, -30), 38, RHO_INDUSTRIAL));
  for (const x of D.stackX) m.push(cyl(v(x, 70, D.stackZ), v(x, D.stackTop, D.stackZ), 11, RHO_FRAME));
  for (const z of [42, -42]) m.push(cyl(v(140, 36, z), v(236, 36, z), 30, RHO_TANK));
  for (const x of [150, 188, 226]) m.push(cyl(v(x, 20, 0), v(x, 128, 0), 9, RHO_INDUSTRIAL));
  for (const z of [46, -46]) m.push(sph(v(-296, 34, z), 30, RHO_INDUSTRIAL));
  const cs = mcos(D.wingDroop), sn = msin(D.wingDroop);
  for (const s of [1, -1]) for (const t of [24, 72, 122]) {
    // three radiator beams per wing slope, each carrying a third of the wing's panel area
    const y = -4 - sn * t, z = s * (D.deckZ + 4 + cs * t);
    m.push(rod(v(-D.wingX, y, z), v(D.wingX, y, z), (PANEL_AREAL * D.wingLen) / 3 + TRUSS_LIGHT));
  }
  return m;
}

function outpostModules(): Module[] {
  const D = OUTPOST, m: Module[] = [];
  m.push(rod(v(0, -D.trussHalf, 0), v(0, D.trussHalf, 0), TRUSS_LIGHT));
  m.push(cyl(v(-D.habHalf, 0, 0), v(D.habHalf, 0, 0), 8, RHO_HAB));
  m.push(cyl(v(-D.canHalf, D.canY, 0), v(D.canHalf, D.canY, 0), 7.5, RHO_HAB));
  for (const s of [1, -1]) {
    m.push(rod(v(s * 10, D.wingY, 0), v(s * D.wingReach, D.wingY, 0), SOLAR_AREAL * 18 + 200));
    m.push(rod(v(s * 8, D.radiatorY, 0), v(s * 32, D.radiatorY, 0), PANEL_AREAL * 14));
  }
  m.push(sph(v(0, D.tankY, 0), 17, RHO_TANK));
  m.push(sph(v(0, D.trussHalf - 2, 0), 13, RHO_HAB));
  return m;
}

function drydockModules(): Module[] {
  const D = DRYDOCK, m: Module[] = [];
  for (const sx of [1, -1]) for (const sz of [1, -1]) m.push(rod(v(sx * D.halfX, -D.halfY, sz * D.halfZ), v(sx * D.halfX, D.halfY, sz * D.halfZ), TRUSS_HEAVY));
  for (const y of D.portals) {
    for (const sz of [1, -1]) m.push(rod(v(-D.halfX, y, sz * D.halfZ), v(D.halfX, y, sz * D.halfZ), TRUSS_LIGHT));
    for (const sx of [1, -1]) m.push(rod(v(sx * D.halfX, y, -D.halfZ), v(sx * D.halfX, y, D.halfZ), TRUSS_LIGHT));
  }
  m.push(cyl(v(0, D.hullY0, 0), v(0, D.hullY1, 0), D.hullR, RHO_FRAME));
  m.push(cyl(v(D.officeX, D.officeY0, 0), v(D.officeX, D.officeY1, 0), D.officeHalfX, RHO_HAB));
  for (const y of D.cranes) m.push(rod(v(-D.halfX, y, D.halfZ + 6), v(D.halfX, y, D.halfZ + 6), TRUSS_HEAVY));
  return m;
}

function citadelModules(): Module[] {
  const D = CITADEL, m: Module[] = [];
  // octagonal keep as the cylinder of equal cross-section area (8·tan(π/8)·a² = π·r²)
  const r = D.keepR * Math.sqrt((8 * Math.tan(Math.PI / 8)) / Math.PI);
  m.push(cyl(v(0, -D.keepY, 0), v(0, D.keepY, 0), r, RHO_ARMOURED));
  for (const s of [1, -1]) {
    m.push(cyl(v(0, s * D.keepY, 0), v(0, s * D.capY, 0), 0.5 * r, RHO_ARMOURED)); // end frusta (mean radius)
    m.push(rod(v(0, s * D.capY, 0), v(0, s * D.mastY, 0), TRUSS_LIGHT));
  }
  for (let k = 0; k < 4; k++) {
    const az = (k * Math.PI) / 2;
    m.push(cyl(radial(az, D.armR0, 0), radial(az, 236, 0), 44, RHO_HAB));
    m.push(cyl(radial(az, 236, 0), radial(az, D.armR1 - 30, 0), 30, RHO_HAB));
  }
  return m;
}

const MODULES: Record<string, () => Module[]> = {
  ringHabitat: wheelModules, spindle: spindleModules, refinery: refineryModules, outpost: outpostModules,
  drydock: drydockModules, citadel: citadelModules,
};

/** Fallback for an unknown layout: every collider as enclosed habitat volume (overlaps counted twice). */
function colliderModules(cols: readonly StationCollider[]): Module[] {
  return cols.map((c) => (c.kind === 'capsule' && c.b ? cyl(c.a, c.b, c.radius, RHO_HAB) : sph(c.a, c.radius, RHO_HAB)));
}

// ------------------------------------------------------------------------------------------------ mass properties

/** Mass, CoM-free second moments: per module mass m, centre c and the inertia tensor about its own centre. */
function moduleProps(md: Module, out: Float64Array): void {
  // out: [m, cx, cy, cz, Ixx, Iyy, Izz, Ixy, Ixz, Iyz] about the module centre
  out.fill(0);
  let m = 0;
  const axial = (a: V3, b: V3, Ia: number, It: number): void => {
    // I = It·(E − uuᵀ) + Ia·uuᵀ
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, L = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const ux = dx / L, uy = dy / L, uz = dz / L, d = Ia - It;
    out[4] = It + d * ux * ux; out[5] = It + d * uy * uy; out[6] = It + d * uz * uz;
    out[7] = d * ux * uy; out[8] = d * ux * uz; out[9] = d * uy * uz;
    out[1] = 0.5 * (a.x + b.x); out[2] = 0.5 * (a.y + b.y); out[3] = 0.5 * (a.z + b.z);
  };
  switch (md.k) {
    case 'cyl': {
      const L = Math.hypot(md.b.x - md.a.x, md.b.y - md.a.y, md.b.z - md.a.z);
      m = md.rho * Math.PI * md.r * md.r * L;
      axial(md.a, md.b, 0.5 * m * md.r * md.r, (m * (3 * md.r * md.r + L * L)) / 12);
      break;
    }
    case 'rod': {
      const L = Math.hypot(md.b.x - md.a.x, md.b.y - md.a.y, md.b.z - md.a.z);
      m = md.mpl * L;
      axial(md.a, md.b, 0, (m * L * L) / 12);
      break;
    }
    case 'box': {
      const { x: a, y: b, z: c } = md.h;
      m = md.rho * 8 * a * b * c;
      out[4] = (m * (4 * b * b + 4 * c * c)) / 12; out[5] = (m * (4 * a * a + 4 * c * c)) / 12; out[6] = (m * (4 * a * a + 4 * b * b)) / 12;
      out[1] = md.c.x; out[2] = md.c.y; out[3] = md.c.z;
      break;
    }
    case 'sphere':
      m = md.rho * (4 / 3) * Math.PI * md.r ** 3;
      out[4] = out[5] = out[6] = 0.4 * m * md.r * md.r;
      out[1] = md.c.x; out[2] = md.c.y; out[3] = md.c.z;
      break;
    case 'annulus': {
      const s = md.ri * md.ri + md.ro * md.ro, H = 2 * md.hh;
      m = md.rho * Math.PI * (md.ro * md.ro - md.ri * md.ri) * H;
      out[5] = 0.5 * m * s;
      out[4] = out[6] = 0.25 * m * s + (m * H * H) / 12;
      out[2] = md.y;
      break;
    }
  }
  out[0] = m;
}

export interface RotorDef {
  /** Moment of inertia of the rotating part about the station's +Y axis, kg·m², and its mass, kg. */
  I: number;
  mass: number;
  /** Spin relative to the station body (D5 for the Wheel), rad/s. */
  omega0: number;
  /** Counter-rotating pair (+Y half at +Ω, −Y half at −Ω, net h = 0, axial impulses go to the body through the gearing). */
  counter: boolean;
}

export interface StationMassProps {
  mass: number;
  /** Centre of mass in layout coordinates, m. */
  com: V3;
  /**
   * Moments about the CoM along the station axes, kg·m², and the products of inertia (Ixy, Ixz, Iyz) those axes
   * neglect; `principal` are the eigenvalues of the full tensor. Where |products| is not ≪ inertia (drydock: the
   * largest product 1.44× its smallest moment; refinery 0.46×) the station axes are not principal: W3-A's full
   * `inertia: number[6]` takes `tensor`.
   */
  inertia: V3;
  products: V3;
  principal: V3;
  tensor: number[];
  /** inertia / mass, m² (Craft.gyration). */
  gyration: V3;
  rotor: RotorDef | null;
  modules: number;
}

const CACHE = new WeakMap<StationLayout, StationMassProps>();

/** Mass properties of a station from its layout's modules (cached per layout object). §1.4, W2-C day 1. */
export function stationMassProps(layout: StationLayout): StationMassProps {
  const hit = CACHE.get(layout);
  if (hit) return hit;
  const mods = (MODULES[layout.visualId] ?? (() => colliderModules(layout.colliders)))();
  const P = new Float64Array(10);
  let M = 0, cx = 0, cy = 0, cz = 0;
  const all: Float64Array[] = [];
  let rI = 0, rM = 0, counter = false;
  for (const md of mods) {
    moduleProps(md, P);
    all.push(P.slice());
    M += P[0]; cx += P[0] * P[1]; cy += P[0] * P[2]; cz += P[0] * P[3];
    if (md.rotor !== 0) {
      // axial moment about the station's Y axis (parallel axis in x and z)
      rI += P[5] + P[0] * (P[1] * P[1] + P[3] * P[3]);
      rM += P[0];
      if (Math.abs(md.rotor) === 2) counter = true;
    }
  }
  cx /= M; cy /= M; cz /= M;
  let Ixx = 0, Iyy = 0, Izz = 0, Ixy = 0, Ixz = 0, Iyz = 0;
  for (const p of all) {
    const m = p[0], dx = p[1] - cx, dy = p[2] - cy, dz = p[3] - cz;
    Ixx += p[4] + m * (dy * dy + dz * dz); Iyy += p[5] + m * (dx * dx + dz * dz); Izz += p[6] + m * (dx * dx + dy * dy);
    Ixy += p[7] - m * dx * dy; Ixz += p[8] - m * dx * dz; Iyz += p[9] - m * dy * dz;
  }
  const spin = layout.visualId === 'ringHabitat' ? WHEEL_SPIN : layout.visualId === 'spindle' ? SPINDLE.spin : 0;
  const out: StationMassProps = {
    mass: M,
    com: v(cx, cy, cz),
    inertia: v(Ixx, Iyy, Izz),
    products: v(Ixy, Ixz, Iyz),
    principal: eigenSym(Ixx, Iyy, Izz, Ixy, Ixz, Iyz),
    tensor: [Ixx, Iyy, Izz, Ixy, Ixz, Iyz],
    gyration: v(Ixx / M, Iyy / M, Izz / M),
    rotor: rM > 0 ? { I: counter ? rI / 2 : rI, mass: rM, omega0: spin, counter } : null,
    modules: mods.length,
  };
  CACHE.set(layout, out);
  return out;
}

/** Eigenvalues of a symmetric 3×3 (cyclic Jacobi; load time), ascending order of the axes kept. */
function eigenSym(a: number, b: number, c: number, xy: number, xz: number, yz: number): V3 {
  const A = [[a, xy, xz], [xy, b, yz], [xz, yz, c]];
  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0;
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) off += A[p][q] * A[p][q];
    if (off <= 1e-30 * (a * a + b * b + c * c)) break;
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
      if (A[p][q] === 0) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
      for (let k = 0; k < 3; k++) { const x = A[k][p], y = A[k][q]; A[k][p] = cs * x - sn * y; A[k][q] = sn * x + cs * y; }
      for (let k = 0; k < 3; k++) { const x = A[p][k], y = A[q][k]; A[p][k] = cs * x - sn * y; A[q][k] = sn * x + cs * y; }
    }
  }
  return v(A[0][0], A[1][1], A[2][2]);
}

// ------------------------------------------------------------------------------------------------ rotor state

/** The §1.4 rotor fields of a station (saved). h = I_rotor·Ω along +Y (0 for a counter-rotating pair). */
export interface RotorState {
  rotorH: V3;
  rotorOmega: number;
  rotorAngle0: number;
  rotorT0: number;
}

export function initRotor(def: RotorDef | null, t: number, angle0 = 0): RotorState {
  const w = def ? def.omega0 : 0;
  return { rotorH: v(0, def && !def.counter ? def.I * w : 0, 0), rotorOmega: w, rotorAngle0: angle0, rotorT0: t };
}

/** Rotor angle relative to the station body at time t, rad (θ₀ + Ω·(t − t₀), in doubles: analytic under any warp). */
export function rotorAngle(r: RotorState, t: number): number {
  return r.rotorAngle0 + r.rotorOmega * (t - r.rotorT0);
}

export function saveRotor(r: RotorState): RotorState {
  return { rotorH: { x: r.rotorH.x, y: r.rotorH.y, z: r.rotorH.z }, rotorOmega: r.rotorOmega, rotorAngle0: r.rotorAngle0, rotorT0: r.rotorT0 };
}

/** Loader with defaults (an old save: the rotor at its data spin, angle 0 at t). h is re-derived from Ω (never trusted). */
export function loadRotor(raw: unknown, def: RotorDef | null, t: number): RotorState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  const r = initRotor(def, num(o.rotorT0, t), num(o.rotorAngle0, 0));
  if (def) {
    r.rotorOmega = num(o.rotorOmega, def.omega0);
    r.rotorH.y = def.counter ? 0 : def.I * r.rotorOmega;
  }
  return r;
}

/** Re-base the angle at t (keeps θ continuous; reduces θ₀ mod 2π so the doubles keep their precision). */
function rebase(r: RotorState, t: number): void {
  let a = r.rotorAngle0 + r.rotorOmega * (t - r.rotorT0);
  a -= TWO_PI * Math.floor(a / TWO_PI);
  r.rotorAngle0 = a;
  r.rotorT0 = t;
}

/** An axial angular impulse dL (N·m·s, about +Y) on a free rotor: ΔΩ = dL / I_rotor, θ continuous at t. */
export function rotorImpulse(r: RotorState, def: RotorDef, dL: number, t: number): void {
  rebase(r, t);
  r.rotorOmega += dL / def.I;
  r.rotorH.y = def.counter ? 0 : def.I * r.rotorOmega;
}

// ------------------------------------------------------------------------------------------------ gyrostat

/**
 * Exact torque-free motion over dt of an axisymmetric gyrostat (Ix = Iz = It about the transverse axes, Iy about the
 * symmetry axis +Y, internal momentum h along +Y in body axes, ω body axes): L_world is constant, ω_y is constant,
 * the transverse ω turns at λ = ((Iy − It)·ω_y + h)/It about −Y in the body, and
 *   q(t) = R(L̂, |L|·t/It) ⊗ q₀ ⊗ R(ŷ, −λ·t).
 * Unconditionally exact (warp-free). q and w are updated in place; nothing allocates.
 */
export function gyrostatFree(q: Quat, w: V3, It: number, Iy: number, h: number, dt: number): void {
  const lam = ((Iy - It) * w.y + h) / It;
  // L in body axes, then world
  const lx = It * w.x, ly = Iy * w.y + h, lz = It * w.z;
  rot(LW, q, lx, ly, lz);
  const L = Math.sqrt(LW.x * LW.x + LW.y * LW.y + LW.z * LW.z);
  // Euler: ẇx = λ·wz, ẇz = −λ·wx, so (wx, wz) turns by λ·dt about +Y as seen in the body.
  const a = lam * dt, c = mcos(a), s = msin(a);
  const wx = w.x * c + w.z * s, wz = -w.x * s + w.z * c;
  w.x = wx; w.z = wz;
  // q ← R(L̂, L·dt/It) ⊗ q ⊗ R(ŷ, −λ·dt)
  const half = -0.5 * a, sb = msin(half), cb = mcos(half);
  qmul(q, q.x, q.y, q.z, q.w, 0, sb, 0, cb);
  if (L > 0) {
    const ang = 0.5 * (L * dt) / It, sa = msin(ang) / L;
    qmul(q, LW.x * sa, LW.y * sa, LW.z * sa, mcos(ang), q.x, q.y, q.z, q.w);
  }
  const n = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  q.x /= n; q.y /= n; q.z /= n; q.w /= n;
}

const LW: V3 = { x: 0, y: 0, z: 0 };

function rot(out: V3, q: Quat, x: number, y: number, z: number): V3 {
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

/** out = a ⊗ b from components (out may be either operand's owner: components are read first). */
function qmul(out: Quat, ax: number, ay: number, az: number, aw: number, bx: number, by: number, bz: number, bw: number): void {
  out.x = aw * bx + ax * bw + ay * bz - az * by;
  out.y = aw * by - ax * bz + ay * bw + az * bx;
  out.z = aw * bz + ax * by - ay * bx + az * bw;
  out.w = aw * bw - ax * bx - ay * by - az * bz;
}

/** World angular momentum of a gyrostat (body inertia diag(It, Iy, It), h along body +Y) -> out. */
export function gyrostatL(q: Quat, w: V3, It: number, Iy: number, h: number, out: V3): V3 {
  return rot(out, q, It * w.x, Iy * w.y + h, It * w.z);
}

// ------------------------------------------------------------------------------------------------ rotating colliders

/** The layout's colliders split into those fixed to the station body and those on the rotor (cached per layout). */
export interface RotorSplit {
  fixed: StationCollider[];
  rotor: StationCollider[];
  /** For a counter-rotating pair: the sign of each rotor collider's spin (+1 / −1), index-aligned with `rotor`. */
  sign: Int8Array;
}

const SPLIT = new WeakMap<StationLayout, RotorSplit>();

/**
 * Which colliders turn: the Wheel's ring, spokes and rotor-sleeve hub (everything in its y = 0 plane), the spindle's
 * drums (the tori at r 72 between its drum heights; +Y drum at +Ω, −Y at −Ω).
 */
export function rotorSplit(layout: StationLayout): RotorSplit {
  const hit = SPLIT.get(layout);
  if (hit) return hit;
  const fixed: StationCollider[] = [], rotor: StationCollider[] = [], sign: number[] = [];
  for (const c of layout.colliders) {
    const b = c.b ?? c.a;
    let turns = false, sg = 1;
    if (layout.visualId === 'ringHabitat') turns = Math.abs(c.a.y) < 1 && Math.abs(b.y) < 1;
    else if (layout.visualId === 'spindle') {
      const ra = Math.hypot(c.a.x, c.a.z), rb = Math.hypot(b.x, b.z);
      turns = c.kind === 'capsule' && Math.abs(ra - 72) < 1 && Math.abs(rb - 72) < 1 && Math.abs(c.a.y) >= SPINDLE.drumY0 && Math.abs(c.a.y) <= SPINDLE.drumY1;
      sg = c.a.y > 0 ? 1 : -1;
    }
    if (turns) { rotor.push(c); sign.push(sg); } else fixed.push(c);
  }
  const out = { fixed, rotor, sign: Int8Array.from(sign) };
  SPLIT.set(layout, out);
  return out;
}

interface StationLike { rel: V3; relV: V3; q: Quat; w: V3 }

/**
 * Point `out` (owns its vectors: use makeContactBody()) at the rotor of a station at time t, for the compound solver:
 * pose = station pose turned by θ about +Y, ω (rotor axes) = R(ŷ,θ)ᵀ·ω_station + Ω·ŷ, mass = the whole station,
 * inverse inertia transverse = the station's, axial = 1/I_rotor (a free rotor takes the axial impulse), or the
 * station's for a counter-rotating geared pair. `sign` −1 for the −Y drum of a pair. The Wheel's transverse moments
 * are equal (3- and 6-fold symmetry), so the transverse inverse inertia is rotation-invariant about +Y.
 */
export function rotorContactBody(out: ContactBody, st: StationLike, mp: StationMassProps, r: RotorState, t: number, sign = 1): ContactBody {
  const th = sign * rotorAngle(r, t), h = 0.5 * th, s = msin(h), c = mcos(h);
  out.p.x = st.rel.x; out.p.y = st.rel.y; out.p.z = st.rel.z;
  out.v.x = st.relV.x; out.v.y = st.relV.y; out.v.z = st.relV.z;
  qmul(out.q, st.q.x, st.q.y, st.q.z, st.q.w, 0, s, 0, c);
  // ω in rotor axes: rotate the station-body ω by −θ about Y, add the relative spin
  const cs = mcos(th), sn = msin(th), w = st.w;
  out.w.x = w.x * cs - w.z * sn;
  out.w.z = w.x * sn + w.z * cs;
  out.w.y = w.y + sign * r.rotorOmega;
  out.invMass = 1 / mp.mass;
  out.invI.x = 1 / mp.inertia.x;
  out.invI.z = 1 / mp.inertia.z;
  out.invI.y = mp.rotor && !mp.rotor.counter ? 1 / mp.rotor.I : 1 / mp.inertia.y;
  return out;
}

/**
 * After the solve on a body from rotorContactBody: copy the station's new velocity back, the transverse Δω into the
 * station's ω, and the axial Δω into the rotor (free rotor: ΔΩ, θ re-based at t; geared pair: into the station).
 */
export function rotorContactAfter(b: ContactBody, st: StationLike, mp: StationMassProps, r: RotorState, t: number, sign = 1): void {
  const th = sign * rotorAngle(r, t), cs = mcos(th), sn = msin(th), w = st.w;
  st.relV.x = b.v.x; st.relV.y = b.v.y; st.relV.z = b.v.z;
  // back to station axes: rotate by +θ
  const wx = b.w.x * cs + b.w.z * sn, wz = -b.w.x * sn + b.w.z * cs;
  const dWy = b.w.y - (w.y + sign * r.rotorOmega);
  w.x = wx; w.z = wz;
  if (mp.rotor && !mp.rotor.counter) rotorImpulse(r, mp.rotor, dWy * mp.rotor.I, t);
  else w.y += dWy;
}

/**
 * Kinematics of a point fixed on the rotor at rotor-local r (station body not rotating): position, velocity Ω × r and
 * acceleration −Ω²·r_⊥ in station axes at time t -> pos, vel, acc. For checks and for W2-E's ring gravity.
 */
export function rotorPoint(r: RotorState, t: number, rl: V3, pos: V3, vel: V3, acc: V3): void {
  const th = rotorAngle(r, t), c = mcos(th), s = msin(th), W = r.rotorOmega;
  // R(ŷ, θ)·r: x' = x c + z s, z' = −x s + z c
  pos.x = rl.x * c + rl.z * s; pos.y = rl.y; pos.z = -rl.x * s + rl.z * c;
  vel.x = W * pos.z; vel.y = 0; vel.z = -W * pos.x; // Ω ŷ × p
  acc.x = -W * W * pos.x; acc.y = 0; acc.z = -W * W * pos.z;
}
