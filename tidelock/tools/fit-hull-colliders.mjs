#!/usr/bin/env node
// Check (and optionally fit) the collision compounds of src/data/hullColliders.ts against the hull meshes that
// render/space/ships.ts builds (buildShipModel, run in node: hull + glass channels).
//
//   node tools/fit-hull-colliders.mjs                 check every hull, print coverage / protrusion
//   node tools/fit-hull-colliders.mjs --hull wren     one hull (repeatable / comma list)
//   node tools/fit-hull-colliders.mjs --fit --write   move box faces and radii onto the mesh, rewrite the file
//   node tools/fit-hull-colliders.mjs --seed --write  replace a compound by an automatic box decomposition
//                                                    (--max-parts 16); keep hand-made ones for hulls you care about
//   node tools/fit-hull-colliders.mjs --slices        also print the mesh's extents per 1 m slice along Z
//   node tools/fit-hull-colliders.mjs --gaps     also measure the gaps: hull surface farther than --gap-tol from the
//                                                    compound (worst place, share of the surface beyond it)
//   node tools/fit-hull-colliders.mjs --ascii    print top / side silhouettes (# hull only, @ both, + compound only)
//   --close 0.3   flood the outside with a ball of this radius (open tubes and bells read as solid)
//   --section -12,4.5   print cross-sections at these z (with --gaps)
//   --tol 0.3   allowed protrusion (m)      --vox 0.15   voxel size (m, grows for big hulls)   --gap-tol 0.3 (m)
//
// Method: the hull triangles are rasterised into a voxel grid, the outside is flood-filled from the border and
// everything not reached is "solid" (hull volume). Coverage = solid voxels inside the compound / solid voxels.
// Protrusion = distance from a compound voxel that is not solid to the nearest solid voxel. For the Wren the
// interior rooms of src/data/interiors.ts must lie inside the compound (checked, and fitting never breaks it).
// Fitting is greedy: a face (box) or radius (capsule/sphere) grows one voxel while the slab just outside it is
// at least half solid, and shrinks while the slab just inside it protrudes more than --tol and is mostly empty.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = path.join(root, 'src/data/hullColliders.ts');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const TOL = Number(opt('--tol', '0.3'));
const VOX0 = Number(opt('--vox', '0.15'));

async function load() {
  const { build } = await import('esbuild');
  const tmp = path.join(os.tmpdir(), `tidelock-hullfit-${process.pid}.mjs`);
  await build({
    stdin: {
      contents: "export { buildShipModel } from './src/render/space/ships'; export { CH_HULL, CH_GLASS } from './src/render/space/geo'; export { HULL_COLLIDERS } from './src/data/hullColliders'; export { SHIP_LAYOUTS } from './src/data/shipLayouts'; export { INTERIORS } from './src/data/interiors';",
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'esm', outfile: tmp, logLevel: 'error', define: { __DEV__: 'false' },
  });
  const mod = await import(pathToFileURL(tmp).href);
  await fs.unlink(tmp).catch(() => {});
  return mod;
}

// ------------------------------------------------------------------------------------------------ parts

function qrot(q, x, y, z) {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)];
}
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];

function segDist2(p, a, b) {
  const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2];
  const l2 = ex * ex + ey * ey + ez * ez;
  let t = l2 > 0 ? ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey + (p[2] - a[2]) * ez) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = p[0] - a[0] - t * ex, dy = p[1] - a[1] - t * ey, dz = p[2] - a[2] - t * ez;
  return dx * dx + dy * dy + dz * dz;
}

function partInside(pt, p) {
  if (p.kind === 'sphere') return (pt[0] - p.c[0]) ** 2 + (pt[1] - p.c[1]) ** 2 + (pt[2] - p.c[2]) ** 2 <= p.r * p.r;
  if (p.kind === 'capsule') return segDist2(pt, p.a, p.b) <= p.r * p.r;
  let x = pt[0] - p.c[0], y = pt[1] - p.c[1], z = pt[2] - p.c[2];
  if (p.q) [x, y, z] = qrot(qinv(p.q), x, y, z);
  return Math.abs(x) <= p.h[0] && Math.abs(y) <= p.h[1] && Math.abs(z) <= p.h[2];
}
const inCompound = (pt, parts) => parts.some((p) => partInside(pt, p));

function partBounds(p) {
  if (p.kind === 'sphere') return [p.c.map((v) => v - p.r), p.c.map((v) => v + p.r)];
  if (p.kind === 'capsule') return [[0, 1, 2].map((i) => Math.min(p.a[i], p.b[i]) - p.r), [0, 1, 2].map((i) => Math.max(p.a[i], p.b[i]) + p.r)];
  const ext = [0, 1, 2].map((i) => {
    if (!p.q) return p.h[i];
    let s = 0;
    for (let k = 0; k < 3; k++) { const ax = qrot(p.q, k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0); s += Math.abs(ax[i]) * p.h[k]; }
    return s;
  });
  return [p.c.map((v, i) => v - ext[i]), p.c.map((v, i) => v + ext[i])];
}

// ------------------------------------------------------------------------------------------------ voxels

function voxelise(mod, id, parts) {
  const model = mod.buildShipModel(id, 0, 0, true);
  const tris = [];
  for (const ch of [mod.CH_HULL, mod.CH_GLASS]) {
    const g = model.geometries[ch];
    if (!g) continue;
    const pos = g.getAttribute('position').array, idx = g.index ? g.index.array : null;
    const n = idx ? idx.length : pos.length / 3;
    for (let i = 0; i < n; i++) { const k = idx ? idx[i] : i; tris.push(pos[3 * k], pos[3 * k + 1], pos[3 * k + 2]); }
  }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], tris[i + k]); hi[k] = Math.max(hi[k], tris[i + k]); }
  const meshLo = lo.slice(), meshHi = hi.slice();
  for (const p of parts) { const [a, b] = partBounds(p); for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], a[k]); hi[k] = Math.max(hi[k], b[k]); } }
  const vox = Math.max(VOX0, Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 420);
  for (let k = 0; k < 3; k++) { lo[k] -= 3 * vox; hi[k] += 3 * vox; }
  const nx = Math.ceil((hi[0] - lo[0]) / vox), ny = Math.ceil((hi[1] - lo[1]) / vox), nz = Math.ceil((hi[2] - lo[2]) / vox);
  const N = nx * ny * nz, grid = new Uint8Array(N); // 1 surface, 2 outside, 0 unknown (-> inside)
  const mark = (x, y, z) => {
    const i = Math.floor((x - lo[0]) / vox), j = Math.floor((y - lo[1]) / vox), k = Math.floor((z - lo[2]) / vox);
    if (i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz) grid[i + nx * (j + ny * k)] = 1;
  };
  for (let t = 0; t < tris.length; t += 9) {
    const ax = tris[t], ay = tris[t + 1], az = tris[t + 2], bx = tris[t + 3], by = tris[t + 4], bz = tris[t + 5], cx = tris[t + 6], cy = tris[t + 7], cz = tris[t + 8];
    const e = Math.max(Math.hypot(bx - ax, by - ay, bz - az), Math.hypot(cx - ax, cy - ay, cz - az), Math.hypot(cx - bx, cy - by, cz - bz));
    const n = Math.max(1, Math.ceil(e / (0.5 * vox)));
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
      const u = i / n, w = j / n, s = 1 - u - w;
      mark(s * ax + u * bx + w * cx, s * ay + u * by + w * cy, s * az + u * bz + w * cz);
    }
  }
  // Flood the outside from the border (6-connected). With --close R the flood is made by a ball of radius R: open
  // shells (pod tubes, nozzle throats) whose mouths are narrower than 2R count as solid, as a body hitting them feels.
  const q = new Int32Array(N);
  let qh = 0, qt = 0;
  const CLOSE = Number(opt('--close', '0'));
  let deep = null;
  if (CLOSE > 0) {
    deep = new Float32Array(N).fill(1e9);
    const sq = new Int32Array(N), ss = new Int32Array(N).fill(-1);
    let h = 0, t = 0;
    for (let c = 0; c < N; c++) if (grid[c] === 1) { deep[c] = 0; ss[c] = c; sq[t++] = c; }
    while (h < t) {
      const c = sq[h++], i = c % nx, j = ((c / nx) | 0) % ny, k = (c / (nx * ny)) | 0, s0 = ss[c];
      const si = s0 % nx, sj = ((s0 / nx) | 0) % ny, sk = (s0 / (nx * ny)) | 0;
      for (const d of [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1, k > 0 ? c - nx * ny : -1, k < nz - 1 ? c + nx * ny : -1]) {
        if (d < 0) continue;
        const di = d % nx, dj = ((d / nx) | 0) % ny, dk = (d / (nx * ny)) | 0, dd = Math.hypot(di - si, dj - sj, dk - sk) * vox;
        if (dd < deep[d] - 1e-6) { if (ss[d] < 0) sq[t++] = d; deep[d] = dd; ss[d] = s0; }
      }
    }
  }
  if (CLOSE > 0) {
    // ... and the mouths of the engine bells are closed: the bell's volume (exit radius, two radii deep) is hull.
    const L = mod.SHIP_LAYOUTS[id];
    for (const e of L ? L.engines : []) {
      for (let k = 0; k < nz; k++) {
        const z = lo[2] + (k + 0.5) * vox;
        if (z < e.pos.z - 2 * e.radius || z > e.pos.z) continue;
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
          const x = lo[0] + (i + 0.5) * vox, y = lo[1] + (j + 0.5) * vox;
          if ((x - e.pos.x) ** 2 + (y - e.pos.y) ** 2 <= e.radius * e.radius && grid[i + nx * (j + ny * k)] === 0) grid[i + nx * (j + ny * k)] = 1;
        }
      }
    }
  }
  const push = (i) => { if (grid[i] === 0 && (!deep || deep[i] > CLOSE)) { grid[i] = 2; q[qt++] = i; } };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
    if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) push(i + nx * (j + ny * k));
  while (qh < qt) {
    const c = q[qh++], i = c % nx, j = ((c / nx) | 0) % ny, k = (c / (nx * ny)) | 0;
    if (i > 0) push(c - 1); if (i < nx - 1) push(c + 1);
    if (j > 0) push(c - nx); if (j < ny - 1) push(c + nx);
    if (k > 0) push(c - nx * ny); if (k < nz - 1) push(c + nx * ny);
  }
  if (deep) {
    // Dilate the ball-reachable outside back by R (the ball's own sweep): every free voxel within R of it is outside.
    const sq = new Int32Array(N), ss = new Int32Array(N).fill(-1), dd0 = new Float32Array(N).fill(1e9);
    let h = 0, t = 0;
    for (let c = 0; c < N; c++) if (grid[c] === 2) { ss[c] = c; dd0[c] = 0; sq[t++] = c; }
    while (h < t) {
      const c = sq[h++], i = c % nx, j = ((c / nx) | 0) % ny, k = (c / (nx * ny)) | 0, s0 = ss[c];
      const si = s0 % nx, sj = ((s0 / nx) | 0) % ny, sk = (s0 / (nx * ny)) | 0;
      for (const d of [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1, k > 0 ? c - nx * ny : -1, k < nz - 1 ? c + nx * ny : -1]) {
        if (d < 0 || grid[d] !== 0) continue;
        const di = d % nx, dj = ((d / nx) | 0) % ny, dk = (d / (nx * ny)) | 0, dd = Math.hypot(di - si, dj - sj, dk - sk) * vox;
        if (dd <= CLOSE && dd < dd0[d] - 1e-6) { if (ss[d] < 0) sq[t++] = d; dd0[d] = dd; ss[d] = s0; }
      }
    }
    for (let c = 0; c < N; c++) if (grid[c] === 0 && ss[c] >= 0) grid[c] = 2;
  }
  // Distance to the nearest solid voxel (BFS carrying the nearest site; 6-connected, near-Euclidean).
  const site = new Int32Array(N).fill(-1), dist = new Float32Array(N).fill(1e9);
  qh = 0; qt = 0;
  for (let c = 0; c < N; c++) if (grid[c] !== 2) { site[c] = c; dist[c] = 0; q[qt++] = c; }
  const coords = (c) => [c % nx, ((c / nx) | 0) % ny, (c / (nx * ny)) | 0];
  while (qh < qt) {
    const c = q[qh++], [i, j, k] = coords(c), s = site[c], [si, sj, sk] = coords(s);
    const nb = [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1, k > 0 ? c - nx * ny : -1, k < nz - 1 ? c + nx * ny : -1];
    for (const d of nb) {
      if (d < 0) continue;
      const [di, dj, dk] = coords(d);
      const dd = Math.hypot(di - si, dj - sj, dk - sk) * vox;
      if (dd < dist[d] - 1e-6) { if (site[d] < 0) q[qt++] = d; dist[d] = dd; site[d] = s; }
    }
  }
  const solidAt = (p) => {
    const i = Math.floor((p[0] - lo[0]) / vox), j = Math.floor((p[1] - lo[1]) / vox), k = Math.floor((p[2] - lo[2]) / vox);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return false;
    return grid[i + nx * (j + ny * k)] !== 2;
  };
  const distAt = (p) => {
    const i = Math.floor((p[0] - lo[0]) / vox), j = Math.floor((p[1] - lo[1]) / vox), k = Math.floor((p[2] - lo[2]) / vox);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return 99;
    return dist[i + nx * (j + ny * k)];
  };
  return { vox, lo, nx, ny, nz, grid, dist, solidAt, distAt, meshLo, meshHi, triangles: tris.length / 9 };
}

function measure(V, parts, interior) {
  const { vox, lo, nx, ny, nz, grid, dist } = V;
  let solid = 0, covered = 0, outside = 0, inC = 0, maxP = 0, maxPart = '';
  const partMax = parts.map(() => 0);
  const pt = [0, 0, 0];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = i + nx * (j + ny * k);
    pt[0] = lo[0] + (i + 0.5) * vox; pt[1] = lo[1] + (j + 0.5) * vox; pt[2] = lo[2] + (k + 0.5) * vox;
    const s = grid[c] !== 2;
    let inside = false;
    for (let p = 0; p < parts.length; p++) {
      if (!partInside(pt, parts[p])) continue;
      inside = true;
      if (!s && dist[c] > partMax[p]) partMax[p] = dist[c];
    }
    if (s) solid++;
    if (inside) { inC++; if (s) covered++; else { outside++; if (dist[c] > maxP) maxP = dist[c]; } }
  }
  for (let p = 0; p < parts.length; p++) if (partMax[p] === maxP) maxPart = parts[p].name;
  let interiorOut = 0;
  for (const p of interior) if (!inCompound(p, parts)) interiorOut++;
  return { coverage: covered / Math.max(1, solid), solidVol: solid * vox ** 3, outsideVol: outside * vox ** 3, compoundVol: inC * vox ** 3, maxProtrusion: maxP, maxPart, partMax, interiorOut, interiorN: interior.length };
}

function interiorSamples(mod, id) {
  const def = mod.INTERIORS && mod.INTERIORS[id];
  if (!def) return [];
  const pts = [];
  for (const r of def.rooms) {
    const b = r.box, st = 0.25;
    for (let x = b.min.x; x <= b.max.x + 1e-9; x += Math.max(st, (b.max.x - b.min.x) / 8))
      for (let y = b.min.y; y <= b.max.y + 1e-9; y += Math.max(st, (b.max.y - b.min.y) / 4))
        for (let z = b.min.z; z <= b.max.z + 1e-9; z += Math.max(st, (b.max.z - b.min.z) / 8)) { const q = [x, y, z]; q.room = r.id; pts.push(q); }
  }
  return pts;
}

/** Gaps: distance from each uncovered hull-surface voxel (solid, next to outside) to the nearest compound voxel. */
function gaps(V, parts) {
  const { vox, lo, nx, ny, nz, grid } = V, N = nx * ny * nz, sxy = nx * ny;
  const inC = new Uint8Array(N), pt = [0, 0, 0];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    pt[0] = lo[0] + (i + 0.5) * vox; pt[1] = lo[1] + (j + 0.5) * vox; pt[2] = lo[2] + (k + 0.5) * vox;
    if (inCompound(pt, parts)) inC[i + nx * j + sxy * k] = 1;
  }
  // BFS from compound voxels carrying the nearest site (as for the protrusion distance).
  const site = new Int32Array(N).fill(-1), dist = new Float32Array(N).fill(1e9), q = new Int32Array(N);
  let qh = 0, qt = 0;
  for (let c = 0; c < N; c++) if (inC[c]) { site[c] = c; dist[c] = 0; q[qt++] = c; }
  const co = (c) => [c % nx, ((c / nx) | 0) % ny, (c / sxy) | 0];
  while (qh < qt) {
    const c = q[qh++], [i, j, k] = co(c), [si, sj, sk] = co(site[c]);
    const nb = [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1, k > 0 ? c - sxy : -1, k < nz - 1 ? c + sxy : -1];
    for (const d of nb) {
      if (d < 0) continue;
      const [di, dj, dk] = co(d), dd = Math.hypot(di - si, dj - sj, dk - sk) * vox;
      if (dd < dist[d] - 1e-6) { if (site[d] < 0) q[qt++] = d; dist[d] = dd; site[d] = site[c]; }
    }
  }
  let surf = 0, over = 0, worst = 0, at = [0, 0, 0];
  const cand = [];
  const GT = Number(opt('--gap-tol', '0.3'));
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const c = i + nx * j + sxy * k;
    if (grid[c] === 2) continue;
    if (grid[c - 1] !== 2 && grid[c + 1] !== 2 && grid[c - nx] !== 2 && grid[c + nx] !== 2 && grid[c - sxy] !== 2 && grid[c + sxy] !== 2) continue;
    surf++;
    const d = dist[c];
    if (d > GT) over++;
    if (d > worst) { worst = d; at = [lo[0] + (i + 0.5) * vox, lo[1] + (j + 0.5) * vox, lo[2] + (k + 0.5) * vox]; }
    if (d > GT) cand.push([d, lo[0] + (i + 0.5) * vox, lo[1] + (j + 0.5) * vox, lo[2] + (k + 0.5) * vox]);
  }
  // The worst places, at least 1.5 m apart.
  cand.sort((a, b) => b[0] - a[0]);
  const top = [];
  for (const c of cand) { if (top.length >= 10) break; if (top.every((t) => Math.hypot(t[1] - c[1], t[2] - c[2], t[3] - c[3]) > 1.5)) top.push(c); }
  return { worst, at, share: over / Math.max(1, surf), inC, top };
}

function ascii(V, inC) {
  const { vox, lo, nx, ny, nz, grid } = V, sxy = nx * ny, st = Math.max(1, Math.round(0.3 / vox));
  const ch = (h, c) => (h && c ? '@' : h ? '#' : c ? '+' : '.');
  console.log(`  top view (rows z from nose, columns x, cell ${(st * vox).toFixed(2)} m):`);
  for (let k = 0; k < nz; k += st) {
    let row = '';
    for (let i = 0; i < nx; i += st) {
      let h = false, c = false;
      for (let kk = k; kk < Math.min(nz, k + st); kk++) for (let ii = i; ii < Math.min(nx, i + st); ii++) for (let j = 0; j < ny; j++) {
        const v = ii + nx * j + sxy * kk; if (grid[v] !== 2) h = true; if (inC[v]) c = true;
      }
      row += ch(h, c);
    }
    console.log(`  ${(lo[2] + (k + 0.5 * st) * vox).toFixed(1).padStart(6)} ${row}`);
  }
  console.log('  side view (rows y from top, columns z from nose):');
  for (let j = ny - 1; j >= 0; j -= st) {
    let row = '';
    for (let k = 0; k < nz; k += st) {
      let h = false, c = false;
      for (let jj = Math.max(0, j - st + 1); jj <= j; jj++) for (let kk = k; kk < Math.min(nz, k + st); kk++) for (let i = 0; i < nx; i++) {
        const v = i + nx * jj + sxy * kk; if (grid[v] !== 2) h = true; if (inC[v]) c = true;
      }
      row += ch(h, c);
    }
    console.log(`  ${(lo[1] + (j + 0.5) * vox).toFixed(1).padStart(6)} ${row}`);
  }
}

function section(V, inC, z) {
  const { vox, lo, nx, ny, nz, grid } = V, sxy = nx * ny, k = Math.floor((z - lo[2]) / vox);
  if (k < 0 || k >= nz) return;
  console.log(`  section z ${z} (rows y from top, columns x, cell ${vox.toFixed(2)} m, x from ${lo[0].toFixed(2)}):`);
  for (let j = ny - 1; j >= 0; j--) {
    let row = '';
    for (let i = 0; i < nx; i++) { const v = i + nx * j + sxy * k, h = grid[v] !== 2, c = inC[v]; row += h && c ? '@' : h ? '#' : c ? '+' : '.'; }
    if (/[#@+]/.test(row)) console.log(`  ${(lo[1] + (j + 0.5) * vox).toFixed(2).padStart(6)} ${row}`);
  }
}

// ------------------------------------------------------------------------------------------------ fitting

/** Sample points on a part's surface patch (face `f` of a box, or the lateral surface of a round part) at offset `off`. */
function facePoints(p, f, off, vox) {
  const pts = [];
  if (p.kind === 'box') {
    const k = f >> 1, s = f & 1 ? -1 : 1, u = (k + 1) % 3, w = (k + 2) % 3;
    const nu = Math.max(1, Math.round((2 * p.h[u]) / vox)), nw = Math.max(1, Math.round((2 * p.h[w]) / vox));
    for (let a = 0; a < nu; a++) for (let b = 0; b < nw; b++) {
      const l = [0, 0, 0];
      l[k] = s * (p.h[k] + off); l[u] = -p.h[u] + ((a + 0.5) * 2 * p.h[u]) / nu; l[w] = -p.h[w] + ((b + 0.5) * 2 * p.h[w]) / nw;
      const r = p.q ? qrot(p.q, l[0], l[1], l[2]) : l;
      pts.push([p.c[0] + r[0], p.c[1] + r[1], p.c[2] + r[2]]);
    }
    return pts;
  }
  const a = p.kind === 'sphere' ? p.c : p.a, b = p.kind === 'sphere' ? p.c : p.b;
  const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2], L = Math.hypot(ex, ey, ez);
  const d = L > 1e-9 ? [ex / L, ey / L, ez / L] : [0, 0, 1];
  const t1 = Math.abs(d[0]) < 0.9 ? [0, -d[2], d[1]] : [d[2], 0, -d[0]];
  const tl = Math.hypot(...t1); t1[0] /= tl; t1[1] /= tl; t1[2] /= tl;
  const t2 = [d[1] * t1[2] - d[2] * t1[1], d[2] * t1[0] - d[0] * t1[2], d[0] * t1[1] - d[1] * t1[0]];
  const R = p.r + off, nA = Math.max(8, Math.round((2 * Math.PI * R) / vox)), nL = Math.max(1, Math.round(L / vox));
  for (let i = 0; i <= nL; i++) for (let j = 0; j < nA; j++) {
    const t = nL ? i / nL : 0, ang = (2 * Math.PI * j) / nA, c = Math.cos(ang) * R, s = Math.sin(ang) * R;
    pts.push([a[0] + ex * t + t1[0] * c + t2[0] * s, a[1] + ey * t + t1[1] * c + t2[1] * s, a[2] + ez * t + t1[2] * c + t2[2] * s]);
  }
  if (p.kind === 'sphere') for (const sg of [-1, 1]) for (let j = 0; j < nA; j++) {
    const ang = (2 * Math.PI * j) / nA, c = Math.cos(ang) * R * 0.7, s = Math.sin(ang) * R * 0.7;
    pts.push([a[0] + d[0] * sg * R * 0.7 + t1[0] * c + t2[0] * s, a[1] + d[1] * sg * R * 0.7 + t1[1] * c + t2[1] * s, a[2] + d[2] * sg * R * 0.7 + t1[2] * c + t2[2] * s]);
  }
  return pts;
}

function adjust(p, f, delta) {
  if (p.kind === 'box') {
    const k = f >> 1, s = f & 1 ? -1 : 1;
    if (p.h[k] + delta / 2 < 0.1) return false;
    p.h[k] += delta / 2;
    const l = [0, 0, 0]; l[k] = (s * delta) / 2;
    const r = p.q ? qrot(p.q, l[0], l[1], l[2]) : l;
    for (let i = 0; i < 3; i++) p.c[i] += r[i];
    return true;
  }
  if (p.r + delta < 0.1) return false;
  p.r += delta;
  return true;
}

function fitParts(V, parts, interior) {
  const vox = V.vox;
  let moves = 0;
  for (let pass = 0; pass < 3; pass++) {
    for (const p of parts) {
      const others = parts.filter((o) => o !== p);
      const faces = p.kind === 'box' ? 6 : 1;
      for (let f = 0; f < faces; f++) {
        for (let step = 0; step < 80; step++) {
          // 1. A slab just inside the face that sticks out more than the tolerance: pull the face in.
          const inn = facePoints(p, f, -vox / 2, vox);
          if (Math.max(...inn.map((q) => V.distAt(q))) > TOL) {
            const before = interior.filter((q) => partInside(q, p));
            if (!adjust(p, f, -vox)) break;
            if (before.some((q) => !inCompound(q, parts))) { adjust(p, f, vox); break; }
            moves++;
            continue;
          }
          // 2. A slab just outside that is mostly hull, close to the hull everywhere, and not already covered: push out.
          const out = facePoints(p, f, vox / 2, vox);
          let sol = 0, fresh = 0, far = 0;
          for (const q of out) {
            if (V.distAt(q) > TOL) far++;
            if (!V.solidAt(q)) continue;
            sol++;
            if (!inCompound(q, others)) fresh++;
          }
          if (far === 0 && sol >= 0.5 * out.length && fresh >= 0.25 * sol) { if (!adjust(p, f, vox)) break; moves++; continue; }
          break;
        }
      }
    }
  }
  return moves;
}

/**
 * Decompose the hull volume into axis-aligned boxes. Each round: the depth of every uncovered hull voxel inside the
 * uncovered volume is recomputed, boxes are grown from the deepest few seeds (spread apart), and the one that
 * covers the most uncovered hull is kept. So the core goes first, then wings, fins and pods (their own depth).
 */
function seedBoxes(V, id, maxParts) {
  const { nx, ny, nz, grid, dist, vox, lo } = V, N = nx * ny * nz, sxy = nx * ny;
  const depth = new Int32Array(N), q = new Int32Array(N), covered = new Uint8Array(N);
  let solidN = 0;
  for (let c = 0; c < N; c++) if (grid[c] !== 2) solidN++;
  const dims = [nx, ny, nz];
  const grow = (seed) => {
    const b = [seed % nx, ((seed / nx) | 0) % ny, (seed / sxy) | 0];
    const B = [b[0], b[0], b[1], b[1], b[2], b[2]]; // i0 i1 j0 j1 k0 k1
    let grew = true;
    while (grew) {
      grew = false;
      for (let f = 0; f < 6; f++) {
        const ax = f >> 1, hiSide = f & 1, nv = hiSide ? B[2 * ax + 1] + 1 : B[2 * ax] - 1;
        if (nv < 0 || nv >= dims[ax]) continue;
        const r = B.slice(); r[2 * ax] = r[2 * ax + 1] = nv;
        let tot = 0, sol = 0, fresh = 0, far = 0;
        for (let k = r[4]; k <= r[5] && far === 0; k++) for (let j = r[2]; j <= r[3]; j++) for (let i = r[0]; i <= r[1]; i++) {
          const c = i + nx * j + sxy * k;
          tot++;
          if (grid[c] !== 2) { sol++; if (!covered[c]) fresh++; } else if (dist[c] > TOL) far++;
        }
        if (far === 0 && sol >= 0.5 * tot && fresh >= 0.25 * sol) { B[2 * ax + hiSide] = nv; grew = true; }
      }
    }
    let fresh = 0;
    for (let k = B[4]; k <= B[5]; k++) for (let j = B[2]; j <= B[3]; j++) for (let i = B[0]; i <= B[1]; i++) {
      const c = i + nx * j + sxy * k;
      if (grid[c] !== 2 && !covered[c]) fresh++;
    }
    return { B, fresh };
  };
  const parts = [];
  for (let iter = 0; iter < 3 * maxParts && parts.length < maxParts; iter++) {
    let qh = 0, qt = 0, left = 0;
    for (let c = 0; c < N; c++) {
      if (grid[c] === 2 || covered[c]) { q[qt++] = c; depth[c] = 0; } else { depth[c] = -1; left++; }
    }
    if (left < 0.01 * solidN) break;
    while (qh < qt) {
      const c = q[qh++], i = c % nx, j = ((c / nx) | 0) % ny, k = (c / sxy) | 0;
      if (i > 0 && depth[c - 1] < 0) { depth[c - 1] = depth[c] + 1; q[qt++] = c - 1; }
      if (i < nx - 1 && depth[c + 1] < 0) { depth[c + 1] = depth[c] + 1; q[qt++] = c + 1; }
      if (j > 0 && depth[c - nx] < 0) { depth[c - nx] = depth[c] + 1; q[qt++] = c - nx; }
      if (j < ny - 1 && depth[c + nx] < 0) { depth[c + nx] = depth[c] + 1; q[qt++] = c + nx; }
      if (k > 0 && depth[c - sxy] < 0) { depth[c - sxy] = depth[c] + 1; q[qt++] = c - sxy; }
      if (k < nz - 1 && depth[c + sxy] < 0) { depth[c + sxy] = depth[c] + 1; q[qt++] = c + sxy; }
    }
    // The deepest voxels come last in BFS order: walk back and take up to 8 seeds at least 1.5 m apart.
    const seeds = [], gap = Math.ceil(1.5 / vox);
    for (let n = qt - 1; n >= 0 && seeds.length < 8; n--) {
      const c = q[n];
      if (grid[c] === 2 || covered[c]) continue;
      const i = c % nx, j = ((c / nx) | 0) % ny, k = (c / sxy) | 0;
      if (seeds.some((s) => Math.abs(s[0] - i) < gap && Math.abs(s[1] - j) < gap && Math.abs(s[2] - k) < gap)) continue;
      seeds.push([i, j, k, c]);
    }
    let best = null;
    for (const s of seeds) { const g = grow(s[3]); if (!best || g.fresh > best.fresh) best = g; }
    if (!best) break;
    const B = best.B;
    for (let k = B[4]; k <= B[5]; k++) for (let j = B[2]; j <= B[3]; j++) for (let i = B[0]; i <= B[1]; i++) covered[i + nx * j + sxy * k] = 1;
    if (best.fresh < 27) continue;
    const c = [0, 1, 2].map((a) => lo[a] + ((B[2 * a] + B[2 * a + 1] + 1) / 2) * vox);
    const h = [0, 1, 2].map((a) => ((B[2 * a + 1] - B[2 * a] + 1) * vox) / 2);
    parts.push({ name: `${id}-${parts.length + 1}`, kind: 'box', c, h });
  }
  return parts;
}

// ------------------------------------------------------------------------------------------------ output

const r4 = (v) => Math.round(v * 1e4) / 1e4 + 0; // + 0 turns -0 into 0
const vec = (a) => `[${a.map(r4).join(', ')}]`;
function partLine(p) {
  if (p.kind === 'box') return `{ name: '${p.name}', kind: 'box', c: ${vec(p.c)}, h: ${vec(p.h)}${p.q ? `, q: ${vec(p.q)}` : ''} }`;
  if (p.kind === 'capsule') return `{ name: '${p.name}', kind: 'capsule', a: ${vec(p.a)}, b: ${vec(p.b)}, r: ${r4(p.r)} }`;
  return `{ name: '${p.name}', kind: 'sphere', c: ${vec(p.c)}, r: ${r4(p.r)} }`;
}

async function writeFile(all) {
  const src = await fs.readFile(OUT_FILE, 'utf8');
  const at = src.indexOf('export const HULL_COLLIDERS');
  const head = at > 0 ? src.slice(0, at) : src;
  let body = 'export const HULL_COLLIDERS: Record<ShipVisualId, HullPartDef[]> = {\n';
  for (const [id, parts] of Object.entries(all)) body += `  ${id}: [\n${parts.map((p) => `    ${partLine(p)},\n`).join('')}  ],\n`;
  body += '};\n';
  await fs.writeFile(OUT_FILE, head + body);
}

// ------------------------------------------------------------------------------------------------ main

const mod = await load();
const all = JSON.parse(JSON.stringify(mod.HULL_COLLIDERS));
const want = argv.filter((_, i) => argv[i - 1] === '--hull').flatMap((s) => s.split(','));
const ids = want.length ? want : Object.keys(all);
let worst = 0;
const skip = new Set();
for (const id of ids) {
  const parts = all[id];
  if (!parts) { console.log(`${id}: no compound`); continue; }
  const V = voxelise(mod, id, parts);
  const interior = interiorSamples(mod, id);
  const f = (v) => v.toFixed(2);
  console.log(`\n${id}: mesh ${V.triangles} tris, bounds x ${f(V.meshLo[0])}..${f(V.meshHi[0])} y ${f(V.meshLo[1])}..${f(V.meshHi[1])} z ${f(V.meshLo[2])}..${f(V.meshHi[2])}, voxel ${V.vox.toFixed(3)} m, ${parts.length} parts`);
  if (has('--slices')) {
    for (let z = Math.floor(V.meshLo[2]); z < V.meshHi[2]; z += 1) {
      let x0 = 99, x1 = -99, y0 = 99, y1 = -99, xc0 = 99, xc1 = -99;
      for (let x = V.meshLo[0]; x <= V.meshHi[0]; x += V.vox) for (let y = V.meshLo[1]; y <= V.meshHi[1]; y += V.vox) {
        if (!V.solidAt([x, y, z + 0.5])) continue;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        if (Math.abs(y) < 0.3) { xc0 = Math.min(xc0, x); xc1 = Math.max(xc1, x); }
      }
      // centreline height profile
      let h0 = 99, h1 = -99;
      for (let y = V.meshLo[1]; y <= V.meshHi[1]; y += V.vox) if (V.solidAt([0, y, z + 0.5])) { h0 = Math.min(h0, y); h1 = Math.max(h1, y); }
      console.log(`  z ${String(z + 0.5).padStart(6)}: x ${f(x0)}..${f(x1)}  y ${f(y0)}..${f(y1)}  centreline y ${f(h0)}..${f(h1)}  at y=0 x ${f(xc0)}..${f(xc1)}`);
    }
  }
  const L = mod.SHIP_LAYOUTS[id], ext = [V.meshHi[0] - V.meshLo[0], V.meshHi[1] - V.meshLo[1], V.meshHi[2] - V.meshLo[2]];
  const off = L ? Math.max(Math.abs(ext[0] / L.width - 1), Math.abs(ext[1] / L.height - 1), Math.abs(ext[2] / L.length - 1)) : 0;
  if (off > 0.1) {
    console.log(`  WARNING: mesh ${ext.map((v) => v.toFixed(1)).join(' x ')} m differs from the layout ${L.width} x ${L.height} x ${L.length} m by ${(off * 100).toFixed(0)}% — exterior not rebuilt yet?${has('--force') ? '' : ' (not fitted or written; --force to override)'}`);
    if (!has('--force')) { skip.add(id); }
  }
  if (has('--seed') && !skip.has(id)) {
    // Engine bells are open shells (no volume to fill): one capsule per nozzle from the layout, ending at the exit plane.
    const eng = (L ? L.engines : []).map((e, i) => ({ name: `engine-${i + 1}`, kind: 'capsule', a: [e.pos.x, e.pos.y, e.pos.z - 2 * e.radius], b: [e.pos.x, e.pos.y, e.pos.z - 0.95 * e.radius], r: 0.95 * e.radius }));
    const seeded = seedBoxes(V, id, Number(opt('--max-parts', '16')) - eng.length);
    parts.length = 0;
    parts.push(...seeded, ...eng);
  }
  let m = measure(V, parts, interior);
  const show = (tag, m) => console.log(`  ${tag}: coverage ${(m.coverage * 100).toFixed(1)}% of ${m.solidVol.toFixed(0)} m3, outside hull ${m.outsideVol.toFixed(1)} m3, max protrusion ${m.maxProtrusion.toFixed(2)} m (${m.maxPart})${m.interiorN ? `, interior samples outside ${m.interiorOut}/${m.interiorN}` : ''}`);
  show('check', m);
  { const cl = [Infinity, Infinity, Infinity], ch = [-Infinity, -Infinity, -Infinity]; for (const p of parts) { const [a, b] = partBounds(p); for (let k = 0; k < 3; k++) { cl[k] = Math.min(cl[k], a[k]); ch[k] = Math.max(ch[k], b[k]); } }
    console.log(`  compound bounds x ${f(cl[0])}..${f(ch[0])} y ${f(cl[1])}..${f(ch[1])} z ${f(cl[2])}..${f(ch[2])}`); }
  if (has('--fit') && !skip.has(id)) {
    const moves = fitParts(V, parts, interior);
    m = measure(V, parts, interior);
    show(`fit (${moves} moves)`, m);
  }
  if (has('--gaps') || has('--ascii')) {
    const g = gaps(V, parts);
    console.log(`  gaps: worst ${g.worst.toFixed(2)} m at (${g.at.map((v) => v.toFixed(2)).join(', ')}), ${(g.share * 100).toFixed(1)}% of the hull surface farther than ${opt('--gap-tol', '0.3')} m from the compound`);
    for (const t of g.top) console.log(`    gap ${t[0].toFixed(2)} m at (${t[1].toFixed(2)}, ${t[2].toFixed(2)}, ${t[3].toFixed(2)})`);
    if (m.interiorOut) {
      const out = interior.filter((q) => !inCompound(q, parts)), b0 = [0, 1, 2].map((k) => Math.min(...out.map((q) => q[k]))), b1 = [0, 1, 2].map((k) => Math.max(...out.map((q) => q[k])));
      const byRoom = {};
      for (const q of out) { const b = (byRoom[q.room] ??= [[1e9, 1e9, 1e9], [-1e9, -1e9, -1e9], 0]); for (let k = 0; k < 3; k++) { b[0][k] = Math.min(b[0][k], q[k]); b[1][k] = Math.max(b[1][k], q[k]); } b[2]++; }
      for (const [rid, b] of Object.entries(byRoom)) console.log(`    room ${rid}: ${b[2]} samples outside, x ${b[0][0].toFixed(2)}..${b[1][0].toFixed(2)} y ${b[0][1].toFixed(2)}..${b[1][1].toFixed(2)} z ${b[0][2].toFixed(2)}..${b[1][2].toFixed(2)}`);
      console.log(`    interior samples outside within x ${b0[0].toFixed(2)}..${b1[0].toFixed(2)} y ${b0[1].toFixed(2)}..${b1[1].toFixed(2)} z ${b0[2].toFixed(2)}..${b1[2].toFixed(2)}`);
    }
    if (has('--ascii')) ascii(V, g.inC);
    for (const zs of opt('--section', '').split(',').filter(Boolean)) section(V, g.inC, Number(zs));
  }
  if (has('--parts')) parts.forEach((p, i) => console.log(`    ${p.name.padEnd(14)} protrusion ${m.partMax[i].toFixed(2)} m  ${partLine(p)}`));
  worst = Math.max(worst, m.maxProtrusion);
}
if (has('--write')) { for (const id of skip) all[id] = mod.HULL_COLLIDERS[id]; await writeFile(all); console.log(`\nwrote ${path.relative(root, OUT_FILE)}`); }
console.log(`\nworst protrusion ${worst.toFixed(2)} m (tolerance ${TOL} m)`);
