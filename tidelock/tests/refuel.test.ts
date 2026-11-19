// Refuelling through a docked port (src/world/refuel.ts).
import { describe, expect, it } from 'vitest';
import { LH2_LINE, lineFlow, makeRefuelIO, N2H4_LINE, refuelStep } from '../src/world/refuel';

const ship = () => ({ propellant: 0, propellantCapacity: 22500, rcsPropellant: 100, rcsPropellantCapacity: 1500 });
const wheel = () => ({ propellant: 2e6, rcsPropellant: 5e4 });

describe('refuelling', () => {
  it('the rates are the orifice law: 7.7 kg/s of LH2, 0.5 kg/s of hydrazine; 22.5 t takes about 49 min', () => {
    const q = 0.6 * Math.PI * 0.025 * 0.025 * Math.sqrt(2 * 71 * 3e5);
    expect(lineFlow(LH2_LINE)).toBeCloseTo(q, 12);
    expect(lineFlow(LH2_LINE)).toBeCloseTo(7.69, 2);
    expect(lineFlow(N2H4_LINE)).toBeCloseTo(0.5, 12);
    expect(22500 / lineFlow(LH2_LINE) / 60).toBeCloseTo(48.8, 1);
  });

  it('mass is conserved, the fill stops exactly at full, and one warp step equals many small ones', () => {
    const s1 = ship(), w1 = wheel(), io = makeRefuelIO();
    io.docked = true; io.lh2 = 1; io.n2h4 = 1;
    const M0 = s1.propellant + s1.rcsPropellant + w1.propellant + w1.rcsPropellant;
    io.dt = 1e4; refuelStep(io, s1, w1);
    expect(s1.propellant).toBe(22500);
    expect(s1.rcsPropellant).toBe(1500);
    expect(Math.abs(s1.propellant + s1.rcsPropellant + w1.propellant + w1.rcsPropellant - M0) / M0).toBeLessThan(1e-15);
    const s2 = ship(), w2 = wheel();
    io.dt = 1;
    for (let i = 0; i < 1e4; i++) refuelStep(io, s2, w2);
    expect(Math.abs(s2.propellant - s1.propellant)).toBeLessThan(1e-9);
    expect(Math.abs(w2.propellant - w1.propellant)).toBeLessThan(1e-6);
    expect(Math.abs(s2.propellant + s2.rcsPropellant + w2.propellant + w2.rcsPropellant - M0) / M0).toBeLessThan(1e-12); // 1e4 roundings
  });

  it('honest timing: the next flow edge, valves, not docked, a finite store', () => {
    const s = ship(), w = wheel(), io = makeRefuelIO();
    io.docked = true; io.lh2 = 1; io.n2h4 = 0; io.dt = 60;
    refuelStep(io, s, w);
    expect(io.dmLh2).toBeCloseTo(60 * lineFlow(LH2_LINE), 9);
    expect(io.nextEdge).toBeCloseTo((22500 - io.dmLh2) / lineFlow(LH2_LINE), 6);
    io.lh2 = 0.5; refuelStep(io, s, w);
    expect(io.mdotLh2).toBeCloseTo(0.5 * lineFlow(LH2_LINE), 12);
    io.docked = false; refuelStep(io, s, w);
    expect(io.dmLh2).toBe(0);
    const tiny = { propellant: 100, rcsPropellant: 0 };
    io.docked = true; io.lh2 = 1; io.dt = 1e3;
    const before = s.propellant;
    refuelStep(io, s, tiny);
    expect(tiny.propellant).toBe(0);
    expect(s.propellant - before).toBeCloseTo(100, 9);
  });
});
