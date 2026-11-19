// Build-time core of the aero/thermal skin bake (SIMULATION.md W2-B item 4). Bundled for node by
// tools/bake-aero.mjs (which writes src/data/aero/<hull>.ts); imported directly by tests/aero.test.ts, which
// re-bakes a few directions and compares them with the generated table within the quantisation step.
// NOT part of the game bundle (nothing in src/ imports it).
//
// Skin: every part of the hull compound (src/data/hullColliders.ts via world/compound.ts) is tiled with cells of
// about `spacing` metres (box faces in a grid, capsules as cylinder rings plus equal-area hemisphere bands, spheres
// in equal-area bands); a cell whose centre, pushed 1 mm outward, lies inside any part is interior skin and is
// dropped, so what remains is the outer skin of the union. Each cell: centre p, outward normal n, area A, zone.
//
// Directions: an octahedral VERTEX grid of N×N directions (vertex sampling makes bilinear interpolation continuous
// across the folds), mirror-halved (the hull is left–right symmetric, ux ≥ 0 only): N = 33 for the Newtonian force
// and moment, every second vertex (N = 17) for free-molecular, damping and zone areas.
//
// Per flow direction û (the direction the AIR moves relative to the craft) and per cell with d = n·û < 0 (windward)
// that is not shadowed (a ray from p upstream, along −û, hits no other part):
//   Newtonian  f/q = A·(1.84·d²·(−n) + C_f·t̂)  (t̂ the flow's tangential direction, C_f = 0.002); F, M = Σ f, Σ p × f
//   Free-molecular (hyperthermal, full accommodation, diffuse re-emission): f/q = A·c·(2·û + K·(−n)), c = −d, with
//              K chosen at run time (re-emission speed / flow speed): stored as A_p = Σ A c, S = Σ A c p,
//              G = Σ A c (−n), Mg = Σ A c p × (−n)  →  F/q = 2·A_p·û + K·G,  M/q = 2·S × û + K·Mg
//   Damping (∂M/∂ω, analytic): Newtonian  M_d = (q/V)·D_N·ω,  D_N = Σ 3.68·d·A·(p×n)(p×n)ᵀ  (symmetric, 6 terms)
//              free-molecular  D_F = Σ 2A·[(p×û)(p×n)ᵀ + d·(|p|²I − p pᵀ)]  (9 terms)
//   Zones: projected windward area per zone Σ_zone A c (W2-B heating, W2-D sun / albedo / IR).

import { HULL_COLLIDERS, type HullPartDef } from '../src/data/hullColliders';
import { PART_BOX, PART_CAPSULE, compileCompound, compoundContains, type Compound } from '../src/world/compound';

export const CP_MAX = 1.84;
export const C_F = 0.002;
export const N_BIG = 33;
export const N_SMALL = 17;
export const COLS_BIG = 6;
/** Small-grid columns: Ap, S(3), G(3), Mg(3), D_N(6: xx yy zz xy xz yz), D_F(9 row-major), zones(12). */
export const COLS_SMALL = 1 + 3 + 3 + 3 + 6 + 9 + 12;
export const N_ZONES = 12;

/**
 * PROVISIONAL zone table, until W2-C delivers HULL_ZONES in src/data/hullColliders.ts (then: tag by it and re-bake).
 * radius = the local radius of curvature that sets the stagnation heating (m); mirror = the zone's mirror image.
 */
export const ZONES: { name: string; radius: number; mirror: number }[] = [
  { name: 'nose', radius: 0.9, mirror: 0 },
  { name: 'canopy', radius: 0.45, mirror: 1 },
  { name: 'belly-fwd', radius: 1.27, mirror: 2 },
  { name: 'belly-aft', radius: 1.27, mirror: 3 },
  { name: 'dorsal-fwd', radius: 0.8, mirror: 4 },
  { name: 'dorsal-aft', radius: 0.8, mirror: 5 },
  { name: 'chine-port', radius: 0.3, mirror: 7 },
  { name: 'chine-stbd', radius: 0.3, mirror: 6 },
  { name: 'pod-port', radius: 1.27, mirror: 9 },
  { name: 'pod-stbd', radius: 1.27, mirror: 8 },
  { name: 'wing-port', radius: 0.12, mirror: 11 },
  { name: 'wing-stbd', radius: 0.12, mirror: 10 },
];

function zoneOf(name: string, x: number, y: number, z: number, ny: number): number {
  const port = x < 0;
  if (/^(wing|fin)/.test(name) || Math.abs(x) > 6.2) return port ? 10 : 11;
  if (/^pod/.test(name)) return port ? 8 : 9;
  if (z < -13.4 || /^(nose|chin|windscreen)/.test(name)) return 0;
  if (/^(canopy|cockpit)/.test(name)) return 1;
  if (/(chine|flank|cheek|shoulder|valley|radiator|tank|flare)/.test(name) || Math.abs(x) > 3.3) return port ? 6 : 7;
  if (ny < -0.5 || y < -1.0) return z < 1 ? 2 : 3;
  return z < 1 ? 4 : 5;
}

export interface Skin {
  n: number;
  /** Per cell: p (3), n (3), A, part index, zone (stride 9). */
  cell: Float64Array;
  area: number;
  zoneArea: Float64Array;
}

const PS = 16;

/** Tile the outer skin of the compound. */
export function sampleSkin(cmp: Compound, spacing: number): Skin {
  const out: number[] = [];
  const d = cmp.data;
  const push = (part: number, px: number, py: number, pz: number, nx: number, ny: number, nz: number, A: number): void => {
    const l = Math.hypot(nx, ny, nz);
    nx /= l; ny /= l; nz /= l;
    if (compoundContains(cmp, px + 1e-3 * nx, py + 1e-3 * ny, pz + 1e-3 * nz)) return;
    out.push(px, py, pz, nx, ny, nz, A, part, zoneOf(cmp.names[part], px, py, pz, ny));
  };
  for (let i = 0; i < cmp.n; i++) {
    const o = i * PS;
    if (cmp.kind[i] === PART_BOX) {
      const c = [d[o], d[o + 1], d[o + 2]], h = [d[o + 3], d[o + 4], d[o + 5]];
      const u = [[d[o + 6], d[o + 7], d[o + 8]], [d[o + 9], d[o + 10], d[o + 11]], [d[o + 12], d[o + 13], d[o + 14]]];
      for (let a = 0; a < 3; a++) {
        const b = (a + 1) % 3, e = (a + 2) % 3;
        const nb = Math.max(1, Math.ceil((2 * h[b]) / spacing)), ne = Math.max(1, Math.ceil((2 * h[e]) / spacing));
        const A = (4 * h[b] * h[e]) / (nb * ne);
        for (const sg of [-1, 1]) {
          for (let ib = 0; ib < nb; ib++) for (let ie = 0; ie < ne; ie++) {
            const sb = -h[b] + (2 * h[b] * (ib + 0.5)) / nb, se = -h[e] + (2 * h[e] * (ie + 0.5)) / ne;
            const px = c[0] + sg * h[a] * u[a][0] + sb * u[b][0] + se * u[e][0];
            const py = c[1] + sg * h[a] * u[a][1] + sb * u[b][1] + se * u[e][1];
            const pz = c[2] + sg * h[a] * u[a][2] + sb * u[b][2] + se * u[e][2];
            push(i, px, py, pz, sg * u[a][0], sg * u[a][1], sg * u[a][2], A);
          }
        }
      }
    } else {
      const ax = d[o], ay = d[o + 1], az = d[o + 2], bx = d[o + 3], by = d[o + 4], bz = d[o + 5], r = d[o + 6];
      let ex = bx - ax, ey = by - ay, ez = bz - az;
      const L = Math.hypot(ex, ey, ez);
      if (L > 1e-9) { ex /= L; ey /= L; ez /= L; } else { ex = 0; ey = 0; ez = 1; }
      // basis ⊥ e
      let px0 = Math.abs(ex) < 0.9 ? 1 : 0, py0 = Math.abs(ex) < 0.9 ? 0 : 1, pz0 = 0;
      const dp = px0 * ex + py0 * ey + pz0 * ez;
      px0 -= dp * ex; py0 -= dp * ey; pz0 -= dp * ez;
      const pl = Math.hypot(px0, py0, pz0);
      px0 /= pl; py0 /= pl; pz0 /= pl;
      const qx0 = ey * pz0 - ez * py0, qy0 = ez * px0 - ex * pz0, qz0 = ex * py0 - ey * px0;
      const nphi = Math.max(8, Math.ceil((2 * Math.PI * r) / spacing));
      if (L > 1e-9) {
        const nl = Math.max(1, Math.ceil(L / spacing));
        const A = (2 * Math.PI * r * L) / (nl * nphi);
        for (let il = 0; il < nl; il++) for (let ip = 0; ip < nphi; ip++) {
          const s = (L * (il + 0.5)) / nl, ph = (2 * Math.PI * (ip + 0.5)) / nphi;
          const cx = Math.cos(ph), sx = Math.sin(ph);
          const nx = cx * px0 + sx * qx0, ny = cx * py0 + sx * qy0, nz = cx * pz0 + sx * qz0;
          push(i, ax + s * ex + r * nx, ay + s * ey + r * ny, az + s * ez + r * nz, nx, ny, nz, A);
        }
      }
      // hemispheres (a full sphere when L = 0): equal-area bands in the axial coordinate
      const nb = Math.max(2, Math.ceil((Math.PI * r) / 2 / spacing));
      for (const [cxp, cyp, czp, sg] of [[ax, ay, az, -1], [bx, by, bz, 1]] as const) {
        const A = (2 * Math.PI * r * r) / (nb * nphi);
        for (let ib = 0; ib < nb; ib++) {
          const ct = (ib + 0.5) / nb, st = Math.sqrt(1 - ct * ct);
          for (let ip = 0; ip < nphi; ip++) {
            const ph = (2 * Math.PI * (ip + 0.5 * (ib & 1))) / nphi;
            const cx = Math.cos(ph) * st, sx = Math.sin(ph) * st;
            const nx = sg * ct * ex + cx * px0 + sx * qx0, ny = sg * ct * ey + cx * py0 + sx * qy0, nz = sg * ct * ez + cx * pz0 + sx * qz0;
            push(i, cxp + r * nx, cyp + r * ny, czp + r * nz, nx, ny, nz, A);
          }
        }
      }
    }
  }
  // Enforce the left–right mirror symmetry the half tables assume: keep the x > 0 cells and their mirror images (part
  // and zone mapped to their mirror twins), and the cells exactly on the plane x = 0 (cylinder phases and box grids
  // are not mirror-symmetric cell by cell, so tiling both halves independently left 1% area asymmetries).
  const twin = mirrorParts(cmp);
  const sym: number[] = [];
  for (let k = 0; k < out.length; k += 9) {
    const x = out[k];
    if (x < -1e-9) continue;
    for (let j = 0; j < 9; j++) sym.push(out[k + j]);
    if (x > 1e-9) {
      sym.push(-out[k], out[k + 1], out[k + 2], -out[k + 3], out[k + 4], out[k + 5], out[k + 6], twin[out[k + 7]], ZONES[out[k + 8]].mirror);
    }
  }
  const cell = Float64Array.from(sym);
  const n = cell.length / 9;
  let area = 0;
  const zoneArea = new Float64Array(N_ZONES);
  for (let k = 0; k < n; k++) { area += cell[k * 9 + 6]; zoneArea[cell[k * 9 + 8]] += cell[k * 9 + 6]; }
  return { n, cell, area, zoneArea };
}

/** Mirror twin of every part (port ↔ stbd by name; a part without a side is its own twin). */
function mirrorParts(cmp: Compound): number[] {
  return cmp.names.map((nm, i) => {
    const t = nm.includes('port') ? nm.replace('port', 'stbd') : nm.includes('stbd') ? nm.replace('stbd', 'port') : nm;
    const j = cmp.names.indexOf(t);
    return j >= 0 ? j : i;
  });
}

// ------------------------------------------------------------------------------------------- ray casting

/** Does the ray p + t·dir (t > 1e-4) hit part i? */
function rayHitsPart(cmp: Compound, i: number, px: number, py: number, pz: number, dx: number, dy: number, dz: number): boolean {
  const bs = cmp.bs, b = i * 4;
  const wx = bs[b] - px, wy = bs[b + 1] - py, wz = bs[b + 2] - pz, R = bs[b + 3];
  const pr = wx * dx + wy * dy + wz * dz;
  if (pr < -R) return false;
  if (wx * wx + wy * wy + wz * wz - pr * pr > R * R) return false;
  const d = cmp.data, o = i * PS;
  if (cmp.kind[i] === PART_BOX) {
    let t0 = 1e-4, t1 = Infinity;
    const rx = px - d[o], ry = py - d[o + 1], rz = pz - d[o + 2];
    for (let k = 0; k < 3; k++) {
      const u = o + 6 + 3 * k;
      const ol = rx * d[u] + ry * d[u + 1] + rz * d[u + 2];
      const dl = dx * d[u] + dy * d[u + 1] + dz * d[u + 2];
      const h = d[o + 3 + k];
      if (Math.abs(dl) < 1e-12) { if (Math.abs(ol) > h) return false; continue; }
      let ta = (-h - ol) / dl, tb = (h - ol) / dl;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return false;
    }
    return true;
  }
  // capsule / sphere: segment a–b, radius r (Quilez's capsule intersection)
  const ax = d[o], ay = d[o + 1], az = d[o + 2], r = d[o + 6];
  const bax = d[o + 3] - ax, bay = d[o + 4] - ay, baz = d[o + 5] - az;
  const oax = px - ax, oay = py - ay, oaz = pz - az;
  const baba = bax * bax + bay * bay + baz * baz;
  const bard = bax * dx + bay * dy + baz * dz;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = dx * oax + dy * oay + dz * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;
  const sph = (cx: number, cy: number, cz: number): boolean => {
    const ox = px - cx, oy = py - cy, oz = pz - cz;
    const bb = ox * dx + oy * dy + oz * dz, cc = ox * ox + oy * oy + oz * oz - r * r;
    const hh = bb * bb - cc;
    if (hh < 0) return false;
    const s = Math.sqrt(hh);
    return -bb + s > 1e-4; // the far root ahead: the ray passes through the sphere ahead of p
  };
  if (baba < 1e-18) return sph(ax, ay, az);
  const a = baba - bard * bard;
  const bq = baba * rdoa - baoa * bard;
  const c = baba * oaoa - baoa * baoa - r * r * baba;
  let hh = bq * bq - a * c;
  if (hh >= 0 && a > 1e-18) {
    const s = Math.sqrt(hh);
    for (const t of [(-bq - s) / a, (-bq + s) / a]) {
      if (t <= 1e-4) continue;
      const y = baoa + t * bard;
      if (y > 0 && y < baba) return true;
    }
  }
  return sph(ax, ay, az) || sph(ax + bax, ay + bay, az + baz);
}

/** Shadowing on (default) or off (to compare with an unshadowed Newtonian estimate). */
let SHADOW = true;
export function setShadowing(on: boolean): void { SHADOW = on; }

function shadowed(cmp: Compound, own: number, px: number, py: number, pz: number, dx: number, dy: number, dz: number): boolean {
  for (let i = 0; i < cmp.n; i++) {
    if (i === own) continue;
    if (rayHitsPart(cmp, i, px, py, pz, dx, dy, dz)) return true;
  }
  return false;
}

// ------------------------------------------------------------------------------------------- directions

/** Direction of octahedral vertex (s, t) ∈ [−1, 1]², s ≥ 0 in the mirror half. */
export function octDir(s: number, t: number, out: Float64Array): void {
  let x = s, y = t;
  let z = 1 - Math.abs(s) - Math.abs(t);
  if (z < 0) {
    x = (1 - Math.abs(t)) * (s >= 0 ? 1 : -1);
    y = (1 - Math.abs(s)) * (t >= 0 ? 1 : -1);
  }
  const l = Math.hypot(x, y, z);
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
}

/** One flow direction: the 6 big-grid and the 37 small-grid columns. */
export function bakeDirection(cmp: Compound, skin: Skin, ux: number, uy: number, uz: number, big: Float64Array, bo: number, small: Float64Array | null, so: number): void {
  const C = skin.cell;
  let Fx = 0, Fy = 0, Fz = 0, Mx = 0, My = 0, Mz = 0;
  const sm = new Float64Array(COLS_SMALL);
  for (let k = 0; k < skin.n; k++) {
    const o = k * 9;
    const nx = C[o + 3], ny = C[o + 4], nz = C[o + 5];
    const d = nx * ux + ny * uy + nz * uz;
    if (d >= 0) continue;
    const px = C[o], py = C[o + 1], pz = C[o + 2];
    if (SHADOW && shadowed(cmp, C[o + 7], px, py, pz, -ux, -uy, -uz)) continue;
    const A = C[o + 6], c = -d;
    // Newtonian pressure + skin friction along the tangential flow
    const cp = CP_MAX * d * d * A;
    let tx = ux - d * nx, ty = uy - d * ny, tz = uz - d * nz;
    const tl = Math.hypot(tx, ty, tz);
    if (tl > 1e-9) { const k2 = (C_F * A) / tl; tx *= k2; ty *= k2; tz *= k2; } else { tx = ty = tz = 0; }
    const fx = -cp * nx + tx, fy = -cp * ny + ty, fz = -cp * nz + tz;
    Fx += fx; Fy += fy; Fz += fz;
    Mx += py * fz - pz * fy; My += pz * fx - px * fz; Mz += px * fy - py * fx;
    if (small) {
      const ac = A * c;
      sm[0] += ac;
      sm[1] += ac * px; sm[2] += ac * py; sm[3] += ac * pz;
      sm[4] -= ac * nx; sm[5] -= ac * ny; sm[6] -= ac * nz;
      sm[7] -= ac * (py * nz - pz * ny); sm[8] -= ac * (pz * nx - px * nz); sm[9] -= ac * (px * ny - py * nx);
      const vx = py * nz - pz * ny, vy = pz * nx - px * nz, vz = px * ny - py * nx; // p × n
      const kd = 2 * CP_MAX * d * A;
      sm[10] += kd * vx * vx; sm[11] += kd * vy * vy; sm[12] += kd * vz * vz;
      sm[13] += kd * vx * vy; sm[14] += kd * vx * vz; sm[15] += kd * vy * vz;
      const wx = py * uz - pz * uy, wy = pz * ux - px * uz, wz = px * uy - py * ux; // p × û
      const p2 = px * px + py * py + pz * pz;
      const w = [wx, wy, wz], v = [vx, vy, vz], p = [px, py, pz];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        sm[16 + 3 * i + j] += 2 * A * (w[i] * v[j] + d * ((i === j ? p2 : 0) - p[i] * p[j]));
      }
      sm[25 + C[o + 8]] += ac;
    }
  }
  big[bo] = Fx; big[bo + 1] = Fy; big[bo + 2] = Fz; big[bo + 3] = Mx; big[bo + 4] = My; big[bo + 5] = Mz;
  if (small) for (let c = 0; c < COLS_SMALL; c++) small[so + c] = sm[c];
}

export interface AeroBake {
  hull: string;
  spacing: number;
  samples: number;
  skinArea: number;
  zoneArea: number[];
  volume: number;
  big: Float64Array;
  small: Float64Array;
  /** max |∂(M/q)/∂θ| per body axis, m³/rad (for the in-air step limit). */
  stiff: number[];
  ms: number;
}

/** Hull volume by a voxel count of the compound, m³. */
export function hullVolume(cmp: Compound, h = 0.2): number {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < cmp.n; i++) {
    x0 = Math.min(x0, cmp.aabb[i * 6]); y0 = Math.min(y0, cmp.aabb[i * 6 + 1]); z0 = Math.min(z0, cmp.aabb[i * 6 + 2]);
    x1 = Math.max(x1, cmp.aabb[i * 6 + 3]); y1 = Math.max(y1, cmp.aabb[i * 6 + 4]); z1 = Math.max(z1, cmp.aabb[i * 6 + 5]);
  }
  let n = 0;
  for (let x = x0 + h / 2; x < x1; x += h) for (let y = y0 + h / 2; y < y1; y += h) for (let z = z0 + h / 2; z < z1; z += h) {
    if (compoundContains(cmp, x, y, z)) n++;
  }
  return n * h * h * h;
}

export const HB = (N_BIG + 1) / 2;
export const HS = (N_SMALL + 1) / 2;

export function compoundOf(hull: string): Compound {
  const defs = (HULL_COLLIDERS as Record<string, HullPartDef[] | undefined>)[hull];
  if (!defs) throw new Error(`no hull ${hull}`);
  return compileCompound(defs);
}

/** The whole bake for one hull. */
export function bakeHull(hull: string, spacing = 0.25): AeroBake {
  const t0 = performance.now();
  const cmp = compoundOf(hull);
  const skin = sampleSkin(cmp, spacing);
  const big = new Float64Array(HB * N_BIG * COLS_BIG);
  const small = new Float64Array(HS * N_SMALL * COLS_SMALL);
  const u = new Float64Array(3);
  for (let j = 0; j < N_BIG; j++) for (let i = 0; i < HB; i++) {
    octDir(i / (HB - 1), -1 + (2 * j) / (N_BIG - 1), u);
    const onSmall = (i & 1) === 0 && (j & 1) === 0;
    bakeDirection(cmp, skin, u[0], u[1], u[2], big, (j * HB + i) * COLS_BIG, onSmall ? small : null, onSmall ? ((j >> 1) * HS + (i >> 1)) * COLS_SMALL : 0);
  }
  // stiffness: largest moment-coefficient slope between neighbouring vertices
  const stiff = [0, 0, 0];
  const ua = new Float64Array(3), ub = new Float64Array(3);
  for (let j = 0; j < N_BIG; j++) for (let i = 0; i < HB; i++) {
    for (const [di, dj] of [[1, 0], [0, 1]]) {
      const i2 = i + di, j2 = j + dj;
      if (i2 >= HB || j2 >= N_BIG) continue;
      octDir(i / (HB - 1), -1 + (2 * j) / (N_BIG - 1), ua);
      octDir(i2 / (HB - 1), -1 + (2 * j2) / (N_BIG - 1), ub);
      const ang = Math.acos(Math.min(1, ua[0] * ub[0] + ua[1] * ub[1] + ua[2] * ub[2]));
      if (ang < 1e-6) continue;
      const a = (j * HB + i) * COLS_BIG, b = (j2 * HB + i2) * COLS_BIG;
      for (let k = 0; k < 3; k++) stiff[k] = Math.max(stiff[k], Math.abs(big[b + 3 + k] - big[a + 3 + k]) / ang);
    }
  }
  const volume = hullVolume(cmp);
  return {
    hull, spacing, samples: skin.n, skinArea: skin.area, zoneArea: Array.from(skin.zoneArea), volume, big, small, stiff,
    ms: performance.now() - t0,
  };
}

// ------------------------------------------------------------------------------------------- packing

/** Quantise columns to int16 with a per-column scale (max |x| / 32767). */
export function quantise(data: Float64Array, cols: number): { q: Int16Array; scale: number[] } {
  const rows = data.length / cols;
  const scale: number[] = [];
  const q = new Int16Array(data.length);
  for (let c = 0; c < cols; c++) {
    let m = 0;
    for (let r = 0; r < rows; r++) m = Math.max(m, Math.abs(data[r * cols + c]));
    const s = m > 0 ? m / 32767 : 1;
    scale.push(s);
    for (let r = 0; r < rows; r++) q[r * cols + c] = Math.round(data[r * cols + c] / s);
  }
  return { q, scale };
}
