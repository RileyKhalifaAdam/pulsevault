// Master caution (docs/SIMULATION.md W2-D item 6): latched thresholds with hysteresis. Each condition becomes
// ACTIVE when its value crosses `on` and inactive again only past `off` (so it cannot chatter); a condition that
// becomes active lights the MASTER CAUTION lamp (latched until the plunger is pressed) and WAKES the sleeper.
//
// WIRING (wave 2): systemsStep (src/world/shipSystems.ts) fills the slots it owns (battery, over-temperature,
// breaker trip, drive inhibit, undervoltage) and calls cautionStep once per systems step; the session fills the
// other slots before it from its own states, once per systems step (10 Hz at 1×, per quantum under warp):
//   C_RCS_POOL = rcsPropellant/rcsPropellantCapacity, C_MAIN_POOL = propellant/propellantCapacity (§1.4 wave 1),
//   C_PROX = 1 when the target range < 200 m while closing faster than 0.5 m/s, C_PERIAPSIS = 1 when the predicted
//   periapsis is below atm.top (the ρ = 1e-7 level, NOT W2-B's tableTop), C_IMPACT = predicted time to impact, s,
//   C_CO2 / C_O2 = the worst room's ppCO₂ / ppO₂, Pa (W2-D air).
// The MASTER CAUTION plunger device calls cautionAck. `wake` (the return value ≠ 0) is ORed into the session's
// sleep-wake test (today only contact wakes the sleeper). Save: CautionState (plain JSON) with loader defaults.
// Values default to neutral (cautionNeutral) so an unwired slot never triggers.

export const C_RCS_POOL = 0, C_MAIN_POOL = 1, C_OVERTEMP = 2, C_PROX = 3, C_PERIAPSIS = 4, C_IMPACT = 5;
export const C_BATTERY = 6, C_CO2 = 7, C_O2 = 8, C_BREAKER = 9, C_INHIBIT = 10, C_UNDERVOLT = 11;
export const N_CAUTIONS = 12;

export interface CautionDef {
  id: string;
  /** +1: active when value > on, clears below off; −1: active when value < on, clears above off. */
  dir: number;
  on: number;
  off: number;
  /** Neutral value of an unwired slot. */
  neutral: number;
}

export const CAUTIONS: readonly CautionDef[] = [
  { id: 'rcs-pool', dir: -1, on: 0.10, off: 0.12, neutral: 1 },
  { id: 'main-pool', dir: -1, on: 0.10, off: 0.12, neutral: 1 },
  // max over nodes of T − T_caution (zones: 0.8 × limit), K
  { id: 'overtemp', dir: 1, on: 0, off: -10, neutral: -1e9 },
  { id: 'proximity', dir: 1, on: 0.5, off: 0.5, neutral: 0 },
  { id: 'periapsis', dir: 1, on: 0.5, off: 0.5, neutral: 0 },
  { id: 'impact', dir: -1, on: 600, off: 660, neutral: Infinity },
  { id: 'battery', dir: -1, on: 0.20, off: 0.22, neutral: 1 },
  { id: 'co2', dir: 1, on: 1000, off: 900, neutral: 0 },
  { id: 'o2', dir: -1, on: 16e3, off: 16.5e3, neutral: 21e3 },
  { id: 'breaker', dir: 1, on: 0.5, off: 0.5, neutral: 0 },
  { id: 'drive-inhibit', dir: 1, on: 0.5, off: 0.5, neutral: 0 },
  { id: 'undervoltage', dir: -1, on: 105, off: 108, neutral: 120 },
];

export interface CautionState {
  /** Bitmask of active conditions. */
  active: number;
  /** Bitmask of conditions that became active since the last acknowledgement (what the SYS page lists). */
  unacked: number;
  /** MASTER CAUTION lamp. */
  lamp: boolean;
}

export const makeCautionState = (): CautionState => ({ active: 0, unacked: 0, lamp: false });

export function cautionNeutral(out: Float64Array): Float64Array {
  for (let i = 0; i < N_CAUTIONS; i++) out[i] = CAUTIONS[i].neutral;
  return out;
}

export const makeCautionValues = (): Float64Array => cautionNeutral(new Float64Array(N_CAUTIONS));

/** Update with this step's values; returns the bitmask of conditions that became active now (≠ 0: wake). */
export function cautionStep(cs: CautionState, values: Float64Array): number {
  let fresh = 0;
  for (let i = 0; i < N_CAUTIONS; i++) {
    const d = CAUTIONS[i], v = values[i], bit = 1 << i;
    if (cs.active & bit) {
      if (d.dir > 0 ? v <= d.off : v >= d.off) cs.active &= ~bit;
    } else if (d.dir > 0 ? v > d.on : v < d.on) {
      cs.active |= bit;
      fresh |= bit;
    }
  }
  if (fresh) { cs.unacked |= fresh; cs.lamp = true; }
  return fresh;
}

/** The MASTER CAUTION plunger: lamp off, list cleared (active conditions stay active and re-light only when they recur). */
export function cautionAck(cs: CautionState): void {
  cs.lamp = false;
  cs.unacked = 0;
}

export const saveCaution = (cs: CautionState): CautionState => ({ active: cs.active, unacked: cs.unacked, lamp: cs.lamp });

export function loadCaution(saved: unknown): CautionState {
  const s = makeCautionState();
  const o = saved as Partial<CautionState> | null | undefined;
  if (!o || typeof o !== 'object') return s;
  if (typeof o.active === 'number') s.active = o.active | 0;
  if (typeof o.unacked === 'number') s.unacked = o.unacked | 0;
  if (typeof o.lamp === 'boolean') s.lamp = o.lamp;
  return s;
}
