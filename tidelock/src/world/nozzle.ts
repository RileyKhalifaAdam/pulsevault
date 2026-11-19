// Ambient-pressure thrust (SIMULATION.md W2-B item 6; owner decision D1: physics on — a Wick landing is one-way).
//
//   F = ṁ·vₑ + (p_e − p_a)·A_eff
//
// * Wall nozzles (the hydrazine RCS jets): isentropic nozzle of area ratio ε and γ; the flow separates where the wall
//   pressure would fall below 0.35·p_a (Summerfield criterion), and A_eff shrinks to the separation station:
//     attached:   C_F = C_F,mom(p_e/p_c) + (p_e − p_a)/p_c·ε
//     separated:  C_F = C_F,mom(p_s/p_c) + (p_s − p_a)/p_c·ε_s,  p_s = 0.35·p_a,  ε_s = ε(M(p_s/p_c))  (≥ 1)
//   (downstream of separation the wall sees ≈ p_a on both sides and adds nothing). The thrust factor
//   k(p_a/p_c) = C_F/C_F,vac is tabulated at load (257 entries, linear lookup); ṁ is set by the chamber and does not
//   change. p_c follows the blowdown: p_c = P_C0·inp[IN_P] (jets.ts F = F₀·p/p₀ is chamber-pressure-proportional).
// * The Wren's magnetic nozzle has no wall, so there is no recovery: F = max(0, F_s − p_a·A_e), A_e = π·1.15² per pod.
//   At Wick's sea level (94 kPa) that is 781 kN lost of the 800 kN: the ship cannot lift off again.
//
// WIRING (wave 2; nothing here is called yet):
//   * setup.ts (load, derived): c.rcsNozzle = buildNozzleTable(RCS_EPS, RCS_GAMMA) (shared by every hydrazine pack).
//   * dynamics.ts integrateCraft, per step in air (p_a > 0, from atmoProfile.ts io[AT_P] at the craft):
//       after jetsStep(...) and BEFORE applyEngines: nz[NZ_PA] = p_a; nz[NZ_PC] = RCS_PC0·inp[IN_P]; nozzleK(tab, nz)
//       k = nz[NZ_K]; o.fx *= k; ... ; o.t* = (o.t* − o.d*)·k + o.d*   (the jet-damping part o.d* is a mass-flow
//       effect and is not scaled); ṁ unchanged. The controllers' authorities (torqueAuthority / forceAuthority) are
//       multiplied by the same k.
//     after applyEngines, per engine i: F_i ← magneticThrust(F_i, p_a, ENGINE_EXIT_AREA) — in practice applyEngines
//       gains the term; ṁ unchanged (propellant is still spent: that is the cost of a sea-level burn).
//   * Pressure is at the craft centre (the pods are within 15 m: a 0.2% pressure difference at sea level).
//   Contract fields: reads engineThrust (wave 1), writes nothing new; the applied force goes through the ledger.

export const NZ_PA = 0, NZ_PC = 1, NZ_K = 2, NZ_LEN = 3;

/** Hydrazine RCS jet nozzle: area ratio, γ of the decomposition products, chamber pressure at a full tank (Pa). */
export const RCS_EPS = 40;
export const RCS_GAMMA = 1.27;
export const RCS_PC0 = 2.0e6;
/** Summerfield separation criterion: the flow leaves the wall where p_wall < 0.35·p_a. */
export const SEPARATION = 0.35;
/** The Wren's magnetic nozzle exit area per pod, m² (π·1.15²). */
export const ENGINE_EXIT_AREA = Math.PI * 1.15 * 1.15;
/** Table range of p_a/p_c. Above it the jet produces nothing (k = 0). */
export const NZ_XMAX = 1;
const NT = 257;

export interface NozzleTable {
  eps: number;
  gamma: number;
  /** p_e/p_c at the design area ratio, and the vacuum thrust coefficient. */
  pe: number;
  cfVac: number;
  /** k(x) at x = i·NZ_XMAX/(NT−1). */
  k: Float64Array;
}

/** Static/chamber pressure ratio at Mach M. */
export const pRatioOfMach = (M: number, g: number): number => Math.pow(1 + 0.5 * (g - 1) * M * M, -g / (g - 1));
/** A/A* at Mach M. */
export const areaRatioOfMach = (M: number, g: number): number =>
  Math.pow((2 / (g + 1)) * (1 + 0.5 * (g - 1) * M * M), (g + 1) / (2 * (g - 1))) / M;
/** Supersonic Mach of a pressure ratio p/p_c (1 at and above the throat ratio). */
export function machOfPRatio(pr: number, g: number): number {
  const m2 = (2 / (g - 1)) * (Math.pow(1 / pr, (g - 1) / g) - 1);
  return m2 > 1 ? Math.sqrt(m2) : 1;
}
/** Momentum thrust coefficient of a full expansion to p/p_c. */
export function cfMomentum(pr: number, g: number): number {
  const a = ((2 * g * g) / (g - 1)) * Math.pow(2 / (g + 1), (g + 1) / (g - 1));
  const b = 1 - Math.pow(pr, (g - 1) / g);
  return Math.sqrt(a * (b > 0 ? b : 0));
}

/** C_F at ambient/chamber ratio x for a nozzle of area ratio eps (with Summerfield separation). */
export function thrustCoefficient(x: number, eps: number, g: number, pe: number): number {
  const ps = SEPARATION * x;
  let cf: number;
  if (ps <= pe) {
    cf = cfMomentum(pe, g) + (pe - x) * eps;
  } else {
    const ms = machOfPRatio(ps, g);
    const es = ms > 1 ? areaRatioOfMach(ms, g) : 1;
    const pss = ms > 1 ? ps : pRatioOfMach(1, g);
    cf = cfMomentum(pss, g) + (pss - x) * es;
  }
  return cf > 0 ? cf : 0;
}

/** Build the thrust-factor table of a wall nozzle (load time; allocates). */
export function buildNozzleTable(eps = RCS_EPS, gamma = RCS_GAMMA): NozzleTable {
  // exit Mach: bisection on the supersonic branch of A/A*(M) = eps
  let lo = 1, hi = 60;
  for (let i = 0; i < 200; i++) { const m = 0.5 * (lo + hi); if (areaRatioOfMach(m, gamma) < eps) lo = m; else hi = m; }
  const pe = pRatioOfMach(0.5 * (lo + hi), gamma);
  const cfVac = cfMomentum(pe, gamma) + pe * eps;
  const k = new Float64Array(NT);
  for (let i = 0; i < NT; i++) k[i] = thrustCoefficient((i * NZ_XMAX) / (NT - 1), eps, gamma, pe) / cfVac;
  return { eps, gamma, pe, cfVac, k };
}

/** nz[NZ_K] = F(p_a)/F_vac at nz[NZ_PA], nz[NZ_PC] (1 in vacuum, 0 when p_a ≥ p_c·NZ_XMAX). */
export function nozzleK(T: NozzleTable, nz: Float64Array): void {
  const pa = nz[NZ_PA], pc = nz[NZ_PC];
  if (!(pa > 0)) { nz[NZ_K] = 1; return; }
  if (!(pc > 0)) { nz[NZ_K] = 0; return; }
  const f = ((pa / pc) * (NT - 1)) / NZ_XMAX;
  if (f >= NT - 1) { nz[NZ_K] = 0; return; }
  const i = Math.floor(f), w = f - i;
  nz[NZ_K] = T.k[i] * (1 - w) + T.k[i + 1] * w;
}

/** Throat and exit area of a jet of vacuum thrust F at chamber pressure pc, m² (display, audio). */
export function jetAreas(T: NozzleTable, F: number, pc = RCS_PC0): { throat: number; exit: number } {
  const at = F / (T.cfVac * pc);
  return { throat: at, exit: at * T.eps };
}

/** A wall-less (magnetic) nozzle: the thrust left after the ambient pressure on the exit area, N (≥ 0). */
export const magneticThrust = (F: number, pa: number, Ae = ENGINE_EXIT_AREA): number => {
  const f = F - (pa > 0 ? pa : 0) * Ae;
  return F > 0 && f > 0 ? f : 0;
};
