# Star Citizen and spatially partitioned simulation — research notes

Research pass of 2026-11-24. Flags: V = source opened; V‡ = opened, but the source is a fan compilation citing the developer, not the developer itself; U = search excerpt or memory.

Access: only en.wikipedia.org, arxiv.org, www.gdcvault.com and raw.githubusercontent.com could be opened; RSI, the Star Citizen wikis and all press were blocked. Flags: V = opened this session; V‡ = opened, but the source is [R], a fan compilation (updated 29 Aug 2026) citing CIG videos and posts, not CIG itself; U = search excerpt or memory.

## 1. Findings

Star Citizen
1. Timeline: zones and 64-bit built 2014–15, listed under Alpha 3.0 (Dec 2017); client OCS 3.3 (Nov 2018); server OCS 3.8 (Dec 2019); PES 3.18 (Mar 2023); Replication Layer onto its own server 3.23 (May 2024); static meshing with Pyro in "4.0 Preview" (Dec 2024). Your recollection holds; the 3.23 step was missing. V‡ [R]
2. Disagreements: Wikipedia dates client OCS to December 2018 (V [W1]); CIG's Alpha 2.0 notes (Dec 2015) already list "Large World" and interior physics grids (U [S1]).
3. (a) Positions are 64-bit floats. Each planet, station, ship and room is a nestable "zone" with its own coordinate system, contents stored relative to it; rendering converts to camera-relative 32-bit. V‡ [R]
4. (a) That ship-interior physics grids are separate scenes insulated from the ship's motion is a fan description. U [S2]
5. (b) Client OCS: the server tells each client what to load, by distance and object size, then sends a snapshot and deltas. V‡ [R]
6. (b) Server OCS: areas with no players are serialised to a database and no longer ticked, "frozen in time". The abstract simulator meant to advance them (StarSim) is largely unshipped. V‡ [R]
7. (c) PES: a per-shard graph database, one node per physical entity, edges for containment, mirroring the zone tree; a separate global database holds stowed inventory and money. A relational design was abandoned around end-2020 for latency. V‡ [R]
8. (d) The Replication Layer caches entity state, decides streaming, relays state and writes behind to the database; it simulates nothing. It replaced direct server-to-server links in the 2020–21 redesign and enabled crash recovery, during which "teleporting of entities may be experienced". V‡ [R]; CIG's own wording U [S3]
9. (e) Static meshing: zone subtrees are hand-assigned to servers at shard start; one server has authority per entity; others hold read-only "client views"; a central component transfers authority, at first only in deep space. Border overlap is the compilation's speculation. V‡ [R]
10. (e) Players per shard: 50 (2017), 100–150 (2022), 500 on 10 servers at 4.0 Preview, about 600 later; tests reached 1000+ (V‡ [R]) with interaction delay rising (U [S4]).
11. (e) Unshipped: automatic reassignment of zones, splitting a zone into "simulation islands", scaling out the relay. Shipped in 4.10 (2026): instanced missions on servers started on demand ("quasi-dynamic"). V‡ [R]; U [S5]
12. (f) Costs: the authority conversion touched thousands of call sites over a year; 3.18 brought "major outages" (V [W1]) of about 25 days (U [S6]); 2024 tests flooded the relay's message queue; a crowded section still overloads its server. V‡ [R]

Anchors
13. EVE time dilation slows the game to 10% speed (V [W2]), per node, so unrelated systems on that node slow too (U [S7]).
14. SpatialOS: one worker has write authority per component; the runtime moves it for load balancing; only properties tagged for handover cross. V [SP]
15. LAMMPS: owned subdomains, ghost copies out to the cutoff, ghost forces summed back to the owner (V [L]). Adaptive-mesh codes record the coarse/fine flux mismatch and correct it (V [A]). Merging N particles into two can conserve mass, momentum and energy (V [P]).
16. WGSL has only f16 and f32 (V [G]). Rapier's WASM build claims cross-platform determinism (V [D]). KSP propagates orbits by patched conics (V [W3]).

## 2. Precedents

| System | Unit | Hand-off | Failure mode | Flag |
|---|---|---|---|---|
| EVE | Solar system; several share a node, assigned at startup by predicted load, not one node each | Gate jump; no continuous border | Node-wide slowdown to 10% | V 10%, rest U [S7] |
| SpatialOS | Per-component write authority | Runtime reassigns; tagged state crosses | Untagged server state lost (inference) | V [SP] |
| Second Life | Fixed 256 m region, one core, own physics | Object re-created on the neighbour | Stalls at borders; corner double-crossings fail | V unit [W4], rest U [S8] |
| Dual Universe | Claimed single shard | Unknown | Shut down Aug 2025 | V [W5] |
| Domain decomposition | Owned subdomain plus ghost layer | Ghosts refreshed each step; atoms migrate | Slowest subdomain sets the pace | V [L] |

## 3. Design rules

One phone
1. Positions are (frame, local coordinate), never global floats. My arithmetic: f64 spacing at 1 AU is 30 µm, so at 480 Hz anything slower than about 7 mm/s would not move; at 4 light-years it is 8 m. GPU matter has only f32, so it must live in a region frame.
2. Frames are coordinate changes, not exemptions from physics: apply inertial terms, and convert momentum and kinetic energy between frames in the ledger.
3. Simulate only the awake region, but never freeze the rest. Each sleeping representation needs a closed-form advance over any interval (Kepler arc, hydrostatic rest, lumped cooling); anything without one stays awake or is reported as frozen.
4. Keep the world record separate from the solvers that check regions out. On a phone this buys save, recovery after a tab kill and thermal shedding. Hold it in memory with a journal; Star Citizen's database-in-the-loop design failed on latency.
5. Add EVE's lever to the thermal governor: slow simulated time before cutting fidelity, on one global clock.

Several devices only
6. Relay and interest management, authority load balancing, dynamic splitting, shard databases, lag compensation, crash takeover. This took Star Citizen 2018–2024 and is unfinished. A second awake bubble can also wait.

Conservation at hand-off
7. A hand-off is a double-entry transaction: identical mass, momentum, angular momentum and energy debited and credited, at one simulated time, in a stated frame, never with zero or two owners.
8. Do not split an interaction island across owners. If unavoidable, compute the interface impulse once and apply it to both sides, as LAMMPS does; two solvers each treating the other as a ghost will not give equal and opposite impulses.
9. Regions stepping at different rates need flux registers: each side accumulates what crossed, and the mismatch goes to numerical loss.
10. Turning particles into a lump conserves mass and momentum exactly; kinetic energy the lump cannot represent is booked as internal energy. Promotion regenerates particles deterministically to matching totals.
11. Visible violations: frozen time, teleports after crash recovery, NPCs lost when loaded before their floor (V‡ [R]); Second Life border stalls (U).

Decide now
12. Stable 64-bit IDs and single-writer ownership as an invariant; non-owners send impulses. Retrofitting ownership cost Star Citizen a year.
13. Authoritative and bit-exact: the record, a ledger in integer units, and the CPU tier. GPU particles are owner-local detail; only their coarse summary (mass, momentum, energy per cell) is authoritative.
14. Log every exchange across a tier or region interface, quantised. Otherwise GPU forces entering the CPU tier break the bit-exact replay promised in /home/user/pulsevault/reality-engine/03-plan.md; a peer would later receive the same log.
15. One world clock; transfers only on tick boundaries.

Can wait: transport, prediction, trust model, database choice, parallel islands.

## 4. Not established
- No CIG primary text was opened; Star Citizen detail rests on [R] or excerpts.
- Whether meshed servers overlap at borders, and what an authority transfer serialises.
- Dynamic meshing status after September 2026; boundary-specific bugs in 4.0.
- How physics grids treat inertial forces.
- EVE's node rules, Second Life crossing mechanics, Dual Universe internals.
- Whether Rapier determinism holds in our WASM build.

Sources
[R] https://raw.githubusercontent.com/un0btanium/sc-server-meshing/main/public/techs/unofficial-road-to-dynamic-server-meshing.md
[W1] https://en.wikipedia.org/wiki/Star_Citizen [W2] https://en.wikipedia.org/wiki/Battle_of_B-R5RB [W3] https://en.wikipedia.org/wiki/Kerbal_Space_Program [W4] https://en.wikipedia.org/wiki/Second_Life [W5] https://en.wikipedia.org/wiki/Dual_Universe
[SP] https://raw.githubusercontent.com/spatialos/UnrealGDK/0.4.2/SpatialGDK/Documentation/content/handover-between-server-workers.md
[L] https://raw.githubusercontent.com/lammps/lammps/develop/doc/src/Developer_par_comm.rst
[A] https://raw.githubusercontent.com/AMReX-Codes/amrex/development/Docs/sphinx_documentation/source/AmrCore.rst
[P] https://arxiv.org/abs/1411.2248
[G] https://raw.githubusercontent.com/gpuweb/gpuweb/main/wgsl/index.bs
[D] https://raw.githubusercontent.com/dimforge/rapier.rs/master/docs/user_guides/templates/determinism.mdx
Excerpt only: [S1] https://robertsspaceindustries.com/comm-link/transmission/15106-star-citizen-alpha-20-available [S2] https://starcitizen.tools/Comm-Link:BTS_-_Multicrew_%26_Physics_Grids [S3] https://api.star-citizen.wiki/comm-links/18397 [S4] https://robertsspaceindustries.com/spectrum/community/SC/forum/3/thread/server-meshing-tests [S5] https://starcitizen.tools/Comm-Link:Letter_from_the_Chairman_-_2026-08-27 [S6] https://massivelyop.com/2023/04/04/star-citizens-forums-and-launcher-are-crashing-once-more-as-the-multiweek-pu-partial-outage-stretches-on/ [S7] https://www.eveonline.com/article/time-dilation-hows-that-going and https://www.eveonline.com/article/building-a-balanced-universe [S8] https://wiki.secondlife.com/wiki/Region_crossing
