import { describe, expect, it } from 'vitest';
import { BODY_SHIP, EVENT_KINDS, EVENT_RING_SIZE, MAT, clearEvents, createEventRing, drain, emitEvent, pending } from '../src/world/events';

/** Count V8 garbage collections while `fn` runs (an allocation-free loop of 1e6 iterations triggers none). */
export async function gcCount(fn: () => void): Promise<number> {
  const starts: number[] = [];
  const obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) starts.push(e.startTime); });
  obs.observe({ entryTypes: ['gc'] });
  const t0 = performance.now();
  fn();
  const t1 = performance.now();
  await new Promise((r) => setTimeout(r, 50));
  obs.disconnect();
  // only collections that started while fn ran (the test runner's own work afterwards does not count)
  return starts.filter((t) => t >= t0 && t <= t1).length;
}

describe('event ring', () => {
  it('is a fixed ring of 256 preallocated records with every kind of §1.4', () => {
    const r = createEventRing();
    expect(EVENT_RING_SIZE).toBe(256);
    expect(r.rec.length).toBe(256);
    expect(EVENT_KINDS).toEqual(['contact', 'slide', 'jetOn', 'jetOff', 'boot', 'bootOff', 'detent', 'toggle', 'plunger', 'latch', 'undock', 'breaker', 'capture', 'creak']);
    const keys = Object.keys(r.rec[0]).sort();
    expect(keys).toEqual(['J', 'a', 'b', 'kind', 'matA', 'matB', 'normal', 'pos', 't', 'vn'].sort());
  });

  it('drains in emit order, copies the vectors and empties', () => {
    const r = createEventRing();
    const p = { x: 1, y: 2, z: 3 }, n = { x: 0, y: 1, z: 0 };
    emitEvent(r, 'jetOn', 0.5, 3, 0, 34e3, p, null, 0, 0, 0);
    emitEvent(r, 'contact', 0.6, 7, BODY_SHIP, 0.54, p, n, 1.2, MAT.steel, MAT.aluminium);
    p.x = 99; // the ring copied it
    const seen: string[] = [];
    const seqs: number[] = [];
    expect(pending(r)).toBe(2);
    expect(drain(r, (e, seq) => { seen.push(`${e.kind}@${e.t}:${e.a}/${e.b}:${e.pos.x}:${e.normal.y}`); seqs.push(seq); })).toBe(2);
    expect(seen).toEqual(['jetOn@0.5:3/0:1:0', `contact@0.6:7/${BODY_SHIP}:1:1`]);
    expect(seqs).toEqual([0, 1]);
    expect(pending(r)).toBe(0);
    expect(drain(r, () => { throw new Error('nothing pending'); })).toBe(0);
  });

  it('wraps: a reader 300 behind gets the newest 256 in order, and the overwritten ones are counted', () => {
    const r = createEventRing();
    for (let i = 0; i < 300; i++) emitEvent(r, 'slide', i, i, BODY_SHIP, 1, null, null, 0.1, 0, 0);
    expect(r.dropped).toBe(44);
    const ts: number[] = [];
    drain(r, (e, seq) => { ts.push(e.t); expect(seq).toBe(e.t); });
    expect(ts.length).toBe(256);
    expect(ts[0]).toBe(44);
    expect(ts[255]).toBe(299);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBe(ts[i - 1] + 1);
    // and keeps working across many wraps, interleaved with drains
    let next = 300, got = 0;
    for (let k = 0; k < 50; k++) {
      for (let i = 0; i < 100; i++) emitEvent(r, 'detent', next++, 0, 0, 0, null, null, 0, 0, 0);
      drain(r, (e) => { expect(e.t).toBe(300 + got); got++; });
    }
    expect(got).toBe(5000);
    expect(r.dropped).toBe(44);
  });

  it('emit allocates nothing: the records are the same objects, and 1e6 emits trigger no garbage collection', async () => {
    const r = createEventRing();
    const before = r.rec.map((e) => [e, e.pos, e.normal]);
    const p = { x: 1, y: 2, z: 3 }, n = { x: 0, y: 0, z: 1 };
    const kinds = EVENT_KINDS;
    const loop = (): void => {
      for (let i = 0; i < 1e6; i++) {
        emitEvent(r, kinds[i % 14], i * 1e-3, i & 255, -1, 0.1 * i, p, (i & 1) === 0 ? n : null, 0.5, 4, 0);
        if ((i & 63) === 0) drain(r, noop);
      }
    };
    // Warm up the same loop first: while V8 tiers the code up, unoptimised calls box double arguments into
    // HeapNumbers. In steady state (optimised, as every per-frame path is after a few frames) nothing is allocated.
    loop();
    loop();
    const gcs = await gcCount(loop);
    expect(gcs).toBe(0);
    r.rec.forEach((e, i) => { expect(e).toBe(before[i][0]); expect(e.pos).toBe(before[i][1]); expect(e.normal).toBe(before[i][2]); });
  });

  it('draining never changes anything but the read cursor; clear forgets pending', () => {
    const r = createEventRing();
    emitEvent(r, 'toggle', 1, 2, 1, 0.01, null, null, 0, 0, 0);
    const snap = JSON.stringify(r.rec);
    drain(r, noop);
    expect(JSON.stringify(r.rec)).toBe(snap);
    emitEvent(r, 'toggle', 2, 2, 0, 0.01, null, null, 0, 0, 0);
    clearEvents(r);
    expect(pending(r)).toBe(0);
  });
});

function noop(): void { /* drained */ }
