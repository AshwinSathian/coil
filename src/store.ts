// Local persistence. Everything here is a convenience: the game works if storage is blocked.

import type { Mode } from './sim.ts';

export interface Saved {
  best: Partial<Record<Mode, number>>;
  bestReplay: Partial<Record<Mode, string>>;
  daily: { day: string; score: number; replay: string; submitted: number } | null;
  stats: { games: number; fruit: number; ms: number; longest: number };
  settings: { sound: boolean; haptics: boolean; theme: 'auto' | 'light' | 'dark'; ghost: boolean; look: 'retro' | 'modern' };
  name: string;
  player: string; // random id, keys this device's leaderboard rows
}

const KEY = 'coil:v1';

const fresh = (): Saved => ({
  best: {},
  bestReplay: {},
  daily: null,
  stats: { games: 0, fruit: 0, ms: 0, longest: 0 },
  settings: { sound: true, haptics: true, theme: 'auto', ghost: true, look: 'retro' },
  name: '',
  player: crypto.randomUUID?.() ?? String(Math.random()).slice(2),
});

function load(): Saved {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      const f = fresh();
      return { ...f, ...s, stats: { ...f.stats, ...s.stats }, settings: { ...f.settings, ...s.settings } };
    }
  } catch {
    /* storage blocked or corrupt: start fresh */
  }
  return fresh();
}

export const saved = load();

export function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {
    /* private mode: keep going in memory */
  }
}

export function wipe() {
  Object.assign(saved, fresh());
  persist();
}
