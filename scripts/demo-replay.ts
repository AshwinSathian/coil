// Prints a replay link of an autopilot game, handy for screenshots: node scripts/demo-replay.ts [mode] [ticks]
import { Game, type Mode } from '../src/sim.ts';
import { think } from '../src/autopilot.ts';
import { encode, toReplay } from '../src/replay.ts';

const mode = (process.argv[2] ?? 'classic') as Mode;
const g = new Game(mode, 20261120);
const max = Number(process.argv[3] ?? 1e9);
while (g.alive && g.tick < max) g.step(think(g));
console.log(encode(toReplay(g)), g.score, g.len, g.tick);
