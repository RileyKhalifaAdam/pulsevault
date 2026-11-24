# System tier: frames, orbits, gravity and time

The system tier is the CPU, bit-exact layer that knows where every body of a star system is at every tick and tells each region of detail what gravity it feels. This spec decides that heavy bodies move under mutual Newtonian attraction, not on two-body rails, using one fixed-step method on an absolute tick grid; the method is data, closed by a build-server test. Surface regions ride the body's rotating frame; orbital regions are non-rotating free-fall frames. Heavy-body state is a function of the world record and its journal, so it is checkpointed and hashed. Dormant objects fly one of two declared modes, and release 1 has one world clock.

Tags: **[M]** measured, **[D]** derived, **[E]** estimate until the Phase 0a probe or first build-server run. "This round" is the version-2 red team; 06 and 08 are the research and design files. Earth: GM 3.986e14 m^3/s^2, equatorial radius 6.378e6 m, spin 7.292e-5 rad/s, oblateness J2 1.0826e-3 [M, 06].

## 1. Frame tree and number formats

Every position is a frame plus a local coordinate.

| Level | Frame | Format |
|---|---|---|
| G | Star-system origins | Three 64-bit integers, km: +/-975,000 light-years [D: 2^63 km / 9.461e12]; error 0.5 km |
| S | Body relative to its parent, non-rotating axes | 64-bit floats (f64), metres and m/s |
| B | Body-fixed rotating frame | f64; spin phase is a 64-bit integer fraction of a turn, phase0 + rate x tick, wrapping exactly, so it never loses precision (VP05) |
| R | Region | Anchor double-double; contents f64 within 8 km |

*Double-double* holds a number as two f64 (about 106 bits) using only add, subtract and multiply. Every awake anchor, and any coordinate that can exceed 2^43 m = 58.8 AU [D], is double-double.

| Distance from frame origin | f64 position spacing [D: 2^(exponent-52)] | Worst rounding (half) | Speed there | f64 velocity spacing | Double-double spacing [D: x 2^-53] |
|---|---|---|---|---|---|
| Earth's radius, 6.371e6 m | 0.93 nm | 0.47 nm | 7.67 km/s | 9.1e-13 m/s | 1e-25 m |
| 1 AU | 31 um | 15 um | 29.78 km/s | 3.6e-12 m/s | 3.4e-21 m |
| 30 AU | 0.98 mm | 0.49 mm | 5.43 km/s | 9.1e-13 m/s | 1.1e-19 m |
| 1 light-year | 2 m | 1 m | 0.01c | 4.7e-10 m/s | 2.2e-16 m |

Region contents never hold these magnitudes: local spacing is 9.1e-13 m inside 8 km anywhere [D] (F10). A heavy body's round-off random-walks sqrt(525,960 steps) x 31 um / sqrt(12) = 6.4 mm per year at 1 AU [D]: navigation, never contact.

## 2. The region frame

| | Surface region | Free-fall region (orbit, cruise) |
|---|---|---|
| Anchor | A point fixed in the body's rotating frame | A point falling under the summed gravity of all heavy bodies plus the primary's J2, stepped every tick |
| Axes | Parallel to the body-fixed axes | Parallel to system axes; never rotate |
| Solvers see | Velocity relative to static ground | Velocity relative to the anchor |
| Re-centre when the focus object is | Over 256 m away [E]: shift positions | Over 256 m or 32 m/s away [E]: shift positions and velocities |

Re-centring happens at a frame boundary, is decided from sequenced state so every peer does it at the same tick, and is journalled. Shifts are multiples of 2^-16 m and 2^-16 m/s: the anchor absorbs them exactly, each body rounds by at most 4.5e-13 m and 5.7e-14 m/s [D: half a spacing], and that residual plus the kinetic-energy change -P.dV + 0.5 M dV^2 goes to the frame-transfer account.

Orbital speed (7.67 km/s) lives only in the anchor. Local speeds stay under 32 m/s, spacing 3.6e-15 m/s [D], so millimetres survive and orbital speed never reaches a contact solver (P11).

A region is the surface kind while anything in it touches ground; it becomes free-fall once its focus is airborne and 2 km or 20 s from terrain [E], in one transaction (v_inertial = v_local + spin x r).

Leaving: an island past the demote radius is demoted into the parent body's frame: surface-dormant if at rest on the ground, an arc if in free flight (section 7). One still moving in contact has no formula: the region grows to keep it, or it is paused and reported. Nothing is deleted or rewound (F12, VP19).

## 3. Orbit integrator

**Decision.** Heavy bodies (10 in release 1, 34 in Phase 2) attract each other and everything else pairwise. Objects (vessels, debris, anchors) attract nothing. Two-body rails survive only as mode K for dormant objects and as the fallback for an uncertified authored system. ORRERY's real-system mode was itself mutually attracting, so the real choice was the method and its independence from warp (VP01).

**Interface.** heavy_state(tick) is bit-exact and equals F(initial-record hash, arithmetic version, integrator id and step, journal of kicks and mass changes, tick), whatever the warp history or observer (VP02). Changing the method is a journalled event continuing from a checkpoint.

**Method.** Release 1 uses "PEFRL-60": a fourth-order symplectic composition (energy error stays bounded, not drifting) of five drifts and four kicks, coefficients 0.1786178958448091, -0.2123418310626054, -0.06626458266981849 (Omelyan and co-authors, from memory; fourth-order convergence confirmed in a run this session). Step H = 28,800 ticks = 60 s [D], on tick multiples of H. This follows VF05 over VP01's baseline (ORRERY's 12th-order multistep at 600 s): it starts itself, checkpoints as positions and velocities, takes kicks without a restart, and needs only add, subtract, multiply, divide and square root. The multistep method is the candidate if 34 bodies need warp above 1e6x; nested Wisdom-Holman replaces either only by passing the oracle test.

1. Bodies in ascending id; state is position and velocity relative to the parent.
2. Drift: relative position gains coefficient x H x relative velocity.
3. Kick: for each pair once, form the separation through the tree, compute 1/(r^2 sqrt(r^2)), apply equal and opposite accelerations; relative velocity gains coefficient x H x (own acceleration minus parent's).
4. Every 1,024 nodes (17.07 h [D]) settle accounts, write a checkpoint and hash.
5. Between nodes, quintic Hermite interpolation; worst case Phobos, H^6 n^6 r / 46,080 = 1.3 nm [D].

**Reaction and mass (VP18).** Every body has an exact deferred-reaction momentum account and an integer mass-change account. At a checkpoint node, once account / mass reaches the body's velocity spacing, the representable part becomes a journalled kick, debited exactly. Thresholds: 2.2e13 kg m/s for Earth, 8.4e9 Moon, 4.8e3 Phobos [D: mass x velocity spacing], so a 10 t lander at 10 m/s kicks Phobos by 21 spacings and never Earth. An object whose orbital momentum exceeds a body's threshold is integrated with it as a two-way pair.

**Step and close encounters.** The heavy step never changes. A guard requires 256 steps per local circular period 2 pi sqrt(d^3/GM) for every heavy pair [E] (Phobos has 459 [D: 27,554 s / 60]); a violation is a journalled fault that refuses warp. Mode-S objects step at H/2^k, k up to 7, chosen at nodes from the closest possible approach in the next 60 s; low orbit gets 15 s.

| After one year | Value | Basis |
|---|---|---|
| Moon along-track; energy | 7 mm; 2e-13 | [D] two-body f64 run this session |
| Earth; Mercury | 0.13 m; 0.28 m, round-off | Same |
| Phobos (Phase 2) | 41 m; 3e-12 | Same; Forest-Ruth gives 2.2 km |
| Published | Leapfrog at 60 s: Earth 5.6 m [D, 06]; Wisdom-Holman, 5-day step: energy 1e-8 [M, arXiv:2307.05683 via 06] | |
| Against the real sky | Mercury 960 km per decade, no relativity [D, 06]; Moon 14 km, no Earth J2 on it [D: 1.5 J2 (R/a)^2 n a t] | Reported, not gated |

Full n-body errors are [E] until the oracle run.

**Cost.** One pair costs 5.4-6.9 ns in wasm on a 2.1 GHz Xeon [M, this round]; the A16 is 1-2.5x slower [E].

| [D] | 10 bodies, 45 pairs | 34 bodies, 561 pairs |
|---|---|---|
| One step, 4 evaluations | 1.0-1.2 us | 12-15.5 us |
| Warp ceiling at 0.5 ms per frame | 1.4e6-1.9e6x | 1.2e5-1.5e5x |
| One simulated year | 0.5-0.65 s | 6.4-8.1 s |

The body-count ceiling is pairs <= 6.5e7 / warp [D: 0.5 ms x 3,600 / (4 x 6.9 ns)]: 360 bodies at 1,000x, 36 at 100,000x. Region gravity costs 72 us per frame for 300 bodies [E, 08]; the tier is capped at 0.5 ms.

**Cache (VF10).** A checkpoint is 1,632 B for 34 bodies [D: 34 x 6 x 8] plus accounts. The last 64 are kept; older ones thin to every 65,536 nodes, so any tick costs at most 1.0 s of re-stepping [D: 65,536 x 15.5 us].

## 4. Bit-exactness

The shipped .wasm binary is the canonical arithmetic; a server or native app runs it unless CI shows equal hashes (VP07).

| Rule | Detail |
|---|---|
| Allowed | f64 add, subtract, multiply, divide, square root; integers. Such a kernel hashed identically on native x86-64 and wasm under Node [M, this round]; Safari unverified |
| Forbidden | Host maths, fused multiply-add, relaxed SIMD, threads, reassociation. A non-finite result halts the step; no NaN is hashed |
| Own functions | Sine, cosine: exact octant from the integer phase, then a fixed polynomial. Stumpff series (for the Kepler solver): fixed degree after fixed-rule argument quartering. Kepler solve: exactly 2 Halley and 2 Newton iterations, 1e-13 relative [M, same paper]. Jacobi elliptic functions (Phase 1): fixed Landen steps |
| Order | Ascending stable id; explicit parentheses; constants as bit patterns in an arithmetic-version table |
| Versioning | Binary hash, arithmetic version and integrator id in the world record and handshake; mismatch refused |

Tests in CI: stored bit patterns for 10,000 inputs per function [E]; the hash of 1e6 heavy steps equal on native x86-64, native ARM64, Node and the phone's Safari; equal hashes under three warp schedules.

## 5. Gravity supplied to a region

Each tick a region receives a *gravity packet*: per-body acceleration (free-fall: the primary's pull at the body minus at the anchor, in Encke's cancellation-free form; surface: gravity plus centrifugal at the body-fixed position), the 3x3 gradient for the torque 3(GM/r^3) r x (I r), the spin vector, third-body tides, and potential differences for the ledger. The matter tier gets one vector, the gradient and the spin vector.

Sizes at L = 250 m from the anchor (the plan's "250 m" read as radius), [D], m/s^2:

| Term | Formula | Earth's equator | Low orbit, 400 km |
|---|---|---|---|
| Uniform gravity | GM/r^2 (1 + 1.5 J2) | 9.8142 | 8.676, cancelled exactly by the anchor's fall |
| Centrifugal | spin^2 R | 0.0339, leaving 9.7803 ([M] 9.780) | None |
| Tidal gradient | 2 GM L/r^3 vertical; GM L/r^3 across | 7.7e-4; 3.8e-4 | 6.4e-4; 3.2e-4 |
| J2 gradient | 4 a_J2 L/r | Included above | 1.8e-6 |
| Second order | 3 g (L/r)^2 | 4.5e-8 | 3.5e-8 |
| Third order | 4 g (L/r)^3 | 2.4e-12 | 1.7e-12 |
| Moon; Sun tide | 2 GM_b R/d^3 | 1.1e-6; 5.1e-7 | In the anchor's path; across the region 4.3e-11; 2.0e-11 |
| Coriolis | 2 spin v | 1.5e-3 at 10 m/s | None |
| Centrifugal variation | spin^2 L | 1.3e-6 | None |

Earth's fall toward the Sun (5.9e-3) cancels the Sun's uniform pull, leaving the tide; the spin-rate (Euler) term is zero because spin is prescribed. Drop rule: a term may be dropped only if its bound over the region is under 1e-9 m/s^2 (6.5 mm for a free body in an hour [D: 0.5 a t^2; threshold E]), decided from sequenced state so all peers agree, and listed in the Reality Report. Only the third-order term and the cross-region variation of third-body tides drop. Coriolis is applied as a rotation of velocity (Boris scheme), which cannot do work.

## 6. Time and warp

The clock is a 64-bit tick count at 1/480 s, range 6.09e8 years [D: 2^63 / 480 / 3.156e7]. Release 1 and multiplayer step 2 use one world clock (VP03): a region's "now" field equals the world tick, and each record also carries its own elapsed ticks, which stop while paused. Warp rate is a world-level, tick-stamped, sequenced input that changes ticks per frame, never a step size (P19, F11).

| Rate | Legal when | Runs |
|---|---|---|
| Below 1 | Always: the governor's time dilation, sequenced (P15) | Everything, slower |
| 1 | Always | Everything |
| Up to 4 [E] | Awake regions hold mechanisms only and fit the budget | More 480 Hz ticks per frame |
| Above 4 | Every region is demoted; otherwise refused, naming the blocking object | Heavy bodies, mode-S objects |
| Above the ceiling | Never; no change of model | Ceiling computed from measured step cost |

| Advances by formula | Paused and reported |
|---|---|
| Heavy bodies; dormant orbits; body spin; torque-free rotation of a rigid dormant object (Jacobi elliptic closed form, stored angular momentum untouched); lumped thermal relaxation (phase 4) | Joints, motors, controllers, heaters, charging, matter micro-state. An object holding rotor momentum keeps its attitude fixed in inertial axes, which conserves angular momentum |

Rule (VP19): a coupled subsystem advances only if every process in it has a formula; otherwise it pauses whole, and the Reality Report lists object and interval.

## 7. Dormant objects

| State | Advance |
|---|---|
| On the surface | None: a body-fixed position riding the spin phase |
| Mode K (default) | Two-body Kepler arc plus J2 drift of node, periapsis and mean anomaly; closed form for any tick; carries a valid-until tick (parent change, terrain) |
| Mode S | Summed gravity of all heavy bodies plus J2, same method and grid; advanced lazily, catch-up capped at 0.1 ms per frame [E]. For occupied, tracked or near-expiry objects, at most 64 [E] |

Modes change only at grid ticks through journalled events, the energy difference booked to the integrator account. Prediction uses the mode the object will fly, and the Reality Report lists each object's mode (VP17). Mode K omits third-body pulls; without J2 drift low orbits would err by 590 km per day [D, 06]. An arc that meets the body's reference surface ends in a declared event: object at rest at the site, mass exact, momentum to the body's account, kinetic energy booked as heat. Mode S in low orbit costs 111 steps per frame at 1e5x [D: 1e5 / 60 / 15] x 2 us [E] = 0.2 ms per object, so tracked low orbiters lower the warp ceiling.

Waking: an awake region's focus comes within the promote radius (from sequenced state, never a camera); a predicted approach to an awake region; a sequenced player command. Dormant objects are not screened against each other.

## 8. Bodies and data

Release 1 has ten bodies, the last five as system barycentres. Phase 2 adds 19 moons, Pluto, Charon, Eris, Ceres and Vesta: Principia's 34 [M, 08]. Values are catalogue figures recalled from memory [E], except Earth's J2 [M, 06]; the generator replaces them.

| Body | GM, m^3/s^2 | Mean radius, km | Sidereal rotation | J2 |
|---|---|---|---|---|
| Sun | 1.32712e20 | 695,700 | 25.4 d | 2e-7 |
| Mercury | 2.2032e13 | 2,439.7 | 58.65 d | 5.0e-5 |
| Venus | 3.2486e14 | 6,051.8 | -243.0 d | 4.5e-6 |
| Earth | 3.9860e14 | 6,371.0 | 23.934 h | 1.0826e-3 |
| Moon | 4.9028e12 | 1,737.4 | 27.32 d | 2.0e-4 |
| Mars | 4.2828e13 | 3,389.5 | 24.62 h | 1.96e-3 |
| Jupiter | 1.26713e17 | 69,911 | 9.93 h | 1.47e-2 |
| Saturn | 3.7941e16 | 58,232 | 10.66 h | 1.63e-2 |
| Uranus | 5.7946e15 | 25,362 | -17.2 h | 3.5e-3 |
| Neptune | 6.8365e15 | 24,622 | 16.1 h | 3.4e-3 |

Initial states are generated on the build server from the DE440 kernel in the PyPI package naif-de440 [M, this round: PyPI reachable, JPL hosts not] at J2000.0 (Julian date 2451545.0, barycentric dynamical time) = tick 0, as parent-relative f64, stored with the kernel checksum (VF15). Pole directions come from the IAU rotation report, not opened here. Licence: NASA material is "not protected by copyright unless noted" [M, 06]; JPL's own terms could not be opened. Only derived numbers ship.

Authored systems: the builder gives a star's mass, radius and temperature, and per body its mass, bulk density, orbital elements at tick 0, spin and albedo A. The tool derives and labels:

| Property | Formula | Earth check [D] |
|---|---|---|
| Radius | (3M / 4 pi density)^(1/3) | 6,371 km at 5,514 kg/m^3 |
| Surface gravity | GM/R^2 - spin^2 R | 9.76 m/s^2 before J2 |
| Escape speed | sqrt(2GM/R) | 11.19 km/s |
| Equilibrium temperature | (L(1-A) / 16 pi sigma d^2)^(1/4) | 254.6 K at A = 0.3; real mean 288 K |

The tool integrates an authored system for 10,000 years on the build server [E]. One that fails runs on two-body rails, declared, because invented systems can be unstable [M, 06: Principia had to alter the stock KSP moons].

## 9. Environment fields (interface only)

environment(body, position, tick) returns density, pressure, temperature and medium velocity; vacuum is a value, returned everywhere in release 1 (P14). starlight(position, tick) returns direction and flux L/(4 pi d^2), 1,361 W/m^2 at 1 AU [M, 06], with an eclipse factor. Atmosphere, drag and heating arrive in phase 4.

## 10. Validation tests

Tolerances are [E] until the first run; every gate runs on the shipped binary and step (P17). B = build server, P = phone.

| Test | Reference | Tolerance | Runs |
|---|---|---|---|
| Own-function vectors | Stored bit patterns | 0 bits | B |
| Heavy hash, 1e6 steps | Same binary on the build server | 0 bits | P (0a), B |
| Warp-schedule invariance | Hash at one tick under three schedules, one through a checkpoint restore | 0 bits | P (0s), B |
| Two-body closure, integrator | Kepler closed form, lunar orbit, 1 year | 0.1 m; energy 1e-12 | B, P |
| Kepler solver closure | Closed form, eccentricity 0.6, 10,000 periods | Position 1e-9; energy 1e-12 | B, P |
| Oracle agreement, 1 year | IAS15-class run of the same model (1e-16 [M, 06]) | Planets 5 m, Moon 1 m; with 34 bodies 100 m, 5 km, Phobos 50 km | B |
| DE440 residual, 10 years | Kernel | Mercury 960 km within 15%; others reported | B |
| Resting weight | m x 9.7803 at Earth's equatorial radius; m x 1.6242 on the Moon [D: GM/R^2] | 0.1% | P (0s) |
| Fall time | sqrt(2h/g) for 21.2 m on Earth, 3.52 m on the Moon (1,000 ticks [D]) | 0.1% | P (0s) |
| Frame invariance | One scripted region, its body at the origin, at 1 AU moving 29.78 km/s, at 30 AU | Local hash 0 bits | B, P |
| Frame-transfer identity | KE' = KE - P.dV + 0.5 M dV^2 | 1 ledger unit per body | B |
| Foucault; eastward drop | 10.64 degrees per hour at 45 degrees; 2.20 cm in 100 m [D, 08] | 2% | 0b |
| Tidal drift | 10 m radial gap at 400 km becomes 10.192 m after 100 s [D, 08] | 1% | 0b |
| J2 node drift, both modes | -3.68 degrees per day at 800 km, 56 degrees [M, 06] | 1% | B |
| Sun-Earth L1, mode S | 1.4976e6 km from Earth [D, 08] | 0.1% | B |
| Small-body recoil | 1 t at 1 m/s onto 1.309e6 kg gives 0.7634 mm/s [D, 08] | 0.1%; residual 0 | Phase 2 |

## 11. Honest limits

- Newtonian only: no relativity (Mercury 42.98 arcseconds per century [M, 06]), no light-time (499 s per AU [D, 06]); valid below 0.01c.
- Point masses, plus J2 for a region's primary and for objects; no higher harmonics, raised tides, precession or collisions between bodies.
- Dormant objects do not interact; mode K has no third-body gravity; internals pause.
- Warp cost grows linearly with warp; in the long run only bit-exact replay is guaranteed.
- Other star systems are catalogue entries; only the occupied one is integrated.
- No figure here is measured on an iPhone 15.

## Interfaces

**Assumed from 01-foundations.** Stable 64-bit ids; the state hash; the Reality Report; the sequenced command stream; a world record with journal and checkpoints holding this tier's body table, integrator record, heavy checkpoints, kick journal, accounts, dormant orbits and region frames; a hierarchical ledger with frame-transfer, gravitational field work, centrifugal potential, deferred reaction, integrator oscillation and radiative accounts; a charter naming Newtonian gravitation as a law (P03, F11).

**Assumed from 03-first-builds.** Phase 0a times the pair kick, one step, sine/cosine and the Kepler solve on the phone and returns the 1e6-step hash (F04, F14). Phase 0s uses this tier's reference sphere and a tangent plane at a site (latitude, longitude, radius) as ground, and gates on the P (0s) rows.

**Needed from later specs.** Mechanism tier: f64 state relative to the anchor; gravity, gradient torque and Coriolis rotation as per-body inputs; a re-base operation; no absolute speed clamp; rest judged relative to the frame (P08). Matter tier: takes the packet per substep, in f32 relative to its own window. Regions: focus, promote and demote radii, aggregate record. Multiplayer: sequencing of warp, tracking and promotion; the heavy checkpoint in the join package and the heavy hash in the fingerprint. Re-centring is a state-derived journalled event here, not a sequenced input.

**Provided.** heavy_state(tick); body orientation; transforms between frames; the gravity packet; warp admission with the blocking object; dormant advance and prediction; derived body properties; environment and starlight samples; heavy checkpoint and hash. API nouns: Site, Orbit, Clock.requestWarp, Predict, Environment.

## Changes to the plan

- "The Wisdom-Holman family" becomes an interface plus PEFRL-60, closed on the build server before phone work (VP01, VF05).
- "About 34 heavy bodies (up to 300-450)" becomes 10, then 34, with a ceiling that falls as warp rises.
- "A pure function of the tick" becomes a function of record, version, grid and journal, checkpointed in the world record, join package and fingerprint (VP02, VF10).
- "Vessels do not perturb planets" becomes exact accounts settled by journalled kicks (VP18).
- "Closed-form advance for dormant small objects" becomes modes K and S (VP17).
- "Each region has its own now" becomes one world clock, with warp above 4x only when every region is demoted (VP03).
- Surface regions use the rotating frame with an integer spin phase (VP05); anchors are double-double.
- ORRERY is no longer described as fixed rails for the real system.
- "Their orbits give exact test answers" becomes: two-body closed forms are the exact checks; DE440 stays on the build server (VF15).

## Open items

- Whether Safari's wasm gives Node's hashes, and the A16 timings behind every cost and warp ceiling.
- The oracle run: n-body error of PEFRL-60 for 10 and 34 bodies, whether compensated sums are needed against round-off, and the bake-off with the multistep and nested methods.
- Whether the WebAssembly specification requires a correctly rounded square root (recalled, not checked).
- Thresholds marked [E]: re-centre distances, the 1e-9 m/s^2 floor, 256 steps per period, checkpoint spacing, 64 mode-S objects, the frame-switch horizon.
- A cheaper mode-S step for low orbits (Wisdom-Holman for objects).
- JPL's licence terms, the IAU pole table and the catalogue values recalled from memory.
