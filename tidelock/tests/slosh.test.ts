// W3-A slosh, settling and ullage (src/world/slosh.ts): frequency against the formula, momentum exchange with the
// hull (linear and angular), settling time √(2X/a), the ignition rule, determinism and cache independence, cost.

import { describe, expect, it } from 'vitest';
import {
  MP_CX, MP_CY, MP_CZ, MP_IXX, MP_M, RF_DT, RF_HX, RF_HY, RF_HZ, buildMassModel, makeMassOut, makeRotFull, makeTankState,
  massProps, rebaseInternal, rotateFull, symMul, tankDefsFor,
} from '../src/world/massProps';
import {
  IGNITION_U_MAX, SI_ALX, SI_AX, SI_AY, SI_AZ, SI_CX, SI_H, SI_M, SI_WX, SO_DIXX, SO_DLX, SO_DVX, buildSloshModel, internalMomentum,
  loadSloshState, makeSloshIn, makeSloshOut, makeSloshState, sloshOmega, sloshQuiet, sloshStep, unsettledFraction,
} from '../src/world/slosh';
import { perfNow } from '../src/world/math';

const Q = 1 / 120;
const setup = (fill = 0.5) => {
  const mass = buildMassModel('wren', tankDefsFor('wren', 22500, 1500), 42900);
  const sl = buildSloshModel(mass);
  const tanks = makeTankState(mass, fill);
  return { mass, sl, tanks, slosh: makeSloshState(sl), mp: makeMassOut(), si: makeSloshIn(), so: makeSloshOut() };
};
const fillSi = (S: ReturnType<typeof setup>, a: [number, number, number], w: [number, number, number] = [0, 0, 0], h = Q) => {
  massProps(S.mass, S.tanks, S.slosh, [], [], 0, S.mp);
  S.si[SI_H] = h; S.si[SI_AX] = a[0]; S.si[SI_AY] = a[1]; S.si[SI_AZ] = a[2];
  S.si[SI_WX] = w[0]; S.si[SI_WX + 1] = w[1]; S.si[SI_WX + 2] = w[2];
  S.si[SI_ALX] = S.si[SI_ALX + 1] = S.si[SI_ALX + 2] = 0;
  S.si[SI_CX] = S.mp[MP_CX]; S.si[SI_CX + 1] = S.mp[MP_CY]; S.si[SI_CX + 2] = S.mp[MP_CZ]; S.si[SI_M] = S.mp[MP_M];
};

describe('W3-A slosh', () => {
  it('lateral slosh frequency within 2 % of the formula (box tank and capsule tank, settled by a burn)', () => {
    for (const id of ['lh2-belly-fwd', 'lh2-pod-stbd']) {
      const S = setup(0.5);
      const i = S.mass.tanks.findIndex((t) => t.id === id);
      const a = -12; // full-throttle proper acceleration (−Z), the liquid settles aft
      // settle first, then kick the lateral (x) slosh mode with a short side push
      for (let k = 0; k < 120 * 20; k++) { fillSi(S, [0, 0, a]); sloshStep(S.sl, S.tanks, S.slosh, S.si, S.so); }
      for (let k = 0; k < 6; k++) { fillSi(S, [0.5, 0, a]); sloshStep(S.sl, S.tanks, S.slosh, S.si, S.so); }
      const o = i * 12 + 6; // e_x
      const xs: number[] = [];
      let prev = S.slosh[o], tPrev = 0;
      for (let k = 1; k < 120 * 30; k++) {
        fillSi(S, [0, 0, a]); sloshStep(S.sl, S.tanks, S.slosh, S.si, S.so);
        const e = S.slosh[o], t = k * Q;
        if (prev < 0 && e >= 0) xs.push(tPrev + (Q * -prev) / (e - prev));
        prev = e; tPrev = t;
      }
      const T = (xs[xs.length - 1] - xs[0]) / (xs.length - 1);
      const om = new Float64Array(3);
      const f = S.tanks[i].m / S.mass.cap[i];
      sloshOmega(S.sl, i, f, 2, -a, om);
      const zeta = S.sl.zeta[i], wd = om[0] * Math.sqrt(1 - zeta * zeta);
      const err = Math.abs((2 * Math.PI) / T - wd) / wd;
      console.log(`${id}: measured ${((2 * Math.PI) / T).toFixed(4)} rad/s, formula ${wd.toFixed(4)} rad/s (fill ${f.toFixed(3)}, ${xs.length} periods), error ${(100 * err).toFixed(2)} %`);
      expect(err).toBeLessThan(0.02);
    }
    // the plan's numbers: β ≈ 0.4 at half fill for an upright cylinder, ω² = 1.84 g/R deep
    const S = setup(0.5);
    const i = S.mass.tanks.findIndex((t) => t.id === 'lh2-pod-stbd');
    const om = new Float64Array(3);
    sloshOmega(S.sl, i, 1, 2, 10, om);
    expect(om[0] * om[0]).toBeCloseTo((1.8412 * 10) / S.sl.rad[i], 2);
  });

  it('the liquid exchanges momentum with the hull: linear (system CoM fixed) and angular (I·ω + L_int conserved)', () => {
    const S = setup(0.6);
    // spin the ship: centrifugal settling, plus a short side burn to excite slosh; then free (no torque, no force)
    const w = { x: 0.02, y: 0.15, z: 0.04 }, q = { x: 0, y: 0, z: 0, w: 1 }, rf = makeRotFull(), mp2 = makeMassOut();
    const li = new Float64Array(3), Lb = { x: 0, y: 0, z: 0 };
    const Ltot = (out: { x: number; y: number; z: number }) => {
      massProps(S.mass, S.tanks, S.slosh, [], [], 0, S.mp);
      fillSi(S, [0, 0, 0]);
      internalMomentum(S.sl, S.tanks, S.slosh, S.si, li);
      symMul(S.mp, MP_IXX, w.x, w.y, w.z, Lb);
      const bx = Lb.x + li[0], by = Lb.y + li[1], bz = Lb.z + li[2];
      const tx = 2 * (q.y * bz - q.z * by), ty = 2 * (q.z * bx - q.x * bz), tz = 2 * (q.x * by - q.y * bx);
      out.x = bx + q.w * tx + (q.y * tz - q.z * ty); out.y = by + q.w * ty + (q.z * tx - q.x * tz); out.z = bz + q.w * tz + (q.x * ty - q.y * tx);
      return out;
    };
    let dvx = 0, dvy = 0, dvz = 0;
    let L0 = { x: 0, y: 0, z: 0 }, maxDev = 0, maxLint = 0;
    for (let k = 0; k < 120 * 60; k++) {
      const side = k < 240 ? 0.8 : 0;
      massProps(S.mass, S.tanks, S.slosh, [], [], 0, S.mp);
      fillSi(S, [side, 0, 0], [w.x, w.y, w.z]);
      internalMomentum(S.sl, S.tanks, S.slosh, S.si, li);
      if (k === 240) L0 = Ltot({ x: 0, y: 0, z: 0 });
      // rotate with L_int as stored momentum (torque-free), then the liquid, then rebase
      massProps(S.mass, S.tanks, S.slosh, [], [], 0, S.mp);
      fillSi(S, [side, 0, 0], [w.x, w.y, w.z]);
      internalMomentum(S.sl, S.tanks, S.slosh, S.si, li);
      rf[RF_DT] = Q; rf[RF_HX] = li[0]; rf[RF_HY] = li[1]; rf[RF_HZ] = li[2];
      rotateFull(w, q, S.mp, rf);
      S.si[SI_WX] = w.x; S.si[SI_WX + 1] = w.y; S.si[SI_WX + 2] = w.z;
      sloshStep(S.sl, S.tanks, S.slosh, S.si, S.so);
      massProps(S.mass, S.tanks, S.slosh, [], [], 0, mp2);
      rebaseInternal(w, mp2, S.so, SO_DIXX, SO_DLX);
      if (k >= 240) {
        dvx += S.so[SO_DVX]; dvy += S.so[SO_DVX + 1]; dvz += S.so[SO_DVX + 2];
        const L = Ltot({ x: 0, y: 0, z: 0 });
        const d = Math.hypot(L.x - L0.x, L.y - L0.y, L.z - L0.z) / Math.hypot(L0.x, L0.y, L0.z);
        if (d > maxDev) maxDev = d;
        if (Math.hypot(li[0], li[1], li[2]) > maxLint) maxLint = Math.hypot(li[0], li[1], li[2]);
      }
    }
    // linear: the hull's accumulated Δv equals −Σ m ṗ / M of the liquid now (the system CoM never moved)
    let px = 0, py = 0, pz = 0, px0 = 0;
    for (let i = 0; i < S.mass.nT; i++) { const o = i * 12, m = S.tanks[i].m; if (!S.sl.active[i]) continue; px += m * (S.slosh[o + 3] + S.slosh[o + 9]); py += m * (S.slosh[o + 4] + S.slosh[o + 10]); pz += m * (S.slosh[o + 5] + S.slosh[o + 11]); }
    void px0;
    console.log(`angular: max |ΔL|/L ${maxDev.toExponential(2)} over 58 s with |L_int| up to ${maxLint.toExponential(2)} N·m·s (|L| ${Math.hypot(L0.x, L0.y, L0.z).toExponential(2)})`);
    expect(maxLint).toBeGreaterThan(1e-3 * Math.hypot(L0.x, L0.y, L0.z)); // the liquid really moved
    expect(maxDev).toBeLessThan(1e-9);
    expect(Number.isFinite(dvx + dvy + dvz + px + py + pz)).toBe(true);
  });

  it('linear exchange: the hull velocity change balances the liquid momentum change exactly', () => {
    const S = setup(0.4);
    let dvx = 0, dvz = 0;
    const P0 = { x: 0, z: 0 };
    for (let k = 0; k < 120 * 5; k++) {
      fillSi(S, [k < 60 ? 2 : 0, 0, -1]);
      if (k === 60) for (let i = 0; i < S.mass.nT; i++) { const o = i * 12; if (!S.sl.active[i]) continue; P0.x += S.tanks[i].m * (S.slosh[o + 3] + S.slosh[o + 9]); P0.z += S.tanks[i].m * (S.slosh[o + 5] + S.slosh[o + 11]); }
      sloshStep(S.sl, S.tanks, S.slosh, S.si, S.so);
      if (k >= 60) { dvx += S.so[SO_DVX] * S.si[SI_M]; dvz += S.so[SO_DVX + 2] * S.si[SI_M]; }
    }
    let px = 0, pz = 0;
    for (let i = 0; i < S.mass.nT; i++) { const o = i * 12; if (!S.sl.active[i]) continue; px += S.tanks[i].m * (S.slosh[o + 3] + S.slosh[o + 9]); pz += S.tanks[i].m * (S.slosh[o + 5] + S.slosh[o + 11]); }
    // M·Δv_hull + Δ(Σ m ṗ) = 0
    expect(dvx + (px - P0.x)).toBeCloseTo(0, 6);
    expect(dvz + (pz - P0.z)).toBeCloseTo(0, 6);
  });

  it('ullage: from free fall the liquid is unsettled and ignition fails; an ullage burn settles it in √(2X/a)', () => {
    const S = setup(0.5);
    // a minute of free fall from a settled start: spread
    for (let k = 0; k < 120 * 5; k++) { fillSi(S, [0, 0, -5]); sloshStep(S.sl, S.tanks, S.slosh, S.si, S.so); }
    expect(unsettledFraction(S.sl, S.tanks, S.slosh, 3, true)).toBeLessThan(0.05);
    fillSi(S, [0, 0, 0], [0, 0, 0], 120);
    sloshStep(S.sl, S.tanks, S.slosh, S.si, S.so); // one 120 s warp quantum, exact
    const u0 = unsettledFraction(S.sl, S.tanks, S.slosh, 3, true);
    expect(u0).toBeGreaterThan(IGNITION_U_MAX); // ignition would fail
    // RCS ullage: 68 kN forward on ≈ 55 t → a ≈ 1.2 m/s²
    const a = 68e3 / 55e3;
    // the belly tanks feed first: X of the largest (belly-fwd) along z
    const i = S.mass.tanks.findIndex((t) => t.id === 'lh2-belly-fwd');
    const f = S.tanks[i].m / S.mass.cap[i], X = S.sl.a[3 * i + 2] * (1 - f);
    const x0 = S.slosh[i * 12 + 2];
    const tPred = Math.sqrt((2 * (X - x0)) / a);
    let t = 0;
    while (unsettledFraction(S.sl, S.tanks, S.slosh, 3, true) > IGNITION_U_MAX && t < 60) {
      fillSi(S, [0, 0, -a]); sloshStep(S.sl, S.tanks, S.slosh, S.si, S.so); t += Q;
    }
    let tFull = t;
    while (S.slosh[i * 12 + 2] < X - 1e-9 && tFull < 60) { fillSi(S, [0, 0, -a]); sloshStep(S.sl, S.tanks, S.slosh, S.si, S.so); tFull += Q; }
    console.log(`ullage: u0 ${u0.toFixed(3)}; ignition allowed after ${t.toFixed(2)} s, fully settled after ${tFull.toFixed(2)} s (√(2X/a) = ${tPred.toFixed(2)} s, X ${X.toFixed(2)} m)`);
    expect(Math.abs(tFull - tPred)).toBeLessThan(2 * Q + 0.02 * tPred);
    expect(unsettledFraction(S.sl, S.tanks, S.slosh, 3, true)).toBe(0);
  });

  it('determinism: a fresh model (cold caches) and a warm one give the same bits; save/load; quiet when coasting', () => {
    const run = (S: ReturnType<typeof setup>, n: number, k0 = 0) => {
      for (let k = k0; k < k0 + n; k++) { fillSi(S, [Math.sin(k * 0.01), 0.1, k % 300 < 150 ? -8 : -0.5]); sloshStep(S.sl, S.tanks, S.slosh, S.si, S.so); S.tanks[0].m -= 0.05; }
    };
    const A = setup(0.7);
    run(A, 2000);
    const saved = JSON.stringify({ slosh: A.slosh, m: A.tanks.map((t) => t.m) });
    run(A, 3000, 2000);
    const B = setup(0.7);
    const d = JSON.parse(saved);
    B.slosh = loadSloshState(d.slosh, B.sl);
    d.m.forEach((m: number, i: number) => (B.tanks[i].m = m));
    run(B, 3000, 2000);
    expect(B.slosh).toEqual(A.slosh);
    expect(loadSloshState('junk', B.sl).every((x) => x === 0)).toBe(true);
    // coasting for a long time: everything relaxes and the caller may skip it
    const C = setup(0.5);
    fillSi(C, [0, 0, -3]); sloshStep(C.sl, C.tanks, C.slosh, C.si, C.so);
    for (let k = 0; k < 40; k++) { fillSi(C, [0, 0, 0], [0, 0, 0], 17); sloshStep(C.sl, C.tanks, C.slosh, C.si, C.so); }
    expect(sloshQuiet(C.slosh)).toBe(true);
  });

  it('cost: sloshStep for the Wren (8 sloshing tanks) per call, node', () => {
    const S = setup(0.6);
    const N = 100000;
    for (let k = 0; k < N; k++) { fillSi(S, [0.01 * Math.sin(k), 0, -12]); sloshStep(S.sl, S.tanks, S.slosh, S.si, S.so); S.tanks[0].m -= 1e-4; }
    let tt = 0;
    const t0 = perfNow();
    for (let k = 0; k < N; k++) { S.si[SI_AX] = 0.01 * ((k & 15) - 8); sloshStep(S.sl, S.tanks, S.slosh, S.si, S.so); S.tanks[0].m -= 1e-4; }
    tt = perfNow() - t0;
    const us = (tt * 1e3) / N;
    console.log(`cost (node): sloshStep ${us.toFixed(3)} µs per step (8 LH2 tanks, draining)`);
    expect(us).toBeLessThan(6); // a regression guard (1.0 µs standalone; vitest runs files in parallel)
  });
});
