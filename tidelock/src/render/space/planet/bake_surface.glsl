// ---------------------------------------------------------------------------------------------
// Bake pass 2: reads the elevation cube from pass 1 and writes one of two RGBA8 cube maps.
//   default      : rgb = sqrt(albedo), a = height code (ocean classes: 0.5 = sea level) or gloss
//   OUT_NORMAL   : rgb = body-space normal * 0.5 + 0.5, a = emissive mask (lava heat or city lights)
// ---------------------------------------------------------------------------------------------
#define CLS_BARREN 0
#define CLS_ROCKY 1
#define CLS_DESERT 2
#define CLS_LAVA 3
#define CLS_ICE 4
#define CLS_OCEAN 5
#define CLS_TERRAN 6
#define CLS_EYEBALL 7

uniform highp samplerCube tHeight;
uniform vec3 uPal[6];
uniform int uPalN;
uniform float uIce;
uniform float uCity;
uniform float uNormalK;
uniform float uTexel;     // angular size of the finite-difference step, radians

vec3 ramp(float t) {
  float x = clamp(t, 0.0, 1.0) * float(uPalN - 1);
  int i = int(floor(x));
  int j = min(i + 1, uPalN - 1);
  float f = x - float(i);
  return mix(uPal[i], uPal[j], f * f * (3.0 - 2.0 * f));
}

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// Clustered settlement lights: metro cores, sprawl, small towns and faint transit lines.
float cityLights(vec3 p, float habit) {
  if (habit <= 0.001) return 0.0;
  float region = smoothstep(-0.05, 0.25, fbm(p * 2.6 + 100.0, 4));
  vec3 w = worley(p * 23.0 + 9.0);
  float metro = smoothstep(0.42, 0.04, w.x) * step(0.45, w.z);
  vec3 w2 = worley(p * 71.0 + 3.0);
  float towns = smoothstep(0.30, 0.05, w2.x) * step(0.6, w2.z) * 0.55;
  float sprawl = smoothstep(0.0, 0.5, fbm(p * 55.0 + 7.0, 3) + 0.15);
  float lanes = (1.0 - smoothstep(0.0, 0.035, w.y - w.x)) * 0.22;
  float v = (metro * (0.55 + 0.45 * sprawl) + towns * sprawl + lanes * sprawl) * region;
  return clamp(v * habit, 0.0, 1.0);
}

void main() {
  vec3 p = normalize(cubeDir(uFace, gl_FragCoord.xy / uRes));
  vec4 hv = texture(tHeight, p);
  float h = hv.r;
  float lat = abs(p.y);

#ifdef OUT_NORMAL
  // ---- normal from the elevation field (finite differences across cube faces) ----
  vec3 up = abs(p.y) < 0.92 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t1 = normalize(cross(up, p));
  vec3 t2 = cross(p, t1);
  float e = uTexel;
  float hx1 = texture(tHeight, normalize(p + t1 * e)).r;
  float hx0 = texture(tHeight, normalize(p - t1 * e)).r;
  float hy1 = texture(tHeight, normalize(p + t2 * e)).r;
  float hy0 = texture(tHeight, normalize(p - t2 * e)).r;
  float k = uNormalK;
  #if CLS == CLS_TERRAN || CLS == CLS_OCEAN || CLS == CLS_EYEBALL
  // sea floor does not shade; the water surface is flat
  hx1 = max(hx1, 0.0); hx0 = max(hx0, 0.0); hy1 = max(hy1, 0.0); hy0 = max(hy0, 0.0);
  #endif
  vec3 n = normalize(p - k * ((hx1 - hx0) * t1 + (hy1 - hy0) * t2) / (2.0 * e));
  float emis = 0.0;
  #if CLS == CLS_LAVA
  emis = hv.g;
  #else
  if (uCity > 0.0) {
    #if CLS == CLS_TERRAN || CLS == CLS_OCEAN
    float coast = smoothstep(0.0, 0.004, h) * (0.25 + 0.75 * smoothstep(0.16, 0.01, h));
    float clim = 1.0 - smoothstep(0.72, 0.90, lat);
    emis = cityLights(p, coast * clim);
    #elif CLS == CLS_EYEBALL
    float s = p.x + fbm(p * 3.0 + 33.0, 4) * 0.10;
    float iceEdge = -0.20 + 0.50 * uIce;
    float coast = smoothstep(0.0, 0.004, h) * (0.35 + 0.65 * smoothstep(0.2, 0.01, h));
    // settlements hug the twilight band: from the temperate ring across the terminator onto the ice margin
    float ring = exp(-pow((s - 0.5 * iceEdge - 0.02) / 0.16, 2.0));
    emis = cityLights(p, coast * ring * 1.9);
    #else
    // sealed colonies on dead worlds: sparse, clustered
    float site = smoothstep(0.12, 0.35, fbm(p * 2.2 + 140.0, 4));
    emis = cityLights(p, site * 0.8);
    #endif
  }
  #endif
  fragColor = vec4(n * 0.5 + 0.5, emis);

#else
  vec3 col;
  float code = 0.0;

  #if CLS == CLS_TERRAN || CLS == CLS_OCEAN
  float fine = hv.a;
  float el = max(h, 0.0);
  float temp = 1.0 - lat * lat * 1.15 - el * 0.9 + fine * 0.25;
  float belt = exp(-pow((lat - 0.40) / 0.15, 2.0));
  float moist = clamp(0.58 + hv.g * 0.85 - belt * 0.55 + (1.0 - smoothstep(0.0, 0.10, el)) * 0.12, 0.0, 1.0);
  float arid = 1.0 - moist;
  float t = clamp(arid * 0.62 - 0.06 + pow(el, 0.8) * 0.95 + fine * 0.10, 0.0, 1.0);
  col = ramp(t);
  // dense forest darkens wet lowlands; grassland lightens the transition
  col *= mix(1.0, 0.70, smoothstep(0.55, 0.95, moist) * smoothstep(0.25, 0.6, temp) * smoothstep(0.35, 0.0, el));
  col = mix(col, uPal[max(uPalN - 2, 0)] * (0.9 + fine * 0.4), smoothstep(0.30, 0.85, hv.b) * 0.55);
  // tundra then snow
  col = mix(col, vec3(luma(col)) * vec3(0.95, 0.92, 0.85) + 0.03, smoothstep(0.42, 0.24, temp) * 0.6);
  float snow = smoothstep(0.27, 0.14, temp - hv.b * 0.10);
  col = mix(col, vec3(0.78, 0.80, 0.83), snow);
  // beaches
  col = mix(col, vec3(0.50, 0.45, 0.34), smoothstep(0.010, 0.0, h) * (1.0 - snow) * 0.5);
  // polar caps and sea ice (same mask as pass 1)
  float edge = 1.0 - uIce * 0.24;
  float cap = smoothstep(edge - 0.02, edge + 0.02, lat + fbm(p * 4.0 + 33.0, 4) * 0.10 + el * 0.25);
  col = mix(col, vec3(0.76, 0.80, 0.84) * (0.94 + fine * 0.25), cap);
  code = clamp(0.5 + h * 2.5, 0.0, 1.0);

  #elif CLS == CLS_EYEBALL
  float fine = hv.a;
  float s = p.x + fbm(p * 3.0 + 33.0, 4) * 0.10;
  float iceEdge = -0.20 + 0.50 * uIce;
  float night = smoothstep(iceEdge + 0.035, iceEdge - 0.035, s);
  float dry = smoothstep(iceEdge + 0.24, iceEdge + 0.36, s);
  float el = max(h, 0.0);
  // temperate ring: lush (dark) against the ice, drying toward the day side
  float moist = clamp(0.85 - smoothstep(iceEdge + 0.04, iceEdge + 0.34, s) * 0.85 + fine * 0.5, 0.0, 1.0);
  float t = clamp((1.0 - moist) * 0.5 + pow(el, 0.8) * 1.1 + fine * 0.10, 0.0, 1.0);
  col = ramp(t);
  col *= mix(1.0, 0.72, smoothstep(0.5, 0.9, moist) * smoothstep(0.3, 0.0, el));
  col = mix(col, vec3(0.50, 0.45, 0.34), smoothstep(0.010, 0.0, h) * 0.4);
  // scorched face. "Iris": wind-streaked desert whose dune fields and yardangs radiate from the
  // sub-stellar point; "pupil": a dark glassy basalt shield where the star stands at the zenith.
  float ang = atan(p.z, p.y);
  vec3 rc = vec3(cos(ang) * 9.0, sin(ang) * 9.0, s * 2.6);
  float fibre = fbm(rc + 50.0, 5) + 0.6 * fbm(rc * vec3(2.9, 2.9, 2.2) + 9.0, 4);
  vec3 scorched = ramp(clamp(0.66 + el * 0.8 + fibre * 0.50 + fine * 0.20, 0.0, 1.0));
  scorched *= vec3(1.12, 0.98, 0.84) * (0.95 + 0.45 * fibre);
  float pan = smoothstep(0.0, -0.05, hv.g) * smoothstep(0.80, 0.55, s);
  scorched = mix(scorched, vec3(0.62, 0.59, 0.52) * (0.9 + fine * 0.5), pan * 0.45);
  float collar = smoothstep(0.72, 0.88, s + fibre * 0.08);
  scorched = mix(scorched, scorched * vec3(0.46, 0.36, 0.30), collar * 0.75);
  float pupil = smoothstep(0.885, 0.92, s + fibre * 0.012 + fine * 0.02 + fbm(p * 7.0 + 19.0, 4) * 0.035);
  scorched = mix(scorched, vec3(0.026, 0.022, 0.021) * (1.0 + fine * 1.2 + fibre * 0.6), pupil * 0.95);
  col = mix(col, scorched, dry);
  // ice sheet over the terminator and night side; frozen seas read smoother and bluer
  vec3 ice = vec3(0.72, 0.77, 0.82) * (0.92 + fine * 0.35);
  ice = mix(ice, vec3(0.50, 0.62, 0.74), smoothstep(0.0, -0.06, hv.g) * 0.6);
  col = mix(col, ice, night);
  // alpine snow in the ring
  col = mix(col, vec3(0.78, 0.80, 0.83), smoothstep(0.30, 0.45, el + hv.b * 0.1) * (1.0 - dry));
  code = clamp(0.5 + h * 2.5, 0.0, 1.0);

  #elif CLS == CLS_BARREN
  float fine = hv.a;
  col = ramp(clamp(0.55 + h * 0.9 + fine * 0.30, 0.0, 1.0));
  col = mix(col, uPal[0] * 0.8, hv.g * 0.85);
  col = mix(col, uPal[uPalN - 1] * 1.12, clamp(hv.b, 0.0, 1.0) * 0.55);
  col *= 0.93 + fine * 0.35;
  code = 0.0;

  #elif CLS == CLS_ROCKY
  float fine = hv.a;
  col = ramp(clamp(0.50 + h * 0.55 + hv.g * 0.55 + fine * 0.15, 0.0, 1.0));
  col *= mix(1.0, 0.55, smoothstep(-0.02, -0.28, hv.g));
  col *= mix(1.0, 0.70, clamp(hv.b, 0.0, 1.0));
  col *= 0.94 + fine * 0.3;
  // dark, wind-scoured provinces against bright dust plains
  col *= mix(0.66, 1.10, smoothstep(-0.22, 0.20, fbm(p * 1.6 + 7.0, 5) + fine * 0.15));
  float edge = 1.0 - uIce * 0.20;
  float cap = smoothstep(edge - 0.015, edge + 0.015, lat + fbm(p * 5.0 + 33.0, 4) * 0.06);
  col = mix(col, vec3(0.74, 0.76, 0.78), cap);
  code = cap * 0.5;

  #elif CLS == CLS_DESERT
  float fine = hv.a;
  col = ramp(clamp(0.45 + h * 0.85 + fine * 0.18, 0.0, 1.0));
  col *= mix(0.70, 1.08, smoothstep(-0.25, 0.18, fbm(p * 1.5 + 7.0, 5) + fine * 0.15));
  float mesa = smoothstep(0.05, 0.30, h);
  col *= 1.0 + 0.10 * sin(h * 150.0 + fine * 6.0) * mesa;
  vec3 sand = ramp(0.5) * vec3(1.18, 1.08, 0.92);
  col = mix(col, sand * (0.95 + fine * 0.2), hv.g * 0.8);
  col = mix(col, vec3(0.70, 0.68, 0.63) * (0.92 + fine * 0.4), hv.b * 0.9);
  float edge = 1.0 - uIce * 0.16;
  float cap = smoothstep(edge - 0.015, edge + 0.015, lat + fbm(p * 5.0 + 33.0, 4) * 0.05);
  col = mix(col, vec3(0.74, 0.76, 0.78), cap);
  code = hv.b * 0.35 + cap * 0.4;

  #elif CLS == CLS_LAVA
  float fine = hv.a;
  col = ramp(clamp(0.40 + h * 0.65 + (hv.b - 0.5) * 0.30 + fine * 0.35, 0.0, 1.0));
  col = mix(col, vec3(0.012, 0.010, 0.010), smoothstep(0.04, 0.45, hv.g));
  code = smoothstep(0.3, 0.8, hv.g) * 0.6;

  #elif CLS == CLS_ICE
  float fine = hv.a;
  // plains: provinces of older (duller, faintly stained) and younger (bright, bluish) ice
  float prov = fbm(p * 2.2 + 21.0, 5);
  float mott = fbm(p * 11.0 + 5.0, 4);
  col = ramp(clamp(0.74 + h * 1.5 + prov * 0.55 + mott * 0.22 + fine * 0.22, 0.34, 1.0));
  vec3 stain = uPal[0] * vec3(1.08, 0.92, 0.80) * (0.75 + fine * 0.7 + mott * 0.4);
  float chaos = max(hv.b, 0.0) * (0.75 + mott * 1.2 + fine * 0.8);
  col = mix(col, mix(col, stain, 0.8), clamp(chaos, 0.0, 1.0) * 0.8);
  col = mix(col, stain, clamp(hv.g * 1.15, 0.0, 1.0) * 0.92);
  col = mix(col, vec3(0.84, 0.86, 0.88), clamp(-hv.b, 0.0, 1.0) * 0.6);
  code = 0.75 * (1.0 - clamp(hv.g + chaos, 0.0, 1.0) * 0.7);
  #else
  col = vec3(0.3);
  #endif

  col = clamp(col, 0.0, 0.85);
  fragColor = vec4(sqrt(col), code);
#endif
}
