# Spec 01 — Laws, materials and the world record

This is the permanent layer: the rules, number formats, records and accounts that every solver, region and network peer stands on. It decides what a module must prove before it is registered; which numbers are integers, 64-bit floats (f64) or 32-bit floats (f32), with the WebAssembly binary as the one canonical arithmetic; a frame record with exact rules for re-expressing momentum, angular momentum and energy when anything changes frame; a ledger per frame in which numerical loss is measured per operator, so the leftover must be near zero; and a world record with one owner per record, a hash-chained journal and a snapshot that continues bit-identically. No code exists.

Tags: MEASURED (source), DERIVED (derivation shown), ESTIMATE (replaced by the named measurement), CHOICE (design parameter).

## 1. Charter as registration rules

A *module* is any registered unit of physics or bookkeeping: a law kernel, closure, integrator, generator or port. The registry (id, version, hash) lives in the world record, and strict mode refuses to step with an unregistered module. The build server's automated tests check every row.

| # | Rule | What the module must show |
|---|---|---|
| 1 | Only named laws are hard-coded | Which it implements: balance of mass, momentum, angular momentum and energy; the second law (every dissipation posting to heat is at least zero); Newtonian gravitation; radiative exchange (inverse-square flux, Stefan-Boltzmann). Uniform g is a derived local approximation whose error is reported per region. |
| 2 | Behaviour only from geometry and measured data | Every parameter resolves to a field of a material, pair or body-catalogue record with source and uncertainty. |
| 3 | Every shortcut declared | A fidelity-record entry per constant, clamp and threshold, with a sensitivity test; whatever it removes is posted to a named account. |
| 4 | Every claim has a test | A reference and tolerance, run on the canonical binary at the shipped precision, tick and body count. |
| 5 | Units by types | Typed public signatures and a must-not-compile test. |
| 6 | No global coordinates | Inputs and outputs are (frame, local value) and integer ticks; identical state hash with the anchor at the origin, at 1 AU moving 29.78 km/s, and at 30 AU. |
| 7 | Double-entry hand-offs | A row in the seam table (section 6) for each seam it touches; paired postings under one transaction id; one owner throughout. |
| 8 | Nothing silently frozen | Per process, an exact advance with a test, or the label "pauses" (section 8). |
| 9 | Purity | Its input kinds, all from the closed set (section 9); a lint against clocks, host maths and randomness; snapshot-restore-continue hash equality. |

## 2. Numbers

| Quantity | Format | Unit and limit |
|---|---|---|
| Time | i64 | Tick of 1/480 s; 6.1e8 years (DERIVED: 2^63 / 480 / 3.156e7) |
| Identifiers | u64 | 16-bit creator slot + 48-bit counter (CHOICE); 8,900 years at 1,000 ids per second (DERIVED: 2^48 / 1,000 / 3.156e7) |
| Mass: bodies, particle quanta, aggregates, heavy-body mass delta | i64 | Microgram; 9.2e9 kg per ledger (DERIVED: 2^63 x 1e-9 kg; the 9.2e12 in 08's CASCADE is a slip) |
| Region ledger totals | i128 | Mass moment 2^-16 ug m; momentum 2^-16 ug m/s; angular momentum 2^-32 ug m^2/s; energy 2^-33 ug m^2/s^2 = 1.16e-19 J, limit 2.0e19 J (DERIVED: 2^127 x 2^-33 x 1e-9) (CHOICE) |
| Re-base shift and boost | integer multiples | 2^-16 m and 2^-16 m/s (08 ORRERY) |
| Prescribed spin phase | u64, integer rate per tick | 2^-64 turn = 2.2e-12 m at Earth's radius (DERIVED: 2 pi x 6.371e6 / 2^64) |
| Star-system origin | 3 x i64 | Kilometre; about 975,000 light-years (DERIVED in 08) |
| Heavy bodies, anchors, mechanism state | f64 | Metres and m/s relative to parent or anchor |
| System and body ledgers | double-double (two f64, about 106 bits) | Earth's 2.6e33 J still has 32 J spacing (DERIVED: 2^(111-106)), so it never shares an account with a region |
| Matter tier, drawing | f32 | Relative to a window or camera origin; never hashed |

Bit-exactness rules for the CPU side (system tier, mechanism tier, world record):

1. **Canonical arithmetic is the shipped .wasm binary.** Server and native app run that same binary for these tiers unless the build server shows equal hashes. Binary hash and arithmetic version sit in the world record and the session handshake; a mismatch is refused.
2. Only + - x / and square root on f64, comparisons and explicitly rounded conversions. No fused multiply-add (a x b + c rounded once), no relaxed vector instructions, no threads in the ordered path; scalar until a hash test admits more.
3. Own mathematical functions (sine, cosine, arctangent, exponential, logarithm, power) built from rule 2 with fixed series lengths and iteration counts. No host or platform maths.
4. Fixed ordering: every loop and sum runs in ascending id. Sums feeding a ledger are formed in double-double and rounded once to the integer unit.
5. A NaN (not-a-number) is never stored or hashed; an operation producing one faults its island, which is paused and reported.
6. Randomness is a counter-based generator keyed by (world seed, record id, tick).

Units: public quantities carry their dimension in the type at no run-time cost (MEASURED: Rust `uom` 0.38.0, 01-research.md). A position carries its frame id; combining frames without an explicit conversion is an error. Kernels use bare f64 inside.

## 3. Frames

A *frame* is a coordinate system with one parent. An *anchor* is the origin of a region's frame. The frame record holds: id; kind; parent; origin and velocity in the parent; orientation; angular velocity; children's number format; radius cap; `now` (the tick its state holds at); ledger id.

| Kind | Parent | Origin, velocity | Rotates | Children | Cap |
|---|---|---|---|---|---|
| Star system | Galaxy | 3 x i64 km; f64 | No | f64 | 2^43 m = 58.8 AU, where spacing passes 1 mm (DERIVED in 08) |
| Body inertial | System or body | f64 | No | f64 | — |
| Body-fixed | Body inertial, same origin | — | Prescribed spin: axis f64, phase u64, integer rate | f64 | — |
| Region, free-fall | Body inertial or system | f64, moved by the system tier | No | f64 | 8 km (CHOICE, 08) |
| Region, surface | Body-fixed | f64, fixed | Rides the body | f64 | 8 km |
| Matter window | Region or carrier body | f64 pose snapped to whole cells | With carrier | f32 | 1.28 m (CHOICE, 08) |

Only body-fixed frames rotate. Spun habitats and vehicle interiors are real motion inside a non-rotating region.

**State conversion.** For a child with origin R, velocity V, rotation Q (child axes to parent axes) and angular velocity W: r' = R + Q r; v' = V + Q v + W x (Q r); w' = W + Q w. Any two frames convert through their nearest common ancestor.

**Ledger re-expression.** A set of bodies has totals M, mass moment N = sum of m r, momentum P, angular momentum L about the origin (spin included), kinetic energy K, and inertia J about the origin.

- Shift and boost (rotate vectors by Q first): N' = N + M R; P' = P + M V; L' = L + R x P + N x V + M (R x V); K' = K + P.V + (1/2) M V^2. The added terms are the *frame-transfer* posting. For 1,000 kg at 7.67 km/s the cross term is 7.67e6 J per m/s of relative speed (DERIVED: 1,000 x 7,670).
- A re-base is R = -d, V = -u with d and u multiples of 2^-16. Every term is then a whole number of ledger units (DERIVED: ug x 2^-16 x 2^-16 = 2^-32; the half gives 2^-33), so the ledger side is exact and only the f64 state rounds, by at most one spacing per body (9.1e-13 m at 8 km, DERIVED: 2^(12-52)).
- Rotating to non-rotating at one origin, spin w: P' = P + w x N; L' = L + J w; K' = K + w.L + (1/2) w.J w.

In a rotating frame the conserved energy is K + U_gravity - (1/2) w.J w, which equals E_inertial - w.L_inertial (DERIVED by substitution). A surface ledger therefore carries a centrifugal-potential account, posts centrifugal and Coriolis impulses to "inertial impulse" (momentum is not conserved there), and expects zero Coriolis work. At Earth's equator the centrifugal term is 0.0339 m/s^2 (DERIVED: (7.292e-5)^2 x 6.378e6).

## 4. Materials

Each numeric field stores value, uncertainty class, source id, reference temperature and validity range. Tiers: Me mechanism, Ma matter, L ledger, E environment.

| Field | Unit | Tier | Meaning |
|---|---|---|---|
| Density | kg/m^3 | all | Mass from geometry |
| Young's modulus, Poisson's ratio | Pa, – | Me, Ma | Stiffness; analytic contact-patch and peak-force estimates |
| Yield, ultimate strength | Pa | Me | Bend and break (later phase) |
| Fracture toughness | Pa m^0.5 | Me, Ma | Fracture energy per crack area |
| Specific heat, conductivity | J/kg/K, W/m/K | L, Ma, E | Heat account, lumped cooling |
| Melting point, latent heat | K, J/kg | Ma, L | Phase change |
| Viscosity, surface tension, bulk modulus | Pa s, N/m, Pa | Ma | Liquids; validity flags |
| Friction angle, grain density | degree, kg/m^3 | Ma | Granular matter |
| Resistivity | ohm m | L, Me | Joule heat |
| Emissivity (surface) | – | E | Radiative exchange |
| Validity | K, Pa, 1/s | all | Outside it the Reality Report flags the use |

Initial library. Every value is an ESTIMATE recalled from handbook-typical figures. The build fails strict mode while any source reads "memory"; candidate sources are listed in 01-research.md (CoolProp, `chemicals`, NIST). Classes: A within 2%, B 10%, C 30%, D wider.

| Material | Density | E, GPa | Poisson | Strength, MPa | Heat, J/kg/K | k, W/m/K | Class | Other |
|---|---|---|---|---|---|---|---|---|
| Mild steel | 7,850 | 200 | 0.29 | 250 yield | 490 | 50 | B | 1.6e-7 ohm m |
| Aluminium 6061-T6 | 2,700 | 69 | 0.33 | 276 yield | 896 | 167 | B | |
| Titanium Ti-6Al-4V | 4,430 | 114 | 0.34 | 880 yield | 526 | 6.7 | B | |
| Copper | 8,960 | 117 | 0.34 | 70 yield | 385 | 400 | B | 1.68e-8 ohm m |
| Oak, along grain | 700 | 11 | 0.35 | 50 crushing | 2,000 | 0.17 | C | Treated as isotropic, declared |
| Natural rubber | 1,100 | 0.005 | 0.49 | 20 tensile | 1,900 | 0.16 | D | |
| ABS plastic | 1,050 | 2.3 | 0.35 | 40 yield | 1,400 | 0.17 | C | |
| Soda-lime glass | 2,500 | 70 | 0.22 | 40 tensile | 840 | 1.0 | C | |
| Concrete | 2,400 | 30 | 0.20 | 30 compressive | 880 | 1.4 | C | |
| Granite | 2,700 | 50 | 0.25 | 150 compressive | 790 | 2.9 | C | |
| Water ice, 263 K | 917 | 9 | 0.33 | 5 compressive | 2,050 | 2.2 | C | Melts 273.15 K; 334 kJ/kg |
| Water, 293 K | 998 | 2.2 bulk | – | – | 4,182 | 0.60 | A | 1.0e-3 Pa s; 0.073 N/m |
| Dry quartz sand | 1,600 bulk | – | – | 33 degree friction | 800 | 0.25 | C | Grains 2,650 |
| Lunar regolith | 1,500 bulk | – | – | 40 degree friction | 760 | 0.01 in vacuum | D | |
| Air, 288.15 K | 1.225 | – | – | – | 1,005 | 0.025 | A | 1.8e-5 Pa s |

**Pair table: empirical closures, not laws.** Friction is Coulomb with static and kinetic coefficients; friction work goes to heat. Restitution is e(v) = min(1, e_ref (v / 1 m/s)^(-1/4)) (trend from 01-research.md, unverified there); the loss (1 - e^2) x (1/2) m_reduced v_normal^2 goes to heat by definition. A pair record also holds rolling resistance, validity (dry, 250-350 K, in air) and source. A missing pair uses the geometric mean of the self-pairs and is flagged "mixing-rule default". All values ESTIMATE, class C-D; friction in vacuum is outside validity and is flagged at the airless site.

| Pair | Static | Kinetic | e_ref |
|---|---|---|---|
| Steel-steel | 0.74 | 0.57 | 0.6 |
| Steel-aluminium | 0.61 | 0.47 | 0.5 |
| Steel-oak | 0.5 | 0.4 | 0.4 |
| Oak-oak | 0.6 | 0.5 | 0.5 |
| Rubber-steel | 0.9 | 0.7 | 0.8 |
| Rubber-concrete | 1.0 | 0.8 | 0.8 |
| ABS-steel | 0.4 | 0.3 | 0.6 |
| Glass-glass | 0.9 | 0.4 | 0.9 |

The ambient medium is a field record (density, pressure, temperature, velocity by position). Vacuum is that record with zero density, present from the first build.

## 5. The ledger

A *ledger* is the set of accounts kept in one frame: one per region (integers), one per body and one per system (double-double). Each closes at its own magnitude and rolls up to its parent as one line through section 3. An *operator* is one stage of a step (field kick, drift, contact solve, restitution pass, circuit update, clamp, weld).

| Account | Kind | Content |
|---|---|---|
| Mass per material; mass moment; momentum; angular momentum | State | Measured from state |
| Kinetic | State | Translation and rotation relative to this frame |
| Gravitational | State | Potential relative to the anchor, from the supplied field expansion |
| Centrifugal potential | State | Rotating frames only |
| Stored elastic; electrical; heat | State | Springs and strain; batteries and capacitors; thermal, latent and unresolved-to-internal |
| In transit; escrow | State | Wrenches in the delay line; objects debited but not yet credited |
| Dissipation | Flow | Friction, restitution, viscous, plastic and Joule channels, each from its own formula |
| External work; creation | Flow | Player-driven actuators and escape hatches; world creation, the single booked creation |
| Boundary flux | Flow | Per port: mass, momentum, angular momentum, energy; radiative source and sink; ambient medium |
| Field change; inertial impulse; reservoirs | Flow | Supplied field varying in time; fictitious impulses; ground, planet and atmosphere |
| Frame transfer | Flow | Section 3 terms |
| Numerical loss | Flow | Per operator, below |
| Rounding | Flow | The tick's leftover, bounded below |
| Deferred reaction; integrator oscillation; mass delta | Body, system | Reactions owed to heavy bodies; the orbit integrator's bounded energy error; mined or added mass |

**Numerical loss is not the leftover.** Each operator measures the accounts it touches immediately before and after itself, posts its physical channels from formulas, and posts the remainder of its own bracket as numerical loss under its own name. Where a closed form exists the operator posts that and both must agree; for an implicit soft constraint the loss per step is (1/2) m dv^2 + (1/2) k dx^2 (DERIVED from backward Euler on a linear spring). The tick identity, change in state = sum of flows + rounding, is then a real check: a missing operator or unbooked mutation appears as rounding above tolerance.

**Closure tolerances** (ESTIMATE, replaced by the first 0b run): mass exactly 0 every tick. Momentum, angular momentum and energy: |rounding| at most 2^-40 of the summed magnitudes of that tick's totals and postings, plus one unit per posting. A breach raises a ledger-anomaly event and pauses the region. Numerical loss is gated as a fraction of physical dissipation on named scenes (10%, ESTIMATE; set by the mechanism spec).

## 6. Ports and seams

A *port* is a declared interface through which matter, momentum or energy crosses a region boundary or a tier boundary, always at a tick boundary. Each port keeps a per-tick flux account: mass per material, momentum, angular momentum, energy by store, transaction id and counterparty ledger. A posting is valid only if the counterparty holds the equal and opposite posting at the same tick.

| Seam | Mass | Momentum, angular momentum | Energy |
|---|---|---|---|
| Quantised re-base | Exact | Exact; state rounding booked | Exact; rounding booked |
| Object between regions, merge, split, re-parent | Exact | Exact up to one booked rounding via the common ancestor | Same |
| Surface frame to body inertial | Exact | Bounded, booked | Bounded; centrifugal account closed |
| Mechanism demote and promote | Exact | Exact | Exact by store |
| Particles to reservoir record and back | Exact (integer quanta) | Owner-attested, bounded | Attested; unresolved to heat, reseed mismatch booked |
| Matter-to-mechanism wrench | — | Exact: the quantised value acts on both sides; in transit meanwhile | Bounded by the fluid's ledgered energy drop |
| Dig and deposit | Exact (integer fill) | Zero relative momentum | Enthalpy carried; toughness x area |
| Contact with a planet | — | Exact; counter-entry in deferred reaction | No work in the surface frame |
| Gravity from the frame above | — | Posted per tick against deferred reaction | Potential plus field change; bounded |
| Region to system roll-up | Exact | Bounded (double-double) | Bounded |
| Owner change | Identical | Identical | Identical; zero postings |

**Merge and split.** Regions merge before contact is possible: predicted approach inside a horizon of 10 s (ESTIMATE; DERIVED: 0.6 MB at 1 Mbit/s = 4.8 s, plus 2,304 ticks caught up at 2x = 4.8 s). Both stand at the same tick, both ledgers close into one, the older lease sequences, and the summed awake set passes admission or the merge slows the region by a sequenced command. Split distance is twice merge distance (CHOICE). An interaction island is never divided. Contact above the declared closing-speed envelope conserves mass and momentum and books the rest as heat.

## 7. The world record

A *record* is the unit of persistent state: a header plus a typed body. Header: id, type, schema version, frame, owner, lease epoch, state (awake, on formula, paused), own elapsed ticks, high-water tick (last mutation) and hash. Types: world header, module registry, fidelity, frame, body catalogue, material, pair, ambient field, aggregate, mechanism snapshot, reservoir (integer mass per material, enthalpy, container), terrain edit leaf, ledger, lease, heavy-body checkpoint.

**Identifiers** are minted from a creator's block by a sequenced command, never reused, and survive every hand-off. Generated things (untouched terrain, pebbles) get an id when first touched.

**One owner.** Every mutable record has exactly one owner at every tick. A *lease* is (owner, epoch, expiry tick) granted by one *arbiter*: the host at step 1, the server at step 2. Every message and journal entry carries the epoch, and a stale epoch is refused. A lapse is an external event that the arbiter sequences; the step never reads a clock. A new epoch starts at the highest tick any survivor holds. At step 1 a guest that loses the host pauses its regions and reports it, or continues in a labelled fork that is never merged. A region is never rewound to a checkpoint: it continues, pauses with a report, or demotes. Expiry is 2-5 s (ESTIMATE; set by the two-phone lock test).

**Journal.** Append-only entries (sequence, tick, epoch, kind, payload, hash of previous entry). Every boundary transaction forces a checkpoint or carries the input tail; a solo owner streams inputs to the record keeper (3.5 MB per hour, DERIVED in 08). Each world checkpoint (every 10 s, ESTIMATE) truncates the journal before it, keeping a capped tail. Storage: a namespaced origin-private directory written from a Worker; persist() requested and its answer shown; flush on page hide; export and import as a file from the first build that saves; at quota, refuse and report.

**Snapshot.** Everything whose absence could change one future bit is state: body state, joint state, warm-start impulses, contact cache, tree order, timers, id counters, delay-line contents, ledger, lease, clamp settings and tick. Serialisation is canonical: ascending id, schema order, little-endian, raw f64 bits. Gate: snapshot at tick N, restore elsewhere, run M ticks, hash equals the uninterrupted run.

**Fingerprint.** A 64-bit hash per record; the region fingerprint hashes (id, record hash) pairs with tick, epoch and ledger heads; the world fingerprint adds the heavy-body checkpoint hash and binary hash. Journal chain and binary identity use SHA-256 (CHOICE).

**Join package:** binary hash, world-record head, journal tail, heavy-body checkpoint, leases, a region snapshot at a sequenced tick, the input tail.

## 8. Aggregates and the three states

An *aggregate* is what is stored for an unobserved object. It is a *gyrostat*: a rigid carrier plus spinning parts.

| Field | Format |
|---|---|
| Mass per material | i64 ug list |
| Centre-of-mass position, velocity; orientation | f64 in its frame |
| Total angular momentum about the centre of mass | f64, frame axes; authoritative |
| Inertia tensor; rotor momentum h | f64, body axes |
| Named energy stores: rotor, elastic, electrical, heat per thermal node, unresolved | Ledger units |
| Ledger totals at demotion | Integers |
| Formula parameters (thermal nodes, self-discharge), paused-process list, per-subsystem elapsed ticks | — |
| Snapshot id and hash; delta list; reconstruction seed | u64 |

About 256 B plus 128 B per snapshotted body (ESTIMATE, 08).

**Contract.** *Demote* requires non-rotor relative kinetic energy below 5e-7 J/kg (DERIVED in 08: 1 mm/s); the residual goes to unresolved-to-internal, never negative. The snapshot is authoritative for micro-state, the aggregate for totals and pose; a dormant change is applied to the aggregate and appended to the delta list in one transaction. *Promote* restores snapshot plus deltas, re-posed, with body angular velocity set to I^-1 (R^T L - h), so angular momentum is conserved whatever the attitude (a rigid-only record would invent 1.41 h at 90 degrees, DERIVED: 2 sin 45). Promote then demote with no time elapsed returns identical bits; otherwise ledger totals are identical integers and state rounding is booked. Lost going up: matter micro-state only (booked to heat). Reconstructed going down: particles from a lattice seeded by hash(record id, tick, world seed); terrain from generator plus edits, on the bit-exact CPU path.

**Three states.** *Awake*: inside a region and admitted by its budget. *On formula*: every process in a coupled subsystem has a registered exact advance. *Paused*: any process lacks one, so the whole subsystem pauses together, with interval and reason in the Reality Report and an event to the game. Choose in that order. Warp is a world-level input, legal above about 4x (ESTIMATE, 08) only when every region is at rest and demoted; otherwise it is refused, naming the blocker.

## 9. Purity

A step is a function of (state, tick, inputs stamped with that tick). The sequencer stamps every input with a future tick; background work must finish by then or the peer stalls. The closed input set: player commands and edits; warp and slowdown; thermal-governor actions that touch simulation; promote, demote; re-base, re-parent; merge, split; lease epoch, join, leave; escrow credits; quantised matter-to-mechanism wrenches on a fixed delay line, applied identically by every peer including the owner; kicks and mass changes to heavy bodies; version changes. Never inputs: wall clock, frame rate, device load, camera, container order. Bit-exact replay (checkpoint plus journal) covers the record, system tier and mechanism tier; matter replays from its wrench stream.

## 10. Fidelity record and clamps

One per module and world; it generates the Reality Report. Fields: law; rung (exact, convergent, empirical, sub-grid, out of scope); every constant with source; validity envelope; tests; shipped configuration; omissions with size (42.98 arcseconds per century, 499 s per AU, below 0.01c; from 08); mixing-rule defaults; paused objects; trust scope.

1. One stiffness clamp per world: a maximum resolvable contact frequency, a numerical regularisation, fixed for the world's life and independent of substeps, iterations, frame rate, governor and peer. At 120 Hz it is 5.7e5 N/m per kg for any material (DERIVED in 07).
2. No absolute speed clamp. The closing-speed envelope is minimum thickness x 480 per second (1 cm gives 4.8 m/s, DERIVED).
3. Sleep is a carrier-relative weld transaction.
4. Every clamp activation posts what it removed.
5. An adopted solver's constants (07 lists six, MEASURED there) each need an entry or removal.

## 11. Budget (replaces "100-300 boxes" and "4 W")

| Line, per 60 Hz frame | Range | Replaced by (probe 0a) |
|---|---|---|
| One core, sustained | About 5 ms (ESTIMATE from an unverified excerpt) | Single-core duty and battery drain |
| Page, input, drawing | 1.0-1.5 ms (ESTIMATE) | Empty-scene breakdown |
| System tier | 0.5 ms cap (ESTIMATE, 08) | Heavy-body step timing |
| Ledger, journal, packing | 0.2-0.4 ms (ESTIMATE) | Micro-benchmark |
| Fingerprint, each second | 0.12-0.4 ms (DERIVED: 120 kB at 0.3-1 GB/s, rate ESTIMATE) | Snapshot-plus-hash, 300 bodies |
| Mechanism tier | 2.5 ms: 70-300 boxes alone, 35-150 shared (DERIVED by the red team) | Scalar f64 throughput |
| Network | 0.2-0.5 ms (ESTIMATE); radio power unknown | Data-channel drain |

A shared region's budget is the smallest sustained budget among its peers, at most half the single-phone figure, set by sequenced input.

## Red-team resolutions

| Id | Resolution |
|---|---|
| VP04, P03, F11 | Sections 1, 3, 5, 6 |
| VP07, VF14, P22 | Section 2 rules; section 9 scope |
| VP19, P19 | Section 8 |
| VF09, F03, F20 | Section 11 |
| VP14 | Gyrostat record and contract |
| VP15, P11 | Merge and split; envelope |
| VP03 | One world clock for steps 1-2. `now` and high-water tick stay in the schema; enabling them needs check-out only when region now is at least the high-water tick, read-only ghosts otherwise, and property tests |
| VP08, VP12, P15 | Section 9 |
| VP10, VF03, VF12 | Section 7; gate with three simulated peers and 1,000 owner kills |
| VP11, VF04, VP13 | Join package, snapshot gate, section 11; peer states in step, catching up at 2x, resync with the region paused; repeated mismatch makes a viewer |
| VP20 | Step 1 is friends only. Journal entries reserve an author-signature field; wrench audit by the energy bound in section 6; hidden information is unprotectable, stated in the fidelity record |
| VF08, VF16 | Accepted; they belong to the multiplayer spec and cost table |
| P02, P09, P14, P25, P08, F10, F15, VF11, VP16 | Sections 6, 5, 4, 4, 10, 3, 7, 7, 7 |

## Interfaces

- **From 02 (system tier):** heavy-body state as a function of (initial record hash, arithmetic version, fixed step grid, journal of kicks and mass changes, tick), with checkpoint bytes and hash; anchor motion; per region and tick a field expansion (gravity, gradient, spin vector) with error estimate; dormant propagation and attitude advance; re-base as commands. **To 02:** frame record, conversions, formats, arithmetic rules, the deferred-reaction, integrator-oscillation and mass-delta accounts, aggregate fields, journal and checkpoint containers.
- **From 03 (first builds):** pinned toolchain, printed binary hash, a result path of a few hundred bytes, the probe items of section 11. **To 03:** gates: anchor invariance; frame-transfer identity within tolerance; closure; snapshot-restore-continue; round trip of a rover with spinning wheels (identical hash, angular momentum within 1e-12, ESTIMATE); lease fault injection.
- **Needed from the mechanism spec:** f64 anchor-relative state; operator brackets and channel formulas; complete snapshot; weld sleep; no speed clamp; adopt-or-write settled before 0b.
- **From the matter spec:** integer mass quanta assigned on the CPU; f32 relative to a window origin only; quantised wrenches; seeded reseeding.
- **From the multiplayer spec:** sequencer, arbiter and registrar, transport, viewer mode. Islands coupled to matter may be owner-authoritative and state-synced, marked on the record.
- **From the API spec:** typed quantities; pause, hand-off and anomaly events; engine hand-offs as an audited class apart from game escape hatches.

## Changes to the plan

1. Charter point 1 names gravitation and radiative exchange as laws.
2. One ledger becomes one per frame, with the seam table saying what is exact.
3. "Each region has its own now" becomes one world clock until the server step.
4. "Heavy bodies are a pure function of the tick" becomes the five-argument function above, checkpointed in the world record.
5. "Tiers run unchanged" is withdrawn; surface regions sit in the rotating body frame.
6. "Sleeps at its last checkpoint" is withdrawn: regions never rewind.
7. The aggregate gains rotor momentum and named stores; liquids gain a reservoir record.
8. Rigid bodies agree through sequenced wrenches, not the coarse summary.
9. "250 m across" is a radius; exactly one owner needs an arbiter, so step 1 is host-authoritative.
10. The integer mass limit is 9.2e9 kg per ledger.

## Open items

- Equal hashes of the canonical binary on Safari and on the build server over 1e6 steps; correctly rounded square root in WebAssembly is from memory.
- Cost of i128 and double-double postings for 300 bodies; hash rate; snapshot size and time.
- The 2^-40 closure tolerance and the 10% numerical-loss gate against first runs.
- Whether an adopted solver's snapshot continues bit-identically.
- persist() answer, write rate and eviction on the phone; checkpoint interval.
- Lease expiry and merge horizon from two-phone measurements.
- Energy drift of the stepped gyrostat attitude.
- Cited sources for every material and pair value; friction in vacuum.
