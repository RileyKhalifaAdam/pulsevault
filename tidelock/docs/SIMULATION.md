# TIDELOCK — the simulation plan (binding)

The owner's request: **"Now make every possible thing simulated to the max while keeping performance."**
Still binding: *no UI except for moving my character; everything else is controlled physically, including the
ship; nothing is not simulated; as physics-based as possible while it runs smoothly on my iPhone 15.*

This file is the technical director's plan for that request. It comes from the audited and reviewed inventory
of seven areas (propulsion, environment, systems, crew, instruments, senses, budget) and from three competing
plans (fidelity, performance and player lenses). Where they disagreed, the decision and the reason are written
down here (look for **Decision**). An engineer who reads only this file, `CLAUDE.md` and `docs/ARCHITECTURE.md`
must be able to build their package.

- **Precedence.** `ARCHITECTURE.md` still owns the conventions (SI, axes, frames, determinism, rendering
  contract). This file owns *what* gets simulated, in which order, by whom, and within what budget. Where this
  plan amends `ARCHITECTURE.md` (§1.3, render extrapolation; §1.4, new laws), package W1-A writes the amendment;
  in waves 2 and 3 the hub (W2-D, W3-B) writes that wave's amendments (station gravity ends the "test masses"
  law, the layered atmosphere, the eye's sim-time adaptation).
- **Start condition.** Wave 1 starts once the four integrations in flight today have merged: hull-shape
  collisions (`compound.ts` → `contact.ts`), loose objects (`props.ts` → session, `input.ts`), photo textures
  (`render/space/*`) and the ray tracer (`render/rt` → `scene.ts`, `pipeline.ts`). Line numbers quoted below
  come from the audit and **will have drifted**. Search for the named symbol instead of trusting the number.
- **Reading the numbers.** "node" means measured in this container. The A16 in Safari is taken as about 2× node
  (Safari's JIT is 1.5–2.5× slower). "(est.)" marks a number nobody measured.

---

## 1. Principles, budget and architecture

### 1.1 Principles (every package keeps these)

1. **Cause, then effect.** Every motion, light, sound and reading comes from simulated state. A value is
   integrated, never set. Nothing is drawn, heard or felt without a cause in the world.
2. **Actuators write, everyone reads.** The world records what it actually applied: per-jet duty, engine
   thrust state, wheel momentum, the step-mean proper force and torque, and impulses. Puffs, plumes, sound,
   gauges and the crew's body read those records, never the pilot's commands.
3. **Below perception is not built.** A phenomenon the owner cannot notice on the phone is built only if it
   is a near-free rider on code that already exists for something felt. Otherwise it goes to §3.
4. **Efficiency before cutting** (the owner's frame-rate rule). Use exact or analytic updates for fast states,
   implicit steps for slow ones, sleeping, islands, multi-rate stepping, baking at load. If the efficient form
   still does not fit, scale it back and say so.
5. **Warp honesty.** A state either has an update that is exact at any step size, or it limits the step only
   while it is active and reports why (`limitedBy`). Coasting sleep warp stays free.
6. **Determinism on one engine.** The same input log on the same browser engine gives the same world, bit for
   bit, at any frame rate. No `Math.random`/`Date.now` in `world/`, `game/`, `sim/`. Noise comes from a counter
   hash (`core/rng.ts`) keyed to the tick index. Write σT⁴ as `T*T*T*T`. New transcendental calls in `world/`
   go through wrappers in `src/world/math.ts`, so an fdlibm port can be dropped in later.
7. **Physical controls only.** Every new control is a device in `src/data/cockpit.ts` (or a wall-mounted
   interactable in `src/data/interiors.ts`) driven by the existing touch-a-device path. No new on-screen UI.
8. **The viewer's rules** (`CLAUDE.md`): no network, everything baked at load or inlined; sound only after a
   tap; `localStorage` may throw.

### 1.2 Budget (A16, Safari, after ~20 min of thermal throttling)

The simulation is cheap today. In node, `session.step` costs 0.03 ms per frame on foot and 0.2–0.3 ms at the
helm, where thrust wakes the props. Sleep warp at 1e4 costs 0.02–0.08 ms per frame. What stops "more physics"
is structure, not speed. Every slow, honest effect (gravity gradient, tides, drag, station gravity, draughts)
would keep the loose objects awake. Awake objects force 0.1 s chunks, and that collapses 1e4 sleep warp to
about 15× on an A16. Wave 1 fixes the structure first.

The rows are *new or changed* work per frame, main thread, A16 (est. = 2× node unless marked).

| Subsystem | 1× @60 fps (raster tiers) | 1× @30 fps (RT High) | Sleep 1e4 @60 fps | Sleep 1e4, eyes-closed render | GPU RT High | GPU raster | Memory | Save |
|---|---|---|---|---|---|---|---|---|
| Fixed-tick spine, extrapolation, perf counters (W1-A) | 0.02 ms | 0.02 ms | 0.01 ms | 0.01 ms | 0 | 0 | 2 KB | +0.1 kB |
| Prediction, incremental and only when visible (W1-A) | 0.05 ms average (was 2–9 ms bursts twice a second) | 0.1 ms | 0 (not visible) | 0 | 0 | 0 | 16 KB | 0 |
| Craft dynamics: jets, spool, ledger, CMG, gravity gradient, aero, perturbations (W1-B, W2-B, W3-A) | ≤0.02 ms | ≤0.04 ms | ≤0.3 ms | ≤0.3 ms | 0 | 0 | ≤100 KB of tables | +1.5 kB |
| Contact and soft-capture docking (W2-C) | ≤0.02 ms, only during a capture | ≤0.04 ms | capture limits warp ("capture") | same | 0 | 0 | 2 KB | +0.5 kB |
| Crew body: harness, head, gait, handholds; floating attitude later (W1-C, W2-E, W3-D) | ≤0.01 ms (≤0.04 floating) | ≤0.02 (≤0.08) | 0 (closed form) | 0 | 0 | 0 | 1 KB | +0.4 kB |
| Loose objects with islands and drift mode (W1-C) | ≤0.1 ms awake (was 0.4–0.6), 0 asleep | ≤0.2 ms | ≤0.2 ms | ≤0.2 ms | 0 | 0 | 2 KB | 0 |
| Ship systems: thermal, power, cabin gas, life support (W2-D, W3-B) | ≤0.01 ms (a breach transient adds 0.04 ms) | ≤0.02 ms | ≤0.1 ms | ≤0.1 ms | 0 | 0 | 50 KB | +3 kB |
| Sensors: radar, lidar, rel-nav filter (W3-C) | ≤0.005 ms | ≤0.01 ms | ≤0.02 ms | ≤0.02 ms | 0 | 0 | 2 KB | +0.6 kB |
| Audio parameter updates, main thread (W1-D, W2-F) | ≤0.05 ms | ≤0.05 ms | ≤0.02 ms (continuous sources muted) | ≤0.02 ms | 0 | 0 | ~5 MB of buffers | 0 |
| Render honesty pass (W1-E): removals | ~0 | ~0 | — | — | **−0.2 to −0.3 ms** | −0.2 ms | 0 | 0 |
| Render with physical causes (W2-F, W3-E): uniform packing, SH9, occluder culling, IK | ≤0.1 ms | ≤0.1 ms | — | — | **gated, §1.2.2** | **gated, §1.2.2** | ≤3 MB | 0 |
| Docking camera draw calls (W3-C), only while active | ≤0.08 ms average (0.5 ms on its 10 Hz frame) | ≤0.15 ms average | — | — | in the §1.2.2 ledger | in the ledger | 0.4 MB | 0 |
| **New-simulation total** | **≤0.4 ms typical, ≤0.55 ms worst (cap 0.6 ms)** | **≤0.6 ms typical, ≤0.95 ms worst (cap 1.0 ms)** | **≤3 ms (budget); ~0.7 ms used** | **≤8 ms (budget)** | **ledger, §1.2.2** | **ledger, §1.2.2** | **≤+8 MB** | **≤+8 kB (save ≤50 kB of the 100 kB limit)** |

*How the totals add up (review).* The 1× rows sum to ≈ 0.37 ms at 60 fps with props awake and nothing else
transient (spine 0.02 + prediction 0.05 + craft 0.02 + crew 0.01 + props 0.1 + systems 0.01 + sensors 0.005 +
audio 0.05 + render 0.1). The worst coincidence (a capture, a floating body, a breach and the dock camera
together) adds 0.02 + 0.03 + 0.04 + 0.08 ≈ 0.17 ms, so ≈ 0.54 ms. Per-tick rows double at 30 fps (four ticks
per 33 ms frame instead of two); per-frame rows (audio, render) do not: ≈ 0.58 ms typical, ≈ 0.91 ms worst. The earlier "≤0.3 / ≤0.5 ms" totals were below
the sum of their own rows and are corrected here. Under sleep warp the rows sum to about 0.7 ms, inside the
3 ms budget, so the 8 ms eyes-closed budget is headroom, not a need.

- **Audio thread:** at most **5%** of one core (about 0.1 W). W1-D's sources are 1–3% on Safari (est.) and
  W2-F adds one FDN (≈1%), the CMG whine and the machinery; 3% was not enough for both waves. Share one noise
  buffer across all noise sources; run the FDN only for the room the head is in.
- **Page size:** at most +80 KB in total (5.8 of 16 MB is used today). Tables are baked at load **except the
  aero/thermal skin tables, which are baked at build time** (W2-B): about 16 KB of base64 int16 data.
- **Load time:** at most +300 ms behind the existing loading bar. *Review measurement:* one combined skin pass
  (Newtonian + free-molecular + damping + 12 zone areas) over 17k samples × 1024 directions took **336 ms in
  node** (≈ 700 ms on the A16); Newtonian alone took 174 ms. The load-time bake therefore does not fit, which is
  why W2-B bakes it at build time (prototype: `scratchpad/sim-audit/plan-review/aero.mjs`).

#### 1.2.1 Thermal headroom (why the caps are not bigger)

- **RT High is GPU-bound at about 30 fps** with roughly 15 ms of CPU idle per frame. That idle CPU is **not
  free**: the SoC shares one thermal budget. A P-core running JS draws about 2–3 W, so 6 ms per 33 ms frame is
  about 0.4–0.6 W, which is 10–15% of a sustained 4–5 W and comes out of GPU clocks.
  **Decision:** the awake simulation budget stays at **3 ms per frame on every tier** (`perf-sim-budget-fixed`
  keeps the constant). The 1× caps above are design limits that new code must stay under.
- **Asleep with eyes closed**, the render is cut (W1-A, W1-E) and the GPU idles 80–95%. Only then may the sim
  budget rise to **8 ms per frame**.
- **60 fps raster tiers** have about 3 ms of CPU budget for the sim under warp, as today.
- **Measurement:** Safari's `performance.now()` is 1 ms coarse here (the viewer is not cross-origin isolated).
  So budgets count *work units* against a running cost-per-unit estimate, and the clock is only a backstop.
  The perf report shows 2 s *means* of sim and render ms, plus idle = frame − sim − render (W1-A).

#### 1.2.2 GPU rule at RT High

At RT High a GPU addition is allowed only up to the GPU time the W1-E removals freed, measured with the shot
harness and on the owner's report. This covers the docking camera, RT dynamic sun casters, screen light in the
RT composite and window ghost taps. Anything over that ships on the raster tiers only, or waits. The raster tiers
may add up to +0.5 ms **in the worst situation**, not on average.

**GPU ledger (review).** The plan's GPU additions, summed, are well over both limits. One worst situation (in the
cockpit, at night, docking at a lit station) adds about 0.65 ms on raster and 1.0–1.5 ms at RT High. Every
package therefore records its measured cost in this ledger, and spends in this order:

| # | Item (package) | Raster (est.) | RT High (est.) | Active when |
|---|---|---|---|---|
| — | W1-E removals | −0.2 | −0.2 to −0.3 | always |
| 1 | RT dynamic sun casters (W2-F) | 0 (shadow map exists) | +0.15–0.3 | sun patch in the cabin |
| 2 | Visible body, raster overlay (W3-D) | +0.1–0.3 | +0.2–0.5 | cockpit, looking down |
| 3 | Station capsule occluders, CPU-culled to ≤3 (W2-F) | +0.02 | +0.05 | within 2 km of a station |
| 4 | Planetshine SH9 + window form factor (W2-F) | +0.03 | +0.03 | always |
| 5 | Screen light, baked form factor × live colour (W2-F) | +0.02 | +0.02 | cockpit |
| 6 | Floods as analytic spots (W2-F) | +0.05–0.1 | +0.05–0.1 | within 300 m of a lit station |
| 7 | Docking camera, 10 Hz (W3-C) | +0.1–0.2 average | +0.2–0.4 average | docking page and a station < 2 km |
| 8 | Eye post: pre-exposure, PSF sprite, CAT16, 64² bleach pass (W3-E) | +0.1–0.15 | +0.1–0.15 | always |
| 9 | Cloud flow map, airglow, plume line light (W3-E) | +0.1–0.3 | +0.1–0.3 | planet in view / burning |

Rules: an item ships at RT High only while the running sum stays ≤ 0 net, in this order; the rest ship on the
raster tiers if the worst-situation raster sum stays ≤ +0.5 ms. Anything left over needs a matching removal or
an efficiency gain first (the owner's rule): for example the screen light uses a **baked screen→surface form
factor** multiplied by the live screen colour (one texture tap) instead of per-fragment polygon integrals, and the
docking camera reuses the cockpit's frustum-culled draw lists. The ledger is checked by the shot harness in the
worst situations (cockpit at night docking; sunlit lounge; aerobrake) before each wave merges.

### 1.3 Simulation architecture

**Decision 1: main thread only, no simulation Worker.** The fidelity and performance plans agree, and the
player plan agrees too.
- There is no `SharedArrayBuffer` in the viewer (`crossOriginIsolated` is false), so there is no synchronous
  hand-off inside a frame. The crew, the hand, the props and the ship are coupled, and the renderer would draw
  state at least one frame old.
- The sim costs under 1 ms per frame, so a Worker would save almost nothing.
- A CSP without `blob:` would block every Worker.
- The predictor and photo decode are latency-tolerant, so a classic Blob Worker with a main-thread fallback
  stays possible later. It is not part of this plan (see §3).

**Decision 2: fixed sim-time tick, built first (wave 1).** The disagreement:
- The fidelity plan said "after the work packages, not felt".
- The performance plan said "WP0, blocks everything".
- The player plan proposed a 50 Hz controller grid.
- The budget reviewer measured the effect: 2.5° of attitude difference after 60 s between 30, 60 and jittered
  60 fps, and props ending in different rooms. The reviewer refuted the claim that today's frames judder.

We build it first anyway. It is cheap (size M), and the harness springs, the devices, the controller, PWM and
replayable bug reports all need a fixed `h`. Doing it later means re-tuning every one of them. The rules:

- **Tick.** `Q = 1/120 s` of sim time, counted as an integer `world.tick`. Sim time is `t = tick / 120`, always
  derived from the integer, never accumulated.
- **Inputs are latched per tick.** Device states and contacts sampled at a tick boundary are the commands for
  that tick.
- **Controller (holds, Flight Assist) runs every 2 ticks (60 Hz)** on the grid, with a zero-order hold between.
  This replaces `CONTROL_DT = 1/50` (which does not divide the tick) and frame-remainder chunks.
- **Crew, loose objects and devices** always step `h = Q`, with fixed sub-steps: devices, the harness and the
  head run 4 sub-steps per tick (480 Hz). Every exponential coefficient becomes a precomputed constant.
- **Craft** keep their adaptive steps (ARCHITECTURE §3) but synchronise only on tick boundaries, never on frame
  boundaries.
- **Under warp** the world advances in whole *quanta* `q = Q·2ⁿ` (n chosen from the warp level, for example
  q = 2¹¹·Q ≈ 17 s at sleep warp). The budget decides how many quanta fit in a frame. That changes only the
  *rate of progress*, never the sequence of steps. When the budget runs out the frame stops at a quantum
  boundary.
- **Rendering.** The renderer draws the latest tick state `t_k ≤ t_frame`, **extrapolated** by `r = t_frame − t_k`
  (r < Q = 8.3 ms) to first order from the world's own `v` and `ω`. Look yaw and pitch from the finger are
  applied at render time, so look latency does not grow. *Amendment to ARCHITECTURE §4:* "the renderer
  extrapolates by less than one tick from the world's own v and ω; it computes no motion of its own."
- **Saves** happen at a tick boundary and include `tick`, the latched inputs and the controller state.

**Decision 3: a multi-rate scheduler with declared warp behaviour.** Every subsystem states its natural rate,
how it behaves under warp, and its µs budget:

| Subsystem | Natural rate at 1× | Under warp | `limitedBy` reason |
|---|---|---|---|
| Ephemeris (bodies) | fixed H = 362 s, ahead of time (exists) | unchanged | — |
| Craft translation and rotation | adaptive, synced on ticks | adaptive, synced on quanta | thrust, rotation, atmosphere, proximity, contact (exist) |
| Controller (holds, Flight Assist) | 60 Hz on the grid | event-driven when settled (W1-B); CMG hold and constant-duty desaturation as a continuous-time law inside the rotation ODE, steps ≤ 1 s (W2-B) | thrust/rotation while correcting |
| Crew, props, devices | h = Q, with islands and sleeping | rest and drift modes in closed form; contact at Q under the budget | `props`, new `crew` |
| Docking soft capture | in the contact sub-steps | ≤ 1/120 s while attenuating | new `capture` |
| Thermal, cabin gas, power, life support | 10 Hz on the grid (every 12 ticks), implicit | one implicit step per ≤ 30 s (thermal) or ≤ 10 s (gas); SOC and life support exact | — |
| Breach venting | 5 ms sub-steps | ≤ 5 ms while venting | new `venting` |
| Sensors | 10 Hz (radar, lidar) | one update per frame; covariance propagated in closed form | — |
| Prediction | incremental, ≤ 0.3 ms slices | paused while hidden | — |
| Eye adaptation (W3-E) | sim time, exact exponentials | exact | — |
| Audio | real time, read from views | continuous sources muted above 4×; events decimated | — |

**Decision 4: saves stay compatible.**
- The loader stops discarding saves of another `SAVE_VERSION`. Today `session.ts` rejects any version other
  than 3 (`data.tidelock !== SAVE_VERSION`).
- Every new field is additive and has a loader default, applied by a `migrate()` that W1-A writes.
- Derived data is rebuilt at load, not saved: jet allocation tables, aero tables, atmosphere tables, mass
  properties.
- Save → load → step must stay bit-identical. Every package adds that case to its tests.
- Size target: ≤50 kB after all waves (23–37 kB today).

**Decision 5: cross-engine determinism is not pursued.** Saves never leave the device. We only hard-code the
Yoshida constants as literals: `W1 = 1.3512071919596578`, `W0 = −1.7024143839193153` (today `Math.cbrt(2)` in
`ephemeris.ts`). The wrapper rule in §1.1 keeps a later port possible.

### 1.4 The shared contract (fields every package relies on)

The wave's spine/hub owner (W1-A in wave 1, W2-D in wave 2, W3-B in wave 3) adds all of that wave's fields to
`src/world/state.ts`, `src/core/types.ts` and `src/game/api.ts` **on day 1**, with defaults. The packages then
fill them in. Units are SI. "Craft axes" means ship-local axes.

**Wave 1 (Craft):**
- `jetDuty: number[]` — the duty actually applied over the last step, 0..1, one per jet. It is 0 when the craft
  is landed, docked or dry.
- `engineThrust: number[]` — the thrust state `F_s` of each main engine, in N.
- `engineTimer: number[]` — the ignition timer of each engine, in s.
- `rcsPropellant: number` and `rcsPropellantCapacity: number` — kg. The existing `propellant` and
  `propellantCapacity` become the main (LH2) pool.
- `fAcc: V3`, `tauAcc: V3` and `accT: number` — ∫F·dt (N·s) and ∫τ·dt (N·m·s) of the proper (non-gravitational)
  force and torque actually applied, and the time accumulated, since the session last consumed them. Craft
  axes. Saved.
- `dvImpulse: V3` and `dwImpulse: V3` — impulsive Δv (m/s) and Δω (rad/s) from contacts, latch and undock since
  the last consumption. Craft axes.
- `airVel: V3` — the air-relative velocity `u = v_rel − ω_body × r_rel` (inertial axes, m/s); zero outside air.
- `heatFlux: number` — the instantaneous stagnation heat flux, W/m².
- `holdWakeT: number` — the sim time at which a settled hold must wake (+∞ when awake).

These are rebuilt at load, not saved:
- `jets: JetDef[]` — `{pos, dir, thrust, ve}` from the layout.
- `engines: EngineDef[]` — `{pos, dir, maxThrust, ve, tauUp, tauDown, delay, minThrottle}`.
- `jetTable: Float64Array` — 12 columns × N jets.

Wave 1 interfaces that are not fields (owned once, delivered on day 1 as stubs):
- **Ledger consumption** — `consumeLedger(c, out)` in `dynamics.ts` (W1-B) returns the tick's mean proper force
  and torque and the impulses, then zeroes them. Only the session calls it (W1-A), **once per tick** (once per
  quantum under warp), after the world step and before the crew, props and views read the snapshot. No other
  consumer resets the accumulators.
- **Event emit** — `emitEvent(kind, …)` in `events.ts` (W1-C). W1-C commits the ring and its emit signature on
  day 1, because W1-B's dynamics writes jet edges from day 1.
- **Body stepping** — `stepCrew(state, motion, h)` / `stepProps(state, motion, h)` and
  `nextBodyEvent(state, motion, tMax)` (the drift/rest scheduler) in `crew.ts`/`props.ts` (W1-C). W1-A's tick loop
  calls them; W1-C owns what is inside.
- **Frame fields** — `frame.eyesClosed` and the interpolation inputs live in `render/frame.ts`, which W1-E owns;
  W1-E adds them on day 1.

**Wave 2 (Craft):**
- `cmgH: V3`, `cmgHMax: number`, `cmgTauMax: number`
- `rotorH: V3`, `rotorOmega: number`, `rotorAngle0: number`, `rotorT0: number` (stations)
- `thermal: { T: number[] }`, `power: { soc: number, breakers: number[], reactorSet: number }`,
  `cabin: { rooms: number[] }` (5 numbers per room), `life: { o2Tank: number }`
- `zones: number[]` — health per damage zone; `overloadD: number`
- `heatIn: number[]` — joules per thermal zone deposited by aerodynamic heating since the last thermal step
- `driveInhibit: boolean` — set by thermal, honoured by dynamics

`Joint` gains `{phase: 'soft'|'retract'|'hard', stroke: V3, strokeV: V3, rot: V3, rotV: V3}`.

Added in review (wave 2), because two packages read or write each of them:
- `latchArmed: boolean`, `valves: { lh2: number, n2h4: number }` (0..1 opening) — written by W2-D's devices,
  read by W2-C's capture and refuelling.
- `jetHealth: number[]`, `engineHealth: number[]`, `radiatorHealth: number[]` — written by W2-C's damage, read by
  W2-B's allocator and dynamics and by W2-D's thermal. A change in `jetHealth` triggers a table rebuild.
- `shutters: number[]` — one per window group, 0 (open) … 1 (closed); written by W2-D's devices, read by W2-D's
  thermal (window sunlight) and W2-F's render.
- **Hull zone table** — `HULL_ZONES` (12 thermal skin zones, each with area, local radius, material and the
  damage components it contains) in `src/data/hullColliders.ts`, **owned by W2-C and delivered on day 1**. W2-B
  tags skin samples with it; W2-D builds its skin nodes from it; W2-C maps manifold points onto it.
- **Station mass properties** — `stationMassProps(layout)` in `src/world/stations.ts` (W2-C, day 1). W2-B's
  `setup.ts` calls it when building stations.
- `atm.top` keeps today's meaning (where ρ = 1e-7 kg/m³: Wick 127 km) and stays the reference for station
  altitudes, the "atmosphere" situation and events, cautions and line-of-sight; the extended profile gets a new
  `atm.tableTop` (W2-B).

**Wave 3 (Craft):**
- `tanks: {m: number, pos: V3, cap: number}[]`, `com: V3`, `inertia: number[6]`, `gimbal: number[]`,
  `slosh: number[]`, `flex: number[4]`
- Added in review: `vent: {F: V3, tau: V3, mdot: number}` (written by W3-B's cabin and cryo, applied by W3-A's
  dynamics, read by W3-C's predictor); `extImpulse: {J: V3, L: V3}` (written by W3-D, applied and zeroed by W3-A);
  `tpsMass: number[]` (written by W3-B's ablation, read by W3-A's mass properties); `tableCom: V3` (the CoM the jet
  table was built at, **saved**, so a table rebuilt after load is the same one).

**Views (`src/game/api.ts`):**
- Wave 1: `CraftView.jetDuty`, `engineLevel` (F_s/F_max), `airVelocity`, `heatFlux`;
  `FlightView.specificForce` (the IMU reading, see W1-A), `rcsPropellant`; `CrewView.eyeOffset` (V3, ship axes);
  frame `eyesClosed: number`.
- Waves 2–3 add `SystemsView` (temperatures, bus, rooms, cautions), `DockingView` (ring phase, stroke) and
  `SensorView` (tracks, covariance).

**Event ring (`src/world/events.ts`, new, wave 1, owned by W1-C):**
- A fixed ring of 256 records:
  `{kind, t, a, b, J, pos: V3, normal: V3, vn, matA, matB}`.
- Kinds: `contact`, `slide`, `jetOn`, `jetOff`, `boot`, `bootOff`, `detent`, `toggle`, `plunger`, `latch`,
  `undock`, `breaker`, `capture`, `creak`.
- Writers: props, crew and devices (W1-C), dynamics (W1-B, jet edges) and contact (W1-B hooks, later W2-C).
- `session.drainEvents(cb)` reads it once per frame.
- It is **output only**: never saved, never read by the world. Determinism is unaffected.

---

## 2. Work packages

Waves run one after another. Packages inside a wave run in parallel and own disjoint files. A file not listed
for a package in a wave is read-only for that package; if a one-line hook is needed in someone else's file,
the owner writes it on request (the request names the function). "Hub" marks the package that owns
`session.ts`, `api.ts`, `types.ts`, `state.ts`, `world.ts` and `app.ts` in that wave.

### Wave 1 — the spine, real thrusters, the body, hearing, honest pixels

#### W1-A Spine: fixed tick, scheduling, prediction, perf (hub)

**Goal.** Frame-rate-independent, replayable, budgeted stepping. No prediction hitch. Honest perf numbers.
The phone sleeps cool. Every wave-1 contract field exists on day 1.

**Files.**
- Game and app: `src/game/session.ts`, `src/game/api.ts`, `src/core/types.ts`, `src/app/app.ts`, `src/app/perf.ts`,
  `src/ui/perfOverlay.ts`.
- World: `src/world/world.ts`, `src/world/state.ts`, `src/world/ephemeris.ts`, `src/world/predict.ts`,
  `src/world/math.ts`, `src/world/index.ts`.
- Tests: `tests/session.test.ts`, `tests/world.test.ts`, `tests/worldPredict.test.ts`, new `tests/determinism.test.ts`.
- `docs/ARCHITECTURE.md` (the amendments).
- New `src/game/flight.ts`. W1-A creates it by **moving**, unchanged, `command()`, `faAxis`, `assistRef`, the hold
  logic and `arm()` out of `session.ts`, with the tests passing, then hands it to W1-B by the end of day 2.

**Model and work.**
1. **The fixed tick and quanta of §1.3.**
2. **Budgets in work units.**
   - Each subsystem reports units done; `perf.ts` keeps ms per unit from 2 s means.
   - `session.setBudget(ms)`: 3 ms awake, 8 ms asleep with eyes closed.
   - New `limitedBy` names: `capture`, `venting`, `crew`, `systems` (`LimitedBy` in `core/types.ts`,
     `WHY_NAMES` in `world.ts`).
   - `advance()` accepts a `wakeAt` stop time, so a settled hold wakes exactly on time (W1-B).
3. **Incremental prediction** (`perf-prediction-burst`, `fc-prediction-spike-and-thrust`).
   - While `predDirty` is false, keep the ghost. Drop points with t < now and extend the far end only as far as
     needed to keep the horizon (at 1× that is about one coast step every 20–30 s of real time), with **at most**
     0.3 ms of steps in any frame. The 0.3 ms is a cap, not a spend; the average is what the 0.05 ms row assumes.
   - On a disturbance (thrust, impulse, contact, primary change, burn edit), restart time-sliced at 0.5 ms per
     frame and show the old path until the new one is done.
   - A run that hits its budget is **resumed**. Today it is truncated: the cold first refresh drew 17 points.
   - **While thrusting**, the ghost integrates the held thrust and ṁ = F/vₑ with `stepForced` for
     min(propellant/ṁ, 30 s), then coasts. A second polyline gives "if cut now".
   - Prediction is computed only while a NAV screen or the hologram is visible and the pilot is awake
     (`perf-invisible-instruments`). W1-E supplies `cockpitScreensVisible()`.
4. **Perf honesty** (`perf-autoquality-30fps-blind`, `perf-timer-resolution`).
   - Record idle = frame − sim − render, with a target interval per tier: 33.3 ms for RT tiers, 16.7 ms
     otherwise.
   - Large idle with the frame over target means GPU-bound: lower resolution, but never blame the CPU.
   - The report shows 2 s means, not percentiles, of sim, render and idle, plus a 20 min trend of render and
     frame p50 as a thermal proxy.
   - Auto-quality must not cut RT High while frame ≈ 33 ms and idle is large.
5. **Eyes-closed sleep render** (`perf-sleep-render-dark`).
   - When the sleep shade is ≥ 0.9, set `frame.eyesClosed = 1`, render every 3rd frame at `MIN_SCALE` (0.6),
     and raise the sim budget to 8 ms.
   - W1-E skips RT, shadows and probes under the flag, and resets RT history on waking.
   - The grey shade becomes the eyelid transmission of W1-E: app.ts passes the amount and stops painting the
     black div.
6. **Autosave** (`perf-autosave-hitch`).
   - Probe storage once. If the probe fails, stop the periodic stringify.
   - Otherwise serialise on a frame with idle ≥ 4 ms, and write in a following `setTimeout(0)`.
7. **Ephemeris** (`perf-ephemeris-interp-reuse`, `env-determinism-transcendentals`).
   - Use literal Yoshida constants.
   - Cache `relPositions` per distinct t within a sync span. It is the same arithmetic, so the result stays
     bit-identical.
   - Add a note in `tests/worldPredict.test.ts` that the GC figures are V8 artefacts:
     JavaScriptCore NaN-boxes doubles (`perf-v8-double-boxing-benchmarks`).
8. **Views.**
   - `FlightView.specificForce` is the IMU reading: f = −feltAt(motion, r_imu), with r_imu from the layout
     (W1-B adds `imuPos`, about (0, −1.2, −12.0) m, under the cockpit deck). This fixes
     `inst-accel-readout-com-only`: at 0.5 rad/s the cockpit reads 0.34 g as the body feels it, and drag is
     included.
   - Add `airVelocity` and `heatFlux` to `CraftView`.
   - (Moved in review: r̂ in ShipMotion is built in `crew.ts`, so W1-C adds it.)
   - The helm felt point becomes the seated CoM, eye − 0.65 m (`body-small-kinematic-leftovers` (b); the line is
     in `session.ts`, so W1-A writes it). Remove the zoom argument `app.ts` passes to the camera (W1-C deletes
     the zoom itself).
9. **`migrate()`** and save compatibility (Decision 4).
   - A version-3 save has one 24 t pool. Split it as `rcs = min(1.5 t, propellant/16)` and `main = propellant − rcs`,
     so total mass is kept and the owner's ship is never left with a dry RCS pool by the upgrade.
   - Version-3 crafts get `engineThrust = 0`, `holdWakeT = +∞`, ledgers zero.
10. **Inputs that the sim uses are latched per tick.** Look yaw and pitch are applied to the *camera* at render
    time (no latency), but every sim use of the look (push-off direction, reach and grab rays, lean) reads the
    value latched at the tick boundary, and the input log records it. Otherwise replays diverge.
11. **Budgets count work.** The predictor's slices and the warp budget are counted in steps against a cost-per-step
    estimate (Safari's clock is 1 ms coarse); `Predictor.run` takes a step count, not milliseconds.
12. **Audio hook in `app.ts`.** Two lines: `attachAudio(host)` at boot and `audio.update(session, frame)` per
    frame. The functions are W1-D's.

**Budget.** ≤0.02 ms per frame for the spine. Prediction falls from 2–9 ms bursts twice a second to
≤0.1 ms per frame on average, and 0 when hidden. Save +0.1 kB.

**Tests.**
- The same input log at 30, 60 and jittered-60 fps gives a **bit-identical** world after 60 s of hold, thrust,
  coast and a thrown mug. This is the reviewer's `det.ts` scenario. Compare states **at the same tick**; under
  warp, also compare at the same quantum with two different (mocked) budgets: the sequence must not change,
  only the progress per frame.
- A changed look between ticks does not change the world until the next tick boundary.
- A version-3 save with 24 t splits into 1.5 t + 22.5 t with the same total mass.
- Save → load mid-flight, then continue: bit-identical.
- Incremental extension equals one long run over the same horizon, bit for bit.
- No frame spends more than 0.5 ms in the predictor.
- The idle arithmetic, and the GPU-bound inference, on synthetic rings.
- When storage throws, there is no stringify.
- A version-3 save loads with defaults.

**The owner notices.** No hitch twice a second. The ship handles the same at 30 and 60 fps. The phone is
cooler after sleeping. "Copy performance report" shows real headroom.

**Risks.** session.ts has just been edited for the loose objects. Extrapolation near contact is bounded by Q.
The look must not gain latency.

#### W1-B Real thrusters (propulsion and attitude actuators)

**Goal.** Every force and torque comes from a jet or an engine that exists, burns its own propellant, saturates
and shows. The applied-force ledger feeds everything that is felt.

**Files.**
- World: `src/world/dynamics.ts`, `src/world/setup.ts` (craft construction), `src/world/control.ts`,
  `src/world/contact.ts` (in wave 1 *hooks only*: impulse accumulation, applied = 0 when landed or docked, and
  the landed load).
- Data and game: `src/sim/ships.ts`, `src/data/shipLayouts.ts`, `src/game/flight.ts` (from day 3).
- Tests: `tests/worldCraft.test.ts`, `tests/ships.test.ts`, new `tests/jets.test.ts`.

**Model.**
1. **Per-jet RCS** (`att-rcs-jets`, `prop-rcs-no-z-jets`, `fc-attitude-actuators-free`,
   `attitude-torquer-momentum-power`).
   - The 10 existing jets (4 on X, 6 on Y) plus **4 new Z jets**:
     - two −Z-exhaust jets at the nose, about (±1.0, 0, −14.8) m. They push the ship aft. Check their
       clearance against the cockpit glass (the interior runs to z −15.0; the eye is at −13.45).
     - two +Z-exhaust jets on the stern pods, about (±6.0, −0.2, 13.0) m.
   - Add ±Z jets to all seven hulls in `shipLayouts.ts`.
   - Thrust per jet keeps 68 kN per axis: 34 kN per X jet and per Z jet, 22.7 kN per Y jet.
   - Each jet j has position r_j, exhaust direction d_j, thrust F_j and duty u_j ∈ [0,1].
     - Force: F = −Σ u_j F_j d_j
     - Torque: τ = Σ (r_j − c) × (−u_j F_j d_j)
     - Mass flow: ṁ_rcs = Σ u_j F_j / vₑ
   - **Allocation.** At load, solve 12 small minimum-propellant LPs (±F and ±τ per axis) for a 12 × N table,
     scaled so that each column's largest duty is 1. Per step, duty = Σ_k |cmd_k| · table[k±], clamped to
     [0,1]. Then compute the *actual* F and τ from the duties, so coupling and saturation emerge.
   - **Authority.** `maxTorque` is replaced by the computed authority, about 0.56 / 0.78 / 0.22 MN·m in
     pitch / yaw / roll, which is 40–60% below today's lumped values. Hold gains derive from it.
   - **Cost of turning.** A 90° slew at 0.375 rad/s costs about 150 kg. **Decision (D3):** `HOLD_MAX_RATE`
     drops from 0.6 to **0.1 rad/s**, about 40 kg per hold slew. The stick keeps full authority.
     Torque needs propellant: a dry RCS pool cannot turn the ship until the CMGs of W2-B exist.
2. **Separate RCS pool** (`prop-rcs-separate-propellant`, `systems-rcs-separate-propellant`).
   - The pool is hydrazine: ρ = 1004 kg/m³, **vₑ = 2250 m/s** (Isp 229 s, down from 2400), **1.5 t**.
     The LH2 main pool becomes 22.5 t, so the total stays 24 t.
   - Blowdown with ratio B = 3. Tank V_t = 2.24 m³, initial ullage V_u0 = V_t/3. Isothermal pressure
     p = p₀·V_u0/V_u, with V_u = V_t − m/ρ.
   - Jet thrust F_j = F_j0·p/p₀, and vₑ = vₑ0·(0.97 + 0.03·p/p₀). Empty, the thrust is a third of full.
3. **Main-drive transients** (`prop-engine-transients`).
   - Two engines at r_e = (±4.8, −0.2, 15.6) m, each 400 kN at vₑ = 34 km/s.
   - Ignition delay t_d = 0.5 s. Then exactly:
     F_s ← F_cmd + (F_s − F_cmd)·e^(−h/τ), with τ_up = 0.8 s, τ_down = 0.3 s.
   - Over the step, force and ṁ use the exact step mean
     F̄ = F_cmd + (F_s − F_cmd)·(τ/h)(1 − e^(−h/τ)). The rocket equation still emerges.
   - **Minimum stable throttle 15%**, with hysteresis on the *command*: it lights at a command ≥ 0.15 and goes
     out below 0.10; while lit, F_cmd = max(cmd, 0.15)·F_max, so the engine never runs between 10 and 15%.
   - The ignition delay ends exactly on a step boundary (the step is cut there), like tank-empty today.
   - **Flight Assist rework:** the main drive is used only when |a_req| > 0.18·a_main, and released below
     0.12·a_main. The RCS covers everything finer. Note the honest gap: the RCS saturates at 1.02 m/s² and the
     lowest main-drive acceleration is 0.15·a_main ≈ 1.8 m/s², so demands in between are met by saturated RCS
     (slower) — do not "fix" it with a lower floor.
   - The renderer's private spool, ignition kick and flicker are deleted by W1-E, which reads `engineLevel`.
4. **Two engines as two forces** (`prop-thrust-line-gimbal`, part 1). **Decision:** the pods are offset
   0.2 m below the declared CoM, and applying that offset now would cost about 6 kg/s of RCS to trim during
   every burn. So each engine is **canted 0.73° in pitch** (atan(0.2/15.6)) so the pair's resultant passes
   through the design CoM, as real ships are built. Yaw cancels by symmetry. A moving CoM and the gimbal
   come in W3-A.
5. **The applied-force ledger** (`prop-felt-from-commands`, `env-aero-felt-by-crew`, `sens-crew-no-drag`).
   - Every step adds the step-mean proper force — engines, jets, and drag as the RK4-weighted mean of the stage
     forces (k₁ + 2k₂ + 2k₃ + k₄)/6 — and the torque, both rotated into craft axes, to `fAcc` and `tauAcc`.
     It also adds `accT`.
   - Hooks in contact.ts add J/m to `dvImpulse` and I⁻¹(r × J) to `dwImpulse`, for every contact, latch capture
     and undock spring.
   - Landed, the ledger records the ground reaction (≈ −g plus the centripetal term), and `c.load` becomes
     |ground reaction|/m. Today it is thrust/m.
   - `airVel` and `heatFlux` (Sutton–Graves, 1.74e-4·√(ρ/R_n)·u³ with R_n = 1 m) are written per forced step.
6. **Applied ≠ commanded** (`prop-visual-from-command`, `prop-ground-thrust` in part). Landed, docked or with
   an empty pool, `jetDuty` and `engineThrust` are what is applied, i.e. 0. No more ghost puffs on the ground.
   (Thrust through the ground contact comes in W2-C.)
7. **Event-driven settled hold** (`fc-hold-warp-dependent`).
   - One deadband law at every warp: delete `LOOSE_WARP`, `WAKE_ANGLE_LOOSE` and `SUSPEND_WARP`.
   - At settle, solve θ₀ + ω_r·t + ½·α_b·t² = θ_db for the first t > 0. Here ω_r is the residual rate relative to
     the target frame and α_b a bound on the disturbing acceleration (0 in wave 1). Set `holdWakeT`.
   - The world stops at `holdWakeT` (W1-A's `wakeAt`); the 60 Hz law runs until settled again.
   - Today sleep drifts 104° per real minute. Cost at 1e4: a wake every ~1500 s of sim (0.15 s real), each about
     120 powered steps × 18 µs ≈ 2 ms. That averages 0.2 ms per frame.
8. **Flight Assist reference** (`sens-rendezvous-radar-lidar`, the bug part). `assistRef` may return a target
   only within FA_RANGE (100 km) **and** with line of sight (segment–sphere against every body radius plus
   its atmosphere top). Today it nulls velocity against a targeted station anywhere in the system.
9. **Rider: jet damping** (`att-jet-damping`). τ_jd = −Σ_e ṁ_e·|r_e − c|²·ω_⊥ while powered. Free, though
   it is only 0.06%.

**Budget.**
- About 0.6 µs per powered step, 0 extra coasting.
- At 1× < 0.01 ms per frame.
- Powered warp loses about 3% of its sim seconds.
- Save: +0.6 kB (14 duties, 4 engine numbers, RCS pool, accumulators, the wake time). Tables are rebuilt at load.

**Tests.**
- Rocket equation per pool, at 1e-3, with the spool and the jets.
- A pure torque command gives |F| ≤ 1% of authority.
- Propellant per slew matches 2·I·ω/(arm·vₑ) within 2%.
- Torque-free L conservation still holds.
- A dry pool gives zero torque.
- The spool update agrees for one step of 1 s and 120 steps of Q within 1e-12 relative (mathematically equal;
  not bit-equal in floating point).
- **The ledger is the truth:** over any powered or in-air step, ∫fAcc equals m·Δv − ∫m·g dt (in craft axes) within
  1e-9 relative, and ∫tauAcc equals the change in I·ω plus the gyroscopic integral. A ledger that disagrees with
  what dynamics applied is the one bug everything downstream (body, props, IMU, audio) would inherit.
- Minimum-throttle hysteresis, and no thrust between 10 and 15%.
- Blowdown thrust is ⅓ at empty.
- After 1 real minute of sleep with the hold on, the error is within the deadband.
- assistRef returns null behind Wick.
- Save → load bit-identical.
- `ships.test.ts` pins are updated deliberately.

**The owner notices.**
- The RCS gauge falls after a hard turn.
- Puffs come from the nose and tail jets that actually fire in a turn.
- Backing off the Wheel puffs at the nose.
- Ignition builds up over about a second, through the seat.
- Fine translation is RCS work.
- After sleeping, the ship points where it did.

**Risks.**
- Flight Assist retuning.
- Turning costs may frustrate (D3).
- The nose jets vs the windscreen.
- dynamics.ts has just been edited.

#### W1-C The body: felt forces, harness and head, boots, quasi-static props

**Goal.** The pilot's body and every loose object feel what the ship actually does. Sleep warp survives slow
forces.

**Files.**
- World: `src/world/crew.ts`, `src/world/props.ts`, `src/world/devices.ts`, new `src/world/events.ts`.
- `src/render/camera.ts` (interior eye path), `src/app/input.ts` (pinch), `src/data/props.ts` (Cd·A and material
  constants E, ρ, ν, η and dimensions for audio).
- Tests: `tests/crew.test.ts`, `tests/props.test.ts`, `tests/devices.test.ts`.

**Model.**
1. **Felt acceleration from the ledger** (`prop-felt-from-commands`, `body-ship-impulse-feel`).
   - craftMotion uses a = (fAcc/accT)/m and α = I⁻¹(τ̄ − ω × Iω) with τ̄ = tauAcc/accT. The rebuild from
     commands is deleted.
   - A loose body takes v_rel += −Δv − Δω × r from `dvImpulse` and `dwImpulse`.
   - A gripped body passes the impulse only up to the boot shear impulse J_max = μ_s·(F_mag + m·max(0, −f_n))·Q.
     Beyond that the boots slip.
   - A seated body takes the impulse through the harness (item 2).
2. **Helm torso, harness and head** (`body-helm-harness-head`).
   - Torso: m = 80 kg on a unilateral seat cushion and back, k = 60 kN/m (4.4 Hz), ζ = 0.3.
   - Harness: tension-only, k = 40 kN/m, slack 1.5 cm.
   - Head: a second-order lag on the torso, ω = 2π·2 Hz, ζ = 0.6 (4.5 kg head).
   - 4 sub-steps per tick (480 Hz) with semi-implicit Euler (ω·h = 0.057).
   - **The eye only translates.** The vestibulo-ocular reflex holds gaze, so the view never tilts; there is no
     camera shake: `eye = helmEye + x_torso + x_head`, written to `CrewView.eyeOffset`.
   - A steady 12 m/s² gives 1.6 cm of sink (x = a/ω²). A 2 m/s capture gives about 6 cm on the torso and 8–10 cm
     on the head, settling in about 0.3 s.
3. **Seats and bunk** (`body-seat-constraints`).
   - Unilateral contact with Coulomb friction μ 0.6. Bunk straps k = 8 kN/m.
   - **While asleep, or whenever h > 0.02 s, the closed-form equilibrium is used.** An explicit spring at
     h ≈ 83 ms would explode.
   - Props see the seated body with a finite mass through the seat spring (wave 2 gives it its shape).
4. **Boots, traction, gait** (`body-gait-boots-friction`, `body-boot-magnet-model`, `body-head-motion-on-foot`).
   - Magnet force per boot F(g) = F₀/(1 + g/g₀)², F₀ = 200 N, g₀ = 5 mm. It replaces the flat 2 m/s² pull.
   - Boots catch only when the soles touch (gap < 2 mm) and v_n ≤ 0.5 m/s; otherwise the body bounces with
     restitution 0.3. That ends the snap at any landing speed.
   - The landing goes through a knee spring of 20 kN/m with ζ = 0.7.
   - Traction T ≤ μ_s·(ΣF_mag + m·max(0, −f_n)), μ_s = 0.7, μ_k = 0.5. The legs apply
     F_leg = m(a_cmd − f_t), limited by T and by 1 kN. The felt load acts while gripped.
   - Speed cap 1.1 m/s while the felt normal is < 0.3 g; running only at ≥ 0.6 g.
   - Eye excursion from stance geometry, as a translation: vertical ±2 cm at 1.8 Hz at 1 g, scaled by
     √(f_n/g) with a floor of 0.3; lateral ±1.2 cm at half that frequency. The head lag responds to the body's
     own acceleration (a nod on stopping).
5. **Pinch is lean, not zoom; the head rotates about the neck** (`body-head-kinematics`, `eye-zoom`,
   `eye-head-dynamics`).
   - Lean is torso flexion: up to 0.30 m standing and 0.12 m harnessed, by a force-limited PD (ω = 6 rad/s,
     ζ = 1).
   - A head sphere of r = 0.10 m is tested against the compiled boxes, so the head cannot pass through glass.
   - **The FOV is fixed.** Delete the 1..3 zoom in camera.ts and input.ts.
   - Rotation is about a neck pivot: eye = pivot + R(yaw, pitch)·(0, 0.07, −0.09) m. Limits are ±75° yaw and
     +60/−70° pitch, plus torso twist up to ±40° when harnessed. That replaces today's 126°.
6. **Quasi-static props with islands** (`env-props-quasistatic-warp`, `perf-props-warp-collapse`,
   `perf-crew-frozen-under-warp`). Three modes per body:
   - **Contact.** h = Q with the existing solver. Sub-steps loop over the *awake island list* (awake bodies
     plus those touching them), never all n.
   - **Rest (asleep).** While v_rel < 1e-3 m/s and the tangential felt acceleration ≤ μ_s × the normal felt
     into the surface. It wakes when the predicted felt acceleration leaves that cone by more than 1e-4 m/s²,
     not on the global α² > 1e-12 or Δω tests, which are deleted.
   - **Drift.** No contact. Integrate in the ship's CoM-centred inertial frame in closed form:
     x(t) = x₀ + v₀t − ½·a_s·t² (plus the tidal linear term, wave 2), with
     dt = min(5 s, 0.1/n, √(2·gap/|a|), gap/|v|). Here `gap` comes from the static grid's distance to the nearest
     box, evaluated in the ship frame at the ship's attitude. Contact is entered at Q.
   - **Cabin-air drag** (`air-drag-props-ventilation` drag part, `body-cabin-air-drag`).
     F = −½ρ·C_dA·|u|·u, with ρ = 1.2 kg/m³ until W2-D's `cabin.ts` supplies it, and u = v (no draught yet;
     see W3-B). In drift mode use the closed form along the velocity: v(t) = v₀/(1 + k·v₀·t),
     k = ρ·C_dA/(2m).
     - Values: pillow 0.45 kg with C_dA 0.19 m² (speed e-folds every 2m/(ρ·C_dA) ≈ 4 m; quadratic drag never
       "stops" a body); pen 0.012 kg, 0.002 m² (10 m); mug 0.35 kg, 0.006 m² (97 m); crew 0.6 m² (220 m).
   - **Drift step bound (review).** `gap` shrinks because the *walls* move too: bound the step by
     gap/(|v − ω×r| + |ω|·r_body) in the ship frame, not gap/|v| in the inertial frame. At 1× a ship turning at
     0.1 rad/s sweeps a wall 10 m from the CoM at 1 m/s.
   - **Save.** The mode of each body (contact/rest/drift) and the drift anchor (x₀, v₀, t₀) are saved, or are a
     pure function of saved state; otherwise save → load changes the step sequence.
   - The crew body uses the same three modes, so it is simulated under warp instead of frozen (reason `crew`).
7. **The event ring** (§1.4). It also carries per-awake-body tangential speed and normal force (for rolling
   and sliding sounds).
8. **Small fixes.**
   - `dev-stick-time-overrun`: floor(dt/H) whole steps plus one remainder step. Under the tick, dt is always Q.
   - `body-small-kinematic-leftovers`: the landed proper acceleration gains Ω×(Ω×r) (the helm felt point is
     moved by W1-A, because it is in `session.ts`).
9. **ShipMotion gains r̂** (the primary-relative local vertical, ship axes) and n² = μ/r³, from the craft state.
   W2-E's tides use them. (Moved here from W1-A in review: `craftMotion` is in `crew.ts`.)

**Budget.**
- Harness and head about 1 µs per frame, gait ≤ 2 µs.
- Awake props with islands ≤ 0.1 ms, against 0.4–0.6 ms today.
- Drift mode 0.31 µs per 30-body step (node).
- Under sleep: 0 for the crew, ≤ 0.2 ms for props.
- Save +0.3 kB.

**Tests.**
- A steady 12 m/s² gives x = a/ω² within 5%.
- A 2 m/s impulse to the helm pilot peaks at about 6 cm and settles in < 0.5 s.
- A gripped pilot slips under an impulse above J_max and holds below it.
- The bunk is stable at h = 0.1 s.
- A floating body conserves inertial momentum through a ship turn.
- **A mug thrown just before lying down: sleep reaches ≥ 0.9e4 within 0.5 s of real time.**
- Drift mode stops exactly at contact, including a wall that moves into the body while the ship turns.
- Save → load in drift mode and in rest mode continues bit-identically.
- In a simulated aerobrake (a ledger with 20 m/s² of drag), a free mug reaches the forward bulkhead and the
  seated pilot's torso sinks a/ω² into the harness.
- Devices integrate exactly dt.
- Identical body paths at 30 and 60 fps.
- No event read can change the state.

**The owner notices.**
- Every burn presses them into the seat.
- A bump on the Wheel throws a walking pilot forward.
- An aerobrake pins them against the forward bulkhead.
- Leaning brings a screen closer with real parallax.
- Thrown pillows slow down in air.
- Sleep still works.

**Risks.**
- props.ts has just landed from another engineer.
- The new boots change how walking feels.
- Contact ↔ drift transitions.
- Until W2-C the latch capture is still instant, so a 2 m/s capture throws a walking pilot. That is honest for
  an instant capture.

#### W1-D Hearing (audio, from nothing)

**Goal.** The ship stops being silent, and every sound has a structure-borne cause.

**Files.** `src/audio/*` (new: `index.ts`, `context.ts`, `sources.ts`, `modal.ts`, `mixer.ts`),
`tests/audio.test.ts`, `tests/audio.e2e.cjs`. One hook in `app.ts`, written by W1-A.

**Model.**
- **Start.**
  - `attachAudio` adds a capture listener for `pointerup`, `touchend` and `click` on `window`. The listener
    creates the AudioContext **and calls `resume()`** inside the gesture, and is removed once
    `state === 'running'`. *Review correction:* `pointerdown` from a touch is **not** an activation-triggering
    event in the HTML spec or WebKit (only `touchend`/`pointerup` for touch, plus `click`), so a context made
    there stays `suspended`. The first sound therefore comes when the first finger lifts.
  - It sets `navigator.audioSession.type = 'playback'` inside a try/catch (the silent switch otherwise mutes
    WebAudio).
  - It resumes on `visibilitychange` and on `interrupted`.
  - **Native nodes only.** No AudioWorklet: the CSP may refuse its module. No OfflineAudioContext: buffers are
    filled in plain JS through `createBuffer`.
  - **Equal-power stereo**, no HRTF: the phone's two speakers make HRTF pointless.
- **Mix.** `master → DynamicsCompressor (limiter) → destination`. The reference is 94 dB SPL = gain 1. Cabin
  ambience sits at 55–60 dBA, a gain of 10^((57 − 94)/20) ≈ 0.014 (0.01–0.02; 0.03 would be 63.5 dB).
  - **Air path:** gain ∝ ρ/ρ₀ (constant until W2-D).
  - **Bone path:** low-pass at 300 Hz, active while the boots grip or the pilot is seated.
  - The phone's speakers roll off below about 250 Hz, so rumble is rendered as harmonics at 250–800 Hz (missing
    fundamental).
- **RCS** (`prop-thruster-sound`, `sound-propulsion-structure-borne`).
  - On `jetOn`: a valve click, a 5–10 ms broadband transient, with gain ∝ F_j/34 kN, and a 15 ms chamber rise.
  - While the duty is > 0: looping band-passed noise at 0.5–5 kHz with gain ∝ u_j·F_j.
  - On `jetOff`: a shutdown click.
  - Pan by the jet's azimuth relative to the head. Structure attenuation 1/(1 + d/10 m).
- **Main drive.** Per engine, broadband rumble with gain ∝ F_s/F_max, plus 6–12 Hz amplitude modulation from a
  1% thrust fluctuation. The ignition transient fires when F_s crosses 1%. The level follows `engineLevel`
  directly, so the spool is heard.
- **Modal impacts** (`sound-impacts-modal`).
  - At load, bake a buffer per (prop type × surface material), 30 pairs × 0.6 s × 48 kHz Float32 ≈ 3.5 MB:
    y(t) = Σ_k a_k e^(−π f_k η t) sin(2π f_k t), with 6–12 modes.
  - Plate modes f_mn = 0.453·c_L·h·((m/L_x)² + (n/L_y)²), with c_L = √(E/(ρ(1−ν²))).
  - Bar modes f_n = (β_n²/2π)·√(EI/(ρAL⁴)).
  - Loss factors η: aluminium 1e-4–1e-3, ceramic 1e-3, ABS 0.02, card 0.05–0.1. Deck panels are aluminium,
    2 mm thick, 0.6 × 0.6 m.
  - Per hit: gain ∝ J/√m, low-pass at 1/τ_c with Hertz contact time τ_c = 2.87·(m*²/(R*·E*²·v))^(1/5), and ±2%
    detune from a hash of the event index.
  - 16 voices; the quietest is stolen.
  - Sliding and rolling: filtered noise with gain ∝ μ·N·v_t.
- **Mechanisms** (`sound-crew-devices`).
  - Boot clamp: a 50 g armature at 0.5 m/s is 6 mJ into the deck modes, with gain ∝ √E.
  - Detents, toggle snap-through (5–20 mJ) and plunger make/break each have a device buffer.
  - The UI tick cues in `ui/kit/kit.ts` stay unwired; the hook is deleted in W2-F.
- **Aero roar** (`sound-aero-buffeting`).
  - Outside: p_rms = 0.01·q/(1 + 0.13M²)^0.64 (hypersonic Laganelli form, *not* the 0.006·q low-Mach value).
  - Mass-law transmission TL = 20·log₁₀(f·m″) − 47 dB with m″ = 30 kg/m²; band peak at f ≈ 0.3·U/δ.
  - That gives about 70–80 dB in the cabin at q = 10 kPa and Mach 25, louder lower down, and silence at skip-out.
  - Mach in wave 1 comes from an isothermal speed of sound √(γRT_eq/M); W2-B's profile replaces it.
- **Machinery** (`sound-machinery-ambience`). Fans: blade-pass at 7 blades × 3000 rpm = 350 Hz plus harmonics
  over broadband noise, 55–60 dBA, placed per room. The state is a declared constant until W2-D's power bus
  drives it.
- **Honesty** (`sound-propagation-honesty`).
  - Vacuum outside is silent.
  - Docked, the station's hum comes through the collar; landed, the ground conducts.
  - No Doppler (1.5% at 5 m/s in the cabin).
  - Continuous sources mute above 4× warp; events are decimated to ≤ 8 per second.

**Budget.** Main thread ≤ 0.05 ms per frame. Audio thread 1–3% of a core (12 noise sources with 2 biquads
cost 4.6 ms of CPU per second of audio in node). About 5 MB of buffers. Page about 10 KB.

**Tests.**
- Buffer synthesis is deterministic.
- Mode frequencies match the plate formula within 0.5%.
- The level laws.
- The voice cap.
- **No sound without a cause** (node, with a mock AudioContext that records node parameters): with `jetDuty`
  all 0 every RCS loop gain is 0; a `jetOn` event starts exactly one transient with gain ∝ F_j; with
  `engineLevel` 0 the rumble gain is 0; outside air the aero gain is 0; above 4× warp every continuous gain is 0.
- e2e (Playwright Chromium, iframe `sandbox="allow-scripts"`): no AudioContext is constructed before a gesture;
  a `pointerdown` alone does not start it; the graph is `running` after a tap (down + up); zero network requests.
  The iOS-only parts (silent switch, `audioSession`, `interrupted`) cannot be tested here and are reported as
  unverified.

**The owner notices.** Within seconds: thump-hiss from the jet that fires, a deep rumble through the deck on a
burn, the clink of a dropped mug, and silence while coasting.

**Risks.** Levels and ear fatigue (the limiter is mandatory). Node overhead on Safari. The silent switch.

#### W1-E Honest pixels (removals and render fixes driven by sim state)

**Goal.** Delete every effect that has no physical cause, drive the remaining ones from sim state, and free
GPU time for later waves.

**Files.**
- `src/render/scene.ts`, `src/render/frame.ts`, `src/render/pipeline.ts`, `src/render/post/shaders.ts`.
- `src/render/space/effects.ts`, `hologram.ts`, `instruments.ts`, `star.ts`, `sky.ts`, `planet.ts`, `cockpit.ts`,
  `hullMaterials.ts`, `ships.ts`.
- `src/render/rt/*` (the eyes-closed skip only).

**Work.**
1. **Puffs from `jetDuty`** (`prop-visual-from-command`, `fx-rcs-plume`).
   - No 0.25 threshold.
   - Hydrazine exhaust is transparent. What is visible is sunlit condensate, mostly at pulse edges.
   - Particle velocity = nozzle velocity (v + ω × r) + vₑ·d with a 30–60° cone. No drag.
   - Brightness = sun visibility × Henyey–Greenstein phase (g = 0.8) × column density. Nothing shows in shadow.
   - Delete the hot pinpoint.
   - Particles are stored against an inertial anchor, not the player's translating fx frame.
2. **Main plume** (`fx-main-plume` part 1).
   - The level is `engineLevel`.
   - Delete the render spool (τ 0.45/0.6 s), the ignition kick and the 47/113 Hz flicker.
   - No shock diamonds in vacuum. In air, cell spacing is 1.3·D_e·√(p_e/p_a) (W3-E finishes the air shape).
3. **Sheath** (`env-reentry-sheath-cause`, `fx-reentry-thermal-glow` part 1).
   - Orient along `airVelocity`, not the barycentric velocity.
   - Intensity = smoothstep(u, 3, 4 km/s)·√(heatFlux / 1 MW/m²), instantaneous, so it never lingers.
   - **Delete the screen-space plasma filaments and the heat-haze UV warp** (they paint over the cabin).
   - Hull glow stays on the stored-heat fraction until W2-F switches it to temperatures.
4. **Delete:**
   - the constant `AmbientLight` fill (`light-ambient-fill`)
   - the space-dust field (`fx-space-dust`, `env-space-dust-cause`)
   - the damage factor on engine glow (`systems-damage-render-fake`)
   - vignette, lateral chromatic aberration and grain (keep 1 LSB of triangular dither), the split-tone grade
     and the unused damage/jump/flash overlays (`eye-camera-artefacts`; CAS sharpening stays)
   - lens ghosts and the six iris spikes on the star *and* on bright stars in `sky.ts`
     (`light-star-disc-and-eye-glare` part 1; bloom stays until W3-E's PSF)
5. **Hologram** (`holo-scale-dishonest`, `holo-decorative-motion`).
   - A linear radial scale s = R_display/r_max, so the start orbit's orbit-to-globe ratio is 1.084.
   - A second linear zoom box around the ship or target, labelled with range rings in round km.
   - Frame: the orbit plane fixed in inertial orientation. The ship marker moves at the orbital rate.
   - Delete `uSpin`, the flicker and the dip.
   - Globe meridians at the sim `spinAngle`; a terminator from the star direction.
   - Show the prediction's events (closest approach, atmosphere entry, impact) and the "if cut now" line.
6. **Instruments.**
   - The attitude disc becomes a GPU overlay quad updated every frame (`inst-attitude-disc-5hz`); the canvas text
     stays at 5 Hz.
   - The aux POWER/THERMAL screens show only simulated state — heat fraction and rate, both propellant pools,
     mass flows, engine levels, lights — redrawn at 1 Hz (`inst-aux-screens-fake`). "REACTOR 82 %" and the
     other fixed numbers go.
   - The g read-out comes from `specificForce`.
7. **Screen washout** (`inst-screen-washout`).
   - Glass diffuse albedo 0.01 in the material and in the RT record.
   - Auto-brightness: L follows the illuminance on the glass, τ = 1 s, from 10 to 1000 cd/m².
   - At Tallow's 3–4e4 lx the veiling luminance is R_d·E/π ≈ 110 cd/m²: contrast is about 3.7:1 at 300 cd/m² and
     recovers to about 10:1 once auto-brightness reaches 1000 cd/m². The greying is felt for the ~1 s the
     brightness takes to follow, and as a lower contrast after.
8. **Orientation and clocks** (`env-locked-planet-render-spin`, `light-body-orientation`,
   `light-star-rotation-flares` rotation part, `env-cloud-phase-snap`, `fx-clock-warp`).
   - Every body, locked ones included, is drawn from the sim `spinAngle`. No seed `phase0`.
   - The star's spin and granulation (lifetime 5–10 min) run on sim time.
   - The cloud phase is computed in doubles from sim time and never wraps (same rate until W3-E's winds).
   - Every visual relaxation (nozzle glow, plasma easing, glare easing) integrates on sim dt with exact
     exponentials.
9. **Light balance** (`light-far-point-sources`, `light-per-object-key`).
   - Unresolved worlds: E_sun·p·(R/d)²·Φ(α) with the Lambert phase Φ(α) = (sin α + (π − α)·cos α)/π.
   - Craft: their own sunlit cross-section, with no brightness floors.
   - `starVisibility` is evaluated at each craft's own position, so the Wheel enters night ahead of the Wren.
10. **Eyes closed** (`perf-sleep-render-dark`, `eye-closed-lids`).
    - Under `frame.eyesClosed`, skip RT, shadow and probe updates; reset RT history on waking.
    - The eyelid is a per-channel multiply in the composite: 4% at 650–700 nm, 0.4% in blue and green. A
      sunlit bunk glows faint red.
11. **`cockpitScreensVisible()`** for W1-A: a frustum and room test of the console glass.

**Budget.** CPU about 0. GPU −0.2 to −0.3 ms at RT High (heat haze and filaments 0.1–0.2 ms, ghost quads,
one dust draw call). The overlay costs +0.02 ms.

**Tests.**
- Shot-harness comparisons: puff count 0 at duty 0; no dust; no ghosts.
- A hologram unit test: ratio 1.084.
- The sheath direction for a given v_rel and ω_body; sheath intensity is 0 on the first frame after
  `heatFlux` reaches 0 (no lingering).
- With `engineLevel` held at 0.5, plume brightness is constant frame to frame (no flicker, no kick).
- The cloud phase stays continuous across a planet rotation.

**The owner notices.**
- Nothing glows, drifts or flickers without a cause.
- The hologram's orbit really skims the planet.
- The screens grey out in sunlight.
- Night-side hulls are truly dark.

**Risks.** The picture may look plainer at first, and the owner may miss the effects. The commit message and
the summary say why. scene.ts is shared with the RT and photo merges.

### Wave 2 — attitude and air, docking by touch, the ship as a house, hands, causes you can see and hear

#### W2-B Flight physics II: CMGs, gravity gradient, aerodynamics, atmosphere, perturbations

**Goal.** Slow torques and air act on the ship as they really would, honestly under warp.

**Files.**
- World: `src/world/dynamics.ts`, `src/world/setup.ts`, `src/world/control.ts`, `src/world/atmosphere.ts`,
  new `src/world/aero.ts`, `src/world/predict.ts`.
- `src/game/flight.ts`, `src/sim/universe.ts` (buildAtmosphere), `src/data/shipLayouts.ts`, new
  `tools/bake-aero.mjs` and its generated `src/data/aero/*.ts`.
- Tests: `tests/worldCraft.test.ts`, `tests/universe.test.ts`, `tests/worldPredict.test.ts`, new
  `tests/aero.test.ts`, `tests/attitude.test.ts`.

**Model.**
1. **CMG pack** (`att-wheels`, `attitude-torquer-momentum-power`, part 2).
   - **Decision.** The fidelity and performance plans proposed "4 wheels × 2e4 N·m·s, 2 kN·m". The systems
     reviewer showed that no wheel can be the source of MN·m torque, and that a 2 kN·m wheel at speed draws
     hundreds of kW. We use **CMG-class units** instead: 4 in a pyramid, each 4.8e3 N·m·s and 260 N·m (the ISS
     CMG class), with a rotor at 6600 rpm (110 Hz, for audio) and 100 W standby plus up to 300 W active each.
   - Cluster envelope: |h_i| ≤ 1.0e4 N·m·s per body axis and |ḣ_i| ≤ 520 N·m. No singularity modelling (not
     perceptible).
   - Rotation: I·ω̇ = τ_ext + τ_jets − ḣ − ω × (Iω + h).
   - Allocator: the CMGs take a demand if |τ| ≤ τ_cmg and there is momentum margin; jets take the rest.
     Desaturate when |h_i| > 0.8·h_max: the jets produce τ = −k·h while the CMGs absorb the opposite, so the
     body feels nothing net.
   - CMG-only slew rate h/I: about 1.7e-3 rad/s in pitch and 4.4e-3 in roll. A slow turn is free and silent
     apart from the whine.
2. **The CMG hold as a continuous-time law** (the key to an affordable warp). When the hold is on the CMGs,
   its PD law (ω_n = 0.05 rad/s, ζ = 0.9) is integrated *inside* the rotation ODE (RK4, step ≤ 0.2/ω_n = 4 s).
   A 60 Hz digital controller with a 0.05 rad/s loop bandwidth is indistinguishable from continuous, so this is
   honest. At 1e4 warp: about 42 rotation steps per frame × 0.4 µs ≈ 0.02 ms. Jets fire only for slews faster
   than CMG authority and for desaturation.
   - *Review correction — how often and how long desaturation is.* An inertial (stability) hold sees a cyclic
     gravity-gradient torque whose momentum swing is τ_max/(2n) ≈ 10/(2·1.11e-3) ≈ 4.5e3 N·m·s, under the
     0.8·h_max = 8e3 threshold: **no desaturation at all**. An LVLH hold (prograde etc.) with the principal axes
     not aligned to the local vertical sees a *secular* torque of 3–10 N·m: a desaturation every 800–2700 s.
     Because the CMGs can absorb only 520 N·m, a desaturation lasts ≥ 8e3/520 ≈ 15 s, not 1 s.
   - At 1e4 that is up to 12 desaturations per real second. At the general 1/60 s powered-step limit each would
     cost ~900 steps × 18 µs ≈ 16 ms — **beyond the budget**. So desaturation runs **inside the continuous-time
     law** like the hold: the jets fire a constant couple at low duty, the CMGs absorb it, both are constant over
     the step, propellant flow is exact, and the RK4 step is ≤ 1 s. That is honest (the forces are smooth and
     constant); the 1/60 s limit stays for pilot-commanded and Flight-Assist thrust. Cost: ≈ 15 steps per
     desaturation, ≤ 0.05 ms per frame at 1e4 even in the worst attitude.
   - The CMG parameters go in `src/data/shipLayouts.ts` (W2-B's file), not in the `ships.ts` catalogue (W2-D's);
     W2-D splits the catalogue's lumped `rcs_std_1` torque on request.
3. **Gravity-gradient torque** (`att-gravity-gradient`, `env-gravity-gradient-torque`).
   - τ = (3μ/|r|³)·(r̂_b × I·r̂_b) from the primary, with r̂_b in body axes.
   - Rotation is integrated every step for any craft with inertia anisotropy > 1%.
   - Wren: peak about 10 N·m, libration ≈ 57 min.
   - Ships **only with** W1-C's quasi-static props (done) and items 1–2. Otherwise sleep warp collapses.
   - **Stations (review correction).** The Wren's 520 N·m CMGs are irrelevant at station scale: a 1e10 kg,
     900 m station misaligned from the local vertical sees a gravity-gradient torque of order
     1.5·n²·ΔI ≈ 1e7–1e8 N·m. Instead, each station starts in its **gravity-gradient equilibrium**: principal
     axes aligned with the local-vertical frame (the Wheel's spin axis, its largest-inertia axis, along the orbit
     normal, which is stable for a gyrostat) and ω = n about the orbit normal, not today's ω = 0. It then librates
     honestly about that attitude. A station pilot in `flight.ts` damps libration with station-scale actuators
     sized τ_max ≈ 1e-6·I_max (est.), integrated as the same continuous-time law. The docked Wren turns with the
     station at n (one turn per orbit), which is real.
4. **Newtonian aero table** (`env-aero-shape`, `att-aero-moments`).
   - From the hull compound (`craftCompound`): 17k skin samples × directions on a Fibonacci sphere. Per direction
     û: F/q = Σ −C_p·A·n and M/q = Σ p × f over windward samples (n·û < 0), with C_p = 1.84·(n·û)² (modified
     Newtonian) and skin friction C_f = 0.002 along the flow.
   - **Free-molecular table** (diffuse reflection, C_D ≈ 2.2).
   - **Damping derivatives** ∂M/∂ω, computed **analytically in the same pass** (the local flow is u + ω × p, so
     ∂C_p/∂ω is linear in p × n) rather than by finite differences. M = q·M(û) + q·(ℓ/|u|)·D(û)·ω.
   - The 12-zone projected areas W2-D needs (sun, albedo, IR) come out of the same pass.
   - **Bake at build time, not at load (review).** One combined pass measured **336 ms in node** at 1024
     directions (Newtonian alone 174 ms), so ≈ 0.4–0.7 s on the A16 — over the +300 ms load budget. Use the hull's
     left–right mirror symmetry (halves the directions), 1024 directions for the Newtonian F and M and 256 for
     free-molecular, damping and zone areas, quantised to int16 with a per-column scale: ≈ 12 KB, ≈ 16 KB as
     base64 in a generated `src/data/aero/<hull>.ts`, written by a new `tools/bake-aero.mjs` (W2-B owns both,
     like `tools/bake-interior.mjs`). Load cost ≈ 0, and the data are identical on every engine. Only the Wren
     needs it now; other hulls get it when they fly. A test re-bakes in node and compares within the quantisation
     step.
   - Prototype numbers: nose-first F/q = 57 m², belly-first 655 m² with M/q = −1089 m³, L/D ≈ 1.1 at α = 30°.
   - **Regime factors** (`env-mach-knudsen`):
     - free-molecular for Kn > 10, with a log-Kn bridge;
     - modified Newtonian for M > 5;
     - a transonic drag rise ×1.3–1.6 at M 1.0–1.2;
     - subsonic blunt body: C_D scale 0.6–1.0 and a CoP shift.
     These are 16-entry K_D(M) and K_M(M) tables.
   - In air, translation and rotation are co-integrated, with sub-steps ≤ min(Q, 0.1/ω_pitch), where
     ω_pitch ≈ 0.7 rad/s at 10 kPa.
   - **The predictor** assumes the attitude the active hold commands (prograde, retrograde and so on), or else
     a constant α and β relative to the velocity. The NAV screen says "path assumes attitude held" (W2-F draws
     it).
5. **Layered atmosphere** (`env-atmosphere-profile`).
   - Piecewise-linear T(z) in units of H₀ = R·T_s/(M·g):
     - lapse g/c_p × 0.67 up to the tropopause at 1.5·H₀ (T = 0.75·T_s);
     - warming to 0.94·T_s at 6·H₀;
     - the mesopause at 11·H₀ (0.65·T_s);
     - the thermosphere rising to T_exo = 1000 K × (1 + 0.5·(activity − 0.35)) over 14–20·H₀;
     - M → 0.016 (atomic O) above 15·H₀.
   - Check against Earth: H₀ = 8.4 km gives 12.6, 50 and 92 km.
   - The tropopause temperature follows from the lapse (for Earth 288 − 6.5 × 12.6 ≈ 206 K ≈ 0.72·T_s); do not
     also impose 0.75·T_s.
   - Integrate dp/dz = −ρ·g(z) hydrostatically with ρ = pM/(R_gas·T), into 512 entries of ln ρ and T per body,
     up to where ρ < 1e-15 kg/m³ (Wick reaches past 547 km). That top is the new `atm.tableTop`.
   - **Hazard found in review: do not move `atm.top` (`AtmosphereDef.height`).** `universe.ts` places every
     station at `parent.radius + atmosphere.height + altitude`, and the same height drives the 'atmosphere'
     situation (re-entry glow), the atmosphere-entry event (which **wakes the sleeper**), the predictor's
     atmosphere event, the planned caution and line-of-sight. Raising it to the table top would move the Wheel
     hundreds of km and make the Wren permanently "in atmosphere", waking every sleep. Keep `height` at the
     ρ = 1e-7 kg/m³ level for all of those; only the drag and thermal lookups use the table above it.
   - The sound speed a = √(γ·R_gas·T/M) is exposed to audio.
   - **Weak drag as a coast perturbation** (`env-thermosphere-drag-leo`). Where |a_drag| < 1e-5 m/s², stepCoast
     applies half-kick / drift / half-kick velocity kicks instead of the 1 s in-air cap. At 547 km this gives an
     honest ~1.7 m/day decay and differential drift against the Wheel.
6. **Ambient-pressure thrust** (`prop-pressure-thrust`, `env-ambient-pressure-thrust`).
   - F_e = ṁ·vₑ + (p_e − p_a)·A_eff, with p_a = ρRT/M from the profile, p_e ≈ 1 kPa for the torch, and
     A_e = π·1.15² = 4.15 m² per pod.
   - A wall nozzle separates when p_e < 0.35·p_a (Summerfield), and A_eff shrinks to the separation point.
   - The Wren's drive is a magnetic nozzle (`ships.ts`) with no wall, so the loss is p_a·A_e with no recovery.
     At Wick sea level (94 kPa) that is about 781 kN of the 800 kN.
   - RCS jets lose p_a·A_jet the same way.
   - **Decision D1** below: built and on.
7. **Station gravity** (`env-station-gravity`).
   - a = −G·m_st·d/|d|³ for stations on the same primary within 50 km, with the masses from W2-C's `stations.ts`.
   - Inside the bounding radius, g ∝ r. The reaction acts on the station.
   - At 682 m from a 1e9 kg Wheel, a = 1.4e-7 m/s² and the Clohessy–Wiltshire drift is about 180 m per 8 h sleep.
     It scales with the real station mass: at W2-C's ~1e10 kg it is ≈ 1.4e-6 m/s² and **≈ 1.7 km per 8 h sleep**
     (the Hill radius is only ~60 m, so this is a perturbation, not a capture). The owner should hear plainly that
     a parked Wren will not stay parked beside the Wheel through a night (part of D5).
8. **Aero heating per zone** (`env-entry-heating-zones`, the flux part).
   - Convective: q_i = 1.74e-4·√(ρ/R_i)·u³·f(θ_i), with f the windward incidence fraction from the table and
     R_i the zone's local radius (0.12–1.27 m).
   - Radiative, above 9 km/s: Tauber–Sutton q_r ∝ ρ^1.22·f(u).
   - Joules are accumulated into `heatIn[zone]` for W2-D.
9. **Buoyancy** (`env-buoyancy`). F = ρ·V_hull·g, about 1.8 t at Wick's surface. Free.
10. **Honour `driveInhibit`** (thermal interlock from W2-D).

**Budget.**
- In air: 4 table lookups per RK4 step at about 70 ns each, under 0.001 ms per frame.
- Gravity gradient and the CMG law add about 1 µs per frame at 1×.
- Under sleep 1e4, ≤ 0.05 ms per frame typical, ≤ 0.1 ms with desaturations in the worst LVLH attitude.
- Memory: the tables are about 60 KB per hull unpacked, plus 4 KB per body. Page ≈ 16 KB (build-time data).
- Save +0.2 kB.

**Tests.**
- Libration period within 2% of 2π/(n·√(3(I_y − I_z)/I_x)).
- Total L = Iω + h is conserved torque-free.
- Desaturation drives h to 0 and spends propellant.
- **1 real minute of sleep at 1e4 with GG: attitude within the deadband, mean warp ≥ 0.9e4**, for both a
  stability hold and a misaligned prograde hold (the desaturation case).
- A stability hold over 10 orbits never desaturates; a misaligned LVLH hold desaturates at the predicted
  interval and the body rate stays within the hold's deadband during it.
- A station started at its gravity-gradient equilibrium stays within 1° of it over 10 orbits without its pilot.
- Station orbit radii are unchanged by the new profile, and no 'atmosphere' event fires at 547 km.
- The aero table gives zero side force at β = 0 for the symmetric hull; nose and belly within 5% of 57 and
  655 m²; the correct pitch-stability sign; damping removes an oscillation.
- Hydrostatic table: p₀ = ρ₀·g·H₀ within 1%.
- An Earth-like test body gives ρ(100 km) within ×1.5 of 5.6e-7 kg/m³.
- Coast-perturbation decay matches fine forced integration within 2%.
- Station-gravity drift is 1.5·f·t² within 5%.
- Sea-level thrust loss is p_a·A_e.

**The owner notices.**
- With the hold off, the ship slowly swings to the vertical.
- With it on, the CMGs whine and the jets puff now and then to desaturate.
- Belly-first braking is about 10× harder; the ship weathervanes; banking the lift steers the corridor.
- The Wheel has moved a little after a sleep.

**Risks.**
- Aerobraking corridors move by about 10 km.
- The bake on the load path.
- The predictor's attitude assumption must be stated.
- A station without a hold would tumble.

#### W2-C Contact II: soft-capture docking, stations as gyrostats, landed contact, located damage, refuelling

**Goal.** Docking is a touch. The Wheel spins for real. Damage is where the hit was. A dry ship can be refuelled.

**Files.**
- World: `src/world/contact.ts`, `src/world/compound.ts`, new `src/world/stations.ts` (layout → mass and
  inertia, rotor), new `src/world/damage.ts`.
- Data: `src/data/stationLayouts.ts`, `src/data/hullColliders.ts` (zone tags), `src/data/systems/tallow.ts`
  (text only).
- Tests: `tests/compound.test.ts`, `tests/stationLayouts.test.ts`, new `tests/docking.test.ts`,
  `tests/damage.test.ts`.

**Model.**
1. **Soft capture** (`fc-dock-capture-standoff`, `systems-dock-latch-capture`, `fc-latch-auto-arm` mechanics).
   - The latches close only on collar–port contact, with the **LATCH ARM** device on (W2-D adds it; the
     auto-arm within 1 km is deleted).
   - The envelope is lateral ≤ 0.3 m, angle ≤ 10°, closing speed ≤ 0.3 m/s. **Decision:** that is 3× the IDSS
     values (0.1 m, 5°, 0.1 m/s), loosened for a phone.
   - The ring is a 6-DOF spring-damper between the bodies at the contact point: k = 5e4 N/m axial and lateral,
     k_θ = 5e5 N·m/rad, ζ = 0.6 with c = 2ζ√(k·m_eff), stroke ±0.3 m and a hard stop beyond it. Linear and
     angular momentum are exchanged through the solver. With m_eff ≈ the Wren's 43–67 t the axial period is
     2π·√(m/k) ≈ 5.8–7.3 s (not 5.4 s) and it settles in about 10 s (1/(ζω) ≈ 1.9 s). A 0.3 m/s capture peaks at
     ≈ 0.17 m of stroke (inside ±0.3 m) and ≈ 21 kN, i.e. 0.3 m/s² at the crew — the boots hold. The angular ring
     (k_θ = 5e5 N·m/rad on I ≈ 6e6 kg·m²) has a ≈ 22 s period and settles in ≈ 30 s; retraction waits for it.
   - **Retraction:** a hook motor (force limit 10 kN, 5 mm/s) draws the stroke to zero over about 60 s. The hard
     joint (today's kinematic joint) forms only at offset < 5 mm and angle < 0.2°.
   - The `capture` warp reason applies while attenuating (≤ Q). Retraction may take steps of 0.5 s.
   - This removes today's 4 m / 20° freeze and the 240 m/s² capture spike that W1-C's crew would feel.
2. **Thrust while docked loads the latch** (`prop-docked-latch-load`).
   - The rule that zeroes throttle, RCS and torque goes (it lives in `flight.ts`, so W2-B deletes it on W2-C's
     request). The ship's thrust and jets act on the docked stack.
   - Latch load F_l = |F_ship − m_ship·a_stack| and moment M_l. Ratings: axial 1.5e5 N, shear 5e4 N,
     moment 1.5e5 N·m.
   - Above a rating the latch breaks: the joint is released with its stored spring energy and a damage event.
   - DRIVE ARM stays, as the pilot's own switch.
3. **Stations from their layouts** (`env-station-rotor-spin`).
   - Mass and inertia come from module volumes × density (habitat about 120 kg/m³ of enclosed volume, trusses
     per metre). The Wheel is expected near 1e10 kg. `stationMassProps(layout)` (day 1, §1.4) is what W2-B's
     `setup.ts` calls; the initial gravity-gradient equilibrium attitude and ω = n are set there too (W2-B).
   - Rotor: I_ring = m_ring·r² (about 8.7e13 kg·m² at 5e8 kg and 418 m), Ω from data (D5),
     h = I_ring·Ω along +Y (`rotorH`, which W2-B's Euler term uses).
   - Angle θ = θ₀ + Ω·(t − t₀) in doubles, analytic under any warp. The renderer reads it (W2-F).
   - Contacts against rotating colliders use the collider velocity Ω × r and transform the spokes by θ. The
     impulse changes the rotor's h.
   - Fix the text in `tallow.ts`: "twice a minute", "400 km", "above the dusk belt".
4. **Landed** (`prop-ground-thrust`).
   - Liftoff happens when the contact normal force reaches zero. Delete the 1 cm `rel *= 1 + 0.01/r` snap.
   - Thrust and jets act through the contact: the pin holds while |F_t| ≤ μ_s·F_n (μ_s = 0.6), and the ship
     slides otherwise.
   - Tipping: the torque about the edge of the support polygon (from the compound's support points) releases
     the pin into a rigid body in compound contact.
5. **Located damage** (`damage-localized-components`, `systems-structural-failure-thresholds`).
   - The manifold point gives a zone tag: nose cap, 4 cockpit panes, lounge window, wings L/R, pods L/R,
     4 RCS quads, 2 radiators, dorsal collar, belly fore/aft, tanks.
   - Energy split by compliance: E_i = E·(1/k_i)/Σ(1/k), with k_ship = 1e7 N/m and k_station = 1e9 N/m, so the
     ship takes 99%. This fixes today's double counting.
   - Capacities and effects:
     - window: cracks at 10 kJ, breaks at 30 kJ (giving a breach area for W3-B);
     - RCS quad: disabled at 50 kJ, and its jets leave the allocation table (rebuild it);
     - drive pod: 500 kJ, thrust × health;
     - radiator: 100 kJ, rejection × health;
     - hull panels: 1–5 MJ/m³ × zone volume.
   - `hull` becomes the derived mean of the structural zones.
   - **Graded overload:** limit 6 g, ultimate 9 g, D += ((n − 6)/(9 − 6))·dt/2 s, with n = |fAcc/accT|/(m·g₀).
     This replaces the 15.0 g death.
   - Landing damage comes from the contact energy, not from a 5 m/s cut.
6. **Refuelling** (`prop-refuel`, `systems-dock-propellant-transfer`).
   - Hard-docked with the FUEL valve open (a W2-D device): ṁ = C_d·A·√(2ρΔp), with C_d = 0.6, a 50 mm line,
     LH2 ρ = 71 kg/m³ and Δp = 3 bar, giving **7.7 kg/s**. A full 22.5 t takes about 49 min.
   - The hydrazine line runs at 0.5 kg/s.
   - The station's supply is finite (the Wheel holds 2e6 kg of LH2).
   - Constant flow is exact under warp.
7. Emit `latch`, `capture`, `undock` and `contact` events.

**Budget.** About 1 µs per step during a capture, 0 otherwise. Save +0.5 kB.

**Tests.**
- A capture conserves linear and angular momentum to 1e-9 relative.
- A 0.3 m/s centred capture never reaches the hard stop and peaks below 0.5 m/s² at the crew; a 0.5 m/s one
  bounces off (outside the envelope) instead of latching.
- A centred capture ends with offset ≤ 5 mm; an off-centre one torques the station.
- The rim impact speed equals |Ω × r|.
- The rotor angle after 1e5 s of warp is analytic.
- The latch breaks above its rating.
- Liftoff has no position jump.
- Damage lands in the hit zone, and the compliance split sums to E.
- The refuel rate is analytic.
- Overload damage accumulates.

**The owner notices.** The ship touches the port, rocks on the ring and is drawn in square. Brushing the Wheel's
rim is a hard impact. A scrape cracks a pane or kills a quad, and the ship rolls when it should translate.
Opening the fuel valve makes the gauge climb.

**Risks.** Docking gets harder. contact.ts has just been rewritten by the hull-shape engineer. Station masses
change other numbers (station gravity).

#### W2-D Ship systems I: heat, power, air, life support, devices, cautions (hub)

**Goal.** Heat, power and air are real states with physical controls and consequences.

**Files.**
- World: new `src/world/thermal.ts`, `src/world/power.ts`, `src/world/cabin.ts`; `src/world/state.ts`,
  `src/world/world.ts`.
- Game and app: `src/core/types.ts`, `src/game/session.ts`, `src/game/api.ts`, `src/app/app.ts`, `src/app/perf.ts`.
- Data: `src/sim/ships.ts`, `src/data/cockpit.ts`, `src/data/interiors.ts`.
- Tests: `tests/ships.test.ts`, `tests/session.test.ts`, new `tests/thermal.test.ts`, `tests/power.test.ts`,
  `tests/cabin.test.ts`.

**Model.**
1. **Thermal network** (`heat-hull-environment`, `heat-internal-sources-radiators`,
   `env-space-thermal-environment`, `env-entry-heating-zones`, `prop-engine-heat`, `heat-engine-nozzle-afterglow`
   nodes, `cabin-thermal-window-fog` heat part). About 36 nodes:
   - 12 skin zones (aluminium 3 mm, 7.3 kJ/m²K). The windward zones carry a TPS tile layer (25 mm, ρ = 140,
     c = 1000, so 3.5 kJ/m²K; ε = 0.85; limit 1900 K).
   - 3 structure nodes; 2 nozzle skirts (Nb, 300 kg, c = 350, ε = 0.8, A = 8 m²); 2 radiator panels; a coolant
     loop; a reactor bay; an avionics bay.
   - 10 cabin air and furnishing nodes (shared with cabin.ts); about 4 window-pane groups.
   - Each node obeys
     C_i·dT_i/dt = Q_sun + Q_alb + Q_IR + Q_aero + Q_int − ε_i·σ·A_i·(T_i⁴ − T_bg⁴) − Σ_j G_ij·(T_i − T_j).
   - **Sun:** S = L/(4πd²) (1243 W/m² at Wick). The shadow factor ν is the analytic disc overlap of the star by
     the primary. Projected area per zone and direction is baked with the aero table (12 zones × 256 directions,
     12 KB).
   - **Albedo** and **planet IR** use sphere-plate view factors, which are 0.85 = (R/r)² at 547 km for nadir.
     Wick is tidally locked, so its night side is cold (about 150 K); an eclipse equilibrium falls near 150 K.
   - **Internal sources:** crew 80–250 W by activity; avionics 2 kW; lights from the bus; reactor waste
     P_e·(1 − η)/η with η = 0.3; drive waste ε_d·½·ṁ·vₑ² with **ε_d = 4.4e-4 (D4)**, about 6 MW at full throttle,
     80% to the pods; CMGs 0.4–1.2 kW.
   - **Window sunlight** τ = 0.8 × S·ν·A_win·cos θ × (1 − shutter) goes into the room nodes. At 4–10 kW it
     dominates the cabin.
   - **Window shutters (added in review).** Crewed windows have external covers (the ISS Cupola has seven).
     Without them the only way to stop the cockpit heating by kelvins per minute in direct sun is to turn the ship.
     One shutter per window group, a motorised cover (60 W while moving, 4 s travel) on a cockpit or wall device;
     closed it passes no light or sun heat, stops screen washout, and protects the pane (W4 micrometeoroids).
   - **Radiators** (D4 default): a pumped liquid-metal loop up to 1100 K into 2 two-sided deployed panels of
     13 m² (A = 52 m²): ε·σ·A·T⁴ ≈ 3.7 MW at 1100 K (ε 0.85). Pump transfer Q = ṁ·c_p·ΔT is a device-controlled
     flow. *Review note:* NaK-78 boils at about 1058 K at 1 bar, so a 1100 K NaK loop must be pressurised
     (≈ 2 bar); lithium is the usual choice above ~1100 K. Either is fine; the data must say which.
   - **Interlocks:** `driveInhibit` when a pod exceeds 1800 K or the loop exceeds 1150 K.
   - **Integration:** backward Euler with the radiation term linearised (4εσT³). Every 12 ticks at 1×; one step
     per ≤ 30 s under warp; it consumes `heatIn`.
     - *Review correction:* a fixed 6 Gauss–Seidel sweeps does not converge when a node's conductances dwarf
       its C/h (small panes and air nodes at h = 30 s), and an unconverged solve does not conserve energy, so
       the "closes per orbit to ≤ 1e-6" test would fail. The matrix is symmetric positive definite: use a dense
       Cholesky of the 36×36 system (≈ 8k multiply-adds, ~10 µs on the A16, at 10 Hz ≈ 0.003 ms per frame),
       or iterate GS to a residual of 1e-10 of the step's energy. Store links as CSR adjacency: in a review
       prototype the CSR step cost 3.3 µs in node against 40 µs for a scan over all links
       (`scratchpad/sim-audit/plan-review/thermal.mjs`).
     - Energy is booked with the same linearised radiation flux the solve used.
   - **Failure by zone temperature** (seals 450 K, aluminium 775 K, TPS 1900 K) goes into the zone health of W2-C,
     not "heat ≥ capacity, whole craft destroyed". The negative-`heatDissipation` runaway disappears with the
     constant.
   - `heat`/`heatCapacity` stay as derived values until W2-F moves the render. The pins at
     `tests/ships.test.ts:291-292` are changed deliberately.
2. **Electrical** (`power-electrical-bus`, `lights-powered-photometric` sim part).
   - The **drive bus** carries reactor electric output (2 × 14 MW rated) to the torch at 5 MW per engine.
   - The **hotel bus** runs at 120 V DC: a 50 kWh battery (1.8e8 J), V = V_oc(SOC) − I·R_i with V_oc 112–126 V
     and R_i = 0.02 Ω.
   - Loads: lights 15–40 W per fixture; screens 30 W each; avionics 600 W; CMGs; fans 0.6 kW; scrubber 0.5 kW;
     RCS valves 40 W each while open; thermostatic heaters and coolers up to 5 kW; floods 2 × 200 W; nav lights
     50 W; shore power 50 kW when docked.
   - The reactor follows demand at a 2 %/s ramp (W3-B's first-order core replaces it). *Review note:* at
     0.56 MW/s a cold reactor needs ≈ 18 s to carry one engine's 10 MW, which would silently add 18 s to the
     0.5 s ignition delay. So **DRIVE ARM is also the reactor's "drive standby"**: arming raises the setpoint to
     the drive load, and the torch cannot light until the drive bus carries it (a physical procedure: arm, wait,
     light). The drive-bus voltage is on the SYS page.
   - Breakers trip on thermal I²t: ∫(I² − I_r²)·dt > 5 s·I_r². Lamp flux ∝ (V/V_nom)^1.5. Electronics trip on
     undervoltage below 100 V.
   - The bus is solved algebraically per thermal tick; SOC is exact for piecewise-constant power.
3. **Cabin gas** (`air-room-gas-network`).
   - 10 rooms, with V from the boxes minus solids: cockpit 27.7, lounge 89.1, cargo 107.5, engineering 39.2 m³,
     370.5 m³ in total.
   - Each room holds N₂, O₂, CO₂ and H₂O masses, with T from the thermal air node; p = Σ n·R·T/V.
   - Doors are open in wave 2 (leaves come in W3-B). Orifice flow ṁ = C_d·A·√(2ρΔp) with A = 2.1 m² and
     C_d = 0.6, solved implicitly by elimination on the door tree. Fans exchange 0.2 m³/s between neighbours.
   - Humidity: crew 2 kg/day. The dew point comes from a table (not `Math.log`). Condensation on cold panes
     integrates a fog fraction per pane, which W2-F renders.
   - Implicit steps of ≤ 10 s under warp.
4. **Life support** (`life-support-consumables`).
   - Metabolism scaled by activity W: O₂ 0.84, CO₂ 1.0 and H₂O 2.0 kg per day at 100 W.
   - Scrubber removal η·Q·ρ_CO₂ (η = 0.9, Q = 0.01 m³/s, 0.5 kW).
   - O₂ from a 100 kg high-pressure tank through a regulator at 21 kPa.
   - With the scrubber off: CO₂ rises 149 Pa/day and O₂ falls 173 Pa/day.
   - ppO₂ and ppCO₂ per room are exposed (W3-D uses them).
5. **Devices in `data/cockpit.ts` and `data/interiors.ts`.**
   - LATCH ARM (guarded toggle).
   - FUEL LH2 and FUEL N2H4 valves.
   - EXT LIGHTS: floods, nav and strobe toggles, replacing the dummy toggles; the COMMS dummies are deleted
     (`inst-dummy-switches`).
   - MASTER CAUTION (lamp plunger).
   - An engineering breaker panel (8 hotel circuits, push-pull), reactor output lever and scram guard, fan and
     scrubber switches.
   - Per-room light switches, replacing the single lounge toggle.
   - Window shutter controls (cockpit panel and one per room window).
   - The wrist boot-magnet switch W2-E needs (D8): a body-mounted device of reach 'arm'.
6. **Master caution** (`inst-caution-warning`). Latched thresholds with hysteresis:
   - either pool < 10%;
   - any zone > 0.8 × its limit;
   - range < 200 m while closing at > 0.5 m/s;
   - predicted periapsis below `atm.top` (the ρ = 1e-7 level, not W2-B's table top);
   - predicted impact within 10 min;
   - battery < 20%;
   - ppCO₂ > 1 kPa, ppO₂ < 16 kPa;
   - a breaker trip.
   **A caution wakes the sleeper** (today only contact wakes them).
7. **Hidden or locked page** (`perf-hidden-time-stops`, D6). The hidden wall time becomes a debt, repaid under
   the honest warp machinery and capped at one sim day. Hitches longer than 0.1 s are repaid too, not dropped.
8. **Session hooks.** Natural wake (W2-E). The app.ts look snap on entering the helm is deleted once W2-E's
   transitions land. Views: `SystemsView`, `DockingView`.

**Budget.** Thermal about 3 µs per step in node (6–8 µs on A16) at 10 Hz, about 0.001 ms per frame; under 1e4,
6 steps per frame ≈ 0.05 ms. Gas is similar. The bus < 0.3 µs. Save +2–3 kB.

**Tests.**
- A flat plate reaches T = (αS/(εσ))^¼ = 296.6 K at α/ε = 0.3/0.85.
- The eclipse fraction is 37.4% of the **94.5 min** orbit (a = 7090.5 km, μ = 4.38e14: T = 2π√(a³/μ) = 5669 s;
  asin(6543/7090.5) = 67.4°), i.e. 35.3 min of shadow. (The systems audit's 91 min used the wrong 420 km.)
- Energy closes per orbit to ≤ 1e-6 relative.
- Backward Euler at 10 s stays within 0.5 K of fine RK4 over an orbit.
- 1× vs 1e4 within 1 K.
- SOC is exact at any step.
- Gas mass is conserved across doors.
- CO₂ rises 149 Pa/day with the scrubber off.
- The I²t trip time.
- A caution wakes a sleeper.
- The thermal step conserves energy to 1e-9 per step at h = 30 s with the smallest pane node in the network.
- A closed shutter gives 0 W of window sunlight and 0 lux through that window.
- With DRIVE ARM off the torch cannot light; armed, it lights only once the drive bus carries the load.
- The debt repays honestly.

**The owner notices.**
- The hull temperature cycles every orbit; long burns heat the ship and the drive cuts itself.
- Lights are switches with consequences; a sagging battery dims the lamps.
- The cockpit warms in direct sun.
- The ship wakes them for danger.

**Risks.** This is the largest package and the hub. Catalogue numbers change, and pinned tests with them.

#### W2-E Body II: hands, transitions, reach, tides, natural sleep

**Files.**
- World: `src/world/crew.ts`, `src/world/props.ts`, `src/world/devices.ts`, `src/world/events.ts`.
- `src/render/camera.ts`, `src/app/input.ts`, `src/data/props.ts`, new `src/data/handholds.ts`.
- Tests: `tests/crew.test.ts`, `tests/props.test.ts`, `tests/devices.test.ts`.

**Model.**
1. **Handholds** (`body-handholds-grab-ship`).
   - Rails along the corridor, door frames, console edges, and first the cockpit pillar handles already drawn
     (`render/space/cockpit.ts`, pillar grab handles).
   - A grip is a force-limited critically damped spring between the grip point and the shoulder: ω = 25 rad/s,
     |F| ≤ 350 N, arm 0.72 m. It slips above the limit.
   - Input: a head-touch on a surface within reach while floating means grab.
2. **Sit, stand, strap-in, lie** (`body-sit-stand-strap-snaps`, `body-lying-head-frame`, `eye-head-dynamics`).
   - A force-limited PD moves the pelvis along a path: legs ≤ 600 N, arms ≤ 200 N, ω = 7 rad/s, ζ = 1. The
     duration emerges, 0.6–1.2 s.
   - The head pitch toward the console is a neck rotation at ≤ 250°/s.
   - Standing up in zero g keeps the legs' velocity.
   - Lying: the body frame follows the bed, with neck limits, so the camera gains roll.
3. **Push-off** (`body-pushoff-jump-physics`). The impulse direction must lie within the friction cone (≤ 35°
   from the touched surface's normal). Legs give ≤ 1 kN over 0.25 s (≤ 3.1 m/s, after peeling the magnets);
   arms ≤ 300 N over 0.3 s (1.1 m/s). The flick speed maps to effort.
4. **Posture shapes for the props** (`body-props-pose-helm`). A seated capsule pair (torso and thighs), a lying
   capsule along the bunk, and a helm body that props can hit. A throw from a seat pushes the body.
5. **Reach** (`body-reach-arm`). Shoulders at ±0.19 m lateral and 0.25 m below the eye, arm 0.72 m, lean
   ≤ 0.25 m standing and ≤ 0.1 m harnessed. Occlusion is a segment against the boxes, cached at 5 Hz. One shared
   constant set for devices and props.
6. **Tidal acceleration** (`env-tidal-accel-in-cabin`, `body-tidal-gradient`). a = n²·(3r̂(r̂·p) − p) with
   n² = μ/r³ = 1.23e-6 s⁻². It applies to the crew and to props in drift mode (closed form for linear terms).
   A body released 5 m along the vertical moves 1 m in about 330 s.
7. **Natural wake** (`body-sleep-metabolism`). Borbély model:
   - awake: dS/dt = (1 − S)/18.2 h; asleep: dS/dt = −S/4.2 h;
   - C(t) = 0.12·sin(2πt/24 h + φ) on the ship clock;
   - wake when S − C < 0.17 (about 7 h of ship time **after a full 17 h waking day**).
   - Closed-form exponentials. Falling asleep keeps today's rule (D7).
   - **Hazard found in review — gated on D7, default off.** Awake time runs at 1×, so an owner who plays an
     hour has accrued one hour of sleep pressure: S rises from its post-sleep 0.12 to only ≈ 0.17, and the
     wake rule fires within minutes of lying down. Built as specified, natural wake would take away sleep warp,
     the game's only time acceleration, after the first night. W2-E builds S and C (state, closed forms,
     tests), exposes them, and enables the wake rule only once the owner answers D7. Until then sleep ends on a
     touch or a caution (W2-D), as today.
8. **Boots switch** (D8). A wrist device toggles the magnets.

**Budget.** 1–3 µs per frame while gripping. Save +0.1 kB.

**Tests.**
- A grip arrests a 1 m/s float within the force limit.
- A transition conserves momentum in zero g.
- Push-off inside and outside the friction cone.
- Props bounce off the seated pilot.
- Tidal drift against the exact solution of the linear ODE p̈ = n²(3r̂r̂ᵀ − I)p (with the rotating-frame terms
  when the ship turns): released 5 m out along the vertical from an inertially fixed ship, 6 m is reached at
  t = arccosh(1.2)/(√3·n) ≈ 324 s (the ½at² estimate gives 330 s).
- The sleep length is about 7 h from the steady 17 h / 7 h cycle; after 1 h awake it is under 1 h (the D7
  hazard, as a test so the answer is visible).

**The owner notices.** Knocked loose, they catch a handle. Sitting down is a motion. Lying down, they look up at
the overhead. A floating mug drifts toward the bow over minutes. (A night's sleep ends by itself only once D7
is answered.)

#### W2-F Senses II: sound and light from the new states

**Files.** `src/audio/*` and `src/render/*` (all of it, including `probes.ts`, `rt/*` and
`space/interior.ts`/`interior.bake.ts`, except what W3-C/W3-D take later). Render tests and the shot harnesses.

**Work.**
- **Audio.**
  - Room acoustics (`sound-room-acoustics`): Sabine RT60 = 0.161·V/ΣSα (Eyring above α 0.2) from the boxes,
    with α 0.05–0.1 for metal and 0.3 for soft furnishings; an 8-line FDN of native nodes (each delay ≥ 128
    samples); 6 early-reflection taps.
  - CMG whine: 110 Hz plus bearing ball-pass ×3–5 plus PWM (`sound-attitude-actuators`).
  - Machinery driven by the bus: fan rpm from bus voltage and switch, pumps, reactor hum.
  - The air-path gain from the cabin pressure (`sound-cabin-air-medium`).
  - Thermal creaks at a rate ∝ |dT/dt| of the skin zones, as `creak` events (`sound-thermal-creak`).
  - The caution horn; capture clank and hooks; Mach from W2-B for the transonic buffet.
  - Delete the UI tick hook in `ui/kit/kit.ts`.
- **Light from temperature** (`fx-reentry-thermal-glow` part 2, `heat-engine-nozzle-afterglow` render).
  - Hull, TPS, nozzle and radiator glow from W2-D temperatures through a Planck LUT (T → linear RGB radiance,
    visible above about 800 K), 12 per-zone emissive uniforms.
  - A niobium skirt fades from 1600 K through red in about 28 s after cutoff.
- **Powered lights** (`lights-powered-photometric`, `light-exterior-artificial`, `inst-decorative-wall-screens`).
  - Per-room lightmap gain from the bus. Splitting the bake channels per room is the honest form; use it if the
    memory measurement allows, else a per-room gain.
  - Status lamps blink from the state they report.
  - Nav lights and a 1 Hz strobe on sim time, only when powered.
  - Floods as analytic spot terms on station and hull materials: I = 20,000 lm/(2π(1 − cos 15°)) ≈ 9.4e4 cd, so
    about 100 lx at 30 m. Station floods light the Wren within 300 m.
  - Window glow seen from outside = interior luminance.
  - The lounge wall screen shows ship clock and orbit at 1 Hz; the other stencil screens become dark glass.
- **Sun and shadow** (`light-craft-shadows`, `light-rt-dynamic-casters`).
  - Station capsules as analytic sun occluders, CPU-culled to ≤ 3 per frame and passed as uniforms. Penumbra
    width 2d·tan(0.70°), so 1.2 m at 50 m. **Both ways:** the Wren's own capsules also shadow the station's
    materials, so its shadow falls on the port during an approach with the sun behind.
  - RT dynamic casters: ≤ 32 prop OBBs plus device handles as slab tests after the BVH miss (≤ 0.3 ms, under
    the §1.2.2 gate).
- **Planetshine** (`light-planetshine-area`, `light-planetshine-lower-tiers`, `env-starlight-planetshine-radiance`
  part).
  - SH9 from 64 samples of the visible cap (baked albedo low mip × max(0, n·s) × E_sun/π, plus air) every 4
    frames, into a LightProbe and the interior windows on **every** tier through the window form factor.
  - The Lambert phase is used for distant worlds.
- **Interior bounce on non-RT tiers** (`light-interior-bounce-non-rt`). One-bounce radiosity per room:
  E_amb = Φ_patch·ρ/(S_room·(1 − ρ_mean)).
- **Window optics** (`eye-window-optics`). Fresnel at n = 1.46 per surface; 3–4 panes give (1 − R)^(2N) ≈ 0.75–0.85
  transmission; cabin reflection from the room probe; ghost taps on the raster tiers; the fog fraction from
  cabin.ts. **Shutters** (`rev-window-shutters`): the cover is drawn and multiplies the window's transmission
  (and the RT window-opening factor, a uniform, so the static BVH is untouched).
- **Screens light the desk** (`inst-screens-not-light-sources`). The screens and the cockpit's static surfaces
  never move, so the closed-form polygon irradiance (form factor) from each screen to each static texel is
  **baked once** into a lightmap channel (two screens → one RG channel); at run time it is multiplied by the live
  mean screen colour (a 16×11 downscale at each redraw): one texture tap, ≈ 0.02 ms. Only moving receivers (the
  stick, props, the hands) use the per-fragment analytic form. In the RT composite under the gate.
- **Station rotor** drawn from the sim angle, replacing the private `min(0.25, dt)` clock in `stations.ts`.
- **Prediction note** on screen: "path assumes attitude held". Draw the device parts for the new W2-D devices.

**Budget.** Audio thread total ≤ 3%. GPU at RT High within what W1-E freed; raster ≤ +0.5 ms. Memory ≤ 3 MB
(one extra lightmap layer, if chosen).

**Tests.**
- The Planck LUT matches black-body chromaticity within ΔE 2.
- The baked screen form factor matches the analytic polygon irradiance within 2% at sample desk points.
- The SH9 projection is exact for a known radiance.
- The rotor angle equals the sim's.
- Gain is 0 when a breaker is open.
- The shot harness at night and in eclipse.

**The owner notices.** Glowing edges after an aerobrake fade over minutes. The lights in each room are their own.
The floods light the port in the shadow. The Wheel's spokes sweep shadows through the windows. Wick lights the
window side of the cabin.

### Wave 3 — mass that moves, compartments, sensors, a body that can be hurt, the eye

#### W3-A Mass properties, engines and structure, small perturbations

**Depends on D2 (tank layout).**

**Files.**
- World: `src/world/dynamics.ts`, `src/world/setup.ts`, `src/world/control.ts` (allocator, TVC),
  `src/world/compound.ts` (gyration about the CoM), `src/world/contact.ts` (CoM offsets), `src/world/ephemeris.ts`
  (J2 between bodies).
- Data: `src/sim/ships.ts`, `src/sim/universe.ts`, `src/data/shipLayouts.ts`, `src/data/hullColliders.ts`.
- Tests: `tests/worldCraft.test.ts`, `tests/compound.test.ts`, new `tests/massprops.test.ts`.

**Model.**
1. **Mass properties** (`mass-com-inertia`, `fuel-tanks-com-transfer`).
   - Dry structure comes from `compoundGyration` about the dry CoM. The hull centroid sits 1.7 m aft of today's
     declared CoM, and its roll inertia is 3.6× lower than the box.
   - Tanks at their positions: m = Σm_i; c = Σm_i·r_i/m; I_c = Σ[I_i + m_i·(|d|²E − d·dᵀ)].
   - The full-tensor Euler equation ω̇ = I⁻¹(τ − ω × (Iω + h)), with I and I⁻¹ **recomputed on every powered
     step** (54 ns). *Review:* a "recompute when the mass changed by > 1 kg" rule makes I⁻¹ depend on history, so
     a save loaded between two recomputes would continue with a different I⁻¹ and break bit-identity.
   - Every ship-frame consumer is offset by c: render mesh, colliders, crew feltAt, collar, jets. The allocation
     table is rebuilt when |c − tableCom| > 2 cm, and `tableCom` is saved, so the table rebuilt at load is the one
     in use when the save was made.
   - Crossfeed and draw-order valves (same fluid only) as devices; transfer pumps at 5–20 kg/s.
2. **Thrust line, gimbal, differential throttle** (`prop-thrust-line-gimbal`, part 2).
   - The pods' lines now pass through the design CoM and drift as c moves.
   - Gimbal ±4° at 15°/s with a first-order lag of 0.1 s, pivot at z = 13.5 m: authority 400 kN × 13.5 m ×
     sin 4° ≈ 0.38 MN·m per engine.
   - TVC takes pitch and yaw during burns, so the RCS stays quiet. Differential throttle ±10% in yaw.
   - Engine-out yaws the ship.
3. **Slosh and ullage** (`prop-slosh-ullage`).
   - An equivalent spring-mass per tank (Abramson, NASA SP-106): m_s = 0.4·m_liquid at half fill;
     ω² = 1.84·a_eff/R; ζ = 0.02 bare, 0.05 with baffles. Exact damped-oscillator update.
   - In free fall (a_eff < 1e-3 m/s²) the liquid is unsettled. Settling needs ullage thrust for t ≈ √(2R/a).
   - Ignition with an unsettled fraction > 0.5 fails: no thrust, 1 kg vented.
4. **Hull flex** (`struct-flex`, `body-hull-flex-at-cockpit`).
   - Two modes, 6 Hz and 14 Hz (est.), ζ = 0.02, exact update.
   - Driven by thrust steps and by contact and latch impulses.
   - The cockpit's modal acceleration Φ·q̈ goes into ShipMotion (the harness feels it).
5. **RCS pulse mode** (`prop-rcs-pwm`).
   - On/off jets on a 50 ms PWM frame, minimum on-time 30 ms, valve delay 10 ms.
   - MIB = F·t_min (680 N·s ≈ 1 cm/s on 67 t).
   - Pulse-mode exhaust velocity vₑ·(1 − 0.2·e^(−t_on/0.05)).
   - Step edges align to pulse edges; a settled hold costs 0 under warp.
6. **Perturbation riders.**
   - J2 (`env-j2-oblateness`): J2 = 0.165·q = 0.011 for Sconce, on craft whose primary is Sconce and on the moon
     pairs in the ephemeris, with the reaction. Renderworks precesses about 1.9°/day.
   - Solar radiation pressure (`env-srp`): F = (S/c)·Σ A_i·cos θ_i·[(1 − ρ_s)·ŝ + 2ρ_s·cos θ_i·n_i]·ν, from W2-D's
     projected-area table, as a coast perturbation.
   - Crew and prop mass and momentum exchange (`body-momentum-mass`, `mass-crew-props-cargo`): applied from the
     `extImpulse` that W3-D emits.

**Tests.**
- The parallel-axis tensor against a brute-force sum.
- Save → load in the middle of a long burn (CoM moving, table rebuilt once) continues bit-identically.
- Draining a tank shifts c by the analytic amount.
- L is conserved with the full tensor.
- TVC holds attitude through a burn with the RCS duty < 2%.
- Slosh frequency within 2% of the formula.
- An unsettled start fails.
- Flex energy decays at ζ.
- J2 nodal rate within 3%.
- MIB granularity.

**The owner notices.** Agility changes as tanks drain. The bells swivel during burns. An ullage tap is needed
before lighting. A shudder when the latch slams. Pulsed puffs and thumps.

#### W3-B Ship systems II: compartments, breach, doors, hatch, reactor, cryo (hub)

**Files.**
- World: `src/world/thermal.ts`, `src/world/power.ts`, `src/world/cabin.ts`, `src/world/damage.ts`,
  `src/world/state.ts`, `src/world/world.ts`.
- Game and app: `src/core/types.ts`, `src/game/session.ts`, `src/game/api.ts`, `src/app/app.ts`.
- Data: `src/data/interiors.ts` (door leaves, door buttons, hatch, airlock), `src/data/stationLayouts.ts`
  (station cabin state).
- Tests: `tests/cabin.test.ts`, `tests/thermal.test.ts`, `tests/session.test.ts`.

**Model.**
1. **Breach** (`air-breach-decompression`).
   - Choked flow ṁ = C_d·A·p₀·√(γ/(R·T₀))·(2/(γ+1))^((γ+1)/(2(γ−1))), i.e. 239 kg/s per m² × C_d at 101 kPa
     and 293 K.
   - Isentropic cooling T ∝ p^((γ−1)/γ), with a fog flash below the dew point.
   - Vent force F = ṁ·u* + p*·A (u* = 313 m/s, p* = 0.528·p₀), applied at the hole normal into the ledger. The
     craft counts as powered for chooseDt; the predictor is told (`venting`).
   - A sink-flow field u = Q/(2πr²) toward the hole drives drag on bodies and props (W3-D reads it).
   - 5 ms sub-steps, warp reason `venting`.
   - Losing the 4.2 m² lounge window: about 445 kg of air, Δv ≈ 3.5 m/s, yaw rate ≈ 0.2 rad/s within about 1 s.
     A 1 cm² crack e-folds in 7.4 h.
2. **Doors** (`doors-physical-pressure`).
   - A 40 kg leaf, a 300 N current-limited motor, 0.9 m of travel in 1.2 s, with friction.
   - Δp·A holds a door shut (2.1 kN per kPa). It auto-closes on a pressure-drop sensor (0.5 kPa/s).
   - A manual crank device.
   - The leaf is a moving collider for the crew and props (the `dynamicBoxes` slot W3-D adds) and an RT dynamic
     object (W3-E). A_eff = width × open fraction.
3. **Hatch, airlock, ramp** (`hatch-dock-airlock`).
   - A hinged hatch with dogs. It opens only at Δp < 0.2 kPa, after the equalisation valve.
   - Docked: an air umbilical exchanges with the station's cabin.
   - Airlock: S = 0.04 m³/s over 2.5 m³, so τ = 62 s; it reaches 2 kPa in about 4 min, then vents.
   - The ventral ramp has hydraulic rams and opens only at Δp ≈ 0.
4. **Reactor** (`reactor-dynamics-controls`).
   - A first-order core with τ = 30 s toward the rod setpoint.
   - Scram: decay heat 0.066·P₀·t^(−0.2) in closed form.
   - Core glow from core power (W3-E). Engineering devices (from W2-D).
5. **Cryo** (`systems-cryo-boiloff`).
   - Heat leak Q = 0.5 W/m² × 100 m² = 50 W, so boil-off Q/h_fg ≈ 9.7 kg/day uncooled.
   - Cryocooler P = Q·(T_h/T_c − 1)/η_rel ≈ 4.7 kW at η_rel = 0.15, on the bus.
   - **Boil-off has to go somewhere (added in review).** With the cooler unpowered, tank pressure rises and the
     relief valve vents gaseous H₂. Real ships vent through a balanced (non-propulsive) pair; model the vent as
     two opposed nozzles with a 2% imbalance, written to `vent` (≈ 1e-4 kg/s at ~500 m/s gives 0.06 N per side,
     so ≈ 1e-3 N net and ≈ 2e-8 m/s² — SRP-sized, applied as a coast perturbation,
     and a `vent` event for a hiss through the structure). The cold gas plume is the first ship-side **cause**
     for W3-E's sunlit vent sparkle. Same mechanism for the humidity condensate dump of the life-support loop
     (W2-D, ~2 kg/day of water, vented as ice crystals once a day through a heated nozzle).
6. **Ablation** (`env-ablation`). Above 800 K: ṁ = q_net/H_eff with H_eff = 20 MJ/kg per TPS zone. Thickness and
   capacity fall; once spent, the zone limit becomes the substrate's.
7. **Ventilation draught** (`air-drag-props-ventilation`, draught part).
   - v_air = 0.1–0.2 m/s from supply to return grilles, now allowed because drift mode handles steady drag.
   - Light props end at the grilles. The fans stop in sleep only if switched off.
8. **SYS read-outs from sensors** (`sens-hull-heat-truth`).
   - Thermocouples with a 5 s lag and 1 K resolution; cabin pressure; damage reported as events, not a %.
   - Noise from the counter hash.

**Tests.**
- The blowdown matches the analytic τ.
- Vent impulse equals ∫ṁ·u* + p*·A.
- A door cannot open against Δp.
- Airlock pump-down time is ln(p₀/p)·V/S.
- Decay heat is the closed form.
- Mass and energy are conserved over the network.

**The owner notices.** A cracked window kicks and spins the ship, things fly to the hole, the doors slam and
refuse to open toward vacuum. After docking, they crack the equalisation valve and swing the hatch open.
Engineering has a purpose.

#### W3-C Sensors and the flight computer

**Files.**
- New `src/world/sensors.ts`; `src/world/predict.ts`; `src/game/flight.ts` (laws read estimates).
- `src/data/cockpit.ts` (wave 3 owner: it also adds W3-B's devices on request).
- `src/render/space/instruments.ts`, `src/render/space/hologram.ts`, new `src/render/dockcam.ts`.
- New `tests/sensors.test.ts`.

**Model.**
1. **Rendezvous radar** (`sens-rendezvous-radar-lidar`).
   - An S-band transponder, 0.2–200 km: σ_r = max(0.5 m, 1e-3·r), σ_ṙ = 0.02 m/s, angles 0.1°, 10 Hz.
   - A track needs line of sight (segment–sphere against bodies plus atmosphere), a gimbal of ±70° about the
     dorsal axis and 3 s to acquire.
2. **Lidar.** 1 m–2 km: σ_r = 2 cm, bearing 0.02°. Inside 200 m it gives the 6-DOF pose of the port target at
   σ = 0.2°.
3. **Relative-nav EKF.**
   - 6 states, propagated with the Clohessy–Wiltshire transition matrix, n = √(μ/a³) = 1.11e-3 rad/s.
   - FA, the TGT and DOCK holds and the docking page read the estimate.
   - Without a track: "NO TRACK", FA shows NO REF, and the covariance grows.
   - Truth remains only in contact mechanics.
4. **Docking camera** (`inst-docking-camera`).
   - On the collar: 60° FOV, 256×192 at 10 Hz.
   - Rendered before the frame's HDR target is bound (the tile-GPU rule in `probes.ts`), used directly as the NAV
     glass `emissiveMap`.
   - Auto-exposure with τ = 0.5 s; shot noise ∝ √signal plus read noise; blooming when the star is in view.
   - Active only while the docking page is shown and a station is within 2 km (the §1.2.2 gate at RT High).
5. **Predictor knows about vents.** While `vent` or a breach is active, the ghost integrates the vent force
   like held thrust (W3-B's request; `predict.ts` is W3-C's in wave 3), so "drawn path = flown path" holds.
6. **Planner** (`fc-planner-unreachable`).
   - 4 detented rotary encoders (prograde, normal and radial Δv, time to burn), each with a push-to-enter, and
     BURN and ANTI-TGT hold lamps. W3-D implements the `encoder` device kind.
   - Finite burns in the ghost: t_b = m₀·vₑ/F·(1 − e^(−Δv/vₑ)), centred on the node.

**Budget.** About 3.4 µs per filter update in node (< 10 µs on A16) at 10 Hz. The dockcam costs 0.2–0.4 ms GPU
on average while active, and 0.2–0.5 ms of draw-call CPU per render (est.).

**Tests.**
- Loss of line of sight behind Wick.
- Filter consistency: NEES within 95% bounds over 1000 seeded runs.
- FA refuses an untracked station.
- Encoder detents.
- The finite-burn Δv matches the rocket equation.

**The owner notices.** A target behind Wick drops out and comes back at the limb. Closing speed settles as the
filter converges. Docking means watching the port grow on the screen. Burns can be planned from the seat.

#### W3-D Body III: a body that can be hurt and seen

**Files.**
- World: `src/world/crew.ts`, `src/world/props.ts`, `src/world/devices.ts`, `src/world/events.ts`.
- `src/render/camera.ts`, `src/app/input.ts`, `src/data/props.ts`, new `src/render/space/body.ts`.
- Tests: `tests/crew.test.ts`, `tests/props.test.ts`, `tests/devices.test.ts`.

**Model.**
1. **Floating attitude** (`body-floating-attitude`).
   - Carry L in ship axes: dL/dt = −Ω_ship × L + τ_contact. Inertia about 13/13/1.3 kg·m².
   - Capsule collision. Look = the neck within its limits about the body.
   - The boots right the body near a deck.
2. **Unbuckling under thrust** (`body-harness-drive-interlock`, D7). Delete the `leaveHelm` refusal. The body
   rests on the seat back; stepping off under 12 m/s² means a 26 m fall sternward, about 25 m/s.
3. **Injury** (`body-impact-injury`, `crew-injury-physiology`).
   - HIC over a 15 ms window: serious above about 700, critical about 1000.
   - Torso Δv into a rigid wall: > 5 m/s bruising, > 8–10 m/s serious, > 15 m/s fatal.
   - Consequences go through the vision post hook (W3-E) and the wreck path.
4. **Acceleration physiology** (`body-g-physiology`).
   - P_eye = P_heart − ρ·g_z·h, with P_heart = 120 mmHg, ρ = 1060 kg/m³, h = 0.30 m (about 23 mmHg per g).
   - Baroreflex +1–1.5 g with τ = 8 s. Grey-out at 3.5–4 g, black-out at about 4.5 g, g-LOC after the 5 s O₂
     reserve, recovery 12 s + 15 s.
   - −Gz red-out at −2 to −3 g; +Gx tolerated to 12–15 g briefly.
   - Hypoxia and hypercapnia from cabin.ts.
   - Closed form under warp. Output: a vision vignette and desaturation (W3-E's post hook).
5. **Controls bodies can touch** (`body-devices-untouchable`). Small device colliders; a contact impulse
   projected on the travel direction moves the mechanism (m_eff 0.2–0.5 kg for a grip, 5 g for a plunger).
6. **Momentum exchange** (`body-momentum-mass`). Every crew and prop contact impulse J at r pushes −J onto the
   ship (`extImpulse`, applied by W3-A). A push-off moves the ship 1.4 mm/s.
7. **Visible body** (`body-visible-body`).
   - Two-bone analytic IK arms (upper arm 0.30, forearm 0.27, hand 0.19 m) from the shoulders to the held grip.
   - Rigid low-poly segments, about 3k triangles. A raster overlay at RT High.
   - It replaces the "hand ring" in `cockpit.ts`; W3-E writes that hook.
8. **`dynamicBoxes`** for W3-B's door leaves, the `encoder` device kind, and breach drag from W3-B's flow field.

**Tests.**
- L is conserved while floating.
- HIC on a known pulse.
- Grey-out onset at the stated g.
- A mug pressing a plunger closes it.
- Ship Δv equals −J/M.

**The owner notices.** Floating while the hold turns, the cabin rotates around them. A crash can knock them out.
A hard entry tunnels the view. Their gloved hand is on the stick.

#### W3-E The eye and light, physically

**Files.** `src/render/*` except `instruments.ts`, `hologram.ts`, `dockcam.ts` (W3-C) and `space/body.ts` (W3-D).
Also `src/audio/*` maintenance.

**Model.**
1. **Absolute photometry and eye adaptation** (`light-photometry-eye-adaptation`).
   - Absolute cd/m² with pre-exposure (multiply emission by last frame's exposure) to stay inside fp16.
     Tallow at Wick gives 45.6 klux (36.7 lm/W at 3482 K); the disc is 9.7e7 cd/m²; lamps give about 100 cd/m².
   - Adaptation **on sim time** (exact exponentials). Fast neural and pupil stage: τ = 0.1–0.5 s toward brighter.
     Cones: τ = 2 min, plateau at 7–10 min. Rods: up to 30 min.
   - Pupil d = 4.9 − 3·tanh(0.4·log₁₀ L_a) mm. The EV clamps go.
   - The RT `bakedGain` contract is restated in absolute units.
2. **Eye PSF** (`light-star-disc-and-eye-glare` part 2). CIE 2002 general disability glare (age 25) fitted as
   bloom weights, plus a 256² PSF sprite with ciliary corona and lenticular halo, scaled by the pupil. Disc
   radiance from Stefan–Boltzmann with limb darkening u = 0.65.
3. **Mesopic and scotopic vision, afterimages** (`eye-mesopic-scotopic-afterimage`).
   - Scotopic Y_s = Y·(1.33·(1 + (Y + Z)/X) − 1.68) (Larson); the CIE 191 MES2 blend for L_a 0.001–3 cd/m².
   - Photopigment state p (the unbleached fraction) per 64² retinal cell: dp/dt = (1 − p)/120 s − p·L/L₀ with
     L₀ = 2e4 td. The image is scaled by p, so a negative afterimage follows a glance at Tallow.
   - Rod noise only in the dark.
4. **Chromatic adaptation** (`eye-chromatic-adaptation`). CAT16 to the luminance-weighted adapting white from
   the metering reduction, with D = F·(1 − (1/3.6)·e^((−L_a − 42)/92)). Fast component a few seconds; 90% within
   60 s. It replaces the fixed 0.42 white balance.
5. **Stars** (`sky-stars-photometric-catalogue`). A disc-plus-bulge luminosity function, T_eff tied to M_V,
   E = 2.54e-6·10^(−0.4m) lux, colour only for bright stars, and a limiting magnitude that follows adaptation.
6. **Atmospheres** (`atmo-physical-scattering`, `light-eclipse-limb`, `atmo-night-emissions` airglow part).
   - β_R(λ) = 8π³(n² − 1)²/(3Nλ⁴)·F_King, integrated over Tallow's Planck spectrum and the sRGB CMFs. Wick's
     zenith τ ≈ 0.048/0.091/0.225.
   - A Hillaire 32×32 multiple-scattering LUT; the physical scale height.
   - Eclipses: disc-overlap area with limb darkening, plus refraction flattening at the limb.
   - An OI 557.7 nm airglow shell, visible dark-adapted. City lights are constant, seen through exposure.
7. **Clouds with winds** (`atmo-clouds-winds`). A zonal wind profile (the eyeball world's superrotation
   20–60 m/s; the stationary sub-stellar storm stays put), advected by a two-phase flow map on sim time.
8. **Plume physics** (`fx-main-plume` part 2). P_jet = ½·F·vₑ = 1.6e10 W per pod × the radiative fraction, as a
   line light on the stern and nearby stations; in air, the shock-cell shape.
9. **Vents** (`env-space-dust-cause` part 2). Ballistic ice from station and ship vents (Q = 1e18–1e20
   molecules/s), visible only when sunlit (Mie forward scattering). The ship's vents and their mass flow come
   from `vent` (W3-B's boil-off relief and condensate dump); a station vents on a schedule from its own life
   support (declared in `stationLayouts.ts` by W3-B). No vent, no sparkle.
10. **Hooks.** Sconce drawn as a 5% oblate spheroid (from W3-A's J2), door leaves and hatch in the RT dynamic
    path, reactor core glow, the body overlay, the vision hook for W3-D.

**Budget.** Within the §1.2.2 gate at RT High; ≤ +0.5 ms on raster. Pre-exposure costs one multiply per shader.

**Tests.**
- The Planck/photopic integral gives 36.7 lm/W at 3482 K.
- A 30 min dark-adaptation curve.
- The scotopic formula on known XYZ.
- The SH and scattering LUTs against reference integrals.
- The shot harness across day, night and eclipse.

**The owner notices.** Stars come up slowly on the night side. Sunlight floods the eye with veiling glare. A dark
blob follows the gaze after looking at Tallow. Wick's sky colour follows from its own air and star.

### Wave 4 — backlog (build only after waves 1–3 are measured on the phone)

These are deferred, not rejected. Each needs something that does not exist yet, or is large:
- **EVA, suit and exterior airlock** (`body-eva-airlock`): Clohessy–Wiltshire relative motion, a tension-only
  tether, a 0.1 m/s² cold-gas pack.
- **Other traffic** (`env-other-traffic`) with **multi-rate far craft** (`perf-far-craft-multirate`, needed for
  traffic to cost nothing).
- **Micrometeoroids** (`env-micrometeoroids`, `micrometeoroid-punctures`): a Grün flux and window pits. A 1 mm²
  hole e-folds in about 31 days.
- **Stellar flares and radiation** (`env-radiation-flares`, `radiation-flares`, flares part of
  `light-star-rotation-flares`). M2–M3 flares are +10–50% in V for minutes, twice a year.
- **Ring matter at Sconce** (`env-sconce-rings-physical`).
- **Gas-giant descent** (`env-gas-giant-entry`).
- **Wind forces near the ground** (`env-winds`).
- **Plume impingement** (`env-plume-impingement`, `prop-plume-impingement`). It needs station thermal and damage
  models first.
- **Night-side lightning** (`atmo-night-emissions`, lightning part). It is rare on the ice hemisphere.
- *Added in review (missing from the inventory):*
  - **Aurora on Wick's night side** (`rev-aurora`). An active M dwarf drives strong particle precipitation; from
    547 km a night-side auroral oval would be one of the brightest things outside the window. Needs a planetary
    magnetic field (not in the data) and the flare/particle model above; build with the flares.
  - **Airborne lint and dust in the cabin** (`rev-cabin-motes`). Crewed cabins in micro-g carry floating debris
    that collects on the intake filters (an ISS routine), visible as motes in a sun shaft. Needs W3-B's draught
    field; a few hundred GPU points advected by the draught, lit only inside the sun patch.
  - **The pilot's own breathing and heartbeat** (`rev-own-body-sound`). In a quiet cabin they are audible; rate
    from W3-D's physiology (g load, hypoxia, exertion). Low priority, but nearly free once W3-D exists.

---

## Decisions where the three plans disagreed

| Question | Fidelity plan | Performance plan | Player plan | **Decision and reason** |
|---|---|---|---|---|
| Fixed tick | after the work packages | WP0, blocks all | 50 Hz controller grid | **Wave 1, a 120 Hz tick with a 60 Hz controller and extrapolated rendering** (§1.3). It is cheap. Harness, devices, PWM and replays need a fixed h. 50 Hz does not divide 120. |
| Worker | no | no; predictor maybe later | no | **No Worker in this plan.** The predictor becomes incremental on the main thread instead. |
| Torque source | jets plus a 2e4 N·m·s wheel cluster | the same, 4 × 2e4 | jets now, no wheels | **Jets in wave 1; CMG-class units (4 × 4.8e3 N·m·s, 260 N·m) in wave 2.** A wheel cannot honestly supply MN·m, and 2 kN·m wheels draw hundreds of kW. The CMG hold as a continuous-time law is what makes gravity gradient affordable under warp. |
| Gravity gradient | with quasi-static props and the event-driven hold | same | same | **Wave 2, together with the CMGs.** A jets-only deadband would wake about 55 times a real second at 1e4 and limit the warp. |
| Engine offset (0.2 m) | separate forces in wave 1, gimbal later | gimbal in wave 1 | two forces in wave 1, no gimbal | **Two forces in wave 1, canted 0.73° so the resultant passes through the CoM**, as real ships are built. Applying the offset without a gimbal would cost about 6 kg/s of RCS during every burn. The gimbal comes with the moving CoM (W3-A). |
| RCS pool | 600–800 kg | 800 kg | 0.8 t | **1.5 t at vₑ 2250 m/s, the main pool reduced to 22.5 t** (D3). At about 40 kg per hold slew, 800 kg runs out too fast for play. |
| Hold slew rate | not stated | not stated | not stated | **0.1 rad/s** (D3), about 40 kg per 90° instead of 150 kg. |
| Thermal nodes | 8–12 zones | about 12 | 16 | **About 36 nodes**: 12 skin zones, structure, pods, radiators, loop, bays, rooms, panes. Measured 24 nodes at 2.4 µs in node; it is cheap, and the window-sunlight term needs the room and pane nodes. |
| Radiators | not stated | real drawn area | 13 m², cut the MW | **D4 default: a NaK loop up to 1100 K into 52 m² of two-sided panels, about 3.7 MW.** It is consistent with geometry, and the radiators visibly glow on long burns. |
| Docking | the contact package | the systems package | the propulsion package, phase 2 | **One contact package in wave 2 (W2-C).** It owns contact.ts once the hull-shape work lands. |
| Sleep budget | — | 8 ms when the render is cut | cut the render | **3 ms awake on every tier (thermal), 8 ms only with eyes closed.** |
| Ambient-pressure thrust | owner decides | behind a decision | owner decides | **Built and on in W2-B** (D1). The start never needs a landing, and the owner is told plainly. |
| Natural wake | — | — | — | **Wave 2 builds the model; the wake rule waits for D7** (review: with awake time at 1×, sleep pressure stays near zero, so natural wake would end almost every sleep at once). |
| Navigation and gyro filter (MEKF) | do not build | — | do not build | **Not built** (§3). |
| Docking camera | second wave | none at RT High | phase 2 | **W3-C, gated by the RT GPU rule** (§1.2.2). |

## Owner decisions (defaults the engineers use until answered)

- **D1 — Nozzle and atmosphere.**
  - The Wren's magnetic nozzle loses p_a·A_e ≈ 781 kN of its 800 kN at Wick's sea level. As specified, a Wick
    landing is a **one-way trip**: the ship cannot lift off again.
  - Default: physics on; landing is a commitment.
  - Alternatives: a dense-air drive mode (a later package), or a smaller exit area.
- **D2 — Tank layout.**
  - 22.5 t of LH2 is about 317 m³, roughly 29% of the hull, which conflicts with the interior. 1.5 t of
    hydrazine is 1.5 m³.
  - Default proposal: conformal tanks outside the pressure hull in the belly and wing roots.
  - This blocks W3-A only.
- **D3 — Turning costs propellant.** Default yes, with a 1.5 t RCS pool and a 0.1 rad/s hold slew rate.
- **D4 — Drive waste heat and radiators.** Defaults: ε_d = 4.4e-4 (about 6 MW at full throttle, a tuning value,
  not a measured one) and a 1100 K liquid-metal loop (pressurised NaK or lithium; NaK boils near 1058 K at
  1 bar) with 52 m² of panels.
- **D5 — Station masses and the Wheel's spin.**
  - Default: masses from the layouts (the Wheel about 1e10 kg).
  - Spin: Ω = 0.149 rad/s gives 1 g at 441 m with a 66 m/s rim; the alternative keeps 0.09 rad/s (0.36 g).
  - The text is fixed to match either way.
- **D6 — Hidden or locked page.** Default: catch up on the time missed, capped at one sim day, under honest warp.
- **D7 — Sleep and harness.** Unbuckling under thrust is allowed (wave 3). *Sleep (revised in review):* the
  homeostatic model is honest, but with awake time at 1× an owner rarely builds real sleep pressure, so natural
  wake would usually end a sleep within minutes. Options: (a) honest both ways (Borbély decides when you can fall
  asleep and when you wake; long trips then need long real sessions); (b) natural wake only, as planned (sleep
  after a short session lasts minutes of ship time); (c) keep wake-on-touch and cautions, with S and C shown on
  the SYS page only. **Default (c)** until the owner chooses, because (a) and (b) remove sleep warp in
  practice.
- **D8 — Boot magnets** on a wrist switch. Default yes.

---

## 3. Not doing (with reasons)

| Item (finding ids) | Reason |
|---|---|
| Relativity, light-time, aberration, Doppler of light, zodiacal light, g grey-out at the Wren's ~1.2 g (`env-relativity-lighttime`, `light-below-perception`) | Below perception: 31″ aberration, a 1e-8 clock effect. |
| Gyro, star tracker and MEKF; own-ship orbit determination (`sens-imu-startracker-mekf`, `nav-orbit-determination`) | With real spacecraft gyros the drift is arcseconds, invisible on a phone. MEMS-grade parts would fake degradation just to be seen. The rendezvous sensors (W3-C) cover the felt part. |
| Propellant-gauging noise (`sens-propellant-mass-gauging`) | ±1–2% on a gauge is not felt and adds nothing physical to the ship. |
| Ship-clock drift and timing (`inst-clock-timing`) | 86 ms per day; imperceptible. The tick index serves as the sensors' timestamp. |
| A Worker for the authoritative sim (`perf-sim-worker-authoritative`) | No SharedArrayBuffer, so at least one frame of lag on coupled crew, hand and ship physics, for under 1 ms saved. |
| Worker offload of photo decode and the BVH build (`perf-offload-latency-tolerant`) | These belong to the photo and RT engineers. Recommendation passed to them: upload an `ImageBitmap` straight with `texSubImage3D` (no `getImageData`), before any Worker. |
| A cross-engine libm (`perf-cross-engine-determinism`) | Saves never leave the device. Only the literals are adopted (W1-A), plus the `world/math.ts` wrapper rule. |
| An adaptive awake sim budget at RT High (`perf-sim-budget-fixed`, the awake part) | Spare CPU at RT High comes out of GPU thermal headroom (§1.2.1). The sleep part is built (W1-A). |
| Device-mechanics refinements (`body-device-mechanics-fidelity`) | Travel times are already 30–50 ms, so the difference is imperceptible at 30–60 fps. |
| Biodynamic feedthrough into the stick (`body-biodynamic-feedthrough`) | A few % of grip tug, a comfort and nausea risk, barely perceptible. |
| Vestibular illusions and camera tilt or shake (the vestibular part of `body-g-physiology`) | The phone has no vestibular output. Drawing them would be camera motion without a cause in the world, and a nausea risk. |
| Water, galley and washroom plumbing (`plumbing-galley-washroom`) | Nothing to act on in a flight sandbox. Water mass may join the tanks in W3-A if a tank is defined. |
| Real-time modal synthesis | Pre-baked buffers sound the same at about 0 run-time cost (5% of a core saved). |
| HRTF panning | Pointless on two phone speakers; equal-power stereo instead. |
| Point-kinetics reactor | Stiff (Λ = 1e-4 s) and invisible. A first-order core with decay heat (W3-B) gives every felt behaviour. |
| Cargo mass (cargo part of `mass-crew-props-cargo`) | There is no cargo yet. It joins the W3-A mass properties when cargo exists. |
| Display P3 output (`light-display-gamut`) | Tallow's 3482 K light lies inside sRGB. Only < 1900 K glows gain anything, against a pipeline-wide colour risk. |
| A near-scene station shadow map | Analytic capsule occluders (W2-F) give the same penumbra at a fraction of the cost (4 MB, 0.8–1.5 ms). |

Refuted in review and not planned: `perf-ephemeris-burst`. The ring extends in ≤ 64-node slices inside the
predictor's budget loop, so no single-frame burst exists.

---

## 4. Inventory appendix: every finding → package

Legend: W1-A … W3-E = packages; W4 = backlog; NO = §3. "+" means the finding is split across packages.

### Propulsion
| id | → |
|---|---|
| att-rcs-jets | W1-B |
| prop-rcs-no-z-jets | W1-B |
| att-wheels | W2-B |
| prop-engine-transients | W1-B (+W1-E render) |
| prop-pressure-thrust | W2-B |
| prop-felt-from-commands | W1-B + W1-C |
| mass-com-inertia | W3-A |
| prop-rcs-separate-propellant | W1-B |
| prop-thrust-line-gimbal | W1-B (canted forces) + W3-A (gimbal) |
| att-gravity-gradient | W2-B |
| att-aero-moments | W2-B |
| prop-rcs-pwm | W3-A |
| prop-engine-heat | W2-D |
| prop-slosh-ullage | W3-A |
| prop-plume-impingement | W4 |
| struct-flex | W3-A |
| prop-ground-thrust | W1-B (applied = 0) + W2-C |
| prop-thruster-sound | W1-D |
| mass-crew-props-cargo | W3-A + W3-D (crew/props); cargo NO until cargo exists |
| att-jet-damping | W1-B |
| prop-visual-from-command | W1-B + W1-E |
| prop-refuel | W2-C (+ W2-D valve) |
| prop-docked-latch-load | W2-C |

### Environment
| id | → |
|---|---|
| env-aero-felt-by-crew | W1-B + W1-C |
| env-gravity-gradient-torque | W2-B |
| env-reentry-sheath-cause | W1-E (+ W1-A view) |
| env-tidal-accel-in-cabin | W2-E |
| env-aero-shape | W2-B |
| env-entry-heating-zones | W2-B (flux) + W2-D (zones) |
| env-station-rotor-spin | W2-C (+ W2-F render) |
| env-atmosphere-profile | W2-B |
| env-thermosphere-drag-leo | W2-B |
| env-station-gravity | W2-B (masses from W2-C) |
| env-space-thermal-environment | W2-D |
| env-mach-knudsen | W2-B |
| env-sconce-rings-physical | W4 |
| env-space-dust-cause | W1-E (remove) + W3-E (vents) |
| env-starlight-planetshine-radiance | W2-F + W3-E |
| env-j2-oblateness | W3-A (+ W3-E oblate render) |
| env-srp | W3-A |
| env-gas-giant-entry | W4 |
| env-winds | W4 (forces); clouds in W3-E |
| env-micrometeoroids | W4 |
| env-radiation-flares | W4 |
| env-locked-planet-render-spin | W1-E |
| env-buoyancy | W2-B |
| env-relativity-lighttime | NO |
| env-determinism-transcendentals | W1-A |
| env-other-traffic | W4 |
| env-ablation | W3-B |
| env-props-quasistatic-warp | W1-C |
| env-ambient-pressure-thrust | W2-B |
| env-plume-impingement | W4 |
| env-cloud-phase-snap | W1-E |

### Ship systems
| id | → |
|---|---|
| heat-hull-environment | W2-D |
| heat-internal-sources-radiators | W2-D |
| air-drag-props-ventilation | W1-C (drag) + W3-B (draught) |
| heat-engine-nozzle-afterglow | W2-D (nodes) + W2-F (render) |
| power-electrical-bus | W2-D |
| lights-powered-photometric | W2-D + W2-F |
| damage-localized-components | W2-C |
| air-breach-decompression | W3-B |
| air-room-gas-network | W2-D |
| doors-physical-pressure | W3-B |
| hatch-dock-airlock | W3-B |
| life-support-consumables | W2-D |
| reactor-dynamics-controls | W3-B (first-order; point kinetics NO) |
| fuel-tanks-com-transfer | W3-A |
| attitude-torquer-momentum-power | W1-B (jets) + W2-B (CMG) |
| cabin-thermal-window-fog | W2-D + W2-F |
| crew-injury-physiology | W3-D |
| radiation-flares | W4 |
| micrometeoroid-punctures | W4 |
| plumbing-galley-washroom | NO |
| systems-dock-propellant-transfer | W2-C (+ W2-D valve) |
| systems-dock-latch-capture | W2-C |
| systems-rcs-separate-propellant | W1-B |
| systems-structural-failure-thresholds | W2-C |
| systems-damage-render-fake | W1-E |
| systems-cryo-boiloff | W3-B |

### Crew
| id | → |
|---|---|
| body-ship-impulse-feel | W1-B + W1-C (latch duration W2-C) |
| body-helm-harness-head | W1-C |
| body-floating-attitude | W3-D |
| body-sit-stand-strap-snaps | W2-E |
| body-gait-boots-friction | W1-C |
| body-head-motion-on-foot | W1-C |
| body-handholds-grab-ship | W2-E |
| body-seat-constraints | W1-C |
| body-pushoff-jump-physics | W2-E |
| body-boot-magnet-model | W1-C (+ W2-E switch) |
| body-g-physiology | W3-D (vestibular part NO) |
| body-props-pose-helm | W2-E |
| body-eva-airlock | W4 |
| body-momentum-mass | W3-D + W3-A |
| body-tidal-gradient | W2-E |
| body-impact-injury | W3-D |
| body-reach-arm | W2-E |
| body-biodynamic-feedthrough | NO |
| body-sleep-metabolism | W2-E (wake) + W2-D (metabolism) |
| body-device-mechanics-fidelity | NO |
| body-small-kinematic-leftovers | W1-C |
| body-head-kinematics | W1-C |
| body-lying-head-frame | W2-E |
| body-harness-drive-interlock | W3-D |
| body-devices-untouchable | W3-D |
| body-visible-body | W3-D (+ W3-E hook) |
| dev-stick-time-overrun | W1-C |
| body-hull-flex-at-cockpit | W3-A |
| body-cabin-air-drag | W1-C |

### Instruments
| id | → |
|---|---|
| fc-attitude-actuators-free | W1-B |
| inst-aux-screens-fake | W1-E (+ W2-F with bus data) |
| holo-scale-dishonest | W1-E |
| inst-accel-readout-com-only | W1-A (view) + W1-E (display) |
| sens-imu-startracker-mekf | NO |
| sens-rendezvous-radar-lidar | W1-B (FA range/LOS bug) + W3-C |
| inst-docking-camera | W3-C |
| inst-screens-not-light-sources | W2-F |
| fc-prediction-spike-and-thrust | W1-A (+ W3-C finite burns) |
| nav-orbit-determination | NO |
| fc-control-rate-frame-coupled | W1-A |
| fc-latch-auto-arm | W2-C + W2-D |
| inst-attitude-disc-5hz | W1-E |
| inst-screen-washout | W1-E |
| holo-decorative-motion | W1-E |
| inst-caution-warning | W2-D (+ W2-F horn) |
| fc-planner-unreachable | W3-C |
| sens-propellant-mass-gauging | NO |
| sens-hull-heat-truth | W3-B |
| inst-decorative-wall-screens | W2-F |
| fc-hold-warp-dependent | W1-B (+ W2-B CMG law) |
| inst-clock-timing | NO |
| fc-dock-capture-standoff | W2-C |
| sens-crew-no-drag | W1-B + W1-C |
| inst-dummy-switches | W2-D + W2-F |

### Senses
| id | → |
|---|---|
| sound-propulsion-structure-borne | W1-D |
| sound-impacts-modal | W1-D |
| sound-aero-buffeting | W1-D (+ W2-F Mach) |
| sound-machinery-ambience | W1-D + W2-F |
| sound-crew-devices | W1-D |
| sound-cabin-air-medium | W2-F |
| sound-room-acoustics | W2-F |
| sound-propagation-honesty | W1-D |
| light-photometry-eye-adaptation | W3-E |
| light-star-disc-and-eye-glare | W1-E (remove ghosts/spikes) + W3-E (PSF) |
| fx-reentry-thermal-glow | W1-E + W2-F |
| light-craft-shadows | W2-F |
| fx-rcs-plume | W1-E |
| eye-camera-artefacts | W1-E |
| eye-mesopic-scotopic-afterimage | W3-E |
| eye-chromatic-adaptation | W3-E |
| sky-stars-photometric-catalogue | W3-E |
| light-per-object-key | W1-E |
| light-planetshine-area | W2-F |
| light-interior-bounce-non-rt | W2-F |
| atmo-physical-scattering | W3-E |
| atmo-clouds-winds | W3-E |
| fx-main-plume | W1-E + W3-E |
| fx-space-dust | W1-E |
| light-far-point-sources | W1-E |
| light-star-rotation-flares | W1-E (rotation, granulation) + W4 (flares) |
| light-body-orientation | W1-E |
| light-eclipse-limb | W3-E |
| atmo-night-emissions | W3-E (airglow) + W4 (lightning) |
| light-exterior-artificial | W2-F |
| light-display-gamut | NO |
| light-below-perception | NO |
| light-ambient-fill | W1-E |
| light-rt-dynamic-casters | W2-F (gated) |
| light-planetshine-lower-tiers | W2-F |
| eye-window-optics | W2-F |
| eye-zoom | W1-C |
| eye-head-dynamics | W1-C + W2-E |
| sound-attitude-actuators | W2-F (+ W1-D jets) |
| fx-clock-warp | W1-E |
| sound-thermal-creak | W2-F |
| eye-closed-lids | W1-E |

### Budget
| id | → |
|---|---|
| perf-fixed-tick | W1-A |
| perf-sleep-render-dark | W1-A + W1-E |
| perf-props-warp-collapse | W1-C |
| perf-prediction-burst | W1-A |
| perf-autoquality-30fps-blind | W1-A |
| perf-sim-budget-fixed | W1-A (sleep budget); awake adaptive NO |
| perf-offload-latency-tolerant | NO (recommendation to the photo/RT owners) |
| perf-sim-worker-authoritative | NO |
| perf-hidden-time-stops | W2-D (D6) |
| perf-autosave-hitch | W1-A |
| perf-far-craft-multirate | W4 (with traffic) |
| perf-crew-frozen-under-warp | W1-C |
| perf-ephemeris-interp-reuse | W1-A |
| perf-v8-double-boxing-benchmarks | W1-A |
| perf-cross-engine-determinism | NO (literals adopted in W1-A) |
| perf-timer-resolution | W1-A |
| perf-invisible-instruments | W1-A (+ W1-E visibility query) |
| perf-ephemeris-burst | refuted |

### Added in review (not in the audited inventory)
| id | → | What |
|---|---|---|
| rev-window-shutters | W2-D (device, thermal) + W2-F (render) | external window covers: sun heat, glare, washout |
| rev-sensible-atmosphere-top | W2-B | keep `atm.top` at ρ = 1e-7 for station placement, events, wake, cautions |
| rev-station-gg-equilibrium | W2-B (setup, pilot) + W2-C (inertia) | stations start in LVLH gravity-gradient equilibrium, ω = n |
| rev-desat-continuous | W2-B | CMG desaturation at constant duty inside the continuous-time law |
| rev-drive-standby | W2-D | DRIVE ARM brings the reactor to drive load before ignition |
| rev-boiloff-vent | W3-B (+ W3-E sparkle) | balanced boil-off and condensate vents as the cause of ship vent plumes |
| rev-aurora | W4 | night-side aurora (needs a magnetic field and the particle model) |
| rev-cabin-motes | W4 | floating lint in sun shafts, advected by the draught |
| rev-own-body-sound | W4 | the pilot's breathing and heartbeat from W3-D's physiology |

---

## Review notes

What the plan review changed (the reviewer could edit only this file; prototypes are in
`/tmp/claude-0/-home-user-pulsevault/02af9242-a437-54ad-bf2c-efd96ec068b3/scratchpad/sim-audit/plan-review/`):

- **Completeness.** Every audited finding was already mapped (checked id by id, 192 + 1 refuted). Added nine
  phenomena the inventory missed (table above): shutters, a sensible-atmosphere-top hazard, station
  gravity-gradient equilibrium, continuous desaturation, drive standby, boil-off and condensate vents (the missing
  cause for W3-E's vent sparkle), aurora, cabin motes, own-body sound.
- **Budget arithmetic.** The 1× totals were below the sum of their own rows; corrected to ≤0.4/≤0.55 ms at 60 fps
  and ≤0.6/≤0.95 ms at 30 fps (caps unchanged and still met). Added the dock-camera CPU row. Audio-thread cap
  3% → 5% (W1-D + W2-F did not fit in 3%). The GPU additions were over both limits; added a GPU ledger with a
  spending order and worst-situation checks (§1.2.2), and the baked screen form factor.
- **Measured.** A combined aero/thermal skin bake costs 336 ms in node (≈ 0.7 s on the A16), so it moves to a
  build-time tool (W2-B). A 36-node implicit thermal step costs 3.3 µs in node with CSR adjacency (40 µs with a
  naive link scan).
- **Physics fixes.** Desaturation lasts ≥ 15 s (CMG 520 N·m limit), not 1 s, and an inertial hold never
  desaturates; stations need GG equilibrium, not the Wren's CMGs (1e7–1e8 N·m scale); the orbit is 94.5 min,
  not 91; capture period 5.8–7.3 s, angular ≈ 22 s; pillow C_dA and "stops" wording; ambience gain 0.014;
  screen contrast with auto-brightness; minimum-throttle clamp; tropopause over-specification; NaK boils at
  1058 K; vent thrust; station gravity at 1e10 kg is ≈ 1.7 km per sleep; tidal test uses the exact solution.
- **Hazards.** Raising `atm.top` would move every station and wake every sleep; natural wake (D7) would remove
  sleep warp in practice — now gated, default off; `pointerdown` does not unlock audio on touch; hysteresis on
  I⁻¹ and the jet table broke save/load bit-identity; props' mode must be saved; sim uses of the look must be
  latched per tick; fixed GS sweeps broke the energy test.
- **Parallel safety.** Moved ShipMotion r̂ to W1-C and the helm felt point / zoom line to W1-A; defined day-1
  owners for the ledger consumer, the event emit API, body stepping, frame fields, the hull zone table, station
  mass properties and new wave-2/3 contract fields (valves, latch arm, health arrays, shutters, vent,
  extImpulse, tpsMass, tableCom); the docked-thrust rule deletion goes through flight.ts' owner.
- **Tests added.** Ledger equals applied impulse; no sound without a cause (mock AudioContext); sheath does not
  linger; plume does not flicker; drift with moving walls; save/load in drift and mid-burn; desaturation and
  station-equilibrium cases; station radii unchanged; energy per thermal step; shutters; drive standby; capture
  never reaches the hard stop.

Not verified: every A16 figure is still an estimate (×2 node); WebKit's audio activation was taken from the spec,
not run on Safari; the GPU ledger numbers are the auditors' estimates and must be measured per wave.

