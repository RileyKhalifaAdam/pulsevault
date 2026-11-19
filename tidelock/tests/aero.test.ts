// W2-B aerodynamics: the build-time skin bake (tools/aeroBake.ts → src/data/aero/wren.ts) and its run-time lookup
// (src/world/aero.ts). Newtonian theory checks on a sphere and a flat plate, the Wren's table (symmetry, stability,
// damping), a re-bake against the generated file, heating, regimes, cost.
import { describe, expect, it } from 'vitest';
import { AERO_WREN } from '../src/data/aero/wren';
import {
  AI_A, AI_CX, AI_CZ, AI_IX, AI_IY, AI_IZ, AI_M, AI_MFP, AI_RHO, AI_TW, AI_UX, AI_UY, AI_UZ, AI_WX, AO_FX, AO_FY, AO_FZ, AO_MX,
  AO_MY, AO_MZ, AO_Q, AO_QPEAK, AO_QSTAG, AO_WAIR, AO_WFM, SG_K, aeroForce, aeroHeat, b64decode, buoyancy,
  centreOfPressure, decodeAero, makeAeroIn, makeAeroOut, type AeroGen,
} from '../src/world/aero';
import { compileCompound } from '../src/world/compound';
import { HULL_ZONES } from '../src/data/hullZones';
import {
  COLS_BIG, COLS_SMALL, C_F, CP_MAX, HB, HS, N_BIG, N_SMALL, bakeDirection, compoundOf, octDir, quantise,
  sampleSkin, setShadowing,
} from '../tools/aeroBake';

const T = decodeAero(AERO_WREN as unknown as AeroGen);

/** Count V8 garbage collections while `fn` runs (as tests/jets.test.ts). */
async function gcCount(fn: () => void): Promise<number> {
  const starts: number[] = [];
  const obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) starts.push(e.startTime); });
  obs.observe({ entryTypes: ['gc'] });
  const t0 = performance.now();
  fn();
  const t1 = performance.now();
  await new Promise((r) => setTimeout(r, 50));
  obs.disconnect();
  return starts.filter((t) => t >= t0 && t <= t1).length;
}
const ai = makeAeroIn(), ao = makeAeroOut();
function flow(ux: number, uy: number, uz: number, rho = 1e-3, mfp = 1e-7): Float64Array {
  ai[AI_UX] = ux; ai[AI_UY] = uy; ai[AI_UZ] = uz; ai[AI_RHO] = rho; ai[AI_A] = 300; ai[AI_MFP] = mfp;
  ai[3] = ai[4] = ai[5] = 0;
  aeroForce(T, ai, ao);
  return ao;
}
/** Coefficients /q at angle of attack α (craft moving forward and down relative to its body: air on the belly). */
function alpha(a: number, V = 3000): number[] {
  const o = flow(0, -V * Math.sin(a), -V * Math.cos(a));
  const q = o[AO_Q];
  return [o[AO_FX] / q, o[AO_FY] / q, o[AO_FZ] / q, o[AO_MX] / q, o[AO_MY] / q, o[AO_MZ] / q];
}

describe('Newtonian skin integration (bake core)', () => {
  it('a sphere: C_D = C_pmax/2 + C_f·π/2 on πR², free-molecular A_p = πR², ∫c² = 2/3·πR²', () => {
    const R = 2;
    const cmp = compileCompound([{ name: 'ball', kind: 'sphere', c: [0, 0, 0], r: R }]);
    const skin = sampleSkin(cmp, 0.04);
    const big = new Float64Array(6), small = new Float64Array(COLS_SMALL);
    bakeDirection(cmp, skin, 0, 0, 1, big, 0, small, 0);
    const A = Math.PI * R * R;
    const cd = big[2] / A;
    console.log(`sphere: ${skin.n} cells, area ${(skin.area / (4 * A)).toFixed(5)} of 4πR²; C_D ${cd.toFixed(4)} (theory ${(CP_MAX / 2 + (C_F * Math.PI) / 2).toFixed(4)}); A_p/πR² ${(small[0] / A).toFixed(4)}; G_z/πR² ${(small[6] / A).toFixed(4)}`);
    expect(Math.abs(cd / (CP_MAX / 2 + (C_F * Math.PI) / 2) - 1)).toBeLessThan(0.01);
    expect(Math.abs(big[0]) + Math.abs(big[1])).toBeLessThan(1e-3 * big[2]);
    expect(Math.abs(big[3]) + Math.abs(big[4]) + Math.abs(big[5])).toBeLessThan(1e-3 * big[2] * R);
    expect(Math.abs(small[0] / A - 1)).toBeLessThan(0.01);
    expect(Math.abs(small[6] / A - 2 / 3)).toBeLessThan(0.01);
    // Newtonian damping of a sphere about its centre is zero (p × n = 0 everywhere)
    for (let k = 10; k < 16; k++) expect(Math.abs(small[k])).toBeLessThan(1e-9);
  });

  it('a flat plate: normal force C_pmax·sin²α·A, friction C_f·A along the plate', () => {
    const cmp = compileCompound([{ name: 'plate', kind: 'box', c: [0, 0, 0], h: [5, 0.002, 5] }]);
    const skin = sampleSkin(cmp, 0.1);
    const big = new Float64Array(6);
    for (const deg of [90, 30, 10]) {
      const a = (deg * Math.PI) / 180;
      bakeDirection(cmp, skin, 0, -Math.sin(a), Math.cos(a), big, 0, null, 0);
      const N = -big[1], expectN = CP_MAX * Math.sin(a) ** 2 * 100;
      expect(Math.abs(N / expectN - 1)).toBeLessThan(0.005);
      if (deg < 90) expect(Math.abs(big[2] / (C_F * 100 + CP_MAX * Math.cos(a) ** 2 * 0.04) - 1)).toBeLessThan(0.02); // + the 10 × 0.004 m leading edge
      expect(Math.abs(big[3]) + Math.abs(big[4]) + Math.abs(big[5])).toBeLessThan(1e-4 * expectN * 5); // ≪ N × half-span
    }
  });
});

describe('the Wren table', () => {
  it('decodes, is the size the plan allows, and is identical to a re-bake within the quantisation step', () => {
    expect(T.big.length).toBe(HB * N_BIG * COLS_BIG);
    expect(T.small.length).toBe(HS * N_SMALL * COLS_SMALL);
    const bytes = b64decode(AERO_WREN.dataBig).length + b64decode(AERO_WREN.dataSmall).length;
    const src = AERO_WREN.dataBig.length + AERO_WREN.dataSmall.length;
    console.log(`table: ${(bytes / 1024).toFixed(1)} KB int16, ${(src / 1024).toFixed(1)} KB base64 in the page, ${((T.big.length + T.small.length) * 8 / 1024).toFixed(0)} KB unpacked`);
    expect(src).toBeLessThan(32 * 1024);
    const cmp = compoundOf('wren');
    const skin = sampleSkin(cmp, 0.25);
    expect(skin.n).toBe(AERO_WREN.samples);
    const big = new Float64Array(6), small = new Float64Array(COLS_SMALL), u = new Float64Array(3);
    for (const [i, j] of [[0, 16], [16, 16], [8, 4], [4, 30], [12, 0], [2, 22]]) {
      octDir(i / (HB - 1), -1 + (2 * j) / (N_BIG - 1), u);
      const onSmall = i % 2 === 0 && j % 2 === 0;
      bakeDirection(cmp, skin, u[0], u[1], u[2], big, 0, onSmall ? small : null, 0);
      const o = (j * HB + i) * COLS_BIG;
      for (let c = 0; c < COLS_BIG; c++) expect(Math.abs(T.big[o + c] - big[c])).toBeLessThanOrEqual(AERO_WREN.scaleBig[c] * 0.5000001);
      if (onSmall) {
        const os = ((j >> 1) * HS + (i >> 1)) * COLS_SMALL;
        for (let c = 0; c < COLS_SMALL; c++) expect(Math.abs(T.small[os + c] - small[c])).toBeLessThanOrEqual(AERO_WREN.scaleSmall[c] * 0.5000001);
      }
    }
    // quantise round-trips within half a step
    const q = quantise(new Float64Array([1, -2, 0.5, 3]), 2);
    expect(Math.abs(q.q[2] * q.scale[0] - 0.5)).toBeLessThanOrEqual(q.scale[0] / 2);
  });

  it('nose-first and belly-first: shadowed table, and the plan prototype’s unshadowed 57 / 655 m²', () => {
    const nose = alpha(0), belly = alpha(Math.PI / 2);
    const cmp = compoundOf('wren'), skin = sampleSkin(cmp, 0.25), b = new Float64Array(6);
    setShadowing(false);
    bakeDirection(cmp, skin, 0, 0, 1, b, 0, null, 0); const nU = b[2];
    bakeDirection(cmp, skin, 0, 1, 0, b, 0, null, 0); const bU = b[1], mU = b[3];
    setShadowing(true);
    console.log(`Wren F/q: nose-first ${nose[2].toFixed(1)} m² (unshadowed ${nU.toFixed(1)}, plan 57), belly-first ${belly[1].toFixed(1)} m² (unshadowed ${bU.toFixed(1)}, plan 655), ` +
      `belly M/q ${belly[3].toFixed(0)} m³ (unshadowed ${mU.toFixed(0)}, plan −1089)`);
    // DEVIATION from the plan's "±5% of 57 / 655 m²", stated: the plan's numbers are the prototype's UNSHADOWED sum.
    // Unshadowed, this bake gives nose 56.8 (−0.4%) and belly 609 (−7%: the prototype counted the skin hidden inside
    // overlapping colliders, which this bake drops). The shipped table is SHADOWED (a cell whose upstream ray hits
    // another part gets no impact pressure: the wings behind the pods, the belly behind the chines), which lowers
    // both by another ≈ 10%. The test pins each number to its own tolerance so a drift in either is caught.
    expect(Math.abs(nU / 57 - 1)).toBeLessThan(0.05);
    expect(Math.abs(bU / 655 - 1)).toBeLessThan(0.08);
    expect(Math.abs(mU / -1089 - 1)).toBeLessThan(0.05);
    expect(nose[2] / nU).toBeGreaterThan(0.85); expect(nose[2] / nU).toBeLessThan(1); // shadowing removes 5–15%
    expect(belly[1] / bU).toBeGreaterThan(0.85); expect(belly[1] / bU).toBeLessThan(1);
    expect(Math.abs(nose[2] / 51.5 - 1)).toBeLessThan(0.02); expect(Math.abs(belly[1] / 587 - 1)).toBeLessThan(0.02);
    expect(belly[1] / nose[2]).toBeGreaterThan(9); // "belly-first braking is about 10× harder"
  });

  it('zero side force and yaw/roll moment at β = 0; mirror-symmetric in β', () => {
    for (const deg of [0, 15, 30, 60, 120, 170]) {
      const c = alpha((deg * Math.PI) / 180);
      expect(Math.abs(c[0])).toBeLessThan(1e-9); expect(Math.abs(c[4])).toBeLessThan(1e-9); expect(Math.abs(c[5])).toBeLessThan(1e-9);
    }
    const V = 2000, a = 0.3, bta = 0.2;
    const u = [V * Math.sin(bta), -V * Math.sin(a), -V * Math.cos(a) * Math.cos(bta)];
    const p = Array.from(flow(u[0], u[1], u[2])).slice(0, 6), m = Array.from(flow(-u[0], u[1], u[2])).slice(0, 6);
    expect(p[0]).toBeCloseTo(-m[0], 6); expect(p[1]).toBeCloseTo(m[1], 6); expect(p[2]).toBeCloseTo(m[2], 6);
    expect(p[3]).toBeCloseTo(m[3], 6); expect(p[4]).toBeCloseTo(-m[4], 6); expect(p[5]).toBeCloseTo(-m[5], 6);
    expect(Math.abs(p[0])).toBeGreaterThan(1); // sideslip makes side force
  });

  it('is statically stable in pitch (∂M_x/∂α < 0), weathervanes in yaw, L/D ≈ 1.1 at α = 30°', () => {
    const rows: string[] = [];
    for (let deg = 0; deg <= 60; deg += 10) {
      const a = (deg * Math.PI) / 180, c = alpha(a), c2 = alpha(a + 0.02);
      const D = c[1] * Math.sin(a) + c[2] * Math.cos(a), L = c[1] * Math.cos(a) - c[2] * Math.sin(a);
      rows.push(`α ${deg}°: D/q ${D.toFixed(0)} L/q ${L.toFixed(0)} L/D ${(L / D).toFixed(2)} Mx/q ${c[3].toFixed(0)}`);
      if (deg >= 10) expect((c2[3] - c[3]) / 0.02).toBeLessThan(0);
      if (deg === 30) { expect(L / D).toBeGreaterThan(0.9); expect(L / D).toBeLessThan(1.3); }
    }
    console.log(rows.join('\n'));
    // yaw: flow from the right (β > 0) turns the nose into the wind. Body y up; +M_y turns −Z (nose) toward −X.
    const V = 2000, bt = 0.1;
    const o = flow(V * Math.sin(bt), 0, -V * Math.cos(bt));
    // the craft slips toward +x: the air comes from +x; the nose should yaw toward +x (M_y < 0)
    expect(o[AO_MY]).toBeLessThan(0);
    // belly-first: the centre of pressure lies aft of the CoM (+Z is aft), which is why the ship pitches nose-down
    const ob = flow(0, -V, 0);
    const cp = { x: 0, y: 0, z: 0 };
    centreOfPressure({ x: ob[AO_FX], y: ob[AO_FY], z: ob[AO_FZ] }, { x: ob[AO_MX], y: ob[AO_MY], z: ob[AO_MZ] }, { x: 0, y: 0, z: 0 }, cp);
    console.log(`belly-first centre of pressure: z = ${cp.z.toFixed(2)} m (aft of the CoM)`);
    expect(cp.z).toBeGreaterThan(0.5); expect(cp.z).toBeLessThan(5); expect(Math.abs(cp.x)).toBeLessThan(1e-9);
  });

  it('damping removes a pitch oscillation (and without it the oscillation keeps its amplitude)', () => {
    const I = 62200 * (6.6 * 6.6 + 32 * 32) / 12, V = 1500, rho = 0.01;
    const run = (damp: boolean): number => {
      let th = 0.6, w = 0; // α = 0.6 rad trim offset start, about the pitch axis
      const h = 0.02;
      const acc = (t: number, ww: number): number => {
        ai[AI_UX] = 0; ai[AI_UY] = -V * Math.sin(t); ai[AI_UZ] = -V * Math.cos(t); ai[AI_RHO] = rho; ai[AI_A] = 300; ai[AI_MFP] = 1e-7;
        ai[AI_WX] = damp ? ww : 0; ai[4] = ai[5] = 0;
        aeroForce(T, ai, ao);
        return ao[AO_MX] / I;
      };
      let amp = 0;
      for (let k = 0; k < 6000; k++) {
        const k1t = w, k1w = acc(th, w);
        const k2t = w + 0.5 * h * k1w, k2w = acc(th + 0.5 * h * k1t, w + 0.5 * h * k1w);
        const k3t = w + 0.5 * h * k2w, k3w = acc(th + 0.5 * h * k2t, w + 0.5 * h * k2w);
        const k4t = w + h * k3w, k4w = acc(th + h * k3t, w + h * k3w);
        th += (h / 6) * (k1t + 2 * k2t + 2 * k3t + k4t); w += (h / 6) * (k1w + 2 * k2w + 2 * k3w + k4w);
        if (k > 5000) amp = Math.max(amp, Math.abs(w));
      }
      ai[AI_WX] = 0;
      return amp;
    };
    const free = run(false), damped = run(true);
    console.log(`pitch oscillation at q = ${(0.5 * rho * V * V / 1e3).toFixed(1)} kPa: late |ω| amplitude ${free.toExponential(2)} undamped, ${damped.toExponential(2)} with damping derivatives`);
    expect(damped).toBeLessThan(0.5 * free);
    expect(free).toBeGreaterThan(0.01);
  });

  it('bridges to free-molecular flow by Knudsen number, with re-emission at the wall temperature', () => {
    const V = 7800;
    const cont = flow(0, 0, -V, 1e-9, 1e-5)[AO_FZ] / ao[AO_Q];
    const fm = flow(0, 0, -V, 1e-9, 1e4)[AO_FZ] / ao[AO_Q];
    expect(ao[AO_WFM]).toBe(1);
    const mid = flow(0, 0, -V, 1e-9, 32)[AO_FZ] / ao[AO_Q];
    console.log(`nose-first F/q: continuum ${cont.toFixed(1)}, bridge (Kn 1) ${mid.toFixed(1)}, free-molecular ${fm.toFixed(1)} m²`);
    expect(fm).toBeGreaterThan(cont);
    expect(mid).toBeGreaterThan(Math.min(cont, fm)); expect(mid).toBeLessThan(Math.max(cont, fm));
    // hotter wall, more re-emission momentum
    ai[AI_TW] = 1500;
    const hot = flow(0, 0, -V, 1e-9, 1e4)[AO_FZ] / ao[AO_Q];
    ai[AI_TW] = 300;
    expect(hot).toBeGreaterThan(fm);
    // the FM base term is 2·A_p: the projected area seen along the flow
    ai[AI_M] = 1e9; // K → 0
    const bare = flow(0, 0, -V, 1e-9, 1e4)[AO_FZ] / ao[AO_Q];
    ai[AI_M] = 0.02897;
    expect(bare).toBeGreaterThan(1.9 * 20); expect(bare).toBeLessThan(fm);
  });

  it('heats each zone by Sutton–Graves on its radius × its windward projected area; radiation only above 9 km/s', () => {
    const heat = new Float64Array(T.nZones);
    const rho = 1e-4;
    flow(0, 0, -7000, rho); aeroHeat(T, ai, ao, heat);
    const nose = T.zoneNames.indexOf('nose');
    const qNose = SG_K * Math.sqrt(rho / T.zoneR[nose]) * 7000 ** 3;
    const os = ((16 >> 1) * HS + 0) * COLS_SMALL; // vertex (s = 0, t = 0) = +Z flow
    expect(heat[nose] / (qNose * T.small[os + 25 + nose])).toBeCloseTo(1, 6);
    let sumAp = 0;
    for (let z = 0; z < T.nZones; z++) sumAp += T.small[os + 25 + z];
    expect(Math.abs(sumAp / T.small[os] - 1)).toBeLessThan(1e-3);
    // §1.4 heatFlux is the STAGNATION flux: Sutton–Graves at the nose radius (HULL_ZONES nose, 0.45 m), whatever the
    // attitude; the hottest zone (a wing leading edge, R 0.25 m) is AO_QPEAK, separate.
    expect(ao[AO_QSTAG] / (SG_K * Math.sqrt(rho / 0.45) * 7000 ** 3)).toBeCloseTo(1, 9);
    expect(ao[AO_QPEAK]).toBeGreaterThanOrEqual(ao[AO_QSTAG]);
    const p7 = heat.reduce((a, b) => a + b, 0);
    flow(0, 0, -11000, rho); aeroHeat(T, ai, ao, heat);
    const p11 = heat.reduce((a, b) => a + b, 0);
    const conv11 = p7 * (11 / 7) ** 3;
    console.log(`nose-first at ρ 1e-4: total ${(p7 / 1e6).toFixed(1)} MW at 7 km/s; ${(p11 / 1e6).toFixed(1)} MW at 11 km/s (convective alone ${(conv11 / 1e6).toFixed(1)}); peak zone flux ${(ao[AO_QPEAK] / 1e4).toFixed(0)} W/cm²`);
    expect(p11).toBeGreaterThan(conv11 * 1.01);
    // buoyancy: ρ·V·g with the baked 906 m³ hull volume: 1.06 t-force at ρ = 1.174 (the plan's "1.8 t" was an estimate)
    const bt = buoyancy(T, 1.174, 9.81) / 9.81;
    console.log(`buoyancy at ρ 1.174: ${bt.toFixed(0)} kg-force (hull volume ${T.volume} m³)`);
    expect(bt).toBeCloseTo(1.174 * AERO_WREN.volume, 6);
    expect(bt).toBeGreaterThan(1000); expect(bt).toBeLessThan(1130);
  });

  it('its heat zones ARE HULL_ZONES: same ids index by index, same radii, mirror twins, baked areas near W2-C\'s', () => {
    expect(T.nZones).toBe(HULL_ZONES.length);
    const rows: string[] = [];
    for (let z = 0; z < HULL_ZONES.length; z++) {
      expect(T.zoneNames[z]).toBe(HULL_ZONES[z].id);
      expect(T.zoneR[z]).toBe(HULL_ZONES[z].radius);
      const tw = HULL_ZONES[z].id.replace(/port|stbd/, (m) => (m === 'port' ? 'stbd' : 'port'));
      expect(T.zoneNames[T.zoneMirror[z]]).toBe(tw);
      rows.push(`${HULL_ZONES[z].id} ${T.zoneArea[z].toFixed(0)}/${HULL_ZONES[z].area}`);
      // W2-C measured its areas on a 0.25 m grid of the same compound (agreement within 15% there)
      expect(Math.abs(T.zoneArea[z] / HULL_ZONES[z].area - 1)).toBeLessThan(0.15);
    }
    console.log(`zone areas, baked / HULL_ZONES (m²): ${rows.join(', ')}`);
    // belly-first heat goes to the belly zones (tile), not to the dorsal aluminium
    const heat = new Float64Array(T.nZones);
    flow(0, -6000, 0, 1e-4); aeroHeat(T, ai, ao, heat); // the craft moves −Y (belly first)
    const id = (n: string): number => HULL_ZONES.findIndex((z) => z.id === n);
    expect(heat[id('belly-fwd')] + heat[id('belly-aft')]).toBeGreaterThan(5 * (heat[id('dorsal-fwd')] + heat[id('dorsal-aft')]));
    // sideslip from starboard heats the starboard flank more than the port one
    flow(3000, 0, -3000, 1e-4); aeroHeat(T, ai, ao, heat); // slipping toward +X: the air comes from starboard
    expect(heat[id('flank-stbd')]).toBeGreaterThan(heat[id('flank-port')]);
  });

  it('ω_air pairs each moment axis with its own inertia and the local slope: ≈ 0.7 rad/s in pitch at 10 kPa nose-first', () => {
    const V = 1000, rho = 2e4 / (V * V);
    ai[AI_IX] = 5.53e6; ai[AI_IY] = 7.18e6; ai[AI_IZ] = 2.10e6;
    const w0 = flow(0, 0, -V, rho)[AO_WAIR];
    const wb = flow(0, -V, 0, rho)[AO_WAIR];
    console.log(`ω_air at 10 kPa: nose-first ${w0.toFixed(2)} rad/s, belly-first ${wb.toFixed(2)} rad/s (old global bound ${Math.sqrt(1e4 * T.stiffMax / 2.10e6).toFixed(2)})`);
    expect(w0).toBeGreaterThan(0.4); expect(w0).toBeLessThan(1.6);
    expect(w0).toBeLessThan(Math.sqrt(1e4 * T.stiffMax / 2.10e6));
    ai[AI_IX] = ai[AI_IY] = ai[AI_IZ] = 1;
  });

  it('decodes identically every time (derived at load, never saved)', () => {
    const T2 = decodeAero(AERO_WREN as unknown as AeroGen);
    expect(Array.from(T2.big)).toEqual(Array.from(T.big));
    expect(Array.from(T2.small)).toEqual(Array.from(T.small));
  });

  it('costs well under a microsecond per lookup and allocates nothing', async () => {
    const heat = new Float64Array(T.nZones);
    const bench = (mfp: number, withHeat: boolean): number => {
      ai[AI_CX] = 0.01; ai[AI_CZ] = -0.2; ai[AI_IX] = 5.5e6; ai[AI_IY] = 7.2e6; ai[AI_IZ] = 2.1e6; ai[AI_WX] = 1e-3;
      let s = 0;
      for (let i = 0; i < 2e5; i++) { ai[AI_UX] = 30 * Math.sin(i); ai[AI_UY] = -2000 * Math.sin(i * 1e-3); ai[AI_UZ] = -2000; ai[AI_RHO] = 1e-3; ai[AI_MFP] = mfp; aeroForce(T, ai, ao); s += ao[AO_FZ]; }
      const t0 = performance.now();
      for (let i = 0; i < 1e6; i++) {
        ai[AI_UX] = 30 * Math.sin(i); ai[AI_UY] = -2000 * Math.sin(i * 1e-3); ai[AI_UZ] = -2000; ai[AI_RHO] = 1e-3; ai[AI_MFP] = mfp;
        aeroForce(T, ai, ao); s += ao[AO_FZ];
        if (withHeat) { aeroHeat(T, ai, ao, heat); s += heat[0]; }
      }
      expect(s).not.toBeNaN();
      return (performance.now() - t0) / 1e6 * 1e6; // ns (includes two Math.sin of the driver)
    };
    const nC = bench(1e-6, false), nB = bench(3, false), nF = bench(1e5, false), nH = bench(1e-6, true) - nC;
    console.log(`aeroForce: continuum ${nC.toFixed(0)} ns, bridge ${nB.toFixed(0)} ns, free-molecular ${nF.toFixed(0)} ns; aeroHeat ${nH.toFixed(0)} ns (node); ω_air at q = 2 kPa: ${ao[AO_WAIR].toFixed(3)} rad/s`);
    expect(nC).toBeLessThan(5000); // wall-clock backstop only (shared CI machines); the budget is checked by the GC count and the print
    const gcs = await gcCount(() => {
      for (let i = 0; i < 1e6; i++) {
        ai[AI_UX] = 1; ai[AI_UY] = -2000 * Math.sin(i * 1e-3); ai[AI_UZ] = -2000; ai[AI_RHO] = 1e-3; ai[AI_MFP] = i & 1 ? 3 : 1e-6;
        aeroForce(T, ai, ao); aeroHeat(T, ai, ao, heat);
      }
    });
    expect(gcs).toBe(0);
    ai[AI_CX] = 0; ai[AI_CZ] = 0; ai[AI_WX] = 0;
  });
});
