// ---------------------------------------------------------------------------------------------
// Gas / ice giant bake: banded cloud tops with sheared turbulence and vortex storms.
// The pattern coordinate is advected through a toy flow (alternating zonal jets + curl-noise
// eddies + storm vortices) before the band colours are looked up, which folds the detail into
// streaks, festoons and spirals instead of plain noise.
//   rgb = sqrt(albedo), a = cloud-top brightness (used for a hint of relief at runtime)
// ---------------------------------------------------------------------------------------------
uniform vec3 uPal[6];
uniform int uPalN;
uniform float uBands;
uniform float uTurb;
uniform float uContrast;
uniform vec4 uStorm[8];      // xyz = centre (unit), w = radius (radians)
uniform vec4 uStormP[8];     // x = twist, y = type (0 warm oval, 1 white oval, 2 dark spot), z = aspect, w = tint strength
uniform int uStormN;
uniform float uFine;

vec3 ramp(float t) {
  float x = clamp(t, 0.0, 1.0) * float(uPalN - 1);
  int i = int(floor(x));
  int j = min(i + 1, uPalN - 1);
  float f = x - float(i);
  return mix(uPal[i], uPal[j], f * f * (3.0 - 2.0 * f));
}

vec3 rotAround(vec3 v, vec3 axis, float ang) {
  float c = cos(ang);
  float s = sin(ang);
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}

// band coordinate: 0..uBands from south to north pole, with irregular band widths
float bandCoord(float y) {
  float x = (asin(clamp(y, -1.0, 1.0)) / 3.14159265 + 0.5) * uBands;
  float i = floor(x * 0.5);
  float f = x * 0.5 - i;
  float w = mix(hash11(i + 40.0), hash11(i + 41.0), f * f * (3.0 - 2.0 * f));
  return x + (w - 0.5) * 1.1;
}

vec3 bandColor(float x, out float belt) {
  float i = floor(x);
  float f = x - i;
  float ta = fract(i * 0.618034 + hash11(i + 7.0) * 0.25);
  float tb = fract((i + 1.0) * 0.618034 + hash11(i + 8.0) * 0.25);
  float t = smoothstep(0.36, 0.64, f);
  belt = mix(mod(i, 2.0), mod(i + 1.0, 2.0), t);
  // belts (odd bands) are darker and warmer than the zones between them
  vec3 ca = ramp(ta) * mix(vec3(1.06), vec3(0.62, 0.55, 0.50), mod(i, 2.0) * uContrast);
  vec3 cb = ramp(tb) * mix(vec3(1.06), vec3(0.62, 0.55, 0.50), mod(i + 1.0, 2.0) * uContrast);
  return mix(ca, cb, t);
}

void main() {
  vec3 p = normalize(cubeDir(uFace, gl_FragCoord.xy / uRes));
  vec3 q = p;

  // storm vortices wind the pattern up
  for (int i = 0; i < uStormN; i++) {
    vec3 c = uStorm[i].xyz;
    float d = acos(clamp(dot(q, c), -1.0, 1.0)) / uStorm[i].w;
    q = rotAround(q, c, uStormP[i].x * exp(-d * d * 1.6));
  }

  // advect: curl-noise eddies + alternating zonal jets
  float F = 2.6;
  float A = 0.062 * uTurb;
  for (int k = 0; k < 4; k++) {
    float x = bandCoord(q.y);
    float fx = fract(x);
    float edge = 1.0 - abs(fx - 0.5) * 2.0;                  // 1 at band boundaries
    vec4 n = noised(vec3(q.x, q.y * 2.2, q.z) * F + float(k) * 19.3);
    vec3 v = cross(q, n.yzw * vec3(1.0, 2.2, 1.0));
    q = normalize(q + v * A * (0.35 + 0.9 * edge));
    float jet = sin(x * 3.14159265);
    q = rotAround(q, vec3(0.0, 1.0, 0.0), jet * 0.30 * (0.4 + uTurb));
    F *= 2.1;
    A *= 0.5;
  }

  float x = bandCoord(q.y);
  float belt;
  vec3 col = bandColor(x, belt);

  // streaky detail, already sheared by the advection; stretched further along latitude circles
  vec3 qs = vec3(q.x, q.y * 4.0, q.z);
  float streak = fbm(qs * 5.0 + 3.0, 6);
  float fineS = fbm(qs * 17.0 + 31.0, 4) * uFine;
  float fil = ridged(qs * 7.0 + 9.0, 5);
  col *= 1.0 + (streak * 0.85 + fineS * 0.5) * uContrast;
  // dark warm filaments inside belts, pale puffs in zones
  col = mix(col, col * vec3(0.74, 0.62, 0.55), smoothstep(0.25, 0.75, fil) * belt * 0.6 * uContrast);
  col += (1.0 - belt) * smoothstep(0.12, 0.45, streak + fineS) * 0.07 * uContrast;

  // poles: bands dissolve into mottled cyclone fields
  float polar = smoothstep(0.80, 0.95, abs(p.y) + streak * 0.05);
  vec3 w = worley(q * 13.0);
  vec3 pc = ramp(0.15) * vec3(0.72, 0.78, 0.86) * (0.8 + 0.5 * w.x);
  col = mix(col, pc, polar * 0.75);

  float bright = 0.5 + streak * 0.8;
  // storm ovals
  for (int i = 0; i < uStormN; i++) {
    vec3 c = uStorm[i].xyz;
    vec3 dv = p - c * dot(p, c);
    vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), c));
    float de = dot(dv, east) / uStormP[i].z;
    float dn = dot(dv, cross(c, east));
    float d = sqrt(de * de + dn * dn) / uStorm[i].w;
    float inside = smoothstep(1.0, 0.55, d + streak * 0.25);
    float coreF = smoothstep(0.6, 0.0, d);
    vec3 sc;
    if (uStormP[i].y < 0.5) {
      sc = mix(ramp(0.0), vec3(0.62, 0.22, 0.10), 0.6) * (0.85 + 0.5 * coreF + streak * 0.6);
    } else if (uStormP[i].y < 1.5) {
      sc = vec3(0.80, 0.78, 0.74) * (0.9 + streak * 0.4);
    } else {
      sc = col * vec3(0.42, 0.50, 0.62);
    }
    col = mix(col, sc, inside * uStormP[i].w);
    // pale collar
    col += smoothstep(1.35, 1.0, d) * smoothstep(0.8, 1.0, d) * 0.05 * uStormP[i].w;
    bright += inside * 0.3;
  }

  // high white cirrus streaks (prominent on ice giants)
  float cirrus = pow(ridged(vec3(q.x, q.y * 9.0, q.z) * 3.1 + 55.0, 4), 5.0) * smoothstep(0.0, 0.25, fbm(q * 2.0 + 90.0, 3));
  col = mix(col, vec3(0.82, 0.84, 0.86), clamp(cirrus * 3.0 * (1.2 - uTurb), 0.0, 0.7));

  col = clamp(col, 0.0, 0.88);
  fragColor = vec4(sqrt(col), clamp(bright, 0.0, 1.0));
}
