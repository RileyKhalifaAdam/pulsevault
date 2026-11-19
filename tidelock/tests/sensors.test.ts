// W3-C rendezvous sensors in the real world: radar and lidar statistics against truth, acquisition, occlusion by Wick's
// atmosphere and by station structure, Flight Assist refusing an untracked target, the lidar pose, determinism,
// save/load and cost.
import { describe, expect, it } from 'vitest';
import type { Quat, V3 } from '../src/core/types';
import { SHIP_LAYOUTS } from '../src/data/shipLayouts';
import { sensorMounts } from '../src/data/sensorMounts';
import { computeStats, defaultLoadout } from '../src/sim/ships';
import { generateGalaxy, getSystem } from '../src/sim/universe';
import { addCraft, advance, createWorld, qRot, shipDef, type Craft, type World } from '../src/world';
import { compoundContains, hullCompound } from '../src/world/compound';
import { navPropagate, navSigma } from '../src/world/relnav';
import {
  designatePort, lineOfSight, loadSensors, makeSensorReadout, makeSensors, noiseG, RADAR_ACQ, saveSensors, sensorAssistRef,
  sensorLos, sensorPortAxis, sensorReadout, sensorsStep, sensorsTarget, SENSOR_TICKS, TRACK_NONE, TRACK_POSE, TRACK_RADAR,
  VIS_BODY, VIS_CRAFT, VIS_FACING, VIS_OK, type SensorIn, type SensorState,
} from '../src/world/sensors';

const system = getSystem(generateGalaxy(1), 'tallow')!;
const stats = computeStats(defaultLoadout('wren'));
const WICK = 'tallow.wick', WHEEL = 'tallow.st.chandlers-wheel';
const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const DEG = Math.PI / 180;

/** Quaternion turning local +Y onto unit d (shortest arc). */
function yTo(d: V3): Quat {
  const c = d.y, ax = d.z, az = -d.x; // (0,1,0) × d = (d.z, 0, −d.x)
  const s = Math.hypot(ax, az);
  if (s < 1e-12) return c > 0 ? { x: 0, y: 0, z: 0, w: 1 } : { x: 1, y: 0, z: 0, w: 0 };
  const ang = Math.atan2(s, c), k = Math.sin(ang / 2) / s;
  return { x: ax * k, y: 0, z: az * k, w: Math.cos(ang / 2) };
}

interface Rig { w: World; ship: Craft; st: Craft; S: SensorState; tick: number; IN: SensorIn }

/** The Wren `dist` metres out along the axis of the Wheel's port `portIx` (+ a lateral offset), collar facing the port. */
function rig(dist: number, portIx = -1, lateral = v3(), relVel = v3()): Rig {
  const w = createWorld(system, { stations: true });
  const st = w.craft.find((c) => c.id === WHEEL)!;
  const axis = v3(), pp = v3();
  let ix = portIx;
  if (ix < 0) {
    // the radial port whose axis is nearest the along-track direction
    const vl = Math.hypot(st.relV.x, st.relV.y, st.relV.z);
    let best = -2;
    st.ports.forEach((p, i) => { qRot(axis, st.q, p.dir.x, p.dir.y, p.dir.z); const c = -(axis.x * st.relV.x + axis.y * st.relV.y + axis.z * st.relV.z) / vl; if (p.size !== 'S' && c > best) { best = c; ix = i; } });
  }
  const p = st.ports[ix];
  qRot(axis, st.q, p.dir.x, p.dir.y, p.dir.z);
  qRot(pp, st.q, p.pos.x, p.pos.y, p.pos.z);
  const r = v3(st.rel.x + pp.x + axis.x * dist + lateral.x, st.rel.y + pp.y + axis.y * dist + lateral.y, st.rel.z + pp.z + axis.z * dist + lateral.z);
  const ship = addCraft(w, shipDef('player', 'Wren', stats, SHIP_LAYOUTS.wren, {
    primaryId: WICK, r, v: v3(st.relV.x + relVel.x, st.relV.y + relVel.y, st.relV.z + relVel.z), q: yTo(v3(-axis.x, -axis.y, -axis.z)),
  }));
  ship.w.x = ship.w.y = ship.w.z = 0;
  advance(w, 0);
  const S = makeSensors();
  sensorsTarget(S, WHEEL, ix);
  const IN: SensorIn = { world: w, ship, target: st, tick: 0, t: w.t, radarOn: true, lidarOn: true };
  return { w, ship, st, S, tick: 0, IN };
}

/** Fly `seconds` at the 120 Hz tick: world step, coast propagation, a sensor cycle every 12 ticks. */
function fly(R: Rig, seconds: number, each?: (R: Rig) => void): void {
  const n = Math.round(seconds * 120);
  for (let k = 0; k < n; k++) {
    advance(R.w, 1 / 120);
    R.tick++;
    navPropagate(R.S.nav, R.w.t, 0, 0, 0);
    if (R.tick % SENSOR_TICKS === 0) {
      R.IN.tick = R.tick; R.IN.t = R.w.t;
      sensorsStep(R.S, R.IN);
      each?.(R);
    }
  }
}

/** Truth: ship-relative position/velocity of the tracked port from the radar (or lidar) mount, inertial. */
function truth(R: Rig, which: 'radar' | 'lidar'): { r: number; rd: number; d: V3; dv: V3 } {
  const { ship, st } = R, p = st.ports[R.S.port];
  const M = sensorMounts(ship.shipVisual, ship.dockPort)[which];
  const a = qRot(v3(), ship.q, M.pos.x, M.pos.y, M.pos.z), pp = qRot(v3(), st.q, p.pos.x, p.pos.y, p.pos.z);
  const d = v3(st.rel.x + pp.x - ship.rel.x - a.x, st.rel.y + pp.y - ship.rel.y - a.y, st.rel.z + pp.z - ship.rel.z - a.z);
  const dv = v3(st.relV.x - ship.relV.x, st.relV.y - ship.relV.y, st.relV.z - ship.relV.z);
  const r = Math.hypot(d.x, d.y, d.z);
  return { r, rd: (d.x * dv.x + d.y * dv.y + d.z * dv.z) / r, d, dv };
}

describe('sensor mounts and noise', () => {
  it('mounts sit outside the hull, noise is standard normal and repeatable', () => {
    const k = hullCompound('wren')!, M = sensorMounts('wren', SHIP_LAYOUTS.wren.dockingPort);
    for (const m of [M.radar, M.lidar, M.camera]) expect(compoundContains(k, m.pos.x, m.pos.y, m.pos.z)).toBe(false);
    let s = 0, s2 = 0, n = 200000, s3 = 0;
    for (let i = 0; i < n; i++) { const g = noiseG(7, i, 3); s += g; s2 += g * g; s3 += g * noiseG(7, i, 4); }
    expect(Math.abs(s / n)).toBeLessThan(0.01);
    expect(Math.abs(s2 / n - 1)).toBeLessThan(0.01);
    expect(Math.abs(s3 / n)).toBeLessThan(0.01); // channels independent
    expect(noiseG(7, 12345, 2)).toBe(noiseG(7, 12345, 2));
    expect(noiseG(7, 2 ** 40 + 5, 2)).not.toBe(noiseG(7, 5, 2));
  });
});

describe('radar', () => {
  it('acquires in 3 s; range and range rate match truth within their noise statistics; the estimate converges', () => {
    const R = rig(5000, -1, v3(), v3(0, 0, 0));
    // give it a closing speed along the port axis: 1.5 m/s
    const st = R.st, p = st.ports[R.S.port], ax = qRot(v3(), st.q, p.dir.x, p.dir.y, p.dir.z);
    R.ship.relV.x -= 1.5 * ax.x; R.ship.relV.y -= 1.5 * ax.y; R.ship.relV.z -= 1.5 * ax.z;
    let acquiredAt = -1;
    const er: number[] = [], erd: number[] = [], sigR: number[] = [];
    const estErr: number[] = [], estSig: number[] = [];
    const out = makeSensorReadout();
    fly(R, 60, (r) => {
      if (acquiredAt < 0 && r.S.radarLock) acquiredAt = r.w.t;
      if (!r.S.radarLock) return;
      const T = truth(r, 'radar');
      er.push(r.S.zRange - T.r); sigR.push(Math.max(0.5, 1e-3 * T.r));
      erd.push(r.S.zRate - T.rd);
      if (r.w.t > 40) {
        sensorReadout(r.S, r.w.t, out);
        estErr.push(out.rangeRate - (-1.5 + 0)); // closing along the axis (approximately the truth below)
        const Tr = truth(r, 'radar');
        estErr[estErr.length - 1] = out.rangeRate - Tr.rd;
        estSig.push(out.sigRate);
      }
    });
    expect(acquiredAt).toBeGreaterThan(RADAR_ACQ - 1e-9);
    expect(acquiredAt).toBeLessThan(RADAR_ACQ + 0.11 + 1e-9);
    const n = erd.length, mean = erd.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(erd.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
    const zr = er.map((e, i) => e / sigR[i]), mr = zr.reduce((a, b) => a + b, 0) / n, sr = Math.sqrt(zr.reduce((a, b) => a + (b - mr) ** 2, 0) / (n - 1));
    // n ≈ 570: mean within 4σ/√n, sd within 15%
    expect(Math.abs(mean)).toBeLessThan((4 * 0.02) / Math.sqrt(n));
    expect(Math.abs(sd / 0.02 - 1)).toBeLessThan(0.15);
    expect(Math.abs(mr)).toBeLessThan(4 / Math.sqrt(n));
    expect(Math.abs(sr - 1)).toBeLessThan(0.15);
    // The filtered closing speed: errors consistent with its own σ, and far below the raw 0.02 m/s.
    const z2 = estErr.reduce((a, e, i) => a + (e / estSig[i]) ** 2, 0) / estErr.length;
    const rms = Math.sqrt(estErr.reduce((a, e) => a + e * e, 0) / estErr.length);
    console.log(`radar at 5 km: acquired at ${acquiredAt.toFixed(2)} s; range-rate residual mean ${(mean * 1e3).toFixed(2)} mm/s sd ${(sd * 1e3).toFixed(2)} mm/s (σ 20); range z mean ${mr.toFixed(3)} sd ${sr.toFixed(3)}; filtered ṙ rms ${(rms * 1e3).toFixed(2)} mm/s, mean (err/σ)² ${z2.toFixed(2)}`);
    expect(rms).toBeLessThan(0.01);
    expect(z2).toBeLessThan(3);
  });

  it('Flight Assist refuses an untracked station; NO TRACK while acquiring and after the target is lost', () => {
    const R = rig(3000);
    const V = v3(), out = makeSensorReadout();
    fly(R, 1);
    expect(sensorReadout(R.S, R.w.t, out).tracking).toBe(false);
    expect(sensorAssistRef(R.S, R.w.t, V)).toBe(false); // acquiring: NO REF
    fly(R, 4);
    expect(sensorReadout(R.S, R.w.t, out).track).toBe(TRACK_RADAR);
    expect(sensorAssistRef(R.S, R.w.t, V)).toBe(true);
    const T = truth(R, 'radar'), sg = [0, 0];
    navSigma(R.S.nav, R.w.t, sg); // 1 s after lock the cross-range velocity is still being resolved
    expect(Math.hypot(V.x + T.dv.x, V.y + T.dv.y, V.z + T.dv.z)).toBeLessThan(3 * sg[1]);
    expect(sg[1]).toBeLessThan(10);
    // power the radar off: the lock goes at once, the estimate coasts for COAST_MAX, then FA has no reference.
    R.IN.radarOn = false; R.IN.lidarOn = false;
    fly(R, 1);
    expect(R.S.radarLock).toBe(false);
    expect(sensorReadout(R.S, R.w.t, out).tracking).toBe(false);
    expect(sensorAssistRef(R.S, R.w.t, V)).toBe(true); // coasting 1 s
    const s1 = out.sigRange;
    fly(R, 1.5);
    expect(sensorAssistRef(R.S, R.w.t, V)).toBe(false);
    expect(sensorLos(R.S, R.w.t, v3(), v3())).toBe(false);
    expect(sensorReadout(R.S, R.w.t, out).sigRange).toBeGreaterThan(s1); // the covariance grows
    // an untracked station (different target) is refused at once
    sensorsTarget(R.S, 'tallow.st.gloaming-lock', 0);
    expect(sensorAssistRef(R.S, R.w.t, V)).toBe(false);
  });
});

describe('occlusion', () => {
  it('Wick and its sensible atmosphere block the line of sight; the limb clears it', () => {
    const w = createWorld(system, { stations: false });
    const wick = w.bodies.find((b) => b.id === WICK)!, top = wick.radius + wick.atmosphere!.height;
    const mk = (id: string, ang: number, alt: number): Craft => addCraft(w, shipDef(id, id, stats, SHIP_LAYOUTS.wren, {
      primaryId: WICK, r: v3((wick.radius + alt) * Math.cos(ang), 0, -(wick.radius + alt) * Math.sin(ang)), v: v3(),
    }));
    const a = mk('a', 0, 0), b = mk('b', 0, 0);
    advance(w, 0);
    // chord between two points at radius r separated by angle φ comes within r·cos(φ/2) of the centre
    const vis = (alt: number, phi: number): number => {
      const r = wick.radius + alt;
      a.rel.x = r; a.rel.y = 0; a.rel.z = 0;
      b.rel.x = r * Math.cos(phi); b.rel.y = 0; b.rel.z = -r * Math.sin(phi);
      return lineOfSight(w, a, b, false, 0, 0, 0, b.rel.x - a.rel.x, b.rel.y - a.rel.y, b.rel.z - a.rel.z);
    };
    const r1 = wick.radius + 400e3, phiLimb = 2 * Math.acos(top / r1);
    expect(vis(400e3, phiLimb * 0.98)).toBe(VIS_OK);
    expect(vis(400e3, phiLimb * 1.02)).toBe(VIS_BODY); // grazes below atm.top
    expect(vis(400e3, Math.PI * 0.9)).toBe(VIS_BODY); // behind Wick
    // the atmosphere, not only the rock: a chord whose lowest point is 1 km below atm.top but far above the ground
    const r2 = top + 500, phi2 = 2 * Math.acos((top - 1000) / r2);
    expect(vis(r2 - wick.radius, phi2)).toBe(VIS_BODY);
  });

  it('a target behind the station drops out, and the port must face the sensor', () => {
    const R = rig(4000);
    fly(R, 4);
    expect(R.S.radarLock).toBe(true);
    // Move a second craft (the target) to the far side of the Wheel, origin-tracked: the Wheel's structure is between.
    const { w, ship, st } = R;
    const far = addCraft(w, shipDef('far', 'far', stats, SHIP_LAYOUTS.wren, {
      primaryId: WICK, r: v3(2 * st.rel.x - ship.rel.x, 2 * st.rel.y - ship.rel.y, 2 * st.rel.z - ship.rel.z), v: v3(st.relV.x, st.relV.y, st.relV.z),
    }));
    advance(w, 0);
    sensorsTarget(R.S, 'far', -1);
    R.IN.target = far;
    fly(R, 4);
    expect(R.S.radarVis).toBe(VIS_CRAFT);
    expect(R.S.radarLock).toBe(false);
    // the tracked port seen from behind (ship on the far side of its axis plane): facing fails
    const R2 = rig(4000);
    const p = R2.st.ports[R2.S.port], axv = qRot(v3(), R2.st.q, p.dir.x, p.dir.y, p.dir.z), pp = qRot(v3(), R2.st.q, p.pos.x, p.pos.y, p.pos.z);
    R2.ship.rel.x = R2.st.rel.x + pp.x - 4000 * axv.x; R2.ship.rel.y = R2.st.rel.y + pp.y - 4000 * axv.y; R2.ship.rel.z = R2.st.rel.z + pp.z - 4000 * axv.z;
    R2.ship.q = yTo(axv);
    advance(R2.w, 0);
    fly(R2, 1);
    expect([VIS_FACING, VIS_CRAFT]).toContain(R2.S.radarVis);
    expect(R2.S.radarLock).toBe(false);
    // designatePort picks a port that faces the ship
    const ix = designatePort(R2.st, 'M', R2.ship.r.x, R2.ship.r.y, R2.ship.r.z);
    const q = R2.st.ports[ix], qa = qRot(v3(), R2.st.q, q.dir.x, q.dir.y, q.dir.z), qp = qRot(v3(), R2.st.q, q.pos.x, q.pos.y, q.pos.z);
    expect((R2.ship.r.x - R2.st.r.x - qp.x) * qa.x + (R2.ship.r.y - R2.st.r.y - qp.y) * qa.y + (R2.ship.r.z - R2.st.r.z - qp.z) * qa.z).toBeGreaterThan(0);
  });
});

describe('lidar and pose', () => {
  it('inside 200 m the lidar gives the port pose; range from the filter is cm-grade', () => {
    const R = rig(150, -1, v3(2, -1, 0.5));
    const out = makeSensorReadout(), A = v3(), U = v3();
    let worstAxis = 0, n = 0;
    const er: number[] = [];
    fly(R, 20, (r) => {
      if (r.w.t < 8) return;
      const p = r.st.ports[r.S.port], ax = qRot(v3(), r.st.q, p.dir.x, p.dir.y, p.dir.z);
      expect(sensorPortAxis(r.S, r.w.t, A, U)).toBe(true);
      worstAxis = Math.max(worstAxis, Math.acos(Math.min(1, A.x * ax.x + A.y * ax.y + A.z * ax.z)));
      sensorReadout(r.S, r.w.t, out);
      // filter range from the ship origin vs truth from the origin
      const pp = qRot(v3(), r.st.q, p.pos.x, p.pos.y, p.pos.z);
      const tr = Math.hypot(r.st.rel.x + pp.x - r.ship.rel.x, r.st.rel.y + pp.y - r.ship.rel.y, r.st.rel.z + pp.z - r.ship.rel.z);
      er.push(out.range - tr);
      n++;
    });
    expect(out.track).toBe(TRACK_POSE);
    const rms = Math.sqrt(er.reduce((a, e) => a + e * e, 0) / er.length);
    console.log(`lidar at 150 m: range rms ${(rms * 100).toFixed(2)} cm, σ ${(out.sigRange * 100).toFixed(2)} cm; port axis worst ${(worstAxis / DEG).toFixed(3)}° (raw σ 0.2°) over ${n} cycles`);
    expect(rms).toBeLessThan(0.02);
    expect(worstAxis).toBeLessThan(0.25 * DEG);
  });
});

describe('determinism, save/load, cost', () => {
  it('two runs are identical; save → load → continue is bit-identical', () => {
    const a = rig(1500), b = rig(1500);
    fly(a, 8); fly(b, 8);
    expect(JSON.stringify(saveSensors(a.S))).toBe(JSON.stringify(saveSensors(b.S)));
    const saved = JSON.stringify(saveSensors(a.S));
    const c = rig(1500); // same world history
    fly(c, 8);
    c.S = loadSensors(JSON.parse(saved));
    fly(a, 6); fly(c, 6);
    expect(JSON.stringify(saveSensors(c.S))).toBe(JSON.stringify(saveSensors(a.S)));
    expect(saved.length).toBeLessThan(800);
    const d = loadSensors(undefined);
    expect(d.targetId).toBe(null);
    expect(sensorAssistRef(d, 0, v3())).toBe(false);
    console.log(`sensor save: ${saved.length} bytes`);
  });

  it('cost: a full measurement cycle and the per-tick propagation (node)', () => {
    const R = rig(150); // radar off below 200 m: run one at 1.5 km too
    fly(R, 3);
    const R2 = rig(1500);
    fly(R2, 4);
    const time = (f: () => void, n: number): number => { for (let i = 0; i < 2000; i++) f(); const t0 = performance.now(); for (let i = 0; i < n; i++) f(); return ((performance.now() - t0) * 1000) / n; };
    let tk = 1e6;
    const cycleLidarPose = time(() => { R.IN.tick = tk++; sensorsStep(R.S, R.IN); }, 20000);
    const cycleRadarLidar = time(() => { R2.IN.tick = tk++; sensorsStep(R2.S, R2.IN); }, 20000);
    let tt = R.S.nav.t;
    const prop = time(() => { tt += 1 / 120; navPropagate(R.S.nav, tt, 1e-4, 0, 0); }, 200000);
    const out = makeSensorReadout();
    const read = time(() => { sensorReadout(R.S, tt, out); }, 50000);
    const perFrame = (prop * 2) + cycleRadarLidar / 6 + read;
    console.log(`cost (node): cycle radar+lidar ${cycleRadarLidar.toFixed(2)} µs, lidar+pose ${cycleLidarPose.toFixed(2)} µs; navPropagate ${prop.toFixed(3)} µs/tick; readout ${read.toFixed(2)} µs; ≈ ${perFrame.toFixed(2)} µs per 60 fps frame (budget 5 µs on A16 ≈ 2.5 µs node)`);
    expect(cycleRadarLidar).toBeLessThan(20);
    expect(R2.S.radarLock && R2.S.lidarLock).toBe(true);
  });
});

void TRACK_NONE; void VIS_OK;
