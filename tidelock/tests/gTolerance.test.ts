// W3-D acceleration physiology (src/world/gTolerance.ts): +Gz tolerance against the published relaxed curves,
// the time-to-G-LOC curve at constant +Gz, recline, +Gx, −Gz red-out, push-pull, recovery time constants, the
// cabin air (vacuum, hypoxia, hypercapnia), warp steps, determinism, save → load, cost.
//
// Published references used for the bands (relaxed, no straining, no G-suit):
// - Gradual onset (≈ 0.1 g/s): peripheral light loss 4.1 ± 0.7 g, central light loss (black-out) 4.7 ± 0.8 g,
//   loss of consciousness 5.4 ± 0.9 g (Cochran, Gard & Norsworthy 1954, as summarised by Gillingham & Fosdick 1988).
// - Rapid onset: G-LOC follows the onset by the 4–6 s "functional buffer" (the brain's O₂ reserve) at any level well
//   above tolerance, longer near the threshold, never below the relaxed rapid-onset threshold; vision fails ≈ 1–2 s
//   before consciousness (Whinnery; Burton & Whinnery 1996). Recovery: absolute incapacitation ≈ 12 s, then relative
//   incapacitation ≈ 15 s (Whinnery 1989).
// - Time of useful consciousness after a rapid decompression to vacuum: 9–15 s.
import { describe, expect, it } from 'vitest';
import {
  BARO_MAX, COLUMN_PER_G, createGIn, createGOut, createPhysiology, GI_FX, GI_FY, GI_FZ, GI_P, GI_PPCO2, GI_PPO2,
  GO_BLACK, GO_CAUSE, GO_CONSCIOUS, GO_CONTROL, GO_PACO2, GO_RED, GO_SAO2, GO_TUNNEL, GT_D0, GT_LEN, GT_SETTLED,
  loadPhysiology, MMHG, physioMaxStep, savePhysiology, seatBodyForce, stepPhysiology, CAUSE_GLOC, CAUSE_HYPOXIA,
} from '../src/world/gTolerance';
import { perfNow } from '../src/world/math';

const Q = 1 / 120, g0 = 9.80665;

interface Env { gz: (t: number) => number; gx?: (t: number) => number; ppO2?: number; ppCO2?: number; p?: number }
interface Trace { tPLL: number; gPLL: number; tCLL: number; gCLL: number; tLOC: number; gLOC: number; tWake: number; s: Float64Array; out: Float64Array }

function run(env: Env, T: number, h = Q, s = createPhysiology(), t0 = 0): Trace {
  const inp = createGIn(), out = createGOut();
  const tr: Trace = { tPLL: -1, gPLL: 0, tCLL: -1, gCLL: 0, tLOC: -1, gLOC: 0, tWake: -1, s, out };
  const n = Math.round(T / h);
  for (let i = 0; i < n; i++) {
    const t = t0 + i * h, g = env.gz(t);
    inp[GI_FY] = g * g0; inp[GI_FZ] = -(env.gx ? env.gx(t) : 0) * g0;
    if (env.ppO2 !== undefined) inp[GI_PPO2] = env.ppO2;
    if (env.ppCO2 !== undefined) inp[GI_PPCO2] = env.ppCO2;
    if (env.p !== undefined) inp[GI_P] = env.p;
    stepPhysiology(s, inp, h, out);
    const te = t + h;
    if (tr.tPLL < 0 && out[GO_TUNNEL] > 0.05) { tr.tPLL = te; tr.gPLL = g; }
    if (tr.tCLL < 0 && out[GO_CONSCIOUS] === 1 && out[GO_BLACK] >= 0.99) { tr.tCLL = te; tr.gCLL = g; }
    if (tr.tLOC < 0 && out[GO_CONSCIOUS] === 0) { tr.tLOC = te; tr.gLOC = g; }
    if (tr.tLOC >= 0 && tr.tWake < 0 && out[GO_CONSCIOUS] === 1) tr.tWake = te;
  }
  return tr;
}
const step = (G: number) => (t: number): number => (t < 0 ? 1 : G);

describe('+Gz tolerance (relaxed)', () => {
  it('rests at 1 g in sea-level air: full vision, conscious, SaO₂ ≈ 0.97, PaCO₂ 40 mmHg, and settles', () => {
    const tr = run({ gz: () => 1 }, 600);
    expect(tr.out[GO_TUNNEL]).toBe(0);
    expect(tr.out[GO_BLACK]).toBe(0);
    expect(tr.out[GO_CONSCIOUS]).toBe(1);
    expect(tr.out[GO_CONTROL]).toBe(1);
    expect(tr.out[GO_SAO2]).toBeGreaterThan(0.96);
    expect(tr.out[GO_PACO2] / MMHG).toBeCloseTo(40, 0);
    expect(tr.s[GT_SETTLED]).toBe(1);
    expect(physioMaxStep(tr.s)).toBe(Infinity);
  });

  it('gradual onset 0.1 g/s: light loss 4.1 ± 0.7 g, black-out 4.7 ± 0.8 g, G-LOC 5.4 ± 0.9 g, in that order', () => {
    const tr = run({ gz: (t) => 1 + 0.1 * t }, 100);
    console.log(`[gTolerance] GOR 0.1 g/s: PLL ${tr.gPLL.toFixed(2)} g, black-out ${tr.gCLL.toFixed(2)} g, G-LOC ${tr.gLOC.toFixed(2)} g`);
    expect(tr.gPLL).toBeGreaterThan(3.4); expect(tr.gPLL).toBeLessThan(4.8);
    expect(tr.gCLL).toBeGreaterThan(3.9); expect(tr.gCLL).toBeLessThan(5.5);
    expect(tr.gLOC).toBeGreaterThan(4.5); expect(tr.gLOC).toBeLessThan(6.3);
    expect(tr.tPLL).toBeLessThan(tr.tCLL);
    expect(tr.tCLL).toBeLessThan(tr.tLOC);
  });

  it('time to G-LOC at constant +Gz (rapid onset): none at ≤ 4.5 g, 4–10 s above, falling to the ~5 s O₂ reserve', () => {
    const levels = [4, 4.5, 5.5, 6, 7, 9, 12, 15];
    const t = levels.map((G) => run({ gz: step(G) }, 120).tLOC);
    console.log(`[gTolerance] time to G-LOC: ${levels.map((G, i) => `${G} g ${t[i] < 0 ? 'none' : t[i].toFixed(2) + ' s'}`).join(', ')}`);
    expect(t[0]).toBe(-1);
    expect(t[1]).toBe(-1);
    for (let i = 2; i < levels.length; i++) {
      expect(t[i]).toBeGreaterThan(4);
      expect(t[i]).toBeLessThan(10);
      expect(t[i]).toBeLessThanOrEqual(t[i - 1] + 1e-9);
    }
    // vision fails before consciousness, by 0.5–2.5 s, at a high level
    const tr = run({ gz: step(9) }, 20);
    expect(tr.tLOC - tr.tCLL).toBeGreaterThan(0.5);
    expect(tr.tLOC - tr.tCLL).toBeLessThan(2.5);
    expect(tr.s[0]).toBeGreaterThan(0); // the baroreflex has started
  });

  it('the baroreflex: a 4 g plateau tunnels the view early and gives part of it back (the Stoll dip)', () => {
    const s = createPhysiology();
    run({ gz: step(4) }, 6, Q, s);
    const early = run({ gz: step(4) }, Q, Q, s).out[GO_TUNNEL];
    run({ gz: step(4) }, 40, Q, s);
    const late = run({ gz: step(4) }, Q, Q, s).out[GO_TUNNEL];
    console.log(`[gTolerance] 4 g plateau: tunnel ${early.toFixed(2)} at 6 s, ${late.toFixed(2)} at 46 s`);
    expect(early).toBeGreaterThan(late + 0.2);
    expect(s[0]).toBeCloseTo(BARO_MAX, -1);
  });

  it('a reclined seat protects: 9 g along the ship with the seat back at 70° gives no G-LOC; upright it does', () => {
    const c = Math.cos((70 * Math.PI) / 180), sn = Math.sin((70 * Math.PI) / 180);
    const fb = new Float64Array(3);
    // the thrust presses the pilot into the seat: craft-frame felt f = 9 g along +y (upright seat = pure +Gz)
    seatBodyForce({ x: 0, y: 9 * g0, z: 0 }, c, sn, fb, 0);
    expect(fb[1] / g0).toBeCloseTo(9 * c, 9);
    const s = createPhysiology(), inp = createGIn(), out = createGOut();
    inp[GI_FX] = fb[0]; inp[GI_FY] = fb[1]; inp[GI_FZ] = fb[2];
    let lost = false;
    for (let i = 0; i < 60 * 120; i++) { stepPhysiology(s, inp, Q, out); if (out[GO_CONSCIOUS] === 0) lost = true; }
    expect(lost).toBe(false);
    expect(run({ gz: step(9) }, 60).tLOC).toBeGreaterThan(0);
  });

  it('+Gx is far better tolerated: 12 g eyeballs-in for 30 s keeps consciousness and most of the view; the strain limit arrives at ≈ 53 s (15 g ≈ 24 s)', () => {
    const tr = run({ gz: () => 0, gx: () => 12 }, 30);
    expect(tr.tLOC).toBe(-1);
    expect(tr.out[GO_TUNNEL]).toBeLessThan(0.3);
    const tLimit = (G: number): number => {
      const s = createPhysiology(), inp = createGIn(), out = createGOut();
      inp[GI_FY] = 0; inp[GI_FZ] = -G * g0;
      for (let i = 1; i < 600 * 120; i++) { stepPhysiology(s, inp, Q, out); if (s[GT_D0] >= 1) return i * Q; }
      return -1;
    };
    const t12 = tLimit(12), t15 = tLimit(15);
    console.log(`[gTolerance] +Gx strain limit: 12 g ${t12.toFixed(1)} s, 15 g ${t15.toFixed(1)} s`);
    expect(t12).toBeGreaterThan(45); expect(t12).toBeLessThan(75);
    expect(t15).toBeGreaterThan(18); expect(t15).toBeLessThan(32);
  });
});

describe('−Gz, push-pull, recovery', () => {
  it('red-out appears at −2 … −3 g and not at −1 g', () => {
    expect(run({ gz: () => -2.5 }, 6).out[GO_RED]).toBeGreaterThan(0.5);
    expect(run({ gz: () => -1 }, 6).out[GO_RED]).toBeLessThan(0.05);
    expect(run({ gz: () => 1 }, 6).out[GO_RED]).toBe(0);
  });

  it('push-pull: 10 s at −2 g just before a 5 g pull causes the G-LOC the same pull alone does not', () => {
    expect(run({ gz: step(5) }, 60).tLOC).toBe(-1);
    const tr = run({ gz: (t) => (t < 10 ? -2 : 5) }, 70);
    expect(tr.tLOC).toBeGreaterThan(10);
  });

  it('recovery: 12 s of absolute incapacitation after the load goes, then 15 s of relative incapacitation; vision back within 3 s', () => {
    const s = createPhysiology();
    const a = run({ gz: step(9) }, 30, Q, s);
    expect(a.tLOC).toBeGreaterThan(0);
    // hold until G-LOC, relieve at once
    const s2 = createPhysiology(), inp = createGIn(), out = createGOut();
    let t = 0, tOff = -1, tWake = -1, tFull = -1, tSee = -1;
    inp[GI_FY] = 9 * g0;
    for (let i = 0; i < 120 * 80; i++) {
      if (tOff < 0 && out[GO_CONSCIOUS] === 0 && i > 0) { tOff = t; inp[GI_FY] = g0; }
      stepPhysiology(s2, inp, Q, out); t += Q;
      if (tOff >= 0 && tSee < 0 && s2[2] > 0.4) tSee = t;
      if (tOff >= 0 && tWake < 0 && out[GO_CONSCIOUS] === 1) tWake = t;
      if (tWake >= 0 && tFull < 0 && out[GO_CONTROL] >= 1) tFull = t;
    }
    console.log(`[gTolerance] recovery: unconscious ${(tWake - tOff).toFixed(2)} s, relative ${(tFull - tWake).toFixed(2)} s, retina back ${(tSee - tOff).toFixed(2)} s`);
    expect(tWake - tOff).toBeGreaterThan(11.5); expect(tWake - tOff).toBeLessThan(13.5);
    expect(tFull - tWake).toBeGreaterThan(14.8); expect(tFull - tWake).toBeLessThan(15.2);
    expect(tSee - tOff).toBeLessThan(3);
    expect(out[GO_CAUSE]).toBe(0);
  });

  it('the hands have no control while unconscious and the cause is G-LOC', () => {
    const s = createPhysiology(), inp = createGIn(), out = createGOut();
    inp[GI_FY] = 8 * g0;
    for (let i = 0; i < 120 * 8; i++) stepPhysiology(s, inp, Q, out);
    expect(out[GO_CONSCIOUS]).toBe(0);
    expect(out[GO_CONTROL]).toBe(0);
    expect(out[GO_CAUSE]).toBe(CAUSE_GLOC);
  });
});

describe('the cabin air', () => {
  it('vacuum (a breach): unconscious after 8–16 s, cause hypoxia', () => {
    const tr = run({ gz: () => 1, p: 0, ppO2: 0 }, 40);
    console.log(`[gTolerance] vacuum: useful consciousness ${tr.tLOC.toFixed(2)} s`);
    expect(tr.tLOC).toBeGreaterThan(8); expect(tr.tLOC).toBeLessThan(16);
    expect(tr.out[GO_CAUSE]).toBe(CAUSE_HYPOXIA);
  });

  it('thin oxygen: ppO₂ 14 kPa keeps consciousness with SaO₂ 0.78–0.92; 6 kPa takes it within 2 minutes', () => {
    const a = run({ gz: () => 1, ppO2: 14000 }, 900);
    expect(a.tLOC).toBe(-1);
    expect(a.out[GO_SAO2]).toBeGreaterThan(0.78); expect(a.out[GO_SAO2]).toBeLessThan(0.92);
    const b = run({ gz: () => 1, ppO2: 6000 }, 300);
    expect(b.tLOC).toBeGreaterThan(10); expect(b.tLOC).toBeLessThan(120);
  });

  it('CO₂: 5 % is breathable (PaCO₂ 44–50 mmHg); 15 % narcotises within 5 minutes', () => {
    const a = run({ gz: () => 1, ppCO2: 5066 }, 1200);
    expect(a.tLOC).toBe(-1);
    expect(a.out[GO_PACO2] / MMHG).toBeGreaterThan(44); expect(a.out[GO_PACO2] / MMHG).toBeLessThan(50);
    const b = run({ gz: () => 1, ppCO2: 15199 }, 400);
    expect(b.tLOC).toBeGreaterThan(30); expect(b.tLOC).toBeLessThan(300);
  });
});

describe('warp, determinism, save → load, cost', () => {
  it('a 17 s quantum gives the same state as 2048 ticks within perception, and a settled state is a fixed point', () => {
    const env: Env = { gz: (t) => (t < 34 ? 5.2 : 1), ppO2: 15000 };
    const a = run(env, 68, Q).s, b = run(env, 68, 2048 * Q).s;
    for (const k of [0, 1, 2, 3, 4]) expect(Math.abs(a[k] - b[k])).toBeLessThan(k === 0 || k >= 3 ? 0.02 * Math.abs(a[k]) + 1 : 0.02);
    // settled: one huge step changes no continuous state
    const s = run({ gz: () => 1 }, 900).s;
    expect(s[GT_SETTLED]).toBe(1);
    const before = Array.from(s);
    run({ gz: () => 1 }, 1e5, 1e5, s);
    for (let k = 0; k < 9; k++) expect(Math.abs(s[k] - before[k])).toBeLessThan(1e-6 * (Math.abs(before[k]) + 1));
  });

  it('is deterministic and save → load mid-transient continues bit-identically', () => {
    const env: Env = { gz: (t) => 1 + 0.3 * t, gx: (t) => 0.5 * Math.sin(t), ppO2: 17000 };
    const a = run(env, 20), b = run(env, 20);
    expect(Array.from(a.s)).toEqual(Array.from(b.s));
    const s1 = run(env, 12).s;
    const s2 = loadPhysiology(JSON.parse(JSON.stringify(savePhysiology(s1))));
    expect(s2.length).toBe(GT_LEN);
    run(env, 8, Q, s1, 12); run(env, 8, Q, s2, 12);
    expect(Array.from(s2)).toEqual(Array.from(s1));
    // loader default
    expect(Array.from(loadPhysiology(undefined))).toEqual(Array.from(createPhysiology()));
  });

  it('cost (node)', () => {
    const s = createPhysiology(), inp = createGIn(), out = createGOut();
    const N = 200000;
    inp[GI_FY] = 3 * g0;
    for (let i = 0; i < 20000; i++) { inp[GI_FY] = (1 + 3 * Math.abs(Math.sin(i * 1e-3))) * g0; stepPhysiology(s, inp, Q, out); }
    let t0 = perfNow();
    for (let i = 0; i < N; i++) { inp[GI_FY] = (1 + 3 * Math.abs(Math.sin(i * 1e-3))) * g0; stepPhysiology(s, inp, Q, out); }
    const tr = ((perfNow() - t0) * 1e3) / N;
    inp[GI_FY] = g0;
    run({ gz: () => 1 }, 900, Q, s);
    t0 = perfNow();
    for (let i = 0; i < N; i++) stepPhysiology(s, inp, Q, out);
    const st = ((perfNow() - t0) * 1e3) / N;
    t0 = perfNow();
    for (let i = 0; i < N / 10; i++) stepPhysiology(s, inp, 2048 * Q, out);
    const wq = ((perfNow() - t0) * 1e3) / (N / 10);
    const s3 = createPhysiology();
    t0 = perfNow();
    for (let i = 0; i < 2000; i++) { inp[GI_FY] = (i & 1 ? 1 : 3) * g0; stepPhysiology(s3, inp, 2048 * Q, out); }
    const wt = ((perfNow() - t0) * 1e3) / 2000;
    console.log(`[gTolerance] node µs: tick in a transient ${tr.toFixed(3)}, tick settled ${st.toFixed(3)}, 17 s quantum settled ${wq.toFixed(3)}, 17 s quantum in a transient (68 sub-steps) ${wt.toFixed(2)}`);
    expect(tr).toBeLessThan(2);
    expect(COLUMN_PER_G / MMHG).toBeCloseTo(23.4, 1);
  });
});
