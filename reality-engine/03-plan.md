# Reality engine — the plan

Synthesized from five research sweeps, three independent candidate architectures and six adversarial
reviews (see `01-research.md` and `02-designs-and-reviews.md`). No code exists yet.

## The verdict in one paragraph

No single solver can be "reality" on an iPhone 15, and each of the three candidate designs that bet on
one was rejected by its reviewers. What survives is a design where the permanent part of the engine is
not a solver at all: it is a **laws-and-materials layer** (conservation laws, real material data in SI
units, and an audit of every approximation), with two replaceable solver tiers underneath it. One tier
runs machines on the CPU; the other runs flowing matter on the GPU. It ships first as a web page your
iPhone opens in Safari, so it needs no Mac and no Apple account.

## What "first principles" will mean here (the charter)

1. The only hard-coded physics is conservation of mass, momentum, angular momentum and energy, plus the
   second law of thermodynamics as an admissibility test on every material model.
2. Everything specific to an object enters only through its geometry and its material. Materials carry
   measured SI properties (density, stiffness, yield strength, friction pairs, viscosity, thermal
   properties), each with a recorded source. No per-object scripted behaviour.
3. Every numerical shortcut is declared and measured, never hidden.
4. Every fidelity claim is backed by an automated test against a closed-form answer or a published
   experiment, with a tolerance.
5. Units are enforced by the type system.

Fidelity ladder:

- **Exact by construction**: mass, momentum exchanged between two interacting bodies, units, replay on the same build.
- **Convergent and tested**: free rigid motion, joints and mechanisms, bending and buckling of stiff parts, hydrostatics, heat conduction.
- **Empirical, labelled as such**: friction, bounce (restitution), viscosity. These are empirical in real engineering too.
- **Out of scope**: atoms, sound waves travelling through steel, turbulence, electromagnetic fields.

## The limits that shaped the design

- **Real stiffness cannot be time-stepped.** Simulating steel explicitly at 1 cm resolution needs about
  9,800 steps per frame and water about 2,500; the phone affords 2 to 8. So stiff things are treated as
  rigid (with bending computed separately at the real stiffness) and liquids as incompressible. This is
  the one sanctioned departure from real parameters, and the engine reports it per material.
- **Heat is the binding constraint, not speed or memory.** An A16 phone sustains about 4.3 W over a
  30-minute game session, and its GPU holds 50-85% of peak output once warm. Every budget is sized to
  what the phone can hold for 20 minutes.
- **Scale is a workshop, not a world.** Estimates, all unmeasured on an iPhone 15: hundreds of awake
  rigid bodies in the browser and low thousands in a native app; 10-30 thousand matter particles, which
  is litres to low tens of litres of liquid, or a few litres of sand. A larger world can exist around
  that as sleeping or simplified matter.
- **Contact is the main fidelity risk.** Even simulators fitted to data miss real cube tosses by 13-25%
  of the cube's size.

## Architecture

**Layer 1 — Laws and materials (permanent).** Typed SI units; a material database with provenance; a
per-step ledger of mass, momentum and energy with a separate "numerical loss" account; a fidelity
record per object showing authored versus achieved parameters.

**Layer 2 — Mechanism tier (CPU, bit-exact).** Rigid bodies and jointed mechanisms
(reduced-coordinate articulations, the formulation robotics simulators use), solved with a substepped
soft-constraint solver of the Box2D v3 / Rapier lineage at 480 steps per second. Contact stiffness and
friction are derived from material data, then clamped to what the step rate can resolve, with the clamp
reported. Actuators are physical models: DC motors with back-EMF and current limits, gearboxes with
reflected inertia, batteries with internal resistance. Stiff parts bend, yield and break through
quasi-static modal elasticity at the real modulus, the one method reviewed that keeps real steel
stiffness on a phone.

**Layer 3 — Matter tier (GPU).** A particle-grid continuum solver (MLS-MPM: matter as particles that
exchange momentum through a grid) for liquids, sand, mud and soft solids, with an implicit pressure
solve so liquids do not compress. It is coupled both ways to the mechanism tier with friction, so a
boat floats and a digger digs.

**Game-builder API ("a robot on reality").** A game supplies geometry, material names, joints,
actuators, sensors and controllers. In strict mode, the default, a game cannot teleport objects, set
velocities or conjure matter. The player's finger is a force-limited actuator. Escape hatches exist but
are logged, and the energy they inject is booked as external. A live "Reality Report" shows the ledger
and every active approximation.

**Thermal governor.** When the phone warms, it reduces render quality, frame rate or the amount of
awake matter. It never changes the timestep, the materials or the laws.

## Delivery

- **First**: a Rust core compiled to WebAssembly with GPU kernels in WGSL (the WebGPU shader language),
  published as a static site on GitHub Pages. You open the URL in Safari (iOS 26 or later) and add it to
  the Home Screen. The whole loop runs from this Linux environment.
- **Later, optional**: the same core as a native iOS app, built on GitHub's macOS machines and delivered
  through TestFlight. This needs the Apple Developer Program (US$99 per year). It removes the browser's
  limits: one physics thread, a memory kill near 2 GB, and no haptics.
- **Testing without the phone**: the CPU tier is bit-exact across the phone, the browser and the build
  server, so a replay recorded on your phone reproduces here. A double-precision reference solver acts
  as the oracle for every production solver.

## Roadmap

| Phase | Goal | Done when |
|---|---|---|
| 0a. Probe | Measure your actual phone | A page reports WebGPU limits, timer precision, real particle and rigid-body throughput at several sizes, and a 20-minute heat soak. You paste the result back. Every budget above is replaced by a measurement. |
| 0b. Laws, materials, first world | Units, material database, ledger, rigid blocks | You throw and stack steel, oak and rubber blocks at 60 Hz for 20 minutes. Conservation tests pass. The solver choice is settled by a written A/B test on the build server. |
| 1. Mechanisms | Joints, motors, gearboxes, batteries, sensors | A rover and a six-joint arm run on the phone driven only by voltages. Motor tests are within 1-2%. A phone replay reproduces bit-exactly on the build server. |
| 2. Bend, yield, break | Stiff parts deform at real stiffness | Beam deflection, vibration frequency and buckling load are within 3-5% of theory. A bridge fails where the analysis says it should. |
| 3. Liquids | Incompressible liquid on the GPU, coupled to machines | Hydrostatic pressure is within 3%, the dam-break experiment within 10%, and a boat floats at the predicted waterline. The heat soak holds. |
| 4. Sand, mud, soft solids, heat | Granular matter, plasticity, conduction, melting | Column collapse and angle of repose match experiment. The melting front is within 5% of theory. |
| 5. Native app (optional) | Remove the browser ceiling | A TestFlight build runs at least twice the awake bodies of the web build, with identical replay hashes. |
| 6. Builder kit and first game | Prove a game can be built on it | A sample game ships using only the public API in strict mode, with no engine changes made for it. |

The test suite is written before each feature, and each phase ends with a 20-minute soak on the phone.

## What the reviews changed

- A continuum-only engine was dropped: at real parameters it resolves only water, oil, honey and gelatin, and sand fails its own honesty test.
- A single energy-minimizing solver for everything was dropped: its time integrator loses angular momentum, and it has never been measured on a phone.
- Automatic switching of an object from rigid to fully deformable was dropped: the deformable solver cannot be steel-stiff, so the hand-off would join two different materials.
- The probe was split out as its own first step, because no published measurement of this kind of simulation on an iPhone 15 exists and estimates span a factor of ten.

## Decisions that are yours

1. **3D.** Decided: the engine is 3D. The 2D option is dropped.
2. **What to build first.** Machines, robots and vehicles (assumed, and the order above), or liquids, sand and destruction first (phases 3-4 move ahead of 2).
3. **Where it lives.** A new public repository is recommended; GitHub Pages on a free account needs a public repo, and it keeps PulseVault untouched. This session cannot create repositories, so you would create it. The alternative is a subfolder of this repo.
4. **Apple Developer Program.** Only needed for phase 5, so it can wait.
5. **Device lab.** Your phone must run iOS 26 or later, and each phase needs you to run a soak test and paste back a block of text.

Decided since this plan was written: the engine is 3D; it must scale to a whole solar system or more;
and multiplayer is required. This document predates the last two and is being rewritten around them.

Defaults chosen unless you say otherwise: strict mode on; when the phone runs hot, drop to 30 frames per
second before reducing matter.

## Caveats on the evidence

- Network restrictions meant many sources were seen only as search excerpts; `01-research.md` marks each finding as verified or not.
- The particle and body counts above are estimates scaled from other devices. Phase 0a exists to replace them.
