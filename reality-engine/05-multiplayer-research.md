# Multiplayer for the reality engine: research return

V = VERIFIED (opened this session); U = UNVERIFIED (search excerpt or memory). Access: WebFetch resolved only raw.githubusercontent.com; curl also reached en.wikipedia.org, developer.apple.com and www.gdcvault.com. No files written to the project; no git or environment changes.

## 1. Findings

Netcode models
1. Deterministic lockstep sends only inputs (6 bits each in Fiedler's demo), so bandwidth ignores object count; it needs bit-exact results and stalls on a missing input. V [F1]
2. Factorio is lockstep: a cheap state CRC is compared every tick and a mismatched client re-downloads the map. Events of several hundred players are reported; count unconfirmed. U [S1]
3. Rollback (GGPO) predicts remote inputs and, on a miss, rewinds and single-steps to the present: a miss k ticks old costs k extra ticks in one frame. V [G]
4. Rocket League runs Bullet on dedicated servers and re-synchronises clients from stored physics states (V [W1]); its 120 Hz tick is U [S2]. Overwatch's talk abstract credits determinism (V [GD]).
5. Snapshots of 901 cubes at 60 Hz cost 17.4 Mbit/s raw and, quantised and delta-coded, about 57 bits per changed cube: 3.4 kbit/s per moving body (V [F2]; the sum is mine). State synchronisation fits prioritised bodies into 256 kbit/s but pops after loss bursts (V [F3]).
6. Distributed authority: Fiedler's four-player demo sends everything through the host as arbiter, for "cooperative experiences only" (V [F4]). Roblox hands parts to nearby clients and "cannot verify physics calculations" by them (V [R]).

Sandbox precedents
7. Teardown multiplayer shipped 12 March 2026 for up to 12 players; the team once called voxel-physics sync infeasible (V [W2]). Destruction runs in fixed-point integers as ordered deterministic commands; other bodies use server state sync (U [S3]).
8. DarkMultiPlayer's warp modes: MCW_FORCE, MCW_VOTE, MCW_LOWEST, SUBSPACE_SIMPLE, SUBSPACE (default), NONE (V [K1]). Luna keeps subspaces: clients move only to one "more advanced in time"; revert, quickload and pause are gone; vessel locks go to a player within 20 km; far-future players' updates queue until memory runs out; default cap 20 players (V [K2]).
9. Stormworks moved physics to the server so sessions stop slowing to the slowest client; vehicles with fluid systems desync most (U [S4]). Outer Wilds' QSB mod syncs ship velocity but not the player inside it (V [Q]).

Determinism
10. WebAssembly allows nondeterministic NaN bits, relaxed-SIMD results (fused multiply-add may round once or twice) and shared-memory threads (V [WA1][WA2]). Its deterministic profile fixes the first two (V [WA3]); Wasmtime can enforce that (V [WT]).
11. Rapier needs `enhanced-determinism` (no SIMD, no parallel) and nalgebra's maths functions; its wasm build claims equal snapshot hashes across browsers and processors (V [D]). Box2D v3 disables contraction, ships its own trig functions, orders by creation and tests determinism on every pull request (V [B]). Photon Quantum is Q48.16 fixed point, floats forbidden (U [S5]).

Matter that is not bit-exact
12. No precedent found for sharing a nondeterministic particle fluid. Nearest: Sea of Thieves computes waves per client from a shared clock, with the ship server-hosted (U [S6]); Noita Entangled Worlds syncs grid pixels (V [N]); findings 5 and 7.

Transport and hosting
13. WebTransport, with unreliable datagrams, shipped in Safari 26.4 (iOS 26.4, 24 March 2026) (V [A1][M1]). Unordered, no-retransmit data channels: Safari 11 onward (V [M2]). WebSocket is TCP without backpressure (V [M3]). Native: GameKit peer-to-peer caps at 16 players (V [A3]); Network.framework has QUIC datagrams (V [A4]).
14. iOS Safari reportedly suspends WebRTC and WebSocket on screen lock or backgrounding, and a socket may stay dead on return (U [S7]). A suspended native app runs no code and may lose its sockets (V [A2]).
15. WebRTC needs a server only for signalling (V [MB]). Cloudflare Durable Objects: free plan 100,000 requests and 13,000 GB-s a day; paid from $5 a month (V [C1]). STUN is free; TURN is $0.05/GB after 1,000 GB free (V [C2]).
16. Fly.io's smallest machine is about $2.19 a month plus $0.02/GB; Hetzner CAX11 about €5.99 after a June 2026 rise (U [S8]).

Replay verification and scale
17. Trackmania has validated replays by re-running stored inputs since 2003; Trackmania 2 checks only top-10 records, daily (V [T]). Limits: false logs that replay cleanly (U [S9]); look-ahead cheating, delaying your input to see others' first (V [W3]); legal but inhuman inputs.
18. Players: peer to peer 2-4, at most 16; one physics server 8-20 (Rocket League 8 U, Teardown 12, Luna 20); meshed, Star Citizen 500-600 over about 10 servers (file 04).

## 2. Design rules
1. Mechanism tier: sequenced lockstep. One sequencer per region (the host, later a server) stamps inputs with ticks; peers compare state hashes and resync from a snapshot on mismatch. Inputs cost bytes; state costs 3.4 kbit/s per moving body.
2. No whole-world rollback on phones: rewinding k ticks multiplies CPU by k against a 4 W budget. Use two to four ticks of input delay; predict only the local actuator, visually.
3. Matter tier: one owner per region simulates it and sends quantised coupling impulses every tick in the input stream, plus the coarse cell field (mass, momentum, energy) a few times a second. Others draw local particles steered to that field. Rigid bodies agree exactly; splashes differ per viewer.
4. Ledger, per region and tick: owner, lease number, input hash, mechanism state hash, coarse matter totals, each coupling impulse and transfer, time rate. Matter entries are "attested, not replayable"; conservation bounds what an owner can fake.
5. Time: one tick unit, one "now" per region. Inside a region, warp or slowdown is a sequenced input shared by all. Across regions, subspaces: sync forward only; a region ahead of you is a read-only recording until you jump to its now (cheap, because sleeping matter advances in closed form). Transfers wait in escrow until the receiver's clock reaches the send time. Amends file 04 rule 15.
6. Ownership: the region is the unit, held by lease (number plus expiry tick). First arrival owns; later arrivals join its lockstep group. Moves happen on tick boundaries: mechanism state needs no copy; matter is reseeded from the coarse field. Touching islands merge regions.
7. Hot phone: governor actions that change simulation are sequenced inputs. Order: cut rendering, hand off matter ownership, become a viewer that only receives state, last slow the region for everyone (amends file 04 rule 5).
8. Killed phone: routine. The lease lapses within seconds; a co-simulator takes over, or the region sleeps at its last journalled checkpoint. Rejoining needs a snapshot plus the input tail.
9. Trust: friends co-op first; hashes catch bugs, not cheats. Later: signed input logs, server input deadlines, sampled re-runs. Bots and hidden-information cheats remain: every lockstep peer holds full state.
10. Build: forbid relaxed SIMD, unordered threading or iteration, platform maths libraries and observable NaN bits. Run the server from the same wasm binary under Wasmtime unless CI shows native hashes match.

## 3. Ladder (player counts are my judgement)
1. Two to four players, peer to peer, star through a host over unreliable data channels. Cost $0-5 a month: static site, a free Durable Object for signalling, free STUN, TURN inside 1,000 GB. Demands: everything under "Now" in section 4, plus a viewer mode.
2. One headless server: 8-16 players per region, about 20 per server. Cost: one small VPS, roughly €5-10 a month, with a UDP port and certificate for WebTransport (iOS 26.4 or later), WebSocket as fallback. It sequences, journals, audits and owns orphaned regions. Having no GPU, it cannot run the matter tier, which stays client-owned.
3. Several servers splitting the region tree, statically first: hundreds of players, one VPS each plus a relay. Demands: file 04 rules 7-9, an authority-transfer service, per-server slowdown.

## 4. Decide now, or later
Now: the step is a pure function of state and tick inputs (no wall clock, no unseeded randomness); complete snapshot, restore and hash; every mutation is a tick-stamped command, including governor actions and matter coupling; region leases in the world record; integer ticks with a per-region now; a cross-architecture hash test in CI from the first commit.
Later: transport, input delay, island-scoped rollback, matchmaking, signed logs, meshing, native APIs.

## 5. Not established
- Blocked primary sources: Teardown's blog, Factorio's posts, Photon's docs, Hetzner, Fly.io, webkit.org; both GDC talks beyond abstracts.
- Apple's own account of Safari's background policy, including Home Screen web apps.
- Current VPS prices (excerpts conflict; Oracle's free ARM tier was reportedly halved); whether Cloudflare can terminate WebTransport.
- Space Engineers and Besiege netcode; any Universe Sandbox multiplayer.
- Any shipped precedent for rules 3-5: they are untested designs.
- Whether our hashes match natively and in wasm; rollback cost on an iPhone 15.

Sources (G = https://raw.githubusercontent.com)
[F1-F4] G/gafferongames/gafferongames/master/content/post/ deterministic_lockstep.md, snapshot_compression.md, state_synchronization.md, networked_physics_in_virtual_reality.md
[G] G/pond3r/ggpo/master/doc/README.md [R] G/Roblox/creator-docs/main/content/en-us/physics/network-ownership.md
[GD] https://www.gdcvault.com/play/1024001/-Overwatch-Gameplay-Architecture-and (Rocket League: /play/1024972/It-IS-Rocket-Science-The)
[W1] https://en.wikipedia.org/wiki/Rocket_League [W2] https://en.wikipedia.org/wiki/Teardown_(video_game) [W3] https://en.wikipedia.org/wiki/Cheating_in_online_games
[K1] G/godarklight/DarkMultiPlayer/master/Common/Common.cs, Server/Settings.cs [K2] G/wiki/LunaMultiplayer/LunaMultiplayer/ Limitations.md, Lock-system.md, Interpolation.md; G/LunaMultiplayer/LunaMultiplayer/master/LmpClient/Systems/Warp/WarpSystem.cs
[Q] G/qsb-dev/quantum-space-buddies/master/README.md [N] G/IntQuant/noita_entangled_worlds/master/README.md
[WA1] G/WebAssembly/design/main/Nondeterminism.md [WA2] G/WebAssembly/relaxed-simd/main/proposals/relaxed-simd/Overview.md [WA3] G/WebAssembly/spec/main/document/core/appendix/profiles.rst [WT] G/bytecodealliance/wasmtime/main/docs/examples-deterministic-wasm-execution.md
[D] G/dimforge/rapier.rs/master/docs/user_guides/templates/determinism.mdx [B] G/erincatto/box2d/main/docs/simulation.md
[A1] https://developer.apple.com/documentation/safari-release-notes/safari-26_4-release-notes [A2] https://developer.apple.com/library/archive/technotes/tn2277/_index.html [A3] https://developer.apple.com/documentation/gamekit/gkmatchrequest/maxplayersallowedformatch(of:) [A4] https://developer.apple.com/documentation/network
[M1] G/mdn/browser-compat-data/main/api/WebTransport.json [M2] G/mdn/browser-compat-data/main/api/RTCDataChannel.json [M3] G/mdn/content/main/files/en-us/web/api/websockets_api/index.md
[MB] G/johanhelsing/matchbox/main/README.md [C1] G/cloudflare/cloudflare-docs/production/src/content/partials/durable-objects/durable-objects-pricing.mdx [C2] G/cloudflare/cloudflare-docs/production/src/content/docs/realtime/turn/faq.mdx [T] G/BigBang1112/revalidate/main/README.md
Excerpt only: [S1] factorio.com/blog/post/fff-55, fff-188 [S2] hone.gg/blog/fix-lag-in-rocket-league/ [S3] blog.voxagon.se/2026/03/13/teardown-multiplayer.html [S4] Stormworks patch notes on steamdb.info (post not identified) [S5] doc.photonengine.com/quantum/current/manual/cheat-protection [S6] outscal.com/web-story/sea-of-thieves-storm-simulation [S7] developer.apple.com/forums/thread/774239 [S8] fly.io/pricing, docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/ [S9] haeberlen.cis.upenn.edu/papers/avm-tr.pdf
