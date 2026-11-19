// Layered atmosphere profile (SIMULATION.md W2-B item 5): temperature with altitude, mean molar mass with altitude,
// density and pressure by hydrostatic integration, speed of sound, mean free path. Built once per body at load
// (derived data, never saved), looked up per force evaluation.
//
// WIRING (wave 2; nothing here is called yet):
//   * sim/universe.ts buildAtmosphere: carry the inputs the profile needs into AtmosphereDef (molarMass, and the
//     surface temperature the scale height was made from, i.e. the body's `temperature`). `height` (atm.top, where
//     the OLD exponential reaches 1e-7 kg/m³) is NOT changed: station placement, the 'atmosphere' situation and
//     event (it wakes the sleeper), the predictor's atmosphere event, cautions and line of sight keep using it.
//   * world/setup.ts createWorld (and world.ts load, since it is derived): per body with an atmosphere
//       profiles[i] = buildAtmoProfile({ surfaceDensity, scaleHeight, mu, radius, surfaceTemp, molarMass })
//     kept OUTSIDE the saved state (like the ephemeris cache). `atm.tableTop` (§1.4) = profiles[i].tableTop.
//   * world/dynamics.ts force() / chooseDt(): replace `airDensity(atm, alt)` with
//       io[AT_ALT] = alt; atmoAt(profile, io); rho = io[AT_RHO]
//     and gate drag/heating on `alt < profile.tableTop` instead of `alt < atm.height` (the 'atmosphere' event and
//     c.inAtmosphere stay on atm.height). io[AT_T], io[AT_A], io[AT_MFP] feed aero.ts (Mach, Knudsen, re-emission),
//     io[AT_P] feeds nozzle.ts (ambient-pressure thrust). Rate: every force evaluation (4 per RK4 step) in air.
//   * Weak drag above atm.height: see perturb.ts (WEAK_DRAG_ACCEL, kick–drift–kick around stepCoast).
//   * Audio (W2-F) reads io[AT_A] (speed of sound) through the view at the craft's altitude.
//   Contract fields: writes atm.tableTop (rebuilt, not saved); reads nothing saved.
//
// Model (in units of H₀ = R·T_s/(M_s·g₀), the surface scale height; Earth: H₀ ≈ 8.4 km):
//   T: lapse 0.67·g₀/c_p to the tropopause at 1.5·H₀ (its temperature FOLLOWS from the lapse, ≈0.71·T_s for
//      γ = 1.4; not imposed), linear to 0.94·T_s at 6·H₀ (stratopause), linear to 0.65·T_s at 11·H₀ (mesopause),
//      linear to T₁₄ = T_m + 0.22·(T_exo − T_m) at 14·H₀, then the Bates thermosphere
//      T = T_exo − (T_exo − T₁₄)·exp(−0.153·(z/H₀ − 14)) (≈75% of the rise by 20·H₀, as MSIS),
//      T_exo = 1000 K·(1 + 0.5·(activity − 0.35)).
//   M: M_s up to the homopause at 12·H₀, then diffusive separation toward atomic oxygen,
//      M = M_top + (M_s − M_top)·exp(−(z/H₀ − 12)/12) (M_top = 0.016 kg/mol; never above M_s; H₂ worlds → M_s/2).
//   γ follows M between γ_s and 5/3 (monatomic). g(z) = μ/(R + z)².
//   d ln p / dz = −M(z)·g(z)/(R_gas·T(z)), RK4 at H₀/64, anchored at p₀ = ρ₀·R_gas·T_s/M_s; ρ = p·M/(R_gas·T).
//   Integrated up to ρ < 1e-15 kg/m³ (that altitude is tableTop), resampled to N (default 512) uniform entries of
//   ln ρ, T, M; lookup is linear in ln ρ (exponential within a cell), T and M. ρ_used = ρ − ρ(tableTop), so drag
//   reaches exactly 0 at the top with no step.
// Pure, deterministic, allocation-free on the lookup path (builder allocates once). No three.js, no DOM.

/** Universal gas constant, J/(mol·K). */
export const R_GAS = 8.314462618;
/** Boltzmann constant, J/K, and Avogadro's number. */
export const K_BOLTZMANN = 1.380649e-23;
export const N_AVOGADRO = 6.02214076e23;
/** Hard-sphere molecular diameter for the mean free path, m (N₂/O₂ ≈ 3.7e-10). */
export const MOLECULE_DIAMETER = 3.7e-10;
/** Density where the drag/thermal table ends, kg/m³ (atm.tableTop). */
export const TABLE_TOP_RHO = 1e-15;
/** Entries per body table. */
export const TABLE_N = 512;
/** Atomic-oxygen limit of the upper-atmosphere molar mass, kg/mol. */
export const M_ATOMIC_O = 0.016;
/** Default solar activity (0 quiet … 1 active); T_exo = 1000 K at 0.35. */
export const DEFAULT_ACTIVITY = 0.35;

/** io slots of atmoAt: AT_ALT is the input (m above the surface), the rest are outputs. */
export const AT_ALT = 0, AT_RHO = 1, AT_T = 2, AT_P = 3, AT_A = 4, AT_M = 5, AT_MFP = 6, AT_GAMMA = 7, AT_LEN = 8;

export interface AtmoProfileInput {
  /** kg/m³ at the surface (AtmosphereDef.surfaceDensity). */
  surfaceDensity: number;
  /** Surface scale height R·T_s/(M·g₀), m (AtmosphereDef.scaleHeight). */
  scaleHeight: number;
  /** Body G·M (m³/s²) and radius (m). */
  mu: number;
  radius: number;
  /** Surface temperature, K (the temperature the scale height was made from). */
  surfaceTemp: number;
  /** kg/mol; derived from the scale height when absent (M = R·T_s/(g₀·H₀)). */
  molarMass?: number;
  /** Surface ratio of specific heats; default from M (CO₂-like 1.29, H₂-like 1.41, else 1.4). */
  gamma?: number;
  /** Solar activity 0..1 (default 0.35). */
  activity?: number;
  /** Table entries (default 512). */
  n?: number;
}

export interface AtmoProfile {
  n: number;
  /** Altitude of the last table entry, m: where ρ falls below 1e-15 kg/m³. §1.4 atm.tableTop. */
  tableTop: number;
  dz: number;
  invDz: number;
  /** ln ρ (kg/m³), T (K), M (kg/mol), γ per entry, entry k at altitude k·dz. */
  lnRho: Float64Array;
  T: Float64Array;
  M: Float64Array;
  gamma: Float64Array;
  /** ρ at tableTop (subtracted so drag ends with no step). */
  rhoTop: number;
  /** Surface values and the derived constants. */
  rho0: number;
  p0: number;
  T0: number;
  M0: number;
  gamma0: number;
  H0: number;
  g0: number;
  Texo: number;
  /** Altitude where the layered ρ falls to 1e-7 kg/m³ (information only: atm.top stays the old one). */
  z1e7: number;
}

// ---------------------------------------------------------------------------------------------- the model

interface Model {
  Ts: number; Ms: number; Mtop: number; gs: number; gtop: number; H0: number; Texo: number;
  T15: number; T6: number; T11: number; T14: number;
}

function defaultGamma(M: number): number {
  return M >= 0.035 ? 1.29 : M < 0.005 ? 1.41 : 1.4;
}

/** T(z) of the layered model. */
function modelT(m: Model, z: number): number {
  const x = z / m.H0;
  if (x <= 1.5) return m.Ts + (m.T15 - m.Ts) * (x / 1.5);
  if (x <= 6) return m.T15 + (m.T6 - m.T15) * ((x - 1.5) / 4.5);
  if (x <= 11) return m.T6 + (m.T11 - m.T6) * ((x - 6) / 5);
  if (x <= 12) return m.T11;
  if (x <= 14) return m.T11 + (m.T14 - m.T11) * ((x - 12) / 2);
  return m.Texo - (m.Texo - m.T14) * Math.exp(-0.153 * (x - 14));
}

/** Mean molar mass at z. */
function modelM(m: Model, z: number): number {
  const x = z / m.H0;
  if (x <= 12) return m.Ms;
  return m.Mtop + (m.Ms - m.Mtop) * Math.exp(-(x - 12) / 12);
}

/** γ at z: follows M from the surface gas toward monatomic. */
function modelGamma(m: Model, M: number): number {
  if (m.Ms === m.Mtop) return m.gs;
  const f = (m.Ms - M) / (m.Ms - m.Mtop);
  return m.gs + (m.gtop - m.gs) * f;
}

/**
 * Build a body's profile (load time; allocates). The integration is RK4 in ln p at H₀/64 up to ρ < 1e-15 kg/m³ (or
 * 400·H₀ / 3 body radii as a backstop), then resampled.
 */
export function buildAtmoProfile(inp: AtmoProfileInput): AtmoProfile {
  const n = inp.n ?? TABLE_N;
  const R = inp.radius, mu = inp.mu;
  const g0 = mu / (R * R);
  const H0 = inp.scaleHeight;
  const Ts = inp.surfaceTemp;
  const Ms = inp.molarMass ?? (R_GAS * Ts) / (g0 * H0);
  const gs = inp.gamma ?? defaultGamma(Ms);
  const act = inp.activity ?? DEFAULT_ACTIVITY;
  const Texo = 1000 * (1 + 0.5 * (act - 0.35));
  const Mtop = Ms < 0.01 ? Ms / 2 : Math.min(Ms, M_ATOMIC_O);
  const cp = (gs / (gs - 1)) * (R_GAS / Ms);
  const T15 = Ts - 0.67 * (g0 / cp) * 1.5 * H0;
  const T11 = 0.65 * Ts;
  const m: Model = {
    Ts, Ms, Mtop, gs, gtop: 5 / 3, H0, Texo,
    T15, T6: 0.94 * Ts, T11, T14: T11 + 0.22 * (Texo - T11),
  };
  const rho0 = inp.surfaceDensity;
  const p0 = (rho0 * R_GAS * Ts) / Ms;

  // Fine integration of ln p(z).
  const hz = H0 / 64;
  const zMax = Math.min(400 * H0, 3 * R);
  const cap = Math.ceil(zMax / hz) + 2;
  const fineLnP = new Float64Array(cap);
  const dlnp = (z: number): number => {
    const r = R + z;
    return -(modelM(m, z) * (mu / (r * r))) / (R_GAS * modelT(m, z));
  };
  const rhoAt = (z: number, lnp: number): number => (Math.exp(lnp) * modelM(m, z)) / (R_GAS * modelT(m, z));
  let lnp = Math.log(p0);
  fineLnP[0] = lnp;
  let k = 0;
  let z1e7 = -1;
  for (; k + 1 < cap; k++) {
    const z = k * hz;
    const k1 = dlnp(z), k2 = dlnp(z + hz / 2), k4 = dlnp(z + hz);
    lnp += (hz / 6) * (k1 + 4 * k2 + k4); // k2 = k3: the derivative does not depend on ln p
    fineLnP[k + 1] = lnp;
    const rho = rhoAt(z + hz, lnp);
    if (z1e7 < 0 && rho < 1e-7) z1e7 = z + hz;
    if (rho < TABLE_TOP_RHO) { k++; break; }
  }
  const tableTop = k * hz;
  // Resample to n uniform entries (linear in ln p on the fine grid: hz ≪ dz).
  const lnRho = new Float64Array(n), T = new Float64Array(n), M = new Float64Array(n), G = new Float64Array(n);
  const dz = tableTop / (n - 1);
  for (let i = 0; i < n; i++) {
    const z = i === n - 1 ? tableTop : i * dz;
    const f = z / hz;
    let j = Math.floor(f);
    if (j >= k) j = k - 1;
    const w = f - j;
    const lp = fineLnP[j] * (1 - w) + fineLnP[j + 1] * w;
    const Tz = modelT(m, z), Mz = modelM(m, z);
    T[i] = Tz; M[i] = Mz; G[i] = modelGamma(m, Mz);
    lnRho[i] = lp + Math.log(Mz / (R_GAS * Tz));
  }
  return {
    n, tableTop, dz, invDz: 1 / dz, lnRho, T, M, gamma: G, rhoTop: Math.exp(lnRho[n - 1]),
    rho0, p0, T0: Ts, M0: Ms, gamma0: gs, H0, g0, Texo, z1e7,
  };
}

const MFP_K = 1 / (Math.SQRT2 * Math.PI * MOLECULE_DIAMETER * MOLECULE_DIAMETER * N_AVOGADRO);

/**
 * Atmosphere at io[AT_ALT] (m): ρ (kg/m³, 0 at and above tableTop), T (K), p (Pa), speed of sound a (m/s), M
 * (kg/mol), mean free path (m; 1e30 in vacuum) and γ, into io. Below the surface the surface values. ~25 ns.
 */
export function atmoAt(P: AtmoProfile, io: Float64Array): void {
  const z = io[AT_ALT];
  const n = P.n;
  let f = z * P.invDz;
  if (!(f > 0)) f = 0; // also NaN
  let i = Math.floor(f);
  let rho: number, T: number, M: number, g: number;
  if (i >= n - 1) {
    T = P.T[n - 1]; M = P.M[n - 1]; g = P.gamma[n - 1];
    io[AT_RHO] = 0; io[AT_P] = 0; io[AT_MFP] = 1e30;
    io[AT_T] = T; io[AT_M] = M; io[AT_GAMMA] = g;
    io[AT_A] = Math.sqrt((g * R_GAS * T) / M);
    return;
  }
  const w = f - i, u = 1 - w;
  const lr = P.lnRho, Ta = P.T, Ma = P.M, Ga = P.gamma;
  rho = Math.exp(lr[i] * u + lr[i + 1] * w) - P.rhoTop;
  if (rho < 0) rho = 0;
  T = Ta[i] * u + Ta[i + 1] * w;
  M = Ma[i] * u + Ma[i + 1] * w;
  g = Ga[i] * u + Ga[i + 1] * w;
  const RT = R_GAS * T;
  io[AT_RHO] = rho;
  io[AT_T] = T;
  io[AT_M] = M;
  io[AT_GAMMA] = g;
  io[AT_P] = (rho * RT) / M;
  io[AT_A] = Math.sqrt((g * RT) / M);
  io[AT_MFP] = rho > 0 ? (M * MFP_K) / rho : 1e30;
}

/** A fresh io array for atmoAt. */
export const makeAtmoIO = (): Float64Array => new Float64Array(AT_LEN);
