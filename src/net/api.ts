import type { Replay } from '../sim/replay';
import { gameServerHttpUrl } from './env';

/**
 * Client for the server's public read APIs (leaderboards + replays). These are
 * plain GET/JSON against the same host as the WS game server. Writes NEVER go
 * through here — scores/records/ELO are written only by the authoritative match
 * loop on the server.
 */

export interface RecordRow {
  userId: string;
  handle: string;
  partnerId: string | null;
  score: number;
  replayId: string | null;
  createdAt: string;
}

export interface EloRow {
  userId: string;
  handle: string;
  rating: number;
  games: number;
}

export type RecordMode = 'solo' | 'duo';
export type EloMode = '1v1' | '2v2';
/** a specific drivetrain board or the cross-drivetrain 'overall' */
export type Board = 'mecanum' | 'tank' | 'swerve' | 'xdrive' | 'overall';

async function getJson<T>(path: string): Promise<T> {
  const base = gameServerHttpUrl();
  if (!base) throw new Error('Leaderboards need the game server (VITE_GAME_SERVER_URL).');
  const res = await fetch(base + path);
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return (await res.json()) as T;
}

export function fetchRecords(
  mode: RecordMode,
  drivetrain: Board,
  season?: number,
): Promise<{ rows: RecordRow[] }> {
  const s = season != null ? `&season=${season}` : '';
  return getJson(`/api/records?mode=${mode}&drivetrain=${drivetrain}${s}`);
}

export function fetchElo(
  mode: EloMode,
  drivetrain: Board,
  season?: number,
): Promise<{ rows: EloRow[] }> {
  const s = season != null ? `&season=${season}` : '';
  return getJson(`/api/elo?mode=${mode}&drivetrain=${drivetrain}${s}`);
}

export function fetchReplay(id: string): Promise<Replay> {
  return getJson(`/api/replay/${id}`);
}
