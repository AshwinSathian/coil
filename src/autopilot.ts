// Autopilot for the title screen and for fuzz tests.
// Shortest path to the fruit, taken only if the snake can still reach its tail afterwards;
// otherwise the move that keeps the most open space.

import { N, type Game } from './sim.ts';

const seen = new Int32Array(N);
const from = new Int16Array(N);
const queue = new Int16Array(N);
let stamp = 0;

/** BFS from `start`, returns the first direction of a path to `goal`, or -1. */
function firstStep(g: Game, start: number, goal: number, blocked: (c: number) => boolean) {
  stamp++;
  let qh = 0;
  let qt = 0;
  seen[start] = stamp;
  for (let d = 0; d < 4; d++) {
    const m = g.next(start, d);
    if (m < 0 || seen[m] === stamp || (blocked(m) && m !== goal)) continue;
    seen[m] = stamp;
    from[m] = d;
    if (m === goal) return d;
    queue[qt++] = m;
  }
  while (qh < qt) {
    const c = queue[qh++];
    for (let d = 0; d < 4; d++) {
      const m = g.next(c, d);
      if (m < 0 || seen[m] === stamp || (blocked(m) && m !== goal)) continue;
      seen[m] = stamp;
      from[m] = from[c];
      if (m === goal) return from[m];
      queue[qt++] = m;
    }
  }
  return -1;
}

function space(g: Game, start: number) {
  stamp++;
  let qh = 0;
  let qt = 0;
  queue[qt++] = start;
  seen[start] = stamp;
  while (qh < qt) {
    const c = queue[qh++];
    for (let d = 0; d < 4; d++) {
      const m = g.next(c, d);
      if (m >= 0 && seen[m] !== stamp && g.occ[m] === 0) {
        seen[m] = stamp;
        queue[qt++] = m;
      }
    }
  }
  return qt;
}

export function think(g: Game): number {
  const head = g.head;
  const target = g.gold >= 0 ? g.gold : g.food;
  const toFood = firstStep(g, head, target, (c) => !g.passable(c));
  if (toFood >= 0 && g.len > 6) {
    // Is the tail still reachable from the cell we would move into?
    const next = g.next(head, toFood);
    const reach = firstStep(g, next, g.tail, (c) => c !== g.tail && g.occ[c] !== 0);
    if (reach >= 0) return toFood;
  } else if (toFood >= 0) return toFood;

  let best = g.dir;
  let bestScore = -1;
  for (let d = 0; d < 4; d++) {
    if (d === (g.dir ^ 2)) continue;
    const m = g.next(head, d);
    if (!g.passable(m)) continue;
    const s = space(g, m) * 4 + (firstStep(g, m, g.tail, (c) => c !== g.tail && g.occ[c] !== 0) >= 0 ? 2 : 0) + (d === g.dir ? 1 : 0);
    if (s > bestScore) {
      bestScore = s;
      best = d;
    }
  }
  return best;
}
