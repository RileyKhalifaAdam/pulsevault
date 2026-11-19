// W3-D item 3 "Injury" (docs/SIMULATION.md §2 W3-D, `body-impact-injury`, `crew-injury-physiology`): impacts and
// sustained loads hurt the pilot; injuries heal over sim time; some are fatal. Replaces the binary "wreck = death"
// (15 g hull load / 5 m/s touchdown) for the crew: the pilot dies of injuries, not of a flag. Pure TypeScript,
// deterministic, allocation-free per call (Float64Array state and module scratch), SI units, plain-JSON save.
//
// Model.
// - Severity per body region on a continuous AIS-like scale 0 … 6 (1 minor, 2 moderate, 3 serious, 4 severe,
//   5 critical, 6 unsurvivable): HEAD (impact), TORSO (impact and sustained ±Gx/±Gy strain), SPINE (seated pulses),
//   BRAIN (anoxia; −Gz strain goes to HEAD). Two injuries in one region combine as √(S₁² + S₂²) (repeat blows are
//   worse than either); dose-driven severities ratchet (S = max(S, map(dose))).
// - Head, sampled (seated / bunk: the harness head from body.ts at its 480 Hz sub-steps): a streaming HIC₁₅ over a
//   15 ms window on the resultant head acceleration, HIC = max [(1/(t₂−t₁))∫a dt]^2.5 (t₂ − t₁), a in g, trapezoid
//   increments in a 16-slot ring, evaluated only while a sample in the window exceeds 8 g (below that HIC < 3).
// - Head, impulsive (the contact solver resolves a head-sphere hit as an impulse, so its pulse shape is not in the
//   tick history): the pulse is the half-sine of the head–surface contact, duration T = π√(μ/k), μ the reduced mass
//   (the head 4.5 kg against a wall; a prop's μ = m_p m_h/(m_p + m_h)), k = the series stiffness of the skull and
//   scalp (5 MN/m, T ≈ 3 ms on a rigid wall) and the surface; Δv_head = μ(1 + e)v/m_h; peak A = πΔv/(2T). HIC of a
//   half-sine in closed form: A^2.5·T·f(w*), f(w) = w·[(2/(πw)) sin(πw/2)]^2.5, w* = min(0.6708, 15 ms / T)
//   (the optimum solves tan θ = 5θ/3, θ = πw/2). HIC → AIS: 250 → 1, 450 → 2, 700 → 3 (serious), 850 → 4,
//   1000 → 5 (critical), 2000 → 6 (plan: serious above ≈ 700, critical ≈ 1000).
// - Concussion: a head severity S ≥ 2 knocks the pilot out for 30 s·20^(S−2) (S 2: 30 s, 3: 10 min, 4: 3.3 h — the
//   AIS loss-of-consciousness bands), then confusion for 15 s + half of it (≤ 1 h): the hands' control ramps back.
// - Torso, impulsive: the plan's rigid-wall thresholds on the approach speed — 5 m/s bruising (AIS 1), 9 serious
//   (3), 15 fatal (6) — with a compliant surface entering through the series stiffness: v_eq = v·√(k_eff/k_torso)
//   (k_torso 100 kN/m), so padding is protective and a steel bulkhead is not.
// - Spine/whole body, sampled (seated): the Brinkley dynamic response model (NASA-STD-3001), one damped oscillator
//   per axis on the torso's specific force in body axes, DR = ω²δ/g: x (eyeballs in +) ω 62.8 rad/s ζ 0.2,
//   y ω 58.0 ζ 0.09, z (spine compression +) ω 52.9 ζ 0.224; exact discretisation per sample. β = √Σ(DR/DR_high)²
//   against the high-risk limits (x +46/−37, y ±22, z +18/−13.4); β → AIS: 0.76 → 1, 1 → 3, 1.6 → 5, 2.2 → 6.
// - Sustained strain (gTolerance.ts doses, D = 1 the Eiband voluntary limit): ±Gx/±Gy → TORSO, −Gz → HEAD:
//   D 1.5 → 1, 2.5 → 2, 4 → 3, 6 → 4, 9 → 5, 14 → 6.
// - Brain anoxia (gTolerance.ts dose A, 1 ≈ 4 min without flow): A 0.25 → 2, 0.5 → 4 (coma while ≥ 4), 1 → 6.
// - Healing, exact at any step (piecewise linear in time): the severity falls by one AIS step per 7 days below 1,
//   21 days in (1, 2], 45 days in (2, 3], 90 days in (3, 4], 180 days above 4. Nothing heals once dead.
// - Fatal (deterministic, the median, no dice): any region ≥ 6, or ISS ≥ 50 with the ISS regions head/neck =
//   max(HEAD, BRAIN), chest = TORSO, back/abdomen = SPINE (ISS = Σ S² of the three).
//
// WIRING (wave 3; nothing here is called yet):
// - crew.ts contact sub-step: when the head sphere hits a box or a prop hits the head,
//     headImpact(inj, vRelNormal, e, mOther (≥ 1e9 or ≤ 0 for the ship), kSurf(material))
//   when the torso/capsule hits a box: bodyImpact(inj, vn, kSurf) (vn = approach normal speed before the solve;
//   a prop hitting the torso: vn = J/((1 + e)·80 kg)). body.ts clampEyeOffset when it clamps with a closing speed:
//   headImpact with that speed. These replace no code; the hull's own wreck rule (contact.ts LAND_MAX_SPEED, the
//   overload 15 g; already replaced for the craft by damage.ts isDestroyed) stops killing the pilot: app.ts's wreck
//   path keys on isDead(inj) (and the craft-loss path on damage.ts isDestroyed: a pilot in a lost hull dies of the
//   vacuum through gTolerance.ts, honestly, a few minutes later — or W3-B's breach says when).
// - session.ts helm / bunk, inside the 4 harness sub-steps at 1× (h = HS = 1/480 s):
//     IS[IS_HX..HZ] = head specific force (felt at the seat + the torso and head accelerations of body.ts),
//     IS[IS_TX..TZ] = torso specific force in the seat's body axes; injurySample(inj, IS, HS)
//   Under warp (h > 0.02 s, the harness at its closed-form equilibrium) injurySample settles the oscillators to
//   their static deflection and clears the HIC ring: no pulse exists in a quasi-static step.
// - Once per tick (and once per quantum under warp), after gTolerance.ts stepPhysiology:
//     injuryPhysio(inj, gt, h); crewCondition(gout, inj, cc) → CrewView (conscious, control, the vision state for
//   W3-E's post hook: tunnel, grey, black, red). control → devices.ts: below 0.5 the hand lets go (the stick
//   springs back to centre, hands.ts release(grip)); 0 while unconscious. !conscious counts as eyes closed for
//   frame.eyesClosed (sleep warp may run through a knock-out).
// - §1.4: reads no contract field directly (accelerations from body.ts, doses from gt); writes none (owns crew.inj,
//   saved). extImpulse is bodyMomentum.ts.
// - Save: saveInjury / loadInjury (loader default: unhurt).

import { G0, oscTransition } from './body';
import { CAUSE_HYPOXIA, CAUSE_NARCOSIS, GO_BLACK, GO_CAUSE, GO_CONSCIOUS, GO_CONTROL, GO_GREY, GO_RED, GO_TUNNEL, GT_ANOX, GT_D0 } from './gTolerance';

const mexp = (x: number): number => Math.exp(x);
const msin = (x: number): number => Math.sin(x);

// ------------------------------------------------------------------------------------------------ constants

export const R_HEAD = 0, R_TORSO = 1, R_SPINE = 2, R_BRAIN = 3;
export const N_REGIONS = 4;
export const AIS_FATAL = 6;
export const ISS_FATAL = 50;

export const HEAD_MASS = 4.5;
export const K_HEAD = 5e6;
export const K_TORSO = 1e5;
/** Surface stiffness for a few cabin materials, N/m (∞-like for the structure). */
export const K_STRUCTURE = 1e9, K_PANEL = 2e6, K_GLASS = 5e7, K_PADDING = 2e4;

export const HIC_WINDOW = 0.015;
export const HIC_GATE_G = 8;
export const HIC_RING = 16;

/** Brinkley axes: ω (rad/s), ζ, high-risk limit for + and − DR. */
export const BRINKLEY: readonly (readonly [number, number, number, number])[] = [
  [62.8, 0.2, 46, 37],
  [58.0, 0.09, 22, 22],
  [52.9, 0.224, 18, 13.4],
];
export const BETA_EVENT = 0.6;

/** Piecewise-linear maps (x, AIS) pairs. */
export const MAP_HIC: readonly number[] = [0, 0, 150, 0, 250, 1, 450, 2, 700, 3, 850, 4, 1000, 5, 2000, 6];
export const MAP_TORSO_V: readonly number[] = [0, 0, 3, 0, 5, 1, 7, 2, 9, 3, 11, 4, 13, 5, 15, 6];
export const MAP_BETA: readonly number[] = [0, 0, 0.6, 0, 0.76, 1, 0.88, 2, 1, 3, 1.3, 4, 1.6, 5, 2.2, 6];
export const MAP_STRAIN: readonly number[] = [0, 0, 1, 0, 1.5, 1, 2.5, 2, 4, 3, 6, 4, 9, 5, 14, 6];
export const MAP_ANOX: readonly number[] = [0, 0, 0.1, 0, 0.25, 2, 0.5, 4, 0.75, 5, 1, 6];

export const KO_BASE = 30, KO_GROWTH = 20, KO_MIN_S = 2;
export const CONF_BASE = 15, CONF_MAX = 3600;
export const COMA_S = 4;
const DAY = 86400;
/** Healing: seconds per AIS step in band (b−1, b], b = 1 … 6. */
export const HEAL_STEP: readonly number[] = [7 * DAY, 21 * DAY, 45 * DAY, 90 * DAY, 180 * DAY, 180 * DAY];

// HIC optimum window fraction of a half-sine: tan θ = 5θ/3, w = 2θ/π (bisection at load)
export const W_OPT = (() => {
  let lo = 0.9, hi = 1.3;
  for (let i = 0; i < 80; i++) {
    const m = 0.5 * (lo + hi), g = 2.5 * m * Math.cos(m) - 1.5 * Math.sin(m);
    if (g > 0) lo = m; else hi = m;
  }
  return (lo + hi) / Math.PI;
})();

// ------------------------------------------------------------------------------------------------ layout

export const IJ_S0 = 0; // + region: severity
export const IJ_PRE0 = 4; // + region: severity before the open sampled event
export const IJ_KO = 8; // s unconscious left (concussion)
export const IJ_CONF = 9; // s confusion left
export const IJ_CONF0 = 10; // confusion length at its start
export const IJ_DEAD = 11; // 1 dead
export const IJ_DEATH = 12; // region + 1 that decided it (5 = ISS)
// streaming HIC
export const IJ_HH = 13; // sample step in use
export const IJ_HN = 14; // samples in the ring
export const IJ_HI = 15; // ring index of the newest sample
export const IJ_HA = 16; // last |a| (g)
export const IJ_HEV = 17; // 1 while a head event is open
export const IJ_HPK = 18; // peak HIC of the open event
export const IJ_HQ = 19; // quiet samples in a row
export const IJ_HINC = 20; // + HIC_RING: ∫a dt of each interval (g·s)
export const IJ_HGA = IJ_HINC + HIC_RING; // + HIC_RING: |a| of each sample (g)
// Brinkley
export const IJ_B0 = IJ_HGA + HIC_RING; // δx, vx, δy, vy, δz, vz
export const IJ_BH = IJ_B0 + 6; // sample step the oscillators last used
export const IJ_BEV = IJ_BH + 1;
export const IJ_BPK = IJ_BH + 2; // peak β of the open event
export const IJ_LAST_HIC = IJ_BH + 3; // largest HIC of the last head event (report)
export const IJ_LAST_BETA = IJ_BH + 4; // largest β of the last spine event (report)
export const IJ_LEN = IJ_BH + 5;

/** injurySample input layout. */
export const IS_HX = 0, IS_HY = 1, IS_HZ = 2, IS_TX = 3, IS_TY = 4, IS_TZ = 5;
export const IS_LEN = 6;

/** crewCondition output layout. */
export const CC_CONSCIOUS = 0, CC_CONTROL = 1, CC_TUNNEL = 2, CC_GREY = 3, CC_BLACK = 4, CC_RED = 5, CC_DEAD = 6, CC_CAUSE = 7;
export const CC_LEN = 8;
export const CC_NONE = 0, CC_GLOC = 1, CC_HYPOXIA = 2, CC_NARCOSIS = 3, CC_CONCUSSION = 4, CC_COMA = 5, CC_DEADC = 6;

export const createInjury = (): Float64Array => new Float64Array(IJ_LEN);
export const createInjurySample = (): Float64Array => new Float64Array(IS_LEN);
export const createCondition = (): Float64Array => new Float64Array(CC_LEN);

// ------------------------------------------------------------------------------------------------ maps

/** Piecewise-linear interpolation in a flat (x, y) table; clamps at both ends. */
export function pwl(tab: readonly number[], x: number): number {
  const n = tab.length;
  if (!(x > tab[0])) return tab[1];
  for (let i = 2; i < n; i += 2) {
    if (x <= tab[i]) {
      const x0 = tab[i - 2], y0 = tab[i - 1];
      return y0 + ((tab[i + 1] - y0) * (x - x0)) / (tab[i] - x0);
    }
  }
  return tab[n - 1];
}

const rss = (a: number, b: number): number => Math.sqrt(a * a + b * b);
const cap6 = (s: number): number => (s > AIS_FATAL ? AIS_FATAL : s);

/** HIC of a half-sine pulse of peak A (g) and duration T (s), with the 15 ms window. Closed form. */
export function hicHalfSine(A: number, T: number): number {
  if (!(A > 0) || !(T > 0)) return 0;
  let w = W_OPT;
  if (w * T > HIC_WINDOW) w = HIC_WINDOW / T;
  const m = (2 / (Math.PI * w)) * msin((Math.PI * w) / 2);
  const am = A * m;
  return am * am * Math.sqrt(am) * w * T;
}

/** Concussion consequences of a head severity S: knock-out and confusion timers. */
function concuss(inj: Float64Array, S: number): void {
  if (S >= KO_MIN_S) {
    const ko = KO_BASE * mexp(Math.log(KO_GROWTH) * (S - KO_MIN_S));
    if (ko > inj[IJ_KO]) inj[IJ_KO] = ko;
    let conf = CONF_BASE + 0.5 * ko;
    if (conf > CONF_MAX) conf = CONF_MAX;
    if (conf > inj[IJ_CONF]) { inj[IJ_CONF] = conf; inj[IJ_CONF0] = conf; }
  } else if (S >= 1.5) {
    const conf = CONF_BASE * (S - 1);
    if (conf > inj[IJ_CONF]) { inj[IJ_CONF] = conf; inj[IJ_CONF0] = conf; }
  }
}

/** Is the pilot dead by the region / ISS rule (sets IJ_DEAD and the cause once). */
function checkDeath(inj: Float64Array): void {
  if (inj[IJ_DEAD] === 1) return;
  for (let r = 0; r < N_REGIONS; r++) {
    if (inj[IJ_S0 + r] >= AIS_FATAL) { inj[IJ_DEAD] = 1; inj[IJ_DEATH] = r + 1; return; }
  }
  const hn = inj[IJ_S0 + R_HEAD] > inj[IJ_S0 + R_BRAIN] ? inj[IJ_S0 + R_HEAD] : inj[IJ_S0 + R_BRAIN];
  const ch = inj[IJ_S0 + R_TORSO], ab = inj[IJ_S0 + R_SPINE];
  if (hn * hn + ch * ch + ab * ab >= ISS_FATAL) { inj[IJ_DEAD] = 1; inj[IJ_DEATH] = 5; }
}

/** Add an impact injury of severity s to region r (committed at once). */
function addImpact(inj: Float64Array, r: number, s: number): void {
  if (!(s > 0)) return;
  const pre = inj[IJ_PRE0 + r], cur = inj[IJ_S0 + r];
  // an open sampled event holds pre + its own share; fold the new blow into both
  inj[IJ_PRE0 + r] = cap6(rss(pre, s));
  inj[IJ_S0 + r] = cap6(rss(cur, s));
  if (r === R_HEAD) concuss(inj, inj[IJ_S0 + r]);
  checkDeath(inj);
}

// ------------------------------------------------------------------------------------------------ impulsive impacts

/**
 * The head hits something: relative normal speed vRel (m/s, ≥ 0), restitution e, the other mass (kg; ≤ 0 or ≥ 1e9
 * for the ship), its surface stiffness (N/m). Returns the HIC; the injury is applied.
 */
export function headImpact(inj: Float64Array, vRel: number, e: number, mOther: number, kSurf: number): number {
  if (!(vRel > 0) || inj[IJ_DEAD] === 1) return 0;
  const mu = mOther > 0 && mOther < 1e9 ? (mOther * HEAD_MASS) / (mOther + HEAD_MASS) : HEAD_MASS;
  const k = kSurf > 0 ? (K_HEAD * kSurf) / (K_HEAD + kSurf) : K_HEAD;
  const T = Math.PI * Math.sqrt(mu / k);
  const dv = (mu * (1 + e) * vRel) / HEAD_MASS;
  const A = (Math.PI * dv) / (2 * T) / G0;
  const hic = hicHalfSine(A, T);
  addImpact(inj, R_HEAD, pwl(MAP_HIC, hic));
  if (hic > inj[IJ_LAST_HIC]) inj[IJ_LAST_HIC] = hic;
  return hic;
}

/** Rigid-wall-equivalent approach speed of a torso impact on a surface of stiffness kSurf. */
export const torsoEquivalentSpeed = (vn: number, kSurf: number): number =>
  kSurf > 0 ? vn * Math.sqrt(kSurf / (K_TORSO + kSurf)) : vn;

/** The torso / whole body hits a surface at approach speed vn (m/s). Returns the severity added. */
export function bodyImpact(inj: Float64Array, vn: number, kSurf: number): number {
  if (!(vn > 0) || inj[IJ_DEAD] === 1) return 0;
  const s = pwl(MAP_TORSO_V, torsoEquivalentSpeed(vn, kSurf));
  addImpact(inj, R_TORSO, s);
  return s;
}

// ------------------------------------------------------------------------------------------------ sampled path

const PHI = new Float64Array(12);
let phiH = -1;
function brinkleyCoeffs(h: number): void {
  if (h === phiH) return;
  phiH = h;
  for (let k = 0; k < 3; k++) oscTransition(PHI, 4 * k, BRINKLEY[k][0], BRINKLEY[k][1], h);
}

/** Brinkley β (against the high-risk limits) of the oscillator state. */
export function brinkleyBeta(inj: Float64Array): number {
  let b = 0;
  for (let k = 0; k < 3; k++) {
    const w = BRINKLEY[k][0], dr = (w * w * inj[IJ_B0 + 2 * k]) / G0;
    const r = dr / (dr >= 0 ? BRINKLEY[k][2] : BRINKLEY[k][3]);
    b += r * r;
  }
  return Math.sqrt(b);
}

/** Brinkley DR of axis k (0 x, 1 y, 2 z) of the current state. */
export const brinkleyDR = (inj: Float64Array, k: number): number => (BRINKLEY[k][0] * BRINKLEY[k][0] * inj[IJ_B0 + 2 * k]) / G0;

/**
 * One sample of the seated body's head and torso specific forces (IS layout; head any axes, torso BODY axes,
 * m/s²) over h. At 1× call it at the harness sub-steps (h = HS); a larger h (> 0.02 s, quasi-static) settles.
 */
export function injurySample(inj: Float64Array, a: Float64Array, h: number): void {
  if (!(h > 0) || inj[IJ_DEAD] === 1) return;
  // Brinkley inputs: x = eyeballs in (+ forward = −z), y = lateral, z = spinal compression (+y)
  const ix = -a[IS_TZ], iy = a[IS_TX], iz = a[IS_TY];
  if (h > 0.02) {
    // quasi-static: the static deflection, no pulse
    for (let k = 0; k < 3; k++) {
      const w = BRINKLEY[k][0], A = k === 0 ? ix : k === 1 ? iy : iz;
      inj[IJ_B0 + 2 * k] = A / (w * w);
      inj[IJ_B0 + 2 * k + 1] = 0;
    }
    inj[IJ_HN] = 0; inj[IJ_HEV] = 0; inj[IJ_HPK] = 0; inj[IJ_HQ] = 0;
    closeSpine(inj);
    for (let r = 0; r < N_REGIONS; r++) inj[IJ_PRE0 + r] = inj[IJ_S0 + r];
    return;
  }
  brinkleyCoeffs(h);
  for (let k = 0; k < 3; k++) {
    const w = BRINKLEY[k][0], A = k === 0 ? ix : k === 1 ? iy : iz, dp = A / (w * w);
    const o = IJ_B0 + 2 * k, d = inj[o] - dp, v = inj[o + 1], p = 4 * k;
    inj[o] = dp + PHI[p] * d + PHI[p + 1] * v;
    inj[o + 1] = PHI[p + 2] * d + PHI[p + 3] * v;
  }
  const beta = brinkleyBeta(inj);
  if (beta > BETA_EVENT) {
    if (inj[IJ_BEV] === 0) { inj[IJ_BEV] = 1; inj[IJ_BPK] = 0; inj[IJ_PRE0 + R_SPINE] = inj[IJ_S0 + R_SPINE]; }
    if (beta > inj[IJ_BPK]) {
      inj[IJ_BPK] = beta;
      inj[IJ_S0 + R_SPINE] = cap6(rss(inj[IJ_PRE0 + R_SPINE], pwl(MAP_BETA, beta)));
      if (beta > inj[IJ_LAST_BETA]) inj[IJ_LAST_BETA] = beta;
      checkDeath(inj);
    }
  } else closeSpine(inj);
  hicSample(inj, a, h);
}

function closeSpine(inj: Float64Array): void {
  if (inj[IJ_BEV] === 1) { inj[IJ_BEV] = 0; inj[IJ_PRE0 + R_SPINE] = inj[IJ_S0 + R_SPINE]; }
}

function hicSample(inj: Float64Array, a: Float64Array, h: number): void {
  const ag = Math.sqrt(a[IS_HX] * a[IS_HX] + a[IS_HY] * a[IS_HY] + a[IS_HZ] * a[IS_HZ]) / G0;
  if (inj[IJ_HH] !== h) { inj[IJ_HH] = h; inj[IJ_HN] = 0; inj[IJ_HEV] = 0; inj[IJ_HPK] = 0; inj[IJ_HQ] = 0; }
  let nWin = Math.floor(HIC_WINDOW / h + 1e-9);
  if (nWin > HIC_RING - 1) nWin = HIC_RING - 1;
  const i = (inj[IJ_HI] + 1) % HIC_RING;
  inj[IJ_HI] = i;
  inj[IJ_HINC + i] = inj[IJ_HN] > 0 ? 0.5 * (inj[IJ_HA] + ag) * h : 0;
  inj[IJ_HGA + i] = ag;
  inj[IJ_HA] = ag;
  if (inj[IJ_HN] < HIC_RING) inj[IJ_HN] += 1;
  const nHave = inj[IJ_HN] - 1 < nWin ? inj[IJ_HN] - 1 : nWin;
  // gate: any sample of the window above 8 g
  let hot = false;
  for (let j = 0; j <= nHave; j++) if (inj[IJ_HGA + ((i - j + HIC_RING) % HIC_RING)] >= HIC_GATE_G) { hot = true; break; }
  if (!hot) {
    if (inj[IJ_HEV] === 1) { inj[IJ_HEV] = 0; inj[IJ_PRE0 + R_HEAD] = inj[IJ_S0 + R_HEAD]; }
    return;
  }
  if (inj[IJ_HEV] === 0) { inj[IJ_HEV] = 1; inj[IJ_HPK] = 0; inj[IJ_PRE0 + R_HEAD] = inj[IJ_S0 + R_HEAD]; }
  // every window ending at the newest sample: dv accumulates backward
  let dv = 0, best = 0;
  for (let j = 1; j <= nHave; j++) {
    dv += inj[IJ_HINC + ((i - j + 1 + HIC_RING) % HIC_RING)];
    const T = j * h, m = dv / T, hic = m * m * Math.sqrt(m) * T;
    if (hic > best) best = hic;
  }
  if (best > inj[IJ_HPK]) {
    inj[IJ_HPK] = best;
    if (best > inj[IJ_LAST_HIC]) inj[IJ_LAST_HIC] = best;
    const s = pwl(MAP_HIC, best);
    if (s > 0) {
      const sNew = cap6(rss(inj[IJ_PRE0 + R_HEAD], s));
      if (sNew > inj[IJ_S0 + R_HEAD]) { inj[IJ_S0 + R_HEAD] = sNew; concuss(inj, sNew); checkDeath(inj); }
    }
  }
}

// ------------------------------------------------------------------------------------------------ physiology, timers, healing

/** Exact healing of one severity over t seconds (piecewise linear by band). */
export function heal(S: number, t: number): number {
  while (t > 0 && S > 0) {
    let b = Math.ceil(S);
    if (b < 1) b = 1;
    const floor = b - 1, step = HEAL_STEP[b - 1], need = (S - floor) * step;
    if (t >= need) { S = floor; t -= need; } else { S -= t / step; t = 0; }
  }
  return S > 0 ? S : 0;
}

/**
 * Once per tick / quantum (h, s): dose-driven injuries from gTolerance's state (strain → TORSO / HEAD, anoxia →
 * BRAIN), the knock-out and confusion timers, healing, death. Exact at any h.
 */
export function injuryPhysio(inj: Float64Array, gt: Float64Array, h: number): void {
  if (inj[IJ_DEAD] === 1 || !(h > 0)) return;
  // healing first (over the step), then the step-end doses ratchet
  for (let r = 0; r < N_REGIONS; r++) {
    const s = inj[IJ_S0 + r];
    if (s > 0) {
      const sh = heal(s, h);
      inj[IJ_S0 + r] = sh;
      // an open sampled event keeps its own share above pre
      const pre = inj[IJ_PRE0 + r];
      inj[IJ_PRE0 + r] = pre > sh ? sh : heal(pre, h);
    }
  }
  let dT = gt[GT_D0];
  for (let k = 1; k < 3; k++) if (gt[GT_D0 + k] > dT) dT = gt[GT_D0 + k];
  ratchet(inj, R_TORSO, pwl(MAP_STRAIN, dT));
  ratchet(inj, R_HEAD, pwl(MAP_STRAIN, gt[GT_D0 + 3]));
  ratchet(inj, R_BRAIN, pwl(MAP_ANOX, gt[GT_ANOX]));
  // timers
  if (inj[IJ_KO] > 0) inj[IJ_KO] = inj[IJ_KO] > h ? inj[IJ_KO] - h : 0;
  else if (inj[IJ_CONF] > 0) inj[IJ_CONF] = inj[IJ_CONF] > h ? inj[IJ_CONF] - h : 0;
  checkDeath(inj);
}

function ratchet(inj: Float64Array, r: number, s: number): void {
  if (s > inj[IJ_S0 + r]) {
    inj[IJ_S0 + r] = s;
    if (s > inj[IJ_PRE0 + r]) inj[IJ_PRE0 + r] = s;
  }
}

export const isDead = (inj: Float64Array): boolean => inj[IJ_DEAD] === 1;
export const injuryMax = (inj: Float64Array): number => {
  let m = 0;
  for (let r = 0; r < N_REGIONS; r++) if (inj[IJ_S0 + r] > m) m = inj[IJ_S0 + r];
  return m;
};

// ------------------------------------------------------------------------------------------------ the pilot's condition

/**
 * Combine gTolerance's outputs (GO layout) with the
 * injuries into the condition the session, the devices and W3-E's vision hook read (CC layout).
 */
export function crewCondition(gout: Float64Array, inj: Float64Array, out: Float64Array): void {
  const dead = inj[IJ_DEAD] === 1;
  const coma = inj[IJ_S0 + R_BRAIN] >= COMA_S;
  const ko = inj[IJ_KO] > 0;
  const physioUp = gout[GO_CONSCIOUS] === 1;
  const conscious = !dead && !coma && !ko && physioUp;
  out[CC_CONSCIOUS] = conscious ? 1 : 0;
  out[CC_DEAD] = dead ? 1 : 0;
  let cause = CC_NONE;
  if (dead) cause = CC_DEADC;
  else if (coma) cause = CC_COMA;
  else if (ko) cause = CC_CONCUSSION;
  else if (!physioUp) cause = gout[GO_CAUSE] === CAUSE_HYPOXIA ? CC_HYPOXIA : gout[GO_CAUSE] === CAUSE_NARCOSIS ? CC_NARCOSIS : CC_GLOC;
  out[CC_CAUSE] = cause;
  if (!conscious) {
    out[CC_CONTROL] = 0;
    out[CC_TUNNEL] = 1; out[CC_GREY] = 1; out[CC_BLACK] = 1;
    out[CC_RED] = dead ? 0 : gout[GO_RED];
    return;
  }
  let ctl = gout[GO_CONTROL];
  if (inj[IJ_CONF] > 0 && inj[IJ_CONF0] > 0) {
    const c = 1 - inj[IJ_CONF] / inj[IJ_CONF0];
    if (c < ctl) ctl = c;
  }
  const sm = injuryMax(inj);
  if (sm > 2) {
    let c = 1 - 0.2 * (sm - 2);
    if (c < 0) c = 0;
    if (c < ctl) ctl = c;
  }
  out[CC_CONTROL] = ctl;
  out[CC_TUNNEL] = gout[GO_TUNNEL]; out[CC_GREY] = gout[GO_GREY]; out[CC_BLACK] = gout[GO_BLACK]; out[CC_RED] = gout[GO_RED];
}

// ------------------------------------------------------------------------------------------------ save / load

export const saveInjury = (inj: Float64Array): number[] => Array.from(inj);

export function loadInjury(raw: unknown): Float64Array {
  const inj = createInjury();
  if (Array.isArray(raw) && raw.length === IJ_LEN) {
    for (let i = 0; i < IJ_LEN; i++) {
      const v = raw[i];
      if (typeof v === 'number' && Number.isFinite(v)) inj[i] = v;
    }
  }
  return inj;
}
