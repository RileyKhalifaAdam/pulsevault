// W3-A hull flex (src/world/flex.ts): mode shape normalisation, frequency, energy decay at ζ, exactness at any step,
// the latch slam felt at the helm, thrust light-up, save/load, cost.

import { describe, expect, it } from 'vitest';
import { buildMassModel, makeMassOut, makeTankState, massProps, MP_M, tankDefsFor } from '../src/world/massProps';
import {
  FI_H, FI_M, FLEX_HZ, FLEX_ZETA, buildFlexModel, flexAccelAt, flexAddLoad, flexClear, flexDispAt, flexEnergy, flexQuiet,
  flexShape, flexStation, flexStep, loadFlexState, makeFlexIn,
} from '../src/world/flex';
import { INTERIORS } from '../src/data/interiors';
import { SHIP_LAYOUTS } from '../src/data/shipLayouts';
import { perfNow } from '../src/world/math';

const Q = 1 / 120;
const setup = () => {
  const mass = buildMassModel('wren', tankDefsFor('wren', 22500, 1500), 42900);
  const mp = massProps(mass, makeTankState(mass, 1), [], [], [], 0, makeMassOut());
  return { m: buildFlexModel(mass.zSpan, mass.dryCom.y), M: mp[MP_M] };
};

describe('W3-A hull flex', () => {
  it('free-free mode shape: ∫φ² = 1, ∫φ = 0 and ∫zφ = 0 (orthogonal to the rigid-body motions)', () => {
    const { m } = setup();
    const s = new Float64Array(2);
    let a = 0, b = 0, c = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const xi = (i + 0.5) / N, z = m.z0 + xi * m.L;
      flexShape(m, z, s, 0);
      a += (s[0] * s[0]) / N; b += s[0] / N; c += ((xi - 0.5) * s[0]) / N;
    }
    expect(a).toBeCloseTo(1, 3);
    expect(Math.abs(b)).toBeLessThan(1e-3);
    expect(Math.abs(c)).toBeLessThan(1e-3);
  });

  it('modal energy decays at the specified damping (E ∝ e^(−2ζωt)) and rings at ω√(1 − ζ²)', () => {
    const { m, M } = setup();
    const F = [0, 0, 0, 0], fi = makeFlexIn();
    fi[FI_H] = Q; fi[FI_M] = M;
    flexClear(fi);
    // a latch slam at the dorsal collar: 2 kN·s down, and 1 kN·s sideways
    const collar = SHIP_LAYOUTS.wren.dockingPort.pos;
    flexAddLoad(m, [collar.x, collar.y, collar.z, 1000, -2000, 0], fi, true);
    flexStep(F, m, fi);
    flexClear(fi);
    const E0 = flexEnergy(F, m, M);
    let crossings = 0, prev = F[0], tFirst = 0, tLast = 0;
    const T = 2;
    for (let k = 1; k <= T * 120; k++) {
      flexStep(F, m, fi);
      if (prev < 0 && F[0] >= 0) { crossings++; if (crossings === 1) tFirst = k * Q; tLast = k * Q; }
      prev = F[0];
    }
    // energies of the two modes separately (they decay at different rates)
    const w1 = 2 * Math.PI * FLEX_HZ[0], w2 = 2 * Math.PI * FLEX_HZ[1];
    const e1 = 0.5 * M * (F[1] * F[1] + w1 * w1 * F[0] * F[0]), e2 = 0.5 * M * (F[3] * F[3] + w2 * w2 * F[2] * F[2]);
    // the initial split
    const G = [0, 0, 0, 0];
    const fi2 = makeFlexIn(); fi2[FI_H] = Q; fi2[FI_M] = M; flexClear(fi2);
    flexAddLoad(m, [collar.x, collar.y, collar.z, 1000, -2000, 0], fi2, true);
    flexStep(G, m, fi2);
    const e10 = 0.5 * M * (G[1] * G[1] + w1 * w1 * G[0] * G[0]), e20 = 0.5 * M * (G[3] * G[3] + w2 * w2 * G[2] * G[2]);
    const r1 = e1 / e10, r2 = e2 / e20, p1 = Math.exp(-2 * FLEX_ZETA * w1 * T), p2 = Math.exp(-2 * FLEX_ZETA * w2 * T);
    // over whole periods the instantaneous energy ripples by ±2ζ; 2 s holds 12 and 28 periods
    console.log(`flex: E0 ${E0.toFixed(2)} J; after ${T} s mode 1 ${r1.toFixed(4)} (e^(−2ζωt) ${p1.toFixed(4)}), mode 2 ${r2.toFixed(4)} (${p2.toFixed(4)}); ${crossings} crossings`);
    expect(Math.abs(r1 / p1 - 1)).toBeLessThan(0.06);
    expect(Math.abs(r2 / p2 - 1)).toBeLessThan(0.06);
    const f = (crossings - 1) / (tLast - tFirst);
    expect(Math.abs(f - FLEX_HZ[0] * Math.sqrt(1 - FLEX_ZETA * FLEX_ZETA)) / FLEX_HZ[0]).toBeLessThan(0.02);
  });

  it('exact at any step: one 1 s step equals 120 ticks under a held load', () => {
    const { m, M } = setup();
    const A = [1e-4, 0, -2e-5, 1e-4], B = A.slice(), fi = makeFlexIn();
    fi[FI_M] = M; flexClear(fi);
    flexAddLoad(m, [4.8, -0.2, 13.5, 0, 0, -8e5], fi, false);
    fi[FI_H] = 1; flexStep(A, m, fi);
    fi[FI_H] = Q; for (let k = 0; k < 120; k++) flexStep(B, m, fi);
    for (let k = 0; k < 4; k++) expect(Math.abs(A[k] - B[k])).toBeLessThan(1e-12);
  });

  it('what the crew feels: a hard latch at the collar and a full-thrust light-up, at the helm seat', () => {
    const { m, M } = setup();
    const helm = flexStation(m, INTERIORS.wren!.helmEye.z);
    const fi = makeFlexIn(), out = new Float64Array(2), d = new Float64Array(2);
    fi[FI_H] = Q; fi[FI_M] = M;
    // latch: 0.3 m/s closing on a 67 t ship stopped by a station in ≈ 50 ms: J ≈ 2e4 N·s, here applied at the collar
    const F = [0, 0, 0, 0];
    flexClear(fi);
    const collar = SHIP_LAYOUTS.wren.dockingPort.pos;
    flexAddLoad(m, [collar.x, collar.y, collar.z, 0, -2e4, 0], fi, true);
    let peak = 0, peakD = 0;
    for (let k = 0; k < 240; k++) {
      flexStep(F, m, fi); flexClear(fi);
      flexAccelAt(F, m, fi, helm, out); flexDispAt(F, helm, d);
      peak = Math.max(peak, Math.abs(out[1])); peakD = Math.max(peakD, Math.abs(d[1]));
    }
    // light-up: both engines spool to 800 kN with τ_up 0.8 s (jets.ts): the structure follows quasi-statically
    const G = [0, 0, 0, 0];
    let peak2 = 0;
    for (let k = 0; k < 600; k++) {
      const Fz = -8e5 * (1 - Math.exp(-(k * Q) / 0.8));
      flexClear(fi);
      flexAddLoad(m, [4.8, -0.2, 13.5, 0, 0, Fz / 2], fi, false);
      flexAddLoad(m, [-4.8, -0.2, 13.5, 0, 0, Fz / 2], fi, false);
      flexStep(G, m, fi);
      flexAccelAt(G, m, fi, helm, out);
      peak2 = Math.max(peak2, Math.abs(out[1]));
    }
    console.log(`felt at the helm: latch slam ${peak.toFixed(3)} m/s² peak, ${(peakD * 1e3).toFixed(2)} mm; light-up ${peak2.toFixed(4)} m/s² peak (static deflection ${(G[0] * helm[1] * 1e3).toFixed(2)} mm)`);
    expect(peak).toBeGreaterThan(0.05);
    expect(peak2).toBeLessThan(peak);
  });

  it('save/load, quiet test and cost', () => {
    const { m, M } = setup();
    expect(loadFlexState([1, 'x', 3])).toEqual([1, 0, 3, 0]);
    const F = [1e-3, 0, 1e-3, 0], fi = makeFlexIn();
    fi[FI_M] = M; flexClear(fi); fi[FI_H] = 17;
    for (let k = 0; k < 10; k++) flexStep(F, m, fi);
    expect(flexQuiet(F)).toBe(true);
    const ld = new Float64Array([4.8, -0.2, 13.5, 100, 2000, -4e5]);
    const N = 200000;
    fi[FI_H] = Q;
    let t0 = perfNow();
    for (let k = 0; k < N; k++) { flexClear(fi); flexAddLoad(m, ld, fi, false); flexAddLoad(m, ld, fi, false); flexStep(F, m, fi); }
    t0 = perfNow();
    for (let k = 0; k < N; k++) { flexClear(fi); flexAddLoad(m, ld, fi, false); flexAddLoad(m, ld, fi, false); flexStep(F, m, fi); }
    const us = ((perfNow() - t0) * 1e3) / N;
    console.log(`cost (node): flex step with 2 loads ${us.toFixed(3)} µs`);
    expect(us).toBeLessThan(1);
  });
});
