// GLSL ES 3.00 sources of the hybrid ray tracer (RawShaderMaterial, glslVersion GLSL3). The BVH layout and
// the traversal rules match src/render/rt/bvh.ts exactly (its JS mirror is what tests/bvh.test.ts checks).
import { FRONT_ONLY, MAX_ITERS, STACK_SIZE, TEX_MASK, TEX_SHIFT } from './bvh';

const HEAD = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp samplerCube;
#define PI 3.14159265
#define INF 1e30
`;

export const FULLSCREEN_VERT = /* glsl */ `
precision highp float;
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/** Shared by passes that turn a depth texel back into a ship-space point and read the G-buffer. */
const GBUF_READ = /* glsl */ `
uniform mat4 uInvVP;
vec3 shipPos(vec2 uv, float z) {
  vec4 p = uInvVP * vec4(uv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}
vec3 decN(vec3 e) { return normalize(e * 2.0 - 1.0 + 1e-6); }
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

// ------------------------------------------------------------------------------------------------ G-buffer

export const GBUF_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec3 normal;
in vec4 aSurf;
in vec4 aSurf2;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
out vec3 vN;
out vec4 vSurf;
out vec4 vSurf2;
void main() {
  vN = normal;
  vSurf = aSurf;
  vSurf2 = aSurf2;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const GBUF_FRAG = HEAD + /* glsl */ `
in vec3 vN;
in vec4 vSurf;
in vec4 vSurf2;
layout(location = 0) out vec4 oN;
layout(location = 1) out vec4 oA;
void main() {
  if (vSurf2.y > 0.5) discard; // the exterior hull is drawn by the outside pass, not lit here
  vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
  oN = vec4(n * 0.5 + 0.5, vSurf.a);
  oA = vec4(vSurf.rgb, vSurf2.x); // albedo stays sqrt-encoded
}`;

// ------------------------------------------------------------------------------------------------ traversal

export const TRAVERSE = /* glsl */ `
uniform sampler2D uNodes;
uniform sampler2D uTris;
uniform sampler2D uSurf;
uniform float uLamps;
uniform float uBakedGain;
#define TEX_SHIFT ${TEX_SHIFT}
#define TEX_MASK ${TEX_MASK}
#define STACK_SIZE ${STACK_SIZE}
#define MAX_ITERS ${MAX_ITERS}
#define FRONT_ONLY ${FRONT_ONLY.toFixed(1)}
ivec2 tc(int i) { return ivec2(i & TEX_MASK, i >> TEX_SHIFT); }
vec3 safeInv(vec3 d) { return (step(vec3(0.0), d) * 2.0 - 1.0) / max(abs(d), vec3(1e-12)); }

float slabW(int node, vec3 o, vec3 inv, float tMax, out vec2 w) {
  vec4 a = texelFetch(uNodes, tc(node * 2), 0);
  vec4 b = texelFetch(uNodes, tc(node * 2 + 1), 0);
  w = vec2(a.w, b.w);
  vec3 t0 = (a.xyz - o) * inv;
  vec3 t1 = (b.xyz - o) * inv;
  vec3 tn = min(t0, t1);
  vec3 tf = max(t0, t1);
  float near = max(max(tn.x, tn.y), max(tn.z, 0.0));
  float far = min(min(tf.x, tf.y), min(tf.z, tMax));
  return near <= far ? near : INF;
}

float triHit(int t, vec3 o, vec3 d, float tMax, out vec2 uv) {
  vec4 a = texelFetch(uTris, tc(t * 3), 0);
  vec3 e1 = texelFetch(uTris, tc(t * 3 + 1), 0).xyz;
  vec3 e2 = texelFetch(uTris, tc(t * 3 + 2), 0).xyz;
  vec3 p = cross(d, e2);
  float det = dot(e1, p);
  if (a.w >= FRONT_ONLY ? det <= 1e-12 : abs(det) <= 1e-12) return INF;
  float inv = 1.0 / det;
  vec3 s = o - a.xyz;
  float u = dot(s, p) * inv;
  if (u < 0.0 || u > 1.0) return INF;
  vec3 q = cross(s, e1);
  float v = dot(d, q) * inv;
  if (v < 0.0 || u + v > 1.0) return INF;
  float tt = dot(e2, q) * inv;
  if (!(tt > 1e-4 && tt < tMax)) return INF;
  uv = vec2(u, v);
  return tt;
}

// Closest hit (anyHit false) or first hit (shadow rays). Returns the distance, or INF on a miss; tri = -1 on a
// miss. Children are tested at the parent, the nearer one is descended into, the farther one pushed with its
// entry distance (skipped on pop when a closer hit exists). Out of iterations: any-hit reports occluded.
float traceRay(vec3 o, vec3 d, float tMax, bool anyHit, out int tri, out vec2 bary) {
  vec3 inv = safeInv(d);
  tri = -1;
  bary = vec2(0.0);
  float best = tMax;
  vec2 W;
  if (slabW(0, o, inv, best, W) >= INF) return INF;
  int stackN[STACK_SIZE];
  float stackT[STACK_SIZE];
  int sp = 0;
  int node = 0;
  for (int it = 0; it < MAX_ITERS; it++) {
    int next = -1;
    vec2 nW = vec2(0.0);
    if (W.x >= 3.0) {
      int cnt = int(W.x) - 3;
      int off = int(W.y);
      for (int k = 0; k < 16; k++) {
        if (k >= cnt) break;
        vec2 uv;
        float t = triHit(off + k, o, d, best, uv);
        if (t < best) {
          best = t;
          tri = off + k;
          bary = uv;
          if (anyHit) return best;
        }
      }
    } else {
      int L = node + 1;
      int R = int(W.y);
      vec2 wl, wr;
      float tl = slabW(L, o, inv, best, wl);
      float tr = slabW(R, o, inv, best, wr);
      if (tl < INF && tr < INF) {
        bool nl = tl <= tr;
        next = nl ? L : R;
        nW = nl ? wl : wr;
        if (sp < STACK_SIZE) {
          stackN[sp] = nl ? R : L;
          stackT[sp] = nl ? tr : tl;
          sp++;
        }
      } else if (tl < INF) {
        next = L;
        nW = wl;
      } else if (tr < INF) {
        next = R;
        nW = wr;
      }
    }
    while (next < 0 && sp > 0) {
      sp--;
      if (stackT[sp] < best) {
        next = stackN[sp];
        nW = vec2(texelFetch(uNodes, tc(next * 2), 0).w, texelFetch(uNodes, tc(next * 2 + 1), 0).w);
      }
    }
    if (next < 0) break;
    node = next;
    W = nW;
    if (it == MAX_ITERS - 1 && anyHit) {
      tri = max(tri, 0);
      return min(best, tMax * 0.999);
    }
  }
  return tri < 0 ? INF : best;
}

// Shading data of a hit: face normal (towards the ray), albedo, and the baked (lamp + emissive) radiance.
void hitSurface(int t, vec2 b, vec3 d, out vec3 n, out vec3 albedo, out vec3 baked) {
  vec4 ta = texelFetch(uTris, tc(t * 3), 0);
  vec4 tb = texelFetch(uTris, tc(t * 3 + 1), 0);
  vec4 tcv = texelFetch(uTris, tc(t * 3 + 2), 0);
  n = normalize(cross(tb.xyz, tcv.xyz));
  if (dot(n, d) > 0.0) n = -n;
  int ia = int(ta.w >= FRONT_ONLY ? ta.w - FRONT_ONLY : ta.w);
  int ib = int(tb.w);
  int ic = int(tcv.w);
  albedo = texelFetch(uSurf, tc(ia * 3), 0).rgb;
  vec3 w = vec3(1.0 - b.x - b.y, b.x, b.y);
  vec3 lit = texelFetch(uSurf, tc(ia * 3 + 1), 0).rgb * w.x + texelFetch(uSurf, tc(ib * 3 + 1), 0).rgb * w.y + texelFetch(uSurf, tc(ic * 3 + 1), 0).rgb * w.z;
  vec3 alt = texelFetch(uSurf, tc(ia * 3 + 2), 0).rgb * w.x + texelFetch(uSurf, tc(ib * 3 + 2), 0).rgb * w.y + texelFetch(uSurf, tc(ic * 3 + 2), 0).rgb * w.z;
  baked = (lit * uLamps + alt) * uBakedGain;
}
`;

// ------------------------------------------------------------------------------------------------ trace pass

export const TRACE_FRAG = HEAD + GBUF_READ + TRAVERSE + /* glsl */ `
uniform sampler2D uDepth;
uniform sampler2D uG0;
uniform sampler2D uG1;
uniform vec2 uSize;
uniform vec3 uEye;
uniform vec3 uSunDir;
uniform vec3 uSunE;
uniform float uCosSun;
uniform vec4 uFx;       // sun visibility, sun bounce, reflections, AO (1 = on)
uniform int uFrame;
uniform int uCheckerB;  // 1: the bounce ray is traced on alternate pixels (checkerboard flipping every frame)
uniform samplerCube uEnv;
uniform mat3 uEnvRot;
uniform float uEnvGain; // 0 = no environment (misses are black)
uniform vec2 uEnvLod;   // x: log2(2 S / pi) for a cube of S texels a face (lod of a lobe of half-width 1 rad), y: max lod
uniform float uClampL;  // firefly clamp, max luminance of one sample
uniform float uReflMaxRough;
uniform float uAoRadius;
layout(location = 0) out vec4 oA; // bounce radiance (mean incoming, sun only), sun visibility
layout(location = 1) out vec4 oB; // reflected radiance, ambient occlusion

uint hashu(uint x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}
// per-pixel Cranley-Patterson rotation of an R2 sequence over frames: stratified in time, decorrelated in space
vec2 rnd2(ivec2 px, uint dim) {
  uint h = hashu(uint(px.x) * 1973u + uint(px.y) * 9277u + dim * 26699u);
  vec2 rot = vec2(float(h & 0xffffu), float(h >> 16)) / 65536.0;
  float f = float(uFrame & 65535);
  return fract(rot + vec2(0.7548776662, 0.5698402910) * f);
}
mat3 basis(vec3 n) {
  vec3 t = abs(n.x) > 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 tt = normalize(cross(n, t));
  return mat3(tt, cross(n, tt), n);
}
vec3 cosineDir(vec3 n, vec2 u) {
  float r = sqrt(u.x);
  float ph = 2.0 * PI * u.y;
  return basis(n) * vec3(r * cos(ph), r * sin(ph), sqrt(max(0.0, 1.0 - u.x)));
}
vec3 coneDir(vec3 axis, float cosMax, vec2 u) {
  float c = 1.0 - u.x * (1.0 - cosMax);
  float s = sqrt(max(0.0, 1.0 - c * c));
  float ph = 2.0 * PI * u.y;
  return basis(axis) * vec3(s * cos(ph), s * sin(ph), c);
}
// GGX visible-normal sampling (spherical caps, Dupuy & Benyoub 2023); v in tangent space, z = normal
vec3 sampleVNDF(vec3 v, float a, vec2 u) {
  vec3 vh = normalize(vec3(a * v.x, a * v.y, v.z));
  float ph = 2.0 * PI * u.x;
  float z = (1.0 - u.y) * (1.0 + vh.z) - vh.z;
  float s = sqrt(clamp(1.0 - z * z, 0.0, 1.0));
  vec3 h = vec3(s * cos(ph), s * sin(ph), z) + vh;
  return normalize(vec3(a * h.x, a * h.y, max(0.0, h.z)));
}
vec3 clampL(vec3 c) {
  float l = lum(c);
  return l > uClampL ? c * (uClampL / l) : c;
}
// radiance leaving a hit towards the ray: baked lamps/emissives (+ sunlight with its own shadow ray)
vec3 shadeHit(vec3 o, vec3 d, float t, int tri, vec2 b, bool baked, vec2 u) {
  vec3 n, alb, bk;
  hitSurface(tri, b, d, n, alb, bk);
  vec3 c = baked ? bk : vec3(0.0);
  float ndl = dot(n, uSunDir);
  if (ndl > 0.0) {
    vec3 h = o + d * t + n * 0.004;
    int st; vec2 sb;
    if (traceRay(h, coneDir(uSunDir, uCosSun, u), 1e4, true, st, sb) >= INF) c += alb * (1.0 / PI) * uSunE * ndl;
  }
  return c;
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  float z = texelFetch(uDepth, px, 0).r;
  if (z >= 1.0) { oA = vec4(0.0); oB = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec4 g0 = texelFetch(uG0, px, 0);
  vec3 N = decN(g0.xyz);
  float rough = g0.w;
  vec2 uv = (vec2(px) + 0.5) / uSize;
  vec3 P = shipPos(uv, z);
  vec3 toEye = uEye - P;
  float dist = length(toEye);
  vec3 V = toEye / max(dist, 1e-6);
  vec3 O = P + N * (0.004 + 0.0015 * dist);
  float vis = 0.0;
  vec3 bounce = vec3(0.0);
  vec3 refl = vec3(0.0);
  float ao = 1.0;
  int tri; vec2 b;
  if (uFx.x > 0.5 && dot(N, uSunDir) > 0.0) {
    vis = traceRay(O, coneDir(uSunDir, uCosSun, rnd2(px, 0u)), 1e4, true, tri, b) >= INF ? 1.0 : 0.0;
  }
  if (uFx.y > 0.5) {
    // The sun's bounce is the lowest-frequency signal here and is accumulated over many frames anyway, so it is
    // traced on half the pixels per frame; the temporal pass rebuilds the other half from their four traced
    // neighbours (marked by a negative red). Half the bounce rays (about a quarter of the trace) for no visible loss.
    if (uCheckerB == 0 || ((px.x + px.y + uFrame) & 1) == 0) {
      vec3 d = cosineDir(N, rnd2(px, 1u));
      float t = traceRay(O, d, 80.0, false, tri, b);
      if (tri >= 0) bounce = clampL(shadeHit(O, d, t, tri, b, false, rnd2(px, 2u)));
    } else bounce = vec3(-1.0);
  }
  if (uFx.z > 0.5 && rough < uReflMaxRough) {
    mat3 tb = basis(N);
    vec3 vt = transpose(tb) * V;
    float a = max(rough * rough, 0.002);
    vec3 h = tb * sampleVNDF(vt, a, rnd2(px, 3u));
    vec3 d = reflect(-V, h);
    if (dot(d, N) <= 0.0) d = reflect(-V, N);
    float t = traceRay(O, d, 120.0, false, tri, b);
    if (tri >= 0) refl = shadeHit(O, d, t, tri, b, true, rnd2(px, 4u));
    // escaped through a window: the outside averaged over the lobe (its mip), not one noisy texel of it
    else if (uEnvGain > 0.0) refl = textureLod(uEnv, uEnvRot * d, clamp(log2(a * 1.5) + uEnvLod.x, 0.0, uEnvLod.y)).rgb * uEnvGain;
    refl = clampL(refl);
  }
  if (uFx.w > 0.5) {
    vec3 d = cosineDir(N, rnd2(px, 5u));
    ao = traceRay(O, d, uAoRadius, true, tri, b) >= INF ? 1.0 : 0.0;
  }
  oA = vec4(bounce, vis);
  oB = vec4(refl, ao);
}`;

// ------------------------------------------------------------------------------------------------ temporal

export const TEMPORAL_FRAG = HEAD + GBUF_READ + /* glsl */ `
uniform sampler2D uRawA;
uniform sampler2D uRawB;
uniform sampler2D uDepth;
uniform sampler2D uG0;
uniform sampler2D uPrevDepth;
uniform sampler2D uPrevG0;
uniform sampler2D uHistA;
uniform sampler2D uHistB;
uniform sampler2D uHistM;
uniform mat4 uPrevVP;
uniform mat4 uPrevInvVP;
uniform vec2 uSize;
uniform vec3 uEye;
uniform vec4 uCap;      // history length cap per effect: visibility, bounce, reflections, AO
uniform float uMotion;  // 0 = still (pure accumulation), 1 = moving (history clamped to the neighbourhood)
uniform float uMinAlpha;// lighting change (the sun moved in ship space): floor of the blend weight
uniform float uReset;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
layout(location = 2) out vec4 oM; // second moments (visibility, bounce luminance, reflection luminance), history length

vec3 prevPos(vec2 uv, float z) {
  vec4 p = uPrevInvVP * vec4(uv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  float z = texelFetch(uDepth, px, 0).r;
  if (z >= 1.0) { oA = vec4(0.0); oB = vec4(0.0, 0.0, 0.0, 1.0); oM = vec4(0.0); return; }
  vec4 ra = texelFetch(uRawA, px, 0);
  vec4 rb = texelFetch(uRawB, px, 0);
  // neighbourhood statistics of this frame's samples (clamp, and the variance before history exists)
  vec4 ma = vec4(0.0), qa = vec4(0.0), mb = vec4(0.0), qb = vec4(0.0);
  float cnt = 0.0, cntB = 0.0;
  ivec2 hi = ivec2(uSize) - 1;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    ivec2 q = clamp(px + ivec2(i, j), ivec2(0), hi);
    if (texelFetch(uDepth, q, 0).r >= 1.0) continue;
    vec4 a = texelFetch(uRawA, q, 0);
    vec4 b = texelFetch(uRawB, q, 0);
    // bounce (rgb) only from the pixels that traced it this frame (checkerboard: red < 0 = not traced)
    float tb = a.r < 0.0 ? 0.0 : 1.0;
    vec4 la = vec4(a.rgb * tb, a.a);
    ma += la; qa += la * la; mb += b; qb += b * b; cnt += 1.0; cntB += tb;
  }
  ma.a /= cnt; qa.a /= cnt;
  ma.rgb /= max(cntB, 1.0); qa.rgb /= max(cntB, 1.0);
  mb /= cnt; qb /= cnt;
  vec4 sa = sqrt(max(qa - ma * ma, 0.0));
  vec4 sb = sqrt(max(qb - mb * mb, 0.0));
  if (ra.r < 0.0) ra.rgb = ma.rgb; // not traced here this frame: the mean of the traced neighbours

  vec3 N = decN(texelFetch(uG0, px, 0).xyz);
  vec2 uv = (vec2(px) + 0.5) / uSize;
  vec3 P = shipPos(uv, z);
  float dist = length(uEye - P);
  vec4 hA = vec4(0.0), hB = vec4(0.0), hM = vec4(0.0);
  float wsum = 0.0;
  vec4 pc = uPrevVP * vec4(P, 1.0);
  if (pc.w > 0.0 && uReset < 0.5) {
    vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
    vec2 f = puv * uSize - 0.5;
    ivec2 b0 = ivec2(floor(f));
    vec2 fr = f - floor(f);
    for (int j = 0; j <= 1; j++) for (int i = 0; i <= 1; i++) {
      ivec2 q = b0 + ivec2(i, j);
      if (q.x < 0 || q.y < 0 || q.x > hi.x || q.y > hi.y) continue;
      float pz = texelFetch(uPrevDepth, q, 0).r;
      if (pz >= 1.0) continue;
      vec3 pp = prevPos((vec2(q) + 0.5) / uSize, pz);
      if (length(pp - P) > 0.02 + 0.015 * dist) continue;              // disocclusion
      if (dot(decN(texelFetch(uPrevG0, q, 0).xyz), N) < 0.85) continue; // different surface
      float w = (i == 0 ? 1.0 - fr.x : fr.x) * (j == 0 ? 1.0 - fr.y : fr.y);
      hA += texelFetch(uHistA, q, 0) * w;
      hB += texelFetch(uHistB, q, 0) * w;
      hM += texelFetch(uHistM, q, 0) * w;
      wsum += w;
    }
  }
  float n = 0.0;
  if (wsum > 1e-3) {
    hA /= wsum; hB /= wsum; hM /= wsum;
    n = hM.w;
    if (uMotion > 0.0) {
      // clamp to the neighbourhood: wide for the noisy indirect signals, tighter for visibility and AO
      vec4 ka = vec4(3.0, 3.0, 3.0, 1.5), kb = vec4(2.5, 2.5, 2.5, 1.5);
      vec4 ca = clamp(hA, ma - ka * sa - 0.02, ma + ka * sa + 0.02);
      vec4 cb = clamp(hB, mb - kb * sb - 0.02, mb + kb * sb + 0.02);
      hA = mix(hA, ca, uMotion);
      hB = mix(hB, cb, uMotion);
    }
  }
  float n1 = min(n + 1.0, 2048.0);
  vec4 al = max(vec4(1.0 / n1), max(1.0 / uCap, vec4(uMinAlpha)));
  if (n < 0.5) al = vec4(1.0);
  oA = vec4(mix(hA.rgb, ra.rgb, al.y), mix(hA.a, ra.a, al.x));
  oB = vec4(mix(hB.rgb, rb.rgb, al.z), mix(hB.a, rb.a, al.w));
  vec3 m2 = vec3(mix(hM.x, ra.a * ra.a, al.x), mix(hM.y, lum(ra.rgb) * lum(ra.rgb), al.y), mix(hM.z, lum(rb.rgb) * lum(rb.rgb), al.z));
  if (n1 < 4.0) {
    // young history: take the variance from the neighbourhood instead
    vec3 sv = vec3(sa.a, lum(sa.rgb), lum(sb.rgb));
    m2 = vec3(oA.a * oA.a, lum(oA.rgb) * lum(oA.rgb), lum(oB.rgb) * lum(oB.rgb)) + sv * sv;
  }
  oM = vec4(m2, n1);
}`;

// ------------------------------------------------------------------------------------------------ à-trous

export const ATROUS_FRAG = HEAD + GBUF_READ + /* glsl */ `
uniform sampler2D uInA;
uniform sampler2D uInB;
uniform sampler2D uAccA;
uniform sampler2D uAccB;
uniform sampler2D uM;
uniform sampler2D uDepth;
uniform sampler2D uG0;
uniform vec2 uSize;
uniform vec3 uEye;
uniform int uStep;
uniform int uRadius; // 1: 3x3 (1/4 1/2 1/4), 2: 5x5 B3 spline (1/16 1/4 3/8 1/4 1/16)
uniform float uVarScale;
uniform float uReflMaxRough;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
float hw(int i) {
  int a = abs(i);
  return uRadius == 2 ? (a == 0 ? 0.375 : (a == 1 ? 0.25 : 0.0625)) : (a == 0 ? 0.5 : 0.25);
}
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  float z = texelFetch(uDepth, px, 0).r;
  vec4 ca = texelFetch(uInA, px, 0);
  vec4 cb = texelFetch(uInB, px, 0);
  if (z >= 1.0) { oA = ca; oB = cb; return; }
  vec4 g0 = texelFetch(uG0, px, 0);
  vec3 N = decN(g0.xyz);
  float rough = g0.w;
  vec2 uv = (vec2(px) + 0.5) / uSize;
  vec3 P = shipPos(uv, z);
  float dist = length(uEye - P);
  vec4 M = texelFetch(uM, px, 0);
  vec4 aa = texelFetch(uAccA, px, 0);
  vec4 ab = texelFetch(uAccB, px, 0);
  float lb = lum(ca.rgb), lr = lum(cb.rgb);
  float sv = 4.0 * sqrt(max(M.x - aa.a * aa.a, 0.0) * uVarScale) + 0.02;
  float sbn = 4.0 * sqrt(max(M.y - lum(aa.rgb) * lum(aa.rgb), 0.0) * uVarScale) + 1e-4 + 0.05 * lb;
  float sr = 4.0 * sqrt(max(M.z - lum(ab.rgb) * lum(ab.rgb), 0.0) * uVarScale) + 1e-4 + 0.05 * lr;
  // glossy reflections keep their sharpness: only the first steps on smooth surfaces
  float reflSteps = 1.0 + 8.0 * clamp(rough / max(uReflMaxRough, 1e-3), 0.0, 1.0);
  float reflOn = float(uStep) <= reflSteps ? 1.0 : 0.0;
  // a rough lobe's reflection is smooth by nature: past ~0.15 the luminance edge-stop only keeps 1-spp noise
  // clusters alive (blotches), so it fades out and the filter is purely geometric (depth, normal)
  float roughBlur = smoothstep(0.12, 0.3, rough);
  float tolZ = (0.01 + 0.004 * dist) * float(uStep);
  vec4 sumA = vec4(0.0), sumB = vec4(0.0);
  vec4 wA = vec4(0.0), wB = vec4(0.0);
  ivec2 hi = ivec2(uSize) - 1;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    if (abs(i) > uRadius || abs(j) > uRadius) continue;
    float h = hw(i) * hw(j);
    ivec2 q = px + ivec2(i, j) * uStep;
    if (q.x < 0 || q.y < 0 || q.x > hi.x || q.y > hi.y) continue;
    float zq = texelFetch(uDepth, q, 0).r;
    if (zq >= 1.0) continue;
    vec4 a = texelFetch(uInA, q, 0);
    vec4 b = texelFetch(uInB, q, 0);
    float w = h;
    if (i != 0 || j != 0) {
      vec3 Pq = shipPos((vec2(q) + 0.5) / uSize, zq);
      vec3 Nq = decN(texelFetch(uG0, q, 0).xyz);
      w *= exp(-abs(dot(N, Pq - P)) / tolZ) * pow(max(dot(N, Nq), 0.0), 32.0);
    }
    vec4 wa = vec4(vec3(w * exp(-abs(lum(a.rgb) - lb) / sbn)), w * exp(-abs(a.a - ca.a) / sv));
    float wr = w * mix(exp(-abs(lum(b.rgb) - lr) / sr), 1.0, roughBlur) * ((i == 0 && j == 0) ? 1.0 : reflOn);
    vec4 wb = vec4(vec3(wr), w);
    sumA += a * wa; wA += wa;
    sumB += b * wb; wB += wb;
  }
  oA = sumA / max(wA, vec4(1e-6));
  oB = sumB / max(wB, vec4(1e-6));
}`;

// ------------------------------------------------------------------------------------------------ composite

export const COMPOSITE_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec3 normal;
in vec4 aSurf;
in vec4 aSurf2;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
out vec3 vP;
out vec3 vN;
out vec4 vSurf;
out vec4 vSurf2;
void main() {
  vP = position;
  vN = normal;
  vSurf = aSurf;
  vSurf2 = aSurf2;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const DEPTH_FRAG = HEAD + /* glsl */ `
in vec4 vSurf2;
out vec4 o;
void main() {
  if (vSurf2.y > 0.5) discard;
  o = vec4(0.0);
}`;

/**
 * Full-resolution, drawn over the rasterised interior with its depth (LEQUAL, polygon offset), blended
 * dst = dst * src.a + src.rgb: adds traced sun direct + sun bounce + reflections, and multiplies by AO.
 */
export const COMPOSITE_FRAG = HEAD + GBUF_READ + /* glsl */ `
in vec3 vP;
in vec3 vN;
in vec4 vSurf;
in vec4 vSurf2;
uniform sampler2D uDenA;
uniform sampler2D uDenB;
uniform sampler2D uLowDepth;
uniform sampler2D uLowG0;
uniform vec2 uLowSize;
uniform vec2 uTargetSize;
uniform vec3 uEye;
uniform vec3 uSunDir;
uniform vec3 uSunE;
uniform float uSunAng;
uniform vec4 uFx;
uniform float uReflMaxRough;
uniform float uAoStrength;
uniform int uDebug; // 0 final, 1 visibility, 2 bounce, 3 reflections, 4 AO, 5 sun direct only
out vec4 o;

float D_GGX(float nh, float a) {
  float a2 = a * a;
  float d = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}
float V_SmithJoint(float nv, float nl, float a) {
  float a2 = a * a;
  float gv = nl * sqrt(nv * nv * (1.0 - a2) + a2);
  float gl = nv * sqrt(nl * nl * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}
vec3 envBRDF(vec3 F0, float rough, float nv) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * nv)) * r.x + r.y;
  vec2 ab = vec2(-1.04, 1.04) * a004 + r.zw;
  return F0 * ab.x + ab.y;
}
void main() {
  if (vSurf2.y > 0.5 || vSurf2.z > 0.5) discard; // exterior hull; unlit surfaces
  vec3 N = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
  vec3 alb = vSurf.rgb * vSurf.rgb;
  float rough = vSurf.a;
  float metal = vSurf2.x;
  vec3 toEye = uEye - vP;
  float dist = length(toEye);
  vec3 V = toEye / max(dist, 1e-6);
  // joint bilateral upsampling of the denoised low-resolution signals
  vec2 uv = gl_FragCoord.xy / uTargetSize;
  vec2 f = uv * uLowSize - 0.5;
  ivec2 b0 = ivec2(floor(f));
  vec2 fr = f - floor(f);
  ivec2 hi = ivec2(uLowSize) - 1;
  vec4 A = vec4(0.0), B = vec4(0.0);
  float ws = 0.0;
  vec4 Abest = vec4(0.0, 0.0, 0.0, 0.0), Bbest = vec4(0.0, 0.0, 0.0, 1.0);
  float wbest = -1.0;
  for (int j = 0; j <= 1; j++) for (int i = 0; i <= 1; i++) {
    ivec2 q = clamp(b0 + ivec2(i, j), ivec2(0), hi);
    float zq = texelFetch(uLowDepth, q, 0).r;
    if (zq >= 1.0) continue;
    vec3 Pq = shipPos((vec2(q) + 0.5) / uLowSize, zq);
    vec3 Nq = decN(texelFetch(uLowG0, q, 0).xyz);
    float bil = (i == 0 ? 1.0 - fr.x : fr.x) * (j == 0 ? 1.0 - fr.y : fr.y);
    float g = exp(-abs(dot(N, Pq - vP)) / (0.01 + 0.006 * dist)) * pow(max(dot(N, Nq), 0.0), 8.0);
    vec4 a = texelFetch(uDenA, q, 0);
    vec4 b = texelFetch(uDenB, q, 0);
    float w = bil * g;
    A += a * w; B += b * w; ws += w;
    if (g > wbest) { wbest = g; Abest = a; Bbest = b; }
  }
  if (ws > 1e-4) { A /= ws; B /= ws; } else { A = Abest; B = Bbest; }

  float nl = dot(N, uSunDir);
  float nv = clamp(dot(N, V), 1e-3, 1.0);
  vec3 F0 = mix(vec3(0.04), alb, metal);
  vec3 sun = vec3(0.0);
  if (uFx.x > 0.5 && nl > 0.0) {
    // sphere-light widening: the star's disc bounds how sharp its highlight can be
    float a = clamp(rough * rough + uSunAng * 0.5, 0.002, 1.0);
    vec3 H = normalize(uSunDir + V);
    float nh = clamp(dot(N, H), 0.0, 1.0);
    float vh = clamp(dot(V, H), 0.0, 1.0);
    vec3 F = F0 + (1.0 - F0) * pow(1.0 - vh, 5.0);
    vec3 spec = F * (D_GGX(nh, a) * V_SmithJoint(nv, nl, a));
    sun = (alb * (1.0 - metal) / PI + spec) * uSunE * nl * A.a;
  }
  float aoF = uFx.w > 0.5 ? mix(1.0, B.a, uAoStrength) : 1.0;
  vec3 bounce = uFx.y > 0.5 ? alb * (1.0 - metal) * A.rgb * aoF : vec3(0.0);
  vec3 refl = (uFx.z > 0.5 && rough < uReflMaxRough) ? B.rgb * envBRDF(F0, rough, nv) : vec3(0.0);
  if (uDebug == 0) o = vec4(sun + bounce + refl, aoF);
  else if (uDebug == 1) o = vec4(vec3(A.a), 0.0);
  else if (uDebug == 2) o = vec4(A.rgb, 0.0);
  else if (uDebug == 3) o = vec4(B.rgb, 0.0);
  else if (uDebug == 4) o = vec4(vec3(B.a), 0.0);
  else o = vec4(sun, 0.0);
}`;

export const COPY_FRAG = HEAD + /* glsl */ `
in vec2 vUv;
uniform sampler2D uSrc;
out vec4 o;
void main() { o = texture(uSrc, vUv); }`;
