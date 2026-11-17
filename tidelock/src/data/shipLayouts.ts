// Physical layouts of the seven hulls: pure data shared by the simulation (collision radius, docking
// collar) and the renderer (render/space/ships.ts builds nozzles, RCS blocks, hardpoint mounts, the
// docking collar and the navigation lights AT these positions, so they always sit on the geometry).
//
// Ship-local metres: forward = -Z, up = +Y, right (starboard) = +X, origin at the centre of mass.
// Main-engine exhaust leaves toward +Z; `engines[i].pos` is the centre of the nozzle exit plane.

import type { RGB, ShipLayout, ShipVisualId, V3 } from '../core/types';

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });

const RED: RGB = [1, 0.05, 0.03];
const GREEN: RGB = [0.05, 1, 0.22];
const WHITE: RGB = [1, 1, 1];

const PX = v(1, 0, 0);
const NX = v(-1, 0, 0);
const PY = v(0, 1, 0);
const NY = v(0, -1, 0);

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
  // Corvane CD-7 Wren — arrowhead lifting body, twin side pods, bubble canopy
  wren: {
    id: 'wren',
    length: 16,
    width: 12.1,
    height: 2.9,
    radius: 10.1,
    engines: [
      { pos: v(4.15, 0.12, 8.0), radius: 0.66 },
      { pos: v(-4.15, 0.12, 8.0), radius: 0.66 },
    ],
    rcs: [
      ...both([{ pos: v(1.45, 0.0, -5.5), dir: PX }], flipDir),
      { pos: v(0, 0.66, -5.5), dir: PY },
      { pos: v(0, -0.5, -5.5), dir: NY },
      ...both([{ pos: v(5.0, 0.12, 2.5), dir: PX }], flipDir),
      ...both([{ pos: v(4.15, 0.95, 5.2), dir: PY }]),
      ...both([{ pos: v(4.15, -0.71, 5.2), dir: NY }]),
    ],
    hardpoints: both([{ pos: v(1.6, -0.98, -0.6), size: 1 }]),
    dockingPort: { pos: v(0, 1.72, 1.15), dir: PY },
    cockpit: v(0, 1.3, -3.35),
    chaseCam: { distance: 34, height: 8 },
    lights: navLights(v(6.02, 0.39, 6.05), v(0, 1.02, 6.5), [{ pos: v(0, -0.86, 0.5), color: RED, blink: 2.2 }]),
  },
} as unknown as Record<ShipVisualId, ShipLayout>;
