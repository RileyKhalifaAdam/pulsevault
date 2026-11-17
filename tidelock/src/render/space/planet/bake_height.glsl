// ---------------------------------------------------------------------------------------------
// Bake pass 1: terrain elevation + class masks into an RGBA16F cube map.
//   R = elevation relative to the sea-level datum (0 = coastline for ocean-bearing classes)
//   G, B, A = class-specific masks consumed by bake_surface.glsl
// CLS is #defined by the baker (ids below). uPack = 1 packs R into RG8 for the CPU quantile pass.
// ---------------------------------------------------------------------------------------------
#define CLS_BARREN 0
#define CLS_ROCKY 1
#define CLS_DESERT 2
#define CLS_LAVA 3
#define CLS_ICE 4
#define CLS_OCEAN 5
#define CLS_TERRAN 6
#define CLS_EYEBALL 7

uniform float uRough;
uniform float uCraters;
uniform float uLavaAmt;
uniform float uIce;
uniform float uLocked;
uniform float uSeaLevel;
uniform int uPack;
uniform float uFine;      // 1 at >= 1024 texels per face, lower at small bakes (skips sub-texel octaves)

// Distance (radians, approx) to the zero set of a smooth noise field: long sinuous lines.
float lineDist(vec3 p, float freq, vec3 off) {
  vec4 n = noised(p * freq + off);
  vec3 g = n.yzw - p * dot(n.yzw, p);
  return abs(n.x) / (freq * max(length(g), 0.25));
}

vec4 terrain(vec3 p) {
#if CLS == CLS_TERRAN || CLS == CLS_OCEAN || CLS == CLS_EYEBALL
  vec3 q = p + vnoise3(p * 1.1 + 3.0) * 0.40;
  float cont = fbm(q * 1.3, 7) + fbm(q * 2.9 + 20.0, 4) * 0.30;
  float mmask = smoothstep(-0.08, 0.25, fbm(q * 1.7 + 40.0, 3));
  float rdg = ridged(q * 3.6 + 9.0, 6);
  float fine = fbm(p * 21.0 + 80.0, 4);
  #if CLS == CLS_OCEAN
  float arcs = pow(ridged(q * 2.2 + 5.0, 5), 2.2);
  float hot = smoothstep(0.10, 0.45, fbm(q * 5.0 + 70.0, 4));
  float h = cont * 0.45 + arcs * 0.75 * mmask + hot * 0.14 + fine * 0.035;
  #else
  float land = smoothstep(-0.15, 0.25, cont);
  float h = cont + rdg * mmask * (0.22 + 0.45 * uRough) * mix(0.3, 1.0, land) + fine * 0.035;
  #endif
  float moist = fbm(p * 2.3 + 60.0, 4) * 1.6;
  return vec4(h, moist, rdg * mmask, fine);

#elif CLS == CLS_BARREN
  vec3 q = p + vnoise3(p * 0.9 + 3.0) * 0.25;
  float big = fbm(q * 1.2, 5);
  float maria = smoothstep(-0.04, -0.26, fbm(q * 0.85 + 50.0, 4));
  float rough = fbm(p * 7.0 + 13.0, 6);
  float h = big * 0.55;
  h = mix(h, -0.16 + big * 0.10, maria);
  h += rough * 0.10 * mix(1.0, 0.2, maria) * (0.4 + uRough);
  float dens = 0.25 + 0.75 * uCraters;
  float old = mix(1.0, 0.25, maria);
  float ej = 0.0;
  vec3 c = craterLayer(p, 2.6, 0.45 * dens, 0.8);
  h += c.x * old; ej += c.y * 0.5;
  c = craterLayer(p, 5.3, 0.6 * dens, 0.9);
  h += c.x * old; ej += c.y * 0.8;
  c = craterLayer(p, 10.7, 0.7 * dens, 1.0);
  h += c.x * mix(1.0, 0.5, maria); ej += c.y;
  c = craterLayer(p, 21.3, 0.75 * dens, 1.0);
  h += c.x * mix(1.0, 0.6, maria); ej += c.y;
  if (uFine > 0.3) {
    c = craterLayer(p, 43.7, 0.8 * dens, 1.0);
    h += c.x * mix(1.0, 0.7, maria); ej += c.y * 0.8;
  }
  if (uFine > 0.8) {
    c = craterLayer(p, 89.0, 0.8 * dens, 1.0);
    h += c.x; ej += c.y * 0.6;
  }
  return vec4(h, maria, ej, fbm(p * 25.0 + 80.0, 4));

#elif CLS == CLS_ROCKY
  vec3 q = p + vnoise3(p * 1.0 + 3.0) * 0.35;
  float big = fbm(q * 1.1, 6);
  float rdg = ridged(q * 3.0 + 9.0, 6);
  float mmask = smoothstep(0.0, 0.3, fbm(q * 1.6 + 40.0, 3));
  float h = big * 0.9 + rdg * mmask * 0.3 * (0.4 + uRough);
  // canyon system along the zero set of a warped field, confined to a few provinces
  float cmask = smoothstep(0.02, 0.22, fbm(q * 1.4 + 75.0, 3));
  float cd = lineDist(q, 1.9, vec3(70.0)) + fbm(p * 14.0 + 31.0, 3) * 0.010;
  float trib = lineDist(q, 6.5, vec3(44.0)) + fbm(p * 30.0 + 11.0, 2) * 0.004;
  float canyon = (1.0 - smoothstep(0.004, 0.020, cd)) * cmask;
  canyon = max(canyon, (1.0 - smoothstep(0.002, 0.007, trib)) * cmask * smoothstep(0.09, 0.02, cd) * 0.6);
  h -= canyon * 0.16;
  // shield volcanoes
  vec3 w = worley(q * 1.5 + 30.0);
  float cone = smoothstep(0.42, 0.0, w.x) * step(0.72, w.z);
  h += cone * cone * 0.45 - smoothstep(0.035, 0.0, w.x) * step(0.72, w.z) * 0.08;
  float dens = 0.15 + 0.85 * uCraters;
  float ej = 0.0;
  vec3 c = craterLayer(p, 3.1, 0.35 * dens, 0.6);
  h += c.x;
  c = craterLayer(p, 7.3, 0.5 * dens, 0.7);
  h += c.x; ej += c.y * 0.4;
  c = craterLayer(p, 17.9, 0.6 * dens, 0.8);
  h += c.x; ej += c.y * 0.4;
  if (uFine > 0.3) {
    c = craterLayer(p, 41.0, 0.6 * dens, 0.8);
    h += c.x;
  }
  float dust = fbm(q * 2.1 + 90.0, 5) + 0.3 * fbm(q * 7.0 + 12.0, 3);
  return vec4(h + fbm(p * 19.0 + 80.0, 4) * 0.03, dust, max(canyon, ej * 0.5), fbm(p * 23.0 + 80.0, 4));

#elif CLS == CLS_DESERT
  vec3 q = p + vnoise3(p * 1.2 + 3.0) * 0.35;
  float big = fbm(q * 1.5, 6);
  float rdg = ridged(q * 3.3 + 9.0, 5);
  float h0 = big * 0.9 + rdg * 0.25 * smoothstep(-0.1, 0.3, fbm(q * 2.0 + 40.0, 3)) * (0.4 + uRough);
  float mesa = smoothstep(0.02, 0.25, big);
  float st = h0 * 11.0;
  float terr = (floor(st) + smoothstep(0.55, 0.95, fract(st))) / 11.0;
  float h = mix(h0, terr, mesa * 0.8);
  // dry channels cut into the plateaus
  float chd = lineDist(q, 4.3, vec3(70.0)) + fbm(p * 26.0 + 31.0, 2) * 0.004;
  float chan = (1.0 - smoothstep(0.002, 0.010, chd)) * smoothstep(-0.05, 0.15, big);
  h -= chan * 0.05;
  // sand seas with dune trains (megadunes only; fine dunes are a runtime detail)
  float erg = smoothstep(0.00, -0.20, big + fbm(q * 4.0 + 55.0, 3) * 0.3);
  vec3 dw = vnoise3(p * 5.0 + 21.0) * 0.045;
  float ph = dot(p + dw, normalize(vec3(0.35, 0.9, 0.25))) * 135.0;
  float dune = pow(0.5 + 0.5 * sin(ph + 2.0 * gnoise(p * 11.0)), 1.6);
  h = mix(h, -0.02 + big * 0.25 + dune * 0.022 * uFine, erg);
  float salt = smoothstep(-0.27, -0.36, big + fbm(q * 6.0 + 15.0, 3) * 0.12);
  h = mix(h, -0.12, salt);
  vec3 c = craterLayer(p, 6.1, 0.12 + 0.5 * uCraters, 0.6);
  h += c.x * (1.0 - erg);
  return vec4(h, erg, salt, fbm(p * 23.0 + 80.0, 4));

#elif CLS == CLS_LAVA
  vec3 q = p + vnoise3(p * 1.3 + 3.0) * 0.30;
  float big = fbm(q * 1.6, 6);
  float rdg = ridged(q * 3.5 + 9.0, 5);
  float h = big * 0.8 + rdg * 0.22 * (0.4 + uRough);
  float amt = 0.25 + 0.75 * uLavaAmt;
  // magma seas fill the lowlands; the whole day side on a tidally locked world
  float level = mix(-0.30, 0.02, amt) + uLocked * 0.75 * smoothstep(-0.15, 0.85, p.x);
  float sea = smoothstep(level + 0.035, level - 0.035, big + fbm(q * 5.0 + 17.0, 3) * 0.2);
  vec3 wq = q + vnoise3(p * 4.0 + 61.0) * 0.06;
  vec3 w1 = worley(wq * 4.2);
  vec3 w2 = worley(wq * 11.0 + 7.0);
  vec3 w3 = worley(wq * 29.0 + 3.0);
  float e1 = w1.y - w1.x;
  float e2 = w2.y - w2.x;
  float e3 = w3.y - w3.x;
  float crack1 = 1.0 - smoothstep(0.0, 0.045, e1);
  float crack2 = (1.0 - smoothstep(0.0, 0.07, e2)) * smoothstep(-0.1, 0.2, fbm(q * 2.6 + 33.0, 3) + amt * 0.25 - 0.1);
  float halo = (1.0 - smoothstep(0.0, 0.30, e1)) * 0.10 + (1.0 - smoothstep(0.0, 0.35, e2)) * 0.05;
  // crust rafts on the seas: bright molten gaps, darker cooled plates
  float rafts = mix(1.0, 0.10 + 0.25 * w3.z, smoothstep(0.02, 0.16, e3) * smoothstep(0.9, 0.2, sea * (0.35 + amt)));
  float heat = max(max(crack1 * 0.85, crack2 * 0.55) + halo, sea * rafts);
  // calderas
  vec3 wv = worley(q * 2.3 + 51.0);
  float vent = smoothstep(0.05, 0.0, wv.x) * step(0.6, wv.z);
  h += smoothstep(0.30, 0.0, wv.x) * step(0.6, wv.z) * 0.25 - vent * 0.1;
  heat = max(heat, vent);
  h = mix(h, level - 0.03, sea * 0.9);
  h -= (crack1 + crack2 * 0.6) * 0.035;
  h += (1.0 - sea) * fbm(p * 17.0 + 80.0, 4) * 0.05;
  return vec4(h, clamp(heat, 0.0, 1.0), w2.z, fbm(p * 23.0 + 80.0, 4));

#elif CLS == CLS_ICE
  vec3 q = p + vnoise3(p * 1.0 + 3.0) * 0.30;
  float big = fbm(q * 1.4, 5);
  float h = big * 0.25 + fbm(p * 9.0 + 13.0, 5) * 0.05 * (0.4 + uRough);
  // lineae: three families of long arcuate fractures
  float d1 = lineDist(q, 1.3, vec3(70.0));
  float d2 = lineDist(q, 2.9, vec3(44.0, 12.0, 91.0));
  float d3 = lineDist(q, 6.3, vec3(15.0, 77.0, 23.0)) + fbm(p * 22.0, 2) * 0.003;
  float d4 = lineDist(q, 13.0, vec3(5.0, 27.0, 63.0));
  float l1 = 1.0 - smoothstep(0.004, 0.011, d1);
  float l2 = 1.0 - smoothstep(0.003, 0.008, d2);
  float l3 = (1.0 - smoothstep(0.0015, 0.005, d3)) * 0.8;
  float l4 = (1.0 - smoothstep(0.001, 0.003, d4)) * 0.5 * smoothstep(-0.05, 0.15, fbm(q * 2.2 + 8.0, 3));
  float lin = max(max(l1, l2), max(l3, l4));
  // double ridge: raised flanks, central trough
  float ridge = (1.0 - smoothstep(0.006, 0.016, d1)) + (1.0 - smoothstep(0.004, 0.012, d2)) * 0.7 + (1.0 - smoothstep(0.002, 0.007, d3)) * 0.4;
  h += ridge * 0.012 - lin * 0.018;
  // chaos terrain
  float chaos = smoothstep(0.10, 0.30, fbm(q * 2.4 + 37.0, 4));
  vec3 w = worley(p * 34.0);
  h += chaos * ((w.y - w.x) * 0.03 - 0.012);
  vec3 c = craterLayer(p, 6.7, 0.08 + 0.5 * uCraters, 0.7);
  h += c.x;
  vec3 c2 = craterLayer(p, 19.0, 0.08 + 0.5 * uCraters, 0.8);
  h += c2.x;
  return vec4(h, lin, max(chaos * (0.5 + 0.5 * w.z), 0.0) - (c.y + c2.y) * 0.8, fbm(p * 23.0 + 80.0, 4));
#else
  return vec4(0.0);
#endif
}

void main() {
  vec3 p = normalize(cubeDir(uFace, gl_FragCoord.xy / uRes));
  vec4 t = terrain(p);
  if (uPack == 1) {
    float v = clamp(t.r * 0.5 + 0.5, 0.0, 1.0) * 255.0;
    fragColor = vec4(floor(v) / 255.0, fract(v), 0.0, 1.0);
    return;
  }
  t.r -= uSeaLevel;
#if CLS == CLS_TERRAN || CLS == CLS_OCEAN
  // polar caps: sea ice turns shallow water into (flat) "land"
  float edge = 1.0 - uIce * 0.24;
  float cap = smoothstep(edge - 0.02, edge + 0.02, abs(p.y) + fbm(p * 4.0 + 33.0, 4) * 0.10 + max(t.r, 0.0) * 0.25);
  t.r = mix(t.r, max(t.r, 0.012 + 0.02 * cap), cap);
#elif CLS == CLS_EYEBALL
  // +X is the sub-stellar point. Night side: ice sheet. Day side: seas boiled off into salt pans.
  float s = p.x + fbm(p * 3.0 + 33.0, 4) * 0.12;
  float iceEdge = -0.06 - (1.0 - uIce) * 0.5;
  float night = smoothstep(iceEdge + 0.04, iceEdge - 0.04, s);
  float dry = smoothstep(0.26, 0.42, s);
  float h0 = t.r;
  float dome = smoothstep(iceEdge, iceEdge - 0.6, s);
  float crev = 1.0 - smoothstep(0.002, 0.007, lineDist(p, 5.1, vec3(15.0, 77.0, 23.0)));
  t.r = mix(t.r, max(t.r, 0.02) * 0.5 + 0.03 + dome * 0.08 - crev * 0.02, night);
  t.r = mix(t.r, max(t.r, 0.006), dry);
  t.g = h0;
#endif
  fragColor = t;
}
