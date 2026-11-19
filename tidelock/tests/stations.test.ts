// Stations as gyrostats (src/world/stations.ts): layout mass properties, the rotor, exact torque-free motion, contacts
// with the rotating colliders.
import { describe, expect, it } from 'vitest';
import type { Quat, V3 } from '../src/core/types';
import { STATION_LAYOUTS } from '../src/data/stationLayouts';
import {
  collide, DEFAULT_CONTACT, makeContactBody, makeContactResult, Manifold, solveManifold, sphereCompound, stationCompound, type ContactBody,
} from '../src/world/compound';
import {
  gyrostatFree, gyrostatL, initRotor, loadRotor, rotorAngle, rotorContactAfter, rotorContactBody, rotorImpulse, rotorPoint, rotorSplit,
  saveRotor, stationMassProps, WHEEL_SPIN,
} from '../src/world/stations';

const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const WHEEL = STATION_LAYOUTS.ringHabitat;
const MP = stationMassProps(WHEEL);

describe('station mass properties from the layouts', () => {
  it('every archetype has a positive mass and inertia; the Wheel is axisymmetric with its rotor dominating Iy', () => {
    for (const [id, l] of Object.entries(STATION_LAYOUTS)) {
      const m = stationMassProps(l);
      expect(m.mass).toBeGreaterThan(1e6);
      expect(m.inertia.x).toBeGreaterThan(0);
      expect(m.principal.x + m.principal.y + m.principal.z).toBeCloseTo(m.inertia.x + m.inertia.y + m.inertia.z, -3);
      console.log(`${id}: ${m.mass.toExponential(2)} kg, I ${m.inertia.x.toExponential(2)} ${m.inertia.y.toExponential(2)} ${m.inertia.z.toExponential(2)}, |prod|/I ${(len(m.products) / m.inertia.x).toExponential(1)}, com ${len(m.com).toFixed(2)} m${m.rotor ? `, rotor I ${m.rotor.I.toExponential(2)} Ω ${m.rotor.omega0}` : ''}`);
    }
    expect(MP.inertia.x / MP.inertia.z).toBeCloseTo(1, 9);
    expect(len(MP.products) / MP.inertia.x).toBeLessThan(1e-9);
    expect(MP.rotor!.I / MP.inertia.y).toBeGreaterThan(0.95);
    expect(MP.rotor!.omega0).toBe(WHEEL_SPIN);
    // the thick ring 395..441 m (I = m·(Ri² + Ro²)/2) dominates
    expect(Math.sqrt(MP.rotor!.I / MP.rotor!.mass)).toBeGreaterThan(380); // spokes and sleeve sit inside
    expect(Math.sqrt(MP.rotor!.I / MP.rotor!.mass)).toBeLessThan(441);
    expect(stationMassProps(WHEEL)).toBe(MP); // cached
  });

  it('the rotating colliders are the Wheel’s ring, spokes and hub, and the spindle’s drums', () => {
    expect(rotorSplit(WHEEL).rotor.length).toBe(24 + 6 + 1);
    const sp = rotorSplit(STATION_LAYOUTS.spindle);
    expect(sp.rotor.length).toBe(48);
    expect(Array.from(sp.sign).filter((s) => s < 0).length).toBe(24);
    expect(stationMassProps(STATION_LAYOUTS.spindle).rotor!.counter).toBe(true);
    expect(initRotor(stationMassProps(STATION_LAYOUTS.spindle).rotor, 0).rotorH.y).toBe(0);
  });
});

describe('the rotor and the gyrostat', () => {
  it('spin gravity on the rim is Ω²r (1 g at 441 m for D5), the rim moves at Ω r', () => {
    const r = initRotor(MP.rotor, 0);
    const p = v3(), vv = v3(), a = v3();
    rotorPoint(r, 123.4, v3(441, 0, 0), p, vv, a);
    expect(len(a)).toBeCloseTo(WHEEL_SPIN * WHEEL_SPIN * 441, 12);
    expect(len(a)).toBeCloseTo(9.79, 2);
    expect(len(vv)).toBeCloseTo(WHEEL_SPIN * 441, 12);
    // and the acceleration is the second difference of the position (no sign slips)
    const p0 = v3(), p2 = v3(), d = 1e-3;
    rotorPoint(r, 123.4 - d, v3(441, 0, 0), p0, vv, v3());
    rotorPoint(r, 123.4 + d, v3(441, 0, 0), p2, vv, v3());
    expect((p0.x + p2.x - 2 * p.x) / (d * d)).toBeCloseTo(a.x, 3);
  });

  it('the rotor contact body moves the 441 m rim at Ω·r = 65.7 m/s and pulls Ω²·r = 9.79 m/s² there', () => {
    const rotor = initRotor(MP.rotor, 0), st = { rel: v3(), relV: v3(), q: { x: 0, y: 0, z: 0, w: 1 }, w: v3() };
    const RB = makeContactBody();
    for (const t of [0, 17.3, 1234.5]) {
      rotorContactBody(RB, st, MP, rotor, t);
      // a point on the rim at rotor-local (441, 0, 0), in world: R(q)·r; its velocity ω_world × p
      const q = RB.q, l = v3(441, 0, 0);
      const tx = 2 * (q.y * l.z - q.z * l.y), ty = 2 * (q.z * l.x - q.x * l.z), tz = 2 * (q.x * l.y - q.y * l.x);
      const p = v3(l.x + q.w * tx + (q.y * tz - q.z * ty), l.y + q.w * ty + (q.z * tx - q.x * tz), l.z + q.w * tz + (q.x * ty - q.y * tx));
      const W = RB.w.y; // body ω is (0, Ω, 0) for a station at rest, so ω_world = Ω ŷ
      expect(Math.abs(RB.w.x) + Math.abs(RB.w.z)).toBe(0);
      const vel = v3(W * p.z, 0, -W * p.x);
      expect(Math.abs(len(vel) - WHEEL_SPIN * 441) / (WHEEL_SPIN * 441)).toBeLessThan(1e-14);
      expect(Math.abs(W * W * len(p) - WHEEL_SPIN * WHEEL_SPIN * 441) / 9.79).toBeLessThan(1e-14);
      expect(W * W * len(p)).toBeCloseTo(9.79, 2);
      // and the point is where rotorPoint puts it
      const P = v3(), V = v3(), A = v3();
      rotorPoint(rotor, t, l, P, V, A);
      expect(len(v3(P.x - p.x, P.y - p.y, P.z - p.z))).toBeLessThan(1e-9);
      expect(len(v3(V.x - vel.x, V.y - vel.y, V.z - vel.z))).toBeLessThan(1e-9);
    }
  });

  it('the rotor angle after 1e5 s of warp is analytic, and an impulse keeps θ continuous', () => {
    const r = initRotor(MP.rotor, 0, 0.3);
    expect(rotorAngle(r, 1e5)).toBe(0.3 + WHEEL_SPIN * 1e5);
    const th = rotorAngle(r, 5e4);
    rotorImpulse(r, MP.rotor!, 1e9, 5e4);
    expect(Math.abs(((rotorAngle(r, 5e4) - th) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI))).toBeLessThan(1e-9);
    expect(r.rotorOmega).toBeCloseTo(WHEEL_SPIN + 1e9 / MP.rotor!.I, 15);
    expect(r.rotorH.y).toBeCloseTo(MP.rotor!.I * r.rotorOmega, 0);
  });

  it('gyrostatFree is exact: L conserved over 1e5 s in 1e3 steps, and it matches a fine RK4 of Euler’s equations', () => {
    const It = MP.inertia.x, Iy = MP.inertia.y, h = MP.rotor!.I * WHEEL_SPIN;
    const q: Quat = { x: 0.1, y: 0.2, z: -0.05, w: 0.97 }, n = Math.hypot(q.x, q.y, q.z, q.w);
    q.x /= n; q.y /= n; q.z /= n; q.w /= n;
    const w = v3(2e-4, 1.1e-3, -1e-4);
    const L0 = gyrostatL(q, w, It, Iy, h, v3());
    // reference: RK4 on (q, w) with 0.05 s steps over 200 s vs gyrostatFree in one 200 s step
    const qr = { ...q }, wr = { ...w };
    const f = (Q: Quat, W: V3): number[] => {
      const lx = It * W.x, ly = Iy * W.y + h, lz = It * W.z;
      const dwx = -(W.y * lz - W.z * ly) / It, dwy = -(W.z * lx - W.x * lz) / Iy, dwz = -(W.x * ly - W.y * lx) / It;
      // q̇ = ½ q ⊗ (0, w)
      return [dwx, dwy, dwz,
        0.5 * (Q.w * W.x + Q.y * W.z - Q.z * W.y), 0.5 * (Q.w * W.y + Q.z * W.x - Q.x * W.z), 0.5 * (Q.w * W.z + Q.x * W.y - Q.y * W.x), -0.5 * (Q.x * W.x + Q.y * W.y + Q.z * W.z)];
    };
    const dt = 0.05;
    for (let i = 0; i < 4000; i++) {
      const s0 = [wr.x, wr.y, wr.z, qr.x, qr.y, qr.z, qr.w];
      const ev = (s: number[]): number[] => f({ x: s[3], y: s[4], z: s[5], w: s[6] }, v3(s[0], s[1], s[2]));
      const k1 = ev(s0), k2 = ev(s0.map((x, j) => x + 0.5 * dt * k1[j])), k3 = ev(s0.map((x, j) => x + 0.5 * dt * k2[j])), k4 = ev(s0.map((x, j) => x + dt * k3[j]));
      const s1 = s0.map((x, j) => x + (dt / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
      wr.x = s1[0]; wr.y = s1[1]; wr.z = s1[2]; const l = Math.hypot(s1[3], s1[4], s1[5], s1[6]); qr.x = s1[3] / l; qr.y = s1[4] / l; qr.z = s1[5] / l; qr.w = s1[6] / l;
    }
    const qa = { ...q }, wa = { ...w };
    gyrostatFree(qa, wa, It, Iy, h, 200);
    expect((Math.abs(wa.x - wr.x) + Math.abs(wa.y - wr.y) + Math.abs(wa.z - wr.z)) / len(w)).toBeLessThan(1e-8);
    const dq = Math.min(Math.abs(qa.x - qr.x) + Math.abs(qa.y - qr.y) + Math.abs(qa.z - qr.z) + Math.abs(qa.w - qr.w),
      Math.abs(qa.x + qr.x) + Math.abs(qa.y + qr.y) + Math.abs(qa.z + qr.z) + Math.abs(qa.w + qr.w));
    expect(dq).toBeLessThan(1e-9);
    // long warp
    const qb = { ...q }, wb = { ...w };
    for (let i = 0; i < 1000; i++) gyrostatFree(qb, wb, It, Iy, h, 100);
    const L1 = gyrostatL(qb, wb, It, Iy, h, v3());
    expect(len(v3(L1.x - L0.x, L1.y - L0.y, L1.z - L0.z)) / len(L0)).toBeLessThan(1e-12);
    console.log(`gyrostat: |ΔL|/L after 1e5 s = ${(len(v3(L1.x - L0.x, L1.y - L0.y, L1.z - L0.z)) / len(L0)).toExponential(1)}, vs RK4 |Δq| ${dq.toExponential(1)}`);
  });

  it('a spoke sweeping into a ship at rest hits it at Ω r; the impulse goes into the rotor and L is conserved', () => {
    const split = rotorSplit(WHEEL), comp = stationCompound(split.rotor);
    const rotor = initRotor(MP.rotor, 0);
    const st = { rel: v3(), relV: v3(), q: { x: 0, y: 0, z: 0, w: 1 }, w: v3() };
    const t = 10, th = rotorAngle(rotor, t);
    // spoke 0 at azimuth spokeAz0 + θ; the ship sphere (r 2 m) 0.03 m ahead of the spoke's side at radius 200 m
    const r = 200, az = 30 * (Math.PI / 180) + th + (9 + 2 + 0.03) / r;
    const shipM = 6e4, ship: ContactBody = {
      p: v3(r * Math.cos(az), 0, -r * Math.sin(az)), v: v3(), q: { x: 0, y: 0, z: 0, w: 1 }, w: v3(),
      invMass: 1 / shipM, invI: v3(1 / (shipM * 20), 1 / (shipM * 20), 1 / (shipM * 20)),
    };
    const RB = makeContactBody();
    rotorContactBody(RB, st, MP, rotor, t);
    const m = new Manifold(), res = makeContactResult();
    expect(collide(sphereCompound(2), ship, comp, RB, m)).toBeGreaterThan(0);
    // before the solve: the approach speed is the rotor's surface velocity (v + ω × (p − x)) along the normal at the manifold point
    let vn = 0;
    for (let i = 0; i < m.n; i++) {
      const P = m.point(i, ship, v3()), N = m.normal(i, RB, v3());
      const wq = RB.q, ww = v3(), wb = RB.w; // ω in world: R·w
      const tx = 2 * (wq.y * wb.z - wq.z * wb.y), ty = 2 * (wq.z * wb.x - wq.x * wb.z), tz = 2 * (wq.x * wb.y - wq.y * wb.x);
      ww.x = wb.x + wq.w * tx + (wq.y * tz - wq.z * ty); ww.y = wb.y + wq.w * ty + (wq.z * tx - wq.x * tz); ww.z = wb.z + wq.w * tz + (wq.x * ty - wq.y * tx);
      const rx = P.x - RB.p.x, ry = P.y - RB.p.y, rz = P.z - RB.p.z;
      const u = (RB.v.x + ww.y * rz - ww.z * ry) * N.x + (RB.v.y + ww.z * rx - ww.x * rz) * N.y + (RB.v.z + ww.x * ry - ww.y * rx) * N.z;
      vn = Math.max(vn, u);
    }
    solveManifold(m, ship, RB, 1 / 120, { ...DEFAULT_CONTACT, positionIterations: 0 }, res);
    expect(Math.abs(res.approachSpeed - vn) / vn).toBeLessThan(1e-9);
    expect(Math.abs(res.approachSpeed - WHEEL_SPIN * r) / (WHEEL_SPIN * r)).toBeLessThan(0.01);
    console.log(`spoke impact speed ${res.approachSpeed.toFixed(4)} m/s = surface velocity · n ${vn.toFixed(4)} (Ω·r ${(WHEEL_SPIN * r).toFixed(3)} at the sphere centre)`);
    const Om0 = rotor.rotorOmega, th0 = rotorAngle(rotor, t);
    rotorContactAfter(RB, st, MP, rotor, t);
    expect(rotor.rotorOmega).toBeLessThan(Om0);
    expect(Math.abs(rotorAngle(rotor, t) - th0) % (2 * Math.PI)).toBeLessThan(1e-9);
    // angular momentum about the station centre: ship orbital + carrier (I ω) + rotor ΔΩ·I_r
    const Lship = v3(shipM * (ship.p.y * ship.v.z - ship.p.z * ship.v.y), shipM * (ship.p.z * ship.v.x - ship.p.x * ship.v.z), shipM * (ship.p.x * ship.v.y - ship.p.y * ship.v.x));
    Lship.x += ship.w.x / ship.invI.x; Lship.y += ship.w.y / ship.invI.y; Lship.z += ship.w.z / ship.invI.z; // its spin
    const Lst = v3(MP.inertia.x * st.w.x, MP.inertia.y * st.w.y + MP.rotor!.I * (rotor.rotorOmega - Om0), MP.inertia.z * st.w.z);
    const dL = len(v3(Lship.x + Lst.x, Lship.y + Lst.y, Lship.z + Lst.z));
    expect(dL / len(Lship)).toBeLessThan(1e-9);
    const P = len(v3(shipM * ship.v.x + MP.mass * st.relV.x, shipM * ship.v.y + MP.mass * st.relV.y, shipM * ship.v.z + MP.mass * st.relV.z));
    expect(P / (shipM * len(ship.v))).toBeLessThan(1e-9);
  });

  it('save -> load restores the rotor exactly; an old save gets the data spin', () => {
    const r = initRotor(MP.rotor, 5, 1.2);
    rotorImpulse(r, MP.rotor!, -3e8, 77);
    const b = loadRotor(JSON.parse(JSON.stringify(saveRotor(r))), MP.rotor, 0);
    expect(b).toEqual(r);
    expect(rotorAngle(b, 1e6)).toBe(rotorAngle(r, 1e6));
    const d = loadRotor(undefined, MP.rotor, 42);
    expect(d.rotorOmega).toBe(WHEEL_SPIN);
    expect(d.rotorT0).toBe(42);
  });
});
