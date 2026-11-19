// Photo-scanned PBR detail textures (CC0, embedded as base64 JPEG in pack.generated.ts; credits in
// docs/TEXTURE-CREDITS.md; regenerate with `node tools/fetch-textures.mjs`).
//
//   const photo = await loadPhotoMaterials(renderer, 'high');
//   photo.leather.map / .normalMap / .ormMap / .alphaMap / .tileMetres
//   photo.restore()  — from pipeline.onContextRestored (re-decodes into the same Texture objects)
//   photo.dispose()
//
// Every texture: RepeatWrapping, mipmaps (trilinear), anisotropy min(renderer max, 4 on phones / 8 elsewhere,
// 2 at 'low'), flipY = false (the images are stored v-up). Colour is sRGB; normal (OpenGL convention) and ORM
// (R = AO, G = roughness, B = metalness) are linear. alphaMap (cut-out sets only) is opacity in every channel.
//
// UVs are physical: set uv = position-in-metres / tileMetres (a 1 m texture covers 1 m of surface).
// Decoding is asynchronous (createImageBitmap from a Blob — no URL, no network — falling back to an <img> on a
// blob: then a data: URL) and sequential to bound peak memory. 'medium' decodes at 1/2 size per axis (1/4 the
// memory), 'low' at 1/4. After upload the decoded source is released (it is re-made from the base64 by restore()).
// Never rejects: an image that cannot be decoded becomes a 4x4 image of the set's mean values and its name is
// listed in `failed`.

import * as THREE from 'three';
import { PHOTO_MATERIAL_IDS, PHOTO_PACK, PHOTO_PAGE_BYTES, type PhotoImageData, type PhotoMaterialId, type PhotoSetData } from './pack.generated';

export { PHOTO_MATERIAL_IDS, PHOTO_PAGE_BYTES, type PhotoMaterialId };
export type PhotoQuality = 'low' | 'medium' | 'high' | 'ultra';

export interface PhotoMaterial {
  /** sRGB albedo (metals: F0). */
  readonly map: THREE.Texture;
  /** Tangent-space normal, OpenGL convention (+G = +v). */
  readonly normalMap: THREE.Texture;
  /** R = ambient occlusion (detail cavities, mean >= 0.85), G = roughness, B = metalness. */
  readonly ormMap: THREE.Texture;
  /** Opacity for cut-out sets (grating, netting), else null. */
  readonly alphaMap: THREE.Texture | null;
  /** Metres covered by one repeat (u, v). */
  readonly tileMetres: readonly [number, number];
  /** Mean linear albedo, roughness, metalness of the set (for bakes, LOD fallbacks and blend calibration). */
  readonly meanAlbedo: readonly [number, number, number];
  readonly meanRoughness: number;
  readonly meanMetalness: number;
}

export interface PhotoPackControl {
  /** Re-decode every image into the same textures (call after a WebGL context restore). Never rejects. */
  restore(): Promise<void>;
  dispose(): void;
  /** GPU bytes held with mipmaps (estimate, RGBA8). */
  readonly gpuBytes: number;
  /** Images that fell back to flat values ("leather.map", ...). */
  readonly failed: readonly string[];
}

/** One entry per material id; control members are non-enumerable (Object.keys gives only the ids). */
export type PhotoMaterials = Readonly<Record<PhotoMaterialId, PhotoMaterial>> & PhotoPackControl;

/** Real-world size of each set (metres per repeat), available without loading anything. */
export const PHOTO_TILE_METRES: Readonly<Record<PhotoMaterialId, readonly [number, number]>> = Object.fromEntries(
  PHOTO_MATERIAL_IDS.map((id) => [id, PHOTO_PACK[id].tileMetres]),
) as Record<PhotoMaterialId, readonly [number, number]>;

const DIVISOR: Record<PhotoQuality, number> = { low: 4, medium: 2, high: 1, ultra: 1 };

/** GPU bytes the pack takes at a quality (RGBA8 with a full mip chain), without loading it. */
export function photoGpuBytes(quality: PhotoQuality): number {
  let b = 0;
  for (const id of PHOTO_MATERIAL_IDS) {
    for (const img of imagesOf(PHOTO_PACK[id])) {
      const s = Math.max(1, Math.floor(img.data.size / (DIVISOR[quality] ?? 1)));
      b += (s * s * 4 * 4) / 3;
    }
  }
  return Math.round(b);
}

type Slot = 'map' | 'normalMap' | 'ormMap' | 'alphaMap';
interface ImageRef {
  slot: Slot;
  data: PhotoImageData;
}
function imagesOf(set: PhotoSetData): ImageRef[] {
  const out: ImageRef[] = [
    { slot: 'map', data: set.map },
    { slot: 'normalMap', data: set.normalMap },
    { slot: 'ormMap', data: set.ormMap },
  ];
  if (set.alphaMap) out.push({ slot: 'alphaMap', data: set.alphaMap });
  return out;
}

type Source = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const n = bin.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = url;
  });
}

async function decodeFull(b64: string): Promise<Source> {
  const bytes = base64ToBytes(b64);
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'image/jpeg' });
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    } catch {
      try {
        return await createImageBitmap(blob);
      } catch {
        /* fall through to <img> */
      }
    }
  }
  if (typeof Image === 'undefined') throw new Error('no image decoder');
  let url: string | null = null;
  try {
    url = URL.createObjectURL(blob);
    return await loadImageElement(url);
  } catch {
    return await loadImageElement(`data:image/jpeg;base64,${b64}`);
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function closeSource(s: unknown): void {
  if (typeof ImageBitmap !== 'undefined' && s instanceof ImageBitmap) s.close();
}

/** Halve repeatedly (box-like, no aliasing) down to `size`. */
function downscale(src: Source, size: number): Source {
  let cur: Source = src;
  let w = src.width;
  while (w > size) {
    w = Math.max(size, w >> 1);
    const c = makeCanvas(w, w);
    const ctx = c.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return cur;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, w, w);
    if (cur !== src) closeSource(cur);
    cur = c;
  }
  if (cur !== src) closeSource(src);
  return cur;
}

async function decode(data: PhotoImageData, size: number): Promise<Source> {
  const full = await decodeFull(data.jpeg);
  return full.width > size ? downscale(full, size) : full;
}

/** 4x4 canvas of one value (decode-failure fallback). */
function flatSource(rgba: readonly [number, number, number, number]): HTMLCanvasElement | OffscreenCanvas {
  const c = makeCanvas(4, 4);
  const ctx = c.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (ctx) {
    ctx.fillStyle = `rgb(${rgba[0]},${rgba[1]},${rgba[2]})`;
    ctx.fillRect(0, 0, 4, 4);
  }
  return c;
}

const toByte = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
const srgbByte = (v: number): number => toByte(v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

function fallbackValue(set: PhotoSetData, slot: Slot): [number, number, number, number] {
  if (slot === 'map') return [srgbByte(set.meanAlbedo[0]), srgbByte(set.meanAlbedo[1]), srgbByte(set.meanAlbedo[2]), 255];
  if (slot === 'normalMap') return [128, 128, 255, 255];
  if (slot === 'ormMap') return [toByte(set.meanAo), toByte(set.meanRoughness), toByte(set.meanMetalness), 255];
  return [255, 255, 255, 255];
}

function isPhone(): boolean {
  try {
    if (typeof navigator === 'undefined') return false;
    return navigator.maxTouchPoints > 0 || /iPhone|iPad|Android/i.test(navigator.userAgent);
  } catch {
    return false;
  }
}

let releasedStandIn: HTMLCanvasElement | OffscreenCanvas | null = null;
function standIn(): HTMLCanvasElement | OffscreenCanvas | null {
  if (!releasedStandIn) {
    try {
      releasedStandIn = makeCanvas(1, 1);
    } catch {
      releasedStandIn = null;
    }
  }
  return releasedStandIn;
}

/**
 * Decode the pack and make its textures. Resolves with one PhotoMaterial per id (plus non-enumerable
 * restore/dispose/gpuBytes/failed). Never rejects.
 */
export async function loadPhotoMaterials(renderer: THREE.WebGLRenderer, quality: PhotoQuality = 'high'): Promise<PhotoMaterials> {
  const div = DIVISOR[quality] ?? 1;
  let maxAniso = 1;
  try {
    maxAniso = renderer.capabilities.getMaxAnisotropy();
  } catch {
    maxAniso = 1;
  }
  const aniso = Math.max(1, Math.min(maxAniso, quality === 'low' ? 2 : isPhone() ? 4 : 8));
  const failed: string[] = [];
  const result: Record<string, PhotoMaterial> = {};
  const jobs: { tex: THREE.Texture; data: PhotoImageData; size: number; name: string; set: PhotoSetData; slot: Slot }[] = [];
  const all: THREE.Texture[] = [];
  let gpuBytes = 0;
  let disposed = false;

  for (const id of PHOTO_MATERIAL_IDS) {
    const set = PHOTO_PACK[id];
    const tex: Partial<Record<Slot, THREE.Texture>> = {};
    for (const { slot, data } of imagesOf(set)) {
      const size = Math.max(4, Math.floor(data.size / div));
      const t = new THREE.Texture();
      t.name = `photo.${id}.${slot}`;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.flipY = false;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.anisotropy = aniso;
      t.colorSpace = slot === 'map' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      // after the upload, drop the decoded pixels (CPU memory counts against the iOS tab budget)
      t.onUpdate = (tt: THREE.Texture) => {
        const img: unknown = tt.image;
        const s = standIn();
        if (s && img && img !== s) {
          closeSource(img);
          tt.image = s;
        }
      };
      tex[slot] = t;
      all.push(t);
      gpuBytes += (size * size * 16) / 3;
      jobs.push({ tex: t, data, size, name: `${id}.${slot}`, set, slot });
    }
    result[id] = {
      map: tex.map as THREE.Texture,
      normalMap: tex.normalMap as THREE.Texture,
      ormMap: tex.ormMap as THREE.Texture,
      alphaMap: tex.alphaMap ?? null,
      tileMetres: set.tileMetres,
      meanAlbedo: set.meanAlbedo,
      meanRoughness: set.meanRoughness,
      meanMetalness: set.meanMetalness,
    };
  }

  const fill = async (): Promise<void> => {
    failed.length = 0;
    for (const j of jobs) {
      if (disposed) return;
      try {
        const src = await decode(j.data, j.size);
        if (disposed) {
          closeSource(src);
          return;
        }
        j.tex.image = src;
      } catch {
        failed.push(j.name);
        try {
          j.tex.image = flatSource(fallbackValue(j.set, j.slot));
        } catch {
          continue;
        }
        j.tex.generateMipmaps = false;
        j.tex.minFilter = THREE.LinearFilter;
      }
      j.tex.needsUpdate = true;
    }
  };
  try {
    await fill();
  } catch {
    /* fill() handles each image; nothing else can throw */
  }

  Object.defineProperties(result, {
    restore: {
      enumerable: false,
      value: async (): Promise<void> => {
        try {
          await fill();
        } catch {
          /* never rejects */
        }
      },
    },
    dispose: {
      enumerable: false,
      value: (): void => {
        disposed = true;
        for (const t of all) {
          closeSource(t.image);
          t.dispose();
        }
      },
    },
    gpuBytes: { enumerable: false, value: Math.round(gpuBytes) },
    failed: { enumerable: false, value: failed },
  });
  return result as unknown as PhotoMaterials;
}
