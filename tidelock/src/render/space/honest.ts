// Honest pixels, the small pure laws (SIMULATION.md W1-E items 3, 5, 7, 8, 9, 10). No three.js, no DOM, no
// allocation (results go into caller-owned objects), sim time only. Each function is the whole law the renderer
// needs; the call sites stay one line.
//
// WIRING (wave 1, W1-E; nothing here is called yet):
//   * hologram.ts rebuild (the `rmap`/`sc` block, "globe at 0.42 R, altitude compressed"): replace with
//     `const s = holoScale(R, bodyR, ext)`; `rmap(r)` becomes `holoDisplayRadius(r, s)` and the globe radius `rg`
//     becomes `holoDisplayRadius(bodyR, s)` (so `sc(r)` is the constant s). Delete uSpin
//     (`(time * 0.12) % 2π`), the flicker and the dip. Zoom box: `holoZoom(range, boxHalf, out)` gives its scale and
//     the round-km ring step. Meridians: rotate the globe by `body.spinAngle`; terminator from the star direction.
//   * effects.ts plasma sheath (EffectsManager plasma / scene.ts setPlasma caller): direction `sheathDir(view.airVelocity,
//     out)` instead of the barycentric velocity; intensity `sheathIntensity(|airVelocity|, view.heatFlux)` set every
//     frame with no easing (no lingering). The screen-space filaments and the heat-haze UV warp are deleted.
//   * scene.ts far bodies (`b.light = starIntensityAt(...) * starVisibility(...)` and the far point markers):
//     unresolved worlds use `unresolvedIlluminance(E_sun, albedo, R, d, phaseAngle)`; `lambertPhase(α)` is Φ(α).
//   * cockpit.ts / instruments.ts screens: one `ScreenGlass` per console; per frame (sim dt)
//     E_glass_lux = glassIlluminance(starIlluminanceLux(star.luminosity, ds, star.temperature), vis, cosIncidence,
//     windowT) (the star's light on the glass through the canopy); `stepAutoBrightness(g, E_glass_lux, dtSim)`; then
//     emissive = g.L · renderPerNit(starIntensityAt(ds, lum), E_unshadowed_lux) in render units, and the veil is the
//     glass's own diffuse term (albedo GLASS_RD in the material and the RT record; veilLuminance is its cd/m² for
//     tests). renderPerNit is the photometric calibration this pipeline lacked: key level ↔ lux.
//   * W1-A perf-invisible-instruments: `cockpitScreensVisible(camLocal, planes, room, glass, n)` with room =
//     the `cockpit` room's box of data/interiors.ts (ship-local, min xyz then max xyz), glass the console screen
//     quads (cockpit.ts builds them; ship-local), camLocal the camera in ship axes, and
//     planes from `frustumPlanes(projectionMatrix × (shipWorld⁻¹·cameraWorld)⁻¹ (view matrix in ship axes), planes)`.
//   * render/frame.ts gets the EyeFrameFields (`eyesClosed`, `lid`) on day 1 (W1-E owns that file; the fields are
//     defined here so the change is one spread); app.ts sets lid from the crew's sleep state; scene/pipeline call
//     `eyesTransition(prevClosed, frame.eyesClosed)` and on EYES_WAKE reset RT history; under eyesClosed skip RT,
//     shadow and probe updates.
//   * post composite (eyes closed, W1-E 10): multiply by `eyelidTransmission(frame.eyesClosed, out)` per channel.
//   * every visual relaxation (nozzle glow, glare easing): `relaxExact(x, target, dtSim, tau)`.
//   * the cloud phase uniform: `phaseNoWrap(t, rate, period)` — doubles, exact, continuous across a rotation.

import type { V3 } from '../../core/types';

// =============================================================================================== hologram

/**
 * The hologram's linear radial scale (display metres per metre): s = R_display / r_max, r_max the largest of the
 * body radius and every drawn point's distance. Orbit-to-globe ratios are kept exactly.
 */
export function holoScale(rDisplay: number, bodyRadius: number, rMax: number): number {
  const r = rMax > bodyRadius ? rMax : bodyRadius;
  return r > 0 ? rDisplay / r : 0;
}

/** Round range-ring step (m) for a span: the largest 1·2·5 × 10ⁿ km step that gives at least `minRings` rings. */
export function roundKmStep(span: number, minRings = 3): number {
  const km = span / 1000 / minRings;
  if (!(km > 0)) return 1000;
  const e = Math.pow(10, Math.floor(Math.log10(km)));
  const m = km / e;
  const step = m >= 5 ? 5 : m >= 2 ? 2 : 1;
  return Math.max(1, step * e) * 1000;
}

export interface HoloZoom {
  /** Display metres per metre inside the zoom box. */
  scale: number;
  /** Range-ring step, m (round km), and how many rings fit. */
  ringStep: number;
  rings: number;
}

/** The zoom box around the ship or target: linear, `range` (m) to the box edge `boxHalf` (display m). */
export function holoZoom(range: number, boxHalf: number, out: HoloZoom): HoloZoom {
  const r = range > 1 ? range : 1;
  out.scale = boxHalf / r;
  out.ringStep = roundKmStep(r);
  out.rings = Math.floor(r / out.ringStep);
  return out;
}

// =============================================================================================== light balance

/** Lambert-sphere phase law Φ(α) = (sin α + (π − α)·cos α)/π; α = Sun–body–observer angle, rad. Φ(0) = 1. */
export function lambertPhase(alpha: number): number {
  const a = alpha < 0 ? -alpha : alpha > Math.PI ? Math.PI : alpha;
  return (Math.sin(a) + (Math.PI - a) * Math.cos(a)) / Math.PI;
}

/** Illuminance at the observer from an unresolved world: E_sun·p·(R/d)²·Φ(α) (geometric albedo p). */
export function unresolvedIlluminance(eSun: number, albedo: number, radius: number, dist: number, alpha: number): number {
  const k = radius / dist;
  return eSun * albedo * k * k * lambertPhase(alpha);
}

// =============================================================================================== re-entry sheath

/** Unit sheath axis: along the air-relative velocity (the flow comes from −û). Zero vector outside air. */
export function sheathDir(airVel: V3, out: V3): V3 {
  const l = Math.sqrt(airVel.x * airVel.x + airVel.y * airVel.y + airVel.z * airVel.z);
  if (!(l > 1e-9)) { out.x = 0; out.y = 0; out.z = 0; return out; }
  out.x = airVel.x / l; out.y = airVel.y / l; out.z = airVel.z / l;
  return out;
}

/** Sheath intensity = smoothstep(u; 3, 4 km/s)·√(q / 1 MW/m²), instantaneous: 0 the moment heatFlux is 0. */
export function sheathIntensity(u: number, heatFlux: number): number {
  if (!(heatFlux > 0)) return 0;
  const x = (u - 3000) / 1000;
  const s = x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
  return s * Math.sqrt(heatFlux / 1e6);
}

// =============================================================================================== screen washout

/** Diffuse reflectance of the console glass (anti-reflective cover glass). */
export const GLASS_RD = 0.01;
/** Auto-brightness: time constant (s) and range (cd/m²). */
export const AUTO_TAU = 1;
export const SCREEN_L_MIN = 10;
export const SCREEN_L_MAX = 1000;
/** The luminance the screen textures are authored for (gain 1). */
export const SCREEN_L_REF = 300;
/** Black level of the panel as a fraction of white (an emissive OLED-like panel: ≈ 0). */
export const SCREEN_BLACK = 0;

/** Veiling luminance of sunlight on the glass, cd/m²: R_d·E/π. */
export function veilLuminance(eLux: number, rd = GLASS_RD): number {
  return eLux > 0 ? (rd * eLux) / Math.PI : 0;
}

/** Auto-brightness target: 10·E^0.45 cd/m² (E in lx) inside 10…1000 (≈ 130 at 300 lx, 1000 by 3e4 lx). */
export function autoBrightnessTarget(eLux: number): number {
  const L = 10 * Math.pow(eLux > 1 ? eLux : 1, 0.45);
  return L < SCREEN_L_MIN ? SCREEN_L_MIN : L > SCREEN_L_MAX ? SCREEN_L_MAX : L;
}

export interface ScreenGlass {
  /** Current panel white luminance, cd/m² (the state; save it with the console if it is saved at all). */
  L: number;
}

/** Exact first-order step of the auto-brightness over sim dt toward the target for illuminance E. */
export function stepAutoBrightness(g: ScreenGlass, eLux: number, dt: number): ScreenGlass {
  g.L = relaxExact(g.L, autoBrightnessTarget(eLux), dt, AUTO_TAU);
  return g;
}

/** Contrast ratio white : black seen through the veil. */
export function screenContrast(L: number, eLux: number): number {
  const v = veilLuminance(eLux);
  const black = L * SCREEN_BLACK + v;
  return black > 0 ? (L + v) / black : Infinity;
}

// =============================================================================================== eyes and clocks

/** Eyelid transmission per channel (sRGB primaries): 4% in the red (650–700 nm), 0.4% in green and blue. */
export const LID_T: readonly [number, number, number] = [0.04, 0.004, 0.004];

/** Per-channel multiply for closedness c (0 open … 1 closed). */
export function eyelidTransmission(c: number, out: [number, number, number]): [number, number, number] {
  const k = c < 0 ? 0 : c > 1 ? 1 : c;
  out[0] = 1 + (LID_T[0] - 1) * k;
  out[1] = 1 + (LID_T[1] - 1) * k;
  out[2] = 1 + (LID_T[2] - 1) * k;
  return out;
}

/** Exact exponential relaxation over dt (any step size, never overshoots): target + (x − target)·e^(−dt/τ). */
export function relaxExact(x: number, target: number, dt: number, tau: number): number {
  if (!(dt > 0)) return x;
  if (!(tau > 0)) return target;
  return target + (x - target) * Math.exp(-dt / tau);
}

/**
 * A phase in doubles from sim time: (t·rate) mod period, always in [0, period). Continuous across a rotation as
 * long as the shader's pattern is periodic in `period`; never accumulates.
 */
export function phaseNoWrap(t: number, rate: number, period = 2 * Math.PI): number {
  const x = t * rate;
  const m = x - period * Math.floor(x / period);
  return m >= period ? 0 : m;
}

// =============================================================================================== hologram mapping

/** The display radius of a point (or the globe) at distance r from the body centre: linear, r·s. */
export function holoDisplayRadius(r: number, s: number): number {
  return r * s;
}

// =============================================================================================== photometry

const PLANCK_H = 6.62607015e-34, LIGHT_C = 2.99792458e8, BOLTZ_K = 1.380649e-23, STEFAN = 5.670374419e-8;
/** The solar constant at 1 AU, W/m² (stellarFlux units → W/m²). */
export const SOLAR_CONSTANT = 1361;
/** Astronomical unit, m. */
export const AU_M = 1.495978707e11;

/**
 * Luminous efficacy of a blackbody at T (lm per radiated W): 683·∫B_λ·V(λ)dλ / (σT⁴/π) over 360–830 nm, with the
 * Gaussian photopic V(λ) = 1.019·exp(−285.4(λ_µm − 0.559)²). 3482 K → 36.6 lm/W (the plan's 36.7), 5772 K → 92.
 * O(400): call once per star at load, not per frame.
 */
export function blackbodyEfficacy(T: number): number {
  const N = 400, l0 = 360e-9, dl = (830e-9 - l0) / N;
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const l = l0 + (i + 0.5) * dl;
    const B = (2 * PLANCK_H * LIGHT_C * LIGHT_C) / (l ** 5 * (Math.exp((PLANCK_H * LIGHT_C) / (l * BOLTZ_K * T)) - 1));
    const u = l * 1e6 - 0.559;
    sum += B * 1.019 * Math.exp(-285.4 * u * u) * dl;
  }
  return (683 * Math.PI * sum) / (STEFAN * T ** 4);
}

/** Illuminance (lx) on a surface facing a star of `luminosity` Sols and temperature T at `dist` m (unshadowed). */
export function starIlluminanceLux(luminosity: number, dist: number, T: number, efficacy = blackbodyEfficacy(T)): number {
  const au = dist / AU_M;
  return ((SOLAR_CONSTANT * luminosity) / (au * au)) * efficacy;
}

/** Illuminance on the console glass (lx): E·visibility·max(0, cos incidence)·window transmission. */
export function glassIlluminance(eLux: number, vis: number, cosInc: number, windowT: number): number {
  const c = cosInc > 0 ? cosInc : 0;
  return eLux * (vis > 0 ? vis : 0) * c * windowT;
}

/**
 * The photometric calibration of this pipeline: render units per cd/m². The scene lights a white Lambert surface
 * to radiance `keyLevel` (starIntensityAt; key.intensity = π·level) where physically it has E/π cd/m², so
 * 1 cd/m² = π·keyLevel/E render units (keyLevel and E both before the shadow factor, so it stays defined at night).
 */
export function renderPerNit(keyLevel: number, eLuxUnshadowed: number): number {
  return eLuxUnshadowed > 0 ? (Math.PI * keyLevel) / eLuxUnshadowed : 0;
}

// =============================================================================================== screens visible (item 11)

/**
 * Six frustum planes (a, b, c, d per plane, inside when a·x + b·y + c·z + d ≥ 0) from a column-major 4×4
 * view-projection matrix (three.js Matrix4.elements), Gribb–Hartmann. Not normalised (only signs are used).
 */
export function frustumPlanes(m: ArrayLike<number>, out: Float64Array): Float64Array {
  // row i of the matrix: m[i], m[4 + i], m[8 + i], m[12 + i]
  for (let p = 0; p < 6; p++) {
    const row = p >> 1, sgn = p & 1 ? -1 : 1;
    for (let k = 0; k < 4; k++) out[p * 4 + k] = m[k * 4 + 3] + sgn * m[k * 4 + row];
  }
  return out;
}


/**
 * W1-E item 11: true when any console glass quad can be on screen: the camera is inside the cockpit room (outside,
 * the opaque hull hides every console), the quad faces the camera, and no frustum plane has all four corners
 * outside. `glass` holds 12 numbers per quad (corners a, b, c, d counter-clockwise seen from the front),
 * cockpit-local axes like `cam` and the planes. Conservative (may say visible when hidden behind a seat).
 */
export function cockpitScreensVisible(cam: V3, planes: Float64Array, room: ArrayLike<number>, glass: ArrayLike<number>, nQuads: number): boolean {
  if (cam.x < room[0] || cam.y < room[1] || cam.z < room[2] || cam.x > room[3] || cam.y > room[4] || cam.z > room[5]) return false;
  for (let q = 0; q < nQuads; q++) {
    const o = q * 12;
    const ax = glass[o], ay = glass[o + 1], az = glass[o + 2];
    const ux = glass[o + 3] - ax, uy = glass[o + 4] - ay, uz = glass[o + 5] - az;
    const vx = glass[o + 6] - ax, vy = glass[o + 7] - ay, vz = glass[o + 8] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * (cam.x - ax) + ny * (cam.y - ay) + nz * (cam.z - az) <= 0) continue; // seen from behind
    let inside = true;
    for (let p = 0; p < 6 && inside; p++) {
      const a = planes[p * 4], b = planes[p * 4 + 1], c = planes[p * 4 + 2], d = planes[p * 4 + 3];
      let anyIn = false;
      for (let k = 0; k < 4; k++) {
        const x = glass[o + k * 3], y = glass[o + k * 3 + 1], z = glass[o + k * 3 + 2];
        if (a * x + b * y + c * z + d >= 0) { anyIn = true; break; }
      }
      inside = anyIn;
    }
    if (inside) return true;
  }
  return false;
}

// =============================================================================================== eyes closed (item 10)

/** The frame fields render/frame.ts gains on day 1 (defaults: open). */
export interface EyeFrameFields {
  /** The lids are shut: skip RT, shadow and probe updates; the composite multiplies by eyelidTransmission(lid). */
  eyesClosed: boolean;
  /** Closedness 0 (open) … 1 (shut). */
  lid: number;
}
export const EYE_FIELDS_DEFAULT: Readonly<EyeFrameFields> = { eyesClosed: false, lid: 0 };
/** Above this closedness the lids pass < 5% everywhere: the frame counts as eyes-closed. */
export const LID_SHUT = 0.999;
export const EYES_SAME = 0, EYES_CLOSING = 1, EYES_WAKE = 2;

/** Write the frame fields from the lid closedness. */
export function setEyeFields(f: EyeFrameFields, lid: number): EyeFrameFields {
  const l = lid > 0 ? (lid < 1 ? lid : 1) : 0;
  f.lid = l;
  f.eyesClosed = l >= LID_SHUT;
  return f;
}

/** The transition between two frames: EYES_WAKE means reset the RT history (its accumulated frames are stale). */
export function eyesTransition(wasClosed: boolean, isClosed: boolean): number {
  return wasClosed === isClosed ? EYES_SAME : isClosed ? EYES_CLOSING : EYES_WAKE;
}
