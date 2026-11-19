// Continuous sources and the level laws. Every gain is a function of simulated state (the AudioFrame); a source
// whose cause is absent has gain exactly 0, and a source that has been silent for a second is stopped so it
// costs the audio thread nothing (it is restarted, one node, when its cause returns).

import { Smooth, Wire, dB, type Slots } from './mixer';

// ------------------------------------------------------------------ level laws (pure, tested)

/** Structure-borne attenuation along the hull from a source d metres from the head: 1/(1 + d/10 m). */
export const structAtt = (d: number): number => 1 / (1 + d / 10);
/** Air-borne spreading from a compact source: 1/r, held at 1 inside 1 m. */
export const airAtt = (d: number): number => 1 / (d > 1 ? d : 1);

/** Reference thrust of the click law (gain ∝ F_j / 34 kN). */
export const JET_REF_N = 34e3;
/** RCS flow hiss at duty 1, 34 kN, at the jet (structure law applies): 78 dB in its 0.5–5 kHz band. */
export const G_HISS = dB(78);
/** Drive rumble at F_s = F_max, at the nozzle (structure law applies): 90 dB; ≈ 81 dB for two at the helm. */
export const G_RUMBLE = dB(90);
/** Cabin fan at 1 m: 57 dBA (the plan's 55–60 dBA, gain 0.014); the part that reaches the deck through the mount. */
export const G_FAN = dB(57);
export const FAN_STRUCT = 0.25;
/** Station machinery through the collar, at the collar: 52 dB. */
export const G_HUM = dB(52);
/** Bone path level relative to the structure bus (body contact through seat or boots). */
export const BONE_LEVEL = 0.5;
/** Sliding/rolling: gain ∝ μ·N·v_t; 0.6 W of friction power is 50 dB. */
export const K_SLIDE = dB(50) / 0.6;
/** Warp above which continuous sources are muted and events decimated. */
export const WARP_MUTE = 4;
/** Events allowed per real second under warp. */
export const EVENTS_PER_S_WARP = 8;
/** Sea-level reference pressure for the air path, Pa. */
export const P0 = 101325;

/** Air-path gain: radiated pressure ∝ ρ, and ρ ∝ p at cabin temperature. 0 in vacuum. */
export const airPathGain = (cabinPa: number): number => (cabinPa > 0 ? (cabinPa < 2 * P0 ? cabinPa / P0 : 2) : 0);

export interface AeroOut {
  /** Outside fluctuating pressure p_rms, Pa. */
  pOut: number;
  mach: number;
  /** Boundary-layer thickness, m, and the band peak 0.3·U/δ, Hz. */
  delta: number;
  fPeak: number;
  /** In-cabin p_rms after the mass law, Pa (= gain, since 1.0 is 1 Pa). */
  pCabin: number;
}

/** Surface mass of the skin + frames + lining, kg/m² (mass law). */
export const SKIN_MASS = 30;
/** Dynamic viscosity of air used for Re in wave 1, Pa·s (W2-B's profile replaces it). */
const MU_AIR = 1.8e-5;

/**
 * Aero roar (`sound-aero-buffeting`).
 * - Outside: p_rms = 0.01·q/(1 + 0.13M²)^0.64 (hypersonic Laganelli form).
 * - Boundary layer at x (half the hull): laminar δ = 5x/√Re_x, thickened by compressibility (1 + 0.12M²)
 *   (estimate; W2-B's Mach and profile replace it). Band peak f_p = 0.3·U/δ.
 * - Mass law τ(f) = 10^(−TL/10), TL = 20·log₁₀(f·m″) − 47 dB. With a wall-pressure spectrum rising as f² below
 *   f_p and falling as f⁻² above (Goody-like), ∫S·τ df has the closed form p_cabin = p_out·10^2.35/(m″·f_p).
 * About 70–80 dB in the cabin at q = 10 kPa and Mach 25; louder lower down; 0 when q = 0.
 */
export function aeroRoar(out: AeroOut, q: number, rho: number, U: number, soundSpeed: number, x: number): AeroOut {
  const io = AERO_IO;
  io[0] = q; io[1] = rho; io[2] = U; io[3] = soundSpeed; io[4] = x;
  aeroRoarIO(io);
  out.pOut = io[5]; out.mach = io[6]; out.delta = io[7]; out.fPeak = io[8]; out.pCabin = io[9];
  return out;
}
const AERO_IO = new Float64Array(10);

/** The same law on a Float64Array (per-frame path, no boxed doubles): in [q, ρ, U, a, x], out [p_out, M, δ, f_p, p_cabin]. */
export function aeroRoarIO(io: Float64Array): void {
  const q = io[0], rho = io[1], U = io[2], x = io[4];
  io[5] = 0; io[6] = 0; io[7] = 0; io[8] = 0; io[9] = 0;
  if (!(q > 0) || !(U > 0) || !(rho > 0)) return;
  const a = io[3] > 0 ? io[3] : 300;
  const M = U / a;
  const pOut = (0.01 * q) / Math.pow(1 + 0.13 * M * M, 0.64);
  const Re = (rho * U * x) / MU_AIR;
  let delta = ((5 * x) / Math.sqrt(Re > 1 ? Re : 1)) * (1 + 0.12 * M * M);
  if (delta > x) delta = x;
  if (delta < 1e-3) delta = 1e-3;
  const fPeak = (0.3 * U) / delta;
  let pCabin = (pOut * 223.872) / (SKIN_MASS * fPeak); // 10^2.35 = 223.872
  if (pCabin > pOut) pCabin = pOut;
  io[5] = pOut; io[6] = M; io[7] = delta; io[8] = fPeak; io[9] = pCabin;
}

/** Noise-bandwidth compensation: a unit-RMS white loop filtered to a band keeps √(ENBW/Nyquist) of its RMS. */
export const bandComp = (enbwHz: number, nyquist: number): number => Math.sqrt(nyquist / Math.max(1, enbwHz));
/** ENBW of a 2nd-order Butterworth low-pass ≈ 1.11·f_c. */
export const ENBW_LP = 1.11;

// ------------------------------------------------------------------ a looping source that sleeps

/**
 * A looped buffer into a gain. While the target gain stays 0 for `sleepS` seconds the source node is stopped and
 * dropped; when a cause returns a new source starts at the loop phase it would have had. Allocation happens only
 * at those transitions, never per frame.
 */
export class Loop {
  src: AudioBufferSourceNode | null = null;
  readonly gain: GainNode;
  readonly level: Smooth;
  /** Target slot (write `slots.f[loop.k]`, then `if (loop.needs()) loop.sync()`). */
  readonly k: number;
  private readonly f: Float64Array;
  private silentFor = 0;
  private readonly tail: Wire | null;
  restarts = 0;
  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly buf: AudioBuffer,
    out: AudioNode,
    tau: number,
    private readonly offset: number,
    slots: Slots,
    /** The chain after `out` is unplugged from these while the loop sleeps (out → tailTo). */
    tailTo: readonly AudioNode[] = [],
    private readonly sleepS = 1,
  ) {
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(out);
    this.tail = tailTo.length ? new Wire(out, tailTo, slots.f, 0) : null;
    this.level = new Smooth(this.gain.gain, tau, slots, 0.01);
    this.k = this.level.k;
    this.f = slots.f;
  }

  get awake(): boolean {
    return this.src !== null;
  }

  /** True when the target in the slot needs work (a level change, a wake, or counting down to sleep). */
  needs(): boolean {
    const v = this.f[this.k];
    return v !== this.level.last || (v === 0 && this.src !== null) || (v > 0 && this.src === null);
  }

  sync(): void {
    const v = this.f[this.k];
    const now = this.f[0];
    if (v > 0) {
      this.silentFor = 0;
      if (!this.src) {
        const s = this.ctx.createBufferSource();
        s.buffer = this.buf;
        s.loop = true;
        s.connect(this.gain);
        const d = this.buf.duration;
        s.start(now, (this.offset + now) % d);
        this.src = s;
        this.restarts++;
        if (this.tail) this.tail.set(true);
      }
    } else if (this.src) {
      this.silentFor += this.f[1];
      if (this.silentFor > this.sleepS) {
        try { this.src.stop(); } catch { /* ok */ }
        this.src.disconnect();
        this.src = null;
        if (this.tail) this.tail.set(false);
      }
    }
    this.level.sync();
  }

  /** Off the per-frame path. */
  set(v: number): void {
    this.f[this.k] = v;
    this.sync();
  }
}
