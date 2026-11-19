// W3-B breach and vents (src/world/breach.ts, vent.ts, compartments.ts): the blowdown against its closed forms
// (isothermal crack, adiabatic window), the vent impulse against the momentum of the vented gas, hole areas from
// impact energy, the Wren's lounge window, and the flow field's force on a body.
import { describe, expect, it } from 'vitest';
import { buildWrenCompartments, CRACK_A, HOLE_PHI, PERF_FOOTPRINT } from '../src/data/compartments';
import { CD_HOLE } from '../src/data/cabinNet';
import { DAMAGE_COMPONENTS, HULL_ZONES, WINDOW_CRACK, WINDOW_BREAK, Z_DORSAL_FWD, Z_FLANK_STBD, Z_WING_PORT } from '../src/data/hullZones';
import { C_STAR, compileCabin, inventory, makeCabinIo, newCabin, type CabinNet, type CabinState } from '../src/world/cabin';
import { breachHit, holeAreaFromEnergy, HOLE_STRIDE, ventBodyForce } from '../src/world/breach';
import {
  compartmentsGas, compartmentsSubsteps, compartmentsTick, compileCompartments, initTunnel, makeCompIo, makeCompartments,
  ventingLimit, ventingMaxStep, type CompNet, type CompState,
} from '../src/world/compartments';
import { makeDamageState } from '../src/world/damage';
import { D_CMD, D_S, D_X, DOOR_STRIDE } from '../src/world/doors';
import { GAMMA, MOLAR_MASS, R_GAS, ROOM_STRIDE } from '../src/world/life';
import { sonicVentVelocity, VENT_RSTAR, ventConsume, ventExitVelocity } from '../src/world/vent';

const T0 = 294;
const TH = new Float64Array(40).fill(T0); // thermal nodes; rooms at N_ROOM0 = 24
const RT0 = 24;

function setup() {
  const comp = buildWrenCompartments();
  const net = compileCabin(comp.def);
  const cn = compileCompartments(comp, net);
  const st = newCabin(net);
  initTunnel(cn, st);
  const io = makeCabinIo(net);
  io.metab.fill(0); io.inp[3] = 0; io.inp[4] = 0; io.inp[5] = 0; // no crew, scrubber, CHX, regulator
  const cs = makeCompartments(cn);
  const cio = makeCompIo(cn);
  const dmg = makeDamageState();
  cio.inp.damage = dmg;
  for (let k = 0; k < 5; k++) compartmentsGas(cn, cs, net, st, io, cio, TH, RT0, 0.1);
  return { comp, net, cn, st, io, cs, cio, dmg };
}
const roomOf = (id: string): number => buildWrenCompartments().def.rooms.findIndex((r) => r.id === id);
const LOUNGE = roomOf('lounge');
const W_LOUNGE = DAMAGE_COMPONENTS.findIndex((c) => c.id === 'w-lounge');

function massOf(net: CabinNet, st: CabinState): number {
  const o = new Float64Array(4);
  inventory(net, st, o);
  return o[0] * MOLAR_MASS[0] + o[1] * MOLAR_MASS[1] + o[2] * MOLAR_MASS[2] + o[3] * MOLAR_MASS[3];
}
function roomMass(st: CabinState, i: number): number {
  const b = i * ROOM_STRIDE;
  return st.rooms[b] * MOLAR_MASS[0] + st.rooms[b + 1] * MOLAR_MASS[1] + st.rooms[b + 2] * MOLAR_MASS[2] + st.rooms[b + 3] * MOLAR_MASS[3];
}
function roomM(st: CabinState, i: number): number {
  const b = i * ROOM_STRIDE, N = st.rooms[b] + st.rooms[b + 1] + st.rooms[b + 2] + st.rooms[b + 3];
  return roomMass(st, i) / N;
}
/** Seal the lounge: both its doors shut and seated, auto-close disarmed. */
function sealLounge(cn: CompNet, cs: CompState): void {
  cn.comp.doors.forEach((d, k) => {
    if (d.a !== LOUNGE && d.b !== LOUNGE) return;
    const o = k * DOOR_STRIDE;
    cs.mech.door[o + D_S] = 0; cs.mech.door[o + D_X] = 0; cs.mech.door[o + D_CMD] = -1;
  });
}

describe('exit velocity and thrust', () => {
  it('sonic orifice to vacuum: u_eff = u*(γ+1)/γ, thrust coefficient (γ+1)·r* = 1.268', () => {
    const M = 0.02897, T = 293;
    const us = Math.sqrt(GAMMA * R_GAS * T * 2 / ((GAMMA + 1) * M));
    expect(us).toBeCloseTo(313.2, 0); // the plan's u* = 313 m/s
    expect(ventExitVelocity(0, T, M)).toBeCloseTo(us * (GAMMA + 1) / GAMMA, 9);
    // F = ṁ·u_eff = C_d·A·p0·√(γM/(RT))·C*·u_eff  →  F/(C_d·A·p0) = (γ+1)·r*
    const cf = Math.sqrt(GAMMA * M / (R_GAS * T)) * C_STAR * ventExitVelocity(0, T, M);
    expect(cf).toBeCloseTo((GAMMA + 1) * VENT_RSTAR, 9);
    expect(cf).toBeCloseTo(1.268, 3);
    // choked mass flux at 101 kPa, 293 K: 239 kg/s/m² (× C_d)
    expect(101325 * Math.sqrt(GAMMA * M / (R_GAS * T)) * C_STAR).toBeCloseTo(239, 0);
    // continuous across r*: the subsonic formula meets the choked one
    expect(ventExitVelocity(VENT_RSTAR + 1e-9, T, M)).toBeCloseTo(ventExitVelocity(VENT_RSTAR, T, M), 0);
    expect(ventExitVelocity(1, T, M)).toBe(0);
    expect(sonicVentVelocity(1.6, 2.016e-3, 23.3)).toBeGreaterThan(500);
  });
});

describe('blowdown', () => {
  it('a cracked lounge window (1 cm²), lounge sealed: isothermal e^(−t/τ) at 10 Hz for an hour; impulse = Δm·u_eff', () => {
    const s = setup();
    sealLounge(s.cn, s.cs);
    compartmentsTick(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, RT0);
    s.dmg.zones[W_LOUNGE] = 1 - WINDOW_CRACK / WINDOW_BREAK; // cracked
    const V = s.net.V[LOUNGE], M = roomM(s.st, LOUNGE);
    const tau = V / (CD_HOLE * CRACK_A * C_STAR * Math.sqrt(GAMMA * R_GAS * T0 / M));
    const p0 = s.io.p[LOUNGE], m0 = roomMass(s.st, LOUNGE);
    const J = new Float64Array(7);
    ventConsume(s.cs.vent, J);
    const acc = new Float64Array(7);
    const N = 36000;
    for (let n = 0; n < N; n++) {
      compartmentsGas(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, RT0, 0.1);
      ventConsume(s.cs.vent, J);
      for (let k = 0; k < 7; k++) acc[k] += J[k];
    }
    const t = N * 0.1;
    const rel = s.io.p[LOUNGE] / (p0 * Math.exp(-t / tau)) - 1;
    console.log(`crack: τ = ${(tau / 3600).toFixed(2)} h (lounge ${V.toFixed(1)} m³); p(1 h) ${(s.io.p[LOUNGE] / 1000).toFixed(3)} kPa, closed form error ${rel.toExponential(2)}`);
    expect(Math.abs(rel)).toBeLessThan(2e-3);
    expect(s.cs.venting).toBe(0);
    expect(ventingMaxStep(s.cs)).toBeGreaterThan(2048 / 120); // sleep warp untouched by a crack
    const dm = m0 - roomMass(s.st, LOUNGE);
    expect(acc[6] / dm - 1).toBeLessThan(1e-9); // booked mass = mass the room lost
    const u = ventExitVelocity(0, T0, M);
    const Jmag = Math.hypot(acc[0], acc[1], acc[2]);
    expect(Jmag / (dm * u) - 1).toBeLessThan(2e-3);
    expect(acc[0]).toBeLessThan(0); // the window faces +x: the ship is pushed −x
    // the whole Wren through 1 cm² (all doors open): τ = 315.7 m³ … (the plan's 7.4 h is 370 m³)
    const tauShip = 315.70 * tau / V;
    expect(tauShip / 3600).toBeGreaterThan(6); expect(tauShip / 3600).toBeLessThan(6.6);
  });

  it('the lounge window breaks, lounge sealed: the adiabatic closed form; impulse = 2/(γ+1)·m0·u_eff0; first-order in h', () => {
    const run = (sub: number) => {
      const s = setup();
      s.cn.wallH = 0; // adiabatic: the closed form has no walls
      sealLounge(s.cn, s.cs);
      compartmentsTick(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, RT0);
      s.dmg.zones[W_LOUNGE] = 0;
      const V = s.net.V[LOUNGE], M = roomM(s.st, LOUNGE);
      const Aw = s.comp.def.orifices.find((o) => o.id === 'breach-w-lounge')!.A;
      const tau = V / (CD_HOLE * Aw * C_STAR * Math.sqrt(GAMMA * R_GAS * T0 / M));
      const p0 = s.io.p[LOUNGE], m0 = roomMass(s.st, LOUNGE);
      const J = new Float64Array(7), acc = new Float64Array(7);
      ventConsume(s.cs.vent, J);
      const h = 1 / 120 / sub;
      const errs: number[] = [];
      let t = 0;
      const tEnd = 3 * tau;
      while (t < tEnd - 1e-12) {
        compartmentsSubsteps(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, RT0, 1, h);
        t += h;
        ventConsume(s.cs.vent, J);
        for (let k = 0; k < 7; k++) acc[k] += J[k];
        for (const f of [1, 2, 3]) if (Math.abs(t - f * tau) < h / 2) {
          const exact = p0 * Math.pow(1 + (GAMMA - 1) / 2 * t / tau, -2 * GAMMA / (GAMMA - 1));
          errs.push(s.io.p[LOUNGE] / exact - 1);
        }
      }
      // drain the rest to compare the total impulse
      for (let n = 0; n < 2000; n++) {
        compartmentsSubsteps(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, RT0, 1, h);
        ventConsume(s.cs.vent, J);
        for (let k = 0; k < 7; k++) acc[k] += J[k];
      }
      const dm = m0 - roomMass(s.st, LOUNGE);
      const u0 = ventExitVelocity(0, T0, M);
      return { tau, errs, Jratio: Math.hypot(acc[0], acc[1], acc[2]) / (2 / (GAMMA + 1) * dm * u0), mRatio: acc[6] / dm, dm, gasT: T0 + s.cs.gasDT[LOUNGE], mist: s.cio.out.mist[LOUNGE] };
    };
    const a = run(2), b = run(8);
    console.log(`window: τ = ${(a.tau * 1000).toFixed(0)} ms; p error at τ, 2τ, 3τ: Q/2 ${a.errs.map((e) => e.toFixed(4))} · Q/8 ${b.errs.map((e) => e.toFixed(4))}; impulse/closed form ${a.Jratio.toFixed(4)} / ${b.Jratio.toFixed(4)}; ${a.dm.toFixed(1)} kg`);
    for (const e of a.errs) expect(Math.abs(e)).toBeLessThan(0.05);
    for (let i = 0; i < 3; i++) expect(Math.abs(b.errs[i])).toBeLessThan(Math.abs(a.errs[i]) / 3); // first order: 4× finer → ~4× smaller
    expect(Math.abs(a.Jratio - 1)).toBeLessThan(0.02);
    expect(Math.abs(b.Jratio - 1)).toBeLessThan(0.01);
    expect(Math.abs(a.mRatio - 1)).toBeLessThan(1e-9);
  });
});

describe('the Wren loses its lounge window with every door open', () => {
  it('doors auto-close, ≈ 250 kg vented, Δv ≈ 1.7 m/s, a yaw kick ≈ 0.15 rad/s, mass booked exactly; VENTING then not', () => {
    const s = setup();
    const m0 = massOf(s.net, s.st);
    s.dmg.zones[W_LOUNGE] = 0;
    const J = new Float64Array(7), acc = new Float64Array(7);
    let ventTicks = 0, closedAt = -1;
    for (let tick = 0; tick < 120 * 20; tick++) {
      const did = compartmentsTick(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, RT0);
      if (did) ventTicks++;
      else if (tick % 12 === 0) compartmentsGas(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, RT0, 0.1);
      ventConsume(s.cs.vent, J);
      for (let k = 0; k < 7; k++) acc[k] += J[k];
      if (closedAt < 0 && s.cn.comp.doors.every((_, k) => s.cs.mech.door[k * DOOR_STRIDE + D_S] === 0)) closedAt = tick / 120;
    }
    const dm = m0 - massOf(s.net, s.st);
    const Iyy = 67e3 * 31 * 31 / 12; // slender-body estimate of the Wren's yaw inertia
    console.log(`lounge window: ${dm.toFixed(1)} kg vented, |J| ${(Math.hypot(acc[0], acc[1], acc[2]) / 1000).toFixed(1)} kN·s, Δv ${(Math.hypot(acc[0], acc[1], acc[2]) / 67e3).toFixed(2)} m/s, L_y ${(acc[4] / 1000).toFixed(0)} kN·m·s → ω ≈ ${(acc[4] / Iyy).toFixed(3)} rad/s; doors all seated at ${closedAt.toFixed(2)} s; VENTING ${(ventTicks / 120).toFixed(2)} s`);
    expect(Math.abs(acc[6] / dm - 1)).toBeLessThan(1e-9);
    expect(dm).toBeGreaterThan(150); expect(dm).toBeLessThan(400);
    expect(closedAt).toBeGreaterThan(0); expect(closedAt).toBeLessThan(3);
    expect(Math.abs(acc[4] / Iyy)).toBeGreaterThan(0.05);
    expect(s.cs.venting).toBe(0);
    // the rest of the ship holds its (reduced) air behind the doors
    expect(s.io.p[roomOf('cargo')]).toBeGreaterThan(20e3);
    expect(s.io.p[LOUNGE]).toBeLessThan(100);
  });
});

describe('holes from located damage', () => {
  it('hole area from energy; panel hits map to the room behind the skin; wings are not pressurised', () => {
    const z = HULL_ZONES[Z_DORSAL_FWD], ud = z.energyDensity * z.crushDepth;
    expect(holeAreaFromEnergy(ud * PERF_FOOTPRINT, Z_DORSAL_FWD)).toBe(0);
    expect(holeAreaFromEnergy(1e6, Z_DORSAL_FWD)).toBeCloseTo(HOLE_PHI * (1e6 - ud * PERF_FOOTPRINT) / ud, 12);
    console.log(`dorsal hole: 50 kJ → ${(holeAreaFromEnergy(5e4, Z_DORSAL_FWD) * 1e4).toFixed(1)} cm², 1 MJ → ${holeAreaFromEnergy(1e6, Z_DORSAL_FWD).toFixed(3)} m²`);
    const s = setup();
    // a hit on the cargo bay's starboard flank from outside (x = 3.6 > the box's 3.2)
    const r = breachHit(s.cn.breach, s.cs.breach, s.net, 3.6, 0, 6, 1, 0, 0, 5e5, Z_FLANK_STBD);
    expect(r).toBe(roomOf('cargo'));
    expect(s.cs.breach.hole[r * HOLE_STRIDE]).toBeGreaterThan(0);
    // the draught opening moved onto the cargo bay's wall
    const op = s.cn.breach.holeOp[r];
    expect(s.net.opPos[3 * op]).toBeCloseTo(3.2, 9);
    // a wing hit far outboard: no room within reach
    expect(breachHit(s.cn.breach, s.cs.breach, s.net, -9, 0, 6, -1, 0, 0, 5e5, Z_WING_PORT)).toBe(-1);
    // the hole vents: the first tick is a VENTING tick (the opening grew), the vent force points inboard (−x); the
    // ship-wide τ ≈ 20 s then allows 0.02·τ ≈ 0.4 s steps: a sleep quantum is limited ('venting')
    expect(compartmentsTick(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, RT0)).toBe(true);
    const J = new Float64Array(7);
    ventConsume(s.cs.vent, J);
    expect(J[0]).toBeLessThan(0);
    for (let k = 0; k < 24; k++) if (!compartmentsTick(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, RT0) && k % 12 === 0) compartmentsGas(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, RT0, 0.1);
    console.log(`0.106 m² cargo hole: τ_min ${s.cs.tauMin.toFixed(1)} s, max gas step ${ventingMaxStep(s.cs).toFixed(2)} s`);
    expect(ventingMaxStep(s.cs)).toBeLessThan(2048 / 120);
    expect(ventingLimit(s.cs, 2048 / 120)).toBe('venting');
  });

  it('the force on a body near a breach points at the hole (drag + the pressure-gradient force)', () => {
    const s = setup();
    sealLounge(s.cn, s.cs);
    s.dmg.zones[W_LOUNGE] = 0;
    for (let k = 0; k < 4; k++) compartmentsTick(s.cn, s.cs, s.net, s.st, s.io, s.cio, TH, RT0);
    const f = new Float64Array(3);
    // 1 m in from the window centre (3.2, 0.35, −7.5)
    ventBodyForce(s.cn.breach, s.net, s.st, s.io, LOUNGE, 2.2, 0.35, -7.5, 0, 0, 0, 0.7, 0.07, f);
    console.log(`body (C_dA 0.7 m², 0.07 m³) 1 m from the open lounge window at t = 33 ms: F = (${f[0].toFixed(0)}, ${f[1].toFixed(0)}, ${f[2].toFixed(0)}) N`);
    expect(f[0]).toBeGreaterThan(100);
    expect(Math.abs(f[2])).toBeLessThan(f[0]);
    const g = new Float64Array(3);
    ventBodyForce(s.cn.breach, s.net, s.st, s.io, LOUNGE, 2.2, 0.35, -7.5, 0, 0, 0, 0.7, 0, g); // drag only
    expect(f[0]).toBeGreaterThan(g[0]); // the pressure-gradient force adds to the drag toward the hole
  });
});
