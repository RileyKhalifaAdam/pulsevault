// Atmosphere: exponential density co-rotating with its body, drag on the air-relative velocity, convective
// heating into the hull's heat capacity with radiative loss. The forces themselves are applied inside the
// craft integrator (dynamics.ts `force`), which calls the formulas below.

import type { Atmosphere } from './state';

/** Convective heating coefficient (Sutton–Graves form, SI): q = k·√ρ·v³ W/m² for a 1 m nose radius. */
export const HEAT_FLUX_COEFF = 1.7415e-4;
/** Default aerodynamic deceleration that breaks a hull, m/s² (15 g). */
export const DEFAULT_MAX_LOAD = 15 * 9.80665;

/**
 * Density, kg/m³, at `altitude` m above the surface: exponential with the scale height, shifted and rescaled
 * so it is exactly the surface density at 0 and exactly 0 at the top (no step in the drag at the boundary).
 */
export function airDensity(atm: Atmosphere, altitude: number): number {
  if (altitude >= atm.height) return 0;
  if (altitude <= 0) return atm.surfaceDensity;
  const off = Math.exp(-atm.height / atm.scaleHeight);
  return (atm.surfaceDensity * (Math.exp(-altitude / atm.scaleHeight) - off)) / (1 - off);
}

/** Dynamic pressure ½ρv², Pa. */
export const dynamicPressure = (rho: number, airspeed: number): number => 0.5 * rho * airspeed * airspeed;

/** Drag deceleration ½ρv²·CdA / m, m/s². */
export const dragAccel = (rho: number, airspeed: number, dragArea: number, mass: number): number =>
  (0.5 * rho * airspeed * airspeed * dragArea) / mass;

/** Heating power into the hull, W: k·√ρ·v³·area. */
export const heatingPower = (rho: number, airspeed: number, heatArea: number): number =>
  HEAT_FLUX_COEFF * Math.sqrt(rho > 0 ? rho : 0) * airspeed * airspeed * airspeed * heatArea;

/** Radiative loss, W, of a hull holding `heat` J: proportional to the stored fraction. */
export const radiativeLoss = (heat: number, heatCapacity: number, heatDissipation: number): number =>
  (heatDissipation * heat) / heatCapacity;
