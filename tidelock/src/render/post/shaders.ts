// GLSL ES 3.00 sources for the TIDELOCK post chain (see ../pipeline.ts).
//
// Every pass is one full-screen triangle drawn with a RawShaderMaterial (glslVersion GLSL3), so nothing
// from three's shader chunks is pulled in and the output encoding is done exactly once, by hand, in the
// composite pass. All colour maths runs in highp: half-float HDR values and UV offsets of a fraction of a
// texel do not survive mediump on every phone GPU.

export const FULLSCREEN_VERT = /* glsl */ `
precision highp float;
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------- bloom

/**
 * First bloom pass: HDR scene -> half resolution. 13-tap (Jimenez / COD:AW) downsample whose five 2x2
 * groups are combined with a Karis average (weights 1 / (1 + max channel)), so a single very bright
 * texel — a star point, a specular sparkle — cannot flare into a flickering blob ("firefly"). The
 * averaged colour (already exposed) then goes through a soft-knee bright pass keyed on the max channel,
 * which keeps saturated emitters (red dwarfs, amber strips) blooming in their own colour.
 * `uStep` is half a destination texel (one source texel when the scene is exactly twice the bloom
 * target); it is tied to the bloom target, not the scene target, so the footprint does not change with
 * dynamic resolution or the tier's pixel ratio.
 */
export const BLOOM_PREFILTER_FRAG = /* glsl */ `
precision highp float;
uniform highp sampler2D tSrc;
uniform vec2 uStep;
uniform vec4 uCurve;   // threshold, threshold - knee, 2 * knee, 0.25 / knee
uniform float uClamp;
uniform float uExposure;
in vec2 vUv;
out vec4 outColor;

vec3 tap(float x, float y) {
  vec3 c = texture(tSrc, vUv + vec2(x, y) * uStep).rgb;
  // A NaN or Inf from a scene shader would otherwise be smeared over the whole screen by the chain.
  float s = c.r + c.g + c.b;
  if (isnan(s) || isinf(s) || !(s >= 0.0)) c = vec3(0.0);
  // Exposed values: what blooms is what ends up brighter than display white, at any exposure.
  // The ceiling is applied to the max channel — a per-channel clamp would turn a bright orange yellow.
  c = max(c * uExposure, vec3(0.0));
  return c * min(1.0, uClamp / max(max(c.r, max(c.g, c.b)), 1e-4));
}
float maxc(vec3 c) { return max(c.r, max(c.g, c.b)); }

void main() {
  vec3 a = tap(-2.0,  2.0), b = tap(0.0,  2.0), c = tap(2.0,  2.0);
  vec3 d = tap(-2.0,  0.0), e = tap(0.0,  0.0), f = tap(2.0,  0.0);
  vec3 g = tap(-2.0, -2.0), h = tap(0.0, -2.0), i = tap(2.0, -2.0);
  vec3 j = tap(-1.0,  1.0), k = tap(1.0,  1.0);
  vec3 l = tap(-1.0, -1.0), m = tap(1.0, -1.0);

  vec3 g0 = (a + b + d + e) * 0.25;
  vec3 g1 = (b + c + e + f) * 0.25;
  vec3 g2 = (d + e + g + h) * 0.25;
  vec3 g3 = (e + f + h + i) * 0.25;
  vec3 g4 = (j + k + l + m) * 0.25;
  float w0 = 0.125 / (1.0 + maxc(g0));
  float w1 = 0.125 / (1.0 + maxc(g1));
  float w2 = 0.125 / (1.0 + maxc(g2));
  float w3 = 0.125 / (1.0 + maxc(g3));
  float w4 = 0.5 / (1.0 + maxc(g4));
  vec3 col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);

  // soft-knee threshold
  float br = maxc(col);
  float rq = clamp(br - uCurve.y, 0.0, uCurve.z);
  rq = uCurve.w * rq * rq;
  col *= max(rq, br - uCurve.x) / max(br, 1e-4);
  outColor = vec4(col, 1.0);
}
`;

/** Bloom downsample, level n -> n+1: the same 13-tap kernel with its plain weights. */
export const BLOOM_DOWN_FRAG = /* glsl */ `
precision highp float;
uniform highp sampler2D tSrc;
uniform vec2 uStep;
in vec2 vUv;
out vec4 outColor;

vec3 tap(float x, float y) { return texture(tSrc, vUv + vec2(x, y) * uStep).rgb; }

void main() {
  vec3 e = tap(0.0, 0.0);
  vec3 corners = tap(-2.0, 2.0) + tap(2.0, 2.0) + tap(-2.0, -2.0) + tap(2.0, -2.0);
  vec3 edges = tap(0.0, 2.0) + tap(-2.0, 0.0) + tap(2.0, 0.0) + tap(0.0, -2.0);
  vec3 inner = tap(-1.0, 1.0) + tap(1.0, 1.0) + tap(-1.0, -1.0) + tap(1.0, -1.0);
  outColor = vec4(e * 0.125 + corners * 0.03125 + edges * 0.0625 + inner * 0.125, 1.0);
}
`;

/**
 * Bloom upsample, level n+1 -> n: 3x3 tent of the coarser level, alpha-blended over the finer level
 * that is already in the target (dst = tent * scatter + dst * (1 - scatter)). The chain is therefore a
 * normalised sum of ever wider blurs; `uScatter` moves energy between the tight core and the wide halo.
 */
export const BLOOM_UP_FRAG = /* glsl */ `
precision highp float;
uniform highp sampler2D tSrc;
uniform vec2 uStep;     // one texel of the coarser level
uniform float uScatter;
in vec2 vUv;
out vec4 outColor;

void main() {
  vec4 o = uStep.xyxy * vec4(1.0, 1.0, -1.0, 0.0);
  vec3 s = texture(tSrc, vUv).rgb * 4.0;
  s += (texture(tSrc, vUv - o.xw).rgb + texture(tSrc, vUv + o.xw).rgb
      + texture(tSrc, vUv - o.wy).rgb + texture(tSrc, vUv + o.wy).rgb) * 2.0;
  s += texture(tSrc, vUv - o.xy).rgb + texture(tSrc, vUv + o.xy).rgb
     + texture(tSrc, vUv - o.zy).rgb + texture(tSrc, vUv + o.zy).rgb;
  outColor = vec4(s * 0.0625, uScatter);
}
`;

// ---------------------------------------------------------------------------------------------- shared

/** Noise helpers shared by the composite and FXAA passes (film grain must be added after the AA). */
const NOISE = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// Interleaved gradient noise: a well distributed screen-space pattern, cheap enough for a dither.
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
// uGrain: amount, cell size in px, per-frame seed, unused. Works on sRGB-encoded colour.
vec3 filmGrain(vec3 srgb, vec2 fragCoord, vec4 grain) {
  vec2 p = fragCoord / grain.y + grain.z * vec2(17.13, 9.71);
  vec2 ip = floor(p);
  vec2 fp = fract(p);
  fp = fp * fp * (3.0 - 2.0 * fp);
  float n = mix(mix(hash12(ip), hash12(ip + vec2(1.0, 0.0)), fp.x),
                mix(hash12(ip + vec2(0.0, 1.0)), hash12(ip + vec2(1.0, 1.0)), fp.x), fp.y);
  n = n + hash12(fragCoord + grain.z * 3.7) - 1.0;           // soft cell + per-pixel tooth, -1..1
  float l = dot(srgb, vec3(0.299, 0.587, 0.114));
  // Photographic response: nothing in true black (space stays black), strongest in the mid-tones.
  float amp = smoothstep(0.0, 0.10, l) * (1.0 - 0.55 * l);
  return srgb + n * grain.x * amp;
}
`;

// ---------------------------------------------------------------------------------------------- composite

/**
 * Composite: scene (+ sharpen, chromatic aberration, screen-space effects) -> exposure -> + bloom ->
 * vignette -> hue-preserving filmic tone map -> split-tone grade -> sRGB -> dither (+ grain when this is
 * the last pass).
 *
 * Compile-time switches (set from the quality tier):
 *   FINAL      last pass (MSAA tiers): add film grain, alpha = 1. Otherwise alpha carries luma for FXAA.
 *   CHROMA     edge chromatic aberration (2 extra scene taps)
 *   SHARPEN    contrast-adaptive sharpening in a compressed HDR space (4 extra scene taps)
 *   BLOOM_HQ   4-tap tent when magnifying the half-res bloom
 * Screen-space effects are uniform-driven branches of this one program, so triggering a jump never
 * compiles a shader mid-flight.
 */
export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
uniform highp sampler2D tScene;
uniform highp sampler2D tBloom;
uniform vec2 uSceneTexel;   // 1 / internal resolution
uniform vec2 uBloomTexel;   // 1 / bloom level-0 resolution
uniform vec2 uOutSize;      // output size, px
uniform vec4 uTone;         // exposure (linear), bloom strength, contrast, saturation
uniform vec4 uLens;         // vignette, aberration (output px in the corners), sharpen, time (s)
uniform vec3 uShadowTint;
uniform vec3 uHighTint;
uniform vec4 uFx;           // jump, damage, heat, flash
uniform vec4 uGrain;        // amount, cell size px, frame seed, unused
in vec2 vUv;
out vec4 outColor;

${NOISE}

float maxc(vec3 c) { return max(c.r, max(c.g, c.b)); }

float vnoise(vec2 p) {
  vec2 ip = floor(p);
  vec2 fp = fract(p);
  fp = fp * fp * (3.0 - 2.0 * fp);
  return mix(mix(hash12(ip), hash12(ip + vec2(1.0, 0.0)), fp.x),
             mix(hash12(ip + vec2(0.0, 1.0)), hash12(ip + vec2(1.0, 1.0)), fp.x), fp.y);
}

// ---- Display transform: a hue-preserving filmic curve.
// A per-channel curve (ACES fit, AgX…) clips the channels of a bright saturated emitter one after the
// other, so an ember-orange star slides through yellow to white and deep blue goes purple. Here the curve
// is applied to one norm (the max channel) and the colour keeps its chromaticity; very bright values then
// travel toward white along a straight line in Oklab's cone space, where hue is perceptually constant.
// The scalar curve is the ACES RRT+ODT fit (S. Hill) at the exposure three.js uses, so neutral tones land
// exactly where art tuned under ACESFilmicToneMapping expects them: 0.18 -> 0.21, 1.0 -> 0.76.
float filmic(float x) {
  x *= 1.0 / 0.6;
  return clamp((x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.4329510) + 0.238081), 0.0, 1.0);
}
const mat3 RGB_TO_LMS = mat3(
  vec3(0.4122214708, 0.2119034982, 0.0883024619),
  vec3(0.5363325363, 0.6806995451, 0.2817188376),
  vec3(0.0514459929, 0.1073969566, 0.6299787005));
const mat3 LMS_TO_RGB = mat3(
  vec3(4.0767416621, -1.2684380046, -0.0041960863),
  vec3(-3.3077115913, 2.6097574011, -0.7034186147),
  vec3(0.2309699292, -0.3413193965, 1.7076147010));
// How fast over-range colour whitens: 8 % at 8x display white, 32 % at 40x, 43 % at 64x. Slow enough
// that a star disc at 40 is still clearly its own colour, fast enough that it reads as hot.
const float WHITEN = 0.012;

vec3 toneMap(vec3 c, float contrast, float saturation) {
  float peak = max(maxc(c), 1e-6);
  float p = 0.18 * pow(peak / 0.18, contrast);     // contrast pivots on mid grey, on the norm only
  float m = filmic(p);
  vec3 col = c * (m / peak);                       // same chromaticity, display range
  vec3 lms = pow(max(RGB_TO_LMS * col, vec3(0.0)), vec3(1.0 / 3.0));
  float L = dot(lms, vec3(0.2104542553, 0.7936177850, -0.0040720468));   // Oklab lightness
  lms = L + (lms - L) * saturation;                // scales Oklab chroma at constant hue and lightness
  float w = 1.0 - 1.0 / (1.0 + WHITEN * max(p - 1.0, 0.0));
  lms = mix(lms, vec3(pow(m, 1.0 / 3.0)), w);      // toward white at the same peak
  return clamp(LMS_TO_RGB * (lms * lms * lms), 0.0, 1.0);
}

vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

vec3 sceneTap(vec2 uv) { return max(texture(tScene, uv).rgb, vec3(0.0)); }

// Spectral weights for the jump smear: t = 0 blue end .. 1 red end. Sums to a neutral white.
vec3 spectrum(float t) {
  return clamp(vec3(1.5 - abs(4.0 * t - 3.0), 1.5 - abs(4.0 * t - 2.0), 1.5 - abs(4.0 * t - 1.0)), 0.0, 1.0);
}

void main() {
  vec2 uv = vUv;
  vec2 d = uv - 0.5;
  // px from the centre, normalised so the long screen axis spans -1..1 (round on any aspect)
  vec2 pn = d * uOutSize / (0.5 * max(uOutSize.x, uOutSize.y));
  float r2 = dot(pn, pn);
  // 0 at the centre, 1 at the edge midpoints, 2 in the corners (elliptical, follows the frame)
  float e2 = 4.0 * dot(d, d);
  // lens coordinates: round, |pv| = 1 in the frame corners (the image circle of a real lens)
  vec2 pv = d * uOutSize * (2.0 / length(uOutSize));
  float rv2 = dot(pv, pv);
  float time = uLens.w;

  // ---- heat haze: refraction shimmer rising up the screen, stronger toward the frame edge
  float heat = uFx.z;
  if (heat > 0.0) {
    vec2 hp = vec2(uv.x * uOutSize.x / uOutSize.y, uv.y) * 7.0;
    vec2 n = vec2(vnoise(hp + vec2(0.0, -time * 2.1)), vnoise(hp * 1.3 + vec2(31.7, -time * 2.6))) - 0.5;
    n += 0.5 * (vec2(vnoise(hp * 2.9 + vec2(7.3, -time * 4.3)), vnoise(hp * 3.3 + vec2(13.1, -time * 3.7))) - 0.5);
    uv += n * heat * (0.35 + 0.65 * smoothstep(0.1, 1.3, e2)) * vec2(0.010, 0.006);
  }

  // ---- scene colour
  vec3 col;
  float jump = uFx.x;
  if (jump > 0.0) {
    // Radial stretch: every point streaks away from the vanishing point, longer toward the frame
    // edge, with a restrained dispersion (blue leads, red trails) rather than a full rainbow.
    float jit = ign(gl_FragCoord.xy + uGrain.z * 5.588238);
    float amount = jump * (0.05 + 0.3 * smoothstep(0.0, 1.2, r2));
    vec3 acc = vec3(0.0);
    vec3 wsum = vec3(0.0);
    for (int i = 0; i < 16; i++) {
      float t = (float(i) + jit) / 16.0;
      vec3 w = mix(vec3(1.0), spectrum(t) * 2.0, 0.45) * (1.0 - 0.6 * t);   // streaks fade along their length
      acc += w * sceneTap(0.5 + (uv - 0.5) * (1.0 - amount * t));
      wsum += w;
    }
    col = acc / wsum;
    col *= 1.0 + jump * (1.5 * smoothstep(0.0, 1.2, r2) + 0.8 * (1.0 - smoothstep(0.0, 0.4, r2)));
  } else {
    col = sceneTap(uv);
#ifdef SHARPEN
    vec3 sharp = vec3(0.0);
    if (uLens.z > 0.0) {
      // Contrast-adaptive sharpening (after AMD CAS) in a Reinhard-compressed space. The amount falls
      // to zero where the neighbourhood already spans the range — an emissive strip on a hull, a star on
      // black — so HDR edges get no halo and no hue shift; only soft, low-contrast detail is lifted.
      vec3 n0 = sceneTap(uv + vec2(uSceneTexel.x, 0.0));
      vec3 n1 = sceneTap(uv - vec2(uSceneTexel.x, 0.0));
      vec3 n2 = sceneTap(uv + vec2(0.0, uSceneTexel.y));
      vec3 n3 = sceneTap(uv - vec2(0.0, uSceneTexel.y));
      vec3 cc = col / (1.0 + maxc(col));
      n0 /= 1.0 + maxc(n0);
      n1 /= 1.0 + maxc(n1);
      n2 /= 1.0 + maxc(n2);
      n3 /= 1.0 + maxc(n3);
      const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
      float l0 = dot(cc, LUMA), la = dot(n0, LUMA), lb = dot(n1, LUMA), lc = dot(n2, LUMA), ld = dot(n3, LUMA);
      float mn = min(l0, min(min(la, lb), min(lc, ld)));
      float mx = max(l0, max(max(la, lb), max(lc, ld)));
      float amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, 1e-4), 0.0, 1.0));
      float w = -0.2 * amp * min(uLens.z, 1.0);
      // …and the result may not leave the range of its neighbourhood, per channel: transitions get
      // steeper, but nothing overshoots into a ring (a blue outline around an amber strip).
      vec3 lo = min(cc, min(min(n0, n1), min(n2, n3)));
      vec3 hi = max(cc, max(max(n0, n1), max(n2, n3)));
      vec3 sc = clamp((cc + (n0 + n1 + n2 + n3) * w) / (1.0 + 4.0 * w), lo, min(hi, vec3(0.995)));
      sharp = sc / (1.0 - maxc(sc)) - col;
    }
#endif
#ifdef CHROMA
    if (uLens.y > 0.0) {
      // Lateral chromatic aberration: red scales out, blue scales in. It grows with r^5 — nothing over
      // the middle of the frame, uLens.y output px in the very corners — and stays well under a pixel:
      // any more and one-pixel HDR lines and star points split into coloured ghosts.
      vec2 off = pv * (rv2 * rv2 * uLens.y) / uOutSize;
      col.r = sceneTap(uv - off).r;
      col.b = sceneTap(uv + off).b;
    }
#endif
#ifdef SHARPEN
    col = max(col + sharp, vec3(0.0));
#endif
  }

  // ---- bloom
#ifdef BLOOM_HQ
  vec4 bo = uBloomTexel.xyxy * vec4(0.5, 0.5, -0.5, 0.5);
  vec3 bloom = 0.25 * (texture(tBloom, uv + bo.xy).rgb + texture(tBloom, uv - bo.xy).rgb
                     + texture(tBloom, uv + bo.zw).rgb + texture(tBloom, uv - bo.zw).rgb);
#else
  vec3 bloom = texture(tBloom, uv).rgb;
#endif
  // The bloom chain was built from exposed values (see the prefilter), the scene taps were not.
  col = col * uTone.x + bloom * uTone.y;

  // ---- natural (cos^4-like) vignette over the image circle, scene-referred effect light
  float vig = 1.0 / (1.0 + rv2 * uLens.x);
  col *= vig * vig;
  float flash = uFx.w;
  col = col * (1.0 + 4.0 * flash) + vec3(flash * flash * 3.0 * (1.0 - 0.6 * rv2));
  if (heat > 0.0) {
    // Plasma sheath: fine filaments streaming up from the frame edges, additive and translucent so the
    // scene reads through them; only their densest cores go white-hot.
    vec2 hq = vec2(vUv.x * uOutSize.x / uOutSize.y, vUv.y);
    float s1 = vnoise(vec2(hq.x * 14.0, hq.y * 1.6 - time * 2.6));
    float s2 = vnoise(vec2(hq.x * 46.0 + 7.1, hq.y * 3.5 - time * 4.4));
    float s3 = vnoise(vec2(hq.x * 120.0 + 3.3, hq.y * 7.0 - time * 7.0));
    float streak = s1 * 0.5 + s2 * 0.32 + s3 * 0.18;
    float reach = smoothstep(0.95, 2.2, e2 + (streak - 0.5) * 0.8);
    float glow = heat * heat * reach * (0.2 + 1.6 * streak * streak);
    col += vec3(1.0, 0.24, 0.04) * glow + vec3(1.0, 0.55, 0.25) * (glow * glow * 0.8);
  }

  // ---- display transform + grade
  col = toneMap(col, uTone.z, uTone.w);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float lp = sqrt(l);
  col *= mix(vec3(1.0), uShadowTint, 1.0 - smoothstep(0.0, 0.55, lp))
       * mix(vec3(1.0), uHighTint, smoothstep(0.45, 1.0, lp));

  // ---- display-referred accents
  float dmg = uFx.y;
  if (dmg > 0.0) {
    float pulse = 0.82 + 0.18 * sin(time * 9.0);
    float edge = smoothstep(0.55, 2.0, e2);
    edge = edge * edge * dmg * pulse;
    float grey = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, vec3(grey), 0.35 * dmg);
    col = mix(col, col * vec3(1.0, 0.2, 0.15) + vec3(0.36, 0.008, 0.0), edge);
  }
  col = mix(col, vec3(1.0), flash * flash * flash);

  vec3 srgb = linearToSrgb(clamp(col, 0.0, 1.0));
#ifdef FINAL
  srgb = filmGrain(srgb, gl_FragCoord.xy, uGrain);
#endif
  // Triangular-PDF dither, one 8-bit step wide, faded out toward zero so true black stays true black.
  float u = ign(gl_FragCoord.xy + uGrain.z * 5.588238) * 2.0 - 1.0;
  float tri = sign(u) * (1.0 - sqrt(1.0 - abs(u)));
  srgb += tri * (1.0 / 255.0) * smoothstep(0.0, 2.0 / 255.0, srgb);
#ifdef FINAL
  outColor = vec4(srgb, 1.0);
#else
  outColor = vec4(srgb, dot(clamp(srgb, 0.0, 1.0), vec3(0.299, 0.587, 0.114)));
#endif
}
`;

// ---------------------------------------------------------------------------------------------- FXAA

/**
 * FXAA 3.11 (quality path, after Timothy Lottes) for the tiers without MSAA. Input is the sRGB-encoded
 * composite with luma in alpha; film grain is added here, after the filter, so it is not mistaken for
 * edges. The sub-pixel blend is moderate, reduced on one-pixel lines and almost off on isolated maxima:
 * a full-strength one eats stars and dims thin lines.
 */
export const FXAA_FRAG = /* glsl */ `
precision highp float;
uniform highp sampler2D tSrc;
uniform vec2 uTexel;
uniform vec4 uGrain;
in vec2 vUv;
out vec4 outColor;

${NOISE}

#define EDGE_MIN 0.0312
#define EDGE_REL 0.125
#define SUBPIX 0.5
#define SEARCH_STEPS 9

float stepSize(int i) {
  return i < 4 ? 1.0 : (i < 5 ? 1.5 : (i < 7 ? 2.0 : (i < 8 ? 4.0 : 8.0)));
}

void main() {
  vec4 m = texture(tSrc, vUv);
  float lM = m.a;
  float lN = textureOffset(tSrc, vUv, ivec2(0, 1)).a;
  float lS = textureOffset(tSrc, vUv, ivec2(0, -1)).a;
  float lE = textureOffset(tSrc, vUv, ivec2(1, 0)).a;
  float lW = textureOffset(tSrc, vUv, ivec2(-1, 0)).a;
  float lMin = min(lM, min(min(lN, lS), min(lE, lW)));
  float lMax = max(lM, max(max(lN, lS), max(lE, lW)));
  float range = lMax - lMin;
  vec3 rgb = m.rgb;

  if (range >= max(EDGE_MIN, lMax * EDGE_REL)) {
    float lNW = textureOffset(tSrc, vUv, ivec2(-1, 1)).a;
    float lNE = textureOffset(tSrc, vUv, ivec2(1, 1)).a;
    float lSW = textureOffset(tSrc, vUv, ivec2(-1, -1)).a;
    float lSE = textureOffset(tSrc, vUv, ivec2(1, -1)).a;
    float lNS = lN + lS;
    float lWE = lW + lE;
    float lWc = lNW + lSW;
    float lEc = lNE + lSE;
    float lNc = lNW + lNE;
    float lSc = lSW + lSE;
    float edgeH = abs(lWc - 2.0 * lW) + abs(lNS - 2.0 * lM) * 2.0 + abs(lEc - 2.0 * lE);
    float edgeV = abs(lNc - 2.0 * lN) + abs(lWE - 2.0 * lM) * 2.0 + abs(lSc - 2.0 * lS);
    bool horz = edgeH >= edgeV;

    float l1 = horz ? lS : lW;
    float l2 = horz ? lN : lE;
    float g1 = l1 - lM;
    float g2 = l2 - lM;
    bool steep1 = abs(g1) >= abs(g2);
    float gScaled = 0.25 * max(abs(g1), abs(g2));
    float stepLen = horz ? uTexel.y : uTexel.x;
    float lAvg;
    if (steep1) { stepLen = -stepLen; lAvg = 0.5 * (l1 + lM); } else { lAvg = 0.5 * (l2 + lM); }

    vec2 uvE = vUv;
    if (horz) uvE.y += stepLen * 0.5; else uvE.x += stepLen * 0.5;
    vec2 off = horz ? vec2(uTexel.x, 0.0) : vec2(0.0, uTexel.y);
    vec2 uv1 = uvE - off;
    vec2 uv2 = uvE + off;
    float e1 = texture(tSrc, uv1).a - lAvg;
    float e2 = texture(tSrc, uv2).a - lAvg;
    bool done1 = abs(e1) >= gScaled;
    bool done2 = abs(e2) >= gScaled;
    if (!done1) uv1 -= off;
    if (!done2) uv2 += off;
    for (int i = 2; i < SEARCH_STEPS; i++) {
      if (done1 && done2) break;
      if (!done1) { e1 = texture(tSrc, uv1).a - lAvg; done1 = abs(e1) >= gScaled; }
      if (!done2) { e2 = texture(tSrc, uv2).a - lAvg; done2 = abs(e2) >= gScaled; }
      float q = stepSize(i);
      if (!done1) uv1 -= off * q;
      if (!done2) uv2 += off * q;
    }
    float d1 = horz ? vUv.x - uv1.x : vUv.y - uv1.y;
    float d2 = horz ? uv2.x - vUv.x : uv2.y - vUv.y;
    bool near1 = d1 < d2;
    float pixOff = 0.5 - min(d1, d2) / (d1 + d2);
    bool mBelow = lM < lAvg;
    bool correct = ((near1 ? e1 : e2) < 0.0) != mBelow;
    float finalOff = correct ? pixOff : 0.0;

    float lAll = (2.0 * (lNS + lWE) + lWc + lEc) / 12.0;
    float sub = clamp(abs(lAll - lM) / range, 0.0, 1.0);
    sub = (3.0 - 2.0 * sub) * sub * sub;
    // A pixel that stands clear of all four neighbours is a star point, and one that stands clear of
    // both neighbours across the edge is the spine of a one-pixel line. Neither is a stair-step: the
    // sub-pixel low-pass would only dim them (a quarter-pixel blend with black halves a line's light).
    float lone = lM - max(max(lN, lS), max(lE, lW));
    float ridge = lM - max(l1, l2);
    float keep = lone > 0.6 * range ? 0.15 : (ridge > 0.5 * range ? 0.4 : 1.0);
    finalOff = max(finalOff, sub * sub * SUBPIX * keep);

    vec2 uvF = vUv;
    if (horz) uvF.y += finalOff * stepLen; else uvF.x += finalOff * stepLen;
    rgb = texture(tSrc, uvF).rgb;
  }

  outColor = vec4(filmGrain(rgb, gl_FragCoord.xy, uGrain), 1.0);
}
`;
