// ---------------------------------------------------------------------------------------------
// Cloud layer bake: a raw "cloudiness" field in R (thresholded at runtime so cover and edge
// softness stay adjustable and the edges can be eroded by the detail layer up close).
// uStyle: 0 = temperate circulation (ITCZ, storm tracks, cyclones), 1 = tidally locked
// (cloud over the terminator ring, clear dry air over the scorched face), 2 = thin dust / cirrus.
// The field is built from four scales so the threshold cuts weather systems out of it rather than
// blobs: synoptic "weather", warped frontal bands, ridged streaks and cellular cumulus fields.
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
    core += fall * 0.20 - exp(-d * d * 60.0) * 0.5;
  }
  // synoptic scale: where the weather systems are
  vec3 qw = q + vnoise3(q * 1.5 + 5.0) * 0.28;
  float weather = fbm(qw * 2.1 + 9.0, 4);
  // frontal bands: warped again and stretched along latitude circles
  vec3 q2 = qw + vnoise3(qw * 4.6 + 17.0) * 0.09;
  vec3 qs = vec3(q2.x, q2.y * 2.1, q2.z);
  float mid = fbmGain(qs * 5.2 + 3.0, 6, 0.57);
  float streak = ridged(qs * 3.7 + 31.0, 5);
  // broken cumulus fields and fine wisps
  float cells = billow(q2 * 24.0 + 7.0, 4);
  float wisp = fbm(qs * 41.0 + 13.0, 3);
  float f;
  if (uStyle == 0) {
    float y = p.y + gnoise(p * 2.0 + 71.0) * 0.06;
    float band = 0.09 * exp(-pow(y / 0.10, 2.0)) + 0.13 * exp(-pow((abs(y) - 0.72) / 0.16, 2.0)) -
                 0.13 * exp(-pow((abs(y) - 0.36) / 0.13, 2.0));
    f = weather * 0.95 + mid * 0.62 + (streak - 0.35) * 0.20 + (cells - 0.24) * 0.42 + wisp * 0.10 + band + core;
  } else if (uStyle == 1) {
    float s = p.x;
    float band = 0.16 * exp(-pow((s - 0.12) / 0.22, 2.0)) - 0.30 * smoothstep(0.32, 0.62, s) - 0.45 * smoothstep(0.62, 0.9, s) + 0.05 * smoothstep(0.0, -0.7, s);
    f = weather * 0.85 + mid * 0.62 + (streak - 0.35) * 0.24 + (cells - 0.24) * 0.40 + wisp * 0.10 + band + core;
  } else {
    // high thin streamers: mostly streak, little bulk
    vec3 qt = vec3(q2.x, q2.y * 3.4, q2.z);
    float thin = ridged(qt * 2.9 + 51.0, 5);
    f = weather * 0.95 + (thin - 0.32) * 0.26 + mid * 0.30 + wisp * 0.06;
  }
  float v = clamp(f * 0.85 + 0.5, 0.0, 1.0);
  if (uPack == 1) {
    fragColor = vec4(v, 0.0, 0.0, 1.0);
    return;
  }
  fragColor = vec4(v, v, v, 1.0);
}
