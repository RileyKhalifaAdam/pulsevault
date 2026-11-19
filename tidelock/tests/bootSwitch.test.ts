// W2-E item 8 (D8): the wrist boot-magnet switch (src/world/bootSwitch.ts) — the field follows the switch with the
// coil's time constant (no snap), the magnet pull and well scale with it, save → load.
import { describe, expect, it } from 'vitest';
import { bootMagnet, bootWell } from '../src/world/body';
import {
  BOOT_COIL_TAU, bootMagnetSwitched, bootsCanCatch, bootWellSwitched, createBootSwitch, loadBootSwitch, saveBootSwitch, stepBootSwitch, toggleBoots,
} from '../src/world/bootSwitch';

const Q = 1 / 120;

describe('boot magnet switch (D8)', () => {
  it('switching off releases the field with the coil time constant; on restores it the same way', () => {
    const b = createBootSwitch();
    expect(b.level).toBe(1);
    expect(toggleBoots(b)).toBe(false);
    for (let k = 0; k < 6; k++) stepBootSwitch(b, Q); // 50 ms = τ
    expect(b.level).toBeCloseTo(Math.exp(-6 * Q / BOOT_COIL_TAU), 12);
    expect(bootMagnetSwitched(b, 0)).toBeCloseTo(b.level * bootMagnet(0), 12);
    expect(bootWellSwitched(b, 0)).toBeCloseTo(b.level * bootWell(0), 12);
    for (let k = 0; k < 240; k++) stepBootSwitch(b, Q);
    expect(b.level).toBe(0);
    expect(bootsCanCatch(b)).toBe(false);
    // one warp quantum is exact at any h
    const c = createBootSwitch(false);
    toggleBoots(c); stepBootSwitch(c, 0.03);
    expect(c.level).toBeCloseTo(1 - Math.exp(-0.03 / BOOT_COIL_TAU), 12);
  });

  it('save → load continues bit-identically; old saves load with the magnets on', () => {
    const a = createBootSwitch();
    toggleBoots(a); for (let k = 0; k < 3; k++) stepBootSwitch(a, Q);
    const b = loadBootSwitch(JSON.parse(JSON.stringify(saveBootSwitch(a))));
    for (let k = 0; k < 9; k++) { stepBootSwitch(a, Q); stepBootSwitch(b, Q); }
    expect(b).toEqual(a);
    expect(loadBootSwitch(undefined)).toEqual({ on: true, level: 1 });
  });
});
