// Thermal network (src/world/thermal.ts, src/data/thermalNet.ts, src/world/shipSystems.ts): W2-D item 1 tests.
import { describe, expect, it } from 'vitest';
import { defaultDemand } from '../src/data/powerNet';
import {
  LOOP_T_SAT, N_LOOP, N_PANE0, N_RAD0, N_REACTOR, N_ROOM0, N_ROOMS, N_SKIRT0, N_TPS_BF, PUMP_G_MAX, RAD_EPS, RAD_PANEL_AREA, ROOM_CAUTION,
  ROOM_VOLUME, SCRAM_LOOP, WREN_THERMAL,
} from '../src/data/thermalNet';
import { C_BREAKER, C_CABIN_COLD, C_OVERTEMP, C_SCRAM } from '../src/world/caution';
import { L_GALLEY } from '../src/data/powerNet';
import { Z_BELLY_FWD, Z_DORSAL_FWD } from '../src/data/hullZones';
import {
  makeShipSystems, makeSystemsInputs, makeSystemsState, radiatorG, saveSystems, loadSystems, systemsDue, systemsSpanTicks, systemsStep,
  type ShipSystems, type SystemsInputs, type SystemsState,
} from '../src/world/shipSystems';
import {
  BOOK_DU, BOOK_IN, BOOK_RAD, compileThermal, ENV_ALB, ENV_NU, ENV_NX, ENV_NY, ENV_NZ, ENV_S, ENV_SX, ENV_SY, ENV_SZ, ENV_TPL, ENV_VF,
  makeThermalEnv, planetIrTemp, shadowFactor, SIGMA, thermalSources, thermalStep, type ThermalNetDef,
} from '../src/world/thermal';

// ---------------------------------------------------------------------------------------------- orbit environment
const MU = 4.38e14, A_ORB = 7090.5e3, R_P = 6543e3, S0 = 1243, ALBEDO = 0.3;
const PERIOD = 2 * Math.PI * Math.sqrt((A_ORB * A_ORB * A_ORB) / MU);
const D_SUN = 1.2e11, R_SUN = 6e8;
const T_SS = Math.pow(((1 - ALBEDO) * S0) / SIGMA, 0.25);

type Rot = (x: number, y: number, z: number, out: number[]) => void;
const INERTIAL: Rot = (x, y, z, o) => { o[0] = x; o[1] = y; o[2] = z; };
const RV = [0, 0, 0];
/** Circular equatorial orbit in the XZ plane, the star along +X (β = 0); craft axes = rot(inertial axes). */
function orbitEnv(env: Float64Array, t: number, rot: Rot = INERTIAL): void {
  const th = (2 * Math.PI * t) / PERIOD;
  const rx = A_ORB * Math.cos(th), rz = A_ORB * Math.sin(th);
  const sx = D_SUN - rx, sz = -rz;
  const ds = Math.hypot(sx, sz);
  env[ENV_S] = S0;
  env[ENV_NU] = shadowFactor(sx, 0, sz, R_SUN, -rx, 0, -rz, R_P);
  rot(sx / ds, 0, sz / ds, RV); env[ENV_SX] = RV[0]; env[ENV_SY] = RV[1]; env[ENV_SZ] = RV[2];
  rot(-rx / A_ORB, 0, -rz / A_ORB, RV); env[ENV_NX] = RV[0]; env[ENV_NY] = RV[1]; env[ENV_NZ] = RV[2];
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
    const run = (saveAt: number): (number | string)[] => {
      let { sys, st, inp } = wren();
      for (let k = 0; k < 400; k++) {
        if (k === saveAt) st = loadSystems(JSON.parse(JSON.stringify(saveSystems(st))));
        orbitEnv(inp.env, k * 7.3);
        inp.heatIn[Z_BELLY_FWD] = k % 3 === 0 ? 1e5 : 0;
        inp.power.driveArmed = k > 80 && k < 300 ? 1 : 0;
        inp.power.lit = k > 100 && k < 200 ? 2 : 0;
        inp.jetPower[0] = inp.jetPower[1] = inp.power.lit ? 6.8e9 : 0;
        if (k === 150) st.thermal.T[N_ROOM0 + 2] = 310; // a hot room: the per-node latch is part of the state
        systemsStep(sys, st, inp, k % 2 ? 0.1 : 17.07);
      }
      return [...st.thermal.T, st.power.soc, st.power.reactorP, st.caution.active, JSON.stringify(saveSystems(st))];
    };
    const a = run(-1), b = run(-1), c = run(250);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(loadSystems(undefined).thermal.T.length).toBe(38);
    const d = loadSystems({ power: { soc: 0.5 } });
    expect(d.power.scram).toBe(0); expect(d.power.standbyS).toBe(0); expect(d.thermal.hot.every((h) => h === 0)).toBe(true);
    expect(Number.isNaN(d.tick)).toBe(true);
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

// ---------------------------------------------------------------------------------------------- review fixes
const FULL_JET = 0.5 * 400e3 * 34e3;

/** Arm, wait for the drive bus, burn at full thrust until driveInhibit (1× systems steps of 0.1 s). */
function burnToInhibit(x: { sys: ShipSystems; st: SystemsState; inp: SystemsInputs }): number {
  const { sys, st, inp } = x;
  inp.power.driveArmed = 1;
  let t = 0;
  while (!sys.pout.driveReady) { systemsStep(sys, st, inp, 0.1); t += 0.1; }
  inp.power.lit = 2; inp.jetPower[0] = inp.jetPower[1] = FULL_JET;
  while (!st.thermal.inhibit) { systemsStep(sys, st, inp, 0.1); t += 0.1; }
  return t;
}

describe('review D1: the interlock removes the heat source', () => {
  it('after a full burn with DRIVE ARM left on, the loop never reaches NaK saturation (1 h)', () => {
    const x = wren(), { sys, st, inp } = x;
    const t = burnToInhibit(x);
    inp.power.lit = 0; inp.jetPower.fill(0); // engines out (dynamics honours the inhibit); ARM stays on
    let loopMax = 0, reactorMax = 0, tSetback = -1;
    for (let k = 0; k < 36000; k++) {
      systemsStep(sys, st, inp, 0.1);
      loopMax = Math.max(loopMax, st.thermal.T[N_LOOP]); reactorMax = Math.max(reactorMax, st.thermal.T[N_REACTOR]);
      if (tSetback < 0 && st.power.reactorP < 1e5) tSetback = k * 0.1;
    }
    console.log(`D1: inhibit after ${t.toFixed(1)} s of arm+burn; armed 1 h after: loop max ${loopMax.toFixed(1)} K, reactor max ${reactorMax.toFixed(1)} K, setback to < 0.1 MW in ${tSetback.toFixed(1)} s`);
    expect(loopMax).toBeLessThan(LOOP_T_SAT);
    expect(loopMax).toBeLessThan(SCRAM_LOOP);
    expect(st.power.scram).toBe(0);
    expect(tSetback).toBeLessThan(5); // 10 MW at the 10 %/s setback ramp ≈ 3.6 s
    expect(st.thermal.T[N_LOOP]).toBeLessThan(1000);
  });

  it('armed and never lit: the standby lapses after 60 s and the loop stays far from the interlock', () => {
    const { sys, st, inp } = wren();
    inp.power.driveArmed = 1;
    let readyAt = -1, loopMax = 0;
    for (let k = 0; k < 36000; k++) {
      systemsStep(sys, st, inp, 0.1);
      if (readyAt < 0 && sys.pout.driveReady) readyAt = k * 0.1;
      loopMax = Math.max(loopMax, st.thermal.T[N_LOOP]);
      expect(st.thermal.inhibit).toBe(false);
    }
    console.log(`D1: armed 1 h, never lit: drive ready at ${readyAt.toFixed(1)} s, standby lapsed at 60 s, loop max ${loopMax.toFixed(0)} K`);
    expect(sys.pout.driveReady).toBe(false);
    expect(sys.pout.standby).toBe(false);
    expect(st.power.reactorP).toBeLessThan(1e5);
    expect(loopMax).toBeLessThan(700);
    // cycling DRIVE ARM restarts the standby
    inp.power.driveArmed = 0; systemsStep(sys, st, inp, 0.1);
    inp.power.driveArmed = 1;
    for (let k = 0; k < 250; k++) systemsStep(sys, st, inp, 0.1);
    expect(sys.pout.driveReady).toBe(true);
  });

  it('arm, wait 40 s, light: the burn runs; the standby lapse is resolved inside one 120 s step', () => {
    const { sys, st, inp } = wren();
    inp.power.driveArmed = 1;
    for (let k = 0; k < 400; k++) systemsStep(sys, st, inp, 0.1);
    expect(sys.pout.driveReady).toBe(true);
    inp.power.lit = 2; inp.jetPower[0] = inp.jetPower[1] = FULL_JET;
    for (let k = 0; k < 600; k++) systemsStep(sys, st, inp, 0.1);
    expect(sys.pout.driveFrac).toBe(1);
    expect(st.thermal.inhibit).toBe(false);
    // the lapse is resolved inside a long step (exact two-piece ramp)
    const a = wren(), b = wren();
    a.inp.power.driveArmed = 1; b.inp.power.driveArmed = 1;
    for (let k = 0; k < 1200; k++) systemsStep(a.sys, a.st, a.inp, 0.1);
    systemsStep(b.sys, b.st, b.inp, 120);
    expect(a.st.power.reactorP).toBeLessThan(1e5); // back to the hotel load (+ charging)
    expect(Math.abs(b.st.power.reactorP - a.st.power.reactorP)).toBeLessThan(0.02 * a.st.power.reactorP);
  });

  it('auto-scram near NaK saturation: reactor to zero within ~1 s, latched, caution and wake', () => {
    const { sys, st, inp } = wren();
    for (let k = 0; k < 50; k++) systemsStep(sys, st, inp, 0.1);
    expect(st.power.reactorP).toBeGreaterThan(0);
    for (const i of [N_LOOP, N_REACTOR, N_RAD0, N_RAD0 + 1]) st.thermal.T[i] = SCRAM_LOOP + 5; // the hot loop group
    systemsStep(sys, st, inp, 0.1);
    expect(st.power.scram).toBe(1);
    expect(st.power.reactorSet).toBe(0);
    expect(st.caution.active & (1 << C_SCRAM)).not.toBe(0);
    expect(sys.wake & (1 << C_SCRAM)).not.toBe(0);
    for (let k = 0; k < 10; k++) systemsStep(sys, st, inp, 0.1);
    expect(st.power.reactorP).toBe(0);
    st.power.reactorSet = 1; // the lever alone does not restart a scrammed reactor
    for (let k = 0; k < 10; k++) systemsStep(sys, st, inp, 0.1);
    expect(st.power.reactorP).toBe(0);
    expect(sys.pout.V).toBeGreaterThan(105); // the battery carries the hotel bus
  });

  it('radiators lost: the loop heats for days on the hotel load waste; the scram stops it short of saturation', () => {
    const { sys, st, inp } = wren();
    inp.radiatorHealth[0] = 0; inp.radiatorHealth[1] = 0;
    let t = 0, loopMax = 0;
    while (!st.power.scram && t < 20 * 86400) { systemsStep(sys, st, inp, 30); t += 30; }
    for (let k = 0; k < 2880; k++) { systemsStep(sys, st, inp, 30); loopMax = Math.max(loopMax, st.thermal.T[N_LOOP]); }
    console.log(`D1: radiators lost: scram after ${(t / 86400).toFixed(2)} days; loop max in the day after ${loopMax.toFixed(1)} K`);
    expect(st.power.scram).toBe(1);
    expect(loopMax).toBeLessThan(LOOP_T_SAT);
  });
});

describe('review D2: the thermostats hold the cabin', () => {
  const ATT: Record<string, Rot> = {
    inertial: INERTIAL,
    'nose-to-sun': (x, y, z, o) => { o[0] = -z; o[1] = y; o[2] = -x; },
    'tail-to-sun': (x, y, z, o) => { o[0] = z; o[1] = y; o[2] = x; },
    'belly-to-sun': (x, y, z, o) => { o[0] = y; o[1] = -x; o[2] = z; },
    'top-to-sun': (x, y, z, o) => { o[0] = y; o[1] = x; o[2] = z; },
  };
  const day = (rot: Rot | null, shut: number): { lo: number; hi: number; caution: number } => {
    const { sys, st, inp } = wren();
    inp.shutters.fill(shut);
    let lo = Infinity, hi = -Infinity, caution = 0;
    for (let k = 0; k < 2 * 2880; k++) { // two days at h = 30 s; the second day is judged
      if (rot) orbitEnv(inp.env, k * 30 + 15, rot);
      systemsStep(sys, st, inp, 30);
      caution |= st.caution.active;
      if (k < 2880) continue;
      for (let r = 0; r < N_ROOMS; r++) { const T = st.thermal.T[N_ROOM0 + r]; lo = Math.min(lo, T); hi = Math.max(hi, T); }
    }
    return { lo, hi, caution };
  };
  it('294 ± 2 K for a day at h = 30 s in five attitudes with the shutters closed, and in deep space', () => {
    const out: string[] = [];
    for (const [name, rot] of [...Object.entries(ATT), ['deep space', null] as const]) {
      const r = day(rot, 1);
      out.push(`${name} ${r.lo.toFixed(1)}..${r.hi.toFixed(1)}`);
      expect(r.lo).toBeGreaterThan(292); expect(r.hi).toBeLessThan(296);
      expect(r.caution & ((1 << C_CABIN_COLD) | (1 << C_OVERTEMP))).toBe(0);
    }
    console.log(`D2 rooms, day 2, shutters closed: ${out.join('; ')}`);
  });
  it('shutters open: the cold attitudes still hold; open windows in direct sun out-run the coolers', () => {
    const tail = day(ATT['tail-to-sun'], 0), deep = day(null, 0), top = day(ATT['top-to-sun'], 0);
    console.log(`D2 shutters open: tail ${tail.lo.toFixed(1)}..${tail.hi.toFixed(1)}, deep space ${deep.lo.toFixed(1)}..${deep.hi.toFixed(1)}, top-to-sun ${top.lo.toFixed(1)}..${top.hi.toFixed(1)}`);
    for (const r of [tail, deep]) { expect(r.lo).toBeGreaterThan(292); expect(r.hi).toBeLessThan(296); }
    expect(top.hi).toBeGreaterThan(296);
  });
  it('a cold cabin raises the cabin-cold caution and wakes', () => {
    const { sys, st, inp } = wren();
    systemsStep(sys, st, inp, 0.1);
    st.thermal.T[N_ROOM0 + 4] = 280;
    systemsStep(sys, st, inp, 0.1);
    expect(sys.wake & (1 << C_CABIN_COLD)).not.toBe(0);
  });
});

describe('review D3: burns do not cook the engineering room', () => {
  it('after a full burn to the interlock no room exceeds 305 K over the next 6 h; a hot room raises a caution', () => {
    const x = wren(), { sys, st, inp } = x;
    burnToInhibit(x);
    inp.power.lit = 0; inp.power.driveArmed = 0; inp.jetPower.fill(0);
    let hi = 0;
    for (let k = 0; k < 720; k++) {
      systemsStep(sys, st, inp, 30);
      for (let r = 0; r < N_ROOMS; r++) hi = Math.max(hi, st.thermal.T[N_ROOM0 + r]);
    }
    console.log(`D3: warmest room in the 6 h after a full burn: ${hi.toFixed(1)} K`);
    expect(hi).toBeLessThan(ROOM_CAUTION);
    st.thermal.T[N_ROOM0 + 9] = ROOM_CAUTION + 1;
    systemsStep(sys, st, inp, 0.1);
    expect(sys.wake & (1 << C_OVERTEMP)).not.toBe(0);
  });
});

describe('review D4: bad inputs cannot poison the network', () => {
  it('h = 0, NaN or negative h is a no-op; NaN inputs are sanitised', () => {
    const { sys, st, inp } = wren();
    orbitEnv(inp.env, 100);
    systemsStep(sys, st, inp, 1);
    const before = JSON.stringify(saveSystems(st));
    for (const h of [0, -1, NaN, Infinity]) { systemsStep(sys, st, inp, h); expect(sys.wake).toBe(0); }
    expect(JSON.stringify(saveSystems(st))).toBe(before);
    inp.jetPower[0] = NaN; inp.heatIn[3] = NaN; inp.env[2] = NaN; inp.env[0] = Infinity; inp.crewW[1] = NaN;
    inp.power.demand[L_GALLEY] = NaN; inp.power.fault[2] = NaN; inp.power.lit = NaN; inp.pumpCmd = NaN; inp.shutters[0] = NaN; inp.radiatorHealth[0] = NaN;
    for (let k = 0; k < 10; k++) systemsStep(sys, st, inp, k ? 0.1 : 30);
    expect(st.thermal.T.every((t) => Number.isFinite(t) && t > 0)).toBe(true);
    expect(Number.isFinite(st.power.soc)).toBe(true);
    expect(sys.pout.V).toBeGreaterThan(105);
  });
  it('the interlock and the caution read a NaN temperature as over the limit', () => {
    const { sys, st, inp } = wren();
    systemsStep(sys, st, inp, 0.1);
    st.thermal.T[N_LOOP] = NaN;
    systemsStep(sys, st, inp, 0.1);
    expect(st.thermal.inhibit).toBe(true);
    expect(st.power.scram).toBe(1);
    expect(st.caution.active & (1 << C_OVERTEMP)).not.toBe(0);
  });
});

describe('review D5: every new overheat and every new trip lights the lamp again', () => {
  it('a second hot node and a second trip each wake', () => {
    const { sys, st, inp } = wren();
    systemsStep(sys, st, inp, 0.1);
    st.thermal.T[N_ROOM0 + 2] = ROOM_CAUTION + 3;
    systemsStep(sys, st, inp, 0.1);
    expect(sys.wake & (1 << C_OVERTEMP)).not.toBe(0);
    st.thermal.T[N_ROOM0 + 2] = ROOM_CAUTION + 3; // still hot: no new wake
    systemsStep(sys, st, inp, 0.1);
    expect(sys.wake & (1 << C_OVERTEMP)).toBe(0);
    st.thermal.T[N_ROOM0 + 2] = ROOM_CAUTION + 3;
    st.thermal.T[N_ROOM0 + 8] = ROOM_CAUTION + 3; // a different node
    systemsStep(sys, st, inp, 0.1);
    expect(sys.wake & (1 << C_OVERTEMP)).not.toBe(0);
    // two breaker trips in consecutive steps
    inp.power.fault[4] = 1; inp.power.fault[7] = 0.2; // LIFE SUP trips in 0.07 s, UTILITY (25 A on 15 A) in 2.8 s
    const wakes: number[] = [];
    for (let k = 0; k < 200 && wakes.length < 2; k++) { systemsStep(sys, st, inp, 0.1); if (sys.wake & (1 << C_BREAKER)) wakes.push(sys.newTrips); }
    expect(wakes.length).toBe(2);
    expect(wakes[0]).not.toBe(wakes[1]);
  });
});

describe('review D6: the radiator panel as effectiveness–NTU', () => {
  it('radiatorG reproduces Q = ṁc_p(1 − e^−N)(T_in − T_eq) in series with the panel, 2ṁc_p → ṁc_p', () => {
    const mcp = 18000;
    for (const Tp of [5, 100, 330, 1100, 3000, 2e4]) {
      const hA = 4 * RAD_EPS * SIGMA * Tp ** 3 * 26, N = hA / mcp, G = radiatorG(mcp, Tp, 26);
      const exact = mcp * (N > 1e-12 ? -Math.expm1(-N) : N);
      expect(Math.abs((G * hA) / (G + hA) - exact)).toBeLessThan(1e-9 * exact);
      expect(G).toBeGreaterThan(mcp * (1 - 1e-12)); expect(G).toBeLessThanOrEqual(2 * mcp);
    }
    expect(radiatorG(0, 1000, 26)).toBe(0);
    expect(radiatorG(mcp, 1000, 0)).toBe(0);
  });
  it('at the 1150 K interlock the panels sit near 1100 K and reject ≈ 3.6 MW', () => {
    const x = wren(), { st } = x;
    burnToInhibit(x);
    const Tr = st.thermal.T[N_RAD0], Q = RAD_EPS * SIGMA * 4 * RAD_PANEL_AREA * Tr ** 4;
    console.log(`D6: loop ${st.thermal.T[N_LOOP].toFixed(1)} K, panels ${Tr.toFixed(1)} K, rejecting ${(Q / 1e6).toFixed(2)} MW (ṁc_p ${PUMP_G_MAX} W/K per panel)`);
    expect(Tr).toBeGreaterThan(1085);
    expect(Q).toBeGreaterThan(3.4e6);
  });
});

describe('review D7: room volumes', () => {
  it('free air 314.8 m³ = the plan\'s 370.5 m³ of boxes minus 55.8 m³ of solids', () => {
    const sum = ROOM_VOLUME.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(314.8, 1);
  });
});

describe('review D8: the warp schedule', () => {
  it('10 Hz at 1×; under warp whole quanta to ≈ 120 s (4 sub-steps of 29.9 s at q = 2¹¹ ticks); one quantum with the drive on', () => {
    expect(systemsSpanTicks(1, false)).toBe(12);
    expect(systemsSpanTicks(8, false)).toBe(12);
    expect(systemsSpanTicks(2048, false)).toBe(7 * 2048);
    expect(systemsSpanTicks(2048, true)).toBe(2048);
    expect(systemsSpanTicks(65536, false)).toBe(65536);
    // the call sequence depends on the quanta only (any frame budget sees the same quantum boundaries)
    const st = makeSystemsState();
    const hs: number[] = [];
    for (let tick = 0; tick <= 2048 * 30; tick += 2048) { const h = systemsDue(st, tick, 2048, false); if (h) hs.push(h); }
    expect(hs.length).toBe(4);
    expect(hs.every((h) => h === (7 * 2048) / 120)).toBe(true);
  });
});
