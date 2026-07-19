import type { Replay } from '../../src/sim/replay';
import type { AssistConfig, GameId, RobotSpec } from '../../src/types';
import type { PendingMatch, PendingRosterEntry } from '../matchTypes';
import { PLACEMENT_GAMES } from '../../src/config';
import { q } from './pool';

/** every board/period is keyed by game; old callers/rows default to DECODE. */
type Game = GameId;
const g = (game?: Game): Game => game ?? 'decode';

/** the robot configuration a record run used (denormalized onto the row) */
export interface RecordConfig {
  spec: RobotSpec;
  assists: AssistConfig;
  /** in a DUO run, the co-op PARTNER's robot (each driver brings their own build,
   * so a duo can mix drivetrains). Absent for solo runs / legacy rows. */
  partnerSpec?: RobotSpec;
}

/**
 * Data-access for Phase 3 (records, ELO, replays, presets, seasons). The SERVER
 * is the only trusted writer — scores come from the authoritative sim, never a
 * client POST. Every write is stamped with the replay's BALANCE_VERSION (the
 * season key). All calls no-op when the DB is disabled.
 */

// ------------------------------------------------------------- seasons ------
// Periods are PER GAME: each game runs its own Act → Season progression, so DECODE
// and Chain Reaction never share a live season or an act. `game` defaults to DECODE.
export async function ensureSeason(
  balanceVersion: number,
  game?: Game,
  initialAct = 0,
): Promise<void> {
  // No baked-in name — the structured "Act X · Season Y" label is derived in
  // listSeasons. A brand-new game's first row seeds `initialAct` (Chain Reaction
  // starts at Act 1); on conflict we only re-activate — act is left untouched.
  await q(
    `insert into seasons (game, balance_version, act, active) values ($1, $2, $3, true)
     on conflict (game, balance_version) do update set active = true`,
    [g(game), balanceVersion, initialAct],
  );
  await q(`update seasons set active = false where game = $1 and balance_version <> $2`, [
    g(game),
    balanceVersion,
  ]);
}

/**
 * The CURRENT season number FOR A GAME. Season is the `balance_version` key, but the
 * live season is DB-controlled so an admin can start a fresh season at runtime WITHOUT
 * a code redeploy (`startNewSeason`). It is the greater of the highest season row for
 * this game and the code's `BALANCE_VERSION` fallback — so a genuine balance bump still
 * rolls the season automatically, and an admin bump wins when there's been no change.
 */
export async function currentSeasonNumber(fallback: number, game?: Game): Promise<number> {
  const rows = await q<{ bv: number | null }>(
    `select max(balance_version) as bv from seasons where game = $1`,
    [g(game)],
  );
  return Math.max(Number(rows[0]?.bv ?? 0), fallback);
}

export interface SeasonRow {
  /** internal balance_version key (stamped on every record/match/replay) */
  season: number;
  /** grouping era; 0 = beta/pre-season, then 1-indexed */
  act: number;
  /** 1-indexed ordinal of this season WITHIN its act (for display) */
  seasonNo: number;
  /** admin's custom title, or null to use the structured "Act X · Season Y" */
  name: string | null;
  active: boolean;
  startedAt: string;
  records: number;
  matches: number;
}

/** every season that exists (a `seasons` row OR any data stamped with it),
 * newest first, with its act + within-act ordinal and how much data it holds. */
export async function listSeasons(game?: Game): Promise<SeasonRow[]> {
  const rows = await q<{
    season: number;
    act: number;
    season_no: number;
    name: string | null;
    active: boolean | null;
    started_at: string | null;
    records: string;
    matches: string;
  }>(
    `with versions as (
       select balance_version as v from seasons where game = $1
       union select balance_version from records where game = $1
       union select balance_version from matches where game = $1
     ),
     rows as (
       select v.v as season,
              coalesce(s.act, 0) as act,
              s.name as name,
              coalesce(s.active, false) as active,
              s.started_at as started_at,
              (select count(*) from records r where r.balance_version = v.v and r.game = $1) as records,
              (select count(*) from matches m where m.balance_version = v.v and m.game = $1) as matches
       from versions v
       left join seasons s on s.balance_version = v.v and s.game = $1
     )
     select season, act, name, active, started_at, records, matches,
            (row_number() over (partition by act order by season))::int as season_no
     from rows
     order by season desc`,
    [g(game)],
  );
  // legacy rows carry the old baked-in "Season N" name — treat those as auto
  // (null) so the structured label wins; keep only genuine custom titles.
  const isAuto = (n: string | null): boolean => !n || /^season\s+\d+$/i.test(n.trim());
  return rows.map((r) => ({
    season: Number(r.season),
    act: Number(r.act),
    seasonNo: Number(r.season_no),
    name: isAuto(r.name) ? null : r.name,
    active: !!r.active,
    startedAt: r.started_at ?? '',
    records: Number(r.records),
    matches: Number(r.matches),
  }));
}

/** Archive the live season and open a fresh one (admin action). The new
 * balance_version is one past the current, so its boards start empty; old
 * seasons stay fully queryable. `bumpAct` opens a new ACT (act++, its season
 * ordinal resets to 1); otherwise it's a new season in the SAME act. `name` is
 * an optional custom title (null ⇒ the structured "Act X · Season Y"). Returns
 * the new version + its act and within-act ordinal. */
export async function startNewSeason(
  fallback: number,
  name?: string,
  bumpAct = false,
  game?: Game,
): Promise<{ season: number; act: number; seasonNo: number }> {
  const next = (await currentSeasonNumber(fallback, game)) + 1;
  const cur = await q<{ act: number | null }>(
    `select act from seasons where game = $1 order by balance_version desc limit 1`,
    [g(game)],
  );
  const act = Number(cur[0]?.act ?? 0) + (bumpAct ? 1 : 0);
  const custom = name && name.trim() ? name.trim() : null;
  await q(
    `insert into seasons (game, balance_version, name, act, active) values ($1, $2, $3, $4, true)
     on conflict (game, balance_version) do update set name = excluded.name, act = excluded.act, active = true`,
    [g(game), next, custom, act],
  );
  await q(`update seasons set active = false where game = $1 and balance_version <> $2`, [g(game), next]);
  const cnt = await q<{ n: number }>(
    `select count(*)::int as n from seasons where game = $1 and act = $2`,
    [g(game), act],
  );
  return { season: next, act, seasonNo: Number(cnt[0]?.n ?? 1) };
}

/** Delete all replays stamped with a given (archived) game×season. The record/match
 * rows survive — their `replay_id` FK is `on delete set null`, so leaderboard
 * entries stay visible, they just stop being watchable. Returns the count freed. */
export async function purgeSeasonReplays(season: number, game?: Game): Promise<number> {
  const rows = await q<{ id: string }>(
    `delete from replays where balance_version = $1 and game = $2 returning id`,
    [season, g(game)],
  );
  return rows.length;
}

// -------------------------------------------------------- announcements -----

export type AnnouncementKind = 'patch' | 'season' | 'act';
export interface AnnouncementRow {
  id: string;
  kind: AnnouncementKind;
  title: string;
  body: string;
  tagline: string | null;
  publishedAt: string;
}

const ANNOUNCEMENT_KINDS: AnnouncementKind[] = ['patch', 'season', 'act'];
const asKind = (k: unknown): AnnouncementKind =>
  ANNOUNCEMENT_KINDS.includes(k as AnnouncementKind) ? (k as AnnouncementKind) : 'patch';

/** publish an announcement (admin only). Returns the created row. */
export async function createAnnouncement(input: {
  kind: string;
  title: string;
  body: string;
  tagline?: string | null;
}): Promise<AnnouncementRow> {
  const rows = await q<{
    id: string;
    kind: string;
    title: string;
    body: string;
    tagline: string | null;
    published_at: string;
  }>(
    `insert into announcements (kind, title, body, tagline)
     values ($1, $2, $3, $4)
     returning id, kind, title, body, tagline, published_at`,
    [asKind(input.kind), input.title, input.body ?? '', input.tagline?.trim() || null],
  );
  const r = rows[0];
  return {
    id: r.id,
    kind: asKind(r.kind),
    title: r.title,
    body: r.body,
    tagline: r.tagline,
    publishedAt: r.published_at,
  };
}

/** recent active announcements, newest first (the client feed + admin list). */
export async function listAnnouncements(limit = 12): Promise<AnnouncementRow[]> {
  const rows = await q<{
    id: string;
    kind: string;
    title: string;
    body: string;
    tagline: string | null;
    published_at: string;
  }>(
    `select id, kind, title, body, tagline, published_at
       from announcements
      where active
      order by published_at desc
      limit $1`,
    [Math.min(50, Math.max(1, limit))],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: asKind(r.kind),
    title: r.title,
    body: r.body,
    tagline: r.tagline,
    publishedAt: r.published_at,
  }));
}

/** retire an announcement (soft delete — it stops appearing in the feed). */
export async function deleteAnnouncement(id: string): Promise<boolean> {
  const rows = await q<{ id: string }>(
    `update announcements set active = false where id = $1 and active returning id`,
    [id],
  );
  return rows.length > 0;
}

// ------------------------------------------------------------ profiles ------
export async function ensureProfile(userId: string, handle: string): Promise<void> {
  await q(
    `insert into profiles (user_id, handle) values ($1, $2)
     on conflict (user_id) do nothing`,
    [userId, handle],
  );
}

export async function setHandle(userId: string, handle: string): Promise<void> {
  await q(`update profiles set handle = $2, updated_at = now() where user_id = $1`, [
    userId,
    handle,
  ]);
}

export interface PublicProfile {
  userId: string;
  handle: string;
  /** unique lowercase [a-z0-9] slug, or null for a legacy profile with none yet */
  username: string | null;
}

/** a user's public profile (display handle + unique username), or null */
export async function getProfile(userId: string): Promise<PublicProfile | null> {
  const rows = await q<{ handle: string; username: string | null }>(
    `select handle, username from profiles where user_id = $1`,
    [userId],
  );
  return rows[0] ? { userId, handle: rows[0].handle, username: rows[0].username } : null;
}

/** resolve a public username → profile (the /profile/<username> read path), or null */
export async function getProfileByUsername(username: string): Promise<PublicProfile | null> {
  const rows = await q<{ user_id: string; handle: string; username: string | null }>(
    `select user_id, handle, username from profiles where username = $1`,
    [username],
  );
  const r = rows[0];
  return r ? { userId: r.user_id, handle: r.handle, username: r.username } : null;
}

/** thrown by setUsername when the requested username is already taken */
export class UsernameTakenError extends Error {
  constructor() {
    super('username taken');
    this.name = 'UsernameTakenError';
  }
}

/** claim a username for a user (profile row must already exist — caller ensures
 * it). Usernames are one-per-account and globally unique; a collision throws
 * `UsernameTakenError` (Postgres unique-violation 23505 on profiles_username_key). */
export async function setUsername(userId: string, username: string): Promise<void> {
  try {
    await q(`update profiles set username = $2, updated_at = now() where user_id = $1`, [
      userId,
      username,
    ]);
  } catch (e) {
    if (e && typeof e === 'object' && (e as { code?: string }).code === '23505') {
      throw new UsernameTakenError();
    }
    throw e;
  }
}

/** is a username free to claim? (false if any other user already holds it) */
export async function usernameAvailable(username: string, forUserId?: string): Promise<boolean> {
  const rows = await q<{ user_id: string }>(`select user_id from profiles where username = $1`, [
    username,
  ]);
  return rows.length === 0 || (!!forUserId && rows[0].user_id === forUserId);
}

// -------------------------------------------------- per-account settings ----
/** a user's synced GameSettings blob (client-shaped JSON), or null if unset */
export async function getUserSettings(userId: string): Promise<unknown | null> {
  const rows = await q<{ settings: unknown }>(`select settings from profiles where user_id = $1`, [
    userId,
  ]);
  return rows[0]?.settings ?? null;
}

/** upsert a user's settings blob (profile row is ensured first by the caller) */
export async function saveUserSettings(userId: string, settings: unknown): Promise<void> {
  await q(`update profiles set settings = $2, updated_at = now() where user_id = $1`, [
    userId,
    JSON.stringify(settings),
  ]);
}

// ------------------------------------------------------------- replays ------
export async function saveReplay(replay: Replay, game?: Game): Promise<string> {
  const rows = await q<{ id: string }>(
    `insert into replays (format, balance_version, seed, ticks, setups, tracks, game)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      replay.format,
      replay.balanceVersion,
      replay.seed,
      replay.ticks,
      JSON.stringify(replay.setups),
      JSON.stringify(replay.tracks),
      g(game),
    ],
  );
  return rows[0].id;
}

export async function getReplay(id: string): Promise<Replay | null> {
  const rows = await q<{
    format: number;
    balance_version: number;
    game: Game;
    seed: string;
    ticks: number;
    setups: Replay['setups'];
    tracks: Replay['tracks'];
  }>(`select format, balance_version, game, seed, ticks, setups, tracks from replays where id = $1`, [id]);
  const r = rows[0];
  if (!r) return null;
  return {
    format: r.format,
    balanceVersion: r.balance_version,
    game: r.game ?? 'decode', // picks the sim module to re-simulate (CR vs DECODE)
    mode: 'match',
    seed: Number(r.seed),
    ticks: r.ticks,
    setups: r.setups,
    tracks: r.tracks,
  };
}

// --------------------------------------------------- record-chasing board ---
export interface RecordSubmit {
  userId: string;
  partnerId?: string;
  mode: 'solo' | 'duo';
  drivetrain: string;
  score: number;
  balanceVersion: number;
  replayId: string;
  config?: RecordConfig;
  game?: Game;
}

export async function submitRecord(r: RecordSubmit): Promise<string> {
  const rows = await q<{ id: string }>(
    `insert into records (user_id, partner_id, mode, drivetrain, score, balance_version, replay_id, config, game)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      r.userId,
      r.partnerId ?? null,
      r.mode,
      r.drivetrain,
      r.score,
      r.balanceVersion,
      r.replayId,
      r.config ? JSON.stringify(r.config) : null,
      g(r.game),
    ],
  );
  return rows[0].id;
}

export interface BoardRow {
  userId: string;
  handle: string;
  username: string | null;
  partnerId: string | null;
  /** partner's display name + username (duo runs only; null for solo / unknown) */
  partnerHandle: string | null;
  partnerUsername: string | null;
  score: number;
  replayId: string | null;
  createdAt: string;
  config: RecordConfig | null;
}

/** best score per player within a season × mode × drivetrain, ranked. Pass
 * drivetrain 'overall' (or omit) for the cross-drivetrain board (each player's
 * best run on ANY drivetrain). */
export async function recordLeaderboard(opts: {
  mode: 'solo' | 'duo';
  drivetrain?: string;
  balanceVersion: number;
  limit?: number;
  game?: Game;
}): Promise<BoardRow[]> {
  const params: unknown[] = [opts.balanceVersion, opts.mode, g(opts.game)];
  let dtFilter = '';
  if (opts.drivetrain && opts.drivetrain !== 'overall') {
    params.push(opts.drivetrain);
    dtFilter = `and r.drivetrain = $${params.length}`;
  }
  params.push(opts.limit ?? 100);
  return q<BoardRow>(
    `with best as (
       select distinct on (r.user_id)
         r.user_id, r.partner_id, r.score, r.replay_id, r.created_at, r.config
       from records r
       where r.balance_version = $1 and r.mode = $2 and r.game = $3 ${dtFilter}
       order by r.user_id, r.score desc, r.created_at asc
     )
     select b.user_id as "userId", p.handle, p.username,
            b.partner_id as "partnerId",
            pp.handle as "partnerHandle", pp.username as "partnerUsername",
            b.score, b.replay_id as "replayId", b.created_at as "createdAt", b.config
     from best b
       join profiles p on p.user_id = b.user_id
       left join profiles pp on pp.user_id = b.partner_id
     order by b.score desc, b.created_at asc
     limit $${params.length}`,
    params,
  );
}

export async function personalBest(
  userId: string,
  mode: 'solo' | 'duo',
  drivetrain: string,
  balanceVersion: number,
  game?: Game,
): Promise<number | null> {
  // 'overall' = the cross-drivetrain board (no drivetrain filter), matching
  // recordLeaderboard — a mixed-drivetrain duo run's PB is over ALL the user's
  // runs in this mode×season, not one drivetrain.
  const overall = drivetrain === 'overall';
  const rows = await q<{ score: number | null }>(
    `select max(score) as score from records
     where user_id = $1 and mode = $2 and balance_version = $3 and game = $4
       ${overall ? '' : 'and drivetrain = $5'}`,
    overall
      ? [userId, mode, balanceVersion, g(game)]
      : [userId, mode, balanceVersion, g(game), drivetrain],
  );
  return rows[0]?.score ?? null;
}

/** the user's standing in a season × mode × drivetrain bucket, by their BEST
 * score there: 1-based `rank` (ties share the better rank) and the bucket's
 * player `total`. Pass drivetrain 'overall' for the cross-drivetrain board (no
 * drivetrain filter — matching recordLeaderboard), where mixed-drivetrain duos
 * land. Call AFTER submitting the run so it reflects it. */
export async function recordRank(
  userId: string,
  mode: 'solo' | 'duo',
  drivetrain: string,
  balanceVersion: number,
  game?: Game,
): Promise<{ rank: number; total: number }> {
  const overall = drivetrain === 'overall';
  const rows = await q<{ rank: number; total: number }>(
    `with best as (
       select user_id, max(score) as s from records
       where balance_version = $1 and mode = $2 and game = $5
         ${overall ? '' : 'and drivetrain = $4'}
       group by user_id
     ), me as (select s from best where user_id = $3)
     select
       (select count(*) from best)::int as total,
       (1 + (select count(*) from best where s > (select s from me)))::int as rank`,
    [balanceVersion, mode, userId, overall ? null : drivetrain, g(game)],
  );
  return { rank: rows[0]?.rank ?? 1, total: rows[0]?.total ?? 1 };
}

// --------------------------------------------------- admin moderation -------
/** one moderation row: the best run per player in a bucket, WITH its record +
 * replay id so an admin can delete it (the public board omits these ids). */
export interface AdminRecordRow {
  recordId: string;
  userId: string;
  handle: string;
  score: number;
  drivetrain: string;
  replayId: string | null;
  createdAt: string;
}

/** admin: the moderation view of a leaderboard bucket — same best-per-player
 * ranking the public board shows, but carrying the record id for deletion. */
export async function adminListRecords(opts: {
  mode: 'solo' | 'duo';
  drivetrain?: string;
  balanceVersion: number;
  limit?: number;
  game?: Game;
}): Promise<AdminRecordRow[]> {
  const params: unknown[] = [opts.balanceVersion, opts.mode, g(opts.game)];
  let dtFilter = '';
  if (opts.drivetrain && opts.drivetrain !== 'overall') {
    params.push(opts.drivetrain);
    dtFilter = `and r.drivetrain = $${params.length}`;
  }
  params.push(opts.limit ?? 100);
  return q<AdminRecordRow>(
    `with best as (
       select distinct on (r.user_id)
         r.id, r.user_id, r.score, r.drivetrain, r.replay_id, r.created_at
       from records r
       where r.balance_version = $1 and r.mode = $2 and r.game = $3 ${dtFilter}
       order by r.user_id, r.score desc, r.created_at asc
     )
     select b.id as "recordId", b.user_id as "userId", p.handle, b.score,
            b.drivetrain, b.replay_id as "replayId", b.created_at as "createdAt"
     from best b join profiles p on p.user_id = b.user_id
     order by b.score desc, b.created_at asc
     limit $${params.length}`,
    params,
  );
}

/** admin: delete a single record run by id, plus its now-orphaned replay
 * (records → replays is `on delete set null`, so this can't strand a board row).
 * Returns true if a row was deleted. */
export async function deleteRecordById(id: string): Promise<boolean> {
  const rows = await q<{ replay_id: string | null }>(
    `delete from records where id = $1 returning replay_id`,
    [id],
  );
  const r = rows[0];
  if (!r) return false;
  if (r.replay_id) await q(`delete from replays where id = $1`, [r.replay_id]).catch(() => {});
  return true;
}

/** admin: delete EVERY record run by a user (a confirmed cheater) + their
 * replays. The profile + ELO stay; only the record board is cleared. Returns the
 * number of runs removed. */
export async function deleteUserRecords(userId: string): Promise<number> {
  const rows = await q<{ replay_id: string | null }>(
    `delete from records where user_id = $1 returning replay_id`,
    [userId],
  );
  const ids = rows.map((r) => r.replay_id).filter((x): x is string => !!x);
  if (ids.length) await q(`delete from replays where id = any($1)`, [ids]).catch(() => {});
  return rows.length;
}

/** admin: find profiles by handle (case-insensitive substring) or exact userId,
 * for the rename / moderation picker. */
export async function searchProfiles(
  query: string,
  limit = 25,
): Promise<{ userId: string; handle: string }[]> {
  return q<{ userId: string; handle: string }>(
    `select user_id as "userId", handle from profiles
     where handle ilike $1 or user_id = $2
     order by handle limit $3`,
    [`%${query}%`, query, limit],
  );
}

// -------------------------------------------------------- robot presets -----
export async function listPresets(
  userId: string,
): Promise<{ slot: number; name: string; spec: RobotSpec }[]> {
  return q<{ slot: number; name: string; spec: RobotSpec }>(
    `select slot, name, spec from robot_presets where user_id = $1 order by slot`,
    [userId],
  );
}

export async function savePreset(
  userId: string,
  slot: number,
  name: string,
  spec: RobotSpec,
): Promise<void> {
  await q(
    `insert into robot_presets (user_id, slot, name, spec) values ($1, $2, $3, $4)
     on conflict (user_id, slot)
       do update set name = excluded.name, spec = excluded.spec, updated_at = now()`,
    [userId, slot, name, JSON.stringify(spec)],
  );
}

export async function deletePreset(userId: string, slot: number): Promise<void> {
  await q(`delete from robot_presets where user_id = $1 and slot = $2`, [userId, slot]);
}

// -------------------------------------------------------------- ranked ELO --
// RANKED ELO is keyed by ACT, not season: ratings persist across seasons within an act and
// only reset on a new act (records reset every season). `actForSeason` maps a season to its act.
export async function actForSeason(balanceVersion: number, game?: Game): Promise<number> {
  const rows = await q<{ act: number | null }>(
    `select act from seasons where game = $1 and balance_version = $2`,
    [g(game), balanceVersion],
  );
  return Number(rows[0]?.act ?? 0);
}

export async function getRating(
  userId: string,
  mode: '1v1' | '2v2',
  act: number,
  game?: Game,
): Promise<number> {
  const rows = await q<{ rating: number }>(
    `select rating from elo_ratings
     where user_id = $1 and mode = $2 and act = $3 and game = $4`,
    [userId, mode, act, g(game)],
  );
  return rows[0]?.rating ?? 1000;
}

/** the full Glicko-2 state (rating + deviation + volatility). Defaults are a
 * fresh, maximally-uncertain player: 1000 / RD 350 / vol 0.06. */
export async function getRatingFull(
  userId: string,
  mode: '1v1' | '2v2',
  act: number,
  game?: Game,
): Promise<{ rating: number; rd: number; vol: number }> {
  const rows = await q<{ rating: number; rd: number; vol: number }>(
    `select rating, rd, vol from elo_ratings
     where user_id = $1 and mode = $2 and act = $3 and game = $4`,
    [userId, mode, act, g(game)],
  );
  const r = rows[0];
  return { rating: r?.rating ?? 1000, rd: r?.rd ?? 350, vol: r?.vol ?? 0.06 };
}

/** Upsert a player's rating for the ACT's board and return their NEW total games on it
 * (games after this match) — the caller uses it to decide the games-based
 * placement / provisional flag for the results screen. */
export async function upsertRating(
  userId: string,
  mode: '1v1' | '2v2',
  act: number,
  rating: number,
  rd: number,
  vol: number,
  game?: Game,
): Promise<number> {
  const rows = await q<{ games: number }>(
    `insert into elo_ratings (user_id, mode, act, game, rating, rd, vol, games)
     values ($1, $2, $3, $4, $5, $6, $7, 1)
     on conflict (user_id, mode, game, act)
       do update set rating = excluded.rating, rd = excluded.rd, vol = excluded.vol,
                     games = elo_ratings.games + 1, updated_at = now()
     returning games`,
    [userId, mode, act, g(game), Math.round(rating), rd, vol],
  );
  return rows[0]?.games ?? 1;
}

/** The public leaderboard for an ACT's board — PLACED players only (games >=
 * PLACEMENT_GAMES). Players still in placements are intentionally omitted;
 * `eloUserStanding` reports the viewer's own standing separately. */
export async function eloLeaderboard(opts: {
  mode: '1v1' | '2v2';
  act: number;
  limit?: number;
  game?: Game;
}): Promise<{ userId: string; handle: string; username: string | null; rating: number; games: number }[]> {
  return q<{ userId: string; handle: string; username: string | null; rating: number; games: number }>(
    `select e.user_id as "userId", p.handle, p.username, e.rating, e.games
     from elo_ratings e join profiles p on p.user_id = e.user_id
     where e.act = $1 and e.mode = $2 and e.game = $5 and e.games >= $4
     order by e.rating desc, e.games desc
     limit $3`,
    [opts.act, opts.mode, opts.limit ?? 100, PLACEMENT_GAMES, g(opts.game)],
  );
}

/** The viewing player's own standing on an ACT's board, whether or not they're placed:
 * their rating + games, and their rank AMONG PLACED PLAYERS (null while still in
 * placements). Returns null if they've never played this board. Rank uses the
 * same order as `eloLeaderboard` so the two always agree. */
export async function eloUserStanding(opts: {
  userId: string;
  mode: '1v1' | '2v2';
  act: number;
  game?: Game;
}): Promise<{ rank: number | null; rating: number; games: number } | null> {
  const rows = await q<{ rating: number; games: number; rnk: string | null }>(
    `with placed as (
       select user_id,
              rank() over (order by rating desc, games desc) as rnk
       from elo_ratings
       where act = $1 and mode = $2 and game = $5 and games >= $3
     )
     select e.rating, e.games, p.rnk
     from elo_ratings e
     left join placed p on p.user_id = e.user_id
     where e.act = $1 and e.mode = $2 and e.game = $5 and e.user_id = $4`,
    [opts.act, opts.mode, PLACEMENT_GAMES, opts.userId, g(opts.game)],
  );
  const r = rows[0];
  if (!r) return null;
  return { rank: r.rnk != null ? Number(r.rnk) : null, rating: r.rating, games: r.games };
}

// -------- per-season ELO SNAPSHOT (historical, frozen at each season's end) --
/** Snapshot a player's post-match rating for the SEASON it was played in. While the season is
 * live this tracks the latest rating; after it rolls it stays frozen = the end-of-season state.
 * Called alongside `upsertRating` on every rated match. `games` is the act-cumulative count. */
export async function upsertEloHistory(
  userId: string,
  mode: '1v1' | '2v2',
  balanceVersion: number,
  rating: number,
  rd: number,
  vol: number,
  games: number,
  game?: Game,
): Promise<void> {
  await q(
    `insert into elo_history (user_id, mode, game, balance_version, rating, rd, vol, games)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (user_id, mode, game, balance_version)
       do update set rating = excluded.rating, rd = excluded.rd, vol = excluded.vol,
                     games = excluded.games, updated_at = now()`,
    [userId, mode, g(game), balanceVersion, Math.round(rating), rd, vol, games],
  );
}

/** The historical leaderboard for a PAST season — the ratings frozen at that season's end. Same
 * shape + placement filter as `eloLeaderboard`, but reads the per-season snapshot. */
export async function eloHistoryLeaderboard(opts: {
  mode: '1v1' | '2v2';
  balanceVersion: number;
  limit?: number;
  game?: Game;
}): Promise<{ userId: string; handle: string; username: string | null; rating: number; games: number }[]> {
  return q<{ userId: string; handle: string; username: string | null; rating: number; games: number }>(
    `select h.user_id as "userId", p.handle, p.username, h.rating, h.games
     from elo_history h join profiles p on p.user_id = h.user_id
     where h.balance_version = $1 and h.mode = $2 and h.game = $5 and h.games >= $4
     order by h.rating desc, h.games desc
     limit $3`,
    [opts.balanceVersion, opts.mode, opts.limit ?? 100, PLACEMENT_GAMES, g(opts.game)],
  );
}

/** A player's own frozen standing in a PAST season (mirrors `eloUserStanding`). */
export async function eloHistoryUserStanding(opts: {
  userId: string;
  mode: '1v1' | '2v2';
  balanceVersion: number;
  game?: Game;
}): Promise<{ rank: number | null; rating: number; games: number } | null> {
  const rows = await q<{ rating: number; games: number; rnk: string | null }>(
    `with placed as (
       select user_id,
              rank() over (order by rating desc, games desc) as rnk
       from elo_history
       where balance_version = $1 and mode = $2 and game = $5 and games >= $3
     )
     select h.rating, h.games, p.rnk
     from elo_history h
     left join placed p on p.user_id = h.user_id
     where h.balance_version = $1 and h.mode = $2 and h.game = $5 and h.user_id = $4`,
    [opts.balanceVersion, opts.mode, PLACEMENT_GAMES, opts.userId, g(opts.game)],
  );
  const r = rows[0];
  if (!r) return null;
  return { rank: r.rnk != null ? Number(r.rnk) : null, rating: r.rating, games: r.games };
}

// -------------------------------------------------------- global stats -----
export interface GlobalStats {
  users: number;
  /** total games played — COMBINED across every game (the homepage headline) */
  games: number;
  byCategory: { solo: number; duo: number; '1v1': number; '2v2': number };
  /** games played PER GAME (DECODE + Chain Reaction tracked separately). The
   * homepage sums these into `games`; the split is here if a surface wants it. */
  byGame: Record<Game, number>;
}

/** site-wide totals for the homepage: registered players + games played, split
 * by category (solo/duo record runs + 1v1/2v2 PvP matches — the server-tracked
 * games) AND by game (DECODE vs Chain Reaction, recorded separately). The
 * headline `games` COMBINES every game. Cheap COUNT/GROUP BY over indexed tables. */
export async function getGlobalStats(): Promise<GlobalStats> {
  const [users, recRows, matchRows] = await Promise.all([
    q<{ n: string }>(`select count(*) as n from profiles`),
    q<{ game: Game; mode: string; n: string }>(`select game, mode, count(*) as n from records group by game, mode`),
    q<{ game: Game; mode: string; n: string }>(`select game, mode, count(*) as n from matches group by game, mode`),
  ]);
  const byCategory: GlobalStats['byCategory'] = { solo: 0, duo: 0, '1v1': 0, '2v2': 0 };
  const byGame: Record<Game, number> = { decode: 0, chain: 0 };
  for (const r of [...recRows, ...matchRows]) {
    const n = Number(r.n);
    // combined-by-category (homepage) — sums across games
    if (r.mode in byCategory) byCategory[r.mode as keyof GlobalStats['byCategory']] += n;
    // recorded separately per game
    const gk = (r.game ?? 'decode') as Game;
    if (gk in byGame) byGame[gk] += n;
  }
  const games = byCategory.solo + byCategory.duo + byCategory['1v1'] + byCategory['2v2'];
  return { users: Number(users[0]?.n ?? 0), games, byCategory, byGame };
}

// ---------------------------------------------------------- per-user stats --
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

/**
 * A user's whole competitive profile for a season in ONE round-trip: overall ELO
 * (+ live rank) per mode, record personal-bests (+ rank) per mode, W/L totals,
 * and recent PvP history. Ranks are computed server-side with window functions
 * so the client never pulls a full board to find one row. Empty/zero when the
 * player hasn't competed; the DB is disabled ⇒ callers no-op before this.
 */
export async function getUserStats(
  userId: string,
  balanceVersion: number,
  game?: Game,
): Promise<UserStats> {
  const gm = g(game);
  // ELO for the LIVE season = the per-ACT board (persists across seasons); for an ARCHIVED
  // season = the per-season SNAPSHOT frozen at that season's end. Records/matches stay per-season.
  const act = await actForSeason(balanceVersion, game);
  const current = await currentSeasonNumber(balanceVersion, game);
  const isLive = balanceVersion >= current;
  const eloTable = isLive ? 'elo_ratings' : 'elo_history';
  const eloKeyCol = isLive ? 'act' : 'balance_version';
  const eloKeyVal = isLive ? act : balanceVersion;
  const [profile, elo, recPb, recRank, match, recent] = await Promise.all([
    q<{ handle: string; username: string | null }>(
      `select handle, username from profiles where user_id = $1`,
      [userId],
    ),
    q<{ mode: '1v1' | '2v2'; rating: number; games: number; rnk: string | null }>(
      `with placed as (
         select user_id, mode,
                rank() over (partition by mode order by rating desc, games desc) as rnk
         from ${eloTable}
         where ${eloKeyCol} = $1 and game = $4 and games >= $3
       )
       select e.mode, e.rating, e.games, p.rnk
       from ${eloTable} e
       left join placed p on p.user_id = e.user_id and p.mode = e.mode
       where e.${eloKeyCol} = $1 and e.game = $4 and e.user_id = $2`,
      [eloKeyVal, userId, PLACEMENT_GAMES, gm],
    ),
    q<{ mode: 'solo' | 'duo'; score: number; replay_id: string | null }>(
      `select distinct on (mode) mode, score, replay_id
       from records where user_id = $1 and balance_version = $2 and game = $3
       order by mode, score desc, created_at asc`,
      [userId, balanceVersion, gm],
    ),
    q<{ mode: 'solo' | 'duo'; rnk: string }>(
      `with best as (
         select user_id, mode, max(score) as score
         from records where balance_version = $1 and game = $3 group by user_id, mode
       ), ranked as (
         select user_id, mode, rank() over (partition by mode order by score desc) as rnk
         from best
       )
       select mode, rnk from ranked where user_id = $2`,
      [balanceVersion, userId, gm],
    ),
    q<{ played: string; wins: string }>(
      `select count(*) as played, count(*) filter (where mp.won) as wins
       from match_participants mp join matches m on m.id = mp.match_id
       where mp.user_id = $1 and m.balance_version = $2 and m.game = $3`,
      [userId, balanceVersion, gm],
    ),
    q<UserMatchRow>(
      `select mp.match_id as "matchId", m.mode, mp.alliance, mp.score, mp.won,
              mp.rating_before as "ratingBefore", mp.rating_after as "ratingAfter",
              m.created_at as "createdAt"
       from match_participants mp join matches m on m.id = mp.match_id
       where mp.user_id = $1 and m.balance_version = $2 and m.game = $3
       order by m.created_at desc limit 10`,
      [userId, balanceVersion, gm],
    ),
  ]);

  const rankByMode = new Map(recRank.map((r) => [r.mode, Number(r.rnk)]));
  const elos: UserEloStat[] = (['1v1', '2v2'] as const).map((mode) => {
    const row = elo.find((e) => e.mode === mode);
    return {
      mode,
      rating: row ? row.rating : 1000,
      games: row ? row.games : 0,
      // placed-only rank: null while the player is still in placements
      rank: row && row.rnk != null ? Number(row.rnk) : null,
    };
  });
  const records: UserRecordStat[] = (['solo', 'duo'] as const).map((mode) => {
    const pb = recPb.find((r) => r.mode === mode);
    return {
      mode,
      best: pb ? pb.score : null,
      rank: rankByMode.get(mode) ?? null,
      replayId: pb?.replay_id ?? null,
    };
  });
  const played = Number(match[0]?.played ?? 0);
  const wins = Number(match[0]?.wins ?? 0);

  return {
    userId,
    handle: profile[0]?.handle ?? null,
    username: profile[0]?.username ?? null,
    season: balanceVersion,
    elo: elos,
    records,
    match: { played, wins, losses: played - wins },
    recent,
  };
}

// ------------------------------------------------------ PvP match history ---
export async function saveMatch(
  mode: '1v1' | '2v2',
  balanceVersion: number,
  replayId: string,
  ranked: boolean,
  game?: Game,
): Promise<string> {
  const rows = await q<{ id: string }>(
    `insert into matches (mode, balance_version, replay_id, ranked, game) values ($1, $2, $3, $4, $5) returning id`,
    [mode, balanceVersion, replayId, ranked, g(game)],
  );
  return rows[0].id;
}

export async function addMatchParticipant(p: {
  matchId: string;
  userId: string;
  alliance: 'red' | 'blue';
  drivetrain: string;
  score: number;
  won: boolean;
  /** null for a custom (unranked) match — no rating change */
  ratingBefore: number | null;
  ratingAfter: number | null;
}): Promise<void> {
  await q(
    `insert into match_participants
       (match_id, user_id, alliance, drivetrain, score, won, rating_before, rating_after)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (match_id, user_id) do nothing`,
    [p.matchId, p.userId, p.alliance, p.drivetrain, p.score, p.won, p.ratingBefore, p.ratingAfter],
  );
}

// ---------------------------------------------------- unified match history ---
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
  drivetrain: string | null; // record only (its leaderboard bucket)
  createdAt: string;
  replayId: string | null;
  score: number;
  /** both alliances' FINAL totals (versus only; null for record runs). The
   * per-participant `score` is the alliance total, so red/blue are recoverable
   * from the participant fan-out below without a dedicated match-score column. */
  redScore: number | null;
  blueScore: number | null;
  won: boolean | null; // versus only
  eloBefore: number | null;
  eloAfter: number | null;
  players: MatchHistoryPlayer[]; // everyone who played (incl. the queried user)
}
export interface MatchHistoryPage {
  rows: MatchHistoryEntry[];
  total: number;
  offset: number;
  limit: number;
}

/**
 * A user's UNIFIED match history for a season — versus matches (ranked + custom,
 * with every participant) AND record runs (solo/duo, with the partner) merged and
 * newest-first, paginated + filterable. `type`: all|ranked|custom|solo|duo;
 * `result`: all|win|loss (win/loss applies to versus only). One feed query + one
 * participant fan-out; ranks/deltas already stored, so it's cheap.
 */
export async function userMatchHistory(
  userId: string,
  opts: {
    balanceVersion: number;
    offset?: number;
    limit?: number;
    type?: string;
    result?: string;
    game?: Game;
  },
): Promise<MatchHistoryPage> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 25));
  const offset = Math.max(0, opts.offset ?? 0);

  const conds: string[] = [];
  switch (opts.type) {
    case 'ranked': conds.push(`kind = 'versus' and ranked is true`); break;
    case 'custom': conds.push(`kind = 'versus' and ranked is not true`); break;
    case 'solo': conds.push(`kind = 'record' and mode = 'solo'`); break;
    case 'duo': conds.push(`kind = 'record' and mode = 'duo'`); break;
    case 'versus': conds.push(`kind = 'versus'`); break;
    case 'record': conds.push(`kind = 'record'`); break;
  }
  if (opts.result === 'win') conds.push(`won is true`);
  else if (opts.result === 'loss') conds.push(`won is false`);
  const where = conds.length ? `where ${conds.join(' and ')}` : '';

  const feed = `
    with feed as (
      select 'versus' as kind, m.id::text as id, m.mode as mode, m.ranked as ranked,
             null::text as drivetrain, m.created_at as created_at, m.replay_id::text as replay_id,
             mp.score as score, mp.won as won,
             mp.rating_before as elo_before, mp.rating_after as elo_after
      from match_participants mp join matches m on m.id = mp.match_id
      where mp.user_id = $1 and m.balance_version = $2 and m.game = $3
      union all
      select 'record', r.id::text, r.mode, null::boolean,
             r.drivetrain, r.created_at, r.replay_id::text,
             r.score, null::boolean, null::int, null::int
      from records r
      where r.user_id = $1 and r.balance_version = $2 and r.game = $3
    )`;

  const [rows, countRows] = await Promise.all([
    q<{
      kind: 'versus' | 'record';
      id: string;
      mode: string;
      ranked: boolean | null;
      drivetrain: string | null;
      created_at: string;
      replay_id: string | null;
      score: number;
      won: boolean | null;
      elo_before: number | null;
      elo_after: number | null;
    }>(`${feed} select * from feed ${where} order by created_at desc limit $4 offset $5`, [
      userId,
      opts.balanceVersion,
      g(opts.game),
      limit,
      offset,
    ]),
    q<{ n: string }>(`${feed} select count(*)::int as n from feed ${where}`, [
      userId,
      opts.balanceVersion,
      g(opts.game),
    ]),
  ]);

  // fan-out players: all participants of the versus matches on this page, plus the
  // self+partner of record runs. One query for versus participants, one for the
  // profiles referenced by record runs.
  const versusIds = rows.filter((r) => r.kind === 'versus').map((r) => r.id);
  const byMatch = new Map<string, MatchHistoryPlayer[]>();
  // both alliances' final totals per match (score is the alliance total, so any
  // participant on a side carries it — see room.ts scores[alliance].total)
  const scoreByMatch = new Map<string, { red: number | null; blue: number | null }>();
  if (versusIds.length) {
    const parts = await q<{
      id: string;
      user_id: string;
      alliance: 'red' | 'blue';
      score: number;
      handle: string;
      username: string | null;
    }>(
      `select mp.match_id::text as id, mp.user_id, mp.alliance, mp.score, p.handle, p.username
       from match_participants mp join profiles p on p.user_id = mp.user_id
       where mp.match_id = any($1::uuid[])`,
      [versusIds],
    );
    for (const p of parts) {
      const list = byMatch.get(p.id) ?? [];
      list.push({ userId: p.user_id, handle: p.handle, username: p.username, alliance: p.alliance });
      byMatch.set(p.id, list);
      const s = scoreByMatch.get(p.id) ?? { red: null, blue: null };
      if (p.alliance === 'red') s.red = p.score;
      else s.blue = p.score;
      scoreByMatch.set(p.id, s);
    }
  }
  // profiles for record runs (self + partners)
  const recordIds = rows.filter((r) => r.kind === 'record').map((r) => r.id);
  const recPlayers = new Map<string, MatchHistoryPlayer[]>();
  if (recordIds.length) {
    const recs = await q<{ id: string; partner_id: string | null }>(
      `select id::text as id, partner_id from records where id = any($1::uuid[])`,
      [recordIds],
    );
    const need = new Set<string>([userId]);
    for (const r of recs) if (r.partner_id) need.add(r.partner_id);
    const profs = await q<{ user_id: string; handle: string; username: string | null }>(
      `select user_id, handle, username from profiles where user_id = any($1::text[])`,
      [[...need]],
    );
    const byUser = new Map(profs.map((p) => [p.user_id, p]));
    const mk = (uid: string): MatchHistoryPlayer => {
      const p = byUser.get(uid);
      return { userId: uid, handle: p?.handle ?? 'Player', username: p?.username ?? null, alliance: null };
    };
    for (const r of recs) {
      const list = [mk(userId)];
      if (r.partner_id) list.push(mk(r.partner_id));
      recPlayers.set(r.id, list);
    }
  }

  return {
    rows: rows.map((r) => ({
      kind: r.kind,
      id: r.id,
      mode: r.mode,
      ranked: r.ranked,
      drivetrain: r.drivetrain,
      createdAt: r.created_at,
      replayId: r.replay_id,
      score: r.score,
      redScore: r.kind === 'versus' ? scoreByMatch.get(r.id)?.red ?? null : null,
      blueScore: r.kind === 'versus' ? scoreByMatch.get(r.id)?.blue ?? null : null,
      won: r.won,
      eloBefore: r.elo_before,
      eloAfter: r.elo_after,
      players: (r.kind === 'versus' ? byMatch.get(r.id) : recPlayers.get(r.id)) ?? [],
    })),
    total: Number(countRows[0]?.n ?? 0),
    offset,
    limit,
  };
}

// -------------------------------------------------- pending (staged) matches ---
// The designated matchmaker stages a paired ranked match; the fair host-region
// machine claims it when the players reconnect. See server/matchTypes.ts.

export async function createPendingMatch(m: PendingMatch): Promise<void> {
  await q(
    `insert into pending_matches (code, host_region, mode, seed, roster, ranked)
     values ($1, $2, $3, $4, $5::jsonb, $6)
     on conflict (code) do nothing`,
    [m.code, m.hostRegion, m.mode, m.seed, JSON.stringify(m.roster), m.ranked],
  );
}

/** atomically claim a staged match (delete-returning, so exactly one host builds
 * it even if two clients race the first connect). Returns null if unknown/already
 * claimed. */
export async function takePendingMatch(code: string): Promise<PendingMatch | null> {
  const rows = await q<{
    code: string;
    host_region: string;
    mode: string;
    seed: string;
    roster: PendingRosterEntry[];
    ranked: boolean;
  }>(`delete from pending_matches where code = $1 returning *`, [code]);
  const r = rows[0];
  if (!r) return null;
  return {
    code: r.code,
    hostRegion: r.host_region,
    mode: r.mode as PendingMatch['mode'],
    seed: Number(r.seed),
    roster: r.roster,
    ranked: r.ranked,
    // channel + game are carried inside the roster jsonb (no schema column) — all
    // entries share one, so read them off the first
    channel: r.roster[0]?.channel,
    game: r.roster[0]?.game,
  };
}

/** reap staged matches nobody claimed (e.g. both clients vanished after assign) */
export async function cleanupStalePending(olderThanMs: number): Promise<number> {
  const rows = await q<{ code: string }>(
    `delete from pending_matches where created_at < now() - ($1 || ' milliseconds')::interval returning code`,
    [String(olderThanMs)],
  );
  return rows.length;
}
