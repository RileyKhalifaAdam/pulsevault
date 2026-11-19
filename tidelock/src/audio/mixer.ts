// The mix: native nodes only. Two physical paths into the ear, then a limiter.
//
//   structure-borne sources ─► struct ─┬─► air (gain = cabin p / p₀: a panel radiates ∝ ρ) ─┐
//   air-borne sources ─────────────────┼─► air                                              ├─► master ─► limiter ─► trim ─► guard ─► out
//                                      └─► bone LP 300 Hz ─► bone (1 while seated / gripped) ┘
//
// Reference: 1.0 at the output is 1 Pa = 94 dB SPL. The limiter (−6 dBFS, ratio 20, 1 ms attack) is mandatory:
// ear fatigue on a phone at arm's length. DynamicsCompressorNode always adds an automatic make-up gain (Chromium
// and WebKit share the kernel: (1/g(0 dBFS))^0.6, +3.42 dB for these settings, measured); `trim` removes it so
// the 94 dB = 1.0 reference holds below the threshold. `guard` is a WaveShaper soft clip (linear to 0.8, then
// tanh to a ceiling of 0.98) for what the compressor's attack lets through: nothing reaches full scale.

/** Pressure reference: gain 1 = 94 dB SPL. */
export const dB = (spl: number): number => Math.pow(10, (spl - 94) / 20);

/**
 * The per-frame numbers of one engine, in one Float64Array: [0] = ctx.currentTime, [1] = frame dt (s), then one
 * target slot per Smooth. The per-frame path writes a target into its slot and calls `sync()` with no arguments:
 * V8 boxes a double passed to (or returned from) any call it does not inline, and a typed-array store is a raw
 * write, so this keeps the update allocation-free whatever the JIT decides to inline.
 */
export class Slots {
  readonly f = new Float64Array(96);
  n = 2;
  take(): number {
    if (this.n >= this.f.length) throw new Error('audio: out of parameter slots');
    return this.n++;
  }
}

/**
 * One AudioParam driven by a first-order approach (setTargetAtTime). Writes only when the target moves by more
 * than `eps` (relative) or reaches exactly 0, so a steady state costs no automation events. Allocation-free.
 */
export class Smooth {
  /** Last target written (NaN before the first write). */
  last = Number.NaN;
  writes = 0;
  /** This parameter's slot in `f`. */
  readonly k: number;
  /** When a target of 0 has been written: the time it is set exactly to 0 (an exponential never arrives). */
  private zeroAt = -1;
  readonly f: Float64Array;
  constructor(readonly param: AudioParam, readonly tau: number, slots: Slots, readonly eps = 0.01) {
    this.k = slots.take();
    this.f = slots.f;
  }
  /** Apply the target in this parameter's slot. */
  sync(): void {
    const v = this.f[this.k];
    const l = this.last;
    if (v === l) return;
    const d = v > l ? v - l : l - v;
    const ref = v > l ? v : l;
    if (v !== 0 && l === l && d <= this.eps * ref) return;
    const now = this.f[0];
    const p = this.param;
    if (this.zeroAt > now) p.cancelScheduledValues(now);
    p.setTargetAtTime(v, now, this.tau);
    if (v === 0) {
      // 8 τ later the approach is at −70 dB: end it at exactly 0 so silence is silence
      this.zeroAt = now + 8 * this.tau;
      p.setValueAtTime(0, this.zeroAt);
    } else this.zeroAt = -1;
    this.last = v;
    this.writes++;
  }
  /** Off the per-frame path: write the slot and apply. */
  set(v: number): void {
    this.f[this.k] = v;
    this.sync();
  }
}

/**
 * A connection that exists only while something flows through it. Chromium and WebKit pull every node that is
 * connected to the destination each render quantum, silent or not; a chain whose sources sleep is unplugged, so
 * an idle graph costs the audio thread (almost) nothing. Plugs in at once, unplugs after `holdS` of inactivity
 * (after the gain has ramped down). Allocation-free; reads dt from the engine's slots.
 */
export class Wire {
  on = false;
  private idle = 0;
  constructor(private readonly from: AudioNode, private readonly to: readonly AudioNode[], private readonly f: Float64Array, private readonly holdS = 0.5) {}
  set(active: boolean): void {
    if (active) {
      this.idle = 0;
      if (!this.on) {
        for (let i = 0; i < this.to.length; i++) this.from.connect(this.to[i]);
        this.on = true;
      }
    } else if (this.on) {
      this.idle += this.f[1];
      if (this.idle > this.holdS) {
        for (let i = 0; i < this.to.length; i++) this.from.disconnect(this.to[i]);
        this.on = false;
      }
    }
  }
}

/** Limiter settings (knee 0). */
export const LIMIT_THRESHOLD_DB = -6;
export const LIMIT_RATIO = 20;
/**
 * The compressor's built-in make-up gain, dB: (1/g)^0.6 with g its static gain at a 0 dBFS input
 * (knee 0: g = T·(1 − 1/R) dB), as in the Chromium/WebKit DynamicsCompressorKernel.
 */
export const limiterMakeupDb = (thresholdDb: number, ratio: number): number => -0.6 * thresholdDb * (1 - 1 / ratio);
/** Soft-clip guard: linear below KNEE, then tanh toward CEIL; the curve spans inputs ±GUARD_SPAN. */
export const GUARD_KNEE = 0.8;
export const GUARD_CEIL = 0.98;
export const GUARD_SPAN = 2;
export const guardCurve = (x: number): number => {
  const a = x < 0 ? -x : x;
  const y = a <= GUARD_KNEE ? a : GUARD_KNEE + (GUARD_CEIL - GUARD_KNEE) * Math.tanh((a - GUARD_KNEE) / (GUARD_CEIL - GUARD_KNEE));
  return x < 0 ? -y : y;
};

export interface Mixer {
  readonly ctx: BaseAudioContext;
  readonly master: GainNode;
  readonly limiter: DynamicsCompressorNode;
  /** Removes the limiter's make-up gain (and scales into the guard's ±GUARD_SPAN input range). */
  readonly trim: GainNode;
  readonly guard: WaveShaperNode;
  /** The final node (connected to the destination). */
  readonly out: AudioNode;
  readonly struct: GainNode;
  readonly air: GainNode;
  readonly boneLP: BiquadFilterNode;
  readonly bone: GainNode;
  readonly airGain: Smooth;
  readonly boneGain: Smooth;
  /** air → master and struct → bone LP, plugged only while they carry sound. */
  readonly airWire: Wire;
  readonly boneWire: Wire;
}

export function createMixer(ctx: BaseAudioContext, slots: Slots): Mixer {
  const master = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = LIMIT_THRESHOLD_DB;
  limiter.knee.value = 0;
  limiter.ratio.value = LIMIT_RATIO;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.15;
  master.connect(limiter);
  const trim = ctx.createGain();
  trim.gain.value = Math.pow(10, -limiterMakeupDb(LIMIT_THRESHOLD_DB, LIMIT_RATIO) / 20) / GUARD_SPAN;
  limiter.connect(trim);
  const guard = ctx.createWaveShaper();
  const N = 2049;
  const curve = new Float32Array(N);
  for (let i = 0; i < N; i++) curve[i] = guardCurve(GUARD_SPAN * ((2 * i) / (N - 1) - 1));
  guard.curve = curve;
  guard.oversample = 'none';
  trim.connect(guard);
  guard.connect(ctx.destination);
  const air = ctx.createGain();
  air.gain.value = 0;
  const struct = ctx.createGain();
  struct.connect(air);
  const boneLP = ctx.createBiquadFilter();
  boneLP.type = 'lowpass';
  boneLP.frequency.value = 300;
  boneLP.Q.value = 0.707;
  const bone = ctx.createGain();
  bone.gain.value = 0;
  boneLP.connect(bone);
  bone.connect(master);
  return {
    ctx, master, limiter, trim, guard, out: guard, struct, air, boneLP, bone, airGain: new Smooth(air.gain, 0.05, slots), boneGain: new Smooth(bone.gain, 0.05, slots),
    airWire: new Wire(air, [master], slots.f), boneWire: new Wire(struct, [boneLP], slots.f),
  };
}

// ------------------------------------------------------------------ transient voices

export const VOICES = 16;
/** Fade time of a stolen voice, s. */
export const STEAL_S = 0.005;

interface Voice {
  src: AudioBufferSourceNode | null;
  wired: boolean;
  lp: BiquadFilterNode;
  gain: GainNode;
  pan: StereoPannerNode;
  route: number; // 0 struct, 1 air
  level: number;
  t0: number;
  decay: number; // 1/s, envelope rate of the buffer
  end: number;
}

/**
 * 16 one-shot voices with persistent filter/gain/pan nodes. A new hit takes a free voice or steals the quietest
 * (estimated level = start level · e^(−decay·age)); a hit quieter than every sounding voice is itself the quietest
 * and is dropped. The only allocation is the AudioBufferSourceNode a hit needs (Web Audio sources are one-shot),
 * at most one per played event (≤ 16 per frame, ≤ 8 per second under warp).
 */
export class VoicePool {
  readonly voices: Voice[] = [];
  started = 0;
  stolen = 0;
  dropped = 0;
  constructor(private readonly ctx: BaseAudioContext, private readonly outs: readonly AudioNode[], private readonly f: Float64Array) {
    for (let i = 0; i < VOICES; i++) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.707;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = ctx.createStereoPanner();
      lp.connect(gain);
      gain.connect(pan);
      this.voices.push({ src: null, wired: false, lp, gain, pan, route: 0, level: 0, t0: 0, decay: 1, end: 0 });
    }
  }

  levelOf(v: Voice, now: number): number {
    if (!v.src || now >= v.end) return 0;
    const age = now > v.t0 ? now - v.t0 : 0;
    return v.level * Math.exp(-v.decay * age);
  }

  /** Unplug voices whose buffer has ended (per frame; reads the time from the slots). */
  reap(): void {
    const now = this.f[0];
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (v.src && now > v.end + 0.05) {
        v.src.disconnect();
        v.src = null;
        v.pan.disconnect();
        v.wired = false;
      }
    }
  }

  /** Voices still sounding at `now`. */
  active(now: number): number {
    let n = 0;
    for (const v of this.voices) if (v.src && now < v.end) n++;
    return n;
  }

  masked = 0;

  /**
   * Start a transient. `gain` is the buffer's peak pressure as played, `level` the same after its low-pass (what
   * reaches the ear, used for every decision). Below perception is not built: a hit more than 40 dB under the
   * loudest sounding voice is masked and dropped, and every voice stops when its envelope falls under `floor`
   * (instead of playing the buffer's inaudible tail). A low-pass at ≥ 20 kHz is bypassed (the mechanism clips).
   * Buffers play at their own rate (no playbackRate: resampling would double a voice's cost). A stolen voice that
   * is still sounding is ramped to 0 over STEAL_S before it stops (a hard stop clicks), and the new hit on it
   * starts after the ramp.
   */
  play(buf: AudioBuffer, when: number, gain: number, level: number, pan: number, lpHz: number, route: number, decay: number, now: number, floor: number): boolean {
    let best = -1, bestL = Infinity, loud = 0;
    for (let i = 0; i < this.voices.length; i++) {
      const l = this.levelOf(this.voices[i], now);
      if (l > loud) loud = l;
      if (l < bestL) { bestL = l; best = i; }
    }
    if (level < 0.01 * loud) { this.masked++; return false; }
    if (bestL > 0 && bestL >= level) { this.dropped++; return false; }
    const v = this.voices[best];
    let start = when;
    if (v.src) {
      if (bestL > 0) {
        // still audible: fade it out, then start the new hit on this voice
        this.stolen++;
        const g = v.gain.gain;
        g.cancelScheduledValues(now);
        g.setTargetAtTime(0, now, STEAL_S / 4);
        const end = now + STEAL_S;
        try { v.src.stop(end); } catch { /* already stopped */ }
        if (start < end) start = end;
      } else {
        try { v.src.stop(); } catch { /* already stopped */ }
        v.src.disconnect();
      }
    }
    if (!v.wired || v.route !== route) {
      if (v.wired) v.pan.disconnect();
      v.pan.connect(this.outs[route]);
      v.route = route;
      v.wired = true;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    if (lpHz < 20000) {
      src.connect(v.lp);
      v.lp.frequency.setValueAtTime(lpHz, start);
    } else src.connect(v.gain);
    v.gain.gain.setValueAtTime(gain, start);
    v.pan.pan.setValueAtTime(pan, start);
    // audible life: until the envelope level·e^(−decay·t) reaches the floor (its physical decay), at most the buffer
    let life = buf.duration;
    const tf = level > floor ? Math.log(level / floor) / decay : 0;
    if (tf < life) life = tf > 0.03 ? tf : 0.03;
    src.start(start);
    src.stop(start + life);
    v.src = src;
    v.level = level;
    v.t0 = start;
    v.decay = decay;
    v.end = start + life;
    this.started++;
    return true;
  }
}
