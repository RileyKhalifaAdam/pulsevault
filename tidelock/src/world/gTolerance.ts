// W3-D item 4 "Acceleration physiology" (docs/SIMULATION.md §2 W3-D, `body-g-physiology`; the vestibular part is §3
// NOT DOING): what sustained acceleration and the cabin air do to the pilot's eyes, brain and breathing. Pure
// TypeScript, deterministic, allocation-free per step (state, inputs and outputs live in Float64Arrays; module scratch),
// SI units in and out (Pa, m/s², s; mmHg only as named constants), plain-JSON save.
//
// Model (first principles, one parameter set; the numbers each piece is fitted to are in tests/gTolerance.test.ts).
// - Hydrostatics. Body axes: +x right, +y head (up the spine), +z back (−z = chest, forward), as the ship's axes.
//   f = the specific force the body feels (what an accelerometer on the torso reads; standing on Earth f = +g ŷ).
//   Pressure at the eye and the brain: P = P_heart + p_B − ρ_blood·(f·d), with d the heart→eye (0, 0.30, −0.05) m and
//   heart→brain (0, 0.30, −0.02) m, P_heart = 120 mmHg, ρ = 1060 kg/m³: 23.4 mmHg per g along the spine. A reclined
//   seat or lying down needs no special case: f in body axes carries the recline (column × cos θ), and +Gx loses only
//   the small anterior offset (that is why +Gx is so much better tolerated).
// - Baroreflex p_B: first order, τ = 8 s, toward K·(P_eye(1 g) − P_eye,raw) clamped to −25 … +29.2 mmHg (+1.25 g).
//   It works both ways, so −Gz before +Gz lowers +Gz tolerance (the push-pull effect) with no extra rule.
// - Perfusion with autoregulation: retina q_r = clamp((P_eye − IOP)/72 mmHg, 0, 1), IOP 15 mmHg; brain
//   q_b = clamp(P_brain/50 mmHg, 0, 1) (jugular siphon: venous ≈ 0); both × the chemical factor
//   (1 + 0.03/mmHg·(PaCO₂ − 40)) · (1 + 0.8·clamp((50 − PaO₂)/30, 0, 1)) (CO₂ and hypoxic vasodilation).
// - Tissue oxygen reservoir per tissue, x ∈ [0, 1]: dx/dt = (q·(a − x) − c)/T (uptake ∝ flow × the gradient from
//   the arterial driver a to the tissue, against a constant demand c). Steady x = a − c/q; at zero flow x falls
//   linearly (the ~5 s "O₂ reserve"). Exact for frozen q and a: x = x_ss + (x − x_ss)·e^(−q h/T) (x = x − c h/T at
//   q = 0), clamped at 0, unconditionally stable. Brain c 0.40, T 4.22 s; retina c 0.33, T 2.07 s.
//   a = ½·SaO₂/SaO₂,ref + ½·min(PaO₂, 1.2 PaO₂,ref)/PaO₂,ref (content and tension; 1 at sea-level air).
// - Vision from the retina: tunnel (peripheral light loss) from x_r = 0.386 to 0.033, grey from 0.486, black
//   (central light loss) from 0.174. G-LOC when the brain x_b < 0.126; consciousness returns after 12 s of
//   reperfusion (x_b ≥ 0.25) — "absolute incapacitation" — then 15 s of "relative incapacitation" with the hands'
//   control ramping 0 → 1 (Whinnery's 12 s + 15 s). The hands have no control while unconscious.
// - −Gz red-out: venous pressure at the eye P_v = 5 mmHg − ρ(f·d) engorges the lids; red = clamp((P_v − 30)/30
//   mmHg) through a 1.5 s lag (−2 … −3 g).
// - Breathing (the cabin's hypoxia and hypercapnia, cabin.ts): PiO₂ = ppO₂/p·(p − 47 mmHg) (humidified; zero at or
//   below 47 mmHg = 6.3 kPa, the Armstrong line), PiCO₂ likewise; alveolar ventilation V̇_A = 4.3 L/min ×
//   (1 + 0.45/mmHg·(PaCO₂ − 40)⁺ + clamp((60 − PaO₂)/30, 0, 1.5)), capped by the chest load:
//   60·max(0.02, 1 − (G_x/16)²) L/min; PACO₂ target = PiCO₂ + 172 mmHg·L/min / V̇_A (≤ p − 47), PaCO₂ follows with
//   τ = 90 s; PAO₂ = PiO₂ − (PaCO₂ − PiCO₂)(FiO₂ + (1 − FiO₂)/0.8); PaO₂ = PAO₂ − (5 + 3(|f|/g − 1)⁺) mmHg
//   (V/Q mismatch under load); the PaO₂ the head receives follows with τ = 5 s (lung-to-brain transit).
//   SaO₂ from Severinghaus (1979): S = 1/(23400/(P³ + 150P) + 1). CO₂ narcosis: unconscious above PaCO₂ 100 mmHg.
//   Vacuum: unconscious in ≈ 12 s (useful consciousness 9–15 s).
// - Sustained-acceleration strain doses (the Eiband / NASA-STD-3001 time limits, ±Gx, ±Gy, −Gz; +Gz is the
//   cardiovascular model above): D' = (G/G_ref)^3.5 / T_ref − D/300 s above an onset; D = 1 is the voluntary
//   tolerance end point. +Gx (6 g, 600 s) → 12 g ≈ 53 s, 15 g ≈ 24 s; −Gx (5 g, 300 s); ±Gy (3 g, 300 s);
//   −Gz (3 g, 30 s) → 5 g ≈ 5 s. Exact exponential for constant G. injury.ts turns doses into injuries.
// - Brain anoxia dose (for injury.ts): while x_b < 0.08, dA/dt = (0.08 − x_b)/0.08 / 240 s; 1 = irreversible
//   (≈ 4 min of no flow), decays with τ = 1 h.
//
// Rates and warp honesty. At 1× step h = Q (once per tick, after the crew step, with the tick's mean felt force at
// the torso). Under warp: the continuous states are split into ≤ 0.25 s sub-steps (≤ 128 per call) while they are in
// a transient; once they sit at the fixed point of unchanged inputs (`settled`) one exact step covers any h. The
// timers and doses are exact at any h. physioMaxStep() gives the step the transient wants (`crew` limitedBy reason
// while finite); at sleep in the bunk at 1 bar the state is settled within minutes and costs one step per quantum.
//
// WIRING (wave 3; nothing here is called yet):
// - crew.ts stepCrew / session.ts helm, once per tick after the body step (h = Q; under warp once per quantum, h = q):
//     GI[GI_FX..FZ] = the tick's mean felt specific force at the torso in BODY axes (seated: the seat frame, so the
//       recline is in it — qRotInv(bodyQ, …) of crew.ts feltAt / body.ts helm f; standing: the boot frame; floating:
//       W3-D's floating attitude; asleep in the bunk: BUNK frame — lying is −Gx/+Gx, not Gz)
//     GI[GI_PPO2], GI[GI_PPCO2], GI[GI_P] = the partial pressures and total pressure of the room the head is in
//       (cabin.ts room state; a helmet or suit later supplies its own)
//     stepPhysiology(crew.gt, GI, h, GO)  — then injury.ts injuryPhysio(crew.inj, crew.gt, h) and crewCondition().
// - Replaces nothing (there is no g physiology today). Reads no §1.4 field directly (felt force comes from the body
//   step that reads fAcc/accT; gas from cabin.ts `cabin.rooms`). Writes no §1.4 field: it owns crew.gt (saved).
// - world.ts limitedBy: 'crew' while physioMaxStep(gt) < the quantum (only in a physiological transient under warp).
// - Save: savePhysiology(gt) / loadPhysiology(raw) (loader default: rested, at sea-level air, conscious).

import { G0 } from './body';

// ------------------------------------------------------------------------------------------------ wrappers (§1.1 rule 6)

const mexp = (x: number): number => Math.exp(x);

// ------------------------------------------------------------------------------------------------ constants

export const MMHG = 133.322387415;
export const RHO_BLOOD = 1060;
/** heart → eye and heart → brain, body axes (m). */
export const EYE_DY = 0.3, EYE_DZ = -0.05;
export const BRAIN_DY = 0.3, BRAIN_DZ = -0.02;
export const P_HEART = 120 * MMHG;
export const P_EYE_1G = P_HEART - RHO_BLOOD * G0 * EYE_DY;
/** Pa per g along the spine at the eye (≈ 23.4 mmHg). */
export const COLUMN_PER_G = RHO_BLOOD * G0 * EYE_DY;
export const BARO_TAU = 8;
export const BARO_K = 0.5;
export const BARO_MAX = 1.25 * COLUMN_PER_G;
export const BARO_MIN = -25 * MMHG;
export const IOP = 15 * MMHG;
export const AR_RETINA = 72 * MMHG;
export const AR_BRAIN = 50 * MMHG;
export const Q_MAX = 2.5;

export const C_BRAIN = 0.4, T_BRAIN = 4.22;
export const C_RETINA = 0.33, T_RETINA = 2.07;
/** Retinal reservoir thresholds: tunnel starts / complete, grey starts, black (central loss) starts. */
export const X_PLL = 0.386, X_CLL = 0.033;
export const X_GREY = X_PLL + 0.1;
export const X_BLACK = X_CLL + 0.4 * (X_PLL - X_CLL);
/** Brain: G-LOC below, reperfused above (counts toward waking), impaired below. */
export const X_LOC = 0.126, X_WAKE = 0.25, X_IMPAIR = 0.4;
export const T_ABS = 12;
export const T_REL = 15;

export const P_V0 = 5 * MMHG;
export const RED_0 = 30 * MMHG, RED_SPAN = 30 * MMHG, RED_TAU = 1.5;

export const PH2O = 47 * MMHG;
export const RQ = 0.8;
export const VA0 = 4.3; // L/min
export const K_CO2 = 40 * VA0; // mmHg·L/min
export const VENT_CO2 = 0.45, VENT_CO2_LOW = 0.15; // per mmHg above / below 40 mmHg
export const VENT_DRIVE_MIN = 0.3;
/** Cerebral (and retinal) blood flow chemistry: per mmHg of PaCO₂ above / below 40, limits; hypoxic dilation. */
export const CBF_CO2_UP = 0.03, CBF_CO2_DOWN = 0.02, CBF_CO2_MIN = 0.6, CBF_CO2_MAX = 2;
export const CBF_HYP_P0 = 50, CBF_HYP_SPAN = 25, CBF_HYP_GAIN = 1;
export const VA_MAX0 = 60;
export const VA_MIN_FRAC = 0.02;
export const G_RESP = 16;
export const PACO2_TAU = 90, PACO2_TAU_FALL = 30;
/** Lung O₂ washout: functional residual capacity, L (τ = FRC / V̇_A). */
export const V_FRC = 2.4;
export const CIRC_TAU = 5;
export const NARC_LOC = 100 * MMHG, NARC_WAKE = 90 * MMHG, NARC_IMPAIR = 70 * MMHG;

/** Strain doses: [G_ref (g), T_ref (s), onset (g)] for +Gx, −Gx, ±Gy, −Gz. */
export const STRAIN: readonly (readonly [number, number, number])[] = [
  [6, 600, 3],
  [5, 300, 2.5],
  [3, 300, 1.5],
  [3, 30, 1.5],
];
export const STRAIN_TAU = 300;
export const X_ANOX = 0.08, T_ANOX = 240, ANOX_TAU = 3600;

/** Sub-step while in a transient under warp, s, and the most sub-steps one call takes. */
export const H_SUB = 0.25;
export const NSUB_MAX = 128;

/** Severinghaus (1979) oxygen dissociation; P in mmHg. No transcendental. */
export const sevSat = (p: number): number => (p > 0 ? 1 / (23400 / (p * p * p + 150 * p) + 1) : 0);

// ------------------------------------------------------------------------------------------------ layout

/** State (saved). */
export const GT_PB = 0; // baroreflex pressure, Pa
export const GT_XB = 1; // brain oxygen reservoir
export const GT_XR = 2; // retina
export const GT_PAO2 = 3; // arterial PO₂ delivered to the head, Pa
export const GT_PACO2 = 4; // arterial PCO₂, Pa
export const GT_RED = 5; // red-out 0..1
export const GT_LOC = 6; // 1 unconscious (physiological)
export const GT_TREP = 7; // s of reperfusion while unconscious
export const GT_TREL = 8; // s of relative incapacitation left
export const GT_D0 = 9; // + 0..3 strain doses (+Gx, −Gx, ±Gy, −Gz)
export const GT_ANOX = 13; // brain anoxia dose
export const GT_SETTLED = 14; // 1 when the continuous states sit at the fixed point of the inputs in GT_IN0..
export const GT_IN0 = 15; // last inputs (GI layout, 6)
export const GT_CAUSE = 21; // why unconscious (CAUSE_*)
export const GT_FAO2 = 22; // alveolar O₂ dry fraction (PAO₂ = F·(p − 47 mmHg): a pressure drop acts at once, Boyle)
export const GT_LEN = 23;

/** Inputs. */
export const GI_FX = 0, GI_FY = 1, GI_FZ = 2, GI_PPO2 = 3, GI_PPCO2 = 4, GI_P = 5;
export const GI_LEN = 6;

/** Outputs (after each step). */
export const GO_TUNNEL = 0; // 0 full field … 1 no field
export const GO_GREY = 1;
export const GO_BLACK = 2;
export const GO_RED = 3;
export const GO_CONSCIOUS = 4; // 1/0
export const GO_CONTROL = 5; // hands' control 0..1
export const GO_GZ = 6; // f_y / g
export const GO_GX = 7; // −f_z / g (+ = eyeballs in)
export const GO_PAO2 = 8; // Pa (delivered)
export const GO_SAO2 = 9;
export const GO_PACO2 = 10; // Pa
export const GO_VENT = 11; // alveolar ventilation, L/min
export const GO_QB = 12; // brain flow fraction
export const GO_CAUSE = 13;
export const GO_LEN = 14;

export const CAUSE_NONE = 0, CAUSE_GLOC = 1, CAUSE_HYPOXIA = 2, CAUSE_NARCOSIS = 3;

export const createGIn = (): Float64Array => {
  const g = new Float64Array(GI_LEN);
  g[GI_FY] = G0; g[GI_PPO2] = 21227; g[GI_P] = 101325;
  return g;
};
export const createGOut = (): Float64Array => new Float64Array(GO_LEN);

// ------------------------------------------------------------------------------------------------ module scratch

const SC = new Float64Array(16);
const SC_QB = 0, SC_QR = 1, SC_A = 2, SC_PBT = 3, SC_REDT = 4, SC_CO2T = 5, SC_O2T = 6, SC_VA = 7, SC_GX = 8, SC_FAT = 9;
// cached constant-τ coefficients for the last h
const EC = new Float64Array(8);
let ecH = -1;
const EC_PB = 0, EC_RED = 1, EC_CO2 = 2, EC_CIRC = 3, EC_STRAIN = 4, EC_ANOX = 5, EC_CO2F = 6;
function coeffs(h: number): void {
  if (h === ecH) return;
  ecH = h;
  EC[EC_PB] = mexp(-h / BARO_TAU);
  EC[EC_RED] = mexp(-h / RED_TAU);
  EC[EC_CO2] = mexp(-h / PACO2_TAU);
  EC[EC_CO2F] = mexp(-h / PACO2_TAU_FALL);
  EC[EC_CIRC] = mexp(-h / CIRC_TAU);
  EC[EC_STRAIN] = mexp(-h / STRAIN_TAU);
  EC[EC_ANOX] = mexp(-h / ANOX_TAU);
}

/** Alveolar PO₂ the gas equation gives for the inspired gas and the arterial PCO₂, Pa (≥ 0). */
function alveolarO2(ppO2: number, ppCO2: number, p: number, paCO2: number): number {
  if (!(p > PH2O)) return 0;
  const fi = ppO2 / p, dry = p - PH2O, piO2 = fi * dry, piCO2 = (ppCO2 / p) * dry;
  let pa = piO2 - (paCO2 - piCO2) * (fi + (1 - fi) / RQ);
  const cap = dry - paCO2;
  if (pa > cap) pa = cap;
  return pa > 0 ? pa : 0;
}
/** Alveolar–arterial difference under load (V/Q mismatch), Pa. */
const aaGradient = (gTot: number): number => (5 + 3 * (gTot > 1 ? gTot - 1 : 0)) * MMHG;
// the a = 1 point: sea-level air, 1 g, PaCO₂ 40 mmHg
export const FAO2_REF = alveolarO2(21227, 0, 101325, 40 * MMHG) / (101325 - PH2O);
export const PAO2_REF = alveolarO2(21227, 0, 101325, 40 * MMHG) - aaGradient(1);
export const SAO2_REF = sevSat(PAO2_REF / MMHG);

// ------------------------------------------------------------------------------------------------ state

export function createPhysiology(): Float64Array {
  const s = new Float64Array(GT_LEN);
  s[GT_PB] = 0;
  s[GT_XB] = 1 - C_BRAIN;
  s[GT_XR] = 1 - C_RETINA;
  s[GT_PAO2] = PAO2_REF;
  s[GT_PACO2] = 40 * MMHG;
  s[GT_FAO2] = FAO2_REF;
  s[GT_IN0 + GI_FY] = G0; s[GT_IN0 + GI_PPO2] = 21227; s[GT_IN0 + GI_P] = 101325;
  return s;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Targets and flows for the current inputs and state (module scratch SC). Everything algebraic of the state.
 */
function evalTargets(s: Float64Array, inp: Float64Array): void {
  const fx = inp[GI_FX], fy = inp[GI_FY], fz = inp[GI_FZ];
  const gTot = Math.sqrt(fx * fx + fy * fy + fz * fz) / G0;
  const hEye = RHO_BLOOD * (fy * EYE_DY + fz * EYE_DZ);
  const hBrain = RHO_BLOOD * (fy * BRAIN_DY + fz * BRAIN_DZ);
  // baroreflex target from the raw (uncompensated) eye pressure
  let pbt = BARO_K * (P_EYE_1G - (P_HEART - hEye));
  if (pbt > BARO_MAX) pbt = BARO_MAX; else if (pbt < BARO_MIN) pbt = BARO_MIN;
  SC[SC_PBT] = pbt;
  // red-out (venous engorgement at the eye)
  SC[SC_REDT] = clamp01((P_V0 - hEye - RED_0) / RED_SPAN);
  // chemistry
  const paCO2 = s[GT_PACO2], paO2 = s[GT_PAO2];
  const pco2m = paCO2 / MMHG, po2m = paO2 / MMHG;
  let chem = pco2m > 40 ? 1 + CBF_CO2_UP * (pco2m - 40) : 1 - CBF_CO2_DOWN * (40 - pco2m);
  if (chem < CBF_CO2_MIN) chem = CBF_CO2_MIN; else if (chem > CBF_CO2_MAX) chem = CBF_CO2_MAX;
  let hyp = (CBF_HYP_P0 - po2m) / CBF_HYP_SPAN;
  hyp = hyp < 0 ? 0 : hyp > 1 ? 1 : hyp;
  chem *= 1 + CBF_HYP_GAIN * hyp;
  // perfusion
  const pEye = P_HEART + s[GT_PB] - hEye, pBrain = P_HEART + s[GT_PB] - hBrain;
  let qr = (pEye - IOP) / AR_RETINA;
  qr = (qr < 0 ? 0 : qr > 1 ? 1 : qr) * chem;
  let qb = pBrain / AR_BRAIN;
  qb = (qb < 0 ? 0 : qb > 1 ? 1 : qb) * chem;
  SC[SC_QR] = qr > Q_MAX ? Q_MAX : qr;
  SC[SC_QB] = qb > Q_MAX ? Q_MAX : qb;
  // arterial driver
  const sat = sevSat(po2m);
  let pr = paO2 / PAO2_REF;
  if (pr > 1.2) pr = 1.2;
  SC[SC_A] = 0.5 * (sat / SAO2_REF) + 0.5 * pr;
  // breathing
  const gx = (fz < 0 ? -fz : fz) / G0;
  SC[SC_GX] = gx;
  let drive = pco2m > 40 ? 1 + VENT_CO2 * (pco2m - 40) : 1 - VENT_CO2_LOW * (40 - pco2m);
  let hd = (60 - po2m) / 30;
  hd = hd < 0 ? 0 : hd > 1.5 ? 1.5 : hd;
  drive += hd;
  if (drive < VENT_DRIVE_MIN) drive = VENT_DRIVE_MIN;
  let vmax = 1 - (gx / G_RESP) * (gx / G_RESP);
  if (vmax < VA_MIN_FRAC) vmax = VA_MIN_FRAC;
  vmax *= VA_MAX0;
  let va = VA0 * drive;
  if (va > vmax) va = vmax;
  SC[SC_VA] = va;
  const p = inp[GI_P];
  const dry = p > PH2O ? p - PH2O : 0;
  const piCO2 = p > 0 ? (inp[GI_PPCO2] / p) * dry : 0;
  let co2t = piCO2 + (K_CO2 / va) * MMHG;
  if (co2t > dry) co2t = dry;
  SC[SC_CO2T] = co2t;
  SC[SC_FAT] = dry > 0 ? alveolarO2(inp[GI_PPO2], inp[GI_PPCO2], p, paCO2) / dry : 0;
  const pA = s[GT_FAO2] * dry - aaGradient(gTot);
  SC[SC_O2T] = pA > 0 ? pA : 0;
}

/** One reservoir update, exact for frozen q and a; clamped to [0, 1]. */
function reservoir(x: number, q: number, a: number, c: number, T: number, h: number): number {
  let y: number;
  if (q > 1e-9) {
    const xs = a - c / q;
    y = xs + (x - xs) * mexp((-q * h) / T);
  } else {
    y = x - (c * h) / T;
  }
  return y < 0 ? 0 : y > 1 ? 1 : y;
}

/** Strain rate for an axis load g (g units): (g/G_ref)^3.5 / T_ref above the onset. */
function strainRate(k: number, g: number): number {
  const d = STRAIN[k];
  if (!(g > d[2])) return 0;
  const r = g / d[0];
  return (r * r * r * Math.sqrt(r)) / d[1];
}

function sameInputs(s: Float64Array, inp: Float64Array): boolean {
  for (let i = 0; i < GI_LEN; i++) if (s[GT_IN0 + i] !== inp[i]) return false;
  return true;
}

/** One continuous sub-step of length h (constant-τ coefficients EC must be for this h). */
function subStep(s: Float64Array, inp: Float64Array, h: number): void {
  evalTargets(s, inp);
  const xb0 = s[GT_XB];
  s[GT_XB] = reservoir(xb0, SC[SC_QB], SC[SC_A], C_BRAIN, T_BRAIN, h);
  s[GT_XR] = reservoir(s[GT_XR], SC[SC_QR], SC[SC_A], C_RETINA, T_RETINA, h);
  s[GT_PB] = SC[SC_PBT] + (s[GT_PB] - SC[SC_PBT]) * EC[EC_PB];
  s[GT_RED] = SC[SC_REDT] + (s[GT_RED] - SC[SC_REDT]) * EC[EC_RED];
  const co2t = SC[SC_CO2T];
  s[GT_PACO2] = co2t + (s[GT_PACO2] - co2t) * (co2t < s[GT_PACO2] ? EC[EC_CO2F] : EC[EC_CO2]);
  s[GT_PAO2] = SC[SC_O2T] + (s[GT_PAO2] - SC[SC_O2T]) * EC[EC_CIRC];
  const fat = SC[SC_FAT];
  s[GT_FAO2] = fat + (s[GT_FAO2] - fat) * mexp((-h * SC[SC_VA]) / (60 * V_FRC));
  // brain anoxia dose (trapezoid of the deficit over the step), decaying slowly
  const xm = 0.5 * (xb0 + s[GT_XB]);
  const rate = xm < X_ANOX ? (X_ANOX - xm) / X_ANOX / T_ANOX : 0;
  s[GT_ANOX] = s[GT_ANOX] * EC[EC_ANOX] + rate * h;
  // consciousness state machine
  consciousness(s, h);
}

function consciousness(s: Float64Array, h: number): void {
  const xb = s[GT_XB], co2 = s[GT_PACO2];
  if (s[GT_LOC] === 0) {
    if (xb < X_LOC || co2 > NARC_LOC) {
      s[GT_LOC] = 1; s[GT_TREP] = 0; s[GT_TREL] = 0;
      s[GT_CAUSE] = co2 > NARC_LOC ? CAUSE_NARCOSIS : SC[SC_QB] >= 0.75 ? CAUSE_HYPOXIA : CAUSE_GLOC;
    } else if (s[GT_TREL] > 0) {
      s[GT_TREL] = s[GT_TREL] > h ? s[GT_TREL] - h : 0;
    }
  } else if (xb >= X_WAKE && co2 < NARC_WAKE) {
    s[GT_TREP] += h;
    if (s[GT_TREP] >= T_ABS) {
      const over = s[GT_TREP] - T_ABS;
      s[GT_LOC] = 0; s[GT_TREP] = 0; s[GT_CAUSE] = CAUSE_NONE;
      s[GT_TREL] = T_REL > over ? T_REL - over : 0;
    }
  } else {
    s[GT_TREP] = 0;
  }
}

/** Is every continuous state at the fixed point of the current targets (within a tolerance far below perception)? */
function atFixedPoint(s: Float64Array, inp: Float64Array): boolean {
  evalTargets(s, inp);
  const qb = SC[SC_QB], qr = SC[SC_QR], a = SC[SC_A];
  const xbs = qb > 1e-9 ? a - C_BRAIN / qb : 0, xrs = qr > 1e-9 ? a - C_RETINA / qr : 0;
  const xbT = xbs < 0 ? 0 : xbs > 1 ? 1 : xbs, xrT = xrs < 0 ? 0 : xrs > 1 ? 1 : xrs;
  return Math.abs(s[GT_XB] - xbT) < 1e-7 && Math.abs(s[GT_XR] - xrT) < 1e-7 &&
    Math.abs(s[GT_PB] - SC[SC_PBT]) < 1e-3 && Math.abs(s[GT_RED] - SC[SC_REDT]) < 1e-7 &&
    Math.abs(s[GT_PACO2] - SC[SC_CO2T]) < 1e-3 && Math.abs(s[GT_PAO2] - SC[SC_O2T]) < 1e-3 &&
    Math.abs(s[GT_FAO2] - SC[SC_FAT]) < 1e-9;
}

/**
 * Advance the physiology by h (s) under the inputs (GI layout), writing the outputs (GO layout).
 * h = Q at 1×; any h under warp (sub-stepped while in a transient, one exact step once settled).
 */
export function stepPhysiology(s: Float64Array, inp: Float64Array, h: number, out: Float64Array): void {
  if (h > 0) {
    // strain doses: exact for constant G over the whole h
    const fx = inp[GI_FX], fy = inp[GI_FY], fz = inp[GI_FZ];
    const gx = -fz / G0, gy = (fx < 0 ? -fx : fx) / G0, gz = fy / G0;
    const settled = s[GT_SETTLED] === 1 && sameInputs(s, inp);
    let n = 1, hs = h;
    if (!settled && h > H_SUB) {
      n = Math.ceil(h / H_SUB);
      if (n > NSUB_MAX) n = NSUB_MAX;
      hs = h / n;
    }
    coeffs(hs);
    for (let i = 0; i < n; i++) subStep(s, inp, hs);
    coeffs(h);
    const e = EC[EC_STRAIN];
    for (let k = 0; k < 4; k++) {
      const g = k === 0 ? gx : k === 1 ? -gx : k === 2 ? gy : -gz;
      const rt = strainRate(k, g) * STRAIN_TAU;
      s[GT_D0 + k] = rt + (s[GT_D0 + k] - rt) * e;
    }
    for (let i = 0; i < GI_LEN; i++) s[GT_IN0 + i] = inp[i];
    s[GT_SETTLED] = atFixedPoint(s, inp) ? 1 : 0;
  }
  physiologyOut(s, inp, out);
}

/** Outputs for the current state (no stepping). */
export function physiologyOut(s: Float64Array, inp: Float64Array, out: Float64Array): void {
  evalTargets(s, inp);
  const xr = s[GT_XR], xb = s[GT_XB];
  const loc = s[GT_LOC] === 1;
  out[GO_TUNNEL] = clamp01((X_PLL - xr) / (X_PLL - X_CLL));
  out[GO_GREY] = clamp01((X_GREY - xr) / (X_GREY - X_CLL));
  out[GO_BLACK] = loc ? 1 : clamp01((X_BLACK - xr) / (X_BLACK - X_CLL));
  out[GO_RED] = s[GT_RED];
  out[GO_CONSCIOUS] = loc ? 0 : 1;
  let ctl = 0;
  if (!loc) {
    ctl = 1;
    if (s[GT_TREL] > 0) ctl = 1 - s[GT_TREL] / T_REL;
    const ci = clamp01((xb - X_LOC) / (X_IMPAIR - X_LOC));
    if (ci < ctl) ctl = ci;
    const cn = clamp01((NARC_LOC - s[GT_PACO2]) / (NARC_LOC - NARC_IMPAIR));
    if (cn < ctl) ctl = cn;
  }
  out[GO_CONTROL] = ctl;
  out[GO_GZ] = inp[GI_FY] / G0;
  out[GO_GX] = -inp[GI_FZ] / G0;
  out[GO_PAO2] = s[GT_PAO2];
  out[GO_SAO2] = sevSat(s[GT_PAO2] / MMHG);
  out[GO_PACO2] = s[GT_PACO2];
  out[GO_VENT] = SC[SC_VA];
  out[GO_QB] = SC[SC_QB];
  out[GO_CAUSE] = s[GT_CAUSE];
}

/** Largest step the physiology wants now: H_SUB·NSUB_MAX in a transient, +∞ once settled (limitedBy 'crew'). */
export const physioMaxStep = (s: Float64Array): number => (s[GT_SETTLED] === 1 ? Infinity : H_SUB * NSUB_MAX);

// ------------------------------------------------------------------------------------------------ helpers

/**
 * Felt specific force in a seat's body axes: the seat is reclined by `recline` (rad, back toward +z) about the body
 * x axis, from upright in the craft (body = craft axes when upright). out = R_x(−recline)·f.
 */
export function seatBodyForce(f: { x: number; y: number; z: number }, cosR: number, sinR: number, out: Float64Array, o: number): void {
  // body y (spine) = craft (0, cos, sin); body z (back) = craft (0, −sin, cos)
  out[o] = f.x;
  out[o + 1] = f.y * cosR + f.z * sinR;
  out[o + 2] = -f.y * sinR + f.z * cosR;
}

// ------------------------------------------------------------------------------------------------ save / load

export const savePhysiology = (s: Float64Array): number[] => Array.from(s);

export function loadPhysiology(raw: unknown): Float64Array {
  const s = createPhysiology();
  if (Array.isArray(raw) && raw.length === GT_LEN) {
    for (let i = 0; i < GT_LEN; i++) {
      const v = raw[i];
      if (typeof v === 'number' && Number.isFinite(v)) s[i] = v;
    }
  }
  return s;
}
