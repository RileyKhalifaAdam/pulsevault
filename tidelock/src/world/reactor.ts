// The reactor core (docs/SIMULATION.md W3-B item 4; §3: no point kinetics — Λ ≈ 1e-4 s is stiff and invisible).
//
// Fission power P_f (thermal, W) is a first-order lag toward the rod setpoint S: dP_f/dt = (S − P_f)/τ, τ = 30 s.
// A SCRAM is the textbook asymptote of a large negative reactivity insertion: a prompt jump to J = 0.1 of P_f
// (ρ ≈ −9 $: β/(β − ρ)) and then the longest delayed-neutron period, τ_s = 80 s, toward 0.
// Decay heat from the fission products, for ANY power history, as a sum of 19 first-order groups (rates s_i
// log-spaced at half decades, 1e-9 … 1 s⁻¹): dD_i/dt = s_i·(a_i·P_f − D_i), with yields a_i = (C/Γ(0.2))·s_i^0.2·Δ,
// C = 0.066 (the plan's 0.066·P₀·t^−0.2), Δ = ln(10)/2. This is the exact quadrature of
//   t^−0.2 = (1/Γ(0.2))·∫ s^0.2·e^(−s·t) d(ln s)
// with the trapezoidal rule in ln s, which converges spectrally for this smooth integrand: after T_op of operation at
// P₀ the decay heat is C·P₀·[t^−0.2 − (t + T_op)^−0.2] (the Way–Wigner form) to < 1 % for 10 s ≤ t ≤ 1e7 s, T_op ≤
// 1e8 s (tests). Σa_i = 7.95 % (the delayed share); thermal power = (1 − Σa)·P_f + ΣD_i, = P_f in steady state.
// Integration: EXACT for a piecewise-constant setpoint at any step (P_f is an exponential, each group's response to
// it is closed form), so the core is warp-honest with no limitedBy, and the energy of the step is the exact integral.
//
// Electric output P_e = η·P_th (η = 0.3, powerNet REACTOR_ETA); the waste P_th − P_e goes to the reactor-bay node.
// Demand following (coreAdvance): the controller holds the TOTAL thermal power at P_target,e/η (≤ the lever × rated),
// so after an up-step the electric output reaches 98 % in ≈ 2 min. DRIVE ARM is the "drive standby" (review / critic):
// arming raises the target to the drive load, and the torch lights only once the drive bus carries it (power.ts
// DRIVE_READY_FRAC), so the procedure is arm, wait ≈ 2 min, light. After a scram the core still makes
// 0.066·P₀·t^−0.2 of heat (≈ 4 MW thermal 10 s after a long run at the rated 93 MW, ≈ 1 MW after an hour): the loop must keep
// rejecting it, and that is what makes the engineering page matter.
//
// WIRING (wave 3): power.ts powerStep's exact ramp `ramp(P1, target, up, down, t)` is REPLACED by
//   coreAdvance(core, target, st.scram, t, RAMP)   (RAMP[0] = electric J over t, RAMP[1] = electric W at the end)
// with the same two-piece split across a standby lapse; st.reactorP becomes coreElectric(core); powerOut.reactorWasteJ
// = core.out[CO_THERMAL_J] − RAMP[0] summed over the pieces (it then includes decay heat after a scram, which the
// shunt must take). Rate: powerStep's rate (10 Hz at 1×, ≤ 30 s steps under warp). Core glow for W3-E: coreThermal.
// §1.4: power.reactorSet is the lever (S ≤ reactorSet·rated thermal); saved: c.systems.reactor = saveCore(core).

import { REACTOR_ETA, REACTOR_P_RATED } from '../data/powerNet';

const mexp = (x: number): number => Math.exp(x);
const mexpm1 = (x: number): number => Math.expm1(x);

export const CORE_TAU = 30;
export const SCRAM_TAU = 80;
export const SCRAM_JUMP = 0.1;
export const DECAY_C = 0.066;
export const N_GROUPS = 19;
/** Rated thermal power, W (electric rating / η). */
export const CORE_P_RATED = REACTOR_P_RATED / REACTOR_ETA;
const GAMMA_02 = 4.590843711998803; // Γ(0.2)
const DELTA = Math.LN10 / 2;

export const GROUP_S: Float64Array = Float64Array.from({ length: N_GROUPS }, (_, i) => Math.pow(10, -9 + i / 2));
export const GROUP_A: Float64Array = Float64Array.from(GROUP_S, (s) => (DECAY_C / GAMMA_02) * Math.pow(s, 0.2) * DELTA);
export const DELAYED_FRACTION = GROUP_A.reduce((a, b) => a + b, 0);
/** Hot constants in a typed array: a computed module const becomes a `var` in the bundle, and V8 boxes arithmetic on
 *  it (measured: an allocation per call; 0 with this). [Σa, rated thermal W]. */
const RK = Float64Array.of(DELAYED_FRACTION, CORE_P_RATED);

/** Output slots (of the last coreAdvance). */
export const CO_THERMAL_J = 0, CO_DECAY_J = 1, CO_FISSION_J = 2;

export interface CoreState {
  /** Fission power, W thermal. */
  Pf: number;
  /** Decay-heat group powers, W. */
  D: Float64Array;
  /** 1 once scrammed (the prompt jump has been applied), until the scram is reset. */
  scrammed: number;
  /** Outputs of the last call (CO_*), then the step's setpoint and h (scratch; not saved). */
  out: Float64Array;
}

export function makeCore(P0 = 0): CoreState {
  const D = new Float64Array(N_GROUPS);
  for (let i = 0; i < N_GROUPS; i++) D[i] = GROUP_A[i] * P0;
  return { Pf: P0, D, scrammed: 0, out: new Float64Array(5) };
}

export const coreDecay = (c: CoreState): number => { let s = 0; for (let i = 0; i < N_GROUPS; i++) s += c.D[i]; return s; };
/** Thermal power now, W. */
export const coreThermal = (c: CoreState): number => (1 - DELAYED_FRACTION) * c.Pf + coreDecay(c);
export const coreElectric = (c: CoreState): number => REACTOR_ETA * coreThermal(c);

/**
 * Advance the core by h seconds toward the thermal setpoint S (W; ignored while scrammed), exactly. Writes the
 * step's thermal, decay and fission energies into c.out. Allocation-free.
 */
export function coreStep(c: CoreState, S: number, scram: number, h: number): void {
  c.out[3] = S; c.out[4] = h;
  coreStepK(c, scram);
}

/** coreStep with S and h in c.out[3], c.out[4] (doubles passed through a typed array: no heap-number boxing). */
function coreStepK(c: CoreState, scram: number): void {
  const o = c.out;
  const S = o[3], h = o[4];
  o[0] = 0; o[1] = 0; o[2] = 0;
  if (!(h > 0)) return;
  if (scram > 0 && c.scrammed === 0) { c.scrammed = 1; c.Pf *= SCRAM_JUMP; }
  else if (!(scram > 0)) c.scrammed = 0;
  const tau = c.scrammed ? SCRAM_TAU : CORE_TAU;
  const s = c.scrammed ? 0 : (S > 0 ? S : 0);
  const P0 = c.Pf, dP = P0 - s;
  const ekm = -mexpm1(-h / tau), ek = 1 - ekm; // 1 − e^(−h/τ) without cancellation
  const intP = s * h + dP * tau * ekm;
  const r = 1 / tau;
  let dsum = 0, Ed = 0;
  for (let i = 0; i < N_GROUPS; i++) {
    const lam = GROUP_S[i], a = GROUP_A[i], D0 = c.D[i];
    const elm = -mexpm1(-lam * h), el = 1 - elm;
    const dl = lam - r;
    const cross = (dl > 1e-12 || dl < -1e-12) ? (elm - ekm) / dl : h * el; // (e^(−rh) − e^(−λh))/(λ − r)
    const D1 = a * s * elm + D0 * el + a * lam * dP * cross;
    Ed += a * intP - (D1 - D0) / lam;
    c.D[i] = D1;
    dsum += D1;
  }
  c.Pf = s + dP * ek;
  o[CO_FISSION_J] = intP;
  o[CO_DECAY_J] = Ed;
  o[CO_THERMAL_J] = (1 - RK[0]) * intP + Ed;
  void dsum;
}

/**
 * power.ts adapter (replaces its exact ramp): advance toward an ELECTRIC target (W) for t seconds; ramp[0] = electric
 * energy (J), ramp[1] = electric power at the end (W). The power controller holds TOTAL thermal power at target/η
 * (≤ rated): it sets the fission level S_f = (P_t − ΣD)/(1 − Σa) from the decay heat at the step's start, so the
 * delayed 8 % does not lag the demand by hours (it overdrives the fission power by ≈ 8 % on an up-step and trims it as
 * the fission products build up). ΣD changes on time scales ≥ 1 s, so this is step-size independent to second order
 * (tests: 0.1 s vs 30 s steps); coreStep itself is exact.
 */
export function coreAdvance(c: CoreState, targetElectric: number, scram: number, t: number, ramp: Float64Array): void {
  let Pt = targetElectric / REACTOR_ETA;
  if (Pt > RK[1]) Pt = RK[1];
  // sums inlined: a non-inlined call returning a double boxes it (an allocation per call)
  let d0 = 0;
  for (let i = 0; i < N_GROUPS; i++) d0 += c.D[i];
  let S = (Pt - d0) / (1 - RK[0]);
  if (S < 0) S = 0; else if (S > RK[1]) S = RK[1];
  c.out[3] = S; c.out[4] = t;
  coreStepK(c, scram);
  ramp[0] = REACTOR_ETA * c.out[CO_THERMAL_J];
  let d1 = 0;
  for (let i = 0; i < N_GROUPS; i++) d1 += c.D[i];
  ramp[1] = REACTOR_ETA * ((1 - RK[0]) * c.Pf + d1);
}

/** Way–Wigner decay heat fraction after T_op of operation, t after shutdown (the closed form the groups reproduce). */
export const wayWigner = (t: number, Top: number): number => DECAY_C * (Math.pow(t, -0.2) - Math.pow(t + Top, -0.2));

export function saveCore(c: CoreState): { Pf: number; D: number[]; scrammed: number } {
  return { Pf: c.Pf, D: Array.from(c.D), scrammed: c.scrammed };
}

export function loadCore(raw: unknown, P0 = 0): CoreState {
  const c = makeCore(P0);
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (typeof o.Pf === 'number' && Number.isFinite(o.Pf) && o.Pf >= 0) c.Pf = o.Pf;
  if (Array.isArray(o.D) && o.D.length === N_GROUPS && o.D.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0)) c.D.set(o.D);
  else for (let i = 0; i < N_GROUPS; i++) c.D[i] = GROUP_A[i] * c.Pf;
  c.scrammed = o.scrammed === 1 ? 1 : 0;
  return c;
}
