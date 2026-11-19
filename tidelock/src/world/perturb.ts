// Small perturbations on the craft's orbit (SIMULATION.md W2-B items 5 and 7): station gravity and weak
// (thermospheric) drag as a coast perturbation.
//
// Station gravity: a = −G·m_st·d/|d|³ from a station on the same primary within 50 km (d = ship − station), g ∝ r
// inside the station's bounding radius (uniform-sphere interior: no singularity when the ship is in the hub), and a
// C¹ taper over the last 20% of the range so nothing steps at 50 km. The reaction −m_ship·a acts on the station.
// At 682 m from a 1e10 kg Wheel: 1.4e-6 m/s², ≈ 1.7 km of Clohessy–Wiltshire drift per 8 h sleep (D5).
//
// Weak drag: where |a_drag| < WEAK_DRAG_ACCEL (1e-5 m/s²), the coast step stays the symplectic Yoshida step at the
// dynamical-time step and the drag enters as half-kick / drift / half-kick velocity kicks (dragKick before and after
// stepCoast), instead of capping the step at 1 s in air. At 547 km over Wick that gives the honest ≈ m/day decay.
//
// WIRING (wave 2; nothing here is called yet):
//   * dynamics.ts gravity(): for a craft with stations on its primary within STATION_GRAVITY_RANGE, add
//     stationGravity(sg) per station (sg[SG_DX..DZ] = craft − station, primary-relative; sg[SG_GM] = G·m_st from
//     W2-C's stationMassProps; sg[SG_RB] = the station's bounding radius) — inside every force evaluation of the
//     translational integrator (coast and forced). The station's own integrator gets −m_ship/m_st times it.
//     Stations' positions within a step: linear in time from their step-start state (the station step is the same
//     size; the error is second order in a 1e-6 m/s² term).
//   * dynamics.ts chooseDt / integrateCraft: when above atm.top (no 'atmosphere' situation) but below
//     profile.tableTop and |a_drag| (from aero.ts at the current attitude) < WEAK_DRAG_ACCEL, do not take the in-air
//     forced branch: dragKick(P, a, dt/2); stepCoast(P, eph, t, dt); recompute a at the new state; dragKick(P, a, dt/2).
//     The kicks are proper forces: the ledger gets m·a over the step (the IMU reads 1e-6 g, honestly).
//   Contract fields: none new; reads W2-C's station masses.

export const SG_DX = 0, SG_DY = 1, SG_DZ = 2, SG_GM = 3, SG_RB = 4, SG_AX = 5, SG_AY = 6, SG_AZ = 7, SG_LEN = 8;
/** Station gravity is applied within this range, m (same primary). */
export const STATION_GRAVITY_RANGE = 50e3;
/** The taper starts at this fraction of the range. */
export const STATION_GRAVITY_TAPER = 0.8;
/** Below this drag acceleration the drag is a coast perturbation (kicks around stepCoast), m/s². */
export const WEAK_DRAG_ACCEL = 1e-5;
export const G_NEWTON = 6.6743e-11;

/** Acceleration on the ship from one station, into sg[SG_AX..AZ]. */
export function stationGravity(sg: Float64Array): void {
  const dx = sg[SG_DX], dy = sg[SG_DY], dz = sg[SG_DZ];
  const d2 = dx * dx + dy * dy + dz * dz;
  const R = STATION_GRAVITY_RANGE;
  if (!(d2 < R * R)) { sg[SG_AX] = sg[SG_AY] = sg[SG_AZ] = 0; return; }
  const d = Math.sqrt(d2), rb = sg[SG_RB], gm = sg[SG_GM];
  // −GM·d/|d|³ outside, −GM·d/R_b³ inside (uniform sphere)
  let k = d > rb ? gm / (d2 * d) : gm / (rb * rb * rb);
  const r0 = STATION_GRAVITY_TAPER * R;
  if (d > r0) {
    const x = (d - r0) / (R - r0);
    k *= 1 - x * x * (3 - 2 * x);
  }
  sg[SG_AX] = -k * dx; sg[SG_AY] = -k * dy; sg[SG_AZ] = -k * dz;
}

/** A velocity kick v += a·h on a particle-like state (half kicks of the weak-drag splitting). */
export function dragKick(P: { vx: number; vy: number; vz: number }, a: { x: number; y: number; z: number }, h: number): void {
  P.vx += a.x * h; P.vy += a.y * h; P.vz += a.z * h;
}
