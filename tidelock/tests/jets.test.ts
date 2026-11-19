// W1-B real thrusters: the pure core of src/world/jets.ts (allocation, blowdown, spool, hold wake, LOS, ledger).
import { describe, expect, it } from 'vitest';
import type { V3 } from '../src/core/types';
import { HULL_COLLIDERS, type HullPartDef } from '../src/data/hullColliders';
import { SHIP_LAYOUTS } from '../src/data/shipLayouts';
import {
  ENGINE_TAIL_EPS, ENGINE_UNLIT, IN_CX, IN_H, IN_IX, IN_IY, IN_IZ, IN_M, IN_P, IN_RCS, IN_THROTTLE, IN_WX, IN_WY, IN_WZ,
  N_COLS, Q, RCS_CAPACITY, RCS_DENSITY, RCS_VE0,
  addJetDamping, airStep, allocateJets, applyEngines, applyJets, assistVisible, buildJetTable, clearThrustOut,
  consumeLedgerInto, engineActive, engineCommandThrust, engineCutStep, engineDef, engineLatch, engineUpdate,
  faMainDrive, forceAuthority, holdAlpha, holdCmdToJets, holdWakeTime, holdWakeTimeVec, jetEdgeMasks, jetsFromLayout,
  jetsStep, ledgerAdd, ledgerAddInertialForce, ledgerImpulse, lineOfSight, lpMinimize, loadJetState, makeLedgerMean,
  makeStepIn, makeThrustOut, rcsBlowdown, rcsTankVolume, rcsVeFactor, rk4MeanV, saveJetState, setPressure,
  suttonGraves, torqueAuthority, torqueToCmd, type JetDef, type JetState, type JetTable, type Ledger,
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

/**
 * The Wren's 10 layout jets plus the 4 Z jets wave 1 adds to shipLayouts.ts, at positions checked against
 * HULL_COLLIDERS below (the plan's (±1.0, 0, −14.8) is inside the windscreen, (±6.0, −0.2, 13.0) fires into the pod).
 */
const WREN_Z_JETS = [
  { pos: v(2.8, -0.1, -14.45), dir: v(0, 0, -1) },
  { pos: v(-2.8, -0.1, -14.45), dir: v(0, 0, -1) },
  { pos: v(7.2, -0.6, 11.0), dir: v(0, 0, 1) },
  { pos: v(-7.2, -0.6, 11.0), dir: v(0, 0, 1) },
];
/** The Albatross has no roll authority today (every jet has a zero roll arm): wing-tip ±Y jets. */
const ALBATROSS_ROLL_JETS = [
  { pos: v(14.5, 0.34, 9.775), dir: v(0, 1, 0) },
  { pos: v(-14.5, 0.34, 9.775), dir: v(0, 1, 0) },
  { pos: v(14.5, -0.26, 9.775), dir: v(0, -1, 0) },
  { pos: v(-14.5, -0.26, 9.775), dir: v(0, -1, 0) },
];
const WREN_JETS = jetsFromLayout([...SHIP_LAYOUTS.wren.rcs, ...WREN_Z_JETS]);
const T = buildJetTable(WREN_JETS, ZERO);
const ENGINES = SHIP_LAYOUTS.wren.engines.map((e) => engineDef(e.pos, ZERO));

// Wren mass properties as setup.ts builds them today: a uniform 19 × 6.6 × 32 m box of 42.9 t + 24 t.
const DRY = 42900, MAIN = 22500, M0 = DRY + MAIN + RCS_CAPACITY;
const GYR = v((6.6 ** 2 + 32 ** 2) / 12, (19 ** 2 + 32 ** 2) / 12, (19 ** 2 + 6.6 ** 2) / 12);

/** A step input with the pool at `rcs` kg (p/p₀ written), rate w, CoM at the origin, h = Q. */
function stepIn(rcs = RCS_CAPACITY, w: V3 = ZERO, h = Q, throttle = 0): Float64Array {
  const inp = makeStepIn();
  inp[IN_H] = h; inp[IN_RCS] = rcs; inp[IN_WX] = w.x; inp[IN_WY] = w.y; inp[IN_WZ] = w.z; inp[IN_THROTTLE] = throttle;
  setPressure(T, inp);
  return inp;
}
const P1 = stepIn(); // full pool: p/p₀ = 1 exactly

function columnVector(T: JetTable, k: number): number[] {
  const duty = new Float64Array(T.n);
  for (let j = 0; j < T.n; j++) duty[j] = T.table[k * T.n + j];
  const o = applyJets(T, duty, P1, makeThrustOut());
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
    expect(T.deadCols).toBe(0);
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
    const ta = torqueAuthority(T, P1, v(0, 0, 0)), fa = forceAuthority(T, P1, v(0, 0, 0));
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
    expect(lpMinimize(2, 2, [1, 1, 2, 2], [1, 2], [1, 3], new Uint8Array([1, 1]), x)).toBeCloseTo(1, 12);
    expect(x[0]).toBeCloseTo(1, 12);
    expect(lpMinimize(1, 2, [1, -1], [-1], [1, 1], new Uint8Array([1, 0]), x)).toBe(-1);
  });

  it('a dead jet removes its column entries; an axis nothing can make purely has zero authority and a deadCols bit', () => {
    const health = new Float64Array(14).fill(1);
    WREN_JETS.forEach((j, i) => { if (j.dir.z < -0.5) health[i] = 0; }); // both nose Z jets dead: no +Fz (aft push)
    const Td = buildJetTable(WREN_JETS, ZERO, { thrustScale: health });
    expect(Td.authority[4]).toBe(0);
    expect(Td.deadCols).toBe(1 << 4);
    for (let j = 0; j < 14; j++) if (health[j] === 0) for (let k = 0; k < N_COLS; k++) expect(Td.table[k * 14 + j]).toBe(0);
    expect(Td.authority[5]).toBeGreaterThan(0);
  });
});

describe('every hull: torque authority on all six torque columns (D3)', () => {
  const hulls = Object.keys(SHIP_LAYOUTS) as (keyof typeof SHIP_LAYOUTS)[];
  const extra: Record<string, { pos: V3; dir: V3 }[]> = { wren: WREN_Z_JETS, albatross: ALBATROSS_ROLL_JETS };
  const cols = (m: number) => Array.from({ length: 12 }, (_, k) => (m >> k) & 1 ? ['+Fx', '-Fx', '+Fy', '-Fy', '+Fz', '-Fz', '+τx', '-τx', '+τy', '-τy', '+τz', '-τz'][k] : '').filter(Boolean).join(' ');

  it('today: only the Albatross has a dead torque axis (roll); with its wing-tip jets every hull has all six', () => {
    const report: string[] = [];
    for (const id of hulls) {
      const now = buildJetTable(jetsFromLayout(SHIP_LAYOUTS[id].rcs), ZERO);
      const fixed = buildJetTable(jetsFromLayout([...SHIP_LAYOUTS[id].rcs, ...(extra[id] ?? [])]), ZERO);
      report.push(`${id}: dead today [${cols(now.deadCols)}] → with wave-1 jets [${cols(fixed.deadCols)}]`);
      expect(now.deadCols & 0xfc0).toBe(id === 'albatross' ? (1 << 10) | (1 << 11) : 0);
      expect(fixed.deadCols & 0xfc0).toBe(0);
      for (let k = 6; k < 12; k++) expect(fixed.authority[k]).toBeGreaterThan(0);
    }
    const alb = buildJetTable(jetsFromLayout([...SHIP_LAYOUTS.albatross.rcs, ...ALBATROSS_ROLL_JETS]), ZERO);
    report.push(`albatross roll authority with the tip jets: ${(Math.min(alb.authority[10], alb.authority[11]) / 1e3).toFixed(1)} kN·m (68 kN pack)`);
    console.log(report.join('\n'));
  });

  it('holdAlpha takes the minimum over the axes that have authority (one dead axis does not freeze the hold)', () => {
    const S = new Float64Array(1);
    holdAlpha(v(721480, 789480, 0), v(1e6, 2e6, 3e6), S); expect(S[0]).toBeCloseTo(789480 / 2e6, 12);
    holdAlpha(v(4, 9, 1), v(2, 3, 1), S); expect(S[0]).toBe(1);
    holdAlpha(v(0, 0, 0), v(1, 1, 1), S); expect(S[0]).toBe(0);
  });
});

describe('the jets sit on the hull with a clear plume (D8)', () => {
  type P = [number, number, number];
  const qinv = (q: number[], p: P): P => {
    const [x, y, z, w] = q, qx = -x, qy = -y, qz = -z;
    const tx = 2 * (qy * p[2] - qz * p[1]), ty = 2 * (qz * p[0] - qx * p[2]), tz = 2 * (qx * p[1] - qy * p[0]);
    return [p[0] + w * tx + (qy * tz - qz * ty), p[1] + w * ty + (qz * tx - qx * tz), p[2] + w * tz + (qx * ty - qy * tx)];
  };
  const sdPart = (p: HullPartDef, x: P): number => {
    if (p.kind === 'sphere') return Math.hypot(x[0] - p.c[0], x[1] - p.c[1], x[2] - p.c[2]) - p.r;
    if (p.kind === 'capsule') {
      const ab = [p.b[0] - p.a[0], p.b[1] - p.a[1], p.b[2] - p.a[2]], ap = [x[0] - p.a[0], x[1] - p.a[1], x[2] - p.a[2]];
      const l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
      const t = Math.max(0, Math.min(1, l2 > 0 ? (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / l2 : 0));
      return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t) - p.r;
    }
    let l: P = [x[0] - p.c[0], x[1] - p.c[1], x[2] - p.c[2]];
    if (p.q) l = qinv(p.q, l);
    const d = [Math.abs(l[0]) - p.h[0], Math.abs(l[1]) - p.h[1], Math.abs(l[2]) - p.h[2]];
    return Math.hypot(Math.max(d[0], 0), Math.max(d[1], 0), Math.max(d[2], 0)) + Math.min(Math.max(d[0], d[1], d[2]), 0);
  };
  const sd = (id: string, x: P) => Math.min(...(HULL_COLLIDERS as Record<string, HullPartDef[]>)[id].map((p) => sdPart(p, x)));
  /** Smallest hull clearance over the exhaust axis and a 15° cone, 0.3 to 6 m out. */
  const plume = (id: string, pos: V3, dir: V3): number => {
    const a = Math.abs(dir.x) < 0.9 ? v(1, 0, 0) : v(0, 1, 0);
    const u = v(dir.y * a.z - dir.z * a.y, dir.z * a.x - dir.x * a.z, dir.x * a.y - dir.y * a.x);
    const ul = Math.hypot(u.x, u.y, u.z); u.x /= ul; u.y /= ul; u.z /= ul;
    const w = v(dir.y * u.z - dir.z * u.y, dir.z * u.x - dir.x * u.z, dir.x * u.y - dir.y * u.x);
    let worst = Infinity;
    for (let s = 0.3; s <= 6; s += 0.05) for (let k = -1; k < 8; k++) {
      const rr = k < 0 ? 0 : s * Math.tan((15 * Math.PI) / 180), c = Math.cos((k * Math.PI) / 4), sn = Math.sin((k * Math.PI) / 4);
      worst = Math.min(worst, sd(id, [pos.x + dir.x * s + rr * (c * u.x + sn * w.x), pos.y + dir.y * s + rr * (c * u.y + sn * w.y), pos.z + dir.z * s + rr * (c * u.z + sn * w.z)]));
    }
    return worst;
  };

  it('the new Wren Z jets and Albatross roll jets: on the skin (|d| ≤ 0.3 m) and the plume cone clear', () => {
    const rows: string[] = [];
    for (const [id, jets] of [['wren', WREN_Z_JETS], ['albatross', ALBATROSS_ROLL_JETS]] as const) {
      for (const j of jets) {
        const s = sd(id, [j.pos.x, j.pos.y, j.pos.z]), c = plume(id, j.pos, j.dir);
        rows.push(`${id} (${j.pos.x}, ${j.pos.y}, ${j.pos.z}) → (${j.dir.x}, ${j.dir.y}, ${j.dir.z}): skin ${s.toFixed(3)} m, plume clearance ${c.toFixed(3)} m`);
        expect(Math.abs(s)).toBeLessThanOrEqual(0.3);
        expect(c).toBeGreaterThan(0.05);
      }
    }
    // the rejected positions, for the record
    expect(sd('wren', [1.0, 0, -14.8])).toBeLessThan(-0.2); // inside the nose / windscreen
    expect(sd('wren', [2.2, -0.3, -14.6])).toBeLessThan(0); // inside cheek-fwd (the first proposal)
    expect(plume('wren', v(6.0, -0.2, 13.0), v(0, 0, 1))).toBeLessThan(0); // fires into the pod stern
    // existing jets whose plume touches the hull (wave 1's shipLayouts work, not fixed here)
    for (const id of Object.keys(SHIP_LAYOUTS) as (keyof typeof SHIP_LAYOUTS)[]) for (const j of SHIP_LAYOUTS[id].rcs) {
      const c = plume(id, j.pos, j.dir);
      if (c < 0) rows.push(`existing ${id} jet at (${j.pos.x}, ${j.pos.y}, ${j.pos.z}): plume clearance ${c.toFixed(3)} m`);
    }
    console.log(rows.join('\n'));
  });
});

describe('per-step allocation and what the jets actually do', () => {
  const duty = new Float64Array(14), o = makeThrustOut(), cmd = new Float64Array(6);
  const fa = forceAuthority(T, P1, v(0, 0, 0));
  const fMin = Math.min(fa.x, fa.y, fa.z);

  it('a pure torque command gives |F| ≤ 1% of authority (single axes, and torque-only mixes)', () => {
    let worst = 0;
    const mixes = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0], [0, 0, -1], [0.5, 0.5, 0], [0.3, -0.4, 0.5], [-0.2, 0.2, -0.6], [1, 1, 1], [-1, 1, -1]];
    for (const m of mixes) {
      cmd.fill(0); cmd[3] = m[0]; cmd[4] = m[1]; cmd[5] = m[2];
      jetsStep(T, cmd, true, P1, duty, o);
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
    clearThrustOut(o); applyJets(T, duty, P1, o);
    expect(sat).toBeGreaterThan(0);
    const kx = o.fx / T.authority[0], ky = o.ty / T.authority[8];
    expect(kx).toBeLessThan(1);
    expect(kx).toBeCloseTo(ky, 9);
    expect(Math.abs(o.fy) + Math.abs(o.fz)).toBeLessThan(1e-6);
    cmd.fill(0); cmd[3] = 1; cmd[4] = 1; cmd[5] = 1;
    const clip = new Float64Array(14);
    for (let a = 3; a < 6; a++) for (let j = 0; j < 14; j++) clip[j] += T.table[2 * a * 14 + j];
    for (let j = 0; j < 14; j++) clip[j] = Math.min(1, clip[j]);
    clearThrustOut(o); applyJets(T, clip, P1, o);
    console.log(`per-jet clipping of a full 3-axis torque would add |F| = ${(Math.hypot(o.fx, o.fy, o.fz) / 1e3).toFixed(1)} kN of spurious translation`);
  });

  it('a dry pool, or a landed / docked craft, applies nothing: zero duty, zero torque', () => {
    cmd.fill(0); cmd[3] = 1; cmd[4] = -1; cmd[0] = 1;
    expect(jetsStep(T, cmd, true, stepIn(0, v(0.1, 0, 0)), duty, o).mdotRcs).toBe(0);
    expect([o.fx, o.fy, o.fz, o.tx, o.ty, o.tz, o.mdotRcs].every((x) => x === 0)).toBe(true);
    expect(Array.from(duty).every((d) => d === 0)).toBe(true);
    jetsStep(T, cmd, false, P1, duty, o);
    expect(o.tx === 0 && o.ty === 0 && o.tz === 0 && Array.from(duty).every((d) => d === 0)).toBe(true);
  });

  it('torqueToCmd maps N·m onto the signed columns at the current pool', () => {
    const c = new Float64Array(6);
    for (const m of [RCS_CAPACITY, 400]) {
      const inp = stepIn(m);
      torqueToCmd(T, inp, v(1e5, -2e5, 5e4), c);
      jetsStep(T, c, true, inp, duty, o);
      expect(o.tx).toBeCloseTo(1e5, 3); expect(o.ty).toBeCloseTo(-2e5, 3); expect(o.tz).toBeCloseTo(5e4, 3);
    }
  });

  it('holdCmdToJets: the hold output (normalised by min ±) delivers exactly hold·authority on an asymmetric hull (D9)', () => {
    const A = buildJetTable(jetsFromLayout([...SHIP_LAYOUTS.albatross.rcs, ...ALBATROSS_ROLL_JETS]), ZERO);
    const asym = A.authority[6] / A.authority[7];
    const inp = makeStepIn(); inp[IN_RCS] = 700; inp[IN_H] = Q; setPressure(A, inp);
    const auth = torqueAuthority(A, inp, v(0, 0, 0));
    const d = new Float64Array(A.n), c = new Float64Array(6), oo = makeThrustOut();
    for (const hold of [v(0.6, -0.3, 0.2), v(-0.6, 0.3, -0.2), v(1, 1, -1), v(-1, -1, 1)]) {
      c.fill(0); holdCmdToJets(A, hold, c);
      jetsStep(A, c, true, inp, d, oo);
      // an unsaturated hold is exact; a saturated mix keeps its direction and loses magnitude together
      if (Math.abs(hold.x) < 1) {
        expect(oo.tx).toBeCloseTo(hold.x * auth.x, 3); expect(oo.ty).toBeCloseTo(hold.y * auth.y, 3); expect(oo.tz).toBeCloseTo(hold.z * auth.z, 3);
      } else {
        expect(oo.tx / (hold.x * auth.x)).toBeCloseTo(oo.ty / (hold.y * auth.y), 9);
        expect(oo.tz / (hold.z * auth.z)).toBeCloseTo(oo.ty / (hold.y * auth.y), 9);
      }
    }
    console.log(`albatross pitch ± authority ratio ${asym.toFixed(4)}: without holdCmdToJets the stronger side over-delivers by ${((Math.max(asym, 1 / asym) - 1) * 100).toFixed(1)}%`);
  });

  it('jet edges come out as on/off masks', () => {
    const e = { on: 0, off: 0 };
    jetEdgeMasks([0, 1, 0.5, 0], [0.2, 0, 0.5, 0], 4, e);
    expect(e.on).toBe(1); expect(e.off).toBe(2);
  });

  function slew(axis: 0 | 1 | 2, target: number): { prop: number; I: number } {
    // a minimal single-axis rotation integrator at h = Q: full command, the last step trimmed to land on the target
    const I = M0 * [GYR.x, GYR.y, GYR.z][axis];
    let w = 0, prop = RCS_CAPACITY;
    const inp = stepIn();
    const tq = (oo: typeof o) => [oo.tx, oo.ty, oo.tz][axis];
    for (const goal of [target, 0]) {
      for (let i = 0; i < 1e5 && Math.abs(goal - w) > 1e-15; i++) {
        cmd.fill(0);
        cmd[3 + axis] = goal > w ? 1 : -1;
        inp[IN_RCS] = prop;
        jetsStep(T, cmd, true, inp, duty, o);
        const dw = (tq(o) / I) * Q;
        if (Math.abs(dw) > Math.abs(goal - w)) {
          cmd[3 + axis] *= Math.abs(goal - w) / Math.abs(dw);
          jetsStep(T, cmd, true, inp, duty, o);
          w = goal;
        } else w += dw;
        prop -= o.mdotRcs * Q;
      }
    }
    return { prop: RCS_CAPACITY - prop, I };
  }

  it('propellant per slew matches 2·I·ω/(arm·vₑ) with the GEOMETRIC arm: pitch, roll within 2%; yaw 4.3% (roll trim)', () => {
    const ve = RCS_VE0 * rcsVeFactor(1);
    const p = slew(0, 0.1);
    const pExp = (2 * p.I * 0.1) / (12.25 * ve); // (12.5 + 12)/2
    const y = slew(1, 0.1);
    const yGeo = (2 * y.I * 0.1) / (11.5 * ve); // (12 + 11)/2
    const r = slew(2, 0.1);
    const rExp = (2 * r.I * 0.1) / (4.8 * ve);
    console.log(`slews to 0.1 rad/s and back: pitch ${p.prop.toFixed(2)} kg (formula ${pExp.toFixed(2)}, ${((p.prop / pExp - 1) * 100).toFixed(2)}%), yaw ${y.prop.toFixed(2)} kg (formula ${yGeo.toFixed(2)}, ${((y.prop / yGeo - 1) * 100).toFixed(2)}%), roll ${r.prop.toFixed(2)} kg (formula ${rExp.toFixed(2)}, ${((r.prop / rExp - 1) * 100).toFixed(2)}%)`);
    expect(Math.abs(p.prop / pExp - 1)).toBeLessThan(0.02);
    expect(Math.abs(r.prop / rExp - 1)).toBeLessThan(0.02);
    // yaw: the nose X jets sit at y +0.2 and the tail X jets at y −0.2, so a pure yaw couple also makes
    // 0.4·34 kN = 13.6 kN·m of roll, trimmed by the tail Y jets. That trim is real propellant: the plan's 2% does
    // not hold for yaw on this geometry. Bounded honestly at 5% and pinned to the measured 4.3%.
    expect(y.prop / yGeo - 1).toBeGreaterThan(0.035);
    expect(y.prop / yGeo - 1).toBeLessThan(0.05);
  });

  it('jet damping opposes the rate perpendicular to the arm (reference form = the inlined per-step form)', () => {
    const d = makeThrustOut();
    addJetDamping(d, 10, 0, 0, 15, 0.1, 0, 0.3);
    expect(d.dx).toBeCloseTo(-10 * 225 * 0.1, 12);
    expect(d.dz).toBeCloseTo(0, 12);
    expect(d.tx).toBe(d.dx);
    cmd.fill(0); cmd[3] = 0.7; cmd[1] = 0.4;
    const inp = stepIn(900, v(0.02, -0.05, 0.01));
    jetsStep(T, cmd, true, inp, duty, o);
    const ref = makeThrustOut(), p = inp[IN_P], ms = p / rcsVeFactor(p);
    for (let j = 0; j < 14; j++) if (duty[j] > 0) {
      const J = WREN_JETS[j];
      addJetDamping(ref, duty[j] * J.thrust * ms / J.ve, J.pos.x, J.pos.y, J.pos.z, 0.02, -0.05, 0.01);
    }
    expect(o.dx).toBeCloseTo(ref.dx, 9); expect(o.dy).toBeCloseTo(ref.dy, 9); expect(o.dz).toBeCloseTo(ref.dz, 9);
  });
});

describe('the hydrazine blowdown pool', () => {
  it('thrust is a third at empty and exactly 1 at full; vₑ follows 0.97 + 0.03·p/p₀', () => {
    expect(rcsBlowdown(0)).toBe(1 / 3);
    expect(rcsBlowdown(RCS_CAPACITY)).toBe(1);
    // the plan's V_t = 2.24 m³ is the capacity's tank to rounding: 1500·3/(2·1004)
    expect(rcsTankVolume(RCS_CAPACITY, RCS_DENSITY, 3)).toBeCloseTo(2.241, 3);
    expect(T.tankVolume).toBeCloseTo(2.241, 3);
    // isothermal: p₀V_u0 = pV_u with V_u = V_t − m/ρ
    const Vt = T.tankVolume;
    for (const m of [0, 300, 750, 1200, 1499]) expect(rcsBlowdown(m)).toBeCloseTo((Vt / 3) / (Vt - m / RCS_DENSITY), 12);
    const duty = new Float64Array(14), oF = makeThrustOut(), oE = makeThrustOut(), cmd = [1, 0, 0, 0, 0, 0];
    jetsStep(T, cmd, true, stepIn(1e-9), duty, oE);
    applyJets(T, duty, P1, clearThrustOut(oF));
    expect(oE.fx / oF.fx).toBeCloseTo(1 / 3, 9);
    expect(oE.mdotRcs / oF.mdotRcs).toBeCloseTo((1 / 3) / rcsVeFactor(1 / 3), 9);
    expect(rcsVeFactor(1 / 3)).toBeCloseTo(0.98, 15);
  });

  it('bounded above: an overfilled pool runs at p₀, never more (D5)', () => {
    for (const m of [1500.0001, 2000, 2248, 3000, Infinity]) expect(rcsBlowdown(m)).toBe(1);
    const duty = new Float64Array(14), o = makeThrustOut();
    jetsStep(T, [1, 0, 0, 0, 0, 0], true, stepIn(3000), duty, o);
    expect(o.fx).toBeCloseTo(T.authority[0], 6);
    const s = loadJetState({ rcsPropellant: 3000, rcsPropellantCapacity: 1500 }, 14, 2, 1500);
    expect(s.rcsPropellant).toBe(1500);
    expect(loadJetState({ rcsPropellant: -5 }, 14, 2, 1500).rcsPropellant).toBe(0);
    // a refit to a smaller pool wins over the saved capacity
    expect(loadJetState({ rcsPropellant: 1500, rcsPropellantCapacity: 1500 }, 14, 2, 800).rcsPropellant).toBe(800);
  });
});

describe('fitted modules drive the numbers, not the Wren constants (D4)', () => {
  it('RCS pack thrust / vₑ, the drive share per nozzle and the tank all come from the fit', () => {
    const big = buildJetTable(jetsFromLayout([...SHIP_LAYOUTS.wren.rcs, ...WREN_Z_JETS], 920e3, 2400), ZERO, { rcsCapacity: 4000 });
    for (let k = 0; k < N_COLS; k++) expect(big.authority[k] / T.authority[k]).toBeCloseTo(920 / 68, 9);
    expect(big.cost[0] / T.cost[0]).toBeCloseTo((920 / 68) * (2250 / 2400), 9);
    expect(big.tankVolume).toBeCloseTo((4000 * 3) / (2 * RCS_DENSITY), 12);
    const inp = makeStepIn(); inp[IN_RCS] = 2000; setPressure(big, inp);
    expect(inp[IN_P]).toBeCloseTo(1 / (3 - 2 * 0.5), 15); // half of a 4 t pool
    const eng = SHIP_LAYOUTS.wren.engines.map((e) => engineDef(e.pos, ZERO, 1.33e7 / 2, 11800));
    const o = applyEngines(eng, [eng[0].maxThrust, eng[1].maxThrust], makeStepIn(), makeThrustOut());
    expect(-o.fz).toBeCloseTo(1.33e7 * Math.cos(Math.atan(0.2 / 15.6)), 3);
    expect(o.mdotMain).toBeCloseTo(1.33e7 / 11800, 9);
  });
});

describe('main drive: spool, ignition delay, minimum throttle', () => {
  const d = ENGINES[0];

  it('engines are canted so the pair passes through the CoM (≈ 0.73° in pitch)', () => {
    expect(d.dir.y).toBeLessThan(0);
    expect((Math.atan2(-d.dir.y, d.dir.z) * 180) / Math.PI).toBeCloseTo(0.7345, 3);
    const o = applyEngines(ENGINES, [4e5, 4e5], makeStepIn(), makeThrustOut());
    expect(Math.hypot(o.tx, o.ty, o.tz)).toBeLessThan(1e-6);
    expect(o.fz).toBeCloseTo(-8e5 * Math.cos(Math.atan(0.2 / 15.6)), 6);
    expect(o.mdotMain).toBeCloseTo(8e5 / 34e3, 12);
  });

  function run(F0: number, timer0: number, cmd: number, h: number, steps: number): { F: number; J: number; timer: number } {
    const th = [F0], tm = [timer0], mm = [0], inp = makeStepIn();
    inp[IN_H] = h; inp[IN_THROTTLE] = cmd;
    let J = 0;
    for (let i = 0; i < steps; i++) { engineUpdate(d, th, tm, 0, true, inp, mm); J += mm[0] * h; }
    return { F: th[0], J, timer: tm[0] };
  }

  it('one 1 s step equals 120 steps of Q within 1e-12 relative (state and impulse), shut-down tails included', () => {
    const cases: [number, number, number, number][] = [
      [0, 0, 1, 1], [4e5, 0, 0.3, 1], [1e5, 0, 0.9, 1], [4e5, 0, 0.12, 1], [2e5, 0.5, 1, 1], [3e5, 0.2, 0.6, 1],
      [4e5, ENGINE_UNLIT, 0, 1], [4e5, 0, 0.05, 10], [6e4, ENGINE_UNLIT, 0, 10], [4e5, ENGINE_UNLIT, 0.5, 1],
    ];
    for (const [F0, t0, c, T1] of cases) {
      const a = run(F0, t0, c, T1, 1), b = run(F0, t0, c, Q, Math.round(120 * T1));
      expect(Math.abs(a.F - b.F) / Math.max(a.F, 1)).toBeLessThan(1e-12);
      expect(Math.abs(a.J - b.J) / Math.max(a.J, 1)).toBeLessThan(1e-12);
      expect(a.timer).toBe(b.timer);
    }
  });

  it('after shut-down the thrust reaches exactly 0 at τ_down·ln(F/ε) and never sits at a denormal (D1)', () => {
    const th = [4e5], tm = [0], mm = [0], inp = makeStepIn();
    inp[IN_H] = Q; inp[IN_THROTTLE] = 0;
    const eps = ENGINE_TAIL_EPS * d.maxThrust;
    let t = 0, tZero = -1, J = 0, tiny = 0, late = 0;
    for (let i = 0; i < 3600 * 120; i++) {
      engineUpdate(d, th, tm, 0, true, inp, mm);
      t += Q; J += mm[0] * Q;
      if (th[0] > 0 && th[0] < eps) tiny++;
      if (tZero > 0 && mm[0] !== 0) late++; // every step AFTER the one the tail ended in applies nothing
      if (th[0] === 0 && tZero < 0) tZero = t;
    }
    const tOff = 0.3 * Math.log(4e5 / eps);
    console.log(`shut-down tail: F_s = 0 exactly after ${tZero.toFixed(4)} s (closed form ${tOff.toFixed(4)} s), impulse ${J.toFixed(3)} N·s vs τ(F₀ − ε) ${(0.3 * (4e5 - eps)).toFixed(3)}; 1 h later F_s = ${th[0]}, mean = ${mm[0]}`);
    expect(tiny).toBe(0); expect(late).toBe(0);
    expect(th[0]).toBe(0); expect(mm[0]).toBe(0);
    expect(tZero).toBeGreaterThanOrEqual(tOff); expect(tZero).toBeLessThan(tOff + Q * 1.0001);
    expect(J / (0.3 * (4e5 - eps)) - 1).toBeLessThan(1e-12);
    expect(engineActive(th, tm, 1)).toBe(false);
    expect(engineActive([0], [0.3], 1)).toBe(true); // in the ignition delay
    expect(engineActive([5], [ENGINE_UNLIT], 1)).toBe(true); // still spooling down
  });

  it('the step mean is the exact integral of the exponential', () => {
    const th = [0], tm = [0], mm = [0], inp = makeStepIn();
    inp[IN_H] = 0.37; inp[IN_THROTTLE] = 1;
    engineUpdate(d, th, tm, 0, true, inp, mm);
    const tau = 0.8, Fc = 4e5;
    expect(mm[0]).toBeCloseTo(Fc - Fc * (tau / 0.37) * (1 - Math.exp(-0.37 / tau)), 6);
    expect(th[0]).toBeCloseTo(Fc * (1 - Math.exp(-0.37 / tau)), 6);
  });

  it('ignition: 0.5 s with no thrust, and the step-cutting helper lands on its end', () => {
    const th = [0], tm = [ENGINE_UNLIT], mm = [0], inp = makeStepIn();
    inp[IN_THROTTLE] = 1;
    const eu = (h: number, en: boolean) => { inp[IN_H] = h; engineUpdate(d, th, tm, 0, en, inp, mm); return mm[0]; };
    expect(eu(Q, true)).toBe(0);
    expect(tm[0]).toBeCloseTo(0.5 - Q, 15);
    let t = Q, cuts = 0;
    while (tm[0] > 0) {
      inp[IN_H] = Q; engineCutStep(tm, 1, inp);
      const h = inp[IN_H];
      if (h < Q) cuts++;
      expect(eu(h, true)).toBe(0);
      t += h;
    }
    expect(t).toBeCloseTo(0.5, 12);
    expect(tm[0]).toBe(0);
    expect(eu(Q, true)).toBeGreaterThan(0);
    // not enabled (dry main pool, docked, destroyed): out at once
    expect(eu(Q, false)).toBe(0);
    expect(th[0]).toBe(0); expect(tm[0]).toBe(ENGINE_UNLIT);
    console.log(`ignition delay: ${cuts} step cut(s) with h = Q`);
  });

  it('hysteresis on the command: lights at ≥ 15%, out below 10%, never commands thrust between 10 and 15%', () => {
    let lit = false;
    const sweep = [0, 0.05, 0.1, 0.12, 0.149, 0.15, 0.3, 0.12, 0.11, 0.1, 0.0999, 0.12, 0.14, 0.16, 0.0];
    const litSeq: boolean[] = [];
    for (const c of sweep) {
      lit = engineLatch(lit, c);
      litSeq.push(lit);
      const F = engineCommandThrust(d, lit, c) / d.maxThrust;
      expect(F === 0 || F >= 0.15).toBe(true);
    }
    expect(litSeq).toEqual([false, false, false, false, false, true, true, true, true, true, false, false, false, true, false]);
    // the engine itself settles at 15% for a 12% command once lit, and is truly 0 after going out
    const th = [0], tm = [0], mm = [0], inp = makeStepIn();
    inp[IN_H] = 5; inp[IN_THROTTLE] = 0.5; engineUpdate(d, th, tm, 0, true, inp, mm);
    inp[IN_H] = Q; inp[IN_THROTTLE] = 0.12;
    for (let i = 0; i < 2000; i++) { engineUpdate(d, th, tm, 0, true, inp, mm); expect(th[0] === 0 || th[0] >= 0.15 * d.maxThrust - 1e-6).toBe(true); }
    expect(th[0] / d.maxThrust).toBeCloseTo(0.15, 9);
    inp[IN_THROTTLE] = 0.09;
    for (let i = 0; i < 2000; i++) engineUpdate(d, th, tm, 0, true, inp, mm);
    expect(th[0]).toBe(0); expect(tm[0]).toBe(ENGINE_UNLIT);
  });

  it('Flight Assist main-drive hysteresis 0.18 / 0.12', () => {
    expect(faMainDrive(false, 0.17, 1)).toBe(false);
    expect(faMainDrive(false, 0.19, 1)).toBe(true);
    expect(faMainDrive(true, 0.13, 1)).toBe(true);
    expect(faMainDrive(true, 0.11, 1)).toBe(false);
  });
});

describe('the rocket equation emerges per pool (minimal fixed-step integrator, h = Q)', () => {
  it('RCS pool with blowdown: η from the geometry by hand, η ≤ 1, Δv = η·vₑ₀·∫(0.97 + 0.03 p/p₀) dm/m within 1e-3', () => {
    const duty = new Float64Array(14), o = makeThrustOut(), cmd = [1, 0, 0, 0, 0, 0];
    // η of the +Fx column, by hand from the jet definitions (independent of applyJets' force and ṁ):
    // η = Σ u_j F_j (−d_j·x̂) / Σ u_j F_j, and ṁ = Σ u_j F_j p / (vₑ₀ (0.97 + 0.03 p))
    let num = 0, den = 0;
    for (let j = 0; j < 14; j++) { const u = T.table[0 * 14 + j], J: JetDef = WREN_JETS[j]; num += u * J.thrust * -J.dir.x; den += u * J.thrust; }
    const etaGeo = num / den;
    const inp = stepIn();
    let rcs = RCS_CAPACITY, m = M0, vx = 0, checked = 0;
    while (rcs > 300) {
      inp[IN_RCS] = rcs;
      jetsStep(T, cmd, true, inp, duty, o);
      const p = rcsBlowdown(rcs);
      const mdotHand = (den * p) / (RCS_VE0 * (0.97 + 0.03 * p));
      expect(o.mdotRcs / mdotHand - 1).toBeLessThan(1e-12); expect(mdotHand / o.mdotRcs - 1).toBeLessThan(1e-12);
      expect(o.fx / (num * p) - 1).toBeLessThan(1e-12); expect((num * p) / o.fx - 1).toBeLessThan(1e-12);
      checked++;
      const dm = o.mdotRcs * Q;
      vx += (o.fx * Q) / (m - dm / 2);
      rcs -= dm; m -= dm;
      expect(Math.hypot(o.tx, o.ty, o.tz)).toBeLessThan(1e-6);
    }
    const m1 = m, N = 20000, hh = (M0 - m1) / N;
    const f = (mm: number) => rcsVeFactor(rcsBlowdown(mm - DRY - MAIN)) / mm;
    let s = f(m1) + f(M0);
    for (let i = 1; i < N; i++) s += (i & 1 ? 4 : 2) * f(m1 + i * hh);
    const dvExp = etaGeo * RCS_VE0 * (s * hh) / 3;
    console.log(`RCS: η (geometry) = ${etaGeo.toFixed(5)}, ${checked} steps; Δv ${vx.toFixed(5)} m/s vs ${dvExp.toFixed(5)} m/s (rel ${(vx / dvExp - 1).toExponential(2)})`);
    expect(etaGeo).toBeLessThanOrEqual(1);
    expect(etaGeo).toBeGreaterThan(0.99);
    expect(Math.abs(vx / dvExp - 1)).toBeLessThan(1e-3);
  });

  it('main pool with the spool from cold: Δv = vₑ·cos(cant)·ln(m₀/m₁) within 1e-3', () => {
    const th = [0, 0], tm = [ENGINE_UNLIT, ENGINE_UNLIT], mean = [0, 0], o = makeThrustOut(), inp = makeStepIn();
    let m = M0, main = MAIN, vz = 0, t = 0;
    while (t < 300) {
      inp[IN_H] = Q; inp[IN_THROTTLE] = t < 200 ? 1 : 0.4;
      engineCutStep(tm, 2, inp);
      const h = inp[IN_H];
      for (let i = 0; i < 2; i++) engineUpdate(ENGINES[i], th, tm, i, main > 0, inp, mean);
      clearThrustOut(o); applyEngines(ENGINES, mean, inp, o);
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
  const at = (x: number, y: number, z: number) => v(1e9 + x, y, z);

  it('is null behind the body and clear in front of it', () => {
    const a = at(-R - 400e3, 0, 0), b = at(R + 400e3, 0, 0);
    expect(lineOfSight(a, b, bodies)).toBe(false);
    const c = at(-R - 400e3, 60e3, 0);
    expect(lineOfSight(a, c, bodies)).toBe(true);
    expect(assistVisible(a, b, 100e3, bodies)).toBe(false);
    expect(assistVisible(a, c, 100e3, bodies)).toBe(true);
    expect(assistVisible(a, at(-R - 400e3, 150e3, 0), 100e3, bodies)).toBe(false); // out of range
  });

  it('the atmosphere top blocks a grazing line, except for a craft flying inside the air', () => {
    const h = R + 60e3;
    expect(lineOfSight(at(-1.2e6, h, 0), at(1.2e6, h, 0), bodies)).toBe(false);
    expect(lineOfSight(at(0, R + 50e3, 0), at(0, R + 400e3, 0), bodies)).toBe(true);
  });
});

describe('air and heat (per forced step)', () => {
  it('u = v − Ω × r and the Sutton–Graves flux at the caller-written density', () => {
    const air = { airVel: v(0, 0, 0), heatFlux: 0, rho: 0.02 };
    airStep(air, v(3.3e6, 0, 0), v(0, 7500, 0), v(0, 0, 7.27e-5));
    expect(air.airVel.y).toBeCloseTo(7500 - 7.27e-5 * 3.3e6, 9);
    expect(air.heatFlux).toBeCloseTo(suttonGraves(0.02, Math.hypot(air.airVel.x, air.airVel.y, air.airVel.z)), 6);
    air.rho = 0; airStep(air, v(1, 0, 0), v(1, 0, 0), v(0, 0, 0));
    expect(air.heatFlux).toBe(0);
  });
});

describe('the applied-force ledger', () => {
  const mk = (): Ledger => ({ fAcc: v(0, 0, 0), tauAcc: v(0, 0, 0), accT: 0, dvImpulse: v(0, 0, 0), dwImpulse: v(0, 0, 0) });
  const ft = (fx: number, fy: number, fz: number, tx: number, ty: number, tz: number) => ({ fx, fy, fz, tx, ty, tz });

  it('accumulates step means and consumes them as the time-weighted mean, then zeroes', () => {
    const L = mk(), out = makeLedgerMean(), inp = makeStepIn();
    inp[IN_H] = Q; ledgerAdd(L, ft(100, 0, -50, 1, 2, 3), inp);
    inp[IN_H] = 3 * Q; ledgerAdd(L, ft(300, 0, -50, 3, 2, 1), inp);
    consumeLedgerInto(L, out);
    expect(out.T).toBeCloseTo(4 * Q, 15);
    expect(out.f.x).toBeCloseTo(250, 9); expect(out.f.z).toBeCloseTo(-50, 9);
    expect(out.tau.x).toBeCloseTo(2.5, 12); expect(out.tau.z).toBeCloseTo(1.5, 12);
    expect(L.accT).toBe(0); expect(L.fAcc.x).toBe(0);
    consumeLedgerInto(L, out);
    expect(out.f.x).toBe(0); expect(out.T).toBe(0);
    const k = rk4MeanV(v(0, 0, 0), v(1, 0, 0), v(2, 0, 0), v(3, 0, 0), v(4, 0, 0));
    expect(k.x).toBe(2.5);
  });

  it('rotates inertial forces into craft axes; impulses give J/m and I⁻¹(r × J)', () => {
    const L = mk(), out = makeLedgerMean(), inp = makeStepIn();
    const s = Math.SQRT1_2;
    inp[IN_H] = 1;
    ledgerAddInertialForce(L, { x: 0, y: s, z: 0, w: s }, v(10, 0, 0), inp); // yawed +90°: inertial +X is craft +Z
    ledgerAdd(L, ft(0, 0, 0, 0, 0, 0), inp);
    inp[IN_M] = 50; inp[IN_IX] = 1; inp[IN_IY] = 2; inp[IN_IZ] = 4;
    ledgerImpulse(L, v(0, 100, 0), v(2, 0, 0), inp);
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
  const inp = makeStepIn(), auth = v(0, 0, 0), hold = v(0, 0, 0);
  function step(s: Sim, k: number): void {
    const m = DRY + s.main + s.rcsPropellant;
    inp[IN_H] = Q; inp[IN_RCS] = s.rcsPropellant; inp[IN_WX] = s.w.x; inp[IN_WY] = s.w.y; inp[IN_WZ] = s.w.z;
    inp[IN_CX] = 0; inp[IN_THROTTLE] = (k % 300) / 300; inp[IN_M] = m;
    // the hold law is fed FRESH authority from the current pool every tick (D2): a toy rate damper
    torqueAuthority(T, inp, auth);
    hold.x = Math.max(-1, Math.min(1, (-m * GYR.x * 4 * s.w.x) / auth.x + 0.4 * Math.cos(k * 0.031)));
    hold.y = Math.max(-1, Math.min(1, (-m * GYR.y * 4 * s.w.y) / auth.y));
    hold.z = k % 97 < 40 ? -0.7 : Math.max(-1, Math.min(1, (-m * GYR.z * 4 * s.w.z) / auth.z));
    cmd[0] = Math.sin(k * 0.05);
    holdCmdToJets(T, hold, cmd);
    engineCutStep(s.engineTimer, 2, inp);
    const h = inp[IN_H];
    jetsStep(T, cmd, true, inp, duty, o);
    for (let i = 0; i < 2; i++) engineUpdate(ENGINES[i], s.engineThrust, s.engineTimer, i, s.main > 0, inp, mean);
    applyEngines(ENGINES, mean, inp, o);
    s.v.x += (o.fx / m) * h; s.v.y += (o.fy / m) * h; s.v.z += (o.fz / m) * h;
    s.w.x += (o.tx / (m * GYR.x)) * h; s.w.y += (o.ty / (m * GYR.y)) * h; s.w.z += (o.tz / (m * GYR.z)) * h;
    s.rcsPropellant -= o.mdotRcs * h; s.main -= o.mdotMain * h;
    ledgerAdd(s, o, inp);
    for (let j = 0; j < 14; j++) s.jetDuty[j] = duty[j];
    if (k % 7 === 0) { consumeLedgerInto(s, lm); s.rcs += lm.f.x; }
    if (k === 120) s.holdWakeT = 1234.5678;
    if (k === 200) s.holdWakeT = Infinity;
  }
  it('mid-burn, mid-ignition, mid-tail, with a pending ledger and a pool that has drained', () => {
    const a = mkSim();
    a.rcsPropellant = 700; // the authority now differs from the full-pool value by a factor 0.6
    for (let k = 0; k < 250; k++) step(a, k);
    expect(a.engineTimer.some((t) => t > 0) || a.engineThrust[0] > 0).toBe(true);
    const json = JSON.stringify({ jets: saveJetState(a), v: a.v, w: a.w, rcs: a.rcs, main: a.main });
    const raw = JSON.parse(json);
    const b: Sim = { ...loadJetState(raw.jets, 14, 2), v: raw.v, w: raw.w, rcs: raw.rcs, main: raw.main };
    for (let k = 250; k < 1200; k++) { step(a, k); step(b, k); }
    const flat = (s: Sim) => [...s.jetDuty, ...s.engineThrust, ...s.engineTimer, s.rcsPropellant, s.fAcc.x, s.fAcc.y, s.fAcc.z, s.tauAcc.x, s.tauAcc.z, s.accT, s.v.x, s.v.y, s.v.z, s.w.x, s.w.y, s.w.z, s.rcs, s.main, s.holdWakeT];
    const fa = flat(a), fb = flat(b);
    for (let i = 0; i < fa.length; i++) expect(Object.is(fa[i], fb[i])).toBe(true);
    console.log(`save/load: pool ${a.rcsPropellant.toFixed(3)} kg after 1200 steps, both runs identical`);
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
  it('per-step paths allocate nothing and cost well under a microsecond (see the plain-node bundle check too)', async () => {
    const duty = new Float64Array(14), o = makeThrustOut(), cmd = new Float64Array([0.3, -0.2, 0.5, 0.4, -0.6, 0.2]);
    const th = [2e5, 2e5], tm = [0, 0], mean = [0, 0];
    const N = 1_000_000;
    const sink = new Float64Array(1);
    const inp = stepIn(900, v(0.01, 0, 0));
    const jetsLoop = () => { for (let i = 0; i < N; i++) { cmd[0] = (i & 7) * 0.1; inp[IN_RCS] = 900 - i * 1e-4; inp[IN_WX] = 0.01 + i * 1e-9; jetsStep(T, cmd, true, inp, duty, o); sink[0] += o.mdotRcs; } };
    const engLoop = () => {
      for (let i = 0; i < N; i++) {
        inp[IN_THROTTLE] = (i & 1023) < 512 ? 1 : 0.5 + i * 1e-9; inp[IN_H] = Q;
        for (let e = 0; e < 2; e++) engineUpdate(ENGINES[e], th, tm, e, true, inp, mean);
        clearThrustOut(o); applyEngines(ENGINES, mean, inp, o); sink[0] += o.fz;
      }
    };
    jetsLoop(); engLoop();
    let t0 = performance.now(); jetsLoop(); const tj = ((performance.now() - t0) / N) * 1e3;
    t0 = performance.now(); engLoop(); const te = ((performance.now() - t0) / N) * 1e3;
    t0 = performance.now();
    for (let i = 0; i < 100; i++) buildJetTable(WREN_JETS, ZERO);
    const tb = (performance.now() - t0) / 100;
    console.log(`node (vitest): jetsStep ${tj.toFixed(3)} µs, 2 × engineUpdate + applyEngines ${te.toFixed(3)} µs, buildJetTable ${tb.toFixed(3)} ms (sink ${sink[0] > 0 ? '+' : '-'})`);
    expect(tj).toBeLessThan(2);
    expect(te).toBeLessThan(2);
    expect(await gcCount(jetsLoop)).toBe(0);
    expect(await gcCount(engLoop)).toBe(0);
  });
});
