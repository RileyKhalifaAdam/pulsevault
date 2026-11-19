// The CMG pack (SIMULATION.md W2-B items 1–2): four CMG-class units in a pyramid (ISS class: 4.8e3 N·m·s and
// 260 N·m each, rotors at 6600 rpm), modelled as a cluster envelope |h_i| ≤ 1.0e4 N·m·s and |ḣ_i| ≤ 520 N·m per body
// axis (no singularity modelling: not perceptible). This file holds the pack's state, the hand-over rule between
// the CMG hold and the 60 Hz jet controller, the constant-duty desaturation, power and save/load. The dynamics are
// in attitude.ts (rotateHeld: the hold law and the pack inside the rotation ODE).
//
// WIRING (wave 2; nothing here is called yet):
//   * setup.ts addCraft (ships with a pack; the parameters belong in shipLayouts.ts per the plan, exported here
//     until W2-B's wiring moves them): c.cmgH = {0,0,0}, c.cmgHMax = CMG_H_AXIS, c.cmgTauMax = CMG_TAU_AXIS,
//     c.cmg = makeCmgState() (holds h by reference: c.cmg.h === c.cmgH). Stations: no pack (see attitude.ts).
//   * session/control.ts, every 60 Hz control tick: cmgHoldUpdate(c.cmg, holdOn, wRel, inertia, tauExt) — onto the
//     CMGs when the hold is on, the pack's momentum after stopping the body relative to the target frame
//     (h + I·ω_rel) is ≤ 0.8·h_max on every axis, and the known external torque (gravity gradient + aero + engine)
//     fits 0.8·τ_max; off when the hold is released. While c.cmg.onCmg the hold runs on the CMGs (attitude.ts
//     MODE_HOLD inside the ODE), else on the jets (wave-1 holdTorque). The slew speed is whatever the momentum
//     budget allows (cmgSlewLimits), so a turn of any size on the CMGs is slow, free and silent.
//   * dynamics.ts integrateCraft, per translational step while c.cmg.onCmg, BEFORE the jets (t = step start time,
//     jetsOk = RCS propellant > 0 && jets enabled && any jet health > 0):
//       configureCmg(ri, c.cmgHMax, c.cmgTauMax) once per craft; cmgSlewLimits(ri, c.cmgH, wRel, c.cmgHMax) per step
//       ri[RI_FF] = 0; ri[RI_TJ*] = 0; ri[RI_DTMAX] = HOLD_DT_MAX
//       if (desatUpdate(c.cmg, t, jetsOk, ...)) {           // starts / ends a desaturation at step boundaries
//         cmd = 0; torqueToCmd(T, inp, c.cmg.tau, cmd); jetsStep(T, cmd, enabled, inp, duty, o);
//         ri[RI_TJ*] = o.t*                                   // the ACTUAL jet couple, constant over the step
//         if (!desatApply(c.cmg, ri, t)) { duty = 0; o = 0 }  // jets cannot deliver ≥ 50%: aborted, retry later
//       }                                                     // (desatApply sets FF, DTMAX and cuts ri[RI_DT])
//       rotateHeld(c.w, c.q, c.cmgH, ri, ro); cmgAfterRotate(c.cmg, ro)   // hands back to the jets if losing
//     The cut step length goes back to integrateCraft (like engineCutStep cuts inp[IN_H]); propellant o.mdotRcs·dt
//     is exact. The jets' duty is constant over the desaturation (≥ 15 s, ≈ 15–20 steps of ≤ 1 s).
//   * caution (W2-D / caution.ts): desatBlocked(c.cmg, t) → "CMG desaturation: no RCS authority" (the pack cannot
//     dump momentum: empty tank, jets off or failed); once saturated, cmgAfterRotate hands the hold to the jets,
//     which cannot hold either, and the ship drifts — honest, and said. No warp limit is needed: with no jets nothing
//     is integrated at a finer step than a free coast.
//   * world.ts save/load: saveCmgState(c.cmg) / loadCmgState(raw, c.cmg) (defaults: h = 0, no desaturation, hold on
//     the jets, no retry pending).
//   * audio (W2-F): rotor whine at CMG_ROTOR_HZ whenever the pack is powered; gimbal noise ∝ ro[RO_UMEAN];
//     power (W2-D bus): cmgPower(ro[RO_UMEAN]) W.
//   Contract fields: cmgH, cmgHMax, cmgTauMax (§1.4 wave 2). NEW field needed (report to the hub, W2-D):
//   `cmg: { desat: boolean, tau: V3, onCmg: boolean, retryAt: number }` (saved; was requested as cmgDesat {on, tau})
//   — the desaturation couple, the CMG/jets hand-over and the retry time all carry memory across steps.

import type { V3 } from '../core/types';
import {
  DESAT_DT_MAX, RI_DT, RI_DTMAX, RI_FF, RI_HMAX, RI_IX, RI_IY, RI_IZ, RI_TJX, RI_TJY, RI_TJZ, RI_UMAX, RI_WLX, RI_WLY, RI_WLZ, RO_OVER,
  RO_SAT,
} from './attitude';

/** Units in the pyramid; per-unit momentum (N·m·s) and torque (N·m). */
export const CMG_UNITS = 4;
export const CMG_H_UNIT = 4.8e3;
export const CMG_TAU_UNIT = 260;
/** Cluster envelope per body axis. */
export const CMG_H_AXIS = 1.0e4;
export const CMG_TAU_AXIS = 520;
/** Rotor speed (6600 rpm) as a frequency for audio, Hz. */
export const CMG_ROTOR_HZ = 6600 / 60;
/** Power per unit: standby (rotor at speed) and the most added while gimballing, W. */
export const CMG_P_STANDBY = 100;
export const CMG_P_ACTIVE = 300;
/** Desaturate above this fraction of h_max on any axis. */
export const DESAT_START = 0.8;
/** The desaturation couple is at most this fraction of the CMG torque (the rest stays with the hold). */
export const DESAT_TAU_FRAC = 0.8;
/** A desaturation lasts at least this long, s (SIMULATION.md review correction). */
export const DESAT_MIN_T = 15;
/** It ends when the remaining time at the couple's rate is below this, s. */
export const DESAT_END_T = 1e-3;
/** Abort when the jets deliver less than this fraction of the commanded couple (along it). */
export const DESAT_DELIVER_MIN = 0.5;
/** After an abort, do not try again for this long, s. */
export const DESAT_RETRY = 120;
/** CMG-only slew: the share of h_max a slew may use (the rate limit per axis is (this·h_max − |h_rest|)/I). */
export const CMG_SLEW_FRAC = 0.9;
/** ... and never below this share (a slow position loop stays alive with a full pack). */
export const CMG_SLEW_MIN = 0.02;
/** Hand the hold onto the CMGs when the known external torque fits this fraction of τ_max ... */
export const CMG_TAKE_FRAC = 0.8;
/** ... and back to the jets when the pack's unmet (losing) demand exceeds this fraction of τ_max. */
export const CMG_OVER_TOL = 0.05;

export interface CmgState {
  /** Stored momentum, body axes, N·m·s (§1.4 cmgH). */
  h: V3;
  /** Desaturating: the jets hold the constant couple `tau` (body axes, N·m; the DELIVERED couple), the pack absorbs it. */
  desat: boolean;
  tau: V3;
  /** The hold runs on the CMGs (else on the jets). Memory: it is saved. */
  onCmg: boolean;
  /** No desaturation starts before this time (s; after an abort for lack of jet authority). */
  retryAt: number;
}

export function makeCmgState(h?: V3): CmgState {
  return { h: h ?? { x: 0, y: 0, z: 0 }, desat: false, tau: { x: 0, y: 0, z: 0 }, onCmg: false, retryAt: -Infinity };
}

/** Pack limits and the CMG-only slew rates (empty pack) into the rotation input (needs ri[RI_IX..IZ] set). */
export function configureCmg(ri: Float64Array, hMax = CMG_H_AXIS, tauMax = CMG_TAU_AXIS): void {
  ri[RI_HMAX] = hMax;
  ri[RI_UMAX] = tauMax;
  ri[RI_WLX] = (CMG_SLEW_FRAC * hMax) / ri[RI_IX];
  ri[RI_WLY] = (CMG_SLEW_FRAC * hMax) / ri[RI_IY];
  ri[RI_WLZ] = (CMG_SLEW_FRAC * hMax) / ri[RI_IZ];
}

/**
 * Per step: the slew rate limits from the momentum budget. Stopping the body relative to the target frame leaves the
 * pack at h_rest = h + I·ω_rel (total momentum is conserved), which stays constant through a slew; a slew at ω_lim
 * adds I·ω_lim, so ω_lim,i = max(0, CMG_SLEW_FRAC·h_max − |h_rest,i|)/I_i never runs the pack past 0.9·h_max.
 */
export function cmgSlewLimits(ri: Float64Array, h: V3, wRel: V3, hMax = CMG_H_AXIS): void {
  const b = CMG_SLEW_FRAC * hMax;
  const rx = Math.abs(h.x + ri[RI_IX] * wRel.x), ry = Math.abs(h.y + ri[RI_IY] * wRel.y), rz = Math.abs(h.z + ri[RI_IZ] * wRel.z);
  // floor: CMG_SLEW_MIN·h_max/I keeps the attitude loop alive (slowly) when the budget is spent, so a full pack
  // still corrects its error until the edge, where cmgAfterRotate hands it to the jets
  const f = CMG_SLEW_MIN * hMax;
  ri[RI_WLX] = (rx < b - f ? b - rx : f) / ri[RI_IX];
  ri[RI_WLY] = (ry < b - f ? b - ry : f) / ri[RI_IY];
  ri[RI_WLZ] = (rz < b - f ? b - rz : f) / ri[RI_IZ];
}

const ax3 = (v: V3): number => Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));

/**
 * At a step boundary (time t): start a desaturation when any |h_i| > 0.8·h_max, the jets can fire (jetsOk) and no
 * retry is pending (couple τ = −h/T_d, T_d = max(15 s, max|h_i|/(0.8·τ_max))); end it when h has no component left
 * along −τ. Returns whether the pack is desaturating.
 */
export function desatUpdate(s: CmgState, t: number, jetsOk: boolean, hMax = CMG_H_AXIS, tauMax = CMG_TAU_AXIS): boolean {
  const h = s.h, c = s.tau;
  if (s.desat) {
    const tt = c.x * c.x + c.y * c.y + c.z * c.z;
    const left = tt > 0 ? -(h.x * c.x + h.y * c.y + h.z * c.z) / tt : 0;
    if (!(left > DESAT_END_T) || !jetsOk) { s.desat = false; c.x = c.y = c.z = 0; }
    return s.desat;
  }
  const m = ax3(h);
  if (m > DESAT_START * hMax && jetsOk && !(t < s.retryAt)) {
    const Td = Math.max(DESAT_MIN_T, m / (DESAT_TAU_FRAC * tauMax));
    c.x = -h.x / Td; c.y = -h.y / Td; c.z = -h.z / Td;
    s.desat = true;
  }
  return s.desat;
}

/**
 * After the jets were evaluated for the commanded couple s.tau and their ACTUAL couple put in ri[RI_TJ*]: if they
 * deliver less than DESAT_DELIVER_MIN of it (along it), abort (no retry before t + DESAT_RETRY; ri[RI_TJ*] and
 * RI_FF zeroed: the caller discards the jet output) and return false. Else adopt the delivered couple as s.tau, set
 * RI_FF = 1 and RI_DTMAX = DESAT_DT_MAX, cut ri[RI_DT] so the couple stops at a step boundary, and return true.
 */
export function desatApply(s: CmgState, ri: Float64Array, t: number): boolean {
  if (!s.desat) return false;
  const c = s.tau, h = s.h;
  const tx = ri[RI_TJX], ty = ri[RI_TJY], tz = ri[RI_TJZ];
  const cc = c.x * c.x + c.y * c.y + c.z * c.z;
  const along = cc > 0 ? (tx * c.x + ty * c.y + tz * c.z) / cc : 0;
  const dd = tx * tx + ty * ty + tz * tz;
  const left = dd > 0 ? -(h.x * tx + h.y * ty + h.z * tz) / dd : 0;
  if (!(along >= DESAT_DELIVER_MIN) || !(left > DESAT_END_T)) {
    s.desat = false; c.x = c.y = c.z = 0;
    if (!(along >= DESAT_DELIVER_MIN)) s.retryAt = t + DESAT_RETRY;
    ri[RI_TJX] = ri[RI_TJY] = ri[RI_TJZ] = 0; ri[RI_FF] = 0;
    return false;
  }
  c.x = tx; c.y = ty; c.z = tz;
  ri[RI_FF] = 1;
  ri[RI_DTMAX] = DESAT_DT_MAX;
  if (left < ri[RI_DT]) ri[RI_DT] = left;
  return true;
}

/** A desaturation was aborted for lack of jet authority and the retry is pending (caution). */
export const desatBlocked = (s: CmgState, t: number): boolean => t < s.retryAt;

/** Remaining time of the desaturation at its couple's rate, s (0 when not desaturating). */
export function desatTimeLeft(s: CmgState): number {
  if (!s.desat) return 0;
  const h = s.h, t = s.tau, tt = t.x * t.x + t.y * t.y + t.z * t.z;
  return tt > 0 ? Math.max(0, -(h.x * t.x + h.y * t.y + h.z * t.z) / tt) : 0;
}

/** Ideal jets (tests, tools): cut ri[RI_DT] at the couple s.tau's rate and cap the sub-step at 1 s. */
export function desatCutDt(s: CmgState, ri: Float64Array): void {
  if (!s.desat) return;
  ri[RI_DTMAX] = DESAT_DT_MAX;
  const left = desatTimeLeft(s);
  if (left < ri[RI_DT]) ri[RI_DT] = left;
}

/**
 * Can the CMGs take the hold? `wRel` is the body rate relative to the target frame (rad/s, body axes), `inertia` the
 * principal moments, `tauExt` the known external torque on the body (gravity gradient + aero + engine; N·m, body
 * axes; omit for none). True when stopping the body leaves the pack at |h_i + I_i·ω_rel,i| ≤ DESAT_START·h_max and
 * |τ_ext,i| ≤ CMG_TAKE_FRAC·τ_max on every axis. The attitude error does not matter: any turn fits, at the slew
 * rate the momentum budget allows (cmgSlewLimits), torque-limited while it spins up.
 */
export function cmgTakesHold(wRel: V3, inertia: V3, h: V3, tauExt?: V3, hMax = CMG_H_AXIS, tauMax = CMG_TAU_AXIS): boolean {
  const e = DESAT_START * hMax;
  if (Math.abs(h.x + inertia.x * wRel.x) > e || Math.abs(h.y + inertia.y * wRel.y) > e || Math.abs(h.z + inertia.z * wRel.z) > e) return false;
  if (tauExt) {
    const l = CMG_TAKE_FRAC * tauMax;
    if (Math.abs(tauExt.x) > l || Math.abs(tauExt.y) > l || Math.abs(tauExt.z) > l) return false;
  }
  return true;
}

/** Control tick: the hand-over onto the CMGs (and off when the hold is released). Returns s.onCmg. */
export function cmgHoldUpdate(s: CmgState, holdOn: boolean, wRel: V3, inertia: V3, tauExt?: V3, hMax = CMG_H_AXIS, tauMax = CMG_TAU_AXIS): boolean {
  if (!holdOn) s.onCmg = false;
  else if (!s.onCmg && cmgTakesHold(wRel, inertia, s.h, tauExt, hMax, tauMax)) s.onCmg = true;
  return s.onCmg;
}

/**
 * After rotateHeld in MODE_HOLD: back to the jets when the pack was losing — by more than CMG_OVER_TOL·τ_max (a
 * disturbance above τ_max), or by any amount while an axis was in the envelope's edge band (ro[RO_SAT]: the pack is
 * full and the body is being pushed off; a small disturbance would otherwise drift it quietly).
 */
export function cmgAfterRotate(s: CmgState, ro: Float64Array, tauMax = CMG_TAU_AXIS): boolean {
  const over = ro[RO_OVER];
  if (over > CMG_OVER_TOL * tauMax || (ro[RO_SAT] !== 0 && over > 0)) s.onCmg = false;
  return s.onCmg;
}

/** Electrical power of the pack, W, at a mean output torque magnitude uMean (N·m). */
export function cmgPower(uMean: number, tauMax = CMG_TAU_AXIS): number {
  const f = uMean > 0 ? Math.min(1, uMean / tauMax) : 0;
  return CMG_UNITS * (CMG_P_STANDBY + CMG_P_ACTIVE * f);
}

/** Momentum swing a cyclic gravity-gradient torque of amplitude tau (twice orbital frequency) produces, N·m·s. */
export const ggMomentumSwing = (tau: number, n: number): number => tau / (2 * n);

// ============================================================================================= save / load

export function saveCmgState(s: CmgState): Record<string, unknown> {
  const o: Record<string, unknown> = { h: [s.h.x, s.h.y, s.h.z], d: s.desat ? 1 : 0, t: [s.tau.x, s.tau.y, s.tau.z], o: s.onCmg ? 1 : 0 };
  if (Number.isFinite(s.retryAt)) o.r = s.retryAt;
  return o;
}

const num = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const vec = (x: unknown): V3 => {
  const a = Array.isArray(x) ? x : [];
  return { x: num(a[0], 0), y: num(a[1], 0), z: num(a[2], 0) };
};

/**
 * Loader with defaults (older saves: h = 0, no desaturation, hold on the jets, no retry pending). Writes into `into`
 * when given (keeps c.cmgH aliasing).
 */
export function loadCmgState(raw: unknown, into?: CmgState): CmgState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const s = into ?? makeCmgState();
  const h = vec(r.h), t = vec(r.t);
  s.h.x = h.x; s.h.y = h.y; s.h.z = h.z;
  s.desat = r.d === 1 && (t.x !== 0 || t.y !== 0 || t.z !== 0);
  s.tau.x = s.desat ? t.x : 0; s.tau.y = s.desat ? t.y : 0; s.tau.z = s.desat ? t.z : 0;
  s.onCmg = r.o === 1;
  s.retryAt = num(r.r, -Infinity);
  return s;
}
