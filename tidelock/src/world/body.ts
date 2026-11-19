// W1-C "The body" — pure core (docs/SIMULATION.md §2 W1-C items 1–5, 8, 9). Pure TypeScript, deterministic,
// allocation-free in every per-step function (module-level typed scratch), plain-JSON state, SI units.
//
// WIRING (wave 1; this file replaces nothing by itself, it is called from the files below):
// - crew.ts `craftMotion(world, c, out)`: replace the rebuild from commands (throttle, rcs, torque) by
//     motionFromLedger(mean.fAcc, mean.tauAcc, mean.accT, craftMass(c), m·gyration, c.w, out)
//   using the tick's means from W1-B's `consumeLedger(c, mean)` (the session calls it once per tick). Landed:
//     landedProperAccel(b.mu, c.rel, b.spinAxis, b.spinRate, c.q, out.a)   (adds Ω×(Ω×r), item 8)
//   and always localVertical(c.rel, b.mu, c.q, out.rhat) → out.n2 (item 9; give ShipMotion `rhat`, `n2`).
// - props.ts `stepProps` (start of the tick, before the sub-steps): for every loose awake/drifting body
//     applyShipJump(b.v, b.w, b.p, mean.dv, mean.dw)          (v_rel += −Δv − Δω×r, ω_rel −= Δω)
//   and delete the global wake on |Δa| > WAKE_DA / |Δω| > WAKE_DW / α²r² (quasistatic.ts decides waking).
// - crew.ts `stepCrew` while gripped: shipJumpAt(crewCoM, dv, dw, J); bootImpulse(80, J, deckN, ΣbootMagnet(gap),
//   feltNormal, Q, dvOut) → crew.vel += dvOut, slip / lift ends the grip (emit 'bootOff'). Walking: replace
//   BOOT_HOLD / BOOT_PULL / BOOT_SNAP / WALK_ACCEL with bootMagnet, bootContact, bootTraction, legForce,
//   gaitSpeedCap; FootBody (stepFoot) + gaitPhase / gaitEye give the on-foot eye offset.
// - session.ts helm (seated) each tick: shipJumpAt(helmSeatPoint, dv, dw, J); add J to body.v; then
//     stepHelmBody(body, HELM_DEF, felt at the seat (crew.ts feltAt, v = 0), leanDir, leanMax, h)
//   with h = Q at 1× (4 exact sub-steps inside) and the quantum under warp (closed-form equilibrium when
//   h > QS_DT). CrewView.eyeOffset = helmEyeOffset(body, leanDir, out) + neckEyeDelta(yaw, pitch, out2).
//   Bunk / table: the same with BUNK_DEF (asleep ⇒ the quantum is ≫ QS_DT ⇒ harnessEquilibrium; never a spring
//   at h ≈ 83 ms).
// - app/input.ts pinch: leanT = pinchLean(leanAtPinchStart, scale, maxLean) (replaces the 1..3 zoom);
//   render/camera.ts: delete `req.zoom` / `lean` FOV narrowing (FOV fixed), add CrewView.eyeOffset to the eye.
//   leanMax = leanClearance(compiledBoxes, n, eye, leanDir, LEAN_MAX_HELM | LEAN_MAX_STAND) so the head
//   sphere (r 0.10 m) never passes through glass.
// - Save: saveHarnessBody / loadHarnessBody, saveFootBody / loadFootBody (loader defaults for old saves).
//
// Transcendentals: only at module load (coefficients) and in rare off-tick paths, through the m* wrappers
// below; wave 1 moves them into src/world/math.ts with the rest of the wrappers (§1.1 rule 6).

import type { Quat, V3 } from '../core/types';
import type { ShipMotion } from './crew';

// ------------------------------------------------------------------------------------------------ wrappers

const mexp = (x: number): number => Math.exp(x);
const mcos = (x: number): number => Math.cos(x);
const msin = (x: number): number => Math.sin(x);
const mlog = (x: number): number => Math.log(x);

// ------------------------------------------------------------------------------------------------ constants

/** The fixed tick, s (SIMULATION.md §1.3), and the body's sub-steps per tick (480 Hz). */
export const Q = 1 / 120;
export const SUBSTEPS = 4;
export const HS = Q / SUBSTEPS;
/** Above this step the seat, harness and bunk use the closed-form equilibrium, s (plan item 3). */
export const QS_DT = 0.02;

export const G0 = 9.80665;
export const TORSO_MASS = 80;
/** Seat cushion and back: k (N/m) and damping ratio (4.4 Hz on 80 kg). */
export const SEAT_K = 60e3;
export const SEAT_ZETA = 0.3;
/** Harness webbing: tension-only, k (N/m), slack (m). The damping ratio is an assumption (webbing hysteresis). */
export const HARNESS_K = 40e3;
export const HARNESS_ZETA = 0.3;
export const HARNESS_SLACK = 0.015;
/**
 * Bracing in the slack, 1/s: a seated or strapped body is not a free point between its cushion and its straps —
 * muscle tone and the rub of webbing and cloth damp its motion there (assumption, time constant 0.25 s). Without
 * it a 2 m/s capture would rattle the torso between seat back and straps for seconds.
 */
export const BRACE_BETA = 4;
/** Head: a second-order lag on the torso, ω (rad/s), ζ; head mass (kg, for loads only). */
export const HEAD_OMEGA = 2 * Math.PI * 2;
export const HEAD_ZETA = 0.6;
export const HEAD_MASS = 4.5;
/** Bunk: straps k (N/m) with slack, mattress k (N/m, assumption) and damping ratio (assumption). */
export const BUNK_STRAP_K = 8e3;
export const BUNK_MATTRESS_K = 20e3;
export const BUNK_ZETA = 0.3;
export const BUNK_SLACK = 0.02;
/** Lean (torso flexion): PD ω (rad/s, ζ = 1), the moving upper-body mass (kg), muscle force limit (N), limits (m). */
export const LEAN_OMEGA = 6;
export const LEAN_MASS = 40;
export const LEAN_FMAX = 500;
export const LEAN_MAX_HELM = 0.12;
export const LEAN_MAX_STAND = 0.3;
/** Hip-to-eye length of the flexing torso, m: leaning ℓ forward drops the eye by L − √(L² − ℓ²). */
export const LEAN_ARM = 0.65;
/** Head sphere radius for the clearance test, m. */
export const HEAD_RADIUS = 0.1;
/** Neck pivot → eye in head axes (facing −Z), m; look limits, rad; torso twist when harnessed, rad. */
export const NECK_EYE_Y = 0.07;
export const NECK_EYE_Z = -0.09;
export const NECK_YAW_MAX = (75 * Math.PI) / 180;
export const NECK_PITCH_UP = (60 * Math.PI) / 180;
export const NECK_PITCH_DOWN = (70 * Math.PI) / 180;
export const TORSO_TWIST_MAX = (40 * Math.PI) / 180;
/** Boots: magnet F(g) = F0 / (1 + g/g0)² per boot, static / kinetic friction, catch rules, knee, legs. */
export const BOOT_F0 = 200;
export const BOOT_G0 = 0.005;
export const BOOT_MU_S = 0.7;
export const BOOT_MU_K = 0.5;
export const BOOT_CATCH_GAP = 0.002;
export const BOOT_CATCH_VN = 0.5;
export const BOOT_RESTITUTION = 0.3;
export const KNEE_K = 20e3;
export const KNEE_ZETA = 0.7;
export const LEG_FMAX = 1000;
/** Gait: speed caps (m/s) by felt normal load; eye bob amplitudes (m) and step frequency at 1 g (Hz). */
export const SPEED_LOW_G = 1.1;
export const SPEED_WALK = 1.4;
export const SPEED_RUN = 2.2;
export const BOB_V = 0.02;
export const BOB_L = 0.012;
export const STEP_HZ = 1.8;
export const BOB_FLOOR = 0.3;

// ------------------------------------------------------------------------------------------------ exact linear oscillator

/**
 * Flush to zero below 1e-200: exact exponential decay toward a zero equilibrium runs into subnormal numbers, which
 * cost ~10× per operation on x86 and ARM (measured: 1.6 µs instead of 0.2 µs per helm tick). Deterministic.
 */
const ftz = (x: number): number => (x < 1e-200 && x > -1e-200 ? 0 : x);
function ftz3(v: V3): void { v.x = ftz(v.x); v.y = ftz(v.y); v.z = ftz(v.z); }

/**
 * out[o..o+3] = the exact transition matrix over h of y'' = −ω²y − 2ζωy' (row-major: y' = Φ00 y + Φ01 v,
 * v' = Φ10 y + Φ11 v). ω = 0 gives free flight. Under-, critically and over-damped cases.
 */
export function oscTransition(out: Float64Array, o: number, w: number, z: number, h: number): void {
  if (!(w > 0)) { out[o] = 1; out[o + 1] = h; out[o + 2] = 0; out[o + 3] = 1; return; }
  if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z), e = mexp(-z * w * h), c = mcos(wd * h), s = msin(wd * h), r = (z * w) / wd;
    out[o] = e * (c + r * s); out[o + 1] = (e * s) / wd; out[o + 2] = (-e * w * w * s) / wd; out[o + 3] = e * (c - r * s);
  } else if (z === 1) {
    const e = mexp(-w * h);
    out[o] = e * (1 + w * h); out[o + 1] = e * h; out[o + 2] = -e * w * w * h; out[o + 3] = e * (1 - w * h);
  } else {
    const q = Math.sqrt(z * z - 1), s1 = -w * (z - q), s2 = -w * (z + q), e1 = mexp(s1 * h), e2 = mexp(s2 * h), d = s1 - s2;
    out[o] = (s1 * e2 - s2 * e1) / d; out[o + 1] = (e1 - e2) / d; out[o + 2] = (s1 * s2 * (e2 - e1)) / d; out[o + 3] = (s1 * e1 - s2 * e2) / d;
  }
}

// ------------------------------------------------------------------------------------------------ felt acceleration from the ledger

/** ShipMotion plus what wave 1 adds (item 9) and the slow-force rate bound the rest test needs. */
export interface BodyMotion extends ShipMotion {
  /** Unit local vertical (away from the primary), ship axes; n² = μ/r³, 1/s². */
  rhat: V3;
  n2: number;
  /** Upper bound of |d(felt)/dt| anywhere in the cabin, m/s³ (0 in wave 1; tides and gravity gradient in wave 2). */
  fDot: number;
}

export const createBodyMotion = (): BodyMotion => ({
  a: { x: 0, y: 0, z: 0 }, w: { x: 0, y: 0, z: 0 }, alpha: { x: 0, y: 0, z: 0 }, rhat: { x: 0, y: 1, z: 0 }, n2: 0, fDot: 0,
});

/**
 * The ship's motion from the ledger means (§1.4): a = (fAcc/accT)/m, α = I⁻¹(τ̄ − ω × Iω), τ̄ = tauAcc/accT, all in
 * craft axes; I = (Ix, Iy, Iz) principal moments, kg·m². accT ≤ 0 (nothing accumulated) gives a = 0, τ̄ = 0.
 */
export function motionFromLedger(fAcc: V3, tauAcc: V3, accT: number, mass: number, I: V3, w: V3, out: ShipMotion): ShipMotion {
  const inv = accT > 0 ? 1 / accT : 0, im = mass > 0 ? inv / mass : 0;
  out.a.x = fAcc.x * im; out.a.y = fAcc.y * im; out.a.z = fAcc.z * im;
  out.w.x = w.x; out.w.y = w.y; out.w.z = w.z;
  const tx = tauAcc.x * inv, ty = tauAcc.y * inv, tz = tauAcc.z * inv;
  const Lx = I.x * w.x, Ly = I.y * w.y, Lz = I.z * w.z;
  // α = I⁻¹(τ̄ − ω × Iω)
  out.alpha.x = I.x > 0 ? (tx - (w.y * Lz - w.z * Ly)) / I.x : 0;
  out.alpha.y = I.y > 0 ? (ty - (w.z * Lx - w.x * Lz)) / I.y : 0;
  out.alpha.z = I.z > 0 ? (tz - (w.x * Ly - w.y * Lx)) / I.z : 0;
  return out;
}

/** Rotate inertial (x,y,z) into craft axes: q maps local → world, so this is q⁻¹·v. */
function toLocal(out: V3, q: Quat, x: number, y: number, z: number): V3 {
  const qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

/**
 * Proper acceleration of a landed craft, craft axes: −g + Ω×(Ω×r) = μr/|r|³ + Ω×(Ω×r) (the ground co-rotates; the
 * centripetal term lightens the felt load at the equator). rel = position relative to the body, inertial axes.
 */
export function landedProperAccel(mu: number, rel: V3, spinAxis: V3, spinRate: number, q: Quat, out: V3): V3 {
  const d2 = rel.x * rel.x + rel.y * rel.y + rel.z * rel.z, d = Math.sqrt(d2);
  const g = d > 0 ? mu / (d2 * d) : 0;
  const Wx = spinAxis.x * spinRate, Wy = spinAxis.y * spinRate, Wz = spinAxis.z * spinRate;
  const cx = Wy * rel.z - Wz * rel.y, cy = Wz * rel.x - Wx * rel.z, cz = Wx * rel.y - Wy * rel.x;
  const ax = rel.x * g + (Wy * cz - Wz * cy), ay = rel.y * g + (Wz * cx - Wx * cz), az = rel.z * g + (Wx * cy - Wy * cx);
  return toLocal(out, q, ax, ay, az);
}

/** Primary-relative local vertical in craft axes (out, unit) and n² = μ/r³ (returned). */
export function localVertical(rel: V3, mu: number, q: Quat, out: V3): number {
  const d2 = rel.x * rel.x + rel.y * rel.y + rel.z * rel.z, d = Math.sqrt(d2);
  if (!(d > 0)) { out.x = 0; out.y = 1; out.z = 0; return 0; }
  toLocal(out, q, rel.x / d, rel.y / d, rel.z / d);
  return mu / (d2 * d);
}

// ------------------------------------------------------------------------------------------------ impulses

/** The relative-velocity jump of a point fixed at r (craft axes) when the ship takes Δv, Δω: out = −Δv − Δω × r. */
export function shipJumpAt(r: V3, dv: V3, dw: V3, out: V3): V3 {
  const x = -dv.x - (dw.y * r.z - dw.z * r.y), y = -dv.y - (dw.z * r.x - dw.x * r.z), z = -dv.z - (dw.x * r.y - dw.y * r.x);
  out.x = x; out.y = y; out.z = z;
  return out;
}

/**
 * A loose body keeps its inertial velocity when the ship jumps: v_rel += −Δv − Δω × r, and (when its angular
 * velocity is carried relative to the ship) ω_rel −= Δω. r = its centre, craft axes.
 */
export function applyShipJump(v: V3, w: V3 | null, r: V3, dv: V3, dw: V3): void {
  v.x += -dv.x - (dw.y * r.z - dw.z * r.y);
  v.y += -dv.y - (dw.z * r.x - dw.x * r.z);
  v.z += -dv.z - (dw.x * r.y - dw.y * r.x);
  if (w) { w.x -= dw.x; w.y -= dw.y; w.z -= dw.z; }
}

// ------------------------------------------------------------------------------------------------ boots

/** Magnet pull of one boot at sole gap g (m), N. */
export const bootMagnet = (gap: number): number => {
  const u = 1 + (gap > 0 ? gap : 0) / BOOT_G0;
  return BOOT_F0 / (u * u);
};

/** Normal load the soles carry, N: magnets plus the felt load into the deck (fn = felt·n, n out of the deck). */
export const bootNormalLoad = (fMag: number, m: number, fn: number): number => fMag + m * (fn < 0 ? -fn : 0);

/** Most tangential impulse the soles pass in one step h: J_max = μ_s·(F_mag + m·max(0, −f_n))·h, N·s. */
export const bootJmax = (fMag: number, m: number, fn: number, h: number = Q): number => BOOT_MU_S * bootNormalLoad(fMag, m, fn) * h;

/** Static traction limit of the soles, N: T = μ_s·(ΣF_mag + m·max(0, −f_n)). */
export const bootTraction = (fMag: number, m: number, fn: number): number => BOOT_MU_S * bootNormalLoad(fMag, m, fn);

export const BOOT_HELD = 0;
export const BOOT_SLIP = 1;
export const BOOT_LIFT = 2;

/** Impulse the deck actually applied in the last bootImpulse call (N·s, craft axes): the ship gets −J. */
export const bootLastJ: V3 = { x: 0, y: 0, z: 0 };

/**
 * A gripped body of mass m when the deck jumps: jump = the relative-velocity jump of the body (shipJumpAt),
 * n = unit deck normal (out of the deck), fMag = total magnet pull, fn = felt·n, h = the step the load acts over.
 * The deck pushes as hard as needed; it pulls only up to the normal load × h (beyond that the soles lift);
 * friction passes |J_t| ≤ μ_s·N_imp, N_imp = load·h + J_n (the normal impulse adds grip, tension removes it),
 * else the soles slip and pass μ_k·N_imp. With a purely tangential jump this is exactly J_max of the plan.
 * out = the body's relative-velocity change (jump + J/m). Returns BOOT_HELD, BOOT_SLIP or BOOT_LIFT.
 */
export function bootImpulse(m: number, jump: V3, n: V3, fMag: number, fn: number, h: number, out: V3): number {
  // impulse that would keep the body with the deck
  const rx = -m * jump.x, ry = -m * jump.y, rz = -m * jump.z;
  const rn = rx * n.x + ry * n.y + rz * n.z;
  const tx = rx - rn * n.x, ty = ry - rn * n.y, tz = rz - rn * n.z;
  const cap = bootNormalLoad(fMag, m, fn) * h;
  let jn = rn, res = BOOT_HELD;
  if (rn < -cap) { jn = -cap; res = BOOT_LIFT; }
  const nImp = cap + jn;
  const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
  let k = 1;
  if (tl > BOOT_MU_S * nImp) {
    k = tl > 0 ? (BOOT_MU_K * nImp) / tl : 0;
    if (res === BOOT_HELD) res = BOOT_SLIP;
  }
  const jx = jn * n.x + k * tx, jy = jn * n.y + k * ty, jz = jn * n.z + k * tz;
  bootLastJ.x = jx; bootLastJ.y = jy; bootLastJ.z = jz;
  out.x = jump.x + jx / m; out.y = jump.y + jy / m; out.z = jump.z + jz / m;
  return res;
}

export const SOLE_NONE = 0;
export const SOLE_CATCH = 1;
export const SOLE_BOUNCE = 2;

/**
 * Soles meeting a deck: gap (m) and vn = normal velocity (m/s, < 0 approaching). They catch when gap < 2 mm and
 * the approach is ≤ 0.5 m/s; a faster arrival at contact bounces with restitution 0.3 (bounceVn gives the new vn).
 */
export function bootContact(gap: number, vn: number): number {
  if (gap >= BOOT_CATCH_GAP) return SOLE_NONE;
  if (-vn <= BOOT_CATCH_VN) return SOLE_CATCH;
  return gap <= 0 ? SOLE_BOUNCE : SOLE_NONE;
}
export const bounceVn = (vn: number): number => (vn < 0 ? -BOOT_RESTITUTION * vn : vn);

/**
 * Leg force along the deck, N (2-D in the deck plane: ax, az = commanded acceleration; fx, fz = felt tangential):
 * F = m(a_cmd − f_t), limited by the traction T and by LEG_FMAX. Writes out.x, out.z; returns true when limited.
 */
export function legForce(m: number, ax: number, az: number, fx: number, fz: number, T: number, out: V3): boolean {
  let Fx = m * (ax - fx), Fz = m * (az - fz);
  const lim = T < LEG_FMAX ? T : LEG_FMAX, l = Math.sqrt(Fx * Fx + Fz * Fz);
  const limited = l > lim;
  if (limited) { const s = l > 0 ? lim / l : 0; Fx *= s; Fz *= s; }
  out.x = Fx; out.y = 0; out.z = Fz;
  return limited;
}

/** Top speed from the felt load into the deck (m/s²): 1.1 m/s below 0.3 g, running only at ≥ 0.6 g. */
export const gaitSpeedCap = (fnInto: number): number => (fnInto < 0.3 * G0 ? SPEED_LOW_G : fnInto < 0.6 * G0 ? SPEED_WALK : SPEED_RUN);

// ------------------------------------------------------------------------------------------------ knee, gait, head lag on foot

/** Knee compression (m, + = sinking), its rate, gait phase (rad, 0..4π) and the walking head's lag on the body. */
export interface FootBody {
  kx: number;
  kv: number;
  phase: number;
  hx: V3;
  hv: V3;
}

export const createFootBody = (): FootBody => ({ kx: 0, kv: 0, phase: 0, hx: { x: 0, y: 0, z: 0 }, hv: { x: 0, y: 0, z: 0 } });

/** Free motion with linear damping β over h: [e^{−βh}, (1 − e^{−βh})/β] (ZOH forcing handled by the caller). */
const BRACE_E = mexp(-BRACE_BETA * HS);
let rtBraceH = 0, rtBraceE = 0;

const PHI_KNEE = new Float64Array(4);
const PHI_HEAD = new Float64Array(4);
const PHI_LEAN = new Float64Array(4);
oscTransition(PHI_KNEE, 0, Math.sqrt(KNEE_K / TORSO_MASS), KNEE_ZETA, HS);
oscTransition(PHI_HEAD, 0, HEAD_OMEGA, HEAD_ZETA, HS);
oscTransition(PHI_LEAN, 0, LEAN_OMEGA, 1, HS);

/** A landing at approach speed vIn (m/s, > 0) loads the knee: the body's CoM keeps moving into it. */
export function kneeLand(fb: FootBody, vIn: number): void {
  if (vIn > 0) fb.kv += vIn;
}

/**
 * One tick (h = Q, 4 exact sub-steps) of the knee and the head lag on foot. The knee spring carries the landing
 * and load *changes*; the static load is held by posture (muscles), so a steady load gives no sink. aBody = the
 * body's own acceleration along the deck this tick (legs), craft axes: the head lags it (a nod on stopping).
 * Not for h ≠ Q: under warp the body is quasi-static (kx = kv = 0, head centred: settleFoot).
 */
export function stepFoot(fb: FootBody, aBody: V3): void {
  const P = PHI_KNEE, H = PHI_HEAD;
  for (let i = 0; i < SUBSTEPS; i++) {
    const x = fb.kx, v = fb.kv;
    fb.kx = P[0] * x + P[1] * v;
    fb.kv = P[2] * x + P[3] * v;
  }
  fb.kx = ftz(fb.kx); fb.kv = ftz(fb.kv);
  headLagTick(fb.hx, fb.hv, aBody.x, aBody.y, aBody.z, H);
  ftz3(fb.hx); ftz3(fb.hv);
}

export function settleFoot(fb: FootBody): void {
  fb.kx = 0; fb.kv = 0;
  fb.hx.x = fb.hx.y = fb.hx.z = 0; fb.hv.x = fb.hv.y = fb.hv.z = 0;
}

/** Advance the gait phase by one step h at speed (m/s); cadence scales with speed relative to SPEED_WALK. */
export function gaitPhase(phase: number, speed: number, h: number): number {
  const r = speed > 0 ? speed / SPEED_WALK : 0;
  let p = phase + 2 * Math.PI * STEP_HZ * (r < 1.6 ? r : 1.6) * h;
  const P4 = 4 * Math.PI;
  if (p >= P4) p -= P4;
  return p;
}

/**
 * Eye excursion from stance geometry, a translation in deck axes (y up, x lateral): vertical ±2 cm at the step
 * frequency, lateral ±1.2 cm at half of it, scaled by √(f_n/g) with a floor of 0.3 and by the speed fraction.
 * Writes out.x (lateral) and out.y (vertical); out.z = 0.
 */
export function gaitEye(phase: number, fnInto: number, speed: number, out: V3): V3 {
  let s = Math.sqrt((fnInto > 0 ? fnInto : 0) / G0);
  if (s < BOB_FLOOR) s = BOB_FLOOR;
  const r = speed > 0 ? (speed < SPEED_WALK ? speed / SPEED_WALK : 1) : 0;
  out.x = BOB_L * s * r * msin(0.5 * phase);
  out.y = BOB_V * s * r * msin(phase);
  out.z = 0;
  return out;
}

/** The head as a lag on a base that accelerates by (ax, ay, az) relative to the ship over one tick (4 sub-steps). */
function headLagTick(hx: V3, hv: V3, ax: number, ay: number, az: number, H: Float64Array): void {
  // exact zero-order hold: forcing −a ⇒ equilibrium −a/ω²
  const w2 = HEAD_OMEGA * HEAD_OMEGA, ex = -ax / w2, ey = -ay / w2, ez = -az / w2;
  for (let i = 0; i < SUBSTEPS; i++) {
    let y = hx.x - ex, v = hv.x;
    hx.x = ex + H[0] * y + H[1] * v; hv.x = H[2] * y + H[3] * v;
    y = hx.y - ey; v = hv.y;
    hx.y = ey + H[0] * y + H[1] * v; hv.y = H[2] * y + H[3] * v;
    y = hx.z - ez; v = hv.z;
    hx.z = ez + H[0] * y + H[1] * v; hv.z = H[2] * y + H[3] * v;
  }
}

// ------------------------------------------------------------------------------------------------ seat, harness, bunk

/**
 * A body held by unilateral springs, per craft axis: below `lo` one spring (kLo/m = wLo², ζLo) pushes it back,
 * above `hi` another; in between it is free (the slack). Coefficients are exact for h = HS (precomputed).
 */
export interface HarnessDef {
  m: number;
  lo: Float64Array;
  hi: Float64Array;
  wLo: Float64Array;
  zLo: Float64Array;
  wHi: Float64Array;
  zHi: Float64Array;
  /** Transition matrices for HS, 4 numbers per axis. */
  phiLo: Float64Array;
  phiHi: Float64Array;
  /** One-entry cache for another sub-step (h ≠ Q, h ≤ QS_DT; rare). */
  rtH: number;
  rtLo: Float64Array;
  rtHi: Float64Array;
}

interface AxisSpec { lo: number; hi: number; kLo: number; zLo: number; kHi: number; zHi: number }

export function makeHarnessDef(m: number, axes: readonly [AxisSpec, AxisSpec, AxisSpec]): HarnessDef {
  const d: HarnessDef = {
    m, lo: new Float64Array(3), hi: new Float64Array(3), wLo: new Float64Array(3), zLo: new Float64Array(3), wHi: new Float64Array(3),
    zHi: new Float64Array(3), phiLo: new Float64Array(12), phiHi: new Float64Array(12), rtH: 0, rtLo: new Float64Array(12), rtHi: new Float64Array(12),
  };
  for (let a = 0; a < 3; a++) {
    const s = axes[a];
    d.lo[a] = s.lo; d.hi[a] = s.hi;
    d.wLo[a] = Math.sqrt(s.kLo / m); d.zLo[a] = s.zLo; d.wHi[a] = Math.sqrt(s.kHi / m); d.zHi[a] = s.zHi;
    oscTransition(d.phiLo, 4 * a, d.wLo[a], s.zLo, HS);
    oscTransition(d.phiHi, 4 * a, d.wHi[a], s.zHi, HS);
  }
  return d;
}

/**
 * The helm seat (facing −Z, craft axes): +Y up — the cushion below 0, the shoulder/lap straps beyond the slack;
 * +Z aft — the seat back beyond 0, the shoulder straps forward beyond the slack; ±X — straps and bolsters beyond
 * the slack either side. Torso 80 kg.
 */
export const HELM_DEF: HarnessDef = makeHarnessDef(TORSO_MASS, [
  { lo: -HARNESS_SLACK, hi: HARNESS_SLACK, kLo: HARNESS_K, zLo: HARNESS_ZETA, kHi: HARNESS_K, zHi: HARNESS_ZETA },
  { lo: 0, hi: HARNESS_SLACK, kLo: SEAT_K, zLo: SEAT_ZETA, kHi: HARNESS_K, zHi: HARNESS_ZETA },
  { lo: -HARNESS_SLACK, hi: 0, kLo: HARNESS_K, zLo: HARNESS_ZETA, kHi: SEAT_K, zHi: SEAT_ZETA },
]);

/** The bunk (body lying on +Y): mattress below 0, straps beyond the slack in every other direction. */
export const BUNK_DEF: HarnessDef = makeHarnessDef(TORSO_MASS, [
  { lo: -BUNK_SLACK, hi: BUNK_SLACK, kLo: BUNK_STRAP_K, zLo: BUNK_ZETA, kHi: BUNK_STRAP_K, zHi: BUNK_ZETA },
  { lo: 0, hi: BUNK_SLACK, kLo: BUNK_MATTRESS_K, zLo: BUNK_ZETA, kHi: BUNK_STRAP_K, zHi: BUNK_ZETA },
  { lo: -BUNK_SLACK, hi: BUNK_SLACK, kLo: BUNK_STRAP_K, zLo: BUNK_ZETA, kHi: BUNK_STRAP_K, zHi: BUNK_ZETA },
]);

/** Torso displacement from its seated neutral point and velocity (craft axes), head lag, lean. Plain JSON. */
export interface HarnessBody {
  x: V3;
  v: V3;
  /** Head relative to the torso, m and m/s. */
  hx: V3;
  hv: V3;
  /** Lean (m along the lean direction), its rate, and the target the pinch set. */
  lean: number;
  leanV: number;
  leanT: number;
}

export const createHarnessBody = (): HarnessBody => ({
  x: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 }, hx: { x: 0, y: 0, z: 0 }, hv: { x: 0, y: 0, z: 0 }, lean: 0, leanV: 0, leanT: 0,
});

const AX = new Float64Array(3);
const AV = new Float64Array(3);
const AF = new Float64Array(3);
const AV0 = new Float64Array(3);

function ensureRt(def: HarnessDef, hs: number): void {
  if (def.rtH === hs) return;
  for (let a = 0; a < 3; a++) {
    oscTransition(def.rtLo, 4 * a, def.wLo[a], def.zLo[a], hs);
    oscTransition(def.rtHi, 4 * a, def.wHi[a], def.zHi[a], hs);
  }
  def.rtH = hs;
}

/**
 * Closed-form equilibrium of the held body under a steady felt acceleration (the limit of the damped motion):
 * per axis f > 0 → hi + f/wHi², f < 0 → lo + f/wLo², f = 0 → wherever it is in the slack. v = 0, head centred,
 * lean at its target unless the muscles cannot hold it (|f_d|·LEAN_MASS > LEAN_FMAX: it sags to a stop).
 */
export function harnessEquilibrium(b: HarnessBody, def: HarnessDef, f: V3, dir: V3 | null, leanMax: number): void {
  AF[0] = f.x; AF[1] = f.y; AF[2] = f.z;
  AX[0] = b.x.x; AX[1] = b.x.y; AX[2] = b.x.z;
  for (let a = 0; a < 3; a++) {
    const fa = AF[a];
    if (fa > 0) AX[a] = def.hi[a] + fa / (def.wHi[a] * def.wHi[a]);
    else if (fa < 0) AX[a] = def.lo[a] + fa / (def.wLo[a] * def.wLo[a]);
    else AX[a] = AX[a] < def.lo[a] ? def.lo[a] : AX[a] > def.hi[a] ? def.hi[a] : AX[a];
  }
  b.x.x = AX[0]; b.x.y = AX[1]; b.x.z = AX[2];
  b.v.x = b.v.y = b.v.z = 0;
  b.hx.x = b.hx.y = b.hx.z = 0; b.hv.x = b.hv.y = b.hv.z = 0;
  const lim = leanMax > 0 ? leanMax : 0;
  const t = b.leanT < 0 ? 0 : b.leanT > lim ? lim : b.leanT;
  const fd = dir ? f.x * dir.x + f.y * dir.y + f.z * dir.z : 0;
  b.lean = LEAN_MASS * (fd < 0 ? -fd : fd) <= LEAN_FMAX ? t : fd < 0 ? 0 : lim;
  b.leanV = 0;
}

/**
 * Advance the seated / lying body by h. f = the felt acceleration at the seat (crew.ts feltAt with v = 0; the
 * tick's ledger mean), craft axes. dir = unit lean direction (leanDir) or null; leanMax = the lean limit now
 * (posture limit ∩ head clearance). h = Q: 4 exact sub-steps (precomputed coefficients); h ≤ QS_DT otherwise:
 * the same with coefficients computed once for that h; h > QS_DT (warp, sleep): the closed-form equilibrium.
 * Apply the tick's impulse first: b.v += shipJumpAt(seatPoint, dv, dw).
 */
export function stepHarnessBody(b: HarnessBody, def: HarnessDef, f: V3, dir: V3 | null, leanMax: number, h: number): void {
  if (!(h > 0)) return;
  if (h > QS_DT) { harnessEquilibrium(b, def, f, dir, leanMax); return; }
  const hs = h / SUBSTEPS;
  let pLo = def.phiLo, pHi = def.phiHi;
  if (h !== Q) { ensureRt(def, hs); pLo = def.rtLo; pHi = def.rtHi; }
  AX[0] = b.x.x; AX[1] = b.x.y; AX[2] = b.x.z;
  AV[0] = b.v.x; AV[1] = b.v.y; AV[2] = b.v.z;
  AF[0] = f.x; AF[1] = f.y; AF[2] = f.z;
  const lo = def.lo, hi = def.hi, wLo = def.wLo, wHi = def.wHi;
  const head = h === Q ? PHI_HEAD : null;
  if (h !== Q && rtBraceH !== hs) { rtBraceE = mexp(-BRACE_BETA * hs); rtBraceH = hs; }
  const eb = h === Q ? BRACE_E : rtBraceE, ib = 1 / BRACE_BETA, gb = (1 - eb) * ib;
  for (let i = 0; i < SUBSTEPS; i++) {
    for (let a = 0; a < 3; a++) {
      const x = AX[a], v = AV[a], fa = AF[a];
      AV0[a] = v;
      if (x < lo[a]) {
        const w = wLo[a], e = lo[a] + fa / (w * w), y = x - e, o = 4 * a;
        AX[a] = e + pLo[o] * y + pLo[o + 1] * v; AV[a] = pLo[o + 2] * y + pLo[o + 3] * v;
      } else if (x > hi[a]) {
        const w = wHi[a], e = hi[a] + fa / (w * w), y = x - e, o = 4 * a;
        AX[a] = e + pHi[o] * y + pHi[o + 1] * v; AV[a] = pHi[o + 2] * y + pHi[o + 3] * v;
      } else {
        // in the slack: v' = f − βv, exact
        const vt = fa * ib, d = v - vt;
        AX[a] = x + vt * hs + d * gb; AV[a] = vt + d * eb;
      }
    }
    // the head lags the torso's acceleration relative to the ship (its mean over this sub-step)
    headLagSub(b.hx, b.hv, (AV[0] - AV0[0]) / hs, (AV[1] - AV0[1]) / hs, (AV[2] - AV0[2]) / hs, hs, head);
  }
  b.x.x = AX[0]; b.x.y = AX[1]; b.x.z = AX[2];
  b.v.x = ftz(AV[0]); b.v.y = ftz(AV[1]); b.v.z = ftz(AV[2]);
  ftz3(b.hx); ftz3(b.hv);
  leanStep(b, f, dir, leanMax, h, h === Q ? PHI_LEAN : null);
}

const PHI_RT = new Float64Array(8);
let rtHeadH = 0;

function headLagSub(hx: V3, hv: V3, ax: number, ay: number, az: number, hs: number, P: Float64Array | null): void {
  let H = P;
  if (!H) {
    if (rtHeadH !== hs) { oscTransition(PHI_RT, 0, HEAD_OMEGA, HEAD_ZETA, hs); oscTransition(PHI_RT, 4, LEAN_OMEGA, 1, hs); rtHeadH = hs; }
    H = PHI_RT;
  }
  const w2 = HEAD_OMEGA * HEAD_OMEGA, ex = -ax / w2, ey = -ay / w2, ez = -az / w2;
  let y = hx.x - ex, v = hv.x;
  hx.x = ex + H[0] * y + H[1] * v; hv.x = H[2] * y + H[3] * v;
  y = hx.y - ey; v = hv.y;
  hx.y = ey + H[0] * y + H[1] * v; hv.y = H[2] * y + H[3] * v;
  y = hx.z - ez; v = hv.z;
  hx.z = ez + H[0] * y + H[1] * v; hv.z = H[2] * y + H[3] * v;
}

/**
 * Lean: a force-limited PD (ω = 6 rad/s, ζ = 1) with the felt load fed forward (the muscles know their weight).
 * Unsaturated, the error is exactly critically damped; saturated, the motion is exactly ballistic. Hard stops at
 * 0 and leanMax.
 */
function leanStep(b: HarnessBody, f: V3, dir: V3 | null, leanMax: number, h: number, P: Float64Array | null): void {
  const lim = leanMax > 0 ? leanMax : 0;
  const t = b.leanT < 0 ? 0 : b.leanT > lim ? lim : b.leanT;
  const fd = dir ? f.x * dir.x + f.y * dir.y + f.z * dir.z : 0;
  const hs = h / SUBSTEPS, L = P ?? PHI_RT, o = P ? 0 : 4;
  const w2 = LEAN_OMEGA * LEAN_OMEGA, amax = LEAN_FMAX / LEAN_MASS;
  let x = b.lean, v = b.leanV;
  for (let i = 0; i < SUBSTEPS; i++) {
    const e = x - t;
    // muscle acceleration the PD asks for (with feed-forward −fd)
    const am = -w2 * e - 2 * LEAN_OMEGA * v - fd;
    if (am <= amax && am >= -amax) {
      x = t + L[o] * e + L[o + 1] * v; v = L[o + 2] * e + L[o + 3] * v;
    } else {
      const acc = (am > 0 ? amax : -amax) + fd;
      x += v * hs + 0.5 * acc * hs * hs; v += acc * hs;
    }
    if (x < 0) { x = 0; if (v < 0) v = 0; } else if (x > lim) { x = lim; if (v > 0) v = 0; }
  }
  b.lean = x; b.leanV = ftz(v);
}

/** Force the seat and harness put on the torso now (spring + damper of the engaged sides), N, craft axes. */
export function harnessForce(b: HarnessBody, def: HarnessDef, out: V3): V3 {
  AX[0] = b.x.x; AX[1] = b.x.y; AX[2] = b.x.z; AV[0] = b.v.x; AV[1] = b.v.y; AV[2] = b.v.z;
  for (let a = 0; a < 3; a++) {
    const x = AX[a], v = AV[a];
    let F = 0;
    if (x < def.lo[a]) { const w = def.wLo[a]; F = def.m * (w * w * (def.lo[a] - x) - 2 * def.zLo[a] * w * v); }
    else if (x > def.hi[a]) { const w = def.wHi[a]; F = def.m * (w * w * (def.hi[a] - x) - 2 * def.zHi[a] * w * v); }
    AF[a] = F;
  }
  out.x = AF[0]; out.y = AF[1]; out.z = AF[2];
  return out;
}

/** Elastic energy stored in the engaged springs, J. */
export function harnessEnergy(b: HarnessBody, def: HarnessDef): number {
  let E = 0;
  AX[0] = b.x.x; AX[1] = b.x.y; AX[2] = b.x.z;
  for (let a = 0; a < 3; a++) {
    const x = AX[a];
    if (x < def.lo[a]) { const d = def.lo[a] - x, w = def.wLo[a]; E += 0.5 * def.m * w * w * d * d; }
    else if (x > def.hi[a]) { const d = x - def.hi[a], w = def.wHi[a]; E += 0.5 * def.m * w * w * d * d; }
  }
  return E;
}

// ------------------------------------------------------------------------------------------------ eye, lean, look

/** Unit lean direction (craft axes): horizontal along the look yaw; harnessed, the torso twists at most ±40°. */
export function leanDir(yaw: number, harnessed: boolean, out: V3): V3 {
  const y = harnessed ? (yaw > TORSO_TWIST_MAX ? TORSO_TWIST_MAX : yaw < -TORSO_TWIST_MAX ? -TORSO_TWIST_MAX : yaw) : yaw;
  out.x = -msin(y); out.y = 0; out.z = -mcos(y);
  return out;
}

/** Eye drop of a torso flexed by ℓ about the hips, m (≥ 0). */
export const leanDrop = (l: number): number => {
  const c = l < LEAN_ARM ? l : LEAN_ARM;
  return LEAN_ARM - Math.sqrt(LEAN_ARM * LEAN_ARM - c * c);
};

/**
 * CrewView.eyeOffset for a held body: torso + head lag + lean (translation only: the VOR holds the gaze, the view
 * never tilts and there is no camera shake). Craft axes, m.
 */
export function helmEyeOffset(b: HarnessBody, dir: V3 | null, out: V3): V3 {
  const l = b.lean, dx = dir ? dir.x : 0, dy = dir ? dir.y : 0, dz = dir ? dir.z : 0;
  out.x = b.x.x + b.hx.x + l * dx;
  out.y = b.x.y + b.hx.y + l * dy - leanDrop(l);
  out.z = b.x.z + b.hx.z + l * dz;
  return out;
}

/**
 * The eye turns about a neck pivot: eye = pivot + R(yaw, pitch)·(0, 0.07, −0.09). Returns the change from the
 * straight-ahead eye (yaw = pitch = 0), craft axes (the eye points of the layouts are straight-ahead eyes).
 */
export function neckEyeDelta(yaw: number, pitch: number, out: V3): V3 {
  const cy = mcos(yaw), sy = msin(yaw), cp = mcos(pitch), sp = msin(pitch);
  // R = Ry(yaw)·Rx(pitch). Rx(p): y' = y cos p − z sin p, z' = y sin p + z cos p (p > 0 turns −Z toward +Y);
  // Ry(yaw): x' = z sin yaw, z' = z cos yaw for x = 0 (yaw > 0 turns −Z toward −X, to the left)
  const ry = NECK_EYE_Y * cp - NECK_EYE_Z * sp, rz = NECK_EYE_Y * sp + NECK_EYE_Z * cp;
  out.x = rz * sy;
  out.y = ry - NECK_EYE_Y;
  out.z = rz * cy - NECK_EYE_Z;
  return out;
}

/** Look limits: pitch +60°/−70°; harnessed yaw ±(75° neck + 40° torso twist); on foot yaw is free (the body turns). */
export function clampLook(yaw: number, pitch: number, harnessed: boolean, out: { yaw: number; pitch: number }): void {
  const ym = NECK_YAW_MAX + TORSO_TWIST_MAX;
  out.yaw = harnessed ? (yaw > ym ? ym : yaw < -ym ? -ym : yaw) : yaw;
  out.pitch = pitch > NECK_PITCH_UP ? NECK_PITCH_UP : pitch < -NECK_PITCH_DOWN ? -NECK_PITCH_DOWN : pitch;
}

/**
 * Pinch is lean, not zoom: spreading the fingers by `scale` (current / start distance) leans in, one doubling
 * covers the whole range; pinching in leans back. Pure; called from the input handler, not per step.
 */
export function pinchLean(leanAtStart: number, scale: number, maxLean: number): number {
  if (!(scale > 0) || !(maxLean > 0)) return leanAtStart > 0 ? (leanAtStart < maxLean ? leanAtStart : maxLean > 0 ? maxLean : 0) : 0;
  const t = leanAtStart + (maxLean * mlog(scale)) / Math.LN2;
  return t < 0 ? 0 : t > maxLean ? maxLean : t;
}

/**
 * How far the head sphere (radius r, centre at eye) can travel along dir before touching a box (boxes as
 * minX, minY, minZ, maxX, maxY, maxZ — crew.ts' compiled boxes), capped at maxLean. Boxes the head already
 * overlaps do not block (it can always lean out of them). Minkowski slab test, slightly conservative at edges.
 */
export function leanClearance(boxes: Float64Array, n: number, eye: V3, dir: V3, maxLean: number, r: number = HEAD_RADIUS): number {
  let best = maxLean;
  const ex = eye.x, ey = eye.y, ez = eye.z, dx = dir.x, dy = dir.y, dz = dir.z;
  for (let i = 0, k = 0; i < n; i++, k += 6) {
    let t0 = -Infinity, t1 = Infinity, inside = true, miss = false;
    for (let a = 0; a < 3 && !miss; a++) {
      const p = a === 0 ? ex : a === 1 ? ey : ez, d = a === 0 ? dx : a === 1 ? dy : dz;
      const lo = boxes[k + a] - r, hi = boxes[k + 3 + a] + r;
      if (p < lo || p > hi) inside = false;
      if (d === 0) { if (p < lo || p > hi) miss = true; continue; }
      let ta = (lo - p) / d, tb = (hi - p) / d;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) miss = true;
    }
    if (miss || inside || t1 < 0) continue;
    const t = t0 - 1e-4;
    if (t < best) best = t < 0 ? 0 : t;
  }
  return best;
}

// ------------------------------------------------------------------------------------------------ save / load

const num = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const v3o = (x: unknown): V3 => {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  return { x: num(o.x, 0), y: num(o.y, 0), z: num(o.z, 0) };
};

export function saveHarnessBody(b: HarnessBody): HarnessBody {
  return { x: { ...b.x }, v: { ...b.v }, hx: { ...b.hx }, hv: { ...b.hv }, lean: b.lean, leanV: b.leanV, leanT: b.leanT };
}

/** Loader with defaults: a save without the field (or with junk) gives a body at rest in the neutral point. */
export function loadHarnessBody(data: unknown): HarnessBody {
  const o = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  return { x: v3o(o.x), v: v3o(o.v), hx: v3o(o.hx), hv: v3o(o.hv), lean: num(o.lean, 0), leanV: num(o.leanV, 0), leanT: num(o.leanT, 0) };
}

export function saveFootBody(b: FootBody): FootBody {
  return { kx: b.kx, kv: b.kv, phase: b.phase, hx: { ...b.hx }, hv: { ...b.hv } };
}

export function loadFootBody(data: unknown): FootBody {
  const o = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  return { kx: num(o.kx, 0), kv: num(o.kv, 0), phase: num(o.phase, 0), hx: v3o(o.hx), hv: v3o(o.hv) };
}
