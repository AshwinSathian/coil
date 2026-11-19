# Coil: plan

A snake game for phone, tablet and desktop browsers. Built for its owner to play and as a portfolio piece.

## Goals

- First paint in one request. The whole app (HTML, CSS, JS) is inlined into a single `index.html` under 30 KB gzipped. No fonts, images or audio files.
- Playable offline after the first visit (service worker, installable PWA).
- Smooth on an average phone: fixed-step simulation, interpolated rendering at the display refresh rate.
- Feels native on each input: swipe on touch, arrows/WASD on keyboard, D-pad/stick on gamepad.

## The engineering idea: one deterministic simulation, used four ways

`src/sim.ts` is a pure, integer-only simulation driven by a seeded PRNG and a list of `(tick, direction)` inputs. Same seed and same inputs always produce the same game. That one property gives:

1. **Replays as links.** A finished game encodes to a few hundred bytes (varint + base64url) and fits in a URL fragment. Anyone can open it and watch the run.
2. **Ghost runs.** In Daily mode, your best run of the day plays alongside you as a translucent snake.
3. **Server-verified leaderboard.** The Worker imports the same `sim.ts`, replays the submitted inputs and computes the score itself. The client never sends a score.
4. **Attract mode.** The title screen runs the sim with an autopilot (BFS to food, with a check that it can still reach its tail).

Known ceiling: a verified replay proves the game is legal, not that a human played it in real time. Someone could compute a run offline. Fine for a personal leaderboard.

## Modes

| Mode | Walls | Rules |
|---|---|---|
| Classic | solid | Speed ramps with length. Combo multiplier for eating fast. Golden fruit appears sometimes and expires. |
| Daily | solid | Classic rules plus a seeded obstacle layout. Same seed worldwide per UTC day. Global leaderboard, ghost of your best. |
| Blitz | wrap | 60 seconds, fast, golden fruit more often. Score attack. |
| Zen | wrap | No death. Biting yourself cuts off the tail. Constant calm speed. |
| Gates | mixed | Generated rooms: edges are runs of wall or gate, plus inner walls. Clear a room's fruit target for a bonus and a harder room. Added 2026-11-20. |

Daily became a generated room too (rules revision 2). The replay format's first byte records the revision, so revision-1 links still play their original board.

## Looks

Retro is the default: a snake of square blocks, Anybody wide type, warm charcoal or celadon ground. Modern is one tap away on the menu: system type, a glowing gradient tube, a board whose glow warms with the multiplier. Both have light and dark themes. Three design reviews (loupe, impeccable, design-taste-frontend) shaped both looks. One of them caught that the first Retro draft (checkerboard, orange snake with eyes) read like an existing snake game, so it was redrawn.

## Stack

- Vite + TypeScript, no UI framework. Canvas 2D for the board, DOM for menus and HUD.
- `vite-plugin-singlefile` inlines the build.
- Cloudflare Worker with static assets. `/api/*` runs the Worker; everything else is served from the edge. D1 stores daily scores and their replays.
- Web Audio synthesises every sound. `navigator.vibrate` for haptics where supported. Screen Wake Lock during play.
- Tests: `node --test` (Node 24 strips TS types natively). Sim determinism, replay round-trip, an autopilot fuzz that checks sim invariants over many games, and server verification.

## Milestones (vertical slices)

1. Sim + replay codec + tests.
2. Renderer + input + game loop: Classic playable.
3. Menus, modes, game over, persistence, audio, haptics.
4. Replays (share, watch), Daily ghost, attract mode.
5. Worker + D1 leaderboard with verification.
6. PWA, icons, OG image, meta.
7. Visual and functional verification (Playwright on phone, tablet, desktop sizes), loupe review, fixes.
8. Push to GitHub, deploy to `coil.ashwinsathian.com`.
