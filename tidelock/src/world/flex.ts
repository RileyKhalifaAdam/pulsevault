// Hull flex (SIMULATION.md W3-A item 4): the first two bending modes of the hull as a free-free beam along craft Z —
// mode 1 vertical bending (displacement along Y, 6 Hz est.), mode 2 lateral bending (along X, 14 Hz est.), ζ = 0.02 —
// each an exact damped oscillator  q̈ + 2ζω q̇ + ω² q = Q/M_n  driven by the generalised forces of the loads on the
// structure: point forces F at p give Q = F·ê φ(z) plus the bending moment of F about the neutral axis
// (Q₁ = F_y φ₁(z) − M_x φ₁'(z), Q₂ = F_x φ₂(z) + M_y φ₂'(z), M = (p − n(z)) × F), and impulses (latch, contact,
// undock spring, a slosh slam) the same with J. Thrust steps act through the engines' line offset from the neutral
// axis and the gimbal's side force; the spool's 0.8 s rise is slow against 6 Hz, so a normal light-up barely rings
// the hull, a hard latch or a contact does.
// Mode shapes: the uniform free-free beam, φ(ξ) = cosh βξ + cos βξ − σ(sinh βξ + sin βξ), β = 4.7300, σ = 0.98250,
// ξ = (z − z₀)/L over the hull's Z extent, normalised to ∫φ² dξ = 1, so the modal mass is the craft's mass M.
// flex[4] = [q₁, q̇₁, q₂, q̇₂] (m, m/s: the generalised coordinate; the deflection at z is q φ(z)).
// The structure's local acceleration at z is q̈₁φ₁(z)·ŷ + q̈₂φ₂(z)·x̂: the crew's seat feels −that on top of the
// rigid-body felt acceleration (flexAccelAt). Energy E = ½M Σ (q̇² + ω²q²) decays as e^(−2ζωt).
//
// WIRING (wave 3; nothing here is called yet):
//   * setup.ts / load: c.flexModel = buildFlexModel(c.mass.zSpan, c.mass.dryCom.y) (not saved); stations for the
//     fixed points: flexStation(model, z) at load for the helm seat, the bunk, the collar (cache them).
//     §1.4 `flex` = [0, 0, 0, 0] or loadFlexState(raw).
//   * dynamics.ts integrateCraft, per step: fi = c.flexIn; fi[FI_H] = dt; fi[FI_M] = c.mp[MP_M]; clear the loads
//     (flexClear); add every force of the step at its point: flexAddLoad(model, ld, fi, false) with ld = [p (craft,
//     ORIGIN-referenced, not about c), F] for each engine (pivot, −F̄·d), the RCS jets' net (optional: 34 kN at the
//     nose is the largest), and the aero resultant at its centre of pressure; then flexStep(c.flex, model, fi).
//     contact.ts / capture.ts / undock: every impulse J at point p: flexAddLoad(model, [p, J], fi, true) before the
//     step that follows (the impulse is applied at the start of that step).
//   * crew.ts feltAt / session.ts helm (body.ts harness): add flexAccelAt(c.flex, model, fi, st, out) (the seat's
//     station st), NEGATED, to the felt acceleration at the seat. render/camera: flexDispAt for the eye (≤ mm).
//   * Under warp the update is exact at any step; flexQuiet(c.flex) (energy < 1e-9 J) lets the caller skip it, so a
//     coasting ship costs nothing. No limitedBy.
//   * §1.4 fields read and written: flex.
// Rate: per craft step (≤ 120 Hz at 1×; 14 Hz is resolved at 8.6 samples per period and the update is exact).

const BETA = 4.730040745;
const SIGMA = 0.982502215;
export const FLEX_HZ = [6, 14];
export const FLEX_ZETA = 0.02;
/** Table resolution of φ, φ' over ξ ∈ [0, 1]. */
const NTAB = 256;

/** flexStep inputs: dt, modal mass, generalised forces Q₁, Q₂ (N, held over the step), impulses J₁, J₂ (N·s, at the start). */
export const FI_H = 0, FI_M = 1, FI_Q1 = 2, FI_Q2 = 3, FI_J1 = 4, FI_J2 = 5, FI_LEN = 6;
export const makeFlexIn = (): Float64Array => new Float64Array(FI_LEN);

export interface FlexModel {
  z0: number;
  L: number;
  /** Neutral-axis height (y) of the vertical bending, m. */
  yna: number;
  w: Float64Array;
  zeta: number;
  /** φ and dφ/dz tables (NTAB + 1 points), shared by both modes (same beam). */
  phi: Float64Array;
  dphi: Float64Array;
  /** Coefficient cache keyed on h: [h, A1, B1, C1, D1, A2, …, D2]. */
  cache: Float64Array;
}

function shape(x: number): number {
  return Math.cosh(BETA * x) + Math.cos(BETA * x) - SIGMA * (Math.sinh(BETA * x) + Math.sin(BETA * x));
}
function dshape(x: number): number {
  return BETA * (Math.sinh(BETA * x) - Math.sin(BETA * x) - SIGMA * (Math.cosh(BETA * x) + Math.cos(BETA * x)));
}

/** Build the modal model over the hull's Z extent [z0, z1] with the neutral axis at y = yna. Load time. */
export function buildFlexModel(zSpan: readonly [number, number], yna: number, hz: readonly number[] = FLEX_HZ, zeta = FLEX_ZETA): FlexModel {
  const z0 = zSpan[0], L = zSpan[1] - zSpan[0];
  // normalise ∫φ² dξ = 1 (Simpson on 2048 panels)
  let s = 0;
  const N = 2048;
  for (let i = 0; i <= N; i++) { const p = shape(i / N); s += (i === 0 || i === N ? 1 : i % 2 ? 4 : 2) * p * p; }
  const norm = 1 / Math.sqrt(s / (3 * N));
  const phi = new Float64Array(NTAB + 1), dphi = new Float64Array(NTAB + 1);
  for (let i = 0; i <= NTAB; i++) { phi[i] = norm * shape(i / NTAB); dphi[i] = (norm * dshape(i / NTAB)) / L; }
  return { z0, L, yna, w: new Float64Array(hz.map((f) => 2 * Math.PI * f)), zeta, phi, dphi, cache: new Float64Array(9).fill(NaN) };
}

/** [φ(z), φ'(z)] at craft z (clamped to the hull), into out[o], out[o + 1]. Load time / tests (a double argument). */
export function flexShape(m: FlexModel, z: number, out: Float64Array, o: number): void {
  ZS[0] = z;
  shapeAt(m, ZS, 0, out, o);
}
const ZS = new Float64Array(1);
/** The same with z = src[i] (no double argument: per-step path). */
function shapeAt(m: FlexModel, src: ArrayLike<number>, si: number, out: Float64Array, o: number): void {
  let x = ((src[si] - m.z0) / m.L) * NTAB;
  if (x < 0) x = 0; else if (x > NTAB) x = NTAB;
  let i = x | 0;
  if (i >= NTAB) i = NTAB - 1;
  const f = x - i;
  out[o] = m.phi[i] + f * (m.phi[i + 1] - m.phi[i]);
  out[o + 1] = m.dphi[i] + f * (m.dphi[i + 1] - m.dphi[i]);
}

/** A fixed station (load time): [z, φ(z), φ'(z)]. */
export function flexStation(m: FlexModel, z: number): Float64Array {
  const s = new Float64Array(3);
  s[0] = z;
  flexShape(m, z, s, 1);
  return s;
}

export function flexClear(fi: Float64Array): void {
  fi[FI_Q1] = fi[FI_Q2] = fi[FI_J1] = fi[FI_J2] = 0;
}

const SH = new Float64Array(2);
/**
 * Add a point load ld = [px, py, pz, Fx, Fy, Fz] (craft axes; a force in N or, with `impulse`, an impulse in N·s) to
 * the generalised forces (FI_Q*) or impulses (FI_J*).
 */
export function flexAddLoad(m: FlexModel, ld: ArrayLike<number>, fi: Float64Array, impulse: boolean): void {
  const px = ld[0], py = ld[1], fx = ld[3], fy = ld[4], fz = ld[5];
  shapeAt(m, ld, 2, SH, 0);
  // moment about the neutral axis point n(z) = (0, yna, z): M = (p − n) × F
  const ry = py - m.yna, rx = px;
  const Mx = ry * fz, My = -rx * fz; // (rx, ry, 0) × (fx, fy, fz): x = ry·fz, y = −rx·fz
  const q1 = fy * SH[0] - Mx * SH[1], q2 = fx * SH[0] + My * SH[1];
  if (impulse) { fi[FI_J1] += q1; fi[FI_J2] += q2; } else { fi[FI_Q1] += q1; fi[FI_Q2] += q2; }
}

function coeffs(m: FlexModel, fi: Float64Array): void {
  const h = fi[FI_H], c = m.cache;
  if (c[0] === h) return;
  c[0] = h;
  for (let n = 0; n < 2; n++) {
    const w = m.w[n], zw = m.zeta * w, wd = w * Math.sqrt(1 - m.zeta * m.zeta);
    const E = Math.exp(-zw * h), cs = Math.cos(wd * h), sn = Math.sin(wd * h);
    const o = 1 + 4 * n;
    c[o] = E * (cs + (zw / wd) * sn);
    c[o + 1] = (E * sn) / wd;
    c[o + 2] = (-E * w * w * sn) / wd;
    c[o + 3] = E * (cs - (zw / wd) * sn);
  }
}

/** Advance flex[4] over fi[FI_H] (exact for loads held over the step; impulses at its start). */
export function flexStep(F: number[], m: FlexModel, fi: Float64Array): void {
  const h = fi[FI_H], M = fi[FI_M];
  if (!(h > 0) || !(M > 0)) return;
  coeffs(m, fi);
  const c = m.cache;
  for (let n = 0; n < 2; n++) {
    const w = m.w[n], o = 1 + 4 * n;
    const eq = fi[FI_Q1 + n] / (M * w * w);
    const y = F[2 * n] - eq, v = F[2 * n + 1] + fi[FI_J1 + n] / M;
    F[2 * n] = eq + c[o] * y + c[o + 1] * v;
    F[2 * n + 1] = c[o + 2] * y + c[o + 3] * v;
  }
}

/**
 * The structure's flex acceleration (craft axes, m/s²) at a station st = [z, φ, φ'] at the end of the step, with the
 * step's loads in fi: out[0] = x, out[1] = y (z is 0: bending only). The felt acceleration there gains −out.
 */
export function flexAccelAt(F: ArrayLike<number>, m: FlexModel, fi: Float64Array, st: ArrayLike<number>, out: Float64Array): void {
  const M = fi[FI_M] > 0 ? fi[FI_M] : 1;
  const w1 = m.w[0], w2 = m.w[1], z = m.zeta;
  const a1 = fi[FI_Q1] / M - 2 * z * w1 * F[1] - w1 * w1 * F[0];
  const a2 = fi[FI_Q2] / M - 2 * z * w2 * F[3] - w2 * w2 * F[2];
  out[0] = a2 * st[1];
  out[1] = a1 * st[1];
}

/** Deflection of the structure at a station (m): out[0] = x, out[1] = y. */
export function flexDispAt(F: ArrayLike<number>, st: ArrayLike<number>, out: Float64Array): void {
  out[0] = F[2] * st[1];
  out[1] = F[0] * st[1];
}

/** Modal energy ½M Σ (q̇² + ω² q²), J. */
export function flexEnergy(F: ArrayLike<number>, m: FlexModel, M: number): number {
  let e = 0;
  for (let n = 0; n < 2; n++) { const w = m.w[n]; e += F[2 * n + 1] * F[2 * n + 1] + w * w * F[2 * n] * F[2 * n]; }
  return 0.5 * M * e;
}

/** True when the hull is still: every |q| < 1e-9 m and |q̇| < 1e-7 m/s. */
export function flexQuiet(F: ArrayLike<number>): boolean {
  return Math.abs(F[0]) < 1e-9 && Math.abs(F[2]) < 1e-9 && Math.abs(F[1]) < 1e-7 && Math.abs(F[3]) < 1e-7;
}

export const saveFlexState = (F: readonly number[]): number[] => F.slice(0, 4);

/** Loader default: at rest. */
export function loadFlexState(raw: unknown): number[] {
  const out = [0, 0, 0, 0];
  if (!Array.isArray(raw)) return out;
  for (let k = 0; k < 4; k++) { const v = raw[k]; out[k] = typeof v === 'number' && Number.isFinite(v) ? v : 0; }
  return out;
}
