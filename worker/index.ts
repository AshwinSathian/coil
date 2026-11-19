// Daily leaderboard API. Static files are served by Workers Assets; only /api/* reaches this code.
// The client never sends a score: the Worker replays the submitted inputs through the same
// sim.ts the browser runs and stores the score that falls out.

import { REV, dailySeed, utcDay } from '../src/sim.ts';
import { decode, simulate } from '../src/replay.ts';

interface Env {
  DB: D1Database;
  LIMITER: RateLimit;
}

const TOP = 25;
const NAME = /^[\p{L}\p{N} _.'-]{1,16}$/u;
const PLAYER = /^[A-Za-z0-9-]{8,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
const fail = (error: string, status = 400) => json({ error }, status);

async function top(env: Env, day: string, player: string) {
  const { results } = await env.DB.prepare(
    'SELECT name, score, length, replay, player = ?2 AS me FROM runs WHERE day = ?1 ORDER BY score DESC, created ASC LIMIT ?3',
  )
    .bind(day, player, TOP)
    .all<{ name: string; score: number; length: number; replay: string; me: number }>();
  return results.map((r) => ({ ...r, me: r.me === 1 }));
}

async function submit(req: Request, env: Env) {
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  const { success } = await env.LIMITER.limit({ key: ip });
  if (!success) return fail('Too many submissions. Wait a minute', 429);

  const text = await req.text();
  if (text.length > 24_000) return fail('Run is too large', 413);
  let body: { name?: unknown; player?: unknown; replay?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return fail('Request body is not JSON');
  }
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  const player = typeof body.player === 'string' ? body.player : '';
  if (!NAME.test(name)) return fail('Names are 1 to 16 letters, numbers, spaces, dots or dashes');
  if (!PLAYER.test(player)) return fail('Missing player id');
  if (typeof body.replay !== 'string') return fail('Missing replay');

  let replay;
  try {
    replay = decode(body.replay);
  } catch (e) {
    return fail(`Replay rejected: ${(e as Error).message}`);
  }
  if (replay.mode !== 'daily') return fail('Only Daily runs go on the leaderboard');
  if (replay.rev !== REV) return fail('This run was played under older rules. Play today’s Daily again');
  // Accept today's board, and yesterday's for a run that finished just after midnight UTC.
  const now = Date.now();
  const day = [utcDay(now), utcDay(now - 864e5)].find((d) => dailySeed(d) === replay.seed);
  if (!day) return fail('This run is from a board that has closed');

  const game = simulate(replay);
  if (game.alive || game.tick !== replay.endTick) return fail('Replay does not end in a finished game');
  if (game.score <= 0) return fail('Score at least one fruit to join the leaderboard');

  await env.DB.prepare(
    `INSERT INTO runs (day, player, name, score, length, ticks, replay, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT (day, player) DO UPDATE SET
       name = excluded.name,
       score = CASE WHEN excluded.score > runs.score THEN excluded.score ELSE runs.score END,
       length = CASE WHEN excluded.score > runs.score THEN excluded.length ELSE runs.length END,
       ticks = CASE WHEN excluded.score > runs.score THEN excluded.ticks ELSE runs.ticks END,
       replay = CASE WHEN excluded.score > runs.score THEN excluded.replay ELSE runs.replay END,
       created = CASE WHEN excluded.score > runs.score THEN excluded.created ELSE runs.created END`,
  )
    .bind(day, player, name, game.score, game.len, game.tick, body.replay, now)
    .run();

  const stats = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM runs WHERE day = ?1 AND score > mine.score) + 1 AS rank,
            (SELECT COUNT(*) FROM runs WHERE day = ?1) AS total, mine.score AS score
     FROM runs AS mine WHERE day = ?1 AND player = ?2`,
  )
    .bind(day, player)
    .first<{ rank: number; total: number; score: number }>();

  return json({ day, score: stats?.score ?? game.score, rank: stats?.rank ?? 0, total: stats?.total ?? 0, entries: await top(env, day, player) });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== '/api/daily') return fail('Not found', 404);
    try {
      if (req.method === 'POST') return await submit(req, env);
      if (req.method === 'GET') {
        const day = url.searchParams.get('day') ?? utcDay();
        if (!DAY.test(day)) return fail('Day must be YYYY-MM-DD');
        const player = url.searchParams.get('player') ?? '';
        return json({ day, entries: await top(env, day, PLAYER.test(player) ? player : '') });
      }
      return fail('Method not allowed', 405);
    } catch (e) {
      console.error(e);
      return fail('Leaderboard is having trouble', 500);
    }
  },
} satisfies ExportedHandler<Env>;
