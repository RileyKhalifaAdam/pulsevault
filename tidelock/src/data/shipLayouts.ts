// Physical layouts of the seven hulls: pure data shared by the simulation (collision radius, docking
// collar) and the renderer (render/space/ships.ts builds nozzles, RCS blocks, hardpoint mounts, the
// docking collar and the navigation lights AT these positions, so they always sit on the geometry).
//
// Ship-local metres: forward = -Z, up = +Y, right (starboard) = +X, origin at the centre of mass.
// Main-engine exhaust leaves toward +Z; `engines[i].pos` is the centre of the nozzle exit plane.
//
// RCS: `rcs[i].dir` is the EXHAUST direction (the push on the ship is opposite). Every hull carries ±X, ±Y and ±Z
// jets (SIMULATION.md W1-B: two −Z-exhaust jets forward that push the ship aft, two +Z-exhaust jets aft). Each new
// position sits on the hull's collision skin with a 15° plume cone clear of the hull for 6 m (checked against
// HULL_COLLIDERS in tests/jets.test.ts); the jet table (world/jets.ts) is solved from these at load.

import type { RGB, ShipLayout, ShipVisualId, V3 } from '../core/types';

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });

const RED: RGB = [1, 0.05, 0.03];
const GREEN: RGB = [0.05, 1, 0.22];
const WHITE: RGB = [1, 1, 1];

const PX = v(1, 0, 0);
const NX = v(-1, 0, 0);
const PY = v(0, 1, 0);
const NY = v(0, -1, 0);
const NZ = v(0, 0, -1);
const PZ = v(0, 0, 1);

/** Mirror a list of starboard (+X) entries to both sides: starboard first, then port. */
function both<T extends { pos: V3 }>(items: T[], flip?: (t: T) => T): T[] {
  const out: T[] = [];
  for (const it of items) {
    out.push(it);
    const m = { ...it, pos: v(-it.pos.x, it.pos.y, it.pos.z) };
    out.push(flip ? flip(m) : m);
  }
  return out;
}
const flipDir = <T extends { dir: V3 }>(t: T): T => ({ ...t, dir: v(-t.dir.x, t.dir.y, t.dir.z) });

/** Standard light set: red port, green starboard, white tail strobe (+ optional extra beacons). */
function navLights(tip: V3, tail: V3, extra: { pos: V3; color: RGB; blink: number }[] = []): ShipLayout['lights'] {
  return [
    { pos: v(-Math.abs(tip.x), tip.y, tip.z), color: RED, blink: 0 },
    { pos: v(Math.abs(tip.x), tip.y, tip.z), color: GREEN, blink: 0 },
    { pos: tail, color: WHITE, blink: 1.4 },
    ...extra,
  ];
}

export const SHIP_LAYOUTS: Record<ShipVisualId, ShipLayout> = {
  // Corvane Wren — 32 m courier you can live in: smooth white armour over the nose and upper hull, a working
  // body with exposed machinery along the flanks and stern, engine pods at the wing roots, twin canted fins.
  // The hull encloses the interior of src/data/interiors.ts (x ±3.2, deck -1.0 to overhead 1.4, z -15.0..13.4).
  wren: {
    id: 'wren',
    length: 32,
    width: 19,
    height: 6.6,
    radius: 16.5,
    engines: [
      { pos: v(4.8, -0.2, 15.6), radius: 1.15 },
      { pos: v(-4.8, -0.2, 15.6), radius: 1.15 },
    ],
    rcs: [
      ...both([{ pos: v(3.9, 0.2, -12.0), dir: PX }], flipDir),
      { pos: v(0, 2.0, -12.5), dir: PY },
      { pos: v(0, -1.7, -12.5), dir: NY },
      // (the 15° plume edge of these tail X jets grazes the wing trailing edge: no consequence until plume impingement)
      ...both([{ pos: v(6.0, -0.2, 11.0), dir: PX }], flipDir),
      ...both([{ pos: v(4.8, 1.1, 12.0), dir: PY }]),
      ...both([{ pos: v(4.8, -1.5, 12.0), dir: NY }]),
      // Z jets: nose cheeks outboard of the windscreen (the eye is at z −13.45), and the pod flanks aft
      ...both([{ pos: v(2.8, -0.1, -14.45), dir: NZ }]),
      ...both([{ pos: v(7.2, -0.6, 11.0), dir: PZ }]),
    ],
    hardpoints: both([{ pos: v(2.6, -1.7, -6.0), size: 1 }]),
    dockingPort: { pos: v(0, 1.95, 2.2), dir: PY },
    cockpit: v(-0.55, 0.25, -13.45),
    chaseCam: { distance: 64, height: 14 },
    // visual only: lenses on the wing-tip pods, strobes on both fin tips, belly and dorsal beacons
    lights: [
      { pos: v(-9.53, -0.42, 6.5), color: RED, blink: 0 },
      { pos: v(9.53, -0.42, 6.5), color: GREEN, blink: 0 },
      { pos: v(3.36, 4.4, 14.7), color: WHITE, blink: 1.4 },
      { pos: v(-3.36, 4.4, 14.7), color: WHITE, blink: 1.4 },
      { pos: v(0, -1.8, 1.0), color: RED, blink: 2.2 },
      { pos: v(0, 2.62, 10.9), color: RED, blink: 2.2 },
    ],
  },

  // Ilmarin Drover — crew module, truss spine with six cans, one big bell
  drover: {
    id: 'drover',
    length: 38.3,
    width: 10.9,
    height: 11.2,
    radius: 19.4,
    engines: [{ pos: v(0, 0, 19.0), radius: 2.2 }],
    rcs: [
      ...both([{ pos: v(2.6, -0.2, -15.6), dir: PX }], flipDir),
      { pos: v(0, 2.2, -15.9), dir: PY },
      { pos: v(0, -2.2, -15.6), dir: NY },
      ...both([{ pos: v(3.78, 0, 12.6), dir: PX }], flipDir),
      ...both([{ pos: v(1.0, 1.75, 14.2), dir: PY }]),
      ...both([{ pos: v(1.0, -1.75, 14.2), dir: NY }]),
      ...both([{ pos: v(1.6, 0, -19.2), dir: NZ }]),
      // the aft cans are not mirror images: each jet sits on its own can's after face
      { pos: v(3.6, 0, 14.35), dir: PZ },
      { pos: v(-3.4, 0, 14.65), dir: PZ },
    ],
    hardpoints: both([{ pos: v(1.15, -2.42, -14.6), size: 1 }]),
    dockingPort: { pos: v(0, 2.51, -14.0), dir: PY },
    cockpit: v(0, 1.2, -18.2),
    chaseCam: { distance: 78, height: 18 },
    lights: navLights(v(2.64, -0.2, -14.2), v(0, 5.68, 13.1), [{ pos: v(0, -2.27, -15.0), color: RED, blink: 2.2 }]),
  },

  // Hadley-Okafor Magpie — stubby hull, chin laser boom, side hoppers, grapple arms
  magpie: {
    id: 'magpie',
    length: 26,
    width: 13.4,
    height: 9.2,
    radius: 13.5,
    engines: [
      { pos: v(1.75, -0.3, 13.0), radius: 1.2 },
      { pos: v(-1.75, -0.3, 13.0), radius: 1.2 },
    ],
    rcs: [
      ...both([{ pos: v(3.7, -0.3, -4.2), dir: PX }], flipDir),
      ...both([{ pos: v(2.0, 3.0, -4.25), dir: PY }]),
      ...both([{ pos: v(2.0, -3.0, -4.25), dir: NY }]),
      ...both([{ pos: v(3.7, -0.3, 6.8), dir: PX }], flipDir),
      ...both([{ pos: v(2.05, 3.0, 6.85), dir: PY }]),
      ...both([{ pos: v(0.9, -3.0, 6.85), dir: NY }]),
      ...both([{ pos: v(2.1, 0, -7.3), dir: NZ }]),
      ...both([{ pos: v(6.0, 0, 6.35), dir: PZ }]),
    ],
    hardpoints: both([{ pos: v(2.2, 3.3, -2.3), size: 1 }]),
    dockingPort: { pos: v(0, 3.31, 6.0), dir: PY },
    cockpit: v(0, 3.7, -5.6),
    chaseCam: { distance: 56, height: 14 },
    lights: navLights(v(6.7, 2.08, 1.5), v(0, 5.66, 7.9), [{ pos: v(0, -3.06, 0.5), color: RED, blink: 2.2 }]),
  },

  // Corvane Shrike — long nose, forward-swept wings, twin canted fins, two close-set drives
  shrike: {
    id: 'shrike',
    length: 15,
    width: 11.4,
    height: 3.7,
    radius: 7.7,
    engines: [
      { pos: v(0.72, 0.02, 7.5), radius: 0.56 },
      { pos: v(-0.72, 0.02, 7.5), radius: 0.56 },
    ],
    rcs: [
      ...both([{ pos: v(0.62, -0.02, -4.5), dir: PX }], flipDir),
      { pos: v(0, 0.42, -4.5), dir: PY },
      { pos: v(0, -0.36, -4.5), dir: NY },
      ...both([{ pos: v(1.62, 0.02, 5.9), dir: PX }], flipDir),
      ...both([{ pos: v(0.62, 0.68, 5.7), dir: PY }]),
      ...both([{ pos: v(0.62, -0.54, 5.7), dir: NY }]),
      ...both([{ pos: v(0.7, 0, -5.95), dir: NZ }]),
      ...both([{ pos: v(2.2, 0, 5.35), dir: PZ }]),
    ],
    hardpoints: both([
      { pos: v(2.6, -0.6, 1.9), size: 2 },
      { pos: v(4.0, -0.68, 0.4), size: 1 },
    ]),
    dockingPort: { pos: v(0, 1.17, 1.2), dir: PY },
    cockpit: v(0, 0.92, -2.9),
    chaseCam: { distance: 32, height: 7.5 },
    lights: navLights(v(5.7, -0.36, -1.45), v(0, 0.74, 5.95), [{ pos: v(0, -0.66, 1.0), color: RED, blink: 2.2 }]),
  },

  // Ilmarin Albatross — slender hull, radiator wings, dish, spherical tanks
  albatross: {
    id: 'albatross',
    length: 34,
    width: 30,
    height: 7.9,
    radius: 18.9,
    engines: [
      { pos: v(0.9, 0, 17.0), radius: 0.8 },
      { pos: v(-0.9, 0, 17.0), radius: 0.8 },
    ],
    rcs: [
      ...both([{ pos: v(1.6, 0, -10.4), dir: PX }], flipDir),
      { pos: v(0, 1.45, -8.4), dir: PY },
      { pos: v(0, -1.45, -10.4), dir: NY },
      ...both([{ pos: v(1.5, 0, 12.82), dir: PX }], flipDir),
      { pos: v(0, 1.5, 12.82), dir: PY },
      { pos: v(0, -1.5, 12.82), dir: NY },
      // every jet above has a zero roll arm: ±Y jets on the radiator-wing tips give the hull roll authority
      ...both([{ pos: v(14.5, 0.34, 9.775), dir: PY }]),
      ...both([{ pos: v(14.5, -0.26, 9.775), dir: NY }]),
      ...both([{ pos: v(0.7, 0, -16.1), dir: NZ }]),
      ...both([{ pos: v(15.0, 0, 10.15), dir: PZ }]),
    ],
    hardpoints: both([{ pos: v(0.9, -1.58, -8.6), size: 1 }]),
    dockingPort: { pos: v(0, 1.72, -9.9), dir: PY },
    cockpit: v(0, 0.75, -14.3),
    chaseCam: { distance: 84, height: 20 },
    lights: navLights(v(15.05, 0, 9.5), v(0, 1.56, 12.3), [{ pos: v(0, -1.52, -7.5), color: RED, blink: 2.2 }]),
  },

  // Hadley-Okafor Caravel — caged container stack on a keel, bow shield, bridge tower aft, four bells
  caravel: {
    id: 'caravel',
    length: 72.6,
    width: 18.2,
    height: 23.1,
    radius: 36.7,
    engines: [
      { pos: v(2.9, 2.35, 36.0), radius: 2.0 },
      { pos: v(-2.9, 2.35, 36.0), radius: 2.0 },
      { pos: v(2.9, -2.35, 36.0), radius: 2.0 },
      { pos: v(-2.9, -2.35, 36.0), radius: 2.0 },
    ],
    rcs: [
      ...both([{ pos: v(8.6, 0, -30.4), dir: PX }], flipDir),
      { pos: v(0, 6.3, -30.4), dir: PY },
      { pos: v(0, -6.3, -30.4), dir: NY },
      ...both([{ pos: v(5.8, 0, 31.8), dir: PX }], flipDir),
      ...both([{ pos: v(3.2, 4.8, 31.8), dir: PY }]),
      ...both([{ pos: v(3.2, -4.8, 31.8), dir: NY }]),
      ...both([{ pos: v(2.7, 0, -36.45), dir: NZ }]),
      ...both([{ pos: v(5.6, 0, 33.6), dir: PZ }]),
    ],
    hardpoints: [
      ...both([{ pos: v(5.0, 6.7, -30.5), size: 2 }]),
      ...both([{ pos: v(4.1, 6.4, 23.2), size: 2 }]),
    ],
    dockingPort: { pos: v(0, -0.2, -36.51), dir: NZ },
    cockpit: v(0, 11.9, 24.2),
    chaseCam: { distance: 165, height: 40 },
    lights: [
      ...navLights(v(7.52, 11.3, 25.9), v(0, 16.15, 26.4)),
      { pos: v(-8.66, 0, -29.9), color: RED, blink: 0 },
      { pos: v(8.66, 0, -29.9), color: GREEN, blink: 0 },
      { pos: v(0, -6.38, -30.0), color: RED, blink: 2.2 },
    ],
  },

  // Auric Arsenal Halberd — wedge prow, dorsal turret, side sponsons, triple drives
  halberd: {
    id: 'halberd',
    length: 44,
    width: 18.9,
    height: 10.6,
    radius: 22.7,
    engines: [
      { pos: v(0, -0.2, 22.0), radius: 1.5 },
      { pos: v(3.3, -0.2, 22.0), radius: 1.5 },
      { pos: v(-3.3, -0.2, 22.0), radius: 1.5 },
    ],
    rcs: [
      ...both([{ pos: v(4.8, -0.3, -13.0), dir: PX }], flipDir),
      { pos: v(0, 2.3, -13.0), dir: PY },
      { pos: v(0, -2.8, -13.0), dir: NY },
      ...both([{ pos: v(9.1, -0.3, 8.4), dir: PX }], flipDir),
      ...both([{ pos: v(7.6, 1.45, 8.4), dir: PY }]),
      ...both([{ pos: v(7.6, -2.05, 8.4), dir: NY }]),
      ...both([{ pos: v(2.6, 0, -20.5), dir: NZ }]),
      // above the drive bells, firing aft between them
      ...both([{ pos: v(1.7, 1.4, 18.8), dir: PZ }]),
    ],
    hardpoints: [
      ...both([{ pos: v(7.6, -0.3, -6.9), size: 3 }]),
      ...both([{ pos: v(7.6, 1.85, 4.4), size: 2 }]),
      ...both([{ pos: v(7.6, -2.45, 4.4), size: 2 }]),
    ],
    dockingPort: { pos: v(0, 3.54, 11.9), dir: PY },
    cockpit: v(0, 4.3, 3.6),
    chaseCam: { distance: 104, height: 26 },
    lights: navLights(v(9.14, -0.3, -1.4), v(0, 7.26, 6.0), [{ pos: v(0, -3.46, 0), color: RED, blink: 2.2 }]),
  },
};
