// W3-A mass properties (src/world/massProps.ts, src/data/tanks.ts, src/data/massPropsBaked.ts): tank layout against
// the hull and the interior, moments of known shapes against brute-force sums, the parallel-axis tensor, CoM shift on
// draining, the baked table's freshness, angular momentum with the full tensor, impulses, save/load mid-burn, cost.

import { describe, expect, it } from 'vitest';
import { HULL_COLLIDERS } from '../src/data/hullColliders';
import { INTERIORS } from '../src/data/interiors';
import { HULL_MOMENTS } from '../src/data/massPropsBaked';
import { TANK_FAIRINGS, LH2_DENSITY, tankContains, tankVolume, wrenTanks } from '../src/data/tanks';
import { compileCompound, compoundContains } from '../src/world/compound';
import {
  MP_CX, MP_CY, MP_CZ, MP_IXX, MP_IYY, MP_IZZ, MP_IXY, MP_IXZ, MP_IYZ, MP_JXX, MP_M, NM, RF_DT, RF_HX, RF_TX, RF_TY, RF_TZ,
  applyExtImpulse, buildMassModel, drawFluid, drawMain, FLUID_N2H4, invertSym, ledgerImpulseFull, loadMassState, makeExtImpulse,
  makeMassOut, makeRotFull, makeTankState, massProps, momentsToProps, needsTableRebuild, poolsOf, rotateFull, saveMassState,
  solidMoments, symMul, tankDefsFor, transferStep,
} from '../src/world/massProps';
import { volumeMoments, compoundOf } from '../tools/massPropsBake';
import { makeRig, rigLoad, rigSave, rigTick } from './w3aRig';
import { perfNow } from '../src/world/math';

const v = (x: number, y: number, z: number) => ({ x, y, z });

/** Brute-force raw moments of a point cloud {m, p}. */
function brute(pts: { m: number; x: number; y: number; z: number }[]): Float64Array {
  const s = new Float64Array(NM);
  for (const p of pts) {
    s[0] += p.m; s[1] += p.m * p.x; s[2] += p.m * p.y; s[3] += p.m * p.z;
    s[4] += p.m * p.x * p.x; s[5] += p.m * p.y * p.y; s[6] += p.m * p.z * p.z;
    s[7] += p.m * p.x * p.y; s[8] += p.m * p.x * p.z; s[9] += p.m * p.y * p.z;
  }
  return s;
}

/** Sample a shape on an n³ grid of cell centres (uniform mass m). */
function sampleShape(shape: 'box' | 'cyl' | 'capsule', c: { x: number; y: number; z: number }, h: { x: number; y: number; z: number }, m: number, n: number) {
  const pts: { m: number; x: number; y: number; z: number }[] = [];
  const ez = shape === 'capsule' ? h.z + h.x : h.z;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
    const x = -h.x + (2 * h.x * (i + 0.5)) / n, y = -h.y + (2 * h.y * (j + 0.5)) / n, z = -ez + (2 * ez * (k + 0.5)) / n;
    let inside = true;
    if (shape === 'cyl') inside = x * x + y * y <= h.x * h.x;
    if (shape === 'capsule') inside = tankContains({ shape: 'capsule', c: v(0, 0, 0), h }, x, y, z);
    if (inside) pts.push({ m: 1, x: x + c.x, y: y + c.y, z: z + c.z });
  }
  for (const p of pts) p.m = m / pts.length;
  return pts;
}

describe('W3-A tank layout (D2)', () => {
  it('every tank is outside the pressure hull, inside the hull plus the conformal fairings, and no two overlap', () => {
    const k0 = compileCompound(HULL_COLLIDERS.wren);
    const k1 = compileCompound([...HULL_COLLIDERS.wren, ...TANK_FAIRINGS]);
    const rooms = INTERIORS.wren!.rooms.map((r) => r.box), M = 0.1;
    const inRoom = (x: number, y: number, z: number) => rooms.some((b) => x > b.min.x - M && x < b.max.x + M && y > b.min.y - M && y < b.max.y + M && z > b.min.z - M && z < b.max.z + M);
    const T = wrenTanks();
    let inside = 0, VL = 0;
    for (const t of T) {
      let n = 0, out1 = 0, room = 0, ov = 0, in0 = 0;
      const d = 0.1, ez = t.shape === 'capsule' ? t.h.z + t.h.x : t.h.z;
      for (let x = t.c.x - t.h.x + d / 2; x < t.c.x + t.h.x; x += d) for (let y = t.c.y - t.h.y + d / 2; y < t.c.y + t.h.y; y += d) for (let z = t.c.z - ez + d / 2; z < t.c.z + ez; z += d) {
        if (!tankContains(t, x, y, z)) continue;
        n++;
        if (compoundContains(k0, x, y, z)) in0++;
        if (!compoundContains(k1, x, y, z)) out1++;
        if (inRoom(x, y, z)) room++;
        for (const u of T) if (u !== t && tankContains(u, x, y, z)) { ov++; break; }
      }
      expect(room, `${t.id} reaches into a room`).toBe(0);
      expect(ov, `${t.id} overlaps another tank`).toBe(0);
      // the N2H4 capsules are 0.41 m (the colliders say 0.36): reported, allowed
      if (t.fluid === 'lh2') expect(out1 / n, `${t.id} pokes out of hull + fairings`).toBeLessThan(0.005);
      if (t.fluid === 'lh2') { inside += (tankVolume(t) * in0) / n; VL += tankVolume(t); }
    }
    const lh2 = T.filter((t) => t.fluid === 'lh2').reduce((s, t) => s + t.cap, 0);
    const n2h4 = T.filter((t) => t.fluid === 'n2h4').reduce((s, t) => s + t.cap, 0);
    expect(lh2).toBeCloseTo(22500, 6);
    expect(n2h4).toBeCloseTo(1500, 6);
    const ullage = 1 - lh2 / LH2_DENSITY / VL;
    expect(ullage).toBeGreaterThan(0.02);
    console.log(`D2: LH2 tanks ${VL.toFixed(1)} m³ (${inside.toFixed(1)} m³ inside today's hull, ${(VL - inside).toFixed(1)} m³ in new fairings), ullage ${(100 * ullage).toFixed(1)} %`);
  });
});

describe('W3-A moments and the tensor', () => {
  it('box, cylinder and capsule moments match a brute-force sum (parallel-axis included)', () => {
    for (const shape of ['box', 'cyl', 'capsule'] as const) {
      const c = v(1.3, -0.7, 4.1), h = shape === 'box' ? v(0.8, 0.5, 2.1) : v(0.6, 0.6, 1.4);
      const a = solidMoments(shape, c, h, 1000, new Float64Array(NM));
      const b = brute(sampleShape(shape, c, h, 1000, 80));
      const A = momentsToProps(a, makeMassOut()), B = momentsToProps(b, makeMassOut());
      for (let k = MP_IXX; k <= MP_IZZ; k++) expect(Math.abs(A[k] - B[k]) / B[k], `${shape} I${k}`).toBeLessThan(5e-3);
      for (let k = MP_CX; k <= MP_CZ; k++) expect(A[k]).toBeCloseTo(B[k], 3);
    }
  });

  it('the full tensor (products of inertia) and its inverse match a brute-force point cloud', () => {
    const pts = [
      { m: 120, x: 3, y: -1, z: 7 }, { m: 80, x: -2, y: 2.5, z: -4 }, { m: 300, x: 0.5, y: 0.2, z: 1 },
      { m: 55, x: -4, y: -3, z: 2 }, { m: 210, x: 1, y: 4, z: -6 },
    ];
    const P = momentsToProps(brute(pts), makeMassOut());
    const m = pts.reduce((s, p) => s + p.m, 0);
    const c = { x: pts.reduce((s, p) => s + p.m * p.x, 0) / m, y: pts.reduce((s, p) => s + p.m * p.y, 0) / m, z: pts.reduce((s, p) => s + p.m * p.z, 0) / m };
    let Ixx = 0, Iyy = 0, Izz = 0, Ixy = 0, Ixz = 0, Iyz = 0;
    for (const p of pts) {
      const x = p.x - c.x, y = p.y - c.y, z = p.z - c.z;
      Ixx += p.m * (y * y + z * z); Iyy += p.m * (x * x + z * z); Izz += p.m * (x * x + y * y);
      Ixy -= p.m * x * y; Ixz -= p.m * x * z; Iyz -= p.m * y * z;
    }
    const want = [Ixx, Iyy, Izz, Ixy, Ixz, Iyz];
    for (let k = 0; k < 6; k++) expect(P[MP_IXX + k]).toBeCloseTo(want[k], 6);
    // I·I⁻¹ = E
    const e = { x: 0, y: 0, z: 0 }, f = { x: 0, y: 0, z: 0 };
    for (const [x, y, z] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
      symMul(P, MP_JXX, x, y, z, e); symMul(P, MP_IXX, e.x, e.y, e.z, f);
      expect(f.x).toBeCloseTo(x, 10); expect(f.y).toBeCloseTo(y, 10); expect(f.z).toBeCloseTo(z, 10);
    }
    const inv = new Float64Array(6);
    invertSym([2, 3, 4, 0.5, 0.2, -0.3], 0, inv, 0);
    symMul(inv, 0, 2, 0.5, 0.2, e);
    expect(e.x).toBeCloseTo(1, 12); expect(e.y).toBeCloseTo(0, 12); expect(e.z).toBeCloseTo(0, 12);
  });

  it('the baked hull moments are not stale (coarse re-bake within 3 %)', () => {
    // the shrike on the bake's own 0.1 m grid must match exactly; the Wren on a 0.25 m grid within 3 %
    const s = volumeMoments(compoundOf('shrike'), 0.1);
    expect(s.map((x) => Number(x.toPrecision(12)))).toEqual(HULL_MOMENTS.shrike.volume);
    for (const hull of ['wren']) {
      const m = volumeMoments(compoundOf(hull), 0.25), b = HULL_MOMENTS[hull].volume;
      expect(Math.abs(m[0] - b[0]) / b[0], hull).toBeLessThan(0.03);
      expect(Math.abs(m[3] / m[0] - b[3] / b[0])).toBeLessThan(0.05);
      expect(Math.abs(m[6] - b[6]) / b[6]).toBeLessThan(0.03);
    }
  });

  it('the Wren dry model: total = dryMass, shell from the zones, and where the CoM and inertia land', () => {
    const model = buildMassModel('wren', tankDefsFor('wren', 22500, 1500), 42900);
    expect(model.dry[0]).toBe(42900);
    const dry = momentsToProps(model.dry, makeMassOut());
    const full = massProps(model, makeTankState(model, 1), [], [], [], 0, makeMassOut());
    const empty = massProps(model, makeTankState(model, 0), [], [], [], 0, makeMassOut());
    // today's box estimate: m·(y²+z²)/12 with 32 × 19 × 6.6 m
    const box = [(6.6 * 6.6 + 32 * 32) / 12, (19 * 19 + 32 * 32) / 12, (19 * 19 + 6.6 * 6.6) / 12];
    const fmt = (P: Float64Array) => `c (${P[MP_CX].toFixed(3)}, ${P[MP_CY].toFixed(3)}, ${P[MP_CZ].toFixed(3)}) m, I/m (${(P[MP_IXX] / P[MP_M]).toFixed(1)}, ${(P[MP_IYY] / P[MP_M]).toFixed(1)}, ${(P[MP_IZZ] / P[MP_M]).toFixed(1)}) m² [box ${box.map((x) => x.toFixed(1)).join(', ')}], products (${P[MP_IXY].toExponential(2)}, ${P[MP_IXZ].toExponential(2)}, ${P[MP_IYZ].toExponential(2)})`;
    console.log(`dry ${fmt(dry)}\nfull ${fmt(full)} m ${full[MP_M]}\nempty ${fmt(empty)}`);
    expect(full[MP_M]).toBeCloseTo(42900 + 24000, 6);
    // products of inertia are small next to the diagonal (the hull is left–right symmetric)
    expect(Math.abs(full[MP_IXY]) + Math.abs(full[MP_IXZ])).toBeLessThan(2e-3 * full[MP_IXX]);
    // roll inertia far below the box (the plan's 3.6× for the uniform hull)
    expect(full[MP_IZZ] / full[MP_M]).toBeLessThan(box[2] / 2);
  });

  it('draining a tank moves c by the analytic amount: Δc = −Δm (p_t − c)/(M − Δm)', () => {
    const model = buildMassModel('wren', tankDefsFor('wren', 22500, 1500), 42900);
    const T = makeTankState(model, 1);
    const a = massProps(model, T, [], [], [], 0, makeMassOut());
    const i = 0, dm = 3000;
    T[i].m -= dm;
    const b = massProps(model, T, [], [], [], 0, makeMassOut());
    const p = model.tanks[i].c, M = a[MP_M];
    expect(b[MP_CX] - a[MP_CX]).toBeCloseTo((-dm * (p.x - a[MP_CX])) / (M - dm), 12);
    expect(b[MP_CY] - a[MP_CY]).toBeCloseTo((-dm * (p.y - a[MP_CY])) / (M - dm), 12);
    expect(b[MP_CZ] - a[MP_CZ]).toBeCloseTo((-dm * (p.z - a[MP_CZ])) / (M - dm), 12);
    expect(needsTableRebuild(b, { x: a[MP_CX], y: a[MP_CY], z: a[MP_CZ] })).toBe(true);
    expect(needsTableRebuild(a, { x: a[MP_CX] + 0.019, y: a[MP_CY], z: a[MP_CZ] })).toBe(false);
  });

  it('draw order, crossfeed, transfer pumps and the pools', () => {
    const model = buildMassModel('wren', tankDefsFor('wren', 22500, 1500), 42900);
    const T = makeTankState(model, 1);
    const dm = new Float64Array([100, 100]);
    drawMain(model, T, dm, 2, false);
    expect(dm[0]).toBe(0); expect(dm[1]).toBe(0);
    // group 0 (belly) drains first, in proportion to the remaining mass
    const g0 = model.tanks.map((t, i) => (t.group === 0 && t.fluid === 'lh2' ? model.cap[i] - T[i].m : 0));
    expect(g0.reduce((s, x) => s + x, 0)).toBeCloseTo(200, 9);
    for (let i = 0; i < model.nT; i++) if (model.tanks[i].group !== 0 || model.tanks[i].fluid !== 'lh2') expect(T[i].m).toBe(model.cap[i]);
    // empty the belly; with the crossfeed closed the starboard engine draws only its own side's tanks
    for (let i = 0; i < model.nT; i++) if (model.tanks[i].group === 0 && model.tanks[i].fluid === 'lh2') T[i].m = 0;
    dm[0] = 500; dm[1] = 0;
    drawMain(model, T, dm, 2, false);
    const stbd = model.tanks.findIndex((t) => t.id === 'lh2-pod-stbd'), port = model.tanks.findIndex((t) => t.id === 'lh2-pod-port');
    expect(model.cap[stbd] - T[stbd].m).toBeCloseTo(500, 9);
    expect(T[port].m).toBe(model.cap[port]);
    // a transfer pump balances them (same fluid), clamped to 20 kg/s
    const io = new Float64Array([stbd === 0 ? 1 : port, stbd, 50, 10, 0]);
    io[0] = port;
    transferStep(model, T, io);
    expect(io[4]).toBeCloseTo(200, 9);
    const pools = new Float64Array(2);
    poolsOf(model, T, pools);
    const n = new Float64Array([10]);
    drawFluid(model, T, FLUID_N2H4, n);
    const pools2 = new Float64Array(2);
    poolsOf(model, T, pools2);
    expect(pools[1] - pools2[1]).toBeCloseTo(10, 9);
    expect(pools2[0]).toBe(pools[0]);
  });
});

describe('W3-A rotation and impulses', () => {
  it('torque-free rotation with the full tensor conserves L (inertial) and energy', () => {
    const P = momentsToProps(brute([
      { m: 4e4, x: 0, y: 0, z: 0 }, { m: 8e3, x: 3, y: 1, z: 9 }, { m: 6e3, x: -2, y: -1.5, z: -7 }, { m: 5e3, x: 5, y: 2, z: -2 },
    ]), makeMassOut());
    expect(Math.abs(P[MP_IXY]) + Math.abs(P[MP_IXZ]) + Math.abs(P[MP_IYZ])).toBeGreaterThan(1e4);
    const w = v(0.05, 0.12, -0.03), q = { x: 0, y: 0, z: 0, w: 1 }, rf = makeRotFull();
    const L = (out: { x: number; y: number; z: number }) => {
      const b = symMul(P, MP_IXX, w.x, w.y, w.z, { x: 0, y: 0, z: 0 });
      const tx = 2 * (q.y * b.z - q.z * b.y), ty = 2 * (q.z * b.x - q.x * b.z), tz = 2 * (q.x * b.y - q.y * b.x);
      out.x = b.x + q.w * tx + (q.y * tz - q.z * ty); out.y = b.y + q.w * ty + (q.z * tx - q.x * tz); out.z = b.z + q.w * tz + (q.x * ty - q.y * tx);
      return out;
    };
    const E = () => { const b = symMul(P, MP_IXX, w.x, w.y, w.z, { x: 0, y: 0, z: 0 }); return 0.5 * (b.x * w.x + b.y * w.y + b.z * w.z); };
    const L0 = L({ x: 0, y: 0, z: 0 }), E0 = E();
    for (let i = 0; i < 120 * 600; i++) { rf[RF_DT] = 1 / 120; rotateFull(w, q, P, rf); }
    const L1 = L({ x: 0, y: 0, z: 0 });
    const dL = Math.hypot(L1.x - L0.x, L1.y - L0.y, L1.z - L0.z) / Math.hypot(L0.x, L0.y, L0.z);
    console.log(`full-tensor free rotation, 600 s at Q: |ΔL|/L ${dL.toExponential(2)}, ΔE/E ${((E() - E0) / E0).toExponential(2)}`);
    expect(dL).toBeLessThan(1e-9);
    expect(Math.abs(E() - E0) / E0).toBeLessThan(1e-9);
  });

  it('a constant torque about a principal axis gives α = τ/I; extImpulse and contact impulses use the full tensor', () => {
    const model = buildMassModel('wren', tankDefsFor('wren', 22500, 1500), 42900);
    const P = massProps(model, makeTankState(model, 1), [], [], [], 0, makeMassOut());
    const w = v(0, 0, 0), q = { x: 0, y: 0, z: 0, w: 1 }, rf = makeRotFull();
    // from rest over 1 ms: ω/dt = I⁻¹τ (the gyroscopic term is second order in ω); the full tensor couples axes
    rf[RF_DT] = 1e-3; rf[RF_TX] = 1e5; rf[RF_TY] = 0; rf[RF_TZ] = 0;
    rotateFull(w, q, P, rf);
    const want = symMul(P, MP_JXX, 1e5, 0, 0, v(0, 0, 0));
    expect(Math.abs(w.x / 1e-3 - want.x) / Math.abs(want.x)).toBeLessThan(1e-6);
    expect(Math.abs(w.y / 1e-3 - want.y) / Math.abs(want.x)).toBeLessThan(1e-6);
    expect(Math.abs(w.z / 1e-3 - want.z) / Math.abs(want.x)).toBeLessThan(1e-6);
    expect(Math.abs(want.z)).toBeGreaterThan(0);
    const e = makeExtImpulse();
    e.J.x = 670; e.L.y = 5e4;
    const dvw = new Float64Array(6);
    applyExtImpulse(e, P, dvw);
    expect(dvw[0]).toBeCloseTo(670 / P[MP_M], 12);
    const dwy = symMul(P, MP_JXX, 0, 5e4, 0, v(0, 0, 0));
    expect(dvw[4]).toBeCloseTo(dwy.y, 14);
    expect(e.J.x).toBe(0); expect(e.L.y).toBe(0);
    const Lg = { dvImpulse: v(0, 0, 0), dwImpulse: v(0, 0, 0) };
    ledgerImpulseFull(Lg, v(0, 1000, 0), v(0, 0, -12), P);
    const ref = symMul(P, MP_JXX, 12000, 0, 0, v(0, 0, 0)); // r × J = (0,0,−12) × (0,1000,0) = (12000, 0, 0)
    expect(Lg.dwImpulse.x).toBeCloseTo(ref.x, 14);
    expect(Lg.dvImpulse.y).toBeCloseTo(1000 / P[MP_M], 14);
    void RF_HX;
  });
});

describe('W3-A save / load and cost', () => {
  it('save → load in the middle of a long burn (CoM moving, table rebuilt) continues bit-identically', () => {
    const a = makeRig();
    a.s.throttle = 1;
    for (let i = 0; i < 120 * 40 + 7; i++) rigTick(a); // an odd tick: between two 60 Hz control ticks
    const json = rigSave(a);
    const b = rigLoad(json);
    for (let i = 0; i < 120 * 30; i++) { rigTick(a); rigTick(b); }
    expect(rigSave(b)).toBe(rigSave(a));
    expect(a.rebuilds).toBeGreaterThan(2);
  });

  it('loader defaults: an old save spreads its pools by draw order reversed; tableCom defaults to the CoM given', () => {
    const model = buildMassModel('wren', tankDefsFor('wren', 22500, 1500), 42900);
    const s = loadMassState({}, model, 12000, 700, v(0.1, -0.2, 3));
    const pools = new Float64Array(2);
    poolsOf(model, s.tanks, pools);
    expect(pools[0]).toBeCloseTo(12000, 6); expect(pools[1]).toBeCloseTo(700, 9);
    // the last group (dorsal + gloves) is full, the belly (group 0) is what is missing
    for (let i = 0; i < model.nT; i++) if (model.tanks[i].group === 2) expect(s.tanks[i].m).toBeCloseTo(model.cap[i], 9);
    expect(s.tableCom).toEqual(v(0.1, -0.2, 3));
    expect(s.tpsMass.length).toBe(12);
    const round = loadMassState(JSON.parse(JSON.stringify(saveMassState(s))), model, 0, 0, v(0, 0, 0));
    expect(round.tanks.map((t) => t.m)).toEqual(s.tanks.map((t) => t.m));
    // tps on the nose moves c forward
    const P0 = massProps(model, s.tanks, [], [], [], 0, makeMassOut());
    const tps = new Array(12).fill(0); tps[0] = 500;
    const P1 = massProps(model, s.tanks, [], tps, [], 0, makeMassOut());
    expect(P1[MP_CZ]).toBeLessThan(P0[MP_CZ]);
    expect(P1[MP_M] - P0[MP_M]).toBeCloseTo(500, 9);
  });

  it('cost: massProps, rotateFull (µs per call, node)', () => {
    const model = buildMassModel('wren', tankDefsFor('wren', 22500, 1500), 42900);
    const T = makeTankState(model, 0.6), sl = new Array(model.nT * 12).fill(0.01), out = makeMassOut();
    const pts = new Float64Array([80, -0.55, 0, -13.3, 80, 2, 0, -7]);
    const N = 200000;
    for (let i = 0; i < N; i++) massProps(model, T, sl, [], pts, 2, out);
    let t0 = perfNow();
    for (let i = 0; i < N; i++) { T[0].m -= 1e-6; massProps(model, T, sl, [], pts, 2, out); }
    const us1 = ((perfNow() - t0) * 1e3) / N;
    const w = v(0.01, 0.02, 0.005), q = { x: 0, y: 0, z: 0, w: 1 }, rf = makeRotFull();
    rf[RF_DT] = 1 / 120; rf[RF_TX] = 100;
    for (let i = 0; i < N; i++) rotateFull(w, q, out, rf);
    t0 = perfNow();
    for (let i = 0; i < N; i++) rotateFull(w, q, out, rf);
    const us2 = ((perfNow() - t0) * 1e3) / N;
    console.log(`cost (node): massProps ${us1.toFixed(3)} µs (10 tanks, 2 crew), rotateFull ${us2.toFixed(3)} µs (1 sub-step)`);
    expect(us1).toBeLessThan(2);
    expect(us2).toBeLessThan(2);
  });
});
