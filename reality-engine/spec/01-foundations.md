# Spec 01 — Laws, materials and the world record

This is the permanent layer: the rules, number formats, records and accounts every solver, region and peer stands on. It fixes what a module must prove before registration, which numbers are integers, 64-bit floats (f64) or 32-bit floats (f32), and the WebAssembly binary as canonical arithmetic. It gives exact rules for re-expressing momentum, angular momentum and energy across frames, and a ledger per frame with independently measured numerical loss. It defines a world record with one owner per record, a hash-chained journal and snapshots that continue bit-identically.

CHOICE marks a design parameter, as in 08.

## 1. Charter as registration rules

A *module* is any unit of physics or bookkeeping: kernel, closure (an empirical formula), integrator, generator or port. Strict mode refuses to step with one missing from the world record's registry.

| Rule | What the module must show |
|---|---|
| 1. Named laws only | Its law: balance of mass, momentum, angular momentum, energy; the second law (heat from dissipation is never negative); Newtonian gravitation; radiative exchange (inverse-square flux, Stefan-Boltzmann). Uniform g is a derived approximation with reported error. |
| 2. Geometry and measured data only | Each parameter resolves to a material, pair or body-catalogue field with source and uncertainty. |
| 3. Shortcuts declared | A fidelity-record entry and sensitivity test per constant and clamp; what it removes is posted to an account. |
| 4. Claims tested | Reference and tolerance, on the canonical binary at shipped precision, tick and body count. |
| 5. Units by types | Typed signatures; a must-not-compile test. |
| 6. No global coordinates | Identical hash with the anchor at the origin, at 1 AU moving 29.78 km/s, and at 30 AU. |
| 7. Double-entry hand-offs | A seam-table row (section 6); paired postings under one transaction id; one owner. |
| 8. Nothing silently frozen | Per process: an exact advance with a test, or "pauses" (section 8). |
| 9. Purity | Inputs from the closed set (section 9); no clock, host maths or unseeded randomness; snapshot-restore-continue hash equality. |

## 2. Numbers

| Quantity | Format | Unit |
|---|---|---|
| Time | i64 | Tick of 1/480 s; 6.1e8 years (DERIVED: 2^63 / 480 / 3.156e7) |
| Identifier | u64 | 16-bit creator slot, 48-bit counter (CHOICE) |
| Mass: bodies, particle quanta, heavy-body mass delta | i64 | Microgram; 9.2e9 kg per ledger (DERIVED: 2^63 x 1e-9; CASCADE's 9.2e12 in 08 is a slip) |
| Region ledger totals | i128 | Momentum 2^-16 ug m/s; mass moment 2^-16 ug m; angular momentum 2^-32 ug m^2/s; energy 2^-33 ug m^2/s^2 = 1.16e-19 J (CHOICE) |
| Spin phase | u64 | 2^-64 turn, integer rate per tick (CHOICE) |
| Heavy bodies, anchors, mechanism state | f64 | Relative to parent or anchor |
| System and body ledgers | Double-double (two f64, about 106 bits) | Earth's 2.6e33 J (DERIVED in 07) still has 64 J spacing (DERIVED: 2^(111-105)) |
| Matter tier, drawing | f32 | Never hashed |

Bit-exactness rules for the CPU side:

1. **The shipped .wasm binary is the canonical arithmetic.** Server and native app run it unless the build server shows equal hashes. Its hash and the arithmetic version are in the world record and the handshake; a mismatch is refused.
2. Only + - x / and square root on f64. No fused multiply-add (a x b + c rounded once), relaxed vector instructions or threads in the ordered path.
3. Own trigonometric, exponential and power functions with fixed iteration counts; no host maths.
4. Loops and sums run in ascending id; ledger sums are formed in double-double and rounded once.
5. A NaN (not-a-number) is never stored or hashed; producing one pauses its island (bodies linked by contacts or joints) with a report.
6. Randomness is keyed by (world seed, record id, tick).

Public quantities carry their dimension in the type (Rust `uom`, MEASURED in 01-research.md). A position carries its frame id; mixing frames without conversion is an error.

## 3. Frames

A *frame* is a coordinate system with one parent; an *anchor* is a region frame's origin. Record: id, kind, parent, origin and velocity in the parent, orientation, angular velocity, children's number format, radius cap, `now` (tick of its state), ledger id.

| Kind | Parent | Origin | Children |
|---|---|---|---|
| Star system | Galaxy | 3 x i64 km | f64 to 2^43 m (58.8 AU, DERIVED in 08) |
| Body inertial | System or body | f64 | f64 |
| Body-fixed, the only rotating kind | Body inertial | Same; integer spin phase | f64 |
| Free-fall region | Body inertial or system | f64, moved by the system tier | f64 to 8 km (CHOICE) |
| Surface region | Body-fixed | f64, fixed | f64 to 8 km |
| Matter window | Region or carrier | f64, whole cells | f32 to 1.28 m (CHOICE) |

**State conversion.** For a child with origin R, velocity V, rotation Q (child axes to parent axes) and angular velocity W: r' = R + Q r; v' = V + Q v + W x (Q r); w' = W + Q w. Two frames convert through their nearest common ancestor.

**Ledger re-expression.** A set of bodies has mass M, mass moment N (sum of m r), momentum P, angular momentum L about the origin (spin included), kinetic energy K and inertia J about the origin.

- Shift and boost (vectors rotated by Q first): N' = N + M R; P' = P + M V; L' = L + R x P + N x V + M (R x V); K' = K + P.V + (1/2) M V^2. The added terms are the *frame-transfer* posting.
- A *re-base* (moving a region's anchor) is R = -d, V = -u in multiples of 2^-16 m and m/s (CHOICE, 08). Every term is then a whole number of ledger units (DERIVED: ug x 2^-16 x 2^-16 = 2^-32; the half gives 2^-33), so the ledger side is exact. Only the f64 state rounds, by at most one spacing per body.
- Rotating to non-rotating at one origin, spin w: P' = P + w x N; L' = L + J w; K' = K + w.L + (1/2) w.J w.

In a rotating frame the conserved energy is K + U_gravity - (1/2) w.J w, equal to E_inertial - w.L_inertial (DERIVED by substitution). A surface ledger therefore carries a centrifugal-potential account, posts centrifugal and Coriolis impulses to "inertial impulse" and expects zero Coriolis work.

## 4. Materials

Each numeric field stores value, uncertainty class, source, reference temperature and validity range; use outside the range is flagged. Tiers: Me mechanism, Ma matter, L ledger, E environment.

| Field | Unit | Tier and meaning |
|---|---|---|
| Density | kg/m^3 | All: mass from geometry |
| Young's modulus, Poisson's ratio | Pa, – | Me, Ma: stiffness, sideways strain; contact estimates |
| Yield, ultimate strength; fracture toughness | Pa; Pa m^0.5 | Me, Ma: where it bends, breaks, cracks |
| Specific heat, conductivity, melting point, latent heat | J/kg/K, W/m/K, K, J/kg | L, Ma, E: heat storage, flow, phase change |
| Viscosity, surface tension, bulk modulus | Pa s, N/m, Pa | Ma: liquids |
| Friction angle, grain density | degree, kg/m^3 | Ma: slope a pile holds |
| Resistivity; surface emissivity | ohm m; – | L: Joule heat; E: thermal radiation |

Initial library: ESTIMATES recalled from handbook-typical figures; strict mode fails the build while any source reads "memory". Class: A within 2%, B 10%, C 30%, D wider.

| Material | Density | E, GPa | Poisson | Strength, MPa, or friction angle | Heat, J/kg/K | Class |
|---|---|---|---|---|---|---|
| Mild steel | 7,850 | 200 | 0.29 | 250 yield | 490 | B |
| Aluminium 6061-T6 | 2,700 | 69 | 0.33 | 276 yield | 896 | B |
| Copper | 8,960 | 117 | 0.34 | 70 yield | 385 | B |
| Oak, along grain | 700 | 11 | 0.35 | 50 crushing | 2,000 | C |
| Natural rubber | 1,100 | 0.005 | 0.49 | 20 tensile | 1,900 | D |
| Soda-lime glass | 2,500 | 70 | 0.22 | 40 tensile | 840 | C |
| Concrete | 2,400 | 30 | 0.20 | 30 compressive | 880 | C |
| Water ice, 263 K | 917 | 9 | 0.33 | 5 compressive | 2,050 | C |
| Water, 293 K (1.0e-3 Pa s) | 998 | 2.2 bulk | – | – | 4,182 | A |
| Dry quartz sand | 1,600 bulk | – | – | 33 degrees | 800 | C |
| Lunar regolith | 1,500 bulk | – | – | 40 degrees | 760 | D |
| Air, 288.15 K (1.8e-5 Pa s) | 1.225 | – | – | – | 1,005 | A |

**Pair table: empirical closures, not laws.** Friction is Coulomb; its work goes to heat. Restitution is e(v) = min(1, e_ref (v / 1 m/s)^(-1/4)) (trend from 01-research.md, unverified there); the loss (1 - e^2) x (1/2) m_reduced v_normal^2 goes to heat by definition. A pair record adds rolling resistance, validity (dry, in air, 250-350 K) and source; a missing pair takes the geometric mean of the self-pairs, flagged. Values are ESTIMATES, class C-D; friction in vacuum is outside validity.

| Pair | Static | Kinetic | e_ref |
|---|---|---|---|
| Steel-steel | 0.74 | 0.57 | 0.6 |
| Oak-oak | 0.6 | 0.5 | 0.5 |
| Steel-oak | 0.5 | 0.4 | 0.4 |
| Steel-rubber | 0.9 | 0.7 | 0.8 |
| Oak-rubber | 0.8 | 0.6 | 0.6 |
| Rubber-concrete | 1.0 | 0.8 | 0.8 |

The ambient medium is a field record (density, pressure, temperature, velocity by position); vacuum is that record with zero density.

## 5. The ledger

A *ledger* is the set of accounts kept in one frame: integers per region, double-double per body and system. Each closes at its own magnitude and rolls up to its parent through section 3. An *operator* is one stage of a step, such as the contact solve.

| Account | Kind | Content |
|---|---|---|
| Mass per material; mass moment; momentum; angular momentum; kinetic | State | Measured in this frame |
| Gravitational; centrifugal potential | State | Relative to the anchor, from the supplied field; rotating frames only |
| Stored elastic; electrical; heat | State | Springs and strain; batteries; thermal, latent, unresolved-to-internal |
| In transit; escrow | State | Wrenches (force-torque pairs) in the delay line; objects debited, not yet credited |
| Dissipation | Flow | Friction, restitution, viscous, plastic, Joule: each from its own formula |
| Boundary flux; external work; creation | Flow | Per port, with radiation and ambient medium; player-driven actuators; world creation |
| Field change; inertial impulse; reservoirs | Flow | Time-varying field; fictitious impulses; ground, planet, atmosphere |
| Frame transfer; numerical loss; rounding | Flow | Section 3 terms; per operator; the tick's leftover |
| Deferred reaction; integrator oscillation; mass delta | Body, system | Reactions owed to heavy bodies; the orbit integrator's bounded energy error; mass added or removed |

**Numerical loss is not the leftover.** Each operator measures the accounts it touches before and after itself, posts its physical channels from formulas, and posts the rest of its own bracket as numerical loss. Where a closed form exists both must agree: an implicit spring constraint loses (1/2) m dv^2 + (1/2) k dx^2 per step (DERIVED from backward Euler). The tick identity (change in state = flows + rounding) then tests something: a missing operator or unbooked mutation shows as rounding above tolerance.

**Closure tolerances** (ESTIMATE until the first 0b run). Mass: exactly 0 every tick. Momentum, angular momentum, energy: rounding at most 2^-40 of the summed magnitudes of the tick's totals and postings, plus one unit per posting. A breach raises a ledger-anomaly event and pauses the region. Numerical loss is gated at 10% of physical dissipation on named scenes (ESTIMATE; the mechanism spec sets it).

## 6. Ports and seams

A *port* is a declared interface where matter, momentum or energy crosses a region or tier boundary, on a tick. Each keeps a per-tick flux account: mass per material, momentum, angular momentum, energy by store, transaction id, counterparty. A posting is valid only when the counterparty holds its equal and opposite at the same tick. A *seam* is any such hand-over.

| Seam | Mass | Momentum, angular momentum | Energy |
|---|---|---|---|
| Quantised re-base | Exact | Exact; state rounding booked | Same |
| Object between regions; merge, split | Exact | Exact up to one booked rounding through the common ancestor | Same |
| Surface frame to body inertial | Exact | Bounded, booked | Bounded |
| Mechanism demote, promote | Exact | Exact | Exact by store |
| Particles to reservoir and back | Exact (integer quanta) | Owner-attested, bounded | Attested; unresolved to heat; reseed mismatch booked |
| Matter-to-mechanism wrench | — | Exact: the quantised value acts on both sides | Bounded by the fluid's ledgered energy drop |
| Contact with a planet; gravity from above | — | Exact; counter-entry in deferred reaction | Bounded |
| Region to system roll-up | Exact | Bounded (double-double) | Bounded |

**Merge and split.** Regions merge before contact is possible, when predicted approach falls inside 10 s (DERIVED from ESTIMATES: 0.6 MB at 1 Mbit/s = 4.8 s, plus 2,304 ticks caught up at 2x = 4.8 s). Both stand at one tick, both ledgers close into one, the older lease sequences, and the summed awake set passes admission or the region slows by sequenced command. Split distance is twice merge distance (CHOICE). An interaction island is never divided. Contact above the declared closing-speed envelope conserves mass and momentum and books the rest as heat.

## 7. The world record

A *record* is the unit of persistent state. Header: id, type, schema version, frame, owner, lease epoch, state, own elapsed ticks, high-water tick (last mutation), hash. Types: world header, module registry, fidelity, frame, body catalogue, material, pair, ambient field, aggregate, mechanism snapshot, reservoir (integer mass per material, enthalpy, container), terrain edit, ledger, lease, heavy-body checkpoint.

**Identifiers** are minted by sequenced commands from a creator's block, never reused, and survive every hand-off; generated things get one when first touched.

**One owner.** Every mutable record has exactly one owner at every tick. A *lease* is (owner, epoch, expiry tick) granted by one *arbiter* (the host at step 1, the server at step 2); a stale epoch is refused. The step reads no clock, so a lapse is an event the arbiter sequences, and the new epoch starts at the highest tick any survivor holds. A guest that loses the host pauses and reports, or continues in a labelled fork that is never merged. A region is never rewound: it continues, pauses with a report, or demotes. Expiry: 2-5 s (ESTIMATE; set by the two-phone lock test).

**Journal.** Append-only entries: sequence, tick, epoch, kind, payload, reserved author signature, hash of the previous entry. A boundary transaction forces a checkpoint or carries the input tail; a solo owner streams inputs to the record keeper. Each checkpoint (10 s, ESTIMATE) truncates the journal before it. Storage: a namespaced origin-private directory written from a Worker; persist() requested and shown; flush on page hide; file export from the first saving build; refuse and report at quota.

**Snapshot.** Whatever could change one future bit is state: body and joint state, warm-start impulses, contact cache, tree order, timers, id counters, delay lines, ledger, lease, clamp, tick. Serialisation is canonical: ascending id, schema order, little-endian, raw f64 bits. Gate: restore at tick N elsewhere, run M ticks, and the hash equals the uninterrupted run's.

**Fingerprint and join.** A 64-bit hash per record; a region's combines them with tick, epoch and ledger heads; the world's adds the heavy-body checkpoint and binary hashes. A joiner receives binary hash, record head, journal tail, heavy-body checkpoint, leases, a region snapshot at a sequenced tick and the input tail.

## 8. Aggregates and the three states

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

**Contract.** *Demote* (store as an aggregate) needs non-rotor relative kinetic energy below 5e-7 J/kg (DERIVED in 08 from 1 mm/s); the residual goes to unresolved-to-internal, never negative. The snapshot is authoritative for micro-state, the aggregate for totals and pose; a dormant change updates both in one transaction. *Promote* (return to full simulation) restores the snapshot, re-posed, with angular velocity I^-1 (R^T L - h), conserving angular momentum whatever the attitude. With no time elapsed the round trip returns identical bits; otherwise ledger totals are identical integers and state rounding is booked. Lost going up: matter micro-state, booked to heat. Rebuilt going down: particles from a lattice seeded by hash(record id, tick, world seed); terrain from generator plus edits on the bit-exact CPU path.

**Three states.** *Awake*: in a region and admitted by its budget. *On formula*: every process in a coupled subsystem has a registered exact advance. *Paused*: some process lacks one, so the whole subsystem pauses together, with interval and reason in the Reality Report and an event to the game. Choose in that order.

**One world clock** until the server step. Warp is a world-level input, legal above about 4x (ESTIMATE, 08) only when every region is at rest and demoted, else refused naming the blocker. Per-region `now` stays in the schema; enabling it needs check-out only at or after a record's high-water tick, read-only ghosts otherwise, and property tests.

## 9. Purity

A step is a function of (state, tick, inputs stamped with that tick). The *sequencer* (the one peer ordering a region's inputs) stamps each with a future tick; background work must finish by then or the peer stalls. The closed input set: player commands and edits; warp and slowdown; thermal-governor actions that touch simulation; promote, demote; re-base, re-parent; merge, split; lease epoch, join, leave; escrow credits; quantised matter-to-mechanism wrenches on a fixed delay line, applied identically by every peer including the owner; kicks and mass changes to heavy bodies; version changes. Never read: wall clock, frame rate, device load, camera, container order; the awake set comes from sequenced state only. Bit-exact replay (checkpoint plus journal) covers the record, system tier and mechanism tier; matter replays from its wrench stream.

## 10. Fidelity record and clamps

One per module and world; it generates the Reality Report, the readable list of every approximation in force. Fields: law; rung (exact, convergent, empirical, sub-grid, out of scope); constants with source; validity envelope; tests; shipped configuration; omissions with size; mixing-rule defaults; paused objects; trust scope (friends only at step 1; lockstep (peers simulating from shared inputs) cannot hide information).

1. One stiffness clamp per world: a maximum contact frequency, declared as numerical regularisation, fixed for the world's life, independent of substeps, iterations, frame rate, governor and peer.
2. No absolute speed clamp; the closing-speed envelope is minimum thickness x 480 per second (1 cm: 4.8 m/s, DERIVED).
3. Sleep is a carrier-relative weld transaction; every clamp activation posts what it removed; each constant of an adopted solver (six MEASURED in 07) is declared or removed.

## 11. Budget

| Line, per 60 Hz frame (ESTIMATES) | Range | Probe item that replaces it |
|---|---|---|
| Page, input, drawing | 1.0-1.5 ms | Empty-scene breakdown |
| System tier | 0.5 ms cap | Heavy-body step timing |
| Ledger, journal, fingerprint | 0.3-0.8 ms | Snapshot-plus-hash, 300 bodies |
| Mechanism tier | 2.5 ms: 70-300 boxes alone, 35-150 shared (DERIVED in the red-team findings) | Scalar f64 throughput |
| Network | 0.2-0.5 ms; radio power unknown | Data-channel drain |

The 5 ms total rests on an unverified excerpt and is replaced by measured sustained duty. A shared region's budget is the smallest among its peers, at most half the single-phone figure. A peer is in step, catching up at up to 2x, or resyncing with the region paused; repeated mismatch makes it a viewer.

## Interfaces

- **From 02 (system tier):** heavy-body state as a function of (initial record hash, arithmetic version, fixed step grid, journal of kicks and mass changes, tick), with checkpoint and hash; anchor motion; per region and tick a field expansion (gravity, gradient, spin vector) with error estimate; dormant propagation and attitude advance. **To 02:** frame record, conversions, formats, arithmetic rules, the deferred-reaction, integrator-oscillation and mass-delta accounts, aggregate fields, journal container.
- **From 03 (first builds):** pinned toolchain, printed binary hash, a few-hundred-byte result path, section 11's probe items. **To 03:** gates: anchor invariance; frame-transfer identity; ledger closure; snapshot-restore-continue; spinning-wheel rover round trip (identical hash, angular momentum within 1e-12, ESTIMATE); lease fault injection (three simulated peers, 1,000 owner kills).
- **From later specs.** Mechanism: f64 anchor-relative state; operator brackets; complete snapshot; weld sleep; adopt-or-write settled before 0b. Matter: integer mass quanta assigned on the CPU; f32 relative to a window origin only; quantised wrenches; seeded reseeding. Multiplayer: sequencer, arbiter, transport, viewer mode, the signalling split and server certificate (VF08, VF16, accepted); matter-coupled islands may be owner-authoritative, marked on the record. API: typed quantities; pause, hand-off and anomaly events; engine hand-offs audited apart from game escape hatches.

## Changes to the plan

- Charter point 1 names gravitation and radiative exchange as laws (P03, F11).
- One ledger per frame, with a seam table saying what is exact (VP04).
- One world clock until the server step, not a "now" per region (VP03).
- Heavy-body state is the five-argument function above, checkpointed in the world record, not "a pure function of the tick" (VP02, VF10).
- "Tiers run unchanged" is withdrawn; surface regions sit in the rotating body frame (VP05).
- Regions never rewind to a checkpoint (VP10, VP19); rigid bodies agree through sequenced wrenches, not the coarse summary (VP08).
- Aggregates gain rotor momentum and named stores; liquids gain a reservoir record (VP14, VP16).
- "250 m across" is a radius (VP15); step 1 is host-authoritative because one owner needs an arbiter (VF03).
- "100-300 boxes" and "4 W" become section 11's ranges (VF09).

## Open items

- Equal hashes on Safari and the build server over 1e6 steps; correctly rounded square root in WebAssembly is from memory.
- Cost of i128 and double-double postings, hash rate and snapshot size for 300 bodies.
- The 2^-40 tolerance and the 10% numerical-loss gate.
- Whether an adopted solver's snapshot continues bit-identically.
- persist() answer, write rate, eviction; lease expiry and merge horizon from two-phone tests.
- Cited sources for every material and pair value; friction in vacuum.
