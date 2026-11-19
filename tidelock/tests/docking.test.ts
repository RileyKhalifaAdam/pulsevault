// Soft-capture docking (src/world/capture.ts) between a Wren-like ship and the Wheel as a gyrostat (stations.ts).
import { describe, expect, it } from 'vitest';
import type { Quat, V3 } from '../src/core/types';
import { SHIP_LAYOUTS } from '../src/data/shipLayouts';
import { STATION_LAYOUTS } from '../src/data/stationLayouts';
import {
  CAP_BREAK, CAP_CAPTURE, CAP_CONTACT, CAP_HARD, CAP_RETRACT, captureHarden, captureMaxStep, captureStep, HARD_OFFSET, latchBreakSpeed,
  latchLoad, loadCapture, makeCaptureState, makeLatchLoad, makeRingGeom, makeRingIO, Q, RING_EXT, RING_STROKE, ringGeom, ringPhase,
  saveCapture, RING_K, RING_KT, RING_ZETA, type CaptureState,
} from '../src/world/capture';
import { compoundGyration, hullCompound, type ContactBody } from '../src/world/compound';
import { gyrostatFree, stationMassProps } from '../src/world/stations';

const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const WHEEL = STATION_LAYOUTS.ringHabitat;
const MP = stationMassProps(WHEEL);
const H_ROTOR = MP.rotor!.I * MP.rotor!.omega0;
const IT = 0.5 * (MP.inertia.x + MP.inertia.z);
const SHIP_M = 60e3;
const GYR = compoundGyration(hullCompound('wren')!, v3());
const COLLAR = SHIP_LAYOUTS.wren.dockingPort;
const SEAT = v3(-0.55, 0.25, -13.45);
const PORT = WHEEL.ports.find((p) => p.id === 'N2')!;

function rot(q: Quat, a: V3): V3 {
  const tx = 2 * (q.y * a.z - q.z * a.y), ty = 2 * (q.z * a.x - q.x * a.z), tz = 2 * (q.x * a.y - q.y * a.x);
  return v3(a.x + q.w * tx + (q.y * tz - q.z * ty), a.y + q.w * ty + (q.z * tx - q.x * tz), a.z + q.w * tz + (q.x * ty - q.y * tx));
}
const conj = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
function qmul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y, y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w, w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
const axisAngle = (a: V3, ang: number): Quat => ({ x: a.x * Math.sin(ang / 2), y: a.y * Math.sin(ang / 2), z: a.z * Math.sin(ang / 2), w: Math.cos(ang / 2) });
const cross = (a: V3, b: V3): V3 => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);

interface Scene { A: ContactBody; B: ContactBody; s: CaptureState }

/**
 * Ship approaching port N2 of the Wheel (station at the origin, at rest, rotor spinning). The ship's collar axis is
 * opposed to the port axis (turned by `tilt` about the port's up), its collar `gap` m outside the ring face and
 * `lateral` m off the axis along the port's up, closing at `speed`.
 */
function scene(speed: number, gap = 0.02, lateral = 0, tilt = 0): Scene {
  const d = PORT.dir, up = PORT.up;
  // ship +Y (collar) -> −d : rotate ŷ onto −d
  const t = v3(-d.x, -d.y, -d.z), ax = cross(v3(0, 1, 0), t), s = len(ax);
  let q: Quat = s > 1e-12 ? axisAngle(v3(ax.x / s, ax.y / s, ax.z / s), Math.atan2(s, t.y)) : { x: 0, y: 0, z: 0, w: 1 };
  if (tilt) q = qmul(axisAngle(up, tilt), q);
  const pc = v3(PORT.pos.x + (RING_EXT + gap) * d.x + lateral * up.x, PORT.pos.y + (RING_EXT + gap) * d.y + lateral * up.y, PORT.pos.z + (RING_EXT + gap) * d.z + lateral * up.z);
  const rc = rot(q, COLLAR.pos);
  const A: ContactBody = {
    p: v3(pc.x - rc.x, pc.y - rc.y, pc.z - rc.z), v: v3(-speed * d.x, -speed * d.y, -speed * d.z), q, w: v3(),
    invMass: 1 / SHIP_M, invI: v3(1 / (SHIP_M * GYR.x), 1 / (SHIP_M * GYR.y), 1 / (SHIP_M * GYR.z)),
  };
  const B: ContactBody = {
    p: v3(), v: v3(), q: { x: 0, y: 0, z: 0, w: 1 }, w: v3(),
    invMass: 1 / MP.mass, invI: v3(1 / MP.inertia.x, 1 / MP.inertia.y, 1 / MP.inertia.z),
  };
  return { A, B, s: makeCaptureState() };
}

/** Exact torque-free drift: the ship conserving its world angular momentum, the station as the gyrostat. */
function drift(sc: Scene, h: number): void {
  const { A, B } = sc;
  for (const b of [A, B]) { b.p.x += b.v.x * h; b.p.y += b.v.y * h; b.p.z += b.v.z * h; }
  // ship: L_w = R·I·w; rotate by ω_w·h; w = I⁻¹·Rᵀ·L_w
  const Lw = rot(A.q, v3(A.w.x / A.invI.x, A.w.y / A.invI.y, A.w.z / A.invI.z));
  const ww = rot(A.q, A.w), a = len(ww) * h;
  if (a > 0) {
    const n = 1 / len(ww), dq = axisAngle(v3(ww.x * n, ww.y * n, ww.z * n), a);
    const q = qmul(dq, A.q), l = Math.hypot(q.x, q.y, q.z, q.w);
    A.q.x = q.x / l; A.q.y = q.y / l; A.q.z = q.z / l; A.q.w = q.w / l;
  }
  const Lb = rot(conj(A.q), Lw);
  A.w.x = Lb.x * A.invI.x; A.w.y = Lb.y * A.invI.y; A.w.z = Lb.z * A.invI.z;
  gyrostatFree(B.q, B.w, IT, MP.inertia.y, H_ROTOR, h);
}

function momenta(sc: Scene): { P: V3; L: V3; Lship: number } {
  const { A, B } = sc, mA = SHIP_M, mB = MP.mass;
  const P = v3(mA * A.v.x + mB * B.v.x, mA * A.v.y + mB * B.v.y, mA * A.v.z + mB * B.v.z);
  const la = cross(A.p, v3(mA * A.v.x, mA * A.v.y, mA * A.v.z)), lb = cross(B.p, v3(mB * B.v.x, mB * B.v.y, mB * B.v.z));
  const sa = rot(A.q, v3(A.w.x / A.invI.x, A.w.y / A.invI.y, A.w.z / A.invI.z));
  // the rotor's R·h·ŷ written as h·ŷ + h·(R·ŷ − ŷ): the constant h·ŷ (2.9e13 N·m·s, one ulp = 0.004) is left out
  const q = B.q, sw = rot(q, v3(IT * B.w.x, MP.inertia.y * B.w.y, IT * B.w.z));
  const yx = 2 * (q.x * q.y - q.z * q.w), yy1 = -2 * (q.x * q.x + q.z * q.z), yz = 2 * (q.y * q.z + q.x * q.w); // R·ŷ − ŷ
  const sb = v3(sw.x + H_ROTOR * yx, sw.y + H_ROTOR * yy1, sw.z + H_ROTOR * yz);
  return { P, L: v3(la.x + lb.x + sa.x + sb.x, la.y + lb.y + sa.y + sb.y, la.z + lb.z + sa.z + sb.z), Lship: len(la) + len(sa) };
}

function kinetic(sc: Scene): number {
  const { A, B } = sc;
  const e = (b: ContactBody, m: number): number => 0.5 * m * (b.v.x ** 2 + b.v.y ** 2 + b.v.z ** 2);
  return e(A, SHIP_M) + e(B, MP.mass) + 0.5 * (A.w.x ** 2 / A.invI.x + A.w.y ** 2 / A.invI.y + A.w.z ** 2 / A.invI.z) +
    0.5 * (IT * B.w.x ** 2 + MP.inertia.y * B.w.y ** 2 + IT * B.w.z ** 2);
}

interface Run {
  codes: number[]; maxComp: number; peakAcc: number; dP: number; dL: number; L0: number; P0: number;
  energyUp: number; sepSpeed: number; sc: Scene; t: number; dLstep: number;
}

/** Step the pair at the ring's own step limit (Q while engaged, 0.5 s retracting) for `T` seconds. */
function run(sc: Scene, T: number, armed = true, onStep?: (sc: Scene, t: number) => void): Run {
  const g = ringGeom(makeRingGeom(), PORT, COLLAR), io = makeRingIO();
  io.armed = armed;
  const m0 = momenta(sc);
  const out: Run = { codes: [], maxComp: 0, peakAcc: 0, dP: 0, dL: 0, L0: m0.Lship, P0: len(m0.P), energyUp: 0, sepSpeed: 0, sc, t: 0, dLstep: 0 };
  let t = 0, prevE = NaN;
  while (t < T) {
    const hh = sc.s.latched && sc.s.phase !== 'soft' ? 0.5 : Q;
    drift(sc, hh);
    t += hh;
    io.h = hh;
    const v0 = v3(sc.A.v.x, sc.A.v.y, sc.A.v.z), w0 = rot(sc.A.q, sc.A.w);
    const ke = kinetic(sc);
    const mb = momenta(sc).L;
    const code = captureStep(g, sc.s, sc.A, sc.B, io);
    const ma = momenta(sc).L;
    out.dLstep = Math.max(out.dLstep, len(v3(ma.x - mb.x, ma.y - mb.y, ma.z - mb.z)));
    if (code) out.codes.push(code);
    if (code === CAP_HARD) captureHarden(g, sc.s, sc.A, sc.B, io);
    if (sc.s.latched && sc.s.phase === 'soft') {
      const st = sc.s.stroke, r = sc.s.rot;
      const E = ke + 0.5 * RING_K * (st.x * st.x + st.y * st.y + st.z * st.z) + 0.5 * RING_KT * (r.x * r.x + r.y * r.y + r.z * r.z);
      if (Number.isFinite(prevE) && E > prevE) out.energyUp = Math.max(out.energyUp, (E - prevE) / prevE);
      prevE = E;
    } else prevE = NaN;
    if (sc.s.engaged || sc.s.latched) out.maxComp = Math.max(out.maxComp, sc.s.stroke.z);
    if (hh === Q) {
      // felt at the seat: (Δv + Δω × r)/h
      const w1 = rot(sc.A.q, sc.A.w), r = rot(sc.A.q, SEAT);
      const dw = v3(w1.x - w0.x, w1.y - w0.y, w1.z - w0.z), dwr = cross(dw, r);
      const a = len(v3(sc.A.v.x - v0.x + dwr.x, sc.A.v.y - v0.y + dwr.y, sc.A.v.z - v0.z + dwr.z)) / hh;
      out.peakAcc = Math.max(out.peakAcc, a);
    }
    onStep?.(sc, t);
    const m = momenta(sc);
    out.dP = Math.max(out.dP, len(v3(m.P.x - m0.P.x, m.P.y - m0.P.y, m.P.z - m0.P.z)));
    out.dL = Math.max(out.dL, len(v3(m.L.x - m0.L.x, m.L.y - m0.L.y, m.L.z - m0.L.z)));
  }
  const d = PORT.dir;
  out.sepSpeed = (sc.A.v.x - sc.B.v.x) * d.x + (sc.A.v.y - sc.B.v.y) * d.y + (sc.A.v.z - sc.B.v.z) * d.z;
  out.t = t;
  return out;
}

describe('soft capture', () => {
  it('a 0.1 m/s centred arrival captures, conserves momentum and settles', () => {
    const r = run(scene(0.1), 20);
    expect(r.codes[0]).toBe(CAP_CAPTURE);
    expect(r.dP / r.P0).toBeLessThan(1e-9);
    expect(r.dL / r.L0).toBeLessThan(1e-9);
    expect(r.maxComp).toBeLessThan(RING_STROKE);
    expect(r.peakAcc).toBeLessThan(0.5);
    console.log(`0.1 m/s: peak stroke ${r.maxComp.toFixed(4)} m, peak seat accel ${r.peakAcc.toFixed(3)} m/s², dP/P ${(r.dP / r.P0).toExponential(1)}, dL/L ${(r.dL / r.L0).toExponential(1)}`);
  });

  it('a 0.3 m/s centred capture stays off the hard stop, peaks below 0.5 m/s² at the seat, matches the oscillator and dissipates', () => {
    const r = run(scene(0.3), 30);
    expect(r.codes[0]).toBe(CAP_CAPTURE);
    expect(r.maxComp).toBeLessThan(RING_STROKE);
    expect(r.peakAcc).toBeLessThan(0.5);
    // analytic peak of a damped oscillator released at x = 0 with v0: v0/ω · exp(−ζ/√(1−ζ²)·atan(√(1−ζ²)/ζ)), m = ship
    const w = Math.sqrt(RING_K / SHIP_M), zr = Math.sqrt(1 - RING_ZETA * RING_ZETA);
    const xp = (0.3 / w) * Math.exp((-RING_ZETA / zr) * Math.atan(zr / RING_ZETA));
    expect(Math.abs(r.maxComp - xp) / xp).toBeLessThan(0.12);
    expect(r.energyUp).toBeLessThan(1e-9);
    expect(r.dP / r.P0).toBeLessThan(1e-9);
    expect(r.dL / r.L0).toBeLessThan(1e-9);
    console.log(`0.3 m/s: peak stroke ${r.maxComp.toFixed(4)} m (1-D analytic ${xp.toFixed(4)}), seat ${r.peakAcc.toFixed(3)} m/s², energy never rises (max rel +${r.energyUp.toExponential(1)}), dP/P ${(r.dP / r.P0).toExponential(1)}, dL/L ${(r.dL / r.L0).toExponential(1)}`);
  });

  it('0.5 m/s and 1 m/s arrivals are outside the envelope: no latch, they rebound; 1 m/s bottoms the ring', () => {
    for (const sp of [0.5, 1]) {
      const r = run(scene(sp), 15);
      expect(r.codes).toContain(CAP_CONTACT);
      expect(r.codes).not.toContain(CAP_CAPTURE);
      expect(r.sc.s.latched).toBe(false);
      expect(r.sepSpeed).toBeGreaterThan(0);
      expect(r.dP / r.P0).toBeLessThan(1e-9);
      expect(r.dL / r.L0).toBeLessThan(1e-9);
      if (sp === 1) expect(r.maxComp).toBeGreaterThan(RING_STROKE);
      console.log(`${sp} m/s: rebound ${r.sepSpeed.toFixed(3)} m/s (e = ${(r.sepSpeed / sp).toFixed(3)}), max compression ${r.maxComp.toFixed(3)} m, peak seat ${r.peakAcc.toFixed(2)} m/s²`);
    }
  });

  it('an unarmed latch or a 15° misalignment does not capture', () => {
    expect(run(scene(0.1), 10, false).codes).not.toContain(CAP_CAPTURE);
    expect(run(scene(0.1, 0.02, 0, (15 * Math.PI) / 180), 10).codes).not.toContain(CAP_CAPTURE);
  });

  it('a centred capture goes soft -> retract -> hard with offset <= 5 mm', () => {
    const sc = scene(0.1);
    const g = ringGeom(makeRingGeom(), PORT, COLLAR), io = makeRingIO();
    io.armed = true;
    const phases: string[] = [];
    let t = 0;
    while (t < 400 && !(sc.s.latched && sc.s.phase === 'hard')) {
      const h = captureMaxStep(sc.s) === Infinity ? Q : captureMaxStep(sc.s);
      drift(sc, h); t += h; io.h = h;
      const c = captureStep(g, sc.s, sc.A, sc.B, io);
      if (c === CAP_HARD) captureHarden(g, sc.s, sc.A, sc.B, io);
      const ph = ringPhase(sc.s);
      if (phases[phases.length - 1] !== ph) phases.push(ph);
    }
    expect(phases).toEqual(['free', 'soft', 'retract', 'hard']);
    const off = len(sc.s.stroke) + Math.abs(sc.s.ext);
    expect(off).toBeLessThan(HARD_OFFSET);
    // relative velocity removed by the hardening impulse
    const d = rot(sc.A.q, sc.A.w);
    expect(Math.abs(d.x) + Math.abs(d.y) + Math.abs(d.z)).toBeLessThan(1e-6);
    console.log(`soft -> retract -> hard at t = ${t.toFixed(1)} s, final offset ${(off * 1000).toFixed(2)} mm`);
    void CAP_RETRACT;
  });

  it('an off-centre capture torques the station', () => {
    const r = run(scene(0.2, 0.02, 0.2), 10);
    expect(r.codes[0]).toBe(CAP_CAPTURE);
    expect(len(r.sc.B.w)).toBeGreaterThan(1e-12);
    expect(r.dL / r.L0).toBeLessThan(1e-9);
  });

  it('save -> load -> step is bit-identical mid-capture, and the run is deterministic', () => {
    const steps = (sc: Scene, n: number): void => {
      const g = ringGeom(makeRingGeom(), PORT, COLLAR), io = makeRingIO();
      io.armed = true;
      for (let i = 0; i < n; i++) { drift(sc, Q); io.h = Q; captureStep(g, sc.s, sc.A, sc.B, io); }
    };
    const a = scene(0.25, 0.02, 0.1, 0.05);
    steps(a, 300);
    const snap = JSON.stringify({ A: a.A, B: a.B, s: saveCapture(a.s) });
    const o = JSON.parse(snap);
    const b: Scene = { A: o.A, B: o.B, s: loadCapture(o.s) };
    steps(a, 500); steps(b, 500);
    expect(JSON.stringify({ A: b.A, B: b.B, s: saveCapture(b.s) })).toBe(JSON.stringify({ A: a.A, B: a.B, s: saveCapture(a.s) }));
    const c = scene(0.25, 0.02, 0.1, 0.05);
    steps(c, 800);
    expect(JSON.stringify(c.A)).toBe(JSON.stringify(a.A));
    // loader defaults
    const d = loadCapture(undefined);
    expect(d.latched).toBe(false);
    expect(d.engaged).toBe(false);
    expect(d.ext).toBe(RING_EXT);
  });
});

describe('latch loads while docked', () => {
  const m = { ship: SHIP_M, station: MP.mass };
  it('RCS along the collar axis holds, the main drive (shear) breaks it, and the break releases stored energy', () => {
    const L = makeLatchLoad();
    latchLoad(L, v3(0, 68e3, 0), v3(), COLLAR, m);
    expect(L.broken).toBe(false);
    expect(L.axial).toBeCloseTo(68e3 * (MP.mass / (MP.mass + SHIP_M)), 3);
    latchLoad(L, v3(0, 0, -800e3), v3(), COLLAR, m);
    expect(L.broken).toBe(true);
    expect(L.shear).toBeGreaterThan(5e4);
    const vs = latchBreakSpeed(L, m);
    expect(vs).toBeGreaterThan(0);
    // stored energy F²/2k equals the separation kinetic energy ½μv²
    const mu = (SHIP_M * MP.mass) / (SHIP_M + MP.mass);
    expect(0.5 * mu * vs * vs).toBeCloseTo((L.axial ** 2 + L.shear ** 2) / 2e7, 3);
  });
  it('a ring overload during soft capture releases the latches', () => {
    const sc = scene(0.1);
    const g = ringGeom(makeRingGeom(), PORT, COLLAR), io = makeRingIO();
    io.armed = true;
    let broke = false;
    for (let i = 0; i < 600 && !broke; i++) {
      drift(sc, Q); io.h = Q;
      // after capture, shove the ship sideways at 4 m/s (a collision while latched)
      if (i === 240) { sc.A.v.y += 4; }
      broke = captureStep(g, sc.s, sc.A, sc.B, io) === CAP_BREAK;
    }
    expect(broke).toBe(true);
    expect(sc.s.latched).toBe(false);
  });
});
