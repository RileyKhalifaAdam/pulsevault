// W2-E transitions (src/world/transitions.ts): sitting, standing and lying as force-limited motions — duration,
// muscle limits, momentum in zero g, the zero-g stand-up, no snaps, the neck slew, the lying frame, props against the
// seated pilot, warp, save → load.
import { describe, expect, it } from 'vitest';
import type { Quat, V3 } from '../src/core/types';
import { createReaction, consumeReaction } from '../src/world/hands';
import {
  ARM_F, bedFrame, bodyPropImpulse, createTransition, DEF_ARMS, DEF_SIT, handoverResidual, LEG_F, legsDef, loadTransition, NECK_RATE, pathBunk, pathSeat,
  pathStand, POSE_LYING, POSE_SEATED, postureCapsules, saveTransition, slewAngle, sphereCapsule, startTransition, stepTransition, throwReaction, TR_FREE,
  TR_MOVING, TR_NONE, TR_REFUSED_BAD, TR_REFUSED_FAST, TR_SEATED, transitionJump, transitionPose, type TransitionDef, type TransitionState,
} from '../src/world/transitions';
import { shipJumpAt } from '../src/world/body';

const Q = 1 / 120, M = 80, G = 9.80665;
const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const ID: Quat = { x: 0, y: 0, z: 0, w: 1 };
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);

// the Wren's helm: standing body CoM in front of the pilot seat → seated pelvis
const STAND = v3(-0.55, -0.05, -12.7), SEAT = v3(-0.55, -0.55, -13.45);

interface Run { ticks: number; vmax: number; amax: number; limb: number; jump: number; phase: number; first: number }
/**
 * Step a transition at h (default Q) and measure, independently of the module, the body's whole acceleration vector
 * |Δv|/h from its pose (centripetal and cross parts included) and the limb + support force m·|a − f|.
 */
function run(tr: TransitionState, f: V3, maxTicks = 600, h = Q): Run {
  const p = v3(), v = v3(), pp = v3(), pv = v3();
  transitionPose(tr, pp, pv, null);
  let ticks = 0, vmax = 0, amax = 0, limb = 0, jump = 0, first = -1, ph = TR_MOVING;
  while (ticks < maxTicks * Math.round(Q / h)) {
    ph = stepTransition(tr, f, h, null);
    ticks++;
    transitionPose(tr, p, v, null);
    vmax = Math.max(vmax, len(v));
    const ax = (v.x - pv.x) / h, ay = (v.y - pv.y) / h, az = (v.z - pv.z) / h;
    // the tick that ends at a seat hands the residual to the harness (the pose stays): its Δv is measured too
    amax = Math.max(amax, Math.hypot(ax, ay, az));
    limb = Math.max(limb, M * Math.hypot(ax - f.x, ay - f.y, az - f.z));
    if (first < 0) first = Math.hypot(ax, ay, az);
    jump = Math.max(jump, len(v3(p.x - pp.x, p.y - pp.y, p.z - pp.z)));
    pp.x = p.x; pp.y = p.y; pp.z = p.z; pv.x = v.x; pv.y = v.y; pv.z = v.z;
    if (ph !== TR_MOVING) break;
  }
  return { ticks: ticks * h / Q, vmax, amax, limb, jump, phase: ph, first };
}
function start(def: TransitionDef, P0: V3, P2: V3, P1?: V3): TransitionState {
  const tr = createTransition(), c = P1 ?? pathSeat(P0, P2, v3());
  startTransition(tr, def, P0, c, P2, ID, ID, null);
  return tr;
}

describe('sit and stand as motions', () => {
  it('sitting down at the helm in 1 g: the whole acceleration vector stays within the legs (600 N), no snap', () => {
    for (const h of [Q, Q / 8]) {
      const tr = start(DEF_SIT, STAND, SEAT), L = tr.L;
      const r = run(tr, v3(0, -G, 0), 600, h);
      const t = r.ticks * Q;
      console.log(`[transitions] helm sit-down in 1 g (h = Q/${Math.round(Q / h)}): path ${L.toFixed(2)} m, ${t.toFixed(2)} s, peak ${r.vmax.toFixed(2)} m/s, peak |a| (vector) ${r.amax.toFixed(4)} m/s²`);
      expect(r.phase).toBe(TR_SEATED);
      // the plan's 0.6–1.2 s assumed only the along-path force was limited; with the corner's centripetal part in the
      // budget the same legs take 1.2–1.3 s (reported deviation)
      expect(t).toBeGreaterThan(1.0);
      expect(t).toBeLessThan(1.4);
      // the dynamic part (the felt load is carried by posture and seat on top) is the whole vector, ≤ 600 N / 80 kg
      expect(r.amax).toBeLessThanOrEqual(LEG_F / M + 1e-9);
      // no snap: the body never moves more than its speed allows in a tick
      expect(r.jump).toBeLessThanOrEqual(r.vmax * h * 1.001 + 1e-9);
    }
  });

  it('strapping in in zero g with the arms: the limb force m·|a − f| itself stays ≤ 200 N', () => {
    for (const h of [Q, Q / 8]) {
      const tr = start(DEF_ARMS, STAND, SEAT), r = run(tr, v3(), 600, h);
      console.log(`[transitions] zero-g strap-in (arms, h = Q/${Math.round(Q / h)}): ${(r.ticks * Q).toFixed(2)} s, peak ${r.vmax.toFixed(2)} m/s, peak limb force ${r.limb.toFixed(3)} N`);
      expect(r.phase).toBe(TR_SEATED);
      expect(r.limb).toBeLessThanOrEqual(ARM_F + 1e-7);
      expect(r.ticks * Q).toBeLessThan(2.0);
    }
  });

  it('a start velocity across the path is taken up over time within the limbs, never removed at once', () => {
    const tr = createTransition();
    const v0 = v3(0.12, 0.05, -0.03);
    expect(startTransition(tr, DEF_ARMS, STAND, pathSeat(STAND, SEAT, v3()), SEAT, ID, ID, v0)).toBeGreaterThan(0);
    const p = v3(), v = v3();
    transitionPose(tr, p, v, null);
    expect(len(v3(v.x - v0.x, v.y - v0.y, v.z - v0.z))).toBeLessThan(1e-15); // the pose keeps the body's velocity
    const r = run(tr, v3());
    console.log(`[transitions] zero-g strap-in with 0.13 m/s of cross velocity: ${(r.ticks * Q).toFixed(2)} s, first-tick |a| ${r.first.toFixed(3)}, peak limb force ${r.limb.toFixed(3)} N`);
    expect(r.phase).toBe(TR_SEATED);
    expect(r.limb).toBeLessThanOrEqual(ARM_F + 1e-7);
    // too fast across the path (1 m/s): refused, nothing starts
    const t2 = createTransition();
    expect(startTransition(t2, DEF_ARMS, STAND, pathSeat(STAND, SEAT, v3()), SEAT, ID, ID, v3(1, 0, 0))).toBe(TR_REFUSED_FAST);
    expect(t2.on).toBe(false);
  });

  it('lying down on the bunk is a motion too: duration, limits, no snap, it ends in the bed frame', () => {
    const BUNK = v3(-2.6, -0.25, -3.4), BESIDE = v3(-1.9, 0.0, -3.4), qBed = bedFrame(v3(0, 0, -1), { x: 0, y: 0, z: 0, w: 1 });
    for (const [def, f, lim] of [[DEF_SIT, v3(0, -G, 0), LEG_F], [DEF_ARMS, v3(), ARM_F]] as [TransitionDef, V3, number][]) {
      const tr = createTransition(), P1 = pathBunk(BESIDE, BUNK, v3());
      expect(P1.y).toBeGreaterThanOrEqual(BUNK.y + 0.2); // over the mattress, not through its edge
      expect(pathBunk(v3(-1.9, -0.4, -3.4), BUNK, v3()).y).toBeCloseTo(BUNK.y + 0.2, 12);
      expect(startTransition(tr, def, BESIDE, P1, BUNK, ID, qBed, null)).toBeGreaterThan(0);
      const r = run(tr, f);
      const p = v3(), v = v3(), q = { x: 0, y: 0, z: 0, w: 1 };
      transitionPose(tr, p, v, q);
      console.log(`[transitions] lie down (${lim} N): ${(r.ticks * Q).toFixed(2)} s, peak ${r.vmax.toFixed(2)} m/s, peak |a| ${r.amax.toFixed(4)} m/s²`);
      expect(r.phase).toBe(TR_SEATED);
      expect(r.ticks * Q).toBeGreaterThan(0.8);
      expect(r.ticks * Q).toBeLessThan(2.0);
      expect(r.amax).toBeLessThanOrEqual(lim / M + 1e-9);
      expect(r.jump).toBeLessThanOrEqual(r.vmax * Q * 1.001 + 1e-9);
      expect(len(v3(p.x - BUNK.x, p.y - BUNK.y, p.z - BUNK.z))).toBeLessThan(0.01);
      expect(Math.abs(q.x * qBed.x + q.y * qBed.y + q.z * qBed.z + q.w * qBed.w)).toBeGreaterThan(1 - 1e-6); // the bed frame
    }
  });

  it('non-finite or zero-length paths start nothing; non-finite felt loads count as none', () => {
    const t = createTransition();
    expect(startTransition(t, DEF_SIT, v3(NaN, 0, 0), SEAT, SEAT, ID, ID, null)).toBe(TR_REFUSED_BAD);
    expect(t.on).toBe(false);
    expect(startTransition(t, DEF_SIT, SEAT, SEAT, SEAT, ID, ID, null)).toBe(TR_REFUSED_BAD);
    expect(t.on).toBe(false);
    expect(t.phase).toBe(TR_NONE);
    const a = start(DEF_SIT, STAND, SEAT), b = start(DEF_SIT, STAND, SEAT);
    for (let k = 0; k < 20; k++) { stepTransition(a, v3(NaN, Infinity, 0), Q, null); stepTransition(b, v3(), Q, null); }
    expect(saveTransition(a)).toEqual(saveTransition(b));
    expect(Number.isFinite(a.s)).toBe(true);
  });

  it('standing up in 1 g arrives standing; in zero g the legs launch the body and it keeps their velocity', () => {
    const p1 = pathStand(SEAT, STAND, v3());
    const g1 = createTransition();
    startTransition(g1, legsDef(false), SEAT, p1, STAND, ID, ID, null);
    const r1 = run(g1, v3(0, -G, 0));
    expect(r1.phase).toBe(TR_SEATED);
    expect(r1.amax).toBeLessThanOrEqual(LEG_F / M + 1e-9);
    const g0 = createTransition();
    startTransition(g0, legsDef(false), SEAT, p1, STAND, ID, ID, null);
    const r0 = run(g0, v3());
    expect(r0.limb).toBeLessThanOrEqual(LEG_F + 1e-7);
    const p = v3(), v = v3();
    transitionPose(g0, p, v, null);
    console.log(`[transitions] zero-g stand-up: leaves at ${len(v).toFixed(2)} m/s after ${(r0.ticks * Q).toFixed(2)} s`);
    expect(r0.phase).toBe(TR_FREE);
    expect(len(v)).toBeGreaterThan(0.3);
    expect(len(v)).toBeLessThanOrEqual(Math.sqrt(2 * (LEG_F / M) * g0.L));
    // with the boots holding the feet the legs can brake: it arrives
    const gb = createTransition();
    startTransition(gb, legsDef(true), SEAT, p1, STAND, ID, ID, null);
    const rb = run(gb, v3());
    expect(rb.phase).toBe(TR_SEATED);
    expect(rb.limb).toBeLessThanOrEqual(LEG_F + 1e-7);
  });

  it('a transition conserves momentum in zero g: the system CoM of body and a free ship moves uniformly', () => {
    const tr = createTransition(), led = createReaction(), Ms = 5e4;
    // arriving with 0.1 m/s sideways: the cross take-up absorbs it over time and passes it to the ship
    expect(startTransition(tr, DEF_ARMS, STAND, pathSeat(STAND, SEAT, v3()), SEAT, ID, ID, v3(0.1, 0, 0), led)).toBeGreaterThan(0);
    let V = v3(), X = v3(); // the ship's CoM velocity and displacement (inertial)
    const p0 = v3(), v0 = v3(), J = v3(), L = v3();
    transitionPose(tr, p0, v0, null);
    // the body's inertial momentum before: it was moving at (0.1, 0, 0)
    const Pb0 = v3(M * 0.1, 0, 0);
    const jump = v3(), p = v3(), v = v3(), free = v3(); // free: jumps the body takes once the transition has ended
    let t = 0;
    for (let k = 0; k < 400; k++) {
      if (tr.on) stepTransition(tr, v3(), Q, led);
      consumeReaction(led, J, L);
      if (!tr.on && len(J) === 0) break;
      const dV = v3(J.x / Ms, J.y / Ms, J.z / Ms);
      // the ship's displacement over the tick with the tick's impulse spread over it (the limbs push all tick long)
      X = v3(X.x + (V.x + 0.5 * dV.x) * Q, X.y + (V.y + 0.5 * dV.y) * Q, X.z + (V.z + 0.5 * dV.z) * Q);
      t += Q;
      V = v3(V.x + dV.x, V.y + dV.y, V.z + dV.z); // … then takes the tick's impulse
      transitionPose(tr, p, v, null);
      shipJumpAt(p, dV, v3(), jump);
      if (tr.on) transitionJump(tr, jump, led); // the held body sees the ship's jump; its supports pass it back
      else { free.x += jump.x; free.y += jump.y; free.z += jump.z; } // (after the end the harness body takes it: not modelled here)
    }
    transitionPose(tr, p, v, null);
    v.x += free.x; v.y += free.y; v.z += free.z;
    // total momentum: body (ship-relative v + V) + ship
    const Ptot = v3(M * (v.x + V.x) + Ms * V.x, M * (v.y + V.y) + Ms * V.y, M * (v.z + V.z) + Ms * V.z);
    const err = len(v3(Ptot.x - Pb0.x, Ptot.y - Pb0.y, Ptot.z - Pb0.z));
    // and positions (independent of the ledger's bookkeeping: the pose, cross offset included, against the ship's
    // integrated path): the system CoM moves at P/(M + Ms)
    const com = v3((Ms * X.x + M * (X.x + p.x - p0.x) - Pb0.x * t) / (Ms + M), (Ms * X.y + M * (X.y + p.y - p0.y)) / (Ms + M), (Ms * X.z + M * (X.z + p.z - p0.z)) / (Ms + M));
    console.log(`[transitions] zero-g strap-in momentum error ${err.toExponential(1)} N·s (of ${len(Pb0)} N·s); system CoM off its uniform line by ${len(com).toExponential(1)} m`);
    expect(err).toBeLessThan(1e-9);
    expect(len(com)).toBeLessThan(1e-5);
    console.log(`[transitions] zero-g strap-in moves the 50 t ship by ${(len(X) * 1e3).toFixed(3)} mm`);
  });

  it('hands over a residual to the harness instead of snapping', () => {
    const tr = start(DEF_SIT, STAND, SEAT);
    run(tr, v3(0, -G, 0));
    const x = v3(), v = v3();
    handoverResidual(tr, x, v);
    expect(len(x)).toBeLessThan(0.01);
    expect(len(v)).toBeLessThan(0.05);
  });

  it('under warp a transition finishes quasi-statically at its end', () => {
    const tr = start(DEF_SIT, STAND, SEAT);
    expect(stepTransition(tr, v3(0, -G, 0), 17, null)).toBe(TR_SEATED);
    const p = v3(), v = v3();
    transitionPose(tr, p, v, null);
    expect(len(v3(p.x - SEAT.x, p.y - SEAT.y, p.z - SEAT.z))).toBeLessThan(1e-12);
  });

  it('save → load mid-transition continues bit-identically', () => {
    const a = start(DEF_SIT, STAND, SEAT);
    for (let k = 0; k < 30; k++) stepTransition(a, v3(0, -G, 0), Q, null);
    const b = loadTransition(JSON.parse(JSON.stringify(saveTransition(a))));
    for (let k = 0; k < 40; k++) { stepTransition(a, v3(0, -G, 0), Q, null); stepTransition(b, v3(0, -G, 0), Q, null); }
    expect(saveTransition(b)).toEqual(saveTransition(a));
    expect(loadTransition({}).on).toBe(false);
  });
});

describe('neck, lying frame', () => {
  it('the head pitches toward the console at ≤ 250°/s without overshoot', () => {
    let p = 0, k = 0;
    const target = -0.9;
    while (p !== target && k < 1000) { const q = slewAngle(p, target, Q); expect(Math.abs(q - p)).toBeLessThanOrEqual(NECK_RATE * Q + 1e-15); p = q; k++; }
    expect(p).toBe(target);
    expect(k).toBe(Math.ceil(0.9 / (NECK_RATE * Q)));
  });

  it('lying, the body frame follows the bed: the face to the overhead, the head along the bed (the camera rolls)', () => {
    const q = bedFrame(v3(0, 0, -1), { x: 0, y: 0, z: 0, w: 1 });
    const rot = (x: number, y: number, z: number): V3 => {
      const tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
      return v3(x + q.w * tx + (q.y * tz - q.z * ty), y + q.w * ty + (q.z * tx - q.x * tz), z + q.w * tz + (q.x * ty - q.y * tx));
    };
    const face = rot(0, 0, -1), up = rot(0, 1, 0), right = rot(1, 0, 0);
    expect(face.y).toBeCloseTo(1, 12);
    expect(up.z).toBeCloseTo(-1, 12);
    expect(Math.abs(right.x)).toBeCloseTo(1, 12);
    // along the bunk's length (x), the frame rolls the other way
    const q2 = bedFrame(v3(1, 0, 0), { x: 0, y: 0, z: 0, w: 1 });
    expect(Math.hypot(q2.x, q2.y, q2.z, q2.w)).toBeCloseTo(1, 12);
  });
});

describe('posture shapes', () => {
  it('a prop bounces off the seated pilot: momentum conserved, restitution honoured, the torso takes the kick', () => {
    const caps = new Float64Array(14);
    expect(postureCapsules(POSE_SEATED, SEAT, ID, caps)).toBe(2);
    // a 0.35 kg mug flying aft at 3 m/s into the torso, chest height
    const pm = v3(-0.55, -0.2, -13.45 - 0.17 - 0.04 + 0.001), r = 0.04, n = v3(), cp = v3();
    const pen = sphereCapsule(caps, 0, pm, r, n, cp);
    expect(pen).toBeGreaterThan(0);
    const vp = v3(0, 0, 3), vb = v3();
    const P0 = 0.35 * vp.z + M * vb.z;
    const J = bodyPropImpulse(0.35, vp, M, vb, n, 0.5);
    expect(J).toBeGreaterThan(0);
    expect(0.35 * vp.z + M * vb.z).toBeCloseTo(P0, 12);
    expect(vp.z - vb.z).toBeCloseTo(-0.5 * 3, 9); // relative normal speed reversed × e
    expect(vb.z).toBeGreaterThan(0); // the torso is pushed aft, into the seat back (HarnessBody.v)
    // a throw from the seat pushes the body back the other way
    const hv = v3();
    throwReaction(hv, v3(0, 0, -0.35 * 4));
    expect(hv.z).toBeCloseTo((0.35 * 4) / M, 12);
    expect(postureCapsules(POSE_LYING, v3(-2.6, -0.25, -3.4), bedFrame(v3(0, 0, -1), { x: 0, y: 0, z: 0, w: 1 }), caps)).toBe(1);
    expect(Math.abs(caps[2] - caps[5])).toBeCloseTo(1.1, 9); // the lying capsule runs along the bed
  });
});
