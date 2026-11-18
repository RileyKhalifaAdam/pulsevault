// Helpers that fly planner output in pure patched-conic simulation (orbit.ts propagation + node
// application through planner.predictWithNodes) and measure what actually happens. Shared by
// tests/planner.test.ts and the offline random sweep (shots/planner-sweep.ts).

import type { OrbitElements, StateVector, V3 } from '../../src/core/types';
import { SystemModel, elementsToStateTo, newState, orbitNormal } from '../../src/sim/orbit';
import type { TrajectoryPatch, TrajectoryStart } from '../../src/sim/orbit';
import { predictWithNodes } from '../../src/sim/planner';
import type { ManeuverNode, PlanOk } from '../../src/sim/planner';
import type { Rng } from '../../src/core/rng';

const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

/** Arcs after the last node of a plan (vacuum: atmospheres do not stop the prediction). */
export function arcsAfter(model: SystemModel, ship: TrajectoryStart, nodes: readonly ManeuverNode[], maxPatches = 2): { patches: TrajectoryPatch[]; complete: boolean } {
  const pred = predictWithNodes(model, ship, nodes, { maxPatches, maxDuration: 200 * 86400, stopAtAtmosphere: false });
  const last = pred.nodes.length ? pred.nodes[pred.nodes.length - 1] : null;
  const from = last ? last.patchIndex : 0;
  return { patches: from >= 0 ? pred.patches.slice(from) : [], complete: pred.complete };
}

/** Distance (m) and relative speed (m/s) to an orbiter right after the last node of a rendezvous plan. */
export function rendezvousMiss(model: SystemModel, ship: TrajectoryStart, plan: PlanOk, target: OrbitElements, bodyId: string): { dist: number; rel: number; minDist: number } {
  const pred = predictWithNodes(model, ship, plan.nodes, { maxPatches: 1, maxDuration: 1200, stopAtAtmosphere: false });
  if (!pred.complete || pred.nodes.length === 0) return { dist: Infinity, rel: Infinity, minDist: Infinity };
  const a = pred.nodes[pred.nodes.length - 1];
  if (a.bodyId !== bodyId) return { dist: Infinity, rel: Infinity, minDist: Infinity };
  const mu = model.body(bodyId).mu;
  const tg = elementsToStateTo(newState(), target, mu, a.node.t);
  const dist = len(sub(a.after.r, tg.r));
  const rel = len(sub(a.after.v, tg.v));
  // Nothing should ram the target in the first 20 minutes either.
  let minDist = dist;
  const p = pred.patches[pred.patches.length - 1];
  if (p) {
    for (let k = 1; k <= 40; k++) {
      const t = a.node.t + k * 30;
      if (t > p.tEnd) break;
      const s = elementsToStateTo(newState(), p.elements, mu, t);
      const g = elementsToStateTo(newState(), target, mu, t);
      minDist = Math.min(minDist, len(sub(s.r, g.r)));
    }
  }
  return { dist, rel, minDist };
}

/** What a transfer plan does at its target: the pass periapsis before the capture burn and the orbit after it. */
export function transferOutcome(
  model: SystemModel,
  ship: TrajectoryStart,
  plan: PlanOk,
  targetId: string,
): { reached: boolean; rp: number; peAfter: number; apAfter: number; closedAfter: boolean; inc: number } {
  const dep = plan.nodes.filter((n) => n.bodyId !== targetId);
  const pred = predictWithNodes(model, ship, dep, { maxPatches: 8, maxDuration: 200 * 86400, stopAtAtmosphere: false, searchPeriods: 1 });
  const last = pred.nodes.length ? pred.nodes[pred.nodes.length - 1].patchIndex : 0;
  let pass: TrajectoryPatch | null = null;
  for (let i = Math.max(0, last); i < pred.patches.length; i++) {
    if (pred.patches[i].bodyId === targetId) {
      pass = pred.patches[i];
      break;
    }
  }
  if (!pass) return { reached: false, rp: NaN, peAfter: NaN, apAfter: NaN, closedAfter: false, inc: NaN };
  const n = orbitNormal(pass.svStart);
  const inc = Math.acos(Math.max(-1, Math.min(1, n.y)));
  const after = arcsAfter(model, ship, plan.nodes, 1);
  const p = after.patches[0];
  const okAfter = after.complete && !!p && p.bodyId === targetId;
  return {
    reached: true,
    rp: pass.periapsisRadius,
    peAfter: okAfter ? p.periapsisRadius : NaN,
    apAfter: okAfter ? p.apoapsisRadius : NaN,
    closedAfter: okAfter && p.apoapsisRadius < Infinity,
    inc,
  };
}

/** A random bound orbit around `bodyId`: periapsis >= rMin, apoapsis <= rMax, inclination up to `maxInc`, eccentricity up to `maxE`. */
export function randomOrbit(rng: Rng, rMin: number, rMax: number, maxInc: number, maxE: number, t: number): OrbitElements {
  const rp = rMin * (1 + 0.02 * rng.next()) + (rMax - rMin) * 0.5 * rng.next() * rng.next();
  let e = maxE * rng.next() * rng.next();
  const raMax = Math.max(rp, rMax);
  e = Math.min(e, (raMax - rp) / (raMax + rp));
  const a = rp / (1 - e);
  return { a, e, i: maxInc * rng.next(), lan: 2 * Math.PI * rng.next(), argp: 2 * Math.PI * rng.next(), m0: 2 * Math.PI * rng.next(), epoch: t };
}

/** Ship start on given elements around `bodyId` at time t. */
export function shipOn(model: SystemModel, bodyId: string, el: OrbitElements, t: number): TrajectoryStart {
  const sv: StateVector = elementsToStateTo(newState(), el, model.body(bodyId).mu, t);
  return { bodyId, sv, t };
}
