// The first playable loop, headless: trade -> undock -> fly to Gloaming Lock -> dock -> sell -> fly back.
import { describe, expect, test } from 'vitest';
import { makeRng } from '../src/core/rng';
import { quoteBuy, quoteSell } from '../src/sim/economy';
import { createGame, loadGame, type Game, type GameEvents } from '../src/sim/game';
import { hohmannPlan, verifyPlan } from '../src/sim/game/assist';
import { deltaVRemaining } from '../src/sim/physics';
import { shipFromVessel } from '../src/sim/planner';

const WHEEL = 'tallow.st.chandlers-wheel';
const LOCK = 'tallow.st.gloaming-lock';
const DT = 1 / 30;

function finiteState(g: Game): boolean {
  const v = g.state.vessel;
  return [v.r.x, v.r.y, v.r.z, v.v.x, v.v.y, v.v.z, v.q.x, v.q.y, v.q.z, v.q.w, v.fuel, v.hull, g.state.time, g.state.player.credits].every(Number.isFinite);
}

/** Best cargo to carry from the docked station to `to`: highest profit for `units` tonnes that the pilot can afford. */
function bestCargo(g: Game, to: string, units: number): { id: string; profit: number } | null {
  const here = g.dockedStation()!.id;
  let best: { id: string; profit: number } | null = null;
  for (const row of g.market()) {
    const b = quoteBuy(g.state.economy, g.galaxy, here, row.commodityId, units);
    if (b.units < units || b.total > g.state.player.credits) continue;
    const s = quoteSell(g.state.economy, g.galaxy, to, row.commodityId, units);
    if (s.units < units) continue;
    if (!best || s.total - b.total > best.profit) best = { id: row.commodityId, profit: s.total - b.total };
  }
  return best;
}

/** Undock, hand the trip to the flight computer, step until docked at `to`. */
function flyTo(g: Game, to: string, label: string): { frames: number; simTime: number; dvUsed: number; fuelUsed: number; statuses: string[] } {
  const t0 = g.time();
  const fuel0 = g.state.vessel.fuel;
  const dv0 = deltaVRemaining(g.state.vessel);
  const statuses: string[] = [];
  let lastPhase = '';
  expect(g.undock()).toEqual({ ok: true });
  expect(g.setTarget({ kind: 'station', id: to })).toEqual({ ok: true });
  expect(g.engageAutopilot({ kind: 'goToStation', stationId: to })).toEqual({ ok: true });
  let frames = 0;
  while (frames < 20000 && g.state.vessel.dockedAt !== to) {
    g.step(DT);
    frames++;
    const ap = g.autopilot();
    if (ap.engaged && ap.phase !== lastPhase) {
      lastPhase = ap.phase;
      statuses.push(`[frame ${frames}, t+${(g.time() - t0).toFixed(0)} s, warp ${g.warp().level}x (${g.warp().limitReason})] ${ap.phase}: ${ap.status}`);
      expect(ap.status.length).toBeGreaterThan(0);
    }
    if (ap.failed) break;
  }
  const out = { frames, simTime: g.time() - t0, dvUsed: dv0 - deltaVRemaining(g.state.vessel), fuelUsed: fuel0 - g.state.vessel.fuel, statuses };
  console.log(
    `${label}: ${g.state.vessel.dockedAt === to ? 'DOCKED' : `NOT DOCKED (${g.autopilot().failed})`} · frames ${frames} (${(frames * DT).toFixed(0)} s real at 30 fps) · sim ${(out.simTime / 3600).toFixed(2)} h · ` +
      `delta-v ${out.dvUsed.toFixed(0)} m/s · propellant ${out.fuelUsed.toFixed(0)} kg of ${g.state.vessel.stats.fuelCapacity}\n  ${statuses.join('\n  ')}`,
  );
  return out;
}

describe('game core', () => {
  test('new game: docked at Chandler\'s Wheel, stock Wren, full tanks, 5,000 cr, empty hold', () => {
    const g = createGame({ seed: 1 });
    const p = g.player();
    expect(g.dockedStation()?.id).toBe(WHEEL);
    expect(p.credits).toBe(5000);
    expect(p.shipId).toBe('wren');
    expect(p.cargoUsed).toBe(0);
    expect(g.flightInfo().situation).toBe('docked');
    expect(g.flightInfo().propellantFraction).toBe(1);
    expect(g.market().length).toBeGreaterThan(5);
    expect(g.shipPose().docked).toBe(true);
    expect(g.contacts().length).toBeGreaterThan(4);
    expect(g.trajectory().patches.length).toBeGreaterThan(0);
    // Not docked actions fail with a readable reason while docked, and never throw.
    const r = g.plan('toTarget');
    expect(r.ok).toBe(false);
    expect(loadGame('garbage')).toBeNull();
    expect(loadGame('{"format":"tidelock-save","version":1,"state":{}}')).toBeNull();
    // Docked: time passes, economy ticks, the ship rides its port.
    let days = 0;
    g.events.on('dayTicked', () => days++);
    g.setWarp(100000);
    for (let i = 0; i < 60; i++) g.step(0.1);
    expect(days).toBeGreaterThan(0);
    expect(g.dockingState().distance).toBeLessThan(600);
    expect(finiteState(g)).toBe(true);
  });

  test('the playable loop: buy, fly to Gloaming Lock, sell, fly back', () => {
    const g = createGame({ seed: 1 });
    const events: string[] = [];
    for (const name of ['docked', 'undocked', 'dockingGranted', 'burnStarted', 'burnEnded', 'traded', 'fault'] as (keyof GameEvents)[]) g.events.on(name, () => events.push(name));
    const cap = g.player().cargoCapacity;
    const pick = bestCargo(g, LOCK, cap);
    expect(pick).not.toBeNull();
    const q = g.quoteBuy(pick!.id, cap);
    expect(q.units).toBe(cap);
    const big = quoteBuy(g.state.economy, g.galaxy, WHEEL, pick!.id, 400);
    expect(big.total / big.units).toBeGreaterThan(quoteBuy(g.state.economy, g.galaxy, WHEEL, pick!.id, 1).total); // quotes move with quantity
    const credits0 = g.player().credits;
    expect(g.buy(pick!.id, cap)).toEqual({ ok: true });
    expect(g.player().cargoUsed).toBe(cap);
    expect(g.state.vessel.cargoMass).toBe(cap * 1000);
    expect(g.player().credits).toBe(credits0 - q.total);
    expect(g.buy(pick!.id, 1).ok).toBe(false); // hold full

    const out = flyTo(g, LOCK, 'Chandler\'s Wheel -> Gloaming Lock');
    expect(g.state.vessel.dockedAt).toBe(LOCK);
    expect(g.autopilot().engaged).toBe(false);
    expect(g.autopilot().failed).toBeNull();
    expect(g.state.nodes.length).toBe(0);
    expect(g.state.vessel.controls.throttle).toBe(0);
    expect(out.dvUsed).toBeGreaterThan(1500);
    expect(out.dvUsed).toBeLessThan(2400);
    expect(out.fuelUsed / g.state.vessel.stats.fuelCapacity).toBeLessThan(0.3);
    expect(events).toContain('undocked');
    expect(events).toContain('burnStarted');
    expect(events).toContain('dockingGranted');
    expect(events).toContain('docked');
    expect(events).not.toContain('fault');
    expect(g.diagnostics().faults + g.diagnostics().rollbacks).toBe(0);

    const before = g.player().credits;
    expect(g.sell(pick!.id, cap)).toEqual({ ok: true });
    const profit = g.player().credits - credits0;
    const fuel = g.refuelQuote();
    console.log(`sold ${cap} t of ${pick!.id} for ${g.player().credits - before} cr: trade profit ${profit} cr; refuel would cost ${fuel.cost} cr (${fuel.kg.toFixed(0)} kg at ${fuel.pricePerKg} cr/kg)`);
    expect(profit).toBeGreaterThan(0);
    expect(g.player().cargoUsed).toBe(0);
    expect(g.refuel().ok).toBe(true);
    expect(g.flightInfo().propellantFraction).toBeCloseTo(1, 6);

    // Save / load in the middle of the game gives the same state.
    const json = g.save();
    const g2 = loadGame(json);
    expect(g2).not.toBeNull();
    expect(JSON.parse(g2!.save())).toEqual(JSON.parse(json));
    expect(g2!.dockedStation()?.id).toBe(LOCK);

    // The return trip (on the loaded game), with whatever pays best or an empty hold.
    const back = bestCargo(g2!, WHEEL, cap);
    if (back && back.profit > 0) expect(g2!.buy(back.id, cap).ok).toBe(true);
    const ret = flyTo(g2!, WHEEL, 'Gloaming Lock -> Chandler\'s Wheel');
    expect(g2!.state.vessel.dockedAt).toBe(WHEEL);
    expect(ret.dvUsed).toBeLessThan(2400);
    expect(g2!.diagnostics().faults + g2!.diagnostics().rollbacks).toBe(0);
    expect(g2!.player().stats.dockings).toBe(2);
  }, 40000);

  test('flight plan: nodes change the trajectory version; manual flight; fallback planner verifies', () => {
    const g = createGame({ seed: 1 });
    expect(g.undock().ok).toBe(true);
    for (let i = 0; i < 30 * 14; i++) g.step(DT);
    expect(g.dockingState().transit).toBeNull();
    expect(g.flightInfo().situation).toBe('orbit');
    const v0 = g.trajectory().version;
    const a = g.addNode(g.time() + 600, { prograde: 50 });
    expect(a.ok).toBe(true);
    const v1 = g.trajectory().version;
    expect(v1).not.toBe(v0);
    expect(g.trajectory().nodes.length).toBe(1);
    expect(g.trajectory().nodes[0].dvMagnitude).toBeCloseTo(50, 3);
    expect(g.updateNode(a.id!, { dv: { prograde: 80 } }).ok).toBe(true);
    const v2 = g.trajectory().version;
    expect(v2).not.toBe(v1);
    expect(g.flightInfo().nextNode?.dvRemaining).toBeCloseTo(80, 3);
    expect(g.removeNode(a.id!).ok).toBe(true);
    expect(g.trajectory().version).not.toBe(v2);
    expect(g.removeNode('nope').ok).toBe(false);
    // The version only moves on a recompute.
    const v3 = g.trajectory().version;
    g.flightInfo();
    g.targetInfo();
    expect(g.trajectory().version).toBe(v3);

    // Execute one node with the flight computer: delivered delta-v within 0.5 m/s.
    const b = g.addNode(g.time() + 120, { prograde: 30 });
    const dv0 = deltaVRemaining(g.state.vessel);
    expect(g.engageAutopilot({ kind: 'executeNode' }).ok).toBe(true);
    for (let i = 0; i < 30 * 400 && g.autopilot().engaged; i++) g.step(DT);
    expect(g.autopilot().failed).toBeNull();
    expect(g.nodes().length).toBe(0);
    expect(Math.abs(dv0 - deltaVRemaining(g.state.vessel) - 30)).toBeLessThan(0.5);
    expect(b.ok).toBe(true);

    // Manual input: throttle burns propellant and disengages the flight computer.
    g.addNode(g.time() + 900, { prograde: 10 });
    expect(g.engageAutopilot({ kind: 'flyPlan' }).ok).toBe(true);
    g.setControls({ throttle: 0.5 });
    expect(g.autopilot().engaged).toBe(false);
    const fuel = g.state.vessel.fuel;
    for (let i = 0; i < 60; i++) g.step(DT);
    expect(g.state.vessel.fuel).toBeLessThan(fuel);
    g.setControls({ throttle: 0 });
    g.clearNodes();

    // Own Hohmann fallback reaches the station on paper.
    const st = g.system.stations.find((s) => s.id === LOCK)!;
    const ship = shipFromVessel(g.state.vessel, g.time());
    const h = hohmannPlan(g.model, ship, st);
    expect(h.ok).toBe(true);
    if (h.ok) {
      const miss = verifyPlan(g.model, ship, h.nodes, st);
      console.log(`Hohmann fallback: ${h.summary}; predicted miss ${(miss / 1000).toFixed(2)} km`);
      expect(miss).toBeLessThan(20e3);
    }
    // Tug rules: too far from Gloaming Lock; close to the Wheel it works and can be cancelled.
    expect(g.requestDocking(LOCK).ok).toBe(false);
    expect(g.requestDocking(WHEEL).ok).toBe(true);
    expect(g.dockingState().tug).toBe(true);
    g.cancelDocking();
    expect(g.dockingState().transit).toBeNull();
    // No station named and no target: the nearest station answers, and the tug brings the ship in.
    expect(g.requestDocking().ok).toBe(true);
    for (let i = 0; i < 30 * 45 && g.state.vessel.dockedAt === null; i++) {
      g.step(DT);
      expect(g.warp().level).toBe(1);
    }
    expect(g.state.vessel.dockedAt).toBe(WHEEL);
    expect(g.dockingState().portDistance).toBeLessThan(0.01);
  });

  test('fuzz: random actions never throw or produce NaN', () => {
    const g = createGame({ seed: 7 });
    const rng = makeRng('fuzz');
    const ids = g.system.stations.map((s) => s.id);
    const bodies = g.system.bodies.map((b) => b.id);
    const sas = ['off', 'stability', 'prograde', 'retrograde', 'normal', 'radialIn', 'target', 'maneuver', 'killRelative'] as const;
    const plans = ['toTarget', 'circularizeAtPeriapsis', 'circularizeAtApoapsis', 'matchPlane', 'returnToSafeOrbit'] as const;
    for (let i = 0; i < 2500; i++) {
      switch (rng.int(0, 22)) {
        case 0: g.undock(); break;
        case 1: g.setControls({ throttle: rng.chance(0.5) ? rng.next() : 0, pitch: rng.range(-1, 1), yaw: rng.range(-1, 1), roll: NaN }); break;
        case 2: g.setControls({ translate: { x: rng.range(-1, 1), y: Infinity, z: rng.range(-1, 1) } }); break;
        case 3: g.setSas(rng.pick(sas)); break;
        case 4: g.setTarget(rng.chance(0.2) ? null : rng.chance(0.6) ? { kind: 'station', id: rng.pick(ids) } : { kind: 'body', id: rng.pick(bodies) }); break;
        case 5: g.addNode(g.time() + rng.range(-100, 5000), { prograde: rng.range(-300, 300), normal: rng.range(-50, 50), radial: NaN }); break;
        case 6: { const n = g.nodes()[0]; if (n) g.updateNode(n.id, { t: g.time() + rng.range(0, 3000), dv: { prograde: rng.range(-500, 500) } }); break; }
        case 7: { const n = g.nodes()[0]; if (n) g.removeNode(n.id); break; }
        case 8: g.plan(rng.pick(plans)); break;
        case 9: g.engageAutopilot(rng.chance(0.5) ? { kind: 'goToStation', stationId: rng.pick(ids) } : rng.chance(0.5) ? { kind: 'flyPlan' } : { kind: 'matchVelocity', stationId: rng.pick(ids) }); break;
        case 10: g.disengageAutopilot(); break;
        case 11: g.requestDocking(rng.chance(0.5) ? rng.pick(ids) : undefined); break;
        case 12: g.cancelDocking(); break;
        case 13: g.setWarp(rng.pick([1, 4, 10, 100, 1000, 1e6, NaN, -5])); break;
        case 14: { const m = g.market(); if (m.length) g.buy(rng.pick(m).commodityId, rng.int(-1, 12)); break; }
        case 15: { const c = g.player().cargo[0]; if (c) g.sell(c.commodityId, rng.int(0, 12)); break; }
        case 16: g.refuel(rng.chance(0.5) ? rng.range(-10, 5000) : undefined); break;
        case 17: g.repair(); g.rebuy(); g.callTender(); break;
        case 18: { const j = g.save(); expect(loadGame(j)).not.toBeNull(); break; }
        case 19: g.clearNodes(); break;
        case 20: g.warpUp(); break;
        case 21: g.warpDown(); break;
        default: g.engageAutopilot({ kind: 'dock', stationId: rng.pick(ids) }); break;
      }
      const n = rng.int(1, 12);
      for (let k = 0; k < n; k++) g.step(rng.pick([1 / 60, 1 / 30, 0.1, 0, NaN]));
      g.flightInfo(); g.targetInfo(); g.contacts(); g.player(); g.shipPose(); g.dockingState(); g.autopilot(); g.warp(); g.trajectory(); g.tenderQuote(); g.rebuyQuote(); g.repairQuote(); g.refuelQuote();
      if (!finiteState(g)) throw new Error(`non-finite state after action ${i}`);
    }
    const d = g.diagnostics();
    console.log(`fuzz: faults ${d.faults}, rollbacks ${d.rollbacks}, last fault: ${d.lastFault.split('\n')[0]} · t=${(g.time() / 3600).toFixed(1)} h · destroyed ${g.state.vessel.destroyed} · docked ${g.state.vessel.dockedAt}`);
    expect(d.faults).toBe(0);
    expect(d.rollbacks).toBe(0);
  }, 30000);
});
