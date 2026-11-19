// W1-B real thrusters: the pure core of src/world/jets.ts (allocation, blowdown, spool, hold wake, LOS, ledger).
import { describe, expect, it } from 'vitest';
import type { V3 } from '../src/core/types';
import { SHIP_LAYOUTS } from '../src/data/shipLayouts';
import {
  ENGINE_UNLIT, N_COLS, Q, RCS_CAPACITY, RCS_DENSITY, RCS_TANK_VOLUME, RCS_VE0,
  addJetDamping, allocateJets, applyEngines, applyJets, assistVisible, buildJetTable, clearThrustOut, consumeLedgerInto,
  engineCommandThrust, engineDef, engineEventTime, engineLatch, engineUpdate, faMainDrive, forceAuthority, holdWakeTime,
  holdWakeTimeVec, jetEdgeMasks, jetsFromLayout, jetsStep, ledgerAdd, ledgerAddInertial, ledgerImpulse, lineOfSight,
  lpMinimize, loadJetState, makeLedgerMean, makeThrustOut, rcsBlowdown, rcsVeFactor, saveJetState, torqueAuthority,
  torqueToCmd, type JetState, type JetTable, type Ledger,
} from '../src/world/jets';

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });

/** Count V8 garbage collections while `fn` runs (same helper as events.test.ts). */
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
const ZERO = v(0, 0, 0);

/** The Wren's 10 layout jets plus the plan's 4 Z jets (wave 1 adds these to shipLayouts.ts). */
const WREN_Z_JETS = [
  { pos: v(1.0, 0, -14.8), dir: v(0, 0, -1) },
  { pos: v(-1.0, 0, -14.8), dir: v(0, 0, -1) },
  { pos: v(6.0, -0.2, 13.0), dir: v(0, 0, 1) },
  { pos: v(-6.0, -0.2, 13.0), dir: v(0, 0, 1) },
];
const WREN_JETS = jetsFromLayout([...SHIP_LAYOUTS.wren.rcs, ...WREN_Z_JETS]);
const T = buildJetTable(WREN_JETS, ZERO);
const ENGINES = SHIP_LAYOUTS.wren.engines.map((e) => engineDef(e.pos, ZERO));

// Wren mass properties as setup.ts builds them today: a uniform 19 × 6.6 × 32 m box of 42.9 t + 24 t.
const DRY = 42900, MAIN = 22500, M0 = DRY + MAIN + RCS_CAPACITY;
const GYR = v((6.6 ** 2 + 32 ** 2) / 12, (19 ** 2 + 32 ** 2) / 12, (19 ** 2 + 6.6 ** 2) / 12);

function columnVector(T: JetTable, k: number): number[] {
  const duty = new Float64Array(T.n);
  for (let j = 0; j < T.n; j++) duty[j] = T.table[k * T.n + j];
  const o = applyJets(T, duty, 1, 0, 0, 0, 0, 0, 0, makeThrustOut());
  return [o.fx, o.fy, o.fz, o.tx, o.ty, o.tz];
}

describe('jet geometry and the allocation table', () => {
  it('has 14 jets at 68 kN per axis: 34 kN X and Z jets, 22.7 kN Y jets', () => {
    expect(WREN_JETS.length).toBe(14);
    for (const j of WREN_JETS) {
      const t = Math.abs(j.dir.y) > 0.5 ? 68e3 / 3 : 34e3;
      expect(j.thrust).toBeCloseTo(t, 6);
      expect(j.ve).toBe(RCS_VE0);
    }
  });

  it('every column is a pure command along its signed axis, largest duty exactly 1', () => {
    for (let k = 0; k < N_COLS; k++) {
      const axis = k >> 1, sign = k & 1 ? -1 : 1;
      const f = columnVector(T, k);
      expect(Math.sign(f[axis])).toBe(sign);
      expect(Math.abs(f[axis])).toBeCloseTo(T.authority[k], 3);
      for (let a = 0; a < 6; a++) if (a !== axis) expect(Math.abs(f[a])).toBeLessThan(1e-9 * T.authority[k]);
      let um = 0;
      for (let j = 0; j < T.n; j++) um = Math.max(um, T.table[k * T.n + j]);
      expect(um).toBe(1);
    }
  });

  it('computes the authority the plan expects: ≈ 0.56 / 0.78 / 0.22 MN·m in pitch / yaw / roll', () => {
    const ta = torqueAuthority(T, 1, v(0, 0, 0)), fa = forceAuthority(T, 1, v(0, 0, 0));
    console.log(`authority: torque ${(ta.x / 1e6).toFixed(4)} / ${(ta.y / 1e6).toFixed(4)} / ${(ta.z / 1e6).toFixed(4)} MN·m, force ${(fa.x / 1e3).toFixed(2)} / ${(fa.y / 1e3).toFixed(2)} / ${(fa.z / 1e3).toFixed(2)} kN; column ṁ ${Array.from(T.cost, (c) => c.toFixed(2)).join(' ')} kg/s`);
    // pitch: nose Y jet (arm 12.5) + the tail pair at half duty (arm 12): 22.67 kN · 24.5 m
    expect(ta.x).toBeCloseTo((68e3 / 3) * (12.5 + 12), 0);
    // yaw: nose and tail X jets (12 + 11 m) at full duty, the 0.2 m roll coupling trimmed by the tail Y jets
    expect(ta.y).toBeCloseTo(34e3 * 23, 0);
    // roll: the tail Y couple, 2 × 4.8 m
    expect(ta.z).toBeCloseTo((68e3 / 3) * 9.6, 0);
  });

  it('is the minimum-propellant solution (checked against every 6-jet basis)', () => {
    const n = T.n;
    // physical A, rows normalised exactly as the builder does (does not affect optimality)
    const A: number[][] = [[], [], [], [], [], []];
    const cost: number[] = [];
    for (const J of WREN_JETS) {
      const u = v(-J.dir.x, -J.dir.y, -J.dir.z), r = J.pos, F = J.thrust;
      A[0].push(F * u.x); A[1].push(F * u.y); A[2].push(F * u.z);
      A[3].push(F * (r.y * u.z - r.z * u.y)); A[4].push(F * (r.z * u.x - r.x * u.z)); A[5].push(F * (r.x * u.y - r.y * u.x));
      cost.push(F / J.ve);
    }
    const solve = (M: number[][], b: number[]): number[] | null => {
      const m = M.map((row, i) => [...row, b[i]]);
      for (let c = 0; c < 6; c++) {
        let p = c;
        for (let r = c + 1; r < 6; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
        if (Math.abs(m[p][c]) < 1e-6) return null;
        [m[c], m[p]] = [m[p], m[c]];
        for (let r = 0; r < 6; r++) if (r !== c) { const f = m[r][c] / m[c][c]; for (let k = c; k <= 6; k++) m[r][k] -= f * m[c][k]; }
      }
      return m.map((row, i) => row[6] / row[i]);
    };
    const subsets: number[][] = [];
    const rec = (s: number, cur: number[]) => { if (cur.length === 6) { subsets.push(cur.slice()); return; } for (let j = s; j < n; j++) { cur.push(j); rec(j + 1, cur); cur.pop(); } };
    rec(0, []);
    expect(subsets.length).toBe(3003);
    for (let k = 0; k < N_COLS; k++) {
      const axis = k >> 1, sign = k & 1 ? -1 : 1;
      const b = [0, 0, 0, 0, 0, 0]; b[axis] = sign * T.authority[k];
      let best = Infinity;
      for (const S of subsets) {
        const x = solve(A.map((row) => S.map((j) => row[j])), b);
        if (!x || x.some((u) => u < -1e-9)) continue;
        const c = x.reduce((s, u, i) => s + u * cost[S[i]], 0);
        if (c < best) best = c;
      }
      expect(T.cost[k]).toBeLessThanOrEqual(best * (1 + 1e-9));
      expect(T.cost[k]).toBeGreaterThanOrEqual(best * (1 - 1e-9));
    }
  });

  it('the simplex reports infeasibility and copes with redundant rows', () => {
    const x = new Float64Array(2);
    // x0 + x1 = 1, 2x0 + 2x1 = 2 (redundant), min x0 + 3x1 → x0 = 1
    expect(lpMinimize(2, 2, [1, 1, 2, 2], [1, 2], [1, 3], new Uint8Array([1, 1]), x)).toBeCloseTo(1, 12);
    expect(x[0]).toBeCloseTo(1, 12);
    // x0 − x1 = −1 with x1 disabled: infeasible
    expect(lpMinimize(1, 2, [1, -1], [-1], [1, 1], new Uint8Array([1, 0]), x)).toBe(-1);
  });

  it('a dead jet removes its column entries; an axis nothing can make purely has zero authority', () => {
    const health = new Float64Array(14).fill(1);
    WREN_JETS.forEach((j, i) => { if (j.dir.z < -0.5) health[i] = 0; }); // both nose Z jets dead: no +Fz (aft push)
    const Td = buildJetTable(WREN_JETS, ZERO, health);
    expect(Td.authority[4]).toBe(0);
    for (let j = 0; j < 14; j++) if (health[j] === 0) for (let k = 0; k < N_COLS; k++) expect(Td.table[k * 14 + j]).toBe(0);
    expect(Td.authority[5]).toBeGreaterThan(0);
  });
});

describe('per-step allocation and what the jets actually do', () => {
  const duty = new Float64Array(14), o = makeThrustOut(), cmd = new Float64Array(6);
  const fa = forceAuthority(T, 1, v(0, 0, 0));
  const fMin = Math.min(fa.x, fa.y, fa.z);

  it('a pure torque command gives |F| ≤ 1% of authority (single axes, and torque-only mixes)', () => {
    let worst = 0;
    const mixes = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0], [0, 0, -1], [0.5, 0.5, 0], [0.3, -0.4, 0.5], [-0.2, 0.2, -0.6], [1, 1, 1], [-1, 1, -1]];
    for (const m of mixes) {
      cmd.fill(0); cmd[3] = m[0]; cmd[4] = m[1]; cmd[5] = m[2];
      jetsStep(T, cmd, true, RCS_CAPACITY, 0, 0, 0, 0, 0, 0, duty, o);
      const F = Math.hypot(o.fx, o.fy, o.fz) / fMin;
      worst = Math.max(worst, F);
      expect(F).toBeLessThanOrEqual(0.01);
    }
    console.log(`pure torque: worst |F| = ${(worst * 100).toExponential(2)} % of the smallest force authority`);
  });

  it('saturation emerges and keeps the commanded direction (duties scaled, not clipped per jet)', () => {
    cmd.fill(0); cmd[0] = 1; cmd[4] = 1;
    allocateJets(T, cmd, duty);
    let sat = 0;
    for (let j = 0; j < 14; j++) { expect(duty[j]).toBeLessThanOrEqual(1); if (duty[j] === 1) sat++; }
    clearThrustOut(o); applyJets(T, duty, 1, 0, 0, 0, 0, 0, 0, o);
    expect(sat).toBeGreaterThan(0);
    const kx = o.fx / T.authority[0], ky = o.ty / T.authority[8];
    expect(kx).toBeLessThan(1);
    expect(kx).toBeCloseTo(ky, 9);
    expect(Math.abs(o.fy) + Math.abs(o.fz)).toBeLessThan(1e-6);
    // for the record: the per-jet clip of the plan's first wording, on a full three-axis torque command
    cmd.fill(0); cmd[3] = 1; cmd[4] = 1; cmd[5] = 1;
    const clip = new Float64Array(14);
    for (let a = 3; a < 6; a++) for (let j = 0; j < 14; j++) clip[j] += T.table[2 * a * 14 + j];
    for (let j = 0; j < 14; j++) clip[j] = Math.min(1, clip[j]);
    clearThrustOut(o); applyJets(T, clip, 1, 0, 0, 0, 0, 0, 0, o);
    console.log(`per-jet clipping of a full 3-axis torque would add |F| = ${(Math.hypot(o.fx, o.fy, o.fz) / 1e3).toFixed(1)} kN of spurious translation`);
  });

  it('a dry pool, or a landed / docked craft, applies nothing: zero duty, zero torque', () => {
    cmd.fill(0); cmd[3] = 1; cmd[4] = -1; cmd[0] = 1;
    expect(jetsStep(T, cmd, true, 0, 0.1, 0, 0, 0, 0, 0, duty, o).mdotRcs).toBe(0);
    expect([o.fx, o.fy, o.fz, o.tx, o.ty, o.tz, o.mdotRcs].every((x) => x === 0)).toBe(true);
    expect(Array.from(duty).every((d) => d === 0)).toBe(true);
    jetsStep(T, cmd, false, RCS_CAPACITY, 0, 0, 0, 0, 0, 0, duty, o);
    expect(o.tx === 0 && o.ty === 0 && o.tz === 0 && Array.from(duty).every((d) => d === 0)).toBe(true);
  });

  it('torqueToCmd maps N·m onto the signed columns', () => {
    const c = new Float64Array(6);
    torqueToCmd(T, 1, 1e5, -2e5, 5e4, c);
    allocateJets(T, c, duty);
    clearThrustOut(o); applyJets(T, duty, 1, 0, 0, 0, 0, 0, 0, o);
    expect(o.tx).toBeCloseTo(1e5, 3); expect(o.ty).toBeCloseTo(-2e5, 3); expect(o.tz).toBeCloseTo(5e4, 3);
  });

  it('jet edges come out as on/off masks', () => {
    const e = { on: 0, off: 0 };
    jetEdgeMasks([0, 1, 0.5, 0], [0.2, 0, 0.5, 0], 4, e);
    expect(e.on).toBe(1); expect(e.off).toBe(2);
  });

  function slew(axis: 0 | 1 | 2, target: number): { prop: number; wPeak: number; I: number } {
    // a minimal single-axis rotation integrator at h = Q: full command, the last step trimmed to land on the target
    const I = M0 * [GYR.x, GYR.y, GYR.z][axis];
    let w = 0, prop = RCS_CAPACITY, wPeak = 0;
    const tq = (oo: typeof o) => [oo.tx, oo.ty, oo.tz][axis];
    for (const goal of [target, 0]) {
      for (let i = 0; i < 1e5 && Math.abs(goal - w) > 1e-15; i++) {
        cmd.fill(0);
        cmd[3 + axis] = goal > w ? 1 : -1;
        jetsStep(T, cmd, true, prop, 0, 0, 0, 0, 0, 0, duty, o);
        const dw = (tq(o) / I) * Q;
        if (Math.abs(dw) > Math.abs(goal - w)) {
          cmd[3 + axis] *= Math.abs(goal - w) / Math.abs(dw);
          jetsStep(T, cmd, true, prop, 0, 0, 0, 0, 0, 0, duty, o);
          w += (tq(o) / I) * Q;
          w = goal;
        } else w += dw;
        prop -= o.mdotRcs * Q;
      }
      wPeak = Math.max(wPeak, w);
    }
    return { prop: RCS_CAPACITY - prop, wPeak: target, I };
  }

  it('propellant per slew matches 2·I·ω/(arm·vₑ) within 2%', () => {
    const ve = RCS_VE0 * rcsVeFactor(rcsBlowdown(RCS_CAPACITY));
    // pitch: geometric arm of the pure couple (nose 12.5 m, tail pair 12 m): (12.5 + 12)/2
    const p = slew(0, 0.1);
    const pExp = (2 * p.I * 0.1) / (12.25 * ve);
    console.log(`pitch slew to 0.1 rad/s and back: ${p.prop.toFixed(2)} kg (formula ${pExp.toFixed(2)} kg)`);
    expect(Math.abs(p.prop / pExp - 1)).toBeLessThan(0.02);
    // yaw: geometric arm (12 + 11)/2 = 11.5 m, plus the honest price of the 0.2 m roll coupling
    const y = slew(1, 0.1);
    const yGeo = (2 * y.I * 0.1) / (11.5 * ve);
    const armEff = T.authority[8] / (T.cost[8] * RCS_VE0);
    const yEff = (2 * y.I * 0.1) / (armEff * ve);
    console.log(`yaw slew: ${y.prop.toFixed(2)} kg (geometric-arm formula ${yGeo.toFixed(2)} kg, effective arm ${armEff.toFixed(3)} m → ${yEff.toFixed(2)} kg)`);
    expect(Math.abs(y.prop / yEff - 1)).toBeLessThan(0.02);
    expect(y.prop / yGeo - 1).toBeLessThan(0.05);
    const r = slew(2, 0.1);
    const rExp = (2 * r.I * 0.1) / (4.8 * ve);
    console.log(`roll slew: ${r.prop.toFixed(2)} kg (formula ${rExp.toFixed(2)} kg)`);
    expect(Math.abs(r.prop / rExp - 1)).toBeLessThan(0.02);
  });

  it('jet damping opposes the rate perpendicular to the arm', () => {
    const d = makeThrustOut();
    addJetDamping(d, 10, 0, 0, 15, 0.1, 0, 0.3); // arm along z: only ωx is perpendicular
    expect(d.dx).toBeCloseTo(-10 * 225 * 0.1, 12);
    expect(d.dz).toBeCloseTo(0, 12);
    expect(d.tx).toBe(d.dx);
  });
});

describe('the hydrazine blowdown pool', () => {
  it('thrust is a third at empty and ≈ 1 at full; vₑ follows 0.97 + 0.03·p/p₀', () => {
    expect(rcsBlowdown(0)).toBeCloseTo(1 / 3, 15);
    const full = rcsBlowdown(RCS_CAPACITY);
    console.log(`p/p0 at 1500 kg: ${full.toFixed(5)} (tank ${RCS_TANK_VOLUME} m³, liquid ${(RCS_CAPACITY / RCS_DENSITY).toFixed(4)} m³)`);
    expect(full).toBeGreaterThan(0.999); expect(full).toBeLessThan(1.002);
    const duty = new Float64Array(14), oF = makeThrustOut(), oE = makeThrustOut(), cmd = [1, 0, 0, 0, 0, 0];
    jetsStep(T, cmd, true, 1e-9, 0, 0, 0, 0, 0, 0, duty, oE);
    applyJets(T, duty, 1, 0, 0, 0, 0, 0, 0, clearThrustOut(oF));
    expect(oE.fx / oF.fx).toBeCloseTo(1 / 3, 9);
    expect(oE.mdotRcs / oF.mdotRcs).toBeCloseTo((1 / 3) / rcsVeFactor(1 / 3), 9);
    expect(rcsVeFactor(1 / 3)).toBeCloseTo(0.98, 15);
  });
});

describe('main drive: spool, ignition delay, minimum throttle', () => {
  const d = ENGINES[0];

  it('engines are canted so the pair passes through the CoM (≈ 0.73° in pitch)', () => {
    expect(d.dir.y).toBeLessThan(0); // exhaust slightly down, thrust line up through the CoM
    expect((Math.atan2(-d.dir.y, d.dir.z) * 180) / Math.PI).toBeCloseTo(0.7345, 3);
    const o = applyEngines(ENGINES, [4e5, 4e5], 0, 0, 0, 0, 0, 0, makeThrustOut());
    expect(Math.hypot(o.tx, o.ty, o.tz)).toBeLessThan(1e-6);
    expect(o.fz).toBeCloseTo(-8e5 * Math.cos(Math.atan(0.2 / 15.6)), 6);
    expect(o.mdotMain).toBeCloseTo(8e5 / 34e3, 12);
  });

  function run(F0: number, timer0: number, cmd: number, h: number, steps: number): { F: number; J: number; timer: number } {
    const th = [F0], tm = [timer0];
    let J = 0;
    const mm = [0];
    for (let i = 0; i < steps; i++) { engineUpdate(d, th, tm, 0, cmd, h, true, mm); J += mm[0] * h; }
    return { F: th[0], J, timer: tm[0] };
  }

  it('one 1 s step equals 120 steps of Q within 1e-12 relative (state and impulse)', () => {
    const cases: [number, number, number][] = [[0, 0, 1], [4e5, 0, 0.3], [1e5, 0, 0.9], [4e5, 0, 0.12], [2e5, 0.5, 1], [3e5, 0.2, 0.6]];
    for (const [F0, t0, c] of cases) {
      const a = run(F0, t0, c, 1, 1), b = run(F0, t0, c, Q, 120);
      expect(Math.abs(a.F - b.F) / Math.max(a.F, 1)).toBeLessThan(1e-12);
      expect(Math.abs(a.J - b.J) / Math.max(a.J, 1)).toBeLessThan(1e-12);
      expect(a.timer).toBe(b.timer);
    }
  });

  it('the step mean is the exact integral of the exponential', () => {
    const th = [0], tm = [0], mm = [0];
    engineUpdate(d, th, tm, 0, 1, 0.37, true, mm);
    const mean = mm[0];
    const tau = 0.8, Fc = 4e5;
    expect(mean).toBeCloseTo(Fc - Fc * (tau / 0.37) * (1 - Math.exp(-0.37 / tau)), 6);
    expect(th[0]).toBeCloseTo(Fc * (1 - Math.exp(-0.37 / tau)), 6);
  });

  it('ignition: 0.5 s with no thrust, and the step-cutting helper lands on its end', () => {
    const th = [0], tm = [ENGINE_UNLIT], mm = [0];
    const eu = (c: number, h: number, fuel: boolean) => { engineUpdate(d, th, tm, 0, c, h, fuel, mm); return mm[0]; };
    expect(eu(1, Q, true)).toBe(0);
    expect(tm[0]).toBeCloseTo(0.5 - Q, 15);
    let t = Q, cuts = 0;
    while (tm[0] > 0) {
      const h = engineEventTime(tm, 1, Q);
      if (h < Q) cuts++;
      expect(eu(1, h, true)).toBe(0);
      t += h;
    }
    expect(t).toBeCloseTo(0.5, 12);
    expect(tm[0]).toBe(0);
    expect(eu(1, Q, true)).toBeGreaterThan(0);
    // a dry pool is a flame-out
    expect(eu(1, Q, false)).toBe(0);
    expect(th[0]).toBe(0); expect(tm[0]).toBe(ENGINE_UNLIT);
    console.log(`ignition delay: ${cuts} step cut(s) with h = Q`);
  });

  it('hysteresis on the command: lights at ≥ 15%, out below 10%, never commands thrust between 10 and 15%', () => {
    let lit = false;
    const seen: number[] = [];
    const sweep = [0, 0.05, 0.1, 0.12, 0.149, 0.15, 0.3, 0.12, 0.11, 0.1, 0.0999, 0.12, 0.14, 0.16, 0.0];
    const litSeq: boolean[] = [];
    for (const c of sweep) {
      lit = engineLatch(lit, c);
      litSeq.push(lit);
      const F = engineCommandThrust(d, lit, c) / d.maxThrust;
      seen.push(F);
      expect(F === 0 || F >= 0.15).toBe(true);
    }
    expect(litSeq).toEqual([false, false, false, false, false, true, true, true, true, true, false, false, false, true, false]);
    // and the engine itself settles at 15% for a 12% command once lit
    const th = [0], tm = [0], mm = [0];
    engineUpdate(d, th, tm, 0, 0.5, 5, true, mm);
    for (let i = 0; i < 2000; i++) engineUpdate(d, th, tm, 0, 0.12, Q, true, mm);
    expect(th[0] / d.maxThrust).toBeCloseTo(0.15, 9);
    for (let i = 0; i < 2000; i++) engineUpdate(d, th, tm, 0, 0.09, Q, true, mm);
    expect(th[0]).toBeLessThan(1e-6); expect(tm[0]).toBe(ENGINE_UNLIT);
  });

  it('Flight Assist main-drive hysteresis 0.18 / 0.12', () => {
    expect(faMainDrive(false, 0.17, 1)).toBe(false);
    expect(faMainDrive(false, 0.19, 1)).toBe(true);
    expect(faMainDrive(true, 0.13, 1)).toBe(true);
    expect(faMainDrive(true, 0.11, 1)).toBe(false);
  });
});

describe('the rocket equation emerges per pool (minimal fixed-step integrator, h = Q)', () => {
  it('RCS pool with blowdown: Δv = η·vₑ₀·∫(0.97 + 0.03 p/p₀) dm/m within 1e-3', () => {
    const duty = new Float64Array(14), o = makeThrustOut(), cmd = [1, 0, 0, 0, 0, 0];
    let rcs = RCS_CAPACITY, m = M0, vx = 0;
    jetsStep(T, cmd, true, rcs, 0, 0, 0, 0, 0, 0, duty, o);
    const eta = o.fx / (o.mdotRcs * RCS_VE0 * rcsVeFactor(o.pRatio));
    while (rcs > 300) {
      jetsStep(T, cmd, true, rcs, 0, 0, 0, 0, 0, 0, duty, o);
      const dm = o.mdotRcs * Q;
      vx += (o.fx * Q) / (m - dm / 2);
      rcs -= dm; m -= dm;
      expect(Math.hypot(o.tx, o.ty, o.tz)).toBeLessThan(1e-6);
    }
    // Simpson over the total mass, the pool holding m − dry − main
    const m1 = m, N = 20000, hh = (M0 - m1) / N;
    const f = (mm: number) => rcsVeFactor(rcsBlowdown(mm - DRY - MAIN)) / mm;
    let s = f(m1) + f(M0);
    for (let i = 1; i < N; i++) s += (i & 1 ? 4 : 2) * f(m1 + i * hh);
    const dvExp = eta * RCS_VE0 * (s * hh) / 3;
    console.log(`RCS: η = ${eta.toFixed(5)}, Δv ${vx.toFixed(5)} m/s vs ${dvExp.toFixed(5)} m/s (rel ${(vx / dvExp - 1).toExponential(2)})`);
    expect(Math.abs(vx / dvExp - 1)).toBeLessThan(1e-3);
  });

  it('main pool with the spool from cold: Δv = vₑ·cos(cant)·ln(m₀/m₁) within 1e-3', () => {
    const th = [0, 0], tm = [ENGINE_UNLIT, ENGINE_UNLIT], mean = [0, 0], o = makeThrustOut();
    let m = M0, main = MAIN, vz = 0, t = 0;
    while (t < 300) {
      const h = engineEventTime(tm, 2, Q);
      for (let i = 0; i < 2; i++) engineUpdate(ENGINES[i], th, tm, i, t < 200 ? 1 : 0.4, h, main > 0, mean);
      clearThrustOut(o); applyEngines(ENGINES, mean, 0, 0, 0, 0, 0, 0, o);
      const dm = o.mdotMain * h;
      vz += (o.fz * h) / (m - dm / 2);
      main -= dm; m -= dm; t += h;
    }
    const dvExp = 34e3 * Math.cos(Math.atan(0.2 / 15.6)) * Math.log(M0 / m);
    console.log(`main: burnt ${(M0 - m).toFixed(2)} kg, Δv ${(-vz).toFixed(4)} vs ${dvExp.toFixed(4)} m/s (rel ${(-vz / dvExp - 1).toExponential(2)})`);
    expect(Math.abs(-vz / dvExp - 1)).toBeLessThan(1e-3);
  });
});

describe('settled-hold wake time', () => {
  it('scalar: the first t > 0 of θ₀ + ωt + ½αt² = ±θ_db', () => {
    expect(holdWakeTime(0, 1e-4, 0, 0.01)).toBeCloseTo(100, 9);
    expect(holdWakeTime(0.005, -1e-4, 0, 0.01)).toBeCloseTo(150, 9);
    expect(holdWakeTime(0, 0, 0, 0.01)).toBe(Infinity);
    expect(holdWakeTime(0, 0, 2e-6, 0.01)).toBeCloseTo(100, 9);
    // rate outward but acceleration back: turns round inside the band → wakes at the far side
    const t = holdWakeTime(0.004, 1e-4, -1e-6, 0.01);
    const th = (x: number) => 0.004 + 1e-4 * x - 0.5e-6 * x * x;
    expect(Math.abs(th(t))).toBeCloseTo(0.01, 12);
    for (let x = 0; x < t; x += t / 1000) expect(Math.abs(th(x))).toBeLessThanOrEqual(0.01 + 1e-15);
    expect(holdWakeTime(0.02, 0, 0, 0.01)).toBe(0);
  });

  it('vector: exact with α_b = 0, conservative (from below) with α_b > 0', () => {
    const e = [0.003, -0.002, 0.001], w = [1e-5, 3e-5, -2e-5], db = 0.0087;
    const t = holdWakeTimeVec(e[0], e[1], e[2], w[0], w[1], w[2], 0, db);
    expect(Math.hypot(e[0] + w[0] * t, e[1] + w[1] * t, e[2] + w[2] * t)).toBeCloseTo(db, 14);
    const a = 1e-8;
    const ta = holdWakeTimeVec(e[0], e[1], e[2], w[0], w[1], w[2], a, db);
    const g = (x: number) => Math.hypot(e[0] + w[0] * x, e[1] + w[1] * x, e[2] + w[2] * x) + 0.5 * a * x * x - db;
    expect(ta).toBeLessThan(t);
    expect(g(ta)).toBeLessThanOrEqual(1e-15);
    expect(g(ta * (1 + 1e-9))).toBeGreaterThan(-1e-12);
    expect(holdWakeTimeVec(0, 0, 0, 0, 0, 0, 0, db)).toBe(Infinity);
  });
});

describe('Flight Assist reference line of sight', () => {
  const R = 3.2e6, top = 127e3;
  const bodies = [{ r: v(1e9, 0, 0), radius: R, atmosphere: { height: top } }, { r: v(0, 0, 0), radius: 7e8, atmosphere: null }];
  const at = (x: number, y: number, z: number) => [1e9 + x, y, z] as const;

  it('is null behind the body and clear in front of it', () => {
    const a = at(-R - 400e3, 0, 0), b = at(R + 400e3, 0, 0);
    expect(lineOfSight(...a, ...b, bodies)).toBe(false);
    const c = at(-R - 400e3, 60e3, 0);
    expect(lineOfSight(...a, ...c, bodies)).toBe(true);
    expect(assistVisible(v(...a), v(...b), 100e3, bodies)).toBe(false);
    expect(assistVisible(v(...a), v(...c), 100e3, bodies)).toBe(true);
    expect(assistVisible(v(...a), v(...at(-R - 400e3, 150e3, 0)), 100e3, bodies)).toBe(false); // out of range
  });

  it('the atmosphere top blocks a grazing line, except for a craft flying inside the air', () => {
    const h = R + 60e3; // a chord whose lowest point is 60 km up: below the 127 km top
    const a = at(-1.2e6, h, 0), b = at(1.2e6, h, 0);
    expect(lineOfSight(...a, ...b, bodies)).toBe(false);
    const low = at(0, R + 50e3, 0), above = at(0, R + 400e3, 0);
    expect(lineOfSight(...low, ...above, bodies)).toBe(true);
  });
});

describe('the applied-force ledger', () => {
  const mk = (): Ledger => ({ fAcc: v(0, 0, 0), tauAcc: v(0, 0, 0), accT: 0, dvImpulse: v(0, 0, 0), dwImpulse: v(0, 0, 0) });

  it('accumulates step means and consumes them as the time-weighted mean, then zeroes', () => {
    const L = mk(), out = makeLedgerMean();
    ledgerAdd(L, 100, 0, -50, 1, 2, 3, Q);
    ledgerAdd(L, 300, 0, -50, 3, 2, 1, 3 * Q);
    consumeLedgerInto(L, out);
    expect(out.T).toBeCloseTo(4 * Q, 15);
    expect(out.f.x).toBeCloseTo(250, 9); expect(out.f.z).toBeCloseTo(-50, 9);
    expect(out.tau.x).toBeCloseTo(2.5, 12); expect(out.tau.z).toBeCloseTo(1.5, 12);
    expect(L.accT).toBe(0); expect(L.fAcc.x).toBe(0);
    consumeLedgerInto(L, out);
    expect(out.f.x).toBe(0); expect(out.T).toBe(0);
  });

  it('rotates inertial forces into craft axes; impulses give J/m and I⁻¹(r × J)', () => {
    const L = mk(), out = makeLedgerMean();
    const s = Math.SQRT1_2;
    ledgerAddInertial(L, { x: 0, y: s, z: 0, w: s }, 10, 0, 0, 0, 0, 0, 1); // craft yawed +90°: inertial +X is craft +Z
    ledgerImpulse(L, 0, 100, 0, 2, 0, 0, 50, 1, 2, 4);
    consumeLedgerInto(L, out);
    expect(out.f.x).toBeCloseTo(0, 12); expect(out.f.z).toBeCloseTo(10, 12);
    expect(out.dv.y).toBe(2);
    expect(out.dw.z).toBe((2 * 100) / 4);
  });
});

describe('save → load → step is bit-identical', () => {
  interface Sim extends JetState { v: V3; w: V3; rcs: number; main: number }
  const mkSim = (): Sim => ({
    jetDuty: new Array(14).fill(0), engineThrust: [0, 0], engineTimer: [ENGINE_UNLIT, ENGINE_UNLIT],
    rcsPropellant: RCS_CAPACITY, rcsPropellantCapacity: RCS_CAPACITY,
    fAcc: v(0, 0, 0), tauAcc: v(0, 0, 0), accT: 0, dvImpulse: v(0, 0, 0), dwImpulse: v(0, 0, 0), holdWakeT: Infinity,
    v: v(0, 0, 0), w: v(0, 0, 0), rcs: 0, main: MAIN,
  });
  const duty = new Float64Array(14), o = makeThrustOut(), mean = [0, 0], cmd = new Float64Array(6), lm = makeLedgerMean();
  function step(s: Sim, k: number): void {
    cmd[0] = Math.sin(k * 0.05); cmd[3] = 0.4 * Math.cos(k * 0.031); cmd[5] = k % 97 < 40 ? -0.7 : 0;
    const throttle = (k % 300) / 300;
    const h = engineEventTime(s.engineTimer, 2, Q);
    jetsStep(T, cmd, true, s.rcsPropellant, s.w.x, s.w.y, s.w.z, 0, 0, 0, duty, o);
    for (let i = 0; i < 2; i++) engineUpdate(ENGINES[i], s.engineThrust, s.engineTimer, i, throttle, h, s.main > 0, mean);
    applyEngines(ENGINES, mean, s.w.x, s.w.y, s.w.z, 0, 0, 0, o);
    const m = DRY + s.main + s.rcsPropellant;
    s.v.x += (o.fx / m) * h; s.v.y += (o.fy / m) * h; s.v.z += (o.fz / m) * h;
    s.w.x += (o.tx / (m * GYR.x)) * h; s.w.y += (o.ty / (m * GYR.y)) * h; s.w.z += (o.tz / (m * GYR.z)) * h;
    s.rcsPropellant -= o.mdotRcs * h; s.main -= o.mdotMain * h;
    ledgerAdd(s, o.fx, o.fy, o.fz, o.tx, o.ty, o.tz, h);
    for (let j = 0; j < 14; j++) s.jetDuty[j] = duty[j];
    if (k % 7 === 0) { consumeLedgerInto(s, lm); s.rcs += lm.f.x; }
    if (k === 120) s.holdWakeT = 1234.5678;
    if (k === 200) s.holdWakeT = Infinity;
  }
  it('mid-burn, mid-ignition and with a pending ledger', () => {
    const a = mkSim();
    for (let k = 0; k < 250; k++) step(a, k);
    expect(a.engineTimer.some((t) => t > 0) || a.engineThrust[0] > 0).toBe(true);
    const json = JSON.stringify({ jets: saveJetState(a), v: a.v, w: a.w, rcs: a.rcs, main: a.main });
    const raw = JSON.parse(json);
    const b: Sim = { ...loadJetState(raw.jets, 14, 2), v: raw.v, w: raw.w, rcs: raw.rcs, main: raw.main };
    for (let k = 250; k < 700; k++) { step(a, k); step(b, k); }
    const flat = (s: Sim) => [...s.jetDuty, ...s.engineThrust, ...s.engineTimer, s.rcsPropellant, s.fAcc.x, s.fAcc.y, s.fAcc.z, s.tauAcc.x, s.tauAcc.z, s.accT, s.v.x, s.v.y, s.v.z, s.w.x, s.w.y, s.w.z, s.rcs, s.main, s.holdWakeT];
    const fa = flat(a), fb = flat(b);
    for (let i = 0; i < fa.length; i++) expect(Object.is(fa[i], fb[i])).toBe(true);
  });

  it('loader defaults for an old save, and arrays resized to the craft', () => {
    const s = loadJetState({ jetDuty: [0.5] }, 14, 2);
    expect(s.jetDuty.length).toBe(14); expect(s.jetDuty[0]).toBe(0.5); expect(s.jetDuty[13]).toBe(0);
    expect(s.engineTimer).toEqual([ENGINE_UNLIT, ENGINE_UNLIT]);
    expect(s.rcsPropellant).toBe(RCS_CAPACITY); expect(s.holdWakeT).toBe(Infinity);
    expect(loadJetState(undefined, 0, 0).accT).toBe(0);
  });

  it('the table rebuilt at load is the same table', () => {
    const T2 = buildJetTable(jetsFromLayout([...SHIP_LAYOUTS.wren.rcs, ...WREN_Z_JETS]), ZERO);
    for (let i = 0; i < T.table.length; i++) expect(Object.is(T.table[i], T2.table[i])).toBe(true);
    for (let i = 0; i < N_COLS; i++) expect(Object.is(T.authority[i], T2.authority[i])).toBe(true);
  });
});

describe('cost', () => {
  it('per-step paths allocate nothing and cost well under a microsecond', async () => {
    const duty = new Float64Array(14), o = makeThrustOut(), cmd = new Float64Array([0.3, -0.2, 0.5, 0.4, -0.6, 0.2]);
    const th = [2e5, 2e5], tm = [0, 0], mean = [0, 0];
    const N = 1_000_000;
    const sink = new Float64Array(1);
    const jetsLoop = () => { for (let i = 0; i < N; i++) { cmd[0] = (i & 7) * 0.1; jetsStep(T, cmd, true, 900, 0.01, 0, 0, 0, 0, 0, duty, o); sink[0] += o.mdotRcs; } };
    const engLoop = () => {
      for (let i = 0; i < N; i++) {
        for (let e = 0; e < 2; e++) engineUpdate(ENGINES[e], th, tm, e, (i & 1023) < 512 ? 1 : 0.5, Q, true, mean);
        clearThrustOut(o); applyEngines(ENGINES, mean, 0.01, 0, 0, 0, 0, 0, o); sink[0] += o.fz;
      }
    };
    jetsLoop(); engLoop(); // warm up
    let t0 = performance.now(); jetsLoop(); const tj = ((performance.now() - t0) / N) * 1e3;
    t0 = performance.now(); engLoop(); const te = ((performance.now() - t0) / N) * 1e3;
    t0 = performance.now();
    for (let i = 0; i < 100; i++) buildJetTable(WREN_JETS, ZERO);
    const tb = (performance.now() - t0) / 100;
    console.log(`node: jetsStep ${tj.toFixed(3)} µs, 2 × engineUpdate + applyEngines ${te.toFixed(3)} µs, buildJetTable ${tb.toFixed(3)} ms (sink ${sink[0] > 0 ? '+' : '-'})`);
    expect(tj).toBeLessThan(2);
    expect(te).toBeLessThan(2);
    expect(await gcCount(jetsLoop)).toBe(0);
    expect(await gcCount(engLoop)).toBe(0);
  });
});
