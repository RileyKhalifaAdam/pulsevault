#!/usr/bin/env node
// Fetch, process and embed the photo-scanned PBR detail pack (src/render/space/photo/pack.generated.ts).
//
//   node tools/fetch-textures.mjs            download (cached), process, write the pack + docs/TEXTURE-CREDITS.md
//   node tools/fetch-textures.mjs --force    re-download everything
//
// Needs: network to api.polyhaven.com, dl.polyhaven.org, ambientcg.com (-> acg-download.struffelproductions.com);
// curl (downloads go through the environment's proxy); python3 with Pillow and numpy (image processing).
// Sources are CC0 libraries ONLY. Raw downloads go to shots/textures-src/ (git-ignored) and are never committed.
//
// Per material: colour (sRGB JPEG, 4:2:0), normal (OpenGL convention, renormalised after resize, JPEG 4:4:4 at
// higher quality), ORM (R = ambient occlusion, G = roughness, B = metalness, JPEG 4:4:4), and for cut-out sets an
// opacity map (grey JPEG). Every image is stored v-up (rows flipped at build time) so the loader uploads with
// flipY = false for every image source type (ImageBitmap ignores UNPACK_FLIP_Y) and the normal map's +G stays +v.
// Budgets (binding): pack <= 6 MB of page bytes (base64); GPU <= 60 MB with mips at 'high'.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'shots/textures-src');
const OUT = path.join(SRC, 'out');
const PACK = path.join(ROOT, 'src/render/space/photo/pack.generated.ts');
const CREDITS = path.join(ROOT, 'docs/TEXTURE-CREDITS.md');
const FORCE = process.argv.includes('--force');
const PAGE_BUDGET = 6 * 1024 * 1024;
const GPU_BUDGET = 60 * 1024 * 1024;

// tier 'hero': seen at arm's length (seats, tables, walls you lean on): colour 1024, normal 512, ORM 512.
// tier 'detail': floors, frames, hull: colour 512, normal 512, ORM 256 (the procedural trim carries the macro look).
// tile: metres covered by one repeat; null = take the library's measured size.
// op: 'mean' rescales the linear colour per channel to a target mean (re-tint keeping the photographed variation);
//     'desatRust' greys out orange corrosion (vacuum: chips show bare metal, not rust); 'heat' bakes a thin-film
//     oxide tint (straw -> bronze -> purple -> blue) into a bare-steel scan, in v-bands plus blotches.
const MATERIALS = [
  { id: 'whitePanel', lib: 'ambientcg', asset: 'Plastic013B', tier: 'hero', tile: [1.0, 1.0], op: { mean: [0.62, 0.62, 0.6], dielectric: true },
    use: 'work areas: white painted composite wall and ceiling panels, consoles' },
  { id: 'gunmetal', lib: 'ambientcg', asset: 'Metal063', tier: 'detail', tile: [1.0, 1.0], op: { roughMean: 0.38 },
    use: 'work areas: dark gunmetal frames, rails, machinery; exterior: scratched dark metal' },
  { id: 'tread', lib: 'ambientcg', asset: 'Rubber004', tier: 'detail', tile: null, op: { mean: [0.04, 0.04, 0.045], dielectric: true },
    use: 'work areas: rubber tread deck' },
  { id: 'grating', lib: 'ambientcg', asset: 'MetalWalkway006', tier: 'detail', tile: [0.8, 0.8], alpha: true,
    use: 'work areas: metal floor grating, catwalks (alpha test)' },
  { id: 'netting', lib: 'ambientcg', asset: 'Net004A', tier: 'detail', tile: null, alpha: true, op: { mean: [0.05, 0.05, 0.045], dielectric: true },
    use: 'work areas: cargo netting and webbing (alpha test)' },
  { id: 'leather', lib: 'polyhaven', asset: 'brown_leather', tier: 'hero', tile: null, op: { mean: [0.12, 0.022, 0.018], dielectric: true },
    use: 'living areas: worn red leather seats and sofa (vintage brown scan re-tinted to oxblood)' },
  { id: 'brushed', lib: 'ambientcg', asset: 'Metal009', tier: 'detail', tile: [1.0, 1.0], op: { mean: [0.55, 0.56, 0.58] },
    use: 'living areas: brushed metal trims, galley fronts, fittings' },
  { id: 'veneer', lib: 'polyhaven', asset: 'smoked_walnut_veneer', tier: 'hero', tile: null, op: { mean: [0.09, 0.05, 0.03], dielectric: true },
    use: 'living areas: dark wood veneer (raw scan darkened to an oiled finish)' },
  { id: 'fabric', lib: 'polyhaven', asset: 'poly_wool_herringbone', tier: 'hero', tile: null, op: { dielectric: true },
    use: 'living areas: upholstery fabric, bunks, padded panels (neutral grey: tint with vertex colour)' },
  { id: 'hullPaint', lib: 'ambientcg', asset: 'PaintedMetal012', tier: 'detail', tile: [2.5, 2.5], op: { desatRust: true },
    use: 'exterior: worn white paint over metal' },
  { id: 'nozzle', lib: 'ambientcg', asset: 'Metal038', tier: 'detail', tile: [0.8, 0.8], op: { heat: true, lum: 0.3 },
    use: 'exterior: heat-tinted metal for nozzles and exhaust parts (bands run along v)' },
];
const TIERS = { hero: { colour: 1024, normal: 512, orm: 512 }, detail: { colour: 512, normal: 512, orm: 256 } };
const ALPHA_SIZE = 512;
const Q = { colour: 86, normal: 92, orm: 88, alpha: 88 };

function curl(url, out) {
  if (!FORCE && existsSync(out) && statSync(out).size > 0) return;
  execFileSync('curl', ['-sSfL', '--retry', '3', '--max-time', '600', '-A', 'texture-fetch/1.0', '-o', out, url], { stdio: 'inherit' });
}
function json(url, out) {
  curl(url, out);
  return JSON.parse(readFileSync(out, 'utf8'));
}
function hasNonCC0Licence(obj) {
  // Neither API exposes a per-asset licence field today (checked 2026-11); if one appears, it must say CC0.
  let bad = null;
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (/^licen[cs]e$/i.test(k) && typeof v === 'string' && !/cc0|creative commons zero|public domain/i.test(v)) bad = v;
      else walk(v);
    }
  };
  walk(obj);
  return bad;
}

mkdirSync(OUT, { recursive: true });
const jobs = [];
const credits = [];
for (const m of MATERIALS) {
  const dir = path.join(SRC, `${m.lib}_${m.asset}`);
  mkdirSync(dir, { recursive: true });
  const size = TIERS[m.tier];
  const job = { id: m.id, op: m.op ?? {}, size, alpha: !!m.alpha, alphaSize: ALPHA_SIZE, out: OUT };
  let credit;
  if (m.lib === 'polyhaven') {
    const info = json(`https://api.polyhaven.com/info/${m.asset}`, path.join(dir, 'info.json'));
    const files = json(`https://api.polyhaven.com/files/${m.asset}`, path.join(dir, 'files.json'));
    const bad = hasNonCC0Licence(info) ?? hasNonCC0Licence(files);
    if (bad) throw new Error(`${m.asset}: licence "${bad}" is not CC0`);
    const colKey = files.Diffuse ? 'Diffuse' : Object.keys(files).find((k) => k.startsWith('coll'));
    const res = size.colour > 1024 ? '4k' : size.colour > 512 ? '2k' : '1k';
    const pick = (key, r) => files[key]?.[r]?.jpg?.url ?? files[key]?.['1k']?.jpg?.url;
    const urls = { colour: pick(colKey, res), normal: pick('nor_gl', '1k'), ao: pick('AO', '1k'), rough: pick('Rough', '1k') };
    if (files.Metal) urls.metal = pick('Metal', '1k');
    for (const [k, u] of Object.entries(urls)) {
      if (!u) throw new Error(`${m.asset}: no ${k} map`);
      const f = path.join(dir, `${k}.jpg`);
      curl(u, f);
      job[k] = f;
    }
    job.normalConvention = 'gl';
    const dims = info.dimensions ?? [1000, 1000];
    m.tileM = m.tile ?? [dims[0] / 1000, dims[1] / 1000];
    credit = {
      title: info.name, authors: Object.keys(info.authors ?? {}).join(', ') || 'Poly Haven', url: `https://polyhaven.com/a/${m.asset}`,
      method: 'photo-scanned (Poly Haven scan)', files: Object.values(urls),
      licence: 'CC0 1.0 (Poly Haven library licence; the API carries no per-asset licence field, none found)',
    };
  } else {
    const meta = json(
      `https://ambientcg.com/api/v2/full_json?id=${m.asset}&include=tagData,dimensionsData,methodData,displayData`,
      path.join(dir, 'meta.json'),
    );
    const a = meta.foundAssets?.[0];
    if (!a) throw new Error(`${m.asset}: not found on ambientCG`);
    const bad = hasNonCC0Licence(meta);
    if (bad) throw new Error(`${m.asset}: licence "${bad}" is not CC0`);
    const res = size.colour > 512 ? '2K' : '1K';
    const zipUrl = `https://ambientcg.com/get?file=${m.asset}_${res}-JPG.zip`;
    const zip = path.join(dir, `${m.asset}_${res}-JPG.zip`);
    curl(zipUrl, zip);
    job.zip = zip;
    const dx = Number(a.dimensionX) || 0;
    const dy = Number(a.dimensionY) || dx;
    m.tileM = m.tile ?? (dx > 0 ? [dx / 100, dy / 100] : [1, 1]);
    credit = {
      title: a.displayName ?? m.asset, authors: 'ambientCG (Lennart Demes)', url: `https://ambientcg.com/a/${m.asset}`,
      method: { PBRPhotogrammetry: 'photogrammetry', PBRApproximated: 'photo-based (approximated PBR)', PBRMultiAngle: 'photo-based (multi-angle)', PBRProcedural: 'procedural (Substance), not a scan' }[a.creationMethod] ?? a.creationMethod,
      files: [zipUrl], licence: 'CC0 1.0 (ambientCG library licence; the API carries no per-asset licence field, none found)',
    };
  }
  jobs.push(job);
  credits.push({ ...credit, id: m.id, asset: m.asset, lib: m.lib, use: m.use, op: m.op, tile: m.tileM });
}

// ---------------------------------------------------------------------------------------------- processing

const PY = String.raw`
import json, sys, zipfile, io
import numpy as np
from PIL import Image
spec = json.load(open(sys.argv[1]))
qoff = spec['qoff']
def lin(a): return np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
def srgb(a): a = np.clip(a, 0, 1); return np.where(a <= 0.0031308, a * 12.92, 1.055 * a ** (1 / 2.4) - 0.055)
def fit(im, s): return im if im.size == (s, s) else im.resize((s, s), Image.LANCZOS)
def save(arr, path, q, sub, mode='RGB'):
    im = Image.fromarray(np.clip(arr * 255 + 0.5, 0, 255).astype(np.uint8), mode).transpose(Image.FLIP_TOP_BOTTOM)
    im.save(path, 'JPEG', quality=int(q), subsampling=sub, optimize=True, progressive=False)
def periodic_noise(n, rng, fmax, amps):
    y, x = np.mgrid[0:n, 0:n] / n
    acc = np.zeros((n, n))
    for _ in range(amps):
        fx, fy = rng.randint(-fmax, fmax + 1), rng.randint(0, fmax + 1)
        if fx == 0 and fy == 0: continue
        acc += np.cos(2 * np.pi * (fx * x + fy * y) + rng.uniform(0, 2 * np.pi)) / np.hypot(fx, fy)
    acc -= acc.min(); return acc / max(acc.max(), 1e-6)
stats = {}
for j in spec['jobs']:
    def member(suffix, required=True):
        if 'zip' not in j: return None
        z = zipfile.ZipFile(j['zip'])
        for n in z.namelist():
            if n.endswith('_' + suffix + '.jpg'): return Image.open(io.BytesIO(z.read(n)))
        if required: raise SystemExit(j['id'] + ': missing ' + suffix)
        return None
    s = j['size']
    if 'zip' in j:
        col = member('Color'); nor = member('NormalGL', False); conv = 'gl'
        if nor is None: nor = member('NormalDX'); conv = 'dx'
        rough = member('Roughness'); metal = member('Metalness', False); ao = member('AmbientOcclusion', False)
        alpha = member('Opacity', False) if j['alpha'] else None
    else:
        col = Image.open(j['colour']); nor = Image.open(j['normal']); conv = j['normalConvention']
        rough = Image.open(j['rough']); ao = Image.open(j['ao']); metal = Image.open(j['metal']) if 'metal' in j else None; alpha = None
    n0 = rough.size[0]
    R = np.asarray(fit(ao.convert('L'), n0), np.float64) / 255 if ao else np.ones((n0, n0))
    G = np.asarray(fit(rough.convert('L'), n0), np.float64) / 255
    B = np.asarray(fit(metal.convert('L'), n0), np.float64) / 255 if metal else np.zeros((n0, n0))
    # detail AO: scan cavity maps are normalised to the full range; keep the shape, cap the darkening (mean >= 0.85)
    if R.mean() < 0.85: R = 1 - (1 - R) * (0.15 / max(1 - R.mean(), 1e-4))
    if 'roughMean' in j['op']: G = np.clip(G, 1e-3, 1) ** (np.log(j['op']['roughMean']) / np.log(max(G.mean(), 1e-3)))
    if j['op'].get('dielectric'): B = B * 0
    orm = Image.fromarray((np.stack([R, G, B], -1) * 255 + 0.5).astype(np.uint8), 'RGB')
    # colour (linear-space ops, then back to sRGB)
    c = lin(np.asarray(fit(col.convert('RGB'), s['colour']), np.float64) / 255)
    op = j['op']
    if op.get('heat'):
        n = s['colour']; rng = np.random.RandomState(7)
        y = np.mgrid[0:n, 0:n][0] / n
        blot = periodic_noise(n, rng, 5, 40)
        bands = 0.5 + 0.5 * np.cos(2 * np.pi * (y + 0.12 * (blot - 0.5)))
        t = np.clip(0.4 * bands + 0.6 * periodic_noise(n, rng, 8, 60), 0, 1)
        ramp = np.array([[1, 1, 1], [1.0, 0.82, 0.5], [0.9, 0.55, 0.28], [0.62, 0.3, 0.55], [0.32, 0.42, 0.9], [0.55, 0.62, 0.78]])
        x = t * (len(ramp) - 1); i0 = np.floor(x).astype(int).clip(0, len(ramp) - 2); f = (x - i0)[..., None]
        tint = ramp[i0] * (1 - f) + ramp[i0 + 1] * f
        c = c * tint
    if 'lum' in op:
        c = c * (op['lum'] / max(float((c @ np.array([0.2126, 0.7152, 0.0722])).mean()), 1e-4))
    if 'mean' in op:
        c = c * (np.array(op['mean']) / np.maximum(c.reshape(-1, 3).mean(0), 1e-4))
    if op.get('desatRust'):
        mx, mn = c.max(-1), c.min(-1)
        sat = (mx - mn) / np.maximum(mx, 1e-4)
        warm = np.clip((c[..., 0] - c[..., 2]) / np.maximum(mx, 1e-4) * 2, 0, 1)
        k = np.clip((sat - 0.12) * 3, 0, 1) * warm
        grey = (c @ np.array([0.2126, 0.7152, 0.0722]))[..., None] * np.array([0.92, 0.94, 1.0])
        c = c + ((0.3 + 0.5 * grey) - c) * np.clip(k * 1.5, 0, 1)[..., None]
    save(srgb(c), j['out'] + '/' + j['id'] + '_c.jpg', spec['q']['colour'] + qoff, 2)
    meanAlb = c.reshape(-1, 3).mean(0).tolist()
    # normal: to [-1,1], OpenGL convention, resize, renormalise
    nimg = np.asarray(nor.convert('RGB'), np.float64) / 255 * 2 - 1
    if conv == 'dx': nimg[..., 1] = -nimg[..., 1]
    nr = np.stack([np.asarray(fit(Image.fromarray(nimg[..., k].astype(np.float32), 'F'), s['normal']), np.float64) for k in range(3)], -1)
    nr[..., 2] = np.maximum(nr[..., 2], 0.05)
    nr /= np.linalg.norm(nr, axis=-1, keepdims=True)
    save(nr * 0.5 + 0.5, j['out'] + '/' + j['id'] + '_n.jpg', spec['q']['normal'] + qoff, 0)
    o = np.asarray(fit(orm, s['orm']), np.float64) / 255
    save(o, j['out'] + '/' + j['id'] + '_orm.jpg', spec['q']['orm'] + qoff, 0)
    st = {'albedo': meanAlb, 'ao': float(o[..., 0].mean()), 'roughness': float(o[..., 1].mean()), 'metalness': float(o[..., 2].mean())}
    if alpha is not None:
        a = np.asarray(fit(alpha.convert('L'), j['alphaSize']), np.float64) / 255
        save(a, j['out'] + '/' + j['id'] + '_a.jpg', spec['q']['alpha'] + qoff, 0, 'L')
        st['coverage'] = float(a.mean())
    stats[j['id']] = st
# contact sheet of the processed maps (for review; v-up images flipped back for viewing)
tiles = []
for j in spec['jobs']:
    for suf in ['_c', '_n', '_orm']:
        tiles.append(Image.open(j['out'] + '/' + j['id'] + suf + '.jpg').convert('RGB').transpose(Image.FLIP_TOP_BOTTOM).resize((200, 200)))
sheet = Image.new('RGB', (600 * 2, 200 * ((len(spec['jobs']) + 1) // 2)), (16, 16, 16))
for i, t in enumerate(tiles):
    k = i // 3; sheet.paste(t, ((k % 2) * 600 + (i % 3) * 200, (k // 2) * 200))
sheet.save(spec['sheet'], quality=85)
json.dump(stats, open(spec['stats'], 'w'))
`;
const work = mkdtempSync(path.join(tmpdir(), 'tl-tex-'));
const pyFile = path.join(work, 'process.py');
writeFileSync(pyFile, PY);

const bytesOf = (id, suf) => readFileSync(path.join(OUT, `${id}_${suf}.jpg`));
const gpu = (s) => Math.round((s * s * 4 * 4) / 3);
let qoff = 0;
let stats;
let pageBytes = 0;
for (;;) {
  const specFile = path.join(work, 'spec.json');
  writeFileSync(specFile, JSON.stringify({ jobs, q: Q, qoff, sheet: path.join(SRC, 'processed-sheet.jpg'), stats: path.join(work, 'stats.json') }));
  execFileSync('python3', ['-I', pyFile, specFile], { stdio: 'inherit', cwd: work });
  stats = JSON.parse(readFileSync(path.join(work, 'stats.json'), 'utf8'));
  pageBytes = 0;
  for (const j of jobs) for (const suf of ['c', 'n', 'orm', ...(j.alpha ? ['a'] : [])]) pageBytes += Math.ceil(bytesOf(j.id, suf).length / 3) * 4;
  if (pageBytes <= PAGE_BUDGET * 0.97 || qoff <= -24) break;
  qoff -= 4;
  console.log(`pack ${(pageBytes / 1048576).toFixed(2)} MB over budget: re-encoding at quality offset ${qoff}`);
}
if (pageBytes > PAGE_BUDGET) throw new Error(`pack is ${pageBytes} page bytes: over the 6 MB budget`);

// ---------------------------------------------------------------------------------------------- outputs

const r3 = (v) => Math.round(v * 1000) / 1000;
let gpuTotal = 0;
const rows = [];
const entries = jobs.map((j) => {
  const m = MATERIALS.find((x) => x.id === j.id);
  const st = stats[j.id];
  const maps = { map: ['c', j.size.colour], normalMap: ['n', j.size.normal], ormMap: ['orm', j.size.orm] };
  if (j.alpha) maps.alphaMap = ['a', j.alphaSize];
  let pb = 0;
  let gb = 0;
  const fields = Object.entries(maps).map(([k, [suf, size]]) => {
    const b64 = bytesOf(j.id, suf).toString('base64');
    pb += b64.length;
    gb += gpu(size);
    return `    ${k}: { size: ${size}, jpeg: '${b64}' },`;
  });
  gpuTotal += gb;
  rows.push({ id: j.id, asset: m.asset, lib: m.lib, sizes: `${j.size.colour}/${j.size.normal}/${j.size.orm}${j.alpha ? `+a${j.alphaSize}` : ''}`, pb, gb, tile: m.tileM, st });
  return [
    `  ${j.id}: {`,
    `    tileMetres: [${r3(m.tileM[0])}, ${r3(m.tileM[1])}],`,
    `    meanAlbedo: [${st.albedo.map(r3).join(', ')}],`,
    `    meanRoughness: ${r3(st.roughness)}, meanMetalness: ${r3(st.metalness)}, meanAo: ${r3(st.ao)},`,
    `    source: '${m.lib}:${m.asset}',`,
    ...fields,
    '  },',
  ].join('\n');
});
if (gpuTotal > GPU_BUDGET) throw new Error(`pack needs ${gpuTotal} GPU bytes at 'high': over the 60 MB budget`);

const ts = `// GENERATED by tools/fetch-textures.mjs — do not edit by hand.
// Regenerate: node tools/fetch-textures.mjs   (network to api.polyhaven.com, dl.polyhaven.org, ambientcg.com;
// curl; python3 with Pillow + numpy). Sources and licences (all CC0): docs/TEXTURE-CREDITS.md.
// Images are JPEG, base64, stored v-up (upload with flipY = false). Normals: OpenGL convention.
// ORM: R = ambient occlusion, G = roughness, B = metalness. alphaMap: opacity in every channel.
// Page bytes: ${pageBytes} (${(pageBytes / 1048576).toFixed(2)} MB). GPU at 'high' with mips: ${gpuTotal} bytes (${(gpuTotal / 1048576).toFixed(1)} MB).
/* eslint-disable */

export const PHOTO_MATERIAL_IDS = [${jobs.map((j) => `'${j.id}'`).join(', ')}] as const;
export type PhotoMaterialId = (typeof PHOTO_MATERIAL_IDS)[number];

export interface PhotoImageData {
  /** Width = height in texels at 'high'. */
  readonly size: number;
  /** Base64 JPEG. */
  readonly jpeg: string;
}
export interface PhotoSetData {
  /** Metres covered by one repeat (u, v). */
  readonly tileMetres: readonly [number, number];
  /** Mean linear albedo of the colour map (for light bakes and LOD fallbacks). */
  readonly meanAlbedo: readonly [number, number, number];
  readonly meanRoughness: number;
  readonly meanMetalness: number;
  readonly meanAo: number;
  readonly source: string;
  readonly map: PhotoImageData;
  readonly normalMap: PhotoImageData;
  readonly ormMap: PhotoImageData;
  readonly alphaMap?: PhotoImageData;
}

export const PHOTO_PAGE_BYTES = ${pageBytes};

export const PHOTO_PACK: Readonly<Record<PhotoMaterialId, PhotoSetData>> = {
${entries.join('\n')}
};
`;
mkdirSync(path.dirname(PACK), { recursive: true });
writeFileSync(PACK, ts);

const kb = (b) => `${(b / 1024).toFixed(0)} KiB`;
const mb = (b) => `${(b / 1048576).toFixed(2)} MB`;
const md = `# Texture credits

The photo detail pack (\`src/render/space/photo/pack.generated.ts\`) is built by \`node tools/fetch-textures.mjs\`
from CC0 libraries only. CC0 needs no attribution; it is recorded here anyway, with what was changed.

Licence check: the script refuses any asset whose API record carries a licence field that is not CC0. Neither the
Poly Haven API (\`/info\`, \`/files\`) nor the ambientCG API (v2 \`full_json\`, v3 \`assets\`) exposes a per-asset
licence field (checked 2026-11-19), so the licence recorded is the library-wide one: every Poly Haven asset is
CC0 1.0 (polyhaven.com/license) and every ambientCG asset is CC0 1.0 (docs.ambientcg.com/license). Those licence
pages were not reachable from the build machine's network and were not re-read; the statement is the libraries'
published policy.

Generated pack: ${mb(pageBytes)} of page bytes (base64), ${mb(gpuTotal)} of GPU memory with mipmaps at 'high'
(1/4 of that at 'medium', 1/16 at 'low').

| id | asset | author | capture | licence | tile (m) | maps (colour/normal/ORM) | page | GPU | use | changes |
|---|---|---|---|---|---|---|---|---|---|---|
${credits
  .map((c) => {
    const r = rows.find((x) => x.id === c.id);
    const ch = c.op?.mean ? `colour re-tinted to linear mean ${c.op.mean.join('/')}` : c.op?.desatRust ? 'orange corrosion desaturated to bare metal' : c.op?.heat ? `thin-film heat tint baked into the colour, luminance set to ${c.op.lum}` : 'none';
    return `| ${c.id} | [${c.title}](${c.url}) (\`${c.asset}\`) | ${c.authors} | ${c.method} | ${c.licence} | ${c.tile.map(r3).join(' x ')} | ${r.sizes} | ${kb(r.pb)} | ${mb(r.gb)} | ${c.use} | resized, v-flipped, JPEG; ${ch} |`;
  })
  .join('\n')}

Downloaded files (cached under \`shots/textures-src/\`, git-ignored, never committed):

${credits.map((c) => `- ${c.id}: ${c.files.join(' , ')}`).join('\n')}
`;
writeFileSync(CREDITS, md);

console.log('id          asset                    maps            page      GPU      tile     albedo(lin)        rough metal');
for (const r of rows) {
  console.log(
    `${r.id.padEnd(11)} ${r.asset.padEnd(24)} ${r.sizes.padEnd(15)} ${kb(r.pb).padStart(8)} ${mb(r.gb).padStart(8)}  ${r.tile.map(r3).join('x').padEnd(8)} ${r.st.albedo.map((v) => v.toFixed(3)).join(',').padEnd(18)} ${r.st.roughness.toFixed(2)}  ${r.st.metalness.toFixed(2)}`,
  );
}
console.log(`total page ${mb(pageBytes)} / 6 MB   GPU ${mb(gpuTotal)} / 60 MB at 'high'   wrote ${path.relative(ROOT, PACK)}, ${path.relative(ROOT, CREDITS)}`);
