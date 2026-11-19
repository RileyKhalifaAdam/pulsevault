// The Wren's electrical system (docs/SIMULATION.md W2-D item 2): the drive bus (reactor → torches) and the 120 V
// DC hotel bus (reactor converter, shore power, the 50 kWh battery, 8 push-pull breaker circuits, the loads).
// Pure data; no three.js, no DOM.
//
// WIRING (wave 2): src/world/power.ts reads these tables; shipSystems.ts writes load demands by the L_* indices
// (fractions 0..1 of the nominal power) from the devices of data/cockpit.ts and data/interiors.ts:
//   lights per room ← per-room light switches; screens/avionics ← 1 while the ship is powered; L_RCS ← mean jetDuty
//   over the step (Σ duty / nJets); L_CMG ← CMG electrical power / CMG_P (W2-B); fans / scrubber ← their switches
//   (W2-D air); HVAC heaters / coolers and the pump ← shipSystems.ts itself; floods / nav / strobe ← EXT LIGHTS;
//   shutters ← motor moving (W2-D devices); galley, latch actuator, fuel valves ← their devices.
// The breaker panel device writes power.breakers[c] (1 pushed in, 0 pulled); a trip writes 0 here.

import { INTERIORS } from './interiors';
import { SHIP_LAYOUTS } from './shipLayouts';
import { Z_DORSAL_FWD } from './hullZones';
import { HVAC_CAP, HVAC_SINK, N_AVIONICS, N_LOOP, N_ROOM0, N_STRUCT_A, N_STRUCT_F, N_STRUCT_M } from './thermalNet';

/** Exterior lamps dissipate in the dorsal-fore skin (skin node index = hull zone index). */
const Z_DORSAL_FWD_NODE = Z_DORSAL_FWD;

export const BUS_V_NOM = 120;
/** Battery: 50 kWh, V_oc linear 112 V (empty) … 126 V (full), internal resistance, largest charge current. */
export const BATT_E_CAP = 1.8e8;
export const BATT_VOC_EMPTY = 112;
export const BATT_VOC_FULL = 126;
export const BATT_R = 0.02;
export const BATT_I_CHARGE = 200;
/** Reactor → hotel converter rating and regulation voltage; shore power when docked. */
export const CONV_P_MAX = 60e3;
export const BUS_V_REG = 126;
export const SHORE_P = 50e3;
/** Reactor: rated electric output (2 × 14 MW), load-following ramp (fraction of rated per s), conversion efficiency. */
export const REACTOR_P_RATED = 28e6;
export const REACTOR_RAMP = 0.02;
export const REACTOR_ETA = 0.3;
/** Torch electrical load per engine, and the drive-bus fraction that counts as "carrying the load". */
export const DRIVE_P_ENGINE = 5e6;
export const N_ENGINES = 2;
export const DRIVE_READY_FRAC = 0.98;
export const DRIVE_BUS_V_NOM = 3000;
/** Breakers: thermal I²t trip at ∫(I² − I_r²)dt > BREAKER_TRIP_S·I_r²; electronics trip below UV_TRIP_V. */
export const BREAKER_TRIP_S = 5;
export const UV_TRIP_V = 100;
/** Motor and pump drives drop out (not latched) below this, V. */
export const CP_DROPOUT_V = 90;

export interface CircuitDef {
  id: string;
  name: string;
  /** Rated current, A. */
  rating: number;
  /** Electronics: latched trip on undervoltage. */
  uvTrip: boolean;
  /** Thermal node that takes the heat of a fault (short) on this circuit. */
  faultNode: number;
}

export const CIRCUITS: readonly CircuitDef[] = [
  { id: 'ltg-fwd', name: 'LTG FWD', rating: 10, uvTrip: false, faultNode: N_STRUCT_F },
  { id: 'ltg-aft', name: 'LTG AFT', rating: 10, uvTrip: false, faultNode: N_STRUCT_M },
  { id: 'avionics', name: 'AVIONICS', rating: 15, uvTrip: true, faultNode: N_AVIONICS },
  { id: 'flt-ctl', name: 'FLT CTL', rating: 25, uvTrip: true, faultNode: N_STRUCT_M },
  { id: 'life-sup', name: 'LIFE SUP', rating: 15, uvTrip: false, faultNode: N_STRUCT_M },
  { id: 'thermal', name: 'THERMAL', rating: 70, uvTrip: false, faultNode: N_STRUCT_A },
  { id: 'exterior', name: 'EXT LTS', rating: 10, uvTrip: false, faultNode: N_STRUCT_F },
  { id: 'utility', name: 'UTILITY', rating: 15, uvTrip: false, faultNode: N_STRUCT_M },
];
export const N_CIRCUITS = CIRCUITS.length;

/** Load kinds: constant power (electronics, motor drives) or resistive (lamps, P ∝ V²). */
export const LOAD_CP = 0;
export const LOAD_RES = 1;

export interface LoadDef {
  id: string;
  circuit: number;
  /** Nominal power at 120 V (resistive) or the drawn power (constant-power), W. */
  P: number;
  kind: number;
  /** Thermal node the delivered electrical power ends in as heat. */
  node: number;
}

const ROOMS = INTERIORS.wren!.rooms;
/** Lamp power per room (15–40 W fixtures), W. */
const ROOM_LAMPS: Record<string, number> = {
  cockpit: 60, vestibule: 15, lounge: 150, corridor: 80, 'cabin-port': 50, 'cabin-stbd': 50, washroom: 40, suitroom: 40, cargo: 240, engineering: 160,
};
/** RCS valve coils while open, W per jet. */
export const RCS_VALVE_P = 40;
export const N_RCS_JETS = SHIP_LAYOUTS.wren.rcs.length;
export const CMG_P = 1200;
export const PUMP_P = 3000;
export const SCREEN_P = 30;
export const N_SCREENS = 6;

function build(): LoadDef[] {
  const L: LoadDef[] = [];
  ROOMS.forEach((r, i) => L.push({ id: `lights-${r.id}`, circuit: i < 6 ? 0 : 1, P: ROOM_LAMPS[r.id] ?? 30, kind: LOAD_RES, node: N_ROOM0 + i }));
  L.push({ id: 'screens', circuit: 2, P: SCREEN_P * N_SCREENS, kind: LOAD_CP, node: N_ROOM0 }); // cockpit
  L.push({ id: 'avionics', circuit: 2, P: 600, kind: LOAD_CP, node: N_AVIONICS });
  L.push({ id: 'rcs-valves', circuit: 3, P: RCS_VALVE_P * N_RCS_JETS, kind: LOAD_CP, node: N_STRUCT_F });
  L.push({ id: 'cmg', circuit: 3, P: CMG_P, kind: LOAD_CP, node: N_STRUCT_M });
  L.push({ id: 'fans', circuit: 4, P: 600, kind: LOAD_CP, node: N_ROOM0 + 3 }); // corridor
  L.push({ id: 'scrubber', circuit: 4, P: 500, kind: LOAD_CP, node: N_ROOM0 + 9 }); // engineering
  ROOMS.forEach((r, i) => L.push({ id: `heater-${r.id}`, circuit: 5, P: HVAC_CAP[i], kind: LOAD_CP, node: N_ROOM0 + i }));
  // cooler compressor work ends in the sink with the heat it moves
  ROOMS.forEach((r, i) => L.push({ id: `cooler-${r.id}`, circuit: 5, P: HVAC_CAP[i], kind: LOAD_CP, node: HVAC_SINK }));
  L.push({ id: 'pump', circuit: 5, P: PUMP_P, kind: LOAD_CP, node: N_LOOP });
  L.push({ id: 'floods', circuit: 6, P: 400, kind: LOAD_RES, node: Z_DORSAL_FWD_NODE });
  L.push({ id: 'nav', circuit: 6, P: 50, kind: LOAD_RES, node: Z_DORSAL_FWD_NODE });
  L.push({ id: 'strobe', circuit: 6, P: 50, kind: LOAD_RES, node: Z_DORSAL_FWD_NODE });
  L.push({ id: 'shutters', circuit: 6, P: 4 * 60, kind: LOAD_CP, node: N_STRUCT_F });
  L.push({ id: 'galley', circuit: 7, P: 1000, kind: LOAD_CP, node: N_ROOM0 + 2 }); // lounge
  L.push({ id: 'latch', circuit: 7, P: 200, kind: LOAD_CP, node: N_STRUCT_M });
  L.push({ id: 'valves', circuit: 7, P: 100, kind: LOAD_CP, node: N_STRUCT_A });
  return L;
}

export const LOADS: readonly LoadDef[] = build();
export const N_LOADS = LOADS.length;
const li = (id: string): number => LOADS.findIndex((l) => l.id === id);
export const L_LIGHT0 = 0;
export const L_SCREENS = li('screens');
export const L_AVIONICS = li('avionics');
export const L_RCS = li('rcs-valves');
export const L_CMG = li('cmg');
export const L_FANS = li('fans');
export const L_SCRUBBER = li('scrubber');
export const L_HEATER0 = li(`heater-${ROOMS[0].id}`);
export const L_COOLER0 = li(`cooler-${ROOMS[0].id}`);
export const L_PUMP = li('pump');
export const L_FLOODS = li('floods');
export const L_NAV = li('nav');
export const L_STROBE = li('strobe');
export const L_SHUTTERS = li('shutters');
export const L_GALLEY = li('galley');
export const L_LATCH = li('latch');
export const L_VALVES = li('valves');

/** Default demand fractions: lights on in the cockpit and lounge, electronics on, fans and scrubber on, pump on. */
export function defaultDemand(out: Float64Array): Float64Array {
  out.fill(0);
  out[L_LIGHT0] = 1; out[L_LIGHT0 + 2] = 1;
  out[L_SCREENS] = 1; out[L_AVIONICS] = 1; out[L_FANS] = 1; out[L_SCRUBBER] = 1; out[L_PUMP] = 1; out[L_NAV] = 1;
  return out;
}
