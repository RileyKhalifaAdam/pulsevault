// The physical world, stages 3–6: craft dynamics, attitude control, atmosphere, contact, docking, advance, save/load.
import { describe, expect, it } from 'vitest';
import type { V3 } from '../src/core/types';
import { qFromAxisAngle, qFromTo, qMul, qRotate } from '../src/core/vec';
import { SHIP_LAYOUTS } from '../src/data/shipLayouts';
import { STATION_LAYOUTS } from '../src/data/stationLayouts';
import { computeStats, defaultLoadout } from '../src/sim/ships';
import { generateGalaxy, getSystem } from '../src/sim/universe';
import { START_STATION_ID } from '../src/data/systems/layout';
import { compoundSupport, hullCompound } from '../src/world/compound';
import {
  addCraft, advance, circularState, craftInertia, craftMass, createWorld, dockingStatus, DOCK_DISTANCE, drainEvents, flightReadout,
  holdTorque, loadWorld, pointingError, RESTITUTION, saveWorld, shipDef, undock, type Craft, type World, type WorldEvent,
} from '../src/world';
import { HOLD_MAX_RATE } from '../src/world/control';
import { assistVisible, holdCmdToJets, IN_RCS, makeLedgerMean, makeStepIn, torqueAuthority } from '../src/world/jets';
import { consumeLedger } from '../src/world/dynamics';
import { eventRing } from '../src/world/state';
import { drain } from '../src/world/events';
import { refreshWorld } from '../src/world/world';
import { qRotInv } from '../src/world/math';
import { FlightComputer, WAKE_ANGLE, type FlightHost } from '../src/game/flight';

const system = getSystem(generateGalaxy(1), 'tallow')!;
const stats = computeStats(defaultLoadout('wren'));
const WICK = 'tallow.wick', STAR = 'tallow.star', TAPER = 'tallow.taper';
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });

function wren(w: World, primaryId: string, r: V3, v: V3, q?: Craft['q']): Craft {
  return addCraft(w, shipDef('player', 'Wren', stats, SHIP_LAYOUTS.wren, { primaryId, r, v, q }));
}
function lowOrbit(alt: number, stations: boolean): { w: World; ship: Craft; R: number; mu: number } {
  const w = createWorld(system, { stations });
  const b = w.bodies.find((x) => x.id === WICK)!;
  return { w, ship: wren(w, WICK, ...(Object.values(circularState(b.mu, b.radius + alt, 0.3)) as [V3, V3])), R: b.radius, mu: b.mu };
}
/** Far above the system plane: gravity is a few µm/s². */
function deepSpace(): World {
  return createWorld(system, { stations: false });
}
const FAR = v3(0, 4e12, 0);
const WREN_HULL = hullCompound('wren')!;
/** How far the Wren's hull reaches from its centre along the unit ship-local direction d. */
const reach = (d: V3): number => compoundSupport(WREN_HULL, d.x, d.y, d.z);

describe('craft translation', () => {
  it('holds a 420 km orbit of Wick for 30 days, and for a year at large steps', () => {
    const { w, ship, R } = lowOrbit(420e3, true);
    const wheel = w.craft.find((c) => c.id === 'tallow.st.chandlers-wheel')!;
    const r0 = R + 420e3, rw0 = len(wheel.rel);
    let dev = 0, devW = 0, steps = 0;
    for (let i = 0; i < 720; i++) {
      steps += advance(w, 3600).steps;
      dev = Math.max(dev, Math.abs(len(ship.rel) - r0));
      devW = Math.max(devW, Math.abs(len(wheel.rel) - rw0));
    }
    console.log(`420 km orbit, 30 d: radius within ${dev.toFixed(1)} m; Chandler's Wheel within ${devW.toFixed(1)} m`);
    expect(dev).toBeLessThan(4200);
    expect(devW).toBeLessThan(0.01 * (rw0 - R));
    for (let i = 0; i < 67; i++) {
      steps += advance(w, 5 * 86400).steps;
      dev = Math.max(dev, Math.abs(len(ship.rel) - r0));
      devW = Math.max(devW, Math.abs(len(wheel.rel) - rw0));
    }
    const taperLock = w.craft.find((c) => c.id === 'tallow.st.taper-lock')!;
    console.log(`420 km orbit, 365 d (${steps} steps): radius within ${dev.toFixed(1)} m; Wheel within ${devW.toFixed(1)} m`);
    expect(w.t).toBeCloseTo(365 * 86400, 3);
    expect(dev).toBeLessThan(4200);
    expect(devW).toBeLessThan(0.01 * (rw0 - R));
    for (const s of w.craft) expect(w.bodies[s.primary].id).toBe(s === ship ? WICK : system.stations.find((d) => d.id === s.id)!.parentBodyId);
    expect(Math.abs(len(taperLock.rel) / 2466521 - 1)).toBeLessThan(0.02);
    expect(drainEvents(w).length).toBe(0);
  });

  it('a 60 s burn gives the delta-v of the rocket equation (two engines: ignition delay, spool, canted through the CoM)', () => {
    const w = deepSpace();
    const ship = wren(w, STAR, FAR, v3());
    const m0 = craftMass(ship);
    ship.throttle = 1;
    const r = advance(w, 60);
    expect(r.simDt).toBe(60);
    const m1 = craftMass(ship);
    // 0.5 s of ignition delay, then F_s = F(1 − e^(−t/0.8)): ∫F dt = F·(59.5 − 0.8·(1 − e^(−59.5/0.8)))
    const burnT = 59.5 - 0.8 * (1 - Math.exp(-59.5 / 0.8));
    expect(m0 - m1).toBeCloseTo((stats.mainThrust / stats.exhaustVelocity) * burnT, 6);
    expect(ship.rcsPropellant).toBe(ship.rcsPropellantCapacity); // no jet fired
    const dv = len(ship.relV), want = stats.exhaustVelocity * Math.log(m0 / m1);
    console.log(`rocket equation: flown ${dv.toFixed(4)} m/s, ideal ${want.toFixed(4)} m/s (${r.steps} steps)`);
    expect(Math.abs(dv / want - 1)).toBeLessThan(1e-3);
    // both pods sit 0.2 m below the CoM and are canted atan(0.2/15.6) = 0.73° so the thrust passes through it
    const cant = Math.atan2(0.2, 15.6);
    expect(-ship.relV.z / dv).toBeCloseTo(Math.cos(cant), 6);
    expect(len(ship.w)).toBeLessThan(1e-9); // and so it makes no torque
    // Running dry stops the thrust.
    advance(w, 2000);
    expect(ship.propellant).toBe(0);
    const v1 = len(ship.relV);
    expect(Math.abs(v1 / (stats.exhaustVelocity * Math.log(m0 / (stats.dryMass + ship.rcsPropellant))) - 1)).toBeLessThan(1e-3); // W1-A: the RCS pool stays aboard
    advance(w, 100);
    expect(Math.abs(len(ship.relV) - v1)).toBeLessThan(1e-2);
  });
});

describe('craft rotation', () => {
  it('torque-free tumbling conserves angular momentum and energy', () => {
    const w = deepSpace();
    const ship = wren(w, STAR, FAR, v3());
    ship.w = v3(0.3, 0.05, 0.4);
    const I = craftInertia(ship, v3());
    const L = (): V3 => qRotate(ship.q, v3(I.x * ship.w.x, I.y * ship.w.y, I.z * ship.w.z));
    const E = (): number => 0.5 * (I.x * ship.w.x ** 2 + I.y * ship.w.y ** 2 + I.z * ship.w.z ** 2);
    const L0 = L(), E0 = E();
    let dL = 0, dE = 0, dw = 0;
    for (let i = 0; i < 60; i++) {
      advance(w, 10);
      dL = Math.max(dL, len(sub(L(), L0)) / len(L0));
      dE = Math.max(dE, Math.abs(E() / E0 - 1));
      dw = Math.max(dw, len(sub(ship.w, v3(0.3, 0.05, 0.4))));
    }
    console.log(`tumbling 600 s: |dL|/L ≤ ${dL.toExponential(2)}, |dE|/E ≤ ${dE.toExponential(2)}`);
    expect(dw).toBeGreaterThan(0.05); // it really tumbles
    expect(dL).toBeLessThan(1e-4);
    expect(dE).toBeLessThan(1e-5);
  });

  it('the hold controller turns 90° with real torque (the jets) at 0.1 rad/s and settles without overshoot (D3)', () => {
    const w = deepSpace();
    const ship = wren(w, STAR, FAR, v3());
    const dir = v3(1, 0, 0), e = v3(), I = v3(), cmd = new Float64Array(6), inp = makeStepIn();
    const p0 = ship.rcsPropellant;
    let reached = -1, rebound = 0, ang = 0, peakRate = 0;
    for (let k = 0; k < 60 * 30; k++) {
      ang = len(pointingError(ship.q, dir, e));
      if (k === 0) expect(ang).toBeCloseTo(Math.PI / 2, 9);
      if (reached < 0 && ang < 0.02) reached = k / 60;
      if (reached >= 0) rebound = Math.max(rebound, ang);
      inp[IN_RCS] = ship.rcsPropellant;
      torqueAuthority(ship.jetAlloc, inp, ship.maxTorque);
      holdTorque(e, ship.w, craftInertia(ship, I), ship.maxTorque, ship.torque);
      holdCmdToJets(ship.jetAlloc, ship.torque, cmd);
      ship.torque.x = cmd[3]; ship.torque.y = cmd[4]; ship.torque.z = cmd[5];
      advance(w, 1 / 60);
      peakRate = Math.max(peakRate, len(ship.w));
    }
    const used = p0 - ship.rcsPropellant;
    console.log(`hold: 90° reached in ${reached.toFixed(2)} s, peak rate ${peakRate.toFixed(3)} rad/s, final error ${ang.toExponential(2)} rad, rate ${len(ship.w).toExponential(2)} rad/s; ${used.toFixed(1)} kg of hydrazine`);
    expect(peakRate).toBeLessThan(HOLD_MAX_RATE * 1.02);
    expect(used).toBeGreaterThan(25); // the plan's "about 40 kg per hold slew"
    expect(used).toBeLessThan(60);
    expect(len(ship.relV)).toBeLessThan(3e-3); // a pure torque from the jets: no translation (this is the star's 6e-5 m/s² pull over 30 s)
    expect(reached).toBeGreaterThan(0);
    expect(reached).toBeLessThan(20);
    expect(rebound).toBeLessThan(0.03);
    expect(ang).toBeLessThan(0.005);
    expect(len(ship.w)).toBeLessThan(0.002);
    const f = qRotate(ship.q, v3(0, 0, -1));
    expect(f.x).toBeGreaterThan(0.9999);
  });
});

describe('atmosphere', () => {
  const entry = (rp: number, ra: number): { w: World; ship: Craft; mu: number; R: number } => {
    const w = createWorld(system, { stations: false });
    const b = w.bodies.find((x) => x.id === WICK)!;
    const a = (2 * b.radius + rp + ra) / 2, r = b.radius + ra;
    const ship = wren(w, WICK, v3(r, 0, 0), v3(0, 0, -Math.sqrt(b.mu * (2 / r - 1 / a))));
    return { w, ship, mu: b.mu, R: b.radius };
  };
  const energy = (c: Craft, mu: number): number => 0.5 * (c.relV.x ** 2 + c.relV.y ** 2 + c.relV.z ** 2) - mu / len(c.rel);

  it("a low pass through Wick's air loses energy and heats the hull", () => {
    const { w, ship, mu } = entry(105e3, 400e3);
    const e0 = energy(ship, mu);
    let heat = 0, load = 0;
    const ev: WorldEvent[] = [];
    for (let i = 0; i < 70; i++) {
      advance(w, 80);
      heat = Math.max(heat, ship.heat / ship.heatCapacity);
      load = Math.max(load, ship.load);
      ev.push(...drainEvents(w));
    }
    const atm = ev.filter((x) => x.type === 'atmosphere');
    console.log(`aerobrake pass at 105 km: specific energy ${e0.toFixed(0)} -> ${energy(ship, mu).toFixed(0)} J/kg, peak heat ${(100 * heat).toFixed(1)} %, peak load ${load.toFixed(2)} m/s²`);
    expect(atm.map((x) => x.type === 'atmosphere' && x.entered)).toEqual([true, false]);
    expect(energy(ship, mu)).toBeLessThan(e0 - 1e4);
    expect(heat).toBeGreaterThan(0.01);
    expect(ship.destroyed).toBe(false);
    expect(ship.heat / ship.heatCapacity).toBeLessThan(heat); // radiating again
  });

  it('a steep entry destroys the craft', () => {
    const w = createWorld(system, { stations: false });
    const b = w.bodies.find((x) => x.id === WICK)!;
    const a = (40 * Math.PI) / 180;
    const ship = wren(w, WICK, v3(b.radius + 150e3, 0, 0), v3(-7000 * Math.sin(a), 0, -7000 * Math.cos(a)));
    let t = 0;
    while (!ship.destroyed && t < 300) { advance(w, 1); t++; }
    const ev = drainEvents(w);
    console.log(`steep entry: destroyed by ${ship.destroyedBy} after ${t} s at ${((len(ship.rel) - b.radius) / 1000).toFixed(1)} km`);
    expect(ship.destroyed).toBe(true);
    expect(['overload', 'heat']).toContain(ship.destroyedBy);
    expect(ev.some((x) => x.type === 'destroyed')).toBe(true);
    expect(ev.some((x) => x.type === 'atmosphere' && x.entered)).toBe(true);
    // The wreck keeps falling under the same laws and ends on the ground.
    for (let i = 0; i < 400 && ship.landedOn === null; i++) advance(w, 5);
    expect(ship.landedOn).toBe(WICK);
  });
});

describe('contact', () => {
  const rock = (w: World): Craft =>
    addCraft(w, { id: 'rock', name: 'Rock', kind: 'station', dryMass: 2e5, radius: 40, colliders: [{ kind: 'sphere', a: v3(), radius: 40 }], primaryId: STAR, r: FAR, v: v3() });

  it('an impact conserves momentum and loses energy by its restitution', () => {
    const w = deepSpace();
    const st = rock(w);
    // Belly-first onto the top of the rock, the contact straight under the centre of mass, with a sideways slide.
    const belly = reach(v3(0, -1, 0));
    const ship = wren(w, STAR, v3(FAR.x, FAR.y + 40 + belly + 0.5, FAR.z), v3(1, -3, 0));
    const m = craftMass(ship), M = craftMass(st);
    // Barycentric (inertial) momentum of the pair, taken the frame before and the frame after the hit.
    const mom = (): V3 => v3(m * ship.v.x + M * st.v.x, m * ship.v.y + M * st.v.y, m * ship.v.z + M * st.v.z);
    const ke = (): number => 0.5 * m * len(ship.relV) ** 2 + 0.5 * M * len(st.relV) ** 2;
    const k0 = ke();
    let hit: WorldEvent | undefined, p0 = mom();
    for (let i = 0; i < 600 && !hit; i++) { p0 = mom(); advance(w, 1 / 60); hit = drainEvents(w).find((x) => x.type === 'impact'); }
    expect(hit).toBeDefined();
    const p1 = mom();
    const n = sub(ship.rel, st.rel);
    expect(n.y).toBeGreaterThan(40 + belly - 0.1); // the belly on the rock, not the bounding sphere
    expect(n.y).toBeLessThan(40 + belly + 0.1);
    const vnAfter = ship.relV.y - st.relV.y;
    console.log(`impact: normal speed -3 -> ${vnAfter.toFixed(3)} m/s, momentum error ${(len(sub(p1, p0)) / (3 * m)).toExponential(2)}, KE ${k0.toFixed(0)} -> ${ke().toFixed(0)} J, hull ${ship.hull.toFixed(4)}`);
    expect(len(sub(p1, p0)) / (3 * m)).toBeLessThan(1e-6);
    // the centre's rebound: with the hull's own inertia (compoundGyration, a small roll moment) the manifold's
    // off-centre points turn part of the friction impulse into spin, so the centre comes off within 1.5 % of e
    expect(Math.abs(vnAfter / 3 - RESTITUTION)).toBeLessThan(0.015);
    expect(ke()).toBeLessThan(k0);
    expect(len(ship.w)).toBeGreaterThan(0); // friction on the slide spins the ship
    expect(ship.hull).toBeLessThan(1);
    expect(ship.hull).toBeGreaterThan(0.9);
    expect(ship.destroyed).toBe(false);
  });

  it('rests against a station for 60 s without jitter, pressed on by its RCS', () => {
    const w = deepSpace();
    const st = addCraft(w, { id: 'rock', name: 'Rock', kind: 'station', dryMass: 1e10, radius: 40, colliders: [{ kind: 'sphere', a: v3(), radius: 40 }], primaryId: STAR, r: FAR, v: v3() });
    const belly = reach(v3(0, -1, 0));
    const ship = wren(w, STAR, v3(FAR.x, FAR.y + 40 + belly + 0.05, FAR.z), v3(0, -0.1, 0));
    ship.rcs.y = -0.1; // a light push down onto the rock
    const ev: WorldEvent[] = [];
    let vMax = 0, hMin = Infinity, hMax = -Infinity, wMax = 0;
    for (let i = 0; i < 60 * 65; i++) {
      advance(w, 1 / 60);
      ev.push(...drainEvents(w));
      if (i < 60 * 5) continue;
      const h = len(sub(ship.rel, st.rel));
      vMax = Math.max(vMax, len(sub(ship.relV, st.relV)));
      wMax = Math.max(wMax, len(ship.w));
      hMin = Math.min(hMin, h); hMax = Math.max(hMax, h);
    }
    console.log(`resting 60 s on the rock: max |v| ${vMax.toExponential(2)} m/s, max |w| ${wMax.toExponential(2)} rad/s, height ${hMin.toFixed(4)}..${hMax.toFixed(4)} m`);
    expect(vMax).toBeLessThan(1e-3);
    expect(wMax).toBeLessThan(1e-4);
    expect(hMax - hMin).toBeLessThan(2e-3);
    expect(hMin).toBeGreaterThan(40 + belly - 0.03);
    expect(ev.filter((x) => x.type === 'impact').length).toBe(0);
    expect(ship.hull).toBeGreaterThan(0.9999);
  });

  it("a Wren wing-tip strike on Chandler's Wheel turns the ship toward the struck side", () => {
    const w = createWorld(system);
    const st = w.craft.find((c) => c.id === START_STATION_ID)!;
    // The hub (sphere of 68 m) at 45° latitude, where it stands proud of the axle; the ship moves nose-first past it
    // with the hub just off its starboard wing tip (ship-local u: 14° ahead of the beam).
    const uLocal = v3(0.97, 0, -0.243), ul = len(uLocal), u = v3(uLocal.x / ul, uLocal.y / ul, uLocal.z / ul);
    const uWorld = qRotate(st.q, v3(Math.SQRT1_2, Math.SQRT1_2, 0));
    const q = qFromTo(u, uWorld);
    const d = 68 + reach(u) + 0.3;
    const fwd = qRotate(q, v3(0, 0, -4));
    const ship = addCraft(w, shipDef('player', 'Wren', stats, SHIP_LAYOUTS.wren, {
      primaryId: w.bodies[st.primary].id, r: v3(st.rel.x - uWorld.x * d, st.rel.y - uWorld.y * d, st.rel.z - uWorld.z * d),
      v: v3(st.relV.x + fwd.x, st.relV.y + fwd.y, st.relV.z + fwd.z), q,
    }));
    let hit: WorldEvent | undefined;
    for (let i = 0; i < 600 && !hit; i++) { advance(w, 1 / 60); hit = drainEvents(w).find((x) => x.type === 'impact' && x.craftId === 'player'); }
    expect(hit).toBeDefined();
    for (let i = 0; i < 6; i++) advance(w, 1 / 60);
    console.log(`wing-tip strike at ${hit && hit.type === 'impact' ? hit.speed.toFixed(2) : '?'} m/s: yaw rate ${ship.w.y.toExponential(2)} rad/s, roll ${ship.w.z.toExponential(2)}, pitch ${ship.w.x.toExponential(2)}, hull ${ship.hull.toFixed(5)}`);
    expect(ship.w.y).toBeLessThan(-1e-4); // about +Y negative: the nose swings to starboard, toward the hub
    expect(Math.abs(ship.w.y)).toBeGreaterThan(Math.abs(ship.w.x));
    // pushed away from the hub (to port in ship axes)
    const dv = qRotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, sub(ship.relV, st.relV));
    expect(dv.x).toBeLessThan(0);
    expect(ship.destroyed).toBe(false);
  });

  it('two ships collide wing tip to wing tip: momentum is kept, both turn away, both take the damage', () => {
    const w = deepSpace();
    const a = wren(w, STAR, v3(FAR.x - 12, FAR.y, FAR.z), v3(1, 0, 0));
    const b = addCraft(w, shipDef('other', 'Wren', stats, SHIP_LAYOUTS.wren, { primaryId: STAR, r: v3(FAR.x + 12, FAR.y, FAR.z + 2), v: v3(-1, 0, 0) }));
    const m = craftMass(a), M = craftMass(b);
    // barycentric momentum the frame before and the frame after the hit (gravity is the same on both)
    const mom = (): V3 => v3(m * a.v.x + M * b.v.x, m * a.v.y + M * b.v.y, m * a.v.z + M * b.v.z);
    let hit: WorldEvent | undefined, p0 = mom();
    for (let i = 0; i < 60 * 10 && !hit; i++) { p0 = mom(); advance(w, 1 / 60); hit = drainEvents(w).find((x) => x.type === 'impact'); }
    expect(hit).toBeDefined();
    const p1 = mom();
    console.log(`ship-ship: hit at ${hit && hit.type === 'impact' ? hit.speed.toFixed(2) : '?'} m/s, momentum error ${(len(sub(p1, p0)) / (2 * m)).toExponential(2)}`);
    expect(len(sub(p1, p0)) / (m * 2)).toBeLessThan(1e-6);
    // wing tip into wing tip: they meet at the wings (x ±9.5), not at the bounding spheres (2 x 16.5 m) ...
    expect(b.rel.x - a.rel.x).toBeLessThan(2 * 9.6);
    expect(b.rel.x - a.rel.x).toBeGreaterThan(2 * 9.3);
    // ... and the off-centre blow turns each away from the other (most of it goes into the spin)
    expect(a.w.y).toBeLessThan(-0.01);
    expect(b.w.y).toBeGreaterThan(0.01);
    expect(a.hull).toBeLessThan(1);
    expect(b.hull).toBeLessThan(1);
  });

  it('a fast impact destroys the ship', () => {
    const w = deepSpace();
    rock(w);
    const ship = wren(w, STAR, v3(FAR.x + 120, FAR.y, FAR.z), v3(-40, 0, 0));
    for (let i = 0; i < 300 && !ship.destroyed; i++) advance(w, 1 / 60);
    expect(ship.destroyed).toBe(true);
    expect(ship.destroyedBy).toBe('impact');
  });

  it('lands softly on a moon, rides the rotating ground, lifts off under thrust; a fast arrival is a wreck', () => {
    const w = createWorld(system, { stations: false });
    const b = w.bodies.find((x) => x.id === TAPER)!;
    const up = v3(Math.cos(0.4), 0, -Math.sin(0.4));
    const tail = reach(v3(0, 0, 1)); // nose up: it stands on its engine pods
    const place = (h: number): { r: V3; v: V3 } => {
      const rr = b.radius + h, r = v3(up.x * rr, up.y * rr, up.z * rr), wv = b.spinRate, n = b.spinAxis;
      return { r, v: v3(wv * (n.y * r.z - n.z * r.y), wv * (n.z * r.x - n.x * r.z), wv * (n.x * r.y - n.y * r.x)) };
    };
    const p = place(tail + 3);
    const ship = wren(w, TAPER, p.r, p.v, qFromTo(v3(0, 0, -1), up)); // nose up
    const crasher = addCraft(w, { ...shipDef('crasher', 'Crasher', stats, SHIP_LAYOUTS.wren, { primaryId: TAPER, ...place(3000), q: qFromTo(v3(0, 1, 0), up) }) });
    const ev: WorldEvent[] = [];
    for (let i = 0; i < 400; i++) { advance(w, 0.5); ev.push(...drainEvents(w)); }
    expect(ship.landedOn).toBe(TAPER);
    expect(ship.destroyed).toBe(false);
    expect(ev.some((x) => x.type === 'landed' && x.craftId === 'player')).toBe(true);
    const crash = ev.find((x) => x.type === 'impact' && x.craftId === 'crasher');
    const g = b.mu / b.radius ** 2;
    console.log(`touchdown on Taper (g = ${g.toFixed(2)} m/s²); crash at ${crash && crash.type === 'impact' ? crash.speed.toFixed(1) : '?'} m/s, free fall predicts ${Math.sqrt(2 * g * 3000).toFixed(1)}`);
    expect(crash && crash.type === 'impact' && Math.abs(crash.speed / Math.sqrt(2 * g * 3000) - 1) < 0.05).toBe(true);
    expect(crasher.destroyed).toBe(true);
    const before = { ...ship.rel };
    advance(w, 2000);
    const fr = flightReadout(w, 'player');
    expect(fr.situation).toBe('landed');
    expect(fr.surfaceSpeed).toBeLessThan(1e-6);
    expect(Math.abs(fr.altitude - tail)).toBeLessThan(1e-3); // standing on the hull's lowest point, not a sphere
    expect(len(sub(ship.rel, before))).toBeGreaterThan(1000); // carried round by the spin
    ship.throttle = 1;
    for (let i = 0; i < 300; i++) advance(w, 1 / 60);
    ev.push(...drainEvents(w));
    expect(ship.landedOn).toBe(null);
    expect(ev.some((x) => x.type === 'liftoff')).toBe(true);
    expect(flightReadout(w, 'player').altitude).toBeGreaterThan(50);
  });

  it("a slow, level touchdown rests on the hull's belly", () => {
    const w = createWorld(system, { stations: false });
    const b = w.bodies.find((x) => x.id === TAPER)!;
    const up = v3(Math.cos(1.1), 0, -Math.sin(1.1));
    const belly = reach(v3(0, -1, 0));
    const rr = b.radius + belly + 2, r = v3(up.x * rr, up.y * rr, up.z * rr), wv = b.spinRate, n = b.spinAxis;
    const v = v3(wv * (n.y * r.z - n.z * r.y), wv * (n.z * r.x - n.x * r.z), wv * (n.x * r.y - n.y * r.x));
    const ship = wren(w, TAPER, r, v, qFromTo(v3(0, 1, 0), up)); // level, belly down
    const ev: WorldEvent[] = [];
    for (let i = 0; i < 60 * 20 && ship.landedOn === null; i++) { advance(w, 1 / 60); ev.push(...drainEvents(w)); }
    expect(ship.landedOn).toBe(TAPER);
    expect(ship.destroyed).toBe(false);
    expect(ev.some((x) => x.type === 'impact')).toBe(false);
    advance(w, 60);
    const fr = flightReadout(w, 'player');
    console.log(`level touchdown: altitude ${fr.altitude.toFixed(4)} m (belly ${belly.toFixed(3)} m, bounding radius ${SHIP_LAYOUTS.wren.radius} m), hull ${ship.hull.toFixed(5)}`);
    expect(fr.situation).toBe('landed');
    expect(Math.abs(fr.altitude - belly)).toBeLessThan(1e-3);
    expect(ship.hull).toBeGreaterThan(0.98); // a 2.2 m/s touchdown: the energy the impulses take out dents it a little
  });
});

describe('docking', () => {
  const layout = STATION_LAYOUTS.outpost, port = layout.ports.find((p) => p.id === 'P2')!;
  const collar = SHIP_LAYOUTS.wren.dockingPort;
  /** Station at rest in deep space; ship with its collar `d` metres out along the port axis, tilted by `tilt`, closing at `speed`. */
  const scene = (d: number, tilt: number, speed: number): { w: World; ship: Craft; st: Craft } => {
    const w = deepSpace();
    const st = addCraft(w, { id: 'post', name: 'Post', kind: 'station', dryMass: 1e6, radius: layout.radius, colliders: layout.colliders, ports: layout.ports, pad: 'M', primaryId: STAR, r: FAR, v: v3() });
    const q = qMul(qFromAxisAngle(v3(1, 0, 0), tilt), qFromTo(collar.dir, v3(-port.dir.x, -port.dir.y, -port.dir.z)));
    const off = qRotate(q, collar.pos);
    const r = v3(FAR.x + port.pos.x + port.dir.x * d - off.x, FAR.y + port.pos.y + port.dir.y * d - off.y, FAR.z + port.pos.z + port.dir.z * d - off.z);
    const ship = wren(w, STAR, r, v3(-port.dir.x * speed, -port.dir.y * speed, -port.dir.z * speed), q);
    ship.dockingArmed = true;
    return { w, ship, st };
  };

  it('latches only inside the tolerances', () => {
    // Misaligned by 40°: no latch.
    let s = scene(2, (40 * Math.PI) / 180, 0);
    let ds = dockingStatus(s.w, 'player');
    expect(ds.portId).toBe('P2');
    expect(ds.portDistance).toBeCloseTo(2, 6);
    expect(ds.alignment).toBeCloseTo((40 * Math.PI) / 180, 6);
    expect(ds.canLatch).toBe(false);
    advance(s.w, 1);
    expect(s.ship.dockedTo).toBe(null);
    // Too fast: no latch.
    s = scene(3, 0, 3);
    expect(dockingStatus(s.w, 'player').canLatch).toBe(false);
    advance(s.w, 1 / 60);
    expect(s.ship.dockedTo).toBe(null);
    // Not armed: no latch.
    s = scene(2, 0, 0);
    s.ship.dockingArmed = false;
    expect(dockingStatus(s.w, 'player').canLatch).toBe(true);
    advance(s.w, 1);
    expect(s.ship.dockedTo).toBe(null);
    // Too far: nothing until the collar is within DOCK_DISTANCE, then the latch closes.
    s = scene(12, 0, 0.5);
    const m = craftMass(s.ship), M = craftMass(s.st);
    const mom = (): V3 => v3(m * s.ship.v.x + M * s.st.v.x, m * s.ship.v.y + M * s.st.v.y, m * s.ship.v.z + M * s.st.v.z);
    let prev = 12, latchedAt = -1, p0 = mom();
    const ev: WorldEvent[] = [];
    for (let i = 0; i < 60 * 40 && latchedAt < 0; i++) {
      prev = dockingStatus(s.w, 'player').portDistance;
      p0 = mom();
      advance(s.w, 1 / 60);
      ev.push(...drainEvents(s.w));
      if (s.ship.dockedTo !== null) latchedAt = dockingStatus(s.w, 'player').portDistance;
    }
    console.log(`latch closed with the collar ${latchedAt.toFixed(3)} m from the port (previous frame ${prev.toFixed(3)} m)`);
    expect(prev).toBeGreaterThan(DOCK_DISTANCE);
    expect(latchedAt).toBeLessThanOrEqual(DOCK_DISTANCE);
    expect(latchedAt).toBeGreaterThan(DOCK_DISTANCE - 0.1);
    expect(ev.filter((x) => x.type === 'impact').length).toBe(0);
    expect(ev.some((x) => x.type === 'docked' && x.stationId === 'post' && x.portId === 'P2')).toBe(true);
    expect(s.w.joints.length).toBe(1);
    expect(len(sub(mom(), p0)) / (0.5 * m)).toBeLessThan(1e-4); // momentum kept by the pair
    expect(len(sub(s.ship.v, s.st.v))).toBeLessThan(1e-12);
    // The ship now moves with the station, and its drive is interlocked.
    const rel0 = sub(s.ship.rel, s.st.rel), prop = s.ship.propellant;
    s.ship.throttle = 1;
    advance(s.w, 20);
    expect(len(sub(sub(s.ship.rel, s.st.rel), rel0))).toBeLessThan(1e-6);
    expect(s.ship.propellant).toBe(prop);
    s.ship.throttle = 0;
    // Undock: a spring impulse separates the two at 1 m/s along the port axis.
    expect(undock(s.w, 'player')).toBe(true);
    expect(undock(s.w, 'player')).toBe(false);
    expect(drainEvents(s.w).some((x) => x.type === 'undocked')).toBe(true);
    advance(s.w, 10);
    const dv = sub(s.ship.relV, s.st.relV);
    expect(len(dv)).toBeCloseTo(1, 6);
    expect(dv.x * port.dir.x + dv.y * port.dir.y + dv.z * port.dir.z).toBeCloseTo(1, 6);
    expect(dockingStatus(s.w, 'player').portDistance).toBeCloseTo(latchedAt + 10, 3);
    expect(s.ship.dockedTo).toBe(null);
    expect(s.w.joints.length).toBe(0);
  });
});

describe('docking on the Wheel', () => {
  it("an armed, slow approach to a port of Chandler's Wheel closes the latch; the hull never touches", () => {
    const w = createWorld(system);
    const st = w.craft.find((c) => c.id === START_STATION_ID)!;
    const collar = SHIP_LAYOUTS.wren.dockingPort;
    const port = st.ports.find((p) => p.size !== 'S')!;
    const pdir = qRotate(st.q, port.dir), ppos = qRotate(st.q, port.pos);
    const q = qFromTo(collar.dir, v3(-pdir.x, -pdir.y, -pdir.z));
    const off = qRotate(q, collar.pos), d = 12;
    const ship = addCraft(w, shipDef('player', 'Wren', stats, SHIP_LAYOUTS.wren, {
      primaryId: w.bodies[st.primary].id,
      r: v3(st.rel.x + ppos.x + pdir.x * d - off.x, st.rel.y + ppos.y + pdir.y * d - off.y, st.rel.z + ppos.z + pdir.z * d - off.z),
      v: v3(st.relV.x - pdir.x * 0.5, st.relV.y - pdir.y * 0.5, st.relV.z - pdir.z * 0.5), q, pad: 'S',
    }));
    ship.dockingArmed = true;
    const ev: WorldEvent[] = [];
    for (let i = 0; i < 60 * 40 && ship.dockedTo === null; i++) { advance(w, 1 / 60); ev.push(...drainEvents(w)); }
    expect(ship.dockedTo).toBe(st.id);
    expect(ev.some((x) => x.type === 'docked' && x.portId === port.id)).toBe(true);
    expect(ev.filter((x) => x.type === 'impact').length).toBe(0);
    expect(ship.hull).toBe(1);
  });
});

describe('advance, save and load', () => {
  it('reports what limited it when the budget runs out', () => {
    const { w, ship } = lowOrbit(420e3, false);
    let clock = 0;
    const now = (): number => (clock += 0.25);
    let r = advance(w, 1 / 60, { budgetMs: 3, now });
    expect(r.simDt).toBeCloseTo(1 / 60, 12);
    expect(r.limitedBy).toBe('');
    r = advance(w, 1e7, { budgetMs: 3, now });
    expect(r.simDt).toBeGreaterThan(1000);
    expect(r.simDt).toBeLessThan(1e7);
    expect(r.limitedBy).toBe('cpu');
    ship.throttle = 0.2; // above the 15% minimum: the engines light
    r = advance(w, 1000, { budgetMs: 3, now });
    expect(r.simDt).toBeLessThan(1000);
    expect(r.limitedBy).toBe('thrust');
    ship.throttle = 0;
    advance(w, 10); // the shut-down tail ends (F_s = 0 exactly after τ_down·ln(F/ε) ≈ 2.6 s)
    expect(ship.engineThrust).toEqual([0, 0]);
    ship.torque.x = 0.5;
    r = advance(w, 1000, { budgetMs: 3, now });
    expect(r.limitedBy).toBe('rotation');
  });

  it('save -> load -> continue is bit-identical', () => {
    const run = (saves: boolean): string => {
      let { w } = lowOrbit(420e3, true);
      const fly = (frames: number, throttle: number, tx: number): void => {
        const ship = w.craft.find((c) => c.id === 'player')!;
        ship.throttle = throttle; ship.torque.x = tx; ship.torque.y = -tx / 2; ship.rcs.y = throttle > 0 ? 0.5 : 0;
        for (let i = 0; i < frames; i++) advance(w, 1 / 60);
      };
      fly(60, 0.3, 0.2);
      if (saves) w = loadWorld(saveWorld(w));
      fly(60, 0.6, -0.1);
      fly(1, 0, 0);
      advance(w, 4000);
      if (saves) w = loadWorld(saveWorld(w));
      advance(w, 3 * 86400);
      fly(30, 1, 0.05);
      return saveWorld(w);
    };
    const a = run(false), b = run(true);
    console.log(`save size ${a.length} bytes`);
    expect(a.length).toBeLessThan(100_000);
    expect(b).toBe(a);
  });

  it('save -> load -> continue is bit-identical in contact (the warm-start manifolds are saved)', () => {
    const run = (saves: boolean): string => {
      let w = deepSpace();
      addCraft(w, { id: 'rock', name: 'Rock', kind: 'station', dryMass: 1e9, radius: 40, colliders: [{ kind: 'sphere', a: v3(), radius: 40 }], primaryId: STAR, r: FAR, v: v3() });
      const ship = wren(w, STAR, v3(FAR.x + 1.2, FAR.y + 40 + reach(v3(0, -1, 0)) + 0.3, FAR.z), v3(0.4, -1, 0));
      ship.rcs.y = -0.2;
      for (let i = 0; i < 90; i++) advance(w, 1 / 60);
      if (saves) {
        const json = saveWorld(w);
        expect(json).toContain('"contacts":[{');
        w = loadWorld(json);
      }
      for (let i = 0; i < 120; i++) advance(w, 1 / 60);
      return saveWorld(w);
    };
    const a = run(false), b = run(true);
    expect(a.length).toBeLessThan(100_000);
    expect(b).toBe(a);
  });
});

describe('real thrusters (W1-B): jets, two pools, two engines, the ledger, the settled hold', () => {
  const Q = 1 / 120;
  const mean = makeLedgerMean();
  const sub3 = (a: V3, b: V3): V3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
  const toCraft = (s: Craft, a: V3): V3 => qRotInv(v3(), s.q, a.x, a.y, a.z);
  const rel = (a: number, b: number): number => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-300);

  it('the ledger is the truth: per step ∫fAcc = m·Δv − ∫m·g (the RK4 mass weights), jets and engines, within 1e-9', () => {
    // A thrusts, its twin B coasts from the same state: Δv_A − Δv_B is the proper part (B shares A's gravity to 1e-17).
    const worldA = createWorld(system, { stations: false }), worldB = createWorld(system, { stations: false });
    const a = wren(worldA, STAR, FAR, v3()), b = wren(worldB, STAR, FAR, v3());
    let worstMag = 0, worstDir = 0, worstTau = 0, steps = 0;
    const phase = (n: number, set: (s: Craft) => void, still: boolean): void => {
      set(a);
      for (let i = 0; i < n; i++) {
        const va = { ...a.relV }, vb = { ...b.relV }, wa = { ...a.w }, m0 = craftMass(a);
        const Ia = craftInertia(a, v3());
        advance(worldA, Q); advance(worldB, Q);
        const m1 = craftMass(a);
        consumeLedger(a, mean);
        expect(mean.T).toBeCloseTo(Q, 15);
        const dvp = sub3(sub3(a.relV, va), sub3(b.relV, vb));
        // RK4 with ṁ constant: Δv = (h/6)·F·(1/m₀ + 4/m½ + 1/m₁)
        const k = (1 / m0 + 4 / (0.5 * (m0 + m1)) + 1 / m1) / 6;
        const f = mean.f, J = v3(f.x * mean.T * k, f.y * mean.T * k, f.z * mean.T * k);
        if (len(J) > 0) {
          worstMag = Math.max(worstMag, rel(len(dvp), len(J)));
          const dc = toCraft(a, dvp);
          const e = len(sub3(dc, J)) / len(J);
          if (still) expect(e).toBeLessThan(1e-9); // no rotation: the craft-axes vectors agree exactly
          else worstDir = Math.max(worstDir, e); // turning: the applied direction is the step's mean attitude
        }
        // ∫τ dt = I·Δω + ∫ω × Iω dt (trapezoid over the step)
        const w1 = a.w, gyro = (w: V3): V3 => v3(w.y * Ia.z * w.z - w.z * Ia.y * w.y, w.z * Ia.x * w.x - w.x * Ia.z * w.z, w.x * Ia.y * w.y - w.y * Ia.x * w.x);
        const g0 = gyro(wa), g1 = gyro(w1);
        const lhs = v3(mean.tau.x * mean.T, mean.tau.y * mean.T, mean.tau.z * mean.T);
        const rhs = v3(Ia.x * (w1.x - wa.x) + 0.5 * Q * (g0.x + g1.x), Ia.y * (w1.y - wa.y) + 0.5 * Q * (g0.y + g1.y), Ia.z * (w1.z - wa.z) + 0.5 * Q * (g0.z + g1.z));
        const scale = len(lhs) + Q * len(g0) + len(v3(Ia.x * (w1.x - wa.x), Ia.y * (w1.y - wa.y), Ia.z * (w1.z - wa.z)));
        if (scale > 0) worstTau = Math.max(worstTau, len(sub3(lhs, rhs)) / scale);
        steps++;
      }
    };
    phase(30, (s) => { s.rcs.x = 1; }, true); // pure +X: 34 kN × 2 of the port jets, no rotation
    phase(30, (s) => { s.rcs.x = 0; s.rcs.z = -1; }, true); // the Z jets: forward (+Z exhaust at the stern pods)
    phase(120, (s) => { s.rcs.x = 0.3; s.rcs.y = -0.5; s.rcs.z = 1; s.torque.x = 0.2; s.torque.y = 0.4; s.torque.z = -0.3; }, false);
    phase(300, (s) => { s.rcs.x = s.rcs.y = s.rcs.z = 0; s.torque.x = s.torque.y = s.torque.z = 0; s.throttle = 1; }, false); // ignition, spool
    console.log(`ledger vs dynamics over ${steps} ticks: |∫F|·k vs |Δv_A − Δv_B| ≤ ${worstMag.toExponential(2)}; direction while turning ≤ ${worstDir.toExponential(2)}; torque ≤ ${worstTau.toExponential(2)}`);
    expect(worstMag).toBeLessThan(1e-9);
    expect(worstDir).toBeLessThan(2e-3);
    expect(worstTau).toBeLessThan(1e-6);
    expect(a.engineThrust[0]).toBeGreaterThan(0.9 * 400e3);
  });

  it('the ledger is the truth in air: the RK4-weighted drag mean equals m·Δv − ∫m·g within 1e-9', () => {
    const A = lowOrbit(80e3, false), B = lowOrbit(80e3, false);
    B.ship.dragArea = 0;
    let worst = 0, dragMax = 0;
    const sync = (): void => { // B rides on A's state each tick: only the drag inside the step differs
      const a = A.ship, b = B.ship;
      b.rel = { ...a.rel }; b.relV = { ...a.relV }; b.q = { ...a.q }; b.w = { ...a.w };
    };
    for (let i = 0; i < 120; i++) {
      sync();
      const va = { ...A.ship.relV }, vb = { ...B.ship.relV }, m = craftMass(A.ship);
      advance(A.w, Q); advance(B.w, Q);
      consumeLedger(A.ship, mean);
      const dvp = toCraft(A.ship, sub3(sub3(A.ship.relV, va), sub3(B.ship.relV, vb)));
      const J = v3(mean.f.x * mean.T / m, mean.f.y * mean.T / m, mean.f.z * mean.T / m);
      worst = Math.max(worst, len(sub3(dvp, J)) / len(J));
      dragMax = Math.max(dragMax, len(mean.f) / m);
    }
    expect(A.ship.inAtmosphere).toBe(true);
    expect(len(A.ship.airVel)).toBeGreaterThan(7000);
    expect(A.ship.heatFlux).toBeGreaterThan(0);
    expect(B.ship.heatFlux).toBeCloseTo(A.ship.heatFlux, -3); // the flux is the air's, not the drag area's
    console.log(`drag ${dragMax.toExponential(3)} m/s² at 80 km; ledger vs dynamics ≤ ${worst.toExponential(2)}; heat flux ${(A.ship.heatFlux / 1e3).toFixed(1)} kW/m²`);
    expect(worst).toBeLessThan(1e-9);
  });

  it('applied ≠ commanded: a dry RCS pool turns nothing; landed the jets are off, the engines spool against the ground, and the ledger reads the ground (≈ g)', () => {
    const w = deepSpace();
    const s = wren(w, STAR, FAR, v3());
    s.rcsPropellant = 0;
    s.torque.y = 1; s.rcs.x = 1;
    advance(w, 1);
    expect(len(s.w)).toBe(0);
    expect(s.jetDuty.every((d) => d === 0)).toBe(true);
    // landed on Taper (the moon), commanding jets and a throttle below the drive's floor
    const lw = createWorld(system, { stations: false });
    const b = lw.bodies.find((x) => x.id === TAPER)!;
    const up = v3(Math.cos(0.4), 0, -Math.sin(0.4)), tail = reach(v3(0, 0, 1));
    const rr = b.radius + tail + 0.5, r = v3(up.x * rr, up.y * rr, up.z * rr), n = b.spinAxis, wv = b.spinRate;
    const L = wren(lw, TAPER, r, v3(wv * (n.y * r.z - n.z * r.y), wv * (n.z * r.x - n.x * r.z), wv * (n.x * r.y - n.y * r.x)), qFromTo(v3(0, 0, -1), up));
    for (let i = 0; i < 40 && L.landedOn === null; i++) advance(lw, 0.25);
    expect(L.landedOn).toBe(TAPER);
    advance(lw, 1);
    consumeLedger(L, mean);
    const rcs0 = L.rcsPropellant;
    L.rcs.x = 1; L.torque.z = -1; L.throttle = 0.12;
    for (let i = 0; i < 120; i++) advance(lw, 1 / 60);
    expect(L.jetDuty.every((d) => d === 0)).toBe(true);
    expect(L.rcsPropellant).toBe(rcs0);
    expect(L.engineThrust).toEqual([0, 0]); // 12 % does not light a cold drive
    consumeLedger(L, mean);
    const g = b.mu / len(L.rel) ** 2;
    console.log(`landed on Taper: the ledger's proper acceleration ${(len(mean.f) / craftMass(L)).toFixed(5)} m/s² (g ${g.toFixed(5)}), load ${L.load.toFixed(5)}`);
    expect(Math.abs(len(mean.f) / craftMass(L) / g - 1)).toBeLessThan(0.01);
    expect(Math.abs(L.load / g - 1)).toBeLessThan(0.01);
    expect(mean.T).toBeCloseTo(2, 9);
    // throttle 0.3 lights it after the 0.5 s ignition delay; the spool lifts the ship off when thrust beats weight
    L.throttle = 0.3;
    const ev: WorldEvent[] = [];
    let tLift = -1;
    for (let i = 0; i < 600 && tLift < 0; i++) { advance(lw, 1 / 60); ev.push(...drainEvents(lw)); if (L.landedOn === null) tLift = (i + 1) / 60; }
    expect(L.engineThrust[0]).toBeGreaterThan(0);
    console.log(`lift-off ${tLift.toFixed(3)} s after the throttle opened (0.5 s ignition delay, then the 0.8 s spool)`);
    expect(tLift).toBeGreaterThan(0.5);
    expect(tLift).toBeLessThan(1.5);
  });

  it('minimum throttle with hysteresis through the dynamics: never between 10 and 15 %', () => {
    const w = deepSpace();
    const s = wren(w, STAR, FAR, v3());
    const F = 400e3;
    s.throttle = 0.12; advance(w, 3);
    expect(s.engineThrust).toEqual([0, 0]);
    s.throttle = 0.5; advance(w, 6);
    expect(s.engineThrust[0] / F).toBeCloseTo(0.5, 2);
    s.throttle = 0.12; advance(w, 6); // lit: it stays lit, at the 15 % floor
    expect(s.engineThrust[0] / F).toBeCloseTo(0.15, 3);
    expect(s.engineThrust[1] / F).toBeCloseTo(0.15, 3);
    s.throttle = 0.09; advance(w, 6); // below 10 %: out, and the tail ends at exactly zero
    expect(s.engineThrust).toEqual([0, 0]);
    expect(s.engineTimer).toEqual([-1, -1]);
  });

  it('the rocket equation per pool: the RCS runs its own hydrazine dry with blowdown; the main pool is untouched', () => {
    const w = deepSpace();
    const s = wren(w, STAR, FAR, v3());
    const T = s.jetAlloc, m0 = craftMass(s), main0 = s.propellant, cap = s.rcsPropellantCapacity;
    s.rcs.x = 1;
    let t = 0;
    while (s.rcsPropellant > 0 && t < 200) { advance(w, 1); t++; }
    expect(s.rcsPropellant).toBe(0);
    expect(s.propellant).toBe(main0);
    advance(w, 5);
    expect(s.jetDuty.every((d) => d === 0)).toBe(true);
    // Δv = (F/ṁ at p₀)·∫(0.97 + 0.03·p/p₀) dm/m (Simpson); the pure +Fx column's F/ṁ at p₀ = authority/cost
    const m1 = craftMass(s), N = 20000, hh = (m0 - m1) / N;
    const f = (mm: number) => (0.97 + 0.03 / (3 - 2 * ((mm - m1) / cap))) / mm;
    let sm = f(m1) + f(m0);
    for (let i = 1; i < N; i++) sm += (i & 1 ? 4 : 2) * f(m1 + i * hh);
    const dvExp = (T.authority[0] / T.cost[0]) * (sm * hh) / 3;
    const gravity = 6.3e-5 * (t + 5); // the star's pull at FAR over the run, an upper bound
    console.log(`RCS dry after ${t} s: Δv ${s.relV.x.toFixed(4)} m/s, rocket equation with blowdown ${dvExp.toFixed(4)} m/s`);
    expect(Math.abs(s.relV.x - dvExp)).toBeLessThan(1e-3 * dvExp + gravity);
  });

  it.each([[1, 'circular'], [1.03, 'eccentric (e ≈ 0.06)']])('a settled hold sleeps one real minute at 1e4 in low orbit (%s, %s): prograde within the deadband throughout, waking on time', (boost) => {
    const { w, ship } = lowOrbit(420e3, false);
    ship.relV.x *= boost; ship.relV.y *= boost; ship.relV.z *= boost;
    const host: FlightHost = { mult: () => 1e4, targetId: null, nextBurn: () => null, targetState: () => null };
    const fc = new FlightComputer(host);
    fc.world = w; fc.ship = ship;
    fc.setHold('prograde');
    const prograde = (): number => { const f = qRotate(ship.q, v3(0, 0, -1)), v = ship.relV; return Math.acos(Math.min(1, (f.x * v.x + f.y * v.y + f.z * v.z) / len(v))); };
    // first the slew (1× control at 60 Hz), then sleep: a frame is 1/60 s real = 166.7 s of sim
    for (let i = 0; i < 60 * 120 && !fc.settled; i++) { fc.command(); advance(w, 1 / 60); }
    expect(fc.settled).toBe(true);
    const rcs0 = ship.rcsPropellant, t0 = w.t, FRAME = 1e4 / 60;
    let worst = 0, wakes = 0, ticks = 0, frames = 0;
    while (w.t - t0 < 60 * 1e4) {
      // one real frame: the controller at 60 Hz while it works; quiet, the world runs to the frame end or the wake time
      const end = Math.min(w.t + FRAME, t0 + 60 * 1e4);
      while (w.t < end - 1e-9) {
        const was = fc.settled || ship.holdWakeT !== Infinity;
        const active = fc.command();
        if (was && active) wakes++;
        if (active) { advance(w, 1 / 60); ticks++; } else advance(w, Math.min(end, ship.holdWakeT) - w.t > 1e-9 ? Math.min(end, ship.holdWakeT) - w.t : 1 / 60);
        worst = Math.max(worst, prograde());
      }
      frames++;
    }
    const used = rcs0 - ship.rcsPropellant;
    console.log(`[v×${boost}] asleep 60 real s at 1e4 (${(60 * 1e4 / 3600).toFixed(0)} h of sim, ${frames} frames): worst prograde error ${worst.toFixed(4)} rad, ${wakes} wakes (one per ${(60 * 1e4 / wakes).toFixed(0)} s), ${ticks} powered control ticks (${(ticks / wakes).toFixed(0)} per wake), ${used.toFixed(2)} kg of hydrazine (${(used / (60 * 1e4 / 3600)).toFixed(2)} kg per hour asleep)`);
    expect(worst).toBeLessThan(WAKE_ANGLE + 0.005);
    expect(prograde()).toBeLessThan(WAKE_ANGLE + 0.005);
    expect(wakes).toBeGreaterThan(0);
    expect(ticks / wakes).toBeLessThan(400); // the plan's ~120 powered steps per wake, give or take the limit cycle
    expect(used / (60 * 1e4 / 3600)).toBeLessThan(1.5); // kg per hour of sleep (the stiff law would spend ~27 kg per wake)
  });

  it('Flight Assist: no reference behind Wick or beyond 100 km, whatever is targeted', () => {
    const w = createWorld(system, { stations: true });
    const b = w.bodies.find((x) => x.id === WICK)!;
    const wheel = w.craft.find((c) => c.id === START_STATION_ID)!;
    // the Wheel's antipode, 420 km up: behind Wick
    const d = len(wheel.rel), k = -(b.radius + 420e3) / d;
    const ship = wren(w, WICK, v3(wheel.rel.x * k, wheel.rel.y * k, wheel.rel.z * k), v3());
    refreshWorld(w);
    let target: string | null = START_STATION_ID;
    const host: FlightHost = { mult: () => 1, get targetId() { return target; }, nextBurn: () => null, targetState: () => null };
    const fc = new FlightComputer(host);
    fc.world = w; fc.ship = ship;
    expect(fc.assistRef()).toBe(null);
    expect(assistVisible(ship.r, wheel.r, 1e12, w.bodies)).toBe(false); // the body is in the way, not only the range
    // 500 km from the Wheel on its own side, in clear sight: out of range
    const u = v3(wheel.rel.x / d, wheel.rel.y / d, wheel.rel.z / d);
    ship.rel = v3(wheel.rel.x + u.x * 500e3, wheel.rel.y + u.y * 500e3, wheel.rel.z + u.z * 500e3);
    refreshWorld(w);
    expect(assistVisible(ship.r, wheel.r, 1e12, w.bodies)).toBe(true);
    expect(fc.assistRef()).toBe(null);
    // 2 km off: the Wheel is the reference, targeted or not
    ship.rel = v3(wheel.rel.x + u.x * 2e3, wheel.rel.y + u.y * 2e3, wheel.rel.z + u.z * 2e3);
    refreshWorld(w);
    expect(fc.assistRef()).toBe(wheel);
    target = null;
    expect(fc.assistRef()).toBe(wheel);
  });

  it('jet edges reach the event ring; save → load mid-ignition, mid-spool, mid-tail with a pending ledger is bit-identical', () => {
    const w0 = deepSpace();
    const s0 = wren(w0, STAR, FAR, v3());
    s0.torque.z = 1;
    advance(w0, Q);
    const seen: string[] = [];
    drain(eventRing(w0), (e) => { seen.push(`${e.kind}:${e.a}`); });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((x) => x.startsWith('jetOn'))).toBe(true);
    const run = (saves: boolean): string => {
      let w = deepSpace();
      wren(w, STAR, FAR, v3());
      const fly = (n: number, f: (s: Craft) => void): void => {
        const s = w.craft.find((c) => c.id === 'player')!;
        f(s);
        for (let i = 0; i < n; i++) advance(w, Q);
      };
      fly(30, (s) => { s.throttle = 0.6; s.rcs.y = 0.4; s.torque.x = -0.3; }); // mid-ignition delay (0.25 s of 0.5)
      if (saves) w = loadWorld(saveWorld(w));
      fly(90, () => {}); // mid-spool
      if (saves) w = loadWorld(saveWorld(w));
      fly(60, (s) => { s.throttle = 0; s.rcs.y = 0; s.torque.x = 0.2; }); // mid-tail
      if (saves) w = loadWorld(saveWorld(w));
      fly(600, (s) => { s.torque.x = 0; });
      return saveWorld(w);
    };
    expect(run(true)).toBe(run(false));
  });
});
