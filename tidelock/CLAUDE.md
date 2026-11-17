# TIDELOCK — working notes for Claude

TIDELOCK is an original space game for iPhone 15 (Safari / PWA, WebGL2, three.js 0.180.0, TypeScript, esbuild).
Read `docs/ARCHITECTURE.md` before changing anything: it holds the binding conventions (SI units, axes,
frames, ship-local axes), the rendering contract, the performance budget and the art direction.
`src/core/types.ts` is the shared type contract.

## Commands

- `npm run build` — bundle to `dist/` · `npm run build:single` — also one self-contained `dist/tidelock.html`
- `npm run typecheck` — strict TypeScript over `src`, `dev`, `tests`
- `npm test` — vitest; one file: `npx vitest run tests/<name>.test.ts`
- `node build.mjs --harness <name>` then `node tools/shot.cjs dev/<name>.html shots/<name>.png` — render a
  visual harness headlessly and screenshot it (look at the PNG with the Read tool)
- `node tools/shot.cjs index.html shots/game.png --device iphone15` — screenshot the game itself

## Rules

- No external assets, fonts, CDNs or new npm dependencies: everything is procedural or inline.
- The simulation (`src/sim`, `src/data`, `src/core`) must not import three.js or touch the DOM, and must not
  call `Math.random()` / `Date.now()` — use `core/rng.ts`. It has to run under vitest in plain node.
- SI units and the axis conventions in the architecture doc are not negotiable; convert only when formatting
  for display (`core/units.ts`).
- Mobile first: portrait and landscape, safe-area insets, touch targets ≥ 44 pt, no hover-only behaviour.
- Performance budget is for an iPhone 15: no per-frame allocations in hot paths, instancing for repeats,
  bake expensive procedural textures once.
- Original IP only: never borrow names, ships, factions, logos or UI layouts from existing games.
- When several agents work at once: edit only the files you own, do not run git commands that change the
  repository (no commit, checkout, stash, reset), and do not edit `src/core/types.ts` unless told to — report
  the change you need instead. Screenshots and scratch output go in `shots/`.
- Report honestly: say what you ran and saw, and what you did not verify.
