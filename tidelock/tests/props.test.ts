// Loose objects as rigid bodies in the ship's frame (src/world/props.ts).
import { describe, expect, it } from 'vitest';
import type { Quat, V3 } from '../src/core/types';
import type { InteriorLayout } from '../src/data/interiors';
import { PROP_TYPES, PROPS, type PropDef, type PropType } from '../src/data/props';
import { createCrew, createShipMotion, stepCrew, type ShipMotion } from '../src/world/crew';
import {
  CREW_MASS, createPropsState, definePropsLayout, grab, loadPropsState, moveGrab, pickProp, propViews, release, savePropsState,
  stepProps, type PropsState,
} from '../src/world/props';

const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const Q0: Quat = { x: 0, y: 0, z: 0, w: 1 };
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const motion = (ax = 0, ay = 0, az = 0, wx = 0, wy = 0, wz = 0): ShipMotion => {
  const m = createShipMotion();
  m.a.x = ax; m.a.y = ay; m.a.z = az; m.w.x = wx; m.w.y = wy; m.w.z = wz;
  return m;
};
const run = (s: PropsState, m: ShipMotion, seconds: number, dt = 1 / 60): void => {
  for (let t = 0; t < seconds - 1e-9; t += dt) stepProps(s, m, null, dt);
};

/** A 4 m × 2.4 m × 4 m box room, nothing in it. */
const BOX: InteriorLayout = {
  shipId: 'wren',
  rooms: [{ id: 'room', name: 'Room', box: { min: v3(-2, -1, -2), max: v3(2, 1.4, 2) } }],
  doors: [], solids: [], windows: [], interactables: [],
  spawn: { pos: v3(0, -1, 1), yaw: 0 }, helmEye: v3(), bunkEye: v3(), tableEye: v3(),
};
const def = (id: string, type: PropType, pos: V3, stow: PropDef['stow'] = 'loose', holdN = 0): PropDef => ({ id, type, room: 'room', pos, rot: Q0, stow, holdN });
definePropsLayout('t-box', BOX, [
  def('a', 'mug', v3(-0.5, 0, 0)),
  def('b', 'mug', v3(0.5, 0.02, 0)),
  def('tab', 'tablet', v3(0, 0.8, 1)),
  def('crate', 'crateSmall', v3(-1, -0.798, -1)),
]);
const body = (s: PropsState, id: string) => s.bodies.find((b) => b.id === id)!;
const set = (s: PropsState, id: string, p: V3, v: V3 = v3(), w: V3 = v3()): void => {
  const b = body(s, id);
  b.p = { ...p }; b.v = { ...v }; b.w = { ...w }; b.asleep = false; b.stowed = false;
};

/** Angular momentum of a box-shaped body in ship axes (non-rotating ship), and its rotational energy. */
function angular(s: PropsState, id: string): { L: V3; E: number } {
  const b = body(s, id), t = PROP_TYPES[body(s, id).id === 'tab' ? 'tablet' : 'mug'], sh = t.shape;
  if (sh.kind !== 'box') throw new Error('box only');
  const m = t.mass, h = sh.half, I = [(m / 3) * (h.y ** 2 + h.z ** 2), (m / 3) * (h.x ** 2 + h.z ** 2), (m / 3) * (h.x ** 2 + h.y ** 2)];
  const { x, y, z, w } = b.q;
  const R = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
  const om = [b.w.x, b.w.y, b.w.z];
  const wb = [0, 1, 2].map((k) => R[0][k] * om[0] + R[1][k] * om[1] + R[2][k] * om[2]);
  const Lb = wb.map((x2, k) => I[k] * x2);
  const L = [0, 1, 2].map((r) => R[r][0] * Lb[0] + R[r][1] * Lb[1] + R[r][2] * Lb[2]);
  return { L: v3(L[0], L[1], L[2]), E: 0.5 * (wb[0] * Lb[0] + wb[1] * Lb[1] + wb[2] * Lb[2]) };
}

describe('props in free fall', () => {
  it('a released mug keeps its velocity and spin', () => {
    const s = createPropsState('t-box')!;
    set(s, 'a', v3(0, 0, 0), v3(0.5, 0.2, -0.1), v3(0, 3, 0));
    run(s, motion(), 1);
    const a = body(s, 'a');
    expect(a.v.x).toBe(0.5); expect(a.v.y).toBe(0.2); expect(a.v.z).toBe(-0.1);
    expect(Math.abs(a.p.x - 0.5) + Math.abs(a.p.y - 0.2) + Math.abs(a.p.z + 0.1)).toBeLessThan(1e-9);
    expect(len({ x: a.w.x, y: a.w.y - 3, z: a.w.z })).toBeLessThan(1e-9);
  });

  it('a tumbling tablet conserves angular momentum and energy (free rigid body)', () => {
    const s = createPropsState('t-box')!;
    set(s, 'tab', v3(0, 0.2, 0), v3(), v3(0.05, 0.1, 6)); // near the intermediate axis: it flips
    const before = angular(s, 'tab');
    let flip = 1;
    for (let i = 0; i < 180; i++) {
      stepProps(s, motion(), null, 1 / 60);
      const q = body(s, 'tab').q;
      flip = Math.min(flip, 1 - 2 * (q.x * q.x + q.y * q.y)); // the body's z axis against L (≈ ship +Z)
    }
    const after = angular(s, 'tab');
    expect(len({ x: after.L.x - before.L.x, y: after.L.y - before.L.y, z: after.L.z - before.L.z }) / len(before.L)).toBeLessThan(1e-9);
    expect(Math.abs(after.E / before.E - 1)).toBeLessThan(0.02);
    expect(flip).toBeLessThan(-0.9); // it really flips over (the intermediate-axis instability)
  });

  it('bounces off a wall with its restitution', () => {
    const s = createPropsState('t-box')!;
    set(s, 'a', v3(0, 0, 0), v3(0, 0, 1));
    run(s, motion(), 3);
    const a = body(s, 'a');
    expect(a.v.z).toBeCloseTo(-PROP_TYPES.mug.restitution, 2);
    expect(Math.hypot(a.v.x, a.v.y)).toBeLessThan(0.01);
  });

  it('conserves momentum in a prop-prop collision', () => {
    const s = createPropsState('t-box')!;
    set(s, 'a', v3(-0.5, 0, 0), v3(1, 0.05, 0));
    set(s, 'b', v3(0.5, 0.03, 0), v3(-0.6, 0, 0.02));
    const m = PROP_TYPES.mug.mass;
    const p0 = v3(m * 0.4, m * 0.05, m * 0.02);
    run(s, motion(), 0.8);
    const a = body(s, 'a'), b = body(s, 'b');
    expect(a.v.x).toBeLessThan(0.9); // they hit
    expect(Math.abs(m * (a.v.x + b.v.x) - p0.x) + Math.abs(m * (a.v.y + b.v.y) - p0.y) + Math.abs(m * (a.v.z + b.v.z) - p0.z)).toBeLessThan(1e-9);
    expect(len(a.w) + len(b.w)).toBeGreaterThan(0.01); // off-centre: they spin
  });

  it('the pilot pushes objects and objects push the pilot, momentum shared', () => {
    const s = createPropsState('t-box')!;
    set(s, 'b', v3(0.8, 0.2, 0));
    const crew = createCrew(BOX, 'x');
    crew.boots = false; crew.gripped = false; crew.posture = 'floating';
    crew.pos = v3(0, -0.5, 0); crew.vel = v3(0.5, 0, 0);
    const mm = motion(), mug = PROP_TYPES.mug.mass;
    const p0 = CREW_MASS * 0.5;
    for (let i = 0; i < 60; i++) { stepCrew(crew, BOX, mm, { moveX: 0, moveZ: 0 }, 1 / 60); stepProps(s, mm, crew, 1 / 60); }
    const b = body(s, 'b');
    expect(b.v.x).toBeGreaterThan(0.6); // knocked ahead of the pilot
    expect(crew.vel.x).toBeLessThan(0.5);
    expect(Math.abs(CREW_MASS * crew.vel.x + mug * b.v.x - p0)).toBeLessThan(1e-6);
  });
});

describe('props under thrust', () => {
  it('full main drive: loose objects slide aft and come to rest against bulkheads and furniture', () => {
    const s = createPropsState('wren')!;
    const z0 = new Map(s.bodies.map((b) => [b.id, b.p.z]));
    run(s, motion(0, 0, -12), 12);
    let moved = 0;
    for (const b of s.bodies) {
      expect(b.p.z).toBeGreaterThan(z0.get(b.id)! - 0.05); // nothing goes forward
      if (b.p.z > z0.get(b.id)! + 0.3) moved++;
      if (!b.stowed) {
        expect(len(b.v)).toBeLessThan(0.05); // at rest...
        expect(b.asleep).toBe(true); // ...held up by something against 12 m/s²
      }
    }
    expect(moved).toBeGreaterThanOrEqual(8);
    for (const id of ['crate-L1', 'crate-L2', 'crate-S1', 'crate-S2', 'toolbox', 'bottle-galley', 'helmet', 'plant']) expect(body(s, id).stowed).toBe(true);
    for (const id of ['mug-galley-1', 'mug-table-1', 'tablet-port', 'food-1']) expect(body(s, id).stowed).toBe(false);
  });

  it('a magnetically held mug stays put under RCS and breaks free under main thrust', () => {
    const s = createPropsState('wren')!;
    const p0 = { ...body(s, 'mug-table-1').p };
    run(s, motion(1, 0, -1), 5); // ≈ 1.4 m/s² of RCS
    expect(body(s, 'mug-table-1').stowed).toBe(true);
    expect(body(s, 'mug-table-1').p).toEqual(p0);
    run(s, motion(0, 0, -12), 0.5);
    expect(body(s, 'mug-table-1').stowed).toBe(false);
    expect(body(s, 'mug-table-1').p.z).toBeGreaterThan(p0.z + 0.2);
  });

  it('strapped crates never break free below their rating', () => {
    const s = createPropsState('wren')!;
    run(s, motion(0, 0, -24.5), 2); // 80 kg × 24.5 = 1960 N < 2000 N
    for (const id of ['crate-L1', 'crate-L2', 'crate-S1', 'crate-S2']) expect(body(s, id).stowed).toBe(true);
    run(s, motion(0, 0, -25.5), 0.1);
    expect(body(s, 'crate-L1').stowed).toBe(false);
    expect(body(s, 'crate-S1').stowed).toBe(true); // 25 kg × 25.5 = 638 N < 1000 N
  });

  it('a spinning ship flings loose objects outward with the centrifugal acceleration', () => {
    const s = createPropsState('t-box')!;
    set(s, 'a', v3(1.0, 0.2, 0));
    const W = 0.5;
    run(s, motion(0, 0, 0, 0, 0, W), 0.1, 1 / 100);
    const a = body(s, 'a');
    const r = Math.hypot(1.0, 0.2), radial = (a.v.x * 1.0 + a.v.y * 0.2) / r; // Coriolis is across the motion
    expect(radial / 0.1 / (W * W * r)).toBeCloseTo(1, 2);
    run(s, motion(0, 0, 0, 0, 0, W), 8);
    expect(Math.hypot(a.p.x, a.p.y)).toBeGreaterThan(1.8); // pinned in the outer corner
    expect(len(a.v)).toBeLessThan(0.05);
  });
});

describe('hands', () => {
  it('grab, carry and throw: a mug follows the hand, a crate lags, the throw leaves at the release velocity', () => {
    const s = createPropsState('t-box')!;
    const eye = v3(0, 0.2, 0.4);
    expect(pickProp(s, eye, v3(-0.5, -0.2, -0.4), 1)).toBe('a');
    expect(grab(s, 'a', v3(-0.5, 2, 0), eye)).toBe(false); // out of reach
    expect(grab(s, 'a', v3(-0.5, 0, 0), eye)).toBe(true);
    const hand = v3(-0.5, 0, 0), mm = motion();
    for (let i = 0; i < 60; i++) { hand.x += 0.5 / 60; hand.y += 0.2 / 60; moveGrab(s, hand, 1 / 60); stepProps(s, mm, null, 1 / 60); }
    const a = body(s, 'a');
    expect(len({ x: a.p.x - hand.x, y: a.p.y - hand.y, z: a.p.z - hand.z })).toBeLessThan(0.03);
    expect(propViews(s).find((p) => p.id === 'a')!.grabbed).toBe(true);
    expect(release(s, v3(2, 0, -1))).toBe(true);
    expect(a.v).toEqual(v3(2, 0, -1));
    const x0 = a.p.x;
    stepProps(s, mm, null, 0.1);
    expect(a.p.x - x0).toBeCloseTo(0.2, 6);
    // the crate: 25 kg on a 160 N arm
    const c = body(s, 'crate');
    set(s, 'crate', v3(-1, 0, -1)); // floating
    const ceye = v3(-1, 0.3, -0.5), ch = v3(-1, 0, -1);
    expect(grab(s, 'crate', ch, ceye)).toBe(true);
    ch.x += 0.35; moveGrab(s, ch, 1 / 60);
    for (let i = 0; i < 6; i++) { moveGrab(s, ch, 1 / 60); stepProps(s, mm, null, 1 / 60); }
    expect(ch.x - c.p.x).toBeGreaterThan(0.2); // still well behind after 0.1 s
    for (let i = 0; i < 180; i++) { moveGrab(s, ch, 1 / 60); stepProps(s, mm, null, 1 / 60); }
    expect(Math.abs(ch.x - c.p.x)).toBeLessThan(0.05); // got there
    release(s, v3(5, 0, 0));
    expect(c.v.x).toBeLessThan(1.2); // 24 N·s of throw cannot hurl 25 kg
  });
});

describe('state and cost', () => {
  it('save → load → continue is identical', () => {
    const s = createPropsState('wren')!;
    run(s, motion(0, 0, -12), 1.5);
    run(s, motion(0.8, 0, 0, 0, 0.05, 0), 0.5);
    const saved = JSON.stringify(savePropsState(s));
    const t = loadPropsState(saved)!;
    expect(t).not.toBeNull();
    run(s, motion(0.8, 0, 0, 0, 0.05, 0), 2);
    run(t, motion(0.8, 0, 0, 0, 0.05, 0), 2);
    expect(JSON.stringify(t)).toBe(JSON.stringify(s));
    expect(loadPropsState({ layoutId: 'nope' })).toBeNull();
    expect(loadPropsState('{bad')).toBeNull();
  });

  it('a 10-second run of all props costs under 5 ms of CPU per simulated second', () => {
    expect(PROPS.wren!.length).toBeGreaterThanOrEqual(24);
    const scenario = (s: PropsState): number => {
      let subs = 0;
      const thrust = motion(0, 0, -12), rcs = motion(0.9, 0.3, 0, 0, 0.02, 0), coast = motion(0, 0, 0, 0, 0.02, 0);
      for (let i = 0; i < 600; i++) {
        const m = i < 120 ? coast : i < 300 ? thrust : i < 420 ? rcs : coast;
        subs += stepProps(s, m, null, 1 / 60);
      }
      return subs;
    };
    scenario(createPropsState('wren')!); // warm the JIT (the game runs this every frame)
    scenario(createPropsState('wren')!);
    const s = createPropsState('wren')!;
    const t0 = performance.now();
    const subs = scenario(s);
    const ms = performance.now() - t0;
    console.log(`props: 10 s simulated in ${ms.toFixed(1)} ms (${(ms / 10).toFixed(2)} ms per s, ${(ms / 600).toFixed(3)} ms per frame), ${subs} sub-steps`);
    expect(ms / 10).toBeLessThan(5);
  });
});
