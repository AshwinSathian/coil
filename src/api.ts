export interface Entry {
  name: string;
  score: number;
  length: number;
  replay: string;
  me?: boolean;
}

export interface Board {
  day: string;
  entries: Entry[];
  rank?: number;
  total?: number;
}

async function call(path: string, init?: RequestInit): Promise<Board> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as Board & { error?: string };
  if (!res.ok) throw new Error(body.error || `Leaderboard unavailable (${res.status})`);
  return body;
}

export const fetchBoard = (day: string, player: string) => call(`/api/daily?day=${day}&player=${encodeURIComponent(player)}`);

export const submitRun = (name: string, player: string, replay: string) =>
  call('/api/daily', { method: 'POST', body: JSON.stringify({ name, player, replay }) });
