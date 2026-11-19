// Test rig for W3-A (not a test file): a Wren in free space (no gravity) stepping at the 120 Hz tick through the W3-A
// cores in the order the WIRING headers give — massProps → TVC (60 Hz) → gimbal actuators → engine spool (jets.ts)
// → applyGimbaled → full-tensor rotation (with the liquid's L_int as stored momentum) → propellant draw → slosh →
// massProps → rebaseInternal → flex. The RCS is ideal torque: whatever the TVC leaves of the attitude hold's demand.

import { ENGINE_UNLIT, IN_CX, IN_CY, IN_CZ, IN_H, IN_WX, IN_WY, IN_WZ, engineUpdate, makeStepIn, makeThrustOut, clearThrustOut, type EngineDef } from '../src/world/jets';
import { MP_CX, MP_CY, MP_CZ, MP_IXX, MP_M, RF_DT, RF_HX, RF_HY, RF_HZ, RF_TX, RF_TY, RF_TZ, buildMassModel, drawMain, makeMassOut, makeRotFull, makeTankState, massProps, needsTableRebuild, rebaseInternal, rotateFull, saveMassState, loadMassState, tankDefsFor, eulerAccel, type MassModel, type TankState } from '../src/world/massProps';
import { SI_ALX, SI_AX, SI_CX, SI_H, SI_M, SI_WX, buildSloshModel, internalMomentum, makeSloshIn, makeSloshOut, makeSloshState, sloshStep, loadSloshState, saveSloshState, type SloshModel } from '../src/world/slosh';
import { G_STRIDE, TI_MASK, TI_TX, TI_TY, TI_TZ, applyGimbaled, diffThrottle, gimbalDefs, gimbalStep, loadGimbalState, makeGimbalState, makeTvcIn, makeTvcOut, saveGimbalState, tvcSolve, type GimbalDef } from '../src/world/gimbal';
import { FI_H, FI_M, buildFlexModel, flexAddLoad, flexClear, flexStep, loadFlexState, makeFlexIn, saveFlexState, type FlexModel } from '../src/world/flex';
import { SHIP_LAYOUTS } from '../src/data/shipLayouts';
import type { Quat, V3 } from '../src/core/types';

export const Q = 1 / 120;
/** Ideal RCS torque authority per axis used to express the residual as a duty (Wren: 34 kN pairs, ≈ 13 m / 3.9 m arms). */
export const RCS_AUTH = [0.9e6, 0.9e6, 0.27e6];

export interface RigState {
  tick: number;
  q: Quat;
  w: V3;
  /** System CoM velocity, inertial. */
  v: V3;
  tanks: TankState[];
  slosh: number[];
  gimbal: number[];
  flex: number[];
  engineThrust: number[];
  engineTimer: number[];
  tableCom: V3;
  throttle: number;
}

export interface Rig {
  mass: MassModel;
  sl: SloshModel;
  defs: GimbalDef[];
  fx: FlexModel;
  s: RigState;
  /** Fixed mount (no TVC): the bells stay at their neutral cant. */
  locked: boolean;
  /** Engine k disabled (engine out) when bit k is set. */
  outMask: number;
  /** Run the slosh every n ticks (h = n·Q, the tick's inputs held): the decimated rate the WIRING allows. */
  sloshEvery: number;
  // metrics
  rcsDuty: number; rcsT: number; rebuilds: number; maxTrimErr: number;
}

const ED: EngineDef[] = [];

export function makeRig(opts: { locked?: boolean; outMask?: number; fill?: number } = {}): Rig {
  const mass = buildMassModel('wren', tankDefsFor('wren', 22500, 1500), 42900);
  const tanks = makeTankState(mass, opts.fill ?? 1);
  const mp = makeMassOut();
  massProps(mass, makeTankState(mass, 1), [], [], [], 0, mp);
  const design = { x: mp[MP_CX], y: mp[MP_CY], z: mp[MP_CZ] };
  const defs = gimbalDefs(SHIP_LAYOUTS.wren.engines, design);
  const sl = buildSloshModel(mass);
  const fx = buildFlexModel(mass.zSpan, mass.dryCom.y);
  massProps(mass, tanks, [], [], [], 0, mp);
  return {
    mass, sl, defs, fx, locked: !!opts.locked, outMask: opts.outMask ?? 0, sloshEvery: 1,
    s: {
      tick: 0, q: { x: 0, y: 0, z: 0, w: 1 }, w: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 },
      tanks, slosh: makeSloshState(sl), gimbal: makeGimbalState(defs.length), flex: [0, 0, 0, 0],
      engineThrust: defs.map(() => 0), engineTimer: defs.map(() => ENGINE_UNLIT),
      tableCom: { x: mp[MP_CX], y: mp[MP_CY], z: mp[MP_CZ] }, throttle: 0,
    },
    rcsDuty: 0, rcsT: 0, rebuilds: 0, maxTrimErr: 0,
  };
}

const MP = makeMassOut(), MP2 = makeMassOut();
const inp = makeStepIn();
const O = makeThrustOut();
const mean = new Float64Array(4), dm = new Float64Array(4);
const RF = makeRotFull();
const SI = makeSloshIn(), SO = makeSloshOut();
const TI = makeTvcIn(), TO = makeTvcOut();
const FI = makeFlexIn();
const LD = new Float64Array(6);
const AL = { x: 0, y: 0, z: 0 }, TAU = { x: 0, y: 0, z: 0 }, HV = { x: 0, y: 0, z: 0 };
const RES = new Float64Array(3), LI = new Float64Array(3), BASE = new Float64Array(1);

function qRotTo(q: Quat, x: number, y: number, z: number, out: V3): void {
  const tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
  out.x = x + q.w * tx + (q.y * tz - q.z * ty); out.y = y + q.w * ty + (q.z * tx - q.x * tz); out.z = z + q.w * tz + (q.x * ty - q.y * tx);
}
const FV = { x: 0, y: 0, z: 0 };

/** One 120 Hz tick. Hold: attitude toward identity, ω_n 1.5 rad/s, ζ 0.9 (a stiff rate loop, like control.ts). */
export function rigTick(r: Rig): void {
  const s = r.s, h = Q, n = r.defs.length;
  massProps(r.mass, s.tanks, s.slosh, [], [], 0, MP);
  if (needsTableRebuild(MP, s.tableCom)) { s.tableCom.x = MP[MP_CX]; s.tableCom.y = MP[MP_CY]; s.tableCom.z = MP[MP_CZ]; r.rebuilds++; }
  // controller (60 Hz): torque demand
  if ((s.tick & 1) === 0) {
    const wn = 1.5, ze = 0.9;
    const ex = 2 * Math.sign(s.q.w || 1) * s.q.x, ey = 2 * Math.sign(s.q.w || 1) * s.q.y, ez = 2 * Math.sign(s.q.w || 1) * s.q.z;
    TI[TI_TX] = -MP[MP_IXX] * (wn * wn * ex + 2 * ze * wn * s.w.x);
    TI[TI_TY] = -MP[MP_IXX + 1] * (wn * wn * ey + 2 * ze * wn * s.w.y);
    TI[TI_TZ] = -MP[MP_IXX + 2] * (wn * wn * ez + 2 * ze * wn * s.w.z);
    TI[TI_MASK] = 7;
    const T = s.engineThrust;
    if (r.locked) {
      for (let k = 0; k <= n * G_STRIDE; k++) s.gimbal[k] = 0;
      RES[0] = TI[TI_TX]; RES[1] = TI[TI_TY]; RES[2] = TI[TI_TZ];
      // the engines' own torque about c is a disturbance the RCS must cancel too (computed below per step)
    } else {
      tvcSolve(r.defs, s.gimbal, T, MP, TI, TO);
      RES[0] = TO[0]; RES[1] = TO[1]; RES[2] = TO[2];
    }
  }
  // engines
  inp[IN_H] = h;
  gimbalStep(s.gimbal, n, inp); inp[IN_WX] = s.w.x; inp[IN_WY] = s.w.y; inp[IN_WZ] = s.w.z;
  inp[IN_CX] = MP[MP_CX]; inp[IN_CY] = MP[MP_CY]; inp[IN_CZ] = MP[MP_CZ];
  for (let k = 0; k < n; k++) {
    if (ED.length <= k) ED.push({} as EngineDef);
    const d = r.defs[k], e = ED[k];
    e.pos = d.pivot; e.dir = d.dir0; e.maxThrust = d.maxThrust; e.ve = d.ve; e.tauUp = d.tauUp; e.tauDown = d.tauDown; e.delay = d.delay; e.minThrottle = d.minThrottle;
    BASE[0] = s.throttle;
    diffThrottle(s.gimbal, r.defs, k, BASE, inp);
    engineUpdate(e, s.engineThrust, s.engineTimer, k, (r.outMask & (1 << k)) === 0 && s.tanks.some((t) => t.m > 0), inp, mean);
  }
  clearThrustOut(O);
  applyGimbaled(r.defs, s.gimbal, mean, inp, O);
  // with a fixed mount the RCS also cancels the engines' trim torque (the hold sees it as a disturbance)
  let rx = RES[0], ry = RES[1], rz = RES[2];
  if (r.locked) { rx -= O.tx - O.dx; ry -= O.ty - O.dy; rz -= O.tz - O.dz; }
  if (s.engineThrust.some((x) => x > 0)) {
    r.rcsDuty += (Math.abs(rx) / RCS_AUTH[0] + Math.abs(ry) / RCS_AUTH[1] + Math.abs(rz) / RCS_AUTH[2]) / 3 * h;
    r.rcsT += h;
    const trim = Math.hypot(O.tx - O.dx, O.ty - O.dy, O.tz - O.dz);
    if (s.tick > 600 && !r.locked && trim > r.maxTrimErr) r.maxTrimErr = trim;
  }
  TAU.x = O.tx + rx; TAU.y = O.ty + ry; TAU.z = O.tz + rz;
  // rotation with the liquid's stored momentum
  SI[SI_CX] = MP[MP_CX]; SI[SI_CX + 1] = MP[MP_CY]; SI[SI_CX + 2] = MP[MP_CZ]; SI[SI_M] = MP[MP_M];
  RF[RF_DT] = h; RF[RF_TX] = TAU.x; RF[RF_TY] = TAU.y; RF[RF_TZ] = TAU.z;
  internalMomentum(r.sl, s.tanks, s.slosh, SI, LI);
  RF[RF_HX] = LI[0]; RF[RF_HY] = LI[1]; RF[RF_HZ] = LI[2];
  HV.x = RF[RF_HX]; HV.y = RF[RF_HY]; HV.z = RF[RF_HZ];
  eulerAccel(MP, s.w, TAU, HV, AL);
  rotateFull(s.w, s.q, MP, RF);
  // translation of the system CoM (craft axes force → inertial)
  qRotTo(s.q, O.fx, O.fy, O.fz, FV);
  const m = MP[MP_M];
  s.v.x += (FV.x / m) * h; s.v.y += (FV.y / m) * h; s.v.z += (FV.z / m) * h;
  // propellant
  for (let k = 0; k < n; k++) dm[k] = (mean[k] / r.defs[k].ve) * h;
  drawMain(r.mass, s.tanks, dm, n, true);
  // slosh
  const doSlosh = s.tick % r.sloshEvery === 0;
  SI[SI_H] = h * r.sloshEvery; SI[SI_AX] = O.fx / m; SI[SI_AX + 1] = O.fy / m; SI[SI_AX + 2] = O.fz / m;
  SI[SI_WX] = s.w.x; SI[SI_WX + 1] = s.w.y; SI[SI_WX + 2] = s.w.z;
  SI[SI_ALX] = AL.x; SI[SI_ALX + 1] = AL.y; SI[SI_ALX + 2] = AL.z;
  if (doSlosh) {
    sloshStep(r.sl, s.tanks, s.slosh, SI, SO);
    massProps(r.mass, s.tanks, s.slosh, [], [], 0, MP2);
    rebaseInternal(s.w, MP2, SO, 3, 9);
  } else {
    massProps(r.mass, s.tanks, s.slosh, [], [], 0, MP2);
  }
  // flex: engine forces at their pivots
  FI[FI_H] = h; FI[FI_M] = MP2[MP_M];
  flexClear(FI);
  for (let k = 0; k < n; k++) {
    const F = mean[k];
    if (F === 0) continue;
    const d = r.defs[k], gp = s.gimbal[k * G_STRIDE], gy = s.gimbal[k * G_STRIDE + 1];
    LD[0] = d.pivot.x; LD[1] = d.pivot.y; LD[2] = d.pivot.z;
    // small-angle direction (the load only needs the side force to first order)
    LD[3] = -F * (d.dir0.x + gy * d.dir0.z); LD[4] = -F * (d.dir0.y - gp * d.dir0.z); LD[5] = -F * d.dir0.z;
    flexAddLoad(r.fx, LD, FI, false);
  }
  flexStep(s.flex, r.fx, FI);
  s.tick++;
}

export function rigSave(r: Rig): string {
  const s = r.s;
  return JSON.stringify({
    tick: s.tick, q: s.q, w: s.w, v: s.v, throttle: s.throttle,
    mass: saveMassState({ tanks: s.tanks, tableCom: s.tableCom, tpsMass: [] }),
    slosh: saveSloshState(s.slosh), gimbal: saveGimbalState(s.gimbal), flex: saveFlexState(s.flex),
    engineThrust: s.engineThrust, engineTimer: s.engineTimer
  });
}

/** Load into a FRESH rig (fresh models and caches): everything derived is rebuilt. */
export function rigLoad(json: string, opts: { locked?: boolean; outMask?: number } = {}): Rig {
  const d = JSON.parse(json);
  const r = makeRig(opts);
  const ms = loadMassState(d.mass, r.mass, 0, 0, { x: 0, y: 0, z: 0 });
  const s = r.s;
  s.tick = d.tick; s.q = d.q; s.w = d.w; s.v = d.v; s.throttle = d.throttle;
  s.tanks = ms.tanks; s.tableCom = ms.tableCom;
  s.slosh = loadSloshState(d.slosh, r.sl); s.gimbal = loadGimbalState(d.gimbal, r.defs.length); s.flex = loadFlexState(d.flex);
  s.engineThrust = d.engineThrust; s.engineTimer = d.engineTimer;
  return r;
}
