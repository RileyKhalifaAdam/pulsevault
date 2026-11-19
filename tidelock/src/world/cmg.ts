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
//   * session/control.ts, every 60 Hz control tick while a hold is on: cmgTakesHold(err, wRel, inertia, ...) decides
//     whether the hold runs on the CMGs (attitude.ts MODE_HOLD inside the ODE) or on the jets (wave-1 holdTorque):
//     onto the CMGs when the PD demand fits 80% of the pack and it is not saturated; back to the jets when the last
//     rotateHeld reported ro[RO_OVER] > CMG_OVER_TOL·τ_max (a slew faster than the pack can turn the ship).
//   * dynamics.ts integrateCraft, per translational step while the hold is on the CMGs, BEFORE the jets:
//       desatUpdate(c.cmg, c.cmgHMax, c.cmgTauMax)   // starts / ends a desaturation at step boundaries
//       configureCmg(ri, c.cmgHMax, c.cmgTauMax) once per craft (RI_HMAX, RI_UMAX, RI_WL* from the inertia)
//       if (c.cmg.desat) { desatCutDt(c.cmg, ri); cmd = 0; torqueToCmd(T, inp, c.cmg.tau, cmd);
//                          jetsStep(T, cmd, enabled, inp, duty, o); ri[RI_FF] = 1; ri[RI_DTMAX] = DESAT_DT_MAX }
//       ri[RI_TJ*] = o.t* (the ACTUAL jet couple, constant over the step: propellant o.mdotRcs·dt is exact)
//     The cut step length goes back to integrateCraft (like engineCutStep cuts inp[IN_H]). The jets' duty is
//     constant over the desaturation (≥ 15 s, ≈ 15–20 steps of ≤ 1 s): jetDuty / the duty tape / audio read it.
//   * world.ts save/load: saveCmgState(c.cmg) / loadCmgState(raw) (defaults: h = 0, no desaturation).
//   * audio (W2-F): rotor whine at CMG_ROTOR_HZ whenever the pack is powered; gimbal noise ∝ ro[RO_UMEAN];
//     power (W2-D bus): cmgPower(ro[RO_UMEAN]) W.
//   Contract fields: cmgH, cmgHMax, cmgTauMax (§1.4 wave 2). NEW field needed (report to the hub, W2-D):
//   `cmgDesat: { on: boolean, tau: V3 }` (saved) — the constant desaturation couple must survive save → load.

import type { V3 } from '../core/types';
import { RI_HMAX, RI_IX, RI_IY, RI_IZ, RI_DT, RI_DTMAX, RI_UMAX, RI_WLX, RI_WLY, RI_WLZ, DESAT_DT_MAX } from './attitude';

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
/** CMG-only slew: rate limit as a fraction of h_max/I per axis. */
export const CMG_SLEW_FRAC = 0.8;
/** Hand the hold onto the CMGs when the PD demand fits this fraction of τ_max ... */
export const CMG_TAKE_FRAC = 0.8;
/** ... and back to the jets when the pack's unmet demand exceeds this fraction of τ_max. */
export const CMG_OVER_TOL = 0.05;

export interface CmgState {
  /** Stored momentum, body axes, N·m·s (§1.4 cmgH). */
  h: V3;
  /** Desaturating: the jets hold the constant couple `tau` (body axes, N·m), the pack absorbs it. */
  desat: boolean;
  tau: V3;
}

export function makeCmgState(h?: V3): CmgState {
  return { h: h ?? { x: 0, y: 0, z: 0 }, desat: false, tau: { x: 0, y: 0, z: 0 } };
}

/** Pack limits and the CMG-only slew rates into the rotation input (needs ri[RI_IX..IZ] set). */
export function configureCmg(ri: Float64Array, hMax = CMG_H_AXIS, tauMax = CMG_TAU_AXIS): void {
  ri[RI_HMAX] = hMax;
  ri[RI_UMAX] = tauMax;
  ri[RI_WLX] = (CMG_SLEW_FRAC * hMax) / ri[RI_IX];
  ri[RI_WLY] = (CMG_SLEW_FRAC * hMax) / ri[RI_IY];
  ri[RI_WLZ] = (CMG_SLEW_FRAC * hMax) / ri[RI_IZ];
}

const ax3 = (v: V3): number => Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));

/**
 * At a step boundary: start a desaturation when any |h_i| > 0.8·h_max (couple τ = −h/T_d, T_d =
 * max(15 s, max|h_i|/(0.8·τ_max)), held constant to the end); end it when h has no component left along −τ.
 * Returns whether the pack is desaturating.
 */
export function desatUpdate(s: CmgState, hMax = CMG_H_AXIS, tauMax = CMG_TAU_AXIS): boolean {
  const h = s.h, t = s.tau;
  if (s.desat) {
    const tt = t.x * t.x + t.y * t.y + t.z * t.z;
    const left = tt > 0 ? -(h.x * t.x + h.y * t.y + h.z * t.z) / tt : 0;
    if (!(left > DESAT_END_T)) { s.desat = false; t.x = t.y = t.z = 0; }
    return s.desat;
  }
  const m = ax3(h);
  if (m > DESAT_START * hMax) {
    const Td = Math.max(DESAT_MIN_T, m / (DESAT_TAU_FRAC * tauMax));
    t.x = -h.x / Td; t.y = -h.y / Td; t.z = -h.z / Td;
    s.desat = true;
  }
  return s.desat;
}

/** Remaining time of the desaturation at its couple's rate, s (0 when not desaturating). */
export function desatTimeLeft(s: CmgState): number {
  if (!s.desat) return 0;
  const h = s.h, t = s.tau, tt = t.x * t.x + t.y * t.y + t.z * t.z;
  return tt > 0 ? Math.max(0, -(h.x * t.x + h.y * t.y + h.z * t.z) / tt) : 0;
}

/** While desaturating: cut ri[RI_DT] so the couple ends at a step boundary, and cap the sub-step at 1 s. */
export function desatCutDt(s: CmgState, ri: Float64Array): void {
  if (!s.desat) return;
  ri[RI_DTMAX] = DESAT_DT_MAX;
  const left = desatTimeLeft(s);
  if (left < ri[RI_DT]) ri[RI_DT] = left;
}

/**
 * Should the hold run on the CMGs? `err` is the attitude error vector (rad, body axes, 2·vec(q_e)), `wRel` the rate
 * error (rad/s), `inertia` the principal moments. True when the unclamped PD demand I·(ω_n²θ + 2ζω_n·ω_rel) fits
 * CMG_TAKE_FRAC of τ_max on every axis and no axis is pressed against the envelope edge in the demanded direction.
 */
export function cmgTakesHold(err: V3, wRel: V3, inertia: V3, h: V3, wn: number, zeta: number,
  hMax = CMG_H_AXIS, tauMax = CMG_TAU_AXIS): boolean {
  const k2 = wn * wn, k1 = 2 * zeta * wn, lim = CMG_TAKE_FRAC * tauMax;
  const tx = inertia.x * (k2 * err.x + k1 * wRel.x), ty = inertia.y * (k2 * err.y + k1 * wRel.y), tz = inertia.z * (k2 * err.z + k1 * wRel.z);
  if (Math.abs(tx) > lim || Math.abs(ty) > lim || Math.abs(tz) > lim) return false;
  // u ≈ −τ_c = +I(...) grows h along the demand: refuse if an axis is already at the edge that way.
  const e = 0.98 * hMax;
  if ((tx > 0 && h.x > e) || (tx < 0 && h.x < -e)) return false;
  if ((ty > 0 && h.y > e) || (ty < 0 && h.y < -e)) return false;
  if ((tz > 0 && h.z > e) || (tz < 0 && h.z < -e)) return false;
  return true;
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
  return { h: [s.h.x, s.h.y, s.h.z], d: s.desat ? 1 : 0, t: [s.tau.x, s.tau.y, s.tau.z] };
}

const num = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const vec = (x: unknown): V3 => {
  const a = Array.isArray(x) ? x : [];
  return { x: num(a[0], 0), y: num(a[1], 0), z: num(a[2], 0) };
};

/** Loader with defaults (older saves: h = 0, no desaturation). Writes into `into` when given (keeps c.cmgH aliasing). */
export function loadCmgState(raw: unknown, into?: CmgState): CmgState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const s = into ?? makeCmgState();
  const h = vec(r.h), t = vec(r.t);
  s.h.x = h.x; s.h.y = h.y; s.h.z = h.z;
  s.desat = r.d === 1 && (t.x !== 0 || t.y !== 0 || t.z !== 0);
  s.tau.x = s.desat ? t.x : 0; s.tau.y = s.desat ? t.y : 0; s.tau.z = s.desat ? t.z : 0;
  return s;
}

