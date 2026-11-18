// Station layouts (data/stationLayouts.ts) and their agreement with the geometry render/space/stations.ts builds:
// ports outside the colliders with a clear straight approach, pad sizes that cover every hull allowed to dock,
// everything inside the bounding radius, and the visual model staying out of the corridors and inside budget.
import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import type { DockingPortDef, PadSize, ShipVisualId, StationCollider, StationLayout, StationVisualId, V3 } from '../src/core/types';
import { SHIP_LAYOUTS } from '../src/data/shipLayouts';
import { APPROACH_LENGTH, BERTHS, PAD_CLEARANCE, PAD_ORDER, STATION_LAYOUTS, padFits } from '../src/data/stationLayouts';
import { newColliderContact, sphereColliderContact } from '../src/sim/physics';
import { SHIPS } from '../src/sim/ships';
import { generateGalaxy } from '../src/sim/universe';
import { CH_HULL } from '../src/render/space/geo';
import { buildStationModel, type StationModel } from '../src/render/space/stations';

const IDS: StationVisualId[] = ['ringHabitat', 'spindle', 'refinery', 'outpost', 'drydock', 'citadel'];
const SHIP_IDS = Object.keys(SHIPS) as ShipVisualId[];
const PORT_COUNT: Record<StationVisualId, number> = { ringHabitat: 8, spindle: 6, refinery: 4, outpost: 2, drydock: 5, citadel: 4 };

const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const along = (p: DockingPortDef, s: number): V3 => ({ x: p.pos.x + p.dir.x * s, y: p.pos.y + p.dir.y * s, z: p.pos.z + p.dir.z * s });

const contact = newColliderContact();
/** Clearance (m, negative = overlap) between a sphere and the nearest collider. */
function clearance(colliders: readonly StationCollider[], c: V3, r: number): number {
  let best = Infinity;
  for (const col of colliders) {
    sphereColliderContact(c, r, col, contact);
    best = Math.min(best, -contact.depth);
  }
  return best;
}

/** Where a docked hull's centre sits along the port axis, and how far off the axis its collar puts it. */
function dockedOffset(id: ShipVisualId): { out: number; lateral: number } {
  const dp = SHIP_LAYOUTS[id].dockingPort;
  const out = dot(dp.pos, dp.dir);
  const lateral = len({ x: dp.pos.x - dp.dir.x * out, y: dp.pos.y - dp.dir.y * out, z: dp.pos.z - dp.dir.z * out });
  return { out, lateral };
}

describe('station layouts', () => {
  it('defines the six archetypes with the documented port counts', () => {
    expect(Object.keys(STATION_LAYOUTS).sort()).toEqual([...IDS].sort());
    for (const id of IDS) {
      const L = STATION_LAYOUTS[id];
      expect(L.visualId).toBe(id);
      expect(L.ports.length, id).toBe(PORT_COUNT[id]);
      expect(new Set(L.ports.map((p) => p.id)).size, `${id}: unique port ids`).toBe(L.ports.length);
      expect(L.colliders.length, id).toBeGreaterThan(0);
      expect(L.controlZone, id).toBeGreaterThan(L.radius * 4);
      for (const c of L.colliders) {
        expect(c.radius).toBeGreaterThan(0);
        expect(c.kind === 'capsule' ? c.b !== undefined : c.b === undefined, `${id}: capsule has b, sphere has not`).toBe(true);
      }
    }
    expect(STATION_LAYOUTS.ringHabitat.ports.some((p) => p.size === 'L')).toBe(true);
    expect(STATION_LAYOUTS.outpost.ports.map((p) => p.size).sort()).toEqual(['M', 'S']);
  });

  it('gives every port a unit axis and a perpendicular unit up', () => {
    for (const id of IDS) {
      for (const p of STATION_LAYOUTS[id].ports) {
        expect(len(p.dir), `${id}/${p.id} dir`).toBeCloseTo(1, 6);
        expect(len(p.up), `${id}/${p.id} up`).toBeCloseTo(1, 6);
        expect(Math.abs(dot(p.dir, p.up)), `${id}/${p.id} up perpendicular`).toBeLessThan(1e-6);
        expect(PAD_ORDER).toContain(p.size);
      }
    }
  });

  it('keeps ports outside all colliders with a clear straight approach of more than 300 m', () => {
    expect(APPROACH_LENGTH).toBeGreaterThanOrEqual(300);
    for (const id of IDS) {
      const L = STATION_LAYOUTS[id];
      for (const p of L.ports) {
        const R = PAD_CLEARANCE[p.size];
        // the mating point itself, with the berth's standoff as margin
        expect(clearance(L.colliders, p.pos, 0), `${id}/${p.id} mating point`).toBeGreaterThan(2);
        // the corridor: a sphere of the pad's clearance radius from the mating plane outward
        for (let s = R; s <= APPROACH_LENGTH + R; s += 2) {
          const c = clearance(L.colliders, along(p, s), R);
          if (c < 0.5) throw new Error(`${id}/${p.id}: corridor blocked ${s} m out (clearance ${c.toFixed(1)} m)`);
        }
      }
    }
  });

  it('lets every hull that fits a pad dock and leave without touching a collider', () => {
    for (const id of IDS) {
      const L = STATION_LAYOUTS[id];
      for (const p of L.ports) {
        for (const ship of SHIP_IDS) {
          if (!padFits(SHIPS[ship].pad, p.size)) continue;
          const { out, lateral } = dockedOffset(ship);
          const r = SHIP_LAYOUTS[ship].radius + lateral;
          expect(r, `${ship} fits the ${SHIPS[ship].pad} corridor`).toBeLessThanOrEqual(PAD_CLEARANCE[SHIPS[ship].pad] + 1.5);
          for (let s = out; s <= APPROACH_LENGTH; s += 1.5) {
            const c = clearance(L.colliders, along(p, s), r);
            if (c < 0.2) throw new Error(`${id}/${p.id}: ${ship} touches a collider ${s.toFixed(1)} m out (clearance ${c.toFixed(1)} m)`);
          }
        }
      }
    }
  });

  it('keeps berths apart and approach corridors from running into each other near the station', () => {
    for (const id of IDS) {
      const L = STATION_LAYOUTS[id];
      for (let i = 0; i < L.ports.length; i++) {
        for (let j = i + 1; j < L.ports.length; j++) {
          const a = L.ports[i];
          const b = L.ports[j];
          const need = BERTHS[a.size].frame + BERTHS[b.size].frame;
          const d = len({ x: a.pos.x - b.pos.x, y: a.pos.y - b.pos.y, z: a.pos.z - b.pos.z });
          expect(d, `${id}: ${a.id} vs ${b.id}`).toBeGreaterThan(Math.min(need, PAD_CLEARANCE[a.size] + PAD_CLEARANCE[b.size] + 4));
          // sampled corridor separation over the first 150 m
          for (let s = 0; s <= 150; s += 10) {
            for (let t = 0; t <= 150; t += 10) {
              const pa = along(a, s);
              const pb = along(b, t);
              const sep = len({ x: pa.x - pb.x, y: pa.y - pb.y, z: pa.z - pb.z });
              if (sep < PAD_CLEARANCE[a.size] + PAD_CLEARANCE[b.size]) throw new Error(`${id}: corridors of ${a.id} and ${b.id} overlap (${sep.toFixed(0)} m apart)`);
            }
          }
        }
      }
    }
  });

  it('covers every ship that can dock at a station of each archetype', () => {
    // each archetype on its own: the smaller hulls always find a pad
    for (const id of IDS) {
      const sizes = STATION_LAYOUTS[id].ports.map((p) => p.size);
      const largest = PAD_ORDER.reduce((m, s) => (sizes.includes(s) ? s : m), 'S' as PadSize);
      for (const ship of SHIP_IDS) {
        if (padFits(SHIPS[ship].pad, largest)) expect(sizes.some((s) => padFits(SHIPS[ship].pad, s)), `${id}: ${ship}`).toBe(true);
      }
    }
    // and against the generated universe: a station's advertised maxPad is really there
    const galaxy = generateGalaxy(1);
    let stations = 0;
    for (const sys of galaxy.systems) {
      for (const st of sys.stations) {
        stations++;
        const L = STATION_LAYOUTS[st.visualId];
        expect(L.ports.some((p) => padFits(st.maxPad, p.size)), `${st.name} (${st.visualId}) offers a ${st.maxPad} pad`).toBe(true);
        for (const ship of SHIP_IDS) {
          if (!padFits(SHIPS[ship].pad, st.maxPad)) continue;
          expect(L.ports.some((p) => padFits(SHIPS[ship].pad, p.size)), `${ship} at ${st.name}`).toBe(true);
        }
      }
    }
    expect(stations).toBeGreaterThan(10);
  });

  it('keeps everything inside the bounding radius', () => {
    for (const id of IDS) {
      const L = STATION_LAYOUTS[id];
      for (const c of L.colliders) {
        expect(len(c.a) + c.radius, `${id} collider`).toBeLessThanOrEqual(L.radius);
        if (c.b) expect(len(c.b) + c.radius, `${id} collider`).toBeLessThanOrEqual(L.radius);
      }
      for (const p of L.ports) {
        const B = BERTHS[p.size];
        // tip of the guide booms and the corner of the approach frame
        const tip = along(p, B.frameOut + B.boom);
        expect(Math.hypot(len(tip), B.frame), `${id}/${p.id} guide boom`).toBeLessThanOrEqual(L.radius);
        expect(Math.hypot(len(along(p, B.frameOut)), B.frame * Math.SQRT2 + 16), `${id}/${p.id} frame`).toBeLessThanOrEqual(L.radius);
      }
    }
  });
});

// ------------------------------------------------------------------------------------------------ visual model

function eachHullVertex(m: StationModel, fn: (x: number, y: number, z: number, part: string) => void): void {
  for (const part of m.parts) {
    const g = part.model.geometries[CH_HULL] as THREE.BufferGeometry | null;
    if (g) {
      const P = g.getAttribute('position').array as Float32Array;
      for (let i = 0; i < P.length; i += 3) fn(P[i], P[i + 1], P[i + 2], part.name);
    }
    for (const inst of [part.crates, part.struts]) {
      if (!inst) continue;
      for (let i = 0; i < inst.count; i++) fn(inst.matrix[i * 16 + 12], inst.matrix[i * 16 + 13], inst.matrix[i * 16 + 14], part.name);
    }
  }
}

function checkCorridors(id: StationVisualId, L: StationLayout, m: StationModel): void {
  let worst = '';
  let maxR = 0;
  eachHullVertex(m, (x, y, z, part) => {
    maxR = Math.max(maxR, Math.hypot(x, y, z));
    if (worst) return;
    for (const p of L.ports) {
      const dx = x - p.pos.x;
      const dy = y - p.pos.y;
      const dz = z - p.pos.z;
      const s = dx * p.dir.x + dy * p.dir.y + dz * p.dir.z;
      if (s < 1 || s > APPROACH_LENGTH) continue;
      const lat = Math.hypot(dx - p.dir.x * s, dy - p.dir.y * s, dz - p.dir.z * s);
      if (lat < PAD_CLEARANCE[p.size]) worst = `${id}/${part}: geometry at (${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)}) is inside the corridor of ${p.id} (${s.toFixed(0)} m out, ${lat.toFixed(1)} m off axis)`;
    }
  });
  if (worst) throw new Error(worst);
  expect(maxR, `${id}: geometry inside the bounding radius`).toBeLessThanOrEqual(L.radius);
  expect(maxR, `${id}: bounding radius is not wildly loose`).toBeGreaterThan(L.radius * 0.8);
}

describe('station models', () => {
  const report: string[] = [];
  for (const id of IDS) {
    it(`${id}: hero and far LOD stay in budget and out of the approach corridors`, () => {
      const L = STATION_LAYOUTS[id];
      const hero = buildStationModel(id, { seed: 3, lod: 0, bake: false, name: 'TEST STATION' });
      const far = buildStationModel(id, { seed: 3, lod: 1, bake: false });
      report.push(`${id}: hero ${hero.triangles} tris / ${hero.drawCalls} calls (${hero.buildMs.toFixed(0)} ms unbaked), far ${far.triangles} tris / ${far.drawCalls} calls`);
      expect(hero.triangles, 'hero triangles').toBeLessThanOrEqual(250000);
      expect(hero.triangles, 'hero has megastructure detail').toBeGreaterThan(40000);
      expect(hero.drawCalls, 'hero draw calls').toBeLessThanOrEqual(30);
      expect(far.triangles, 'far triangles').toBeLessThanOrEqual(30000);
      expect(far.drawCalls, 'far draw calls').toBeLessThanOrEqual(hero.drawCalls);
      checkCorridors(id, L, hero);
      checkCorridors(id, L, far);
      // most of the structure lies in or near a collider (berths and thin booms excepted)
      let near = 0;
      let total = 0;
      const c: V3 = { x: 0, y: 0, z: 0 };
      eachHullVertex(hero, (x, y, z) => {
        total++;
        c.x = x;
        c.y = y;
        c.z = z;
        if (clearance(L.colliders, c, 0) < 12) near++;
      });
      expect(near / total, `${id}: share of geometry within 12 m of a collider`).toBeGreaterThan(0.7);
    });
  }

  it('is deterministic per seed and varies with it', () => {
    const sig = (m: StationModel): number => {
      let h = 0;
      eachHullVertex(m, (x, y, z) => {
        h = (h * 31 + Math.round(x * 10) * 7 + Math.round(y * 10) * 13 + Math.round(z * 10) * 17) | 0;
      });
      return h;
    };
    const a = buildStationModel('outpost', { seed: 11, bake: false });
    const b = buildStationModel('outpost', { seed: 11, bake: false });
    const c = buildStationModel('outpost', { seed: 12, bake: false });
    expect(sig(a)).toBe(sig(b));
    expect(sig(a)).not.toBe(sig(c));
    expect(a.triangles).toBe(b.triangles);
  });

  it('bakes floodlight exposure into the hull', () => {
    const m = buildStationModel('outpost', { seed: 2, bake: true });
    let litVerts = 0;
    for (const part of m.parts) {
      const g = part.model.geometries[CH_HULL] as THREE.BufferGeometry | null;
      if (!g) continue;
      const F = g.getAttribute('aFx').array as Uint8Array;
      for (let i = 1; i < F.length; i += 4) if (F[i] > 40) litVerts++;
    }
    expect(litVerts).toBeGreaterThan(200);
    // eslint-disable-next-line no-console
    console.log(report.join('\n'));
  });
});
