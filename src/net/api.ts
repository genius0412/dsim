import type { Replay } from '../sim/replay';
import type { LiveRoom, StaffRole } from './protocol';
import type { ReportedUser, ReportRow } from '../report';
import type { AssistConfig, GameId, RobotSpec } from '../types';
import { gameServerHttpUrl, setLanFromServer } from './env';
import { getAuthToken } from '../lib/authClient';
import { DISCORD_REGION } from './discordActivity';
// the per-DEVICE view preference (localStorage, never `GameSettings`) — the one thing a
// practice upload can say that the replay container structurally cannot. It is a leaf module
// with no React and no DOM beyond `localStorage`, guarded against storage being unavailable.
import { getViewPref } from '../games/biobuzz/graphics/store';

/**
 * Boards + periods are per-game. DECODE is the server's default for a MISSING
 * `game`, so it is the one id we leave OUT of the URL — every DECODE request
 * stays byte-identical to what it was before there was more than one game, and
 * every other game names itself. `needsGameParam` is the shared predicate so the
 * four query builders below cannot disagree about which ids are implicit.
 */
const needsGameParam = (game?: GameId): boolean => game !== undefined && game !== 'decode';
const gameParam = (game?: GameId): string => (needsGameParam(game) ? `&game=${game}` : '');

/**
 * Client for the server's public read APIs (leaderboards + replays). These are
 * plain GET/JSON against the same host as the WS game server. Writes NEVER go
 * through here — scores/records/ELO are written only by the authoritative match
 * loop on the server.
 */

/**
 * The badge fields that travel with EVERY name the server sends — a leaderboard
 * row, a match-history participant, a friend, the sender of a challenge.
 *
 * One shared shape rather than a pair of fields copied into each interface,
 * because the failure mode is silent: a row type that forgets them still
 * compiles and still renders, just with no badge on that one surface — which is
 * how the ranked board ended up bare while the record board next to it was fine.
 *
 * Both are OPTIONAL. One Fly app serves every client build, so a client can be
 * newer than the server it is talking to and receive neither; "absent" must
 * render exactly like "not a supporter", never as a broken field.
 */
export interface BadgeFields {
  /** active supporter membership (staff are entitled without paying) */
  supporter?: boolean;
  /** 'owner' | 'admin' — renders the staff badge in place of the supporter one */
  role?: StaffRole;
}

export interface RecordConfig {
  spec: RobotSpec;
  assists: AssistConfig;
  /** in a DUO run, the co-op partner's robot (each driver brings their own build,
   * so a duo can mix drivetrains). Absent for solo runs / legacy rows. */
  partnerSpec?: RobotSpec;
}

export interface RecordRow extends BadgeFields {
  userId: string;
  handle: string;
  username: string | null;
  partnerId: string | null;
  /** duo partner's display name + username (null for solo runs / legacy) */
  partnerHandle: string | null;
  partnerUsername: string | null;
  /** the partner's own badge — a duo row prints two names, so it carries two */
  partnerSupporter?: boolean;
  partnerRole?: StaffRole;
  score: number;
  replayId: string | null;
  createdAt: string;
  config: RecordConfig | null;
  /**
   * WHICH SOLVE PRODUCED THIS RUN — `'2d'` | `'3d'` (migration 0039). Absent from an older
   * server's response, and a pre-0039 row reads `'2d'`, so the chip is drawn only where the
   * value is actually known to be `'3d'` — a board that claimed "2D" for every row an old
   * deploy served would be stating something it was never told.
   */
  physics?: string;
}

export interface EloRow extends BadgeFields {
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
/** a record board: a specific drivetrain or the cross-drivetrain 'overall'.
 * RANKED (ELO) is NOT split by drivetrain — only the record boards are. */
export type Board = 'mecanum' | 'tank' | 'swerve' | 'xdrive' | 'overall';

async function getJson<T>(path: string): Promise<T> {
  const base = gameServerHttpUrl();
  if (!base) throw new Error('Leaderboards need the game server (VITE_GAME_SERVER_URL).');
  const res = await fetch(base + path);
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return (await res.json()) as T;
}

/** thrown when the server has the replay but will not serve it to this viewer — everyone who
 * played in it has to opt in (migration 0037). Its own type because the viewer shows a real
 * explanation for it rather than an HTTP status, and because a 403 here is not a failure. */
export class ReplayPrivateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayPrivateError';
  }
}

/**
 * A PUBLIC read that answers differently once it knows who is asking.
 *
 * `getJson` sends no Authorization header and `authedJson` throws without a token, and a
 * replay needs neither: signed out you may still watch a public one, and signed in you may
 * also watch your own. So the token rides along WHEN THERE IS ONE and its absence is not an
 * error. Nothing here retries on 401 — anonymous is a valid answer, not a stale session.
 *
 * ⚠️ COST, accepted knowingly: `getAuthToken` caches a token it HAS but does not remember a
 * miss, so a signed-out visitor pays one `/token` round trip per call — on the public profile
 * and career pages, and again on each page of history. It is small and it is off the
 * leaderboard path (that still uses `getJson`), so it is not worth a negative cache in shared
 * auth, where a stale "no session" would delay a real sign-in. Fix it THERE, with a few
 * seconds' TTL that `force` bypasses, if the profile page ever gets heavy anonymous traffic.
 */
async function maybeAuthedJson<T>(path: string): Promise<T> {
  const base = gameServerHttpUrl();
  if (!base) throw new Error('Leaderboards need the game server (VITE_GAME_SERVER_URL).');
  const token = await getAuthToken().catch(() => null);
  const res = await fetch(base + path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ReplayPrivateError(body.message ?? 'This replay is private.');
  }
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return (await res.json()) as T;
}

export function fetchRecords(
  mode: RecordMode,
  drivetrain: Board,
  season?: number,
  game?: GameId,
  /** the ERA filter (0039): `'2d'` or `'3d'`, or omitted for every row. An older server
   *  ignores the parameter and answers with the whole board, which is the right degradation —
   *  the filter narrows a board, so failing open shows MORE rather than an empty page. */
  physics?: '2d' | '3d',
): Promise<{ rows: RecordRow[] }> {
  const s = season != null ? `&season=${season}` : '';
  const ph = physics ? `&physics=${physics}` : '';
  return getJson(`/api/records?mode=${mode}&drivetrain=${drivetrain}${s}${ph}${gameParam(game)}`);
}

export function fetchElo(
  mode: EloMode,
  season?: number,
  me?: string | null,
  game?: GameId,
): Promise<{ rows: EloRow[]; me: EloStanding | null }> {
  const s = season != null ? `&season=${season}` : '';
  const m = me ? `&me=${encodeURIComponent(me)}` : '';
  return getJson(`/api/elo?mode=${mode}${s}${m}${gameParam(game)}`);
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
  /** active supporter membership — the profile header badge. Absent from a
   *  server older than the perk, which renders identically to false. */
  supporter?: boolean;
  /** 'owner' | 'admin' — the staff badge, which replaces the supporter one */
  role?: StaffRole;
  season: number;
  elo: UserEloStat[];
  records: UserRecordStat[];
  match: { played: number; wins: number; losses: number };
  recent: UserMatchRow[];
  /** LIFETIME playtime + games played: this game, and the total across all of them.
   *  Absent from a server older than the tracker, which renders as nothing at all. */
  activity?: { games: number; seconds: number; allGames: number; allSeconds: number };
}

/** One round-trip: a user's whole competitive profile for the current season
 * (ranks computed server-side — no full board pulled to the client). */
export function fetchUserStats(userId: string, season?: number, game?: GameId): Promise<UserStats> {
  const p = new URLSearchParams();
  if (season != null) p.set('season', String(season));
  if (needsGameParam(game)) p.set('game', game as GameId);
  const qs = p.toString();
  return getJson(`/api/user/${encodeURIComponent(userId)}/stats${qs ? `?${qs}` : ''}`);
}

export interface GlobalStats {
  users: number;
  /** total games played — COMBINED across every game (the homepage headline) */
  games: number;
  byCategory: { solo: number; duo: number; '1v1': number; '2v2': number };
  /** games played PER GAME (DECODE + Chain Reaction tracked separately); the
   * homepage sums these into `games`. Absent from older servers. */
  byGame?: Partial<Record<GameId, number>>;
}

/** site-wide totals for the homepage (players + games played, by category) */
export function fetchGlobalStats(): Promise<GlobalStats> {
  return getJson(`/api/stats`);
}

/** every live RANKED match currently running (for the "Watch Live" list). Each
 * `room` code is spectated via `LobbyClient.spectate`. Custom and record rooms are
 * deliberately absent — they are reached by code (`fetchLiveRoom`). */
export function fetchLiveRooms(): Promise<{ region: string; rooms: LiveRoom[] }> {
  return getJson(`/api/live`);
}

/** one open, joinable lobby in a Discord Activity group (see `fetchLobbies`) */
export interface DiscordLobby {
  code: string;
  players: number;
  capacity: number;
  kind: 'versus' | 'record';
  game: GameId;
}

/**
 * OPEN lobbies for a Discord Activity, scoped by its `group` (the activity instance
 * id). Powers the in-activity lobby browser so more than one game can run at once.
 * Empty for an unknown/empty group — this never lists the global custom-room set.
 * In-activity `getJson` rides the same `/gs` proxy origin as every other read.
 */
export async function fetchLobbies(group: string): Promise<DiscordLobby[]> {
  if (!group) return [];
  try {
    // PIN to the fixed activity region (same as the socket): the read is anycast,
    // so without it an EU player would hit the EU machine and never see the US
    // player's room. The server fly-replays this GET to DISCORD_REGION.
    const q = `group=${encodeURIComponent(group)}&region=${encodeURIComponent(DISCORD_REGION)}`;
    const r = await getJson<{ lobbies: DiscordLobby[] }>(`/api/lobbies?${q}`);
    return r.lobbies ?? [];
  } catch {
    return []; // unreachable server / no lobbies read the same to the browser
  }
}

/**
 * Look up ONE live match by its room code — used to spectate a custom game, and to
 * find the region hosting a friend's match.
 *
 * Resolves to null when nothing is live under that code (a finished match, a typo,
 * a lobby that never started). The `region` on the result is what the spectate
 * socket must be opened with: a custom code carries no region prefix of its own, so
 * without it the connection lands on the wrong machine and the room "does not exist".
 */
export async function fetchLiveRoom(code: string): Promise<LiveRoom | null> {
  try {
    const r = await getJson<{ room: LiveRoom }>(`/api/room?code=${encodeURIComponent(code)}`);
    return r.room ?? null;
  } catch {
    return null; // 404 (not live) and an unreachable server read the same here
  }
}

export interface Presence {
  /** open sockets to the game server (people engaged with multiplayer — solo /
   * free-drive players never connect, so this is "who's around to play with") */
  online: number;
  /** distinct authenticated users currently connected */
  signedIn: number;
  /**
   * Waiting players per bucket, EVERY GAME COMBINED.
   *
   * Kept for compatibility, and deliberately not what the UI shows: pairing is
   * bucketed by game, so this number told a DECODE player that a Chain Reaction
   * queuer was waiting for them. Read `gameQueues` instead.
   */
  queues: { '1v1': number; '2v2': number };
  /** waiting players per bucket, SPLIT BY GAME — the only version a player can act
   *  on. Absent from servers older than this field; callers fall back to `queues`. */
  gameQueues?: Record<string, { '1v1': number; '2v2': number }>;
  /** the live admin notice (scheduled restart / info), or null — mirrors the
   * WebSocket `serverNotice` so disconnected pages can show the banner too */
  notice?: { kind: 'restart' | 'info'; message: string; until?: number } | null;
  /** a scheduled MAINTENANCE window, or null. `biting` is whether it is in force
   *  right now — an armed window with a future start announces itself first. */
  maintenance?: {
    startsAt: number | null;
    endsAt: number | null;
    message: string;
    biting: boolean;
  } | null;
  /** what THIS deploy can honour (see SERVER_CAPS in protocol.ts). One Fly app
   * serves every client build, so a new client checks here before offering
   * something an older server would mishandle rather than ignore. */
  caps?: string[];
}

/**
 * One-shot, cached read of the server's capabilities.
 *
 * Cached for the page's lifetime because the answer can't change under a running
 * client: a redeploy drops every socket, and the version gate reloads the page on
 * a new build. A FAILED read resolves to no capabilities and is not cached, so a
 * later call retries — and the safe direction is exactly that one, since every
 * caller uses this to decide whether to OFFER something. A hidden feature is
 * recoverable; a silently mismatched ranked match is not.
 */
let capsCache: Promise<string[]> | null = null;
export function serverCaps(): Promise<string[]> {
  if (!capsCache) {
    capsCache = fetchPresence()
      .then((p) => (Array.isArray(p.caps) ? p.caps : []))
      .catch(() => {
        capsCache = null;
        return [];
      });
  }
  return capsCache;
}

/**
 * Live presence: who's online + how deep each ranked queue is, so a player can
 * see it BEFORE queueing. Cheap JSON off the same host; poll it (usePresence).
 *
 * `full` asks for a FRESH aggregate rather than a cached one. The count is always
 * real either way; a server with nobody connected just holds its last read longer
 * (~45s) so one browsing visitor costs about a query a minute instead of one every
 * 8 seconds. Pass `full` where the number drives a decision rather than decorating
 * one - ranked queue depth - and leave it off for the ambient chip.
 */
export function fetchPresence(full = false): Promise<Presence> {
  return getJson<Presence>(`/api/presence${full ? '?full=1' : ''}`).then((p) => {
    /* THE LAN ENTRY POINTS ARE LIT FROM HERE, not from the build (src/net/env.ts
       `setLanFromServer`). It goes in `fetchPresence` rather than in `serverCaps` because
       this is the single funnel every presence read passes through - `usePresence` polls it
       from the shell on every screen, so the answer lands during the first poll the app was
       already making. Nothing anywhere fetches anything extra for this. */
    setLanFromServer(Array.isArray(p.caps) && p.caps.includes('lan'));
    return p;
  });
}

export interface PublicProfile extends BadgeFields {
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

export interface MatchHistoryPlayer extends BadgeFields {
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
  /** both alliances' final totals (versus only; null for record runs) */
  redScore: number | null;
  blueScore: number | null;
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
  game?: GameId;
}
function historyQuery(o: MatchHistoryOpts): string {
  const p = new URLSearchParams();
  if (o.season != null) p.set('season', String(o.season));
  if (o.offset) p.set('offset', String(o.offset));
  if (o.limit != null) p.set('limit', String(o.limit));
  if (o.type && o.type !== 'all') p.set('type', o.type);
  if (o.result && o.result !== 'all') p.set('result', o.result);
  if (needsGameParam(o.game)) p.set('game', o.game as GameId);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** a signed-in user's paginated match history (by user id — "my Career").
 * OPTIONALLY AUTHED: a row's `replayId` is null unless the reader may watch it, so the
 * Watch button on your own matches depends on the server knowing they are yours. */
export function fetchUserMatches(
  userId: string,
  opts: MatchHistoryOpts = {},
): Promise<MatchHistoryPage> {
  return maybeAuthedJson(`/api/user/${encodeURIComponent(userId)}/matches${historyQuery(opts)}`);
}

/** a public player's paginated match history (by username — profile page). Same reason for
 * the optional token: a stranger's page still shows YOUR shared matches as watchable. */
export function fetchUserMatchesByUsername(
  username: string,
  opts: MatchHistoryOpts = {},
): Promise<MatchHistoryPage> {
  return maybeAuthedJson(
    `/api/profile/${encodeURIComponent(username)}/matches${historyQuery(opts)}`,
  );
}

/** Public username format: 4–20 lowercase letters/digits. Mirrors the server
 * (`server/api.ts` USERNAME_RE) and the DB unique index. */
export const USERNAME_RE = /^[a-z0-9]{4,20}$/;

/** is a username validly-formatted AND free? (server-checked; format-checks
 * locally first so a bad string never hits the network) */
export async function checkUsername(
  username: string,
): Promise<{ valid: boolean; available: boolean; reason?: string }> {
  const u = username.trim().toLowerCase();
  if (!USERNAME_RE.test(u)) return { valid: false, available: false };
  const base = gameServerHttpUrl();
  if (!base) return { valid: true, available: true }; // no server ⇒ can't check; allow
  try {
    const res = await fetch(base + `/api/username-available?u=${encodeURIComponent(u)}`);
    if (!res.ok) return { valid: true, available: false };
    // `reason: 'inappropriate'` distinguishes a moderation block (blocked name) from
    // a plain format/availability failure, so the UI can show the right hint.
    return (await res.json()) as { valid: boolean; available: boolean; reason?: string };
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
  // sends the token when there is one: a participant may watch their own match whatever
  // anybody has opted into, and signed out you may still watch a public one
  return maybeAuthedJson(`/api/replay/${id}`);
}

// ---- replay privacy (your own account setting) ------------------------------

/** may anyone watch your versus match replays? Default FALSE, and retroactively so — see
 * migration 0037. A match is released only when EVERY player in it has this on. */
export function fetchReplaysPublic(): Promise<{ replaysPublic: boolean }> {
  return authedJson('/api/user/privacy');
}

export function saveReplaysPublic(replaysPublic: boolean): Promise<{ replaysPublic: boolean }> {
  return authedJson('/api/user/privacy', {
    method: 'POST',
    body: JSON.stringify({ replaysPublic }),
  });
}

// ---- solo practice replays (own account only) ------------------------------

/** one uploaded practice run as the server stores it */
export interface PracticeRun {
  id: string;
  game: GameId;
  score: number;
  ticks: number;
  replayId: string | null;
  createdAt: string;
  /** which solve ran it ('2d' | '3d'; migration 0039). Older servers omit it. */
  physics?: string;
  /** which renderer it was watched in, or null/absent when unknown */
  view?: string | null;
}

/**
 * Send a finished SOLO PRACTICE run to the account.
 *
 * The one write this module makes — everything else here is a read, because scores and ELO
 * are written only by the authoritative match loop. Practice is the exception BECAUSE it is
 * offline: there is no authoritative loop for the mode, and the run lands in a table no
 * leaderboard can read (see migration 0032). Returns null on any failure; the run is already
 * kept on the device by then (`src/net/practiceRuns.ts`), so a failed upload costs nothing but
 * the copy on the account.
 */
export async function uploadPracticeRun(
  replay: Replay,
  score: number,
  game?: GameId,
): Promise<PracticeRun | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  try {
    /**
     * `view` RIDES THE POST; `physics` DOES NOT, and the asymmetry is the point.
     *
     * The physics is already inside the container (`Replay.physics`, stamped by the recorder),
     * and the server reads it from there — so it cannot be restated here, cannot drift from
     * the log it describes, and cannot be claimed. The VIEW is the one fact the container has
     * no room for, because it is a property of the screen rather than of the simulation: it is
     * read from the device preference the player was actually watching in.
     *
     * An older server ignores the extra key entirely, which is what makes this safe to send
     * unconditionally — one Fly app serves every client version.
     */
    const res = await fetch(`${base}/api/practice?game=${game ?? 'decode'}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ replay, score, view: getViewPref() }),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { run: PracticeRun }).run ?? null;
  } catch {
    return null;
  }
}

/** the signed-in account's own practice runs, newest first. Null when signed out or the
 *  server is unreachable — the caller falls back to what this device has. */
export async function fetchPracticeRuns(game?: GameId): Promise<PracticeRun[] | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  try {
    const res = await fetch(`${base}/api/practice?game=${game ?? 'decode'}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return ((await res.json()) as { runs: PracticeRun[] }).runs ?? [];
  } catch {
    return null;
  }
}

// ---- self-hosted (LAN) matches, own account only ---------------------------

/** one driver in a self-hosted match, by NAME. See migration 0033 for why there are no
 *  user ids here: the reporting server is untrusted, and attributing a match to an account
 *  on its say-so is an impersonation primitive. */
export interface LanParticipant {
  name: string;
  teamName?: string;
  teamNumber?: number;
  alliance: 'red' | 'blue';
  drivetrain?: string;
}

/** one self-hosted match as the cloud stores it */
export interface LanRun {
  id: string;
  matchId: string;
  game: GameId;
  score: { red: number; blue: number };
  participants: LanParticipant[];
  replayId: string | null;
  createdAt: string;
}

/**
 * Send a finished SELF-HOSTED match to the cloud, under the HOST's account.
 *
 * ⚠️ **This goes to `gameServerHttpUrl()`, which is the CLOUD even while
 * `gameServerUrl()` points at the LAN box.** The whole point is that the match was played
 * on a laptop with no database; posting it back there would drop it on the floor. See the
 * note at the top of `env.ts`.
 *
 * Everything in the body is data the cloud does not trust — the score came off a server
 * whose operator could have patched it — and that is survivable only because of where it
 * lands: `lan_runs` is not reachable from `record_leaderboard`, so nothing here can move a
 * board, a PB, a rank or an ELO.
 *
 * THREE OUTCOMES, and the third is the one worth naming. `null` is a failure worth RETRYING
 * — an offline venue, a 503 from a busy server — and the match is already on the device
 * (`src/net/lanRuns.ts`), so it costs a retry rather than the match. `'refused'` is a failure
 * that will never succeed: the cloud answered 409 (another account already filed this match
 * id) or 400 (this body is not one it will take). Retrying either forever would park the
 * backlog on an item that can never drain and block every match behind it, so the caller
 * retires it locally instead.
 */
export async function uploadLanRun(
  matchId: string,
  replay: Replay,
  score: { red: number; blue: number },
  participants: LanParticipant[],
  game?: GameId,
): Promise<LanRun | 'refused' | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  try {
    const res = await fetch(`${base}/api/lan?game=${game ?? 'decode'}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ matchId, replay, score, participants }),
    });
    // 409: the match belongs to another host. 400: this body will never be accepted. Both are
    // permanent verdicts about THIS item; everything else (401 mid-token-refresh, 429, 503,
    // a gateway) is the connection or the moment, and deserves another go later.
    if (res.status === 409 || res.status === 400) return 'refused';
    if (!res.ok) return null;
    return ((await res.json()) as { run: LanRun }).run ?? null;
  } catch {
    return null;
  }
}

/** the signed-in account's own self-hosted matches, newest first. Null when signed out or
 *  the cloud is unreachable — the caller falls back to what this device has. */
export async function fetchLanRuns(game?: GameId): Promise<LanRun[] | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  try {
    const res = await fetch(`${base}/api/lan?game=${game ?? 'decode'}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return ((await res.json()) as { runs: LanRun[] }).runs ?? [];
  } catch {
    return null;
  }
}

// ---- announcements (patch notes / new season / new act) --------------------

export type AnnouncementKind = 'patch' | 'season' | 'act';
export interface Announcement {
  id: string;
  kind: AnnouncementKind;
  title: string;
  /** newline-separated bullet lines (rendered as a list) */
  body: string;
  /** optional headline for the cinematic season/act reveal */
  tagline: string | null;
  publishedAt: string;
}

/** recent active announcements (newest first). Empty when no server/DB. Never
 * throws — the announcements gate is best-effort and must not break the app. */
export async function fetchAnnouncements(limit = 12): Promise<Announcement[]> {
  const base = gameServerHttpUrl();
  if (!base) return [];
  try {
    const res = await fetch(base + `/api/announcements?limit=${limit}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { announcements?: Announcement[] };
    return data.announcements ?? [];
  } catch {
    return [];
  }
}

/** publish an announcement (admin only; server re-authorizes). */
export async function adminPublishAnnouncement(input: {
  kind: AnnouncementKind;
  title: string;
  body: string;
  tagline?: string;
}): Promise<Announcement | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  const res = await fetch(base + '/api/admin/announcement', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { announcement?: Announcement };
  return data.announcement ?? null;
}

/** retire an announcement (soft delete — stops appearing in the feed). */
export async function adminDeleteAnnouncement(id: string): Promise<boolean> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return false;
  const res = await fetch(base + '/api/admin/announcement/delete?id=' + encodeURIComponent(id), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  return res.ok;
}

// ---- seasons ---------------------------------------------------------------

export interface SeasonInfo {
  /** internal balance_version key */
  season: number;
  /** grouping era; 0 = beta/pre-season, then 1-indexed */
  act: number;
  /** 1-indexed ordinal of this season within its act (for display) */
  seasonNo: number;
  /** admin's custom title, or null to use the structured "Act X · Season Y" */
  name: string | null;
  active: boolean;
  startedAt: string;
  records: number;
  matches: number;
}

/** all seasons (newest first) + which one is live, for the board's season picker */
export function fetchSeasons(game?: GameId): Promise<{ current: number; seasons: SeasonInfo[] }> {
  return getJson(`/api/seasons${needsGameParam(game) ? `?game=${game}` : ''}`);
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

/**
 * The operator view of who is on the service right now.
 *
 * Deliberately scoped (server: GET /api/admin/presence). Signed-in accounts carry
 * only state that is already public or already shown to their own friends;
 * anonymous sessions are COUNTS with no identifier; nobody's screen or menu is
 * reported; and there is no history, because the source row is a ~5s snapshot that
 * overwrites itself.
 */
export interface AdminPresencePlayer {
  userId: string;
  /** how many SOCKETS this account holds — one player with two tabs is two
   *  sessions and one account, which is why the tiles need both numbers */
  sessions?: number;
  handle: string | null;
  username: string | null;
  act: 'menu' | 'lobby' | 'match';
  room?: string;
  queue?: '1v1' | '2v2';
  queuedS?: number;
  /** the game they are QUEUED for, which can differ from the one they are in */
  queueGame?: string;
  game?: string;
}
/** ONE anonymous session. `id` is the server's per-socket connection id: not an IP,
 *  not a fingerprint, gone when the socket closes. See 0024_presence_guests.sql. */
export interface AdminPresenceGuest {
  id: string;
  act: 'menu' | 'lobby' | 'match';
  room?: string;
  game?: string;
}
export interface AdminAnonBucket {
  total: number;
  inMatch: number;
  inLobby: number;
  idle: number;
}
export interface AdminMachineRow {
  machine: string;
  region: string;
  online: number;
  updatedAt?: string;
  players: AdminPresencePlayer[];
  guests: AdminPresenceGuest[];
  anon: AdminAnonBucket;
}
export interface AdminPresence {
  region: string;
  machines: AdminMachineRow[];
  local: AdminMachineRow;
  rooms: LiveRoom[];
  queues: Record<string, number>;
}

export interface MaintenanceWindow {
  active: boolean;
  startsAt: number | null;
  endsAt: number | null;
  message: string;
}

export async function adminFetchMaintenance(): Promise<{ maintenance: MaintenanceWindow; biting: boolean } | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  try {
    const res = await fetch(base + '/api/admin/maintenance', {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { ok: boolean; maintenance: MaintenanceWindow; biting: boolean };
    return j.ok ? { maintenance: j.maintenance, biting: j.biting } : null;
  } catch {
    return null;
  }
}

export async function adminSetMaintenance(w: MaintenanceWindow): Promise<boolean> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return false;
  const q = new URLSearchParams({ active: w.active ? '1' : '0', msg: w.message });
  if (w.startsAt) q.set('startsAt', String(w.startsAt));
  if (w.endsAt) q.set('endsAt', String(w.endsAt));
  try {
    const res = await fetch(base + '/api/admin/maintenance?' + q.toString(), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false;
    return ((await res.json()) as { ok: boolean }).ok === true;
  } catch {
    return false;
  }
}

export async function adminFetchPresence(): Promise<AdminPresence | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  try {
    const res = await fetch(base + '/api/admin/presence', {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as AdminPresence;
  } catch {
    return null;
  }
}

/** one finished game in the admin's "Recent games" list. A finished match can't be
 *  spectated, so `replayId` (when the match saved one) is what the row opens. */
export interface AdminMatchRow {
  kind: 'versus' | 'record';
  id: string;
  game: GameId;
  mode: string;
  ranked: boolean | null;
  createdAt: string;
  replayId: string | null;
  balanceVersion: number;
  redScore: number | null;
  blueScore: number | null;
  score: number | null;
  players: { userId: string; handle: string; alliance: 'red' | 'blue' | null }[];
}

/** the most recently finished games service-wide (admin only) */
export async function adminFetchMatches(limit = 40, game?: GameId): Promise<AdminMatchRow[] | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  const qs = new URLSearchParams({ limit: String(limit) });
  if (game) qs.set('game', game);
  try {
    const res = await fetch(`${base}/api/admin/matches?${qs.toString()}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return ((await res.json()) as { matches: AdminMatchRow[] }).matches;
  } catch {
    return null;
  }
}

/** the moderation queue: one row per reported player, most recently reported first */
/** one row of the account-standing ledger, as the server sends it */
export interface StandingEvent {
  id: string;
  kind: string;
  /** SIGNED: positive is points taken, negative is points given back by a moderator's
   *  adjustment. Render it through `standingDelta`, never with a hard-coded minus sign. */
  points: number;
  scoreAfter: number;
  cooldownMin: number;
  ratingCharge: number;
  game: string | null;
  at: string;
  /** set when a moderator pardoned this offence — it no longer counts toward escalation and
   *  no longer costs points, and is shown struck through rather than hidden */
  voidedAt?: string | null;
  /** a moderator's stated reason for a manual adjustment */
  note?: string | null;
}

export interface StandingInfo {
  score: number;
  /** epoch ms the ranked queue reopens, or null */
  restrictedUntil: number | null;
}

/**
 * THIS account's standing and the offences behind it.
 *
 * Self-only by construction — the endpoint takes no user parameter, so there is no version
 * of this call that reads someone else's standing. Null (signed out, no server, no database)
 * simply hides the panel: a player with no account has nothing to be in bad standing about.
 */
export async function fetchStanding(): Promise<{ standing: StandingInfo | null; events: StandingEvent[] }> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return { standing: null, events: [] };
  try {
    const res = await fetch(`${base}/api/standing`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return { standing: null, events: [] };
    const body = (await res.json()) as { standing: StandingInfo | null; events?: StandingEvent[] };
    return { standing: body.standing ?? null, events: body.events ?? [] };
  } catch {
    return { standing: null, events: [] };
  }
}

export async function adminFetchReports(): Promise<ReportedUser[] | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  try {
    const res = await fetch(`${base}/api/admin/reports`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return ((await res.json()) as { users: ReportedUser[] }).users ?? [];
  } catch {
    return null;
  }
}

/** one player's reports AND their recent matches — the drill-down. Both in one request
 *  because a moderator cannot judge a cheating report without watching a match. */
export async function adminFetchReportedUser(userId: string): Promise<{
  reports: ReportRow[];
  matches: ModMatch[];
  standing: StandingInfo | null;
  standingEvents: StandingEvent[];
} | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  try {
    const res = await fetch(`${base}/api/admin/reports?user=${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      reports: ReportRow[]; matches: ModMatch[];
      standing?: StandingInfo | null; standingEvents?: StandingEvent[];
    };
    return { ...body, standing: body.standing ?? null, standingEvents: body.standingEvents ?? [] };
  } catch {
    return null;
  }
}

/** one of a reported player's recent matches, with the replay a moderator watches */
export interface ModMatch {
  matchId: string;
  replayId: string | null;
  game: GameId;
  mode: string;
  ranked: boolean | null;
  createdAt: string;
  score: number;
  won: boolean | null;
}

/** triage every OPEN report against a player */
export async function adminSetReportStatus(
  userId: string,
  status: 'reviewed' | 'dismissed',
): Promise<boolean> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return false;
  try {
    const res = await fetch(
      `${base}/api/admin/reports?user=${encodeURIComponent(userId)}&status=${status}`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` } },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** a MISSCORE claim in the moderation queue */
export interface ScoreReport {
  id: string;
  matchId: string | null;
  /** the match's REPLAY — what the WATCH button opens. A match id is not a replay id, and
   *  passing one where the other belongs is what made every WATCH here 404. */
  replayId: string | null;
  roomCode: string;
  game: string;
  detail: string;
  status: string;
  smite: number;
  createdAt: string;
  reporterId: string;
  reporterHandle: string;
  reporterUsername: string | null;
  /** the filer's own history — how many claims they have ever filed, and how many were
   *  rejected. The pattern is what separates a mistake from a habit before anyone smites. */
  reporterFiled: number;
  reporterRejected: number;
}

export async function adminFetchScoreReports(status = 'open'): Promise<ScoreReport[] | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  try {
    const res = await fetch(`${base}/api/admin/score-reports?status=${encodeURIComponent(status)}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return ((await res.json()) as { reports: ScoreReport[] }).reports ?? [];
  } catch {
    return null;
  }
}

/**
 * Resolve one misscore claim.
 *
 * `smite` is standing points taken off the REPORTER, and the server refuses it on anything
 * but a rejection — upholding a claim means they were right, and charging someone for being
 * right is the failure this whole feature guards against.
 */
export async function adminResolveScoreReport(
  id: string,
  verdict: 'upheld' | 'rejected',
  smite = 0,
): Promise<boolean> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return false;
  const q = new URLSearchParams({ id, verdict, smite: String(Math.max(0, Math.round(smite))) });
  try {
    const res = await fetch(`${base}/api/admin/score-reports?${q.toString()}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** one finished match, as the score editor reads it */
export interface AdminMatch {
  matchId: string;
  replayId: string | null;
  game: string;
  mode: string;
  ranked: boolean | null;
  createdAt: string;
  red: number;
  blue: number;
  participants: {
    userId: string;
    handle: string;
    username: string | null;
    alliance: 'red' | 'blue';
    drivetrain: string;
    score: number;
    won: boolean | null;
    ratingBefore: number | null;
    ratingAfter: number | null;
  }[];
  corrections: {
    id: string;
    adminId: string;
    redBefore: number;
    blueBefore: number;
    redAfter: number;
    blueAfter: number;
    note: string | null;
    at: string;
  }[];
}

/** who played a match, what it scored, and every correction already applied to it */
export async function adminFetchMatch(matchId: string): Promise<AdminMatch | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  try {
    const res = await fetch(`${base}/api/admin/match?id=${encodeURIComponent(matchId)}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return ((await res.json()) as { match: AdminMatch }).match ?? null;
  } catch {
    return null;
  }
}

/**
 * Set a finished match's alliance scores.
 *
 * The win/loss flag is re-derived by the server from the new numbers; the RATINGS are not
 * touched, because Glicko-2 is sequential and re-rating one match in the middle means
 * re-rating every match since. Returns the before/after pair, or null if it did not land.
 */
export async function adminCorrectMatchScore(
  matchId: string,
  red: number,
  blue: number,
  note?: string,
): Promise<{ redBefore: number; blueBefore: number; redAfter: number; blueAfter: number } | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  const q = new URLSearchParams({
    id: matchId,
    red: String(Math.max(0, Math.round(red))),
    blue: String(Math.max(0, Math.round(blue))),
  });
  if (note) q.set('note', note);
  try {
    const res = await fetch(`${base}/api/admin/match?${q.toString()}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as { redBefore: number; blueBefore: number; redAfter: number; blueAfter: number };
  } catch {
    return null;
  }
}

/** one account's standing as a MODERATOR reads it — the same ledger the player sees, plus
 *  the name, so the console never shows a bare uuid next to a punishment */
export interface AdminStanding {
  userId: string;
  handle: string | null;
  username: string | null;
  standing: StandingInfo | null;
  events: StandingEvent[];
}

export async function adminFetchStanding(userId: string): Promise<AdminStanding | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  try {
    const res = await fetch(`${base}/api/admin/standing?user=${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as AdminStanding;
  } catch {
    return null;
  }
}

/**
 * Edit one account's standing.
 *
 * Every field is OPTIONAL and an absent one changes nothing — `lock` especially: leaving it
 * out keeps a cooldown somebody is legitimately serving, `false` lifts it, a number sets one
 * that many minutes out. A pardon VOIDS the offences rather than deleting them, so escalation
 * forgets them while the record does not.
 */
export async function adminEditStanding(
  userId: string,
  opts: { score?: number; pardonAll?: boolean; pardonIds?: string[]; lock?: false | number; note?: string },
): Promise<{ scoreBefore: number; scoreAfter: number; pardoned: number } | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  const q = new URLSearchParams({ user: userId });
  if (opts.score !== undefined) q.set('score', String(Math.round(opts.score)));
  if (opts.pardonAll) q.set('pardon', 'all');
  else if (opts.pardonIds?.length) q.set('pardon', opts.pardonIds.join(','));
  if (opts.lock === false) q.set('lock', 'clear');
  else if (typeof opts.lock === 'number') q.set('lock', String(Math.max(0, Math.round(opts.lock))));
  if (opts.note) q.set('note', opts.note);
  try {
    const res = await fetch(`${base}/api/admin/standing?${q.toString()}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as { scoreBefore: number; scoreAfter: number; pardoned: number };
  } catch {
    return null;
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

/** archive the live boards and open a fresh period; `newAct` opens a new ACT
 * (else a new season in the current act). Returns the new balance_version. */
export async function adminStartSeason(
  name?: string,
  opts?: { newAct?: boolean },
): Promise<number | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  const params = new URLSearchParams();
  if (name && name.trim()) params.set('name', name.trim());
  if (opts?.newAct) params.set('act', 'new');
  const qs = params.toString() ? `?${params.toString()}` : '';
  const res = await fetch(base + '/api/admin/season/start' + qs, {
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

/** one row of the admin user search — now also the supporter console */
export interface AdminUserRow {
  userId: string;
  handle: string;
  username?: string | null;
  /** a PAID membership. Deliberately not the entitled-or-staff predicate the rest
   *  of the app uses: this row is where an admin decides whether to grant months,
   *  and a colleague showing as a supporter with no expiry would mislead exactly
   *  there. Staff are identified by `role` instead. */
  supporter?: boolean;
  supporterUntil?: string | null;
  /** a Ko-fi payer address is linked, so this account renews automatically */
  autoRenews?: boolean;
  role?: StaffRole | null;
}

/** search profiles by handle (substring), exact userId, or exact username */
export async function adminSearchUsers(query: string): Promise<AdminUserRow[]> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token || !query.trim()) return [];
  const res = await fetch(base + '/api/admin/users?q=' + encodeURIComponent(query.trim()), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = (await res.json().catch(() => ({}))) as { users?: AdminUserRow[] };
  return data.users ?? [];
}

/** POST to an admin route with the signed-in token; null when not authorized */
async function adminPost<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  const res = await fetch(base + path + '?' + new URLSearchParams(params).toString(), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as T | null;
}

/** comp a supporter membership (contributor, botched payment, goodwill) */
export function adminGrantSupporter(
  userId: string,
  months: number,
  note = '',
): Promise<{ until: string | null } | null> {
  return adminPost('/api/admin/supporter/grant', { userId, months: String(months), note });
}

/** end a membership now — chargeback, refund, or a comp given in error */
export function adminRevokeSupporter(
  userId: string,
  note = '',
): Promise<{ revoked: boolean } | null> {
  return adminPost('/api/admin/supporter/revoke', { userId, note });
}

/** flag a Ko-fi payment as charged back. Does NOT revoke — that is a second,
 *  deliberate decision, because the membership may cover other payments too. */
export function adminRefundPayment(txn: string): Promise<{ ok: boolean } | null> {
  return adminPost('/api/admin/supporter/refund', { txn });
}

export interface SupporterGrantRow {
  source: 'kofi' | 'admin' | 'revoke';
  months: number;
  until: string | null;
  note: string | null;
  createdAt: string;
}

/** why does this account have a membership? (audit trail, newest first) */
export async function adminSupporterHistory(userId: string): Promise<SupporterGrantRow[]> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return [];
  const res = await fetch(
    base + '/api/admin/supporter/history?userId=' + encodeURIComponent(userId),
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return [];
  const data = (await res.json().catch(() => ({}))) as { grants?: SupporterGrantRow[] };
  return data.grants ?? [];
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

// ---- friends ---------------------------------------------------------------

/** a friend's presence, as resolved BY THE SERVER. `online` already accounts for
 * an 'invisible' friend (they arrive as a plain offline row with no last-seen),
 * so there is no client-side filtering to forget. */
/** what a friend is doing right now, for a chess.com-style activity line. Only
 * meaningful while `online`; null otherwise. */
export type Activity = 'menu' | 'lobby' | 'match';

export interface FriendRow extends BadgeFields {
  userId: string;
  handle: string;
  username: string | null;
  online: boolean;
  /** 'dnd' shows a red dot; null = plain */
  status: 'dnd' | null;
  /** coarse seconds since last seen — null when online or never seen. Already
   * rounded server-side to the buckets the UI renders. */
  offlineSeconds: number | null;
  /** 'menu' | 'lobby' | 'match' while online; null when offline/invisible/unknown */
  activity: Activity | null;
  /** which game the friend is in — only set alongside `activity` */
  game: GameId | null;
  /**
   * The match to SPECTATE, when this friend is in one that is actually running.
   *
   * Absent in a lobby, absent once the match ends, and absent for an invisible
   * friend. `region` is required to open the spectate socket — a custom room's
   * code carries no region of its own. Optional on the wire: a server older than
   * this feature simply never sends it and no Watch button appears.
   */
  watch?: { room: string; region: string; ranked: boolean };
}

export type PresenceStatus = 'online' | 'dnd' | 'invisible';

/** a "come join my room" invite from a friend, addressed to the caller. Carries
 * everything `Lobby`'s `join()`/`config` need to auto-join, same shape as a
 * manually-typed room code + the room's `RoomConfig`. */
export interface RoomInvite {
  id: string;
  from: PublicProfile;
  /** the room code to join — EXCEPT for a rated format, where there is no room to
   * join and this is the party token both sides hand the matchmaker instead */
  room: string;
  game: GameId;
  kind: 'versus' | 'record';
  record: 'solo' | 'duo' | null;
  /** what was offered (see ChallengeFormat). Null on challenges sent by a client
   * older than formats — read as the historical casual-versus meaning. */
  format: string | null;
  /**
   * WHICH MACHINE the room is on — the sender's region.
   *
   * One app runs in several regions and a custom room code is BARE: unlike a
   * matchmaker-staged `iad-abc123`, there is nothing in it for the proxy to route on. So a
   * recipient who connects without this lands on whichever machine is nearest to THEM, and
   * if the two players picked different servers they each end up alone in a different room
   * that happens to share a code. Null ⇒ an older sender; the client falls back to its own
   * region, which is the behaviour that produced the split in the first place.
   */
  region?: string | null;
  createdAt: string;
}

/** a challenge the CALLER sent, as they see it: the other party is the recipient,
 * and `declined` is the answer they've been waiting for. */
export interface SentInvite extends Omit<RoomInvite, 'from'> {
  to: PublicProfile;
  declined: boolean;
}

export interface FriendsPayload {
  friends: FriendRow[];
  incoming: PublicProfile[];
  outgoing: PublicProfile[];
  blocked: PublicProfile[];
  invites: RoomInvite[];
  /** challenges the caller SENT and that are still live. Absent from an older
   * server, so every consumer must tolerate undefined. */
  sent?: SentInvite[];
  /** the caller's own self-set status (null = automatic) */
  status: PresenceStatus | null;
}

/** thrown when the server is reachable but has no friends API — an older build
 * than the client (one Fly app serves every client version). The panel renders
 * an "unavailable" state for this rather than an error. */
export class FriendsUnavailableError extends Error {
  constructor() {
    super('friends unavailable');
    this.name = 'FriendsUnavailableError';
  }
}

/**
 * Authenticated JSON call. `getJson` above is the PUBLIC reader — it sends no
 * Authorization header, so a friends read through it would just 401. Everything
 * here needs the Bearer token, hence the separate helper rather than repeating
 * the token dance nine times.
 */
async function authedJson<T>(path: string, init?: RequestInit): Promise<T> {
  const base = gameServerHttpUrl();
  if (!base) throw new FriendsUnavailableError();

  const send = async (force: boolean): Promise<Response> => {
    const token = await getAuthToken(force);
    if (!token) throw new Error('Please sign in again.');
    return fetch(base + path, {
      ...init,
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${token}`,
        ...init?.headers,
      },
    });
  };

  // The token is cached in memory until it nears expiry (see getAuthToken), which
  // is what keeps a polling client off Neon Auth — and therefore off the database
  // it reads. The one case a cache can't predict is a session revoked server-side:
  // the token is still unexpired but no longer accepted. A 401 is exactly that
  // signal, so retry ONCE with a forced refresh before surfacing an error. Only
  // once, so a genuinely signed-out client fails fast instead of looping.
  let res = await send(false);
  if (res.status === 401) res = await send(true);

  // 404 = this server predates the friends API. Distinguished from other errors
  // so the caller can degrade instead of showing a failure.
  if (res.status === 404 && !init?.method) throw new FriendsUnavailableError();
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}`);
  return data as T;
}

/** the caller's friends, requests and blocks. This request also records the
 * caller's own presence server-side — there is no separate ping — including WHAT
 * the caller is doing (`activity`) + which game, so friends see a live activity
 * line. Both are optional; an old server ignores the query params. */
export function fetchFriends(activity?: Activity, game?: GameId): Promise<FriendsPayload> {
  const qs = new URLSearchParams();
  if (activity) qs.set('a', activity);
  if (game) qs.set('g', game);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return authedJson<FriendsPayload>('/api/friends' + suffix);
}

const friendPost = (path: string, username: string): Promise<{ ok?: boolean; outcome?: string }> =>
  authedJson(`/api/friends/${path}`, { method: 'POST', body: JSON.stringify({ username }) });

/** send a request. Resolves to 'accepted' when the target had already sent one
 * to the caller (the server turns that into an immediate friendship). */
export async function sendFriendRequest(username: string): Promise<'sent' | 'accepted'> {
  const r = await friendPost('request', username);
  return r.outcome === 'accepted' ? 'accepted' : 'sent';
}

export const acceptFriendRequest = (username: string) => friendPost('accept', username);
export const declineFriendRequest = (username: string) => friendPost('decline', username);
export const cancelFriendRequest = (username: string) => friendPost('cancel', username);
export const removeFriend = (username: string) => friendPost('remove', username);
export const blockUser = (username: string) => friendPost('block', username);
export const unblockUser = (username: string) => friendPost('unblock', username);

/** set your own presence status (null = automatic) */
export function setPresenceStatus(status: PresenceStatus | null): Promise<unknown> {
  return authedJson('/api/friends/status', {
    method: 'POST',
    body: JSON.stringify({ status }),
  });
}

/** invite a friend to a room by code — must already be friends (server-checked,
 * same as every other friends mutation). `record` only applies when
 * `kind === 'record'`. */
export function inviteToRoom(
  username: string,
  room: string,
  game: GameId,
  kind: 'versus' | 'record',
  record?: 'solo' | 'duo' | null,
  format?: string | null,
  /** the region the sender will HOST the room in — see `RoomInvite.region` */
  region?: string | null,
): Promise<unknown> {
  return authedJson('/api/friends/invite', {
    method: 'POST',
    body: JSON.stringify({
      username, room, game, kind,
      record: record ?? null, format: format ?? null, region: region ?? null,
    }),
  });
}

/** dismiss (or consume, on join) an invite addressed to the caller */
export function dismissRoomInvite(id: string): Promise<unknown> {
  return authedJson('/api/friends/invite/dismiss', {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
}

/** DECLINE a challenge sent to me. Unlike dismiss, the sender is told: the row is
 * marked rather than deleted so their client can say "@you declined" once. */
export function declineRoomInvite(id: string): Promise<unknown> {
  return authedJson('/api/friends/invite/decline', {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
}

/** withdraw a challenge I sent (or clear one I've been told was declined) */
export function cancelRoomInvite(id: string): Promise<unknown> {
  return authedJson('/api/friends/invite/cancel', {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
}

/** public player search — matches the @username or the DISPLAY NAME (min 2 chars).
 *  Feeds both the Records look-up bar and the add-a-friend box. */
export async function searchUsers(query: string): Promise<PublicProfile[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  try {
    const r = await getJson<{ users: PublicProfile[] }>(
      `/api/users/search?q=${encodeURIComponent(q)}`,
    );
    return r.users ?? [];
  } catch {
    return []; // server asleep or older than this client — no results, not an error
  }
}

/** the supporter tier's price, as the SERVER charges it (server/kofi.ts). Read
 *  from the server rather than hardcoded in the UI so the number on the Donate
 *  page can never drift from the number the grant policy actually enforces. */
export interface TierPrice {
  amount: number;
  /** ISO 4217, e.g. 'USD' */
  currency: string;
}

/** an account's paid entitlements. Extend the shape (never replace it) as tiers grow. */
export interface Entitlements {
  /** an active supporter membership — removes ads, unlocks cosmetic perks */
  supporter: boolean;
  /** ISO instant the membership lapses, or null if not a supporter — and always
   *  null for staff, who are entitled by role rather than by a purchase */
  supporterUntil: string | null;
  /** 'owner' | 'admin'. Staff get the supporter perks without paying, so
   *  `supporter` is true while `supporterUntil` stays null; this is what lets the
   *  UI say "included with your role" instead of rendering a lapsed membership. */
  role?: StaffRole;
  /** a Ko-fi payer address is linked, so payments renew with no manual claim */
  autoRenews: boolean;
  /** absent when talking to a server older than the pricing route */
  price?: TierPrice;
  /**
   * The revision of the Terms of Use this account has accepted — the key
   * `src/legalText.ts` derives from `LEGAL_UPDATED` (migration 0040).
   *
   * THREE-VALUED, and every value means something different to `termsGateState`:
   * a STRING is what was accepted, `null` is "never asked", and `undefined` is "this
   * server did not say" — which is what a server older than the route answers, and
   * what `fetchEntitlements` falls back to when it swallows a failure. Only the
   * first two may put a dialog in front of anybody.
   */
  termsVersion?: string | null;
}

const NO_ENTITLEMENTS: Entitlements = {
  supporter: false,
  supporterUntil: null,
  autoRenews: false,
};

/**
 * The caller's entitlements. NEVER throws — an ad gate that fails loudly would
 * break the menu for a signed-out player, and a server older than this client
 * (the one Fly app serves every client version) simply 404s this route. Both
 * degrade to "not a supporter", which shows ads; the server independently
 * enforces every perk, so a wrong answer here costs nothing but a few pixels.
 */
export async function fetchEntitlements(): Promise<Entitlements> {
  try {
    const r = await authedJson<Partial<Entitlements>>('/api/user/entitlements');
    return {
      supporter: !!r.supporter,
      supporterUntil: r.supporterUntil ?? null,
      role: r.role === 'owner' || r.role === 'admin' ? r.role : undefined,
      autoRenews: !!r.autoRenews,
      price: r.price,
      // PASSED THROUGH UNTOUCHED, including `undefined`. Coercing it to null here
      // would turn "this server never told us" into "never accepted" and show a
      // blocking dialog to everybody on a stale server.
      termsVersion: r.termsVersion,
    };
  } catch {
    return NO_ENTITLEMENTS;
  }
}

/**
 * Accept the current Terms of Use, for the signed-in account.
 *
 * ⚠️ IT SENDS NO VERSION. The server records its OWN `LEGAL_VERSION`, so a client
 * cannot accept a revision that does not exist or pre-accept the next one to escape
 * the gate for good. The answer is the version that was actually written, which is
 * what the gate then compares.
 *
 * Unlike `fetchEntitlements` this DOES throw: somebody is waiting on a button, and a
 * silent failure would leave a dialog that closes and comes straight back.
 */
export async function acceptTerms(): Promise<{ termsVersion: string | null }> {
  const r = await authedJson<{ termsVersion?: string | null }>('/api/user/accept-terms', {
    method: 'POST',
  });
  return { termsVersion: r.termsVersion ?? null };
}

/** the tier price for a SIGNED-OUT visitor. Same never-throws contract: the
 *  Donate page falls back to "see Ko-fi for the price" rather than breaking. */
export async function fetchPricing(): Promise<TierPrice | null> {
  try {
    const base = gameServerHttpUrl();
    if (!base) return null;
    const res = await fetch(base + '/api/pricing');
    if (!res.ok) return null;
    const data = (await res.json()) as { price?: TierPrice };
    return data.price && typeof data.price.amount === 'number' ? data.price : null;
  } catch {
    return null;
  }
}

/**
 * Delete the signed-in account and everything DSIM stores about it.
 *
 * Irreversible, so the server demands the literal string `DELETE` in the body —
 * a value no accidental or replayed request carries. Throws on failure: someone
 * who asked for deletion must never be told "done" when it was not.
 */
export async function deleteMyAccount(): Promise<boolean> {
  const r = await authedJson<{ deleted?: boolean }>('/api/user/delete', {
    method: 'POST',
    body: JSON.stringify({ confirm: 'DELETE' }),
  });
  return !!r.deleted;
}

/**
 * Attach a Ko-fi payment to the signed-in account by its transaction id.
 *
 * Unlike `fetchEntitlements` this DOES throw — the user is actively waiting on
 * the result of a payment they made, and silently swallowing "already claimed"
 * or "not found" would leave them staring at a page that never changes. The
 * caller shows the message.
 */
export async function claimKofiPayment(
  transactionId: string,
): Promise<{ ok: boolean; supporterUntil: string | null; months: number }> {
  const r = await authedJson<{ ok?: boolean; supporterUntil?: string | null; months?: number }>(
    '/api/user/claim-kofi',
    { method: 'POST', body: JSON.stringify({ transactionId }) },
  );
  return { ok: !!r.ok, supporterUntil: r.supporterUntil ?? null, months: r.months ?? 0 };
}
