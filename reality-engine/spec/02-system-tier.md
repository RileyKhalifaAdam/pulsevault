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

| Distance from frame origin | f64 position spacing [D: 2^(exponent-52)] | Speed there | f64 velocity spacing |
|---|---|---|---|
| Earth's radius, 6.371e6 m | 0.93 nm | 7.67 km/s | 9.1e-13 m/s |
| 1 AU | 31 um | 29.78 km/s | 3.6e-12 m/s |
| 30 AU | 0.98 mm | 5.43 km/s | 9.1e-13 m/s |
| 1 light-year | 2 m | 0.01c | 4.7e-10 m/s |

The worst-case position or velocity error is half a spacing per operation. Double-double is 2^53 times finer: 3.4e-21 m at 1 AU, 2.2e-16 m at one light-year [D]. Region contents never hold these magnitudes: local spacing is 9.1e-13 m inside 8 km anywhere [D] (F10).

## 2. The region frame

| | Surface region | Free-fall region (orbit, cruise) |
|---|---|---|
| Anchor | A point fixed in the body's rotating frame; the ground is static | A point falling under the summed gravity of all heavy bodies plus the primary's J2, stepped every tick |
| Axes | Parallel to the body-fixed axes | Parallel to system axes; never rotate |
| Re-centre when the focus object is | Over 256 m away [E]: shift positions | Over 256 m or 32 m/s away [E]: shift positions and velocities |

Re-centring is decided from sequenced state at a frame boundary, so every peer does it at the same tick, and is journalled. Shifts are multiples of 2^-16 m and m/s: the anchor absorbs them exactly, each body rounds by at most 4.5e-13 m and 5.7e-14 m/s [D: half a spacing], and that residual plus the energy change -P.dV + 0.5 M dV^2 is booked as frame transfer.

Orbital speed (7.67 km/s) lives only in the anchor; local speeds stay under 32 m/s, spacing 3.6e-15 m/s [D], so millimetres survive and no contact solver sees orbital speed (P11).

A region is the surface kind while anything in it touches ground; it becomes free-fall once its focus is airborne and 2 km or 20 s from terrain [E], in one transaction (v_inertial = v_local + spin x r).

Leaving: an island past the demote radius is demoted into the parent body's frame, surface-dormant if at rest on the ground, an arc if in free flight. One still moving in contact has no formula: the region grows to keep it, or it is paused and reported, never deleted or rewound (F12, VP19).

## 3. Orbit integrator

**Decision (VP01).** Heavy bodies (10 in release 1, 34 in Phase 2) attract each other and everything else pairwise. Objects (vessels, debris, anchors) attract nothing. Two-body rails survive only as mode K for dormant objects and as the fallback for an uncertified authored system.

**Interface.** heavy_state(tick) is bit-exact and equals F(initial-record hash, arithmetic version, integrator id and step, journal of kicks and mass changes, tick), whatever the warp history or observer (VP02). Changing the method is a journalled event continuing from a checkpoint.

**Method.** Release 1 uses "PEFRL-60": a fourth-order symplectic composition (energy error stays bounded) of five drifts and four kicks, coefficients 0.1786178958448091, -0.2123418310626054, -0.06626458266981849 (Omelyan et al., from memory; order confirmed by a run this session). Step H = 28,800 ticks = 60 s [D], on tick multiples of H. It follows VF05, not VP01's baseline (ORRERY's 12th-order multistep at 600 s): it is self-starting, checkpoints as positions and velocities, takes kicks without a restart, and needs only add, subtract, multiply, divide and square root. The multistep and nested Wisdom-Holman methods can replace it only through the oracle test.

1. Bodies in ascending id, state relative to the parent. Drift: position gains coefficient x H x velocity.
2. Kick: for each pair once, form the separation through the tree, compute 1/(r^2 sqrt(r^2)), apply equal and opposite accelerations; velocity gains coefficient x H x (own acceleration minus parent's).
3. Every 1,024 nodes (17.07 h [D]) settle accounts, write a checkpoint and hash.
4. Between nodes, quintic Hermite interpolation; worst case Phobos, H^6 n^6 r / 46,080 = 1.3 nm [D].

**Reaction and mass (VP18).** Every body has an exact deferred-reaction momentum account and an integer mass-change account. At a checkpoint node, once account / mass reaches the body's velocity spacing, the representable part becomes a journalled kick. Thresholds: 2.2e13 kg m/s for Earth, 8.4e9 Moon, 4.8e3 Phobos [D: mass x velocity spacing]; a 10 t lander at 10 m/s kicks Phobos by 21 spacings, never Earth. Objects whose orbital momentum exceeds a threshold are integrated as two-way pairs.

**Step and close encounters.** The heavy step never changes. A guard requires 256 steps per local circular period for every heavy pair [E] (Phobos has 459 [D: 27,554 s / 60]); a violation is a journalled fault that refuses warp. Mode-S objects step at H/2^k, k up to 7, chosen at nodes from the closest possible approach in the next 60 s; low orbit gets 15 s.

| After one year [D: two-body f64 run this session] | Along-track error | Relative energy error |
|---|---|---|
| Moon; planets | 7 mm; under 0.3 m (round-off) | 2e-13 |
| Phobos (Phase 2) | 41 m (three-stage Forest-Ruth: 2.2 km) | 3e-12 |

Published references: leapfrog at 60 s gives Earth 5.6 m per year [D, 06]; Wisdom-Holman at 5 days holds energy to 1e-8 [M, arXiv:2307.05683 via 06]. N-body errors are [E] until the oracle run.

**Cost.** One pair costs 5.4-6.9 ns in wasm on a 2.1 GHz Xeon [M, this round]; the A16 is 1-2.5x slower [E]. A step of four evaluations is 1.0-1.2 us for 10 bodies (45 pairs) and 12-15.5 us for 34 (561 pairs), so 0.5 ms per frame allows warp of 1.4e6-1.9e6x and 1.2e5-1.5e5x [D]. Body-count ceiling: pairs <= 6.5e7 / warp [D: 0.5 ms x 3,600 / (4 x 6.9 ns)], so 360 bodies at 1,000x and 36 at 100,000x.

**Cache (VF10).** A checkpoint is 1,632 B for 34 bodies [D: 34 x 6 x 8] plus accounts. The last 64 are kept; older ones thin to every 65,536 nodes, so any tick costs at most 1.0 s of re-stepping [D: 65,536 x 15.5 us].

## 4. Bit-exactness

The shipped .wasm binary is the canonical arithmetic; a server or native app runs it unless CI shows equal hashes (VP07).

| Rule | Detail |
|---|---|
| Allowed | f64 add, subtract, multiply, divide, square root; integers. Such a kernel hashed identically on native x86-64 and wasm under Node [M, this round]; Safari unverified |
| Forbidden | Host maths, fused multiply-add, relaxed SIMD, threads, reassociation. A non-finite result halts the step; no NaN is hashed |
| Own functions | Sine, cosine: exact octant from the integer phase, then a fixed polynomial. Stumpff series for the Kepler solver: fixed degree and reduction. Kepler solve: exactly 2 Halley and 2 Newton iterations, 1e-13 relative [M, same paper]. Jacobi elliptic functions (Phase 1): fixed Landen steps |
| Order | Ascending stable id; explicit parentheses; constants as bit patterns in an arithmetic-version table |
| Versioning | Binary hash, arithmetic version and integrator id in the world record and handshake; mismatch refused |

Tests: the first two rows of section 10, in CI and on the phone.

## 5. Gravity supplied to a region

Each tick a region receives a *gravity packet*: per-body acceleration (free-fall: the primary's pull at the body minus at the anchor, in Encke's cancellation-free form; surface: gravity plus centrifugal), the 3x3 gradient for the torque 3(GM/r^3) r x (I r), the spin vector and potential differences for the ledger.

Sizes at L = 250 m from the anchor (the plan's "250 m" read as radius), [D], m/s^2:

| Term | Formula | Earth's equator | Low orbit, 400 km |
|---|---|---|---|
| Uniform gravity | GM/r^2 (1 + 1.5 J2) | 9.8142 | 8.676, cancelled exactly by the anchor's fall |
| Centrifugal | spin^2 R | 0.0339, leaving 9.7803 ([M] 9.780) | None |
| Tidal gradient | 2 GM L/r^3 vertical; GM L/r^3 across | 7.7e-4; 3.8e-4 | 6.4e-4; 3.2e-4 |
| Second; third order | 3 g (L/r)^2; 4 g (L/r)^3 | 4.5e-8; 2.4e-12 | 3.5e-8; 1.7e-12 |
| Moon; Sun tide | 2 GM_b R/d^3 | 1.1e-6; 5.1e-7 | In the anchor's path; across the region 4.3e-11; 2.0e-11 |
| Coriolis | 2 spin v | 1.5e-3 at 10 m/s | None |

Earth's own fall (5.9e-3 toward the Sun) cancels the Sun's uniform pull, leaving the tide; the Euler term is zero because spin is prescribed. Drop rule: a term may be dropped only if its bound over the region is under 1e-9 m/s^2 (6.5 mm for a free body in an hour [D: 0.5 a t^2; threshold E]); the decision uses sequenced state, so peers agree, and is listed in the Reality Report. Only the third-order term and the cross-region tide variation drop. Coriolis is applied as a velocity rotation (Boris scheme), which cannot do work.

## 6. Time and warp

The clock is a 64-bit tick count at 1/480 s, range 6.09e8 years [D: 2^63 / 480 / 3.156e7]. Release 1 and multiplayer step 2 use one world clock (VP03): a region's "now" field equals the world tick, and each record also carries its own elapsed ticks, which stop while paused. Warp rate is a world-level, tick-stamped, sequenced input that changes ticks per frame, never a step size (P19, F11).

| Rate | Rule |
|---|---|
| Below 1 | Always legal: the governor's time dilation, sequenced (P15) |
| 1 to 4 [E] | Legal when awake regions hold mechanisms only and fit the budget; more 480 Hz ticks per frame |
| Above 4 | Legal when every region is demoted, else refused naming the blocking object; only heavy bodies and mode-S objects step |
| Above the ceiling | Refused; the model never changes, and the ceiling comes from measured step cost |

Advancing by formula: heavy bodies, dormant orbits, body spin, torque-free rotation of a rigid dormant object (Jacobi elliptic closed form) and, from phase 4, lumped thermal relaxation. Paused and reported: joints, motors, controllers, heaters, charging, matter micro-state. An object with rotor momentum keeps its attitude fixed in inertial axes, conserving angular momentum. Rule (VP19): a coupled subsystem advances only if every process in it has a formula; otherwise it pauses whole and the Reality Report lists it.

## 7. Dormant objects

| State | Advance |
|---|---|
| On the surface | None: a body-fixed position riding the spin phase |
| Mode K (default) | Two-body Kepler arc plus J2 drift of node, periapsis and mean anomaly; closed form for any tick; carries a valid-until tick (parent change, terrain) |
| Mode S | Summed gravity of all heavy bodies plus J2, same method and grid; advanced lazily, catch-up capped at 0.1 ms per frame [E]. For occupied, tracked or near-expiry objects, at most 64 [E] |

Modes change only at grid ticks through journalled events, the energy difference booked to the integrator account. Prediction uses the mode the object will fly; the Reality Report lists each object's mode (VP17). An arc that meets the body's reference surface ends in a declared event: object at rest at the site, mass exact, momentum to the body's account, kinetic energy booked as heat. A tracked low orbiter costs 0.2 ms per frame at 1e5x [D: 1e5 / 60 / 15 = 111 steps, x 2 us E], lowering the warp ceiling.

Waking: an awake region's focus comes within the promote radius (from sequenced state, never a camera); a predicted approach to an awake region; a sequenced player command.

## 8. Bodies and data

Release 1 has ten bodies, the last five as system barycentres. Phase 2 adds 19 moons, Pluto, Charon, Eris, Ceres and Vesta: Principia's 34 [M, 08]. Values are catalogue figures recalled from memory [E]; the generator replaces them and adds each J2.

| Body | GM, m^3/s^2 | Mean radius, km | Sidereal rotation |
|---|---|---|---|
| Sun | 1.32712e20 | 695,700 | 25.4 d |
| Mercury | 2.2032e13 | 2,439.7 | 58.65 d |
| Venus | 3.2486e14 | 6,051.8 | -243.0 d |
| Earth | 3.9860e14 | 6,371.0 | 23.934 h |
| Moon | 4.9028e12 | 1,737.4 | 27.32 d |
| Mars | 4.2828e13 | 3,389.5 | 24.62 h |
| Jupiter | 1.26713e17 | 69,911 | 9.93 h |
| Saturn | 3.7941e16 | 58,232 | 10.66 h |
| Uranus | 5.7946e15 | 25,362 | -17.2 h |
| Neptune | 6.8365e15 | 24,622 | 16.1 h |

Initial states are generated on the build server from the DE440 kernel in the PyPI package naif-de440 [M, this round: PyPI reachable, JPL hosts not] at J2000.0 (Julian date 2451545.0 TDB) = tick 0, as parent-relative f64, stored with the kernel checksum (VF15). Licence: NASA material is "not protected by copyright unless noted" [M, 06]; JPL's own terms are unopened, so only derived numbers ship.

Authored systems: the builder gives a star's mass, radius and temperature, and per body its mass, bulk density, orbital elements at tick 0, spin and albedo A. The tool derives and labels:

| Property | Formula | Earth check [D] |
|---|---|---|
| Radius | (3M / 4 pi density)^(1/3) | 6,371 km at 5,514 kg/m^3 |
| Surface gravity | GM/R^2 - spin^2 R | 9.76 m/s^2 before J2 |
| Escape speed | sqrt(2GM/R) | 11.19 km/s |
| Equilibrium temperature | (L(1-A) / 16 pi sigma d^2)^(1/4) | 254.6 K at A = 0.3; real mean 288 K |

An authored system must survive a 10,000-year build-server integration [E]; otherwise it runs on declared two-body rails, since invented systems can be unstable [M, 06: Principia altered the stock KSP moons].

## 9. Environment fields (interface only)

environment(body, position, tick) returns density, pressure, temperature and medium velocity; vacuum is a value, returned everywhere in release 1 (P14). starlight(position, tick) returns direction and flux L/(4 pi d^2), 1,361 W/m^2 at 1 AU [M, 06], with an eclipse factor. Atmosphere, drag and heating arrive in phase 4.

## 10. Validation tests

Tolerances are [E] until the first run; every gate runs on the shipped binary and step (P17). B = build server, P = phone.

| Test | Reference | Tolerance | Runs |
|---|---|---|---|
| Bit-exactness | Stored bit patterns, 10,000 inputs per own function; hash of 1e6 heavy steps against the build server | 0 bits | P (0a), B |
| Warp invariance | Hash at one tick under three schedules, one through a checkpoint restore | 0 bits | P (0s), B |
| Two-body closure | Kepler closed form: integrator on a lunar orbit, 1 year; mode-K solver at eccentricity 0.6, 10,000 periods | 0.1 m; 1e-9 relative; energy 1e-12 | B, P |
| Oracle, 1 year | IAS15-class run of the same model (1e-16 [M, 06]) | Planets 5 m, Moon 1 m; with 34 bodies 100 m, 5 km, Phobos 50 km | B |
| DE440, 10 years | Kernel; Mercury off by 960 km for lack of relativity [D, 06] | Within 15%; others reported | B |
| Weight and fall | m x 9.7803 at Earth's equatorial radius, m x 1.6242 on the Moon [D: GM/R^2]; sqrt(2h/g) over 21.2 m and 3.52 m (1,000 ticks [D]) | 0.1% | P (0s) |
| Frame invariance | One scripted region, its body at the origin, at 1 AU moving 29.78 km/s, at 30 AU; re-base identity KE' = KE - P.dV + 0.5 M dV^2 | Local hash 0 bits; 1 ledger unit per body | B, P |
| Region terms | Foucault 10.64 degrees per hour at 45 degrees; 10 m radial gap at 400 km becomes 10.192 m in 100 s [D, 08] | 2%; 1% | 0b |
| Dormant modes | J2 node drift -3.68 degrees per day at 800 km, 56 degrees [M, 06] | 1% | B |
| Small-body recoil | 1 t at 1 m/s onto 1.309e6 kg gives 0.7634 mm/s [D, 08] | 0.1%; residual 0 | Phase 2 |

## 11. Honest limits

- Newtonian only: no relativity (Mercury 42.98 arcseconds per century [M, 06]) or light-time (499 s per AU [D, 06]); valid below 0.01c.
- Point masses, plus J2 for a region's primary and for objects; no higher harmonics, raised tides, precession or body collisions.
- Dormant objects do not interact; mode K has no third-body gravity; internals pause.
- Other star systems are catalogue entries; warp cost grows linearly with warp.

## Interfaces

**Assumed from 01-foundations.** Stable 64-bit ids; the state hash; the Reality Report; the sequenced command stream; a world record with journal and checkpoints holding this tier's body table, integrator record, heavy checkpoints, kick journal, accounts, dormant orbits and region frames; a hierarchical ledger with frame-transfer, field-work, centrifugal-potential, deferred-reaction, integrator-oscillation and radiative accounts; a charter naming Newtonian gravitation as a law (P03, F11).

**Assumed from 03-first-builds.** Phase 0a times the pair kick, one step, sine/cosine and the Kepler solve on the phone and returns the 1e6-step hash (F04, F14). Phase 0s uses this tier's reference sphere and a tangent plane at a site as ground.

**Needed from later specs.** Mechanism tier: f64 state relative to the anchor; gravity, gradient torque and Coriolis rotation as per-body inputs; a re-base operation; no absolute speed clamp; rest judged in the frame (P08). Matter tier: one vector, the gradient and the spin per substep, f32 relative to its own window. Regions: focus, promote and demote radii, aggregate record. Multiplayer: sequencing of warp, tracking and promotion; the heavy checkpoint in the join package and its hash in the fingerprint. Re-centring is a state-derived journalled event, not a sequenced input.

**Provided.** Every function named above, plus frame transforms, warp admission, prediction, derived body properties and the heavy checkpoint and hash. API nouns: Site, Orbit, Clock.requestWarp, Predict, Environment.

## Changes to the plan

- "The Wisdom-Holman family" becomes an interface plus PEFRL-60, closed on the build server before phone work; ORRERY's real-system mode was not fixed rails (VP01, VF05).
- "About 34 heavy bodies (up to 300-450)" becomes 10, then 34, with a ceiling that falls as warp rises.
- "A pure function of the tick" becomes a function of record, version, grid and journal, checkpointed in the world record, join package and fingerprint (VP02, VF10).
- "Vessels do not perturb planets" becomes exact accounts settled by journalled kicks (VP18); dormant objects get modes K and S (VP17).
- "Each region has its own now" becomes one world clock; warp above 4x needs every region demoted (VP03).
- Surface regions rotate with the body, on an integer spin phase (VP05).
- "Their orbits give exact test answers" becomes: two-body closed forms are the exact checks; DE440 stays on the build server (VF15).

## Open items

- Whether Safari's wasm gives Node's hashes; the A16 timings behind every cost and warp ceiling.
- The oracle run: n-body error of PEFRL-60 for 10 and 34 bodies, whether compensated sums are needed, and the bake-off with the multistep and nested methods.
- Whether WebAssembly requires a correctly rounded square root (recalled, not checked).
- Every [E] threshold, set from the first runs.
- A cheaper mode-S step for low orbits (Wisdom-Holman for objects).
- JPL's licence terms, the IAU pole table, and the recalled catalogue values.
