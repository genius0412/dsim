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
  username: string | null;
  partnerId: string | null;
  /** duo partner's display name + username (null for solo runs / legacy) */
  partnerHandle: string | null;
  partnerUsername: string | null;
  score: number;
  replayId: string | null;
  createdAt: string;
  config: RecordConfig | null;
}

export interface EloRow {
  userId: string;
  handle: string;
  username: string | null;
  rating: number;
  games: number;
}

/** the viewing player's own standing on a board (placed or not). `rank` is null
 * while still in placements; derive placement from `games` against PLACEMENT_GAMES. */
export interface EloStanding {
  rank: number | null;
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
  me?: string | null,
): Promise<{ rows: EloRow[]; me: EloStanding | null }> {
  const s = season != null ? `&season=${season}` : '';
  const m = me ? `&me=${encodeURIComponent(me)}` : '';
  return getJson(`/api/elo?mode=${mode}&drivetrain=${drivetrain}${s}${m}`);
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
  username: string | null;
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
  /** the live admin notice (scheduled restart / info), or null — mirrors the
   * WebSocket `serverNotice` so disconnected pages can show the banner too */
  notice?: { kind: 'restart' | 'info'; message: string; until?: number } | null;
}

/** live presence: who's online + how deep each ranked queue is, so a player can
 * see it BEFORE queueing. Cheap JSON off the same host; poll it (usePresence). */
export function fetchPresence(): Promise<Presence> {
  return getJson(`/api/presence`);
}

export interface PublicProfile {
  userId: string;
  handle: string | null;
  username: string | null;
}

/** a user's public profile (display handle + unique username), keyed by user id */
export function fetchProfile(userId: string): Promise<PublicProfile> {
  return getJson(`/api/user/${encodeURIComponent(userId)}`);
}

/** a public profile by its username (the /profile/<username> page). Rejects on 404. */
export function fetchProfileByUsername(username: string): Promise<PublicProfile> {
  return getJson(`/api/profile/${encodeURIComponent(username)}`);
}

/** one user's full stats by username (the public profile page). Rejects on 404. */
export function fetchUserStatsByUsername(username: string, season?: number): Promise<UserStats> {
  const s = season != null ? `?season=${season}` : '';
  return getJson(`/api/profile/${encodeURIComponent(username)}/stats${s}`);
}

// ---- unified match history (Career + public profile) -----------------------

export interface MatchHistoryPlayer {
  userId: string;
  handle: string;
  username: string | null;
  alliance: 'red' | 'blue' | null; // null for record-run partners
}
export interface MatchHistoryEntry {
  kind: 'versus' | 'record';
  id: string;
  mode: string; // '1v1'|'2v2' (versus) or 'solo'|'duo' (record)
  ranked: boolean | null; // versus only
  drivetrain: string | null; // record only
  createdAt: string;
  replayId: string | null;
  score: number;
  won: boolean | null; // versus only
  eloBefore: number | null;
  eloAfter: number | null;
  players: MatchHistoryPlayer[];
}
export interface MatchHistoryPage {
  rows: MatchHistoryEntry[];
  total: number;
  offset: number;
  limit: number;
}
/** filter/paging options for the match history */
export interface MatchHistoryOpts {
  season?: number;
  offset?: number;
  limit?: number;
  type?: 'all' | 'ranked' | 'custom' | 'solo' | 'duo';
  result?: 'all' | 'win' | 'loss';
}
function historyQuery(o: MatchHistoryOpts): string {
  const p = new URLSearchParams();
  if (o.season != null) p.set('season', String(o.season));
  if (o.offset) p.set('offset', String(o.offset));
  if (o.limit != null) p.set('limit', String(o.limit));
  if (o.type && o.type !== 'all') p.set('type', o.type);
  if (o.result && o.result !== 'all') p.set('result', o.result);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** a signed-in user's paginated match history (by user id — "my Career") */
export function fetchUserMatches(
  userId: string,
  opts: MatchHistoryOpts = {},
): Promise<MatchHistoryPage> {
  return getJson(`/api/user/${encodeURIComponent(userId)}/matches${historyQuery(opts)}`);
}

/** a public player's paginated match history (by username — profile page) */
export function fetchUserMatchesByUsername(
  username: string,
  opts: MatchHistoryOpts = {},
): Promise<MatchHistoryPage> {
  return getJson(`/api/profile/${encodeURIComponent(username)}/matches${historyQuery(opts)}`);
}

/** Public username format: 4–20 lowercase letters/digits. Mirrors the server
 * (`server/api.ts` USERNAME_RE) and the DB unique index. */
export const USERNAME_RE = /^[a-z0-9]{4,20}$/;

/** is a username validly-formatted AND free? (server-checked; format-checks
 * locally first so a bad string never hits the network) */
export async function checkUsername(
  username: string,
): Promise<{ valid: boolean; available: boolean }> {
  const u = username.trim().toLowerCase();
  if (!USERNAME_RE.test(u)) return { valid: false, available: false };
  const base = gameServerHttpUrl();
  if (!base) return { valid: true, available: true }; // no server ⇒ can't check; allow
  try {
    const res = await fetch(base + `/api/username-available?u=${encodeURIComponent(u)}`);
    if (!res.ok) return { valid: true, available: false };
    return (await res.json()) as { valid: boolean; available: boolean };
  } catch {
    return { valid: true, available: false };
  }
}

/** claim the signed-in user's unique username (server verifies the JWT + uniqueness).
 * Throws with the server's message (e.g. "That username is taken.") on failure. */
export async function updateUsername(username: string): Promise<{ username: string }> {
  const base = gameServerHttpUrl();
  if (!base) throw new Error('Setting a username needs the game server (VITE_GAME_SERVER_URL).');
  const token = await getAuthToken();
  if (!token) throw new Error('Please sign in again.');
  const res = await fetch(base + '/api/user/username', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ username: username.trim().toLowerCase() }),
  });
  const data = (await res.json().catch(() => ({}))) as { username?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}`);
  return { username: data.username ?? username.trim().toLowerCase() };
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

// ---- seasons ---------------------------------------------------------------

export interface SeasonInfo {
  season: number;
  name: string;
  active: boolean;
  startedAt: string;
  records: number;
  matches: number;
}

/** all seasons (newest first) + which one is live, for the board's season picker */
export function fetchSeasons(): Promise<{ current: number; seasons: SeasonInfo[] }> {
  return getJson(`/api/seasons`);
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

/** archive the live boards and open a fresh season; returns the new season number */
export async function adminStartSeason(name?: string): Promise<number | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  const q = name && name.trim() ? '?name=' + encodeURIComponent(name.trim()) : '';
  const res = await fetch(base + '/api/admin/season/start' + q, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { season?: number };
  return data.season ?? null;
}

/** delete the replays of an archived season (omit `season` to purge every one
 * before the live season). Boards stay; those runs just stop being watchable. */
export async function adminPurgeReplays(season?: number): Promise<number | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  const q = season != null ? '?season=' + season : '';
  const res = await fetch(base + '/api/admin/season/purge-replays' + q, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { freed?: number };
  return data.freed ?? 0;
}

// ---- admin moderation: leaderboard records + display names ------------------

/** one moderation row: the best run per player in a bucket, with its record id */
export interface AdminRecordRow {
  recordId: string;
  userId: string;
  handle: string;
  score: number;
  drivetrain: string;
  replayId: string | null;
  createdAt: string;
}

/** fetch the moderation view of a record-board bucket (live season) */
export async function adminFetchRecords(
  mode: 'solo' | 'duo',
  drivetrain: string,
  limit = 100,
): Promise<AdminRecordRow[]> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return [];
  const q = new URLSearchParams({ mode, drivetrain, limit: String(limit) });
  const res = await fetch(base + '/api/admin/records?' + q.toString(), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = (await res.json().catch(() => ({}))) as { rows?: AdminRecordRow[] };
  return data.rows ?? [];
}

/** delete one record run (+ its replay) by id */
export async function adminDeleteRecord(id: string): Promise<boolean> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return false;
  const res = await fetch(base + '/api/admin/record/delete?id=' + encodeURIComponent(id), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  return res.ok;
}

/** delete EVERY record run by a user (confirmed cheater); returns count removed */
export async function adminClearUserRecords(userId: string): Promise<number | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  const res = await fetch(base + '/api/admin/user/records/clear?userId=' + encodeURIComponent(userId), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { removed?: number };
  return data.removed ?? 0;
}

/** search profiles by handle (substring) or exact userId, for renaming */
export async function adminSearchUsers(query: string): Promise<{ userId: string; handle: string }[]> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token || !query.trim()) return [];
  const res = await fetch(base + '/api/admin/users?q=' + encodeURIComponent(query.trim()), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = (await res.json().catch(() => ({}))) as { users?: { userId: string; handle: string }[] };
  return data.users ?? [];
}

/** force a user's display name to a clean value; returns the saved handle or null */
export async function adminRenameUser(userId: string, handle: string): Promise<string | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  const q = new URLSearchParams({ userId, handle: handle.trim() });
  const res = await fetch(base + '/api/admin/user/rename?' + q.toString(), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { handle?: string };
  return data.handle ?? null;
}
