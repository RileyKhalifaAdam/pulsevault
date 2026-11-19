// The session on the physical world (src/game/session.ts): what the client flies. Everything here goes through
// the Session contract only — setControls, setHold, setWarp, the views and the events.

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
const START_DISTANCE = WHEEL_RADIUS + START_CLEARANCE;
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
    expect(d.distance - WHEEL_RADIUS).toBeCloseTo(200, 1);
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

describe('the pilot as a body in the ship', () => {
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
  const face = (s: Session, yaw: number): void => s.addLook(yaw - s.crew().yaw || 1e-9, 0);

  it('leave the helm, walk to the cabin, switch the lights, sleep an hour in the bunk, wake, fly again', () => {
    const s = createSession(FREE);
    const said: string[] = [];
    const modes: string[] = [];
    const sleeps: { asleep: boolean; seconds: number }[] = [];
    s.events.on('crewMessage', (e) => said.push(e.text));
    s.events.on('crewMode', (e) => modes.push(e.mode));
    s.events.on('sleep', (e) => sleeps.push({ ...e }));
    expect(s.mode()).toBe('helm');
    expect(s.interior()?.shipId).toBe('wren');
    expect(s.crew().posture).toBe('seated');
    expect(s.crew().eye).toEqual(s.interior()!.helmEye);
    expect(s.leaveHelm()).toBe(true);
    expect(s.mode()).toBe('onFoot');
    expect(modes).toEqual(['onFoot']);
    let c = s.crew();
    expect(c.pos).toEqual(s.interior()!.spawn.pos);
    expect(c.roomId).toBe('cockpit');
    expect(c.prompt?.kind).toBe('helm');
    run(s, 0.2);
    expect(s.crew().gripped).toBe(true);
    expect(s.crew().posture).toBe('walking');
    // the drive is locked off and time stays at 1x
    s.setControls({ throttle: 1, translate: { x: 1, y: 0, z: 0 } });
    const t0 = s.time();
    s.warpUp();
    s.warpUp();
    run(s, 1);
    expect(s.player().throttle).toBe(0);
    expect(s.flight().accel).toBeLessThan(1e-6);
    expect(s.time() - t0).toBeCloseTo(1, 6);
    expect(s.warp().requested).toBe(1);
    expect(s.warp().limitedBy).toBe('crew');
    expect(s.player().hold).toBe('stability');
    // into the cabin, to the light switch
    face(s, Math.PI);
    walkTo(s, [[0, -3.2], [0, -2.0]]);
    expect(s.crew().roomName).toBe('Cabin');
    face(s, Math.atan2(0.6, 0.5));
    expect(s.crew().prompt?.kind).toBe('lights');
    expect(s.cabinLights()).toBe(true);
    expect(s.interact()).toBe(true);
    expect(s.cabinLights()).toBe(false);
    // hatch, galley
    walkTo(s, [[0, 1.0]]);
    expect(s.crew().prompt?.kind).toBe('hatch');
    s.interact();
    expect(said.pop()).toBe('Hatch sealed — not docked');
    // boots off: the pilot floats; push off toward the corridor door, boots back on to land
    s.setBoots(false);
    run(s, 0.1);
    expect(s.crew().posture).toBe('floating');
    s.setBoots(true);
    run(s, 0.5);
    expect(s.crew().gripped).toBe(true);
    // to the bunk
    walkTo(s, [[0, 1.6], [0, 3.05], [0.73, 3.05]]);
    c = s.crew();
    expect(c.roomId).toBe('bunks');
    expect(c.prompt?.kind).toBe('bunk');
    s.interact();
    c = s.crew();
    expect(c.posture).toBe('lying');
    expect(c.eye).toEqual(s.interior()!.bunkEye);
    expect(c.prompt?.label).toBe('Sleep');
    expect(c.asleep).toBe(false);
    s.interact();
    expect(s.crew().asleep).toBe(true);
    expect(s.warp().requested).toBe(1e4);
    const t1 = s.time();
    let frames = 0;
    while (s.time() - t1 < 3600 && frames < 4000) { s.step(1 / 60); frames++; }
    expect(s.time() - t1).toBeGreaterThanOrEqual(3600);
    expect(frames).toBeLessThan(200); // well above 100x: the world granted the sleep
    s.addLook(0.01, 0);
    expect(s.crew().asleep).toBe(false);
    expect(sleeps.length).toBe(2);
    expect(sleeps[1].seconds).toBeCloseTo(s.time() - t1, 6);
    const t2 = s.time();
    run(s, 1);
    expect(s.time() - t2).toBeCloseTo(1, 6);
    // save while on foot: the body comes back where it was
    const again = loadSession(s.save(), FREE)!;
    expect(again.mode()).toBe('onFoot');
    expect(again.crew().posture).toBe('lying');
    expect(again.cabinLights()).toBe(false);
    // up, back to the cockpit, strap in, light the drive
    s.standUp();
    run(s, 0.3);
    expect(s.crew().posture).toBe('walking');
    walkTo(s, [[0, 3.05], [0, 1.6], [0, -2.0], [0, -3.2], [-0.5, -3.25]]);
    face(s, 0);
    expect(s.crew().prompt?.kind).toBe('helm');
    expect(s.interact()).toBe(true);
    expect(s.mode()).toBe('helm');
    expect(modes).toEqual(['onFoot', 'helm']);
    s.setControls({ throttle: 1 });
    run(s, 2);
    expect(s.player().throttle).toBe(1);
    expect(s.flight().accel).toBeGreaterThan(5);
    s.reset();
    expect(s.mode()).toBe('helm');
    expect(s.cabinLights()).toBe(true);
  });

  it('thrust while the pilot is loose is not possible; a turning ship is felt on foot', () => {
    const s = createSession(FREE);
    // strapped in while the drive is on; the crew is pressed toward the stern at the ship's acceleration
    s.setControls({ throttle: 1 });
    run(s, 0.5);
    expect(s.leaveHelm()).toBe(false);
    expect(s.crew().felt.z).toBeCloseTo(s.player().maxAccel, 6);
    s.setControls({ throttle: 0 });
    run(s, 0.5);
    expect(Math.hypot(s.crew().felt.x, s.crew().felt.y, s.crew().felt.z)).toBeLessThan(0.05);
    expect(s.leaveHelm()).toBe(true);
    s.setHold('prograde'); // the hold keeps working with the seat empty: the ship turns under the pilot
    let felt = 0;
    for (let i = 0; i < 600; i++) {
      s.step(1 / 60);
      const f = s.crew().felt;
      felt = Math.max(felt, Math.hypot(f.x, f.y, f.z));
    }
    expect(felt).toBeGreaterThan(0.01);
    expect(felt).toBeLessThan(4);
    expect(s.crew().roomId).toBe('cockpit');
    expect(s.player().throttle).toBe(0);
  });
});
