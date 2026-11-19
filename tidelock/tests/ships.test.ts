// Tests for src/sim/ships.ts — the ship & module catalogue and the loadout maths.
//
// Independent references: stats are re-derived here from the raw catalogue rows, the rocket equation
// is checked against a Simpson quadrature of F/m(t) (no logarithm). The Wren's flight itself is proven on
// the physical world (tests/worldCraft.test.ts, tests/session.test.ts).

import { describe, expect, it } from 'vitest';
import type { ModuleSlotType, ShipVisualId, VesselStats } from '../src/core/types';
import { SHIP_LAYOUTS } from '../src/data/shipLayouts';
import {
  BASE_SENSOR_RANGE,
  HULL_HEAT_CAPACITY,
  HULL_RADIATION,
  MODULES,
  MODULE_IDS,
  SHIPS,
  SHIP_IDS,
  accel,
  burnTime,
  canFit,
  compareModules,
  compareStats,
  computeStats,
  defaultLoadout,
  deltaV,
  fittedModules,
  getModule,
  isLoadoutValid,
  jumpCost,
  listModulesForSlot,
  loadoutResale,
  loadoutValue,
  moduleResale,
  propellantFor,
  shipPrice,
  swapCost,
  validateLoadout,
  weaponsOf,
  withModule,
  type Loadout,
  type ModuleDef,
} from '../src/sim/ships';

const ALL_SHIPS: ShipVisualId[] = ['wren', 'drover', 'magpie', 'shrike', 'albatross', 'caravel', 'halberd'];
const ALL_SLOT_TYPES: ModuleSlotType[] = ['engine', 'rcs', 'reactor', 'tank', 'cargo', 'shield', 'armor', 'weapon', 'radiator', 'jump', 'computer', 'scanner', 'utility'];
const mods: ModuleDef[] = MODULE_IDS.map((id) => MODULES[id]);
const stock = (id: ShipVisualId): VesselStats => computeStats(defaultLoadout(id));
const codes = (l: Loadout): string[] => validateLoadout(l).map((p) => p.code);
/** Index of the first slot of `type` on a hull. */
const slotOf = (id: ShipVisualId, type: ModuleSlotType, nth = 0): number => {
  const hits = SHIPS[id].slots.map((s, i) => (s.type === type ? i : -1)).filter((i) => i >= 0);
  return hits[nth];
};

/** Δv of a burn of `duration` s by Simpson quadrature of thrust / mass(t). */
function integrateBurn(stats: VesselStats, fuel: number, cargo: number, duration: number, steps = 20000): number {
  const m0 = stats.dryMass + fuel + cargo;
  const mdot = stats.mainThrust / stats.exhaustVelocity;
  const a = (t: number): number => stats.mainThrust / (m0 - mdot * t);
  const h = duration / steps;
  let dv = 0;
  for (let i = 0; i < steps; i++) dv += (h / 6) * (a(i * h) + 4 * a((i + 0.5) * h) + a((i + 1) * h));
  return dv;
}

// ------------------------------------------------------------------------------------ catalogue

describe('module catalogue', () => {
  it('has a broad, well-formed catalogue covering every slot type', () => {
    expect(mods.length).toBeGreaterThanOrEqual(70);
    expect(new Set(MODULE_IDS).size).toBe(mods.length);
    expect(new Set(mods.map((m) => m.name)).size).toBe(mods.length);
    for (const type of ALL_SLOT_TYPES) expect(mods.filter((m) => m.slotType === type).length, type).toBeGreaterThanOrEqual(4);
    for (const m of mods) {
      expect(MODULES[m.id]).toBe(m);
      expect(getModule(m.id)).toBe(m);
      expect(m.name.startsWith(m.manufacturer), m.id).toBe(true);
      expect(m.name).toMatch(/ Mk (I|II|III|IV)$/);
      expect([1, 2, 3, 4]).toContain(m.size);
      expect([1, 2, 3, 4]).toContain(m.tier);
      expect(m.mass, m.id).toBeGreaterThan(0);
      expect(m.price, m.id).toBeGreaterThan(0);
      expect(m.powerDraw).toBeGreaterThanOrEqual(0);
      expect(m.powerOutput).toBeGreaterThanOrEqual(0);
      expect(m.powerOutput > 0).toBe(m.slotType === 'reactor');
      expect(m.description.length, m.id).toBeGreaterThan(20);
      expect(!!m.weapon).toBe(m.slotType === 'weapon');
      for (const v of Object.values(m.stats)) if (typeof v === 'number') expect(Number.isFinite(v), m.id).toBe(true);
    }
    expect(getModule('nope')).toBeUndefined();
    expect(getModule(null)).toBeUndefined();
    expect(getModule('toString')).toBeUndefined();
  });

  it('main drives trade thrust for exhaust velocity in every size', () => {
    const engines = mods.filter((m) => m.slotType === 'engine');
    for (const size of [1, 2, 3, 4]) {
      const row = engines.filter((m) => m.size === size).sort((a, b) => a.stats.exhaustVelocity! - b.stats.exhaustVelocity!);
      expect(row.length, `size ${size}`).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < row.length; i++) {
        expect(row[i].stats.exhaustVelocity!).toBeGreaterThan(row[i - 1].stats.exhaustVelocity!);
        expect(row[i].stats.thrust!, `${row[i].id} vs ${row[i - 1].id}`).toBeLessThan(row[i - 1].stats.thrust!);
      }
    }
    const ve = (prefix: string): number[] => engines.filter((m) => m.id.startsWith(prefix)).map((m) => m.stats.exhaustVelocity!);
    for (const v of ve('eng_chem')) expect(Math.abs(v - 4500)).toBeLessThan(200);
    for (const v of ve('eng_ntr')) expect(v >= 9000 && v <= 12000).toBe(true);
    for (const p of ['eng_pulse', 'eng_torch', 'eng_cruise']) for (const v of ve(p)) expect(v >= 25000 && v <= 60000, p).toBe(true);
    // Bigger drives of one family push harder.
    for (const p of ['eng_chem', 'eng_ntr', 'eng_pulse', 'eng_torch', 'eng_cruise']) {
      const fam = engines.filter((m) => m.id.startsWith(p)).sort((a, b) => a.size - b.size);
      for (let i = 1; i < fam.length; i++) expect(fam[i].stats.thrust!).toBeGreaterThan(fam[i - 1].stats.thrust!);
    }
  });

  it('has flight computers for tiers 0..3, the three scanner kinds and every utility', () => {
    const tiers = mods.filter((m) => m.slotType === 'computer').map((m) => m.stats.computerTier);
    expect(tiers.sort()).toEqual([0, 1, 2, 3]);
    const has = (f: (m: ModuleDef) => unknown): boolean => mods.some((m) => !!f(m));
    expect(has((m) => m.stats.surveyScanner)).toBe(true);
    expect(has((m) => m.stats.cargoScanner)).toBe(true);
    expect(has((m) => m.stats.combatScanner)).toBe(true);
    expect(has((m) => m.stats.miningLaser)).toBe(true);
    expect(has((m) => m.stats.refinery)).toBe(true);
    expect(has((m) => m.stats.fuelScoop)).toBe(true);
    expect(has((m) => m.slotType === 'utility' && (m.stats.heatShield ?? 0) > 1)).toBe(true);
    expect(has((m) => m.stats.dockingComputer)).toBe(true);
    expect(has((m) => m.stats.limpets)).toBe(true);
  });

  it('weapons are complete and lasers are hitscan', () => {
    const kinds = new Set<string>();
    for (const m of mods) {
      const w = m.weapon;
      if (!w) continue;
      kinds.add(w.kind);
      for (const v of [w.damage, w.shieldMult, w.hullMult, w.range, w.rateOfFire, w.energyPerShot, w.heatPerShot, w.gimbal]) expect(v, m.id).toBeGreaterThan(0);
      const laser = w.kind === 'pulse' || w.kind === 'beam';
      expect(w.projectileSpeed === Infinity, m.id).toBe(laser);
      if (!laser) expect(w.projectileSpeed > 100 && w.projectileSpeed < 1e5).toBe(true);
      expect(w.ammo > 0, m.id).toBe(!laser);
      expect(w.ammoPrice > 0).toBe(!laser);
      expect(w.gimbal).toBeLessThan(Math.PI / 2);
    }
    expect([...kinds].sort()).toEqual(['beam', 'cannon', 'missile', 'pulse', 'rail']);
  });

  it('no module is strictly better than another that fits the same slot', () => {
    for (const a of mods) {
      for (const b of mods) {
        if (a === b || a.slotType !== b.slotType || b.size > a.size) continue;
        const rows = compareModules(a.id, b.id);
        const dominated = rows.every((r) => r.verdict >= 0) && rows.some((r) => r.verdict > 0);
        expect(dominated, `${b.id} is strictly better than ${a.id}`).toBe(false);
      }
    }
  });
});

// ------------------------------------------------------------------------------------ hulls

describe('hulls', () => {
  it('defines the seven hulls of the architecture doc', () => {
    expect(Object.keys(SHIPS).sort()).toEqual([...ALL_SHIPS].sort());
    expect([...SHIP_IDS].sort()).toEqual([...ALL_SHIPS].sort());
    expect(SHIP_IDS[0]).toBe('wren');
    const lengths: Record<ShipVisualId, number> = { wren: 32, drover: 38, magpie: 26, shrike: 15, albatross: 34, caravel: 72, halberd: 44 };
    const roles: Record<ShipVisualId, string> = { wren: 'courier', drover: 'hauler', magpie: 'miner', shrike: 'fighter', albatross: 'explorer', caravel: 'freighter', halberd: 'gunship' };
    for (const id of ALL_SHIPS) {
      const s = SHIPS[id];
      expect(s.id).toBe(id);
      expect(s.length).toBe(lengths[id]);
      expect(Math.abs(s.length - SHIP_LAYOUTS[id].length)).toBeLessThanOrEqual(1);
      expect(s.role).toBe(roles[id]);
      expect(s.defaultLoadout.length).toBe(s.slots.length);
      expect(s.hullMass).toBeGreaterThan(0);
      expect(s.hull).toBeGreaterThan(0);
      expect(s.dragArea).toBeGreaterThan(0);
      expect(s.description.split(/(?<=[.!?])\s+/).length, id).toBe(2);
      for (const slot of s.slots) expect([1, 2, 3, 4]).toContain(slot.size);
      for (const type of ALL_SLOT_TYPES) expect(s.slots.some((sl) => sl.type === type), `${id} ${type}`).toBe(true);
    }
    expect(SHIPS.wren.price).toBeGreaterThan(30000);
    expect(SHIPS.wren.price).toBeLessThan(45000);
    for (const id of ['caravel', 'halberd'] as const) expect(SHIPS[id].price >= 1e6 && SHIPS[id].price <= 3e6).toBe(true);
    for (const id of ALL_SHIPS) if (id !== 'caravel' && id !== 'halberd') expect(SHIPS[id].price).toBeLessThan(1e6);
    expect(SHIPS.wren.pad).toBe('M'); // the 32 m Wren needs a medium pad
    expect(SHIPS.caravel.pad).toBe('L');
  });

  it('weapon slots match the hardpoints of the physical layout', () => {
    for (const id of ALL_SHIPS) {
      const sizes = SHIPS[id].slots.filter((s) => s.type === 'weapon').map((s) => s.size);
      expect(sizes, id).toEqual(SHIP_LAYOUTS[id].hardpoints.map((h) => h.size));
    }
  });
});

// ------------------------------------------------------------------------------------ default loadouts & balance

describe('default loadouts', () => {
  it('validate cleanly, with every stat finite and derived from the catalogue', () => {
    const keys: Record<keyof VesselStats, true> = {
      dryMass: true, fuelCapacity: true, mainThrust: true, exhaustVelocity: true, rcsThrust: true, rcsExhaustVelocity: true,
      maxAngularAccel: true, maxAngularRate: true, hullMax: true, armor: true, shieldMax: true, shieldRegen: true, powerOutput: true,
      powerDraw: true, heatCapacity: true, heatDissipation: true, dragArea: true, heatShield: true, cargoCapacity: true, jumpRange: true,
      jumpFuelPerLy: true, sensorRange: true, computerTier: true, radius: true, hasFuelScoop: true, hasMiningLaser: true, hasRefinery: true,
      hasSurveyScanner: true, hasDockingComputer: true,
    };
    for (const id of ALL_SHIPS) {
      const ship = SHIPS[id];
      const l = defaultLoadout(id);
      expect(l.modules).toEqual(ship.defaultLoadout);
      expect(l.modules).not.toBe(ship.defaultLoadout);
      expect(validateLoadout(l), id).toEqual([]);
      expect(isLoadoutValid(l)).toBe(true);
      const s = computeStats(l);
      expect(Object.keys(s).sort()).toEqual(Object.keys(keys).sort());
      for (const [k, v] of Object.entries(s)) {
        if (typeof v === 'number') expect(Number.isFinite(v) && v >= 0, `${id}.${k}`).toBe(true);
        else expect(typeof v).toBe('boolean');
      }
      // Independent re-derivation from the raw rows.
      const fitted = l.modules.filter((m): m is string => m !== null).map((m) => MODULES[m]);
      const sum = (f: (m: ModuleDef) => number | undefined): number => fitted.reduce((acc, m) => acc + (f(m) ?? 0), 0);
      expect(s.dryMass).toBe(ship.hullMass + sum((m) => m.mass));
      expect(s.fuelCapacity).toBe(sum((m) => m.stats.fuelCapacity));
      expect(s.cargoCapacity).toBe(sum((m) => m.stats.cargoCapacity));
      expect(s.mainThrust).toBe(sum((m) => m.stats.thrust));
      const engine = fitted.find((m) => m.slotType === 'engine')!;
      expect(s.exhaustVelocity).toBeCloseTo(engine.stats.exhaustVelocity!, 6);
      expect(s.rcsThrust).toBe(sum((m) => m.stats.rcsThrust));
      expect(s.maxAngularAccel).toBeCloseTo(sum((m) => m.stats.torque) / ((s.dryMass * ship.length ** 2) / 12), 12);
      expect(s.powerDraw).toBeCloseTo(sum((m) => m.powerDraw), 6);
      expect(s.powerOutput).toBeCloseTo(sum((m) => m.powerOutput), 6);
      expect(s.powerDraw).toBeLessThanOrEqual(s.powerOutput);
      expect(s.hullMax).toBe(ship.hull + sum((m) => m.stats.hull));
      expect(s.shieldMax).toBe(sum((m) => m.stats.shield));
      expect(s.heatCapacity).toBeCloseTo(HULL_HEAT_CAPACITY * s.dryMass + sum((m) => m.stats.heatCapacity), 0);
      expect(s.heatDissipation).toBeCloseTo(HULL_RADIATION * ship.dragArea + sum((m) => m.stats.heatDissipation), 0);
      expect(s.dragArea).toBe(ship.dragArea);
      expect(s.radius).toBe(SHIP_LAYOUTS[id].radius);
      expect(s.sensorRange).toBeGreaterThan(BASE_SENSOR_RANGE);
      // Sanity of the flight-feel numbers.
      expect(s.maxAngularAccel).toBeGreaterThan(0.1);
      expect(s.maxAngularAccel).toBeLessThan(3);
      expect(s.maxAngularRate).toBeGreaterThan(0.15);
      expect(s.maxAngularRate).toBeLessThan(1.2);
      expect(s.rcsThrust / (s.dryMass + s.fuelCapacity)).toBeGreaterThan(0.05); // can translate for docking
      expect(s.shieldMax).toBeGreaterThan(0);
      expect(s.jumpRange).toBeGreaterThan(0);
      // A maximum-range jump leaves most of the tank for flying.
      expect(jumpCost(s, s.jumpRange)).toBeLessThan(0.35 * s.fuelCapacity);
    }
  });

  it('hit the balance targets (full tank, empty hold)', () => {
    const km = 1000;
    const targets: Record<ShipVisualId, { dv: [number, number]; a: [number, number]; loaded?: [number, number] }> = {
      wren: { dv: [13 * km, 16 * km], a: [11, 13] },
      shrike: { dv: [9 * km, 11 * km], a: [25, 32] },
      drover: { dv: [13 * km, 15.5 * km], a: [4, 7], loaded: [7 * km, 9 * km] },
      magpie: { dv: [13 * km, 15.5 * km], a: [3, 5], loaded: [7 * km, 9.5 * km] },
      albatross: { dv: [40 * km, 50 * km], a: [4.3, 5.7] },
      caravel: { dv: [9 * km, 11.5 * km], a: [2, 4] },
      halberd: { dv: [11 * km, 13.5 * km], a: [9, 11] },
    };
    for (const id of ALL_SHIPS) {
      const s = stock(id);
      const t = targets[id];
      const dv = deltaV(s);
      const a = accel(s);
      expect(dv >= t.dv[0] && dv <= t.dv[1], `${id} Δv ${dv.toFixed(0)}`).toBe(true);
      expect(a >= t.a[0] && a <= t.a[1], `${id} accel ${a.toFixed(2)}`).toBe(true);
      const loaded = deltaV(s, s.fuelCapacity, s.cargoCapacity * 1000);
      expect(loaded).toBeLessThan(dv);
      if (t.loaded) expect(loaded >= t.loaded[0] && loaded <= t.loaded[1], `${id} loaded Δv ${loaded.toFixed(0)}`).toBe(true);
    }
    expect(accel(stock('magpie'))).toBeLessThan(accel(stock('drover'))); // "like the Drover but slower"
    expect(stock('caravel').cargoCapacity).toBeGreaterThan(stock('drover').cargoCapacity);
    expect(stock('drover').cargoCapacity).toBeGreaterThan(stock('magpie').cargoCapacity);
    expect(stock('magpie').cargoCapacity).toBeGreaterThan(stock('wren').cargoCapacity);
  });

  it('give the starter what a phone player needs, and each role its tools', () => {
    const wren = stock('wren');
    expect(wren.computerTier).toBe(3);
    expect(wren.hasDockingComputer).toBe(true);
    expect(wren.cargoCapacity).toBeGreaterThanOrEqual(6);
    // Sized like two of the reference ship of sim/physics.ts (5e9 J, 5e6 W): the 32 m Wren has twice the old mass.
    expect(wren.heatCapacity > 9e9 && wren.heatCapacity < 1.1e10).toBe(true);
    expect(wren.heatDissipation > 1.0e7 && wren.heatDissipation < 1.3e7).toBe(true);
    const magpie = stock('magpie');
    expect(magpie.hasMiningLaser && magpie.hasRefinery).toBe(true);
    const alb = stock('albatross');
    expect(alb.hasSurveyScanner && alb.hasFuelScoop).toBe(true);
    expect(weaponsOf(defaultLoadout('halberd')).length).toBe(6);
    expect(stock('halberd').armor).toBeGreaterThan(stock('shrike').armor);
    expect(stock('shrike').maxAngularAccel).toBeGreaterThan(stock('wren').maxAngularAccel);
  });

  it('jump ranges: starter about 8 ly, the Albatross best, about 16 ly at most', () => {
    const wren = stock('wren').jumpRange;
    expect(wren >= 7.5 && wren <= 8.5).toBe(true);
    const alb = stock('albatross').jumpRange;
    for (const id of ALL_SHIPS) if (id !== 'albatross') expect(stock(id).jumpRange, id).toBeLessThan(alb);
    // Best achievable by swapping the jump drive on any stock hull.
    let best = 0;
    for (const id of ALL_SHIPS) {
      const i = slotOf(id, 'jump');
      for (const m of listModulesForSlot(SHIPS[id].slots[i])) best = Math.max(best, computeStats(withModule(defaultLoadout(id), i, m.id)).jumpRange);
    }
    expect(best >= 15.5 && best <= 16.5).toBe(true);
    expect(alb).toBeGreaterThanOrEqual(15.5);
  });
});

// ------------------------------------------------------------------------------------ rocket equation

describe('rocket-equation helpers', () => {
  it('Δv agrees with numeric integration of thrust / mass to burn-out', () => {
    for (const id of ALL_SHIPS) {
      const s = stock(id);
      const mdot = s.mainThrust / s.exhaustVelocity;
      for (const [fuel, cargo] of [[s.fuelCapacity, 0], [s.fuelCapacity, s.cargoCapacity * 1000], [0.3 * s.fuelCapacity, 2000]] as const) {
        const ref = integrateBurn(s, fuel, cargo, fuel / mdot);
        expect(Math.abs(deltaV(s, fuel, cargo) / ref - 1), id).toBeLessThan(1e-9);
        expect(accel(s, fuel, cargo)).toBeCloseTo(s.mainThrust / (s.dryMass + fuel + cargo), 9);
      }
      expect(deltaV(s)).toBe(deltaV(s, s.fuelCapacity, 0));
      expect(accel(s, s.fuelCapacity, 0, 0.5)).toBeCloseTo(0.5 * accel(s), 12);
      expect(deltaV(s, 0)).toBe(0);
      expect(accel(s, 0)).toBe(0);
    }
  });

  it('burn time and propellant for a given Δv agree with the integration', () => {
    const s = stock('wren');
    const mdot = s.mainThrust / s.exhaustVelocity;
    for (const dv of [50, 800, 4000, 12000]) {
      const T = burnTime(s, dv);
      expect(Math.abs(integrateBurn(s, s.fuelCapacity, 0, T) / dv - 1)).toBeLessThan(1e-9);
      expect(propellantFor(s, dv)).toBeCloseTo(mdot * T, 6);
      // Hauling cargo costs more propellant and more time for the same Δv.
      expect(propellantFor(s, dv, s.fuelCapacity, 8000)).toBeGreaterThan(propellantFor(s, dv));
      expect(burnTime(s, dv, s.fuelCapacity, 8000, 0.5)).toBeGreaterThan(2 * T);
    }
    expect(burnTime(s, deltaV(s) * 1.01)).toBe(Infinity);
    expect(burnTime(s, 0)).toBe(0);
  });

  it('jump cost is propellant per light-year inside the range and impossible beyond it', () => {
    const s = stock('wren');
    expect(s.jumpFuelPerLy).toBeCloseTo((13 * s.dryMass) / 1000, 9);
    expect(jumpCost(s, 4)).toBeCloseTo(4 * s.jumpFuelPerLy, 9);
    expect(jumpCost(s, s.jumpRange)).toBeCloseTo(s.jumpRange * s.jumpFuelPerLy, 9);
    expect(jumpCost(s, s.jumpRange + 0.01)).toBe(Infinity);
    expect(jumpCost(s, 0)).toBe(0);
    expect(jumpCost(s, -3)).toBe(0);
    const none = computeStats(withModule(defaultLoadout('wren'), slotOf('wren', 'jump'), null));
    expect(none.jumpRange).toBe(0);
    expect(jumpCost(none, 1)).toBe(Infinity);
    // Jumping spends Δv: the tank is shared.
    expect(deltaV(s, s.fuelCapacity - jumpCost(s, 7))).toBeLessThan(deltaV(s));
  });

  it('a heavier fit jumps shorter on the same drive', () => {
    const i = slotOf('wren', 'jump');
    const lr = withModule(defaultLoadout('wren'), i, 'jmp_lr_1');
    const s = computeStats(lr);
    const rated = MODULES.jmp_lr_1.stats;
    expect(s.dryMass).toBeGreaterThan(rated.jumpRatedMass!);
    expect(s.jumpRange).toBeCloseTo(rated.jumpRange! * Math.sqrt(rated.jumpRatedMass! / s.dryMass), 9);
    expect(s.jumpRange).toBeGreaterThan(computeStats(withModule(defaultLoadout('wren'), i, 'jmp_std_1')).jumpRange);
    const warn = validateLoadout(lr);
    expect(warn.map((p) => p.code)).toEqual(['jump-overmass']);
    expect(warn[0].severity).toBe('warning');
    expect(warn[0].slot).toBe(i);
    expect(isLoadoutValid(lr)).toBe(true);
    // Stripping mass restores range.
    const light = withModule(withModule(lr, slotOf('wren', 'shield'), null), slotOf('wren', 'cargo'), null);
    expect(computeStats(light).jumpRange).toBeGreaterThan(s.jumpRange);
  });
});

// ------------------------------------------------------------------------------------ fit rules

describe('fit rules and validation', () => {
  it('a module fits a slot of its type and of its size or larger', () => {
    expect(canFit({ type: 'engine', size: 2 }, 'eng_torch_1')).toBe(true);
    expect(canFit({ type: 'engine', size: 2 }, 'eng_torch_2')).toBe(true);
    expect(canFit({ type: 'engine', size: 2 }, MODULES.eng_torch_3)).toBe(false);
    expect(canFit({ type: 'tank', size: 4 }, 'eng_torch_1')).toBe(false);
    expect(canFit({ type: 'engine', size: 4 }, 'no_such_module')).toBe(false);
    for (const slot of [{ type: 'weapon', size: 2 }, { type: 'utility', size: 1 }, { type: 'jump', size: 3 }] as const) {
      const list = listModulesForSlot(slot);
      expect(list.length).toBeGreaterThan(0);
      expect(list).toEqual(mods.filter((m) => m.slotType === slot.type && m.size <= slot.size).sort((a, b) => a.size - b.size || a.price - b.price));
      for (const m of listModulesForSlot(slot, 1)) expect(m.tier).toBe(1);
    }
    expect(listModulesForSlot({ type: 'weapon', size: 1 }).some((m) => m.size > 1)).toBe(false);
  });

  it('reports wrong type, wrong size, unknown ids, duplicates and slot-count mismatches', () => {
    const base = defaultLoadout('wren');
    const eng = slotOf('wren', 'engine');
    const wrongType = validateLoadout(withModule(base, slotOf('wren', 'armor'), 'wpn_pulse_1'));
    expect(wrongType.map((p) => p.code)).toEqual(['slot-type']);
    expect(wrongType[0].slot).toBe(slotOf('wren', 'armor'));
    expect(wrongType[0].message).toContain('Lumen Forge Stiletto Mk I');
    expect(wrongType[0].message).toContain('armour');

    const tooBig = withModule(base, eng, 'eng_torch_2');
    expect(codes(tooBig)).toEqual(['slot-size']);
    expect(validateLoadout(tooBig)[0].message).toMatch(/too small.*Tradewind Mk II/);
    expect(isLoadoutValid(tooBig)).toBe(false);
    // A module that does not fit contributes nothing, not even mass: only the other drive pod pushes.
    expect(computeStats(tooBig).mainThrust).toBe(MODULES.eng_torch_1.stats.thrust);
    expect(computeStats(tooBig).dryMass).toBe(stock('wren').dryMass - MODULES.eng_torch_1.mass);
    expect(fittedModules(tooBig)[eng]).toBeNull();
    const noDrive = withModule(tooBig, slotOf('wren', 'engine', 1), 'eng_torch_2');
    expect(codes(noDrive)).toEqual(['slot-size', 'slot-size', 'no-engine']);
    expect(computeStats(noDrive).mainThrust).toBe(0);

    expect(codes(withModule(base, slotOf('wren', 'scanner'), 'warp_coil_9'))).toEqual(['unknown-module']);
    const twoDocks = withModule(base, slotOf('wren', 'utility', 1), 'utl_dock');
    expect(codes(twoDocks)).toEqual(['duplicate']);
    expect(computeStats(twoDocks).dryMass).toBe(stock('wren').dryMass);
    expect(codes({ shipId: 'wren', modules: base.modules.slice(0, 5) })).toContain('slot-count');
    expect(codes({ shipId: 'dinghy' as ShipVisualId, modules: [] })).toEqual(['unknown-ship']);
    for (const p of validateLoadout(tooBig)) expect(p.message.length).toBeGreaterThan(10);
  });

  it('requires a drive, RCS, a reactor and a tank; a jump drive is optional', () => {
    const base = defaultLoadout('drover');
    const strip = (type: ModuleSlotType): Loadout => ({ shipId: 'drover', modules: base.modules.map((m, i) => (SHIPS.drover.slots[i].type === type ? null : m)) });
    expect(codes(strip('engine'))).toEqual(['no-engine']);
    expect(codes(strip('rcs'))).toEqual(['no-rcs']);
    expect(codes(strip('reactor'))).toEqual(['no-reactor']);
    expect(codes(strip('tank'))).toEqual(['no-tank']);
    expect(codes(strip('jump'))).toEqual(['no-jump']);
    expect(isLoadoutValid(strip('jump'))).toBe(true);
    expect(isLoadoutValid(strip('tank'))).toBe(false);
    for (const type of ['shield', 'armor', 'weapon', 'cargo', 'computer', 'scanner', 'utility', 'radiator'] as const) expect(codes(strip(type)), type).toEqual([]);
    const bare = computeStats({ shipId: 'drover', modules: base.modules.map(() => null) });
    expect(bare.dryMass).toBe(SHIPS.drover.hullMass);
    expect(bare.computerTier).toBe(0);
    expect(bare.sensorRange).toBe(BASE_SENSOR_RANGE);
    expect(bare.heatShield).toBe(1);
    expect(bare.maxAngularAccel + bare.maxAngularRate + bare.mainThrust + bare.exhaustVelocity + bare.fuelCapacity + bare.jumpRange).toBe(0);
    expect(deltaV(bare)).toBe(0);
  });

  it('enforces the power budget', () => {
    const base = defaultLoadout('wren');
    // The 32 m Wren runs two reactors; with one pulled the rest of the ship draws more than one supplies.
    const half = withModule(base, slotOf('wren', 'reactor', 1), null);
    const p = validateLoadout(half);
    expect(p.map((x) => x.code)).toEqual(['power']);
    expect(p[0].severity).toBe('error');
    expect(p[0].message).toBe('Power budget exceeded: modules draw 19.0 MW, the reactor supplies 14.0 MW.');
    // Either a bigger reactor or shedding loads fixes it: a real choice.
    expect(codes(withModule(half, slotOf('wren', 'reactor', 1), 'rct_hi_1'))).toEqual([]);
    expect(codes(withModule(withModule(half, slotOf('wren', 'engine', 1), null), slotOf('wren', 'weapon'), null))).toEqual([]); // one drive pod, guns off
    // Two reactors carry twin pulse drives.
    const pulse = withModule(withModule(base, slotOf('wren', 'engine'), 'eng_pulse_1'), slotOf('wren', 'engine', 1), 'eng_pulse_1');
    expect(codes(pulse)).toEqual([]);
    // The Shrike is at the edge: a bigger shield does not fit its budget as sold.
    expect(codes(withModule(defaultLoadout('shrike'), slotOf('shrike', 'shield'), 'shd_std_2'))).toEqual(['power']);
  });

  it('upgrades change the ship the way their stats say', () => {
    const base = defaultLoadout('wren');
    const s0 = computeStats(base);
    // Both drive pods take the same engine.
    const drives = (m: string): Loadout => withModule(withModule(base, slotOf('wren', 'engine'), m), slotOf('wren', 'engine', 1), m);
    const cruise = computeStats(drives('eng_cruise_1'));
    expect(deltaV(cruise)).toBeGreaterThan(deltaV(s0) * 1.3);
    expect(accel(cruise)).toBeLessThan(accel(s0) * 0.6);
    const chem = computeStats(drives('eng_chem_1'));
    expect(accel(chem)).toBeGreaterThan(accel(s0) * 3);
    expect(deltaV(chem)).toBeLessThan(deltaV(s0) * 0.2);
    const bladder = computeStats(withModule(base, slotOf('wren', 'cargo'), 'cargo_fuel_2'));
    expect(bladder.cargoCapacity).toBe(0);
    expect(deltaV(bladder)).toBeGreaterThan(deltaV(s0) + 4000);
    const plated = computeStats(withModule(base, slotOf('wren', 'armor'), 'arm_plate_1'));
    expect(plated.armor).toBe(60);
    expect(plated.hullMax).toBe(s0.hullMax + 150);
    expect(deltaV(plated)).toBeLessThan(deltaV(s0));
    expect(plated.maxAngularAccel).toBeLessThan(s0.maxAngularAccel);
    const shielded = computeStats(withModule(withModule(base, slotOf('wren', 'utility', 1), 'utl_heat_1'), slotOf('wren', 'armor'), 'arm_ceramic_1'));
    expect(shielded.heatShield).toBeCloseTo(2.5 * 1.6, 12);
    const sink = computeStats(withModule(base, slotOf('wren', 'radiator'), 'rad_sink_1'));
    expect(sink.heatCapacity).toBeGreaterThan(s0.heatCapacity + 2e9);
    expect(sink.heatDissipation).toBeLessThan(s0.heatDissipation);
    const manual = computeStats(withModule(base, slotOf('wren', 'computer'), null));
    expect(manual.computerTier).toBe(0);
    expect(manual.maxAngularRate).toBeLessThan(s0.maxAngularRate);
    expect(withModule(base, 0, null)).not.toBe(base);
    expect(base.modules).toEqual(SHIPS.wren.defaultLoadout); // withModule never mutates
  });

  it('lists fitted weapons by hardpoint', () => {
    const shrike = weaponsOf(defaultLoadout('shrike'));
    expect(shrike.map((w) => w.hardpoint)).toEqual([0, 1, 2, 3]);
    expect(shrike.map((w) => w.module.id)).toEqual(['wpn_pulse_2', 'wpn_pulse_2', 'wpn_cannon_1', 'wpn_cannon_1']);
    for (const w of shrike) {
      expect(SHIPS.shrike.slots[w.slot].type).toBe('weapon');
      expect(w.weapon).toBe(w.module.weapon);
      expect(w.module.size).toBeLessThanOrEqual(SHIP_LAYOUTS.shrike.hardpoints[w.hardpoint].size);
    }
    const first = slotOf('wren', 'weapon');
    const second = slotOf('wren', 'weapon', 1);
    const onlySecond = withModule(withModule(defaultLoadout('wren'), first, null), second, 'wpn_cannon_1');
    expect(weaponsOf(onlySecond).map((w) => [w.slot, w.hardpoint, w.weapon.kind])).toEqual([[second, 1, 'cannon']]);
    expect(weaponsOf(withModule(defaultLoadout('wren'), first, null))).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------ money

describe('prices and resale', () => {
  it('values a loadout as hull plus modules', () => {
    for (const id of ALL_SHIPS) {
      const l = defaultLoadout(id);
      const modsPrice = l.modules.reduce((acc, m) => acc + (m ? MODULES[m].price : 0), 0);
      expect(loadoutValue(l)).toBe(SHIPS[id].price + modsPrice);
      expect(shipPrice(id)).toBe(loadoutValue(l));
    }
    expect(shipPrice('wren')).toBeLessThan(shipPrice('shrike'));
    expect(shipPrice('caravel') > 1e6 && shipPrice('halberd') < 4e6).toBe(true);
  });

  it('never lets buying and selling turn a profit', () => {
    for (const m of mods) {
      expect(moduleResale(m.id), m.id).toBeLessThan(m.price);
      expect(moduleResale(m.id)).toBeGreaterThan(0);
    }
    expect(moduleResale(null)).toBe(0);
    expect(moduleResale('nope')).toBe(0);
    for (const id of ALL_SHIPS) {
      const l = defaultLoadout(id);
      // Buy new, sell whole.
      expect(loadoutResale(l)).toBeLessThan(shipPrice(id));
      // Buy new, strip every module, sell the pieces and the bare hull.
      const strippedCash = l.modules.reduce((acc, m) => acc + moduleResale(m), 0);
      const bare: Loadout = { shipId: id, modules: l.modules.map(() => null) };
      expect(strippedCash + loadoutResale(bare)).toBeLessThan(shipPrice(id));
      // Swap any slot to any alternative and back: always a net loss.
      SHIPS[id].slots.forEach((slot, i) => {
        for (const alt of listModulesForSlot(slot)) {
          if (alt.id === l.modules[i]) continue;
          const there = swapCost(l, i, alt.id);
          const back = swapCost(withModule(l, i, alt.id), i, l.modules[i]);
          expect(there + back, `${id} slot ${i} ${alt.id}`).toBeGreaterThan(0);
        }
        // Selling a module and buying the same one back costs money too.
        if (l.modules[i]) expect(swapCost(l, i, null) + swapCost(withModule(l, i, null), i, l.modules[i])).toBeGreaterThan(0);
      });
    }
    const wren = defaultLoadout('wren');
    expect(swapCost(wren, slotOf('wren', 'armor'), 'arm_plate_1')).toBe(MODULES.arm_plate_1.price);
    expect(swapCost(wren, slotOf('wren', 'engine'), null)).toBe(-moduleResale('eng_torch_1'));
  });
});

// ------------------------------------------------------------------------------------ comparisons

describe('stat comparisons for outfitting', () => {
  it('compares two modules stat by stat', () => {
    const rows = compareModules('eng_torch_1', 'eng_pulse_1');
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.thrust.delta).toBe(4.0e5);
    expect(by.thrust.verdict).toBe(1);
    expect(by.exhaustVelocity.delta).toBe(-9000);
    expect(by.exhaustVelocity.verdict).toBe(-1);
    expect(by.mass.verdict).toBe(-1); // heavier
    expect(by.price.verdict).toBe(-1);
    expect(by.powerDraw.delta).toBe(3);
    expect(by.powerDraw.verdict).toBe(-1);
    expect(by.thrust.unit).toBe('N');
    expect(by.thrust.label).toBe('Thrust');
    expect(by.shield).toBeUndefined();
    // Fitting into an empty slot / removing.
    const add = compareModules(null, 'shd_std_1');
    expect(add.find((r) => r.key === 'shield')).toMatchObject({ from: 0, to: 200, delta: 200, verdict: 1 });
    const remove = compareModules('shd_std_1', null);
    expect(remove.find((r) => r.key === 'shield')!.verdict).toBe(-1);
    expect(remove.find((r) => r.key === 'mass')!.verdict).toBe(1);
    expect(compareModules('shd_std_1', 'shd_std_1').every((r) => r.delta === 0 && r.verdict === 0)).toBe(true);
    expect(compareModules(null, null)).toEqual([]);
    // Weapons, including hitscan lasers (no NaN from Infinity - Infinity).
    const w = Object.fromEntries(compareModules('wpn_pulse_1', 'wpn_beam_1').map((r) => [r.key, r]));
    expect(w.projectileSpeed.delta).toBe(0);
    expect(w.dps.delta).toBeCloseTo(5.5 * 10 - 14 * 3, 9);
    expect(w.range.verdict).toBe(-1);
    for (const r of compareModules('wpn_pulse_1', 'wpn_cannon_1')) expect(Number.isNaN(r.delta)).toBe(false);
    const flags = Object.fromEntries(compareModules('scn_nav_1', 'scn_survey_1').map((r) => [r.key, r]));
    expect(flags.surveyScanner).toMatchObject({ from: 0, to: 1, verdict: 1 });
  });

  it('compares whole-ship stats before and after a fit', () => {
    const base = defaultLoadout('wren');
    const a = computeStats(base);
    expect(compareStats(a, a)).toEqual([]);
    const rows = compareStats(a, computeStats(withModule(base, slotOf('wren', 'engine'), 'eng_cruise_1')));
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.deltaV.verdict).toBe(1);
    expect(by.accel.verdict).toBe(-1);
    expect(by.mainThrust.verdict).toBe(-1);
    expect(by.exhaustVelocity.verdict).toBe(1);
    expect(by.dryMass.verdict).toBe(-1);
    expect(by.powerDraw.delta).toBeCloseTo(1, 9);
    expect(by.shieldMax).toBeUndefined();
    const dock = compareStats(a, computeStats(withModule(base, slotOf('wren', 'utility'), null)));
    expect(dock.find((r) => r.key === 'hasDockingComputer')).toMatchObject({ from: 1, to: 0, verdict: -1 });
  });
});
