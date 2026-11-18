// The world as a whole: advance it through time inside a CPU budget, read its event queue, save and load it.

import type { Craft, World, WorldEvent } from './state';
import { ephemerisOf } from './ephemeris';
import { integrateCraft, lastStop, stepEstimate, STOP_SURFACE, takeSteps, WHY_CONTACT, WHY_FREE } from './dynamics';
import { proximityLimit, proximityWhy, resolveContacts, surfaceContact, updateJoints } from './contact';
import { perfNow } from './math';

export type LimitedBy = '' | 'thrust' | 'rotation' | 'contact' | 'atmosphere' | 'proximity' | 'cpu';

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
}

/** Craft steps per synchronisation of the whole world while coasting (keeps the budget check fine-grained). */
const CHUNK_STEPS = 32;
const WHY_NAMES: LimitedBy[] = ['cpu', 'thrust', 'rotation', 'atmosphere', 'proximity', 'contact'];
const tally = new Float64Array(8);
const S6 = new Float64Array(6);
const RESULT: AdvanceResult = { simDt: 0, simMs: 0, steps: 0, limitedBy: '' };
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

/**
 * Advance the world by `simDt` seconds — a wish. Every craft takes its own adaptive steps under the full laws;
 * the world is synchronised (joints, contacts, latches) as often as proximity demands. If the budget runs out
 * first, the call stops at a consistent time and reports how far it got and what kept the steps small:
 * 'thrust', 'rotation', 'atmosphere', 'proximity', 'contact', or plain 'cpu'.
 * The returned object is reused between calls.
 */
export function advance(world: World, simDt: number, opts: AdvanceOptions = NO_OPTS): AdvanceResult {
  const now = opts.now ?? perfNow;
  const budget = opts.budgetMs ?? Infinity;
  const start = now();
  const eph = ephemerisOf(world);
  const craft = world.craft;
  const t0 = world.t, tEnd = t0 + simDt;
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
    resolveContacts(world, t1);
    if (world.t < tEnd && now() - start > budget) { limited = true; break; }
  }
  refreshWorld(world);
  const craftSteps = takeSteps();
  let limitedBy: LimitedBy = '';
  if (limited) {
    let best = 1;
    for (let i = 2; i <= WHY_CONTACT; i++) if (tally[i] > tally[best]) best = i;
    let total = 0;
    for (let i = 0; i <= WHY_CONTACT; i++) total += tally[i];
    limitedBy = tally[best] >= 0.3 * total ? WHY_NAMES[best] : 'cpu';
  }
  RESULT.simDt = world.t - t0;
  RESULT.simMs = now() - start;
  RESULT.steps = craftSteps + (eph.steps - bodySteps0);
  RESULT.limitedBy = limitedBy;
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
  return JSON.stringify(world);
}

export function loadWorld(json: string): World {
  const w = JSON.parse(json) as World;
  if (!w || w.version !== 1 || !Array.isArray(w.bodies) || !Array.isArray(w.craft)) throw new Error('loadWorld: not a version 1 world');
  return w;
}

/** Convenience: the craft with this id, or null. */
export function getCraft(world: World, id: string): Craft | null {
  for (let i = 0; i < world.craft.length; i++) if (world.craft[i].id === id) return world.craft[i];
  return null;
}
