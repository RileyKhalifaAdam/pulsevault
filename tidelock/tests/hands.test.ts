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
  release, saveGrip, setGripPull, shoulderPoint, startPush, stepGrip, yawQuat,
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

  it('momentum exchange on a hand pull: the ship takes exactly what the body gets (linear and angular)', () => {
    const H = hold(v3(1, 0.5, -2), v3(1, 0.5, -2));
    const g = createGrip(), led = createReaction();
    const p = v3(1.2, 0.2, -1.6), v = v3(0.05, 0, 0), off = v3(0, 0.3, 0);
    grab(g, H, 0, p, off);
    setGripPull(g, 0.25); // pull in: the body is drawn to the handle
    const P0 = { x: BODY_MASS * v.x, y: BODY_MASS * v.y, z: BODY_MASS * v.z };
    const L0 = { x: BODY_MASS * (p.y * v.z - p.z * v.y), y: BODY_MASS * (p.z * v.x - p.x * v.z), z: BODY_MASS * (p.x * v.y - p.y * v.x) };
    for (let k = 0; k < 120; k++) stepGrip(g, H, p, v, null, Q, led);
    const J = v3(), L = v3();
    consumeReaction(led, J, L);
    const dP = v3(BODY_MASS * v.x - P0.x, BODY_MASS * v.y - P0.y, BODY_MASS * v.z - P0.z);
    const dL = v3(BODY_MASS * (p.y * v.z - p.z * v.y) - L0.x, BODY_MASS * (p.z * v.x - p.x * v.z) - L0.y, BODY_MASS * (p.x * v.y - p.y * v.x) - L0.z);
    expect(len(dP)).toBeGreaterThan(1); // a real pull: > 1 N·s
    expect(len(v3(J.x + dP.x, J.y + dP.y, J.z + dP.z))).toBeLessThan(1e-12 * (1 + len(dP)));
    expect(len(v3(L.x + dL.x, L.y + dL.y, L.z + dL.z))).toBeLessThan(1e-11 * (1 + len(dL)));
    expect(len(led.J)).toBe(0); // consumed
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
  it('inside the 35° cone the push goes where wished; outside it is clamped to the cone edge; into the wall, none', () => {
    expect(PUSH_MU_MATCHES_BOOTS).toBe(true);
    const a = (30 * Math.PI) / 180, inside = run(LIMB_ARMS, v3(0, 0, 1), v3(Math.sin(a), 0, Math.cos(a)), 1);
    expect(inside.res).toBe(PUSH_IN_CONE);
    expect(Math.atan2(inside.v.x, inside.v.z)).toBeCloseTo(a, 12);
    const b = (70 * Math.PI) / 180, out = run(LIMB_ARMS, v3(0, 0, 1), v3(Math.sin(b), 0, Math.cos(b)), 1);
    expect(out.res).toBe(PUSH_CLAMPED);
    expect(Math.atan2(out.v.x, out.v.z)).toBeCloseTo(PUSH_CONE, 12);
    expect(len(out.v)).toBeCloseTo(1.125, 12);
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
