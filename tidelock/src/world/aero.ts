// Aerodynamics of a hull from its baked skin tables (SIMULATION.md W2-B items 4, 8, 9): force and moment from the
// flow direction and Mach number (modified Newtonian with skin friction in continuum flow, hyperthermal
// free-molecular flow above Kn = 10, Wilmoth's sin² bridge in log Kn between 1e-3 and 10), analytic damping
// derivatives, the centre of pressure, convective (Sutton–Graves, capped by the free-molecular energy flux) and
// radiative (Tauber–Sutton, above 9 km/s) heating per hull zone, and buoyancy.
//
// Tables (src/data/aero/<hull>.ts, written at BUILD time by tools/bake-aero.mjs): an octahedral vertex grid of flow
// directions, mirror-halved (ux ≥ 0) — 33×33 for the Newtonian F/q, M/q, 17×17 for free-molecular terms, damping
// and zone areas. Lookup is bilinear in the octahedral coordinates (continuous everywhere, folds included).
//
// WIRING (wave 2; nothing here is called yet):
//   * setup.ts (load time, derived, never saved): c.aero = decodeAero(AERO_WREN) for the Wren (hulls without a table
//     keep today's scalar dragArea path); c.aeroIn = makeAeroIn(), c.aeroOut = makeAeroOut().
//   * dynamics.ts force() — every force evaluation in air (4 per RK4 step), replacing `k = ½ρ|u|·cdA/m` drag:
//       ai[AI_UX..UZ] = q⁻¹·u (u = air-relative velocity v − ω_body × r, inertial → craft axes); ai[AI_WX..WZ] = c.w;
//       ai[AI_RHO], ai[AI_A], ai[AI_MFP], ai[AI_M] from atmoProfile.ts atmoAt; ai[AI_TW] = skin temperature (W2-D,
//       default 300 K); ai[AI_CX..CZ] = CoM (origin until W3-A); ai[AI_IX..IZ] = principal moments (body axes).
//       aeroForce(c.aero, ai, ao): ao[AO_FX..FZ] (N, craft axes: qRot to inertial, /m for the acceleration) and
//       ao[AO_MX..MZ] (N·m about the CoM) — translation AND rotation are then co-integrated by the in-air RK4 with
//       sub-steps ≤ min(Q, 0.1/ao[AO_WAIR]) (WHY_ATMOSPHERE; ω_air = max_k √(q·∂M_k/∂θ / I_k) with the LOCAL moment
//       slope of the table cell, per axis against its own inertia). The step-mean aero force goes into the ledger (a
//       proper force: the IMU and the crew feel it), the moment into the rotation torque.
//   * once per step in air: aeroHeat(c.aero, ai, ao, heat) → heat[z] W per zone, z in HULL_ZONES order (the table's
//     zones ARE HULL_ZONES: same ids, same index, same radii; tests/aero.test.ts checks it); c.heatIn[z] += heat[z]·dt
//     (§1.4, for W2-D's skin nodes); c.heatFlux = ao[AO_QSTAG] (§1.4 heatFlux = the stagnation flux at the nose
//     radius, which W1-E's sheath reads); ao[AO_QPEAK] (the hottest windward zone, e.g. a wing leading edge) is
//     exposed separately for cautions / W2-F, not written to heatFlux.
//   * buoyancy: F = ρ·V_hull·g upward, V_hull = c.aero.volume (906 m³: ≈ 1.06 t-force at Wick's surface, ρ 1.17).
//   * Hulls without a table: aeroForce is not called (no fake coefficients).
//   Contract fields: reads airVel (§1.4 wave 1, its source), writes heatIn[], heatFlux; nothing saved.
//
// Pure, deterministic, allocation-free on the per-call path (typed-array in/out; builder allocates once).

/** The generated module's shape (src/data/aero/<hull>.ts). */
export interface AeroGen {
  version: number;
  hull: string;
  nBig: number;
  nSmall: number;
  colsBig: number;
  colsSmall: number;
  samples: number;
  skinArea: number;
  volume: number;
  refLength: number;
  stiff: readonly number[];
  zones: readonly { name: string; area: number; radius: number; mirror: number }[];
  scaleBig: readonly number[];
  scaleSmall: readonly number[];
  dataBig: string;
  dataSmall: string;
}

export interface AeroTable {
  hull: string;
  nB: number; hB: number; cB: number;
  nS: number; hS: number; cS: number;
  /** Decoded columns, interleaved per grid vertex: big[(j·hB + i)·cB + c]. */
  big: Float64Array;
  small: Float64Array;
  nZones: number;
  zoneArea: Float64Array;
  /** 1/√R per zone (Sutton–Graves) and R. */
  zoneInvSqrtR: Float64Array;
  zoneR: Float64Array;
  zoneMirror: Int32Array;
  zoneNames: string[];
  volume: number;
  refLength: number;
  /** max over axes of |∂(M/q)/∂θ|, m³/rad (whole table; information). */
  stiffMax: number;
  /** Local moment slope per big-grid vertex and body axis, |∂(M_k/q)/∂θ| m³/rad: the max over the vertex's grid edges. */
  stiffV: Float64Array;
  /** Index of the 'nose' zone (stagnation heat flux, §1.4 heatFlux). */
  noseZone: number;
}

// ----------------------------------------------------------------------------------------- small-table columns
const S_AP = 0, S_S = 1, S_G = 4, S_MG = 7, S_DN = 10, S_DF = 16, S_Z = 25;

// ----------------------------------------------------------------------------------------- io slots
export const AI_UX = 0, AI_UY = 1, AI_UZ = 2, AI_WX = 3, AI_WY = 4, AI_WZ = 5, AI_RHO = 6, AI_A = 7, AI_MFP = 8;
export const AI_M = 9, AI_TW = 10, AI_CX = 11, AI_CY = 12, AI_CZ = 13, AI_IX = 14, AI_IY = 15, AI_IZ = 16, AI_LEN = 17;
export const AO_FX = 0, AO_FY = 1, AO_FZ = 2, AO_MX = 3, AO_MY = 4, AO_MZ = 5, AO_Q = 6, AO_V = 7, AO_MACH = 8;
export const AO_KN = 9, AO_WFM = 10, AO_WAIR = 11, AO_QPEAK = 12, AO_QSTAG = 13, AO_LEN = 14;

export const makeAeroIn = (): Float64Array => { const a = new Float64Array(AI_LEN); a[AI_TW] = 300; a[AI_M] = 0.02897; a[AI_IX] = a[AI_IY] = a[AI_IZ] = 1; a[AI_A] = 340; a[AI_MFP] = 1e30; return a; };
export const makeAeroOut = (): Float64Array => new Float64Array(AO_LEN);

/** Sutton–Graves convective coefficient (Earth air), SI: q = k·√(ρ/R)·V³. */
export const SG_K = 1.7415e-4;
/** Knudsen limits of the bridge. */
export const KN_CONT = 1e-3;
export const KN_FM = 10;
const R_GAS = 8.314462618;

/** Mach knots and the continuum regime factors on the Newtonian force (K_D) and moment (K_M): tuning values. */
export const MACH_KNOTS = new Float64Array([0, 0.4, 0.6, 0.8, 0.9, 1.0, 1.1, 1.2, 1.4, 1.7, 2.0, 2.5, 3.0, 4.0, 5.0, 10]);
export const K_DRAG = new Float64Array([0.62, 0.62, 0.64, 0.70, 0.80, 0.92, 1.00, 1.02, 1.02, 1.01, 1.00, 0.99, 0.99, 0.99, 1.0, 1.0]);
export const K_MOMENT = new Float64Array([0.80, 0.80, 0.80, 0.82, 0.86, 0.92, 0.97, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]);

/** Tauber–Sutton radiative heating, Earth air: f(V) at V = 9.0 … 16 km/s (W/cm² units of the correlation). */
const TS_V = new Float64Array([9.0, 9.25, 9.5, 9.75, 10, 10.25, 10.5, 10.75, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16]);
const TS_F = new Float64Array([1.5, 4.3, 9.7, 19.5, 35, 55, 81, 115, 151, 238, 359, 495, 660, 850, 1065, 1313, 1550, 1780, 2040]);

// ----------------------------------------------------------------------------------------- decode

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Deterministic base64 → bytes (no atob: world/ stays free of browser globals). */
export function b64decode(s: string): Uint8Array {
  const lut = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) lut[B64.charCodeAt(i)] = i;
  let n = s.length;
  while (n > 0 && s[n - 1] === '=') n--;
  const out = new Uint8Array(Math.floor((n * 3) / 4));
  let o = 0, acc = 0, bits = 0;
  for (let i = 0; i < n; i++) {
    const v = lut[s.charCodeAt(i)];
    if (v < 0) continue;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
  }
  return out.subarray(0, o);
}

function dequant(s: string, scale: readonly number[], cols: number): Float64Array {
  const b = b64decode(s);
  const n = b.length >> 1;
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let v = b[2 * k] | (b[2 * k + 1] << 8); // little-endian int16
    if (v >= 32768) v -= 65536;
    out[k] = v * scale[k % cols];
  }
  return out;
}

/** Decode a generated table (load time; allocates ≈ 70 KB). */
export function decodeAero(g: AeroGen): AeroTable {
  const nz = g.zones.length;
  const zoneArea = new Float64Array(nz), zoneInvSqrtR = new Float64Array(nz), zoneR = new Float64Array(nz), zoneMirror = new Int32Array(nz);
  g.zones.forEach((z, i) => { zoneArea[i] = z.area; zoneR[i] = z.radius; zoneInvSqrtR[i] = 1 / Math.sqrt(z.radius); zoneMirror[i] = z.mirror; });
  const hB = (g.nBig + 1) / 2, big = dequant(g.dataBig, g.scaleBig, g.colsBig);
  const names = g.zones.map((z) => z.name);
  return {
    hull: g.hull,
    nB: g.nBig, hB, cB: g.colsBig,
    nS: g.nSmall, hS: (g.nSmall + 1) / 2, cS: g.colsSmall,
    big,
    small: dequant(g.dataSmall, g.scaleSmall, g.colsSmall),
    nZones: nz, zoneArea, zoneInvSqrtR, zoneR, zoneMirror, zoneNames: names,
    volume: g.volume, refLength: g.refLength,
    stiffMax: Math.max(g.stiff[0], g.stiff[1], g.stiff[2]),
    stiffV: vertexStiffness(big, g.nBig, hB, g.colsBig),
    noseZone: Math.max(0, names.indexOf('nose')),
  };
}

/** Direction of octahedral vertex (i, j) of the mirror-half grid (as tools/aeroBake.ts octDir). */
function vertexDir(i: number, j: number, n: number, h: number, out: Float64Array): void {
  const s = i / (h - 1), t = -1 + (2 * j) / (n - 1);
  let x = s, y = t;
  const z = 1 - Math.abs(s) - Math.abs(t);
  if (z < 0) { x = (1 - Math.abs(t)) * (s >= 0 ? 1 : -1); y = (1 - Math.abs(s)) * (t >= 0 ? 1 : -1); }
  const l = Math.hypot(x, y, z);
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
}

/**
 * Per vertex and axis, the largest |ΔM_k/q| / angle over the grid edges that touch it (load time). The in-air step
 * limit takes the max over the 4 vertices of the cell it is in: a local, conservative slope (a shadowing step in a
 * far cell no longer shortens every step).
 */
function vertexStiffness(big: Float64Array, n: number, h: number, cols: number): Float64Array {
  const out = new Float64Array(n * h * 3);
  const a = new Float64Array(3), b = new Float64Array(3);
  for (let j = 0; j < n; j++) for (let i = 0; i < h; i++) {
    for (let e = 0; e < 2; e++) {
      const i2 = i + (e === 0 ? 1 : 0), j2 = j + (e === 1 ? 1 : 0);
      if (i2 >= h || j2 >= n) continue;
      vertexDir(i, j, n, h, a); vertexDir(i2, j2, n, h, b);
      const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const ang = Math.acos(c > 1 ? 1 : c < -1 ? -1 : c);
      if (ang < 1e-6) continue;
      const p = (j * h + i) * cols + 3, q = (j2 * h + i2) * cols + 3;
      for (let k = 0; k < 3; k++) {
        const sl = Math.abs(big[q + k] - big[p + k]) / ang;
        const u = (j * h + i) * 3 + k, v = (j2 * h + i2) * 3 + k;
        if (sl > out[u]) out[u] = sl;
        if (sl > out[v]) out[v] = sl;
      }
    }
  }
  return out;
}

// ----------------------------------------------------------------------------------------- lookup

/** Cell of the last octCell call: base offset (vertex index) and the four bilinear weights. */
const CELL = new Float64Array(9);
const C_D = 6; // the direction (ax ≥ 0, uy, uz) octCell reads
const C_I = 0, C_J = 1, C_W = 2; // weights w00 w10 w01 w11 at 2..5

/** Bilinear cell of the direction in CELL[C_D..] (ax ≥ 0, uy, uz) in an N×N mirror-half octahedral vertex grid. */
function octCell(n: number, h: number): void {
  const ax = CELL[C_D], uy = CELL[C_D + 1], uz = CELL[C_D + 2];
  const l = ax + (uy < 0 ? -uy : uy) + (uz < 0 ? -uz : uz);
  let s = ax / l, t = uy / l;
  if (uz < 0) {
    const at = t < 0 ? -t : t;
    const s2 = 1 - at;
    t = (1 - s) * (t >= 0 ? 1 : -1);
    s = s2;
  }
  let fi = s * (h - 1), fj = (t + 1) * 0.5 * (n - 1);
  let i = Math.floor(fi), j = Math.floor(fj);
  if (i > h - 2) i = h - 2; if (i < 0) i = 0;
  if (j > n - 2) j = n - 2; if (j < 0) j = 0;
  fi -= i; fj -= j;
  CELL[C_I] = i; CELL[C_J] = j;
  CELL[C_W] = (1 - fi) * (1 - fj); CELL[C_W + 1] = fi * (1 - fj); CELL[C_W + 2] = (1 - fi) * fj; CELL[C_W + 3] = fi * fj;
}

/**
 * Interpolate columns c0 … c0+count−1 of the grid at the last octCell into out[o0 …]. Writes typed-array slots only
 * (no double return value: a double returned from a call V8 does not inline is a heap allocation).
 */
function interpInto(data: Float64Array, h: number, cols: number, c0: number, count: number, out: Float64Array, o0: number): void {
  const i = CELL[C_I], j = CELL[C_J];
  const w0 = CELL[C_W], w1 = CELL[C_W + 1], w2 = CELL[C_W + 2], w3 = CELL[C_W + 3];
  const a = (j * h + i) * cols + c0, b = a + cols, c = a + h * cols, d = c + cols;
  for (let k = 0; k < count; k++) out[o0 + k] = w0 * data[a + k] + w1 * data[b + k] + w2 * data[c + k] + w3 * data[d + k];
}
/** Interpolated rows: VB (big grid, 6 columns) and VS (small grid, all columns). */
const VB = new Float64Array(8);
const VS = new Float64Array(64);

/** Mach-table lookup of SCR[3] into SCR[0] (K_D) and SCR[1] (K_M). */
const SCR = new Float64Array(16);
function machFactors(): void {
  const m = SCR[3];
  const k = MACH_KNOTS;
  if (!(m > 0)) { SCR[0] = K_DRAG[0]; SCR[1] = K_MOMENT[0]; return; }
  if (m >= k[15]) { SCR[0] = K_DRAG[15]; SCR[1] = K_MOMENT[15]; return; }
  let i = 0;
  while (k[i + 1] < m) i++;
  const w = (m - k[i]) / (k[i + 1] - k[i]);
  SCR[0] = K_DRAG[i] + w * (K_DRAG[i + 1] - K_DRAG[i]);
  SCR[1] = K_MOMENT[i] + w * (K_MOMENT[i + 1] - K_MOMENT[i]);
}

/** Free-molecular weight from the Knudsen number SCR[4] (Wilmoth's sin² bridge in log Kn), into SCR[2]. */
function fmWeight(): void {
  const kn = SCR[4];
  if (!(kn > KN_CONT)) { SCR[2] = 0; return; }
  if (kn >= KN_FM) { SCR[2] = 1; return; }
  const s = Math.sin((Math.PI / 8) * (3 + Math.log10(kn)));
  SCR[2] = s * s;
}

/**
 * Aerodynamic force (N, craft axes) and moment (N·m, about the CoM ai[AI_C*]) at the air-relative craft velocity
 * ai[AI_U*] (craft axes) and body rate ai[AI_W*], into ao. Also q, V, Mach, Kn, the free-molecular weight and the
 * aero pitch frequency ω_air = √(q·stiff/I_min) (the in-air sub-step is ≤ 0.1/ω_air).
 */
export function aeroForce(T: AeroTable, ai: Float64Array, ao: Float64Array): void {
  const ux = ai[AI_UX], uy = ai[AI_UY], uz = ai[AI_UZ], rho = ai[AI_RHO];
  const V = Math.sqrt(ux * ux + uy * uy + uz * uz);
  ao[AO_FX] = ao[AO_FY] = ao[AO_FZ] = ao[AO_MX] = ao[AO_MY] = ao[AO_MZ] = 0;
  ao[AO_V] = V; ao[AO_Q] = 0; ao[AO_MACH] = 0; ao[AO_KN] = 0; ao[AO_WFM] = 0; ao[AO_WAIR] = 0;
  if (!(rho > 0) || !(V > 1e-6)) return;
  const iV = 1 / V;
  // flow direction (the air moves opposite to the craft); mirror into ux ≥ 0
  let fx = -ux * iV;
  const fy = -uy * iV, fz = -uz * iV;
  const sx = fx < 0 ? -1 : 1;
  fx *= sx;
  CELL[C_D] = fx; CELL[C_D + 1] = fy; CELL[C_D + 2] = fz;
  const q = 0.5 * rho * V * V, qv = q * iV;
  const mach = V / ai[AI_A];
  const kn = ai[AI_MFP] / T.refLength;
  SCR[4] = kn; fmWeight();
  const w = SCR[2];
  ao[AO_Q] = q; ao[AO_MACH] = mach; ao[AO_KN] = kn; ao[AO_WFM] = w;
  // mirrored body rate (pseudovector under x → −x: (ωx, −ωy, −ωz))
  const wx = ai[AI_WX], wy = sx * ai[AI_WY], wz = sx * ai[AI_WZ];
  const spin = wx !== 0 || wy !== 0 || wz !== 0;
  let Fx = 0, Fy = 0, Fz = 0, Mx = 0, My = 0, Mz = 0;
  if (w > 0 || spin) {
    octCell(T.nS, T.hS);
    if (w > 0) interpInto(T.small, T.hS, T.cS, 0, S_Z, VS, 0); // FM terms and both damping matrices
    else interpInto(T.small, T.hS, T.cS, S_DN, 6, VS, S_DN);
  }
  if (w < 1) {
    SCR[3] = mach; machFactors();
    const kd = SCR[0], km = SCR[1] * kd, c = 1 - w;
    if (spin) {
      // Newtonian damping (symmetric): M = (q/V)·D_N·ω
      const kdmp = c * kd * qv;
      const dxx = VS[S_DN], dyy = VS[S_DN + 1], dzz = VS[S_DN + 2], dxy = VS[S_DN + 3], dxz = VS[S_DN + 4], dyz = VS[S_DN + 5];
      Mx += kdmp * (dxx * wx + dxy * wy + dxz * wz);
      My += kdmp * (dxy * wx + dyy * wy + dyz * wz);
      Mz += kdmp * (dxz * wx + dyz * wy + dzz * wz);
    }
    octCell(T.nB, T.hB);
    interpInto(T.big, T.hB, T.cB, 0, 6, VB, 0);
    const kf = c * kd * q, kmq = c * km * q;
    Fx += kf * VB[0]; Fy += kf * VB[1]; Fz += kf * VB[2];
    Mx += kmq * VB[3]; My += kmq * VB[4]; Mz += kmq * VB[5];
  }
  if (w > 0) {
    // hyperthermal free-molecular flow, diffuse re-emission at the wall temperature: K = 2·√(πRT_w/(2M))/V
    const K = (2 * Math.sqrt((Math.PI * R_GAS * ai[AI_TW]) / (2 * ai[AI_M]))) * iV;
    const ap = VS[S_AP], sxp = VS[S_S], syp = VS[S_S + 1], szp = VS[S_S + 2];
    const kq = w * q;
    Fx += kq * (2 * ap * fx + K * VS[S_G]);
    Fy += kq * (2 * ap * fy + K * VS[S_G + 1]);
    Fz += kq * (2 * ap * fz + K * VS[S_G + 2]);
    Mx += kq * (2 * (syp * fz - szp * fy) + K * VS[S_MG]);
    My += kq * (2 * (szp * fx - sxp * fz) + K * VS[S_MG + 1]);
    Mz += kq * (2 * (sxp * fy - syp * fx) + K * VS[S_MG + 2]);
    if (spin) {
      const kv = w * qv;
      Mx += kv * (VS[S_DF] * wx + VS[S_DF + 1] * wy + VS[S_DF + 2] * wz);
      My += kv * (VS[S_DF + 3] * wx + VS[S_DF + 4] * wy + VS[S_DF + 5] * wz);
      Mz += kv * (VS[S_DF + 6] * wx + VS[S_DF + 7] * wy + VS[S_DF + 8] * wz);
    }
  }
  // un-mirror: F_x, M_y, M_z change sign
  Fx *= sx; My *= sx; Mz *= sx;
  // about the CoM: M_com = M − c × F
  const cx = ai[AI_CX], cy = ai[AI_CY], cz = ai[AI_CZ];
  ao[AO_FX] = Fx; ao[AO_FY] = Fy; ao[AO_FZ] = Fz;
  ao[AO_MX] = Mx - (cy * Fz - cz * Fy);
  ao[AO_MY] = My - (cz * Fx - cx * Fz);
  ao[AO_MZ] = Mz - (cx * Fy - cy * Fx);
  // In-air step limit: the fastest aero pitch/yaw/roll frequency, each moment axis against its own inertia, with the
  // local slope of the big-grid cell (the max over its 4 vertices; octCell(T.nB) is the last cell looked up when
  // w < 1, else look it up now). Free-molecular moments are taken at twice the Newtonian slope (conservative).
  if (!(w < 1)) octCell(T.nB, T.hB);
  const i0 = CELL[C_I], j0 = CELL[C_J], hb = T.hB, sv = T.stiffV;
  const v00 = (j0 * hb + i0) * 3, v10 = v00 + 3, v01 = v00 + hb * 3, v11 = v01 + 3;
  SCR[3] = mach; machFactors();
  const ks = q * ((1 - w) * SCR[0] * SCR[1] + 2 * w);
  let wa = 0;
  for (let k = 0; k < 3; k++) {
    let m = sv[v00 + k];
    if (sv[v10 + k] > m) m = sv[v10 + k];
    if (sv[v01 + k] > m) m = sv[v01 + k];
    if (sv[v11 + k] > m) m = sv[v11 + k];
    const f = (ks * m) / ai[AI_IX + k];
    if (f > wa) wa = f;
  }
  ao[AO_WAIR] = Math.sqrt(wa);
}

/**
 * Heating per zone, W, into heat[0..nZones−1] at the state in ai (call after aeroForce, which leaves V, Kn weight
 * in ao): convective q_i = min(k·√(ρ/R_i)·V³, ½ρV³) bridged to the free-molecular ½ρV³ by the Kn weight, plus
 * Tauber–Sutton radiative heating above 9 km/s, times the zone's windward projected area. ao[AO_QPEAK] = the
 * largest flux on a zone with ≥ 2% of its area windward; ao[AO_QSTAG] = the same flux model at the NOSE radius
 * (the stagnation heat flux, §1.4 heatFlux), whatever the attitude.
 */
export function aeroHeat(T: AeroTable, ai: Float64Array, ao: Float64Array, heat: Float64Array): void {
  const nz = T.nZones;
  for (let z = 0; z < nz; z++) heat[z] = 0;
  ao[AO_QPEAK] = 0; ao[AO_QSTAG] = 0;
  const rho = ai[AI_RHO], ux = ai[AI_UX], uy = ai[AI_UY], uz = ai[AI_UZ];
  const V = Math.sqrt(ux * ux + uy * uy + uz * uz);
  if (!(rho > 0) || !(V > 1e-6)) return;
  const iV = 1 / V;
  let fx = -ux * iV;
  const fy = -uy * iV, fz = -uz * iV;
  const mir = fx < 0;
  if (mir) fx = -fx;
  CELL[C_D] = fx; CELL[C_D + 1] = fy; CELL[C_D + 2] = fz;
  octCell(T.nS, T.hS);
  SCR[4] = ai[AI_MFP] / T.refLength; fmWeight();
  const w = SCR[2];
  interpInto(T.small, T.hS, T.cS, S_Z, nz, VS, S_Z);
  const V3 = V * V * V, sr = Math.sqrt(rho);
  const qfm = 0.5 * rho * V3;
  // Tauber–Sutton factor f(V) (km/s table), 0 below 9 km/s
  let fV = 0;
  const vk = V * 1e-3;
  if (vk > 9) {
    if (vk >= 16) fV = TS_F[18] + ((TS_F[18] - TS_F[17]) / 0.5) * (vk - 16);
    else { let i = 0; while (TS_V[i + 1] < vk) i++; fV = TS_F[i] + ((TS_F[i + 1] - TS_F[i]) * (vk - TS_V[i])) / (TS_V[i + 1] - TS_V[i]); }
  }
  let aExp = 0, rhoPow = 0;
  if (fV > 0) {
    aExp = 1.072e6 * Math.pow(V, -1.88) * Math.pow(rho, -0.325);
    if (aExp > 1) aExp = 1;
    rhoPow = Math.pow(rho, 1.22);
  }
  let peak = 0;
  for (let z = 0; z < nz; z++) {
    const ap = VS[S_Z + (mir ? T.zoneMirror[z] : z)];
    if (!(ap > 0)) continue;
    let qc = SG_K * sr * V3 * T.zoneInvSqrtR[z];
    if (qc > qfm) qc = qfm;
    let qz = (1 - w) * qc + w * qfm;
    if (fV > 0) qz += 4.736e8 * Math.pow(T.zoneR[z], aExp) * rhoPow * fV * (1 - w);
    heat[z] = qz * ap;
    if (ap > 0.02 * T.zoneArea[z] && qz > peak) peak = qz;
  }
  ao[AO_QPEAK] = peak;
  {
    const zn = T.noseZone;
    let qc = SG_K * sr * V3 * T.zoneInvSqrtR[zn];
    if (qc > qfm) qc = qfm;
    let qs = (1 - w) * qc + w * qfm;
    if (fV > 0) qs += 4.736e8 * Math.pow(T.zoneR[zn], aExp) * rhoPow * fV * (1 - w);
    ao[AO_QSTAG] = qs;
  }
}

/**
 * Centre of pressure: the point of the force's line of action closest to the CoM, craft axes: c + (F × M)/|F|²
 * (M about the CoM c). Display / tests.
 */
export function centreOfPressure(F: { x: number; y: number; z: number }, M: { x: number; y: number; z: number }, com: { x: number; y: number; z: number }, out: { x: number; y: number; z: number }): void {
  const f2 = F.x * F.x + F.y * F.y + F.z * F.z;
  if (!(f2 > 0)) { out.x = com.x; out.y = com.y; out.z = com.z; return; }
  out.x = com.x + (F.y * M.z - F.z * M.y) / f2;
  out.y = com.y + (F.z * M.x - F.x * M.z) / f2;
  out.z = com.z + (F.x * M.y - F.y * M.x) / f2;
}

/** Buoyancy force magnitude, N: ρ·V_hull·g (upward, against local gravity). */
export const buoyancy = (T: AeroTable, rho: number, g: number): number => rho * T.volume * g;
