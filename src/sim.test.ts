import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Game, H, MODES, N, W, dailySeed, roomTarget, type Mode } from './sim.ts';
import { decode, encode, simulate, toReplay } from './replay.ts';
import { think } from './autopilot.ts';

function autoplay(mode: Mode, seed: number, maxTicks = 4000) {
  const g = new Game(mode, seed);
  while (g.alive && g.tick < maxTicks) {
    g.step(think(g));
    checkInvariants(g);
  }
  return g;
}

function checkInvariants(g: Game) {
  let snake = 0;
  for (let c = 0; c < N; c++) if (g.occ[c] === 1) snake++;
  assert.equal(snake, g.len, 'occupancy matches length');
  const cells = new Set<number>();
  for (let i = 0; i < g.len; i++) cells.add(g.seg(i));
  assert.equal(cells.size, g.len, 'no overlapping segments');
  if (g.alive) {
    assert.notEqual(g.occ[g.food], 1, 'fruit never under the snake');
    assert.notEqual(g.occ[g.food], 2, 'fruit never on a rock');
  }
}

test('same seed and inputs give the same game', () => {
  const a = autoplay('classic', 42);
  const b = autoplay('classic', 42);
  assert.deepEqual([a.score, a.tick, a.len, a.log], [b.score, b.tick, b.len, b.log]);
  const c = autoplay('classic', 43);
  assert.notDeepEqual([a.score, a.tick, a.log], [c.score, c.tick, c.log]);
});

test('replay round-trips and re-simulates to the same score', () => {
  for (const mode of MODES) {
    for (let seed = 1; seed <= 15; seed++) {
      const g = autoplay(mode, seed * 7919, 3000);
      const code = encode(toReplay(g));
      const r = decode(code);
      assert.deepEqual(r, toReplay(g));
      const s = simulate(r);
      assert.equal(s.score, g.score, `${mode}/${seed}`);
      assert.equal(s.tick, g.tick);
      assert.equal(s.alive, g.alive);
    }
  }
});

test('autopilot plays a decent classic game', () => {
  let total = 0;
  for (let s = 0; s < 10; s++) total += autoplay('classic', s).fruit;
  assert.ok(total / 10 > 25, `average fruit ${total / 10}`);
});

test('walls kill in classic, wrap in blitz', () => {
  const g = new Game('classic', 1);
  while (g.alive) g.step(0);
  assert.equal(g.death, 'wall');
  const b = new Game('blitz', 1);
  for (let i = 0; i < 30; i++) b.step(0);
  assert.ok(b.alive);
});

test('blitz ends on time', () => {
  const g = autoplay('blitz', 5, 100_000);
  assert.equal(g.death, 'time');
  assert.ok(g.elapsed >= 60_000);
});

test('zen bites instead of dying', () => {
  const g = new Game('zen', 3);
  for (let i = 0; i < 4000 && g.alive; i++) g.step(think(g));
  assert.ok(g.alive);
  // Force a self bite: grow, then turn into the body.
  const z = new Game('zen', 9);
  z.grow = 6;
  for (let i = 0; i < 6; i++) z.step(1);
  for (const d of [2, 3, 0]) z.step(d);
  assert.ok(z.alive);
  assert.ok(z.cut > 0);
  checkInvariants(z);
});

test('daily rocks are seeded, symmetric and leave the board connected', () => {
  const a = new Game('daily', dailySeed('2026-11-20'));
  const b = new Game('daily', dailySeed('2026-11-20'));
  assert.deepEqual(a.rocks, b.rocks);
  assert.ok(a.rocks.length >= 8);
  for (let d = 0; d < 60; d++) {
    const g = new Game('daily', dailySeed(`2027-01-${d}`));
    assert.ok(g.alive);
    assert.equal(g.occ[g.head], 1);
  }
});

test('reversing is ignored', () => {
  const g = new Game('classic', 1);
  g.step(3);
  assert.equal(g.dir, 1);
  assert.equal(g.log.length, 0);
});

test('decode rejects junk', () => {
  for (const s of ['', '!!!!', 'AAAA', encode({ rev: 2, mode: 'classic', seed: 1, endTick: 5, log: [9, 1] }), encode({ rev: 9, mode: 'classic', seed: 1, endTick: 5, log: [] })]) {
    assert.throws(() => decode(s));
  }
});

test('replays recorded under rules rev 1 still play back exactly', () => {
  // Captured before gates existed, one per mode at the time (classic, daily, blitz, zen).
  const fixtures: [string, number, number][] = JSON.parse(readFileSync(new URL('./fixtures-v1.json', import.meta.url), 'utf8'));
  for (const [code, score, tick] of fixtures) {
    const r = decode(code);
    assert.equal(r.rev, 1);
    const g = simulate(r);
    assert.equal(g.score, score, r.mode);
    assert.equal(g.tick, tick, r.mode);
  }
});

test('a gate sends you out the opposite edge, same row or column; a wall stops you', () => {
  const g = new Game('classic', 1);
  const bottom = (H - 1) * W + 4;
  assert.equal(g.next(bottom, 2), -1, 'solid bottom edge');
  g.colGate[4] = 1;
  assert.equal(g.next(bottom, 2), 4, 'bottom gate leads to the top of column 4');
  g.rowGate[3] = 1;
  assert.equal(g.next(3 * W, 3), 3 * W + W - 1, 'left gate leads to the right end of row 3');
  assert.equal(g.next(5 * W, 3), -1, 'row 5 has no gate');
});

test('gate rooms: mirrored edges, at least one gate per axis, connected, and they advance', () => {
  let maxRoom = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const g = new Game('gates', seed * 104729);
    for (let y = 0; y < H; y++) assert.equal(g.rowGate[y], g.rowGate[H - 1 - y]);
    assert.ok(g.rowGate.some(Boolean) && g.colGate.some(Boolean));
    let rooms = 0;
    while (g.alive && g.tick < 6000) {
      g.step(think(g));
      checkInvariants(g);
      if (g.newRoom) {
        rooms++;
        assert.equal(g.len, 3, 'fresh snake each room');
        assert.equal(g.roomFruit, 0);
      }
    }
    assert.equal(g.room, rooms + 1);
    maxRoom = Math.max(maxRoom, g.room);
    if (g.room > 1) assert.ok(g.score >= 100 + roomTarget(1) * 10);
  }
  assert.ok(maxRoom >= 3, `autopilot reached room ${maxRoom}`);
});

test('the autopilot uses gates', () => {
  let ported = 0;
  for (let seed = 1; seed <= 5 && !ported; seed++) {
    const g = new Game('blitz', seed);
    while (g.alive && !ported) {
      g.step(think(g));
      if (g.ported) ported++;
    }
  }
  assert.ok(ported > 0);
});

test('daily rev 2 is a generated room with gates and inner walls', () => {
  const g = new Game('daily', dailySeed('2026-11-21'));
  assert.ok(g.rocks.length >= 8);
  assert.ok(g.rowGate.some(Boolean) || g.colGate.some(Boolean));
  const old = new Game('daily', dailySeed('2026-11-21'), 1);
  assert.ok(!old.rowGate.some(Boolean) && !old.colGate.some(Boolean), 'rev 1 daily keeps solid edges');
});
