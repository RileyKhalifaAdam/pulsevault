// The ship's thermal network (docs/SIMULATION.md W2-D item 1): lumped nodes with heat capacity C_i, linear
// conductive / convective / pumped links G_ij, exterior surfaces that absorb sunlight, planet albedo and planet IR
// and radiate εσA(T⁴ − T_bg⁴) to space, windows that pass sunlight into the rooms, and the heat that every other
// subsystem deposits (aero heatIn, electrical loads, reactor and drive waste, crew).
//
//   C_i·dT_i/dt = Q_i − ε_iσA_i(T_i⁴ − T_bg⁴) − Σ_j G_ij(T_i − T_j)
//
// Integration: backward Euler with the radiation term linearised about the step's start temperature,
// R(T') ≈ R(T) + 4εσA·T³·(T' − T), so each step is ONE linear solve of an SPD (diagonally dominant M-) matrix:
//   (C/h + 4εσAT³ + ΣG)·T' − ΣG·T'_j = C/h·T + Q + 4εσAT³·T − R(T)
// Unconditionally stable at any h (T' > 0 always); the step's energy is booked with the same linearised flux, so
// heat in − heat out = Σ C·ΔT holds to round-off (tests: 1e-9 of the step energy, h = 30 s, stiff links).
// The solve is an exact sparse LDLᵀ (no sqrt): a minimum-degree ordering and the fill pattern are found once at
// load (compileThermal), and the numeric factorisation is a precomputed flat "program" of multiply-adds over the
// CSR entries of L. No iteration, so no convergence question (the review's Gauss–Seidel objection does not apply).
//
// WIRING (wave 2; nothing here is called yet):
//   * setup.ts / load (derived, never saved): c.thermalNet = compileThermal(WREN_THERMAL) (src/data/thermalNet.ts)
//     once per hull type with a network; c.thermal = loadThermal(saved?.thermal, WREN_THERMAL) (§1.4 thermal.T).
//   * The per-step call is systemsStep (src/world/shipSystems.ts), which calls thermalSources + thermalStep. It
//     runs every 12 ticks (10 Hz, h = 0.1 s) on the grid at 1×, and under warp every systemsSpanTicks(...) ticks
//     (≈ 120 s of sim time, a whole number of quanta) with thermalSubsteps(h) implicit steps of ≤ 30 s
//     (MAX_THERMAL_STEP). No limitedBy: the step is stable at any h.
//   * Environment (env Float64Array, ENV_* slots): the wiring fills it once per systems step from the ephemeris:
//     sun direction and planet nadir in CRAFT axes (q⁻¹·(r_star − r), q⁻¹·(r_planet − r), normalised), S = L/(4πd²)
//     (luminosity from the star's T_eff and radius: σT⁴·R²/d²), ν = shadowFactor(...) (analytic disc overlap),
//     VF = (R_p/r)², albedo exitance = albedoExitance(a, S, cos ζ), planet IR temperature = planetIrTemp(...).
//   * Replaces: the scalar `heat` / heatCapacity / heatDissipation integration in dynamics.ts force() (the heat
//     ODE term) and atmosphere.ts radiativeLoss; `heat` stays a derived value (storedHeat) until W2-F moves the render.
//   * §1.4 fields: reads heatIn[] (J per hull zone since the last step; zeroed here), shutters[], radiatorHealth[];
//     writes thermal.T[] and driveInhibit (via shipSystems.ts). Pure, deterministic, allocation-free per step.
//
// Measured (node 22, esbuild bundle, this container): 38-node Wren network (119 L entries, 175 program ops):
// thermalStep 2.3 µs + thermalSources 0.6 µs; the whole systemsStep 4.2 µs (≈ 8 µs on the A16 est.).

/** Stefan–Boltzmann constant, W/(m²·K⁴). */
export const SIGMA = 5.670374419e-8;
/** Cosmic background, K. */
export const T_BG = 2.725;
/** Longest single implicit step under warp, s (§1.3 table). */
export const MAX_THERMAL_STEP = 30;
/** Systems step on the 1× grid: every 12 ticks of 1/120 s. */
export const THERMAL_TICKS = 12;

/** Environment slots (craft axes for the directions). */
export const ENV_S = 0; // solar irradiance at the ship, W/m² (unshadowed)
export const ENV_NU = 1; // visible fraction of the star's disc, 0..1
export const ENV_SX = 2, ENV_SY = 3, ENV_SZ = 4; // unit vector toward the star, craft axes
export const ENV_NX = 5, ENV_NY = 6, ENV_NZ = 7; // unit vector toward the planet's centre (nadir), craft axes
export const ENV_VF = 8; // (R_p / r)²: sphere-to-plate view factor for a nadir-facing plate
export const ENV_ALB = 9; // planet albedo exitance at the sub-ship point, W/m² (a·S·max(0, cos ζ))
export const ENV_TPL = 10; // planet IR (brightness) temperature at the sub-ship point, K
export const ENV_TBG = 11; // background temperature, K
export const ENV_LEN = 12;

export const makeThermalEnv = (): Float64Array => {
  const e = new Float64Array(ENV_LEN);
  e[ENV_SX] = 1; e[ENV_NX] = -1; e[ENV_TBG] = T_BG;
  return e;
};

// ------------------------------------------------------------------------------------------------ definitions

export interface ThermalNodeDef {
  id: string;
  /** Heat capacity, J/K. */
  C: number;
  /** Initial temperature (loader default), K. */
  T0: number;
  /** Failure / interlock temperature, K (Infinity: none). */
  limit: number;
  /** Master-caution temperature, K (Infinity: none). */
  caution: number;
}

export interface ThermalLinkDef {
  a: number;
  b: number;
  /** Conductance, W/K (the default value; variable links are rewritten per step through net.G). */
  G: number;
}

/** An exterior surface: absorbs sun / albedo (α) and planet IR (ε), radiates ε·A to space. */
export interface ThermalSurfaceDef {
  node: number;
  alpha: number;
  eps: number;
  /** Emitting area, m². */
  area: number;
  /** Facets for the projected area toward a direction d: Σ a_f·max(0, n_f·d); flat [nx, ny, nz, a, …]. */
  facets: readonly number[];
  /** Radiator index (radiatorHealth scales area and absorption), or −1. */
  radiator: number;
}

/** A window pane: sun and albedo pass τ into the room, α into the pane; the shutter takes them on the skin. */
export interface ThermalWindowDef {
  id: string;
  pane: number;
  room: number;
  /** Skin node the closed shutter sits on. */
  skin: number;
  /** Shutter group index (§1.4 shutters[]). */
  group: number;
  /** Outward normal, craft axes. */
  n: readonly [number, number, number];
  area: number;
  /** Solar transmittance, solar absorptance of the pane, IR emissivity of the pane, solar absorptance of the shutter. */
  tau: number;
  alphaGlass: number;
  epsGlass: number;
  alphaShutter: number;
}

export interface ThermalNetDef {
  nodes: readonly ThermalNodeDef[];
  links: readonly ThermalLinkDef[];
  surfaces: readonly ThermalSurfaceDef[];
  windows: readonly ThermalWindowDef[];
  /** Hull zone (HULL_ZONES order) → node that takes its aerodynamic heatIn, or −1. */
  zoneNode: readonly number[];
}

// ------------------------------------------------------------------------------------------------ compiled form

export interface ThermalNet {
  def: ThermalNetDef;
  n: number;
  C: Float64Array;
  limit: Float64Array;
  caution: Float64Array;
  /** Links: endpoints and the CURRENT conductance (the caller may rewrite G[k] before a step). */
  nLinks: number;
  la: Int32Array;
  lb: Int32Array;
  G: Float64Array;
  G0: Float64Array;
  /** Ordering: perm[p] = node at elimination position p; iperm[node] = p. */
  perm: Int32Array;
  iperm: Int32Array;
  /** L (strictly lower, permuted) in CSR: entries of row p are rowStart[p] .. rowStart[p+1]−1, columns lcol[]. */
  rowStart: Int32Array;
  lcol: Int32Array;
  nnz: number;
  /** Link k adds −G_k into L-entry slot[k]. */
  slot: Int32Array;
  /** Factorisation program: entry e subtracts W[pa[m]]·L[pb[m]] for m in progStart[e] .. progStart[e+1]−1. */
  progStart: Int32Array;
  progA: Int32Array;
  progB: Int32Array;
  // surfaces
  nSurf: number;
  sNode: Int32Array;
  sAlpha: Float64Array;
  sEps: Float64Array;
  sArea: Float64Array;
  sRad: Int32Array;
  fStart: Int32Array;
  fN: Float64Array; // nx, ny, nz, a per facet
  // windows
  nWin: number;
  wPane: Int32Array;
  wRoom: Int32Array;
  wSkin: Int32Array;
  wGroup: Int32Array;
  wN: Float64Array;
  wArea: Float64Array;
  wTau: Float64Array;
  wAlphaG: Float64Array;
  wEpsG: Float64Array;
  wAlphaS: Float64Array;
  zoneNode: Int32Array;
  // per-step coefficients and scratch (no allocation per step)
  /** ε·A per node for this step (written by thermalSources; a caller without surfaces may write it). */
  eA: Float64Array;
  diag: Float64Array;
  rhs: Float64Array;
  kRad: Float64Array;
  rRad: Float64Array;
  Aoff: Float64Array;
  Lv: Float64Array;
  Wv: Float64Array;
  D: Float64Array;
  y: Float64Array;
  /** Window outputs of the last thermalSources: W of sunlight + albedo light transmitted into the room. */
  winLight: Float64Array;
  /** Bookkeeping of the last step: [heat in J, radiated J (linearised), Σ C·ΔT J, |residual| J]. */
  book: Float64Array;
}

export const BOOK_IN = 0, BOOK_RAD = 1, BOOK_DU = 2, BOOK_RES = 3;

/** Minimum-degree elimination order of the link graph (ties: lowest node index). Load time. */
function minDegreeOrder(n: number, la: Int32Array, lb: Int32Array): Int32Array {
  const adj = new Uint8Array(n * n);
  for (let k = 0; k < la.length; k++) {
    const a = la[k], b = lb[k];
    if (a !== b) { adj[a * n + b] = 1; adj[b * n + a] = 1; }
  }
  const done = new Uint8Array(n);
  const order = new Int32Array(n);
  for (let p = 0; p < n; p++) {
    let best = -1, bestDeg = 1 << 30;
    for (let i = 0; i < n; i++) {
      if (done[i]) continue;
      let d = 0;
      for (let j = 0; j < n; j++) if (!done[j] && adj[i * n + j]) d++;
      if (d < bestDeg) { bestDeg = d; best = i; }
    }
    order[p] = best;
    done[best] = 1;
    // its remaining neighbours become a clique
    for (let a = 0; a < n; a++) {
      if (done[a] || !adj[best * n + a]) continue;
      for (let b = 0; b < n; b++) if (b !== a && !done[b] && adj[best * n + b]) adj[a * n + b] = 1;
    }
  }
  return order;
}

/** Build the solver for a network: ordering, fill pattern, factorisation program, typed arrays. Load time. */
export function compileThermal(def: ThermalNetDef): ThermalNet {
  const n = def.nodes.length;
  const nL = def.links.length;
  const la = new Int32Array(nL), lb = new Int32Array(nL), G = new Float64Array(nL), G0 = new Float64Array(nL);
  def.links.forEach((l, k) => {
    if (l.a === l.b || l.a < 0 || l.b < 0 || l.a >= n || l.b >= n) throw new Error(`thermal link ${k}: bad endpoints ${l.a}-${l.b}`);
    la[k] = l.a; lb[k] = l.b; G[k] = l.G; G0[k] = l.G;
  });
  const perm = minDegreeOrder(n, la, lb);
  const iperm = new Int32Array(n);
  for (let p = 0; p < n; p++) iperm[perm[p]] = p;
  // symbolic elimination in permuted order: M[q*n+p] (q > p) = entry exists
  const M = new Uint8Array(n * n);
  for (let k = 0; k < nL; k++) {
    const p = iperm[la[k]], q = iperm[lb[k]];
    if (p > q) M[p * n + q] = 1; else M[q * n + p] = 1;
  }
  for (let p = 0; p < n; p++) {
    for (let q1 = p + 1; q1 < n; q1++) {
      if (!M[q1 * n + p]) continue;
      for (let q2 = q1 + 1; q2 < n; q2++) if (M[q2 * n + p]) M[q2 * n + q1] = 1;
    }
  }
  const rowStart = new Int32Array(n + 1);
  const slotOf = new Int32Array(n * n).fill(-1);
  const cols: number[] = [];
  for (let q = 0; q < n; q++) {
    rowStart[q] = cols.length;
    for (let p = 0; p < q; p++) if (M[q * n + p]) { slotOf[q * n + p] = cols.length; cols.push(p); }
  }
  rowStart[n] = cols.length;
  const nnz = cols.length;
  const lcol = Int32Array.from(cols);
  const slot = new Int32Array(nL);
  for (let k = 0; k < nL; k++) {
    const p = iperm[la[k]], q = iperm[lb[k]];
    slot[k] = p > q ? slotOf[p * n + q] : slotOf[q * n + p];
  }
  const progStart = new Int32Array(nnz + 1);
  const pa: number[] = [], pb: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let e = rowStart[i]; e < rowStart[i + 1]; e++) {
      progStart[e] = pa.length;
      const j = lcol[e];
      for (let e2 = rowStart[i]; e2 < e; e2++) {
        const k = lcol[e2];
        const ejk = slotOf[j * n + k];
        if (ejk >= 0) { pa.push(e2); pb.push(ejk); }
      }
    }
  }
  progStart[nnz] = pa.length;
  // surfaces
  const nS = def.surfaces.length;
  const sNode = new Int32Array(nS), sAlpha = new Float64Array(nS), sEps = new Float64Array(nS), sArea = new Float64Array(nS), sRad = new Int32Array(nS);
  const fStart = new Int32Array(nS + 1);
  const fl: number[] = [];
  def.surfaces.forEach((s, i) => {
    sNode[i] = s.node; sAlpha[i] = s.alpha; sEps[i] = s.eps; sArea[i] = s.area; sRad[i] = s.radiator;
    fStart[i] = fl.length / 4;
    for (let f = 0; f + 3 < s.facets.length; f += 4) {
      const nx = s.facets[f], ny = s.facets[f + 1], nz = s.facets[f + 2];
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      fl.push(nx / l, ny / l, nz / l, s.facets[f + 3]);
    }
  });
  fStart[nS] = fl.length / 4;
  const nW = def.windows.length;
  const wPane = new Int32Array(nW), wRoom = new Int32Array(nW), wSkin = new Int32Array(nW), wGroup = new Int32Array(nW);
  const wN = new Float64Array(3 * nW), wArea = new Float64Array(nW), wTau = new Float64Array(nW), wAlphaG = new Float64Array(nW), wEpsG = new Float64Array(nW), wAlphaS = new Float64Array(nW);
  def.windows.forEach((w, i) => {
    wPane[i] = w.pane; wRoom[i] = w.room; wSkin[i] = w.skin; wGroup[i] = w.group;
    const l = Math.sqrt(w.n[0] * w.n[0] + w.n[1] * w.n[1] + w.n[2] * w.n[2]);
    wN[3 * i] = w.n[0] / l; wN[3 * i + 1] = w.n[1] / l; wN[3 * i + 2] = w.n[2] / l;
    wArea[i] = w.area; wTau[i] = w.tau; wAlphaG[i] = w.alphaGlass; wEpsG[i] = w.epsGlass; wAlphaS[i] = w.alphaShutter;
  });
  return {
    def, n,
    C: Float64Array.from(def.nodes.map((d) => d.C)),
    limit: Float64Array.from(def.nodes.map((d) => d.limit)),
    caution: Float64Array.from(def.nodes.map((d) => d.caution)),
    nLinks: nL, la, lb, G, G0, perm, iperm, rowStart, lcol, nnz, slot,
    progStart, progA: Int32Array.from(pa), progB: Int32Array.from(pb),
    nSurf: nS, sNode, sAlpha, sEps, sArea, sRad, fStart, fN: Float64Array.from(fl),
    nWin: nW, wPane, wRoom, wSkin, wGroup, wN, wArea, wTau, wAlphaG, wEpsG, wAlphaS,
    zoneNode: Int32Array.from(def.zoneNode),
    eA: new Float64Array(n), diag: new Float64Array(n), rhs: new Float64Array(n), kRad: new Float64Array(n), rRad: new Float64Array(n),
    Aoff: new Float64Array(nnz), Lv: new Float64Array(nnz), Wv: new Float64Array(nnz), D: new Float64Array(n), y: new Float64Array(n),
    winLight: new Float64Array(nW),
    book: new Float64Array(4),
  };
}

// ------------------------------------------------------------------------------------------------ sources

/** Projected area of surface s toward the unit direction (dx, dy, dz): Σ a_f·max(0, n_f·d). */
function projArea(net: ThermalNet, s: number, dx: number, dy: number, dz: number): number {
  const F = net.fN;
  let a = 0;
  for (let f = net.fStart[s]; f < net.fStart[s + 1]; f++) {
    const c = F[4 * f] * dx + F[4 * f + 1] * dy + F[4 * f + 2] * dz;
    if (c > 0) a += c * F[4 * f + 3];
  }
  return a;
}

/**
 * Environmental heat (W) ADDED into Q[node], and this step's emission coefficients net.eA (ε·A per node), from the
 * environment (ENV_* slots), the shutters (0 open … 1 closed, per window group) and radiatorHealth (0..1). Also the
 * light each window passes into its room (net.winLight, W). Sun: α·S·ν·A⊥; albedo: α·ALB·VF·A⊥(nadir); planet IR:
 * ε·σT_p⁴·VF·A⊥(nadir) (sphere–plate view factor = (R/r)² for a nadir-facing plate; side-facing facets use their
 * nadir projection, which slightly under-counts the limb at low altitude). Self-shadowing of the hull is not modelled
 * (W2-B's baked zone-area table can replace the facets). Allocation-free.
 */
export function thermalSources(net: ThermalNet, env: Float64Array, shutters: ArrayLike<number>, radHealth: ArrayLike<number>, Q: Float64Array): void {
  const eA = net.eA;
  for (let i = 0; i < net.n; i++) eA[i] = 0;
  const Sun = env[ENV_S] * env[ENV_NU];
  const sx = env[ENV_SX], sy = env[ENV_SY], sz = env[ENV_SZ];
  const nx = env[ENV_NX], ny = env[ENV_NY], nz = env[ENV_NZ];
  const vf = env[ENV_VF], tp = env[ENV_TPL];
  const alb = env[ENV_ALB] * vf;
  const ir = SIGMA * tp * tp * tp * tp * vf;
  for (let s = 0; s < net.nSurf; s++) {
    let scale = 1;
    const r = net.sRad[s];
    if (r >= 0) { const hv = r < radHealth.length ? radHealth[r] : 1; scale = hv > 0 ? (hv < 1 ? hv : 1) : 0; }
    const node = net.sNode[s];
    eA[node] += net.sEps[s] * net.sArea[s] * scale;
    let q = 0;
    if (Sun > 0) q += net.sAlpha[s] * Sun * projArea(net, s, sx, sy, sz);
    if (vf > 0) {
      const an = projArea(net, s, nx, ny, nz);
      q += (net.sAlpha[s] * alb + net.sEps[s] * ir) * an;
    }
    Q[node] += q * scale;
  }
  const W = net.wN;
  for (let w = 0; w < net.nWin; w++) {
    const g = net.wGroup[w];
    let sh = g < shutters.length ? shutters[g] : 0;
    sh = sh > 0 ? (sh < 1 ? sh : 1) : 0;
    const open = 1 - sh;
    const A = net.wArea[w];
    const cs = W[3 * w] * sx + W[3 * w + 1] * sy + W[3 * w + 2] * sz;
    const cn = W[3 * w] * nx + W[3 * w + 1] * ny + W[3 * w + 2] * nz;
    const solar = (cs > 0 ? Sun * cs : 0) + (cn > 0 ? alb * cn : 0); // W/m² of sun + albedo light on the pane
    const irIn = cn > 0 ? ir * cn : 0;
    const light = net.wTau[w] * solar * A * open;
    net.winLight[w] = light;
    Q[net.wRoom[w]] += light;
    Q[net.wPane[w]] += (net.wAlphaG[w] * solar + net.wEpsG[w] * irIn) * A * open;
    Q[net.wSkin[w]] += (net.wAlphaS[w] * solar + 0.9 * irIn) * A * sh;
    // the closed cover shields the pane from space (cover emissivity seen through ≈ 0.1 of open)
    eA[net.wPane[w]] += net.wEpsG[w] * A * (1 - 0.9 * sh);
  }
}

// ------------------------------------------------------------------------------------------------ the step

/**
 * One backward-Euler step of h seconds with constant sources Q (W per node) and the conductances in net.G, the
 * emission coefficients in net.eA. T is updated in place (any indexable array of doubles: the state's number[]).
 * Book: net.book (heat in, radiated, Σ C·ΔT, |in − out − ΔU|), all in J. Allocation-free; ≈ 1 µs for 38 nodes.
 */
export function thermalStep(net: ThermalNet, T: { [i: number]: number }, Q: Float64Array, h: number, Tbg = T_BG): void {
  const n = net.n, perm = net.perm, C = net.C, eA = net.eA;
  const diag = net.diag, rhs = net.rhs, kR = net.kRad, rR = net.rRad;
  const tb4 = Tbg * Tbg * Tbg * Tbg;
  const ih = 1 / h;
  for (let p = 0; p < n; p++) {
    const i = perm[p];
    const t = T[i];
    const e = eA[i] * SIGMA;
    const t3 = t * t * t;
    const k = 4 * e * t3;
    const R = e * (t3 * t - tb4);
    kR[i] = k; rR[i] = R;
    const Ch = C[i] * ih;
    diag[p] = Ch + k;
    rhs[p] = Ch * t + Q[i] + k * t - R;
  }
  const Aoff = net.Aoff, nnz = net.nnz;
  for (let e = 0; e < nnz; e++) Aoff[e] = 0;
  const la = net.la, lb = net.lb, G = net.G, slot = net.slot, ip = net.iperm;
  for (let k = 0; k < net.nLinks; k++) {
    const g = G[k];
    diag[ip[la[k]]] += g;
    diag[ip[lb[k]]] += g;
    Aoff[slot[k]] -= g;
  }
  // numeric LDLᵀ (up-looking, precomputed program)
  const rs = net.rowStart, lc = net.lcol, ps = net.progStart, pa = net.progA, pb = net.progB;
  const Lv = net.Lv, Wv = net.Wv, D = net.D;
  for (let i = 0; i < n; i++) {
    let d = diag[i];
    for (let e = rs[i]; e < rs[i + 1]; e++) {
      let s = Aoff[e];
      for (let m = ps[e]; m < ps[e + 1]; m++) s -= Wv[pa[m]] * Lv[pb[m]];
      Wv[e] = s;
      const l = s / D[lc[e]];
      Lv[e] = l;
      d -= s * l;
    }
    D[i] = d;
  }
  // solve L·y = b, then Lᵀ·x = y/D
  const y = net.y;
  for (let i = 0; i < n; i++) {
    let s = rhs[i];
    for (let e = rs[i]; e < rs[i + 1]; e++) s -= Lv[e] * y[lc[e]];
    y[i] = s;
  }
  for (let i = 0; i < n; i++) y[i] /= D[i];
  for (let i = n - 1; i >= 0; i--) {
    const xi = y[i];
    for (let e = rs[i]; e < rs[i + 1]; e++) y[lc[e]] -= Lv[e] * xi;
  }
  // write back and book with the same linearised radiation
  let ein = 0, erad = 0, du = 0;
  for (let p = 0; p < n; p++) {
    const i = perm[p];
    const t0 = T[i], t1 = y[p];
    const dT = t1 - t0;
    du += C[i] * dT;
    erad += h * (rR[i] + kR[i] * dT);
    ein += h * Q[i];
    T[i] = t1;
  }
  const b = net.book;
  b[BOOK_IN] = ein; b[BOOK_RAD] = erad; b[BOOK_DU] = du;
  const res = ein - erad - du;
  b[BOOK_RES] = res < 0 ? -res : res;
}

/** Number of implicit steps for an interval h (≤ MAX_THERMAL_STEP each). */
export const thermalSubsteps = (h: number): number => (h <= MAX_THERMAL_STEP ? 1 : Math.ceil(h / MAX_THERMAL_STEP));

/** Restore the default conductances (call before rewriting the variable links of a step). */
export function resetLinks(net: ThermalNet): void {
  net.G.set(net.G0);
}

// ------------------------------------------------------------------------------------------------ environment helpers

/** Wrappers for transcendental calls (§1.1 rule 6; move into world/math.ts when wave 2 wires this file). */
const acos_ = (x: number): number => Math.acos(x < -1 ? -1 : x > 1 ? 1 : x);
const asin_ = (x: number): number => Math.asin(x < -1 ? -1 : x > 1 ? 1 : x);

/**
 * Visible fraction ν of the star's disc from the ship: the analytic overlap of two discs of angular radii
 * a_s = asin(R_s/d_s) (star) and a_p = asin(R_p/d_p) (planet) at angular separation θ (tangent-plane overlap of
 * circles; the planet's limb is straight at the star's 0.3° scale, so the curvature error is negligible).
 * (sx, sy, sz): ship → star centre; (px, py, pz): ship → planet centre (any common axes, m).
 */
export function shadowFactor(sx: number, sy: number, sz: number, Rs: number, px: number, py: number, pz: number, Rp: number): number {
  const ds = Math.sqrt(sx * sx + sy * sy + sz * sz), dp = Math.sqrt(px * px + py * py + pz * pz);
  if (!(dp > Rp)) return 0;
  if (!(ds > Rs)) return 1;
  if (dp > ds) return 1; // planet behind the star
  const r1 = asin_(Rs / ds), r2 = asin_(Rp / dp);
  const d = acos_((sx * px + sy * py + sz * pz) / (ds * dp));
  if (d >= r1 + r2) return 1;
  if (d <= r2 - r1) return 0;
  if (d <= r1 - r2) return 1 - (r2 * r2) / (r1 * r1);
  const c1 = (d * d + r1 * r1 - r2 * r2) / (2 * d * r1);
  const c2 = (d * d + r2 * r2 - r1 * r1) / (2 * d * r2);
  const k = (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2);
  const A = r1 * r1 * acos_(c1) + r2 * r2 * acos_(c2) - 0.5 * Math.sqrt(k > 0 ? k : 0);
  const nu = 1 - A / (Math.PI * r1 * r1);
  return nu < 0 ? 0 : nu > 1 ? 1 : nu;
}

/** Planet albedo exitance at the sub-ship point, W/m²: a·S·max(0, cos ζ) (ζ = solar zenith angle there). */
export const albedoExitance = (albedo: number, S: number, cosZeta: number): number => (cosZeta > 0 ? albedo * S * cosZeta : 0);

/**
 * Planet IR temperature at the sub-ship point, K. A tidally locked world with little heat redistribution (Wick):
 * T = max(T_night, T_ss·cos^¼ ζ), T_ss = ((1 − a)·S_p/σ)^¼ the sub-stellar equilibrium. The night side ≈ 150 K.
 */
export function planetIrTemp(cosZeta: number, Tss: number, Tnight: number): number {
  if (!(cosZeta > 0)) return Tnight;
  const t = Tss * Math.sqrt(Math.sqrt(cosZeta));
  return t > Tnight ? t : Tnight;
}

/** Heat stored above T_ref, J (the derived `heat` the renderer reads until W2-F). */
export function storedHeat(net: ThermalNet, T: ArrayLike<number>, Tref = 293): number {
  let e = 0;
  for (let i = 0; i < net.n; i++) e += net.C[i] * (T[i] - Tref);
  return e;
}

// ------------------------------------------------------------------------------------------------ state

/** §1.4 `thermal: { T: number[] }` plus the interlock and caution latches (saved, so a load resumes the hysteresis). */
export interface ThermalState {
  T: number[];
  /** driveInhibit latch: set above the interlock limits, cleared below them minus the hysteresis band. */
  inhibit: boolean;
  /** Per node: 1 while above its caution temperature (cleared HOT_HYST below it); a new 1 is a caution pulse. */
  hot: number[];
}

export function makeThermalState(def: ThermalNetDef): ThermalState {
  return { T: def.nodes.map((d) => d.T0), inhibit: false, hot: def.nodes.map(() => 0) };
}

export function saveThermal(s: ThermalState): ThermalState {
  return { T: s.T.slice(), inhibit: s.inhibit, hot: s.hot.slice() };
}

/** Loader with defaults: a missing, wrong-length or non-finite save gives the network's initial temperatures. */
export function loadThermal(saved: unknown, def: ThermalNetDef): ThermalState {
  const s = makeThermalState(def);
  const o = saved as Partial<ThermalState> | null | undefined;
  if (o && Array.isArray(o.T) && o.T.length === def.nodes.length && o.T.every((t) => typeof t === 'number' && t > 0 && Number.isFinite(t))) {
    for (let i = 0; i < s.T.length; i++) s.T[i] = o.T[i];
  }
  if (o && typeof o.inhibit === 'boolean') s.inhibit = o.inhibit;
  if (o && Array.isArray(o.hot) && o.hot.length === def.nodes.length) for (let i = 0; i < s.hot.length; i++) s.hot[i] = o.hot[i] === 1 ? 1 : 0;
  return s;
}
