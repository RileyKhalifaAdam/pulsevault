// W2-E item 8 — the boot magnets' wrist switch (D8, default yes: built, magnets on). Pure, deterministic,
// allocation-free, SI units, plain-JSON state. The switch drives the coils; the field follows the coil current with
// its L/R time constant (an exact first-order closed form per step), so switching off is a 50 ms release, not a
// snap, and the magnet pull, the well and the boots' grip all scale with it.
//
// WIRING (wave 2):
// - The device: W2-D hub item 5 builds "the wrist boot-magnet switch W2-E needs (D8): a body-mounted device of reach
//   'arm'" in devices.ts; its action calls toggleBoots(crew.boots) (or setBoots). It is always within reach (worn).
// - crew.ts, once per tick before the boot contact: stepBootSwitch(crew.boots, h) (h = Q at 1×, the quantum under
//   warp: the closed form is exact at any h). Then every body.ts magnet use goes through the level:
//   bootMagnetSwitched(boots, gap) replaces bootMagnet(gap) (×2 boots as today), bootWellSwitched(boots, gap)
//   replaces bootWell(gap) in pushPeel and the escape test, bootContact's catch only when bootsCanCatch(boots)
//   (unmagnetised soles do not stick in zero g; they still stand in gravity, through the felt load in
//   bootNormalLoad), and transitions.ts legsDef(bootsHeld && bootsCanCatch(boots)).
// - Switching off while gripped in zero g: the magnet pull falls to 0 within ~0.2 s; bootImpulse's cap then lets
//   the soles lift on the next jump, and the body floats ('bootOff' event, as today).
// - Save: saveBootSwitch / loadBootSwitch (loader default: on, level 1 — today's always-on magnets).
// - §1.4: none (crew-local state). Reads nothing from the craft.

import { bootMagnet, bootWell, Q } from './body';

/** Coil L/R time constant, s (a small electromagnet). */
export const BOOT_COIL_TAU = 0.05;
/** Field level below which the soles no longer catch on the deck. */
export const BOOT_CATCH_LEVEL = 0.5;

export interface BootSwitchState {
  /** The switch position. */
  on: boolean;
  /** The magnet field as a fraction of full (0..1), following the switch with BOOT_COIL_TAU. */
  level: number;
}

export const createBootSwitch = (on = true): BootSwitchState => ({ on, level: on ? 1 : 0 });
export function toggleBoots(b: BootSwitchState): boolean { b.on = !b.on; return b.on; }
export function setBoots(b: BootSwitchState, on: boolean): void { b.on = on; }

const E_Q = Math.exp(-Q / BOOT_COIL_TAU);
let eH = -1, eV = 0;

/** Advance the field over h: level → target + (level − target)·e^(−h/τ), exact; settles exactly once within 1e-9. */
export function stepBootSwitch(b: BootSwitchState, h: number): void {
  if (!(h > 0)) return;
  const tgt = b.on ? 1 : 0;
  if (b.level === tgt) return;
  let e: number;
  if (h === Q) e = E_Q; else { if (eH !== h) { eV = Math.exp(-h / BOOT_COIL_TAU); eH = h; } e = eV; }
  const l = tgt + (b.level - tgt) * e;
  b.level = l - tgt < 1e-9 && l - tgt > -1e-9 ? tgt : l;
}

/** One boot's magnet pull at sole gap g with the switch's field, N. */
export const bootMagnetSwitched = (b: BootSwitchState, gap: number): number => b.level * bootMagnet(gap);
/** Work to pull the boots out of the magnet well at gap g with the switch's field, J. */
export const bootWellSwitched = (b: BootSwitchState, gap: number, boots = 2): number => b.level * bootWell(gap, boots);
/** Do the soles still catch on the deck (zero-g magnet catch)? */
export const bootsCanCatch = (b: BootSwitchState): boolean => b.level >= BOOT_CATCH_LEVEL;

export const saveBootSwitch = (b: BootSwitchState): BootSwitchState => ({ on: b.on, level: b.level });
/** Loader default: on at full field (today's magnets are always on). */
export function loadBootSwitch(data: unknown): BootSwitchState {
  const o = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const on = o.on === false ? false : true;
  const l = typeof o.level === 'number' && Number.isFinite(o.level) ? o.level : on ? 1 : 0;
  return { on, level: l < 0 ? 0 : l > 1 ? 1 : l };
}
