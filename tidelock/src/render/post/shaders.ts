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
 * averaged colour then goes through a soft-knee bright pass keyed on the max channel, which keeps
 * saturated emitters (red dwarfs, amber strips) blooming in their own colour.
 * `uStep` is half a destination texel, i.e. one source texel of an ideal 2:1 chain; it is tied to the
 * bloom target, not the scene target, so the footprint does not change with dynamic resolution.
 */
export const BLOOM_PREFILTER_FRAG = /* glsl */ `
precision highp float;
uniform highp sampler2D tSrc;
uniform vec2 uStep;
uniform vec4 uCurve;   // threshold, threshold - knee, 2 * knee, 0.25 / knee
uniform float uClamp;
in vec2 vUv;
out vec4 outColor;

vec3 tap(float x, float y) {
  vec3 c = texture(tSrc, vUv + vec2(x, y) * uStep).rgb;
  // A NaN or Inf from a scene shader would otherwise be smeared over the whole screen by the chain.
  float s = c.r + c.g + c.b;
  if (isnan(s) || isinf(s) || !(s >= 0.0)) c = vec3(0.0);
  return min(max(c, vec3(0.0)), vec3(uClamp));
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
 * Composite: scene (+ sharpen, chromatic aberration, screen-space effects) + bloom -> exposure ->
 * vignette -> AgX tone map -> look / split-tone grade -> sRGB -> dither (+ grain when this is the last
 * pass).
 *
 * Compile-time switches (set from the quality tier):
 *   FINAL      last pass (MSAA tiers): add film grain, alpha = 1. Otherwise alpha carries luma for FXAA.
 *   CHROMA     edge chromatic aberration (2 extra scene taps)
 *   SHARPEN    unsharp mask in a compressed HDR space (4 extra scene taps)
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
uniform vec4 uLens;         // vignette, aberration (output px at the long-axis edge), sharpen, time (s)
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

// ---- AgX (Troy Sobotka), constants as in three.js / Filament (Rec.2020 working primaries).
// Chosen over an ACES fit because it rolls saturated emitters off toward white along their own hue:
// an ember-orange star stays orange in its halo instead of skewing yellow, blue does not turn purple.
const mat3 SRGB_TO_REC2020 = mat3(
  vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
const mat3 REC2020_TO_SRGB = mat3(
  vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
const mat3 AGX_INSET = mat3(
  vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
  vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
  vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
const mat3 AGX_OUTSET = mat3(
  vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
  vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
  vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
const float AGX_MIN_EV = -12.47393;
const float AGX_MAX_EV = 4.026069;

vec3 agxCurve(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

// Symmetric power S-curve through 0, 0.5 and 1 (0.5 is where AgX puts 18 % grey).
vec3 sCurve(vec3 x, float k) {
  vec3 lo = 0.5 * pow(2.0 * x, vec3(k));
  vec3 hi = 1.0 - 0.5 * pow(2.0 - 2.0 * x, vec3(k));
  return mix(lo, hi, step(vec3(0.5), x));
}

vec3 toneMap(vec3 c, float contrast, float saturation) {
  c = AGX_INSET * (SRGB_TO_REC2020 * c);
  c = clamp((log2(max(c, vec3(1e-10))) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV), 0.0, 1.0);
  c = clamp(agxCurve(c), 0.0, 1.0);
  // look, in the log-encoded domain (as AgX looks are defined): contrast, then saturation
  c = sCurve(c, contrast);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = l + (c - l) * saturation;
  c = AGX_OUTSET * c;
  c = pow(max(c, vec3(0.0)), vec3(2.2));
  return clamp(REC2020_TO_SRGB * c, 0.0, 1.0);
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
    // Radial chromatic stretch: smear toward the centre with the spectrum laid along the streak.
    float jit = ign(gl_FragCoord.xy + uGrain.z * 5.588238);
    float amount = jump * (0.06 + 0.34 * smoothstep(0.0, 1.2, r2));
    vec3 acc = vec3(0.0);
    vec3 wsum = vec3(0.0);
    for (int i = 0; i < 10; i++) {
      float t = (float(i) + jit) / 10.0;
      vec3 w = spectrum(t);
      acc += w * sceneTap(0.5 + (uv - 0.5) * (1.0 - amount * t));
      wsum += w;
    }
    col = acc / wsum;
    col *= 1.0 + jump * 0.8 * (1.0 - smoothstep(0.0, 0.5, r2));   // the tunnel mouth brightens
  } else {
    col = sceneTap(uv);
#ifdef SHARPEN
    vec3 sharp = vec3(0.0);
    if (uLens.z > 0.0) {
      // Unsharp mask in a Reinhard-compressed space so HDR edges do not ring.
      vec3 cc = col / (1.0 + maxc(col));
      vec3 n0 = sceneTap(uv + vec2(uSceneTexel.x, 0.0));
      vec3 n1 = sceneTap(uv - vec2(uSceneTexel.x, 0.0));
      vec3 n2 = sceneTap(uv + vec2(0.0, uSceneTexel.y));
      vec3 n3 = sceneTap(uv - vec2(0.0, uSceneTexel.y));
      vec3 blur = (n0 / (1.0 + maxc(n0)) + n1 / (1.0 + maxc(n1)) + n2 / (1.0 + maxc(n2)) + n3 / (1.0 + maxc(n3))) * 0.25;
      vec3 sc = clamp(cc + (cc - blur) * uLens.z, 0.0, 0.995);
      sharp = sc / (1.0 - maxc(sc)) - col;
    }
#endif
#ifdef CHROMA
    if (uLens.y > 0.0) {
      // Lateral chromatic aberration: red scales out, blue scales in, growing with r^2 — zero on axis.
      vec2 off = pn * (r2 * uLens.y) / uOutSize;
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
  col += bloom * uTone.y;

  // ---- exposure, natural (cos^4-like) vignette, scene-referred effect light
  float vig = 1.0 / (1.0 + e2 * uLens.x);
  col *= uTone.x * vig * vig;
  float flash = uFx.w;
  col = col * (1.0 + 3.0 * flash) + vec3(flash * flash * 2.0);
  if (heat > 0.0) {
    float lick = vnoise(vec2(uv.x * 5.0, uv.y * 3.0 - time * 1.8)) * 0.6 + 0.4;
    col += vec3(1.0, 0.34, 0.07) * (heat * heat * 1.4 * lick * smoothstep(0.45, 2.0, e2));
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
    float edge = smoothstep(0.25, 1.9, e2) * dmg * pulse;
    float grey = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, vec3(grey), 0.35 * dmg);
    col = mix(col, col * vec3(1.0, 0.16, 0.12) + vec3(0.42, 0.012, 0.0), edge);
  }
  col = mix(col, vec3(1.0), smoothstep(0.0, 1.0, flash));

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
 * edges. The sub-pixel blend is kept low: a full-strength one eats one-pixel stars and dims thin lines.
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
#define SUBPIX 0.35
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
    finalOff = max(finalOff, sub * sub * SUBPIX);

    vec2 uvF = vUv;
    if (horz) uvF.y += finalOff * stepLen; else uvF.x += finalOff * stepLen;
    rgb = texture(tSrc, uvF).rgb;
  }

  outColor = vec4(filmGrain(rgb, gl_FragCoord.xy, uGrain), 1.0);
}
`;
