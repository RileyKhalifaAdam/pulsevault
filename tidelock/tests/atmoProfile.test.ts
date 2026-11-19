// W2-B layered atmosphere profile (src/world/atmoProfile.ts): hydrostatics, Earth check, Wick, tableTop vs atm.top.
import { describe, expect, it } from 'vitest';
import { generateGalaxy, getSystem } from '../src/sim/universe';
import {
  AT_A, AT_ALT, AT_M, AT_MFP, AT_P, AT_RHO, AT_T, R_GAS, TABLE_TOP_RHO, atmoAt, buildAtmoProfile, makeAtmoIO,
} from '../src/world/atmoProfile';
import { airDensity } from '../src/world/atmosphere';

const MU_E = 3.986004418e14, R_E = 6.371e6, TS_E = 288.15, M_E = 0.02897;
const G_E = MU_E / (R_E * R_E);
const H_E = (R_GAS * TS_E) / (M_E * G_E);
const earth = buildAtmoProfile({ surfaceDensity: 1.225, scaleHeight: H_E, mu: MU_E, radius: R_E, surfaceTemp: TS_E, molarMass: M_E });
const io = makeAtmoIO();
const at = (z: number): Float64Array => { io[AT_ALT] = z; atmoAt(earth, io); return io; };

describe('layered atmosphere', () => {
  it('is hydrostatic: p₀ = ρ₀·g·H₀ and the column weighs p₀ (∫ρ g dz) within 1%', () => {
    expect(Math.abs(earth.p0 / (earth.rho0 * earth.g0 * earth.H0) - 1)).toBeLessThan(1e-9);
    // column mass by the trapezoid rule on a 100 m grid up to the table top, with g(z)
    let col = 0, prev = at(0)[AT_RHO] * G_E;
    for (let z = 100; z <= earth.tableTop; z += 100) {
      const r = R_E + z, g = MU_E / (r * r), f = at(z)[AT_RHO] * g;
      col += 50 * (prev + f); prev = f;
    }
    console.log(`Earth: p₀ ${earth.p0.toFixed(0)} Pa, column ∫ρg dz ${col.toFixed(0)} Pa, tableTop ${(earth.tableTop / 1e3).toFixed(0)} km, ρ=1e-7 at ${(earth.z1e7 / 1e3).toFixed(1)} km`);
    expect(Math.abs(col / earth.p0 - 1)).toBeLessThan(0.01);
    // local check dp/dz = −ρ g at a few heights
    for (const z of [5e3, 30e3, 80e3, 150e3, 400e3]) {
      const p1 = at(z - 50)[AT_P], p2 = at(z + 50)[AT_P];
      const r = R_E + z, g = MU_E / (r * r);
      const rho = at(z)[AT_RHO];
      expect(Math.abs((p2 - p1) / 100 / (-rho * g) - 1)).toBeLessThan(0.01);
    }
  });

  it('matches Earth: tropopause, stratopause, ρ(100 km) within ×1.5 of 5.6e-7, thermosphere', () => {
    const row = (z: number): string => { const o = at(z); return `${(z / 1e3).toFixed(0)} km: ρ ${o[AT_RHO].toExponential(2)} T ${o[AT_T].toFixed(0)} K M ${(o[AT_M] * 1e3).toFixed(1)} a ${o[AT_A].toFixed(0)} m/s`; };
    console.log([0, 12.6e3, 50e3, 86e3, 100e3, 150e3, 300e3, 400e3, 547e3].map(row).join('\n'));
    expect(at(12.6e3)[AT_T]).toBeGreaterThan(200); expect(at(12.6e3)[AT_T]).toBeLessThan(212); // 288 − 6.5×12.6 ≈ 206 K
    expect(Math.abs(at(6 * earth.H0)[AT_T] - 0.94 * TS_E)).toBeLessThan(2); // stratopause knot at 6·H₀ ≈ 50 km (smoothed by the 1.8 km table)
    const r100 = at(100e3)[AT_RHO];
    expect(r100 / 5.6e-7).toBeLessThan(1.5); expect(r100 / 5.6e-7).toBeGreaterThan(1 / 1.5);
    expect(Math.abs(at(11e3)[AT_RHO] / 0.3639 - 1)).toBeLessThan(0.03); // US-76 at 11 km
    expect(Math.abs(at(0)[AT_A] - 340.3)).toBeLessThan(1);
    const r400 = at(400e3)[AT_RHO];
    expect(r400).toBeGreaterThan(1e-12); expect(r400).toBeLessThan(1e-11); // MSIS, T_exo ≈ 1000 K: 2.8e-12 … 4e-12
    expect(at(earth.tableTop + 1)[AT_RHO]).toBe(0);
    expect(at(earth.tableTop * 0.999)[AT_RHO]).toBeLessThan(10 * TABLE_TOP_RHO);
    expect(at(1e3)[AT_MFP]).toBeLessThan(1e-6);
  });

  it('is continuous: no step anywhere, drag reaches exactly 0 at the top', () => {
    let worst = 0;
    for (let z = 0; z < earth.tableTop; z += 37) {
      const a = at(z)[AT_RHO], b = at(z + 1)[AT_RHO];
      if (a > 1e-14) worst = Math.max(worst, Math.abs(Math.log(b / a)));
    }
    expect(worst).toBeLessThan(1e-3); // ≤ 0.1% per metre (H ≥ 6 km)
    expect(at(earth.tableTop)[AT_RHO]).toBe(0);
  });

  it('Wick: the table reaches past 547 km, atm.top stays where stations were placed, no air event at 547 km', () => {
    const system = getSystem(generateGalaxy(1), 'tallow')!;
    const wick = system.bodies.find((b) => b.id === 'tallow.wick')!;
    const atm = wick.atmosphere!;
    const mu = 6.6743e-11 * wick.mass;
    const P = buildAtmoProfile({ surfaceDensity: atm.surfaceDensity, scaleHeight: atm.scaleHeight, mu, radius: wick.radius, surfaceTemp: wick.temperature });
    const o = makeAtmoIO();
    const rho = (z: number): number => { o[AT_ALT] = z; atmoAt(P, o); return o[AT_RHO]; };
    o[AT_ALT] = 0; atmoAt(P, o);
    const a0 = o[AT_A];
    console.log(`Wick: T_s ${wick.temperature.toFixed(0)} K, M ${(P.M0 * 1e3).toFixed(2)} g/mol, H₀ ${(atm.scaleHeight / 1e3).toFixed(2)} km, p₀ ${(P.p0 / 1e3).toFixed(1)} kPa, ` +
      `atm.top ${(atm.height / 1e3).toFixed(0)} km (old exponential), layered ρ=1e-7 at ${(P.z1e7 / 1e3).toFixed(0)} km, tableTop ${(P.tableTop / 1e3).toFixed(0)} km; ` +
      `ρ(420 km) ${rho(420e3).toExponential(2)}, ρ(547 km) ${rho(547e3).toExponential(2)}, a₀ ${a0.toFixed(0)} m/s`);
    expect(Math.abs(P.p0 / 0.94e5 - 1)).toBeLessThan(0.01);
    expect(P.tableTop).toBeGreaterThan(547e3);
    expect(rho(547e3)).toBeGreaterThan(0);
    // atm.top is NOT derived from the profile: the old exponential is exactly 0 there, the profile keeps going
    expect(airDensity({ surfaceDensity: atm.surfaceDensity, scaleHeight: atm.scaleHeight, height: atm.height }, atm.height)).toBe(0);
    expect(547e3).toBeGreaterThan(atm.height); // the 'atmosphere' situation (gated on atm.top) does not fire at 547 km
    // the Wheel's placement uses atm.height + altitude: unchanged by construction (this file never writes it)
  });

  it('builds deterministically and quickly; atmoAt costs tens of ns and allocates nothing', async () => {
    const t0 = performance.now();
    const P2 = buildAtmoProfile({ surfaceDensity: 1.225, scaleHeight: H_E, mu: MU_E, radius: R_E, surfaceTemp: TS_E, molarMass: M_E });
    const tb = performance.now() - t0;
    expect(Array.from(P2.lnRho)).toEqual(Array.from(earth.lnRho));
    const o = makeAtmoIO();
    let s = 0;
    for (let i = 0; i < 1e6; i++) { o[AT_ALT] = (i % 5000) * 100; atmoAt(earth, o); s += o[AT_RHO]; }
    const t1 = performance.now();
    for (let i = 0; i < 4e6; i++) { o[AT_ALT] = (i % 5000) * 100; atmoAt(earth, o); s += o[AT_RHO]; }
    const ns = ((performance.now() - t1) / 4e6) * 1e6;
    console.log(`atmo profile build ${tb.toFixed(1)} ms; atmoAt ${ns.toFixed(1)} ns (node)`);
    expect(s).toBeGreaterThan(0);
    expect(ns).toBeLessThan(200);
    const gc: number[] = [];
    const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) gc.push(e.startTime); });
    obs.observe({ entryTypes: ['gc'] });
    const g0 = performance.now();
    for (let i = 0; i < 2e6; i++) { o[AT_ALT] = (i % 9000) * 100; atmoAt(earth, o); }
    const g1 = performance.now();
    await new Promise((r) => setTimeout(r, 50));
    obs.disconnect();
    expect(gc.filter((t) => t >= g0 && t <= g1).length).toBe(0);
  });
});
