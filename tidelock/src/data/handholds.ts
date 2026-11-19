// Handholds as pure data (W2-E item 1, `body-handholds-grab-ship`): rails, handles, console and counter edges and
// door frames a floating body can grab. Ship-local axes (forward −Z, up +Y, right +X), metres. No three.js.
//
// Each hold is a straight bar from `a` to `b` with grip radius `r` (a point handle has a = b). The physics
// (src/world/hands.ts) grips the closest point on the bar; a 'rail' or 'edge' lets the hand slide along it.
//
// WIRING (wave 2):
// - crew.ts (or session.ts) builds once per layout: holds = compileHandholds(handholdsFor(layout)) and keeps the
//   Float64Array next to the compiled collision boxes. Nothing here runs per tick.
// - render (W2-F / the cockpit owner): the cockpit pillar handles and the overhead rails exist in
//   render/space/cockpit.ts (same coordinates as below). The CORRIDOR RAILS and the door-frame grab bars are new
//   physics holds that nothing draws yet: the interior renderer should draw them from this table (a 0.012 m bar).
// - Reads: data/interiors.ts layouts (doors, solids). Writes nothing. No §1.4 contract field.

import type { V3 } from '../core/types';
import type { InteriorLayout } from './interiors';

export type HandholdKind = 'rail' | 'handle' | 'edge' | 'frame';
export const HOLD_KIND_CODE: Readonly<Record<HandholdKind, number>> = { rail: 0, handle: 1, edge: 2, frame: 3 };

export interface Handhold {
  id: string;
  kind: HandholdKind;
  room: string;
  a: V3;
  b: V3;
  /** Grip radius (bar radius), m. */
  r: number;
}

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });

/**
 * The Wren's explicit holds. Cockpit numbers follow render/space/cockpit.ts: pillar handles at x = ±(1.697 − 0.17),
 * z = console.min.z + 0.12, the rubber grip y 0.30–0.42 above the console top (y 0) on a bar y 0.12–0.60; the
 * overhead rails at x ±1.06, y = 1.397 − 0.09, z −14.25…−13.05; the side consoles' inner top edges (x ±1.25,
 * y −0.25); the main console's aft top edge (y 0, z −14.15).
 */
const WREN_HOLDS: Handhold[] = [
  { id: 'pillar-port', kind: 'handle', room: 'cockpit', a: v(-1.527, 0.12, -14.88), b: v(-1.527, 0.6, -14.88), r: 0.0135 },
  { id: 'pillar-stbd', kind: 'handle', room: 'cockpit', a: v(1.527, 0.12, -14.88), b: v(1.527, 0.6, -14.88), r: 0.0135 },
  { id: 'overhead-port', kind: 'rail', room: 'cockpit', a: v(-1.06, 1.307, -14.25), b: v(-1.06, 1.307, -13.05), r: 0.0115 },
  { id: 'overhead-stbd', kind: 'rail', room: 'cockpit', a: v(1.06, 1.307, -14.25), b: v(1.06, 1.307, -13.05), r: 0.0115 },
  { id: 'console-port-edge', kind: 'edge', room: 'cockpit', a: v(-1.25, -0.25, -14.1), b: v(-1.25, -0.25, -12.65), r: 0.02 },
  { id: 'console-stbd-edge', kind: 'edge', room: 'cockpit', a: v(1.25, -0.25, -14.1), b: v(1.25, -0.25, -12.65), r: 0.02 },
  { id: 'console-edge', kind: 'edge', room: 'cockpit', a: v(-1.6, 0.0, -14.15), b: v(1.6, 0.0, -14.15), r: 0.02 },
  // corridor rails at hip-to-chest height along both walls, broken at the side doors (z −2.0…−1.2, −0.4…0.4)
  { id: 'corr-port-1', kind: 'rail', room: 'corridor', a: v(-0.84, 0.35, -4.4), b: v(-0.84, 0.35, -2.1), r: 0.012 },
  { id: 'corr-port-2', kind: 'rail', room: 'corridor', a: v(-0.84, 0.35, -1.1), b: v(-0.84, 0.35, -0.5), r: 0.012 },
  { id: 'corr-port-3', kind: 'rail', room: 'corridor', a: v(-0.84, 0.35, 0.5), b: v(-0.84, 0.35, 2.8), r: 0.012 },
  { id: 'corr-stbd-1', kind: 'rail', room: 'corridor', a: v(0.84, 0.35, -4.4), b: v(0.84, 0.35, -2.1), r: 0.012 },
  { id: 'corr-stbd-2', kind: 'rail', room: 'corridor', a: v(0.84, 0.35, -1.1), b: v(0.84, 0.35, -0.5), r: 0.012 },
  { id: 'corr-stbd-3', kind: 'rail', room: 'corridor', a: v(0.84, 0.35, 0.5), b: v(0.84, 0.35, 2.8), r: 0.012 },
  // furniture edges in the lounge and cabins
  { id: 'galley-edge', kind: 'edge', room: 'lounge', a: v(-2.55, -0.08, -9.8), b: v(-2.55, -0.08, -5.7), r: 0.02 },
  { id: 'table-edge-port', kind: 'edge', room: 'lounge', a: v(0.55, -0.3, -8.3), b: v(0.55, -0.3, -6.7), r: 0.02 },
  { id: 'bed-port-edge', kind: 'edge', room: 'cabin-port', a: v(-2.0, -0.45, -4.4), b: v(-2.0, -0.45, -2.4), r: 0.02 },
  { id: 'bed-stbd-edge', kind: 'edge', room: 'cabin-stbd', a: v(2.0, -0.45, -4.4), b: v(2.0, -0.45, -2.4), r: 0.02 },
  { id: 'workbench-edge', kind: 'edge', room: 'engineering', a: v(1.8, -0.05, 10.5), b: v(1.8, -0.05, 11.7), r: 0.02 },
];

/** Door-frame grab bars from the layout's doors: both jambs and the lintel of every opening (inset 2 cm). */
export function doorFrameHolds(layout: InteriorLayout): Handhold[] {
  const out: Handhold[] = [];
  for (const d of layout.doors) {
    const b = d.box, ex = b.max.x - b.min.x, ez = b.max.z - b.min.z;
    const y0 = b.min.y + 0.3, y1 = b.max.y - 0.02;
    if (ex >= ez) {
      // the opening spans x; the wall is normal to z
      const z = 0.5 * (b.min.z + b.max.z), x0 = b.min.x + 0.02, x1 = b.max.x - 0.02;
      out.push({ id: `${d.id}-jamb-p`, kind: 'frame', room: d.a, a: v(x0, y0, z), b: v(x0, y1, z), r: 0.02 });
      out.push({ id: `${d.id}-jamb-s`, kind: 'frame', room: d.a, a: v(x1, y0, z), b: v(x1, y1, z), r: 0.02 });
      out.push({ id: `${d.id}-lintel`, kind: 'frame', room: d.a, a: v(x0, y1, z), b: v(x1, y1, z), r: 0.02 });
    } else {
      const x = 0.5 * (b.min.x + b.max.x), z0 = b.min.z + 0.02, z1 = b.max.z - 0.02;
      out.push({ id: `${d.id}-jamb-f`, kind: 'frame', room: d.a, a: v(x, y0, z0), b: v(x, y1, z0), r: 0.02 });
      out.push({ id: `${d.id}-jamb-a`, kind: 'frame', room: d.a, a: v(x, y0, z1), b: v(x, y1, z1), r: 0.02 });
      out.push({ id: `${d.id}-lintel`, kind: 'frame', room: d.a, a: v(x, y1, z0), b: v(x, y1, z1), r: 0.02 });
    }
  }
  return out;
}

/** Every hold of a layout (the Wren's explicit list plus its door frames). */
export function handholdsFor(layout: InteriorLayout): Handhold[] {
  const explicit = layout.shipId === 'wren' ? WREN_HOLDS : [];
  return [...explicit, ...doorFrameHolds(layout)];
}

/** Stride of the compiled table: ax, ay, az, bx, by, bz, r, kind code. */
export const HOLD_STRIDE = 8;

/** Compile holds into one typed array (once per layout; allocates). */
export function compileHandholds(holds: readonly Handhold[]): Float64Array {
  const t = new Float64Array(holds.length * HOLD_STRIDE);
  holds.forEach((h, i) => {
    const o = i * HOLD_STRIDE;
    t[o] = h.a.x; t[o + 1] = h.a.y; t[o + 2] = h.a.z; t[o + 3] = h.b.x; t[o + 4] = h.b.y; t[o + 5] = h.b.z;
    t[o + 6] = h.r; t[o + 7] = HOLD_KIND_CODE[h.kind];
  });
  return t;
}
