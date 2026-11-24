# Spec 01 — Laws, materials and the world record

This is the permanent layer: the rules, number formats, records and accounts every solver, region and peer stands on. It decides what a module must prove before registration; which numbers are integers, 64-bit floats (f64) or 32-bit floats (f32), with the WebAssembly binary as the one canonical arithmetic; how momentum, angular momentum and energy are re-expressed when anything changes frame; a ledger per frame whose numerical loss is measured per operator; and a world record with one owner per record, a hash-chained journal and snapshots that continue bit-identically.

Tags: MEASURED, DERIVED, ESTIMATE (replaced by the named measurement), CHOICE (design parameter). Red-team ids follow the heading of the section that answers them.

## 1. Charter as registration rules (P03, F11, P17)

A *module* is any registered unit of physics or bookkeeping: kernel, closure, integrator, generator or port. Strict mode refuses to step with a module missing from the world record's registry; automated tests check each row.

| Rule | What the module must show |
|---|---|
| 1. Only named laws are hard-coded | Its law: balance of mass, momentum, angular momentum, energy; the second law (heat from dissipation is never negative); Newtonian gravitation; radiative exchange (inverse-square flux, Stefan-Boltzmann). Uniform g is a derived approximation with reported error. |
| 2. Behaviour from geometry and measured data | Each parameter resolves to a material, pair or body-catalogue field with source and uncertainty. |
| 3. Shortcuts declared | A fidelity-record entry per constant and clamp, with a sensitivity test; what it removes is posted to a named account. |
| 4. Claims tested | Reference and tolerance, on the canonical binary at shipped precision, tick and body count. |
| 5. Units by types | Typed signatures; a must-not-compile test. |
| 6. No global coordinates | Identical hash with the anchor at the origin, at 1 AU moving 29.78 km/s, and at 30 AU. |
| 7. Double-entry hand-offs | A seam-table row (section 6); paired postings under one transaction id; one owner. |
| 8. Nothing silently frozen | Per process: an exact advance with a test, or "pauses" (section 8). |
| 9. Purity | Inputs from the closed set (section 9); no clock, host maths or unseeded randomness; snapshot-restore-continue hash equality. |

## 2. Numbers (VP07, VF14)

| Quantity | Format | Unit |
|---|---|---|
| Time | i64 | Tick of 1/480 s; 6.1e8 years (DERIVED: 2^63 / 480 / 3.156e7) |
| Identifier | u64 | 16-bit creator slot, 48-bit counter (CHOICE) |
| Mass: bodies, particle quanta, heavy-body mass delta | i64 | Microgram; 9.2e9 kg per ledger (DERIVED: 2^63 x 1e-9; CASCADE's 9.2e12 in 08 is a slip) |
| Region ledger totals | i128 | Momentum 2^-16 ug m/s; mass moment 2^-16 ug m; angular momentum 2^-32 ug m^2/s; energy 2^-33 ug m^2/s^2 = 1.16e-19 J (CHOICE) |
| Re-base steps | Integer | 2^-16 m and 2^-16 m/s (08) |
| Spin phase | u64 | 2^-64 turn, integer rate per tick |
| Heavy bodies, anchors, mechanism state | f64 | Relative to parent or anchor |
| System and body ledgers | Double-double (two f64, about 106 bits) | Earth's 2.6e33 J still has 32 J spacing (DERIVED: 2^(111-106)) |
| Matter tier, drawing | f32 | Never hashed |

Bit-exactness rules for the CPU side (system tier, mechanism tier, world record):

1. **The shipped .wasm binary is the canonical arithmetic.** Server and native app run it unless the build server shows equal hashes. Its hash and the arithmetic version are in the world record and the handshake; a mismatch is refused.
2. Only + - x / and square root on f64. No fused multiply-add (a x b + c rounded once), relaxed vector instructions or threads in the ordered path.
3. Own trigonometric, exponential and power functions with fixed iteration counts; no host maths.
4. Loops and sums run in ascending id; ledger sums are formed in double-double and rounded once.
5. A NaN (not-a-number) is never stored or hashed; producing one pauses the island with a report.
6. Randomness is a counter-based generator keyed by (world seed, record id, tick).

Public quantities carry their dimension in the type (Rust `uom`, MEASURED in 01-research.md). A position carries its frame id; mixing frames without conversion is an error.

## 3. Frames (VP04, VP05, F10)

A *frame* is a coordinate system with one parent; an *anchor* is a region frame's origin. Record: id, kind, parent, origin and velocity in the parent, orientation, angular velocity, children's number format, radius cap, `now` (tick of its state), ledger id.

| Kind | Parent | Origin | Children |
|---|---|---|---|
| Star system | Galaxy | 3 x i64 km | f64 to 2^43 m (58.8 AU, DERIVED in 08) |
| Body inertial | System or body | f64 | f64 |
| Body-fixed, the only rotating kind | Body inertial | Same; integer spin phase | f64 |
| Free-fall region | Body inertial or system | f64, moved by the system tier | f64 to 8 km (CHOICE) |
| Surface region | Body-fixed | f64, fixed | f64 to 8 km |
| Matter window | Region or carrier | f64, whole cells | f32 to 1.28 m (CHOICE) |

Spun habitats and vehicle interiors are real motion in a non-rotating region.

**State conversion.** For a child with origin R, velocity V, rotation Q (child axes to parent axes) and angular velocity W: r' = R + Q r; v' = V + Q v + W x (Q r); w' = W + Q w. Two frames convert through their nearest common ancestor.

**Ledger re-expression.** A set of bodies has mass M, mass moment N (sum of m r), momentum P, angular momentum L about the origin (spin included), kinetic energy K and inertia J about the origin.

- Shift and boost (vectors rotated by Q first): N' = N + M R; P' = P + M V; L' = L + R x P + N x V + M (R x V); K' = K + P.V + (1/2) M V^2. The added terms are the *frame-transfer* posting; for 1,000 kg at 7.67 km/s the cross term is 7.67e6 J per m/s of relative speed (DERIVED: 1,000 x 7,670).
- A re-base is R = -d, V = -u, both multiples of 2^-16. Every term is then a whole number of ledger units (DERIVED: ug x 2^-16 x 2^-16 = 2^-32; the half gives 2^-33), so the ledger side is exact; only the f64 state rounds, by at most one spacing per body (9.1e-13 m at 8 km, DERIVED: 2^(12-52)).
- Rotating to non-rotating at one origin, spin w: P' = P + w x N; L' = L + J w; K' = K + w.L + (1/2) w.J w.

In a rotating frame the conserved energy is K + U_gravity - (1/2) w.J w, equal to E_inertial - w.L_inertial (DERIVED by substitution). A surface ledger therefore carries a centrifugal-potential account, posts centrifugal and Coriolis impulses to "inertial impulse" (momentum is not conserved there) and expects zero Coriolis work.

## 4. Materials (P25, P14)

Each numeric field stores value, uncertainty class, source, reference temperature and validity range; use outside the range is flagged. Tiers: Me mechanism, Ma matter, L ledger, E environment.

| Field | Unit | Tier and use |
|---|---|---|
| Density | kg/m^3 | All: mass from geometry |
| Young's modulus, Poisson's ratio | Pa, – | Me, Ma: stiffness, analytic contact estimates |
| Yield, ultimate strength; fracture toughness | Pa; Pa m^0.5 | Me, Ma: bend, break |
| Specific heat, conductivity, melting point, latent heat | J/kg/K, W/m/K, K, J/kg | L, Ma, E: heat account, phase change |
| Viscosity, surface tension, bulk modulus | Pa s, N/m, Pa | Ma: liquids |
| Friction angle, grain density | degree, kg/m^3 | Ma: granular matter |
| Resistivity; surface emissivity | ohm m; – | L: Joule heat; E: radiation |

Initial library. Every value is an ESTIMATE recalled from handbook-typical figures; strict mode fails the build while any source reads "memory". Class: A within 2%, B 10%, C 30%, D wider.

| Material | Density | E, GPa | Poisson | Strength, MPa | Heat, J/kg/K | k, W/m/K | Class |
|---|---|---|---|---|---|---|---|
| Mild steel | 7,850 | 200 | 0.29 | 250 yield | 490 | 50 | B |
| Aluminium 6061-T6 | 2,700 | 69 | 0.33 | 276 yield | 896 | 167 | B |
| Copper (1.68e-8 ohm m) | 8,960 | 117 | 0.34 | 70 yield | 385 | 400 | B |
| Oak, along grain | 700 | 11 | 0.35 | 50 crushing | 2,000 | 0.17 | C |
| Natural rubber | 1,100 | 0.005 | 0.49 | 20 tensile | 1,900 | 0.16 | D |
| ABS plastic | 1,050 | 2.3 | 0.35 | 40 yield | 1,400 | 0.17 | C |
| Soda-lime glass | 2,500 | 70 | 0.22 | 40 tensile | 840 | 1.0 | C |
| Concrete | 2,400 | 30 | 0.20 | 30 compressive | 880 | 1.4 | C |
| Water ice, 263 K (latent 334 kJ/kg) | 917 | 9 | 0.33 | 5 compressive | 2,050 | 2.2 | C |
| Water, 293 K (1.0e-3 Pa s; 0.073 N/m) | 998 | 2.2 bulk | – | – | 4,182 | 0.60 | A |
| Dry quartz sand | 1,600 bulk | – | – | 33 degree friction | 800 | 0.25 | C |
| Lunar regolith, in vacuum | 1,500 bulk | – | – | 40 degree friction | 760 | 0.01 | D |
| Air, 288.15 K (1.8e-5 Pa s) | 1.225 | – | – | – | 1,005 | 0.025 | A |

**Pair table: empirical closures, not laws.** Friction is Coulomb; its work goes to heat. Restitution is e(v) = min(1, e_ref (v / 1 m/s)^(-1/4)) (trend from 01-research.md, unverified there); the loss (1 - e^2) x (1/2) m_reduced v_normal^2 goes to heat by definition. A pair record also holds rolling resistance, validity (dry, in air, 250-350 K) and source. A missing pair takes the geometric mean of the self-pairs, flagged "mixing-rule default". Values are ESTIMATES, class C-D; friction in vacuum is outside validity and flagged.

| Pair | Static | Kinetic | e_ref |
|---|---|---|---|
| Steel-steel | 0.74 | 0.57 | 0.6 |
| Oak-oak | 0.6 | 0.5 | 0.5 |
| Steel-oak | 0.5 | 0.4 | 0.4 |
| Steel-rubber | 0.9 | 0.7 | 0.8 |
| Oak-rubber | 0.8 | 0.6 | 0.6 |
| Rubber-concrete | 1.0 | 0.8 | 0.8 |

The ambient medium is a field record (density, pressure, temperature, velocity by position); vacuum is that record with zero density, present from the first build.

## 5. The ledger (VP04, P09, VP18)

A *ledger* is the set of accounts kept in one frame: integers per region, double-double per body and per system. Each closes at its own magnitude and rolls up to its parent as one line through section 3. An *operator* is one stage of a step (field kick, drift, contact solve, circuit update, clamp, weld).

| Account | Kind | Content |
|---|---|---|
| Mass per material; mass moment; momentum; angular momentum | State | Measured from state |
| Kinetic | State | Relative to this frame |
| Gravitational; centrifugal potential | State | Relative to the anchor, from the supplied field; rotating frames only |
| Stored elastic; electrical; heat | State | Springs and strain; batteries; thermal, latent, unresolved-to-internal |
| In transit; escrow | State | Wrenches in the delay line; objects debited, not yet credited |
| Dissipation | Flow | Friction, restitution, viscous, plastic, Joule: each from its own formula |
| External work; creation | Flow | Player-driven actuators, escape hatches; world creation, the one booked creation |
| Boundary flux | Flow | Per port, including radiation and the ambient medium |
| Field change; inertial impulse; reservoirs | Flow | Time-varying supplied field; fictitious impulses; ground, planet, atmosphere |
| Frame transfer; numerical loss; rounding | Flow | Section 3 terms; per operator; the tick's leftover |
| Deferred reaction; integrator oscillation; mass delta | Body, system | Reactions owed to heavy bodies; the orbit integrator's bounded energy error; mass added or removed |

**Numerical loss is not the leftover.** Each operator measures the accounts it touches immediately before and after itself, posts its physical channels from formulas, and posts the rest of its own bracket as numerical loss under its name. Where a closed form exists it posts that too and both must agree: an implicit soft constraint loses (1/2) m dv^2 + (1/2) k dx^2 per step (DERIVED: backward Euler on a linear spring). The tick identity (change in state = flows + rounding) then tests something: a missing operator or unbooked mutation shows as rounding above tolerance.

**Closure tolerances** (ESTIMATE until the first 0b run). Mass: exactly 0 every tick. Momentum, angular momentum, energy: rounding at most 2^-40 of the summed magnitudes of the tick's totals and postings, plus one unit per posting. A breach raises a ledger-anomaly event and pauses the region. Numerical loss is gated at 10% of physical dissipation on named scenes (ESTIMATE; the mechanism spec sets it).

## 6. Ports and seams (P02, VP15, VP16, P11)

A *port* is a declared interface through which matter, momentum or energy crosses a region or tier boundary, always at a tick boundary. Each keeps a per-tick flux account: mass per material, momentum, angular momentum, energy by store, transaction id, counterparty ledger. A posting is valid only when the counterparty holds its equal and opposite at the same tick.

| Seam | Mass | Momentum, angular momentum | Energy |
|---|---|---|---|
| Quantised re-base | Exact | Exact; state rounding booked | Exact; rounding booked |
| Object between regions; merge, split | Exact | Exact up to one booked rounding through the common ancestor | Same |
| Surface frame to body inertial | Exact | Bounded, booked | Bounded |
| Mechanism demote, promote | Exact | Exact | Exact by store |
| Particles to reservoir and back | Exact (integer quanta) | Owner-attested, bounded | Attested; unresolved to heat; reseed mismatch booked |
| Matter-to-mechanism wrench | — | Exact: the quantised value acts on both sides | Bounded by the fluid's ledgered energy drop |
| Dig, deposit | Exact (integer fill) | Zero relative momentum | Enthalpy carried; toughness x area |
| Contact with a planet; gravity from above | — | Exact; counter-entry in deferred reaction | No contact work in the surface frame; field energy bounded |
| Region to system roll-up | Exact | Bounded (double-double) | Bounded |

**Merge and split.** Regions merge before contact is possible, when predicted approach falls inside 10 s (ESTIMATE; DERIVED: 0.6 MB at 1 Mbit/s = 4.8 s, plus 2,304 ticks caught up at 2x = 4.8 s). Both stand at one tick, both ledgers close into one, the older lease sequences, and the summed awake set passes admission or the region slows by sequenced command. Split distance is twice merge distance (CHOICE). An interaction island is never divided. Contact above the declared closing-speed envelope conserves mass and momentum and books the rest as heat.

## 7. The world record (VP10, VP11, VF03, VF11, VF12, F15)

A *record* is the unit of persistent state. Header: id, type, schema version, frame, owner, lease epoch, state, own elapsed ticks, high-water tick (last mutation), hash. Types: world header, module registry, fidelity, frame, body catalogue, material, pair, ambient field, aggregate, mechanism snapshot, reservoir (integer mass per material, enthalpy, container), terrain edit, ledger, lease, heavy-body checkpoint.

**Identifiers** are minted by sequenced commands from a creator's block, never reused, and survive every hand-off; generated things get one when first touched.

**One owner.** Every mutable record has exactly one owner at every tick. A *lease* is (owner, epoch, expiry tick) granted by one *arbiter* (the host at step 1, the server at step 2); messages with a stale epoch are refused. The step reads no clock, so a lapse is an event the arbiter sequences, and the new epoch starts at the highest tick any survivor holds. A guest that loses the host pauses and reports, or continues in a labelled fork that is never merged. A region is never rewound: it continues, pauses with a report, or demotes. Expiry: 2-5 s (ESTIMATE; set by the two-phone lock test).

**Journal.** Append-only entries: sequence, tick, epoch, kind, payload, reserved author signature, hash of the previous entry. A boundary transaction forces a checkpoint or carries the input tail; a solo owner streams inputs to the record keeper (3.5 MB per hour, DERIVED in 08). Each checkpoint (10 s, ESTIMATE) truncates the journal before it. Storage: a namespaced origin-private directory written from a Worker, persist() requested and shown, flushed on page hide, with file export from the first saving build; at quota it refuses and reports.

**Snapshot.** Whatever could change one future bit is state: body and joint state, warm-start impulses, contact cache, tree order, timers, id counters, delay lines, ledger, lease, clamp, tick. Serialisation is canonical: ascending id, schema order, little-endian, raw f64 bits. Gate: restore at tick N elsewhere, run M ticks, and the hash equals the uninterrupted run's.

**Fingerprint.** A 64-bit hash per record; a region's combines them with tick, epoch and ledger heads; the world's adds the heavy-body checkpoint hash and binary hash. The journal chain uses SHA-256 (CHOICE).

**Join package:** binary hash, record head, journal tail, heavy-body checkpoint, leases, a region snapshot at a sequenced tick, the input tail.

## 8. Aggregates and the three states (VP14, VP19, VP03, P19)

An *aggregate* is the record of an unobserved object: a *gyrostat*, a rigid carrier plus spinning parts.

| Field | Format |
|---|---|
| Mass per material | i64 ug |
| Centre-of-mass position, velocity; orientation | f64 |
| Total angular momentum (authoritative) | f64, frame axes |
| Inertia; rotor momentum h | f64, body axes |
| Energy stores: rotor, elastic, electrical, heat per thermal node, unresolved | Ledger units |
| Ledger totals at demotion | Integers |
| Formula parameters; paused processes; elapsed ticks per subsystem | — |
| Snapshot id, hash; delta list; reseed seed | u64 |

About 256 B plus 128 B per snapshotted body (ESTIMATE, 08).

**Contract.** *Demote* needs non-rotor relative kinetic energy below 5e-7 J/kg (DERIVED in 08 from 1 mm/s); the residual goes to unresolved-to-internal, never negative. The snapshot is authoritative for micro-state, the aggregate for totals and pose; a dormant change updates the aggregate and the delta list in one transaction. *Promote* restores snapshot plus deltas, re-posed, with angular velocity I^-1 (R^T L - h), conserving angular momentum whatever the attitude (a rigid-only record invents 1.41 h at 90 degrees, DERIVED: 2 sin 45). With no time elapsed the round trip returns identical bits; otherwise ledger totals are identical integers and state rounding is booked. Lost going up: matter micro-state, booked to heat. Rebuilt going down: particles from a lattice seeded by hash(record id, tick, world seed); terrain from generator plus edits on the bit-exact CPU path.

**Three states.** *Awake*: in a region and admitted by its budget. *On formula*: every process in a coupled subsystem has a registered exact advance. *Paused*: some process lacks one, so the whole subsystem pauses together, with interval and reason in the Reality Report and an event to the game. Choose in that order.

**One world clock** until the server step. Warp is a world-level input, legal above about 4x (ESTIMATE, 08) only when every region is at rest and demoted, else refused naming the blocker. Per-region `now` stays in the schema; enabling it needs check-out only at or after a record's high-water tick, read-only ghosts otherwise, and property tests.

## 9. Purity (VP08, VP12, P15, P22)

A step is a function of (state, tick, inputs stamped with that tick). The sequencer stamps each input with a future tick; background work must finish by then or the peer stalls. The closed input set: player commands and edits; warp and slowdown; thermal-governor actions that touch simulation; promote, demote; re-base, re-parent; merge, split; lease epoch, join, leave; escrow credits; quantised matter-to-mechanism wrenches on a fixed delay line, applied identically by every peer including the owner; kicks and mass changes to heavy bodies; version changes. Never inputs: wall clock, frame rate, device load, camera, container order. Bit-exact replay (checkpoint plus journal) covers the record, system tier and mechanism tier; matter replays from its wrench stream.

## 10. Fidelity record and clamps (P08, P11, VP20)

One per module and world; it generates the Reality Report. Fields: law; rung (exact, convergent, empirical, sub-grid, out of scope); constants with source; validity envelope; tests; shipped configuration; omissions with size (42.98 arcseconds per century, 499 s per AU, below 0.01c; 08); mixing-rule defaults; paused objects; trust scope (friends only at step 1; lockstep cannot hide information).

1. One stiffness clamp per world: a maximum contact frequency, declared as numerical regularisation, fixed for the world's life, independent of substeps, iterations, frame rate, governor and peer. At 120 Hz: 5.7e5 N/m per kg for any material (DERIVED in 07).
2. No absolute speed clamp; the closing-speed envelope is minimum thickness x 480 per second (1 cm: 4.8 m/s, DERIVED).
3. Sleep is a carrier-relative weld transaction; every clamp activation posts what it removed.
4. Each constant of an adopted solver (six MEASURED in 07) gets an entry or is removed.

## 11. Budget (VF09, VF04, VP13, F20)

| Per 60 Hz frame | Range | Probe item that replaces it |
|---|---|---|
| One core, sustained | About 5 ms (ESTIMATE, unverified excerpt) | Single-core duty, battery drain |
| Page, input, drawing | 1.0-1.5 ms (ESTIMATE) | Empty-scene breakdown |
| System tier | 0.5 ms cap (ESTIMATE, 08) | Heavy-body step timing |
| Ledger, journal, packing | 0.2-0.4 ms (ESTIMATE) | Micro-benchmark |
| Fingerprint, each second | 0.12-0.4 ms (DERIVED: 120 kB at 0.3-1 GB/s; rate ESTIMATE) | Snapshot-plus-hash, 300 bodies |
| Mechanism tier | 2.5 ms: 70-300 boxes alone, 35-150 shared (DERIVED by the red team) | Scalar f64 throughput |
| Network | 0.2-0.5 ms (ESTIMATE); radio power unknown | Data-channel drain |

A shared region's budget is the smallest sustained budget among its peers, at most half the single-phone figure. A peer is in step, catching up at up to 2x, or resyncing with the region paused; repeated mismatch makes it a viewer.

## Interfaces

- **From 02 (system tier):** heavy-body state as a function of (initial record hash, arithmetic version, fixed step grid, journal of kicks and mass changes, tick), with checkpoint and hash; anchor motion; per region and tick a field expansion (gravity, gradient, spin vector) with error estimate; dormant propagation and attitude advance. **To 02:** frame record, conversions, formats, arithmetic rules, the deferred-reaction, integrator-oscillation and mass-delta accounts, aggregate fields, journal container.
- **From 03 (first builds):** pinned toolchain, printed binary hash, a result path of a few hundred bytes, section 11's probe items. **To 03:** gates: anchor invariance; frame-transfer identity; closure; snapshot-restore-continue; rover with spinning wheels round trip (identical hash, angular momentum within 1e-12, ESTIMATE); lease fault injection with three simulated peers and 1,000 owner kills.
- **From the mechanism spec:** f64 anchor-relative state; operator brackets; complete snapshot; weld sleep; adopt-or-write settled before 0b.
- **From the matter spec:** integer mass quanta assigned on the CPU; f32 relative to a window origin only; quantised wrenches; seeded reseeding.
- **From the multiplayer spec:** sequencer, arbiter, transport, viewer mode, the signalling split and server certificate (VF08, VF16, accepted). Matter-coupled islands may be owner-authoritative, marked on the record.
- **From the API spec:** typed quantities; pause, hand-off and anomaly events; engine hand-offs audited apart from game escape hatches.

## Changes to the plan

1. Charter point 1 names gravitation and radiative exchange as laws.
2. One ledger becomes one per frame, with a seam table saying what is exact.
3. "Each region has its own now" becomes one world clock until the server step.
4. "Heavy bodies are a pure function of the tick" becomes the five-argument function above, checkpointed in the world record.
5. "Tiers run unchanged" is withdrawn; surface regions sit in the rotating body frame.
6. "Sleeps at its last checkpoint" is withdrawn: regions never rewind.
7. The aggregate gains rotor momentum and named stores; liquids gain a reservoir record.
8. Rigid bodies agree through sequenced wrenches, not the coarse summary.
9. "250 m across" is a radius. Exactly one owner needs an arbiter, so step 1 is host-authoritative.
10. The integer mass limit is 9.2e9 kg per ledger.

## Open items

- Equal hashes on Safari and the build server over 1e6 steps; correctly rounded square root in WebAssembly is from memory.
- Cost of i128 and double-double postings for 300 bodies; hash rate; snapshot size.
- The 2^-40 tolerance and the 10% numerical-loss gate.
- Whether an adopted solver's snapshot continues bit-identically.
- persist() answer, write rate and eviction; checkpoint interval.
- Lease expiry and merge horizon from two-phone tests.
- Energy drift of the stepped gyrostat attitude.
- Cited sources for every material and pair value; friction in vacuum.
