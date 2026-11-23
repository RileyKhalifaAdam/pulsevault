export const meta = {
  name: 'reality-engine-plan',
  description: 'Research the iPhone 15 budget and simulation state of the art, draft three independent engine architectures, and red-team each one',
  phases: [
    { title: 'Research', detail: 'five parallel web-verified research sweeps (hardware, continuum methods, contact solvers, toolchain, first-principles validation)' },
    { title: 'Design', detail: 'three independent architectures from different stances' },
    { title: 'Red-team', detail: 'two adversarial lenses per architecture' },
  ],
}

const CONTEXT = `
PROJECT CONTEXT (planning only — nobody is writing code yet):
The user wants a "reality engine": a physics engine that is as close to real life as possible, with FIRST PRINCIPLES as a core philosophy
(conservation laws, constitutive material models, SI units, measured material parameters — not scripted special cases), that runs in real time
on a base iPhone 15 (A16 Bionic, 6 GB RAM, 60 Hz display — NOT the Pro), and serves as the backbone on which games are built
"the way someone builds a robot on top of reality": game objects are made of matter, materials and mechanisms, and behaviour emerges from the simulation.
Today's date is 2026-11-23. The development environment is a Linux cloud container with no Mac/Xcode attached; the user follows along from the Claude app
and wants to run the result on their own iPhone 15. Their existing repo is an unrelated small static PWA deployed with GitHub Pages.
Do NOT write code. Do NOT create, edit or delete any files in the repository. Your final output is data for the lead architect, not a message to a human.
`

const RESEARCH_RULES = `
RESEARCH RULES:
- Verify with the web. Use the WebSearch tool (if it is deferred, load it with ToolSearch query "select:WebSearch") and a page-fetch tool or the web-fetch agent if you have one. Prefer primary sources: papers, vendor documentation, engine source/docs, published benchmarks, conference talks.
- Every quantitative claim needs a source URL. Set verified=true ONLY if you actually opened a source this session that supports it; otherwise verified=false and put "memory" (or the URL you could not open) as the source.
- Be precise about dates and versions; things changed in 2025-2026, so do not rely on memory for platform support claims.
- Return at most 30 findings, each one or two sentences, highest-value first. Numbers over adjectives.
- "implications" = concrete consequences for the engine design. "open_questions" = things that could not be settled and need a prototype/measurement.
`

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    area: { type: 'string' },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          source: { type: 'string' },
          verified: { type: 'boolean' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['claim', 'source', 'verified', 'confidence'],
      },
    },
    implications: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['area', 'summary', 'findings', 'implications', 'open_questions'],
}

const AREAS = [
  {
    key: 'hardware',
    prompt: `RESEARCH AREA: the real compute budget of a base iPhone 15.
Establish, with sources: A16 Bionic CPU (core counts, P/E split, clock, SIMD extensions actually present — NEON/ASIMD, and whether SVE/SME exist on A16), GPU (core count, rough compute throughput, Metal feature family, whether Metal 4 runs on A16, fp64 availability on GPU, max buffer/texture sizes, compute threadgroup limits), memory (6 GB total, the practical per-app jetsam limit and the increased-memory-limit entitlement, unified memory implications, memory bandwidth), display (60 Hz on the base model), and THERMALS (sustained vs peak performance — e.g. 3DMark Wild Life Extreme stress-test stability numbers for iPhone 15 / A16 — and what sustained power budget that implies).
Then find REAL measured real-time simulation throughput on this class of hardware (A15/A16/A17/M1-class Apple GPUs, or mobile/integrated GPUs with a stated conversion): particles per frame for MLS-MPM, PBF/SPH, XPBD on GPU via Metal or WebGPU; rigid body counts for CPU engines (Jolt, Box2D v3, PhysX, Rapier) on mobile ARM. Name the demos/papers/products and their numbers (e.g. WebGPU MLS-MPM demos, Zibra Liquids mobile, Unity/Unreal mobile physics guidance).
Finish with a defensible per-frame budget: how many ms of CPU and GPU can physics take at 60 Hz while leaving room for rendering and staying thermally sustainable for a 20+ minute session.`,
  },
  {
    key: 'continuum',
    prompt: `RESEARCH AREA: continuum and particle methods for simulating matter itself in real time (solids, fluids, granular, fracture, phase change).
Cover with sources: MPM family (MLS-MPM, APIC, PolyPIC, CPIC rigid coupling, implicit MPM, sparse grids/SPGrid, GPU MPM papers such as Gao 2018, Wang 2020, Fei 2021 "Principles towards real-time simulation of MPM on modern GPUs", and anything 2023-2026), SPH (DFSPH/IISPH), position-based fluids, FEM variants used in real time (projective dynamics, XPBD-FEM, Vertex Block Descent), peridynamics and phase-field / CD-MPM fracture, unified particle frameworks (Macklin 2014 Unified Particle Physics, NVIDIA Flex, Warp, Taichi, Genesis, Newton).
For each method: which physical phenomena it reproduces faithfully, its known NON-physical artifacts (numerical dissipation, numerical fracture, volume loss, locking, cell-crossing instability, stiffness-dependent results), its timestep restriction (CFL / speed of sound — e.g. what explicit dt real steel or water stiffness would require and how real-time systems cope: softened moduli, implicit solves, substepping), and published real-time particle/element counts with the hardware they ran on.
Also cover the constitutive models that carry the first-principles content (Neo-Hookean, corotated, St. Venant-Kirchhoff, von Mises and Drucker-Prager plasticity, equations of state for fluids, viscosity models) and which real material parameters they consume (density, Young's modulus, Poisson ratio, yield stress, friction angle, viscosity).
Conclude with which method(s) are the most credible "single substrate for matter" on a phone-class GPU, and at what spatial resolution / world size.`,
  },
  {
    key: 'contact',
    prompt: `RESEARCH AREA: rigid bodies, articulated mechanisms, contact and friction — the part that decides whether you can build a working machine/robot in the simulation.
Cover with sources: XPBD (Macklin 2016), small-steps (2019), "Detailed Rigid Body Simulation with XPBD" (Mueller 2020), Vertex Block Descent (SIGGRAPH 2024) and Augmented VBD (SIGGRAPH 2025), Incremental Potential Contact (Li 2020) and Affine Body Dynamics (Lan 2022) including any real-time/GPU variants through 2026, Box2D v3 soft-step / Solver2D comparisons (Erin Catto), TGS, Jolt, Rapier, PhysX 5, MuJoCo's convex soft-contact model, Drake's hydroelastic contact, Featherstone articulated-body algorithm and reduced vs maximal coordinates, Genesis and Newton (2025).
For each: accuracy vs reality (energy behaviour, stacking stability, friction fidelity, mass-ratio robustness, joint drift, stiff-system behaviour), what robotics actually trusts for sim-to-real and why, performance on mobile ARM CPUs (bodies/contacts per ms where published), and cross-platform determinism guarantees.
Also cover the physical modelling of things a "robot built on reality" needs: Coulomb friction and its limits as an empirical law, restitution, rolling/spinning friction, compliant (Hertzian) contact, continuous collision detection, SDF vs convex vs mesh collision, and actuator models (DC motor torque-speed curves, gear trains, springs/dampers, hydraulics) plus standard description formats (URDF, MJCF, SDF, USD Physics).
Conclude with which solver family gives the best realism-per-millisecond for mechanisms on a phone, and how it should couple to a deformable/fluid substrate.`,
  },
  {
    key: 'toolchain',
    prompt: `RESEARCH AREA: how this engine actually gets built in a Linux cloud container and delivered to a base iPhone 15, and which language/GPU API makes that sane.
Establish the CURRENT (late 2026) state with sources:
1. WebGPU in iOS Safari: which iOS/Safari version made it default-on, whether iPhone 15 gets it, the actual device limits on iPhone (maxStorageBufferBindingSize, maxBufferSize, maxComputeInvocationsPerWorkgroup, compute shader support, timestamp queries), known bugs/perf caveats, and WebGPU-vs-native-Metal performance gap.
2. WebAssembly on iOS Safari: SIMD support, threads/SharedArrayBuffer and the cross-origin-isolation (COOP/COEP) requirement, whether GitHub Pages can satisfy it (e.g. coi-serviceworker workaround), memory ceilings for WASM and for a Safari tab on a 6 GB iPhone, Memory64 status.
3. PWA capabilities on iOS that a game needs: fullscreen/home-screen install, touch, DeviceMotion/gyro permission, haptics/vibration (un)availability, audio latency, storage quotas, background throttling, 60 Hz rAF behaviour, low-power-mode throttling.
4. Native route: Metal 3/Metal 4 status and what Metal 4 adds for compute; what is required to ship to a personal iPhone (Mac + Xcode, free 7-day provisioning vs paid Developer Program, TestFlight); whether cloud macOS CI (GitHub Actions macOS runners, Xcode Cloud) can build/sign/deliver without the user owning a Mac, and the realistic friction.
5. Portable-core options: Rust + wgpu (current version, iOS/Metal backend maturity, WASM/WebGPU target), C++ + Dawn or wgpu-native, Swift + Metal only, Zig; shader portability (WGSL, MSL, Slang, naga transpilation); what real shipped engines chose.
6. Floating-point determinism across CPU (ARM64 vs x86-64 vs WASM) and GPU, and what deterministic engines do about it.
Conclude with a ranked recommendation of delivery path(s) for a first on-device demo with the least friction AND a path that does not cap long-term performance.`,
  },
  {
    key: 'rigor',
    prompt: `RESEARCH AREA: what "first principles" and "as close to real life as possible" can rigorously mean at phone scale, how to prove it, and what makes a simulated reality good to build games on.
Cover with sources:
1. The physics hierarchy and where a phone must cut: what is truly fundamental (conservation of mass, linear/angular momentum, energy; second law) vs constitutive/empirical closures (elasticity models, Coulomb friction, viscosity, turbulence, restitution). What a continuum-scale engine can honestly claim.
2. Structure-preserving numerics: symplectic and variational integrators, energy-momentum methods, what position-based/implicit methods do to energy, timestep/CFL constraints, why float32 matters (GPU has no fp64 on Apple silicon), large-world precision strategies.
3. Verification & validation practice: code verification vs validation (ASME V&V 10/20, method of manufactured solutions, convergence-order tests), and a concrete list of analytical/experimental benchmarks suitable for an automated test suite with their closed-form answers or reference datasets — e.g. pendulum period, projectile, elastic/inelastic collision, friction-angle threshold on an incline, Dzhanibekov/intermediate-axis effect, cantilever deflection and Euler buckling, modal frequencies of a beam, Hertz contact, hydrostatic pressure and Archimedes buoyancy, dam break (Martin & Moyce 1952), Poiseuille/Couette flow, Stokes terminal velocity, Taylor-Green vortex, granular column collapse (Lajeunesse/Lube), angle of repose, 1D heat conduction. Include published physics-engine comparison studies (e.g. Erez/Tassa/Todorov 2015, Chung & Pollard, any 2023-2026 benchmark suites).
4. Multi-physics scope worth planning for and its cheapest faithful formulation: heat (Fourier conduction, phase change, combustion), buoyancy/drag/lift emerging from fluid vs modelled, lumped-element electric circuits and motors, physically based sound (modal synthesis, contact sound), light. Which of these are realistic on an A16 next to mechanics.
5. Precedents — games/sandboxes where the simulation IS the game substrate and what their developers said made it work or fail: Noita, Teardown, The Powder Toy, Algodoo/Phun, Besiege, Kerbal Space Program, Zelda: Tears of the Kingdom (GDC 2024 "physics-driven everything / no special cases" talk), Principia, Poly Bridge, Dreams, Roblox's aerodynamics/material work. Extract design rules for the game-builder-facing API.
6. Sources of real material parameters (open databases, handbooks) and unit-system discipline in simulation code (dimensional analysis types, SI everywhere, nondimensionalisation).
Conclude with a precise, defensible definition of "first-principles" for this engine and an explicit fidelity ladder (what is exact, what is approximated, what is out of scope).`,
  },
]

const DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    thesis: { type: 'string' },
    first_principles_stance: { type: 'string' },
    architecture: { type: 'string' },
    frame_budget: { type: 'string' },
    platform_and_toolchain: { type: 'string' },
    game_builder_api: { type: 'string' },
    validation_plan: { type: 'string' },
    roadmap: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          phase: { type: 'string' },
          goal: { type: 'string' },
          deliverables: { type: 'string' },
          exit_criteria: { type: 'string' },
        },
        required: ['phase', 'goal', 'deliverables', 'exit_criteria'],
      },
    },
    risks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { risk: { type: 'string' }, mitigation: { type: 'string' } },
        required: ['risk', 'mitigation'],
      },
    },
    non_goals: { type: 'array', items: { type: 'string' } },
    decisions_for_user: { type: 'array', items: { type: 'string' } },
  },
  required: ['name', 'thesis', 'first_principles_stance', 'architecture', 'frame_budget', 'platform_and_toolchain', 'game_builder_api', 'validation_plan', 'roadmap', 'risks', 'non_goals', 'decisions_for_user'],
}

const STANCES = [
  {
    key: 'continuum-first',
    brief: `STANCE: CONTINUUM-FIRST. Everything is matter. One substrate (a material-point / particle-grid style continuum solver on the GPU, or whatever the research says is the strongest single substrate) simulates solids, fluids, granular media, fracture and phase change from constitutive laws and real material parameters. Rigid bodies and joints are treated as the stiff limit of matter and only get a dedicated solver where the research proves the continuum cannot do the job at phone resolution. Argue this as hard as it can honestly be argued.`,
  },
  {
    key: 'variational-solver-first',
    brief: `STANCE: ONE VARIATIONAL PRINCIPLE, MANY PRIMITIVES. The engine is a single implicit time integrator that minimises an incremental potential (inertia + elastic energy + contact/friction + constraints) over heterogeneous primitives — rigid and articulated bodies, FEM solids, shells/cloth, rods, and particle fluids/granulars — using the strongest modern solver family from the research (VBD/AVBD, XPBD, IPC-style barriers, etc.). Priority: mechanisms that actually work — motors, gears, linkages, vehicles, robots — with robotics-grade contact and friction, plus deformables and fluids coupled through the same principle. Argue this as hard as it can honestly be argued.`,
  },
  {
    key: 'layered-multiscale',
    brief: `STANCE: LAYERED REALITY KERNEL. Separate (1) LAWS and MATERIALS (conservation laws, constitutive models, SI units, a material database) from (2) REPRESENTATIONS (rigid body, articulated, FEM, particle continuum, grid fluid, lumped thermal/electrical networks) and (3) SOLVERS/BACKENDS (CPU reference, GPU). Each object carries a material and the engine picks and switches representation by need (a steel beam is rigid until loads approach yield, then becomes deformable, then fractures into pieces), with conservation-preserving hand-offs and level-of-detail in space and time. Priority: an architecture that can start small, be verified against analytical benchmarks at every step, and grow in fidelity without rewrites. Argue this as hard as it can honestly be argued.`,
  },
]

const CRITIQUE_SCHEMA = {
  type: 'object',
  properties: {
    lens: { type: 'string' },
    scores: {
      type: 'object',
      properties: {
        realism: { type: 'number' },
        feasibility_on_a16: { type: 'number' },
        first_principles_integrity: { type: 'number' },
        game_buildability: { type: 'number' },
        delivery_safety: { type: 'number' },
      },
      required: ['realism', 'feasibility_on_a16', 'first_principles_integrity', 'game_buildability', 'delivery_safety'],
    },
    fatal_flaws: {
      type: 'array',
      items: {
        type: 'object',
        properties: { flaw: { type: 'string' }, evidence: { type: 'string' } },
        required: ['flaw', 'evidence'],
      },
    },
    fixable_flaws: {
      type: 'array',
      items: {
        type: 'object',
        properties: { flaw: { type: 'string' }, fix: { type: 'string' } },
        required: ['flaw', 'fix'],
      },
    },
    numbers_challenged: {
      type: 'array',
      items: {
        type: 'object',
        properties: { claim: { type: 'string' }, correction: { type: 'string' }, basis: { type: 'string' } },
        required: ['claim', 'correction', 'basis'],
      },
    },
    best_ideas: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string' },
  },
  required: ['lens', 'scores', 'fatal_flaws', 'fixable_flaws', 'numbers_challenged', 'best_ideas', 'verdict'],
}

const LENSES = [
  {
    key: 'feasibility',
    brief: `LENS: PERFORMANCE AND DELIVERY SKEPTIC. Assume the author is optimistic by 3-10x. Re-derive the per-frame cost from the research numbers (particles, grid cells, substeps, solver iterations, memory bandwidth, thermal sustained budget on A16, WebGPU/Metal limits). Check that the toolchain and delivery path really work from a Linux cloud container to a personal iPhone 15. Check that the roadmap's first on-device milestone is reachable and that each phase has a measurable exit criterion. Identify what will melt the phone, blow the memory limit, or stall the project.`,
  },
  {
    key: 'physics',
    brief: `LENS: PHYSICS AND FIRST-PRINCIPLES SKEPTIC, AND GAME-BUILDER ADVOCATE. Hunt for places where the design quietly abandons first principles (tuned fudge factors, softened material stiffness presented as real, non-conserved momentum/energy/mass at representation hand-offs or couplings, timestep-dependent behaviour, artifacts that would make a real mechanism fail: joint drift, gears slipping, stacks jittering, tunnelling, numerical fracture). Check the validation plan would actually catch those. Then ask whether a game designer could really build a vehicle, a robot arm, a bridge, a boat and a fire on this engine and have them behave like the real thing — and whether the API lets them.`,
  },
]

phase('Research')
log('Sweeping five research areas in parallel (web-verified)')
const researchRaw = await parallel(
  AREAS.map(a => () =>
    agent(`${CONTEXT}\n${a.prompt}\n${RESEARCH_RULES}`, {
      label: `research:${a.key}`,
      phase: 'Research',
      schema: FINDINGS_SCHEMA,
      agentType: 'general-purpose',
    }).then(r => (r ? { key: a.key, ...r } : null))
  )
)
const research = researchRaw.filter(Boolean)
const missing = AREAS.map(a => a.key).filter(k => !research.some(r => r.key === k))
if (missing.length) log(`Research areas that returned nothing: ${missing.join(', ')}`)
log(`Research complete: ${research.length}/${AREAS.length} areas, ${research.reduce((n, r) => n + r.findings.length, 0)} findings`)

const RESEARCH_JSON = JSON.stringify(research)

const designed = await pipeline(
  STANCES,
  stance =>
    agent(
      `${CONTEXT}
You are one of three independent architects. Produce a complete, concrete engine plan from the stance below. The other architects are arguing different stances; do not hedge toward them — but be honest about where your stance is weak.

${stance.brief}

REQUIREMENTS FOR YOUR PLAN:
- Ground every performance number in the research below. Where the research has no number, say "estimate" and show the derivation (counts x cost). Design for a SUSTAINED thermal budget on a base iPhone 15 at 60 Hz, not peak.
- Be specific: name algorithms, data structures, particle/element/body counts, grid resolution, substeps, dt, world size, CPU-vs-GPU split, memory footprint, precision strategy.
- first_principles_stance: state exactly what is derived from conservation laws and measured material parameters, what is an empirical closure, and what is a numerical compromise (and how the engine reports it instead of hiding it).
- platform_and_toolchain: language, GPU API, how the first on-device demo reaches the user's iPhone 15 from a Linux cloud container, and the long-term path.
- game_builder_api: how a game is built on top "like a robot on top of reality" — materials, shapes, joints, actuators, sensors, units, queries, authoring, determinism/replay, what a game is NOT allowed to do (e.g. teleport, set velocities) and the escape hatches.
- validation_plan: the automated benchmark suite with named analytical/experimental tests and pass tolerances, and how it runs in CI without an iPhone.
- roadmap: 5-8 phases, each with a goal, deliverables and a measurable exit criterion; the first phase must end with something the user can run on their phone.
- risks, non_goals, decisions_for_user (only decisions that genuinely belong to the user).
- Each prose field should be dense and under ~450 words. No code.

RESEARCH (JSON, from five web-verified sweeps; "verified": false means from memory):
${RESEARCH_JSON}`,
      { label: `design:${stance.key}`, phase: 'Design', schema: DESIGN_SCHEMA }
    ),
  (design, stance) =>
    parallel(
      LENSES.map(lens => () =>
        agent(
          `${CONTEXT}
You are an adversarial reviewer of one proposed architecture for this engine. Default to skepticism: if a claim is not supported by the research or by a derivation you can check, treat it as wrong. You may use web search to check specific claims.

${lens.brief}

Score each dimension 0-10 (10 = excellent; for delivery_safety 10 = very likely to ship each phase). A fatal flaw is one that invalidates the plan unless the core approach changes; a fixable flaw comes with a concrete fix. In best_ideas list the ideas worth keeping even if this design loses. Keep each item to 1-3 sentences.

PROPOSED ARCHITECTURE (stance: ${stance.key}):
${JSON.stringify(design)}

RESEARCH THE ARCHITECT WAS GIVEN:
${RESEARCH_JSON}`,
          { label: `redteam:${stance.key}:${lens.key}`, phase: 'Red-team', schema: CRITIQUE_SCHEMA }
        )
      )
    ).then(critiques => ({ stance: stance.key, design, critiques: critiques.filter(Boolean) }))
)

const designs = designed.filter(Boolean)
if (designs.length < STANCES.length) log(`Only ${designs.length}/${STANCES.length} architectures completed`)

return { research, designs }
