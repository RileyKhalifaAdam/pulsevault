// Ephemeris: full n-body integration of the massive bodies with a fixed step and a 4th-order symplectic
// (Yoshida) scheme, cached ahead of the present in a ring buffer of typed arrays and read back anywhere inside
// the cache by cubic Hermite interpolation. Fixed step + fixed order of operations = deterministic.

import type { World } from './state';

// SIMULATION.md Decision 5: the Yoshida constants as literals (not Math.cbrt(2) at load), so the ephemeris never
// depends on an engine's cbrt: W1 = 1/(2 − 2^(1/3)), W0 = −2^(1/3)·W1.
const W1 = 1.3512071919596578;
const W0 = -1.7024143839193153;
/** relPositions cache entries: one Yoshida step evaluates three distinct times, per primary; twelve cover a tick of craft about four primaries. */
const RP_SLOTS = 12;
/** Yoshida 4th-order coefficients: drifts C1 C2 C2 C1, kicks D1 D2 D1. */
export const YC1 = W1 / 2;
export const YC2 = (W0 + W1) / 2;
export const YD1 = W1;
export const YD2 = W0;

/** Mutual Newtonian accelerations of `n` point masses. `s` holds positions at `off` (3n values). */
export function bodyAccelerations(n: number, mu: ArrayLike<number>, s: Float64Array, off: number, acc: Float64Array): void {
  const n3 = 3 * n;
  for (let i = 0; i < n3; i++) acc[i] = 0;
  for (let i = 0; i < n; i++) {
    const io = off + 3 * i;
    const xi = s[io], yi = s[io + 1], zi = s[io + 2];
    const mi = mu[i];
    let ax = 0, ay = 0, az = 0;
    for (let j = i + 1; j < n; j++) {
      const jo = off + 3 * j;
      const dx = s[jo] - xi, dy = s[jo + 1] - yi, dz = s[jo + 2] - zi;
      const d2 = dx * dx + dy * dy + dz * dz;
      const inv = 1 / (d2 * Math.sqrt(d2));
      const kj = mu[j] * inv, ki = mi * inv;
      ax += kj * dx; ay += kj * dy; az += kj * dz;
      const a = 3 * j;
      acc[a] -= ki * dx; acc[a + 1] -= ki * dy; acc[a + 2] -= ki * dz;
    }
    const a = 3 * i;
    acc[a] += ax; acc[a + 1] += ay; acc[a + 2] += az;
  }
}

/** One Yoshida step of length `h` in place on a packed state [positions 3n][velocities 3n] at `off`. */
export function yoshidaStep(n: number, mu: ArrayLike<number>, s: Float64Array, off: number, acc: Float64Array, h: number): void {
  const n3 = 3 * n;
  const v = off + n3;
  let k = YC1 * h;
  for (let i = 0; i < n3; i++) s[off + i] += k * s[v + i];
  bodyAccelerations(n, mu, s, off, acc);
  k = YD1 * h;
  for (let i = 0; i < n3; i++) s[v + i] += k * acc[i];
  k = YC2 * h;
  for (let i = 0; i < n3; i++) s[off + i] += k * s[v + i];
  bodyAccelerations(n, mu, s, off, acc);
  k = YD2 * h;
  for (let i = 0; i < n3; i++) s[v + i] += k * acc[i];
  k = YC2 * h;
  for (let i = 0; i < n3; i++) s[off + i] += k * s[v + i];
  bodyAccelerations(n, mu, s, off, acc);
  k = YD1 * h;
  for (let i = 0; i < n3; i++) s[v + i] += k * acc[i];
  k = YC1 * h;
  for (let i = 0; i < n3; i++) s[off + i] += k * s[v + i];
}

/** Total energy (J) and angular momentum (kg·m²/s, out[1..3]) of a packed state; out[0] = energy. */
export function bodyInvariants(n: number, mu: ArrayLike<number>, s: Float64Array, off: number, G: number, out: Float64Array): Float64Array {
  const n3 = 3 * n;
  let e = 0, lx = 0, ly = 0, lz = 0;
  for (let i = 0; i < n; i++) {
    const p = off + 3 * i, v = p + n3;
    const m = mu[i] / G;
    e += 0.5 * m * (s[v] * s[v] + s[v + 1] * s[v + 1] + s[v + 2] * s[v + 2]);
    lx += m * (s[p + 1] * s[v + 2] - s[p + 2] * s[v + 1]);
    ly += m * (s[p + 2] * s[v] - s[p] * s[v + 2]);
    lz += m * (s[p] * s[v + 1] - s[p + 1] * s[v]);
    for (let j = i + 1; j < n; j++) {
      const q = off + 3 * j;
      e -= (m * mu[j]) / Math.hypot(s[q] - s[p], s[q + 1] - s[p + 1], s[q + 2] - s[p + 2]);
    }
  }
  out[0] = e; out[1] = lx; out[2] = ly; out[3] = lz;
  return out;
}

/**
 * The cached, interpolated motion of the bodies. Node k is the state after k steps of `h` from t = 0; the
 * ring keeps nodes kMin..kMax. `setPin(t)` tells it which node must never be evicted (the present).
 */
export class Ephemeris {
  readonly n: number;
  readonly n3: number;
  readonly h: number;
  readonly mu: Float64Array;
  readonly capacity: number;
  /** Body steps integrated since creation (for the benchmark and the step counters). */
  steps = 0;
  private readonly buf: Float64Array;
  private readonly acc: Float64Array;
  private kMin: number;
  private kMax: number;
  private pin: number;
  /**
   * relPositions cache (SIMULATION.md W1-A 7): within a sync span every craft evaluates the bodies at the same
   * sub-step times, so the last RP_SLOTS distinct (t, p) results are kept and copied out — the same arithmetic done
   * once, so the result is bit-identical. An entry is valid while no node was written since (gen).
   */
  private gen = 0;
  private readonly rpT = new Float64Array(RP_SLOTS).fill(NaN);
  private readonly rpP = new Int32Array(RP_SLOTS);
  private readonly rpGen = new Float64Array(RP_SLOTS).fill(-1);
  private readonly rpBuf: Float64Array;
  private rpNext = 0;
  /** Cache hits and misses (benchmarks). */
  rpHits = 0;
  rpMisses = 0;

  constructor(mu: ArrayLike<number>, h: number, step0: number, state0: ArrayLike<number>, capacity = 8192) {
    this.n = mu.length;
    this.n3 = 3 * this.n;
    this.h = h;
    this.mu = Float64Array.from(mu);
    this.capacity = capacity;
    this.buf = new Float64Array(capacity * 2 * this.n3);
    this.acc = new Float64Array(this.n3);
    this.rpBuf = new Float64Array(RP_SLOTS * this.n3);
    this.kMin = this.kMax = this.pin = step0;
    const o = (step0 % capacity) * 2 * this.n3;
    for (let i = 0; i < 2 * this.n3; i++) this.buf[o + i] = state0[i];
    this.ensure(step0 * h);
  }

  /** The present: nodes at or after floor(t / h) are never evicted. */
  setPin(t: number): void {
    const k = Math.floor(t / this.h);
    this.pin = k < this.kMin ? this.kMin : k;
  }

  /** Extend the cache so that time `t` can be read. Returns the latest readable time (≥ t unless the ring is full). */
  ensure(t: number): number {
    const need = Math.floor(t / this.h) + 1;
    const stride = 2 * this.n3, cap = this.capacity, buf = this.buf;
    while (this.kMax < need) {
      if (this.kMax + 1 - this.kMin >= cap) {
        if (this.kMin >= this.pin) return this.kMax * this.h;
        this.kMin++;
        this.gen++;
      }
      const a = (this.kMax % cap) * stride, b = ((this.kMax + 1) % cap) * stride;
      for (let i = 0; i < stride; i++) buf[b + i] = buf[a + i];
      yoshidaStep(this.n, this.mu, buf, b, this.acc, this.h);
      this.kMax++;
      this.gen++;
      this.steps++;
    }
    return t;
  }

  covers(t: number): boolean {
    return t >= this.kMin * this.h && t <= this.kMax * this.h;
  }

  /** Latest cached time. */
  get tMax(): number {
    return this.kMax * this.h;
  }

  /** Positions of all bodies relative to body `p` at time `t`: out[3j..3j+2] = r_j − r_p. */
  relPositions(t: number, p: number, out: Float64Array): void {
    const n3 = this.n3, rt = this.rpT, gen = this.gen;
    for (let j = 0; j < RP_SLOTS; j++) {
      if (rt[j] === t && this.rpP[j] === p && this.rpGen[j] === gen) {
        const src = this.rpBuf, o = j * n3;
        for (let i = 0; i < n3; i++) out[i] = src[o + i];
        this.rpHits++;
        return;
      }
    }
    this.rpMisses++;
    this.relPositionsRaw(t, p, out);
    const j = this.rpNext;
    this.rpNext = (j + 1) % RP_SLOTS;
    rt[j] = t; this.rpP[j] = p; this.rpGen[j] = gen;
    const dst = this.rpBuf, o = j * n3;
    for (let i = 0; i < n3; i++) dst[o + i] = out[i];
  }

  /** relPositions without the cache. */
  relPositionsRaw(t: number, p: number, out: Float64Array): void {
    const h = this.h, n3 = this.n3, cap = this.capacity, buf = this.buf;
    let k = Math.floor(t / h);
    if (k >= this.kMax) k = this.kMax - 1;
    if (k < this.kMin) k = this.kMin;
    const s = (t - k * h) / h, u = 1 - s;
    const h00 = (1 + 2 * s) * u * u, h10 = s * u * u * h, h01 = s * s * (3 - 2 * s), h11 = -s * s * u * h;
    const a = (k % cap) * 2 * n3, b = ((k + 1) % cap) * 2 * n3;
    const av = a + n3, bv = b + n3;
    const p3 = 3 * p;
    const px = h00 * buf[a + p3] + h10 * buf[av + p3] + h01 * buf[b + p3] + h11 * buf[bv + p3];
    const py = h00 * buf[a + p3 + 1] + h10 * buf[av + p3 + 1] + h01 * buf[b + p3 + 1] + h11 * buf[bv + p3 + 1];
    const pz = h00 * buf[a + p3 + 2] + h10 * buf[av + p3 + 2] + h01 * buf[b + p3 + 2] + h11 * buf[bv + p3 + 2];
    for (let i = 0; i < n3; i += 3) {
      out[i] = h00 * buf[a + i] + h10 * buf[av + i] + h01 * buf[b + i] + h11 * buf[bv + i] - px;
      out[i + 1] = h00 * buf[a + i + 1] + h10 * buf[av + i + 1] + h01 * buf[b + i + 1] + h11 * buf[bv + i + 1] - py;
      out[i + 2] = h00 * buf[a + i + 2] + h10 * buf[av + i + 2] + h01 * buf[b + i + 2] + h11 * buf[bv + i + 2] - pz;
    }
  }

  /** Barycentric position and velocity of body `i` at time `t` into out[off..off+5]. */
  state(t: number, i: number, out: Float64Array, off = 0): void {
    const h = this.h, n3 = this.n3, cap = this.capacity, buf = this.buf;
    let k = Math.floor(t / h);
    if (k >= this.kMax) k = this.kMax - 1;
    if (k < this.kMin) k = this.kMin;
    const s = (t - k * h) / h, u = 1 - s;
    const h00 = (1 + 2 * s) * u * u, h10 = s * u * u * h, h01 = s * s * (3 - 2 * s), h11 = -s * s * u * h;
    const d00 = (-6 * s * u) / h, d10 = (1 - s) * (1 - 3 * s), d01 = -d00, d11 = s * (3 * s - 2);
    const a = (k % cap) * 2 * n3 + 3 * i, b = ((k + 1) % cap) * 2 * n3 + 3 * i;
    for (let c = 0; c < 3; c++) {
      const p0 = buf[a + c], v0 = buf[a + n3 + c], p1 = buf[b + c], v1 = buf[b + n3 + c];
      out[off + c] = h00 * p0 + h10 * v0 + h01 * p1 + h11 * v1;
      out[off + 3 + c] = d00 * p0 + d10 * v0 + d01 * p1 + d11 * v1;
    }
  }

  /** Copy of the integration node at or before `t` (what a save needs to continue bit-identically). */
  seed(t: number): { step: number; state: number[] } {
    let k = Math.floor(t / this.h);
    if (k > this.kMax) k = this.kMax;
    if (k < this.kMin) k = this.kMin;
    const stride = 2 * this.n3, o = (k % this.capacity) * stride;
    const state = new Array<number>(stride);
    for (let i = 0; i < stride; i++) state[i] = this.buf[o + i];
    return { step: k, state };
  }
}

const cache = new WeakMap<World, Ephemeris>();

/** The ephemeris of a world (created on first use from the node stored in the world). */
export function ephemerisOf(world: World): Ephemeris {
  let e = cache.get(world);
  if (!e) {
    const mu = world.bodies.map((b) => b.mu);
    e = new Ephemeris(mu, world.h, world.ephStep, world.ephState);
    e.setPin(world.t);
    e.ensure(world.t);
    cache.set(world, e);
  }
  return e;
}
