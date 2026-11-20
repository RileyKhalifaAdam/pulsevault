import { it } from 'vitest';
import { createShipMotion } from '../src/world/crew';
import { createPropsState, stepProps } from '../src/world/props';
const motion = (ax = 0, ay = 0, az = 0, wx = 0, wy = 0, wz = 0) => { const m = createShipMotion(); m.a.x = ax; m.a.y = ay; m.a.z = az; m.w.x = wx; m.w.y = wy; m.w.z = wz; return m; };
it('dbg', () => {
  const s = createPropsState('wren')!;
  const thrust = motion(0, 0, -12);
  for (let i = 0; i < 720; i++) {
    const n = stepProps(s, thrust, null, 1 / 60);
    if (i % 60 === 59) {
      const modes = [0, 0, 0, 0]; for (const b of s.bodies) modes[b.qs.mode]++;
      console.log(i, n, modes.join(','), s.bodies.filter((b) => !b.stowed && Math.hypot(b.v.x, b.v.y, b.v.z) > 0.01).map((b) => `${b.id}:${b.qs.mode}:${Math.hypot(b.v.x, b.v.y, b.v.z).toFixed(3)}`).join(' '));
    }
  }
  const s2 = createPropsState('wren')!;
  const rcs = motion(0.9, 0.3, 0, 0, 0.02, 0), coast = motion(0, 0, 0, 0, 0.02, 0);
  let subs = 0;
  for (let i = 0; i < 600; i++) {
    const m = i < 120 ? coast : i < 300 ? thrust : i < 420 ? rcs : coast;
    subs += stepProps(s2, m, null, 1 / 60);
    if (i % 30 === 29) { const modes = [0, 0, 0, 0]; for (const b of s2.bodies) modes[b.qs.mode]++; console.log('S', i, subs, modes.join(',')); }
  }
});
