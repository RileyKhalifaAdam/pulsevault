import { it } from 'vitest';
import { createShipMotion } from '../src/world/crew';
import { createPropsState, stepProps } from '../src/world/props';
it('dbg', () => {
  const s = createPropsState('wren')!;
  const m = createShipMotion(); m.a.z = -12;
  const b = s.bodies.find((x) => x.id === 'spanner-2')!;
  for (let t = 0; t < 1440; t++) {
    const pre = `${b.qs.mode}/${b.qs.tickEnd}`;
    stepProps(s, m, null, 1 / 120);
    if (s.tick >= 104 && s.tick <= 150) console.log(s.tick, pre, '->', b.qs.mode, b.qs.tickEnd, 'p', b.p.x.toFixed(4), b.p.y.toFixed(4), b.p.z.toFixed(4), 'v', b.v.x.toFixed(3), b.v.y.toFixed(3), b.v.z.toFixed(3));
    if (s.tick > 150) break;
  }
});
