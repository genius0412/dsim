import type { Replay } from '../sim/replay';
import type { AwardRow } from '../awards';
import type { EquippedBadge } from '../badges';
import type { RewardGrant } from '../rewards';
import type { AccessGroup, BannerKind, LiveRoom, LockdownScope, SiteBanner, StaffRole } from './protocol';
import type { ReportedUser, ReportRow } from '../report';
import type { AssistConfig, GameId, RobotSpec } from '../types';
import { gameServerHttpUrl, setLanFromServer } from './env';
import { getAuthToken } from '../lib/authClient';
import { DISCORD_REGION } from './discordActivity';
// the per-DEVICE view preference (localStorage, never `GameSettings`) — the one thing a
// practice upload can say that the replay container structurally cannot. It is a leaf module
// with no React and no DOM beyond `localStorage`, guarded against storage being unavailable.
import { getViewPref } from '../games/biobuzz/graphics/store';
import { setPracticeUploadBlocked } from './practiceRuns';

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
  /**
   * the EQUIPPED BADGES and their counters, `[{id, n}]` (0048). Rides `badgeCols` beside the
   * two above for the same reason — every surface that prints a name draws it, and writing the
   * column out by hand per query is how a board ends up quietly missing it. Absent from an older server;
   * read through `coerceEquippedBadges`, which drops anything this build does not know.
   */
  badges?: EquippedBadge[] | null;
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
  /** ...and the partner's worn badges. */
  partnerBadges?: EquippedBadge[] | null;
  score: number;
  replayId: string | null;
  createdAt: string;
  config: RecordConfig | null;
  /**
   * WHICH SOLVE PRODUCED THIS RUN — `'2d'` | `'3d'` (migration 0039). Absent from an older
   * server's response, and a pre-0039 row reads `'2d'`.
   *
   * No longer shown as a chip (every row on the board is 3D now). It is still projected, and
   * `Leaderboard` still reads it, for exactly one job: dropping a `'2d'` row served by a deploy
   * that predates the ruling. Absent is kept rather than dropped — absent means "this server
   * never told us", not "2D".
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
export type Board = 'mecanum' | 'tank' | 'swerve' | 'xdrive' | 'butterfly' | 'overall';

async function getJson<T>(path: string): Promise<T> {
  const base = gameServerHttpUrl();
  if (!base) throw new Error('Leaderboards need the game server, and this build has none.');
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
  if (!base) throw new Error('Leaderboards need the game server, and this build has none.');
  const token = await getAuthToken().catch(() => null);
  let res = await fetch(base + path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  // A signed-in player whose token could not be read, or was stale, is refused as a stranger,
  // and their OWN match then reads as "private". Ask once more with a freshly fetched token.
  if (res.status === 403) {
    const fresh = await getAuthToken(true).catch(() => null);
    if (fresh && fresh !== token) {
      res = await fetch(base + path, { headers: { authorization: `Bearer ${fresh}` } });
    }
  }
  if (res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ReplayPrivateError(body.message ?? 'This replay is private.');
  }
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return (await res.json()) as T;
}

/**
 * The record board. NO ERA ARGUMENT (owner ruling, 2026-09-18): the server decides which solve
 * this board is made of, because a board it could be asked for is a board two callers can
 * disagree about. The `physics` query parameter the Day 3 filter used is gone from here; a
 * current server ignores it if an older client still sends one, and `Leaderboard` filters an
 * OLDER server's mixed response client-side.
 */
export function fetchRecords(
  mode: RecordMode,
  drivetrain: Board,
  season?: number,
  game?: GameId,
): Promise<{ rows: RecordRow[]; physics?: string }> {
  const s = season != null ? `&season=${season}` : '';
  return getJson(`/api/records?mode=${mode}&drivetrain=${drivetrain}${s}${gameParam(game)}`);
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
  /** every SEASON AWARD this account holds — account-wide, never season-scoped, or a
   *  trophy case would empty itself the moment a new season opened. */
  awards?: AwardRow[];
  /** the worn badges and their counters (0048). */
  badges?: EquippedBadge[] | null;
  /** every badge the account holds and how many times — the trophy case (0048). */
  badgeCounts?: Record<string, number>;
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
  /** total games played — COMBINED across every game and source (the homepage headline) */
  games: number;
  /** solo = record solo + practice · duo = record duo · 1v1 / 2v2 = ranked ·
   * custom = custom rooms + Discord rooms + LAN. `custom` is absent from older servers,
   * which also counted custom rooms inside 1v1 / 2v2. */
  byCategory: { solo: number; duo: number; '1v1': number; '2v2': number; custom?: number };
  /** games played PER GAME. Absent from older servers. */
  byGame?: Partial<Record<GameId, number>>;
}

/** site-wide totals for the homepage (players + games played, by category) */
export function fetchGlobalStats(): Promise<GlobalStats> {
  return getJson(`/api/stats`);
}

/**
 * Count one match the cloud did not run: a finished solo PRACTICE run, or a LAN match (its
 * host sends it; nobody else does). Server rooms count themselves. Fire-and-forget: offline,
 * no game server, or an older server that 404s all cost nothing.
 *
 * `text/plain` so the POST is a simple request with no CORS preflight, and `keepalive` so a
 * practice run harvested while the page unloads still gets its report out.
 */
export function reportPlayed(game: GameId, source: 'practice' | 'lan', mode?: '1v1' | '2v2'): void {
  const base = gameServerHttpUrl();
  if (!base) return;
  try {
    void fetch(`${base}/api/played`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ game, source, mode }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* fetch unavailable — nothing to count with */
  }
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
  /** SEATS taken, bots included — a bot is a seat, and the browser must not offer one that
   * is not there. Older servers send sockets only; the difference is a bot-filled room. */
  players: number;
  capacity: number;
  kind: 'versus' | 'record';
  game: GameId;
  /** can a new driver actually walk in? Absent from an older server ⇒ treat as true, which
   * is what that server meant: it only ever listed joinable rooms. */
  joinable?: boolean;
  /** why not, when it is not. Absent ⇒ unknown, render it as a plain lobby. */
  state?: 'lobby' | 'strategy' | 'match' | 'full';
}

/**
 * OPEN lobbies for a Discord Activity, scoped by its `group` (the activity instance
 * id). Powers the in-activity lobby browser so more than one game can run at once.
 * Empty for an unknown/empty group — this never lists the global custom-room set.
 * In-activity `getJson` rides the same `/gs` proxy origin as every other read.
 */
export async function fetchLobbies(group: string): Promise<DiscordLobby[] | null> {
  if (!group) return [];
  try {
    // PIN to the fixed activity region (same as the socket): the read is anycast,
    // so without it an EU player would hit the EU machine and never see the US
    // player's room. The server fly-replays this GET to DISCORD_REGION.
    const q = `group=${encodeURIComponent(group)}&region=${encodeURIComponent(DISCORD_REGION)}`;
    const r = await getJson<{ lobbies: DiscordLobby[] }>(`/api/lobbies?${q}`);
    return r.lobbies ?? [];
  } catch {
    /**
     * ⚠️ NULL, NOT `[]`. A failed read and an empty activity are different facts, and
     * returning `[]` for both let one dropped poll overwrite a good list with "nobody has
     * opened the main lobby yet" — the browser had no error branch and no stale retention,
     * unlike every other poller in this app. The caller keeps its last good list.
     */
    return null;
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
    /** 'matches' | 'site' (0051); absent from an older server, which only had matches */
    scope?: string;
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
export function fetchUserStatsByUsername(username: string, season?: number, game?: GameId): Promise<UserStats> {
  const p = new URLSearchParams();
  if (season != null) p.set('season', String(season));
  if (needsGameParam(game)) p.set('game', game as GameId);
  const qs = p.toString();
  return getJson(`/api/profile/${encodeURIComponent(username)}/stats${qs ? `?${qs}` : ''}`);
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
  if (!base) throw new Error('Setting a username needs the game server, and this build has none.');
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
  if (!base) throw new Error('Changing your name needs the game server, and this build has none.');
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
/** the providers a DSIM account can link. */
export type LinkProvider = 'github' | 'discord';

/** which providers this server has credentials for, and which you have linked. */
export function fetchLinks(): Promise<{ linked: LinkProvider[]; available: LinkProvider[] }> {
  return authedJson('/api/user/links');
}

/**
 * Ask for the authorize URL. ⚠️ The browser is then SENT there — the client never learns or
 * asserts the external account id; the server reads it from the provider over the back
 * channel (`server/oauthLink.ts`), because a self-declared link is forgeable.
 */
export function startLink(provider: LinkProvider): Promise<{ url: string }> {
  return authedJson(`/api/link/${provider}/start`);
}

/** disconnect. For GitHub the server also takes the star badge and decal back. */
export function unlinkProvider(provider: LinkProvider): Promise<{ unlinked: boolean }> {
  return authedJson(`/api/link/${provider}/unlink`, { method: 'POST' });
}

/**
 * THE REWARD LEDGER (0048) — everything the claim dialog and the appearance page read, in one
 * request: pending grants, badge counts, what is worn, and the trophy case.
 *
 * The server still sends `title: null` and `earnedTitles: []` so a client from before titles
 * folded into badges (0049) does not break; this build reads neither.
 *
 * An older server has no such route and answers 404, which `authedJson` raises as
 * `FriendsUnavailableError` — the caller reads that as "nothing pending", which is true.
 */
export interface RewardStateDto {
  pending: RewardGrant[];
  badges: Record<string, number>;
  equippedBadges: EquippedBadge[];
  /** the trophy case — each placement with its act and season. Absent from a server that
   *  predates the field. */
  awards?: AwardRow[];
}

/**
 * A `window` event saying the account's unlocks changed (a claim delivered a cosmetic). The
 * entitlement provider re-reads `/api/user/entitlements` on it, so the robot builder unlocks
 * the swatch without a reload. An event rather than an import, because `src/ads/` must not
 * depend on the reward UI.
 */
export const ENTITLEMENTS_CHANGED = 'dsim:entitlements';

export function fetchRewards(): Promise<RewardStateDto> {
  return authedJson('/api/user/rewards');
}

/** CLAIM one grant, and with `equip` wear it. Answers the account's whole reward state after. */
export function claimReward(id: string, equip: boolean): Promise<RewardStateDto> {
  return authedJson('/api/user/rewards/claim', {
    method: 'POST',
    body: JSON.stringify({ id, equip }),
  });
}

/** WEAR these badges, in this order. The server re-validates against what is held. */
export function saveBadges(badges: string[]): Promise<{ equippedBadges: EquippedBadge[] }> {
  return authedJson('/api/user/badges', {
    method: 'POST',
    body: JSON.stringify({ badges }),
  });
}

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
    if (!res.ok) {
      // the one refusal the player can fix: say so on Practice replays (`practiceRuns.ts`)
      if (res.status === 403) {
        const body = (await res.json().catch(() => null)) as { code?: string } | null;
        if (body?.code === 'email_unverified') setPracticeUploadBlocked(true);
      }
      return null;
    }
    setPracticeUploadBlocked(false);
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
  /** owner/admin, so the console can tell a colleague's session from a player's */
  role?: 'owner' | 'admin' | null;
  /**
   * A `profiles` row EXISTS for this account.
   *
   * ⚠️ `handle: null` means two completely different things and the console printed
   * both as "(no profile)". The row is created lazily — `ensureProfile` runs on the
   * API routes a signed-in client hits, not when its socket authenticates — so an
   * account can genuinely have auth and no profile for a few seconds after signing
   * up. That is `known: false`, and it renders as the account id plus "no username
   * yet". `known: true` with a null handle would be a bug worth seeing.
   *
   * OPTIONAL because a server older than this field does not send it, and the
   * client's own merge fills the names in from the database row in that case.
   */
  known?: boolean;
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
  /** 0051. Absent from an older server's answer, which means `matches` and no bypass. */
  scope?: LockdownScope;
  redirectUrl?: string | null;
  redirectLabel?: string | null;
  bypass?: AccessGroup[];
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
  // the 0051 fields; an older server ignores them and applies a matches lockdown
  if (w.scope) q.set('scope', w.scope);
  if (w.redirectUrl) q.set('redirect', w.redirectUrl);
  if (w.redirectLabel) q.set('redirectLabel', w.redirectLabel);
  if (w.bypass?.length) q.set('bypass', w.bypass.join(','));
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

// ---- access groups (0051) and site banners (0052) ---------------------------

export interface AccessMemberRow {
  userId: string;
  group: AccessGroup;
  handle: string | null;
  username: string | null;
  grantedBy: string;
  grantedAt: string;
  note: string;
}
export interface AccessGrantResult {
  tag: string;
  ok: boolean;
  userId?: string;
  handle?: string;
  username?: string | null;
  added?: boolean;
  error?: string;
}

/** one authenticated admin call; `{ ok: false, error }` for every failure, never a throw */
async function adminCall<T extends object>(
  path: string,
  init: { method?: 'GET' | 'POST'; body?: string } = {},
): Promise<(T & { ok: true }) | { ok: false; error: string }> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return { ok: false, error: 'Sign in with an admin account.' };
  try {
    const res = await fetch(base + path, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'text/plain' } : {}) },
      body: init.body,
      cache: 'no-store',
    });
    if (res.status === 404 && !res.headers.get('content-type')?.includes('json')) {
      return { ok: false, error: 'This server predates this feature.' };
    }
    const j = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: string }) | null;
    if (!j) return { ok: false, error: `Server returned ${res.status}.` };
    if (j.ok === false || !res.ok) return { ok: false, error: j.error ?? `Server returned ${res.status}.` };
    return { ...j, ok: true };
  } catch {
    return { ok: false, error: 'Couldn’t reach the server.' };
  }
}

export const adminFetchAccess = (group?: AccessGroup) =>
  adminCall<{ members: AccessMemberRow[] }>(`/api/admin/access${group ? `?group=${group}` : ''}`);

export const adminGrantAccess = (group: AccessGroup, tag: string, note = '') =>
  adminCall<AccessGrantResult>(
    '/api/admin/access?' + new URLSearchParams({ action: 'grant', group, tag, note }).toString(),
    { method: 'POST' },
  );

export const adminBulkGrantAccess = (group: AccessGroup, tags: string, note = '') =>
  adminCall<{ results: AccessGrantResult[] }>(
    '/api/admin/access?' + new URLSearchParams({ action: 'bulk', group, note }).toString(),
    { method: 'POST', body: tags },
  );

export const adminRevokeAccess = (group: AccessGroup, userId: string) =>
  adminCall<{ removed: boolean }>(
    '/api/admin/access?' + new URLSearchParams({ action: 'revoke', group, userId }).toString(),
    { method: 'POST' },
  );

export interface AdminBannerRow extends SiteBanner {
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}
export interface BannerDraft {
  kind: Exclude<BannerKind, 'restart'>;
  message: string;
  startsAt: number | null;
  endsAt: number | null;
  game: string | null;
  channel: string | null;
}

export const adminFetchBanners = () => adminCall<{ banners: AdminBannerRow[] }>('/api/admin/banners');

export function adminSaveBanner(draft: BannerDraft, id?: number) {
  const q = new URLSearchParams({ action: id ? 'update' : 'create', kind: draft.kind, msg: draft.message });
  if (id) q.set('id', String(id));
  if (draft.startsAt) q.set('startsAt', String(draft.startsAt));
  if (draft.endsAt) q.set('endsAt', String(draft.endsAt));
  if (draft.game) q.set('game', draft.game);
  if (draft.channel) q.set('channel', draft.channel);
  return adminCall<{ banner: AdminBannerRow }>('/api/admin/banners?' + q.toString(), { method: 'POST' });
}

export const adminEndBanner = (id: number) =>
  adminCall<{ done: boolean }>(`/api/admin/banners?action=end&id=${id}`, { method: 'POST' });
export const adminDeleteBanner = (id: number) =>
  adminCall<{ done: boolean }>(`/api/admin/banners?action=delete&id=${id}`, { method: 'POST' });

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
  game: GameId,
  limit = 100,
): Promise<AdminRecordRow[]> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return [];
  const q = new URLSearchParams({ mode, drivetrain, game, limit: String(limit) });
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

/**
 * Search profiles by handle (substring), exact userId, or exact username.
 *
 * PAGED. `more` says there is at least one row past this page, which the server answers by
 * fetching one extra rather than by counting — a count over a `ilike '%…%'` is the same scan
 * twice. An older server sends no `more` field and the page simply never offers "load more".
 */
export async function adminSearchUsers(
  query: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ users: AdminUserRow[]; more: boolean }> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token || !query.trim()) return { users: [], more: false };
  const q = new URLSearchParams({ q: query.trim() });
  if (opts.limit) q.set('limit', String(opts.limit));
  if (opts.offset) q.set('offset', String(opts.offset));
  const res = await fetch(base + '/api/admin/users?' + q.toString(), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { users: [], more: false };
  const data = (await res.json().catch(() => ({}))) as { users?: AdminUserRow[]; more?: boolean };
  return { users: data.users ?? [], more: data.more === true };
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

/**
 * Take an abusive @username away. Returns the one that was cleared, `''` when there was none.
 *
 * CLEARED, NOT REPLACED — the account goes back through the username gate, which already
 * validates format, uniqueness and content. `adminRenameUser` above is the DISPLAY name, which
 * its owner can change straight back; this is the permanent public one, which they cannot.
 */
export async function adminClearUsername(
  userId: string,
  note = '',
): Promise<{ cleared: string | null } | null> {
  return adminPost('/api/admin/user/username', { userId, note });
}

/** the shape both suspension calls answer with. `until` is ms epoch, null ⇒ not suspended. */
export interface AdminSuspension {
  until: number | null;
  reason: string | null;
}

/**
 * Suspend an account from online play for `days`, or lift it.
 *
 * The reason IS SHOWN TO THE PLAYER at the door — anything they should not read belongs in a
 * private note instead.
 */
export function adminSuspendUser(
  userId: string,
  days: number,
  reason: string,
): Promise<{ suspension: AdminSuspension } | null> {
  return adminPost('/api/admin/user/suspend', { userId, days: String(days), reason });
}

export function adminLiftSuspension(
  userId: string,
  reason = '',
): Promise<{ suspension: AdminSuspension } | null> {
  return adminPost('/api/admin/user/suspend', { userId, lift: '1', reason });
}

/** delete an account and everything it owns. Terminal; the audit row outlives it. */
export function adminDeleteUser(userId: string, note = ''): Promise<{ ok: boolean } | null> {
  return adminPost('/api/admin/user/delete', { userId, note });
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
  /**
   * This account's EARNED, permanent cosmetic unlocks (`profiles.cosmetics`,
   * `"<axis>:<key>"` ids from `src/cosmetics.ts`) — a separate ledger from `supporter`
   * (docs/cosmetics-plan.md §3.2/§3.7) that survives a lapsed membership. Optional for
   * the same "not asked / older server" reason as `termsVersion`: absent means "this
   * server did not say", not "nothing earned" — `[]` means the latter. NEVER
   * authoritative: the server independently strips an unowned cosmetic on join/update
   * regardless of what this field says, so the client uses it only to decide which
   * picker rows to render as owned rather than locked.
   */
  unlockedCosmetics?: string[];
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
      // same pass-through-untouched rule as `termsVersion`: `undefined` means "this
      // server did not say" (older build), not "nothing earned".
      unlockedCosmetics: r.unlockedCosmetics,
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
 * EVERYTHING THE SERVER HOLDS ABOUT YOU, as one JSON document (`GET /api/user/export`).
 *
 * Typed loosely on purpose. The client's job is to hand the file to the person who asked for
 * it, unchanged — it does not read a single field, and a mirrored interface here would be a
 * second copy of the server's shape to keep in step for no benefit. `format` is the one thing
 * it does check, and it checks it for a specific reason below.
 */
export interface AccountExport {
  format: number;
  exportedAt: string;
  [section: string]: unknown;
}

/** the server serving this client predates the export route */
export class ExportUnavailableError extends Error {
  constructor() {
    super('export unavailable');
    this.name = 'ExportUnavailableError';
  }
}

/**
 * ⚠️ AN OLD SERVER ANSWERS THIS PATH 200, WITH SOMETHING ELSE.
 *
 * One Fly app serves every client version, so this call can land on a build that has no export
 * route — and `/api/user/export` matches that server's `/api/user/<id>` public-profile route,
 * which happily reports a profile for the user id `"export"`: `{userId:'export', handle:null}`,
 * status 200. There is no HTTP status to catch, so the guard is the payload: a real export
 * carries `format`, and anything without it is a server that does not have this feature rather
 * than an account with no data. Handing that object to somebody as their personal data export
 * would be the worst possible failure of this route, so it is checked here and not in the UI.
 *
 * `method: 'GET'` is passed explicitly, which looks redundant and is not: `authedJson` turns a
 * 404 on a method-less call into `FriendsUnavailableError`, and that would swallow the server's
 * own "no account data" message for a deleted account.
 */
export async function fetchMyExport(): Promise<AccountExport> {
  const data = await authedJson<Partial<AccountExport>>('/api/user/export', { method: 'GET' });
  if (typeof data?.format !== 'number') throw new ExportUnavailableError();
  return data as AccountExport;
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

// ======================================================== admin: audit + user ==
//
// The two reads behind the console's Audit tab and its user detail panel (server:
// migration 0041). Both are GETs with the signed-in admin token, both are paged, and
// both answer an EMPTY page rather than null when the server is older than the route —
// one Fly app serves every client version, so a console loaded from a newer Vercel
// deploy has to degrade to "nothing to show" instead of an error the admin cannot act on.

/** one row of the admin audit log */
export interface AuditRow {
  id: string;
  adminId: string;
  /** a dotted key: `user.rename`, `record.delete`, `season.start`, … */
  action: string;
  targetUser: string | null;
  targetHandle: string | null;
  targetUsername: string | null;
  targetId: string | null;
  detail: Record<string, unknown>;
  note: string | null;
  at: string;
}

export async function adminFetchAudit(
  opts: { action?: string; admin?: string; user?: string; q?: string; limit?: number; offset?: number } = {},
): Promise<{ rows: AuditRow[]; more: boolean } | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) if (v) q.set(k, String(v));
  try {
    const res = await fetch(base + '/api/admin/audit?' + q.toString(), {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    // 404 is an OLD SERVER, not a failure: the tab shows its empty state rather than
    // "couldn't load", which would send an admin looking for a problem that is a deploy.
    if (res.status === 404) return { rows: [], more: false };
    if (!res.ok) return null;
    const body = (await res.json()) as { rows?: AuditRow[]; more?: boolean };
    return { rows: body.rows ?? [], more: body.more === true };
  } catch {
    return null;
  }
}

/** the distinct action keys present in the log — the filter menu's options */
export async function adminFetchAuditActions(): Promise<string[]> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return [];
  try {
    const res = await fetch(base + '/api/admin/audit?actions=1', {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return [];
    return ((await res.json()) as { actions?: string[] }).actions ?? [];
  } catch {
    return [];
  }
}

export interface AdminNote {
  id: string;
  adminId: string;
  note: string;
  at: string;
}

/** everything the console knows about one account, in one request */
/** one report filed AGAINST the open account */
export interface AdminReportRow {
  id: string;
  reason: string;
  detail: string | null;
  roomCode: string;
  game: string;
  status: string;
  createdAt: string;
  reporterHandle: string;
  reporterUsername: string | null;
}

/** one report the open account FILED — the direction a bare "9 rejected" cannot explain */
export interface AdminReportFiledRow {
  id: string;
  reason: string;
  detail: string | null;
  roomCode: string;
  game: string;
  status: string;
  createdAt: string;
  subjectId: string;
  subjectHandle: string | null;
  subjectUsername: string | null;
}

export interface AdminKofiPayment {
  transactionId: string | null;
  kind: string;
  amount: string | null;
  currency: string | null;
  isSubscription: boolean;
  claimedAt: string | null;
  refundedAt: string | null;
}

export interface AdminUserDetail {
  userId: string;
  /** false ⇒ there is no `profiles` row for this id — see `AdminPresencePlayer.known` */
  known: boolean;
  handle: string | null;
  username: string | null;
  role: StaffRole | null;
  supporter: boolean;
  supporterUntil: string | null;
  autoRenews: boolean;
  replaysPublic: boolean;
  termsVersion: string | null;
  termsAcceptedAt: string | null;
  createdAt: string | null;
  standing: StandingInfo | null;
  standingEvents: StandingEvent[];
  reportsAgainst: { total: number; open: number; reporters: number };
  reportsFiled: { total: number; rejected: number };
  scoreReportsFiled: { total: number; rejected: number };
  /** the rows behind those counts. OPTIONAL: one Fly app serves every client version, so a
   *  console loaded from a newer deploy may be talking to a server that does not send them. */
  reportsAgainstList?: AdminReportRow[];
  reportsFiledList?: AdminReportFiledRow[];
  /** `until: null` ⇒ not suspended. Absent on an older server. */
  suspension?: AdminSuspension;
  notes: AdminNote[];
  grants: SupporterGrantRow[];
  /** Ko-fi payments this account claimed — the rows `adminRefundPayment` acts on */
  payments?: AdminKofiPayment[];
  recentMatches: ModMatch[];
  records: {
    recordId: string;
    game: string;
    mode: string;
    drivetrain: string;
    score: number;
    replayId: string | null;
    createdAt: string;
  }[];
  audit: AuditRow[];
}

export async function adminFetchUser(userId: string): Promise<AdminUserDetail | null> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) return null;
  try {
    const res = await fetch(base + '/api/admin/user?id=' + encodeURIComponent(userId), {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return ((await res.json()) as { user: AdminUserDetail }).user ?? null;
  } catch {
    return null;
  }
}

/** pin a private moderator note to an account (never shown to the player) */
export function adminAddNote(userId: string, note: string): Promise<{ note: AdminNote } | null> {
  return adminPost('/api/admin/user/note', { id: userId, note });
}

export function adminDeleteNote(userId: string, noteId: string): Promise<{ ok: boolean } | null> {
  return adminPost('/api/admin/user/note', { id: userId, delete: noteId });
}
