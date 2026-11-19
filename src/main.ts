import './style.css';
import { COMBO_WINDOW_MS, Game, MODES, dailySeed, utcDay, type Mode } from './sim.ts';
import { decode, encode, player, simulate, toReplay, type Replay } from './replay.ts';
import { think } from './autopilot.ts';
import { Renderer } from './render.ts';
import { bindInput, pollGamepad, type Action, type InputSink } from './input.ts';
import { setSound, sfx, unlockAudio } from './audio.ts';
import { persist, saved, wipe } from './store.ts';
import { fetchBoard, submitRun, type Entry } from './api.ts';

type Screen = 'menu' | 'ready' | 'play' | 'pause' | 'over' | 'replay';
const NAMES: Record<Mode, string> = { classic: 'Classic', daily: 'Daily', blitz: 'Blitz', zen: 'Zen' };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('board');
const renderer = new Renderer(canvas);
const scoreEl = $('score');
const comboEl = $('combo');
const bestEl = $('best');
const meterEl = $('meter').firstElementChild as HTMLElement;
const noteEl = $('playNote');
const toastEl = $('toast');
const liveEl = $('liveStats');

let screen: Screen = 'menu';
let game: Game = new Game('classic', 1);
let ghost: ReturnType<typeof player> | null = null;
let attract = newAttract();
let attractDeadAt = 0;
let queue: number[] = [];
let acc = 0;
let last = performance.now();
let topCombo = 0;
let shownScore = -1;
let lastSecond = 0;
let overTimer = 0;
let wakeLock: { release(): Promise<void> } | null = null;

// Replay viewer state
let rp: ReturnType<typeof player> | null = null;
let rpData: Replay | null = null;
let rpName = '';
let rpSpeed = 1;
let rpPaused = false;

function random32() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}
function newAttract() {
  return new Game('classic', random32());
}

const PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>';
const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg>';
function setScreen(s: Screen) {
  screen = s;
  document.body.dataset.screen = s;
  const btn = $('pauseBtn');
  const paused = s === 'pause';
  btn.innerHTML = paused ? PLAY_ICON : PAUSE_ICON;
  btn.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
}

// ---------------------------------------------------------------- game flow

function startGame(mode: Mode) {
  clearTimeout(overTimer);
  const today = utcDay();
  game = new Game(mode, mode === 'daily' ? dailySeed(today) : random32());
  ghost = null;
  if (mode === 'daily' && saved.settings.ghost && saved.daily?.day === today) {
    try {
      ghost = player(decode(saved.daily.replay));
    } catch {
      ghost = null;
    }
  }
  renderer.reset();
  queue = [];
  acc = 0;
  topCombo = 0;
  shownScore = -1;
  lastSecond = 0;
  setScreen('ready');
  $('readyHint').textContent = matchMedia('(pointer: coarse)').matches
    ? 'Swipe to start. Swipe anywhere to turn.'
    : 'Press an arrow key to start. Esc pauses.';
  noteEl.textContent = '';
  updateHud();
}

function begin() {
  if (screen !== 'ready') return;
  setScreen('play');
  acc = 0;
  sfx.start();
  lockScreen();
}

function turn(d: number) {
  if (screen === 'pause') resume();
  if (screen === 'ready') begin();
  if (screen !== 'play') return;
  const prev = queue.length ? queue[queue.length - 1] : game.dir;
  if (d === prev || d === (prev ^ 2) || queue.length >= 3) return;
  queue.push(d);
}

function tickGame() {
  const before = game.score;
  game.step(queue.length ? queue.shift()! : -1);
  ghost?.advance();
  if (game.ate) {
    renderer.onEat(game, game.score - before);
    if (game.ate === 2) sfx.gold();
    else sfx.eat(game.combo);
    buzz(game.ate === 2 ? 25 : 10);
    topCombo = Math.max(topCombo, game.combo + 1);
    if (game.combo > 0) bump();
  }
  if (game.cut) {
    renderer.onBite(game);
    sfx.bite();
    buzz(30);
  }
  if (game.rules.timeLimitMs) {
    const s = Math.ceil(game.timeLeft / 1000);
    if (s !== lastSecond && s <= 10 && s > 0) sfx.tick(s <= 3);
    lastSecond = s;
  }
  if (!game.alive) endGame();
}

function pause() {
  if (screen !== 'play' && screen !== 'ready') return;
  setScreen('pause');
  releaseScreen();
}

function resume() {
  if (screen !== 'pause') return;
  setScreen(game.tick ? 'play' : 'ready');
  acc = 0;
  if (game.tick) lockScreen();
}

function endGame() {
  renderer.onDeath(game);
  if (!game.won) sfx.die();
  buzz([30, 40, 70]);
  releaseScreen();
  const mode = game.mode;
  const prevBest = saved.best[mode] ?? 0;
  const isBest = game.score > prevBest;
  const code = encode(toReplay(game));
  saved.stats.games++;
  saved.stats.fruit += game.fruit;
  saved.stats.ms += game.elapsed;
  saved.stats.longest = Math.max(saved.stats.longest, game.len);
  if (isBest) {
    saved.best[mode] = game.score;
    saved.bestReplay[mode] = code;
  }
  const today = utcDay();
  if (mode === 'daily' && game.seed === dailySeed(today) && (saved.daily?.day !== today || game.score > saved.daily.score)) {
    saved.daily = { day: today, score: game.score, replay: code, submitted: saved.daily?.day === today ? saved.daily.submitted : -1 };
  }
  persist();
  // Hold on the crash for a beat before the results take over the panel.
  overTimer = window.setTimeout(() => showOver(isBest, prevBest), game.won ? 200 : 650);
}

function showOver(isBest: boolean, prevBest: number) {
  setScreen('over');
  const g = game;
  $('overTitle').textContent = g.won
    ? 'Board cleared'
    : { wall: 'Hit the wall', self: 'Ran into yourself', rock: 'Hit a rock', time: 'Time’s up' }[g.death!] ?? 'Game over';
  countUp($('finalScore'), g.score);
  const verdict = $('verdict');
  verdict.className = 'verdict' + (isBest && g.score > 0 ? ' new' : '');
  verdict.textContent = isBest && g.score > 0
    ? prevBest ? `New ${NAMES[g.mode]} best, up from ${prevBest}.` : `Your first ${NAMES[g.mode]} score.`
    : `${NAMES[g.mode]} best: ${saved.best[g.mode] ?? 0}`;
  if (isBest && g.score > 0) setTimeout(() => sfx.best(), 250);
  fillStats($('overStats'), [
    ['Fruit', String(g.fruit)],
    ['Length', String(g.len)],
    ['Time', clock(g.elapsed)],
    ['Top multiplier', topCombo ? `×${topCombo}` : '–'],
  ]);
  const form = $('submitForm');
  const rank = $('rankLine');
  form.hidden = true;
  rank.hidden = true;
  if (g.mode === 'daily' && g.seed === dailySeed(utcDay())) {
    if (!saved.name) {
      form.hidden = false;
      ($('nameInput') as HTMLInputElement).value = '';
    } else submitDaily();
  }
  document.querySelector<HTMLElement>('.p-over .primary')?.focus({ preventScroll: true });
}

async function submitDaily() {
  const rank = $('rankLine');
  const d = saved.daily;
  if (!d || d.day !== utcDay() || !saved.name) return;
  rank.hidden = false;
  rank.className = 'rank';
  if (d.submitted >= d.score) {
    rank.textContent = 'Your best today is already on the leaderboard.';
    return showRank(rank, false);
  }
  rank.textContent = 'Checking your run…';
  try {
    const res = await submitRun(saved.name, saved.player, d.replay);
    d.submitted = d.score;
    persist();
    rank.textContent = `Your best today, ${d.score}, is ${ordinal(res.rank!)} of ${res.total}.`;
    showRank(rank, true);
  } catch (e) {
    rank.className = 'rank error';
    rank.textContent = `${(e as Error).message}. Your run is saved and will be sent after your next Daily game.`;
  }
}

function showRank(el: HTMLElement, append: boolean) {
  const a = document.createElement('button');
  a.className = 'text-btn';
  a.textContent = 'See leaderboard';
  a.onclick = () => openLeaders();
  if (append) el.append(' ');
  el.append(a);
}

// ---------------------------------------------------------------- replays

function openReplay(r: Replay, name = '') {
  clearTimeout(overTimer);
  rpData = r;
  rpName = name;
  rp = player(r);
  rpPaused = false;
  acc = 0;
  renderer.reset();
  shownScore = -1;
  const final = simulate(r);
  $('replayTitle').textContent = name ? `${name}’s run` : 'Replay';
  $('replayNote').textContent = `${NAMES[r.mode]}${r.mode === 'daily' ? ` on ${dayLabel(dayOfSeed(r.seed))}` : ''}, ${final.score} points, ${final.len} long.`;
  $('playModeBtn').textContent = `Play ${NAMES[r.mode]}`;
  $('replayToggle').textContent = 'Pause';
  setScreen('replay');
  updateHud();
}

function dayOfSeed(seed: number) {
  for (let i = 0; i < 400; i++) {
    const d = utcDay(Date.now() - i * 864e5);
    if (dailySeed(d) === seed) return d;
  }
  return '';
}

async function share() {
  const url = `${location.origin}/#r=${encode(toReplay(game))}${saved.name ? `&n=${encodeURIComponent(saved.name)}` : ''}`;
  const text = `${game.score} in Coil ${NAMES[game.mode]}`;
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ title: 'Coil', text, url });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Replay link copied');
  } catch {
    prompt('Copy this replay link', url);
  }
}

// ---------------------------------------------------------------- frame loop

function frame(now: number) {
  requestAnimationFrame(frame);
  pollGamepad(sink);
  const dt = Math.min(250, now - last);
  last = now;
  let g = game;
  let alpha = 1;

  if (screen === 'menu') {
    g = attract;
    if (attract.alive) {
      acc += dt;
      while (acc >= attract.interval && attract.alive) {
        acc -= attract.interval;
        attract.step(think(attract));
        if (!attract.alive) attractDeadAt = now;
      }
      alpha = attract.alive ? acc / attract.interval : 1;
    } else if (now - attractDeadAt > 1400) {
      attract = newAttract();
      renderer.reset();
      acc = 0;
    }
  } else if (screen === 'play') {
    acc += dt;
    let steps = 0;
    while (game.alive && acc >= game.interval && steps++ < 4) {
      acc -= game.interval;
      tickGame();
    }
    alpha = game.alive ? Math.min(1, acc / game.interval) : 1;
  } else if (screen === 'replay' && rp) {
    g = rp.game;
    if (!rpPaused) {
      acc += dt * rpSpeed;
      let steps = 0;
      while (acc >= g.interval && steps++ < 12) {
        acc -= g.interval;
        const before = g.score;
        if (!rp.advance()) {
          rpPaused = true;
          $('replayToggle').textContent = 'Watch again';
          if (!g.alive && !g.won) renderer.onDeath(g);
          break;
        }
        if (g.ate) renderer.onEat(g, g.score - before);
        if (g.cut) renderer.onBite(g);
      }
    }
    alpha = !rpPaused && g.alive ? Math.min(1, acc / g.interval) : 1;
  }
  renderer.draw(g, alpha, screen === 'menu' || screen === 'replay' ? null : ghost?.game ?? null, now);
  if (screen !== 'menu') updateHud(g, alpha);
}

function updateHud(g = screen === 'replay' && rp ? rp.game : game, alpha = 0) {
  if (g.score !== shownScore) {
    shownScore = g.score;
    scoreEl.textContent = String(g.score);
  }
  comboEl.textContent = g.combo > 0 && g.alive ? `×${g.combo + 1}` : '';
  const best = Math.max(saved.best[g.mode] ?? 0, screen === 'replay' ? 0 : g.score);
  bestEl.textContent = screen === 'replay' || !best ? NAMES[g.mode] : `${NAMES[g.mode]} best ${best}`;
  const since = g.elapsed + alpha * g.interval - g.lastEatMs;
  const frac = g.rules.zen ? 0 : Math.max(0, 1 - since / COMBO_WINDOW_MS);
  meterEl.style.width = `${(frac * 100).toFixed(1)}%`;
  document.documentElement.style.setProperty('--heat', g.alive ? String(g.combo / 4) : '0');
  if (screen !== 'play' && screen !== 'ready') return;
  const live = `${g.fruit}|${g.len}|${Math.round(1000 / g.interval)}`;
  if (liveEl.dataset.v !== live) {
    liveEl.dataset.v = live;
    fillStats(liveEl, [
      ['Fruit', String(g.fruit)],
      ['Length', String(g.len)],
      ['Moves a second', (1000 / g.interval).toFixed(1)],
    ]);
  }
  if (g.rules.timeLimitMs) {
    const left = Math.max(0, g.timeLeft - alpha * g.interval);
    const txt = left < 10_000 ? (left / 1000).toFixed(1) : String(Math.ceil(left / 1000));
    if (noteEl.dataset.t !== txt) {
      noteEl.dataset.t = txt;
      noteEl.innerHTML = `<span class="clock${left < 10_000 ? ' low' : ''}">${txt}</span>seconds left`;
    }
  } else if (g.rules.zen) noteEl.textContent = `Your longest snake so far is ${Math.max(g.len, saved.stats.longest)}.`;
  else if (ghost) noteEl.textContent = `The faint snake is your best run today, ${saved.daily?.score ?? 0} points.`;
}

// ---------------------------------------------------------------- menu

function renderMenu() {
  for (const b of document.querySelectorAll<HTMLElement>('.mode')) {
    const m = b.dataset.mode as Mode;
    const el = b.querySelector('.m-best')!;
    const today = saved.daily?.day === utcDay() ? saved.daily.score : 0;
    const v = m === 'daily' ? today : saved.best[m] ?? 0;
    el.innerHTML = v ? `<span class="sr-only">best </span><b>${v}</b>` : '';
  }
}

function toMenu() {
  clearTimeout(overTimer);
  releaseScreen();
  rp = null;
  if (location.hash) history.replaceState(null, '', location.pathname);
  renderer.reset();
  if (!attract.alive) attract = newAttract();
  acc = 0;
  setScreen('menu');
  renderMenu();
  loadToday();
}

// Top Daily runs, shown under the menu where there is room (desktop, tablet).
let todayAt = 0;
async function loadToday() {
  if (Date.now() - todayAt < 60_000 || !matchMedia('(min-height: 820px), (min-aspect-ratio: 1/1) and (min-height: 600px)').matches) return;
  todayAt = Date.now();
  try {
    const b = await fetchBoard(utcDay(), saved.player);
    const list = $('todayList');
    list.replaceChildren(...b.entries.slice(0, 3).map(entryRow));
    $('today').hidden = !b.entries.length;
  } catch {
    $('today').hidden = true;
  }
}

function entryRow(e: Entry) {
  const li = document.createElement('li');
  if (e.me) li.className = 'me';
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = e.name;
  const pts = document.createElement('span');
  pts.className = 'pts';
  pts.textContent = String(e.score);
  const watch = document.createElement('button');
  watch.className = 'icon';
  watch.setAttribute('aria-label', `Watch ${e.name}’s run`);
  watch.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg>';
  watch.onclick = () => {
    $<HTMLDialogElement>('leaders').close();
    try {
      openReplay(decode(e.replay), e.name);
    } catch {
      toast('This replay could not be read');
    }
  };
  li.append(who, pts, watch);
  return li;
}

// ---------------------------------------------------------------- input

const sink: InputSink = {
  anyGesture: unlockAudio,
  dir: turn,
  action(a: Action) {
    if (document.querySelector('dialog[open]')) return;
    if (a === 'pause') return screen === 'pause' ? resume() : pause();
    if (a === 'back') {
      if (screen === 'play' || screen === 'ready') pause();
      else if (screen === 'pause') resume();
      else if (screen === 'over' || screen === 'replay') toMenu();
      return;
    }
    if (screen === 'ready') begin();
    else if (screen === 'pause') resume();
    else if (screen === 'over') startGame(game.mode);
    else if (screen === 'replay') toggleReplay();
  },
};
bindInput(document.body, sink, () => screen === 'ready' || screen === 'play' || screen === 'pause');

addEventListener('keydown', (e) => {
  if (screen !== 'menu' || document.querySelector('dialog[open]') || e.metaKey || e.ctrlKey) return;
  const i = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(e.code);
  if (i >= 0) startGame(MODES[i]);
});

document.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-mode], [data-act], [data-open], [data-close]');
  if (!t) return;
  unlockAudio();
  if (t.dataset.mode) return startGame(t.dataset.mode as Mode);
  if (t.dataset.open) return t.dataset.open === 'leaders' ? openLeaders() : openDialog(t.dataset.open);
  if (t.hasAttribute('data-close')) return (t.closest('dialog') as HTMLDialogElement).close();
  switch (t.dataset.act) {
    case 'resume': return resume();
    case 'restart': return startGame(game.mode);
    case 'menu': return toMenu();
    case 'again': return startGame(game.mode);
    case 'watch': return openReplay(toReplay(game), saved.name);
    case 'share': return share();
    case 'replayToggle': return toggleReplay();
    case 'replayRestart': return rpData && openReplay(rpData, rpName);
    case 'playMode': return rpData && startGame(rpData.mode);
  }
});

function toggleReplay() {
  if (!rp || !rpData) return;
  if (!rp.game.alive || rp.game.tick >= rpData.endTick) return openReplay(rpData, rpName);
  rpPaused = !rpPaused;
  $('replayToggle').textContent = rpPaused ? 'Resume' : 'Pause';
}

$('pauseBtn').addEventListener('click', () => (screen === 'pause' ? resume() : screen === 'replay' ? toggleReplay() : pause()));

for (const b of document.querySelectorAll<HTMLElement>('#speed [data-speed]')) {
  b.addEventListener('click', () => {
    rpSpeed = Number(b.dataset.speed);
    for (const o of document.querySelectorAll('#speed [data-speed]')) o.setAttribute('aria-checked', String(o === b));
  });
}

$('submitForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = ($('nameInput') as HTMLInputElement).value.trim().replace(/\s+/g, ' ');
  if (!/^[\p{L}\p{N} _.'-]{1,16}$/u.test(name)) {
    toast('Use up to 16 letters, numbers, spaces, dots or dashes');
    return;
  }
  saved.name = name;
  persist();
  $('submitForm').hidden = true;
  submitDaily();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
  else if (wakeLock === null && screen === 'play') lockScreen();
});
addEventListener('blur', () => pause());

// ---------------------------------------------------------------- dialogs

function openDialog(id: string) {
  if (screen === 'play') pause();
  if (id === 'settings') syncSettings();
  $<HTMLDialogElement>(id).showModal();
}

for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close(); // backdrop
  });
}

let boardDay = utcDay();
async function openLeaders(day = utcDay()) {
  boardDay = day;
  const list = $('boardList');
  $('dayLabel').textContent = dayLabel(day);
  ($('dayNext') as HTMLButtonElement).disabled = day >= utcDay();
  if (!$<HTMLDialogElement>('leaders').open) openDialog('leaders');
  list.innerHTML = '<li class="empty">Loading…</li>';
  try {
    const b = await fetchBoard(day, saved.player);
    if (boardDay !== day) return;
    list.replaceChildren();
    if (!b.entries.length) list.innerHTML = `<li class="empty">${day === utcDay() ? 'No runs yet today. Play Daily to set the first score.' : 'Nobody played this day.'}</li>`;
    list.append(...b.entries.map(entryRow));
  } catch (e) {
    list.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = navigator.onLine ? `${(e as Error).message}. Try again in a moment.` : 'You’re offline. The leaderboard loads when you reconnect.';
    list.append(li);
  }
}
$('dayPrev').addEventListener('click', () => openLeaders(utcDay(Date.parse(boardDay) - 864e5)));
$('dayNext').addEventListener('click', () => openLeaders(utcDay(Date.parse(boardDay) + 864e5)));

function syncSettings() {
  const s = saved.settings;
  ($('optSound') as HTMLInputElement).checked = s.sound;
  ($('optHaptics') as HTMLInputElement).checked = s.haptics;
  ($('optGhost') as HTMLInputElement).checked = s.ghost;
  for (const b of document.querySelectorAll('#themeSeg [data-theme]')) b.setAttribute('aria-checked', String((b as HTMLElement).dataset.theme === s.theme));
  const st = saved.stats;
  fillStats($('lifeStats'), [
    ['Games', String(st.games)],
    ['Fruit eaten', String(st.fruit)],
    ['Time played', clock(st.ms, true)],
    ['Longest snake', String(st.longest)],
  ]);
}
($('optSound') as HTMLInputElement).onchange = (e) => {
  saved.settings.sound = (e.target as HTMLInputElement).checked;
  setSound(saved.settings.sound);
  persist();
};
($('optHaptics') as HTMLInputElement).onchange = (e) => {
  saved.settings.haptics = (e.target as HTMLInputElement).checked;
  persist();
};
($('optGhost') as HTMLInputElement).onchange = (e) => {
  saved.settings.ghost = (e.target as HTMLInputElement).checked;
  persist();
};
for (const b of document.querySelectorAll<HTMLElement>('#themeSeg [data-theme]')) {
  b.onclick = () => {
    saved.settings.theme = b.dataset.theme as Saved['theme'];
    persist();
    applyTheme();
    syncSettings();
  };
}
type Saved = typeof saved.settings;
for (const b of document.querySelectorAll<HTMLElement>('button[data-look]')) {
  b.onclick = () => {
    saved.settings.look = b.dataset.look as Saved['look'];
    persist();
    applyTheme();
  };
}
$('wipeBtn').onclick = () => {
  if (!confirm('Erase all scores, stats and settings on this device?')) return;
  wipe();
  applyTheme();
  setSound(true);
  syncSettings();
  renderMenu();
  toast('Erased');
};

let installEvent: (Event & { prompt(): Promise<void> }) | null = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e as typeof installEvent;
  $('installBtn').hidden = false;
});
$('installBtn').onclick = async () => {
  await installEvent?.prompt();
  installEvent = null;
  $('installBtn').hidden = true;
};

// ---------------------------------------------------------------- helpers

function applyTheme() {
  const pref = saved.settings.theme;
  const t = pref === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : pref;
  const look = saved.settings.look;
  document.documentElement.dataset.theme = t;
  document.documentElement.dataset.look = look;
  renderer.setTheme(t, look);
  for (const b of document.querySelectorAll('[data-look]')) b.setAttribute('aria-checked', String((b as HTMLElement).dataset.look === look));
  for (const m of document.querySelectorAll('meta[name=theme-color]')) m.setAttribute('content', getComputedStyle(document.body).backgroundColor);
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

function fillStats(dl: HTMLElement, rows: [string, string][]) {
  dl.replaceChildren(
    ...rows.map(([k, v]) => {
      const div = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = k;
      dd.textContent = v;
      div.append(dt, dd);
      return div;
    }),
  );
}

function clock(ms: number, long = false) {
  const s = Math.round(ms / 1000);
  if (long && s >= 3600) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function dayLabel(day: string) {
  if (!day) return 'an earlier day';
  if (day === utcDay()) return 'Today';
  if (day === utcDay(Date.now() - 864e5)) return 'Yesterday';
  return new Date(day + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function countUp(el: HTMLElement, to: number) {
  if (renderer.reducedMotion || to < 10) {
    el.textContent = String(to);
    return;
  }
  const t0 = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / 700);
    el.textContent = String(Math.round(to * (1 - (1 - k) ** 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function bump() {
  if (renderer.reducedMotion) return;
  scoreEl.classList.add('bump');
  setTimeout(() => scoreEl.classList.remove('bump'), 90);
}

let toastTimer = 0;
function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2200);
}

function buzz(p: number | number[]) {
  if (saved.settings.haptics) navigator.vibrate?.(p);
}

async function lockScreen() {
  try {
    wakeLock = (await (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen')) ?? null;
  } catch {
    wakeLock = null;
  }
}
function releaseScreen() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

// ---------------------------------------------------------------- boot

new ResizeObserver(() => renderer.resize()).observe(canvas);
renderer.resize();
setSound(saved.settings.sound);
applyTheme();
renderMenu();
loadToday();

function openFromHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const r = h.get('r');
  if (!r) return;
  try {
    openReplay(decode(r), (h.get('n') ?? '').slice(0, 16));
  } catch {
    toast('This replay link is damaged or incomplete');
    history.replaceState(null, '', location.pathname);
  }
}
openFromHash();
addEventListener('hashchange', openFromHash);
requestAnimationFrame(frame);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
}
