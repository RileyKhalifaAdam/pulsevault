// Oblateness (J2) of a spinning body (SIMULATION.md W3-A item 6, `env-j2-oblateness`): the closed-form J2 gravity
// term about the body's spin axis k̂, a perturbation rider on the gravity sum (no new state, no new step limit).
//   a_J2 = −(3/2)·J2·μ·R²/r⁵ · [(1 − 5ζ²/r²)·r + 2ζ·k̂],   ζ = r·k̂,   r = position relative to the body
// The reaction on the body is −m·a_J2 (equal and opposite: the ephemeris pairs apply it to both members, weighted by
// mass). J2 for a fluid body in hydrostatic equilibrium follows from its rotation: J2 ≈ k₂/3 · q with
// q = Ω²R³/μ; the plan takes J2 = 0.165·q (k₂ ≈ 0.5), 0.011 for Sconce. Nodal regression of an orbit:
//   Ω̇ = −(3/2)·n·J2·(R/p)²·cos i   (tests/j2.test.ts within 3 %).
//
// WIRING (wave 3; nothing here is called yet):
//   * data/systems (sim/universe.ts): give each oblate body `j2` (= J2_FROM_SPIN·Ω²R³/μ unless stated) — a new
//     AtmosphereDef-style optional field on BodyDef/Body (types.ts / state.ts, the hub adds it); 0 elsewhere.
//   * dynamics.ts gravity(): after the point-mass sum, for the primary p with j2 > 0:
//       J[0..2] = (x, y, z) primary-relative; J[3..5] = spin axis; J[6] = μ_p, J[7] = R_p, J[8] = j2; j2Accel(J)
//       → J[9..11] added to _ax.._az. (Other bodies' J2 on a craft is < 1e-9 of their pull at their distances: not built.)
//   * ephemeris.ts (W3-A owns it in wave 3): the same term between each moon and its planet (the moon pairs), with the
//     reaction −(m_moon/m_planet)·a on the planet, inside the Yoshida force evaluation (fixed H: deterministic).
//   * Read only; writes nothing in §1.4. Cost ≈ 10 ns per evaluation. Warp: a smooth conservative term, exact under
//     the existing integrators; no limitedBy.

/** J2 per unit rotational parameter q = Ω²R³/μ (the plan's 0.165). */
export const J2_FROM_SPIN = 0.165;

/** j2Accel slots: in r (3), spin axis (3, unit), μ, R, J2; out a (3). */
export const J2_RX = 0, J2_KX = 3, J2_MU = 6, J2_R = 7, J2_J2 = 8, J2_AX = 9, J2_LEN = 12;
export const makeJ2In = (): Float64Array => new Float64Array(J2_LEN);

/** The J2 acceleration (m/s²) at J[J2_RX..] into J[J2_AX..]. */
export function j2Accel(J: Float64Array): void {
  const x = J[0], y = J[1], z = J[2], kx = J[3], ky = J[4], kz = J[5];
  const r2 = x * x + y * y + z * z;
  if (!(r2 > 0) || !(J[J2_J2] !== 0)) { J[9] = J[10] = J[11] = 0; return; }
  const r = Math.sqrt(r2), R = J[J2_R];
  const ze = x * kx + y * ky + z * kz;
  const k = (-1.5 * J[J2_J2] * J[J2_MU] * R * R) / (r2 * r2 * r);
  const a = 1 - (5 * ze * ze) / r2;
  J[9] = k * (a * x + 2 * ze * kx);
  J[10] = k * (a * y + 2 * ze * ky);
  J[11] = k * (a * z + 2 * ze * kz);
}

/** Hydrostatic J2 estimate from a body's spin rate, radius and μ. */
export const j2FromSpin = (spinRate: number, radius: number, mu: number): number =>
  mu > 0 ? (J2_FROM_SPIN * spinRate * spinRate * radius * radius * radius) / mu : 0;

/** Secular nodal regression rate (rad/s) of an orbit a, e, i about a body (μ, R, J2). */
export function nodalRate(mu: number, R: number, J2: number, a: number, e: number, i: number): number {
  const n = Math.sqrt(mu / (a * a * a)), p = a * (1 - e * e);
  return -1.5 * n * J2 * (R / p) * (R / p) * Math.cos(i);
}
