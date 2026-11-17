// Deterministic random numbers. The simulation never calls Math.random(): everything procedural is
// derived from seeds so a save file plus the galaxy seed reproduces the same universe.

/** 32-bit string/number hash (FNV-1a + avalanche). Use to derive sub-seeds: hash(`${seed}:planet:${i}`). */
export function hash(input: string | number): number {
  const s = typeof input === 'number' ? String(input) : input;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number;
  /** Integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Standard normal (mean 0, sd 1). */
  gauss(): number;
  /** Random element. */
  pick<T>(items: readonly T[]): T;
  /** Random element by weight. */
  weighted<T>(items: readonly T[], weight: (item: T) => number): T;
  /** In-place Fisher–Yates shuffle; returns the same array. */
  shuffle<T>(items: T[]): T[];
  /** Independent child generator. */
  fork(label: string | number): Rng;
  /** Current internal state (serialisable). */
  state(): number;
}

/** mulberry32-based generator. */
export function makeRng(seed: number | string): Rng {
  let s = (typeof seed === 'string' ? hash(seed) : seed >>> 0) || 0x9e3779b9;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    gauss: () => {
      let u = 0;
      while (u === 0) u = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    },
    pick: (items) => items[Math.floor(next() * items.length)],
    weighted: (items, weight) => {
      let total = 0;
      for (const it of items) total += Math.max(0, weight(it));
      let r = next() * total;
      for (const it of items) {
        r -= Math.max(0, weight(it));
        if (r <= 0) return it;
      }
      return items[items.length - 1];
    },
    shuffle: (items) => {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
      return items;
    },
    fork: (label) => makeRng(hash(`${s}:${label}`)),
    state: () => s,
  };
  return rng;
}
