export const meta = {
  name: 'tidelock-wave3-cores-prebuild',
  description: 'TIDELOCK: build the self-contained cores of wave-3 packages (mass properties/gimbal/slosh/flex, compartments/breach/doors/airlock/reactor/cryo, sensors and burn planner, injury and g tolerance, eye adaptation) in new files, each adversarially reviewed and fixed',
  phases: [
    { title: 'Build', detail: 'five cores in new files with tests' },
    { title: 'Review', detail: 'a skeptical specialist per core tries to refute it' },
    { title: 'Fix', detail: 'fix every confirmed defect' },
  ],
}

const ROOT = '/home/user/pulsevault/tidelock'
const SCRATCH = '/tmp/claude-0/-home-user-pulsevault/02af9242-a437-54ad-bf2c-efd96ec068b3/scratchpad/w3cores'

const COMMON = `Project: TIDELOCK, an original hard-science space game for iPhone 15 (Safari, WebGL2, three.js 0.180.0, TypeScript strict, esbuild). Project root: ${ROOT} — cd there first. Scratch directory: ${SCRATCH}/<your label>/ (create it; bundles, test pages, logs go there).

THE OWNER'S REQUEST: "Now make every possible thing simulated to the max while keeping performance." and "If something causes bad frame rate just aim for maximum efficiency and first principles thinking." (also a binding rule in CLAUDE.md). The binding plan is docs/SIMULATION.md: read §1 in full (principles, budget and its thermal headroom, architecture with the fixed 120 Hz tick and the multi-rate scheduler, §1.4 the shared contract including the wave-2 fields), your package section in full, the owner decisions (engineers use the defaults), the 'Added in review' and 'Review notes' sections. Also docs/ARCHITECTURE.md §2–3 and src/core/types.ts.

ALREADY BUILT AHEAD (new files, reviewed, not yet wired — you may import them; read their WIRING headers): wave 1 — src/world/events.ts (event ring), src/world/jets.ts (jet allocation, blowdown, engine spool, ledger), src/world/body.ts and src/world/quasistatic.ts (felt acceleration, harness/head, boots, rest/drift closed forms), src/world/dutyTape.ts and src/render/space/plumes.ts, src/audio/*; wave 2 — src/world/{attitude,cmg,aero,atmoProfile,nozzle,perturb}.ts and src/data/aero/wren.ts (CMGs, gravity gradient, aero table, atmosphere, ambient-pressure thrust), src/world/{capture,stations,damage,refuel,landed}.ts and src/data/hullZones.ts (soft capture, gyrostats, located damage with a structure energy pool, refuelling), src/world/{thermal,power,caution,shipSystems}.ts and src/data/{thermalNet,powerNet}.ts (36-node implicit thermal network, electrical bus, cautions, systemsDue scheduler), src/world/{cabin,life}.ts and src/data/cabinNet.ts (per-room gas with orifice flow incl. choked flow, life support, roomAirVel/draftAt), src/world/{hands,transitions,tides,bootSwitch}.ts (handholds, physical sit/stand/lie, tides, boot wrist switch). Waves 1 and 2 will wire them into the existing files.

THIS IS A PRE-BUILD AHEAD OF WAVE 3. Another engineer is finishing a different job right now and edits src/render/*, src/app/*, src/ui/*, e2e/* and may touch any existing file. So you build the SELF-CONTAINED CORE of your package in NEW FILES ONLY — pure, allocation-free, deterministic functions and data structures with their tests (and build-time tools under tools/ if the plan bakes tables at build time; their output goes to a new generated file) — designed so wave 3 wires them into the existing files with little code. Do not edit any existing file; do not run git commands that change the repository; do not run build.mjs or npm run build (they re-bake and rewrite files others own) — bundle with esbuild directly into your scratch dir if you need to; run vitest only on your own test files. Put a short 'WIRING' comment at the top of each new file: which existing function calls it, with what, at what rate, what it replaces, and which §1.4 contract fields it reads and writes. Rules that bind world/ code: no three.js, no DOM, no Math.random/Date.now (core/rng.ts), SI units, no allocation in per-step paths (preallocated scratch, typed arrays), the rates and closed/implicit forms the plan specifies (thermal and gas implicit and unconditionally stable at the warp step sizes the plan names), warp honesty (declare a limitedBy reason where the plan does), save → load → step bit-identical for any state you define (save/load helpers with loader defaults), and the per-subsystem µs budgets of §1.2 — measure in node and report.
Final report (≤ 220 words): files, what you ran and saw (numbers: µs per call measured in node, test results, conservation errors), the wiring recipe, deviations from the plan with reasons, and what is not verified.`

const PKGS = [
  { id: 'W3-A', who: 'a senior spacecraft mass-properties, structures and propulsion engineer',
    scope: `Package W3-A "Mass properties, engines and structure, small perturbations". Tank layout per owner decision D2 default (conformal tanks outside the pressure hull in the belly and wing roots; 22.5 t LH2 is about 317 m³ at 70.8 kg/m³ — size and place them against src/data/interiors.ts and the hull in src/data/hullColliders.ts / src/data/hullZones.ts; 1.5 t hydrazine 1.5 m³). Build the core in new files (e.g. src/world/massProps.ts, src/world/gimbal.ts, src/world/slosh.ts, src/world/flex.ts, src/data/tanks.ts, tests): the moving centre of mass and full inertia tensor from dry structure + tanks + crew + loose objects (+ tpsMass), with tableCom saved so a jet table rebuilt after load is the same one (§1.4), the main-engine gimbal (actuator rate and range limits, a thrust-vector controller that keeps the resultant through the moving CoM, replacing the fixed 0.73° cant), propellant slosh as equivalent pendulum or spring-mass models per tank with damping from baffles (frequencies from the standard lateral-slosh formulas for the tank shape and fill), the vent force/torque application (vent {F, tau, mdot}) and extImpulse application, the first hull bending modes (flex[4]) excited by thrust transients and docking, coupling back into felt acceleration at the crew. Tests: CoM and inertia of known shapes analytic; momentum and angular momentum conserved with slosh exchanging momentum with the hull; slosh frequency matches the formula; gimbal keeps the thrust line through the CoM as tanks drain (RCS trim usage drops to ~0); flex modal energy decays at the specified damping; determinism; save/load; cost.` },
  { id: 'W3-B', who: 'a senior spacecraft systems engineer for pressurised compartments, mechanisms and nuclear power',
    scope: `Package W3-B (hub) "Ship systems II: compartments, breach, doors, hatch, reactor, cryo". Builds on src/world/cabin.ts (orifice and choked flow, per-room gas — do not edit it; extend in new files) and src/world/thermal.ts/power.ts. Build the core in new files (e.g. src/world/breach.ts, src/world/doors.ts, src/world/airlock.ts, src/world/reactor.ts, src/world/cryo.ts, src/data/doors.ts, tests): hull breach from located damage (hole area from impact energy), venting with choked mass flow at 5 ms sub-steps while venting and the reaction force/torque (vent F/τ written for W3-A), the force on crew and loose objects near the breach (from the flow field), doors and the dorsal hatch as physical mechanisms (mass, motor force, travel, pressure load holding a door shut against a pressure difference, auto-close on pressure drop), the airlock cycle (pump-down about 16 min, the critic's number, with a pump curve), the reactor as a first-order core with decay heat (no point kinetics — §3 says why), DRIVE ARM as reactor standby (critic addition), cryogenic LH2 boil-off from heat leak and the boil-off/condensate vents (the missing physical cause for vent sparkle), ablation of the TPS writing tpsMass. Tests: choked-flow vent time of a room through a hole matches the analytic blowdown; momentum of vented gas equals the impulse on the ship; a door cannot open against 1 kPa with the motor force; airlock pump-down time; decay heat follows the standard fraction curve; boil-off rate from the heat leak; determinism; save/load; cost and warp honesty (limitedBy 'venting').` },
  { id: 'W3-C', who: 'a senior guidance, navigation and sensors engineer (rendezvous radar, lidar, docking cameras, trajectory planning)',
    scope: `Package W3-C "Sensors and the flight computer". Build the core in new files (e.g. src/world/sensors.ts, src/world/radar.ts, src/world/lidar.ts, src/world/dockCam.ts, src/world/burnPlan.ts, tests): rendezvous radar and lidar with real beam limits, range/range-rate noise models, update rates (10 Hz), occlusion by bodies and the station structure (line of sight via the existing compound colliders — read-only), the tracks and covariance propagated in closed form under warp (§1.3), the docking-camera geometry as a pure function (what the camera would see: target pose relative to the boresight, to be rendered by a later render step), Flight Assist and holds fed only through these sensor readings for target-relative modes, and the burn planner (impulsive and finite-burn planning on the ghost integrator of src/world/predict.ts — read-only: call it, do not edit it). Per §3, no IMU/star-tracker/MEKF (drift is arcseconds and invisible) and no gauging noise. Tests: radar range-rate matches truth within its noise statistics; occluded targets drop out; covariance growth matches the closed form; burn planner's predicted encounter matches flight within tolerance; determinism; save/load; cost.` },
  { id: 'W3-D', who: 'a senior human-factors and injury-biomechanics engineer',
    scope: `Package W3-D "Body III: a body that can be hurt" — the simulation core only (the visible-hands rendering is wave 3's render step). Build in new files (e.g. src/world/injury.ts, src/world/gTolerance.ts, tests): g tolerance over time along each body axis (the standard human tolerance curves: +Gz grey-out → black-out → G-LOC with time-at-g, onset rate and the protective effect of a reclined seat and the harness; −Gz red-out; Gx much better tolerated) as a state with recovery, producing the eye's vision state (tunnel, grey, black) and loss of control of the hands while G-LOC; injury from impacts on the body (head and torso impact criteria such as HIC from the body's acceleration history, injury states that heal over sim time, a fatal threshold) replacing binary 15 g / 5 m/s deaths noted in the audit; extImpulse written for W3-A when the body pushes on the ship. Per §3 no vestibular illusions or camera shake. Tests: time-to-G-LOC at constant +Gz matches the published curve shape within its spread; HIC of a known pulse; recovery time constants; determinism; save/load; cost.` },
  { id: 'W3-E', who: 'a senior colour scientist and physically based camera/eye engineer',
    scope: `Package W3-E "The eye and light, physically" — the pure, renderer-independent core only (the render integration happens later). Build in new files (e.g. src/render/eye/adaptation.ts, src/render/eye/photometry.ts, tests): physical radiometry end to end — the star's luminosity and 3482 K spectrum to irradiance at the ship in W/m² and illuminance in lux (36.6 lm/W at 3482 K is already used by W1-E; check it), scene luminance to exposure in EV the way a human eye adapts (photopic/mesopic/scotopic, pupil diameter vs luminance, the slow cone and rod adaptation time constants, running on SIM time not real time per the reviewer), the Purkinje shift and loss of colour vision at low light, glare from the sun disc and bright sources (veiling luminance), and how the starfield's visibility follows from the adaptation state; pure functions and a small state struct the pipeline will read each frame (no three.js in the core; it may sit under src/render/eye/ but must import no DOM or three). Tests: illuminance at Wick's distance from Tallow's luminosity; pupil diameter and adaptation times against the standard published models; dark-adaptation curve shape (cone plateau then rod break); exposure is continuous and frame-rate independent; determinism; cost.` },
]

const REVIEW = {
  type: 'object',
  properties: {
    defects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          what: { type: 'string' },
          evidence: { type: 'string', description: 'file:line, command run and its output' },
          fix: { type: 'string' },
        },
        required: ['id', 'severity', 'what', 'evidence', 'fix'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['defects', 'summary'],
}

const results = await pipeline(
  PKGS,
  (p) => agent(`You are ${p.who}.

${COMMON}

YOUR PACKAGE: ${p.scope}`, { label: `build:${p.id}`, phase: 'Build', effort: 'high' }),
  (built, p) => agent(`You are an independent, skeptical reviewer (${p.who}). Try to REFUTE the claim that the pre-built core of ${p.id} is correct, efficient and ready to wire.

${COMMON.replace('you build the SELF-CONTAINED CORE of your package in NEW FILES ONLY', 'the builder built the self-contained core in new files only; YOU EDIT NOTHING IN THE REPO (scratch dir only)')}

THE PACKAGE: ${p.scope}

THE BUILDER'S REPORT:
${String(built)}

Read the code and the plan; run the tests yourself; write independent checks in your scratch dir (analytic cases, conservation, stiff and edge cases: zero, saturation, empty tanks, huge steps under warp, NaN/Infinity, save/load) and measure µs per call. Look for: wrong physics, units or parameter values, deviations from the plan, hidden allocation, non-determinism, instability at the step sizes the plan uses, implicit schemes that are not actually implicit, closed forms that are not exact, conservation leaks, warp-honesty holes, tests that would pass even if the physics were wrong, anything that would make wiring hard. Every defect needs evidence. No style preferences.`, { label: `review:${p.id}`, phase: 'Review', schema: REVIEW, effort: 'high' })
    .then(rev => ({ built, rev })),
  (x, p) => (x.rev && x.rev.defects && x.rev.defects.length)
    ? agent(`You are ${p.who}, the builder of the ${p.id} core. A skeptical reviewer found defects. Fix every real one (if you disagree, prove it with a test or measurement instead of changing code).

${COMMON}

YOUR PACKAGE: ${p.scope}

YOUR BUILD REPORT:
${String(x.built)}

THE REVIEW (JSON):
${JSON.stringify(x.rev)}

Re-run your tests and measurements. Final report (≤ 200 words): each defect id → fixed / disproved (evidence), final numbers, the wiring recipe.`, { label: `fix:${p.id}`, phase: 'Fix', effort: 'high' })
        .then(fix => ({ id: p.id, built: x.built, review: x.rev.summary, defects: x.rev.defects.map(d => d.id + ':' + d.severity), fix }))
    : { id: p.id, built: x.built, review: x.rev ? x.rev.summary : 'no review', defects: [], fix: 'no defects' },
)

return results
