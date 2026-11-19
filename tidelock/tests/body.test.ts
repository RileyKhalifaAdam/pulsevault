// W1-C pure core of the body (src/world/body.ts): felt acceleration from the ledger, impulse transfer, boots,
// helm torso / harness / head, lean and look, bunk closed form, gait, save → load bit-identity.
import { describe, expect, it } from 'vitest';
import type { Quat, V3 } from '../src/core/types';
import {
  applyShipJump, bootWell, clampEyeOffset, footEyeOffset, HEAD_OMEGA, HEAD_ZETA, leanTick, LEAN_MAX_STAND, settleFoot,
  BOOT_HELD, BOOT_LIFT, BOOT_MU_K, BOOT_SLIP, bootContact, bootImpulse, bootJmax, bootLastJ, bootMagnet, BUNK_DEF, clampLook,
  createFootBody, createHarnessBody, gaitEye, gaitPhase, gaitSpeedCap, G0, harnessEnergy, harnessEquilibrium, harnessForce, HARNESS_K,
  HARNESS_SLACK, HELM_DEF, helmEyeOffset, kneeLand, landedProperAccel, leanClearance, leanDir, LEAN_MAX_HELM, legForce, loadFootBody,
  loadHarnessBody, localVertical, motionFromLedger, neckEyeDelta, oscTransition, pinchLean, Q, saveFootBody, saveHarnessBody, SEAT_K,
  shipJumpAt, SOLE_BOUNCE, SOLE_CATCH, SOLE_NONE, stepFoot, stepHarnessBody, TORSO_MASS, type HarnessBody,
} from '../src/world/body';
import { createShipMotion, feltAt } from '../src/world/crew';

const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const ID: Quat = { x: 0, y: 0, z: 0, w: 1 };
const cross = (a: V3, b: V3): V3 => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

/** Step the helm body tick by tick for `seconds`, calling `each` after every tick. */
function runHelm(b: HarnessBody, f: V3, seconds: number, each?: (t: number) => void, dir: V3 | null = null): void {
  const n = Math.round(seconds / Q);
  for (let i = 0; i < n; i++) { stepHarnessBody(b, HELM_DEF, f, dir, LEAN_MAX_HELM, Q); each?.((i + 1) * Q); }
}

describe('felt acceleration from the ledger', () => {
  it('a = (fAcc/accT)/m and α = I⁻¹(τ̄ − ω × Iω)', () => {
    const m = createShipMotion();
    const I = v3(2e6, 3e6, 1.5e6), w = v3(0.01, -0.02, 0.03);
    motionFromLedger(v3(1e5 * Q, -2e5 * Q, 3e5 * Q), v3(4e4 * Q, 0, -1e4 * Q), Q, 5e4, I, w, m);
    expect(m.a.x).toBeCloseTo(2, 12); expect(m.a.y).toBeCloseTo(-4, 12); expect(m.a.z).toBeCloseTo(6, 12);
    const L = v3(I.x * w.x, I.y * w.y, I.z * w.z), c = cross(w, L);
    expect(m.alpha.x).toBeCloseTo((4e4 - c.x) / I.x, 15);
    expect(m.alpha.y).toBeCloseTo((0 - c.y) / I.y, 15);
    expect(m.alpha.z).toBeCloseTo((-1e4 - c.z) / I.z, 15);
    // nothing accumulated: no proper force, torque-free Euler term only
    motionFromLedger(v3(1, 1, 1), v3(1, 1, 1), 0, 5e4, I, w, m);
    expect(len(m.a)).toBe(0);
    expect(m.alpha.x).toBeCloseTo(-c.x / I.x, 15);
  });

  it('landed: g − Ω²R at the equator, g at the pole; local vertical and n²', () => {
    const mu = 3.986e14, R = 6.371e6, W = 7.292e-5, axis = v3(0, 1, 0), out = v3();
    landedProperAccel(mu, v3(R, 0, 0), axis, W, ID, out);
    expect(out.x).toBeCloseTo(mu / (R * R) - W * W * R, 10);
    landedProperAccel(mu, v3(0, R, 0), axis, W, ID, out);
    expect(out.y).toBeCloseTo(mu / (R * R), 10);
    const n2 = localVertical(v3(0, 0, 7e6), mu, ID, out);
    expect(out.z).toBeCloseTo(1, 15);
    expect(n2).toBeCloseTo(mu / 7e6 ** 3, 25);
  });

  it('a loose body keeps its inertial velocity and spin through a ship impulse', () => {
    const V = v3(10, -3, 7), W = v3(0.01, 0.02, -0.03), r = v3(1.2, -0.4, -9), v = v3(0.1, 0.2, -0.3), w = v3(0.5, 0, 1);
    const dv = v3(0.4, -1.1, 2), dw = v3(-0.02, 0.05, 0.01);
    const before = v3(V.x + v.x + cross(W, r).x, V.y + v.y + cross(W, r).y, V.z + v.z + cross(W, r).z);
    const spin0 = v3(W.x + w.x, W.y + w.y, W.z + w.z);
    applyShipJump(v, w, r, dv, dw);
    const W2 = v3(W.x + dw.x, W.y + dw.y, W.z + dw.z), c2 = cross(W2, r);
    expect(V.x + dv.x + v.x + c2.x).toBeCloseTo(before.x, 13);
    expect(V.y + dv.y + v.y + c2.y).toBeCloseTo(before.y, 13);
    expect(V.z + dv.z + v.z + c2.z).toBeCloseTo(before.z, 13);
    expect(W2.x + w.x).toBeCloseTo(spin0.x, 15); expect(W2.z + w.z).toBeCloseTo(spin0.z, 15);
  });
});

describe('boots', () => {
  const m = TORSO_MASS, up = v3(0, 1, 0), fMag = 2 * bootMagnet(0), fn = -G0, out = v3();
  const jmax = bootJmax(fMag, m, fn);

  it('J_max = μ_s·(F_mag + m·max(0, −f_n))·Q; the magnets fall off as (1 + g/g₀)⁻²', () => {
    expect(jmax).toBeCloseTo(0.7 * (400 + m * G0) * Q, 12);
    expect(bootMagnet(0.005)).toBeCloseTo(50, 12);
    expect(bootJmax(fMag, m, +3)).toBeCloseTo(0.7 * 400 * Q, 12); // felt pulling off the deck adds no grip
  });

  it('a gripped pilot holds just below J_max and slips just above it', () => {
    const below = v3(-(jmax / m) * (1 - 1e-9), 0, 0);
    expect(bootImpulse(m, below, up, fMag, fn, Q, out)).toBe(BOOT_HELD);
    expect(len(out)).toBeLessThan(1e-12);
    expect(bootLastJ.x).toBeCloseTo(jmax * (1 - 1e-9), 12);
    const above = v3(-(jmax / m) * (1 + 1e-9), 0, 0);
    expect(bootImpulse(m, above, up, fMag, fn, Q, out)).toBe(BOOT_SLIP);
    // it keeps what kinetic friction did not take: momentum of body + ship is conserved (the ship gets −J)
    const jk = BOOT_MU_K * (fMag + m * G0) * Q;
    expect(bootLastJ.x).toBeCloseTo(jk, 12);
    expect(out.x).toBeCloseTo(above.x + jk / m, 14);
    expect(m * out.x - bootLastJ.x).toBeCloseTo(m * above.x, 12);
  });

  it('a deck that drops away faster than the magnets can pull lifts the soles; one pushing up never does', () => {
    expect(bootImpulse(m, v3(0, 2, 0), up, fMag, fn, Q, out)).toBe(BOOT_LIFT);
    expect(out.y).toBeCloseTo(2 - ((fMag + m * G0) * Q) / m, 12);
    expect(bootImpulse(m, v3(0.01, -2, 0), up, fMag, fn, Q, out)).toBe(BOOT_HELD); // pressed hard: friction holds
    expect(len(out)).toBeLessThan(1e-12);
  });

  it('soles catch below 0.5 m/s within 2 mm, bounce above it; traction limits the legs; speed caps', () => {
    expect(bootContact(0.001, -0.4)).toBe(SOLE_CATCH);
    expect(bootContact(0, -0.8)).toBe(SOLE_BOUNCE);
    expect(bootContact(0.01, -0.1)).toBe(SOLE_NONE);
    // D5: soles leaving the deck are caught only when they cannot climb out of the magnet well (2 J for two boots)
    expect(bootWell(0)).toBeCloseTo(2, 12);
    expect(bootContact(0, 1.5)).toBe(SOLE_NONE); // a jump at JUMP_SPEED: 90 J ≫ 2 J
    expect(bootContact(0.001, 3)).toBe(SOLE_NONE);
    expect(bootContact(0, 0.2)).toBe(SOLE_CATCH); // ½·80·0.04 = 1.6 J < 2 J: falls back onto the magnets
    expect(bootContact(0, 0.23)).toBe(SOLE_NONE); // 2.1 J > 2 J: escapes
    expect(bootContact(0.001, 0.21)).toBe(SOLE_NONE); // the well is shallower 1 mm up (1.67 J < 1.76 J)
    expect(bootContact(0, 0.21)).toBe(SOLE_CATCH);
    const F = v3();
    expect(legForce(m, 8, 0, 0, 0, 100, F)).toBe(true);
    expect(Math.hypot(F.x, F.z)).toBeCloseTo(100, 10);
    expect(legForce(m, 1, 0, 0.5, 0, 1e4, F)).toBe(false);
    expect(F.x).toBeCloseTo(40, 12);
    expect(gaitSpeedCap(0)).toBe(1.1); expect(gaitSpeedCap(0.4 * G0)).toBe(1.4); expect(gaitSpeedCap(G0)).toBe(2.2);
  });

  it('knee landing settles; gait eye bob is ±2 cm at 1 g and floored at 0.3 in free fall', () => {
    const fb = createFootBody();
    kneeLand(fb, 0.5);
    let peak = 0;
    for (let i = 0; i < 120; i++) { stepFoot(fb, v3()); peak = Math.max(peak, fb.kx); }
    expect(peak).toBeGreaterThan(0.01); expect(peak).toBeLessThan(0.03);
    expect(Math.abs(fb.kx)).toBeLessThan(1e-4);
    let ph = 0, maxY = 0, maxX = 0, maxY0 = 0;
    const e = v3();
    for (let i = 0; i < 240; i++) {
      ph = gaitPhase(ph, 1.4, Q);
      maxY = Math.max(maxY, gaitEye(ph, G0, 1.4, e).y); maxX = Math.max(maxX, e.x);
      maxY0 = Math.max(maxY0, gaitEye(ph, 0, 1.4, e).y);
    }
    expect(maxY).toBeCloseTo(0.02, 3); expect(maxX).toBeCloseTo(0.012, 3); expect(maxY0).toBeCloseTo(0.006, 3);
  });
});

describe('helm torso, harness and head', () => {
  it('the exact transition matches a fine RK4 of the damped oscillator', () => {
    const P = new Float64Array(4), w = 27.386, z = 0.3, h = 0.05;
    oscTransition(P, 0, w, z, h);
    let x = 0.01, v = -0.3;
    const N = 20000, dt = h / N;
    const f = (x1: number, v1: number): [number, number] => [v1, -w * w * x1 - 2 * z * w * v1];
    for (let i = 0; i < N; i++) {
      const k1 = f(x, v), k2 = f(x + 0.5 * dt * k1[0], v + 0.5 * dt * k1[1]), k3 = f(x + 0.5 * dt * k2[0], v + 0.5 * dt * k2[1]), k4 = f(x + dt * k3[0], v + dt * k3[1]);
      x += (dt / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]); v += (dt / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
    }
    expect(P[0] * 0.01 + P[1] * -0.3).toBeCloseTo(x, 12);
    expect(P[2] * 0.01 + P[3] * -0.3).toBeCloseTo(v, 11);
  });

  it('a steady 12 m/s² sinks the torso a/ω² into the seat back (within 5%) and the eye only translates', () => {
    const b = createHarnessBody();
    runHelm(b, v3(0, 0, 12), 2);
    const want = 12 / (SEAT_K / TORSO_MASS);
    expect(Math.abs(b.x.z - want) / want).toBeLessThan(0.05);
    expect(want).toBeCloseTo(0.016, 3);
    const e = helmEyeOffset(b, null, v3());
    expect(e.z).toBeCloseTo(b.x.z, 6); // the head lag has settled on the torso
  });

  it('a 2 m/s capture impulse: torso peaks ~6 cm, settles in < 0.5 s; the harness holds the pilot (head: see PLAN BAND)', () => {
    for (const dir of [1, -1]) {
      const b = createHarnessBody();
      b.v.z += 2 * dir; // shipJumpAt for a 2 m/s Δv along ∓Z
      let peak = 0, peakHead = 0, peakLag = 0, impulse = 0, maxF = 0, settled = Infinity;
      const F = v3();
      // integrate the seat + harness force with the trapezoid rule on the tick grid
      let fPrev = harnessForce(b, HELM_DEF, F).z;
      runHelm(b, v3(), 1, (t) => {
        peak = Math.max(peak, Math.abs(b.x.z)); peakHead = Math.max(peakHead, Math.abs(b.x.z + b.hx.z)); peakLag = Math.max(peakLag, Math.abs(b.hx.z));
        const f = harnessForce(b, HELM_DEF, F).z;
        impulse += 0.5 * (f + fPrev) * Q; fPrev = f;
        maxF = Math.max(maxF, Math.abs(f));
        const off = dir > 0 ? b.x.z : Math.max(0, -HARNESS_SLACK - b.x.z);
        if (settled === Infinity && t > 0.05 && Math.abs(b.v.z) < 0.02 && off < 0.002) settled = t;
      });
      expect(peak).toBeGreaterThan(0.045); expect(peak).toBeLessThan(0.085);
      // measured (not re-banded): the plan's 8–10 cm head figure is checked, and fails, in the it.fails below
      expect(peakHead).toBeGreaterThan(peak);
      expect(settled).toBeLessThan(0.5);
      // all the momentum went through the seat / harness (the body ends at rest relative to the ship); the
      // tick-grid quadrature of ∫F dt has the same sign and size (it is coarse: the contact lasts ~12 ticks)
      expect(Math.abs(b.v.z) * TORSO_MASS).toBeLessThan(0.005 * TORSO_MASS * 2);
      expect(Math.sign(impulse)).toBe(-dir);
      expect(Math.abs(impulse) / (TORSO_MASS * 2)).toBeGreaterThan(0.85);
      // not knocked loose: the webbing load stays far below a 13 kN restraint rating, the torso inside 10 cm
      expect(maxF).toBeLessThan(13e3);
      console.log(`[body] 2 m/s capture ${dir > 0 ? 'into seat back' : 'into harness'}: torso ${(peak * 100).toFixed(1)} cm, head ${(peakHead * 100).toFixed(1)} cm (lag ${(peakLag * 100).toFixed(1)}), settled ${settled.toFixed(3)} s, peak load ${(maxF / 1000).toFixed(2)} kN, ∫F ${impulse.toFixed(2)} N·s`);
    }
  });

  it('the plan\'s head model on a rigid stop: 2 m/s → a head lag of v/ω·e^(−ζφ/√(1−ζ²)) = 7.94 cm', () => {
    // a 2 m/s stop within one tick (240 m/s² for Q) of the body the head rides on (stepFoot's head lag)
    const fb = createFootBody();
    settleFoot(fb);
    let peak = 0;
    stepFoot(fb, v3(0, 0, 240));
    for (let i = 0; i < 120; i++) { stepFoot(fb, v3()); peak = Math.max(peak, Math.abs(fb.hx.z)); }
    const zr = Math.sqrt(1 - HEAD_ZETA * HEAD_ZETA), ana = (2 / HEAD_OMEGA) * Math.exp((-HEAD_ZETA / zr) * Math.atan2(zr, HEAD_ZETA));
    console.log(`[body] rigid 2 m/s stop: head lag ${(peak * 100).toFixed(2)} cm (analytic impulse ${(ana * 100).toFixed(2)} cm)`);
    expect(ana).toBeCloseTo(0.0794, 4);
    expect(Math.abs(peak - ana)).toBeLessThan(0.004); // the 1-tick ramp instead of an ideal impulse
  });

  // PLAN INCONSISTENCY (owner decision, D9): SIMULATION.md W1-C item 2 says a 2 m/s capture gives "8–10 cm on the
  // head". With the plan's own parameters the head lags the torso 10.6 cm (harness rebound) and reaches 12–14 cm
  // from the seat. Either the head ω (2π·2 Hz) / ζ (0.6) or the figure changes; until then this check stays red
  // (it.fails), so the gap is visible in every run instead of re-banded.
  it.fails('PLAN BAND: a 2 m/s capture keeps the head within 8–10 cm (lag on the torso and seat-relative)', () => {
    for (const dir of [1, -1]) {
      const b = createHarnessBody();
      b.v.z += 2 * dir;
      let peakHead = 0, peakLag = 0;
      runHelm(b, v3(), 1, () => { peakHead = Math.max(peakHead, Math.abs(b.x.z + b.hx.z)); peakLag = Math.max(peakLag, Math.abs(b.hx.z)); });
      expect(peakLag).toBeLessThanOrEqual(0.1);
      expect(peakHead).toBeLessThanOrEqual(0.1);
    }
  });

  it('energy never grows without a load: a rattle in the slack loses energy (contacts and bracing)', () => {
    const b = createHarnessBody();
    b.v.x = 0.4; b.v.y = -0.3; b.v.z = 0.2;
    const E0 = 0.5 * TORSO_MASS * (0.16 + 0.09 + 0.04);
    let Emax = 0, E = 0;
    runHelm(b, v3(), 2, () => {
      E = 0.5 * TORSO_MASS * (b.v.x ** 2 + b.v.y ** 2 + b.v.z ** 2) + harnessEnergy(b, HELM_DEF);
      Emax = Math.max(Emax, E);
    });
    expect(Emax).toBeLessThan(E0 * 1.002);
    expect(E).toBeLessThan(E0 * 0.05);
  });

  it('aerobrake: a 20 m/s² drag ledger sinks the pilot a/ω² into the harness', () => {
    const m = createShipMotion(), ship = 5e4;
    motionFromLedger(v3(0, 0, ship * 20 * Q), v3(), Q, ship, v3(1e6, 1e6, 1e6), v3(), m); // drag pushes the ship aft (+Z)
    const seat = v3(-0.55, -0.4, -13.45), f = feltAt(m, seat.x, seat.y, seat.z, 0, 0, 0, v3());
    expect(f.z).toBeCloseTo(-20, 12);
    const b = createHarnessBody();
    runHelm(b, f, 2);
    expect(b.x.z).toBeCloseTo(-HARNESS_SLACK - 20 / (HARNESS_K / TORSO_MASS), 4);
  });

  it('the bunk is stable at h = 0.1 s (closed form) and continuous with the 1× motion', () => {
    const b = createHarnessBody(), f = v3(0.3, -2, 0.1);
    for (let i = 0; i < 2000; i++) stepHarnessBody(b, BUNK_DEF, f, null, 0, Q);
    const settled = saveHarnessBody(b);
    for (let i = 0; i < 1000; i++) stepHarnessBody(b, BUNK_DEF, f, null, 0, 0.1);
    expect(Math.abs(b.x.x - settled.x.x)).toBeLessThan(1e-9);
    expect(Math.abs(b.x.y - settled.x.y)).toBeLessThan(1e-9);
    expect(Math.abs(b.x.z - settled.x.z)).toBeLessThan(1e-9);
    // a load change while asleep goes straight to the new equilibrium, no oscillation, no blow-up
    stepHarnessBody(b, BUNK_DEF, v3(0, 5, 0), null, 0, 17.07);
    expect(b.x.y).toBeCloseTo(0.02 + 5 / (8e3 / TORSO_MASS), 12);
    // a non-standard short step (h = 1/60 ≤ 0.02) stays exact and bounded
    const c = createHarnessBody();
    c.v.y = -1;
    for (let i = 0; i < 600; i++) stepHarnessBody(c, BUNK_DEF, v3(), null, 0, 1 / 60);
    const E = 0.5 * TORSO_MASS * (c.v.x ** 2 + c.v.y ** 2 + c.v.z ** 2) + harnessEnergy(c, BUNK_DEF);
    expect(E).toBeLessThan(1e-4 * 0.5 * TORSO_MASS); // 99.99 % of the 40 J gone (it rattles freely in the slack)
    expect(c.x.y).toBeGreaterThan(-0.06);
  });

  it('a non-finite felt load for one tick (a bad ledger) does not poison the body', () => {
    const b = createHarnessBody(), d = leanDir(0, true, v3());
    b.leanT = 0.05;
    runHelm(b, v3(0, 0, 3), 0.5, undefined, d);
    stepHarnessBody(b, HELM_DEF, v3(NaN, Infinity, 0), d, LEAN_MAX_HELM, Q);
    runHelm(b, v3(0, 0, 3), 1, undefined, d);
    const e = helmEyeOffset(b, d, v3());
    expect(Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.z)).toBe(true);
    harnessEquilibrium(b, BUNK_DEF, v3(NaN, 0, 0), d, LEAN_MAX_HELM);
    expect(Number.isFinite(b.x.x)).toBe(true);
  });

  it('identical paths at 30 and 60 fps (the body steps on the tick, not the frame)', () => {
    const a = createHarnessBody(), b = createHarnessBody(), f = v3(0.2, -1, 3);
    a.v.z = 1; b.v.z = 1;
    for (let frame = 0; frame < 60; frame++) for (let k = 0; k < 2; k++) stepHarnessBody(a, HELM_DEF, f, null, 0, Q);
    for (let frame = 0; frame < 30; frame++) for (let k = 0; k < 4; k++) stepHarnessBody(b, HELM_DEF, f, null, 0, Q);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('lean, look and the eye', () => {
  it('pinch is lean: one doubling of finger spread is the whole range; pinching in leans back', () => {
    expect(pinchLean(0, 2, LEAN_MAX_HELM)).toBeCloseTo(LEAN_MAX_HELM, 15);
    expect(pinchLean(0, Math.SQRT2, LEAN_MAX_HELM)).toBeCloseTo(LEAN_MAX_HELM / 2, 15);
    expect(pinchLean(0.06, 0.5, LEAN_MAX_HELM)).toBe(0);
    expect(pinchLean(0.06, 1, LEAN_MAX_HELM)).toBe(0.06);
  });

  it('the lean PD reaches its target without overshoot, holds against 12 m/s², sags against 20 m/s²', () => {
    const d = leanDir(0, true, v3());
    const b = createHarnessBody();
    b.leanT = 0.1;
    let over = 0;
    runHelm(b, v3(), 2.5, () => { over = Math.max(over, b.lean - 0.1); }, d);
    expect(b.lean).toBeCloseTo(0.1, 4);
    expect(over).toBeLessThan(1e-9);
    const c = createHarnessBody();
    c.leanT = 0.1;
    runHelm(c, v3(0, 0, 12), 3, undefined, d);
    expect(c.lean).toBeCloseTo(0.1, 4);
    const e = createHarnessBody();
    e.leanT = 0.1;
    runHelm(e, v3(0, 0, 20), 3, undefined, d);
    expect(e.lean).toBe(0);
    const eye = helmEyeOffset(c, d, v3());
    expect(eye.z - c.x.z).toBeLessThan(-0.09); // leaning brings the eye forward (−Z) of the sunk torso, with a small drop
    expect(eye.y).toBeLessThan(0);
  });

  it('the head sphere stops at glass; the eye turns about the neck; look limits', () => {
    const boxes = Float64Array.from([-1, -1, -0.5, 1, 1, -0.3]); // a pane 0.3 m ahead
    const t = leanClearance(boxes, 1, v3(0, 0, 0), v3(0, 0, -1), 0.3);
    expect(t).toBeCloseTo(0.2, 3);
    expect(leanClearance(boxes, 1, v3(0, 0, 0), v3(0, 0, 1), 0.3)).toBe(0.3);
    // D8: a pane 5 cm ahead of the eye (inside the 0.10 m head sphere): no lean into it, free to lean away
    const near = Float64Array.from([-1, -1, -0.3, 1, 1, -0.05]);
    expect(leanClearance(near, 1, v3(), v3(0, 0, -1), 0.12)).toBe(0);
    expect(leanClearance(near, 1, v3(), v3(0, 0, 1), 0.12)).toBe(0.12);
    expect(leanClearance(near, 1, v3(), v3(1, 0, 0), 0.12)).toBe(0.12); // sliding along it does not go deeper
    // the whole eye offset (torso + head lag + lean) is clamped by the same sphere test: a 14 cm capture swing toward
    // a pane 15 cm ahead stops 5 cm out
    const off = clampEyeOffset(boxes, 1, v3(0, 0, -0.15), v3(0, 0, -0.14));
    expect(off.z).toBeCloseTo(-0.05 + 1e-4, 6);
    const far = clampEyeOffset(boxes, 1, v3(0, 0, 0.5), v3(0, 0, -0.14));
    expect(far.z).toBe(-0.14);
    const o = v3();
    neckEyeDelta(0, 0, o);
    expect(len(o)).toBeLessThan(1e-15);
    neckEyeDelta(Math.PI / 2, 0, o); // looking left: the eye swings to −X
    expect(o.x).toBeCloseTo(-0.09, 12); expect(o.z).toBeCloseTo(0.09, 12);
    neckEyeDelta(0, Math.PI / 2, o); // looking up: the eye rises and comes back over the pivot
    expect(o.y).toBeCloseTo(0.09 - 0.07, 12); expect(o.z).toBeCloseTo(0.07 + 0.09, 12);
    const L = { yaw: 0, pitch: 0 };
    clampLook(3, 2, true, L);
    expect(L.yaw).toBeCloseTo((115 * Math.PI) / 180, 12); expect(L.pitch).toBeCloseTo(Math.PI / 3, 12);
    clampLook(3, -2, false, L);
    expect(L.yaw).toBe(3); expect(L.pitch).toBeCloseTo((-70 * Math.PI) / 180, 12);
  });
});

describe('standing lean (D7)', () => {
  it('on foot the lean reaches LEAN_MAX_STAND = 0.30 m, moves the eye, saves and loads', () => {
    const fb = createFootBody(), d = leanDir(0.4, false, v3()), g = v3(0, -G0, 0);
    fb.leanT = 0.5; // the pinch asks beyond the limit
    let over = 0;
    for (let i = 0; i < 360; i++) { stepFoot(fb, v3()); leanTick(fb, g, d, LEAN_MAX_STAND, Q); over = Math.max(over, fb.lean - LEAN_MAX_STAND); }
    expect(fb.lean).toBeCloseTo(LEAN_MAX_STAND, 6);
    expect(over).toBeLessThanOrEqual(0);
    const e = footEyeOffset(fb, d, null, v3());
    expect(e.x * d.x + e.z * d.z).toBeCloseTo(LEAN_MAX_STAND, 6);
    expect(e.y).toBeLessThan(0); // the flexed torso drops the eye
    fb.leanT = 0.1; // pinch back
    for (let i = 0; i < 5; i++) leanTick(fb, g, d, LEAN_MAX_STAND, Q);
    const c = loadFootBody(JSON.parse(JSON.stringify(saveFootBody(fb))));
    for (let i = 0; i < 200; i++) { leanTick(fb, g, d, LEAN_MAX_STAND, Q); leanTick(c, g, d, LEAN_MAX_STAND, Q); }
    expect(JSON.stringify(c)).toBe(JSON.stringify(fb));
    expect(fb.lean).toBeCloseTo(0.1, 3);
    // a clearance of 0 (a wall in the way) pulls the lean back to 0; warp steps are the equilibrium
    for (let i = 0; i < 240; i++) leanTick(fb, g, d, 0, Q);
    expect(fb.lean).toBe(0);
    fb.leanT = 0.2; leanTick(fb, g, d, LEAN_MAX_STAND, 5);
    expect(fb.lean).toBe(0.2);
    expect(loadFootBody({ kx: 0 }).lean).toBe(0);
  });
});

describe('save → load', () => {
  it('helm, bunk and foot bodies continue bit-identically; old saves get defaults', () => {
    const a = createHarnessBody(), f = v3(0.1, -3, 7);
    a.v.z = 1.7; a.leanT = 0.08;
    const d = leanDir(0.3, true, v3());
    for (let i = 0; i < 37; i++) stepHarnessBody(a, HELM_DEF, f, d, LEAN_MAX_HELM, Q);
    const b = loadHarnessBody(JSON.parse(JSON.stringify(saveHarnessBody(a))));
    for (let i = 0; i < 200; i++) { stepHarnessBody(a, HELM_DEF, f, d, LEAN_MAX_HELM, Q); stepHarnessBody(b, HELM_DEF, f, d, LEAN_MAX_HELM, Q); }
    for (const k of ['x', 'v', 'hx', 'hv'] as const) for (const c of ['x', 'y', 'z'] as const) expect(Object.is(a[k][c], b[k][c])).toBe(true);
    expect(Object.is(a.lean, b.lean) && Object.is(a.leanV, b.leanV)).toBe(true);
    const fa = createFootBody();
    kneeLand(fa, 0.4);
    for (let i = 0; i < 5; i++) stepFoot(fa, v3(1, 0, 0));
    const fb = loadFootBody(JSON.parse(JSON.stringify(saveFootBody(fa))));
    for (let i = 0; i < 50; i++) { stepFoot(fa, v3(-2, 0, 0)); stepFoot(fb, v3(-2, 0, 0)); }
    expect(JSON.stringify(fa)).toBe(JSON.stringify(fb));
    expect(loadHarnessBody(undefined)).toEqual(createHarnessBody());
    expect(loadFootBody({ kx: 'junk' })).toEqual(createFootBody());
    // the equilibrium path too
    harnessEquilibrium(a, BUNK_DEF, f, null, 0);
    expect(loadHarnessBody(JSON.parse(JSON.stringify(a)))).toEqual(a);
  });

  it('shipJumpAt is −Δv − Δω × r', () => {
    const o = shipJumpAt(v3(1, 2, 3), v3(0.1, 0, 0), v3(0, 0, 0.5), v3());
    expect(o.x).toBeCloseTo(-0.1 + 0.5 * 2, 15); expect(o.y).toBeCloseTo(-0.5 * 1, 15); expect(o.z).toBe(-0);
  });
});

describe('cost (node)', () => {
  it('µs per call', () => {
    const b = createHarnessBody(), f = v3(0.1, -2, 3), d = leanDir(0, true, v3());
    b.leanT = 0.05;
    const N = 200000;
    for (let i = 0; i < 20000; i++) stepHarnessBody(b, HELM_DEF, f, d, LEAN_MAX_HELM, Q);
    let t0 = performance.now();
    for (let i = 0; i < N; i++) { if ((i & 1023) === 0) b.v.z += 0.5; stepHarnessBody(b, HELM_DEF, f, d, LEAN_MAX_HELM, Q); }
    const helm = ((performance.now() - t0) * 1000) / N;
    const fb = createFootBody(), a = v3(0.3, 0, 0);
    t0 = performance.now();
    for (let i = 0; i < N; i++) stepFoot(fb, a);
    const foot = ((performance.now() - t0) * 1000) / N;
    const o = v3(), up = v3(0, 1, 0), j = v3(0.01, 0, 0);
    t0 = performance.now();
    for (let i = 0; i < N; i++) bootImpulse(80, j, up, 400, -9.8, Q, o);
    const boot = ((performance.now() - t0) * 1000) / N;
    console.log(`[body] µs/call (node): stepHarnessBody(tick, 4 sub-steps) ${helm.toFixed(3)}, stepFoot ${foot.toFixed(3)}, bootImpulse ${boot.toFixed(3)}`);
    expect(helm).toBeLessThan(5);
  });
});
