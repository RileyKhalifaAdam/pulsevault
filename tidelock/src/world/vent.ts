// Vents: the reaction of gas leaving the ship (docs/SIMULATION.md §1.4 `vent: {F, tau, mdot}`, W3-B items 1 and 5).
// Every source that throws mass overboard — a breach or an open collar (compartments.ts), the airlock dump valve, the
// LH2 boil-off relief pair and the condensate dump (cryo.ts) — books its IMPULSE here per step: dJ = −dm·u_eff·n̂ at
// the exit point (n̂ the outward normal), dL = (r − com) × dJ. Each source keeps its own slot, published as the mean
// over its own step (F = J/span), so sources stepped at different rates (venting every tick, the cryo tank at the
// systems rate) add up without resampling. `ventTotal` sums the slots into the §1.4 contract field; `ventConsume`
// hands the exact impulse since the last consumption to the dynamics (preferred over F·dt: exact at any step).
//
// Effective exhaust velocity of a sharp orifice from a reservoir at p₀, T₀ into p_d (the momentum of the jet once it
// has expanded to the ambient pressure, which is what the ship feels):
//   choked (p_d/p₀ ≤ r*): u_eff = u*·(1 + (1 − p_d/p*)/γ), u* = √(γ·R·T*/M), T* = 2T₀/(γ+1), p* = r*·p₀
//     (F = ṁ·u* + (p* − p_d)·A* with A* = ṁ/(ρ*u*)); to vacuum u_eff = u*(γ+1)/γ = 537 m/s for air at 293 K, i.e.
//     the sonic-orifice thrust coefficient F/(C_d·A·p₀) = (γ+1)·r* = 1.268;
//   subsonic: u_e = √(2·c_p·T₀·(1 − (p_d/p₀)^((γ−1)/γ))) (isentropic, fully expanded, no pressure thrust).
//
// WIRING (wave 3): state.ts holds c.ventState = loadVent(saved?.vent) and the §1.4 field c.vent = {F, tau, mdot}
//   (ship axes, N, N·m, kg/s) filled by ventTotal(c.ventState, c.vent) after each source's publish; W3-A's dynamics
//   applies c.vent.F / c.vent.tau as a constant proper force / torque over its steps (or, exactly, the impulse from
//   ventConsume once per tick, after consumeLedger, adding it to fAcc/tauAcc and Δv/Δω) and removes c.vent.mdot of
//   mass; W3-C's predictor reads c.vent.F as a thrust while |F| > 0 ('venting'). Pure, allocation-free, deterministic.

import { GAMMA, R_GAS } from './life';

/** Source slots. */
export const VENT_GAS = 0; // breaches, open collar, airlock dump (compartments.ts, every gas step)
export const VENT_BOIL = 1; // LH2 relief pair (cryo.ts)
export const VENT_DUMP = 2; // condensate dump (cryo.ts)
export const N_VENT_SRC = 3;
const SLOT = 7; // Fx Fy Fz Tx Ty Tz mdot (step means)

export interface VentState {
  /** Published step means per source (SLOT numbers each). */
  pub: Float64Array;
  /** Running impulse of the current span per source: Jx Jy Jz Lx Ly Lz m. */
  span: Float64Array;
  /** Impulse, angular impulse and mass since the last ventConsume: Jx Jy Jz Lx Ly Lz m. */
  acc: Float64Array;
  /** Centre of mass the torques are taken about (ship axes, m): W3-A writes c.com here before the step. */
  com: Float64Array;
}

export function makeVentState(): VentState {
  return { pub: new Float64Array(N_VENT_SRC * SLOT), span: new Float64Array(N_VENT_SRC * SLOT), acc: new Float64Array(7), com: new Float64Array(3) };
}

/**
 * Book mass dm (kg, ≥ 0) leaving at exit point (px, py, pz) along the outward unit normal (nx, ny, nz) at effective
 * velocity u (m/s) into source `src`'s current span: the ship receives −dm·u·n̂.
 */
export function ventAdd(v: VentState, src: number, dm: number, u: number, px: number, py: number, pz: number, nx: number, ny: number, nz: number): void {
  if (!(dm > 0)) return;
  const j = -dm * u, s = v.span, o = src * SLOT;
  const Jx = j * nx, Jy = j * ny, Jz = j * nz;
  const rx = px - v.com[0], ry = py - v.com[1], rz = pz - v.com[2];
  s[o] += Jx; s[o + 1] += Jy; s[o + 2] += Jz;
  s[o + 3] += ry * Jz - rz * Jy; s[o + 4] += rz * Jx - rx * Jz; s[o + 5] += rx * Jy - ry * Jx;
  s[o + 6] += dm;
}

/** End source `src`'s span of `T` seconds: publish F = J/T, τ = L/T, ṁ = m/T; move the impulse to the accumulator. */
export function ventPublish(v: VentState, src: number, T: number): void {
  const s = v.span, p = v.pub, a = v.acc, o = src * SLOT;
  const iT = T > 0 ? 1 / T : 0;
  for (let k = 0; k < SLOT; k++) { p[o + k] = s[o + k] * iT; a[k] += s[o + k]; s[o + k] = 0; }
}

/** The §1.4 field: the sum of the sources' published means. */
export function ventTotal(v: VentState, out: { F: { x: number; y: number; z: number }; tau: { x: number; y: number; z: number }; mdot: number }): void {
  let fx = 0, fy = 0, fz = 0, tx = 0, ty = 0, tz = 0, m = 0;
  const p = v.pub;
  for (let s = 0, o = 0; s < N_VENT_SRC; s++, o += SLOT) { fx += p[o]; fy += p[o + 1]; fz += p[o + 2]; tx += p[o + 3]; ty += p[o + 4]; tz += p[o + 5]; m += p[o + 6]; }
  out.F.x = fx; out.F.y = fy; out.F.z = fz; out.tau.x = tx; out.tau.y = ty; out.tau.z = tz; out.mdot = m;
}

/** Hand the exact impulse since the last call to the dynamics (out: Jx Jy Jz Lx Ly Lz m) and zero it. */
export function ventConsume(v: VentState, out: Float64Array): void {
  const a = v.acc;
  for (let k = 0; k < 7; k++) { out[k] = a[k]; a[k] = 0; }
}

// ------------------------------------------------------------------------------------------------ exit velocity

/** Critical pressure ratio of air (γ = 1.4) and the subsonic expansion table g(r) = √(1 − r^((γ−1)/γ)). */
export const VENT_RSTAR = Math.pow(2 / (GAMMA + 1), GAMMA / (GAMMA - 1));
const G_N = 128;
const G_TAB: Float64Array = (() => {
  const t = new Float64Array(G_N + 1);
  for (let j = 0; j <= G_N; j++) {
    const r = VENT_RSTAR + (1 - VENT_RSTAR) * (j / G_N);
    t[j] = j === G_N ? 0 : Math.sqrt(1 - Math.pow(r, (GAMMA - 1) / GAMMA));
  }
  return t;
})();
const KV = Float64Array.of(VENT_RSTAR, G_N / (1 - VENT_RSTAR), GAMMA, R_GAS);

/**
 * Effective exhaust velocity (m/s) of air (γ = 1.4) of molar mass M (kg/mol) from a reservoir at T0 (K) through an
 * orifice at pressure ratio r = p_down/p_up (header). r ≥ 1 gives 0.
 */
export function ventExitVelocity(r: number, T0: number, M: number): number {
  const g = KV[2], R = KV[3];
  if (!(r < 1) || !(T0 > 0) || !(M > 0)) return 0;
  if (r <= KV[0]) {
    const us = Math.sqrt(g * R * T0 * 2 / ((g + 1) * M));
    return us * (1 + (1 - (r > 0 ? r / KV[0] : 0)) / g);
  }
  let u = (r - KV[0]) * KV[1];
  const j = u | 0;
  u -= j;
  const gr = j >= G_N ? 0 : G_TAB[j] + (G_TAB[j + 1] - G_TAB[j]) * u;
  return Math.sqrt(2 * g * R * T0 / ((g - 1) * M)) * gr;
}

/** Choked effective velocity to vacuum for a gas of ratio γ, molar mass M, reservoir T0: u*(γ+1)/γ (cryo vents). */
export function sonicVentVelocity(gamma: number, M: number, T0: number): number {
  return Math.sqrt(gamma * R_GAS * T0 * 2 / ((gamma + 1) * M)) * (gamma + 1) / gamma;
}

// ------------------------------------------------------------------------------------------------ save / load

export interface VentSave { pub: number[]; span: number[]; acc: number[] }

export function saveVent(v: VentState): VentSave {
  return { pub: Array.from(v.pub), span: Array.from(v.span), acc: Array.from(v.acc) };
}

export function loadVent(raw: unknown): VentState {
  const v = makeVentState();
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const fill = (dst: Float64Array, src: unknown): void => {
    if (!Array.isArray(src) || src.length !== dst.length) return;
    for (let i = 0; i < dst.length; i++) { const x = src[i]; dst[i] = typeof x === 'number' && Number.isFinite(x) ? x : 0; }
  };
  fill(v.pub, o.pub); fill(v.span, o.span); fill(v.acc, o.acc);
  return v;
}
