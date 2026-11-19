// W2-E transitions (src/world/transitions.ts): sitting, standing and lying as force-limited motions — duration,
// muscle limits, momentum in zero g, the zero-g stand-up, no snaps, the neck slew, the lying frame, props against the
// seated pilot, warp, save → load.
import { describe, expect, it } from 'vitest';
import type { Quat, V3 } from '../src/core/types';
import { createReaction, consumeReaction } from '../src/world/hands';
import {
  ARM_F, bedFrame, bodyPropImpulse, createTransition, DEF_ARMS, DEF_SIT, handoverResidual, LEG_F, legsDef, loadTransition, NECK_RATE, pathSeat, pathStand,
  POSE_LYING, POSE_SEATED, postureCapsules, saveTransition, slewAngle, sphereCapsule, startTransition, stepTransition, throwReaction, TR_FREE, TR_MOVING,
  TR_SEATED, transitionJump, transitionPose, type TransitionDef, type TransitionState,
} from '../src/world/transitions';
import { shipJumpAt } from '../src/world/body';

const Q = 1 / 120, M = 80, G = 9.80665;
const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const ID: Quat = { x: 0, y: 0, z: 0, w: 1 };
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);

// the Wren's helm: standing body CoM in front of the pilot seat → seated pelvis
const STAND = v3(-0.55, -0.05, -12.7), SEAT = v3(-0.55, -0.55, -13.45);

interface Run { ticks: number; vmax: number; amax: number; jump: number; phase: number }
function run(tr: TransitionState, f: V3, maxTicks = 600): Run {
  const p = v3(), v = v3(), pp = v3(), pv = v3();
  transitionPose(tr, pp, pv, null);
  let ticks = 0, vmax = 0, amax = 0, jump = 0, ph = TR_MOVING;
  while (ticks < maxTicks) {
    ph = stepTransition(tr, f, Q, null);
    ticks++;
    transitionPose(tr, p, v, null);
    vmax = Math.max(vmax, len(v));
    amax = Math.max(amax, Math.abs(len(v) - len(pv)) / Q);
    jump = Math.max(jump, len(v3(p.x - pp.x, p.y - pp.y, p.z - pp.z)));
    pp.x = p.x; pp.y = p.y; pp.z = p.z; pv.x = v.x; pv.y = v.y; pv.z = v.z;
    if (ph !== TR_MOVING) break;
  }
  return { ticks, vmax, amax, jump, phase: ph };
}
function start(def: TransitionDef, P0: V3, P2: V3, P1?: V3): TransitionState {
  const tr = createTransition(), c = P1 ?? pathSeat(P0, P2, v3());
  startTransition(tr, def, P0, c, P2, ID, ID, null);
  return tr;
}

describe('sit and stand as motions', () => {
  it('sitting down at the helm in 1 g takes 0.6–1.2 s and never outruns the muscles', () => {
    const tr = start(DEF_SIT, STAND, SEAT), L = tr.L;
    const r = run(tr, v3(0, -G, 0));
    const t = r.ticks * Q;
    console.log(`[transitions] helm sit-down in 1 g: path ${L.toFixed(2)} m, ${t.toFixed(2)} s, peak ${r.vmax.toFixed(2)} m/s, peak |dv/dt| ${r.amax.toFixed(2)} m/s²`);
    expect(r.phase).toBe(TR_SEATED);
    expect(t).toBeGreaterThan(0.6);
    expect(t).toBeLessThan(1.2);
    // never faster than the muscles allow: |s̈| ≤ 600 N/80 kg (+ the felt load, which posture and seat carry)
    expect(r.amax).toBeLessThanOrEqual(LEG_F / M + G + 1e-6);
    expect(r.vmax).toBeLessThanOrEqual(Math.sqrt(2 * (LEG_F / M + G) * L));
    // no snap: the body never moves more than its speed allows in a tick
    expect(r.jump).toBeLessThanOrEqual(r.vmax * Q * 1.001 + 1e-9);
  });

  it('strapping in in zero g with the arms (200 N) is slower and stays within the arms', () => {
    const tr = start(DEF_ARMS, STAND, SEAT), r = run(tr, v3());
    console.log(`[transitions] zero-g strap-in (arms): ${(r.ticks * Q).toFixed(2)} s, peak ${r.vmax.toFixed(2)} m/s`);
    expect(r.phase).toBe(TR_SEATED);
    expect(r.amax).toBeLessThanOrEqual(ARM_F / M + 1e-6);
    expect(r.ticks * Q).toBeLessThan(2.5);
  });

  it('standing up in 1 g arrives standing; in zero g the legs launch the body and it keeps their velocity', () => {
    const p1 = pathStand(SEAT, STAND, v3());
    const g1 = createTransition();
    startTransition(g1, legsDef(false), SEAT, p1, STAND, ID, ID, null);
    const r1 = run(g1, v3(0, -G, 0));
    expect(r1.phase).toBe(TR_SEATED);
    const g0 = createTransition();
    startTransition(g0, legsDef(false), SEAT, p1, STAND, ID, ID, null);
    const r0 = run(g0, v3());
    const p = v3(), v = v3();
    transitionPose(g0, p, v, null);
    console.log(`[transitions] zero-g stand-up: leaves at ${len(v).toFixed(2)} m/s after ${(r0.ticks * Q).toFixed(2)} s`);
    expect(r0.phase).toBe(TR_FREE);
    expect(len(v)).toBeGreaterThan(0.3);
    expect(len(v)).toBeLessThanOrEqual(Math.sqrt(2 * (LEG_F / M) * g0.L));
    // with the boots holding the feet the legs can brake: it arrives
    const gb = createTransition();
    startTransition(gb, legsDef(true), SEAT, p1, STAND, ID, ID, null);
    expect(run(gb, v3()).phase).toBe(TR_SEATED);
  });

  it('a transition conserves momentum in zero g: the system CoM of body and a free ship stays put', () => {
    const tr = createTransition(), led = createReaction(), Ms = 5e4;
    startTransition(tr, DEF_ARMS, STAND, pathSeat(STAND, SEAT, v3()), SEAT, ID, ID, v3(0.1, 0, 0), led);
    let V = v3(), X = v3(); // the ship's CoM velocity and displacement (inertial)
    const p0 = v3(), v0 = v3(), J = v3(), L = v3();
    transitionPose(tr, p0, v0, null);
    // the body's inertial momentum before: it was moving at (0.1, 0, 0); the start took the cross part into the ship
    const Pb0 = v3(M * 0.1, 0, 0);
    const jump = v3(), p = v3(), v = v3(), free = v3(); // free: jumps the body takes once the transition has ended
    for (let k = 0; k < 400; k++) {
      if (tr.on) stepTransition(tr, v3(), Q, led);
      consumeReaction(led, J, L);
      if (!tr.on && len(J) === 0) break;
      X = v3(X.x + V.x * Q, X.y + V.y * Q, X.z + V.z * Q); // the ship coasts over the tick at its old velocity …
      const dV = v3(J.x / Ms, J.y / Ms, J.z / Ms);
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
    console.log(`[transitions] zero-g strap-in momentum error ${err.toExponential(1)} N·s (of ${len(Pb0)} N·s)`);
    expect(err).toBeLessThan(1e-9);
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
