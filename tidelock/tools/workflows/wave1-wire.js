export const meta = {
  name: 'tidelock-wave1-wire',
  description: 'TIDELOCK wave 1: wire the pre-built cores into the game — spine (fixed tick), real thrusters, the body, hearing, honest pixels — each reviewed adversarially, then join, accept and publishable page',
  phases: [
    { title: 'Contract', detail: 'W1-A lands every day-1 contract field, stub and hook so the packages can work in parallel' },
    { title: 'Wire', detail: 'W1-A spine, W1-B thrusters, W1-C body, W1-E pixels — each wired, reviewed by a skeptic, fixed' },
    { title: 'Join', detail: 'seams, full proof, performance against the budget, page build' },
    { title: 'Accept', detail: 'an independent tester plays the build by touch and tries to break it; fixes' },
  ],
}

const ROOT = '/home/user/pulsevault/tidelock'
const SCRATCH = '/tmp/claude-0/-home-user-pulsevault/02af9242-a437-54ad-bf2c-efd96ec068b3/scratchpad/wave1'

const COMMON = `Project: TIDELOCK, an original hard-science space game for iPhone 15 (Safari, WebGL2, three.js 0.180.0, TypeScript strict, esbuild). Project root: ${ROOT} — cd there first. Scratch directory: ${SCRATCH}/<your label>/ (create it).

THE OWNER (plays only on an iPhone 15, inside the Claude app's page viewer): "Now make every possible thing simulated to the max while keeping performance." — "If something causes bad frame rate just aim for maximum efficiency and first principles thinking." (binding rule in CLAUDE.md) — earlier: "no UI except for moving my character; everything else controlled physically; everything based off of physics so nothing is not simulated."

THE BINDING PLAN is docs/SIMULATION.md. Read §1 in full (principles, budget and thermal headroom, architecture: the fixed 120 Hz tick, quanta under warp, the multi-rate scheduler, save compatibility; §1.4 the shared contract), WAVE 1 in full (W1-A … W1-E), the owner decisions (use the defaults), 'Added in review' and 'Review notes'. Also docs/ARCHITECTURE.md and CLAUDE.md (iPhone delivery rules).

WHERE THE BUILD IS (published to the owner as version 8): the 32 m Corvane Wren you live in and fly by touching physical controls; hybrid ray tracing (src/render/rt, RT tier Off/Low/Medium/High in the three-finger system menu, default High with a safety governor); photo-scanned CC0 textures; 27 loose objects you can grab, carry and throw (src/world/props.ts, e2e/props.cjs); hull-shape compound collisions (src/world/compound.ts in contact.ts). All proofs green: typecheck, unit tests (tests/gTolerance.test.ts excluded — see below), e2e/cockpit.cjs, e2e/interior.cjs, e2e/props.cjs, e2e/artifact.cjs.

PRE-BUILT CORES FOR WAVE 1 (new files, each adversarially reviewed and fixed, NOT yet wired; their WIRING headers give the exact recipe): src/world/events.ts (the §1.4 event ring); src/world/jets.ts (W1-B: per-jet RCS allocation table by minimum-propellant LPs, blowdown, engine spool and min-throttle hysteresis, hold wake time, FA line of sight, ledger helpers; Wren Z jets at (±2.8,−0.1,−14.45) and (±7.2,−0.6,11.0)); src/world/body.ts and src/world/quasistatic.ts (W1-C: felt acceleration from the ledger, impulse transfer, boot shear-impulse limit, helm torso/harness/head springs moving the eye, pinch-to-lean, rest/drift closed forms with nextBodyEvent/serviceBodies so loose objects never block sleep warp); src/world/dutyTape.ts and src/render/space/plumes.ts (W1-E: sunlit-condensate RCS puffs from the duty tape, main plume from engine level); src/audio/* (W1-D: attachAudio, createAudioFrame, fillAudioFrame, audio.update(frame, drain) — W1-A writes the app.ts hook). Wave-2 and wave-3 cores also exist as new files (attitude, cmg, aero, atmoProfile, nozzle, perturb, capture, stations, damage, refuel, landed, thermal, power, caution, shipSystems, cabin, life, hands, transitions, tides, bootSwitch, sleep, massProps, slosh, gimbal, flex, j2, vent, breach, doors, airlock, compartments, reactor, cryo, ablation, sensors, relnav, burnPlan, dockCam, injury, gTolerance …): DO NOT wire or edit them in wave 1; tests/gTolerance.test.ts is half-built — exclude it from vitest runs by name ('npx vitest run --exclude tests/gTolerance.test.ts').

RULES FOR PARALLEL WORK: edit only the files your package owns per docs/SIMULATION.md wave 1 (the contract stage has already put every shared field, stub and hook in place; if you still need a change in another package's file, make the smallest possible edit, mark it with a comment '// W1-x hook' and name it in your report); never run git commands that change the repository; during the Wire phase do NOT run the slow browser e2e suites (the machine has 4 cores and they take an hour under load) — use typecheck, unit tests and node benchmarks; a single harness screenshot is fine for render work; the join runs the e2e suites. Determinism, SI units, no allocation in per-tick paths, save → load → step bit-identical, warp honesty, the §1.2 budgets (measure in node and report µs).
THE CONTAINER RESTARTS WITHOUT WARNING every hour or two and kills every running agent. So: keep running notes in shots/notes-<your label with ':' replaced by '-'>.md (what is done, what is next, commands that pass) and update them after every meaningful step; FIRST THING, read that file if it exists — if it does, an earlier attempt of yours was killed: continue from it instead of starting over. Keep the tree compiling between steps where you can.
Final report (≤ 220 words): files changed, what you ran and saw (numbers), deviations from the plan with reasons, seams for the next engineer, what is not verified.`

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

phase('Contract')
const contract = await agent(`You are the simulation-architecture lead (package W1-A, the hub).

${COMMON}

YOUR TASK NOW — DAY 1 ONLY, so four engineers can then work in parallel without touching each other's files. Land, compile-clean and with all existing tests passing:
1. Every wave-1 field of §1.4 on Craft in src/world/state.ts and src/core/types.ts with loader defaults (jetDuty, engineThrust, engineTimer, rcsPropellant/Capacity (main pool becomes 22.5 t LH2, RCS 1.5 t hydrazine), fAcc/tauAcc/accT, dvImpulse/dwImpulse, airVel, heatFlux, holdWakeT), the rebuilt-at-load ones (jets, engines, jetTable) built through src/world/jets.ts in setup, and the migrate() of Decision 4 (saves of other versions load with defaults; never discarded).
2. The views in src/game/api.ts: CraftView.jetDuty, engineLevel, airVelocity, heatFlux; FlightView.specificForce, rcsPropellant; CrewView.eyeOffset; frame eyesClosed; session.drainEvents(cb) over src/world/events.ts.
3. Stubs with the final signatures for the interfaces other packages own (consumeLedger(c, out) in dynamics.ts returning zeros until W1-B fills it; the stepCrew/stepProps/nextBodyEvent signatures W1-C fills; frame.eyesClosed and interpolation inputs in render/frame.ts for W1-E), each marked '// W1-x fills'.
4. Move command(), faAxis, assistRef, the hold logic and arm() from session.ts UNCHANGED into the new src/game/flight.ts with tests passing (it then belongs to W1-B).
5. The audio hook in app.ts per the recipe at the top of src/audio/index.ts (attachAudio on boot; per frame createAudioFrame/fillAudioFrame/audio.update with session.drainEvents), feeding what exists today (zeros where wave-1 fields are not filled yet).
Do not build the tick, the scheduler or anything else yet — that is your Wire-phase task. Run typecheck and 'npx vitest run --exclude tests/gTolerance.test.ts'. Report (≤ 200 words): every field/stub/hook and its file, so the other engineers can rely on it.`, { label: 'contract:W1-A', phase: 'Contract', effort: 'high' })

const PKGS = [
  { id: 'W1-A', who: 'the simulation-architecture lead (package W1-A, the hub)',
    task: `Package W1-A "Spine" as docs/SIMULATION.md specifies, everything after day 1 (which you already landed — your contract report is below): the fixed tick Q = 1/120 s as an integer world.tick; inputs latched per tick; the controller grid at 60 Hz; crew/props/devices at h = Q with fixed sub-steps; craft synchronised on tick boundaries; warp in whole quanta q = Q·2^n chosen by the budget (rate of progress only, never the sequence); the renderer extrapolating < 1 tick from the world's own v and ω (amend docs/ARCHITECTURE.md §4 as the plan says) with look applied at render time; budgets in work units with perf.ts keeping ms per unit; session.setBudget (3 ms awake, 8 ms asleep with eyes closed); prediction in ≤ 0.3 ms slices only when visible; honest perf numbers; cheap rendering while asleep with eyes closed (with W1-E's frame.eyesClosed); hidden-page catch-up per D6 (capped at one sim day, honest warp); saves at tick boundaries with tick, latched inputs and controller state; the Yoshida literals; new tests/determinism.test.ts (30 vs 60 vs jittered 60 fps give bit-identical world state; save→load→step identical). You own: src/game/session.ts, src/game/api.ts, src/core/types.ts, src/app/app.ts, src/app/perf.ts, src/ui/perfOverlay.ts, src/world/{world,state,ephemeris,predict,math,index}.ts, tests/{session,world,worldPredict,determinism}.test.ts, docs/ARCHITECTURE.md.` },
  { id: 'W1-B', who: 'a senior spacecraft GNC and propulsion engineer',
    task: `Package W1-B "Real thrusters": wire src/world/jets.ts per its WIRING header and the plan — per-jet RCS with the computed authority replacing maxTorque, the separate hydrazine pool with blowdown, two engines as two forces with spool, ignition delay cut on a step boundary, 15% minimum throttle with hysteresis, the applied-force ledger filled every step (engines, jets, RK4-weighted drag) and consumeLedger, contact.ts hooks only (impulse accumulation into dvImpulse/dwImpulse; applied = 0 landed/docked/dry; landed load), airVel and heatFlux, applied ≠ commanded, the event-driven settled hold with holdWakeT (one deadband law at every warp), Flight Assist rework (main drive only above 0.18·a_main, RCS below; FA reference only within 100 km and line of sight), jet damping; HOLD_MAX_RATE 0.1 rad/s (D3); the 4 Z jets on all seven hulls in shipLayouts.ts. All the plan's W1-B tests, especially "the ledger is the truth" (∫fAcc = m·Δv − ∫m·g dt within 1e-9) and the one-minute-asleep hold staying within the deadband. You own: src/world/{dynamics,setup,control}.ts, src/world/contact.ts (hooks only), src/sim/ships.ts, src/data/shipLayouts.ts, src/game/flight.ts, src/world/jets.ts, tests/{worldCraft,ships,jets}.test.ts.` },
  { id: 'W1-C', who: 'a senior physics engineer for human-body and contact simulation in moving frames',
    task: `Package W1-C "The body": wire src/world/body.ts and src/world/quasistatic.ts per their WIRING headers and the plan — felt acceleration from the ledger (delete the rebuild from commands), impulse transfer to loose bodies and through the boots (shear-impulse limit, slip) and the harness, the helm torso/harness/head springs moving the eye (CrewView.eyeOffset; translate, never rotate — the VOR keeps gaze), boots with traction, pinch becomes leaning (not zoom) in input.ts without breaking the fixed pointer roles, loose objects and crew in rest/drift closed forms so they never block sleep warp, the event ring writes from props, crew and devices (contact, slide, boot, detent, toggle …) with the material constants in src/data/props.ts that the audio needs, camera.ts eye path. The existing e2e/props.cjs behaviours must keep working (grab, carry, throw by touch). All the plan's W1-C tests. You own: src/world/{crew,props,devices,events,body,quasistatic}.ts, src/render/camera.ts, src/app/input.ts, src/data/props.ts, tests/{crew,props,devices,body,quasistatic,events}.test.ts.` },
  { id: 'W1-E', who: 'a senior rendering engineer for physically based effects on mobile GPUs',
    task: `Package W1-E "Honest pixels": wire src/render/space/plumes.ts and src/world/dutyTape.ts per their WIRING headers (session records the tape each tick — ask for it through the contract stub or add a marked one-line hook) and do the rest of W1-E: remove every effect with no physical cause (the renderer's private engine spool, ignition kick and flicker; the hot pinpoint; the 0.25 duty threshold), RCS puffs and the main plume driven only by jetDuty/engineLevel from the world, particles against an inertial anchor, nothing in shadow, the hologram scale fix, screen washout in sunlight from the physical luminance, frame.eyesClosed and the eyes-closed render skip (including RT), the renderer's sub-tick extrapolation inputs. Keep the RT pipeline and the props visual working; budget: GPU at RT High ≤ 0 net, raster tiers ≤ +0.5 ms; no new draw-call explosion (one or two instanced draws for all puffs). One or two harness screenshots at most. You own: src/render/{scene,frame,pipeline}.ts, src/render/post/shaders.ts, src/render/space/{effects,hologram,instruments,star,sky,planet,cockpit,hullMaterials,ships,plumes}.ts, src/render/rt/* (eyes-closed skip only), src/world/dutyTape.ts, tests/plumes.test.ts.` },
]

phase('Wire')
const wired = await pipeline(
  PKGS,
  (p) => agent(`You are ${p.who}.

${COMMON}

THE CONTRACT STAGE IS DONE. Its report:
${String(contract)}

YOUR PACKAGE: ${p.task}`, { label: `wire:${p.id}`, phase: 'Wire', effort: 'high' }),
  (built, p) => agent(`You are an independent, skeptical reviewer (${p.who}). Try to REFUTE the claim that wave-1 package ${p.id} is correctly and efficiently wired into the game.

${COMMON.replace('RULES FOR PARALLEL WORK:', 'YOU EDIT NOTHING IN THE REPO (scratch dir only). RULES THE BUILDERS FOLLOWED:')}

THE PACKAGE: ${p.task}

THE BUILDER'S REPORT:
${String(built)}

Read the diff of the package's files ('git diff HEAD -- <files>'), the plan section and the core's WIRING header; run typecheck and the package's tests yourself; write independent checks in your scratch dir (conservation, determinism across frame rates, save/load mid-burn and mid-contact, warp, edge cases) and measure µs per tick. Look for: physics that is computed but not applied or applied twice, the ledger disagreeing with dynamics, things still set instead of integrated, frame-rate dependence, allocation in per-tick paths, warp-honesty holes, broken touch behaviour, deviations from the plan, tests that would pass even if the physics were wrong. Other packages are being wired at the same time; failures caused by their unfinished work are not defects of this package — say so. Every defect needs evidence. No style preferences.`, { label: `review:${p.id}`, phase: 'Wire', schema: REVIEW, effort: 'high' })
    .then(rev => ({ built, rev })),
  (x, p) => (x.rev && x.rev.defects && x.rev.defects.length)
    ? agent(`You are ${p.who}, who wired ${p.id}. A skeptical reviewer found defects. Fix every real one (if you disagree, prove it with a test or measurement instead of changing code).

${COMMON}

YOUR PACKAGE: ${p.task}

YOUR REPORT:
${String(x.built)}

THE REVIEW (JSON):
${JSON.stringify(x.rev)}

Re-run typecheck, your tests and measurements. Final report (≤ 200 words): each defect id → fixed / disproved (evidence), final numbers, seams left.`, { label: `fix:${p.id}`, phase: 'Wire', effort: 'high' })
        .then(fix => ({ id: p.id, built: x.built, review: x.rev.summary, defects: x.rev.defects.map(d => d.id + ':' + d.severity), fix }))
    : { id: p.id, built: x.built, review: x.rev ? x.rev.summary : 'no review', defects: [], fix: 'no defects' },
)
const wiredText = wired.map((w, i) => w ? `### ${w.id}\nWIRED: ${w.built}\nREVIEW: ${w.review}\nDEFECTS: ${w.defects.join(', ')}\nFIX: ${w.fix}` : `### ${PKGS[i].id}\n(no result — the agent failed; its partial work may be on disk)`).join('\n\n')

phase('Join')
const join = await agent(`You are the lead engineer and release engineer for wave 1: join four wired packages, hold the iPhone budget, and make sure the owner can play it.

${COMMON.replace('during the Wire phase do NOT run the slow browser e2e suites (the machine has 4 cores and they take an hour under load) — use typecheck, unit tests and node benchmarks; a single harness screenshot is fine for render work; the join runs the e2e suites.', 'you run the e2e suites now, one at a time (never in parallel; kill any leftover browser before starting the next; the machine has 4 cores).')}

THE CONTRACT REPORT:
${String(contract)}

THE FOUR PACKAGES:
${wiredText}

YOUR TASK (you may change any wave-1 file; keep fixes narrow): close every seam the reports name; make the whole loop coherent (tick → world → ledger → crew/props/devices → events → audio and render); prove it: 'npx tsc --noEmit -p .', 'npx vitest run --exclude tests/gTolerance.test.ts', 'npm run build', then one at a time 'node e2e/cockpit.cjs', 'node e2e/interior.cjs', 'node e2e/props.cjs', and finally 'node build.mjs --artifact' + 'node e2e/artifact.cjs' (direct and sandboxed iframe), page under 16 MB; update e2e checks only where wave 1 legitimately changed behaviour (e.g. pinch now leans instead of zooming; turning now costs RCS propellant; engine spool) and add e2e checks for the new behaviour the owner will notice: puffs from the jets that fire, the RCS gauge falling after a hard turn, the seat pushing back on ignition (eye offset), sound starting after the first tap (AudioContext running in the iframe), a loose object resting during sleep warp without limiting it. Measure the per-frame CPU of the whole simulation at 1× and under sleep warp against §1.2 (node benchmark plus the emulator's perf numbers) and the frame stats from the seat with RT High. Keep running notes in shots/wave1-join-notes.md (the container can restart). Final report (≤ 250 words): what the owner will notice that is new, numbers vs budget, what is still wrong, every risk on the real iPhone.`, { label: 'join', phase: 'Join', effort: 'high' })

phase('Accept')
const ACCEPT = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    defects: REVIEW.properties.defects,
    summary: { type: 'string' },
  },
  required: ['pass', 'defects', 'summary'],
}
const accept = await agent(`You are an independent acceptance tester and physicist. The owner will play this build on an iPhone 15 by touch only. Try to BREAK wave 1.

${COMMON.replace('RULES FOR PARALLEL WORK:', 'YOU EDIT NOTHING IN THE REPO except new scratch scripts in your scratch dir. RULES THE BUILDERS FOLLOWED:')}

THE JOIN REPORT:
${String(join)}

Build nothing new; use dist/ as built (run 'node build.mjs --artifact' only if dist is missing). Drive the game with Playwright and real touch events (borrow helpers from e2e/cockpit.cjs and e2e/props.cjs), at the iPhone 15 viewport, inside the sandboxed iframe like e2e/artifact.cjs. Play it as the owner would for a while: tap in, walk to the helm, strap in, turn hard with the stick (puffs from the right jets? RCS gauge falls? turn rate honest?), light the drive at 15% and 100% (spool, seat push, plume), Flight Assist on and off, unstrap and walk under thrust, grab and throw a mug, sleep in the bunk with time acceleration (does the hold keep pointing? do loose objects stay put and not limit warp?), wake, pinch to lean, the three-finger menu with RT tiers, the error panel never appears, no page errors, no network. Check physics claims numerically through the page's test hooks where they exist (ledger vs Δv, determinism at 30 vs 60 fps if exposed). Report every defect with evidence (screenshot path, log line, number). pass = true only if nothing would make the owner's first ten minutes worse than the previous build.`, { label: 'accept', phase: 'Accept', schema: ACCEPT, effort: 'high' })

let finalFix = 'no defects'
if (accept && accept.defects && accept.defects.length) {
  finalFix = await agent(`You are the wave-1 release engineer. The acceptance tester found defects. Fix every real one (blockers and majors first; if you disagree, prove it), then re-run the affected proofs one at a time and finally 'node build.mjs --artifact' + 'node e2e/artifact.cjs'.

${COMMON.replace('during the Wire phase do NOT run the slow browser e2e suites (the machine has 4 cores and they take an hour under load) — use typecheck, unit tests and node benchmarks; a single harness screenshot is fine for render work; the join runs the e2e suites.', 'run the e2e suites one at a time, never in parallel.')}

THE JOIN REPORT:
${String(join)}

THE ACCEPTANCE REPORT (JSON):
${JSON.stringify(accept)}

Final report (≤ 200 words): each defect id → fixed / disproved / left (why), proofs run and their results, the artifact check result and page size.`, { label: 'final-fix', phase: 'Accept', effort: 'high' })
}

return { contract, wired: wired.map(w => w && { id: w.id, defects: w.defects, fix: w.fix }), join, accept, finalFix }
