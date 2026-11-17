# TIDELOCK — design & architecture

TIDELOCK is an original hard-science space game for iPhone (Safari / installed PWA, WebGL2). It joins three
things that rarely meet:

1. **Real orbital mechanics.** True-scale star systems, patched conics, Δv budgets, manoeuvre nodes, transfer
   windows, aerobraking, gravity assists, rendezvous and docking. Nothing teleports: every trip is flown.
2. **A living political economy.** Supply-and-demand markets, minor factions with influence in every system,
   three great powers, states (boom, famine, war…), conflicts, expansions, reputation, crime and news — all
   simulated continuously and all pushed around by what the player does.
3. **Cinematic beauty.** HDR rendering, bloom, atmospheric scattering, ringed giants, detailed ships and
   stations, a crisp holographic interface. Every screenshot should look like concept art.

It is not a clone of any existing game: the setting, names, ships, factions, UI and art are our own.

## 1. Setting

The year is 2907. **The Ember Reach** is a cluster of ~24 star systems, most of them red dwarfs ("embers")
whose habitable worlds are tidally locked: one face forever toward the star, one forever dark, people living
along the twilight terminator. Red-dwarf systems are compact — planets sit a few million km from the star and
orbit in days — which makes real-scale interplanetary flight playable: transfers take hours to days, and
neighbouring worlds hang large in the sky. A few K/G/F stars, a white dwarf and brown dwarfs add variety.

Three great powers contest the Reach:

| id | Name | Character | Colour |
|----|------|-----------|--------|
| `assembly` | **Meridian Assembly** | Democratic/corporate federation of the terminator cities; trade, law, bureaucracy | teal `#3FD0C9` |
| `hegemony` | **Auric Hegemony** | Dynastic day-side industrial houses; foundries, fleets, patronage, order | gold `#F2B84B` |
| `league` | **Umbral League** | Night-side cooperatives, ice miners, free ports, smugglers; fiercely independent | violet `#9B7BFF` |

Independents are slate grey `#8A97A6`; outlaws ("Scorch clans") are red `#FF5A4D`. Every inhabited system has
3–6 minor factions, each aligned to a power or independent, competing for influence.

The player is an independent captain starting with a second-hand **Wren** courier and a small loan of credits.

## 2. Core loop

Dock → read markets, mission board, politics and news → pick a goal → plan the route (Δv and time are the real
costs) → fly it (burn, coast under time-warp, capture or aerobrake, rendezvous, dock) → get paid, shift
reputation and faction influence → upgrade the ship → reach further.

Careers that all feed the same simulation: **trading** (incl. smuggling), **missions** (courier, supply,
passengers, satellite deployment/recovery, rescue, bounties, survey), **mining**, **bounty hunting / piracy**,
**exploration** (orbital surveys sold to the Survey Office).

## 3. Conventions (binding)

- **Units:** SI — m, s, kg, rad, N, K. Credits `cr`. One cargo unit = 1 tonne. Never store km or degrees.
- **Axes:** right-handed, reference plane XZ, +Y north. Prograde = counter-clockwise seen from +Y
  (from +X toward −Z). Zero-element orbit: periapsis on +X, velocity at periapsis toward −Z.
  (Equivalently: take the textbook z-up formulas and map `(x, y, z)_textbook → (x, z, −y)`.)
- **Frames:** a moving object stores `r`, `v` relative to the centre of its SOI body in non-rotating system
  axes, plus that body's id. Absolute position = sum of positions up the parent chain (all on Kepler rails).
- **Ship-local axes:** forward −Z, up +Y, right +X (same as a three.js camera). Orientation quaternion maps
  local → world. Main-engine exhaust leaves toward local +Z.
- **Station-local axes:** +Y is the main/spin axis; stations keep a fixed inertial attitude with +Y along
  their orbit normal. Rotating sections are visual only.
- **Time:** `time` is sim seconds since the epoch (1 JAN 2907). One political/economic tick per sim day.
- **Determinism:** the simulation never calls `Math.random()` or `Date.now()`; use `core/rng.ts` seeded from
  ids. Rendering may use `Math.random()` for purely cosmetic jitter.
- **Colours:** linear RGB 0..1 in data; convert at the edge.
- **Propellant:** one tank feeds main drive, RCS and jump drive. Δv = vₑ·ln(m₀/m₁) is real and shown everywhere.
- **Language:** TypeScript strict; no `any` across module boundaries; pure functions for math; classes only
  where state is owned. No dependencies beyond `three` (pinned 0.180.0). No external assets of any kind — all
  geometry, textures, sounds and icons are procedural or inline.

## 4. Physics model

- Bodies move on fixed Kepler orbits (rails). Ships feel only the gravity of the body whose SOI they are in
  (patched conics), so predictions drawn on the map are exactly what will happen.
- Real time and low warp (≤4×, allowed under thrust): numeric integration (RK4, fixed sub-steps) of gravity +
  thrust + drag. High warp (to 1,000,000×, only when coasting outside atmosphere): analytic Kepler propagation
  with exact SOI-transition handling. Warp auto-drops before manoeuvre nodes, SOI changes, atmosphere,
  close approaches and hostile contacts.
- Attitude: torque-limited rotation with reaction wheels; SAS hold modes (stability, prograde, retrograde,
  normal ±, radial ±, target ±, manoeuvre, kill-relative-velocity).
- Atmospheres: exponential density, drag `½ρv²·CdA`, heating ∝ `√ρ·v³` against a heat budget — aerobraking is
  a real, risky way to save propellant. Hydrogen giants can be skimmed with a fuel scoop.
- Jump drive: only engages in flat space (farther than 8 radii from every body). Jumps take sim time and
  propellant per light-year and arrive in the destination's beacon parking orbit.
- Docking: request clearance inside the station's control zone, approach the assigned port along its axis,
  soft-capture below 3 m/s with reasonable alignment. A docking computer can fly it.
- The **flight computer** plans everything a phone player should not have to do by hand (circularise,
  Hohmann/Lambert transfers, plane matches, interplanetary windows, capture, rendezvous) as ordinary manoeuvre
  nodes the player can inspect, tweak and fly manually or let the autopilot execute. It never cheats physics.

## 5. Rendering contract

Stack: three.js 0.180.0, WebGL2, custom GLSL where needed. Two scenes share one camera orientation:

- **Far scene** — skybox, star, planets, moons, rings. Each body visual is authored as a **unit sphere at the
  origin** (radius 1 = body radius); the scene manager positions it camera-relative and scales it so angular
  size and depth order are exact (`renderPos = dir · D`, `scale = radius · D / distance`). Shaders must
  therefore work in units of body radius and take `uSunDir` (unit, world space) rather than light positions.
- **Near scene** — ships, stations, asteroids, cargo, effects, in metres, camera at the origin (floating
  origin: positions are computed in doubles relative to the camera, then cast to float). Near 0.3 m, far 80 km.
- Depth is cleared between the two. Everything renders into one HDR (half-float) target, then post:
  bloom → tone-map (filmic) → vignette/grain → AA → sRGB.
- **Light units:** sun-lit white diffuse ≈ 1.0 before tone-mapping. Lights/windows 2–8, engine cores and star
  discs 10–60 so bloom has something to work with. Keep albedos physically plausible (≤ 0.8).
- A body in a planet's shadow gets no direct starlight (eclipse factor comes from the scene manager), only
  planet-shine and ambient: orbital sunrises and sunsets must look right.
- Every visual factory returns `{ object3d, update(ctx), dispose() }` and never touches global renderer
  state. Quality tiers `low | medium | high | ultra` are passed in and respected.

### Performance budget (iPhone 15, A16, Safari, 60 fps)

- Internal resolution: device pixel ratio capped at 2, dynamic resolution scaling 0.6–1.0 of that.
- ≤ 200 draw calls and ≤ 500k triangles in a normal frame; instancing for anything repeated.
- ≤ 300 MB of GPU memory in total; planet surfaces are baked once into cube/equirect textures at load —
  never many-octave noise per pixel per frame on large surfaces.
- No per-frame allocations in hot paths (reuse vectors); no layout thrash in the HUD (transform/opacity only).
- GLSL ES 3.00, explicit precision, no extensions that iOS Safari lacks. Half-float render targets only.

## 6. Art direction

*Grounded industrial hard-sci-fi lit by real starlight.* Deep true blacks, HDR highlights that bloom, long
shadows, a restrained palette that lets starlight colour do the work (ember-orange under red dwarfs, clean
white under F stars). Reference feelings: orbital photography, film stills, high-end concept art — not
cartoons, not neon arcade.

- **Ships and stations:** believable engineering — panel seams, hull plating with subtle wear, exposed truss,
  radiators, tanks, antennae, docking collars, navigation strobes (red port / green starboard / white tail),
  warm window lights, livery stripes in faction or manufacturer colours. PBR metal/ceramic/carbon materials
  with procedural normal/roughness detail. Each hull has a distinct readable silhouette.
- **Worlds:** photoreal as far as procedural allows — crisp terminators, thin luminous atmospheres with
  coloured sunsets at the limb, cloud shadows, specular oceans, night-side city glow, banded giants with
  turbulent storms, rings with gaps and shadows.
- **Space:** a real-looking star field (thousands of sharp stars with a magnitude/colour distribution), a
  subtle galactic band and one or two distant nebulae per system. Dark, not purple soup.
- **Effects:** engine plumes with a hot core and shock structure, RCS puffs, glints, lens flare on the star,
  heat shimmer and plasma on aerobraking, restrained camera shake.

### Interface

Thin-line holographic instrumentation on near-black translucent glass. Calm, precise, legible in sunlight.

- Accent **ember amber** `#FFB454` (primary, selection, prograde); **ion cyan** `#6FE3FF` (information,
  targets, orbits); **signal red** `#FF5A4D` (danger); **go green** `#63E6A1` (nominal, profit);
  text `#E8EEF5` / dim `#8FA3B8`; panel glass `rgba(10,14,20,0.72)` with a 1px `rgba(255,255,255,0.08)`
  border and backdrop blur.
- Type: `"DIN Alternate", "Avenir Next", -apple-system, "SF Pro Text", system-ui, sans-serif`; numerals
  tabular; labels uppercase with wide tracking; nothing below 11 px; touch targets ≥ 44 pt.
- Layout works in **portrait and landscape**, respects safe-area insets, and is fully playable one- or
  two-thumbed. No hover-only affordances. Motion is short (120–240 ms), eased, purposeful.

### Audio

Procedural Web Audio only: a deep engine rumble that follows throttle, soft RCS hiss, tactile UI ticks,
docking clamps, alarms, and a sparse generative ambient score (slow evolving pads, distant bells) that shifts
with context (docked / coasting / combat). Unlocks on the first touch; respects a mute toggle.

## 7. Ships (original designs)

| id | Name / maker | Role | Length | Silhouette |
|----|--------------|------|--------|------------|
| `wren` | Corvane CD-7 **Wren** | courier (starter) | 16 m | compact arrowhead lifting body, twin side-mounted drive pods, bubble canopy |
| `drover` | Ilmarin **Drover** | hauler | 38 m | forward crew module, long truss spine carrying six cargo cans, single big drive bell |
| `magpie` | Hadley-Okafor **Magpie** | miner / salvager | 26 m | stubby industrial hull, chin-mounted mining laser boom, side hoppers, grapple arms |
| `shrike` | Corvane **Shrike** | fighter | 15 m | forward-swept strakes, long nose, twin canted fins, two close-set drives |
| `albatross` | Ilmarin **Albatross** | explorer | 34 m | slender hull, huge fold-out radiator wings, dish antenna, spherical tanks |
| `caravel` | Hadley-Okafor **Caravel** | heavy freighter | 72 m | blocky container stack around a keel, bridge tower aft, four drive bells |
| `halberd` | Auric Arsenal **Halberd** | gunship | 44 m | armoured wedge prow, dorsal turret ring, side sponsons, triple drives |

## 8. Module map

```
src/core/      types.ts (contract)  vec.ts  rng.ts  events.ts  units.ts
src/sim/       orbit.ts      Kepler math, body positions, SOI, patched-conic prediction
               lambert.ts    Lambert solver
               planner.ts    manoeuvre nodes + transfer / rendezvous / capture planners
               physics.ts    vessel dynamics, integration, warp, atmosphere, collisions
               autopilot.ts  attitude hold, burn execution, rendezvous & docking guidance
               universe.ts   galaxy generation (systems, bodies, stations, sites)
               economy.ts    commodities, markets, trade flows
               factions.ts   factions, powers, influence, states, conflicts, reputation, crime
               news.ts       generated news feed
               ships.ts      ship & module catalogue, loadouts -> VesselStats
               missions.ts   mission generation and lifecycle
               combat.ts     weapons, damage, shields, heat      npc.ts  NPC ships & traffic
               game.ts       GameSim facade: state, step(), actions, events, save/load
src/data/      shipLayouts.ts  stationLayouts.ts  (pure data shared by sim and render)
src/render/    pipeline.ts   renderer, HDR post chain, dynamic resolution, quality tiers
               scene.ts      system scene manager (far/near scenes, lighting, eclipse)
               camera.ts     chase / cockpit / orbit cameras
               mapview.ts    orbital map
               space/        sky.ts star.ts planet.ts ships.ts stations.ts asteroids.ts effects.ts
src/ui/        kit/ (design system)  hud/  station/  map/  galaxy/  menus/  tutorial/
src/audio/     audio.ts
src/main.ts    bootstrap + main loop
tests/         vitest unit + simulation tests       dev/harness/  visual harness pages
e2e/           Playwright flows                     tools/        shot.cjs, pw.cjs
```

## 9. Tooling

```
npm run build                      # dist/index.html + dist/game.js
npm run build:single               # + dist/tidelock.html (one self-contained file)
npm run typecheck                  # tsc --noEmit over src, dev, tests
npm test                           # vitest (tests/**/*.test.ts); `npx vitest run tests/orbit.test.ts` for one file
node build.mjs --harness <name>    # bundles dev/harness/<name>.ts -> dist/dev/<name>.html
node tools/shot.cjs dev/<name>.html?param=1 shots/<name>.png [--device iphone15|iphone15l|desktop] [--dpr 1|2] [--wait ms] [--eval js] [--tap x,y]
```

A harness is a tiny page that exercises one visual module in isolation; it must set `window.__ready = true`
after its first complete frame and should read URL parameters to switch variants. Headless Chromium renders
with SwiftShader (software) — images are correct but frame rates there say nothing about an iPhone.
`tools/pw.cjs` exports `launch(device)`, `serveDist()` and `waitReady(page)` for scripted Playwright flows.
Screenshots go under `shots/` (git-ignored).
