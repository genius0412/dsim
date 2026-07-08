import type { Replay } from '../sim/replay';
import type { AssistConfig, RobotSpec } from '../types';
import { gameServerHttpUrl } from './env';
import { getAuthToken } from '../lib/authClient';

/**
 * Client for the server's public read APIs (leaderboards + replays). These are
 * plain GET/JSON against the same host as the WS game server. Writes NEVER go
 * through here — scores/records/ELO are written only by the authoritative match
 * loop on the server.
 */

export interface RecordConfig {
  spec: RobotSpec;
  assists: AssistConfig;
}

export interface RecordRow {
  userId: string;
  handle: string;
  partnerId: string | null;
  score: number;
  replayId: string | null;
  createdAt: string;
  config: RecordConfig | null;
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

export interface UserEloStat {
  mode: '1v1' | '2v2';
  rating: number;
  games: number;
  rank: number | null;
}
export interface UserRecordStat {
  mode: 'solo' | 'duo';
  best: number | null;
  rank: number | null;
  replayId: string | null;
}
export interface UserMatchRow {
  matchId: string;
  mode: '1v1' | '2v2';
  alliance: 'red' | 'blue';
  score: number;
  won: boolean;
  ratingBefore: number;
  ratingAfter: number;
  createdAt: string;
}
export interface UserStats {
  userId: string;
  handle: string | null;
  season: number;
  elo: UserEloStat[];
  records: UserRecordStat[];
  match: { played: number; wins: number; losses: number };
  recent: UserMatchRow[];
}

/** One round-trip: a user's whole competitive profile for the current season
 * (ranks computed server-side — no full board pulled to the client). */
export function fetchUserStats(userId: string, season?: number): Promise<UserStats> {
  const s = season != null ? `?season=${season}` : '';
  return getJson(`/api/user/${encodeURIComponent(userId)}/stats${s}`);
}

export interface GlobalStats {
  users: number;
  games: number;
  byCategory: { solo: number; duo: number; '1v1': number; '2v2': number };
}

/** site-wide totals for the homepage (players + games played, by category) */
export function fetchGlobalStats(): Promise<GlobalStats> {
  return getJson(`/api/stats`);
}

export interface Presence {
  /** open sockets to the game server (people engaged with multiplayer — solo /
   * free-drive players never connect, so this is "who's around to play with") */
  online: number;
  /** distinct authenticated users currently connected */
  signedIn: number;
  /** how many players are waiting in each ranked bucket right now */
  queues: { '1v1': number; '2v2': number };
}

/** live presence: who's online + how deep each ranked queue is, so a player can
 * see it BEFORE queueing. Cheap JSON off the same host; poll it (usePresence). */
export function fetchPresence(): Promise<Presence> {
  return getJson(`/api/presence`);
}

/** a user's public profile (display handle) */
export function fetchProfile(userId: string): Promise<{ userId: string; handle: string | null }> {
  return getJson(`/api/user/${encodeURIComponent(userId)}`);
}

/** fetch the signed-in user's synced settings blob (null if never saved) */
export async function fetchAccountSettings(): Promise<unknown | null> {
  const base = gameServerHttpUrl();
  if (!base) return null;
  const token = await getAuthToken();
  if (!token) return null;
  const res = await fetch(base + '/api/user/settings', {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { settings?: unknown };
  return data.settings ?? null;
}

/** save the signed-in user's settings blob (best-effort; server verifies JWT) */
export async function saveAccountSettings(settings: unknown): Promise<void> {
  const base = gameServerHttpUrl();
  if (!base) return;
  const token = await getAuthToken();
  if (!token) return;
  await fetch(base + '/api/user/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ settings }),
  });
}

/** set the signed-in user's OWN display name (server verifies the Neon Auth JWT) */
export async function updateHandle(handle: string): Promise<{ userId: string; handle: string }> {
  const base = gameServerHttpUrl();
  if (!base) throw new Error('Changing your name needs the game server (VITE_GAME_SERVER_URL).');
  const token = await getAuthToken();
  if (!token) throw new Error('Please sign in again.');
  const res = await fetch(base + '/api/user/handle', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ handle }),
  });
  const data = (await res.json().catch(() => ({}))) as { handle?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}`);
  return { userId: '', handle: data.handle ?? handle };
}

export function fetchReplay(id: string): Promise<Replay> {
  return getJson(`/api/replay/${id}`);
}

// ---- admin (authorized server-side by ADMIN_USER_IDS against your auth JWT) ----

/** whether the signed-in user is an admin (+ their userId, so you can find the
 * UUID to put in ADMIN_USER_IDS). Safe for anyone to call — false when signed out. */
export async function fetchAdminStatus(): Promise<{ isAdmin: boolean; userId: string | null }> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return { isAdmin: false, userId: null };
  try {
    const res = await fetch(base + '/api/admin/status', { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return { isAdmin: false, userId: null };
    return (await res.json()) as { isAdmin: boolean; userId: string | null };
  } catch {
    return { isAdmin: false, userId: null };
  }
}

/** broadcast a scheduled-restart countdown to every connected client */
export async function adminAnnounce(seconds: number, message: string): Promise<boolean> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return false;
  const q = new URLSearchParams({ seconds: String(Math.max(0, Math.round(seconds))), msg: message });
  const res = await fetch(base + '/api/admin/announce?' + q.toString(), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  return res.ok;
}

/** clear a pending restart notice */
export async function adminCancelNotice(): Promise<boolean> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return false;
  const res = await fetch(base + '/api/admin/announce?cancel=1', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  return res.ok;
}
