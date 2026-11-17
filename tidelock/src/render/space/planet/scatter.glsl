// ---------------------------------------------------------------------------------------------
// Analytic single-scattering atmosphere shared by the surface, limb and ring shaders.
// All lengths are in body radii (surface at r = 1); density falls off exponentially with scale
// height uAtmo.y and is treated as zero above the shell radius uAtmo.x.
// SCATTER_STEPS must be #defined by the including shader.
// ---------------------------------------------------------------------------------------------
uniform vec4 uAtmo;        // x = shell radius, y = scale height, z = Mie g, w = multiple-scattering boost
uniform vec3 uBetaR;       // molecular scattering coefficient at the surface, per body radius
uniform vec3 uBetaE;       // total extinction coefficient at the surface, per body radius
uniform float uBetaM;      // haze (Mie) scattering coefficient at the surface, per body radius
uniform vec3 uSunDir;      // unit, world axes, from the body toward the star
uniform vec3 uSunColor;    // linear star colour * intensity (sun-lit white = this)

// Integral of density along a ray leaving radius r with zenith cosine mu, out to space
// (Chapman grazing-incidence function, Schueler's closed-form approximation).
float opticalLength(float r, float mu) {
  float H = uAtmo.y;
  float rho = exp(-(r - 1.0) / H);
  float c = sqrt(1.5707963 * r / H);
  if (mu >= 0.0) {
    return H * rho * c / ((c - 1.0) * mu + 1.0);
  }
  float rp = r * sqrt(max(1.0 - mu * mu, 0.0));      // perigee of the ray
  float rhoP = exp(min(-(rp - 1.0) / H, 30.0));
  float cp = sqrt(1.5707963 * rp / H);
  return H * max(2.0 * rhoP * cp - rho * c / ((c - 1.0) * (-mu) + 1.0), 0.0);
}

// 0 when the planet itself blocks the star as seen from radius r with zenith cosine mu.
float planetShadow(float r, float mu) {
  if (mu >= 0.0) return 1.0;
  float rp = r * sqrt(max(1.0 - mu * mu, 0.0));
  return smoothstep(1.0 - 0.35 * uAtmo.y, 1.0 + 0.65 * uAtmo.y, rp);
}

// Star light reaching a point at radius r (zenith cosine mu) after extinction.
vec3 sunTransmittance(float r, float mu) {
  return exp(-uBetaE * opticalLength(r, mu)) * planetShadow(r, mu);
}

// In-scattered radiance along o + d * t for t in [t0, t1]; `trans` receives the view transmittance.
vec3 atmoScatter(vec3 o, vec3 d, float t0, float t1, out vec3 trans) {
  float H = uAtmo.y;
  float dt = (t1 - t0) / float(SCATTER_STEPS);
  float mu = dot(d, uSunDir);
  float g = uAtmo.z;
  float phR = 0.1875 * (1.0 + mu * mu);
  float phM = 0.25 * (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5);
  vec3 sum = vec3(0.0);
  vec3 sumM = vec3(0.0);
  float odV = 0.0;
  float rhoPrev = 0.0;
  float rPrev = 0.0;
  vec3 sPrev = vec3(0.0);
  for (int i = 0; i <= SCATTER_STEPS; i++) {
    float t = t0 + dt * float(i);
    vec3 x = o + d * t;
    float r = max(length(x), 1.0);
    float rho = exp(-(r - 1.0) / H);
    if (i > 0) {
      // exact for a locally exponential profile
      float dr = r - rPrev;
      odV += (abs(dr) > 1e-5 * H ? (rhoPrev - rho) * H / dr : 0.5 * (rho + rhoPrev)) * dt;
    }
    float muS = dot(x, uSunDir) / r;
    vec3 s = rho * exp(-uBetaE * (odV + opticalLength(r, muS))) * planetShadow(r, muS);
    if (i > 0) sum += 0.5 * (s + sPrev) * dt;
    rhoPrev = rho;
    rPrev = r;
    sPrev = s;
  }
  trans = exp(-uBetaE * odV);
  return sum * (uBetaR * (phR * uAtmo.w) + vec3(uBetaM * phM)) * uSunColor;
}
