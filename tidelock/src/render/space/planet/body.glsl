// ---------------------------------------------------------------------------------------------
// Runtime body shader. One draw call per body: the unit sphere, its atmosphere shell and its ring
// plane are intersected analytically along the view ray and composited front to back, so the limb is
// exactly round at any distance, there is no shell geometry to show an edge, and rings sort correctly
// against the globe and the air without depth tricks. Everything is in the body-fixed frame, in units
// of body radius (the CPU rotates camera and sun into it; +Y is the spin axis, the ring plane is y = 0).
//
// Feature #defines (set by planet.ts): GIANT, HAS_ATMO, HAS_CLOUDS, HAS_OCEAN, HAS_RINGS,
// EMISSIVE (0 none, 1 lava, 2 city lights), DETAIL_LAYERS (0..2), MAX_SCATTER_STEPS.
// scatter.glsl is prepended (it declares uSunDir / uSunColor and the atmosphere functions).
// Output is premultiplied alpha: rgb = radiance, a = how much of the background is covered.
// ---------------------------------------------------------------------------------------------
const float PI = 3.14159265;
const float DETAIL_S1 = 9.0;       // tiles per body radius, coarse layer
const float DETAIL_S2 = 61.0;      // fine layer

in vec3 vRay;
out vec4 fragColor;

uniform vec3 uCamPos;          // camera, body frame
uniform samplerCube tAlbedo;   // rgb = sqrt(albedo), a = sea-level code (ocean classes) or gloss
uniform samplerCube tNormal;   // rgb = body-space normal, a = emissive mask
uniform samplerCube tCloud;    // r = raw cloudiness
uniform sampler2D tDetail;     // rg = slope, b = height, a = billow; tiling
uniform sampler2D tRing;       // rgb = sqrt(colour), a = relative optical depth; u = radius
uniform vec4 uSurf;            // x = regolith (Lommel-Seeliger) blend, y = ambient, z = detail normal amp, w = detail albedo amp
uniform vec4 uOceanDeep;       // rgb = deep water, a = glint roughness
uniform vec3 uOceanShallow;
uniform vec4 uCloud;           // x = threshold, y = edge softness, z = shadow reach (radians at noon), w = opacity
uniform vec3 uCloudColor;
uniform vec4 uCloudRot;        // xy = cos/sin of the drift angle, z = erosion amplitude
uniform vec4 uEmis;            // rgb = colour * intensity, a = lava intensity
uniform vec4 uRing;            // x = inner radius, y = outer radius, z = 1 / (outer - inner), w = optical depth scale
uniform vec3 uSkyAmb;          // sky-light fill colour (fraction of sun colour)
uniform vec4 uLod;             // x = detail weight (0 = off), y = cloud shadow tap on/off, z = gloss strength

vec3 rotY(vec3 p, vec2 cs) {
  return vec3(cs.x * p.x + cs.y * p.z, p.y, -cs.y * p.x + cs.x * p.z);
}

#if DETAIL_LAYERS > 0
// Triplanar tap of the tiling detail texture. Returns the blended texel; `grad` is the slope as a
// body-space vector (to be projected onto the tangent plane).
vec4 triSample(vec3 p, vec3 dpx, vec3 dpy, float s, vec3 w, out vec3 grad) {
  vec4 a = textureGrad(tDetail, p.zy * s, dpx.zy * s, dpy.zy * s);
  vec4 b = textureGrad(tDetail, p.xz * s + 0.37, dpx.xz * s, dpy.xz * s);
  vec4 c = textureGrad(tDetail, p.xy * s + 0.71, dpx.xy * s, dpy.xy * s);
  vec2 sa = a.xy - 0.5;
  vec2 sb = b.xy - 0.5;
  vec2 sc = c.xy - 0.5;
  grad = w.x * vec3(0.0, sa.y, sa.x) + w.y * vec3(sb.x, 0.0, sb.y) + w.z * vec3(sc.x, sc.y, 0.0);
  return a * w.x + b * w.y + c * w.z;
}
#endif

void main() {
  vec3 ro = uCamPos;
  vec3 rd = normalize(vRay);
  float b = dot(ro, rd);
  float imp = length(cross(ro, rd));                    // impact parameter of the ray
  float fw = max(fwidth(imp), 1e-7);
  float cov = b < 0.0 ? clamp(0.5 - (imp - 1.0) / fw, 0.0, 1.0) : 0.0;   // analytic limb coverage
  float tS = -b - sqrt(max(1.0 - imp * imp, 0.0));      // surface hit (tangent point when grazing)
  vec3 p = normalize(ro + rd * tS);
  vec3 dpx = dFdx(p);
  vec3 dpy = dFdy(p);

#ifdef HAS_RINGS
  float tR = abs(rd.y) > 1e-6 ? -ro.y / rd.y : -1.0;
  vec3 rq = ro + rd * tR;
  float ru = (length(rq.xz) - uRing.x) * uRing.z;
  float ruW = fwidth(ru);
  bool ringOn = tR > 0.0 && ru > 0.0 && ru < 1.0;
#endif

  // ------------------------------------------------------------------ atmosphere along the ray
  vec3 trans = vec3(1.0);
  vec3 insc = vec3(0.0);
  float tMid = 1e9;
#ifdef HAS_ATMO
  float Ra = uAtmo.x;
  if (imp < Ra && (b < 0.0 || dot(ro, ro) < Ra * Ra)) {
    float hh = sqrt(Ra * Ra - imp * imp);
    float t0 = max(-b - hh, 0.0);
    float t1 = mix(-b + hh, tS, cov);
    if (t1 > t0) {
      insc = atmoScatter(ro, rd, t0, t1, trans);
      tMid = 0.5 * (t0 + t1);
    }
  }
#endif

  // ------------------------------------------------------------------ surface
  vec3 surf = vec3(0.0);
  if (cov > 0.0) {
    vec3 v = -rd;
    vec3 L = uSunDir;
    float muS = dot(p, L);
    float ndv = max(dot(p, v), 0.0);
    float fp = max(length(dpx), length(dpy));           // footprint, radii per pixel

    vec4 alb = textureGrad(tAlbedo, p, dpx, dpy);
    vec3 albedo = alb.rgb * alb.rgb;
    vec3 n = p;
    float emis = 0.0;
#ifndef GIANT
    vec4 nt = textureGrad(tNormal, p, dpx, dpy);
    n = normalize(nt.xyz * 2.0 - 1.0);
    emis = nt.a;
#endif

    // ---- small-scale detail (fades in as the baked texels get magnified)
    vec3 dG = vec3(0.0);
    vec3 dGc = vec3(0.0);
    float dH = 0.0;
    float dA = 0.0;
    float dW = 0.0;
    float dF = 0.0;
#if DETAIL_LAYERS > 0
    if (uLod.x > 0.0) {
      vec3 tw = abs(p);
      tw *= tw;
      tw *= tw;
      tw /= tw.x + tw.y + tw.z;
  #ifdef GIANT
      vec3 ps = vec3(p.x, p.y * 2.2, p.z);
      vec3 psx = vec3(dpx.x, dpx.y * 2.2, dpx.z);
      vec3 psy = vec3(dpy.x, dpy.y * 2.2, dpy.z);
  #else
      vec3 ps = p;
      vec3 psx = dpx;
      vec3 psy = dpy;
  #endif
      float w1 = (1.0 - smoothstep(0.6, 3.0, fp * DETAIL_S1 * 256.0)) * uLod.x;
      vec3 g1;
      vec4 d1 = triSample(ps, psx, psy, DETAIL_S1, tw, g1);
      dG += g1 * (w1 * 1.3);
      dGc = g1 * w1;
      dH += (d1.z - 0.5) * w1;
      dA += (d1.w - 0.5) * w1;
      dW = w1;
  #if DETAIL_LAYERS > 1
      float w2 = (1.0 - smoothstep(0.6, 3.0, fp * DETAIL_S2 * 256.0)) * uLod.x;
    #ifdef GIANT
      w2 *= 0.45;                                        // cloud decks are soft at the small scale
    #endif
      vec3 g2;
      vec4 d2 = triSample(ps.yzx, psx.yzx, psy.yzx, DETAIL_S2, tw.yzx, g2);
      dG += g2.zxy * (w2 * 0.6);
      dGc += g2.zxy * (w2 * 0.3);
      dH += (d2.z - 0.5) * w2 * 0.6;
      dA += (d2.w - 0.5) * w2 * 0.6;
      dF = (d2.w - 0.5) * w2;
  #endif
    }
#endif
    vec3 dT = dG - p * dot(dG, p);                      // tangent-plane slope

    // ---- water
    float water = 0.0;
#ifdef HAS_OCEAN
    float code = alb.a + dH * 0.035;
    water = 1.0 - smoothstep(0.496, 0.504, code);
    float depth = clamp((0.5 - alb.a) * 2.0, 0.0, 1.0);
    vec3 wcol = mix(uOceanShallow, uOceanDeep.rgb, smoothstep(0.0, 0.22, depth));
    albedo = mix(albedo, wcol, water);
    n = normalize(mix(n, p, water));
#endif
#ifdef GIANT
    albedo *= 1.0 + (dH * 0.9 + dA * 1.5) * uSurf.w;      // billowing cloud tops
#else
    albedo *= 1.0 + dH * 2.0 * uSurf.w * (1.0 - water);
#endif
    n = normalize(n - dT * (uSurf.z * mix(1.0, 0.12, water)));

    // ---- star light at the surface
#ifdef HAS_ATMO
    vec3 tSun = sunTransmittance(1.0, muS);
    vec3 sky = uSkyAmb * uSunColor * smoothstep(-0.18, 0.3, muS);
#else
    vec3 tSun = vec3(smoothstep(-0.008, 0.012, muS));
    vec3 sky = vec3(0.0);
#endif
    float d0 = max(dot(n, L), 0.0);
#ifdef GIANT
    float diff = d0 * (0.80 + 0.20 * ndv);
    diff *= 1.0 - clamp(dot(dT, L) * 1.6, -0.35, 0.5) * smoothstep(0.0, 0.25, muS);   // relief on the cloud deck
#else
    float dv = max(dot(n, v), 0.0);
    float diff = mix(d0, min(2.0 * d0 / (d0 + dv + 0.02), 1.3), uSurf.x);
#endif
    vec3 direct = uSunColor * tSun * diff;

#ifdef HAS_RINGS
    // ring shadow on the globe
    if (abs(L.y) > 1e-4) {
      float ts = -p.y / L.y;
      if (ts > 0.0) {
        vec3 qs = p + L * ts;
        float us = (length(qs.xz) - uRing.x) * uRing.z;
        if (us > 0.0 && us < 1.0) {
          float lodS = clamp(log2(fp * 1024.0 * uRing.z / max(abs(L.y), 0.08)) + 1.0, 1.5, 8.0);
          float tauS = textureLod(tRing, vec2(us, 0.5), lodS).a * uRing.w;
          direct *= exp(-tauS / max(abs(L.y), 0.03));
        }
      }
    }
#endif

    // ---- clouds: one tap for cover, one toward the sun for ground shadow + self shading
    float cloudA = 0.0;
    vec3 cloudC = vec3(0.0);
    float cShadow = 1.0;
#ifdef HAS_CLOUDS
    vec3 pc = rotY(p, uCloudRot.xy);
    vec3 dcx = rotY(dpx, uCloudRot.xy);
    vec3 dcy = rotY(dpy, uCloudRot.xy);
    // up close the detail layer breaks the baked field into cells and wisps and sharpens its edges
    float erode = (dH * 0.75 + dA * 0.5) * uCloudRot.z;
    float soft = uCloud.y * mix(1.0, 0.5, dW);
    float c0 = textureGrad(tCloud, pc, dcx, dcy).r + erode;
    cloudA = smoothstep(uCloud.x - soft, uCloud.x + soft, c0);
    float c1 = c0;
    if (uLod.y > 0.5) {
      vec3 lt = rotY(L - p * muS, uCloudRot.xy);
      float reach = uCloud.z / max(muS, 0.16);
      c1 = textureGrad(tCloud, normalize(pc + lt * reach), dcx * 1.5, dcy * 1.5).r + erode;
      float sh = smoothstep(uCloud.x - soft * 1.6, uCloud.x + soft * 1.6, c1);
      cShadow = 1.0 - sh * 0.72 * uCloud.w;
    }
    float thick = smoothstep(uCloud.x, uCloud.x + 0.30, c0);
    float selfSh = clamp(1.0 + (c0 - c1) * 5.0, 0.45, 1.25);
  #ifdef HAS_ATMO
    vec3 tSunC = sunTransmittance(1.0 + uAtmo.y * 1.2, muS);
  #else
    vec3 tSunC = vec3(smoothstep(-0.02, 0.03, muS));
  #endif
    float wrap = clamp((muS + 0.12) / 1.12, 0.0, 1.0);
    // cloud tops are bumpy: slopes facing the star catch the light
    float bump = -dot(dGc - p * dot(dGc, p), L) * 2.6 * smoothstep(-0.05, 0.2, muS);
    float cl = clamp(wrap * selfSh + bump, 0.0, 1.5);
    cloudC = uCloudColor * (0.72 + 0.28 * thick) * (uSunColor * tSunC * cl + sky * 0.9 + uSurf.y);
    cloudA *= uCloud.w;
#endif

    // ---- specular: ocean sun glint and sky sheen, a broad gloss on ice / salt
    vec3 spec = vec3(0.0);
#ifdef HAS_OCEAN
    float glossy = water;
    float rough = uOceanDeep.a;
#else
    float glossy = alb.a * uLod.z;
    float rough = 0.34;
#endif
#ifndef GIANT
    if (glossy > 0.001 && muS > -0.05) {
      vec3 nw = normalize(mix(n, normalize(p - dT * 0.35), water));
      vec3 hv = normalize(L + v);
      float nh = max(dot(nw, hv), 0.0);
      float nl = max(dot(nw, L), 0.0);
      float nv = max(dot(nw, v), 0.0);
      float a2 = rough * rough;
      float dd = nh * nh * (a2 - 1.0) + 1.0;
      float D = a2 / (PI * dd * dd);
      float F = 0.02 + 0.98 * pow(1.0 - clamp(dot(v, hv), 0.0, 1.0), 5.0);
      float k = rough * 0.5;
      float G = nl / (4.0 * (nl * (1.0 - k) + k) * (nv * (1.0 - k) + k));
      spec = uSunColor * tSun * (PI * D * F * G * glossy);
      // grazing sky reflection
      spec += sky * (glossy * (0.02 + 0.98 * pow(1.0 - nv, 5.0)) * 2.5);
    }
#endif

    vec3 ground = albedo * (direct * cShadow + sky + uSurf.y) + spec * cShadow;

    // ---- emissive
#if EMISSIVE == 1
    // up close the molten channels break into crusted, braided flows: detail eats into the half-lit
    // margins of the baked mask while the hot cores stay solid
    float heat = emis + (dH * 1.9 + dA * 1.5) * emis * (1.0 - emis) * 3.0;
    heat = clamp(heat, 0.0, 1.0);
    vec3 hc = mix(vec3(1.0, 0.07, 0.005), vec3(1.0, 0.34, 0.04), smoothstep(0.15, 0.55, heat));
    hc = mix(hc, vec3(1.0, 0.72, 0.30), smoothstep(0.55, 1.0, heat));
    ground += hc * (heat * heat * sqrt(heat) * uEmis.a);
#elif EMISSIVE == 2
    float night = smoothstep(0.13, -0.05, muS);          // lights come on in deep twilight
    float sparkle = 1.0 + dF * 3.0 + dA * 1.2;
    ground += uEmis.rgb * (emis * emis * night * max(sparkle, 0.15) * (1.0 - cloudA * 0.6));
#endif

    surf = mix(ground, cloudC, cloudA);
  }

  // ------------------------------------------------------------------ rings
  vec3 ringC = vec3(0.0);
  float ringA = 0.0;
  bool ringFront = false;
#ifdef HAS_RINGS
  if (ringOn) {
    float lod = log2(max(ruW * 1024.0, 1.0));
    vec4 rs = textureLod(tRing, vec2(ru, 0.5), lod);
    float tau = rs.a * uRing.w;
    vec3 rcol = rs.rgb * rs.rgb;
    float mu = max(abs(rd.y), 0.015);
    float mu0 = max(abs(uSunDir.y), 0.015);
    ringA = 1.0 - exp(-tau / mu);
    float cosT = dot(rd, uSunDir);                      // +1 = looking toward the star
    float alpha = acos(clamp(-cosT, -1.0, 1.0));        // phase angle
    float pBack = (8.0 / (3.0 * PI)) * (sin(alpha) + (PI - alpha) * cos(alpha));
    const float g = 0.78;
    float pFwd = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosT, 1.5);
    float dust = 0.09 + 0.24 * exp(-tau * 1.8);         // thin ringlets are dustier
    float phase = pBack * (1.0 - dust) + pFwd * dust;
    float slab;
    if (ro.y * uSunDir.y > 0.0) {
      // lit face: diffuse reflection from a slab
      slab = mu0 / (mu0 + mu) * (1.0 - exp(-tau * (1.0 / mu0 + 1.0 / mu)));
    } else {
      // unlit face: light filtering through (brightest where the ring is thin but not empty)
      float x = tau * (mu0 - mu) / (mu * mu0);
      float f = abs(x) < 1e-3 ? 1.0 - 0.5 * x : (1.0 - exp(-x)) / x;
      slab = exp(-tau / mu0) * (tau / mu) * f;
    }
    // shadow of the globe
    float qs = dot(rq, uSunDir);
    float qd = length(rq - uSunDir * qs);
    float pen = 0.006 + 0.012 * max(-qs, 0.0);
    float shade = qs < 0.0 ? smoothstep(1.0 - pen, 1.0 + pen * 2.0, qd) : 1.0;
    ringC = uSunColor * rcol * (0.25 * 1.5 * phase * slab * shade) + rcol * (uSurf.y * ringA);
    float tRef = cov > 0.0 ? tS : 1e9;
    ringFront = tR < min(tRef, tMid);
  }
#endif

  // ------------------------------------------------------------------ composite, far to near
  vec3 C = vec3(0.0);
  float A = 0.0;
  if (!ringFront) {
    C = ringC;
    A = ringA;
  }
  C = mix(C, surf, cov);
  A = mix(A, 1.0, cov);
  C = C * trans + insc;
  A = 1.0 - (1.0 - A) * dot(trans, vec3(0.3333));
  if (ringFront) {
    C = ringC + C * (1.0 - ringA);
    A = ringA + A * (1.0 - ringA);
  }
  fragColor = vec4(C, A);
}
