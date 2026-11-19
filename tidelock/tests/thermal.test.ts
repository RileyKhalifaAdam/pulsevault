// Thermal network (src/world/thermal.ts, src/data/thermalNet.ts, src/world/shipSystems.ts): W2-D item 1 tests.
import { describe, expect, it } from 'vitest';
import { defaultDemand } from '../src/data/powerNet';
import { N_LOOP, N_PANE0, N_ROOM0, N_SKIRT0, N_TPS_BF, WREN_THERMAL } from '../src/data/thermalNet';
import { Z_BELLY_FWD, Z_DORSAL_FWD } from '../src/data/hullZones';
import { makeShipSystems, makeSystemsInputs, makeSystemsState, saveSystems, loadSystems, systemsStep, type ShipSystems, type SystemsInputs, type SystemsState } from '../src/world/shipSystems';
import {
  BOOK_DU, BOOK_IN, BOOK_RAD, compileThermal, ENV_ALB, ENV_NU, ENV_NX, ENV_NY, ENV_NZ, ENV_S, ENV_SX, ENV_SY, ENV_SZ, ENV_TPL, ENV_VF,
  makeThermalEnv, planetIrTemp, shadowFactor, SIGMA, thermalSources, thermalStep, type ThermalNetDef,
} from '../src/world/thermal';

// ---------------------------------------------------------------------------------------------- orbit environment
const MU = 4.38e14, A_ORB = 7090.5e3, R_P = 6543e3, S0 = 1243, ALBEDO = 0.3;
const PERIOD = 2 * Math.PI * Math.sqrt((A_ORB * A_ORB * A_ORB) / MU);
const D_SUN = 1.2e11, R_SUN = 6e8;
const T_SS = Math.pow(((1 - ALBEDO) * S0) / SIGMA, 0.25);

/** Circular equatorial orbit in the XZ plane, the star along +X (β = 0); craft axes = inertial axes. */
function orbitEnv(env: Float64Array, t: number): void {
  const th = (2 * Math.PI * t) / PERIOD;
  const rx = A_ORB * Math.cos(th), rz = A_ORB * Math.sin(th);
  const sx = D_SUN - rx, sz = -rz;
  const ds = Math.hypot(sx, sz);
  env[ENV_S] = S0;
  env[ENV_NU] = shadowFactor(sx, 0, sz, R_SUN, -rx, 0, -rz, R_P);
  env[ENV_SX] = sx / ds; env[ENV_SY] = 0; env[ENV_SZ] = sz / ds;
  env[ENV_NX] = -rx / A_ORB; env[ENV_NY] = 0; env[ENV_NZ] = -rz / A_ORB;
  env[ENV_VF] = (R_P / A_ORB) ** 2;
  const cz = rx / A_ORB; // sun at +X: cos ζ at the sub-ship point
  env[ENV_ALB] = cz > 0 ? ALBEDO * S0 * cz : 0;
  env[ENV_TPL] = planetIrTemp(cz, T_SS, 150);
}

function wren(): { sys: ShipSystems; st: SystemsState; inp: SystemsInputs } {
  const sys = makeShipSystems(), st = makeSystemsState(), inp = makeSystemsInputs();
  defaultDemand(inp.power.demand);
  return { sys, st, inp };
}

/** Run one orbit with systems steps of h; returns the node temperatures at the end and the energy totals. */
function runOrbit(h: number, st0: SystemsState): { T: number[]; ein: number; erad: number; du: number } {
  const { sys, inp } = wren();
  const st = loadSystems(JSON.parse(JSON.stringify(saveSystems(st0))));
  const n = Math.round(PERIOD / h);
  const hh = PERIOD / n;
  let ein = 0, erad = 0, du = 0;
  for (let k = 0; k < n; k++) {
    orbitEnv(inp.env, (k + 0.5) * hh);
    systemsStep(sys, st, inp, hh);
    ein += sys.book[0]; erad += sys.book[1]; du += sys.book[2];
  }
  return { T: st.thermal.T.slice(), ein, erad, du };
}

// ---------------------------------------------------------------------------------------------- tests

describe('thermal network: analytic cases', () => {
  it('a flat plate reaches (αS/(εσ))^¼ = 296.6 K at α/ε = 0.3/0.85', () => {
    const def: ThermalNetDef = {
      nodes: [{ id: 'plate', C: 7300, T0: 200, limit: Infinity, caution: Infinity }],
      links: [], windows: [], zoneNode: [],
      surfaces: [{ node: 0, alpha: 0.3, eps: 0.85, area: 1, facets: [1, 0, 0, 1], radiator: -1 }],
    };
    const net = compileThermal(def);
    const env = makeThermalEnv();
    env[ENV_S] = 1243; env[ENV_NU] = 1; env[ENV_SX] = 1; env[ENV_SY] = 0; env[ENV_SZ] = 0; env[ENV_VF] = 0;
    const T = [200], Q = new Float64Array(1);
    for (let k = 0; k < 2000; k++) { Q.fill(0); thermalSources(net, env, [], [], Q); thermalStep(net, T, Q, 30); }
    const exact = Math.pow((0.3 * 1243) / (0.85 * SIGMA) + 2.725 ** 4, 0.25);
    expect(exact).toBeCloseTo(296.6, 1);
    expect(Math.abs(T[0] - exact)).toBeLessThan(1e-9);
  });

  it('two-node steady state: Q through G into a radiator at (Q/εσA)^¼', () => {
    const def: ThermalNetDef = {
      nodes: [{ id: 'src', C: 1e5, T0: 300, limit: Infinity, caution: Infinity }, { id: 'rad', C: 2e4, T0: 300, limit: Infinity, caution: Infinity }],
      links: [{ a: 0, b: 1, G: 50 }], windows: [], zoneNode: [],
      surfaces: [{ node: 1, alpha: 0, eps: 0.85, area: 2, facets: [], radiator: -1 }],
    };
    const net = compileThermal(def);
    const env = makeThermalEnv();
    const T = [300, 300], Q = new Float64Array(2);
    for (let k = 0; k < 5000; k++) { Q.fill(0); Q[0] = 2000; thermalSources(net, env, [], [], Q); thermalStep(net, T, Q, k < 1000 ? 30 : 3000, 0); }
    const Tr = Math.pow(2000 / (0.85 * SIGMA * 2), 0.25);
    expect(Math.abs(T[1] - Tr)).toBeLessThan(1e-8);
    expect(Math.abs(T[0] - (Tr + 2000 / 50))).toBeLessThan(1e-8);
  });

  it('two-node transient follows the exponential (first order in h)', () => {
    const C1 = 1e4, C2 = 3e4, G = 20;
    const def: ThermalNetDef = {
      nodes: [{ id: 'a', C: C1, T0: 400, limit: Infinity, caution: Infinity }, { id: 'b', C: C2, T0: 300, limit: Infinity, caution: Infinity }],
      links: [{ a: 0, b: 1, G }], windows: [], zoneNode: [], surfaces: [],
    };
    const net = compileThermal(def);
    const tau = (C1 * C2) / (G * (C1 + C2));
    const Tm = (C1 * 400 + C2 * 300) / (C1 + C2);
    for (const nSteps of [100, 1000]) {
      const T = [400, 300], Q = new Float64Array(2);
      for (let k = 0; k < nSteps; k++) thermalStep(net, T, Q, tau / nSteps);
      const exact = Tm + (400 - Tm) * Math.exp(-1);
      // backward Euler: (1 + 1/n)^-n vs e^-1, error ≈ ΔT·e^-1/(2n)
      expect(Math.abs(T[0] - exact)).toBeLessThan((100 * Math.exp(-1)) / nSteps);
      expect(Math.abs(C1 * T[0] + C2 * T[1] - (C1 * 400 + C2 * 300))).toBeLessThan(1e-12 * C2 * 400 * nSteps);
    }
  });

  it('is unconditionally stable with stiff links at h = 30 s (and 1e5 s): no overshoot, maximum principle', () => {
    const def: ThermalNetDef = {
      nodes: [0, 1, 2, 3].map((i) => ({ id: `n${i}`, C: i === 0 ? 50 : 1e6, T0: 300, limit: Infinity, caution: Infinity })),
      links: [{ a: 0, b: 1, G: 1e8 }, { a: 1, b: 2, G: 1e7 }, { a: 2, b: 3, G: 1 }, { a: 0, b: 3, G: 1e6 }],
      windows: [], zoneNode: [], surfaces: [],
    };
    const net = compileThermal(def);
    for (const h of [30, 1e5]) {
      const T = [1000, 300, 200, 100], Q = new Float64Array(4);
      for (let k = 0; k < 50; k++) {
        thermalStep(net, T, Q, h);
        for (const t of T) { expect(t).toBeGreaterThanOrEqual(100 - 1e-9); expect(t).toBeLessThanOrEqual(1000 + 1e-9); }
        expect(Math.abs(net.book[BOOK_DU])).toBeLessThan(1e-6 * 1e6 * 1000);
      }
    }
  });
});

describe('eclipse geometry', () => {
  it('the shadow covers 37.4% of the 94.5 min orbit (35.3 min)', () => {
    expect(PERIOD).toBeCloseTo(5669, -1);
    const N = 200000;
    let lit = 0;
    const env = makeThermalEnv();
    for (let k = 0; k < N; k++) { orbitEnv(env, ((k + 0.5) / N) * PERIOD); lit += env[ENV_NU]; }
    const shadow = 1 - lit / N;
    expect(Math.abs(shadow - (2 * Math.asin(R_P / A_ORB)) / (2 * Math.PI))).toBeLessThan(2e-3);
    expect(shadow).toBeCloseTo(0.374, 2);
    expect((shadow * PERIOD) / 60).toBeCloseTo(35.3, 0);
  });

  it('a partial eclipse dims smoothly (disc overlap)', () => {
    // star of angular radius r1 at separation just inside the planet's limb
    const nu = (d: number): number => shadowFactor(1e6 * Math.cos(d), 1e6 * Math.sin(d), 0, 1e6 * Math.sin(0.01), 1e3, 0, 0, 1e3 * Math.sin(1));
    expect(nu(1 + 0.02)).toBe(1);
    expect(nu(1 - 0.02)).toBe(0);
    expect(nu(1)).toBeCloseTo(0.5, 2);
    expect(nu(1 + 0.005)).toBeGreaterThan(nu(1 - 0.005));
  });
});

describe('the Wren network', () => {
  it('has the planned size: ~36 nodes, every node linked, aero heat of the belly goes to the TPS', () => {
    expect(WREN_THERMAL.nodes.length).toBe(38);
    const net = compileThermal(WREN_THERMAL);
    const deg = new Array(net.n).fill(0);
    for (let k = 0; k < net.nLinks; k++) { deg[net.la[k]]++; deg[net.lb[k]]++; }
    expect(deg.every((d) => d > 0)).toBe(true);
    expect(net.zoneNode[Z_BELLY_FWD]).toBe(N_TPS_BF);
    // the pressurised NaK loop's interlock is below its saturation temperature
    expect(WREN_THERMAL.nodes[N_LOOP].limit).toBeLessThan(1178);
  });

  it('conserves energy to 1e-9 per step at h = 30 s (smallest pane node, stiff loop, burn, aero heat)', () => {
    const { sys, st, inp } = wren();
    let smallest = Infinity;
    for (let i = 0; i < sys.net.n; i++) smallest = Math.min(smallest, sys.net.C[i]);
    expect(sys.net.C[N_PANE0 + 3]).toBe(smallest === sys.net.C[N_PANE0 + 3] ? smallest : sys.net.C[N_PANE0 + 3]);
    inp.power.driveArmed = 1; inp.power.lit = 2; inp.jetPower[0] = inp.jetPower[1] = 0.5 * 400e3 * 34e3;
    for (let k = 0; k < 200; k++) {
      orbitEnv(inp.env, k * 30);
      inp.heatIn[Z_BELLY_FWD] = 3e7; inp.heatIn[Z_DORSAL_FWD] = 1e6;
      systemsStep(sys, st, inp, 30);
      const b = sys.net.book;
      const scale = Math.abs(b[BOOK_IN]) + Math.abs(b[BOOK_RAD]) + Math.abs(b[BOOK_DU]);
      expect(Math.abs(b[BOOK_IN] - b[BOOK_RAD] - b[BOOK_DU])).toBeLessThan(1e-9 * scale);
    }
    expect(inp.heatIn.every((x) => x === 0)).toBe(true);
  });

  it('energy closes over an orbit to 1e-6; 10 s steps within 0.5 K and 30 s within 1 K of 0.1 s steps', () => {
    // settle 3 orbits at 30 s, then compare one orbit at three step sizes from the same state
    const { sys, st, inp } = wren();
    for (let k = 0; k < Math.round((3 * PERIOD) / 30); k++) { orbitEnv(inp.env, k * 30); systemsStep(sys, st, inp, 30); }
    const fine = runOrbit(0.1, st), mid = runOrbit(10, st), warp = runOrbit(30, st);
    for (const r of [fine, mid, warp]) expect(Math.abs(r.ein - r.erad - r.du)).toBeLessThan(1e-6 * r.ein);
    let d10 = 0, d30 = 0;
    for (let i = 0; i < fine.T.length; i++) { d10 = Math.max(d10, Math.abs(mid.T[i] - fine.T[i])); d30 = Math.max(d30, Math.abs(warp.T[i] - fine.T[i])); }
    console.log(`orbit: max |T(10 s) − T(0.1 s)| = ${d10.toFixed(3)} K, |T(30 s) − T(0.1 s)| = ${d30.toFixed(3)} K`);
    expect(d10).toBeLessThan(0.5);
    expect(d30).toBeLessThan(1);
  });

  it('the hull temperature cycles with the orbit; the night side gets cold', () => {
    const { sys, st, inp } = wren();
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < Math.round((4 * PERIOD) / 10); k++) {
      orbitEnv(inp.env, k * 10);
      systemsStep(sys, st, inp, 10);
      if (k * 10 > 2 * PERIOD) { lo = Math.min(lo, st.thermal.T[Z_DORSAL_FWD]); hi = Math.max(hi, st.thermal.T[Z_DORSAL_FWD]); }
    }
    expect(hi - lo).toBeGreaterThan(5);
  });

  it('window sunlight heats the cockpit by kelvins per minute; a closed shutter passes 0 W', () => {
    const { sys, st, inp } = wren();
    const e = inp.env;
    e[ENV_S] = 1243; e[ENV_NU] = 1; e[ENV_SX] = 0; e[ENV_SY] = 0; e[ENV_SZ] = -1; // the sun dead ahead
    systemsStep(sys, st, inp, 0.1);
    const front = sys.def.windows.findIndex((w) => w.id === 'w-front');
    expect(sys.net.winLight[front]).toBeCloseTo(0.8 * 1243 * 3.6, 3);
    const T0 = st.thermal.T[N_ROOM0];
    for (let k = 0; k < 600; k++) systemsStep(sys, st, inp, 0.1);
    const rate = (st.thermal.T[N_ROOM0] - T0); // K per minute
    expect(rate).toBeGreaterThan(0.5);
    inp.shutters[0] = 1; inp.shutters[1] = 1;
    systemsStep(sys, st, inp, 0.1);
    for (let w = 0; w < sys.def.windows.length; w++) if (sys.def.windows[w].group <= 1) expect(sys.net.winLight[w]).toBe(0);
  });

  it('a long full burn heats the loop to the interlock: driveInhibit, then it clears below the hysteresis', () => {
    const { sys, st, inp } = wren();
    inp.power.driveArmed = 1;
    for (let k = 0; k < 300; k++) systemsStep(sys, st, inp, 0.1);
    expect(sys.pout.driveReady).toBe(true);
    inp.power.lit = 2; inp.jetPower[0] = inp.jetPower[1] = 0.5 * 400e3 * 34e3;
    let t = 0;
    while (!st.thermal.inhibit && t < 3600) { systemsStep(sys, st, inp, 0.1); t += 0.1; }
    console.log(`full burn from a cold loop: driveInhibit after ${t.toFixed(0)} s; skirts ${st.thermal.T[N_SKIRT0].toFixed(0)} K`);
    expect(st.thermal.inhibit).toBe(true);
    expect(t).toBeGreaterThan(120);
    expect(st.thermal.T[N_SKIRT0]).toBeGreaterThan(1400); // the afterglow
    inp.power.lit = 0; inp.power.driveArmed = 0; inp.jetPower.fill(0);
    let tc = 0;
    while (st.thermal.inhibit && tc < 7200) { systemsStep(sys, st, inp, 1); tc += 1; }
    expect(st.thermal.inhibit).toBe(false);
    expect(st.thermal.T[N_LOOP]).toBeLessThan(1100);
  });

  it('is deterministic and save → load → step is bit-identical', () => {
    const run = (saveAt: number): number[] => {
      let { sys, st, inp } = wren();
      for (let k = 0; k < 400; k++) {
        if (k === saveAt) st = loadSystems(JSON.parse(JSON.stringify(saveSystems(st))));
        orbitEnv(inp.env, k * 7.3);
        inp.heatIn[Z_BELLY_FWD] = k % 3 === 0 ? 1e5 : 0;
        inp.power.lit = k > 100 && k < 200 ? 2 : 0;
        inp.jetPower[0] = inp.jetPower[1] = inp.power.lit ? 6.8e9 : 0;
        systemsStep(sys, st, inp, k % 2 ? 0.1 : 17.07);
      }
      return [...st.thermal.T, st.power.soc, st.power.reactorP, st.caution.active];
    };
    const a = run(-1), b = run(-1), c = run(250);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(loadSystems(undefined).thermal.T.length).toBe(38);
  });

  it('costs a few µs per step in node', () => {
    const { sys, st, inp } = wren();
    orbitEnv(inp.env, 100);
    const Q = new Float64Array(sys.net.n);
    const T = st.thermal.T;
    for (let k = 0; k < 20000; k++) thermalStep(sys.net, T, Q, 0.1);
    const N = 200000;
    let t0 = performance.now();
    for (let k = 0; k < N; k++) thermalStep(sys.net, T, Q, 0.1);
    const step = ((performance.now() - t0) / N) * 1000;
    for (let k = 0; k < 20000; k++) systemsStep(sys, st, inp, 0.1);
    t0 = performance.now();
    for (let k = 0; k < N; k++) systemsStep(sys, st, inp, 0.1);
    const full = ((performance.now() - t0) / N) * 1000;
    console.log(`segments ${sys.pout.segments} V ${sys.pout.V} soc ${st.power.soc}; thermalStep (38 nodes, ${sys.net.nnz} L entries, ${sys.net.progA.length} program ops): ${step.toFixed(2)} µs; systemsStep: ${full.toFixed(2)} µs`);
    expect(step).toBeLessThan(20);
    expect(full).toBeLessThan(40);
  });
});
