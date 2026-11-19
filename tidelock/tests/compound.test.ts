// Compound collision shapes and rigid-body contact (src/world/compound.ts, src/data/hullColliders.ts).
import { describe, expect, it } from 'vitest';
import type { Quat, V3 } from '../src/core/types';
import { qFromAxisAngle, qFromTo } from '../src/core/vec';
import { HULL_COLLIDERS, type HullPartDef } from '../src/data/hullColliders';
import { INTERIORS } from '../src/data/interiors';
import { SHIP_LAYOUTS } from '../src/data/shipLayouts';
import { STATION_LAYOUTS } from '../src/data/stationLayouts';
import {
  collide, collidePlanet, compileCompound, compoundContains, compoundGyration, compoundSupport, DEFAULT_CONTACT, hullCompound, kineticEnergy,
  makeContactResult, Manifold, planetBody, solveManifold, stationCompound, type Compound, type ContactBody, type ContactParams,
} from '../src/world/compound';

const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const ID = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const one = (p: HullPartDef): Compound => compileCompound([p]);
const WREN = hullCompound('wren')!;
const WREN_MASS = 80000;
const wrenGyr = compoundGyration(WREN, v3());

function body(mass: number, gyr: V3, p: V3, v = v3(), q: Quat = ID(), w = v3()): ContactBody {
  return { p, v, q, w, invMass: mass > 0 ? 1 / mass : 0, invI: v3(mass > 0 ? 1 / (mass * gyr.x) : 0, mass > 0 ? 1 / (mass * gyr.y) : 0, mass > 0 ? 1 / (mass * gyr.z) : 0) };
}
const wren = (p: V3, v = v3(), q: Quat = ID(), w = v3()): ContactBody => body(WREN_MASS, wrenGyr, p, v, q, w);
const station = (p: V3, v = v3()): ContactBody => body(5e8, v3(1e4, 1e4, 1e4), p, v);
const fixed = (p: V3): ContactBody => body(0, v3(1, 1, 1), p);

/** Total linear momentum and angular momentum about the origin of a set of bodies (world axes). */
function momenta(bs: ContactBody[]): { P: V3; L: V3 } {
  const P = v3(), L = v3();
  for (const b of bs) {
    if (b.invMass === 0) continue;
    const m = 1 / b.invMass;
    P.x += m * b.v.x; P.y += m * b.v.y; P.z += m * b.v.z;
    L.x += m * (b.p.y * b.v.z - b.p.z * b.v.y); L.y += m * (b.p.z * b.v.x - b.p.x * b.v.z); L.z += m * (b.p.x * b.v.y - b.p.y * b.v.x);
    // Iω in world axes = R (I_local ω_local)
    const s = v3(b.w.x / b.invI.x, b.w.y / b.invI.y, b.w.z / b.invI.z);
    const r = rot(b.q, s);
    L.x += r.x; L.y += r.y; L.z += r.z;
  }
  return { P, L };
}
function rot(q: Quat, a: V3): V3 {
  const tx = 2 * (q.y * a.z - q.z * a.y), ty = 2 * (q.z * a.x - q.x * a.z), tz = 2 * (q.x * a.y - q.y * a.x);
  return v3(a.x + q.w * tx + (q.y * tz - q.z * ty), a.y + q.w * ty + (q.z * tx - q.x * tz), a.z + q.w * tz + (q.x * ty - q.y * tx));
}
/** Semi-implicit Euler step of a free body (no torque) under acceleration `a`. */
function step(b: ContactBody, dt: number, a = v3()): void {
  if (b.invMass === 0) return;
  b.v.x += a.x * dt; b.v.y += a.y * dt; b.v.z += a.z * dt;
  b.p.x += b.v.x * dt; b.p.y += b.v.y * dt; b.p.z += b.v.z * dt;
  const q = b.q, w = b.w, h = 0.5 * dt;
  const x = q.x + h * (q.w * w.x + q.y * w.z - q.z * w.y), y = q.y + h * (q.w * w.y + q.z * w.x - q.x * w.z);
  const z = q.z + h * (q.w * w.z + q.x * w.y - q.y * w.x), ww = q.w - h * (q.x * w.x + q.y * w.y + q.z * w.z);
  const l = Math.hypot(x, y, z, ww);
  q.x = x / l; q.y = y / l; q.z = z / l; q.w = ww / l;
}

describe('narrow phase against analytic cases', () => {
  const m = new Manifold();
  const N = v3();
  it('sphere–sphere', () => {
    const s = one({ name: 's', kind: 'sphere', c: [0, 0, 0], r: 1 });
    expect(collide(s, fixed(v3(1.5, 0, 0)), s, fixed(v3()), m)).toBe(1);
    expect(m.depth(0)).toBeCloseTo(0.5, 9);
    m.normal(0, fixed(v3()), N);
    expect(N.x).toBeCloseTo(1, 9);
    expect(collide(s, fixed(v3(2.2, 0, 0)), s, fixed(v3()), m)).toBe(0);
  });
  it('crossed capsules, parallel capsules (two points)', () => {
    const cx = one({ name: 'x', kind: 'capsule', a: [-2, 0, 0], b: [2, 0, 0], r: 0.5 });
    const cz = one({ name: 'z', kind: 'capsule', a: [0, 0, -2], b: [0, 0, 2], r: 1 });
    expect(collide(cx, fixed(v3(0.3, 1.4, 0.2)), cz, fixed(v3()), m)).toBe(1);
    expect(m.depth(0)).toBeCloseTo(0.1, 9);
    expect(m.normal(0, fixed(v3()), N).y).toBeCloseTo(1, 9);
    expect(collide(cx, fixed(v3(1, 0.9, 0)), cx, fixed(v3()), m)).toBe(2);
    expect(m.depth(0)).toBeCloseTo(0.1, 9);
    expect(m.depth(1)).toBeCloseTo(0.1, 9);
  });
  it('sphere on a box face and on a box corner', () => {
    const box = one({ name: 'b', kind: 'box', c: [0, 0, 0], h: [1, 1, 1] });
    const s = one({ name: 's', kind: 'sphere', c: [0, 0, 0], r: 0.5 });
    expect(collide(s, fixed(v3(0.3, 1.3, -0.2)), box, fixed(v3()), m)).toBe(1);
    expect(m.depth(0)).toBeCloseTo(0.2, 9);
    expect(m.normal(0, fixed(v3()), N).y).toBeCloseTo(1, 9);
    expect(collide(s, fixed(v3(1.2, 1.2, 1.2)), box, fixed(v3()), m)).toBe(1);
    expect(m.depth(0)).toBeCloseTo(0.5 - 0.2 * Math.sqrt(3), 9);
    m.normal(0, fixed(v3()), N);
    expect(N.x).toBeCloseTo(1 / Math.sqrt(3), 9);
    expect(N.z).toBeCloseTo(1 / Math.sqrt(3), 9);
    // Same pair with the box as A: equal depth, opposite normal.
    expect(collide(box, fixed(v3()), s, fixed(v3(1.2, 1.2, 1.2)), m)).toBe(1);
    expect(m.depth(0)).toBeCloseTo(0.5 - 0.2 * Math.sqrt(3), 9);
    expect(m.normal(0, fixed(v3(1.2, 1.2, 1.2)), N).x).toBeCloseTo(-1 / Math.sqrt(3), 9);
  });
  it('capsule lying on a box face gives a line contact', () => {
    const box = one({ name: 'b', kind: 'box', c: [0, 0, 0], h: [2, 1, 2] });
    const cap = one({ name: 'c', kind: 'capsule', a: [-1, 0, 0], b: [1, 0, 0], r: 0.5 });
    const n = collide(cap, fixed(v3(0, 1.4, 0)), box, fixed(v3()), m);
    expect(n).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < n; i++) expect(m.depth(i)).toBeCloseTo(0.1, 9);
  });
  it('box resting on a box: four corners; rotated 45°: still four', () => {
    const big = one({ name: 'b', kind: 'box', c: [0, 0, 0], h: [2, 1, 2] });
    const cube = one({ name: 'c', kind: 'box', c: [0, 0, 0], h: [1, 1, 1] });
    expect(collide(cube, fixed(v3(0, 1.9, 0)), big, fixed(v3()), m)).toBe(4);
    for (let i = 0; i < 4; i++) expect(m.depth(i)).toBeCloseTo(0.1, 9);
    const A = fixed(v3(0.2, 1.9, -0.1));
    A.q = qFromAxisAngle(v3(0, 1, 0), Math.PI / 4);
    expect(collide(cube, A, big, fixed(v3()), m)).toBe(4);
    for (let i = 0; i < 4; i++) expect(m.depth(i)).toBeCloseTo(0.1, 9);
  });
  it('box edge across box edge', () => {
    const cube = one({ name: 'c', kind: 'box', c: [0, 0, 0], h: [1, 1, 1] });
    const A = fixed(v3(0, 2 * Math.SQRT2 - 0.1, 0));
    A.q = qFromAxisAngle(v3(0, 0, 1), Math.PI / 4);
    const B = fixed(v3());
    B.q = qFromAxisAngle(v3(1, 0, 0), Math.PI / 4);
    expect(collide(cube, A, cube, B, m)).toBe(1);
    expect(m.depth(0)).toBeCloseTo(0.1, 6);
    expect(m.normal(0, B, N).y).toBeGreaterThan(0.999);
    const P = m.point(0, A, v3());
    expect(Math.hypot(P.x, P.z)).toBeLessThan(1e-6);
  });
});

describe('hull compounds', () => {
  it('every hull has at most 24 parts (the Wren, the hull the player lives in and touches, 72) and a sane bounding sphere', () => {
    for (const [id, parts] of Object.entries(HULL_COLLIDERS)) {
      expect(parts.length, id).toBeLessThanOrEqual(id === 'wren' ? 72 : 24);
      const c = hullCompound(id)!;
      expect(c.n, id).toBe(parts.length);
      expect(c.radius, id).toBeLessThan(SHIP_LAYOUTS[id as keyof typeof SHIP_LAYOUTS].radius * 1.15);
    }
  });
  it('the Wren matches its layout and encloses its interior', () => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < WREN.n; i++) {
      x0 = Math.min(x0, WREN.aabb[i * 6]); y0 = Math.min(y0, WREN.aabb[i * 6 + 1]); z0 = Math.min(z0, WREN.aabb[i * 6 + 2]);
      x1 = Math.max(x1, WREN.aabb[i * 6 + 3]); y1 = Math.max(y1, WREN.aabb[i * 6 + 4]); z1 = Math.max(z1, WREN.aabb[i * 6 + 5]);
    }
    const L = SHIP_LAYOUTS.wren;
    expect(x1 - x0).toBeCloseTo(L.width, 0);
    expect(z1 - z0).toBeCloseTo(L.length, 0);
    expect(Math.abs(y1 - y0 - L.height)).toBeLessThan(0.4); // the 32 m exterior stands 6.3 m (layout 6.6 with the lights)
    // mirror-symmetric about the centre plane
    for (const p of HULL_COLLIDERS.wren) {
      if (!p.name.endsWith('-stbd')) continue;
      const q = HULL_COLLIDERS.wren.find((o) => o.name === p.name.slice(0, -5) + '-port')!;
      expect(q, p.name).toBeDefined();
      const c = p.kind === 'capsule' ? p.a : p.c, d = q.kind === 'capsule' ? q.a : q.c;
      expect(d[0]).toBeCloseTo(-c[0], 6);
    }
    for (const e of L.engines) expect(compoundContains(WREN, e.pos.x, e.pos.y, e.pos.z - 0.05)).toBe(true);
    for (const r of INTERIORS.wren!.rooms) {
      const b = r.box;
      for (let k = 0; k < 27; k++) {
        const fx = (k % 3) / 2, fy = (((k / 3) | 0) % 3) / 2, fz = ((k / 9) | 0) / 2;
        const p = v3(b.min.x + (b.max.x - b.min.x) * fx, b.min.y + (b.max.y - b.min.y) * fy, b.min.z + (b.max.z - b.min.z) * fz);
        expect(compoundContains(WREN, p.x, p.y, p.z), `${r.id} ${p.x},${p.y},${p.z}`).toBe(true);
      }
    }
  });
});

describe('rigid-body response', () => {
  it('a wing-tip strike yaws the ship toward the struck side, angular momentum = r × J', () => {
    const A = wren(v3(), v3(0, 0, -1));
    // A post just ahead of the starboard wing's swept leading edge, 8 m out: moved in along the edge normal until it
    // overlaps by 1 cm.
    const nrm = v3(0.4432, 0, -0.8965), edge = v3(8, -0.415, 2.6 + ((8 - 4.8) * 2.2) / 4.45);
    const ball = one({ name: 'post', kind: 'sphere', c: [0, 0, 0], r: 1 });
    const m = new Manifold(), res = makeContactResult();
    let off = 2;
    while (off > 0 && (collide(WREN, A, ball, fixed(v3(edge.x + nrm.x * off, edge.y, edge.z + nrm.z * off)), m) === 0 || m.depth(0) < 0.01)) off -= 0.002;
    const B = station(v3(edge.x + nrm.x * off, edge.y, edge.z + nrm.z * off));
    const before = momenta([A, B]);
    const w0 = { ...A.w };
    expect(collide(WREN, A, ball, B, m)).toBe(1);
    expect(WREN.names[m.partA(0)]).toBe('wing-lead-stbd');
    const pc = m.point(0, A, v3());
    // (No position correction here, so the momenta are compared at the same poses.)
    solveManifold(m, A, B, 1 / 60, { ...DEFAULT_CONTACT, positionIterations: 0 }, res);
    expect(A.w.y).toBeLessThan(0); // about +Y negative: the nose swings to starboard (+X)
    expect(A.w.y * -16).toBeGreaterThan(0); // (ω × r_nose).x with r_nose = (0, 0, -16)
    // I Δω (body axes = world here) equals the reported angular impulse, which equals r × J.
    const dL = v3((A.w.x - w0.x) / A.invI.x, (A.w.y - w0.y) / A.invI.y, (A.w.z - w0.z) / A.invI.z);
    const rJ = v3(pc.y * res.impulse.z - pc.z * res.impulse.y, pc.z * res.impulse.x - pc.x * res.impulse.z, pc.x * res.impulse.y - pc.y * res.impulse.x);
    expect(len(v3(dL.x - res.angularImpulse.x, dL.y - res.angularImpulse.y, dL.z - res.angularImpulse.z))).toBeLessThan(1e-6 * len(dL));
    expect(len(v3(dL.x - rJ.x, dL.y - rJ.y, dL.z - rJ.z))).toBeLessThan(0.01 * len(dL));
    expect(res.impulse.z).toBeGreaterThan(0);
    // Linear and angular momentum of the pair are conserved.
    const after = momenta([A, B]);
    expect(len(v3(after.P.x - before.P.x, after.P.y - before.P.y, after.P.z - before.P.z))).toBeLessThan(1e-6 * WREN_MASS);
    expect(len(v3(after.L.x - before.L.x, after.L.y - before.L.y, after.L.z - before.L.z))).toBeLessThan(1e-6 * len(dL));
  });

  it('a head-on hit conserves momentum and loses exactly the restitution energy', () => {
    const prm: ContactParams = { ...DEFAULT_CONTACT, restitution: 0.5 };
    const s = one({ name: 's', kind: 'sphere', c: [0, 0, 0], r: 1 });
    const A = body(1000, v3(0.4, 0.4, 0.4), v3(1.99, 0, 0), v3(-3, 0, 0));
    const B = body(3000, v3(0.4, 0.4, 0.4), v3(), v3(1, 0, 0));
    const m = new Manifold(), res = makeContactResult();
    const e0 = kineticEnergy(A) + kineticEnergy(B);
    collide(s, A, s, B, m);
    solveManifold(m, A, B, 1 / 60, prm, res);
    const mu = (1000 * 3000) / 4000, loss = 0.5 * mu * (1 - 0.25) * 16;
    expect(1000 * A.v.x + 3000 * B.v.x).toBeCloseTo(-3000 + 3000, 6);
    expect(B.v.x - A.v.x).toBeCloseTo(-0.5 * (1 - -3), 9);
    expect(e0 - kineticEnergy(A) - kineticEnergy(B)).toBeCloseTo(loss, 3);
    expect(res.energy).toBeCloseTo(loss, 3);
    // The Wren broadside into a post level with its centre of mass (central: the normal runs through it): same law,
    // now with the real hull — the flat flank of the pressure hull at x = 3.6 m takes it.
    const W = wren(v3(), v3(2, 0, 0));
    const side = compoundSupport(WREN, 1, 0, 0) > 3.6 ? 3.6 : compoundSupport(WREN, 1, 0, 0);
    const S = station(v3(side + 0.3 - 0.01, 0, 0));
    const ball = one({ name: 'post', kind: 'sphere', c: [0, 0, 0], r: 0.3 });
    const k0 = kineticEnergy(W) + kineticEnergy(S), p0 = WREN_MASS * 2;
    expect(collide(WREN, W, ball, S, m)).toBe(1);
    expect(WREN.names[m.partA(0)]).toBe('hull');
    solveManifold(m, W, S, 1 / 60, prm, res);
    expect((WREN_MASS * W.v.x + 5e8 * S.v.x) / p0).toBeCloseTo(1, 9);
    const mu2 = (WREN_MASS * 5e8) / (WREN_MASS + 5e8), loss2 = 0.5 * mu2 * 0.75 * 4;
    expect((k0 - kineticEnergy(W) - kineticEnergy(S)) / loss2).toBeCloseTo(1, 4);
    expect(res.energy / loss2).toBeCloseTo(1, 4);
    expect(len(W.w)).toBeLessThan(1e-9);
  });

  it('a slow approach comes to rest against a station collider without jitter for 60 s', () => {
    const hull = one({ name: 'hull', kind: 'capsule', a: [0, 0, -30], b: [0, 0, 30], r: 20 });
    // 0.1 m above the hull at 0.15 m/s, pressed on by 0.1 m/s² (thrusters): it touches at ~0.2 m/s, below restSpeed.
    const belly = compoundSupport(WREN, 0, -1, 0);
    const A = wren(v3(), v3(0, -0.15, 0));
    const B = station(v3(0, -(20 + belly + 0.1), 0));
    const m = new Manifold(), res = makeContactResult(), dt = 1 / 60, push = v3(0, -0.1, 0);
    let maxV = 0, maxW = 0, yMin = Infinity, yMax = -Infinity, maxEnergyGain = 0, bounced = false;
    for (let i = 0; i < 3600; i++) {
      step(A, dt, push); step(B, dt);
      const e0 = kineticEnergy(A) + kineticEnergy(B);
      collide(WREN, A, hull, B, m);
      solveManifold(m, A, B, dt, DEFAULT_CONTACT, res);
      maxEnergyGain = Math.max(maxEnergyGain, kineticEnergy(A) + kineticEnergy(B) - e0);
      if (res.points > 0 && A.v.y - B.v.y > 0.02) bounced = true; // e = 0.2 at 0.2 m/s would rebound at 0.04
      if (i >= 600) {
        maxV = Math.max(maxV, len(v3(A.v.x - B.v.x, A.v.y - B.v.y, A.v.z - B.v.z)));
        maxW = Math.max(maxW, len(A.w));
        yMin = Math.min(yMin, A.p.y - B.p.y); yMax = Math.max(yMax, A.p.y - B.p.y);
      }
    }
    expect(bounced).toBe(false); // ~0.2 m/s is below the bounce threshold
    expect(maxV).toBeLessThan(1e-3);
    expect(maxW).toBeLessThan(1e-4);
    expect(yMax - yMin).toBeLessThan(2e-3);
    // Resting on the flat bottom of the belly (its keel line on the top of the r = 20 m hull).
    const rest = 20 + belly;
    expect(yMin).toBeGreaterThan(rest - 0.03);
    expect(yMax).toBeLessThan(rest + 0.001);
    console.log(`resting 50 s: max |v| ${maxV.toExponential(2)} m/s, max |w| ${maxW.toExponential(2)} rad/s, height range ${(yMax - yMin).toExponential(2)} m, max energy gain per step ${maxEnergyGain.toExponential(2)} J`);
    expect(maxEnergyGain).toBeLessThan(1e-6);
    for (let i = 0; i < m.n; i++) expect(WREN.names[m.partA(i)]).toBe('belly');
  });

  it('a glancing scrape slows the ship by Coulomb friction', () => {
    const hull = one({ name: 'hull', kind: 'capsule', a: [0, 0, -300], b: [0, 0, 300], r: 20 });
    const A = wren(v3(0, 0, 0), v3(0, 0, -5));
    const B = body(0, v3(1, 1, 1), v3(0, -20 - compoundSupport(WREN, 0, -1, 0) + 0.001, 0));
    const m = new Manifold(), res = makeContactResult(), dt = 1 / 120, a = 2;
    let maxRatio = 0, minRatio = Infinity;
    for (let i = 0; i < 120; i++) {
      step(A, dt, v3(0, -a, 0));
      collide(WREN, A, hull, B, m);
      solveManifold(m, A, B, dt, DEFAULT_CONTACT, res);
      const jt = Math.hypot(res.impulse.x, res.impulse.z);
      if (res.normalImpulse > 0) { maxRatio = Math.max(maxRatio, jt / res.normalImpulse); minRatio = Math.min(minRatio, jt / res.normalImpulse); }
    }
    expect(maxRatio).toBeLessThanOrEqual(DEFAULT_CONTACT.friction * 1.0001);
    expect(minRatio).toBeGreaterThan(DEFAULT_CONTACT.friction * 0.8);
    // Pressed with a = 2 m/s² for 1 s: friction takes μ·a·t = 0.8 m/s.
    expect(-A.v.z).toBeGreaterThan(5 - 0.8 - 0.15);
    expect(-A.v.z).toBeLessThan(5 - 0.8 + 0.15);
  });

  it('ship–ship contact is symmetric', () => {
    const make = (): [ContactBody, ContactBody] => [wren(v3(), v3(0.5, 0, 0)), wren(v3(18.95, 0, 0.5), v3(-0.5, 0, 0))];
    const m = new Manifold(), r1 = makeContactResult(), r2 = makeContactResult();
    let [A, B] = make();
    const n1 = collide(WREN, A, WREN, B, m);
    expect(n1).toBeGreaterThan(0);
    const before = momenta([A, B]);
    solveManifold(m, A, B, 1 / 60, DEFAULT_CONTACT, r1);
    const after = momenta([A, B]);
    expect(len(v3(after.P.x - before.P.x, after.P.y - before.P.y, after.P.z - before.P.z))).toBeLessThan(1e-6);
    const vA = { ...A.v }, wA = { ...A.w };
    [A, B] = make();
    const m2 = new Manifold();
    expect(collide(WREN, B, WREN, A, m2)).toBe(n1);
    solveManifold(m2, B, A, 1 / 60, DEFAULT_CONTACT, r2);
    expect(r2.impulse.x).toBeCloseTo(-r1.impulse.x, 6);
    expect(r2.impulse.y).toBeCloseTo(-r1.impulse.y, 6);
    expect(r2.impulse.z).toBeCloseTo(-r1.impulse.z, 6);
    expect(r2.energy).toBeCloseTo(r1.energy, 6);
    expect(A.v.x).toBeCloseTo(vA.x, 9);
    expect(A.w.y).toBeCloseTo(wA.y, 9);
    expect(r1.impulse.x).toBeLessThan(0);
  });

  it('a touchdown on a planet rests on the hull’s lowest points', () => {
    const belly = compoundSupport(WREN, 0, -1, 0);
    const R = 1e6, C = v3(0, -R - belly - 0.4, 0), g = 3;
    const A = wren(v3(), v3(0, -1, 0));
    const P = planetBody({ p: v3(), v: v3(), q: ID(), w: v3(), invMass: 0, invI: v3() }, C, v3(0, 1, 0), 0, 0);
    const m = new Manifold(), res = makeContactResult(), dt = 1 / 60;
    let firstHit = 0;
    for (let i = 0; i < 1200; i++) {
      const dx = A.p.x - C.x, dy = A.p.y - C.y, dz = A.p.z - C.z, r = Math.hypot(dx, dy, dz);
      step(A, dt, v3((-g * dx) / r, (-g * dy) / r, (-g * dz) / r));
      collidePlanet(WREN, A, P, R, m);
      solveManifold(m, A, P, dt, DEFAULT_CONTACT, res);
      if (!firstHit && res.points > 0) firstHit = res.approachSpeed;
    }
    expect(firstHit).toBeGreaterThan(1);
    expect(len(A.v)).toBeLessThan(1e-3);
    expect(len(A.w)).toBeLessThan(1e-4);
    const alt = Math.hypot(A.p.x - C.x, A.p.y - C.y, A.p.z - C.z) - R;
    expect(alt).toBeGreaterThan(belly - 0.03);
    expect(alt).toBeLessThan(belly + 0.001);
    expect(m.n).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < m.n; i++) expect(WREN.names[m.partA(i)]).toBe('belly'); // its four bottom corners
  });
});

describe('cost', () => {
  it('one compound against a station’s colliders costs under 20 µs per step', () => {
    let layout = Object.values(STATION_LAYOUTS)[0];
    for (const l of Object.values(STATION_LAYOUTS)) if (l.colliders.length > layout.colliders.length) layout = l;
    const sc = stationCompound(layout.colliders);
    const col = layout.colliders.find((c) => c.kind === 'capsule' && c.b)!;
    // Rest the Wren belly-down on the middle of that capsule.
    const mid = v3(0.5 * (col.a.x + col.b!.x), 0.5 * (col.a.y + col.b!.y), 0.5 * (col.a.z + col.b!.z));
    const ax = v3(col.b!.x - col.a.x, col.b!.y - col.a.y, col.b!.z - col.a.z), al = len(ax);
    let up = Math.abs(ax.y) / al < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0);
    const k = (up.x * ax.x + up.y * ax.y + up.z * ax.z) / (al * al);
    up = v3(up.x - k * ax.x, up.y - k * ax.y, up.z - k * ax.z);
    const ul = len(up); up = v3(up.x / ul, up.y / ul, up.z / ul);
    const h = col.radius + compoundSupport(WREN, 0, -1, 0);
    const A = wren(v3(mid.x + up.x * h, mid.y + up.y * h, mid.z + up.z * h), v3(), qFromTo(v3(0, 1, 0), up));
    const B = station(v3());
    const m = new Manifold(), res = makeContactResult(), dt = 1 / 60, push = v3(-up.x * 0.3, -up.y * 0.3, -up.z * 0.3);
    for (let i = 0; i < 300; i++) { step(A, dt, push); collide(WREN, A, sc, B, m); solveManifold(m, A, B, dt, DEFAULT_CONTACT, res); }
    expect(res.points).toBeGreaterThan(0);
    const N = 20000;
    let spent = 0, best = Infinity;
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      for (let i = 0; i < N; i++) { collide(WREN, A, sc, B, m); solveManifold(m, A, B, dt, DEFAULT_CONTACT, res); }
      spent = ((performance.now() - t0) * 1000) / N;
      best = Math.min(best, spent);
    }
    console.log(`compound vs ${layout.colliders.length} station colliders: ${best.toFixed(2)} µs per step, ${m.n} points`);
    expect(best).toBeLessThan(20);
  });
});
