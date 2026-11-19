// Deterministic snake simulation. Integer-only, seeded, no clock, no DOM.
// The browser and the Worker run this same file: same seed + same inputs = same game.

export const W = 21;
export const H = 21;
export const N = W * H;

// Order is part of the replay format (a mode is stored as its index). Append only.
export const MODES = ['classic', 'daily', 'blitz', 'zen', 'gates'] as const;
export type Mode = (typeof MODES)[number];

// 0 up, 1 right, 2 down, 3 left. Opposite direction = d ^ 2.
export const DX = [0, 1, 0, -1];
export const DY = [-1, 0, 1, 0];

const EMPTY = 0;
const SNAKE = 1;
const WALL = 2;

/**
 * How the board is laid out.
 * walls: every edge is solid. wrap: every edge is a gate.
 * daily: one generated room per day. rooms: a run of generated rooms (Gates mode).
 */
export type Layout = 'walls' | 'wrap' | 'daily' | 'rooms';

export interface Rules {
  layout: Layout;
  zen: boolean;
  timeLimitMs: number; // 0 = none
  goldChance: number; // out of 256, rolled after each fruit
  interval: (len: number, room: number) => number; // ms per tick
}

const classicPace = (l: number) => Math.max(68, 150 - (l - 3) * 2);

export const RULES: Record<Mode, Rules> = {
  classic: { layout: 'walls', zen: false, timeLimitMs: 0, goldChance: 40, interval: classicPace },
  daily: { layout: 'daily', zen: false, timeLimitMs: 0, goldChance: 40, interval: classicPace },
  blitz: { layout: 'wrap', zen: false, timeLimitMs: 60_000, goldChance: 90, interval: (l) => Math.max(58, 96 - (l - 3)) },
  zen: { layout: 'wrap', zen: true, timeLimitMs: 0, goldChance: 30, interval: () => 125 },
  gates: { layout: 'rooms', zen: false, timeLimitMs: 0, goldChance: 40, interval: (l, r) => Math.max(70, 142 - (r - 1) * 7 - (l - 3) * 2) },
};

/** Rules revision. 1: Daily had solid edges and rocks only. 2: gates and generated rooms. */
export const REV = 2;
export const DAILY_LEVEL = 3;
/** Fruit needed to clear room r in Gates mode. */
export const roomTarget = (r: number) => Math.min(12, 5 + r);
export const roomBonus = (r: number) => 100 * r;

export const GOLD_TTL = 45; // ticks
export const COMBO_WINDOW_MS = 3500;
export const MAX_COMBO = 4; // multiplier = combo + 1

export type Death = 'wall' | 'self' | 'rock' | 'time' | null;
export type Sides = { rows: Uint8Array; cols: Uint8Array };

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
  /** Gates: rowGate[y] lets row y pass through the left and right edges; colGate[x] the top and bottom. */
  readonly rowGate = new Uint8Array(H);
  readonly colGate = new Uint8Array(W);
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
  ported = false; // head went through a gate
  newRoom = false; // a room was cleared and the next one built

  room = 0; // Gates mode: current room, from 1
  roomFruit = 0;

  readonly mode: Mode;
  readonly seed: number;
  readonly rev: number;

  constructor(mode: Mode, seed: number, rev = REV) {
    this.mode = mode;
    this.seed = seed;
    this.rev = rev;
    this.rules = RULES[mode];
    this.rand = rng(seed);
    const layout = this.rules.layout;
    if (layout === 'wrap') {
      this.rowGate.fill(1);
      this.colGate.fill(1);
    }
    this.spawn();
    if (layout === 'daily') {
      if (rev === 1) this.placeRocks();
      else this.buildRoom(DAILY_LEVEL);
    } else if (layout === 'rooms') {
      this.room = 1;
      this.buildRoom(1);
    }
    this.food = this.freeCell();
  }

  private spawn() {
    const y = H >> 1;
    this.dir = 1;
    for (let x = 7; x <= 9; x++) this.pushHead(y * W + x);
  }

  get roomTarget() { return roomTarget(this.room); }

  get head() { return this.body[(this.tailIdx + this.len - 1) % N]; }
  get tail() { return this.body[this.tailIdx]; }
  /** i = 0 is the tail, len - 1 is the head */
  seg(i: number) { return this.body[(this.tailIdx + i) % N]; }
  get interval() { return this.rules.interval(this.len, this.room); }
  get timeLeft() { return this.rules.timeLimitMs ? Math.max(0, this.rules.timeLimitMs - this.elapsed) : Infinity; }

  /** Neighbour of `c` in direction `d`: through a gate if the edge has one there, -1 into a wall. */
  next(c: number, d: number) {
    let x = (c % W) + DX[d];
    let y = ((c / W) | 0) + DY[d];
    if (x < 0 || x >= W) {
      if (!this.rowGate[y]) return -1;
      x = (x + W) % W;
    } else if (y < 0 || y >= H) {
      if (!this.colGate[x]) return -1;
      y = (y + H) % H;
    }
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
    this.ported = false;
    this.newRoom = false;
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
    const h = this.head;
    this.ported = Math.abs((n % W) - (h % W)) > 1 || Math.abs(((n / W) | 0) - ((h / W) | 0)) > 1;
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
    if (this.room && ++this.roomFruit >= this.roomTarget) return this.nextRoom();
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

  /** Gates mode: bank the room bonus, then rebuild the board around a fresh snake. */
  private nextRoom() {
    this.score += roomBonus(this.room);
    this.room++;
    this.roomFruit = 0;
    this.occ.fill(EMPTY);
    this.rocks.length = 0;
    this.tailIdx = 0;
    this.len = 0;
    this.grow = 0;
    this.combo = 0;
    this.gold = -1;
    this.vacated = -1;
    this.newRoom = true;
    this.spawn();
    this.buildRoom(this.room);
    this.food = this.freeCell();
  }

  /**
   * A generated room. Edges are cut into mirrored runs, each a wall or a gate; the higher
   * the level, the fewer gates and the more and longer the inner walls.
   */
  private buildRoom(level: number) {
    const open = Math.max(30, 82 - level * 9); // chance a run is a gate, out of 100
    this.edgeRuns(this.rowGate, open);
    this.edgeRuns(this.colGate, open);
    const pieces = Math.min(9, 2 + level + this.rand(2));
    this.placeWalls(pieces, 2 + Math.min(level, 5));
  }

  private edgeRuns(gate: Uint8Array, open: number) {
    const n = gate.length;
    const mid = n >> 1;
    let any = false;
    for (let i = 0; i <= mid; ) {
      const run = 2 + this.rand(3);
      const isGate = this.rand(100) < open ? 1 : 0;
      any ||= isGate === 1;
      for (let k = i; k < i + run && k <= mid; k++) gate[k] = gate[n - 1 - k] = isGate;
      i += run;
    }
    if (!any) gate[mid] = gate[mid - 1] = gate[mid + 1] = 1; // every edge pair gets at least one way through
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

  // Rev-1 Daily rocks. Kept exactly as shipped so old Daily replays still play back.
  private placeRocks() {
    this.placeWalls(4 + this.rand(3), 4);
  }

  // Mirrored straight walls, four-way symmetric. Keeps the centre open and the board connected.
  private placeWalls(pieces: number, maxLen: number) {
    const cx = W >> 1;
    const cy = H >> 1;
    for (let p = 0; p < pieces; p++) {
      const len = 2 + this.rand(maxLen - 1);
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
