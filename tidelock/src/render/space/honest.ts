// Honest pixels, the small pure laws (SIMULATION.md W1-E items 3, 5, 7, 8, 9, 10). No three.js, no DOM, no
// allocation (results go into caller-owned objects), sim time only. Each function is the whole law the renderer
// needs; the call sites stay one line.
//
// WIRING (wave 1, W1-E; nothing here is called yet):
//   * hologram.ts rebuild (the `rmap`/`sc` block, "globe at 0.42 R, altitude compressed"): replace with
//     `const s = holoScale(R, bodyR, ext)` and draw every point at r·s (globe radius bodyR·s). Delete uSpin
//     (`(time * 0.12) % 2π`), the flicker and the dip. Zoom box: `holoZoom(range, boxHalf, out)` gives its scale and
//     the round-km ring step. Meridians: rotate the globe by `body.spinAngle`; terminator from the star direction.
//   * effects.ts plasma sheath (EffectsManager plasma / scene.ts setPlasma caller): direction `sheathDir(view.airVelocity,
//     out)` instead of the barycentric velocity; intensity `sheathIntensity(|airVelocity|, view.heatFlux)` set every
//     frame with no easing (no lingering). The screen-space filaments and the heat-haze UV warp are deleted.
//   * scene.ts far bodies (`b.light = starIntensityAt(...) * starVisibility(...)` and the far point markers):
//     unresolved worlds use `unresolvedIlluminance(E_sun, albedo, R, d, phaseAngle)`; `lambertPhase(α)` is Φ(α).
//   * cockpit.ts / instruments.ts screens: one `ScreenGlass` per console; per frame (sim dt)
//     `stepAutoBrightness(g, E_glass_lux, dtSim)`, then the screen emissive gain = g.L / SCREEN_L_REF and the veil
//     `veilLuminance(E_glass_lux)` added (cd/m², converted with the pipeline's luminance scale). Glass diffuse
//     albedo GLASS_RD in the material and in the RT record.
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
