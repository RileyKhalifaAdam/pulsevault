# Spec 03 — First builds and verification

This spec says what is built first and how each build is proven: a bootstrap, a probe page (0a), a two-scale build (0s), a foundations build with rigid blocks (0b), then mechanisms and two phones in outline. It decides that release 1 ends there, that every phase exit is a list of numbered tests whose phone result fits in one pasted line, and that the WebAssembly file exactly as the compiler emits it is the one arithmetic every machine runs. It fixes the fingerprint test that exists from the first commit and reports what was run here.

Tags: **[M]** measured ("today": run for this spec), **[D]** derived, **[E]** estimate until measured. 01 and 02 are the sibling specs; R1, 07, 08 are 01-research.md, 07-plan-redteam.md, 08-scale-designs.md.

## 1. Release 1

| Phase | Content | Cut first | User minutes [E] |
|---|---|---|---|
| 0 Bootstrap | Repository, pinned toolchain script, build-test-deploy pipeline, a page printing its build id, one-tap result return (VF06, F23) | — | 5 |
| 0a Probe | Section 4 | Particle chain | 45 |
| 0s Two scales | Section 5 | Orbit drawing | 10 |
| 0b Blocks | Section 5 | Orbit site, WebGL drawing | 35 |
| 1 Mechanisms | Section 8 | Slider joint | 35 |
| 1m-a Two phones, one room | Section 8 | Late join | 40 |

Release 1 is these six (VF01, F02). Everything else is unscheduled behind a measured go/no-go: 1m-b (rendezvous worker, takeover), 34 bodies and vessels, liquids (single-player first, VF18), environment, bend-yield-break, 6a server, 6b native app (VF17), real terrain, a second awake region, per-region clocks.

**Time box and kill rule.** Device time is scarce: one planned device session per phase, one retry. A phase needing a third applies its cut, then stops for re-planning. Builder effort [E]: 1, 2, 3, 6, 8, 4 sessions. From 0s each page is a toy importing only the public API (F16).

## 2. The development loop here

Run today with read-only commands and throwaway files in the scratchpad (`$S`); all [M].

| Command | Observation |
|---|---|
| `rustc -vV; rustup target list --installed; which wasm-bindgen wasm-opt qemu-aarch64` | rustc 1.97.0, LLVM 22.1.6, x86-64 Linux; no wasm32 target, bindings tool or ARM emulator. (`cargo install wasm-bindgen-cli --locked --root $S/wb` does build 0.2.130 from crates.io, in 87 s) |
| `curl` static.rust-lang.org `/dist/rust-std-1.97.0-wasm32-unknown-unknown.tar.xz`; `sha256sum` | 200, 21.9 MB, digest as published. `rustup target add` fetches this file (not run: it writes outside the scratchpad) |
| `rustc --sysroot $S/sys --target wasm32-unknown-unknown --crate-type cdylib -C opt-level=3 -C strip=symbols`, throwaway f64 kernel, two folders | 18,320 bytes, no imports, identical SHA-256 |
| Kernel natively; `node run.mjs` (v22.23.5, v24.22.3); `bun run.mjs` (1.4.4: JavaScriptCore, Safari's engine) | One hash everywhere, also in a Chromium page: 7b9a6899fec2896e (10 bodies, 1e6 steps), dee4618cf376e6c5 (34 bodies, 1e5); 5.1-8.4 ns per pair |
| Playwright 1.63.0 `chromium.launch` (HeadlessChrome 157), local server | Default flags: no adapter. With `--enable-unsafe-webgpu`: a SwiftShader software adapter runs a WGSL compute shader (4,096 values correct; 1,000 dispatches in 116-124 ms), also in a Worker. Timer step 0.1 ms; 0.005 ms with isolation headers |
| `cargo build --release --target wasm32-unknown-unknown`, empty library on rapier3d-f64 0.36.1 (`enhanced-determinism`, `serde-serialize`) | Compiles in 46 s, no imports; the feature forces pure-Rust `libm` |
| `curl -sI` | Reachable: static.rust-lang.org, index.crates.io, registry.npmjs.org, pypi.org. Not: octocat.github.io, cdn.playwright.dev, ssd.jpl.nasa.gov. Only Chromium is installed |

- **Inner loop (VF07).** Node and Bun for bit-exact tests; Chromium with that flag for pages, WGSL and a two-page lockstep harness. The bootstrap script pins rustc, the wasm32 component by digest, Node, Bun, Playwright and a lockfile of crates.io-only dependencies.
- **No bindings tool:** it would rewrite the binary. The core exports plain functions over one command and one result buffer; the host is hand-written JavaScript (F17). The compiler's output ships; its SHA-256 is the *build id*, carried in the file name, handshake and world record, where a mismatch is refused (VF14).
- **Machines.** The deployed site, Safari and ARM64 cannot be seen from here (F07):

| Machine | Runs | When |
|---|---|---|
| Linux x86-64 runner | Canonical build twice (digests must match); all tests under Node and Bun; Chromium pages; deploy; fetch the live URL, check its build id | Every commit |
| Linux ARM64 runner [E: free for public repositories] | The same file under Node and Bun: both engines' ARM64 code generators | Every commit |
| macOS ARM64 runner [M, R1] | Safari by WebDriver: fingerprint lines; WGSL compiles if WebGPU is exposed [E] | Every deploy |
| Oracle job | Python: DE440 from PyPI, a high-order reference integrator; never shipped (VF15) | Nightly |
| The phone | A16, iOS Safari, heat, storage, locking; the third ARM64 check | Once per phase |

## 3. The fingerprint test

A *fingerprint* is 01's 64-bit hash of canonically serialised state. A *transcript* is a committed file of (tick, fingerprint) lines from the canonical binary.

| Transcript | What is hashed | From |
|---|---|---|
| T0 | Output bits of divide, square root, every own function, double-double, 128-bit integer and float-to-integer operations; 10,000 fixed inputs each | First commit |
| T1 | Heavy-body state at each checkpoint node of 1e6 steps (1.90 years [D: 6e7 s / 3.156e7]) | First commit (stub kernel until 02's method lands) |
| T2 | 0s scenes: rest, drop, three anchors, three warp schedules | 0s |
| T3 | Scripted block scenes every 480 ticks to 10,000, with ledger and journal heads | 0a, 0b |
| T4 | Snapshot bytes at tick 4,800; the restored run at 9,600 | 0a |

**Failure** is any of: one bit differing between two WebAssembly platforms or from the committed file; a transcript edited without an arithmetic-version bump; two clean builds with different digests; a non-finite value reaching the hasher; a cold and a warm run differing on one engine. Failure blocks deploy. A differing native build only obliges servers and native apps to run the .wasm (VP07). A phone mismatch blocks the phase: T0 names the operation, which is replaced by integer arithmetic; 08's fixed-point heavy bodies are the last resort.
## 4. Phase 0a: the probe

One page, stages in order. Costs are timed over batches of at least 1,000 ticks or 200 ms, so Safari's 1 ms timer [M, R1] costs at most 0.5% [D: 1/200].

| Stage | Method | Result fields | Decision; budget re-derived |
|---|---|---|---|
| 1 Identity | Digest of the fetched .wasm; tab or Home Screen; typed iOS version | `b`, `ios`, `mode` | Digest differs from CI: stop |
| 2 Timers | Smallest `performance.now()` step; 600 frame intervals | `tq`, `raf` | Median outside 16.7 +/- 0.5 ms: rerun. Isolation shim needed only if `tq` forces batches over 2 s; release 1 ships none (F15) |
| 3 Arithmetic | T0, T1; ns per pair; microseconds per step; ns per sine, Kepler solve, ledger posting | `h0`, `h1`, `pk`, `st`, `fn` | **Hashes differ from the build server: no-go for all phone work.** Warp ceiling = 1.8 s / `st` [D: (warp / 3,600) steps per frame x `st` <= 0.5 ms] |
| 4 Record | Hash MB/s; serialise, hash, restore 300 synthetic bodies; origin-private write MB/s from a Worker; `persist()` answer | `hr`, `sn`, `wr`, `ps` | `sn` over 4 ms [E]: checkpoints sliced across frames. `ps` false: Home Screen install required. Ledger line = `sn` / checkpoint interval + hash per tick (VF09, VF11) |
| 5 Rigid | Candidate solver as it would ship (rapier3d-f64, scalar; P17): 50 to 400 boxes; T3, T4 | `r50`..`r400`, `h3`, `h4` | B boxes per ms. Solo budget N1 = B x (C minus 01's page, system and ledger lines); shared = N1 / 2 (VF04); players = shared / 30 parts (VP13) |
| 6 WebGPU | Limits, features; a compute pass through the hand-written host, and in a Worker; every kernel compiled | `lim`, `ft`, `wk`, `sc` | Settles F17, F09; gates nothing in release 1 |
| 7 Dispatch, readback | 1,000 dispatches: CPU ms; map-read of 4 kB to 1 MB, in frames | `dp`, `rb` | Dispatch cap = 1 ms / `dp`. Median over 2 frames [E]: matter-coupled bodies owner-authoritative only (VP09, P05) |
| 8 Particle chain | Scatter, grid update, 16 pressure sweeps, gather, sort; 4,096 to 32,768 particles | `p4`..`p32` | Liquid budget = half the largest size with under 2% long frames; under 4,000: matter tier deferred (F04) |
| 9 Soak, 20 min | CPU only (VF09): the stage-5 scene sized once to 5.0 ms per frame, a loopback data channel carrying 60 packets per second; per minute: step cost, interval histogram, ticks done / due | `s30`, `f25`, `cg`, `str`, `b0`, `b1` | Pass: no 30 Hz stretch, under 2% of intervals above 25 ms, cost growth under 15% [E], ratio 1.000. Then C = 5.0 ms; else retry at 3.0, then 2.0, then stop. Power = (`b0` - `b1`) x 0.39 W, +/- 0.39 [D: 12.98 Wh [M, R1] x 1% x 3 per hour], replacing "4 W" (F20) |
| 10 Memory | WebAssembly memory, then GPU buffers, in 64 MB steps to 1,024 and 512 MB | `mw`, `mg` | Cap = half the last good step |

**Protocol for the user (F05).** (1) iOS 26 or later; type the version. (2) Battery 50-90%, unplugged and idle 15 minutes. (3) Low Power Mode off, Auto-Brightness off, brightness mid-slider, Auto-Lock "Never". (4) No case, flat on a hard table; type the room temperature. (5) Safari tab, all else closed. (6) Type the battery percentage, tap Start, wait about 30 minutes, type it again. (7) Tap Send result; if the page reloads, leave it: it resumes.

**Breadcrumbs.** Before each stage, soak minute and memory step the page appends a line to an origin-private file through a Worker's synchronous handle, flushed, and waits for the acknowledgement. On load, an unfinished stage is marked KILLED and skipped. localStorage is not used: it belongs to the existing site (F15).

**Result line.** `RE1;0a;b=...;...;crc=....`: at most 900 bytes for 0a [E: 70 fields x 12 B], 300 later; shown with a Copy button and as a pre-filled GitHub issue link (F24). CI recomputes the hashes for that build id (F14).

**Solver decision (F06, VF13).** Made in 0a: the candidate is adopted only if A2-A4 pass and N1 is at least 60 [E: two 30-part rovers]. Otherwise 0s's hand-written contact code grows to box-box with a fixed-iteration impulse solve, and 0b's stack gate drops to 5 boxes [E].

## 5. Phases 0s and 0b

| | 0s Two scales | 0b Foundations and blocks |
|---|---|---|
| Built | Ten bodies on 02's method; two sites, the equators of Earth and the Moon, each a tangent plane (F12); one surface region; one hand-written steel cube, 0.1 m, 7.85 kg [D: 7,850 x 0.001]; a region ledger with both potentials, ground reservoir, dissipation and numerical loss; tick-stamped input log; snapshot as a copyable string, also the export (VF11); Reality Report | 01 for one region: units; steel, oak, rubber with pair records (P25); vacuum as the ambient value (P14); per-operator numerical loss (P09); ports; world record, journal, checkpoints; the closed input set, governor actions included (P15, VP12); solver constants and clamps in the Reality Report (P08); namespaced origin-private storage, file export (VF11). Boxes through the solver interface: f64 anchor-relative, weld sleep, no speed clamp (VP05). Sites: Earth, Moon, a free-fall region at 400 km; leavers become dormant records |
| Drawing | Canvas 2D: system view, side view of the site (F22) | One instanced WebGL2 call, Canvas fallback; tests run with drawing off |
| The user can | Choose the site; Drop; Rest; read derived g, contact force, energy accounts; set warp; copy and paste a snapshot; Run tests | Pick site and material; spawn, throw, stack; warp; kill the app and return; export, import; read the ledger; Run tests |
| Warp | Above 1x the region is demoted: a falling cube refuses, by name; a resting cube is welded and reported paused (P19, VP03) | Same, for all blocks |
| Left out | WebGPU, solver library, joints, a second body, orbit regions, terrain, 34 bodies, continuous zoom, journal, network | Joints, motors, other shapes, matter tier, network, a second awake region, thrust |
| Done when | A1, A2, S1-S9 pass on the phone in one session; S2's oracle part on the build server | B1-B11 pass; the phone part in one session from the Home Screen |

## 6. Test catalogue

Runs: N Node and Bun, C Chromium, S Safari runner, P phone, O oracle job. Tolerances other than 0 bits are [E].

| Test | Checks | Reference | Tolerance | Runs |
|---|---|---|---|---|
| A1 Build identity | Page runs the CI binary | SHA-256 | Equal | C S P |
| A2 Transcripts | T0, T1; T3 on the candidate solver | Committed file | 0 bits | N C S P |
| A3 Continue | T4: snapshot, restore elsewhere, run on | Uninterrupted run | 0 bits | N P |
| A4 Join | Snapshot plus input tail, 10,000 ticks | Uninterrupted run | 0 bits | N |
| A5 Crumbs | Renderer killed mid-stage | Stage marked KILLED; run completes | Exact | C |
| A6 Kernels | WGSL compiles; GPU against CPU twin, 4,096 particles | Twin | 0 errors; 1e-4 | C S P |
| S1 Warp invariance | Hash at node 16,384 (11.4 days [D]); three schedules, one through a snapshot copied, reloaded and pasted | Transcript | 0 bits | N P |
| S2 Orbit accuracy | Two-body run, 1 year; ten bodies, 1 year, DE440 difference reported | Kepler closed form; high-order run of the same model (02) | 0.1 m; planets 5 m, Moon 1 m | N P; O |
| S3 Periods | Earth; mean of 13 lunar months | 365.256 d; 27.322 d (from memory) | 0.01 d; 0.05 d | N P |
| S4 Energy | Ten-body total, 10 years (5.26e6 steps [D]) | Initial value | 1e-10 relative | N P |
| S5 Weight | Mean contact force over 480 ticks | m(GM/R^2 - spin^2 R): 76.78 N, 12.75 N [D: 7.85 x 9.7803, x 1.6242] | 0.1% | P |
| S6 Fall | First-contact tick from 21.2 m, 3.52 m | sqrt(2h/g): 999.4, 999.3 ticks [D] | 1 tick | P |
| S7 Frame invariance | Region hash, body at the origin, at 1 AU moving 29.78 km/s, at 30 AU | Each other | 0 bits | N P |
| S8 Ledger | Closure each tick of S5, S6; roll-up surface to system and back | 01 | Mass 0; 01's bound; 1 unit per body | N P |
| S9 Pace | 5 minutes at 1x, 1 at the ceiling | Tick ratio 1.000; long intervals; tier cost | 2%; 0.1, 0.5 ms | P |
| B1 Transcript | T3, three sites | Committed file | 0 bits | N C S P |
| B2 Recovery, storage | Force-close, resume from checkpoint plus journal; export, import; journal truncated at checkpoints; no write outside the namespace | Next checkpoint hash; size cap | 0 bits | C P |
| B3 Ledger | Closure every tick of B11; a build with one posting removed must fail; numerical loss on named scenes | 01; physical dissipation | 0 breaches; 10% | N P |
| B4 Frames | S7 for blocks; re-base in orbit | KE' = KE - P.dV + 0.5 M dV^2 | 0 bits; 1 unit per body | N P |
| B5 Rotation, tide | 100 m equatorial drop; 10 m radial gap at 400 km, 100 s | 2.20 cm east; 10.192 m [D, 08] | 2%; 1% | N |
| B6 Stack | 10 steel boxes, 20 minutes | Top-box drift | 1 mm | N P |
| B7 Envelope | Block at 4.8 m/s onto a 1 cm plate; a faster one (P11) | No pass-through; declared event, mass and momentum exact | Exact | N |
| B8 Materials | 1 m rebound; slope either side of atan(static friction) | e(v)^2 h; holds, slides (01) | 5%; 1.5 degrees | N P |
| B9 Purity | Phone journal replayed on the build server, governor actions included | Phone's checkpoint hashes | 0 bits | N |
| B10 Dormant | Welded stack warped a day; block leaving the orbit region | Bits before; mass, momentum | 0 bits; 0 micrograms, one booked rounding | N |
| A7, B11 Soak | Stage 9; in 0b, N1 boxes with no dilation events | Stage 9's rule | — | P |

## 7. Repository and delivery

| Module | One line |
|---|---|
| `toolchain/` | Pinned versions, bootstrap script |
| `core/arith`, `core/record` | Own maths, arithmetic version; records, serialisation, fingerprint, journal, snapshot |
| `core/ledger`, `core/frames`, `core/system` | Accounts; frame conversions; heavy bodies, gravity packets, warp admission |
| `core/mechanism`, `core/region` | Solver interface and solver; awake set, promote, demote, commands |
| `core/abi`, `host/` | Exported functions; loader with digest check, public API, storage Worker, drawing, result line |
| `kernels/`, `pages/` | WGSL files with CPU twins (probe only); probe, two-scales, blocks |
| `tests/`, `data/`, `results/` | Transcripts, scenes, runners, oracle scripts; body table, materials, pairs; pasted lines |
| `.github/workflows/` | Build, matrix, deploy, live-URL check, result verification |

**Delivery.** A push builds, runs the matrix, deploys to Pages and fetches the live URL; the builder reads the run's logs.

**By hand (F24, VF19).**

| When | The user's step | Minutes [E] |
|---|---|---|
| Once | Create a public repository with a licence, or approve this session trying its repository-creation tool (in its catalogue [M]; never invoked) | 3 |
| Once | Settings, Pages, Source: "GitHub Actions"; attach the repository to the session | 2 |
| Each phase | Open the URL in Safari, follow the on-page protocol, tap Send result | Section 1 |
| From 0b | Share, Add to Home Screen, open from the icon (wake lock works there [M, R1]) | 1 |
| 1m-a | Bring a second phone on iOS 26 or later | — |
| 1m-b only | A Cloudflare account; its token as a repository secret | 15 |

**Sharing an origin (F15, P24).** A project site lives at `<account>.github.io/<repository>/`, the same origin as the existing PulseVault site, which keeps its state in localStorage [M, 07]. Quota, the persistence grant and "clear website data" are shared, so no instruction says to clear site data; the pages offer "Delete engine data" for their own directory. The engine writes no localStorage, registers no service worker and loads no third-party script, since any script there could read the other site's data. Safari may delete script-written data after seven idle days unless persistence is granted [M, R1], and a Home Screen app keeps storage apart from Safari tabs [E]: export and import are the bridge.

## 8. Phases 1 and 1m, coarsely

| Phase | Exit criteria |
|---|---|
| 1 Mechanisms: hinge and slider joints, one motor-battery model, suspend, resume, warp | One 30-part rover blueprint drives from voltages on Earth and the Moon. Motor no-load speed and stall torque within 2% [E]; battery energy equals work plus heat to ledger closure. Foucault precession 10.64 degrees per hour at 45 degrees, within 2% [D, 08]. A rover with spinning wheels and a flywheel, demoted and promoted: identical hash, angular momentum within 1e-12 [E] (VP14). Parked and warped a month: the pre-suspend hash, paused processes listed (VP19). Two rovers pass stage 9's rule; the phone's journal replays on the build server |
| 1m-a: host-authoritative, offers exchanged as QR codes, no server, no takeover (VF03, VF08) | Two Chromium pages with 5% injected loss first: zero mismatches in 10 minutes. Then two phones, 10 minutes at the shared budget: zero mismatches, ratio 1.000 on both; a build mismatch refused; a late joiner equal after 10,000 ticks (VP11); a guest that loses the host pauses and reports. The lock matrix (lock 3, 10, 60 s; app switch; notification pull-down; Low Power Mode; tab against Home Screen) records what each side sees (VF12) |
| 1m-b (go/no-go) | Three simulated peers, 1,000 random owner kills: never zero or two owners, ledger change 0 units (VP10); lease expiry from the lock matrix |

**The second phone is needed for** Safari-to-Safari data channels on real radios, fingerprint equality between two devices, the lock matrix, radio battery drain, real jitter for the input delay, and the slowest-phone budget rule. Lockstep logic, joins and fault injection run here without it.

## Interfaces

**Assumed from 01.** The fingerprint function and canonical serialisation, before the first commit; record and snapshot formats; closure tolerances; the closed input set; pair table and restitution law; budget lines.

**Assumed from 02.** The integrator and its checkpoint nodes; the DE440 body table; site and gravity-packet definitions (9.7803 and 1.6242 m/s^2); warp admission. One difference: 02 puts the Foucault test in 0b; it needs a joint, so it moves to Phase 1 and B5 stands in.

**Provided.** Pinned toolchain, canonical binary and build id; transcripts; the result line; the gates 01 and 02 name.

**Needed from later specs.** Mechanism: a solver interface with complete snapshot, its constants, weld sleep. Matter: a kernel manifest with a CPU twin per kernel. Multiplayer: handshake, join package, QR offer format, arbiter rules. API (P20): games are written in JavaScript or TypeScript against `host/`'s public module; controller rate and event stream.

## Changes to the plan

- The roadmap gains Phase 0; each "Goal" becomes numbered tests (VP06, VF02).
- Release 1 ends at 1m-a; later rows are unscheduled go/no-go items; Phase 6 splits into 6a and 6b.
- "1m ... with lease takeover" becomes 1m-a without takeover; takeover is 1m-b.
- 0s: any warp above 1x puts the region to sleep; Canvas drawing; no continuous zoom.
- "This session cannot create one" is untested, tried only on the user's approval; licence, Pages source, Cloudflare account and the second phone's iOS version join the decisions (VF19).
- "100-300 boxes" and "4 W" are replaced by stages 5 and 9.
- "Paste back the result" becomes one line per phase.
- No bindings tool; a hand-written host.

## Open items

- Whether Safari on the A16 reproduces T0-T4: this gates everything.
- Whether the Linux ARM64 runner is free, the macOS runner's Safari can be driven and exposes WebGPU, and builds stay reproducible once dependencies are added.
- Whether breadcrumbs survive a real iOS page kill; Home Screen storage separation.
- Whether the session's GitHub tools may create a repository and read issues and logs.
- Whether rapier3d-f64 passes T4; its phone throughput; every [E] threshold.
