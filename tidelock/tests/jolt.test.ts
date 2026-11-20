// Contact jolts reach what rides inside (src/world/contact.ts takeJolt -> src/game/session.ts chunkMotion), and the
// hand's reach bends down to a low table (src/world/props.ts reachAlong).
import { describe, expect, it } from 'vitest';
import { createSession } from '../src/game';
import { qRotInv, takeJolt, undock, type Craft, type Jolt, type World } from '../src/world';
import { reachAlong, ARM_REACH, type PropsState } from '../src/world/props';
import { CREW_EYE, CREW_RADIUS } from '../src/world/crew';
import { INTERIORS } from '../src/data/interiors';

const FREE = { budgetMs: 1e9 };
interface Inside { world: World; ship: Craft; loose: PropsState | null }

describe('contact jolts', () => {
  it('the undock spring is a jolt of exactly the velocity change, read once', () => {
    const s = createSession(FREE) as unknown as Inside;
    const st = s.world.craft.find((c) => c.kind === 'station' && c.primary === s.ship.primary)!;
    s.world.joints.push({ kind: 'dock', craftId: s.ship.id, otherId: st.id, portId: st.ports[0].id, localPos: { x: 0, y: 0, z: 50 }, localQ: { x: 0, y: 0, z: 0, w: 1 } });
    s.ship.dockedTo = st.id;
    s.ship.dockPortId = st.ports[0].id;
    const v0 = { ...s.ship.relV };
    expect(undock(s.world, s.ship.id)).toBe(true);
    const j: Jolt = { dv: { x: 0, y: 0, z: 0 }, dw: { x: 0, y: 0, z: 0 }, n: 0 };
    expect(takeJolt(s.ship, j)).toBe(true);
    expect(j.dv.x).toBeCloseTo(s.ship.relV.x - v0.x, 12);
    expect(j.dv.y).toBeCloseTo(s.ship.relV.y - v0.y, 12);
    expect(j.dv.z).toBeCloseTo(s.ship.relV.z - v0.z, 12);
    expect(Math.hypot(j.dv.x, j.dv.y, j.dv.z)).toBeGreaterThan(0.5);
    expect(takeJolt(s.ship, j)).toBe(false); // cleared
  });

  it('a floating mug keeps its inertial velocity when the hull is jolted: in the ship it moves by −Δv', () => {
    const sess = createSession(FREE);
    const s = sess as unknown as Inside;
    const ps = s.loose!;
    const mug = ps.bodies.find((b) => b.id === 'mug-table-2')!;
    // lift it into the middle of the lounge, at rest relative to the ship, awake
    mug.p.x = 0; mug.p.y = 0.3; mug.p.z = -7.5;
    mug.v.x = mug.v.y = mug.v.z = 0;
    mug.asleep = false; mug.stowed = false; mug.still = 0;
    const st = s.world.craft.find((c) => c.kind === 'station' && c.primary === s.ship.primary)!;
    s.world.joints.push({ kind: 'dock', craftId: s.ship.id, otherId: st.id, portId: st.ports[0].id, localPos: { x: 0, y: 0, z: 50 }, localQ: { x: 0, y: 0, z: 0, w: 1 } });
    s.ship.dockedTo = st.id;
    s.ship.dockPortId = st.ports[0].id;
    const v0 = { ...s.ship.relV };
    undock(s.world, s.ship.id);
    const dv = { x: s.ship.relV.x - v0.x, y: s.ship.relV.y - v0.y, z: s.ship.relV.z - v0.z };
    const want = qRotInv({ x: 0, y: 0, z: 0 }, s.ship.q, -dv.x, -dv.y, -dv.z);
    sess.step(1 / 60);
    // the step's jolt spread over its span: the mug now moves at −Δv (ship axes), within the free-fall drift
    expect(mug.v.x).toBeCloseTo(want.x, 2);
    expect(mug.v.y).toBeCloseTo(want.y, 2);
    expect(mug.v.z).toBeCloseTo(want.z, 2);
    sess.step(1 / 60);
    expect(Math.hypot(mug.v.x - want.x, mug.v.y - want.y, mug.v.z - want.z)).toBeLessThan(0.01); // once, not every step
  });
});

describe('reach', () => {
  it('a standing pilot reaches the loose mug across the lounge table by bending, not at eye level', () => {
    const L = INTERIORS.wren!;
    const table = L.solids.find((f) => f.id === "table")!.box;
    const deck = L.rooms[0].box.min.y;
    const eye = { x: table.min.x - CREW_RADIUS - 0.02, y: deck + CREW_EYE, z: -7.2 };
    const mug = { x: 1.15, y: -0.243, z: -7.2 };
    const dx = mug.x - eye.x, dy = mug.y - eye.y, dz = mug.z - eye.z, d = Math.hypot(dx, dy, dz);
    expect(d).toBeGreaterThan(ARM_REACH);
    expect(d).toBeLessThan(reachAlong(dy / d));
    expect(reachAlong(0)).toBe(ARM_REACH);
    expect(reachAlong(0.5)).toBe(ARM_REACH);
  });
});
