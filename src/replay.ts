// Replay codec: a whole game in a few hundred bytes, safe for a URL fragment.
// Layout: version, mode, seed, endTick, eventCount, then per event varint(tickDelta * 4 + dir). Base64url.

import { Game, MODES, type Mode } from './sim.ts';

const VERSION = 1;
export const MAX_TICKS = 200_000;

export interface Replay {
  mode: Mode;
  seed: number;
  endTick: number;
  log: number[]; // flat [tick, dir, ...]
}

function putVarint(out: number[], v: number) {
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

export function encode(r: Replay): string {
  const out: number[] = [VERSION, MODES.indexOf(r.mode)];
  putVarint(out, r.seed >>> 0);
  putVarint(out, r.endTick);
  putVarint(out, r.log.length / 2);
  let prev = 0;
  for (let i = 0; i < r.log.length; i += 2) {
    putVarint(out, (r.log[i] - prev) * 4 + r.log[i + 1]);
    prev = r.log[i];
  }
  let bin = '';
  for (const b of out) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Throws on anything malformed. */
export function decode(s: string): Replay {
  if (!/^[A-Za-z0-9_-]{4,20000}$/.test(s)) throw new Error('bad replay');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  let p = 0;
  const byte = () => {
    if (p >= bin.length) throw new Error('truncated replay');
    return bin.charCodeAt(p++);
  };
  const varint = () => {
    let v = 0;
    let mul = 1;
    for (let i = 0; i < 5; i++) {
      const b = byte();
      v += (b & 0x7f) * mul;
      if (b < 0x80) return v;
      mul *= 128;
    }
    throw new Error('bad varint');
  };
  if (byte() !== VERSION) throw new Error('unknown replay version');
  const mode = MODES[byte()];
  if (!mode) throw new Error('unknown mode');
  const seed = varint() >>> 0;
  const endTick = varint();
  const count = varint();
  if (endTick > MAX_TICKS || count > endTick + 1) throw new Error('replay too long');
  const log: number[] = [];
  let tick = 0;
  for (let i = 0; i < count; i++) {
    const v = varint();
    tick += Math.floor(v / 4);
    log.push(tick, v % 4);
  }
  if (p !== bin.length) throw new Error('trailing bytes');
  if (tick > endTick) throw new Error('event after end');
  return { mode, seed, endTick, log };
}

export const toReplay = (g: Game): Replay => ({ mode: g.mode, seed: g.seed, endTick: g.tick, log: g.log.slice() });

/** Steps a game along a replay. `advance()` runs one tick; returns false once the replay is over. */
export function player(r: Replay) {
  const game = new Game(r.mode, r.seed);
  let i = 0;
  return {
    game,
    advance() {
      if (!game.alive || game.tick >= r.endTick) return false;
      let input = -1;
      while (i < r.log.length && r.log[i] < game.tick) i += 2; // stale events are ignored, not replayed late
      if (i < r.log.length && r.log[i] === game.tick) {
        input = r.log[i + 1];
        i += 2;
      }
      game.step(input);
      return true;
    },
  };
}

/** Runs a replay to its end. Used by the Worker to score submissions. */
export function simulate(r: Replay) {
  const p = player(r);
  while (p.advance());
  return p.game;
}
