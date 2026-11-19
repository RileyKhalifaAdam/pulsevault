// W1-E honest exhaust: the pure core (src/render/space/plumeCore.ts, src/world/dutyTape.ts) and the small laws
// (src/render/space/honest.ts).
import { describe, expect, it } from 'vitest';
import type { V3 } from '../src/core/types';
import { SHIP_LAYOUTS } from '../src/data/shipLayouts';
import { createSession } from '../src/game';
import { jetsFromLayout, jetEdgeMasks } from '../src/world/jets';
import { createDutyTape, tapeRecord, tapeReset, DUTY_TAPE_SLOTS, type DutyTape } from '../src/world/dutyTape';
import {
  CONE_ON,
  CONE_OFF,
  ETA_BED,
  F_MIN,
  F_ON_HI,
  F_ON_LO,
  HG_G,
  KAPPA,
  LIFE_MAX,
  OMEGA0,
  PHASE_MAX,
  PUFF_FILL_SCREENS,
  PUFF_OFF,
  PUFF_ON,
  PUFF_STEADY,
  PUFF_STRIDE,
  PuffPool,
  TAU_END,
  TICK,
  T_BED,
  T_PARCEL,
  WREN_OCCLUDERS,
  hgPhase,
  packOccluders,
  parcelLife,
  parcelRadiance,
  plumeAxisColumn,
  plumeCellRadii,
  plumeEmissivity,
  plumeExitFactor,
  plumeLength,
  puffFillPx,
  puffQuadPx,
  rayCapsuleDist2,
  solvePuffFloor,
  shockCellSpacing,
  tauFloor,
  type PuffCam,
  type PuffCraft,
} from '../src/render/space/plumeCore';
import {
  EYES_CLOSING,
  EYES_SAME,
  EYES_WAKE,
  autoBrightnessTarget,
  blackbodyEfficacy,
  cockpitScreensVisible,
  eyelidTransmission,
  eyesTransition,
  frustumPlanes,
  glassIlluminance,
  holoDisplayRadius,
  holoScale,
  holoZoom,
  lambertPhase,
  phaseNoWrap,
  relaxExact,
  renderPerNit,
  roundKmStep,
  screenContrast,
  setEyeFields,
  sheathDir,
  sheathIntensity,
  starIlluminanceLux,
  stepAutoBrightness,
  unresolvedIlluminance,
  veilLuminance,
} from '../src/render/space/honest';

const JETS = jetsFromLayout(SHIP_LAYOUTS.wren.rcs);
const NJ = JETS.length;
const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const R0 = v3(1.5e11, 2e3, -4e6), V0 = v3(-3e4, 0, 7.8e3);
const ZERO = v3();
const zeros = (): number[] => new Array(NJ).fill(0);
const mdot = (j: number): number => JETS[j].thrust / JETS[j].ve;

/**
 * Fly ticks k0..k1 of a duty pattern: the world records every tick on the tape (as the session will), the renderer
 * runs one pool.frame + consume every `tpf` ticks (frame phase `phase`). The craft coasts in a straight line, so the
 * tick state is exact at any tick. Returns the parcels written.
 */
function fly(pool: PuffPool, tape: DutyTape, dutyAt: (k: number) => ArrayLike<number>, k0: number, k1: number, tpf = 1, phase = 0, w = ZERO): number {
  let n = 0;
  tapeReset(tape, 0, zeros(), NJ, k0 - 1);
  const r = v3(), c: PuffCraft = { r, v: V0, q: { x: 0, y: 0, z: 0, w: 1 }, w };
  const frame = (k: number): void => {
    const t = k * TICK;
    r.x = R0.x + V0.x * t; r.y = R0.y + V0.y * t; r.z = R0.z + V0.z * t;
    pool.frame(t, r, V0, ZERO);
    n += pool.consume(0, c, JETS, tape);
  };
  for (let k = k0; k <= k1; k++) {
    tapeRecord(tape, 0, dutyAt(k), NJ, k);
    if ((k + phase) % tpf === 0) frame(k);
  }
  frame(k1); // the last frame sees everything
  return n;
}

/** Condensate mass (kg) and parcels by kind written since the pool was made. */
function census(pool: PuffPool): { m: number; kinds: number[] } {
  return { m: pool.massOut, kinds: Array.from(pool.countOut) };
}

describe('RCS puffs from the applied duty', () => {
  it('the Wren has 10 jets (the benchmarks use the real count)', () => {
    expect(NJ).toBe(10);
  });

  it('duty 0 makes nothing, ever (no threshold, no idle puffs)', () => {
    const pool = new PuffPool(512);
    expect(fly(pool, createDutyTape(), zeros, 1, 600)).toBe(0);
    expect(pool.liveCount()).toBe(0);
    expect(pool.alive).toBe(false);
  });

  it('edges are crossings of 0 only: a held duty is one opening and one closing, not a valve cycling per tick', () => {
    for (const d of [0.01, 0.1, 0.3, 0.5, 1]) {
      const pool = new PuffPool(65536);
      const on = zeros(); on[0] = d;
      fly(pool, createDutyTape(), (k) => (k >= 10 && k < 130 ? on : zeros()), 1, 140);
      const { m, kinds } = census(pool);
      const prop = mdot(0) * d * 1.0; // 120 ticks = 1 s at duty d
      // the opening bursts happen in the first T_BED only (2 ticks), the closing once
      expect(kinds[PUFF_ON]).toBe(Math.ceil((ETA_BED * d * TICK) / T_PARCEL - 1e-9) + Math.ceil((ETA_BED * d * (T_BED - TICK)) / T_PARCEL - 1e-9));
      expect(kinds[PUFF_OFF]).toBeGreaterThan(0);
      // condensate of a 1 s hold: cold bed + dribble + 0.2% steady — a few % of the propellant at most, never fog
      expect(m / prop).toBeLessThan(0.02 / d + 0.01);
      expect(m).toBeLessThanOrEqual(prop * (1 + 1e-6));
    }
  });

  it('condensate never exceeds the propellant that passed, for every duty and pulse length', () => {
    for (const d of [0.003, 0.01, 0.1, 0.3, 0.6, 1]) {
      for (const len of [1, 2, 3, 5, 12, 60]) {
        const pool = new PuffPool(65536);
        const on = zeros(); on[3] = d;
        // ten pulses of `len` ticks, 20 ticks apart
        fly(pool, createDutyTape(), (k) => (k >= 10 && (k - 10) % (len + 20) < len && k < 10 + 10 * (len + 20) ? on : zeros()), 1, 10 + 10 * (len + 20) + 5);
        const prop = mdot(3) * d * len * TICK * 10;
        expect(pool.massOut).toBeLessThanOrEqual(prop * (1 + 1e-9));
        expect(pool.massOut).toBeGreaterThan(0); // no threshold: even 0.3% for one tick shows (faintly)
      }
    }
  });

  it('frame-rate and frame-phase independent: the same tick history gives the same parcels at 1–4 ticks/frame', () => {
    // two-tick pulses every 0.1 s and single-tick 0.6 pulses: both start and end inside a 4-tick frame
    const hist = (k: number): number[] => { const d = zeros(); if (k % 12 < 2) d[0] = 1; if (k % 24 === 5) d[7] = 0.6; return d; };
    const ref = new PuffPool(65536);
    const n1 = fly(ref, createDutyTape(), hist, 1, 240, 1, 0);
    const edges = { on: 0, off: 0 };
    let worldOn = 0;
    for (let k = 1, prev = zeros(); k <= 240; k++) { const d = hist(k); jetEdgeMasks(prev, d, NJ, edges); worldOn += ((edges.on & 1) ? 1 : 0) + ((edges.on >> 7) & 1); prev = d; }
    expect(worldOn).toBe(31); // 21 two-tick pulses on jet 0, 10 single-tick ones on jet 7
    const c1 = census(ref);
    for (const tpf of [2, 3, 4]) {
      for (let phase = 0; phase < tpf; phase++) {
        const pool = new PuffPool(65536);
        const n = fly(pool, createDutyTape(), hist, 1, 240, tpf, phase);
        expect(n).toBe(n1);
        expect(pool.massOut).toBe(ref.massOut);
        const c = census(pool);
        expect(c.kinds).toEqual(c1.kinds);
        // same births: absolute positions now agree to float32 rounding of anchor-relative km (anchors differ)
        let worst = 0, alive = 0;
        const Ar = ref.anchorPos(240 * TICK, v3()), Ap = pool.anchorPos(240 * TICK, v3());
        const pr = v3(), pp = v3();
        for (let i = 0; i < n; i++) {
          const o = i * PUFF_STRIDE;
          if (ref.data[o + 7] < ref.now || pool.data[o + 7] < pool.now) continue;
          alive++;
          ref.parcelPos(i, pr); pool.parcelPos(i, pp);
          worst = Math.max(worst, Math.abs(Ar.x + pr.x - Ap.x - pp.x), Math.abs(Ar.y + pr.y - Ap.y - pp.y), Math.abs(Ar.z + pr.z - Ap.z - pp.z));
        }
        expect(alive).toBeGreaterThan(50);
        expect(worst).toBeLessThan(0.02);
      }
    }
  });

  it('a clean pulse makes condensate at its two edges, a little in between', () => {
    const pool = new PuffPool(4096);
    const on = zeros(); on[2] = 1;
    fly(pool, createDutyTape(), (k) => (k >= 10 && k < 70 ? on : zeros()), 1, 80);
    const { kinds, m } = census(pool);
    expect(kinds[PUFF_ON]).toBe(11); // 0.5·8.33 ms → 9 parcels, then 0.5·1.67 ms → 2
    expect(kinds[PUFF_OFF]).toBe(10); // the full dribble volume, 5 ms of full flow
    // 0.2 % of 0.5 s = 1 ms → 2 parcels of 0.5 ms (the fractional accumulator may land just below 2)
    expect(kinds[PUFF_STEADY]).toBeGreaterThanOrEqual(1);
    expect(kinds[PUFF_STEADY]).toBeLessThanOrEqual(2);
    const edge = mdot(2) * (ETA_BED * T_BED + 0.005);
    expect(m).toBeCloseTo(edge + mdot(2) * kinds[PUFF_STEADY] * T_PARCEL, 6);
  });

  it('parcel velocity = nozzle velocity (v + ω × r) + f·vₑ·d̂ inside the cone, and no drag', () => {
    const pool = new PuffPool(2048);
    const tape = createDutyTape();
    const w = v3(0.02, -0.05, 0.03); // body rates, rad/s
    const j = 0;
    const on = zeros(); on[j] = 1;
    const k = 100;
    fly(pool, tape, (kk) => (kk === k + 1 ? on : zeros()), k, k + 1, 1, 0, w);
    const J = JETS[j];
    const wxr = v3(w.y * J.pos.z - w.z * J.pos.y, w.z * J.pos.x - w.x * J.pos.z, w.x * J.pos.y - w.y * J.pos.x);
    const V = pool.anchorVel(pool['tNow'] as number, v3());
    let n = 0;
    for (let i = 0; i < pool.capacity; i++) {
      const o = i * PUFF_STRIDE;
      if (pool.data[o + 7] < -1e8 || pool.data[o + 11] !== PUFF_ON) continue;
      n++;
      const ex = pool.data[o + 4] + V.x - (V0.x + wxr.x);
      const ey = pool.data[o + 5] + V.y - (V0.y + wxr.y);
      const ez = pool.data[o + 6] + V.z - (V0.z + wxr.z);
      const sp = Math.hypot(ex, ey, ez);
      expect(sp).toBeGreaterThan(F_ON_LO * J.ve * 0.999);
      expect(sp).toBeLessThan(F_ON_HI * J.ve * 1.001);
      expect((ex * J.dir.x + ey * J.dir.y + ez * J.dir.z) / sp).toBeGreaterThan(Math.cos(CONE_ON) - 1e-6);
    }
    expect(n).toBe(9);
    const p0 = pool.parcelPos(0, v3());
    const t1 = (k + 1) * TICK + 0.05;
    pool.frame(t1, v3(R0.x + V0.x * t1, R0.y + V0.y * t1, R0.z + V0.z * t1), V0, ZERO); // no re-base
    const p1 = pool.parcelPos(0, v3());
    expect(p1.x - p0.x).toBeCloseTo(pool.data[4] * 0.05, 3);
    expect(p1.z - p0.z).toBeCloseTo(pool.data[6] * 0.05, 3);
  });

  it('parcels are inertial: the player\'s later motion and anchor re-bases do not move them (free fall)', () => {
    const pool = new PuffPool(2048);
    const tape = createDutyTape();
    const g = v3(-8.2, 0.3, 1.1);
    const c: PuffCraft = { r: R0, v: V0, q: { x: 0, y: 0, z: 0, w: 1 }, w: ZERO };
    const on = zeros(); on[5] = 1;
    const k = 50;
    tapeReset(tape, 0, zeros(), NJ, k);
    pool.frame(k * TICK, R0, V0, g);
    tapeRecord(tape, 0, on, NJ, k + 1);
    tapeRecord(tape, 0, zeros(), NJ, k + 2);
    pool.frame((k + 2) * TICK, R0, V0, g);
    pool.consume(0, c, JETS, tape);
    let best = -1, end = -1;
    for (let i = 0; i < pool.capacity; i++) {
      const o = i * PUFF_STRIDE;
      if (pool.data[o + 11] === PUFF_OFF && pool.data[o + 7] > end) { end = pool.data[o + 7]; best = i; }
    }
    expect(best).toBeGreaterThanOrEqual(0);
    const abs = (t: number): V3 => {
      const A = pool.anchorPos(t, v3());
      const p = pool.parcelPos(best, v3());
      return v3(A.x + p.x, A.y + p.y, A.z + p.z);
    };
    const t0 = (k + 2) * TICK + 0.02;
    pool.frame(t0, R0, V0, g);
    const P0 = abs(t0);
    const o = best * PUFF_STRIDE;
    const VA = pool.anchorVel(t0, v3());
    const U = v3(pool.data[o + 4] + VA.x, pool.data[o + 5] + VA.y, pool.data[o + 6] + VA.z);
    const rebases0 = pool.rebases;
    const T = 0.2;
    expect(end - (pool.now + T)).toBeGreaterThan(0);
    const r2 = v3(R0.x + V0.x * T + 1900, R0.y + 0.5 * g.y * T * T - 400, R0.z + V0.z * T + 1200);
    const v2 = v3(V0.x + 60, V0.y - 15, V0.z + 22);
    pool.frame(t0 + T, r2, v2, g);
    expect(pool.rebases).toBe(rebases0 + 1);
    const P1 = abs(t0 + T);
    expect(Math.abs(P1.x - (P0.x + U.x * T + 0.5 * g.x * T * T))).toBeLessThan(0.01);
    expect(Math.abs(P1.y - (P0.y + U.y * T + 0.5 * g.y * T * T))).toBeLessThan(0.01);
    expect(Math.abs(P1.z - (P0.z + U.z * T + 0.5 * g.z * T * T))).toBeLessThan(0.01);
  });

  it('is deterministic: the same duty history gives bit-identical parcels', () => {
    const pat = (k: number): number[] => JETS.map((_, j) => ((k * 7 + j * 13) % 11) / 10 * (k % 5 < 3 ? 1 : 0));
    const a = new PuffPool(1024), b = new PuffPool(1024);
    fly(a, createDutyTape(), pat, 1, 300, 2);
    fly(b, createDutyTape(), pat, 1, 300, 2);
    const ua = new Uint32Array(a.data.buffer), ub = new Uint32Array(b.data.buffer);
    let same = ua.length === ub.length;
    for (let i = 0; same && i < ua.length; i++) same = ua[i] === ub[i];
    expect(same).toBe(true);
    expect(a.liveCount()).toBeGreaterThan(0);
  });

  it('stays inside its emission budget under heavy pulsing (fewer, heavier parcels; mass conserved)', () => {
    const small = new PuffPool(256), big = new PuffPool(65536);
    const pat = (k: number): number[] => JETS.map(() => (k % 6 < 3 ? 0.5 : 0));
    fly(small, createDutyTape(), pat, 1, 60);
    fly(big, createDutyTape(), pat, 1, 60);
    expect(small.massOut / big.massOut).toBeCloseTo(1, 9);
  });

  it('closed-form life ends where even a forward-lit centre falls below the radiance floor', () => {
    expect(OMEGA0 * PHASE_MAX * (1 - Math.exp(-TAU_END))).toBeCloseTo(F_MIN, 15);
    const m = 7.5e-3, s0 = 0.27, w = 1200;
    const life = parcelLife(m, s0, w);
    const s = s0 + w * life;
    expect((KAPPA * m) / (2 * Math.PI * s * s)).toBeCloseTo(TAU_END, 12);
    expect(parcelLife(m, s0, 1)).toBe(LIFE_MAX);
    expect(tauFloor(hgPhase(-1))).toBeGreaterThan(700 * TAU_END);
  });

  it('brightness: Henyey–Greenstein g = 0.8 is normalised, forward-bright, and nothing shows in shadow', () => {
    let I = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) { const mu = -1 + (2 * (i + 0.5)) / N; I += hgPhase(mu) * 2 * Math.PI * (2 / N); }
    expect(I).toBeCloseTo(1, 4);
    expect(hgPhase(1)).toBeCloseTo((1 - HG_G * HG_G) / (4 * Math.PI * (1 - HG_G) ** 3), 10);
    expect(hgPhase(1) / hgPhase(-1)).toBeGreaterThan(700);
    expect(parcelRadiance(5, 0.7, 0)).toBe(0);
    expect(parcelRadiance(5, 0.7, 1)).toBeGreaterThan(0);
  });

  it('the hull shadows a puff on its far side from the sun (capsule occluders), in the shader twin too', () => {
    const occ = new Float32Array(32);
    const n = packOccluders(WREN_OCCLUDERS, { x: 0, y: 0, z: 0, w: 1 }, 0, 0, 0, occ);
    expect(n).toBe(2);
    const fus = WREN_OCCLUDERS[0];
    expect(rayCapsuleDist2(0, -4, 0, 0, 1, 0, fus.a.x, fus.a.y, fus.a.z, fus.b.x, fus.b.y, fus.b.z)).toBeLessThan(fus.radius ** 2);
    expect(rayCapsuleDist2(4, -4, 0, 0, 1, 0, fus.a.x, fus.a.y, fus.a.z, fus.b.x, fus.b.y, fus.b.z)).toBeGreaterThan(fus.radius ** 2);
    expect(rayCapsuleDist2(0, 4, 0, 0, 1, 0, fus.a.x, fus.a.y, fus.a.z, fus.b.x, fus.b.y, fus.b.z)).toBeGreaterThan(fus.radius ** 2);
    for (const J of JETS) for (const o of WREN_OCCLUDERS) {
      expect(rayCapsuleDist2(J.pos.x, J.pos.y, J.pos.z, 0, 0, 0, o.a.x, o.a.y, o.a.z, o.b.x, o.b.y, o.b.z, 1e-9)).toBeGreaterThan(o.radius ** 2);
    }
    expect(CONE_OFF).toBeGreaterThan(CONE_ON);
    // a real pulse, the sun straight down the jet's exhaust axis on the far side of the hull: the twin draws less
    const pool = new PuffPool(4096);
    const tape = createDutyTape();
    const jd = JETS.findIndex((J) => J.dir.y < -0.5); // a jet exhausting downward
    expect(jd).toBeGreaterThanOrEqual(0);
    const on = zeros(); on[jd] = 1;
    const c: PuffCraft = { r: v3(), v: v3(), q: { x: 0, y: 0, z: 0, w: 1 }, w: v3() };
    tapeReset(tape, 0, zeros(), NJ, 0);
    for (let k = 1; k <= 8; k++) tapeRecord(tape, 0, k <= 4 ? on : zeros(), NJ, k);
    pool.frame(0.03, c.r, c.v, ZERO);
    pool.consume(0, c, JETS, tape);
    pool.frame(0.06, c.r, c.v, ZERO);
    const cam: PuffCam = { p: v3(60, -10, 0), right: v3(0, 0, -1), up: v3(0, 1, 0), fwd: v3(-1, 0, 0), px: 1000, shutter: 0 };
    const sc = new Float64Array(4);
    const sunUp = v3(0, 1, 0);
    const lit = puffFillPx(pool, cam, sunUp, 1, 1, null, 0, sc);
    const shaded = puffFillPx(pool, cam, sunUp, 1, 1, occ, n, sc);
    expect(lit).toBeGreaterThan(0);
    expect(shaded).toBeLessThan(lit);
    expect(puffFillPx(pool, cam, sunUp, 0, 1, null, 0, sc)).toBe(0); // planet shadow: nothing
  });

  it('GPU fill is bounded: the floor rises just enough to keep the drawn pixels ≤ the budget, and only when needed', () => {
    const W = 1179, H = 2556, budget = PUFF_FILL_SCREENS * W * H;
    const scenes: [string, (k: number) => number[]][] = [
      ['all jets at 0.5', () => JETS.map(() => 0.5)],
      ['all jets 3-tick pulses', (k) => JETS.map(() => (k % 9 < 3 ? 1 : 0))],
      ['yaw hold 0.3 on two jets', () => { const d = zeros(); d[0] = 0.3; d[5] = 0.3; return d; }],
    ];
    const sc = new Float64Array(4);
    let raised = 0, honestFits = 0;
    for (const [, pat] of scenes) {
      const pool = new PuffPool(2048);
      const tape = createDutyTape();
      const c: PuffCraft = { r: v3(), v: v3(), q: { x: 0, y: 0, z: 0, w: 1 }, w: v3() };
      tapeReset(tape, 0, zeros(), NJ, 0);
      for (let k = 1; k <= 240; k++) {
        tapeRecord(tape, 0, pat(k), NJ, k);
        pool.frame(k * TICK, c.r, c.v, ZERO);
        pool.consume(0, c, JETS, tape);
        expect(pool.liveBound).toBeGreaterThanOrEqual(pool.liveCount());
        if (k % 8) continue;
        // chase cam 64 m aft looking forward into the sun (forward scatter: the brightest case), and 3 m off the nose
        for (const cam of [
          { p: v3(0, 14, 64), right: v3(1, 0, 0), up: v3(0, 0.976, -0.213), fwd: v3(0, -0.213, -0.976), px: 0.5 * H / Math.tan(27.5 * Math.PI / 180), shutter: 1 / 60 },
          { p: v3(0, 0.5, -14), right: v3(1, 0, 0), up: v3(0, 1, 0), fwd: v3(0, 0, -1), px: 0.5 * H / Math.tan(27.5 * Math.PI / 180), shutter: 1 / 60 },
        ]) {
          const sun = v3(-cam.fwd.x, -cam.fwd.y, -cam.fwd.z);
          const phi = solvePuffFloor(pool, cam, sun, 1, budget, null, 0);
          const drawn = puffFillPx(pool, cam, sun, 1, phi, null, 0, sc, pool.quadCapPx); // exactly what the shader covers
          expect(drawn).toBeLessThanOrEqual(budget * (1 + 1e-9));
          expect(drawn).toBeLessThanOrEqual(pool.fillPx * (1 + 1e-9));
          if (phi > 1) { raised++; expect(pool.fillHonest).toBeGreaterThan(budget); expect(drawn).toBeGreaterThan(0.25 * budget); } // ≥ budget − one quad share (a quad leaves at once at x = 0.1σ)
          else { honestFits++; expect(drawn).toBeCloseTo(pool.fillHonest, 3); }
        }
      }
    }
    expect(raised).toBeGreaterThan(0);
    expect(honestFits).toBeGreaterThan(0);
  });

  it('robust: a NaN frame is ignored, a load keeps the first edge after it, a bad slot throws', () => {
    const pool = new PuffPool(2048);
    const tape = createDutyTape();
    const c: PuffCraft = { r: R0, v: V0, q: { x: 0, y: 0, z: 0, w: 1 }, w: ZERO };
    const on = zeros(); on[1] = 1;
    tapeReset(tape, 0, zeros(), NJ, 100);
    pool.frame(100 * TICK, R0, V0, ZERO);
    pool.frame(NaN, R0, V0, ZERO);
    pool.frame(101 * TICK, v3(NaN, 0, 0), V0, ZERO);
    expect(pool.rejected).toBe(2);
    tapeRecord(tape, 0, on, NJ, 101);
    pool.frame(101 * TICK, R0, V0, ZERO);
    expect(pool.consume(0, c, JETS, tape)).toBeGreaterThan(0);
    expect(pool.alive).toBe(true);
    // load to an earlier tick: the session resets the tape (seeded with the loaded jetDuty = 0) and the pool
    pool.reset();
    tapeReset(tape, 0, zeros(), NJ, 40);
    tapeRecord(tape, 0, on, NJ, 41); // the jet opens on the first tick after the load
    pool.frame(41 * TICK, R0, V0, ZERO);
    const n = pool.consume(0, c, JETS, tape);
    expect(n).toBe(9); // the opening is kept
    // a tape tick that jumps back without a reset starts a new epoch: no invented edge
    tapeRecord(tape, 0, zeros(), NJ, 20);
    pool.frame(20 * TICK, R0, V0, ZERO); // > 1 tick back: the pool resets itself
    expect(pool.consume(0, c, JETS, tape)).toBe(0);
    expect(() => pool.consume(DUTY_TAPE_SLOTS, c, JETS, tape)).toThrow(RangeError);
    expect(() => tapeRecord(tape, -1, on, NJ, 1)).toThrow(RangeError);
  });
});

describe('main plume from engineLevel', () => {
  it('held at 0.5 the brightness is the same every frame (no spool, kick or flicker)', () => {
    const f0 = plumeExitFactor(0.5, 400e3, 34e3, 1.15);
    for (let i = 0; i < 100; i++) expect(plumeExitFactor(0.5, 400e3, 34e3, 1.15)).toBe(f0);
    expect(f0).toBeCloseTo(0.25, 12); // ∝ ṁ²: two-body emission
    expect(plumeExitFactor(1, 400e3, 34e3, 1.15)).toBeCloseTo(1, 12);
    expect(plumeExitFactor(0.15, 400e3, 34e3, 1.15)).toBeCloseTo(0.0225, 12);
    expect(plumeExitFactor(0, 400e3, 34e3, 1.15)).toBe(0);
  });

  it('expands freely in vacuum: column ∝ R⁻³, length where it thins to 1e-4, no shock cells', () => {
    const t = Math.tan((15 * Math.PI) / 180);
    expect(plumeAxisColumn(0)).toBe(1);
    expect(plumeAxisColumn(10, t) * (1 + 10 * t) ** 3).toBeCloseTo(1, 12);
    const L = plumeLength(t);
    expect(plumeAxisColumn(L, t)).toBeCloseTo(1e-4, 10);
    // numerical transverse column of ε matches the closed form √(π/2)/R³
    const z = 6, R = 1 + z * t;
    let col = 0;
    for (let i = -4000; i <= 4000; i++) col += plumeEmissivity((i / 4000) * 4 * R, z, t) * (4 * R / 4000);
    expect(col / (Math.sqrt(Math.PI / 2) / R ** 3)).toBeCloseTo(1, 6);
    expect(shockCellSpacing(2.3, 3e3, 0)).toBe(0);
    expect(shockCellSpacing(2.3, 4e4, 1e5)).toBeCloseTo(1.3 * 2.3 * Math.sqrt(0.4), 12);
    // the shader's cell spacing in nozzle radii is the same for every nozzle: 2.6·√(p_e/p_a); 0 in vacuum
    expect(plumeCellRadii(0)).toBe(0);
    expect(plumeCellRadii(1e5, 3e3) * 1.15).toBeCloseTo(shockCellSpacing(2.3, 3e3, 1e5), 12);
  });

  it('brightness from each engine\'s own mass flow: a small hull at its own thrust is not 8.7× the Wren', () => {
    // a hull with 0.56 m nozzles at the Wren's 400 kN / 34 km/s would be (1.15/0.56)³ = 8.7× brighter at the exit;
    // at a thrust that scales with its exit area (same exit pressure) it is (0.56/1.15)·… of the Wren instead
    const wrong = plumeExitFactor(1, 400e3, 34e3, 0.56);
    expect(wrong).toBeCloseTo((1.15 / 0.56) ** 3, 6);
    const F = 400e3 * (0.56 / 1.15) ** 2;
    expect(plumeExitFactor(1, F, 34e3, 0.56)).toBeCloseTo(0.56 / 1.15, 6);
  });
});

describe('hologram, light balance, sheath, washout, lids, clocks', () => {
  it('a linear radial scale: the start orbit\'s orbit-to-globe ratio is 1.084 on the display (the old map fails)', () => {
    const s = createSession();
    const f = s.flight();
    const body = s.bodies().find((b) => b.id === f.primaryId)!;
    const me = s.craft().find((c) => c.isPlayer)!;
    const r = Math.hypot(me.r.x - body.r.x, me.r.y - body.r.y, me.r.z - body.r.z);
    const bodyR = body.def.radius;
    const Rd = 0.085, ext = r * 1.02; // hologram.ts: R and the fitted path extent
    // what hologram.ts will draw: the globe at holoDisplayRadius(bodyR, s), the ship's orbit at holoDisplayRadius(r, s)
    const sc = holoScale(Rd, bodyR, ext);
    const ratio = holoDisplayRadius(r, sc) / holoDisplayRadius(bodyR, sc);
    expect(ratio).toBeCloseTo(1.084, 3);
    expect(holoDisplayRadius(ext, sc)).toBeCloseTo(Rd, 12);
    // negative control: hologram.ts's current map (globe at 0.42 R, altitude compressed a/(a+k)) shows ≈ 2.4
    const g0 = Rd * 0.42, k = bodyR * 0.25, amax = Math.max(1, ext - bodyR), fmax = amax / (amax + k);
    const rmap = (x: number): number => { const a = Math.max(0, x - bodyR); return x < bodyR ? (g0 * x) / bodyR : g0 + ((Rd - g0) * (a / (a + k))) / Math.max(1e-6, fmax); };
    const old = rmap(r) / g0;
    expect(Math.abs(old - 1.084)).toBeGreaterThan(0.5);
  });

  it('zoom box rings come in round km', () => {
    expect(roundKmStep(10e3)).toBe(2000);
    expect(roundKmStep(1.2e3)).toBe(1000);
    expect(roundKmStep(60e3)).toBe(20000);
    const z = holoZoom(25e3, 0.03, { scale: 0, ringStep: 0, rings: 0 });
    expect(z.ringStep).toBe(5000);
    expect(z.rings).toBe(5);
    expect(z.scale).toBeCloseTo(0.03 / 25e3, 15);
  });

  it('Lambert phase and unresolved worlds', () => {
    expect(lambertPhase(0)).toBeCloseTo(1, 15);
    expect(lambertPhase(Math.PI / 2)).toBeCloseTo(1 / Math.PI, 15);
    expect(lambertPhase(Math.PI)).toBeCloseTo(0, 15);
    expect(unresolvedIlluminance(1000, 0.3, 6e6, 6e8, 0)).toBeCloseTo(1000 * 0.3 * 1e-4, 12);
  });

  it('sheath: along the air velocity, instantaneous, 0 the frame heatFlux reaches 0', () => {
    const d = sheathDir(v3(3, 0, -4), v3());
    expect(d.x).toBeCloseTo(0.6, 15);
    expect(d.z).toBeCloseTo(-0.8, 15);
    expect(sheathIntensity(7000, 1e6)).toBe(1);
    expect(sheathIntensity(7000, 4e6)).toBe(2);
    expect(sheathIntensity(2500, 1e6)).toBe(0);
    expect(sheathIntensity(7000, 0)).toBe(0);
  });

  it('screen washout: 3.7:1 at 300 cd/m² in 3.5e4 lx, ≈ 10:1 once auto-brightness reaches 1000', () => {
    expect(veilLuminance(3.5e4)).toBeCloseTo(111.4, 1);
    expect(screenContrast(300, 3.5e4)).toBeCloseTo(3.69, 2);
    expect(screenContrast(1000, 3.5e4)).toBeCloseTo(9.98, 2);
    expect(autoBrightnessTarget(3.5e4)).toBe(1000);
    expect(autoBrightnessTarget(0)).toBe(10);
    const g = { L: 300 };
    stepAutoBrightness(g, 3.5e4, 1);
    expect(g.L).toBeCloseTo(1000 - 700 * Math.exp(-1), 9);
    // exact at any step size: 10 steps of 0.1 s = one of 1 s
    const h = { L: 300 };
    for (let i = 0; i < 10; i++) stepAutoBrightness(h, 3.5e4, 0.1);
    expect(h.L).toBeCloseTo(g.L, 9);
  });

  it('eyelids pass red, not blue; relaxations are exact; the cloud phase never snaps', () => {
    const lid = eyelidTransmission(1, [0, 0, 0]);
    expect(lid[0]).toBeCloseTo(0.04, 12);
    expect(lid[1]).toBeCloseTo(0.004, 12);
    expect(lid[2]).toBeCloseTo(0.004, 12);
    expect(eyelidTransmission(0, [0, 0, 0])).toEqual([1, 1, 1]);
    let x = 0;
    for (let i = 0; i < 8; i++) x = relaxExact(x, 1, 0.125, 0.5);
    expect(x).toBeCloseTo(relaxExact(0, 1, 1, 0.5), 12);
    const rate = 2 * Math.PI / 86400;
    let prev = phaseNoWrap(0, rate);
    for (let t = 997; t < 2 * 86400 + 5; t += 997) {
      const p = phaseNoWrap(t, rate);
      const dp = ((p - prev + 3 * Math.PI) % (2 * Math.PI)) - Math.PI; // shortest step
      expect(Math.abs(dp - 997 * rate)).toBeLessThan(1e-9);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(2 * Math.PI);
      prev = p;
    }
  });

  it('photometry: blackbody efficacy, the star on the glass, and the pipeline\'s lux ↔ render calibration', () => {
    expect(blackbodyEfficacy(3482)).toBeCloseTo(36.7, 0);
    expect(blackbodyEfficacy(5772)).toBeGreaterThan(90);
    expect(blackbodyEfficacy(5772)).toBeLessThan(95);
    // Sol at 1 AU: 1361 W/m² × ≈ 92 lm/W ≈ 125 klx
    const E = starIlluminanceLux(1, 1.495978707e11, 5772);
    expect(E / 1e3).toBeGreaterThan(120);
    expect(E / 1e3).toBeLessThan(130);
    expect(glassIlluminance(E, 0, 1, 0.9)).toBe(0); // night side
    expect(glassIlluminance(E, 1, -0.3, 0.9)).toBe(0); // glass facing away
    expect(glassIlluminance(4e4, 1, 0.5, 0.9)).toBeCloseTo(1.8e4, 6);
    // a white Lambert surface at key level L under E lx shows E/π cd/m² = L render units
    expect(renderPerNit(1.3, 4e4) * (4e4 / Math.PI)).toBeCloseTo(1.3, 12);
  });

  it('cockpitScreensVisible: inside the room facing the glass yes; facing away, behind it or outside no', () => {
    // a 90° camera at the pilot's eye (0, 1, −13) looking −Z; one screen quad at z = −14.2 facing +Z
    const room = [-1.7, -0.4, -15, 1.7, 2.1, -11.6];
    const glass = [-0.3, 0.6, -14.2, 0.3, 0.6, -14.2, 0.3, 1.0, -14.2, -0.3, 1.0, -14.2];
    const proj = (fwdSign: number): Float64Array => {
      // view-projection for a camera at (0,1,−13) looking along ∓Z (perspective, n 0.05, f 100, fov 90°, aspect 1)
      const n = 0.05, f = 100;
      const P = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -(f + n) / (f - n), -1, 0, 0, (-2 * f * n) / (f - n), 0];
      // view: rotate 180° about y when looking +Z, then translate by −eye
      const s = fwdSign; // +1: looking −Z
      const Vw = [s, 0, 0, 0, 0, 1, 0, 0, 0, 0, s, 0, 0, -1, s * 13, 1]; // column-major
      const M = new Float64Array(16);
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let a = 0; for (let k = 0; k < 4; k++) a += P[k * 4 + r] * Vw[c * 4 + k]; M[c * 4 + r] = a; }
      return frustumPlanes(M, new Float64Array(24));
    };
    const eye = v3(0, 1, -13);
    expect(cockpitScreensVisible(eye, proj(1), room, glass, 1)).toBe(true);
    expect(cockpitScreensVisible(eye, proj(-1), room, glass, 1)).toBe(false); // looking aft
    expect(cockpitScreensVisible(v3(0, 1, -14.6), proj(1), room, glass, 1)).toBe(false); // behind the glass
    expect(cockpitScreensVisible(v3(0, 14, 64), proj(1), room, glass, 1)).toBe(false); // chase cam: outside the hull
  });

  it('eyes-closed frame fields: shut above 0.999, and waking asks for an RT history reset', () => {
    const f = { eyesClosed: false, lid: 0 };
    expect(setEyeFields(f, 0.5).eyesClosed).toBe(false);
    expect(setEyeFields(f, 1).eyesClosed).toBe(true);
    expect(setEyeFields(f, NaN).lid).toBe(0);
    expect(eyesTransition(false, true)).toBe(EYES_CLOSING);
    expect(eyesTransition(true, false)).toBe(EYES_WAKE);
    expect(eyesTransition(true, true)).toBe(EYES_SAME);
  });
});
