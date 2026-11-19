// The photo pack (pack.generated.ts) as THREE texture arrays, for detail blending inside ONE shader across all
// the ship's surfaces (surfaces.ts interior atlas, the cockpit hardware, the hull, the props):
//
//   uPhAlbB  sRGB RGBA8 array, the four 1024 scans (whitePanel, leather, veneer, fabric)      layer = PHOTO_LAYER.alb
//   uPhAlbS  sRGB RGBA8 array, the seven 512 sets; A = opacity (grating, netting) else 1     layer = PHOTO_LAYER.alb - 16
//   uPhLin   linear RGBA8 array, every set at the normal map's size: R,G = tangent normal xy (OpenGL, +G = +v),
//            B = ambient occlusion, A = roughness (metalness is never read: the trim keeps its own)
//
// Sizes: 'high'/'ultra' as stored (1024 / 512 / 512), 'medium' and 'low' half per axis (512 / 256 / 256).
// GPU (RGBA8 + mips): 47.6 MB high/ultra, 11.9 MB medium/low.
//
// One shared, reference-counted instance per size. acquirePhotoDetail(q) returns at once with empty uniforms
// (`uPhOn` = 0, sampler values null so three binds its empty array); the JPEGs decode asynchronously, one image
// per task (createImageBitmap is off the main thread; the copy into the layer is a getImageData of <= 4 MB),
// then the three arrays are uploaded on three successive animation frames through the renderer that compiled
// the first material using them (noteRenderer, called from onBeforeCompile), and `uPhOn` turns 1 a frame later.
// Programs never change: the samplers exist from the first compile, so there is no hitch when the photos land.
// The decoded pixels are dropped after the upload; on a WebGL context loss the samplers are cleared and
// `uPhOn` = 0, and when the context comes back the pack is decoded again into the same textures.
import * as THREE from 'three';
import { PHOTO_MATERIAL_IDS, PHOTO_PACK, type PhotoImageData, type PhotoMaterialId, type PhotoSetData } from './pack.generated';
import { closePhotoSource, decodePhotoImage, makePhotoCanvas } from './index';

export type PhotoDetailQuality = 'low' | 'medium' | 'high' | 'ultra';

export interface PhotoDetailUniforms {
  uPhAlbB: { value: THREE.DataArrayTexture | null };
  uPhAlbS: { value: THREE.DataArrayTexture | null };
  uPhLin: { value: THREE.DataArrayTexture | null };
  /** 1 once every array is uploaded, else 0 (the shaders then use the trim alone). */
  uPhOn: { value: number };
}

export interface PhotoDetail {
  readonly uniforms: PhotoDetailUniforms;
  /** Resolves once the photos are in use (true) or the decode failed altogether (false). Never rejects. */
  readonly ready: Promise<boolean>;
  /** GPU bytes with mips. */
  readonly bytes: number;
  /** Decode + copy time, ms (main-thread work only). */
  readonly decodeMs: number;
  /** Images that fell back to flat values. */
  readonly failed: readonly string[];
  /** Give the instance a renderer to upload with (first call wins; also arms the context-restore refill). */
  noteRenderer(r: THREE.WebGLRenderer): void;
}

/** Albedo layer per set: 0..3 in the big array, 16+i in the small one; lin = layer of the linear array. */
export const PHOTO_LAYER: Readonly<Record<PhotoMaterialId, { alb: number; lin: number }>> = (() => {
  const out: Record<string, { alb: number; lin: number }> = {};
  let nb = 0;
  let ns = 0;
  PHOTO_MATERIAL_IDS.forEach((id, i) => {
    const big = PHOTO_PACK[id].map.size >= 1024;
    out[id] = { alb: big ? nb++ : 16 + ns++, lin: i };
  });
  return out as Record<PhotoMaterialId, { alb: number; lin: number }>;
})();
const BIG_IDS = PHOTO_MATERIAL_IDS.filter((id) => PHOTO_LAYER[id].alb < 16);
const SMALL_IDS = PHOTO_MATERIAL_IDS.filter((id) => PHOTO_LAYER[id].alb >= 16);
const BIG_SIZE = 1024;
const SMALL_SIZE = 512;
const LIN_SIZE = 512;

const divisor = (q: PhotoDetailQuality): number => (q === 'high' || q === 'ultra' ? 1 : 2);

/** GPU bytes of the arrays at a quality, without loading anything. */
export function photoDetailBytes(q: PhotoDetailQuality): number {
  const d = divisor(q);
  const px = BIG_IDS.length * (BIG_SIZE / d) ** 2 + SMALL_IDS.length * (SMALL_SIZE / d) ** 2 + PHOTO_MATERIAL_IDS.length * (LIN_SIZE / d) ** 2;
  return Math.round((px * 4 * 4) / 3);
}

interface Entry {
  detail: PhotoDetail;
  refs: number;
  dispose(): void;
}
const cache = new Map<number, Entry>();

function makeArray(size: number, layers: number, srgb: boolean, aniso: number): THREE.DataArrayTexture {
  const t = new THREE.DataArrayTexture(null, size, size, layers);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.flipY = false;
  t.unpackAlignment = 4;
  return t;
}

const toByte = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
const srgbByte = (v: number): number => toByte(v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

const nextFrame = (): Promise<void> =>
  new Promise((res) => {
    if (typeof requestAnimationFrame === 'function') {
      // a hidden page never runs rAF: fall back after 100 ms
      let done = false;
      const fin = (): void => {
        if (!done) {
          done = true;
          res();
        }
      };
      requestAnimationFrame(fin);
      setTimeout(fin, 100);
    } else setTimeout(res, 16);
  });
const yieldTask = (): Promise<void> => new Promise((res) => setTimeout(res, 0));

/**
 * The shared photo-detail arrays at quality `q` (reference counted; pair with releasePhotoDetail). Starts the
 * decode on first use. In node (no DOM) the instance stays empty and `ready` resolves false.
 */
export function acquirePhotoDetail(q: PhotoDetailQuality): PhotoDetail {
  const d = divisor(q);
  const have = cache.get(d);
  if (have) {
    have.refs++;
    return have.detail;
  }
  const isPhone = (() => {
    try {
      return typeof navigator !== 'undefined' && (navigator.maxTouchPoints > 0 || /iPhone|iPad|Android/i.test(navigator.userAgent));
    } catch {
      return false;
    }
  })();
  const aniso = q === 'low' ? 2 : isPhone ? 4 : 8;
  const bigS = BIG_SIZE / d;
  const smallS = SMALL_SIZE / d;
  const linS = LIN_SIZE / d;
  const albB = makeArray(bigS, BIG_IDS.length, true, aniso);
  const albS = makeArray(smallS, SMALL_IDS.length, true, aniso);
  const lin = makeArray(linS, PHOTO_MATERIAL_IDS.length, false, aniso);
  albB.name = 'photo.albedo.big';
  albS.name = 'photo.albedo.small';
  lin.name = 'photo.linear';
  const uniforms: PhotoDetailUniforms = { uPhAlbB: { value: null }, uPhAlbS: { value: null }, uPhLin: { value: null }, uPhOn: { value: 0 } };
  const failed: string[] = [];
  let renderer: THREE.WebGLRenderer | null = null;
  let disposed = false;
  let gen = 0;
  let decodeMs = 0;
  let canvasHost: HTMLCanvasElement | null = null;

  const canvases = new Map<number, { c: HTMLCanvasElement | OffscreenCanvas; g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D }>();
  const ctx2d = (s: number): { c: HTMLCanvasElement | OffscreenCanvas; g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } | null => {
    let e = canvases.get(s);
    if (!e) {
      const c = makePhotoCanvas(s, s);
      const g = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!g) return null;
      e = { c, g };
      canvases.set(s, e);
    }
    return e;
  };
  /** Decode `img` and return its RGBA pixels at s x s (rows from v = 0), or null. */
  const pixels = async (img: PhotoImageData, s: number): Promise<Uint8ClampedArray | null> => {
    const src = await decodePhotoImage(img, Math.max(s, Math.min(img.size, s)));
    const t0 = performance.now();
    try {
      const e = ctx2d(s);
      if (!e) return null;
      e.g.imageSmoothingEnabled = true;
      e.g.imageSmoothingQuality = 'high';
      e.g.clearRect(0, 0, s, s);
      e.g.drawImage(src, 0, 0, s, s);
      return e.g.getImageData(0, 0, s, s).data;
    } finally {
      closePhotoSource(src);
      decodeMs += performance.now() - t0;
    }
  };

  const fill = async (): Promise<boolean> => {
    const my = ++gen;
    failed.length = 0;
    decodeMs = 0;
    if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') return false;
    const dB = new Uint8Array(bigS * bigS * 4 * BIG_IDS.length);
    const dS = new Uint8Array(smallS * smallS * 4 * SMALL_IDS.length);
    const dL = new Uint8Array(linS * linS * 4 * PHOTO_MATERIAL_IDS.length);
    let ok = 0;
    const one = async (name: string, img: PhotoImageData, s: number, write: (p: Uint8ClampedArray | null) => void): Promise<boolean> => {
      let p: Uint8ClampedArray | null = null;
      try {
        p = await pixels(img, s);
      } catch {
        p = null;
      }
      if (my !== gen || disposed) return false;
      if (!p) failed.push(name);
      else ok++;
      const t0 = performance.now();
      write(p);
      decodeMs += performance.now() - t0;
      await yieldTask();
      return my === gen && !disposed;
    };
    for (const id of PHOTO_MATERIAL_IDS) {
      const set: PhotoSetData = PHOTO_PACK[id];
      const L = PHOTO_LAYER[id];
      const big = L.alb < 16;
      const s = big ? bigS : smallS;
      const dst = big ? dB : dS;
      const base = (big ? L.alb : L.alb - 16) * s * s * 4;
      const mr = srgbByte(set.meanAlbedo[0]);
      const mg = srgbByte(set.meanAlbedo[1]);
      const mb = srgbByte(set.meanAlbedo[2]);
      if (
        !(await one(`${id}.map`, set.map, s, (p) => {
          for (let i = 0, n = s * s; i < n; i++) {
            const o = base + i * 4;
            dst[o] = p ? p[i * 4] : mr;
            dst[o + 1] = p ? p[i * 4 + 1] : mg;
            dst[o + 2] = p ? p[i * 4 + 2] : mb;
            dst[o + 3] = 255;
          }
        }))
      )
        return false;
      if (set.alphaMap) {
        if (
          !(await one(`${id}.alphaMap`, set.alphaMap, s, (p) => {
            if (!p) return;
            for (let i = 0, n = s * s; i < n; i++) dst[base + i * 4 + 3] = p[i * 4];
          }))
        )
          return false;
      }
      const lb = L.lin * linS * linS * 4;
      if (
        !(await one(`${id}.normalMap`, set.normalMap, linS, (p) => {
          for (let i = 0, n = linS * linS; i < n; i++) {
            dL[lb + i * 4] = p ? p[i * 4] : 128;
            dL[lb + i * 4 + 1] = p ? p[i * 4 + 1] : 128;
          }
        }))
      )
        return false;
      if (
        !(await one(`${id}.ormMap`, set.ormMap, linS, (p) => {
          const ao = toByte(set.meanAo);
          const ro = toByte(set.meanRoughness);
          for (let i = 0, n = linS * linS; i < n; i++) {
            dL[lb + i * 4 + 2] = p ? p[i * 4] : ao;
            dL[lb + i * 4 + 3] = p ? p[i * 4 + 1] : ro;
          }
        }))
      )
        return false;
    }
    if (!ok) return false;
    canvases.clear();
    // upload one array per frame (each is 10-22 MB with mips), then switch the detail on
    const arrays: [THREE.DataArrayTexture, Uint8Array, keyof PhotoDetailUniforms][] = [
      [lin, dL, 'uPhLin'],
      [albS, dS, 'uPhAlbS'],
      [albB, dB, 'uPhAlbB'],
    ];
    for (const [t, data, key] of arrays) {
      if (my !== gen || disposed) return false;
      t.image = { data, width: t.image.width, height: t.image.height, depth: t.image.depth };
      t.needsUpdate = true;
      // after the upload, drop the pixels (CPU memory counts against the iOS tab)
      t.onUpdate = (tt: THREE.Texture) => {
        const im = (tt as THREE.DataArrayTexture).image as { data: Uint8Array | null };
        im.data = null;
      };
      if (renderer) {
        try {
          renderer.initTexture(t);
        } catch {
          /* uploaded on first use instead */
        }
      }
      (uniforms[key] as { value: THREE.DataArrayTexture | null }).value = t;
      await nextFrame();
    }
    if (my !== gen || disposed) return false;
    await nextFrame();
    if (my !== gen || disposed) return false;
    uniforms.uPhOn.value = 1;
    return true;
  };

  const onLost = (): void => {
    gen++;
    uniforms.uPhOn.value = 0;
    uniforms.uPhAlbB.value = null;
    uniforms.uPhAlbS.value = null;
    uniforms.uPhLin.value = null;
  };
  const onRestored = (): void => {
    if (disposed) return;
    void fill().catch(() => false);
  };

  const ready = fill().catch(() => false);
  const detail: PhotoDetail = {
    uniforms,
    ready,
    bytes: photoDetailBytes(q),
    get decodeMs() {
      return decodeMs;
    },
    failed,
    noteRenderer(r: THREE.WebGLRenderer): void {
      if (renderer || disposed) return;
      renderer = r;
      const el = r.domElement as HTMLCanvasElement | undefined;
      if (el && typeof el.addEventListener === 'function') {
        canvasHost = el;
        el.addEventListener('webglcontextlost', onLost, false);
        el.addEventListener('webglcontextrestored', onRestored, false);
      }
      // the arrays may already be filled: upload now, while loading
      for (const t of [lin, albS, albB]) {
        const im = t.image as { data: Uint8Array | null };
        if (im.data && t.version > 0) {
          try {
            r.initTexture(t);
          } catch {
            /* first use */
          }
        }
      }
    },
  };
  const entry: Entry = {
    detail,
    refs: 1,
    dispose(): void {
      disposed = true;
      gen++;
      onLost();
      if (canvasHost) {
        canvasHost.removeEventListener('webglcontextlost', onLost, false);
        canvasHost.removeEventListener('webglcontextrestored', onRestored, false);
      }
      albB.dispose();
      albS.dispose();
      lin.dispose();
    },
  };
  cache.set(d, entry);
  return detail;
}

export function releasePhotoDetail(p: PhotoDetail): void {
  for (const [k, e] of cache) {
    if (e.detail !== p) continue;
    if (--e.refs > 0) return;
    e.dispose();
    cache.delete(k);
    return;
  }
}
