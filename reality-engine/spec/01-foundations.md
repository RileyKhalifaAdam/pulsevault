# Spec 01 — Laws, materials and the world record

This is the permanent layer: the rules, number formats, records and accounts every solver, region and peer stands on. Numbers are tagged MEASURED, DERIVED, ESTIMATE (until the Phase 0a probe or a cited source replaces it) or CHOICE (a design parameter). 07 and 08 are the saved red-team and design files; 02 and 03 are the sibling specs.

## 1. Charter as registration rules

A *module* is any unit of physics or bookkeeping: kernel, closure (an empirical formula), integrator, generator or port. Strict mode refuses to step with an unregistered one.

| Rule | What the module must show |
|---|---|
| 1. Named laws only | Its law: balance of mass, momentum, angular momentum, energy and charge; the second law (heat from dissipation is never negative); Newtonian gravitation; radiative exchange (inverse-square flux, Stefan-Boltzmann). Anything else, uniform g included, is a closure or a derived approximation with reported error. |
| 2. Geometry and measured data only | Each parameter resolves to a material, pair or body-catalogue field with source and uncertainty. |
| 3. Shortcuts declared | A fidelity-record entry and sensitivity test per constant and clamp; what it removes is posted to an account. |
| 4. Claims tested | Reference and tolerance, on the canonical binary at shipped precision, tick and body count. |
| 5. Units by types | Typed signatures in SI units; a must-not-compile test. |
| 6. No global coordinates | Identical hash with the anchor at the origin, at 1 AU moving 29.78 km/s, and at 30 AU (CHOICE of cases, 08). |
| 7. Double-entry hand-offs | A seam-table row (section 6); paired postings under one transaction id; one owner. |
| 8. Nothing silently frozen | Per process: an advance with a test and a declared error, or "pauses" (section 8). |
| 9. Purity | Inputs from the closed set (section 9); no clock, host maths or unseeded randomness; snapshot-restore-continue hash equality. |

## 2. Numbers

| Quantity | Format (i signed integer, u unsigned, f float, with bit width) | Unit |
|---|---|---|
| Time | i64 | Tick of 1/480 s; 6.1e8 years (DERIVED: 2^63 / 480 / 3.156e7) |
| Identifier | u64 | 16-bit creator slot, 48-bit counter (CHOICE) |
| Mass: mechanism bodies, particle quanta, a heavy body's mass delta | i64 | Microgram (ug); 9.2e9 kg per ledger (DERIVED: 2^63 x 1e-9; CASCADE's 9.2e12 in 08 is a slip). A heavy body's own mass is its GM in f64 |
| Region ledger totals | i128 | Momentum 2^-16 ug m/s; mass moment 2^-16 ug m; angular momentum 2^-32 ug m^2/s; energy 2^-33 ug m^2/s^2 = 1.16e-19 J (CHOICE) |
| Spin phase | u64 | 2^-64 turn, integer rate per tick (CHOICE) |
| Heavy bodies, mechanism state | f64 | Relative to parent or anchor |
| Free-fall anchors; system and body ledgers | Double-double (two f64; 106 bits, DERIVED: 2 x 53) | Earth's 2.6e33 J (DERIVED in 07) still has 64 J spacing (DERIVED: 2^(111-105)) |
| Matter tier, drawing | f32 | Never hashed |

Bit-exactness rules for the CPU side:

1. **The shipped .wasm binary is the canonical arithmetic.** Server and native app run it unless the build server shows equal hashes. Its SHA-256 and the arithmetic version are in the world record and the handshake; a mismatch is refused.
2. f64 uses only operations WebAssembly defines exactly: + - x /, square root, comparison, rounding to an integer and integer conversion. No fused multiply-add (a x b + c rounded once), relaxed vector instructions or threads in the ordered path; the build scans the binary for forbidden instructions and host imports.
3. Own trigonometric, exponential and power functions with fixed iteration counts; no host maths.
4. Loops and sums run in ascending id; ledger sums are formed in double-double and rounded once, to nearest with ties to even.
5. A NaN (not-a-number) or infinity is never stored or hashed; producing one pauses its island (bodies linked by contacts or joints) with a report.
6. Randomness is keyed by (world seed, record id, tick).

Public quantities carry their dimension in the type. A position carries its frame id; mixing frames without conversion is an error.

## 3. Frames

A *frame* is a coordinate system with one parent; an *anchor* is a region frame's origin. Record: id, kind, parent, origin and velocity in the parent, orientation, angular velocity, children's number format, radius cap, `now` (tick of its state), ledger id.

| Kind | Parent | Origin | Children |
|---|---|---|---|
| Star system | Galaxy | 3 x i64 km | f64 to 2^43 m (58.8 AU, DERIVED in 08) |
| Body inertial | System or body | f64 | f64 |
| Body-fixed (the only rotating kind) | Body inertial | Same; integer spin phase | f64 |
| Free-fall region | Body inertial or system | Double-double, from the system tier | f64 to 8 km (CHOICE, 08) |
| Surface region | Body-fixed | f64, fixed | f64 to 8 km |
| Matter window | Region or carrier | f64, whole cells | f32 to 1.28 m (CHOICE) |

Full simulation reaches about 250 m from the focus (ESTIMATE, 08); 8 km is the hard cap. Free-fall anchors are double-double because f64 at 1 AU steps by 2^-15 m (DERIVED: 1.496e11 m lies between 2^37 and 2^38; 37 - 52), coarser than a re-base quantum.

**State conversion.** For a child with origin R, velocity V, rotation Q (child axes to parent axes) and angular velocity W: r' = R + Q r; v' = V + Q v + W x (Q r); w' = W + Q w. Two frames convert through their nearest common ancestor.

**Ledger re-expression.** A set of bodies has mass M, mass moment N (sum of m r), momentum P, angular momentum L about the origin (spin included), kinetic energy K and inertia J about the origin.

- Shift and boost (vectors rotated by Q first): N' = N + M R; P' = P + M V; L' = L + R x P + N x V + M (R x V); K' = K + P.V + (1/2) M V^2. The added terms are the *frame-transfer* posting.
- A *re-base* (moving a region's anchor) is R = -d, V = -u in multiples of 2^-16 m and m/s (CHOICE, 08). Every term is then a whole number of ledger units (DERIVED: ug x 2^-16 x 2^-16 = 2^-32; the half gives 2^-33), so the ledger side is exact. Each body's f64 state rounds by at most half a spacing (4.5e-13 m at 8 km, DERIVED: 2^-41); the booked rounding is bounded per body by m times half a velocity spacing in momentum, and m |v| times that in energy (DERIVED).
- Rotating to non-rotating at one origin, spin w: P' = P + w x N; L' = L + J w; K' = K + w.L + (1/2) w.J w. A surface region at R_a from the body's centre becomes free-fall this way; its new anchor moves at w x R_a.

In a rotating frame with its origin on the spin axis the conserved energy is K + U_gravity - (1/2) w.J w, equal to E_inertial - w.L_inertial (DERIVED by substitution). A surface ledger keeps that centrifugal potential relative to its anchor, per body -m (w x R_a).(w x r) - (1/2) m |w x r|^2 (DERIVED by expanding |w x (R_a + r)|^2). It posts centrifugal and Coriolis impulses to "inertial impulse" and expects zero Coriolis work. On roll-up, inertial impulses cancel against the anchor's own change of motion, so nothing fictitious reaches the parent ledger.

## 4. Materials

Each numeric field stores value, uncertainty class, source, reference temperature and validity range; use outside the range is flagged. Tiers: Me mechanism, Ma matter, L ledger, E environment.

| Field | Unit | Tier and meaning |
|---|---|---|
| Phase; density | –; kg/m^3 | All: solid, liquid, gas or granular; mass from geometry |
| Young's modulus, Poisson's ratio | Pa, – | Me, Ma: stiffness, sideways strain |
| Yield, ultimate strength; fracture toughness | Pa; Pa m^0.5 | Me, Ma: where it bends, breaks, cracks |
| Specific heat, conductivity, melting point, latent heat | J/kg/K, W/m/K, K, J/kg | L, Ma, E: heat storage, flow, phase change |
| Viscosity, surface tension, bulk modulus; molar mass, heat-capacity ratio | Pa s, N/m, Pa; kg/mol, – | Ma: liquids; E: gases |
| Friction angle, cohesion, grain density | degree, Pa, kg/m^3 | Ma: slope a pile holds |
| Resistivity; surface emissivity | ohm m; – | L: Joule heat; E: thermal radiation |

Initial library: every value is an ESTIMATE recalled from memory of handbook-typical figures; no source was opened. Class (A within 2%, B 10%, C 30%, D wider) is the class expected once sourced. While a source reads "memory" the value counts as class D, the Reality Report lists it as unsourced, and no gate that depends on it may pass.

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
| Dry sand | 1,600 bulk | – | – | 33 degrees | 800 | C |
| Lunar regolith | 1,500 bulk | – | – | 40 degrees | 760 | D |
| Air, 288.15 K (1.8e-5 Pa s) | 1.225 | – | – | – | 1,005 | A |

**Pair table: empirical closures, not laws.** Friction is Coulomb, static at rest and kinetic when sliding; its work goes to heat. Restitution is e(v) = min(e_0, e_ref (v / 1 m/s)^(-1/4)), v being the normal approach speed: the plastic-regime trend in 01-research.md (unverified there), under a low-speed plateau e_0 below 1, so small bounces die through a booked channel and not through solver damping (e_0 = 0.9 for every listed pair, ESTIMATE). The loss (1 - e^2) x (1/2) m_reduced v_normal^2 goes to heat by definition. A pair record adds rolling resistance, validity (dry, in air, 250-350 K) and source. A missing pair takes the geometric mean of the self-pairs as a declared class-D default, listed in the Reality Report; with a self-pair missing the contact is refused. Values are ESTIMATES from memory, class C-D; friction in vacuum is outside validity.

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
| Mass per material; mass moment; momentum; angular momentum; kinetic | Measured | From state, in this frame |
| Gravitational; centrifugal potential | Measured | Relative to the anchor, from the supplied field; centrifugal in rotating frames only |
| Stored elastic; electrical and chemical; heat | Measured | Springs and strain; batteries, propellant; thermal, latent, unresolved-to-internal |
| In transit; escrow | Measured | Wrenches (force-torque pairs) in the delay line; objects debited, not yet credited |
| Dissipation | Posted | Friction, restitution, viscous, plastic, Joule: each from its own formula, never negative |
| Boundary flux; external work; creation | Posted | Per port, with radiative source and sink and the ambient medium; forces a game applies from outside the model; world creation |
| Gravity impulse; inertial impulse; field change; reservoirs | Posted | From the supplied field; fictitious forces; a time-varying field; ground, planet, atmosphere |
| Frame transfer; numerical loss; rounding | Posted | Section 3 terms; per operator; the tick's leftover |
| Deferred reaction; integrator oscillation; mass delta | Body, system | Reactions owed to heavy bodies; the orbit integrator's bounded energy error; mass added or removed |

**Numerical loss is not the leftover.** Each operator measures the accounts it touches before and after itself, posts its physical channels from their formulas, and posts the rest of its own bracket as numerical loss. Three checks keep that honest. Where a closed form exists the two must agree: an implicit spring loses (1/2) m dv^2 + (1/2) k dx^2 per step (DERIVED from backward Euler). An operator made only of internal forces must show zero momentum and angular-momentum loss to rounding, and an energy gain is an anomaly. And the tick identity (change in measured accounts = postings + rounding) catches a missing operator or unbooked mutation as rounding above tolerance. Brackets and closure run every tick; if the probe shows they do not fit, their cadence becomes a sequenced world constant, never a per-phone choice.

**Closure tolerances** (ESTIMATE until the first 0b run). Mass: exactly 0 every tick. Momentum, angular momentum, energy: rounding at most 2^-40 of the summed magnitudes of the tick's totals and postings, plus one unit per posting. A breach raises an anomaly event and pauses the region. Numerical loss is gated at 10% of physical dissipation on named scenes such as ring-down and rebound (ESTIMATE; the mechanism spec sets it).

## 6. Ports and seams

A *port* is a declared interface where matter, momentum or energy crosses a region or tier boundary, on a tick. Each keeps a per-tick flux account: mass per material, momentum, angular momentum, energy by store, transaction id, counterparty. A posting is valid only when the counterparty holds its equal and opposite at the same tick. A *seam* is any such hand-over.

| Seam | Mass | Momentum, angular momentum | Energy |
|---|---|---|---|
| Quantised re-base | Exact | Exact in the ledger; state rounding booked | Same |
| Object between regions; merge, split | Exact | Exact up to one booked rounding | Same |
| Surface frame to body inertial | Exact | Bounded, booked | Bounded |
| Mechanism demote, promote | Exact | Exact in the ledger; state rounding booked | Exact by store |
| Particles to reservoir and back | Exact (integer quanta) | Owner-attested, bounded | Attested; unresolved to heat; reseed mismatch booked |
| Matter-to-mechanism wrench | — | Exact: the quantised value acts on both sides | Bounded by the fluid's ledgered energy drop |
| Gravity from, and contact with, a heavy body | — | Exact in the region (reservoir posting); bounded on roll-up to deferred reaction | Bounded |
| Region to system roll-up | Exact | Bounded (double-double) | Bounded |

**Merge and split.** Regions merge before contact is possible, when predicted approach falls inside 10 s (DERIVED from ESTIMATES: 0.6 MB at 1 Mbit/s = 4.8 s, plus 2,304 ticks caught up at 2x = 4.8 s). Both stand at one tick, both ledgers close into one with frame-transfer postings, the older lease sequences, and the summed awake set passes admission or the region slows by sequenced command. Promotion reserves its worst-case cost the same way. Split distance is twice merge distance (CHOICE). An interaction island is never divided. Contact above the closing-speed envelope (section 10) is a declared impact: mass and momentum conserved, the rest booked as heat.

## 7. The world record

A *record* is the unit of persistent state. Header: id, type, schema version, frame, owner, lease epoch, state, own elapsed ticks, high-water tick (last mutation), fingerprint. Types: world header (seed, binary hash, arithmetic version, integrator id, version and step), module registry, fidelity, frame, body catalogue, material, pair, ambient field, aggregate, mechanism snapshot, reservoir (integer mass per material, enthalpy, container), terrain edit, ledger, lease, heavy-body checkpoint.

**Identifiers** are minted by sequenced commands from a creator's block, never reused, and survive every hand-off; generated things get one when first touched.

**One owner.** Every mutable record has exactly one owner at every tick. A *lease* is (owner, epoch, expiry) granted by one *arbiter*: the host at step 1, the server at step 2. Expiry is a deadline on the arbiter's own clock, outside the step; the step sees only the lapse, an event the arbiter sequences and journals. Every message carries the epoch and a stale one is refused. The new epoch starts at the highest tick any survivor holds, with the inputs the others lack forwarded. A guest that loses the host pauses and reports, or continues in a labelled fork that is never merged; taking over the host's role needs a registrar both phones can reach, holding the epoch number. A region is never rewound: it continues, pauses with a report, or demotes. Expiry length: 2-5 s (ESTIMATE; set by the two-phone lock test).

**Journal.** Append-only entries: sequence, tick, epoch, kind, payload, reserved author signature, hash of the previous entry. A boundary transaction forces a checkpoint or carries the input tail; a solo owner streams inputs to the record keeper. Each checkpoint (10 s, ESTIMATE) replaces the last but one and truncates the journal before it, keeping a capped input tail for bug reports. Storage is a namespaced origin-private directory with persist() requested, a flush on page hide and file export from the first saving build. A failed write or full quota is reported as "not saved"; it never changes what the step does.

**Snapshot.** Whatever could change one future bit is state: body and joint state, warm-start impulses, contact cache, tree order, timers, id counters, delay lines, ledger, lease, clamp, tick. Serialisation is canonical: ascending id, schema order, little-endian, raw f64 bits. Gate: restore at tick N elsewhere, run M ticks, and the fingerprint equals the uninterrupted run's.

**Fingerprint and join.** The fingerprint is 64-bit FNV-1a over the canonical bytes (CHOICE; offset 0xcbf29ce484222325, prime 0x100000001b3, both from memory). It detects bugs, not cheats. Each record keeps one; a region's hashes them in ascending id with tick, epoch and ledger heads; the world's adds the heavy-body checkpoint and binary hash. It is taken at sequenced ticks. A joiner receives binary hash, record head, journal tail, heavy-body checkpoint, leases, a region snapshot at a sequenced tick, the input tail and the coarse matter field.

## 8. Aggregates and the three states

An *aggregate* is the record of an unobserved object: a *gyrostat*, a rigid carrier plus spinning parts.

| Field | Format |
|---|---|
| Mass per material | i64 ug |
| Centre-of-mass position, velocity; orientation | f64 |
| Total angular momentum L (authoritative) | f64, frame axes |
| Inertia I; rotor momentum h relative to the carrier | f64, body axes |
| Energy stores: rotor, elastic, electrical and chemical, heat per thermal node, unresolved | Ledger units |
| Ledger totals at demotion | Integers |
| Propagation mode, formula parameters, bounding radius; paused processes; elapsed ticks per subsystem | — |
| Snapshot id, fingerprint; delta list; reseed seed | u64 |

**Contract.** *Demote* (store as an aggregate) is one transaction in three steps. Weld: parts other than rotors must move, relative to the carrier, with under 5e-7 J/kg (DERIVED: (1/2) v^2 at 1 mm/s, a CHOICE in 08); that residual is zeroed and posted to unresolved-to-internal, never negative. Snapshot the welded state. Compute the aggregate from it. The snapshot is authoritative for micro-state, the aggregate for totals and pose; a dormant change updates both in one transaction, and the totals sit in the parent frame's ledger. *Promote* (return to full simulation) restores the snapshot, re-posed, with angular velocity I^-1 (R^T L - h), R being the body-to-frame rotation, which conserves angular momentum whatever the attitude. With no time elapsed promote returns the snapshot's bits and the aggregate recomputed from them is identical. Otherwise ledger totals are identical integers, state rounding is booked, and any energy difference left by the dormant advance is posted as its numerical loss. Lost going up: matter micro-state, booked to heat. Rebuilt going down: particles on a lattice seeded by hash(world seed, record id, demotion tick), stored in the record; terrain from generator plus edits on the bit-exact CPU path.

**Three states.** *Awake*: in a region and admitted by its sequenced budget. *On formula*: every process in a coupled subsystem has a registered advance, exact or with a declared error bound, whose result at a tick does not depend on when or how often it is evaluated. *Paused*: some process lacks one, so the whole subsystem pauses together, with interval and reason in the Reality Report and an event to the game. Choose in that order. An object a region cannot admit is never left unsimulated inside it: the region slows instead.

**One world clock** until the server step. Warp is a world-level input that changes ticks per frame, never the tick or a step size. It is legal above about 4x (ESTIMATE, 08) only when every region is at rest and demoted, else refused naming the blocker. Per-region `now` stays in the schema; enabling it needs check-out only at or after a record's high-water tick, read-only ghosts otherwise, transfers at the later of the two clocks, and property tests.

## 9. Purity

A step is a function of (state, tick, inputs stamped with that tick). The *sequencer* (the peer ordering a region's inputs) stamps each with a future tick; background work must finish by then or the peer stalls. The closed input set:

- player commands and edits;
- warp, slowdown and the region budget; thermal-governor actions that touch simulation;
- promote, demote; re-base, re-parent; merge, split;
- lease epoch and lapse, join, leave; escrow credits;
- from the matter owner: quantised matter-to-mechanism wrenches on a fixed delay line, applied identically by every peer including the owner; attested ledger postings; states of owner-authoritative islands;
- kicks and mass changes to heavy bodies; integrator and version changes.

Never read: wall clock, frame rate, device load, storage state or camera; the awake set comes from sequenced state only. The matter tier's coarse field serves drawing and attested postings, never the mechanism tier. Bit-exact replay (checkpoint plus journal) covers the record, system tier and mechanism tier; matter is not replayed, its recorded wrenches are.

## 10. Fidelity record and clamps

One per module and world; it generates the Reality Report, the list of approximations in force. Fields: law; rung (exact, convergent, empirical, sub-grid, out of scope); constants with source; validity envelope; tests; shipped configuration; omissions with size; mixing-rule defaults; unsourced values; paused objects; trust scope (friends only at step 1; lockstep, peers simulating from shared inputs, cannot hide information).

1. One stiffness clamp per world: a maximum contact frequency, declared as numerical regularisation and never as a material value, fixed for the world's life, independent of substeps, iterations, frame rate, governor and peer. ESTIMATE: 120 Hz, a quarter of the tick rate, where every clamped contact has stiffness m (2 pi 120)^2 = 5.7e5 N/m per kg whatever its material (DERIVED in 07). The report lists each clamped pair with its real frequency; patch radius and peak force come from the real moduli.
2. No absolute speed clamp. The closing-speed envelope is the pair's smaller thickness x 480 per second (DERIVED: 1 cm x 480 = 4.8 m/s); below it nothing can pass through unseen. Above it a swept pair (always against static shapes, opt-in between moving bodies) gets the declared impact of section 6, and an unswept pair is reported as out of envelope from sequenced state.
3. Sleep is a carrier-relative weld transaction; every clamp activation posts what it removed; each constant of an adopted solver (six MEASURED in 07) is declared with a sensitivity test or removed.

## 11. Budget

| Line, per 60 Hz frame (ESTIMATES) | Range | Replaced by probe item |
|---|---|---|
| Page, input, drawing | 1.0-1.5 ms | Empty-scene breakdown |
| System tier | 0.5 ms cap | Heavy-body step timing |
| Ledger, journal, fingerprint | 0.3-0.8 ms | Snapshot-plus-fingerprint, 300 bodies |
| Mechanism tier | 2.5 ms: 70-300 boxes alone, 35-150 shared (DERIVED in the red-team findings) | Scalar f64 throughput |
| Network | 0.2-0.5 ms; radio power unknown | Data-channel drain |
| Bytes | Region snapshot 0.6 MB, aggregate 256 B (ESTIMATES, 08); heavy-body checkpoint 1,632 B (DERIVED: 34 x 6 x 8); inputs 3.5 MB per player-hour (DERIVED in 08: 60 x 16 B x 3,600) | Snapshot size, write rate |

The 5 ms total and the plan's 4 W rest on unverified excerpts; there is no watt line until sustained duty and battery percent over a 20-minute soak are measured. A shared region's budget is sequenced: the smallest among its peers, at most half the single-phone figure (CHOICE), the other half being catch-up reserve; joins pass admission like merges. A peer is in step, catching up at up to 2x, or resyncing with the region paused; repeated mismatch makes it a viewer.

## Interfaces

- **From 02 (system tier):** heavy-body state as a function of (initial record hash, arithmetic version, fixed step grid, journal of kicks and mass changes, tick), with checkpoint and hash; anchor motion; per region and tick a field expansion (gravity, gradient, spin vector) with error estimate; dormant propagation modes and attitude advance. **To 02:** frame record, conversions, formats, arithmetic rules, the deferred-reaction, integrator-oscillation and mass-delta accounts, aggregate fields, journal container. 02's stated mismatch is closed: free-fall anchors are double-double.
- **From 03 (first builds):** pinned toolchain, printed binary hash, a few-hundred-byte result path, section 11's probe items. **To 03:** fingerprint and serialisation; gates: anchor invariance; frame-transfer identity; ledger closure, failing when one posting is removed; snapshot-restore-continue; a join from snapshot plus input tail matching after 10,000 ticks; round trip of a rover with spinning wheels and a flywheel (identical fingerprint, angular momentum within 1e-12 relative, ESTIMATE, 08); lease fault injection with three simulated peers and 1,000 random owner kills. 02 and 03 gate the frame-transfer identity at "1 ledger unit per body"; with these units that holds on the ledger side only, and the state side is bounded as in section 3.
- **From later specs.** Mechanism: f64 anchor-relative state; operator brackets; complete snapshot; weld sleep; swept detection; adopt-or-write settled before 0b. Matter: integer mass quanta from the CPU; f32 only inside a window; quantised wrenches and attested postings; seeded reseeding. Multiplayer: sequencer, arbiter, registrar, transport, fingerprint cadence, viewer mode from step 1, the signalling split and server certificate (VF08, VF16, accepted); matter-coupled islands may be owner-authoritative, marked on the record. API: typed quantities; pause, hand-off and anomaly events; engine hand-offs audited apart from game escape hatches.

## Changes to the plan

- Charter point 1 names gravitation, radiative exchange and charge as laws (P03, F11); point 8's "exact formula" admits a declared error bound.
- One ledger per frame, plus a seam table (VP04).
- One world clock until the server step; warp never changes a step size (VP03).
- Heavy-body state is the five-argument function above, checkpointed in the world record (VP02, VF10).
- "Tiers run unchanged" is withdrawn; surface regions sit in the rotating body frame (VP05).
- Regions never rewind to a checkpoint (VP10, VP19); rigid bodies agree through sequenced wrenches, not the coarse summary (VP08).
- Aggregates gain rotor momentum and named stores; liquids gain a reservoir record (VP14, VP16).
- The GPU's f32 is relative to a matter window, not the region origin (VP16); free-fall anchors are double-double, not f64.
- "250 m across" is a radius (VP15); step 1 is host-authoritative (VF03).
- "100-300 boxes" and "4 W" become section 11's ranges (VF09).

## Open items

- Equal hashes on Safari and the build server over 1e6 steps; correctly rounded square root in WebAssembly and the FNV constants are from memory.
- Cost of per-tick brackets, i128 and double-double postings, fingerprint rate and snapshot size for 300 bodies; the closure tolerance.
- Whether an adopted solver's snapshot continues bit-identically.
- persist() answer, write rate, eviction; lease expiry and merge horizon from two-phone tests.
- Cited sources for every material and pair value; library values for the fields the table omits (conductivity, emissivity, resistivity); e_0 per pair; friction in vacuum.
- The stiffness clamp's value; whether step-2 phones co-simulate or view (VP13).
