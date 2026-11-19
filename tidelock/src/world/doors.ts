// Doors and the dorsal hatch as mechanisms (docs/SIMULATION.md W3-B items 2–3).
//
// Sliding pressure door (one per doorway, src/data/compartments.ts DoorDef): two degrees of freedom.
//   * The SEAT stroke s ∈ [0, S] (S = 4 mm): a cam of mechanical advantage MA lifts the leaf off its seal. The motor
//     (300 N, current-limited, a DC force–speed line) must beat the seal preload plus the pressure load:
//     F·MA > F_seal + |Δp|·A (A = W·H, 2.1 kN per kPa on a spine door), so a door can be unseated only below
//     (2·300 − 200)/2.1 = 190 Pa: it never opens toward vacuum, it stalls (and hums) instead. The stroke speed falls
//     with the load (S/T_seat·(1 − need/F)). Seating needs no force (the pressure helps).
//   * The SLIDE x ∈ [0, W]: m·ẍ = F_motor + F_crank − sign(ẋ)·(F_c + μ_roll·|Δp|·A_covered), A_covered = A·(1 − x/W),
//     F_motor = clamp(m·(v_t − ẋ)/T_ctrl, ±300 N) on a trapezoidal speed target v_t (≤ 1 m/s, braking at
//     4 m/s² into the stop), Coulomb stick–slip, semi-implicit Euler at the device sub-step (480 Hz). End stops absorb
//     ½mẋ² (the slam, an event for W2-F). Once unseated the leaf rides hardened rollers (μ_roll 0.001), so it can
//     still close across the flow of a breach (≈ 170 N at 80 kPa).
//   * Gas: open fraction f = min(1, (x·H + s·2(W + H))/A) of the doorway orifice (the unseated crack hisses and
//     equalises), the leaf's equalisation valve as its own orifice.
//   * Auto-close: a pressure-drop sensor on either side (dp/dt < −0.5 kPa/s from cabin io.depress) commands CLOSE
//     and latches (a door button re-arms it). Manual crank: a hand force F_h (≤ 150 N) × 20 on the leaf and the cam.
// Hinged hatch (corridor overhead → docking tunnel): angle θ ∈ [0, θ_open], I·θ̈ = τ_pull − c·θ̇ − τ_p,
//   τ_p = Δp·A·D/2·max(0, 1 − θ/θ_seal) (Δp = corridor − tunnel: the cabin side seats it; a higher tunnel pressure
//   blows it open once the dogs are out). Dogs d ∈ [0, 1] driven by the handle (3 s), θ locked while any dog is in.
//   A 100 N pull 0.4 m from the hinge lifts it only below Δp ≈ 200 Pa. Flow fraction min(1, 2·sin θ) (curtain area
//   π·D·(D·sinθ)/2 over πD²/4).
//
// Determinism and warp: fixed sub-step DOOR_H = Q/4, no transcendental calls but √ and sin. doorsAdvance(…, T)
// integrates whole sub-steps for T seconds but returns at once when every mechanism is at rest (rest is exact: a
// resting mechanism has no dynamics), so a quantum of 17 s costs nothing unless a door is moving, and then ≤ 2 s of
// sub-steps (the travel). The gas sees the open fractions at the end of the call (one gas step per quantum).
//
// WIRING (wave 3): compartments.ts calls doorsAdvance every tick (1×, T = Q) or once per quantum (warp, T = q) BEFORE
//   the gas step, with p = cabin io.p and depress = io.depress of the last gas step; it writes the open fractions into
//   cabin io.open[door.orifice | door.valve | hatch.orifice | hatch.valve]. Devices (data/cockpit.ts, interiors.ts —
//   the W3-C owner adds them on request) write st.door[k·DOOR_STRIDE + D_CMD] (−1 close, 0 stop, +1 open; a press also
//   sets D_ARM = 1 and clears D_FIRED), D_VALVE (0..1), the crank force in inp.crank[k], the hatch D_* via
//   st.hatch[H_DOGCMD], H_VALVE and the crew's pull torque inp.pull (N·m, W2-E hands: |F| ≤ 100 N at 0.4 m). Outputs:
//   out.slamJ[k] (J at an end stop: a 'door' event, W2-F), out.motorW (bus load, W2-D powerNet L_*), the leaf
//   boxes (doorLeafBox → W3-D's dynamicBoxes collider slot, W3-E RT dynamic object). §1.4: reads cabin.rooms (via
//   io.p), writes nothing of §1.4; its own saved state is st.door / st.hatch.

import {
  CREW_PULL_MAX, DOOR_A_DEC, DOOR_AUTO_DPDT, DOOR_CAM_MA, DOOR_CRANK_MA, DOOR_F_COULOMB, DOOR_F_MOTOR, DOOR_MU_ROLL,
  DOOR_SEAL_F, DOOR_SEAT_STROKE, DOOR_SEAT_T, DOOR_T_CTRL, DOOR_V_MAX, HAND_F_MAX, HATCH_ARM, HATCH_DAMP, HATCH_DOG_T,
  HATCH_OPEN, HATCH_SEAL_ANGLE, type DoorDef, type HatchDef,
} from '../data/compartments';

/** Device sub-step, s (4 per 1/120 s tick, as the harness and devices). */
export const DOOR_H = 1 / 480;

/** Per-door saved state slots. */
export const D_S = 0, D_X = 1, D_V = 2, D_CMD = 3, D_ARM = 4, D_FIRED = 5, D_VALVE = 6;
export const DOOR_STRIDE = 7;
/** Hatch saved state slots. */
export const H_TH = 0, H_W = 1, H_DOGS = 2, H_DOGCMD = 3, H_VALVE = 4;
export const HATCH_STRIDE = 5;

export interface MechState {
  door: Float64Array;
  hatch: Float64Array;
}

export interface MechInputs {
  /** Crank hand force per door, N (+ opens); clamped to ±HAND_F_MAX. */
  crank: Float64Array;
  /** Crew pull torque on the hatch about its hinge, N·m (+ opens); clamped to CREW_PULL_MAX·HATCH_ARM. */
  pull: number;
  /** Door motors powered (bus): 0/1. */
  power: number;
}

export interface MechOut {
  /** Energy dissipated at an end stop this call, J, per door; [nDoors] = the hatch. */
  slamJ: Float64Array;
  /** Mean motor electrical power this call, W. */
  motorW: number;
  /** A mechanism is moving or straining (stalled against a load) at the end of the call. */
  busy: boolean;
}

/** Compiled door table (flat, never saved). */
export interface MechNet {
  nD: number;
  a: Int32Array; b: Int32Array; orifice: Int32Array; valve: Int32Array;
  W: Float64Array; H: Float64Array; A: Float64Array; m: Float64Array; gapK: Float64Array;
  hatch: HatchDef;
  doors: DoorDef[];
  K: Float64Array; // hot constants (typed: no boxed module doubles in the loop)
  /** Scratch: [0] motor mechanical work of the call, J·(1/DOOR_H) (a double returned from a call is boxed). */
  acc: Float64Array;
}

const K_FM = 0, K_VMAX = 1, K_ADEC = 2, K_TC = 3, K_MA = 4, K_S = 5, K_ST = 6, K_SEAL = 7, K_MU = 8, K_FC = 9, K_CMA = 10, K_HF = 11, K_AUTO = 12;

export function compileMech(doors: DoorDef[], hatch: HatchDef): MechNet {
  const nD = doors.length;
  return {
    nD,
    a: Int32Array.from(doors, (d) => d.a), b: Int32Array.from(doors, (d) => d.b),
    orifice: Int32Array.from(doors, (d) => d.orifice), valve: Int32Array.from(doors, (d) => d.valve),
    W: Float64Array.from(doors, (d) => d.W), H: Float64Array.from(doors, (d) => d.H), A: Float64Array.from(doors, (d) => d.A),
    m: Float64Array.from(doors, (d) => d.mass), gapK: Float64Array.from(doors, (d) => 2 * (d.W + d.H)),
    hatch, doors,
    acc: new Float64Array(1),
    K: Float64Array.of(DOOR_F_MOTOR, DOOR_V_MAX, DOOR_A_DEC, DOOR_T_CTRL, DOOR_CAM_MA, DOOR_SEAT_STROKE, DOOR_SEAT_T, DOOR_SEAL_F, DOOR_MU_ROLL, DOOR_F_COULOMB, DOOR_CRANK_MA, HAND_F_MAX, DOOR_AUTO_DPDT),
  };
}

/** Fresh state: doors open (the wave-2 ship has open doors), armed, valves shut; the hatch shut and dogged. */
export function makeMechState(mn: MechNet): MechState {
  const door = new Float64Array(mn.nD * DOOR_STRIDE);
  for (let k = 0; k < mn.nD; k++) {
    const o = k * DOOR_STRIDE;
    door[o + D_S] = mn.K[K_S]; door[o + D_X] = mn.W[k]; door[o + D_CMD] = 1; door[o + D_ARM] = 1;
  }
  return { door, hatch: new Float64Array(HATCH_STRIDE) };
}

export const makeMechInputs = (mn: MechNet): MechInputs => ({ crank: new Float64Array(mn.nD), pull: 0, power: 1 });
export const makeMechOut = (mn: MechNet): MechOut => ({ slamJ: new Float64Array(mn.nD + 1), motorW: 0, busy: false });

/** True when nothing can move: every door at the end its command asks for (or stopped), the hatch still. */
function doorAtRest(mn: MechNet, d: Float64Array, k: number, crank: number): boolean {
  const o = k * DOOR_STRIDE;
  if (d[o + D_V] !== 0 || crank !== 0) return false;
  const cmd = d[o + D_CMD];
  if (cmd > 0) return d[o + D_S] >= mn.K[K_S] && d[o + D_X] >= mn.W[k];
  if (cmd < 0) return d[o + D_X] <= 0 && d[o + D_S] <= 0;
  return true;
}

/**
 * One sub-step of door k (h = DOOR_H) with room pressures p: adds the motor's mechanical power (W) to mn.acc[0] and
 * slam energy to out.
 */
function stepDoor(mn: MechNet, d: Float64Array, k: number, p: Float64Array, inp: MechInputs, out: MechOut, h: number): void {
  const K = mn.K, o = k * DOOR_STRIDE;
  const W = mn.W[k], A = mn.A[k], m = mn.m[k];
  const pa = p[mn.a[k]], pb = p[mn.b[k]];
  const dp = pa > pb ? pa - pb : pb - pa;
  const cmd = d[o + D_CMD];
  let fc = inp.crank[k];
  if (fc > K[K_HF]) fc = K[K_HF]; else if (fc < -K[K_HF]) fc = -K[K_HF];
  fc *= K[K_CMA];
  const fm = inp.power > 0 ? K[K_FM] : 0;
  let s = d[o + D_S], x = d[o + D_X], v = d[o + D_V];
  let pw = 0;
  // ---- seat phase (quasi-static: the stroke has no inertia worth integrating)
  const wantOpen = cmd > 0 || fc > 0;
  if (wantOpen && s < K[K_S] && v === 0 && x <= 0) {
    const need = (K[K_SEAL] + dp * A) / K[K_MA];
    const drive = (cmd > 0 ? fm : 0) + (fc > 0 ? fc : 0);
    if (drive > need) {
      s += (K[K_S] / K[K_ST]) * (1 - need / drive) * h;
      if (s > K[K_S]) s = K[K_S];
      pw += need * (K[K_S] / K[K_ST]) * (1 - need / drive);
    }
    d[o + D_S] = s;
    mn.acc[0] += pw;
    return;
  }
  if (cmd < 0 && x <= 0 && v === 0 && s > 0 && !(fc > 0)) {
    s -= (K[K_S] / K[K_ST]) * h;
    d[o + D_S] = s > 0 ? s : 0;
    return;
  }
  if (s < K[K_S] && v === 0 && x <= 0) return; // seated or seating: the leaf cannot slide
  // ---- slide phase
  let vt = 0;
  if (cmd !== 0) {
    const dist = cmd > 0 ? W - x : x;
    const vb = Math.sqrt(2 * K[K_ADEC] * (dist > 0 ? dist : 0));
    vt = (vb < K[K_VMAX] ? vb : K[K_VMAX]) * (cmd > 0 ? 1 : -1);
  }
  let F = m * (vt - v) / K[K_TC];
  if (F > fm) F = fm; else if (F < -fm) F = -fm;
  const Fd = F + fc;
  const Fr = K[K_FC] + K[K_MU] * dp * A * (1 - x / W);
  let vn: number;
  if (v === 0) {
    if (Fd > Fr) vn = (Fd - Fr) / m * h;
    else if (Fd < -Fr) vn = (Fd + Fr) / m * h;
    else vn = 0;
  } else {
    vn = v + (Fd - (v > 0 ? Fr : -Fr)) / m * h;
    if (vn * v < 0) vn = 0; // friction stops it within the sub-step
  }
  x += vn * h;
  if (x >= W) { x = W; out.slamJ[k] += 0.5 * m * vn * vn; vn = 0; }
  else if (x <= 0) { x = 0; out.slamJ[k] += 0.5 * m * vn * vn; vn = 0; }
  pw += (F * vn > 0 ? F * vn : 0);
  d[o + D_X] = x; d[o + D_V] = vn;
  mn.acc[0] += pw;
}

/** Hatch sub-step: p[room] − p[tunnel] seats it. */
function stepHatch(mn: MechNet, hs: Float64Array, p: Float64Array, inp: MechInputs, out: MechOut, h: number): void {
  const hd = mn.hatch;
  // dogs
  const dc = hs[H_DOGCMD];
  let dg = hs[H_DOGS];
  if (dc > 0 && dg < 1) { dg += h / HATCH_DOG_T; if (dg > 1) dg = 1; }
  else if (dc < 0 && dg > 0 && hs[H_TH] <= 0) { dg -= h / HATCH_DOG_T; if (dg < 0) dg = 0; }
  hs[H_DOGS] = dg;
  if (dg < 1) { hs[H_W] = 0; return; } // a dog still in: locked (θ is 0, dogs engage only when shut)
  let th = hs[H_TH], w = hs[H_W];
  let tp = inp.pull;
  const tmax = CREW_PULL_MAX * HATCH_ARM;
  if (tp > tmax) tp = tmax; else if (tp < -tmax) tp = -tmax;
  const dp = p[hd.room] - p[hd.tunnel];
  const seal = th < HATCH_SEAL_ANGLE ? 1 - th / HATCH_SEAL_ANGLE : 0;
  const tq = dp * hd.A * hd.D * 0.5 * seal;
  let tau = tp - HATCH_DAMP * w - tq;
  if (th <= 0 && w === 0 && !(tau > 0)) return; // on its seal, the frame reacts
  w += tau / hd.I * h;
  if (tp === 0 && tq === 0 && (w < 0 ? -w : w) < 1e-3) w = 0; // hinge friction holds a slowly drifting hatch
  th += w * h;
  if (th <= 0) { th = 0; out.slamJ[mn.nD] += 0.5 * hd.I * w * w; w = 0; }
  else if (th >= HATCH_OPEN) { th = HATCH_OPEN; out.slamJ[mn.nD] += 0.5 * hd.I * w * w; w = 0; }
  hs[H_TH] = th; hs[H_W] = w;
}

/** The hatch has no dynamics left: still, nobody pulling, the dogs where their handle puts them, and no pressure
 *  torque that could move it (seated against a higher cabin pressure, or out of the seal's reach). */
function hatchAtRest(mn: MechNet, hs: Float64Array, p: Float64Array, inp: MechInputs): boolean {
  if (hs[H_W] !== 0 || inp.pull !== 0) return false;
  const dc = hs[H_DOGCMD], dg = hs[H_DOGS], th = hs[H_TH];
  if ((dc > 0 && dg < 1) || (dc < 0 && dg > 0 && th <= 0)) return false;
  if (dg < 1) return true;
  if (th >= HATCH_SEAL_ANGLE || th >= HATCH_OPEN) return true;
  const dp = p[mn.hatch.room] - p[mn.hatch.tunnel];
  return th <= 0 ? dp >= 0 : dp === 0;
}

/**
 * Advance every door and the hatch by T seconds (whole DOOR_H sub-steps; T is rounded down to them, a tick = 4) with
 * the room pressures p and the pressure-rate sensor depress (cabin io, Pa and Pa/s), then write the open fractions
 * into `open` (cabin io.open). Returns at once from the sub-step loop once everything is at rest. Allocation-free.
 */
export function doorsAdvance(mn: MechNet, st: MechState, p: Float64Array, depress: Float64Array, inp: MechInputs, out: MechOut, T: number, open: Float64Array): void {
  const d = st.door, hs = st.hatch, K = mn.K, nD = mn.nD;
  out.slamJ.fill(0);
  // auto-close sensing (once per call: the sensor sees the gas step's mean rate)
  for (let k = 0; k < nD; k++) {
    const o = k * DOOR_STRIDE;
    if (d[o + D_ARM] > 0 && d[o + D_FIRED] === 0 && (depress[mn.a[k]] < K[K_AUTO] || depress[mn.b[k]] < K[K_AUTO])) {
      d[o + D_FIRED] = 1; d[o + D_CMD] = -1;
    }
  }
  const n = Math.floor(T / DOOR_H + 1e-9);
  mn.acc[0] = 0;
  for (let j = 0; j < n; j++) {
    let rest = true;
    for (let k = 0; k < nD; k++) {
      if (doorAtRest(mn, d, k, inp.crank[k])) continue;
      rest = false;
      stepDoor(mn, d, k, p, inp, out, DOOR_H);
    }
    if (!hatchAtRest(mn, hs, p, inp)) { rest = false; stepHatch(mn, hs, p, inp, out, DOOR_H); }
    if (rest) break;
  }
  out.motorW = T > 0 ? mn.acc[0] * DOOR_H / T / 0.7 : 0;
  let busy = false;
  for (let k = 0; k < nD; k++) {
    const o = k * DOOR_STRIDE;
    if (!doorAtRest(mn, d, k, inp.crank[k])) busy = true;
    const f = (d[o + D_X] * mn.H[k] + d[o + D_S] * mn.gapK[k]) / mn.A[k];
    open[mn.orifice[k]] = d[o + D_S] > 0 ? (f < 1 ? f : 1) : 0;
    const vv = d[o + D_VALVE];
    open[mn.valve[k]] = vv > 0 ? (vv < 1 ? vv : 1) : 0;
  }
  if (!hatchAtRest(mn, hs, p, inp)) busy = true;
  const sth = Math.sin(hs[H_TH]);
  open[mn.hatch.orifice] = 2 * sth < 1 ? 2 * sth : 1;
  const hv = hs[H_VALVE];
  open[mn.hatch.valve] = hv > 0 ? (hv < 1 ? hv : 1) : 0;
  out.busy = busy;
}

/** A door button: command, re-arm the auto-close (a press is the crew's acknowledgement). */
export function pressDoor(st: MechState, k: number, cmd: number): void {
  const o = k * DOOR_STRIDE;
  st.door[o + D_CMD] = cmd > 0 ? 1 : cmd < 0 ? -1 : 0;
  st.door[o + D_ARM] = 1;
  st.door[o + D_FIRED] = 0;
}

/**
 * The leaf's box (ship axes) for the moving collider: the closed leaf (the doorway box) shifted along the slide
 * axis by x into its wall pocket; out = [minx, miny, minz, maxx, maxy, maxz].
 */
export function doorLeafBox(mn: MechNet, st: MechState, k: number, out: Float64Array): void {
  const dd = mn.doors[k], x = st.door[k * DOOR_STRIDE + D_X];
  const sx = dd.slide.x * x, sz = dd.slide.z * x;
  out[0] = dd.box.min.x + sx; out[1] = dd.box.min.y; out[2] = dd.box.min.z + sz;
  out[3] = dd.box.max.x + sx; out[4] = dd.box.max.y; out[5] = dd.box.max.z + sz;
}

// ------------------------------------------------------------------------------------------------ save / load

export function saveMech(st: MechState): { door: number[]; hatch: number[] } {
  return { door: Array.from(st.door), hatch: Array.from(st.hatch) };
}

export function loadMech(mn: MechNet, raw: unknown): MechState {
  const st = makeMechState(mn);
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const ok = (a: unknown, n: number): a is number[] => Array.isArray(a) && a.length === n && a.every((x) => typeof x === 'number' && Number.isFinite(x));
  if (ok(o.door, st.door.length)) st.door.set(o.door);
  if (ok(o.hatch, st.hatch.length)) st.hatch.set(o.hatch);
  return st;
}
