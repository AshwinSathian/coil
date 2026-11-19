# Coil

[![CI](https://github.com/AshwinSathian/coil/actions/workflows/ci.yml/badge.svg)](https://github.com/AshwinSathian/coil/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Play](https://img.shields.io/badge/play-coil.ashwinsathian.com-orange.svg)](https://coil.ashwinsathian.com)

Snake for phone, tablet and desktop browsers. Live at **https://coil.ashwinsathian.com**.

<p align="center">
  <img src="docs/desktop.png" alt="Coil on a desktop: the board on the left, the mode list on the right" width="70%">
  <img src="docs/phone.png" alt="Coil on a phone" width="22%">
</p>

- Five modes: Classic (solid walls), Gates (a run of generated rooms), Daily (one generated room per UTC day, with a leaderboard), Blitz (60 seconds, every edge wraps) and Zen (no game over; biting yourself cuts off your tail).
- Edges are set cell by cell. A solid stretch is a wall. A dashed stretch in the fruit colour is a gate: leave through it and you come back in on the opposite edge, same row or column. Gates and Daily mix both kinds and add walls inside the board.
- Two looks, switchable from the menu: Retro (block snake, Anybody wide type) and Modern (system type, a glowing tube, a board that warms as your multiplier climbs). Each has a light and a dark theme.
- Swipe, arrow keys/WASD/HJKL, or a gamepad. Up to three turns can be queued.
- Every game can be replayed and shared as a link.
- Installable, and playable offline after the first visit. A new version reloads in place only when you're on the menu, so it never interrupts a run.

## How it works

`src/sim.ts` is the whole game: an integer-only simulation with a seeded PRNG and no clock. The same seed and the same inputs always produce the same game. Several features rest on that:

1. **Replays as links.** A game is stored as its seed plus the ticks where the direction changed, varint-packed and base64url-encoded (`src/replay.ts`). A 55-segment Classic run is about 190 characters and fits in a URL fragment.
2. **Ghost runs.** In Daily, your best run of the day plays beside you as a faint snake.
3. **A leaderboard the client can't lie to.** The client sends inputs, never a score. The Worker (`worker/index.ts`) imports the same `sim.ts`, replays the run and stores the score it computes. A replay proves the run is legal. It does not prove a person played it live.
4. **Rooms.** Gates mode and Daily share one generator. It cuts each edge into mirrored runs of wall or gate and places mirrored inner walls, then keeps a wall only if a flood fill (which follows gates) still reaches every open cell. Each Gates room has fewer gates and more walls than the last.
5. **Old links keep working.** A replay's first byte is the rules revision it was played under. Daily rooms gained gates in revision 2. A revision-1 Daily link still rebuilds the old board, and the tests pin one replay per mode from before the change to its exact score.
6. **Title-screen demo.** An autopilot (`src/autopilot.ts`: shortest path to the fruit, taken only if the tail is still reachable afterwards) plays behind the menu. The tests also use it for fuzzing.

The renderer (`src/render.ts`) draws the frames between sim ticks. The head and tail slide, and the body is cell centres joined into one path. A snake that wraps around the board edge is drawn again, shifted by one board width.

Sound is synthesised with Web Audio, so the game ships no audio files. The build inlines all HTML, CSS and JS into one `index.html`, about 25 KB gzipped. The only other request is a 28 KB subset of the Anybody variable font.

## Run it

```sh
npm install
npm test                                   # sim, replay codec, autopilot fuzz
npx wrangler d1 migrations apply coil-db --local
npm run preview                            # build + wrangler dev with a local D1
```

`npm run dev` runs Vite alone, without the leaderboard API.

## Deploy

```sh
npx wrangler d1 migrations apply coil-db --remote
npm run deploy
```

Cloudflare Workers serves the static files from the edge. Only `/api/*` runs Worker code, backed by D1 and a rate-limit binding (20 submissions per IP per minute).

## Credits

Type: [Anybody](https://github.com/Etcetera-Type-Co/Anybody), SIL Open Font License (`public/fonts/OFL.txt`).

## License

Code: [MIT](LICENSE). Font: SIL Open Font License.
