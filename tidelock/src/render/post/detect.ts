// Quality-tier detection from what a browser will tell us: the user agent, the screen, and (where it is
// not masked) the WebGL renderer string. Safari hides the GPU behind "Apple GPU", so iPhones are
// classified by screen class instead; the dynamic-resolution controller absorbs what this gets wrong.

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface GpuInfo {
  /** Recommended tier for this device. */
  tier: QualityTier;
  /** Unmasked renderer string, or the masked one, or ''. */
  renderer: string;
  /** Software rasteriser (SwiftShader, llvmpipe…): frame times say nothing about the image. */
  software: boolean;
  mobile: boolean;
}

interface EnvLike {
  userAgent: string;
  maxTouchPoints: number;
  devicePixelRatio: number;
  screenWidth: number;
  screenHeight: number;
  deviceMemory?: number;
  hardwareConcurrency?: number;
}

const ORDER: QualityTier[] = ['low', 'medium', 'high', 'ultra'];
const atMost = (t: QualityTier, cap: QualityTier): QualityTier => (ORDER.indexOf(t) > ORDER.indexOf(cap) ? cap : t);

/** Pure classification (exported for tests / harnesses). */
export function classifyGpu(renderer: string, maxTextureSize: number, floatTargets: boolean, env: EnvLike): GpuInfo {
  const ua = env.userAgent;
  const software = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
  const iOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && env.maxTouchPoints > 1);
  const android = /Android/i.test(ua);
  const mobile = iOS || android;
  const short = Math.min(env.screenWidth, env.screenHeight);
  let tier: QualityTier;

  if (iOS && software) {
    // A real iPhone never reports a software rasteriser: this is device emulation in a test browser
    // (headless screenshots). Render what the target device would, so captures show the shipped look.
    tier = 'high';
  } else if (iOS) {
    if (short >= 744) {
      tier = 'high'; // iPad: plenty of GPU, but far more pixels than a phone
    } else if (env.devicePixelRatio >= 3 && short >= 390) {
      tier = 'high'; // iPhone 12 and later (390/393/428/430 pt @3x) — the iPhone 15 class we target
    } else {
      tier = 'medium'; // 375 pt @3x (X/XS/mini) and every @2x phone
    }
  } else if (android) {
    if (/Adreno \(TM\) (7[3-9]\d|8\d\d)|Immortalis|Mali-G7[1-9]\d|Xclipse 9/i.test(renderer)) tier = 'high';
    else if (/Adreno \(TM\) (6[4-9]\d|7[0-2]\d)|Mali-G(7\d|6[1-9]\d)|Xclipse/i.test(renderer)) tier = 'medium';
    else tier = 'low';
  } else if (software) {
    tier = 'low';
  } else if (/Apple M\d|RTX|GTX 1[06-9]|GTX [2-9]|Radeon (RX|Pro)|Arc\(TM\) A|Quadro/i.test(renderer)) {
    tier = 'ultra';
  } else if (/Intel|Iris|UHD|HD Graphics|Mali|Adreno|PowerVR/i.test(renderer)) {
    tier = 'medium';
  } else {
    tier = 'high'; // masked or unknown desktop GPU
  }

  // Capability and memory caps.
  if (!floatTargets || maxTextureSize < 4096) tier = 'low';
  if (env.deviceMemory !== undefined && env.deviceMemory <= 2) tier = atMost(tier, 'low');
  else if (env.deviceMemory !== undefined && env.deviceMemory <= 4) tier = atMost(tier, 'medium');
  if (!iOS && env.hardwareConcurrency !== undefined && env.hardwareConcurrency <= 4) tier = atMost(tier, 'medium');

  return { tier, renderer, software, mobile };
}

export function detectGpu(gl: WebGL2RenderingContext, floatTargets: boolean): GpuInfo {
  let renderer = '';
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = String((dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) ?? '');
  } catch {
    renderer = '';
  }
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const scr = typeof screen !== 'undefined' ? screen : undefined;
  const env: EnvLike = {
    userAgent: nav?.userAgent ?? '',
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
    screenWidth: scr?.width ?? 1280,
    screenHeight: scr?.height ?? 720,
    deviceMemory: (nav as (Navigator & { deviceMemory?: number }) | undefined)?.deviceMemory,
    hardwareConcurrency: nav?.hardwareConcurrency,
  };
  return classifyGpu(renderer, Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0, floatTargets, env);
}
