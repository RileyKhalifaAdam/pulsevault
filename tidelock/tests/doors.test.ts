// W3-B doors and the dorsal hatch (src/world/doors.ts): pressure load holds a door shut, travel time, auto-close on a
// pressure drop, the crank, the hatch's 0.2 kPa limit and blow-open, and rest is exact (a still door costs nothing).
import { describe, expect, it } from 'vitest';
import { buildWrenCompartments, CREW_PULL_MAX, DOOR_CAM_MA, DOOR_F_MOTOR, DOOR_SEAL_F, HAND_F_MAX, HATCH_ARM } from '../src/data/compartments';
import {
  compileMech, D_CMD, D_FIRED, D_S, D_X, DOOR_STRIDE, doorLeafBox, doorsAdvance, H_DOGCMD, H_DOGS, H_TH, loadMech, makeMechInputs,
  makeMechOut, makeMechState, pressDoor, saveMech,
} from '../src/world/doors';

const comp = buildWrenCompartments();
const mn = compileMech(comp.doors, comp.hatch);
const nR = comp.idx.nRooms;
const open = new Float64Array(comp.def.orifices.length);
const TICK = 1 / 120;

function shut() {
  const st = makeMechState(mn);
  for (let k = 0; k < mn.nD; k++) { const o = k * DOOR_STRIDE; st.door[o + D_S] = 0; st.door[o + D_X] = 0; st.door[o + D_CMD] = 0; }
  return st;
}
const P = (base = 101325): Float64Array => new Float64Array(nR).fill(base);

describe('sliding pressure doors', () => {
  it('a door cannot open against 1 kPa with its 300 N motor; it opens at 100 Pa in ≈ 1.6 s', () => {
    const k = 0, d = comp.doors[k];
    expect(d.A).toBeCloseTo(2.1, 9);
    expect(d.mass).toBeCloseTo(40, 9);
    const limit = (DOOR_F_MOTOR * DOOR_CAM_MA - DOOR_SEAL_F) / d.A;
    expect(limit).toBeLessThan(200);
    const inp = makeMechInputs(mn), out = makeMechOut(mn), dep = new Float64Array(nR);
    // 1 kPa
    let st = shut(), p = P();
    p[d.b] -= 1000;
    pressDoor(st, k, 1);
    for (let t = 0; t < 10 * 120; t++) doorsAdvance(mn, st, p, dep, inp, out, TICK, open);
    expect(st.door[k * DOOR_STRIDE + D_S]).toBe(0);
    expect(open[d.orifice]).toBe(0);
    expect(out.busy).toBe(true); // stalled, straining (the motor hums)
    // 100 Pa
    st = shut(); p = P(); p[d.b] -= 100;
    pressDoor(st, k, 1);
    let tOpen = -1;
    for (let t = 0; t < 10 * 120 && tOpen < 0; t++) {
      doorsAdvance(mn, st, p, dep, inp, out, TICK, open);
      if (st.door[k * DOOR_STRIDE + D_X] >= d.W && !out.busy) tOpen = (t + 1) * TICK;
    }
    console.log(`door ${d.id}: unseat limit ${limit.toFixed(0)} Pa; opens at 100 Pa in ${tOpen.toFixed(3)} s (W ${d.W} m, ${d.mass.toFixed(0)} kg)`);
    expect(tOpen).toBeGreaterThan(1.1); expect(tOpen).toBeLessThan(1.8);
    expect(open[d.orifice]).toBe(1);
    // close: comes back to seated
    pressDoor(st, k, -1);
    for (let t = 0; t < 3 * 120; t++) doorsAdvance(mn, st, p, dep, inp, out, TICK, open);
    expect(st.door[k * DOOR_STRIDE + D_S]).toBe(0);
    expect(open[d.orifice]).toBe(0);
    expect(out.busy).toBe(false);
  });

  it('auto-close on a 0.5 kPa/s pressure drop, against the flow; the slam is booked; latched until a button', () => {
    const k = 2, d = comp.doors[k];
    const st = makeMechState(mn), inp = makeMechInputs(mn), out = makeMechOut(mn);
    const p = P(), dep = new Float64Array(nR);
    p[d.a] = 60e3; p[d.b] = 20e3; // a breach transient: 40 kPa across the (open) doorway
    dep[d.b] = -400;
    doorsAdvance(mn, st, p, dep, inp, out, TICK, open);
    expect(st.door[k * DOOR_STRIDE + D_FIRED]).toBe(0);
    dep[d.b] = -600;
    let slam = 0, tSeat = -1;
    for (let t = 0; t < 4 * 120; t++) {
      doorsAdvance(mn, st, p, dep, inp, out, TICK, open);
      slam += out.slamJ[k];
      if (tSeat < 0 && st.door[k * DOOR_STRIDE + D_S] === 0) tSeat = (t + 1) * TICK;
    }
    console.log(`auto-close across 40 kPa: seated after ${tSeat.toFixed(3)} s, slam ${slam.toFixed(2)} J`);
    expect(st.door[k * DOOR_STRIDE + D_FIRED]).toBe(1);
    expect(tSeat).toBeGreaterThan(0); expect(tSeat).toBeLessThan(2);
    // and now it refuses to open toward the low side
    pressDoor(st, k, 1);
    dep.fill(0);
    for (let t = 0; t < 2 * 120; t++) doorsAdvance(mn, st, p, dep, inp, out, TICK, open);
    expect(open[d.orifice]).toBe(0);
  });

  it('the manual crank unseats against 1 kPa (150 N × 20), and the crack equalises through the gap', () => {
    const k = 0, d = comp.doors[k];
    const st = shut(), inp = makeMechInputs(mn), out = makeMechOut(mn), dep = new Float64Array(nR);
    const p = P(); p[d.b] -= 1000;
    inp.crank[k] = 1000; // clamped to the hand's 150 N
    for (let t = 0; t < 120; t++) doorsAdvance(mn, st, p, dep, inp, out, TICK, open);
    expect(HAND_F_MAX).toBe(150);
    expect(st.door[k * DOOR_STRIDE + D_S]).toBeGreaterThan(0);
    expect(open[d.orifice]).toBeGreaterThan(0);
  });

  it('a resting door takes no sub-steps; the leaf box slides into its pocket; save → load is exact', () => {
    const st = makeMechState(mn), inp = makeMechInputs(mn), out = makeMechOut(mn), dep = new Float64Array(nR), p = P();
    doorsAdvance(mn, st, p, dep, inp, out, 2048 / 120, open);
    expect(out.busy).toBe(false);
    const b = new Float64Array(6);
    doorLeafBox(mn, st, 0, b);
    expect(b[0]).toBeCloseTo(comp.doors[0].box.min.x + comp.doors[0].W, 12);
    pressDoor(st, 3, -1);
    for (let t = 0; t < 30; t++) doorsAdvance(mn, st, p, dep, inp, out, TICK, open);
    const s2 = loadMech(mn, JSON.parse(JSON.stringify(saveMech(st))));
    for (let t = 0; t < 60; t++) { doorsAdvance(mn, st, p, dep, inp, out, TICK, open); doorsAdvance(mn, s2, p, dep, inp, out, TICK, open); }
    expect(Array.from(s2.door)).toEqual(Array.from(st.door));
  });
});

describe('the dorsal hatch', () => {
  const corridor = comp.hatch.room, tunnel = comp.hatch.tunnel;
  const run = (dp: number, pull: number, T = 6) => {
    const st = makeMechState(mn), inp = makeMechInputs(mn), out = makeMechOut(mn), dep = new Float64Array(nR);
    const p = P(); p[tunnel] = p[corridor] - dp;
    st.hatch[H_DOGCMD] = 1;
    inp.pull = pull;
    for (let t = 0; t < T * 120; t++) doorsAdvance(mn, st, p, dep, inp, out, TICK, open);
    return st;
  };
  it('a 100 N pull at 0.4 m opens it only below Δp ≈ 200 Pa (after the 3 s dogs)', () => {
    const pull = CREW_PULL_MAX * HATCH_ARM;
    const lim = pull / (comp.hatch.A * comp.hatch.D / 2);
    console.log(`hatch: A ${comp.hatch.A.toFixed(3)} m², pull ${pull} N·m → opens below ${lim.toFixed(0)} Pa`);
    expect(lim).toBeGreaterThan(180); expect(lim).toBeLessThan(220);
    const a = run(250, pull);
    expect(a.hatch[H_DOGS]).toBe(1);
    expect(a.hatch[H_TH]).toBe(0);
    const b = run(150, pull);
    expect(b.hatch[H_TH]).toBeGreaterThan(1);
    // dogs still in: nothing moves, whatever the pull
    const st = makeMechState(mn), inp = makeMechInputs(mn), out = makeMechOut(mn);
    inp.pull = pull;
    for (let t = 0; t < 120; t++) doorsAdvance(mn, st, P(), new Float64Array(nR), inp, out, TICK, open);
    expect(st.hatch[H_TH]).toBe(0);
  });
  it('with the tunnel at higher pressure the hatch blows open once the dogs are out', () => {
    const s = run(-2000, 0);
    expect(s.hatch[H_TH]).toBeGreaterThan(0.5);
    expect(open[comp.hatch.orifice]).toBe(1);
  });
});
