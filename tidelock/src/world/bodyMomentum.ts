// W3-D item 6 "Momentum exchange" (docs/SIMULATION.md §2 W3-D, `body-momentum-mass`): every push the crew and the
// loose objects put on the hull goes into §1.4 `extImpulse {J, L}` (craft axes; L about the system centre of mass c),
// which W3-A's massProps.ts applyExtImpulse applies to the craft once per tick and zeroes. Pure, allocation-free,
// deterministic; exact (the tests check linear and angular momentum of ship + body to round-off).
//
// ONE accounting per body state (mixing them is a reactionless drive or a double count):
// - FREE bodies (floating, walking on boots, a hand on a rail with hands.ts' grip spring, a loose prop): they are NOT
//   in W3-A's mass `pts`. Every support impulse the hull gives them goes to the hull with the opposite sign:
//   hands.ts' ReactionLedger (grip, push-off, transitions, boots, walls) → foldReaction once per tick; any other
//   contact impulse J_body at hull point p → addReaction(ext, J_body, p, c).
// - COUPLED bodies (seated in the harness, resting props, a body W3-A counts in `pts`): part of the rigid system;
//   forces between them and the hull are internal and are NOT booked.
// - The change between the two is booked once, exactly: attach (a free body becomes coupled) and detach. Let the
//   body have mass m at hull point p (r = p − c with c the system CoM BEFORE the change) and velocity relative to the
//   hull point u = v_body − (V + ω × r). Then, with W3-A recomputing the mass properties for the new `pts` before it
//   applies extImpulse:
//     attach: J = m(ω × r + u),  L = μ r × u,  μ = mM/(M + m)   (M = system mass before; ΔV = J/(M + m))
//     detach: J = −m(ω × r + u), L = −μ r × u, μ = mM'/(M' + m) (M' = system mass after;  ΔV = J/M')
//   and the system CoM moves by Δc = ±m r/(M_after) in craft axes: W3-A must move rel by q·Δc at the same instant
//   (the hull does not jump; comShift gives Δc). A pure release (u = 0) changes ω not at all (L = 0).
//
// WIRING (wave 3; nothing here is called yet):
// - session.ts once per tick, after the crew and props step and before W3-A's applyExtImpulse:
//     consumeReaction(crewLedger, J, L) (hands.ts); foldReaction(c.extImpulse, J, L, c.com)
//   props.ts / crew.ts contacts of FREE bodies: addReaction(c.extImpulse, J_on_body, p_contact, c.com) for every
//   impulse the solver gives a body (wall bounce, a prop resting on the deck is COUPLED, no booking).
//   transitions.ts / hands.ts when a body becomes seated, gripped-rigid or resting (enters pts): attachBody(…); when
//   it leaves: detachBody(…) and W3-A shifts rel by q·comShift(…).
// - §1.4 written: extImpulse (J, L) — accumulated here, applied and zeroed by W3-A. Read: com (c), the craft's ω.
// - Replaces hands.ts' "consume and discard" (its THE RULE holds once every free-body support writes here).
// - Nothing is saved here: extImpulse is consumed every tick; a save happens at a tick boundary after it is zeroed
//   (W1-A's tick order), so it is always zero in a save. If W3-A saves it anyway, saving {J, L} as numbers is exact.

import type { V3 } from '../core/types';
import type { ExtImpulse } from './massProps';

/** The hull gave a free body the impulse Jb (N·s, craft axes) at hull point p (craft axes): the hull takes −Jb. */
export function addReaction(ext: ExtImpulse, Jb: V3, p: V3, com: V3): void {
  const rx = p.x - com.x, ry = p.y - com.y, rz = p.z - com.z;
  ext.J.x -= Jb.x; ext.J.y -= Jb.y; ext.J.z -= Jb.z;
  ext.L.x -= ry * Jb.z - rz * Jb.y;
  ext.L.y -= rz * Jb.x - rx * Jb.z;
  ext.L.z -= rx * Jb.y - ry * Jb.x;
}

/**
 * Fold a consumed hands.ts ReactionLedger (J and L the ship takes, L about the craft-axes ORIGIN, as hands.ts books
 * it with ship-frame positions) into extImpulse about the system CoM c: L_c = L_o − c × J.
 */
export function foldReaction(ext: ExtImpulse, J: V3, L: V3, com: V3): void {
  ext.J.x += J.x; ext.J.y += J.y; ext.J.z += J.z;
  ext.L.x += L.x - (com.y * J.z - com.z * J.y);
  ext.L.y += L.y - (com.z * J.x - com.x * J.z);
  ext.L.z += L.z - (com.x * J.y - com.y * J.x);
}

function couple(ext: ExtImpulse, sign: number, m: number, mSys: number, p: V3, com: V3, w: V3, u: V3): void {
  const rx = p.x - com.x, ry = p.y - com.y, rz = p.z - com.z;
  const wrx = w.y * rz - w.z * ry, wry = w.z * rx - w.x * rz, wrz = w.x * ry - w.y * rx;
  const s = sign * m;
  ext.J.x += s * (wrx + u.x); ext.J.y += s * (wry + u.y); ext.J.z += s * (wrz + u.z);
  const mu = (sign * m * mSys) / (mSys + m);
  ext.L.x += mu * (ry * u.z - rz * u.y);
  ext.L.y += mu * (rz * u.x - rx * u.z);
  ext.L.z += mu * (rx * u.y - ry * u.x);
}

/**
 * A free body of mass m at hull point p (craft axes) with velocity u relative to that hull point becomes coupled to
 * the rigid system (system mass M and CoM c before the change; ω the craft's angular velocity, craft axes).
 */
export function attachBody(ext: ExtImpulse, m: number, M: number, p: V3, com: V3, w: V3, u: V3): void {
  couple(ext, 1, m, M, p, com, w, u);
}

/**
 * A coupled body of mass m at p leaves the rigid system with velocity u relative to its hull point (M' = the system
 * mass AFTER it left; c the CoM BEFORE).
 */
export function detachBody(ext: ExtImpulse, m: number, Mafter: number, p: V3, com: V3, w: V3, u: V3): void {
  couple(ext, -1, m, Mafter, p, com, w, u);
}

/** CoM shift (craft axes) when a body of mass m at p joins (sign +1, mAfter = M + m) or leaves (−1, mAfter = M'). */
export function comShift(sign: number, m: number, mAfter: number, p: V3, com: V3, out: V3): V3 {
  const k = (sign * m) / mAfter;
  out.x = k * (p.x - com.x); out.y = k * (p.y - com.y); out.z = k * (p.z - com.z);
  return out;
}
