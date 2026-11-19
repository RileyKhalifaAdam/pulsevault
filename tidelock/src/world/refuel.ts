// Refuelling through a docked port (docs/SIMULATION.md W2-C item 6): two transfer lines (LH2 to the main pool,
// hydrazine to the RCS pool), each an orifice flow ṁ = C_d·A·√(2ρΔp) scaled by its valve opening, with the station
// pump holding Δp. Flow only while hard-docked; it stops exactly when the ship's tank is full or the station's store
// is empty. Constant flow over a step is exact at any step size (warp-honest without a limitedBy reason), and the
// step reports when the next flow edge happens so a scheduler can land a quantum on it. Pure, allocation-free.
//
// WIRING (wave 2):
// - session/world tick (or once per quantum under warp), for a ship hard-docked (capture phase 'hard') at a station
//   whose StationDef.services includes 'refuel':
//     IO.dt = h; IO.docked = true; IO.lh2 = s.valves.lh2; IO.n2h4 = s.valves.n2h4   (§1.4, W2-D's FUEL devices)
//     refuelStep(IO, s, st)   // s.propellant/propellantCapacity, s.rcsPropellant/rcsPropellantCapacity; the
//                             // station's store IS st.propellant (LH2) and st.rcsPropellant (N2H4): mass conserved
//   Station stores at setup: st.propellant = STATION_LH2[visualId] (the Wheel 2e6 kg), st.rcsPropellant = STATION_N2H4[…].
//   IO.mdotLh2 drives the gauge, W2-F's line sound and W2-D's valve flow noise; IO.nextEdge (s) may bound a quantum.
// Reads valves (§1.4); writes propellant and rcsPropellant of both craft. ≈ 0.02 µs per call in node.

/** A transfer line: discharge coefficient, bore (m), liquid density (kg/m³), pump head Δp (Pa). */
export interface Line { cd: number; d: number; rho: number; dp: number }

/** 50 mm LH2 line at 3 bar: ṁ = 0.6·π·0.025²·√(2·71·3e5) = 7.69 kg/s (22.5 t in ≈ 49 min). */
export const LH2_LINE: Line = { cd: 0.6, d: 0.05, rho: 71, dp: 3e5 };
/** Hydrazine line sized for 0.5 kg/s at the same head: d = √(4·0.5/(π·0.6·√(2·1004·3e5))) ≈ 6.6 mm. */
export const N2H4_LINE: Line = { cd: 0.6, d: Math.sqrt((4 * 0.5) / (Math.PI * 0.6 * Math.sqrt(2 * 1004 * 3e5))), rho: 1004, dp: 3e5 };

/** Station stores by archetype at setup, kg (the Wheel holds 2e6 kg of LH2). */
export const STATION_LH2: Record<string, number> = { ringHabitat: 2e6, spindle: 1e6, refinery: 5e6, outpost: 5e4, drydock: 5e5, citadel: 3e5 };
export const STATION_N2H4: Record<string, number> = { ringHabitat: 5e4, spindle: 3e4, refinery: 1e5, outpost: 5e3, drydock: 2e4, citadel: 2e4 };

/** Full-open mass flow of a line, kg/s. */
export function lineFlow(l: Line): number {
  return l.cd * 0.25 * Math.PI * l.d * l.d * Math.sqrt(2 * l.rho * l.dp);
}
const MDOT_LH2 = lineFlow(LH2_LINE);
const MDOT_N2H4 = lineFlow(N2H4_LINE);

export interface RefuelIO {
  /** Inputs: step (s), hard-docked, valve openings 0..1. */
  dt: number;
  docked: boolean;
  lh2: number;
  n2h4: number;
  /** Outputs: flow at the start of the step (kg/s), mass moved this step (kg), time to the next flow edge (s, ∞). */
  mdotLh2: number;
  mdotN2h4: number;
  dmLh2: number;
  dmN2h4: number;
  nextEdge: number;
}
export function makeRefuelIO(): RefuelIO {
  return { dt: 0, docked: false, lh2: 0, n2h4: 0, mdotLh2: 0, mdotN2h4: 0, dmLh2: 0, dmN2h4: 0, nextEdge: Infinity };
}

interface ShipTanks { propellant: number; propellantCapacity: number; rcsPropellant: number; rcsPropellantCapacity: number }
interface StationStore { propellant: number; rcsPropellant: number }

const clamp01 = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);

/** Move propellant over io.dt (exact for constant valves). Returns nothing; see io. */
export function refuelStep(io: RefuelIO, s: ShipTanks, st: StationStore): void {
  io.mdotLh2 = io.mdotN2h4 = io.dmLh2 = io.dmN2h4 = 0;
  io.nextEdge = Infinity;
  if (!io.docked || !(io.dt > 0)) return;
  // LH2
  const q1 = MDOT_LH2 * clamp01(io.lh2);
  if (q1 > 0) {
    const room = s.propellantCapacity - s.propellant, have = st.propellant, lim = room < have ? room : have;
    if (lim > 0) {
      io.mdotLh2 = q1;
      const want = q1 * io.dt, dm = want < lim ? want : lim;
      s.propellant += dm; st.propellant -= dm; io.dmLh2 = dm;
      if (want < lim) io.nextEdge = (lim - dm) / q1;
    }
  }
  const q2 = MDOT_N2H4 * clamp01(io.n2h4);
  if (q2 > 0) {
    const room = s.rcsPropellantCapacity - s.rcsPropellant, have = st.rcsPropellant, lim = room < have ? room : have;
    if (lim > 0) {
      io.mdotN2h4 = q2;
      const want = q2 * io.dt, dm = want < lim ? want : lim;
      s.rcsPropellant += dm; st.rcsPropellant -= dm; io.dmN2h4 = dm;
      if (want < lim) { const e = (lim - dm) / q2; if (e < io.nextEdge) io.nextEdge = e; }
    }
  }
}
