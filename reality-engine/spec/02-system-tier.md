# System tier: frames, orbits, gravity and time

The system tier is the CPU, bit-exact layer that knows where every body of a star system is at every tick and tells each region of detail what gravity it feels. Heavy bodies move under mutual Newtonian attraction, not on two-body rails, by one fixed-step method on an absolute tick grid; the method is data, closed by a build-server test. Surface regions ride the body's rotating frame; orbital regions are non-rotating free-fall frames. Heavy-body state is a function of the world record and its journal, so it is checkpointed and hashed. Release 1 builds the ten-body integrator, surface regions, the clock and warp; free-fall regions, dormant orbits, kicks and the 34-body set arrive in Phase 2.

Tags: **[M]** measured, **[D]** derived, **[E]** estimate until the Phase 0a probe or first build-server run, **[C]** design choice stored in the world record. 06 and 08 are the research and design files; "raw-v2" is raw-results-v2-round.json. A "review run" is a throwaway two-body or J2 calculation made by the author and repeated in review. Earth: GM 3.986e14 m^3/s^2, equatorial radius 6.378e6 m, spin 7.292e-5 rad/s [E, recalled], oblateness J2 1.0826e-3 [M, 06]. G = 6.6743e-11 [E, recalled]; bodies are defined by GM, and mass = GM/G serves only the accounts.

## 1. Frame tree and number formats

| Level | Frame | Format |
|---|---|---|
| G | Star-system origins | Three 64-bit integers, km [C]: +/-975,000 light-years [D: 2^63 km / 9.461e12]; error 0.5 km |
| S | Body relative to its parent, non-rotating axes | 64-bit floats (f64), metres and m/s |
| B | Body-fixed rotating frame | f64; spin phase is a 64-bit integer fraction of a turn, phase0 + rate x tick, wrapping exactly, so it never loses precision (VP05); the pole is a stored matrix |
| R | Region | Surface anchor: f64 in B. Free-fall anchor: double-double position, f64 velocity. Contents: f64 within 8 km |

*Double-double* holds a number as two f64 (about 106 bits) using only add, subtract and multiply. Any coordinate that can exceed 2^43 m = 58.8 AU [D] is double-double too.

| Distance from frame origin | f64 position spacing [D: 2^(exponent-52)] | Speed there | f64 velocity spacing |
|---|---|---|---|
| Earth's radius, 6.371e6 m | 0.93 nm | 7.67 km/s | 9.1e-13 m/s |
| 1 AU | 31 um | 29.78 km/s | 3.6e-12 m/s |
| 30 AU | 0.98 mm | 5.43 km/s | 9.1e-13 m/s |
| 1 light-year | 2 m | 0.01c | 4.7e-10 m/s |

One operation errs by at most half a spacing. Repeated operations add as a random walk of about spacing x sqrt(count / 12): under 0.5 m a year for Neptune [D: 0.98 mm x sqrt(2.6e6 drifts / 12); review run 0.07 m]. Double-double is 2^53 times finer: 3.4e-21 m at 1 AU, 2.2e-16 m at one light-year [D]. Region contents never hold these magnitudes: local spacing is 9.1e-13 m inside 8 km [D] (F10).

## 2. The region frame

| | Surface region (axes body-fixed) | Free-fall region (orbit, cruise; axes never rotate) |
|---|---|---|
| Anchor | A point fixed in the body's rotating frame; the ground is static | A reference point falling under the summed gravity of all heavy bodies plus the primary's J2 |
| Re-centre when the focus object is | Over 256 m away [E]: shift positions | Over 256 m or 32 m/s away [E]: shift positions and velocities |

The free-fall anchor is not a body. It is advanced every tick by the same update rule as the mechanism tier's free bodies, and contents feel gravity at their own position minus the anchor's actual acceleration. A body's inertial path therefore does not depend on which anchor carries it, beyond rounding.

Re-centring is computed from sequenced state at ticks that are multiples of 8 and journalled as a member of 01's closed command set; no peer chooses its timing. Shifts are multiples of 2^-16 m and m/s [C, 01]: the ledger terms and the anchor are exact, and each body's state rounds by at most half a spacing (4.5e-13 m; 5.7e-14 m/s below 1,024 m/s [D]), booked with the energy change -P.dV + 0.5 M dV^2 as frame transfer. A ship thrusting at 10 m/s^2 re-centres every 3.2 s [D: 32 / 10].

Orbital speed (7.67 km/s) lives only in the anchor; local speeds stay under 32 m/s, spacing 3.6e-15 m/s [D], so millimetres survive and no contact solver sees orbital speed (P11).

A region is the surface kind while anything in it touches ground; it becomes free-fall once its focus is airborne and 2 km or 20 s from terrain [E], in one transaction under 01's rotating-to-inertial rule (v_inertial = v_local + spin x r).

Leaving: an island past the demote radius is demoted into the parent body's frame, surface-dormant if at rest on the ground, an arc if in free flight. One still moving in contact has no formula: the region grows to keep it, or it is paused and reported, never deleted or rewound (F12, VP19).

## 3. Orbit integrator

**Decision (VP01, VF05).** Heavy bodies (10 in release 1, 34 in Phase 2) attract each other and everything else pairwise; objects (vessels, debris, anchors) attract nothing. Two-body rails survive only as mode K for dormant objects and as the fallback for an uncertified authored system.

**Interface (VP02).** heavy_state(tick) is bit-exact and equals F(initial-record hash, arithmetic version, integrator id and step, journal of kicks and mass changes, tick), whatever the warp history or observer. Changing the method is a journalled event continuing from a checkpoint.

**Method.** Release 1 uses "PEFRL-60": a fourth-order symplectic composition (its energy error stays bounded instead of drifting) with step H = 28,800 ticks = 60 s [C], on tick multiples of H. One step is five drifts weighted a, b, 1 - 2(a + b), b, a, alternating with four kicks weighted (1 - 2c)/2, c, c, (1 - 2c)/2, where a = 0.1786178958448091, b = -0.06626458266981849, c = -0.2123418310626054 (Omelyan, Mryglod and Folk, recalled [E]; doubling the step raised the error 16-fold in a review run, confirming fourth order). It follows VF05, not VP01's baseline (ORRERY's 12th-order multistep at 600 s): it is self-starting, checkpoints as positions and velocities, takes kicks without a restart, and needs only the five basic operations. If it fails the ten-body oracle row, the step is halved or the multistep method taken before any phone build; nested Wisdom-Holman may replace it only through the same test.

1. Bodies in ascending id, state relative to the parent. Drift: position gains weight x H x velocity.
2. Kick: for each pair once, form the separation through the tree and the factor 1/(r^2 sqrt(r^2)); body i gains GM_j x separation x factor and body j loses GM_i x separation x factor, so forces are equal and opposite and total momentum holds to rounding. Velocity gains weight x H x (own acceleration minus parent's).
3. At every node settle the accounts below. Every 1,024 nodes [C] (17.07 h [D]) write a checkpoint and hash.
4. Between nodes, quintic Hermite interpolation of position, velocity and acceleration, part of the method's definition. It needs a fifth evaluation per step while anything reads between nodes. Worst case Phobos, H^6 n^6 r / 46,080 = 1.3 nm [D].

**Reaction and mass (VP18).** Each body's double-double ledger holds a deferred-reaction momentum account; its integer account holds mass change. The momentum account receives minus the change in inertial momentum of whatever the body pulled or pushed, so fictitious forces never enter it. At a node, once account / carried mass reaches the body's velocity spacing, the representable part becomes a journalled kick and the account is debited by exactly what the f64 velocity gained. Carried mass is the body plus dormant objects resting on it. Awake surface regions on the body are re-based by the opposite velocity in the same transaction, so loose contents keep their inertial velocity and contact passes on the rest. Thresholds: 2.2e13 kg m/s for Earth, 8.4e9 Moon, 4.8e3 Phobos [D: mass x velocity spacing]; a 10 t lander at 10 m/s kicks Phobos by 21 spacings, never Earth. Objects whose orbital momentum exceeds a threshold are integrated as two-way pairs. GM changes by a journalled event once mass change x G reaches one spacing of GM (9.4e8 kg for Earth [D: 2^-4 / G]). Spin is prescribed, so angular reaction is posted to 01's planet reservoir and reported; settling it as integer rate changes is Phase 2. One rate unit of Earth is 1.3e22 kg m^2/s [D: 1.6e-16 rad/s x 8.0e37 kg m^2], never reached.

**Step and close encounters.** The heavy step never changes. A guard requires 256 steps per local circular period for every heavy pair [E] (Phobos has 459 [D: 27,554 s / 60]); a violation is a journalled, reported fault that refuses warp. Heavy bodies get no other close-encounter handling. Mode-S objects step at H/2^k, the smallest k (at most 7 [C]) that meets the same guard at the closest approach possible before the next node; low orbit gets 15 s.

| After one year, two bodies [D: review runs] | Along-track error | Relative energy error |
|---|---|---|
| Moon; planets | Millimetres; under 0.5 m. All round-off | Under 1e-11 |
| Phobos (Phase 2) | 40 m (at 120 s: 645 m; three-stage Forest-Ruth: 1.9 km) | Under 1e-11 |

Round-off error grows as time^1.5 (Brouwer's law [M, 06]): 0.3 m in a year becomes about 300 m in a century [D: x 100^1.5]. Published references: leapfrog at 60 s gives Earth 5.6 m per year [D, 06]; Wisdom-Holman at 5 days holds energy to 1e-8 [M, arXiv:2307.05683 via 06]. N-body errors are [E] until the oracle run.

**Cost.** One pair costs 5.4-6.9 ns in wasm on a 2.1 GHz Xeon [M, raw-v2]; the A16 is 1-2.5x slower [E]. A step of four evaluations is 1.0-1.2 us for 10 bodies (45 pairs) and 12-15.5 us for 34 (561 pairs) [D], so 0.5 ms per frame allows warp of 1.4e6-1.9e6x and 1.2e5-1.5e5x on the Xeon [D], up to 2.5 times less on the phone [E]. Body-count ceiling [E]: pairs <= 6.5e7 / warp [D: 0.5 ms x 3,600 / (4 x 6.9 ns)], so 360 bodies at 1,000x and 36 at 100,000x.

**Cache (VF10).** A checkpoint is 1,632 B for 34 bodies [D: 34 x 6 x 8] plus accounts. The newest 64 are kept [E] (45.5 days, 104 kB [D]); older ones thin to every 65,536 nodes [C]. Reaching any tick costs at most 16 ms of re-stepping inside that window and 1.0 s outside [D: 1,024 and 65,536 x 15.5 us]. Every snapshot, journal checkpoint and join package carries the current node and unsettled accounts, and the world fingerprint hashes them. Prediction of heavy bodies is cosmetic: time-sliced, never hashed, same arithmetic. A year ahead costs 8.2 s [D: 525,960 x 15.5 us] and stores every 1,024th node, 0.84 MB [D: 514 x 1,632 B].

## 4. Bit-exactness

The shipped .wasm binary is the canonical arithmetic; a server or native app runs it unless CI shows equal hashes (VP07).

| Rule | Detail |
|---|---|
| Allowed | f64 add, subtract, multiply, divide, square root, each correctly rounded under IEEE 754, which WebAssembly follows [E, recalled]; integers. Such a kernel hashed identically on native x86-64 and wasm under Node [M, raw-v2]. ARM64 is reached only through Safari on the phone, unverified |
| Forbidden | Host maths, fused multiply-add, relaxed SIMD, threads, reassociation. A non-finite result stops the clock with a report (01 rule 5); no NaN is hashed |
| Own functions | Sine, cosine: exact octant from the integer phase, or a fixed reduction of an f64 angle, then a fixed polynomial. Stumpff series for the Kepler solver: fixed degree and reduction. Kepler solve: exactly 2 Halley and 2 Newton iterations, 1e-13 relative [M, arXiv:2307.05683 via 06]. Phase 2 attitude: Jacobi elliptic functions by a fixed number of Landen steps (08). Cube and fourth roots occur only in authoring; results are stored as bit patterns |
| Order | Ascending stable id; explicit parentheses; constants as bit patterns in an arithmetic-version table |
| Versioning | Binary hash, arithmetic version and integrator id in the world record and handshake; mismatch refused |

Tests: section 10, rows 1-2, on the build server (Node, x86-64) and the phone (Safari, ARM64). A native build is not canonical until it matches.

## 5. Gravity supplied to a region

Each tick a region receives a *gravity packet*: a per-body acceleration evaluated at the body's own position (free-fall: the primary's pull with J2 at the body minus at the anchor, in Encke's form, which avoids subtracting nearly equal numbers; surface: gravity with J2 plus centrifugal); the third-body tide at the anchor; the 3x3 gradient for the torque 3(GM/r^3) u x (I u), u the unit vector to the primary; the spin vector; and, for the ledger, the potential differences of exactly the field applied.

Sizes at L = 250 m from the anchor (the plan's "250 m" read as radius), [D], m/s^2:

| Term | Formula | Earth's equator | Low orbit, 400 km |
|---|---|---|---|
| Uniform gravity | GM/r^2; on the equator x (1 + 1.5 J2) | 9.8142, of which J2 0.0159 | 8.676 plus J2 0.0125, cancelled exactly by the anchor's fall |
| Centrifugal | spin^2 R | 0.0339, leaving 9.7803 (9.780 [M, 06]); 1.3e-6 across the region | None |
| Tidal gradient | 2 GM L/r^3 vertical; GM L/r^3 across | 7.7e-4; 3.8e-4 | 6.4e-4; 3.2e-4; J2 part 1.8e-6 |
| Second; third order | 3 g (L/r)^2; 4 g (L/r)^3 | 4.5e-8; 2.4e-12 | 3.5e-8; 1.7e-12 |
| Moon; Sun tide | 2 GM_b R/d^3 | 1.1e-6; 5.1e-7 | In the anchor's path; across the region 4.3e-11; 2.0e-11 |
| Coriolis | 2 spin v | 1.5e-3 at 10 m/s | None |

Earth's fall toward the Sun (5.9e-3) cancels the Sun's uniform pull, leaving the tide; the Euler term is zero because spin is prescribed. Drop rule: a term may be dropped only if its bound over the region is under 1e-9 m/s^2 [E] (6.5 mm for a free body in an hour [D: 0.5 a t^2]); the decision uses sequenced state, so peers agree, and is listed in the Reality Report. Only the variation of third-body tide across the region and third-order terms in the torque and matter-tier expansions drop. Coriolis is applied as a velocity rotation (Boris scheme: speed-preserving, basic operations only), so it does no work.

## 6. Time and warp

The clock is a 64-bit tick count at 1/480 s, range 6.09e8 years [D: 2^63 / 480 / 3.156e7]. Release 1 and multiplayer step 2 use one world clock (VP03): a region's "now" field equals the world tick, and each record also carries its own elapsed ticks, which stop while paused. Warp rate is a world-level, tick-stamped, sequenced input that changes ticks per frame, never a step size (P19, F11).

| Rate | Rule |
|---|---|
| Below 1 | Always legal: the governor's time dilation, sequenced (P15) |
| 1 to 4 [E] | Legal when awake regions hold mechanisms only and the sequencer admits it against the region's budget |
| Above 4 | Legal when every region is demoted, else refused naming the blocking object; only heavy bodies and mode-S objects step |
| Above the ceiling | Refused; the model never changes. The ceiling is a sequenced world value, the lowest any peer measured |

A wake trigger caps a frame's tick count, so every peer stops on the same tick.

Advancing by formula: heavy bodies, dormant orbits, body spin and, later, torque-free rotation of a rigid dormant object (Phase 2) and lumped thermal relaxation (phase 4). Paused and reported: joints, motors, controllers, heaters, charging, matter micro-state. An object with rotor momentum has its attitude paused in inertial axes and reported, which keeps angular momentum exact (VP14). Rule (VP19): a coupled subsystem advances only if every process in it has a formula; otherwise it pauses whole and the Reality Report lists it.

## 7. Dormant objects

| State | Advance |
|---|---|
| On the surface | None: a body-fixed position riding the spin phase. Rotor momentum turned by the planet is posted to the planet reservoir |
| Mode K (default) | Two-body Kepler arc about the parent plus J2 drift of node, periapsis and mean anomaly, on *mean* elements: the J2 wobble of the semi-major axis (6 km in low orbit) is removed to first order at demotion. Without that the arc drifts 880 km a day along-track, ahead or behind depending on where it was demoted; with it, under 10 km [D: review run, 400 km, 51.6 degrees]. Closed form for any tick; zero elapsed ticks returns the stored state bit for bit. Carries a valid-until tick (terrain, or leaving the parent's sphere of influence a (m/M)^0.4, 925,000 km for Earth [D]) |
| Mode S | Summed gravity of all heavy bodies plus J2, same method and grid; about 1 m a day from the awake path in low orbit [D: Phobos run scaled by (nH)^4]. Lazy but invisible: a fixed number of steps per frame set by a sequenced input [E: about 0.1 ms], and any read of the state forces catch-up first. For occupied, tracked or near-expiry objects, at most 64 [E]; a request beyond that is refused, never downgraded |

Modes change only at grid ticks through journalled events. Prediction uses the mode the object will fly; the Reality Report lists each object's mode (VP17). A tracked low orbiter costs 0.2 ms per frame at 1e5x [D: 1e5 / 60 / 15 = 111 steps, x 2 us E], lowering the warp ceiling.

Waking, tested at every node from sequenced state, never a camera: an awake region's focus comes within the promote radius; a predicted approach to an awake region; a sequenced player command.

What each hand-off conserves (mass is always exact, in integer micrograms):

| Seam | Momentum, angular momentum | Energy |
|---|---|---|
| Re-centre | Ledger exact; state rounding booked | Frame-transfer posting, exact |
| Surface to free-fall and back | 01's rotation rule; rounding booked | w.L + 0.5 w.J w against centrifugal potential |
| Awake to dormant and back | Centre-of-mass state copied bit for bit | None |
| Leaving mode K | State continuous | Change in kinetic plus summed potential over the arc, booked as model error per object |
| Arc meets the reference surface | To the body's reaction account and planet reservoir | Kinetic energy relative to the ground booked as heat; the object rests at the site, declared |
| Kick | Account debited by what the body gained | Body's kinetic change against field work |

## 8. Bodies and data

Release 1 has ten bodies, the last five as system barycentres. Phase 2 adds 19 moons, Pluto, Charon, Eris, Ceres and Vesta, 34 as in Principia [M, 06]. Values are catalogue figures recalled from memory [E]; the generator replaces them and adds each J2, pole and phase0.

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

Initial states are generated on the build server from the DE440 kernel in the PyPI package naif-de440 [M, raw-v2: PyPI reachable, JPL hosts not] at J2000.0 (Julian date 2451545.0 TDB) = tick 0, as parent-relative f64, stored with the kernel checksum (VF15). Licence: NASA material is "not protected by copyright unless noted" [M, 06]; JPL's own terms are unopened, so only derived numbers ship.

Authored systems: the builder gives a star's mass, radius and temperature T, and per body its mass, bulk density, orbital elements at tick 0, spin, albedo A and optionally J2 (default 0, not derived from spin). The tool derives, labels and stores:

| Property | Formula | Check [D] |
|---|---|---|
| Star luminosity L | 4 pi R^2 sigma T^4 | Sun at 5,772 K: 3.828e26 W |
| Radius | (3M / 4 pi density)^(1/3) | Earth: 6,371 km at 5,514 kg/m^3 |
| Surface gravity | GM/R^2 - spin^2 R | 9.79 m/s^2 on that sphere, before J2 |
| Escape speed | sqrt(2GM/R) | 11.19 km/s |
| Equilibrium temperature | (L(1-A) / 16 pi sigma d^2)^(1/4) | 254.6 K at A = 0.3; real mean 288 K |

An authored system must pass a 10,000-year build-server integration [E] with no guard fault and no semi-major axis moving over 1% [E], about 1.8 hours for ten bodies [D: 5.3e9 steps x 1.2 us]. Otherwise it runs on declared two-body rails, since invented systems can be unstable [M, 06: Principia altered the stock KSP moons].

## 9. Environment fields (interface only)

environment(body, position, tick) returns density, pressure, temperature and medium velocity; vacuum is a value, returned everywhere in release 1 (P14). starlight(position, tick) returns direction and flux L/(4 pi d^2), 1,361 W/m^2 at 1 AU [M, 08], with an eclipse factor.

## 10. Validation tests

Tolerances are [E] until the first run; every gate runs on the shipped binary and step (P17). B = build server, P = phone.

| Test | Reference | Tolerance | Runs |
|---|---|---|---|
| Bit-exactness | Stored bit patterns, 10,000 inputs per own function; hash of 1e6 heavy steps against the build server | 0 bits | P (0a), B |
| Warp invariance | Hash at one tick under three schedules, one through a checkpoint restore; elements of a mode-K orbit about a lone point mass across demote, warp, promote | 0 bits; 1e-12 | P (0s), B |
| Two-body closure | Kepler closed form: integrator on a lunar orbit, 1 year; mode-K solver at eccentricity 0.6, 10,000 periods | 0.1 m; 1e-9 relative; energy 1e-12 | B, P |
| Heavy conservation | Total momentum and angular momentum of the ten bodies, 1 year; energy oscillation | 1e-12 relative; 1e-10 | B |
| Oracle, 1 year | IAS15-class run of the same model (1e-16 [M, 06]) | Planets 5 m, Moon 1 m; with 34 bodies 100 m, 5 km, Phobos 50 km | B |
| DE440, 10 years | Mercury's perihelion lags the kernel by 4.30 arcseconds for lack of relativity [D: 42.98 per century, M, 06], 960-1,450 km [D: x 4.60e10 to 6.98e10 m] | Within 15%; others reported | B |
| Weight and fall | m x 9.7803 at Earth's equatorial radius, m x 1.6242 on the Moon [D: GM/R^2, J2, spin]. Height fallen in 1,000 ticks: 21.22 m and 3.52 m [D: 0.5 g t^2]; a first-order stepper overshoots by 1/1,000 [D]. Eastward drift of the Earth drop: 2.15 mm [D: spin g t^3 / 3] | 0.1%; 0.2%; 2% | P (0s) |
| Frame invariance | One scripted region on a lone body at the origin, at 1 AU moving 29.78 km/s, at 30 AU; re-base identity KE' = KE - P.dV + 0.5 M dV^2; one free body carried by two anchors 100 m apart | Local hash 0 bits; 1 ledger unit per body; 1e-9 m per orbit | B, P |
| Region terms | Foucault 10.64 degrees per hour at 45 degrees [D, 08]; a 10 m radial gap at 400 km, at rest in the region's non-rotating axes, becomes 10.128 m in 100 s [D: 10 x sqrt((2 - cos nt)^2 + (2 sin nt - 3nt)^2); review run] | 2%; 1% of the change | 0b |
| Dormant modes | J2 node drift -3.68 degrees per day at 800 km, 56 degrees [M, 06]; mode K against mode S, 400 km, 51.6 degrees, 1 day, demoted at four points of the orbit | 1%; 20 km | B |
| Small-body recoil | 1 t at 1 m/s onto 1.309e6 kg settles at 0.7634 mm/s [D, 08] | 0.1%; momentum residual 0 at every node | Phase 2 |

## 11. Honest limits

- Newtonian only: no relativity (Mercury 42.98 arcseconds per century [M, 06]) or light-time (499 s per AU [D, 06]); valid below 0.01c.
- Point masses, plus J2 for a region's primary and for objects; no higher harmonics, raised tides, precession or body collisions. Spin rate and pole are constant.
- Objects exert no gravity: 6.7e-8 m/s^2 at 1 m from a tonne [D: Gm/L^2], above the drop threshold, omitted and declared.
- Dormant objects do not interact; mode K has no third-body gravity; dormant attitude ignores gradient torque; internals pause; an arc that reaches the surface ends at rest, not in a simulated crash.
- Other star systems are catalogue entries; warp cost grows linearly with warp; round-off alone moves a planet about 300 m in a century.

## Interfaces

**Assumed from 01-foundations.** Stable 64-bit ids; the state hash; the Reality Report; the closed command set; a world record with journal and checkpoints holding this tier's body table, integrator record, heavy checkpoints, kick journal, accounts, dormant orbits and region frames; per-frame ledgers and the conversion rules of its section 3; Newtonian gravitation as a named law (P03, F11). One mismatch to settle: 01 lists a free-fall anchor's origin as f64, and this spec needs a double-double position.

**Assumed from 03-first-builds.** Phase 0a times the pair kick, one step, sine/cosine and the Kepler solve on the phone and returns the 1e6-step hash (F04, F14). Phase 0s uses this tier's reference sphere and a tangent plane at a site as ground.

**Needed from later specs.** Mechanism tier: f64 state relative to the anchor; gravity, gradient torque and Coriolis rotation as per-body inputs; its free-body update rule, which the anchor copies; a re-base operation; no absolute speed clamp; rest judged in the frame (P08). Matter tier: one vector, the gradient and the spin per substep, f32 relative to its own window. Regions: the focus object, promote and demote radii. Multiplayer: sequencing of warp, ceilings, tracking and promotion.

**Provided.** Every function named above, plus frame transforms, warp admission, prediction, derived body properties and the heavy checkpoint and hash. API nouns: Site, Orbit, Clock.requestWarp, Predict, Environment.

## Changes to the plan

- "The Wisdom-Holman family" becomes an interface plus PEFRL-60, closed on the build server before phone work; ORRERY's real-system mode was not fixed rails (VP01, VF05).
- "About 34 heavy bodies (up to 300-450)" becomes 10, then 34, with an estimated ceiling that falls as warp rises.
- "A pure function of the tick" becomes a function of record, version, grid and journal, checkpointed in the world record, snapshots, join package and fingerprint (VP02, VF10).
- "Vessels do not perturb planets" becomes accounts settled by journalled kicks (VP18); dormant objects get modes K and S (VP17).
- "Each region has its own now" becomes one world clock; warp above 4x needs every region demoted (VP03).
- Surface regions rotate with the body, on an integer spin phase (VP05); "250 m across" is read as a radius.
- "Their orbits give exact test answers" becomes: two-body closed forms are the exact checks; DE440 stays on the build server (VF15).

## Open items

- Whether Safari's wasm gives Node's hashes; the A16 timings behind every cost and warp ceiling.
- The oracle run: n-body error of PEFRL-60 for 10 and 34 bodies, whether compensated sums are needed, and the bake-off with the multistep and nested methods.
- Whether WebAssembly requires a correctly rounded square root (recalled, not checked).
- The review-run scripts were not saved; they must become build-server tests before their numbers are relied on.
- Mode K's mean-element correction and the kick's re-base of awake surface regions are untested designs. If the first fails its test, low orbiters stay in mode S.
- Phase 2 attitude: the closed form also needs an elliptic integral of the third kind; until it exists a tumbling dormant object is paused and reported.
- Every [E] threshold, set from the first runs.
- JPL's licence terms, the IAU pole table and the recalled catalogue values. Moon states need a source: the PyPI kernel is recalled to hold only the Sun, the Moon and the planets (barycentres from Mars outward).
