// Landed contact: pin, slide, tip, lift-off (src/world/landed.ts).
import { describe, expect, it } from 'vitest';
import { GROUND_INVALID, GROUND_LIFT, GROUND_PIN, GROUND_SLIDE, GROUND_TIP, groundState, makeGroundIO, MU_S } from '../src/world/landed';

/** A 60 t craft on four feet at (±b, 0, ±c) relative to the CoM foot, CoM h above the plane, gravity g along −n. */
function io(b = 2, c = 5, h = 1.5, g = 9.8) {
  const o = makeGroundIO();
  const pts = [[b, 0, c], [-b, 0, c], [-b, 0, -c], [b, 0, -c]];
  pts.forEach((p, i) => o.pts.set(p, i * 3));
  o.np = 4; o.h = h;
  o.F.y = -6e4 * g;
  return o;
}

describe('landed contact', () => {
  it('pins at rest and under small thrust; the centre of pressure is under the CoM', () => {
    const o = io();
    expect(groundState(o)).toBe(GROUND_PIN);
    expect(Math.hypot(o.cop.x, o.cop.y, o.cop.z)).toBeLessThan(1e-12);
    o.F.x = 0.5 * MU_S * 6e4 * 9.8;
    expect(groundState(o)).toBe(GROUND_PIN);
    // CoP moves toward the push by h·Ft/Fn
    expect(o.cop.x).toBeCloseTo((1.5 * o.F.x) / (6e4 * 9.8), 12);
  });
  it('slides above μ_s·F_n, tips when h·Ft/Fn passes the half-width, lifts when thrust beats the weight', () => {
    const o = io(2, 5, 1.5);
    o.F.x = 0.7 * 6e4 * 9.8;
    expect(groundState(o) & GROUND_SLIDE).toBeTruthy();
    const t = io(2, 5, 4);
    t.F.x = 0.55 * 6e4 * 9.8; // 4·0.55 = 2.2 > 2
    expect(groundState(t)).toBe(GROUND_TIP);
    const m = io();
    m.M.z = -6e4 * 9.8 * 2.5; // a torque about z (roll) that shifts the CoP 2.5 m to +x
    expect(groundState(m) & GROUND_TIP).toBeTruthy();
    const l = io();
    l.F.y = 1; // net upward
    expect(groundState(l)).toBe(GROUND_LIFT);
    expect(l.Fn).toBeLessThanOrEqual(0);
  });
});

describe('landed contact: yaw and bad inputs (review)', () => {
  it('a yaw torque beyond μ_s·F_n·r_eff slides the craft; force and yaw share the friction', () => {
    const o = io(); // feet at (±2, 0, ±5): r_eff = √29 from the centre
    const rEff = Math.sqrt(29), cap = MU_S * 6e4 * 9.8;
    o.M.y = 0.9 * cap * rEff;
    expect(groundState(o)).toBe(GROUND_PIN);
    expect(o.rEff).toBeCloseTo(rEff, 12);
    o.M.y = 1e9;
    expect(groundState(o) & GROUND_SLIDE).toBeTruthy();
    // 0.7 of the friction in force and 0.75 in yaw: 0.49 + 0.5625 > 1 -> slides; each alone holds
    const b = io();
    b.F.x = 0.7 * cap; b.M.y = 0.75 * cap * rEff;
    expect(groundState(b) & GROUND_SLIDE).toBeTruthy();
    b.F.x = 0;
    expect(groundState(b) & GROUND_SLIDE).toBeFalsy();
  });
  it('NaN or ∞ inputs never release the craft; no support points tips it into the compound solver', () => {
    for (const bad of [NaN, Infinity]) {
      const o = io();
      o.F.y = bad;
      expect(groundState(o)).toBe(GROUND_INVALID);
      const p = io();
      p.pts[4] = bad;
      expect(groundState(p)).toBe(GROUND_INVALID);
    }
    const z = io();
    z.np = 0;
    expect(groundState(z)).toBe(GROUND_TIP);
  });
});
