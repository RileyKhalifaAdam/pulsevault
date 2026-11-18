# TIDELOCK — architecture (v2: the physical world first)

TIDELOCK is being rebuilt from the bottom up as **a working physical world** that runs smoothly on an iPhone 15
(Safari, WebGL2). Everything else — trade, missions, factions, flight computers — is removed until the world
itself is right, and will later be built *on top of* this world, never beside it.

The rule that decides every argument: **if it moves, it moves because of a force integrated over time.**
No rails, no spheres of influence, no kinematic shortcuts, no state that is edited instead of simulated.

## 1. Layers

```
core/     vec.ts rng.ts units.ts events.ts types.ts     maths and shared types
world/    THE PHYSICAL WORLD (pure TypeScript, no DOM, no three.js, deterministic)
            state.ts       World, Body, Craft, Joint — plain JSON-serialisable data
            ephemeris.ts   n-body integration of the massive bodies, cached ahead of time
            dynamics.ts    forces and torques on craft; translational + rotational integration
            contact.ts     colliders, impacts, resting contact, docking latches
            atmosphere.ts  density, drag, heating
            predict.ts     forward integration of a ghost craft (the map's trajectory)
            elements.ts    osculating orbit read-outs derived from state (information only)
            setup.ts       initial conditions from a SystemDef (Kepler elements -> state vectors, once)
            world.ts       createWorld / advance(world, realDt, warp, budgetMs) / save / load
sim/      universe.ts (system data), ships.ts (Wren stats) — data sources for setup only
game/     the thin session on top of the world: player input -> thruster and torque commands,
          attitude-hold controller (real torques), target, camera focus, save slot
render/   pipeline, scene, camera, space/* — draws the world's state; owns no simulation
ui/       hud, controls, map, menus, perf overlay — reads the game/world, sends commands
```

Dependencies point downward only. `world/` knows nothing about the player, the screen or the frame rate.

## 2. Conventions (binding)

- **Units:** SI — m, s, kg, rad, N, J, K. Never store km or degrees; convert only for display (`core/units.ts`).
- **Axes:** right-handed, reference plane XZ, +Y north. Prograde = counter-clockwise seen from +Y.
- **One inertial frame.** World state is in system-barycentric, non-rotating axes, in doubles.
  For numerical precision a craft is *integrated* in coordinates relative to its primary body (the body whose
  pull dominates), with the other bodies entering as direct-minus-indirect terms. The primary is a choice of
  coordinates, not of physics: every craft feels every body at all times, and switching primary changes no force.
- **Ship-local axes:** forward −Z, up +Y, right +X; the quaternion maps local → world; main exhaust leaves +Z.
- **Station-local axes:** +Y is the main axis. Stations are rigid bodies like any other craft.
- **Time:** sim seconds since 1 JAN 2907. **Determinism:** no `Math.random()` / `Date.now()` in `world/`,
  `game/`, `sim/`; the same inputs give the same world, bit for bit, on every device.
- **Language:** TypeScript strict, no dependencies beyond three.js 0.180.0, no external assets.

## 3. The physical world (`world/`)

### What exists
- **Bodies** — the star, planets and moons: mass, radius, position, velocity, spin axis, spin rate and angle,
  optional atmosphere (surface density, scale height, top). They gravitate.
- **Craft** — ships, stations, debris: rigid bodies with dry mass, propellant mass, principal moments of
  inertia, position, velocity, attitude quaternion, angular velocity, colliders, docking ports, drag area,
  heat state, hull. Their own gravity is neglected (test masses); that is the only mass approximation.
- **Joints** — docking latches and landed contact: constraints created and released by physical conditions.

### Laws
1. **Gravity:** Newtonian point-mass attraction. Bodies attract each other (full n-body). Every craft is
   attracted by every body. There are no spheres of influence anywhere in the simulation.
2. **Translation:** `m·a = ΣF` with gravity, thrust, drag and contact forces. Mass falls as propellant burns
   (`ṁ = F / vₑ`), so the rocket equation emerges; it is never applied as a formula.
3. **Rotation:** Euler's equations `I·ω̇ = τ − ω × Iω` with torques from the attitude system (limited torque),
   drag and contacts. Attitude hold is a controller commanding real torque — orientation is never set.
4. **Atmosphere:** exponential density co-rotating with the body; drag `½ρv²·CdA` against the air-relative
   velocity; heating `∝ √ρ·v³` into a heat capacity with radiative loss. Entering too fast destroys the craft.
5. **Contact:** sphere and capsule colliders. Impacts are resolved with impulses (restitution, friction) and do
   damage by energy; a slow, aligned arrival at a docking port closes a latch (a joint); undocking releases it
   with a spring impulse. A slow touchdown on a body's surface becomes resting contact on the rotating ground.
6. **Nothing else moves anything.** No tug, no teleport, no "on rails" mode. Time acceleration means taking
   more or larger integration steps under the same laws.

### Integration
- **Bodies:** fixed step `H` (a few hundred seconds, ≤ 1/200 of the shortest orbital period), 4th-order
  symplectic (Yoshida). Their states are computed ahead of the present and kept in a ring buffer — the
  **ephemeris** — and read back anywhere in a step by cubic Hermite interpolation. Fixed step + fixed order of
  operations = deterministic, and long-term stable (no secular energy drift).
- **Craft:** each craft takes its own adaptive steps across the frame, sampling the ephemeris:
  step ≤ a small fraction of the local dynamical time `√(r³/GM)`; ≤ 1/60 s while thrusting or turning;
  finer still in contact or in atmosphere. Coasting uses a symplectic scheme; thrust and drag phases a
  4th-order one. Rotation is sub-stepped by angular rate.
- **Time acceleration** is limited only by honesty and by the CPU: `advance()` gets a millisecond budget and
  reports the sim time it actually covered and why it was limited (`thrust`, `rotation`, `contact`,
  `atmosphere`, `proximity`, `cpu`). The request is a wish; the world never cuts corners to meet it.
- **Prediction** is the same integrator run on a ghost: it yields a polyline in the frame of a chosen body
  plus events (periapsis, apoapsis, closest approach to a target, atmosphere entry, impact). Planned burns are
  impulses applied to the ghost. Because the laws are identical, the drawn path is what will happen.
- **Read-outs** (apoapsis, periapsis, period, inclination) are osculating elements computed from the state
  relative to the primary. They are information for the pilot and are never fed back into the motion.

### Budgets (iPhone 15, A16)
- `advance()` at 1×: under 0.3 ms per frame. Default budget under time acceleration: 3 ms per frame.
- No allocation in the stepping loops (typed arrays, preallocated scratch). State saves under 100 kB.
- A benchmark test reports body-steps/s and craft-steps/s so regressions are visible.

### Proof (tests that must hold)
Two-body motion matches the analytic Kepler solution; energy and angular momentum of the body system stay
bounded over years; every planet, moon and station of the start system stays in its orbit for a simulated
year; burning a known propellant mass gives the Δv the rocket equation predicts; torque-free rotation
conserves angular momentum; an impact conserves momentum and loses energy by its restitution; a latch closes
only inside its tolerances; save → load → continue is bit-identical; prediction and actual flight agree.

## 4. Rendering contract (unchanged, restated)

- three.js 0.180.0, WebGL2. **Far scene** (sky, star, bodies as unit spheres placed camera-relative so angular
  size is exact) and **near scene** (craft, effects; metres; floating origin at the camera), depth cleared
  between; one HDR half-float target → bloom → filmic tone map → AA → sRGB.
- The renderer reads positions, attitudes, spins and thruster states from the world each frame and
  interpolates nothing itself. Lighting comes from geometry: star direction, eclipse factor, planetshine.
- Budget: device pixel ratio ≤ 2 with dynamic resolution 0.6–1.0; ≤ 200 draw calls, ≤ 500k triangles,
  ≤ 300 MB GPU memory; baked planet textures; no per-frame allocation.

## 5. Smoothness is a feature

- Target: 60 fps on an iPhone 15, never below 30. Frame time is measured, not assumed: the app keeps a rolling
  record of frame, simulation and render time, steps per frame, resolution scale and quality tier.
- **Perf overlay** (toggle in the menu): fps, frame-time p50/p95, sim ms, render ms, draw calls, resolution
  scale, tier, and a "Copy performance report" button — the owner's phone is the only real test device.
- **Automatic quality:** start at a safe tier; drop resolution scale first, then tier, when p95 frame time
  stays above budget; climb back slowly. Expensive bakes are spread over frames behind a progress bar.
- The delivery rules for the iPhone page viewer in `CLAUDE.md` are binding for all client code.

## 6. What the first physical-world build contains

The Tallow system (red dwarf, six planets, three moons) under full n-body gravity; the stations as orbiting
rigid bodies; the player's Wren beside Chandler's Wheel in low orbit of Wick. Fly by hand with real thrust and
torque, accelerate time, watch the predicted path on the map, plan a burn, rendezvous and dock by latch, hit
things, graze the atmosphere, fall into it. Nothing to buy, nobody to talk to.

## 7. Later layers (not now, and only on top of the world)

Guidance (a flight computer is a pilot issuing the same thruster commands), surfaces you can land on in
detail, cargo as physical mass, other vessels as rigid bodies with pilots, then economy and politics driven by
what physically moves between places.
