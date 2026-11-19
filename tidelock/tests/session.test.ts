// The session on the physical world (src/game/session.ts): what the client flies. Everything here goes through
// the Session contract only — setControls, setHold, setWarp, the views and the events — and, in the last block,
// through the pilot's hand on the physical controls alone.

import { describe, expect, it } from 'vitest';
import type { Quat, V3 } from '../src/core/types';
import { SHIP_LAYOUTS } from '../src/data/shipLayouts';
import { STATION_LAYOUTS } from '../src/data/stationLayouts';
import { START_STATION_ID } from '../src/data/systems/layout';
import { createSession, loadSession, type Session } from '../src/game';
import { START_CLEARANCE } from '../src/game/session';
import { computeStats, defaultLoadout } from '../src/sim/ships';
import { DOCK_ANGLE, DOCK_DISTANCE, DOCK_SPEED, qRotInv } from '../src/world';

const STATS = computeStats(defaultLoadout('wren'));
const WHEEL_RADIUS = STATION_LAYOUTS.ringHabitat.radius;
const START_DISTANCE = WHEEL_RADIUS + SHIP_LAYOUTS.wren.radius + START_CLEARANCE;
const FREE = { budgetMs: 1e9 }; // no CPU limit: these tests are about the motion

const run = (s: Session, seconds: number, dt = 1 / 60): void => {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) s.step(dt);
};
const me = (s: Session) => s.craft().find((c) => c.isPlayer)!;
const nose = (q: Quat): V3 => ({ x: -2 * (q.x * q.z + q.w * q.y), y: -2 * (q.y * q.z - q.w * q.x), z: -(1 - 2 * (q.x * q.x + q.y * q.y)) });
/** Velocity of the player relative to the primary body. */
const relVel = (s: Session): V3 => {
  const c = me(s), b = s.bodies().find((x) => x.id === s.flight().primaryId)!;
  return { x: c.v.x - b.v.x, y: c.v.y - b.v.y, z: c.v.z - b.v.z };
};
const angle = (a: V3, b: V3): number => Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / (Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z)))));
const progradeError = (s: Session): number => angle(nose(me(s).q), relVel(s));
/** Fly until the nose is on prograde and the controller has gone quiet (the craft view shows no torque, so use rate). */
const settleOn = (s: Session, err: () => number, limit = 90): number => {
  let t = 0;
  for (; t < limit; t += 0.5) {
    run(s, 0.5);
    if (err() < 0.004 && s.player().spin < 0.01) break;
  }
  return t;
};
const snapshot = (s: Session) => {
  const c = me(s), p = s.player();
  return { t: s.time(), r: { ...c.r }, v: { ...c.v }, q: { ...c.q }, propellant: p.propellant, hold: p.hold, target: s.target()?.id ?? null, burns: s.burns().map((b) => ({ ...b })) };
};

describe('session on the physical world', () => {
  it('starts beside Chandler\'s Wheel, at rest relative to it, and stays there for ten minutes of coasting', () => {
    const s = createSession(FREE);
    const d = s.docking();
    expect(d.stationId).toBe(START_STATION_ID);
    expect(s.craft().some((c) => c.id === START_STATION_ID && c.kind === 'station')).toBe(true);
    expect(s.system.stations.map((x) => x.id).sort()).toEqual(s.craft().filter((c) => c.kind === 'station').map((c) => c.id).sort());
    expect(Math.abs(d.distance - START_DISTANCE)).toBeLessThan(0.01);
    expect(d.distance - WHEEL_RADIUS - SHIP_LAYOUTS.wren.radius).toBeCloseTo(200, 1); // hull clear of the Wheel's sphere
    // Same orbit, a little ahead: no closing speed; in inertial axes the pair turns about each other once per orbit.
    expect(Math.abs(s.target()!.closing)).toBeLessThan(1e-3);
    expect(d.relSpeed).toBeCloseTo(((2 * Math.PI) / s.flight().period) * d.distance, 3);
    expect(d.dockedTo).toBe(null);
    const p = s.player();
    expect(p.propellantFraction).toBe(1);
    expect(p.mass).toBeCloseTo(STATS.dryMass + STATS.fuelCapacity, 6);
    expect(s.flight().situation).toBe('orbit');
    expect(s.flight().primaryName).toBe('Wick');
    expect(s.target()?.id).toBe(START_STATION_ID);
    let worst = 0;
    for (let i = 0; i < 60; i++) {
      run(s, 10, 0.05);
      worst = Math.max(worst, Math.abs(s.docking().distance - START_DISTANCE));
    }
    expect(s.time()).toBeCloseTo(600, 3);
    expect(worst).toBeLessThan(3);
    expect(Math.abs(s.target()!.closing)).toBeLessThan(0.05);
    expect(s.player().propellantFraction).toBe(1);
    expect(s.warp().achieved).toBeCloseTo(1, 6);
  });

  it('a 20 s prograde burn raises the apoapsis as vis-viva says; the hold then goes quiet and 1000x is granted', () => {
    const s = createSession(FREE);
    s.setHold('prograde');
    const tTurn = settleOn(s, () => progradeError(s));
    expect(tTurn).toBeLessThan(60);
    expect(progradeError(s)).toBeLessThan(0.004);

    const f0 = s.flight();
    const body = s.bodies().find((b) => b.id === f0.primaryId)!.def;
    const r0 = f0.altitude + body.radius, v0 = f0.speed, apo0 = f0.apoapsisAlt, m0 = s.player().mass;
    s.setControls({ throttle: 1 });
    run(s, 20);
    s.setControls({ throttle: 0 });
    run(s, 0.1);
    // Rocket equation for the propellant that went, vis-viva for the orbit it buys.
    const m1 = m0 - (STATS.mainThrust / STATS.exhaustVelocity) * 20;
    const dv = STATS.exhaustVelocity * Math.log(m0 / m1);
    const a = 1 / (2 / r0 - ((v0 + dv) * (v0 + dv)) / body.mu);
    const expected = 2 * a - r0 - body.radius - apo0;
    const f1 = s.flight();
    const rise = f1.apoapsisAlt - apo0;
    expect(expected).toBeGreaterThan(100e3);
    expect(Math.abs(rise / expected - 1)).toBeLessThan(0.02);
    expect(s.player().mass).toBeCloseTo(m1, 0);
    expect(progradeError(s)).toBeLessThan(0.05);

    // Converged hold: no torque demand, so nothing holds time acceleration down.
    settleOn(s, () => progradeError(s), 30);
    s.setWarp(1000);
    expect(s.warp().requested).toBe(1000);
    run(s, 2);
    // a torquing ship is stepped at 1/60 s (a thousand steps for this frame); a quiet one takes a handful
    expect(s.step(1 / 60).steps).toBeLessThan(200);
    const w = s.warp();
    expect(w.achieved).toBeGreaterThan(990);
    expect(w.limitedBy).toBe('');
    // …the nose stays near prograde round the orbit (loosely, under time acceleration)…
    run(s, 2);
    expect(s.time()).toBeGreaterThan(3900);
    expect(progradeError(s)).toBeLessThan(0.35);
    s.warpDown();
    expect(s.warp().requested).toBe(100);
    s.setWarp(1);
    run(s, 1);
    expect(s.warp().achieved).toBeCloseTo(1, 6);
    // …and is brought back onto it with real torque once time runs at 1x again.
    run(s, 20);
    expect(progradeError(s)).toBeLessThan(0.01);
  });

  it('one simulated day at 100 000x leaves the orbit as it was', () => {
    const s = createSession(FREE);
    const f0 = { ...s.flight() };
    const R = s.bodies().find((b) => b.id === f0.primaryId)!.def.radius;
    const a0 = (f0.apoapsisAlt + f0.periapsisAlt) / 2 + R;
    s.setWarp(1e5);
    let frames = 0;
    while (s.time() < 86400 && frames < 500) { s.step(1 / 60); frames++; }
    expect(frames).toBeLessThan(60);
    expect(s.warp().achieved).toBeGreaterThan(9.9e4);
    const f1 = s.flight();
    const a1 = (f1.apoapsisAlt + f1.periapsisAlt) / 2 + R;
    expect(Math.abs(a1 / a0 - 1)).toBeLessThan(1e-3);
    expect(Math.abs(f1.period / f0.period - 1)).toBeLessThan(1e-3);
    expect(Math.abs(f1.altitude / f0.altitude - 1)).toBeLessThan(1e-2);
    expect(f1.eccentricity).toBeLessThan(1e-3);
    expect(f1.situation).toBe('orbit');
    // still beside the station it shares the orbit with
    expect(Math.abs(s.docking().distance - START_DISTANCE)).toBeLessThan(100);
  });

  it('a hand-flown approach (RCS translate + dock hold) latches at a port; undock separates', () => {
    const s = createSession(FREE);
    const log: string[] = [];
    let dockedAt = { stationId: '', portId: '' };
    s.events.on('docked', (e) => { log.push('docked'); dockedAt = e; });
    s.events.on('undocked', () => log.push('undocked'));
    s.events.on('impact', () => log.push('impact'));
    s.setHold('dock');
    const aRcs = STATS.rcsThrust / (STATS.dryMass + STATS.fuelCapacity);
    const STANDOFF = 150, dt = 1 / 30;
    const tr = { x: 0, y: 0, z: 0 }, loc = { x: 0, y: 0, z: 0 };
    let phase = 0, last = { portDistance: Infinity, alignment: Math.PI, relSpeed: 99, lateral: 99 }, tDock = -1;
    for (let i = 0; i < 1200 / dt; i++) {
      const d = s.docking();
      if (d.dockedTo !== null) { tDock = s.time(); break; }
      expect(d.portId).not.toBe(null);
      last = { portDistance: d.portDistance, alignment: d.alignment, relSpeed: d.relSpeed, lateral: d.lateral };
      const c = me(s), st = s.craft().find((x) => x.id === d.stationId)!;
      const A = d.portAxis;
      // ship relative to the mating point, velocity relative to the station (world axes)
      const px = -d.portOffset.x, py = -d.portOffset.y, pz = -d.portOffset.z;
      const vx = c.v.x - st.v.x, vy = c.v.y - st.v.y, vz = c.v.z - st.v.z;
      const along = px * A.x + py * A.y + pz * A.z;
      const lx = px - along * A.x, ly = py - along * A.y, lz = pz - along * A.z;
      const lat = Math.hypot(lx, ly, lz);
      let wx: number, wy: number, wz: number; // wanted velocity
      if (phase === 0) {
        // to a point out on the port axis, braking on a square-root curve
        const gx = A.x * STANDOFF - px, gy = A.y * STANDOFF - py, gz = A.z * STANDOFF - pz;
        const g = Math.hypot(gx, gy, gz);
        const sp = Math.min(8, 0.25 * g, Math.sqrt(2 * 0.4 * aRcs * g));
        wx = (gx / g) * sp; wy = (gy / g) * sp; wz = (gz / g) * sp;
        if (g < 8 && Math.hypot(vx, vy, vz) < 0.6) phase = 1;
      } else {
        // down the axis: centre first, then close slowly
        const close = lat < 2.5 ? Math.max(0.4, Math.min(2.5, 0.05 * along)) : 0;
        const k = Math.min(0.25, 1.2 / Math.max(lat, 1e-6));
        wx = -lx * k - A.x * close; wy = -ly * k - A.y * close; wz = -lz * k - A.z * close;
      }
      const K = 1.5 / aRcs; // full thrust for a velocity error of aRcs / 1.5
      qRotInv(loc, c.q, (wx - vx) * K, (wy - vy) * K, (wz - vz) * K);
      tr.x = Math.max(-1, Math.min(1, loc.x)); tr.y = Math.max(-1, Math.min(1, loc.y)); tr.z = Math.max(-1, Math.min(1, loc.z));
      s.setControls({ translate: tr });
      s.step(dt);
    }
    s.setControls({ translate: { x: 0, y: 0, z: 0 } });
    expect(tDock).toBeGreaterThan(0);
    expect(log).toEqual(['docked']);
    // inside the latch tolerances on the frame before the latch closed
    expect(last.portDistance).toBeLessThan(DOCK_DISTANCE + 0.5);
    expect(last.alignment).toBeLessThan(DOCK_ANGLE);
    expect(last.relSpeed).toBeLessThan(DOCK_SPEED);
    expect(dockedAt.stationId).toBe(START_STATION_ID);
    expect(STATION_LAYOUTS.ringHabitat.ports.some((p) => p.id === dockedAt.portId)).toBe(true);
    // the 32 m Wren needs a medium pad: it latched at an M or L port, never at a small one
    expect(STATION_LAYOUTS.ringHabitat.ports.find((p) => p.id === dockedAt.portId)!.size).not.toBe('S');
    expect(s.player().dockedTo).toBe(START_STATION_ID);
    expect(s.flight().situation).toBe('docked');
    expect(me(s).dockedTo).toBe(START_STATION_ID);
    expect(s.player().hull).toBe(1);
    // Latched: drive and RCS are interlocked, and being docked never limits time acceleration.
    const prop = s.player().propellant;
    s.setControls({ throttle: 1 });
    s.setWarp(1000);
    run(s, 1);
    expect(s.player().propellant).toBe(prop);
    expect(s.warp().achieved).toBeGreaterThan(990);
    expect(s.warp().limitedBy).toBe('');
    expect(s.player().dockedTo).toBe(START_STATION_ID);
    s.setWarp(1);
    s.setControls({ throttle: 0 });
    // Undock: the spring pushes the ship off along the port axis and the latch does not grab it back.
    expect(s.undock()).toBe(true);
    expect(s.undock()).toBe(false);
    expect(log).toEqual(['docked', 'undocked']);
    s.setHold('stability');
    run(s, 30);
    const d = s.docking();
    expect(d.dockedTo).toBe(null);
    expect(s.player().dockedTo).toBe(null);
    expect(d.portDistance).toBeGreaterThan(20);
    expect(d.closing).toBeLessThan(-0.5);
    expect(log).toEqual(['docked', 'undocked']);
    expect(SHIP_LAYOUTS.wren.dockingPort).toBeTruthy();
  });

  it('save -> load gives the same state and the same future; reset() restores the start', () => {
    const s = createSession(FREE);
    const start = snapshot(s);
    s.setHold('retrograde');
    s.setControls({ throttle: 0.5 });
    run(s, 6);
    s.setControls({ throttle: 0 });
    s.setTarget(s.system.bodies[1].id);
    const id = s.addBurn(s.time() + 600, { prograde: 12, radial: -3 });
    s.updateBurn(id, { normal: 4 });
    run(s, 3);
    const json = s.save();
    expect(json.length).toBeLessThan(100e3);
    const l = loadSession(json, FREE);
    expect(l).not.toBe(null);
    expect(snapshot(l!)).toEqual(snapshot(s));
    expect(l!.burns()).toEqual([{ id, t: s.burns()[0].t, prograde: 12, normal: 4, radial: -3 }]);
    run(s, 5);
    run(l!, 5);
    expect(snapshot(l!)).toEqual(snapshot(s));
    expect(loadSession('not a save')).toBe(null);
    expect(loadSession('{"tidelock":1}')).toBe(null);

    // The prediction of the saved flight covers the planned burn.
    const p = l!.prediction();
    expect(p.count).toBeGreaterThan(50);
    expect(p.events.some((e) => e.kind === 'burn')).toBe(true);
    expect(p.frameBodyId).toBe(l!.flight().primaryId);
    l!.removeBurn(id);
    expect(l!.prediction().events.some((e) => e.kind === 'burn')).toBe(false);

    let resets = 0;
    s.events.on('reset', () => resets++);
    s.reset();
    expect(resets).toBe(1);
    expect(snapshot(s)).toEqual(start);
    expect(s.player().propellantFraction).toBe(1);
    expect(Math.abs(s.docking().distance - START_DISTANCE)).toBeLessThan(0.01);
    expect(snapshot(createSession(FREE))).toEqual(start);
  });
});


describe('the pilot, hands on the physical controls', () => {
  /** Walk toward ship-local waypoints, steering by the body's own yaw. */
  const walkTo = (s: Session, points: [number, number][]): void => {
    for (const [x, z] of points) {
      let n = 0;
      for (; n < 1500; n++) {
        const c = s.crew();
        const dx = x - c.pos.x, dz = z - c.pos.z, d = Math.hypot(dx, dz);
        if (d < 0.06) break;
        const k = Math.min(0.8, d * 3) / d, cy = Math.cos(c.yaw), sy = Math.sin(c.yaw);
        s.setWalk({ moveX: (cy * dx - sy * dz) * k, moveZ: (-sy * dx - cy * dz) * k });
        s.step(1 / 60);
      }
      expect(n, `waypoint ${x},${z}`).toBeLessThan(1500);
    }
    s.setWalk({ moveX: 0, moveZ: 0 });
  };
  /** Device id by what it is wired to (positions and ids belong to the cockpit data). */
  const idOf = (s: Session, role: string): string => s.cockpit()!.devices.find((d) => d.role === role)!.id;
  const dev = (s: Session, role: string) => { const id = idOf(s, role); return s.devices().find((d) => d.id === id)!; };
  const tap = (s: Session, role: string): void => {
    expect(s.tapDevice(idOf(s, role)), `tap ${role}`).toBe(true);
    run(s, 0.3);
  };
  const litHolds = (s: Session): string[] => s.cockpit()!.devices.filter((d) => d.role.startsWith('hold') && dev(s, d.role).lit).map((d) => d.role);
  const strapIn = (s: Session): void => {
    run(s, 0.2);
    tap(s, 'harness');
    expect(s.mode()).toBe('helm');
  };

  it('starts on foot beside the pilot seat, drive safe, hold on HOLD; the seat controls are out of reach until strapped in', () => {
    const s = createSession(FREE);
    const modes: string[] = [];
    s.events.on('crewMode', (e) => modes.push(e.mode));
    expect(s.mode()).toBe('onFoot');
    expect(s.interior()?.shipId).toBe('wren');
    expect(s.cockpit()?.shipId).toBe('wren');
    expect(s.devices().length).toBe(s.cockpit()!.devices.length);
    run(s, 0.3);
    let c = s.crew();
    expect(c.roomId).toBe('cockpit');
    expect(c.posture).toBe('walking');
    expect(c.gripped).toBe(true);
    expect(s.player().hold).toBe('stability');
    expect(litHolds(s)).toEqual(['holdStability']);
    expect(dev(s, 'driveArm').lit).toBe(false);
    expect(dev(s, 'harness').lit).toBe(false);
    expect(dev(s, 'cabinLights').lit).toBe(true);
    // out of reach from the deck: nothing happens
    for (const role of ['throttle', 'rotation', 'driveArm', 'holdPrograde']) expect(dev(s, role).reachable, role).toBe(false);
    expect(s.grabDevice(idOf(s, 'throttle'), 1)).toBe(false);
    expect(s.tapDevice(idOf(s, 'driveArm'))).toBe(false);
    expect(s.tapDevice(idOf(s, 'holdPrograde'))).toBe(false);
    run(s, 0.5);
    expect(s.player().hold).toBe('stability');
    expect(s.tapDevice('no-such-device')).toBe(false);
    // the harness is within reach of the hand
    expect(dev(s, 'harness').reachable).toBe(true);
    strapIn(s);
    expect(modes).toEqual(['helm']);
    c = s.crew();
    expect(c.posture).toBe('seated');
    expect(c.eye).toEqual(s.interior()!.helmEye);
    expect(dev(s, 'harness').lit).toBe(true);
    for (const d of s.cockpit()!.devices) if (d.reach === 'pilotSeat') expect(dev(s, d.role).reachable, d.id).toBe(true);
    // the head turns in the seat, within limits
    s.addLook(0.4, -0.2);
    expect(s.crew().yaw).toBeCloseTo(0.4, 9);
    expect(s.crew().pitch).toBeCloseTo(-0.2, 9);
    s.addLook(10, 10);
    expect(s.crew().yaw).toBeLessThan(2.5);
    expect(s.crew().pitch).toBeLessThan(1.3);
    // screens page; TARGET steps on from the Wheel
    const nav = s.cockpit()!.devices.find((d) => d.kind === 'screen' && (d.pages?.length ?? 0) > 1)!;
    const page = (): string => s.devices().find((d) => d.id === nav.id)!.page;
    expect(page()).toBe(nav.pages![0]);
    expect(s.tapDevice(nav.id)).toBe(true);
    expect(page()).toBe(nav.pages![1]);
    expect(s.target()?.id).toBe(START_STATION_ID);
    tap(s, 'targetNext');
    const t1 = s.target()?.id;
    expect(t1).toBeDefined();
    expect(t1).not.toBe(START_STATION_ID);
    // LATCH RELEASE with nothing latched does nothing
    tap(s, 'undock');
    expect(s.player().dockedTo).toBe(null);
  });

  it('PRO lamp, DRIVE ARM and the throttle lever: a 20 s burn raises the apoapsis as vis-viva says; safe, the lever does nothing', () => {
    const s = createSession(FREE);
    strapIn(s);
    tap(s, 'holdPrograde');
    expect(s.player().hold).toBe('prograde');
    expect(litHolds(s)).toEqual(['holdPrograde']);
    expect(settleOn(s, () => progradeError(s))).toBeLessThan(60);
    expect(progradeError(s)).toBeLessThan(0.004);

    // drive safe: the lever moves, the valves stay shut
    const lever = idOf(s, 'throttle');
    const m0 = s.player().mass;
    expect(s.grabDevice(lever, 7)).toBe(true);
    expect(s.grabDevice(lever, 8)).toBe(false); // one hand to a control
    s.moveDevice(7, 1, 0);
    run(s, 2);
    expect(dev(s, 'throttle').x).toBeCloseTo(1, 6);
    expect(dev(s, 'throttle').held).toBe(true);
    expect(s.player().throttle).toBe(0);
    expect(s.flight().accel).toBeLessThan(1e-6);
    expect(s.player().mass).toBe(m0);
    s.moveDevice(7, 0, 0);
    run(s, 1);
    s.releaseDevice(7);
    run(s, 0.2);
    expect(dev(s, 'throttle').x).toBe(0);

    // arm, push the lever forward for 20 s, pull it back
    tap(s, 'driveArm');
    expect(dev(s, 'driveArm').lit).toBe(true);
    expect(s.player().throttle).toBe(0);
    settleOn(s, () => progradeError(s), 30);
    const f0 = s.flight();
    const body = s.bodies().find((b) => b.id === f0.primaryId)!.def;
    const r0 = f0.altitude + body.radius, v0 = f0.speed, apo0 = f0.apoapsisAlt;
    expect(s.grabDevice(lever, 7)).toBe(true);
    s.moveDevice(7, 1, 0);
    run(s, 1 / 60);
    expect(s.player().throttle).toBeLessThan(0.2); // the lever has to travel
    run(s, 20 - 1 / 60);
    expect(s.player().throttle).toBe(1);
    expect(dev(s, 'throttle').lit).toBe(true);
    expect(s.crew().felt.z).toBeCloseTo(s.player().maxAccel, 4); // pressed into the seat
    s.moveDevice(7, 0, 0);
    run(s, 1);
    s.releaseDevice(7);
    expect(s.player().throttle).toBe(0);
    const m1 = m0 - (STATS.mainThrust / STATS.exhaustVelocity) * 20;
    const dv = STATS.exhaustVelocity * Math.log(m0 / m1);
    const a = 1 / (2 / r0 - ((v0 + dv) * (v0 + dv)) / body.mu);
    const expected = 2 * a - r0 - body.radius - apo0;
    const rise = s.flight().apoapsisAlt - apo0;
    expect(expected).toBeGreaterThan(100e3);
    expect(Math.abs(rise / expected - 1)).toBeLessThan(0.03);
    expect(Math.abs(s.player().mass / m1 - 1)).toBeLessThan(1e-3);

    // lever left open, drive disarmed: the valves close; re-armed, they open again
    s.grabDevice(lever, 7);
    s.moveDevice(7, 0.5, 0);
    run(s, 1);
    s.releaseDevice(7);
    run(s, 1);
    expect(s.player().throttle).toBeGreaterThan(0.4);
    expect(dev(s, 'throttle').x).toBeCloseTo(0.5, 6); // friction holds it
    // the harness is interlocked with the drive
    expect(s.tapDevice(idOf(s, 'harness'))).toBe(false);
    expect(s.mode()).toBe('helm');
    tap(s, 'driveArm');
    expect(dev(s, 'driveArm').lit).toBe(false);
    expect(s.player().throttle).toBe(0);
    expect(s.flight().accel).toBeLessThan(1e-6);
    // save / load keeps the controls where they were
    const again = loadSession(s.save(), FREE)!;
    expect(again.mode()).toBe('helm');
    expect(again.devices().map((d) => [d.id, d.x, d.lit])).toEqual(s.devices().map((d) => [d.id, d.x, d.lit]));
    expect(again.player().hold).toBe('prograde');
    // now the buckle opens
    tap(s, 'harness');
    expect(s.mode()).toBe('onFoot');
    expect(dev(s, 'harness').lit).toBe(false);
    expect(dev(s, 'throttle').reachable).toBe(false);
  });

  it('the rotation controller turns the ship with real torque and HOLD stops it when the hand lets go; RCS pushes; hold lamps are exclusive', () => {
    const s = createSession(FREE);
    strapIn(s);
    const rhc = idOf(s, 'rotation');
    const q0 = { ...me(s).q };
    const n0 = nose(q0);
    expect(s.grabDevice(rhc, 3)).toBe(true);
    s.moveDevice(3, 1, 0); // yaw right
    run(s, 4);
    expect(dev(s, 'rotation').x).toBeCloseTo(1, 2);
    expect(s.player().spin).toBeGreaterThan(0.05);
    const turned = angle(nose(me(s).q), n0);
    expect(turned).toBeGreaterThan(0.1);
    // nose went to starboard: its component along the ship's original +X axis is positive
    const local = qRotInv({ x: 0, y: 0, z: 0 }, q0, nose(me(s).q).x, nose(me(s).q).y, nose(me(s).q).z);
    expect(local.x).toBeGreaterThan(0.05);
    s.releaseDevice(3);
    run(s, 0.3);
    expect(dev(s, 'rotation').x).toBe(0); // the spring brought it back
    run(s, 30);
    expect(s.player().spin).toBeLessThan(1e-3);
    // translation controller: starboard thrusters, real acceleration, then it stops when released
    const v0 = { ...me(s).v };
    expect(s.grabDevice(idOf(s, 'translation'), 4)).toBe(true);
    s.moveDevice(4, 1, 0);
    run(s, 2);
    expect(me(s).rcs.x).toBeCloseTo(1, 2);
    expect(s.flight().accel).toBeGreaterThan(0.01);
    s.releaseDevice(4);
    run(s, 0.5);
    expect(me(s).rcs.x).toBe(0);
    expect(s.flight().accel).toBeLessThan(1e-6);
    expect(v0).toBeDefined();
    // fore/aft rocker: forward is -Z
    expect(s.grabDevice(idOf(s, 'translationZ'), 5)).toBe(true);
    s.moveDevice(5, 0, 1);
    run(s, 0.5);
    expect(me(s).rcs.z).toBe(-1);
    s.releaseDevice(5);
    run(s, 0.5);
    expect(me(s).rcs.z).toBe(0);
    // every hold lamp selects its mode, one lit at a time
    for (const d of s.cockpit()!.devices.filter((x) => x.role.startsWith('hold'))) {
      tap(s, d.role);
      expect(litHolds(s), d.id).toEqual([d.role]);
    }
    tap(s, 'holdOff');
    expect(s.player().hold).toBe('off');
  });

  it('unstrap, walk aft, switch the lights, lie in the bunk: four still seconds is sleep, an hour passes, a touch wakes', () => {
    const s = createSession(FREE);
    const sleeps: { asleep: boolean; seconds: number }[] = [];
    s.events.on('sleep', (e) => sleeps.push({ ...e }));
    strapIn(s);
    tap(s, 'harness');
    expect(s.mode()).toBe('onFoot');
    expect(s.crew().pos).toEqual(s.interior()!.spawn.pos);
    // the sofa and the bed are far away; the light switch too
    for (const role of ['bunk', 'tableSeat', 'cabinLights']) expect(dev(s, role).reachable, role).toBe(false);
    expect(s.tapDevice(idOf(s, 'bunk'))).toBe(false);
    // aft through the companionway: the switch faces into the lounge, so it is out of reach from the companionway
    walkTo(s, [[0, -12.2], [0, -11.0]]);
    expect(s.crew().roomName).toBe('Companionway');
    expect(dev(s, 'cabinLights').reachable).toBe(false);
    walkTo(s, [[0, -9.9], [-1.1, -9.9]]);
    expect(s.crew().roomName).toBe('Lounge');
    expect(dev(s, 'cabinLights').reachable).toBe(true);
    expect(s.cabinLights()).toBe(true);
    tap(s, 'cabinLights');
    expect(s.cabinLights()).toBe(false);
    expect(dev(s, 'cabinLights').lit).toBe(false);
    // the sofa under the big window: tap to sit, any walk input stands up
    walkTo(s, [[1.4, -9.0]]);
    expect(dev(s, 'bunk').reachable).toBe(false);
    tap(s, 'tableSeat');
    expect(s.crew().posture).toBe('seated');
    expect(s.crew().eye).toEqual(s.interior()!.tableEye);
    s.setWalk({ moveX: -1, moveZ: 0 });
    run(s, 0.5);
    s.setWalk({ moveX: 0, moveZ: 0 });
    run(s, 0.5);
    expect(s.crew().posture).toBe('walking');
    // down the corridor to the bed in the port cabin
    walkTo(s, [[0, -9.0], [0, -5.4], [0, -3.0], [0, -1.6]]);
    expect(s.crew().roomId).toBe('corridor');
    expect(dev(s, 'bunk').reachable).toBe(false);
    walkTo(s, [[-1.65, -1.6], [-1.65, -3.3]]);
    expect(s.crew().roomId).toBe('cabin-port');
    expect(s.crew().roomName).toBe('Port cabin');
    tap(s, 'bunk');
    let c = s.crew();
    expect(c.posture).toBe('lying');
    expect(c.eye).toEqual(s.interior()!.bunkEye);
    expect(c.asleep).toBe(false);
    run(s, 2);
    s.addLook(0.05, 0); // not still yet
    run(s, 3);
    expect(s.crew().asleep).toBe(false);
    let n = 0;
    while (!s.crew().asleep && n++ < 120) s.step(1 / 60);
    expect(s.crew().asleep).toBe(true);
    expect(s.warp().requested).toBe(1e4);
    const t1 = s.time();
    let frames = 0;
    while (s.time() - t1 < 3600 && frames < 4000) { s.step(1 / 60); frames++; }
    expect(s.time() - t1).toBeGreaterThanOrEqual(3600);
    expect(frames).toBeLessThan(200); // the world granted the sleep
    // any touch wakes: the first one does nothing else
    expect(s.tapDevice(idOf(s, 'bunk'))).toBe(true);
    expect(s.crew().asleep).toBe(false);
    expect(s.crew().posture).toBe('lying');
    expect(sleeps.length).toBe(2);
    expect(sleeps[1].seconds).toBeGreaterThanOrEqual(3600);
    const t2 = s.time();
    run(s, 1);
    expect(s.time() - t2).toBeCloseTo(1, 6);
    // saved lying down: it comes back lying down, lights off
    const again = loadSession(s.save(), FREE)!;
    expect(again.mode()).toBe('onFoot');
    expect(again.crew().posture).toBe('lying');
    expect(again.cabinLights()).toBe(false);
    // walk input gets the pilot up; back to the seat
    s.setWalk({ moveX: 0, moveZ: 1 });
    run(s, 0.1);
    s.setWalk({ moveX: 0, moveZ: 0 });
    run(s, 0.5);
    expect(s.crew().posture).toBe('walking');
    walkTo(s, [[-1.65, -1.6], [0, -1.6], [0, -5.4], [0, -9.0], [0, -11.0], [0, -12.2], [-0.55, -12.6]]);
    tap(s, 'harness');
    expect(s.mode()).toBe('helm');
    s.reset();
    expect(s.mode()).toBe('onFoot');
    expect(s.cabinLights()).toBe(true);
    expect(s.player().hold).toBe('stability');
  });
  // ---- Flight Assist: everything through the physical devices
  const wheel = (s: Session) => s.craft().find((c) => c.id === START_STATION_ID)!;
  /** Velocity relative to Chandler's Wheel, world axes. */
  const relWheel = (s: Session): V3 => { const c = me(s), w = wheel(s); return { x: c.v.x - w.v.x, y: c.v.y - w.v.y, z: c.v.z - w.v.z }; };
  const speedRel = (s: Session): number => { const r = relWheel(s); return Math.hypot(r.x, r.y, r.z); };
  const along = (a: V3, n: V3): number => a.x * n.x + a.y * n.y + a.z * n.z;
  const until = (s: Session, done: () => boolean, limit: number): number => {
    let t = 0;
    for (; t < limit && !done(); t += 0.1) run(s, 0.1);
    return t;
  };
  /** Put the DRIVE lever where it reads `value` (0..1). */
  const setLever = (s: Session, value: number): void => {
    expect(s.grabDevice(idOf(s, 'throttle'), 7)).toBe(true);
    s.moveDevice(7, value > 0 ? 0.05 + value * 0.95 : 0, 0);
    run(s, 1);
    s.releaseDevice(7);
    run(s, 0.2);
  };
  const quiet = (s: Session): boolean => { const c = me(s); return c.throttle === 0 && c.rcs.x === 0 && c.rcs.y === 0 && c.rcs.z === 0; };

  it('FLT ASSIST off leaves a drift alone; on, it nulls 5 m/s sideways beside the Wheel with the RCS (about 1 m/s²) and then goes quiet', () => {
    const s = createSession(FREE);
    strapIn(s);
    expect(STATS.rcsThrust / (STATS.dryMass + STATS.fuelCapacity)).toBeGreaterThan(0.9);
    expect(STATS.rcsThrust / (STATS.dryMass + STATS.fuelCapacity)).toBeLessThan(1.1);
    expect(dev(s, 'flightAssist').lit).toBe(false);
    expect(s.player().assist).toBe('off');
    // a drift by hand: translation controller to starboard until 5 m/s, assist off
    expect(s.grabDevice(idOf(s, 'translation'), 4)).toBe(true);
    s.moveDevice(4, 1, 0);
    const tUp = until(s, () => speedRel(s) >= 5, 20);
    s.releaseDevice(4);
    run(s, 0.5);
    expect(tUp).toBeGreaterThan(4);
    expect(tUp).toBeLessThan(6.5); // 1 m/s² of RCS
    const drift = speedRel(s);
    expect(drift).toBeGreaterThan(4.9);
    const p0 = s.player().propellant;
    run(s, 10);
    expect(Math.abs(speedRel(s) - drift)).toBeLessThan(0.02); // off: nobody touches it
    expect(s.player().propellant).toBe(p0);
    expect(quiet(s)).toBe(true);
    // on: the computer stops the ship relative to the station
    tap(s, 'flightAssist');
    expect(dev(s, 'flightAssist').lit).toBe(true);
    expect(s.player().assist).toBe('on');
    expect(s.player().assistRef).toBe(wheel(s).name);
    expect(s.player().assistCmd).toBe(0);
    const tStop = 0.3 + until(s, () => speedRel(s) < 0.1, 30);
    console.log(`flight assist: 5 m/s sideways nulled to < 0.1 m/s in ${tStop.toFixed(1)} s`);
    expect(tStop).toBeLessThan(8);
    expect(s.player().propellant).toBeLessThan(p0);
    run(s, 6);
    expect(speedRel(s)).toBeLessThan(0.06);
    expect(quiet(s)).toBe(true); // inside the dead-band: no chatter
    const p1 = s.player().propellant;
    run(s, 5);
    expect(s.player().propellant).toBe(p1);
    // off again by the same button
    tap(s, 'flightAssist');
    expect(dev(s, 'flightAssist').lit).toBe(false);
    expect(s.player().assist).toBe('off');
  });

  it('FLT ASSIST: the lever commands speed along the nose, the velocity follows the nose through a 90 degree turn, lever to zero stops the ship', () => {
    const s = createSession(FREE);
    strapIn(s);
    tap(s, 'flightAssist');
    // lever at 20 %: 10 m/s along the nose, drive safe -> RCS does it
    setLever(s, 0.2);
    expect(s.player().assistCmd).toBeCloseTo(10, 1);
    expect(me(s).throttle).toBe(0);
    const tGo = until(s, () => Math.abs(along(relWheel(s), nose(me(s).q)) - 10) < 0.1, 40);
    expect(tGo).toBeLessThan(16);
    run(s, 4);
    let n = nose(me(s).q);
    expect(along(relWheel(s), n)).toBeGreaterThan(9.9);
    expect(along(relWheel(s), n)).toBeLessThan(10.1);
    expect(Math.abs(speedRel(s) - 10)).toBeLessThan(0.1);
    expect(s.player().assistSpeed).toBeCloseTo(speedRel(s), 6);
    // armed, the main drive takes the forward part: yaw the nose 90 degrees with the rotation controller
    tap(s, 'driveArm');
    const n0 = n;
    expect(s.grabDevice(idOf(s, 'rotation'), 3)).toBe(true);
    s.moveDevice(3, 1, 0);
    const tTurn = until(s, () => angle(nose(me(s).q), n0) >= Math.PI / 2, 120);
    s.releaseDevice(3);
    expect(tTurn).toBeLessThan(120);
    run(s, 40);
    n = nose(me(s).q);
    expect(angle(n, n0)).toBeGreaterThan(1.4);
    expect(Math.abs(along(relWheel(s), n) - 10)).toBeLessThan(0.15); // the velocity is along the new nose
    expect(angle(relWheel(s), n)).toBeLessThan(0.02);
    expect(Math.abs(speedRel(s) - 10)).toBeLessThan(0.15);
    // lever back to zero: the ship comes to rest relative to the station (RCS braking, 1 m/s²)
    setLever(s, 0);
    const tStop = 1.2 + until(s, () => speedRel(s) < 0.1, 60);
    console.log(`flight assist: 10 m/s forward stopped in ${tStop.toFixed(1)} s after the lever went to zero`);
    expect(tStop).toBeLessThan(16);
    run(s, 6);
    expect(speedRel(s)).toBeLessThan(0.06);
    expect(quiet(s)).toBe(true);
    // the translation controller adds up to 3 m/s while held, and letting go stops that motion
    expect(s.grabDevice(idOf(s, 'translation'), 4)).toBe(true);
    s.moveDevice(4, 1, 0);
    run(s, 8);
    expect(Math.abs(speedRel(s) - 3)).toBeLessThan(0.1);
    s.releaseDevice(4);
    run(s, 8);
    expect(speedRel(s)).toBeLessThan(0.1);
  });

  it('FLT ASSIST with no reference (no craft targeted, no station within 100 km): the lamp blinks and nothing fires', () => {
    const a = createSession(FREE);
    strapIn(a);
    // the same ship 500 km from the station, with nothing targeted
    const j = JSON.parse(a.save());
    const w = JSON.parse(j.world);
    const pc = w.craft.find((c: { id: string }) => c.id === a.player().craftId);
    pc.rel.x += 500e3; // (relative to the primary: the integrated state of record)
    pc.r.x += 500e3;
    j.world = JSON.stringify(w);
    j.session.targetId = null;
    const s = loadSession(JSON.stringify(j), FREE)!;
    expect(s).not.toBe(null);
    expect(s.mode()).toBe('helm');
    tap(s, 'flightAssist');
    expect(s.player().assist).toBe('noRef');
    expect(s.player().assistRef).toBe('');
    const seen = new Set<boolean>();
    for (let i = 0; i < 30; i++) { run(s, 0.05); seen.add(dev(s, 'flightAssist').lit); }
    expect(seen.size).toBe(2); // blinking
    const p0 = s.player().propellant, v0 = { ...me(s).v };
    tap(s, 'driveArm');
    setLever(s, 0.5);
    expect(s.grabDevice(idOf(s, 'translation'), 4)).toBe(true);
    s.moveDevice(4, 1, 1);
    run(s, 10);
    expect(quiet(s)).toBe(true);
    expect(s.player().propellant).toBe(p0);
    expect(s.player().throttle).toBe(0);
    expect(v0).toBeDefined();
    // a craft target is a reference at any range: the assist wakes up
    s.setTarget(START_STATION_ID);
    run(s, 0.2);
    expect(s.player().assist).toBe('on');
    expect(dev(s, 'flightAssist').lit).toBe(true);
    // and the latch is saved
    const again = loadSession(s.save(), FREE)!;
    expect(again.player().assist).toBe('on');
  });
});

describe('loose objects in the hand', () => {
  /** A session with the pilot standing (boots on, gripped) at ship-local feet position (x, z), facing yaw. */
  const standAt = (x: number, z: number, yaw: number, opts: { budgetMs: number } = FREE): Session => {
    const s0 = createSession(opts);
    const data = JSON.parse(s0.save()) as { session: { crew: { pos: V3; vel: V3; yaw: number; pitch: number } } };
    const c = data.session.crew;
    c.pos.x = x; c.pos.z = z; c.vel.x = c.vel.y = c.vel.z = 0; c.yaw = yaw; c.pitch = 0;
    const s = loadSession(JSON.stringify(data), opts)!;
    run(s, 0.2);
    return s;
  };
  const prop = (s: Session, id: string) => s.props().find((p) => p.id === id)!;
  const toward = (s: Session, p: V3): V3 => { const e = s.crew().eye; return { x: p.x - e.x, y: p.y - e.y, z: p.z - e.z }; };
  /** Horizontal direction at angle th from ship forward (-Z) toward starboard (+X). */
  const flat = (th: number): V3 => ({ x: Math.sin(th), y: 0, z: -Math.cos(th) });

  it('grab a mug by pointer, carry it, throw it: it crosses the lounge and hits the far wall; the body recoils', () => {
    // at the galley counter, facing it (port, -X); the mugs are magnetted to the counter top
    const s = standAt(-2.2, -8.9, Math.PI / 2);
    expect(s.crew().roomId).toBe('lounge');
    const mug0 = prop(s, 'mug-galley-1');
    expect(mug0.stowed).toBe(true);
    const dir = toward(s, mug0.pos);
    expect(s.propAt(dir)).toBeLessThan(1);
    expect(s.propAt(flat(Math.PI / 2))).toBe(Infinity); // nothing to starboard within reach
    // a quick tap undoes the magnet
    expect(s.propGrab(3, dir)).toBe(true);
    s.propRelease(3, true);
    expect(prop(s, 'mug-galley-1').stowed).toBe(false);
    // hand on it again, lift it off the counter and hold it out ahead
    expect(s.propGrab(3, toward(s, prop(s, 'mug-galley-1').pos))).toBe(true);
    expect(prop(s, 'mug-galley-1').grabbed).toBe(true);
    // (ahead and a little to port: clear of the galley cabinets and the fridge)
    s.propMove(3, flat(-0.3));
    run(s, 1);
    const eye = s.crew().eye, held = prop(s, 'mug-galley-1').pos;
    const reachNow = Math.hypot(held.x - eye.x, held.y - eye.y, held.z - eye.z);
    expect(reachNow).toBeLessThan(1.1);
    expect(held.y).toBeGreaterThan(0.3); // carried at about eye height, off the counter
    // float free (boots off) and swing the arm toward starboard: let go as the hand moves across
    s.setBoots(false);
    s.step(1 / 60);
    const v0 = { ...s.crew().vel };
    for (let i = 0; i <= 6; i++) { s.propMove(3, flat(-0.3 + (0.7 * i) / 6)); s.step(1 / 60); }
    s.propRelease(3, false);
    expect(prop(s, 'mug-galley-1').grabbed).toBe(false);
    s.step(1 / 60);
    const recoil = s.crew().vel.x - v0.x;
    let xMax = -Infinity, hitAt = -1;
    const xs: number[] = [];
    for (let i = 0; i < 180; i++) {
      s.step(1 / 60);
      const p = prop(s, 'mug-galley-1').pos;
      xs.push(p.x);
      if (p.x > xMax) { xMax = p.x; hitAt = i; }
    }
    const xEnd = xs[xs.length - 1];
    console.log(`thrown mug: reached x = ${xMax.toFixed(3)} m after ${((hitAt + 1) / 60).toFixed(2)} s (starboard wall at 3.2), then x = ${xEnd.toFixed(3)}; body recoil ${recoil.toFixed(4)} m/s`);
    expect(xMax).toBeGreaterThan(3.2 - 0.042 - 0.05); // it reached the far (starboard) wall
    expect(xEnd).toBeLessThan(xMax - 0.02); // and came back off it
    expect(recoil).toBeLessThan(-0.005); // the arm that threw it pushed the floating body the other way
  });

  it('at full thrust loose objects slide aft; a carried mug stays in the hand, and holding on to a strapped crate holds the body back', () => {
    // in the cargo bay beside the strapped crates, facing them (port)
    const a = standAt(-0.6, 4.5, Math.PI / 2), b = standAt(-0.6, 4.5, Math.PI / 2);
    const crate = prop(a, 'crate-S1');
    expect(crate.stowed).toBe(true);
    expect(a.propGrab(5, toward(a, crate.pos))).toBe(true);
    const loose0 = { ...prop(a, 'crate-S3').pos };
    a.setControls({ throttle: 1 });
    b.setControls({ throttle: 1 });
    run(a, 0.25);
    run(b, 0.25);
    const slid = prop(a, 'crate-S3').pos.z - loose0.z;
    const va = a.crew().vel.z, vb = b.crew().vel.z;
    console.log(`full thrust 0.25 s: loose crate slid ${slid.toFixed(3)} m aft; body aft speed ${va.toFixed(3)} m/s holding the strapped crate, ${vb.toFixed(3)} m/s not`);
    expect(slid).toBeGreaterThan(0.2);
    expect(prop(a, 'crate-S1').stowed).toBe(true); // the strap holds (crate 25 kg x 12 m/s² + the hand < 1000 N)
    expect(vb).toBeGreaterThan(2); // falls aft at ~12 m/s²
    expect(va).toBeLessThan(vb - 0.2); // the hand's pull (up to 160 N on 80 kg) is felt
    a.propRelease(5, false);

    // carrying a loose mug under thrust: it stays in the hand while the loose things fall aft
    const c = standAt(-2.2, -8.9, Math.PI / 2);
    expect(c.propGrab(6, toward(c, prop(c, 'mug-galley-1').pos))).toBe(true);
    for (let i = 0; i < 60; i++) { c.propMove(6, flat(-0.3)); c.step(1 / 60); }
    const book0 = { ...prop(c, 'book-lounge').pos };
    c.setControls({ throttle: 1 });
    for (let i = 0; i < 18; i++) { c.propMove(6, flat(-0.3)); c.step(1 / 60); }
    const e = c.crew().eye, m = prop(c, 'mug-galley-1');
    expect(m.grabbed).toBe(true);
    expect(Math.hypot(m.pos.x - e.x, m.pos.y - e.y, m.pos.z - e.z)).toBeLessThan(1.1);
    expect(prop(c, 'book-lounge').pos.z - book0.z).toBeGreaterThan(0.2);
  });

  it('awake objects limit time acceleration (reason "props"); asleep they do not; saves keep them, old saves get the defaults', () => {
    const s = standAt(-2.2, -8.9, Math.PI / 2, { budgetMs: 3 });
    expect(s.propGrab(2, toward(s, prop(s, 'mug-galley-1').pos))).toBe(true);
    s.propRelease(2, true);
    s.propMove(2, flat(0));
    // nudge it loose by hand: grab, pull, let go with some speed
    expect(s.propGrab(2, toward(s, prop(s, 'mug-galley-1').pos))).toBe(true);
    for (let i = 0; i <= 6; i++) { s.propMove(2, flat(-0.3 + (0.6 * i) / 6)); s.step(1 / 60); }
    s.propRelease(2, false);
    s.setWarp(1e4);
    s.step(1 / 60);
    s.step(1 / 60);
    const w = s.warp();
    console.log(`with a mug in flight at 1e4x: achieved ${w.achieved.toFixed(0)}x, limited by '${w.limitedBy}'`);
    expect(w.limitedBy).toBe('props');
    expect(w.achieved).toBeLessThan(1e4);
    // save while it flies: the save carries the objects; a save without them loads with the ship's defaults
    const json = s.save();
    expect(json).toContain('"props":{');
    const l = loadSession(json, { budgetMs: 1e9 })!;
    expect(l.props().find((p) => p.id === 'mug-galley-1')!.pos).toEqual(prop(s, 'mug-galley-1').pos);
    const old = JSON.parse(json) as { session: { props?: unknown } };
    delete old.session.props;
    const o = loadSession(JSON.stringify(old), { budgetMs: 1e9 })!;
    expect(o.props().find((p) => p.id === 'mug-galley-1')!.stowed).toBe(true);
    // everything settles and goes to sleep: the warp is granted again
    const f = createSession({ budgetMs: 3 });
    f.setWarp(1e4);
    for (let i = 0; i < 5; i++) f.step(1 / 60);
    expect(f.warp().limitedBy).not.toBe('props');
  });

  it('after a burn in orbit the shaken-loose objects settle and sleep: the sleep warp is not held back', () => {
    const s = createSession({ budgetMs: 3 });
    const awake = (): number => s.props().filter((p) => !p.asleep && !p.stowed).length;
    s.setHold('prograde');
    run(s, 60);
    s.setControls({ throttle: 1 });
    run(s, 10); // 12 m/s² for 10 s: the magnetted mugs break free, everything loose slides aft
    s.setControls({ throttle: 0 });
    run(s, 0.5); // the drive cuts out: everything wakes as the cabin stops pushing on it
    const shaken = s.props().filter((p) => !p.stowed).length, woke = awake();
    let t = 0.5;
    for (; t < 120 && awake() > 0; t++) run(s, 1);
    console.log(`after the burn: ${shaken} objects loose, ${woke} still awake 0.5 s after the drive cut out, all asleep after ${t} s of coasting (prograde hold, the cabin turning at the orbital rate)`);
    expect(shaken).toBeGreaterThan(14);
    expect(awake()).toBe(0);
    s.setWarp(1e4);
    const t0 = s.time();
    for (let i = 0; i < 60; i++) s.step(1 / 60);
    expect(s.time() - t0).toBeGreaterThan(2000);
    expect(s.warp().limitedBy).not.toBe('props');
  });

  it('the sofa prompt shows to a body standing at the end of the table or pressed into the gap', () => {
    for (const [x, z] of [[1.47, -9.0], [1.47, -6.0], [1.6, -7.5]]) {
      const s = standAt(x, z, -Math.PI / 2); // facing starboard, toward the sofa
      expect(s.crew().prompt?.label, `${x},${z}`).toBe('Sit on the sofa');
    }
  });
});
