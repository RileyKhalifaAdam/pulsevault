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

## Delivery target: the owner's iPhone, in an embedded page (binding for all client code)

The owner plays on an iPhone and has no computer to hand. The game reaches them as ONE self-contained HTML page
shown inside the Claude app's page viewer (a locked-down iframe; also openable in Safari). Nobody can open a
console on that phone, and it cannot be tested on a real device before the owner sees it, so:

- **Embedded sizing.** The page is a guest: size to the container with `height: 100%` on html/body, never
  `100vh`/`100dvh`; re-layout on `resize` and `visualViewport` changes; the area can be smaller than the screen.
  Pin edge controls with `env(safe-area-inset-*, 0px)` added to their own padding/offsets; keep a side gutter of
  `max(16px, env(safe-area-inset-left/right, 0px))` for controls and text (the canvas itself is full-bleed).
- **Blocked in the viewer (never call, never depend on):** `alert`/`confirm`/`prompt` (`confirm()` returns false at
  once — every confirmation is an in-page sheet), service workers (guard registration and ignore failure),
  downloads, `window.open`, `window.print`, fullscreen and orientation lock, camera/mic/motion, and ALL network
  requests (no fetch of assets, no external fonts, scripts, images). Everything is inline or generated.
- **Storage.** `localStorage` can throw or come back empty: wrap every access in try/catch, keep the game fully
  playable without it, and keep the save under one key (`tidelock.save.v1`) plus settings (`tidelock.settings.v1`).
- **iOS Safari touch.** `touch-action: none` on the game surface; `preventDefault` on `touchmove`, `gesturestart`
  and double-tap so the page never rubber-bands, pinch-zooms or zooms on double tap; `-webkit-user-select: none`,
  `-webkit-touch-callout: none`, `-webkit-tap-highlight-color: transparent`; pointer events with
  `setPointerCapture`; real multi-touch (steer + throttle together); any text input has font-size >= 16px.
- **iOS WebGL.** Device pixel ratio capped at 2; half-float colour targets only where the extension exists (the
  pipeline detects it); survive context loss; frame-rate independent logic (Low Power Mode halves rAF to 30 fps);
  stay inside the memory budget — iOS kills tabs that exceed it.
- **Sound** only starts from a tap.
- **Visible failures.** Uncaught errors and unhandled rejections must show an in-page panel with the message and
  stack, a "Copy report" button (clipboard write inside the click handler, falling back to selectable text) and
  "Reload"; a failed WebGL2 context shows a plain explanation. The owner's bug reports depend on this.
- Both orientations must work by layout alone. No hover-only affordances.

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
