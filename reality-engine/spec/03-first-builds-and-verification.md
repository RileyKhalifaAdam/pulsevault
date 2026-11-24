# Spec 03 — First builds and verification

This spec says what is built first and how each build is proven: a bootstrap, a probe page (0a), a two-scale build (0s), a foundations build with rigid blocks (0b), then mechanisms and two phones in outline. It decides that release 1 ends there, that every phase exit is a list of numbered tests whose phone result fits in one pasted line, and that the WebAssembly file exactly as the compiler emits it, with no bindings tool, is the one arithmetic every machine runs. It fixes the fingerprint test that exists from the first commit and the machines it runs on, and it reports what was actually run in this container.

Tags: **[M]** measured (source named; "today" means commands run for this spec), **[D]** derived, **[E]** estimate until Phase 0a or a first run. Specs 01 and 02 are the foundations and system-tier specs; 01-research, 07 and 08 are the research, red-team and design files.

## 1. Release 1

| Phase | Delivers | Device sessions | User minutes [E] | Cut first |
|---|---|---|---|---|
| 0 Bootstrap | Repository, pinned toolchain script, build-test-deploy pipeline, a page printing its build id, one-tap result return (VF06, F23) | 0 | 10 | — |
| 0a Probe | Section 4 | 1 | 45 | Particle chain, isolation-shim check |
| 0s Two scales | Section 5 | 1 | 10 | Orbit drawing (numbers stay) |
| 0b Blocks | Section 6 | 1 | 35 | Orbit site, WebGL drawing |
| 1 Mechanisms | Section 9 | 1 | 35 | Slider joint |
| 1m-a Two phones, one room | Section 9 | 1, two phones | 40 | Late join |

Release 1 is these six, ending in a toy shared by URL (VF01, F02). Behind measured go/no-go, unscheduled: 1m-b (rendezvous worker, takeover), 34 bodies and vessels, liquids (single-player first; the shared summary is decided after that, VF18), environment, bend-yield-break, 6a server, 6b native app (VF17), terrain beyond one plane per site, a second awake region, per-region clocks.

**Time box and kill rule.** Device time is the scarce resource: each phase has one planned device session and one retry. A phase needing a third applies its cut list, then stops for re-planning with the user. Builder effort [E]: 1, 2, 3, 6, 8, 4 working sessions. From 0s on, each phase's page is a toy that imports only the public API (F16): "drop a cube on two worlds", then "throw blocks on two worlds and in orbit".

## 2. The development loop here

Run today with read-only commands and throwaway files in the scratchpad (`$S`); every observation is [M].

| Command | Observation |
|---|---|
| `rustc -vV; cargo -V; rustup target list --installed` | rustc and cargo 1.97.0, LLVM 22.1.6, host x86_64-unknown-linux-gnu; only the host target installed |
| `which wasm-bindgen wasm-pack wasm-opt wasmtime qemu-aarch64` | None (`/usr/bin/wasm-ld` exists) |
| `curl` of static.rust-lang.org `/dist/rust-std-1.97.0-wasm32-unknown-unknown.tar.xz`, then `sha256sum` | 200; 21.9 MB in 1.3 s; digest equals the published `.sha256`. `rustup target add` (not run: it writes outside the scratchpad) fetches this same component |
| `rustc --sysroot $S/sys --target wasm32-unknown-unknown --crate-type cdylib -C opt-level=3 -C strip=symbols` on a throwaway f64 kernel, in two folders | An 18,320-byte file with no imports; both builds have the same SHA-256 |
| `CARGO_HOME=$S/cargo-home cargo install wasm-bindgen-cli --locked --root $S/wb` | wasm-bindgen 0.2.130 built from crates.io in 87 s |
| `node -v` in `/opt/node22`, `/opt/node24`; `bun -v` | v22.23.5 (V8 12.4), v24.22.3 (V8 13.6); Bun 1.4.4, which runs JavaScriptCore, Safari's engine |
| The kernel natively, then `node run.mjs`, `bun run.mjs` (plain `WebAssembly.instantiate`) | One hash on native x86-64, both Nodes, Bun and a Chromium page: 7b9a6899fec2896e (10 bodies, 1e6 kick-drift steps), dee4618cf376e6c5 (34 bodies, 1e5); 5.1-8.4 ns per pair |
| Playwright 1.63.0 `chromium.launch` (HeadlessChrome 157.0.8103.78) on a local server, default flags | `navigator.gpu` exists; `requestAdapter()` returns null |
| Same with `--enable-unsafe-webgpu` | Software adapter (swiftshader, fallback). A WGSL compute shader compiles with 0 messages; 4,096 values read back correct; 1,000 dispatches encode in 0.8-6.4 ms and finish in 116-124 ms; WebGPU works in a dedicated Worker; origin-private files exist, `persisted()` false |
| Same, server sending isolation headers | `crossOriginIsolated` true; timer step 0.005 ms, against 0.1 ms without |
| `cargo build --release --target wasm32-unknown-unknown`, empty library depending on rapier3d-f64 0.36.1 with `enhanced-determinism`, `serde-serialize` | Compiles in 46 s (28 crates), no imports; that feature forces the pure-Rust `libm` maths |
| `curl -sI` | 200: static.rust-lang.org, index.crates.io, registry.npmjs.org, pypi.org. No response: octocat.github.io, pages.github.com, cdn.playwright.dev, ssd.jpl.nasa.gov. 403: api.github.com, GitHub release downloads. `/opt/pw-browsers` holds Chromium only |

**Consequences.**

- Inner loop (VF07): build with the wasm32 component; bit-exact tests under Node and Bun; headless Chromium with that flag for pages, WGSL and a two-page lockstep harness. The bootstrap script pins rustc 1.97.0, the component by digest, Node, Bun and Playwright; dependencies come only from crates.io with a committed lockfile.
- No bindings tool. It is installable but would rewrite the binary. The core exports plain functions over one command buffer and one result buffer; the host is hand-written JavaScript (F17). The compiler's output is the shipped file and its SHA-256 is the *build id*.
- Nothing here can show the deployed site, Safari or ARM64 (VF07, F07). Hence:

| Machine | Runs | When |
|---|---|---|
| Linux x86-64 runner | Canonical build twice (digests must match); all tests under Node 22, 24 and Bun; Chromium pages; deploy; a fetch of the live URL checking its build id | Every commit |
| Linux ARM64 runner (free for public repositories [E, from memory]) | The same file under Node and Bun: V8's and JavaScriptCore's ARM64 code generators | Every commit |
| macOS ARM64 runner (macOS 26, free for public repositories [M, 01-research]) | Safari driven by its WebDriver: fingerprint lines; WGSL compile checks if the runner exposes WebGPU [E] | Every deploy |
| Oracle job, Linux | Python with the DE440 kernel from PyPI and a high-order reference integrator; never shipped (VF15) | Nightly, and on integrator change |
| The phone | A16, iOS Safari, heat, storage, locking | Once per phase |

ARM64 is covered in three layers: two engines on a Linux ARM64 runner, Apple's Safari on a macOS runner, and the phone at each phase exit and each arithmetic-version change.

## 3. The fingerprint test

A *fingerprint* is spec 01's 64-bit hash of canonically serialised state (ascending id, little-endian, raw f64 bits). A *transcript* is a committed text file of (tick, fingerprint) lines produced by the canonical binary.

| Transcript | What is hashed | Exists from |
|---|---|---|
| T0 | Output bits of divide, square root, every own function, double-double, 128-bit integer and float-to-integer operations: 10,000 fixed inputs each | First commit |
| T1 | Heavy-body state at every checkpoint node of 1e6 steps (1.90 years [D: 6e7 s / 3.156e7]) | First commit, on a stub kernel until spec 02's method lands |
| T2 | 0s scenes: rest, drop, three anchors, three warp schedules | 0s |
| T3 | Scripted block scenes every 480 ticks to tick 10,000, with ledger and journal heads | 0a for the candidate solver; 0b in full |
| T4 | Snapshot bytes at tick 4,800 and the restored run at 9,600 | 0a |

**Failure** is any of: one differing bit between two WebAssembly platforms or against the committed file; a transcript edited without an arithmetic-version bump in the same commit; two clean builds with different digests; a non-finite value reaching the hasher; a first (cold) and later (warm) run differing on one engine. Any failure blocks deploy. A native build that differs is not a failure: it only obliges servers and native apps to run the .wasm (VP07). A phone mismatch blocks the phase; T0 names the operation, which is replaced by integer arithmetic, with 08's fixed-point heavy bodies as last resort.

**Build skew (VF14).** The .wasm file name contains its digest; the page fetches an uncached `build.json` and offers a reload when stale (Pages cache about 10 minutes [E]); handshake and world record carry the build id, and a mismatch is refused.

## 4. Phase 0a: the probe

One page, stages in order. Every cost is timed over a batch of at least 1,000 ticks or 200 ms, so Safari's 1 ms timer [M, WebKit source via 01-research] gives at most 0.5% error [D: 1/200] (VF02).

| Stage | Method | Result fields | Decision and budget |
|---|---|---|---|
| 1 Identity | Digest of the fetched .wasm; tab or Home Screen; iOS version typed in | `b`, `ios`, `mode` | Digest differs from CI: stop |
| 2 Timers | Smallest `performance.now()` step; 600 animation-frame intervals; `crossOriginIsolated` | `tq`, `raf`, `coi` | Median outside 16.7 +/- 0.5 ms: protocol broken, rerun. An isolation shim is needed only if `tq` forces batches over 2 s; release 1 ships none (F15) |
| 3 Arithmetic | T0, T1; ns per pair (10, 34 bodies); microseconds per step; ns per sine, Kepler solve, double-double add, ledger posting | `h0`, `h1`, `pk`, `st`, `fn` | **Hashes differ from the build server: no-go for all phone work** (section 3). Warp ceiling = 1.8 s / `st` [D: (warp / 3,600) steps per frame x `st` <= 0.5 ms] |
| 4 Record | Hash MB/s; serialise, hash and restore 300 synthetic bodies; origin-private write MB/s from a Worker; `persist()` answer; quota | `hr`, `sn`, `wr`, `ps`, `q` | `sn` over 4 ms [E]: checkpoints are sliced across frames. `ps` false: Home Screen install and export are required from 0b. Ledger line = `sn` / checkpoint interval + hash per tick (VF09, VF11) |
| 5 Rigid | Candidate solver in shipped configuration (rapier3d-f64, scalar, P17): pyramids of 50, 100, 200, 400 boxes; T3, T4 | `r50`..`r400`, `h3`, `h4` | B boxes per ms. Solo budget N1 = B x (C - page - system - ledger lines of spec 01); shared = N1 / 2 (VF04); players per region = shared / 30 parts (VP13). N1 under 60 [E]: reopen the solver decision |
| 6 WebGPU | Limits and features; one compute pass through the hand-written host, and in a Worker; every kernel file compiled, plus known trouble constructs [M, 01-research] | `lim`, `ft`, `wk`, `sc` | Settles F17 and F09; gates nothing in release 1 |
| 7 Dispatch, readback | 1,000 dispatches: CPU ms; map-read of 4 kB, 64 kB, 1 MB, 200 times each, in frames | `dp`, `rb` | Dispatch cap = 1 ms / `dp`. Median over 2 frames [E]: matter-coupled bodies are owner-authoritative only (VP09, P05) |
| 8 Particle chain | Scatter, grid update, 16 pressure sweeps, gather and sort at 4,096 to 32,768 particles, 600 frames each; CPU twin compared at 4,096 | `p4`..`p32` | Liquid budget = half the largest size with under 2% long frames; under 4,000: matter tier deferred (F04) |
| 9 Loopback channel | Two peer connections in the page, 60 packets per second | `dc` | Network CPU line; radio drain needs the second phone |
| 10 Soak, 20 min | CPU only (VF09): the stage-5 scene sized once to 5.0 ms per frame, then fixed; per minute: step cost, interval histogram, ticks done / due | `s30`, `f25`, `cg`, `str`, `b0`, `b1` | Pass: no 30 Hz stretch, under 2% of intervals above 25 ms, cost growth under 15% [E], ratio 1.000. Then C = 5.0 ms; else retry at 3.0, then 2.0; none passes: stop. Mean power = (`b0` - `b1`) x 0.39 W, +/- 0.39 W [D: 12.98 Wh [M, 01-research] x 1% x 3 per hour], replacing "4 W" (F20) |
| 11 Memory | WebAssembly memory, then GPU buffers, in 64 MB steps to 1,024 and 512 MB | `mw`, `mg` | Cap = half the last good step |

**Protocol for the user (F05).** (1) iOS 26 or later; type the version. (2) Battery 50-90%, unplugged and unused for 15 minutes. (3) Low Power Mode off, Auto-Brightness off, brightness slider at the middle, Auto-Lock "Never", Do Not Disturb on. (4) No case; flat on a hard table; room 20-25 degrees, typed in. (5) Safari tab, other tabs and apps closed. (6) Type the battery percentage, tap Start, do not touch for about 30 minutes, type the percentage again. (7) Tap Send result. If the page reloads itself, leave it: it resumes.

**Breadcrumbs.** Before each stage, soak minute and memory step, the page appends a line to an origin-private file `reality-engine/probe/crumbs` through a Worker's synchronous handle with flush, and proceeds only on the Worker's acknowledgement; the stage index is mirrored in the URL fragment. On load, a started but unfinished stage is marked KILLED, skipped, and the run continues. No localStorage is used, since that key space belongs to the existing site (F15).

**Result line.** One line, `RE1;0a;b=...;...;crc=....`, at most 900 bytes for 0a [E: 70 fields x 12 B] and 300 for later phases, shown with a Copy button and as a pre-filled GitHub issue link (F24). A CI job recomputes the hashes for that build id (F14); the line is committed under `results/`.

**Solver decision (F06, VF13).** Made in 0a on the build server: the candidate is adopted only if T3 is equal on every engine, T4 holds, a join from snapshot plus input tail matches after 10,000 ticks, and N1 is at least 60. Otherwise the fallback is 0s's hand-written contact code grown to box-box with a fixed-iteration impulse solve; 0b's effort doubles and its stack gate drops to 5 boxes [E].

## 5. Phase 0s: two scales

| | |
|---|---|
| Built | Ten bodies on spec 02's method from its DE440 start; integer spin phase; two sites, the equators of Earth and the Moon, each a tangent plane (F12); one surface region; one hand-written steel cube, 0.1 m, 7.85 kg [D: 7,850 x 0.001]; a region ledger (mass, momentum, energy, both potentials, ground reservoir, dissipation, numerical loss); tick-stamped input log; snapshot as a copyable string, which is also the export (VF11); Reality Report panel; Canvas 2D only (F22) |
| The user sees | A system view (dots, trails, date) and a site view (cube from the side; derived g, contact force, energy accounts) |
| The user can | Choose the site; Drop; Rest; move the warp slider; copy and paste a snapshot; Run tests |
| Warp rule | Any rate above 1x demotes the region. A falling cube refuses the request, by name; a resting cube is welded to the ground and reported as paused (P19, VP03) |
| Left out | WebGPU, solver library, joints, a second body, orbit regions, dormant orbit modes, vessels, terrain, 34 bodies, continuous zoom, the journal, network |

**Done when** A1-A3 and S1-S10 pass on the phone in one session and S11 on the build server (VP06, VF06).

## 6. Phase 0b: foundations and rigid blocks

| | |
|---|---|
| Built | Spec 01 for one region: typed units; steel, oak and rubber with pair records (P25); vacuum as the ambient-medium value (P14); per-frame ledger with per-operator numerical loss (P09); declared ports; world record, journal, checkpoints, snapshot; the closed input set including governor actions (P15, VP12, P22); every solver constant and clamp in the Reality Report (P08); namespaced origin-private storage from a Worker, `persist()` shown, file export and import (VF11) |
| Mechanism | Boxes on a plane through the engine's solver interface; f64 anchor-relative state; weld sleep; no absolute speed clamp (VP05) |
| Frames | Earth site, Moon site, a free-fall region at 400 km with re-basing; leavers become surface-dormant or mode-K records |
| Drawing | One instanced WebGL2 call, Canvas fallback; tests also run with drawing off (F22) |
| The user can | Pick site and material; spawn, throw and stack up to the budget; warp once everything rests; kill the app and return; export and import; read the ledger panel; Run tests |
| Left out | Joints and motors; shapes other than boxes; matter tier; network (lease fields exist, unused); a second awake region; terrain; thrust |

**Done when** B1-B13 pass, the phone part in one session from the Home Screen.

## 7. Test catalogue

Runs: N Node and Bun (here and both Linux runners), C headless Chromium, S Safari runner, P phone, O oracle job. Tolerances other than "0 bits" are [E].

| Test | Checks | Reference | Tolerance | Runs |
|---|---|---|---|---|
| A1 Build identity | Page runs the CI binary | SHA-256 | Equal | C S P |
| A2, A3 | T0; T1 | Committed transcript | 0 bits | N C S P |
| A4 | T3 on the candidate solver | Transcript | 0 bits | N C S P |
| A5 Continue | T4: snapshot, restore elsewhere, run on | Uninterrupted run | 0 bits | N P |
| A6 Join | Snapshot plus input tail, 10,000 ticks | Uninterrupted run | 0 bits | N |
| A7 Crumbs | Renderer killed mid-stage | Stage marked KILLED, run completes | Exact | C |
| A8 Kernels | Every WGSL file compiles; GPU equals CPU twin | Twin at 4,096 particles | 0 errors; 1e-4 relative | C S P |
| A9 Soak | Stage 10 | Its pass rule | As stated | P |
| S1 Warp invariance | Heavy hash at node 16,384 (11.4 days [D]) under three schedules, one through a restore | Transcript | 0 bits | N P |
| S2 Two-body closure | Integrator against the Kepler closed form, 1 year | Spec 02 | 0.1 m | N P |
| S3 Periods | Earth; mean of 13 lunar months | 365.256 d; 27.322 d (from memory) | 0.01 d; 0.05 d | N P |
| S4 Energy | Ten-body total, 10 years (5.26e6 steps [D]) | Initial value | 1e-10 relative | N P |
| S5 Weight | Mean contact force over 480 ticks | m(GM/R^2 - spin^2 R): 76.78 N, 12.75 N [D: 7.85 x 9.7803, x 1.6242] | 0.1% | P |
| S6 Fall | First-contact tick from 21.2 m and 3.52 m | sqrt(2h/g) = 999.4, 999.3 ticks [D] | 1 tick | P |
| S7 Frame invariance | Region hash with the body at the origin, at 1 AU moving 29.78 km/s, at 30 AU | Each other | 0 bits | N P |
| S8 Ledger | Closure each tick of S5, S6; roll-up surface to body to system and back | Spec 01 | Mass 0; spec 01's bound; 1 unit per body | N P |
| S9 Snapshot string | Copy, reload, paste, continue | Uninterrupted hash | 0 bits | P |
| S10 Pace | 5 minutes at 1x, 1 at the ceiling | Ratio 1.000; long intervals; tier cost | Under 2%; 0.1 and 0.5 ms | P |
| S11 Oracle | 10 bodies, 1 year; DE440 reported | High-order run of the same model | Planets 5 m, Moon 1 m | O |
| B1 | T3 at all three sites | Transcript | 0 bits | N C S P |
| B2 Recovery | Force-close mid-scene; resume from checkpoint plus journal | Hash at the next checkpoint | 0 bits | C P |
| B3 Ledger | Closure every tick of B13; a build with one posting removed must fail | Spec 01 | 0 breaches | N P |
| B4 Numerical loss | Named scenes; implicit-spring closed form | Physical dissipation | 10% | N |
| B5 Frames | S7 for blocks; re-base identity in orbit | KE' = KE - P.dV + 0.5 M dV^2 | 0 bits; 1 unit per body | N P |
| B6 Rotation, tide | 100 m drop at the equator; 10 m radial gap at 400 km after 100 s | 2.20 cm east; 10.192 m [D, 08] | 2%; 1% | N |
| B7 Stack | 10 steel boxes for 20 minutes, then welded | Top-box drift | 1 mm | N P |
| B8 Envelope | Block at 4.8 m/s onto a 1 cm plate; faster impact | No pass-through; declared event, mass and momentum exact | Exact (P11) | N |
| B9 Materials | 1 m drop rebound; slope either side of atan(static friction) | e(v)^2 h; holds, slides (spec 01 pair table) | 5%; 1.5 degrees | N P |
| B10 Purity | Phone journal replayed on the build server, governor actions included | Phone's checkpoint hashes | 0 bits | N |
| B11 Storage | Export, import; journal truncated at checkpoints; no write outside the namespace | Hash; file size cap | 0 bits | C P |
| B12 Dormant | Welded stack warped one day; block leaving the orbit region | Bits before; mass, momentum | 0 bits; 0 micrograms, one booked rounding | N |
| B13 Soak | N1 boxes, 20 minutes | Stage 10's rule, no dilation events | As stated | P |

## 8. Repository and delivery

| Module | One line |
|---|---|
| `toolchain/` | Pinned versions and the bootstrap script |
| `core/arith` | Own maths functions, double-double, constants, arithmetic version |
| `core/record` | Ids, records, canonical serialisation, fingerprint, journal, snapshot |
| `core/ledger`, `core/frames` | Accounts and closure; frame records and conversions |
| `core/system` | Heavy bodies, checkpoints, gravity packets, warp admission |
| `core/mechanism` | Solver interface, the adopted or hand-written solver behind it |
| `core/region` | Awake set, promote, demote, command stream |
| `core/abi` | Exported functions and the two buffers |
| `host/` | Loader with digest check, public API, storage Worker, drawing, result line, breadcrumbs |
| `kernels/` | WGSL files, manifest, CPU twins (probe only in release 1) |
| `pages/` | Index with build stamp; probe, two-scales, blocks |
| `tests/` | Transcripts, scripted scenes, engine runners, fault injection, oracle scripts |
| `data/` | Body table with provenance; materials and pairs with sources |
| `.github/workflows/` | Build, matrix, deploy, live-URL check, result verification |
| `results/` | Every pasted result line |

**Delivery.** A push builds, runs the matrix, deploys to Pages and fetches the live URL; the builder reads the run's logs. The phone alone shows Safari's hashes, its shader compiler, locking and heat.

**What the user does by hand (F24, VF19).**

| When | Step | Minutes [E] |
|---|---|---|
| Once | Create a public repository with a licence, or approve this session trying its repository-creation tool (listed in its catalogue [M]; never invoked, authorisation untested) | 3 |
| Once | Settings, Pages, Source: "GitHub Actions"; attach the repository to the session | 2 |
| Each phase | Open the URL in Safari, follow the on-page protocol, tap Send result | 10-45 |
| From 0b | Share, Add to Home Screen, open from the icon (wake lock works there [M, 01-research]) | 1 |
| 1m-a | A second phone on iOS 26 or later | — |
| 1m-b only | A Cloudflare account and a token stored as a repository secret | 15 |

**Sharing an origin (F15, P24).** A project site lives at `<account>.github.io/<repository>/`, the same origin as the existing PulseVault site, which keeps all its state in localStorage [M, 07]. Therefore: storage quota, the persistence grant and "clear website data" are shared, so no instruction ever says to clear site data and the pages offer "Delete engine data" for their own directory; the engine writes no localStorage and registers no service worker in release 1; engine pages load no third-party script, because any script there could read the other site's data; a clean origin needs a custom domain, a user decision. Safari may delete script-written data after seven days without interaction unless persistence is granted [M, 01-research], and a Home Screen app keeps storage apart from Safari tabs [E, from memory], so export and import are the only bridge.

## 9. Phases 1 and 1m, coarsely

| Phase | Exit criteria |
|---|---|
| 1 Mechanisms (hinge and slider joints, one motor-battery model, suspend, resume, warp) | One 30-part rover blueprint drives from voltages on Earth and Moon. Motor no-load speed and stall torque within 2% [E]; battery energy equals work plus heat within ledger closure. Foucault precession 10.64 degrees per hour at 45 degrees within 2% [D, 08]. A rover with spinning wheels and a flywheel is demoted and promoted: identical hash, angular momentum within 1e-12 [E] (VP14). Parked, warped a month, promoted: hash equals the pre-suspend hash and paused processes are listed (VP19). Two rovers pass stage 10's soak rule. The phone's journal replays on the build server |
| 1m-a (host-authoritative, offers exchanged as QR codes, no server, no takeover; VF03, VF08) | First, in two Chromium pages with 5% injected loss: zero mismatches in 10 minutes. Then two phones: 10 minutes at the shared budget with zero mismatches and ratio 1.000 on both; a build mismatch refused; a late joiner equal after 10,000 ticks (VP11); a guest that loses the host pauses and reports; battery drain with the channel open on both. The lock matrix (lock 3, 10, 60 s; app switch; notification pull-down; Low Power Mode; tab against Home Screen) records what each side sees (VF12) |
| 1m-b (go/no-go) | Three simulated peers, 1,000 random owner kills: never zero or two owners, ledger change 0 units (VP10). Lease expiry set from the lock matrix |

**The second phone is needed for** Safari-to-Safari data channels on real radios, fingerprint equality between two devices, the lock matrix, radio drain, real jitter for the input delay, and the slowest-phone budget rule. It is not needed for lockstep logic, joins or fault injection, which run here.

## Interfaces

**Assumed from 01.** The fingerprint function and canonical serialisation, defined before the first commit; record and snapshot formats; closure tolerances; the closed input set; pair table and restitution law; budget lines that section 4 replaces.

**Assumed from 02.** The integrator and its checkpoint nodes; the body table generated from DE440; site and gravity-packet definitions (9.7803 and 1.6242 m/s^2); warp admission. One difference: 02 lists the Foucault test under 0b; it needs a joint, so it moves to Phase 1 and B6 replaces it.

**Provided.** Pinned toolchain, canonical binary and build id; transcripts T0-T4; the result line and its fields; CI oracle jobs; the gates named by 01 and 02.

**Needed from later specs.** Mechanism: the solver interface with a complete snapshot, its constants, weld sleep. Matter: kernel manifest with a CPU twin per kernel and dispatches per frame. Multiplayer: handshake fields, join package, QR offer format, arbiter rules for the kill test. API (P20): games are written in JavaScript or TypeScript against `host/`'s public module; controller rate and event stream.

## Changes to the plan

- The roadmap gains Phase 0 (bootstrap); each "Goal" becomes numbered tests (VP06, VF02).
- Release 1 is cut at 1m-a; later rows are unscheduled go/no-go items; Phase 6 splits into 6a and 6b (VF01, VF17, VF18).
- "1m ... with lease takeover" becomes 1m-a without takeover; takeover is 1m-b (VF03, VF08).
- 0s: any warp above 1x puts the region to sleep; Canvas drawing; no continuous zoom (VF06).
- "This session cannot create one" becomes untested, tried only on the user's approval; licence, Pages source, Cloudflare account and the second phone's iOS version join the decisions (VF19).
- "100-300 boxes" and "4 W" are replaced by stages 5 and 10 (F20, VF09).
- "Paste back the result" becomes one line per phase, by issue link.
- No bindings tool in the shipped binary; hand-written host.

## Open items

- Whether Safari on the A16 reproduces T0-T4; this gates everything.
- Whether the Linux ARM64 runner is free, the macOS runner's Safari can be driven and exposes WebGPU, and builds are reproducible across hosts once dependencies are added.
- Whether breadcrumbs survive a real iOS page kill; the Pages cache lifetime; Home Screen storage separation.
- Whether the session's GitHub tools are authorised to create a repository and read issues and logs.
- Whether rapier3d-f64 passes T4; its phone throughput; every [E] threshold above.
