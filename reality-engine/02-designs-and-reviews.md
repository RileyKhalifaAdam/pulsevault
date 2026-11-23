# Reality engine — three candidate architectures and their red-team reviews

---

# Hamilton — one incremental potential, many primitives (stance: variational-solver-first)

**Thesis.** Reality has one rulebook, so the engine has one solver. Every substep, the whole awake world is the minimiser of a single incremental potential: inertia + stored elastic energy + dissipation potentials (friction, damping, motor back-EMF) + contact and joint constraints. Rigid bodies, reduced-coordinate articulations, FEM solids, shells, rods and material points differ only in which degrees of freedom and which energy terms they contribute. The minimiser is augmented vertex block descent (AVBD lineage) run at small substeps.

Why this is the right backbone for "building a robot on top of reality": a machine does not know which solver it lives in. Its chassis is rigid, its tyre is FEM, its suspension is a joint plus a spring, its cable is a rod, and it drives through sand. Multi-solver engines (Newton, Genesis) put coupling seams exactly where gameplay happens; Newton's MPM sees rigid bodies as colliders only. With one objective there is one definition of force, one stiffness-clamp rule, one material library, one energy ledger and one scalar error (the minimisation residual) for the whole world. Adding a kind of matter means adding an energy term and a block type, not a solver.

Priority is mechanisms that actually work: motors, gearboxes, linkages, vehicles, robots, on the CPU, bit-deterministic. Deformables attached to mechanisms are solved monolithically in the same sweep. Liquids and granulars are the same functional discretised on GPU material points.

Where the stance is honestly weak:
- AVBD has no published CPU or mobile numbers and every implementation is labelled experimental. The proven phone-class solver is Soft Step, and my estimate is that the unified solver carries about one third of a specialised rigid engine's body count (about 1,100 boxes at 8 substeps against about 3,000 at 4).
- Block descent conserves momentum only at convergence; impulse solvers conserve it pairwise by construction.
- The implicit part of the integrator dissipates energy numerically.
- VBD converges poorly at 1:10,000 stiffness ratios, so stiff matter must be rigid.
- The GPU matter tier is not in the same linear solve as the CPU tier: it is one principle on two machines, coupled by a staggered exchange, and it is not bit-exact.
- Seven primitive types is a large scope.

The plan answers these with measurement rather than rhetoric: a Phase 2 A/B gate against a Soft Step sweep (itself a block Gauss-Seidel pass on the linearised potential, so the fallback stays inside the principle), a per-tick residual and energy ledger, and declared clamps.

## First-principles stance

CHARTER. One hard-coded law: each substep the state minimises Phi(x) = (1/2h^2)|x - x~|^2_M + Psi(x) + h*D((x - x_n)/h) + constraint and contact terms. Its stationarity condition is Newton's second law per degree of freedom. Every Psi is translation- and rotation-invariant, so linear and angular momentum conservation follow from the principle (Noether) at convergence. Every D is convex and non-negative, so entropy production is non-negative by construction (Clausius-Duhem admissibility). Nothing object-specific exists outside geometry, material and constitutive model. SI units at the API with compile-time dimension types; nondimensionalised fp32 inside kernels.

DERIVED FROM CONSERVATION LAWS AND MEASURED PARAMETERS (Tier 0-1):
- mass and inertia tensors from geometry x density, never authored
- gravity; joint kinematics; ideal gear ratios from tooth counts
- elastic energies from measured E, nu, thickness: stable Neo-Hookean solids, membrane plus hinge-bending shells, Cosserat rods
- hydrostatic pressure and buoyancy emerging from the matter tier, never a buoyancy formula
- reflected rotor inertia N^2*I; DC-motor transduction with K_t = K_e and back-EMF as a Rayleigh dissipation term K^2/R; lumped circuits by Kirchhoff (modified nodal analysis)

EMPIRICAL CLOSURES (Tier 2, labelled; parameters per material pair with source and uncertainty):
- Coulomb friction with separate static and kinetic coefficients on an elliptic cone (pyramids bias direction)
- contact dissipation (Hunt-Crossley) in place of a restitution constant
- rolling and torsional resistance scaled by the computed contact-patch radius
- yield and hardening, Drucker-Prager friction angle, viscosity, gearbox efficiency and backlash, motor losses
Tier 3 phenomenological: aerodynamic drag and lift on bodies, sub-grid splash and turbulence, no surface tension.

NUMERICAL COMPROMISES, each measured and reported:
1. Stiffness clamp. Contact and material stiffness are derived from Hertz and E, then clamped so the resolved frequency is at most 1/4 of the substep rate (120 Hz at 480 Hz). Effective contact moduli land in the 1e5-1e7 Pa band Drake also accepts, against 2e11 Pa for steel. Report: requested versus achieved stiffness per material pair.
2. Rigid idealisation. Matter stiffer than the clamp is rigid; its modulus feeds contact only.
3. Softened liquids. At dx 2 cm and 4 substeps an explicit P-wave modulus tops out near 23 kPa, about 1e5 times softer than water; iterations raise it but stay budget-limited. Report: density error.
4. Unconverged minimisation. Momentum defect = h x sum of block residuals; constraint violation. Report: both, per island per tick.
5. Integrator dissipation from the implicit part. Report: a "numerical" account in the energy ledger.
6. Staggered CPU-GPU coupling with about one frame of lag. Report: exchanged-impulse mismatch.
7. Sleeping, kinematic gear pairs, adjacent-link collision filters, fp32.

REPORTING. A Reality Report is always available as HUD and JSON: energy ledger (kinetic, potential, elastic, heat by cause, actuator work, numerical), momentum defect, clamp table, density error, coupling defect and a list of non-physical Director actions. Every feature is tagged with its fidelity tier in the docs. Out of scope by declaration: atomistic, relativistic, Maxwell fields, shocks, resolved turbulence.

## Architecture

ONE STEP. Fixed tick 1/60 s. Substeps per island: 4 for loose piles, 8 by default (h = 1/480 s), 16-32 for flagged precision islands (gear trains, 1:1000 mass ratios). Each substep:
- predictor x~ = x_n + h*v_n + h^2*M^-1*f for resolved smooth forces (gravity, actuator torques), the symplectic-Euler part
- minimise Phi over all awake degrees of freedom: one graph-coloured Gauss-Seidel primal sweep plus one augmented-Lagrangian dual update, duals warm-started across substeps and frames
- velocities from position increments
The unknowns are increments, not positions, so fp32 keeps full relative precision at small h; world poses accumulate in f64.

PRIMITIVES ARE BLOCK TYPES IN THE SAME SWEEP:
- rigid body: 6-DOF block, 6x6 LDLT
- articulation: its whole reduced-coordinate vector is one block (Featherstone CRBA/ABA). Tree joints are exact; loop closures and contacts are AL rows through its Jacobian; armature and implicit joint damping included
- FEM vertex (stable Neo-Hookean tets), shell vertex (membrane plus dihedral bending), rod node (Cosserat position plus quaternion): 3-6-DOF blocks
- actuators add energy and dissipation terms, never special cases

CONTACT AND FRICTION:
- broad phase: dynamic AABB tree, once per frame with speculative margins
- narrow phase: sphere, capsule, box, cylinder, convex hull (up to 32 vertices), static meshes and heightfields, vertex-shape for deformables
- hybrid speculative plus time-of-impact CCD against statics
- normal contact: compliant unilateral AL constraint, stiffness from Hertz, clamped
- friction: lagged-normal maximum-dissipation term on an elliptic cone, persistent anchors for static friction
- IPC-style barriers only where affordable: offset-distance bounds for cloth and rod self-contact, valid while per-substep motion stays within the contact radius. No full IPC (1.4-776 s per step on desktop CPUs).

MATTER TIER (GPU). Liquids and granulars are material points: the same functional discretised with APIC/MLS-MPM transfers on a moving dense 64^3 window (dx 2-4 cm, a 1.3-2.6 m cube), quadratic B-splines, sort-plus-gather P2G, solved by PB-MPM-style compliant iterations (2 substeps x 2 iterations, or 4 x 1 when fast). Constitutive models come from the shared library: volumetric liquid, Drucker-Prager sand, viscoplastic mud.

COUPLING. Attached deformables (tyres, belts, cables, pads, cloth) are monolithic: same sweep, on CPU. Bulk matter couples through one shared frictional contact potential. The CPU exports collider proxies with start and end poses; the GPU returns per-body wrenches; the CPU adds them plus a linearised impedance (added mass and drag) so the lag is semi-implicit.

DATA AND THREADS. Structure-of-arrays, union-find islands with sleeping, persistent greedy colouring so results are independent of thread count, 4-wide NEON / SIMD128. The CPU owns everything gameplay-authoritative and is bit-deterministic; GPU matter is fp32 and tolerance-reproducible.

WORLD AND MEMORY. f64 world coordinates (kilometre-scale addressable), awake bubble about 30 m, about 20k sleeping bodies stored. Engine state under 150 MB (estimate: 2k bodies x 256 B, 10k manifolds x 256 B, 32k points x 96 B = 3 MB, grid 64^3 x 32 B = 8 MB, the rest proxies, BVH and render buffers), far below the roughly 1 GB web budget.

## Frame budget

DESIGN POINT: sustained, not cool. Every workload is sized to about 60% of cool-device capacity (published A16 GPU stability 51-84%; about 4.3 W over a 30-minute game run).

PER 16.67 ms FRAME: GPU at most 10 ms (matter compute 4.5, render 5.5); CPU physics at most 4.0 ms wall on the 2 P-cores; main thread under 8 ms; controllers and game logic under 1 ms; device about 4 W; thermal state at or below "fair" for 20-30 minutes (about 11% battery per 20 minutes).

CPU DERIVATION (native, A16 P-core roughly equal to M2 P-core). Box3D Soft Step on M2: 5,050 boxes cost 9.1 ms on 1 thread and 4.9 ms on 2 (1.85x) at 4 substeps, i.e. 1.8 microseconds per box-frame per core. Estimate: 30% is collision (0.54 microseconds, independent of substeps) and 70% solve (0.32 microseconds per box-substep). Estimate: an AVBD 6x6 block sweep costs 2x a Soft Step sweep; no CPU or mobile AVBD timing is published. At 8 substeps: 8 x 0.63 = 5.0 microseconds solve per box-frame per core, 2.7 microseconds wall on two cores.

Reference scene:
- collision, once per frame: 0.5 ms
- 300 awake primitives (0.8 ms) + 60 hulls (x3.3 per Box3D's hull/box ratio, 0.55 ms): 1.4 ms
- 2 articulated robots x 30 DOF: 8 substeps x about 30 microseconds (MuJoCo humanoid about 25 microseconds per step per core on M3 Max, derated 1.2x) = 0.24 ms each, in parallel: 0.3 ms
- deformables: 0.8 ms = 1.5 core-ms / 0.6 microseconds per FEM vertex-sweep (estimate: about 22 incident tets x 25 ns plus a 3x3 solve) = about 2,400 vertex-sweeps: 600 FEM vertices (about 2,500 tets) at 4 sweeps, or about 1,500 cloth vertices, or about 3,000 rod nodes
- islands, sleeping, sensors, ledger, proxy export: 0.4 ms; headroom 0.6 ms
Single-category ceilings in the same 3.4 ms: about 1,100 stacked boxes, 350 piled hulls or 1,800 jointed bodies at 8 substeps; roughly double at 4.

WEB TIER (Phases 1-4): one WASM thread with SIMD128. Estimate 1.4x WASM penalty and no second core, so about 40% of native: about 400 boxes, or 120 primitives + 20 hulls + one 30-DOF robot + 250 FEM vertices.

GPU MATTER. The invariant is particle-passes per frame. Scaling the one measured native iPhone MLS-MPM app to A16 gives 15-28k points cool and 10-17k sustained with a quality renderer (low confidence); the WebGPU-demo scaling gives 50-100k with cheap rendering at 1-2 steps. Plan: 16k points x 4 passes = 64k particle-passes sustained natively (24k cool), 12k on web until measured. At 8 points per cell that is 16 L of matter at dx 2 cm or 128 L at 4 cm: a bucket to a bathtub. Advection limit dx/h: 3.6 m/s at 3 cm with 2 substeps, 7.2 m/s with 4.

WHY MECHANISMS STAY ON CPU. AVBD's 110,000 blocks in 3.5 ms on an RTX 4090 scales (about 46x FLOPS ratio; the 4090 figure is from memory) to about 2,400 blocks cool and 1,400 sustained on the A16 GPU. That is no better than the CPU, consumes the matter budget and forfeits bit-exact determinism.

THERMAL GOVERNOR (never touches dt, substeps or iterations): render resolution and fluid shading, then 30 Hz presentation, then time dilation to 0.5x (logged in replays). Settled islands and settled liquid always sleep. Phase 1 replaces these estimates with on-device measurements.

## Platform and toolchain

LANGUAGE. Rust on the stable toolchain. One platform-agnostic core crate (solver, collision, materials, replay) plus thin hosts. Strict floating point for the CPU core: no fast-math, no FMA contraction, in-house sin/cos/atan2, fixed iteration and insertion order, SIMD written lane-wise so scalar, SSE2, NEON and WASM SIMD128 give identical bits. Units through the `uom` crate at the API boundary.

GPU API. WGSL compute and render through wgpu (v30): browser WebGPU on the web, Metal natively, one shader source. WGSL is written to WebKit's stricter dialect from day one (no textures bound to `let`, constant arrays of 2,047 elements or fewer, large tables in buffers). Limits are requested explicitly from adapter.limits and designed to the portable floor: 256 MiB per buffer, at most 8 storage buffers per stage, workgroups of 256 invocations. Integer atomics only, hence sort-plus-gather P2G and fixed-point per-body wrench sums.

FIRST ON-DEVICE DEMO (no Mac, no Apple account). The container builds wasm32 + JS glue + WGSL into a static site; a git push publishes it on GitHub Pages; the user opens the URL in Safari on iOS 26 or later and adds it to the Home Screen for full-screen and wake lock. It starts single-threaded, because GitHub Pages cannot send the cross-origin isolation headers that WASM threads need; a service-worker shim (coi-serviceworker) is added later only if measurements justify it. Web constraints designed in from the start:
- about 1 GB process budget (tabs are killed near 2 GB), so snapshots go to OPFS with storage.persist() and resume-after-kill is a core feature
- requestAnimationFrame drops to 30 fps in Low Power Mode and under thermal mitigation, so 30 Hz presentation is a supported mode
- no haptics on iPhone Safari

LONG-TERM PATH. The same core as a native iOS app: Rust static library for aarch64-apple-ios, wgpu on Metal, a thin Swift shell. Built and signed on GitHub Actions macOS runners (macOS 26 arm64, Xcode 26.x) with fastlane and an App Store Connect Team API key, delivered by TestFlight (builds last 90 days). This needs the paid Apple Developer Program (US$99 per year); runners are free for public repositories and about US$0.062 per minute for private ones. Native unlocks both P-cores with NEON, E-cores for background jobs, ProcessInfo.thermalState, Core Haptics, float atomics, buffers up to the full device limit, and hand-written Metal 3/4 kernels as an optimisation layer under wgpu.

REPOSITORY. The user's existing PWA repository is unrelated and stays untouched; the engine belongs in its own repository (see decisions).

CI WITHOUT A PHONE. The Linux container builds and tests x86-64 native and wasm32 (wasmtime/node) and compares state hashes; WASM float semantics are fixed by spec, so it is the determinism reference. A phone replay log reproduces bit-exactly in the container, which replaces an attached debugger.

## Game-builder API

MENTAL MODEL. A game is a machine shop plus control software. Authors describe matter and mechanisms; the engine supplies reality; game code reads sensors and commands actuators.

VOCABULARY:
- Material: a named record in the material database (density, E, nu, yield, dissipation, later thermal), each value with source and uncertainty. Friction and dissipation live in a material-pair table.
- Part: shape + material. Mass, inertia and contact stiffness are derived, never set.
- Assembly: parts + joints (revolute, prismatic, spherical, universal, screw, weld with finite strength, gear pair with ratio and backlash, belt or cable as a rod).
- Actuators: DC motor + gearbox (voltage in; K_t, R, L, rotor inertia, efficiency), linear actuator, spring, damper, brake, clutch, all powered from a battery (energy capacity, internal resistance).
- Sensors: encoder, tachometer, IMU, joint force-torque, contact and pressure pads, strain on deformables, range finder, current and voltage, each with rate, resolution and optional noise.
- Controller: a function called at a fixed control rate (60, 120 or 240 Hz) that reads sensors and writes actuator inputs. This is the only write path in strict mode.
- Player input: a "hand" (compliant spring-damper with force and power limits) or tele-operated actuator commands.

READ-ONLY ACCESS. Raycast, overlap, sweep, closest points; poses, velocities, stresses; the energy ledger and Reality Report; events (contact begin/end, joint break, yield, sleep/wake, budget overrun).

NOT ALLOWED IN STRICT MODE. Setting pose or velocity of dynamic matter; sourceless forces or impulses; editing mass or inertia; changing material constants at runtime; friction overrides outside the pair table; disabling collision between non-adjacent parts; changing time scale.

ESCAPE HATCHES (the Director API: explicit, logged, counted in the Reality Report):
- spawn and despawn at declared ports, with mass and energy booked as external
- prescribed-motion bodies (an infinite-impedance actuator; its power draw is reported)
- teleport of whole sleeping assemblies
- trigger volumes (sense only), time dilation, idealised unbreakable "bedrock" material, debug forces

UNITS AND RANGE. SI only. Rust SDK with compile-time dimensions; TypeScript SDK with unit-tagged constructors. Documented supported range: parts 1 cm to 10 m, 1 g to 10 t, mass ratio within an island up to 1:1000 (tested), speeds up to 50 m/s.

AUTHORING. A versioned text assembly format, MJCF import first and USD Physics later, plus an in-app inspector: telemetry plots, clamp table, and a budget meter that prices an assembly (blocks, contact rows, particle-passes) against the device budget before it runs.

DETERMINISM AND REPLAY. Snapshot + input log (actuator commands, Director actions, governor events, recorded GPU coupling wrenches) replays the CPU world bit-exactly on web, native and CI. Snapshots include solver warm-start state, so restore-and-continue equals an uninterrupted run. GPU matter is re-simulated within tolerance, not bit-exact. Rollback netcode is not promised in v1.

DESIGNER LEVERS THAT ARE PHYSICAL. Energy budgets (battery capacity), material strength, torque and current limits, mass and reach: the natural gating mechanisms, in place of scripted locks.

## Validation plan

STRUCTURE (FDS-style: verification checks the math, validation checks the physics), all headless.

T0 CONSERVATION AND DETERMINISM, every commit:
- mass exact; ballistic and isolated free-body momentum to round-off
- momentum defect of interacting islands (h x sum of block residuals) at most 1e-3 of exchanged impulse per tick; energy-ledger closure at most 1e-4 relative per tick, numerical-loss account reported
- state-hash equality after 10,000 ticks on 20 scenes: x86-64 native = wasm32 = arm64, independent of thread count; snapshot-restore-continue equals an uninterrupted run

T1 CLOSED-FORM VERIFICATION, with observed convergence order under substep and mesh refinement:
- projectile range within 0.3% at 8 substeps; pendulum period versus the amplitude series within 0.2%, energy loss at most 0.5%/s at 480 Hz (estimate about 0.3%/s from the chord-versus-tangent projection error 0.75(theta-dot x h)^2 per substep), order at least 0.9
- Dzhanibekov: angular momentum magnitude within 0.1%, kinetic energy within 0.5% over 10 s
- incline: slip onset atan(mu_s) within 0.5 degrees, sliding acceleration within 2%; Le Lidec sliding-cube dissipated energy (mu x m x g x d) within 2% with no normal bounce
- 10-box stack drift under 1 mm in 10 s; 100:1 heavy-on-light; 1:1000 chain stretch under 0.5%; card pyramid stands
- slider-crank and four-bar coupler curves within 0.1% of link length; Chrono/ADAMS joint reference trajectories within 1%
- DC motor: no-load speed V/K_e and stall torque K_t x V/R within 0.5%, mechanical time constant within 2%; gear ratio exact, backlash within 5%
- cantilever tip deflection PL^3/3EI within 3% refined, phone-resolution error published; first mode within 5%; Euler buckling within 5%; Hertz force-indentation within 10% where resolvable; rod and cloth catenary within 1%
- matter: hydrostatic rho x g x h within 3%, density error at most 5% at 0.5 m depth; Archimedes draft within 5%; Torricelli within 10%; heave period of a floating block within 10%; coupling momentum defect at most 2% of exchanged impulse

T2 EXPERIMENTAL VALIDATION, nightly:
- Martin and Moyce dam-break front within 10% to dimensionless time 3; granular column run-out exponent within 0.15 and prefactor within 20%; angle of repose within 3 degrees; MFIX DEM02 bounce heights and DEM05 oblique impact; ten Cate sphere settling within 15%
- cube-toss dataset (550 tosses): position error at most 20% of cube width (fitted Drake, Bullet and MuJoCo reach 13-25%), tracked as an honesty metric

RUNNING WITHOUT AN IPHONE:
- CPU suite natively and as WASM in the Linux container; bit-exactness makes container results equal on-device results
- WGSL kernels: naga validation plus a WebKit-dialect lint; execution on software Vulkan through wgpu if the container allows it (to be confirmed in Phase 1), otherwise on a GitHub macOS arm64 runner's Metal device (availability unverified); tolerance comparison against a slow CPU reference of the same kernels
- performance gated on deterministic operation counters (block solves, contact rows, particle-passes), with macOS arm64 runner timings as an A16 P-core proxy
- on-device: the PWA carries a 60-second conformance subset and a 20-minute thermal soak, each producing a copyable report (frame-time percentiles, GPU timestamps if exposed, frame-rate halving events)

Tolerances are re-baselined once after Phase 1 device measurements and afterwards only tighten. Each release publishes a fidelity report.

## Roadmap

### 1. First contact on the phone
- Goal: Prove the delivery path, measure the real device, and run a minimal variational rigid core on the user's iPhone 15.
- Deliverables: Static PWA (Rust to wasm32 with SIMD128, wgpu on Safari WebGPU, GitHub Pages). Capability probe: adapter limits and features, cross-origin isolation, hardware concurrency, memory growth, iOS version. Microbenchmarks: block-solve throughput and sort-plus-gather P2G particle-passes per ms. Solver v0: 6-DOF rigid blocks, primitive shapes, augmented-Lagrangian joints (revolute, prismatic, spherical, weld), compliant contact with elliptic-cone friction, islands and sleeping, energy ledger v0, touch 'hand' spring. CI with T0 and rigid T1 tests and x86-versus-WASM state hashes.
- Exit criteria: The user opens a URL on their iPhone 15 and a 150-body scene (box stack, double pendulum, a four-bar linkage they can grab) holds 60 Hz through a 10-minute soak with p95 physics time at most 4 ms; the probe and microbenchmark report is pasted back and replaces the estimates in the frame budget; at least 12 T0/T1 tests pass; x86-64 and wasm32 hashes are equal.

### 2. Mechanisms that work
- Goal: Robotics-grade articulated mechanisms with physical actuators and sensors, and a data-backed solver decision.
- Deliverables: Articulation blocks (Featherstone reduced coordinates, loop closures as AL rows), DC motor + gearbox + battery, springs, dampers, brakes, sensors, fixed-rate controller API in TypeScript, MJCF subset import, convex hulls with speculative + time-of-impact CCD, kinematic gear pair with backlash, wheels. A/B harness: AVBD block sweep versus a Soft Step sweep on identical scenes (stacking, friction, energy, cost). Robot-arm and RC-car demos.
- Exit criteria: All mechanism T1 tests pass (motor constants within 0.5-2%, 1:1000 chain under 0.5% stretch, slider-crank within 0.1%, 10-box stack drift under 1 mm). An imported 6-DOF arm stacks three cubes using only sensors and motor voltages. On the phone, one 30-DOF robot plus 120 primitives sustains 60 Hz for 10 minutes. The solver choice is recorded with the A/B data.

### 3. Soft parts of machines
- Goal: Deformables solved monolithically with mechanisms, with material-derived parameters and visible clamps.
- Deliverables: FEM tets (stable Neo-Hookean), shells and cloth (membrane + hinge bending), Cosserat rods, all as block types in the same sweep. Soft tyres, belts, cables, gripper pads. Offset-bound self-contact for cloth and rods. Material database v1 with provenance and uncertainty. Requested-versus-achieved stiffness table and Reality Report HUD.
- Exit criteria: Structural T1 tests pass (cantilever within 3% refined with order at least 1, first mode and buckling within 5%, catenary within 1%). A soft-tyre car and a cable-driven gripper run on the phone at sustained 60 Hz within the web budget (about 250 FEM vertices). Every material in the demos shows its clamp in the report.

### 4. Matter
- Goal: Liquids and granulars on the GPU under the same functional, two-way coupled to mechanisms, inside the sustained thermal budget.
- Deliverables: Material points (liquid, Drucker-Prager sand, viscoplastic mud) on a moving 64^3 window with PB-MPM-style iterations. Frictional coupling to collider proxies, wrench readback with impedance term, coupling ledger. Low-cost screen-space fluid rendering. Thermal governor. OPFS snapshots and resume after a tab kill. Explicit capped-sound-speed MLS-MPM kept as a declared fallback.
- Exit criteria: A 20-minute on-device soak holds 60 Hz presentation (or the governor's declared 30 Hz mode) with at least 12k points x 4 passes. Matter T1/T2 tests pass in CI (hydrostatic within 3%, dam-break front within 10%, run-out exponent within 0.15, Archimedes within 5%, coupling defect at most 2%). An excavator arm digs sand and a paddle boat floats and moves. A forced tab kill resumes from the last snapshot.

### 5. Native iOS
- Goal: Remove the browser ceiling: both P-cores, Metal, haptics, real thermal state.
- Deliverables: Native host (Rust static library, wgpu on Metal, thin Swift shell). GitHub Actions macOS build and signing with fastlane and TestFlight delivery. Deterministic two-thread job system over the fixed colouring. ProcessInfo thermal governor, Core Haptics. Three-way kernel benchmark: Safari WebGPU, wgpu on Metal, hand-written Metal.
- Exit criteria: A TestFlight build on the user's iPhone runs the reference scene (300 primitives + 60 hulls + 2 x 30-DOF robots + 600 FEM vertices + 16k points) at 60 Hz with thermal state at or below 'fair' for 20 minutes and at most 11% battery drain; native and wasm32 state hashes are equal on all 20 determinism scenes.

### 6. Game-builder SDK and first game
- Goal: Make it possible to build a game the way one builds a robot, and prove it with one.
- Deliverables: Assembly format v1, Rust and TypeScript SDKs with unit types, strict mode and Director escape hatches, replay recorder and player, inspector with telemetry and budget meter, documentation with fidelity tiers per feature. A sample game built only through the public API (a workshop challenge: build and program a machine to do a task).
- Exit criteria: The sample game ships as PWA and TestFlight build with zero strict-mode violations. A recorded 5-minute session replays bit-exactly on web, native and CI. A second small demo is built from the documentation without any engine change.

### 7. Deeper reality
- Goal: Extend fidelity where the principle makes it cheap, each addition gated by a test.
- Deliverables: SDF tooth contact for real gears and threads; energy-criterion fracture (breakable welds, tearing); heat conduction, friction heating and motor thermal limits closing the energy ledger; modal impact sound; GPU block descent for large cloth; contact calibration against the cube-toss dataset.
- Exit criteria: Each feature lands with its test (1D conduction within 2%, Stefan melting front within 5%, cube toss at most 20% of cube width, real-tooth gear ratio within 0.5% over 100 revolutions). The published fidelity report covers every tier and every declared compromise.

## Risks
- AVBD-style block descent underperforms Soft Step on the CPU (stacking quality, friction, cost). No CPU or mobile AVBD numbers exist and every implementation is marked experimental; the 2x cost factor in the budget is an estimate. — Mitigation: Phase 2 A/B gate on the conformance suite with pre-agreed criteria. The solver interface is 'energy terms + block updates', so a Soft Step velocity sweep (a block Gauss-Seidel pass on the linearised potential) can replace the primal sweep for rigid contact without changing materials, API, ledger or tests.
- Momentum is conserved only at convergence, and the implicit part of the integrator dissipates energy; with one sweep per substep both errors are real. — Mitigation: Small substeps instead of many iterations, explicit symplectic predictor for resolved forces, warm-started duals, per-tick momentum-defect and numerical-loss accounts with CI gates, and a second-order (BDF2-style) predictor evaluated as an option in Phase 2.
- Stiffness ratios: VBD converges poorly at 1:10,000; steel-on-rubber mechanisms and gear trains sit at that edge. — Mitigation: Rigid idealisation for stiff matter, hard constraints through augmented Lagrangian, reduced-coordinate articulations with exact joints, 16-32 substeps for precision islands, and a published clamp table instead of silent softening.
- Matter tier: 3D convergence of PB-MPM-style iterations at 4 passes per frame is unproven, liquids will be visibly compressible, and A16 throughput (10-17k points) is a low-confidence scaling. — Mitigation: Phase 1 microbenchmark on the actual phone before any commitment; density error reported; explicit capped-sound-speed MLS-MPM as declared fallback; matter sized honestly at bucket-to-bathtub scale.
- Staggered CPU-GPU coupling lags by about a frame (asynchronous readback), which can destabilise light bodies in dense matter and leak momentum. — Mitigation: Linearised impedance term (added mass and drag) in the CPU potential, exchanged-impulse ledger with a 2% gate, floating-body heave test, and recorded wrenches so CPU replays stay bit-exact.
- Safari WebGPU fragility: stricter WGSL compiler, reported iOS crashes, tab kills near 2 GB, 30 fps in Low Power Mode, no threads without cross-origin isolation. — Mitigation: WebKit-dialect WGSL from day one, early and frequent on-device checks, about 1 GB budget, snapshot and resume, supported 30 Hz mode, and the native track in Phase 5.
- Thermals: sustained GPU output is 51-84% of peak and no published figure matches this workload; a combined CPU + GPU duty cycle may throttle sooner than planned. — Mitigation: All budgets at 60% of cool capacity, 20-minute soak as an exit criterion from Phase 1, a governor that only touches rendering and time dilation, sleeping for settled islands and liquid.
- Single precision at small substeps (the h^2 term) and large coordinates. — Mitigation: Solve for increments in island-local frames, accumulate world poses in f64 on the CPU, grid-relative positions on the GPU, and precision tests (1:1000 chain, far-from-origin scene) in CI.
- Scope: seven primitive types, a matter tier, an SDK and two hosts. Collision detection and authoring multiply even if the solver does not. — Mitigation: Strict phase gates with measurable exits; fixed cut order (SDF gear teeth, fracture, heat, GPU cloth, then shells) so mechanisms never slip; no feature without its test.
- No Mac and no attached device: native debugging is blind and the paid developer account is a dependency. — Mitigation: Bit-exact replay logs captured on the phone and reproduced in the Linux container, exported telemetry reports, CI-built TestFlight delivery, and a web build that remains fully functional if the native track is deferred.
- Non-convex contact for real gear teeth and threads is unproven on mobile. — Mitigation: Kinematic gear and screw pairs (ratio, backlash, mesh stiffness, efficiency) as the declared default; SDF tooth contact is Phase 7 research for small counts.
- Game-design risk: simulation-first games have struggled to find the game (two years of directions for Noita; straight-line solutions in Teardown). — Mitigation: Physical gating levers (energy, strength, torque limits), bedrock material, budget meter, replay and telemetry from the start, and a sample game in Phase 6 that tests the SDK against a real design.

## Non-goals
- Atomistic, quantum, relativistic or electromagnetic-field (Maxwell) simulation; lumped circuits and motors only.
- Compressible flow, shocks, resolved turbulence or real water Reynolds numbers; fine splash detail is declared lower fidelity.
- Open water or large terrain volumes of simulated matter: liquids and granulars are bucket-to-bathtub scale (about 16-128 L) inside a 1.3-2.6 m window.
- Full IPC with intersection-free guarantees; barriers are used only for thin-body self-contact.
- Time-resolved elastic waves in metals or true water compressibility; stiff matter is rigid and the clamp is reported.
- Bit-exact determinism of GPU matter, and rollback netcode or multiplayer in v1.
- Photoreal rendering or ray tracing; the renderer is a thin client of the simulation.
- A general-purpose game engine: no scene editor, animation system, UI toolkit or asset pipeline beyond the assembly format.
- Scripted animation, kinematic character controllers or per-object special cases that bypass physics, outside the logged Director escape hatches.
- Android, desktop or console as product targets (x86-64 and WASM builds exist for CI only), and iPhones older than the base iPhone 15 as a performance target.
- Any change to the user's existing PWA repository.

## Decisions for the user
- 3D is assumed. Confirm, or choose 2D: the same budget carries about 6-7x more bodies in 2D (Box2D 1.36 ms versus Box3D 9.1 ms for 5,050 bodies), at the cost of the 'robot on reality' feel.
- Apple Developer Program (US$99 per year): needed for the native TestFlight track in Phase 5. Without it the engine stays a Safari web app with about 40% of the CPU capacity, no haptics and browser memory limits. Decide yes, no, or defer until Phase 4 results.
- Where the engine lives: a new repository is recommended, leaving the existing PWA untouched. Public gives free macOS CI and free GitHub Pages but makes the code visible; private costs about US$0.062 per macOS CI minute and may need a paid plan for Pages (from memory).
- Licence and openness, if public: open-source licence choice, or keep source closed.
- What you most want to build first (vehicles, walking or arm robots, contraptions, digging and water machines). This sets the reference scene and whether Phase 4 (liquids and sand) should come before Phase 3 (soft parts).
- How strictly the reality rule binds games: strict mode on by default with logged escape hatches (recommended), or permissive by default.
- Behaviour when the phone runs hot: drop to 30 Hz display first (recommended), or slow motion first.
- Whether replays alone are enough or you eventually want multiplayer or rollback; this changes determinism requirements for the GPU matter tier.
- Your part in testing: confirm the phone is on iOS 26 or later, and that you are willing to run a 10-20 minute soak test per phase and paste the report back, since no one else has the device.

## Red-team review — feasibility lens

Scores (0-10): realism 5, feasibility_on_a16 3.5, first_principles_integrity 6.5, game_buildability 5.5, delivery_safety 4

**Verdict.** Not shippable as budgeted. The delivery path for a first web demo is real and the reporting discipline is the best part of the design, but the frame budget is about 2x over the phone's sustainable power envelope, the matter tier's cost model ignores the grid that dominates it, and several Phase 4 and Phase 5 exit criteria contradict the plan's own declared limits. The central solver bet is unmeasured and gated too late. If this design is kept, it needs a days-long Phase 0 on the real phone (probe, microbenchmarks, synthetic-load thermal soak), the solver A/B run on desktop before anything is built on it, budgets re-derived from watts at roughly half the stated scene, and a governor that can shed simulated load. On those terms the mechanisms tier at a few hundred bodies is credible; the 16k-point matter tier alongside it at 60 Hz for 20 minutes is not yet.

### Fatal flaws
- The frame budget is sized so the frame still fits when the GPU is throttled to 60%, not sized to the sustainable power envelope. The combined duty cycle is roughly 1.3-1.9x over what the research says an A16 phone can hold, so the reference scene, the 'about 4 W' figure, the 11% per 20 minutes drain and the 'thermal state at or below fair for 20 minutes' exits cannot all be true. The budget and the governor both have to change: budget from watts, and allow the governor to shed simulated load. — Evidence: Research numbers: A16 GPU averages 7 W at full load (GFXBench Aztec); sustainable whole-device draw is about 4.3 W (30-minute Genshin run); idle with display is 0.94 W. The plan runs the GPU 10 of 16.67 ms (60% duty, about 3-4.2 W) plus up to 16 P-core-ms per frame (2 x 4 ms physics + 8 ms main thread, about one P-core, roughly 2-3 W) plus display: about 5.5-8 W (my derivation, low confidence on the exact split). A 4.3 W envelope leaves roughly 5-6 ms of GPU and about 5 P-core-ms per frame, about half the plan. The governor's first two steps only cut rendering (30 Hz presentation removes about 27% of GPU time and 0% of physics), so the steady state is 0.5x time dilation, i.e. slow motion. On the web tier the design-point state (thermal mitigation) is exactly when WebKit halves requestAnimationFrame to 30 fps.
- The plan's identity (one AVBD-lineage block-descent solver for everything, on CPU, one sweep per substep) rests on a solver with no CPU or mobile measurement, against the research's explicit recommendation (Soft Step baseline, AVBD as a time-boxed R&D track). The decision gate is in Phase 2, after the Phase 1 solver, joints, friction and ledger are built on it, and the stated fallback (a Soft Step velocity sweep for rigid contact) reintroduces the rigid/deformable solver seam the thesis exists to remove, which forces a redesign of Phase 3. — Evidence: Research: every AVBD implementation is marked experimental, with no CCD, sleeping or bitwise determinism, and no published CPU timing; VBD converges poorly at 1:10,000 stiffness ratios; Catto reports artefacts from deriving velocity from positions. I read the authors' own 3D demo source: it defaults to 10 iterations per 1/60 s step, single precision, no substepping, velocities by BDF1 from positions, so the plan's 4-8 single-sweep substeps is an unpublished operating point (4 sweeps per frame for piles is under half the authors' default). The '2x a Soft Step sweep' cost is an unsupported estimate; my operation count puts 2x as the floor before SIMD losses.

### Fixable flaws
- The first on-device milestone bundles delivery proof, device measurement and a full solver v0 (joints, friction, islands, sleeping, ledger, touch hand, 12 tests, hash CI) into one gate, so the cheapest and most decision-relevant data arrives last. — Fix: Add a Phase 0 measured in days: probe page, one WGSL compute smoke test, block-solve and P2G microbenchmarks, and a 20-minute synthetic-load soak that burns exactly the planned duty cycle (for example 4.5 ms GPU compute + 5.5 ms render + 4 ms CPU) to test the power budget before any solver exists.
- The AVBD versus Soft Step A/B gate is in Phase 2 and its 'pre-agreed criteria' are not stated; 'the solver choice is recorded' is not a pass/fail exit. — Fix: Run the A/B natively on x86 in the container in the first two weeks (no phone needed) with written thresholds: cost per body-substep with SIMD, 10-box stack drift, sliding-cube dissipated energy, 1:1000 chain stretch, momentum defect. Build articulations and deformables only on the winner.
- The matter tier is budgeted in particle-passes, but with a dense 64^3 window and gather P2G the cost is dominated by grid cells: 262,144 cells against about 2,000 occupied at 16k points, and about 7.1M neighbour-cell probes per pass against 432k particle-node pairs. — Fix: Use an active-block list (occupancy mask over 8^3 blocks) or a tight moving AABB of 32^3-48^3, 16-byte fixed-point cells, and budget cell-passes and particle-passes separately. Measure both, plus per-dispatch overhead for the roughly 30-40 compute dispatches per frame, in the Phase 0 microbenchmark.
- Phase 4 exit tolerances contradict the plan's own declared softening: hydrostatic within 3%, density error at most 5% at 0.5 m and dam-break front within 10% are not reachable at a 23 kPa effective modulus and 4 passes, so Phase 4 cannot exit as written. — Fix: Either restate the tests inside the resolvable regime (depth of 0.1-0.15 m at dx 2 cm, dam height of about 0.1 m, tolerance tied to the reported Mach number) or add and price a warm-started volume/pressure constraint solve for liquids, and gate it on a measured density error.
- The thermal governor may not touch any simulated quantity, and several exits allow 'or the governor's declared 30 Hz mode', which makes the 60 Hz criteria unfalsifiable. The web tier also has no thermalState API, only frame-rate halving after the fact. — Fix: Add declared, logged load shedding of simulated amount (matter window and point count through demotion and sleeping, awake-bubble radius) ahead of time dilation. Write exits as 'sim-time ratio 1.0 and at least 95% of frames at 60 Hz, zero dilation events', with a fixed soak protocol (Low Power Mode off, stated brightness, no case, unplugged, ambient noted).
- GPU kernels would be developed blind. I checked this container: no /dev/dri, no Vulkan ICD, no lavapipe installed, and a GitHub release download returned 403 through the proxy. WebKit's WGSL compiler cannot run on Linux at all, and with no Mac there is no Web Inspector, so every Safari-only shader failure costs a push, a Pages deploy and a human round trip. — Fix: Phase 0 tasks: get WGSL executing in the container (software Vulkan from apt, or headless Chromium with a software WebGPU adapter), add a macOS runner job that loads the page in Safari through safaridriver (unverified that the runner exposes WebGPU), and ship an on-page diagnostics overlay that captures compilation info, error scopes and uncaught errors into the copyable report.
- The on-device instruments are too coarse for the gates. WebKit's performance.now() defaults to 1 ms resolution (confirmed in Performance.cpp); GitHub Pages cannot be cross-origin isolated without the service-worker shim; GPU timestamps are 'if exposed'. A 4 ms p95 gate therefore carries about 25% instrument error and the 4.5 ms GPU budget is unobservable. — Fix: Adopt the isolation shim (or a host that sets COOP/COEP headers) from Phase 0 for high-resolution timers, time batches of N ticks rather than single ticks, infer GPU cost from load-ramp tests to the frame-miss point, and print a build hash in the HUD and every report so stale cached builds are detectable.
- Single precision is defended only for the increments. Constraint residuals need absolute island-local positions, and at the stiffness clamp one rounding step of position is a non-trivial force, worst in the 16-32 substep precision islands where it matters most. Mueller 2020 and Macklin 2019 both state small steps need double precision. — Fix: Evaluate constraint residuals in f64 or in contact-local relative coordinates, price precision islands at 1.5-2x for the lost SIMD width, and put a far-from-origin resting-jitter and slow-creep test in the Phase 1 desktop suite before the fp32 decision is frozen.
- Per-island substep classes (4, 8, 16-32) create a runtime cost cliff and a stiffness jump. A 32-substep mechanism touching a 4-substep pile forces the merged island to 32 substeps (8x the pile's cost), and because the clamp is a fraction of the substep rate the pile's contact stiffness changes by up to 64x. The budget meter cannot price this statically. — Fix: Tie the stiffness clamp to one global reference rate so materials do not change with what they touch, cap the size of precision islands, and have the budget meter price the worst-case merge.
- Toolchain and hosting set-up is not in the Phase 1 deliverables. In this container rustc 1.97 stable, cargo and Node 22 are present and crates.io, npm and static.rust-lang.org are reachable, but the wasm32 target, wasm-bindgen, wasm-opt and wasmtime are missing, the container is ephemeral, and prebuilt GitHub release binaries appear blocked. WASM threads in Rust also need nightly, which contradicts 'stable toolchain'. A new repository, its Pages enablement and session push access are user-side steps. — Fix: Make an environment setup script and a pinned tool list the first deliverable (cargo-built wasm-bindgen, Node as the WASM test runner instead of wasmtime), state that the web tier is single-threaded for good unless nightly is accepted, and list the user's one-time steps. The existing repository's workflow at /home/user/pulsevault/.github/workflows/pages.yml shows an Actions-based Pages deploy pattern that can be copied.
- A project site in a new repository under the same account shares the github.io origin with the user's existing PWA: OPFS, IndexedDB, storage quota and the persistence grant are origin-wide, so engine snapshots and any 'clear website data' debugging step can collide with or wipe the existing app's local data in Safari. — Fix: Namespace all storage under an engine-specific directory and database name, never instruct origin-wide data clearing, test through a Home Screen install (separate storage container), or host the engine on its own origin, which would also allow real COOP/COEP headers.
- The roadmap has measurable exits but no durations, effort budgets or kill criteria, and some exits test the wrong thing: Phase 2 requires writing a pick-and-stack manipulation controller, and Phase 5 depends on Apple steps that are manual (programme enrolment delay, app record creation in App Store Connect, signing secrets) with a 30-60 minute blind build-and-TestFlight loop. — Fix: Time-box each phase with an explicit re-plan trigger, replace the cube-stacking exit with an engine-only grasp-hold test (slip under 1 mm for 10 s at a stated grip force), move the Developer Program decision to the end of Phase 2, and have the user place signing keys directly into repository secrets, never in chat.

### Numbers challenged
- About 4 W device draw with GPU at most 10 ms, CPU physics 4 ms on 2 P-cores and main thread under 8 ms; about 11% battery per 20 minutes. → About 5.5-8 W for that duty cycle, i.e. 14-20% battery per 20 minutes and a thermal state above 'fair' well inside the soak. A 4.3 W envelope supports roughly 5-6 ms GPU total and about 5 P-core-ms per frame. (basis: Research figures: 7 W average A16 GPU at full load, 0.94 W idle with display, 4.32 W sustained in a 30-minute game run, 12.98 Wh battery. Linear duty scaling with a credit for running at a lower frequency; my derivation, low confidence on the exact split.)
- An AVBD 6x6 block sweep costs 2x a Soft Step sweep, giving about 1,100 stacked boxes native at 8 substeps and about 400 on the web. → Plan on 2.5-4x: about 550-900 boxes native and about 130-300 on the single WASM thread, until the A/B measures it. (basis: My operation count for a stacked box: about 5,800 flops per AVBD body sweep (16 contact-point visits with 6x6 outer products, LDLT, dual update) against about 2,850 for Soft Step solve plus relax, which matches Box3D's measured 0.315 microseconds. The remainder is SIMD loss from variable-length per-body lists (Box2D data puts SIMD at 1.56-3.5x) and no FMA.)
- The invariant is particle-passes per frame; 16k points x 4 passes on a dense 64^3 grid fits 4.5 ms. → Grid traffic dominates: 8.4 MB of grid touched for clear, gather and update gives about 40-70 MB per pass, 160-280 MB per frame, 10-17 GB/s at 60 Hz, which alone can exceed the 4.5 ms budget by about 1.5-2.5x. (basis: 64^3 x 32 B = 8.4 MB; 262,144 cells x 27 neighbour probes per gather pass; LPDDR5 theoretical 51.2 GB/s shared with CPU, display and renderer, assumed about half usable by GPU compute (my assumption).)
- Scaling the one measured iPhone MLS-MPM app gives 16k points sustained natively (12k on web) at 4 passes. → The transfer is not valid as stated: 16k is the top of the research's 10-17k range, the source's substeps per frame are not published, and its grid is roughly 10-20x smaller than 64^3. Plan 6-8k points x 4 passes or 12-16k x 2 until measured. (basis: I read the PhoneFluid README: no substep count, no per-frame milliseconds, no A16 figures. 43k particles at 40% fill and 2.1 mm cells implies about 13-27k cells at 4-8 points per cell (my inference). Combined with the power correction above.)
- Hydrostatic pressure within 3% and density error at most 5% at 0.5 m depth. → At the plan's own 23 kPa ceiling the compression at 0.5 m is about 21%. Reaching 5% needs about 98 kPa, i.e. a 9.9 m/s wave speed: more than 8 explicit substeps at dx 2 cm, or dx 4 cm at 4 substeps with zero CFL margin. (basis: rho x g x h = 1000 x 9.81 x 0.5 = 4.9 kPa; 4.9/23 = 21%; c = sqrt(K/rho); the 23 kPa ceiling is the research's derived figure for dx 2 cm and 4 substeps.)
- Martin and Moyce dam-break front within 10%; advection limit 3.6 m/s at 3 cm with 2 substeps. → A 0.3-0.5 m dam has a front speed of about 3.4-4.4 m/s against a numerical sound speed near 4.8 m/s: Mach 0.7-0.9 where the weakly compressible rule needs under 0.1, and at or above the advection limit. Water falling 0.66 m already reaches 3.6 m/s. (basis: Front speed about 2 x sqrt(g x H); free-fall speed sqrt(2 x g x h); the Mach under 0.1 rule is in the research.)
- 0.6 microseconds per FEM vertex-sweep (22 tets x 25 ns); 600 FEM vertices at 4 sweeps native, about 250 on the web. → Expect 1.2-2.3 microseconds, and monolithic coupling means the island's 8 (or 16-32) substeps, not 4: about 150-300 vertices native and 60-125 on the web. Four tyres from 250 vertices are about 60 each, a 12-sided wheel with 3.4% radial run-out. (basis: 25 ns is about 86 cycles at 3.46 GHz for a stable Neo-Hookean gradient plus 3x3 Hessian block of roughly 300-400 flops, which needs more than 4 flops per cycle without FMA (my estimate). 1 - cos(15 degrees) = 3.4%.)
- Unknowns are increments, so fp32 keeps full relative precision at small h. → True for increments, not for constraint residuals: one position rounding step at 4-8 m from the island origin is 0.48 micrometres, which at the stiffness clamp is about 0.27 m/s^2 of force noise per unit mass (3% of g) at 8 substeps and about 4.3 m/s^2 (44% of g) at 32 substeps. (basis: k = m x (2 x pi x f)^2 with f = 120 Hz and 480 Hz; float32 spacing of 2^-21 m in the 4-8 m binade; my derivation, order of magnitude.)
- Phase 1 exit: 150 bodies at p95 physics time of at most 4 ms on the phone. → The estimate is 1.2 ms only if AVBD is 2x, WASM costs 1.4x and the v0 solver already has tuned SIMD. With 2.5-4x, 1.4-2x and no SIMD the range is about 2-11 ms, and the measurement itself is quantised to 1 ms. (basis: 150 x (0.54 + 8 x 0.315 x factor) microseconds x WASM penalty x 2-3.5 for a non-SIMD build (Box2D float versus NEON data); WebKit default timer precision of 1 ms.)
- Two P-cores scale 1.85x for physics, as on the M2 Air. → Expect about 1.3-1.6x on the phone, since the main thread, render submission and the browser or GPU process share the same two P-cores during the 4 ms physics window. (basis: The M2 benchmark ran on a machine with four P-cores and no competing render load; the A16 has two. My estimate, to be measured natively.)
- Reference scene costs 3.4 ms, including 2 robots at 0.24 ms each. → That prices everything at 8 substeps. A geared robot flagged as a precision island at 32 substeps costs about 0.96 ms each, and any pile it touches inherits 32 substeps. With the corrections above the scene is about 1.7x over 4 ms before the power halving, so a sustainable native scene is roughly one third of the stated one. (basis: Rigid 1.4 ms x 1.5 + deformables 0.8 ms x 4 + robots 0.3-0.6 ms + collision 0.5 ms + overhead 0.4 ms is about 6.5-6.8 ms (my recomputation from the plan's own line items).)
- 30 Hz presentation is an effective second governor step. → It saves only rendering: 5.5 ms x 30 fewer frames is 165 ms of 600 ms of GPU time per second (27%), and no physics or matter compute at all. (basis: The fixed 60 Hz tick still runs 60 matter and solver steps per second; arithmetic on the plan's own GPU split.)

### Best ideas to keep
- Web-first delivery with a capability probe and on-device microbenchmarks that replace every estimate. The container check supports it: Rust 1.97 stable and Node 22 are installed and crates.io, npm and the Rust distribution host are reachable, so a wasm32 static site is buildable from here.
- CPU-authoritative, bit-deterministic core with WASM as the determinism reference, so a replay log captured on the phone reproduces in the Linux container. With no Mac and no attached device, this is the only realistic debugger.
- The Reality Report: energy ledger with a 'numerical' account, momentum defect, and a requested-versus-achieved stiffness table per material pair. It turns unavoidable compromises into measured, visible quantities.
- A budget meter and CI performance gates expressed in deterministic operation counters (block solves, contact rows, particle-passes, and it should add cell-passes), which work without a phone and survive hardware changes.
- Sensors-and-actuators as the only write path in strict mode, with a logged and counted Director API for the non-physical escape hatches, and physical gating levers (battery energy, torque and current limits, material strength).
- Twenty-minute thermal soak as a phase exit criterion from the start, settled islands and settled liquid always sleeping, and snapshot plus resume-after-tab-kill treated as a core feature.
- Honest scale declarations: bucket-to-bathtub matter, stiff matter rigid with the clamp reported, kinematic gear pairs as the default with real tooth contact deferred, and a fixed cut order so mechanisms never slip.
- A solver interface defined as 'energy terms plus block updates' with an A/B harness, which keeps materials, API, ledger and tests intact whichever solver wins. Keep the harness; move it to the front.

## Red-team review — physics lens

Scores (0-10): realism 4.5, feasibility_on_a16 5, first_principles_integrity 4, game_buildability 5, delivery_safety 4

**Verdict.** The honesty machinery (Reality Report, clamp table, tiers, strict mode) and the actuator-sensor-controller API are the best parts and should survive whichever design wins. The physics core does not hold up as written. Backward Euler loses angular momentum and stored elastic energy at rates that make spinning assemblies, soft tyres, springs and bounces visibly wrong at 480 Hz, and the charter's Noether claim is false. One vertex-block sweep per substep also breaks action-reaction by tens of percent in impacts, and the validation suite as specified would catch neither the spin-down nor the launch loss. I expect the plan's own A/B gate to choose Soft Step for rigid contact, which turns the single-solver thesis into the two-tier design the research recommended, after Phase 1 has been spent on the losing solver. For a game builder, only the robot arm is fully served: the vehicle is rigid-wheel or toy-scale, the bridge cannot break until Phase 7, the boat is a toy in a tub, and fire does not exist. The delivery path and budgets are sensible; keep them, change the time discretisation, make rigid contact pairwise, and run the A/B in Phase 1. Both toy checks are in /tmp/claude-0/-home-user-pulsevault/a416cf0e-c7c2-56a3-935d-f4967a8e2aae/scratchpad/chk/be_checks.py and /tmp/claude-0/-home-user-pulsevault/a416cf0e-c7c2-56a3-935d-f4967a8e2aae/scratchpad/chk/ramp.py; they are simplified 1D and 2D reproductions, not an AVBD implementation.

### Fatal flaws
- The charter's one hard-coded law is backward Euler, which does not conserve angular momentum even at full convergence, so the Noether claim is false. It also dissipates stored elastic energy at first order. The time discretisation must change (second-order or variational for resolved conservative terms, or velocity-level constraint impulses); the block solver can stay. — Evidence: Derivation: a mass held on a circle by any internal force obeys phi -> phi(1 - phi^2) per substep, giving omega(t) = omega0 / sqrt(1 + 2*omega0^2*h*t). I confirmed this numerically with a fully converged solve at 480 Hz: 16% of angular momentum is lost in 1 s at 10 rad/s, 54% at 30 rad/s and 85% at 100 rad/s, identical for 5, 20 and 120 Hz springs and for a hard constraint; at 1920 Hz the losses are still 5%, 28% and 70%. This hits welded or jointed maximal-coordinate parts with offset centres of mass, loop closures, FEM tyres, belts on pulleys and cloth; single rigid blocks and reduced-coordinate tree joints are exempt. The research already said so (MuJoCo: implicit treatment damps tumbling at about (h*omega)^2 per step; rigor notes: keep the conservative part symplectic). Script: /tmp/claude-0/-home-user-pulsevault/a416cf0e-c7c2-56a3-935d-f4967a8e2aae/scratchpad/chk/be_checks.py
- One vertex-block Gauss-Seidel sweep per substep breaks action-reaction between interacting bodies, and the defect is solver-order dependent. The plan's own momentum gate (1e-3 of exchanged impulse) is unreachable at the budgeted sweep count. The remedy is pairwise impulse (dual) updates for rigid contact and joints, which is the Soft Step fallback, so the 'one solver' thesis is the part most likely to die. — Evidence: Body A is solved against B's stale position and B against A's new one, so the penalty forces differ by kappa/(1+kappa) with kappa = k*h^2/m = (omega_c*h)^2 = 2.47 at the declared clamp. A 1D two-body toy with stiffness at the clamp gave a defect of 71% of the exchanged impulse at 1 sweep, 6-21% at 2-4 sweeps and about 0.3% at 10 sweeps; two equal boxes meeting head-on drift off together. For a 1:10 mass pair in the unfavourable order the heavy body received 3.5x the light body's impulse. An AVBD-style penalty ramp cut the defect to 1-26% but only by trading it against 4-16 mm of penetration set by tuned parameters. The contact research recommended Soft Step as baseline and AVBD as time-boxed R&D; the plan inverts that with no new evidence. Script: /tmp/claude-0/-home-user-pulsevault/a416cf0e-c7c2-56a3-935d-f4967a8e2aae/scratchpad/chk/ramp.py

### Fixable flaws
- The validation plan tests conservation only at benign operating points: one pendulum of about 1 m at about 25 degrees, a single rigid body for Dzhanibekov, and isolated free bodies. It would not catch the spin-down or the launch-energy loss. — Fix: Add torque-free spinning tests (welded dumbbell, hinged pair, FEM wheel, belt drive) at 10, 30 and 100 rad/s gating angular momentum and kinetic energy. Add spring-launch efficiency at 5-50 Hz, a head-on equal-mass impact and Newton's cradle. Run every test at the shipped substep and sweep budget with sleeping disabled.
- Energy-ledger closure at 1e-4 is vacuous if the 'numerical' account is the residual, and nothing caps how large that account may be. — Fix: Compute the numerical account independently (for backward Euler, half the mass-weighted velocity jump squared plus half the stiffness-weighted position increment squared). Gate numerical loss as a maximum fraction of physical dissipation in every reference scene.
- Restitution cannot emerge from Hunt-Crossley under this integrator, so balls, cradles and springboards are numerically dead and the MFIX DEM02 bounce test cannot pass. — Fix: Add a declared Tier 2 velocity-level restitution closure e(v) per material pair from measured data, or integrate resolvable contact springs with an energy-consistent rule. Reserve Hunt-Crossley for contacts whose frequency is far below the substep rate.
- The stiffness clamp and substep count are per island, so physics depends on contact-graph membership: the same pad is 64x stiffer in a 32-substep island than in a 4-substep one, and numerical damping changes with it. — Fix: Fix one substep rate and one clamp per world, declared by the game. Buy precision with extra sweeps only, and add a substep-invariance test (4, 8 and 16 substeps must agree within tolerance).
- AVBD's stabilisation alpha, penalty ramp beta, warm-start decay gamma and post-stabilisation pass are tuned non-physical parameters, and they are missing from the declared compromises. The authors' demo uses alpha 0.99, beta 1e5 (its own comment says the paper suggests 1-1000), gamma 0.99, 10 iterations plus a post-stabilisation pass at 60 Hz, and has no restitution. — Fix: List them as declared compromises with sensitivity tests (results within tolerance across their ranges), or use fixed material-derived stiffness and pay in sweeps. Budget the post-stabilisation pass explicitly.
- Separate static and kinetic friction coefficients make the dissipation potential non-convex, contradicting 'every D is convex', and the normal force is lagged by a substep. — Fix: Declare friction a non-variational Tier 2 closure. Refresh the normal force inside the sweep, and add stick-slip and friction-limit-under-transient-load tests.
- No tests for tunnelling, gear slip under load or joint drift under load, and CCD exists only against statics. 'Gear ratio exact' holds only if the gear is eliminated as a coordinate coupling inside one articulation block. — Fix: Add bullet tests (1 cm part at 50 m/s against thin dynamic plates and cloth), a loaded gear train over 1,000 revolutions (ratio, backlash, efficiency) and loaded-joint separation limits. Add opt-in dynamic CCD and state the speed envelope as thickness divided by substep.
- Bridge: 'stiffer than the clamp is rigid' is decided by material modulus, so structures become rigid bodies with hard welds whose redundant load paths are set by solver order. Finite-strength welds are in the API but fracture is Phase 7 and first on the cut list. — Fix: Decide rigidity by structural mode frequency: a 1 m steel bar of 1 cm^2 carrying 100 kg sits near 71 Hz, which is resolvable. Give members derived lumped compliance (EA/L, EI) through rods and shells, move breakable welds to Phase 2-3, and test a redundant truss against the stiffness method.
- Vehicle: there is no enclosed-gas energy term, so a tyre cannot be pneumatic. FEM tyres in the inertial frame suffer the rotational spin-down, and rigid wheels with Coulomb friction have no slip curve. A differential needs a three-shaft constraint that the gear pair does not provide. — Fix: Add a pressure-volume (ideal gas) energy term as a primitive. Solve tyre and belt deformation in the rim's co-rotating frame, add a declared brush-tyre closure for rigid wheels, and add three-shaft gear constraints.
- Boat: the charter forbids any buoyancy formula while the matter tier holds 16-128 L, so a boat is a toy in a tub and cannot travel. — Fix: Add a Tier 1 analytic hydrostatic reservoir: integrate rho*g*z over the wetted hull against a height-field free surface (this is Archimedes, not a fudge), with wave-making and drag declared Tier 3. Embed the particle window in it for near-field detail.
- Fire is absent from all seven phases: no gas phase, no combustion, no smoke, and heat conduction only in Phase 7. — Fix: Either declare fire a non-goal or add a Tier 3 slice. That slice is solid heat conduction pulled forward (explicit and cheap), one-step pyrolysis with measured ignition temperature and heat of combustion, and a coarse Boussinesq gas grid sharing the GPU matter budget, with mass and energy booked in the ledger.
- CPU-GPU coupling lags one frame, which acts as negative damping of about omega*tau/2 (0.075 for a 0.7 s heave). The impedance term is a stabiliser with no reaction on the fluid, and a 2% per-exchange gate allows secular drift. — Fix: Derive the impedance from GPU-measured displaced mass and reconcile predicted against actual impulses so the net is zero. Gate cumulative drift (a floating body at rest for 60 s) and consider same-frame readback for small windows.
- API: 'mass and inertia never authored' conflicts with MJCF import and with real parts (hollow shells, internal motors). The controller-only write path makes every game designer a controls engineer, there is no character path, and the SDK arrives in Phase 6. — Fix: Accept measured mass properties with provenance and consistency checks. Ship a controller library (joint servo, wheel speed, inverse kinematics, balance) as ordinary strict-mode code, and expose a usable SDK from Phase 2.
- The A/B gate sits in Phase 2, after the v0 solver and articulations are built on AVBD, and its pass criteria are not stated. — Fix: Move it to Phase 1 with criteria fixed in advance (momentum, angular momentum, cost per body, stack drift). Box3D has an Emscripten build, so run it on the phone as the measured Soft Step baseline instead of writing a second solver.
- FEM fidelity at phone resolution: linear tets lock in bending and near incompressibility, and under-converged sweeps soften global modes. Matter tests can pass at CI resolution while the shipped configuration was never validated. — Fix: Use rods and shells for slender parts and a locking fix (F-bar, mixed or quadratic elements) for rubber. Require every structural and matter test to run at the shipped resolution, particle count and pass count with its own published band.

### Numbers challenged
- Pendulum energy loss at most 0.5%/s at 480 Hz (estimate 0.3%/s from 0.75(theta-dot*h)^2 per substep). → The formula is a cycle average and 0.3%/s needs peak angular speed near 1.4 rad/s (a 1 m pendulum at about 25 degrees). Loss scales as 0.75*theta-dot-max^2*h per second: a 25 cm pendulum at 60 degrees loses about 6%/s, and continuous rotation at 10 rad/s loses 29% of its kinetic energy in the first second. (basis: Derivation of the projection map plus numeric check at 480 Hz.)
- Momentum defect of interacting islands at most 1e-3 of exchanged impulse per tick, with one sweep per substep. → About 71% at clamp stiffness with 1 sweep, 6-21% at 2-4 sweeps, about 0.3% at 10 sweeps. Meeting 1e-3 in one sweep needs kappa below 1e-3, a contact frequency under about 2.4 Hz at 480 Hz. (basis: Defect = kappa/(1+kappa), kappa = (omega_c*h)^2 = 2.47; 1D two-body toy.)
- An AVBD 6x6 block sweep costs 2x a Soft Step sweep, giving about 1,100 stacked boxes native and about 400 on web. → Unsupported; plan on 3-6x, which gives roughly 400-780 boxes native and 150-300 on web. If conservation needs about 10 sweeps per substep the count falls by a further order of magnitude. (basis: Each row is assembled twice into a dense 6x6 with ragged per-body row counts that defeat 4-wide SIMD; I recomputed the plan's own cost model with factors 3 and 6.)
- Hunt-Crossley contact dissipation replaces a restitution constant. → A contact spring with zero physical damping returns a coefficient of restitution of about 0.05 at the clamp frequency, 0.51 at 30 Hz and 0.80 at 10 Hz (480 Hz substeps). Raising the substep rate does not help because the clamp scales with it. (basis: Backward Euler keeps 1/(1+(omega*h)^2) = 29% of modal energy per substep at omega*h = pi/2; numeric check.)
- Springs and stored elastic energy are first-principles terms in Psi. → A spring launch delivers 90%, 79%, 60% and 33% of its stored energy at 5, 10, 20 and 50 Hz (480 Hz), about 2% lost per Hz. Catapults, bows and pogo mechanisms are off by tens of percent. (basis: Loss over a quarter period is (pi/2)*omega*h; numeric check.)
- Liquid density error at most 5% at 0.5 m depth, with the P-wave modulus topping out near 23 kPa. → rho*g*h/K = 4.9 kPa / 23 kPa, about 21%. Reaching 5% needs K of at least 98 kPa (sound speed about 9.9 m/s), which is 9 or more explicit substeps at dx 2 cm against 4 budgeted passes. (basis: The plan's own modulus and the hydrostatic relation.)
- 600 FEM vertices (about 2,500 tets) at 4 sweeps natively, 250 on web; soft tyres from measured E. → The default is 8 substeps in the same sweep, so 300 vertices native and about 125 on web. At 2 cm elements a 120 Hz clamp caps E near 60 kPa, about 80x softer than tyre rubber at 5 MPa. (basis: Highest element frequency is about 2c/dx with c = sqrt(E/rho) and rho = 1,100 kg/m^3 (my assumption that the clamp applies to element modes).)
- Rolling and torsional resistance scaled by the computed contact-patch radius. → If the radius comes from the clamped modulus it is 27-126x too large. It must be computed analytically from the real moduli, independent of the numerical clamp. (basis: Hertz: a scales as E^(-1/3); 2e11 Pa clamped to 1e7-1e5 Pa.)
- Archimedes draft within 5% at dx 2-4 cm. → Grid-distance contact offsets the hull by about half a cell (1-2 cm), so 5% needs a draft of at least 10 cells (20-40 cm). That does not fit in 16-128 L; the test passes only at CI resolution. (basis: Research note that MPM contact acts at grid-cell distance, plus geometry.)
- Supported range: parts down to 1 cm at speeds up to 50 m/s. → At 480 Hz a body travels 10.4 cm per substep and CCD covers statics only, so dynamic-dynamic tunnelling is possible for anything thinner than about 10 cm. Offset-bound cloth contact is valid only up to radius/h (2.4 m/s for an assumed 5 mm radius). (basis: Arithmetic on the plan's own substep rate.)

### Best ideas to keep
- The Reality Report: an always-available HUD and JSON with the energy ledger, momentum defect, requested-versus-achieved stiffness table, density error, coupling defect and a count of non-physical Director actions.
- Strict mode with a logged Director escape hatch, where spawned mass and energy are booked as external and prescribed-motion bodies report their power draw.
- The machine-shop API: materials with provenance and uncertainty, a material-pair table, parts, assemblies, actuators, sensors and fixed-rate controllers, with battery energy, torque limits and material strength as the designer's gating levers.
- DC motor physics done properly: K_t = K_e, back-EMF as a Rayleigh dissipation term K^2/R, reflected rotor inertia N^2*I, and battery internal resistance through nodal circuit analysis.
- Reduced-coordinate articulations with exact tree joints as first-class bodies. They are also exempt from the backward-Euler spin-down, which is a second reason to route every revolving mechanism through them.
- Bit-deterministic CPU core with WASM as the reference, so a replay captured on the phone (including recorded GPU wrenches) reproduces in the Linux container in place of an attached debugger.
- A thermal governor that only touches rendering, presentation rate and logged time dilation, never dt, substeps or iterations, with every workload sized to 60% of cool capacity.
- Phase 1 as a capability probe and microbenchmark on the user's actual phone, with the measured numbers replacing the estimates before anything is committed.
- A budget meter that prices an assembly in block solves, contact rows and particle-passes before it runs, and performance CI gated on those deterministic counters.
- Fidelity tier tags on every feature, phone-resolution error published beside refined error, and the cube-toss dataset kept as an honesty metric.
- An explicit A/B gate against Soft Step behind an 'energy terms plus block updates' interface. Keep the gate; move it earlier.
- Attached deformables solved on the CPU in the same loop as their mechanism, with bulk matter on the GPU behind a recorded coupling interface.

---

# Materia: continuum-first reality engine (one matter model, two kinematic closures) (stance: continuum-first)

**Thesis.** Everything in the world is material points carrying mass, a measured SI material record and thermodynamic state. One GPU particle-grid solver (3D MLS-MPM/APIC with implicit real-bulk-modulus pressure, plasticity, regularised damage and heat) moves all matter that can flow, pile, squash, tear or melt. Buoyancy, pouring, digging, erosion, melting and breaking then emerge with no special cases, which is exactly what conventional engines script.

Matter that is too stiff or too thin for a centimetre-scale grid is not handed to different physics. It is the same material points under a kinematic restriction (rigid or affine clusters), integrated by a small deterministic CPU constraint solver. It is promoted back to free particles, with mass, momentum and energy booked, when it breaks, melts or is cut.

That dedicated solver exists only where the research shows the continuum fails at phone resolution:
- Wave speed: steel at 1 cm needs about 9,800 explicit substeps per frame; implicit MPM defaults to 250 iterations; VBD converges poorly at 1:10,000 stiffness ratios.
- Contact: native MPM contact is sticky and acts at grid-cell distance.
- Geometry: joints and thin parts are smaller than 2 cells.

Honesty comes from a conservation ledger and a per-material fidelity card, so every shortcut is measured and shown.

Where this stance is weak: at dx 2.5 cm and about 12k awake particles (an estimate), the continuum is roughly 25 litres of moving media and soft matter. Most robot parts will live in the stiff limit.

## First-principles stance

Definition: only the balance laws are hard-coded. Everything object-specific enters through geometry and constitutive models with measured SI parameters. There is no per-object scripted behaviour.

DERIVED (exact or convergent)
- Mass: Lagrangian material points carry fixed mass, so conservation is exact by construction.
- Linear and angular momentum: weak-form momentum balance on the grid with APIC/MLS-MPM transfers, which conserve both. Body-matter exchange is an explicit tally, so what leaves the grid is exactly what the body receives.
- Energy: a first-law ledger per tick (kinetic, gravitational, elastic strain, thermal, latent, actuator work in, numerical loss). Plastic work, viscous dissipation and friction become heat sources in the heat equation.
- Second law: every constitutive module must pass a Clausius-Duhem admissibility test (non-negative dissipation on randomised strain paths) before it can be registered.
- Stiff limit: rigid and affine bodies are the same material points under a kinematic restriction. Mass, centre of mass and inertia are integrals of density, and Newton-Euler follows from the same momentum balance.

MEASURED PARAMETERS (each stored with source, uncertainty and valid range)
Density; E and Poisson ratio (bulk and shear moduli); viscosity or a Herschel-Bulkley set; yield stress and hardening; friction angle and cohesion; tensile strength and fracture energy; conductivity, specific heat, latent heat and transition temperatures; static and kinetic friction per material PAIR.

EMPIRICAL CLOSURES (Tier 2, labelled, validated against experiments)
Hyperelastic law (stable Neo-Hookean or fixed-corotated), von Mises, Drucker-Prager, snow hardening, damage softening, Fourier conduction, Coulomb friction, contact dissipation and restitution, lumped motor and battery models.

PHENOMENOLOGICAL (Tier 3, declared)
Air is ambient drag only. Vapour vents to a reservoir. There is no turbulence model: numerical viscosity stands in and is measured. Surface tension is omitted below grid scale.

NUMERICAL COMPROMISES (each reported, none hidden)
1. Acoustic filtering. Pressure is solved implicitly with the REAL bulk modulus, so sound waves are damped, not propagated. Reported as maximum density deviation (gate under 1%).
2. Shear wave-speed cap, c_cap = C x dx / dt_sub, with C = 0.5 (estimate, to be measured):
   - Tabletop (dx 2.5 cm): 3 m/s at 4 substeps, 6 m/s at 8.
   - Room (dx 5 cm): 6 m/s at 4 substeps, 12 m/s at 8.
   - 6 m/s means a shear modulus up to about 36 kPa at 1000 kg/m3.
   Materials under the cap run at measured moduli (gels, soft foams, mud, dough; published snow parameters at room scale with 8 substeps). Above the cap, the modulus is softened only if the visible dimensionless groups survive: Froude number, friction angle, strength over rho g L, and gravity strain rho g L / E under 1%. Otherwise the body goes to the stiff limit. The softening factor and strain inflation are printed on the fidelity card.
3. Resolution floor of 2 dx. APIC numerical viscosity is measured by Taylor-Green decay and published. Real water Reynolds numbers are not reachable.
4. Sleeping thresholds; fixed-iteration pressure residual; fp32; contact-compliance clamps (soft-constraint frequency at most half the substep rate); one-tick coupling and sensor lag on the web host.

REPORTING
- A fidelity card per material per world scale: resolved, softened by a stated factor, stiff-limit, or unsupported.
- A live HUD and an API query for the ledger, residuals and clamps.
- A public fidelity report generated by CI.
- Numerical energy loss is reported and is not silently converted to heat.

## Architecture

1. MATTER MODEL (the substrate)
Every object is material points: position, velocity, APIC affine matrix, deformation gradient (J only for liquids), mass, rest volume, material id, plastic and damage state, specific enthalpy, owner id. About 128 bytes each. One SI material library, pluggable constitutive modules and one conservation ledger serve both closures.

2. FREE CLOSURE (GPU, all flowing or deforming matter)
- Solver: 3D MLS-MPM/APIC with quadratic B-splines.
- Grid: block-sparse, 4x4x4-node blocks over a 128x64x128 virtual window. dx is 2.5 cm (tabletop, 3.2 x 1.6 x 3.2 m) or 5 cm (room, 6.4 x 3.2 x 6.4 m). Only blocks touched by awake particles are processed. A dense 64-cubed grid would cost 262k node updates per substep against about 12k particles.
- Particle-to-grid: per-substep counting sort plus gather. This is the path the measured iPhone app uses, the only clean one on WebGPU (integer atomics only), and it gives a fixed summation order.
- Integration per substep:
  - explicit deviatoric stress with per-particle return mapping (von Mises, Drucker-Prager, snow);
  - implicit cell-centred pressure with the real bulk modulus (block Gauss-Seidel with a 2-level multigrid, warm-started, fixed iteration count, residual reported);
  - F-bar anti-locking;
  - crack-band damage scaled by dx so dissipated energy per crack area equals the fracture energy.
- Heat: conduction on the grid once per tick (explicitly stable at this dx), enthalpy-based phase change, temperature-dependent moduli.
- Sleeping: block-level sleep and wake. Settled matter becomes a zero-velocity boundary.
- Sand: fully explicit with softened elastic moduli and a real friction angle (declared).

3. STIFF-LIMIT CLOSURE (CPU)
- Material points restricted to rigid (6 DOF) or affine (12 DOF) clusters, optionally several clusters joined by bonds whose stiffness and strength derive from E, section and fracture energy.
- Integrated by a substepped soft-constraint Gauss-Seidel solver (Soft Step lineage): 8 substeps at 480 Hz, strict f32, warm starting, islands and sleeping.
- It handles joints, bonds and body-body Coulomb contact from the pair table.
- The GPU is entirely for matter; the otherwise idle P-cores carry this tier and game logic.

4. COUPLING
- Bodies are written into the grid as a collider field: sub-cell signed distance, normal, body velocity, pair friction.
- Grid nodes enforce non-penetration plus a Coulomb cone, which fixes MPM's sticky contact.
- The momentum removed is summed per body and returned as a wrench at stiff substep boundaries (partitioned, asynchronous, Drake-style precedent).
- An added-mass term stabilises the one-tick readback lag on the web host. Native shared memory removes the lag.

5. PROMOTION AND DEMOTION
- Bond overload, melting or cutting turns a cluster into free particles.
- Freezing or settling turns free particles into a cluster or static matter.
- Mass is exact, momentum is conserved and the energy difference is booked.

6. PRECISION
- GPU state is fp32 in cell units relative to the window origin (about 0.2 micrometre resolution).
- Kernels are nondimensionalised by dx, dt and rho0 dx-cubed.
- The window origin and world positions are f64 on the CPU.

7. LAYERS
Host (web or native) -> Rust core -> robot layer (actuators, sensors, sources) -> game.

DESIGN COUNTS
- 65,536 particle slots.
- About 12k awake particles x 4 substeps (estimate).
- 4,096-block grid pool (262k nodes).
- Up to 256 awake stiff bodies and 512 joints.

## Frame budget

All figures are targets measured on a COOL device, sized so the frame still fits when the GPU throttles to about 60% (research budget: GPU at most 10 ms, CPU physics at most 4 ms wall, about 4 W).

TIMING
- Fixed tick 1/60 s.
- MPM dt 1/240 s (4 substeps). A deterministic rule switches to 8 substeps when a scene holds resolved solids above the 4-substep cap; the awake budget then halves.
- Stiff tier dt 1/480 s.

GPU PHYSICS: 4.5 ms
- MPM substeps, 3.7 ms: 48k particle-substeps per frame (12k awake x 4). ESTIMATE, at an assumed 13k particle-substeps per GPU-ms. The bracket is 3k to 44k per ms:
  - Low end: PhoneFluid scaled to A16 gives 15-28k particles cool at an unknown substep count of at least 1.
  - High end: WebGPU-Ocean's 100k x 2 steps on a laptop iGPU, scaled to 50-200k particle-substeps.
  - Phase 0 replaces this constant with a measurement.
- Implicit pressure, included above at about +15%. ESTIMATE: about 10k active cells x 24 sweeps of a 7-point stencil against 12k x 54 weighted transfers per substep.
- Collider field and wrench reduction: 0.5 ms (estimate).
- Heat: 0.1 ms, once per tick.
- Stretch tier if the high end holds: 24k x 4 or 48k x 2.

MATTER VOLUME (8 particles per cell)
- Tabletop: about 23 L awake, 128 L total.
- Room: about 190 L awake, about 1 cubic metre total.

GPU RENDER: 5.5 ms (allocation, unmeasured)
- 0.5x internal scale (about 0.75 Mpx).
- Depth and thickness splats with a narrow-range filter for liquids.
- Impostor ellipsoids for granular and soft matter; meshes for stiff bodies.
- One shadowed light; spatial upscale.

CPU: at most 4 ms wall (web v1 is one WASM thread)
- Stiff solver, 1.5 ms: 256 awake primitive bodies and 512 joints at 8 substeps. ESTIMATE: Box3D does 555 stacked boxes per ms per M2 core at 4 substeps; 8 substeps is about 300 per ms; an assumed 1.5x WASM penalty gives about 200 per ms. Convex hulls cost about 3.3x more.
- Command encoding for about 70 dispatches and collider upload: 0.8 ms (estimate; Safari per-dispatch overhead is unmeasured).
- Controllers and sensors: 1.0 ms. Ledger and readback: 0.3 ms. Headroom: 0.4 ms.

MEMORY (estimate, count x size)
- Particles: 65,536 x 128 B = 8.4 MB.
- Sort buffers: 1 MB.
- Grid: 4,096 blocks x 64 nodes x 64 B = 16.8 MB.
- Body SDF atlas: 256 x 32-cubed x 2 B = 16.8 MB.
- Render targets: about 40 MB.
- WASM heap cap: 128 MB.
- Total under 250 MB against a 1 GB web planning cap. No buffer exceeds 32 MB against the 256 MiB floor.

THERMAL GOVERNOR (in the core)
- Inputs: GPU timestamps where exposed, frame pacing, requestAnimationFrame halving (Low Power Mode or thermal mitigation) on web, thermalState on native.
- Ladder:
  1. Lower the render scale.
  2. Render at 30 Hz with the physics tick unchanged.
  3. Refuse new wake-ups and promotions beyond the certified scene budget.
  4. Time dilation at 0.5x (identical physics, slower clock, shown on the HUD).
- It never changes dt, material parameters or laws, and never deletes matter.
- Scenes carry a matter budget checked at authoring time.

## Platform and toolchain

LANGUAGE
- Rust (stable) for the core.
- Compile-time SI dimension types (uom-style) at the API boundary; nondimensional f32 inside kernels.
- The stiff tier follows strict IEEE rules (no FMA contraction, no fast-math, in-house trig, fixed ordering), so WASM, x86-64 and ARM64 give identical bits.

GPU API
- wgpu (v30.x) with WGSL as the single shader language: browser WebGPU on wasm, Metal on native iOS.
- WGSL is written to WebKit's stricter dialect from day one: no textures in let bindings, constant arrays of 2,047 elements or fewer, tables in buffers.
- At most 8 storage buffers per stage (WebKit allows 44); requiredLimits requested explicitly from adapter.limits.

FIRST ON-DEVICE DEMO (no Mac, no Apple account, no signing)
- A static site (wasm32 + WGSL + a minimal bootstrap), built on Linux GitHub Actions and deployed to GitHub Pages from a NEW public repository. The existing PWA repo is not touched.
- The user opens the URL in Safari on iOS 26 or later and adds it to the Home Screen for full screen and wake lock.
- Single-threaded WASM with fixed-width SIMD. Not used: threads (GitHub Pages cannot set the isolation headers; Rust wasm threads need nightly), Memory64 and relaxed SIMD (not in a shipping Safari).
- The page boots with a probe:
  - adapter limits and features;
  - a compile check of every pipeline;
  - a memory-growth test;
  - per-dispatch overhead;
  - particle-substeps per ms;
  - a 20-minute soak.
- Results appear as a copyable text block the user pastes back. Nothing is uploaded automatically.
- Resilience: snapshots to OPFS with storage.persist(). A tab kill (2,048 MB WebContent limit observed on iPhones) resumes from the snapshot. The WASM memory maximum is declared at 256 MB.

CI WITHOUT A PHONE (Linux runners)
- cargo tests of the f64/f32 CPU reference solver.
- The WASM build under a headless runtime for bit-exact golden hashes of the stiff tier.
- WGSL validated by naga plus a WebKit deny-list lint.
- GPU kernels executed on software Vulkan (lavapipe) through wgpu. Feasibility is unverified and is confirmed in phase 0. The fallback is reference-only CI plus the on-device conformance subset.

LONG-TERM PATH
- A native iOS host from the same core (Rust + wgpu on Metal).
- Hand-written Metal 3/4 kernels only where a measured win exists: float-atomic scatter A/B, 1024-thread groups, shared-memory same-frame readback (removes the coupling lag).
- Also ProcessInfo.thermalState, MetalFX upscaling, Core Haptics, all 6 cores.
- Built and signed on GitHub Actions macOS runners (free for public repos) with fastlane and an App Store Connect Team API key, delivered through TestFlight (builds last 90 days).
- This needs the US$99/yr Apple Developer Program, which is a user decision.
- The web host stays as the zero-install demo and determinism reference.

REJECTED
- A Swift/Metal-only core: cannot be built or tested in the Linux container.
- Slang: Metal and WGSL targets are still experimental.
- Newton, Warp, Genesis or Taichi AOT as runtime: CUDA/Python-bound or unproven on iOS. They serve as offline oracles only.

## Game-builder API

A game is a description of matter and machines plus controllers. It never scripts outcomes.

WORLD
- Scale preset: Tabletop (dx 2.5 cm) or Room (dx 5 cm).
- Gravity; ambient temperature and air density.
- A certified matter budget that tooling checks at authoring time.

MATERIALS
- Chosen by name from the library (water, oil, honey, dry and wet sand, snow, clay, gelatin, foam, silicone, wax, ice, oak, concrete, aluminium, steel and so on).
- Each record holds SI constitutive parameters with source, uncertainty and valid range.
- The engine answers with a fidelity card for this world scale: resolved at measured moduli, softened by factor X, stiff-limit, or unsupported.
- Custom materials must be complete parameter sets that pass admissibility checks. They are flagged "unmeasured".

PARTS
- Geometry (primitives, convex hulls, voxelised meshes or SDFs) plus a material.
- Mass, centre of mass and inertia are computed, never authored.
- Fill regions for media, for example "8 L of water at 20 C".

ASSEMBLIES
- Joints: revolute, prismatic, spherical, weld, wheel.
- Adhesive bonds with real strength and compliance, which break under load.
- MJCF import later.

ACTUATORS
Stateful physical models that obey force and power limits and draw from sources:
- DC motor with gearbox (voltage, resistance, torque and back-EMF constants, rotor inertia reflected by the ratio squared, efficiency).
- Linear actuator; spring and damper.
- Heater and cooler (watts).
- Pump and valve (pressure-flow curve).
- Finite-mass emitter and drain; thruster that ejects matter.
- Sources: battery (Wh, internal resistance) and tank.
Energy and strength budgets are the natural gameplay gates.

SENSORS (rate, latency, optional seeded noise)
- Encoder, IMU, joint and contact force-torque.
- Thermometer, pressure probe, range ray, fluid-force sensor.
- Region probe: mass, centre of mass, momentum, mean temperature, and phase fractions by material.

CONTROL
- Controllers run like firmware at the fixed 60 Hz tick: read sensors, command actuators.
- Player input maps to actuators or to the "hand", a force- and power-limited manipulator.

QUERIES AND UNITS
- Raycast and overlap against bodies are synchronous.
- Queries against free matter are region probes with one-tick latency on the web host.
- Typed SI at the boundary; bare numbers are rejected.

DETERMINISM AND REPLAY
- Stiff tier and game state: bit-exact across x86-64, ARM64 and WASM.
- GPU matter: fixed-order gather aims at same-device, same-build repeatability (to be measured). Cross-device results are tolerance-only.
- Replay is an input log plus quantised keyframes (default every 10 s, about 2.6 MB each at full capacity, estimate).
- No rollback promise.

FORBIDDEN IN STRICT MODE
- Teleport; setting position, velocity or mass.
- Forces without an actuator; per-object gravity.
- Collision filtering between touching matter.
- Creating or destroying matter mid-run.
- Changing material parameters at runtime.

ESCAPE HATCHES ("interventions")
- Spawn and despawn at declared portals; kinematic prescribed-motion bodies; teleport; director forces; time scale; indestructible boundary material.
- Each is explicit, logged in the ledger as external work or mass, and listed in the fidelity report.
- A build with zero post-load interventions is certified strict.

AUTHORING
- Declarative scene data.
- An in-browser inspector with overlays for stress, temperature, fidelity tier, ledger and budget meter, plus telemetry recording.

## Validation plan

The suite is built before features and run FDS-style: verification checks the maths, validation checks the physics. Tolerances are initial gates. They are re-baselined once in phase 1 against the f64 reference at phone resolution, and only tightened after that.

TIER 0, CONSERVATION (every push)
- Mass drift exactly 0.
- Closed-box linear momentum drift at most 1e-5 relative per 1,000 steps.
- Free-flight rotating block: angular momentum within 0.1% over 10 s.
- Ledger closure: unexplained energy at most 1% of throughput (2% with all models on).
- Promotion and demotion round trip: mass exact, momentum at most 1e-5.
- Body-matter exchange balance at most 1e-5.
- Unit-type compile tests.
- Clausius-Duhem admissibility for every constitutive module.

TIER 1, VERIFICATION (closed forms and convergence order)
- Method of Manufactured Solutions for the momentum equation: observed order at least 1.5 in f64.
- Hydrostatic column: pressure within 2% of rho g h, residual speed under 1 mm/s.
- Soft cantilever at resolved modulus vs Euler-Bernoulli: tip deflection within 10% at 8 cells thickness.
- 1D slab conduction vs analytic: within 2%.
- Stefan melting front s = 2 lambda sqrt(alpha t): within 5%.
- Plane Poiseuille profile: within 5%.
- Torricelli efflux: within 10%.
- Archimedes draft of a floating stiff block: within max(3%, 0.5 dx).
- Stokes settling: within 15%.
- 2D Taylor-Green decay (thin periodic slab): numerical viscosity REPORTED, gated to within 10% of baseline.
- Stiff tier:
  - pendulum period within 0.5% including the amplitude series; energy drift at most 1% over 100 periods;
  - Dzhanibekov flip with angular momentum within 0.1%;
  - incline slip angle within 1 degree of atan(mu_s);
  - 10-box stack drifting under 1 mm in 60 s;
  - 1:1000 mass-ratio chain;
  - DC motor torque-speed line within 3%.

TIER 2, VALIDATION (experiments)
- Martin and Moyce dam break: dimensionless front position RMS error at most 10%.
- Quasi-2D granular column collapse (run-out about 1.2a below a = 2.3, about 1.9 a^(2/3) above): tall-column exponent 0.67 +/- 0.1, prefactors within 20%, repose angle within 3 degrees.
- ten Cate sphere settling: within 15%.
- MFIX DEM02 bouncing particle and DEM05 oblique impact.
- Acosta cube-toss dataset (550 tosses): position error at most 25% of cube width (parity with fitted MuJoCo); stretch goal 15%. Elastic impacts are reported as a known weak area.
- Fracture: dissipated energy within 25% of fracture energy x crack area at dx and dx/2.

EXECUTION WITHOUT AN IPHONE
- The Rust CPU reference (f64 for order studies, f32 as oracle) runs everything on Linux.
- WGSL kernels run on lavapipe through wgpu (to be confirmed in phase 0) and must match the f32 reference within 1e-4 relative per step on 1k-particle scenes.
- Stiff-tier golden state hashes must be identical on x86-64 and WASM.
- Nightly full suite; a reduced suite per push.

ON DEVICE
- A 60-second conformance subset plus the performance gates, with results as a pasteable block.
- Performance gates: 20-minute soak, at least 95% of frames within 16.7 ms, no requestAnimationFrame halving (web) or thermalState at most "fair" (native).

OUTPUT
An auto-generated public fidelity report covering every test, tier, tolerance, measured value, softened materials and active clamps.

## Roadmap

### 0. Probe and first matter
- Goal: Replace every throughput estimate with a measurement on the user's own iPhone 15, and put moving matter in their hand.
- Deliverables: A new public repo with a GitHub Pages URL. Rust-to-wasm plus WGSL explicit 3D MLS-MPM (counting sort + gather, block-sparse grid) with water and dry sand at softened moduli, labelled as such. Tilt gravity and touch poke; simple splat rendering. Capability probe, benchmark and 20-minute soak with a copyable results block. CI skeleton: naga validation, WebKit-dialect lint, lavapipe feasibility check.
- Exit criteria: The user runs the URL on the iPhone 15 and it holds at least 8k particles x 4 substeps at 60 Hz for 20 minutes without requestAnimationFrame halving. Recorded: particle-substeps per GPU-ms, per-dispatch overhead, adapter limits, memory ceiling, sustained-to-cool ratio. Go/no-go: below 5k particle-substeps per ms sustained triggers the contingency ladder (room scale default, 2 substeps, native track pulled forward) before phase 2.

### 1. Conservation core and reference
- Goal: Make first principles enforceable: units, materials with provenance, ledger, and an oracle to test against.
- Deliverables: Rust core with typed SI units. Material library v1 (about 12 materials with source and uncertainty). Constitutive interface with admissibility tests. f64/f32 CPU reference solver mirroring the GPU kernels. Energy ledger. V&V harness and fidelity-report generator in CI.
- Exit criteria: Tier 0 tests pass (mass exact, momentum at most 1e-5, ledger closure at most 1%). Manufactured-solution observed order at least 1.5 in f64. GPU vs reference at most 1e-4 per step. Fidelity report published automatically on every push. Tolerances re-baselined once and frozen.

### 2. Honest liquids and soft solids
- Goal: Liquids with the real bulk modulus and soft solids at measured moduli, sustained on the phone.
- Deliverables: Implicit pressure solve; F-bar; viscosity; hyperelastic solids under the wave-speed cap. Block sleeping; thermal governor. Screen-space liquid renderer. Fidelity cards and HUD (density deviation, residuals, ledger).
- Exit criteria: On device: hydrostatic within 2%, dam break RMS at most 10%, Torricelli within 10%, soft cantilever within 10%, density deviation under 1%. 20-minute soak at the design point (12k awake x 4 substeps, or the phase-0-measured equivalent) with at least 95% of frames within 16.7 ms.

### 3. Granular, plastic, breaking, heat
- Goal: Piling, yielding, tearing and melting from constitutive laws with measured parameters.
- Deliverables: Drucker-Prager, von Mises, snow and Herschel-Bulkley models. Crack-band-regularised damage. Grid heat equation with enthalpy phase change and dissipation-to-heat coupling. Temperature-dependent moduli. Library extended to sand, snow, clay, wax and ice.
- Exit criteria: Column-collapse exponent 0.67 +/- 0.1 and repose angle within 3 degrees. Stefan front within 5%; slab conduction within 2%. Fracture energy within 25% at two resolutions. Ledger closure at most 2% with all models on. Soak still passes.

### 4. Stiff limit and coupling
- Goal: Stiff matter as kinematically restricted matter, with two-way frictional coupling and conserved promotion and demotion.
- Deliverables: Rigid, affine and bonded-cluster bodies. Deterministic CPU soft-constraint solver with joints and pair-table Coulomb contact. Collider field, frictional grid boundary and wrench exchange with added-mass stabilisation. Promotion and demotion (break, melt, freeze, settle).
- Exit criteria: Pendulum within 0.5%; 10-box stack stable for 60 s; Archimedes within max(3%, 0.5 dx); incline within 1 degree; cube toss at most 25% of width. Promotion round trip: mass exact, momentum at most 1e-5. Stiff-tier hashes identical on x86-64 and WASM. On device, 256 awake bodies plus the phase-2 particle budget sustained.

### 5. Robot layer and first game
- Goal: Prove a game can be built like a robot on reality, through the public API only.
- Deliverables: Actuators, sensors, energy sources, controllers. Strict mode and logged interventions. Scene format and inspector. Replay, keyframes and OPFS resume. One vertical-slice sample game (for example: build a machine that moves 5 kg of sand across the table on a battery budget).
- Exit criteria: Sample game certified strict (zero post-load interventions). Motor torque-speed within 3%. A 5-minute replay on the same device reproduces region-probe quantities within 1%, or reports the divergence. Tab-kill resume works. Soak passes with the game running.

### 6. Native iOS host (gated on the Apple Developer decision)
- Goal: Remove browser ceilings and re-certify budgets on Metal.
- Deliverables: wgpu-on-Metal host built and signed on GitHub macOS runners and delivered through TestFlight. thermalState governor; same-frame coupling readback; MetalFX upscaling; haptics. Optional hand-written Metal kernels, including a float-atomic scatter A/B.
- Exit criteria: TestFlight build running on the user's phone. Three-way benchmark (Safari WebGPU vs wgpu-Metal vs hand Metal) published. 20-minute soak with thermalState at most 'fair'. Budgets and fidelity report re-issued for native.

### 7. Raise the ceiling (time-boxed R&D)
- Goal: Push the continuum's stiffness and scale limits without breaking the charter.
- Deliverables: Experiments: multigrid implicit elasticity to raise the wave-speed cap; moving and streaming windows; compact or linear kernels (CK-MPM, MPM Lite); AVBD on GPU vs the CPU stiff tier; modal sound; lumped circuits.
- Exit criteria: Each experiment is adopted only if the full suite still passes and a published metric (wave-speed cap, awake particles, world extent) improves by at least 1.5x on device. Otherwise it is documented and dropped.

## Risks
- A16 throughput in Safari WebGPU is unmeasured. The planning constant (13k particle-substeps per GPU-ms) sits inside a 3k-44k bracket, so the design point could be off by 4x either way. — Mitigation: Phase 0 measures it on the user's phone before anything is built on it. Contingency ladder: room scale (dx 5 cm) as default, 2 substeps for liquid-only scenes, the native Metal track pulled forward. All budgets are expressed as particle-substeps so they rescale mechanically.
- Core weakness of the stance: about 12k awake particles at 2.5 cm is roughly 25 L of moving matter with nothing resolved below 5 cm. Mechanisms live almost entirely in the stiff-limit tier and the continuum may feel like scenery. — Mitigation: State it openly. Room scale gives about 190 L. Design the sample game around media handling (pour, dig, melt, break), where the continuum is the gameplay. Promotion and demotion keeps stiff parts as real matter. Phase 7 attacks the ceiling.
- The implicit pressure solve in 3D with free surfaces may not converge in a fixed small iteration count, or may checkerboard on the staggered layout. Many small dispatches may also cost more than the arithmetic. — Mitigation: Warm start, block-local sweeps in threadgroup memory and a 2-level multigrid. Residual reported every tick. Fallback: weakly compressible liquids with a reported Mach number, or a PB-MPM-style compliant iteration. Dispatch overhead measured in phase 0.
- Sand and stiff-ish solids need softened elastic moduli (up to 1,000-10,000x for real sand shear modulus), which inflates elastic strain and can look spongy. — Mitigation: Keep friction angle, yield and density real. Gate softening on the gravity-strain group staying under 1%. Print the factor on the fidelity card. Use 8 substeps or room scale where it buys real moduli. Multigrid implicit elasticity is the long-term fix.
- Partitioned body-matter coupling with one-tick readback lag on the web can go unstable for light bodies in dense liquid (added-mass instability). Grid contact acts at cell distance. — Mitigation: An added-mass term in the body solve, a sub-cell SDF collider field and a floating-body benchmark as a gate. Native shared-memory readback removes the lag. Low density-ratio cases are flagged degraded on the web.
- MPM numerical fracture and resolution-dependent breaking make destruction depend on dx rather than material strength. — Mitigation: Crack-band regularisation so dissipated energy matches the fracture energy. A two-resolution fracture test in CI. Stiff bodies break by bond energy criteria. Reported as a Tier 2 closure, not a derivation.
- WebKit specifics: stricter WGSL compiler, reported iOS WebGPU crashes, about 2 GB process kill, requestAnimationFrame halved in Low Power Mode, no haptics. — Mitigation: Strict-dialect lint and an on-device pipeline compile check at boot. Footprint under 250 MB. OPFS snapshot and resume as a core feature. 30 Hz presentation as a supported mode. Native host for the long term.
- GPU floats are not bit-exact across devices, and same-device repeatability is unproven. Replays and any future multiplayer cannot rely on matter state. — Mitigation: Fixed-order gather. Stiff tier and game state on a deterministic CPU path. Replays use an input log plus keyframes with divergence reporting. Rollback and lockstep on matter are a non-goal.
- Sustained thermal throttling (published stability 51-84%) may sit below the assumed 60%. — Mitigation: The governor ladder (render scale, 30 Hz render, promotion refusal, time dilation) never alters physics. Block sleeping doubles as a thermal feature. The soak test is an exit criterion in every phase from 0 onward.
- Scope: a simulation that never becomes a game (Noita spent two years finding one), and every kernel maintained twice (WGSL and CPU reference). — Mitigation: A vertical-slice game is a phase 5 exit criterion. Designer tools (budgets, boundary material, telemetry, replay) ship with the API. The reference solver is the test oracle, so the duplicate effort pays for CI without a phone.
- Material data provenance and licensing; handbook values carry real scatter. — Mitigation: Every parameter stores source, uncertainty and licence. Start from open sources (CoolProp, the 'chemicals' library, primary papers). Unmeasured or fantasy materials are flagged in the fidelity report.

## Non-goals
- Atomistic, quantum or relativistic simulation: 'first principles' here means continuum balance laws plus measured constitutive parameters.
- Propagating sound and shock waves, compressible gas dynamics and resolved air flow: air is ambient drag and a vapour reservoir in v1.
- Resolved turbulence or real water Reynolds numbers: fine splash and vorticity detail is lower fidelity by construction, and the measured numerical viscosity is published.
- Metals, wood, stone or hard plastics as time-resolved continua at real stiffness: they are stiff-limit bodies (rigid, affine or bonded) until they break or melt.
- Continuum features thinner than 2 dx: cloth, shells, ropes, gear teeth, threads and surface tension are out of the free closure in v1.
- Open or streaming worlds in v1: one matter window (3.2 x 1.6 x 3.2 m tabletop or 6.4 x 3.2 x 6.4 m room).
- Cross-device bit-exact matter, rollback netcode or lockstep multiplayer.
- Maxwell field solves, detailed chemistry and combustion, wave optics, ray-traced rendering: circuits and motors are lumped models only.
- A general-purpose game engine (UI toolkit, asset pipeline, audio middleware, editor suite): this is the physics backbone plus a thin host.
- Android, desktop or console product targets: the web build may run there, but nothing is tuned or certified off the iPhone 15.
- Using Newton, Genesis, Warp, Taichi or IPC as the runtime: they are offline oracles only.

## Decisions for the user
- 3D at tabletop or room scale (about 25-190 L of moving matter, estimate), or a 2D world with far more matter and extent (the Noita / Powder Toy route)? This plan assumes 3D; a 2D product is a different, much roomier engine.
- Default world scale: Tabletop (dx 2.5 cm, 3.2 m window, finer detail, softer stiffness cap) or Room (dx 5 cm, 6.4 m window, 8x more matter volume, coarser detail)?
- Where the demo lives: a new public repository with its own GitHub Pages URL (recommended; leaves your existing PWA untouched and makes macOS CI free later), or a subfolder of the existing site?
- Will you pay for the Apple Developer Program (US$99/yr) for the native TestFlight track, and when: right after the web demo, or only if the browser ceiling is actually hit?
- What should the first game on top be about: liquids, sand and soil, soft bodies, destruction or heat? This sets the order of the material library and which benchmarks gate first.
- When the phone runs hot, what is your preference order: truthful slow motion, 30 fps rendering, or lower visual quality? The engine will not change the physics.
- Should games be strict by default (no teleporting or velocity setting unless explicitly unlocked and logged), or permissive by default with strict as an opt-in certification?
- Is the engine open-source with a public fidelity report? A public repo is needed anyway for free CI, and openness affects which material data sources can be redistributed.
- Is your iPhone 15 on iOS 26 or later, or are you willing to update? Safari WebGPU, and therefore the first demo, requires it.

## Red-team review — feasibility lens

Scores (0-10): realism 4, feasibility_on_a16 5, first_principles_integrity 6, game_buildability 5, delivery_safety 4

**Verdict.** There is no fatal flaw in the delivery path: Rust or JavaScript to WebGPU on GitHub Pages reaches the phone from Linux, and the phase 0 milestone is reachable once it is split and given a protocol and crash breadcrumbs. Raw explicit throughput is also not where the plan is optimistic: PhoneFluid's source suggests about 10 substeps per frame, which makes the 13k planning constant defensible for plain liquid.

The optimism is in what is stacked on that constant. Honest stiffness needs 16-24 substeps for sand that passes the plan's own gate, dispatch count is 2-4x the estimate, the single-thread WASM stiff tier is 1.5-3x over, and the power envelope is 1.3-1.6x tighter than the millisecond budget. Compounded, a mixed scene is about 3-5x over.

The result at tabletop scale is roughly 25 L of liquid and soft gel, or about 5 L of gate-passing sand, while the mechanisms run on one browser thread. I would keep phase 0, the ledger, the fidelity cards and implicit-pressure liquids. I would not adopt continuum-first as the centre of gravity unless a compliant or implicit deviatoric solve moves from phase 7 into the base design, the body-liquid coupling is made strong, and an existing rigid-body engine replaces the in-house one.

Verification limits: the web search budget was already exhausted, so checks were direct fetches of GitHub-hosted sources (PhoneFluid, WebKit, wgpu, configure-pages). The added-mass result, browser readback latency, foam moduli and Safari on macOS runners are from memory and unconfirmed.

### Fatal flaws
- The frame budget and the plan's own fidelity gate cannot both hold for sand or any softened solid at tabletop scale, so at the stated budget the free closure honestly hosts only liquids, mud and very soft gels. Either the explicit deviatoric solve or the 1% gravity-strain rule has to change. — Evidence: At the 4-substep cap (3 m/s, P-wave, Poisson ratio 0.3) sand gets E of about 11 kPa, which is 15% gravity strain on a 10 cm pile (3.7% at 8 substeps) against the 1% gate. Passing the gate needs about 16 substeps for that pile and about 24 for a 25 cm bed, leaving 2-3k awake particles. The 'resolved' list is also overstated: soft foam has a shear speed of about 20-35 m/s, and published snow sits at 12.1 m/s against a 12 m/s cap before hardening or any motion.

### Fixable flaws
- Phase 0 bundles the device measurement with a full block-sparse MPM, sand plasticity, a renderer and CI, so the number every later budget depends on arrives only after most of the risky code is written. — Fix: Split it. Step 0a is a plain-JavaScript probe page shipped in days: limits, features, timer resolution, pipeline compile, a 1,000-dispatch overhead batch, a synthetic 27-node gather kernel ramped until frames drop, and a 20-minute synthetic soak. Step 0b is explicit MPM on a small dense grid; add the block-sparse grid only if 0a shows it is needed.
- Phase 0's exit mixes 'measured' with 'passed' (8k x 4 for 20 minutes) and has no test protocol, so a warm room, a case, charging or Low Power Mode can flip the result. — Fix: Make the exit 'numbers recorded under a written protocol' (iOS build, Low Power Mode off, unplugged, no case, fixed brightness, room temperature, battery percent before and after as a power proxy). Let the thresholds only choose the contingency branch.
- There is no remote debugger without a Mac, so a Safari shader rejection, device loss or WebContent kill leaves no results block to paste. Home Screen and Pages caching can also serve a stale build. — Fix: Persist a breadcrumb log to localStorage at every probe stage and every soak minute and show it on the next launch. Capture getCompilationInfo, uncapturederror and device.lost, stamp the build hash in the results, and cache-bust every asset.
- Lavapipe exercises naga's SPIR-V path, while Safari compiles the generated Metal shader in relaxed maths mode (seen in WebKit's ShaderModule.mm). The 1e-4 GPU-versus-reference gate and any NaN guards proven in CI therefore do not transfer to the phone, and the WebKit lint only knows two rejections. — Fix: Add a macOS GitHub runner job now (free for public repos; feasibility to confirm) that drives Safari to compile every pipeline and run the 1k-particle conformance set. Write kernels NaN-safe by construction (clamp before divide, no reliance on isnan) and treat the on-device subset as the real gate.
- wgpu's WebGPU backend against Safari is in nobody's CI. wgpu's README and CI do not mention Safari and warn that its API and WGSL may differ from the spec, and the research shows Bevy's wgpu shaders already broke on Safari 26. — Fix: Use a thin hand-written WebGPU host on the web (the WGSL is shared either way), or prove wgpu device creation and one compute pass on the phone in step 0a before committing. Keep wgpu for native and for lavapipe CI.
- The pressure solve is costed by arithmetic (+15%) but not by dispatches. 24 Gauss-Seidel sweeps need red-black passes, which gives roughly 150-260 dispatches per frame at 4 substeps (300-520 at 8) against the 70 assumed, each touching only about 10k cells. — Fix: Budget in dispatches as well as milliseconds. Run several block-local Jacobi or Chebyshev sweeps per dispatch in workgroup memory (4 or fewer pressure dispatches per substep), measure per-dispatch cost in 0a, and cap the frame at about 100 dispatches.
- The plan writes a new deterministic 3D rigid-body engine (joints, hulls, continuous collision, islands, sleeping) and assumes it matches Box3D's hand-tuned SIMD throughput on one main-thread WASM core. Box3D itself is still alpha after years of specialist work. — Fix: Adopt Rapier (Rust, bit-identical WASM) as the stiff tier and write only the material-derived contact, actuator and coupling layers. Certify 64-128 awake primitives for web v1 and add worker threads through the service-worker isolation shim later.
- Lagged partitioned coupling to an effectively incompressible liquid is unstable whenever a body's added mass exceeds its own mass, whatever the step size (standard fluid-structure result, cited from memory). A 20 cm wooden paddle has about 2.7 kg of added mass against about 0.5 kg of its own. Browser readback also takes 1-3 frames and varies, so the lag is neither one tick nor repeatable (from experience, not measured). — Fix: Put each body's inverse mass inside the GPU pressure solve (a rank-6 term per body), or apply a deliberately over-estimated added-mass tensor. Deliver wrenches at a fixed 2-tick delay so replays stay repeatable, and gate with a bobbing-float test at density ratios 0.1-0.5.
- Coupling and the stiff tier arrive in phase 4, after the pressure solver and renderer were built without moving boundaries, and the first game is phase 5. The riskiest integration and the proof of buildability both come last. — Fix: Pull a kinematic collider, one rigid body and one motor into phase 2 as a vertical slice. End every phase with a small playable toy on the phone.
- The GPU budget has zero margin at the assumed 60% throttle and fails at the 51% figure in the research. Safari halves requestAnimationFrame on the OS thermal state, which is a power limit the page cannot read, and holding the physics tick at 30 Hz rendering sheds only about 27% of GPU load. — Fix: Design to about 6.5-8 ms of cool GPU time in total. Make 30 Hz presentation with 60 Hz physics a certified first-class mode, and record the battery-percent drop per soak as the power measurement.
- Several exit criteria cannot be run or cannot fail. The 8-cell-thick cantilever needs about 33k particles (2.7x the awake budget), the replay gate passes if it merely 'reports the divergence', tolerances are frozen in phase 1 before the features exist, and no phase has an effort estimate or cut line. — Fix: Size every on-device test to half the certified budget or less and replace 'or reports' with numeric thresholds. Freeze tolerances per feature in the phase that ships it, and give each phase a time box and a kill criterion.
- A new repository cannot switch on Pages from the workflow: the configure-pages action states that enablement needs a token other than GITHUB_TOKEN. The cloud session must also be granted the new repository. — Fix: Give the user a one-time checklist (create the public repo, set the Pages source to GitHub Actions, attach it to the session). The alternative is a subfolder of the existing Pages site, after checking that the existing service worker's scope does not cache it.
- Governor rung 3 (refuse wake-ups and promotions) freezes matter that the laws say should move or break, which contradicts 'never changes laws'. One 40 cm block promoting releases about 33k particles, 2.7x the awake budget. — Fix: Count worst-case promotable volume in the authoring-time matter budget. Replace refusal with time dilation so the governor never alters outcomes.
- A counting sort that places particles with atomic cursors gives a racy order inside each cell, so the 'fixed summation order' and same-device replay claim does not follow from sort-plus-gather alone. — Fix: Use a stable placement (rank from a prefix sum over particle index) or sort indices within each cell. Price that extra pass in the phase 0 benchmark.

### Numbers challenged
- Planning constant of 13k particle-substeps per GPU-ms inside a 3k-44k bracket, with PhoneFluid's substep count unknown (at least 1). → PhoneFluid's water preset implies about 600 substeps per second (about 10 per 60 Hz frame). Its Medium tier is then about 430k particle-substeps per frame on the A20 Pro, about 160k cool on A16, or roughly 10-35k per ms natively. The 3k floor is too pessimistic, but that kernel is far lighter than this design's, so expect roughly 2-15k per ms here: 13k is plausible for J-only liquid and about 2-3x high for elastoplastic particles in Safari. (basis: Fetched FluidPreset.swift (stepsPerSecond 1200 at reference dt 0.2), FluidSimulation.swift (water dt 0.4, speed clamp 0.75 cells per step) and Simulation.metal (Tait equation of state; position, velocity and affine matrix only; dense grid). The resolution scale factor was not found, so the substep count carries about 1.5x uncertainty.)
- Implicit pressure adds about 15%; about 70 dispatches per frame cost 0.8 ms of CPU. → About 150-260 dispatches per frame at 4 substeps. At the plan's own 11 microseconds per dispatch that is 1.7-3.0 ms of CPU, taking the CPU total to about 5-6 ms before any per-dispatch GPU launch cost. (basis: Count per substep: sort 3-4, block marking 1-2, P2G 1, grid and collider 2-3, G2P 1, wrench 1, pressure right-hand side and gradient 2, 24 sweeps as 24-48 passes, multigrid transfers about 4.)
- c_cap = 0.5 dx/dt gives 3 m/s at tabletop with 4 substeps, applied to wave speed alone. → Material speed shares that limit. Free fall from 0.46 m reaches 3 m/s (half a cell per substep) and from 1.03 m reaches 4.5 m/s (0.75 cell, where the measured iPhone app clamps velocity); the 1.6 m window allows 5.6 m/s. Scenes with drops over about 0.5-1 m need 8 substeps, halving awake matter to about 6k particles. (basis: v = sqrt(2gh). PhoneFluid sets maxSpeed = 0.75/dt and clamps, which strict mode forbids; the plan's 8-substep rule is keyed to stiffness only.)
- 6 m/s means a shear modulus up to about 36 kPa; softened materials keep gravity strain under 1%. → At that cap E is about 100 kPa, so the 1% gate only passes for bodies under about 11 cm tall. The limit is 2.7 cm at 4 substeps and 44 cm at room scale with 8 substeps. (basis: rho g L / E < 0.01 with E of about 3G and 1000 kg/m3.)
- Gels, soft foams, mud and dough run at measured moduli; published snow parameters run at room scale with 8 substeps. → Soft foam is over every cap in the table (about 20-35 m/s against 3-12 m/s) because its density is about 30 kg/m3. Snow's shear speed is 12.1 m/s, equal to the cap, with no allowance for motion or for hardening, which multiplies the modulus by exp(10(1-Jp)). (basis: c = sqrt(G/rho) with snow E 1.4e5 Pa, Poisson ratio 0.2 and 400 kg/m3 from the research. Foam E of 30-100 kPa is a handbook value from memory.)
- 256 awake bodies and 512 joints at 8 substeps cost 1.5 ms on one WASM thread (1.5x WASM penalty). → About 2-4.5 ms unless the new solver has Box3D-grade graph-coloured SIMD. 256 convex hulls cost about 4 ms even at the plan's own rate. (basis: 555 boxes per ms at 4 substeps is about 300 at 8. The Box2D non-SIMD build is 3.4-3.6x slower, giving about 57 per ms after the 1.5x WASM penalty; hulls cost 3.3x boxes.)
- GPU at most 10 ms on a cool device so the frame still fits at 60% throttle, about 4 W. → 10 ms / 0.6 is 16.67 ms, so there is no margin; at the 51% stability figure it is 19.6 ms. A 60% GPU duty is about 5-6 W whole-device, above the 4.3 W sustained run, which points to about 6.5-8 ms. (basis: Research power figures: 0.94 W idle, about 7 W average under GPU benchmark load, 4.32 W in the 30-minute game run.)
- Tabletop window of 3.2 x 1.6 x 3.2 m with 128 L of total matter. → 65,536 slots cover the window floor to a depth of 1.25 cm, half a cell. A two-cell sand floor needs 512 L (262k particles, 4x the slots), so the usable world is roughly a 0.8 x 0.8 x 0.2 m tray. (basis: 128 L / (3.2 m x 3.2 m); 8 particles per 15.6 mL cell.)
- About 12k awake particles at dx 2.5 cm (23 L), with phase 7 raising the ceiling. → Moving the same 23 L to 1 cm cells costs 15.6x the particles and 2.5x the substeps, about 39x. Nothing on the contingency ladder or in phase 7 (1.5x adoption gate) approaches that. (basis: Volume scales with dx cubed and substeps with 1/dx at fixed speeds.)
- The boot probe records per-dispatch overhead and particle-substeps per GPU-ms. → performance.now() is quantised to 1 ms by default in WebKit and timestamp-query on the iPhone 15 is unconfirmed. These numbers need 1,000-dispatch batches and a load ramp to the frame-drop point, or the isolation shim for finer timers. (basis: WebKit Performance.cpp (timePrecision 1 ms) and HardwareCapabilities.mm (timestamp-query only when Metal stage-boundary counter sampling exists), both fetched.)
- Running GPU kernels on lavapipe through wgpu is unverified. → Lower risk than stated: wgpu's own CI runs its GPU tests on Linux with Mesa's software Vulkan driver. The gap is what that run proves about Safari, not whether it runs. (basis: wgpu .github/workflows/ci.yml fetched (install-mesa step, LVP_POISON_MEMORY).)
- Total memory under 250 MB against a 1 GB planning cap. → The arithmetic checks out (8.4 + 16.8 + 16.8 MB for particles, grid and SDF atlas) and even a 2x miss is safe, so memory is not what will fail. GPU buffers live in WebKit's separate GPU process, whose limit was not measured (from memory). (basis: Recomputed count x size for each buffer.)

### Best ideas to keep
- Measure first on the user's own phone through a static GitHub Pages WebGPU page (no Mac, Apple account or signing), with a go/no-go threshold and every budget expressed in particle-substeps so it rescales mechanically.
- A fidelity card per material per world scale (resolved, softened by a stated factor, stiff-limit, unsupported), plus a conservation ledger and a CI-generated public fidelity report. Numerical energy loss is reported, not silently turned into heat.
- Implicit pressure with the real bulk modulus for liquids, gated on density deviation under 1%. Liquids are the one place where real stiffness is affordable on this phone.
- A thermal governor that never changes dt, parameters or laws, with truthful time dilation as the last rung and matter budgets certified at authoring time.
- Sort-plus-gather particle-to-grid transfer, which matches the only measured iPhone MPM app and avoids float atomics on WebGPU.
- A deterministic CPU stiff tier with the WASM build as the cross-platform reference, and an f32/f64 CPU solver as the test oracle so CI works without a phone.
- Strict mode with logged interventions, actuators that draw from finite energy sources, and sensors with rate, latency and noise: games are gated by energy and strength budgets instead of scripts.
- Treating a tab kill as the normal failure mode, with OPFS snapshot and resume built into the core.
- A second-law admissibility test (non-negative dissipation on random strain paths) that every constitutive module must pass before it can be registered.
- WebKit-strict WGSL from day one, 8 or fewer storage buffers per stage, and explicit requiredLimits; and a phase 7 rule that adopts research only if the full suite passes and a published metric improves 1.5x on device.

## Red-team review — physics lens

Scores (0-10): realism 4, feasibility_on_a16 5, first_principles_integrity 5, game_buildability 3, delivery_safety 4

**Verdict.** Reject as the lead design; keep its honesty machinery. The stance's own softening gate leaves only thin liquids, thick liquids and jelly resolved at measured parameters, in about 23 L with 5 cm features. Sand, the flagship medium, fails that gate at every preset, and the vehicle, arm and bridge fall to a late, conventional rigid tier with solver-determined statics, 60 Hz control and a lagged coupling that degrades every boat on the web host. Fire is a non-goal outright. The validation suite would miss the worst artifacts (spongy sand, volume drift, thin-wall leaks, substep dependence, joint error), and several of its fluid tests cannot run at shipped resolution. A mechanism-first design that adopts this plan's ledger, fidelity cards, strict mode and probe-first roadmap, and treats the continuum as an implicit liquid and granular medium, would serve the request better. All arithmetic here was derived and checked; web search was unavailable, so foam properties, the crack-band size limit and WebGPU readback latency are from memory.

### Fatal flaws
- The softening rule that keeps above-cap materials honest admits almost nothing, so dry sand (the flagship granular medium and the phase-5 sample game) is unsupported by the design's own gate. The explicit-deviatoric core would have to become implicit or rigid-plastic for granular and stiff-ish media, which the plan defers to phase 7 R&D. — Evidence: Gravity strain under 1% with a wave-speed cap c means body height L <= 0.01 c^2/g: 0.9 cm (tabletop, 4 substeps), 3.7 cm (tabletop 8 / room 4), 14.7 cm (room 8), i.e. at or below the 2 dx floor (5-10 cm). A 30 cm sand bed at tabletop/4 has 33% strain at its base, and a 10 cm bed 11%. Clay, silicone, snow and foam hit the same wall.
- The roadmap and GPU budget are inverted relative to the product goal. The continuum resolves about 4 of the 15 library materials at measured moduli (water, oil, honey, gelatin), in about 23 L with nothing under 5 cm. The vehicle, robot arm and bridge live entirely in a conventional maximal-coordinate rigid solver that arrives in phase 4, and the boat floats on a pond of at most 23 L awake. — Evidence: The architecture itself says most robot parts live in the stiff limit and the continuum may feel like scenery. Phases 0-3 and 100% of GPU physics go to the free closure. The stiff tier has no reduced-coordinate articulations, gears, belts, cables, compliant parts or aerodynamic forces, although the research recommended articulations and declared lift/drag models.
- Fire cannot be built at all, and heat gameplay is thinner than the plan implies. Combustion is a non-goal, air is drag only, vapour is deleted to a reservoir, and there is no convection, no radiation and no surface heat loss to ambient. — Evidence: The non-goals list detailed chemistry and combustion and resolved air flow, while the decisions list still offers heat as a first-game theme. Conduction-only melting is slow at real constants: an ice front needs about 6.4 simulated hours to cross 4 cells (assuming lambda about 0.3), and a 1 kW heater needs 5.6 minutes per kg of ice.

### Fixable flaws
- The 'real bulk modulus' pressure solve is an incompressible projection in disguise, because K has no measurable effect at this dx and dt. Effective compressibility is set by the fixed sweep count (the same iteration-dependent stiffness the plan criticises in PBD), and any leftover volume error at 2.2 GPa needs an undeclared relaxation factor to avoid popping. — Fix: Label it as an incompressible-limit solve. Publish the volume-drift relaxation as a declared numerical parameter, and gate on divergence residual plus a 20-minute water-level test rather than on K.
- Phase 0's go/no-go measures explicit kernels only. The implicit solve that the design point depends on is first costed and convergence-tested in phase 2, and its only fallback (weakly compressible liquid) cannot pass the plan's own density gate. — Fix: Add a pressure-solve microbenchmark to the phase 0 probe: the block-sparse sweep and multigrid dispatch chain, with convergence on a 20-cell hydrostatic column. Replace the weakly compressible fallback with fewer particles at room scale or a 2D mode.
- The wave-speed cap ignores material velocity, and no continuous collision detection or tunnelling policy is stated for either tier. Falling water, thrown objects and vehicles above a few m/s use up the whole CFL budget, and nothing says whether velocities are clamped (unbooked momentum loss) or allowed to go unstable. — Fix: Define the cap on c + |v| with a deterministic velocity-triggered substep rule. Add speculative plus time-of-impact CCD in the stiff tier, book any clamp in the ledger, and add tunnelling tests (fast body against a thin wall, particles against a fast thin plate).
- Node-based collider fields cannot separate matter on the two sides of a wall thinner than about 2 dx (5-10 cm). Cups, buckets, pipes and boat hulls leak or glue inside to outside, and a 32-cubed SDF of a 1 m hull has 3 cm voxels. — Fix: Use a CPIC-style per-particle side-of-surface compatibility test, or particle-level SDF projection. Print the minimum wall thickness on the fidelity card, and add a leak test requiring zero mass through a thin-walled container in 60 s.
- Contact between two free bodies is still single-velocity-field MPM. Two gel blocks or snowballs fuse when 1-2 cells apart, and the pair friction table cannot apply. The collider fix covers body-to-matter contact only. — Fix: Add a two-field nodal contact per owner id (Bardenhagen/Nairn style) with Coulomb friction from the pair table at nodes shared by two owners. Add separation and sliding tests between free bodies.
- Liquid-to-solid boundaries use a Coulomb pair friction coefficient, which is not a measurable property of water on steel. Viscous liquids obey no-slip, so the Poiseuille test and hull drag would be tuned rather than derived. — Fix: Choose the boundary condition by phase: no-slip or Navier-slip driven by viscosity for liquids, Coulomb for granular and solid matter. Remove friction entries for liquid pairs.
- The coupling assumes exactly one tick of lag, but WebGPU readback is asynchronous with no guaranteed latency (from memory, not re-checked). Bodies act as infinite mass for at least 4 matter substeps, every boat is the 'light body in dense liquid' case flagged degraded on the web through phase 5, and stiff-tier bit-exactness is void whenever a body touches matter. — Fix: Integrate coupled bodies' free 6-DOF motion on the GPU inside the substep loop, or read back a per-body 6x6 fluid impedance for an implicit CPU solve. Use a fixed N-tick delay line, restate determinism as holding for matter-free scenes only, and add a heave-period and decay test plus a block-resting-on-sand test.
- Stiff-tier statics are decided by the solver, not the material. With compliance clamped to 240 Hz, load sharing and break order in a statically indeterminate bridge follow the clamp and Gauss-Seidel order rather than E A / L. Force and fracture-energy break criteria also cannot both hold under a clamp. — Fix: Solve bonded and jointed islands with a direct sparse factorisation, and apply one uniform softening factor per island so stiffness ratios survive. Validate against truss member forces from matrix analysis, bonded-cantilever deflection and first mode, and three-point-bend failure load, and declare which criterion is distorted.
- Controllers run at 60 Hz with one-tick sensor lag, and joints are maximal-coordinate only. Balancing robots, drones and stiff geared servos need 250-1000 Hz loops, and a loaded arm will show joint separation that depends on iteration count. — Fix: Add Featherstone articulations. Ship substep-rate (480 Hz) motor-driver and servo blocks with SI gains, allow opt-in substep controllers on the CPU tier, and add gear, rack, belt and cable constraints as declared Tier 2 idealisations.
- Thermal state at the hand-off is unspecified. Stiff bodies have no stated temperature field, nothing cools to ambient, particle-grid temperature transfer is strongly diffusive unless done by increments, and boundary layers are far below a cell, so melting rates are set by the grid. — Fix: Give each body a coarse voxel or lumped enthalpy coupled through the collider cells. Add declared surface convection and grey-body radiation, transfer temperature increments only, and state a sub-grid heat-transfer closure. If fire is wanted, add a one-step fuel-mass and heat-release model as Tier 3.
- Governor step 3 (refuse wake-ups and promotions) changes outcomes with device temperature, contradicting 'never changes laws': a refused pile becomes an immovable momentum sink and a refused bond does not break. The certified budget also ignores that a player can wake everything. — Fix: Put time dilation before any refusal and allow deeper dilation. Certify scenes on total movable particles, not expected awake particles.
- The energy-ledger gate is circular. 'Numerical loss' is the residual, so 'unexplained energy at most 1% of throughput' is either trivially met or, if loss counts, unreachable with APIC filtering and backward-Euler pressure. 'Throughput' is undefined. — Fix: Compute every physical channel independently and gate numerical dissipation against physical dissipation on named scenes: sloshing decay rate, gel ring-down, rebound height. Define the normalisation.
- The validation suite misses the artifacts this lens cares about. There is no 4-versus-8-substep invariance test, no long-run volume drift test (mass is exact while J drifts), no joint-error gate, no grasp or static-friction creep test and no pass criterion for the 1:1000 chain, and several fluid tests cannot run at shipped resolution. — Fix: Require every Tier 1 and Tier 2 test to be run and reported at shipped dx, dt and fp32 as well as on the f64 reference. Add the missing tests, and state that cube-toss parameters come from the material table with no fitting.
- Fracture is less first-principles than claimed. Crack-band regularisation needs dx below roughly 2 E Gf / ft^2 (from memory), which is millimetres for gels, and stiff bodies break along authored bond planes, which is pre-fractured destruction. — Fix: Print the characteristic length on the fidelity card and declare any strength scaling when dx exceeds it. Label stiff-tier fracture as an authored pattern, or generate bond planes at runtime from the stress state.
- Promotion can fail for lack of slots. A 1 cubic metre stiff body is 512k particles at tabletop against 65,536 slots, and partial promotion (melting layer, remainder mass properties, momentum split, SDF update) is unspecified. — Fix: Specify surface-layer promotion with the remainder's mass, inertia and SDF updated, with reserved slots. Test the ledger across a partial melt and a partial break.
- A viscosity cap is missing from the declared compromises. Explicit deviatoric stress limits kinematic viscosity to about 0.025 m^2/s at tabletop/4, which unyielded Herschel-Bulkley mud, cold honey and wax near freezing exceed. Below the numerical viscosity floor, water and oil are the same fluid. — Fix: Treat viscosity implicitly, or add both the upper cap and the 'viscosity unresolved below the numerical floor' flag to the fidelity card.
- The API has gaps that block real builds. Strict mode forbids collision filtering between touching matter, yet ideal joints need filtered overlapping pairs. The language in which a game author writes controllers and scenes is never stated. — Fix: Define joints as declared kinematic-pair idealisations with implicit pair filtering, and specify the authoring binding (Rust crate, JS/TS over WASM, or both).
- Phase 4 packs a from-scratch deterministic rigid solver, the coupling and promotion/demotion into one phase, and the first game arrives only after five phases with all debugging through pasted text from the phone. — Fix: Adopt Rapier (Rust, WASM bit-identical determinism, multibodies) as the stiff-tier base. Pull a minimal mechanism-plus-matter game slice forward to right after phase 1.

### Numbers challenged
- Above the cap, a modulus is softened only if gravity strain rho g L / E stays under 1%. → That allows bodies at most 0.9 cm tall (tabletop, 4 substeps), 3.7 cm (tabletop 8 or room 4) or 14.7 cm (room 8). The set of softened-but-honest materials is essentially empty. (basis: Derived: L_max = 0.01 c_cap^2 / g with c_cap = 3, 6, 12 m/s, compared with the 2 dx floor of 5-10 cm.)
- Sand runs fully explicit with softened moduli and a real friction angle, gated on gravity strain under 1%. → A 10 cm sand bed at tabletop/4 has 11% base strain and a 30 cm bed 33%. Even room/8 gives 2% at 30 cm. Sand fails its own gate at every preset. (basis: Derived: strain = g L / c^2 for a P-wave modulus capped at rho c^2.)
- Materials under the cap run at measured moduli: gels, soft foams, mud, dough. → Soft foam is far above the cap because it is light: E of 20-100 kPa at 25-50 kg/m^3 gives 28-45 m/s against a 12 m/s maximum cap. (basis: Derived from c = sqrt(E/rho); foam property ranges are from memory (search budget exhausted).)
- Published snow parameters are resolved at room scale with 8 substeps. → Shear speed is 12.08 m/s against a 12 m/s cap before any margin (13.9 m/s with the 4/3 factor). Hardening raises it to 20 m/s at 10% plastic compaction and 33 m/s at 20%, and a snowball at dx 5 cm is 1-2 cells. (basis: Derived from E 1.4e5 Pa, nu 0.2, rho 400 kg/m^3, hardening exp(10(1 - Jp)); those snow parameters were themselves quoted from memory in the research.)
- 6 m/s means a shear modulus up to about 36 kPa at 1000 kg/m^3. → About 27 kPa (6.75 kPa at 3 m/s), and less once material velocity is counted. (basis: Derived: with pressure implicit, the explicit deviatoric part still carries a longitudinal modulus of 4G/3.)
- The 4-substep tabletop cap of 3 m/s is a stiffness budget. → Motion alone consumes it: a 0.46 m fall reaches 3 m/s (0.5 cells per substep) and a fall across the 1.6 m window reaches 5.6 m/s (0.93 cells per substep). (basis: Derived: v = sqrt(2 g h), with dx/dt = 6 m/s.)
- Implicit pressure costs about +15% of the MPM substep. → The plan's own counts give 1.68M stencil taps against 648k transfer taps, 2.6 times more. +15% needs each tap to be about 17 times cheaper, and 24 sweeps over 4 substeps is 96-192 dispatches against the 70 budgeted unless sweeps are block-local, which weakens convergence. (basis: Derived from the frame_budget figures (10k cells x 24 sweeps x 7 points; 12k particles x 54 transfers).)
- Pressure is solved implicitly with the real bulk modulus. → The compressibility term rho dx^2 / (K dt^2) is 1.6e-5, so K changes nothing measurable. Effective stiffness is whatever the fixed sweep count leaves. (basis: Derived for water at dx 2.5 cm and dt 1/240 s.)
- Fallback: weakly compressible liquids with a reported Mach number. → At the explicit cap, a 0.3-0.5 m water column compresses 33-55% (c 3 m/s), 8-14% (6 m/s) or 2-3.4% (12 m/s). It fails the under-1% density gate for any depth over 0.9-14.7 cm, and phase 0's explicit water has the same problem. (basis: Derived: hydrostatic density change = g h / c^2.)
- Tabletop holds about 23 L awake and 128 L total. → For player-driven scenes the certifiable figure is 23 L. If all 65,536 particles wake, GPU physics is about 5.4 times budget (20-24 ms), beyond what 0.5x time dilation absorbs. (basis: Derived: 65,536 / 12,000 times the 3.7-4.5 ms physics budget.)
- ten Cate sphere settling and Stokes settling within 15%. → At dx 2.5 cm the ten Cate tank is 4 x 6.4 x 4 cells and the sphere 0.6 of a cell, and a resolved Stokes case needs far more than the particle budget. These validate the f64 reference, not the shipped engine. (basis: Derived from the research's ten Cate geometry (1.5 cm sphere, 10 x 16 x 10 cm tank).)
- Soft-constraint frequency is clamped to at most half the substep rate (240 Hz), reported as a compromise. → A 5 cm steel bond of 1 cm^2 section resonates near 16 kHz and a 10 cm steel block's affine mode near 25 kHz, so the clamp is about 4,500 to 10,000 times softer than the material. Affine clusters are either effectively rigid or rubber-like. (basis: Derived: f = sqrt(k/m) / 2 pi with k = E A / L, and c / 2L for the block mode.)
- Cube toss position error at most 25% of cube width, parity with fitted MuJoCo. → The published 13-25% figures are for parameters fitted to that dataset. An engine using unfitted table values should expect worse, and fitting would break the measured-parameter charter. (basis: The research's own contact finding: 'fitted simulators still missed real trajectories'.)
- Stefan melting front within 5% as a phase 3 gate, implying melting is playable. → The test can pass while gameplay melting is grid-controlled: the thermal boundary layer in water is 2.9 mm after 60 s (about 1/9 of a cell) and 9 mm after 10 minutes. (basis: Derived: sqrt(alpha t) with water diffusivity 1.43e-7 m^2/s.)

### Best ideas to keep
- A per-material fidelity card for each world scale (resolved, softened by a stated factor, stiff-limit, unsupported), with a CI-generated public fidelity report. It is the right honesty mechanism even though it would currently print 'unsupported' for most of the library.
- The principle that softening is permitted only when named dimensionless groups survive, and is refused otherwise. Keep the rule and let its harsh result drive the solver choice.
- A first-law ledger with numerical loss reported and never silently converted to heat, plus a Clausius-Duhem admissibility test before any constitutive module can register.
- Budgets expressed in particle-substeps, with a phase 0 on-device probe that replaces every estimate with a measurement and has an explicit go/no-go ladder.
- A thermal governor whose last resort is truthful slow motion and which never changes dt or material parameters, once the wake-refusal step is removed.
- Strict mode with logged interventions booked as external work or mass, and the 'hand' as a force- and power-limited manipulator for player input.
- Actuators as stateful physical models drawing from finite sources (battery, tank), with reflected rotor inertia, so energy and strength budgets are the gameplay gates.
- Stiff bodies defined as the same matter under a kinematic restriction, with mass, centre of mass and inertia computed from density and promotion/demotion booked. It is a sound accounting principle for mass and energy at hand-offs.
- An f64/f32 CPU reference solver mirroring the GPU kernels, with manufactured-solution order tests and software-Vulkan CI, so verification runs without a phone.
- Sort-plus-gather transfers for a fixed summation order, cell-relative fp32 state with f64 world origin, and typed SI at the API boundary with nondimensional kernels.
- Tab-kill resume from OPFS snapshots as a core feature, and a web-first host with a native Metal host from the same core.
- A two-resolution fracture-energy test as a gate on resolution-independent breaking.

---

# STRATA - Layered Reality Kernel (Laws and Materials -> Representations -> Solvers) (stance: layered-multiscale)

**Thesis.** Reality has one set of laws but no single affordable discretisation. On an A16, explicit steel at 1 cm needs about 9,800 substeps per frame and water about 2,500, against a budget of 2-8, so no one solver can be the substrate. The 2026 state of the art (Newton, Genesis) is multi-solver for the same reason. The permanent part of the engine therefore must not be a solver: it must be the laws and the matter.

STRATA keeps three things separate:
- L, Laws and Materials: balance laws kept as an auditable ledger, constitutive models, typed SI units, and a material database with provenance.
- R, Representations: interchangeable descriptions of the same matter, each with a declared validity regime.
- S, Solvers/backends: an f64 CPU reference oracle, an f32 SIMD CPU production path, and GPU kernels.

Every object is matter with a material. The engine runs the cheapest representation whose validity regime contains the object's current state and changes it when the state leaves that regime. A steel beam is a 6-DoF rigid body until its computed stress nears yield, then rigid plus elastic modes, then elastoplastic FEM, then fractured pieces. Across each hand-off mass is exact, momentum is exact to round-off, and energy is audited.

Why this stance wins on a phone:
- Fidelity is spent only where something is happening, which is the only way "as close to real life as possible" survives a roughly 4 W sustained envelope.
- It can start in Phase 0 as a few hundred rigid blocks on the user's iPhone and grow to bending, breaking, pouring and melting without a rewrite. Each new capability is a representation or solver plugged in under unchanged laws, materials and game API.
- Nothing is admitted until it passes analytical benchmarks and agrees with the neighbouring representation where their regimes overlap. Verification is built into the growth path.
- Games see matter, mechanisms, actuators and sensors, never solvers, so game code survives every fidelity upgrade.

Where the stance is weak:
- Hand-offs are the hardest part: pops, thrash at thresholds, and the awkward fact that stress must be estimated in a body modelled as rigid.
- The layering can become architecture for its own sake before anything is measured.
- Coupling between the CPU mechanism tier and the GPU continuum tier is partitioned and lags by a frame; a single unified solver would give more uniform emergent behaviour inside its (small) window than STRATA does across its seams.
- Total scope (seven representations, two hosts) is years of work, and only the early phases are low-risk.

## First-principles stance

Charter: "first principles" means continuum-scale balance laws hard-coded once; all object behaviour enters only through geometry plus constitutive models with measured SI parameters; every discretisation converges to its governing equation at a tested order; every shortcut is declared with a number. It does not mean atomistic simulation.

DERIVED (Tier 0-1; lives in the Laws layer and is shared by every representation):
- Balances of mass, linear momentum, angular momentum and energy, kept as a per-step ledger (kinetic, gravitational, elastic, plastic work, heat, electrical, external, numerical).
- Second law as an admissibility test on every constitutive model (dissipation >= 0, heat flows hot to cold), enforced by unit tests.
- Mass, centre of mass and inertia always computed from density x geometry, never typed in.
- Rigid body as the stiff limit of the same continuum; modal dynamics from linear elasticity (K and M from E, nu, rho); yield onset from the computed stress field against yield stress; buoyancy from integrated hydrostatic pressure; Fourier heat equation; Kirchhoff circuit laws; shallow water as depth-averaged flow with its validity ratio checked.

EMPIRICAL CLOSURES (Tier 2; measured parameters with source and uncertainty; pair properties stored per material pair):
Coulomb friction (static and kinetic), Hunt-Crossley contact dissipation and restitution, Hooke and Neo-Hookean elasticity, J2 plasticity with hardening, Drucker-Prager friction angle and cohesion, Newtonian and Herschel-Bulkley viscosity, Rankine and fracture-energy failure, conductivity, heat capacity, latent heat, DC-motor constants, battery internal resistance.

PHENOMENOLOGICAL (Tier 3; labelled as such): drag and lift coefficients on bodies, rolling and torsional resistance, sub-grid surface tension, unresolved turbulence, crack path at mesh resolution, the stress-screening bound used on rigid bodies.

NUMERICAL COMPROMISES (each has a reported metric):
1. Stiffness clamp: contact and elastic frequency limited to 1/4 of the substep rate (120 Hz at 480 Hz). Reports authored versus effective modulus.
2. Liquids solved in the incompressible limit with a fixed iteration budget. Reports residual divergence and density error.
3. Elastic wave-speed cap for soft solids in the particle tier. Reports real versus capped sound speed. Density, yield stress, friction angle, viscosity and thermal properties stay real; the scaling rule preserves Froude number and strength over rho*g*L.
4. Finite resolution (dx 1-4 cm, at most 16 modes, coarse tets). Reports dx and the convergence order measured in CI.
5. Gauss-Seidel non-convergence. Reports constraint residual.
6. Representation hand-off energy residual. Booked in the ledger.
7. Sleeping, float32, one-frame GPU-to-CPU coupling lag, and numerical viscosity (reported as an effective viscosity from Taylor-Green decay).

REPORTING: every object exposes a FidelityRecord (current representation, tier, authored versus effective parameters, active clamps, residuals). The world exposes the energy and momentum ledger every frame, a debug HUD draws it, and CI publishes a fidelity report per build. Physical dissipation (friction, plastic work, viscosity, Joule heating) becomes heat in the body. Numerical dissipation goes in its own bucket and is never relabelled as physics.

Out of scope by charter: quantum and atomistic, relativity, Maxwell field solves, shocks, resolved turbulence, detailed chemistry, wave optics.

## Architecture

THREE LAYERS, ONE-WAY DEPENDENCIES.

L - Laws and Materials: typed SI quantities; the balance-law ledger; a constitutive library of pure functions (strain, strain rate, temperature -> stress, heat flux, yield, failure); a material database starting with 12 entries (steel, aluminium, copper, oak, rubber, glass, concrete, ABS, ice, water, dry sand, clay); a pair table for friction and dissipation.

R - Representations of the same matter, each with a declared validity regime:
- S0 asleep or static.
- S1 rigid, including reduced-coordinate (Featherstone) articulations.
- S2 rigid plus up to 16 linear modes baked from a quadratic-tet eigenanalysis. Modes below 120 Hz use the exact exponential integrator; higher modes are quasi-static. Yields a stress field.
- S3 elastoplastic FEM: stable Neo-Hookean tets plus J2 plasticity as compliant constraints.
- S4 particle continuum (MLS-MPM with APIC transfers): Drucker-Prager granular, Herschel-Bulkley mud, liquids with a grid pressure projection.
- F0 hydrostatic analytic liquid; F1 shallow-water heightfield.
- N lumped thermal and electrical networks.

S - Solvers behind one contract (step, plus a mandatory residual report):
- REF: f64, scalar, simple; the oracle for every representation.
- CPU: f32, 4-wide SIMD, substepped soft-constraint Gauss-Seidel (the Soft Step lineage), graph-coloured, 8 substeps.
- GPU: WGSL compute for MPM, pressure and heightfield. Every GPU kernel has a CPU twin.

REPRESENTATION MANAGER. Picks the cheapest representation whose regime contains the object's state, from dimensionless indicators with hysteresis:
- S1 -> S2 when a screening bound (joint and contact wrenches through section formulas, x3 concentration factor) reaches 0.2 of yield.
- S2 -> S3 when any sample point reaches 0.8 of yield or deflection exceeds 2% of length.
- S3 -> fracture when the failure criterion holds and released strain energy covers fracture energy x new area. Pieces re-enter S1; debris enters S4.
- S3 -> S1/S2 after stress stays under 0.3 of yield for 0.5 s; the deformed rest shape is re-baked asynchronously.
- Solid -> S4 on melting or unbounded plastic flow; S4 -> frozen aggregate after 30 frames below a kinetic-energy-density threshold.
- Liquid moves between particles, heightfield and hydrostatic by distance from interaction and depth-to-wavelength ratio.

HAND-OFF PROTOCOL (transactional, at a substep boundary): mass moves through an integer ledger and is exact. The target state is fitted to reproduce linear and angular momentum to round-off. Promotions embed exactly. Demotions project, and the lost energy (unresolved vibration) is booked as heat. Each transaction is logged for replay.

INTERACTION PORT (avoids pairwise couplings): every representation exposes surface patches (point, normal, velocity, effective inverse mass, material) and accepts impulses.
- Tier A: all CPU representations are solved together in one substep loop.
- Tier B: the GPU continuum is coupled by partition. Collider primitives or SDFs and velocities go up; per-body wrenches accumulate in fixed-point i32 atomics (order-independent, so momentum closes exactly) and come back one frame later. GPU-side body proxies keep contact two-way within MPM substeps.

LEVEL OF DETAIL. Space: an awake bubble of 15-30 m inside a 256 m world; one 64-cubed MPM window. Time: per-island substeps of 8, 16 or 32; sleeping; 60 Hz thermal; background baking.

DETERMINISM CLASSES. CPU tier: bit-exact across x86-64, ARM64 and WASM. GPU tier: tolerance-level, checkpointed. Gameplay-authoritative mechanisms stay on the CPU.

## Frame budget

Targets on a cool device, sized so a 0.6 GPU thermal derate still fits 16.67 ms (research budget): GPU <= 10 ms (physics 4.5, render 5.5); CPU physics <= 4 ms wall; main thread < 8 ms; about 4 W; 20-30 minute soak.

TIME. Fixed frame 1/60 s. CPU tier: 8 substeps (1/480 s); flagged precision islands 16-32. MPM: 2-8 substeps from an advective limit of 0.8 cell per substep (deterministic rule). Thermal: 60 Hz (research: explicit conduction at 1 cm is stable to 0.15 s even for copper). Circuits: 480 Hz.

CPU SPLIT (web = one thread; native = 2 P-cores):
- Collision, once per frame with speculative margins: 0.8 ms
- Unified solve (rigid, articulations, FEM share it): 2.4 ms
- Modal: 0.2 ms
- Manager, stress screening, ledger, networks: 0.3 ms
- GPU coupling: 0.3 ms

CPU COUNTS (estimates, derivations shown):
- Rigid: Box3D on an M2 gives 555 stacked boxes per ms per core at 4 substeps (research). At 8 substeps, assuming the solver is 70% of cost: 326. Web: divide by 1.4 for WASM and 1.5 for immature code (both unmeasured assumptions) = about 155 per ms, so about 450 awake boxes or 135 convex hulls (hulls cost 3.3x) in 3 ms. Native, 2 P-cores, mature: 326 x 2 x 3 = about 1,950 boxes or 600 hulls.
- Robots: about 25 microseconds per humanoid step (derived from MuJoCo) x 8 = 0.2 ms per frame each; budget four articulations of up to 30 DoF.
- FEM: about 0.15 microseconds per tet-constraint (assumed about 150 flops) x 2 constraints x 8 substeps = 2.4 microseconds per tet per frame, so about 400 tets per ms, traded against boxes.
- Modal: 64 bodies x 16 modes x 8 substeps x about 20 ns = 0.16 ms.
- Sleeping or static: 20,000 bodies.

GPU CONTINUUM (estimate): design point 64k particle-substeps per frame, default 16k particles x 4 substeps. This sits at the upper edge of the research's conservative range (10-17k particles sustained with a heavy renderer) and below its optimistic 50-100k. The 8k tier is the guaranteed fallback and 32k the stretch; the Phase 0 on-device measurement replaces all three.
- Transfers: quadratic B-splines; particle-to-grid by counting sort plus gather, with fixed-point atomic scatter as an A/B option. About 3.4 ms.
- Grid: dense 64-cubed window with an 8-cubed block activity mask. dx 2 cm gives a 1.28 m cube; 4 cm gives 2.56 m.
- Matter: at 8 particles per cell, 16k particles is 16 litres at 2 cm or 128 litres at 4 cm - a bucket to a bathtub.
- Pressure: one 3-level V-cycle or 16 Jacobi sweeps per substep, <= 1 ms.
- Shallow water: 256 x 256 at 10 cm cells, about 0.1 ms.
- Render, 5.5 ms: forward PBR, instancing, one shadow map, half-resolution liquid surface, about 0.75 render scale.

MEMORY (estimate): particles 32k x 96 B = 3 MB; grid 64-cubed x 32 B = 8.4 MB; bodies 20k x 256 B = 5 MB; baked modes, tets and SDFs about 50 MB; snapshot ring 50 MB; assets about 150 MB. Total under 400 MB; hard cap 1 GB on web; every GPU buffer under 128 MiB.

PRECISION: CPU f32 with the world limited to +/-128 m (ulp about 8 micrometres at the edge); f64 world origins later; REF backend f64; GPU f32 in window-local cell units; mass ledger in integer micrograms.

GOVERNOR (decisions recorded as replay inputs): G1 lower render scale; G2 smaller particle tier for new promotions and a smaller awake bubble; G3 30 Hz presentation; G4 declared half-speed simulation. It never changes substep dt, material parameters or laws.

## Platform and toolchain

LANGUAGE AND GPU API: Rust (stable) + wgpu v30 + WGSL. This is the only surveyed stack where one codebase and one shader language reach both Safari WebGPU and native Metal with first-class support. WGSL is written to WebKit's stricter dialect from day one (no textures bound to let, constant arrays of at most 2,047 elements, large tables in buffers). Crates mirror the layers: laws (units, ledger), materials, one crate per representation, solve-ref (f64), solve-cpu (f32 SIMD), solve-gpu, host-web, host-ios, bench, validate.

FIRST ON-DEVICE DEMO (no Mac, no Apple account, no signing):
- The engine lives in a new repository; the existing PWA repo is not touched.
- The Linux container builds wasm32 (single-threaded, SIMD128) plus the WGSL kernels. A GitHub Actions job deploys a static site to GitHub Pages.
- The user opens the URL in Safari on iOS 26 or later (WebGPU is on by default) and adds it to the Home Screen for full screen and wake lock.
- Page 1 is a capability probe: adapter limits and features, cross-origin isolation, core count, memory growth, rigid and MPM-kernel microbenchmarks, and a 20-minute soak logger. It emits JSON for the user to paste back.
- Page 2 is the playable scene.
- World snapshots go to OPFS with persistent storage requested, because iOS kills the tab on memory overuse without signalling device loss.

WEB CONSTRAINTS ACCEPTED FOR PHASES 0-4: one physics thread (Rust WASM threads need a nightly toolchain plus a service-worker header shim on Pages); about 1 GB memory budget; integer-only atomics; 30 fps in Low Power Mode; no haptics; no thermal-state API, so the governor infers load from frame timing.

LONG-TERM PATH (native iOS):
- The same core built as a static library for aarch64-apple-ios, with a thin Swift shell and wgpu on Metal.
- Built and signed on GitHub Actions macOS runners (Xcode 26.6) using fastlane and an App Store Connect Team API key; delivered through TestFlight (builds valid 90 days).
- Requires the US$99/yr Apple Developer Program. A public repo gets free macOS runner minutes; private costs about US$0.062 per minute.
- Native adds both P-cores with NEON (E-cores for background baking), ProcessInfo.thermalState, Core Haptics, larger buffers, and an escape hatch below wgpu for hand-written Metal kernels (float-atomic scatter A/B, 1024-thread groups). Metal 4 is optional; no throughput gain is expected from it.

DETERMINISM TOOLCHAIN: no fused multiply-add, no fast-math, in-house sin/cos/atan2, fixed iteration and insertion order. WASM float semantics are fixed by spec, so the WASM build is the cross-platform reference; x86-64 and ARM64 builds are hash-compared against it in CI.

UNVERIFIED, TO BE MEASURED IN PHASE 0:
- The Safari-versus-native compute gap and the phone's real adapter limits.
- The WASM-versus-native CPU penalty and the cost of shader bounds checks.
- Whether software Vulkan runs the compute kernels headless in the container.
- Whether GitHub macOS runners expose a usable Metal GPU for kernel tests.

## Game-builder API

MODEL: a game is a set of blueprints (matter plus mechanisms) and controllers that sense and actuate. That is exactly what a robot gets from reality, and the game gets nothing more.

MATTER: a body is a shape (primitive, convex hull or baked mesh) plus a material name from the database. Mass, inertia, stiffness, strength, thermal and friction behaviour follow from the material and are not authored per object. Baking (hulls, modal bases, coarse tets, SDFs) runs offline or in the background.

MECHANISMS: joints are physical parts - revolute, prismatic, spherical, weld, bolt, glue - with bearing friction, backlash, compliance, and a breaking strength derived from material and cross-section.

ACTUATORS (stateful physics, split into transmission and dynamics as MuJoCo does): DC motor (torque constant, back-EMF, winding resistance, rotor inertia reflected through the gear ratio squared), gearbox (ratio, efficiency), linear actuator, spring and damper, heater, brake. They draw from energy sources (a battery with capacity and internal resistance) through a lumped circuit. A flat battery stops the robot.

SENSORS: encoder, IMU, force/torque, contact, strain, temperature, current and voltage, range (ray), fluid force. Noise and latency models are optional.

CONTROLLERS: deterministic callbacks at 60-240 Hz that read sensors and write actuator commands (voltage, PWM, or a setpoint to a built-in PID). The player's finger is itself an actuator: a force-limited spring-damper hand, capped at about 200 N by default.

UNITS: typed SI at the API with compile-time dimension checks. Supported range is declared: objects 1 cm to 10 m, 1 g to 10 t, with a warning above 1:1000 mass ratio inside one island.

QUERIES: raycast, overlap, closest point; read-only ground-truth state; the per-object FidelityRecord; the world energy and momentum ledger; a per-blueprint cost estimate against the reality budget (awake bodies, tets, particles), with explicit refusal or declared degradation.

AUTHORING: declarative text blueprints (materials by name, parametric shapes, joints, wiring); glTF for visuals; MJCF subset import; USD later; an in-app builder in the last phase.

DETERMINISM AND REPLAY: fixed step. A replay is the initial snapshot plus the actuator command stream plus governor decisions. CPU-tier state is bit-exact across phone, web and CI; GPU matter replays within tolerance from periodic checkpoints. Snapshot and restore is first-class and doubles as crash recovery.

NOT ALLOWED IN STRICT MODE: setting position or velocity, teleporting, forces at a distance, changing the mass or material of existing matter, creating or destroying matter mid-simulation, per-object time scale, disabling collision between touching matter.

ESCAPE HATCHES (explicit and audited):
1. Source and sink ports that add or remove matter with ledger entries.
2. An "unphysical" namespace (set pose, set velocity, external wrench, kinematic prescribed-motion bodies). Every call logs the momentum and energy injected and clears the session's strict flag.
3. Declared fictional boundary materials (unbreakable, immovable) for level design, because fully destructible worlds otherwise defeat objectives.
4. Whole-world pause and slow motion only.
5. Forcing or pinning an object's representation, shown in its FidelityRecord.

## Validation plan

Principle: verification checks the maths against closed forms and manufactured solutions; validation checks the physics against experiments. Both are automated, toleranced and run on every change. A representation or solver is not admitted until its tests pass.

RUNNING WITHOUT AN IPHONE:
1. REF (f64) and production (f32) backends run natively on x86-64 in the Linux container.
2. The same WASM binary that ships runs under a headless runtime; its state hashes must equal x86-64's. CPU-tier bit-exactness is what lets CI trajectories stand in for the phone.
3. GPU kernels run on software Vulkan through wgpu if that works; otherwise they are compared with their CPU twins on a macOS runner.
4. The phone gets a self-test page: a 2-minute subset plus soak telemetry, exported as JSON.

TIER 0 (exact):
- Mass ledger drift = 0.
- Closed-system linear and angular momentum drift <= 1e-5 relative over 10 s (f32), <= 1e-12 (REF).
- Dimension errors fail to compile.
- 10,000-step state hash identical on x86-64 and WASM.

TIER 1 (closed forms):
- Free fall against the exact discrete solution; order 1 confirmed.
- Pendulum period including the amplitude series <= 0.5%; energy bounded within 0.1% over 60 s with no secular drift.
- Dzhanibekov: angular momentum <= 1e-4, kinetic energy <= 0.5% over 30 s.
- 1:1000 mass-ratio chain stretch <= 1%; 10-box stack creep < 1 mm in 60 s.
- Incline slip at atan(mu_s) +/- 0.5 degrees; sliding stop distance v^2/(2*mu*g) <= 2%; sliding-cube energy curve <= 3%.
- Cantilever P*L^3/(3EI) <= 2% (modal), <= 5% (FEM), measured order >= 1.8; first bending mode <= 2%; Euler buckling <= 5%; plastic-hinge collapse load <= 10%.
- 1D conduction <= 1% with manufactured-solution order 2; Stefan melting front <= 5%.
- Hydrostatic pressure <= 2%; Archimedes float depth <= 1e-4 (analytic liquid), <= 5% (particles); Torricelli efflux <= 10%.
- RC time constant <= 0.5%; DC-motor stall torque and no-load speed <= 1%.

TIER 2 (experiments):
- Drop-bounce restitution within 5% of authored.
- Martin and Moyce dam-break front <= 10% RMS.
- Granular column run-out: exponent +/- 0.1, prefactor +/- 20%; angle of repose = friction angle +/- 2 degrees.
- MFIX DEM02 bounce heights.
- Cube-toss dataset: tracked, not gated. Target <= 20% of cube width; fitted research simulators sit at 13.5-25%.

TRACKED AND PUBLISHED (not gated): effective numerical viscosity from 2D Taylor-Green decay; effective versus authored modulus; residual divergence.

STANCE-SPECIFIC GATES:
- Representation equivalence: the same scenario forced into rigid, modal and FEM (and into hydrostatic, heightfield and particle liquid) agrees within 3% wherever regimes overlap.
- Hand-off audit: every transition conserves mass exactly and momentum <= 1e-5, with energy residual < 1% of kinetic energy and fully booked.
- No-thrash: a load hovering at a threshold causes at most one transition per second.
- Production solver trajectories stay within tolerance of REF.

Output: a versioned fidelity report (tests, errors, tolerances, active clamps) published with every build.

## Roadmap

### Phase 0 - Probe and first matter (web)
- Goal: Prove the Linux-container-to-iPhone delivery loop, measure the real phone, and stand up the Laws and Materials layer with one representation.
- Deliverables: New repo with CI and GitHub Pages deploy. Typed SI units, conservation ledger, 12-material database with provenance. Rigid bodies (sphere, box, capsule, convex hull) with a substepped soft-constraint solver at 8 substeps; f64 reference backend and f32 WASM production backend. WebGPU renderer. Touch 'hand' as a force-limited actuator. Capability probe page with rigid and synthetic MPM-kernel microbenchmarks and a 20-minute soak logger.
- Exit criteria: The user opens a URL on the iPhone 15 and throws and stacks steel, oak and rubber blocks. 300 awake boxes hold 60 Hz (p95 frame under 16.7 ms) for 20 minutes. Probe JSON is returned with adapter limits, particle-substeps per ms and the WASM penalty. Tier 0 plus eight Tier 1 tests are green; x86-64 and WASM state hashes match over 10,000 steps.

### Phase 1 - Mechanisms: robots on reality
- Goal: Make the engine a place where machines are built from parts, powered and controlled only through actuators and sensors.
- Deliverables: Reduced-coordinate articulations; joints with friction, backlash and breaking strength; DC motor, gearbox, spring, battery and lumped circuits; sensor set; controller API; blueprint format v1; MJCF subset import; snapshot and deterministic replay; strict mode with audited escape hatches.
- Exit criteria: A motorised rover and a 6-DoF arm, built from blueprints only and driven by voltages, run on the phone. Motor tests pass at 1%; pendulum, 1:1000 chain and Dzhanibekov tests pass. A 60-second replay recorded on the phone reproduces the same final hash in CI.

### Phase 2 - Solids that bend and yield (first representation switch)
- Goal: Demonstrate the core claim: one object changing representation by need, with audited hand-offs.
- Deliverables: Baking pipeline (quadratic-tet modal bases, coarse tets). Rigid-plus-modes and elastoplastic FEM representations. Stress screening. Representation manager with hysteresis and the hand-off ledger. FidelityRecord and debug HUD. Lumped and field thermal.
- Exit criteria: Cantilever, first-mode, buckling and plastic-hinge tests pass at their tolerances. Equivalence, hand-off audit and no-thrash gates pass. On the phone a steel beam under rising load goes rigid, then bends, then takes a permanent set, with frame time inside budget.

### Phase 3 - Breaking and granular matter (GPU tier)
- Goal: Add fracture and the particle continuum, coupled to mechanisms with a closed momentum ledger, under a thermal governor.
- Deliverables: Fracture by Rankine and fracture-energy criteria, splitting FEM into rigid pieces plus debris. GPU MLS-MPM with Drucker-Prager and Herschel-Bulkley models in a 64-cubed window. Partitioned coupling with integer wrench accumulation and GPU body proxies. Freeze and thaw of settled matter. Governor with recorded decisions.
- Exit criteria: Granular column collapse and angle-of-repose tests pass. Coupling momentum closes to 1e-5. The measured sustained particle tier (target 16k particles at 4 substeps) holds 60 Hz for 20 minutes with a rigid scene active. The beam demo now ends in fracture with mass exactly conserved.

### Phase 4 - Liquids and phase change
- Goal: Liquids at three levels of detail and heat-driven change of state, all on the same material data.
- Deliverables: Grid pressure projection for particle liquids. Hydrostatic analytic and shallow-water heightfield representations with hand-offs. Buoyancy and viscosity. Melting and freezing with latent heat.
- Exit criteria: Hydrostatic at 2%, Torricelli at 10%, dam break at 10% RMS, Stefan front at 5%. Density error under 1% at the default tier, reported live. A boat blueprint floats on the phone at the analytically predicted draft within 5%.

### Phase 5 - Native iOS host
- Goal: Remove the browser ceiling without changing the core, laws, materials or game API.
- Deliverables: macOS-runner build, sign and TestFlight pipeline. Two-P-core job system with NEON. Thermal-state governor. Haptics. Optional hand-written Metal kernels. Three-way benchmark (Safari WebGPU, wgpu on Metal, raw Metal).
- Exit criteria: A TestFlight build runs on the user's phone. CPU-tier replay hashes equal the web build's. Awake-body count is at least 2x the web build. A 30-minute soak stays at thermal state 'fair' or better and uses no more than about 17% battery (4.3 W for 30 minutes of a 12.98 Wh pack).

### Phase 6 - Builder kit and first game
- Goal: Prove that a game can be built on the engine the way a robot is built on reality, using only the public API.
- Deliverables: In-app builder; blueprint library; telemetry and replay tools; designer boundary materials; documentation including the published fidelity ladder and report; one sample game (build a machine that moves a load across a gap).
- Exit criteria: The sample game ships in strict mode with no engine changes made for it. A new mechanism can be authored on the phone without code. The fidelity report is public and every feature is tagged with its tier.

## Risks
- Hand-off artefacts: visible pops, energy jumps or thrash when an object changes representation. This is the stance's central risk. — Mitigation: Hysteresis thresholds; transactional hand-offs with booked residuals; promotions are exact embeddings; equivalence and no-thrash tests gate every transition; per-object pin override; switching only arrives in Phase 2, after rigid bodies are solid.
- Stress in a body modelled as rigid is only an estimate. Screening can miss concentrations (late promotion) or over-trigger (wasted cost). — Mitigation: Conservative section-formula bound with a x3 factor; modal stress field as a cheap second stage; calibration against the f64 FEM reference on a corpus of shapes; the screening rule is labelled Tier 3 in the fidelity report.
- Architecture before evidence: the three-layer design becomes a framework that is never finished. — Mitigation: No abstraction lands without two concrete implementations (reference plus production). Phase 0 ships one representation. Interfaces are allowed to change until Phase 3.
- Seams between tiers: partitioned CPU-GPU coupling with a one-frame lag can go unstable for light bodies in dense matter, and gives less uniform emergence than a monolithic solver. — Mitigation: GPU-side body proxies; impulse limits enforced by the momentum ledger; an added-mass test (light float in liquid) as a gate; small volumes of attached soft matter stay on the CPU tier.
- GPU continuum throughput on Safari WebGPU on an A16 is unmeasured; estimates span 10k to 100k particles. — Mitigation: On-device microbenchmark in Phase 0, before any MPM design is frozen; 8k/16k/32k tiers; the engine stays useful with rigid, modal and FEM representations alone.
- Real stiffness cannot be time-resolved for steel or water, so promoted metal may look too soft. — Mitigation: The elastic regime is handled by modal quasi-statics using the real modulus. FEM is entered only near yield, where plastic flow at the real yield stress dominates. The modulus clamp is bounded so yield strain stays under 2%, and is reported.
- WebKit quirks: stricter WGSL compiler, iOS-only WebGPU crashes, tab kill near 2 GB, 30 fps in Low Power Mode. — Mitigation: WebKit-strict shader dialect; shader smoke test inside the probe page; 1 GB memory cap; OPFS snapshots with resume; a supported 30 Hz presentation mode; the native host as the durable path.
- Thermals: sustained GPU output is 50-85% of peak, and the web build cannot read thermal state. — Mitigation: Budgets sized at 60% of cool-device capacity; governor driven by measured frame time; settled matter sleeps; a 20-minute soak is an exit criterion from Phase 0 onward.
- No device in CI: all on-device evidence depends on the user's phone and time. — Mitigation: CPU-tier bit-exactness makes CI trajectories representative; the self-test page exports JSON; on-device requests are kept short and batched per phase.
- Contact realism ceiling: friction and restitution are empirical, and even fitted research simulators miss real cube tosses by 13-25% of cube width. — Mitigation: Label contact Tier 2; derive compliant normal contact from material data; publish the cube-toss metric; make no claim beyond what the report shows.
- Scope: seven representations and two hosts amount to years of work. — Mitigation: Every phase ships a runnable, validated increment. Later phases can be cut or reordered without invalidating earlier ones.
- Simulation-first projects often struggle to become games (the Noita and Teardown experience). — Mitigation: Boundary materials, strength and energy budgets as natural gating, replay and telemetry from Phase 1, and a sample game as the final exit criterion.
- Determinism erosion from the GPU tier, governor decisions and background baking. — Mitigation: Governor decisions and bake completions are recorded replay inputs; GPU state is checkpointed; gameplay-authoritative state stays on the CPU tier.

## Non-goals
- Atomistic, quantum or relativistic physics; Maxwell field solves (magnets and motors are lumped models).
- Resolved compressible gas dynamics, shocks and explosions; resolved turbulence; detailed combustion chemistry.
- Time-resolving the real stiffness of metals or the real compressibility of water. These are declared clamps, not targets.
- Light transport or wave optics as part of the physics claim. Rendering is separate, and the A16 has no hardware ray tracing.
- Acoustic wave propagation in air. Modal object sound may come later as a cheap by-product of the modal representation.
- One universal solver or a single-substrate world. The plan deliberately uses several representations under one set of laws.
- Open worlds of kilometres in the first version. The world is 256 m, the awake bubble 15-30 m, and resolved flowing matter is a bucket to a bathtub.
- Bit-exact GPU results across devices, and rollback netcode or multiplayer in the first version.
- Learned or neural physics surrogates as the authority for behaviour.
- A full visual editor comparable to Unity or Unreal; authoring is text blueprints plus a simple in-app builder.
- Android, desktop or Pro-only features (120 Hz, ray tracing) as supported targets, although the web build may happen to run elsewhere.
- Embedding or wrapping a third-party physics engine as the core. Box3D, Jolt, Rapier, MuJoCo and Newton are references and oracles only.

## Decisions for the user
- Will you pay for the Apple Developer Program (US$99/yr)? It is required for the native app (Phase 5). Without it the engine stays a Safari web app with one physics thread, about half the body count, no haptics and a roughly 1 GB memory budget. If you buy it early, the native phase can move up to right after Phase 1.
- Should the engine's new repository be public or private, and under what licence? Public gets free macOS build minutes and makes the fidelity report open; private costs about US$0.062 per macOS minute. Either way I recommend not putting it in your existing PWA repo.
- What should the first game be, and at what scale? My default is a workshop-scale machine and robot sandbox (1-3 m of active matter), which fits the phone's budget best. Vehicles or outdoor terrain would change the resolution and which representations get built first.
- Are you willing to be the device lab? Each phase needs you to open a page, run a probe or a 20-30 minute soak, and paste back a block of JSON. Please also say which iOS version the phone runs (26 or later is required) and whether you use a case.
- When the phone gets hot, which do you prefer by default: full fidelity at 30 fps, or 60 fps with less matter resolved? The engine will not change physical laws or timesteps either way.
- Do you expect to want multiplayer or rollback later? If yes, gameplay-critical matter must stay on the bit-exact CPU tier and GPU-simulated matter cannot decide outcomes; that is cheaper to commit to now.
- How strict should games be by default? Strict mode forbids teleports, velocity edits and conjured matter, with audited escape hatches. Should your own games start in strict mode with opt-in exceptions, or permissive with a 'physical purity' score?

## Red-team review — feasibility lens

Scores (0-10): realism 5, feasibility_on_a16 4, first_principles_integrity 6.5, game_buildability 6, delivery_safety 4.5

**Verdict.** Phases 0-1 are reachable and the delivery path from the Linux container to the phone works; Phases 2-4 do not work as specified. The plan is honest about its unknowns, but its own numbers fail where they can be checked.

- **Stiff deformables:** the shared Gauss-Seidel loop caps steel at a few MPa, so the flagship rigid-to-bending-to-yield hand-off turns a steel beam into rubber.
- **Granular matter:** the substep rule ignores elastic wave speed, and throughput sits about 3-5x above the only iPhone anchor, leaving roughly 1-3 litres of honest sand rather than 16.
- **CPU budgets:** web figures for boxes, robots and tets are optimistic by about 2-6x.
- **Thermals:** the budget runs the phone at its thermal ceiling by design, with no margin on web.
- **Delivery:** it needs a public repo (or a paid plan), a separate origin from the existing PWA, and a few manual user steps the plan omits. The first device contact should be a days-long probe, not the end of a large Phase 0.
- **Scope:** nine solver units with double or triple implementations and no timeboxes will stall after Phase 1 unless cut to about three representations.

Keep the laws/materials layer, the fidelity reporting, the determinism split and the web-first loop. Replace S3 with reduced-order or implicit plasticity, and make S4 time-step-robust or much smaller.

Web search was unavailable (budget exhausted). I verified by direct fetch only GitHub's Pages plan gating, the PhoneFluid README and shader, wgpu's CI workflow, fastlane's API-key table and one Box3D CSV. Readback latency, the JavaScriptCore WASM penalty and per-dispatch overhead are from memory or estimated and need the probe.

### Fatal flaws
- S3 (elastoplastic FEM as compliant constraints in the shared 8-substep Gauss-Seidel loop) cannot represent stiff matter, so the flagship steel-beam hand-off in Phase 2 fails as designed. Two of the plan's own declared rules contradict each other by about 4,500x in modulus. — Evidence: Compromise 1 caps elastic frequency at 120 Hz. For a 5 cm steel tet (element frequency roughly c/(pi*h), my estimate) that allows c of about 19 m/s, so E_eff is about 2.8 MPa against 200 GPa. The plan's bound 'yield strain under 2%' needs E_eff >= 250 MPa / 0.02 = 12.5 GPa (c about 1,260 m/s), which is about 540 substeps per frame against 8-32 budgeted. At 2.8-4.5 MPa a 1 m x 5 cm steel cantilever sags more than 10 m under its own weight (q*L^4/(8EI), q = 192 N/m) against 0.23 mm at the real modulus. The 'exact embedding' S2->S3 promotion is therefore a four-orders-of-magnitude stiffness jump, and the FEM cantilever (5%), plastic-hinge (10%) and 3% equivalence gates cannot pass on the production solver. Even real rubber (5 MPa) needs about 28 substeps at 5 cm tets under the same rule. It survives only if S3 leaves the Gauss-Seidel loop for reduced-order plasticity in the modal basis or a prefactored implicit solve.
- The GPU continuum design point (16k particles x 4 substeps, substeps set by an advective limit) is unsupported for granular and mud, which are the Phase 3 deliverable. The substep rule ignores the elastic wave-speed limit, and the throughput is above the only iPhone-measured anchor. — Evidence: At dx 2 cm and 4 substeps the explicit ceiling is 4.8 m/s (research). A 25 cm deep bed (the plan's 16 litres) then strains g*h/c^2 = 2.45/23, about 11%, at its base, with flow Mach number about 0.46. Holding 1% needs c of about 16 m/s, i.e. at least 13 substeps at CFL 1 and about 27 at CFL 0.5. Separately, 64k particle-substeps in 3.4 ms is 18.8k per ms; the PhoneFluid anchor scaled to A16 gives roughly 3-6k per ms (range 1.5-14x below the plan, because that app's substep count and render share are unpublished; I checked its README and shader). That app is native Metal with a Tait equation of state, with no pressure projection, no per-particle SVD and no body proxies. Together this leaves on the order of 1-3k particles of honest sand at 2 cm, not 16k, unless S4 moves to a time-step-robust formulation (which the research recommended) or to 4 cm cells.

### Fixable flaws
- Phase 0 bundles a from-scratch 3D rigid engine (hulls, f64 reference plus f32 production), a WebGPU renderer, typed units, a ledger and a 12-material database before the first device measurement. The probe that should steer every later budget is not a separate, earlier gate. — Fix: Split it. Phase 0a is a plain JS + WGSL probe page with no engine and no wgpu, shipped within days, whose exit is the returned JSON. Phase 0b is rigid boxes and spheres only, with hulls, capsules and most materials moved to Phase 1.
- The Phase 0 MPM benchmark is 'synthetic kernels'. It will overstate throughput because it omits the per-substep counting sort, the SVD return mapping, the pressure sweeps, about 110-120 compute dispatches per frame, the renderer and the thermal soak. — Fix: Benchmark the real kernel chain end to end at 4k/8k/16k particles with the renderer on for 20 minutes. Also record per-dispatch overhead, buffer readback latency in frames, timestamp-query availability, Low Power Mode and Lockdown Mode, in both a Safari tab and Home Screen mode.
- Several exit criteria are not measurable or not falsifiable. 'p95 frame under 16.7 ms' cannot be read from vsync-quantised requestAnimationFrame with 1 ms timers. Phase 3 passes at whatever particle tier is measured, so it cannot fail. No phase has a timebox or a descope trigger. — Fix: Restate as dropped-frame fraction (for example under 2% of intervals above 25 ms over 20 minutes) plus CPU step time measured with 20 microsecond timers; a COOP/COEP service-worker shim gives those without nightly Rust. Add a numeric floor per phase (for example, under 4k sustained particles at test-passing substeps means the GPU continuum is descoped) and a timebox with a named cut list.
- Delivery details are missing. GitHub Pages on a Free account works only for public repos (checked in GitHub's docs source), so the 'private' option silently breaks Phase 0. The session can only reach the existing repo, so a new repo and the Pages source setting need user steps. The existing PWA is a project site with no custom domain and uses client storage, so a second project site shares its origin in Safari. — Fix: Tell the user up front: public repo, or a paid plan. List the one-time manual steps. Serve the engine from a different origin (custom subdomain or separate account/organisation), or namespace every storage key and OPFS directory and never clear storage at origin level.
- WebKit's WGSL compiler and iOS-only WebGPU crashes can only be exercised on the user's phone, with results pasted back by hand. For the 20-30 kernels of Phases 3-4 that loop can stall the project. — Fix: Make a Safari shader-compile smoke test on a macOS runner a Phase 0 exit item (wgpu's own CI runs GPU tests on macos-26 and on Linux Mesa, so both are probably usable). Add a one-tap 'send results' button (share sheet or a prefilled issue link) instead of copy-paste. Keep a CPU twin for every kernel so logic bugs are found in the container.
- The CPU tier's first demo depends on WebGPU staying up for 20 minutes, yet the research lists an iOS Metal-backend crash that builds over about 70 seconds and scales with mesh count. A renderer crash would block Phase 0 although the physics is pure CPU. — Fix: Draw all boxes in one instanced call and add a minimal WebGL2 fallback renderer for the CPU tier. Make the Phase 0 physics exit independent of which renderer is used.
- Verification multiplies the scope. Nine representation/solver units, each with an f64 reference and an f32 SIMD path, three with GPU kernels plus CPU twins, and about ten hand-off types each carrying three gates, all written from scratch with third-party engines excluded. — Fix: Version 1 has three representations: rigid plus articulations, one reduced-order deformable, one particle/liquid tier. The reference is the same generic code in f64 with converged iterations, and independent oracles (Rapier, MuJoCo, Box3D) are used offline in the container. F0/F1, fracture re-meshing and field thermal wait until Phase 0 numbers justify them.
- Runtime baking is unbudgeted. After a plastic set or fracture the plan re-bakes hulls, coarse tets and a quadratic-tet eigenanalysis on the phone in single-threaded WASM, and it needs a tet mesher that does not exist in the stack. — Fix: Pre-fracture and pre-bake offline in CI. Use structured lattice tets for anything meshed at runtime, cap runtime bakes at one per second in a Web Worker, and let new fragments stay plain rigid.
- The web governor cannot see thermal state, and Safari halves requestAnimationFrame under thermal mitigation or Low Power Mode. The plan sizes GPU work at exactly the 0.6 derate, so it leaves no margin against the 51% stability figure in the research. — Fix: Size sustained budgets at 0.5 of cool capacity (GPU about 8 ms cool). Detect the 30 Hz cadence explicitly and switch to two fixed steps per presented frame, and make 30 Hz presentation at full-speed simulation a passing state for web soaks.
- The native path has manual steps the plan does not list. fastlane's `produce` does not accept an App Store Connect API key (checked in fastlane's docs), so the app record cannot be created from CI. The Xcode project cannot be built or tested in the Linux container, so each fix costs a 10-15 minute runner cycle. — Fix: Give the user a preflight checklist (enrol, accept agreements, create the app record and bundle ID, create a Team API key). Generate the Xcode project from a spec file, and stand up an empty 'hello triangle' TestFlight build as its own early milestone before porting anything.
- A 12-material database with sourced uncertainties plus a pair table (78 pairs, each with static and kinetic friction and dissipation) is a Phase 0 deliverable. Measured data does not exist for many pairs, and the research sessions repeatedly could not open primary sources. — Fix: Start with four materials and about six measured pairs. Label every other pair as a Tier 3 mixing-rule default in the FidelityRecord.

### Numbers challenged
- Web build: about 155 boxes per ms, so about 450 awake boxes (or 135 hulls) in 3 ms. → Expect about 40-110 boxes per ms, so 110-330 awake stacked boxes in 3 ms (central about 180). The Phase 0 exit of 300 boxes is still reachable because nothing else runs, but at roughly 3-8 ms of CPU, not 2. (basis: 326 per ms native is Box3D with hand-written graph-coloured NEON. The research's own Box2D data shows a 3.4-3.6x penalty without SIMD, so 1.5x for 'immature' is optimistic (use 2-3.5x). The 1.4x WASM factor is unmeasured; 1.5-2.5x on JavaScriptCore is my estimate from memory.)
- Four articulated robots at 0.2 ms per frame each. → About 0.42 ms each on web, so about 1.7 ms for four. That is 70% of the 2.4 ms unified solve and leaves room for roughly 100 boxes, not 450. (basis: The plan applied its 1.4 x 1.5 web factors to boxes but not to robots. The 25 microsecond figure is optimised MuJoCo C on an M3 Max with few contacts.)
- FEM costs 0.15 microseconds per tet-constraint, about 400 tets per ms. → About 0.4-1.0 microseconds per constraint on web, so 60-150 tets per ms; and the effective modulus is set by the iteration count, not by the material. (basis: Each constraint needs the deformation gradient, gradients for four nodes, scatter across 20 or more colours and a polar/SVD return map for J2, which is 300-500 flops before web penalties (my estimate). 150 flops is not supported by any research figure.)
- The modulus clamp is bounded so yield strain stays under 2%. → Under the 120 Hz rule, steel at 5 cm tets gets E_eff of about 2.8 MPa, which is a yield strain near 9,000%. The 2% bound needs 12.5 GPa, i.e. about 540 substeps per frame. (basis: E_eff = rho*(pi*f*h)^2 with rho 7,850, f 120 Hz, h 0.05 m; required c = sqrt(12.5e9/7850) = 1,262 m/s.)
- Default 16k particles x 4 substeps, transfers in about 3.4 ms; 8k is the 'guaranteed' fallback. → Plan on about 3-8k liquid particles at 4 substeps until measured. Nothing guarantees 8k: it still needs 9.4k particle-substeps per ms. (basis: PhoneFluid scaled by 2.75x gives about 15.6k particles cool for a whole native Metal frame at an unpublished substep count, or 3-6k particle-substeps per ms for plausible substep and render shares. The laptop WebGPU anchor would allow the plan's figure, so the two anchors disagree by 5-10x.)
- MPM needs 2-8 substeps from an advective limit of 0.8 cell. → Granular and mud need 13-27 or more substeps at 2 cm for 1%-level self-weight compression; at 4 substeps a 25 cm bed compresses about 11% at its base. (basis: Explicit stability is set by elastic wave speed: c <= dx/dt = 4.8 m/s at 4 substeps (research), strain = g*h/c^2. The research notes the published snow parameters need at least 16 substeps at this resolution.)
- Pressure: one 3-level V-cycle or 16 Jacobi sweeps per substep within 1 ms, giving density error under 1%, hydrostatic 2% and Torricelli 10%. → 16 Jacobi sweeps remove only about 37% of the smooth residual per substep for a 13-cell-deep volume; a cold 1% answer needs about 160 sweeps (about 840 at 30 cells). The two options are not equivalent, and the 64 pressure dispatches per frame have an unmeasured fixed cost. (basis: Jacobi damping factor per sweep is about 1 - pi^2/(2N^2) for N cells of depth. At a guessed 20 microseconds per dispatch, 115 dispatches cost 2.3 ms.)
- About 4 W on a cool device, and thermal state 'fair' or better for 30 minutes (Phase 5). → The cool-device draw of the stated budget is about 5.5-6 W, so throttling to the 0.6 derate is the normal operating point within minutes. No research figure shows 'fair' being held at 4.3 W. (basis: GPU at 60% duty x about 7 W (Aztec average) = 4.2 W, plus about 0.9 W idle/display and 0.5-1 W for a P-core at 25-50% duty. The 4.3 W Genshin figure is a throttled average with no thermal state reported. All inputs are unverified search excerpts.)
- GPU-to-CPU coupling lags by one frame. → Assume 2-3 frames (33-50 ms) on Safari WebGPU until the probe measures it. That tightens the added-mass stability limit for light bodies. (basis: Buffer readback is asynchronous through the GPU process; 2-3 frame latency is typical in browsers (from memory, not measured on iOS).)
- Pendulum energy bounded within 0.1% over 60 s at 8 substeps. → A first-order semi-implicit update at 1/480 s oscillates by about +/-0.33% for a 1 m pendulum. The gate needs about 27 substeps, a second-order update, or a 0.5% tolerance. (basis: Symplectic Euler conserves a modified energy; the true energy oscillates with relative amplitude omega*dt/2 = 3.13 x 0.00208 / 2.)
- Representations agree within 3% wherever regimes overlap. → This is tighter than the plan's own closed-form tolerances for the same representations (FEM cantilever 5%, particle Archimedes 5%, Torricelli 10%), so the gate is internally inconsistent. For stiff FEM it is unreachable. (basis: Comparison of the plan's Tier 1 tolerances with its stance-specific gate, plus the stiffness derivation above.)
- Phase 5 soak uses no more than about 17% battery. → The arithmetic is right for a new 12.98 Wh pack, but a three-year-old pack at about 85% health reads about 19.5% for the same energy. Normalise by battery health or measure energy another way. (basis: 4.3 W x 0.5 h = 2.15 Wh; 2.15 / (12.98 x 0.85) = 19.5%. The 85% health figure is an assumption.)
- Baked modes, tets and SDFs take about 50 MB. → More like 100-200 MB when shapes are unique (64 modal bodies at 1-2 MB each, plus 1 MB per 64-cubed f32 SDF). The total still fits under 1 GB; memory is not the binding limit. (basis: 16 modes x 3 components x about 5k nodes x 4 B is about 1 MB per body before stress bases; I found no memory blocker in this plan.)

### Best ideas to keep
- Web-first delivery: a wasm32 + WGSL static site on GitHub Pages opened in Safari, with native TestFlight later from the same Rust/wgpu core. I checked the container: Rust 1.97, Node 22 and clang are present, and the Rust, crates and Ubuntu hosts are reachable, so the Linux-side loop is real.
- A capability probe and a 20-minute soak on the user's own phone before any continuum design is frozen, with 8k/16k/32k tiers replaced by measured numbers.
- Laws and materials as the permanent layer: mass and inertia from density x geometry, per-pair friction data, provenance on every number, typed SI units at the API.
- FidelityRecord per object (authored versus effective parameters, active clamps, residuals) and an energy ledger that keeps numerical loss in its own bucket, never relabelled as physics.
- Rigid plus quasi-static modes with the real modulus (S2) as a cheap stress estimator. It is the one deformable representation here that can honour real steel stiffness on a phone, and it should carry plasticity too.
- CPU-authoritative deterministic tier with the WASM build as the cross-platform reference and the GPU tier held to tolerance only; a replay is snapshot plus actuator commands plus governor decisions.
- A governor that changes render scale, particle tier and awake bubble but never substep dt, materials or laws, with its decisions recorded.
- Snapshot and restore to OPFS as a first-class feature, because iOS kills the tab without a device-lost signal.
- Game API as blueprints, actuators that draw from a battery through a lumped circuit, sensors, strict mode with audited escape hatches, and a per-blueprint cost estimate that can refuse.
- Integer fixed-point wrench accumulation so CPU-GPU momentum exchange closes exactly regardless of thread order.
- A tiered, toleranced validation suite with a published fidelity report, including forcing one scenario through neighbouring representations to compare them.
