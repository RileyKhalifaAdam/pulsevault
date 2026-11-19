// The pilot as a body inside the ship (src/world/crew.ts): felt acceleration, boots, free float, collision.
import { describe, expect, it } from 'vitest';
import type { V3 } from '../src/core/types';
import { INTERIORS } from '../src/data/interiors';
import { SHIP_LAYOUTS } from '../src/data/shipLayouts';
import { computeStats, defaultLoadout } from '../src/sim/ships';
import { generateGalaxy, getSystem } from '../src/sim/universe';
import {
  addCraft, advance, BOOT_HOLD, circularState, craftMass, craftMotion, createCrew, createShipMotion, createWorld, CREW_COM, CREW_RADIUS,
  crewFelt, crewInside, feltAt, findPrompt, pushOffCrew, roomAt, shipDef, sitCrew, standCrew, stepCrew,
  type CrewInput, type CrewState, type ShipMotion,
} from '../src/world';

const system = getSystem(generateGalaxy(1), 'tallow')!;
const stats = computeStats(defaultLoadout('wren'));
const L = INTERIORS.wren!;
const STILL: CrewInput = { moveX: 0, moveZ: 0 };
const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);

function orbit() {
  const w = createWorld(system, { stations: false });
  const b = w.bodies.find((x) => x.id === 'tallow.wick')!;
  const s = circularState(b.mu, b.radius + 420e3, 0.3);
  const ship = addCraft(w, shipDef('player', 'Wren', stats, SHIP_LAYOUTS.wren, { primaryId: b.id, r: s.r, v: s.v }));
  return { w, ship };
}
const room = (s: CrewState): string => roomAt(L, s.pos.x, s.pos.y + CREW_COM, s.pos.z)?.id ?? '';
/** Step at a frame rate, checking every frame that the body is inside the walkable volume. */
function run(s: CrewState, m: ShipMotion, input: CrewInput, seconds: number, hz: number): void {
  const n = Math.round(seconds * hz);
  for (let i = 0; i < n; i++) {
    stepCrew(s, L, m, input, 1 / hz);
    if (!crewInside(L, s)) throw new Error(`left the walkable volume at ${JSON.stringify(s.pos)}`);
  }
}
/** Walk in boots toward ship-local waypoints (yaw 0: forward = -Z, right = +X). */
function walk(s: CrewState, m: ShipMotion, points: [number, number][], hz: number): void {
  const input: CrewInput = { moveX: 0, moveZ: 0 };
  for (const [x, z] of points) {
    let t = 0;
    for (; t < 20 * hz; t++) {
      const dx = x - s.pos.x, dz = z - s.pos.z, d = Math.hypot(dx, dz);
      if (d < 0.06) break;
      const k = Math.min(0.8, d * 3) / d;
      input.moveX = dx * k; input.moveZ = -dz * k;
      stepCrew(s, L, m, input, 1 / hz);
      if (!crewInside(L, s)) throw new Error(`left the walkable volume at ${JSON.stringify(s.pos)}`);
      expect(s.gripped).toBe(true);
    }
    expect(t, `waypoint ${x},${z} reached (at ${s.pos.x.toFixed(2)},${s.pos.z.toFixed(2)})`).toBeLessThan(20 * hz);
  }
}
const ROUTE: [number, number][] = [[0, -3.2], [0, -2.0], [0, 1.6], [0, 3.05], [0.73, 3.05]];

describe('the pilot as a body in the ship', () => {
  it('free fall: nothing is felt, a floating body keeps its velocity, and a gripped one stays put', () => {
    const { w, ship } = orbit();
    advance(w, 30);
    const m = craftMotion(w, ship, createShipMotion());
    const s = createCrew(L, ship.id);
    expect(len(crewFelt(s, m, v3()))).toBe(0);
    run(s, m, STILL, 5, 60);
    expect(s.gripped).toBe(true);
    expect(s.pos).toEqual(L.spawn.pos);
    // loose in the cabin, drifting aft and to starboard
    s.boots = false;
    s.pos = v3(-0.4, -0.5, -2.0);
    s.vel = v3(0.1, 0, 0.3);
    run(s, m, STILL, 3, 60);
    expect(s.posture).toBe('floating');
    expect(s.vel).toEqual(v3(0.1, 0, 0.3));
    expect(s.pos.x).toBeCloseTo(-0.1, 9);
    expect(s.pos.z).toBeCloseTo(-1.1, 9);
  });

  it('full throttle: the felt acceleration is the ship\'s, toward the stern, and a loose body ends against the aft bulkhead', () => {
    const { w, ship } = orbit();
    ship.throttle = 1;
    advance(w, 1 / 60);
    const m = craftMotion(w, ship, createShipMotion());
    const a = ship.mainThrust / craftMass(ship);
    expect(a).toBeGreaterThan(8);
    const f = feltAt(m, 0, 0, 0, 0, 0, 0, v3());
    expect(Math.abs(f.x)).toBe(0);
    expect(Math.abs(f.y)).toBe(0);
    expect(f.z).toBeCloseTo(a, 9);
    for (const hz of [60, 20]) {
      const s = createCrew(L, ship.id);
      s.boots = false;
      s.pos.y += 0.1;
      run(s, m, STILL, 4, hz);
      expect(room(s)).toBe('cockpit');
      expect(s.pos.z).toBeGreaterThan(-2.6 - CREW_RADIUS - 0.03);
      expect(s.pos.z).toBeLessThan(-2.6 - CREW_RADIUS + 1e-6);
      expect(len(s.vel)).toBeLessThan(0.3);
    }
  });

  it('boots hold under a gentle RCS push and fail under main thrust', () => {
    const { w, ship } = orbit();
    const m = createShipMotion();
    ship.rcs.x = 1;
    const rcs = ship.rcsThrust / craftMass(ship);
    expect(rcs).toBeLessThan(BOOT_HOLD);
    craftMotion(w, ship, m);
    const s = createCrew(L, ship.id);
    expect(crewFelt(s, m, v3()).x).toBeCloseTo(-rcs, 9);
    run(s, m, STILL, 3, 60);
    expect(s.gripped).toBe(true);
    expect(s.pos).toEqual(L.spawn.pos);
    // without boots the same push carries the body to the port wall
    const loose = createCrew(L, ship.id);
    loose.boots = false;
    run(loose, m, STILL, 6, 60);
    expect(loose.pos.x).toBeLessThan(-0.9);
    // main drive: the boots let go and the body goes aft
    ship.rcs.x = 0;
    ship.throttle = 1;
    craftMotion(w, ship, m);
    run(s, m, STILL, 2, 60);
    expect(s.gripped).toBe(false);
    expect(s.pos.z).toBeGreaterThan(-3.0);
    // drive off: the boots take hold again where the body lies
    ship.throttle = 0;
    craftMotion(w, ship, m);
    run(s, m, STILL, 2, 60);
    expect(s.gripped).toBe(true);
  });

  it('walks in boots from the spawn point through the cockpit door, the cabin and the corridor into the bunk room', () => {
    const { w, ship } = orbit();
    const m = craftMotion(w, ship, createShipMotion());
    for (const hz of [60, 20]) {
      const s = createCrew(L, ship.id);
      walk(s, m, ROUTE, hz);
      expect(room(s)).toBe('bunks');
      expect(findPrompt(s, L)?.kind).toBe('bunk');
      sitCrew(s, L, 'bunk');
      expect(s.posture).toBe('lying');
      standCrew(s);
      expect(room(s)).toBe('bunks');
    }
    // straight at a wall beside the door: it stops the body; the door frame lets it through and slides it in
    const s = createCrew(L, ship.id);
    run(s, m, { moveX: 0, moveZ: -1 }, 4, 60);
    expect(room(s)).toBe('cockpit');
    s.pos.x = -0.35;
    run(s, m, { moveX: 0, moveZ: -1 }, 1.2, 60);
    expect(room(s)).toBe('cabin');
    expect(s.yaw).toBe(0);
    expect(findPrompt(createCrew(L, ship.id), L)?.kind).toBe('helm');
  });

  it('a spinning ship: centrifugal acceleration at a known offset, Coriolis on a moving body, Euler under torque', () => {
    const m = createShipMotion();
    m.w.y = 0.5;
    const f = feltAt(m, 0, 0, -4, 0, 0, 0, v3());
    expect(f.x).toBeCloseTo(0, 12);
    expect(f.y).toBeCloseTo(0, 12);
    expect(f.z).toBeCloseTo(-0.25 * 4, 12); // ω² r, away from the axis
    const c = feltAt(m, 0, 0, 0, 1, 0, 0, v3()); // -2 ω × v
    expect(c.z).toBeCloseTo(1, 12);
    expect(c.x).toBeCloseTo(0, 12);
    m.w.y = 0;
    m.alpha.y = 0.2;
    const e = feltAt(m, 0, 0, -4, 0, 0, 0, v3()); // -α × r
    expect(e.x).toBeCloseTo(0.8, 12);
    // from a real craft: yaw torque gives α = τ / I about +Y
    const { w, ship } = orbit();
    ship.torque.y = 1;
    const cm = craftMotion(w, ship, createShipMotion());
    expect(cm.alpha.y).toBeCloseTo(ship.maxTorque.y / (craftMass(ship) * ship.gyration.y), 9);
    // a tumbling ship throws a loose body outward, and it still stays aboard
    const spin = createShipMotion();
    spin.w.x = 1.2; spin.w.y = 0.7;
    const s = createCrew(L, 'player');
    s.boots = false;
    run(s, spin, STILL, 20, 20);
  });

  it('pushing off floats across the cabin and bounces off the far bulkhead', () => {
    const m = createShipMotion();
    const s = createCrew(L, 'player');
    s.pos = v3(0, -0.75, -2.2);
    s.boots = false;
    s.yaw = Math.PI; // facing aft
    stepCrew(s, L, m, STILL, 1 / 60);
    expect(s.posture).toBe('floating');
    expect(pushOffCrew(s, L)).toBe(true);
    expect(s.vel.z).toBeCloseTo(1.2, 9);
    s.pos.x = 1.2; // aim past the door, at the bulkhead
    s.pos.z = 0.6;
    let bounced = false, zMax = -9;
    for (let i = 0; i < 60 * 4 && !bounced; i++) {
      run(s, m, STILL, 1 / 60, 60);
      zMax = Math.max(zMax, s.pos.z);
      bounced = s.vel.z < 0;
    }
    expect(bounced).toBe(true);
    expect(zMax).toBeGreaterThan(1.9 - CREW_RADIUS - 0.05);
    expect(s.vel.z).toBeCloseTo(-1.2 * 0.3, 6);
    expect(room(s)).toBe('cabin');
    // a jump in boots: up to the overhead, back to the deck, gripped again
    const j = createCrew(L, 'player');
    expect(pushOffCrew(j, L)).toBe(true);
    stepCrew(j, L, m, STILL, 1 / 60);
    expect(j.gripped).toBe(false);
    run(j, m, STILL, 3, 60);
    expect(j.gripped).toBe(true);
    expect(j.pos.y).toBe(-0.75);
  });

  it('nothing tunnels: a body thrown hard in every direction stays inside at 60 Hz and at 20 Hz', () => {
    const m = createShipMotion();
    for (const hz of [60, 20]) {
      for (let k = 0; k < 24; k++) {
        const s = createCrew(L, 'player');
        s.boots = false;
        s.pos = v3(0, -0.4, k % 2 ? 0 : 6);
        const a = (k * Math.PI) / 12;
        s.vel = v3(Math.cos(a) * 14, ((k % 5) - 2) * 3, Math.sin(a) * 14);
        m.a.z = k % 3 === 0 ? -12 : 0;
        run(s, m, STILL, 6, hz);
      }
    }
  });

  it('state is plain JSON: a save/load round trip continues identically', () => {
    const m = createShipMotion();
    m.w.z = 0.3;
    const s = createCrew(L, 'player');
    walk(s, m, [[0, -3.2], [0, -2.0]], 60);
    s.boots = false;
    pushOffCrew(s, L);
    run(s, m, STILL, 1.5, 60);
    const t = JSON.parse(JSON.stringify(s)) as CrewState;
    expect(t).toEqual(s);
    run(s, m, { moveX: 0.3, moveZ: 1 }, 5, 60);
    run(t, m, { moveX: 0.3, moveZ: 1 }, 5, 60);
    expect(t).toEqual(s);
  });
});
