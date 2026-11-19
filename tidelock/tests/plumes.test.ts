// W1-E honest exhaust: the pure core (src/render/space/plumeCore.ts) and the small laws (src/render/space/honest.ts).
import { describe, expect, it } from 'vitest';
import type { V3 } from '../src/core/types';
import { SHIP_LAYOUTS } from '../src/data/shipLayouts';
import { createSession } from '../src/game';
import { jetsFromLayout } from '../src/world/jets';
import {
  CONE_ON,
  CONE_OFF,
  F_ON_HI,
  F_ON_LO,
  HG_G,
  KAPPA,
  N_EDGE_OFF,
  N_EDGE_ON,
  PUFF_OFF,
  PUFF_ON,
  PUFF_STRIDE,
  PuffPool,
  TAU_END,
  TICK,
  WREN_OCCLUDERS,
  hgPhase,
  packOccluders,
  parcelLife,
  parcelRadiance,
  plumeAxisColumn,
  plumeEmissivity,
  plumeExitFactor,
  plumeLength,
  rayCapsuleDist2,
  shockCellSpacing,
  type PuffCraft,
} from '../src/render/space/plumeCore';
import {
  autoBrightnessTarget,
  eyelidTransmission,
  holoScale,
  holoZoom,
  lambertPhase,
  phaseNoWrap,
  relaxExact,
  roundKmStep,
  screenContrast,
  sheathDir,
  sheathIntensity,
  stepAutoBrightness,
  unresolvedIlluminance,
  veilLuminance,
} from '../src/render/space/honest';

const JETS = jetsFromLayout(SHIP_LAYOUTS.wren.rcs);
const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const craft = (): PuffCraft => ({ r: v3(1.5e11, 2e3, -4e6), v: v3(-3e4, 0, 7.8e3), q: { x: 0, y: 0, z: 0, w: 1 }, w: v3() });
const ZERO = v3();

/** Fly `ticks` ticks of a duty pattern (one pool.frame + emit per tick, sim time = tick·Q). */
function run(pool: PuffPool, c: PuffCraft, dutyAt: (k: number) => number[], k0: number, k1: number, g = ZERO): number {
  let n = 0;
  for (let k = k0; k <= k1; k++) {
    const t = k * TICK;
    const r = { x: c.r.x + c.v.x * (t - k0 * TICK), y: c.r.y + c.v.y * (t - k0 * TICK), z: c.r.z + c.v.z * (t - k0 * TICK) };
    pool.frame(t, r, c.v, g);
    n += pool.emit(0, { ...c, r }, JETS, dutyAt(k), k);
  }
  return n;
}

describe('RCS puffs from the applied duty', () => {
  it('duty 0 makes nothing, ever (no threshold, no idle puffs)', () => {
    const pool = new PuffPool(512);
    const zero = new Array(JETS.length).fill(0);
    expect(run(pool, craft(), () => zero, 0, 600)).toBe(0);
    expect(pool.liveCount()).toBe(0);
    expect(pool.alive).toBe(false);
  });

  it('a tiny duty still makes condensate (no 0.25 threshold): one opening and one closing per tick', () => {
    const pool = new PuffPool(2048);
    const d = new Array(JETS.length).fill(0);
    d[0] = 0.01;
    const n = run(pool, craft(), (k) => (k >= 10 && k < 12 ? d : new Array(JETS.length).fill(0)), 0, 12);
    expect(n).toBe(2 * (N_EDGE_ON + N_EDGE_OFF));
  });

  it('a clean pulse makes condensate at its two edges, a little in between', () => {
    const pool = new PuffPool(2048);
    const on = new Array(JETS.length).fill(0);
    on[2] = 1;
    const off = new Array(JETS.length).fill(0);
    const nEdges = run(pool, craft(), (k) => (k >= 10 && k < 70 ? on : off), 0, 80);
    // 0.5 s fully open: 10 + 10 edge parcels and ETA_STEADY·0.5 s / T_PARCEL = 2 steady parcels
    // (the steady accumulator is fractional: 60 × 0.0333… lands on 1 or 2)
    const kinds = [0, 0, 0];
    for (let i = 0; i < nEdges; i++) kinds[pool.data[i * PUFF_STRIDE + 11]]++;
    expect(kinds[PUFF_ON]).toBe(N_EDGE_ON);
    expect(kinds[PUFF_OFF]).toBe(N_EDGE_OFF);
    expect(kinds[2]).toBeGreaterThanOrEqual(1);
    expect(kinds[2]).toBeLessThanOrEqual(2);
  });

  it('parcel velocity = nozzle velocity (v + ω × r) + f·vₑ·d̂ inside the cone, and no drag', () => {
    const pool = new PuffPool(2048);
    const c = craft();
    c.w = v3(0.02, -0.05, 0.03); // body rates, rad/s
    const d = new Array(JETS.length).fill(0);
    const j = 0;
    d[j] = 1;
    const k = 100;
    pool.frame(k * TICK, c.r, c.v, ZERO);
    pool.emit(0, c, JETS, new Array(JETS.length).fill(0), k);
    pool.frame((k + 1) * TICK, c.r, c.v, ZERO);
    const n = pool.emit(0, c, JETS, d, k + 1);
    expect(n).toBe(N_EDGE_ON);
    const J = JETS[j];
    const wxr = v3(c.w.y * J.pos.z - c.w.z * J.pos.y, c.w.z * J.pos.x - c.w.x * J.pos.z, c.w.x * J.pos.y - c.w.y * J.pos.x);
    const V = pool.anchorVel(pool['tNow'] as number, v3());
    for (let i = 0; i < n; i++) {
      const o = i * PUFF_STRIDE;
      // u is anchor-relative: back to inertial, minus the nozzle velocity
      const ex = pool.data[o + 4] + V.x - (c.v.x + wxr.x);
      const ey = pool.data[o + 5] + V.y - (c.v.y + wxr.y);
      const ez = pool.data[o + 6] + V.z - (c.v.z + wxr.z);
      const sp = Math.hypot(ex, ey, ez);
      // float32 storage of a ~3e4 m/s anchor-relative velocity: ~2 mm/s; the exhaust part is ≥ 675 m/s
      expect(sp).toBeGreaterThan(F_ON_LO * J.ve * 0.999);
      expect(sp).toBeLessThan(F_ON_HI * J.ve * 1.001);
      const cos = (ex * J.dir.x + ey * J.dir.y + ez * J.dir.z) / sp;
      expect(cos).toBeGreaterThan(Math.cos(CONE_ON) - 1e-6);
    }
    // ballistic: positions advance linearly in time (CPU twin of the shader)
    const p0 = pool.parcelPos(0, v3());
    pool.frame((k + 1) * TICK + 0.05, c.r, c.v, ZERO);
    const p1 = pool.parcelPos(0, v3());
    const o = 0;
    expect(p1.x - p0.x).toBeCloseTo(pool.data[o + 4] * 0.05, 3);
    expect(p1.z - p0.z).toBeCloseTo(pool.data[o + 6] * 0.05, 3);
  });

  it('parcels are inertial: the player\'s later motion and anchor re-bases do not move them (free fall)', () => {
    const pool = new PuffPool(2048);
    const c = craft();
    const g = v3(-8.2, 0.3, 1.1);
    const d = new Array(JETS.length).fill(0);
    d[5] = 1;
    const k = 50;
    pool.frame(k * TICK, c.r, c.v, g);
    pool.emit(0, c, JETS, new Array(JETS.length).fill(0), k);
    pool.frame((k + 1) * TICK, c.r, c.v, g);
    pool.emit(0, c, JETS, d, k + 1);
    pool.frame((k + 2) * TICK, c.r, c.v, g);
    pool.emit(0, c, JETS, new Array(JETS.length).fill(0), k + 2);
    // the dribble parcels (closing at the start of tick k + 2) live ~0.2–1.2 s: pick the longest-lived one
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
    const t0 = (k + 2) * TICK + 0.01;
    pool.frame(t0, c.r, c.v, g);
    const P0 = abs(t0);
    const o = best * PUFF_STRIDE;
    const V0 = pool.anchorVel(t0, v3());
    const U = v3(pool.data[o + 4] + V0.x, pool.data[o + 5] + V0.y, pool.data[o + 6] + V0.z);
    // the player now burns sideways and drifts far off; the anchor re-bases (> 2 km away) onto that new state
    const rebases0 = pool.rebases;
    const T = 0.2;
    expect(end - (pool.now + T)).toBeGreaterThan(0); // still alive then
    const r2 = v3(c.r.x + c.v.x * T + 1900, c.r.y + 0.5 * g.y * T * T - 400, c.r.z + c.v.z * T + 1200);
    const v2 = v3(c.v.x + 60, c.v.y - 15, c.v.z + 22);
    pool.frame(t0 + T, r2, v2, g);
    expect(pool.rebases).toBe(rebases0 + 1);
    const P1 = abs(t0 + T);
    // free fall in a uniform field: P0 + U·T + ½gT²
    const ex = P0.x + U.x * T + 0.5 * g.x * T * T, ey = P0.y + U.y * T + 0.5 * g.y * T * T, ez = P0.z + U.z * T + 0.5 * g.z * T * T;
    // float32 storage of anchor-relative values of a few km: ~1 mm
    expect(Math.abs(P1.x - ex)).toBeLessThan(0.01);
    expect(Math.abs(P1.y - ey)).toBeLessThan(0.01);
    expect(Math.abs(P1.z - ez)).toBeLessThan(0.01);
  });

  it('is deterministic: the same duty history gives bit-identical parcels', () => {
    const pat = (k: number): number[] => JETS.map((_, j) => ((k * 7 + j * 13) % 11) / 10 * (k % 5 < 3 ? 1 : 0));
    const a = new PuffPool(1024), b = new PuffPool(1024);
    run(a, craft(), pat, 0, 300);
    run(b, craft(), pat, 0, 300);
    const ua = new Uint32Array(a.data.buffer), ub = new Uint32Array(b.data.buffer);
    let same = ua.length === ub.length;
    for (let i = 0; same && i < ua.length; i++) same = ua[i] === ub[i];
    expect(same).toBe(true);
    expect(a.liveCount()).toBeGreaterThan(0);
  });

  it('stays inside its budget under heavy pulsing (fewer, heavier parcels; mass conserved)', () => {
    const pool = new PuffPool(512);
    const half = new Array(JETS.length).fill(0.5);
    const c = craft();
    pool.frame(0, c.r, c.v, ZERO);
    pool.emit(0, c, JETS, half, 0);
    pool.frame(TICK, c.r, c.v, ZERO);
    const n = pool.emit(0, c, JETS, half, 1);
    // unscaled: 14 jets × 20 edge parcels = 280 in one tick; budget = 512·Q/0.6 ≈ 7 → one per burst
    expect(n).toBeLessThanOrEqual(2 * JETS.length);
    let K = 0;
    for (let i = 0; i < n; i++) K += pool.data[i * PUFF_STRIDE + 10];
    let want = 0;
    for (const J of JETS) want += (N_EDGE_ON + N_EDGE_OFF) * (KAPPA * (J.thrust / J.ve) * 5e-4) / (2 * Math.PI);
    expect(K / want).toBeCloseTo(1, 5);
  });

  it('closed-form life: the centre optical depth reaches TAU_END exactly then', () => {
    const m = 7.5e-3, s0 = 0.27, w = 120;
    const life = parcelLife(m, s0, w);
    const s = s0 + w * life;
    expect((KAPPA * m) / (2 * Math.PI * s * s)).toBeCloseTo(TAU_END, 12);
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

  it('the hull shadows a puff on its far side from the sun (capsule occluders)', () => {
    const occ = new Float32Array(32);
    const n = packOccluders(WREN_OCCLUDERS, { x: 0, y: 0, z: 0, w: 1 }, 0, 0, 0, occ);
    expect(n).toBe(2);
    const sun = v3(0, 1, 0); // sun overhead
    const fus = WREN_OCCLUDERS[0];
    // a puff under the belly: the fuselage is between it and the sun
    expect(rayCapsuleDist2(0, -4, 0, sun.x, sun.y, sun.z, fus.a.x, fus.a.y, fus.a.z, fus.b.x, fus.b.y, fus.b.z)).toBeLessThan(fus.radius ** 2);
    // a puff off the starboard side at the same height: clear
    expect(rayCapsuleDist2(4, -4, 0, sun.x, sun.y, sun.z, fus.a.x, fus.a.y, fus.a.z, fus.b.x, fus.b.y, fus.b.z)).toBeGreaterThan(fus.radius ** 2);
    // above the hull: clear (the ray goes away from it)
    expect(rayCapsuleDist2(0, 4, 0, sun.x, sun.y, sun.z, fus.a.x, fus.a.y, fus.a.z, fus.b.x, fus.b.y, fus.b.z)).toBeGreaterThan(fus.radius ** 2);
    // every jet nozzle sits outside the occluders (puffs are born lit when the sun is on that side)
    for (const J of JETS) for (const o of WREN_OCCLUDERS) {
      expect(rayCapsuleDist2(J.pos.x, J.pos.y, J.pos.z, 0, 0, 0, o.a.x, o.a.y, o.a.z, o.b.x, o.b.y, o.b.z, 1e-9)).toBeGreaterThan(o.radius ** 2);
    }
    expect(CONE_OFF).toBeGreaterThan(CONE_ON);
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
  });
});

describe('hologram, light balance, sheath, washout, lids, clocks', () => {
  it('a linear radial scale: the start orbit\'s orbit-to-globe ratio is 1.084', () => {
    const s = createSession();
    const f = s.flight();
    const body = s.bodies().find((b) => b.id === f.primaryId)!;
    const me = s.craft().find((c) => c.isPlayer)!;
    const r = Math.hypot(me.r.x - body.r.x, me.r.y - body.r.y, me.r.z - body.r.z);
    const R = body.def.radius;
    const sc = holoScale(0.085, R, r * 1.02);
    expect((r * sc) / (R * sc)).toBeCloseTo(1.084, 3);
    expect(r * 1.02 * sc).toBeCloseTo(0.085, 12);
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
});
