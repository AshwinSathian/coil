// Canvas renderer. The sim moves in whole cells; this draws the frames in between.

import { H, W, DX, DY, type Game } from './sim.ts';

type Theme = 'dark' | 'light';
export type Look = 'retro' | 'modern';
interface Palette {
  board: string;
  alt: string;
  rim: string;
  rock: string;
  rockTop: string;
  head: [number, number, number]; // oklch
  tail: [number, number, number];
  band: string;
  fruit: string;
  fruitLeaf: string;
  gold: string;
  ghost: string;
  eye: string;
  pupil: string;
  text: string;
}

// Retro: warm charcoal (night) or celadon porcelain (day), a flat board with pixel dots,
// a snake built from square blocks. Saffron with madder blocks in both themes.
const PALETTES: Record<Theme, Palette> = {
  dark: {
    board: 'oklch(0.235 0.012 60)',
    alt: 'oklch(0.36 0.014 60)', // pixel dots
    rim: 'oklch(0.62 0.03 70)',
    rock: 'oklch(0.52 0.02 60)',
    rockTop: 'oklch(0.6 0.02 60)',
    head: [0.88, 0.15, 84],
    tail: [0.74, 0.17, 62],
    band: 'oklch(0.6 0.19 22)',
    fruit: 'oklch(0.85 0.11 170)',
    fruitLeaf: 'oklch(0.95 0.06 170)',
    gold: 'oklch(0.93 0.15 98)',
    ghost: 'oklch(0.9 0.02 70 / 0.26)',
    eye: 'oklch(0.98 0.01 90)',
    pupil: 'oklch(0.2 0.012 60)',
    text: 'oklch(0.97 0.01 80)',
  },
  light: {
    board: 'oklch(0.93 0.026 165)',
    alt: 'oklch(0.78 0.03 170)',
    rim: 'oklch(0.5 0.06 200)',
    rock: 'oklch(0.45 0.04 200)',
    rockTop: 'oklch(0.53 0.04 200)',
    head: [0.8, 0.16, 76],
    tail: [0.69, 0.16, 56],
    band: 'oklch(0.52 0.18 20)',
    fruit: 'oklch(0.52 0.11 180)',
    fruitLeaf: 'oklch(0.72 0.08 175)',
    gold: 'oklch(0.74 0.17 75)',
    ghost: 'oklch(0.3 0.04 200 / 0.24)',
    eye: 'oklch(0.99 0.005 90)',
    pupil: 'oklch(0.22 0.02 60)',
    text: 'oklch(0.24 0.02 60)',
  },
};

// Modern: flat board with a dot grid, one continuous glowing tube from warm white to madder.
const MODERN: Record<Theme, Palette> = {
  dark: {
    ...PALETTES.dark,
    board: 'oklch(0.185 0.018 270)',
    alt: 'oklch(0.33 0.02 270)', // dot grid
    rim: 'oklch(1 0 0 / 0.35)',
    rock: 'oklch(0.5 0.02 270)',
    rockTop: 'oklch(0.5 0.02 270)',
    head: [0.95, 0.07, 88],
    tail: [0.6, 0.21, 22],
    fruit: 'oklch(0.88 0.13 168)',
    gold: 'oklch(0.95 0.12 95)',
    ghost: 'oklch(1 0 0 / 0.16)',
    pupil: 'oklch(0.2 0.02 270)',
  },
  light: {
    ...PALETTES.light,
    board: 'oklch(0.995 0.002 270)',
    alt: 'oklch(0.86 0.006 270)',
    rim: 'oklch(0 0 0 / 0.3)',
    rock: 'oklch(0.62 0.01 270)',
    rockTop: 'oklch(0.62 0.01 270)',
    head: [0.8, 0.15, 72],
    tail: [0.55, 0.21, 20],
    fruit: 'oklch(0.66 0.14 168)',
    gold: 'oklch(0.8 0.16 80)',
    ghost: 'oklch(0 0 0 / 0.12)',
    pupil: 'oklch(0.2 0.02 270)',
  },
};

const RAMP = 48;
/** Colour index for segment k of n. Short snakes use only the head end of the ramp. */
const rampAt = (k: number, n: number) => Math.min(RAMP - 1, Math.round((k / Math.max(n - 1, 18)) * (RAMP - 1)));
const rampOf = (p: Palette, dead = false) =>
  Array.from({ length: RAMP }, (_, i) => {
    const t = i / (RAMP - 1);
    let [l, c, h] = p.head.map((v, k) => v + (p.tail[k] - v) * t);
    if (dead) {
      l *= 0.72;
      c *= 0.22;
    }
    return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)})`;
  });

interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size: number }
interface Popup { x: number; y: number; text: string; life: number }

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private cell = 0;
  private size = 0;
  private bg: HTMLCanvasElement = document.createElement('canvas');
  private theme: Theme = 'dark';
  private look: Look = 'retro';
  private pal = PALETTES.dark;
  private ramp = rampOf(PALETTES.dark);
  private deadRamp = rampOf(PALETTES.dark, true);
  private grads: (CanvasGradient | null)[] = [];
  private gradKey = -1;
  private gradGame: Game | null = null;
  private particles: Particle[] = [];
  private popups: Popup[] = [];
  private bulges: number[] = []; // ticks at which fruit was swallowed
  private shakeUntil = 0;
  private flashUntil = 0;
  private last = 0;
  private bgKey = '';
  private xs = new Float32Array(W * H + 2);
  private ys = new Float32Array(W * H + 2);
  reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  readonly canvas: HTMLCanvasElement;
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
  }

  setTheme(t: Theme, look: Look = this.look) {
    this.theme = t;
    this.look = look;
    this.pal = (look === 'modern' ? MODERN : PALETTES)[t];
    this.ramp = rampOf(this.pal);
    this.deadRamp = rampOf(this.pal, true);
    this.bgKey = '';
  }

  resize() {
    const css = this.canvas.getBoundingClientRect().width;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const px = Math.max(W, Math.round(css * dpr / W) * W);
    if (px === this.size) return;
    this.size = px;
    this.cell = px / W;
    this.canvas.width = this.canvas.height = px;
    this.bgKey = '';
  }

  private drawBackground(g: Game) {
    const key = `${this.size}|${this.theme}|${this.look}|${g.rowGate.join('')}|${g.colGate.join('')}|${g.rocks.join(',')}`;
    if (key === this.bgKey) return;
    this.bgKey = key;
    const b = this.bg;
    b.width = b.height = this.size;
    const x = b.getContext('2d')!;
    const c = this.cell;
    x.fillStyle = this.pal.board;
    x.fillRect(0, 0, this.size, this.size);
    if (this.look === 'modern') return this.modernBackground(x, g);
    x.fillStyle = this.pal.alt;
    const d = Math.max(1, Math.round(c * 0.07));
    for (let i = 1; i < W; i++) for (let j = 1; j < H; j++) if (!this.nearWall(g, i, j)) x.fillRect(Math.round(i * c - d / 2), Math.round(j * c - d / 2), d, d);
    this.drawEdges(x, g, Math.max(1.5, c * 0.09), [c * 0.5, c * 0.5]);
    this.bridgeRocks(x, g, c * 0.06);
    for (const r of g.rocks) {
      const rx = (r % W) * c;
      const ry = ((r / W) | 0) * c;
      const inset = c * 0.06;
      x.fillStyle = this.pal.rock;
      x.fillRect(rx + inset, ry + inset, c - inset * 2, c - inset * 2);
      x.fillStyle = this.pal.rockTop;
      x.fillRect(rx + inset, ry + inset, c - inset * 2, (c - inset * 2) * 0.72);
    }
  }

  /**
   * The rim says the rule, cell by cell: a solid neutral line is wall, a dashed stretch in the
   * fruit colour is a gate
   * (leave there and you come back in on the opposite edge). Gate ends get a short post.
   */
  private drawEdges(x: CanvasRenderingContext2D, g: Game, lw: number, dash: number[]) {
    const c = this.cell;
    const S = this.size;
    x.strokeStyle = this.pal.rim;
    x.lineWidth = lw;
    const rows = g.rowGate;
    const cols = g.colGate;
    const all = (a: Uint8Array, v: number) => a.every((k) => k === v);
    // Uniform boards keep the rounded rim.
    if ((all(rows, 0) && all(cols, 0)) || (all(rows, 1) && all(cols, 1))) {
      if (rows[0]) {
        x.setLineDash(dash);
        x.strokeStyle = this.pal.fruit;
      }
      x.beginPath();
      x.roundRect(lw / 2, lw / 2, S - lw, S - lw, this.cornerPx());
      x.stroke();
      x.setLineDash([]);
      return;
    }
    const h = lw / 2;
    // side: [gates, fixed coordinate, horizontal?]
    const sides: [Uint8Array, number, boolean][] = [[cols, h, true], [cols, S - h, true], [rows, h, false], [rows, S - h, false]];
    for (const [gates, fixed, horizontal] of sides) {
      for (let i = 0; i < gates.length; ) {
        let j = i;
        while (j < gates.length && gates[j] === gates[i]) j++;
        const a = i * c;
        const b = j * c;
        x.setLineDash(gates[i] ? dash : []);
        x.strokeStyle = gates[i] ? this.pal.fruit : this.pal.rim;
        x.beginPath();
        if (horizontal) {
          x.moveTo(a, fixed);
          x.lineTo(b, fixed);
        } else {
          x.moveTo(fixed, a);
          x.lineTo(fixed, b);
        }
        x.stroke();
        x.setLineDash([]);
        x.strokeStyle = this.pal.rim;
        // Posts where a gate meets a wall.
        if (gates[i]) {
          const post = c * 0.42;
          const dir = fixed < S / 2 ? 1 : -1;
          x.lineWidth = lw * 1.6;
          x.beginPath();
          for (const p of [a, b]) {
            if (p <= 0 || p >= S) continue;
            if (horizontal) {
              x.moveTo(p, fixed - h * dir);
              x.lineTo(p, fixed + post * dir);
            } else {
              x.moveTo(fixed - h * dir, p);
              x.lineTo(fixed + post * dir, p);
            }
          }
          x.stroke();
          x.lineWidth = lw;
        }
        i = j;
      }
    }
  }

  /** Grid point (i, j) touches a wall cell, so its dot would show through the wall's joints. */
  private nearWall(g: Game, i: number, j: number) {
    const o = g.occ;
    return o[(j - 1) * W + i - 1] === 2 || o[(j - 1) * W + i] === 2 || o[j * W + i - 1] === 2 || o[j * W + i] === 2;
  }

  /** Fills the gap between neighbouring wall cells so a run of them reads as one wall. */
  private bridgeRocks(x: CanvasRenderingContext2D, g: Game, inset: number) {
    const c = this.cell;
    x.fillStyle = this.pal.rock;
    for (const r of g.rocks) {
      const rx = (r % W) * c;
      const ry = ((r / W) | 0) * c;
      if (r % W < W - 1 && g.occ[r + 1] === 2) x.fillRect(rx + c / 2, ry + inset, c, c - inset * 2);
      if (r + W < W * H && g.occ[r + W] === 2) x.fillRect(rx + inset, ry + c / 2, c - inset * 2, c);
    }
  }

  /** The canvas's CSS border radius in canvas pixels, so the rim follows the rounded corner. */
  private cornerPx() {
    const css = this.canvas.getBoundingClientRect().width || 1;
    return (parseFloat(getComputedStyle(this.canvas).borderTopLeftRadius) || 0) * (this.size / css);
  }

  private modernBackground(x: CanvasRenderingContext2D, g: Game) {
    const c = this.cell;
    x.fillStyle = this.pal.alt;
    const r = Math.max(0.7, c * 0.04);
    for (let i = 1; i < W; i++) for (let j = 1; j < H; j++) {
      if (this.nearWall(g, i, j)) continue;
      x.beginPath();
      x.arc(i * c, j * c, r, 0, 7);
      x.fill();
    }
    this.drawEdges(x, g, Math.max(2, c * 0.06), [c * 0.3, c * 0.45]);
    x.fillStyle = this.pal.rock;
    this.bridgeRocks(x, g, c * 0.1);
    for (const k of g.rocks) {
      x.beginPath();
      x.roundRect((k % W) * c + c * 0.1, ((k / W) | 0) * c + c * 0.1, c * 0.8, c * 0.8, c * 0.28);
      x.fill();
    }
  }

  // --- events from the game loop ---
  onEat(g: Game, points: number) {
    this.bulges.push(g.tick);
    const h = g.head;
    const x = (h % W) + 0.5;
    const y = ((h / W) | 0) + 0.5;
    const color = g.ate === 2 ? this.pal.gold : this.pal.fruit;
    this.burst(x, y, color, g.ate === 2 ? 22 : 12);
    if (points) this.popups.push({ x, y, text: `+${points}`, life: 1 });
  }
  /** Head went through a gate: a ring where it left and where it came in. */
  onPort(g: Game, from: number) {
    const h = g.head;
    this.burst((h % W) + 0.5, ((h / W) | 0) + 0.5, this.pal.fruit, 8);
    if (from >= 0) this.burst((from % W) + 0.5, ((from / W) | 0) + 0.5, this.pal.fruit, 6);
  }
  onRoom() {
    this.reset();
    this.bgKey = '';
    if (!this.reducedMotion) this.flashUntil = performance.now() + 420;
  }
  onBite(g: Game) {
    const h = g.head;
    this.burst((h % W) + 0.5, ((h / W) | 0) + 0.5, this.ramp[RAMP - 1], 16);
  }
  onDeath(g: Game) {
    if (!this.reducedMotion) this.shakeUntil = performance.now() + 320;
    for (let i = g.len - 1; i >= 0; i -= 2) {
      const c = g.seg(i);
      this.burst((c % W) + 0.5, ((c / W) | 0) + 0.5, this.ramp[Math.round((1 - i / g.len) * (RAMP - 1))], 2);
    }
  }
  reset() {
    this.particles.length = 0;
    this.popups.length = 0;
    this.bulges.length = 0;
  }

  private burst(x: number, y: number, color: string, n: number) {
    if (this.reducedMotion) n = Math.min(n, 4);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 2 + Math.random() * 5;
      const max = 0.35 + Math.random() * 0.4;
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: max, max, color, size: 0.06 + Math.random() * 0.1 });
    }
  }

  // --- frame ---
  draw(g: Game, alpha: number, ghost: Game | null, now: number) {
    const dt = Math.min(0.05, (now - (this.last || now)) / 1000);
    this.last = now;
    const ctx = this.ctx;
    const c = this.cell;
    this.drawBackground(g);
    ctx.save();
    if (now < this.shakeUntil) {
      const k = ((this.shakeUntil - now) / 320) * c * 0.25;
      ctx.translate((Math.random() - 0.5) * k, (Math.random() - 0.5) * k);
    }
    ctx.drawImage(this.bg, 0, 0);
    ctx.scale(c, c); // from here on, units are cells

    this.drawFruit(g.food, now, false, 1);
    if (g.gold >= 0) this.drawFruit(g.gold, now, true, g.goldTtl / 45);
    if (ghost && ghost.len) this.drawSnake(ghost, ghost.alive ? alpha : 1, true);
    this.drawSnake(g, alpha, false);
    this.drawCrash(g);
    this.drawEffects(dt);
    ctx.restore();
    // New room: a quick wash of the fruit colour fading out.
    if (now < this.flashUntil) {
      ctx.globalAlpha = ((this.flashUntil - now) / 420) * 0.35;
      ctx.fillStyle = this.pal.fruit;
      ctx.fillRect(0, 0, this.size, this.size);
      ctx.globalAlpha = 1;
    }
  }

  private drawFruit(cell: number, now: number, gold: boolean, ttl: number) {
    if (cell < 0) return;
    const ctx = this.ctx;
    const x = (cell % W) + 0.5;
    const y = ((cell / W) | 0) + 0.5;
    const pulse = this.reducedMotion ? 1 : 1 + Math.sin(now / 180) * 0.06;
    if (this.look === 'modern') {
      const col = gold ? this.pal.gold : this.pal.fruit;
      const glow = ctx.createRadialGradient(x, y, 0, x, y, 0.9 * pulse);
      glow.addColorStop(0, col);
      glow.addColorStop(0.3, col);
      glow.addColorStop(1, 'transparent');
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = glow;
      ctx.fillRect(x - 1, y - 1, 2, 2);
      ctx.globalAlpha = 1;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(x, y, (gold ? 0.24 : 0.22) * pulse, 0, 7);
      ctx.fill();
      if (gold) {
        ctx.strokeStyle = col;
        ctx.lineWidth = 0.05;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(x, y, 0.42, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ttl);
        ctx.stroke();
      }
      return;
    }
    if (gold) {
      ctx.strokeStyle = this.pal.gold;
      ctx.lineWidth = 0.07;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(x, y, 0.46, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ttl);
      ctx.stroke();
      ctx.fillStyle = this.pal.gold;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const r = (i % 2 ? 0.14 : 0.32) * pulse;
        const a = (i / 8) * Math.PI * 2 - Math.PI / 2 + now / 1400;
        ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill();
      return;
    }
    // A cut gem: diamond body with a lighter upper facet.
    const r = 0.36 * pulse;
    ctx.fillStyle = this.pal.fruit;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = this.pal.fruitLeaf;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r * 0.5, y - r * 0.5);
    ctx.lineTo(x, y);
    ctx.lineTo(x - r * 0.5, y - r * 0.5);
    ctx.closePath();
    ctx.fill();
  }

  /** Builds the body as one continuous (unwrapped) polyline from head to tail, then strokes it. */
  private drawSnake(g: Game, alpha: number, ghost: boolean) {
    const ctx = this.ctx;
    const xs = this.xs;
    const ys = this.ys;
    let n = 0;
    let px = (g.head % W) + 0.5;
    let py = ((g.head / W) | 0) + 0.5;
    const neck = g.len > 1 ? g.seg(g.len - 2) : g.head;
    // Head eases from the neck cell into the head cell.
    const [ndx, ndy] = delta(neck, g.head);
    xs[n] = px - ndx * (1 - alpha);
    ys[n] = py - ndy * (1 - alpha);
    n++;
    let prev = g.head;
    for (let i = g.len - 2; i >= 0; i--) {
      const s = g.seg(i);
      const [dx, dy] = delta(s, prev);
      px -= dx;
      py -= dy;
      xs[n] = px;
      ys[n++] = py;
      prev = s;
    }
    if (g.vacated >= 0 && alpha < 1) {
      const [dx, dy] = delta(g.vacated, prev);
      xs[n] = px - dx * (1 - alpha);
      ys[n++] = py - dy * (1 - alpha);
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, xs[i]); maxX = Math.max(maxX, xs[i]);
      minY = Math.min(minY, ys[i]); maxY = Math.max(maxY, ys[i]);
    }
    // A wrapped snake hangs off one edge; draw it again shifted by a board width/height.
    for (const ox of [0, -W, W]) {
      if (minX + ox > W || maxX + ox < 0) continue;
      for (const oy of [0, -H, H]) {
        if (minY + oy > H || maxY + oy < 0) continue;
        ctx.save();
        ctx.translate(ox, oy);
        if (ghost) this.strokeGhost(n);
        else if (this.look === 'modern') this.strokeTube(g, n, alpha);
        else this.strokeBody(g, n, alpha);
        ctx.restore();
      }
    }
  }

  private strokeGhost(n: number) {
    const ctx = this.ctx;
    ctx.strokeStyle = this.pal.ghost;
    ctx.lineWidth = 0.5;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(this.xs[0], this.ys[0]);
    for (let i = 1; i < n; i++) ctx.lineTo(this.xs[i], this.ys[i]);
    ctx.stroke();
  }

  /** Modern body: one smooth tube. Corners are rounded with quadratic curves through cell centres. */
  private strokeTube(g: Game, n: number, alpha: number) {
    const ctx = this.ctx;
    const xs = this.xs;
    const ys = this.ys;
    const dead = !g.alive && !g.won;
    ctx.lineCap = ctx.lineJoin = 'round';
    const mx = (i: number) => (xs[i] + xs[i + 1]) / 2;
    const my = (i: number) => (ys[i] + ys[i + 1]) / 2;
    const piece = (k: number) => {
      ctx.beginPath();
      if (k === 0) ctx.moveTo(xs[0], ys[0]);
      else ctx.moveTo(mx(k - 1), my(k - 1));
      if (k === n - 1) ctx.lineTo(xs[k], ys[k]);
      else if (k === 0) ctx.lineTo(mx(0), my(0));
      else ctx.quadraticCurveTo(xs[k], ys[k], mx(k), my(k));
    };
    const ramp = dead ? this.deadRamp : this.ramp;
    const spine = () => {
      ctx.beginPath();
      ctx.moveTo(xs[0], ys[0]);
      for (let k = 1; k < n - 1; k++) ctx.quadraticCurveTo(xs[k], ys[k], mx(k), my(k));
      ctx.lineTo(xs[n - 1], ys[n - 1]);
    };
    // Glow: one blurred pass along the spine (blur is in device pixels, not cells).
    if (this.theme === 'dark' && !dead && n > 1) {
      ctx.save();
      ctx.shadowColor = ramp[6];
      ctx.shadowBlur = this.cell * 0.9;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = ramp[6];
      ctx.lineWidth = 0.5;
      spine();
      ctx.stroke();
      ctx.restore();
    }
    this.bulges = this.bulges.filter((t) => g.tick - t < n + 1);
    const taperFrom = Math.max(2, n - 7);
    for (let k = n - 1; k >= 0; k--) {
      let w = 0.66;
      if (k >= taperFrom) w *= 1 - ((k - taperFrom + 1) / (n - taperFrom + 1)) * 0.6;
      for (const t of this.bulges) {
        const d = k - (g.tick - t + alpha - 1);
        if (Math.abs(d) < 1.5) w += 0.16 * (1 - Math.abs(d) / 1.5);
      }
      ctx.strokeStyle = dead ? ramp[rampAt(k, n)] : this.pieceGradient(g, k, n, ramp);
      ctx.lineWidth = w;
      // Butt caps inside the body so neighbouring pieces meet without beads; round only at the ends.
      ctx.lineCap = k === 0 || k === n - 1 ? 'round' : 'butt';
      piece(k);
      ctx.stroke();
    }
    // Specular line along the top of the tube.
    if (!dead && n > 2) {
      ctx.save();
      ctx.translate(0, -0.08);
      ctx.strokeStyle = 'rgb(255 255 255 / 0.14)';
      ctx.lineWidth = 0.12;
      spine();
      ctx.stroke();
      ctx.restore();
    }
    // Head: a bright cap with two small eyes.
    ctx.fillStyle = ramp[0];
    ctx.beginPath();
    ctx.arc(xs[0], ys[0], 0.36, 0, 7);
    ctx.fill();
    const fdx = DX[g.dir];
    const fdy = DY[g.dir];
    ctx.fillStyle = this.pal.pupil;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(xs[0] + fdx * 0.12 - fdy * side * 0.15, ys[0] + fdy * 0.12 + fdx * side * 0.15, dead ? 0.03 : 0.055, 0, 7);
      ctx.fill();
    }
  }

  /**
   * A gradient along piece k so the colour flows instead of stepping cell by cell.
   * Interior pieces only move when the sim ticks, so they are cached per tick;
   * the two pieces at each end slide every frame and are rebuilt.
   */
  private pieceGradient(g: Game, k: number, n: number, ramp: string[]) {
    const key = g.tick * 1000 + n;
    if (this.gradKey !== key || this.gradGame !== g || this.grads.length < n) {
      this.gradKey = key;
      this.gradGame = g;
      this.grads = new Array(n).fill(null);
    }
    const moving = k <= 1 || k >= n - 2;
    const cached = this.grads[k];
    if (cached && !moving) return cached;
    const xs = this.xs;
    const ys = this.ys;
    const ax = k === 0 ? xs[0] : (xs[k - 1] + xs[k]) / 2;
    const ay = k === 0 ? ys[0] : (ys[k - 1] + ys[k]) / 2;
    const bx = k === n - 1 ? xs[k] : (xs[k] + xs[k + 1]) / 2;
    const by = k === n - 1 ? ys[k] : (ys[k] + ys[k + 1]) / 2;
    const gr = this.ctx.createLinearGradient(ax, ay, bx, by);
    gr.addColorStop(0, ramp[rampAt(Math.max(0, k - 0.5), n)]);
    gr.addColorStop(1, ramp[rampAt(k + 0.5, n)]);
    if (!moving) this.grads[k] = gr;
    return gr;
  }

  /** Retro body: square blocks with gaps, every third block madder. Head and tail blocks slide. */
  private strokeBody(g: Game, n: number, alpha: number) {
    const ctx = this.ctx;
    const xs = this.xs;
    const ys = this.ys;
    const dead = !g.alive && !g.won;
    const ramp = dead ? this.deadRamp : this.ramp;
    this.bulges = this.bulges.filter((t) => g.tick - t < n + 1);
    for (let i = n - 1; i >= 0; i--) {
      let size = i === 0 ? 0.9 : 0.8;
      if (i > n - 4) size *= 1 - (i - (n - 4)) * 0.12; // stubby tail
      for (const t of this.bulges) {
        const d = i - (g.tick - t + alpha - 1);
        if (Math.abs(d) < 1) size += 0.14 * (1 - Math.abs(d));
      }
      const band = i > 0 && (g.tick - i) % 3 === 0;
      ctx.fillStyle = band && !dead ? this.pal.band : ramp[rampAt(i, n)];
      const h = size / 2;
      ctx.fillRect(xs[i] - h, ys[i] - h, size, size);
    }
    // Two square pixel eyes, set toward the heading.
    const fdx = DX[g.dir];
    const fdy = DY[g.dir];
    ctx.fillStyle = this.pal.pupil;
    const e = 0.13;
    for (const side of [-1, 1]) {
      const ex = xs[0] + fdx * 0.16 - fdy * side * 0.2;
      const ey = ys[0] + fdy * 0.16 + fdx * side * 0.2;
      if (dead) {
        ctx.fillRect(ex - e / 2, ey - 0.02, e, 0.04);
      } else ctx.fillRect(ex - e / 2, ey - e / 2, e, e);
    }
  }

  /** Marks the cell the snake crashed into. */
  private drawCrash(g: Game) {
    if (g.alive || g.won || g.death === 'time') return;
    const n = g.next(g.head, g.dir);
    const ctx = this.ctx;
    let x: number;
    let y: number;
    if (n >= 0) {
      x = (n % W) + 0.5;
      y = ((n / W) | 0) + 0.5;
    } else {
      // Off the board: mark the edge just past the head.
      x = (g.head % W) + 0.5 + DX[g.dir] * 0.5;
      y = ((g.head / W) | 0) + 0.5 + DY[g.dir] * 0.5;
    }
    ctx.strokeStyle = this.pal.band;
    ctx.lineWidth = 0.09;
    ctx.beginPath();
    ctx.arc(x, y, 0.42, 0, 7);
    ctx.stroke();
  }

  private drawEffects(dt: number) {
    const ctx = this.ctx;
    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.9;
      p.vy *= 0.9;
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, 7);
      ctx.fill();
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    ctx.font = this.look === 'modern' ? '600 0.55px system-ui, -apple-system, sans-serif' : '800 0.6px Anybody, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = this.pal.text;
    for (const p of this.popups) {
      p.life -= dt * 1.3;
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 2));
      ctx.fillText(p.text, p.x, p.y - 0.6 - (1 - p.life) * 0.9);
    }
    this.popups = this.popups.filter((p) => p.life > 0);
    ctx.globalAlpha = 1;
  }
}

/** Step from cell a to its neighbour b, accounting for wrap-around. */
function delta(a: number, b: number): [number, number] {
  let dx = (b % W) - (a % W);
  let dy = ((b / W) | 0) - ((a / W) | 0);
  if (dx > 1) dx -= W;
  if (dx < -1) dx += W;
  if (dy > 1) dy -= H;
  if (dy < -1) dy += H;
  return [dx, dy];
}
