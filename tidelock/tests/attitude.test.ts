// W2-B attitude core: the rotation ODE with CMG momentum and gravity gradient (src/world/attitude.ts) and the CMG
// pack's desaturation / hand-over / save-load (src/world/cmg.ts).
import { describe, expect, it } from 'vitest';
import type { Quat, V3 } from '../src/core/types';
import { SHIP_LAYOUTS } from '../src/data/shipLayouts';
import {
  DESAT_DT_MAX, HOLD_DT_MAX, MODE_FREE, MODE_HOLD, RI_DT, RI_DTMAX, RI_FF, RI_IX, RI_IY, RI_IZ, RI_MODE, RI_MU,
  RI_OMX, RI_OMY, RI_OMZ, RI_QRW, RI_QRX, RI_QRY, RI_QRZ, RI_RX, RI_RY, RI_RZ, RI_TEY, RI_TJX, RI_TJY, RI_TJZ, RI_VX,
  RI_VY, RI_VZ, RO_BAD, RO_CUT, RO_ERR, RO_GGX, RO_GGY, RO_GGZ, RO_OVER, RO_SAT, RO_STEPS, RI_HRY, RI_TEX, RI_TEZ,
  RI_UMAX, RI_WN, ROT_NS_MAX, ggEquilibrium, ggTorque, makeRotIn, makeRotOut, matToQuat, pitchLibration, rotateGyrostat,
  rotateHeld,
} from '../src/world/attitude';
import {
  CMG_H_AXIS, CMG_OVER_TOL, CMG_TAU_AXIS, DESAT_MIN_T, DESAT_RETRY, cmgAfterRotate, cmgHoldUpdate, cmgPower,
  cmgSlewLimits, cmgTakesHold, configureCmg, desatApply, desatBlocked, desatCutDt, desatUpdate, ggMomentumSwing,
  loadCmgState, makeCmgState, saveCmgState, type CmgState,
} from '../src/world/cmg';
import { STATION_LAYOUTS } from '../src/data/stationLayouts';
import { gyrostatFree, initRotor, stationMassProps } from '../src/world/stations';
import {
  IN_IX, IN_IY, IN_IZ, IN_M, IN_RCS, IN_WX, IN_WY, IN_WZ, buildJetTable, jetsFromLayout, jetsStep, makeStepIn,
  makeThrustOut, torqueToCmd,
} from '../src/world/jets';
import { qRot, qRotInv } from '../src/world/math';

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });

/**
 * Count V8 garbage collections while `fn` runs (as tests/jets.test.ts), after one warm-up run of the same `fn`: a
 * fresh closure starts in the interpreter, and the scavenges it causes in its first few ms (measured: all within the
 * first 60 ms of a 400 ms window, none after) are the test driver's, not the code under test's.
 */
async function gcCount(fn: () => void): Promise<number> {
  fn();
  const starts: number[] = [];
  const obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) starts.push(e.startTime); });
  obs.observe({ entryTypes: ['gc'] });
  const t0 = performance.now();
  fn();
  const t1 = performance.now();
  await new Promise((r) => setTimeout(r, 50));
  obs.disconnect();
  return starts.filter((t) => t >= t0 && t <= t1).length;
}
const MU = 1.1 * 3.986004418e14; // Wick-like
const RORB = 6.9e6;
const N = Math.sqrt(MU / (RORB * RORB * RORB));
// The Wren: 62.2 t, 19 × 6.6 × 32 m box gyration.
const MASS = 62200;
const I_WREN = v(MASS * (6.6 * 6.6 + 32 * 32) / 12, MASS * (19 * 19 + 32 * 32) / 12, MASS * (19 * 19 + 6.6 * 6.6) / 12);

/** Circular prograde orbit in XZ (orbit normal +Y), like setup.ts circularState. */
function orbit(t: number, r: V3, vel: V3): void {
  const c = Math.cos(N * t), s = Math.sin(N * t), vc = N * RORB;
  r.x = RORB * c; r.y = 0; r.z = -RORB * s;
  vel.x = -vc * s; vel.y = 0; vel.z = -vc * c;
}
function setOrbit(ri: Float64Array, t: number): void {
  const r = v(0, 0, 0), vel = v(0, 0, 0);
  orbit(t, r, vel);
  ri[RI_RX] = r.x; ri[RI_RY] = r.y; ri[RI_RZ] = r.z; ri[RI_VX] = vel.x; ri[RI_VY] = vel.y; ri[RI_VZ] = vel.z;
}
function setI(ri: Float64Array, I: V3): void { ri[RI_IX] = I.x; ri[RI_IY] = I.y; ri[RI_IZ] = I.z; }
/** LVLH frame at t: columns R (radial), T (along-track), N (+Y). */
function lvlh(t: number): [V3, V3, V3] {
  const r = v(0, 0, 0), vel = v(0, 0, 0);
  orbit(t, r, vel);
  const R = v(r.x / RORB, 0, r.z / RORB), Nn = v(0, 1, 0);
  const T = v(Nn.y * R.z - Nn.z * R.y, Nn.z * R.x - Nn.x * R.z, Nn.x * R.y - Nn.y * R.x);
  return [R, T, Nn];
}
const qmul = (a: Quat, b: Quat): Quat => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});
const qaxis = (ax: V3, ang: number): Quat => ({ x: ax.x * Math.sin(ang / 2), y: ax.y * Math.sin(ang / 2), z: ax.z * Math.sin(ang / 2), w: Math.cos(ang / 2) });
function totalH(q: Quat, w: V3, h: V3, I: V3): V3 {
  const o = v(0, 0, 0);
  return qRot(o, q, I.x * w.x + h.x, I.y * w.y + h.y, I.z * w.z + h.z);
}
function setRef(ri: Float64Array, q: Quat, om: V3): void {
  ri[RI_QRX] = q.x; ri[RI_QRY] = q.y; ri[RI_QRZ] = q.z; ri[RI_QRW] = q.w;
  ri[RI_OMX] = om.x; ri[RI_OMY] = om.y; ri[RI_OMZ] = om.z;
}

describe('rotation ODE with stored momentum', () => {
  it('conserves total angular momentum I·ω + h while the CMGs exchange momentum with the body', () => {
    const ri = makeRotIn(), ro = makeRotOut();
    setI(ri, I_WREN); configureCmg(ri); ri[RI_MODE] = MODE_HOLD;
    const q = qaxis(v(0.6, 0.8, 0), 0.3), w = v(2e-4, -1e-4, 3e-4), h = v(3000, -2000, 1000);
    setRef(ri, { x: 0, y: 0, z: 0, w: 1 }, v(0, 0, 0));
    const H0 = totalH(q, w, h, I_WREN);
    const h0 = { ...h };
    let maxOver = 0;
    for (let i = 0; i < 300; i++) { ri[RI_DT] = 10; rotateHeld(w, q, h, ri, ro); maxOver = Math.max(maxOver, ro[RO_OVER]); }
    const H1 = totalH(q, w, h, I_WREN);
    const dH = Math.hypot(H1.x - H0.x, H1.y - H0.y, H1.z - H0.z) / Math.hypot(H0.x, H0.y, H0.z);
    console.log(`L conservation over 3000 s of CMG hold: |ΔH|/|H| = ${dH.toExponential(2)}; h moved ${Math.hypot(h.x - h0.x, h.y - h0.y, h.z - h0.z).toFixed(0)} N·m·s; final err ${ro[RO_ERR].toExponential(2)} rad`);
    expect(dH).toBeLessThan(1e-7);
    expect(Math.hypot(h.x - h0.x, h.y - h0.y, h.z - h0.z)).toBeGreaterThan(1000); // momentum really moved
    expect(ro[RO_ERR]).toBeLessThan(1e-6); // and the hold converged to identity
  });

  it('conserves L torque-free in free mode with a rotor (gyrostat)', () => {
    const ri = makeRotIn(), ro = makeRotOut();
    setI(ri, v(3e10, 5e10, 3.2e10)); ri[RI_MODE] = MODE_FREE;
    ri[17] = 0; ri[18] = 4e9; ri[19] = 0; // RI_HRY rotor
    const q = qaxis(v(1, 0, 0), 0.2), w = v(1e-3, 2e-3, -5e-4), h = v(0, 0, 0);
    const I = v(3e10, 5e10, 3.2e10);
    const tot = (): V3 => totalH(q, w, v(0, 4e9, 0), I);
    const H0 = tot();
    for (let i = 0; i < 200; i++) { ri[RI_DT] = 5; rotateHeld(w, q, h, ri, ro); }
    const H1 = tot();
    const dH = Math.hypot(H1.x - H0.x, H1.y - H0.y, H1.z - H0.z) / Math.hypot(H0.x, H0.y, H0.z);
    expect(dH).toBeLessThan(1e-10);
  });

  it('gravity-gradient pitch libration period matches 2π/(n·√(3(I_t − I_r)/I_n)) within 2%', () => {
    const ri = makeRotIn(), ro = makeRotOut();
    // body x radial (smallest), y along-track, z orbit normal (largest): the stable LVLH attitude.
    const I = v(2.1e6, 5.5e6, 7.2e6);
    setI(ri, I); ri[RI_MU] = MU; ri[RI_MODE] = MODE_FREE;
    const [R, T, Nn] = lvlh(0);
    const q0 = matToQuat(R, T, Nn, { x: 0, y: 0, z: 0, w: 1 });
    const q = qmul(qaxis(Nn, 0.02), q0); // 0.02 rad pitch offset about the orbit normal
    const w = v(0, 0, N), h = v(0, 0, 0);
    const span = 20;
    let prev = 0, t = 0, steps = 0;
    const cross: number[] = [];
    const bx = v(0, 0, 0);
    for (let i = 0; i < 40000 && cross.length < 7; i++) {
      setOrbit(ri, t); ri[RI_DT] = span; rotateHeld(w, q, h, ri, ro); t += span; steps += ro[RO_STEPS];
      const [R1, T1] = lvlh(t);
      qRot(bx, q, 1, 0, 0);
      const th = Math.atan2(bx.x * T1.x + bx.y * T1.y + bx.z * T1.z, bx.x * R1.x + bx.y * R1.y + bx.z * R1.z);
      if (i > 0 && prev < 0 && th >= 0) cross.push(t - span * (th / (th - prev)));
      prev = th;
    }
    const period = (cross[cross.length - 1] - cross[0]) / (cross.length - 1);
    const expect_ = (2 * Math.PI) / pitchLibration(N, I.y, I.x, I.z);
    console.log(`pitch libration: ${(period / 60).toFixed(2)} min, analytic ${(expect_ / 60).toFixed(2)} min, ${(steps / (t / span)).toFixed(1)} sub-steps per 20 s span`);
    expect(Math.abs(period / expect_ - 1)).toBeLessThan(0.02);
    // The Wren's numbers from the plan: pitching about its x axis, roll axis radial, yaw axis along-track: ≈ 57 min.
    const wren = (2 * Math.PI) / pitchLibration(2 * Math.PI / (94.5 * 60), I_WREN.y, I_WREN.z, I_WREN.x) / 60;
    expect(wren).toBeGreaterThan(54); expect(wren).toBeLessThan(60);
  });

  it('ggTorque is the torque rotateHeld integrates, and peaks near 10 N·m for the Wren', () => {
    const ri = makeRotIn(), ro = makeRotOut();
    setI(ri, I_WREN); ri[RI_MU] = MU; ri[RI_MODE] = MODE_FREE; setOrbit(ri, 0);
    const q = qaxis(v(0, 0.6, 0.8), 0.7), w = v(0, 0, 0), h = v(0, 0, 0);
    const b = v(0, 0, 0), tq = v(0, 0, 0);
    qRotInv(b, q, ri[RI_RX], ri[RI_RY], ri[RI_RZ]);
    ggTorque(tq, MU, b.x, b.y, b.z, I_WREN.x, I_WREN.y, I_WREN.z);
    ri[RI_DT] = 1e-3; rotateHeld(w, q, h, ri, ro);
    expect(Math.abs(ro[RO_GGX] - tq.x)).toBeLessThan(1e-6 * Math.hypot(tq.x, tq.y, tq.z) + 1e-12);
    expect(Math.abs(ro[RO_GGY] - tq.y)).toBeLessThan(1e-6 * Math.hypot(tq.x, tq.y, tq.z) + 1e-12);
    expect(Math.abs(ro[RO_GGZ] - tq.z)).toBeLessThan(1e-6 * Math.hypot(tq.x, tq.y, tq.z) + 1e-12);
    // peak over attitudes: 1.5·n²·ΔI at 45° in the yaw–roll plane
    let peak = 0;
    for (let a = 0; a < Math.PI; a += 0.01) {
      ggTorque(tq, MU, RORB * Math.cos(a), 0, RORB * Math.sin(a), I_WREN.x, I_WREN.y, I_WREN.z);
      peak = Math.max(peak, Math.hypot(tq.x, tq.y, tq.z));
    }
    expect(peak).toBeGreaterThan(5); expect(peak).toBeLessThan(12);
  });
});

describe('CMG pack: saturation, desaturation, hand-over', () => {
  it('saturates at h_max under a constant disturbance, then reports unmet demand and the body starts to turn', () => {
    const ri = makeRotIn(), ro = makeRotOut();
    setI(ri, I_WREN); configureCmg(ri); ri[RI_MODE] = MODE_HOLD; setRef(ri, { x: 0, y: 0, z: 0, w: 1 }, v(0, 0, 0));
    ri[RI_TEY] = 300;
    const q = { x: 0, y: 0, z: 0, w: 1 }, w = v(0, 0, 0), h = v(0, 0, 0);
    let tSat = -1, t = 0, hMaxSeen = 0, hAtSat = 0;
    for (let i = 0; i < 200; i++) {
      ri[RI_DT] = 1; rotateHeld(w, q, h, ri, ro); t += 1;
      hMaxSeen = Math.max(hMaxSeen, Math.abs(h.y));
      if (tSat < 0 && ro[RO_OVER] > 1) { tSat = t; hAtSat = h.y; }
    }
    console.log(`saturation: unmet demand from t = ${tSat} s (h_y = ${h.y.toFixed(0)}), final error ${(ro[RO_ERR] * 180 / Math.PI).toFixed(2)}°, sat mask ${ro[RO_SAT]}`);
    expect(tSat).toBeGreaterThan(30); expect(tSat).toBeLessThan(45); // 1e4 · 0.98 / 300 ≈ 33 s plus the PD lag
    expect(hAtSat).toBeGreaterThan(0.97 * CMG_H_AXIS);
    expect(hMaxSeen).toBeLessThanOrEqual(CMG_H_AXIS * (1 + 1e-5)); // RK4 overshoot of the soft edge only
    expect(ro[RO_SAT] & 2).toBe(2);
    expect(ro[RO_ERR]).toBeGreaterThan(0.01); // the body now turns: the pack cannot hold
  });

  it('desaturates with the real Wren jets at constant duty: h → 0 in ≥ 15 s, propellant spent, body undisturbed', () => {
    const layout = SHIP_LAYOUTS.wren;
    const jets = jetsFromLayout(layout.rcs);
    const T = buildJetTable(jets, v(0, 0, 0));
    const inp = makeStepIn(), o = makeThrustOut(), duty = new Float64Array(jets.length), cmd = new Float64Array(6);
    inp[IN_RCS] = 1500; inp[IN_M] = MASS; inp[IN_IX] = I_WREN.x; inp[IN_IY] = I_WREN.y; inp[IN_IZ] = I_WREN.z;
    const ri = makeRotIn(), ro = makeRotOut();
    setI(ri, I_WREN); configureCmg(ri); ri[RI_MODE] = MODE_HOLD; setRef(ri, { x: 0, y: 0, z: 0, w: 1 }, v(0, 0, 0));
    const s = makeCmgState(v(-2000, 8500, 1500));
    const q = { x: 0, y: 0, z: 0, w: 1 }, w = v(0, 0, 0);
    let t = 0, rcs = 1500, started = -1, ended = -1, maxErr = 0, maxW = 0, spans = 0, dutyMax = 0;
    const h0 = { ...s.h };
    for (let i = 0; i < 200 && ended < 0; i++) {
      const on = desatUpdate(s, t, rcs > 0);
      if (on && started < 0) started = t;
      if (!on && started >= 0) { ended = t; break; }
      ri[RI_DT] = 10; ri[RI_DTMAX] = HOLD_DT_MAX; ri[RI_FF] = 0; ri[RI_TJX] = ri[RI_TJY] = ri[RI_TJZ] = 0;
      if (on) {
        cmd.fill(0); inp[IN_RCS] = rcs; inp[IN_WX] = w.x; inp[IN_WY] = w.y; inp[IN_WZ] = w.z;
        torqueToCmd(T, inp, s.tau, cmd);
        jetsStep(T, cmd, true, inp, duty, o);
        ri[RI_TJX] = o.tx; ri[RI_TJY] = o.ty; ri[RI_TJZ] = o.tz;
        expect(desatApply(s, ri, t)).toBe(true);
        rcs -= o.mdotRcs * ri[RI_DT];
        for (let j = 0; j < duty.length; j++) dutyMax = Math.max(dutyMax, duty[j]);
        spans++;
      }
      rotateHeld(w, q, s.h, ri, ro);
      t += ri[RI_DT];
      maxErr = Math.max(maxErr, ro[RO_ERR]); maxW = Math.max(maxW, Math.hypot(w.x, w.y, w.z));
    }
    const left = (s.h.x * h0.x + s.h.y * h0.y + s.h.z * h0.z) / Math.hypot(h0.x, h0.y, h0.z);
    console.log(`desaturation: ${(ended - started).toFixed(2)} s in ${spans} spans, ${(1500 - rcs).toFixed(2)} kg N2H4, h along h0 ${left.toFixed(2)} N·m·s (|h| ${Math.hypot(s.h.x, s.h.y, s.h.z).toFixed(1)}), max duty ${dutyMax.toExponential(2)}, body err ≤ ${maxErr.toExponential(2)} rad, |ω| ≤ ${maxW.toExponential(2)}`);
    expect(started).toBe(0);
    expect(ended - started).toBeGreaterThanOrEqual(DESAT_MIN_T);
    expect(Math.abs(left)).toBeLessThan(0.01 * Math.hypot(h0.x, h0.y, h0.z));
    expect(1500 - rcs).toBeGreaterThan(0.1);
    expect(maxErr).toBeLessThan(1e-4);
    expect(maxW).toBeLessThan(1e-5);
    expect(spans).toBeLessThan(40);
  });

  it('a stability (inertial) hold with a principal axis on the orbit normal never desaturates over 10 orbits', () => {
    const ri = makeRotIn(), ro = makeRotOut();
    setI(ri, I_WREN); configureCmg(ri); ri[RI_MU] = MU; ri[RI_MODE] = MODE_HOLD;
    // body x (pitch axis) along the orbit normal +Y, rolled 40° about it: GG torque cyclic at 2n.
    const qr = qmul(qaxis(v(0, 1, 0), 0.7), qaxis(v(0, 0, 1), Math.PI / 2));
    setRef(ri, qr, v(0, 0, 0));
    const q = { ...qr }, w = v(0, 0, 0), s = makeCmgState();
    let t = 0, desats = 0, hPeak = 0, steps = 0;
    const span = 0.03 * Math.sqrt(RORB ** 3 / MU); // the translational coast step (ETA = 0.03)
    const tEnd = 10 * 2 * Math.PI / N;
    while (t < tEnd) {
      if (desatUpdate(s, t, true)) desats++;
      setOrbit(ri, t); ri[RI_DT] = span; rotateHeld(w, q, s.h, ri, ro); t += span; steps += ro[RO_STEPS];
      hPeak = Math.max(hPeak, Math.abs(s.h.x), Math.abs(s.h.y), Math.abs(s.h.z));
    }
    const swing = ggMomentumSwing(10, N);
    console.log(`inertial hold, 10 orbits: peak |h_i| ${hPeak.toFixed(0)} N·m·s (plan estimate τ/(2n) = ${swing.toFixed(0)}), ${desats} desaturations, ${(steps / (t / span)).toFixed(1)} sub-steps per ${span.toFixed(1)} s step`);
    expect(desats).toBe(0);
    expect(hPeak).toBeLessThan(0.8 * CMG_H_AXIS);
  });

  it('a misaligned LVLH hold desaturates at the predicted interval and the body stays in the deadband during it', () => {
    const ri = makeRotIn(), ro = makeRotOut();
    setI(ri, I_WREN); configureCmg(ri); ri[RI_MU] = MU; ri[RI_MODE] = MODE_HOLD;
    // A retrograde LVLH hold, misaligned in PITCH (20° about the orbit normal): only the GG torque component along
    // the orbit normal is secular in the inertial frame (the in-plane components turn with the LVLH frame and cycle).
    const [R, T, Nn] = lvlh(0);
    // body x = N (pitch axis on the orbit normal), y = R, z = T (nose −Z retrograde): right-handed, N × R = T.
    const qL = matToQuat(Nn, R, T, { x: 0, y: 0, z: 0, w: 1 });
    const qr = qmul(qaxis(Nn, 0.35), qL);
    const q = { ...qr }, w = v(0, 0, 0), s = makeCmgState();
    const Om = v(0, N, 0);
    qRotInv(w, q, Om.x, Om.y, Om.z);
    // prediction: the pack absorbs c = τ_gg − ω × Iω; the part along ω̂ (= body x = N) accumulates secularly
    const b = v(0, 0, 0), tg = v(0, 0, 0);
    qRotInv(b, q, RORB * Math.cos(0), 0, 0);
    ggTorque(tg, MU, b.x, b.y, b.z, I_WREN.x, I_WREN.y, I_WREN.z);
    const Iw = v(I_WREN.x * w.x, I_WREN.y * w.y, I_WREN.z * w.z);
    const ue = v(tg.x - (w.y * Iw.z - w.z * Iw.y), tg.y - (w.z * Iw.x - w.x * Iw.z), tg.z - (w.x * Iw.y - w.y * Iw.x));
    const tPred = 0.8 * CMG_H_AXIS / Math.abs(ue.x);
    let t = 0, first = -1;
    const span = 26;
    const starts: number[] = [];
    let maxErrDesat = 0, prevOn = false;
    const tEnd = 4 * 2 * Math.PI / N;
    const qref = { ...qr };
    while (t < tEnd) {
      const on = desatUpdate(s, t, true);
      if (on && !prevOn) starts.push(t);
      prevOn = on;
      // the reference at t: rotate about +Y by n·t
      const qt = qmul(qaxis(v(0, 1, 0), N * t), qref);
      setRef(ri, qt, Om);
      setOrbit(ri, t);
      ri[RI_DT] = span; ri[RI_DTMAX] = HOLD_DT_MAX; ri[RI_FF] = 0; ri[RI_TJX] = ri[RI_TJY] = ri[RI_TJZ] = 0;
      if (on) {
        // ideal jets: exactly the couple (the jet-table path is tested above)
        ri[RI_TJX] = s.tau.x; ri[RI_TJY] = s.tau.y; ri[RI_TJZ] = s.tau.z;
        desatApply(s, ri, t);
      }
      rotateHeld(w, q, s.h, ri, ro);
      t += ri[RI_DT];
      if (on) maxErrDesat = Math.max(maxErrDesat, ro[RO_ERR]);
    }
    first = starts[0];
    const iv = starts.length > 2 ? (starts[starts.length - 1] - starts[1]) / (starts.length - 2) : NaN;
    console.log(`misaligned LVLH hold: |u| ≈ ${Math.hypot(ue.x, ue.y, ue.z).toFixed(2)} N·m; first desaturation at ${first.toFixed(0)} s (predicted ${tPred.toFixed(0)} s); ${starts.length} in 4 orbits, interval ${iv.toFixed(0)} s; error during them ≤ ${maxErrDesat.toExponential(2)} rad`);
    expect(Math.abs(first / tPred - 1)).toBeLessThan(0.1);
    expect(starts.length).toBeGreaterThan(2);
    expect(maxErrDesat).toBeLessThan(1e-3);
  });

  it('hands the hold to the CMGs whenever the pack has the momentum (any turn size), not for fast rates or big torques', () => {
    expect(cmgTakesHold(v(0, 0, 0), I_WREN, v(0, 0, 0))).toBe(true); // a 0.2 rad (or 3 rad) turn from rest: yes
    expect(cmgTakesHold(v(1e-3, 0, 0), I_WREN, v(0, 0, 0))).toBe(true); // 5.5e3 N·m·s to absorb: fits 8e3
    expect(cmgTakesHold(v(0.01, 0, 0), I_WREN, v(0, 0, 0))).toBe(false); // 5.5e4 N·m·s: jets
    expect(cmgTakesHold(v(0, 0, 0), I_WREN, v(9900, 0, 0))).toBe(false); // pack nearly full
    expect(cmgTakesHold(v(-1e-3, 0, 0), I_WREN, v(9900, 0, 0))).toBe(true); // ...but stopping this rate empties it
    expect(cmgTakesHold(v(0, 0, 0), I_WREN, v(0, 0, 0), v(0, 450, 0))).toBe(false); // known torque > 0.8 τ_max
    expect(cmgPower(0)).toBe(400); expect(cmgPower(CMG_TAU_AXIS)).toBe(1600);
  });
});

describe('stations in gravity-gradient equilibrium', () => {
  it('a station started at its equilibrium stays within 1° of LVLH over 10 orbits without a pilot', () => {
    const ri = makeRotIn(), ro = makeRotOut();
    const I = v(4.5e15, 8.1e15, 4.6e15); // a wheel: largest about its main axis (+Y)
    setI(ri, I); ri[RI_MU] = MU; ri[RI_MODE] = MODE_FREE;
    const r = v(0, 0, 0), vel = v(0, 0, 0); orbit(0, r, vel);
    const q = { x: 0, y: 0, z: 0, w: 1 }, w = v(0, 0, 0), h = v(0, 0, 0);
    ggEquilibrium(r, vel, I, q, w);
    const ax = v(0, 0, 0);
    qRot(ax, q, 0, 1, 0);
    expect(ax.y).toBeCloseTo(1, 12); // main axis on the orbit normal
    expect(w.y).toBeCloseTo(N, 15);
    let t = 0, maxAng = 0;
    const span = 26;
    while (t < 10 * 2 * Math.PI / N) {
      setOrbit(ri, t); ri[RI_DT] = span; rotateHeld(w, q, h, ri, ro); t += span;
      const [R, T, Nn] = lvlh(t);
      const qL = matToQuat(R, Nn, v(-T.x, -T.y, -T.z), { x: 0, y: 0, z: 0, w: 1 }); // x → R (min), y → N (max), z → −T
      const d = Math.abs(qL.x * q.x + qL.y * q.y + qL.z * q.z + qL.w * q.w);
      maxAng = Math.max(maxAng, 2 * Math.acos(Math.min(1, d)));
    }
    console.log(`station equilibrium: max deviation from LVLH over 10 orbits ${(maxAng * 180 / Math.PI).toExponential(2)}°`);
    expect(maxAng).toBeLessThan(Math.PI / 180);
  });
});

describe('determinism, save/load, cost', () => {
  function scenario(steps: number, st: { q: Quat; w: V3; s: CmgState; t: number }, ri: Float64Array, ro: Float64Array): void {
    for (let i = 0; i < steps; i++) {
      const on = desatUpdate(st.s, st.t, true);
      setOrbit(ri, st.t);
      ri[RI_DT] = 26; ri[RI_DTMAX] = HOLD_DT_MAX; ri[RI_FF] = 0; ri[RI_TJX] = ri[RI_TJY] = ri[RI_TJZ] = 0;
      if (on) { ri[RI_TJX] = st.s.tau.x; ri[RI_TJY] = st.s.tau.y; ri[RI_TJZ] = st.s.tau.z; desatApply(st.s, ri, st.t); }
      rotateHeld(st.w, st.q, st.s.h, ri, ro);
      st.t += ri[RI_DT];
    }
  }
  function setup(): { ri: Float64Array; ro: Float64Array } {
    const ri = makeRotIn(), ro = makeRotOut();
    setI(ri, I_WREN); configureCmg(ri); ri[RI_MU] = MU; ri[RI_MODE] = MODE_HOLD;
    setRef(ri, qaxis(v(0.48, 0.6, 0.64), 1.1), v(0, 0, 0));
    return { ri, ro };
  }
  it('save → load → step is bit-identical (mid-desaturation included)', () => {
    const A = setup(), B = setup();
    const a = { q: qaxis(v(0.48, 0.6, 0.64), 1.1), w: v(0, 0, 0), s: makeCmgState(v(7900, -100, 0)), t: 0 };
    const b = { q: { ...a.q }, w: { ...a.w }, s: makeCmgState(v(7900, -100, 0)), t: 0 };
    scenario(400, a, A.ri, A.ro);
    scenario(3, b, B.ri, B.ro); // a desaturation is under way now
    expect(b.s.desat || a.s.desat).toBe(true);
    const saved = JSON.stringify({ q: b.q, w: b.w, cmg: saveCmgState(b.s), t: b.t });
    const raw = JSON.parse(saved);
    const c = { q: raw.q as Quat, w: raw.w as V3, s: loadCmgState(raw.cmg), t: raw.t as number };
    const C = setup();
    scenario(397, c, C.ri, C.ro);
    expect(c.q).toEqual(a.q); expect(c.w).toEqual(a.w); expect(c.s).toEqual(a.s); expect(c.t).toBe(a.t);
    const d = loadCmgState(undefined);
    expect(d.desat).toBe(false); expect(d.h).toEqual(v(0, 0, 0));
  });

  it('cost: µs per rotation sub-step (CMG hold + gravity gradient), and no garbage', async () => {
    const { ri, ro } = setup();
    const st = { q: qaxis(v(0.48, 0.6, 0.64), 1.1), w: v(0, 0, 0), h: v(100, 200, 300) };
    setOrbit(ri, 0);
    // h is reset every call: left alone, the inertial hold's gravity gradient fills the pack over the 4e6 s this
    // loop simulates and the bench would time the edge band (0.96 s sub-steps) instead of the settled hold.
    const one = (): void => { st.h.x = 100; st.h.y = 200; st.h.z = 300; ri[RI_DT] = 4; rotateHeld(st.w, st.q, st.h, ri, ro); };
    for (let i = 0; i < 2e4; i++) one();
    let best = Infinity;
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      for (let i = 0; i < 1e5; i++) one();
      best = Math.min(best, (performance.now() - t0) / 1e5 * 1000);
    }
    expect(ro[RO_STEPS]).toBe(1);
    const ri2 = makeRotIn(); setI(ri2, I_WREN); ri2[RI_MODE] = MODE_FREE; ri2[RI_MU] = MU; setOrbit(ri2, 0);
    let bestFree = Infinity;
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      for (let i = 0; i < 1e5; i++) { ri2[RI_DT] = 4; rotateHeld(st.w, st.q, st.h, ri2, ro); }
      bestFree = Math.min(bestFree, (performance.now() - t0) / 1e5 * 1000);
    }
    const gcs = await gcCount(() => { for (let i = 0; i < 1e6; i++) one(); });
    const gcsSat = await gcCount(() => { for (let i = 0; i < 2e5; i++) { ri[RI_DT] = 4; rotateHeld(st.w, st.q, st.h, ri, ro); } }); // pack filling up, edge band
    const r2 = makeRotIn(), o2 = makeRotOut(); setI(r2, v(1.05e14, 1.98e14, 1.05e14)); r2[RI_HRY] = 2.9e13; r2[RI_MU] = MU; setOrbit(r2, 0);
    const q2 = { x: 0, y: 0, z: 0, w: 1 }, w2 = v(0, N, 0);
    const gcsGyro = await gcCount(() => { for (let i = 0; i < 5e5; i++) { r2[RI_DT] = 26; rotateGyrostat(w2, q2, r2, o2); } });
    console.log(`GCs: ${gcs} settled hold (1e6 calls), ${gcsSat} filling/edge (2e5), ${gcsGyro} rotateGyrostat (5e5)`);
    expect(gcsSat).toBe(0); expect(gcsGyro).toBe(0);
    expect(gcs).toBe(0);
    console.log(`rotateHeld: ${gcs} GCs in 1e6 calls; ${best.toFixed(3)} µs per 4 s sub-step (hold + GG), ${bestFree.toFixed(3)} µs free + GG (node); 1e4 sleep warp ≈ ${(1e4 / 60 / 4 * best / 1000).toFixed(3)} ms per frame`);
    expect(best).toBeLessThan(20); // wall-clock backstop only
    // one real minute of sleep at 1e4 (6e5 s): a misaligned LVLH hold with gravity gradient and desaturations, the
    // rotation core alone at the 26 s translational coast step
    {
      const r2 = makeRotIn(), o2 = makeRotOut();
      setI(r2, I_WREN); configureCmg(r2); r2[RI_MU] = MU; r2[RI_MODE] = MODE_HOLD;
      const qr = qaxis(v(0, 1, 0), 0.35);
      const st2 = { q: { ...qr }, w: v(0, N, 0), s: makeCmgState() };
      let t = 0, des = 0, prev = false, steps = 0;
      const t0 = performance.now();
      while (t < 6e5) {
        const on = desatUpdate(st2.s, t, true); if (on && !prev) des++; prev = on;
        setRef(r2, qmul(qaxis(v(0, 1, 0), N * t), qr), v(0, N, 0)); setOrbit(r2, t);
        r2[RI_DT] = 26; r2[RI_DTMAX] = HOLD_DT_MAX; r2[RI_FF] = 0; r2[RI_TJX] = r2[RI_TJY] = r2[RI_TJZ] = 0;
        if (on) { r2[RI_TJX] = st2.s.tau.x; r2[RI_TJY] = st2.s.tau.y; r2[RI_TJZ] = st2.s.tau.z; desatApply(st2.s, r2, t); }
        rotateHeld(st2.w, st2.q, st2.s.h, r2, o2); t += r2[RI_DT]; steps += o2[RO_STEPS];
      }
      const ms = performance.now() - t0;
      console.log(`1 real minute at 1e4 (6e5 s, misaligned LVLH hold, GG): ${des} desaturations, ${steps} sub-steps, ${ms.toFixed(1)} ms CPU in node = ${(ms / 3600).toFixed(4)} ms per 60 fps frame`);
      // plan: ≤ 0.1 ms per frame with desaturations. Wall-clock backstop ×5 (shared, loaded test machines); the work
      // is pinned by the sub-step count below, which does not depend on the machine.
      expect(ms / 3600).toBeLessThan(0.5);
      expect(steps / 3600).toBeLessThan(60); // sub-steps per 60 fps frame at 1e4: plan ≈ 42 (4 s hold steps) + desaturations
    }
    void DESAT_DT_MAX; void RI_OMX; void RI_OMY; void RI_OMZ;
  });
});

describe('review fixes: slews, hand-over, desaturation without jets, the soft edge, guards', () => {
  const qang = (a: Quat, b: Quat): number => { const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w); return 2 * Math.acos(Math.min(1, d)); };

  it('a 30° turn of any axis runs on the CMGs alone: torque-limited spin-up, momentum-limited rate, never handed to the jets', () => {
    const rows: string[] = [];
    for (const [name, ax] of [['pitch (x)', v(1, 0, 0)], ['yaw (y)', v(0, 1, 0)], ['roll (z)', v(0, 0, 1)]] as const) {
      const ri = makeRotIn(), ro = makeRotOut();
      setI(ri, I_WREN); configureCmg(ri); ri[RI_MODE] = MODE_HOLD;
      const target = qaxis(ax, 30 * Math.PI / 180);
      setRef(ri, target, v(0, 0, 0));
      const q = { x: 0, y: 0, z: 0, w: 1 }, w = v(0, 0, 0), s = makeCmgState();
      expect(cmgHoldUpdate(s, true, w, I_WREN)).toBe(true);
      const H0 = totalH(q, w, s.h, I_WREN);
      let t = 0, maxOver = 0, hPeak = 0, t05 = -1, uFirst = 0, wPeak = 0;
      for (let i = 0; i < 80; i++) {
        cmgHoldUpdate(s, true, w, I_WREN);
        expect(s.onCmg).toBe(true);
        cmgSlewLimits(ri, s.h, w);
        ri[RI_DT] = 26; rotateHeld(w, q, s.h, ri, ro); cmgAfterRotate(s, ro);
        if (i === 0) uFirst = ro[2];
        t += 26;
        maxOver = Math.max(maxOver, ro[RO_OVER]);
        hPeak = Math.max(hPeak, Math.abs(s.h.x), Math.abs(s.h.y), Math.abs(s.h.z));
        wPeak = Math.max(wPeak, Math.hypot(w.x, w.y, w.z));
        if (t05 < 0 && qang(q, target) < 0.5 * Math.PI / 180) t05 = t;
      }
      const H1 = totalH(q, w, s.h, I_WREN);
      const I = ax.x ? I_WREN.x : ax.y ? I_WREN.y : I_WREN.z;
      const wl = 0.9 * CMG_H_AXIS / I;
      rows.push(`${name}: rate ${wPeak.toExponential(2)} (limit ${wl.toExponential(2)}) rad/s, within 0.5° at ${t05} s (θ/ω_lim ${(0.5236 / wl).toFixed(0)} s), peak |h| ${hPeak.toFixed(0)}, max over ${maxOver.toFixed(2)} N·m, mean |u| first step ${uFirst.toFixed(0)} N·m, |ΔL| ${Math.hypot(H1.x - H0.x, H1.y - H0.y, H1.z - H0.z).toExponential(1)}`);
      expect(maxOver).toBeLessThan(CMG_OVER_TOL * CMG_TAU_AXIS);
      expect(uFirst).toBeGreaterThan(0.5 * CMG_TAU_AXIS); // torque-limited spin-up at the start
      expect(hPeak).toBeLessThan(0.9 * CMG_H_AXIS * 1.001);
      expect(wPeak).toBeLessThan(wl * 1.001);
      expect(t05).toBeGreaterThan(0.5236 / wl); expect(t05).toBeLessThan(0.5236 / wl + 200);
      expect(qang(q, target)).toBeLessThan(1e-3);
      expect(s.onCmg).toBe(true);
    }
    console.log(rows.join('\n'));
  });

  it('a disturbance above τ_max hands the hold to the jets at once (losing), not only at the momentum edge', () => {
    const ri = makeRotIn(), ro = makeRotOut();
    setI(ri, I_WREN); configureCmg(ri); ri[RI_MODE] = MODE_HOLD; setRef(ri, { x: 0, y: 0, z: 0, w: 1 }, v(0, 0, 0));
    ri[RI_TEY] = 600;
    const q = { x: 0, y: 0, z: 0, w: 1 }, w = v(0, 0, 0), s = makeCmgState();
    cmgHoldUpdate(s, true, w, I_WREN);
    let t = 0;
    while (s.onCmg && t < 100) { ri[RI_DT] = 4; rotateHeld(w, q, s.h, ri, ro); cmgAfterRotate(s, ro); t += 4; }
    console.log(`600 N·m disturbance: handed to the jets after ${t} s, |h_y| ${Math.abs(s.h.y).toFixed(0)} N·m·s, over ${ro[RO_OVER].toFixed(0)} N·m`);
    expect(s.onCmg).toBe(false);
    // a PD loop builds its demand within ≈ 1/ω_n = 20 s; it is handed over before the pack reaches its edge band
    expect(t).toBeLessThanOrEqual(30);
    expect(Math.abs(s.h.y)).toBeLessThan(0.8 * CMG_H_AXIS);
    expect(ro[RO_SAT]).toBe(0);
  });

  it('the soft momentum edge holds at 4 s sub-steps and 26 s calls (no RK4 overshoot past h_max)', () => {
    const rows: string[] = [];
    for (const dist of [300, 450, 515]) for (const [call, sub] of [[4, 4], [26, 4], [1, 1]]) {
      const ri = makeRotIn(), ro = makeRotOut();
      setI(ri, I_WREN); configureCmg(ri); ri[RI_MODE] = MODE_HOLD; ri[RI_DTMAX] = sub; ri[RI_TEY] = dist;
      const q = { x: 0, y: 0, z: 0, w: 1 }, w = v(0, 0, 0), h = v(0, 0, 0);
      let hm = 0, steps = 0;
      for (let i = 0; i < 400 / call; i++) { ri[RI_DT] = call; rotateHeld(w, q, h, ri, ro); hm = Math.max(hm, Math.abs(h.y)); steps += ro[RO_STEPS]; }
      rows.push(`${dist} N·m, ${call} s calls / ${sub} s sub-steps: max |h_y| ${hm.toFixed(1)} (${steps} sub-steps)`);
      expect(hm).toBeLessThan(CMG_H_AXIS * (1 + 1e-3));
    }
    console.log(rows.join('; '));
  });

  it('a desaturation without jet authority aborts, does not retry before DESAT_RETRY, and never runs 1 s sub-steps', () => {
    const jets = jetsFromLayout(SHIP_LAYOUTS.wren.rcs);
    const T = buildJetTable(jets, v(0, 0, 0));
    const inp = makeStepIn(), o = makeThrustOut(), duty = new Float64Array(jets.length), cmd = new Float64Array(6);
    inp[IN_M] = MASS; inp[IN_IX] = I_WREN.x; inp[IN_IY] = I_WREN.y; inp[IN_IZ] = I_WREN.z;
    const rows: string[] = [];
    for (const [label, rcs, enabled] of [['empty tank', 0, true], ['jets disabled', 1500, false], ['healthy', 1500, true]] as const) {
      const ri = makeRotIn(), ro = makeRotOut();
      setI(ri, I_WREN); configureCmg(ri); ri[RI_MODE] = MODE_HOLD; setRef(ri, { x: 0, y: 0, z: 0, w: 1 }, v(0, 0, 0));
      ri[RI_TEY] = 5;
      const s = makeCmgState(v(-2000, 8500, 1500)); s.onCmg = true;
      const q = { x: 0, y: 0, z: 0, w: 1 }, w = v(0, 0, 0);
      let t = 0, starts = 0, aborts = 0, steps = 0, applied = 0, firstEnd = -1, holdCalls = 0, holdSteps = 0;
      for (let n = 0; n < 2000; n++) {
        // jetsOk from the tank only: "jets disabled" is the case the caller did not foresee (a failed table)
        const was = s.desat;
        const on = desatUpdate(s, t, rcs > 0);
        if (on && !was) starts++;
        if (!on && was && firstEnd < 0) firstEnd = t;
        ri[RI_DT] = 26; ri[RI_DTMAX] = HOLD_DT_MAX; ri[RI_FF] = 0; ri[RI_TJX] = ri[RI_TJY] = ri[RI_TJZ] = 0;
        if (on) {
          cmd.fill(0); inp[IN_RCS] = rcs; torqueToCmd(T, inp, s.tau, cmd); jetsStep(T, cmd, enabled, inp, duty, o);
          ri[RI_TJX] = o.tx; ri[RI_TJY] = o.ty; ri[RI_TJZ] = o.tz;
          if (desatApply(s, ri, t)) applied++; else { aborts++; expect(desatBlocked(s, t)).toBe(true); }
        }
        if (s.onCmg) { rotateHeld(w, q, s.h, ri, ro); cmgAfterRotate(s, ro); holdCalls++; holdSteps += ro[RO_STEPS]; } else { ri[RI_MODE] = MODE_FREE; rotateHeld(w, q, s.h, ri, ro); ri[RI_MODE] = MODE_HOLD; }
        steps += ro[RO_STEPS]; t += ri[RI_DT];
        if (label === 'healthy' && firstEnd > 0) break;
      }
      rows.push(`${label}: ${starts} starts, ${aborts} aborts, ${applied} desat spans, ${holdSteps} sub-steps in ${holdCalls} CMG-hold calls, then ${steps - holdSteps} in ${2000 - holdCalls} free-drift calls; ${t.toFixed(0)} s; hold on CMGs at the end: ${s.onCmg}, |h| ${Math.hypot(s.h.x, s.h.y, s.h.z).toFixed(0)}`);
      if (label === 'empty tank') { expect(starts).toBe(0); expect(applied).toBe(0); }
      if (label === 'jets disabled') {
        expect(applied).toBe(0);
        expect(starts).toBe(aborts);
        expect(starts).toBeLessThanOrEqual(Math.ceil(t / DESAT_RETRY) + 1);
      }
      if (label !== 'healthy') {
        expect(s.desat).toBe(false);
        // 4 s hold sub-steps (7 per 26 s), 0.96 s only for the few calls on the approach to the edge band: never 1 s throughout
        expect(holdSteps).toBeLessThanOrEqual(7 * holdCalls + 28 * 6);
        expect(holdCalls).toBeLessThan(40); // the pack fills (5 N·m) and hands over; the ship then drifts, honestly
        expect(s.onCmg).toBe(false); // the pack saturated and handed the hold to the (dry) jets: honest drift
      } else { expect(firstEnd).toBeGreaterThanOrEqual(DESAT_MIN_T); expect(aborts).toBe(0); }
    }
    console.log(rows.join('\n'));
  });

  it('save → load → step is bit-identical across a CMG/jets hand-over (the mode is saved state)', () => {
    type St = { q: Quat; w: V3; s: CmgState; t: number };
    const mk = (): { ri: Float64Array; ro: Float64Array } => {
      const ri = makeRotIn(), ro = makeRotOut();
      setI(ri, I_WREN); configureCmg(ri); ri[RI_MU] = MU; setRef(ri, { x: 0, y: 0, z: 0, w: 1 }, v(0, 0, 0)); ri[RI_TEY] = 5;
      return { ri, ro };
    };
    const run = (n: number, st: St, ri: Float64Array, ro: Float64Array, log?: boolean[]): void => {
      for (let i = 0; i < n; i++) {
        cmgHoldUpdate(st.s, true, st.w, I_WREN);
        desatUpdate(st.s, st.t, false); // dry tank: no desaturation, the pack fills
        setOrbit(ri, st.t);
        ri[RI_DT] = 26; ri[RI_DTMAX] = HOLD_DT_MAX; ri[RI_FF] = 0;
        ri[RI_MODE] = st.s.onCmg ? MODE_HOLD : MODE_FREE;
        if (st.s.onCmg) cmgSlewLimits(ri, st.s.h, st.w);
        rotateHeld(st.w, st.q, st.s.h, ri, ro);
        if (st.s.onCmg) cmgAfterRotate(st.s, ro);
        st.t += ri[RI_DT];
        log?.push(st.s.onCmg);
      }
    };
    const fresh = (): St => ({ q: { x: 0, y: 0, z: 0, w: 1 }, w: v(0, 0, 0), s: makeCmgState(v(0, 7500, 0)), t: 0 });
    const A = mk(), a = fresh(), logA: boolean[] = [];
    run(60, a, A.ri, A.ro, logA);
    const B = mk(), b = fresh();
    run(12, b, B.ri, B.ro);
    // the save point is inside the hysteresis band: on the CMGs, though a fresh decision would refuse them now
    expect(b.s.onCmg).toBe(true);
    expect(cmgTakesHold(b.w, I_WREN, b.s.h)).toBe(false);
    const raw = JSON.parse(JSON.stringify({ q: b.q, w: b.w, cmg: saveCmgState(b.s), t: b.t }));
    const C = mk(), c: St = { q: raw.q, w: raw.w, s: loadCmgState(raw.cmg), t: raw.t };
    run(48, c, C.ri, C.ro);
    expect(logA.indexOf(false)).toBeGreaterThan(12); // the hand-over to the jets happens after the save point
    expect(c.q).toEqual(a.q); expect(c.w).toEqual(a.w); expect(c.s).toEqual(a.s); expect(c.t).toBe(a.t);
    // without the saved mode (an older save) the run takes the other branch: the state is load-bearing
    const old = { ...raw.cmg }; delete old.o;
    const D = mk(), d: St = { q: raw.q, w: raw.w, s: loadCmgState(old), t: raw.t };
    run(48, d, D.ri, D.ro);
    expect(d.q).not.toEqual(a.q);
    expect(loadCmgState({}).onCmg).toBe(false); expect(loadCmgState({}).retryAt).toBe(-Infinity);
  });

  it('sub-steps follow a large constant torque, and bad input is rejected, never stepped', () => {
    const ri = makeRotIn(), ro = makeRotOut();
    setI(ri, I_WREN); ri[RI_MODE] = MODE_FREE; ri[RI_TJX] = 5000;
    const q = { x: 0, y: 0, z: 0, w: 1 }, w = v(0, 0, 0), h = v(0, 0, 0);
    ri[RI_DT] = 60; rotateHeld(w, q, h, ri, ro);
    const exact = 0.5 * 5000 / I_WREN.x * 3600;
    const ang = 2 * Math.atan2(Math.hypot(q.x, q.y, q.z), q.w);
    console.log(`free, τ 5000 N·m, dt 60 s: ${ro[RO_STEPS]} sub-steps, angle ${ang.toFixed(6)} vs exact ${exact.toFixed(6)} rad`);
    expect(Math.abs(ang / exact - 1)).toBeLessThan(1e-6);
    // a huge step: integrated up to ROT_NS_MAX sub-steps, then cut and said
    const q2 = { x: 0, y: 0, z: 0, w: 1 }, w2 = v(0, 0, 0);
    ri[RI_DT] = 1e9; rotateHeld(w2, q2, h, ri, ro);
    expect(ro[RO_CUT]).toBe(1); expect(ro[RO_STEPS]).toBe(ROT_NS_MAX); expect(ri[RI_DT]).toBeLessThan(1e9);
    expect(Math.abs(w2.x / (5000 * ri[RI_DT] / I_WREN.x) - 1)).toBeLessThan(1e-9);
    // dt = Infinity / NaN / 0: no-op; NaN state: untouched
    for (const dt of [Infinity, NaN, 0, -1]) { ri[RI_DT] = dt; const q3 = { ...q }; rotateHeld(w, q3, h, ri, ro); expect(ro[RO_BAD]).toBe(1); expect(q3).toEqual(q); }
    const wn = v(NaN, 0, 0), q4 = { x: 0, y: 0, z: 0, w: 1 }, h4 = v(1, 2, 3);
    ri[RI_DT] = 4; ri[RI_MODE] = MODE_HOLD; rotateHeld(wn, q4, h4, ri, ro);
    expect(ro[RO_BAD]).toBe(2); expect(q4).toEqual({ x: 0, y: 0, z: 0, w: 1 }); expect(h4).toEqual(v(1, 2, 3));
  });
});

describe('the Wheel: gyrostat split (exact drift + gravity-gradient kicks)', () => {
  const mp = stationMassProps(STATION_LAYOUTS.ringHabitat);
  const rot = initRotor(mp.rotor, 0);
  const I = mp.inertia;
  const setup = (): { ri: Float64Array; ro: Float64Array; q: Quat; w: V3 } => {
    const ri = makeRotIn(), ro = makeRotOut();
    setI(ri, I); ri[RI_MU] = MU; ri[RI_MODE] = MODE_FREE; ri[RI_HRY] = rot.rotorH.y;
    const r = v(0, 0, 0), vel = v(0, 0, 0); orbit(0, r, vel);
    const q = { x: 0, y: 0, z: 0, w: 1 }, w = v(0, 0, 0);
    ggEquilibrium(r, vel, I, q, w);
    // a 0.01 rad offset about the orbit normal (+Y: the spin axis) and 0.005 rad about the radial
    const [R] = lvlh(0);
    const q1 = qmul(qaxis(R, 0.005), qmul(qaxis(v(0, 1, 0), 0.01), q));
    return { ri, ro, q: q1, w };
  };

  it('matches the fine RK4 over 2 orbits at 1 drift per 26 s coast step', () => {
    const A = setup(), B = setup();
    let t = 0, maxD = 0, stepsA = 0, stepsB = 0, maxDev = 0;
    const tEnd = 2 * 2 * Math.PI / N;
    while (t < tEnd) {
      setOrbit(A.ri, t); setOrbit(B.ri, t);
      A.ri[RI_DT] = 26; rotateGyrostat(A.w, A.q, A.ri, A.ro); stepsA += A.ro[RO_STEPS];
      const hz = v(0, 0, 0);
      B.ri[RI_DT] = 26; rotateHeld(B.w, B.q, hz, B.ri, B.ro); stepsB += B.ro[RO_STEPS];
      t += 26;
      const d = Math.abs(A.q.x * B.q.x + A.q.y * B.q.y + A.q.z * B.q.z + A.q.w * B.q.w);
      maxD = Math.max(maxD, 2 * Math.acos(Math.min(1, d)));
      const [R, T, Nn] = lvlh(t);
      const qL = matToQuat(R, Nn, v(-T.x, -T.y, -T.z), { x: 0, y: 0, z: 0, w: 1 });
      const e = Math.abs(qL.x * A.q.x + qL.y * A.q.y + qL.z * A.q.z + qL.w * A.q.w);
      maxDev = Math.max(maxDev, 2 * Math.acos(Math.min(1, e)));
    }
    const n = t / 26;
    console.log(`Wheel (I ${[I.x, I.y, I.z].map((x) => x.toExponential(2)).join(', ')}, h_r ${rot.rotorH.y.toExponential(2)}): split ${(stepsA / n).toFixed(1)} vs RK4 ${(stepsB / n).toFixed(1)} sub-steps per 26 s; max attitude difference ${maxD.toExponential(2)} rad over 2 orbits; libration ≤ ${(maxDev * 180 / Math.PI).toFixed(3)}°`);
    expect(stepsA / n).toBe(1);
    expect(maxD).toBeLessThan(2e-4);
    expect(maxDev).toBeLessThan(Math.PI / 180);
  });

  it('is exact torque-free (L conserved to rounding) and costs < 1 µs per 26 s step', () => {
    const A = setup();
    A.ri[RI_MU] = 0;
    A.w.x = 1e-4; A.w.z = -5e-5;
    const L = (): V3 => totalH(A.q, A.w, v(0, rot.rotorH.y, 0), I);
    const L0 = L();
    for (let i = 0; i < 2000; i++) { A.ri[RI_DT] = 26; rotateGyrostat(A.w, A.q, A.ri, A.ro); }
    const L1 = L();
    const dL = Math.hypot(L1.x - L0.x, L1.y - L0.y, L1.z - L0.z) / Math.hypot(L0.x, L0.y, L0.z);
    expect(dL).toBeLessThan(1e-12);
    // the inlined drift is W2-C's gyrostatFree closed form
    const qa = { ...A.q }, wa = { ...A.w }, qb = { ...A.q }, wb = { ...A.w };
    A.ri[RI_DT] = 300; rotateGyrostat(wa, qa, A.ri, A.ro);
    gyrostatFree(qb, wb, I.x, I.y, rot.rotorH.y, 300);
    for (const k of ['x', 'y', 'z', 'w'] as const) expect(Math.abs(qa[k] - qb[k])).toBeLessThan(1e-14);
    for (const k of ['x', 'y', 'z'] as const) expect(Math.abs(wa[k] - wb[k])).toBeLessThan(1e-14 * Math.hypot(wb.x, wb.y, wb.z));
    const B = setup();
    setOrbit(B.ri, 0);
    for (let i = 0; i < 2e4; i++) { B.ri[RI_DT] = 26; rotateGyrostat(B.w, B.q, B.ri, B.ro); }
    let best = Infinity;
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      for (let i = 0; i < 1e5; i++) { B.ri[RI_DT] = 26; rotateGyrostat(B.w, B.q, B.ri, B.ro); }
      best = Math.min(best, (performance.now() - t0) / 1e5 * 1000);
    }
    console.log(`rotateGyrostat: ${best.toFixed(3)} µs per 26 s step (node) = ${(best * 1e4 / 60 / 26 / 1000).toFixed(4)} ms per frame at 1e4; torque-free |ΔL|/|L| ${dL.toExponential(1)}`);
    expect(best).toBeLessThan(20); // wall-clock backstop
    // the pilot law runs in the kicks (MODE_HOLD with a station-scale τ_max)
    const P = setup();
    P.ri[RI_MODE] = MODE_HOLD; P.ri[RI_UMAX] = 1e-6 * I.y; P.ri[RI_WN] = 4 * N; P.ri[RI_DTMAX] = 0.2 / (4 * N);
    const r = v(0, 0, 0), vel = v(0, 0, 0); orbit(0, r, vel);
    const qe = { x: 0, y: 0, z: 0, w: 1 }, we = v(0, 0, 0); ggEquilibrium(r, vel, I, qe, we);
    let t = 0, e1 = 0;
    while (t < 2 * 2 * Math.PI / N) {
      setRef(P.ri, qmul(qaxis(v(0, 1, 0), N * t), qe), v(0, N, 0)); // the LVLH target at the step start
      setOrbit(P.ri, t); P.ri[RI_DT] = 26; rotateGyrostat(P.w, P.q, P.ri, P.ro); t += 26;
      if (e1 === 0 && t > 1000) e1 = P.ro[RO_ERR];
    }
    console.log(`station pilot (τ_max 1e-6·I_max, ω_n 4n) in the kicks: error 1.1e-2 rad at the start, ${e1.toExponential(2)} after 1000 s (pitch about the spin axis removed), ${P.ro[RO_ERR].toExponential(2)} after 2 orbits (roll/yaw precess slowly against the rotor's stiffness); RK4 agrees within 15% (scratch pilot.ts)`);
    expect(e1).toBeLessThan(6e-3);
    expect(P.ro[RO_ERR]).toBeLessThan(e1);
    void RI_TEX; void RI_TEZ;
  });
});
