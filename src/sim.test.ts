import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, MODES, N, dailySeed, type Mode } from './sim.ts';
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
  for (const s of ['', '!!!!', 'AAAA', encode({ mode: 'classic', seed: 1, endTick: 5, log: [9, 1] })]) {
    assert.throws(() => decode(s));
  }
});
