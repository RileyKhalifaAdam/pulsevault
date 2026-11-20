// The fixed tick (SIMULATION.md §1.3, W1-A tests): the same input log gives the same world, bit for bit, whatever the
// frame rate — 30, 60 and jittered 60 fps — compared at the same tick; under warp the step sequence does not depend
// on the budget, only how far each frame gets; save → load mid-flight → continue is bit-identical.
import { describe, expect, it } from 'vitest';
import type { V3 } from '../src/core/types';
import { createSession, loadSession } from '../src/game/session';
import type { Session } from '../src/game/api';

/** No CPU limit and no wall clock: these runs are about the sequence of steps. */
const FREE = { budgetMs: 1e9, unitMs: 1e-9, now: () => 0 };
const flat = (th: number): V3 => ({ x: Math.sin(th), y: 0, z: -Math.cos(th) });

interface Ev { tick: number; act: (s: Session) => void }

/** The pilot standing at the galley counter (port side of the lounge), facing it, boots on. */
function galley(opts = FREE): Session {
  const s0 = createSession(opts);
  const data = JSON.parse(s0.save()) as { session: { crew: { pos: V3; vel: V3; yaw: number; pitch: number } } };
  const c = data.session.crew;
  c.pos.x = -2.2; c.pos.z = -8.9; c.vel.x = c.vel.y = c.vel.z = 0; c.yaw = Math.PI / 2; c.pitch = 0;
  return loadSession(JSON.stringify(data), opts)!;
}
const toward = (s: Session, id: string): V3 => {
  const e = s.crew().eye, p = s.props().find((x) => x.id === id)!.pos;
  return { x: p.x - e.x, y: p.y - e.y, z: p.z - e.z };
};

/** 60 s: the prograde hold turns the ship, a mug is unclipped, carried and thrown, the drive burns 5 s, then a coast. */
const LOG: Ev[] = [
  { tick: 24, act: (s) => { s.propGrab(3, toward(s, 'mug-galley-1')); s.propRelease(3, true); } },
  { tick: 30, act: (s) => { s.propGrab(3, toward(s, 'mug-galley-1')); } },
  { tick: 31, act: (s) => s.propMove(3, flat(-0.3)) },
  { tick: 150, act: (s) => s.setHold('prograde') },
  { tick: 151, act: (s) => s.addLook(0.2, -0.1) },
  { tick: 600, act: (s) => s.setBoots(false) },
  ...Array.from({ length: 7 }, (_, i): Ev => ({ tick: 602 + 2 * i, act: (s) => s.propMove(3, flat(-0.3 + (0.7 * i) / 6)) })),
  { tick: 617, act: (s) => s.propRelease(3, false) },
  { tick: 2400, act: (s) => s.setControls({ throttle: 1 }) },
  { tick: 2403, act: (s) => s.addLook(-0.4, 0.05) },
  { tick: 3000, act: (s) => s.setControls({ throttle: 0 }) },
  { tick: 3001, act: (s) => s.setControls({ translate: { x: 0.5, y: 0, z: 0 } }) },
  { tick: 3121, act: (s) => s.setControls({ translate: { x: 0, y: 0, z: 0 } }) },
];

/**
 * Drive a session through the log with frames of `frame()` real seconds, until tick `end`. An input is delivered
 * between the frames at exactly its tick (a frame that would cross it is cut short there), as the app delivers a
 * touch between two frames: the next tick latches it.
 */
function drive(s: Session, frame: () => number, end: number, log: readonly Ev[] = LOG): Session {
  let i = 0;
  while (i < log.length && log[i].tick < s.tick()) i++;
  for (let guard = 0; s.tick() < end && guard < 1e6; guard++) {
    while (i < log.length && log[i].tick === s.tick()) log[i++].act(s);
    const next = i < log.length && log[i].tick < end ? log[i].tick : end;
    let dt = frame();
    const cap = (next - s.tick()) / 120 - 1e-7; // never step past the next input (the residue of a tick stays owed)
    if (dt > cap) dt = cap > 1e-6 ? cap : 1e-6;
    s.step(dt);
  }
  return s;
}

function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const at60 = (): number => 1 / 60;
const at30 = (): number => 1 / 30;
const jitter60 = (seed: number): (() => number) => { const r = lcg(seed); return () => (1 / 60) * (0.55 + 0.9 * r()); };

describe('the fixed tick: frame-rate independence', () => {
  it('30, 60 and jittered 60 fps give a bit-identical world after 60 s of hold, thrust, coast and a thrown mug', () => {
    const a = drive(galley(), at60, 7200);
    const b = drive(galley(), at30, 7200);
    const c = drive(galley(), jitter60(7), 7200);
    expect(a.tick()).toBe(7200);
    expect(a.time()).toBe(60);
    const sa = a.save();
    expect(b.save()).toBe(sa);
    expect(c.save()).toBe(sa);
    // the scenario did what it says: the mug was thrown and the drive burnt
    const mug = a.props().find((p) => p.id === 'mug-galley-1')!;
    expect(mug.stowed).toBe(false);
    expect(a.player().propellant).toBeLessThan(createSession(FREE).player().propellant);
    // and a second jitter pattern agrees mid-flight (at the end of the burn) as well
    const d = drive(galley(), jitter60(99), 3000), e = drive(galley(), at30, 3000);
    expect(d.save()).toBe(e.save());
  });

  it('a look changed between ticks does not change the world until the next tick boundary', () => {
    const s = drive(galley(), at60, 300);
    const w0 = (JSON.parse(s.save()) as { world: string }).world;
    s.addLook(0.3, 0.1);
    const owed = (s.frameTime() - s.time()) * 120; // the part of a tick real time already owes
    s.step((0.5 * (1 - owed)) / 120); // still less than a tick: nothing is stepped
    expect(s.tick()).toBe(300);
    expect((JSON.parse(s.save()) as { world: string }).world).toBe(w0);
    s.step(1 / 120);
    expect(s.tick()).toBe(301);
  });

  /** The save without the loose objects' part (see the it.fails below). */
  const noProps = (json: string): string => {
    const o = JSON.parse(json) as { session: Record<string, unknown> };
    delete o.session.props;
    return JSON.stringify(o);
  };

  it('save → load mid-flight (mid-burn), then continue: bit-identical (the world, the tick, the latched inputs, the controller)', () => {
    const a = drive(galley(), at60, 2700);
    const json = a.save();
    const b = loadSession(json, FREE)!;
    expect(b.tick()).toBe(2700);
    expect(b.save()).toBe(json);
    drive(a, at60, 4000);
    drive(b, jitter60(3), 4000);
    expect(noProps(b.save())).toBe(noProps(a.save()));
  });

  // Seam for W1-C (props.ts): the previous pose of each awake loose body lives in the per-layout runtime (rt.prev /
  // rt.prevOk, shared by every session of that layout), not in PropsState. A session loaded mid-throw therefore
  // starts from whatever pose another session left there; in a scratch copy this case diverged after ~800 ticks
  // (a: 60 fps, b: jittered, run one after the other). It passes in this order today; keep it as the alarm.
  it('save → load with an object in flight: the loose objects continue bit-identically too', () => {
    const a = drive(galley(), at60, 2700);
    const b = loadSession(a.save(), FREE)!;
    drive(a, at60, 4000);
    drive(b, jitter60(3), 4000);
    expect(b.save()).toBe(a.save());
  });

  it('under warp the sequence of steps does not depend on the budget, only the progress per frame', () => {
    const warp = (budgetMs: number): Session => {
      const s = createSession({ budgetMs, unitMs: 0.001, now: () => 0 });
      s.setHold('prograde');
      s.setWarp(1000);
      return s;
    };
    const big = warp(1e9), small = warp(0.05); // 50 units a frame
    const at = new Map<number, string>();
    for (let i = 0; i < 40; i++) { big.step(1 / 60); at.set(big.tick(), big.save()); }
    const target = big.tick();
    expect(target).toBeGreaterThan(40 * 1000 * 2 * 0.9);
    let frames = 0, same = 0;
    while (small.tick() < target && frames < 1e5) {
      small.step(1 / 60);
      frames++;
      const b = at.get(small.tick());
      if (b !== undefined) { expect(small.save()).toBe(b); same++; } // the same state wherever both frames ended
    }
    expect(frames).toBeGreaterThan(40); // the small budget got less far per frame…
    expect(small.warp().achieved).toBeLessThan(1000);
    expect(same).toBeGreaterThan(3); // …but stepped through the same states
  });

  it('the quantum at sleep warp is 2048 ticks (≈ 17 s) and the frame shows the tick state itself', () => {
    const s = createSession(FREE);
    s.setWarp(1e4);
    s.step(1 / 60);
    expect(s.tick() % 2048).toBe(0);
    expect(s.frameTime()).toBe(s.time());
    s.setWarp(1);
    s.step(0.5 / 120);
    const r = s.frameTime() - s.time();
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1 / 120);
  });
});
