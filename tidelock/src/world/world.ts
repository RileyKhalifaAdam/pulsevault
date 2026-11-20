// The world as a whole: advance it through time inside a CPU budget, read its event queue, save and load it.

import { DERIVED_CRAFT_KEYS, type Craft, type World, type WorldEvent } from './state';
import { buildThrusters } from './setup';
import { loadJetState, RCS_CAPACITY } from './jets';
import { ephemerisOf } from './ephemeris';
import { integrateCraft, lastStop, stepEstimate, STOP_SURFACE, takeSteps, WHY_CONTACT, WHY_FREE } from './dynamics';
import { contactsForSave, proximityLimit, proximityWhy, resolveContacts, surfaceContact, updateJoints } from './contact';
import { perfNow } from './math';

/** Why a step was short. Wave 1 adds the names later waves' laws report (SIMULATION.md W1-A 2): 'capture' (soft-capture
 * docking, W2-C), 'venting' (breach, W3-B), 'crew' (the crew body in contact, W1-C), 'systems' (ship systems, W2-D). */
export type LimitedBy = '' | 'thrust' | 'rotation' | 'contact' | 'atmosphere' | 'proximity' | 'cpu' | 'capture' | 'venting' | 'crew' | 'systems';

/** The fixed simulation tick (SIMULATION.md §1.3): Q = 1/TICK_HZ s; sim time is always world.tick / TICK_HZ. */
export const TICK_HZ = 120;
export const TICK = 1 / TICK_HZ;

export interface AdvanceOptions {
  /** Wall-clock milliseconds this call may use (default: unlimited). */
  budgetMs?: number;
  /** Wall clock, ms (default performance.now). Injected so that the world itself stays deterministic. */
  now?: () => number;
}

export interface AdvanceResult {
  /** Sim seconds actually covered. */
  simDt: number;
  /** Wall-clock milliseconds used. */
  simMs: number;
  /** Integration steps taken (body steps + craft steps + rotation sub-steps). */
  steps: number;
  /** Why less than the requested time was covered ('' = all of it was). */
  limitedBy: LimitedBy;
  /**
   * What made the craft steps short, whether or not the budget ran out (the same rule as limitedBy: the reason behind
   * ≥ 30% of the steps, else '' when they were free or 'cpu'). The session's work-unit budget names its limit by it.
   */
  busy: LimitedBy;
}

/** Craft steps per synchronisation of the whole world while coasting (keeps the budget check fine-grained). */
const CHUNK_STEPS = 32;
/** By dynamics.ts WHY_* index (WHY_FREE = 0 … WHY_CONTACT = 5); 6..9 are reserved for the later waves' reasons. */
const WHY_NAMES: LimitedBy[] = ['cpu', 'thrust', 'rotation', 'atmosphere', 'proximity', 'contact', 'capture', 'venting', 'crew', 'systems'];
const tally = new Float64Array(WHY_NAMES.length);
const S6 = new Float64Array(6);
const RESULT: AdvanceResult = { simDt: 0, simMs: 0, steps: 0, limitedBy: '', busy: '' };
const TAU = 2 * Math.PI;
const NO_OPTS: AdvanceOptions = {};

/** Recompute the derived fields (barycentric states, spin angles) at world.t. */
export function refreshWorld(world: World): void {
  const eph = ephemerisOf(world), t = world.t, bodies = world.bodies;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    eph.state(t, i, S6);
    b.r.x = S6[0]; b.r.y = S6[1]; b.r.z = S6[2];
    b.v.x = S6[3]; b.v.y = S6[4]; b.v.z = S6[5];
    const a = (b.spinAngle0 + b.spinRate * t) % TAU;
    b.spinAngle = a < 0 ? a + TAU : a;
  }
  const craft = world.craft;
  for (let i = 0; i < craft.length; i++) {
    const c = craft[i], b = bodies[c.primary];
    c.r.x = b.r.x + c.rel.x; c.r.y = b.r.y + c.rel.y; c.r.z = b.r.z + c.rel.z;
    c.v.x = b.v.x + c.relV.x; c.v.y = b.v.y + c.relV.y; c.v.z = b.v.z + c.relV.z;
  }
}

/** The world's tick index (SIMULATION.md §1.3). A world from createWorld or an older save has none yet: its tick is
 * the last whole tick at or before world.t (the first advanceTicks then ends exactly on the grid). */
export function worldTick(world: World): number {
  const k = world.tick;
  return typeof k === 'number' && k === k ? k : Math.floor(world.t * TICK_HZ + 1e-9);
}

/**
 * Advance the world by `simDt` seconds — a wish. Every craft takes its own adaptive steps under the full laws;
 * the world is synchronised (joints, contacts, latches) as often as proximity demands. If the budget runs out
 * first, the call stops at a consistent time and reports how far it got and what kept the steps small:
 * 'thrust', 'rotation', 'atmosphere', 'proximity', 'contact', or plain 'cpu'.
 * The returned object is reused between calls. (The session steps the world with advanceTicks; this free-time form
 * is for tools and tests. world.tick follows to the last whole tick at or before the new world.t.)
 */
export function advance(world: World, simDt: number, opts: AdvanceOptions = NO_OPTS): AdvanceResult {
  const r = advanceTo(world, world.t + simDt, opts.budgetMs ?? Infinity, opts.now ?? perfNow);
  world.tick = Math.floor(world.t * TICK_HZ + 1e-9);
  return r;
}

/**
 * Advance the world by exactly `n` whole ticks, to t = (tick + n) / TICK_HZ (SIMULATION.md §1.3: craft keep their
 * adaptive steps but synchronise on tick boundaries; under warp n is the quantum). No wall-clock budget: the session
 * budgets whole steps, so a step always ends on the grid. The returned object is reused between calls.
 */
export function advanceTicks(world: World, n: number): AdvanceResult {
  const k1 = worldTick(world) + (n > 0 ? n : 0);
  const t1 = k1 / TICK_HZ;
  const r = advanceTo(world, t1, Infinity, perfNow);
  world.tick = k1;
  world.t = t1;
  return r;
}

function advanceTo(world: World, tEnd: number, budget: number, now: () => number): AdvanceResult {
  const limitedClock = budget < Infinity;
  const start = limitedClock ? now() : 0;
  const eph = ephemerisOf(world);
  const craft = world.craft;
  const t0 = world.t;
  const bodySteps0 = eph.steps;
  let limited = false;
  tally.fill(0);
  takeSteps();
  while (world.t < tEnd) {
    const t = world.t;
    // Longest stretch before the world must be looked at as a whole again.
    let span = Infinity, why = WHY_FREE;
    for (let i = 0; i < craft.length; i++) {
      const c = craft[i];
      if (c.dockedTo !== null || c.landedOn !== null) continue;
      const d = CHUNK_STEPS * stepEstimate(world, c);
      if (d < span) span = d;
    }
    const prox = proximityLimit(world);
    if (prox < span) { span = prox; why = proximityWhy(); }
    let t1 = t + span < tEnd ? t + span : tEnd;
    if (t1 === tEnd) why = WHY_FREE;
    eph.setPin(t);
    const cov = eph.ensure(t1);
    if (cov < t1) t1 = cov;
    for (let i = 0; i < craft.length; i++) {
      const c = craft[i];
      if (c.dockedTo !== null || c.landedOn !== null) continue;
      const tr = integrateCraft(world, eph, c, t, t1, tally, why);
      if (lastStop() === STOP_SURFACE) surfaceContact(world, c, tr);
    }
    world.t = t1;
    updateJoints(world, t1, t1 - t);
    resolveContacts(world, t1, t1 - t);
    if (limitedClock && world.t < tEnd && now() - start > budget) { limited = true; break; }
  }
  refreshWorld(world);
  const craftSteps = takeSteps();
  let best = 1, total = 0;
  for (let i = 2; i < tally.length; i++) if (tally[i] > tally[best]) best = i;
  for (let i = 0; i < tally.length; i++) total += tally[i];
  const busy: LimitedBy = tally[best] > 0 && tally[best] >= 0.3 * total ? WHY_NAMES[best] : '';
  RESULT.simDt = world.t - t0;
  RESULT.simMs = limitedClock ? now() - start : 0;
  RESULT.steps = craftSteps + (eph.steps - bodySteps0);
  RESULT.limitedBy = limited ? (busy !== '' ? busy : 'cpu') : '';
  RESULT.busy = busy;
  return RESULT;
}

const NO_EVENTS: WorldEvent[] = [];

/** Take everything that happened since the last call (the queue is emptied). */
export function drainEvents(world: World): WorldEvent[] {
  if (world.events.length === 0) return NO_EVENTS;
  const e = world.events;
  world.events = [];
  return e;
}

/** Serialise the world. load → continue reproduces the unsaved run bit for bit. */
export function saveWorld(world: World): string {
  const seed = ephemerisOf(world).seed(world.t);
  world.ephStep = seed.step;
  world.ephState = seed.state;
  world.contacts = contactsForSave(world);
  // the derived thruster data (jets, engines, the allocation table, scratch) is rebuilt at load, never saved
  const craft = world.craft.map((c) => {
    const o = { ...c } as Record<string, unknown>;
    for (let i = 0; i < DERIVED_CRAFT_KEYS.length; i++) delete o[DERIVED_CRAFT_KEYS[i]];
    return o;
  });
  return JSON.stringify({ ...world, craft });
}

export function loadWorld(json: string): World {
  const w = JSON.parse(json) as World;
  if (!w || w.version !== 1 || !Array.isArray(w.bodies) || !Array.isArray(w.craft)) throw new Error('loadWorld: not a version 1 world');
  for (let i = 0; i < w.craft.length; i++) migrateCraft(w.craft[i]);
  return w;
}

const finite = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);

/**
 * SIMULATION.md Decision 4: bring a loaded craft up to the current fields, never discard it. Every field added since
 * the save was made gets its loader default; the derived data is rebuilt (setup.ts buildThrusters).
 * - A save from before the two pools (no `rcsPropellant`: session save version 3) had one tank. It is split as
 *   rcs = min(1.5 t, propellant/16), main = propellant − rcs (capacities alike), so the total mass is kept and an
 *   upgraded ship never finds its RCS pool dry.
 * - Duties and engine thrust 0, engines unlit, ledgers and impulses zero, no air, hold awake (holdWakeT = +∞; a
 *   saved null is +∞). Arrays are resized to the craft's current jet and engine counts.
 * Values present in the save are kept bit for bit, so save → load → step is bit-identical.
 */
export function migrateCraft(c: Craft): Craft {
  const raw = c as unknown as Record<string, unknown>;
  if (typeof raw.rcsPropellant !== 'number') {
    const p = finite(raw.propellant, 0), cap = finite(raw.propellantCapacity, p);
    const rcs = Math.min(RCS_CAPACITY, (p > 0 ? p : 0) / 16), rcsCap = Math.min(RCS_CAPACITY, (cap > 0 ? cap : 0) / 16);
    c.propellant = p - rcs;
    c.propellantCapacity = cap - rcsCap;
    c.rcsPropellant = rcs;
    c.rcsPropellantCapacity = rcsCap > rcs ? rcsCap : rcs;
  }
  const rc = finite(raw.rcsPropellantCapacity, 0);
  c.rcsPropellantCapacity = rc > 0 ? rc : 0;
  buildThrusters(c);
  const js = loadJetState(raw, c.jets.length, c.engines.length, c.rcsPropellantCapacity);
  c.jetDuty = js.jetDuty;
  c.engineThrust = js.engineThrust;
  c.engineTimer = js.engineTimer;
  c.rcsPropellant = js.rcsPropellant;
  c.rcsPropellantCapacity = js.rcsPropellantCapacity;
  c.fAcc = js.fAcc;
  c.tauAcc = js.tauAcc;
  c.accT = js.accT;
  c.dvImpulse = js.dvImpulse;
  c.dwImpulse = js.dwImpulse;
  c.holdWakeT = js.holdWakeT;
  const av = (raw.airVel && typeof raw.airVel === 'object' ? raw.airVel : {}) as Record<string, unknown>;
  c.airVel = { x: finite(av.x, 0), y: finite(av.y, 0), z: finite(av.z, 0) };
  c.heatFlux = finite(raw.heatFlux, 0);
  return c;
}

/** Convenience: the craft with this id, or null. */
export function getCraft(world: World, id: string): Craft | null {
  for (let i = 0; i < world.craft.length; i++) if (world.craft[i].id === id) return world.craft[i];
  return null;
}
