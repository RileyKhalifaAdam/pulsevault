// Quality-tier auto-detection (src/render/post/detect.ts): pure classification, no GL, no DOM.

import { describe, expect, it } from 'vitest';
import { classifyGpu } from '../src/render/post/detect';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const phone = (w: number, h: number, dpr: number, ua = IPHONE_UA) => ({
  userAgent: ua,
  maxTouchPoints: 5,
  devicePixelRatio: dpr,
  screenWidth: w,
  screenHeight: h,
});
const desktop = (ua: string, extra: { deviceMemory?: number; hardwareConcurrency?: number } = {}) => ({
  userAgent: ua,
  maxTouchPoints: 0,
  devicePixelRatio: 2,
  screenWidth: 1728,
  screenHeight: 1117,
  ...extra,
});

describe('classifyGpu', () => {
  it('puts the iPhone 15 class on high (Safari masks the GPU as "Apple GPU")', () => {
    for (const [w, h] of [
      [393, 852],
      [852, 393],
      [430, 932],
      [390, 844],
    ]) {
      const info = classifyGpu('Apple GPU', 16384, true, phone(w, h, 3));
      expect(info.tier).toBe('high');
      expect(info.mobile).toBe(true);
      expect(info.software).toBe(false);
    }
  });

  it('keeps small and @2x iPhones on medium, iPads on high', () => {
    expect(classifyGpu('Apple GPU', 16384, true, phone(375, 812, 3)).tier).toBe('medium');
    expect(classifyGpu('Apple GPU', 16384, true, phone(375, 667, 2)).tier).toBe('medium');
    expect(classifyGpu('Apple GPU', 16384, true, { ...phone(820, 1180, 2, MAC_UA) }).tier).toBe('high'); // iPadOS desktop UA
  });

  it('renders the target look under device emulation with a software rasteriser', () => {
    const info = classifyGpu('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', 8192, true, phone(393, 852, 2));
    expect(info.tier).toBe('high');
    expect(info.software).toBe(true);
  });

  it('falls back to low without float render targets, big textures or memory', () => {
    expect(classifyGpu('Apple GPU', 16384, false, phone(393, 852, 3)).tier).toBe('low');
    expect(classifyGpu('Apple GPU', 2048, true, phone(393, 852, 3)).tier).toBe('low');
    expect(classifyGpu('ANGLE (NVIDIA GeForce RTX 3070)', 16384, true, desktop(WIN_UA, { deviceMemory: 2 })).tier).toBe('low');
    expect(classifyGpu('llvmpipe (LLVM 15.0.7, 256 bits)', 16384, true, desktop(WIN_UA)).tier).toBe('low');
  });

  it('grades Android and desktop GPUs by their renderer string', () => {
    expect(classifyGpu('Adreno (TM) 740', 16384, true, phone(412, 915, 2.6, ANDROID_UA)).tier).toBe('high');
    expect(classifyGpu('Adreno (TM) 650', 16384, true, phone(412, 915, 2.6, ANDROID_UA)).tier).toBe('medium');
    expect(classifyGpu('Mali-G52', 8192, true, phone(360, 800, 2, ANDROID_UA)).tier).toBe('low');
    expect(classifyGpu('ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)', 16384, true, desktop(MAC_UA)).tier).toBe('ultra');
    expect(classifyGpu('ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)', 16384, true, desktop(WIN_UA, { hardwareConcurrency: 16 })).tier).toBe('ultra');
    expect(classifyGpu('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)', 16384, true, desktop(WIN_UA, { hardwareConcurrency: 8 })).tier).toBe('medium');
    expect(classifyGpu('ANGLE (NVIDIA, NVIDIA GeForce RTX 4070)', 16384, true, desktop(WIN_UA, { hardwareConcurrency: 4 })).tier).toBe('medium');
  });
});
