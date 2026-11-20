// Real thrusters (SIMULATION.md W1-B): per-jet RCS with a minimum-propellant allocation table, the hydrazine
// blowdown pool, the main-drive spool with ignition delay and minimum-throttle hysteresis, jet damping, the
// settled-hold wake time, the Flight Assist line-of-sight test and the applied-force ledger.
//
// Pure, deterministic and allocation-free on every per-step path. Per-step entry points take NO scalar double
// arguments and return no doubles: a double passed to (or returned from) a call TurboFan does not inline is boxed
// on the heap (measured: 124 scavenges per 8e6 calls with inlining off, 0 with the value in a typed array). The
// per-step scalars travel in one per-craft Float64Array `inp` (makeStepIn, slots IN_*); results go into ThrustOut
// / typed arrays. The allocating functions are the load-time builders (buildJetTable, jetsFromLayout, engineDef,
// saveJetState/loadJetState).
//
// WIRING (wave 1; WIRED by W1-B: setup.ts, dynamics.ts, contact.ts, control.ts, game/flight.ts — kept as the map):
//   * setup.ts addCraft / shipDef (once per craft, at construction AND at load; nothing here is saved):
//       c.jets    = jetsFromLayout(layout.rcs, stats.rcsThrust, stats.rcsExhaustVelocity)   // fitted RCS pack
//       c.engines = layout.engines.map(e => engineDef(e.pos, com, stats.mainThrust / layout.engines.length,
//                                                     stats.exhaustVelocity))              // fitted drive
//       c.jetTable = buildJetTable(c.jets, com, { rcsCapacity: c.rcsPropellantCapacity })  // the tank follows the
//       capacity (V_t = cap·B/((B−1)·ρ), p/p₀ = 1/(B − (B−1)·m/cap)); c.jetIn = makeStepIn() (scratch).
//       The §1.4 field `jetTable: Float64Array` is c.jetTable.table; keep the JetTable object beside it.
//       c.maxTorque is NOT computed here any more (no load-time snapshot: see control.ts below).
//       If buildJetTable(...).deadCols has a torque bit (6..11), the hull cannot make that torque: log it (dev).
//   * dynamics.ts integrateCraft, replacing the lumped mdot / lx,ly,lz block and rotateCraft's
//     `clamp1(c.torque.x) * c.maxTorque.x`. Per step, fill the input once:
//       inp = c.jetIn; inp[IN_H] = h; inp[IN_RCS] = c.rcsPropellant; inp[IN_WX..WZ] = c.w; inp[IN_CX..CZ] = com;
//       inp[IN_THROTTLE] = c.throttle; inp[IN_M] = mass; inp[IN_IX..IZ] = craftInertia;
//       engineCutStep(c.engineTimer, n, inp)   // cuts inp[IN_H] at an ignition-delay end (like tank-empty)
//       cmd[0..2] = c.rcs; cmd[3..5] = the torque command (see control.ts below)
//       jetsStep(T, cmd, !landed && !docked && !destroyed, inp, duty, o)   // clears o, writes ACTUAL F/τ/ṁ_rcs
//       for each engine i: engineUpdate(c.engines[i], c.engineThrust, c.engineTimer, i,
//                                       c.propellant > 0 && !docked && !destroyed, inp, mean)
//       applyEngines(c.engines, mean, inp, o)   // adds main F/τ/ṁ_main and jet damping
//     qRot(o.f*) → inertial force; o.t* is the rotation torque. c.rcsPropellant −= o.mdotRcs·h; c.propellant −=
//     o.mdotMain·h. Powered (Q steps, no coasting warp) iff o.mdotRcs > 0 || engineActive(thrust, timer, n): the
//     shut-down spool tail ends at F_s = 0 EXACTLY, at t = τ_down·ln(F_s/ε), ε = 1e-6·F_max (no denormal tail).
//     Ledger, once per step: add the drag step mean (rk4MeanV of the stage forces, rotated to craft axes) into
//     o.f*, then ledgerAdd(c, o, inp); jetEdgeMasks(c.jetDuty, duty, n, edges) → emitEvent(jetOn/jetOff); copy
//     duty into c.jetDuty. consumeLedger(c, out) = consumeLedgerInto(c, out). airStep(c.air, rel, relV, ωBody).
//   * control.ts holdTorque keeps its signature but is fed FRESH authority every 60 Hz control tick:
//       torqueAuthority(T, inp, c.maxTorque)  // the current pool's pressure; never a load-time snapshot
//     and its `alpha = Math.min(ax, ay, az)` becomes `holdAlpha(maxTorque, inertia, S); alpha = S[0]` (min over the axes
//     that HAVE authority: one dead axis must not freeze the other two). Its −1..1 output is normalised by the
//     smaller of ±; convert it for the jets with holdCmdToJets(T, tq, cmd) (scales to each signed column, so the
//     stronger direction does not over-deliver). Stick input goes straight to cmd[3..5].
//   * session.ts Flight Assist: a_rcs per axis = forceAuthority(T, inp, fa).x / m (not c.rcsThrust / m: the Wren's
//     pure Fy is 46 kN, not 68); faMainDrive for the 0.18/0.12 main-drive hysteresis; assistRef keeps a candidate
//     only if assistVisible(c.r, ref.r, FA_RANGE, world.bodies). Settled hold: at settle
//     c.holdWakeT = t + holdWakeTimeVec(err, wRel, alphaB, db) (replaces LOOSE_WARP / WAKE_ANGLE_LOOSE /
//     SUSPEND_WARP).
//   * contact.ts hooks: ledgerImpulse(c, J, r, inp) for every contact / latch capture / undock spring. LANDED, the
//     jets are off but the engines run (they fire against the ground; W2-C pushes through the contact): in the
//     landed branch call engineUpdate/applyEngines with inp[IN_H] = dt, then aUp = (o.f · up)/m, burn =
//     o.mdotMain·dt and c.load from o instead of c.mainThrust·throttle. Otherwise lift-off would wait for a
//     0.5 s ignition delay that only starts after lift-off and the craft would fall back.
//   * world.ts save/load (W1-A migrate): saveJetState(c) / loadJetState(raw, nJets, nEngines, c's capacity).
//   * sim/ships.ts: the Tern's rcsExhaustVelocity 2400 → RCS_VE0; the Wren's 24 t splits 22.5 t LH2 + 1.5 t N2H4.
//   * shipLayouts.ts (checked against HULL_COLLIDERS in tests/jets.test.ts: on the skin, 15° plume cone clear for
//     6 m): Wren Z jets at (±2.8, −0.1, −14.45) exhaust −Z (the plan's (±1.0, 0, −14.8) is inside the windscreen)
//     and (±7.2, −0.6, 11.0) exhaust +Z (the plan's (±6.0, −0.2, 13.0) plume hits the pod stern). Albatross:
//     +Y at (±14.5, 0.34, 9.775) and −Y at (±14.5, −0.26, 9.775) on the wing tips (today it has NO roll authority).
//     The other five hulls still need their ±Z jets (deadCols ±Fz today). Existing plumes that touch the hull: the
//     Wren's tail X jets (6.0, −0.2, 11) into wing-trail, the Magpie's (3.7, −0.3, 6.8) (the test prints them).
//   * world/math.ts: take expPair (in-place typed-slot exp/expm1) as the §1.1.6 wrapper for this file.
//
// Conventions: SI; craft axes (forward −Z, up +Y, right +X); JetDef.dir and EngineDef.dir are EXHAUST
// directions (the force on the ship is −dir); `com` is the centre of mass in craft axes (origin today).

import type { Quat, V3 } from '../core/types';

// =============================================================================================== constants

/** The fixed simulation tick, s (SIMULATION.md §1.3). */
export const Q = 1 / 120;
/** Command axes: Fx, Fy, Fz, τx, τy, τz. Table column k = 2·axis + (negative ? 1 : 0). */
export const N_AXES = 6;
export const N_COLS = 12;

/** The Wren's RCS thrust per translation axis, N (shared out equally among the jets with that exhaust direction). */
export const RCS_AXIS_THRUST = 68e3;
/** Hydrazine monopropellant: exhaust velocity at full tank pressure (Isp 229 s), density, the Wren's pool. */
export const RCS_VE0 = 2250;
export const RCS_DENSITY = 1004;
export const RCS_CAPACITY = 1500;
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
/** The shut-down tail ends (F_s = 0 exactly) when the decaying thrust reaches this fraction of F_max. */
export const ENGINE_TAIL_EPS = 1e-6;

/** Flight Assist uses the main drive above this fraction of a_main and releases it below the second. */
export const FA_MAIN_ON = 0.18;
export const FA_MAIN_OFF = 0.12;

/** Slots of the per-step input array (makeStepIn). IN_P is written by the functions here (tank p/p₀). */
export const IN_H = 0, IN_RCS = 1, IN_WX = 2, IN_WY = 3, IN_WZ = 4, IN_CX = 5, IN_CY = 6, IN_CZ = 7;
export const IN_THROTTLE = 8, IN_M = 9, IN_IX = 10, IN_IY = 11, IN_IZ = 12, IN_P = 13, IN_LEN = 14;

// Transcendental wrapper (SIMULATION §1.1.6; move into world/math.ts when wave 1 wires this file, where an fdlibm
// port can replace the body). It works IN PLACE on a typed slot: io[k] ← e^x, io[k+1] ← e^x − 1 with x = io[k]. A
// wrapper taking and returning doubles is boxed whenever TurboFan's inlining budget runs out at one of its call
// sites (measured: exp/expm1 inlined at only 1 of 4 sites in the bundled step loop, 45 scavenges per 8e6 spool steps).
function expPair(io: Float64Array, k: number): void {
  const x = io[k];
  io[k] = Math.exp(x);
  io[k + 1] = Math.expm1(x);
}

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

/** The at-load jet data: packed geometry, the 12-column allocation table and the tank. Rebuilt at load, never saved. */
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
  /** Bit k set: column k has zero authority (no jet combination makes that signed axis purely). */
  deadCols: number;
  /** The CoM the table was built at (craft axes). */
  com: V3;
  /** The RCS tank: capacity (kg) and blowdown ratio B; volume V_t = cap·B/((B−1)·ρ) (m³, for display). */
  rcsCapacity: number;
  blowdown: number;
  tankVolume: number;
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

/** Per forced step: air-relative velocity (inertial) and stagnation heat flux. The caller writes `rho` first. */
export interface AirOut {
  airVel: V3;
  heatFlux: number;
  /** Input: local air density, kg/m³. */
  rho: number;
}

const GEO = 8;

export const makeStepIn = (): Float64Array => { const a = new Float64Array(IN_LEN); a[IN_P] = 1; return a; };

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
 * JetDefs from a layout's `rcs` list ({pos, dir}, dir = exhaust). Each translation axis gets `axisThrust` (the
 * fitted pack's stats.rcsThrust) in each sense, shared equally among the jets with the same exhaust direction
 * (Wren: 34 kN per X and Z jet, 22.7 kN per Y jet). `ve` is the pack's exhaust velocity. Load time only.
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
 * below the CoM: a 0.73° cant). Yaw offsets cancel by the pair's symmetry and are not canted. `maxThrust` is this
 * nozzle's share of the fitted drive (stats.mainThrust / engines), `ve` the drive's stats.exhaustVelocity.
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
 * problem is infeasible. Two-phase dense tableau, Bland's rule, redundant rows tolerated. Load time only.
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

export interface JetTableOptions {
  /** RCS pool capacity, kg (the craft's rcsPropellantCapacity): sizes the blowdown tank. */
  rcsCapacity?: number;
  /** Blowdown ratio B. */
  blowdown?: number;
  /** Propellant density, kg/m³ (only for the reported tank volume). */
  density?: number;
  /** Per jet thrust factor (wave 2's jetHealth); ≤ 0 removes the jet. */
  thrustScale?: ArrayLike<number>;
}

/** Tank volume of a blowdown pool whose `capacity` fills it to the design ullage V_u0 = V_t/B. */
export const rcsTankVolume = (capacity = RCS_CAPACITY, density = RCS_DENSITY, B = RCS_BLOWDOWN): number =>
  (capacity * B) / ((B - 1) * density);

/**
 * Build the jet table: for each of the 12 signed axes, the minimum-propellant duties that give a pure command
 * along that axis (all other force and torque components exactly zero), scaled so the column's largest duty is
 * 1. An axis no combination can produce purely gets a zero column, zero authority and its bit in `deadCols`.
 * Load time; deterministic.
 */
export function buildJetTable(jets: readonly JetDef[], com: V3, opts: JetTableOptions = {}): JetTable {
  const thrustScale = opts.thrustScale;
  const rcsCapacity = opts.rcsCapacity ?? RCS_CAPACITY, blowdown = opts.blowdown ?? RCS_BLOWDOWN;
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
  let deadCols = 0;
  for (let k = 0; k < N_COLS; k++) {
    const axis = k >> 1, sign = k & 1 ? -1 : 1;
    b.fill(0);
    b[axis] = sign;
    deadCols |= 1 << k;
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
    if (authority[k] > 0) deadCols &= ~(1 << k);
  }
  return {
    n, geo, table, authority, cost: colCost, deadCols, com: { x: com.x, y: com.y, z: com.z },
    rcsCapacity, blowdown, tankVolume: rcsTankVolume(rcsCapacity, opts.density ?? RCS_DENSITY, blowdown),
  };
}

// =============================================================================================== the blowdown pool

/**
 * Tank pressure ratio p/p₀ of an isothermal blowdown pool holding `m` kg of a `capacity` kg pool:
 * p₀·V_u0/V_u with V_u = V_t − m/ρ and V_t = cap·B/((B−1)·ρ), i.e. p/p₀ = 1/(B − (B−1)·m/cap) (ρ cancels).
 * m is clamped to [0, cap]: exactly 1 when full, exactly 1/B when empty, never above 1. For UI / tests; the
 * per-step paths use the same formula through inp (no double return).
 */
export function rcsBlowdown(m: number, capacity = RCS_CAPACITY, B = RCS_BLOWDOWN): number {
  if (!(capacity > 0)) return 1 / B;
  const x = m >= capacity ? 1 : m > 0 ? m / capacity : 0;
  return 1 / (B - (B - 1) * x);
}

/** inp[IN_P] = p/p₀ of the table's tank at inp[IN_RCS] kg (the formula of rcsBlowdown). */
export function setPressure(T: JetTable, inp: Float64Array): void {
  const m = inp[IN_RCS], cap = T.rcsCapacity, B = T.blowdown;
  const x = !(cap > 0) ? 0 : m >= cap ? 1 : m > 0 ? m / cap : 0;
  inp[IN_P] = 1 / (B - (B - 1) * x);
}

/** Exhaust-velocity factor at pressure ratio p/p₀: 0.97 + 0.03·p/p₀. */
export const rcsVeFactor = (pRatio: number): number => 0.97 + 0.03 * pRatio;

// =============================================================================================== authority

/** The torque authority per axis (the smaller of ±), N·m, at the CURRENT pool inp[IN_RCS]. Feed holdTorque with it. */
export function torqueAuthority(T: JetTable, inp: Float64Array, out: V3): V3 {
  setPressure(T, inp);
  const a = T.authority, p = inp[IN_P];
  out.x = (a[6] < a[7] ? a[6] : a[7]) * p;
  out.y = (a[8] < a[9] ? a[8] : a[9]) * p;
  out.z = (a[10] < a[11] ? a[10] : a[11]) * p;
  return out;
}

/** The force authority per axis (the smaller of ±), N, at the current pool. Flight Assist's a_rcs = this / m. */
export function forceAuthority(T: JetTable, inp: Float64Array, out: V3): V3 {
  setPressure(T, inp);
  const a = T.authority, p = inp[IN_P];
  out.x = (a[0] < a[1] ? a[0] : a[1]) * p;
  out.y = (a[2] < a[3] ? a[2] : a[3]) * p;
  out.z = (a[4] < a[5] ? a[4] : a[5]) * p;
  return out;
}

/**
 * The hold's braking acceleration bound, written to out[0]: min over the axes WITH authority of authority/I
 * (rad/s²); 0 if none.
 * Replaces holdTorque's `Math.min(ax, ay, az)`, which a single dead axis (Albatross roll today) drives to 0 and so
 * freezes the whole hold.
 */
export function holdAlpha(authority: V3, inertia: V3, out: Float64Array): void {
  let a = Infinity;
  if (authority.x > 0 && inertia.x > 0) { const v = authority.x / inertia.x; if (v < a) a = v; }
  if (authority.y > 0 && inertia.y > 0) { const v = authority.y / inertia.y; if (v < a) a = v; }
  if (authority.z > 0 && inertia.z > 0) { const v = authority.z / inertia.z; if (v < a) a = v; }
  out[0] = a === Infinity ? 0 : a; // written, not returned: a returned double is boxed when the call is not inlined
}

/**
 * holdTorque's −1..1 output (normalised by torqueAuthority, the smaller of ±) → jet torque commands cmd[3..5] on the
 * signed columns: cmd = hold·min(a₊, a₋)/a_±, so the applied torque is exactly hold·authority whichever the sign.
 */
export function holdCmdToJets(T: JetTable, hold: V3, cmd: Float64Array): Float64Array {
  const a = T.authority;
  for (let ax = 0; ax < 3; ax++) {
    const h = ax === 0 ? hold.x : ax === 1 ? hold.y : hold.z;
    const ap = a[6 + 2 * ax], an = a[7 + 2 * ax], mn = ap < an ? ap : an;
    const as = h < 0 ? an : ap;
    cmd[3 + ax] = as > 0 ? (h * mn) / as : 0;
  }
  return cmd;
}

/** A torque in N·m → the jet torque commands cmd[3..5] (before clamping) at the current pool. */
export function torqueToCmd(T: JetTable, inp: Float64Array, tau: V3, cmd: Float64Array): Float64Array {
  setPressure(T, inp);
  const a = T.authority, p = inp[IN_P];
  const ax = a[tau.x < 0 ? 7 : 6] * p, ay = a[tau.y < 0 ? 9 : 8] * p, az = a[tau.z < 0 ? 11 : 10] * p;
  cmd[3] = ax > 0 ? tau.x / ax : 0;
  cmd[4] = ay > 0 ? tau.y / ay : 0;
  cmd[5] = az > 0 ? tau.z / az : 0;
  return cmd;
}

// =============================================================================================== per step: RCS

/**
 * Duties for a 6-axis command (each −1..1, clamped): duty = Σ_k |cmd_k|·table[k±]. Saturation: when a duty would
 * exceed 1 the whole duty vector is scaled down by its largest duty (not clipped per jet), so the applied force and
 * torque keep the commanded DIRECTION and only lose magnitude. Per-jet clipping (the plan's first wording) turns a
 * saturated three-axis torque command into 11.3 kN of spurious translation (measured in tests/jets.test.ts).
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

/**
 * Jet damping torque of one exhaust stream: −ṁ·(|ρ|²ω − (ρ·ω)ρ) = −ṁ|ρ|²ω⊥, ρ = r − com. Added into o.t* and o.d*.
 * Reference form for tests; the per-step loops below inline the same expression.
 */
export function addJetDamping(o: ThrustOut, mdot: number, rx: number, ry: number, rz: number, wx: number, wy: number, wz: number): void {
  if (mdot === 0) return;
  const r2 = rx * rx + ry * ry + rz * rz, rw = rx * wx + ry * wy + rz * wz;
  const dx = -mdot * (r2 * wx - rw * rx), dy = -mdot * (r2 * wy - rw * ry), dz = -mdot * (r2 * wz - rw * rz);
  o.dx += dx; o.dy += dy; o.dz += dz;
  o.tx += dx; o.ty += dy; o.tz += dz;
}

/**
 * The force, torque (about com = inp[IN_C*]) and ṁ the jets actually apply at duties `duty` and the pressure ratio
 * inp[IN_P] (F = F₀·p/p₀, vₑ = vₑ₀·(0.97 + 0.03·p/p₀)), plus jet damping at body rate inp[IN_W*]. ADDS into `o`.
 */
export function applyJets(T: JetTable, duty: Float64Array, inp: Float64Array, o: ThrustOut): ThrustOut {
  const n = T.n, g = T.geo;
  const p = inp[IN_P], mScale = p / (0.97 + 0.03 * p);
  const wx = inp[IN_WX], wy = inp[IN_WY], wz = inp[IN_WZ], cx = inp[IN_CX], cy = inp[IN_CY], cz = inp[IN_CZ];
  let fx = 0, fy = 0, fz = 0, tx = 0, ty = 0, tz = 0, md = 0, dx = 0, dy = 0, dz = 0;
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
    // jet damping −ṁ(|ρ|²ω − (ρ·ω)ρ)
    const r2 = rx * rx + ry * ry + rz * rz, rw = rx * wx + ry * wy + rz * wz;
    dx -= mj * (r2 * wx - rw * rx); dy -= mj * (r2 * wy - rw * ry); dz -= mj * (r2 * wz - rw * rz);
  }
  o.fx += fx * p; o.fy += fy * p; o.fz += fz * p;
  o.tx += tx * p + dx; o.ty += ty * p + dy; o.tz += tz * p + dz;
  o.dx += dx; o.dy += dy; o.dz += dz;
  o.mdotRcs += md;
  o.pRatio = p;
  return o;
}

/**
 * One RCS step: tank pressure from inp[IN_RCS], allocate `cmd`, then what the jets actually do. Not `enabled`
 * (landed, docked, destroyed) or a dry pool → all duties 0 and nothing applied. Clears `o` first.
 */
export function jetsStep(T: JetTable, cmd: ArrayLike<number>, enabled: boolean, inp: Float64Array, duty: Float64Array, o: ThrustOut): ThrustOut {
  clearThrustOut(o);
  if (!enabled || !(inp[IN_RCS] > 0)) {
    for (let j = 0; j < T.n; j++) duty[j] = 0;
    return o;
  }
  setPressure(T, inp);
  allocateJets(T, cmd, duty);
  return applyJets(T, duty, inp, o);
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

// spool() works in typed slots (no double arguments or returns): in SP_F, SP_FC, SP_H, SP_TU, SP_TD, SP_EPS; out
// SP_MEAN, SP_END; SP_X(+1) is expPair's scratch.
const SP = new Float64Array(12);
const SP_F = 0, SP_FC = 1, SP_H = 2, SP_TU = 3, SP_TD = 4, SP_EPS = 5, SP_MEAN = 6, SP_END = 7, SP_X = 8, SP_T = 10, SP_H0 = 11;
/**
 * Exact first-order spool from F over h toward Fc (τ_up rising, τ_down falling; it never crosses Fc). Toward 0 the
 * tail ends at F = 0 exactly when it reaches ε, at t_off = τ·ln(F/ε) (∫₀^t_off F e^(−t/τ) dt = τ(F − ε)): an
 * exponential never reaches 0 in floating point and sticks at a denormal (9e-323 · e^(−Q/τ) rounds back to itself).
 */
function spool(): void {
  const F = SP[SP_F], Fc = SP[SP_FC], h = SP[SP_H];
  if (h <= 0 || F === Fc) { SP[SP_MEAN] = F; SP[SP_END] = F; return; }
  const tau = Fc > F ? SP[SP_TU] : SP[SP_TD];
  const x = -h / tau;
  SP[SP_X] = x; expPair(SP, SP_X);
  const e = SP[SP_X], om = -SP[SP_X + 1]; // e = e^(−h/τ), om = 1 − e (accurate for small h/τ)
  if (Fc === 0) {
    // the tail ends inside this step iff F·e^(−h/τ) ≤ ε, i.e. h ≥ t_off = τ·ln(F/ε) (no log needed)
    const eps = SP[SP_EPS];
    if (F <= eps) { SP[SP_MEAN] = 0; SP[SP_END] = 0; return; }
    if (F * e <= eps) { SP[SP_MEAN] = (tau * (F - eps)) / h; SP[SP_END] = 0; return; }
  }
  const d = F - Fc;
  SP[SP_MEAN] = Fc + d * (om / -x); // F̄ = F_c + (F − F_c)·(τ/h)(1 − e^(−h/τ))
  SP[SP_END] = Fc + d * e;
}

/**
 * Advance engine i through h = inp[IN_H] with the throttle command inp[IN_THROTTLE] (latched for the tick).
 * `enabled` = the main pool is not empty and the craft is not docked or destroyed (landed engines DO run).
 * State: thrust[i] = F_s (N); timer[i] = ENGINE_UNLIT (−1) when unlit, the ignition delay still to run (> 0), or
 * 0 when burning. Exact at any h (an ignition delay ending inside the step splits it; the shut-down tail ends
 * exactly). Writes the exact step-mean thrust F̄ (N) to mean[i]: force −F̄·dir, ṁ = F̄/vₑ. Not enabled: F_s = 0, unlit.
 */
export function engineUpdate(d: EngineDef, thrust: { [k: number]: number }, timer: { [k: number]: number }, i: number, enabled: boolean, inp: Float64Array, mean: { [k: number]: number }): void {
  if (!enabled) { thrust[i] = 0; timer[i] = ENGINE_UNLIT; mean[i] = 0; return; }
  // The timer and the delay segment live in typed slots, not in locals: a local that is 0 or −1 (Smi) on one path
  // and a double on another became a boxed phi in the bundled loop (measured: ~3 HeapNumbers per ignition-delay step).
  const h = inp[IN_H], cmd = inp[IN_THROTTLE], mt = d.minThrottle;
  SP[SP_T] = timer[i];
  const wasLit = SP[SP_T] >= 0;
  // engineLatch and engineCommandThrust, inlined (no double arguments on the per-step path)
  const lit = wasLit ? cmd >= ENGINE_OFF_THROTTLE : cmd >= mt;
  if (!lit) SP[SP_T] = ENGINE_UNLIT;
  else if (!wasLit) SP[SP_T] = d.delay;
  const Fc = lit ? (cmd > 1 ? 1 : cmd < mt ? mt : cmd) * d.maxThrust : 0;
  SP[SP_TU] = d.tauUp; SP[SP_TD] = d.tauDown; SP[SP_EPS] = ENGINE_TAIL_EPS * d.maxThrust;
  // Segment 0: the part of the ignition delay inside this step (target 0); segment 1: the rest (target Fc). Both
  // spool() calls run on EVERY update (a zero-length segment returns at once), so both call sites stay hot.
  SP[SP_H0] = 0;
  const t = SP[SP_T];
  if (t > 0) {
    if (h < t && t - h > 1e-12) { SP[SP_H0] = h; SP[SP_T] = t - h; } else { SP[SP_H0] = t < h ? t : h; SP[SP_T] = 0; }
  }
  const h0 = SP[SP_H0], h1 = h - h0;
  SP[SP_F] = thrust[i]; SP[SP_FC] = 0; SP[SP_H] = h0; spool();
  const m0 = SP[SP_MEAN];
  SP[SP_F] = SP[SP_END]; SP[SP_FC] = Fc; SP[SP_H] = h1; spool();
  mean[i] = h0 === 0 ? SP[SP_MEAN] : h1 === 0 ? m0 : (m0 * h0 + SP[SP_MEAN] * h1) / h;
  thrust[i] = SP[SP_END];
  timer[i] = SP[SP_T];
}

/** True while any engine is lit (incl. its ignition delay) or still spooling down: dynamics' "powered" test. */
export function engineActive(thrust: ArrayLike<number>, timer: ArrayLike<number>, n: number): boolean {
  for (let i = 0; i < n; i++) if (timer[i] >= 0 || thrust[i] > 0) return true;
  return false;
}

/** The step-cutting helper: inp[IN_H] = min(inp[IN_H], the time until the first ignition delay ends). */
export function engineCutStep(timer: ArrayLike<number>, n: number, inp: Float64Array): void {
  let dt = inp[IN_H];
  for (let i = 0; i < n; i++) { const t = timer[i]; if (t > 0 && t < dt) dt = t; }
  inp[IN_H] = dt;
}

/**
 * Add the engines' step-mean thrusts `mean[i]` (from engineUpdate) to `o`: force −F̄·dir, torque about com
 * (inp[IN_C*]), ṁ_main = ΣF̄/vₑ, jet damping at rate inp[IN_W*].
 */
export function applyEngines(defs: readonly EngineDef[], mean: ArrayLike<number>, inp: Float64Array, o: ThrustOut): ThrustOut {
  const wx = inp[IN_WX], wy = inp[IN_WY], wz = inp[IN_WZ], cx = inp[IN_CX], cy = inp[IN_CY], cz = inp[IN_CZ];
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
    const r2 = rx * rx + ry * ry + rz * rz, rw = rx * wx + ry * wy + rz * wz;
    const dx = -md * (r2 * wx - rw * rx), dy = -md * (r2 * wy - rw * ry), dz = -md * (r2 * wz - rw * rz);
    o.dx += dx; o.dy += dy; o.dz += dz;
    o.tx += dx; o.ty += dy; o.tz += dz;
  }
  return o;
}

/** Flight Assist main-drive hysteresis: engage above FA_MAIN_ON·a_main, release below FA_MAIN_OFF·a_main. */
export function faMainDrive(using: boolean, aReq: number, aMain: number): boolean {
  return using ? aReq >= FA_MAIN_OFF * aMain : aReq > FA_MAIN_ON * aMain;
}

// =============================================================================================== settled hold (at settle only)

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
export function lineOfSight(a: V3, b: V3, bodies: readonly LosBody[]): boolean {
  const ax = a.x, ay = a.y, az = a.z;
  const dx = b.x - ax, dy = b.y - ay, dz = b.z - az;
  const l2 = dx * dx + dy * dy + dz * dz;
  for (let i = 0; i < bodies.length; i++) {
    const B = bodies[i];
    const ox = ax - B.r.x, oy = ay - B.r.y, oz = az - B.r.z;
    const px = b.x - B.r.x, py = b.y - B.r.y, pz = b.z - B.r.z;
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

/** A Flight Assist reference is usable only within `range` (a constant, FA_RANGE) and in line of sight. */
export function assistVisible(a: V3, b: V3, range: number, bodies: readonly LosBody[]): boolean {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  if (dx * dx + dy * dy + dz * dz > range * range) return false;
  return lineOfSight(a, b, bodies);
}

// =============================================================================================== air (per forced step)

/**
 * out.airVel = u = v_rel − Ω × r_rel (inertial axes; Ω the body's spin angular-velocity vector, rad/s) and
 * out.heatFlux = Sutton–Graves 1.74e-4·√(ρ/R_n)·|u|³ with R_n = 1 m at ρ = out.rho (the caller writes it first).
 */
export function airStep(out: AirOut, r: V3, v: V3, omega: V3): AirOut {
  const u = out.airVel;
  u.x = v.x - (omega.y * r.z - omega.z * r.y);
  u.y = v.y - (omega.z * r.x - omega.x * r.z);
  u.z = v.z - (omega.x * r.y - omega.y * r.x);
  const rho = out.rho;
  if (rho > 0) { const s = Math.sqrt(u.x * u.x + u.y * u.y + u.z * u.z); out.heatFlux = 1.74e-4 * Math.sqrt(rho) * s * s * s; }
  else out.heatFlux = 0;
  return out;
}

/** Sutton–Graves stagnation heat flux, W/m²: 1.74e-4·√(ρ/R_n)·u³ (reference form; airStep is the per-step one). */
export function suttonGraves(rho: number, u: number, rn = 1): number {
  return rho > 0 ? 1.74e-4 * Math.sqrt(rho / rn) * u * u * u : 0;
}

// =============================================================================================== the ledger

/** out = (k₁ + 2k₂ + 2k₃ + k₄)/6: the step mean of a force sampled at the four RK4 stages (drag). */
export function rk4MeanV(out: V3, k1: V3, k2: V3, k3: V3, k4: V3): V3 {
  out.x = (k1.x + 2 * k2.x + 2 * k3.x + k4.x) / 6;
  out.y = (k1.y + 2 * k2.y + 2 * k3.y + k4.y) / 6;
  out.z = (k1.z + 2 * k2.z + 2 * k3.z + k4.z) / 6;
  return out;
}

/** Add one step's mean proper force (N) and torque (N·m), both CRAFT axes (s.f*, s.t*), over h = inp[IN_H]. */
export function ledgerAdd(L: Ledger, s: { fx: number; fy: number; fz: number; tx: number; ty: number; tz: number }, inp: Float64Array): void {
  const h = inp[IN_H];
  L.fAcc.x += s.fx * h; L.fAcc.y += s.fy * h; L.fAcc.z += s.fz * h;
  L.tauAcc.x += s.tx * h; L.tauAcc.y += s.ty * h; L.tauAcc.z += s.tz * h;
  L.accT += h;
}

/**
 * Add a proper force given in INERTIAL axes (rotated into craft axes by q⁻¹, the formula of math.ts qRotInv inlined
 * so no doubles are passed) over inp[IN_H]; no time is added (ledgerAdd adds it once per step).
 */
export function ledgerAddInertialForce(L: Ledger, q: Quat, f: V3, inp: Float64Array): void {
  const x = f.x, y = f.y, z = f.z, qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  const h = inp[IN_H];
  L.fAcc.x += (x + qw * tx + (qy * tz - qz * ty)) * h;
  L.fAcc.y += (y + qw * ty + (qz * tx - qx * tz)) * h;
  L.fAcc.z += (z + qw * tz + (qx * ty - qy * tx)) * h;
}

/**
 * A contact / latch / undock impulse J (N·s) at r from the CoM, both craft axes: Δv += J/m, Δω += I⁻¹(r × J), with
 * m = inp[IN_M] and the principal inertia inp[IN_IX..IZ].
 */
export function ledgerImpulse(L: Ledger, J: V3, r: V3, inp: Float64Array): void {
  const m = inp[IN_M];
  L.dvImpulse.x += J.x / m; L.dvImpulse.y += J.y / m; L.dvImpulse.z += J.z / m;
  L.dwImpulse.x += (r.y * J.z - r.z * J.y) / inp[IN_IX];
  L.dwImpulse.y += (r.z * J.x - r.x * J.z) / inp[IN_IY];
  L.dwImpulse.z += (r.x * J.y - r.y * J.x) / inp[IN_IZ];
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
const arr = (x: unknown, n: number, d: number, lo: number, hi: number): number[] => {
  const out: number[] = new Array(n);
  const a = Array.isArray(x) ? x : [];
  for (let i = 0; i < n; i++) { const v = num(a[i], d); out[i] = v < lo ? lo : v > hi ? hi : v; }
  return out;
};

/**
 * Read the saved fields with loader defaults: duties and thrusts 0, engines unlit, an old save's RCS pool full,
 * empty ledger, hold awake (+∞). `rcsCapacity` is the craft's CURRENT capacity (from its fit): the pool is clamped
 * to [0, capacity] (an edited, migrated or refitted save cannot overfill the blowdown tank). Arrays are resized
 * to the craft's current jet/engine counts; duties are clamped to [0, 1], thrusts to ≥ 0, timers to ≥ −1.
 */
export function loadJetState(raw: unknown, nJets: number, nEngines: number, rcsCapacity = RCS_CAPACITY): JetState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const cap = rcsCapacity > 0 ? rcsCapacity : 0;
  const m = num(o.rcsPropellant, cap);
  return {
    jetDuty: arr(o.jetDuty, nJets, 0, 0, 1),
    engineThrust: arr(o.engineThrust, nEngines, 0, 0, Infinity),
    engineTimer: arr(o.engineTimer, nEngines, ENGINE_UNLIT, ENGINE_UNLIT, Infinity),
    rcsPropellant: m < 0 ? 0 : m > cap ? cap : m,
    rcsPropellantCapacity: cap,
    fAcc: vec(o.fAcc), tauAcc: vec(o.tauAcc), accT: num(o.accT, 0), dvImpulse: vec(o.dvImpulse), dwImpulse: vec(o.dwImpulse),
    holdWakeT: o.holdWakeT === null ? Infinity : num(o.holdWakeT, Infinity),
  };
}
