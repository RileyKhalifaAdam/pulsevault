// Located damage (src/world/damage.ts, src/data/hullZones.ts).
import { describe, expect, it } from 'vitest';
import type { V3 } from '../src/core/types';
import { HULL_COLLIDERS } from '../src/data/hullColliders';
import {
  C_COLLAR, DAMAGE_COMPONENTS, HULL_ZONES, N_HULL_ZONES, STRUCTURE_CAPACITY, WINDOW_BREAK, Z_BELLY_FWD, Z_DORSAL_AFT, Z_FLANK_PORT, Z_NOSE, Z_POD_STBD, Z_WING_PORT,
} from '../src/data/hullZones';
import { SHIP_LAYOUTS } from '../src/data/shipLayouts';
import { collide, compileCompound, compoundContains, hullCompound, Manifold, solveManifold, sphereCompound, DEFAULT_CONTACT, makeContactResult, type ContactBody } from '../src/world/compound';
import {
  absorb, buildDamageModel, complianceSplit, componentAt, damageAt, damageComponent, damageFromManifold, deriveHealth, impactOverload,
  isDestroyed, K_SHIP, K_STATION, loadDamageState, makeDamageState, overloadStep, saveDamageState, windowState, zoneOfPoint,
} from '../src/world/damage';
import { jetsFromLayout } from '../src/world/jets';

const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const idx = (id: string): number => DAMAGE_COMPONENTS.findIndex((c) => c.id === id);
const JETS = jetsFromLayout(SHIP_LAYOUTS.wren.rcs);
const MODEL = buildDamageModel(JETS);

/** Every exterior surface sample of the Wren's compound (each part's surface on an S grid, outside all other parts). */
function forEachExteriorSample(S: number, cb: (part: string, p: number[], n: number[], dA: number) => void): void {
  const parts = HULL_COLLIDERS.wren, comps = parts.map((p) => compileCompound([p]));
  const qrot = (q: number[], x: number, y: number, z: number): number[] => {
    const [qx, qy, qz, qw] = q, tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
    return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)];
  };
  const sample = (pi: number, p: number[], n: number[], dA: number): void => {
    for (let k = 0; k < comps.length; k++) if (k !== pi && compoundContains(comps[k], p[0] + n[0] * 0.03, p[1] + n[1] * 0.03, p[2] + n[2] * 0.03)) return;
    cb(parts[pi].name, p, n, dA);
  };
  parts.forEach((p, pi) => {
    if (p.kind === 'box') {
      const q = p.q ?? [0, 0, 0, 1];
      for (let ax = 0; ax < 3; ax++) for (const s of [-1, 1]) {
        const a1 = (ax + 1) % 3, a2 = (ax + 2) % 3, n1 = Math.max(1, Math.ceil((2 * p.h[a1]) / S)), n2 = Math.max(1, Math.ceil((2 * p.h[a2]) / S));
        for (let i = 0; i < n1; i++) for (let j = 0; j < n2; j++) {
          const l = [0, 0, 0]; l[ax] = s * p.h[ax]; l[a1] = -p.h[a1] + ((i + 0.5) * 2 * p.h[a1]) / n1; l[a2] = -p.h[a2] + ((j + 0.5) * 2 * p.h[a2]) / n2;
          const w = qrot(q, l[0], l[1], l[2]), nl = [0, 0, 0]; nl[ax] = s;
          sample(pi, [p.c[0] + w[0], p.c[1] + w[1], p.c[2] + w[2]], qrot(q, nl[0], nl[1], nl[2]), (4 * p.h[a1] * p.h[a2]) / (n1 * n2));
        }
      }
    } else if (p.kind === 'capsule') {
      const [ax, ay, az] = p.a, d = [p.b[0] - ax, p.b[1] - ay, p.b[2] - az], L = Math.hypot(d[0], d[1], d[2]), u = d.map((x) => x / L), r = p.r;
      let e = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const dd = e[0] * u[0] + e[1] * u[1] + e[2] * u[2]; e = e.map((x, k) => x - dd * u[k]); const el = Math.hypot(...e); e = e.map((x) => x / el);
      const f = [u[1] * e[2] - u[2] * e[1], u[2] * e[0] - u[0] * e[2], u[0] * e[1] - u[1] * e[0]];
      const na = Math.max(8, Math.ceil((2 * Math.PI * r) / S)), nl = Math.max(1, Math.ceil(L / S)), nlat = Math.max(4, Math.ceil((0.5 * Math.PI * r) / S));
      for (let i = 0; i < na; i++) {
        const t = ((i + 0.5) / na) * 2 * Math.PI, n = [0, 1, 2].map((k) => Math.cos(t) * e[k] + Math.sin(t) * f[k]);
        for (let j = 0; j < nl; j++) { const g = (j + 0.5) / nl; sample(pi, [0, 1, 2].map((k) => p.a[k] + d[k] * g + r * n[k]), n, (2 * Math.PI * r * L) / (na * nl)); }
        for (const [c, sg] of [[p.a, -1], [p.b, 1]] as const) for (let k = 0; k < nlat; k++) {
          const ph = ((k + 0.5) / nlat) * 0.5 * Math.PI, n2 = [0, 1, 2].map((m) => Math.cos(ph) * n[m] + sg * Math.sin(ph) * u[m]);
          sample(pi, [0, 1, 2].map((m) => c[m] + r * n2[m]), n2, (2 * Math.PI * r * r * Math.cos(ph) * (0.5 * Math.PI / nlat)) / na);
        }
      }
    }
  });
}

describe('hull zones', () => {
  it('12 zones; every component in exactly one zone; the areas match the compound’s exterior within 15%', () => {
    expect(HULL_ZONES.length).toBe(N_HULL_ZONES);
    const seen = new Set<number>();
    for (const z of HULL_ZONES) for (const c of z.components) { expect(seen.has(c)).toBe(false); seen.add(c); }
    expect(seen.size).toBe(DAMAGE_COMPONENTS.length);
    // re-measure: sample each part's surface on a 0.3 m grid, keep the samples outside every other part
    const area = new Float64Array(12);
    forEachExteriorSample(0.3, (part, p, n, dA) => { area[zoneOfPoint(part, v3(p[0], p[1], p[2]), v3(n[0], n[1], n[2]))] += dA; });
    HULL_ZONES.forEach((z, i) => expect(Math.abs(area[i] - z.area) / z.area).toBeLessThan(0.15));
  });

  it('points land in the zone they hit', () => {
    expect(zoneOfPoint('nose', v3(0, -0.3, -15.4), v3(0, 0, -1))).toBe(Z_NOSE);
    expect(zoneOfPoint('wing-port', v3(-8, -0.4, 6.7), v3(0, -1, 0))).toBe(Z_WING_PORT);
    expect(zoneOfPoint('hull', v3(-3.6, 0, 0), v3(-1, 0, 0))).toBe(Z_FLANK_PORT);
    expect(zoneOfPoint('hull', v3(0, -1.2, -5), v3(0, -1, 0))).toBe(Z_BELLY_FWD);
    expect(zoneOfPoint('hull', v3(0, 1.2, 8), v3(0, 1, 0))).toBe(Z_DORSAL_AFT);
  });
});

describe('located damage', () => {
  it('a hit strikes the component at the point: window, collar, RCS quad, drive pod, radiator, else the panel', () => {
    const d = makeDamageState();
    expect(componentAt(d, MODEL, 'windscreen', v3(0, 0.5, -15.6), 1)).toBe(idx('w-front'));
    expect(componentAt(d, MODEL, 'roof', v3(0, 1.9, 2.2), 2)).toBe(idx('collar'));
    // the first starboard fore jet (3.9, 0.2, −12)
    expect(componentAt(d, MODEL, 'cheek-stbd', v3(3.9, 0.4, -12.1), 7)).toBe(idx('rcs-fore-stbd'));
    expect(componentAt(d, MODEL, 'pod-stbd', v3(4.8, -1.4, 8), Z_POD_STBD)).toBe(idx('drive-stbd'));
    expect(componentAt(d, MODEL, 'radiator-port', v3(-4.3, 0.9, 8), Z_FLANK_PORT)).toBe(idx('radiator-port'));
    expect(componentAt(d, MODEL, 'belly', v3(0, -1.8, -5), Z_BELLY_FWD)).toBe(Z_BELLY_FWD);
  });

  it('a 50 kJ hit on a quad disables its jets (allocation table rebuild); a pod scales its engine; windows crack then break', () => {
    const d = makeDamageState();
    const jh = JETS.map(() => 1), eh = [1, 1], rh = [1, 1];
    expect(deriveHealth(d, MODEL, jh, eh, rh)).toBe(false);
    damageAt(d, MODEL, 'cheek-stbd', v3(3.9, 0.4, -12.1), v3(1, 0, 0), 50e3);
    expect(deriveHealth(d, MODEL, jh, eh, rh)).toBe(true);
    const dead = jh.map((h, j) => (h === 0 ? j : -1)).filter((j) => j >= 0);
    expect(dead.length).toBeGreaterThan(0);
    for (const j of dead) expect(JETS[j].pos.x).toBeGreaterThanOrEqual(0);
    expect(deriveHealth(d, MODEL, jh, eh, rh)).toBe(false);
    damageAt(d, MODEL, 'pod-stbd', v3(4.8, -1.4, 8), v3(0, -1, 0), 250e3);
    deriveHealth(d, MODEL, jh, eh, rh);
    expect(eh[0]).toBeCloseTo(0.5, 12);
    expect(eh[1]).toBe(1);
    const w = idx('w-front');
    damageAt(d, MODEL, 'windscreen', v3(0, 0.5, -15.6), v3(0, 0, -1), 9e3);
    expect(windowState(d, w)).toBe(0);
    damageAt(d, MODEL, 'windscreen', v3(0, 0.5, -15.6), v3(0, 0, -1), 2e3);
    expect(windowState(d, w)).toBe(1);
    damageAt(d, MODEL, 'windscreen', v3(0, 0.5, -15.6), v3(0, 0, -1), WINDOW_BREAK);
    expect(windowState(d, w)).toBe(2);
    // the overflow beyond the pane's capacity went into the canopy panel
    expect(d.zones[DAMAGE_COMPONENTS[w].zone]).toBeLessThan(1);
    expect(d.hull).toBeLessThan(1);
  });

  it('the compliance split sums to E and a station takes 1%; a real manifold damages the struck zone only', () => {
    const out = new Float64Array(2);
    complianceSplit(1e6, K_SHIP, K_STATION, out);
    expect(out[0] + out[1]).toBe(1e6);
    expect(out[0] / 1e6).toBeCloseTo(0.990099, 5);
    complianceSplit(1e6, K_SHIP, K_SHIP, out);
    expect(out[0]).toBe(5e5);
    // the Wren's nose driven into a fixed sphere
    const wren = hullCompound('wren')!, ball = sphereCompound(5);
    const A: ContactBody = { p: v3(), v: v3(0, 0, -3), q: { x: 0, y: 0, z: 0, w: 1 }, w: v3(), invMass: 1 / 6e4, invI: v3(1 / 6e6, 1 / 6e6, 1 / 6e6) };
    const B: ContactBody = { p: v3(0, -0.9, -16.3 - 5 + 0.02), v: v3(), q: { x: 0, y: 0, z: 0, w: 1 }, w: v3(), invMass: 0, invI: v3() };
    const m = new Manifold(), res = makeContactResult();
    expect(collide(wren, A, ball, B, m)).toBeGreaterThan(0);
    solveManifold(m, A, B, 1 / 120, DEFAULT_CONTACT, res);
    expect(res.energy).toBeGreaterThan(0);
    const d = makeDamageState();
    complianceSplit(res.energy, K_SHIP, K_STATION, out);
    damageFromManifold(d, MODEL, m, A, B, wren.names, out[0], true);
    const hurt = d.zones.map((h, i) => (h < 1 ? i : -1)).filter((i) => i >= 0);
    expect(hurt.length).toBeGreaterThan(0);
    for (const i of hurt) expect(DAMAGE_COMPONENTS[i].zone).toBe(Z_NOSE);
    // energy accounted once: Σ (1 − h)·capacity = the ship's share
    let E = 0;
    d.zones.forEach((h, i) => (E += (1 - h) * DAMAGE_COMPONENTS[i].capacity));
    expect(E / out[0]).toBeCloseTo(1, 9);
    console.log(`nose strike at 3 m/s: dissipated ${res.energy.toFixed(0)} J, ship ${out[0].toFixed(0)} J -> ${hurt.map((i) => DAMAGE_COMPONENTS[i].id).join(', ')}`);
  });

  it('graded overload: nothing at 6 g, D grows (n − 6)/3 per 2 s above it', () => {
    const d = makeDamageState(), c = { dryMass: 6e4, propellant: 0 }, g = 9.80665;
    overloadStep(d, { f: v3(0, 0, 6 * g * 6e4), T: 10 }, c);
    expect(d.overloadD).toBe(0);
    overloadStep(d, { f: v3(0, 0, 8 * g * 6e4), T: 1 }, c);
    expect(d.overloadD).toBeCloseTo(1 / 3, 12);
    overloadStep(d, { f: v3(0, 0, 9 * g * 6e4), T: 2 }, c);
    expect(d.overloadD).toBe(1);
  });

  it('save -> load round-trips exactly, an old save is undamaged', () => {
    const d = makeDamageState();
    damageAt(d, MODEL, 'wing-port', v3(-8, -0.4, 6.7), v3(0, -1, 0), 123456.789);
    d.overloadD = 0.123;
    const b = loadDamageState(JSON.parse(JSON.stringify(saveDamageState(d))));
    expect(b.zones).toEqual(d.zones);
    expect(b.overloadD).toBe(d.overloadD);
    expect(b.hull).toBe(d.hull);
    const o = loadDamageState(undefined);
    expect(o.zones.every((h) => h === 1)).toBe(true);
  });
});

/** Energy booked in a damage state: Σ (1 − h)·capacity over components + (1 − structure)·STRUCTURE_CAPACITY. */
function booked(d: ReturnType<typeof makeDamageState>): number {
  let E = (1 - d.structure) * STRUCTURE_CAPACITY;
  d.zones.forEach((h, i) => (E += (1 - h) * DAMAGE_COMPONENTS[i].capacity));
  return E;
}

describe('review fixes: crashes, localisation, RCS housings, overload mass', () => {
  it('a nose-first crash books every joule (component -> panel -> structure) and destroys the ship at high speed', () => {
    const m = 60e3, c = { dryMass: 43e3, propellant: 15.5e3, rcsPropellant: 1.5e3 }, out = new Float64Array(2);
    const res: string[] = [];
    for (const v of [1, 10, 25, 50, 100, 200]) {
      const d = makeDamageState(), E = 0.5 * m * v * v;
      complianceSplit(E, K_SHIP, K_STATION, out);
      const comp = componentAt(d, MODEL, 'nose', v3(0, 0.2, -15.45), zoneOfPoint('nose', v3(0, 0.2, -15.45), v3(0, 0, -1)));
      const left = absorb(d, MODEL, comp, out[0]);
      expect(Math.abs(booked(d) + left - out[0]) / out[0]).toBeLessThan(1e-12);
      const n = impactOverload(d, m * v, DAMAGE_COMPONENTS[comp].zone, c);
      if (v <= 1) expect(d.overloadD).toBe(0);
      if (v === 25) expect(isDestroyed(d)).toBe(false);
      if (v >= 100) { expect(isDestroyed(d)).toBe(true); expect(d.hull).toBe(0); }
      res.push(`${v} m/s: nose ${d.zones[0].toFixed(2)} structure ${d.structure.toFixed(2)} D ${d.overloadD.toFixed(2)} n ${n.toFixed(0)} g lost ${isDestroyed(d)}`);
    }
    console.log(res.join('\n'));
    // spill: a pane takes 30 kJ, the canopy panel the rest, then the structure; returns what is beyond everything
    const d = makeDamageState(), w = DAMAGE_COMPONENTS.findIndex((x) => x.id === 'w-front');
    const all = WINDOW_BREAK + HULL_ZONES[DAMAGE_COMPONENTS[w].zone].area * 0.1 * 2e6 + STRUCTURE_CAPACITY;
    const left = damageAt(d, MODEL, 'windscreen', v3(0, 0.5, -15.6), v3(0, 0, -1), all + 1e6) === w ? 0 : NaN;
    expect(left).toBe(0);
    expect(d.structure).toBe(0);
    expect(isDestroyed(d)).toBe(true);
    // the collar takes the capture ring's hard-stop energy
    const e = makeDamageState();
    damageComponent(e, MODEL, C_COLLAR, 66e3);
    expect(e.zones[C_COLLAR]).toBeCloseTo(1 - 66e3 / 150e3, 12);
  });

  it('every exterior surface point books its hit in its own zone (no window on the nose, no RCS on the radiators)', () => {
    const d = makeDamageState();
    let n = 0, bad = 0, win = 0, winBad = 0;
    const glazing = new Set(['windscreen', 'canopy', 'cockpit-rail-stbd', 'cockpit-rail-port']);
    forEachExteriorSample(0.15, (part, p, nn) => {
      const pt = v3(p[0], p[1], p[2]), z = zoneOfPoint(part, pt, v3(nn[0], nn[1], nn[2])), c = componentAt(d, MODEL, part, pt, z);
      n++;
      if (DAMAGE_COMPONENTS[c].zone !== z) bad++;
      const k = DAMAGE_COMPONENTS[c];
      if (k.kind === 'window' && k.zone === 1) { win++; if (!glazing.has(part)) winBad++; }
    });
    expect(n).toBeGreaterThan(5000);
    expect(bad).toBe(0);
    expect(win).toBeGreaterThan(0);
    expect(winBad).toBe(0);
    // the reviewer's case: the nose cap at (0, 0.2, −15.45), normal −z, is the nose panel
    expect(damageAt(d, MODEL, 'nose', v3(0, 0.2, -15.45), v3(0, 0, -1), 1)).toBe(Z_NOSE);
    // a radiator hit next to the aft RCS is the radiator; a cheek hit far from a jet is the flank panel
    expect(DAMAGE_COMPONENTS[componentAt(d, MODEL, 'radiator-stbd', v3(4.4, 0.9, 10.8), 7)].kind).toBe('radiator');
    console.log(`localisation: ${n} exterior samples, ${bad} booked outside their zone; ${win} canopy-window hits, all on glazing parts`);
  });

  it('the 10 jets sit in 6 RCS housings, mirrored; overload counts the RCS propellant', () => {
    const per = new Map<number, number[]>();
    MODEL.jetQuad.forEach((q, j) => { expect(q).toBeGreaterThanOrEqual(0); per.set(q, [...(per.get(q) ?? []), j]); });
    const ids = [...per.keys()].map((q) => DAMAGE_COMPONENTS[q].id).sort();
    expect(ids).toEqual(['rcs-aft-port', 'rcs-aft-stbd', 'rcs-fore-dorsal', 'rcs-fore-port', 'rcs-fore-stbd', 'rcs-fore-ventral']);
    const count = (id: string): number => per.get(DAMAGE_COMPONENTS.findIndex((c) => c.id === id))!.length;
    expect(count('rcs-fore-stbd')).toBe(count('rcs-fore-port'));
    expect(count('rcs-aft-stbd')).toBe(count('rcs-aft-port'));
    for (const [q, js] of per) for (const j of js) {
      // a jet's mirror image (x -> −x) is in the mirrored housing
      const mj = JETS.findIndex((o) => o.pos.x === -JETS[j].pos.x && o.pos.y === JETS[j].pos.y && o.pos.z === JETS[j].pos.z);
      const id = DAMAGE_COMPONENTS[q].id, mid = DAMAGE_COMPONENTS[MODEL.jetQuad[mj]].id;
      expect(mid).toBe(id.replace('stbd', 'P').replace('port', 'stbd').replace('P', 'port'));
    }
    const g = 9.80665, c = { dryMass: 43e3, propellant: 22.5e3, rcsPropellant: 1.5e3 }, m = 67e3;
    const d = makeDamageState();
    overloadStep(d, { f: v3(0, 0, 7 * g * m), T: 1 }, c);
    expect(d.overloadD).toBeCloseTo(1 / 6, 12);
  });

  it('save -> load keeps the structure; an old save has it whole', () => {
    const d = makeDamageState();
    absorb(d, MODEL, Z_NOSE, HULL_ZONES[Z_NOSE].area * 0.3 * 5e6 + 1.234e6);
    expect(d.structure).toBeLessThan(1);
    const b = loadDamageState(JSON.parse(JSON.stringify(saveDamageState(d))));
    expect(b.structure).toBe(d.structure);
    expect(b.hull).toBe(d.hull);
    expect(loadDamageState({ zones: d.zones, overloadD: 0 }).structure).toBe(1);
  });
});
