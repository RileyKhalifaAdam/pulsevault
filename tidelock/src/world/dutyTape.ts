// The duty tape (SIMULATION.md W1-E item 1, §1.3): every tick's applied jet duty of up to DUTY_TAPE_SLOTS craft,
// kept for the renderer so that what it shows does not depend on the frame rate or the frame phase.
//
// WIRING (wave 1; nothing here is called yet):
//   * game/session.ts owns one `DutyTape` next to the event ring. In the 120 Hz tick loop (W1-A), right after the
//     world step that wrote `c.jetDuty` of craft c (dynamics.ts integrateCraft, the `copy duty into c.jetDuty` line
//     of jets.ts's WIRING), for each craft that has a puff slot (slot 0 = player, 1..3 the nearest others within
//     3 km): `tapeRecord(tape, slot, c.jetDuty, c.jets.length, world.tick)`. O(jets) per tick, no allocation.
//   * After a load, a slot reassignment or a craft leaving range: `tapeReset(tape, slot, c.jetDuty, n, world.tick)`
//     (seeds the duty BEFORE the next recorded tick, so the first edge after a load is kept).
//   * The render side reads it once per frame: PuffPool.consume(slot, craft, jets, tape) (render/space/plumeCore.ts).
//   * Contract: OUTPUT ONLY, like the event ring (world/events.ts). Never saved, never read by the world, so it cannot
//     change the simulation; its loader default is an empty tape (createDutyTape()).
//
// Tick k is the step that ended at k·Q and covered [(k − 1)·Q, k·Q]; duty[j] is what jet j applied over it.

/** Craft slots (player + 3) and the most jets a slot can hold (jets.ts edge masks stop at 31). */
export const DUTY_TAPE_SLOTS = 4;
export const DUTY_TAPE_JETS = 32;
/** Ticks kept per slot: 0.53 s, ≥ 16 frames at 30 fps. A longer stall keeps the latest ones. */
export const DUTY_TAPE_LEN = 64;

export interface DutyTape {
  /** Per slot: the latest recorded tick (−1: nothing), the count recorded since the last reset, the reset epoch. */
  readonly last: Float64Array;
  readonly count: Float64Array;
  readonly epoch: Float64Array;
  readonly jets: Int32Array;
  /** Per slot the duty in force before the first recorded tick of this epoch (the seed). */
  readonly seed: Float64Array;
  /** Per slot, a ring of DUTY_TAPE_LEN ticks × DUTY_TAPE_JETS duties; entry of tick k at (k mod LEN). */
  readonly duty: Float64Array;
}

export function createDutyTape(): DutyTape {
  return {
    last: new Float64Array(DUTY_TAPE_SLOTS).fill(-1),
    count: new Float64Array(DUTY_TAPE_SLOTS),
    epoch: new Float64Array(DUTY_TAPE_SLOTS),
    jets: new Int32Array(DUTY_TAPE_SLOTS),
    seed: new Float64Array(DUTY_TAPE_SLOTS * DUTY_TAPE_JETS),
    duty: new Float64Array(DUTY_TAPE_SLOTS * DUTY_TAPE_LEN * DUTY_TAPE_JETS),
  };
}

function checkSlot(slot: number): void {
  if (!(slot >= 0 && slot < DUTY_TAPE_SLOTS) || slot !== (slot | 0)) throw new RangeError(`duty tape slot ${slot} (0..${DUTY_TAPE_SLOTS - 1})`);
}

const clampDuty = (d: number): number => (d > 0 ? (d < 1 ? d : 1) : 0); // NaN → 0

/** Start a new epoch for `slot`: `duty` was in force at the end of tick `tick` (nothing recorded yet). */
export function tapeReset(t: DutyTape, slot: number, duty: ArrayLike<number> | null, n: number, tick: number): void {
  checkSlot(slot);
  const m = n < DUTY_TAPE_JETS ? n : DUTY_TAPE_JETS;
  t.last[slot] = tick;
  t.count[slot] = 0;
  t.epoch[slot]++;
  t.jets[slot] = m;
  const o = slot * DUTY_TAPE_JETS;
  for (let j = 0; j < DUTY_TAPE_JETS; j++) t.seed[o + j] = duty && j < m ? clampDuty(duty[j]) : 0;
}

/**
 * Record tick `tick`'s applied duties. A tick that does not follow the last one (a load to an earlier tick, a skip)
 * starts a new epoch seeded with this duty, so no edge is invented across the gap.
 */
export function tapeRecord(t: DutyTape, slot: number, duty: ArrayLike<number>, n: number, tick: number): void {
  checkSlot(slot);
  const m = n < DUTY_TAPE_JETS ? n : DUTY_TAPE_JETS;
  if (t.last[slot] < 0 || tick !== t.last[slot] + 1 || m !== t.jets[slot]) {
    tapeReset(t, slot, duty, m, tick);
    return;
  }
  const o = (slot * DUTY_TAPE_LEN + (tick % DUTY_TAPE_LEN)) * DUTY_TAPE_JETS;
  for (let j = 0; j < m; j++) t.duty[o + j] = clampDuty(duty[j]);
  t.last[slot] = tick;
  t.count[slot]++;
}

/** Offset of tick k's duties in `t.duty` (k must be one of the last min(count, LEN) recorded ticks). */
export function tapeAt(slot: number, k: number): number {
  return (slot * DUTY_TAPE_LEN + (k % DUTY_TAPE_LEN)) * DUTY_TAPE_JETS;
}
