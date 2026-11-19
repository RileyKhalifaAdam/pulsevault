// W2-E hands (src/world/hands.ts, src/data/handholds.ts): reach, grip arrest within the force limit, momentum
// exchange with the ship, rail slide, letting go, push-off inside and outside the friction cone, save → load.
import { describe, expect, it } from 'vitest';
import type { Quat, V3 } from '../src/core/types';
import { compileHandholds, HOLD_STRIDE, handholdsFor, type Handhold } from '../src/data/handholds';
import { INTERIORS } from '../src/data/interiors';
import { bootWell, shipJumpAt } from '../src/world/body';
import {
  ARM_LEN, ARM_PUSH_F, ARM_PUSH_T, BODY_MASS, consumeReaction, createGrip, createPush, createReachCache, createReachResult, createReaction, flickEffort,
  grab, GRIP_FMAX, GRIP_HELD, GRIP_LOST, GRIP_SLIDING, gripEquilibrium, LEG_PUSH_F, LEG_PUSH_T, LIMB_ARMS, LIMB_LEGS, loadGrip, pickHandhold, PUSH_CLAMPED,
  PUSH_CONE, PUSH_IN_CONE, PUSH_MU_MATCHES_BOOTS, PUSH_NONE, pushPeel, pushTick, RAIL_SLIDE_F, reachCached, reachPoint, REACH_LEAN_HELM, REACH_LEAN_STAND,
  recordImpulse, release, saveGrip, setGripPull, shoulderPoint, startPush, stepGrip, yawQuat, GRIP_OMEGA,
} from '../src/world/hands';

const Q = 1 / 120;
const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const ID: Quat = { x: 0, y: 0, z: 0, w: 1 };
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const hold = (a: V3, b: V3, kind: Handhold['kind'] = 'handle'): Float64Array => compileHandholds([{ id: 'h', kind, room: 'r', a, b, r: 0.015 }]);

describe('reach', () => {
  const NOBOX = new Float64Array(0);
  it('shoulders sit ±0.19 m lateral and 0.25 m below the eye, turning with the body', () => {
    const s = v3();
    shoulderPoint(v3(0, 1.6, 0), ID, 1, s);
    expect(s).toEqual(v3(0.19, 1.35, 0));
    shoulderPoint(v3(0, 1.6, 0), yawQuat(Math.PI / 2, { x: 0, y: 0, z: 0, w: 1 }), 1, s); // facing −X: right is −Z
    expect(s.z).toBeCloseTo(-0.19, 12);
  });

  it('the arm (0.72 m) plus a lean of ≤ 0.25 m standing / ≤ 0.10 m harnessed decides', () => {
    const eye = v3(0, 1.6, 0), dir = v3(0, 0, -1), r = createReachResult();
    // a point 0.9 m straight ahead of the right shoulder: needs a lean of ≈ 0.18 m
    const P = v3(0.19, 1.35, -0.9);
    expect(reachPoint(eye, ID, dir, REACH_LEAN_STAND, P, NOBOX, 0, r).ok).toBe(true);
    expect(r.side).toBe(1);
    expect(r.lean).toBeCloseTo(0.18, 9);
    expect(reachPoint(eye, ID, dir, REACH_LEAN_HELM, P, NOBOX, 0, r).ok).toBe(false);
    expect(reachPoint(eye, ID, dir, REACH_LEAN_STAND, v3(0.19, 1.35, -1.0), NOBOX, 0, r).ok).toBe(false);
    expect(reachPoint(eye, ID, null, 0, v3(0.19, 1.35, -0.7), NOBOX, 0, r).ok).toBe(true);
  });

  it('a box between shoulder and target blocks it; the box the shoulder is in (its own seat) does not', () => {
    const eye = v3(0, 1.6, 0), r = createReachResult();
    const wall = Float64Array.from([-1, 0, -0.45, 1, 3, -0.4]);
    expect(reachPoint(eye, ID, null, 0, v3(0.19, 1.35, -0.6), wall, 1, r).ok).toBe(false);
    expect(r.occluded).toBe(true);
    const seat = Float64Array.from([-1, 0, -0.2, 1, 1.4, 0.3]);
    expect(reachPoint(eye, ID, null, 0, v3(0.19, 1.35, -0.6), seat, 1, r).ok).toBe(true);
    // the 5 Hz cache agrees and only refreshes on its epoch
    const c = createReachCache(1);
    expect(reachCached(c, 0, 0, eye, ID, null, 0, v3(0.19, 1.35, -0.6), wall, 1)).toBe(false);
    expect(reachCached(c, 0, 23, eye, ID, null, 0, v3(0.19, 1.35, -0.6), NOBOX, 0)).toBe(false);
    expect(reachCached(c, 0, 24, eye, ID, null, 0, v3(0.19, 1.35, -0.6), NOBOX, 0)).toBe(true);
  });

  it('the Wren has holds (pillar handles, rails, edges, door frames) and a touch picks the nearest', () => {
    const lay = INTERIORS.wren!;
    const list = handholdsFor(lay), H = compileHandholds(list);
    expect(list.length).toBeGreaterThan(40);
    expect(H.length).toBe(list.length * HOLD_STRIDE);
    const i = pickHandhold(H, list.length, v3(-1.5, 0.36, -14.85));
    expect(list[i].id).toBe('pillar-port');
    expect(pickHandhold(H, list.length, v3(0, 0.5, -8))).toBe(-1);
  });
});

describe('grip', () => {
  it('arrests a 1 m/s float within the 350 N force limit and holds still', () => {
    const H = hold(v3(0, 1, 0), v3(0, 1, 0));
    const g = createGrip(), led = createReaction();
    // body point 0.45 m from the handle, moving away from it at 1 m/s; the hand at the shoulder (+0.4 m up)
    const p = v3(0, 0.6, -0.15), v = v3(0, 0, -1), off = v3(0, 0.4, 0);
    expect(grab(g, H, 0, p, off)).toBe(true);
    let peak = 0, lost = false, zMin = p.z;
    for (let k = 0; k < 240; k++) {
      const r = stepGrip(g, H, p, v, null, Q, led);
      if (r === GRIP_LOST) lost = true;
      peak = Math.max(peak, g.fPeak); zMin = Math.min(zMin, p.z);
    }
    console.log(`[hands] 1 m/s arrest: peak hand force ${peak.toFixed(1)} N, stop distance ${(-0.15 - zMin).toFixed(3)} m, |v| after 2 s ${len(v).toExponential(1)}`);
    expect(lost).toBe(false);
    expect(peak).toBeLessThanOrEqual(GRIP_FMAX * (1 + 1e-9));
    expect(peak).toBeGreaterThan(0.99 * GRIP_FMAX);
    expect(len(v)).toBeLessThan(1e-3);
    // the stop takes about v²/(2·F/m) = 0.114 m of arm (then the arm draws the body back to where it caught on)
    expect(-0.15 - zMin).toBeGreaterThan(0.1);
    expect(-0.15 - zMin).toBeLessThan(0.2);
    expect(len(v3(0, 0.6 + off.y - 1, zMin))).toBeLessThan(ARM_LEN);
  });

  /**
   * Independent reference: the body as a free point mass under the physical hand force law
   * F = m·clamp(−ω²(p − target) − 2ωv − f, 350 N / m), integrated by RK4 at 2 µs, with ∫F dt and ∫p × F dt
   * accumulated alongside. The module's ledger must equal −∫F dt and −∫p × F dt (the ship as a separate body).
   */
  function reference(p0: V3, v0: V3, target: V3, f: V3, T: number): { p: V3; v: V3; J: V3; L: V3 } {
    const amax = GRIP_FMAX / BODY_MASS, w = GRIP_OMEGA, n = Math.round(T / 2e-6), h = T / n;
    let y = [p0.x, p0.y, p0.z, v0.x, v0.y, v0.z, 0, 0, 0, 0, 0, 0];
    const der = (s: number[]): number[] => {
      let ax = -w * w * (s[0] - target.x) - 2 * w * s[3] - f.x, ay = -w * w * (s[1] - target.y) - 2 * w * s[4] - f.y, az = -w * w * (s[2] - target.z) - 2 * w * s[5] - f.z;
      const a = Math.hypot(ax, ay, az);
      if (a > amax) { ax *= amax / a; ay *= amax / a; az *= amax / a; }
      const Fx = BODY_MASS * ax, Fy = BODY_MASS * ay, Fz = BODY_MASS * az;
      return [s[3], s[4], s[5], ax + f.x, ay + f.y, az + f.z, Fx, Fy, Fz, s[1] * Fz - s[2] * Fy, s[2] * Fx - s[0] * Fz, s[0] * Fy - s[1] * Fx];
    };
    for (let i = 0; i < n; i++) {
      const k1 = der(y), k2 = der(y.map((q, j) => q + 0.5 * h * k1[j])), k3 = der(y.map((q, j) => q + 0.5 * h * k2[j])), k4 = der(y.map((q, j) => q + h * k3[j]));
      y = y.map((q, j) => q + (h / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
    }
    return { p: v3(y[0], y[1], y[2]), v: v3(y[3], y[4], y[5]), J: v3(y[6], y[7], y[8]), L: v3(y[9], y[10], y[11]) };
  }

  it('momentum exchange on a hand pull: the ledger equals the integrated hand force law (linear and angular)', () => {
    const H = hold(v3(1, 0.5, -2), v3(1, 0.5, -2));
    // unsaturated: the body drifts at 6 cm/s and the arm draws it back toward where it caught on, under a felt load
    const g = createGrip(), led = createReaction(), f = v3(0.3, -0.2, 0.1);
    const p = v3(1.2, 0.2, -1.6), v = v3(0.06, 0.02, -0.03), off = v3(0, 0.3, 0);
    expect(grab(g, H, 0, p, off)).toBe(true);
    const target = v3(g.g.x + g.tgt.x - g.off.x, g.g.y + g.tgt.y - g.off.y, g.g.z + g.tgt.z - g.off.z);
    const ref = reference(p, v, target, f, 1);
    for (let k = 0; k < 120; k++) stepGrip(g, H, p, v, f, Q, led);
    const J = v3(), L = v3();
    consumeReaction(led, J, L);
    const eJ = len(v3(J.x + ref.J.x, J.y + ref.J.y, J.z + ref.J.z)), eL = len(v3(L.x + ref.L.x, L.y + ref.L.y, L.z + ref.L.z));
    const ep = len(v3(p.x - ref.p.x, p.y - ref.p.y, p.z - ref.p.z));
    console.log(`[hands] hand pull vs RK4 of the force law over 1 s: |J| ${len(ref.J).toFixed(3)} N·s, error ${eJ.toExponential(1)} N·s; |L| ${len(ref.L).toFixed(3)}, error ${eL.toExponential(1)} N·m·s; position ${ep.toExponential(1)} m`);
    expect(len(ref.J)).toBeGreaterThan(4); // a real exchange (felt load carried + the stop)
    // (the reference's own rounding over 5e5 RK4 steps is ~1e-9; the ledger's felt-load moment uses the sub-step's
    // mean position, O(a·hs²) — 2e-8 of |L|)
    expect(eJ).toBeLessThan(1e-8);
    expect(eL).toBeLessThan(1e-7 * len(ref.L));
    expect(ep).toBeLessThan(1e-11);
    expect(len(led.J)).toBe(0); // consumed
  });

  it('a saturated catch (1 m/s) matches the force law to the sub-step: the ledger is the hand force, not a bookkeeping', () => {
    const H = hold(v3(0, 1, 0), v3(0, 1, 0));
    const g = createGrip(), led = createReaction();
    const p = v3(0, 0.6, -0.15), v = v3(0.2, 0, -1), off = v3(0, 0.4, 0);
    grab(g, H, 0, p, off);
    const target = v3(g.g.x + g.tgt.x - g.off.x, g.g.y + g.tgt.y - g.off.y, g.g.z + g.tgt.z - g.off.z);
    const ref = reference(p, v, target, v3(), 1);
    for (let k = 0; k < 120; k++) stepGrip(g, H, p, v, null, Q, led);
    const eJ = len(v3(led.J.x + ref.J.x, led.J.y + ref.J.y, led.J.z + ref.J.z));
    console.log(`[hands] 1 m/s catch vs RK4 of the capped force law: |J| ${len(ref.J).toFixed(3)} N·s, error ${eJ.toExponential(1)} N·s`);
    expect(eJ).toBeLessThan(1e-9 + 1e-3 * len(ref.J));
  });

  it('push off one wall, fly across, stop at the far wall: with every contact in the ledger the ship keeps Δv = 0', () => {
    // the cabin's walls at z = 0 (aft) and z = −6 (fore); the ship a free 5e4 kg body; crew.ts' wall stop is an
    // inelastic contact impulse J = −m·v_n, recorded with recordImpulse (THE RULE in hands.ts)
    const run = (wallInLedger: boolean): { V: number; v: number } => {
      const Ms = 5e4, ps = createPush(), led = createReaction(), a = v3(), J = v3(), L = v3(), jump = v3(), Jw = v3();
      const p = v3(0, 0, -0.3), v = v3();
      let V = v3(), stopped = false;
      startPush(ps, v3(0, 0, -1), v3(0, 0, -1), 1, LIMB_LEGS);
      for (let k = 0; k < 120 * 10; k++) {
        if (ps.on) pushTick(ps, p, Q, led, a); else { a.x = a.y = a.z = 0; }
        p.x += v.x * Q + 0.5 * a.x * Q * Q; p.y += v.y * Q + 0.5 * a.y * Q * Q; p.z += v.z * Q + 0.5 * a.z * Q * Q;
        v.x += a.x * Q; v.y += a.y * Q; v.z += a.z * Q;
        if (!stopped && p.z <= -5.7) {
          Jw.x = -BODY_MASS * v.x; Jw.y = -BODY_MASS * v.y; Jw.z = -BODY_MASS * v.z; // the far wall stops the body
          v.x = v.y = v.z = 0; p.z = -5.7; stopped = true;
          if (wallInLedger) recordImpulse(led, p, Jw);
        }
        consumeReaction(led, J, L);
        const dV = v3(J.x / Ms, J.y / Ms, J.z / Ms);
        V = v3(V.x + dV.x, V.y + dV.y, V.z + dV.z);
        shipJumpAt(p, dV, v3(), jump); // the free body keeps its inertial velocity
        if (!stopped) { v.x += jump.x; v.y += jump.y; v.z += jump.z; }
        else if (len(jump) > 0) { const Jb = v3(BODY_MASS * -jump.x, BODY_MASS * -jump.y, BODY_MASS * -jump.z); if (wallInLedger) recordImpulse(led, p, Jb); } // pressed on the wall, it rides along
      }
      return { V: V.z, v: v.z };
    };
    const closed = run(true), leaky = run(false);
    console.log(`[hands] push off, fly 5.4 m, stop at the far wall: ship Δv ${closed.V.toExponential(1)} m/s with the wall in the ledger, ${(leaky.V * 1e3).toFixed(3)} mm/s without (the reactionless drive)`);
    expect(Math.abs(closed.V)).toBeLessThan(1e-15);
    expect(leaky.V).toBeCloseTo((LEG_PUSH_F * LEG_PUSH_T) / 5e4, 4);
  });

  it('coupled with a free 2e5 kg ship through the ledger, total momentum is conserved to rounding', () => {
    const H = hold(v3(0, 0, -1), v3(0, 0, -1));
    const g = createGrip(), led = createReaction();
    const M = 2e5, p = v3(0, -0.3, -0.5), v = v3(0, 0, 0.8), off = v3(0, 0.3, 0);
    let V = v3(); // ship CoM velocity (inertial = craft axes; the ship does not turn: L goes into ω, tracked separately)
    expect(grab(g, H, 0, p, off)).toBe(true);
    const Ptot0 = BODY_MASS * (V.z + v.z) + M * V.z;
    const J = v3(), L = v3(), jump = v3();
    for (let k = 0; k < 240; k++) {
      stepGrip(g, H, p, v, null, Q, led);
      consumeReaction(led, J, L);
      const dV = v3(J.x / M, J.y / M, J.z / M);
      V = v3(V.x + dV.x, V.y + dV.y, V.z + dV.z);
      shipJumpAt(p, dV, v3(), jump); // the body sees the ship's jump (W1-C ledger path)
      v.x += jump.x; v.y += jump.y; v.z += jump.z;
    }
    const Ptot = BODY_MASS * (V.z + v.z) + M * V.z;
    console.log(`[hands] ship Δv from catching an 80 kg body at 0.8 m/s: ${(V.z * 1e3).toFixed(3)} mm/s; momentum error ${Math.abs(Ptot - Ptot0).toExponential(1)} N·s`);
    expect(Math.abs(Ptot - Ptot0)).toBeLessThan(1e-10);
    expect(V.z).toBeCloseTo((BODY_MASS * 0.8) / (M + BODY_MASS), 6);
  });

  it('a rail holds ≤ 200 N along it: a fast catch slides with 150 N of friction, then sticks', () => {
    const H = hold(v3(-3, 1, 0), v3(3, 1, 0), 'rail');
    const g = createGrip();
    const p = v3(-2, 0.6, 0), v = v3(1.5, 0, 0), off = v3(0, 0.3, 0);
    grab(g, H, 0, p, off);
    const r1 = stepGrip(g, H, p, v, null, Q, null);
    expect(r1).toBe(GRIP_SLIDING);
    const v1 = v.x;
    stepGrip(g, H, p, v, null, Q, null);
    expect((v1 - v.x) / Q).toBeCloseTo(RAIL_SLIDE_F / BODY_MASS, 6);
    let held = false;
    for (let k = 0; k < 120 && !held; k++) held = stepGrip(g, H, p, v, null, Q, null) === GRIP_HELD;
    expect(held).toBe(true);
    expect(p.x).toBeLessThan(3);
    // slid ≈ v²/(2a) = 0.6 m along the rail before sticking
    expect(g.g.x + 2).toBeGreaterThan(0.5);
  });

  it('sliding along a rail with velocity across it, the whole hand force (across + friction) stays ≤ 350 N', () => {
    const H = hold(v3(-3, 1, 0), v3(3, 1, 0), 'rail');
    const g = createGrip(), p = v3(-2, 0.6, 0.2), v = v3(1.5, 0, -1.0);
    grab(g, H, 0, p, v3(0, 0.3, 0));
    let pk = 0, slid = false;
    for (let k = 0; k < 60 && g.on; k++) { if (stepGrip(g, H, p, v, null, Q, null) === GRIP_SLIDING) slid = true; pk = Math.max(pk, g.fPeak); }
    console.log(`[hands] rail slide with 1 m/s across: peak hand force ${pk.toFixed(2)} N`);
    expect(slid).toBe(true);
    expect(pk).toBeLessThanOrEqual(GRIP_FMAX * (1 + 1e-9));
  });

  it('a non-finite felt load counts as none (no poisoned state); a zero step does nothing', () => {
    const H = hold(v3(0, 1, 0), v3(0, 1, 0)), off = v3(0, 0.4, 0);
    const a = createGrip(), b = createGrip(), pa = v3(0, 0.6, -0.2), pb = v3(0, 0.6, -0.2), va = v3(0, 0, -0.3), vb = v3(0, 0, -0.3);
    grab(a, H, 0, pa, off); grab(b, H, 0, pb, off);
    for (let k = 0; k < 10; k++) { stepGrip(a, H, pa, va, v3(NaN, Infinity, 0), Q, null); stepGrip(b, H, pb, vb, null, Q, null); }
    expect(pa).toEqual(pb); expect(va).toEqual(vb);
    expect(stepGrip(a, H, pa, va, null, 0, null)).toBe(GRIP_HELD);
    expect(pa).toEqual(pb);
    const ps = createPush(), out = v3(1, 1, 1);
    startPush(ps, v3(0, 1, 0), v3(0, 1, 0), 1, LIMB_LEGS);
    expect(pushTick(ps, v3(), 0, null, out)).toBe(0);
    expect(out).toEqual(v3());
  });

  it('warp and 1× pass the ship the same momentum: gripEquilibrium records the entry stop and the felt load carried', () => {
    const H = hold(v3(0, 1, 0), v3(0, 1, 0)), off = v3(0, 0.4, 0), f = v3(0, 0, 2); // 160 N felt load
    // 1×: settle, then one second of steady hold
    const g1 = createGrip(), l1 = createReaction(), p1 = v3(0, 0.6, -0.2), w1 = v3(), J1 = v3(), L1 = v3();
    grab(g1, H, 0, p1, off);
    for (let k = 0; k < 1200; k++) stepGrip(g1, H, p1, w1, f, Q, l1);
    consumeReaction(l1, J1, L1);
    for (let k = 0; k < 120; k++) stepGrip(g1, H, p1, w1, f, Q, l1);
    consumeReaction(l1, J1, L1);
    // warp: one 1 s quantum from the same held state
    const g2 = createGrip(), l2 = createReaction(), p2 = { ...p1 }, w2 = v3(), J2 = v3(), L2 = v3();
    grab(g2, H, 0, p2, off);
    g2.tgt = { ...g1.tgt }; g2.g = { ...g1.g };
    expect(gripEquilibrium(g2, H, p2, w2, f, 1, l2)).toBe(GRIP_HELD);
    consumeReaction(l2, J2, L2);
    console.log(`[hands] steady hold under 160 N: ship J per second at 1× ${J1.z.toFixed(6)} N·s, under warp ${J2.z.toFixed(6)} N·s`);
    expect(J1.z).toBeCloseTo(160, 6);
    expect(J2.z).toBeCloseTo(J1.z, 6);
    // entering warp while moving: the body's momentum goes to the ship, not nowhere
    const g3 = createGrip(), l3 = createReaction(), p3 = v3(0, 0.6, -0.2), w3 = v3(0.1, 0, 0);
    grab(g3, H, 0, p3, off);
    gripEquilibrium(g3, H, p3, w3, v3(), 0.5, l3);
    expect(l3.J.x).toBeCloseTo(BODY_MASS * 0.1, 12);
  });

  it('lets go when the arm is pulled past full extension, or when the felt load is beyond the grip under warp', () => {
    const H = hold(v3(0, 1, 0), v3(0, 1, 0));
    const g = createGrip();
    const p = v3(0, 0.6, -0.2), v = v3(0, 0, -3), off = v3(0, 0.4, 0);
    grab(g, H, 0, p, off);
    let r = GRIP_HELD;
    for (let k = 0; k < 120 && r !== GRIP_LOST; k++) r = stepGrip(g, H, p, v, null, Q, null);
    expect(r).toBe(GRIP_LOST);
    expect(g.on).toBe(false);
    expect(len(v)).toBeGreaterThan(1); // still flying away
    const g2 = createGrip(), p2 = v3(0, 0.6, -0.2), w2 = v3();
    grab(g2, H, 0, p2, off);
    expect(gripEquilibrium(g2, H, p2, w2, v3(0, 0, 2))).toBe(GRIP_HELD); // 160 N
    expect(gripEquilibrium(g2, H, p2, w2, v3(0, 0, 5))).toBe(GRIP_LOST); // 400 N
    release(g2);
  });

  it('save → load mid-arrest continues bit-identically', () => {
    const H = hold(v3(0, 1, 0), v3(0, 1, 0));
    const a = createGrip(), pa = v3(0, 0.6, -0.15), va = v3(0.1, 0, -1), off = v3(0, 0.4, 0);
    grab(a, H, 0, pa, off);
    for (let k = 0; k < 7; k++) stepGrip(a, H, pa, va, v3(0, -0.5, 0), Q, null);
    const b = loadGrip(JSON.parse(JSON.stringify(saveGrip(a))), 1), pb = { ...pa }, vb = { ...va };
    for (let k = 0; k < 50; k++) { stepGrip(a, H, pa, va, v3(0, -0.5, 0), Q, null); stepGrip(b, H, pb, vb, v3(0, -0.5, 0), Q, null); }
    expect(pb).toEqual(pa); expect(vb).toEqual(va);
    expect(loadGrip({ on: true, hold: 9 }, 1).on).toBe(false);
  });
});

describe('push-off', () => {
  const run = (limb: number, n: V3, want: V3, effort: number): { v: V3; res: number } => {
    const ps = createPush(), v = v3(), p = v3(), a = v3();
    const res = startPush(ps, n, want, effort, limb);
    for (let k = 0; k < 60 && ps.on; k++) { pushTick(ps, p, Q, null, a); v.x += a.x * Q; v.y += a.y * Q; v.z += a.z * Q; }
    return { v, res };
  };
  it('legs: ≤ 1 kN over 0.25 s gives 3.125 m/s, 3.117 m/s after peeling the boot magnets (2 J)', () => {
    const { v, res } = run(LIMB_LEGS, v3(0, 1, 0), v3(0, 1, 0), 1);
    expect(res).toBe(PUSH_IN_CONE);
    expect(v.y).toBeCloseTo((LEG_PUSH_F * LEG_PUSH_T) / BODY_MASS, 12);
    expect(bootWell(0)).toBeCloseTo(2, 12);
    expect(pushPeel(v3(0, 1, 0), v, bootWell(0), v3(), null)).toBe(true);
    expect(v.y).toBeCloseTo(3.117, 3);
  });
  it('arms: ≤ 300 N over 0.3 s gives 1.125 m/s; the flick speed scales it', () => {
    expect(run(LIMB_ARMS, v3(0, 0, 1), v3(0, 0, 1), 1).v.z).toBeCloseTo((ARM_PUSH_F * ARM_PUSH_T) / BODY_MASS, 12);
    expect(run(LIMB_ARMS, v3(0, 0, 1), v3(0, 0, 1), flickEffort(0.5, 2)).v.z).toBeCloseTo(0.28125, 12);
  });
  it('inside the 35° cone the push goes where wished; outside it is clamped to the cone edge with the force the friction allows; into the wall, none', () => {
    expect(PUSH_MU_MATCHES_BOOTS).toBe(true);
    const a = (30 * Math.PI) / 180, inside = run(LIMB_ARMS, v3(0, 0, 1), v3(Math.sin(a), 0, Math.cos(a)), 1);
    expect(inside.res).toBe(PUSH_IN_CONE);
    expect(Math.atan2(inside.v.x, inside.v.z)).toBeCloseTo(a, 12);
    const b = (70 * Math.PI) / 180, out = run(LIMB_ARMS, v3(0, 0, 1), v3(Math.sin(b), 0, Math.cos(b)), 1);
    expect(out.res).toBe(PUSH_CLAMPED);
    expect(Math.atan2(out.v.x, out.v.z)).toBeCloseTo(PUSH_CONE, 12);
    // the surface carries only F·cos 70°, so friction passes the cone edge's F·cos 70°/cos 35°
    expect(len(out.v)).toBeCloseTo(1.125 * Math.cos(b) / Math.cos(PUSH_CONE), 12);
    const c89 = (89 * Math.PI) / 180, graze = run(LIMB_ARMS, v3(0, 0, 1), v3(Math.sin(c89), 0, Math.cos(c89)), 1);
    expect(len(graze.v)).toBeLessThan(0.03); // almost along the wall: almost no push
    expect(run(LIMB_ARMS, v3(0, 0, 1), v3(0, 0, -1), 1).res).toBe(PUSH_NONE);
  });
  it('the ship takes the push: ledger J = −m·Δv and L = −p × J', () => {
    const ps = createPush(), led = createReaction(), p = v3(1, 2, 3), a = v3();
    startPush(ps, v3(0, 1, 0), v3(0, 1, 0), 1, LIMB_LEGS);
    for (let k = 0; k < 40; k++) pushTick(ps, p, Q, led, a);
    expect(led.J.y).toBeCloseTo(-LEG_PUSH_F * LEG_PUSH_T, 9);
    // the body got J_b = −led.J at p; the ship's angular impulse is −p × J_b = p × led.J
    expect(led.L.x).toBeCloseTo(-p.z * led.J.y, 9);
    expect(led.L.y).toBeCloseTo(0, 12);
    expect(led.L.z).toBeCloseTo(p.x * led.J.y, 9);
  });
});

describe('cost (node; loose bounds — the bench in the report is the measurement)', () => {
  it('a held tick, a reach test and a hold pick stay within the crew row of §1.2', () => {
    const lay = INTERIORS.wren!, H = compileHandholds(handholdsFor(lay)), nH = H.length / HOLD_STRIDE;
    const boxes = new Float64Array(lay.solids.length * 6);
    lay.solids.forEach((s, i) => boxes.set([s.box.min.x, s.box.min.y, s.box.min.z, s.box.max.x, s.box.max.y, s.box.max.z], i * 6));
    const g = createGrip(), p = v3(), v = v3(), off = v3(0, 0.3, 0), led = createReaction(), r = createReachResult();
    const time = (n: number, f: (i: number) => void): number => {
      for (let i = 0; i < n; i++) f(i);
      const t0 = performance.now();
      for (let i = 0; i < n; i++) f(i);
      return ((performance.now() - t0) * 1000) / n;
    };
    const grip = time(50000, (i) => {
      if (i % 240 === 0) { p.x = -1.3; p.y = 0; p.z = -14.6; v.x = 0.5; v.y = 0; v.z = 0.5; grab(g, H, 0, p, off); }
      stepGrip(g, H, p, v, null, Q, led);
    });
    const reach = time(50000, () => reachPoint(v3(-0.55, 0.62, -12.7), ID, v3(0, 0, -1), REACH_LEAN_STAND, v3(-0.9, 0, -13.9), boxes, lay.solids.length, r));
    const pick = time(50000, () => pickHandhold(H, nH, v3(-1.5, 0.36, -14.88)));
    console.log(`[hands] node µs: stepGrip/tick ${grip.toFixed(3)}, reachPoint ${reach.toFixed(3)}, pickHandhold ${pick.toFixed(3)}`);
    expect(grip).toBeLessThan(5);
    expect(reach).toBeLessThan(5);
    expect(pick).toBeLessThan(10);
  });
});
