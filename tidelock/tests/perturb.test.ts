// W2-B ambient-pressure thrust (src/world/nozzle.ts), station gravity and weak drag as a coast perturbation
// (src/world/perturb.ts).
import { describe, expect, it } from 'vitest';
import { AT_ALT, AT_RHO, R_GAS, atmoAt, buildAtmoProfile, makeAtmoIO } from '../src/world/atmoProfile';
import { YC1, YC2, YD1, YD2 } from '../src/world/ephemeris';
import {
  ENGINE_EXIT_AREA, NZ_K, NZ_LEN, NZ_PA, NZ_PC, RCS_EPS, RCS_GAMMA, RCS_PC0, SEPARATION, areaRatioOfMach,
  buildNozzleTable, jetAreas, magneticThrust, nozzleK, pRatioOfMach,
} from '../src/world/nozzle';
import {
  G_NEWTON, SG_AX, SG_AY, SG_AZ, SG_DX, SG_DY, SG_DZ, SG_GM, SG_LEN, SG_RB, STATION_GRAVITY_RANGE, WEAK_DRAG_ACCEL,
  dragKick, stationGravity,
} from '../src/world/perturb';

describe('ambient-pressure thrust', () => {
  it('the magnetic drive loses exactly p_a·A_e: 781 kN of 800 kN at Wick sea level (D1: a landing is one-way)', () => {
    const pa = 0.94e5;
    const per = magneticThrust(400e3, pa);
    expect(400e3 - per).toBeCloseTo(pa * ENGINE_EXIT_AREA, 6);
    const lost = 800e3 - 2 * per;
    console.log(`magnetic nozzle at 94 kPa: ${(lost / 1e3).toFixed(0)} kN lost, ${(2 * per / 1e3).toFixed(1)} kN left of 800 kN (A_e ${ENGINE_EXIT_AREA.toFixed(2)} m² per pod)`);
    expect(Math.abs(lost - 781e3)).toBeLessThan(2e3);
    expect(magneticThrust(400e3, 0)).toBe(400e3);
    expect(magneticThrust(100e3, pa)).toBe(0); // throttled down at sea level: nothing, never negative
    expect(magneticThrust(0, pa)).toBe(0);
  });

  it('a wall nozzle loses p_a·A_e while attached, less once separated (Summerfield), and is continuous', () => {
    const T = buildNozzleTable(RCS_EPS, RCS_GAMMA);
    expect(areaRatioOfMach(1, RCS_GAMMA)).toBeCloseTo(1, 12);
    expect(T.cfVac).toBeGreaterThan(1.75); expect(T.cfVac).toBeLessThan(2.0);
    const nz = new Float64Array(NZ_LEN);
    const k = (pa: number, pc = RCS_PC0): number => { nz[NZ_PA] = pa; nz[NZ_PC] = pc; nozzleK(T, nz); return nz[NZ_K]; };
    expect(k(0)).toBe(1);
    // attached: F_vac − F = p_a·A_e exactly (per unit p_c·A_t: x·ε)
    const pAttached = 0.5 * (T.pe * RCS_PC0) / SEPARATION; // below the separation onset
    const F0 = 17e3, A = jetAreas(T, F0);
    expect(Math.abs(F0 * (1 - k(pAttached)) / (pAttached * A.exit) - 1)).toBeLessThan(2e-3);
    // sea level: separated; the loss is smaller than p_a·A_e, the jet still pushes
    const ks = k(0.94e5);
    const lossSea = F0 * (1 - ks), naive = 0.94e5 * A.exit;
    console.log(`hydrazine jet (ε ${RCS_EPS}, p_c ${RCS_PC0 / 1e6} MPa, p_e ${(T.pe * RCS_PC0 / 1e3).toFixed(1)} kPa, A_e ${A.exit.toFixed(3)} m²): sea level k = ${ks.toFixed(3)}; loss ${(lossSea / 1e3).toFixed(1)} kN vs p_a·A_e ${(naive / 1e3).toFixed(1)} kN; empty tank (p/p₀ = 1/3) k = ${k(0.94e5, RCS_PC0 / 3).toFixed(3)}`);
    expect(lossSea).toBeLessThan(naive);
    expect(ks).toBeGreaterThan(0.5); expect(ks).toBeLessThan(1);
    expect(k(0.94e5, RCS_PC0 / 3)).toBeLessThan(ks); // blowdown: lower chamber pressure, more loss
    let prev = 1;
    for (let pa = 0; pa < 1.9e6; pa += 100) {
      const v = k(pa);
      expect(v).toBeLessThanOrEqual(prev + 1e-12);
      expect(prev - v).toBeLessThan(0.01); // no jumps
      prev = v;
    }
    expect(pRatioOfMach(0, 1.4)).toBe(1);
  });
});

describe('station gravity', () => {
  it('is −GM·d/|d|³ outside, ∝ r inside, tapers smoothly to 0 at 50 km', () => {
    const sg = new Float64Array(SG_LEN);
    const gm = G_NEWTON * 1e10;
    const a = (x: number): number => { sg[SG_DX] = x; sg[SG_DY] = 0; sg[SG_DZ] = 0; sg[SG_GM] = gm; sg[SG_RB] = 450; stationGravity(sg); return sg[SG_AX]; };
    expect(a(682) / (-gm / 682 ** 2)).toBeCloseTo(1, 12);
    console.log(`1e10 kg station at 682 m: ${(-a(682)).toExponential(2)} m/s²`);
    expect(a(225) / a(450)).toBeCloseTo(0.5, 12);
    expect(a(STATION_GRAVITY_RANGE)).toBe(0);
    expect(Math.abs(a(39999.9) / (-gm / 39999.9 ** 2) - 1)).toBeLessThan(1e-6);
    let prev = a(40e3);
    for (let x = 40e3; x <= 50e3; x += 10) { const v = a(x); expect(Math.abs(v - prev)).toBeLessThan(1e-12); prev = v; }
    sg[SG_DY] = 3; void SG_AY; void SG_AZ; void SG_DZ;
  });

  it('drives the Clohessy–Wiltshire drift −1.5·f·t² along-track within 5%', () => {
    const mu = 1.1 * 3.986004418e14, r0 = 6.9e6, n = Math.sqrt(mu / r0 ** 3), m = 1e10, sep = 5000;
    const sg = new Float64Array(SG_LEN);
    // planar 2-body, RK4 at 2 s; the station leads on the same circular orbit
    const st = (t: number, o: number[]): void => { const ph = n * t + sep / r0; o[0] = r0 * Math.cos(ph); o[1] = r0 * Math.sin(ph); };
    const acc = (s: number[], t: number, withSt: boolean, out: number[]): void => {
      const r2 = s[0] * s[0] + s[1] * s[1], k = -mu / (r2 * Math.sqrt(r2));
      out[0] = s[2]; out[1] = s[3]; out[2] = k * s[0]; out[3] = k * s[1];
      if (withSt) {
        const p = [0, 0]; st(t, p);
        sg[SG_DX] = s[0] - p[0]; sg[SG_DY] = s[1] - p[1]; sg[SG_DZ] = 0; sg[SG_GM] = G_NEWTON * m; sg[SG_RB] = 450;
        stationGravity(sg); out[2] += sg[SG_AX]; out[3] += sg[SG_AY];
      }
    };
    const step = (s: number[], t: number, h: number, w: boolean): void => {
      const k1 = [0, 0, 0, 0], k2 = [0, 0, 0, 0], k3 = [0, 0, 0, 0], k4 = [0, 0, 0, 0];
      acc(s, t, w, k1);
      acc(s.map((x, i) => x + 0.5 * h * k1[i]), t + h / 2, w, k2);
      acc(s.map((x, i) => x + 0.5 * h * k2[i]), t + h / 2, w, k3);
      acc(s.map((x, i) => x + h * k3[i]), t + h, w, k4);
      for (let i = 0; i < 4; i++) s[i] += (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
    };
    const v0 = n * r0;
    const a = [r0, 0, 0, v0], b = [r0, 0, 0, v0];
    const tEnd = 4 * 2 * Math.PI / n, h = 2;
    let t = 0;
    while (t < tEnd - 1e-9) { step(a, t, h, true); step(b, t, h, false); t += h; }
    const ph = Math.atan2(b[1], b[0]);
    const along = -(a[0] - b[0]) * Math.sin(ph) + (a[1] - b[1]) * Math.cos(ph);
    const f = (G_NEWTON * m) / sep ** 2;
    const pred = -1.5 * f * t * t;
    console.log(`station gravity drift over 4 orbits at ${sep} m: ${along.toFixed(2)} m along-track (CW −1.5·f·t² = ${pred.toFixed(2)} m)`);
    expect(Math.abs(along / pred - 1)).toBeLessThan(0.05);
  });
});

describe('weak drag as a coast perturbation', () => {
  it('kick–drift–kick around the symplectic coast step matches fine forced integration of the decay within 2%', () => {
    const mu = 3.986004418e14, R = 6.371e6, Ts = 288.15, M = 0.02897;
    const P = buildAtmoProfile({ surfaceDensity: 1.225, scaleHeight: (R_GAS * Ts) / (M * (mu / (R * R))), mu, radius: R, surfaceTemp: Ts, molarMass: M });
    const io = makeAtmoIO();
    const bc = 90 / 62200; // the Wren's free-molecular F/q over its mass, m²/kg
    const da = { x: 0, y: 0, z: 0 };
    const drag = (x: number, y: number, vx: number, vy: number): void => {
      io[AT_ALT] = Math.hypot(x, y) - R; atmoAt(P, io);
      const V = Math.hypot(vx, vy), k = -0.5 * io[AT_RHO] * V * bc;
      da.x = k * vx; da.y = k * vy; da.z = 0;
    };
    const r0 = R + 350e3, v0 = Math.sqrt(mu / r0);
    drag(r0, 0, 0, v0);
    const a0 = Math.hypot(da.x, da.y);
    expect(a0).toBeLessThan(WEAK_DRAG_ACCEL);
    const sma = (s: { x: number; y: number; vx: number; vy: number }): number => 1 / (2 / Math.hypot(s.x, s.y) - (s.vx * s.vx + s.vy * s.vy) / mu);
    const grav = (x: number, y: number, o: number[]): void => { const r2 = x * x + y * y, k = -mu / (r2 * Math.sqrt(r2)); o[0] = k * x; o[1] = k * y; };
    const g = [0, 0];
    const yoshida = (s: { x: number; y: number; vx: number; vy: number }, h: number): void => {
      for (const [c, d] of [[YC1, YD1], [YC2, YD2], [YC2, YD1]]) {
        s.x += c * h * s.vx; s.y += c * h * s.vy; grav(s.x, s.y, g); s.vx += d * h * g[0]; s.vy += d * h * g[1];
      }
      s.x += YC1 * h * s.vx; s.y += YC1 * h * s.vy;
    };
    const day = 86400, H = 0.03 * Math.sqrt(r0 ** 3 / mu);
    const N = Math.round(day / H), hh = day / N;
    const kdk = { x: r0, y: 0, vx: 0, vy: v0, vz: 0 }, ref = { x: r0, y: 0, vx: 0, vy: v0, vz: 0 };
    for (let i = 0; i < N; i++) {
      drag(kdk.x, kdk.y, kdk.vx, kdk.vy); dragKick(kdk, da, hh / 2);
      yoshida(kdk, hh); yoshida(ref, hh);
      drag(kdk.x, kdk.y, kdk.vx, kdk.vy); dragKick(kdk, da, hh / 2);
    }
    const dKdk = sma(kdk) - sma(ref);
    // fine forced integration: RK4 with drag at 1 s, minus the same RK4 without drag
    const rk = (s: number[], h: number, withDrag: boolean): void => {
      const f = (u: number[], o: number[]): void => {
        grav(u[0], u[1], g); o[0] = u[2]; o[1] = u[3]; o[2] = g[0]; o[3] = g[1];
        if (withDrag) { drag(u[0], u[1], u[2], u[3]); o[2] += da.x; o[3] += da.y; }
      };
      const k1 = [0, 0, 0, 0], k2 = [0, 0, 0, 0], k3 = [0, 0, 0, 0], k4 = [0, 0, 0, 0];
      f(s, k1); f(s.map((x, i) => x + 0.5 * h * k1[i]), k2); f(s.map((x, i) => x + 0.5 * h * k2[i]), k3); f(s.map((x, i) => x + h * k3[i]), k4);
      for (let i = 0; i < 4; i++) s[i] += (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
    };
    const fa = [r0, 0, 0, v0], fb = [r0, 0, 0, v0];
    for (let i = 0; i < day; i++) { rk(fa, 1, true); rk(fb, 1, false); }
    const smaA = (s: number[]): number => sma({ x: s[0], y: s[1], vx: s[2], vy: s[3] });
    const dFine = smaA(fa) - smaA(fb);
    console.log(`weak drag at 350 km (|a| ${a0.toExponential(2)} m/s²): semi-major axis decay per day ${(-dKdk).toFixed(2)} m with kicks at ${hh.toFixed(1)} s steps (${N} steps), ${(-dFine).toFixed(2)} m fine RK4 at 1 s`);
    expect(dFine).toBeLessThan(-1);
    expect(Math.abs(dKdk / dFine - 1)).toBeLessThan(0.02);
    void AT_RHO;
  });
});
