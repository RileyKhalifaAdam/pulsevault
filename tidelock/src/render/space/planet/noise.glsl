// ---------------------------------------------------------------------------------------------
// Procedural noise library for the planet bake shaders (GLSL ES 3.00).
// Integer hashing only, so every GPU produces the same worlds from the same seed.
// Requires `precision highp float; precision highp int;` in the including shader.
// ---------------------------------------------------------------------------------------------
uniform ivec3 uSeedI;

vec3 hash33(ivec3 p) {
  uvec3 q = uvec3(p + uSeedI) * uvec3(1597334673u, 3812015801u, 2798796415u);
  q = (q.x ^ q.y ^ q.z) * uvec3(1597334673u, 3812015801u, 2798796415u);
  return vec3(q >> 8) * (1.0 / 16777216.0);
}

float hash11(float x) {
  uint n = uint(int(floor(x)) + uSeedI.x * 7 + uSeedI.y) * 2654435761u;
  n = (n ^ (n >> 15)) * 2246822519u;
  n = (n ^ (n >> 13)) * 3266489917u;
  n = n ^ (n >> 16);
  return float(n >> 8) * (1.0 / 16777216.0);
}

// Gradient noise, roughly [-1, 1] (sigma ~0.3).
float gnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = x - i;
  ivec3 ip = ivec3(i);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(hash33(ip) * 2.0 - 1.0, f);
  float b = dot(hash33(ip + ivec3(1, 0, 0)) * 2.0 - 1.0, f - vec3(1.0, 0.0, 0.0));
  float c = dot(hash33(ip + ivec3(0, 1, 0)) * 2.0 - 1.0, f - vec3(0.0, 1.0, 0.0));
  float d = dot(hash33(ip + ivec3(1, 1, 0)) * 2.0 - 1.0, f - vec3(1.0, 1.0, 0.0));
  float e = dot(hash33(ip + ivec3(0, 0, 1)) * 2.0 - 1.0, f - vec3(0.0, 0.0, 1.0));
  float g = dot(hash33(ip + ivec3(1, 0, 1)) * 2.0 - 1.0, f - vec3(1.0, 0.0, 1.0));
  float h = dot(hash33(ip + ivec3(0, 1, 1)) * 2.0 - 1.0, f - vec3(0.0, 1.0, 1.0));
  float k = dot(hash33(ip + ivec3(1, 1, 1)) * 2.0 - 1.0, f - vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z) * 1.35;
}

// Gradient noise with analytic derivatives: (value, d/dx, d/dy, d/dz).
vec4 noised(vec3 x) {
  vec3 i = floor(x);
  vec3 f = x - i;
  ivec3 ip = ivec3(i);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec3 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  vec3 ga = hash33(ip) * 2.0 - 1.0;
  vec3 gb = hash33(ip + ivec3(1, 0, 0)) * 2.0 - 1.0;
  vec3 gc = hash33(ip + ivec3(0, 1, 0)) * 2.0 - 1.0;
  vec3 gd = hash33(ip + ivec3(1, 1, 0)) * 2.0 - 1.0;
  vec3 ge = hash33(ip + ivec3(0, 0, 1)) * 2.0 - 1.0;
  vec3 gf = hash33(ip + ivec3(1, 0, 1)) * 2.0 - 1.0;
  vec3 gg = hash33(ip + ivec3(0, 1, 1)) * 2.0 - 1.0;
  vec3 gh = hash33(ip + ivec3(1, 1, 1)) * 2.0 - 1.0;
  float va = dot(ga, f);
  float vb = dot(gb, f - vec3(1.0, 0.0, 0.0));
  float vc = dot(gc, f - vec3(0.0, 1.0, 0.0));
  float vd = dot(gd, f - vec3(1.0, 1.0, 0.0));
  float ve = dot(ge, f - vec3(0.0, 0.0, 1.0));
  float vf = dot(gf, f - vec3(1.0, 0.0, 1.0));
  float vg = dot(gg, f - vec3(0.0, 1.0, 1.0));
  float vh = dot(gh, f - vec3(1.0, 1.0, 1.0));
  float v = va + u.x * (vb - va) + u.y * (vc - va) + u.z * (ve - va) + u.x * u.y * (va - vb - vc + vd) + u.y * u.z * (va - vc - ve + vg) +
            u.z * u.x * (va - vb - ve + vf) + (-va + vb + vc - vd + ve - vf - vg + vh) * u.x * u.y * u.z;
  vec3 d = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.z * (ge - ga) + u.x * u.y * (ga - gb - gc + gd) + u.y * u.z * (ga - gc - ge + gg) +
           u.z * u.x * (ga - gb - ge + gf) + (-ga + gb + gc - gd + ge - gf - gg + gh) * u.x * u.y * u.z +
           du * (vec3(vb, vc, ve) - va + u.yzx * vec3(va - vb - vc + vd, va - vc - ve + vg, va - vb - ve + vf) +
                 u.zxy * vec3(va - vb - ve + vf, va - vb - vc + vd, va - vc - ve + vg) +
                 u.yzx * u.zxy * (-va + vb + vc - vd + ve - vf - vg + vh));
  return vec4(v, d) * 1.35;
}

// Octave rotation (rotation * 2.0) to hide lattice alignment.
const mat3 OCT = mat3(0.00, 1.60, 1.20, -1.60, 0.72, -0.96, -1.20, -0.96, 1.28);

// Fractal sum, roughly [-0.8, 0.8] (sigma ~0.2).
float fbm(vec3 p, int oct) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < oct; i++) {
    s += a * gnoise(p);
    p = OCT * p + 11.7;
    a *= 0.5;
  }
  return s;
}

float fbmGain(vec3 p, int oct, float gain) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < oct; i++) {
    s += a * gnoise(p);
    p = OCT * p + 11.7;
    a *= gain;
  }
  return s;
}

// Ridged multifractal, [0, 1): sharp crests, smooth valleys.
float ridged(vec3 p, int oct) {
  float s = 0.0;
  float a = 0.5;
  float w = 1.0;
  for (int i = 0; i < oct; i++) {
    float n = 1.0 - min(abs(gnoise(p)) * 1.9, 1.0);
    n *= n;
    s += a * n * w;
    w = clamp(n * 1.8, 0.0, 1.0);
    p = OCT * p + 7.3;
    a *= 0.5;
  }
  return s;
}

// Billowy (abs) fbm, [0, ~0.6].
float billow(vec3 p, int oct) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < oct; i++) {
    s += a * abs(gnoise(p));
    p = OCT * p + 5.1;
    a *= 0.5;
  }
  return s;
}

vec3 vnoise3(vec3 p) {
  return vec3(gnoise(p), gnoise(p + vec3(31.4, 17.7, -12.1)), gnoise(p + vec3(-7.9, 43.2, 23.5)));
}

// Cellular noise. Returns (F1, F2, cell id hash).
vec3 worley(vec3 x) {
  ivec3 ip = ivec3(floor(x));
  vec3 f = x - floor(x);
  float f1 = 9.0;
  float f2 = 9.0;
  float id = 0.0;
  for (int k = -1; k <= 1; k++) {
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        ivec3 o = ivec3(i, j, k);
        vec3 r = hash33(ip + o);
        vec3 dlt = vec3(o) + r - f;
        float d = dot(dlt, dlt);
        if (d < f1) {
          f2 = f1;
          f1 = d;
          id = r.x;
        } else if (d < f2) {
          f2 = d;
        }
      }
    }
  }
  return vec3(sqrt(f1), sqrt(f2), id);
}

// One octave of an impact-crater field on the unit sphere.
//   p: unit direction, freq: lattice cells per unit length, density: 0..1 chance per candidate cell.
// Returns (height delta in units of sphere radius, ejecta/ray brightness 0..1, floor mask 0..1).
vec3 craterLayer(vec3 p, float freq, float density, float sharp) {
  vec3 x = p * freq;
  ivec3 ip = ivec3(floor(x));
  float h = 0.0;
  float ej = 0.0;
  float fl = 0.0;
  for (int k = -1; k <= 1; k++) {
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        ivec3 c = ip + ivec3(i, j, k);
        vec3 r = hash33(c);
        vec3 cp = vec3(c) + 0.15 + 0.7 * r;
        float cr = length(cp);
        if (abs(cr - freq) > 0.5) continue;
        vec3 r2 = hash33(c + ivec3(91, 37, 53));
        if (r2.x > density) continue;
        vec3 cdir = cp / cr;
        float rad = mix(0.10, 0.46, r2.y * r2.y * r2.y) / freq;
        vec3 dv = p - cdir;
        float dist = length(dv);
        float d = dist / rad;
        if (d > 3.5) continue;
        // irregular outline
        d *= 1.0 + 0.10 * gnoise(p * freq * 2.7 + r * 40.0);
        float age = r2.z;                         // 0 fresh .. 1 degraded
        float fresh = 1.0 - age;
        float crisp = mix(1.0, 0.35, age) * sharp;
        float cavity = d * d - 1.0;
        float floorD = mix(-1.0, -0.45, smoothstep(0.02, 0.10, rad));   // big craters have flat floors
        float bowl = max(cavity, floorD);
        float inside = smoothstep(1.0, 0.82, d);
        float rimW = 0.22;
        float rim = d < 1.0 ? exp(-(1.0 - d) * (1.0 - d) / 0.012) : exp(-(d - 1.0) / rimW);
        float peak = smoothstep(0.045, 0.11, rad) * exp(-d * d / 0.018) * 0.35;
        float prof = bowl * inside * 0.55 * crisp + rim * 0.22 * crisp + peak * crisp;
        h += prof * rad * 1.4;
        // ejecta blanket + rays on fresh craters; faded before the lattice neighbourhood runs out
        float reach = smoothstep(1.0, 0.7, dist * freq);
        float ang = atan(dot(dv, cross(cdir, normalize(vec3(0.31, 0.77, 0.55)))), dot(dv, normalize(cross(cdir, vec3(0.55, -0.31, 0.77)))));
        float rays = pow(0.5 + 0.5 * sin(ang * (7.0 + floor(r.x * 6.0)) + r.y * 6.28), 3.0) * 0.6 +
                     pow(0.5 + 0.5 * sin(ang * (17.0 + floor(r.z * 9.0)) + r.x * 6.28), 6.0) * 0.4;
        float blanket = exp(-max(d - 1.0, 0.0) * 1.6);
        float rayFall = exp(-max(d - 1.0, 0.0) * 0.55);
        float e = (blanket * 0.55 + rays * rayFall * 0.75) * smoothstep(0.75, 1.05, d) + inside * 0.25;
        ej += e * fresh * fresh * fresh * reach;
        fl += inside * smoothstep(0.05, 0.12, rad);
      }
    }
  }
  return vec3(h, ej, fl);
}
