// The event ring (docs/SIMULATION.md §1.4): a fixed ring of 256 preallocated records that the world writes
// when something discrete happens (a contact, a jet edge, a boot clamp, a detent) and that the client drains
// once per frame for sound and other senses.
//
// Contract
// - OUTPUT ONLY. Never saved, never read by the world: draining cannot change the simulation, so determinism
//   is unaffected. The world may emit from any step; wave 1 exposes `session.drainEvents(cb)` = `drain(ring, cb)`.
// - Allocation-free: `emitEvent` copies scalars and the two vectors' components into a preallocated record.
//   Pass `null` for a vector that does not apply (it is written as 0, 0, 0).
// - When the reader falls behind by more than 256 records the oldest are overwritten (`dropped` counts them);
//   the writer never blocks and never grows the ring.
// - Records are reused: a drain callback reads the record and must not keep it.
// - No three.js, no DOM: this file runs under vitest in plain node like the rest of src/world.
//
// Field meanings per kind (SI units; ship-local axes for pos / normal; t is sim time, s):
//   contact  a, b  bodies (prop index into the ship's PROPS list, or BODY_SHIP / BODY_CREW)
//            J     normal impulse of the contact, N·s       vn  normal approach speed, m/s (> 0 closing)
//            pos   contact point                            normal  contact normal, from b toward a
//            matA, matB  material codes (MAT below) of the two touching surfaces
//   slide    a, b  as contact (one record per sliding or rolling awake body per tick)
//            J     normal force, N                          vn  tangential (slip) speed, m/s
//   jetOn / jetOff   a = jet index (JetDef order), b = craft index; J = thrust of that jet, N; pos = jet position
//   boot / bootOff   a = 0 left, 1 right; J = energy into the deck, J (0: the model default); vn = sole speed
//   detent / toggle / plunger / breaker   a = device index, b = new state; J = mechanism energy, J (0: default)
//   latch / undock / capture   a, b craft indices; J = impulse across the joint, N·s; pos = port position
//   creak    a = skin zone; J = released strain energy, J (written by W2-F/W2-D thermal)

import type { V3 } from '../core/types';

export type EventKind =
  | 'contact'
  | 'slide'
  | 'jetOn'
  | 'jetOff'
  | 'boot'
  | 'bootOff'
  | 'detent'
  | 'toggle'
  | 'plunger'
  | 'latch'
  | 'undock'
  | 'breaker'
  | 'capture'
  | 'creak';

export const EVENT_KINDS: readonly EventKind[] = [
  'contact', 'slide', 'jetOn', 'jetOff', 'boot', 'bootOff', 'detent', 'toggle', 'plunger', 'latch', 'undock',
  'breaker', 'capture', 'creak',
];

/** Body ids that are not props: the ship's own structure (deck, walls, fittings) and the crew body. */
export const BODY_SHIP = -1;
export const BODY_CREW = -2;

/**
 * Surface material codes carried in matA / matB. The physical constants of each (E, ρ, ν, η) live with the
 * sound model (src/audio/materials.ts) until W1-C moves them into src/data/props.ts.
 */
export const MAT = {
  aluminium: 0, // deck panels and structure
  composite: 1, // interior lining panels, crates
  glass: 2,
  foam: 3, // cushions, sofa, bunk mattress
  steel: 4,
  ceramic: 5,
  polymer: 6, // ABS, polycarbonate, copolyester
  card: 7, // books, packaging
  tissue: 8, // the crew body in its clothes
} as const;
export type MaterialCode = (typeof MAT)[keyof typeof MAT];

export const EVENT_RING_SIZE = 256;
const MASK = EVENT_RING_SIZE - 1;

export interface SimEvent {
  kind: EventKind;
  t: number;
  a: number;
  b: number;
  J: number;
  pos: V3;
  normal: V3;
  vn: number;
  matA: number;
  matB: number;
}

export interface EventRing {
  readonly rec: readonly SimEvent[];
  /** Total records ever written (the next write goes to rec[head & 255]). */
  head: number;
  /** Total records consumed or overwritten (the next read is rec[tail & 255]). */
  tail: number;
  /** Records overwritten before they were drained. */
  dropped: number;
}

export function createEventRing(): EventRing {
  const rec: SimEvent[] = [];
  for (let i = 0; i < EVENT_RING_SIZE; i++) {
    rec.push({ kind: 'contact', t: 0, a: 0, b: 0, J: 0, pos: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, vn: 0, matA: 0, matB: 0 });
  }
  return { rec, head: 0, tail: 0, dropped: 0 };
}

/** Write one record. Allocation-free; overwrites the oldest record when the reader has fallen 256 behind. */
export function emitEvent(
  ring: EventRing,
  kind: EventKind,
  t: number,
  a: number,
  b: number,
  J: number,
  pos: V3 | null,
  normal: V3 | null,
  vn: number,
  matA: number,
  matB: number,
): void {
  if (ring.head - ring.tail >= EVENT_RING_SIZE) {
    ring.tail++;
    ring.dropped++;
  }
  const r = ring.rec[ring.head & MASK];
  r.kind = kind;
  r.t = t;
  r.a = a;
  r.b = b;
  r.J = J;
  if (pos) {
    r.pos.x = pos.x; r.pos.y = pos.y; r.pos.z = pos.z;
  } else {
    r.pos.x = 0; r.pos.y = 0; r.pos.z = 0;
  }
  if (normal) {
    r.normal.x = normal.x; r.normal.y = normal.y; r.normal.z = normal.z;
  } else {
    r.normal.x = 0; r.normal.y = 0; r.normal.z = 0;
  }
  r.vn = vn;
  r.matA = matA;
  r.matB = matB;
  ring.head++;
}

/**
 * Hand every pending record to `cb` in emit order, oldest first, then mark them read. `seq` is the record's
 * absolute sequence number (deterministic: the same world gives the same numbers). Returns how many were drained.
 * The record object is reused by later emits: read it inside the callback, do not keep it.
 */
export function drain(ring: EventRing, cb: (e: SimEvent, seq: number) => void): number {
  const end = ring.head;
  let n = 0;
  while (ring.tail < end) {
    const seq = ring.tail;
    ring.tail++;
    cb(ring.rec[seq & MASK], seq);
    n++;
  }
  return n;
}

/** Records waiting to be drained. */
export const pending = (ring: EventRing): number => ring.head - ring.tail;

/** Forget everything pending (a world reset or load). */
export function clearEvents(ring: EventRing): void {
  ring.tail = ring.head;
}
