// W3-B compartments as a whole (src/world/compartments.ts): mass conservation with vents, determinism, save → load →
// step bit-identical mid-breach, warp honesty (limitedBy 'venting' only while a transient needs it), and cost.
import { describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { buildWrenCompartments } from '../src/data/compartments';
import { DAMAGE_COMPONENTS } from '../src/data/hullZones';
import { compileCabin, inventory, loadCabin, makeCabinIo, newCabin, saveCabin } from '../src/world/cabin';
import {
  compartmentsGas, compartmentsQuantum, compartmentsTick, compileCompartments, initTunnel, loadCompartments, makeCompIo, makeCompartments,
  migrateCabinRooms, saveCompartments, ventingLimit, ventingMaxStep,
} from '../src/world/compartments';
import { makeDamageState, windowState } from '../src/world/damage';
import { pressDoor } from '../src/world/doors';
import { MOLAR_MASS, ROOM_STRIDE } from '../src/world/life';
import { ventConsume } from '../src/world/vent';

const TH = new Float64Array(40).fill(294);
const RT0 = 24;
const QS = 2048 / 120;
const W_LOUNGE = DAMAGE_COMPONENTS.findIndex((c) => c.id === 'w-lounge');
const W_CABIN = DAMAGE_COMPONENTS.findIndex((c) => c.id === 'w-cabin-port');

function setup() {
  const comp = buildWrenCompartments();
  const net = compileCabin(comp.def);
  const cn = compileCompartments(comp, net);
  const st = newCabin(net);
  initTunnel(cn, st);
  const io = makeCabinIo(net);
  io.metab[0] = 120; io.metab[4] = 80;
  const cs = makeCompartments(cn), cio = makeCompIo(cn);
  const dmg = makeDamageState();
  cio.inp.damage = dmg;
  return { comp, net, cn, st, io, cs, cio, dmg };
}
type S = ReturnType<typeof setup>;
function ticks(s: S, n: number, t0: number, acc?: Float64Array): void {
  const J = new Float64Array(7);
  for (let k = 0; k < n; k++) {
    if (!compartmentsTick(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, RT0) && (t0 + k) % 12 === 0) compartmentsGas(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, RT0, 0.1);
    ventConsume(s.cs.vent, J);
    if (acc) for (let i = 0; i < 7; i++) acc[i] += J[i];
  }
}
function kg(s: S): number {
  const o = new Float64Array(4);
  inventory(s.net, s.st, o);
  return o[0] * MOLAR_MASS[0] + o[1] * MOLAR_MASS[1] + o[2] * MOLAR_MASS[2] + o[3] * MOLAR_MASS[3];
}

describe('compartments', () => {
  it('mass: gas + O₂ tank + films + condensate + vented is conserved through a breach (regulator, CHX, panes on)', () => {
    const s = setup();
    s.io.metab.fill(0); s.io.inp[3] = 0; // no crew (food carbon) and no scrubber (CO₂ overboard): every other exit is a vent
    ticks(s, 120, 0);
    const m0 = kg(s);
    s.dmg.zones[W_LOUNGE] = 0;
    const acc = new Float64Array(7);
    ticks(s, 120 * 10, 120, acc);
    const err = Math.abs(m0 - kg(s) - acc[6]) / m0;
    console.log(`breach: mass book (gas + tank + water + vented) closes to ${err.toExponential(1)}; vented ${acc[6].toFixed(1)} kg`);
    expect(err).toBeLessThan(1e-12);
  });

  it('determinism and save → JSON → load → step bit-identical in the middle of a breach (VENTING) and of an airlock cycle', () => {
    const run = (breakAt: number, saveAt: number) => {
      const s = setup();
      s.cs.airlock[1] = 1;
      ticks(s, breakAt, 0);
      s.dmg.zones[W_CABIN] = 0;
      ticks(s, saveAt - breakAt, breakAt);
      return s;
    };
    const a = run(60, 75), b = run(60, 75);
    expect(a.cs.venting).toBe(1);
    // reload b from JSON (damage state is W2-C's, cabin is cabin.ts's)
    const blob = JSON.parse(JSON.stringify({ cabin: saveCabin(b.st), comp: saveCompartments(b.cs), zones: b.dmg.zones }));
    const c = setup();
    const st2 = loadCabin(c.net, blob.cabin.cabin, blob.cabin.life);
    c.st.rooms.set(st2.rooms); c.st.fog.set(st2.fog); c.st.draftQ.set(st2.draftQ); c.st.draftEpoch = st2.draftEpoch; c.st.o2Tank = st2.o2Tank; c.st.condensate = st2.condensate;
    c.cs = loadCompartments(c.cn, c.net, blob.comp);
    c.dmg.zones = blob.zones;
    c.cio.inp.damage = c.dmg;
    // nothing else is carried over: the cabin io is rewritten by every call (open fractions, pump) and the pressures /
    // rates the mechanisms read between gas steps are saved in the compartments state
    ticks(a, 240, 75); ticks(b, 240, 75); ticks(c, 240, 75);
    expect(Array.from(b.st.rooms)).toEqual(Array.from(a.st.rooms));
    expect(Array.from(c.st.rooms)).toEqual(Array.from(a.st.rooms));
    expect(Array.from(c.cs.mech.door)).toEqual(Array.from(a.cs.mech.door));
    expect(Array.from(c.cs.vent.pub)).toEqual(Array.from(a.cs.vent.pub));
    expect(c.cs.airlock[0]).toBe(a.cs.airlock[0]);
    expect(windowState(c.dmg, W_CABIN)).toBe(2);
  });

  it('warp honesty: a still ship never limits; a breach limits (`venting`) only while it needs to; the crack never', () => {
    const s = setup();
    ticks(s, 240, 0);
    expect(ventingLimit(s.cs, QS)).toBe('');
    expect(ventingMaxStep(s.cs)).toBeGreaterThan(1e3);
    // a sleeping ship takes 17 s quanta; a window cracks (1 cm²): still free
    s.dmg.zones[W_LOUNGE] = 1 - 10e3 / 30e3;
    for (let q = 0; q < 20; q++) compartmentsQuantum(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, RT0, QS);
    expect(ventingLimit(s.cs, QS)).toBe('');
    // a window goes inside a sleep quantum (a collision under warp): that quantum resolves itself in Q/2 sub-steps
    const t = setup();
    ticks(t, 240, 0);
    t.dmg.zones[W_LOUNGE] = 0;
    compartmentsQuantum(t.cn, t.cs, t.net, t.st, t.io, t.cio, TH, RT0, QS);
    expect(t.io.p[2]).toBeLessThan(200);
    // at 1×: the warp is limited ('venting') from the break until the transient is over
    s.dmg.zones[W_LOUNGE] = 0;
    ticks(s, 1, 0);
    expect(ventingLimit(s.cs, QS)).toBe('venting');
    let limited = 0, free = -1;
    for (let k = 0; k < 120 * 60; k++) {
      const why = ventingLimit(s.cs, QS);
      if (why === 'venting') limited++; else if (free < 0) free = k / 120;
      if (why === '') break;
      ticks(s, 1, k);
    }
    console.log(`after the break: warp limited for ${(limited / 120).toFixed(2)} s of sim time, then free (max gas step ${ventingMaxStep(s.cs).toFixed(0)} s)`);
    expect(free).toBeGreaterThan(0.5);
    expect(free).toBeLessThan(30);
  });

  it('migrates a wave-2 (10-room) cabin save: rooms kept, a vacuum tunnel added', () => {
    const s = setup();
    const old = Array.from(s.st.rooms.slice(0, 10 * ROOM_STRIDE));
    const st = newCabin(s.net);
    expect(migrateCabinRooms(s.cn, old, st)).toBe(true);
    expect(st.rooms[10 * ROOM_STRIDE]).toBeLessThan(1e-3);
    expect(migrateCabinRooms(s.cn, [1, 2, 3], st)).toBe(false);
    void pressDoor; void kg;
  });
});

describe('cost', () => {
  it('µs per call (node, warmed, esbuild bundle): VENTING tick, quiet tick, 10 Hz gas call, sleep quantum', () => {
    const code = `
      import { buildWrenCompartments } from './src/data/compartments';
      import { buildCabinNet } from './src/data/cabinNet';
      import { INTERIORS } from './src/data/interiors';
      import { compileCabin, makeCabinIo, newCabin, stepCabin } from './src/world/cabin';
      import { compartmentsGas, compartmentsQuantum, compartmentsTick, compileCompartments, initTunnel, makeCompIo, makeCompartments } from './src/world/compartments';
      import { makeDamageState } from './src/world/damage';
      import { DAMAGE_COMPONENTS } from './src/data/hullZones';
      import { coreAdvance, makeCore } from './src/world/reactor';
      import { cryoStep, makeCryoInputs, makeCryoOut, makeCryoState } from './src/world/cryo';
      import { makeVentState } from './src/world/vent';
      const TH = new Float64Array(40).fill(294);
      function mk() {
        const comp = buildWrenCompartments(); const net = compileCabin(comp.def); const cn = compileCompartments(comp, net);
        const st = newCabin(net); initTunnel(cn, st); const io = makeCabinIo(net); io.metab[0] = 120;
        const cs = makeCompartments(cn), cio = makeCompIo(cn); const d = makeDamageState(); cio.inp.damage = d;
        return { comp, net, cn, st, io, cs, cio, d };
      }
      function best(f, N) { let b = 1e9; for (let r = 0; r < 6; r++) { const t0 = performance.now(); for (let n = 0; n < N; n++) f(n); b = Math.min(b, (performance.now() - t0) / N * 1000); } return b; }
      export function run() {
        const r = {};
        // venting tick: a 1 cm² crack keeps the transient slow; force VENTING so every tick is a 2-sub-step tick
        { const s = mk(); s.d.zones[DAMAGE_COMPONENTS.findIndex(c => c.id === 'w-lounge')] = 0;
          for (let n = 0; n < 2000; n++) { s.cs.venting = 1; compartmentsTick(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, 24); }
          r.vent = best(() => { s.cs.venting = 1; compartmentsTick(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, 24); }, 4000); }
        { const s = mk(); for (let n = 0; n < 2000; n++) compartmentsTick(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, 24);
          r.quietTick = best(() => compartmentsTick(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, 24), 20000);
          for (let n = 0; n < 2000; n++) compartmentsGas(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, 24, 0.1);
          r.gas = best(() => compartmentsGas(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, 24, 0.1), 10000);
          for (let n = 0; n < 500; n++) compartmentsQuantum(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, 24, 2048 / 120);
          r.quantum = best(() => compartmentsQuantum(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, 24, 2048 / 120), 5000);
          r.span = best(() => compartmentsQuantum(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, 24, 7 * 2048 / 120), 1000); }
        { const net = compileCabin(buildCabinNet(INTERIORS.wren)), st = newCabin(net), io = makeCabinIo(net); io.inp[0] = 0.1;
          for (let n = 0; n < 5000; n++) stepCabin(net, st, io); r.w2cabin = best(() => stepCabin(net, st, io), 10000); }
        { const s = mk(); s.io.inp[0] = 0.1; for (let n = 0; n < 5000; n++) stepCabin(s.net, s.st, s.io); r.w3cabin = best(() => stepCabin(s.net, s.st, s.io), 10000); }
        { const c = makeCore(1e6), R = new Float64Array(2); r.core = best((n) => coreAdvance(c, n & 1 ? 1e7 : 2e6, 0, 0.1, R), 20000); }
        { const cs = makeCryoState(), i = makeCryoInputs(), o = makeCryoOut(), v = makeVentState(); i.coolerOn = 0; r.cryo = best(() => cryoStep(cs, i, o, v, 0.1), 20000); }
        return r;
      }`;
    const out = esbuild.buildSync({ stdin: { contents: code, resolveDir: (globalThis as unknown as { process: { cwd(): string } }).process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'iife', globalName: 'B', platform: 'node' });
    const B = new Function(`${out.outputFiles[0].text}; return B;`)() as { run(): Record<string, number> };
    const r = B.run();
    const f = (x: number) => x.toFixed(2);
    console.log(`cost (node, µs): VENTING tick ${f(r.vent)} (2 gas sub-steps + doors + vents) · quiet tick ${f(r.quietTick)} · 10 Hz gas call ${f(r.gas)} (stepCabin on the W3 net ${f(r.w3cabin)}, W2 net ${f(r.w2cabin)}) · 17 s quantum ${f(r.quantum)} · core ${f(r.core)} · cryo ${f(r.cryo)}`);
    console.log(`per frame @60 fps (2 ticks): normal ${f(2 * r.quietTick + r.gas / 6)} µs; VENTING ${f(2 * r.vent)} µs (A16 ≈ 2×: ${f(4 * r.vent)} µs vs the plan's +40 µs breach row); sleep 1e4: ${(1e4 / 60 / QS).toFixed(2)} quanta × ${f(r.quantum)} = ${f(1e4 / 60 / QS * r.quantum)} µs per frame, or at the systems span (7 quanta = 119.5 s, 6 implicit steps) ${f(r.span)} µs per call = ${f(1e4 / 60 / QS / 7 * r.span)} µs per frame`);
    expect(r.vent).toBeLessThan(30);
    expect(r.quietTick).toBeLessThan(2);
    expect(r.gas).toBeLessThan(20);
  });
});
