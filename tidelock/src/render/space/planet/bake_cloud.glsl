// ---------------------------------------------------------------------------------------------
// Cloud layer bake: a raw "cloudiness" field in R (thresholded at runtime so cover and edge
// softness stay adjustable and the edges can be eroded by the detail layer up close).
// uStyle: 0 = temperate circulation (ITCZ, storm tracks, cyclones), 1 = tidally locked
// (sub-stellar convective shield around +X), 2 = thin dust / cirrus.
// ---------------------------------------------------------------------------------------------
uniform int uStyle;
uniform vec4 uVortex[8];     // xyz = centre (unit), w = radius (radians)
uniform float uVortexS[8];   // twist (radians at the core, signed)
uniform int uVortexN;
uniform int uPack;

vec3 rotAround(vec3 v, vec3 axis, float ang) {
  float c = cos(ang);
  float s = sin(ang);
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}

void main() {
  vec3 p = normalize(cubeDir(uFace, gl_FragCoord.xy / uRes));
  vec3 q = p;
  float core = 0.0;
  for (int i = 0; i < uVortexN; i++) {
    vec3 c = uVortex[i].xyz;
    float d = acos(clamp(dot(q, c), -1.0, 1.0)) / uVortex[i].w;
    float fall = exp(-d * d * 1.3);
    q = rotAround(q, c, uVortexS[i] * fall);
    core += fall * 0.22 - exp(-d * d * 55.0) * 0.6;
  }
  vec3 q2 = q + vnoise3(q * 2.1 + 5.0) * 0.22;
  q2 += vnoise3(q2 * 5.5 + 17.0) * 0.07;
  vec3 qs = vec3(q2.x, q2.y * 1.7, q2.z);
  float base = fbm(qs * 2.6 + 9.0, 7);
  float wisp = ridged(qs * 6.5 + 3.0, 4);
  float f;
  if (uStyle == 0) {
    float y = p.y + gnoise(p * 2.0 + 71.0) * 0.06;
    float band = 0.10 * exp(-pow(y / 0.11, 2.0)) + 0.15 * exp(-pow((abs(y) - 0.72) / 0.16, 2.0)) -
                 0.15 * exp(-pow((abs(y) - 0.36) / 0.13, 2.0));
    f = base * 1.25 + (wisp - 0.3) * 0.16 + band + core;
  } else if (uStyle == 1) {
    float s = p.x;
    float band = 0.34 * smoothstep(0.15, 0.95, s) - 0.10 * exp(-pow((s - 0.05) / 0.2, 2.0)) - 0.06 * smoothstep(0.0, -0.8, s);
    f = base * 1.15 + (wisp - 0.3) * 0.2 + band + core;
  } else {
    f = base * 0.9 + (wisp - 0.25) * 0.55 + core;
  }
  float v = clamp(f * 0.9 + 0.5, 0.0, 1.0);
  if (uPack == 1) {
    fragColor = vec4(v, 0.0, 0.0, 1.0);
    return;
  }
  fragColor = vec4(v, v, v, 1.0);
}
