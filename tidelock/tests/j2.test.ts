// W3-A J2 rider (src/world/j2.ts): the acceleration is the gradient of the J2 potential, and an integrated orbit's
// node regresses at the secular rate within 3 %.

import { describe, expect, it } from 'vitest';
import { J2_AX, J2_J2, J2_KX, J2_MU, J2_R, j2Accel, makeJ2In, nodalRate } from '../src/world/j2';

const MU = 3.2e14, R = 5.6e6, J2v = 0.011;

describe('W3-A J2', () => {
  it('a_J2 = −∇U with U = (μ J2 R²/2r³)(3ζ²/r² − 1)', () => {
    const J = makeJ2In();
    J[J2_KX] = 0; J[J2_KX + 1] = 1; J[J2_KX + 2] = 0; J[J2_MU] = MU; J[J2_R] = R; J[J2_J2] = J2v;
    const U = (x: number, y: number, z: number) => { const r = Math.hypot(x, y, z), ze = y; return ((MU * J2v * R * R) / (2 * r * r * r)) * ((3 * ze * ze) / (r * r) - 1); };
    const p = [6.1e6, 2.3e6, -1.7e6], h = 1;
    J[0] = p[0]; J[1] = p[1]; J[2] = p[2];
    j2Accel(J);
    for (let k = 0; k < 3; k++) {
      const a = [...p], b = [...p];
      a[k] += h; b[k] -= h;
      const g = -(U(a[0], a[1], a[2]) - U(b[0], b[1], b[2])) / (2 * h);
      expect(Math.abs(J[J2_AX + k] - g) / Math.hypot(J[9], J[10], J[11])).toBeLessThan(1e-6);
    }
  });

  it('nodal regression of an integrated orbit within 3 % of −(3/2) n J2 (R/p)² cos i', () => {
    const J = makeJ2In();
    J[J2_KX + 1] = 1; J[J2_MU] = MU; J[J2_R] = R; J[J2_J2] = J2v;
    const a = 7.0e6, inc = 0.6;
    const vc = Math.sqrt(MU / a);
    // spin axis +Y, reference plane XZ: start on +X with the velocity tilted by i about +X
    let x = a, y = 0, z = 0, vx = 0, vy = vc * Math.sin(inc), vz = -vc * Math.cos(inc);
    const acc = (px: number, py: number, pz: number, out: number[]) => {
      const r2 = px * px + py * py + pz * pz, r = Math.sqrt(r2), k = -MU / (r2 * r);
      J[0] = px; J[1] = py; J[2] = pz; j2Accel(J);
      out[0] = k * px + J[9]; out[1] = k * py + J[10]; out[2] = k * pz + J[11];
    };
    const node = () => { const hx = y * vz - z * vy, hz = x * vy - y * vx; return Math.atan2(hx, hz); };
    // the node averaged over the first and the last orbit (removes the short-period terms of the osculating node)
    let first = 0, last = 0, rMean = 0;
    const T = 2 * Math.PI * Math.sqrt((a * a * a) / MU), dt = T / 2000, steps = 2000 * 20;
    const k1 = [0, 0, 0], k2 = [0, 0, 0], k3 = [0, 0, 0], k4 = [0, 0, 0];
    for (let s = 0; s < steps; s++) {
      rMean += Math.hypot(x, y, z) / steps;
      if (s < 2000) first += node() / 2000;
      if (s >= steps - 2000) last += node() / 2000;
      acc(x, y, z, k1);
      acc(x + 0.5 * dt * vx, y + 0.5 * dt * vy, z + 0.5 * dt * vz, k2);
      const v2x = vx + 0.5 * dt * k1[0], v2y = vy + 0.5 * dt * k1[1], v2z = vz + 0.5 * dt * k1[2];
      acc(x + 0.5 * dt * v2x, y + 0.5 * dt * v2y, z + 0.5 * dt * v2z, k3);
      const v3x = vx + 0.5 * dt * k2[0], v3y = vy + 0.5 * dt * k2[1], v3z = vz + 0.5 * dt * k2[2];
      acc(x + dt * v3x, y + dt * v3y, z + dt * v3z, k4);
      const v4x = vx + dt * k3[0], v4y = vy + dt * k3[1], v4z = vz + dt * k3[2];
      x += (dt / 6) * (vx + 2 * v2x + 2 * v3x + v4x); y += (dt / 6) * (vy + 2 * v2y + 2 * v3y + v4y); z += (dt / 6) * (vz + 2 * v2z + 2 * v3z + v4z);
      vx += (dt / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]); vy += (dt / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]); vz += (dt / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
    }
    let dn = last - first;
    while (dn > Math.PI) dn -= 2 * Math.PI;
    while (dn < -Math.PI) dn += 2 * Math.PI;
    const got = dn / ((steps - 2000) * dt), want = nodalRate(MU, R, J2v, rMean, 0, inc); // the mean radius: the J2 orbit started at r = a is not a circle of radius a
    console.log(`J2 nodal rate: integrated ${got.toExponential(4)} rad/s, secular formula ${want.toExponential(4)} rad/s (${(100 * (got / want - 1)).toFixed(2)} %)`);
    expect(Math.abs(got / want - 1)).toBeLessThan(0.03);
  });
});
