#!/usr/bin/env node
// Bake the Wren interior's lightmaps (build time, deterministic) into src/render/space/interior.bake.ts.
//
//   node tools/bake-interior.mjs            bake now
//   node tools/bake-interior.mjs --if-stale bake only when an input is newer than the output
//   (build.mjs calls bakeIfStale() before every build, so `npm run build` re-bakes when the interior changes)
//
// The geometry, the lightmap charts and the light sources come from buildInterior() in
// src/render/space/interior.ts (bundled for node with esbuild), so the UVs are the ones the game builds.
// Per texel: direct light from every emitter of the rooms around it (line, rect and spot sources, stratified
// samples, shadow rays against a BVH of the opaque interior), then one diffuse bounce (cosine-weighted rays,
// the hit's albedo times its direct light), a small multi-bounce allowance, and a blur of the indirect term
// inside each chart. Three light groups (cabin, always-on, emergency) combine into two variants, "lights on"
// and "lights off", stored as RGBM (range 8), row-delta filtered and deflated, base64 in the .ts module.

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { existsSync, readFileSync, statSync, promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RANGE = 8;
const BOUNCE_RAYS = 36;
const MULTI = 1.45;
const EXPOSE = 1.0;

// =============================================================================================== ray casting
function buildBVH(pos) {
  // pos: Float32Array of triangles (9 floats each, raw vertices). Returns order + nodes.
  const n = pos.length / 9;
  const cen = new Float32Array(n * 3);
  const bmin = new Float32Array(n * 3);
  const bmax = new Float32Array(n * 3);
  for (let i = 0; i < n; i++)
    for (let a = 0; a < 3; a++) {
      const x0 = pos[i * 9 + a], x1 = pos[i * 9 + 3 + a], x2 = pos[i * 9 + 6 + a];
      bmin[i * 3 + a] = Math.min(x0, x1, x2);
      bmax[i * 3 + a] = Math.max(x0, x1, x2);
      cen[i * 3 + a] = (x0 + x1 + x2) / 3;
    }
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const B = [];
  const M = [];
  function node(lo, hi) {
    const id = M.length / 2;
    M.push(0, 0);
    const mn = [1e9, 1e9, 1e9];
    const mx = [-1e9, -1e9, -1e9];
    const cmn = [1e9, 1e9, 1e9];
    const cmx = [-1e9, -1e9, -1e9];
    for (let k = lo; k < hi; k++) {
      const i = order[k];
      for (let a = 0; a < 3; a++) {
        mn[a] = Math.min(mn[a], bmin[i * 3 + a]);
        mx[a] = Math.max(mx[a], bmax[i * 3 + a]);
        cmn[a] = Math.min(cmn[a], cen[i * 3 + a]);
        cmx[a] = Math.max(cmx[a], cen[i * 3 + a]);
      }
    }
    B.push(mn[0] - 1e-5, mn[1] - 1e-5, mn[2] - 1e-5, mx[0] + 1e-5, mx[1] + 1e-5, mx[2] + 1e-5);
    if (hi - lo <= 4) {
      M[id * 2] = lo;
      M[id * 2 + 1] = hi - lo;
      return id;
    }
    let ax = 0;
    for (let a = 1; a < 3; a++) if (cmx[a] - cmn[a] > cmx[ax] - cmn[ax]) ax = a;
    const mid = (lo + hi) >> 1;
    // nth_element by centroid on ax (simple sort of the range)
    const sub = Array.from(order.subarray(lo, hi)).sort((p, q) => cen[p * 3 + ax] - cen[q * 3 + ax] || p - q);
    order.set(sub, lo);
    node(lo, mid);
    const right = node(mid, hi);
    M[id * 2] = right; // interior: [rightChild, 0]; left child is id + 1
    M[id * 2 + 1] = 0;
    return id;
  }
  node(0, n);
  return { order, nodeB: new Float32Array(B), nodeM: new Int32Array(M) };
}

// fixed traversal for interior nodes: left = n + 1, right = nodeM[n*2]
function makeTracer2(d) {
  const { tri, nodeB, nodeM } = d;
  const stack = new Int32Array(256);
  const out = { t: 0, u: 0, v: 0, id: -1 };
  return function trace(ox, oy, oz, dx, dy, dz, tmax, any) {
    const ix = 1 / (Math.abs(dx) < 1e-12 ? 1e-12 : dx);
    const iy = 1 / (Math.abs(dy) < 1e-12 ? 1e-12 : dy);
    const iz = 1 / (Math.abs(dz) < 1e-12 ? 1e-12 : dz);
    let sp = 0;
    stack[sp++] = 0;
    let best = -1;
    let bu = 0;
    let bv = 0;
    while (sp > 0) {
      const n = stack[--sp];
      const b = n * 6;
      let t0 = (nodeB[b] - ox) * ix;
      let t1 = (nodeB[b + 3] - ox) * ix;
      if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
      let a0 = (nodeB[b + 1] - oy) * iy;
      let a1 = (nodeB[b + 4] - oy) * iy;
      if (a0 > a1) { const s = a0; a0 = a1; a1 = s; }
      if (a0 > t0) t0 = a0;
      if (a1 < t1) t1 = a1;
      a0 = (nodeB[b + 2] - oz) * iz;
      a1 = (nodeB[b + 5] - oz) * iz;
      if (a0 > a1) { const s = a0; a0 = a1; a1 = s; }
      if (a0 > t0) t0 = a0;
      if (a1 < t1) t1 = a1;
      if (t1 < 0 || t0 > t1 || t0 > tmax) continue;
      const cnt = nodeM[n * 2 + 1];
      if (cnt > 0) {
        const first = nodeM[n * 2];
        for (let k = first; k < first + cnt; k++) {
          const o = k * 9;
          const e1x = tri[o + 3], e1y = tri[o + 4], e1z = tri[o + 5];
          const e2x = tri[o + 6], e2y = tri[o + 7], e2z = tri[o + 8];
          const px = dy * e2z - dz * e2y;
          const py = dz * e2x - dx * e2z;
          const pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (det > -1e-14 && det < 1e-14) continue;
          const inv = 1 / det;
          const sx = ox - tri[o], sy = oy - tri[o + 1], sz = oz - tri[o + 2];
          const u = (sx * px + sy * py + sz * pz) * inv;
          if (u < 0 || u > 1) continue;
          const qx = sy * e1z - sz * e1y;
          const qy = sz * e1x - sx * e1z;
          const qz = sx * e1y - sy * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * inv;
          if (v < 0 || u + v > 1) continue;
          const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (t > 1e-5 && t < tmax) {
            tmax = t;
            best = k;
            bu = u;
            bv = v;
            if (any) {
              out.id = k;
              return out;
            }
          }
        }
      } else {
        stack[sp++] = nodeM[n * 2];
        stack[sp++] = n + 1;
      }
    }
    out.id = best;
    out.t = tmax;
    out.u = bu;
    out.v = bv;
    return out;
  };
}

const hash = (i, s) => {
  let h = (Math.imul(i, 374761393) + Math.imul(s, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};

// =============================================================================================== worker
function workerMain() {
  const d = workerData;
  const trace = makeTracer2(d);
  const { samp, nsamp, em, nem, emRoom, rooms, nrooms, tnor, tuv, talb, W, H } = d;
  const EMF = 19;
  parentPort.on('message', (msg) => {
    const { pass, from, to } = msg;
    const out = pass === 1 ? d.direct : d.indirect;
    for (let s = from; s < to; s++) {
      const o = s * 8;
      const nx = samp[o + 3], ny = samp[o + 4], nz = samp[o + 5];
      const px = samp[o] + nx * 0.004, py = samp[o + 1] + ny * 0.004, pz = samp[o + 2] + nz * 0.004;
      const ti = samp[o + 6] | 0;
      const acc = new Float64Array(9);
      if (pass === 2 && samp[o + 7] > 0) continue;
      if (pass === 1) {
        let mask = 0;
        for (let r = 0; r < nrooms; r++) {
          const b = r * 6;
          if (px > rooms[b] - 0.5 && px < rooms[b + 3] + 0.5 && py > rooms[b + 1] - 0.6 && py < rooms[b + 4] + 0.7 && pz > rooms[b + 2] - 0.5 && pz < rooms[b + 5] + 0.5) mask |= 1 << r;
        }
        for (let e = 0; e < nem; e++) {
          if (!(mask & (1 << emRoom[e]))) continue;
          const q = e * EMF;
          const type = em[q];
          const grp = em[q + 1] | 0;
          const ex = em[q + 2], ey = em[q + 3], ez = em[q + 4];
          const ax = em[q + 5], ay = em[q + 6], az = em[q + 7];
          const bx = em[q + 8], by = em[q + 9], bz = em[q + 10];
          const enx = em[q + 11], eny = em[q + 12], enz = em[q + 13];
          const cr = em[q + 14], cg = em[q + 15], cb = em[q + 16];
          const k = em[q + 17];
          const cone = em[q + 18];
          if (k <= 0) continue;
          let K = 1;
          let dl = 1;
          let lx = 0, ly = 0, lz = 0;
          if (type === 0) {
            lx = ax - ex; ly = ay - ey; lz = az - ez;
            const L = Math.hypot(lx, ly, lz);
            const mx = (ax + ex) / 2 - px, my = (ay + ey) / 2 - py, mz = (az + ez) / 2 - pz;
            const dist = Math.max(0.2, Math.hypot(mx, my, mz) - L / 2);
            K = Math.max(2, Math.min(14, Math.ceil(L / (0.45 * dist))));
            dl = L / K;
          } else if (type === 1) {
            K = 4;
            dl = (4 * Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz)) / K;
          }
          let vis = 0;
          let tot = 0;
          const contrib = [];
          for (let j = 0; j < K; j++) {
            const r1 = 0.25 + 0.5 * hash(j, e * 7 + 1);
            const r2 = 0.25 + 0.5 * hash(j, e * 13 + 5);
            let qx, qy, qz;
            if (type === 0) {
              const t = (j + r1) / K;
              qx = ex + lx * t; qy = ey + ly * t; qz = ez + lz * t;
            } else if (type === 1) {
              const u = ((j & 1) + r1) / 2 * 2 - 1;
              const v = ((j >> 1) + r2) / 2 * 2 - 1;
              qx = ex + ax * u + bx * v; qy = ey + ay * u + by * v; qz = ez + az * u + bz * v;
            } else {
              qx = ex + (r1 - 0.5) * 0.03; qy = ey; qz = ez + (r2 - 0.5) * 0.03;
            }
            let dx = qx - px, dy = qy - py, dz = qz - pz;
            const r2d = dx * dx + dy * dy + dz * dz;
            const rr = Math.sqrt(r2d);
            dx /= rr; dy /= rr; dz /= rr;
            const cR = dx * nx + dy * ny + dz * nz;
            if (cR <= 0) continue;
            const cE = -(dx * enx + dy * eny + dz * enz);
            let w;
            if (type === 2) {
              if (cE <= cone) continue;
              const f = Math.min(1, (cE - cone) / ((1 - cone) * 0.35 + 1e-3));
              w = (k * cR * f * f) / Math.max(r2d, 0.04);
            } else {
              if (cE <= 0) continue;
              w = (k * cR * cE * dl) / (Math.max(r2d, 0.0025) * Math.PI);
            }
            contrib.push(w, dx, dy, dz, rr);
            tot += w;
          }
          if (tot <= 0) continue;
          let tested = 0;
          let testedW = 0;
          let skippedW = 0;
          for (let j = 0; j < contrib.length; j += 5) {
            const w = contrib[j];
            if (w < tot * 0.04 && contrib.length > 10) {
              skippedW += w;
              continue;
            }
            tested++;
            testedW += w;
            const h = trace(px, py, pz, contrib[j + 1], contrib[j + 2], contrib[j + 3], contrib[j + 4] - 0.02, true);
            if (h.id < 0) vis += w;
          }
          const val = vis + (testedW > 0 ? (skippedW * vis) / testedW : 0);
          void tested;
          acc[grp * 3] += val * cr;
          acc[grp * 3 + 1] += val * cg;
          acc[grp * 3 + 2] += val * cb;
        }
      } else {
        // one bounce: cosine-weighted rays, hit albedo x direct light at the hit
        let tx, ty, tz;
        if (Math.abs(nx) < 0.9) { tx = 0; ty = -nz; tz = ny; } else { tx = nz; ty = 0; tz = -nx; }
        const tl = Math.hypot(tx, ty, tz);
        tx /= tl; ty /= tl; tz /= tl;
        const bxx = ny * tz - nz * ty, byy = nz * tx - nx * tz, bzz = nx * ty - ny * tx;
        const rot = hash(s, 99);
        const dir = d.direct;
        for (let j = 0; j < BOUNCE_RAYS; j++) {
          const u1 = (j + hash(s, j * 3 + 1)) / BOUNCE_RAYS;
          const u2 = (j * 0.618034 + rot) % 1;
          const r = Math.sqrt(u1);
          const ph = 2 * Math.PI * u2;
          const lx = r * Math.cos(ph), ly = r * Math.sin(ph), lz = Math.sqrt(Math.max(0, 1 - u1));
          const dx = tx * lx + bxx * ly + nx * lz;
          const dy = ty * lx + byy * ly + ny * lz;
          const dz = tz * lx + bzz * ly + nz * lz;
          const h = trace(px, py, pz, dx, dy, dz, 30, false);
          if (h.id < 0) continue;
          const t = h.id;
          if (tnor[t * 3] * dx + tnor[t * 3 + 1] * dy + tnor[t * 3 + 2] * dz > 0) continue; // back face: dark
          const w0 = 1 - h.u - h.v;
          const uu = (tuv[t * 6] * w0 + tuv[t * 6 + 2] * h.u + tuv[t * 6 + 4] * h.v) * W - 0.5;
          const vv = (tuv[t * 6 + 1] * w0 + tuv[t * 6 + 3] * h.u + tuv[t * 6 + 5] * h.v) * H - 0.5;
          const x0 = Math.max(0, Math.min(W - 2, Math.floor(uu)));
          const y0 = Math.max(0, Math.min(H - 2, Math.floor(vv)));
          const fx = Math.max(0, Math.min(1, uu - x0));
          const fy = Math.max(0, Math.min(1, vv - y0));
          const ar = talb[t * 3], ag = talb[t * 3 + 1], ab = talb[t * 3 + 2];
          if (ar + ag + ab <= 0) continue;
          for (let c = 0; c < 9; c++) {
            const i00 = (y0 * W + x0) * 9 + c;
            const i10 = i00 + 9;
            const i01 = i00 + W * 9;
            const i11 = i01 + 9;
            const val = (dir[i00] * (1 - fx) + dir[i10] * fx) * (1 - fy) + (dir[i01] * (1 - fx) + dir[i11] * fx) * fy;
            acc[c] += val * (c % 3 === 0 ? ar : c % 3 === 1 ? ag : ab);
          }
        }
        for (let c = 0; c < 9; c++) acc[c] /= BOUNCE_RAYS;
      }
      for (let c = 0; c < 9; c++) out[ti * 9 + c] = acc[c];
    }
    parentPort.postMessage({ done: true });
  });
}

if (!isMainThread) workerMain();

// =============================================================================================== main
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'src/render/space/interior.bake.ts');
const INPUTS = ['src/render/space/interior.ts', 'src/render/space/surfaces.ts', 'src/data/interiors.ts', 'tools/bake-interior.mjs'].map((p) => path.join(root, p));

export function bakeIsStale() {
  if (!existsSync(OUT)) return true;
  const t = statSync(OUT).mtimeMs;
  return INPUTS.some((p) => existsSync(p) && statSync(p).mtimeMs > t);
}

export async function bakeIfStale() {
  if (bakeIsStale()) {
    await bakeInterior();
    return true;
  }
  // file times can lie (a checkout, a copy, an edit inside the same second): the geometry key decides
  let have = '';
  try {
    have = (readFileSync(OUT, 'utf8').match(/key: '([0-9a-f]*)'/) || [])[1] || '';
  } catch {
    have = '';
  }
  const mod = await loadInteriorModule();
  if (mod.buildInterior(mod.INTERIORS.wren).key === have) return false;
  console.log(`interior bake: key changed (${have || 'none'}), re-baking`);
  await bakeInterior(mod);
  return true;
}

async function loadInteriorModule() {
  const { build } = await import('esbuild');
  const tmp = path.join(os.tmpdir(), `tidelock-bake-${process.pid}-${Date.now()}.mjs`);
  await build({
    stdin: {
      contents: "export { buildInterior } from './src/render/space/interior'; export { INTERIORS } from './src/data/interiors'; export { TILE_ALBEDO, TILE_IDS } from './src/render/space/surfaces';",
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: tmp,
    logLevel: 'error',
    define: { __DEV__: 'false' },
  });
  const mod = await import(pathToFileURL(tmp).href);
  await fs.unlink(tmp).catch(() => {});
  return mod;
}

function sharedF32(n) {
  return new Float32Array(new SharedArrayBuffer(n * 4));
}

export async function bakeInterior(loaded) {
  const t0 = Date.now();
  const mod = loaded ?? (await loadInteriorModule());
  const B = mod.buildInterior(mod.INTERIORS.wren);
  const W = B.lmW;
  const H = B.lmH;
  // ---- occluder triangles (opaque + glow) ----
  const raw = [];
  const uvs = [];
  const alb = [];
  for (const bk of B.buckets) {
    if (bk.kind !== 'main' && bk.kind !== 'glow') continue;
    for (let i = 0; i < bk.idx.length; i += 3) {
      let ar = 0, ag = 0, ab = 0;
      for (let k = 0; k < 3; k++) {
        const v = bk.idx[i + k];
        raw.push(bk.pos[v * 3], bk.pos[v * 3 + 1], bk.pos[v * 3 + 2]);
        uvs.push(bk.uv1[v * 2], bk.uv1[v * 2 + 1]);
        const ta = mod.TILE_ALBEDO[mod.TILE_IDS[bk.tile[v] % 16]];
        ar += (ta[0] * bk.col[v * 3]) / 3;
        ag += (ta[1] * bk.col[v * 3 + 1]) / 3;
        ab += (ta[2] * bk.col[v * 3 + 2]) / 3;
      }
      if (bk.kind === 'glow') ar = ag = ab = 0;
      alb.push(Math.min(0.85, ar), Math.min(0.85, ag), Math.min(0.85, ab));
    }
  }
  const nt = raw.length / 9;
  const { order, nodeB, nodeM } = buildBVH(new Float32Array(raw));
  const tri = sharedF32(nt * 9);
  const tnor = sharedF32(nt * 3);
  const tuv = sharedF32(nt * 6);
  const talb = sharedF32(nt * 3);
  for (let k = 0; k < nt; k++) {
    const i = order[k];
    const o = i * 9;
    const v0 = [raw[o], raw[o + 1], raw[o + 2]];
    const e1 = [raw[o + 3] - v0[0], raw[o + 4] - v0[1], raw[o + 5] - v0[2]];
    const e2 = [raw[o + 6] - v0[0], raw[o + 7] - v0[1], raw[o + 8] - v0[2]];
    tri.set([...v0, ...e1, ...e2], k * 9);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(...n) || 1;
    tnor.set([n[0] / l, n[1] / l, n[2] / l], k * 3);
    tuv.set(uvs.slice(i * 6, i * 6 + 6), k * 6);
    talb.set(alb.slice(i * 3, i * 3 + 3), k * 3);
  }
  const nodeBs = sharedF32(nodeB.length);
  nodeBs.set(nodeB);
  const nodeMs = new Int32Array(new SharedArrayBuffer(nodeM.length * 4));
  nodeMs.set(nodeM);
  // ---- texel samples ----
  const S = [];
  const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const owner = new Int32Array(W * H).fill(-1);
  B.charts.forEach((c, ci) => {
    for (let j = 0; j < c.h; j++)
      for (let i = 0; i < c.w; i++) {
        const ti = (c.y + j) * W + c.x + i;
        owner[ti] = ci;
        let p, n;
        if (c.t === 0) {
          let s = (i - 1) / c.dd;
          let t = (j - 1) / c.dd;
          [s, t] = clampPoly(c.poly, s, t);
          p = add3(add3(c.o, mul3(c.U, s)), mul3(c.V, t));
          n = c.N;
        } else if (c.t === 1) {
          const k = Math.min(5, Math.floor(i / 2));
          n = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]][k];
          const ext = c.e[k >> 1];
          p = add3(c.c, mul3(n, ext + 0.01));
        } else {
          const s = Math.max(0, Math.min(c.len, (i - 1) / c.dd));
          const th = Math.max(0, Math.min(4, j - 1)) * (Math.PI / 2);
          n = add3(mul3(c.p1, Math.cos(th)), mul3(c.p2, Math.sin(th)));
          p = add3(add3(c.a, mul3(c.d, s)), mul3(n, c.r + 0.01));
        }
        const skip = c.t === 0 && c.w > 4 && c.h > 4 && (i % 2 === 1 || j % 2 === 1) && i < c.w - 1 && j < c.h - 1 ? 1 : 0;
        S.push(p[0], p[1], p[2], n[0], n[1], n[2], ti, skip);
      }
  });
  const nsamp = S.length / 8;
  const st = [0, 0, 0], sn = [0, 0, 0];
  for (const c of B.charts) { st[c.t] += c.w * c.h; sn[c.t]++; }
  console.log(`charts: faces ${sn[0]} (${st[0]} texels), parts ${sn[1]} (${st[1]}), strips ${sn[2]} (${st[2]}); atlas ${W}x${H}`);
  const samp = sharedF32(S.length);
  samp.set(S);
  // ---- emitters and rooms ----
  const EMF = 19;
  const em = sharedF32(B.emitters.length * EMF);
  const emRoom = new Int32Array(new SharedArrayBuffer(B.emitters.length * 4));
  B.emitters.forEach((e, i) => {
    em.set([e.type, e.group, ...e.p, ...e.a, ...e.b, ...e.n, ...e.c, e.k, e.cone], i * EMF);
    let best = 0;
    let bd = 1e9;
    B.roomBoxes.forEach((b, r) => {
      const d = Math.max(b.min.x - e.p[0], 0, e.p[0] - b.max.x) + Math.max(b.min.y - e.p[1], 0, e.p[1] - b.max.y) + Math.max(b.min.z - e.p[2], 0, e.p[2] - b.max.z);
      if (d < bd) { bd = d; best = r; }
    });
    emRoom[i] = best;
  });
  const rooms = sharedF32(B.roomBoxes.length * 6);
  B.roomBoxes.forEach((b, r) => rooms.set([b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z], r * 6));
  const direct = sharedF32(W * H * 9);
  const indirect = sharedF32(W * H * 9);
  const data = { tri, tnor, tuv, talb, nodeB: nodeBs, nodeM: nodeMs, samp, nsamp, em, nem: B.emitters.length, emRoom, rooms, nrooms: B.roomBoxes.length, W, H, direct, indirect };
  const nw = Math.max(1, Math.min(8, os.cpus().length));
  const workers = Array.from({ length: nw }, () => new Worker(new URL(import.meta.url), { workerData: data }));
  const runPass = async (pass) => {
    const chunk = 4096;
    let next = 0;
    await Promise.all(
      workers.map(
        (w) =>
          new Promise((resolve, reject) => {
            const go = () => {
              if (next >= nsamp) {
                w.off('message', on);
                resolve();
                return;
              }
              const from = next;
              next = Math.min(nsamp, next + chunk);
              w.postMessage({ pass, from, to: next });
            };
            const on = () => go();
            w.on('message', on);
            w.once('error', reject);
            go();
          }),
      ),
    );
  };
  const t1 = Date.now();
  await runPass(1);
  const t2 = Date.now();
  await runPass(2);
  const t3 = Date.now();
  await Promise.all(workers.map((w) => w.terminate()));
  // ---- fill the half-resolution bounce, then blur it inside each planar chart ----
  B.charts.forEach((c) => {
    if (c.t !== 0 || c.w <= 4 || c.h <= 4) return;
    for (let j = 0; j < c.h; j++)
      for (let i = 0; i < c.w; i++) {
        if (!((i % 2 === 1 || j % 2 === 1) && i < c.w - 1 && j < c.h - 1)) continue;
        const i0 = i % 2 ? i - 1 : i, i1 = i % 2 ? i + 1 : i;
        const j0 = j % 2 ? j - 1 : j, j1 = j % 2 ? j + 1 : j;
        const o = ((c.y + j) * W + c.x + i) * 9;
        const corners = [[i0, j0], [i1, j0], [i0, j1], [i1, j1]];
        for (let k = 0; k < 9; k++) {
          let a = 0;
          for (const [ii, jj] of corners) a += indirect[((c.y + jj) * W + c.x + ii) * 9 + k];
          indirect[o + k] = a / 4;
        }
      }
  });
  const tmp2 = new Float32Array(W * H * 9);
  for (let pass = 0; pass < 3; pass++) {
    tmp2.set(indirect);
    B.charts.forEach((c) => {
      if (c.t !== 0) return;
      for (let j = 0; j < c.h; j++)
        for (let i = 0; i < c.w; i++) {
          const acc = new Float64Array(9);
          let n = 0;
          for (let dj = -1; dj <= 1; dj++)
            for (let di = -1; di <= 1; di++) {
              const ii = i + di;
              const jj = j + dj;
              if (ii < 0 || jj < 0 || ii >= c.w || jj >= c.h) continue;
              const o = ((c.y + jj) * W + c.x + ii) * 9;
              for (let k = 0; k < 9; k++) acc[k] += tmp2[o + k];
              n++;
            }
          const o = ((c.y + j) * W + c.x + i) * 9;
          for (let k = 0; k < 9; k++) indirect[o + k] = acc[k] / n;
        }
    });
  }
  // ---- variants, RGBM, filter, deflate ----
  const enc = (variant) => {
    // planes: L = log2(max channel) over [-9, 3] in 255 steps (full res); chroma r/sum, b/sum at half res
    const P = W * H;
    const W2 = W / 2;
    const H2 = H / 2;
    const P2 = W2 * H2;
    const L = new Uint8Array(P);
    const col = new Float32Array(P * 3);
    for (let i = 0; i < P; i++) {
      if (owner[i] < 0) continue;
      const o = i * 9;
      for (let k = 0; k < 3; k++) {
        const dm = direct[o + k], da = direct[o + 3 + k], de = direct[o + 6 + k];
        const im = indirect[o + k], ia = indirect[o + 3 + k], ie = indirect[o + 6 + k];
        col[i * 3 + k] = (variant === 0 ? dm + da + 0.3 * de + MULTI * (im + ia + 0.3 * ie) + 0.006 : da + de + MULTI * (ia + ie) + 0.002) * EXPOSE;
      }
      const m = Math.max(col[i * 3], col[i * 3 + 1], col[i * 3 + 2], 1e-6);
      L[i] = Math.max(1, Math.min(255, Math.round(((Math.log2(m) + 9) / 12) * 255)));
    }
    const CR = new Uint8Array(P2);
    const CB = new Uint8Array(P2);
    for (let y = 0; y < H2; y++)
      for (let x = 0; x < W2; x++) {
        let r = 0, g = 0, bb = 0;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const i = (y * 2 + dy) * W + x * 2 + dx;
          r += col[i * 3];
          g += col[i * 3 + 1];
          bb += col[i * 3 + 2];
        }
        const sum = r + g + bb;
        CR[y * W2 + x] = sum > 0 ? Math.round((r / sum) * 255) : 85;
        CB[y * W2 + x] = sum > 0 ? Math.round((bb / sum) * 255) : 85;
      }
    const filt = (pl, w) => {
      const f = new Uint8Array(pl.length);
      for (let i = 0; i < pl.length; i++) f[i] = i < w ? pl[i] : (pl[i] - pl[i - w]) & 255;
      return f;
    };
    const all = new Uint8Array(P + 2 * P2);
    all.set(filt(L, W), 0);
    all.set(filt(CR, W2), P);
    all.set(filt(CB, W2), P + P2);
    return zlib.deflateSync(all, { level: 9 }).toString('base64');
  };
  const a = enc(0);
  const b = enc(1);
  const src = `// GENERATED by tools/bake-interior.mjs — do not edit. Re-bake: node tools/bake-interior.mjs (npm run build does it when stale).
// ${B.charts.length} charts, ${nsamp} texels, ${nt} occluder triangles, ${B.emitters.length} emitters, density ${B.density.toFixed(1)} texel/m.
export const INTERIOR_BAKE: { key: string; w: number; h: number; a: string; b: string } = {
  key: '${B.key}',
  w: ${W},
  h: ${H},
  a: '${a}',
  b: '${b}',
};
`;
  await fs.writeFile(OUT, src);
  console.log(
    `baked interior lightmaps: ${nsamp} texels, ${nt} tris, ${B.emitters.length} emitters, D ${B.density.toFixed(1)}/m, ` +
      `${((a.length + b.length) / 1024).toFixed(0)} KB base64; direct ${((t2 - t1) / 1000).toFixed(1)} s, bounce ${((t3 - t2) / 1000).toFixed(1)} s, total ${((Date.now() - t0) / 1000).toFixed(1)} s (${nw} workers)`,
  );
}

function clampPoly(poly, s, t) {
  const n = poly.length / 2;
  let inside = true;
  for (let i = 0; i < n; i++) {
    const ax = poly[i * 2], ay = poly[i * 2 + 1];
    const bx = poly[((i + 1) % n) * 2], by = poly[((i + 1) % n) * 2 + 1];
    if ((bx - ax) * (t - ay) - (by - ay) * (s - ax) < -1e-9) { inside = false; break; }
  }
  if (inside) return [s, t];
  let best = 1e9, bs = s, bt = t, cx = 0, cy = 0;
  for (let i = 0; i < n; i++) { cx += poly[i * 2] / n; cy += poly[i * 2 + 1] / n; }
  for (let i = 0; i < n; i++) {
    const ax = poly[i * 2], ay = poly[i * 2 + 1];
    const bx = poly[((i + 1) % n) * 2], by = poly[((i + 1) % n) * 2 + 1];
    const ex = bx - ax, ey = by - ay;
    const l2 = ex * ex + ey * ey || 1e-12;
    const u = Math.max(0, Math.min(1, ((s - ax) * ex + (t - ay) * ey) / l2));
    const px = ax + ex * u, py = ay + ey * u;
    const d = (px - s) ** 2 + (py - t) ** 2;
    if (d < best) { best = d; bs = px; bt = py; }
  }
  const dx = cx - bs, dy = cy - bt;
  const dl = Math.hypot(dx, dy) || 1;
  const k = Math.min(0.004, dl * 0.5) / dl;
  return [bs + dx * k, bt + dy * k];
}

if (isMainThread && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ifStale = process.argv.includes('--if-stale');
  (ifStale ? bakeIfStale() : bakeInterior()).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
