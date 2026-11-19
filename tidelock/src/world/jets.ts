// Real thrusters (SIMULATION.md W1-B): per-jet RCS with a minimum-propellant allocation table, the hydrazine
// blowdown pool, the main-drive spool with ignition delay and minimum-throttle hysteresis, jet damping, the
// settled-hold wake time, the Flight Assist line-of-sight test and the applied-force ledger.
//
// Pure, deterministic and allocation-free on every per-step path (preallocated outputs, typed arrays). The only
// allocating functions are the load-time builders (buildJetTable, jetsFromLayout, saveJetState/loadJetState).
//
// WIRING (wave 1; nothing here is called yet):
//   * setup.ts addCraft/shipDef: `c.jets = jetsFromLayout(layout.rcs, RCS_AXIS_THRUST, RCS_VE0)` (after the 4 Z jets
//     of the test's WREN_JETS are added to every hull in shipLayouts.ts); `c.engines = layout.engines.map(e =>
//     engineDef(e.pos, com, 400e3, 34e3))`; `c.jetTable = buildJetTable(c.jets, com)` — rebuilt at load, never saved.
//     `c.maxTorque` is replaced by `torqueAuthority(c.jetTable, rcsBlowdown(c.rcsPropellant), out)`; control.ts'
//     holdTorque keeps its signature and simply receives that authority (hold gains follow it).
//   * dynamics.ts integrateCraft, replacing the lumped `mdot`/`lx,ly,lz` block and rotateCraft's
//     `clamp1(c.torque.x) * c.maxTorque.x` torque: per step, `cmd = [rcs.x, rcs.y, rcs.z, torque.x, torque.y,
//     torque.z]` (already −1..1); `jetsStep(T, cmd, enabled = !landed && !docked && !destroyed, c.rcsPropellant,
//     c.w, comX, comY, comZ, duty, out)` gives the ACTUAL craft-axes force/torque and ṁ_rcs; `engineUpdate(...)`
//     per engine gives the exact step-mean thrust (dt first cut by `engineEventTime` like tank-empty), then
//     `applyEngines(...)` adds their force/torque/ṁ_main/jet damping to the same `out`. qRot(out.f*) → inertial
//     force; out.t* is the rotation torque. Each pool burns its own ṁ (rcsPropellant / propellant).
//     `ledgerAdd(c, ...)` once per step with the step-mean proper force/torque in craft axes (drag: rk4Mean of the
//     stage forces, rotated with qRotInv); `jetEdgeMasks(c.jetDuty, duty, edges)` → emitEvent(jetOn/jetOff);
//     then copy `duty` into `c.jetDuty`. `consumeLedger(c, out)` in dynamics.ts = `consumeLedgerInto(c, out)`.
//   * contact.ts hooks: `ledgerImpulse(c, J, r, m, I)` for every contact / latch capture / undock spring.
//   * control.ts / session.ts settled hold: at settle `c.holdWakeT = t + holdWakeTimeVec(err, wRel, alphaB, db)`
//     (replaces LOOSE_WARP / WAKE_ANGLE_LOOSE / SUSPEND_WARP); Flight Assist uses `faMainDrive` for the
//     0.18/0.12 main-drive hysteresis; session.ts assistRef keeps a candidate only if
//     `assistVisible(c.r, ref.r, FA_RANGE, world.bodies)` (replaces the bare distance test).
//   * world.ts save/load (W1-A migrate): `saveJetState(c)` / `loadJetState(raw, nJets, nEngines, cap)` for the
//     contract fields jetDuty, engineThrust, engineTimer, rcsPropellant(+Capacity), fAcc, tauAcc, accT,
//     dvImpulse, dwImpulse, holdWakeT (+∞ is saved as null: JSON has no Infinity).
//   * sim/ships.ts: rcsExhaustVelocity 2400 → RCS_VE0; propellant split 22.5 t LH2 + RCS_CAPACITY hydrazine.
//   * shipLayouts.ts: the plan's nose Z jets at (±1.0, 0, −14.8) sit INSIDE the front window (w-front: centre
//     (0, 0.35, −15.0), 3.0 × 1.2 m, i.e. x ±1.5, y −0.25..0.95) and inside the cockpit volume (z to −15.0). Move
//     them outboard of the glass, e.g. (±2.2, −0.3, −14.6) on the cheeks; the table re-solves for any position.
//
// Conventions: SI; craft axes (forward −Z, up +Y, right +X); JetDef.dir and EngineDef.dir are EXHAUST
// directions (the force on the ship is −dir); `com` is the centre of mass in craft axes (origin today).

import type { Quat, V3 } from '../core/types';
import { qRotInv } from './math';

// =============================================================================================== constants

/** The fixed simulation tick, s (SIMULATION.md §1.3). */
export const Q = 1 / 120;
/** Command axes: Fx, Fy, Fz, τx, τy, τz. Table column k = 2·axis + (negative ? 1 : 0). */
export const N_AXES = 6;
export const N_COLS = 12;

/** RCS thrust per translation axis, N (shared out equally among the jets with that exhaust direction). */
export const RCS_AXIS_THRUST = 68e3;
/** Hydrazine monopropellant: exhaust velocity at full tank pressure (Isp 229 s), density, pool, tank. */
export const RCS_VE0 = 2250;
export const RCS_DENSITY = 1004;
export const RCS_CAPACITY = 1500;
export const RCS_TANK_VOLUME = 2.24;
/** Blowdown ratio B = p(full)/p(empty) = V_t / V_u0. */
export const RCS_BLOWDOWN = 3;

/** Main drive (each of the Wren's two engines). */
export const ENGINE_THRUST = 400e3;
export const ENGINE_VE = 34e3;
export const ENGINE_TAU_UP = 0.8;
export const ENGINE_TAU_DOWN = 0.3;
export const ENGINE_DELAY = 0.5;
/** Minimum stable throttle (lights at a command ≥ this; runs at no less than this). */
export const ENGINE_MIN_THROTTLE = 0.15;
/** A lit engine goes out when the command falls below this. */
export const ENGINE_OFF_THROTTLE = 0.10;
/** engineTimer value of an engine that is not lit. */
export const ENGINE_UNLIT = -1;

/** Flight Assist uses the main drive above this fraction of a_main and releases it below the second. */
export const FA_MAIN_ON = 0.18;
export const FA_MAIN_OFF = 0.12;

// Transcendental wrappers (SIMULATION §1.1.6): move into world/math.ts when wave 1 wires this file.
const exp = (x: number): number => Math.exp(x);
const expm1 = (x: number): number => Math.expm1(x);

// =============================================================================================== types

/** One RCS jet: position (craft axes, m), unit EXHAUST direction, thrust and exhaust velocity at p = p₀. */
export interface JetDef {
  pos: V3;
  dir: V3;
  thrust: number;
  ve: number;
}

/** One main engine: nozzle exit position, unit exhaust direction, full thrust, vₑ and the transient constants. */
export interface EngineDef {
  pos: V3;
  dir: V3;
  maxThrust: number;
  ve: number;
  tauUp: number;
  tauDown: number;
  delay: number;
  minThrottle: number;
}

/** The at-load jet data: packed geometry and the 12-column allocation table. Rebuilt at load, never saved. */
export interface JetTable {
  n: number;
  /** Per jet, stride GEO: r (3), unit force direction −d (3), thrust F₀, 1/vₑ₀. */
  geo: Float64Array;
  /** 12 × n: column k (2·axis + neg) holds the duties of the full command along that signed axis. */
  table: Float64Array;
  /** Per column, the magnitude it produces along its axis at p = p₀ (N or N·m): the computed authority. */
  authority: Float64Array;
  /** Per column, ṁ (kg/s at p = p₀) at the full command: the propellant price of that axis. */
  cost: Float64Array;
  /** The CoM the table was built at (craft axes). */
  com: V3;
}

/** What a set of jets and engines actually applied over a step (craft axes). */
export interface ThrustOut {
  fx: number; fy: number; fz: number;
  /** Total torque about the CoM, jet damping included, N·m. */
  tx: number; ty: number; tz: number;
  /** The jet-damping part of t*, N·m. */
  dx: number; dy: number; dz: number;
  /** RCS and main-pool mass flow, kg/s. */
  mdotRcs: number;
  mdotMain: number;
  /** Tank pressure ratio p/p₀ the jets ran at. */
  pRatio: number;
}

/** The applied-force ledger: the §1.4 contract fields, held on Craft. */
export interface Ledger {
  fAcc: V3;
  tauAcc: V3;
  accT: number;
  dvImpulse: V3;
  dwImpulse: V3;
}

/** One consumption of the ledger: step-mean proper force (N) and torque (N·m), impulses, the time covered. */
export interface LedgerMean {
  f: V3;
  tau: V3;
  dv: V3;
  dw: V3;
  T: number;
}

const GEO = 8;

export function makeThrustOut(): ThrustOut {
  return { fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0, dx: 0, dy: 0, dz: 0, mdotRcs: 0, mdotMain: 0, pRatio: 1 };
}

export function clearThrustOut(o: ThrustOut): ThrustOut {
  o.fx = o.fy = o.fz = o.tx = o.ty = o.tz = o.dx = o.dy = o.dz = 0;
  o.mdotRcs = o.mdotMain = 0;
  o.pRatio = 1;
  return o;
}

// =============================================================================================== geometry input

const sgn = (x: number): number => (x > 1e-9 ? 1 : x < -1e-9 ? -1 : 0);

/**
 * JetDefs from a layout's `rcs` list ({pos, dir}, dir = exhaust). Each translation axis gets `axisThrust` in each
 * sense, shared equally among the jets with the same exhaust direction (Wren: 34 kN per X and Z jet, 22.7 kN per
 * Y jet). Load time only.
 */
export function jetsFromLayout(rcs: readonly { pos: V3; dir: V3 }[], axisThrust = RCS_AXIS_THRUST, ve = RCS_VE0): JetDef[] {
  const key = (d: V3): string => `${sgn(d.x)},${sgn(d.y)},${sgn(d.z)}`;
  const count = new Map<string, number>();
  for (const j of rcs) count.set(key(j.dir), (count.get(key(j.dir)) ?? 0) + 1);
  return rcs.map((j) => {
    const l = Math.hypot(j.dir.x, j.dir.y, j.dir.z) || 1;
    return {
      pos: { x: j.pos.x, y: j.pos.y, z: j.pos.z },
      dir: { x: j.dir.x / l, y: j.dir.y / l, z: j.dir.z / l },
      thrust: axisThrust / (count.get(key(j.dir)) ?? 1),
      ve,
    };
  });
}

/**
 * An engine whose exhaust is canted in pitch so its thrust line passes through `com` (the Wren's pods sit 0.2 m
 * below the CoM: a 0.73° cant). Yaw offsets cancel by the pair's symmetry and are not canted.
 */
export function engineDef(pos: V3, com: V3, maxThrust = ENGINE_THRUST, ve = ENGINE_VE): EngineDef {
  const dy = pos.y - com.y, dz = pos.z - com.z;
  const l = Math.hypot(dy, dz) || 1;
  return {
    pos: { x: pos.x, y: pos.y, z: pos.z },
    dir: { x: 0, y: dy / l, z: dz / l },
    maxThrust, ve,
    tauUp: ENGINE_TAU_UP, tauDown: ENGINE_TAU_DOWN, delay: ENGINE_DELAY, minThrottle: ENGINE_MIN_THROTTLE,
  };
}

// =============================================================================================== allocation (load time)

/** Scratch of the dense two-phase simplex (m rows, n structural columns). */
interface Lp {
  m: number; n: number; w: number;
  T: Float64Array;
  basis: Int32Array;
}

function makeLp(m: number, n: number): Lp {
  const w = n + m + 1;
  return { m, n, w, T: new Float64Array((m + 1) * w), basis: new Int32Array(m) };
}

const EPS_PIV = 1e-11;
const EPS_RC = 1e-12;

function pivot(L: Lp, r: number, col: number): void {
  const { T, w, m } = L;
  const ro = r * w;
  const p = T[ro + col];
  for (let j = 0; j < w; j++) T[ro + j] /= p;
  T[ro + col] = 1;
  for (let i = 0; i <= m; i++) {
    if (i === r) continue;
    const io = i * w;
    const f = T[io + col];
    if (f === 0) continue;
    for (let j = 0; j < w; j++) T[io + j] -= f * T[ro + j];
    T[io + col] = 0;
  }
  L.basis[r] = col;
}

/** Simplex iterations with Bland's rule (no cycling); only allowed structural columns may enter. */
function iterate(L: Lp, allowed: Uint8Array): boolean {
  const { T, w, m, n, basis } = L;
  const obj = m * w, rhs = w - 1;
  for (let it = 0; it < 500; it++) {
    let enter = -1;
    for (let j = 0; j < n; j++) if (allowed[j] && T[obj + j] < -EPS_RC) { enter = j; break; }
    if (enter < 0) return true;
    let leave = -1, best = Infinity;
    for (let i = 0; i < m; i++) {
      const a = T[i * w + enter];
      if (a <= EPS_PIV) continue;
      const ratio = T[i * w + rhs] / a;
      if (ratio < best - 1e-14 || (ratio <= best + 1e-14 && leave >= 0 && basis[i] < basis[leave])) { best = ratio; leave = i; }
    }
    if (leave < 0) return false; // unbounded (cannot happen with c ≥ 0)
    pivot(L, leave, enter);
  }
  return false;
}

/**
 * min cᵀx subject to A x = b, x ≥ 0 (A is m × n row-major). Writes x; returns the optimal cost, or −1 when the
 * problem is infeasible. Two-phase dense tableau, Bland's rule, redundant rows tolerated.
 */
export function lpMinimize(m: number, n: number, A: ArrayLike<number>, b: ArrayLike<number>, c: ArrayLike<number>, allowed: Uint8Array, x: Float64Array): number {
  const L = makeLp(m, n);
  const { T, w, basis } = L;
  const obj = m * w, rhs = w - 1;
  T.fill(0);
  for (let i = 0; i < m; i++) {
    const s = b[i] < 0 ? -1 : 1;
    for (let j = 0; j < n; j++) T[i * w + j] = allowed[j] ? s * A[i * n + j] : 0;
    T[i * w + n + i] = 1;
    T[i * w + rhs] = s * b[i];
    basis[i] = n + i;
  }
  // phase I: minimise the sum of the artificials
  for (let j = 0; j <= rhs; j++) {
    if (j >= n && j < rhs) continue;
    let s = 0;
    for (let i = 0; i < m; i++) s += T[i * w + j];
    T[obj + j] = -s;
  }
  if (!iterate(L, allowed) || -T[obj + rhs] > 1e-9) { x.fill(0); return -1; }
  // drive artificials out of the basis; a row with no structural entry is redundant and stays as it is
  for (let i = 0; i < m; i++) {
    if (basis[i] < n) continue;
    for (let j = 0; j < n; j++) if (allowed[j] && Math.abs(T[i * w + j]) > 1e-9) { pivot(L, i, j); break; }
  }
  // phase II: the true cost, reduced against the current basis
  for (let j = 0; j <= rhs; j++) {
    let s = j < n ? c[j] : 0;
    for (let i = 0; i < m; i++) { const bi = basis[i]; if (bi < n) s -= c[bi] * T[i * w + j]; }
    T[obj + j] = j < n || j === rhs ? s : 0;
  }
  if (!iterate(L, allowed)) { x.fill(0); return -1; }
  x.fill(0);
  let cost = 0;
  for (let i = 0; i < m; i++) {
    const bi = basis[i];
    if (bi < n) { const v = T[i * w + rhs]; x[bi] = v > 0 ? v : 0; }
  }
  for (let j = 0; j < n; j++) cost += c[j] * x[j];
  return cost;
}

/**
 * Build the jet table: for each of the 12 signed axes, the minimum-propellant duties that give a pure command
 * along that axis (all other force and torque components exactly zero), scaled so the column's largest duty is
 * 1. An axis no combination can produce purely gets a zero column and zero authority. `thrustScale` (optional,
 * per jet, e.g. wave 2's jetHealth) scales each jet; ≤ 0 removes it. Load time; deterministic.
 */
export function buildJetTable(jets: readonly JetDef[], com: V3, thrustScale?: ArrayLike<number>): JetTable {
  const n = jets.length;
  const geo = new Float64Array(n * GEO);
  const A = new Float64Array(N_AXES * n); // physical: N and N·m per unit duty
  const An = new Float64Array(N_AXES * n); // row-normalised for the LP
  const cost = new Float64Array(n);
  const allowed = new Uint8Array(n);
  let fMax = 0, lMax = 0, cMax = 0;
  for (let j = 0; j < n; j++) {
    const J = jets[j];
    const s = thrustScale ? thrustScale[j] : 1;
    const F = J.thrust * (s > 0 ? s : 0);
    const dl = Math.hypot(J.dir.x, J.dir.y, J.dir.z) || 1;
    const ux = -J.dir.x / dl, uy = -J.dir.y / dl, uz = -J.dir.z / dl;
    const rx = J.pos.x - com.x, ry = J.pos.y - com.y, rz = J.pos.z - com.z;
    const o = j * GEO;
    geo[o] = J.pos.x; geo[o + 1] = J.pos.y; geo[o + 2] = J.pos.z;
    geo[o + 3] = ux; geo[o + 4] = uy; geo[o + 5] = uz;
    geo[o + 6] = F; geo[o + 7] = 1 / J.ve;
    A[0 * n + j] = F * ux; A[1 * n + j] = F * uy; A[2 * n + j] = F * uz;
    A[3 * n + j] = F * (ry * uz - rz * uy);
    A[4 * n + j] = F * (rz * ux - rx * uz);
    A[5 * n + j] = F * (rx * uy - ry * ux);
    cost[j] = F / J.ve;
    allowed[j] = F > 0 ? 1 : 0;
    if (F > fMax) fMax = F;
    const rl = Math.hypot(rx, ry, rz);
    if (rl > lMax) lMax = rl;
    if (cost[j] > cMax) cMax = cost[j];
  }
  const fs = fMax > 0 ? 1 / fMax : 0, ts = fMax > 0 && lMax > 0 ? 1 / (fMax * lMax) : 0, cs = cMax > 0 ? 1 / cMax : 0;
  for (let j = 0; j < n; j++) {
    for (let a = 0; a < 3; a++) An[a * n + j] = A[a * n + j] * fs;
    for (let a = 3; a < 6; a++) An[a * n + j] = A[a * n + j] * ts;
  }
  const cn = new Float64Array(n);
  for (let j = 0; j < n; j++) cn[j] = cost[j] * cs;
  const table = new Float64Array(N_COLS * n);
  const authority = new Float64Array(N_COLS);
  const colCost = new Float64Array(N_COLS);
  const b = new Float64Array(N_AXES);
  const x = new Float64Array(n);
  for (let k = 0; k < N_COLS; k++) {
    const axis = k >> 1, sign = k & 1 ? -1 : 1;
    b.fill(0);
    b[axis] = sign;
    if (fMax === 0 || lpMinimize(N_AXES, n, An, b, cn, allowed, x) < 0) continue;
    let um = 0;
    for (let j = 0; j < n; j++) if (x[j] > um) um = x[j];
    if (um <= 0) continue;
    let mag = 0, cc = 0;
    for (let j = 0; j < n; j++) {
      let u = x[j] === um ? 1 : x[j] / um;
      if (u < 1e-12) u = 0;
      table[k * n + j] = u;
      mag += A[axis * n + j] * u;
      cc += cost[j] * u;
    }
    authority[k] = Math.abs(mag);
    colCost[k] = cc;
  }
  return { n, geo, table, authority, cost: colCost, com: { x: com.x, y: com.y, z: com.z } };
}

/** The torque authority per axis (the smaller of ±), N·m, at the tank pressure ratio `pRatio`. Replaces maxTorque. */
export function torqueAuthority(T: JetTable, pRatio: number, out: V3): V3 {
  const a = T.authority;
  out.x = Math.min(a[6], a[7]) * pRatio;
  out.y = Math.min(a[8], a[9]) * pRatio;
  out.z = Math.min(a[10], a[11]) * pRatio;
  return out;
}

/** The force authority per axis (the smaller of ±), N, at `pRatio`. */
export function forceAuthority(T: JetTable, pRatio: number, out: V3): V3 {
  const a = T.authority;
  out.x = Math.min(a[0], a[1]) * pRatio;
  out.y = Math.min(a[2], a[3]) * pRatio;
  out.z = Math.min(a[4], a[5]) * pRatio;
  return out;
}

/** Torque in N·m → the normalised command (−1..1, before clamping) on the signed columns' own authorities. */
export function torqueToCmd(T: JetTable, pRatio: number, tx: number, ty: number, tz: number, cmd: Float64Array): Float64Array {
  const a = T.authority;
  const ax = a[tx < 0 ? 7 : 6] * pRatio, ay = a[ty < 0 ? 9 : 8] * pRatio, az = a[tz < 0 ? 11 : 10] * pRatio;
  cmd[3] = ax > 0 ? tx / ax : 0;
  cmd[4] = ay > 0 ? ty / ay : 0;
  cmd[5] = az > 0 ? tz / az : 0;
  return cmd;
}

// =============================================================================================== per step: RCS

/**
 * Duties for a 6-axis command (each −1..1, clamped): duty = Σ_k |cmd_k|·table[k±]. Saturation: when a duty would
 * exceed 1 the whole duty vector is scaled down by its largest duty (not clipped per jet), so the applied force and
 * torque keep the commanded DIRECTION and only lose magnitude. Per-jet clipping (the plan's first wording) turns a
 * saturated three-axis torque command into 11.3 kN of spurious translation (24% of the smallest force authority;
 * measured in tests/jets.test.ts), which would fail the plan's own "pure torque → |F| ≤ 1%" test and shove the crew and props.
 */
export function allocateJets(T: JetTable, cmd: ArrayLike<number>, duty: Float64Array): Float64Array {
  const n = T.n, tab = T.table;
  for (let j = 0; j < n; j++) duty[j] = 0;
  for (let a = 0; a < N_AXES; a++) {
    let c = cmd[a];
    if (c === 0 || c !== c) continue;
    let o = 2 * a * n;
    if (c < 0) { c = -c; o += n; }
    if (c > 1) c = 1;
    for (let j = 0; j < n; j++) duty[j] += c * tab[o + j];
  }
  let um = 0;
  for (let j = 0; j < n; j++) if (duty[j] > um) um = duty[j];
  if (um > 1) { const k = 1 / um; for (let j = 0; j < n; j++) duty[j] = duty[j] === um ? 1 : duty[j] * k; }
  return duty;
}

/** Tank pressure ratio p/p₀ of an isothermal blowdown pool holding `m` kg: p₀·V_u0/V_u, V_u = V_t − m/ρ. */
export function rcsBlowdown(m: number, volume = RCS_TANK_VOLUME, density = RCS_DENSITY, ratio = RCS_BLOWDOWN): number {
  const vu0 = volume / ratio;
  let vu = volume - (m > 0 ? m : 0) / density;
  if (vu < vu0 * 1e-3) vu = vu0 * 1e-3;
  return vu0 / vu;
}

/** Exhaust-velocity factor at pressure ratio p/p₀: 0.97 + 0.03·p/p₀. */
export const rcsVeFactor = (pRatio: number): number => 0.97 + 0.03 * pRatio;

/**
 * Jet damping torque of one exhaust stream: −ṁ·(|ρ|²ω − (ρ·ω)ρ) = −ṁ|ρ|²ω⊥, ρ = r − com. Added into o.t* and o.d*.
 */
export function addJetDamping(o: ThrustOut, mdot: number, rx: number, ry: number, rz: number, wx: number, wy: number, wz: number): void {
  if (mdot === 0) return;
  const r2 = rx * rx + ry * ry + rz * rz, rw = rx * wx + ry * wy + rz * wz;
  const dx = -mdot * (r2 * wx - rw * rx), dy = -mdot * (r2 * wy - rw * ry), dz = -mdot * (r2 * wz - rw * rz);
  o.dx += dx; o.dy += dy; o.dz += dz;
  o.tx += dx; o.ty += dy; o.tz += dz;
}

/**
 * The force, torque (about `com`) and ṁ the jets actually apply at duties `duty` and pressure ratio `pRatio`
 * (F = F₀·p/p₀, vₑ = vₑ₀·(0.97 + 0.03·p/p₀)), plus jet damping at body rate w. ADDS into `o` (clear it first).
 */
export function applyJets(T: JetTable, duty: Float64Array, pRatio: number, wx: number, wy: number, wz: number, cx: number, cy: number, cz: number, o: ThrustOut): ThrustOut {
  const n = T.n, g = T.geo;
  const fScale = pRatio, mScale = pRatio / rcsVeFactor(pRatio);
  let fx = 0, fy = 0, fz = 0, tx = 0, ty = 0, tz = 0, md = 0;
  for (let j = 0; j < n; j++) {
    const u = duty[j];
    if (u === 0) continue;
    const q = j * GEO;
    const F = u * g[q + 6];
    const rx = g[q] - cx, ry = g[q + 1] - cy, rz = g[q + 2] - cz;
    const ax = F * g[q + 3], ay = F * g[q + 4], az = F * g[q + 5];
    fx += ax; fy += ay; fz += az;
    tx += ry * az - rz * ay; ty += rz * ax - rx * az; tz += rx * ay - ry * ax;
    const mj = F * g[q + 7] * mScale;
    md += mj;
    if (wx !== 0 || wy !== 0 || wz !== 0) addJetDamping(o, mj, rx, ry, rz, wx, wy, wz);
  }
  o.fx += fx * fScale; o.fy += fy * fScale; o.fz += fz * fScale;
  o.tx += tx * fScale; o.ty += ty * fScale; o.tz += tz * fScale;
  o.mdotRcs += md;
  o.pRatio = pRatio;
  return o;
}

/**
 * One RCS step: allocate `cmd`, then compute what the jets actually do. Not `enabled` (landed, docked, destroyed)
 * or a dry pool → all duties 0 and nothing applied. Clears `o` first; ṁ_rcs is o.mdotRcs.
 */
export function jetsStep(T: JetTable, cmd: ArrayLike<number>, enabled: boolean, rcsPropellant: number, wx: number, wy: number, wz: number, cx: number, cy: number, cz: number, duty: Float64Array, o: ThrustOut): ThrustOut {
  clearThrustOut(o);
  if (!enabled || !(rcsPropellant > 0)) {
    for (let j = 0; j < T.n; j++) duty[j] = 0;
    return o;
  }
  allocateJets(T, cmd, duty);
  return applyJets(T, duty, rcsBlowdown(rcsPropellant), wx, wy, wz, cx, cy, cz, o);
}

/** Edges between the last applied duties and the new ones, as bit masks over jets (≤ 31 jets). */
export function jetEdgeMasks(prev: ArrayLike<number>, duty: ArrayLike<number>, n: number, out: { on: number; off: number }): { on: number; off: number } {
  let on = 0, off = 0;
  for (let j = 0; j < n && j < 31; j++) {
    const a = prev[j] > 0, b = duty[j] > 0;
    if (b && !a) on |= 1 << j;
    else if (a && !b) off |= 1 << j;
  }
  out.on = on; out.off = off;
  return out;
}

// =============================================================================================== per step: main drive

/** Minimum-throttle hysteresis on the command: lights at ≥ minThrottle, goes out below ENGINE_OFF_THROTTLE. */
export function engineLatch(lit: boolean, cmd: number, minThrottle = ENGINE_MIN_THROTTLE): boolean {
  return lit ? cmd >= ENGINE_OFF_THROTTLE : cmd >= minThrottle;
}

/** The commanded thrust of a (lit or unlit) engine: lit → max(cmd, minThrottle)·F_max, never between 10 and 15%. */
export function engineCommandThrust(d: EngineDef, lit: boolean, cmd: number): number {
  if (!lit) return 0;
  const c = cmd > 1 ? 1 : cmd < d.minThrottle ? d.minThrottle : cmd;
  return c * d.maxThrust;
}

/** spool() results: [0] the step mean, [1] the end state (typed slots: returned or module-level doubles box). */
const SM = new Float64Array(2);
/** Exact first-order spool from F over h toward Fc (τ_up rising, τ_down falling; it never crosses Fc). */
function spool(F: number, Fc: number, h: number, tauUp: number, tauDown: number): void {
  if (h <= 0 || F === Fc) { SM[0] = F; SM[1] = F; return; }
  const tau = Fc > F ? tauUp : tauDown;
  const x = -h / tau;
  const e = exp(x), om = -expm1(x); // e = e^(−h/τ), om = 1 − e (accurate for small h/τ)
  const d = F - Fc;
  SM[0] = Fc + d * (om / -x); // F̄ = F_c + (F − F_c)·(τ/h)(1 − e^(−h/τ))
  SM[1] = Fc + d * e;
}

/**
 * Advance engine i through h with throttle command `cmd` (latched for the tick) and a non-empty pool `fuel`.
 * State: thrust[i] = F_s (N); timer[i] = ENGINE_UNLIT (−1) when unlit, the ignition delay still to run (> 0), or
 * 0 when burning. Exact at any h (an ignition delay ending inside the step splits it). Writes the exact step-mean
 * thrust F̄ (N) to mean[i]: force −F̄·dir, ṁ = F̄/vₑ. A dry pool is a flame-out: F_s = 0, unlit.
 * (Writes instead of returning: a returned double is a heap allocation when the call is not inlined.)
 */
export function engineUpdate(d: EngineDef, thrust: number[], timer: number[], i: number, cmd: number, h: number, fuel: boolean, mean: { [k: number]: number }): void {
  let t = timer[i];
  if (!fuel) { thrust[i] = 0; timer[i] = ENGINE_UNLIT; mean[i] = 0; return; }
  const wasLit = t >= 0;
  const lit = engineLatch(wasLit, cmd, d.minThrottle);
  if (!lit) t = ENGINE_UNLIT;
  else if (!wasLit) t = d.delay;
  const Fc = engineCommandThrust(d, lit, cmd);
  const F0 = thrust[i];
  if (t > 0) {
    if (h < t && t - h > 1e-12) {
      spool(F0, 0, h, d.tauUp, d.tauDown);
      mean[i] = SM[0];
      t -= h;
    } else {
      const h1 = t < h ? t : h, h2 = h - h1;
      spool(F0, 0, h1, d.tauUp, d.tauDown);
      const m1 = SM[0];
      spool(SM[1], Fc, h2, d.tauUp, d.tauDown);
      mean[i] = h > 0 ? (m1 * h1 + SM[0] * h2) / h : SM[1];
      t = 0;
    }
  } else {
    spool(F0, Fc, h, d.tauUp, d.tauDown);
    mean[i] = SM[0];
  }
  thrust[i] = SM[1];
  timer[i] = t;
}

/** The step-cutting helper: the time until the first ignition delay ends, if it ends inside h; else h. */
export function engineEventTime(timer: ArrayLike<number>, n: number, h: number): number {
  let dt = h;
  for (let i = 0; i < n; i++) { const t = timer[i]; if (t > 0 && t < dt) dt = t; }
  return dt;
}

/**
 * Add the engines' step-mean thrusts `mean[i]` (from engineUpdate) to `o`: force −F̄·dir, torque about com,
 * ṁ_main = ΣF̄/vₑ, jet damping at rate w.
 */
export function applyEngines(defs: readonly EngineDef[], mean: ArrayLike<number>, wx: number, wy: number, wz: number, cx: number, cy: number, cz: number, o: ThrustOut): ThrustOut {
  for (let i = 0; i < defs.length; i++) {
    const F = mean[i];
    if (F === 0) continue;
    const d = defs[i];
    const ax = -F * d.dir.x, ay = -F * d.dir.y, az = -F * d.dir.z;
    const rx = d.pos.x - cx, ry = d.pos.y - cy, rz = d.pos.z - cz;
    o.fx += ax; o.fy += ay; o.fz += az;
    o.tx += ry * az - rz * ay; o.ty += rz * ax - rx * az; o.tz += rx * ay - ry * ax;
    const md = F / d.ve;
    o.mdotMain += md;
    if (wx !== 0 || wy !== 0 || wz !== 0) addJetDamping(o, md, rx, ry, rz, wx, wy, wz);
  }
  return o;
}

/** Flight Assist main-drive hysteresis: engage above FA_MAIN_ON·a_main, release below FA_MAIN_OFF·a_main. */
export function faMainDrive(using: boolean, aReq: number, aMain: number): boolean {
  return using ? aReq >= FA_MAIN_OFF * aMain : aReq > FA_MAIN_ON * aMain;
}

// =============================================================================================== settled hold

/**
 * First t > 0 at which θ₀ + ω·t + ½·α·t² reaches ±θ_db (symmetric deadband), +∞ if never. 0 if |θ₀| ≥ θ_db.
 * Numerically stable roots (no cancellation).
 */
export function holdWakeTime(theta0: number, omega: number, alpha: number, db: number): number {
  if (!(Math.abs(theta0) < db)) return 0;
  let best = Infinity;
  for (let s = -1; s <= 1; s += 2) {
    const a = 0.5 * alpha, b = omega, c = theta0 - s * db;
    if (a === 0) {
      if (b !== 0) { const t = -c / b; if (t > 0 && t < best) best = t; }
      continue;
    }
    const disc = b * b - 4 * a * c;
    if (disc < 0) continue;
    const q = -0.5 * (b + (b >= 0 ? 1 : -1) * Math.sqrt(disc));
    const t1 = q / a, t2 = q !== 0 ? c / q : Infinity;
    if (t1 > 0 && t1 < best) best = t1;
    if (t2 > 0 && t2 < best) best = t2;
  }
  return best;
}

/**
 * The 3-D wake time: first t > 0 with |e + w·t| + ½·α_b·t² = θ_db, e the attitude error (rad, rotation vector),
 * w the residual rate relative to the target frame, α_b ≥ 0 a bound on the disturbing angular acceleration.
 * α_b = 0: the exact root of |e + w t|² = θ_db². α_b > 0: the bound's root, returned from below (conservative).
 */
export function holdWakeTimeVec(ex: number, ey: number, ez: number, wx: number, wy: number, wz: number, alphaB: number, db: number): number {
  const e2 = ex * ex + ey * ey + ez * ez, w2 = wx * wx + wy * wy + wz * wz, ew = ex * wx + ey * wy + ez * wz;
  if (!(e2 < db * db)) return 0;
  if (!(alphaB > 0)) {
    if (w2 === 0) return Infinity;
    // w2·t² + 2·ew·t + (e2 − db²) = 0 with c < 0: exactly one positive root
    const c = e2 - db * db;
    const q = -(ew + (ew >= 0 ? 1 : -1) * Math.sqrt(ew * ew - w2 * c));
    const t1 = q / w2, t2 = c / q;
    return t1 > 0 ? t1 : t2;
  }
  const el = Math.sqrt(e2), wl = Math.sqrt(w2);
  let lo = holdWakeTime(el, wl, alphaB, db); // g ≤ this scalar bound, so g(lo) ≤ 0
  // upper bound: ½α t² + |w| t − |e| − db = 0
  const a = 0.5 * alphaB, cu = -el - db;
  let hi = (-wl + Math.sqrt(wl * wl - 4 * a * cu)) / (2 * a);
  if (!(hi > lo)) return lo;
  for (let k = 0; k < 60; k++) {
    const t = 0.5 * (lo + hi);
    const x = ex + wx * t, y = ey + wy * t, z = ez + wz * t;
    if (Math.sqrt(x * x + y * y + z * z) + a * t * t - db <= 0) lo = t; else hi = t;
  }
  return lo;
}

// =============================================================================================== Flight Assist reference

/** What the line-of-sight test reads from a body. */
export interface LosBody {
  r: V3;
  radius: number;
  atmosphere: { height: number } | null;
}

/**
 * True when the segment a → b clears every body's radius plus its atmosphere top. When an end point is inside a
 * body's atmosphere shell (flying in the air) only the solid radius blocks for that body.
 */
export function lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number, bodies: readonly LosBody[]): boolean {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const l2 = dx * dx + dy * dy + dz * dz;
  for (let i = 0; i < bodies.length; i++) {
    const B = bodies[i];
    const ox = ax - B.r.x, oy = ay - B.r.y, oz = az - B.r.z;
    const px = bx - B.r.x, py = by - B.r.y, pz = bz - B.r.z;
    let R = B.radius + (B.atmosphere ? B.atmosphere.height : 0);
    let R2 = R * R;
    if (ox * ox + oy * oy + oz * oz < R2 || px * px + py * py + pz * pz < R2) { R = B.radius; R2 = R * R; }
    let s = l2 > 0 ? -(ox * dx + oy * dy + oz * dz) / l2 : 0;
    if (s < 0) s = 0; else if (s > 1) s = 1;
    const cx = ox + dx * s, cy = oy + dy * s, cz = oz + dz * s;
    if (cx * cx + cy * cy + cz * cz < R2) return false;
  }
  return true;
}

/** A Flight Assist reference is usable only within `range` and in line of sight. */
export function assistVisible(a: V3, b: V3, range: number, bodies: readonly LosBody[]): boolean {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  if (dx * dx + dy * dy + dz * dz > range * range) return false;
  return lineOfSight(a.x, a.y, a.z, b.x, b.y, b.z, bodies);
}

// =============================================================================================== air (per forced step)

/** u = v_rel − ω_body × r_rel (inertial axes): the air-relative velocity of a co-rotating atmosphere. */
export function airVelocity(out: V3, rx: number, ry: number, rz: number, vx: number, vy: number, vz: number, spinAxis: V3, spinRate: number): V3 {
  const ox = spinAxis.x * spinRate, oy = spinAxis.y * spinRate, oz = spinAxis.z * spinRate;
  out.x = vx - (oy * rz - oz * ry);
  out.y = vy - (oz * rx - ox * rz);
  out.z = vz - (ox * ry - oy * rx);
  return out;
}

/** Sutton–Graves stagnation heat flux, W/m²: 1.74e-4·√(ρ/R_n)·u³. */
export function suttonGraves(rho: number, u: number, rn = 1): number {
  return rho > 0 ? 1.74e-4 * Math.sqrt(rho / rn) * u * u * u : 0;
}

// =============================================================================================== the ledger

/** The RK4-weighted mean of four stage values (k₁ + 2k₂ + 2k₃ + k₄)/6: the step-mean of a drag force. */
export const rk4Mean = (k1: number, k2: number, k3: number, k4: number): number => (k1 + 2 * k2 + 2 * k3 + k4) / 6;

/** Add one step's mean proper force (N) and torque (N·m), both in CRAFT axes, over h. */
export function ledgerAdd(L: Ledger, fx: number, fy: number, fz: number, tx: number, ty: number, tz: number, h: number): void {
  L.fAcc.x += fx * h; L.fAcc.y += fy * h; L.fAcc.z += fz * h;
  L.tauAcc.x += tx * h; L.tauAcc.y += ty * h; L.tauAcc.z += tz * h;
  L.accT += h;
}

const _lv = { x: 0, y: 0, z: 0 };
/** Add a proper force given in INERTIAL axes (rotated into craft axes by q⁻¹), with a craft-axes torque. */
export function ledgerAddInertial(L: Ledger, q: Quat, fx: number, fy: number, fz: number, tx: number, ty: number, tz: number, h: number): void {
  qRotInv(_lv, q, fx, fy, fz);
  ledgerAdd(L, _lv.x, _lv.y, _lv.z, tx, ty, tz, h);
}

/** A contact / latch / undock impulse J (N·s) at r from the CoM, both craft axes: Δv += J/m, Δω += I⁻¹(r × J). */
export function ledgerImpulse(L: Ledger, jx: number, jy: number, jz: number, rx: number, ry: number, rz: number, m: number, Ix: number, Iy: number, Iz: number): void {
  L.dvImpulse.x += jx / m; L.dvImpulse.y += jy / m; L.dvImpulse.z += jz / m;
  L.dwImpulse.x += (ry * jz - rz * jy) / Ix;
  L.dwImpulse.y += (rz * jx - rx * jz) / Iy;
  L.dwImpulse.z += (rx * jy - ry * jx) / Iz;
}

export function makeLedgerMean(): LedgerMean {
  return { f: { x: 0, y: 0, z: 0 }, tau: { x: 0, y: 0, z: 0 }, dv: { x: 0, y: 0, z: 0 }, dw: { x: 0, y: 0, z: 0 }, T: 0 };
}

/** Consume the ledger: the mean proper force and torque since the last consumption (0 if no time), the impulses; zero it. */
export function consumeLedgerInto(L: Ledger, out: LedgerMean): LedgerMean {
  const T = L.accT, k = T > 0 ? 1 / T : 0;
  out.f.x = L.fAcc.x * k; out.f.y = L.fAcc.y * k; out.f.z = L.fAcc.z * k;
  out.tau.x = L.tauAcc.x * k; out.tau.y = L.tauAcc.y * k; out.tau.z = L.tauAcc.z * k;
  out.dv.x = L.dvImpulse.x; out.dv.y = L.dvImpulse.y; out.dv.z = L.dvImpulse.z;
  out.dw.x = L.dwImpulse.x; out.dw.y = L.dwImpulse.y; out.dw.z = L.dwImpulse.z;
  out.T = T;
  L.fAcc.x = L.fAcc.y = L.fAcc.z = 0;
  L.tauAcc.x = L.tauAcc.y = L.tauAcc.z = 0;
  L.dvImpulse.x = L.dvImpulse.y = L.dvImpulse.z = 0;
  L.dwImpulse.x = L.dwImpulse.y = L.dwImpulse.z = 0;
  L.accT = 0;
  return out;
}

// =============================================================================================== save / load

/** The W1-B contract fields that are saved (everything else here is rebuilt at load). */
export interface JetState extends Ledger {
  jetDuty: number[];
  engineThrust: number[];
  engineTimer: number[];
  rcsPropellant: number;
  rcsPropellantCapacity: number;
  holdWakeT: number;
}

const cpV = (a: V3): V3 => ({ x: a.x, y: a.y, z: a.z });

/** JSON-safe copy (holdWakeT = +∞ becomes null). Every other number is a finite double and round-trips exactly. */
export function saveJetState(s: JetState): Record<string, unknown> {
  return {
    jetDuty: s.jetDuty.slice(), engineThrust: s.engineThrust.slice(), engineTimer: s.engineTimer.slice(),
    rcsPropellant: s.rcsPropellant, rcsPropellantCapacity: s.rcsPropellantCapacity,
    fAcc: cpV(s.fAcc), tauAcc: cpV(s.tauAcc), accT: s.accT, dvImpulse: cpV(s.dvImpulse), dwImpulse: cpV(s.dwImpulse),
    holdWakeT: Number.isFinite(s.holdWakeT) ? s.holdWakeT : null,
  };
}

const num = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const vec = (x: unknown): V3 => {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  return { x: num(o.x, 0), y: num(o.y, 0), z: num(o.z, 0) };
};
const arr = (x: unknown, n: number, d: number): number[] => {
  const out: number[] = new Array(n);
  const a = Array.isArray(x) ? x : [];
  for (let i = 0; i < n; i++) out[i] = num(a[i], d);
  return out;
};

/**
 * Read the saved fields with loader defaults: duties and thrusts 0, engines unlit, an old save's RCS pool full
 * (`rcsCapacity`), empty ledger, hold awake (+∞). Arrays are resized to the craft's current jet/engine counts.
 */
export function loadJetState(raw: unknown, nJets: number, nEngines: number, rcsCapacity = RCS_CAPACITY): JetState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const cap = num(o.rcsPropellantCapacity, rcsCapacity);
  return {
    jetDuty: arr(o.jetDuty, nJets, 0),
    engineThrust: arr(o.engineThrust, nEngines, 0),
    engineTimer: arr(o.engineTimer, nEngines, ENGINE_UNLIT),
    rcsPropellant: num(o.rcsPropellant, cap),
    rcsPropellantCapacity: cap,
    fAcc: vec(o.fAcc), tauAcc: vec(o.tauAcc), accT: num(o.accT, 0), dvImpulse: vec(o.dvImpulse), dwImpulse: vec(o.dwImpulse),
    holdWakeT: o.holdWakeT === null ? Infinity : num(o.holdWakeT, Infinity),
  };
}
