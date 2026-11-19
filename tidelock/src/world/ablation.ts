// Ablation of the thermal protection (docs/SIMULATION.md W3-B item 6, `env-ablation`): the tiled belly's TPS layer
// (thermalNet nodes N_TPS_BF / N_TPS_BA over hull zones belly-fwd / belly-aft) is a charring ablator. Above
// T_ABL = 800 K the net heat into the layer goes into ablation at H_eff = 20 MJ/kg instead of raising its
// temperature: after each implicit thermal step the energy above 800 K, C·(T − T_abl), is converted into ablated
// mass dm = C·(T − T_abl)/H_eff (capped by what is left) and the node is set back by dm·H_eff/C. That is the plan's
// ṁ = q_net/H_eff integrated over the step, energy-exact (the latent energy leaves with the gas: out.latentJ).
// Thickness, heat capacity and conductance follow the remaining mass m: C = c·m (≥ 1 % of new, so the node never
// becomes singular), the tile's conduction to the substrate k·A/t with t = t₀·m/m₀ (capped at a 1000 W/m²K bond
// contact), and once spent the node's limit (and caution) become the substrate's bond-line limit — the plan's "once
// spent, the zone limit becomes the substrate's". The sensible heat of the removed layer, (C_old − C_new)·(T − 293 K),
// also leaves with the gas (out.sensibleJ), so storedHeat + latent + sensible is conserved.
// New: 3.5 kg/m² (25 mm at 140 kg/m³): 427 kg fore, 392 kg aft, ≈ 16 GJ of ablation between them. The RCC nose
// cap is reradiative (it does not ablate) and keeps its 1900 K limit.
//
// WIRING (wave 3): shipSystems.ts systemsStep, after EVERY thermalStep sub-step: ablateStep(tn, net, st.thermal.T,
// c.tpsMass, out) (the §1.4 field tpsMass: number[], one per TPS zone, kg; W3-A adds it to the mass properties at the
// zone centroids). At load: c.tpsMass = loadTps(saved?.tpsMass); applyTps(tn, net, c.tpsMass) (C, conductance,
// limits are derived from the saved mass, never saved themselves). Out: ablatedKg (W3-A mass), latentJ + sensibleJ
// (energy book), the ablating flag per zone for W3-E's char glow / sheath seeding. Allocation-free per step.

import { HULL_ZONES, Z_BELLY_AFT, Z_BELLY_FWD } from '../data/hullZones';
import { N_TPS_BA, N_TPS_BF, TPS_AREAL_C, TPS_K_OVER_T } from '../data/thermalNet';
import type { ThermalNet } from './thermal';

export const T_ABL = 800;
export const H_EFF = 20e6;
export const TPS_RHO = 140;
export const TPS_T0 = 0.025;
export const TPS_K = TPS_K_OVER_T * TPS_T0;
export const TPS_BOND_U = 1000;
export const TPS_C_MIN_FRAC = 0.01;
const T_REF = 293;

export interface TpsNet {
  n: number;
  node: Int32Array;
  sub: Int32Array;
  link: Int32Array;
  A: Float64Array;
  m0: Float64Array;
  C0: Float64Array;
  limit0: Float64Array;
  caution0: Float64Array;
}

export interface TpsOut {
  ablatedKg: number;
  latentJ: number;
  sensibleJ: number;
  ablating: Uint8Array;
}

/** The Wren's two TPS zones, bound to a compiled thermal net. */
export function compileTps(net: ThermalNet): TpsNet {
  const zones = [Z_BELLY_FWD, Z_BELLY_AFT], nodes = [N_TPS_BF, N_TPS_BA];
  const link = nodes.map((nd, i) => {
    for (let k = 0; k < net.nLinks; k++) if ((net.la[k] === nd && net.lb[k] === zones[i]) || (net.lb[k] === nd && net.la[k] === zones[i])) return k;
    throw new Error('ablation: no TPS → substrate link');
  });
  return {
    n: 2, node: Int32Array.from(nodes), sub: Int32Array.from(zones), link: Int32Array.from(link),
    A: Float64Array.from(zones, (z) => HULL_ZONES[z].area), m0: Float64Array.from(zones, (z) => TPS_RHO * TPS_T0 * HULL_ZONES[z].area),
    C0: Float64Array.from(zones, (z) => TPS_AREAL_C * HULL_ZONES[z].area),
    limit0: Float64Array.from(nodes, (nd) => net.limit[nd]), caution0: Float64Array.from(nodes, (nd) => net.caution[nd]),
  };
}

export const makeTps = (tn: TpsNet): number[] => Array.from(tn.m0);
export const makeTpsOut = (tn: TpsNet): TpsOut => ({ ablatedKg: 0, latentJ: 0, sensibleJ: 0, ablating: new Uint8Array(tn.n) });

/** Derived thermal properties of zone i from its remaining mass m (C, link conductance, limits). */
function applyZone(tn: TpsNet, net: ThermalNet, i: number, m: number): void {
  const f = m / tn.m0[i];
  const nd = tn.node[i], k = tn.link[i];
  net.C[nd] = tn.C0[i] * (f > TPS_C_MIN_FRAC ? f : TPS_C_MIN_FRAC);
  const t = TPS_T0 * f;
  const U = t > 0 && TPS_K / t < TPS_BOND_U ? TPS_K / t : TPS_BOND_U;
  net.G0[k] = U * tn.A[i]; net.G[k] = net.G0[k];
  if (m > 0) { net.limit[nd] = tn.limit0[i]; net.caution[nd] = tn.caution0[i]; }
  else { net.limit[nd] = net.limit[tn.sub[i]]; net.caution[nd] = net.caution[tn.sub[i]]; }
}

/** At load: rebuild the derived properties from the saved masses. */
export function applyTps(tn: TpsNet, net: ThermalNet, tps: number[]): void {
  for (let i = 0; i < tn.n; i++) applyZone(tn, net, i, tps[i]);
}

/** After a thermal step: ablate the energy above T_ABL (header). T is the thermal state's T array. */
export function ablateStep(tn: TpsNet, net: ThermalNet, T: { [i: number]: number }, tps: number[], o: TpsOut): void {
  o.ablatedKg = 0; o.latentJ = 0; o.sensibleJ = 0;
  for (let i = 0; i < tn.n; i++) {
    o.ablating[i] = 0;
    const nd = tn.node[i], m = tps[i];
    if (!(m > 0) || !(T[nd] > T_ABL)) continue;
    const C = net.C[nd];
    let dm = C * (T[nd] - T_ABL) / H_EFF;
    if (dm > m) dm = m;
    T[nd] -= dm * H_EFF / C;
    const m1 = m - dm > 0 ? m - dm : 0;
    tps[i] = m1;
    applyZone(tn, net, i, m1);
    o.sensibleJ += (C - net.C[nd]) * (T[nd] - T_REF);
    o.ablatedKg += dm;
    o.latentJ += dm * H_EFF;
    o.ablating[i] = 1;
  }
}

export const saveTps = (tps: number[]): number[] => tps.slice();
export function loadTps(tn: TpsNet, raw: unknown): number[] {
  const t = makeTps(tn);
  if (Array.isArray(raw) && raw.length === tn.n) for (let i = 0; i < tn.n; i++) { const x = raw[i]; if (typeof x === 'number' && Number.isFinite(x)) t[i] = Math.min(tn.m0[i], Math.max(0, x)); }
  return t;
}
