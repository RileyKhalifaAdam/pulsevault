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

  it('a 60 s burn gives the delta-v of the rocket equation', () => {
    const w = deepSpace();
    const ship = wren(w, STAR, FAR, v3());
    const m0 = craftMass(ship);
    ship.throttle = 1;
    const r = advance(w, 60);
    expect(r.simDt).toBe(60);
    const m1 = craftMass(ship);
    expect(m0 - m1).toBeCloseTo((stats.mainThrust / stats.exhaustVelocity) * 60, 6);
    const dv = len(ship.relV), want = stats.exhaustVelocity * Math.log(m0 / m1);
    console.log(`rocket equation: flown ${dv.toFixed(4)} m/s, ideal ${want.toFixed(4)} m/s (${r.steps} steps)`);
    expect(Math.abs(dv / want - 1)).toBeLessThan(1e-3);
    expect(-ship.relV.z / dv).toBeGreaterThan(0.999999);
    // Running dry stops the thrust.
    advance(w, 2000);
    expect(ship.propellant).toBe(0);
    const v1 = len(ship.relV);
    expect(Math.abs(v1 / (stats.exhaustVelocity * Math.log(m0 / stats.dryMass)) - 1)).toBeLessThan(1e-3);
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

  it('the hold controller turns 90° with real torque and settles without overshoot', () => {
    const w = deepSpace();
    const ship = wren(w, STAR, FAR, v3());
    const dir = v3(1, 0, 0), e = v3(), I = v3();
    let reached = -1, rebound = 0, ang = 0, peakRate = 0;
    for (let k = 0; k < 60 * 15; k++) {
      ang = len(pointingError(ship.q, dir, e));
      if (k === 0) expect(ang).toBeCloseTo(Math.PI / 2, 9);
      if (reached < 0 && ang < 0.02) reached = k / 60;
      if (reached >= 0) rebound = Math.max(rebound, ang);
      holdTorque(e, ship.w, craftInertia(ship, I), ship.maxTorque, ship.torque);
      advance(w, 1 / 60);
      peakRate = Math.max(peakRate, len(ship.w));
    }
    console.log(`hold: 90° reached in ${reached.toFixed(2)} s, peak rate ${peakRate.toFixed(3)} rad/s, final error ${ang.toExponential(2)} rad, rate ${len(ship.w).toExponential(2)} rad/s`);
    expect(reached).toBeGreaterThan(0);
    expect(reached).toBeLessThan(10);
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
    expect(vnAfter / 3).toBeCloseTo(RESTITUTION, 2);
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
    ship.throttle = 0.01;
    r = advance(w, 1000, { budgetMs: 3, now });
    expect(r.simDt).toBeLessThan(1000);
    expect(r.limitedBy).toBe('thrust');
    ship.throttle = 0;
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
});
