// The traced light, applied by the surfaces' own forward shaders (the "demodulated" composite).
//
// The tracer (tracer.ts) leaves three low-resolution, denoised signals per frame: sun visibility over the star's
// disc, the sun's one-bounce irradiance, and glossy reflected radiance. Adding them on top of the finished image
// would need the surface's albedo, roughness and normal at full resolution — which only the forward pass has
// (atlas tiles, photo scans, normal maps, lightmaps). So the forward pass takes the light instead:
//
//   sun          an extra direct light in the material's own BRDF (three's RE_Direct: Lambert + GGX, clearcoat),
//                its irradiance × the traced visibility. The shadow-mapped interior sun is off while this runs.
//   bounce       irradiance += π × mean incoming sun-bounce radiance (three multiplies by diffuse / π, then the
//                material's AO).
//   reflections  on surfaces smoother than the trace's cut (their own per-pixel roughness), the traced radiance
//                replaces the probe / environment radiance; three applies its own split-sum BRDF and specular
//                occlusion. Rough surfaces keep the box-projected probes.
//
// Every texel is fetched with a joint-bilateral 2×2 upsample against the tracer's own G-buffer (view-space plane
// distance and ship-space normal), falling back to the best-matching tap for pixels the static mesh does not
// cover (moving controls, loose objects: they take the light of the static surface around them).
//
// One program per material: the patch is uniform-driven (uRtOn), so turning ray tracing on or off, changing its
// tier or effects never compiles anything. Patch before the materials compile (the interior's warm-up).
import * as THREE from 'three';

export const RT_FORWARD_KEY = '|tl-rt-fwd-1';

export interface RtForwardUniforms {
  uRtOn: THREE.IUniform<number>;
  /** sun, bounce, reflections, (AO, unused here) — 1 = on */
  uRtFx: THREE.IUniform<THREE.Vector4>;
  uRtA: THREE.IUniform<THREE.Texture | null>;
  uRtB: THREE.IUniform<THREE.Texture | null>;
  uRtDepth: THREE.IUniform<THREE.Texture | null>;
  uRtG0: THREE.IUniform<THREE.Texture | null>;
  /** Trace resolution and the forward target's resolution, px. */
  uRtLow: THREE.IUniform<THREE.Vector2>;
  uRtTarget: THREE.IUniform<THREE.Vector2>;
  /** Camera near / far, and 1/P00, 1/P11 of its projection (view-space reconstruction of the trace's depth). */
  uRtNF: THREE.IUniform<THREE.Vector2>;
  uRtProj: THREE.IUniform<THREE.Vector2>;
  /** Direction to the star (view space) and its irradiance on a surface facing it (three.js light units). */
  uRtSunDir: THREE.IUniform<THREE.Vector3>;
  uRtSunE: THREE.IUniform<THREE.Vector3>;
  /** View → ship rotation (the G-buffer's normals are ship space). */
  uRtViewToShip: THREE.IUniform<THREE.Matrix3>;
  uRtReflMax: THREE.IUniform<number>;
}

export function createForwardUniforms(reflMax: number): RtForwardUniforms {
  return {
    uRtOn: { value: 0 },
    uRtFx: { value: new THREE.Vector4() },
    uRtA: { value: null },
    uRtB: { value: null },
    uRtDepth: { value: null },
    uRtG0: { value: null },
    uRtLow: { value: new THREE.Vector2(1, 1) },
    uRtTarget: { value: new THREE.Vector2(1, 1) },
    uRtNF: { value: new THREE.Vector2(0.05, 80) },
    uRtProj: { value: new THREE.Vector2(1, 1) },
    uRtSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uRtSunE: { value: new THREE.Vector3() },
    uRtViewToShip: { value: new THREE.Matrix3() },
    uRtReflMax: { value: reflMax },
  };
}

const HEAD = /* glsl */ `
uniform float uRtOn;
uniform vec4 uRtFx;
uniform sampler2D uRtA;
uniform sampler2D uRtB;
uniform sampler2D uRtDepth;
uniform sampler2D uRtG0;
uniform vec2 uRtLow;
uniform vec2 uRtTarget;
uniform vec2 uRtNF;
uniform vec2 uRtProj;
uniform vec3 uRtSunDir;
uniform vec3 uRtSunE;
uniform mat3 uRtViewToShip;
uniform float uRtReflMax;
float rtViewZ( float z ) {
  return 2.0 * uRtNF.x * uRtNF.y / ( ( uRtNF.y + uRtNF.x ) - ( z * 2.0 - 1.0 ) * ( uRtNF.y - uRtNF.x ) );
}
// joint-bilateral 2x2 upsample of the traced signals at this pixel. P, nV: view-space position and geometric normal.
void rtFetch( vec3 P, vec3 nV, out vec4 A, out vec4 B, out float reflK ) {
  vec3 N = normalize( uRtViewToShip * nV );
  float d = max( -P.z, 1e-3 );
  float tol = 0.012 + 0.008 * d;
  vec2 f = gl_FragCoord.xy / uRtTarget * uRtLow - 0.5;
  vec2 fl = floor( f );
  vec2 fr = f - fl;
  ivec2 b0 = ivec2( fl );
  ivec2 hi = ivec2( uRtLow ) - 1;
  A = vec4( 0.0 );
  B = vec4( 0.0 );
  float ws = 0.0;
  float wr = 0.0;
  float best = -1.0;
  float rBest = 0.0;
  vec4 Ab = vec4( 0.0 );
  vec4 Bb = vec4( 0.0 );
  for ( int j = 0; j < 2; j ++ ) {
    for ( int i = 0; i < 2; i ++ ) {
      ivec2 q = clamp( b0 + ivec2( i, j ), ivec2( 0 ), hi );
      float zq = texelFetch( uRtDepth, q, 0 ).r;
      if ( zq >= 1.0 ) continue;
      float dq = rtViewZ( zq );
      vec2 ndc = ( vec2( q ) + 0.5 ) / uRtLow * 2.0 - 1.0;
      vec3 Pq = vec3( ndc * uRtProj * dq, -dq );
      vec4 g = texelFetch( uRtG0, q, 0 );
      float gw = exp( -abs( dot( nV, Pq - P ) ) / tol ) * pow( max( dot( N, normalize( g.xyz * 2.0 - 1.0 + 1e-6 ) ), 0.0 ), 8.0 );
      float bil = ( i == 0 ? 1.0 - fr.x : fr.x ) * ( j == 0 ? 1.0 - fr.y : fr.y );
      float w = bil * gw;
      vec4 a = texelFetch( uRtA, q, 0 );
      vec4 b = texelFetch( uRtB, q, 0 );
      float ro = g.a < uRtReflMax ? 1.0 : 0.0;
      A += a * w;
      ws += w;
      B += b * ( w * ro );
      wr += w * ro;
      if ( gw > best ) { best = gw; Ab = a; Bb = b; rBest = ro; }
    }
  }
  if ( ws > 0.02 ) {
    A /= ws;
    if ( wr > 1e-4 ) { B /= wr; reflK = clamp( wr / ws, 0.0, 1.0 ); } else { reflK = 0.0; }
  } else {
    // nothing of the static mesh here (a moving part, or an edge): the best-matching neighbour
    A = Ab;
    B = Bb;
    reflK = rBest;
  }
}
`;

const APPLY = /* glsl */ `
if ( uRtOn > 0.5 ) {
  vec4 rtA;
  vec4 rtB;
  float rtRK;
  rtFetch( geometryPosition, nonPerturbedNormal, rtA, rtB, rtRK );
#if defined( RE_Direct )
  if ( uRtFx.x > 0.5 && rtA.a > 0.002 ) {
    IncidentLight rtSun;
    rtSun.direction = uRtSunDir;
    rtSun.color = uRtSunE * rtA.a;
    rtSun.visible = true;
    RE_Direct( rtSun, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  }
#endif
#if defined( RE_IndirectDiffuse )
  if ( uRtFx.y > 0.5 ) irradiance += PI * rtA.rgb;
#endif
#if defined( RE_IndirectSpecular )
  if ( uRtFx.z > 0.5 ) radiance = mix( radiance, rtB.rgb, rtRK * ( 1.0 - smoothstep( uRtReflMax - 0.12, uRtReflMax, material.roughness ) ) );
#endif
}
#include <lights_fragment_end>`;

/** Materials the traced light can be applied to: lit, physically based, drawn into the HDR target. */
function patchable(m: THREE.Material): m is THREE.MeshStandardMaterial {
  const std = m as THREE.MeshStandardMaterial;
  if (!std.isMeshStandardMaterial) return false;
  if (m.blending === THREE.AdditiveBlending || !m.colorWrite) return false;
  return true;
}

const patched = new WeakSet<THREE.Material>();

/** Patch one material (idempotent). Its own onBeforeCompile and program key are kept and run first. */
export function patchMaterialForRt(m: THREE.Material, u: RtForwardUniforms): boolean {
  if (!patchable(m)) return false;
  if (patched.has(m)) return true;
  patched.add(m);
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    if (!sh.fragmentShader.includes('#include <lights_fragment_end>') || !sh.fragmentShader.includes('void main() {')) return;
    Object.assign(sh.uniforms, u);
    sh.fragmentShader = sh.fragmentShader.replace('void main() {', `${HEAD}\nvoid main() {`).replace('#include <lights_fragment_end>', APPLY);
  };
  m.customProgramCacheKey = () => prevKey.call(m) + RT_FORWARD_KEY;
  m.needsUpdate = true;
  return true;
}

/** Patch every lit material under `root`; returns how many materials carry the patch. */
export function patchTreeForRt(root: THREE.Object3D, u: RtForwardUniforms): number {
  const seen = new Set<THREE.Material>();
  root.traverse((o) => {
    const mat = (o as THREE.Mesh).material;
    if (!mat) return;
    for (const m of Array.isArray(mat) ? mat : [mat]) if (!seen.has(m) && patchMaterialForRt(m, u)) seen.add(m);
  });
  return seen.size;
}
