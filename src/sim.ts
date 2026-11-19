// Deterministic snake simulation. Integer-only, seeded, no clock, no DOM.
// The browser and the Worker run this same file: same seed + same inputs = same game.

export const W = 21;
export const H = 21;
export const N = W * H;

export const MODES = ['classic', 'daily', 'blitz', 'zen'] as const;
export type Mode = (typeof MODES)[number];

// 0 up, 1 right, 2 down, 3 left. Opposite direction = d ^ 2.
export const DX = [0, 1, 0, -1];
export const DY = [-1, 0, 1, 0];

const EMPTY = 0;
const SNAKE = 1;
const WALL = 2;

export interface Rules {
  wrap: boolean;
  zen: boolean;
  obstacles: boolean;
  timeLimitMs: number; // 0 = none
  goldChance: number; // out of 256, rolled after each fruit
  interval: (len: number) => number; // ms per tick
}

export const RULES: Record<Mode, Rules> = {
  classic: { wrap: false, zen: false, obstacles: false, timeLimitMs: 0, goldChance: 40, interval: (l) => Math.max(68, 150 - (l - 3) * 2) },
  daily: { wrap: false, zen: false, obstacles: true, timeLimitMs: 0, goldChance: 40, interval: (l) => Math.max(68, 150 - (l - 3) * 2) },
  blitz: { wrap: true, zen: false, obstacles: false, timeLimitMs: 60_000, goldChance: 90, interval: (l) => Math.max(58, 96 - (l - 3)) },
  zen: { wrap: true, zen: true, obstacles: false, timeLimitMs: 0, goldChance: 30, interval: () => 125 },
};

export const GOLD_TTL = 45; // ticks
export const COMBO_WINDOW_MS = 3500;
export const MAX_COMBO = 4; // multiplier = combo + 1

export type Death = 'wall' | 'self' | 'rock' | 'time' | null;

export function rng(seed: number) {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export const dailySeed = (day: string) => hashString('coil:' + day);
export const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

export class Game {
  readonly rules: Rules;
  readonly body = new Int16Array(N); // ring buffer, tail at `tailIdx`, head at tailIdx + len - 1
  readonly occ = new Uint8Array(N);
  readonly rocks: number[] = [];
  readonly log: number[] = []; // flat [tick, dir, tick, dir, ...] of direction changes
  private rand: (n: number) => number;
  private tailIdx = 0;
  len = 0;
  dir = 1;
  tick = 0;
  elapsed = 0; // simulated ms
  grow = 0;
  food = -1;
  gold = -1;
  goldTtl = 0;
  score = 0;
  combo = 0;
  fruit = 0;
  lastEatMs = -1e9;
  alive = true;
  won = false;
  death: Death = null;
  // Events from the last step, for rendering and sound.
  vacated = -1;
  ate = 0; // 0 none, 1 fruit, 2 gold
  cut = 0;

  readonly mode: Mode;
  readonly seed: number;

  constructor(mode: Mode, seed: number) {
    this.mode = mode;
    this.seed = seed;
    this.rules = RULES[mode];
    this.rand = rng(seed);
    const y = H >> 1;
    for (let x = 7; x <= 9; x++) this.pushHead(y * W + x);
    if (this.rules.obstacles) this.placeRocks();
    this.food = this.freeCell();
  }

  get head() { return this.body[(this.tailIdx + this.len - 1) % N]; }
  get tail() { return this.body[this.tailIdx]; }
  /** i = 0 is the tail, len - 1 is the head */
  seg(i: number) { return this.body[(this.tailIdx + i) % N]; }
  get interval() { return this.rules.interval(this.len); }
  get timeLeft() { return this.rules.timeLimitMs ? Math.max(0, this.rules.timeLimitMs - this.elapsed) : Infinity; }

  /** Neighbour of `c` in direction `d`, or -1 off the board. */
  next(c: number, d: number) {
    let x = (c % W) + DX[d];
    let y = ((c / W) | 0) + DY[d];
    if (this.rules.wrap) {
      x = (x + W) % W;
      y = (y + H) % H;
    } else if (x < 0 || y < 0 || x >= W || y >= H) return -1;
    return y * W + x;
  }

  /** Cell is safe to enter on the next tick (the tail moves out unless growing). */
  passable(c: number) {
    if (c < 0) return false;
    const o = this.occ[c];
    if (o === EMPTY) return true;
    if (o === WALL) return false;
    return c === this.tail && this.grow === 0 && c !== this.food && c !== this.gold;
  }

  step(input = -1) {
    this.vacated = -1;
    this.ate = 0;
    this.cut = 0;
    if (!this.alive) return;
    if (input >= 0 && input !== this.dir && input !== (this.dir ^ 2)) {
      this.dir = input;
      this.log.push(this.tick, input);
    }
    const dt = this.interval;
    const n = this.next(this.head, this.dir);
    const eats = n >= 0 && (n === this.food || n === this.gold);
    const tailMoves = this.grow === 0 && !eats;

    if (n < 0) return this.die('wall');
    if (this.occ[n] === WALL) return this.die('rock');
    if (this.occ[n] === SNAKE && !(tailMoves && n === this.tail)) {
      if (!this.rules.zen) return this.die('self');
      // Zen: bite off everything from the tail up to the bitten segment.
      let k = 0;
      while (this.seg(k) !== n) k++;
      for (let i = 0; i <= k; i++) this.occ[this.seg(i)] = EMPTY;
      this.tailIdx = (this.tailIdx + k + 1) % N;
      this.len -= k + 1;
      this.cut = k + 1;
    }

    if (eats) this.grow++;
    if (this.grow > 0) this.grow--;
    else if (!this.cut) {
      this.vacated = this.tail;
      this.occ[this.tail] = EMPTY;
      this.tailIdx = (this.tailIdx + 1) % N;
      this.len--;
    }
    this.pushHead(n);

    if (this.gold >= 0 && --this.goldTtl <= 0 && n !== this.gold) this.gold = -1;
    if (n === this.food || n === this.gold) this.eat(n === this.gold);

    this.tick++;
    this.elapsed += dt;
    if (this.rules.timeLimitMs && this.elapsed >= this.rules.timeLimitMs) this.die('time');
  }

  private eat(golden: boolean) {
    const zen = this.rules.zen;
    this.combo = !zen && this.elapsed - this.lastEatMs <= COMBO_WINDOW_MS ? Math.min(this.combo + 1, MAX_COMBO) : 0;
    this.lastEatMs = this.elapsed;
    this.score += (golden ? 50 : 10) * (this.combo + 1);
    this.ate = golden ? 2 : 1;
    if (golden) {
      this.gold = -1;
      return;
    }
    this.fruit++;
    this.food = this.freeCell();
    if (this.food < 0) {
      this.won = true;
      this.alive = false;
      return;
    }
    if (this.gold < 0 && this.rand(256) < this.rules.goldChance) {
      this.gold = this.freeCell();
      this.goldTtl = GOLD_TTL;
    }
  }

  private die(why: Death) {
    this.alive = false;
    this.death = why;
    if (why !== 'time') this.tick++; // the fatal move counts as a tick, so replays reach it
  }

  private pushHead(c: number) {
    this.body[(this.tailIdx + this.len) % N] = c;
    this.occ[c] = SNAKE;
    this.len++;
  }

  private freeCell() {
    let free = 0;
    for (let c = 0; c < N; c++) if (this.occ[c] === EMPTY && c !== this.food && c !== this.gold) free++;
    if (!free) return -1;
    let k = this.rand(free);
    for (let c = 0; c < N; c++) if (this.occ[c] === EMPTY && c !== this.food && c !== this.gold && k-- === 0) return c;
    return -1;
  }

  // Mirrored short walls, four-way symmetric. Keeps the centre cross open and the board connected.
  private placeRocks() {
    const cx = W >> 1;
    const cy = H >> 1;
    const pieces = 4 + this.rand(3);
    for (let p = 0; p < pieces; p++) {
      const len = 2 + this.rand(3);
      const vertical = this.rand(2) === 1;
      const x0 = 1 + this.rand(cx - 1);
      const y0 = 1 + this.rand(cy - 1);
      const cells: number[] = [];
      for (let i = 0; i < len; i++) {
        const x = vertical ? x0 : x0 + i;
        const y = vertical ? y0 + i : y0;
        if (x >= cx || y >= cy) break;
        for (const [mx, my] of [[x, y], [W - 1 - x, y], [x, H - 1 - y], [W - 1 - x, H - 1 - y]]) {
          if (Math.abs(mx - cx) <= 2 && Math.abs(my - cy) <= 2) continue;
          const c = my * W + mx;
          if (this.occ[c] === EMPTY && !cells.includes(c)) cells.push(c);
        }
      }
      for (const c of cells) this.occ[c] = WALL;
      if (this.connected()) this.rocks.push(...cells);
      else for (const c of cells) this.occ[c] = EMPTY;
    }
  }

  private connected() {
    const seen = new Uint8Array(N);
    const stack = [this.head];
    seen[this.head] = 1;
    let reached = 0;
    let open = 0;
    for (let c = 0; c < N; c++) if (this.occ[c] !== WALL) open++;
    while (stack.length) {
      const c = stack.pop()!;
      reached++;
      for (let d = 0; d < 4; d++) {
        const m = this.next(c, d);
        if (m >= 0 && !seen[m] && this.occ[m] !== WALL) {
          seen[m] = 1;
          stack.push(m);
        }
      }
    }
    return reached === open;
  }
}
