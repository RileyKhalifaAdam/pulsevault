# Reality engine — the plan (version 2)

Settled by the user: **3D**, **a whole solar system or more**, **multiplayer**. No code exists yet.

Version 1 of this plan was workshop-scale and single-player (it is in the git history). Its two
solver tiers survive as the innermost layer of this one.

**Status of the evidence.** Two of three scale designs finished (`08-scale-designs.md`). The third
design and the comparative review were stopped to save usage, so the choice between designs below is
the lead's judgement and has not been reviewed.

## The verdict

The engine holds a star system as a tree of reference frames and simulates almost none of it in
detail at any moment. Gravity and orbits run for every body all the time, which is cheap. Machines
and flowing matter are simulated only inside small **regions of detail** around players. Everything
else is stored as exact totals and advanced by formula. Players share a region by exchanging inputs,
not states.

## Charter

The five points of version 1 stand: conservation laws are the only hard-coded physics; behaviour
comes only from geometry and measured material data; every shortcut is declared; every claim has a
test; units are enforced by types. Four are added:

6. **No global coordinates.** Every position is a frame plus a local coordinate. Time is an integer
   count of ticks of 1/480 s.
7. **Every hand-off is a double-entry transaction** in mass, momentum, angular momentum and energy,
   whether between levels of detail, regions or owners, with exactly one owner at all times.
8. **Nothing is silently frozen.** Whatever is not being simulated either advances by an exact
   formula or is reported as paused.
9. **A step is a pure function of state and tick-stamped inputs**, with no wall clock and no
   unseeded randomness. Save, replay and multiplayer all rest on this.

## What "a solar system or more" honestly means

- Every body in a star system moves under Newtonian gravity: about 34 heavy bodies attracting each
  other (ESTIMATE: up to 300-450), plus thousands of small bodies and vessels.
- "Or more" means more levels in the tree. A galaxy is a catalogue plus a generator; only the star
  system you are in is integrated.
- Planets are bodies with tables (interior structure, an atmosphere column, a seeded surface
  generator), not simulated matter. There is no global ocean, weather or geology.
- Nothing mechanical happens where no region is awake. A machine left running pauses unless it has
  an exact formula.
- Newtonian only: Mercury's orbit is off by 43 arcseconds per century, and results hold below about
  1% of light speed.
- Full detail exists only inside a region. The feasibility review re-derived the sustained browser
  budget as roughly 100-300 awake boxes and 3-8 thousand liquid particles (ESTIMATE), lower than
  version 1 claimed.

## Architecture

**Laws, materials and the world record (permanent).** As version 1, plus frames, integer time,
ports through which matter and energy cross a region's boundary, and a world record kept in memory
with a journal. The record is separate from the solvers that temporarily check out a region. That
separation gives save, recovery after the browser kills the page, and hand-off between players.

**Frames and precision.** Star systems are placed with 64-bit integers (1 km resolution, about a
million light-years of range). Bodies inside a system use 64-bit floats relative to their parent
body. A region has its own moving origin, and the GPU works in 32-bit relative to it.

**System tier (CPU, bit-exact).** A structure-preserving orbit integrator (the Wisdom-Holman
family) moves the heavy bodies. Gravity inside a region is supplied by this tier, including tides
and the effects of a rotating planet, so "g" is derived from mass and radius. Vessels do not perturb
planets, an error below what 64-bit numbers can represent (DERIVED). *Lead's choice:* integrate the
heavy bodies with mutual attraction instead of fixed two-body rails, because 34 bodies are cheap and
rails drop the perturbations; keep closed-form advance for dormant small objects.

**Matter across scales.** An unobserved object is an aggregate record (mass by material, centre of
mass, momentum, angular momentum, inertia, internal energy) plus a lossless snapshot of its
mechanism, about 4 kB for a 30-part rover (ESTIMATE). Terrain is a deterministic generator plus a
journal of what players changed. Entering a region promotes a record to full simulation; leaving
demotes it; both are double-entry.

**Regions of detail.** Roughly 250 m across (ESTIMATE). Inside, version 1's two tiers run
unchanged: the mechanism tier (CPU, bit-exact rigid bodies, joints, motors) and the matter tier
(GPU particles for liquids and sand).

**Time.** Each region has its own "now". Inside a region, time warp is a shared input. Across
regions you can only sync forward to one that is ahead.

**Multiplayer.**

- Inside a region, phones run the same bit-exact simulation in lockstep: they exchange inputs with a
  few frames of delay, compare a fingerprint of the state, and resync from a snapshot on mismatch.
  No rollback, because re-simulating multiplies CPU cost on a 4 W budget.
- Heavy bodies need no network at all: they are a pure function of the tick.
- A region is owned by lease. When a phone overheats, locks or is killed, the lease lapses and
  another player takes over or the region sleeps at its last checkpoint.
- Liquids and sand are not bit-exact between devices. One owner simulates them and shares a coarse
  summary, so rigid bodies agree exactly and splashes differ per viewer. **No shipped game does
  this; it is an untested design.**

| Step | Players | What you run | Rough cost |
|---|---|---|---|
| 1. Phones connect directly, one hosts | 2-4 | A free signalling service | $0-5 a month |
| 2. One dedicated server | 8-16 per region | One small rented server | €5-10 a month |
| 3. Several servers dividing space | Hundreds | One server each plus a relay | Scales with servers |

Player counts are the researcher's judgement. A server has no GPU, so matter stays owned by phones.

## Roadmap

| Phase | Goal |
|---|---|
| 0a. Probe | Measure your phone, including the orbit arithmetic |
| 0s. Two scales (new first build, CPU only) | Sun, eight planets and the Moon, plus one rigid cube resting on a surface in its own frame, with a time-warp slider. The cube's weight comes from the planet's mass and radius |
| 0b. Laws, frames, ledger, rigid blocks | The permanent layer, with frames and ports from the start |
| 1. Mechanisms | Joints, motors, batteries, sensors; suspending and resuming objects; warp |
| 1m. Two phones | Lockstep in one shared region, with lease takeover |
| 2. Real solar system and transit | Vessels, trajectory prediction, landing at one airless site |
| 3. Liquids inside a region | The GPU matter tier on a moving frame, with the shared summary |
| 4. Environment | Atmosphere, drag, entry heating, sunlight and temperature |
| 5. Bend, yield, break | Stiff parts deform at real stiffness (version 1's phase 2) |
| 6. Dedicated server, native app | Multiplayer step 2; remove the browser ceiling |
| 7. Builder kit and first game | Built only through the public API |

Later: several servers dividing space.

## Not done

- **Review of this version.** The third scale design and the comparison were not completed.
- **The red-team findings on version 1** (`07-plan-redteam.md`): 3 fatal and 33 major. The three
  fatal ones (no reference frames, a closed world with no boundary ports, no second scale in the
  roadmap) are answered by this version's structure. The 33 major ones are not yet addressed one by
  one. Among them: most of version 1's "done when" tests cannot be measured on the phone and need
  restating.
- **Detailed specs.** None written.

## Decisions that are yours

1. **Where it lives.** A new public repository is recommended; this session cannot create one.
2. **Real or invented solar system first.** Default: the real Sun, planets and Moon, since their
   orbits give exact test answers.
3. **Apple Developer Program** (US$99 a year): only needed for the native app in phase 6.
4. **Device lab.** Your phone needs iOS 26 or later (26.4 for the dedicated-server step), and each
   phase needs you to run a test and paste back the result. Multiplayer tests need a second phone.
